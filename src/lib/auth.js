'use strict';

const crypto = require('crypto');
const { q } = require('../db');
const config = require('../config');
const { randomToken, randomCode, saltedHash, now, timingSafeEqual } = require('./util');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const key = crypto.scryptSync(password, salt, hex.length / 2, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(key, Buffer.from(hex, 'hex'));
  } catch {
    return false;
  }
}

function uniqueRefCode() {
  for (let i = 0; i < 30; i++) {
    const code = randomCode(7);
    if (!q.get('SELECT 1 FROM users WHERE ref_code = ?', code)) return code;
  }
  throw new Error('could not allocate referral code');
}

function newApiKey() {
  return `lv_${randomToken(24)}`;
}

function createUser({ email, password, name = '', role = 'publisher', referredBy = null }) {
  const ts = now();
  const res = q.run(
    `INSERT INTO users (email, password_hash, name, role, ref_code, referred_by, api_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    String(email).toLowerCase().trim(),
    hashPassword(password),
    name,
    role,
    uniqueRefCode(),
    referredBy,
    newApiKey(),
    ts,
  );
  return q.get('SELECT * FROM users WHERE id = ?', Number(res.lastInsertRowid));
}

function findByEmail(email) {
  return q.get('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase().trim());
}

function createSession(userId, req) {
  const id = randomToken(32);
  const ttl = config.session.ttlDays * 86400000;
  q.run(
    'INSERT INTO sessions (id, user_id, ip_hash, ua, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, userId, saltedHash(req.clientIp || ''), String(req.get('user-agent') || '').slice(0, 300),
    now(), now() + ttl,
  );
  q.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), userId);
  return id;
}

function readSession(sid) {
  if (!sid) return null;
  const row = q.get(
    `SELECT s.id AS sid, s.expires_at, u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
    sid, now(),
  );
  return row || null;
}

function destroySession(sid) {
  if (sid) q.run('DELETE FROM sessions WHERE id = ?', sid);
}

function sweepSessions() {
  q.run('DELETE FROM sessions WHERE expires_at < ?', now());
}

function userByApiKey(key) {
  if (!key || !/^lv_[A-Za-z0-9_-]{10,}$/.test(key)) return null;
  return q.get("SELECT * FROM users WHERE api_key = ? AND status = 'active'", key) || null;
}

function rotateApiKey(userId) {
  const key = newApiKey();
  q.run('UPDATE users SET api_key = ? WHERE id = ?', key, userId);
  return key;
}

const PASSWORD_RULES = 'At least 8 characters, including a letter and a number.';
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return 'Password needs at least one letter and one number.';
  if (s.length > 200) return 'Password is too long.';
  return null;
}

function emailProblem(email) {
  const s = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(s)) return 'Enter a valid email address.';
  if (s.length > 190) return 'Email is too long.';
  return null;
}

module.exports = {
  hashPassword, verifyPassword, createUser, findByEmail,
  createSession, readSession, destroySession, sweepSessions,
  userByApiKey, rotateApiKey, uniqueRefCode, newApiKey,
  passwordProblem, emailProblem, PASSWORD_RULES, timingSafeEqual,
};
