'use strict';

/**
 * Idempotent seed. Runs on every boot; only inserts what is missing.
 * `node src/db/seed.js --reset` wipes content/config tables and re-seeds them
 * (it never touches users, links, visits or the ledger).
 */

const { q, settings } = require('./index');
const config = require('../config');
const authLib = require('../lib/auth');
const { now, toMicros } = require('../lib/util');
const pages = require('./seed-pages');
const posts = require('./seed-posts');

// ---------------------------------------------------------------------------
// Rate cards
//
// CONSERVATIVE PLACEHOLDERS. Short-link CPM varies enormously by country,
// device, traffic source, network and fill; published third-party tables
// disagree with each other and with reality. Replace every row with figures
// measured from your own traffic before you promise a publisher anything.
// ---------------------------------------------------------------------------
const RATE_CARDS = [
  ['US', '*', 2.20, 0.88, 'Tier 1 — validate against your own network reporting'],
  ['GB', '*', 1.90, 0.87, 'Tier 1'],
  ['CA', '*', 1.70, 0.87, 'Tier 1'],
  ['AU', '*', 1.65, 0.86, 'Tier 1'],
  ['DE', '*', 1.55, 0.86, 'Tier 1'],
  ['NL', '*', 1.45, 0.85, 'Tier 1'],
  ['SE', '*', 1.40, 0.85, 'Tier 1'],
  ['FR', '*', 1.25, 0.85, 'Tier 1'],
  ['JP', '*', 1.20, 0.84, 'Tier 1'],
  ['IT', '*', 0.95, 0.84, 'Tier 2'],
  ['ES', '*', 0.90, 0.84, 'Tier 2'],
  ['PL', '*', 0.70, 0.83, 'Tier 2'],
  ['BR', '*', 0.55, 0.82, 'Tier 2'],
  ['MX', '*', 0.50, 0.82, 'Tier 2'],
  ['TR', '*', 0.40, 0.80, 'Tier 3'],
  ['IN', '*', 0.32, 0.80, 'Tier 3 — high volume, low rate'],
  ['ID', '*', 0.28, 0.79, 'Tier 3'],
  ['PH', '*', 0.28, 0.79, 'Tier 3'],
  ['PK', '*', 0.22, 0.78, 'Tier 3'],
  ['BD', '*', 0.20, 0.78, 'Tier 3'],
  ['NG', '*', 0.20, 0.76, 'Tier 3'],
  ['VN', '*', 0.26, 0.79, 'Tier 3'],
  ['*', 'desktop', 0.45, 0.84, 'Fallback — desktop'],
  ['*', 'mobile', 0.38, 0.82, 'Fallback — mobile'],
  ['*', '*', 0.35, 0.80, 'Global fallback'],
];

const AD_SLOTS = [
  // gateway
  ['gw_top', 'Gateway — above the fold', 'banner', 'adsense', 'gateway', 20],
  ['gw_mid', 'Gateway — mid content', 'inarticle', 'adsense', 'gateway', 18],
  ['gw_bottom', 'Gateway — below content', 'banner', 'adsense', 'gateway', 16],
  ['gw_native_1', 'Gateway — native 1', 'native', 'adsense', 'gateway', 14],
  ['gw_native_2', 'Gateway — native 2', 'native', 'adsense', 'gateway', 12],
  // Video slot for promoting a YouTube channel. Renders nothing until an
  // operator sets youtube_id in Admin -> Ad inventory, so it degrades cleanly.
  ['gw_video', 'Gateway — featured video', 'video', 'youtube', 'gateway', 14],
  ['gw_unlock', 'Unlock page banner', 'banner', 'adsense', 'gateway', 15],
  // site
  ['site_mid', 'Site — mid page', 'banner', 'adsense', 'site', 10],
  ['site_side', 'Site — sidebar', 'native', 'adsense', 'site', 10],
  // blog
  ['blog_top', 'Blog — above article', 'banner', 'adsense', 'blog', 12],
  ['blog_bottom', 'Blog — below article', 'inarticle', 'adsense', 'blog', 12],
  ['blog_side', 'Blog — sidebar', 'native', 'adsense', 'blog', 10],
];

