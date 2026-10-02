/*
 * #/costs/unit-economics - Unit economics by outlet, factory, head office and company (client brief area 2).
 *
 * Costs are booked by whole month, so the page works in months: the global date filter decides which month(s) are
 * shown (the months its range touches; the running month is month to date with fixed costs accrued pro rata), and a
 * page-local quick switch (ctx.state) flips to any other month of the data.
 *
 * Blocks, in reading order:
 *   header      unit tabs (limited to the persona's scope), month switch, period label, notes on estimates
 *   outlets /   KPI tiles -> P&L waterfall -> side-by-side outlet comparison (the decision view, heat per row) ->
 *   company     per-order economics (overall and by stream) -> EBITDA % trend and run-rate vs break-even -> full P&L
 *   factory     cost-centre view on transfer value: KPI tiles per kg -> bridge to absorption -> variance and trend -> cost lines
 *   head office cost-centre view: KPI tiles -> cost lines and monthly cost -> cost lines table
 *
 * Every figure comes from MK.finance / MK.factory and is formatted with MK.fmt; sentences are composed from those
 * values. Aggregator costs that are not from a settled statement are shown apart and carry the estimate badge.
 * Role scope is applied by the data layer; the page only decides which blocks make sense for what it receives.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;

  /* ------------------------------------------------------------------ layout constants (pixels and UI rules, never data) */

  var COMPANY = 'all';
  var RANGE = 'range';
  var H_WATERFALL = 300;
  var H_CHART = 280;
  var SEQ_STEPS = ['--seq-100', '--seq-150', '--seq-200', '--seq-250', '--seq-300', '--seq-350', '--seq-400', '--seq-450', '--seq-500', '--seq-550'];
  var SEQ_DARK_FROM = 8;               /* from --seq-500 the ink switches to the surface colour (same rule as MK.ui.cells.heat) */
  var DIV_STEPS = ['--div-neg-2', '--div-neg-1', '--div-mid', '--div-pos-1', '--div-pos-2'];
  var MIN_SPREAD = 0.04;               /* a row whose outlets sit closer together than this stays pale: small differences must not shout */
  var MIN_SPREAD_MONEY = 0.15;         /* same idea for rupee rows, as a share of the row maximum */
  var DEFAULT_OPEN = { cogs: true, channel: true, occupancy: true };
  var MAX_STANDOUTS = 5;               /* items in the 'what stands out' strip - one row of cards */
  var GROUP_STEP_LABELS = { people: 'People', occupancy: 'Occupancy', utilities: 'Utilities', operations: 'Operations', marketing: 'Marketing', logistics: 'Logistics', admin: 'Admin' };
  /* what a category holds where the ledger line does not say (docs/RESEARCH.md cost table); words only, never figures */
  var LINE_GLOSS = { housekeeping: 'Tissue paper, cleaning chemicals, gloves, foil and garbage bags' };
  var VARIANCE_LABELS = {
    rmPrice: 'Raw-material prices', rmYield: 'Yield against standard', wastageAndWriteOffs: 'Wastage and write-offs', finishedStockBuild: 'Finished stock build',
    labour: 'Labour', utilities: 'Utilities', overhead: 'Overhead', logistics: 'Logistics', other: 'Rounding and other'
  };

  /* ------------------------------------------------------------------ small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v) { return isNum(v) ? v : 0; }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function andList(items) {
    var list = (items || []).filter(Boolean);
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''; }

  function rangeLabel(from, to) {
    if (!from || !to) return '';
    if (from === to) return MK.dates.label(from, 'd MMM yyyy');
    var sameYear = from.slice(0, 4) === to.slice(0, 4);
    return MK.dates.label(from, sameYear ? 'd MMM' : 'd MMM yyyy') + ' - ' + MK.dates.label(to, 'd MMM yyyy');
  }

  function monthsLabel(keys, withYear) {
    if (!keys || !keys.length) return '';
    if (keys.length === 1) return MK.dates.monthLabel(keys[0], withYear);
    return MK.dates.monthLabel(keys[0], false) + ' - ' + MK.dates.monthLabel(keys[keys.length - 1], withYear);
  }

  /** A change too small to show reads as a plain zero, never as "-0.0". */
  function tidy(delta, zeroLabel) {
    if (!delta || delta.value === null || delta.value === undefined) return null;
    if (delta.dir !== 'flat') return delta;
    return { value: delta.value, label: zeroLabel, dir: 'flat' };
  }
  function pointsDelta(cur, prev) { return isNum(cur) && isNum(prev) ? tidy(fmt.points(cur, prev), fmt.num(0, 1) + ' pts') : null; }
  function pctDelta(cur, prev) { return isNum(cur) && isNum(prev) && prev ? tidy(fmt.delta(cur, prev), fmt.pct(0)) : null; }

  function rupees(v) { return isNum(v) ? fmt.inrFull(Math.round(v)) : '-'; }

  function lineOf(p, key) {
    var lines = (p && p.lines) || [];
    for (var i = 0; i < lines.length; i++) if (lines[i].key === key) return lines[i];
    return null;
  }
  function groupOf(p, id) {
    var groups = (p && p.groups) || [];
    for (var i = 0; i < groups.length; i++) if (groups[i].id === id) return groups[i];
    return null;
  }
  function amountOf(item) { return item ? num(item.amount) : 0; }
  function pctOf(item) { return item && isNum(item.pctOfSales) ? item.pctOfSales : null; }

  /** The aggregators' own lines of the channel group (card MDR is a channel cost but not an aggregator cost). */
  function aggregatorOf(p) {
    var amount = 0, est = 0;
    ((p && p.lines) || []).forEach(function (l) {
      if (l.group !== 'channel' || !/^agg_/.test(l.key)) return;
      amount += num(l.amount);
      est += num(l.estimatedPart);
    });
    var ns = p && p.totals ? num(p.totals.netSales) : 0;
    return { amount: amount, estimatedPart: est, pct: ns > 0 ? amount / ns : null, estimatedPct: ns > 0 ? est / ns : null };
  }

  function sourceIds(p, withSales, estimated) {
    var s = (p && p.sources) || {};
    var ids = [s.costs || 'erp'];
    if (!withSales) return ids;
    ids.push('petpooja');
    (s.aggregatorActual || ['swiggy_annexure', 'zomato_settlement']).forEach(function (id) { ids.push(id); });
    if (estimated) ids.push(s.aggregatorEstimated || 'estimate');
    return ids;
  }

  function sourceEnd(ids) {
    var tag = ui.sourceTag(ids);
    tag.classList.add('ue-source-end');
    return tag;
  }

  function categoryNote(id) {
    var list = (MK.config && MK.config.expenseCategories) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].note || '';
    return '';
  }

  function estimateCaption() {
    var s = MK.config && MK.config.sources && MK.config.sources.estimate;
    return s ? s.caption : 'Estimated at contracted rates';
  }

  function note(text, iconName, extra) {
    return h('p', { 'class': 'ue-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, text), extra || null);
  }

  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[costs-unit-economics] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  function call(fn, fallback) {
    try { var v = fn(); return v === undefined ? fallback : v; } catch (e) {
      if (root.console) root.console.error('[costs-unit-economics] data call failed', e);
      return fallback;
    }
  }

  /* ------------------------------------------------------------------ units, months, period */

  function unitOptions() {
    var allowed = MK.session.allowedUnitIds();
    var defs = (MK.config && MK.config.outlets) || [];
    var list = defs.filter(function (d) { return allowed.indexOf(d.id) !== -1; }).map(function (d) {
      return { id: d.id, label: d.short || d.name, name: d.name, type: d.type, colourVar: d.colourVar, city: d.city, area: d.area, sqft: d.sqft, seats: d.seats, openedOn: d.openedOn };
    });
    if (MK.session.seesAllUnits && MK.session.seesAllUnits()) list.push({ id: COMPANY, label: 'Company', name: 'Company', type: 'company' });
    return list;
  }

  function monthName(row) { return MK.dates.monthLabel(row.monthKey, false) + (row.partial ? ' MTD' : ''); }

  /** Months of the data touched by the global date filter. */
  function touchedMonths(f, monthRows) {
    var keys = monthRows.map(function (r) { return r.monthKey; });
    var from = f && f.from ? f.from.slice(0, 7) : keys[0];
    var to = f && f.to ? f.to.slice(0, 7) : keys[keys.length - 1];
    var hit = keys.filter(function (k) { return k >= from && k <= to; });
    return hit.length ? hit : [keys[keys.length - 1]];
  }

  function filterIsWholeMonths(f) {
    if (!f || !f.from || !f.to) return true;
    var dataEnd = MK.calendar && MK.calendar.dataEnd;
    return f.from === MK.dates.monthStart(f.from) && (f.to === MK.dates.monthEnd(f.to) || f.to === dataEnd);
  }

  function periodArg(keys) { return keys.length === 1 ? keys[0] : { from: keys[0], to: keys[keys.length - 1] }; }

  function shortPeriod(period) {
    if (!period) return '';
    if (period.months && period.months.length === 1 && period.partial) return rangeLabel(period.from, period.to) + ', month to date';
    return period.label || '';
  }

  /* ------------------------------------------------------------------ header: purpose, unit tabs, month switch, notes */

  function header(env) {
    var st = env.st, ctx = env.ctx, p = env.pnl;
    var box = h('section', { 'class': 'ue-head' });

    box.appendChild(h('p', { 'class': 'ue-intro' },
      'What each unit earns and what it costs to run: a monthly P&L for every outlet, the factory and head office, side by side, per order and per square foot.'));

    if (env.units.length > 1) {
      box.appendChild(ui.tabs({ ariaLabel: 'Unit', value: env.unit.id,
        items: env.units.map(function (u) { return { id: u.id, label: u.label }; }),
        onChange: function (id) { st.unit = id; ctx.rerender(); } }));
    } else {
      box.appendChild(h('div', { 'class': 'ue-locked' },
        ui.chip(env.unit.name, 'neutral', { icon: 'lock', dotVar: env.unit.colourVar }),
        h('span', { 'class': 'mk-muted mk-small' }, (ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel : 'Your role') + ' sees this unit only; every figure below is limited to it.')));
    }

    var options = env.monthRows.map(function (r) { return { value: r.monthKey, label: monthName(r) }; });
    if (env.touched.length > 1) options.push({ value: RANGE, label: monthsLabel(env.touched, false) });
    var bar = h('div', { 'class': 'ue-period' },
      h('div', { 'class': 'ue-period__switch' },
        h('span', { 'class': 'mk-label', id: 'ue-month-label' }, 'Month'),
        ui.segmented({ ariaLabel: 'Month', size: 'sm', value: env.sel, options: options, onChange: function (v) { st.period = v; ctx.rerender(); } })),
      h('div', { 'class': 'ue-period__label' }, ui.icon('calendar', 14), h('span', { 'class': 'mk-muted' }, 'Period'), h('strong', null, p.period && p.period.label ? p.period.label : '-')));
    box.appendChild(bar);

    var notes = h('div', { 'class': 'ue-notes' });
    if (p.period && p.period.partial && p.period.note) notes.appendChild(note(p.period.note + '.', 'clock'));
    var f = ctx.filters || {};
    if (env.overridden) {
      notes.appendChild(note('Quick switch: showing ' + monthsLabel(env.keys, true) + ', while the date filter covers ' + rangeLabel(f.from, f.to) + '.', 'calendar',
        ui.button({ label: 'Back to the filter period', variant: 'text', size: 'sm', onClick: function () { st.period = null; ctx.rerender(); } })));
    } else if (!filterIsWholeMonths(f)) {
      notes.appendChild(note('Costs are reported by whole month: the date filter (' + rangeLabel(f.from, f.to) + ') touches ' + monthsLabel(env.touched, true) + ', shown here in full' +
        (p.period && p.period.partial ? ' to date.' : '.'), 'calendar'));
    }
    var est = p.totals ? num(p.totals.estimatedPart) : 0;
    if (est > 0) {
      notes.appendChild(h('p', { 'class': 'ue-note' }, ui.estimateBadge(),
        h('span', null, fmt.inr(est) + ' of the ' + fmt.inr(num(p.totals.channelCosts)) + ' channel costs in this period belongs to aggregator weeks without a statement yet: estimated at contracted (assumed) rates and shown apart wherever it appears.')));
    }
    if (notes.childNodes.length) box.appendChild(notes);

    var descr = unitDescription(env);
    if (descr) box.appendChild(descr);
    return box;
  }

  function unitDescription(env) {
    var u = env.unit, parts = [];
    if (env.isCompany) {
      parts.push('the five outlets at transfer prices, plus the factory\'s under or over absorption and head office.');
    } else if (env.isFactory) {
      parts.push('cost centre. The central kitchen has no customers: its income is the transfer value of what it dispatches to the outlets, so ratios use transfer value and the result is over or under absorption.');
    } else if (env.isHo) {
      parts.push('cost centre. No sales, so there are no sales ratios - only what it costs and how that moves.');
    } else {
      if (u.area || u.city) parts.push([u.area, u.city].filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(', '));
      if (isNum(u.sqft) && u.sqft > 0) parts.push(fmt.num(u.sqft) + ' sq ft');
      if (isNum(u.seats) && u.seats > 0) parts.push(fmt.num(u.seats) + ' seats');
      if (u.openedOn) parts.push('opened ' + MK.dates.label(u.openedOn, 'd MMM yyyy'));
    }
    if (!parts.length) return null;
    return h('p', { 'class': 'ue-unitline' },
      u.colourVar && !env.isCompany ? h('span', { 'class': 'mk-legend-dot', style: { background: 'var(' + u.colourVar + ')' } }) : null,
      h('strong', null, u.name), h('span', { 'class': 'mk-muted' }, '- ' + parts.join(' - ')));
  }

  /* ------------------------------------------------------------------ KPI tiles */

  function tileGrid(tiles, ids) {
    var wrap = h('div', { 'class': 'ue-kpiblock' });
    wrap.appendChild(h('div', { 'class': 'ue-kpis' }, tiles.filter(Boolean).map(function (t) { return ui.statTile(t); })));
    var tag = ui.sourceTag(ids);
    tag.classList.add('ue-source-flat');
    wrap.appendChild(tag);
    return wrap;
  }

  function outletTiles(env) {
    var p = env.pnl, t = p.totals, prev = p.prev, pp = env.prevPnl, ue = env.ue || {};
    var partial = !!(p.period && p.period.partial);
    var vs = env.prevShort ? 'vs ' + env.prevShort : '';
    var agg = aggregatorOf(p), aggPrev = pp ? aggregatorOf(pp) : null;
    var people = groupOf(p, 'people'), occupancy = groupOf(p, 'occupancy');
    var be = ue.breakEven, sq = ue.perSqft;
    var tiles = [];

    tiles.push({ label: 'Net sales', icon: 'coins', value: fmt.inr(t.netSales),
      delta: !partial && prev ? pctDelta(t.netSales, prev.netSales) : null, deltaNote: vs,
      sub: partial && be && isNum(be.netSalesRunRatePerMonth) ? 'Run-rate ' + fmt.inr(be.netSalesRunRatePerMonth) + ' a month' : fmt.num(t.orders) + ' orders',
      title: 'Net of GST and restaurant-funded discounts' });

    tiles.push({ label: 'Gross margin', value: fmt.pct(t.grossMarginPct),
      delta: prev ? pointsDelta(t.grossMarginPct, prev.grossMarginPct) : null, deltaNote: vs,
      sub: 'Food cost ' + fmt.pct(t.foodCostPct), title: 'Net sales less food cost and packaging' });

    tiles.push({ label: 'Aggregator costs, % of sales', value: fmt.pct(agg.pct), goodWhen: 'down',
      delta: aggPrev ? pointsDelta(agg.pct, aggPrev.pct) : null, deltaNote: vs,
      sub: agg.estimatedPart > 0 ? [ui.estimateBadge(), ' ' + fmt.inr(agg.estimatedPart) + ' of ' + fmt.inr(agg.amount)] : fmt.inr(agg.amount) + ' from statements',
      title: 'Service fees, collection fees, GST on fees, ads, refunds and other deductions of Swiggy and Zomato, against total net sales. Card MDR is left out: it is a channel cost but not an aggregator charge, and it has its own line in the channel costs group.' });

    tiles.push({ label: 'People, % of sales', value: fmt.pct(pctOf(people)), goodWhen: 'down',
      delta: pp ? pointsDelta(pctOf(people), pctOf(groupOf(pp, 'people'))) : null, deltaNote: vs, sub: fmt.inr(amountOf(people)) });

    tiles.push({ label: 'Occupancy, % of sales', value: fmt.pct(pctOf(occupancy)), goodWhen: 'down',
      delta: pp ? pointsDelta(pctOf(occupancy), pctOf(groupOf(pp, 'occupancy'))) : null, deltaNote: vs,
      /* rent per sq ft only where the two sides match: the company figure carries head-office rent over the outlets' floor area */
      sub: env.isOutlet && sq && isNum(sq.rentPerSqftPerMonth) && sq.sqft > 0 ? 'Rent ' + rupees(sq.rentPerSqftPerMonth) + ' per sq ft a month' : fmt.inr(amountOf(occupancy)) + ' of rent, its GST and society charges',
      title: 'Rent, the non-creditable GST on rent and society charges' });

    tiles.push({ label: 'EBITDA', value: fmt.inr(t.ebitda), tone: t.ebitda < 0 ? 'critical' : null,
      delta: prev ? pointsDelta(t.ebitdaPct, prev.ebitdaPct) : null, deltaNote: vs, sub: fmt.pct(t.ebitdaPct) + ' of net sales' });

    if (env.isCompany) {
      tiles.push({ label: 'Head office', value: fmt.inr(num(t.headOffice)), goodWhen: 'down',
        sub: t.netSales > 0 ? fmt.pct(num(t.headOffice) / t.netSales) + ' of net sales' : null, title: 'Cost of the head-office cost centre in this period' });
      var abs = num(t.factoryAbsorption);
      tiles.push({ label: abs < 0 ? 'Factory under-absorption' : 'Factory over-absorption', value: fmt.inr(Math.abs(abs)), tone: abs < 0 ? 'warn' : null,
        sub: isNum(t.transferValue) && t.transferValue > 0 ? fmt.pct(Math.abs(abs) / t.transferValue) + ' of transfer value' : null,
        title: 'Transfer value and logistics recovered, less what the factory actually cost' });
    } else {
      if (be && isNum(be.breakEvenSalesPerMonth)) {
        var mos = be.marginOfSafetyPct;
        tiles.push({ label: 'Break-even sales a month', value: fmt.inr(be.breakEvenSalesPerMonth), tone: isNum(mos) && mos < 0 ? 'critical' : null,
          sub: isNum(mos) ? (mos >= 0 ? 'Margin of safety ' + fmt.pct(mos) : 'Run-rate is ' + fmt.pct(-mos) + ' short of it') : null,
          title: 'Fixed costs of a full month (' + fmt.inr(be.fixedCostsPerMonth) + ') divided by the contribution margin (' + fmt.pct(be.contributionMarginPct) + ')' });
      }
      if (sq && sq.sqft > 0) {
        tiles.push({ label: 'EBITDA per sq ft a month', value: rupees(sq.ebitdaPerSqftPerMonth), tone: sq.ebitdaPerSqftPerMonth < 0 ? 'critical' : null,
          sub: 'Sales ' + rupees(sq.netSalesPerSqftPerMonth) + ' per sq ft on ' + fmt.num(sq.sqft) + ' sq ft',
          title: partial ? 'Month-to-date figures are scaled to a full month' : '' });
      }
    }
    return tileGrid(tiles, sourceIds(p, true, num(t.estimatedPart) > 0));
  }

  function factoryTiles(env) {
    var p = env.pnl, t = p.totals, prev = p.prev, ue = env.ue || {}, kg = ue.perKg || {};
    var partial = !!(p.period && p.period.partial);
    var vs = env.prevShort ? 'vs ' + env.prevShort : '';
    var fp = env.factoryPnl, costing = env.costing;
    var rm = lineOf(p, 'raw_materials');
    var prevKg = (env.prevUe && env.prevUe.perKg) || null;   /* per-kg moves are compared per kg, never in points of another base */
    var tiles = [];

    tiles.push({ label: 'Transfer value', icon: 'truck', value: fmt.inr(num(t.transferValue)),
      delta: !partial && prev ? pctDelta(t.transferValue, prev.transferValue) : null, deltaNote: vs,
      sub: partial ? 'Dispatches at transfer price, to date' : null, title: 'What the outlets were charged for the products dispatched to them' });
    tiles.push({ label: 'Dispatched', value: isNum(kg.dispatchKg) ? fmt.kg(kg.dispatchKg) : '-', sub: isNum(kg.transferValue) ? rupees(kg.transferValue) + ' transfer value per kg' : null });
    tiles.push({ label: 'Raw materials per kg', value: rupees(kg.rawMaterials), goodWhen: 'down',
      delta: prevKg ? pctDelta(kg.rawMaterials, prevKg.rawMaterials) : null, deltaNote: vs,
      sub: isNum(pctOf(rm)) ? fmt.pct(pctOf(rm)) + ' of transfer value' : null });
    tiles.push({ label: 'Conversion cost per kg', value: rupees(kg.conversion), goodWhen: 'down',
      delta: prevKg ? pctDelta(kg.conversion, prevKg.conversion) : null, deltaNote: vs,
      sub: costing && isNum(costing.stdConversionPerKg) ? 'Standard ' + rupees(costing.stdConversionPerKg) + ' per kg' : null, title: 'Labour, utilities and overhead per kg dispatched' });
    tiles.push({ label: 'Logistics per kg', value: rupees(kg.logistics), sub: 'Recovered from the outlets: ' + fmt.inr(num(t.logisticsRecovery)) });
    tiles.push({ label: t.ebitda < 0 ? 'Under-absorption' : 'Over-absorption', value: fmt.inr(Math.abs(num(t.ebitda))), tone: t.ebitda < 0 ? 'warn' : 'good',
      delta: prev ? pointsDelta(t.ebitdaPct, prev.ebitdaPct) : null, deltaNote: vs,
      sub: fmt.pct(Math.abs(num(t.ebitdaPct))) + ' of transfer value', title: 'Transfer value and logistics recovered, less raw materials, conversion and logistics costs' });
    tiles.push({ label: 'Absorption per kg', value: rupees(kg.absorption), sub: 'Below zero means the outlets were charged less than the cost' });
    if (fp && isNum(fp.factoryCostPctOfNetworkSales) && env.keys.length === 1) {
      tiles.push({ label: 'Factory cost, % of network sales', value: fmt.pct(fp.factoryCostPctOfNetworkSales),
        sub: isNum(fp.transferValuePctOfNetworkSales) ? 'Transfer value ' + fmt.pct(fp.transferValuePctOfNetworkSales) + ' of network sales' : null,
        title: 'Conversion, logistics and depreciation against the net sales of the five outlets' });
    } else {
      tiles.push({ label: 'Depreciation', value: fmt.inr(num(t.depreciation)), sub: 'Below the absorption line' });
    }
    return tileGrid(tiles, sourceIds(p, false));
  }

  function hoTiles(env) {
    var p = env.pnl, t = p.totals, prev = p.prev, pp = env.prevPnl;
    var partial = !!(p.period && p.period.partial);
    var vs = env.prevShort ? 'vs ' + env.prevShort : '';
    var total = num(t.opex) + num(t.depreciation);
    var tiles = [{ label: 'Head-office cost', icon: 'building', value: fmt.inr(total), goodWhen: 'down',
      delta: !partial && prev ? pctDelta(total, num(prev.opex) + num(prev.depreciation)) : null, deltaNote: vs,
      sub: partial ? 'Accrued pro rata, month to date' : null }];
    (p.groups || []).forEach(function (g) {
      tiles.push({ label: g.label, value: fmt.inr(g.amount), goodWhen: 'down',
        delta: !partial && pp ? pctDelta(g.amount, amountOf(groupOf(pp, g.id))) : null, deltaNote: vs,
        sub: total > 0 ? fmt.pct(g.amount / total) + ' of head-office cost' : null });
    });
    return tileGrid(tiles, sourceIds(p, false));
  }

  /* ------------------------------------------------------------------ P&L waterfall */

  function bridgeTable(steps, base, baseLabel) {
    return {
      columns: [{ key: 'label', label: 'Line' }, { key: 'amount', label: 'Amount', format: 'inrFull', align: 'right' },
        { key: 'pct', label: baseLabel, format: 'pct', align: 'right' }],
      rows: steps.map(function (s) { return { label: s.label, amount: s.kind === 'minus' ? -s.value : s.value, pct: base > 0 ? (s.kind === 'minus' ? -s.value : s.value) / base : null }; })
    };
  }

  function outletWaterfall(env) {
    var p = env.pnl, t = p.totals;
    if (!(t.netSales > 0)) return ui.card({ title: 'Net sales to EBITDA', body: ui.emptyState('No sales in this period', 'There is nothing to bridge for ' + env.unit.name + ' in ' + shortPeriod(p.period) + '.', { compact: true }) });
    var agg = aggregatorOf(p);
    var settled = agg.amount - agg.estimatedPart;
    var pack = amountOf(lineOf(p, 'packaging'));
    var people = amountOf(groupOf(p, 'people')), occ = amountOf(groupOf(p, 'occupancy')), util = amountOf(groupOf(p, 'utilities'));
    var fac = env.isCompany ? amountOf(groupOf(p, 'factory')) : 0;
    var other = t.netSales - t.ebitda - (t.foodCost + pack + agg.amount + people + occ + util + fac);

    var steps = [{ label: 'Net sales', value: t.netSales, kind: 'total' },
      { label: 'Food cost', value: t.foodCost, kind: 'minus' },
      { label: 'Packaging', value: pack, kind: 'minus' }];
    if (agg.estimatedPart > 0) {
      /* two short words per step: a ten-step bridge only wraps its labels while no word is wider than its band */
      steps.push({ label: 'Aggregator fees', value: settled, kind: 'minus' });
      steps.push({ label: 'Estimated fees', value: agg.estimatedPart, kind: 'minus' });
    } else {
      steps.push({ label: 'Aggregator costs', value: agg.amount, kind: 'minus' });
    }
    steps.push({ label: 'People', value: people, kind: 'minus' });
    steps.push({ label: 'Occupancy', value: occ, kind: 'minus' });
    steps.push({ label: 'Utilities', value: util, kind: 'minus' });
    steps.push({ label: 'Other costs', value: Math.abs(other), kind: other >= 0 ? 'minus' : 'plus' });
    if (env.isCompany && fac !== 0) steps.push({ label: 'Factory absorption', value: Math.abs(fac), kind: fac > 0 ? 'minus' : 'plus' });
    steps.push({ label: 'EBITDA', value: t.ebitda, kind: 'total' });

    var bites = [{ name: 'food cost', v: t.foodCost }, { name: 'aggregators', v: agg.amount }, { name: 'people', v: people }, { name: 'occupancy', v: occ },
      { name: 'utilities', v: util }].sort(function (a, b) { return b.v - a.v; });
    var subtitle = env.unit.name + ', ' + shortPeriod(p.period) + ': ' + bites[0].name + ' takes ' + fmt.pct(bites[0].v / t.netSales) + ' of net sales and ' + bites[1].name + ' ' +
      fmt.pct(bites[1].v / t.netSales) + '; ' + (t.ebitda >= 0 ? fmt.inr(t.ebitda) + ' is left as EBITDA (' + fmt.pct(t.ebitdaPct) + ').' : 'the period closes ' + fmt.inr(-t.ebitda) + ' below break-even (' + fmt.pct(t.ebitdaPct) + ').');

    var chart = MK.charts.mount(null, {
      id: 'ue-waterfall', kind: 'waterfall', format: 'inr', height: H_WATERFALL,
      title: 'Net sales to EBITDA', subtitle: subtitle,
      data: { steps: steps, kindLabels: { total: 'Subtotal', minus: 'Cost', plus: 'Credit' }, stepHeader: 'Line' },
      table: bridgeTable(steps, t.netSales, '% of net sales'),
      note: 'Aggregator fees: service and collection fees, GST on them, ads, refunds and other deductions of Swiggy and Zomato. Other costs: operations (housekeeping and consumables, repairs, pest control, POS, licences), local marketing, factory logistics and card MDR' +
        (env.isCompany ? ', plus head-office administration' : '') + '.' +
        (agg.estimatedPart > 0 ? ' The estimated step is the aggregator charge of the weeks that have no statement yet: ' + lowerFirst(estimateCaption()) + '.' : '')
    });
    chart.el.appendChild(sourceEnd(sourceIds(p, true, agg.estimatedPart > 0)));
    return chart.el;
  }

  function factoryWaterfall(env) {
    var p = env.pnl, t = p.totals;
    var tv = num(t.transferValue), lr = num(t.logisticsRecovery);
    if (!(tv > 0)) return ui.card({ title: 'Transfer value to absorption', body: ui.emptyState('Nothing dispatched in this period', null, { compact: true }) });
    var steps = [{ label: 'Transfer value', value: tv, kind: 'total' }, { label: 'Logistics recovered', value: lr, kind: 'plus' }];
    var listed = 0;
    (p.groups || []).forEach(function (g) {
      if (g.id === 'below_ebitda') return;
      if (g.id === 'cogs') {
        (p.lines || []).forEach(function (l) {
          if (l.group !== 'cogs') return;
          steps.push({ label: l.key === 'production_consumables' ? 'Consumables' : l.label, value: num(l.amount), kind: 'minus' });
          listed += num(l.amount);
        });
        return;
      }
      steps.push({ label: GROUP_STEP_LABELS[g.id] || g.label, value: num(g.amount), kind: 'minus' });
      listed += num(g.amount);
    });
    var residual = tv + lr - listed - num(t.ebitda);
    if (Math.abs(residual) >= 1) steps.push({ label: 'Other', value: Math.abs(residual), kind: residual > 0 ? 'minus' : 'plus' });
    steps.push({ label: 'Absorption', value: num(t.ebitda), kind: 'total' });

    var rm = lineOf(p, 'raw_materials');
    var subtitle = shortPeriod(p.period) + ': raw materials take ' + fmt.pct(pctOf(rm)) + ' of transfer value; after conversion and logistics the factory ' +
      (t.ebitda < 0 ? 'under-absorbs ' : 'over-absorbs ') + fmt.inr(Math.abs(num(t.ebitda))) + ' (' + fmt.pct(Math.abs(num(t.ebitdaPct))) + ' of transfer value).';
    var chart = MK.charts.mount(null, {
      id: 'ue-waterfall-factory', kind: 'waterfall', format: 'inr', height: H_WATERFALL,
      title: 'Transfer value to absorption', subtitle: subtitle,
      data: { steps: steps, kindLabels: { total: 'Subtotal', minus: 'Cost', plus: 'Recovered' }, stepHeader: 'Line' },
      table: bridgeTable(steps, tv, '% of transfer value'),
      note: 'Transfer price = standard raw-material cost plus a standard conversion charge per kg. Under-absorption is carried by the company, not by the outlets.'
    });
    chart.el.appendChild(sourceEnd(sourceIds(p, false)));
    return chart.el;
  }

  /* ------------------------------------------------------------------ outlet comparison: the decision view */

  function seqHeat(v, lo, hi, floor) {
    var spread = Math.max(hi - lo, floor);
    var u = spread > 0 ? clamp01((v - lo) / spread) : 0;
    var step = Math.min(SEQ_STEPS.length - 1, Math.floor(u * SEQ_STEPS.length));
    return { token: SEQ_STEPS[step], dark: step >= SEQ_DARK_FROM };
  }

  function divHeat(v, mid, lo, hi, floor) {
    var span = Math.max(Math.abs(hi - mid), Math.abs(mid - lo), floor) || 1;
    var t = Math.max(-1, Math.min(1, (v - mid) / span));
    var idx = Math.abs(t) < 0.1 ? 2 : (t > 0 ? (t > 0.55 ? 4 : 3) : (t < -0.55 ? 0 : 1));
    return { token: DIV_STEPS[idx], dark: idx === 0 || idx === 4 };
  }

  /**
   * Columns of the comparison. 'outlets': every outlet in scope for the period on screen, reference = all outlets.
   * 'months': the selected unit month by month, reference = all months of the data together.
   */
  function comparisonData(env, by) {
    var st = env.st, ctx = env.ctx;
    function ueOf(sel, per) { return call(function () { return MK.finance.unitEconomics(sel, per); }, null); }
    if (by === 'months') {
      var keys = env.monthRows.map(function (r) { return r.monthKey; });
      var whole = periodArg(keys);
      return {
        by: by, refLabel: monthsLabel(keys, false), refWords: 'all months', colWord: 'months',
        cols: env.monthRows.map(function (r) {
          return { id: r.monthKey, label: monthName(r), name: monthName(r), colourVar: null,
            selected: env.keys.length === 1 && env.keys[0] === r.monthKey, hint: 'Show ' + monthName(r) + ' above and below',
            select: function () { st.period = r.monthKey; ctx.rerender(); },
            pnl: MK.finance.pnl(env.unit.id, r.monthKey), ue: ueOf(env.unit.id, r.monthKey) };
        }),
        all: { pnl: MK.finance.pnl(env.unit.id, whole), ue: ueOf(env.unit.id, whole) }
      };
    }
    return {
      by: 'outlets', refLabel: 'All outlets', refWords: 'all outlets', colWord: 'outlets',
      cols: env.outlets.map(function (o) {
        return { id: o.id, label: o.label, name: o.name, colourVar: o.colourVar, selected: env.unit.id === o.id, hint: 'Show ' + o.name + ' above and below',
          select: function () { st.unit = o.id; ctx.rerender(); },
          pnl: MK.finance.pnl(o.id, env.per), ue: ueOf(o.id, env.per) };
      }),
      all: { pnl: MK.finance.pnl('outlets', env.per), ue: ueOf('outlets', env.per) }
    };
  }

  /** For each column, the cost block that sits furthest above the reference share; largest gaps first. */
  function standouts(data) {
    var out = [];
    data.cols.forEach(function (c) {
      if (!(c.pnl.totals.netSales > 0)) return;
      var candidates = [{ label: 'Food cost', groupId: 'cogs', pct: c.pnl.totals.foodCostPct, allPct: data.all.pnl.totals.foodCostPct }];
      (data.all.pnl.groups || []).forEach(function (g) {
        if (g.id === 'cogs' || g.id === 'below_ebitda') return;
        candidates.push({ label: g.label, groupId: g.id, pct: num(pctOf(groupOf(c.pnl, g.id))), allPct: num(g.pctOfSales) });
      });
      var best = null;
      candidates.forEach(function (k) {
        if (!isNum(k.pct) || !isNum(k.allPct)) return;
        var diff = k.pct - k.allPct;
        if (!best || diff > best.diff) best = { label: k.label, groupId: k.groupId, pct: k.pct, allPct: k.allPct, diff: diff };
      });
      if (best && best.diff > 0) out.push({ col: c, label: best.label, groupId: best.groupId, pct: best.pct, allPct: best.allPct, diff: best.diff });
    });
    return out.sort(function (a, b) { return b.diff - a.diff; }).slice(0, MAX_STANDOUTS);
  }

  function comparisonCard(env) {
    var st = env.st, ctx = env.ctx;
    var canOutlets = env.outlets.length > 1;
    var by = canOutlets && st.cmpBy !== 'months' ? 'outlets' : 'months';
    var data = comparisonData(env, by);
    var cols = data.cols, all = data.all;
    var inPct = st.cmpMode !== 'inr';
    st.open = st.open || Object.assign({}, DEFAULT_OPEN);
    var groups = (all.pnl.groups || []).filter(function (g) { return g.id !== 'below_ebitda'; });
    var anyEstimate = num(all.pnl.totals.estimatedPart) > 0;

    var table = h('table', { 'class': 'mk-table mk-table--dense ue-cmp' });
    table.appendChild(h('caption', { 'class': 'mk-sr' }, 'P&L lines by ' + (by === 'months' ? 'month' : 'outlet') + ', ' + (inPct ? 'as a share of net sales' : 'in rupees')));
    var headRow = h('tr', null, h('th', { scope: 'col' }, 'Line'));
    cols.forEach(function (c) {
      headRow.appendChild(h('th', { scope: 'col', 'class': ['is-num', c.selected ? 'is-selected' : ''] },
        h('button', { type: 'button', 'class': 'ue-colbtn', 'aria-pressed': c.selected ? 'true' : 'false', title: c.hint, onClick: c.select },
          c.colourVar ? h('span', { 'class': 'mk-legend-dot', style: { background: 'var(' + c.colourVar + ')' } }) : null, c.label)));
    });
    headRow.appendChild(h('th', { scope: 'col', 'class': 'is-num ue-cmp__all' }, data.refLabel));
    table.appendChild(h('thead', null, headRow));
    var tbody = h('tbody');
    table.appendChild(tbody);

    function addSection(label) {
      tbody.appendChild(h('tr', { 'class': 'ue-cmp__section' }, h('th', { scope: 'rowgroup', colspan: cols.length + 2 }, label)));
    }

    /* spec: { label, cls, get(pnl, ue) -> {amount, pct}, show: 'pct' | 'inr' | 'rupees' | undefined (follows the toggle), heat: 'seq' | 'div', moneyHeat, toggle, badge, title } */
    function addRow(spec) {
      var cells = cols.map(function (c) { return spec.get(c.pnl, c.ue) || {}; });
      var ref = spec.get(all.pnl, all.ue) || {};
      var basis = cells.map(function (x) { return isNum(x.pct) ? x.pct : null; }).filter(isNum);
      var lo = basis.length ? Math.min.apply(null, basis) : 0, hi = basis.length ? Math.max.apply(null, basis) : 0;
      var floor = spec.moneyHeat ? Math.abs(hi) * MIN_SPREAD_MONEY : MIN_SPREAD;
      /* the shade always follows the figure printed in the cell: a P&L row switched to rupees carries no shade,
         because the share it would be shaded by is no longer the number the reader sees */
      var shades = !!spec.heat && (!!spec.show || inPct);
      function text(x) {
        if (spec.show === 'inr') return isNum(x.amount) ? fmt.inr(x.amount) : '-';
        if (spec.show === 'rupees') return isNum(x.amount) ? rupees(x.amount) : '-';
        if (spec.show === 'pct') return isNum(x.pct) ? fmt.pct(x.pct) : '-';
        return inPct ? (isNum(x.pct) ? fmt.pct(x.pct) : '-') : (isNum(x.amount) ? fmt.inr(x.amount) : '-');
      }
      function tip(x) {
        if (spec.show) return null;
        return isNum(x.amount) && isNum(x.pct) ? fmt.inrFull(x.amount) + ' - ' + fmt.pct(x.pct) + ' of net sales' : null;
      }
      var head = h('th', { scope: 'row', 'class': 'ue-cmp__label', title: spec.title || null });
      if (spec.toggle) {
        head.appendChild(h('button', { type: 'button', 'class': 'ue-toggle', 'aria-expanded': spec.toggle.open ? 'true' : 'false', onClick: spec.toggle.onClick },
          ui.icon(spec.toggle.open ? 'chevron-down' : 'chevron-right', 14), h('span', null, spec.label)));
      } else {
        head.appendChild(h('span', null, spec.label));
      }
      if (spec.badge) head.appendChild(spec.badge);
      var tr = h('tr', { 'class': spec.cls || '' }, head);
      cells.forEach(function (x) {
        var td = h('td', { 'class': 'is-num', title: tip(x) }, text(x));
        if (shades && isNum(x.pct) && basis.length > 1) {
          var shade = spec.heat === 'div' ? divHeat(x.pct, isNum(ref.pct) ? ref.pct : 0, lo, hi, floor) : seqHeat(x.pct, lo, hi, floor);
          td.classList.add('mk-heat');
          if (shade.dark) td.classList.add('is-dark');
          td.style.background = 'var(' + shade.token + ')';
        }
        tr.appendChild(td);
      });
      tr.appendChild(h('td', { 'class': 'is-num ue-cmp__all', title: tip(ref) }, text(ref)));
      tbody.appendChild(tr);
    }

    addRow({ label: 'Net sales', cls: 'ue-cmp__total', show: 'inr', get: function (p) { return { amount: p.totals.netSales }; } });

    groups.forEach(function (g) {
      var open = !!st.open[g.id];
      addRow({ label: g.label, cls: 'ue-cmp__group', heat: 'seq',
        toggle: { open: open, onClick: function () { st.open[g.id] = !open; ctx.rerender(); } },
        get: function (p) { var x = groupOf(p, g.id); return { amount: amountOf(x), pct: x ? pctOf(x) : (p.totals.netSales > 0 ? 0 : null) }; } });
      if (open) {
        (all.pnl.lines || []).forEach(function (l) {
          if (l.group !== g.id) return;
          addRow({ label: l.label, cls: 'ue-cmp__line', heat: 'seq', title: LINE_GLOSS[l.key] || null,
            get: function (p) { var x = lineOf(p, l.key); return x ? { amount: num(x.amount), pct: pctOf(x) } : {}; } });
        });
        if (g.id === 'channel' && num(g.estimatedPart) > 0) {
          addRow({ label: 'of which not yet on a statement', cls: 'ue-cmp__line ue-cmp__est', badge: ui.estimateBadge(), title: estimateCaption(),
            get: function (p) { var x = groupOf(p, 'channel'); var e = x ? num(x.estimatedPart) : 0; return { amount: e, pct: p.totals.netSales > 0 ? e / p.totals.netSales : null }; } });
        }
      }
      if (g.id === 'cogs') {
        addRow({ label: 'Gross margin', cls: 'ue-cmp__total', heat: 'div',
          get: function (p) { return { amount: p.totals.grossMargin, pct: p.totals.netSales > 0 ? p.totals.grossMarginPct : null }; } });
      }
    });
    addRow({ label: 'EBITDA', cls: 'ue-cmp__total', heat: 'div',
      get: function (p) { return { amount: p.totals.ebitda, pct: p.totals.netSales > 0 ? p.totals.ebitdaPct : null }; } });

    addSection('Space and break-even, rupees a month');
    addRow({ label: 'Net sales per sq ft', cls: 'ue-cmp__line', show: 'rupees', heat: 'seq', moneyHeat: true,
      get: function (p, ue) { var s = ue && ue.perSqft; return s && s.sqft > 0 ? { amount: s.netSalesPerSqftPerMonth, pct: s.netSalesPerSqftPerMonth } : {}; } });
    addRow({ label: 'Rent per sq ft', cls: 'ue-cmp__line', show: 'rupees', heat: 'seq', moneyHeat: true,
      get: function (p, ue) { var s = ue && ue.perSqft; return s && s.sqft > 0 ? { amount: s.rentPerSqftPerMonth, pct: s.rentPerSqftPerMonth } : {}; } });
    addRow({ label: 'EBITDA per sq ft', cls: 'ue-cmp__line', show: 'rupees', heat: 'div', moneyHeat: true,
      get: function (p, ue) { var s = ue && ue.perSqft; return s && s.sqft > 0 ? { amount: s.ebitdaPerSqftPerMonth, pct: s.ebitdaPerSqftPerMonth } : {}; } });
    addRow({ label: 'Break-even sales', cls: 'ue-cmp__line', show: 'inr',
      get: function (p, ue) { var b = ue && ue.breakEven; return b && isNum(b.breakEvenSalesPerMonth) ? { amount: b.breakEvenSalesPerMonth } : {}; } });
    addRow({ label: 'Margin of safety', cls: 'ue-cmp__line', show: 'pct', heat: 'div', title: 'How far the sales run-rate sits above break-even sales',
      get: function (p, ue) { var b = ue && ue.breakEven; return b && isNum(b.marginOfSafetyPct) ? { pct: b.marginOfSafetyPct } : {}; } });

    /* what stands out: one item per column, largest gap first */
    var items = standouts(data);
    var strip = items.length ? h('div', { 'class': 'ue-standouts', role: 'group', 'aria-label': 'What stands out' }, items.map(function (it) {
      return h('button', { type: 'button', 'class': ['ue-standout', it.col.selected ? 'is-selected' : ''],
        title: 'Show ' + it.col.name + ' and open ' + lowerFirst(it.groupId === 'cogs' ? 'cost of goods sold' : it.label),
        onClick: function () { st.open[it.groupId] = true; it.col.select(); } },
        h('span', { 'class': 'ue-standout__who' }, it.col.colourVar ? h('span', { 'class': 'mk-legend-dot', style: { background: 'var(' + it.col.colourVar + ')' } }) : ui.icon('calendar', 12), it.col.name),
        h('span', { 'class': 'ue-standout__what' }, it.label + ' ' + fmt.pct(it.pct)),
        /* a gap too small to matter is stated, not shouted - the same floor the shading uses */
        h('span', { 'class': ['ue-standout__diff', it.diff < MIN_SPREAD ? 'is-soft' : ''] }, fmt.points(it.pct, it.allPct).label + ' vs ' + data.refWords));
    })) : null;

    var allOpen = groups.every(function (g) { return st.open[g.id]; });
    var actions = [
      ui.button({ label: allOpen ? 'Collapse all' : 'Expand all', variant: 'ghost', size: 'sm', icon: allOpen ? 'chevron-up' : 'chevron-down',
        onClick: function () { groups.forEach(function (g) { st.open[g.id] = !allOpen; }); ctx.rerender(); } }),
      canOutlets ? ui.segmented({ ariaLabel: 'Compare across', size: 'sm', value: by,
        options: [{ value: 'outlets', label: 'Across outlets' }, { value: 'months', label: 'Across months' }], onChange: function (v) { st.cmpBy = v; ctx.rerender(); } }) : null,
      ui.segmented({ ariaLabel: 'Show values as', size: 'sm', value: inPct ? 'pct' : 'inr',
        options: [{ value: 'pct', label: '% of net sales' }, { value: 'inr', label: 'Rupees' }], onChange: function (v) { st.cmpMode = v; ctx.rerender(); } })
    ];

    var legend = h('div', { 'class': 'ue-legend' },
      h('span', { 'class': 'ue-legend__item' }, h('span', { 'class': 'ue-legend__ramp ue-legend__ramp--seq', 'aria-hidden': 'true' }),
        inPct
          ? 'Blue: the darker the cell, the larger the figure in its row - a heavier share of net sales, or more rupees per sq ft; rows where the ' + data.colWord + ' sit close together stay pale'
          : 'Blue: rupees are the amounts themselves, so the P&L rows are left unshaded; switch to % of net sales to see who carries the heavier share'),
      h('span', { 'class': 'ue-legend__item' }, h('span', { 'class': 'ue-legend__ramp ue-legend__ramp--div', 'aria-hidden': 'true' }),
        'Red to blue: margin rows read against ' + data.refWords + ' - blue above that figure, red below'));

    var lead = items[0], title, subtitle;
    if (by === 'months') {
      title = env.unit.name + ' month by month';
      subtitle = (lead ? lead.col.name + ' stands out: ' + lowerFirst(lead.label) + ' took ' + fmt.pct(lead.pct) + ' of net sales against ' + fmt.pct(lead.allPct) + ' over ' + data.refLabel + '. ' : '') +
        'Select a month to see its bridge, per-order economics and full P&L.';
    } else {
      title = 'Outlets side by side';
      subtitle = shortPeriod(all.pnl.period) + '. ' + (lead ? lead.col.name + '\'s ' + lowerFirst(lead.label) + ' is the widest gap: ' + fmt.pct(lead.pct) + ' of its net sales against ' +
        fmt.pct(lead.allPct) + ' across all outlets. ' : '') + 'Select an outlet name to see its bridge, per-order economics and full P&L.';
    }
    var scopeNote = !canOutlets && env.outlets.length === 1
      ? note((ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel : 'Your role') + ' sees ' + env.outlets[0].name + ' only, so the comparison runs across months instead of across outlets.', 'lock') : null;
    if (scopeNote) scopeNote.classList.add('ue-cmpnote');

    return ui.card({ title: title, subtitle: subtitle, actions: actions, flush: true, className: 'ue-cmpcard',
      body: [scopeNote, strip, h('div', { 'class': 'mk-table-wrap' }, table)],
      footer: [legend, ui.sourceTag(sourceIds(all.pnl, true, anyEstimate))] });
  }

  /* ------------------------------------------------------------------ per-order economics */

  function statement(rows) {
    return h('dl', { 'class': 'ue-stmt' }, rows.filter(Boolean).map(function (r) {
      return h('div', { 'class': ['ue-stmt__row', r.kind ? 'ue-stmt__row--' + r.kind : ''], title: r.title || null },
        h('dt', { 'class': 'ue-stmt__label' }, r.sign ? h('span', { 'class': 'ue-stmt__sign', 'aria-hidden': 'true' }, r.sign) : null,
          h('span', { 'class': 'ue-stmt__text' }, r.label, r.badge ? ' ' : null, r.badge || null)),
        h('dd', { 'class': 'ue-stmt__value' }, r.value),
        h('dd', { 'class': 'ue-stmt__share' }, r.share || ''));
    }));
  }

  function perOrderCard(env) {
    var ue = env.ue, p = env.pnl;
    var po = ue && ue.perOrder;
    if (!po || !(ue.orders > 0)) return ui.card({ title: 'Per-order economics', body: ui.emptyState('No orders in this period', null, { compact: true }) });
    var aov = po.netSales;
    function share(v) { return aov > 0 ? fmt.pct(v / aov) : ''; }
    var est = num(po.channelCostsEstimated);
    var contribution = aov - po.foodCost - po.packaging - po.channelCosts;
    var rows = [
      { kind: 'start', label: 'Average order value', value: rupees(aov), share: 'net of GST' },
      { sign: '-', label: 'Food cost', value: rupees(po.foodCost), share: share(po.foodCost) },
      { sign: '-', label: 'Packaging', value: rupees(po.packaging), share: share(po.packaging) },
      { sign: '-', label: 'Aggregator and card fees', value: rupees(po.channelCosts), share: share(po.channelCosts) },
      est > 0 ? { kind: 'sub', label: 'of which', badge: ui.estimateBadge(), value: rupees(est), share: share(est) } : null,
      { kind: 'total', sign: '=', label: 'Contribution per order', value: rupees(contribution), share: share(contribution) },
      { sign: '-', label: 'Operating costs', title: 'People, occupancy, utilities, operations, marketing and factory logistics', value: rupees(po.opex), share: share(po.opex) },
      { kind: 'total', sign: '=', label: 'EBITDA per order', value: rupees(po.ebitda), share: share(po.ebitda) }
    ];
    var seat = ue.perSeat;
    var extra = seat && seat.seats > 0 && isNum(seat.dineInSalesPerSeatPerDay) ? note('Dine-in earns ' + rupees(seat.dineInSalesPerSeatPerDay) + ' per seat a day on ' + fmt.num(seat.seats) + ' seats.', 'store') : null;
    return ui.card({ title: 'Per-order economics', className: 'ue-fill',
      subtitle: env.unit.name + ', ' + fmt.num(ue.orders) + ' orders in ' + shortPeriod(p.period) + ': ' + rupees(contribution) + ' of every ' + rupees(aov) + ' order is left after food, packaging and channel costs.',
      body: [statement(rows), extra],
      footer: ui.sourceTag(sourceIds(p, true, est > 0)) });
  }

  function channelName(id) {
    var list = (MK.config && MK.config.channels) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label || id;
    return id;
  }

  function feesAllowed(stream) {
    var ch = channelName(stream.channelId), kind = null;
    ((MK.config && MK.config.channels) || []).forEach(function (c) { if (c.id === stream.channelId) kind = c.kind; });
    if (kind !== 'aggregator' || !MK.data || typeof MK.data.can !== 'function') return { ok: true, name: ch };
    var actual = MK.data.can(stream.channelId, 'order.feesActual'), estimated = MK.data.can(stream.channelId, 'order.feesEstimated');
    return { ok: actual !== 'no' || estimated !== 'no', name: ch };
  }

  function streamChart(env) {
    var ue = env.ue, p = env.pnl;
    var streams = ((ue && ue.byStream) || []).filter(function (s) { return s.orders > 0 && s.perOrder; });
    if (!streams.length) return ui.card({ title: 'Per order, by stream', body: ui.emptyState('No orders in this period', null, { compact: true }) });
    var gates = streams.map(feesAllowed);
    var anyEst = streams.some(function (s) { return num(s.perOrder.channelCostsEstimated) > 0; });
    var negative = streams.some(function (s) { return s.perOrder.contribution < 0; });

    function col(fn) { return streams.map(function (s, i) { var v = fn(s, gates[i]); return isNum(v) ? Math.round(v) : null; }); }
    var series = [
      { id: 'food', name: 'Food cost', values: col(function (s) { return s.perOrder.foodCost; }), colourVar: '--series-2' },
      { id: 'pack', name: 'Packaging', values: col(function (s) { return s.perOrder.packaging; }), colourVar: '--series-4' },
      { id: 'fees', name: anyEst ? 'Channel costs - statements' : 'Channel costs',
        values: col(function (s, g) { return g.ok ? s.perOrder.channelCosts - num(s.perOrder.channelCostsEstimated) : null; }), colourVar: '--series-8' }
    ];
    if (anyEst) series.push({ id: 'feesEst', name: 'Channel costs - estimated', values: col(function (s, g) { return g.ok ? num(s.perOrder.channelCostsEstimated) : null; }), colourVar: '--series-5' });
    series.push({ id: 'contribution', name: 'Contribution', values: col(function (s, g) { return g.ok ? Math.max(0, s.perOrder.contribution) : null; }), colourVar: '--series-1' });

    var best = streams.slice().sort(function (a, b) { return num(b.contributionPct) - num(a.contributionPct); });
    var top = best[0], low = best[best.length - 1];
    var subtitle = streams.length > 1
      ? top.label + ' keeps ' + rupees(top.perOrder.contribution) + ' an order (' + fmt.pct(top.contributionPct) + '); ' + low.label + ' keeps ' + rupees(low.perOrder.contribution) +
        ' (' + fmt.pct(low.contributionPct) + ') after ' + rupees(low.perOrder.channelCosts) + ' of channel costs.'
      : top.label + ' keeps ' + rupees(top.perOrder.contribution) + ' an order (' + fmt.pct(top.contributionPct) + ').';

    var tableRows = streams.map(function (s, i) {
      var ok = gates[i].ok;
      return { stream: s.label, orders: s.orders, aov: Math.round(s.perOrder.netSales), food: Math.round(s.perOrder.foodCost), pack: Math.round(s.perOrder.packaging),
        fees: ok ? Math.round(s.perOrder.channelCosts) : null, est: ok ? Math.round(num(s.perOrder.channelCostsEstimated)) : null,
        contribution: ok ? Math.round(s.perOrder.contribution) : null, contributionPct: ok ? s.contributionPct : null };
    });
    var blocked = streams.filter(function (s, i) { return !gates[i].ok; });

    var chart = MK.charts.mount(null, {
      id: 'ue-streams', kind: 'hstackedBar', format: 'inrFull', height: H_CHART - 40,
      title: 'Where an order\'s value goes, by stream', subtitle: subtitle,
      data: { categories: streams.map(function (s) { return s.label; }), categoryHeader: 'Stream', series: series },
      table: { columns: [{ key: 'stream', label: 'Stream' }, { key: 'orders', label: 'Orders', format: 'num', align: 'right' },
        { key: 'aov', label: 'Order value', format: 'inrFull', align: 'right' }, { key: 'food', label: 'Food', format: 'inrFull', align: 'right' },
        { key: 'pack', label: 'Packaging', format: 'inrFull', align: 'right' }, { key: 'fees', label: 'Channel costs', format: 'inrFull', align: 'right' },
        { key: 'est', label: 'of which estimated', format: 'inrFull', align: 'right' }, { key: 'contribution', label: 'Contribution', format: 'inrFull', align: 'right' },
        { key: 'contributionPct', label: 'Contribution %', format: 'pct', align: 'right' }], rows: tableRows },
      note: 'Rupees per order; each bar adds up to the stream\'s average order value. In-store channel cost is its share of card MDR. Food cost carries the stream\'s share of the wastage variance.' +
        (negative ? ' A stream with a negative contribution is drawn without one - see the table.' : '') + (anyEst ? ' ' + estimateCaption() + '.' : '')
    });
    blocked.forEach(function (s) { chart.el.appendChild(h('p', { 'class': 'ue-note' }, h('span', null, s.label + ' fees: '), ui.notProvided(channelName(s.channelId)))); });
    if (anyEst) chart.el.appendChild(h('p', { 'class': 'ue-note' }, ui.estimateBadge(), h('span', null, 'The estimated segment covers aggregator orders of weeks without a statement yet; it is never merged into the statement figure.')));
    chart.el.appendChild(sourceEnd(sourceIds(p, true, anyEst)));
    chart.el.classList.add('ue-fill');
    return chart.el;
  }

  /* ------------------------------------------------------------------ trend and break-even */

  function trendChart(env) {
    var labels = env.monthRows.map(function (r) { return MK.dates.monthLabel(r.monthKey, false); });
    var series = env.outlets.map(function (o) {
      var t = MK.finance.pnlTrend(o.id);
      return { id: o.id, name: o.name, values: (t.rows || []).map(function (r) { return r.netSales > 0 ? r.ebitdaPct : null; }) };
    });
    var anyEst = false;
    if (env.seesAll) {
      var company = MK.finance.pnlTrend(COMPANY);
      series.push({ id: 'company', name: 'Company, after factory and head office', colourVar: '--ink-2', values: (company.rows || []).map(function (r) { return r.netSales > 0 ? r.ebitdaPct : null; }) });
      anyEst = (company.rows || []).some(function (r) { return num(r.estimatedPart) > 0; });
    }
    var last = labels.length - 1, first = 0;
    var ranked = series.filter(function (s) { return s.id !== 'company' && isNum(s.values[last]); }).sort(function (a, b) { return b.values[last] - a.values[last]; });
    var subtitle = '';
    if (ranked.length > 1) {
      var climber = null;
      ranked.forEach(function (s) {
        if (!isNum(s.values[first])) return;
        var d = s.values[last] - s.values[first];
        if (!climber || d > climber.d) climber = { s: s, d: d };
      });
      subtitle = ranked[0].name + ' leads in ' + labels[last] + ' at ' + fmt.pct(ranked[0].values[last]) + '; ' + ranked[ranked.length - 1].name + ' trails at ' + fmt.pct(ranked[ranked.length - 1].values[last]) + '.' +
        (climber ? ' Biggest move since ' + labels[first] + ': ' + climber.s.name + ' (' + fmt.points(climber.s.values[last], climber.s.values[first]).label + ').' : '');
    } else if (ranked.length === 1) {
      subtitle = ranked[0].name + ': ' + fmt.pct(ranked[0].values[last]) + ' in ' + labels[last] + (isNum(ranked[0].values[first]) ? ', against ' + fmt.pct(ranked[0].values[first]) + ' in ' + labels[first] : '') + '.';
    }
    var lastRow = env.monthRows[last];
    var markers = env.keys.length === 1 ? env.monthRows.filter(function (r) { return r.monthKey === env.keys[0]; }).map(function (r) { return { label: 'Shown above', atLabel: MK.dates.monthLabel(r.monthKey, false) }; }) : [];
    var chart = MK.charts.mount(null, {
      id: 'ue-trend', kind: 'line', format: 'pct', height: H_CHART, zeroBaseline: false,
      title: 'EBITDA % by month', subtitle: subtitle,
      data: { labels: labels, series: series, colourBy: 'outlet', labelHeader: 'Month', markers: markers },
      note: lastRow && lastRow.partial ? labels[last] + ' = ' + lastRow.periodLabel + '; fixed costs accrued pro rata.' : null
    });
    chart.el.appendChild(sourceEnd(sourceIds(env.pnl, true, anyEst || env.monthRows.some(function (r) { return num(r.estimatedPart) > 0; }))));
    chart.el.classList.add('ue-fill');
    return chart.el;
  }

  function breakEvenChart(env) {
    /* several outlets: one bar each. One outlet in scope: that outlet month by month - a single bar would be a stat tile,
       and the break-even tile above already is one. */
    var byMonth = env.outlets.length < 2;
    var one = env.outlets[0] || null;
    var source = byMonth
      ? (one ? env.monthRows.map(function (r) { return { label: monthName(r), name: monthName(r), key: r.monthKey, ue: call(function () { return MK.finance.unitEconomics(one.id, r.monthKey); }, null) }; }) : [])
      : env.outlets.map(function (o) { return { label: o.label, name: o.name, key: o.id, ue: call(function () { return MK.finance.unitEconomics(o.id, env.per); }, null) }; });
    var rows = source.map(function (r) { return { label: r.label, name: r.name, key: r.key, be: r.ue && r.ue.breakEven }; })
      .filter(function (r) { return r.be && isNum(r.be.breakEvenSalesPerMonth) && isNum(r.be.netSalesRunRatePerMonth); });
    var title = byMonth ? 'Sales run-rate against break-even, by month' : 'Sales run-rate against break-even';
    if (!rows.length) return ui.card({ title: title, body: ui.emptyState('No break-even figures for this period', null, { compact: true }) });
    var sorted = rows.slice().sort(function (a, b) { return num(a.be.marginOfSafetyPct) - num(b.be.marginOfSafetyPct); });
    var thin = sorted[0], wide = sorted[sorted.length - 1];
    function cushion(r) { return fmt.pct(Math.abs(num(r.be.marginOfSafetyPct))) + (r.be.marginOfSafetyPct < 0 ? ' below' : ' above') + ' break-even'; }
    var subtitle = rows.length > 1
      ? (byMonth ? one.name + ': ' : '') + thin.name + ' left the thinnest cushion, ' + cushion(thin) + '; ' + wide.name + ' the widest, ' +
        fmt.pct(Math.abs(num(wide.be.marginOfSafetyPct))) + (wide.be.marginOfSafetyPct < 0 ? ' below.' : ' above.')
      : thin.name + ' runs ' + cushion(thin) + ' of ' + fmt.inr(thin.be.breakEvenSalesPerMonth) + ' a month.';
    var est = rows.some(function (r) { return num(r.be.estimatedPart) > 0; });
    var selected = byMonth ? (env.keys.length === 1 ? env.keys[0] : null) : (env.isOutlet ? env.unit.id : null);
    var mark = null;
    rows.forEach(function (r) { if (r.key === selected) mark = r.label; });
    var chart = MK.charts.mount(null, {
      id: 'ue-breakeven', kind: 'bar', format: 'inr', height: H_CHART,
      title: title, subtitle: subtitle,
      data: { categories: rows.map(function (r) { return r.label; }), categoryHeader: byMonth ? 'Month' : 'Outlet', name: 'Net sales run-rate a month',
        values: rows.map(function (r) { return Math.round(r.be.netSalesRunRatePerMonth); }),
        target: rows.map(function (r) { return Math.round(r.be.breakEvenSalesPerMonth); }), targetName: 'Break-even sales',
        highlight: mark && rows.length > 1 ? mark : undefined },
      note: 'Break-even = the fixed costs of a full month divided by the contribution margin (net sales less food, packaging, aggregator costs and other variable lines).' +
        (byMonth ? ' A month to date is shown at its run-rate, so the months stay comparable.' : '') +
        (est ? ' The variable share includes estimated aggregator costs.' : '')
    });
    chart.el.appendChild(sourceEnd(sourceIds(env.pnl, true, est)));
    chart.el.classList.add('ue-fill');
    return chart.el;
  }

  /* ------------------------------------------------------------------ full P&L detail */

  function ledgerFacts(env) {
    if (env.isCompany || !MK.finance.ledger) return {};
    var lastKey = env.keys[env.keys.length - 1];
    var lines = call(function () { return MK.finance.ledger({ unitId: env.unit.id, monthKey: lastKey }); }, []) || [];
    var map = {};
    lines.forEach(function (l) {
      var m = map[l.categoryId] || (map[l.categoryId] = { bases: [], behaviour: {}, fullMonth: 0, prorata: false });
      var lead = l.note || LINE_GLOSS[l.categoryId] || '';
      var text = lead && l.basis ? lead + ': ' + l.basis : (l.basis || lead);
      if (l.estimated) text = '';
      if (text && m.bases.indexOf(text) === -1) m.bases.push(text);
      if (l.behaviour) m.behaviour[l.behaviour] = true;
      if (l.accrual === 'prorata' && isNum(l.fullMonthAmount)) { m.prorata = true; m.fullMonth += l.fullMonthAmount; }
    });
    return map;
  }

  function detailCard(env) {
    var p = env.pnl, pp = env.prevPnl, t = p.totals, prev = p.prev, st = env.st;
    var costCentre = env.isFactory || env.isHo;
    var hoTotal = num(t.opex) + num(t.depreciation), hoPrevTotal = prev ? num(prev.opex) + num(prev.depreciation) : null;
    var partial = !!(p.period && p.period.partial);
    var single = env.keys.length === 1;
    var facts = ledgerFacts(env);
    var baseLabel = env.isFactory ? '% of transfer value' : (env.isHo ? 'Share of cost' : '% of net sales');
    var rows = [];

    function share(amount, pct) { return env.isHo ? (hoTotal > 0 ? amount / hoTotal : null) : pct; }
    function prevShare(amount, pct) { return env.isHo ? (hoPrevTotal > 0 && isNum(amount) ? amount / hoPrevTotal : null) : pct; }
    function totalRow(label, amount, pct, prevPct, goodWhen) {
      rows.push({ kind: 'total', label: label, amount: amount, pct: pct, prevPct: prevPct, change: env.isHo ? null : pointsDelta(pct, prevPct), goodWhen: goodWhen || 'up' });
    }

    if (env.isFactory) {
      totalRow('Transfer value', num(t.transferValue), null, null);
      rows.push({ kind: 'line', label: 'Logistics recovered from the outlets', amount: num(t.logisticsRecovery), pct: t.transferValue > 0 ? num(t.logisticsRecovery) / t.transferValue : null,
        prevPct: prev && prev.transferValue > 0 ? num(prev.logisticsRecovery) / prev.transferValue : null, goodWhen: 'neutral', basis: categoryNote('logistics_allocation') });
      rows[rows.length - 1].change = pointsDelta(rows[rows.length - 1].pct, rows[rows.length - 1].prevPct);
    } else if (!env.isHo) {
      totalRow('Net sales', t.netSales, null, null);
    }

    (p.groups || []).forEach(function (g) {
      if (g.id === 'below_ebitda') return;
      var pg = groupOf(pp, g.id);
      rows.push({ kind: 'group', label: g.label, amount: g.amount, pct: share(g.amount, pctOf(g)), prevPct: prevShare(pg ? pg.amount : null, pctOf(pg)),
        change: env.isHo ? (!partial && pg ? pctDelta(g.amount, pg.amount) : null) : pointsDelta(pctOf(g), pctOf(pg)), goodWhen: 'down', estimatedPart: num(g.estimatedPart) });
      (p.lines || []).forEach(function (l) {
        if (l.group !== g.id) return;
        var pl = lineOf(pp, l.key), fact = facts[l.key] || null;
        rows.push({ kind: 'line', key: l.key, label: l.label, amount: l.amount, pct: share(l.amount, pctOf(l)), prevPct: prevShare(pl ? pl.amount : null, pctOf(pl)),
          change: env.isHo ? (!partial && pl ? pctDelta(l.amount, pl.amount) : null) : pointsDelta(pctOf(l), pctOf(pl)), goodWhen: 'down', estimatedPart: num(l.estimatedPart),
          basis: fact ? fact.bases.join('; ') : '', behaviour: fact ? Object.keys(fact.behaviour) : [],
          fullMonth: fact && fact.prorata && partial && single ? fact.fullMonth : null });
      });
      if (g.id === 'cogs' && !costCentre) totalRow('Gross margin', t.grossMargin, t.grossMarginPct, prev ? prev.grossMarginPct : null);
    });

    if (env.isHo) {
      rows.push({ kind: 'total', label: 'Head-office cost', amount: hoTotal, pct: hoTotal > 0 ? 1 : null, prevPct: null, change: null, goodWhen: 'down' });
    } else {
      totalRow(env.isFactory ? 'Over / (under) absorption' : 'EBITDA', t.ebitda, t.ebitdaPct, prev ? prev.ebitdaPct : null);
      (p.lines || []).forEach(function (l) {
        if (l.group !== 'below_ebitda') return;
        var pl = lineOf(pp, l.key), fact = facts[l.key] || null;
        rows.push({ kind: 'line', key: l.key, label: l.label, amount: l.amount, pct: pctOf(l), prevPct: pctOf(pl), change: pointsDelta(pctOf(l), pctOf(pl)), goodWhen: 'down',
          basis: fact ? fact.bases.join('; ') : '', behaviour: fact ? Object.keys(fact.behaviour) : [], fullMonth: fact && fact.prorata && partial && single ? fact.fullMonth : null });
      });
      var base = env.isFactory ? num(t.transferValue) : num(t.netSales);
      var prevBase = prev ? (env.isFactory ? num(prev.transferValue) : num(prev.netSales)) : 0;
      totalRow(env.isFactory ? 'After depreciation' : 'EBIT (after depreciation)', t.ebit, base > 0 ? t.ebit / base : null, prev && prevBase > 0 ? prev.ebit / prevBase : null);
    }

    function labelCell(value, row) {
      var main = h('span', { 'class': 'ue-line__name' }, value);
      if (!(row.estimatedPart > 0)) return h('div', { 'class': ['ue-line', 'ue-line--' + row.kind] }, main);
      return h('div', { 'class': ['ue-line', 'ue-line--' + row.kind] }, main,
        h('span', { 'class': 'ue-line__est' }, ui.estimateBadge(), ' ' + fmt.inrFull(row.estimatedPart) + ' of it, until the statement arrives'));
    }
    function bookedCell(value, row) {
      if (row.kind !== 'line') return '';
      var tags = (env.isOutlet ? row.behaviour || [] : []).map(function (b) { return ui.chip(b === 'variable' ? 'Variable' : 'Fixed', b === 'variable' ? 'info' : 'neutral', { outline: true }); });
      var text = (row.basis || '') + (isNum(row.fullMonth) ? (row.basis ? ' - ' : '') + 'full month ' + fmt.inrFull(row.fullMonth) : '');
      if (row.estimatedPart > 0 && !text) text = 'Payout statements; the unsettled tail at contracted (assumed) rates';
      if (!tags.length && !text) return '';
      return h('div', { 'class': 'ue-booked', title: text }, tags, h('span', { 'class': 'ue-booked__text' }, h('span', { 'class': 'ue-booked__clamp' }, text)));
    }

    /* head office has no sales base to compare against and its mix never moves, so the movement stays on the tiles;
       at the start of the data there is no preceding period at all - either way the two columns would be a wall of dashes */
    var prevHead = env.prevShort ? 'Previous (' + env.prevShort + ')' : 'Previous';
    var withPrev = !!prev && !env.isHo;
    var columns = [
      { key: 'label', label: 'Line', render: labelCell, width: 292 },
      { key: 'amount', label: 'Amount', format: 'inrFull', width: 104 },
      { key: 'pct', label: baseLabel, format: 'pct', width: 112 }
    ];
    if (withPrev) {
      columns.push({ key: 'prevPct', label: prevHead, format: 'pct', width: 112, title: baseLabel + ' in the preceding period of equal length' });
      columns.push({ key: 'change', label: 'Change', align: 'right', width: 96, title: 'Change in percentage points against ' + env.prevShort,
        render: function (v, row) { return ui.deltaBadge(v, row.goodWhen) || h('span', { 'class': 'mk-faint' }, '-'); } });
    }
    if (!env.isCompany) columns.push({ key: 'basis', label: 'How it is booked', render: bookedCell, className: 'ue-bookedcell' });

    var csvColumns = [{ key: 'label', label: 'Line' }, { key: 'amount', label: 'Amount' }, { key: 'pct', label: baseLabel }];
    if (withPrev) csvColumns.push({ key: 'prevPct', label: prevHead });
    csvColumns.push({ key: 'estimatedPart', label: 'Estimated part' }, { key: 'basis', label: 'How it is booked' });
    var title = env.isHo ? 'Head-office cost lines' : (env.isFactory ? 'Factory cost lines' : 'Full P&L');
    var estTotal = num(t.estimatedPart);
    var subtitle = env.unit.name + ', ' + (p.period ? p.period.label : '') + '. ' +
      (env.isHo ? 'Every line of the cost centre with its share of the total.' : (env.isFactory ? 'Every cost line against transfer value; the result is what the transfer prices did not cover, or over-covered.'
        : 'Every line, from rent and the GST on it to gas, charcoal, consumables and staff costs' + (estTotal > 0 ? '; ' + fmt.inr(estTotal) + ' of aggregator costs is estimated and marked.' : '.')));

    return ui.card({ title: title, subtitle: subtitle, flush: true, className: 'ue-detail',
      actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', onClick: function () {
        ui.downloadCsv('unit-economics-' + env.unit.id + '-' + env.keys.join('_') + '.csv', csvColumns, rows);
      } }),
      body: ui.table({ columns: columns, rows: rows, dense: true, sortable: false,
        rowClass: function (r) { return r.kind === 'total' ? 'is-strong ue-row-total' : (r.kind === 'group' ? 'is-strong ue-row-group' : 'ue-row-line'); },
        empty: 'No cost lines in this period' }),
      footer: ui.sourceTag(sourceIds(p, !costCentre, estTotal > 0)) });
  }

  /* ------------------------------------------------------------------ cost-centre visuals */

  function varianceChart(env) {
    var fp = env.factoryPnl;
    var lastKey = env.keys[env.keys.length - 1];
    if (!fp || !fp.variance) return ui.card({ title: 'What drove the absorption', body: ui.emptyState('No variance analysis for this month', null, { compact: true }) });
    var items = Object.keys(fp.variance).map(function (k) { return { label: VARIANCE_LABELS[k] || k, value: num(fp.variance[k]) }; }).filter(function (x) { return x.value !== 0; })
      .sort(function (a, b) { return a.value - b.value; });
    if (!items.length) return ui.card({ title: 'What drove the absorption', body: ui.emptyState('Every cost ran at standard in this month', null, { compact: true }) });
    var drag = items[0], help = items[items.length - 1];
    var monthText = MK.dates.monthLabel(lastKey, true) + (fp.period && fp.period.partial ? ' to date' : '');
    var subtitle = monthText + ': net ' + fmt.inr(Math.abs(num(fp.absorption))) + (fp.absorption < 0 ? ' under-absorbed. ' : ' over-absorbed. ') +
      (drag.value < 0 ? 'Biggest drag: ' + lowerFirst(drag.label) + ' (' + fmt.inr(drag.value) + ')' : 'No line ran against standard') +
      (help.value > 0 ? '; biggest help: ' + lowerFirst(help.label) + ' (' + fmt.inr(help.value) + ').' : '.');
    var chart = MK.charts.mount(null, {
      id: 'ue-variance', kind: 'divergingBar', format: 'inrFull', height: H_CHART,
      title: 'What drove the absorption', subtitle: subtitle,
      data: { categories: items.map(function (x) { return x.label; }), values: items.map(function (x) { return x.value; }), name: 'Variance against standard',
        zeroLabel: 'Standard', posLabel: 'Favourable', negLabel: 'Unfavourable', categoryHeader: 'Driver' },
      note: 'The drivers add up to the over or under absorption of the month.' + (env.keys.length > 1 ? ' Variances are analysed by month: this is the latest month of the period.' : '')
    });
    chart.el.appendChild(sourceEnd(fp.source || 'erp'));
    chart.el.classList.add('ue-fill');
    return chart.el;
  }

  function absorptionTrend(env) {
    var t = MK.finance.pnlTrend('factory');
    var rows = t.rows || [];
    var labels = rows.map(monthName);
    var values = rows.map(function (r) { return num(r.transferValue) > 0 ? r.ebitdaPct : null; });
    var under = rows.filter(function (r, i) { return isNum(values[i]) && values[i] < 0; });
    var worst = null;
    rows.forEach(function (r, i) { if (isNum(values[i]) && (!worst || values[i] < worst.v)) worst = { r: r, v: values[i] }; });
    var subtitle = under.length
      ? 'Under-absorbed in ' + andList(under.map(monthName)) + (worst ? '; deepest in ' + monthName(worst.r) + ' at ' + fmt.pct(worst.v) + ' of transfer value.' : '.')
      : 'Transfer prices covered the factory\'s costs in every month shown.';
    var chart = MK.charts.mount(null, {
      id: 'ue-absorption-trend', kind: 'bar', format: 'pct', height: H_CHART,
      title: 'Absorption by month, % of transfer value', subtitle: subtitle,
      data: { categories: labels, values: values, name: 'Over / (under) absorption', categoryHeader: 'Month' },
      note: 'Above zero the outlets were charged more than the factory cost; below zero, less.'
    });
    chart.el.appendChild(sourceEnd('erp'));
    chart.el.classList.add('ue-fill');
    return chart.el;
  }

  function hoLinesChart(env) {
    var p = env.pnl;
    var lines = (p.lines || []).slice().sort(function (a, b) { return b.amount - a.amount; });
    if (!lines.length) return ui.card({ title: 'Head-office cost lines', body: ui.emptyState('No head-office cost in this period', null, { compact: true }) });
    var total = lines.reduce(function (s, l) { return s + num(l.amount); }, 0);
    var chart = MK.charts.mount(null, {
      id: 'ue-ho-lines', kind: 'hbar', format: 'inr', height: H_CHART,
      title: 'Where head-office money goes',
      subtitle: shortPeriod(p.period) + ': ' + lines[0].label + ' takes ' + fmt.pct(total > 0 ? lines[0].amount / total : null) + ' of the ' + fmt.inr(total) + ' head-office cost' +
        (lines.length > 1 ? ', ' + lowerFirst(lines[1].label) + ' another ' + fmt.pct(total > 0 ? lines[1].amount / total : null) : '') + '.',
      data: { categories: lines.map(function (l) { return l.label; }), values: lines.map(function (l) { return l.amount; }), name: 'Cost', categoryHeader: 'Line' }
    });
    chart.el.appendChild(sourceEnd(sourceIds(p, false)));
    chart.el.classList.add('ue-fill');
    return chart.el;
  }

  function hoTrend(env) {
    var t = MK.finance.pnlTrend('ho');
    var rows = t.rows || [];
    var values = rows.map(function (r) { return num(r.opex) + num(r.depreciation); });
    var full = rows.filter(function (r) { return !r.partial; });
    var fullValues = full.map(function (r) { return num(r.opex) + num(r.depreciation); });
    var lowText = fullValues.length ? fmt.inr(Math.min.apply(null, fullValues)) : '', highText = fullValues.length ? fmt.inr(Math.max.apply(null, fullValues)) : '';
    var subtitle = !fullValues.length ? ''
      : (lowText === highText ? 'A steady ' + highText + ' in every full month' : 'Between ' + lowText + ' and ' + highText + ' in a full month') + ': a fixed cost the outlets have to carry.';
    var lastRow = rows[rows.length - 1];
    var chart = MK.charts.mount(null, {
      id: 'ue-ho-trend', kind: 'bar', format: 'inr', height: H_CHART,
      title: 'Head-office cost by month', subtitle: subtitle,
      data: { categories: rows.map(monthName), values: values, name: 'Head-office cost', categoryHeader: 'Month' },
      note: lastRow && lastRow.partial ? monthName(lastRow) + ' = ' + lastRow.periodLabel + ', accrued pro rata.' : null
    });
    chart.el.appendChild(sourceEnd('erp'));
    chart.el.classList.add('ue-fill');
    return chart.el;
  }

  /* ------------------------------------------------------------------ page */

  /**
   * Deep link: open the screen on the unit the link names. Applied once per distinct parameter value, so a unit tab the
   * reader picks afterwards survives every later re-render (store change, filter change) while the id sits in the hash.
   * A unit outside the persona's scope is ignored: the page keeps its own default rather than showing an empty screen.
   */
  function applyParams(st, ctx, units) {
    var p = ctx.params || {};
    var wanted = p.outlet || p.unit || p.unitId || '';
    if (st.paramSig === wanted) return;
    st.paramSig = wanted;
    if (!wanted) return;
    for (var i = 0; i < units.length; i++) {
      if (units[i].id === wanted) { st.unit = wanted; return; }
    }
  }

  function render(rootEl, ctx) {
    var st = ctx.state;
    if (!MK.finance || typeof MK.finance.pnl !== 'function') {
      rootEl.appendChild(ui.emptyState('Cost data is not loaded', 'The finance layer did not start, so there is no P&L to show.', { icon: 'database' }));
      return;
    }
    var units = unitOptions();
    if (!units.length) {
      rootEl.appendChild(ui.emptyState('No unit in your scope', 'Your role has no outlet, factory or head-office cost centre assigned, so there is no P&L to show.', { icon: 'lock' }));
      return;
    }
    var monthRows = call(function () { return MK.finance.pnlTrend(COMPANY).rows; }, []) || [];
    if (!monthRows.length) {
      rootEl.appendChild(ui.emptyState('No cost months in the data', null, { icon: 'calendar' }));
      return;
    }

    /* a link lands on the unit it names (the Overview outlet scorecard sends ?outlet=, other screens ?unit= / ?unitId=) */
    applyParams(st, ctx, units);

    /* unit: keep the choice while it stays inside the persona's scope */
    var unit = null;
    units.forEach(function (u) { if (u.id === st.unit) unit = u; });
    if (!unit) { unit = units[0]; st.unit = unit.id; }

    /* period: the date filter decides; the quick switch overrides until the filter changes */
    var f = ctx.filters || {};
    var filterKey = (f.from || '') + '|' + (f.to || '');
    if (st.filterKey !== filterKey) { st.filterKey = filterKey; st.period = null; }
    var touched = touchedMonths(f, monthRows);
    var defaultSel = touched.length > 1 ? RANGE : touched[0];
    var known = monthRows.some(function (r) { return r.monthKey === st.period; }) || (st.period === RANGE && touched.length > 1);
    var sel = known ? st.period : defaultSel;
    var keys = sel === RANGE ? touched : [sel];
    var per = periodArg(keys);

    var unitSel = unit.id;
    var pnl = MK.finance.pnl(unitSel, per);
    var prevKeys = pnl.prev && pnl.prev.months && pnl.prev.months.length ? pnl.prev.months : null;
    var env = {
      st: st, ctx: ctx, units: units, unit: unit, monthRows: monthRows, touched: touched, sel: sel, keys: keys, per: per,
      overridden: sel !== defaultSel,
      isOutlet: unit.type === 'outlet', isFactory: unit.type === 'factory', isHo: unit.type === 'ho', isCompany: unit.type === 'company',
      outlets: units.filter(function (u) { return u.type === 'outlet'; }),
      seesAll: !!(MK.session.seesAllUnits && MK.session.seesAllUnits()),
      pnl: pnl,
      prevPnl: prevKeys ? call(function () { return MK.finance.pnl(unitSel, periodArg(prevKeys)); }, null) : null,
      prevShort: prevKeys ? monthsLabel(prevKeys, false) : '',
      ue: call(function () { return MK.finance.unitEconomics(unitSel, per); }, null),
      prevUe: null, factoryPnl: null, costing: null
    };
    if (env.isFactory) {
      env.prevUe = prevKeys ? call(function () { return MK.finance.unitEconomics(unitSel, periodArg(prevKeys)); }, null) : null;
      if (MK.factory) {
        var lastKey = keys[keys.length - 1];
        env.factoryPnl = call(function () { return MK.factory.pnl(lastKey); }, null);
        env.costing = call(function () { return MK.factory.costing(lastKey); }, null);
      }
    }

    safe(rootEl, 'Page header', function () { return header(env); });

    if (env.isFactory) {
      safe(rootEl, 'Factory KPIs', function () { return factoryTiles(env); });
      safe(rootEl, 'Factory bridge', function () { return factoryWaterfall(env); });
      safe(rootEl, 'Factory variance and trend', function () {
        return ui.grid([6, 6], [varianceChart(env), absorptionTrend(env)], { className: 'ue-pair' });
      });
      safe(rootEl, 'Factory cost lines', function () { return detailCard(env); });
      if (MK.router.isAllowed && MK.router.isAllowed('factory-overview')) {
        rootEl.appendChild(h('p', { 'class': 'ue-note' }, ui.icon('factory', 14), h('span', null, 'Cost per kg by product, yield and fill rate are on the factory screens. '),
          ui.link('Open factory economics', MK.router.href('factory-overview'), { icon: 'arrow-right' })));
      }
      return;
    }
    if (env.isHo) {
      safe(rootEl, 'Head-office KPIs', function () { return hoTiles(env); });
      safe(rootEl, 'Head-office charts', function () { return ui.grid([7, 5], [hoLinesChart(env), hoTrend(env)], { className: 'ue-pair' }); });
      safe(rootEl, 'Head-office cost lines', function () { return detailCard(env); });
      return;
    }

    safe(rootEl, 'KPI tiles', function () { return outletTiles(env); });
    safe(rootEl, 'P&L waterfall', function () { return outletWaterfall(env); });
    safe(rootEl, 'Outlet comparison', function () { return comparisonCard(env); });
    safe(rootEl, 'Per-order economics', function () { return ui.grid([5, 7], [perOrderCard(env), streamChart(env)], { className: 'ue-pair' }); });
    safe(rootEl, 'Trend and break-even', function () { return ui.grid([7, 5], [trendChart(env), breakEvenChart(env)], { className: 'ue-pair' }); });
    safe(rootEl, 'Full P&L', function () { return detailCard(env); });
  }

  MK.router.register({
    id: 'costs-unit-economics',
    route: '#/costs/unit-economics',
    group: 'Costs',
    title: 'Unit economics',
    subtitle: 'Per-outlet P&L and per-order economics',
    units: 'all',
    roles: null,
    filters: ['date'],
    render: render
  });
})(window);
