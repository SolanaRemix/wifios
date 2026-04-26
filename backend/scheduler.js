'use strict';

const fs   = require('fs');
const path = require('path');
const { run, all } = require('./db');
const { block } = require('./firewall');

const TICK_MS = 1_000; // 1-second resolution

// ─── Atomic state snapshot ───────────────────────────────────────────────────
// Persist the active session set to disk so the Rust reconciler (or a manual
// restart) can restore firewall rules quickly after a power cycle.

const STATE_DIR  = path.join(__dirname, '..', 'config');
const STATE_FILE = path.join(STATE_DIR, 'session-state.json');

/**
 * Write `state` atomically to STATE_FILE using the temp→fsync→rename pattern
 * so a mid-write power cycle always leaves a consistent file on disk.
 * @param {object} state
 */
async function persistState(state) {
  const json = JSON.stringify(state, null, 2);
  const tmpFile = STATE_FILE + '.tmp';
  try {
    // Ensure the config directory exists.
    fs.mkdirSync(STATE_DIR, { recursive: true });

    // Write to temp file.
    const fd = fs.openSync(tmpFile, 'w', 0o600);
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);   // flush data to storage
    fs.closeSync(fd);

    // Atomic rename: temp → final path.
    fs.renameSync(tmpFile, STATE_FILE);

    // Best-effort fsync the directory so the new entry is durable.
    try {
      const dirFd = fs.openSync(STATE_DIR, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch (_) { /* non-fatal on Windows */ }
  } catch (err) {
    console.error('[scheduler] state persist error:', err.message);
  }
}

/**
 * Snapshot active sessions to disk.  Called periodically and on each expire.
 */
async function snapshotState() {
  try {
    const rows = await all(
      `SELECT mac, ip, status, time_left, is_randomized FROM users
       WHERE status IN ('active', 'blocked')`
    );
    const sessions = {};
    const now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
      sessions[row.mac] = {
        mac:          row.mac,
        ip:           row.ip || null,
        status:       row.status,
        time_left:    row.time_left,
        is_randomized: row.is_randomized === 1,
        last_seen:    now,
      };
    }
    await persistState({ version: 1, updated_at: now, sessions });
  } catch (err) {
    console.error('[scheduler] snapshot error:', err.message);
  }
}

// ─── Session tick ─────────────────────────────────────────────────────────────

async function tick() {
  try {
    // Decrement active sessions
    await run(
      "UPDATE users SET time_left = time_left - 1 WHERE status = 'active' AND time_left > 0"
    );

    // Expire sessions whose time has run out; fetch their IPs so we can firewall them
    const expired = await all(
      "SELECT mac, ip FROM users WHERE status = 'active' AND time_left <= 0"
    );

    if (expired.length) {
      await run(
        "UPDATE users SET status = 'expired' WHERE status = 'active' AND time_left <= 0"
      );
      for (const { mac, ip } of expired) {
        console.log(`[scheduler] session expired: ${mac}`);
        if (ip) block(ip, mac);
      }
      // Snapshot after expiry so the reconciler sees the updated state.
      await snapshotState();
    }
  } catch (err) {
    console.error('[scheduler] error:', err.message);
  }
}

// Guard against overlapping ticks if a tick takes longer than TICK_MS
let isTickRunning = false;

setInterval(() => {
  if (isTickRunning) return;
  isTickRunning = true;
  tick().finally(() => {
    isTickRunning = false;
  });
}, TICK_MS);

// Snapshot state every 30 seconds to keep the durable store fresh.
setInterval(snapshotState, 30_000);

// Initial snapshot shortly after startup so a clean state is written even
// before the first session expires.
setTimeout(snapshotState, 5_000);

console.log('⏱  Session scheduler started (1 s tick)');
