'use strict';

const { execFile } = require('child_process');

// Strict validators to prevent command injection
const IP_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
const MAC_PATTERN = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

function validateIP(ip) {
  if (!IP_PATTERN.test(ip)) throw new Error(`Invalid IP address: ${ip}`);
  const parts = ip.split('.').map(Number);
  if (parts.some((p) => p > 255)) throw new Error(`IP octet out of range: ${ip}`);
}

function validateMAC(mac) {
  if (!MAC_PATTERN.test(mac)) throw new Error(`Invalid MAC address: ${mac}`);
}

/**
 * Block outbound traffic from a specific IP via Windows Firewall.
 * Uses execFile with PowerShell arguments as an array to avoid command injection.
 * @param {string} ip   Remote IP address of the device to block.
 * @param {string} mac  MAC address used as part of the rule name.
 */
function block(ip, mac) {
  try {
    validateIP(ip);
    validateMAC(mac);
    const ruleName = `WIFIOS_BLOCK_${mac.replace(/:/g, '')}`;
    const psScript = `New-NetFirewallRule -DisplayName '${ruleName}' -Direction Outbound -RemoteAddress '${ip}' -Action Block -ErrorAction SilentlyContinue`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], (err) => {
      if (err) console.error(`[firewall] block error for ${mac}:`, err.message);
      else console.log(`[firewall] blocked ${ip} (${mac})`);
    });
  } catch (err) {
    console.error('[firewall] validation error:', err.message);
  }
}

/**
 * Remove a previously created block rule by MAC address.
 * Uses execFile with PowerShell arguments as an array to avoid command injection.
 * @param {string} mac  MAC address used when creating the rule.
 */
function allow(mac) {
  try {
    validateMAC(mac);
    const ruleName = `WIFIOS_BLOCK_${mac.replace(/:/g, '')}`;
    const psScript = `Remove-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], (err) => {
      if (err) console.error(`[firewall] allow error for ${mac}:`, err.message);
      else console.log(`[firewall] allowed ${mac}`);
    });
  } catch (err) {
    console.error('[firewall] validation error:', err.message);
  }
}

module.exports = { block, allow };
