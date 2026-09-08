'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

fs.mkdirSync(path.dirname(config.db.file), { recursive: true });

const db = new DatabaseSync(config.db.file);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// --- additive migrations -----------------------------------------------------
// schema.sql only creates tables that do not exist, so columns added to an
// existing table need to be applied separately. Adding a column is idempotent
// here because we check the table's actual shape first.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] migrated: ${table}.${column}`);
  }
}

// Campaigns became account-owned when the self-serve advertiser API landed.
// Rows created before that keep user_id NULL and stay admin-managed.
addColumn('promotions', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
// Prepaid advertiser balance, separate from publisher earnings.
addColumn('users', 'ad_credit_micros', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'ad_spend_micros', 'INTEGER NOT NULL DEFAULT 0');

// --- thin query helpers ------------------------------------------------------
// node:sqlite returns null-prototype objects; spread them so EJS/JSON behave.
const plain = (row) => (row ? { ...row } : row);

const q = {
  /** First matching row, or undefined. */
  get(sql, ...params) {
    return plain(db.prepare(sql).get(...params));
  },
  /** All matching rows. */
  all(sql, ...params) {
    return db.prepare(sql).all(...params).map(plain);
  },
  /** Run a statement; returns { changes, lastInsertRowid }. */
  run(sql, ...params) {
    return db.prepare(sql).run(...params);
  },
  /** Single scalar from the first column of the first row. */
  scalar(sql, ...params) {
    const row = db.prepare(sql).get(...params);
    if (!row) return undefined;
    return Object.values(row)[0];
  },
  /** Wrap fn in a transaction. node:sqlite has no .transaction() helper. */
  tx(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  },
  exec(sql) { db.exec(sql); },
  raw: db,
};

// --- settings key/value store ------------------------------------------------
const settings = {
  get(key, fallback = null) {
    const v = q.scalar('SELECT value FROM settings WHERE key = ?', key);
    if (v === undefined) return fallback;
    try { return JSON.parse(v); } catch { return v; }
  },
  set(key, value) {
    q.run(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    );
  },
  all() {
    const out = {};
    for (const r of q.all('SELECT key, value FROM settings')) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  },
};

module.exports = { db, q, settings };
