'use strict';

/**
 * Revenue engine.
 *
 * IMPORTANT — on the numbers in the seeded rate card:
 * these are conservative placeholders, not a forecast. Real short-link CPM
 * varies enormously by country, device, traffic source, ad network, fill rate
 * and traffic quality, and published third-party CPM tables disagree with each
 * other. Replace every row in `rate_cards` with figures measured from your own
 * traffic and your own network's reporting before you promise a publisher
 * anything. `settings.revenue_disclaimer` is shown in the dashboard for this.
 *
 * Flow:
 *   advertiser revenue (CPM x fill)
 *        -> platform
 *            -> publisher share
 *            -> referrer share (taken from the platform's cut, not the publisher's)
 *            -> platform share
 */

const { q, settings } = require('../db');
const config = require('../config');
const { now, dayKey, clamp } = require('./util');
const fraud = require('./fraud');

/** Most specific matching rate-card row wins: country+device > country > device > wildcard. */
function rateFor(country, device) {
  const c = String(country || 'XX').toUpperCase();
  const d = String(device || 'desktop').toLowerCase();
  const row = q.get(
    `SELECT * FROM rate_cards
     WHERE active = 1
       AND (country = ? OR country = '*')
       AND (device  = ? OR device  = '*')
     ORDER BY (country = ?) DESC, (device = ?) DESC
     LIMIT 1`,
    c, d, c, d,
  );
  return row || { cpm_micros: 500_000, fill_rate: 0.85, country: '*', device: '*' };
}

function shares() {
  return {
    publisher: clamp(settings.get('publisher_share_pct', config.revenue.publisherSharePct), 0, 95),
    referral: clamp(settings.get('referral_share_pct', config.revenue.referralSharePct), 0, 50),
  };
}

/**
 * Price one completed visit.
 * Returns micros; a rejected visit prices at zero but is still recorded.
 */
function priceVisit({ country, device, fraudScore }) {
  const card = rateFor(country, device);
  const verdict = fraud.verdict(fraudScore);

  // CPM is per 1000 impressions, so one valid visit earns cpm/1000, scaled by fill.
  let gross = Math.round((card.cpm_micros / 1000) * card.fill_rate);

  if (verdict === 'reject') gross = 0;
  // Suspicious-but-not-rejected traffic is discounted rather than dropped, which
  // is what an ad network effectively does to you on low-quality inventory.
  else if (verdict === 'review') gross = Math.round(gross * 0.4);

  const s = shares();
  const publisher = Math.round(gross * (s.publisher / 100));
  const referral = Math.round(gross * (s.referral / 100));
  const platform = gross - publisher - referral;

  return {
    cpm_micros: card.cpm_micros,
    fill_rate: card.fill_rate,
    verdict,
    gross_micros: gross,
    publisher_micros: publisher,
    referral_micros: referral,
    platform_micros: Math.max(0, platform),
  };
}

/** Append to the immutable ledger. All balance movement goes through here. */
function ledger({ userId, kind, amountMicros, refType = '', refId = null, note = '' }) {
  if (!amountMicros) return;
  q.run(
    'INSERT INTO ledger (user_id, kind, amount_micros, ref_type, ref_id, note, created_at) VALUES (?,?,?,?,?,?,?)',
    userId, kind, amountMicros, refType, refId, note, now(),
  );
}

/**
 * Credit a completed visit. Earnings land in `pending_micros` and are released
 * to `balance_micros` by releaseMatured() after the hold window, so a fraud
 * sweep inside that window can still reverse them.
 */
function creditVisit(visit, pricing) {
  q.tx(() => {
    if (pricing.publisher_micros > 0) {
      q.run(
        'UPDATE users SET pending_micros = pending_micros + ? WHERE id = ?',
        pricing.publisher_micros, visit.publisher_id,
      );
      ledger({
        userId: visit.publisher_id,
        kind: 'earning',
        amountMicros: pricing.publisher_micros,
        refType: 'visit',
        refId: visit.id,
        note: `${visit.country}/${visit.device} @ CPM ${(pricing.cpm_micros / 1e6).toFixed(3)}`,
      });
    }

    if (pricing.referral_micros > 0) {
      const pub = q.get('SELECT referred_by FROM users WHERE id = ?', visit.publisher_id);
      if (pub && pub.referred_by) {
        q.run(
          'UPDATE users SET pending_micros = pending_micros + ?, ref_earn_micros = ref_earn_micros + ? WHERE id = ?',
          pricing.referral_micros, pricing.referral_micros, pub.referred_by,
        );
        ledger({
          userId: pub.referred_by,
          kind: 'referral',
          amountMicros: pricing.referral_micros,
          refType: 'visit',
          refId: visit.id,
          note: `Referral from user #${visit.publisher_id}`,
        });
      }
    }

    q.run(
      `UPDATE links SET completed_visits = completed_visits + 1,
                        revenue_micros = revenue_micros + ?
       WHERE id = ?`,
      pricing.gross_micros, visit.link_id,
    );

    rollupDaily(visit, pricing);
  });
}

