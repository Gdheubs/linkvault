'use strict';

const express = require('express');
const config = require('../config');
const { q, settings } = require('../db');
const stats = require('../lib/stats');
const revenue = require('../lib/revenue');
const fraud = require('../lib/fraud');
const ads = require('../lib/ads');
const campaigns = require('../lib/campaigns');
const telegram = require('../lib/telegram');
const promos = require('../lib/promos');
const { requireAdmin } = require('../middleware');
const {
  now, usd, slugify, clamp, parseJson, toMicros, isSafeUrl,
} = require('../lib/util');

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, nextFn) => { res.locals.nav = 'admin'; nextFn(); });

const audit = (req, action, meta = {}) => q.run(
  'INSERT INTO audit_log (actor_id, action, meta, ip_hash, created_at) VALUES (?,?,?,?,?)',
  req.user.id, action, JSON.stringify(meta), req.ipHash, now(),
);
const back = (req, res, msg, type = 'success') => {
  res.flash(type, msg);
  res.redirect(req.get('referer') || '/admin');
};
const days = (req, def = 30) => clamp(parseInt(req.query.days, 10) || def, 1, 365);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const d = days(req);
  res.render('admin/overview', {
    title: `Admin · ${config.brand.name}`,
    tab: 'overview',
    days: d,
    pulse: stats.platformPulse(),
    summary: stats.summary(null, d),
    series: stats.series(null, d),
    countries: stats.breakdown(null, 'country', d, 10),
    devices: stats.breakdown(null, 'device', d, 5),
    topPublishers: q.all(
      `SELECT u.id, u.name, u.email, u.fraud_score, u.status,
              SUM(ds.clicks) AS clicks, SUM(ds.completed_visits) AS completed,
              SUM(ds.publisher_micros) AS earned
       FROM daily_stats ds JOIN users u ON u.id = ds.user_id
       WHERE ds.link_id = 0 AND ds.day >= ?
       GROUP BY u.id ORDER BY earned DESC LIMIT 10`,
      stats.sinceDay(d),
    ),
    fraudTop: stats.fraudSignals(7, 8),
    recentFraud: q.all(
      `SELECT f.*, u.email FROM fraud_events f LEFT JOIN users u ON u.id = f.user_id
       ORDER BY f.created_at DESC LIMIT 12`,
    ),
    adsenseReady: ads.adsenseReady(),
    telegramReady: telegram.enabled,
  });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
