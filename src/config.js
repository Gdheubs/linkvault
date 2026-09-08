'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- tiny .env loader (no dependency) ---------------------------------------
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const env = process.env;
const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : parseInt(v, 10));

// A stable dev secret so sessions survive restarts; production must set its own.
function devSecret(name) {
  const p = path.join(__dirname, '..', 'data', '.devsecrets.json');
  let store = {};
  try { store = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* first run */ }
  if (!store[name]) {
    store[name] = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(store, null, 2));
  }
  return store[name];
}

const isProd = env.NODE_ENV === 'production';

if (isProd) {
  for (const k of ['SESSION_SECRET', 'TOKEN_SECRET', 'HASH_SALT']) {
    if (!env[k]) {
      console.error(`[config] FATAL: ${k} must be set in production. Copy .env.example to .env and fill it in.`);
      process.exit(1);
    }
  }
}

const config = {
  isProd,
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  // Getting this wrong is the classic container-deploy bug: every short link,
  // OG tag, sitemap entry and Telegram webhook URL ends up pointing at
  // localhost. Railway, Render and Fly all expose their public hostname, so
  // fall back to that before assuming local.
  baseUrl: (
    env.BASE_URL
    || (env.RAILWAY_PUBLIC_DOMAIN && `https://${env.RAILWAY_PUBLIC_DOMAIN}`)
    || env.RENDER_EXTERNAL_URL
    || (env.FLY_APP_NAME && `https://${env.FLY_APP_NAME}.fly.dev`)
    || `http://localhost:${int(env.PORT, 3000)}`
  ).replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY || (isProd ? 1 : false),

  brand: {
    name: env.BRAND_NAME || 'LinkVault',
    tagline: env.BRAND_TAGLINE || 'Monetized short links with vault-grade file delivery',
    supportEmail: env.SUPPORT_EMAIL || 'support@linkvault.example',
    dmcaEmail: env.DMCA_EMAIL || 'dmca@linkvault.example',
    company: env.COMPANY_NAME || 'LinkVault Media',
    address: env.COMPANY_ADDRESS || '',
    twitter: env.SOCIAL_TWITTER || '',
    telegram: env.SOCIAL_TELEGRAM || '',
    youtube: env.SOCIAL_YOUTUBE || '',
  },

  secrets: {
    session: env.SESSION_SECRET || devSecret('session'),
    token: env.TOKEN_SECRET || devSecret('token'),
    hashSalt: env.HASH_SALT || devSecret('hash'),
  },

  db: {
    file: env.DB_FILE || path.join(__dirname, '..', 'data', 'linkvault.db'),
  },

  session: {
    cookie: 'lv_sid',
    ttlDays: int(env.SESSION_TTL_DAYS, 30),
  },

  // --- monetization defaults (overridable per campaign + in admin settings) ---
  monetization: {
    waitSeconds: int(env.WAIT_SECONDS, 15),
    // The default flow is 'none': the countdown runs, then the Continue button
    // at the bottom of the page unlocks by itself. Nothing is asked of the
    // visitor and no ad interaction is ever required or rewarded.
    //
    // 'none'       = timer only. The shipped flow.
    // 'engagement' = additionally allow an early skip once the visitor has
    //                engaged with the PAGE CONTENT. Still AdSense-safe.
    // 'ad_click'   = allow an early skip on an AD interaction. That is an
    //                incentivised click and the Google AdSense program policies
    //                PROHIBIT it. Only for a network whose terms allow it.
    skipMode: env.SKIP_MODE || 'none',
    minDwellMs: int(env.MIN_DWELL_MS, 2500),
    stepTokenTtlSec: int(env.STEP_TOKEN_TTL, 1800),
    completionTokenTtlSec: int(env.COMPLETION_TOKEN_TTL, 900),
    completionMaxUses: int(env.COMPLETION_MAX_USES, 3),
  },

  revenue: {
    publisherSharePct: Number(env.PUBLISHER_SHARE_PCT || 60),
    referralSharePct: Number(env.REFERRAL_SHARE_PCT || 5),
    // Earnings sit in `pending` for this long so fraud sweeps can claw them back.
    holdHours: int(env.EARNINGS_HOLD_HOURS, 72),
    minPayoutMicros: int(env.MIN_PAYOUT_USD, 5) * 1_000_000,
  },

  fraud: {
    // A visit scoring at/above this is not paid.
    rejectScore: int(env.FRAUD_REJECT_SCORE, 60),
    reviewScore: int(env.FRAUD_REVIEW_SCORE, 35),
    uniqueWindowHours: int(env.UNIQUE_WINDOW_HOURS, 24),
    ipVisitsPerMin: int(env.IP_VISITS_PER_MIN, 12),
    ipVisitsPerHour: int(env.IP_VISITS_PER_HOUR, 120),
    minHumanCompletionMs: int(env.MIN_HUMAN_COMPLETION_MS, 4000),
    publisherAnomalyMinVisits: int(env.PUB_ANOMALY_MIN_VISITS, 200),
  },

  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    botUsername: (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
    storageChatId: env.TELEGRAM_STORAGE_CHAT_ID || '',
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || devSecret('tgwebhook'),
    get enabled() { return Boolean(env.TELEGRAM_BOT_TOKEN); },
  },

  ads: {
    adsenseClient: env.ADSENSE_CLIENT || '',          // ca-pub-XXXXXXXXXXXXXXXX
    adsenseEnabled: bool(env.ADSENSE_ENABLED, false),
    adsTxt: env.ADS_TXT || '',
  },

  analytics: {
    gaId: env.GA_MEASUREMENT_ID || '',
  },

  seo: {
    verifyGoogle: env.GOOGLE_SITE_VERIFICATION || '',
  },
};

module.exports = config;