function rollupDaily(visit, pricing) {
  const day = dayKey(visit.created_at);
  for (const [linkId, country, device] of [
    [visit.link_id, visit.country, visit.device],
    [0, '*', '*'], // publisher totals row
  ]) {
    q.run(
      `INSERT INTO daily_stats (day, user_id, link_id, country, device,
                                clicks, unique_clicks, valid_visits, completed_visits,
                                revenue_micros, publisher_micros)
       VALUES (?,?,?,?,?,0,0,0,1,?,?)
       ON CONFLICT(day, user_id, link_id, country, device) DO UPDATE SET
         completed_visits = completed_visits + 1,
         revenue_micros   = revenue_micros + excluded.revenue_micros,
         publisher_micros = publisher_micros + excluded.publisher_micros`,
      day, visit.publisher_id, linkId, country, device,
      pricing.gross_micros, pricing.publisher_micros,
    );
  }
}

/** Called on entry so clicks/uniques show up immediately, before completion. */
function rollupClick(visit) {
  const day = dayKey(visit.created_at);
  for (const [linkId, country, device] of [
    [visit.link_id, visit.country, visit.device],
    [0, '*', '*'],
  ]) {
    q.run(
      `INSERT INTO daily_stats (day, user_id, link_id, country, device,
                                clicks, unique_clicks, valid_visits, completed_visits, revenue_micros, publisher_micros)
       VALUES (?,?,?,?,?,1,?,?,0,0,0)
       ON CONFLICT(day, user_id, link_id, country, device) DO UPDATE SET
         clicks        = clicks + 1,
         unique_clicks = unique_clicks + excluded.unique_clicks,
         valid_visits  = valid_visits  + excluded.valid_visits`,
      day, visit.publisher_id, linkId, country, device,
      visit.is_unique ? 1 : 0, visit.is_valid ? 1 : 0,
    );
  }
}

/** Move matured pending earnings into the withdrawable balance. */
function releaseMatured() {
  const cutoff = now() - config.revenue.holdHours * 3600000;
  // ref_type is flipped to 'visit_released' at the end of this function, so a
  // row is only ever picked up by one pass.
  const rows = q.all(
    `SELECT user_id, SUM(amount_micros) AS amt
     FROM ledger
     WHERE kind IN ('earning','referral') AND created_at < ? AND ref_type = 'visit'
     GROUP BY user_id`,
    cutoff,
  );
  let released = 0;
  for (const r of rows) {
    if (!r.amt) continue;
    q.tx(() => {
      q.run(
        'UPDATE users SET pending_micros = MAX(0, pending_micros - ?), balance_micros = balance_micros + ? WHERE id = ?',
        r.amt, r.amt, r.user_id,
      );
      ledger({ userId: r.user_id, kind: 'release', amountMicros: r.amt, refType: 'batch', note: 'Hold window elapsed' });
    });
    released += r.amt;
  }
  // Mark the matured rows so they are not released twice.
  q.run(
    `UPDATE ledger SET ref_type = 'visit_released'
     WHERE kind IN ('earning','referral') AND created_at < ? AND ref_type = 'visit'`,
    cutoff,
  );
  return released;
}

/** Reverse a visit's earnings after a fraud sweep. */
function reverseVisit(visitId, note = 'Fraud reversal') {
  const rows = q.all(
    "SELECT * FROM ledger WHERE ref_id = ? AND ref_type LIKE 'visit%' AND kind IN ('earning','referral')",
    visitId,
  );
  for (const row of rows) {
    q.tx(() => {
      const isPending = row.ref_type === 'visit';
      if (isPending) {
        q.run('UPDATE users SET pending_micros = MAX(0, pending_micros - ?) WHERE id = ?', row.amount_micros, row.user_id);
      } else {
        q.run('UPDATE users SET balance_micros = MAX(0, balance_micros - ?) WHERE id = ?', row.amount_micros, row.user_id);
      }
      ledger({
        userId: row.user_id, kind: 'reversal', amountMicros: -row.amount_micros,
        refType: 'visit', refId: visitId, note,
      });
    });
  }
  q.run('UPDATE visits SET publisher_micros = 0, referral_micros = 0 WHERE id = ?', visitId);
  return rows.length;
}

/** Estimated eCPM a publisher is actually realising, in micros. */
function effectiveCpm(userId, days = 30) {
  const since = dayKey(now() - days * 86400000);
  const row = q.get(
    `SELECT SUM(valid_visits) AS v, SUM(publisher_micros) AS m
     FROM daily_stats WHERE user_id = ? AND link_id = 0 AND day >= ?`,
    userId, since,
  );
  if (!row || !row.v) return 0;
  return Math.round((row.m / row.v) * 1000);
}

module.exports = {
  rateFor, shares, priceVisit, creditVisit, rollupClick, rollupDaily,
  releaseMatured, reverseVisit, ledger, effectiveCpm,
};
