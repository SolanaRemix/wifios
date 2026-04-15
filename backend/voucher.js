'use strict';

/**
 * Generate a random voucher code and return a voucher descriptor.
 * The caller is responsible for persisting it to the database.
 *
 * @param {number} time  Access time in seconds
 * @returns {{ code: string, time: number }}
 */
function generateVoucher(time) {
  const code = 'WIFI-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  return { code, time };
}

module.exports = { generateVoucher };
