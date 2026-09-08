'use strict';

/**
 * Developer API (v1). Bearer-token auth with the publisher's API key.
 *
 *   GET    /api/v1/me
 *   GET    /api/v1/links            list + filter
 *   POST   /api/v1/links            create
 *   GET    /api/v1/links/:code      detail + stats
 *   PATCH  /api/v1/links/:code      update
 *   DELETE /api/v1/links/:code      delete
 *   GET    /api/v1/stats            summary + daily series
 *   GET    /api/v1/files            vault contents
 *   GET    /api/v1/shorten?url=     one-shot shortener (quick integrations)
 */

const express = require('express');
const config = require('../config');
const { q } = require('../db');
const stats = require('../lib/stats');
const revenue = require('../lib/revenue');
const { requireApiKey, rateLimit } = require('../middleware');
const { now, randomCode, isSafeUrl, fromMicros, clamp } = require('../lib/util');

const router = express.Router();

router.use(express.json({ limit: '32kb' }));
router.use(rateLimit({
  max: 300, windowMs: 60000, key: 'api',
  by: (req) => (req.get('authorization') || req.get('x-api-key') || req.ipHash).slice(-32),
}));
router.use(requireApiKey);

const shortUrl = (code) => `${config.baseUrl}/s/${code}`;

const publicLink = (l) => ({
  code: l.code,
  short_url: shortUrl(l.code),
  title: l.title,
  description: l.description,
  destination: l.destination,
  resource_id: l.resource_id,
  campaign_id: l.campaign_id,
  status: l.status,
  clicks: l.clicks,
  unique_clicks: l.unique_clicks,
  valid_visits: l.valid_visits,
  completed_visits: l.completed_visits,
  earnings_usd: Number(fromMicros(l.revenue_micros).toFixed(6)),
  expires_at: l.expires_at,
  created_at: l.created_at,
});

// ---------------------------------------------------------------------------
router.get('/me', (req, res) => {
  const u = req.apiUser;
  res.json({
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    balance_usd: Number(fromMicros(u.balance_micros).toFixed(6)),
    pending_usd: Number(fromMicros(u.pending_micros).toFixed(6)),
    paid_usd: Number(fromMicros(u.paid_micros).toFixed(6)),
    referral_code: u.ref_code,
    referral_url: `${config.baseUrl}/register?ref=${u.ref_code}`,
    effective_cpm_usd: Number(fromMicros(revenue.effectiveCpm(u.id, 30)).toFixed(4)),
    links: q.scalar('SELECT COUNT(*) FROM links WHERE user_id = ?', u.id) || 0,
  });
});

