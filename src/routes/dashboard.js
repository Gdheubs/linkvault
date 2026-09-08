'use strict';

const express = require('express');
const config = require('../config');
const { q } = require('../db');
const stats = require('../lib/stats');
const revenue = require('../lib/revenue');
const campaigns = require('../lib/campaigns');
const telegram = require('../lib/telegram');
const promos = require('../lib/promos');
const auth = require('../lib/auth');
const { requireUser, rateLimit } = require('../middleware');
const {
  now, randomCode, isSafeUrl, usd, parseJson, clamp, hostOf, lastDays,
} = require('../lib/util');

const router = express.Router();
router.use(requireUser);

// Every dashboard view needs the nav + live balance.
router.use((req, res, nextFn) => {
  res.locals.nav = 'dashboard';
  res.locals.me = q.get(
    `SELECT id, name, email, role, status, balance_micros, pending_micros, paid_micros,
            ref_code, ref_earn_micros, api_key, tg_chat_id, payout_method, payout_address,
            fraud_score, ad_credit_micros, ad_spend_micros, created_at
     FROM users WHERE id = ?`,
    req.user.id,
  );
  nextFn();
});

const range = (req, def = 30) => clamp(parseInt(req.query.days, 10) || def, 1, 365);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const days = range(req);
  const userId = req.user.id;

  res.render('dashboard/overview', {
    title: `Dashboard · ${config.brand.name}`,
    tab: 'overview',
    days,
    summary: stats.summary(userId, days),
    series: stats.series(userId, days),
    countries: stats.breakdown(userId, 'country', days, 8),
    devices: stats.breakdown(userId, 'device', days, 5),
    topLinks: stats.topLinks(userId, days, 6),
    recent: stats.recentVisits(userId, 12),
    linkCount: q.scalar('SELECT COUNT(*) FROM links WHERE user_id = ?', userId) || 0,
    ecpm: revenue.effectiveCpm(userId, days),
    minPayout: config.revenue.minPayoutMicros,
    shares: revenue.shares(),
    holdHours: config.revenue.holdHours,
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
router.get('/links', (req, res) => {
  const userId = req.user.id;
  const search = String(req.query.q || '').trim();
  const status = ['active', 'paused', 'blocked'].includes(req.query.status) ? req.query.status : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 20;

  const filters = ['l.user_id = ?'];
  const args = [userId];
  if (search) {
    filters.push('(l.code LIKE ? OR l.title LIKE ? OR l.destination LIKE ?)');
    args.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) { filters.push('l.status = ?'); args.push(status); }
  const where = filters.join(' AND ');

  const total = q.scalar(`SELECT COUNT(*) FROM links l WHERE ${where}`, ...args) || 0;
  const links = q.all(
    `SELECT l.*, r.file_name, r.size_bytes, r.kind AS file_kind, c.name AS campaign_name
     FROM links l
     LEFT JOIN resources r ON r.id = l.resource_id
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     WHERE ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
    ...args, perPage, (page - 1) * perPage,
  );

  res.render('dashboard/links', {
    title: `My links · ${config.brand.name}`,
    tab: 'links',
    links,
    search,
    status,
    page,
    perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
    resources: q.all('SELECT id, file_name, kind, size_bytes FROM resources WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', userId),
    campaignOptions: q.all(
      "SELECT id, name FROM campaigns WHERE status = 'active' AND (owner_id = ? OR owner_id IS NULL) ORDER BY owner_id IS NULL, name",
      userId,
    ),
  });
});

router.post('/links', rateLimit({ max: 60, windowMs: 300000, key: 'linkcreate' }), (req, res) => {
  const userId = req.user.id;
  const {
    destination = '', title = '', description = '', alias = '',
    resource_id = '', campaign_id = '', expires_days = '', max_clicks = '', password = '',
  } = req.body || {};

  const dest = String(destination).trim();
  const resourceId = resource_id ? parseInt(resource_id, 10) : null;

  const bail = (msg) => { res.flash('error', msg); return res.redirect('/dashboard/links'); };

  if (!dest && !resourceId) return bail('Give the link a destination URL or attach a stored file.');
  if (dest && !isSafeUrl(dest)) return bail('That destination is not a valid public http(s) URL.');
  if (resourceId) {
    const owned = q.get('SELECT id FROM resources WHERE id = ? AND user_id = ?', resourceId, userId);
    if (!owned) return bail('That file is not in your vault.');
  }

  let code = String(alias).trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (code) {
    if (code.length < 3 || code.length > 32) return bail('Custom alias must be 3-32 characters.');
    if (RESERVED.has(code.toLowerCase())) return bail('That alias is reserved.');
    if (q.get('SELECT 1 FROM links WHERE code = ?', code)) return bail('That alias is already taken.');
  } else {
    do { code = randomCode(7); } while (q.get('SELECT 1 FROM links WHERE code = ?', code));
  }

  let campaignId = null;
  if (campaign_id) {
    const c = q.get(
      "SELECT id FROM campaigns WHERE id = ? AND status = 'active' AND (owner_id = ? OR owner_id IS NULL)",
      parseInt(campaign_id, 10), userId,
    );
    campaignId = c ? c.id : null;
  }

  const expDays = parseInt(expires_days, 10);
  const maxClicks = parseInt(max_clicks, 10);

  q.run(
    `INSERT INTO links (code, user_id, destination, resource_id, campaign_id, title, description,
                        password, expires_at, max_clicks, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    code, userId, dest, resourceId || null, campaignId,
    String(title).slice(0, 160), String(description).slice(0, 400),
    password ? String(password).slice(0, 64) : null,
    Number.isFinite(expDays) && expDays > 0 ? now() + expDays * 86400000 : null,
    Number.isFinite(maxClicks) && maxClicks > 0 ? maxClicks : null,
    now(),
  );

  res.flash('success', `Link created: ${config.baseUrl}/s/${code}`);
  res.redirect('/dashboard/links');
});

router.post('/links/:id/update', (req, res) => {
  const link = q.get('SELECT * FROM links WHERE id = ? AND user_id = ?', parseInt(req.params.id, 10), req.user.id);
  if (!link) { res.flash('error', 'Link not found.'); return res.redirect('/dashboard/links'); }
  if (link.status === 'blocked') { res.flash('error', 'This link is blocked by a moderator and cannot be edited.'); return res.redirect('/dashboard/links'); }

  const { title = '', description = '', destination = '', status = '' } = req.body || {};
  const dest = String(destination).trim();
  if (dest && !isSafeUrl(dest)) { res.flash('error', 'Invalid destination URL.'); return res.redirect('/dashboard/links'); }

  q.run(
    'UPDATE links SET title = ?, description = ?, destination = COALESCE(NULLIF(?, \'\'), destination), status = ? WHERE id = ?',
    String(title).slice(0, 160), String(description).slice(0, 400), dest,
    ['active', 'paused'].includes(status) ? status : link.status, link.id,
  );
  res.flash('success', 'Link updated.');
  res.redirect('/dashboard/links');
});

router.post('/links/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const link = q.get('SELECT id FROM links WHERE id = ? AND user_id = ?', id, req.user.id);
  if (link) q.run('DELETE FROM links WHERE id = ?', id);
  res.flash('success', 'Link deleted. Historical stats are kept for your earnings record.');
  res.redirect('/dashboard/links');
});

// ---------------------------------------------------------------------------
// Per-link analytics
// ---------------------------------------------------------------------------
router.get('/links/:id', (req, res) => {
  const link = q.get(
    `SELECT l.*, r.file_name, r.size_bytes, r.kind AS file_kind, c.name AS campaign_name
     FROM links l LEFT JOIN resources r ON r.id = l.resource_id
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.id = ? AND l.user_id = ?`,
    parseInt(req.params.id, 10), req.user.id,
  );
  if (!link) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such link.' });

  const days = range(req);
  const since = stats.sinceDay(days);
  const rows = q.all(
    `SELECT day, SUM(clicks) AS clicks, SUM(unique_clicks) AS unique_clicks,
            SUM(completed_visits) AS completed_visits, SUM(publisher_micros) AS publisher_micros
     FROM daily_stats WHERE user_id = ? AND link_id = ? AND day >= ? GROUP BY day ORDER BY day`,
    req.user.id, link.id, since,
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const linkSeries = lastDays(days).map((day) => {
    const r = byDay.get(day) || {};
    return {
      day, label: day.slice(5),
      clicks: r.clicks || 0, unique_clicks: r.unique_clicks || 0,
      completed_visits: r.completed_visits || 0, publisher_micros: r.publisher_micros || 0,
    };
  });

  res.render('dashboard/link-detail', {
    title: `${link.title || link.code} · ${config.brand.name}`,
    tab: 'links',
    link,
    days,
    series: linkSeries,
    countries: q.all(
      `SELECT country AS key, SUM(clicks) AS clicks, SUM(completed_visits) AS completed_visits,
              SUM(publisher_micros) AS publisher_micros
       FROM daily_stats WHERE user_id = ? AND link_id = ? AND day >= ? AND country != '*'
       GROUP BY country ORDER BY clicks DESC LIMIT 10`,
      req.user.id, link.id, since,
    ),
    devices: q.all(
      `SELECT device AS key, SUM(clicks) AS clicks, SUM(publisher_micros) AS publisher_micros
       FROM daily_stats WHERE user_id = ? AND link_id = ? AND day >= ? AND device != '*'
       GROUP BY device ORDER BY clicks DESC`,
      req.user.id, link.id, since,
    ),
    visits: q.all(
      `SELECT id, country, device, browser, os, referer, is_valid, is_completed, fraud_score,
              publisher_micros, created_at
       FROM visits WHERE link_id = ? ORDER BY created_at DESC LIMIT 40`,
      link.id,
    ),
    hostOf,
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
router.get('/analytics', (req, res) => {
  const days = range(req);
  const userId = req.user.id;
  res.render('dashboard/analytics', {
    title: `Analytics · ${config.brand.name}`,
    tab: 'analytics',
    days,
    summary: stats.summary(userId, days),
    series: stats.series(userId, days),
    countries: stats.breakdown(userId, 'country', days, 15),
    devices: stats.breakdown(userId, 'device', days, 5),
    browsers: stats.visitBreakdown(userId, 'browser', days, 8),
    oses: stats.visitBreakdown(userId, 'os', days, 8),
    referers: stats.visitBreakdown(userId, 'referer', days, 10),
    topLinks: stats.topLinks(userId, days, 15),
  });
});

// ---------------------------------------------------------------------------
// Earnings + withdrawals
// ---------------------------------------------------------------------------
router.get('/earnings', (req, res) => {
  const userId = req.user.id;
  const days = range(req);
  res.render('dashboard/earnings', {
    title: `Earnings · ${config.brand.name}`,
    tab: 'earnings',
    days,
    summary: stats.summary(userId, days),
    series: stats.series(userId, days),
    ledger: q.all('SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 60', userId),
    payouts: q.all('SELECT * FROM payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', userId),
    minPayout: config.revenue.minPayoutMicros,
    holdHours: config.revenue.holdHours,
    shares: revenue.shares(),
    ecpm: revenue.effectiveCpm(userId, days),
    rateCard: q.all('SELECT * FROM rate_cards WHERE active = 1 ORDER BY cpm_micros DESC LIMIT 25'),
  });
});

router.post('/withdraw', rateLimit({ max: 5, windowMs: 3600000, key: 'withdraw' }), (req, res) => {
  const userId = req.user.id;
  const me = q.get('SELECT balance_micros, payout_method, payout_address, fraud_score FROM users WHERE id = ?', userId);
  const { amount = '', method = '', address = '' } = req.body || {};

  const bail = (msg) => { res.flash('error', msg); return res.redirect('/dashboard/earnings'); };

  const payMethod = String(method || me.payout_method).trim();
  const payAddress = String(address || me.payout_address).trim();
  if (!payMethod || !payAddress) return bail('Add a payout method and address first.');

  const micros = Math.round(Number(amount) * 1_000_000);
  if (!Number.isFinite(micros) || micros <= 0) return bail('Enter a valid amount.');
  if (micros < config.revenue.minPayoutMicros) {
    return bail(`Minimum withdrawal is ${usd(config.revenue.minPayoutMicros)}.`);
  }
  if (micros > me.balance_micros) {
    return bail(`You can withdraw up to ${usd(me.balance_micros)} right now. Pending earnings release after ${config.revenue.holdHours}h.`);
  }
  if (q.get("SELECT 1 FROM payouts WHERE user_id = ? AND status = 'pending'", userId)) {
    return bail('You already have a withdrawal awaiting review.');
  }
  if (me.fraud_score >= 70) {
    return bail('Withdrawals are paused on this account pending a traffic-quality review. Contact support.');
  }

  q.tx(() => {
    q.run('UPDATE users SET balance_micros = balance_micros - ?, payout_method = ?, payout_address = ? WHERE id = ?',
      micros, payMethod, payAddress, userId);
    q.run('INSERT INTO payouts (user_id, amount_micros, method, address, created_at) VALUES (?,?,?,?,?)',
      userId, micros, payMethod, payAddress, now());
    revenue.ledger({ userId, kind: 'payout', amountMicros: -micros, refType: 'payout', note: `${payMethod} withdrawal requested` });
  });

  res.flash('success', `Withdrawal of ${usd(micros)} requested. Payouts are reviewed and processed on the next cycle.`);
  res.redirect('/dashboard/earnings');
});

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------
router.get('/referrals', (req, res) => {
  const userId = req.user.id;
  const me = res.locals.me;
  res.render('dashboard/referrals', {
    title: `Referrals · ${config.brand.name}`,
    tab: 'referrals',
    refUrl: `${config.baseUrl}/register?ref=${me.ref_code}`,
    referred: q.all(
      `SELECT u.id, u.name, u.email, u.created_at, u.status,
              (SELECT COALESCE(SUM(amount_micros),0) FROM ledger
               WHERE user_id = ? AND kind = 'referral' AND ref_type LIKE 'visit%'
                 AND ref_id IN (SELECT id FROM visits WHERE publisher_id = u.id)) AS earned
       FROM users u WHERE u.referred_by = ? ORDER BY u.created_at DESC LIMIT 100`,
      userId, userId,
    ),
    totalRefEarnings: me.ref_earn_micros,
    referralPct: revenue.shares().referral,
  });
});

// ---------------------------------------------------------------------------
// Files (Telegram vault)
// ---------------------------------------------------------------------------
router.get('/files', (req, res) => {
  const userId = req.user.id;
  const me = res.locals.me;
  res.render('dashboard/files', {
    title: `File vault · ${config.brand.name}`,
    tab: 'files',
    resources: q.all(
      `SELECT r.*, (SELECT COUNT(*) FROM links WHERE resource_id = r.id) AS link_count
       FROM resources r WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 200`,
      userId,
    ),
    telegramEnabled: telegram.enabled,
    botUsername: config.telegram.botUsername,
    linked: Boolean(me.tg_chat_id),
    pairCode: me.tg_chat_id ? null : telegram.newPairingCode(userId),
  });
});

router.post('/files/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const owned = q.get('SELECT id FROM resources WHERE id = ? AND user_id = ?', id, req.user.id);
  if (owned) q.run("UPDATE resources SET status = 'removed' WHERE id = ?", id);
  res.flash('success', 'File removed from your vault. Links pointing at it will stop delivering.');
  res.redirect('/dashboard/files');
});

router.post('/files/unlink-telegram', (req, res) => {
  q.run('UPDATE users SET tg_chat_id = NULL WHERE id = ?', req.user.id);
  res.flash('success', 'Telegram account unlinked.');
  res.redirect('/dashboard/files');
});

// ---------------------------------------------------------------------------
// Campaigns (publisher-owned flows)
// ---------------------------------------------------------------------------
router.get('/campaigns', (req, res) => {
  res.render('dashboard/campaigns', {
    title: `Monetization flows · ${config.brand.name}`,
    tab: 'campaigns',
    mine: q.all('SELECT * FROM campaigns WHERE owner_id = ? ORDER BY created_at DESC', req.user.id),
    platform: q.all("SELECT id, name, steps, wait_seconds, skip_mode FROM campaigns WHERE owner_id IS NULL AND status = 'active'"),
    defaultSteps: campaigns.DEFAULT_STEPS,
    parseJson,
  });
});

router.post('/campaigns', (req, res) => {
  const { name = '', steps = '', wait_seconds = '', skip_mode = '', id = '' } = req.body || {};
  const bail = (msg) => { res.flash('error', msg); return res.redirect('/dashboard/campaigns'); };

  let clean;
  try { clean = campaigns.sanitizeSteps(steps); } catch (e) { return bail(e.message); }

  const wait = clamp(parseInt(wait_seconds, 10) || config.monetization.waitSeconds, 0, 120);
  const skip = ['engagement', 'ad_click', 'none'].includes(skip_mode) ? skip_mode : 'engagement';
  const label = String(name).trim().slice(0, 80) || 'Untitled flow';

  if (id) {
    const owned = q.get('SELECT id FROM campaigns WHERE id = ? AND owner_id = ?', parseInt(id, 10), req.user.id);
    if (!owned) return bail('Flow not found.');
    q.run('UPDATE campaigns SET name = ?, steps = ?, wait_seconds = ?, skip_mode = ? WHERE id = ?',
      label, JSON.stringify(clean), wait, skip, owned.id);
    res.flash('success', 'Flow updated.');
  } else {
    if ((q.scalar('SELECT COUNT(*) FROM campaigns WHERE owner_id = ?', req.user.id) || 0) >= 10) {
      return bail('You can keep up to 10 custom flows.');
    }
    q.run(
      `INSERT INTO campaigns (name, owner_id, steps, wait_seconds, skip_mode, targeting, priority, status, created_at)
       VALUES (?,?,?,?,?,'{}',10,'active',?)`,
      label, req.user.id, JSON.stringify(clean), wait, skip, now(),
    );
    res.flash('success', 'Flow created. Select it when you create or edit a link.');
  }
  res.redirect('/dashboard/campaigns');
});

router.post('/campaigns/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const owned = q.get('SELECT id FROM campaigns WHERE id = ? AND owner_id = ?', id, req.user.id);
  if (owned) q.run('DELETE FROM campaigns WHERE id = ?', id);
  res.flash('success', 'Flow deleted. Links using it fall back to the platform default.');
  res.redirect('/dashboard/campaigns');
});

// ---------------------------------------------------------------------------
// Advertise: self-serve ad campaigns for creators
// ---------------------------------------------------------------------------
router.get('/ads', (req, res) => {
  const userId = req.user.id;
  const d = range(req);

  res.render('dashboard/ads', {
    title: `Ad campaigns · ${config.brand.name}`,
    tab: 'ads',
    days: d,
    packages: promos.packages(),
    campaigns: q.all(
      `SELECT * FROM promotions WHERE user_id = ? ORDER BY
         CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'approved' THEN 2
                     WHEN 'draft' THEN 3 WHEN 'paused' THEN 4 ELSE 5 END,
         created_at DESC`,
      userId,
    ),
    totals: promos.accountTotals(userId, d),
    series: promos.accountSeries(userId, d),
    credit: res.locals.me.ad_credit_micros || 0,
    spent: res.locals.me.ad_spend_micros || 0,
    baseUrl: config.baseUrl,
  });
});

router.post('/ads', rateLimit({ max: 20, windowMs: 3600000, key: 'adcreate' }), (req, res) => {
  const bail = (msg) => { res.flash('error', msg); return res.redirect('/dashboard/ads'); };

  const check = promos.validateSubmission({ ...req.body, email: req.body.email || req.user.email });
  if (!check.ok) return bail(check.error);

  const d = check.data;
  const result = q.run(
    `INSERT INTO promotions (user_id, kind, title, blurb, url, youtube_id, image, cta,
                             advertiser, email, note, package, placement, price_micros, days, weight,
                             status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    req.user.id, d.kind, d.title, d.blurb, d.url, d.youtube_id, d.image, d.cta,
    d.advertiser || req.user.name || req.user.email, d.email, d.note,
    d.package, d.placement, d.price_micros, d.days, d.weight, now(),
  );
  const id = Number(result.lastInsertRowid);

  const charged = promos.charge(req.user.id, d.price_micros, id);
  if (charged.ok) {
    q.run("UPDATE promotions SET status = 'pending' WHERE id = ?", id);
    res.flash('success', `Campaign funded (${usd(d.price_micros)}) and submitted for review.`);
  } else {
    res.flash('error',
      `Campaign saved as a draft. You need ${usd(charged.shortfall_usd * 1000000)} more ad credit to fund it.`);
  }
  res.redirect('/dashboard/ads');
});

router.get('/ads/:id', (req, res) => {
  const promo = q.get('SELECT * FROM promotions WHERE id = ? AND user_id = ?',
    parseInt(req.params.id, 10), req.user.id);
  if (!promo) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such campaign.' });
  }

  const d = range(req);
  res.render('dashboard/ad-detail', {
    title: `${promo.title} · ${config.brand.name}`,
    tab: 'ads',
    days: d,
    promo,
    totals: promos.totals(promo.id, d),
    series: promos.series(promo.id, d),
    countries: promos.breakdown(promo.id, 'country', d, 12),
    devices: promos.breakdown(promo.id, 'device', d, 6),
    surfaces: promos.breakdown(promo.id, 'surface', d, 6),
    packageInfo: promos.packageByKey(promo.package),
    preview: promos.card(promo, 'site'),
  });
});

router.post('/ads/:id/state', (req, res) => {
  const promo = q.get('SELECT * FROM promotions WHERE id = ? AND user_id = ?',
    parseInt(req.params.id, 10), req.user.id);
  if (!promo) { res.flash('error', 'Campaign not found.'); return res.redirect('/dashboard/ads'); }

  const want = req.body.state;
  if (want === 'pause' && promo.status === 'active') {
    q.run("UPDATE promotions SET status = 'paused' WHERE id = ?", promo.id);
    res.flash('success', 'Campaign paused. It stops showing immediately.');
  } else if (want === 'resume' && promo.status === 'paused') {
    q.run("UPDATE promotions SET status = 'active' WHERE id = ?", promo.id);
    res.flash('success', 'Campaign resumed.');
  } else if (want === 'fund' && !promo.paid) {
    const charged = promos.charge(req.user.id, promo.price_micros, promo.id);
    if (charged.ok) {
      q.run("UPDATE promotions SET status = 'pending' WHERE id = ?", promo.id);
      res.flash('success', `Funded ${usd(promo.price_micros)}. Your campaign is in the review queue.`);
    } else {
      res.flash('error', `Not enough ad credit — you need ${usd(charged.shortfall_usd * 1000000)} more.`);
    }
  } else {
    res.flash('error', `Cannot do that to a ${promo.status} campaign.`);
  }
  promos.invalidate();
  res.redirect(req.get('referer') || '/dashboard/ads');
});

router.post('/ads/:id/delete', (req, res) => {
  const promo = q.get('SELECT * FROM promotions WHERE id = ? AND user_id = ?',
    parseInt(req.params.id, 10), req.user.id);
  if (!promo) { res.flash('error', 'Campaign not found.'); return res.redirect('/dashboard/ads'); }

  let refunded = false;
  if (promo.paid && ['draft', 'pending', 'approved'].includes(promo.status)) {
    refunded = promos.refund(promo.id, 'Cancelled by advertiser before going live');
  }
  q.run('DELETE FROM promotions WHERE id = ?', promo.id);
  q.run('DELETE FROM promo_stats WHERE promo_id = ?', promo.id);
  promos.invalidate();

  res.flash('success', refunded
    ? `Campaign cancelled and ${usd(promo.price_micros)} returned to your ad credit.`
    : 'Campaign deleted. Delivered impressions are not refunded.');
  res.redirect('/dashboard/ads');
});

// ---------------------------------------------------------------------------
// API + settings
// ---------------------------------------------------------------------------
router.get('/api', (req, res) => {
  res.render('dashboard/api', {
    title: `Developer API · ${config.brand.name}`,
    tab: 'api',
    apiKey: res.locals.me.api_key,
    baseUrl: config.baseUrl,
  });
});

router.post('/api/rotate', rateLimit({ max: 5, windowMs: 3600000, key: 'apirotate' }), (req, res) => {
  auth.rotateApiKey(req.user.id);
  res.flash('success', 'API key rotated. The old key stopped working immediately.');
  res.redirect('/dashboard/api');
});

router.get('/settings', (req, res) => {
  res.render('dashboard/settings', {
    title: `Settings · ${config.brand.name}`,
    tab: 'settings',
    sessions: q.all('SELECT id, ua, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC', req.user.id),
    currentSession: req.session.id,
    passwordRules: auth.PASSWORD_RULES,
  });
});

router.post('/settings', (req, res) => {
  const { name = '', payout_method = '', payout_address = '' } = req.body || {};
  q.run(
    'UPDATE users SET name = ?, payout_method = ?, payout_address = ? WHERE id = ?',
    String(name).slice(0, 80), String(payout_method).slice(0, 40), String(payout_address).slice(0, 200), req.user.id,
  );
  res.flash('success', 'Profile saved.');
  res.redirect('/dashboard/settings');
});

router.post('/settings/sessions/revoke', (req, res) => {
  q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user.id, req.session.id);
  res.flash('success', 'All other sessions signed out.');
  res.redirect('/dashboard/settings');
});

const RESERVED = new Set([
  'api', 'admin', 'dashboard', 'login', 'register', 'logout', 'blog', 'about', 'contact',
  'privacy', 'terms', 'dmca', 'products', 'pricing', 'help', 'docs', 's', 'v', 'd', 'gw',
  'out', 'unlock', 'webhooks', 'static', 'public', 'assets', 'robots', 'sitemap', 'ads',
]);

module.exports = router;
