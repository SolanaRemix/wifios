'use strict';

const express = require('express');
const http = require('http');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const rateLimit = require('express-rate-limit');
const { hashPassword, verifyPassword } = require('./auth');
const { v4: uuidv4 } = require('uuid');
const { WebSocketServer, WebSocket } = require('ws');
const si = require('systeminformation');

const { run, get, all, transaction } = require('./db');
const { createPayment } = require('./payment');
const { generateVoucher } = require('./voucher');
const { generateQR } = require('./qr');
const { getStats } = require('./analytics');
const { generateReceipt } = require('./receipt');
const { block, allow } = require('./firewall');
const { applyTuning } = require('./network-tuning');
const watchdog = require('./watchdog');

// ──────────────────────────────────────────────
// DNS child process management
//
// When DNS_SERVER_MODE=child, server.js spawns dns-server.js as a managed
// child process so the watchdog can actually restart it on DNS failure.
// When DNS_SERVER_MODE is unset or 'external', the DNS server is expected to
// be started and supervised by an external script (e.g. start.ps1), and the
// Node watchdog will warn that it cannot restart it.
// ──────────────────────────────────────────────
const DNS_SERVER_MODE = process.env.DNS_SERVER_MODE || 'external';
let _dnsChildProc = null;

function spawnDnsServer() {
  const dnsPath = path.join(__dirname, 'dns-server.js');
  const child = require('child_process').fork(dnsPath, [], {
    env: { ...process.env },
    silent: false,
  });
  child.on('exit', (code, signal) => {
    console.warn(`[server] dns-server exited (code=${code}, signal=${signal})`);
    _dnsChildProc = null;
  });
  child.on('error', (err) => {
    console.error('[server] dns-server process error:', err.message);
  });
  console.log(`[server] dns-server spawned (pid=${child.pid})`);
  return child;
}

/**
 * Kill the current DNS child (if any) and spawn a fresh one.
 * Used by the watchdog and the /internal/restart-portal endpoint.
 * @returns {Promise<void>}
 */
function restartDnsChildProcess() {
  return new Promise((resolve) => {
    if (_dnsChildProc) {
      _dnsChildProc.kill('SIGTERM');
      _dnsChildProc = null;
    }
    // Brief pause to let the OS reclaim port 53 before re-binding.
    setTimeout(() => {
      _dnsChildProc = spawnDnsServer();
      resolve();
    }, 300);
  });
}

const app = express();

function getPortFromEnv(portValue) {
  if (portValue === undefined || portValue === null || portValue === '') return 3000;
  if (!/^\d+$/.test(portValue)) throw new Error(`Invalid PORT environment variable '${portValue}': must be a valid integer`);
  const port = Number.parseInt(portValue, 10);
  if (port < 0 || port > 65535) throw new Error('Invalid PORT environment variable: must be between 0 and 65535');
  return port;
}

const PORT = getPortFromEnv(process.env.PORT);

// ──────────────────────────────────────────────
// Session secret – persisted so restarts don't invalidate active sessions
// ──────────────────────────────────────────────
const SECRET_FILE = path.join(__dirname, '..', 'config', '.session-secret');
let SESSION_SECRET;
if (process.env.SESSION_SECRET) {
  SESSION_SECRET = process.env.SESSION_SECRET;
} else if (fs.existsSync(SECRET_FILE)) {
  SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} else {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 });
  } catch (_) { /* non-fatal: will regenerate on next restart */ }
}

// ──────────────────────────────────────────────
// Normalise MAC address to lowercase colon-delimited format
// ──────────────────────────────────────────────
function normaliseMac(mac) {
  return mac.toLowerCase().replace(/-/g, ':');
}

const MAC_RE = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/admin', express.static(path.join(__dirname, '..', 'admin-panel')));

// Store sessionMiddleware in a variable so it can be reused for WebSocket auth
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
});

app.use(sessionMiddleware);

// ──────────────────────────────────────────────
// DB initialisation (idempotent)
// ──────────────────────────────────────────────

/**
 * Apply schema.sql to the database so schema changes only need to be made in one place.
 * Strips comment lines then executes each semicolon-delimited statement.
 */
