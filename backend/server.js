'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const { db, run, get, all } = require('./db');
const { confirmPayment, createPayment } = require('./payment');
const { generateVoucher } = require('./voucher');
const { generateQR } = require('./qr');
const { getStats } = require('./analytics');const { generateReceipt } = require('./receipt');
const { block, allow } = require('./firewall');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/admin', express.static(path.join(__dirname, '..', 'admin-panel')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || uuidv4(),
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

  // Seed default admin
  const admin = await get('SELECT id FROM admin WHERE username = ?', ['admin']);
  if (!admin) {
    const hash = await bcrypt.hash('admin123', 10);
    await run('INSERT INTO admin (username, password, first_login) VALUES (?,?,1)', ['admin', hash]);
    console.log('Default admin created. Please change the password after first login.');
  }
}

// ──────────────────────────────────────────────
// Auth helpers
// ──────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'Unauthorised' });
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

    if (row.first_login) {
      return res.json({ redirect: '/change-password.html' });
    }
    return res.json({ success: true, redirect: '/admin/dashboard.html' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/change-password', requireAdmin, async (req, res) => {
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

app.post('/block/:mac', requireAdmin, async (req, res) => {
  const { mac } = req.params;
  if (!/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }
  try {
    const user = await get('SELECT ip FROM users WHERE mac = ?', [mac]);
    if (user && user.ip) block(user.ip, mac);
    await run("UPDATE users SET status = 'blocked', time_left = 0 WHERE mac = ?", [mac]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/allow/:mac', requireAdmin, async (req, res) => {
  const { mac } = req.params;
  if (!/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }
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
  const { amount, mac } = req.body;
  const pricing = require('../config/pricing.json');
  const tier = pricing.rates.find((r) => r.price === Number(amount));

  if (!tier) return res.status(400).json({ error: 'Invalid amount' });
  if (!mac || !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }

  try {
    const payment = createPayment(mac, amount, tier.time);
    await run(
      'INSERT OR IGNORE INTO users (mac) VALUES (?)',
      [mac]
    );
    await run(
      'INSERT INTO payments (ref, mac, amount, time_grant, status) VALUES (?,?,?,?,?)',
      [payment.ref, mac, amount, tier.time, 'pending']
    );
    res.json({ ref: payment.ref, message: 'Payment pending. Waiting for confirmation.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/confirm-payment', requireAdmin, async (req, res) => {
  const { ref } = req.body;
  if (!ref) return res.status(400).json({ error: 'Missing payment ref' });

  try {
    const payment = await get('SELECT * FROM payments WHERE ref = ?', [ref]);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.status !== 'pending') return res.status(400).json({ error: 'Payment already processed' });

    await confirmPayment(payment.mac, payment.time_grant);
    await run("UPDATE payments SET status = 'confirmed' WHERE ref = ?", [ref]);

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
app.post('/voucher/generate', requireAdmin, async (req, res) => {
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
  const { code, mac } = req.body;
  if (!code || !mac) return res.status(400).json({ error: 'Missing code or MAC' });
  if (!/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }

  try {
    const voucher = await get('SELECT * FROM vouchers WHERE code = ? AND used = 0', [code]);
    if (!voucher) return res.status(404).json({ error: 'Invalid or already used voucher' });

    await run('UPDATE vouchers SET used = 1 WHERE id = ?', [voucher.id]);
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
// Routes – Pricing
// ──────────────────────────────────────────────
app.get('/pricing', (req, res) => {
  res.json(require('../config/pricing.json'));
});

// ──────────────────────────────────────────────
// Startup
// ──────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🔥 WiFi Zone OS V3 running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });

module.exports = app;