router.get('/users', (req, res) => {
  const search = String(req.query.q || '').trim();
  const status = ['active', 'suspended', 'banned'].includes(req.query.status) ? req.query.status : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 25;

  const filters = ['1=1'];
  const args = [];
  if (search) { filters.push('(email LIKE ? OR name LIKE ? OR ref_code = ?)'); args.push(`%${search}%`, `%${search}%`, search.toUpperCase()); }
  if (status) { filters.push('status = ?'); args.push(status); }
  const where = filters.join(' AND ');

  const total = q.scalar(`SELECT COUNT(*) FROM users WHERE ${where}`, ...args) || 0;
  res.render('admin/users', {
    title: `Users · Admin`,
    tab: 'users',
    users: q.all(
      `SELECT id, email, name, role, status, balance_micros, pending_micros, paid_micros,
              fraud_score, ref_code, referred_by, created_at, last_login_at,
              (SELECT COUNT(*) FROM links WHERE user_id = users.id) AS links
       FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...args, perPage, (page - 1) * perPage,
    ),
    search, status, page, perPage, total,
    pages: Math.max(1, Math.ceil(total / perPage)),
  });
});

router.get('/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such user.' });
  delete user.password_hash;

  res.render('admin/user-detail', {
    title: `${user.email} · Admin`,
    tab: 'users',
    subject: user,
    summary: stats.summary(id, 30),
    series: stats.series(id, 30),
    links: q.all('SELECT * FROM links WHERE user_id = ? ORDER BY clicks DESC LIMIT 25', id),
    ledger: q.all('SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 40', id),
    payouts: q.all('SELECT * FROM payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', id),
    fraudEvents: q.all('SELECT * FROM fraud_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 25', id),
    referrer: user.referred_by ? q.get('SELECT id, email FROM users WHERE id = ?', user.referred_by) : null,
    referred: q.all('SELECT id, email, created_at FROM users WHERE referred_by = ?', id),
  });
});

router.post('/users/:id/status', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = ['active', 'suspended', 'banned'].includes(req.body.status) ? req.body.status : 'active';
  if (id === req.user.id) return back(req, res, 'You cannot change your own status.', 'error');
  q.run('UPDATE users SET status = ? WHERE id = ?', status, id);
  if (status === 'banned') q.run('DELETE FROM sessions WHERE user_id = ?', id);
  audit(req, 'admin.user.status', { id, status });
  back(req, res, `User marked ${status}.`);
});

router.post('/users/:id/role', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = req.body.role === 'admin' ? 'admin' : 'publisher';
  if (id === req.user.id) return back(req, res, 'You cannot change your own role.', 'error');
  q.run('UPDATE users SET role = ? WHERE id = ?', role, id);
  audit(req, 'admin.user.role', { id, role });
  back(req, res, `Role set to ${role}.`);
});

router.post('/users/:id/adjust', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const amount = Number(req.body.amount);
  const note = String(req.body.note || 'Manual adjustment').slice(0, 200);
  if (!Number.isFinite(amount) || amount === 0) return back(req, res, 'Enter a non-zero amount.', 'error');
  const micros = toMicros(amount);
  q.tx(() => {
    q.run('UPDATE users SET balance_micros = MAX(0, balance_micros + ?) WHERE id = ?', micros, id);
    revenue.ledger({ userId: id, kind: 'adjustment', amountMicros: micros, note });
  });
  audit(req, 'admin.user.adjust', { id, micros, note });
  back(req, res, `Balance adjusted by ${usd(micros)}.`);
});

router.post('/users/:id/ad-credit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const amount = Number(req.body.amount);
  const note = String(req.body.note || 'Ad credit top-up').slice(0, 200);
  if (!Number.isFinite(amount) || amount === 0) return back(req, res, 'Enter a non-zero amount.', 'error');

  const micros = toMicros(amount);
  if (micros > 0) {
    promos.topUp(id, micros, note);
  } else {
    // Removing credit: never let it go negative.
    const cur = q.scalar('SELECT ad_credit_micros FROM users WHERE id = ?', id) || 0;
    const take = Math.min(cur, -micros);
    if (take <= 0) return back(req, res, 'That account has no credit to remove.', 'error');
    q.tx(() => {
      q.run('UPDATE users SET ad_credit_micros = ad_credit_micros - ? WHERE id = ?', take, id);
      revenue.ledger({ userId: id, kind: 'ad_credit', amountMicros: -take, refType: 'topup', note });
    });
  }
  audit(req, 'admin.user.adcredit', { id, micros, note });
  back(req, res, `Ad credit adjusted by ${usd(micros)}.`);
});

// ---------------------------------------------------------------------------
// Links + moderation
// ---------------------------------------------------------------------------
router.get('/links', (req, res) => {
  const search = String(req.query.q || '').trim();
  const status = ['active', 'paused', 'blocked'].includes(req.query.status) ? req.query.status : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 30;

  const filters = ['1=1'];
  const args = [];
  if (search) { filters.push('(l.code LIKE ? OR l.destination LIKE ? OR l.title LIKE ? OR u.email LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  if (status) { filters.push('l.status = ?'); args.push(status); }
  const where = filters.join(' AND ');

  const total = q.scalar(`SELECT COUNT(*) FROM links l JOIN users u ON u.id = l.user_id WHERE ${where}`, ...args) || 0;
  res.render('admin/links', {
    title: 'Links · Admin',
    tab: 'links',
    links: q.all(
      `SELECT l.*, u.email, r.file_name FROM links l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN resources r ON r.id = l.resource_id
       WHERE ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      ...args, perPage, (page - 1) * perPage,
    ),
    search, status, page, perPage, total,
    pages: Math.max(1, Math.ceil(total / perPage)),
  });
});

router.post('/links/:id/status', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = ['active', 'paused', 'blocked'].includes(req.body.status) ? req.body.status : 'active';
  q.run('UPDATE links SET status = ? WHERE id = ?', status, id);
  audit(req, 'admin.link.status', { id, status });
  back(req, res, `Link marked ${status}.`);
});

router.post('/resources/:id/status', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = ['ready', 'quarantined', 'removed'].includes(req.body.status) ? req.body.status : 'ready';
  q.run('UPDATE resources SET status = ? WHERE id = ?', status, id);
  audit(req, 'admin.resource.status', { id, status });
  back(req, res, `File marked ${status}.`);
});

router.get('/files', (req, res) => {
  res.render('admin/files', {
    title: 'File vault · Admin',
    tab: 'files',
    resources: q.all(
      `SELECT r.*, u.email, (SELECT COUNT(*) FROM links WHERE resource_id = r.id) AS link_count
       FROM resources r JOIN users u ON u.id = r.user_id
       ORDER BY r.created_at DESC LIMIT 200`,
    ),
    telegramReady: telegram.enabled,
  });
});

