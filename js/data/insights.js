/*
 * MK.insights - rule-based management insights ("Needs attention"), computed on every call from the
 * live data layer: sales, channel economics, finance, factory and the workflow store. No insight is
 * stored and no figure is typed in: every number in a title or a detail sentence is read from a
 * selector and formatted with MK.fmt, so the text moves with the data, the filters and the persona.
 *
 * Scope: the rules only ever call the public, persona-scoped selectors (MK.data.*, MK.finance.*,
 * MK.factory.*, MK.workflow.*.list), so the Bandra manager gets Bandra's insights and the factory
 * manager the factory's. Nothing is cached.
 *
 * Period: performance rules look at the filter range, extended backwards to at least eight weeks
 * (RULES.minWindowDays) so that an exception raised last month stays on the list until the period
 * moves on; monthly rules use the latest complete month in that window; queue rules (approvals,
 * payables, batches, vendors) describe the workflow store as it is now.
 *
 * MK.insights.list(f) -> [{ id, severity, area, title, detail, metric: { label, value, format }, route, unitId, impact, period }]
 * sorted by severity (critical, warning, info, good) and then by impact in rupees.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});

  /* Thresholds of the rules as shipped. Shares and rates are fractions; amounts are rupees. */
  var DEFAULTS = {
    minWindowDays: 56,
    foodCost: { variancePts: 0.025 },                       /* actual above recipe by this share of net sales */
    takeRate: { gapPts: 0.06 },                             /* effective above contracted take rate */
    underUse: { weekendIndexGap: 0.25, soloIndex: 0.95, minWeekendDays: 4 },
    ramp: { ebitdaGainPts: 0.04 },
    fillRate: { gapPts: 0.03 },
    rent: { warnPct: 0.12, watchPct: 0.095 },
    budget: { overFlexedBy: 0.05, minOverrunPerLine: 5000, minOverrun: 15000, maxInsights: 3, criticalRatio: 1.5,
      coveredElsewhere: ['cogs_variance', 'agg_commission', 'agg_collection', 'agg_other', 'agg_gst_on_fees', 'agg_ads', 'agg_refunds'] },
    ppv: { minPct: 0.025, minAmount: 4000, warnAmount: 25000, months: 2, maxInsights: 4 },
    absorption: { underPct: -0.03 },
    markup: { attachMajorityShare: 0.5 },                   /* "attach items carry most of it" is said only from this share of the amount */
    approvals: { waitDays: 3 }
  };

  /* The live copy the rules read. The dials on #/system/rules keep their values in prefs.insights; syncThresholds() lays
     them over the defaults before every evaluation, in place, so a page holding MK.insights.RULES sees the same object. */
  var RULES = JSON.parse(JSON.stringify(DEFAULTS));

  /*
   * The dials: every threshold a user may move, with its range and step. `ref` is rule.key ('rent.warnPct'; 'window.minWindowDays'
   * for the top-level window). format: 'pts' | 'pct' | 'inr' | 'days' | 'x'. A negative threshold (under-absorption) is moved as
   * a magnitude: sign -1. Anything not listed here (lot sizes, how many insights a rule may raise, wording shares) is not a dial.
   */
  var THRESHOLDS = [
    { ref: 'window.minWindowDays', rule: null, key: 'minWindowDays', label: 'History behind the filter', format: 'days', min: 28, max: 112, step: 7 },
    { ref: 'takeRate.gapPts', rule: 'takeRate', key: 'gapPts', label: 'Effective rate above the contracted rate by', format: 'pts', min: 0.01, max: 0.12, step: 0.005 },
    { ref: 'underUse.weekendIndexGap', rule: 'underUse', key: 'weekendIndexGap', label: 'Weekend index below the other outlets by', format: 'x', min: 0.05, max: 0.6, step: 0.05 },
    { ref: 'underUse.minWeekendDays', rule: 'underUse', key: 'minWeekendDays', label: 'Weekend days needed in the window', format: 'days', min: 2, max: 10, step: 1 },
    { ref: 'foodCost.variancePts', rule: 'foodCost', key: 'variancePts', label: 'Food cost above recipe by', format: 'pts', min: 0.005, max: 0.06, step: 0.005 },
    { ref: 'budget.minOverrun', rule: 'budget', key: 'minOverrun', label: 'Smallest overrun reported', format: 'inr', min: 5000, max: 100000, step: 5000 },
    { ref: 'budget.overFlexedBy', rule: 'budget', key: 'overFlexedBy', label: 'Over the flexed plan by at least', format: 'pct', min: 0.01, max: 0.2, step: 0.01 },
    { ref: 'budget.criticalRatio', rule: 'budget', key: 'criticalRatio', label: 'Critical once spend reaches this multiple of plan', format: 'x', min: 1.1, max: 3, step: 0.1 },
    { ref: 'rent.watchPct', rule: 'rent', key: 'watchPct', label: 'For information from', format: 'pct', min: 0.05, max: 0.15, step: 0.005 },
    { ref: 'rent.warnPct', rule: 'rent', key: 'warnPct', label: 'Warning from', format: 'pct', min: 0.08, max: 0.2, step: 0.005 },
    { ref: 'ramp.ebitdaGainPts', rule: 'ramp', key: 'ebitdaGainPts', label: 'EBITDA margin gained since the first month', format: 'pts', min: 0.01, max: 0.1, step: 0.005 },
    { ref: 'approvals.waitDays', rule: 'approvals', key: 'waitDays', label: 'Days waiting for a decision', format: 'days', min: 1, max: 14, step: 1 },
    { ref: 'fillRate.gapPts', rule: 'fillRate', key: 'gapPts', label: 'Below the daily-supplied outlets by', format: 'pts', min: 0.01, max: 0.1, step: 0.005 },
    { ref: 'ppv.minPct', rule: 'ppv', key: 'minPct', label: 'Price away from standard by at least', format: 'pct', min: 0.005, max: 0.1, step: 0.005 },
    { ref: 'ppv.warnAmount', rule: 'ppv', key: 'warnAmount', label: 'Warning from a variance of', format: 'inr', min: 5000, max: 100000, step: 5000 },
    { ref: 'absorption.underPct', rule: 'absorption', key: 'underPct', label: 'Under-absorption of transfer value beyond', format: 'pct', min: -0.1, max: -0.01, step: 0.005, sign: -1 }
  ];

  /*
   * The catalogue: one entry per family of finding (the prefix of the finding id), with what it watches, the period it looks at,
   * the severities it raises, the screen it opens and the dials it uses. This is what #/system/rules shows; a family with no
   * dial fires on a fact. `rule` on every finding names its family.
   */
  var FAMILIES = [
    { id: 'takerate', prefix: 'takerate|', area: 'Revenue', name: 'Aggregators keep more than the contract', severity: ['warning'], route: '#/revenue/audit', routeLabel: 'Tax & commission audit', thresholds: ['takeRate.gapPts'],
      watches: 'The effective take rate on settled statements (service and collection fees, GST on fees, ads and refunds as a share of aggregator net sales) against the contracted rate, by outlet. Unsettled weeks are never counted.', window: 'Statements settled inside the window' },
    { id: 'underuse', prefix: 'underuse|', area: 'Revenue', name: 'Outlet under-used on weekends', severity: ['warning'], route: '#/revenue/timeslots', routeLabel: 'Time slots', thresholds: ['underUse.weekendIndexGap', 'underUse.minWeekendDays'],
      watches: function (R) { return 'A weekend day\'s sales against a Monday-to-Thursday day, compared with the same ratio at the other outlets in view (against ' + times(R.underUse.soloIndex) + ' when one outlet is in view); the evening is named too when dinner and late night fall short.'; }, window: 'The whole window' },
    { id: 'payout', prefix: 'payout|', area: 'Revenue', name: 'Short-paid settlement', severity: ['critical'], route: '#/revenue/audit', routeLabel: 'Tax & commission audit', thresholds: [],
      watches: 'A payout cycle whose statement pays less than the orders it settles, from the payout reconciliation. No threshold: a short payment is a fact.', window: 'Cycles settled inside the window' },
    { id: 'commission', prefix: 'commission|', area: 'Revenue', name: 'Commission charged above contract', severity: ['critical'], route: '#/revenue/audit', routeLabel: 'Tax & commission audit', thresholds: [],
      watches: 'The service-fee rate on a settled statement against the contracted (assumed) rate, by outlet and channel, grouped across the weeks it persists. The tolerance belongs to the statement audit, not to this list.', window: 'Statements settled inside the window' },
    { id: 'ads', prefix: 'ads|', area: 'Revenue', name: 'Ads deducted above the usual share', severity: ['warning'], route: '#/revenue/audit', routeLabel: 'Tax & commission audit', thresholds: [],
      watches: 'Ads deducted from a payout as a share of menu value against the trailing share, from the statement audit. Campaign performance itself stays in the partner dashboard.', window: 'Statements settled inside the window' },
    { id: 'markup', prefix: 'markup|', area: 'Revenue', name: 'Aggregator markup below the take rate', severity: ['warning', 'info'], route: '#/revenue/dishes', routeLabel: 'Dishes', thresholds: [],
      watches: 'A dish listed on an aggregator at a markup that does not cover the effective take rate: a warning when the POS price moved and the aggregator price did not, otherwise one line for the rest. From the markup audit, at the prices in force on each day.', window: 'The whole window' },
    { id: 'foodcost', prefix: 'foodcost|', area: 'Costs', name: 'Food cost above recipe', severity: ['warning', 'critical'], route: '#/costs/cogs', routeLabel: 'Food cost (COGS)', thresholds: ['foodCost.variancePts'],
      watches: 'Actual food cost against the recipe cost of the portions sold, by outlet; critical above the red-flag level of the food-cost model.', window: 'The complete months in the window' },
    { id: 'budget', prefix: 'budget|', area: 'Costs', name: 'Budget line over plan', severity: ['warning', 'critical'], route: '#/costs/budget', routeLabel: 'Budget tracking', thresholds: ['budget.minOverrun', 'budget.overFlexedBy', 'budget.criticalRatio'],
      watches: 'Approved and pipeline spend of a category against its plan, flexed for actual sales on variable lines, across the units in view: the three largest overruns, with the LPG price or a one-off named when it explains the line. Aggregator lines are left to the revenue rules.', window: 'The latest complete month' },
    { id: 'rent', prefix: 'rent|', area: 'Costs', name: 'Rent heavy for the sales', severity: ['info', 'warning'], route: '#/costs/unit-economics', routeLabel: 'Unit economics', thresholds: ['rent.watchPct', 'rent.warnPct'],
      watches: 'Rent before the GST on it as a share of net sales, by outlet.', window: 'The latest complete month' },
    { id: 'ramp', prefix: 'ramp|', area: 'Costs', name: 'Outlet ramp into profit', severity: ['good'], route: '#/costs/unit-economics', routeLabel: 'Unit economics', thresholds: ['ramp.ebitdaGainPts'],
      watches: 'An outlet that started the data at a loss and has gained at least this much EBITDA margin by the latest complete month.', window: 'The P&L trend to the latest complete month' },
    { id: 'margin', prefix: 'margin|', area: 'Costs', name: 'Margin leader', severity: ['good'], route: '#/costs/unit-economics', routeLabel: 'Unit economics', thresholds: [],
      watches: 'The outlet with the highest EBITDA margin when more than one outlet is in view. No threshold.', window: 'The latest complete month' },
    { id: 'approvals_waiting', prefix: 'approvals|waiting', area: 'Approvals', name: 'Bills waiting for a decision', severity: ['warning'], route: '#/approvals/bills', routeLabel: 'Bills', thresholds: ['approvals.waitDays'],
      watches: 'Bills submitted or under review for at least this many days, with the oldest named.', window: 'The queue as it stands now' },
    { id: 'approvals_duplicate', prefix: 'approvals|duplicate|', area: 'Approvals', name: 'Duplicate invoice number in the queue', severity: ['warning'], route: '#/approvals/bills', routeLabel: 'Bills', thresholds: [],
      watches: 'A bill in the queue that repeats a vendor invoice number already in the books. No threshold: it cannot be approved without a note.', window: 'The queue as it stands now' },
    { id: 'approvals_budget', prefix: 'approvals|budget', area: 'Approvals', name: 'Queued bills that take a line over plan', severity: ['info'], route: '#/approvals/bills', routeLabel: 'Bills', thresholds: [],
      watches: function () { var p = (MK.config && MK.config.budgetPolicy) || { warnAtPct: 0.9, overAtPct: 1 }; return 'Queued bills whose budget impact would put their line over plan, judged by the budget policy (over at ' + pct(p.overAtPct, 0) + ' of plan, watch from ' + pct(p.warnAtPct, 0) + ').'; }, window: 'The queue as it stands now' },
    { id: 'payables', prefix: 'payables|', area: 'Approvals', name: 'Payables past due', severity: ['warning', 'critical'], route: '#/approvals/payables', routeLabel: 'Payables', thresholds: [],
      watches: 'Open bills past their due date by ageing bucket; critical once any bill is more than a month late. Money released to the bank and awaiting a UTR is not counted as overdue.', window: 'As of today' },
    { id: 'batch', prefix: 'batch|', area: 'Approvals', name: 'Payment batch in flight', severity: ['warning', 'info'], route: '#/approvals/payments', routeLabel: 'Payment batches', thresholds: [],
      watches: 'A batch awaiting the director\'s release (warning) or released to the bank without UTRs recorded yet (information). No threshold.', window: 'As of today' },
    { id: 'yield', prefix: 'yield|', area: 'Factory', name: 'Yield below standard', severity: ['warning'], route: '#/factory/production', routeLabel: 'Production & dispatch', thresholds: [],
      watches: 'A factory product whose yield over the window falls below its standard by more than the factory model\'s tolerance, valued at standard raw-material prices.', window: 'The whole window' },
    { id: 'fill', prefix: 'fill|', area: 'Factory', name: 'Fill rate on the alternate-day run', severity: ['info', 'warning'], route: '#/factory/production', routeLabel: 'Production & dispatch', thresholds: ['fillRate.gapPts'],
      watches: 'The fill rate of an alternate-day outlet against the daily-supplied outlets; a warning below the target band, with the logistics cost per kg beside it.', window: 'The whole window' },
    { id: 'ppv', prefix: 'ppv|', area: 'Factory', name: 'Purchase price away from standard', severity: ['good', 'info', 'warning'], route: '#/factory/inventory', routeLabel: 'Inventory', thresholds: ['ppv.minPct', 'ppv.warnAmount'],
      watches: 'The purchase-price variance of a raw material over the latest two months of the window, the four largest either way; a favourable variance is good news.', window: 'The latest two months of the window' },
    { id: 'absorption', prefix: 'absorption|', area: 'Factory', name: 'Factory under-absorption', severity: ['warning'], route: '#/factory/overview', routeLabel: 'Factory economics', thresholds: ['absorption.underPct'],
      watches: 'A complete month in which transfers at standard cost did not cover raw materials and conversion, with the two largest variance drivers named.', window: 'The complete months in the window' },
    { id: 'vendor', prefix: 'vendor|', area: 'Vendors', name: 'Vendor needs a decision', severity: ['warning', 'info'], route: '#/vendors', routeLabel: 'Vendors', thresholds: [],
      watches: 'A vendor flagged by verification (warning) or still being verified (information), with the bills it holds up. No threshold.', window: 'As of today' }
  ];

  function familyOf(id) {
    for (var i = 0; i < FAMILIES.length; i++) if (String(id).indexOf(FAMILIES[i].prefix) === 0) return FAMILIES[i].id;
    return null;
  }
  function descriptorOf(ref) { for (var i = 0; i < THRESHOLDS.length; i++) if (THRESHOLDS[i].ref === ref) return THRESHOLDS[i]; return null; }
  function stored() { var p = MK.store.get('prefs', {}) || {}; return p.insights && typeof p.insights === 'object' ? p.insights : {}; }
  function defaultOf(d) { return d.rule ? DEFAULTS[d.rule][d.key] : DEFAULTS[d.key]; }
  function valueOf(d) { var s = stored(); return typeof s[d.ref] === 'number' && isFinite(s[d.ref]) ? s[d.ref] : defaultOf(d); }
  function snap(d, v) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    v = Math.round(v / d.step) * d.step;
    v = Math.max(d.min, Math.min(d.max, v));
    return Math.round(v * 10000) / 10000;
  }
  /* lay the stored dials over the defaults, in place */
  function syncThresholds() {
    THRESHOLDS.forEach(function (d) { if (d.rule) RULES[d.rule][d.key] = valueOf(d); else RULES[d.key] = valueOf(d); });
  }
  function thresholdState(d) {
    var v = valueOf(d), def = defaultOf(d);
    return { ref: d.ref, rule: d.rule, key: d.key, label: d.label, format: d.format, sign: d.sign || 1, min: d.min, max: d.max, step: d.step, value: v, defaultValue: def, isDefault: v === def };
  }
  /** setThreshold('rent.warnPct', 0.13) -> the value in force after snapping to the dial's range, or null for an unknown dial. */
  function setThreshold(ref, value) {
    var d = descriptorOf(ref); if (!d) return null;
    var v = snap(d, value); if (v === null) return valueOf(d);
    var prefs = MK.store.get('prefs', {}) || {}, s = prefs.insights && typeof prefs.insights === 'object' ? prefs.insights : {};
    if (v === defaultOf(d)) delete s[ref]; else s[ref] = v;
    prefs.insights = s;
    MK.store.set('prefs', prefs);
    syncThresholds();
    MK.bus.emit('insights:changed', { ref: ref, value: v });
    return v;
  }
  /** resetThresholds() puts every dial back to its default; resetThresholds('rent.warnPct') one of them. */
  function resetThresholds(ref) {
    var prefs = MK.store.get('prefs', {}) || {}, s = prefs.insights && typeof prefs.insights === 'object' ? prefs.insights : {};
    if (ref) delete s[ref]; else s = {};
    prefs.insights = s;
    MK.store.set('prefs', prefs);
    syncThresholds();
    MK.bus.emit('insights:changed', { ref: ref || '*' });
  }
  /**
   * catalogue(f) -> { rules: [{ id, name, area, severity, route, routeLabel, watches, window, thresholds: [state], fires: { count, impact, bySeverity, top } }],
   *                  settings: [state], window, totals: { rules, withDials, firing, counts, changed } } - the rule list with what fires now for the filter.
   */
  function catalogue(f) {
    var items = list(f), byFamily = {}, changed = 0, withDials = 0;
    items.forEach(function (x) { (byFamily[x.rule] = byFamily[x.rule] || []).push(x); });
    var rules = FAMILIES.map(function (fam) {
      var fires = byFamily[fam.id] || [], impact = 0, bySev = {};
      fires.forEach(function (x) { impact += x.impact; bySev[x.severity] = (bySev[x.severity] || 0) + 1; });
      var states = fam.thresholds.map(function (ref) { var st = thresholdState(descriptorOf(ref)); if (!st.isDefault) changed++; return st; });
      if (states.length) withDials++;
      /* a sentence that quotes a constant is composed from it, never typed (check-data scans the source for typed figures) */
      return { id: fam.id, name: fam.name, area: fam.area, severity: fam.severity.slice(), route: fam.route, routeLabel: fam.routeLabel, watches: typeof fam.watches === 'function' ? fam.watches(RULES) : fam.watches, window: fam.window,
        thresholds: states, fires: { count: fires.length, impact: impact, bySeverity: bySev, top: fires[0] || null } };
    });
    var settings = THRESHOLDS.filter(function (d) { return !d.rule; }).map(function (d) { var st = thresholdState(d); if (!st.isDefault) changed++; return st; });
    var counts = { critical: 0, warning: 0, info: 0, good: 0, total: 0 };
    items.forEach(function (x) { counts[x.severity]++; counts.total++; });
    return { rules: rules, settings: settings, window: windowOf(f || {}), totals: { rules: FAMILIES.length, withDials: withDials, firing: items.length, counts: counts, changed: changed } };
  }

  var SEVERITY_RANK = { critical: 0, warning: 1, info: 2, good: 3 };

  /* ------------------------------------------------------------------ helpers */

  var fmt = MK.fmt, D = MK.dates;
  function inr(n) { return fmt.inr(n); }
  function pct(x, d) { return fmt.pct(x, d); }
  function pts(x) { return (x * 100).toFixed(1) + ' pts'; }
  function times(x) { return fmt.num(x, 2) + 'x'; }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : many); }
  function byId(list) { var m = {}; (list || []).forEach(function (x) { m[x.id] = x; }); return m; }
  function listOf(names, max) {
    var shown = names.slice(0, max || 3), rest = names.length - shown.length;
    return shown.join(', ') + (rest > 0 ? ' and ' + fmt.num(rest) + ' more' : '');
  }
  function unitName(id) { var u = byId(MK.config.outlets)[id]; return u ? u.name : id; }
  function channelName(id) { var c = byId(MK.config.channels)[id]; return c ? c.label : id; }
  function userName(id) { var u = MK.session.userById(id); return u ? u.name : 'someone'; }

  /** The evaluation window of a filter (see the header): dates, whole months and the latest complete month. */
  function windowOf(f) {
    var cal = MK.calendar, months = MK.config.months;
    var to = f && typeof f.to === 'string' ? f.to : cal.dataEnd, from = f && typeof f.from === 'string' ? f.from : cal.dataStart;
    if (from > to) { var t = from; from = to; to = t; }
    to = D.min(D.max(to, cal.dataStart), cal.dataEnd); from = D.min(D.max(from, cal.dataStart), to);
    var start = D.max(cal.dataStart, D.min(from, D.addDays(to, -(RULES.minWindowDays - 1))));
    var inWindow = months.filter(function (m) { return m >= D.monthKey(start) && m <= D.monthKey(to); });
    var complete = inWindow.filter(function (m) { return D.monthEnd(m + '-01') <= cal.dataEnd; });
    return { from: start, to: to, label: D.label(start) + ' - ' + D.label(to), months: inWindow, monthFrom: inWindow[0], monthTo: inWindow[inWindow.length - 1],
      completeMonth: complete.length ? complete[complete.length - 1] : null, filterFrom: from };
  }

  function countDows(from, to) {
    var n = [0, 0, 0, 0, 0, 0, 0], days = D.diffDays(from, to) + 1, first = D.dow(from);
    for (var i = 0; i < days; i++) n[(first + i) % 7]++;
    return n;
  }

  /* ---------------------------------------------------------------- the rules */
  /* Each rule receives the context and pushes zero or more insights. A rule that cannot run for this persona pushes nothing. */

  function ruleFoodCost(c) {
    if (!c.outletIds.length) return;
    var fc = MK.finance.foodCost({ from: c.w.monthFrom, to: c.w.monthTo }, c.outletIds);
    (fc.rows || []).forEach(function (r) {
      if (!r.netSales || r.variancePts < RULES.foodCost.variancePts) return;
      var others = fc.rows.filter(function (o) { return o.outletId !== r.outletId && o.netSales; });
      var othersPts = others.length ? others.reduce(function (t, o) { return t + o.variance; }, 0) / others.reduce(function (t, o) { return t + o.netSales; }, 0) : null;
      c.push({ id: 'foodcost|' + r.outletId, severity: r.redFlag ? 'critical' : 'warning', area: 'Costs', unitId: r.outletId, route: '#/costs/cogs', period: fc.period.label,
        title: r.label + ' food cost runs ' + pts(r.variancePts) + ' above recipe',
        detail: 'Actual food cost is ' + pct(r.actualPct) + ' of net sales against a recipe cost of ' + pct(r.theoreticalPct) + ' (' + fc.period.label + '): ' + inr(r.variance) +
          ' went to wastage and portioning' + (othersPts !== null ? ', while the other outlets run ' + pts(othersPts) + ' above recipe - a control problem, not a pricing one' : '') +
          (r.redFlag ? '. Above the ' + pct(fc.redFlagPct, 0) + ' red-flag level' : '') + '.',
        metric: { label: 'Food cost variance', value: r.variance, format: 'inr' }, impact: r.variance });
    });
  }

  function ruleTakeRate(c) {
    var ce = MK.data.channelEconomics(c.fw);
    /* the evidence ends where the uploaded statements end, not where the filter ends */
    var covered = (ce.channels || []).filter(function (ch) { return ch.actual && ch.actual.hasData && ch.actualThrough; })
      .map(function (ch) { return channelName(ch.channelId) + ' through ' + D.label(ch.actualThrough); });
    var coverage = 'from ' + D.label(c.w.from) + (covered.length ? ' (' + covered.join(', ') + ')' : '');
    (ce.byOutlet || []).forEach(function (o) {
      var a = o.actual; if (!a || !a.hasData || !a.netSales) return;
      var gap = a.effectiveTakeRate - a.contractedTakeRate; if (gap < RULES.takeRate.gapPts) return;
      var impact = Math.round(gap * a.netSales);
      c.push({ id: 'takerate|' + o.outletId, severity: 'warning', area: 'Revenue', unitId: o.outletId, route: '#/revenue/audit', period: 'Settled statements ' + coverage,
        title: o.label + ': aggregators keep ' + pct(a.effectiveTakeRate) + ' of net sales against ' + pct(a.contractedTakeRate) + ' on contract',
        detail: 'Settled statements ' + coverage + ': ads of ' + inr(a.ads) + ' and refunds of ' + inr(a.refunds) + ' come on top of the contracted fees, and restaurant-funded discounts take ' +
          pct(a.grossValue ? a.restaurantDiscount / a.grossValue : 0) + ' of menu value first. The outlet keeps ' + pct(a.realisationPctOfMenu) + ' of aggregator menu value; the gap to contract is worth ' +
          inr(impact) + '. Contract rates are assumed.',
        metric: { label: 'Effective take rate', value: a.effectiveTakeRate, format: 'pct' }, impact: impact });
    });
  }

  function ruleUnderUse(c) {
    var m = MK.data.matrix(c.fw, 'outlet', 'dow', 'netSales');
    if (!m.supported || !m.rows.length) return;
    var n = countDows(c.w.from, c.w.to), weekdays = n[0] + n[1] + n[2] + n[3], weekendDays = n[5] + n[6];
    if (weekendDays < RULES.underUse.minWeekendDays || !weekdays) return;
    var slots = MK.data.matrix(c.fw, 'outlet', 'slot', 'netSales'), late = [];
    slots.cols.forEach(function (col, j) { if (col.id === 'dinner' || col.id === 'latenight') late.push(j); });
    var rows = m.rows.map(function (r, i) {
      var v = m.values[i], wd = (v[0] + v[1] + v[2] + v[3]) / weekdays, we = (v[5] + v[6]) / weekendDays, sv = slots.values[i] || [];
      return { id: r.id, label: r.label, weekday: wd, weekend: we, total: m.rowTotals[i], evening: late.reduce(function (t, j) { return t + (sv[j] || 0); }, 0) };
    }).filter(function (r) { return r.weekday > 0; });
    rows.forEach(function (r) {
      var others = rows.filter(function (o) { return o.id !== r.id; });
      var index = r.weekend / r.weekday, ref, refEvening = null;
      if (others.length) {
        ref = others.reduce(function (t, o) { return t + o.weekend; }, 0) / others.reduce(function (t, o) { return t + o.weekday; }, 0);
        refEvening = others.reduce(function (t, o) { return t + o.evening; }, 0) / others.reduce(function (t, o) { return t + o.total; }, 0);
        if (index > ref - RULES.underUse.weekendIndexGap) return;
      } else { ref = 1; if (index >= RULES.underUse.soloIndex) return; }
      var impact = Math.round((ref - index) * r.weekday * weekendDays), eveningShare = r.total ? r.evening / r.total : 0;
      var quietEvenings = refEvening !== null && eveningShare < refEvening;
      c.push({ id: 'underuse|' + r.id, severity: 'warning', area: 'Revenue', unitId: r.id, route: '#/revenue/timeslots', period: c.w.label,
        title: r.label + ' is under-used on weekends' + (quietEvenings ? ' and in the evening' : ''),
        detail: 'A weekend day brings ' + times(index) + ' the sales of a Monday-to-Thursday day' + (others.length ? '; at the other outlets it is ' + times(ref) : '') + ' (' + c.w.label + ').' +
          (quietEvenings ? ' Dinner and late night are ' + pct(eveningShare) + ' of sales against ' + pct(refEvening) + ' elsewhere.' : '') +
          ' Trading weekends like ' + (others.length ? 'the rest of the network' : 'a weekday') + ' would add about ' + inr(impact) + ' over the period; rent does not change.',
        metric: { label: 'Weekend sales opportunity', value: impact, format: 'inr' }, impact: impact });
    });
  }

  /* A month whose channel costs include the unsettled tail is quoted with that caveat, never as a plain fact. */
  function estimateClause(row) {
    return row && row.estimatedPart > 0 ? ', including ' + inr(row.estimatedPart) + ' of aggregator charges estimated at assumed contract rates until the statements arrive' : '';
  }

  function ruleRampAndMargin(c) {
    var best = null, month = c.w.completeMonth;
    c.outletIds.forEach(function (id) {
      var rows = (MK.finance.pnlTrend(id).rows || []).filter(function (r) { return r.netSales > 0; }); if (!rows.length) return;
      var first = rows[0], full = rows.filter(function (r) { return !r.partial && (!month || r.monthKey <= month); }), last = full[full.length - 1], open = rows[rows.length - 1];
      if (!last || last === first) return;
      if (!best || last.ebitdaPct > best.row.ebitdaPct) best = { id: id, row: last };
      if (first.ebitdaPct >= 0 || last.ebitdaPct - first.ebitdaPct < RULES.ramp.ebitdaGainPts) return;
      c.push({ id: 'ramp|' + id, severity: 'good', area: 'Costs', unitId: id, route: '#/costs/unit-economics', period: first.label + ' - ' + last.label,
        title: unitName(id) + ' has moved from ' + pct(first.ebitdaPct) + ' to ' + pct(last.ebitdaPct) + ' EBITDA',
        detail: 'Net sales grew from ' + inr(first.netSales) + ' in ' + first.label + ' to ' + inr(last.netSales) + ' in ' + last.label + ' (' + fmt.delta(last.netSales, first.netSales).label +
          '), turning a loss of ' + inr(-first.ebitda) + ' into ' + (last.ebitda >= 0 ? 'a profit of ' + inr(last.ebitda) : 'a loss of ' + inr(-last.ebitda)) + '. Channel costs still take ' + pct(last.channelCostsPct) +
          ' of sales' + (open.partial ? '; ' + open.label + ' to date stands at ' + pct(open.ebitdaPct) + estimateClause(open) : '') + '.',
        metric: { label: 'EBITDA margin', value: last.ebitdaPct, format: 'pct' }, impact: last.ebitda - first.ebitda });
    });
    if (best && c.outletIds.length > 1 && best.row.ebitdaPct > 0) {
      c.push({ id: 'margin|' + best.id, severity: 'good', area: 'Costs', unitId: best.id, route: '#/costs/unit-economics', period: best.row.label,
        title: unitName(best.id) + ' leads on margin: ' + pct(best.row.ebitdaPct) + ' EBITDA in ' + best.row.label,
        detail: inr(best.row.ebitda) + ' of EBITDA on net sales of ' + inr(best.row.netSales) + '; food cost ' + pct(best.row.foodCostPct) + ', channel costs ' + pct(best.row.channelCostsPct) + ' of sales' + estimateClause(best.row) + '.',
        metric: { label: 'EBITDA margin', value: best.row.ebitdaPct, format: 'pct' }, impact: best.row.ebitda });
    }
  }

  function ruleRent(c) {
    var month = c.w.completeMonth; if (!month) return;
    var units = byId(MK.config.outlets);
    c.outletIds.forEach(function (id) {
      var p = MK.finance.pnl(id, month), rent = null;
      (p.lines || []).forEach(function (l) { if (l.key === 'rent') rent = l; });
      if (!rent || !p.totals.netSales || rent.pctOfSales < RULES.rent.watchPct) return;
      var heavy = rent.pctOfSales >= RULES.rent.warnPct, sqft = units[id] && units[id].sqft;
      c.push({ id: 'rent|' + id, severity: heavy ? 'warning' : 'info', area: 'Costs', unitId: id, route: '#/costs/unit-economics', period: p.period.label,
        title: unitName(id) + ' rent is ' + pct(rent.pctOfSales) + ' of net sales',
        detail: inr(rent.amount) + ' a month' + (sqft ? ' (' + fmt.inrFull(Math.round(rent.amount / sqft)) + ' per sq ft)' : '') + ' before the non-creditable GST on it, against net sales of ' + inr(p.totals.netSales) +
          ' in ' + p.period.label + '. Outlet EBITDA is ' + pct(p.totals.ebitdaPct) + estimateClause(p.totals) + (heavy ? ': the fixed base needs more sales in the quiet hours.' : ': the margin carries it, but it is the line to watch at renewal.'),
        metric: { label: 'Rent share of sales', value: rent.pctOfSales, format: 'pct' }, impact: rent.amount });
    });
  }

  function ruleAuditFlags(c) {
    var audit = MK.data.auditFlags(c.fw), flags = audit.flags || [], groups = {}, minor = [];
    flags.forEach(function (fl) {
      if (fl.type === 'payout') {
        var dispute = fl.data && fl.data.dispute;
        c.push({ id: 'payout|' + fl.payoutId, severity: 'critical', area: 'Revenue', unitId: fl.outletId, route: fl.route, period: fl.period.label,
          title: channelName(fl.channelId) + ' short-paid ' + unitName(fl.outletId) + ' by ' + inr(fl.amount),
          detail: 'Payout for ' + fl.period.label + ': ' + fl.detail.replace(/^[^:]*:\s*/, '') + '. ' +
            (dispute ? 'Dispute raised on ' + D.label(dispute.raisedOn, 'd MMM yyyy') + ', status ' + String(dispute.status).toLowerCase() + '.' : 'No dispute raised yet.'),
          metric: { label: 'Short payment', value: fl.amount, format: 'inr' }, impact: fl.amount });
      } else if (fl.type === 'commission' || fl.type === 'ads') {
        var k = fl.type + '|' + fl.outletId + '|' + fl.channelId;
        (groups[k] || (groups[k] = [])).push(fl);
      } else if (fl.type === 'markup') {
        if (fl.data && fl.data.stalePriceChange) {
          var ch = fl.data.stalePriceChange, worst = fl.data.outlets.slice().sort(function (a, b) { return a.markupPct - b.markupPct; })[0];
          c.push({ id: 'markup|' + fl.dishId, severity: 'warning', area: 'Revenue', unitId: null, route: '#/revenue/dishes', period: c.w.label,
            title: fl.detail.split(':')[0] + ': aggregator price not raised after the POS price change',
            detail: 'The POS price went from ' + fmt.inrFull(ch.from) + ' to ' + fmt.inrFull(ch.to) + ' on ' + D.label(ch.date, 'd MMM yyyy') + ' but the aggregator menus still list ' + fmt.inrFull(worst.aggPrice) +
              ': a markup of ' + pct(worst.markupPct) + ' against an effective take rate of ' + pct(worst.effectiveTakeRate) + '. An aggregator portion now realises about ' + fmt.inrFull(Math.round(worst.realisationPerPortion)) +
              ' against ' + fmt.inrFull(worst.posPrice) + ' at the counter - ' + inr(fl.amount) + ' over ' + c.w.label + ', at the menu prices in force on each day.',
            metric: { label: 'Realisation below POS price', value: fl.amount, format: 'inr' }, impact: fl.amount });
        } else minor.push(fl);
      }
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k], first = g[0], total = g.reduce(function (t, x) { return t + x.amount; }, 0), periods = g.map(function (x) { return x.period.label; }).reverse();
      if (first.type === 'commission') {
        c.push({ id: k, severity: 'critical', area: 'Revenue', unitId: first.outletId, route: first.route, period: periods.join(', '),
          title: channelName(first.channelId) + ' charged ' + pct(first.data.chargedPct) + ' against the contracted ' + pct(first.data.contractPct) + ' at ' + unitName(first.outletId),
          detail: plural(g.length, 'settlement week', 'settlement weeks') + ' (' + periods.join(', ') + '): ' + inr(total) + ' over-charged including GST on the fee. Raise it with the aggregator; the contract rate shown is an assumed rate.',
          metric: { label: 'Over-charged', value: total, format: 'inr' }, impact: total });
      } else {
        var share = Math.max.apply(null, g.map(function (x) { return x.data.adsShare; })), trailing = first.data.trailingShare;
        c.push({ id: k, severity: 'warning', area: 'Revenue', unitId: first.outletId, route: first.route, period: periods.join(', '),
          title: channelName(first.channelId) + ' ads at ' + unitName(first.outletId) + ' ran at ' + times(trailing ? share / trailing : 0) + ' the usual rate',
          detail: 'Ads deducted from payouts were ' + pct(share) + ' of menu value against a trailing ' + pct(trailing) + ' (' + periods.join(', ') + '): ' + inr(total) +
            ' more than the usual share. Only the deduction is visible in the statement; campaign performance stays in the partner dashboard.',
          metric: { label: 'Ads above the usual share', value: total, format: 'inr' }, impact: total });
      }
    });
    if (minor.length) {
      var sumMinor = minor.reduce(function (t, x) { return t + x.amount; }, 0), dishes = byId(MK.config.dishes), ms = audit.markupSummary;
      var attach = minor.filter(function (x) { return dishes[x.dishId] && dishes[x.dishId].isAttach; }).reduce(function (t, x) { return t + x.amount; }, 0);
      var top = minor.slice().sort(function (a, b) { return b.amount - a.amount; })[0], attachShare = sumMinor ? attach / sumMinor : 0;
      /* who carries the amount is computed, never assumed */
      var topIsAllAttach = !!(dishes[top.dishId] && dishes[top.dishId].isAttach) && attach === top.amount;   /* then the attach share is the same figure: say it once */
      var carrier = attachShare >= RULES.markup.attachMajorityShare ? ' Attach items carry ' + pct(attachShare, 0) + ' of it.'
        : (sumMinor ? ' ' + top.detail.split(':')[0] + (topIsAllAttach ? ', the attach item,' : '') + ' carries the most, ' + pct(top.amount / sumMinor, 0) + ' of it' +
          (attach && !topIsAllAttach ? '; attach items ' + pct(attachShare, 0) : '') + '.' : '');
      var wider = ms && ms.listings ? ' In all, ' + fmt.num(ms.belowBreakEven) + ' of ' + fmt.num(ms.listings) + ' dish listings realise less than the POS price once discounts and aggregator charges are taken (' +
        inr(ms.lostRealisation) + '); the markup that breaks even is ' + pct(ms.breakEvenMarkupPct.min, 0) + ' to ' + pct(ms.breakEvenMarkupPct.max, 0) + ' by outlet.' : '';
      c.push({ id: 'markup|others', severity: 'info', area: 'Revenue', unitId: null, route: '#/revenue/dishes', period: c.w.label,
        title: plural(minor.length, 'more item is', 'more items are') + ' listed on aggregators at a markup below the take rate',
        detail: listOf(minor.map(function (x) { return x.detail.split(':')[0]; }), 4) + ': the aggregator markup does not even cover the effective take rate, before any discount - ' +
          inr(sumMinor) + ' of realisation below the POS price over ' + c.w.label + '.' + carrier + wider,
        metric: { label: 'Realisation below POS price', value: sumMinor, format: 'inr' }, impact: sumMinor });
    }
  }

  function ruleBudget(c) {
    var month = c.w.completeMonth; if (!month) return;
    var cfg = MK.config, skip = {}, cats = {};
    RULES.budget.coveredElsewhere.forEach(function (id) { skip[id] = true; });
    c.unitIds.forEach(function (unitId) {
      (MK.finance.budget(month, unitId).rows || []).forEach(function (r) {
        if (skip[r.categoryId]) return;
        var base = Math.max(r.flexedPlan, r.comparedWith), over = r.used - base;
        if (over < RULES.budget.minOverrunPerLine || r.used < base * (1 + RULES.budget.overFlexedBy)) return;
        var g = cats[r.categoryId] || (cats[r.categoryId] = { id: r.categoryId, label: r.label, used: 0, plan: 0, over: 0, units: [] });
        g.used += r.used; g.plan += base; g.over += over; g.units.push({ unitId: unitId, over: over });
      });
    });
    var label = D.monthLabel(month, true), mi = cfg.months.indexOf(month);
    Object.keys(cats).map(function (k) { return cats[k]; }).filter(function (g) { return g.over >= RULES.budget.minOverrun; })
      .sort(function (a, b) { return b.over - a.over; }).slice(0, RULES.budget.maxInsights).forEach(function (g) {
        g.units.sort(function (a, b) { return b.over - a.over; });
        var why = '';
        if (g.id === 'gas_lpg') why = ' A commercial cylinder cost ' + fmt.inrFull(cfg.tariffs.lpgCylinder19kg[mi], 1) + ' in ' + label + ' against the ' + fmt.inrFull(cfg.tariffs.lpgBudgetReference, 1) + ' the budget was set on.';
        else {
          var oneOffs = [];
          g.units.forEach(function (u) { MK.finance.ledger({ unitId: u.unitId, monthKey: month, categoryId: g.id }).forEach(function (l) { if (l.component === 'one_off') oneOffs.push(l.note + ' at ' + unitName(l.unitId) + ' (' + inr(l.amount) + ')'); }); });
          if (oneOffs.length) why = ' Includes ' + oneOffs.join(', ') + '.';
        }
        c.push({ id: 'budget|' + g.id, severity: g.plan && g.used / g.plan >= RULES.budget.criticalRatio ? 'critical' : 'warning', area: 'Costs', unitId: g.units.length === 1 ? g.units[0].unitId : null,
          route: '#/costs/budget', period: label,
          title: g.label + ' is ' + pct(g.plan ? g.over / g.plan : 0, 0) + ' over budget in ' + label,
          detail: inr(g.used) + ' approved or in the pipeline against a plan of ' + inr(g.plan) + ' at ' + listOf(g.units.map(function (u) { return unitName(u.unitId); }), 3) +
            ': ' + inr(g.over) + ' over, after flexing variable lines for actual sales.' + why,
          metric: { label: 'Over plan', value: g.over, format: 'inr' }, impact: g.over });
      });
  }

  function ruleFactory(c) {
    if (!c.hasFactory) return;
    /* yield */
    var prod = MK.factory.production(c.fw, { grain: 'month' });
    (prod.yieldFlags || []).forEach(function (y) {
      var series = (prod.series || []).filter(function (s) { return s.sku === y.sku; })[0], low = null;
      if (series) series.yield.forEach(function (v, i) { if (v !== null && (low === null || v < series.yield[low])) low = i; });
      c.push({ id: 'yield|' + y.sku, severity: 'warning', area: 'Factory', unitId: 'factory', route: '#/factory/production', period: c.w.label,
        title: y.name + ' yield is ' + pct(y.actualYield) + ' against a standard of ' + pct(y.stdYield, 0),
        detail: pct(-y.yieldVariancePct) + ' below standard over ' + c.w.label + (low !== null ? ', lowest in ' + prod.buckets[low].label + ' at ' + pct(series.yield[low]) : '') + ': ' + inr(y.value) +
          ' of extra raw material at standard price. Check trimming, mincing loss and batch weights on this line.',
        metric: { label: 'Yield variance', value: y.value, format: 'inr' }, impact: y.value });
    });

    /* fill rate by supply pattern */
    var disp = MK.factory.dispatch(c.fw), daily = null;
    (disp.byRegion || []).forEach(function (r) { if (r.id === 'mumbai') daily = r; });
    (disp.outlets || []).forEach(function (o) {
      if (!o.alternateDaySupply || !daily || !o.indentKg || o.fillRate > daily.fillRate - RULES.fillRate.gapPts) return;
      var region = disp.byRegion.filter(function (r) { return r.id !== 'mumbai'; })[0], target = region ? region.target : null;
      var shortKg = o.indentKg - o.dispatchKg, value = Math.round(shortKg * (o.dispatchKg ? o.transferValue / o.dispatchKg : 0));
      var perKg = logisticsPerKg(c, o.id);
      c.push({ id: 'fill|' + o.id, severity: target && o.fillRate < target[0] ? 'warning' : 'info', area: 'Factory', unitId: o.id, route: '#/factory/production', period: c.w.label,
        title: 'Fill rate to ' + o.label + ' is ' + pct(o.fillRate) + ' against ' + pct(daily.fillRate) + ' for the daily-supplied outlets',
        detail: fmt.kg(shortKg) + ' of ' + fmt.kg(o.indentKg) + ' indented was not supplied on the alternate-day run (' + c.w.label + ', ' + plural(o.supplyDays, 'supply day', 'supply days') + ')' +
          (target ? '; the target band is ' + pct(target[0], 0) + ' to ' + pct(target[1], 0) : '') + '. About ' + inr(value) + ' of product at transfer price.' +
          (perKg ? ' Logistics cost ' + fmt.inrFull(perKg.outlet, 1) + ' per kg against ' + fmt.inrFull(perKg.others, 1) + ' for the other outlets.' : ''),
        metric: { label: 'Fill rate', value: o.fillRate, format: 'pct' }, impact: value });
    });

    /* purchase price variance over the latest months of the window */
    var months = c.w.months.slice(-RULES.ppv.months), rms = {};
    months.forEach(function (mk) {
      (MK.factory.purchases(mk).rows || []).forEach(function (r) {
        var g = rms[r.rmId] || (rms[r.rmId] = { id: r.rmId, name: r.name, unit: r.unit, std: r.stdPrice, ppv: 0, value: 0, price: r.price });
        g.ppv += r.ppv; g.value += r.value; if (r.qty) g.price = r.price;
      });
    });
    var span = months.length ? D.monthLabel(months[0]) + (months.length > 1 ? ' - ' + D.monthLabel(months[months.length - 1], true) : ' ' + months[0].slice(0, 4)) : '';
    Object.keys(rms).map(function (k) { var g = rms[k], atStd = g.value - g.ppv; g.share = atStd ? g.ppv / atStd : 0; return g; })
      .filter(function (g) { return Math.abs(g.ppv) >= RULES.ppv.minAmount && Math.abs(g.share) >= RULES.ppv.minPct; })
      .sort(function (a, b) { return Math.abs(b.ppv) - Math.abs(a.ppv); }).slice(0, RULES.ppv.maxInsights).forEach(function (g) {
      var share = g.share, fav = g.ppv < 0;
      c.push({ id: 'ppv|' + g.id, severity: fav ? 'good' : (g.ppv >= RULES.ppv.warnAmount ? 'warning' : 'info'), area: 'Factory', unitId: 'factory', route: '#/factory/inventory', period: span,
        title: g.name + ' is being bought ' + pct(Math.abs(share)) + (fav ? ' below' : ' above') + ' standard',
        detail: inr(Math.abs(g.ppv)) + (fav ? ' favourable' : ' unfavourable') + ' purchase-price variance over ' + span + ': latest price ' + fmt.inrFull(g.price) + ' per ' + g.unit + ' against a standard of ' + fmt.inrFull(g.std) +
          (fav ? '. The saving stays at the factory as over-absorption; transfer prices do not move.' : '. Outlets are still charged the standard transfer price, so the factory absorbs it.'),
        metric: { label: 'Purchase price variance', value: g.ppv, format: 'inr' }, impact: Math.abs(g.ppv) });
    });

    /* absorption */
    var VARIANCE_LABELS = { rmPrice: 'raw-material prices above standard', rmYield: 'yield below standard', wastageAndWriteOffs: 'wastage and write-offs', finishedStockBuild: 'finished stock built',
      labour: 'labour above standard', utilities: 'utilities above standard (gas and power)', overhead: 'overhead above standard', logistics: 'logistics not recovered' };
    (MK.factory.summary(c.fw).costMonths || []).forEach(function (m) {
      if (m.partial || m.absorptionPct > RULES.absorption.underPct) return;
      /* the two largest unfavourable lines of the variance analysis, so the sentence names the real drivers of the month */
      var v = MK.factory.pnl(m.monthKey).variance || {};
      var drivers = Object.keys(VARIANCE_LABELS).filter(function (k) { return v[k] < 0; }).sort(function (a, b) { return v[a] - v[b]; }).slice(0, 2)
        .map(function (k) { return VARIANCE_LABELS[k] + ' ' + inr(-v[k]); });
      c.push({ id: 'absorption|' + m.monthKey, severity: 'warning', area: 'Factory', unitId: 'factory', route: '#/factory/overview', period: m.label,
        title: 'Factory under-absorbed ' + inr(-m.absorption) + ' in ' + m.label,
        detail: 'Transfers of ' + inr(m.transferValue) + ' at standard cost did not cover raw materials of ' + inr(m.rmConsumed) + ' and conversion of ' + inr(m.conversion) + ': ' + pct(-m.absorptionPct) +
          ' of transfer value, at ' + fmt.inrFull(m.costPerKg, 1) + ' per kg.' + (drivers.length ? ' Largest drivers: ' + drivers.join('; ') + '.' : '') + ' The variance stays at the factory and lowers company EBITDA.',
        metric: { label: 'Under-absorption', value: -m.absorption, format: 'inr' }, impact: -m.absorption });
    });
  }

  /** Logistics allocation per kg dispatched for one outlet and for the other outlets in scope (whole months of the window), or null. */
  function logisticsPerKg(c, outletId) {
    var month = c.w.completeMonth; if (!month || c.outletIds.indexOf(outletId) === -1) return null;
    var range = { from: month + '-01', to: D.monthEnd(month + '-01') }, kg = {};
    (MK.factory.dispatch(range).outlets || []).forEach(function (o) { kg[o.id] = o.dispatchKg; });
    var mine = 0, rest = 0, restKg = 0;
    MK.finance.ledger({ unitIds: c.outletIds, monthKey: month, categoryId: 'logistics_allocation' }).forEach(function (l) {
      if (l.unitId === outletId) mine += l.amount; else { rest += l.amount; restKg += kg[l.unitId] || 0; }
    });
    return kg[outletId] && restKg ? { outlet: mine / kg[outletId], others: rest / restKg } : null;
  }

  function ruleApprovals(c) {
    var W = MK.workflow, today = MK.calendar.today;
    var queue = W.bill.list({ status: W.bill.PIPELINE_STATES }); if (!queue.length) return;
    var waiting = queue.filter(function (b) { return b.submittedAt && D.diffDays(b.submittedAt.slice(0, 10), today) >= RULES.approvals.waitDays; });
    if (waiting.length) {
      var oldest = waiting.slice().sort(function (a, b) { return a.submittedAt < b.submittedAt ? -1 : 1; })[0];
      var total = waiting.reduce(function (t, b) { return t + b.payable; }, 0);
      c.push({ id: 'approvals|waiting', severity: 'warning', area: 'Approvals', unitId: null, route: '#/approvals/bills', period: 'As of ' + D.label(today, 'd MMM yyyy'),
        title: plural(waiting.length, 'bill has', 'bills have') + ' waited ' + fmt.num(RULES.approvals.waitDays) + ' days or more for approval',
        detail: inr(total) + ' payable. The oldest is ' + oldest.number + ' from ' + W.vendor.nameOf(oldest.vendorId) + ' for ' + unitName(oldest.unitId) + ', submitted on ' + D.label(oldest.submittedAt.slice(0, 10), 'd MMM') +
          ' (' + plural(D.diffDays(oldest.submittedAt.slice(0, 10), today), 'day', 'days') + '). ' + plural(queue.length, 'bill is', 'bills are') + ' in the checker\'s queue in all.',
        metric: { label: 'Waiting for approval', value: total, format: 'inr' }, impact: total });
    }
    var dupes = queue.filter(function (b) { return b.flags && b.flags.indexOf('DUPLICATE_INVOICE') !== -1; });
    dupes.forEach(function (b) {
      var match = (W.bill.duplicateCheck(b).matches || []).filter(function (x) { return x.reason === 'SAME_INVOICE_NO'; })[0];
      c.push({ id: 'approvals|duplicate|' + b.id, severity: 'warning', area: 'Approvals', unitId: b.unitId, route: '#/approvals/bills', period: 'As of ' + D.label(today, 'd MMM yyyy'),
        title: b.number + ' repeats a vendor invoice number already in the books',
        detail: W.vendor.nameOf(b.vendorId) + ' invoice ' + b.invoiceNo + ' for ' + unitName(b.unitId) + ', ' + inr(b.payable) + ' payable' +
          (match ? ': the same invoice number is on ' + match.number + (match.inScope && match.status ? ' (' + W.labels.state[match.status].toLowerCase() + ')' : '') : '') + '. It cannot be approved without a note.',
        metric: { label: 'Possible double payment', value: b.payable, format: 'inr' }, impact: b.payable });
    });
    var pushers = queue.filter(function (b) { return dupes.indexOf(b) === -1; }).map(function (b) { return { bill: b, impact: W.bill.budgetImpact(b) }; })
      .filter(function (x) { return x.impact.available && x.impact.status === 'OVER'; });
    if (pushers.length) {
      pushers.sort(function (a, b) { return b.impact.amount - a.impact.amount; });
      var top = pushers[0], sumOver = pushers.reduce(function (t, x) { return t + x.impact.amount; }, 0), cat = byId(MK.config.expenseCategories)[top.bill.categoryId];
      c.push({ id: 'approvals|budget', severity: 'info', area: 'Approvals', unitId: pushers.length === 1 ? top.bill.unitId : null, route: '#/approvals/bills', period: 'As of ' + D.label(today, 'd MMM yyyy'),
        title: plural(pushers.length, 'bill in the queue takes', 'bills in the queue take') + ' a budget line over plan',
        detail: 'Largest: ' + top.bill.number + ' from ' + W.vendor.nameOf(top.bill.vendorId) + ', ' + inr(top.impact.amount) + ' including GST against ' + (cat ? cat.label.toLowerCase() : top.bill.categoryId) + ' at ' + unitName(top.bill.unitId) +
          ' for ' + D.monthLabel(top.impact.monthKey, true) + ': the line would stand at ' + inr(top.impact.afterThis) + ' against a plan of ' + inr(top.impact.budget) + '.',
        metric: { label: 'Bills over plan', value: sumOver, format: 'inr' }, impact: sumOver });
    }
  }

  function rulePayables(c) {
    var p = MK.finance.payables(); if (!p.overdue.count) return;
    var LATE = ['d8_30', 'd31_60', 'd60_plus'];
    var late = p.buckets.filter(function (b) { return LATE.indexOf(b.id) !== -1; }).reduce(function (t, b) { return t + b.amount; }, 0);
    var veryLate = p.buckets.filter(function (b) { return b.id === 'd31_60' || b.id === 'd60_plus'; }).reduce(function (t, b) { return t + b.amount; }, 0);
    var worst = p.byVendor.slice().sort(function (a, b) { return b.overdue - a.overdue; })[0];
    c.push({ id: 'payables|overdue', severity: veryLate > 0 ? 'critical' : 'warning', area: 'Approvals', unitId: null, route: '#/approvals/payables', period: 'As of ' + D.label(p.asOf, 'd MMM yyyy'),
      title: inr(p.overdue.amount) + ' of payables is past due',
      detail: plural(p.overdue.count, 'bill', 'bills') + ' out of open payables of ' + inr(p.total) + '; ' + inr(late) + ' is more than a week late. ' +
        (worst && worst.overdue ? 'Largest: ' + worst.name + ' with ' + inr(worst.overdue) + '. ' : '') + inr(p.dueIn7Days.amount) + ' more falls due in the coming week' +
        (p.inTransit && p.inTransit.count ? '; ' + inr(p.inTransit.amount) + ' already released to the bank is not counted as overdue' : '') + '.',
      metric: { label: 'Overdue payables', value: p.overdue.amount, format: 'inr' }, impact: p.overdue.amount });
  }

  function ruleBatches(c) {
    var W = MK.workflow, today = MK.calendar.today;
    W.batch.list({ status: ['PENDING_RELEASE', 'RELEASED'] }).forEach(function (p) {
      var bills = W.batch.bills(p.id), pastDue = bills.filter(function (b) { return b.dueDate < today; }).length, pending = p.status === 'PENDING_RELEASE';
      c.push({ id: 'batch|' + p.id, severity: pending ? 'warning' : 'info', area: 'Approvals', unitId: p.unitIds.length === 1 ? p.unitIds[0] : null, route: '#/approvals/payments',
        period: 'As of ' + D.label(today, 'd MMM yyyy'),
        title: pending ? 'Payment batch ' + p.number + ' awaits release: ' + inr(p.total) : 'Payment batch ' + p.number + ' is with the bank - UTRs not recorded yet',
        detail: plural(p.billIds.length, 'bill', 'bills') + ' for ' + listOf(p.unitIds.map(unitName), 3) + ', ' + (pending
          ? 'submitted by ' + userName(p.submittedBy) + ' on ' + D.label(p.submittedAt.slice(0, 10), 'd MMM') + '. Only the director can release it'
          : inr(p.total) + ' released by ' + userName(p.releasedBy) + ' on ' + D.label(p.releasedAt.slice(0, 10), 'd MMM') + '. The bills stay open until the payer records the bank references') +
          (pastDue ? '; ' + plural(pastDue, 'bill in it is', 'bills in it are') + ' already past due.' : '.'),
        metric: { label: pending ? 'Awaiting release' : 'Awaiting UTRs', value: p.total, format: 'inr' }, impact: p.total });
    });
  }

  function ruleVendors(c) {
    var W = MK.workflow;
    W.vendor.list({ state: ['NEEDS_REVIEW', 'VERIFYING'] }).forEach(function (v) {
      var open = W.bill.list({ vendorId: v.id, status: ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'] }), blocked = open.reduce(function (t, b) { return t + b.payable; }, 0);
      var last = v.history && v.history.length ? v.history[v.history.length - 1] : null, review = v.state === 'NEEDS_REVIEW';
      var reason = review && v.verification && v.verification.reasons.length ? v.verification.reasons[0] + ' (' + W.SIMULATED_NOTE.toLowerCase() + ')'
        : (last ? (W.labels.action[last.action] || last.action) + ' on ' + D.label(last.at.slice(0, 10), 'd MMM') + '; the verification has not been run yet' : 'Verification has not been run yet');
      c.push({ id: 'vendor|' + v.id, severity: review ? 'warning' : 'info', area: 'Vendors', unitId: null, route: '#/vendors', period: 'As of ' + D.label(MK.calendar.today, 'd MMM yyyy'),
        title: v.name + (review ? ' needs a decision before it can be paid' : ' is waiting for verification'),
        detail: reason + '. ' + (open.length ? plural(open.length, 'open bill', 'open bills') + ' worth ' + inr(blocked) + ' cannot be approved or paid until the vendor is approved again.'
          : 'No open bills are held up yet.'),
        metric: { label: 'Bills held up', value: blocked, format: 'inr' }, impact: blocked });
    });
  }

  var RULE_LIST = [ruleFoodCost, ruleTakeRate, ruleUnderUse, ruleRampAndMargin, ruleRent, ruleAuditFlags, ruleBudget, ruleFactory, ruleApprovals, rulePayables, ruleBatches, ruleVendors];

  /* ---------------------------------------------------------------------- API */

  function list(f) {
    if (!MK.config || !MK.data || !MK.data.summary) return [];
    f = f || {};
    var allowedUnits = MK.session.allowedUnitIds(), allowedOutlets = MK.session.allowedOutletIds();
    var wanted = Array.isArray(f.outletIds) && f.outletIds.length ? f.outletIds : null;
    var outletIds = allowedOutlets.filter(function (id) { return !wanted || wanted.indexOf(id) !== -1; });
    syncThresholds();
    var w = windowOf(f), out = [];
    var c = {
      f: f, w: w, fw: { from: w.from, to: w.to, outletIds: f.outletIds || null, channelIds: f.channelIds || null, mediumIds: f.mediumIds || null },
      outletIds: outletIds,
      /* cost units: the outlets asked for, plus the factory and head office when no outlet filter narrows the view */
      unitIds: wanted ? outletIds : allowedUnits,
      hasFactory: !wanted && allowedUnits.indexOf('factory') !== -1,
      push: function (x) { x.impact = Math.round(x.impact || 0); x.rule = familyOf(x.id); out.push(x); }
    };
    RULE_LIST.forEach(function (rule) {
      if ((rule === ruleApprovals || rule === rulePayables || rule === ruleBatches || rule === ruleVendors) && !MK.workflow) return;
      if ((rule === ruleFoodCost || rule === ruleRampAndMargin || rule === ruleRent || rule === ruleBudget) && !MK.finance) return;
      if (rule === ruleFactory && !MK.factory) return;
      try { rule(c); } catch (e) { if (root.console) root.console.error('[MK.insights] ' + (rule.name || 'rule') + ' failed', e); }
    });
    return out.sort(function (a, b) {
      var s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      return s !== 0 ? s : (b.impact !== a.impact ? b.impact - a.impact : (a.id < b.id ? -1 : 1));
    });
  }

  syncThresholds();

  MK.insights = {
    RULES: RULES,
    DEFAULTS: DEFAULTS,
    THRESHOLDS: THRESHOLDS,
    FAMILIES: FAMILIES,
    SEVERITIES: ['critical', 'warning', 'info', 'good'],
    AREAS: ['Revenue', 'Costs', 'Approvals', 'Factory', 'Vendors'],
    list: list,
    catalogue: catalogue,
    setThreshold: setThreshold,
    resetThresholds: resetThresholds,
    /** The dials in force: [{ ref, label, value, defaultValue, isDefault, ... }]. */
    thresholds: function () { return THRESHOLDS.map(thresholdState); },
    /** The evaluation window a filter resolves to: { from, to, label, months, completeMonth }. */
    window: function (f) {
      if (!MK.config) return { from: null, to: null, label: '', months: [], monthFrom: null, monthTo: null, completeMonth: null, filterFrom: null };
      return windowOf(f || {});
    },
    /** Counts by severity for a badge: { critical, warning, info, good, total }. */
    counts: function (f) {
      var n = { critical: 0, warning: 0, info: 0, good: 0, total: 0 };
      list(f).forEach(function (x) { n[x.severity]++; n.total++; });
      return n;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.MK;
})(typeof window !== 'undefined' ? window : globalThis);
