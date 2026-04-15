'use strict';

const crypto = require('crypto');

/**
 * Generate a cryptographically random voucher code and return a voucher descriptor.
 * The caller is responsible for persisting it to the database.
 *
 * @param {number} time  Access time in seconds
 * @returns {{ code: string, time: number }}
 */
function generateVoucher(time) {
  // Use 4 random bytes → 8 uppercase hex chars (e.g. WIFI-A3F7B2C9)
  const code = 'WIFI-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  return { code, time };
}

module.exports = { generateVoucher };