// ---------------------------------------------------------------------------
// Traffic + fraud
// ---------------------------------------------------------------------------
router.get('/traffic', (req, res) => {
  const d = days(req);
  res.render('admin/traffic', {
    title: 'Traffic · Admin',
    tab: 'traffic',
    days: d,
    summary: stats.summary(null, d),
    series: stats.series(null, d),
    countries: stats.breakdown(null, 'country', d, 20),
    devices: stats.breakdown(null, 'device', d, 5),
    browsers: stats.visitBreakdown(null, 'browser', d, 10),
    oses: stats.visitBreakdown(null, 'os', d, 10),
    referers: stats.visitBreakdown(null, 'referer', d, 12),
    recent: stats.recentVisits(null, 40),
  });
});

router.get('/fraud', (req, res) => {
  const d = days(req, 7);
  res.render('admin/fraud', {
    title: 'Anti-fraud · Admin',
    tab: 'fraud',
    days: d,
    signalCatalog: fraud.SIGNALS,
    topSignals: stats.fraudSignals(d, 20),
    events: q.all(
      `SELECT f.*, u.email FROM fraud_events f LEFT JOIN users u ON u.id = f.user_id
       WHERE f.created_at > ? ORDER BY f.created_at DESC LIMIT 100`,
      now() - d * 86400000,
    ),
    flagged: q.all(
      'SELECT id, email, fraud_score, status, balance_micros, pending_micros FROM users WHERE fraud_score >= 35 ORDER BY fraud_score DESC LIMIT 40',
    ),
    suspectVisits: q.all(
      `SELECT v.id, v.country, v.device, v.fraud_score, v.fraud_reasons, v.publisher_micros,
              v.created_at, l.code, u.email
       FROM visits v JOIN links l ON l.id = v.link_id JOIN users u ON u.id = v.publisher_id
       WHERE v.fraud_score >= ? AND v.created_at > ?
       ORDER BY v.created_at DESC LIMIT 60`,
      config.fraud.reviewScore, now() - d * 86400000,
    ),
    blocklist: q.all('SELECT * FROM blocklist ORDER BY created_at DESC LIMIT 200'),
    thresholds: config.fraud,
    parseJson,
  });
});

router.post('/fraud/block', (req, res) => {
  const kind = ['ip', 'iprange', 'domain', 'country', 'ua'].includes(req.body.kind) ? req.body.kind : 'ip';
  const value = String(req.body.value || '').trim().slice(0, 200);
  const reason = String(req.body.reason || '').slice(0, 200);
  if (!value) return back(req, res, 'Enter a value to block.', 'error');
  try {
    q.run('INSERT INTO blocklist (kind, value, reason, created_at) VALUES (?,?,?,?)', kind, value, reason, now());
  } catch {
    return back(req, res, 'That entry is already on the blocklist.', 'error');
  }
  fraud.invalidateBlocklist();
  audit(req, 'admin.block.add', { kind, value });
  back(req, res, `Blocked ${kind}: ${value}`);
});

router.post('/fraud/unblock/:id', (req, res) => {
  q.run('DELETE FROM blocklist WHERE id = ?', parseInt(req.params.id, 10));
  fraud.invalidateBlocklist();
  audit(req, 'admin.block.remove', { id: req.params.id });
  back(req, res, 'Blocklist entry removed.');
});

router.post('/fraud/reverse/:visitId', (req, res) => {
  const visitId = parseInt(req.params.visitId, 10);
  const n = revenue.reverseVisit(visitId, String(req.body.note || 'Reversed by admin').slice(0, 200));
  audit(req, 'admin.fraud.reverse', { visitId, entries: n });
  back(req, res, n ? `Reversed ${n} ledger entries for visit #${visitId}.` : 'Nothing to reverse for that visit.');
});

router.post('/fraud/rescore/:userId', (req, res) => {
  const score = fraud.refreshPublisherScore(parseInt(req.params.userId, 10));
  back(req, res, `Publisher fraud score recalculated: ${score}.`);
});

// ---------------------------------------------------------------------------
// Revenue: rate cards + payouts
// ---------------------------------------------------------------------------
router.get('/revenue', (req, res) => {
  const d = days(req);
  res.render('admin/revenue', {
    title: 'Revenue · Admin',
    tab: 'revenue',
    days: d,
    summary: stats.summary(null, d),
    series: stats.series(null, d),
    rateCards: q.all('SELECT * FROM rate_cards ORDER BY (country = \'*\'), cpm_micros DESC'),
    shares: revenue.shares(),
    owed: q.scalar('SELECT COALESCE(SUM(balance_micros),0) FROM users') || 0,
    held: q.scalar('SELECT COALESCE(SUM(pending_micros),0) FROM users') || 0,
    paid: q.scalar('SELECT COALESCE(SUM(paid_micros),0) FROM users') || 0,
    platformMicros: q.scalar(
      'SELECT COALESCE(SUM(platform_micros),0) FROM visits WHERE created_at > ?',
      now() - d * 86400000,
    ) || 0,
    holdHours: config.revenue.holdHours,
    minPayout: config.revenue.minPayoutMicros,
  });
});

