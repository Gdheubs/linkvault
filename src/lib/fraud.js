'use strict';

/**
 * Anti-fraud engine.
 *
 * Two scoring passes:
 *   scoreEntry()      — at /s/:code, before the flow starts (cheap signals)
 *   scoreCompletion() — at the end, using the timing/interaction evidence the
 *                       gateway collected across the steps
 *
 * Score is 0-100. config.fraud.reviewScore holds earnings; rejectScore pays zero.
 * Every signal is additive and named so the admin panel can explain a decision.
 */

const { q } = require('../db');
const config = require('../config');
const { now, saltedHash, parseJson } = require('./util');

const SIGNALS = {
  BOT_UA:            { w: 70, label: 'Bot / automation user-agent' },
  PREVIEW_UA:        { w: 100, label: 'Link-preview crawler (never paid)' },
  EMPTY_UA:          { w: 45, label: 'Missing user-agent' },
  NO_ACCEPT_LANG:    { w: 20, label: 'No Accept-Language header' },
  NOT_HTML:          { w: 25, label: 'Client did not request HTML' },
  BLOCKED_IP:        { w: 100, label: 'IP on blocklist' },
  BLOCKED_COUNTRY:   { w: 100, label: 'Country on blocklist' },
  BLOCKED_UA:        { w: 100, label: 'User-agent pattern on blocklist' },
  BLOCKED_REFERER:   { w: 60, label: 'Referring domain on blocklist' },
  IP_BURST_MIN:      { w: 40, label: 'IP burst: too many visits this minute' },
  IP_BURST_HOUR:     { w: 30, label: 'IP burst: too many visits this hour' },
  IP_LINK_SPRAY:     { w: 35, label: 'One IP hitting many links of one publisher' },
  REPEAT_CLICK:      { w: 25, label: 'Repeat click on same link inside cooldown' },
  SELF_TRAFFIC:      { w: 45, label: 'Traffic pattern matches the publisher themselves' },
  DUP_FINGERPRINT:   { w: 30, label: 'Same device fingerprint across many sessions' },
  NO_JS:             { w: 50, label: 'No JavaScript probe received' },
  HEADLESS:          { w: 55, label: 'Headless browser markers' },
  IMPOSSIBLE_SPEED:  { w: 60, label: 'Completed faster than a human can read' },
  LOW_DWELL:         { w: 35, label: 'Step dwell below minimum' },
  NO_INTERACTION:    { w: 25, label: 'Zero pointer/keyboard interaction' },
  NO_FOCUS:          { w: 30, label: 'Tab never held focus' },
  STEP_SKIPPED:      { w: 45, label: 'Step order violated' },
  UA_MISMATCH:       { w: 40, label: 'User-agent changed mid-flow' },
  IP_MISMATCH:       { w: 20, label: 'IP changed mid-flow' },
  PUB_ANOMALY:       { w: 25, label: 'Publisher completion rate is statistically abnormal' },
  PUB_FLAGGED:       { w: 30, label: 'Publisher under fraud review' },
};

function add(list, key, extra) {
  const sig = SIGNALS[key];
  if (!sig) return;
  list.push({ key, w: sig.w, label: sig.label, ...(extra ? { detail: extra } : {}) });
}

function total(signals) {
  return Math.min(100, signals.reduce((s, x) => s + x.w, 0));
}

// --- blocklist (cached; admin writes bump the version) -----------------------
let blockCache = null;
let blockCacheAt = 0;
function blocklist() {
  if (blockCache && now() - blockCacheAt < 30000) return blockCache;
  const rows = q.all('SELECT kind, value FROM blocklist');
  blockCache = {
    ip: new Set(rows.filter((r) => r.kind === 'ip').map((r) => r.value)),
    iprange: rows.filter((r) => r.kind === 'iprange').map((r) => r.value),
    country: new Set(rows.filter((r) => r.kind === 'country').map((r) => r.value.toUpperCase())),
    domain: rows.filter((r) => r.kind === 'domain').map((r) => r.value.toLowerCase()),
    ua: rows.filter((r) => r.kind === 'ua').map((r) => r.value.toLowerCase()),
  };
  blockCacheAt = now();
  return blockCache;
}
function invalidateBlocklist() { blockCache = null; }

