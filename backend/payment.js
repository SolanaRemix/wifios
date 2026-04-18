'use strict';

const crypto = require('crypto');

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

module.exports = { createPayment };