router.post('/revenue/rate', (req, res) => {
  const country = String(req.body.country || '*').trim().toUpperCase().slice(0, 2) || '*';
  const device = ['desktop', 'mobile', 'tablet', '*'].includes(req.body.device) ? req.body.device : '*';
  const cpm = Number(req.body.cpm);
  const fill = clamp(Number(req.body.fill_rate) || 1, 0, 1);
  const note = String(req.body.note || '').slice(0, 120);
  if (!Number.isFinite(cpm) || cpm < 0) return back(req, res, 'Enter a valid CPM in USD.', 'error');

  q.run(
    `INSERT INTO rate_cards (country, device, cpm_micros, fill_rate, active, note) VALUES (?,?,?,?,1,?)
     ON CONFLICT(country, device) DO UPDATE SET cpm_micros = excluded.cpm_micros,
       fill_rate = excluded.fill_rate, note = excluded.note, active = 1`,
    country === '' ? '*' : country, device, toMicros(cpm), fill, note,
  );
  audit(req, 'admin.rate.set', { country, device, cpm });
  back(req, res, `Rate card saved: ${country}/${device} at $${cpm.toFixed(3)} CPM.`);
});

router.post('/revenue/rate/:id/delete', (req, res) => {
  q.run('DELETE FROM rate_cards WHERE id = ?', parseInt(req.params.id, 10));
  back(req, res, 'Rate card row deleted.');
});

router.post('/revenue/shares', (req, res) => {
  const pub = clamp(Number(req.body.publisher_share_pct), 0, 95);
  const ref = clamp(Number(req.body.referral_share_pct), 0, 50);
  settings.set('publisher_share_pct', pub);
  settings.set('referral_share_pct', ref);
  audit(req, 'admin.shares.set', { pub, ref });
  back(req, res, `Revenue split saved: publisher ${pub}%, referrer ${ref}%, platform ${(100 - pub - ref).toFixed(1)}%.`);
});

router.post('/revenue/release', (req, res) => {
  const released = revenue.releaseMatured();
  audit(req, 'admin.revenue.release', { released });
  back(req, res, `Released ${usd(released)} of matured earnings to withdrawable balances.`);
});

