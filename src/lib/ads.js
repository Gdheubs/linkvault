'use strict';

/**
 * Ad + promo inventory.
 *
 * Slot types:
 *   banner / native / inarticle -> AdSense unit, custom network HTML, or house ad
 *   video                       -> YouTube embed (privacy-enhanced nocookie domain)
 *   popup / interstitial        -> modal promo, frequency-capped per session
 *
 * AdSense note: `provider: 'adsense'` slots render a real <ins class="adsbygoogle">
 * only when ADSENSE_ENABLED=true and ADSENSE_CLIENT is set. Until then they
 * render a labelled placeholder of the same dimensions so layout is identical
 * before and after approval — that avoids the classic "site looks broken while
 * under review" problem.
 */

const { q, settings } = require('../db');
const config = require('../config');
const { now, escapeHtml, weightedPick } = require('./util');

let cache = null;
let cacheAt = 0;

function allSlots() {
  if (cache && now() - cacheAt < 20000) return cache;
  cache = q.all('SELECT * FROM ad_slots WHERE enabled = 1 ORDER BY weight DESC, id ASC');
  cacheAt = now();
  return cache;
}
function invalidate() { cache = null; }

function slot(key) {
  return allSlots().find((s) => s.slot_key === key) || null;
}

function byPlacement(placement) {
  return allSlots().filter((s) => s.placement === placement || s.placement === 'both');
}

/** Pick one popup for a placement, respecting weights. */
function pickPopup(placement = 'gateway') {
  const list = byPlacement(placement).filter((s) => s.type === 'popup' || s.type === 'interstitial');
  return weightedPick(list);
}

function adsenseReady() {
  return Boolean(config.ads.adsenseEnabled && config.ads.adsenseClient);
}

const SIZE_HINTS = {
  banner: { min: 90, label: 'Leaderboard / responsive banner' },
  native: { min: 250, label: 'Native in-feed unit' },
  inarticle: { min: 250, label: 'In-article unit' },
  video: { min: 0, label: 'Video' },
  popup: { min: 0, label: 'Promo' },
  interstitial: { min: 0, label: 'Promo' },
};

/**
 * Render a slot to HTML. Returns '' for an unknown/disabled slot so callers can
 * drop it in unconditionally.
 */
function render(key, { step = 0 } = {}) {
  const s = typeof key === 'object' ? key : slot(key);
  if (!s) return '';

  const label = '<div class="ad-label">Advertisement</div>';
  const wrap = (inner, extra = '') =>
    `<div class="ad-slot ad-${escapeHtml(s.type)}" data-slot="${escapeHtml(s.slot_key)}" data-step="${step}"${extra}>${label}${inner}</div>`;

  if (s.provider === 'youtube' || s.type === 'video') {
    const id = String(s.youtube_id || '').trim();
    if (!id) return '';
    return `<div class="ad-slot ad-video" data-slot="${escapeHtml(s.slot_key)}" data-step="${step}">
      <div class="ad-video-head">
        <span class="ad-label">Featured video</span>
        ${s.headline ? `<span class="ad-video-title">${escapeHtml(s.headline)}</span>` : ''}
      </div>
      <div class="video-frame">
        <iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(id)}?rel=0&modestbranding=1"
          title="${escapeHtml(s.headline || 'Featured video')}"
          loading="lazy" referrerpolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen></iframe>
      </div>
      ${s.body ? `<p class="ad-video-body">${escapeHtml(s.body)}</p>` : ''}
    </div>`;
  }

  if (s.provider === 'house' || (!s.html && (s.headline || s.image))) {
    const href = s.href ? `/out/${encodeURIComponent(s.slot_key)}` : '#';
    return wrap(`<a class="house-ad" href="${href}" rel="nofollow sponsored noopener" target="_blank">
      ${s.image ? `<img src="${escapeHtml(s.image)}" alt="" loading="lazy">` : '<div class="house-ad-mark">◈</div>'}
      <div class="house-ad-copy">
        <strong>${escapeHtml(s.headline || s.name)}</strong>
        <span>${escapeHtml(s.body || '')}</span>
      </div>
      <span class="house-ad-go">Learn more →</span>
    </a>`);
  }

  if (s.provider === 'custom' && s.html) {
    // Operator-supplied network tag. Trusted: only an admin can write this field.
    return wrap(s.html);
  }

  if (s.provider === 'adsense') {
    if (!adsenseReady()) {
      const hint = SIZE_HINTS[s.type] || SIZE_HINTS.banner;
      return wrap(
        `<div class="ad-placeholder" style="min-height:${hint.min}px">
           <span class="ad-placeholder-mark">AdSense</span>
           <span class="ad-placeholder-text">${escapeHtml(hint.label)} · slot <code>${escapeHtml(s.slot_key)}</code></span>
           <span class="ad-placeholder-note">Set ADSENSE_CLIENT and ADSENSE_ENABLED=true to serve live ads here.</span>
         </div>`,
      );
    }
    // s.html holds the data-ad-slot id for this unit.
    const adSlotId = escapeHtml(String(s.html || '').trim());
    const format = s.type === 'inarticle'
      ? 'data-ad-layout="in-article" data-ad-format="fluid"'
      : s.type === 'native'
        ? 'data-ad-format="fluid" data-ad-layout-key="-6t+ed+2i-1n-4w"'
        : 'data-ad-format="auto" data-full-width-responsive="true"';
    return wrap(
      `<ins class="adsbygoogle" style="display:block"
         data-ad-client="${escapeHtml(config.ads.adsenseClient)}"
         ${adSlotId ? `data-ad-slot="${adSlotId}"` : ''}
         ${format}></ins>
       <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>`,
    );
  }

  return '';
}

function renderMany(keys, opts) {
  return (keys || []).map((k) => render(k, opts)).filter(Boolean).join('\n');
}

function recordImpression(visitId, slotKey, step = 0, viewable = 0) {
  if (visitId) {
    q.run(
      'INSERT INTO impressions (visit_id, slot_key, step_index, viewable, created_at) VALUES (?,?,?,?,?)',
      visitId, slotKey, step, viewable ? 1 : 0, now(),
    );
  }
  q.run('UPDATE ad_slots SET impressions = impressions + 1 WHERE slot_key = ?', slotKey);
}

function recordClick(slotKey) {
  q.run('UPDATE ad_slots SET clicks = clicks + 1 WHERE slot_key = ?', slotKey);
  return q.get('SELECT href FROM ad_slots WHERE slot_key = ?', slotKey);
}

/** The <head> loader tag; empty until AdSense is switched on. */
function headScript() {
  if (!adsenseReady()) return '';
  return `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escapeHtml(config.ads.adsenseClient)}" crossorigin="anonymous"></script>`;
}

function popupSettings() {
  return {
    enabled: settings.get('popup_enabled', true),
    delayMs: Number(settings.get('popup_delay_ms', 6000)),
    perSession: Number(settings.get('popup_per_session', 1)),
  };
}

module.exports = {
  allSlots, slot, byPlacement, pickPopup, render, renderMany,
  recordImpression, recordClick, headScript, adsenseReady, invalidate, popupSettings,
};