const PRODUCTS = [
  {
    slug: 'linkvault-pro',
    name: 'LinkVault Pro',
    tagline: 'Higher revenue share, priority payouts and unlimited custom flows.',
    price: 9.0,
    period: 'month',
    badge: 'Popular',
    sort: 1,
    features: [
      'Publisher share raised to 75%',
      'Payouts processed twice weekly',
      'Unlimited custom monetization flows',
      'Per-country and per-device flow targeting',
      'Priority support queue',
      'API rate limit raised to 1,200/min',
    ],
    description: `**LinkVault Pro** is for publishers whose links have outgrown the free tier.\n\n## What changes\n\nThe headline difference is the revenue split: Pro accounts keep **75%** of gross instead of the standard share. On a link doing meaningful volume that difference compounds quickly.\n\nPro also unlocks the parts of the monetization engine that are capped on free accounts — unlimited custom flows, and per-country and per-device targeting so you can run a two-step flow for mobile visitors in one market and a three-step flow for desktop in another.\n\n## What does not change\n\nThe anti-fraud engine treats Pro traffic exactly the same way. Invalid traffic earns nothing on any plan, and paying for Pro does not buy leniency on traffic quality. That is deliberate: the value of the inventory depends on every publisher's traffic being real.\n\n## Billing\n\nMonthly, cancel any time. Cancelling drops you back to the standard share at the end of the paid period; nothing already earned is affected.`,
  },
  {
    slug: 'vault-storage-plus',
    name: 'Vault Storage Plus',
    tagline: 'Larger file limits, longer retention and delivery analytics.',
    price: 5.0,
    period: 'month',
    badge: '',
    sort: 2,
    features: [
      'Higher per-file size ceiling',
      'Extended retention on inactive files',
      'Per-file delivery analytics',
      'Bulk upload via the API',
      'Download receipts',
    ],
    description: `Storage Plus extends the Telegram-backed **file vault**.\n\n## Bigger files, longer\n\nFree accounts have a per-file ceiling and inactive files eventually age out. Storage Plus raises the ceiling and keeps inactive files indefinitely while the subscription is active.\n\n## Delivery analytics\n\nYou get a per-file view of how many completion tokens were issued, how many were actually redeemed at the bot, and where redemptions dropped off. That gap — issued versus redeemed — is usually the most actionable number a file publisher has.\n\n## How storage works\n\nFiles are held in Telegram, addressed by a \`file_id\` that is meaningless without the bot token. No public URL is ever generated, and the bot re-verifies the signed completion token before releasing anything.`,
  },
  {
    slug: 'traffic-audit',
    name: 'Traffic Quality Audit',
    tagline: 'A human review of why your traffic is scoring as invalid.',
    price: 0,
    period: 'one-time',
    badge: 'Free',
    sort: 3,
    features: [
      'Signal-by-signal breakdown of your flagged visits',
      'Source-level analysis of where invalid traffic enters',
      'Concrete remediation steps',
      'Follow-up re-check after 14 days',
    ],
    description: `If your traffic-quality score is high and you do not know why, request an audit.\n\n## What we look at\n\nWe pull the actual fraud signals that fired on your visits over the last 30 days, group them by source and by link, and tell you which of your traffic sources is responsible.\n\nMost accounts that come to us assuming they were wrongly flagged turn out to have one bad source — a traffic exchange, a bot-heavy Telegram channel, or a single referrer sending automated hits — mixed in with otherwise fine traffic. Cutting that one source usually fixes the score.\n\n## What we cannot do\n\nWe cannot un-flag traffic that was genuinely invalid, and we cannot restore earnings that were reversed. The audit is about fixing the *next* 30 days.\n\n## Requesting one\n\nUse the contact form and pick "Publisher support". Include your account email and the links you are most concerned about.`,
  },
];

// ---------------------------------------------------------------------------
function seedUsers() {
  if (q.scalar("SELECT COUNT(*) FROM users WHERE role = 'admin'")) return;

  authLib.createUser({
    email: 'admin@linkvault.local',
    password: 'ChangeMe123',
    name: 'Platform Admin',
    role: 'admin',
  });
  console.log('[seed] created admin@linkvault.local / ChangeMe123  — CHANGE THIS PASSWORD');

  if (!config.isProd) {
    authLib.createUser({
      email: 'demo@linkvault.local',
      password: 'Demo12345',
      name: 'Demo Publisher',
    });
    console.log('[seed] created demo@linkvault.local / Demo12345');
  }
}