router.get('/payouts', (req, res) => {
  const status = ['pending', 'approved', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : '';
  res.render('admin/payouts', {
    title: 'Payouts · Admin',
    tab: 'payouts',
    status,
    payouts: q.all(
      `SELECT p.*, u.email, u.name, u.fraud_score FROM payouts p JOIN users u ON u.id = p.user_id
       ${status ? 'WHERE p.status = ?' : ''} ORDER BY p.created_at DESC LIMIT 200`,
      ...(status ? [status] : []),
    ),
    totals: {
      pending: q.scalar("SELECT COALESCE(SUM(amount_micros),0) FROM payouts WHERE status = 'pending'") || 0,
      paid: q.scalar("SELECT COALESCE(SUM(amount_micros),0) FROM payouts WHERE status = 'paid'") || 0,
    },
  });
});

router.post('/payouts/:id/status', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = ['approved', 'paid', 'rejected'].includes(req.body.status) ? req.body.status : null;
  const note = String(req.body.note || '').slice(0, 200);
  const payout = q.get('SELECT * FROM payouts WHERE id = ?', id);
  if (!payout || !status) return back(req, res, 'Invalid payout action.', 'error');
  if (payout.status === 'paid') return back(req, res, 'That payout is already settled.', 'error');

  q.tx(() => {
    q.run('UPDATE payouts SET status = ?, note = ?, processed_at = ?, processed_by = ? WHERE id = ?',
      status, note, now(), req.user.id, id);

    if (status === 'paid') {
      q.run('UPDATE users SET paid_micros = paid_micros + ? WHERE id = ?', payout.amount_micros, payout.user_id);
    }
    if (status === 'rejected') {
      // Money was debited at request time — put it back.
      q.run('UPDATE users SET balance_micros = balance_micros + ? WHERE id = ?', payout.amount_micros, payout.user_id);
      revenue.ledger({
        userId: payout.user_id, kind: 'adjustment', amountMicros: payout.amount_micros,
        refType: 'payout', refId: id, note: `Withdrawal rejected: ${note || 'no reason given'}`,
      });
    }
  });
  audit(req, 'admin.payout.status', { id, status });
  back(req, res, `Payout #${id} marked ${status}.`);
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
router.get('/campaigns', (req, res) => {
  res.render('admin/campaigns', {
    title: 'Monetization flows · Admin',
    tab: 'campaigns',
    list: q.all(
      `SELECT c.*, u.email AS owner_email,
              (SELECT COUNT(*) FROM links WHERE campaign_id = c.id) AS link_count
       FROM campaigns c LEFT JOIN users u ON u.id = c.owner_id ORDER BY c.owner_id IS NOT NULL, c.priority DESC`,
    ),
    defaultSteps: campaigns.DEFAULT_STEPS,
    globalSkipMode: settings.get('skip_mode', null) || config.monetization.skipMode,
    parseJson,
  });
});

router.post('/campaigns', (req, res) => {
  const { id = '', name = '', steps = '', wait_seconds = '', skip_mode = '', targeting = '', priority = '', status = '' } = req.body || {};
  let clean;
  try { clean = campaigns.sanitizeSteps(steps); } catch (e) { return back(req, res, e.message, 'error'); }

  let target = {};
  if (String(targeting).trim()) {
    target = parseJson(targeting, null);
    if (!target || typeof target !== 'object') return back(req, res, 'Targeting must be valid JSON.', 'error');
  }

  const fields = [
    String(name).trim().slice(0, 80) || 'Untitled flow',
    JSON.stringify(clean),
    clamp(parseInt(wait_seconds, 10) || config.monetization.waitSeconds, 0, 120),
    ['engagement', 'ad_click', 'none'].includes(skip_mode) ? skip_mode : 'engagement',
    JSON.stringify(target),
    clamp(parseInt(priority, 10) || 0, 0, 1000),
    ['active', 'paused'].includes(status) ? status : 'active',
  ];

  if (id) {
    q.run(
      'UPDATE campaigns SET name=?, steps=?, wait_seconds=?, skip_mode=?, targeting=?, priority=?, status=? WHERE id=?',
      ...fields, parseInt(id, 10),
    );
    audit(req, 'admin.campaign.update', { id });
    return back(req, res, 'Flow updated.');
  }
  q.run(
    'INSERT INTO campaigns (name, steps, wait_seconds, skip_mode, targeting, priority, status, owner_id, created_at) VALUES (?,?,?,?,?,?,?,NULL,?)',
    ...fields, now(),
  );
  audit(req, 'admin.campaign.create', { name: fields[0] });
  back(req, res, 'Flow created.');
});

router.post('/campaigns/:id/delete', (req, res) => {
  q.run('DELETE FROM campaigns WHERE id = ?', parseInt(req.params.id, 10));
  campaigns.ensureDefault();
  back(req, res, 'Flow deleted.');
});

// ---------------------------------------------------------------------------
// Ads
// ---------------------------------------------------------------------------
router.get('/ads', (req, res) => {
  res.render('admin/ads', {
    title: 'Ad inventory · Admin',
    tab: 'ads',
    slots: q.all('SELECT * FROM ad_slots ORDER BY placement, weight DESC, id'),
    adsenseReady: ads.adsenseReady(),
    adsenseClient: config.ads.adsenseClient,
    popupCfg: ads.popupSettings(),
  });
});

router.post('/ads', (req, res) => {
  const b = req.body || {};
  const key = slugify(b.slot_key || b.name || '').replace(/-/g, '_').slice(0, 40);
  if (!key) return back(req, res, 'Give the slot a key.', 'error');

  const type = ['banner', 'native', 'inarticle', 'video', 'popup', 'interstitial'].includes(b.type) ? b.type : 'banner';
  const provider = ['adsense', 'youtube', 'house', 'custom'].includes(b.provider) ? b.provider : 'adsense';
  const placement = ['gateway', 'site', 'blog', 'both'].includes(b.placement) ? b.placement : 'gateway';
  if (provider === 'house' && b.href && !isSafeUrl(b.href)) return back(req, res, 'House ad link must be a public http(s) URL.', 'error');

  q.run(
    `INSERT INTO ad_slots (slot_key, name, type, provider, html, youtube_id, href, image, headline, body, placement, enabled, weight)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(slot_key) DO UPDATE SET
       name=excluded.name, type=excluded.type, provider=excluded.provider, html=excluded.html,
       youtube_id=excluded.youtube_id, href=excluded.href, image=excluded.image,
       headline=excluded.headline, body=excluded.body, placement=excluded.placement,
       enabled=excluded.enabled, weight=excluded.weight`,
    key,
    String(b.name || key).slice(0, 80),
    type, provider,
    String(b.html || '').slice(0, 8000),
    String(b.youtube_id || '').trim().slice(0, 40),
    String(b.href || '').slice(0, 500),
    String(b.image || '').slice(0, 500),
    String(b.headline || '').slice(0, 160),
    String(b.body || '').slice(0, 400),
    placement,
    b.enabled ? 1 : 0,
    clamp(parseInt(b.weight, 10) || 10, 0, 1000),
  );
  ads.invalidate();
  audit(req, 'admin.ad.save', { key });
  back(req, res, `Ad slot "${key}" saved.`);
});

router.post('/ads/:key/delete', (req, res) => {
  q.run('DELETE FROM ad_slots WHERE slot_key = ?', String(req.params.key));
  ads.invalidate();
  back(req, res, 'Ad slot deleted.');
});

router.post('/ads/popup', (req, res) => {
  settings.set('popup_enabled', Boolean(req.body.popup_enabled));
  settings.set('popup_delay_ms', clamp(parseInt(req.body.popup_delay_ms, 10) || 6000, 0, 120000));
  settings.set('popup_per_session', clamp(parseInt(req.body.popup_per_session, 10) || 1, 0, 5));
  back(req, res, 'Popup settings saved.');
});

// ---------------------------------------------------------------------------
// Promotions (paid placements sold to bloggers / creators)
// ---------------------------------------------------------------------------
router.get('/promotions', (req, res) => {
  const status = ['draft', 'pending', 'approved', 'active', 'paused', 'expired', 'rejected'].includes(req.query.status)
    ? req.query.status : '';

  res.render('admin/promotions', {
    title: 'Promotions · Admin',
    tab: 'promotions',
    status,
    list: q.all(
      `SELECT * FROM promotions ${status ? 'WHERE status = ?' : ''} ORDER BY
         CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'active' THEN 2 ELSE 3 END,
         created_at DESC LIMIT 200`,
      ...(status ? [status] : []),
    ),
    counts: {
      pending: q.scalar("SELECT COUNT(*) FROM promotions WHERE status = 'pending'") || 0,
      awaitingPayment: q.scalar("SELECT COUNT(*) FROM promotions WHERE status = 'approved' AND paid = 0") || 0,
      awaitingMicros: q.scalar("SELECT COALESCE(SUM(price_micros),0) FROM promotions WHERE status = 'approved' AND paid = 0") || 0,
      active: q.scalar("SELECT COUNT(*) FROM promotions WHERE status = 'active'") || 0,
      paidMicros: q.scalar('SELECT COALESCE(SUM(price_micros),0) FROM promotions WHERE paid = 1') || 0,
    },
    packagesJson: JSON.stringify(promos.packages(), null, 2),
  });
});

router.post('/promotions/:id/status', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = ['draft', 'pending', 'approved', 'active', 'paused', 'expired', 'rejected'].includes(req.body.status)
    ? req.body.status : null;
  if (!status) return back(req, res, 'Invalid status.', 'error');

  const row = q.get('SELECT * FROM promotions WHERE id = ?', id);
  if (!row) return back(req, res, 'Promotion not found.', 'error');

  // Rejecting a funded campaign returns the fee to the advertiser's credit.
  // Only refund from a state where it never actually delivered.
  if (status === 'rejected' && row.paid && ['draft', 'pending', 'approved'].includes(row.status)) {
    promos.refund(row.id, 'Campaign rejected in review');
  }

  // Going live starts the clock, if it has not started already.
  if (status === 'active' && !row.starts_at) {
    q.run(
      'UPDATE promotions SET status = ?, starts_at = ?, ends_at = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?',
      status, now(), now() + row.days * 86400000, now(), req.user.id, id,
    );
  } else {
    q.run('UPDATE promotions SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?',
      status, now(), req.user.id, id);
  }
  promos.invalidate();
  audit(req, 'admin.promo.status', { id, status });
  back(req, res, `Promotion #${id} marked ${status}.`);
});

router.post('/promotions/:id/paid', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ref = String(req.body.payment_ref || '').slice(0, 120);
  const row = q.get('SELECT * FROM promotions WHERE id = ?', id);
  if (!row) return back(req, res, 'Promotion not found.', 'error');

  q.run('UPDATE promotions SET paid = 1, payment_ref = ? WHERE id = ?', ref, id);
  // A paid + approved promo becomes active on the next sweep; run one now so the
  // operator sees the result immediately.
  promos.sweep();
  audit(req, 'admin.promo.paid', { id, ref });
  back(req, res, `Promotion #${id} marked paid${row.status === 'approved' ? ' and activated' : ''}.`);
});

