'use strict';

/**
 * Paid promotions.
 *
 * Advertisers pay a small flat fee to have a blog post or a YouTube video shown
 * on the site — inside the gateway steps, alongside articles, or across both.
 * This is distinct from `ads.js`, which handles network ad units: a promotion is
 * a piece of *our own* inventory that we sold directly.
 *
 * Disclosure is not optional. Every promoted item renders with a visible
 * "Promoted" label and its outbound link carries rel="sponsored nofollow", which
 * is what both Google's paid-link guidelines and consumer-protection rules
 * expect. That is enforced here rather than left to the templates.
 */

const { q, settings } = require('../db');
const { now, escapeHtml, weightedPick, toMicros, isSafeUrl, dayKey, lastDays } = require('./util');

/** Default packages. Operators can override the whole set in settings. */
const DEFAULT_PACKAGES = [
  {
    key: 'starter',
    name: 'Starter',
    price: 5,
    days: 7,
    placement: 'blog',
    weight: 8,
    blurb: 'One placement across our blog and article pages for a week.',
    perks: ['Shown on all blog + article pages', '7 days live', 'Click tracking', 'Do-follow disclosure compliant'],
  },
  {
    key: 'spotlight',
    name: 'Spotlight',
    price: 15,
    days: 14,
    placement: 'gateway',
    weight: 14,
    blurb: 'Placement inside the link flow, where our highest-intent traffic is.',
    perks: ['Shown inside every link step', 'Highest traffic surface', '14 days live', 'Click + impression reporting'],
    featured: true,
  },
  {
    key: 'takeover',
    name: 'Takeover',
    price: 35,
    days: 30,
    placement: 'everywhere',
    weight: 22,
    blurb: 'Everywhere we have inventory, for a month, at top rotation weight.',
    perks: ['Every surface: link flow, blog, site', 'Top rotation priority', '30 days live', 'YouTube embed supported', 'Full reporting'],
  },
];

function packages() {
  const custom = settings.get('promo_packages', null);
  if (Array.isArray(custom) && custom.length) return custom;
  return DEFAULT_PACKAGES;
}

function packageByKey(key) {
  return packages().find((p) => p.key === key) || null;
}

// --- selection ---------------------------------------------------------------
let cache = null;
let cacheAt = 0;

function live() {
  if (cache && now() - cacheAt < 20000) return cache;
  cache = q.all(
    `SELECT * FROM promotions
     WHERE status = 'active' AND paid = 1
       AND (starts_at IS NULL OR starts_at <= ?)
       AND (ends_at   IS NULL OR ends_at   >  ?)
     ORDER BY weight DESC, id DESC`,
    now(), now(),
  );
  cacheAt = now();
  return cache;
}
function invalidate() { cache = null; }

function forPlacement(placement, limit = 3) {
  const pool = live().filter((p) => p.placement === placement || p.placement === 'everywhere');
  const picked = [];
  const seen = new Set();
  // Weighted pick without replacement, so a high-weight promo does not fill every slot.
  const remaining = [...pool];
  while (picked.length < limit && remaining.length) {
    const choice = weightedPick(remaining, (p) => p.weight || 1);
    if (!choice) break;
    remaining.splice(remaining.indexOf(choice), 1);
    if (seen.has(choice.id)) continue;
    seen.add(choice.id);
    picked.push(choice);
  }
  return picked;
}

// --- rendering ---------------------------------------------------------------

/**
 * One promoted card. Always labelled, always rel="sponsored nofollow".
 * @param {object} p       the promotion row
 * @param {string} surface where it is being rendered, for click attribution
 */
