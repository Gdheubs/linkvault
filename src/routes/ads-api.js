'use strict';

/**
 * Advertiser API (v1) — self-serve ad campaigns for creators.
 *
 * Any account can be an advertiser; it uses the same Bearer API key as the
 * publisher API. A creator can run campaigns and publish links from one key.
 *
 *   GET    /api/v1/ads/packages              what you can buy
 *   GET    /api/v1/ads/account               credit balance + campaign counts
 *   GET    /api/v1/ads/stats                 rollup across all your campaigns
 *
 *   POST   /api/v1/ads/campaigns             create (funds from credit if available)
 *   GET    /api/v1/ads/campaigns             list yours
 *   GET    /api/v1/ads/campaigns/:id         one campaign + lifetime numbers
 *   PATCH  /api/v1/ads/campaigns/:id         edit creative, pause, resume
 *   DELETE /api/v1/ads/campaigns/:id         cancel (refunds if not yet live)
 *   POST   /api/v1/ads/campaigns/:id/fund    fund a draft from credit
 *   GET    /api/v1/ads/campaigns/:id/stats   daily series + breakdowns
 *
 * Campaign lifecycle:
 *   draft ──fund──> pending ──admin approves──> active ──term ends──> expired
 *                      └─────admin rejects─────> rejected (credit refunded)
 *   active <──pause/resume──> paused
 */

const express = require('express');
const { q } = require('../db');
const promos = require('../lib/promos');
const { requireApiKey, rateLimit } = require('../middleware');
const { now, clamp, isSafeUrl } = require('../lib/util');

const router = express.Router();

router.use(express.json({ limit: '32kb' }));
router.use(rateLimit({
  max: 200,
  windowMs: 60000,
  key: 'adsapi',
  by: (req) => (req.get('authorization') || req.get('x-api-key') || req.ipHash).slice(-32),
}));
router.use(requireApiKey);

const owned = (req, id) => q.get(
  'SELECT * FROM promotions WHERE id = ? AND user_id = ?',
  parseInt(id, 10), req.apiUser.id,
);
const days = (req, def = 30) => clamp(parseInt(req.query.days, 10) || def, 1, 365);

// ---------------------------------------------------------------------------
// Catalogue + account
// ---------------------------------------------------------------------------
router.get('/packages', (req, res) => {
  res.json({
    data: promos.packages().map((p) => ({
      key: p.key,
      name: p.name,
      price_usd: p.price,
      days: p.days,
      placement: p.placement,
      description: p.blurb,
      perks: p.perks || [],
    })),
  });
});

router.get('/account', (req, res) => {
  const u = q.get('SELECT ad_credit_micros, ad_spend_micros FROM users WHERE id = ?', req.apiUser.id);
  const counts = q.get(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'draft')   AS draft,
       SUM(status = 'pending') AS pending,
       SUM(status = 'active')  AS active,
       SUM(status = 'paused')  AS paused,
       SUM(status = 'expired') AS expired,
       SUM(status = 'rejected') AS rejected,
       COALESCE(SUM(impressions), 0) AS impressions,
       COALESCE(SUM(clicks), 0) AS clicks
     FROM promotions WHERE user_id = ?`,
    req.apiUser.id,
  ) || {};

  res.json({
    credit_usd: Number((u.ad_credit_micros / 1e6).toFixed(2)),
    spent_usd: Number((u.ad_spend_micros / 1e6).toFixed(2)),
    campaigns: {
      total: counts.total || 0,
      draft: counts.draft || 0,
      pending: counts.pending || 0,
      active: counts.active || 0,
      paused: counts.paused || 0,
      expired: counts.expired || 0,
      rejected: counts.rejected || 0,
    },
    lifetime: {
      impressions: counts.impressions || 0,
      clicks: counts.clicks || 0,
      ctr: counts.impressions ? Number((counts.clicks / counts.impressions).toFixed(4)) : 0,
    },
  });
});

router.get('/stats', (req, res) => {
  const d = days(req);
  const totals = promos.accountTotals(req.apiUser.id, d);
  res.json({
    days: d,
    totals: {
      impressions: totals.impressions,
      clicks: totals.clicks,
      ctr: Number(totals.ctr.toFixed(4)),
    },
    series: promos.accountSeries(req.apiUser.id, d),
    campaigns: q.all(
      `SELECT id, title, status, impressions, clicks FROM promotions
       WHERE user_id = ? ORDER BY impressions DESC LIMIT 50`,
      req.apiUser.id,
    ).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      impressions: c.impressions,
      clicks: c.clicks,
      ctr: c.impressions ? Number((c.clicks / c.impressions).toFixed(4)) : 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
router.get('/campaigns', (req, res) => {
  const limit = clamp(parseInt(req.query.limit, 10) || 50, 1, 200);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const status = ['draft', 'pending', 'approved', 'active', 'paused', 'expired', 'rejected']
    .includes(req.query.status) ? req.query.status : null;

  const where = status ? 'user_id = ? AND status = ?' : 'user_id = ?';
  const args = status ? [req.apiUser.id, status] : [req.apiUser.id];

  res.json({
    total: q.scalar(`SELECT COUNT(*) FROM promotions WHERE ${where}`, ...args) || 0,
    limit,
    offset,
    data: q.all(
      `SELECT * FROM promotions WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...args, limit, offset,
    ).map((p) => promos.publicCampaign(p)),
  });
});

