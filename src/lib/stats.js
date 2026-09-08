'use strict';

/**
 * Aggregation queries shared by the publisher dashboard and the admin panel.
 * Everything reads from `daily_stats` where possible (pre-rolled) and falls
 * back to `visits` only for breakdowns that need per-visit detail.
 */

const { q } = require('../db');
const { dayKey, lastDays, now } = require('./util');

const sinceDay = (days) => dayKey(now() - (days - 1) * 86400000);

/** Headline tiles for one publisher (or the whole platform when userId is null). */
function summary(userId, days = 30) {
  const where = userId ? 'user_id = ? AND link_id = 0 AND day >= ?' : 'link_id = 0 AND day >= ?';
  const args = userId ? [userId, sinceDay(days)] : [sinceDay(days)];

  const range = q.get(
    `SELECT COALESCE(SUM(clicks),0) AS clicks,
            COALESCE(SUM(unique_clicks),0) AS unique_clicks,
            COALESCE(SUM(valid_visits),0) AS valid_visits,
            COALESCE(SUM(completed_visits),0) AS completed_visits,
            COALESCE(SUM(revenue_micros),0) AS revenue_micros,
            COALESCE(SUM(publisher_micros),0) AS publisher_micros
     FROM daily_stats WHERE ${where}`,
    ...args,
  ) || {};

  const todayWhere = userId ? 'user_id = ? AND link_id = 0 AND day = ?' : 'link_id = 0 AND day = ?';
  const todayArgs = userId ? [userId, dayKey()] : [dayKey()];
  const today = q.get(
    `SELECT COALESCE(SUM(clicks),0) AS clicks,
            COALESCE(SUM(unique_clicks),0) AS unique_clicks,
            COALESCE(SUM(valid_visits),0) AS valid_visits,
            COALESCE(SUM(completed_visits),0) AS completed_visits,
            COALESCE(SUM(revenue_micros),0) AS revenue_micros,
            COALESCE(SUM(publisher_micros),0) AS publisher_micros
     FROM daily_stats WHERE ${todayWhere}`,
    ...todayArgs,
  ) || {};

  const yesterday = q.get(
    `SELECT COALESCE(SUM(publisher_micros),0) AS publisher_micros,
            COALESCE(SUM(clicks),0) AS clicks
     FROM daily_stats WHERE ${todayWhere}`,
    ...(userId ? [userId, dayKey(now() - 86400000)] : [dayKey(now() - 86400000)]),
  ) || {};

  const ecpm = range.valid_visits ? Math.round((range.publisher_micros / range.valid_visits) * 1000) : 0;

  return {
    range,
    today,
    yesterday,
    ecpm,
    completionRate: range.clicks ? range.completed_visits / range.clicks : 0,
    validRate: range.clicks ? range.valid_visits / range.clicks : 0,
    uniqueRate: range.clicks ? range.unique_clicks / range.clicks : 0,
    deltaEarnings: (today.publisher_micros || 0) - (yesterday.publisher_micros || 0),
    deltaClicks: (today.clicks || 0) - (yesterday.clicks || 0),
  };
}

