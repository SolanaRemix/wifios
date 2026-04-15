'use strict';

const { run, all } = require('./db');
const { block } = require('./firewall');

const TICK_MS = 1_000; // 1-second resolution

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
    }
  } catch (err) {
    console.error('[scheduler] error:', err.message);
  }
}

setInterval(tick, TICK_MS);
console.log('⏱  Session scheduler started (1 s tick)');
