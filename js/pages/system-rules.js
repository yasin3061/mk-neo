/*
 * System / Rules (#/system/rules) - the catalogue behind "Needs attention": what each rule watches, the period it
 * looks at, the severities it raises, the screen it opens, and the thresholds it uses - with a dial on every threshold.
 *
 * Moving a dial calls MK.insights.setThreshold, which keeps the value in prefs (the router does not repaint on prefs)
 * and lays it over the defaults in place; this page then repaints its own "fires now" figures from MK.insights.catalogue,
 * and every other screen that reads MK.insights (the Overview, the take-rate tiles, the bills queue) picks the change up
 * on its next render. Counts are for the period and outlet filter currently selected in the app, within the persona's
 * scope, so they match the Overview.
 *
 * Nothing on this page is typed in: names, sentences, windows and defaults come from MK.insights.FAMILIES and THRESHOLDS.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;

  var PAGE_ID = 'system-rules';
  var SEV = {
    critical: { label: 'Critical', tone: 'critical', icon: 'alert-triangle' },
    warning: { label: 'Warning', tone: 'warn', icon: 'eye' },
    info: { label: 'For information', tone: 'info', icon: 'info' },
    good: { label: 'Going well', tone: 'good', icon: 'check-circle' }
  };

  /* ------------------------------------------------------------------ helpers */

  function guard(name, fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; }
    catch (e) { if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e); return fallback; }
  }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function filtersNow() { return MK.filters && typeof MK.filters.get === 'function' ? (MK.filters.get() || {}) : {}; }

  /* a threshold in the units of its dial: 2.5 pts, 9.5%, Rs 15,000, 3 days, 0.25x */
  function valueText(t, v) {
    var a = Math.abs(v);
    switch (t.format) {
      case 'pts': return fmt.num(a * 100, 1) + ' pts';
      case 'pct': return fmt.pct(a, 1);
      case 'inr': return fmt.inr(a);
      case 'days': return fmt.num(a) + (a === 1 ? ' day' : ' days');
      case 'x': return fmt.num(a, 2) + 'x';
      default: return fmt.num(a);
    }
  }

  function tally(counts) {
    return ['critical', 'warning', 'info', 'good'].map(function (k) {
      return counts[k] ? fmt.num(counts[k]) + ' ' + (counts[k] === 1 ? SEV[k].label.toLowerCase() : (k === 'warning' ? 'warnings' : SEV[k].label.toLowerCase())) : null;
    }).filter(Boolean).join(', ');
  }

  /* ------------------------------------------------------------------ blocks */

  function intro(ctx, cat) {
    var user = ctx.user || MK.session.current();
    var f = filtersNow(), scope = f.outletIds && f.outletIds.length ? 'the outlets selected in the filter' : 'every unit in your scope';
    return h('div', { 'class': 'sr-intro' },
      h('p', { 'class': 'sr-intro__text' },
        '"Needs attention" is a rule engine, not a list of typed-in messages: ' + plural(cat.totals.rules, 'rule') + ' read the same figures the screens show, compare them ' +
        'with a threshold and write a finding only when it is crossed. This page is the catalogue: what each rule watches, the period it looks at, the severity it raises, ' +
        'and the thresholds it uses. ' + plural(cat.totals.withDials, 'rule has a dial', 'rules have dials') + '; the rest fire on a fact.'),
      h('p', { 'class': 'sr-intro__who' }, ui.icon('user', 14),
        h('span', null, 'Signed in as ' + user.name + ' - ' + user.roleLabel + '. "Fires now" counts the findings for ' + cat.window.label + ' and ' + scope +
          ', exactly as the Overview lists them.')));
  }

  function settingsCard(cat, live, refresh) {
    var marks = {};
    var dials = cat.settings.map(function (t) { return dial(t, marks, function () { refresh(); }); });
    var card = ui.card({
      title: 'Evaluation window', subtitle: 'Performance rules look back at least this far behind the filter, so that a short filter still has enough history and an exception raised last month stays on the list until the period moves on. Queue rules (bills, payables, batches, vendors) always describe the store as it is now.',
      className: 'sr-card sr-card--settings',
      body: h('div', { 'class': 'sr-dials' }, dials),
      footer: h('div', { 'class': 'sr-foot' }, h('span', { 'class': 'sr-foot__note' }, ui.icon('calendar', 12), 'Window in force: ' + cat.window.label), null)
    });
    live.settings = { marks: marks, foot: card.querySelector('.sr-foot__note') };
    return card;
  }

  /* one dial: label, stepper in the dial's own units, the default beside it */
  function dial(t, marks, refresh) {
    var sign = t.sign || 1;
    var stepper = ui.stepper({
      value: sign * t.value, min: sign === -1 ? -t.max : t.min, max: sign === -1 ? -t.min : t.max, step: t.step, size: 'sm', ariaLabel: t.label,
      format: function (v) { return valueText(t, v); },
      onChange: function (v) { MK.insights.setThreshold(t.ref, sign * v); refresh(); }
    });
    var mark = h('span', { 'class': 'sr-dial__default' });
    marks[t.ref] = { stepper: stepper, mark: mark };
    return h('div', { 'class': 'sr-dial' }, h('span', { 'class': 'sr-dial__label' }, t.label), stepper, mark);
  }

  function paintDials(marks, states) {
    states.forEach(function (t) {
      var m = marks[t.ref]; if (!m) return;
      m.stepper.setValue((t.sign || 1) * t.value);
      m.mark.textContent = t.isDefault ? 'default' : 'default ' + valueText(t, t.defaultValue);
      m.mark.classList.toggle('is-changed', !t.isDefault);
    });
  }

  function ruleCard(rule, live, refresh) {
    var marks = {}, firesHost = h('div', { 'class': 'sr-fires' });
    var dials = rule.thresholds.map(function (t) { return dial(t, marks, function () { refresh(rule.id); }); });
    var resetBtn = dials.length ? ui.button({ label: 'Reset', size: 'sm', variant: 'ghost', title: 'Back to the shipped thresholds of this rule', onClick: function () {
      rule.thresholds.forEach(function (t) { MK.insights.resetThresholds(t.ref); });
      refresh(rule.id);
    } }) : null;
    var card = ui.card({
      title: rule.name, subtitle: rule.watches, className: 'sr-card',
      actions: h('div', { 'class': 'sr-card__sev' }, rule.severity.map(function (s) { return ui.chip(SEV[s].label, SEV[s].tone, { icon: SEV[s].icon, outline: true }); })),
      body: [
        h('p', { 'class': 'sr-meta' }, ui.icon('calendar', 12), h('span', null, 'Looks at: ' + rule.window.toLowerCase())),
        dials.length ? h('div', { 'class': 'sr-dials' }, dials) : h('p', { 'class': 'sr-meta sr-meta--nodial' }, ui.icon('info', 12), h('span', null, 'No dial: this rule fires on a fact.')),
        firesHost
      ],
      footer: h('div', { 'class': 'sr-foot' }, ui.link('Open ' + rule.routeLabel, rule.route, { icon: 'arrow-right' }), resetBtn)
    });
    live.cards[rule.id] = { fires: firesHost, marks: marks, reset: resetBtn };
    return card;
  }

  function paintCard(entry, rule) {
    var f = rule.fires;
    ui.clear(entry.fires);
    entry.fires.appendChild(h('div', { 'class': 'sr-fires__head' },
      ui.chip(f.count ? plural(f.count, 'finding') + ' now' : 'Quiet now', f.count ? 'warn' : 'neutral', { icon: f.count ? 'alert-triangle' : 'check-circle' }),
      f.count ? h('span', { 'class': 'sr-fires__tally' }, tally(f.bySeverity)) : null,
      f.impact ? h('span', { 'class': 'sr-fires__impact' }, fmt.inr(f.impact) + ' at stake') : null));
    if (f.top) entry.fires.appendChild(h('p', { 'class': 'sr-fires__top', title: f.top.detail }, f.top.title));
    paintDials(entry.marks, rule.thresholds);
    if (entry.reset) entry.reset.disabled = rule.thresholds.every(function (t) { return t.isDefault; });
  }

  function kpis(cat, onResetAll) {
    var t = cat.totals;
    var tiles = ui.kpiRow([
      { label: 'Rules', icon: 'list', value: fmt.num(t.rules), sub: plural(t.withDials, 'rule has a dial', 'rules have dials') + ', ' + plural(t.rules - t.withDials, 'fires', 'fire') + ' on a fact' },
      { label: 'Firing now', icon: 'alert-triangle', value: fmt.num(t.firing), tone: t.counts.critical ? 'critical' : (t.counts.warning ? 'warn' : null),
        sub: t.firing ? tally(t.counts) : 'Nothing crosses a threshold for this period and scope' },
      { label: 'Thresholds changed', icon: 'edit', value: fmt.num(t.changed), tone: t.changed ? 'warn' : null,
        sub: t.changed ? 'Kept in this browser; the Overview follows on its next visit' : 'Every dial is at its shipped default' }
    ]);
    return h('div', { 'class': 'sr-kpis' }, tiles,
      h('div', { 'class': 'sr-kpis__actions' },
        ui.button({ label: 'Reset all to defaults', icon: 'refresh', size: 'sm', disabled: !t.changed, onClick: onResetAll }),
        ui.link('Back to Needs attention', '#/overview', { icon: 'arrow-right' })));
  }

  /* ------------------------------------------------------------------ render */

  function render(rootEl, ctx) {
    if (!MK.insights || typeof MK.insights.catalogue !== 'function') {
      rootEl.appendChild(ui.emptyState('Rules are not available', 'MK.insights did not load.', { icon: 'list' }));
      return;
    }
    var live = { cards: {}, settings: null, kpiHost: null };
    var cat = guard('insights.catalogue', function () { return MK.insights.catalogue(filtersNow()); }, null);
    if (!cat) { rootEl.appendChild(ui.emptyState('Rules are not available', 'The catalogue could not be read.', { icon: 'list' })); return; }

    /* ruleId: the rule whose dial moved - its findings and the totals are evaluated again while the dial stays in reach (MK.latency) */
    function refresh(ruleId) {
      cat = guard('insights.catalogue', function () { return MK.insights.catalogue(filtersNow()); }, cat);
      var fresh = kpis(cat, resetAll);
      live.kpiHost.replaceChild(fresh, live.kpiHost.firstChild);
      if (live.settings) { paintDials(live.settings.marks, cat.settings); live.settings.foot.lastChild.textContent = 'Window in force: ' + cat.window.label; }
      cat.rules.forEach(function (rule) { var entry = live.cards[rule.id]; if (entry) paintCard(entry, rule); });
      if (MK.latency) {
        MK.latency.veil(live.kpiHost, { profile: 'recalc' });
        cat.rules.forEach(function (rule) { var entry = live.cards[rule.id]; if (entry && (!ruleId || rule.id === ruleId)) MK.latency.part(entry.fires, 'mini', null, 'recalc'); });
      }
    }
    function resetAll() { MK.insights.resetThresholds(); refresh(); }

    rootEl.appendChild(intro(ctx, cat));
    live.kpiHost = h('div', null, kpis(cat, resetAll));
    rootEl.appendChild(live.kpiHost);
    rootEl.appendChild(ui.callout('info', 'Where these would live in the product',
      'A settings table with an owner (the finance checker by default), an audit trail on every change and the same stable finding keys, so a finding can be acknowledged, snoozed and auto-cleared when the condition passes. ' +
      'The rules themselves are code: about a day each, including the test that proves the seeded story is found.'));

    rootEl.appendChild(settingsCard(cat, live, refresh));

    MK.insights.AREAS.forEach(function (area) {
      var rules = cat.rules.filter(function (r) { return r.area === area; });
      if (!rules.length) return;
      var firing = rules.reduce(function (t, r) { return t + r.fires.count; }, 0);
      rootEl.appendChild(ui.sectionTitle(area, plural(rules.length, 'rule') + (firing ? ', ' + plural(firing, 'finding') + ' now' : ', quiet now')));
      rootEl.appendChild(ui.grid(2, rules.map(function (rule) { return ruleCard(rule, live, refresh); }), { className: 'sr-grid' }));
      rules.forEach(function (rule) { paintCard(live.cards[rule.id], rule); });
    });
    if (live.settings) paintDials(live.settings.marks, cat.settings);
    rootEl.appendChild(ui.sourceTag(['erp']));
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/system/rules',
    group: 'System',
    title: 'Rules',
    subtitle: 'What "Needs attention" watches, and the thresholds it uses',
    units: 'all',
    roles: null,
    filters: [],
    render: render
  });
})(window);
