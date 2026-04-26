'use strict';

// mac-randomization.js — Detect and handle MAC address randomization
//
// Modern iOS (since iOS 14), Android 10+, and Windows 10+ randomize the MAC
// address per network by setting the "locally administered" bit (bit 1 of the
// first octet).  This causes wifios to create duplicate/ghost sessions.
//
// Strategy:
//   1. isRandomizedMac(mac)         — detect locally-administered bit.
//   2. resolveSessionMac(mac, ip)   — if MAC is randomized AND the same IP
//      already has an active non-randomized session, return the canonical MAC
//      so the caller can reuse it instead of creating a ghost entry.
//   3. pruneStaleRandomizedSessions() — periodically remove DB entries for
//      randomized MACs that haven't been seen for STALE_THRESHOLD_SECS.

const { run, all } = require('./db');

// Randomized MACs that haven't been seen for this many seconds are pruned.
const STALE_THRESHOLD_SECS = parseInt(process.env.MAC_STALE_SECS || '300', 10);

/**
 * Returns true if `mac` is a locally-administered (potentially randomized)
 * MAC address.  The locally-administered bit is bit 1 (value 0x02) of the
 * first octet.
 *
 * @param {string} mac  Normalised lowercase colon-delimited MAC.
 * @returns {boolean}
 */
function isRandomizedMac(mac) {
  const firstOctet = parseInt(mac.split(':')[0], 16);
  // Bit 1 of first octet: 0x02 = locally administered (likely randomized)
  return (firstOctet & 0x02) !== 0;
}

/**
 * Given a (mac, ip) pair, determine the canonical MAC to use for session
 * correlation.
 *
 * If `mac` is a randomized MAC and there is already an active non-randomized
 * session for the same IP, the canonical MAC is returned so the request is
 * attributed to the existing session instead of spawning a ghost.
 *
 * @param {string}      mac  Normalised MAC address of the connecting device.
 * @param {string|null} ip   Current IP address of the device (may be null).
 * @returns {Promise<{ mac: string, isRandomized: boolean, wasDeduped: boolean }>}
 */
async function resolveSessionMac(mac, ip) {
  const randomized = isRandomizedMac(mac);

  if (!randomized || !ip) {
    return { mac, isRandomized: randomized, wasDeduped: false };
  }

  // Look for a non-randomized session that currently holds this IP.
  const existing = await all(
    `SELECT mac FROM users
     WHERE ip = ? AND status IN ('active', 'blocked')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END
     LIMIT 1`,
    [ip]
  );

  if (existing.length > 0) {
    const canonicalMac = existing[0].mac;
    if (canonicalMac !== mac && !isRandomizedMac(canonicalMac)) {
      console.log(
        `[mac-random] dedup: randomized ${mac} → canonical ${canonicalMac} (same IP ${ip})`
      );
      return { mac: canonicalMac, isRandomized: true, wasDeduped: true };
    }
  }

  return { mac, isRandomized: true, wasDeduped: false };
}

/**
 * Mark a device record with the randomization flag.
 * Adds an `is_randomized` column value if the schema supports it.
 *
 * @param {string}  mac
 * @param {boolean} isRandomized
 */
async function markRandomized(mac, isRandomized) {
  try {
    await run(
      `UPDATE users SET is_randomized = ? WHERE mac = ?`,
      [isRandomized ? 1 : 0, mac]
    );
  } catch (_) {
    // Column may not exist on older schemas — non-fatal.
  }
}

/**
 * Remove DB entries for randomized MACs that haven't been updated for longer
 * than STALE_THRESHOLD_SECS.  Only removes 'expired' and 'blocked' entries to
 * avoid touching active sessions.
 *
 * @returns {Promise<number>} Number of rows removed.
 */
async function pruneStaleRandomizedSessions() {
  try {
    const result = await run(
      `DELETE FROM users
       WHERE is_randomized = 1
         AND status IN ('expired', 'blocked')
         AND (strftime('%s', 'now') - strftime('%s', updated_at)) > ?`,
      [STALE_THRESHOLD_SECS]
    );
    const pruned = result.changes || 0;
    if (pruned > 0) {
      console.log(`[mac-random] pruned ${pruned} stale randomized MAC session(s)`);
    }
    return pruned;
  } catch (err) {
    console.warn(`[mac-random] prune error: ${err.message}`);
    return 0;
  }
}

// Run a prune cycle every STALE_THRESHOLD_SECS (at most once per minute).
// unref() so this timer does not prevent the process from exiting in test mode.
const PRUNE_INTERVAL_MS = Math.max(STALE_THRESHOLD_SECS * 1000, 60_000);
setInterval(pruneStaleRandomizedSessions, PRUNE_INTERVAL_MS).unref();

module.exports = {
  isRandomizedMac,
  resolveSessionMac,
  markRandomized,
  pruneStaleRandomizedSessions,
  STALE_THRESHOLD_SECS,
};