router.post('/promotions/:id/delete', (req, res) => {
  q.run('DELETE FROM promotions WHERE id = ?', parseInt(req.params.id, 10));
  promos.invalidate();
  audit(req, 'admin.promo.delete', { id: req.params.id });
  back(req, res, 'Promotion deleted.');
});

router.post('/promotions/sweep', (req, res) => {
  const expired = promos.sweep();
  back(req, res, `Sweep complete. ${expired} promotion${expired === 1 ? '' : 's'} expired.`);
});

router.post('/promotions/packages', (req, res) => {
  if (req.body.reset) {
    settings.set('promo_packages', null);
    promos.invalidate();
    return back(req, res, 'Packages reset to the built-in set.');
  }

  const parsed = parseJson(req.body.packages, null);
  if (!Array.isArray(parsed) || !parsed.length) {
    return back(req, res, 'Packages must be a non-empty JSON array.', 'error');
  }

  const clean = [];
  for (const raw of parsed.slice(0, 8)) {
    const key = slugify(raw.key || raw.name || '');
    if (!key) return back(req, res, 'Every package needs a key or a name.', 'error');
    const price = Number(raw.price);
    if (!Number.isFinite(price) || price < 0) return back(req, res, `Package "${key}" needs a numeric price.`, 'error');
    clean.push({
      key,
      name: String(raw.name || key).slice(0, 40),
      price,
      days: clamp(parseInt(raw.days, 10) || 7, 1, 365),
      placement: ['gateway', 'blog', 'site', 'everywhere'].includes(raw.placement) ? raw.placement : 'blog',
      weight: clamp(parseInt(raw.weight, 10) || 10, 1, 100),
      blurb: String(raw.blurb || '').slice(0, 240),
      perks: Array.isArray(raw.perks) ? raw.perks.slice(0, 8).map((x) => String(x).slice(0, 120)) : [],
      featured: Boolean(raw.featured),
    });
  }

  settings.set('promo_packages', clean);
  promos.invalidate();
  audit(req, 'admin.promo.packages', { count: clean.length });
  back(req, res, `Saved ${clean.length} package${clean.length === 1 ? '' : 's'}.`);
});

