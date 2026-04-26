'use strict';

const { exec } = require('child_process');
const { run } = require('./db');
const { isRandomizedMac, resolveSessionMac } = require('./mac-randomization');

/**
 * Parse ARP output from both Windows and Unix (Linux/macOS) formats.
 *
 * Windows:  "  192.168.1.2          aa-bb-cc-dd-ee-ff     dynamic"
 * Linux:    "? (192.168.1.2) at aa:bb:cc:dd:ee:ff [ether] on eth0"
 * macOS:    "? (192.168.1.2) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]"
 *
 * All MACs are normalised to lowercase colon-delimited format (aa:bb:cc:dd:ee:ff).
 * Duplicate IP+MAC pairs are deduplicated before returning.
 *
 * @param {string} stdout  Raw stdout from `arp -a`
 * @returns {{ ip: string, mac: string }[]}
 */
function parseArpOutput(stdout) {
  const seen = new Set();
  const devices = [];

  const normalise = (mac) => mac.toLowerCase().replace(/-/g, ':');

  const addDevice = (ip, mac) => {
    const key = `${ip}|${normalise(mac)}`;
    if (seen.has(key)) return;
    seen.add(key);
    devices.push({ ip, mac: normalise(mac) });
  };

  // Windows: IP and MAC appear on the same line, separated by whitespace
  const winPattern = /(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})/g;
  let match;
  while ((match = winPattern.exec(stdout)) !== null) {
    addDevice(match[1], match[2]);
  }

  // Unix/macOS: "(IP) at MAC"
  const unixPattern = /\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/g;
  while ((match = unixPattern.exec(stdout)) !== null) {
    addDevice(match[1], match[2]);
  }

  return devices;
}

async function upsertDevices(devices) {
  for (const { ip, mac } of devices) {
    // Resolve MAC: if it is randomized and the IP already has a canonical
    // session, use the canonical MAC to avoid creating ghost entries.
    const { mac: resolvedMac } = await resolveSessionMac(mac, ip);

    // Compute is_randomized from the *resolved* MAC so that when a randomized
    // MAC is deduped onto the canonical, the canonical row keeps is_randomized=0.
    const resolvedIsRandomized = isRandomizedMac(resolvedMac);

    await run(
      `INSERT INTO users (mac, ip, is_randomized, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(mac) DO UPDATE SET
         ip           = excluded.ip,
         is_randomized = excluded.is_randomized,
         updated_at   = CURRENT_TIMESTAMP`,
      [resolvedMac, ip, resolvedIsRandomized ? 1 : 0]
    );
  }
}

async function scanDevices() {
  exec('arp -a', async (err, stdout) => {
    if (err) {
      console.error('[mac-engine] arp scan error:', err.message);
      return;
    }
    const devices = parseArpOutput(stdout);
    try {
      await upsertDevices(devices);
      if (devices.length) {
        console.log(`[mac-engine] ${devices.length} device(s) found`);
      }
    } catch (dbErr) {
      console.error('[mac-engine] DB error:', dbErr.message);
    }
  });
}

// Scan every 10 seconds
setInterval(scanDevices, 10_000);
scanDevices(); // immediate first scan

console.log('📡 MAC engine started (scanning every 10 s)');