async function applySchemaFromFile() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const statements = schemaSql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await run(statement);
  }
}

async function initDB() {
  await applySchemaFromFile();

  // Migrate existing databases: add columns introduced in later schema versions.
  // These ALTER TABLE statements are safe to run multiple times because we
  // catch the "duplicate column" error and continue.
  const migrations = [
    "ALTER TABLE users ADD COLUMN is_randomized INTEGER NOT NULL DEFAULT 0",
    // NOT NULL with a DEFAULT means SQLite fills existing rows on ALTER TABLE.
    "ALTER TABLE users ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
  ];
  for (const stmt of migrations) {
    try { await run(stmt); } catch (_) { /* column already exists — skip */ }
  }

  // Back-fill any NULL updated_at values that may exist from the nullable version.
  await run(`UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`);

  // Install/replace a trigger so every UPDATE to a users row automatically
  // refreshes updated_at — this keeps the MAC pruning logic accurate without
  // requiring every UPDATE statement to explicitly set the column.
  await run('DROP TRIGGER IF EXISTS users_set_updated_at');
  await run(`
    CREATE TRIGGER users_set_updated_at
    AFTER UPDATE ON users
    FOR EACH ROW
    WHEN COALESCE(NEW.updated_at, '') = COALESCE(OLD.updated_at, '')
    BEGIN
      UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END
  `);

  // Seed default admin with a random temporary password
  const admin = await get('SELECT id FROM admin WHERE username = ?', ['admin']);
  if (!admin) {
    const tempPassword = crypto.randomBytes(12).toString('hex');
    const hash = await hashPassword(tempPassword);
    await run('INSERT INTO admin (username, password, first_login) VALUES (?,?,1)', ['admin', hash]);
    console.log('═══════════════════════════════════════════════════');
    console.log('  Default admin created.');
    console.log(`  Username : admin`);
    console.log(`  Password : ${tempPassword}`);
    console.log('  ⚠️  Change this password immediately after login!');
    console.log('═══════════════════════════════════════════════════');
  }
}

// ──────────────────────────────────────────────
// Auth helpers
// ──────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'Unauthorised' });
}

/**
 * CSRF protection middleware for state-changing admin routes.
 * Requires the X-CSRF-Token header to match the token stored in the session.
 */
function requireCSRF(req, res, next) {
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

/**
 * Middleware that restricts a route to requests originating from localhost.
 * Used for internal endpoints consumed by the Rust reconciler and watchdog;
 * these bypass admin session + CSRF checks but are not exposed externally.
 */
function requireLocalhost(req, res, next) {
  const addr = req.socket.remoteAddress || '';
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') {
    return next();
  }
  return res.status(403).json({ error: 'forbidden' });
}

/** Rate limiter: max 5 login attempts per IP per 15 minutes. */
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