// ---------------------------------------------------------------------------
// Content: blog, products, pages
// ---------------------------------------------------------------------------
router.get('/content', (req, res) => {
  res.render('admin/content', {
    title: 'Content · Admin',
    tab: 'content',
    posts: q.all('SELECT id, slug, title, status, views, published_at, tags FROM posts ORDER BY published_at DESC'),
    products: q.all('SELECT * FROM products ORDER BY sort, id'),
    pages: q.all('SELECT slug, title, updated_at FROM pages ORDER BY slug'),
    messages: q.all('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 50'),
  });
});

router.get('/content/post/:id', (req, res) => {
  const id = req.params.id === 'new' ? null : parseInt(req.params.id, 10);
  const post = id ? q.get('SELECT * FROM posts WHERE id = ?', id) : null;
  if (id && !post) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such post.' });
  res.render('admin/post-edit', { title: 'Edit post · Admin', tab: 'content', post });
});

router.post('/content/post', (req, res) => {
  const b = req.body || {};
  const slug = slugify(b.slug || b.title);
  if (!slug || !String(b.title || '').trim()) return back(req, res, 'A post needs a title.', 'error');

  const words = String(b.body || '').split(/\s+/).length;
  const fields = [
    String(b.title).slice(0, 200),
    String(b.excerpt || '').slice(0, 400),
    String(b.body || '').slice(0, 200000),
    String(b.cover || '').slice(0, 500),
    String(b.tags || '').slice(0, 200),
    String(b.author || config.brand.name).slice(0, 80),
    Math.max(1, Math.round(words / 220)),
    ['published', 'draft'].includes(b.status) ? b.status : 'draft',
  ];

  if (b.id) {
    q.run(
      'UPDATE posts SET slug=?, title=?, excerpt=?, body=?, cover=?, tags=?, author=?, read_minutes=?, status=?, updated_at=? WHERE id=?',
      slug, ...fields, now(), parseInt(b.id, 10),
    );
  } else {
    q.run(
      'INSERT INTO posts (slug, title, excerpt, body, cover, tags, author, read_minutes, status, published_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      slug, ...fields, now(), now(),
    );
  }
  audit(req, 'admin.post.save', { slug });
  res.flash('success', 'Post saved.');
  res.redirect('/admin/content');
});

router.post('/content/post/:id/delete', (req, res) => {
  q.run('DELETE FROM posts WHERE id = ?', parseInt(req.params.id, 10));
  back(req, res, 'Post deleted.');
});

router.post('/content/product', (req, res) => {
  const b = req.body || {};
  const slug = slugify(b.slug || b.name);
  if (!slug) return back(req, res, 'A product needs a name.', 'error');
  if (b.url && !isSafeUrl(b.url)) return back(req, res, 'Product URL must be a public http(s) URL.', 'error');

  let features = [];
  if (b.features) features = String(b.features).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12);

  q.run(
    `INSERT INTO products (slug, name, tagline, description, features, price_micros, period, image, url, badge, status, sort)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name, tagline=excluded.tagline, description=excluded.description,
       features=excluded.features, price_micros=excluded.price_micros, period=excluded.period, image=excluded.image,
       url=excluded.url, badge=excluded.badge, status=excluded.status, sort=excluded.sort`,
    slug,
    String(b.name).slice(0, 120),
    String(b.tagline || '').slice(0, 200),
    String(b.description || '').slice(0, 8000),
    JSON.stringify(features),
    toMicros(Number(b.price) || 0),
    String(b.period || 'one-time').slice(0, 30),
    String(b.image || '').slice(0, 500),
    String(b.url || '').slice(0, 500),
    String(b.badge || '').slice(0, 40),
    ['active', 'hidden'].includes(b.status) ? b.status : 'active',
    clamp(parseInt(b.sort, 10) || 0, 0, 999),
  );
  audit(req, 'admin.product.save', { slug });
  back(req, res, 'Product saved.');
});

