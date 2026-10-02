/*
 * MK.charts - the only place in the mockup that talks to ECharts.
 *
 * One call builds a chart card: header (title, subtitle, measure / grouping controls, Chart | Table
 * toggle), legend, plot, optional note, and a table twin of the same data. The house style of
 * SPEC section 4 is applied here so page code never writes ECharts options:
 * thin bars, 2px lines, hairline solid grid, ink text, one y-axis, tooltips with values first.
 *
 * Depends on: kernel.js (MK.fmt, MK.session), the global `echarts` (vendor/echarts.min.js) and the DOM.
 * Colours are never written here - they are read from css/tokens.css through token().
 * Full contract for page authors: docs/CHARTS-API.md
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});
  var doc = root.document;
  if (!doc) return; /* browser only */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var DEFAULT_HEIGHT = 280;
  var KINDS = ['line', 'area', 'bar', 'hbar', 'stackedBar', 'hstackedBar', 'heatmap', 'waterfall', 'scatter', 'divergingBar'];
  var SEQ_STEPS = ['100', '150', '200', '250', '300', '350', '400', '450', '500', '550', '600', '650', '700'];
  var BAR_MAX = 24;          /* px, mark spec */
  var FS_AXIS = 11;          /* px, canvas text sizes */
  var FS_LABEL = 11;
  var SERIES_PREFIX = 'mk:'; /* ECharts series id = prefix + caller's series id */
  var HEAT_LABEL_ALL = 40;   /* heatmaps with more cells label only the peak of each row */

  /* ------------------------------------------------------------------ small utils */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v) { return isNum(v) ? v : null; }
  function strings(arr) { return (arr || []).map(function (x) { return x === null || x === undefined ? '' : String(x); }); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function assign(target, src) { if (src) Object.keys(src).forEach(function (k) { target[k] = src[k]; }); return target; }

  function el(tag, className, text) {
    var n = doc.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function svg(tag, attrs) {
    var n = doc.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function empty(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var warned = {};
  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    if (root.console && root.console.warn) root.console.warn('[MK.charts] ' + msg);
  }

  /* ------------------------------------------------------------------ tokens and colour */

  var tokenCache = {};

  /** Read a CSS custom property from :root. Accepts '--name', 'name' or 'var(--name)'. Cached once non-empty. */
  function token(name) {
    if (!name) return '';
    var key = String(name).trim();
    var m = /^var\(\s*(--[^,)\s]+)/.exec(key);
    if (m) key = m[1];
    if (key.charAt(0) !== '-') key = '--' + key;
    if (tokenCache[key]) return tokenCache[key];
    var v = root.getComputedStyle(doc.documentElement).getPropertyValue(key).trim();
    if (v) tokenCache[key] = v;
    return v;
  }

  /** Token name for an entity. Returns the custom-property NAME (e.g. '--ch-swiggy'), usable as colourVar or in var(). */
  function colourFor(kind, idOrIndex) {
    var ids, i;
    switch (kind) {
      case 'channel': return '--ch-' + idOrIndex;
      case 'medium': return '--md-' + idOrIndex;
      case 'factory': return '--ot-factory';
      case 'outlet':
        if (idOrIndex === 'factory') return '--ot-factory';
        ids = (MK.session && MK.session.OUTLET_IDS) || [];
        i = typeof idOrIndex === 'number' ? idOrIndex : ids.indexOf(idOrIndex);
        if (i >= 0 && i < 5) return '--ot-' + (i + 1);
        warnOnce('outlet:' + idOrIndex, 'Unknown outlet "' + idOrIndex + '" - using the muted colour.');
        return '--series-muted';
      default:
        i = +idOrIndex;
        if (i >= 0 && i <= 7 && i === Math.floor(i)) return '--series-' + (i + 1);
        warnOnce('series-overflow', 'More than 8 categorical series requested. Extra series are drawn muted - fold the tail into "Other" or use a table.');
        return '--series-muted';
    }
  }

  /** Resolve a colourVar ('--x' | 'var(--x)') to the computed colour. Falls back to the muted token, never to a generated hue. */
  function resolveColour(colourVar) {
    var v = token(colourVar);
    if (!v) {
      warnOnce('missing:' + colourVar, 'Token "' + colourVar + '" is not defined in css/tokens.css - using the muted colour.');
      v = token('--series-muted');
    }
    return v;
  }

  function cssVar(colourVar) {
    var key = String(colourVar || '').trim();
    if (/^var\(/.test(key)) return key;
    return 'var(' + (key.charAt(0) === '-' ? key : '--' + key) + ')';
  }

  var themeCache = null;
  function theme() {
    if (themeCache) return themeCache;
    var t = {
      font: token('--font') || 'sans-serif',
      ink: token('--ink'), ink2: token('--ink-2'), ink3: token('--ink-3'),
      grid: token('--grid'), axis: token('--axis'), surface: token('--surface'),
      muted: token('--series-muted'),
      single: '--series-1',
      total: '--ink-2', plus: '--seq-500', minus: '--div-neg-2',
      pos: '--div-pos-2', neg: '--div-neg-2'
    };
    if (t.ink && t.surface) themeCache = t; /* cache only once the stylesheet has applied */
    return t;
  }

  function parseRgb(str) {
    var s = String(str || '').trim(), m;
    if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s))) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16)];
    if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s))) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    if ((m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s))) return [+m[1], +m[2], +m[3]];
    return null;
  }
  function luminance(rgb) {
    var c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrastOf(l1, l2) { return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }

  /** Text colour for a label drawn inside a coloured fill: ink or surface, whichever reads better. */
  function inkOn(fill) {
    var T = theme(), f = parseRgb(fill), a = parseRgb(T.ink), b = parseRgb(T.surface);
    if (!f || !a || !b) return T.ink;
    var lf = luminance(f);
    return contrastOf(lf, luminance(a)) >= contrastOf(lf, luminance(b)) ? T.ink : T.surface;
  }

  function seqRamp() { return SEQ_STEPS.map(function (s) { return token('--seq-' + s); }); }

  /** Colour on the sequential ramp at t in 0..1 (same linear interpolation visualMap applies). */
  function rampAt(ramp, t) {
    var pos = clamp(t, 0, 1) * (ramp.length - 1);
    var i = Math.min(ramp.length - 2, Math.floor(pos)), f = pos - i;
    var a = parseRgb(ramp[i]), b = parseRgb(ramp[i + 1]);
    if (!a || !b) return ramp[i] || '';
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }

  /* ------------------------------------------------------------------ formats */

  function smartDecimals(v) { return Math.abs(v) < 100 && v !== Math.round(v) ? 1 : 0; }

  /* The top tick ECharts gives a zero-based value axis (its "nice" interval: 1, 2, 3, 5 x 10^k, rounded up to a multiple). */
  function niceTop(maxVal, splitNumber) {
    if (!(maxVal > 0)) return 0;
    var raw = maxVal / (splitNumber || 4);
    var pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / pow;
    var step = (f < 1.5 ? 1 : f < 2.5 ? 2 : f < 4 ? 3 : f < 7 ? 5 : 10) * pow;
    return Math.ceil(maxVal / step - 1e-9) * step;
  }

  /*
   * One unit per rupee axis. The unit follows the TOP TICK, not the largest value: sales of 0.98 crore still get a
   * 1 crore tick, and that axis must read 0.25 / 0.5 / 0.75 / 1 Cr rather than 25 L / 50 L / 75 L / 1 Cr.
   * Crore axis -> every tick in crore; lakh axis -> every tick in lakh; below that, plain rupees.
   */
  function inrAxis(v, scaleMax) {
    var a = Math.abs(v), sign = v < 0 ? '-' : '';
    var top = Math.max(scaleMax || 0, niceTop(scaleMax || 0, 4));
    if (top >= 1e7 && a > 0 && a < 1e7) return sign + MK.fmt.rupee + String(+(a / 1e7).toFixed(2)) + ' Cr';
    if (top >= 1e5 && a > 0 && a < 1e5) return sign + MK.fmt.rupee + String(+(a / 1e5).toFixed(2)) + ' L';
    return MK.fmt.inr(v);
  }

  /**
   * format -> function (value, where, scaleMax) with where in 'axis' | 'label' | 'tooltip' | 'table'.
   * 'inr' is compact everywhere except the table, which shows full rupees; scaleMax is the largest
   * value on the axis.
   */
  function makeFormatter(format) {
    var F = MK.fmt;
    if (typeof format === 'function') {
      return function (v, where) { return v === null || v === undefined || (typeof v === 'number' && isNaN(v)) ? '-' : String(format(v, where)); };
    }
    switch (format) {
      case 'inr': return function (v, where, scaleMax) { return where === 'table' ? F.inrFull(v) : (where === 'axis' ? inrAxis(v, scaleMax) : F.inr(v)); };
      case 'inrFull': return function (v, where, scaleMax) { return where === 'axis' ? inrAxis(v, scaleMax) : (where === 'label' ? F.inr(v) : F.inrFull(v)); };
      case 'pct': return function (v, where) {
        if (where === 'axis') return F.pct(v, 1).replace(/\.0%$/, '%');
        return F.pct(v, 1);
      };
      case 'kg': return function (v) { return isNum(v) ? F.kg(v, smartDecimals(v)) : '-'; };
      default: return function (v) { return isNum(v) ? F.num(v, smartDecimals(v)) : '-'; };
    }
  }

  function signedWith(fmt) {
    return function (v, where, scaleMax) { var s = fmt(v, where, scaleMax); return isNum(v) && v > 0 ? '+' + s : s; };
  }

  function wholeStep(format, lists) {
    if (format !== undefined && format !== null && format !== 'num') return undefined;
    var whole = lists.every(function (list) { return (list || []).every(function (v) { return !isNum(v) || v === Math.round(v); }); });
    return whole ? 1 : undefined;
  }

  function maxAbsOf(list) {
    var m = 0;
    list.forEach(function (v) { if (isNum(v) && Math.abs(v) > m) m = Math.abs(v); });
    return m;
  }

  /* ------------------------------------------------------------------ text measurement */

  var measureCtx;
  function textWidth(text, size, weight) {
    if (measureCtx === undefined) {
      try { measureCtx = doc.createElement('canvas').getContext('2d'); } catch (e) { measureCtx = null; }
    }
    var s = String(text);
    if (!measureCtx) return s.length * size * 0.56;
    measureCtx.font = (weight || 400) + ' ' + size + 'px ' + theme().font;
    return measureCtx.measureText(s).width;
  }
  function maxTextWidth(list, size) {
    var w = 0;
    list.forEach(function (t) { w = Math.max(w, textWidth(t, size)); });
    return Math.ceil(w);
  }

  /* ------------------------------------------------------------------ icons */

  function icon(name) {
    var s = svg('svg', { viewBox: '0 0 16 16', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
    var paths = {
      chart: 'M2.5 13.5h11M4.5 11V7.5M8 11V3.5M11.5 11V6',
      table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9',
      prev: 'M9.5 3.5L5 8l4.5 4.5',
      next: 'M6.5 3.5L11 8l-4.5 4.5'
    };
    s.appendChild(svg('path', { d: paths[name] || '' }));
    return s;
  }

  /* ------------------------------------------------------------------ tooltip DOM (text nodes only) */

  function tipBox(headText, subText) {
    var box = el('div', 'mk-tip__in');
    if (headText) box.appendChild(el('div', 'mk-tip__head', headText));
    if (subText) box.appendChild(el('div', 'mk-tip__sub', subText));
    var rows = el('div', 'mk-tip__rows');
    box.appendChild(rows);
    var api = {
      node: box,
      /** value first, then name; colour draws a short line key */
      row: function (colour, valueText, nameText, opts) {
        var o = opts || {};
        var cls = (o.active ? ' is-active' : '') + (o.total ? ' is-total' : '');
        var key = el('span', 'mk-tip__key' + cls);
        if (colour) { var stroke = el('i'); stroke.style.background = colour; key.appendChild(stroke); }
        rows.appendChild(key);
        rows.appendChild(el('span', 'mk-tip__val' + cls, valueText));
        rows.appendChild(el('span', 'mk-tip__name' + cls, nameText));
        return api;
      },
      foot: function (text) { box.appendChild(el('div', 'mk-tip__foot', text)); return api; }
    };
    return api;
  }

  function tooltipOption(trigger, formatter) {
    var T = theme();
    return {
      show: true,
      trigger: trigger,
      appendToBody: true,
      confine: true,
      className: 'mk-tip',
      backgroundColor: T.surface,
      borderWidth: 0,
      padding: 0,
      transitionDuration: 0.1,
      textStyle: { color: T.ink, fontFamily: T.font, fontSize: 12 },
      extraCssText: 'box-shadow: var(--shadow-pop); border-radius: 8px;',
      axisPointer: trigger === 'axis'
        ? { type: 'line', snap: true, z: 1, label: { show: false }, lineStyle: { color: T.ink3, width: 1, type: 'solid' }, crossStyle: { color: T.ink3, width: 1, type: 'solid' } }
        : { type: 'none' },
      formatter: formatter
    };
  }

  /* ------------------------------------------------------------------ axes and grid */

  function categoryAxis(labels, o) {
    var T = theme();
    o = o || {};
    return {
      type: 'category',
      data: labels,
      z: 5, /* the baseline stays continuous over the bars' surface-coloured edges */
      inverse: !!o.inverse,
      boundaryGap: o.boundaryGap !== false,
      axisLine: { show: o.line !== false, lineStyle: { color: T.axis, width: 1 } },
      axisTick: { show: false },
      splitLine: { show: false },
      /* fontFamily is repeated on purpose: ECharts sizes containLabel from the label's own font, not the global one */
      axisLabel: assign({ color: T.ink3, fontFamily: T.font, fontSize: FS_AXIS, margin: 10, hideOverlap: true }, o.label)
    };
  }

  function valueAxis(fmt, o) {
    var T = theme();
    o = o || {};
    var axis = {
      type: 'value',
      scale: o.zero === false,
      splitNumber: o.splitNumber || 4,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: true, lineStyle: { color: T.grid, width: 1, type: 'solid' } },
      axisLabel: assign({ color: T.ink3, fontFamily: T.font, fontSize: FS_AXIS, margin: 8, hideOverlap: true, formatter: function (v) { return fmt(v, 'axis', o.scaleMax || 0); } }, o.label)
    };
    if (o.min !== undefined) axis.min = o.min;
    if (o.max !== undefined) axis.max = o.max;
    if (o.interval !== undefined) axis.interval = o.interval;
    if (o.minInterval !== undefined) axis.minInterval = o.minInterval;
    if (o.name) {
      axis.name = o.name;
      axis.nameLocation = o.nameLocation || 'end';
      axis.nameGap = o.nameGap === undefined ? 12 : o.nameGap;
      axis.nameTextStyle = assign({ color: T.ink3, fontFamily: T.font, fontSize: FS_AXIS }, o.nameStyle);
    }
    return axis;
  }

  function grid(top, right, bottom, left) {
    return { top: top, right: right, bottom: bottom, left: left, containLabel: true };
  }

  function endRadius(horizontal, negative) {
    if (horizontal) return negative ? [4, 0, 0, 4] : [0, 4, 4, 0];
    return negative ? [0, 0, 4, 4] : [4, 4, 0, 0];
  }

  /* 1, 2, 3, 4, 5, 6, 8 x 10^k - every half is still a clean tick */
  function niceCeil(x) {
    if (!(x > 0)) return 1;
    var pow = Math.pow(10, Math.floor(Math.log(x) / Math.LN10));
    var m = x / pow, steps = [1, 2, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (m <= steps[i] * (1 + 1e-9)) return steps[i] * pow;
    return 10 * pow;
  }

  /* ------------------------------------------------------------------ series normalisation */

  /**
   * data.series [{id, name, values, colourVar?}] or the single-series shorthand data.values.
   * Colour: colourVar, else by entity when data.colourBy is 'channel' | 'medium' | 'outlet', else by position.
   */
  function seriesList(c) {
    var d = c.data, list;
    if (Array.isArray(d.series)) list = d.series;
    else if (Array.isArray(d.values)) list = [{ id: 'value', name: d.name || c.spec.title || 'Value', values: d.values, colourVar: d.colourVar }];
    else list = [];
    var single = list.length === 1;
    return list.map(function (s, i) {
      var id = s.id !== undefined && s.id !== null ? String(s.id) : 's' + i;
      var cv = s.colourVar || (single && d.colourVar) ||
        (d.colourBy === 'channel' || d.colourBy === 'medium' || d.colourBy === 'outlet' ? colourFor(d.colourBy, id) : colourFor('series', i));
      return { id: id, name: s.name !== undefined && s.name !== null ? String(s.name) : id, values: s.values || [], colourVar: cv, colour: resolveColour(cv) };
    });
  }

  function visibleOf(all, hidden) {
    var vis = all.filter(function (s) { return !hidden[s.id]; });
    return vis.length ? vis : all;
  }

  function hasNumbers(list) {
    return list.some(function (s) { return s.values.some(isNum); });
  }

  function lastIndex(values) {
    for (var i = values.length - 1; i >= 0; i--) if (isNum(values[i])) return i;
    return -1;
  }

  function seriesId(params) {
    var id = params && params.seriesId ? String(params.seriesId) : '';
    return id.indexOf(SERIES_PREFIX) === 0 ? id.slice(SERIES_PREFIX.length) : id;
  }

  /* ================================================================== builders
   * builder(c, hints) -> plan
   *   c     { spec, data, kind, fmt, width, height, hidden, cursor }
   *   plan  { empty } or { option, legend, measure?(chart) -> hints, overlay?(chart) -> [labels], click?(params), zrClick?(chart, x, y), events? }
   * A plan with measure() is laid out twice: once silently to read pixel geometry, then for real.
   */

  var builders = {};

  /* ------------------------------------------------------------------ line / area */

  function buildLine(c, hints) {
    var T = theme(), d = c.data, fmt = c.fmt;
    var labels = strings(d.labels);
    var all = seriesList(c);
    if (!labels.length || !all.length || !hasNumbers(all)) return { empty: true };

    var vis = visibleOf(all, c.hidden);
    var isArea = c.kind === 'area';
    /* forecast tail (CHARTS-API 2.1): one series whose values from `fromIndex` on are a forecast - drawn dashed, with a band */
    var fc = d.forecast && vis.length === 1 && isNum(d.forecast.fromIndex) && d.forecast.fromIndex > 0 && d.forecast.fromIndex < labels.length ? d.forecast : null;
    var fcFrom = fc ? fc.fromIndex : labels.length;
    var fcLo = fc ? (fc.lo || []).map(num) : [], fcHi = fc ? (fc.hi || []).map(num) : [];
    var emph = d.emphasise !== undefined && d.emphasise !== null ? String(d.emphasise) : null;
    if (emph !== null && !all.some(function (s) { return s.id === emph; })) emph = null;
    function paint(s) { return emph === null || s.id === emph ? s.colour : T.muted; }

    /* direct labels: one series -> its last value; <= 4 series -> their names; emphasis -> only the series that is the point */
    var dotted = emph !== null ? vis.filter(function (s) { return s.id === emph; }) : vis;
    var labelled = emph !== null ? dotted.slice() : (vis.length <= 4 ? vis.slice() : []);
    if (hints && hints.dropEndLabels) labelled = [];
    function endAt(s) { return fc && s === vis[0] ? fcFrom - 1 : lastIndex(s.values); }
    function endText(s) { return all.length === 1 ? fmt(s.values[endAt(s)], 'label') : s.name; }
    var endWidth = maxTextWidth(labelled.map(endText), FS_LABEL);
    if (endWidth > c.width * 0.28) { labelled = []; endWidth = 0; }

    /* event markers: vertical hairlines; their captions are placed by overlay() once pixels are known */
    var markers = (d.markers || []).map(function (m) {
      return { label: String(m.label), index: labels.indexOf(String(m.atLabel)) };
    }).filter(function (m) { return m.index >= 0; });
    if (fc) markers.push({ label: fc.label || 'Forecast', index: fcFrom });
    var markerRows = 0;
    if (markers.length) {
      markerRows = 1;
      var plotW = Math.max(60, c.width - 56 - (labelled.length ? endWidth + 14 : 10));
      var step = labels.length > 1 ? plotW / (labels.length - 1) : plotW;
      var sorted = markers.slice().sort(function (a, b) { return a.index - b.index; });
      for (var k = 1; k < sorted.length; k++) {
        var need = (textWidth(sorted[k].label, FS_LABEL) + textWidth(sorted[k - 1].label, FS_LABEL)) / 2 + 8;
        if ((sorted[k].index - sorted[k - 1].index) * step < need) markerRows = 2;
      }
    }
    var top = markers.length ? 8 + markerRows * 14 : 10;

    var series = vis.map(function (s, i) {
      var colour = paint(s);
      var li = endAt(s);
      var out = {
        id: SERIES_PREFIX + s.id, name: s.name, type: 'line',
        data: fc && s === vis[0] ? s.values.map(function (v, i) { return i < fcFrom ? num(v) : null; }) : s.values.map(num),
        z: emph !== null && s.id === emph ? 4 : 3,
        cursor: c.cursor,
        showSymbol: false, symbol: 'circle', symbolSize: 10,
        connectNulls: false,
        lineStyle: { width: 2, color: colour, cap: 'round', join: 'round' },
        itemStyle: { color: colour, borderColor: T.surface, borderWidth: 2 },
        emphasis: { focus: 'series', scale: false, lineStyle: { width: 2 } },
        blur: { lineStyle: { opacity: 0.25 }, areaStyle: { opacity: 0.04 } }
      };
      if (isArea) out.areaStyle = { color: colour, opacity: 0.1 };
      if (li >= 0 && dotted.indexOf(s) !== -1) {
        var showLabel = labelled.indexOf(s) !== -1;
        out.markPoint = {
          silent: true, animation: false, symbol: 'circle', symbolSize: 10,
          itemStyle: { color: colour, borderColor: T.surface, borderWidth: 2 },
          label: { show: showLabel, position: 'right', distance: 6, color: T.ink2, textBorderColor: T.surface, textBorderWidth: 2, fontSize: FS_LABEL, formatter: function () { return endText(s); } },
          data: [{ coord: [li, s.values[li]] }]
        };
      }
      if (i === 0 && markers.length) {
        out.markLine = {
          z: 1, /* guides sit above the gridlines and BEHIND the data: the markLine default (z 5) would strike through lines and labels */
          silent: true, animation: false, symbol: ['none', 'none'],
          label: { show: false },
          lineStyle: { color: T.axis, width: 1, type: 'solid' },
          data: markers.map(function (m) { return { xAxis: m.index }; })
        };
      }
      return out;
    });

    if (fc) {
      var s0 = vis[0], colour0 = paint(s0), quiet = { silent: true, showSymbol: false, connectNulls: false, cursor: c.cursor, emphasis: { disabled: true }, blur: { lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 } } };
      series.push(Object.assign({
        id: SERIES_PREFIX + s0.id + '__fc', name: fc.label || 'Forecast', type: 'line', z: 3,
        data: s0.values.map(function (v, i) { return i >= fcFrom - 1 ? num(v) : null; }),
        lineStyle: { width: 2, color: colour0, type: [5, 5], cap: 'round', join: 'round' }, itemStyle: { color: colour0 }
      }, quiet));
      if (fcLo.length && fcHi.length) {
        /* the band: a transparent base at the low edge, a wash stacked on it up to the high edge */
        var baseVals = labels.map(function (_, i) { return i < fcFrom - 1 ? null : (i === fcFrom - 1 ? num(s0.values[i]) : fcLo[i]); });
        var spanVals = labels.map(function (_, i) { return i < fcFrom - 1 ? null : (i === fcFrom - 1 ? 0 : (isNum(fcHi[i]) && isNum(fcLo[i]) ? fcHi[i] - fcLo[i] : null)); });
        series.push(Object.assign({ id: SERIES_PREFIX + s0.id + '__band0', name: 'band-low', type: 'line', z: 1, stack: 'mk-forecast-band', data: baseVals, lineStyle: { opacity: 0, width: 0 }, areaStyle: { opacity: 0 }, itemStyle: { opacity: 0 } }, quiet));
        series.push(Object.assign({ id: SERIES_PREFIX + s0.id + '__band1', name: fc.bandLabel || '80% band', type: 'line', z: 1, stack: 'mk-forecast-band', data: spanVals, lineStyle: { opacity: 0, width: 0 }, areaStyle: { color: colour0, opacity: 0.12 }, itemStyle: { opacity: 0 } }, quiet));
      }
    }

    var option = {
      grid: grid(top, labelled.length ? endWidth + 16 : 12, 2, 2),
      xAxis: categoryAxis(labels, { boundaryGap: false, label: { interval: 'auto' } }),
      yAxis: valueAxis(fmt, { zero: c.spec.zeroBaseline !== false, minInterval: wholeStep(c.spec.format, vis.map(function (s) { return s.values; })), scaleMax: maxAbsOf([].concat.apply([], vis.map(function (s) { return s.values; }).concat(fc ? [fcHi] : []))) }),
      tooltip: tooltipOption('axis', function (params) {
        var list = Array.isArray(params) ? params : [params];
        if (!list.length) return '';
        var idx = list[0].dataIndex;
        var notes = markers.filter(function (m) { return m.index === idx; }).map(function (m) { return m.label; });
        var tip = tipBox(labels[idx], notes.join(' / '));
        var total = 0;
        vis.forEach(function (s) {
          var v = num(s.values[idx]);
          if (v !== null) total += v;
          var isFc = fc && s === vis[0] && idx >= fcFrom;
          tip.row(paint(s), fmt(v, 'tooltip'), isFc ? (fc.label || 'Forecast') : s.name);
          if (isFc && isNum(fcLo[idx]) && isNum(fcHi[idx])) tip.row(null, fmt(fcLo[idx], 'tooltip') + ' to ' + fmt(fcHi[idx], 'tooltip'), fc.bandLabel || '80% band');
        });
        if (d.showTotal && vis.length > 1) tip.row(null, fmt(total, 'tooltip'), 'Total', { total: true });
        return tip.node;
      }),
      series: series
    };

    var legend = [];
    if (all.length > 1) {
      if (emph !== null) {
        all.forEach(function (s) { if (s.id === emph) legend.push({ id: s.id, name: s.name, colourVar: s.colourVar, shape: 'line' }); });
        legend.push({ id: '__rest', name: d.restLabel || 'Others', colourVar: '--series-muted', shape: 'line' });
      } else {
        all.forEach(function (s) { legend.push({ id: s.id, name: s.name, colourVar: s.colourVar, shape: isArea ? 'rect' : 'line', toggle: true, off: vis.indexOf(s) === -1 }); });
      }
    }

    var plan = {
      option: option,
      legend: legend,
      /* marker captions: DOM overlay, staggered on up to two rows, dropped (tooltip keeps them) if still colliding */
      overlay: function (chart) {
        if (!markers.length) return [];
        var rowsRight = [-Infinity, -Infinity], out = [];
        markers.slice().sort(function (a, b) { return a.index - b.index; }).forEach(function (m) {
          var x = chart.convertToPixel({ xAxisIndex: 0 }, m.index);
          if (!isNum(x)) return;
          var w = textWidth(m.label, FS_LABEL) + 2;
          var left = clamp(x - w / 2, 0, Math.max(0, c.width - w));
          for (var r = 0; r < markerRows; r++) {
            if (left >= rowsRight[r] + 6) {
              rowsRight[r] = left + w;
              out.push({ text: m.label, left: Math.round(left), top: top - 16 - r * 14 });
              return;
            }
          }
        });
        return out;
      },
      zrClick: function (chart, x, y) {
        if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return null;
        var at = chart.convertFromPixel({ gridIndex: 0 }, [x, y]);
        var idx = clamp(Math.round(at[0]), 0, labels.length - 1);
        var values = {};
        all.forEach(function (s) { values[s.id] = num(s.values[idx]); });
        return { seriesId: null, seriesName: null, category: labels[idx], value: null, datum: { index: idx, label: labels[idx], values: values } };
      }
    };

    /* end labels are all-or-nothing: if two would collide, the legend carries identity instead */
    if (!hints && labelled.length > 1) {
      plan.measure = function (chart) {
        var ys = labelled.map(function (s) { return chart.convertToPixel({ yAxisIndex: 0 }, s.values[lastIndex(s.values)]); })
          .filter(isNum).sort(function (a, b) { return a - b; });
        for (var i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] < 14) return { dropEndLabels: true };
        return null;
      };
    }
    return plan;
  }
  builders.line = buildLine;
  builders.area = buildLine;

  /* ------------------------------------------------------------------ bar / hbar */

  /** Greedy wrap at word boundaries. null when a single word is wider than maxW or more than maxLines would be needed. */
  function wrapWords(text, maxW, maxLines, size) {
    var list = String(text).split(/\s+/).filter(Boolean);
    var lines = [], line = '';
    for (var i = 0; i < list.length; i++) {
      if (textWidth(list[i], size) > maxW) return null;
      var joined = line ? line + ' ' + list[i] : list[i];
      if (line && textWidth(joined, size) > maxW) { lines.push(line); line = list[i]; } else line = joined;
    }
    if (line) lines.push(line);
    return lines.length <= maxLines ? lines : null;
  }

  function truncateTo(text, maxW, size) {
    var s = String(text);
    if (textWidth(s, size) <= maxW) return s;
    while (s.length > 1 && textWidth(s + '...', size) > maxW) s = s.slice(0, -1);
    return s.replace(/\s+$/, '') + '...';
  }

  /** Width of the widest tick label a zero-based value axis will print for data reaching scaleMax. */
  function axisLabelWidth(fmt, scaleMax, signed) {
    var top = Math.max(scaleMax || 0, niceTop(scaleMax || 0, 4));
    var w = textWidth(fmt(top, 'axis', scaleMax), FS_AXIS);
    return signed ? Math.max(w, textWidth(fmt(-top, 'axis', scaleMax), FS_AXIS)) : w;
  }

  var SLANT_PAD_MAX = 40;
  var SLANT_DEG = 35, SLANT_COS = Math.cos(SLANT_DEG * Math.PI / 180), SLANT_SIN = Math.sin(SLANT_DEG * Math.PI / 180);

  /*
   * Category labels. Horizontal charts: one line, truncated at 38% of the card (hbar is the form for long names).
   * Vertical charts with up to 12 categories show every label and never split a word:
   *   1. each label is wrapped here, at word boundaries, onto at most two lines of its band;
   *   2. if any label cannot be set that way (a word wider than the band, or a third line needed), all labels are
   *      slanted instead - whole names, each truncated only to the room it really has - and the console says once
   *      that the chart wants hbar or a wider card. ECharts' own overflow: 'break' is not used: it cuts inside
   *      words ("Restau / rant") and stacks up to five lines under a narrow band, eating the plot.
   */
  function categoryLabelStyle(c, cats, horizontal, extraMargin, valueLabelW) {
    var T = theme();
    var margin = 10 + (extraMargin || 0);
    if (horizontal) {
      return { color: T.ink2, fontSize: 12, interval: 0, hideOverlap: false, margin: margin, width: Math.min(maxTextWidth(cats, 12) + 4, Math.round(c.width * 0.38)), overflow: 'truncate' };
    }
    /* no decision before the card has a size: draw() builds a plan for the legend first, with width 0 */
    if (cats.length > 12 || !(c.width > 0)) return { interval: 'auto', margin: margin };

    /* valueLabelW: width of the widest value-axis label, when the caller knows it - it fixes where the first band starts */
    var leftPad = valueLabelW > 0 ? Math.ceil(valueLabelW) + 10 : 46;
    var band = (c.width - leftPad - 10) / cats.length;
    var maxW = Math.max(28, Math.floor(band - 8));
    var wrapped = cats.map(function (t) { return wrapWords(t, maxW, 2, FS_AXIS); });
    if (wrapped.every(function (lines) { return lines !== null; })) {
      return { interval: 0, hideOverlap: false, margin: margin, lineHeight: 14,
        formatter: function (value, index) { var lines = wrapped[index] || wrapWords(value, maxW, 2, FS_AXIS); return lines ? lines.join('\n') : String(value); } };
    }

    warnOnce('slant:' + (c.spec.id || c.spec.title || c.kind), 'Category labels of "' + (c.spec.title || c.spec.id || c.kind) +
      '" do not fit their bands and are drawn slanted. Long names belong in hbar / hstackedBar, or give the card more width.');
    /* A slanted label ends at its tick and runs down to the left. Its length is capped by the plot height it may take.
       The first labels would run past the left edge of the card: the plot is first moved right by up to SLANT_PAD_MAX px
       (padLeft, which the builder adds to the grid), and only what still does not fit is truncated. */
    var cap = clamp(Math.round(c.height * 0.28 / SLANT_SIN), 56, 128);
    function reach(t) { return Math.min(cap, textWidth(t, FS_AXIS)) * SLANT_COS; }
    var padLeft = 0;
    cats.forEach(function (t, j) {
      var at = (j + 0.5) / cats.length; /* moving the plot right also narrows the bands, so a tick gains only (1 - at) of the shift */
      padLeft = Math.max(padLeft, (reach(t) - (leftPad - 6 + band * (j + 0.5))) / (1 - at));
    });
    padLeft = padLeft > 0 ? Math.min(SLANT_PAD_MAX, Math.ceil(padLeft) + 1) : 0;
    var slantBand = (c.width - leftPad - padLeft - 10) / cats.length;
    var slanted = cats.map(function (t, j) {
      var room = (leftPad + padLeft - 6 + slantBand * (j + 0.5)) / SLANT_COS;
      return truncateTo(t, Math.max(40, Math.min(cap, room)), FS_AXIS);
    });
    return { interval: 0, hideOverlap: slantBand * SLANT_SIN < 13, rotate: SLANT_DEG, margin: margin - 2, padLeft: padLeft,
      formatter: function (value, index) { return slanted[index] !== undefined ? slanted[index] : truncateTo(value, cap, FS_AXIS); } };
  }

  /** grid.left for a vertical chart: 2px, plus the room a slanted first label asked for. The hint never reaches ECharts. */
  function takePadLeft(style) {
    var pad = style && style.padLeft ? style.padLeft : 0;
    if (style) delete style.padLeft;
    return 2 + pad;
  }

  function categoryTip(cats, j, vis, hoveredId, valueOf, extra) {
    var tip = tipBox(cats[j]);
    vis.forEach(function (s) {
      tip.row(s.paint || s.colour, valueOf(s, j), s.name, { active: vis.length > 1 && s.id === hoveredId });
    });
    if (extra) extra(tip);
    return tip.node;
  }

  function buildBar(c, hints) {
    var T = theme(), d = c.data, fmt = c.fmt;
    var horizontal = c.kind === 'hbar';
    var cats = strings(d.categories);
    var all = seriesList(c);
    if (!cats.length || !all.length || !hasNumbers(all)) return { empty: true };

    var single = all.length === 1;
    var vis = single ? all : visibleOf(all, c.hidden);
    var showLabels = single && cats.length <= 12;
    var highlight = single && d.highlight !== undefined && d.highlight !== null ? String(d.highlight) : null;
    var hasNeg = vis.some(function (s) { return s.values.some(function (v) { return isNum(v) && v < 0; }); });

    /* target: one number -> a solid rule across the plot; an array -> a tick per category. Single series only. */
    var targetArr = single && Array.isArray(d.target) ? d.target.map(num) : null;
    var targetNum = single && isNum(d.target) ? d.target : null;
    var targetName = d.targetName || 'Target';

    var labelW = showLabels ? maxTextWidth(vis[0].values.filter(isNum).map(function (v) { return fmt(v, 'label'); }), FS_LABEL) : 0;
    var negRoom = showLabels && hasNeg ? (horizontal ? labelW + 6 : 16) : 0;
    var band = (horizontal ? c.height - 30 : c.width - 56) / cats.length;

    var series = vis.map(function (s) {
      return {
        id: SERIES_PREFIX + s.id, name: s.name, type: 'bar', z: 2,
        barMaxWidth: BAR_MAX, barGap: '0%', barCategoryGap: single ? '30%' : '26%',
        cursor: c.cursor,
        /* a 1px surface-coloured edge on each bar = the 2px surface gap between neighbours */
        itemStyle: { color: s.colour, borderColor: T.surface, borderWidth: single ? 0 : 1 },
        emphasis: { focus: single ? 'none' : 'series' },
        blur: { itemStyle: { opacity: 0.35 } },
        label: { show: showLabels, color: T.ink2, textBorderColor: T.surface, textBorderWidth: 2, fontSize: FS_LABEL, distance: 4, formatter: function (p) { return fmt(p.value, 'label'); } },
        labelLayout: { hideOverlap: true },
        data: cats.map(function (cat, j) {
          var v = num(s.values[j]), neg = v !== null && v < 0;
          var item = { value: v, itemStyle: { borderRadius: endRadius(horizontal, neg) } };
          if (highlight !== null && cat !== highlight) item.itemStyle.color = T.muted;
          if (showLabels) {
            item.label = { position: horizontal ? (neg ? 'left' : 'right') : (neg ? 'bottom' : 'top') };
            if (hints && hints.labelDistance && hints.labelDistance[j] !== null) item.label.distance = hints.labelDistance[j];
          }
          return item;
        })
      };
    });

    if (targetArr) {
      var tick = clamp(Math.round(band * 0.7), 12, 32);
      series.push({
        id: SERIES_PREFIX + '__target', name: targetName, type: 'scatter', silent: true, z: 4,
        symbol: 'rect', symbolSize: horizontal ? [2, tick] : [tick, 2],
        itemStyle: { color: T.ink, opacity: 1 },
        emphasis: { disabled: true }, tooltip: { show: false },
        data: targetArr.map(function (t, j) { return t === null ? null : (horizontal ? [t, j] : [j, t]); }).filter(function (p) { return p !== null; })
      });
    }
    if (targetNum !== null) {
      series[0].markLine = {
        silent: true, animation: false, symbol: ['none', 'none'],
        lineStyle: { color: T.ink2, width: 1, type: 'solid' },
        label: { show: true, position: horizontal ? 'start' : 'insideEndTop', distance: horizontal ? 4 : 3, color: T.ink2, fontSize: FS_LABEL, formatter: function () { return targetName + ' ' + fmt(targetNum, 'label'); } },
        data: [horizontal ? { xAxis: targetNum } : { yAxis: targetNum }]
      };
      /* invisible carrier so the value axis always reaches the target */
      series.push({
        id: SERIES_PREFIX + '__reach', type: 'line', silent: true, showSymbol: false, symbol: 'none',
        lineStyle: { opacity: 0, width: 0 }, tooltip: { show: false }, emphasis: { disabled: true },
        data: cats.map(function () { return targetNum; })
      });
    }

    var scaleMax = maxAbsOf([].concat.apply(targetArr || [targetNum], vis.map(function (s) { return s.values; })));
    var catStyle = categoryLabelStyle(c, cats, horizontal, negRoom, axisLabelWidth(fmt, scaleMax, hasNeg));
    var gridLeft = takePadLeft(catStyle);
    var catAxis = categoryAxis(cats, { inverse: horizontal, label: catStyle });
    var valAxis = valueAxis(fmt, {
      minInterval: wholeStep(c.spec.format, vis.map(function (s) { return s.values; })),
      scaleMax: scaleMax
    });
    var painted = vis.map(function (s) { return { id: s.id, name: s.name, colour: s.colour, paint: s.colour, values: s.values }; });

    var option = {
      grid: horizontal
        ? grid(targetNum !== null ? 20 : 4, showLabels ? labelW + 12 : 12, 0, 2)
        : grid(showLabels ? 20 : 10, 8, 2, gridLeft),
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      tooltip: tooltipOption('item', function (p) {
        var j = p.dataIndex;
        if (highlight !== null) painted[0].paint = cats[j] === highlight ? painted[0].colour : T.muted;
        return categoryTip(cats, j, painted, seriesId(p), function (s, jj) { return fmt(num(s.values[jj]), 'tooltip'); }, function (tip) {
          var t = targetArr ? targetArr[j] : targetNum;
          if (t === null || t === undefined) return;
          tip.row(T.ink, fmt(t, 'tooltip'), targetName);
          var v = num(painted[0].values[j]);
          if (v !== null && t) tip.foot(MK.fmt.pct(v / t, 0) + ' of ' + targetName.toLowerCase());
        });
      }),
      series: series
    };

    var legend = [];
    if (!single) {
      all.forEach(function (s) { legend.push({ id: s.id, name: s.name, colourVar: s.colourVar, shape: 'rect', toggle: true, off: vis.indexOf(s) === -1 }); });
    } else if (targetArr || targetNum !== null) {
      legend.push({ id: all[0].id, name: all[0].name, colourVar: all[0].colourVar, shape: 'rect' });
      legend.push({ id: '__target', name: targetName, colourVar: '--ink', shape: 'line' });
    }

    var plan = {
      option: option,
      legend: legend,
      click: function (p) {
        var id = seriesId(p), s = null;
        all.forEach(function (x) { if (x.id === id) s = x; });
        if (!s) return null;
        return { seriesId: s.id, seriesName: s.name, category: cats[p.dataIndex], value: num(s.values[p.dataIndex]), datum: { index: p.dataIndex, target: targetArr ? targetArr[p.dataIndex] : targetNum } };
      }
    };

    /* a target tick just beyond the bar tip would strike through the value label: lift the label over it */
    if (!hints && targetArr && showLabels) {
      plan.measure = function (chart) {
        var finder = horizontal ? { xAxisIndex: 0 } : { yAxisIndex: 0 };
        var zone = horizontal ? labelW + 10 : 20, any = false;
        var out = cats.map(function (_, j) {
          var v = num(vis[0].values[j]), t = targetArr[j];
          if (v === null || t === null || t === undefined || v < 0 || t < v) return null;
          var gap = Math.abs(chart.convertToPixel(finder, t) - chart.convertToPixel(finder, v));
          if (!(gap < zone)) return null;
          any = true;
          return Math.round(gap) + 5;
        });
        return any ? { labelDistance: out } : null;
      };
    }
    return plan;
  }
  builders.bar = buildBar;
  builders.hbar = buildBar;

  /* ------------------------------------------------------------------ stackedBar / hstackedBar */

  function buildStacked(c, hints) {
    var T = theme(), d = c.data, fmt = c.fmt;
    var horizontal = c.kind === 'hstackedBar';
    var cats = strings(d.categories);
    var all = seriesList(c);
    if (!cats.length || !all.length || !hasNumbers(all)) return { empty: true };

    var vis = visibleOf(all, c.hidden);
    var percent = !!d.percent;
    function raw(s, j) { var v = num(s.values[j]); return v === null ? null : Math.max(0, v); }
    var totals = cats.map(function (_, j) { var t = 0; vis.forEach(function (s) { t += raw(s, j) || 0; }); return t; });
    function shown(s, j) { var v = raw(s, j); if (v === null) return null; return percent ? (totals[j] ? v / totals[j] : 0) : v; }
    function share(s, j) { var v = raw(s, j); return v === null || !totals[j] ? null : v / totals[j]; }
    function segText(s, j) { return percent ? MK.fmt.pct(share(s, j), 0) : fmt(raw(s, j), 'label'); }

    /* only the outermost non-zero segment of each bar carries the rounded data end */
    var outer = cats.map(function (_, j) {
      for (var i = vis.length - 1; i >= 0; i--) if ((raw(vis[i], j) || 0) > 0) return i;
      return -1;
    });

    var showTotals = !percent && cats.length <= 12;
    var totalW = showTotals ? maxTextWidth(totals.map(function (t) { return fmt(t, 'label'); }), FS_LABEL) : 0;

    var series = vis.map(function (s, i) {
      var fits = hints && hints.fits ? hints.fits[s.id] : null;
      var labelInk = inkOn(s.colour);
      return {
        id: SERIES_PREFIX + s.id, name: s.name, type: 'bar', stack: 'stack', z: 2,
        barMaxWidth: BAR_MAX, barCategoryGap: '34%',
        cursor: c.cursor,
        itemStyle: { color: s.colour, borderColor: T.surface, borderWidth: 1 },
        emphasis: { focus: 'series' },
        blur: { itemStyle: { opacity: 0.35 } },
        label: { show: false, position: 'inside', color: labelInk, fontSize: FS_LABEL, formatter: function (p) { return segText(s, p.dataIndex); } },
        data: cats.map(function (_, j) {
          var item = { value: shown(s, j) };
          if (outer[j] === i) item.itemStyle = { borderRadius: endRadius(horizontal, false) };
          if (fits && fits[j]) item.label = { show: true };
          return item;
        })
      };
    });

    if (showTotals) {
      series.push({
        id: SERIES_PREFIX + '__total', type: 'bar', stack: 'stack', silent: true, z: 2,
        barMaxWidth: BAR_MAX, barCategoryGap: '34%',
        itemStyle: { color: T.surface, borderWidth: 0 }, /* zero-length carrier: it only holds the label (opacity 0 would hide the label too) */
        emphasis: { disabled: true }, tooltip: { show: false },
        label: { show: true, position: horizontal ? 'right' : 'top', distance: 5, color: T.ink2, textBorderColor: T.surface, textBorderWidth: 2, fontSize: FS_LABEL, formatter: function (p) { return fmt(totals[p.dataIndex], 'label'); } },
        labelLayout: { hideOverlap: true },
        data: cats.map(function () { return 0; })
      });
    }

    var pctFmt = makeFormatter('pct');
    var catStyle = categoryLabelStyle(c, cats, horizontal, 0, percent ? textWidth(pctFmt(1, 'axis'), FS_AXIS) : axisLabelWidth(fmt, maxAbsOf(totals), false));
    var gridLeft = takePadLeft(catStyle);
    var catAxis = categoryAxis(cats, { inverse: horizontal, label: catStyle });
    var valAxis = percent ? valueAxis(pctFmt, { min: 0, max: 1, interval: 0.25 }) : valueAxis(fmt, { minInterval: wholeStep(c.spec.format, vis.map(function (s) { return s.values; })), scaleMax: maxAbsOf(totals) });

    var option = {
      grid: horizontal ? grid(4, showTotals ? totalW + 14 : 14, 0, 2) : grid(showTotals ? 20 : 10, 8, 2, gridLeft),
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      tooltip: tooltipOption('item', function (p) {
        var j = p.dataIndex, hovered = seriesId(p);
        var tip = tipBox(cats[j]);
        vis.forEach(function (s) {
          var v = raw(s, j);
          var text = percent ? MK.fmt.pct(share(s, j), 1) : fmt(v, 'tooltip');
          var name = percent ? s.name + '  ' + fmt(v, 'tooltip') : s.name;
          tip.row(s.colour, text, name, { active: s.id === hovered });
        });
        tip.row(null, fmt(totals[j], 'tooltip'), 'Total', { total: true });
        if (!percent && totals[j]) {
          vis.forEach(function (s) { if (s.id === hovered) tip.foot(s.name + ': ' + MK.fmt.pct(share(s, j), 1) + ' of total'); });
        }
        return tip.node;
      }),
      series: series
    };

    var plan = {
      option: option,
      legend: all.map(function (s) { return { id: s.id, name: s.name, colourVar: s.colourVar, shape: 'rect', toggle: all.length > 1, off: vis.indexOf(s) === -1 }; }),
      click: function (p) {
        var id = seriesId(p), s = null;
        all.forEach(function (x) { if (x.id === id) s = x; });
        if (!s) return null;
        var j = p.dataIndex;
        return { seriesId: s.id, seriesName: s.name, category: cats[j], value: raw(s, j), datum: { index: j, share: share(s, j), total: totals[j] } };
      }
    };

    /* a segment label is drawn only where the text fits inside the segment with padding; otherwise legend + tooltip + table carry it */
    if (!hints) {
      plan.measure = function (chart) {
        var valFinder = horizontal ? { xAxisIndex: 0 } : { yAxisIndex: 0 };
        var catFinder = horizontal ? { yAxisIndex: 0 } : { xAxisIndex: 0 };
        var p0 = chart.convertToPixel(valFinder, 0);
        var bandPx = cats.length > 1 ? Math.abs(chart.convertToPixel(catFinder, 1) - chart.convertToPixel(catFinder, 0)) : BAR_MAX / 0.66;
        var thick = Math.min(BAR_MAX, bandPx * 0.66) - 2;
        var fits = {}, any = false;
        vis.forEach(function (s) {
          fits[s.id] = cats.map(function (_, j) {
            var v = shown(s, j);
            if (!v) return false;
            var len = Math.abs(chart.convertToPixel(valFinder, v) - p0) - 2;
            var w = textWidth(segText(s, j), FS_LABEL);
            var ok = horizontal ? (len >= w + 12 && thick >= 15) : (thick >= w + 6 && len >= 17);
            if (ok) any = true;
            return ok;
          });
        });
        return any ? { fits: fits } : null;
      };
    }
    return plan;
  }
  builders.stackedBar = buildStacked;
  builders.hstackedBar = buildStacked;

  /* ------------------------------------------------------------------ heatmap */

  function buildHeatmap(c, hints) {
    var T = theme(), d = c.data, fmt = c.fmt;
    var rows = strings(d.rows), cols = strings(d.cols), values = d.values || [];
    var cells = [], lo = Infinity, hi = -Infinity;
    rows.forEach(function (_, r) {
      cols.forEach(function (__, k) {
        var v = values[r] ? num(values[r][k]) : null;
        if (v === null) return;
        cells.push([k, r, v]);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      });
    });
    if (!cells.length) return { empty: true };

    var min = isNum(d.min) ? d.min : Math.min(0, lo);
    var max = isNum(d.max) ? d.max : hi;
    if (max <= min) max = min + 1;
    var ramp = seqRamp();

    /*
     * Direct labels are selective (SPEC section 4). A small matrix (up to HEAT_LABEL_ALL cells, e.g. outlet x channel) is
     * read like a table, so every cell is labelled. A big grid (day of week x hour = 105 cells) labels only the peak of
     * each row; the scale legend, the tooltip and the table twin carry the rest. cellLabels: true forces all, false none.
     */
    var labelMode = hints && hints.labels ? hints.labels : null; /* 'all' | 'peaks', set by measure() when the text fits a cell */
    var peakCol = {};
    if (labelMode === 'peaks') {
      cells.forEach(function (cell) {
        var best = peakCol[cell[1]];
        if (best === undefined || cell[2] > best.v) peakCol[cell[1]] = { k: cell[0], v: cell[2] };
      });
    }
    function labelled(cell) { return labelMode === 'all' || (labelMode === 'peaks' && peakCol[cell[1]].k === cell[0]); }

    var option = {
      grid: grid(4, 4, 2, 2),
      xAxis: categoryAxis(cols, { line: false, label: { interval: cols.length <= 31 ? 0 : 'auto', margin: 8 } }),
      yAxis: categoryAxis(rows, { inverse: true, line: false, label: { color: T.ink2, interval: 0, hideOverlap: false, margin: 8 } }),
      visualMap: { show: false, type: 'continuous', min: min, max: max, dimension: 2, seriesIndex: 0, inRange: { color: ramp } },
      tooltip: tooltipOption('item', function (p) {
        var v = p.value;
        return tipBox(null).row(rampAt(ramp, (v[2] - min) / (max - min)), fmt(v[2], 'tooltip'), rows[v[1]] + ', ' + cols[v[0]]).node;
      }),
      series: [{
        id: SERIES_PREFIX + 'cells', type: 'heatmap', cursor: c.cursor,
        /* stroke is centred on the cell edge: 2px in the surface colour = the 2px gap */
        itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: T.ink2, borderWidth: 1.5 } },
        label: { show: false, fontSize: FS_LABEL, formatter: function (p) { return fmt(p.value[2], 'label'); } },
        data: cells.map(function (cell) {
          if (!labelled(cell)) return cell;
          return { value: cell, label: { show: true, color: inkOn(rampAt(ramp, (cell[2] - min) / (max - min))) } };
        })
      }]
    };

    var plan = {
      option: option,
      legend: [{ id: '__scale', shape: 'scale', name: d.valueLabel || '', minText: fmt(min, 'label'), maxText: fmt(max, 'label') }],
      click: function (p) {
        var v = p.value;
        return { seriesId: null, seriesName: null, category: cols[v[0]], value: v[2], datum: { row: rows[v[1]], col: cols[v[0]], rowIndex: v[1], colIndex: v[0], value: v[2] } };
      }
    };

    if (!hints && d.cellLabels !== false) {
      plan.measure = function (chart) {
        var cw = cols.length > 1 ? Math.abs(chart.convertToPixel({ xAxisIndex: 0 }, 1) - chart.convertToPixel({ xAxisIndex: 0 }, 0)) : c.width - 60;
        var ch = rows.length > 1 ? Math.abs(chart.convertToPixel({ yAxisIndex: 0 }, 1) - chart.convertToPixel({ yAxisIndex: 0 }, 0)) : c.height - 30;
        var w = maxTextWidth(cells.map(function (cell) { return fmt(cell[2], 'label'); }), FS_LABEL);
        if (!(cw >= w + 10 && ch >= 18)) return null;
        return { labels: d.cellLabels === true || cells.length <= HEAT_LABEL_ALL ? 'all' : 'peaks' };
      };
    }
    return plan;
  }
  builders.heatmap = buildHeatmap;

  /* ------------------------------------------------------------------ waterfall */

  function waterfallRows(steps) {
    var run = 0;
    return (steps || []).map(function (s) {
      var v = num(s.value) || 0;
      var kind = s.kind === 'total' || s.kind === 'minus' || s.kind === 'plus' ? s.kind : (v < 0 ? 'minus' : 'plus');
      var start, end;
      if (kind === 'total') { start = 0; end = v; }
      else { start = run; end = run + (kind === 'minus' ? -Math.abs(v) : Math.abs(v)); }
      run = end;
      return { label: String(s.label), kind: kind, change: end - start, start: start, end: end, running: run, source: s };
    });
  }

  function buildWaterfall(c) {
    var T = theme(), d = c.data, fmt = c.fmt, signed = signedWith(fmt);
    var rows = waterfallRows(d.steps);
    if (!rows.length) return { empty: true };

    var names = assign({ total: 'Total', plus: 'Increase', minus: 'Decrease' }, d.kindLabels);
    var colourVars = { total: T.total, plus: T.plus, minus: T.minus };
    var colours = { total: resolveColour(T.total), plus: resolveColour(T.plus), minus: resolveColour(T.minus) };
    function labelOf(r) { return r.kind === 'total' ? fmt(r.end, 'label') : signed(r.change, 'label'); }

    /* floating bars = a transparent base stack under the visible part; split at zero so a step may cross the baseline */
    var basePos = [], baseNeg = [], visPos = [], visNeg = [];
    var anyNeg = false;
    rows.forEach(function (r) {
      var lo = Math.min(r.start, r.end), hi = Math.max(r.start, r.end);
      var pLo = Math.max(lo, 0), pHi = Math.max(hi, 0), nLo = Math.min(lo, 0), nHi = Math.min(hi, 0);
      var colour = colours[r.kind];
      var labelOnPos = hi > 0 || lo >= 0;
      if (nLo < 0) anyNeg = true;
      function radius(partLo, partHi) {
        if (r.end === 0 && r.start === 0) return 0;
        if (r.end === partHi && r.end >= r.start && r.end !== 0) return [4, 4, 0, 0];
        if (r.end === partLo && r.end <= r.start && r.end !== 0) return [0, 0, 4, 4];
        return 0;
      }
      basePos.push(pLo);
      baseNeg.push(nHi);
      visPos.push({
        value: pHi - pLo,
        itemStyle: { color: colour, borderRadius: radius(pLo, pHi) },
        label: { show: labelOnPos, position: 'top' }
      });
      visNeg.push({
        value: nLo - nHi,
        itemStyle: { color: colour, borderRadius: radius(nLo, nHi) },
        label: { show: !labelOnPos, position: 'bottom' }
      });
    });

    function carrier(id, data) {
      return { id: SERIES_PREFIX + id, type: 'bar', stack: 'wf', silent: true, barMaxWidth: BAR_MAX, itemStyle: { opacity: 0 }, emphasis: { disabled: true }, tooltip: { show: false }, data: data };
    }
    function visible(id, data) {
      return {
        id: SERIES_PREFIX + id, type: 'bar', stack: 'wf', z: 3, barMaxWidth: BAR_MAX, cursor: c.cursor,
        label: { color: T.ink2, textBorderColor: T.surface, textBorderWidth: 2, fontSize: FS_LABEL, distance: 4, formatter: function (p) { return labelOf(rows[p.dataIndex]); } },
        labelLayout: { hideOverlap: true },
        data: data
      };
    }

    var cats = rows.map(function (r) { return r.label; });
    var scaleMax = maxAbsOf(rows.map(function (r) { return Math.max(Math.abs(r.start), Math.abs(r.end)); }));
    var catStyle = categoryLabelStyle(c, cats, false, anyNeg ? 16 : 0, axisLabelWidth(fmt, scaleMax, anyNeg));
    var option = {
      grid: grid(22, 8, 2, takePadLeft(catStyle)),
      xAxis: categoryAxis(cats, { label: catStyle }),
      yAxis: valueAxis(fmt, { scaleMax: scaleMax }),
      tooltip: tooltipOption('item', function (p) {
        var r = rows[p.dataIndex];
        var tip = tipBox(r.label);
        tip.row(colours[r.kind], r.kind === 'total' ? fmt(r.end, 'tooltip') : signed(r.change, 'tooltip'), names[r.kind]);
        if (r.kind !== 'total') tip.row(null, fmt(r.running, 'tooltip'), 'Running total', { total: true });
        return tip.node;
      }),
      series: [
        carrier('__basePos', basePos),
        carrier('__baseNeg', baseNeg),
        visible('pos', visPos),
        visible('neg', visNeg),
        /* connectors: a hairline stepping from the end of one bar to the start of the next */
        {
          id: SERIES_PREFIX + '__link', type: 'line', step: 'end', silent: true, z: 1, animation: false,
          showSymbol: false, symbol: 'none', lineStyle: { color: T.axis, width: 1, type: 'solid' },
          emphasis: { disabled: true }, tooltip: { show: false },
          data: rows.map(function (r) { return r.running; })
        }
      ]
    };

    var legend = [];
    ['total', 'plus', 'minus'].forEach(function (k) {
      if (rows.some(function (r) { return r.kind === k; })) legend.push({ id: k, name: names[k], colourVar: colourVars[k], shape: 'rect' });
    });

    return {
      option: option,
      legend: legend,
      click: function (p) {
        var r = rows[p.dataIndex];
        if (!r) return null;
        return { seriesId: null, seriesName: names[r.kind], category: r.label, value: r.kind === 'total' ? r.end : r.change, datum: { index: p.dataIndex, kind: r.kind, running: r.running, step: r.source } };
      }
    };
  }
  builders.waterfall = buildWaterfall;

  /* ------------------------------------------------------------------ scatter */

  function buildScatter(c) {
    var T = theme(), d = c.data;
    var xFmt = makeFormatter(d.xFormat || 'num'), yFmt = makeFormatter(d.yFormat || 'num'), sFmt = makeFormatter(d.sizeFormat || 'num');
    var pts = (d.points || []).filter(function (p) { return p && isNum(p.x) && isNum(p.y); });
    if (!pts.length) return { empty: true };

    var colour = resolveColour(d.colourVar || T.single);
    var hl = d.highlight === undefined || d.highlight === null ? null : [].concat(d.highlight).map(String);
    var maxSize = 0;
    pts.forEach(function (p) { if (isNum(p.size) && p.size > maxSize) maxSize = p.size; });
    function sizeOf(p) { return maxSize > 0 && isNum(p.size) ? 12 + 14 * Math.sqrt(Math.max(0, p.size) / maxSize) : 14; }
    function paint(p) { return hl === null || hl.indexOf(String(p.id)) !== -1 ? colour : T.muted; }

    var q = d.quadrants && isNum(d.quadrants.x) && isNum(d.quadrants.y) ? d.quadrants : null;
    var qLabels = q ? strings(q.labels) : [];

    /* names sit above their dot, except at the right edge of the plot where they would be cut off */
    var xs = pts.map(function (p) { return p.x; }).concat(q ? [q.x] : []);
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    function labelSide(p) { return x1 > x0 && (p.x - x0) / (x1 - x0) > 0.88 ? 'left' : 'top'; }

    var points = {
      id: SERIES_PREFIX + 'points', type: 'scatter', z: 3, cursor: c.cursor, symbol: 'circle',
      itemStyle: { color: colour, opacity: 0.95, borderColor: T.surface, borderWidth: 2 },
      emphasis: { scale: 1.35 },
      label: { show: true, position: 'top', distance: 5, color: T.ink2, textBorderColor: T.surface, textBorderWidth: 2, fontSize: FS_LABEL, formatter: function (p) { return p.name; } },
      labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
      data: pts.map(function (p) { return { name: String(p.name), value: [p.x, p.y], symbolSize: sizeOf(p), itemStyle: { color: paint(p) }, label: { position: labelSide(p) } }; })
    };

    if (q) {
      points.markLine = {
        z: 1, /* behind the dots and their name labels (markLine defaults to z 5, the points are z 3) */
        silent: true, animation: false, symbol: ['none', 'none'], label: { show: false },
        lineStyle: { color: T.axis, width: 1, type: 'solid' },
        data: [{ xAxis: q.x }, { yAxis: q.y }]
      };
      var corner = [
        { from: { xAxis: q.x, yAxis: q.y }, to: {}, pos: 'insideTopRight' },
        { from: { yAxis: q.y }, to: { xAxis: q.x }, pos: 'insideTopLeft' },
        { from: {}, to: { xAxis: q.x, yAxis: q.y }, pos: 'insideBottomLeft' },
        { from: { xAxis: q.x }, to: { yAxis: q.y }, pos: 'insideBottomRight' }
      ];
      points.markArea = {
        silent: true, animation: false, itemStyle: { opacity: 0 },
        label: { show: true, color: T.ink3, fontSize: FS_LABEL, distance: 6 },
        data: corner.map(function (k, i) {
          return [assign({ name: qLabels[i] || '', label: { position: k.pos } }, k.from), k.to];
        })
      };
    }

    /* pointer target of at least 28px around every dot; hovering it lifts the dot it belongs to */
    var halo = {
      id: SERIES_PREFIX + '__halo', type: 'scatter', z: 2, cursor: c.cursor, symbol: 'circle',
      itemStyle: { color: colour, opacity: 0 },
      emphasis: { disabled: true }, label: { show: false },
      data: pts.map(function (p) { return { name: String(p.name), value: [p.x, p.y], symbolSize: Math.max(28, sizeOf(p) + 12) }; })
    };

    var series = [halo, points];
    if (q) {
      /* invisible point so both guide lines are always inside the axis range */
      series.push({ id: SERIES_PREFIX + '__reach', type: 'scatter', silent: true, symbolSize: 0, itemStyle: { opacity: 0 }, label: { show: false }, tooltip: { show: false }, emphasis: { disabled: true }, data: [[q.x, q.y]] });
    }

    var option = {
      grid: grid(d.yLabel ? 26 : 10, 16, d.xLabel ? 26 : 2, 2),
      xAxis: valueAxis(xFmt, { zero: false, splitNumber: 5, name: d.xLabel, nameLocation: 'middle', nameGap: 30, scaleMax: maxAbsOf(pts.map(function (p) { return p.x; })) }),
      yAxis: valueAxis(yFmt, { zero: false, name: d.yLabel, nameLocation: 'end', nameGap: 12, nameStyle: { align: 'left' }, scaleMax: maxAbsOf(pts.map(function (p) { return p.y; })) }),
      tooltip: tooltipOption('item', function (p) {
        var pt = pts[p.dataIndex];
        if (!pt) return '';
        var tip = tipBox(String(pt.name));
        tip.row(paint(pt), xFmt(pt.x, 'tooltip'), d.xLabel || 'x');
        tip.row(null, yFmt(pt.y, 'tooltip'), d.yLabel || 'y');
        if (isNum(pt.size)) tip.row(null, sFmt(pt.size, 'tooltip'), d.sizeLabel || 'Size');
        return tip.node;
      }),
      series: series
    };
    option.xAxis.axisLine = { show: true, lineStyle: { color: T.axis, width: 1 } };
    option.xAxis.splitLine = { show: false };
    option.xAxis.boundaryGap = ['4%', '4%']; /* keeps edge dots, and their rings, inside the plot */
    option.yAxis.boundaryGap = ['6%', '6%'];

    function lift(chart, type, p) {
      if (seriesId(p) === '__halo') chart.dispatchAction({ type: type, seriesId: SERIES_PREFIX + 'points', dataIndex: p.dataIndex });
    }

    return {
      option: option,
      legend: [],
      events: {
        mouseover: function (chart, p) { lift(chart, 'highlight', p); },
        mouseout: function (chart, p) { lift(chart, 'downplay', p); }
      },
      click: function (p) {
        var pt = pts[p.dataIndex];
        if (!pt) return null;
        return { seriesId: pt.id === undefined ? null : pt.id, seriesName: String(pt.name), category: String(pt.name), value: pt.y, datum: pt };
      }
    };
  }
  builders.scatter = buildScatter;

  /* ------------------------------------------------------------------ divergingBar (horizontal, centred on zero) */

  function buildDiverging(c) {
    var T = theme(), d = c.data, fmt = c.fmt, signed = signedWith(fmt);
    var cats = strings(d.categories);
    var values = (d.values || []).map(num);
    if (!cats.length || !values.some(isNum)) return { empty: true };

    var posVar = d.invert ? T.neg : T.pos, negVar = d.invert ? T.pos : T.neg;
    var pos = resolveColour(posVar), neg = resolveColour(negVar);
    var maxAbs = 0;
    values.forEach(function (v) { if (v !== null) maxAbs = Math.max(maxAbs, Math.abs(v)); });
    var bound = niceCeil(maxAbs || 1);

    /*
     * Room is reserved once. A value label sits beside the zero line on the EMPTY side of its bar (a negative bar grows
     * left, its label reads on the right of zero), so neither end of the symmetric axis needs a label gutter and the
     * whole width left of the category column belongs to the plot - in a third-width card too.
     */
    var catStyle = categoryLabelStyle(c, cats, true, 0);
    var plotW = Math.max(0, c.width - 2 - catStyle.width - catStyle.margin - 12);
    var labelW = maxTextWidth(values.filter(isNum).map(function (v) { return signed(v, 'label'); }), FS_LABEL);
    var showLabels = plotW / 2 >= labelW + 10; /* else the tooltip and the table twin carry the values */
    /* the axis always reads -bound / 0 / +bound; the half-way ticks appear only where five tick labels fit */
    var tickW = Math.max(textWidth(signed(bound, 'axis', bound), FS_AXIS), textWidth(signed(-bound, 'axis', bound), FS_AXIS));
    var halves = plotW >= 5 * (tickW + 14);

    var bars = {
      id: SERIES_PREFIX + 'value', name: d.name || c.spec.title || 'Value', type: 'bar', z: 2,
      barMaxWidth: BAR_MAX, barCategoryGap: '30%', cursor: c.cursor,
      label: { show: showLabels, color: T.ink2, textBorderColor: T.surface, textBorderWidth: 2, fontSize: FS_LABEL, distance: 6, formatter: function (p) { return signed(p.value, 'label'); } },
      data: values.map(function (v) {
        var isNeg = v !== null && v < 0;
        return { value: v, itemStyle: { color: isNeg ? neg : pos, borderRadius: endRadius(true, isNeg) }, label: { position: isNeg ? 'right' : 'left' } };
      }),
      markLine: {
        silent: true, animation: false, symbol: ['none', 'none'],
        lineStyle: { color: T.axis, width: 1, type: 'solid' },
        label: { show: !!d.zeroLabel, position: 'start', distance: 4, color: T.ink2, fontSize: FS_LABEL, formatter: function () { return String(d.zeroLabel); } },
        data: [{ xAxis: 0 }]
      }
    };

    var option = {
      grid: grid(d.zeroLabel ? 20 : 4, 12, 0, 2),
      xAxis: valueAxis(signed, { min: -bound, max: bound, interval: halves ? bound / 2 : bound, scaleMax: bound,
        label: { showMinLabel: true, showMaxLabel: true, alignMinLabel: 'left', alignMaxLabel: 'right' } }),
      yAxis: categoryAxis(cats, { inverse: true, line: false, label: catStyle }),
      tooltip: tooltipOption('item', function (p) {
        var v = values[p.dataIndex];
        return tipBox(cats[p.dataIndex]).row(v !== null && v < 0 ? neg : pos, signed(v, 'tooltip'), bars.name).node;
      }),
      series: [bars]
    };

    var legend = [];
    if (d.posLabel || d.negLabel) {
      legend.push({ id: 'pos', name: d.posLabel || 'Above', colourVar: posVar, shape: 'rect' });
      legend.push({ id: 'neg', name: d.negLabel || 'Below', colourVar: negVar, shape: 'rect' });
    }

    return {
      option: option,
      legend: legend,
      click: function (p) {
        return { seriesId: null, seriesName: bars.name, category: cats[p.dataIndex], value: values[p.dataIndex], datum: { index: p.dataIndex } };
      }
    };
  }
  builders.divergingBar = buildDiverging;

  /* ================================================================== table twin */

  /*
   * The twin shows what the chart shows: series switched off in the legend (hidden) leave the table as well, and totals
   * and percentage shares are computed over the same visible set, so the two views of one card can never disagree.
   */
  function autoTable(spec, fmt, hidden) {
    var d = spec.data || {}, kind = spec.kind;
    var c = { spec: spec, data: d };
    var cols = [], rows = [];
    function numCell(v, f) { return { text: (f || fmt)(v, 'table'), num: true }; }
    function txt(v) { return { text: String(v), num: false }; }
    var all, cats, percent, pctFmt;

    if (kind === 'line' || kind === 'area') {
      all = visibleOf(seriesList(c), hidden || {});
      cols.push({ label: d.labelHeader || 'Period' });
      all.forEach(function (s) { cols.push({ label: s.name, num: true }); });
      if (d.showTotal && all.length > 1) cols.push({ label: 'Total', num: true });
      strings(d.labels).forEach(function (label, i) {
        var row = [txt(label)], total = 0;
        all.forEach(function (s) { var v = num(s.values[i]); if (v !== null) total += v; row.push(numCell(v)); });
        if (d.showTotal && all.length > 1) row.push(numCell(total));
        rows.push(row);
      });
    } else if (kind === 'bar' || kind === 'hbar' || kind === 'stackedBar' || kind === 'hstackedBar') {
      all = visibleOf(seriesList(c), hidden || {});
      cats = strings(d.categories);
      var stacked = kind === 'stackedBar' || kind === 'hstackedBar';
      percent = stacked && !!d.percent;
      pctFmt = makeFormatter('pct');
      var hasTarget = !stacked && all.length === 1 && (Array.isArray(d.target) || isNum(d.target));
      cols.push({ label: d.categoryHeader || 'Category' });
      all.forEach(function (s) { cols.push({ label: percent ? s.name + ' %' : s.name, num: true }); });
      if (stacked) cols.push({ label: 'Total', num: true });
      if (hasTarget) cols.push({ label: d.targetName || 'Target', num: true });
      cats.forEach(function (cat, j) {
        var row = [txt(cat)], total = 0;
        all.forEach(function (s) { total += Math.max(0, num(s.values[j]) || 0); });
        all.forEach(function (s) {
          var v = num(s.values[j]);
          row.push(percent ? numCell(v === null || !total ? null : Math.max(0, v) / total, pctFmt) : numCell(v));
        });
        if (stacked) row.push(numCell(total));
        if (hasTarget) row.push(numCell(Array.isArray(d.target) ? num(d.target[j]) : d.target));
        rows.push(row);
      });
    } else if (kind === 'heatmap') {
      var rLabels = strings(d.rows), cLabels = strings(d.cols), vals = d.values || [];
      /* keep the matrix narrow enough for a half-width card: long dimension runs down the page */
      var flip = cLabels.length > 8 && cLabels.length > rLabels.length;
      cols.push({ label: flip ? (d.colHeader || '') : (d.rowHeader || '') });
      (flip ? rLabels : cLabels).forEach(function (l) { cols.push({ label: l, num: true }); });
      (flip ? cLabels : rLabels).forEach(function (l, a) {
        var row = [txt(l)];
        (flip ? rLabels : cLabels).forEach(function (_, b) {
          var v = flip ? (vals[b] ? vals[b][a] : null) : (vals[a] ? vals[a][b] : null);
          row.push(numCell(num(v)));
        });
        rows.push(row);
      });
    } else if (kind === 'waterfall') {
      var signed = signedWith(fmt);
      var names = assign({ total: 'Total', plus: 'Increase', minus: 'Decrease' }, d.kindLabels);
      cols = [{ label: d.stepHeader || 'Step' }, { label: 'Type' }, { label: 'Amount', num: true }, { label: 'Running total', num: true }];
      waterfallRows(d.steps).forEach(function (r) {
        rows.push([txt(r.label), txt(names[r.kind]), r.kind === 'total' ? numCell(r.end) : numCell(r.change, signed), numCell(r.running)]);
      });
    } else if (kind === 'scatter') {
      var xF = makeFormatter(d.xFormat || 'num'), yF = makeFormatter(d.yFormat || 'num'), sF = makeFormatter(d.sizeFormat || 'num');
      var pts = d.points || [];
      var sized = pts.some(function (p) { return p && isNum(p.size); });
      cols = [{ label: d.nameHeader || 'Name' }, { label: d.xLabel || 'x', num: true }, { label: d.yLabel || 'y', num: true }];
      if (sized) cols.push({ label: d.sizeLabel || 'Size', num: true });
      pts.forEach(function (p) {
        if (!p) return;
        var row = [txt(p.name), numCell(num(p.x), xF), numCell(num(p.y), yF)];
        if (sized) row.push(numCell(num(p.size), sF));
        rows.push(row);
      });
    } else if (kind === 'divergingBar') {
      var sgn = signedWith(fmt);
      cols = [{ label: d.categoryHeader || 'Category' }, { label: d.name || 'Value', num: true }];
      strings(d.categories).forEach(function (cat, j) { rows.push([txt(cat), numCell(num((d.values || [])[j]), sgn)]); });
    }
    return { columns: cols, rows: rows };
  }

  function customTable(table, fmt) {
    var columns = (table.columns || []).map(function (col) {
      return { label: col.label === undefined ? String(col.key) : String(col.label), num: col.align ? col.align === 'right' : undefined, key: col.key, format: col.format };
    });
    var rows = (table.rows || []).map(function (rec) {
      return columns.map(function (col) {
        var v = rec[col.key];
        var f = col.format ? makeFormatter(col.format) : fmt;
        if (isNum(v)) return { text: f(v, 'table'), num: true };
        return { text: v === null || v === undefined ? '-' : String(v), num: false };
      });
    });
    columns.forEach(function (col, i) {
      if (col.num === undefined) col.num = i > 0 && rows.length > 0 && rows.every(function (r) { return r[i].num || r[i].text === '-'; });
    });
    return { columns: columns, rows: rows };
  }

  /* ================================================================== one-line summary for screen readers */

  function summarise(spec, fmt) {
    var d = spec.data || {}, kind = spec.kind, c = { spec: spec, data: d };
    var all, parts;
    try {
      if (kind === 'line' || kind === 'area') {
        all = seriesList(c);
        /* a forecast tail (2.1): "latest" is the last actual, and the forecast is named */
        var fcFrom = d.forecast && all.length === 1 && isNum(d.forecast.fromIndex) ? d.forecast.fromIndex : null;
        parts = all.slice(0, 4).map(function (s) { return s.name + ' ' + fmt(s.values[fcFrom !== null ? fcFrom - 1 : lastIndex(s.values)], 'tooltip'); });
        var n = strings(d.labels).length;
        return all.length + ' series over ' + (fcFrom !== null ? fcFrom + ' periods plus a ' + (n - fcFrom) + '-period forecast' : n + ' periods') + '. Latest: ' + parts.join(', ') + '.';
      }
      if (kind === 'bar' || kind === 'hbar' || kind === 'stackedBar' || kind === 'hstackedBar') {
        all = seriesList(c);
        var cats = strings(d.categories), best = -1, bestV = -Infinity;
        cats.forEach(function (_, j) { var t = 0; all.forEach(function (s) { t += num(s.values[j]) || 0; }); if (t > bestV) { bestV = t; best = j; } });
        return cats.length + ' categories, ' + all.length + ' series. Highest: ' + (best >= 0 ? cats[best] + ' ' + fmt(bestV, 'tooltip') : '-') + '.';
      }
      if (kind === 'heatmap') {
        var peak = null;
        (d.values || []).forEach(function (row, r) { (row || []).forEach(function (v, k) { if (isNum(v) && (!peak || v > peak.v)) peak = { v: v, r: r, k: k }; }); });
        return strings(d.rows).length + ' by ' + strings(d.cols).length + ' grid. Peak: ' + (peak ? strings(d.rows)[peak.r] + ', ' + strings(d.cols)[peak.k] + ' ' + fmt(peak.v, 'tooltip') : '-') + '.';
      }
      if (kind === 'waterfall') {
        var rows = waterfallRows(d.steps);
        if (!rows.length) return 'No data.';
        return rows.length + ' steps from ' + rows[0].label + ' ' + fmt(rows[0].end, 'tooltip') + ' to ' + rows[rows.length - 1].label + ' ' + fmt(rows[rows.length - 1].running, 'tooltip') + '.';
      }
      if (kind === 'scatter') return (d.points || []).length + ' points: ' + (d.xLabel || 'x') + ' against ' + (d.yLabel || 'y') + '.';
      if (kind === 'divergingBar') {
        var up = 0, down = 0;
        (d.values || []).forEach(function (v) { if (isNum(v)) { if (v > 0) up++; else if (v < 0) down++; } });
        return strings(d.categories).length + ' categories: ' + up + ' above and ' + down + ' below ' + (d.zeroLabel || 'zero') + '.';
      }
    } catch (e) { /* a summary must never break a chart */ }
    return '';
  }

  /* ================================================================== instances */

  var instances = [];
  var memory = {}; /* per route + card: Chart/Table choice and hidden series survive a page re-render */
  var uid = 0;

  function memoryKey(spec) {
    var hash = root.location && root.location.hash ? root.location.hash : '';
    return hash + '::' + (spec.id || spec.title || spec.kind || '');
  }

  function sweepDetached() {
    instances.slice().forEach(function (inst) { if (inst.wasConnected() && !inst.el.isConnected) inst.dispose(); });
  }

  function createInstance(rawSpec) {
    var spec = assign({}, rawSpec);
    var memKey = memoryKey(spec);
    var mem = memory[memKey] || (memory[memKey] = { view: 'chart', hidden: {} });
    var state = { chart: null, plan: null, fmt: null, w: 0, h: 0, raf: 0, timer: 0, ro: null, stale: false, first: true, page: 0, disposed: false, connected: false, controlValues: {} };
    var id = 'mk-chart-' + (++uid);

    /* ---- DOM skeleton */
    var rootEl = el('section', 'mk-chart');
    var head = el('header', 'mk-chart__head');
    var titles = el('div', 'mk-chart__titles');
    var titleEl = el('h3', 'mk-chart__title');
    var subEl = el('p', 'mk-chart__subtitle');
    var tools = el('div', 'mk-chart__tools');
    var controlsEl = el('div', 'mk-chart__controls');
    var viewSeg = el('div', 'mk-chart__seg mk-chart__seg--icons');
    var legendEl = el('ul', 'mk-chart__legend');
    var body = el('div', 'mk-chart__body');
    var plotEl = el('div', 'mk-chart__plot');
    var marksEl = el('div', 'mk-chart__marks');
    var tableEl = el('div', 'mk-chart__table');
    var emptyEl = el('div', 'mk-chart__empty');
    var noteEl = el('p', 'mk-chart__note');

    titleEl.id = id + '-title';
    rootEl.setAttribute('aria-labelledby', titleEl.id);
    viewSeg.setAttribute('role', 'group');
    viewSeg.setAttribute('aria-label', 'View as');
    legendEl.setAttribute('aria-label', 'Legend');
    plotEl.setAttribute('role', 'img');
    marksEl.setAttribute('aria-hidden', 'true');
    tableEl.hidden = true;
    emptyEl.hidden = true;

    var btnChart = el('button', 'mk-chart__segbtn');
    var btnTable = el('button', 'mk-chart__segbtn');
    [[btnChart, 'chart', 'Chart'], [btnTable, 'table', 'Table']].forEach(function (b) {
      b[0].type = 'button';
      b[0].title = b[2] + ' view';
      b[0].setAttribute('aria-label', b[2] + ' view');
      b[0].appendChild(icon(b[1]));
      b[0].addEventListener('click', function () { setView(b[1]); });
      viewSeg.appendChild(b[0]);
    });

    titles.appendChild(titleEl);
    titles.appendChild(subEl);
    tools.appendChild(controlsEl);
    tools.appendChild(viewSeg);
    head.appendChild(titles);
    head.appendChild(tools);
    body.appendChild(plotEl);
    body.appendChild(marksEl);
    body.appendChild(tableEl);
    body.appendChild(emptyEl);
    rootEl.appendChild(head);
    rootEl.appendChild(legendEl);
    rootEl.appendChild(body);
    rootEl.appendChild(noteEl);

    /* ---- chrome */
    /* the kit owns only its own classes: a page may have added a grid span (mk-col-8) or a layout hook, and it must survive every repaint */
    function syncClasses() {
      rootEl.classList.add('mk-chart');
      rootEl.classList.toggle('mk-chart--bare', !!spec.bare);
      rootEl.classList.toggle('is-table', mem.view === 'table' || !root.echarts);
    }

    function renderChrome() {
      if (KINDS.indexOf(spec.kind) === -1) warnOnce('kind:' + spec.kind, 'Unknown chart kind "' + spec.kind + '". Kinds: ' + KINDS.join(', ') + '.');
      state.fmt = makeFormatter(spec.format || 'num');
      syncClasses();
      rootEl.setAttribute('data-kind', spec.kind || '');
      titleEl.textContent = spec.title || '';
      titleEl.hidden = !spec.title;
      subEl.textContent = spec.subtitle || '';
      subEl.hidden = !spec.subtitle;
      noteEl.textContent = spec.note || '';
      noteEl.hidden = !spec.note;
      body.style.height = (isNum(spec.height) && spec.height > 0 ? spec.height : DEFAULT_HEIGHT) + 'px';
      emptyEl.textContent = spec.emptyText || 'No data for this selection';
    }

    function renderControls() {
      empty(controlsEl);
      (spec.controls || []).forEach(function (ctl) {
        if (!ctl || !ctl.options || !ctl.options.length) return;
        if (state.controlValues[ctl.id] === undefined) state.controlValues[ctl.id] = ctl.value === undefined ? ctl.options[0].value : ctl.value;
        var seg = el('div', 'mk-chart__seg');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', ctl.label || String(ctl.id));
        ctl.options.forEach(function (opt) {
          var b = el('button', 'mk-chart__segbtn', opt.label === undefined ? opt.value : opt.label);
          b.type = 'button';
          b.setAttribute('aria-pressed', String(state.controlValues[ctl.id] === opt.value));
          b.addEventListener('click', function () {
            if (state.controlValues[ctl.id] === opt.value) return;
            state.controlValues[ctl.id] = opt.value;
            Array.prototype.forEach.call(seg.children, function (other) { other.setAttribute('aria-pressed', String(other === b)); });
            if (typeof spec.onControl === 'function') spec.onControl(ctl.id, opt.value);
          });
          seg.appendChild(b);
        });
        controlsEl.appendChild(seg);
      });
    }

    function renderLegend(items) {
      empty(legendEl);
      var list = items || [];
      legendEl.hidden = !list.length;
      /* a legend that toggles series stays visible in table view (css/charts.css): it says which series the table includes */
      legendEl.classList.toggle('has-toggles', !(spec.table && typeof spec.table === 'object') && list.some(function (item) { return item.toggle; }));
      list.forEach(function (item) {
        var li = el('li', 'mk-chart__legitem');
        if (item.shape === 'scale') {
          li.className += ' mk-chart__scale';
          if (item.name) li.appendChild(el('span', 'mk-chart__scalename', item.name));
          li.appendChild(el('span', 'mk-chart__scaleend', item.minText));
          li.appendChild(el('span', 'mk-chart__ramp'));
          li.appendChild(el('span', 'mk-chart__scaleend', item.maxText));
          legendEl.appendChild(li);
          return;
        }
        var holder = item.toggle ? el('button', 'mk-chart__legbtn') : el('span', 'mk-chart__legstatic');
        var swatch = el('span', 'mk-chart__swatch mk-chart__swatch--' + (item.shape === 'line' ? 'line' : 'rect'));
        swatch.style.background = cssVar(item.colourVar);
        holder.appendChild(swatch);
        holder.appendChild(el('span', 'mk-chart__legname', item.name));
        if (item.toggle) {
          holder.type = 'button';
          holder.setAttribute('aria-pressed', String(!item.off));
          holder.title = item.off ? 'Show ' + item.name : 'Hide ' + item.name;
          holder.addEventListener('click', function () { toggleSeries(item.id, list); });
          holder.addEventListener('mouseenter', function () { hover('highlight', item.id); });
          holder.addEventListener('mouseleave', function () { hover('downplay', item.id); });
          holder.addEventListener('focus', function () { hover('highlight', item.id); });
          holder.addEventListener('blur', function () { hover('downplay', item.id); });
        }
        li.appendChild(holder);
        legendEl.appendChild(li);
      });
    }

    function hover(type, sid) {
      if (state.chart && mem.view === 'chart' && !mem.hidden[sid]) state.chart.dispatchAction({ type: type, seriesId: SERIES_PREFIX + sid });
    }

    function toggleSeries(sid, list) {
      var ids = list.filter(function (i) { return i.toggle; }).map(function (i) { return i.id; });
      if (mem.hidden[sid]) delete mem.hidden[sid]; else mem.hidden[sid] = true;
      if (ids.every(function (i) { return mem.hidden[i]; })) ids.forEach(function (i) { delete mem.hidden[i]; }); /* never an empty plot */
      draw(false);
      if (mem.view === 'table' || !root.echarts) renderTable(); /* the twin follows the legend too */
      var again = legendEl.querySelectorAll('.mk-chart__legbtn')[ids.indexOf(sid)];
      if (again) again.focus();
    }

    /* ---- chart */
    function context() {
      return { spec: spec, data: spec.data || {}, kind: spec.kind, fmt: state.fmt, width: state.w, height: state.h, hidden: mem.hidden, cursor: typeof spec.onClick === 'function' ? 'pointer' : 'default' };
    }

    function finish(option, animate) {
      var T = theme();
      option.animation = !!animate;
      option.animationDuration = 280;
      option.animationEasing = 'cubicOut';
      option.textStyle = { fontFamily: T.font, fontSize: 12, color: T.ink2 };
      option.color = [T.muted]; /* anything the wrapper did not colour on purpose stays grey */
      option.axisPointer = { lineStyle: { color: T.ink3, width: 1, type: 'solid' } }; /* no dashed default anywhere */
      return option;
    }

    function initChart() {
      if (state.chart || !root.echarts) return;
      state.chart = root.echarts.init(plotEl, null, { renderer: 'canvas' });
      state.chart.on('click', function (p) {
        if (typeof spec.onClick !== 'function' || !state.plan || !state.plan.click) return;
        var datum = state.plan.click(p);
        if (datum) spec.onClick(datum);
      });
      ['mouseover', 'mouseout'].forEach(function (evt) {
        state.chart.on(evt, function (p) {
          if (state.plan && state.plan.events && state.plan.events[evt]) state.plan.events[evt](state.chart, p);
        });
      });
      state.chart.getZr().on('click', function (e) {
        if (typeof spec.onClick !== 'function' || !state.plan || !state.plan.zrClick) return;
        var datum = state.plan.zrClick(state.chart, e.offsetX, e.offsetY);
        if (datum) spec.onClick(datum);
      });
    }

    function renderOverlay(plan) {
      empty(marksEl);
      if (!plan || !plan.overlay) return;
      plan.overlay(state.chart).forEach(function (m) {
        var tag = el('span', 'mk-chart__mark', m.text);
        tag.style.left = m.left + 'px';
        tag.style.top = m.top + 'px';
        marksEl.appendChild(tag);
      });
    }

    /** (Re)build the option from the spec. animate only on the very first paint. */
    function draw(animate) {
      var builder = builders[spec.kind];
      var c = context();
      var plan = builder ? builder(c, null) : { empty: true };

      plotEl.setAttribute('aria-label', (spec.title ? spec.title + '. ' : '') + (plan.empty ? 'No data for this selection.' : summarise(spec, state.fmt)));
      emptyEl.hidden = !plan.empty || mem.view !== 'chart';
      if (plan.empty) {
        state.plan = null;
        state.stale = false;
        renderLegend([]);
        empty(marksEl);
        if (state.chart) state.chart.clear();
        plotEl.style.visibility = 'hidden';
        return;
      }
      plotEl.style.visibility = '';
      renderLegend(plan.legend);
      if (mem.view !== 'chart' || !state.w || !state.h) { state.stale = true; return; }
      if (!state.chart) initChart();
      if (!state.chart) return;

      if (plan.measure) {
        state.chart.setOption(finish(plan.option, false), true);
        var hints = plan.measure(state.chart);
        if (hints) plan = builder(c, hints);
        if (animate) state.chart.clear(); /* so the real pass still plays its entrance */
      }
      state.chart.setOption(finish(plan.option, animate), true);
      state.plan = plan;
      state.stale = false;
      state.first = false;
      renderOverlay(plan);
    }

    /* ---- table twin */
    var ROW_H = 28, HEAD_H = 30, PAGER_H = 36;

    function renderTable() {
      empty(tableEl);
      var model = spec.table && typeof spec.table === 'object' ? customTable(spec.table, state.fmt) : autoTable(spec, state.fmt, mem.hidden);
      if (!model.rows.length) { tableEl.appendChild(el('div', 'mk-chart__empty mk-chart__empty--inline', spec.emptyText || 'No data for this selection')); return; }

      var h = state.h || (isNum(spec.height) ? spec.height : DEFAULT_HEIGHT);
      var fit = Math.max(3, Math.floor((h - HEAD_H) / ROW_H));
      var paged = model.rows.length > fit;
      var per = paged ? Math.max(3, Math.floor((h - HEAD_H - PAGER_H) / ROW_H)) : model.rows.length;
      var pages = Math.max(1, Math.ceil(model.rows.length / per));
      state.page = clamp(state.page, 0, pages - 1);
      var from = state.page * per, to = Math.min(model.rows.length, from + per);

      var wrap = el('div', 'mk-chart__tablewrap');
      var table = el('table', 'mk-chart__tbl');
      table.appendChild(el('caption', 'mk-chart__sr', (spec.title || 'Chart') + ' - data table'));
      var thead = el('thead'), trh = el('tr');
      model.columns.forEach(function (col) {
        var th = el('th', col.num ? 'is-num' : '', col.label);
        th.setAttribute('scope', 'col');
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);
      var tbody = el('tbody');
      model.rows.slice(from, to).forEach(function (row) {
        var tr = el('tr');
        row.forEach(function (cell, i) {
          var td = el(i === 0 ? 'th' : 'td', cell.num ? 'is-num' : '', cell.text);
          if (i === 0) td.setAttribute('scope', 'row');
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      tableEl.appendChild(wrap);

      if (paged) {
        var pager = el('div', 'mk-chart__pager');
        pager.appendChild(el('span', 'mk-chart__pagerinfo', (from + 1) + '-' + to + ' of ' + model.rows.length));
        [['prev', -1, 'Previous rows'], ['next', 1, 'Next rows']].forEach(function (def) {
          var b = el('button', 'mk-chart__pagerbtn');
          b.type = 'button';
          b.title = def[2];
          b.setAttribute('aria-label', def[2]);
          b.disabled = def[1] < 0 ? state.page === 0 : state.page >= pages - 1;
          b.appendChild(icon(def[0]));
          b.addEventListener('click', function () {
            state.page += def[1];
            renderTable();
            var same = tableEl.querySelectorAll('.mk-chart__pagerbtn')[def[1] < 0 ? 0 : 1];
            if (same && !same.disabled) same.focus();
          });
          pager.appendChild(b);
        });
        tableEl.appendChild(pager);
      }
    }

    /* ---- view switch */
    function applyView() {
      var asTable = mem.view === 'table' || !root.echarts;
      btnChart.setAttribute('aria-pressed', String(!asTable));
      btnTable.setAttribute('aria-pressed', String(asTable));
      viewSeg.hidden = !root.echarts;
      syncClasses();
      plotEl.hidden = asTable;
      marksEl.hidden = asTable;
      tableEl.hidden = !asTable;
      if (asTable) {
        if (state.chart) state.chart.dispatchAction({ type: 'hideTip' });
        emptyEl.hidden = true;
        renderTable();
      } else {
        emptyEl.hidden = !!state.plan || state.stale;
        if (state.stale && state.w && state.h) {
          if (state.chart) state.chart.resize();
          draw(state.first);
        }
      }
    }

    function setView(view) {
      if (mem.view === view) return;
      mem.view = view;
      applyView();
    }

    /* ---- sizing: one observer per card, coalesced to a frame */
    function readSize() {
      var w = body.clientWidth, h = body.clientHeight;
      if (!w || !h) return false;
      state.connected = true;
      if (w === state.w && h === state.h) return false;
      state.w = w;
      state.h = h;
      return true;
    }
    function onSize() {
      state.raf = 0;
      state.timer = 0;
      if (state.disposed || !readSize()) return;
      if (mem.view === 'chart' && root.echarts) {
        if (state.chart) state.chart.resize();
        draw(state.first);
      } else {
        state.stale = true;
        renderTable();
      }
    }
    function scheduleSize() {
      if (state.raf || state.timer || state.disposed) return;
      /* a hidden tab gets no animation frames; a timer keeps a background page correct */
      if (doc.hidden) state.timer = root.setTimeout(onSize, 60);
      else state.raf = root.requestAnimationFrame(onSize);
    }

    function start() {
      renderChrome();
      renderControls();
      draw(true);          /* legend and empty state now; the plot is drawn on the next frame, when the page around it */
      applyView();         /* has been built and the width is final (no redraw when a scrollbar appears) */
      if (root.ResizeObserver) {
        state.ro = new root.ResizeObserver(scheduleSize);
        state.ro.observe(body);
      } else {
        root.addEventListener('resize', scheduleSize);
      }
      scheduleSize();
    }

    function update(partial) {
      if (state.disposed || !partial) return controller;
      var dataChanged = 'data' in partial || 'kind' in partial || 'table' in partial;
      if ('controls' in partial) state.controlValues = {};
      assign(spec, partial);
      renderChrome();
      if ('controls' in partial) renderControls();
      if (dataChanged) state.page = 0;
      if ('height' in partial) { state.w = 0; scheduleSize(); }
      draw(false);
      /* new data on a chart already on screen (a control, a dial): the preview shows it being fetched (MK.latency, optional) */
      if (dataChanged && state.connected && root.MK && root.MK.latency) {
        var loadTitle = String(spec.title || 'the chart');
        root.MK.latency.part(body, 'chart', 'Loading ' + loadTitle.charAt(0).toLowerCase() + loadTitle.slice(1), 'recalc');
      }
      if (mem.view === 'table' || !root.echarts) renderTable();
      return controller;
    }

    function dispose() {
      if (state.disposed) return;
      state.disposed = true;
      if (state.raf) root.cancelAnimationFrame(state.raf);
      if (state.timer) root.clearTimeout(state.timer);
      if (state.ro) state.ro.disconnect(); else root.removeEventListener('resize', scheduleSize);
      if (state.chart) { state.chart.dispose(); state.chart = null; }
      var at = instances.indexOf(inst);
      if (at !== -1) instances.splice(at, 1);
      if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    }

    var controller = { el: rootEl, update: update, dispose: dispose };
    var inst = { el: rootEl, controller: controller, start: start, dispose: dispose, wasConnected: function () { return state.connected; } };
    return inst;
  }

  /**
   * Build a chart card inside parent (or detached when parent is null - append controller.el yourself).
   * Returns { el, update(partialSpec), dispose() }.
   */
  function mount(parent, spec) {
    sweepDetached();
    var inst = createInstance(spec || {});
    if (parent) parent.appendChild(inst.el);
    instances.push(inst);
    inst.start();
    return inst.controller;
  }

  /** Dispose every chart mounted inside container (all charts when container is omitted). */
  function disposeAll(container) {
    instances.slice().forEach(function (inst) {
      if (!container || container === inst.el || container.contains(inst.el)) inst.dispose();
    });
  }

  /* ================================================================== sparkline (inline SVG, no ECharts) */

  function sparkline(target, values, opts) {
    var o = opts || {};
    var w = o.width || 96, h = o.height || 28, pad = 4;
    var fmt = makeFormatter(o.format || 'num');
    var pts = (values || []).map(num);
    var nums = pts.filter(isNum);

    var node = svg('svg', { 'class': 'mk-spark', width: String(w), height: String(h), viewBox: '0 0 ' + w + ' ' + h, role: 'img', focusable: 'false' });
    var label = o.label ? o.label + ': ' : '';

    if (!nums.length) {
      node.setAttribute('aria-label', label + 'no data');
      node.appendChild(svg('path', { 'class': 'mk-spark__line mk-spark__line--empty', d: 'M' + pad + ' ' + (h / 2) + 'H' + (w - pad) }));
    } else {
      var lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums), flat = hi === lo;
      var n = pts.length;
      var xAt = function (i) { return n === 1 ? w - pad : pad + (w - 2 * pad) * i / (n - 1); };
      var yAt = function (v) { return flat ? h / 2 : pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo)); };
      var dPath = '', runs = [], run = [];
      pts.forEach(function (v, i) {
        if (v === null) { if (run.length) runs.push(run); run = []; return; }
        run.push([xAt(i), yAt(v)]);
      });
      if (run.length) runs.push(run);
      runs.forEach(function (r) {
        r.forEach(function (p, i) { dPath += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); });
      });
      if (o.area && runs.length === 1 && runs[0].length > 1) {
        var r0 = runs[0];
        node.appendChild(svg('path', { 'class': 'mk-spark__area', d: dPath + 'L' + r0[r0.length - 1][0].toFixed(1) + ' ' + (h - 1) + 'L' + r0[0][0].toFixed(1) + ' ' + (h - 1) + 'Z' }));
      }
      node.appendChild(svg('path', { 'class': 'mk-spark__line', d: dPath }));
      var li = lastIndex(pts);
      if (o.emphasiseLast !== false && li >= 0) {
        var dot = svg('circle', { 'class': 'mk-spark__dot', cx: xAt(li).toFixed(1), cy: yAt(pts[li]).toFixed(1), r: '3' });
        dot.style.fill = cssVar(o.colourVar || '--seq-500');
        node.appendChild(dot);
      }
      var first = nums[0], last = nums[nums.length - 1];
      var change = MK.fmt && first ? MK.fmt.delta(last, first).label : '';
      node.setAttribute('aria-label', label + fmt(first, 'tooltip') + ' to ' + fmt(last, 'tooltip') + (change && change !== '-' ? ' (' + change + ')' : ''));
    }

    if (target) { empty(target); target.appendChild(node); }
    return node;
  }

  /* ================================================================== public API */

  MK.charts = {
    kinds: KINDS.slice(),
    token: token,
    colourFor: colourFor,
    colour: function (kind, idOrIndex) { return resolveColour(colourFor(kind, idOrIndex)); },
    mount: mount,
    card: mount,
    sparkline: sparkline,
    disposeAll: disposeAll,
    format: function (format) { return makeFormatter(format || 'num'); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