function card(p, surface = 'gateway') {
  const href = `/promo/${p.id}?s=${encodeURIComponent(surface)}`;
  const label = '<span class="promo-tag">Promoted</span>';

  if (p.kind === 'youtube' && p.youtube_id) {
    return `<div class="promo promo-video" data-promo="${p.id}">
      <div class="promo-head">${label}<span class="promo-by">${escapeHtml(p.advertiser || '')}</span></div>
      <div class="video-frame">
        <iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(p.youtube_id)}?rel=0&modestbranding=1"
          title="${escapeHtml(p.title)}" loading="lazy" allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"></iframe>
      </div>
      <div class="promo-body">
        <strong>${escapeHtml(p.title)}</strong>
        ${p.blurb ? `<p>${escapeHtml(p.blurb)}</p>` : ''}
        ${p.url ? `<a class="promo-cta" href="${href}" target="_blank" rel="sponsored nofollow noopener">${escapeHtml(p.cta || 'Watch on YouTube')} →</a>` : ''}
      </div>
    </div>`;
  }

  return `<a class="promo promo-card" data-promo="${p.id}" href="${href}" target="_blank" rel="sponsored nofollow noopener">
    <div class="promo-head">${label}<span class="promo-by">${escapeHtml(p.advertiser || '')}</span></div>
    <div class="promo-row">
      ${p.image
    ? `<img class="promo-thumb" src="${escapeHtml(p.image)}" alt="" loading="lazy">`
    : `<div class="promo-thumb promo-thumb-mark">${p.kind === 'youtube' ? '▶' : p.kind === 'product' ? '▣' : '✦'}</div>`}
      <div class="promo-copy">
        <strong>${escapeHtml(p.title)}</strong>
        ${p.blurb ? `<span>${escapeHtml(p.blurb)}</span>` : ''}
      </div>
    </div>
    <span class="promo-cta">${escapeHtml(p.cta || 'Read more')} →</span>
  </a>`;
}

/** A labelled block of promoted cards, or '' when nothing is live. */
function block(placement, { limit = 2, heading = 'Promoted' } = {}) {
  const list = forPlacement(placement, limit);
  if (!list.length) return '';
  // 'everywhere' promos are attributed to the surface they actually rendered on.
  const surface = ['gateway', 'blog', 'site'].includes(placement) ? placement : 'gateway';
  return `<section class="promo-block" aria-label="Promoted content">
    <div class="promo-block-head"><span class="upper">${escapeHtml(heading)}</span>
      <a class="promo-block-link" href="/promote">Promote yours →</a></div>
    <div class="promo-grid">${list.map((x) => card(x, surface)).join('')}</div>
  </section>`;
}

// --- tracking ----------------------------------------------------------------

/**
 * Record impressions against the daily rollup as well as the lifetime counter.
 * @param {number[]} ids
 * @param {object}  ctx  { surface, country, device }
 */
function recordImpressions(ids, ctx = {}) {
  const day = dayKey();
  const surface = ['gateway', 'blog', 'site'].includes(ctx.surface) ? ctx.surface : 'gateway';
  const country = String(ctx.country || 'XX').toUpperCase().slice(0, 2) || 'XX';
  const device = String(ctx.device || 'unknown').slice(0, 12);

  for (const raw of ids) {
    const id = Number(raw);
    if (!id) continue;
    q.run('UPDATE promotions SET impressions = impressions + 1 WHERE id = ?', id);
    q.run(
      `INSERT INTO promo_stats (day, promo_id, surface, country, device, impressions, clicks)
       VALUES (?,?,?,?,?,1,0)
       ON CONFLICT(day, promo_id, surface, country, device)
       DO UPDATE SET impressions = impressions + 1`,
      day, id, surface, country, device,
    );
  }
}

function recordClick(id, ctx = {}) {
  const promoId = Number(id);
  if (!promoId) return null;

  const day = dayKey();
  const surface = ['gateway', 'blog', 'site'].includes(ctx.surface) ? ctx.surface : 'gateway';
  const country = String(ctx.country || 'XX').toUpperCase().slice(0, 2) || 'XX';
  const device = String(ctx.device || 'unknown').slice(0, 12);

  q.run('UPDATE promotions SET clicks = clicks + 1 WHERE id = ?', promoId);
  q.run(
    `INSERT INTO promo_stats (day, promo_id, surface, country, device, impressions, clicks)
     VALUES (?,?,?,?,?,0,1)
     ON CONFLICT(day, promo_id, surface, country, device)
     DO UPDATE SET clicks = clicks + 1`,
    day, promoId, surface, country, device,
  );
  return q.get("SELECT url FROM promotions WHERE id = ? AND status = 'active'", promoId);
}

// --- analytics ---------------------------------------------------------------

