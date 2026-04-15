'use strict';

/**
 * Generate a plain-text receipt for a confirmed payment.
 * @param {{ ref: string, mac: string, time: number, amount: number }} data
 * @returns {string}
 */
function generateReceipt(data) {
  const date = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
  const minutes = Math.round(data.time / 60);
  return [
    '================================',
    '         WiFi Zone OS V3        ',
    '================================',
    `Date   : ${date}`,
    `Ref    : ${data.ref}`,
    `Device : ${data.mac}`,
    `Time   : ${minutes} minute${minutes !== 1 ? 's' : ''}`,
    `Amount : ₱${Number(data.amount).toFixed(2)}`,
    '================================',
    '   Thank you for your purchase!  ',
    '================================',
  ].join('\n');
}

module.exports = { generateReceipt };
