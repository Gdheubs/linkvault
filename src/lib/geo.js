'use strict';

/**
 * Country / device / client classification.
 *
 * Country comes from an edge header when one is present — Cloudflare, Vercel,
 * Fastly, AWS CloudFront and App Engine all set one. There is no bundled GeoIP
 * database, so behind a plain origin server the country is 'XX' (Unknown) and
 * the rate card falls back to its wildcard row. Put the app behind Cloudflare
 * (free tier sets CF-IPCountry) to get real country breakdowns.
 */

const GEO_HEADERS = [
  'cf-ipcountry',            // Cloudflare
  'x-vercel-ip-country',     // Vercel
  'x-country-code',          // Fastly / generic
  'x-appengine-country',     // Google App Engine
  'cloudfront-viewer-country', // AWS CloudFront
  'x-geo-country',           // custom / nginx geoip module
];

function countryFrom(req) {
  for (const h of GEO_HEADERS) {
    const v = req.headers[h];
    if (v && /^[A-Za-z]{2}$/.test(v) && v.toUpperCase() !== 'T1') return v.toUpperCase();
  }
  return 'XX';
}

function clientIp(req) {
  const fwd = req.headers['cf-connecting-ip']
    || req.headers['true-client-ip']
    || req.headers['x-real-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0];
  const ip = (fwd || req.socket?.remoteAddress || '').trim();
  return ip.replace(/^::ffff:/, '');
}

const BOT_RE = /(bot|crawler|spider|crawling|slurp|curl|wget|python-requests|httpclient|okhttp|libwww|java\/|go-http|axios|node-fetch|scrapy|headless|phantomjs|puppeteer|playwright|selenium|lighthouse|gtmetrix|pingdom|uptimerobot|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|facebookexternalhit|whatsapp|telegrambot|discordbot|twitterbot|linkedinbot|preview|monitoring)/i;

/** Legitimate previewers that fetch a URL for an unfurl card, not real traffic. */
const PREVIEW_RE = /(facebookexternalhit|whatsapp|telegrambot|discordbot|twitterbot|linkedinbot|slackbot|skypeuripreview|embedly|quora link preview|vkshare|redditbot|pinterest)/i;

function parseUa(ua = '') {
  const s = String(ua);
  const isTablet = /ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(s);
  const isMobile = !isTablet && /mobile|iphone|ipod|android|blackberry|opera mini|iemobile|webos/i.test(s);
  const device = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop';

  let os = 'Unknown';
  if (/windows nt 10/i.test(s)) os = 'Windows 10/11';
  else if (/windows nt/i.test(s)) os = 'Windows';
  else if (/android[ /]([\d.]+)/i.test(s)) os = `Android ${(s.match(/android[ /]([\d.]+)/i) || [])[1] || ''}`.trim();
  else if (/iphone os ([\d_]+)|cpu os ([\d_]+)/i.test(s)) {
    const m = s.match(/(?:iphone )?os ([\d_]+)/i);
    os = `iOS ${(m ? m[1] : '').replace(/_/g, '.')}`.trim();
  } else if (/mac os x/i.test(s)) os = 'macOS';
  else if (/cros/i.test(s)) os = 'ChromeOS';
  else if (/linux/i.test(s)) os = 'Linux';

  let browser = 'Unknown';
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/samsungbrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/ucbrowser/i.test(s)) browser = 'UC Browser';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/chrome\/|crios/i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s)) browser = 'Safari';

  return {
    device,
    os,
    browser,
    isBot: BOT_RE.test(s),
    isPreview: PREVIEW_RE.test(s),
    empty: !s.trim(),
  };
}

/** Everything the visit row and the fraud engine need, computed once per request. */
function classify(req) {
  const ua = String(req.get('user-agent') || '');
  const parsed = parseUa(ua);
  return {
    ip: clientIp(req),
    ua,
    country: countryFrom(req),
    ...parsed,
    lang: String(req.get('accept-language') || ''),
    referer: String(req.get('referer') || req.get('referrer') || '').slice(0, 500),
    acceptsHtml: /text\/html/i.test(String(req.get('accept') || '')),
    dnt: req.get('dnt') === '1',
  };
}

module.exports = { classify, clientIp, countryFrom, parseUa, BOT_RE, PREVIEW_RE };