/** Day-by-day series for one campaign, zero-filled. */
function series(promoId, days = 30) {
  const since = dayKey(now() - (days - 1) * 86400000);
  const rows = q.all(
    `SELECT day, SUM(impressions) AS impressions, SUM(clicks) AS clicks
     FROM promo_stats WHERE promo_id = ? AND day >= ? GROUP BY day ORDER BY day`,
    promoId, since,
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return lastDays(days).map((day) => {
    const r = byDay.get(day) || {};
    return {
      day,
      label: day.slice(5),
      impressions: r.impressions || 0,
      clicks: r.clicks || 0,
    };
  });
}

/** Totals for one campaign over a window. */
function totals(promoId, days = 30) {
  const since = dayKey(now() - (days - 1) * 86400000);
  const row = q.get(
    `SELECT COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks
     FROM promo_stats WHERE promo_id = ? AND day >= ?`,
    promoId, since,
  ) || { impressions: 0, clicks: 0 };
  row.ctr = row.impressions ? row.clicks / row.impressions : 0;
  return row;
}

/** Breakdown by country, device or surface. */
function breakdown(promoId, field, days = 30, limit = 12) {
  if (!['country', 'device', 'surface'].includes(field)) throw new Error('bad breakdown field');
  const since = dayKey(now() - (days - 1) * 86400000);
  return q.all(
    `SELECT ${field} AS key, SUM(impressions) AS impressions, SUM(clicks) AS clicks
     FROM promo_stats WHERE promo_id = ? AND day >= ?
     GROUP BY ${field} ORDER BY impressions DESC LIMIT ?`,
    promoId, since, limit,
  );
}

/** Account-level rollup across every campaign a user owns. */
function accountSeries(userId, days = 30) {
  const since = dayKey(now() - (days - 1) * 86400000);
  const rows = q.all(
    `SELECT ps.day, SUM(ps.impressions) AS impressions, SUM(ps.clicks) AS clicks
     FROM promo_stats ps JOIN promotions p ON p.id = ps.promo_id
     WHERE p.user_id = ? AND ps.day >= ? GROUP BY ps.day ORDER BY ps.day`,
    userId, since,
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return lastDays(days).map((day) => {
    const r = byDay.get(day) || {};
    return { day, label: day.slice(5), impressions: r.impressions || 0, clicks: r.clicks || 0 };
  });
}

function accountTotals(userId, days = 30) {
  const since = dayKey(now() - (days - 1) * 86400000);
  const row = q.get(
    `SELECT COALESCE(SUM(ps.impressions),0) AS impressions, COALESCE(SUM(ps.clicks),0) AS clicks
     FROM promo_stats ps JOIN promotions p ON p.id = ps.promo_id
     WHERE p.user_id = ? AND ps.day >= ?`,
    userId, since,
  ) || { impressions: 0, clicks: 0 };
  row.ctr = row.impressions ? row.clicks / row.impressions : 0;
  return row;
}

// --- credit + campaign lifecycle ---------------------------------------------

/** Shape a promotion row for an API response. */
function publicCampaign(p, extra = {}) {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    blurb: p.blurb,
    url: p.url,
    youtube_id: p.youtube_id || null,
    image: p.image || null,
    cta: p.cta,
    package: p.package,
    placement: p.placement,
    price_usd: Number((p.price_micros / 1e6).toFixed(2)),
    days: p.days,
    status: p.status,
    paid: Boolean(p.paid),
    starts_at: p.starts_at,
    ends_at: p.ends_at,
    impressions: p.impressions,
    clicks: p.clicks,
    ctr: p.impressions ? Number((p.clicks / p.impressions).toFixed(4)) : 0,
    created_at: p.created_at,
    ...extra,
  };
}

/**
 * Charge a user's prepaid ad credit for a campaign.
 * Returns { ok } or { ok:false, error, shortfall_usd }.
 */
function charge(userId, priceMicros, promoId) {
  const user = q.get('SELECT ad_credit_micros FROM users WHERE id = ?', userId);
  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.ad_credit_micros < priceMicros) {
    return {
      ok: false,
      error: 'insufficient_credit',
      shortfall_usd: Number(((priceMicros - user.ad_credit_micros) / 1e6).toFixed(2)),
    };
  }
  q.tx(() => {
    q.run(
      'UPDATE users SET ad_credit_micros = ad_credit_micros - ?, ad_spend_micros = ad_spend_micros + ? WHERE id = ?',
      priceMicros, priceMicros, userId,
    );
    q.run('UPDATE promotions SET paid = 1 WHERE id = ?', promoId);
    q.run(
      'INSERT INTO ledger (user_id, kind, amount_micros, ref_type, ref_id, note, created_at) VALUES (?,?,?,?,?,?,?)',
      userId, 'ad_spend', -priceMicros, 'promotion', promoId, 'Campaign funded from ad credit', now(),
    );
  });
  return { ok: true };
}