/** Custom error class for HTTP errors thrown inside route handlers. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.httpStatus = status;
  }
}

// ──────────────────────────────────────────────
// Routes – Authentication
// ──────────────────────────────────────────────
app.post('/login', loginRateLimit, async (req, res) => {
  const { user, pass } = req.body;
  if (!user || !pass) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const row = await get('SELECT * FROM admin WHERE username = ?', [user]);
    if (!row) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await verifyPassword(pass, row.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.adminId = row.id;
    req.session.csrfToken = uuidv4();

    if (row.first_login) {
      return res.json({ redirect: '/change-password.html', csrfToken: req.session.csrfToken });
    }
    return res.json({ success: true, redirect: '/admin/dashboard.html', csrfToken: req.session.csrfToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/change-password', requireAdmin, requireCSRF, async (req, res) => {
  const { pass } = req.body;
  if (!pass || pass.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const hash = await hashPassword(pass);
    await run('UPDATE admin SET password = ?, first_login = 0 WHERE id = ?', [hash, req.session.adminId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ──────────────────────────────────────────────
// Routes – User / Device Management
// ──────────────────────────────────────────────
app.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await all('SELECT * FROM users ORDER BY created_at DESC');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/block/:mac', requireAdmin, requireCSRF, async (req, res) => {
  const rawMac = req.params.mac;
  if (!MAC_RE.test(rawMac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }
  const mac = normaliseMac(rawMac);
  try {
    const user = await get('SELECT ip FROM users WHERE mac = ?', [mac]);
    if (user && user.ip) block(user.ip, mac);
    await run("UPDATE users SET status = 'blocked', time_left = 0 WHERE mac = ?", [mac]);
    broadcast('device-blocked', { mac });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/allow/:mac', requireAdmin, requireCSRF, async (req, res) => {
  const rawMac = req.params.mac;
  if (!MAC_RE.test(rawMac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }
  const mac = normaliseMac(rawMac);
  try {
    allow(mac);
    await run("UPDATE users SET status = 'active' WHERE mac = ?", [mac]);
    broadcast('device-allowed', { mac });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Routes – Payments
// ──────────────────────────────────────────────
app.post('/pay', async (req, res) => {
  const { mac: rawMac } = req.body;
  const amount = Number(req.body.amount);
  const pricing = require('../config/pricing.json');
  const tier = pricing.rates.find((r) => r.price === amount);

  if (!tier) return res.status(400).json({ error: 'Invalid amount' });
  if (!rawMac || !MAC_RE.test(rawMac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }
  const mac = normaliseMac(rawMac);

  try {
    const payment = createPayment(mac, amount, tier.time);
    await run('INSERT OR IGNORE INTO users (mac) VALUES (?)', [mac]);
    await run(
      'INSERT INTO payments (ref, mac, amount, time_grant, status) VALUES (?,?,?,?,?)',
      [payment.ref, mac, amount, tier.time, 'pending']
    );
    res.json({ ref: payment.ref, message: 'Payment pending. Waiting for confirmation.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/confirm-payment', requireAdmin, requireCSRF, async (req, res) => {
  const { ref } = req.body;
  if (!ref) return res.status(400).json({ error: 'Missing payment ref' });

  try {
    // Wrap status update + user grant + receipt insert in one transaction so
    // partial failures don't leave a 'confirmed' payment without granting access.
    const payment = await transaction(async () => {
      const result = await run(
        "UPDATE payments SET status = 'confirmed' WHERE ref = ? AND status = 'pending'",
        [ref]
      );
      if (result.changes === 0) {
        const existing = await get('SELECT status FROM payments WHERE ref = ?', [ref]);
        if (!existing) throw new HttpError(404, 'Payment not found');
        throw new HttpError(400, 'Payment already processed');
      }

      const pmt = await get('SELECT * FROM payments WHERE ref = ?', [ref]);

      await run(
        "UPDATE users SET status = 'active', time_left = time_left + ? WHERE mac = ?",
        [pmt.time_grant, pmt.mac]
      );
      await run(
        'INSERT INTO receipts (ref, mac, amount, time_grant) VALUES (?,?,?,?)',
        [pmt.ref, pmt.mac, pmt.amount, pmt.time_grant]
      );
      return pmt;
    });

    const receipt = generateReceipt({
      mac: payment.mac,
      time: payment.time_grant,
      amount: payment.amount,
      ref: payment.ref,
    });
    allow(payment.mac);
    broadcast('payment-confirmed', { ref: payment.ref, mac: payment.mac });
    res.json({ success: true, receipt });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get('/payments', requireAdmin, async (req, res) => {
  try {
    const payments = await all('SELECT * FROM payments ORDER BY created_at DESC LIMIT 100');
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Routes – Vouchers
// ──────────────────────────────────────────────
app.post('/voucher/generate', requireAdmin, requireCSRF, async (req, res) => {
  const { time } = req.body;
  if (!time || isNaN(Number(time)) || Number(time) <= 0) {
    return res.status(400).json({ error: 'Invalid time value' });
  }
  try {
    const voucher = generateVoucher(Number(time));
    await run('INSERT INTO vouchers (code, time_grant) VALUES (?,?)', [voucher.code, voucher.time]);
    res.json(voucher);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/voucher/redeem', async (req, res) => {
  const { code, mac: rawMac } = req.body;
  if (!code || !rawMac) return res.status(400).json({ error: 'Missing code or MAC' });
  if (!MAC_RE.test(rawMac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }
  const mac = normaliseMac(rawMac);

  try {
    // Pre-check to give a clean 404 before acquiring a write lock
    const voucher = await get('SELECT * FROM vouchers WHERE code = ? AND used = 0', [code]);
    if (!voucher) return res.status(404).json({ error: 'Invalid or already used voucher' });

    // Wrap mark-as-used + user grant in a transaction so the voucher is never
    // consumed without granting access (and vice versa).
    await transaction(async () => {
      const result = await run(
        'UPDATE vouchers SET used = 1 WHERE id = ? AND used = 0',
        [voucher.id]
      );
      if (result.changes === 0) {
        throw new HttpError(409, 'Voucher already redeemed');
      }

      await run('INSERT OR IGNORE INTO users (mac) VALUES (?)', [mac]);
      await run(
        "UPDATE users SET status = 'active', time_left = time_left + ? WHERE mac = ?",
        [voucher.time_grant, mac]
      );
    });

    allow(mac);
    broadcast('voucher-redeemed', { mac });
    res.json({ success: true, time_grant: voucher.time_grant });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get('/vouchers', requireAdmin, async (req, res) => {
  try {
    const vouchers = await all('SELECT * FROM vouchers ORDER BY created_at DESC');
    res.json(vouchers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Routes – QR Code
// ──────────────────────────────────────────────
app.get('/qr', requireAdmin, async (req, res) => {
  try {
    // Build the portal URL from trusted config/env rather than the user-controlled
    // Host header to prevent open-redirect / spoofed QR codes.
    const sysConfig = (() => { try { return require('../config/system.json'); } catch (_) { return {}; } })();
    const baseUrl = process.env.PORTAL_PUBLIC_URL
      || (sysConfig.portalIP ? `http://${sysConfig.portalIP}` : `http://localhost:${PORT}`);
    const url = new URL('/', baseUrl).toString();
    const dataUrl = await generateQR(url);
    res.json({ qr: dataUrl, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Routes – Analytics
// ──────────────────────────────────────────────
app.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Routes – Receipts
// ──────────────────────────────────────────────
app.get('/receipts', requireAdmin, async (req, res) => {
  try {
    const receipts = await all('SELECT * FROM receipts ORDER BY created_at DESC LIMIT 100');
    res.json(receipts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Routes – System Info
// ──────────────────────────────────────────────
app.get('/system', requireAdmin, async (req, res) => {
  try {
    const [cpu, mem, disk, net] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
    ]);
    res.json({
      cpu: {
        load: parseFloat(cpu.currentLoad.toFixed(1)),
      },
      memory: {
        total: mem.total,
        used: mem.used,
        free: mem.free,
        usedPercent: parseFloat(((mem.used / mem.total) * 100).toFixed(1)),
      },
      disk: disk.map((d) => ({
        fs: d.fs,
        size: d.size,
        used: d.used,
        usedPercent: parseFloat(d.use.toFixed(1)),
        mount: d.mount,
      })),
      network: net.map((n) => ({
        iface: n.iface,
        rxSec: Math.round(n.rx_sec),
        txSec: Math.round(n.tx_sec),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Routes – Pricing
// ──────────────────────────────────────────────
app.get('/pricing', (req, res) => {
  res.json(require('../config/pricing.json'));
});

// ──────────────────────────────────────────────
// Routes – Internal (reconciler / watchdog use)
//
// All routes under /internal are restricted to localhost-only via the
// requireLocalhost middleware.  They do NOT require an admin session or CSRF
// token so that the Rust reconciler daemon can call them without credentials.
// ──────────────────────────────────────────────

// GET /internal/users — return all user rows (no admin session required).
app.get('/internal/users', requireLocalhost, async (req, res) => {
  try {
    const users = await all('SELECT * FROM users ORDER BY created_at DESC');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /internal/allow/:mac — allow a device (no admin session / CSRF required).
app.post('/internal/allow/:mac', requireLocalhost, async (req, res) => {
  const rawMac = req.params.mac;
  if (!MAC_RE.test(rawMac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }
  const mac = normaliseMac(rawMac);
  try {
    allow(mac);
    await run("UPDATE users SET status = 'active' WHERE mac = ?", [mac]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /internal/block/:mac — block a device (no admin session / CSRF required).
app.post('/internal/block/:mac', requireLocalhost, async (req, res) => {
  const rawMac = req.params.mac;
  if (!MAC_RE.test(rawMac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }
  const mac = normaliseMac(rawMac);
  try {
    const user = await get('SELECT ip FROM users WHERE mac = ?', [mac]);
    if (user && user.ip) block(user.ip, mac);
    await run("UPDATE users SET status = 'blocked', time_left = 0 WHERE mac = ?", [mac]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /internal/restart-portal — called by the watchdog (Node or Rust) to
// restart the DNS captive portal when a resolver failure is detected.
app.post('/internal/restart-portal', requireLocalhost, async (req, res) => {
  const reason  = (req.body && typeof req.body.reason === 'string')
    ? req.body.reason : 'unknown';
  const failures = (req.body && typeof req.body.consecutive_failures === 'number')
    ? req.body.consecutive_failures : 0;

  console.log(
    `[server] /internal/restart-portal — reason: ${reason}, consecutive_failures: ${failures}`
  );

  if (DNS_SERVER_MODE === 'child') {
    try {
      await restartDnsChildProcess();
      console.log('[server] dns-server child process restarted successfully');
      return res.json({ ok: true, restarted: true, reason, ts: Date.now() });
    } catch (err) {
      console.error('[server] dns-server restart failed:', err.message);
      return res.status(500).json({ error: 'restart failed', message: err.message });
    }
  }

  // External mode: the DNS process is managed by start.ps1 or another supervisor.
  // Log the request but do not attempt a restart — return ok=false so the caller
  // knows nothing was done.
  console.warn(
    '[server] /internal/restart-portal — DNS_SERVER_MODE is not "child"; ' +
    'restart skipped. Set DNS_SERVER_MODE=child to enable in-process management.'
  );
  res.json({ ok: true, restarted: false, reason, ts: Date.now() });
});

// ──────────────────────────────────────────────
// WebSocket — live push to admin dashboard
// ──────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

/** Broadcast a JSON message to all authenticated admin WebSocket clients. */
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws.isAuthed) ws.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  // Mark socket as unauthenticated by default so broadcast() skips it
  // until session validation completes successfully.
  ws.isAuthed = false;

  // Register error handler unconditionally so all connections are covered.
  ws.on('error', (err) => console.error('[ws] error:', err.message));

  // Authenticate: only allow admin sessions to maintain a WebSocket connection
  sessionMiddleware(req, {}, (err) => {
    if (err || !req.session || !req.session.adminId) {
      ws.close(1008, 'Unauthorized');
    } else {
      ws.isAuthed = true;
    }
  });
});

