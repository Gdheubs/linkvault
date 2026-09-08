'use strict';

const express = require('express');
const { q } = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const { loginUser, logoutUser, rateLimit } = require('../middleware');
const { now } = require('../lib/util');

const router = express.Router();

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');

// --- register ---------------------------------------------------------------
router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/register', {
    title: `Create your publisher account · ${config.brand.name}`,
    values: { ref: String(req.query.ref || '') },
    error: null,
    passwordRules: auth.PASSWORD_RULES,
  });
});

router.post('/register', rateLimit({ max: 8, windowMs: 600000, key: 'register' }), (req, res) => {
  const { email = '', password = '', name = '', ref = '', terms = '' } = req.body || {};
  const values = { email: String(email).trim(), name: String(name).trim(), ref: String(ref).trim() };

  const fail = (error) => res.status(400).render('auth/register', {
    title: `Create your publisher account · ${config.brand.name}`,
    values, error, passwordRules: auth.PASSWORD_RULES,
  });

  const emailErr = auth.emailProblem(values.email);
  if (emailErr) return fail(emailErr);
  const pwErr = auth.passwordProblem(password);
  if (pwErr) return fail(pwErr);
  if (!terms) return fail('You must accept the Terms of Service and Privacy Policy.');
  if (auth.findByEmail(values.email)) return fail('An account with that email already exists.');

  let referredBy = null;
  if (values.ref) {
    const referrer = q.get('SELECT id FROM users WHERE ref_code = ?', values.ref.toUpperCase());
    if (referrer) referredBy = referrer.id;
  }

  const user = auth.createUser({
    email: values.email,
    password,
    name: values.name || values.email.split('@')[0],
    referredBy,
  });

  q.run(
    'INSERT INTO audit_log (actor_id, action, meta, ip_hash, created_at) VALUES (?,?,?,?,?)',
    user.id, 'user.register', JSON.stringify({ referredBy }), req.ipHash, now(),
  );

  loginUser(req, res, user.id);
  res.flash('success', 'Welcome aboard. Create your first monetized link below.');
  res.redirect('/dashboard');
});

// --- login ------------------------------------------------------------------
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/login', {
    title: `Sign in · ${config.brand.name}`,
    error: null,
    values: { email: '' },
    next: safeNext(req.query.next),
  });
});

router.post('/login', rateLimit({ max: 12, windowMs: 600000, key: 'login' }), (req, res) => {
  const { email = '', password = '', next = '' } = req.body || {};
  const values = { email: String(email).trim() };
  const target = safeNext(next);

  const fail = () => res.status(401).render('auth/login', {
    title: `Sign in · ${config.brand.name}`,
    error: 'Email or password is incorrect.',
    values,
    next: target,
  });

  const user = auth.findByEmail(values.email);
  if (!user) return fail();
  if (!auth.verifyPassword(password, user.password_hash)) {
    q.run(
      'INSERT INTO audit_log (actor_id, action, meta, ip_hash, created_at) VALUES (?,?,?,?,?)',
      user.id, 'user.login_failed', '{}', req.ipHash, now(),
    );
    return fail();
  }
  if (user.status === 'banned') {
    return res.status(403).render('auth/login', {
      title: `Sign in · ${config.brand.name}`,
      error: 'This account has been suspended. Contact support.',
      values,
      next: target,
    });
  }

  loginUser(req, res, user.id);
  res.redirect(user.role === 'admin' && target === '/dashboard' ? '/admin' : target);
});

// --- logout -----------------------------------------------------------------
router.post('/logout', (req, res) => {
  logoutUser(req, res);
  res.redirect('/');
});

// --- password change (from settings) ----------------------------------------
router.post('/account/password', rateLimit({ max: 10, windowMs: 600000, key: 'pwchange' }), (req, res) => {
  if (!req.user) return res.redirect('/login');
  const { current = '', next: newPw = '' } = req.body || {};
  const row = q.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);

  if (!auth.verifyPassword(current, row.password_hash)) {
    res.flash('error', 'Current password is incorrect.');
    return res.redirect('/dashboard/settings');
  }
  const pwErr = auth.passwordProblem(newPw);
  if (pwErr) {
    res.flash('error', pwErr);
    return res.redirect('/dashboard/settings');
  }

  q.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(newPw), req.user.id);
  // Drop every other session so a stolen cookie stops working.
  q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user.id, req.session.id);
  q.run(
    'INSERT INTO audit_log (actor_id, action, meta, ip_hash, created_at) VALUES (?,?,?,?,?)',
    req.user.id, 'user.password_changed', '{}', req.ipHash, now(),
  );
  res.flash('success', 'Password updated. Other sessions were signed out.');
  res.redirect('/dashboard/settings');
});

module.exports = router;
