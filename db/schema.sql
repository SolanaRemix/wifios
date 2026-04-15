-- WiFi Zone OS V3 — Database Schema
-- Run via: sqlite3 db/wifi.db < db/schema.sql

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Admin accounts
CREATE TABLE IF NOT EXISTS admin (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE,
  password    TEXT    NOT NULL,          -- bcrypt hash
  first_login INTEGER NOT NULL DEFAULT 1  -- 1 = force password change
);

-- Connected devices / users
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mac        TEXT    NOT NULL UNIQUE,    -- lowercase colon-separated
  ip         TEXT,                        -- last seen IP
  time_left  INTEGER NOT NULL DEFAULT 0, -- seconds remaining
  status     TEXT    NOT NULL DEFAULT 'blocked', -- active | blocked | expired
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Payment records
CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref        TEXT    NOT NULL UNIQUE,    -- PAY-<timestamp>
  mac        TEXT    NOT NULL,
  amount     REAL    NOT NULL,           -- ₱ amount
  time_grant INTEGER NOT NULL,           -- seconds of access granted
  status     TEXT    NOT NULL DEFAULT 'pending', -- pending | confirmed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Voucher codes
CREATE TABLE IF NOT EXISTS vouchers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,    -- WIFI-XXXXXX
  time_grant INTEGER NOT NULL,           -- seconds of access
  used       INTEGER NOT NULL DEFAULT 0, -- 0 = available, 1 = redeemed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Receipt log
CREATE TABLE IF NOT EXISTS receipts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref        TEXT    NOT NULL,
  mac        TEXT    NOT NULL,
  amount     REAL    NOT NULL,
  time_grant INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_users_mac        ON users (mac);
CREATE INDEX IF NOT EXISTS idx_users_status     ON users (status);
CREATE INDEX IF NOT EXISTS idx_payments_ref     ON payments (ref);
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments (status);
CREATE INDEX IF NOT EXISTS idx_vouchers_code    ON vouchers (code);