function seedRates() {
  for (const [country, device, cpm, fill, note] of RATE_CARDS) {
    q.run(
      `INSERT INTO rate_cards (country, device, cpm_micros, fill_rate, active, note)
       VALUES (?,?,?,?,1,?)
       ON CONFLICT(country, device) DO NOTHING`,
      country, device, toMicros(cpm), fill, note,
    );
  }
}

function seedAds() {
  for (const [key, name, type, provider, placement, weight] of AD_SLOTS) {
    q.run(
      `INSERT INTO ad_slots (slot_key, name, type, provider, placement, weight, enabled)
       VALUES (?,?,?,?,?,?,1)
       ON CONFLICT(slot_key) DO NOTHING`,
      key, name, type, provider, placement, weight,
    );
  }

  // A house promo so the popup and native slots are not empty on a fresh install.
  q.run(
    `INSERT INTO ad_slots (slot_key, name, type, provider, placement, weight, enabled, headline, body, href)
     VALUES ('house_promo', 'House promo — Pro', 'popup', 'house', 'gateway', 8, 1, ?, ?, ?)
     ON CONFLICT(slot_key) DO NOTHING`,
    'Keep more of what you earn',
    'LinkVault Pro raises your revenue share to 75% and unlocks per-country flow targeting.',
    `${config.baseUrl}/products/linkvault-pro`,
  );
}

function seedProducts() {
  for (const p of PRODUCTS) {
    q.run(
      `INSERT INTO products (slug, name, tagline, description, features, price_micros, period, badge, status, sort)
       VALUES (?,?,?,?,?,?,?,?,'active',?)
       ON CONFLICT(slug) DO NOTHING`,
      p.slug, p.name, p.tagline, p.description, JSON.stringify(p.features),
      toMicros(p.price), p.period, p.badge, p.sort,
    );
  }
}

function seedPages() {
  for (const page of pages.build(config)) {
    q.run(
      `INSERT INTO pages (slug, title, body, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(slug) DO NOTHING`,
      page.slug, page.title, page.body, now(),
    );
  }
}

function seedPosts() {
  let offset = 0;
  for (const post of posts.ALL) {
    const words = post.body.split(/\s+/).length;
    q.run(
      `INSERT INTO posts (slug, title, excerpt, body, tags, author, read_minutes, status, published_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'published',?,?)
       ON CONFLICT(slug) DO NOTHING`,
      post.slug, post.title, post.excerpt, post.body, post.tags,
      `${config.brand.name} Team`, Math.max(1, Math.round(words / 220)),
      now() - offset * 86400000, now() - offset * 86400000,
    );
    offset += 4;
  }
}

function seedSettings() {
  if (settings.get('publisher_share_pct', null) === null) {
    settings.set('publisher_share_pct', config.revenue.publisherSharePct);
  }
  if (settings.get('referral_share_pct', null) === null) {
    settings.set('referral_share_pct', config.revenue.referralSharePct);
  }
  if (settings.get('skip_mode', null) === null) {
    settings.set('skip_mode', config.monetization.skipMode);
  }
  if (settings.get('revenue_disclaimer', null) === null) {
    settings.set('revenue_disclaimer',
      'Earnings depend on visitor country, device, traffic source, traffic quality, ad fill and the ad network in use. '
      + 'Rate-card figures are configurable estimates for planning only — they are not a guarantee, and your realised '
      + 'eCPM is the only number that matters. Validate against your own traffic before making commitments.');
  }
  if (settings.get('popup_enabled', null) === null) settings.set('popup_enabled', true);
  if (settings.get('popup_delay_ms', null) === null) settings.set('popup_delay_ms', 6000);
  if (settings.get('popup_per_session', null) === null) settings.set('popup_per_session', 1);
}

function reset() {
  console.log('[seed] --reset: clearing content, ad slots, rate cards and settings');
  q.run('DELETE FROM pages');
  q.run('DELETE FROM posts');
  q.run('DELETE FROM products');
  q.run('DELETE FROM ad_slots');
  q.run('DELETE FROM rate_cards');
  q.run('DELETE FROM settings');
}

function ensureSeed() {
  seedUsers();
  seedRates();
  seedAds();
  seedProducts();
  seedPages();
  seedPosts();
  seedSettings();
}

if (require.main === module) {
  if (process.argv.includes('--reset')) reset();
  ensureSeed();
  console.log('[seed] done');
}

module.exports = ensureSeed;
module.exports.reset = reset;
