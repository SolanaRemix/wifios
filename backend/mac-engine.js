'use strict';

const { exec } = require('child_process');
const { run, get } = require('./db');

/**
 * Parse ARP output (cross-platform) and upsert devices into the DB.
 * Expected line format (Windows): "  192.168.1.x  aa-bb-cc-dd-ee-ff  dynamic"
 * Expected line format (Linux):   "? (192.168.1.x) at aa:bb:cc:dd:ee:ff [ether] ..."
 */
function parseArpOutput(stdout) {
  const devices = [];

  // Windows: "  192.168.1.2          aa-bb-cc-dd-ee-ff     dynamic"
  const winPattern = /(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})/g;
  let match;
  while ((match = winPattern.exec(stdout)) !== null) {
    devices.push({ ip: match[1], mac: match[2].toLowerCase().replace(/-/g, ':') });
  }
  return devices;
}

async function upsertDevices(devices) {
  for (const { ip, mac } of devices) {
    await run(
      `INSERT INTO users (mac, ip)
       VALUES (?, ?)
       ON CONFLICT(mac) DO UPDATE SET ip = excluded.ip`,
      [mac, ip]
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