/** Day-by-day series, zero-filled so the chart has no gaps. */
function series(userId, days = 30) {
  const where = userId ? 'user_id = ? AND link_id = 0 AND day >= ?' : 'link_id = 0 AND day >= ?';
  const args = userId ? [userId, sinceDay(days)] : [sinceDay(days)];
  const rows = q.all(
    `SELECT day,
            SUM(clicks) AS clicks,
            SUM(unique_clicks) AS unique_clicks,
            SUM(valid_visits) AS valid_visits,
            SUM(completed_visits) AS completed_visits,
            SUM(publisher_micros) AS publisher_micros,
            SUM(revenue_micros) AS revenue_micros
     FROM daily_stats WHERE ${where} GROUP BY day ORDER BY day`,
    ...args,
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return lastDays(days).map((day) => {
    const r = byDay.get(day) || {};
    return {
      day,
      label: day.slice(5),
      clicks: r.clicks || 0,
      unique_clicks: r.unique_clicks || 0,
      valid_visits: r.valid_visits || 0,
      completed_visits: r.completed_visits || 0,
      publisher_micros: r.publisher_micros || 0,
      revenue_micros: r.revenue_micros || 0,
    };
  });
}

function breakdown(userId, field, days = 30, limit = 12) {
  if (!['country', 'device'].includes(field)) throw new Error('bad breakdown field');
  const where = userId
    ? `user_id = ? AND link_id != 0 AND day >= ? AND ${field} != '*'`
    : `link_id != 0 AND day >= ? AND ${field} != '*'`;
  const args = userId ? [userId, sinceDay(days)] : [sinceDay(days)];
  return q.all(
    `SELECT ${field} AS key,
            SUM(clicks) AS clicks,
            SUM(valid_visits) AS valid_visits,
            SUM(completed_visits) AS completed_visits,
            SUM(publisher_micros) AS publisher_micros
     FROM daily_stats WHERE ${where}
     GROUP BY ${field} ORDER BY clicks DESC LIMIT ?`,
    ...args, limit,
  );
}

/** Browser/OS/referrer splits come from visits — daily_stats doesn't carry them. */
function visitBreakdown(userId, field, days = 30, limit = 10) {
  if (!['browser', 'os', 'referer'].includes(field)) throw new Error('bad field');
  const since = now() - days * 86400000;
  const expr = field === 'referer'
    ? "CASE WHEN referer = '' THEN 'Direct / none' ELSE referer END"
    : field;
  const where = userId ? 'publisher_id = ? AND created_at > ?' : 'created_at > ?';
  const args = userId ? [userId, since] : [since];
  const rows = q.all(
    `SELECT ${expr} AS key, COUNT(*) AS clicks, SUM(is_valid) AS valid_visits
     FROM visits WHERE ${where} GROUP BY key ORDER BY clicks DESC LIMIT ?`,
    ...args, limit,
  );
  if (field !== 'referer') return rows;
  return rows.map((r) => {
    if (r.key === 'Direct / none') return r;
    try { return { ...r, key: new URL(r.key).hostname.replace(/^www\./, '') }; } catch { return r; }
  });
}

function topLinks(userId, days = 30, limit = 10) {
  const since = sinceDay(days);
  const where = userId ? 'ds.user_id = ? AND ds.link_id != 0 AND ds.day >= ?' : 'ds.link_id != 0 AND ds.day >= ?';
  const args = userId ? [userId, since] : [since];
  return q.all(
    `SELECT l.id, l.code, l.title, l.destination, l.resource_id, l.status,
            SUM(ds.clicks) AS clicks,
            SUM(ds.unique_clicks) AS unique_clicks,
            SUM(ds.completed_visits) AS completed_visits,
            SUM(ds.publisher_micros) AS publisher_micros
     FROM daily_stats ds JOIN links l ON l.id = ds.link_id
     WHERE ${where}
     GROUP BY l.id ORDER BY clicks DESC LIMIT ?`,
    ...args, limit,
  );
}

function recentVisits(userId, limit = 25) {
  const where = userId ? 'v.publisher_id = ?' : '1=1';
  const args = userId ? [userId] : [];
  return q.all(
    `SELECT v.id, v.country, v.device, v.browser, v.os, v.is_valid, v.is_completed,
            v.fraud_score, v.publisher_micros, v.created_at, l.code, l.title
     FROM visits v JOIN links l ON l.id = v.link_id
     WHERE ${where} ORDER BY v.created_at DESC LIMIT ?`,
    ...args, limit,
  );
}

/** Platform-wide counters for the admin home. */
function platformPulse() {
  const dayAgo = now() - 86400000;
  return {
    users: q.scalar('SELECT COUNT(*) FROM users') || 0,
    activeUsers: q.scalar("SELECT COUNT(*) FROM users WHERE status = 'active'") || 0,
    newUsers24h: q.scalar('SELECT COUNT(*) FROM users WHERE created_at > ?', dayAgo) || 0,
    links: q.scalar('SELECT COUNT(*) FROM links') || 0,
    resources: q.scalar('SELECT COUNT(*) FROM resources') || 0,
    visits24h: q.scalar('SELECT COUNT(*) FROM visits WHERE created_at > ?', dayAgo) || 0,
    completed24h: q.scalar('SELECT COUNT(*) FROM visits WHERE created_at > ? AND is_completed = 1', dayAgo) || 0,
    fraud24h: q.scalar('SELECT COUNT(*) FROM fraud_events WHERE created_at > ?', dayAgo) || 0,
    pendingPayouts: q.scalar("SELECT COUNT(*) FROM payouts WHERE status = 'pending'") || 0,
    pendingPayoutMicros: q.scalar("SELECT COALESCE(SUM(amount_micros),0) FROM payouts WHERE status = 'pending'") || 0,
    owedMicros: q.scalar('SELECT COALESCE(SUM(balance_micros + pending_micros),0) FROM users') || 0,
    openTickets: q.scalar("SELECT COUNT(*) FROM contact_messages WHERE status = 'open'") || 0,
  };
}

/** Fraud signal frequency for the admin fraud page. */
function fraudSignals(days = 7, limit = 15) {
  const since = now() - days * 86400000;
  const rows = q.all('SELECT reason FROM fraud_events WHERE created_at > ?', since);
  const counts = new Map();
  for (const r of rows) {
    for (const key of String(r.reason).split(',')) {
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

module.exports = {
  summary, series, breakdown, visitBreakdown, topLinks, recentVisits,
  platformPulse, fraudSignals, sinceDay,
};
