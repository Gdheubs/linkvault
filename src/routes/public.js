'use strict';

/**
 * The public site.
 *
 * This is the surface AdSense reviews. It carries original written content
 * (blog), a real product catalogue, and the policy pages a review expects to
 * find: About, Contact, Privacy, Terms, DMCA, Disclaimer, Cookie policy.
 */

const express = require('express');
const config = require('../config');
const { q, settings } = require('../db');
const ads = require('../lib/ads');
const promos = require('../lib/promos');
const { rateLimit } = require('../middleware');
const { classify } = require('../lib/geo');
const {
  markdown, escapeHtml, now, truncate,
} = require('../lib/util');

const router = express.Router();

router.use((req, res, nextFn) => {
  res.locals.nav = 'site';
  res.locals.adsHead = ads.headScript();
  res.locals.announcement = settings.get('announcement', '');
  res.locals.promos = promos;
  nextFn();
});

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const totals = q.get(
    `SELECT (SELECT COUNT(*) FROM links) AS links,
            (SELECT COUNT(*) FROM users) AS publishers,
            (SELECT COALESCE(SUM(clicks),0) FROM links) AS clicks,
            (SELECT COALESCE(SUM(paid_micros),0) FROM users) AS paid`,
  ) || {};

  res.render('public/home', {
    title: `${config.brand.name} — ${config.brand.tagline}`,
    description: 'Turn any link or file into a monetized short link. Configurable ad flow, real anti-fraud, Telegram-backed file delivery, and transparent publisher payouts.',
    totals,
    posts: q.all("SELECT slug, title, excerpt, cover, tags, read_minutes, published_at FROM posts WHERE status='published' ORDER BY published_at DESC LIMIT 3"),
    products: q.all("SELECT * FROM products WHERE status='active' ORDER BY sort, id LIMIT 3"),
    rateSample: q.all("SELECT country, device, cpm_micros FROM rate_cards WHERE active=1 AND country != '*' ORDER BY cpm_micros DESC LIMIT 8"),
    shares: { publisher: settings.get('publisher_share_pct', config.revenue.publisherSharePct) },
    disclaimer: settings.get('revenue_disclaimer', DEFAULT_DISCLAIMER),
    siteAds: ads.byPlacement('site'),
    ads,
  });
});

