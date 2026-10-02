/*
 * MK.ui - DOM helpers and the component kit. Every component returns a DOM node unless
 * docs/UI-API.md says it returns a controller. No colours here: classes + css/tokens.css only.
 * Strings always enter the DOM as text nodes (see h()); nothing in this file builds HTML from data.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});
  var doc = root.document;
  var ui = MK.ui = {};
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SVG_TAGS = { svg: 1, path: 1, circle: 1, rect: 1, line: 1, ellipse: 1, g: 1, polyline: 1, polygon: 1, title: 0 };
  var PROPS = { value: 1, checked: 1, selected: 1, disabled: 1, readOnly: 1, indeterminate: 1, tabIndex: 1, htmlFor: 1 };
  var uid = 0;

  function nextId(prefix) { uid += 1; return (prefix || 'mk') + '-' + uid; }
  function isNode(x) { return !!x && typeof x === 'object' && typeof x.nodeType === 'number'; }
  function isPlainObject(x) { return !!x && typeof x === 'object' && !isNode(x) && !Array.isArray(x); }

  /* ---------------------------------------------------------------- h() */

  function append(parent, child) {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) { for (var i = 0; i < child.length; i++) append(parent, child[i]); return; }
    if (isNode(child)) { parent.appendChild(child); return; }
    parent.appendChild(doc.createTextNode(String(child)));
  }

  function setAttr(el, key, val) {
    if (val === null || val === undefined || val === false) return;
    if (key === 'class' || key === 'className') {
      var cls = Array.isArray(val) ? val.filter(Boolean).join(' ') : String(val);
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'style' && typeof val === 'object') {
      Object.keys(val).forEach(function (k) {
        if (val[k] === null || val[k] === undefined || val[k] === false) return;
        if (k.indexOf('-') !== -1) el.style.setProperty(k, String(val[k])); else el.style[k] = val[k];
      });
    } else if (key === 'dataset' && typeof val === 'object') {
      Object.keys(val).forEach(function (k) { if (val[k] !== null && val[k] !== undefined) el.dataset[k] = String(val[k]); });
    } else if (/^on[A-Z]/.test(key)) {
      if (typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (key === 'for') {
      el.htmlFor = val;
    } else if (PROPS[key] && !(el instanceof root.SVGElement)) {
      el[key] = val;
    } else if (val === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(val));
    }
  }

  /** h('div', {class: 'x', onClick: fn}, 'text', node, [more]) - strings become text nodes. */
  ui.h = function (tag, attrs) {
    var el = SVG_TAGS[tag] ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    var first = 1;
    if (isPlainObject(attrs)) {
      Object.keys(attrs).forEach(function (k) { setAttr(el, k, attrs[k]); });
      first = 2;
    }
    for (var i = first; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  };
  var h = ui.h;

  ui.clear = function (node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; };
  ui.append = function (parent) { for (var i = 1; i < arguments.length; i++) append(parent, arguments[i]); return parent; };
  ui.uid = nextId;

  /** Read a CSS custom property from :root, e.g. token('--ch-swiggy'). */
  ui.token = function (name) {
    if (MK.charts && typeof MK.charts.token === 'function') return MK.charts.token(name);
    return root.getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
  };

  /* -------------------------------------------------------------- format */

  function formatValue(format, value, row) {
    if (typeof format === 'function') return format(value, row);
    if (value === null || value === undefined || value === '') return '-';
    switch (format) {
      case 'inr': return MK.fmt.inr(value);
      case 'inrFull': return MK.fmt.inrFull(value);
      case 'num': return MK.fmt.num(value);
      case 'num1': return MK.fmt.num(value, 1);
      case 'pct': return MK.fmt.pct(value);
      case 'kg': return MK.fmt.kg(value);
      case 'date': return MK.dates.label(String(value), 'd MMM yyyy');
      default: return String(value);
    }
  }
  ui.format = formatValue;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** '2026-09-16T14:32' | '2026-09-16' | epoch ms -> '16 Sep 2026, 14:32' */
  ui.dateTime = function (at) {
    if (at === null || at === undefined || at === '') return '';
    if (typeof at === 'number') {
      var d = new Date(at);
      var iso = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      return MK.dates.label(iso, 'd MMM yyyy') + ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    var s = String(at);
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
    var out = MK.dates.label(s.slice(0, 10), 'd MMM yyyy');
    var t = /[T ](\d{2}:\d{2})/.exec(s);
    return t ? out + ', ' + t[1] : out;
  };

  /* --------------------------------------------------------------- icons */
  /* 24px grid, stroke only. Spec strings: path data, or 'c:cx,cy,r' | 'r:x,y,w,h,rx' | 'e:cx,cy,rx,ry'. */

  var ICONS = {
    'home': ['M3 10.5 12 3l9 7.5', 'M5 9.5V20h14V9.5', 'M10 20v-6h4v6'],
    'chart': ['M3 21h18', 'M6 17v-6', 'M12 17V5', 'M18 17V8'],
    'clock': ['c:12,12,9', 'M12 7v5l3 2'],
    'dish': ['M3 18h18', 'M5 18a7 7 0 0 1 14 0', 'M12 11V8.5', 'M10.5 8.5h3'],
    'shield-check': ['M12 3l7 3v5.5c0 4.4-2.9 7.8-7 9.5-4.1-1.7-7-5.1-7-9.5V6z', 'M9 12l2.2 2.2L15 10.2'],
    'receipt': ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6'],
    'coins': ['c:9,9,6', 'M15 9a6 6 0 1 1-6 6'],
    'scale': ['M12 4v16', 'M7 20h10', 'M5 7h14', 'M5 7l-2.5 6a2.8 2.8 0 0 0 5 0z', 'M19 7l-2.5 6a2.8 2.8 0 0 0 5 0z'],
    'calculator': ['r:5,3,14,18,2', 'M8.5 7.5h7', 'M8.5 12h.01', 'M12 12h.01', 'M15.5 12h.01', 'M8.5 16h.01', 'M12 16h.01', 'M15.5 16h.01'],
    'check-circle': ['c:12,12,9', 'M8.5 12.2l2.4 2.4 4.6-4.8'],
    'x-circle': ['c:12,12,9', 'M9.2 9.2l5.6 5.6', 'M14.8 9.2l-5.6 5.6'],
    'alert-triangle': ['M12 4 2.8 19.5h18.4z', 'M12 10v4.5', 'M12 17.2h.01'],
    'info': ['c:12,12,9', 'M12 11v5.5', 'M12 7.8h.01'],
    'building': ['r:5,3,14,18,1.5', 'M9 8h2', 'M13 8h2', 'M9 12h2', 'M13 12h2', 'M10 21v-4h4v4'],
    'factory': ['M3 21V10l6 3.5V10l6 3.5V5h6v16z', 'M8 17h.01', 'M12 17h.01', 'M16 17h.01'],
    'store': ['M4 10v10h16V10', 'M2.5 9.5 4.5 4h15l2 5.5', 'M2.5 9.5a3.2 3.2 0 0 0 6.3 0 3.2 3.2 0 0 0 6.4 0 3.2 3.2 0 0 0 6.3 0', 'M10 20v-5h4v5'],
    'truck': ['M2 6h11v10H2z', 'M13 9h4.5L21 12.5V16h-8z', 'c:7,17.5,1.8', 'c:17,17.5,1.8'],
    'box': ['M12 3l8 4.2v9.6L12 21l-8-4.2V7.2z', 'M4 7.2l8 4.3 8-4.3', 'M12 11.5V21'],
    'bank': ['M3 9.5 12 4l9 5.5', 'M4 9.5h16', 'M6 12.5v5', 'M10 12.5v5', 'M14 12.5v5', 'M18 12.5v5', 'M3.5 20.5h17'],
    'wallet': ['M3.5 7.5v10a2 2 0 0 0 2 2h15v-12h-15a2 2 0 0 1 0-4H18v4', 'M16.5 13.5h.01'],
    'layers': ['M12 4l9 4.5-9 4.5-9-4.5z', 'M3 12.5l9 4.5 9-4.5', 'M3 16.5l9 4.5 9-4.5'],
    'grid': ['r:4,4,7,7,1.5', 'r:13,4,7,7,1.5', 'r:4,13,7,7,1.5', 'r:13,13,7,7,1.5'],
    'list': ['M8 6.5h12', 'M8 12h12', 'M8 17.5h12', 'M4 6.5h.01', 'M4 12h.01', 'M4 17.5h.01'],
    'database': ['e:12,6,7,3', 'M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6', 'M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3'],
    'users': ['c:9,8.5,3.2', 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6', 'M16 5.6a3.2 3.2 0 0 1 0 5.8', 'M17.5 14.4c2.1.8 3.5 2.9 3.5 5.6'],
    'user': ['c:12,8.5,3.5', 'M5 20.5c0-3.9 3.1-7 7-7s7 3.1 7 7'],
    'chevron-down': ['M6 9.5l6 6 6-6'],
    'chevron-up': ['M6 14.5l6-6 6 6'],
    'chevron-right': ['M9.5 6l6 6-6 6'],
    'chevron-left': ['M14.5 6l-6 6 6 6'],
    'arrow-up': ['M12 19V5', 'M6 11l6-6 6 6'],
    'arrow-down': ['M12 5v14', 'M6 13l6 6 6-6'],
    'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
    'plus': ['M12 5v14', 'M5 12h14'],
    'minus': ['M5 12h14'],
    'check': ['M5 12.5l4.5 4.5L19 7.5'],
    'x': ['M6 6l12 12', 'M18 6 6 18'],
    'search': ['c:11,11,6.5', 'M16 16l4.5 4.5'],
    'filter': ['M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z'],
    'download': ['M12 4v11', 'M7 10.5l5 5 5-5', 'M4.5 20h15'],
    'upload': ['M12 16V5', 'M7 9.5l5-5 5 5', 'M4.5 20h15'],
    'edit': ['M4 20l1-4.2L16.3 4.5a2.2 2.2 0 0 1 3.2 3.2L8.2 19z', 'M14.5 6.5l3 3'],
    'more': ['c:5,12,1', 'c:12,12,1', 'c:19,12,1'],
    'refresh': ['M20 11a8 8 0 0 0-14.3-4.3L4 8.5', 'M4 4v4.5h4.5', 'M4 13a8 8 0 0 0 14.3 4.3L20 15.5', 'M20 20v-4.5h-4.5'],
    'external': ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    'calendar': ['r:4,5.5,16,15,2', 'M4 10h16', 'M8.5 3.5v4', 'M15.5 3.5v4'],
    'paperclip': ['M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8'],
    'lock': ['r:5,11,14,9.5,2', 'M8 11V8a4 4 0 0 1 8 0v3'],
    'eye': ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'c:12,12,2.8'],
    'file': ['M6 3h8l4.5 4.5V21H6z', 'M14 3v5h4.5'],
    'copy': ['r:8.5,8.5,11.5,11.5,2', 'M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5'],
    'trash': ['M4.5 6.5h15', 'M9 6.5V4h6v2.5', 'M6.5 6.5l.8 13.5h9.4l.8-13.5']
  };
  ICONS.overview = ICONS.home;

  /** icon('check-circle', 16) -> <svg>. Unknown names fall back to 'info'. */
  ui.icon = function (name, size) {
    var spec = ICONS[name] || ICONS.info;
    var px = size || 16;
    var svg = h('svg', {
      'class': 'mk-icon', width: px, height: px, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': px >= 20 ? 1.5 : 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', focusable: 'false'
    });
    spec.forEach(function (s) {
      var kind = s.charAt(1) === ':' ? s.charAt(0) : 'p';
      var n = kind === 'p' ? null : s.slice(2).split(',');
      if (kind === 'p') svg.appendChild(h('path', { d: s }));
      else if (kind === 'c') svg.appendChild(h('circle', { cx: n[0], cy: n[1], r: n[2] }));
      else if (kind === 'e') svg.appendChild(h('ellipse', { cx: n[0], cy: n[1], rx: n[2], ry: n[3] }));
      else if (kind === 'r') svg.appendChild(h('rect', { x: n[0], y: n[1], width: n[2], height: n[3], rx: n[4] || 0 }));
    });
    return svg;
  };
  ui.iconNames = function () { return Object.keys(ICONS); };
  var icon = ui.icon;

  /* ------------------------------------------------------------- buttons */

  /**
   * button({label, icon, iconRight, variant, size, onClick, disabled, disabledReason, title, type, block, ariaLabel})
   * variant: 'secondary' (default) | 'primary' | 'ghost' | 'danger' | 'text'. A non-empty disabledReason keeps the
   * button focusable (aria-disabled) and shows the reason as its tooltip - used for maker-checker segregation.
   */
  ui.button = function (o) {
    o = typeof o === 'string' ? { label: o } : (o || {});
    var blocked = !!o.disabledReason;
    var btn = h('button', {
      type: o.type || 'button',
      'class': ['mk-btn', o.variant && o.variant !== 'secondary' ? 'mk-btn--' + o.variant : '', o.size === 'sm' ? 'mk-btn--sm' : '',
        !o.label && o.icon ? 'mk-btn--icon' : '', o.block ? 'mk-btn--block' : '', o.className],
      title: blocked ? o.disabledReason : o.title,
      'aria-label': o.ariaLabel || (!o.label ? o.title : null),
      'aria-disabled': blocked ? 'true' : null,
      disabled: o.disabled && !blocked ? true : null
    }, o.icon ? icon(o.icon) : null, o.label || null, o.iconRight ? icon(o.iconRight) : null);
    btn.addEventListener('click', function (e) {
      if (blocked || btn.disabled) { e.preventDefault(); e.stopPropagation(); return; }
      if (typeof o.onClick === 'function') o.onClick(e);
    });
    return btn;
  };

  ui.iconButton = function (iconName, label, onClick, o) {
    o = o || {};
    return ui.button({ icon: iconName, title: label, ariaLabel: label, onClick: onClick, variant: o.variant || 'ghost', size: o.size, disabledReason: o.disabledReason });
  };

  /** In-app link: link('Open bills', '#/approvals/bills'). */
  ui.link = function (label, route, o) {
    o = o || {};
    return h('a', { 'class': 'mk-link', href: route, title: o.title }, label, o.icon ? icon(o.icon, 14) : null);
  };

  /* -------------------------------------------------------------- layout */

  /** grid(3, nodes) -> three equal columns; grid([8, 4], nodes) -> 12-column grid with those spans (repeating). */
  ui.grid = function (cols, children, o) {
    o = o || {};
    var spans = Array.isArray(cols) ? cols : null;
    var el = h('div', { 'class': ['mk-grid', spans ? 'mk-grid--12' : 'mk-grid--' + (cols || 1), o.tight ? 'mk-grid--tight' : '', o.start ? 'mk-grid--start' : '', o.className] });
    var flat = [];
    (function walk(c) { if (Array.isArray(c)) c.forEach(walk); else if (c !== null && c !== undefined && c !== false) flat.push(c); })(children || []);
    flat.forEach(function (child, i) {
      var node = isNode(child) ? child : h('div', null, child);
      if (spans) node.classList.add('mk-col-' + spans[i % spans.length]);
      el.appendChild(node);
    });
    return el;
  };

  ui.row = function (children, o) {
    o = o || {};
    return h('div', { 'class': ['mk-row', o.wrap ? 'mk-row--wrap' : '', o.between ? 'mk-row--between' : '', o.end ? 'mk-row--end' : '', o.top ? 'mk-row--top' : '', o.gap ? 'mk-gap-' + o.gap : '', o.className] }, children);
  };

  ui.stack = function (children, gap, className) {
    return h('div', { 'class': ['mk-stack', gap ? 'mk-stack--' + gap : '', className] }, children);
  };

  ui.sectionTitle = function (title, sub, actions) {
    return h('div', { 'class': 'mk-section-title' },
      h('h2', { 'class': 'mk-h3' }, title),
      sub ? h('span', { 'class': 'mk-section-title__sub' }, sub) : null,
      actions ? h('div', { 'class': 'mk-section-title__actions' }, actions) : null);
  };

  /**
   * card({title, subtitle, actions, body, footer, flush, className, id}) -> element; element.bodyEl is the body container.
   * flush: true removes the body padding (use it when the body is a table).
   */
  ui.card = function (o) {
    o = o || {};
    var body = h('div', { 'class': ['mk-card__body', o.flush ? 'mk-card__body--flush' : ''] }, o.body);
    var hasHead = o.title || o.subtitle || o.actions;
    var el = h('section', { 'class': ['mk-card', o.className], id: o.id },
      hasHead ? h('header', { 'class': 'mk-card__head' },
        h('div', { 'class': 'mk-card__titles' },
          o.title ? h('h3', { 'class': 'mk-card__title' }, o.title) : null,
          o.subtitle ? h('p', { 'class': 'mk-card__subtitle' }, o.subtitle) : null),
        o.actions ? h('div', { 'class': 'mk-card__actions' }, o.actions) : null) : null,
      body,
      o.footer ? h('footer', { 'class': 'mk-card__foot' }, o.footer) : null);
    el.bodyEl = body;
    return el;
  };

  /* ---------------------------------------------- delta, hero, stat tiles */

  /**
   * deltaBadge({label, dir}, goodWhen, {note, size}) - dir 'up' | 'down' | 'flat'; goodWhen 'up' | 'down' | 'neutral'.
   * Meaning is carried by arrow + signed label; colour only reinforces it.
   */
  ui.deltaBadge = function (delta, goodWhen, o) {
    o = o || {};
    if (!delta || delta.label === undefined || delta.label === null || delta.label === '-') return null;
    var dir = delta.dir || 'flat';
    var gw = goodWhen || 'up';
    var tone = dir === 'flat' || gw === 'neutral' ? '' : (dir === gw ? 'mk-delta--good' : 'mk-delta--bad');
    var word = dir === 'flat' ? 'No change' : (dir === 'up' ? 'Up' : 'Down');
    return h('span', { 'class': ['mk-delta', tone, o.size === 'lg' ? 'mk-delta--lg' : ''] },
      icon(dir === 'up' ? 'arrow-up' : (dir === 'down' ? 'arrow-down' : 'minus'), o.size === 'lg' ? 16 : 14),
      h('span', { 'class': 'mk-sr' }, word + ' '),
      delta.label,
      o.note ? h('span', { 'class': 'mk-delta__note' }, o.note) : null);
  };

  /** hero({label, value, delta, goodWhen, deltaNote, sub}) - the one big figure of a page. */
  ui.hero = function (o) {
    o = o || {};
    return h('div', { 'class': 'mk-hero' },
      h('div', { 'class': 'mk-hero__label' }, o.label),
      h('div', { 'class': 'mk-hero__line' },
        h('div', { 'class': 'mk-hero__value' }, o.value),
        ui.deltaBadge(o.delta, o.goodWhen, { note: o.deltaNote, size: 'lg' })),
      o.sub ? h('div', { 'class': 'mk-hero__sub' }, o.sub) : null);
  };

  /**
   * statTile({label, value, delta, goodWhen, deltaNote, sub, spark, sparkColourVar, onClick, icon, tone, title})
   * spark: array of numbers (drawn only when MK.charts.sparkline exists). onClick turns the tile into a button.
   */
  ui.statTile = function (o) {
    o = o || {};
    var clickable = typeof o.onClick === 'function';
    var sparkEl = null;
    if (Array.isArray(o.spark) && o.spark.length > 1 && MK.charts && typeof MK.charts.sparkline === 'function') {
      sparkEl = h('span', { 'class': 'mk-tile__spark', 'aria-hidden': 'true' }); /* span: the tile may be a <button> */
      try { MK.charts.sparkline(sparkEl, o.spark, { colourVar: o.sparkColourVar || '--series-1', emphasiseLast: true }); }
      catch (e) { sparkEl = null; if (root.console) root.console.warn('[MK.ui] sparkline failed', e); }
    }
    var deltaEl = ui.deltaBadge(o.delta, o.goodWhen, { note: o.deltaNote });
    var el = h(clickable ? 'button' : 'div', {
      'class': ['mk-tile', o.tone ? 'mk-tile--' + o.tone : ''], type: clickable ? 'button' : null, title: o.title
    },
      h('span', { 'class': 'mk-tile__label' }, o.icon ? icon(o.icon, 14) : null, o.label,
        clickable ? h('span', { 'class': 'mk-tile__go' }, icon('arrow-right', 14)) : null),
      h('span', { 'class': 'mk-tile__value' }, o.value),
      (deltaEl || o.sub) ? h('span', { 'class': 'mk-tile__meta' }, deltaEl, o.sub ? h('span', { 'class': 'mk-tile__sub' }, o.sub) : null) : null,
      sparkEl);
    if (clickable) el.addEventListener('click', o.onClick);
    return el;
  };

  /** kpiRow([tileOptions | node, ...]) - responsive row of stat tiles. */
  ui.kpiRow = function (tiles) {
    return h('div', { 'class': 'mk-kpis' }, (tiles || []).filter(Boolean).map(function (t) { return isNode(t) ? t : ui.statTile(t); }));
  };

  /* --------------------------------------------------------------- chips */

  /** chip('Bandra', 'info', {icon, dotVar, outline, title}) - tone: neutral | info | good | warn | serious | critical. */
  ui.chip = function (label, tone, o) {
    o = o || {};
    return h('span', { 'class': ['mk-chip', tone && tone !== 'neutral' ? 'mk-chip--' + tone : '', o.outline ? 'mk-chip--outline' : ''], title: o.title },
      o.dotVar ? h('span', { 'class': 'mk-chip__dot', style: { background: 'var(' + o.dotVar + ')' } }) : null,
      o.icon ? icon(o.icon, 14) : null, label);
  };

  var STATES = {
    DRAFT: ['neutral', 'edit', 'Draft'],
    SUBMITTED: ['info', 'upload', 'Submitted'],
    UNDER_REVIEW: ['info', 'eye', 'Under review'],
    APPROVED: ['good', 'check-circle', 'Approved'],
    REJECTED: ['critical', 'x-circle', 'Rejected'],
    IN_BATCH: ['info', 'layers', 'In payment batch'],
    PAID: ['good', 'check-circle', 'Paid'],
    PENDING_RELEASE: ['warn', 'clock', 'Pending release'],
    RELEASED: ['info', 'external', 'Released to bank'],
    VERIFYING: ['info', 'refresh', 'Verifying'],
    VERIFIED: ['info', 'shield-check', 'Verified'],
    NEEDS_REVIEW: ['warn', 'alert-triangle', 'Needs review'],
    MATCHED: ['good', 'check-circle', 'Matched'],
    SHORT_PAID: ['critical', 'alert-triangle', 'Short paid'],
    PENDING: ['neutral', 'clock', 'Pending'],
    DISPUTED: ['serious', 'alert-triangle', 'Disputed'],
    OK: ['good', 'check-circle', 'On track'],
    WATCH: ['warn', 'eye', 'Watch'],
    RISK: ['critical', 'alert-triangle', 'At risk'],
    WITHIN: ['good', 'check-circle', 'Within budget'],
    NEAR: ['warn', 'alert-triangle', 'Near limit'],
    OVER: ['critical', 'alert-triangle', 'Over budget'],
    OVERDUE: ['critical', 'clock', 'Overdue'],
    DUE_SOON: ['warn', 'clock', 'Due soon'],
    NOT_DUE: ['neutral', 'calendar', 'Not due'],
    PASS: ['good', 'check', 'Pass'],
    FAIL: ['critical', 'x', 'Fail'],
    SIMULATED: ['neutral', 'info', 'Simulated']
  };

  /** statusInfo('UNDER_REVIEW') -> {tone, icon, label}; unknown states get a neutral, humanised label. */
  ui.statusInfo = function (state) {
    var key = String(state === null || state === undefined ? '' : state).toUpperCase().replace(/[\s-]+/g, '_');
    var s = STATES[key];
    if (s) return { tone: s[0], icon: s[1], label: s[2] };
    var words = key.replace(/_/g, ' ').toLowerCase();
    return { tone: 'neutral', icon: 'info', label: words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown' };
  };

  /** statusChip(state, {label}) - one mapping for every bill / batch / vendor / payout / health state. */
  ui.statusChip = function (state, o) {
    var info = ui.statusInfo(state);
    return ui.chip((o && o.label) || info.label, info.tone, { icon: info.icon, title: o && o.title });
  };

  ui.avatar = function (initials, o) {
    o = o || {};
    return h('span', { 'class': ['mk-avatar', o.accent ? 'mk-avatar--accent' : '', o.size === 'sm' ? 'mk-avatar--sm' : ''], 'aria-hidden': 'true' }, initials);
  };

  /* --------------------------------------------------------------- table */

  var NUMERIC_FORMATS = { inr: 1, inrFull: 1, num: 1, num1: 1, pct: 1, kg: 1 };

  function isNumericCol(col) {
    if (col.numeric !== undefined) return !!col.numeric;
    if (col.align) return col.align === 'right';
    return !!NUMERIC_FORMATS[col.format];
  }

  function sortValueOf(col, row) {
    var v = typeof col.sortValue === 'function' ? col.sortValue(row) : row[col.key];
    if (v && typeof v === 'object' && 'value' in v) v = v.value;
    return v;
  }

  function compareValues(a, b) {
    var an = a === null || a === undefined || a === '' || (typeof a === 'number' && isNaN(a));
    var bn = b === null || b === undefined || b === '' || (typeof b === 'number' && isNaN(b));
    if (an || bn) return an && bn ? 0 : (an ? 1 : -1); /* blanks always last, handled by caller for desc */
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
  }

  function cssLength(v) { return typeof v === 'number' ? v + 'px' : String(v); }
  function tipText(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) : (isNode(v) ? (v.textContent || null) : null); }

  /** One-line cell content limited to maxWidth: ellipsis when it does not fit, full text as the tooltip. */
  function clipCell(content, maxWidth) {
    if (isNode(content) && content.classList && content.classList.contains('mk-cell-clip')) { content.style.maxWidth = cssLength(maxWidth); return content; }
    return h('div', { 'class': 'mk-cell-clip', title: tipText(content), style: { maxWidth: cssLength(maxWidth) } }, content);
  }

  /**
   * table({columns, rows, onRowClick, dense, footer, empty, sortable, sort, onSort, maxHeight, rowClass, caption})
   * Returns the scroll wrapper; wrapper.setRows(rows) swaps the data, wrapper.getSort() -> {key, dir} | null.
   * Body cells stay on one line (a wide table scrolls sideways). Long text is a per-column choice:
   * column.maxWidth (px) truncates with an ellipsis and a tooltip, column.wrap: true lets the cell wrap.
   */
  ui.table = function (o) {
    o = o || {};
    var cols = (o.columns || []).filter(Boolean);
    var rows = o.rows || [];
    var sort = o.sort && o.sort.key ? { key: o.sort.key, dir: o.sort.dir === 'asc' ? 'asc' : 'desc' } : null;
    var clickable = typeof o.onRowClick === 'function';
    var heads = {};

    var tbody = h('tbody');
    var headRow = h('tr');
    cols.forEach(function (col) {
      var numeric = isNumericCol(col);
      var canSort = col.sortable !== undefined ? !!col.sortable : !!o.sortable;
      var th = h('th', { scope: 'col', 'class': [numeric ? 'is-num' : '', col.align === 'center' ? 'is-center' : ''], title: col.title,
        style: col.width ? { width: typeof col.width === 'number' ? col.width + 'px' : col.width } : null });
      if (canSort && col.key) {
        var arrow = h('span', { 'class': 'mk-th-sort__arrow' });
        th.appendChild(h('button', { type: 'button', 'class': 'mk-th-sort', onClick: function () {
          if (sort && sort.key === col.key) sort = { key: col.key, dir: sort.dir === 'desc' ? 'asc' : 'desc' };
          else sort = { key: col.key, dir: numeric ? 'desc' : 'asc' };
          paint();
          if (typeof o.onSort === 'function') o.onSort({ key: sort.key, dir: sort.dir });
        } }, col.label, arrow));
        heads[col.key] = { th: th, arrow: arrow };
      } else {
        append(th, col.label);
      }
      headRow.appendChild(th);
    });

    function sortedRows() {
      if (!sort) return rows;
      var col = null;
      cols.forEach(function (c) { if (c.key === sort.key) col = c; });
      if (!col) return rows;
      var sign = sort.dir === 'asc' ? 1 : -1;
      return rows.map(function (r, i) { return { r: r, i: i, v: sortValueOf(col, r) }; }).sort(function (x, y) {
        var xb = x.v === null || x.v === undefined || x.v === '', yb = y.v === null || y.v === undefined || y.v === '';
        if (xb || yb) return xb && yb ? x.i - y.i : (xb ? 1 : -1);
        return sign * compareValues(x.v, y.v) || x.i - y.i;
      }).map(function (x) { return x.r; });
    }

    function paint() {
      Object.keys(heads).forEach(function (key) {
        var active = sort && sort.key === key;
        heads[key].th.setAttribute('aria-sort', active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        ui.clear(heads[key].arrow).appendChild(icon(active && sort.dir === 'asc' ? 'arrow-up' : 'arrow-down', 12));
      });
      ui.clear(tbody);
      if (!rows.length) {
        var emptyNode = isNode(o.empty) ? o.empty : ui.emptyState(o.empty || 'Nothing to show for this selection', null, { compact: true });
        tbody.appendChild(h('tr', { 'class': 'mk-table__empty' }, h('td', { colspan: cols.length || 1 }, emptyNode)));
        return;
      }
      var ctx = { rows: rows };
      sortedRows().forEach(function (row, index) {
        var tr = h('tr', { 'class': [clickable ? 'is-clickable' : '', typeof o.rowClass === 'function' ? o.rowClass(row) : ''], tabindex: clickable ? 0 : null });
        cols.forEach(function (col) {
          var value = col.key ? row[col.key] : undefined;
          var td = h('td', { 'class': [isNumericCol(col) ? 'is-num' : '', col.align === 'center' ? 'is-center' : '', col.wrap ? 'is-wrap' : '', col.className] });
          ctx.index = index;
          var content = typeof col.render === 'function' ? col.render(value, row, col, ctx) : formatValue(col.format, value, row);
          append(td, col.maxWidth ? clipCell(content, col.maxWidth) : content);
          if (col.render && typeof col.render.decorate === 'function') col.render.decorate(td, value, row, col, ctx);
          tr.appendChild(td);
        });
        if (clickable) {
          tr.addEventListener('click', function (e) {
            if (e.target.closest && e.target.closest('button, a, input, select, textarea, label')) return;
            o.onRowClick(row, e);
          });
          tr.addEventListener('keydown', function (e) {
            if (e.target !== tr || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            o.onRowClick(row, e);
          });
        }
        tbody.appendChild(tr);
      });
    }

    var tfoot = null;
    var footRows = o.footer ? (Array.isArray(o.footer) ? o.footer : [o.footer]) : [];
    if (footRows.length) {
      tfoot = h('tfoot', null, footRows.map(function (f) {
        return h('tr', null, cols.map(function (col) {
          var v = col.key ? f[col.key] : undefined;
          var content = v === undefined ? '' : (isNode(v) || typeof v === 'string' ? v : formatValue(col.format, v, f));
          return h('td', { 'class': [isNumericCol(col) ? 'is-num' : '', col.align === 'center' ? 'is-center' : ''] }, content);
        }));
      }));
    }

    var wrap = h('div', { 'class': ['mk-table-wrap', o.maxHeight ? 'mk-table-wrap--scroll' : '', o.className],
      style: o.maxHeight ? { maxHeight: typeof o.maxHeight === 'number' ? o.maxHeight + 'px' : o.maxHeight } : null },
      h('table', { 'class': ['mk-table', o.dense ? 'mk-table--dense' : ''] },
        o.caption ? h('caption', null, o.caption) : null, h('thead', null, headRow), tbody, tfoot));
    wrap.setRows = function (next) { rows = next || []; paint(); };
    wrap.getSort = function () { return sort ? { key: sort.key, dir: sort.dir } : null; };
    paint();
    return wrap;
  };

  /* Cell renderers: use as column.render. Signature of a renderer: (value, row, col, ctx{rows, index}) -> node | string. */

  var rangeCache = typeof root.WeakMap === 'function' ? new root.WeakMap() : null;

  function columnRange(ctx, key) {
    var rows = (ctx && ctx.rows) || [];
    var perRows = rangeCache && rangeCache.get(rows);
    if (perRows && perRows[key]) return perRows[key];
    var min = Infinity, max = -Infinity;
    rows.forEach(function (r) {
      var v = r[key];
      if (typeof v !== 'number' || isNaN(v)) return;
      if (v < min) min = v;
      if (v > max) max = v;
    });
    var out = { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
    if (rangeCache) { perRows = perRows || {}; perRows[key] = out; rangeCache.set(rows, perRows); }
    return out;
  }

  var SEQ_STEPS = ['--seq-100', '--seq-150', '--seq-200', '--seq-250', '--seq-300', '--seq-350', '--seq-400', '--seq-450', '--seq-500', '--seq-550', '--seq-600', '--seq-650', '--seq-700'];
  var SEQ_DARK_FROM = 8; /* from --seq-500 the ink switches to the surface colour */
  var DIV_STEPS = ['--div-neg-2', '--div-neg-1', '--div-mid', '--div-pos-1', '--div-pos-2'];

  ui.cells = {
    /** Inline horizontal bar next to the formatted value. max null -> largest value in the column. One colour for all bars. */
    bar: function (max, colourVar, o) {
      o = o || {};
      return function (value, row, col, ctx) {
        var top = (max === null || max === undefined) ? Math.max(Math.abs(columnRange(ctx, col.key).max), Math.abs(columnRange(ctx, col.key).min)) : max;
        var share = (typeof value === 'number' && top > 0) ? Math.max(0, Math.min(1, Math.abs(value) / top)) : 0;
        return h('div', { 'class': 'mk-cellbar' },
          h('span', { 'class': 'mk-cellbar__track', 'aria-hidden': 'true' },
            h('span', { 'class': 'mk-cellbar__fill', style: { width: (share * 100).toFixed(1) + '%', background: 'var(' + (colourVar || '--series-1') + ')' } })),
          h('span', { 'class': 'mk-cellbar__value' }, formatValue(o.format || col.format, value, row)));
      };
    },

    /**
     * Shade the whole cell. Sequential blue ramp by default; {scale: 'div', mid} for polarity (above mid blue, below red;
     * {invert: true} swaps that for measures where higher is worse). min / max null -> taken from the column.
     */
    heat: function (min, max, o) {
      o = o || {};
      function render(value, row, col) { return formatValue(o.format || col.format, value, row); }
      render.decorate = function (td, value, row, col, ctx) {
        if (typeof value !== 'number' || isNaN(value)) return;
        var r = columnRange(ctx, col.key);
        var lo = (min === null || min === undefined) ? r.min : min;
        var hi = (max === null || max === undefined) ? r.max : max;
        var token, dark;
        if (o.scale === 'div') {
          var mid = o.mid === undefined ? 0 : o.mid;
          var span = Math.max(Math.abs(hi - mid), Math.abs(mid - lo)) || 1;
          var t = Math.max(-1, Math.min(1, (value - mid) / span)) * (o.invert ? -1 : 1);
          var idx = Math.abs(t) < 0.1 ? 2 : (t > 0 ? (t > 0.55 ? 4 : 3) : (t < -0.55 ? 0 : 1));
          token = DIV_STEPS[idx];
          dark = idx === 0 || idx === 4;
        } else {
          var u = hi > lo ? Math.max(0, Math.min(1, (value - lo) / (hi - lo))) : 0;
          var step = Math.min(SEQ_STEPS.length - 1, Math.floor(u * SEQ_STEPS.length));
          token = SEQ_STEPS[step];
          dark = step >= SEQ_DARK_FROM;
        }
        td.classList.add('mk-heat');
        if (dark) td.classList.add('is-dark');
        td.style.background = 'var(' + token + ')';
      };
      return render;
    },

    /** value is a delta object from MK.fmt.delta / MK.fmt.points, or a fraction (0.042 -> +4.2%). */
    delta: function (goodWhen) {
      return function (value) {
        var d = value;
        if (typeof value === 'number') d = { value: value, label: (value > 0 ? '+' : '') + (value * 100).toFixed(1) + '%', dir: Math.abs(value) < 0.0005 ? 'flat' : (value > 0 ? 'up' : 'down') };
        return ui.deltaBadge(d, goodWhen) || h('span', { 'class': 'mk-faint' }, '-');
      };
    },

    status: function () { return function (value) { return value ? ui.statusChip(value) : h('span', { 'class': 'mk-faint' }, '-'); }; },

    /** value is an array of numbers; drawn when MK.charts.sparkline exists. */
    spark: function (colourVar) {
      return function (value) {
        var el = h('span', { 'class': 'mk-cellspark', 'aria-hidden': 'true' });
        if (Array.isArray(value) && value.length > 1 && MK.charts && typeof MK.charts.sparkline === 'function') {
          try { MK.charts.sparkline(el, value, { colourVar: colourVar || '--series-1', emphasiseLast: true, width: 88, height: 24 }); } catch (e) { /* decorative */ }
        }
        return el;
      };
    },

    /**
     * Main text with a muted second line taken from row[subKey] (or subKey(row)). Both lines are truncated with an
     * ellipsis at {maxWidth} px (default 280; the full text is the tooltip) so a long vendor name never grows the row.
     * {maxWidth: null} switches the limit off - pair it with column.wrap when the text should wrap instead.
     */
    twoLine: function (subKey, o) {
      var maxWidth = o && o.maxWidth !== undefined ? o.maxWidth : 280;
      return function (value, row) {
        var sub = typeof subKey === 'function' ? subKey(row) : row[subKey];
        return h('div', { 'class': maxWidth ? 'mk-cell-clip' : null, style: maxWidth ? { maxWidth: cssLength(maxWidth) } : null },
          h('div', { 'class': 'mk-strong', title: maxWidth ? tipText(value) : null }, value),
          sub ? h('div', { 'class': 'mk-xs mk-muted', title: maxWidth ? tipText(sub) : null }, sub) : null);
      };
    },

    /** Coloured entity dot + label, e.g. cells.entity(function (row) { return '--ch-' + row.id; }). */
    entity: function (colourVarOf) {
      return function (value, row) {
        var v = typeof colourVarOf === 'function' ? colourVarOf(row) : colourVarOf;
        return h('span', { 'class': 'mk-nowrap' }, v ? h('span', { 'class': 'mk-legend-dot', style: { background: 'var(' + v + ')' } }) : null, value);
      };
    }
  };

  /* ------------------------------------------------- tabs and segmented */

  /** tabs({items: [{id, label, count}], value, onChange(id)}) - the caller re-renders the panel in onChange. */
  ui.tabs = function (o) {
    o = o || {};
    var items = o.items || [];
    var current = o.value !== undefined && o.value !== null ? o.value : (items[0] && items[0].id);
    var buttons = [];
    function select(id, focus) {
      current = id;
      buttons.forEach(function (b) {
        var on = b.dataset.id === String(id);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
    }
    var el = h('div', { 'class': 'mk-tabs', role: 'tablist', 'aria-label': o.ariaLabel }, items.map(function (item, i) {
      var b = h('button', { type: 'button', role: 'tab', 'class': 'mk-tab', dataset: { id: item.id },
        onClick: function () { if (current === item.id) return; select(item.id); if (typeof o.onChange === 'function') o.onChange(item.id); },
        onKeydown: function (e) {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          var next = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
          select(next.id, true);
          if (typeof o.onChange === 'function') o.onChange(next.id);
        } },
        item.label,
        item.count !== undefined && item.count !== null ? h('span', { 'class': 'mk-tab__count' }, MK.fmt.num(item.count)) : null);
      buttons.push(b);
      return b;
    }));
    select(current);
    return el;
  };

  /** segmented({options: [{value, label}], value, onChange(value), size: 'sm', ariaLabel}) - measure / grouping switches. */
  ui.segmented = function (o) {
    o = o || {};
    var current = o.value;
    var buttons = [];
    var el = h('div', { 'class': ['mk-seg', o.size === 'sm' ? 'mk-seg--sm' : ''], role: 'group', 'aria-label': o.ariaLabel }, (o.options || []).map(function (opt) {
      var b = h('button', { type: 'button', 'class': 'mk-seg__btn', 'aria-pressed': opt.value === current ? 'true' : 'false', onClick: function () {
        if (current === opt.value) return;
        current = opt.value;
        buttons.forEach(function (x) { x.btn.setAttribute('aria-pressed', x.value === current ? 'true' : 'false'); });
        if (typeof o.onChange === 'function') o.onChange(current);
      } }, opt.label);
      buttons.push({ btn: b, value: opt.value });
      return b;
    }));
    return el;
  };

  /**
   * stepper({label, value, min, max, step, unit, format(v), onChange(v), ariaLabel, title, size: 'sm'})
   * A labelled figure with minus and plus buttons: the fine-tuning control for one model input (a safety margin, a
   * number of days). The value snaps to `step` and stays inside [min, max]; the buttons disable at the ends.
   * Returns the wrapper; wrapper.getValue(), wrapper.setValue(v) (silent).
   */
  ui.stepper = function (o) {
    o = o || {};
    function fin(v) { return typeof v === 'number' && isFinite(v); }
    var step = fin(o.step) && o.step > 0 ? o.step : 1, min = fin(o.min) ? o.min : -Infinity, max = fin(o.max) ? o.max : Infinity;
    var dp = step % 1 === 0 ? 0 : 1;
    function clamp(v) { v = Math.round(v / step) * step; v = Math.max(min, Math.min(max, v)); return Math.round(v * 1000) / 1000; }
    function text(v) { return typeof o.format === 'function' ? o.format(v) : MK.fmt.num(v, dp) + (o.unit ? ' ' + o.unit : ''); }
    var value = clamp(fin(o.value) ? o.value : (fin(o.min) ? o.min : 0));
    var valueEl = h('span', { 'class': 'mk-stepper__value', 'aria-live': 'polite' }, text(value));
    var name = o.ariaLabel || o.label || 'Value';
    var minus = ui.button({ icon: 'minus', size: 'sm', variant: 'ghost', ariaLabel: name + ': less', onClick: function () { set(value - step, true); } });
    var plus = ui.button({ icon: 'plus', size: 'sm', variant: 'ghost', ariaLabel: name + ': more', onClick: function () { set(value + step, true); } });
    function paint() { valueEl.textContent = text(value); minus.disabled = value <= min; plus.disabled = value >= max; }
    function set(v, fire) {
      var next = clamp(v);
      if (next === value) return;
      value = next; paint();
      if (fire && typeof o.onChange === 'function') o.onChange(value);
    }
    var el = h('div', { 'class': ['mk-stepper', o.size === 'sm' ? 'mk-stepper--sm' : ''], role: 'group', 'aria-label': o.ariaLabel || o.label || null, title: o.title || null },
      o.label ? h('span', { 'class': 'mk-stepper__label' }, o.label) : null,
      h('span', { 'class': 'mk-stepper__ctl' }, minus, valueEl, plus));
    paint();
    el.getValue = function () { return value; };
    el.setValue = function (v) { set(v, false); };
    return el;
  };

  /* --------------------------------------------------------------- forms */

  function optionNodes(options, value, placeholder) {
    var out = [];
    if (placeholder) out.push(h('option', { value: '', disabled: true, selected: value === undefined || value === null || value === '' }, placeholder));
    (options || []).forEach(function (opt) {
      var o = typeof opt === 'object' ? opt : { value: opt, label: String(opt) };
      out.push(h('option', { value: o.value, selected: String(o.value) === String(value), disabled: o.disabled ? true : null }, o.label));
    });
    return out;
  }

  /**
   * select({options: [{value, label}], value, onChange(value), placeholder, size: 'sm', block, ariaLabel, disabled, name})
   * Returns the wrapper; wrapper.input is the native <select>, wrapper.getValue() / setValue(v).
   */
  ui.select = function (o) {
    o = o || {};
    var sel = h('select', { 'class': 'mk-select', name: o.name, 'aria-label': o.ariaLabel, disabled: o.disabled ? true : null,
      onChange: function () { if (typeof o.onChange === 'function') o.onChange(sel.value); } }, optionNodes(o.options, o.value, o.placeholder));
    var wrap = h('span', { 'class': ['mk-selectwrap', o.block ? 'mk-selectwrap--block' : '', o.size === 'sm' ? 'mk-selectwrap--sm' : ''] }, sel, icon('chevron-down', 14));
    wrap.input = sel;
    wrap.getValue = function () { return sel.value; };
    wrap.setValue = function (v) { sel.value = v; };
    return wrap;
  };

  function textLike(tag, o, extraClass) {
    o = o || {};
    var el = h(tag, {
      'class': [tag === 'textarea' ? 'mk-textarea' : 'mk-input', extraClass, o.mono ? 'mk-input--mono' : ''],
      type: tag === 'input' ? (o.type || 'text') : null, name: o.name, placeholder: o.placeholder, maxlength: o.maxLength,
      rows: tag === 'textarea' ? (o.rows || 3) : null, min: o.min, max: o.max, step: o.step, inputmode: o.inputMode,
      autocomplete: 'off', spellcheck: o.spellcheck ? 'true' : 'false', 'aria-label': o.ariaLabel,
      disabled: o.disabled ? true : null, readOnly: o.readOnly ? true : null
    });
    if (o.value !== undefined && o.value !== null) el.value = String(o.value);
    if (typeof o.onInput === 'function') el.addEventListener('input', function () { o.onInput(el.value, el); });
    if (typeof o.onChange === 'function') el.addEventListener('change', function () { o.onChange(el.value, el); });
    if (typeof o.onEnter === 'function') el.addEventListener('keydown', function (e) { if (e.key === 'Enter' && tag === 'input') o.onEnter(el.value, el); });
    return el;
  }

  ui.form = {
    /**
     * field({label, control, hint, required, optional, error}) -> wrapper with setError(msg), setOk(msg), control.
     * The label is bound to the first input / select / textarea inside control.
     */
    field: function (o) {
      o = o || {};
      var control = o.control;
      var target = control && (control.matches && control.matches('input, select, textarea') ? control : control.querySelector && control.querySelector('input, select, textarea'));
      var id = target ? (target.id || (target.id = nextId('mk-f'))) : null;
      var msgId = nextId('mk-fm');
      var msg = h('div', { id: msgId, 'aria-live': 'polite' });
      var el = h('div', { 'class': 'mk-field' },
        h('label', { 'class': 'mk-field__label', 'for': id }, o.label,
          o.required ? h('span', { 'class': 'mk-field__req', title: 'Required' }, '*') : null,
          o.optional ? h('span', { 'class': 'mk-field__opt' }, 'optional') : null),
        control,
        o.hint ? h('div', { 'class': 'mk-field__hint' }, o.hint) : null,
        msg);
      if (target) target.setAttribute('aria-describedby', msgId);
      function setMessage(kind, text) {
        ui.clear(msg);
        msg.className = text ? 'mk-field__' + kind : '';
        if (text) append(msg, [icon(kind === 'error' ? 'alert-triangle' : 'check', 14), text]);
        if (target) { if (kind === 'error' && text) target.setAttribute('aria-invalid', 'true'); else target.removeAttribute('aria-invalid'); }
      }
      el.control = control;
      el.input = target;
      el.setError = function (text) { setMessage('error', text || ''); };
      el.setOk = function (text) { setMessage('ok', text || ''); };
      if (o.error) el.setError(o.error);
      return el;
    },

    /** input({value, placeholder, type, name, mono, maxLength, onInput(value), onChange(value), onEnter(value), disabled, readOnly}) */
    input: function (o) { return textLike('input', o); },
    textarea: function (o) { return textLike('textarea', o); },

    /** dateInput({value: 'YYYY-MM-DD', min, max, onChange(iso)}) - native date picker. */
    dateInput: function (o) {
      o = o || {};
      return textLike('input', { type: 'date', value: o.value, min: o.min, max: o.max, name: o.name, onChange: o.onChange, ariaLabel: o.ariaLabel, disabled: o.disabled });
    },

    /**
     * moneyInput({value, placeholder, onChange(number|null), name, disabled}) -> wrapper; wrapper.getValue() is a whole-rupee
     * number or null, wrapper.setValue(n). Shows Indian digit grouping when not focused.
     */
    moneyInput: function (o) {
      o = o || {};
      var value = typeof o.value === 'number' && !isNaN(o.value) ? Math.round(o.value) : null;
      var input = textLike('input', { name: o.name, placeholder: o.placeholder || '0', inputMode: 'numeric', disabled: o.disabled, ariaLabel: o.ariaLabel }, 'mk-input--num');
      function parse(text) {
        var clean = String(text).replace(/[^\d.]/g, '');
        if (!clean) return null;
        var n = Math.round(parseFloat(clean));
        return isNaN(n) ? null : n;
      }
      function show(focused) { input.value = value === null ? '' : (focused ? String(value) : MK.fmt.num(value)); }
      input.addEventListener('focus', function () { show(true); input.select(); });
      input.addEventListener('input', function () { value = parse(input.value); if (typeof o.onChange === 'function') o.onChange(value); });
      input.addEventListener('blur', function () { value = parse(input.value); show(false); });
      show(false);
      var wrap = h('span', { 'class': 'mk-affix' }, h('span', { 'class': 'mk-affix__pre', 'aria-hidden': 'true' }, MK.fmt.rupee), input);
      wrap.input = input;
      wrap.getValue = function () { return value; };
      wrap.setValue = function (n) { value = typeof n === 'number' && !isNaN(n) ? Math.round(n) : null; show(doc.activeElement === input); };
      return wrap;
    },

    select: function (o) { return ui.select(Object.assign({ block: true }, o || {})); },

    /** checkbox({label, checked, onChange(bool)}) -> label element; .input is the checkbox. */
    checkbox: function (o) {
      o = o || {};
      var box = h('input', { type: 'checkbox', checked: !!o.checked, name: o.name, disabled: o.disabled ? true : null,
        onChange: function () { if (typeof o.onChange === 'function') o.onChange(box.checked); } });
      var el = h('label', { 'class': 'mk-check' }, box, h('span', null, o.label));
      el.input = box;
      return el;
    },

    /** search({value, placeholder, onInput(value), width}) - text box with a search icon. */
    search: function (o) {
      o = o || {};
      var input = textLike('input', { type: 'search', value: o.value, placeholder: o.placeholder || 'Search', onInput: o.onInput, ariaLabel: o.ariaLabel || o.placeholder || 'Search' });
      var wrap = h('span', { 'class': 'mk-search', style: o.width ? { width: o.width + 'px' } : null }, icon('search', 14), input);
      wrap.input = input;
      return wrap;
    },

    /** row(fields, 2 | 3) - fields side by side. */
    row: function (fields, cols) { return h('div', { 'class': ['mk-form__row', cols === 3 ? 'mk-form__row--3' : ''] }, fields); },
    /** group(children) - vertical form container. */
    group: function (children) { return h('div', { 'class': 'mk-form' }, children); }
  };
  ['field', 'input', 'textarea', 'moneyInput', 'dateInput', 'checkbox', 'search'].forEach(function (k) { ui[k] = ui.form[k]; });

  /* ------------------------------------------------------------ overlays */
  /* One stack for popovers, drawers and modals: Esc closes the top one, Tab is trapped inside dialogs. */

  var stack = [];
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function overlayRoot() { return doc.getElementById('mk-overlays') || doc.body; }

  function focusables(container) {
    return Array.prototype.slice.call(container.querySelectorAll(FOCUSABLE)).filter(function (el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el === doc.activeElement;
    });
  }

  function pushOverlay(entry) { stack.push(entry); }
  function popOverlay(entry) { stack = stack.filter(function (e) { return e !== entry; }); }

  doc.addEventListener('keydown', function (e) {
    var top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); top.close(); return; }
    if (e.key !== 'Tab' || !top.trap) return;
    var items = focusables(top.el);
    if (!items.length) { e.preventDefault(); top.el.focus(); return; }
    var firstEl = items[0], lastEl = items[items.length - 1];
    if (!top.el.contains(doc.activeElement)) { e.preventDefault(); firstEl.focus(); }
    else if (e.shiftKey && doc.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && doc.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  }, true);

  /** Close every open popover, drawer and modal, including modals opened with dismissible: false (the router calls this on navigation). */
  ui.closeAll = function () { stack.slice().reverse().forEach(function (e) { (e.forceClose || e.close)(); }); };

  /** Close popovers whose anchor left the document (the router calls this after a page re-render). */
  ui.closeOrphans = function () {
    stack.slice().forEach(function (e) { if (e.anchor && !doc.contains(e.anchor)) e.close(); });
  };

  /**
   * popover(anchor, content, {align: 'left' | 'right', width, onClose}) -> {el, close, reposition}
   * Calling it again for an anchor whose popover is open closes that popover (toggle) and returns null.
   */
  ui.popover = function (anchor, content, o) {
    o = o || {};
    if (anchor._mkPopover) { anchor._mkPopover.close(); return null; }
    var el = h('div', { 'class': ['mk-pop', o.className], role: o.role || 'dialog', tabindex: -1, style: o.width ? { width: o.width + 'px' } : null }, content);
    var closed = false;
    var anchorBox = null;

    function reposition() {
      var r = anchorBox = anchor.getBoundingClientRect();
      var w = el.offsetWidth, ht = el.offsetHeight;
      var vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
      var left = o.align === 'right' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      var top = r.bottom + 4;
      if (top + ht > vh - 8 && r.top - ht - 4 > 8) top = r.top - ht - 4;
      el.style.left = Math.round(left) + 'px';
      el.style.top = Math.round(Math.max(8, top)) + 'px';
    }
    function onDown(e) { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); }
    /* A scroll closes the popover only when it moved the anchor: the page may re-render (and re-scroll) underneath
       an open filter popover, and that must not dismiss it. */
    function onScroll(e) {
      if (e.target !== doc && el.contains(e.target)) return;
      var r = anchor.getBoundingClientRect();
      if (Math.abs(r.top - anchorBox.top) > 1 || Math.abs(r.left - anchorBox.left) > 1) close();
    }
    function close() {
      if (closed) return;
      closed = true;
      doc.removeEventListener('mousedown', onDown, true);
      doc.removeEventListener('scroll', onScroll, true);
      root.removeEventListener('resize', close);
      popOverlay(entry);
      if (el.parentNode) el.parentNode.removeChild(el);
      anchor.setAttribute('aria-expanded', 'false');
      anchor._mkPopover = null;
      if (el.contains(doc.activeElement) || doc.activeElement === doc.body) { try { anchor.focus(); } catch (err) { /* anchor gone */ } }
      if (typeof o.onClose === 'function') o.onClose();
    }
    var entry = { el: el, close: close, trap: false, anchor: anchor };

    overlayRoot().appendChild(el);
    reposition();
    anchor.setAttribute('aria-haspopup', 'true');
    anchor.setAttribute('aria-expanded', 'true');
    anchor._mkPopover = entry;
    pushOverlay(entry);
    doc.addEventListener('mousedown', onDown, true);
    doc.addEventListener('scroll', onScroll, true);
    root.addEventListener('resize', close);
    var target = el.querySelector('[data-autofocus]') || focusables(el)[0] || el;
    target.focus();
    return { el: el, close: close, reposition: reposition };
  };

  /**
   * menu(anchor, items, {align, width}) - items: {label, sub, icon, hint, selected, danger, disabled, onSelect}
   * | {heading: 'text'} | {separator: true}. selected: true shows a bold row with a tick. Returns the popover controller.
   */
  ui.menu = function (anchor, items, o) {
    o = o || {};
    var pop = null;
    var hasTicks = (items || []).some(function (it) { return it && it.selected !== undefined; });
    var list = h('div', { role: 'menu', onKeydown: function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      var btns = focusables(list), i = btns.indexOf(doc.activeElement);
      if (!btns.length) return;
      btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length].focus();
    } }, (items || []).filter(Boolean).map(function (it) {
      if (it.separator) return h('div', { 'class': 'mk-menu__sep', role: 'separator' });
      if (it.heading) return h('div', { 'class': 'mk-menu__heading' }, it.heading);
      return h('button', { type: 'button', role: 'menuitem', disabled: it.disabled ? true : null, title: it.title,
        'class': ['mk-menu__item', it.selected ? 'is-selected' : '', it.danger ? 'mk-menu__item--danger' : ''],
        'data-autofocus': it.selected ? '' : null,
        onClick: function () { if (pop) pop.close(); if (typeof it.onSelect === 'function') it.onSelect(it); } },
        it.avatar ? ui.avatar(it.avatar, { size: 'sm' }) : null,
        it.icon ? icon(it.icon) : null,
        h('span', { 'class': 'mk-menu__main' }, it.label, it.sub ? h('span', { 'class': 'mk-menu__sub' }, it.sub) : null),
        it.hint ? h('span', { 'class': 'mk-menu__hint' }, it.hint) : null,
        hasTicks ? h('span', { 'class': 'mk-menu__tick' }, it.selected ? icon('check') : null) : null);
    }));
    pop = ui.popover(anchor, list, { align: o.align, width: o.width, role: 'presentation' });
    return pop;
  };

  function dialogShell(kind, o) {
    var previous = doc.activeElement;
    var titleId = nextId('mk-dlg');
    var closed = false;
    var body = h('div', { 'class': 'mk-' + kind + '__body' }, o.body);
    var foot = h('footer', { 'class': 'mk-' + kind + '__foot' }, o.footer);
    if (!o.footer) foot.hidden = true;
    var titleEl = h('h2', { 'class': 'mk-' + kind + '__title', id: titleId }, o.title);
    var subEl = h('p', { 'class': 'mk-' + kind + '__subtitle' }, o.subtitle);
    if (!o.subtitle) subEl.hidden = true;
    var panel = h(kind === 'drawer' ? 'aside' : 'div', {
      'class': ['mk-' + kind, o.size ? 'mk-modal--' + o.size : ''], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: -1,
      style: kind === 'drawer' && o.width ? { width: Math.max(480, Math.min(560, o.width)) + 'px' } : null
    },
      h('header', { 'class': 'mk-' + kind + '__head' },
        h('div', { 'class': 'mk-' + kind + '__titles' }, titleEl, subEl),
        o.headerExtra || null,
        ui.iconButton('x', 'Close', function () { close(); })),
      body, foot);
    var backdrop = h('div', { 'class': 'mk-backdrop', onMousedown: function (e) { if (e.target === backdrop && o.dismissible !== false) close(); } });
    var layer = kind === 'modal' ? h('div', { 'class': 'mk-modal-layer' }, panel) : panel;

    function close(result) {
      if (closed) return;
      closed = true;
      popOverlay(entry);
      [backdrop, layer].forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      if (previous && doc.contains(previous) && typeof previous.focus === 'function') previous.focus();
      if (typeof o.onClose === 'function') o.onClose(result);
    }
    /* close = the user's way out (Esc), which dismissible: false refuses; forceClose = closeAll() on navigation, which nothing refuses */
    var entry = { el: panel, close: function () { if (o.dismissible !== false) close(); }, forceClose: close, trap: true };

    /* Appended in opening order, backdrop first: with one shared z-index (css/components.css) document order puts
       each new backdrop above every dialog that is already open, so a confirm opened from a drawer blocks the drawer. */
    overlayRoot().appendChild(backdrop);
    overlayRoot().appendChild(layer);
    pushOverlay(entry);
    var target = panel.querySelector('[data-autofocus]') || focusables(body)[0] || panel;
    target.focus();
    /* a drawer opens on a record: the preview shows it arriving (MK.latency), the panel holding the focus meanwhile; {loader: false} opts out (a form) */
    if (kind === 'drawer' && o.loader !== false && MK.latency && typeof MK.latency.part === 'function' &&
      MK.latency.part(body, 'record', o.loaderLabel || 'Fetching the record', 'navigate')) panel.focus();

    return {
      el: panel, body: body, foot: foot, close: close,
      setTitle: function (title, subtitle) {
        ui.clear(titleEl); append(titleEl, title);
        ui.clear(subEl); append(subEl, subtitle); subEl.hidden = !subtitle;
      },
      setBody: function (content) { ui.clear(body); append(body, content); },
      setFooter: function (content) { ui.clear(foot); append(foot, content); foot.hidden = !content; }
    };
  }

  /** drawer({title, subtitle, headerExtra, body, footer, width (480-560), onClose}) -> {el, body, foot, close, setTitle, setBody, setFooter} */
  ui.drawer = function (o) { return dialogShell('drawer', o || {}); };

  /** modal({title, subtitle, body, footer, size: 'sm' | 'lg', dismissible, onClose}) -> same controller as drawer */
  ui.modal = function (o) { return dialogShell('modal', o || {}); };

  /**
   * confirm({title, message, body, confirmLabel, cancelLabel, tone: 'primary' | 'danger', requireReason, reasonLabel,
   * reasonPlaceholder, onConfirm(reason), onCancel()}) -> Promise<{ok, reason}> (never rejects).
   */
  ui.confirm = function (o) {
    o = o || {};
    return new Promise(function (resolve) {
      var settled = false, dlg = null, reasonField = null, reasonInput = null;
      function settle(ok) {
        if (settled) return;
        var reason = reasonInput ? reasonInput.value.trim() : '';
        if (ok && o.requireReason && !reason) { reasonField.setError('A reason is required'); reasonInput.focus(); return; }
        settled = true;
        dlg.close();
        if (ok && typeof o.onConfirm === 'function') o.onConfirm(reason);
        if (!ok && typeof o.onCancel === 'function') o.onCancel();
        resolve({ ok: ok, reason: reason });
      }
      if (o.requireReason || o.reasonLabel) {
        reasonInput = ui.form.textarea({ placeholder: o.reasonPlaceholder || 'Write a short reason', rows: 3 });
        reasonInput.setAttribute('data-autofocus', '');
        reasonField = ui.form.field({ label: o.reasonLabel || 'Reason', control: reasonInput, required: !!o.requireReason });
      }
      var confirmBtn = ui.button({ label: o.confirmLabel || 'Confirm', variant: o.tone === 'danger' ? 'danger' : 'primary', onClick: function () { settle(true); } });
      if (!reasonInput) confirmBtn.setAttribute('data-autofocus', '');
      dlg = ui.modal({
        title: o.title || 'Are you sure?', size: 'sm',
        body: [o.message ? h('p', { 'class': 'mk-modal__message' }, o.message) : null, o.body || null, reasonField],
        footer: [ui.button({ label: o.cancelLabel || 'Cancel', variant: 'ghost', onClick: function () { settle(false); } }), confirmBtn],
        onClose: function () { if (!settled) { settled = true; if (typeof o.onCancel === 'function') o.onCancel(); resolve({ ok: false, reason: '' }); } }
      });
    });
  };

  /** toast('Bill approved', {tone: 'good' | 'warn' | 'critical' | 'info', title, duration}) -> {close}. Bottom right, auto-dismiss. */
  ui.toast = function (message, o) {
    o = o || {};
    var host = doc.getElementById('mk-toasts');
    if (!host) { host = h('div', { id: 'mk-toasts', 'class': 'mk-toasts', role: 'status', 'aria-live': 'polite' }); overlayRoot().appendChild(host); }
    var tone = o.tone || 'info';
    var iconName = tone === 'good' ? 'check-circle' : (tone === 'warn' || tone === 'critical' ? 'alert-triangle' : 'info');
    var timer = null, gone = false;
    function close() {
      if (gone) return;
      gone = true;
      root.clearTimeout(timer);
      el.classList.add('is-leaving');
      root.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 180);
    }
    var el = h('div', { 'class': 'mk-toast mk-toast--' + tone },
      icon(iconName),
      h('div', { 'class': 'mk-toast__main' },
        o.title ? h('div', { 'class': 'mk-toast__title' }, o.title) : null,
        h('div', { 'class': o.title ? 'mk-toast__msg' : 'mk-toast__title' }, message)),
      h('button', { type: 'button', 'class': 'mk-toast__close', 'aria-label': 'Dismiss', onClick: close }, icon('x', 14)));
    host.appendChild(el);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    timer = root.setTimeout(close, o.duration || 4200);
    el.addEventListener('mouseenter', function () { root.clearTimeout(timer); });
    el.addEventListener('mouseleave', function () { if (!gone) timer = root.setTimeout(close, 1800); });
    return { close: close };
  };

  /* ------------------------------------------------------------ timeline */

  var ACTION_TONES = { APPROVED: 'good', PAID: 'good', VERIFIED: 'good', MATCHED: 'good', RELEASED: 'info', REJECTED: 'critical', SHORT_PAID: 'critical', NEEDS_REVIEW: 'warn', PENDING_RELEASE: 'warn' };

  /**
   * timeline(events, {empty}) - audit events, newest first as given.
   * event: {actor, role, action, from, to, note, at, tone, icon}. from / to are workflow states (rendered as status chips).
   */
  ui.timeline = function (events, o) {
    o = o || {};
    if (!events || !events.length) return ui.emptyState(o.empty || 'No activity recorded yet', null, { compact: true, icon: 'clock' });
    return h('ol', { 'class': 'mk-timeline' }, events.map(function (ev) {
      var tone = ev.tone || ACTION_TONES[String(ev.to || '').toUpperCase()] || 'neutral';
      var glyph = ev.icon || (tone === 'good' ? 'check' : (tone === 'critical' ? 'x' : (tone === 'warn' ? 'alert-triangle' : (ev.to ? 'arrow-right' : 'edit'))));
      var who = [ev.actor, ev.role].filter(Boolean).join(' - ');
      return h('li', { 'class': 'mk-tl mk-tl--' + tone },
        h('span', { 'class': 'mk-tl__dot' }, icon(glyph, 14)),
        h('div', null,
          h('div', { 'class': 'mk-tl__head' },
            h('span', { 'class': 'mk-tl__action' }, ev.action || 'Updated'),
            h('span', { 'class': 'mk-tl__time' }, ui.dateTime(ev.at))),
          who ? h('div', { 'class': 'mk-tl__who' }, who) : null,
          (ev.from || ev.to) ? h('div', { 'class': 'mk-tl__states' },
            ev.from ? ui.statusChip(ev.from) : null,
            ev.from && ev.to ? icon('arrow-right', 14) : null,
            ev.to ? ui.statusChip(ev.to) : null) : null,
          ev.note ? h('div', { 'class': 'mk-tl__note' }, ev.note) : null));
    }));
  };

  /* --------------------------------------------------------------- meter */

  /**
   * meter({value, max, label, valueLabel, tone, goodWhen, warnAt, criticalAt, target, size})
   * tone: 'neutral' | 'good' | 'warn' | 'serious' | 'critical' | 'auto' (default). With 'auto' the tone comes from
   * value / max: goodWhen 'down' (default, e.g. budget used) -> warn from warnAt (0.85), critical from criticalAt (1.0);
   * goodWhen 'up' (e.g. fill rate) -> critical below criticalAt (0.85), warn below warnAt (0.95). target: 0..1 marker.
   */
  ui.meter = function (o) {
    o = o || {};
    var max = o.max || 1;
    var ratio = typeof o.value === 'number' && !isNaN(o.value) ? o.value / max : 0;
    var tone = o.tone || 'auto';
    if (tone === 'auto') {
      if (o.goodWhen === 'up') {
        var c1 = o.criticalAt === undefined ? 0.85 : o.criticalAt, w1 = o.warnAt === undefined ? 0.95 : o.warnAt;
        tone = ratio < c1 ? 'critical' : (ratio < w1 ? 'warn' : 'good');
      } else {
        var w2 = o.warnAt === undefined ? 0.85 : o.warnAt, c2 = o.criticalAt === undefined ? 1 : o.criticalAt;
        tone = ratio > c2 ? 'critical' : (ratio >= w2 ? 'warn' : 'good');
      }
    }
    var glyph = tone === 'critical' || tone === 'serious' ? 'alert-triangle' : (tone === 'warn' ? 'alert-triangle' : null);
    var text = o.valueLabel !== undefined ? o.valueLabel : MK.fmt.pct(ratio, 0);
    return h('div', { 'class': ['mk-meter', tone !== 'neutral' ? 'mk-meter--' + tone : '', o.size === 'sm' ? 'mk-meter--sm' : ''],
      role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': typeof o.value === 'number' ? o.value : 0, 'aria-label': typeof o.label === 'string' ? o.label : null },
      (o.label || text) ? h('div', { 'class': 'mk-meter__top' },
        h('span', { 'class': 'mk-meter__label' }, o.label),
        h('span', { 'class': 'mk-meter__value' }, glyph ? icon(glyph, 14) : null, text)) : null,
      h('div', { 'class': 'mk-meter__track' },
        h('span', { 'class': 'mk-meter__fill', style: { width: (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + '%' } }),
        typeof o.target === 'number' ? h('span', { 'class': 'mk-meter__mark', style: { left: (Math.max(0, Math.min(1, o.target)) * 100).toFixed(1) + '%' }, title: o.targetLabel || 'Target' }) : null));
  };

  /* ---------------------------------------- callout, empty, not provided */

  var CALLOUT_ICONS = { info: 'info', good: 'check-circle', warn: 'alert-triangle', serious: 'alert-triangle', critical: 'alert-triangle', neutral: 'info' };

  /** callout('warn', 'Duplicate invoice number', 'Body text or nodes', {actions, icon}) */
  ui.callout = function (tone, title, body, o) {
    o = o || {};
    var t = CALLOUT_ICONS[tone] ? tone : 'neutral';
    return h('div', { 'class': ['mk-callout', t !== 'neutral' ? 'mk-callout--' + t : ''], role: t === 'critical' ? 'alert' : 'note' },
      icon(o.icon || CALLOUT_ICONS[t]),
      h('div', { 'class': 'mk-callout__main' },
        title ? h('div', { 'class': 'mk-callout__title' }, title) : null,
        body ? h('div', { 'class': 'mk-callout__body' }, body) : null),
      o.actions ? h('div', { 'class': 'mk-callout__actions' }, o.actions) : null);
  };

  /** emptyState('Title', 'Optional body', {icon, action: node, compact}) - also accepts a single options object. */
  ui.emptyState = function (title, body, o) {
    if (isPlainObject(title)) { o = title; title = o.title; body = o.body; }
    o = o || {};
    return h('div', { 'class': ['mk-empty', o.compact ? 'mk-empty--compact' : ''] },
      h('div', { 'class': 'mk-empty__icon' }, icon(o.icon || 'box', 20)),
      h('div', { 'class': 'mk-empty__title' }, title || 'Nothing here yet'),
      body ? h('div', { 'class': 'mk-empty__body' }, body) : null,
      o.action || null);
  };

  /** notProvided('Swiggy') -> muted italic "Not provided by Swiggy" with an info icon and a tooltip. */
  ui.notProvided = function (channelName, note) {
    var name = channelName || 'this channel';
    return h('span', { 'class': 'mk-np', title: note || (name + ' does not share this field with restaurants, so it is never shown or estimated here.') },
      icon('info', 14), 'Not provided by ' + name);
  };

  /**
   * sourceTag('petpooja' | ['swiggy_annexure', 'zomato_settlement'] | 'estimate', { prefix })
   * Small muted caption saying where a block's data comes from (DATA-FEASIBILITY.md section 2).
   * Captions come from MK.config.sources; unknown ids fall back to the id itself.
   */
  ui.sourceTag = function (ids, o) {
    o = o || {};
    var list = Array.isArray(ids) ? ids : [ids];
    var sources = (MK.config && MK.config.sources) || {};
    var node = h('div', { 'class': 'mk-source' }, icon('database', 12), h('span', { 'class': 'mk-source__label' }, o.prefix || 'Source'));
    list.forEach(function (id) {
      var s = sources[id];
      var isEstimate = id === 'estimate';
      node.appendChild(h('span', {
        'class': 'mk-source__item' + (isEstimate ? ' mk-source__item--estimate' : ''),
        title: s && s.route ? s.route + (s.frequency ? ' - ' + s.frequency : '') : ''
      }, s ? s.caption : String(id)));
    });
    return node;
  };

  /** estimateBadge() -> small "Estimated" chip for any figure computed at contracted rates before the weekly statement arrives. */
  ui.estimateBadge = function (label) {
    return h('span', { 'class': 'mk-estimate', title: 'Estimated at contracted rates - actuals arrive with the weekly statement' }, label || 'Estimated');
  };

  /** errorCard('Title', error | 'message', 'hint') - used by the router's page error boundary. */
  ui.errorCard = function (title, error, hint) {
    var message = error && error.message ? error.message : String(error || 'Unknown error');
    return h('div', { 'class': 'mk-errorcard', role: 'alert' },
      h('div', { 'class': 'mk-errorcard__title' }, icon('alert-triangle'), title || 'This screen could not be drawn'),
      h('pre', { 'class': 'mk-errorcard__msg' }, message),
      hint ? h('div', { 'class': 'mk-errorcard__hint' }, hint) : null);
  };

  /* ---------------------------------------------------- key-value, steps */

  /** keyValue([{label, value}] | [[label, value]], {cols: 2, stacked}) - value may be a node; null values are skipped. */
  ui.keyValue = function (pairs, o) {
    o = o || {};
    var list = (pairs || []).filter(Boolean).map(function (p) { return Array.isArray(p) ? { label: p[0], value: p[1] } : p; })
      .filter(function (p) { return p.value !== null && p.value !== undefined && p.value !== false; });
    var el = h('dl', { 'class': ['mk-kv', o.stacked ? 'mk-kv--stacked' : (o.cols === 2 ? 'mk-kv--2' : '')] });
    list.forEach(function (p) {
      var dt = h('dt', null, p.label), dd = h('dd', null, p.value);
      if (o.stacked) el.appendChild(h('div', { 'class': 'mk-kv__pair' }, dt, dd)); else { el.appendChild(dt); el.appendChild(dd); }
    });
    return el;
  };

  /** steps({items: ['Business', 'Tax ids', 'Bank', 'Review'], current: 1}) - wizard progress, zero-based current. */
  ui.steps = function (o) {
    o = o || {};
    var items = o.items || [], current = o.current || 0, out = [];
    items.forEach(function (label, i) {
      if (i > 0) out.push(h('li', { 'class': 'mk-steps__bar', 'aria-hidden': 'true' }));
      out.push(h('li', { 'class': ['mk-step', i === current ? 'is-current' : '', i < current ? 'is-done' : ''], 'aria-current': i === current ? 'step' : null },
        h('span', { 'class': 'mk-step__num' }, i < current ? icon('check', 12) : String(i + 1)), label));
    });
    return h('ol', { 'class': 'mk-steps' }, out);
  };

  /* ----------------------------------------------------------------- csv */

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s; /* neutralise spreadsheet formulas */
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * downloadCsv('batch-PB-0012.csv', [{key, label, value(row)}], rows) - raw values (not formatted), UTF-8 with BOM so
   * Excel reads the rupee sign and names correctly. Works from file:// (Blob + temporary anchor). Returns the CSV text.
   */
  ui.downloadCsv = function (filename, columns, rows) {
    var cols = (columns || []).filter(function (c) { return c && (c.key || typeof c.value === 'function') && c.csv !== false; });
    var lines = [cols.map(function (c) { return csvCell(c.label || c.key); }).join(',')];
    (rows || []).forEach(function (row) {
      lines.push(cols.map(function (c) {
        var v = typeof c.value === 'function' ? c.value(row) : row[c.key];
        if (v && typeof v === 'object') v = typeof v.value === 'number' ? v.value : ('label' in v ? v.label : ''); /* delta objects export their raw value */
        return csvCell(v);
      }).join(','));
    });
    var text = lines.join('\r\n');
    var blob = new root.Blob([String.fromCharCode(0xFEFF) + text], { type: 'text/csv;charset=utf-8' });
    var url = root.URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename || 'export.csv', style: { display: 'none' } });
    doc.body.appendChild(a);
    a.click();
    root.setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); root.URL.revokeObjectURL(url); }, 0);
    return text;
  };
})(window);
