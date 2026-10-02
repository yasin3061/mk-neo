/*
 * MK.latency - simulated server latency for the preview.
 *
 * Nothing is fetched: every figure on a screen is already computed in the browser when the screen is drawn. This
 * module makes the preview behave the way the product will while its read models answer: after a page (or a block)
 * is drawn, selected parts are veiled for a short random time behind a skeleton or a spinner with a caption, then
 * revealed with a fade. The content underneath is real and already laid out, so nothing jumps when it appears.
 *
 *   afterRender(pageEl, {navigated, pageId})   called by the router after every draw: a navigation veils at full
 *                                              length, a filter or persona change at 0.6x, any other repaint not at all
 *   veil(rootEl, {profile})                    veils every known part inside rootEl (see TARGETS)
 *   part(el, kind, label, profile)             veils one element; returns the delay in ms (0 when switched off)
 *   pulse(ms)                                  only the progress bar at the top (a save going to the server)
 *   enabled() / setEnabled(on)                 the switch (prefs.latency; "More options" in the top bar); ?instant in
 *                                              the URL switches everything off for a session
 *
 * The veil is CSS only (css/components.css, .mk-loading): classes and a data-loading caption on the element, the
 * shimmer, spinner and caption in pseudo-elements. Page code may therefore rebuild the content underneath while the
 * part is loading without losing the loader. Durations are random on purpose; the data layer stays deterministic.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !root.document) return;
  var doc = root.document;

  /* milliseconds [shortest, longest] by kind of part, before the profile scales them */
  var RANGES = { tile: [250, 800], chart: [700, 1900], table: [500, 1300], block: [900, 2000], record: [350, 800], mini: [300, 700] };
  var PROFILES = { navigate: 1, refresh: 0.6, recalc: 0.45 };
  var KINDS = Object.keys(RANGES);
  var TOP = { table: true, block: true, record: true };   /* tall parts: the spinner sits near the top, where the eye is */
  var HINT_MS = 1500;                                     /* a filter or persona change explains a repaint this soon after */
  var SKIP_PAGES = /^styleguide/;                         /* reference pages of the UI kit load at once */

  /* the parts a screen veils, most specific first: a part inside one already chosen is left to its parent */
  var TARGETS = [
    { sel: '.ov-herobody', kind: 'block', label: 'Loading the headline figures' },
    { sel: '.ov-attncard', part: '.mk-card__body', kind: 'block', label: 'Evaluating the rules' },
    { sel: '.ov-outlook__tiles', kind: 'block', label: 'Running the forecast' },
    { sel: '.fi-suggest', kind: 'block', label: 'Planning the purchases' },
    { sel: '.mk-chart', part: '.mk-chart__body', kind: 'chart', label: chartLabel },
    { sel: '.mk-table-wrap', kind: 'table', label: 'Fetching rows' },
    { sel: '.mk-hero', kind: 'tile' },
    { sel: '.mk-tile', kind: 'tile' }
  ];

  function chartLabel(el) {
    var t = el.querySelector('.mk-chart__title');
    var text = t ? String(t.textContent || '').trim() : '';
    return text ? 'Loading ' + text.charAt(0).toLowerCase() + text.slice(1) : 'Loading the chart';
  }

  /* ---------------------------------------------------------------- the switch */

  function enabled() {
    if (/[?&]instant\b/.test(root.location.search || '')) return false;
    var prefs = MK.store.get('prefs', {}) || {};
    return prefs.latency !== false;
  }
  function setEnabled(on) {
    var prefs = MK.store.get('prefs', {}) || {};
    prefs.latency = !!on;
    MK.store.set('prefs', prefs);
    return enabled();
  }

  /* ---------------------------------------------------------------- the progress bar */

  var active = 0, bar = null;
  function busy(delta) {
    active = Math.max(0, active + delta);
    if (!bar) {
      if (!doc.body) return;
      bar = doc.createElement('div');
      bar.className = 'mk-progress';
      bar.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(bar);
    }
    bar.classList.toggle('is-on', active > 0);
  }
  function pulse(ms) {
    if (!enabled()) return;
    busy(1);
    root.setTimeout(function () { busy(-1); }, ms || 450);
  }

  /* ---------------------------------------------------------------- one part */

  function finish(el) {
    var v = el._mkVeil;
    if (!v) return;
    root.clearTimeout(v.timer);
    el._mkVeil = null;
    el.classList.remove('mk-loading', 'mk-loading--top', 'mk-loading--rel');
    KINDS.forEach(function (k) { el.classList.remove('mk-loading--' + k); });
    el.removeAttribute('aria-busy');
    el.removeAttribute('data-loading');
    el.classList.add('mk-loaded');
    root.setTimeout(function () { el.classList.remove('mk-loaded'); }, 320);
    busy(-1);
  }

  function start(el, kind, label, scale) {
    if (el._mkVeil) return el._mkVeil.ms;                 /* already loading: the first veil stands */
    var r = RANGES[kind] || RANGES.table;
    var ms = Math.max(120, Math.round((r[0] + Math.random() * (r[1] - r[0])) * scale));
    el.classList.remove('mk-loaded');
    el.classList.add('mk-loading', 'mk-loading--' + (RANGES[kind] ? kind : 'table'));
    if (TOP[kind]) el.classList.add('mk-loading--top');
    if (doc.contains(el) && root.getComputedStyle(el).position === 'static') el.classList.add('mk-loading--rel');
    el.setAttribute('aria-busy', 'true');
    el.setAttribute('data-loading', label || '');
    busy(1);
    el._mkVeil = { ms: ms, timer: root.setTimeout(function () { finish(el); }, ms) };
    return ms;
  }

  /** part(el, kind, label, profile) - veil one element; returns the delay in ms, 0 when the simulation is off. */
  function part(el, kind, label, profile) {
    if (!el || !enabled()) return 0;
    return start(el, kind || 'table', label, PROFILES[profile] || PROFILES.navigate);
  }

  /** veil(rootEl, {profile}) - veil every known part inside rootEl (rootEl itself included); returns the longest delay. */
  function veil(rootEl, opts) {
    opts = opts || {};
    if (!rootEl || !enabled()) return 0;
    var scale = PROFILES[opts.profile] || PROFILES.navigate, chosen = [], longest = 0;
    TARGETS.forEach(function (t) {
      var hits = [];
      if (typeof rootEl.matches === 'function' && rootEl.matches(t.sel)) hits.push(rootEl);
      Array.prototype.push.apply(hits, rootEl.querySelectorAll(t.sel));
      hits.forEach(function (el) {
        var target = t.part ? el.querySelector(t.part) : el;
        if (!target || chosen.some(function (c) { return c === target || c.contains(target); })) return;
        chosen.push(target);
        var ms = start(target, t.kind, typeof t.label === 'function' ? t.label(el) : t.label, scale);
        if (ms > longest) longest = ms;
      });
    });
    return longest;
  }

  /* ---------------------------------------------------------------- why a page is being drawn */

  var hint = null;
  function note(profile) { hint = { profile: profile, at: Date.now() }; }
  MK.bus.on('filters:changed', function () { note('refresh'); });
  MK.bus.on('session:changed', function () { note('refresh'); });
  /* a write to the workflow store is a save: the bar runs, the screen is not veiled again */
  MK.bus.on('store:changed', function (evt) { if (evt && evt.key && evt.key !== 'prefs' && evt.key !== '*') pulse(500); });

  /** afterRender(pageEl, {navigated, pageId}) - the router's hook: full veil on a navigation, shorter on a filter or persona change. */
  function afterRender(pageEl, opts) {
    opts = opts || {};
    if (opts.pageId && SKIP_PAGES.test(opts.pageId)) return 0;
    var profile = null;
    if (opts.navigated) profile = 'navigate';
    else if (hint && Date.now() - hint.at < HINT_MS) profile = hint.profile;
    hint = null;
    return profile ? veil(pageEl, { profile: profile }) : 0;
  }

  MK.latency = {
    RANGES: RANGES, PROFILES: PROFILES, TARGETS: TARGETS,
    enabled: enabled, setEnabled: setEnabled,
    veil: veil, part: part, pulse: pulse, afterRender: afterRender,
    /** Reveal a part at once (or everything inside rootEl): for a screen that must not wait. */
    clear: function (rootEl) {
      if (!rootEl) return;
      if (rootEl._mkVeil) finish(rootEl);
      Array.prototype.forEach.call(rootEl.querySelectorAll('.mk-loading'), finish);
    }
  };
})(window);
