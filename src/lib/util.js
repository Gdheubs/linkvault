'use strict';

const crypto = require('crypto');
const config = require('../config');

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Short codes skip look-alike glyphs so codes survive being read aloud / retyped.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const now = () => Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);

function randomCode(len = 6, alphabet = CODE_ALPHABET) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

/** Salted one-way hash — used for IPs and fingerprints so we never store raw PII. */
function saltedHash(value) {
  return crypto
    .createHmac('sha256', config.secrets.hashSalt)
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 32);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// --- money -------------------------------------------------------------------
const MICROS = 1_000_000;
const toMicros = (usd) => Math.round(Number(usd || 0) * MICROS);
const fromMicros = (micros) => Number(micros || 0) / MICROS;

function usd(micros, digits = 2) {
  const n = fromMicros(micros);
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Compact money for dense dashboard tiles: $1.2K, $3.4M. */
function usdCompact(micros) {
  const n = fromMicros(micros);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(n < 10 ? 4 : 2)}`;
}

function num(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function pct(part, whole, digits = 1) {
  if (!whole) return '0.0%';
  return `${((Number(part) / Number(whole)) * 100).toFixed(digits)}%`;
}

// --- text --------------------------------------------------------------------
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function truncate(str, len = 120) {
  const s = String(str || '');
  return s.length > len ? `${s.slice(0, len - 1)}…` : s;
}

function timeAgo(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  const abs = Math.abs(diff);
  const units = [
    [31536000000, 'y'], [2592000000, 'mo'], [604800000, 'w'],
    [86400000, 'd'], [3600000, 'h'], [60000, 'm'], [1000, 's'],
  ];
  for (const [span, label] of units) {
    if (abs >= span) {
      const v = Math.floor(abs / span);
      return diff >= 0 ? `${v}${label} ago` : `in ${v}${label}`;
    }
  }
  return 'just now';
}

function fmtDate(ms, opts = { dateStyle: 'medium' }) {
  if (!ms) return '—';
  return new Date(Number(ms)).toLocaleString('en-US', opts);
}

function fmtBytes(bytes) {
  const b = Number(bytes || 0);
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function dayKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Last n day-keys, oldest first. */
function lastDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(Date.now() - i * 86400000));
  return out;
}

// --- minimal markdown (headings, bold, italics, links, lists, code, quotes) ---
function markdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inList = null;
  let inCode = false;
  let para = [];

  const inline = (t) => escapeHtml(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) =>
      (/^(https?:|\/|#|mailto:)/i.test(href) ? `<a href="${href}">${txt}</a>` : txt));

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const closeList = () => {
    if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null; }
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      flushPara(); closeList();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }

    if (!line.trim()) { flushPara(); closeList(); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      const lvl = h[1].length + 1;
      out.push(`<h${lvl} id="${slugify(h[2])}">${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara(); closeList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^\s*(---|___|\*\*\*)\s*$/.test(line)) {
      flushPara(); closeList(); out.push('<hr>'); continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (inList !== want) { closeList(); out.push(want === 'ul' ? '<ul>' : '<ol>'); inList = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    para.push(line.trim());
  }
  flushPara(); closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

// --- misc --------------------------------------------------------------------
function isSafeUrl(url) {
  try {
    const u = new URL(String(url));
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    // Block obvious SSRF / loopback targets from being used as destinations.
    if (['localhost', '0.0.0.0', '::1', '127.0.0.1'].includes(host)) return false;
    if (/^(10|127)\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n) || 0)); }

function parseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/** Deterministic pick from a weighted list. */
function weightedPick(items, weightOf = (i) => i.weight || 1) {
  const list = items.filter((i) => weightOf(i) > 0);
  if (!list.length) return null;
  const total = list.reduce((s, i) => s + weightOf(i), 0);
  let r = Math.random() * total;
  for (const item of list) {
    r -= weightOf(item);
    if (r <= 0) return item;
  }
  return list[list.length - 1];
}

const COUNTRY_NAMES = {
  US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia',
  DE: 'Germany', FR: 'France', NL: 'Netherlands', ES: 'Spain', IT: 'Italy',
  SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', IE: 'Ireland',
  CH: 'Switzerland', AT: 'Austria', BE: 'Belgium', NZ: 'New Zealand',
  IN: 'India', PK: 'Pakistan', BD: 'Bangladesh', ID: 'Indonesia', PH: 'Philippines',
  VN: 'Vietnam', TH: 'Thailand', MY: 'Malaysia', SG: 'Singapore', JP: 'Japan',
  KR: 'South Korea', CN: 'China', HK: 'Hong Kong', TW: 'Taiwan',
  BR: 'Brazil', MX: 'Mexico', AR: 'Argentina', CO: 'Colombia', CL: 'Chile',
  PE: 'Peru', VE: 'Venezuela', RU: 'Russia', UA: 'Ukraine', PL: 'Poland',
  TR: 'Turkey', SA: 'Saudi Arabia', AE: 'United Arab Emirates', EG: 'Egypt',
  NG: 'Nigeria', ZA: 'South Africa', KE: 'Kenya', GH: 'Ghana', MA: 'Morocco',
  DZ: 'Algeria', IQ: 'Iraq', IR: 'Iran', IL: 'Israel', PT: 'Portugal',
  GR: 'Greece', CZ: 'Czechia', RO: 'Romania', HU: 'Hungary', XX: 'Unknown',
};

function countryName(code) {
  return COUNTRY_NAMES[String(code || '').toUpperCase()] || code || 'Unknown';
}

/** Regional-indicator flag emoji from an ISO-3166-1 alpha-2 code. */
function countryFlag(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX') return '🌐';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

module.exports = {
  B62, CODE_ALPHABET, MICROS,
  now, nowSec, randomCode, randomToken, randomHex, saltedHash, timingSafeEqual,
  toMicros, fromMicros, usd, usdCompact, num, pct,
  escapeHtml, slugify, truncate, timeAgo, fmtDate, fmtBytes, dayKey, lastDays, markdown,
  isSafeUrl, hostOf, clamp, parseJson, weightedPick, countryName, countryFlag, COUNTRY_NAMES,
};