// ---------------------------------------------------------------------------
router.get('/links', (req, res) => {
  const limit = clamp(parseInt(req.query.limit, 10) || 50, 1, 200);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const status = ['active', 'paused', 'blocked'].includes(req.query.status) ? req.query.status : null;

  const where = status ? 'user_id = ? AND status = ?' : 'user_id = ?';
  const args = status ? [req.apiUser.id, status] : [req.apiUser.id];

  res.json({
    total: q.scalar(`SELECT COUNT(*) FROM links WHERE ${where}`, ...args) || 0,
    limit,
    offset,
    data: q.all(`SELECT * FROM links WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset)
      .map(publicLink),
  });
});

router.post('/links', (req, res) => {
  const b = req.body || {};
  const dest = String(b.destination || b.url || '').trim();
  const resourceId = b.resource_id ? parseInt(b.resource_id, 10) : null;

  if (!dest && !resourceId) return res.status(400).json({ error: 'missing_target', message: 'Provide `destination` or `resource_id`.' });
  if (dest && !isSafeUrl(dest)) return res.status(400).json({ error: 'invalid_destination', message: 'Destination must be a public http(s) URL.' });
  if (resourceId && !q.get('SELECT id FROM resources WHERE id = ? AND user_id = ?', resourceId, req.apiUser.id)) {
    return res.status(404).json({ error: 'resource_not_found' });
  }

  let code = String(b.alias || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (code) {
    if (code.length < 3 || code.length > 32) return res.status(400).json({ error: 'invalid_alias', message: 'Alias must be 3-32 characters.' });
    if (q.get('SELECT 1 FROM links WHERE code = ?', code)) return res.status(409).json({ error: 'alias_taken' });
  } else {
    do { code = randomCode(7); } while (q.get('SELECT 1 FROM links WHERE code = ?', code));
  }

  let campaignId = null;
  if (b.campaign_id) {
    const c = q.get(
      "SELECT id FROM campaigns WHERE id = ? AND status='active' AND (owner_id = ? OR owner_id IS NULL)",
      parseInt(b.campaign_id, 10), req.apiUser.id,
    );
    campaignId = c ? c.id : null;
  }

  const expDays = parseInt(b.expires_days, 10);
  const maxClicks = parseInt(b.max_clicks, 10);

  q.run(
    `INSERT INTO links (code, user_id, destination, resource_id, campaign_id, title, description, expires_at, max_clicks, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    code, req.apiUser.id, dest, resourceId || null, campaignId,
    String(b.title || '').slice(0, 160), String(b.description || '').slice(0, 400),
    Number.isFinite(expDays) && expDays > 0 ? now() + expDays * 86400000 : null,
    Number.isFinite(maxClicks) && maxClicks > 0 ? maxClicks : null,
    now(),
  );

  res.status(201).json(publicLink(q.get('SELECT * FROM links WHERE code = ?', code)));
});

router.get('/links/:code', (req, res) => {
  const link = q.get('SELECT * FROM links WHERE code = ? AND user_id = ?', String(req.params.code), req.apiUser.id);
  if (!link) return res.status(404).json({ error: 'not_found' });

  const days = clamp(parseInt(req.query.days, 10) || 30, 1, 365);
  res.json({
    ...publicLink(link),
    stats: {
      days,
      countries: q.all(
        `SELECT country, SUM(clicks) AS clicks, SUM(completed_visits) AS completed
         FROM daily_stats WHERE user_id=? AND link_id=? AND day>=? AND country!='*'
         GROUP BY country ORDER BY clicks DESC LIMIT 20`,
        req.apiUser.id, link.id, stats.sinceDay(days),
      ),
      devices: q.all(
        `SELECT device, SUM(clicks) AS clicks FROM daily_stats
         WHERE user_id=? AND link_id=? AND day>=? AND device!='*' GROUP BY device`,
        req.apiUser.id, link.id, stats.sinceDay(days),
      ),
    },
  });
});

router.patch('/links/:code', (req, res) => {
  const link = q.get('SELECT * FROM links WHERE code = ? AND user_id = ?', String(req.params.code), req.apiUser.id);
  if (!link) return res.status(404).json({ error: 'not_found' });
  if (link.status === 'blocked') return res.status(403).json({ error: 'link_blocked' });

  const b = req.body || {};
  if (b.destination !== undefined && b.destination && !isSafeUrl(b.destination)) {
    return res.status(400).json({ error: 'invalid_destination' });
  }
  q.run(
    `UPDATE links SET title = COALESCE(?, title), description = COALESCE(?, description),
                      destination = COALESCE(?, destination), status = COALESCE(?, status)
     WHERE id = ?`,
    b.title !== undefined ? String(b.title).slice(0, 160) : null,
    b.description !== undefined ? String(b.description).slice(0, 400) : null,
    b.destination !== undefined ? String(b.destination) : null,
    ['active', 'paused'].includes(b.status) ? b.status : null,
    link.id,
  );
  res.json(publicLink(q.get('SELECT * FROM links WHERE id = ?', link.id)));
});

router.delete('/links/:code', (req, res) => {
  const link = q.get('SELECT id FROM links WHERE code = ? AND user_id = ?', String(req.params.code), req.apiUser.id);
  if (!link) return res.status(404).json({ error: 'not_found' });
  q.run('DELETE FROM links WHERE id = ?', link.id);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
router.get('/stats', (req, res) => {
  const days = clamp(parseInt(req.query.days, 10) || 30, 1, 365);
  const s = stats.summary(req.apiUser.id, days);
  res.json({
    days,
    today: {
      clicks: s.today.clicks || 0,
      unique_clicks: s.today.unique_clicks || 0,
      valid_visits: s.today.valid_visits || 0,
      completed_visits: s.today.completed_visits || 0,
      earnings_usd: Number(fromMicros(s.today.publisher_micros || 0).toFixed(6)),
    },
    range: {
      clicks: s.range.clicks || 0,
      unique_clicks: s.range.unique_clicks || 0,
      valid_visits: s.range.valid_visits || 0,
      completed_visits: s.range.completed_visits || 0,
      earnings_usd: Number(fromMicros(s.range.publisher_micros || 0).toFixed(6)),
    },
    effective_cpm_usd: Number(fromMicros(s.ecpm).toFixed(4)),
    completion_rate: Number(s.completionRate.toFixed(4)),
    series: stats.series(req.apiUser.id, days).map((d) => ({
      day: d.day,
      clicks: d.clicks,
      unique_clicks: d.unique_clicks,
      completed_visits: d.completed_visits,
      earnings_usd: Number(fromMicros(d.publisher_micros).toFixed(6)),
    })),
    countries: stats.breakdown(req.apiUser.id, 'country', days, 20),
    devices: stats.breakdown(req.apiUser.id, 'device', days, 5),
  });
});

router.get('/files', (req, res) => {
  res.json({
    data: q.all(
      `SELECT id, kind, file_name, mime, size_bytes, status, downloads, created_at
       FROM resources WHERE user_id = ? AND status != 'removed' ORDER BY created_at DESC LIMIT 200`,
      req.apiUser.id,
    ),
  });
});

/** One-shot shortener, for bookmarklets and simple integrations. */
router.get('/shorten', (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!isSafeUrl(url)) return res.status(400).json({ error: 'invalid_url' });

  const existing = q.get(
    'SELECT * FROM links WHERE user_id = ? AND destination = ? ORDER BY created_at DESC LIMIT 1',
    req.apiUser.id, url,
  );
  if (existing && !req.query.force) return res.json({ short_url: shortUrl(existing.code), code: existing.code, reused: true });

  let code;
  do { code = randomCode(7); } while (q.get('SELECT 1 FROM links WHERE code = ?', code));
  q.run(
    'INSERT INTO links (code, user_id, destination, title, created_at) VALUES (?,?,?,?,?)',
    code, req.apiUser.id, url, String(req.query.title || '').slice(0, 160), now(),
  );
  res.json({ short_url: shortUrl(code), code, reused: false });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, nextFn) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'server_error' });
});

module.exports = router;
