'use strict';

const express = require('express');
const http = require('http');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { WebSocketServer, WebSocket } = require('ws');
const si = require('systeminformation');

const { db, run, get, all } = require('./db');
const { confirmPayment, createPayment } = require('./payment');
const { generateVoucher } = require('./voucher');
const { generateQR } = require('./qr');
const { getStats } = require('./analytics');
const { generateReceipt } = require('./receipt');
const { block, allow } = require('./firewall');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// ──────────────────────────────────────────────
// DB initialisation (idempotent)
// ──────────────────────────────────────────────
async function initDB() {
  await run(`
    CREATE TABLE IF NOT EXISTS admin (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      first_login INTEGER NOT NULL DEFAULT 1
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      mac       TEXT NOT NULL UNIQUE,
      ip        TEXT,
      time_left INTEGER NOT NULL DEFAULT 0,
      status    TEXT NOT NULL DEFAULT 'blocked',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ref        TEXT NOT NULL UNIQUE,
      mac        TEXT NOT NULL,
      amount     REAL NOT NULL,
      time_grant INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE,
      time_grant INTEGER NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS receipts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ref        TEXT NOT NULL,
      mac        TEXT NOT NULL,
      amount     REAL NOT NULL,
      time_grant INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default admin with a random temporary password
  const admin = await get('SELECT id FROM admin WHERE username = ?', ['admin']);
  if (!admin) {
    const tempPassword = require('crypto').randomBytes(12).toString('hex');
    const hash = await bcrypt.hash(tempPassword, 10);
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

// ──────────────────────────────────────────────
// Routes – Authentication
// ──────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { user, pass } = req.body;
  if (!user || !pass) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const row = await get('SELECT * FROM admin WHERE username = ?', [user]);
    if (!row) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(pass, row.password);
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
    const hash = await bcrypt.hash(pass, 10);
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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Routes – Payments
// ──────────────────────────────────────────────
app.post('/pay', async (req, res) => {
  const { amount, mac: rawMac } = req.body;
  const pricing = require('../config/pricing.json');
  const tier = pricing.rates.find((r) => r.price === Number(amount));

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
    // Atomic status transition: only proceed if we actually changed the row
    const result = await run(
      "UPDATE payments SET status = 'confirmed' WHERE ref = ? AND status = 'pending'",
      [ref]
    );
    if (result.changes === 0) {
      // Either not found or already processed — check which
      const existing = await get('SELECT status FROM payments WHERE ref = ?', [ref]);
      if (!existing) return res.status(404).json({ error: 'Payment not found' });
      return res.status(400).json({ error: 'Payment already processed' });
    }

    const payment = await get('SELECT * FROM payments WHERE ref = ?', [ref]);
    await confirmPayment(payment.mac, payment.time_grant);

    const receipt = generateReceipt({
      mac: payment.mac,
      time: payment.time_grant,
      amount: payment.amount,
      ref: payment.ref,
    });
    await run(
      'INSERT INTO receipts (ref, mac, amount, time_grant) VALUES (?,?,?,?)',
      [payment.ref, payment.mac, payment.amount, payment.time_grant]
    );

    allow(payment.mac);
    res.json({ success: true, receipt });
  } catch (err) {
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
    // Fetch the voucher first to get its id and time_grant
    const voucher = await get('SELECT * FROM vouchers WHERE code = ? AND used = 0', [code]);
    if (!voucher) return res.status(404).json({ error: 'Invalid or already used voucher' });

    // Atomic mark-as-used: only grant time if this UPDATE affects exactly 1 row
    const result = await run(
      'UPDATE vouchers SET used = 1 WHERE id = ? AND used = 0',
      [voucher.id]
    );
    if (result.changes === 0) {
      return res.status(409).json({ error: 'Voucher already redeemed' });
    }

    await run('INSERT OR IGNORE INTO users (mac) VALUES (?)', [mac]);
    await run(
      "UPDATE users SET status = 'active', time_left = time_left + ? WHERE mac = ?",
      [voucher.time_grant, mac]
    );
    allow(mac);
    res.json({ success: true, time_grant: voucher.time_grant });
  } catch (err) {
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
app.get('/qr', async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const url = `http://${host}/`;
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
// WebSocket — live push to admin dashboard
// ──────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

/** Broadcast a JSON message to all connected admin WebSocket clients. */
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.on('error', (err) => console.error('[ws] error:', err.message));
});

// Push live overview stats every 5 seconds to connected admin clients
async function broadcastStats() {
  if (wss.clients.size === 0) return;
  try {
    const stats = await getStats();
    const users = await all('SELECT * FROM users ORDER BY created_at DESC');
    broadcast('stats', { stats, users });
  } catch (_) { /* non-fatal */ }
}

setInterval(broadcastStats, 5_000);

module.exports = { app, broadcast };

// ──────────────────────────────────────────────
// Startup
// ──────────────────────────────────────────────
initDB()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`🔥 WiFi Zone OS V3 running at http://localhost:${PORT}`);
      console.log(`📡 WebSocket live feed at  ws://localhost:${PORT}/ws`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
