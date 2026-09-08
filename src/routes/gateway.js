'use strict';

/**
 * The monetization gateway.
 *
 *   GET  /s/:code        entry — create the visit, score it, hand out step 1
 *   GET  /v/:token       render step N (token carries the position; URLs can't be forged)
 *   POST /gw/probe       browser fingerprint + automation markers
 *   POST /gw/advance     finish step N -> token for N+1, or the completion token
 *   POST /gw/impression  ad impression / viewability beacon
 *   GET  /unlock/:token  delivery page (Telegram hand-off or destination redirect)
 *   GET  /out/:slot      house-ad click-out
 *
 * The countdown is enforced server-side against `visit_steps.entered_at`. The
 * client-side timer is presentation only; editing it in devtools does nothing.
 */

const express = require('express');
const config = require('../config');
const { q } = require('../db');
const { classify } = require('../lib/geo');
const fraud = require('../lib/fraud');
const revenue = require('../lib/revenue');
const campaigns = require('../lib/campaigns');
const ads = require('../lib/ads');
const tokens = require('../lib/tokens');
const telegram = require('../lib/telegram');
const promos = require('../lib/promos');
const { rateLimit } = require('../middleware');
const {
  now, randomToken, saltedHash, markdown, escapeHtml, isSafeUrl, hostOf,
} = require('../lib/util');

const router = express.Router();