// ---------------------------------------------------------------------------
// Blog
// ---------------------------------------------------------------------------
router.get('/blog', (req, res) => {
  const tag = String(req.query.tag || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 9;

  const where = tag ? "status='published' AND tags LIKE ?" : "status='published'";
  const args = tag ? [`%${tag}%`] : [];
  const total = q.scalar(`SELECT COUNT(*) FROM posts WHERE ${where}`, ...args) || 0;

  const allTags = new Set();
  for (const r of q.all("SELECT tags FROM posts WHERE status='published'")) {
    for (const t of String(r.tags).split(',')) if (t.trim()) allTags.add(t.trim());
  }

  res.render('public/blog', {
    title: `Blog · ${config.brand.name}`,
    description: 'Guides on link monetization, traffic quality, ad policy compliance and file delivery.',
    posts: q.all(
      `SELECT slug, title, excerpt, cover, tags, author, read_minutes, views, published_at
       FROM posts WHERE ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`,
      ...args, perPage, (page - 1) * perPage,
    ),
    tags: [...allTags].sort(),
    tag, page, total,
    pages: Math.max(1, Math.ceil(total / perPage)),
    ads,
  });
});

router.get('/blog/:slug', (req, res) => {
  const post = q.get("SELECT * FROM posts WHERE slug = ? AND status='published'", String(req.params.slug));
  if (!post) return res.status(404).render('error', { title: 'Post not found', code: 404, message: 'That article does not exist.' });

  q.run('UPDATE posts SET views = views + 1 WHERE id = ?', post.id);

  const tags = String(post.tags).split(',').map((t) => t.trim()).filter(Boolean);
  res.render('public/post', {
    title: `${post.title} · ${config.brand.name}`,
    description: post.excerpt || truncate(post.body.replace(/[#*`>]/g, ''), 160),
    post,
    tags,
    bodyHtml: markdown(post.body),
    related: q.all(
      `SELECT slug, title, excerpt, read_minutes FROM posts
       WHERE status='published' AND id != ? ORDER BY views DESC LIMIT 3`,
      post.id,
    ),
    ads,
  });
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
router.get('/products', (req, res) => {
  res.render('public/products', {
    title: `Products · ${config.brand.name}`,
    description: 'Tools and upgrades from the LinkVault team.',
    products: q.all("SELECT * FROM products WHERE status='active' ORDER BY sort, id"),
    ads,
  });
});

router.get('/products/:slug', (req, res) => {
  const product = q.get("SELECT * FROM products WHERE slug = ? AND status='active'", String(req.params.slug));
  if (!product) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such product.' });
  q.run('UPDATE products SET clicks = clicks + 1 WHERE id = ?', product.id);
  res.render('public/product', {
    title: `${product.name} · ${config.brand.name}`,
    description: product.tagline,
    product,
    features: (() => { try { return JSON.parse(product.features); } catch { return []; } })(),
    bodyHtml: markdown(product.description),
    others: q.all("SELECT slug, name, tagline, badge FROM products WHERE status='active' AND id != ? ORDER BY sort LIMIT 3", product.id),
    ads,
  });
});

// ---------------------------------------------------------------------------
// Promote with us — advertisers buy a placement for a blog post or a video
// ---------------------------------------------------------------------------
function promoteView(res, extra = {}) {
  return res.render('public/promote', {
    title: `Promote your blog or YouTube video · ${config.brand.name}`,
    description: 'Get your blog post or YouTube video in front of our link-flow audience. Clearly labelled placements from a few dollars a week.',
    packages: promos.packages(),
    samples: promos.forPlacement('gateway', 2),
    liveCount: promos.live().length,
    reach: q.get(
      `SELECT COALESCE(SUM(clicks),0) AS clicks,
              (SELECT COUNT(*) FROM posts WHERE status='published') AS posts
       FROM links`,
    ) || { clicks: 0, posts: 0 },
    sent: false,
    error: null,
    values: {},
    ads,
    ...extra,
  });
}

router.get('/promote', (req, res) => promoteView(res, {
  values: { package: String(req.query.package || ''), kind: String(req.query.kind || 'blog') },
}));

router.post('/promote', rateLimit({ max: 6, windowMs: 900000, key: 'promote' }), (req, res) => {
  const body = req.body || {};

  // Honeypot: real people never fill a field they cannot see.
  if (body.website) return promoteView(res, { sent: true });

  const check = promos.validateSubmission(body);
  if (!check.ok) {
    return promoteView(res.status(400), { error: check.error, values: body });
  }

  const d = check.data;
  q.run(
    `INSERT INTO promotions (kind, title, blurb, url, youtube_id, image, cta, advertiser, email, note,
                             package, placement, price_micros, days, weight, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
    d.kind, d.title, d.blurb, d.url, d.youtube_id, d.image, d.cta,
    d.advertiser, d.email, d.note,
    d.package, d.placement, d.price_micros, d.days, d.weight, now(),
  );

  // Mirror it into the contact inbox so it lands in one queue with everything else.
  q.run(
    'INSERT INTO contact_messages (name, email, subject, body, kind, created_at) VALUES (?,?,?,?,?,?)',
    d.advertiser || d.email, d.email,
    `Promotion request: ${d.title}`,
    `Package: ${d.package} (${d.days} days, ${d.placement})\nType: ${d.kind}\nURL: ${d.url || d.youtube_id}\n\n${d.note}`,
    'advertiser', now(),
  );

  promoteView(res, { sent: true });
});

// ---------------------------------------------------------------------------
// Static-ish informational pages
// ---------------------------------------------------------------------------
router.get('/pricing', (req, res) => {
  res.render('public/pricing', {
    title: `Publisher payouts · ${config.brand.name}`,
    description: 'How revenue share, rate cards, hold windows and withdrawals work.',
    shares: {
      publisher: settings.get('publisher_share_pct', config.revenue.publisherSharePct),
      referral: settings.get('referral_share_pct', config.revenue.referralSharePct),
    },
    rateCards: q.all("SELECT * FROM rate_cards WHERE active = 1 ORDER BY (country='*'), cpm_micros DESC LIMIT 40"),
    minPayout: config.revenue.minPayoutMicros,
    holdHours: config.revenue.holdHours,
    disclaimer: settings.get('revenue_disclaimer', DEFAULT_DISCLAIMER),
    ads,
  });
});

const LEGAL = ['privacy', 'terms', 'dmca', 'disclaimer', 'cookies', 'about'];

router.get('/:slug', (req, res, nextFn) => {
  const slug = String(req.params.slug);
  if (!LEGAL.includes(slug)) return nextFn();

  const page = q.get('SELECT * FROM pages WHERE slug = ?', slug);
  if (!page) return nextFn();

  res.render('public/page', {
    title: `${page.title} · ${config.brand.name}`,
    description: `${page.title} for ${config.brand.name}.`,
    page,
    bodyHtml: markdown(page.body),
    legalNav: LEGAL,
    ads,
  });
});

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------
router.get('/contact', (req, res) => {
  res.render('public/contact', {
    title: `Contact · ${config.brand.name}`,
    description: `Reach the ${config.brand.name} team about support, advertising, or a DMCA notice.`,
    sent: false,
    error: null,
    values: {},
    ads,
  });
});

router.post('/contact', rateLimit({ max: 5, windowMs: 900000, key: 'contact' }), (req, res) => {
  const { name = '', email = '', subject = '', body = '', kind = 'general', website = '' } = req.body || {};
  const values = { name, email, subject, body, kind };

  const render = (error, sent = false) => res.status(error ? 400 : 200).render('public/contact', {
    title: `Contact · ${config.brand.name}`,
    description: 'Contact us.',
    sent, error, values: sent ? {} : values, ads,
  });

  // Honeypot: real users never fill a hidden field.
  if (website) return render(null, true);
  if (!String(name).trim() || !String(body).trim()) return render('Name and message are required.');
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(String(email).trim())) return render('Enter a valid email address.');
  if (String(body).length > 5000) return render('Message is too long.');

  q.run(
    'INSERT INTO contact_messages (name, email, subject, body, kind, created_at) VALUES (?,?,?,?,?,?)',
    String(name).slice(0, 100), String(email).slice(0, 190), String(subject).slice(0, 200),
    String(body).slice(0, 5000),
    ['general', 'dmca', 'advertiser', 'support'].includes(kind) ? kind : 'general',
    now(),
  );
  render(null, true);
});

// ---------------------------------------------------------------------------
// Promoted-content viewability, for placements outside the link flow
// ---------------------------------------------------------------------------
router.post('/promo-view', express.json({ limit: '4kb' }), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 8).map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(204).end();
  const ctx = classify(req);
  const surface = ['blog', 'site'].includes(req.body?.surface) ? req.body.surface : 'site';
  promos.recordImpressions(ids, { surface, country: ctx.country, device: ctx.device });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// SEO / crawler files
// ---------------------------------------------------------------------------
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *
Allow: /
# The monetization gateway is per-visitor and must never be indexed.
Disallow: /s/
Disallow: /v/
Disallow: /d/
Disallow: /unlock/
Disallow: /out/
Disallow: /dashboard/
Disallow: /admin/
Disallow: /api/

Sitemap: ${config.baseUrl}/sitemap.xml
`,
  );
});

router.get('/ads.txt', (req, res) => {
  if (config.ads.adsTxt) return res.type('text/plain').send(config.ads.adsTxt);
  if (config.ads.adsenseClient) {
    const pub = config.ads.adsenseClient.replace(/^ca-/, '');
    return res.type('text/plain').send(`google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`);
  }
  res.status(404).type('text/plain').send('# ads.txt not configured. Set ADSENSE_CLIENT or ADS_TXT.\n');
});

router.get('/sitemap.xml', (req, res) => {
  const urls = [
    { loc: '/', pri: '1.0', freq: 'daily' },
    { loc: '/blog', pri: '0.9', freq: 'daily' },
    { loc: '/products', pri: '0.8', freq: 'weekly' },
    { loc: '/pricing', pri: '0.8', freq: 'weekly' },
    { loc: '/promote', pri: '0.7', freq: 'weekly' },
    { loc: '/contact', pri: '0.5', freq: 'monthly' },
    ...LEGAL.map((s) => ({ loc: `/${s}`, pri: '0.4', freq: 'yearly' })),
    ...q.all("SELECT slug, updated_at FROM posts WHERE status='published'").map((p) => ({
      loc: `/blog/${p.slug}`, pri: '0.7', freq: 'monthly', lastmod: new Date(p.updated_at).toISOString().slice(0, 10),
    })),
    ...q.all("SELECT slug FROM products WHERE status='active'").map((p) => ({
      loc: `/products/${p.slug}`, pri: '0.6', freq: 'monthly',
    })),
  ];
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map((u) => `  <url><loc>${escapeHtml(config.baseUrl + u.loc)}</loc>${
        u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''
      }<changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')
    }\n</urlset>\n`,
  );
});

router.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    version: require('../../package.json').version,
    adsense: ads.adsenseReady(),
  });
});

const DEFAULT_DISCLAIMER = 'Earnings depend on visitor country, device, traffic source, traffic quality, ad fill and the ad network in use. Rate-card figures are configurable estimates for planning only — they are not a guarantee, and your realised eCPM is the only number that matters. Validate against your own traffic before making commitments.';

module.exports = router;
module.exports.DEFAULT_DISCLAIMER = DEFAULT_DISCLAIMER;
