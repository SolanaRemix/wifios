#!/usr/bin/env node
'use strict';

/**
 * Standalone DB initialisation script.
 * Applies the schema SQL and seeds the default admin row before the server
 * is started for the first time. Does NOT import server.js — schema is applied
 * directly from db/schema.sql to avoid circular dependencies.
 *
 * Usage:  node scripts/init-db.js
 *         npm run init-db
 */

const path = require('path');
// Resolve the project root from this script's location
process.chdir(path.join(__dirname, '..'));

const { db, run, get } = require('../backend/db');
const { hashPassword } = require('../backend/auth');
const crypto = require('crypto');
const fs = require('fs');

async function init() {
  console.log('🗄️  Running database initialisation…');

  // Apply schema SQL (idempotent CREATE IF NOT EXISTS)
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    // Split on semicolons to run each statement individually
    for (const stmt of schema.split(';').map((s) => s.trim()).filter(Boolean)) {
      await run(stmt);
    }
    console.log('✅ Schema applied');
  }

  // Seed default admin if not present
  const admin = await get('SELECT id FROM admin WHERE username = ?', ['admin']);
  if (!admin) {
    const tempPassword = crypto.randomBytes(12).toString('hex');
    const hash = await hashPassword(tempPassword);
    await run('INSERT INTO admin (username, password, first_login) VALUES (?,?,1)', ['admin', hash]);
    // Intentionally print the one-time temp password to the terminal so the operator
    // can log in and change it. It is never written to disk or any log file.
    console.log('═══════════════════════════════════════════════════');
    console.log('  Default admin created.');
    console.log('  Username : admin');
    console.log(`  Password : ${tempPassword}`);
    console.log('  ⚠️  Change this password immediately after login!');
    console.log('═══════════════════════════════════════════════════');
  } else {
    console.log('ℹ️  Admin already exists — skipping seed');
  }

  db.close();
  console.log('✅ Database initialisation complete');
}

init().catch((err) => {
  console.error('❌ init-db failed:', err.message);
  process.exit(1);
});
