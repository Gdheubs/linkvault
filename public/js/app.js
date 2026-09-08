/* LinkVault — shared UI behaviour. No framework, no CDN. */
(function () {
  'use strict';

  // ---------- theme ----------
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem('lv-theme');
    if (saved) root.setAttribute('data-theme', saved);
    else if (window.matchMedia('(prefers-color-scheme: light)').matches) root.setAttribute('data-theme', 'light');
  } catch (e) { /* private mode */ }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-theme-toggle]');
    if (!t) return;
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('lv-theme', next); } catch (err) { /* ignore */ }
  });

  // ---------- copy to clipboard ----------
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    var value = btn.getAttribute('data-copy');
    if (value === '' || value === 'self') {
      var input = btn.closest('.copy') && btn.closest('.copy').querySelector('input');
      value = input ? input.value : '';
    }
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('btn-ok');
      setTimeout(function () { btn.textContent = old; btn.classList.remove('btn-ok'); }, 1600);
      toast('Copied to clipboard');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done).catch(fallback);
    } else fallback();

    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* ignore */ }
      document.body.removeChild(ta);
    }
  });

  // ---------- confirm-before-submit ----------
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // ---------- toast ----------
  var toastEl = null;
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(function () { toastEl.classList.add('on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2400);
  }
  window.lvToast = toast;

  // ---------- auto-dismiss flash ----------
  var flash = document.querySelector('.flash');
  if (flash) setTimeout(function () { flash.style.transition = 'opacity .4s'; flash.style.opacity = '0'; setTimeout(function () { flash.remove(); }, 400); }, 5200);

  // ---------- scroll reveal ----------
  var reveals = document.querySelectorAll('.reveal');
  if (reveals.length && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en, i) {
        if (!en.isIntersecting) return;
        setTimeout(function () { en.target.classList.add('in'); }, Math.min(i * 60, 300));
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: .08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  // ---------- animated counters ----------
  document.querySelectorAll('[data-count]').forEach(function (el) {
    var target = parseFloat(el.getAttribute('data-count')) || 0;
    var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var prefix = el.getAttribute('data-prefix') || '';
    var suffix = el.getAttribute('data-suffix') || '';
    var dur = 1100;
    var start = null;
    if (target === 0) return;

    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      var v = target * eased;
      el.textContent = prefix + v.toLocaleString('en-US', {
        minimumFractionDigits: decimals, maximumFractionDigits: decimals,
      }) + suffix;
      if (p < 1) requestAnimationFrame(step);
    }
    if ('IntersectionObserver' in window) {
      var o = new IntersectionObserver(function (en) {
        if (en[0].isIntersecting) { requestAnimationFrame(step); o.disconnect(); }
      }, { threshold: .4 });
      o.observe(el);
    } else requestAnimationFrame(step);
  });

  // ---------- modal open/close ----------
  document.addEventListener('click', function (e) {
    var open = e.target.closest('[data-modal-open]');
    if (open) {
      e.preventDefault();
      var m = document.getElementById(open.getAttribute('data-modal-open'));
      if (m) m.classList.add('on');
      return;
    }
    if (e.target.closest('[data-modal-close]') || e.target.classList.contains('modal-back')) {
      var back = e.target.closest('.modal-back');
      if (back) back.classList.remove('on');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-back.on').forEach(function (m) { m.classList.remove('on'); });
    }
  });

  // ---------- forms that prefill a modal from a row ----------
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-fill]');
    if (!btn) return;
    var data = JSON.parse(btn.getAttribute('data-fill'));
    var form = document.querySelector(btn.getAttribute('data-fill-form'));
    if (!form) return;
    Object.keys(data).forEach(function (k) {
      var field = form.elements[k];
      if (!field) return;
      if (field.type === 'checkbox') field.checked = Boolean(data[k]);
      else field.value = data[k] == null ? '' : data[k];
    });
  });

  // ---------- tab panels ----------
  document.querySelectorAll('[data-tabs]').forEach(function (group) {
    var buttons = group.querySelectorAll('[data-tab]');
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-tab');
        buttons.forEach(function (x) { x.classList.toggle('on', x === b); });
        document.querySelectorAll('[data-panel]').forEach(function (p) {
          if (p.closest('[data-tabs]') !== group && group.contains(p) === false && p.getAttribute('data-panel-group') !== group.getAttribute('data-tabs')) return;
          p.classList.toggle('hide', p.getAttribute('data-panel') !== name);
        });
      });
    });
  });

  // ---------- promoted-content viewability ----------
  // The gateway has its own richer beacon; this covers blog and site pages.
  if ('IntersectionObserver' in window && !window.LV_GATEWAY) {
    var promoNodes = document.querySelectorAll('[data-promo]');
    if (promoNodes.length) {
      var seenPromos = {};
      var surface = /^\/blog/.test(location.pathname) ? 'blog' : 'site';
      var po = new IntersectionObserver(function (entries) {
        var batch = [];
        entries.forEach(function (en) {
          var id = en.target.getAttribute('data-promo');
          if (!id || seenPromos[id] || en.intersectionRatio < 0.5) return;
          seenPromos[id] = true;
          batch.push(id);
        });
        if (!batch.length) return;
        fetch('/promo-view', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: batch, surface: surface }),
          keepalive: true,
        }).catch(function () { /* a missed impression count is not worth an error */ });
      }, { threshold: [0, 0.5, 1] });
      promoNodes.forEach(function (n) { po.observe(n); });
    }
  }

  // ---------- meters animate from 0 ----------
  requestAnimationFrame(function () {
    document.querySelectorAll('[data-meter]').forEach(function (el) {
      el.style.width = el.getAttribute('data-meter') + '%';
    });
  });
})();
