/* LinkVault — gateway step engine.
 *
 * The flow, deliberately simple:
 *   1. A countdown runs at the top of the page (and mirrored at the bottom).
 *   2. The visitor reads / scrolls while it runs. Nothing is required of them.
 *   3. When it hits zero the Continue button at the bottom unlocks by itself.
 *   4. They scroll down and press it. On the last step it says "Get my link".
 *
 * No ad interaction is ever required, requested, or rewarded.
 *
 * This file is presentation only. The server re-checks elapsed time against
 * visit_steps.entered_at in POST /gw/advance, so editing anything here just
 * makes the page lie to itself — the request still returns 425 until the real
 * timer has run.
 */
(function () {
  'use strict';

  var cfg = window.LV_GATEWAY;
  if (!cfg) return;

  var startedAt = Date.now();
  var total = Math.max(0, cfg.waitSeconds);
  var unlocked = false;
  var advancing = false;
  var interactions = 0;
  var focusMs = 0;
  var focusSince = document.hasFocus() ? Date.now() : null;

  var $ = function (id) { return document.getElementById(id); };

  var progressBar = $('progressBar');
  var clockNum = $('clockNum');
  var clockRing = $('clockRing');
  var gwClock = $('gwClock');
  var gwStatus = $('gwStatus');
  var scrollLine = $('scrollLine');

  var gateRing = $('gateRing');
  var gateNum = $('gateNum');
  var gateUnit = $('gateUnit');
  var gateTitle = $('gateTitle');
  var gateSub = $('gateSub');
  var gateFoot = $('gateFoot');
  var gateFootNum = $('gateFootNum');
  var gateRingWrap = $('gateRingWrap');
  var btn = $('continueBtn');
  var nudge = $('scrollNudge');

  var sideNum = $('sideNum');
  var sideBar = $('sideBar');
  var sideHint = $('sideHint');

  function circ(el) { return el ? 2 * Math.PI * Number(el.getAttribute('r')) : 0; }
  var CLOCK_C = circ(clockRing);
  var GATE_C = circ(gateRing);
  if (clockRing) { clockRing.style.strokeDasharray = CLOCK_C; clockRing.style.strokeDashoffset = 0; }
  if (gateRing) { gateRing.style.strokeDasharray = GATE_C; gateRing.style.strokeDashoffset = 0; }

  // ---------- countdown ----------
  var lastWhole = -1;

  function tick() {
    var elapsed = (Date.now() - startedAt) / 1000;
    var left = Math.max(0, total - elapsed);
    var done = total > 0 ? Math.min(1, elapsed / total) : 1;
    var secs = Math.ceil(left);

    if (progressBar) progressBar.style.width = (done * 100).toFixed(2) + '%';
    if (clockRing) clockRing.style.strokeDashoffset = (CLOCK_C * done).toFixed(2);
    if (gateRing) gateRing.style.strokeDashoffset = (GATE_C * done).toFixed(2);
    if (sideBar) sideBar.style.width = (done * 100).toFixed(2) + '%';

    if (secs !== lastWhole) {
      lastWhole = secs;
      if (clockNum) clockNum.textContent = secs;
      if (gateNum) gateNum.textContent = secs;
      if (gateFootNum) gateFootNum.textContent = secs;
      if (sideNum) sideNum.textContent = secs + 's';
      // a small pulse each second keeps the countdown feeling alive
      if (gwClock && secs > 0) {
        gwClock.classList.remove('pulse');
        void gwClock.offsetWidth;
        gwClock.classList.add('pulse');
      }
    }

    if (left <= 0) { unlock(); return; }
    requestAnimationFrame(tick);
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;

    document.body.classList.add('gw-ready');
    if (gwStatus) gwStatus.classList.add('ready');
    if (gwClock) { gwClock.classList.add('done'); gwClock.classList.remove('pulse'); }
    if (clockNum) clockNum.textContent = '✓';

    if (gateRingWrap) gateRingWrap.classList.add('done');
    if (gateNum) gateNum.textContent = '✓';
    if (gateUnit) gateUnit.textContent = 'ready';
    if (gateTitle) gateTitle.textContent = cfg.isFinal ? 'Your link is ready' : 'You’re good to go';
    if (gateSub) {
      gateSub.textContent = cfg.isFinal
        ? 'Press the button below to get your link.'
        : 'Press Continue for the next step.';
    }
    if (gateFoot) gateFoot.hidden = true;
    if (sideNum) sideNum.textContent = 'Ready';
    if (sideBar) sideBar.style.width = '100%';
    if (sideHint) sideHint.textContent = 'Scroll down and press the button.';

    if (btn) {
      btn.disabled = false;
      btn.classList.add('ready');
    }
    maybeNudge();
  }

  if (total > 0) requestAnimationFrame(tick); else unlock();

  // ---------- "scroll down to continue" nudge ----------
  function gateVisible() {
    var gate = $('gate');
    if (!gate) return true;
    var r = gate.getBoundingClientRect();
    return r.top < (window.innerHeight - 90) && r.bottom > 0;
  }

  function maybeNudge() {
    if (!nudge) return;
    nudge.hidden = !(unlocked && !gateVisible());
  }

  if (nudge) {
    nudge.addEventListener('click', function () {
      var gate = $('gate');
      if (gate) gate.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // ---------- reading progress line ----------
  function onScroll() {
    if (scrollLine) {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      var p = h > 0 ? Math.min(1, window.scrollY / h) : 0;
      scrollLine.style.width = (p * 100).toFixed(2) + '%';
    }
    maybeNudge();
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  onScroll();

  // ---------- interaction / focus evidence (anti-fraud) ----------
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function () { interactions++; }, { passive: true });
  });
  window.addEventListener('scroll', function () { interactions++; }, { passive: true });

  window.addEventListener('focus', function () { focusSince = Date.now(); });
  window.addEventListener('blur', function () {
    if (focusSince) { focusMs += Date.now() - focusSince; focusSince = null; }
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (focusSince) { focusMs += Date.now() - focusSince; focusSince = null; }
    } else if (!focusSince) focusSince = Date.now();
  });
  function currentFocusMs() {
    return Math.round(focusMs + (focusSince ? Date.now() - focusSince : 0));
  }

  // ---------- advance ----------
  if (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (!unlocked || advancing) return;
      advancing = true;
      btn.disabled = true;
      btn.classList.add('loading');
      var label = $('continueLabel');
      var original = label ? label.textContent : '';
      if (label) label.textContent = cfg.isFinal ? 'Getting your link…' : 'Loading next step…';

      fetch('/gw/advance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: cfg.token,
          dwellMs: Date.now() - startedAt,
          interactions: interactions,
          focusMs: currentFocusMs(),
        }),
      })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (res) {
          if (res.body && res.body.next) { window.location.href = res.body.next; return; }
          reset(res.status === 425
            ? 'Just a moment longer…'
            : (res.body && res.body.message) || 'Something went wrong. Reopen the link.');
        })
        .catch(function () { reset('Network error. Check your connection.'); });

      function reset(msg) {
        advancing = false;
        btn.disabled = false;
        btn.classList.remove('loading');
        if (label) label.textContent = original;
        if (window.lvToast) window.lvToast(msg);
      }
    });
  }

  // ---------- anti-fraud probe ----------
  (function probe() {
    var markers = [];
    try {
      if (navigator.webdriver) markers.push('webdriver');
      if (window.callPhantom || window._phantom) markers.push('phantom');
      if (navigator.plugins && navigator.plugins.length === 0 && !/mobile|android|iphone/i.test(navigator.userAgent)) markers.push('no-plugins');
      if (!navigator.languages || navigator.languages.length === 0) markers.push('no-languages');
      if (window.outerWidth === 0 && window.outerHeight === 0) markers.push('zero-outer');
    } catch (e) { /* ignore */ }

    var fp = [
      navigator.userAgent, navigator.language, (navigator.languages || []).join(','),
      screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
      new Date().getTimezoneOffset(),
      navigator.hardwareConcurrency || 0,
      navigator.maxTouchPoints || 0,
      navigator.deviceMemory || 0,
    ].join('|');

    fetch('/gw/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        visitKey: cfg.visitKey,
        fp: fp,
        headless: markers.length >= 2,
        markers: markers,
        screen: screen.width + 'x' + screen.height,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        langs: (navigator.languages || []).join(','),
        touch: navigator.maxTouchPoints || 0,
      }),
      keepalive: true,
    }).catch(function () { /* non-fatal: the server scores NO_JS instead */ });
  })();

  // ---------- viewability beacons (ads + paid promotions) ----------
  if ('IntersectionObserver' in window) {
    var seenAds = {};
    var adObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var key = en.target.getAttribute('data-slot');
        if (!key || seenAds[key] || en.intersectionRatio < 0.5) return;
        seenAds[key] = true;
        fetch('/gw/impression', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visitKey: cfg.visitKey, slot: key, step: cfg.stepIndex, viewable: 1 }),
          keepalive: true,
        }).catch(function () { /* ignore */ });
      });
    }, { threshold: [0, 0.5, 1] });
    document.querySelectorAll('.ad-slot[data-slot]').forEach(function (s) { adObserver.observe(s); });

    var seenPromos = {};
    var promoObserver = new IntersectionObserver(function (entries) {
      var batch = [];
      entries.forEach(function (en) {
        var id = en.target.getAttribute('data-promo');
        if (!id || seenPromos[id] || en.intersectionRatio < 0.5) return;
        seenPromos[id] = true;
        batch.push(id);
      });
      if (batch.length) {
        fetch('/gw/promo-view', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visitKey: cfg.visitKey, ids: batch }),
          keepalive: true,
        }).catch(function () { /* ignore */ });
      }
    }, { threshold: [0, 0.5, 1] });
    document.querySelectorAll('[data-promo]').forEach(function (p) { promoObserver.observe(p); });
  }

  // ---------- promo popup ----------
  if (cfg.popup && cfg.popupDelayMs >= 0) {
    var KEY = 'lv-popup-' + (cfg.popupKey || 'x');
    var shown = 0;
    try { shown = parseInt(sessionStorage.getItem(KEY) || '0', 10); } catch (e) { /* ignore */ }
    if (shown < cfg.popupPerSession) {
      setTimeout(function () {
        var m = $('promoModal');
        if (!m) return;
        m.classList.add('on');
        try { sessionStorage.setItem(KEY, String(shown + 1)); } catch (e) { /* ignore */ }
      }, cfg.popupDelayMs);
    }
  }
})();
