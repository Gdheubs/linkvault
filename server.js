'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./src/config');
const { q, settings } = require('./src/db');
const mw = require('./src/middleware');
const util = require('./src/lib/util');
const auth = require('./src/lib/auth');
const tokens = require('./src/lib/tokens');
const revenue = require('./src/lib/revenue');
const campaigns = require('./src/lib/campaigns');
const promos = require('./src/lib/promos');
const ensureSeed = require('./src/db/seed');

const app = express();

// --- platform ---------------------------------------------------------------
if (config.trustProxy) app.set('trust proxy', config.trustProxy);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));
app.disable('x-powered-by');
app.set('etag', 'strong');

// Template helpers available in every view.
Object.assign(app.locals, {
  usd: util.usd,
  usdCompact: util.usdCompact,
  num: util.num,
  pct: util.pct,
  fmtDate: util.fmtDate,
  fmtBytes: util.fmtBytes,
  timeAgo: util.timeAgo,
  truncate: util.truncate,
  countryName: util.countryName,
  countryFlag: util.countryFlag,
  hostOf: util.hostOf,
  escapeHtml: util.escapeHtml,
  markdown: util.markdown,
});

// --- middleware --------------------------------------------------------------
app.use(mw.securityHeaders);
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: config.isProd ? '7d' : 0,
  etag: true,
}));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());
app.use(mw.context);
app.use(mw.session);
app.use(mw.flash);
app.use(mw.csrf);

// --- routes ------------------------------------------------------------------
// Gateway first: /s/:code must never be shadowed by the public :slug route.
app.use('/', require('./src/routes/gateway'));
app.use('/', require('./src/routes/auth'));
app.use('/dashboard', require('./src/routes/dashboard'));
app.use('/admin', require('./src/routes/admin'));
// Advertiser API mounts first so /api/v1/ads/* is not shadowed.
app.use('/api/v1/ads', require('./src/routes/ads-api'));
app.use('/api/v1', require('./src/routes/api'));
app.use('/webhooks', require('./src/routes/webhooks'));
// Public site last: it owns the catch-all /:slug for policy pages.
app.use('/', require('./src/routes/public'));

// --- 404 ---------------------------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).render('error', {
    title: 'Page not found',
    code: 404,
    message: 'That page does not exist. It may have been moved or removed.',
  });
});

// --- error handler -----------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, '\n', err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server_error' });
  res.status(500).render('error', {
    title: 'Something went wrong',
    code: 500,
    message: config.isProd
      ? 'An unexpected error occurred. It has been logged.'
      : String(err && err.message ? err.message : err),
  });
});

// --- background jobs ---------------------------------------------------------
function startJobs() {
  const every = (ms, name, fn) => {
    const run = () => {
      try { fn(); } catch (err) { console.error(`[job:${name}]`, err.message); }
    };
    const t = setInterval(run, ms);
    t.unref();
    return t;
  };

  // Release matured earnings into withdrawable balances.
  every(15 * 60000, 'release', () => {
    const released = revenue.releaseMatured();
    if (released > 0) console.log(`[job:release] ${util.usd(released)} released`);
  });

  // Housekeeping.
  every(60 * 60000, 'sweep', () => {
    auth.sweepSessions();
    tokens.sweepTokens();
  });

  // Activate paid promotions and retire the ones past their end date.
  every(15 * 60000, 'promos', () => {
    const expired = promos.sweep();
    if (expired > 0) console.log(`[job:promos] ${expired} promotion(s) expired`);
  });

  // Refresh rolling publisher fraud scores.
  every(30 * 60000, 'rescore', () => {
    const active = q.all(
      'SELECT DISTINCT publisher_id AS id FROM visits WHERE created_at > ?',
      util.now() - 24 * 3600000,
    );
    const fraud = require('./src/lib/fraud');
    for (const row of active) fraud.refreshPublisherScore(row.id);
  });
}

// --- storage safety check ----------------------------------------------------
/**
 * The worst failure mode for this app is deploying a container without mounting
 * a volume: it boots, seeds, serves traffic and reports healthy — then loses
 * every account and balance on the next deploy. Nothing surfaces the mistake.
 *
 * A mounted volume or bind mount is a different device from the image's root
 * filesystem, so comparing device ids catches it. This only warns: a false
 * positive on an unusual platform should not stop a deploy.
 */
function checkStorage() {
  if (!config.isProd) return;

  const dir = path.dirname(config.db.file);
  let mounted = null;
  try {
    mounted = fs.statSync(dir).dev !== fs.statSync(path.dirname(dir)).dev;
  } catch {
    return; // cannot tell; stay quiet rather than cry wolf
  }
  if (mounted !== false) return;

  const line = '─'.repeat(74);
  console.warn('');
  console.warn(line);
  console.warn('  WARNING: the database directory does not look like a mounted volume.');
  console.warn('');
  console.warn(`    ${dir}`);
  console.warn('');
  console.warn('  It appears to sit on the container filesystem, which is destroyed on');
  console.warn('  every deploy and restart. If that is right, you WILL lose every account,');
  console.warn('  link, file record and publisher balance the next time you deploy.');
  console.warn('');
  console.warn('  Fix: mount a persistent volume at this path.');
  console.warn('    Railway  Service -> Settings -> Volumes -> mount /app/data');
  console.warn('    Render   render.yaml already declares a disk; needs a paid plan');
  console.warn('    Docker   -v linkvault-data:/app/data');
  console.warn('');
  console.warn('  Ignore this only if you know your platform mounts storage differently.');
  console.warn(line);
  console.warn('');
}

// --- boot --------------------------------------------------------------------
function boot() {
  checkStorage();
  ensureSeed();
  campaigns.ensureDefault();

  const server = app.listen(config.port, config.host, () => {
    const admins = q.scalar("SELECT COUNT(*) FROM users WHERE role = 'admin'") || 0;
    console.log('');
    console.log(`  ${config.brand.name} is running`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  Local      ${config.baseUrl}`);
    console.log(`  Dashboard  ${config.baseUrl}/dashboard`);
    console.log(`  Admin      ${config.baseUrl}/admin   (${admins} admin account${admins === 1 ? '' : 's'})`);
    console.log(`  Mode       ${config.isProd ? 'production' : 'development'}`);
    console.log(`  AdSense    ${config.ads.adsenseEnabled && config.ads.adsenseClient ? 'live' : 'placeholders (not configured)'}`);
    console.log(`  Telegram   ${config.telegram.enabled ? 'configured' : 'not configured'}`);
    console.log(`  Skip mode  ${settings.get('skip_mode', config.monetization.skipMode)}`);
    console.log('');
    if (!config.isProd) {
      console.log('  Seeded admin: admin@linkvault.local / ChangeMe123');
      console.log('  Seeded publisher: demo@linkvault.local / Demo12345');
      console.log('');
    }
  });

  const shutdown = (signal) => {
    console.log(`\n[${signal}] shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  startJobs();
}

if (require.main === module) boot();

module.exports = app;
