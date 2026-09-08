'use strict';

const crypto = require('crypto');
const config = require('../config');
const auth = require('../lib/auth');
const { clientIp } = require('../lib/geo');
const { saltedHash, now, randomToken, timingSafeEqual } = require('../lib/util');

// --- request context ---------------------------------------------------------
function context(req, res, nextFn) {
  req.clientIp = clientIp(req);
  req.ipHash = saltedHash(req.clientIp);
  res.locals.config = config;
  res.locals.brand = config.brand;
  res.locals.baseUrl = config.baseUrl;
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  res.locals.flash = null;
  nextFn();
}

// --- session ----------------------------------------------------------------
function session(req, res, nextFn) {
  const sid = req.cookies?.[config.session.cookie];
  const row = sid ? auth.readSession(sid) : null;
  if (row) {
    req.session = { id: row.sid };
    req.user = row;
    delete req.user.password_hash;
    res.locals.user = req.user;
  } else {
    req.session = null;
    req.user = null;
    res.locals.user = null;
    if (sid) res.clearCookie(config.session.cookie);
  }
  nextFn();
}

function loginUser(req, res, userId) {
  const sid = auth.createSession(userId, req);
  res.cookie(config.session.cookie, sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: config.session.ttlDays * 86400000,
    path: '/',
  });
  return sid;
}

function logoutUser(req, res) {
  if (req.session?.id) auth.destroySession(req.session.id);
  res.clearCookie(config.session.cookie);
}

// --- CSRF (double-submit cookie) --------------------------------------------
const CSRF_COOKIE = 'lv_csrf';

function csrf(req, res, nextFn) {
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token || token.length < 20) {
    token = randomToken(24);
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: 86400000,
    });
  }
  req.csrfToken = token;
  res.locals.csrfToken = token;

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    // These authenticate with their own unguessable credential instead:
    //   /api/v1/  - bearer API key
    //   /webhooks/ - Telegram's shared secret header
    //   /gw/       - the HMAC step token / visit key, which is bound to one visit
    //                and cannot be obtained cross-site. That is a strictly stronger
    //                anti-forgery guarantee than a double-submit cookie.
    //   /promo-view - an anonymous viewability counter carrying no user data
    if (req.path.startsWith('/api/v1/') || req.path.startsWith('/webhooks/')
        || req.path.startsWith('/gw/') || req.path === '/promo-view') {
      return nextFn();
    }
    const sent = req.body?._csrf || req.get('x-csrf-token');
    if (!sent || !timingSafeEqual(sent, token)) {
      if (req.accepts('json') && !req.accepts('html')) {
        return res.status(403).json({ error: 'csrf_failed' });
      }
      return res.status(403).render('error', {
        title: 'Security check failed',
        code: 403,
        message: 'Your session token expired or did not match. Reload the page and try again.',
      });
    }
  }
  nextFn();
}

// --- rate limiting (in-memory sliding window) --------------------------------
const buckets = new Map();

setInterval(() => {
  const cutoff = now() - 3600000;
  for (const [key, hits] of buckets) {
    const kept = hits.filter((t) => t > cutoff);
    if (kept.length) buckets.set(key, kept); else buckets.delete(key);
  }
}, 120000).unref?.();

/**
 * @param {object} o
 * @param {number} o.max     requests allowed
 * @param {number} o.windowMs
 * @param {string} o.key     bucket namespace
 * @param {(req)=>string} [o.by] identity function, defaults to hashed IP
 */
function rateLimit({ max = 60, windowMs = 60000, key = 'default', by = null } = {}) {
  return function limiter(req, res, nextFn) {
    const id = `${key}:${by ? by(req) : req.ipHash}`;
    const cutoff = now() - windowMs;
    const hits = (buckets.get(id) || []).filter((t) => t > cutoff);
    if (hits.length >= max) {
      const retry = Math.ceil((hits[0] + windowMs - now()) / 1000);
      res.set('Retry-After', String(Math.max(1, retry)));
      if (req.accepts('html') && !req.path.startsWith('/api/')) {
        return res.status(429).render('error', {
          title: 'Slow down',
          code: 429,
          message: `Too many requests. Try again in ${Math.max(1, retry)} seconds.`,
        });
      }
      return res.status(429).json({ error: 'rate_limited', retry_after: Math.max(1, retry) });
    }
    hits.push(now());
    buckets.set(id, hits);
    nextFn();
  };
}

// --- guards ------------------------------------------------------------------
function requireUser(req, res, nextFn) {
  if (!req.user) {
    const back = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${back}`);
  }
  if (req.user.status === 'banned') {
    return res.status(403).render('error', {
      title: 'Account suspended',
      code: 403,
      message: 'This account has been suspended. Contact support if you believe this is a mistake.',
    });
  }
  nextFn();
}

function requireAdmin(req, res, nextFn) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role !== 'admin') {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such page.' });
  }
  nextFn();
}

function requireApiKey(req, res, nextFn) {
  const header = req.get('authorization') || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.get('x-api-key') || req.query.api_key || '');
  const user = auth.userByApiKey(String(key).trim());
  if (!user) return res.status(401).json({ error: 'invalid_api_key' });
  req.apiUser = user;
  nextFn();
}

// --- security headers --------------------------------------------------------
function securityHeaders(req, res, nextFn) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  if (config.isProd) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  nextFn();
}

/** Flash messages via a short-lived cookie so redirects can carry a notice. */
function flash(req, res, nextFn) {
  const raw = req.cookies?.lv_flash;
  if (raw) {
    try { res.locals.flash = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { /* ignore */ }
    res.clearCookie('lv_flash');
  }
  res.flash = (type, message) => {
    res.cookie('lv_flash', Buffer.from(JSON.stringify({ type, message })).toString('base64url'), {
      httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 20000, path: '/',
    });
  };
  nextFn();
}

module.exports = {
  context, session, loginUser, logoutUser, csrf, rateLimit,
  requireUser, requireAdmin, requireApiKey, securityHeaders, flash,
};