router.post('/content/product/:id/delete', (req, res) => {
  q.run('DELETE FROM products WHERE id = ?', parseInt(req.params.id, 10));
  back(req, res, 'Product deleted.');
});

router.post('/content/page', (req, res) => {
  const slug = slugify(req.body.slug || '');
  if (!slug) return back(req, res, 'Page needs a slug.', 'error');
  q.run(
    `INSERT INTO pages (slug, title, body, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(slug) DO UPDATE SET title=excluded.title, body=excluded.body, updated_at=excluded.updated_at`,
    slug, String(req.body.title || slug).slice(0, 200), String(req.body.body || '').slice(0, 200000), now(),
  );
  audit(req, 'admin.page.save', { slug });
  back(req, res, `Page /${slug} saved.`);
});

router.post('/content/message/:id/close', (req, res) => {
  q.run("UPDATE contact_messages SET status = 'closed' WHERE id = ?", parseInt(req.params.id, 10));
  back(req, res, 'Message closed.');
});

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------
router.get('/system', async (req, res) => {
  let botInfo = null;
  if (telegram.enabled) {
    const me = await telegram.getMe();
    botInfo = me.ok ? me.result : { error: me.description };
  }
  res.render('admin/system', {
    title: 'System · Admin',
    tab: 'system',
    settings: settings.all(),
    sys: {
      baseUrl: config.baseUrl,
      isProd: config.isProd,
      adsenseClient: config.ads.adsenseClient || '(unset)',
      adsenseEnabled: config.ads.adsenseEnabled,
      telegramBot: config.telegram.botUsername || '(unset)',
      holdHours: config.revenue.holdHours,
      minPayout: config.revenue.minPayoutMicros,
      fraud: config.fraud,
      monetization: config.monetization,
    },
    botInfo,
    dbSize: (() => {
      try { return require('fs').statSync(config.db.file).size; } catch { return 0; }
    })(),
    counts: {
      visits: q.scalar('SELECT COUNT(*) FROM visits') || 0,
      steps: q.scalar('SELECT COUNT(*) FROM visit_steps') || 0,
      impressions: q.scalar('SELECT COUNT(*) FROM impressions') || 0,
      ledger: q.scalar('SELECT COUNT(*) FROM ledger') || 0,
      tokens: q.scalar('SELECT COUNT(*) FROM completion_tokens') || 0,
    },
    audits: q.all(
      'SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 60',
    ),
    uptimeSec: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    nodeVersion: process.version,
  });
});

router.post('/system/settings', (req, res) => {
  const b = req.body || {};
  if (b.skip_mode) {
    settings.set('skip_mode', ['engagement', 'ad_click', 'none'].includes(b.skip_mode) ? b.skip_mode : 'engagement');
  }
  if (b.revenue_disclaimer !== undefined) settings.set('revenue_disclaimer', String(b.revenue_disclaimer).slice(0, 500));
  if (b.announcement !== undefined) settings.set('announcement', String(b.announcement).slice(0, 300));
  audit(req, 'admin.settings.save', {});
  back(req, res, 'Settings saved.');
});

router.post('/system/telegram/webhook', async (req, res) => {
  const result = await telegram.setWebhook(config.baseUrl);
  back(req, res, result.ok ? 'Telegram webhook registered.' : `Telegram error: ${result.description}`, result.ok ? 'success' : 'error');
});

router.post('/system/vacuum', (req, res) => {
  const cutoff = now() - 180 * 86400000;
  q.run('DELETE FROM impressions WHERE created_at < ?', cutoff);
  q.run('DELETE FROM visit_steps WHERE visit_id IN (SELECT id FROM visits WHERE created_at < ?)', cutoff);
  q.run('DELETE FROM visits WHERE created_at < ?', cutoff);
  q.run('DELETE FROM completion_tokens WHERE expires_at < ?', now() - 86400000);
  q.exec('VACUUM');
  audit(req, 'admin.system.vacuum', {});
  back(req, res, 'Old raw traffic pruned (rolled-up stats kept) and database compacted.');
});

module.exports = router;