// Push live overview stats every 5 seconds to connected admin clients
async function broadcastStats() {
  if (wss.clients.size === 0) return;
  try {
    const stats = await getStats();
    broadcast('stats', { stats });
  } catch (_) { /* non-fatal */ }
}

setInterval(broadcastStats, 5_000);

module.exports = { app, broadcast };

// ──────────────────────────────────────────────
// Startup
// ──────────────────────────────────────────────
initDB()
  .then(() => {
    // Apply network tuning (idempotent; safe on every start)
    applyTuning();

    // DNS child process management + watchdog wiring.
    if (DNS_SERVER_MODE === 'child') {
      // Spawn dns-server.js as a managed child so the watchdog can restart it.
      _dnsChildProc = spawnDnsServer();
      watchdog.registerDnsServer({ restart: restartDnsChildProcess });
      watchdog.start();
      console.log('[server] DNS server running as managed child process (DNS_SERVER_MODE=child)');
    } else {
      // External mode: dns-server.js is started by start.ps1 or another supervisor.
      // The Node watchdog cannot restart an external process, so skip starting it.
      console.warn(
        '[server] DNS_SERVER_MODE is not "child" — watchdog DNS restart disabled. ' +
        'Set DNS_SERVER_MODE=child to enable managed restart.'
      );
    }

    httpServer.listen(PORT, () => {
      console.log(`🔥 WiFi Zone OS V3 running at http://localhost:${PORT}`);
      console.log(`📡 WebSocket live feed at  ws://localhost:${PORT}/ws`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
