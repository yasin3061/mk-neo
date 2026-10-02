/*
 * #/factory/overview - Factory economics: the central kitchen as a cost centre (client brief area 8).
 *
 * The factory has no customers. Its income is the transfer value of what it dispatches to the five
 * outlets, so every ratio on this screen is a share of transfer value and the result is over- or
 * under-absorption. Factory costs are booked by whole month, so the page works in months: the global
 * date filter decides which month is shown (the last month its range touches; the running month is
 * month to date with fixed costs accrued pro rata) and a page-local switch (ctx.state) flips to any
 * other month of the data.
 *
 * Blocks, in reading order:
 *   header      purpose, month switch, period label, notes, the transfer-pricing convention
 *   KPI row     output, transfer value, cost, absorption, cost per kg, yield, wastage, capacity, fill rate, share of network sales
 *   bridge      transfer value -> raw material -> people -> rent -> power -> gas -> logistics -> other -> absorption
 *   cost per kg raw material / labour / utilities / overhead by product against the standard transfer price
 *   absorption  by month (diverging) and the variance analysis of the selected month
 *   prices      raw-material purchase price variance by item
 *   outlets     transfer value by outlet and the logistics cost per kg each outlet carries
 *
 * Every figure comes from MK.factory / MK.finance and is formatted with MK.fmt; subtitles are
 * sentences composed from those figures. Role scope is applied by the data layer: the page only
 * decides what still makes sense for what it receives (the factory manager does not see outlet
 * P&L lines, so the logistics-per-kg card explains itself instead of showing an empty chart).
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates;

  var PAGE_ID = 'factory-overview';

  /* layout constants (pixels and UI rules, never data) */
  var H_BRIDGE = 340;
  var H_CHART = 300;
  var H_SMALL = 280;
  var PPV_MAX_BARS = 10;          /* a diverging bar chart stays readable to about ten categories; the table twin carries every item */

  var SRC_ERP = ['erp'];
  var SRC_TRANSFER = ['erp', 'petpooja'];   /* quantities reconcile against Petpooja transfers; prices and costs are the ERP's */

  var COST_PARTS = [
    { key: 'rmPerKg', id: 'rm', name: 'Raw material', colourVar: '--series-1' },
    { key: 'labourPerKg', id: 'labour', name: 'Labour', colourVar: '--series-2' },
    { key: 'utilitiesPerKg', id: 'utilities', name: 'Utilities', colourVar: '--series-3' },
    { key: 'overheadPerKg', id: 'overhead', name: 'Overhead', colourVar: '--series-4' }
  ];

  /* how the factory's cost lines roll into the bridge; anything not named here is "other running costs" */
  var WF_PEOPLE = { salaries: 1, employer_oncosts: 1, staff_meals: 1, staff_accommodation: 1 };
  var WF_RENT = { rent: 1, rent_gst: 1, cam: 1 };

  var VARIANCE_LABELS = {
    rmPrice: 'Raw-material prices against standard',
    rmYield: 'Yield against standard',
    wastageAndWriteOffs: 'Wastage and write-offs',
    finishedStockBuild: 'Finished stock built, not yet dispatched',
    labour: 'Labour against the standard conversion',
    utilities: 'Utilities against the standard conversion',
    overhead: 'Overhead against the standard conversion',
    logistics: 'Logistics recovered against cost',
    other: 'Rounding and other'
  };
  var VARIANCE_ORDER = ['rmPrice', 'rmYield', 'wastageAndWriteOffs', 'finishedStockBuild', 'labour', 'utilities', 'overhead', 'logistics', 'other'];
  /* the same drivers in the short form a sentence wants */
  var VARIANCE_SHORT = {
    rmPrice: 'raw-material prices', rmYield: 'yield', wastageAndWriteOffs: 'wastage and write-offs',
    finishedStockBuild: 'finished stock built', labour: 'labour', utilities: 'gas, power and water',
    overhead: 'overhead', logistics: 'logistics', other: 'rounding'
  };

  /* ------------------------------------------------------------------ small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v) { return isNum(v) ? v : 0; }
  function r1(v) { return Math.round(num(v) * 10) / 10; }
  function r2(v) { return Math.round(num(v) * 100) / 100; }

  function money(v) { return isNum(v) ? fmt.inrFull(Math.round(v)) : '-'; }
  function perKg(v) { return isNum(v) ? fmt.inrFull(v, 2) : '-'; }

  function call(fn, fallback) {
    try { var v = fn(); return v === undefined ? fallback : v; } catch (e) {
      if (root.console) root.console.error('[' + PAGE_ID + '] data call failed', e);
      return fallback;
    }
  }

  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  function rangeLabel(from, to) {
    if (!from || !to) return '';
    if (from === to) return D.label(from, 'd MMM yyyy');
    var sameYear = from.slice(0, 4) === to.slice(0, 4);
    return D.label(from, sameYear ? 'd MMM' : 'd MMM yyyy') + ' - ' + D.label(to, 'd MMM yyyy');
  }

  function bandText(band, format) {
    if (!band || band.length !== 2) return '';
    var f = format || function (v) { return fmt.pct(v, 1); };
    return 'Target ' + f(band[0]) + ' to ' + f(band[1]);
  }
  function inBand(v, band) { return !band || !isNum(v) ? true : (v >= band[0] && v <= band[1]); }

  function tidy(delta, zeroLabel) {
    if (!delta || delta.value === null || delta.value === undefined) return null;
    if (delta.dir !== 'flat') return delta;
    return { value: delta.value, label: zeroLabel, dir: 'flat' };
  }
  function pointsDelta(cur, prev) { return isNum(cur) && isNum(prev) ? tidy(fmt.points(cur, prev), fmt.num(0, 1) + ' pts') : null; }
  function pctDelta(cur, prev) { return isNum(cur) && isNum(prev) && prev ? tidy(fmt.delta(cur, prev), fmt.pct(0)) : null; }

  function note(text, iconName, extra) {
    return h('p', { 'class': 'fo-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, text), extra || null);
  }

  function sourceEnd(ids) {
    var tag = ui.sourceTag(ids);
    tag.classList.add('fo-source-end');
    return tag;
  }

  /**
   * Grid cell wrapper. MK.charts rewrites the card's className on every draw (js/core/charts.js), which
   * drops the mk-col-* class MK.ui.grid puts on a child of a 12-column grid: the card would collapse the
   * first time a reader switches it to its table twin. Wrapping keeps the span on an element the kit
   * never touches; the card inside stretches to the row height.
   */
  function cell(node) { return node ? h('div', { 'class': 'fo-cell' }, node) : null; }

  function plural(n, one, many) { return fmt.num(n) + ' ' + (Math.abs(n) === 1 ? one : many); }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''; }

  function andList(items) {
    var list = (items || []).filter(Boolean);
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  /** Muted note carrying the limitation the capability matrix states for a Petpooja field. */
  function capabilityNote(fieldKey) {
    if (!MK.data || typeof MK.data.capability !== 'function') return null;
    var cap = call(function () { return MK.data.capability(fieldKey); }, null);
    var can = call(function () { return MK.data.can('petpooja', fieldKey); }, null);
    if (!cap || can !== 'partial' || !cap.note) return null;
    return note('Indent and transfer quantities are reconciled against Petpooja, which supplies ' + lowerFirst(cap.note) +
      '. The transfer prices and every cost on this screen are the ERP\'s own.', 'info');
  }

  /** Inline bar growing left or right from a centred zero line - the kit has no diverging table cell. */
  function divBarCell(format) {
    return function (value, row, col, ctx) {
      var rows = (ctx && ctx.rows) || [];
      var max = 0;
      rows.forEach(function (r) { var v = r[col.key]; if (isNum(v)) max = Math.max(max, Math.abs(v)); });
      var share = (max > 0 && isNum(value)) ? Math.min(1, Math.abs(value) / max) : 0;
      var neg = isNum(value) && value < 0;
      return h('div', { 'class': 'fo-divbar' },
        h('span', { 'class': 'fo-divbar__track', 'aria-hidden': 'true' },
          h('span', {
            'class': ['fo-divbar__fill', neg ? 'is-neg' : 'is-pos'],
            style: { width: (share * 50).toFixed(1) + '%', left: neg ? (50 - share * 50).toFixed(1) + '%' : '50%' }
          })),
        h('span', { 'class': 'fo-divbar__value' }, ui.format(format || col.format, value, row)));
    };
  }

  /* ------------------------------------------------------------------ period */

  function monthName(row) { return D.monthLabel(row.monthKey, false) + (row.partial ? ' MTD' : ''); }

  function touchedMonths(f, keys) {
    var from = f && f.from ? f.from.slice(0, 7) : keys[0];
    var to = f && f.to ? f.to.slice(0, 7) : keys[keys.length - 1];
    var hit = keys.filter(function (k) { return k >= from && k <= to; });
    return hit.length ? hit : [keys[keys.length - 1]];
  }

  function filterIsWholeMonth(f, monthKey) {
    if (!f || !f.from || !f.to) return false;
    var dataEnd = MK.calendar && MK.calendar.dataEnd;
    return f.from === monthKey + '-01' && (f.to === D.monthEnd(monthKey + '-01') || f.to === dataEnd);
  }

  /* ------------------------------------------------------------------ environment */

  function buildEnv(ctx) {
    var st = ctx.state;
    var trend = call(function () { return MK.finance.pnlTrend('factory'); }, null);
    var monthRows = (trend && trend.rows) || [];
    if (!monthRows.length) return null;

    var keys = monthRows.map(function (r) { return r.monthKey; });
    var touched = touchedMonths(ctx.filters, keys);
    var fromFilter = touched[touched.length - 1];
    var sel = (st.month && keys.indexOf(st.month) !== -1) ? st.month : fromFilter;

    var pnl = call(function () { return MK.factory.pnl(sel); }, null);
    var period = (pnl && pnl.period) || null;
    var range = { from: (period && period.from) || (sel + '-01'), to: (period && period.to) || D.monthEnd(sel + '-01') };

    var env = {
      ctx: ctx, st: st, monthRows: monthRows, keys: keys, touched: touched, sel: sel,
      overridden: sel !== fromFilter, period: period, range: range, pnl: pnl,
      prevKey: keys.indexOf(sel) > 0 ? keys[keys.indexOf(sel) - 1] : null,
      summary: call(function () { return MK.factory.summary(range); }, null),
      costing: call(function () { return MK.factory.costing(sel); }, null),
      purchases: call(function () { return MK.factory.purchases(sel); }, null),
      dispatch: call(function () { return MK.factory.dispatch(range); }, null),
      production: call(function () { return MK.factory.production(range); }, null)
    };
    env.targets = (env.summary && env.summary.targets) || {};
    env.prevCosting = env.prevKey ? call(function () { return MK.factory.costing(env.prevKey); }, null) : null;
    env.months = monthRows.map(function (r) {
      var p = call(function () { return MK.factory.pnl(r.monthKey); }, null);
      return { key: r.monthKey, label: D.monthLabel(r.monthKey, false), partial: r.partial, pnl: p };
    });
    return env;
  }

  /* ------------------------------------------------------------------ header */

  function header(env) {
    var ctx = env.ctx, st = env.st, period = env.period;
    var box = h('section', { 'class': 'fo-head' });

    box.appendChild(h('p', { 'class': 'fo-intro' },
      'The central kitchen has no customers: it earns the transfer value of what it sends to the five outlets, so every ratio here is a share of ' +
      'that transfer value and the bottom line is how much of its cost the transfer prices recovered.'));

    var options = env.monthRows.map(function (r) { return { value: r.monthKey, label: monthName(r) }; });
    var bar = h('div', { 'class': 'fo-period' },
      h('div', { 'class': 'fo-period__switch' },
        h('span', { 'class': 'mk-label' }, 'Month'),
        ui.segmented({
          ariaLabel: 'Month', size: 'sm', value: env.sel, options: options,
          onChange: function (v) { st.month = v; ctx.rerender(); }
        })),
      h('div', { 'class': 'fo-period__label' },
        ui.icon('calendar', 14), h('span', { 'class': 'mk-muted' }, 'Period'),
        h('strong', null, (period && (period.periodLabel || period.label)) || rangeLabel(env.range.from, env.range.to))),
      h('div', { 'class': 'fo-period__actions' }, headerActions(env)));
    box.appendChild(bar);

    var notes = h('div', { 'class': 'fo-notes' });
    if (period && period.partial) {
      notes.appendChild(note('Month to date (' + fmt.num(period.elapsedDays) + ' of ' + fmt.num(period.daysInMonth) +
        ' days): output and dispatch are actuals so far, monthly fixed costs are accrued pro rata so the ratios stay comparable.', 'clock'));
    }
    var f = ctx.filters || {};
    if (env.overridden) {
      notes.appendChild(note('Quick switch: showing ' + D.monthLabel(env.sel, true) + ', while the date filter covers ' + rangeLabel(f.from, f.to) + '.', 'calendar',
        ui.button({ label: 'Back to the filter period', variant: 'text', size: 'sm', onClick: function () { st.month = null; ctx.rerender(); } })));
    } else if (!filterIsWholeMonth(f, env.sel)) {
      notes.appendChild(note('Factory costs are booked by whole month: the date filter (' + rangeLabel(f.from, f.to) + ') ends in ' +
        D.monthLabel(env.sel, true) + ', shown here' + (period && period.partial ? ' to date' : ' in full') + '. Use the switch for another month.', 'calendar'));
    }
    if (notes.childNodes.length) box.appendChild(notes);
    return box;
  }

  function headerActions(env) {
    var ctx = env.ctx;
    var may = call(function () { return MK.session.can('bill.create', { unitId: 'factory' }); }, { ok: false, reason: '' });
    return [
      ui.button({
        label: 'Raise a factory bill', icon: 'plus', size: 'sm',
        disabledReason: may.ok ? '' : may.reason,
        title: may.ok ? 'Open the bills register with the factory selected' : '',
        onClick: function () { ctx.navigate('approvals-bills', { unit: 'factory', month: env.sel }); }
      }),
      ui.link('Factory bills', MK.router.href('approvals-bills', { unit: 'factory', month: env.sel }), { icon: 'receipt' })
    ];
  }

  /* ------------------------------------------------------------------ KPI row */

  /**
   * One caption for the whole KPI row instead of the same comparison printed on ten tiles: the note is
   * nowrap in the kit and a full range ("16 Aug - 31 Aug 2026") runs past a fifth-width tile into its
   * neighbour. Stating the baselines once is also denser and says plainly that cost per kg uses another one.
   */
  function kpiCaption(env, prev, hasCostDelta) {
    var parts = [];
    if (prev) parts.push('against ' + rangeLabel(prev.from, prev.to) + ', the period before this one');
    if (hasCostDelta) parts.push('cost per kg against ' + D.monthLabel(env.prevKey, true));
    if (!parts.length) return null;
    return h('p', { 'class': 'fo-kpinote mk-small mk-muted' }, 'Change is measured ' + parts.join('; ') + '.');
  }

  function kpis(env) {
    var s = env.summary, p = env.pnl, c = env.costing, t = env.targets;
    var prev = (s && s.prev) || null;
    var totals = (c && c.totals) || {};
    var absBand = t.absorptionPct;
    var absOk = inBand(p && p.absorptionPct, absBand);
    var flags = (env.production && env.production.yieldFlags) || [];
    var prevCostPerKg = env.prevCosting && env.prevCosting.totals ? env.prevCosting.totals.costPerKg : null;

    var tiles = [
      {
        label: 'Output', icon: 'factory', value: fmt.kg(num(s && s.outputKg), 0),
        delta: prev ? fmt.delta(num(s && s.outputKg), num(prev.outputKg)) : null,
        sub: fmt.kg(num(s && s.kgPerDay), 0) + ' a day, good output after process wastage'
      },
      {
        label: 'Transfer value', icon: 'truck', value: fmt.inr(num(s && s.transferValue)),
        delta: prev ? fmt.delta(num(s && s.transferValue), num(prev.transferValue)) : null,
        sub: perKg(totals.transferPricePerKg) + ' per kg dispatched'
      },
      {
        label: 'Actual cost', icon: 'coins', value: fmt.inr(num(p && p.totalCost)),
        sub: 'Raw material, conversion and logistics',
        title: 'Raw materials consumed ' + money(p && p.rmConsumed) + ', conversion ' + money(p && p.conversion && p.conversion.total) + ', logistics ' + money(p && p.logisticsCost)
      },
      {
        label: (p && p.absorption < 0 ? 'Under-absorbed' : 'Over-absorbed'), icon: 'scale',
        value: fmt.inr(Math.abs(num(p && p.absorption))), goodWhen: 'neutral',
        tone: absOk ? 'good' : 'warn',
        sub: fmt.pct(num(p && p.absorptionPct)) + ' of transfer value' +
          (absBand && absBand.length === 2 ? '; aim within ' + fmt.pct(absBand[0], 0) + ' to ' + fmt.pct(absBand[1], 0) : ''),
        title: 'Transfer value plus logistics recharged, less every factory cost above depreciation. Near zero is the aim: a large gap means the standards no longer match reality.'
      },
      {
        label: 'Cost per kg', icon: 'calculator', value: perKg(totals.costPerKg),
        delta: pctDelta(totals.costPerKg, prevCostPerKg), goodWhen: 'down',
        sub: 'Transfer price ' + perKg(totals.transferPricePerKg) + ' per kg'
      },
      {
        label: 'Yield against standard', icon: 'check-circle', value: fmt.pct(num(s && s.yieldIndex)),
        delta: prev ? pointsDelta(s && s.yieldIndex, prev.yieldIndex) : null,
        sub: flags.length
          ? flags[0].name + ' is ' + fmt.pct(Math.abs(num(flags[0].yieldVariancePct))) + ' below standard, ' + money(flags[0].value) + ' of extra input'
          : 'Production weighted; no product is flagged below standard',
        tone: flags.length ? 'warn' : null,
        title: fmt.pct(1, 0) + ' means every line ran at the standard yield it was costed on.',
        onClick: function () { env.ctx.navigate('factory-production'); }
      },
      {
        label: 'Process wastage', icon: 'trash', value: fmt.pct(num(s && s.wastagePct)), goodWhen: 'down',
        delta: prev ? pointsDelta(s && s.wastagePct, prev.wastagePct) : null,
        sub: bandText(t.wastagePct) + '; write-offs ' + fmt.pct(num(s && s.writeOffPct)),
        tone: inBand(s && s.wastagePct, t.wastagePct) ? null : 'warn'
      },
      {
        label: 'Capacity used', icon: 'layers', value: fmt.pct(num(s && s.capacityUtilisation)), goodWhen: 'neutral',
        sub: fmt.kg(num(s && s.kgPerDay), 0) + ' of ' + fmt.kg(num(s && s.capacityKgPerDay), 0) + ' a day',
        tone: inBand(s && s.capacityUtilisation, t.capacityUtilisation) ? null : 'warn'
      },
      {
        label: 'Fill rate', icon: 'truck', value: fmt.pct(num(s && s.fillRate)),
        delta: prev ? pointsDelta(s && s.fillRate, prev.fillRate) : null,
        sub: 'Mumbai ' + fmt.pct(num(s && s.fillRateMumbai)) + ', Pune ' + fmt.pct(num(s && s.fillRatePune)),
        tone: (inBand(s && s.fillRateMumbai, t.fillRateMumbai) && inBand(s && s.fillRatePune, t.fillRatePune)) ? null : 'warn',
        onClick: function () { env.ctx.navigate('factory-production'); }
      },
      factoryShareTile(env)
    ];
    return h('div', { 'class': 'fo-kpiblock' }, ui.kpiRow(tiles),
      kpiCaption(env, prev, isNum(prevCostPerKg) && isNum(totals.costPerKg)), ui.sourceTag(SRC_TRANSFER));
  }

  function factoryShareTile(env) {
    var p = env.pnl;
    var share = p ? p.factoryCostPctOfNetworkSales : null;
    var withheld = p && p.networkNetSales === null;
    if (!isNum(share)) {
      return { label: 'Factory cost, share of network sales', icon: 'chart', value: '-', sub: 'Network sales are outside this view' };
    }
    return {
      label: 'Factory cost, share of network sales', icon: 'chart', value: fmt.pct(share),
      sub: withheld
        ? 'Conversion, logistics and depreciation; rounded to a tenth of a point'
        : 'Conversion, logistics and depreciation against ' + fmt.inr(num(p.networkNetSales)) + ' of network sales',
      title: 'Transfer value is a further ' + fmt.pct(num(p.transferValuePctOfNetworkSales)) + ' of network net sales.'
    };
  }

  /* ------------------------------------------------------------------ the bridge */

  function bridgeCard(env) {
    var p = env.pnl;
    if (!p || !MK.charts) return null;

    var b = { people: 0, rent: 0, power: 0, gas: 0, logistics: 0, other: 0 };
    (p.lines || []).forEach(function (l) {
      if (l.bucket === 'below_ebitda' || l.categoryId === 'depreciation' || l.bucket === 'rm') return;
      if (l.bucket === 'logistics') { b.logistics += num(l.amount); return; }
      if (WF_PEOPLE[l.categoryId]) { b.people += num(l.amount); return; }
      if (WF_RENT[l.categoryId]) { b.rent += num(l.amount); return; }
      if (l.categoryId === 'electricity') { b.power += num(l.amount); return; }
      if (l.categoryId === 'gas_lpg') { b.gas += num(l.amount); return; }
      b.other += num(l.amount);
    });
    /* the closing figure is the data layer's absorption: any rupee of rounding rides in "other" */
    b.other += num(p.totalCost) - (num(p.rmConsumed) + b.people + b.rent + b.power + b.gas + b.logistics + b.other);

    var steps = [
      { label: 'Transfer value', value: num(p.transferValue), kind: 'total' },
      { label: 'Logistics recharged', value: num(p.logisticsRecovery), kind: 'plus' },
      { label: 'Raw materials', value: num(p.rmConsumed), kind: 'minus' },
      { label: 'People', value: b.people, kind: 'minus' },
      { label: 'Rent', value: b.rent, kind: 'minus' },
      { label: 'Power', value: b.power, kind: 'minus' },
      { label: 'Gas', value: b.gas, kind: 'minus' },
      { label: 'Logistics', value: b.logistics, kind: 'minus' },
      { label: 'Other costs', value: b.other, kind: 'minus' },
      { label: 'Absorption', value: num(p.absorption), kind: 'total' }
    ];

    var biggest = null;
    ['people', 'rent', 'power', 'gas', 'logistics', 'other'].forEach(function (k) { if (!biggest || b[k] > b[biggest]) biggest = k; });
    var conv = num(p.conversion && p.conversion.total);
    var absOk = inBand(p.absorptionPct, env.targets.absorptionPct);

    var band = env.targets.absorptionPct || [];
    var chart = MK.charts.mount(null, {
      id: 'fo-bridge', kind: 'waterfall', height: H_BRIDGE, format: 'inr',
      title: 'From transfer value to absorption',
      subtitle: money(p.transferValue) + ' of transfers plus ' + money(p.logisticsRecovery) + ' of logistics recharged, against ' + money(p.totalCost) +
        ' of cost: the kitchen recovered ' + money(Math.abs(p.absorption)) + (num(p.absorption) < 0 ? ' less' : ' more') + ' than it spent, ' +
        fmt.pct(num(p.absorptionPct)) + ' of transfer value' +
        (band.length === 2 ? ' (' + (absOk ? 'inside' : 'outside') + ' the ' + fmt.pct(band[0], 0) + ' to ' + fmt.pct(band[1], 0) + ' band)' : '') + '.',
      data: { steps: steps, stepHeader: 'Line', kindLabels: { total: 'Result', minus: 'Cost', plus: 'Recovered' } },
      note: 'Conversion cost (people, rent, power, gas and other running costs) is ' + money(conv) + ' against ' + money(p.conversionAbsorbed) +
        ' absorbed at the standard rate on ' + fmt.kg(num(p.dispatchKg), 0) + ' dispatched. Logistics is recharged to the outlets at cost, so it nets out. Depreciation of ' +
        money(p.depreciation) + ' sits below this line.'
    });
    chart.el.appendChild(sourceEnd(SRC_ERP));
    return chart.el;
  }

  /* ------------------------------------------------------------------ cost per kg by product */

  function costPerKgCard(env) {
    var c = env.costing;
    var rows = (c && c.rows) || [];
    if (!MK.charts) return null;
    if (!rows.length) return ui.card({ title: 'Cost per kg by product', body: ui.emptyState('No production costed in this month', null, { compact: true }) });

    var sorted = rows.slice().sort(function (a, b) { return num(b.costPerKg) - num(a.costPerKg); });
    var worst = sorted.slice().sort(function (a, b) { return num(a.marginPerKg) - num(b.marginPerKg); })[0];
    var below = sorted.filter(function (r) { return num(r.marginPerKg) < 0; });
    var split = (c && c.stdConversionSplit) || {};

    var tableRows = sorted.map(function (r) {
      return {
        name: r.name, outputKg: r1(r.outputKg), rmPerKg: r2(r.rmPerKg), labourPerKg: r2(r.labourPerKg),
        utilitiesPerKg: r2(r.utilitiesPerKg), overheadPerKg: r2(r.overheadPerKg),
        costPerKg: r2(r.costPerKg), transferPrice: num(r.transferPrice), marginPerKg: r2(r.marginPerKg)
      };
    });

    var chart = MK.charts.mount(null, {
      id: 'fo-costperkg', kind: 'hstackedBar', height: H_CHART, format: perKgFormat,
      title: 'Cost per kg by product',
      subtitle: worst
        ? worst.name + ' costs ' + perKg(worst.costPerKg) + ' a kg against a transfer price of ' + money(worst.transferPrice) + ': ' +
          (num(worst.marginPerKg) < 0
            ? perKg(Math.abs(worst.marginPerKg)) + ' a kg is not recovered on ' + fmt.kg(num(worst.outputKg), 0) + ' produced. ' +
              plural(below.length, 'product of', 'products of') + ' ' + fmt.num(sorted.length) + ' cost more than the transfer price.'
            : 'every product is inside its transfer price this month.')
        : '',
      data: {
        categories: sorted.map(function (r) { return r.name; }),
        categoryHeader: 'Product',
        series: COST_PARTS.map(function (part) {
          return { id: part.id, name: part.name, colourVar: part.colourVar, values: sorted.map(function (r) { return r2(r[part.key]); }) };
        })
      },
      table: {
        columns: [
          { key: 'name', label: 'Product', maxWidth: 170 },
          { key: 'outputKg', label: 'Output', format: 'kg', align: 'right' },
          { key: 'rmPerKg', label: 'Raw material', format: 'inrFull', align: 'right' },
          { key: 'labourPerKg', label: 'Labour', format: 'inrFull', align: 'right' },
          { key: 'utilitiesPerKg', label: 'Utilities', format: 'inrFull', align: 'right' },
          { key: 'overheadPerKg', label: 'Overhead', format: 'inrFull', align: 'right' },
          { key: 'costPerKg', label: 'Cost per kg', format: 'inrFull', align: 'right' },
          { key: 'transferPrice', label: 'Transfer price', format: 'inrFull', align: 'right' },
          { key: 'marginPerKg', label: 'Recovered per kg', format: 'inrFull', align: 'right' }
        ],
        rows: tableRows
      },
      note: 'Transfer price = standard raw-material cost + ' + money(c.stdConversionPerKg) + ' of standard conversion per kg (labour ' + money(split.labour) +
        ', utilities ' + money(split.utilities) + ', overhead ' + money(split.overhead) + ', set with the budgets in March). Everything the factory spends above those ' +
        'standards stays in the factory, so an outlet food cost is never moved by a factory miss. Switch to Table for cost and transfer price side by side.'
    });
    chart.el.appendChild(sourceEnd(SRC_ERP));
    return chart.el;
  }

  function perKgFormat(v, where) {
    if (!isNum(v)) return '-';
    if (where === 'axis') return fmt.inrFull(Math.round(v));
    if (where === 'tooltip' || where === 'table') return fmt.inrFull(v, 2);
    return fmt.inrFull(Math.round(v));
  }

  /* ------------------------------------------------------------------ absorption by month */

  function absorptionCard(env) {
    var months = env.months.filter(function (m) { return m.pnl; });
    if (!MK.charts || !months.length) return null;

    var values = months.map(function (m) { return num(m.pnl.absorptionPct); });
    var band = (env.targets.absorptionPct && env.targets.absorptionPct.length === 2) ? env.targets.absorptionPct : null;
    var bandText2 = band ? fmt.pct(band[0], 0) + ' to ' + fmt.pct(band[1], 0) + ' band' : 'target band';
    var span = months[0].label + ' to ' + months[months.length - 1].label;
    var worst = months.slice().sort(function (a, b) { return num(a.pnl.absorptionPct) - num(b.pnl.absorptionPct); })[0];
    var outside = months.filter(function (m) { return !inBand(m.pnl.absorptionPct, band); });
    var gas = months.slice().sort(function (a, b) { return num(a.pnl.variance && a.pnl.variance.utilities) - num(b.pnl.variance && b.pnl.variance.utilities); })[0];
    var drivers = worstDrivers(worst.pnl.variance, 2);
    var worstRm = num(worst.pnl.variance && worst.pnl.variance.rmPrice);

    var chart = MK.charts.mount(null, {
      id: 'fo-absorption', kind: 'divergingBar', height: H_SMALL, format: 'pct',
      title: 'Absorption by month',
      subtitle: 'How much of its cost the transfer prices recovered, ' + span + '. ' +
        (outside.length
          ? andList(outside.map(function (m) { return m.label; })) + ' fell outside the ' + bandText2 + '; '
          : 'Every month landed inside the ' + bandText2 + '; ') +
        worst.label + ' was the weakest at ' + fmt.pct(num(worst.pnl.absorptionPct)) + ' of transfer value' +
        (drivers.length ? ', where ' + andList(drivers.map(function (d) { return d.short + ' cost ' + money(Math.abs(d.value)); })) : '') + '.',
      data: {
        categories: months.map(function (m) { return m.label + (m.partial ? ' MTD' : ''); }),
        values: values, name: 'Absorption', categoryHeader: 'Month',
        zeroLabel: 'Full recovery', posLabel: 'Over-absorbed', negLabel: 'Under-absorbed'
      },
      note: gasNote(env, months, gas) + ' Raw-material prices swing the rest: ' +
        (worstRm < 0
          ? money(Math.abs(worstRm)) + ' above standard in ' + worst.label + ' alone.'
          : 'they were ' + money(worstRm) + ' below standard in ' + worst.label + ', which is what keeps that month from being worse.')
    });
    chart.el.appendChild(sourceEnd(SRC_ERP));
    return chart.el;
  }

  /** The gas story, stated from the utilities variance of every month rather than from a fixed sentence. */
  function gasNote(env, months, worstGas) {
    var split = (env.costing && env.costing.stdConversionSplit) || {};
    var over = months.filter(function (m) { return num(m.pnl.variance && m.pnl.variance.utilities) < 0; });
    if (!over.length) return 'Gas, power and water came in at or under the ' + money(num(split.utilities)) + ' per kg standard in every month shown.';
    return 'Gas is the standing overrun: the standard of ' + money(num(split.utilities)) + ' per kg was set at the January cylinder price, and the gas, power and water bill ran above it in ' +
      (over.length === months.length ? 'every one of the ' + plural(months.length, 'month', 'months') : plural(over.length, 'month', 'months') + ' of ' + fmt.num(months.length)) +
      ', worst in ' + worstGas.label + ' at ' + money(Math.abs(num(worstGas.pnl.variance.utilities))) + '.';
  }

  /** The largest ADVERSE drivers only: a favourable line is not a reason a month was weak. */
  function worstDrivers(variance, n) {
    var list = [];
    VARIANCE_ORDER.forEach(function (k) {
      if (!variance || !isNum(variance[k]) || Math.round(variance[k]) >= 0) return;
      list.push({ key: k, label: VARIANCE_LABELS[k] || k, short: VARIANCE_SHORT[k] || k, value: variance[k] });
    });
    list.sort(function (a, b) { return a.value - b.value; });
    return list.slice(0, n || 2);
  }

  /* ------------------------------------------------------------------ variance analysis of the month */

  function varianceCard(env) {
    var p = env.pnl;
    var v = (p && p.variance) || null;
    if (!v) return null;
    var rows = VARIANCE_ORDER.filter(function (k) { return isNum(v[k]) && Math.round(v[k]) !== 0; }).map(function (k) {
      return { driver: VARIANCE_LABELS[k] || k, effect: Math.round(v[k]) };
    });
    rows.sort(function (a, b) { return a.effect - b.effect; });

    var body = rows.length
      ? ui.table({
        dense: true,
        columns: [
          { key: 'driver', label: 'Driver', wrap: true },
          { key: 'effect', label: 'Effect on absorption', format: 'inrFull', align: 'right', render: divBarCell('inrFull'), width: 190 }
        ],
        rows: rows,
        footer: { driver: num(p.absorption) < 0 ? 'Under-absorbed' : 'Over-absorbed', effect: Math.round(num(p.absorption)) }
      })
      : ui.emptyState('No variance to report for this month', null, { compact: true });

    return ui.card({
      title: 'What moved absorption', flush: rows.length > 0,
      subtitle: 'Against the standards behind the transfer price. Favourable adds to recovery, unfavourable takes from it; the lines add to the result.',
      body: body,
      footer: ui.sourceTag(SRC_ERP)
    });
  }

  /* ------------------------------------------------------------------ purchase price variance */

  function ppvCard(env) {
    var pu = env.purchases;
    var rows = (pu && pu.rows) || [];
    if (!MK.charts) return null;
    if (!rows.length) return ui.card({ title: 'Raw-material purchase price variance', body: ui.emptyState('No purchases in this month', null, { compact: true }) });

    /* the data layer reports PPV with "+ unfavourable"; the chart reads left to right as bad to good, so it is signed the other way */
    var priced = rows.filter(function (r) { return isNum(r.ppv) && Math.round(r.ppv) !== 0; })
      .map(function (r) { return { row: r, gain: -Math.round(r.ppv) }; });
    priced.sort(function (a, b) { return Math.abs(b.gain) - Math.abs(a.gain); });
    var shown = priced.slice(0, PPV_MAX_BARS);
    shown.sort(function (a, b) { return b.gain - a.gain; });

    var best = priced.slice().sort(function (a, b) { return b.gain - a.gain; })[0];
    var worst = priced.slice().sort(function (a, b) { return a.gain - b.gain; })[0];
    var totals = (pu && pu.totals) || {};

    var tableRows = rows.slice().sort(function (a, b) { return num(a.ppv) - num(b.ppv); }).map(function (r) {
      return {
        name: r.name, qty: r1(r.qty), price: num(r.price), stdPrice: num(r.stdPrice),
        gain: -Math.round(num(r.ppv)), gainPct: -num(r.ppvPct), vendorName: r.vendorName
      };
    });

    var chart = MK.charts.mount(null, {
      id: 'fo-ppv', kind: 'divergingBar', height: H_CHART, format: 'inrFull',
      title: 'Raw-material purchase price variance',
      subtitle: (best && best.gain > 0 ? best.row.name + ' at ' + money(best.row.price) + ' against a ' + money(best.row.stdPrice) +
        ' standard saved ' + money(best.gain) : 'No item was bought below standard') +
        (worst && worst.gain < 0 ? '; ' + lowerFirst(worst.row.name) + ' at ' + money(worst.row.price) + ' against ' + money(worst.row.stdPrice) +
          ' cost ' + money(Math.abs(worst.gain)) : '') + '. Net ' +
        (num(totals.ppv) <= 0 ? money(Math.abs(num(totals.ppv))) + ' favourable' : money(num(totals.ppv)) + ' unfavourable') + ' on ' + money(totals.value) + ' of purchases.',
      data: {
        categories: shown.map(function (x) { return x.row.name; }),
        values: shown.map(function (x) { return x.gain; }),
        name: 'Price variance', categoryHeader: 'Item',
        zeroLabel: 'At standard', posLabel: 'Bought below standard', negLabel: 'Bought above standard'
      },
      table: {
        columns: [
          { key: 'name', label: 'Item', maxWidth: 200 },
          { key: 'vendorName', label: 'Vendor', maxWidth: 180 },
          { key: 'qty', label: 'Bought', format: 'num1', align: 'right' },
          { key: 'price', label: 'Price', format: 'inrFull', align: 'right' },
          { key: 'stdPrice', label: 'Standard', format: 'inrFull', align: 'right' },
          { key: 'gain', label: 'Variance', format: 'inrFull', align: 'right' },
          { key: 'gainPct', label: 'Against standard', format: 'pct', align: 'right' }
        ],
        rows: tableRows
      },
      note: (priced.length > shown.length ? 'The ' + fmt.num(shown.length) + ' largest of ' + plural(priced.length, 'item', 'items') + ' are drawn; the table has every item. ' : '') +
        'Standard prices are the ones the transfer prices were built on, so a price swing lands in the factory, never in an outlet food cost.'
    });
    chart.el.appendChild(sourceEnd(SRC_ERP));
    return chart.el;
  }

  /* ------------------------------------------------------------------ outlets: transfer value and logistics */

  function transferByOutletCard(env) {
    var d = env.dispatch;
    var outlets = (d && d.outlets) || [];
    if (!MK.charts) return null;
    if (!outlets.length) return ui.card({ title: 'Transfer value by outlet', body: ui.emptyState('No dispatch in this period', null, { compact: true }) });

    var sorted = outlets.slice().sort(function (a, b) { return num(b.transferValue) - num(a.transferValue); });
    var top = sorted[0], total = num(d.totals && d.totals.transferValue);

    var chart = MK.charts.mount(null, {
      id: 'fo-transfer-outlet', kind: 'bar', height: H_SMALL, format: 'inr',
      title: 'Transfer value by outlet',
      subtitle: top ? top.label + ' takes ' + fmt.inr(num(top.transferValue)) + ', ' + fmt.pct(total > 0 ? num(top.transferValue) / total : null) +
        ' of everything the kitchen sent out, on ' + fmt.kg(num(top.dispatchKg), 0) + '.' : '',
      data: {
        categories: sorted.map(function (o) { return o.short || o.label; }),
        values: sorted.map(function (o) { return num(o.transferValue); }),
        name: 'Transfer value', colourVar: '--series-1', categoryHeader: 'Outlet'
      },
      note: 'Transfer value is what the outlet is charged for factory goods: it is the factory income and the outlet food cost, the same rupee on both sides.'
    });
    chart.el.appendChild(sourceEnd(SRC_TRANSFER));
    return chart.el;
  }

  function logisticsPerKgCard(env) {
    var d = env.dispatch;
    var outlets = (d && d.outlets) || [];
    var rows = [];
    outlets.forEach(function (o) {
      var p = call(function () { return MK.finance.pnl(o.id, env.sel); }, null);
      var line = null;
      ((p && p.lines) || []).forEach(function (l) { if (l.key === 'logistics_allocation') line = l; });
      if (!line || !num(o.dispatchKg)) return;
      rows.push({ id: o.id, label: o.short || o.label, name: o.label, amount: num(line.amount), kg: num(o.dispatchKg), perKg: num(line.amount) / num(o.dispatchKg), alternate: !!o.alternateDaySupply });
    });

    if (!rows.length) {
      /* two different reasons for no rows: nothing was dispatched, or the outlet cost lines are out of scope */
      return ui.card({
        title: 'Logistics cost per kg by outlet',
        body: outlets.length
          ? ui.emptyState('Outlet P&L lines are outside your scope',
            'The logistics pool is recharged to the five outlets and appears on their cost lines. Your role sees the factory only, so the split is not shown here; the pool itself is in the bridge above.',
            { icon: 'lock', compact: true })
          : ui.emptyState('No dispatch in this period', 'There is no logistics pool to share out when nothing left the kitchen.', { compact: true }),
        footer: ui.sourceTag(SRC_ERP)
      });
    }
    if (!MK.charts) return null;

    rows.sort(function (a, b) { return b.perKg - a.perKg; });
    var top = rows[0];
    var rest = rows.slice(1);
    var restAvg = rest.length ? rest.reduce(function (a, r) { return a + r.amount; }, 0) / rest.reduce(function (a, r) { return a + r.kg; }, 0) : null;

    var chart = MK.charts.mount(null, {
      id: 'fo-logistics-perkg', kind: 'bar', height: H_SMALL, format: perKgFormat,
      title: 'Logistics cost per kg by outlet',
      subtitle: top ? top.name + ' carries ' + perKg(top.perKg) + ' a kg' + (isNum(restAvg) ? ' against ' + perKg(restAvg) + ' for the other ' + fmt.num(rest.length) + ' outlets' : '') +
        (top.alternate ? ': the alternate-day van to Pune is charged to it in full, ' + money(top.amount) + ' this month.' : ': ' + money(top.amount) + ' this month.') : '',
      data: {
        categories: rows.map(function (r) { return r.label; }),
        values: rows.map(function (r) { return r2(r.perKg); }),
        name: 'Logistics per kg', colourVar: '--series-1', highlight: top ? top.label : null, categoryHeader: 'Outlet'
      },
      table: {
        columns: [
          { key: 'name', label: 'Outlet' },
          { key: 'supply', label: 'Supply' },
          { key: 'kg', label: 'Dispatched', format: 'kg', align: 'right' },
          { key: 'amount', label: 'Logistics recharged', format: 'inrFull', align: 'right' },
          { key: 'perKg', label: 'Per kg', format: 'inrFull', align: 'right' }
        ],
        rows: rows.map(function (r) {
          return { name: r.name, supply: r.alternate ? 'Alternate-day run' : 'Daily supply', kg: r1(r.kg), amount: Math.round(r.amount), perKg: r2(r.perKg) };
        })
      },
      note: 'The van rental, fuel and tolls are shared by kilograms carried; the Pune run is charged to the outlet it serves. The pool is recovered to the rupee, so this is a fair-share recharge, not a margin.'
    });
    chart.el.appendChild(sourceEnd(SRC_ERP));
    return chart.el;
  }

  /* ------------------------------------------------------------------ render */

  function render(rootEl, ctx) {
    var st = ctx.state;

    if (!MK.factory || !MK.finance || typeof MK.finance.pnlTrend !== 'function') {
      rootEl.appendChild(ui.callout('warn', 'The factory model is not loaded', 'This screen needs js/data/factory.js and js/data/finance.js.'));
      return;
    }

    var env = buildEnv(ctx);
    if (!env) {
      rootEl.appendChild(ui.emptyState('The central kitchen is not in your scope',
        (ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel + ' sees' : 'Your role sees') + ' the outlets only, so there is nothing to show here. The screens under Revenue and Costs carry the units you can see.',
        { icon: 'lock' }));
      return;
    }
    if (!env.overridden) st.month = null;    /* the local switch has caught up with the filter: follow the filter again */

    safe(rootEl, 'Header', function () { return header(env); });
    safe(rootEl, 'Key figures', function () { return kpis(env); });
    safe(rootEl, 'Bridge', function () { return bridgeCard(env); });

    safe(rootEl, 'Cost per kg', function () {
      return ui.grid([7, 5], [cell(costPerKgCard(env)), cell(absorptionCard(env))], { className: 'fo-row' });
    });
    safe(rootEl, 'Prices and variance', function () {
      return ui.grid([7, 5], [cell(ppvCard(env)), cell(varianceCard(env))], { className: 'fo-row' });
    });
    safe(rootEl, 'Outlets', function () {
      var indent = capabilityNote('inv.transfers');
      var grid = ui.grid([6, 6], [cell(transferByOutletCard(env)), cell(logisticsPerKgCard(env))], { className: 'fo-row' });
      return indent ? h('div', { 'class': 'fo-block' }, grid, indent) : grid;
    });
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/factory/overview',
    group: 'Factory',
    title: 'Factory economics',
    subtitle: 'Output, cost per kg, recovery and yield',
    units: 'factory',
    roles: null,
    filters: ['date'],
    render: render
  });
})(window);