const VISIT_COOKIE = 'lv_v';
const PROBE_COOKIE = 'lv_p';

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
router.get('/s/:code', rateLimit({ max: 90, windowMs: 60000, key: 'entry' }), (req, res) => {
  const code = String(req.params.code || '').trim();
  const link = q.get('SELECT * FROM links WHERE code = ?', code);

  if (!link) return renderStop(res, 404, 'Link not found', 'This short link does not exist, or it was removed.');
  if (link.status === 'blocked') {
    return renderStop(res, 410, 'Link disabled', 'This link was disabled by a moderator for a policy violation.');
  }
  if (link.status === 'paused') {
    return renderStop(res, 423, 'Link paused', 'The publisher has paused this link. Try again later.');
  }
  if (link.expires_at && link.expires_at < now()) {
    return renderStop(res, 410, 'Link expired', 'This link has passed its expiry date.');
  }
  if (link.max_clicks && link.clicks >= link.max_clicks) {
    return renderStop(res, 410, 'Click limit reached', 'This link hit the click limit its publisher set.');
  }

  const owner = q.get('SELECT id, status FROM users WHERE id = ?', link.user_id);
  if (!owner || owner.status === 'banned') {
    return renderStop(res, 410, 'Unavailable', 'The account behind this link is no longer active.');
  }

  const ctx = classify(req);
  const scored = fraud.scoreEntry(ctx, link);

  // Preview crawlers get a clean unfurl card and are never counted.
  if (ctx.isPreview) return renderUnfurl(res, link);

  const { campaign, steps } = campaigns.resolve(link, ctx);

  const visitKey = randomToken(18);
  const verdict = fraud.verdict(scored.score);
  const insert = q.run(
    `INSERT INTO visits (visit_key, link_id, publisher_id, campaign_id, ip_hash, ua, country, device, os, browser,
                         referer, step_count, step_reached, is_unique, is_valid, fraud_score, fraud_reasons, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
    visitKey, link.id, link.user_id, campaign.id, scored.ipHash, ctx.ua.slice(0, 400),
    ctx.country, ctx.device, ctx.os, ctx.browser, ctx.referer,
    steps.length, scored.isUnique ? 1 : 0, verdict === 'clean' ? 1 : 0,
    scored.score, JSON.stringify(scored.signals), now(),
  );
  const visit = q.get('SELECT * FROM visits WHERE id = ?', Number(insert.lastInsertRowid));

  q.run(
    `UPDATE links SET clicks = clicks + 1,
                      unique_clicks = unique_clicks + ?,
                      valid_visits = valid_visits + ?
     WHERE id = ?`,
    scored.isUnique ? 1 : 0, verdict === 'clean' ? 1 : 0, link.id,
  );
  revenue.rollupClick(visit);

  if (scored.signals.length) {
    fraud.logEvent({
      visitId: visit.id, userId: link.user_id, ipHash: scored.ipHash,
      reason: scored.signals.map((s) => s.key).join(','),
      severity: verdict === 'reject' ? 3 : verdict === 'review' ? 2 : 1,
      meta: { score: scored.score, country: ctx.country, device: ctx.device },
    });
  }

  // Hard-blocked traffic still reaches the destination — we just never pay for it.
  if (scored.blocked) {
    return finishImmediately(req, res, link, visit, 'blocked_traffic');
  }

  res.cookie(VISIT_COOKIE, visitKey, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 3600000, path: '/',
  });

  openStep(visit.id, 1);
  const token = tokens.issueStepToken({
    visitId: visit.id, linkId: link.id, step: 1, steps: steps.length, nonce: randomToken(6),
  });
  res.redirect(302, `/v/${token}`);


});

// ---------------------------------------------------------------------------
// Step rendering
// ---------------------------------------------------------------------------
router.get('/v/:token', (req, res) => {
  const parsed = tokens.readStepToken(req.params.token);
  if (!parsed) {
    return renderStop(res, 400, 'Session expired', 'This step link expired. Open the original short link again.');
  }

  const visit = q.get('SELECT * FROM visits WHERE id = ?', parsed.visitId);
  const link = q.get('SELECT * FROM links WHERE id = ?', parsed.linkId);
  if (!visit || !link) {
    return renderStop(res, 400, 'Session lost', 'We could not find this session. Open the short link again.');
  }

  const ctx = classify(req);
  const { steps, waitSeconds } = campaigns.resolve(link, ctx);
  const index = Math.max(1, Math.min(parsed.step, steps.length));
  const step = steps[index - 1];

  openStep(visit.id, index);
  if (index > visit.step_reached) {
    q.run('UPDATE visits SET step_reached = ? WHERE id = ?', index, visit.id);
  }

  const stepWait = Number(step.wait) > 0 ? Number(step.wait) : waitSeconds;
  const resource = link.resource_id ? q.get('SELECT * FROM resources WHERE id = ?', link.resource_id) : null;

  res.render('gateway/step', {
    layout: false,
    title: `${step.title} · ${config.brand.name}`,
    link,
    visit,
    resource,
    step,
    stepIndex: index,
    stepTotal: steps.length,
    stepWait,
    token: req.params.token,
    bodyHtml: markdown(step.body || ''),
    // Rendered individually so the template can place them: above the fold,
    // mid-article, then any remainder above the gate.
    adUnits: (step.slots || []).map((k) => ads.render(k, { step: index })).filter(Boolean),
    promosHtml: promos.block('gateway', { limit: 2, heading: 'Promoted' }),
    cheapestPromo: Math.min(...promos.packages().map((x) => x.price)) * 1_000_000,
    popup: ads.pickPopup('gateway'),
    popupCfg: ads.popupSettings(),
    adsHead: ads.headScript(),
    trending: q.all(
      "SELECT slug, title, excerpt, read_minutes FROM posts WHERE status = 'published' ORDER BY views DESC LIMIT 3",
    ),
    products: q.all("SELECT slug, name, tagline, badge FROM products WHERE status = 'active' ORDER BY sort LIMIT 2"),
  });
});

// ---------------------------------------------------------------------------
// Beacons
// ---------------------------------------------------------------------------
router.post('/gw/probe', express.json({ limit: '8kb' }), (req, res) => {
  const { visitKey, fp, headless, screen, tz, langs, touch } = req.body || {};
  const visit = visitKey ? q.get('SELECT * FROM visits WHERE visit_key = ?', String(visitKey)) : null;
  if (!visit) return res.status(204).end();

  q.run('UPDATE visits SET fp_hash = ? WHERE id = ?', saltedHash(fp || ''), visit.id);
  res.cookie(PROBE_COOKIE, '1', { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 3600000, path: '/' });

  if (headless) {
    fraud.logEvent({
      visitId: visit.id, userId: visit.publisher_id, ipHash: visit.ip_hash,
      reason: 'HEADLESS', severity: 3, meta: { screen, tz, langs, touch },
    });
  }
  // Same fingerprint across many visits in an hour is a strong duplicate-session tell.
  if (fp) {
    const dupes = q.scalar(
      'SELECT COUNT(*) FROM visits WHERE fp_hash = ? AND created_at > ? AND id != ?',
      saltedHash(fp), now() - 3600000, visit.id,
    ) || 0;
    if (dupes >= 10) {
      fraud.logEvent({
        visitId: visit.id, userId: visit.publisher_id, ipHash: visit.ip_hash,
        reason: 'DUP_FINGERPRINT', severity: 2, meta: { dupes },
      });
    }
  }
  res.json({ ok: true });
});

router.post('/gw/promo-view', express.json({ limit: '4kb' }), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 8).map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(204).end();

  // Attribute to the visit's real country/device so advertisers get a usable
  // breakdown rather than one bucket.
  const visit = req.body?.visitKey
    ? q.get('SELECT country, device FROM visits WHERE visit_key = ?', String(req.body.visitKey))
    : null;

  // Fall back to the request's own geo when the visit cannot be resolved, so a
  // dropped cookie degrades the attribution rather than losing it.
  const ctx = visit ? null : classify(req);
  promos.recordImpressions(ids, {
    surface: 'gateway',
    country: visit ? visit.country : ctx.country,
    device: visit ? visit.device : ctx.device,
  });
  res.status(204).end();
});

router.post('/gw/impression', express.json({ limit: '4kb' }), (req, res) => {
  const { visitKey, slot, step, viewable } = req.body || {};
  const visit = visitKey ? q.get('SELECT id FROM visits WHERE visit_key = ?', String(visitKey)) : null;
  if (slot) ads.recordImpression(visit?.id || null, String(slot).slice(0, 40), Number(step) || 0, viewable ? 1 : 0);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------
router.post('/gw/advance', express.json({ limit: '8kb' }), rateLimit({ max: 120, windowMs: 60000, key: 'advance' }), (req, res) => {
  const parsed = tokens.readStepToken(req.body?.token);
  if (!parsed) return res.status(400).json({ error: 'expired', message: 'Session expired. Reopen the short link.' });

  const visit = q.get('SELECT * FROM visits WHERE id = ?', parsed.visitId);
  const link = q.get('SELECT * FROM links WHERE id = ?', parsed.linkId);
  if (!visit || !link) return res.status(400).json({ error: 'not_found' });

  const ctx = classify(req);
  const { steps, waitSeconds, skipMode } = campaigns.resolve(link, ctx);
  const index = Math.max(1, Math.min(parsed.step, steps.length));
  const step = steps[index - 1];
  const stepWait = Number(step.wait) > 0 ? Number(step.wait) : waitSeconds;

  const row = q.get('SELECT * FROM visit_steps WHERE visit_id = ? AND step_index = ?', visit.id, index);
  if (!row) return res.status(400).json({ error: 'step_not_open' });

  // Replay guard. A step token stays signature-valid for its whole TTL, so a
  // client can post the same advance repeatedly. Re-running the final step must
  // never re-score or re-credit the visit — that would mint money. Hand back a
  // fresh unlock token (the previous one may legitimately have expired) and stop.
  if (visit.is_completed) {
    return res.json({ done: true, next: `/unlock/${tokens.issueCompletionToken({
      visitId: visit.id, linkId: link.id, resourceId: link.resource_id, code: link.code,
    })}` });
  }
  // Re-posting an already-finished intermediate step is idempotent: just hand
  // back the next step again rather than re-recording the dwell evidence.
  if (row.completed_at && index < steps.length) {
    return res.json({
      done: false,
      next: `/v/${tokens.issueStepToken({
        visitId: visit.id, linkId: link.id, step: index + 1, steps: steps.length, nonce: randomToken(6),
      })}`,
    });
  }

  const elapsedMs = now() - row.entered_at;
  const skippedVia = String(req.body?.skippedVia || '');
  const dwellMs = Math.min(Math.max(0, Number(req.body?.dwellMs) || 0), elapsedMs + 2000);
  const interactions = Math.max(0, Math.min(10000, Number(req.body?.interactions) || 0));
  const focusMs = Math.min(Math.max(0, Number(req.body?.focusMs) || 0), elapsedMs + 2000);

  // --- server-authoritative gate ---
  const waitedEnough = elapsedMs >= stepWait * 1000;
  let allowed = waitedEnough;
  let via = waitedEnough ? 'timer' : '';

  if (!allowed && skipMode !== 'none' && skippedVia) {
    const dwellOk = elapsedMs >= config.monetization.minDwellMs;
    if (skipMode === 'engagement' && skippedVia === 'engagement' && dwellOk && interactions > 0) {
      allowed = true; via = 'engagement';
    } else if (skipMode === 'ad_click' && skippedVia === 'ad' && dwellOk) {
      allowed = true; via = 'ad';
    }
  }

  if (!allowed) {
    return res.status(425).json({
      error: 'too_soon',
      remaining_ms: Math.max(0, stepWait * 1000 - elapsedMs),
      message: 'Still counting down.',
    });
  }

  q.run(
    'UPDATE visit_steps SET completed_at = ?, dwell_ms = ?, interactions = ?, focus_ms = ?, skipped_via = ? WHERE id = ?',
    now(), dwellMs, interactions, focusMs, via, row.id,
  );

  // --- more steps to go ---
  if (index < steps.length) {
    const next = index + 1;
    openStep(visit.id, next);
    q.run('UPDATE visits SET step_reached = MAX(step_reached, ?) WHERE id = ?', next, visit.id);
    return res.json({
      done: false,
      next: `/v/${tokens.issueStepToken({
        visitId: visit.id, linkId: link.id, step: next, steps: steps.length, nonce: randomToken(6),
      })}`,
    });
  }

  // --- final step: score, price, credit, issue completion token ---
  const completion = completeVisit(req, visit, link);
  return res.json({ done: true, next: `/unlock/${completion.token}` });
});

// ---------------------------------------------------------------------------
// Completion + delivery
// ---------------------------------------------------------------------------
function completeVisit(req, visit, link) {
  // Second line of defence: never price or credit the same visit twice, whatever
  // path got us here.
  if (visit.is_completed) {
    return {
      token: tokens.issueCompletionToken({
        visitId: visit.id, linkId: link.id, resourceId: link.resource_id, code: link.code,
      }),
      pricing: null,
      scored: null,
    };
  }

  const stepRows = q.all('SELECT * FROM visit_steps WHERE visit_id = ? ORDER BY step_index', visit.id);
  const scored = fraud.scoreCompletion(visit, {
    probeSeen: req.cookies?.[PROBE_COOKIE] === '1',
    headless: false,
    uaNow: String(req.get('user-agent') || '').slice(0, 400),
    ipHashNow: req.ipHash,
    steps: stepRows,
  });

  const pricing = revenue.priceVisit({
    country: visit.country, device: visit.device, fraudScore: scored.score,
  });

  q.run(
    `UPDATE visits SET is_completed = 1, completed_at = ?, fraud_score = ?, fraud_reasons = ?,
                       cpm_micros = ?, revenue_micros = ?, publisher_micros = ?, platform_micros = ?, referral_micros = ?,
                       is_valid = ?
     WHERE id = ?`,
    now(), scored.score, JSON.stringify(scored.signals),
    pricing.cpm_micros, pricing.gross_micros, pricing.publisher_micros,
    pricing.platform_micros, pricing.referral_micros,
    pricing.verdict === 'clean' ? 1 : 0, visit.id,
  );

  const fresh = q.get('SELECT * FROM visits WHERE id = ?', visit.id);
  revenue.creditVisit(fresh, pricing);
  if (pricing.verdict !== 'clean') fraud.refreshPublisherScore(visit.publisher_id);

  const token = tokens.issueCompletionToken({
    visitId: visit.id, linkId: link.id, resourceId: link.resource_id, code: link.code,
  });
  return { token, pricing, scored };
}

/** Blocked/bot traffic: mark the visit finished with zero value and pass through. */
function finishImmediately(req, res, link, visit, reason) {
  q.run(
    "UPDATE visits SET is_completed = 1, is_valid = 0, completed_at = ?, fraud_reasons = json_insert(fraud_reasons, '$[#]', json_object('key', ?, 'w', 0, 'label', ?)) WHERE id = ?",
    now(), reason, 'Passed through without monetization', visit.id,
  );
  if (link.resource_id) {
    return renderStop(res, 200, 'Verification required',
      'This request looked automated, so the file was not released. Open the link in a normal browser.');
  }
  if (isSafeUrl(link.destination)) return res.redirect(302, link.destination);
  return renderStop(res, 404, 'Nothing to deliver', 'This link has no destination configured.');
}

router.get('/unlock/:token', (req, res) => {
  const result = tokens.redeemCompletionToken(req.params.token, { consume: false });
  if (!result.ok) {
    return renderStop(res, 410, 'Unlock expired',
      'This unlock token is no longer valid. Open the short link again to get a fresh one.');
  }
  const link = q.get('SELECT * FROM links WHERE id = ?', result.record.link_id);
  const resource = link?.resource_id ? q.get('SELECT * FROM resources WHERE id = ?', link.resource_id) : null;

  let tgLink = null;
  if (resource && telegram.enabled) tgLink = telegram.deliveryLink(req.params.token);

  res.render('gateway/unlock', {
    layout: false,
    title: `Your file is ready · ${config.brand.name}`,
    link,
    resource,
    token: req.params.token,
    tgLink,
    destinationHost: hostOf(link?.destination || ''),
    telegramEnabled: telegram.enabled,
    adsHtml: ads.renderMany(['gw_unlock', 'gw_native_2'], { step: 99 }),
    promosHtml: promos.block('gateway', { limit: 3, heading: 'Promoted' }),
    adsHead: ads.headScript(),
    products: q.all("SELECT slug, name, tagline, badge FROM products WHERE status = 'active' ORDER BY sort LIMIT 3"),
    posts: q.all("SELECT slug, title, excerpt FROM posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 3"),
  });
});

/** The actual hand-off. Consumes a use of the token. */
router.get('/d/:token', rateLimit({ max: 30, windowMs: 60000, key: 'deliver' }), async (req, res) => {
  const result = tokens.redeemCompletionToken(req.params.token, { consume: true });
  if (!result.ok) {
    return renderStop(res, 410, 'Download expired', `This download token is no longer valid (${result.reason}).`);
  }
  const link = q.get('SELECT * FROM links WHERE id = ?', result.record.link_id);
  if (!link) return renderStop(res, 404, 'Gone', 'The link behind this download was removed.');

  if (link.resource_id) {
    const resource = q.get('SELECT * FROM resources WHERE id = ?', link.resource_id);
    if (!resource || resource.status !== 'ready') {
      return renderStop(res, 410, 'File unavailable', 'This file was removed or is under moderation review.');
    }
    q.run('UPDATE resources SET downloads = downloads + 1 WHERE id = ?', resource.id);

    // Delivered through the bot: the visitor opens Telegram, the bot verifies
    // the token again on its side before sending the bytes.
    const dl = telegram.enabled ? telegram.deliveryLink(req.params.token) : null;
    if (dl) return res.redirect(302, dl.url);

    return renderStop(res, 503, 'Delivery bot offline',
      'The media bot is not configured on this deployment, so the file cannot be sent. Contact the site owner.');
  }

  if (isSafeUrl(link.destination)) return res.redirect(302, link.destination);
  return renderStop(res, 404, 'Nothing to deliver', 'This link has no destination configured.');
});

// ---------------------------------------------------------------------------
// House ad click-out
// ---------------------------------------------------------------------------
router.get('/promo/:id', (req, res) => {
  const ctx = classify(req);
  const row = promos.recordClick(req.params.id, {
    surface: String(req.query.s || 'gateway'),
    country: ctx.country,
    device: ctx.device,
  });
  if (row && isSafeUrl(row.url)) {
    res.set('Referrer-Policy', 'no-referrer');
    return res.redirect(302, row.url);
  }
  return res.redirect(302, '/promote');
});

router.get('/out/:slot', (req, res) => {
  const row = ads.recordClick(String(req.params.slot).slice(0, 40));
  if (row && isSafeUrl(row.href)) {
    res.set('Referrer-Policy', 'no-referrer');
    return res.redirect(302, row.href);
  }
  return res.redirect(302, '/');
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function openStep(visitId, index) {
  const existing = q.get('SELECT id FROM visit_steps WHERE visit_id = ? AND step_index = ?', visitId, index);
  if (existing) return existing.id;
  const r = q.run(
    'INSERT INTO visit_steps (visit_id, step_index, entered_at) VALUES (?,?,?)',
    visitId, index, now(),
  );
  return Number(r.lastInsertRowid);
}

function renderStop(res, code, title, message) {
  return res.status(code).render('gateway/stop', {
    layout: false, title: `${title} · ${config.brand.name}`, heading: title, message, code,
  });
}

/** Minimal OG card for link-preview crawlers — no visit is recorded. */
function renderUnfurl(res, link) {
  const title = escapeHtml(link.title || 'Shared file');
  const desc = escapeHtml(link.description || 'Open to unlock this file.');
  res.set('Content-Type', 'text/html; charset=utf-8').send(
    `<!doctype html><html><head><meta charset="utf-8">
     <title>${title}</title>
     <meta property="og:title" content="${title}">
     <meta property="og:description" content="${desc}">
     <meta property="og:site_name" content="${escapeHtml(config.brand.name)}">
     <meta name="robots" content="noindex">
     </head><body>${title}</body></html>`,
  );
}

module.exports = router;
