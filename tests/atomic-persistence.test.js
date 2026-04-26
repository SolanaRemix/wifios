// tests/atomic-persistence.test.js — Unit tests for scheduler atomic state
// persistence and the state_store logic.
//
// Tests run with plain `node` (no test framework required).

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

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

// ─── Helper: create a temp directory ─────────────────────────────────────────
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wifios-test-'));
}

// ─── Replicate the persistence logic from scheduler.js ───────────────────────
// (Inline so we don't need to spin up the full server with SQLite.)

function persistState(stateFile, stateDir, state) {
  const json = JSON.stringify(state, null, 2);
  const tmpFile = stateFile + '.tmp';
  fs.mkdirSync(stateDir, { recursive: true });
  const fd = fs.openSync(tmpFile, 'w', 0o600);
  fs.writeSync(fd, json);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpFile, stateFile);
  try {
    const dirFd = fs.openSync(stateDir, 'r');
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
  } catch (_) { /* non-fatal on some platforms */ }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n── Atomic persistence: write + read back ──');

{
  const dir  = makeTmpDir();
  const file = path.join(dir, 'session-state.json');

  const state = {
    version: 1,
    updated_at: Math.floor(Date.now() / 1000),
    sessions: {
      'aa:bb:cc:dd:ee:ff': {
        mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.10',
        status: 'active', time_left: 3600, is_randomized: false,
        last_seen: Math.floor(Date.now() / 1000),
      },
    },
  };

  persistState(file, dir, state);

  assert(fs.existsSync(file), 'state file created after persist');
  assert(!fs.existsSync(file + '.tmp'), 'temp file cleaned up after rename');

  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertEqual(loaded.version, 1, 'version preserved');
  assert(loaded.sessions['aa:bb:cc:dd:ee:ff'] !== undefined, 'session entry preserved');
  assertEqual(loaded.sessions['aa:bb:cc:dd:ee:ff'].status, 'active', 'status preserved');
  assertEqual(loaded.sessions['aa:bb:cc:dd:ee:ff'].time_left, 3600, 'time_left preserved');

  fs.rmSync(dir, { recursive: true });
}

console.log('\n── Atomic persistence: simulated crash (tmp file left behind) ──');

{
  const dir  = makeTmpDir();
  const file = path.join(dir, 'session-state.json');
  const tmp  = file + '.tmp';

  // Simulate a crash mid-write: leave a partial JSON in the tmp file,
  // but no final state file.
  fs.writeFileSync(tmp, '{ "version": 1, "partial_write": true');

  assert(!fs.existsSync(file),  'no state file before recovery');
  assert(fs.existsSync(tmp),    'tmp file exists (simulated crash)');

  // Write a good state — this should overwrite the stale tmp and produce a clean file.
  const goodState = { version: 1, updated_at: 0, sessions: {} };
  persistState(file, dir, goodState);

  assert(fs.existsSync(file),  'state file created after recovery write');
  assert(!fs.existsSync(tmp),  'stale tmp file replaced');
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(loaded.partial_write === undefined, 'partial write content not in final file');

  fs.rmSync(dir, { recursive: true });
}

console.log('\n── Atomic persistence: overwrite preserves atomicity ──');

{
  const dir  = makeTmpDir();
  const file = path.join(dir, 'session-state.json');

  const stateV1 = { version: 1, updated_at: 1, sessions: { 'a1:b2:c3:d4:e5:f6': { status: 'active' } } };
  const stateV2 = { version: 1, updated_at: 2, sessions: {} };

  persistState(file, dir, stateV1);
  persistState(file, dir, stateV2);

  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertEqual(loaded.updated_at, 2,         'updated_at reflects v2');
  assert(Object.keys(loaded.sessions).length === 0, 'v2 sessions empty (overwrite succeeded)');

  fs.rmSync(dir, { recursive: true });
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