function ipInRange(ip, prefix) {
  return String(ip).startsWith(String(prefix).replace(/\*+$/, ''));
}

// --- entry scoring -----------------------------------------------------------

/**
 * @param {object} ctx  from geo.classify()
 * @param {object} link the link row
 * @returns {{score:number, signals:Array, blocked:boolean}}
 */
function scoreEntry(ctx, link) {
  const signals = [];
  const bl = blocklist();
  const ipHash = saltedHash(ctx.ip);

  if (ctx.isPreview) add(signals, 'PREVIEW_UA', ctx.ua.slice(0, 80));
  else if (ctx.isBot) add(signals, 'BOT_UA', ctx.ua.slice(0, 80));
  if (ctx.empty) add(signals, 'EMPTY_UA');
  if (!ctx.lang) add(signals, 'NO_ACCEPT_LANG');
  if (!ctx.acceptsHtml) add(signals, 'NOT_HTML');

  if (bl.ip.has(ctx.ip) || bl.iprange.some((r) => ipInRange(ctx.ip, r))) add(signals, 'BLOCKED_IP');
  if (bl.country.has(ctx.country)) add(signals, 'BLOCKED_COUNTRY', ctx.country);
  if (bl.ua.some((p) => ctx.ua.toLowerCase().includes(p))) add(signals, 'BLOCKED_UA');
  if (ctx.referer) {
    const host = (() => { try { return new URL(ctx.referer).hostname.toLowerCase(); } catch { return ''; } })();
    if (host && bl.domain.some((d) => host === d || host.endsWith(`.${d}`))) {
      add(signals, 'BLOCKED_REFERER', host);
    }
  }

  const minAgo = now() - 60000;
  const hourAgo = now() - 3600000;
  const perMin = q.scalar('SELECT COUNT(*) FROM visits WHERE ip_hash = ? AND created_at > ?', ipHash, minAgo) || 0;
  const perHour = q.scalar('SELECT COUNT(*) FROM visits WHERE ip_hash = ? AND created_at > ?', ipHash, hourAgo) || 0;
  if (perMin >= config.fraud.ipVisitsPerMin) add(signals, 'IP_BURST_MIN', `${perMin}/min`);
  if (perHour >= config.fraud.ipVisitsPerHour) add(signals, 'IP_BURST_HOUR', `${perHour}/hr`);

  const distinctLinks = q.scalar(
    'SELECT COUNT(DISTINCT link_id) FROM visits WHERE ip_hash = ? AND publisher_id = ? AND created_at > ?',
    ipHash, link.user_id, hourAgo,
  ) || 0;
  if (distinctLinks >= 8) add(signals, 'IP_LINK_SPRAY', `${distinctLinks} links/hr`);

  const cooldown = now() - config.fraud.uniqueWindowHours * 3600000;
  const repeats = q.scalar(
    'SELECT COUNT(*) FROM visits WHERE ip_hash = ? AND link_id = ? AND created_at > ?',
    ipHash, link.id, cooldown,
  ) || 0;
  if (repeats > 0) add(signals, 'REPEAT_CLICK', `${repeats} prior`);

  // Publisher clicking their own links: same IP that recently held a session for them.
  const ownSession = q.scalar(
    'SELECT COUNT(*) FROM sessions WHERE user_id = ? AND ip_hash = ? AND created_at > ?',
    link.user_id, ipHash, now() - 7 * 86400000,
  ) || 0;
  if (ownSession > 0) add(signals, 'SELF_TRAFFIC');

  const publisher = q.get('SELECT fraud_score FROM users WHERE id = ?', link.user_id);
  if (publisher && publisher.fraud_score >= 50) add(signals, 'PUB_FLAGGED', `score ${publisher.fraud_score}`);

  const score = total(signals);
  return {
    score,
    signals,
    ipHash,
    isUnique: repeats === 0,
    blocked: signals.some((s) => s.w >= 100),
  };
}

// --- completion scoring ------------------------------------------------------

