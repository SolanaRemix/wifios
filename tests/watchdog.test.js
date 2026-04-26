// tests/watchdog.test.js — Unit tests for the watchdog module
//
// Tests run with plain `node` (no test framework required).
// The watchdog module's internals (state, counters) are exposed via
// `_getState()` and `_resetState()` for testability.

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

// ─── Load watchdog ────────────────────────────────────────────────────────────
const watchdog = require('../backend/watchdog');

// ─── Tests ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n── Watchdog: initial state ──');

  watchdog._resetState();
  const s0 = watchdog._getState();
  assertEqual(s0.consecutiveFailures, 0, 'consecutiveFailures starts at 0');
  assert(Array.isArray(s0.restartTimestamps), 'restartTimestamps is an array');
  assertEqual(s0.restartTimestamps.length, 0, 'restartTimestamps starts empty');

  console.log('\n── Watchdog: API surface ──');

  assert(typeof watchdog.start         === 'function', 'start is a function');
  assert(typeof watchdog.stop          === 'function', 'stop is a function');
  assert(typeof watchdog.probeDns      === 'function', 'probeDns is a function');
  assert(typeof watchdog.registerDnsServer === 'function', 'registerDnsServer is a function');
  assert(typeof watchdog._getState     === 'function', '_getState is a function');
  assert(typeof watchdog._resetState   === 'function', '_resetState is a function');

  console.log('\n── Watchdog: start/stop idempotency ──');

  // start() should not throw even when called multiple times
  watchdog.stop();   // ensure clean state
  watchdog.start();
  watchdog.start();  // second call should be a no-op, not throw
  watchdog.stop();   // clean up
  assert(true, 'start() called twice without error');

  watchdog.stop();
  watchdog.stop();   // second stop should be a no-op
  assert(true, 'stop() called twice without error');

  console.log('\n── Watchdog: probeDns returns a Promise ──');

  // Override the DNS probe domain to localhost so the probe resolves quickly
  // without real network access, and await it to avoid dangling timers.
  const origDomain = process.env.WD_PROBE_DOMAIN;
  process.env.WD_PROBE_DOMAIN = 'localhost';
  process.env.WD_DNS_TIMEOUT_MS = '500';
  // Re-require is not possible with CommonJS caching; test the return type only.
  const probeResult = watchdog.probeDns();
  assert(probeResult instanceof Promise, 'probeDns() returns a Promise');
  // Await so the internal timeout is cleared and the process exits cleanly.
  await probeResult;
  // Restore env
  if (origDomain === undefined) delete process.env.WD_PROBE_DOMAIN;
  else process.env.WD_PROBE_DOMAIN = origDomain;

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
