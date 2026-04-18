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
 * Any pre-existing rule for this MAC is removed first so the rule is always fresh.
 * @param {string} ip   Remote IP address of the device to block.
 * @param {string} mac  MAC address used as part of the rule name.
 */
function block(ip, mac) {
  try {
    validateIP(ip);
    validateMAC(mac);
    const ruleName = `WIFIOS_BLOCK_${mac.replace(/:/g, '')}`;

    // Defense-in-depth: after validation, strip any characters that aren't
    // alphanumeric or underscore/dot so nothing unexpected reaches PowerShell.
    const safeRuleName = ruleName.replace(/[^A-Za-z0-9_]/g, '');
    const safeIp = ip.replace(/[^0-9.]/g, '');

    // Step 1: remove any pre-existing rule (idempotent), then create the block rule.
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Remove-NetFirewallRule -DisplayName '${safeRuleName}' -ErrorAction SilentlyContinue`],
      (removeErr) => {
        if (removeErr) {
          console.error(`[firewall] remove-before-block error for ${mac}:`, removeErr.message);
        }
        // Step 2: create the block rule regardless of whether removal succeeded.
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command',
            `New-NetFirewallRule -DisplayName '${safeRuleName}' -Direction Outbound -RemoteAddress '${safeIp}' -Action Block -ErrorAction Stop`],
          (err) => {
            if (err) console.error(`[firewall] block error for ${mac}:`, err.message);
            else console.log(`[firewall] blocked ${ip} (${mac})`);
          }
        );
      }
    );
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
    const safeRuleName = ruleName.replace(/[^A-Za-z0-9_]/g, '');
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Remove-NetFirewallRule -DisplayName '${safeRuleName}' -ErrorAction SilentlyContinue`],
      (err) => {
        if (err) console.error(`[firewall] allow error for ${mac}:`, err.message);
        else console.log(`[firewall] allowed ${mac}`);
      }
    );
  } catch (err) {
    console.error('[firewall] validation error:', err.message);
  }
}

module.exports = { block, allow };