/**
 * @param {object} visit    the visit row
 * @param {object} evidence { probeSeen, headless, uaNow, ipHashNow, steps:[{dwell_ms,interactions,focus_ms}] }
 */
function scoreCompletion(visit, evidence) {
  const signals = parseJson(visit.fraud_reasons, []).map((s) => ({ ...s }));
  const steps = evidence.steps || [];

  if (!evidence.probeSeen) add(signals, 'NO_JS');
  if (evidence.headless) add(signals, 'HEADLESS');
  if (evidence.uaNow && visit.ua && evidence.uaNow !== visit.ua) add(signals, 'UA_MISMATCH');
  if (evidence.ipHashNow && evidence.ipHashNow !== visit.ip_hash) add(signals, 'IP_MISMATCH');

  const elapsed = now() - visit.created_at;
  if (elapsed < config.fraud.minHumanCompletionMs) add(signals, 'IMPOSSIBLE_SPEED', `${elapsed}ms`);

  const totalDwell = steps.reduce((s, x) => s + (x.dwell_ms || 0), 0);
  const totalInteractions = steps.reduce((s, x) => s + (x.interactions || 0), 0);
  const totalFocus = steps.reduce((s, x) => s + (x.focus_ms || 0), 0);

  if (steps.length && totalDwell < config.monetization.minDwellMs * steps.length) {
    add(signals, 'LOW_DWELL', `${totalDwell}ms over ${steps.length} steps`);
  }
  if (totalInteractions === 0) add(signals, 'NO_INTERACTION');
  if (totalFocus === 0) add(signals, 'NO_FOCUS');
  if (visit.step_reached < visit.step_count) add(signals, 'STEP_SKIPPED');

  // Publisher-level anomaly: implausibly perfect completion at volume.
  const stats = q.get(
    `SELECT COUNT(*) AS n, SUM(is_completed) AS done
     FROM visits WHERE publisher_id = ? AND created_at > ?`,
    visit.publisher_id, now() - 86400000,
  );
  if (stats && stats.n >= config.fraud.publisherAnomalyMinVisits) {
    const rate = (stats.done || 0) / stats.n;
    if (rate > 0.95) add(signals, 'PUB_ANOMALY', `${(rate * 100).toFixed(1)}% completion`);
  }

  // De-duplicate: entry signals may repeat.
  const seen = new Set();
  const merged = signals.filter((s) => (seen.has(s.key) ? false : seen.add(s.key)));
  return { score: total(merged), signals: merged };
}

function verdict(score) {
  if (score >= config.fraud.rejectScore) return 'reject';
  if (score >= config.fraud.reviewScore) return 'review';
  return 'clean';
}

function logEvent({ visitId = null, userId = null, ipHash = '', reason, severity = 1, meta = {} }) {
  q.run(
    'INSERT INTO fraud_events (visit_id, user_id, ip_hash, reason, severity, meta, created_at) VALUES (?,?,?,?,?,?,?)',
    visitId, userId, ipHash, reason, severity, JSON.stringify(meta), now(),
  );
}

/** Recompute a publisher's rolling fraud score (0-100) from the last 7 days. */
function refreshPublisherScore(userId) {
  const since = now() - 7 * 86400000;
  const row = q.get(
    `SELECT COUNT(*) AS n,
            AVG(fraud_score) AS avg_score,
            SUM(CASE WHEN fraud_score >= ? THEN 1 ELSE 0 END) AS rejected
     FROM visits WHERE publisher_id = ? AND created_at > ?`,
    config.fraud.rejectScore, userId, since,
  );
  if (!row || !row.n) return 0;
  const rejectRate = (row.rejected || 0) / row.n;
  const score = Math.round(Math.min(100, (row.avg_score || 0) * 0.5 + rejectRate * 100 * 0.5));
  q.run('UPDATE users SET fraud_score = ? WHERE id = ?', score, userId);
  return score;
}

module.exports = {
  SIGNALS, scoreEntry, scoreCompletion, verdict, logEvent,
  refreshPublisherScore, invalidateBlocklist, blocklist,
};