/** Return a campaign's spend to the advertiser's credit (rejection, cancellation). */
function refund(promoId, note = 'Campaign refunded') {
  const p = q.get('SELECT * FROM promotions WHERE id = ?', promoId);
  if (!p || !p.paid || !p.user_id) return false;
  q.tx(() => {
    q.run(
      'UPDATE users SET ad_credit_micros = ad_credit_micros + ?, ad_spend_micros = MAX(0, ad_spend_micros - ?) WHERE id = ?',
      p.price_micros, p.price_micros, p.user_id,
    );
    q.run('UPDATE promotions SET paid = 0 WHERE id = ?', promoId);
    q.run(
      'INSERT INTO ledger (user_id, kind, amount_micros, ref_type, ref_id, note, created_at) VALUES (?,?,?,?,?,?,?)',
      p.user_id, 'ad_refund', p.price_micros, 'promotion', promoId, note, now(),
    );
  });
  invalidate();
  return true;
}

/** Add prepaid credit to an account (admin action, or a payment webhook). */
function topUp(userId, micros, note = 'Ad credit top-up') {
  if (!micros || micros <= 0) return false;
  q.tx(() => {
    q.run('UPDATE users SET ad_credit_micros = ad_credit_micros + ? WHERE id = ?', micros, userId);
    q.run(
      'INSERT INTO ledger (user_id, kind, amount_micros, ref_type, note, created_at) VALUES (?,?,?,?,?,?)',
      userId, 'ad_credit', micros, 'topup', note, now(),
    );
  });
  return true;
}

// --- lifecycle ---------------------------------------------------------------

/** Move paid+approved promos to active, and expire the ones past their end date. */
function sweep() {
  const t = now();
  q.run(
    `UPDATE promotions SET status = 'active', starts_at = COALESCE(starts_at, ?), ends_at = COALESCE(ends_at, ? + days * 86400000)
     WHERE status = 'approved' AND paid = 1`,
    t, t,
  );
  const expired = q.run(
    "UPDATE promotions SET status = 'expired' WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ?",
    t,
  );
  invalidate();
  return Number(expired.changes || 0);
}

/** Validate an advertiser submission. Returns { ok, error, data }. */
function validateSubmission(body) {
  const kind = ['blog', 'youtube', 'product', 'link'].includes(body.kind) ? body.kind : 'blog';
  const pkg = packageByKey(String(body.package || ''));
  if (!pkg) return { ok: false, error: 'Choose a promotion package.' };

  const title = String(body.title || '').trim();
  if (title.length < 4 || title.length > 140) return { ok: false, error: 'Title must be 4-140 characters.' };

  const url = String(body.url || '').trim();
  let youtubeId = '';

  if (kind === 'youtube') {
    youtubeId = extractYouTubeId(body.youtube_id || url);
    if (!youtubeId) return { ok: false, error: 'Paste a valid YouTube video URL or ID.' };
  }
  if (kind !== 'youtube' || url) {
    if (!isSafeUrl(url)) return { ok: false, error: 'Enter a valid public http(s) URL.' };
  }

  const email = String(body.email || '').trim();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) return { ok: false, error: 'Enter a valid contact email.' };

  const image = String(body.image || '').trim();
  if (image && !isSafeUrl(image)) return { ok: false, error: 'Image URL must be a public http(s) URL.' };

  return {
    ok: true,
    data: {
      kind,
      title,
      blurb: String(body.blurb || '').trim().slice(0, 300),
      url,
      youtube_id: youtubeId,
      image,
      cta: String(body.cta || '').trim().slice(0, 40) || (kind === 'youtube' ? 'Watch now' : 'Read more'),
      advertiser: String(body.advertiser || '').trim().slice(0, 80),
      email,
      note: String(body.note || '').trim().slice(0, 500),
      package: pkg.key,
      placement: pkg.placement,
      price_micros: toMicros(pkg.price),
      days: pkg.days,
      weight: pkg.weight || 10,
    },
  };
}

/** Accepts a full URL, a youtu.be link, an embed URL, or a bare id. */
function extractYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

module.exports = {
  DEFAULT_PACKAGES, packages, packageByKey,
  live, forPlacement, card, block, invalidate,
  recordImpressions, recordClick, sweep,
  validateSubmission, extractYouTubeId,
  series, totals, breakdown, accountSeries, accountTotals,
  publicCampaign, charge, refund, topUp,
};
