'use strict';

// watchdog.js — DNS resolver liveness watchdog + captive portal restart guard
//
// Periodically probes the local DNS resolver.  If more than `FAILURE_THRESHOLD`
// consecutive probes fail, it restarts the captive portal (dns-server.js).
//
// Guards against restart storms via:
//   • Exponential backoff between restart attempts.
//   • Rolling 10-minute window restart count cap.
//   • Jitter on the probe interval.

const dns    = require('dns');
const { Resolver } = dns.promises;

// ─── Configuration (overridable via env vars) ────────────────────────────────
const PROBE_INTERVAL_MS       = parseInt(process.env.WD_PROBE_INTERVAL_MS  || '15000', 10);
const PROBE_DOMAIN            = process.env.WD_PROBE_DOMAIN                || 'google.com';
const FAILURE_THRESHOLD       = parseInt(process.env.WD_FAILURE_THRESHOLD  || '3',     10);
const BACKOFF_MIN_MS          = parseInt(process.env.WD_BACKOFF_MIN_MS     || '10000', 10);
const BACKOFF_MAX_MS          = parseInt(process.env.WD_BACKOFF_MAX_MS     || '300000',10);
const MAX_RESTARTS_PER_WINDOW = parseInt(process.env.WD_MAX_RESTARTS       || '5',     10);
const WINDOW_MS               = 10 * 60 * 1000; // 10 minutes
const JITTER_MAX_MS           = parseInt(process.env.WD_JITTER_MS          || '2000',  10);
// Explicit per-probe timeout — dns.promises.Resolver constructor options do
// not apply a per-query timeout, so we enforce one via Promise.race.
const DNS_TIMEOUT_MS          = parseInt(process.env.WD_DNS_TIMEOUT_MS     || '2000',  10);

// DNS resolver to probe (defaults to the system resolver)
const DNS_RESOLVER = process.env.DNS_RESOLVER || '127.0.0.1';
const DNS_PORT     = parseInt(process.env.DNS_PORT || '53', 10);

// ─── State ───────────────────────────────────────────────────────────────────
let consecutiveFailures = 0;
let backoffMs           = BACKOFF_MIN_MS;
let lastRestartAt       = 0;         // epoch ms
let restartTimestamps   = [];        // rolling window
let probeTimer          = null;

// Injected at startup; allows restarting the DNS server without re-requiring.
let dnsServerRef = null;

/**
 * Register the dns-server module so the watchdog can restart it.
 * @param {{ restart: function(): Promise<void> }} ref
 */
function registerDnsServer(ref) {
  dnsServerRef = ref;
}

// ─── Probe ───────────────────────────────────────────────────────────────────

async function probeDns() {
  const resolver = new Resolver();
  resolver.setServers([`${DNS_RESOLVER}:${DNS_PORT}`]);

  // dns.promises.Resolver does not apply the timeout from its constructor
  // options, so we bound the probe duration explicitly with Promise.race.
  const probePromise = resolver.resolve4(PROBE_DOMAIN);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('DNS probe timeout')), DNS_TIMEOUT_MS)
  );

  try {
    await Promise.race([probePromise, timeoutPromise]);
    return true;
  } catch (_) {
    return false;
  }
}

// ─── Restart logic ───────────────────────────────────────────────────────────

async function triggerRestart(reason) {
  const now = Date.now();

  // Prune old timestamps outside the rolling window.
  restartTimestamps = restartTimestamps.filter((t) => now - t < WINDOW_MS);

  if (restartTimestamps.length >= MAX_RESTARTS_PER_WINDOW) {
    console.warn(
      `[watchdog] storm guard: ${restartTimestamps.length} restart(s) in last 10 min — holding off`
    );
    return;
  }

  if (now - lastRestartAt < backoffMs) {
    console.warn(
      `[watchdog] backoff active (${Math.round(backoffMs / 1000)}s remaining) — skipping restart`
    );
    return;
  }

  console.log(
    `[watchdog] triggering captive portal restart — reason: ${reason}, ` +
    `consecutive_failures: ${consecutiveFailures}, ` +
    `window_restarts: ${restartTimestamps.length}/${MAX_RESTARTS_PER_WINDOW}`
  );

  lastRestartAt = now;
  restartTimestamps.push(now);
  consecutiveFailures = 0;

  // Double backoff (capped).
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);

  if (dnsServerRef && typeof dnsServerRef.restart === 'function') {
    try {
      await dnsServerRef.restart();
      console.log('[watchdog] captive portal restarted successfully');
    } catch (err) {
      console.error('[watchdog] captive portal restart failed:', err.message);
    }
  } else {
    console.warn('[watchdog] no dns server reference registered — cannot restart');
  }
}

// ─── Tick ────────────────────────────────────────────────────────────────────

async function tick() {
  const ok = await probeDns();

  if (ok) {
    if (consecutiveFailures > 0) {
      console.log(`[watchdog] DNS resolver recovered after ${consecutiveFailures} failure(s)`);
      consecutiveFailures = 0;
      backoffMs = BACKOFF_MIN_MS;   // reset backoff on recovery
    }
  } else {
    consecutiveFailures += 1;
    console.warn(
      `[watchdog] DNS probe failed (${consecutiveFailures}/${FAILURE_THRESHOLD})`
    );

    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      await triggerRestart('dns_resolver_unresponsive');
    }
  }
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

function jitter() {
  return Math.floor(Math.random() * JITTER_MAX_MS);
}

function scheduleNext() {
  const delay = PROBE_INTERVAL_MS + jitter();
  probeTimer = setTimeout(async () => {
    try { await tick(); } catch (e) { console.error('[watchdog] tick error:', e.message); }
    scheduleNext();
  }, delay);
}

function start() {
  if (probeTimer) return; // already running
  console.log(
    `[watchdog] started — probing ${DNS_RESOLVER}:${DNS_PORT} for '${PROBE_DOMAIN}' ` +
    `every ~${PROBE_INTERVAL_MS / 1000}s (failure threshold: ${FAILURE_THRESHOLD})`
  );
  scheduleNext();
}

function stop() {
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

module.exports = {
  start,
  stop,
  probeDns,
  registerDnsServer,
  // Exposed for testing:
  _getState: () => ({ consecutiveFailures, backoffMs, restartTimestamps: [...restartTimestamps] }),
  _resetState: () => {
    consecutiveFailures = 0;
    backoffMs           = BACKOFF_MIN_MS;
    lastRestartAt       = 0;
    restartTimestamps   = [];
  },
};
