'use strict';

const crypto = require('crypto');
const { run } = require('./db');

/**
 * Build a pending payment object (not yet saved — server.js persists it).
 * @param {string} mac     Device MAC address
 * @param {number} amount  Payment amount in ₱
 * @param {number} time    Access time in seconds
 * @returns {{ ref: string, mac: string, amount: number, time: number, status: string }}
 */
function createPayment(mac, amount, time) {
  return {
    ref: 'PAY-' + crypto.randomUUID(),
    mac,
    amount,
    time,
    status: 'pending',
  };
}

/**
 * Activate a user session after payment is confirmed.
 * @param {string} mac   Device MAC address
 * @param {number} time  Access time in seconds to add
 */
async function confirmPayment(mac, time) {
  await run(
    "UPDATE users SET status = 'active', time_left = time_left + ? WHERE mac = ?",
    [time, mac]
  );
}

module.exports = { createPayment, confirmPayment };
