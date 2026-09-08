/* LinkVault — hand-rolled SVG charts. No charting library.
   Usage:  <div class="chart-wrap" data-chart='{"type":"area","series":[...],"x":"label","y":"clicks"}'></div>
*/
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    return n;
  }
  function fmt(v, kind) {
    if (kind === 'money') {
      return '$' + (v / 1000000).toLocaleString('en-US', { minimumFractionDigits: v >= 1000000 ? 2 : 4, maximumFractionDigits: v >= 1000000 ? 2 : 4 });
    }
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
    return String(Math.round(v));
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  function render(host) {
    var cfg;
    try { cfg = JSON.parse(host.getAttribute('data-chart')); } catch (e) { return; }
    var data = cfg.series || [];
    if (!data.length) {
      host.innerHTML = '<div class="empty"><div class="empty-mark">◔</div>No data in this range yet.</div>';
      return;
    }

    var W = host.clientWidth || 640;
    var H = cfg.height || (host.classList.contains('chart-sm') ? 150 : 260);
    var pad = { t: 14, r: 12, b: 26, l: 46 };
    var iw = Math.max(10, W - pad.l - pad.r);
    var ih = Math.max(10, H - pad.t - pad.b);

    var yKey = cfg.y || 'value';
    var y2Key = cfg.y2;
    var xKey = cfg.x || 'label';
    var kind = cfg.format || 'number';

    var values = data.map(function (d) { return Number(d[yKey]) || 0; });
    var maxRaw = Math.max.apply(null, values);
    if (y2Key) maxRaw = Math.max(maxRaw, Math.max.apply(null, data.map(function (d) { return Number(d[y2Key]) || 0; })));
    var max = niceMax(maxRaw || 1);

    var svg = el('svg', { class: 'chart' + (cfg.height ? '' : ''), viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', width: '100%', height: H });

    // gradients
    var defs = el('defs');
    var lg = el('linearGradient', { id: 'lvGrad' + Math.random().toString(36).slice(2, 7), x1: '0', y1: '0', x2: '0', y2: '1' });
    var gid = lg.getAttribute('id');
    lg.appendChild(el('stop', { offset: '0%', 'stop-color': 'var(--brand)', 'stop-opacity': '.34' }));
    lg.appendChild(el('stop', { offset: '100%', 'stop-color': 'var(--brand)', 'stop-opacity': '0' }));
    defs.appendChild(lg);
    var bg = el('linearGradient', { id: 'lvBar' + gid, x1: '0', y1: '0', x2: '0', y2: '1' });
    bg.appendChild(el('stop', { offset: '0%', 'stop-color': 'var(--brand)' }));
    bg.appendChild(el('stop', { offset: '100%', 'stop-color': 'var(--brand-2)', 'stop-opacity': '.65' }));
    defs.appendChild(bg);
    svg.appendChild(defs);

    // gridlines + y axis
    var grid = el('g', { class: 'chart-grid' });
    var TICKS = 4;
    for (var i = 0; i <= TICKS; i++) {
      var yy = pad.t + (ih / TICKS) * i;
      grid.appendChild(el('line', { x1: pad.l, y1: yy, x2: W - pad.r, y2: yy }));
      var label = el('text', { x: pad.l - 8, y: yy + 3.5, class: 'chart-axis', 'text-anchor': 'end' });
      label.textContent = fmt(max * (1 - i / TICKS), kind);
      grid.appendChild(label);
    }
    svg.appendChild(grid);

    var xAt = function (i) { return pad.l + (data.length === 1 ? iw / 2 : (iw / (data.length - 1)) * i); };
    var yAt = function (v) { return pad.t + ih - (Math.max(0, v) / max) * ih; };

    if (cfg.type === 'bar') {
      var bw = Math.max(2, (iw / data.length) * 0.62);
      data.forEach(function (d, i) {
        var v = Number(d[yKey]) || 0;
        var x = pad.l + (iw / data.length) * i + (iw / data.length - bw) / 2;
        var h = Math.max(v > 0 ? 2 : 0, (v / max) * ih);
        svg.appendChild(el('rect', {
          class: 'chart-bar', x: x, y: pad.t + ih - h, width: bw, height: h,
          fill: 'url(#' + bg.getAttribute('id') + ')', rx: 3,
        }));
      });
    } else {
      var line = data.map(function (d, i) { return (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(Number(d[yKey]) || 0).toFixed(1); }).join(' ');
      if (cfg.type !== 'line') {
        svg.appendChild(el('path', {
          d: line + ' L' + xAt(data.length - 1).toFixed(1) + ' ' + (pad.t + ih) + ' L' + xAt(0).toFixed(1) + ' ' + (pad.t + ih) + ' Z',
          fill: 'url(#' + gid + ')',
        }));
      }
      svg.appendChild(el('path', { d: line, class: 'chart-line' }));

      if (y2Key) {
        var line2 = data.map(function (d, i) { return (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(Number(d[y2Key]) || 0).toFixed(1); }).join(' ');
        svg.appendChild(el('path', { d: line2, class: 'chart-line-2' }));
      }
    }

    // x axis labels (thinned so they never collide)
    var everyN = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 62))));
    data.forEach(function (d, i) {
      if (i % everyN !== 0 && i !== data.length - 1) return;
      var t = el('text', { x: xAt(i), y: H - 8, class: 'chart-axis', 'text-anchor': 'middle' });
      t.textContent = d[xKey];
      svg.appendChild(t);
    });

    // hover layer
    var dot = el('circle', { class: 'chart-dot', r: 4.5, cx: -20, cy: -20, opacity: 0 });
    svg.appendChild(dot);

    host.innerHTML = '';
    host.appendChild(svg);

    var tip = document.createElement('div');
    tip.className = 'chart-tip';
    host.appendChild(tip);

    svg.addEventListener('mousemove', function (ev) {
      var rect = svg.getBoundingClientRect();
      var px = ((ev.clientX - rect.left) / rect.width) * W;
      var idx = Math.round(((px - pad.l) / iw) * (data.length - 1));
      idx = Math.max(0, Math.min(data.length - 1, idx));
      var d = data[idx];
      var cx = xAt(idx);
      var cy = yAt(Number(d[yKey]) || 0);
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('opacity', 1);
      tip.classList.add('on');
      tip.style.left = ((cx / W) * rect.width) + 'px';
      tip.style.top = ((cy / H) * rect.height) + 'px';
      var rows = '<strong>' + d[xKey] + '</strong>';
      rows += '<br>' + (cfg.yLabel || yKey) + ': <b>' + fmt(Number(d[yKey]) || 0, kind) + '</b>';
      if (y2Key) rows += '<br>' + (cfg.y2Label || y2Key) + ': <b>' + fmt(Number(d[y2Key]) || 0, cfg.format2 || 'number') + '</b>';
      tip.innerHTML = rows;
    });
    svg.addEventListener('mouseleave', function () {
      dot.setAttribute('opacity', 0);
      tip.classList.remove('on');
    });
  }

  function sparkline(host) {
    var pts;
    try { pts = JSON.parse(host.getAttribute('data-spark')); } catch (e) { return; }
    if (!pts || pts.length < 2) return;
    var W = 120, H = 46;
    var max = Math.max.apply(null, pts) || 1;
    var d = pts.map(function (v, i) {
      return (i ? 'L' : 'M') + ((W / (pts.length - 1)) * i).toFixed(1) + ' ' + (H - (v / max) * (H - 6) - 3).toFixed(1);
    }).join(' ');
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'stat-spark' });
    var defs = el('defs');
    var id = 'sp' + Math.random().toString(36).slice(2, 8);
    var g = el('linearGradient', { id: id, x1: '0', y1: '0', x2: '0', y2: '1' });
    g.appendChild(el('stop', { offset: '0%', 'stop-color': 'var(--brand)', 'stop-opacity': '.4' }));
    g.appendChild(el('stop', { offset: '100%', 'stop-color': 'var(--brand)', 'stop-opacity': '0' }));
    defs.appendChild(g); svg.appendChild(defs);
    svg.appendChild(el('path', { d: d + ' L' + W + ' ' + H + ' L0 ' + H + ' Z', fill: 'url(#' + id + ')' }));
    svg.appendChild(el('path', { d: d, fill: 'none', stroke: 'var(--brand)', 'stroke-width': '1.8', 'stroke-linecap': 'round' }));
    host.appendChild(svg);
  }

  function donut(host) {
    var cfg;
    try { cfg = JSON.parse(host.getAttribute('data-donut')); } catch (e) { return; }
    var slices = cfg.slices || [];
    var total = slices.reduce(function (s, x) { return s + (Number(x.value) || 0); }, 0);
    var R = 52, C = 2 * Math.PI * R;
    var svg = el('svg', { viewBox: '0 0 132 132', class: 'donut' });
    svg.appendChild(el('circle', { class: 'track', cx: 66, cy: 66, r: R }));
    var offset = 0;
    var palette = ['var(--brand)', 'var(--brand-2)', 'var(--brand-3)', 'var(--info)', 'var(--warn)', 'var(--danger)', 'var(--text-3)'];
    slices.forEach(function (s, i) {
      var frac = total ? (Number(s.value) || 0) / total : 0;
      if (frac <= 0) return;
      var c = el('circle', {
        class: 'val', cx: 66, cy: 66, r: R,
        stroke: s.color || palette[i % palette.length],
        'stroke-dasharray': (frac * C).toFixed(2) + ' ' + C,
        'stroke-dashoffset': (-offset * C).toFixed(2),
      });
      svg.appendChild(c);
      offset += frac;
    });
    host.innerHTML = '';
    host.appendChild(svg);
  }

  function boot() {
    document.querySelectorAll('[data-chart]').forEach(render);
    document.querySelectorAll('[data-spark]').forEach(sparkline);
    document.querySelectorAll('[data-donut]').forEach(donut);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { document.querySelectorAll('[data-chart]').forEach(render); }, 220);
  });
})();
