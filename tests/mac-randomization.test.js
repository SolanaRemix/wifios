// tests/mac-randomization.test.js — Unit tests for MAC randomization module
//
// Tests run with plain `node` (no test framework required) since the project
// has no existing test runner.  Each assertion throws on failure.

'use strict';

// ─── Minimal assert helper ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function assertEqual(a, b, label) {
  assert(a === b, `${label} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// ─── Unit under test ─────────────────────────────────────────────────────────
const { isRandomizedMac, STALE_THRESHOLD_SECS } = require('../backend/mac-randomization');

// ─── Test suite ──────────────────────────────────────────────────────────────

console.log('\n── isRandomizedMac ──');

// Locally-administered MACs have bit 1 of octet 0 = 1 (e.g. 0x02 mask)
assert(isRandomizedMac('02:00:00:00:00:01'),  'AA:00:00:00:00:01 (LA bit set, first octet 0x02)');
assert(isRandomizedMac('aa:bb:cc:dd:ee:ff'),  'aa:bb:cc:dd:ee:ff (0xaa = 0b10101010, LA bit set)');
assert(isRandomizedMac('16:32:64:00:00:01'),  '16:32:... (0x16 & 0x02 = 0x02, LA bit set)');
assert(!isRandomizedMac('00:11:22:33:44:55'), '00:11:... globally administered MAC');
assert(!isRandomizedMac('ac:de:48:00:11:22'), 'ac:de:... Apple OUI (globally administered)');
assert(!isRandomizedMac('4c:57:ca:00:11:22'), '4c:57:ca Apple OUI (globally administered)');
assert(isRandomizedMac('ee:ff:00:11:22:33'),  'ee:ff:... (0xee & 0x02 = 0x02, LA bit set)');

// Edge cases
assert(!isRandomizedMac('00:00:00:00:00:00'), 'all-zeros MAC — not locally administered');

console.log('\n── STALE_THRESHOLD_SECS ──');
assert(typeof STALE_THRESHOLD_SECS === 'number', 'STALE_THRESHOLD_SECS is a number');
assert(STALE_THRESHOLD_SECS > 0,                 'STALE_THRESHOLD_SECS is positive');

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
