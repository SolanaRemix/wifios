'use strict';

// network-tuning.js — Idempotent network tuning for Starlink backhaul
//
// On Linux:   applies sysctl settings for TCP keepalive and configures
//             fq_codel or CAKE queue discipline on the WAN interface via `tc`.
// On Windows: applies TCP keepalive tuning via registry (netsh/PowerShell).
// Safe to call on every startup; settings are only written when they differ.

const { execFile } = require('child_process');
const os = require('os');

const IS_LINUX   = process.platform === 'linux';
const IS_WINDOWS = process.platform === 'win32';

// ─── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_CFG = {
  // TCP keepalive — detect silent Starlink drops quickly
  tcpKeepaliveTime:   120,  // seconds before first probe on idle connection
  tcpKeepaliveIntvl:   15,  // seconds between probes
  tcpKeepaliveProbes:   5,  // probes before giving up
  tcpRetries2:          8,  // retransmit attempts before dropping connection

  // Queue discipline (Linux only): prefer CAKE, fall back to fq_codel
  preferCake:    true,
  wanInterface:  process.env.WAN_IFACE || '',  // auto-detect if empty
};

// ─── Linux sysctl helpers ────────────────────────────────────────────────────

function readSysctl(key) {
  const fspath = '/proc/sys/' + key.replace(/\./g, '/');
  try {
    const { readFileSync } = require('fs');
    return parseInt(readFileSync(fspath, 'utf8').trim(), 10);
  } catch (_) {
    return null;
  }
}

function writeSysctl(key, value) {
  const fspath = '/proc/sys/' + key.replace(/\./g, '/');
  try {
    require('fs').writeFileSync(fspath, String(value) + '\n');
    console.log(`[network-tuning] sysctl ${key} = ${value}`);
  } catch (err) {
    console.warn(`[network-tuning] cannot write ${key}: ${err.message} (run as root?)`);
  }
}

function setIfChanged(key, desired) {
  const current = readSysctl(key);
  if (current === null) {
    console.warn(`[network-tuning] sysctl key ${key} not found`);
    return;
  }
  if (current === desired) {
    console.log(`[network-tuning] sysctl ${key} already ${desired} — no change`);
    return;
  }
  writeSysctl(key, desired);
}

function applyLinuxSysctl(cfg) {
  setIfChanged('net.ipv4.tcp_keepalive_time',   cfg.tcpKeepaliveTime);
  setIfChanged('net.ipv4.tcp_keepalive_intvl',  cfg.tcpKeepaliveIntvl);
  setIfChanged('net.ipv4.tcp_keepalive_probes', cfg.tcpKeepaliveProbes);
  setIfChanged('net.ipv4.tcp_retries2',         cfg.tcpRetries2);
}

// ─── Linux queue discipline helpers ─────────────────────────────────────────

function detectWanInterface(callback) {
  execFile('ip', ['route', 'show', 'default'], (err, stdout) => {
    if (err) {
      // Fallback: try 'route -n'
      execFile('route', ['-n'], (e2, s2) => {
        if (e2) return callback(null);
        const m = s2.match(/^0\.0\.0\.0\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)/m);
        callback(m ? m[1] : null);
      });
      return;
    }
    const m = stdout.match(/default\s+via\s+\S+\s+dev\s+(\S+)/);
    callback(m ? m[1] : null);
  });
}

function applyQdisc(iface, preferCake) {
  const qtype = preferCake ? 'cake' : 'fq_codel';
  // Allow override via env var; default 1Gbit suits most Starlink + GigE setups.
  const cakeBandwidth = process.env.CAKE_BANDWIDTH || '1Gbit';

  // Check if the desired qdisc is already active to stay idempotent.
  execFile('tc', ['qdisc', 'show', 'dev', iface], (err, stdout) => {
    if (err) {
      console.warn(`[network-tuning] tc qdisc show failed: ${err.message}`);
      return;
    }

    if (stdout.toLowerCase().includes(qtype)) {
      console.log(`[network-tuning] qdisc ${qtype} already active on ${iface}`);
      return;
    }

    // CAKE needs a bandwidth hint; without it, it still works as an AQM.
    const args = preferCake
      ? ['qdisc', 'replace', 'dev', iface, 'root', 'cake', 'bandwidth', cakeBandwidth, 'nat', 'ethernet']
      : ['qdisc', 'replace', 'dev', iface, 'root', 'fq_codel'];

    execFile('tc', args, (e) => {
      if (e) {
        if (preferCake) {
          console.warn(`[network-tuning] CAKE not available (${e.message}), trying fq_codel`);
          applyQdisc(iface, false);
        } else {
          console.warn(`[network-tuning] fq_codel apply failed: ${e.message}`);
        }
        return;
      }
      console.log(`[network-tuning] applied ${qtype} qdisc on ${iface}`);
    });
  });
}

function applyLinuxQdisc(cfg) {
  if (cfg.wanInterface) {
    applyQdisc(cfg.wanInterface, cfg.preferCake);
  } else {
    detectWanInterface((iface) => {
      if (!iface) {
        console.warn('[network-tuning] could not detect WAN interface — skipping qdisc');
        return;
      }
      console.log(`[network-tuning] detected WAN interface: ${iface}`);
      applyQdisc(iface, cfg.preferCake);
    });
  }
}

// ─── Windows TCP keepalive tuning ────────────────────────────────────────────

function applyWindowsTcpTuning(cfg) {
  // Set TCP keepalive via netsh (ms units for keepalive, seconds for interval)
  const keepaliveMs    = cfg.tcpKeepaliveTime * 1000;
  const keepaliveIntvl = cfg.tcpKeepaliveIntvl * 1000;

  // netsh interface tcp set global — available Windows Vista+
  execFile(
    'netsh',
    ['interface', 'tcp', 'set', 'global',
      `keepalivetime=${keepaliveMs}`,
      `keepaliveinterval=${keepaliveIntvl}`],
    (err) => {
      if (err) {
        console.warn('[network-tuning] netsh tcp tuning failed:', err.message);
      } else {
        console.log(
          `[network-tuning] Windows TCP keepalive: time=${keepaliveMs}ms interval=${keepaliveIntvl}ms`
        );
      }
    }
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply all network tuning idempotently.
 * Safe to call on startup; each setting is only written if it differs from
 * the current value.
 * @param {Partial<typeof DEFAULT_CFG>} [overrides]
 */
function applyTuning(overrides) {
  const cfg = Object.assign({}, DEFAULT_CFG, overrides);

  if (IS_LINUX) {
    applyLinuxSysctl(cfg);
    applyLinuxQdisc(cfg);
  } else if (IS_WINDOWS) {
    applyWindowsTcpTuning(cfg);
  } else {
    console.log(`[network-tuning] platform '${process.platform}' — skipping`);
  }
}

module.exports = { applyTuning };