router.post('/campaigns', (req, res) => {
  // An API caller is already identified, so the contact email defaults to their
  // account rather than being required on every request.
  const check = promos.validateSubmission({
    ...(req.body || {}),
    email: (req.body && req.body.email) || req.apiUser.email,
  });
  if (!check.ok) return res.status(400).json({ error: 'invalid_campaign', message: check.error });

  const d = check.data;
  const user = req.apiUser;

  const result = q.run(
    `INSERT INTO promotions (user_id, kind, title, blurb, url, youtube_id, image, cta,
                             advertiser, email, note, package, placement, price_micros, days, weight,
                             status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    user.id, d.kind, d.title, d.blurb, d.url, d.youtube_id, d.image, d.cta,
    d.advertiser || user.name || user.email, d.email || user.email, d.note,
    d.package, d.placement, d.price_micros, d.days, d.weight, now(),
  );
  const id = Number(result.lastInsertRowid);

  // Fund it straight away when there is credit, so the creator's next step is
  // just "wait for review" rather than a second call.
  const charged = promos.charge(user.id, d.price_micros, id);
  if (charged.ok) {
    q.run("UPDATE promotions SET status = 'pending' WHERE id = ?", id);
  }

  const row = q.get('SELECT * FROM promotions WHERE id = ?', id);
  res.status(201).json({
    ...promos.publicCampaign(row),
    funded: charged.ok,
    ...(charged.ok ? {} : {
      funding_error: charged.error,
      shortfall_usd: charged.shortfall_usd,
      message: 'Campaign saved as a draft. Add ad credit, then POST /campaigns/:id/fund.',
    }),
    next_step: charged.ok
      ? 'Awaiting review. You will be notified when it goes live.'
      : 'Top up your ad credit, then fund this campaign.',
  });
});

router.get('/campaigns/:id', (req, res) => {
  const row = owned(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const d = days(req);
  res.json({
    ...promos.publicCampaign(row),
    window: { days: d, ...promos.totals(row.id, d) },
  });
});

router.get('/campaigns/:id/stats', (req, res) => {
  const row = owned(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const d = days(req);
  const t = promos.totals(row.id, d);

  res.json({
    campaign_id: row.id,
    title: row.title,
    status: row.status,
    days: d,
    totals: {
      impressions: t.impressions,
      clicks: t.clicks,
      ctr: Number(t.ctr.toFixed(4)),
    },
    lifetime: {
      impressions: row.impressions,
      clicks: row.clicks,
      ctr: row.impressions ? Number((row.clicks / row.impressions).toFixed(4)) : 0,
      cost_usd: Number((row.price_micros / 1e6).toFixed(2)),
      cost_per_click_usd: row.clicks ? Number((row.price_micros / row.clicks / 1e6).toFixed(4)) : null,
      cpm_usd: row.impressions ? Number((row.price_micros / row.impressions * 1000 / 1e6).toFixed(4)) : null,
    },
    series: promos.series(row.id, d),
    by_country: promos.breakdown(row.id, 'country', d, 20),
    by_device: promos.breakdown(row.id, 'device', d, 6),
    by_surface: promos.breakdown(row.id, 'surface', d, 6),
  });
});

router.patch('/campaigns/:id', (req, res) => {
  const row = owned(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (['rejected', 'expired'].includes(row.status)) {
    return res.status(409).json({ error: 'campaign_closed', message: `A ${row.status} campaign cannot be edited.` });
  }

  const b = req.body || {};

  // Advertisers control pause/resume only. Approving is a moderator action.
  let status = null;
  if (b.status !== undefined) {
    if (b.status === 'paused' && ['active', 'paused'].includes(row.status)) status = 'paused';
    else if (b.status === 'active' && row.status === 'paused') status = 'active';
    else {
      return res.status(403).json({
        error: 'status_not_allowed',
        message: 'You can only pause or resume a campaign. Review status is set by a moderator.',
      });
    }
  }

  if (b.url !== undefined && b.url && !isSafeUrl(b.url)) {
    return res.status(400).json({ error: 'invalid_url' });
  }
  if (b.image !== undefined && b.image && !isSafeUrl(b.image)) {
    return res.status(400).json({ error: 'invalid_image_url' });
  }

  // Editing the creative on a live campaign sends it back for re-review, so a
  // vetted card cannot be swapped for something else after approval.
  const creativeChanged = ['title', 'blurb', 'url', 'image', 'cta', 'youtube_id']
    .some((k) => b[k] !== undefined && String(b[k]) !== String(row[k] || ''));
  const requeue = creativeChanged && ['active', 'approved'].includes(row.status);

  q.run(
    `UPDATE promotions SET
       title      = COALESCE(?, title),
       blurb      = COALESCE(?, blurb),
       url        = COALESCE(?, url),
       image      = COALESCE(?, image),
       cta        = COALESCE(?, cta),
       youtube_id = COALESCE(?, youtube_id),
       status     = COALESCE(?, status)
     WHERE id = ?`,
    b.title !== undefined ? String(b.title).slice(0, 140) : null,
    b.blurb !== undefined ? String(b.blurb).slice(0, 300) : null,
    b.url !== undefined ? String(b.url).slice(0, 500) : null,
    b.image !== undefined ? String(b.image).slice(0, 500) : null,
    b.cta !== undefined ? String(b.cta).slice(0, 40) : null,
    b.youtube_id !== undefined ? promos.extractYouTubeId(b.youtube_id) : null,
    requeue ? 'pending' : status,
    row.id,
  );
  promos.invalidate();

  const fresh = q.get('SELECT * FROM promotions WHERE id = ?', row.id);
  res.json({
    ...promos.publicCampaign(fresh),
    ...(requeue ? { message: 'Creative changed, so the campaign is back in the review queue.' } : {}),
  });
});

router.post('/campaigns/:id/fund', (req, res) => {
  const row = owned(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.paid) return res.status(409).json({ error: 'already_funded' });

  const charged = promos.charge(req.apiUser.id, row.price_micros, row.id);
  if (!charged.ok) {
    return res.status(402).json({
      error: charged.error,
      shortfall_usd: charged.shortfall_usd,
      message: 'Not enough ad credit. Contact us to top up.',
    });
  }
  q.run("UPDATE promotions SET status = 'pending' WHERE id = ?", row.id);
  res.json({
    ...promos.publicCampaign(q.get('SELECT * FROM promotions WHERE id = ?', row.id)),
    funded: true,
    next_step: 'Awaiting review.',
  });
});

router.delete('/campaigns/:id', (req, res) => {
  const row = owned(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  // A campaign that never ran is refunded in full. One that has already been
  // live is not — the impressions were delivered.
  let refunded = false;
  if (row.paid && ['draft', 'pending', 'approved'].includes(row.status)) {
    refunded = promos.refund(row.id, 'Cancelled by advertiser before going live');
  }

  q.run('DELETE FROM promotions WHERE id = ?', row.id);
  q.run('DELETE FROM promo_stats WHERE promo_id = ?', row.id);
  promos.invalidate();

  res.json({
    deleted: true,
    refunded,
    refunded_usd: refunded ? Number((row.price_micros / 1e6).toFixed(2)) : 0,
    ...(row.status === 'active' && row.paid
      ? { note: 'This campaign had already gone live, so the fee was not refunded.' }
      : {}),
  });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, nextFn) => {
  console.error('[ads-api]', err);
  res.status(500).json({ error: 'server_error' });
});

module.exports = router;
