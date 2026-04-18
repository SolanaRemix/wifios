'use strict';

const QRCode = require('qrcode');

/**
 * Generate a QR code for the given URL as a base64 data URL.
 * @param {string} url  The URL to encode
 * @returns {Promise<string>}  Base64 data URL (image/png)
 */
async function generateQR(url) {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    margin: 2,
    width: 300,
  });
}

module.exports = { generateQR };
