/*
 * #/costs/budget - Budget tracking: client brief area 3 (cost structure at banking level).
 *
 * Budgets are monthly, per unit and expense category. The month comes from the global date filter (the month of its
 * end date) with a page-local quick switch; the unit is page-local (every unit in the persona's scope, plus the total).
 *
 * Blocks, in reading order:
 *   header        purpose, unit tabs, month switch, how "committed" and "pipeline" are defined, the budget basis
 *   KPI tiles     budget, committed, in pipeline, estimated (only when present), remaining, lines over budget
 *   open month    while the month is open: what the last closed month ended with, one click away
 *   charts        variance by category (diverging, the ten largest) and budget vs committed by unit (grouped bars;
 *                 by month when the persona has a single unit)
 *   hotspots      unit x category lines over budget, ranked by the overrun that higher sales do not explain
 *   category table budget, committed, pipeline, variance, % used as a meter, status - sorted by overrun
 *   drawer        the bills behind a line (number, vendor, amount, status) with a link to #/approvals/bills
 *
 * Every figure is read fresh from MK.finance.budget / MK.workflow.bill on each render, so approving a bill on the
 * approvals screen moves pipeline to committed here. Aggregator costs of weeks without a statement are shown apart
 * and carry the estimate badge. Role scope is applied by the data layer.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;

  /* ------------------------------------------------------------------ layout constants (pixels and UI rules, never data) */

  var ALL = 'all';
  var PAGE_ID = 'costs-budget';
  var PAGE_CLASS = 'pg-costs-budget';
  var BILLS_PAGE = 'approvals-bills';
  var H_CHART = 320;
  var TOP_VARIANCES = 10;
  var TOP_HOTSPOTS = 8;
  var C_BUDGET = '--series-muted', C_COMMITTED = '--series-1';
  var STATUS_TONE = { OK: 'good', WATCH: 'warn', OVER: 'critical' };
  var STATUS_RANK = { OVER: 0, WATCH: 1, OK: 2 };

  /** The open category drawer, kept outside the page root so a re-render can refresh it: { d, monthKey, unitId, categoryId }. */
  var openDrawer = null;

  /* ------------------------------------------------------------------ small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v) { return isNum(v) ? v : 0; }

  function andList(items) {
    var list = (items || []).filter(Boolean);
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function rangeLabel(from, to) {
    if (!from || !to) return '';
    if (from === to) return MK.dates.label(from, 'd MMM yyyy');
    var sameYear = from.slice(0, 4) === to.slice(0, 4);
    return MK.dates.label(from, sameYear ? 'd MMM' : 'd MMM yyyy') + ' - ' + MK.dates.label(to, 'd MMM yyyy');
  }

  function signed(v) { return !isNum(v) ? '-' : (v > 0 ? '+' : '') + fmt.inrFull(v); }
  function signedCompact(v) { return !isNum(v) ? '-' : (v > 0 ? '+' : '') + fmt.inr(v); }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : many); }

  function note(text, iconName, extra) {
    return h('p', { 'class': 'bg-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, text), extra || null);
  }

  function sourceEnd(ids) {
    var tag = ui.sourceTag(ids);
    tag.classList.add('bg-source-end');
    return tag;
  }

  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[costs-budget] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  function call(fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; } catch (e) {
      if (root.console) root.console.error('[costs-budget] data call failed', e);
      return fallback;
    }
  }

  function byId(list, id, key) {
    var k = key || 'id';
    for (var i = 0; i < (list || []).length; i++) if (list[i][k] === id) return list[i];
    return null;
  }

  function isAggregatorLine(r) { return !!r && /^agg_/.test(String(r.categoryId || '')); }

  /**
   * Source tags of a block: costs are captured in the ERP; aggregator lines come from the weekly statements, and their
   * unsettled tail is an estimate. rows = the budget lines the block shows (default: every line of the result).
   */
  function sourcesOf(b, rows) {
    var s = (b && b.sources) || {};
    var list = rows || (b && b.rows) || [];
    var ids = [s.costs || 'erp'];
    if (list.some(isAggregatorLine)) (s.aggregatorActual || ['swiggy_annexure', 'zomato_settlement']).forEach(function (id) { ids.push(id); });
    if (list.some(function (r) { return num(r.estimatedPart) > 0; })) ids.push(s.aggregatorEstimated || 'estimate');
    return ids;
  }

  function estimateCaption() {
    var s = MK.config && MK.config.sources && MK.config.sources.estimate;
    return s ? s.caption : 'Estimated at contracted rates';
  }

  /** "Swiggy and Zomato", from the channel master. */
  function aggregatorNames() {
    var names = ((MK.config && MK.config.channels) || []).filter(function (c) { return c.kind === 'aggregator'; }).map(function (c) { return c.label; });
    return names.length ? andList(names) : 'the aggregators';
  }

  function groupLabel(id) {
    var g = byId((MK.config && MK.config.expenseGroups) || [], id);
    return g ? g.label : id;
  }

  /* ------------------------------------------------------------------ units, months */

  function unitOptions() {
    var allowed = MK.session.allowedUnitIds();
    var list = ((MK.config && MK.config.outlets) || []).filter(function (d) { return allowed.indexOf(d.id) !== -1; })
      .map(function (d) { return { id: d.id, label: d.short || d.name, name: d.name, type: d.type, colourVar: d.colourVar }; });
    if (list.length > 1) {
      var company = !!(MK.session.seesAllUnits && MK.session.seesAllUnits());
      list.unshift({ id: ALL, label: company ? 'Company' : 'All units', name: company ? 'Company, all units' : 'All units in scope', type: ALL, colourVar: null });
    }
    return list;
  }

  function monthName(m) { return MK.dates.monthLabel(m.monthKey, false) + (m.partial ? ' MTD' : ''); }

  function periodText(b) {
    var p = (b && b.period) || {};
    return p.partial ? (p.periodLabel || p.label || '') : (p.label || '');
  }

  function budgetOf(monthKey, unitId) {
    return call(function () { return MK.finance.budget(monthKey, unitId); }, null);
  }

  /* ------------------------------------------------------------------ bills behind a line */

  function billApi() { return MK.workflow && MK.workflow.bill ? MK.workflow.bill : null; }

  function stateGroup(status) {
    var api = billApi();
    if (api && (api.PIPELINE_STATES || []).indexOf(status) !== -1) return 0;
    if (api && (api.COMMITTED_STATES || []).indexOf(status) !== -1) return 1;
    return 2;
  }

  /** Bills of the month that cost something to this category (a rent invoice also feeds the GST-on-rent line). */
  function billsBehind(monthKey, unitId, categoryId) {
    var api = billApi();
    if (!api) return [];
    var filter = { monthKey: monthKey };
    if (unitId !== ALL) filter.unitId = unitId;
    var out = [];
    (call(function () { return api.list(filter); }, []) || []).forEach(function (bill) {
      var parts = call(function () { return api.expenseParts(bill); }, null) || [{ categoryId: bill.categoryId, amount: num(bill.amount) + num(bill.gstAmount) }];
      var cost = 0, hit = false;
      parts.forEach(function (p) { if (p.categoryId === categoryId) { cost += num(p.amount); hit = true; } });
      if (!hit) return;
      out.push({ bill: bill, id: bill.id, number: bill.number || bill.id, invoice: (bill.invoiceNo || '') + (bill.invoiceDate ? ' - ' + MK.dates.label(bill.invoiceDate, 'd MMM') : ''),
        vendor: vendorName(bill.vendorId), unit: unitName(bill.unitId), cost: cost, status: bill.status, group: stateGroup(bill.status) });
    });
    return out.sort(function (a, b) { return a.group - b.group || b.cost - a.cost; });
  }

  function vendorName(id) {
    var v = MK.workflow && MK.workflow.vendor;
    var name = v && typeof v.nameOf === 'function' ? call(function () { return v.nameOf(id); }, null) : null;
    if (name) return name;
    var master = byId((MK.config && MK.config.vendors) || [], id);
    return master ? master.name : String(id || '-');
  }

  function unitName(id) {
    var u = byId((MK.config && MK.config.outlets) || [], id);
    return u ? (u.short || u.name) : String(id || '-');
  }

  function pipelineBillCount(monthKey, unitId) {
    var api = billApi();
    if (!api) return null;
    var filter = { monthKey: monthKey, status: api.PIPELINE_STATES || ['SUBMITTED', 'UNDER_REVIEW'] };
    if (unitId !== ALL) filter.unitId = unitId;
    return (call(function () { return api.list(filter); }, []) || []).length;
  }

  /* ------------------------------------------------------------------ header */

  function header(env) {
    var st = env.st, ctx = env.ctx, b = env.b;
    var box = h('section', { 'class': 'bg-head' });

    box.appendChild(h('p', { 'class': 'bg-intro' },
      'What each unit planned to spend in the month, what is already committed through approved and paid bills, and what is still waiting for approval - line by line. ',
      h('strong', null, env.unit.name + ', ' + periodText(b) + '.')));

    if (env.units.length > 1) {
      box.appendChild(ui.tabs({ ariaLabel: 'Unit', value: env.unit.id,
        items: env.units.map(function (u) { return { id: u.id, label: u.label }; }),
        onChange: function (id) { st.unit = id; ctx.rerender(); } }));
    } else {
      box.appendChild(h('div', { 'class': 'bg-locked' },
        ui.chip(env.unit.name, 'neutral', { icon: 'lock', dotVar: env.unit.colourVar }),
        h('span', { 'class': 'mk-muted mk-small' }, (ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel : 'Your role') + ' sees this unit only; every figure below is limited to it.')));
    }

    box.appendChild(h('div', { 'class': 'bg-period' },
      h('div', { 'class': 'bg-period__switch' },
        h('span', { 'class': 'mk-label' }, 'Month'),
        ui.segmented({ ariaLabel: 'Month', size: 'sm', value: env.monthKey,
          options: env.months.map(function (m) { return { value: m.monthKey, label: monthName(m) }; }),
          onChange: function (v) { st.month = v; ctx.rerender(); } })),
      h('div', { 'class': 'bg-period__label' }, ui.icon('calendar', 14), h('span', { 'class': 'mk-muted' }, 'Period'), h('strong', null, periodText(b) || '-'))));

    var notes = h('div', { 'class': 'bg-notes' });
    notes.appendChild(note('Committed = bills that are approved, in a payment batch or paid, plus costs that never pass through a bill (payroll, aggregator deductions at source, factory transfers). ' +
      'Pipeline = bills submitted or under review. A line is over budget once committed spend passes the budget, and on watch when the pipeline would take it there.', 'info'));
    var basis = (b.policy && b.policy.basis) || '';
    if (basis) notes.appendChild(note(basis + '.', 'file'));
    if (b.basis && b.basis !== 'bills') {
      notes.appendChild(note('No vendor bills are held for ' + MK.dates.monthLabel(env.monthKey, true) + ' in the demo store, so this month is read from the cost ledger: committed equals the booked cost and nothing is in the pipeline.', 'database'));
    }
    var f = ctx.filters || {};
    if (b.period && b.period.partial) {
      notes.appendChild(note('The running month is open (' + (b.period.periodLabel || '') + '): bills received so far are set against the full-month budget of ' + fmt.inr(b.totals.plan) +
        ' (' + fmt.inr(b.totals.planToDate) + ' pro rata to date).', 'clock'));
    }
    if (env.overridden) {
      notes.appendChild(note('Quick switch: showing ' + MK.dates.monthLabel(env.monthKey, true) + ', while the date filter ends in ' + MK.dates.monthLabel(env.defaultMonth, true) + ' (' + rangeLabel(f.from, f.to) + ').', 'calendar',
        ui.button({ label: 'Back to the filter month', variant: 'text', size: 'sm', onClick: function () { st.month = null; ctx.rerender(); } })));
    }
    if (env.unit.id === ALL) {
      notes.appendChild(note('The total adds up every unit\'s own budget: factory transfers are budgeted at the outlets and the factory\'s own costs at the factory.', 'layers'));
    }
    box.appendChild(notes);
    return box;
  }

  /* ------------------------------------------------------------------ KPI tiles */

  function kpis(env) {
    var b = env.b, t = b.totals || {}, counts = b.counts || {};
    var est = num(t.estimatedPart);
    var used = isNum(t.used) ? t.used : num(t.committed) + num(t.pipeline) + est;
    var remaining = num(t.plan) - used;
    var waiting = pipelineBillCount(env.monthKey, env.unit.id);
    var canOpenBills = !!(MK.router.isAllowed && MK.router.isAllowed(BILLS_PAGE));
    var tiles = [];

    tiles.push({ label: 'Budget', icon: 'wallet', value: fmt.inr(t.plan),
      sub: b.period && b.period.partial ? fmt.inr(t.planToDate) + ' pro rata to date' : plural((b.rows || []).length, 'line', 'lines'),
      title: 'The full-month plan of ' + env.unit.name });

    tiles.push({ label: 'Committed', icon: 'check-circle', value: fmt.inr(t.committed),
      sub: t.plan > 0 ? fmt.pct(t.committed / t.plan) + ' of budget' : null,
      title: 'Approved, batched and paid bills plus costs booked without a bill' });

    tiles.push({ label: 'In pipeline', icon: 'clock', value: fmt.inr(t.pipeline), tone: t.pipeline > 0 ? 'warn' : null,
      sub: waiting === null ? 'Bills submitted or under review' : (waiting > 0 ? plural(waiting, 'bill', 'bills') + ' awaiting approval' : 'No bill is waiting'),
      title: 'Bills submitted or under review for this month',
      onClick: canOpenBills && waiting > 0 ? function () { env.ctx.navigate(BILLS_PAGE); } : null });

    if (est > 0) {
      tiles.push({ label: 'Awaiting statement', value: fmt.inr(est), sub: [ui.estimateBadge(), ' aggregator costs'],
        title: estimateCaption() + '. Kept apart from committed spend.' });
    }

    tiles.push({ label: remaining >= 0 ? 'Remaining' : 'Over budget by', icon: 'scale', value: fmt.inr(Math.abs(remaining)), tone: remaining < 0 ? 'critical' : null,
      sub: t.plan > 0 ? fmt.pct(used / t.plan) + ' of budget used' + (est > 0 ? ', estimate included' : '') : null,
      title: 'Budget less committed spend, pipeline' + (est > 0 ? ' and the estimated aggregator costs' : '') });

    var over = num(counts.OVER), watch = num(counts.WATCH);
    /* a consolidated line can be within budget while a single unit's line is far over it: the tile must not read green then */
    var hotOver = env.unit.id === ALL && env.hot ? env.hot.filter(function (x) { return x.row.status === 'OVER'; }).length : 0;
    tiles.push({ label: 'Lines over budget', icon: 'alert-triangle', value: fmt.num(over), tone: over > 0 ? 'critical' : (watch > 0 || hotOver > 0 ? 'warn' : 'good'),
      sub: fmt.num(watch) + ' on watch, ' + fmt.num(num(counts.OK)) + ' on track' + (env.unit.id === ALL && env.hot ? '; ' + fmt.num(hotOver) + ' over at unit level' : ''),
      title: 'Category lines whose committed spend is above the budget' + (hotOver > 0 ? '; unit-level lines are listed under "Where the overruns are"' : '') });

    var wrap = h('div', { 'class': 'bg-kpiblock' }, h('div', { 'class': 'bg-kpis bg-kpis--' + tiles.length }, tiles.map(function (t) { return ui.statTile(t); })));
    var tag = ui.sourceTag(sourcesOf(b));
    tag.classList.add('bg-source-flat');
    wrap.appendChild(tag);
    return wrap;
  }

  /* ------------------------------------------------------------------ open month: point at the last closed one */

  function openMonthNote(env) {
    var b = env.b;
    if (!(b.period && b.period.partial)) return null;
    var idx = env.months.indexOf(byId(env.months, env.monthKey, 'monthKey'));
    var closed = null;
    for (var i = idx - 1; i >= 0 && !closed; i--) if (!env.months[i].partial) closed = env.months[i];
    if (!closed) return null;
    var cb = closed.b;
    var overs = (cb.rows || []).filter(function (r) { return r.status === 'OVER'; }).sort(function (a, c) { return c.variance - a.variance; });
    var closedLabel = MK.dates.monthLabel(closed.monthKey, true);
    var t = b.totals || {};
    /* the headline for the pace is the whole unit, in one number; naming the individual lines is the chart's job right below,
       so the two blocks do not say the same thing twice. */
    var pace = num(t.actual) + num(t.estimatedPart) - num(t.planToDate);
    var text = MK.dates.monthLabel(env.monthKey, true) + ' is still open: invoices for utilities and month-end services arrive after the month closes, so lines fill up as bills are approved. ';
    if (num(t.planToDate) > 0) {
      text += 'Cost accrued so far is ' + fmt.inr(Math.abs(pace)) + (pace > 0 ? ' ahead of' : ' inside') + ' the ' + fmt.inr(t.planToDate) +
        ' budget for the ' + plural(num(b.period.elapsedDays), 'day', 'days') + ' gone; the chart below names the lines that drive it. ';
    }
    text += overs.length
      ? 'The last closed month, ' + closedLabel + ', ended with ' + plural(overs.length, 'line', 'lines') + ' over budget for ' + env.unit.name + ', led by ' +
        andList(overs.slice(0, 3).map(function (r) { return r.label + ' (' + signedCompact(r.variance) + ')'; })) + '.'
      : 'The last closed month, ' + closedLabel + ', ended with every line of ' + env.unit.name + ' within budget.';
    return ui.callout(overs.length || pace > 0 ? 'warn' : 'info', 'The month is open: watch the pace, and see how the last month closed', text,
      { actions: ui.button({ label: 'Show ' + closedLabel, size: 'sm', onClick: function () { env.st.month = closed.monthKey; env.ctx.rerender(); } }) });
  }

  /* ------------------------------------------------------------------ charts */

  function shortLabel(label) { return String(label || '').replace(/\s*\([^)]*\)\s*$/, ''); }

  /**
   * What a line is measured against.
   * Closed month: used (committed + pipeline) against the full-month budget - the basis of the status chips.
   * Open month: cost accrued to date (fixed costs pro rata, plus the aggregator estimate, labelled) against the pro-rata
   * budget to date, because half a month of bills against a full-month budget says nothing about pace.
   */
  function varianceBasis(b) {
    var open = !!(b.period && b.period.partial);
    return {
      open: open,
      budget: function (r) { return open ? num(r.planToDate) : num(r.comparedWith); },
      spent: function (r) { return open ? num(r.actual) + num(r.estimatedPart) : num(r.used); },
      variance: function (r) { return open ? num(r.actual) + num(r.estimatedPart) - num(r.planToDate) : num(r.variance); }
    };
  }

  function chartLabel(r, basis) { return shortLabel(r.label) + (basis.open && num(r.estimatedPart) > 0 ? ' + estimate' : ''); }

  function varianceChart(env) {
    var b = env.b, basis = varianceBasis(b);
    var rows = (b.rows || []).map(function (r) { return { r: r, v: basis.variance(r) }; }).filter(function (x) { return Math.round(x.v) !== 0; })
      .sort(function (a, c) { return Math.abs(c.v) - Math.abs(a.v); }).slice(0, TOP_VARIANCES)
      .sort(function (a, c) { return c.v - a.v; });
    var title = basis.open ? 'Variance to date by category' : 'Variance by category';
    if (!rows.length) return ui.card({ title: title, body: ui.emptyState('No budget lines for this selection', null, { compact: true }) });
    var overs = rows.filter(function (x) { return x.v > 0; });
    var saver = rows[rows.length - 1];
    var lead = basis.open ? 'Ahead of the pro-rata budget: ' : 'Over budget: ';
    var subtitle = overs.length
      ? lead + andList(overs.slice(0, 3).map(function (x) { return shortLabel(x.r.label) + ' (' + signedCompact(x.v) + ')'; })) + '.' +
        (saver && saver.v < 0 ? ' Furthest under: ' + shortLabel(saver.r.label) + ' (' + fmt.inr(-saver.v) + ').' : '')
      : 'No line is ' + (basis.open ? 'ahead of the pro-rata budget' : 'over budget') + '; furthest under is ' + shortLabel(saver.r.label) + ' (' + fmt.inr(-saver.v) + ').';
    var labels = rows.map(function (x) { return chartLabel(x.r, basis); });
    var anyEst = basis.open && rows.some(function (x) { return num(x.r.estimatedPart) > 0; });
    var columns = [{ key: 'label', label: 'Category' }, { key: 'budget', label: basis.open ? 'Budget to date' : 'Budget', format: 'inrFull', align: 'right' }];
    if (basis.open) {
      columns.push({ key: 'accrued', label: 'Accrued to date', format: 'inrFull', align: 'right' });
      if (anyEst) columns.push({ key: 'est', label: 'Estimated (no statement yet)', format: 'inrFull', align: 'right' });
    } else {
      columns.push({ key: 'used', label: 'Used', format: 'inrFull', align: 'right' });
    }
    columns.push({ key: 'varianceText', label: 'Variance', align: 'right' });
    if (!basis.open) columns.push({ key: 'utilisation', label: '% used', format: 'pct', align: 'right' }, { key: 'status', label: 'Status' });
    var chart = MK.charts.mount(null, {
      id: 'bg-variance', kind: 'divergingBar', format: 'inr', height: H_CHART,
      title: title + ', the ' + fmt.num(rows.length) + ' largest', subtitle: subtitle,
      data: { categories: labels, values: rows.map(function (x) { return -x.v; }), name: basis.open ? 'Budget to date less accrued' : 'Budget less used',
        zeroLabel: basis.open ? 'Budget to date' : 'Budget', posLabel: basis.open ? 'Under the pro-rata budget' : 'Under budget', negLabel: basis.open ? 'Ahead of the pro-rata budget' : 'Over budget',
        categoryHeader: 'Category' },
      table: { columns: columns, rows: rows.map(function (x) {
        return { label: x.r.label, budget: basis.budget(x.r), accrued: num(x.r.actual), est: num(x.r.estimatedPart), used: x.r.used, varianceText: signed(Math.round(x.v)), utilisation: x.r.utilisation,
          status: ui.statusInfo ? ui.statusInfo(x.r.status).label : x.r.status };
      }) },
      onClick: function (d) {
        var i = labels.indexOf(d.category);
        if (i !== -1) openCategory(env, rows[i].r.categoryId);
      },
      note: basis.open
        ? 'The month is open, so this chart measures pace: cost accrued to date (fixed costs pro rata) against the budget for ' + fmt.num(b.period.elapsedDays) + ' of ' + fmt.num(b.period.daysInMonth) +
          ' days. The table below sets bills against the full-month budget.' + (anyEst ? ' Lines marked "+ estimate" add aggregator costs of weeks without a statement: ' + estimateCaption().toLowerCase() + '.' : '')
        : 'Used = committed + pipeline, against the full-month budget. Select a bar for the bills behind it.'
    });
    if (anyEst) chart.el.appendChild(h('p', { 'class': 'bg-note bg-note--chart' }, ui.estimateBadge(), h('span', null, 'The estimated part is listed in its own column in the table view and is never added to committed spend.')));
    chart.el.appendChild(sourceEnd(sourcesOf(b, rows.map(function (x) { return x.r; }))));
    return chart.el;
  }

  function byUnitChart(env) {
    var units = env.units.filter(function (u) { return u.id !== ALL; });
    if (units.length < 2) return byMonthChart(env);
    var data = units.map(function (u) {
      var ub = budgetOf(env.monthKey, u.id);
      return ub ? { u: u, t: ub.totals || {}, counts: ub.counts || {} } : null;
    }).filter(Boolean);
    var ranked = data.filter(function (x) { return x.t.plan > 0; }).sort(function (a, c) { return c.t.committed / c.t.plan - a.t.committed / a.t.plan; });
    var top = ranked[0];
    var overUnits = ranked.filter(function (x) { return x.t.committed > x.t.plan; });
    /* in an open month every unit sits near the elapsed share, so "largest share committed" says nothing on its own:
       the takeaway is who is furthest ahead of the pace the calendar sets. */
    var open = !!(env.b.period && env.b.period.partial);
    var prorata = open && isNum(env.b.period.prorata) ? env.b.period.prorata : null;
    var subtitle = '';
    if (top && prorata !== null) {
      var topShare = top.t.committed / top.t.plan;
      var where = fmt.pct(topShare, 0) + ' of its budget against ' + fmt.pct(prorata, 0) + ' of the month gone (' + fmt.inr(top.t.committed) + ' of ' + fmt.inr(top.t.plan) + '). ';
      subtitle = (topShare > prorata ? top.u.name + ' is furthest ahead of the pace: it has committed ' : 'No unit has run ahead of the calendar; ' + top.u.name + ' leads with ') + where +
        (overUnits.length ? plural(overUnits.length, 'unit is', 'units are') + ' over budget in total.' : 'No unit is over its total budget so far.');
    } else if (top) {
      subtitle = top.u.name + ' has committed the largest share of its budget: ' + fmt.inr(top.t.committed) + ' of ' + fmt.inr(top.t.plan) + ' (' + fmt.pct(top.t.committed / top.t.plan, 0) + '). ' +
        (overUnits.length ? plural(overUnits.length, 'unit is', 'units are') + ' over budget in total.' : 'No unit is over its total budget.');
    }
    var labels = data.map(function (x) { return x.u.label; });
    var anyEst = data.some(function (x) { return num(x.t.estimatedPart) > 0; });
    var chart = MK.charts.mount(null, {
      id: 'bg-units', kind: 'hbar', format: 'inr', height: H_CHART,
      title: 'Budget vs committed by unit', subtitle: subtitle,
      data: { categories: labels, categoryHeader: 'Unit',
        series: [{ id: 'budget', name: 'Budget', colourVar: C_BUDGET, values: data.map(function (x) { return num(x.t.plan); }) },
          { id: 'committed', name: 'Committed', colourVar: C_COMMITTED, values: data.map(function (x) { return num(x.t.committed); }) }] },
      table: { columns: [{ key: 'unit', label: 'Unit' }, { key: 'plan', label: 'Budget', format: 'inrFull', align: 'right' }, { key: 'committed', label: 'Committed', format: 'inrFull', align: 'right' },
        { key: 'pipeline', label: 'Pipeline', format: 'inrFull', align: 'right' }].concat(anyEst ? [{ key: 'est', label: 'Estimated', format: 'inrFull', align: 'right' }] : [],
        [{ key: 'share', label: 'Committed %', format: 'pct', align: 'right' }, { key: 'over', label: 'Lines over', format: 'num', align: 'right' }]),
        rows: data.map(function (x) { return { unit: x.u.name, plan: x.t.plan, committed: x.t.committed, pipeline: x.t.pipeline, est: x.t.estimatedPart, share: x.t.plan > 0 ? x.t.committed / x.t.plan : null, over: num(x.counts.OVER) }; }) },
      onClick: function (d) {
        var i = labels.indexOf(d.category);
        if (i !== -1 && env.unit.id !== data[i].u.id) { env.st.unit = data[i].u.id; env.ctx.rerender(); }
      },
      note: MK.dates.monthLabel(env.monthKey, true) + (env.b.period && env.b.period.partial ? ', committed to date against the full-month budget' : '') + '. Select a unit\'s bars to see its lines.' +
        (anyEst ? ' Estimated aggregator costs are not part of committed; they are in the table.' : '')
    });
    chart.el.appendChild(sourceEnd(sourcesOf(env.b)));
    return chart.el;
  }

  /** One unit in scope: budget against committed across the months instead of across units. */
  function byMonthChart(env) {
    var data = env.months.filter(function (m) { return m.b; });
    var worst = null;
    data.forEach(function (m) { if (!m.partial && m.b.totals.plan > 0 && (!worst || m.b.totals.committed / m.b.totals.plan > worst.b.totals.committed / worst.b.totals.plan)) worst = m; });
    var labels = data.map(monthName);
    var chart = MK.charts.mount(null, {
      id: 'bg-months', kind: 'bar', format: 'inr', height: H_CHART,
      title: 'Budget vs committed by month, ' + env.unit.name,
      subtitle: worst ? MK.dates.monthLabel(worst.monthKey, true) + ' used the largest share of its budget: ' + fmt.inr(worst.b.totals.committed) + ' of ' + fmt.inr(worst.b.totals.plan) +
        ' (' + fmt.pct(worst.b.totals.committed / worst.b.totals.plan, 0) + '), with ' + plural(num(worst.b.counts.OVER), 'line', 'lines') + ' over budget.' : '',
      data: { categories: labels, categoryHeader: 'Month',
        series: [{ id: 'budget', name: 'Budget', colourVar: C_BUDGET, values: data.map(function (m) { return num(m.b.totals.plan); }) },
          { id: 'committed', name: 'Committed', colourVar: C_COMMITTED, values: data.map(function (m) { return num(m.b.totals.committed); }) }] },
      onClick: function (d) {
        var i = labels.indexOf(d.category);
        if (i !== -1 && data[i].monthKey !== env.monthKey) { env.st.month = data[i].monthKey; env.ctx.rerender(); }
      },
      note: 'Select a month\'s bars to see its lines.' + (data.length && data[data.length - 1].partial ? ' The running month is committed to date against the full-month budget.' : '')
    });
    chart.el.appendChild(sourceEnd(sourcesOf(env.b, (env.b.rows || []).map(function (r) { return Object.assign({}, r, { estimatedPart: 0 }); }))));
    return chart.el;
  }

  /* ------------------------------------------------------------------ hotspots: unit x category */

  function hotspots(monthKey, units) {
    var out = [];
    units.forEach(function (u) {
      if (u.id === ALL) return;
      var ub = budgetOf(monthKey, u.id);
      ((ub && ub.rows) || []).forEach(function (r) {
        if (r.status === 'OK') return;
        var flexed = isNum(r.flexedPlan) ? r.flexedPlan : r.comparedWith;
        out.push({ key: u.id + '|' + r.categoryId, unit: u, row: r, label: r.label, unitLabel: u.name, budget: r.comparedWith, used: r.used, variance: r.variance,
          unexplained: r.used - flexed, utilisation: r.utilisation, status: r.status });
      });
    });
    return out.sort(function (a, c) { return c.unexplained - a.unexplained; });
  }

  function lineCell(row) {
    return h('div', { 'class': 'bg-line', title: row.label + ' - ' + row.unitLabel },
      row.unit.colourVar ? h('span', { 'class': 'mk-legend-dot', style: { background: 'var(' + row.unit.colourVar + ')' } }) : null,
      h('div', { 'class': 'bg-line__text' }, h('div', { 'class': 'bg-line__name' }, row.label), h('div', { 'class': 'bg-line__sub' }, row.unitLabel)));
  }

  function hotspotCard(env) {
    var hot = env.hot || [];
    if (env.unit.id !== ALL) return null;
    if (!hot.length) {
      return ui.card({ title: 'Where the overruns are', body: ui.emptyState('No unit line is over budget or on watch', 'Every unit and category is within its budget for ' + periodText(env.b) + '.', { icon: 'check-circle', compact: true }) });
    }
    var st = env.st;
    var rows = st.hotAll ? hot : hot.slice(0, TOP_HOTSPOTS);
    var overs = hot.filter(function (x) { return x.status === 'OVER'; });
    var salesDriven = overs.filter(function (x) { return x.unexplained <= 0; });
    var first = hot[0];
    var unexplainedBar = ui.cells.bar(env.hotMax, '--div-neg-2', { format: 'inrFull' });
    var subtitle = plural(overs.length, 'unit line is', 'unit lines are') + ' over budget and ' + fmt.num(hot.length - overs.length) + ' on watch' +
      (salesDriven.length ? '; ' + fmt.num(salesDriven.length) + ' of them only because sales ran ahead of plan' : '') + '. ' +
      first.label + ' at ' + first.unitLabel + ' leads: ' + fmt.inrFull(first.used) + ' used against ' + fmt.inrFull(first.budget) + ' (' + fmt.pct(first.utilisation, 0) + ').';
    var table = ui.table({
      dense: true, sortable: true, sort: st.hotSort || { key: 'unexplained', dir: 'desc' }, onSort: function (s) { st.hotSort = s; },
      columns: [
        { key: 'label', label: 'Line', render: function (v, r) { return lineCell(r); }, sortValue: function (r) { return r.label + r.unitLabel; } },
        { key: 'budget', label: 'Budget', format: 'inrFull' },
        { key: 'used', label: 'Used', format: 'inrFull' },
        { key: 'variance', label: 'Against budget', align: 'right', numeric: true, render: function (v) { return varianceNode(v); } },
        { key: 'unexplained', label: 'Not explained by sales', align: 'right', numeric: true,
          title: 'Used less the budget re-based on actual sales (variable lines move with sales; fixed lines do not)',
          render: function (v, r, col, c) { return v > 0 ? unexplainedBar(v, r, col, c) : ui.chip('Sales-driven', 'neutral', { title: 'Higher sales than planned explain this overrun' }); } },
        { key: 'utilisation', label: '% used', align: 'right', numeric: true, render: function (v) { return fmt.pct(v, 0); } },
        { key: 'status', label: 'Status', render: ui.cells.status() }],
      rows: rows,
      onRowClick: function (r) { st.unit = r.unit.id; st.pendingOpen = r.row.categoryId; env.ctx.rerender(); }
    });
    return ui.card({ title: 'Where the overruns are', subtitle: subtitle, flush: true,
      actions: hot.length > TOP_HOTSPOTS ? ui.button({ label: st.hotAll ? 'Show the top ' + fmt.num(TOP_HOTSPOTS) : 'Show all ' + fmt.num(hot.length), variant: 'ghost', size: 'sm',
        onClick: function () { st.hotAll = !st.hotAll; env.ctx.rerender(); } }) : null,
      body: table,
      footer: [h('p', { 'class': 'bg-foot' }, 'Ranked by the overrun that higher sales do not explain: variable lines (food, packaging, aggregator fees) are re-based on actual sales before comparing. Select a line for its unit and the bills behind it.'),
        ui.sourceTag(sourcesOf(env.b, rows.map(function (x) { return x.row; })))] });
  }

  /* ------------------------------------------------------------------ category table */

  function varianceNode(v) {
    if (!isNum(v)) return '-';
    return h('span', { 'class': v > 0 ? 'mk-bad' : '' }, signed(v));
  }

  function usedMeter(row, period) {
    var partial = !!(period && period.partial);
    return ui.meter({ size: 'sm', value: num(row.used), max: row.comparedWith > 0 ? row.comparedWith : 1, tone: STATUS_TONE[row.status] || 'neutral',
      valueLabel: row.comparedWith > 0 ? fmt.pct(row.utilisation, 0) : '-',
      target: partial && isNum(period.prorata) ? period.prorata : undefined,
      targetLabel: partial && isNum(period.prorata) ? 'Month elapsed: ' + fmt.pct(period.prorata, 0) : undefined });
  }

  function categoryTable(env) {
    var b = env.b, st = env.st, t = b.totals || {};
    var all = b.rows || [];
    var hasEst = num(t.estimatedPart) > 0;
    var only = st.only === 'attention';
    var rows = only ? all.filter(function (r) { return r.status !== 'OK'; }) : all;
    var attention = all.filter(function (r) { return r.status !== 'OK'; }).length;
    var used = isNum(t.used) ? t.used : num(t.committed) + num(t.pipeline) + num(t.estimatedPart);

    var columns = [
      { key: 'label', label: 'Category', render: ui.cells.twoLine(function (r) { return groupLabel(r.group); }, { maxWidth: hasEst ? 190 : 230 }) },
      { key: 'plan', label: 'Budget', format: 'inrFull' },
      { key: 'committed', label: 'Committed', format: 'inrFull' },
      { key: 'pipeline', label: 'Pipeline', align: 'right', numeric: true, render: function (v) { return v > 0 ? h('strong', null, fmt.inrFull(v)) : fmt.inrFull(v); } }];
    if (hasEst) {
      columns.push({ key: 'estimatedPart', label: 'Estimated', align: 'right', numeric: true, title: estimateCaption(),
        render: function (v) { return v > 0 ? h('span', { 'class': 'bg-est' }, fmt.inrFull(v), ui.estimateBadge('Est.')) : '-'; } });
    }
    columns.push({ key: 'variance', label: 'Variance', align: 'right', numeric: true, title: 'Used less budget: above zero is over budget', render: function (v) { return varianceNode(v); } });
    columns.push({ key: 'utilisation', label: '% used', width: hasEst ? 120 : 150, render: function (v, r) { return usedMeter(r, b.period); } });
    columns.push({ key: 'status', label: 'Status', sortValue: function (r) { return -(STATUS_RANK[r.status] === undefined ? 3 : STATUS_RANK[r.status]); }, render: ui.cells.status() });

    var footer = { label: 'Total, ' + plural(all.length, 'line', 'lines'), plan: t.plan, committed: t.committed, pipeline: fmt.inrFull(t.pipeline), estimatedPart: hasEst ? fmt.inrFull(t.estimatedPart) : null,
      variance: signed(isNum(t.variance) ? t.variance : used - num(t.plan)), utilisation: t.plan > 0 ? fmt.pct(used / t.plan, 0) + ' used' : '-', status: '' };

    var table = ui.table({ columns: columns, rows: rows, sortable: true, footer: only ? null : footer,
      sort: st.sort || { key: 'variance', dir: 'desc' }, onSort: function (s) { st.sort = s; },
      rowClass: function (r) { return r.status === 'OVER' ? 'bg-row-over' : ''; },
      onRowClick: function (r) { openCategory(env, r.categoryId); },
      empty: only ? 'No line is over budget or on watch for this selection' : 'No budget lines for this selection' });

    var top = all.slice().sort(function (a, c) { return c.variance - a.variance; })[0];
    var subtitle = env.unit.name + ', ' + periodText(b) + ', sorted by overrun. ' +
      (top && top.variance > 0 ? top.label + ' is furthest over: ' + fmt.inrFull(top.used) + ' against ' + fmt.inrFull(top.comparedWith) + ' (' + fmt.pct(top.utilisation, 0) + ' used). ' : 'No line is over its budget. ') +
      'Select a line for the bills behind it.';

    return ui.card({ title: 'Budget by category', subtitle: subtitle, flush: true, className: 'bg-tablecard',
      actions: [
        ui.segmented({ ariaLabel: 'Lines shown', size: 'sm', value: only ? 'attention' : 'all',
          options: [{ value: 'all', label: 'All lines' }, { value: 'attention', label: 'Over or on watch (' + fmt.num(attention) + ')' }],
          onChange: function (v) { st.only = v; env.ctx.rerender(); } }),
        ui.button({ label: 'CSV', icon: 'download', size: 'sm', onClick: function () {
          ui.downloadCsv('budget-' + env.unit.id + '-' + env.monthKey + '.csv', [
            { key: 'label', label: 'Category' }, { key: 'group', label: 'Group' }, { key: 'plan', label: 'Budget' }, { key: 'committed', label: 'Committed' },
            { key: 'pipeline', label: 'Pipeline' }, { key: 'estimatedPart', label: 'Estimated (not on a statement)' }, { key: 'used', label: 'Used' }, { key: 'variance', label: 'Variance' },
            { key: 'utilisation', label: 'Share of budget used' }, { key: 'status', label: 'Status' }, { key: 'billCount', label: 'Bills' }], all);
        } })],
      body: table,
      footer: [b.period && b.period.partial && isNum(b.period.prorata)
        ? h('p', { 'class': 'bg-foot' }, 'The mark on each meter is the share of the month elapsed (' + fmt.pct(b.period.prorata, 0) + '): rent and other lines billed in advance run ahead of it by design.') : null,
        hasEst ? h('p', { 'class': 'bg-foot' }, ui.estimateBadge(), ' ' + estimateCaption() + '. Shown apart, never added to committed.') : null,
        ui.sourceTag(sourcesOf(b))] });
  }

  /* ------------------------------------------------------------------ drawer: the bills behind a line */

  function drawerContent(sel) {
    var b = budgetOf(sel.monthKey, sel.unitId);
    var row = b ? byId(b.rows, sel.categoryId, 'categoryId') : null;
    if (!row) return null;
    var units = unitOptions();
    var unit = byId(units, sel.unitId) || { id: sel.unitId, name: unitName(sel.unitId) };
    var bills = billsBehind(sel.monthKey, sel.unitId, sel.categoryId);
    var est = num(row.estimatedPart);
    var over = row.used - row.comparedWith;
    var partial = !!(b.period && b.period.partial);
    var body = [];

    body.push(ui.meter({ label: 'Used of the ' + (partial ? 'full-month ' : '') + 'budget', value: num(row.used), max: row.comparedWith > 0 ? row.comparedWith : 1, tone: STATUS_TONE[row.status] || 'neutral',
      valueLabel: (row.comparedWith > 0 ? fmt.pct(row.utilisation, 0) : '-') + ' of ' + fmt.inr(row.comparedWith),
      target: partial && isNum(b.period.prorata) ? b.period.prorata : undefined, targetLabel: partial ? 'Month elapsed: ' + fmt.pct(b.period.prorata, 0) : undefined }));

    /* "over" is measured on USED (committed + pipeline + estimate), so the label has to say where the overrun comes from:
       a line whose committed spend is still inside the budget is not "over budget", it is over once the pipeline is approved. */
    var overLabel;
    if (over <= 0) overLabel = 'Remaining';
    else if (row.committed > row.comparedWith) overLabel = 'Over budget by';
    else if (num(row.pipeline) > 0) overLabel = 'Over budget once the pipeline is approved';
    else overLabel = 'Over budget with the estimated part';
    body.push(ui.keyValue([
      ['Budget', fmt.inrFull(row.comparedWith)],
      Math.round(num(row.plan)) !== Math.round(num(row.comparedWith)) ? ['Full-month plan', fmt.inrFull(row.plan)] : null,
      isNum(row.flexedPlan) && Math.round(row.flexedPlan) !== Math.round(row.comparedWith) ? ['Budget re-based on actual sales', fmt.inrFull(row.flexedPlan)] : null,
      ['Committed', fmt.inrFull(row.committed)],
      ['In pipeline', fmt.inrFull(row.pipeline)],
      est > 0 ? ['Not yet on a statement', h('span', { 'class': 'bg-est' }, fmt.inrFull(est), ui.estimateBadge())] : null,
      ['Used', h('strong', null, fmt.inrFull(row.used))],
      [overLabel, h('strong', { 'class': over > 0 ? 'mk-bad' : '' }, fmt.inrFull(Math.abs(over)))]
    ]));

    if (row.status === 'OVER') {
      body.push(ui.callout('critical', 'Over budget', 'Committed spend of ' + fmt.inrFull(row.committed) + ' is already ' + fmt.inrFull(row.committed - row.comparedWith) + ' above the ' + fmt.inrFull(row.comparedWith) + ' budget' +
        (row.pipeline > 0 ? '; approving the ' + fmt.inrFull(row.pipeline) + ' in the pipeline would take the line to ' + fmt.pct(row.utilisation, 0) + '.' : '.')));
    } else if (row.status === 'WATCH') {
      body.push(ui.callout('warn', 'On watch', row.pipeline > 0 && row.committed + row.pipeline > row.comparedWith
        ? 'Committed spend is within budget, but approving the ' + fmt.inrFull(row.pipeline) + ' in the pipeline would take the line to ' + fmt.pct(row.utilisation, 0) + ' of budget.'
        : fmt.pct(row.utilisation, 0) + ' of the budget is used while more bills of this kind are still expected this month.'));
    }

    if (sel.unitId === ALL) {
      var perUnit = units.filter(function (u) { return u.id !== ALL; }).map(function (u) {
        var ub = budgetOf(sel.monthKey, u.id), r = ub ? byId(ub.rows, sel.categoryId, 'categoryId') : null;
        return r ? { unit: u, name: u.name, colourVar: u.colourVar, plan: r.comparedWith, used: r.used, variance: r.variance, status: r.status } : null;
      }).filter(Boolean).sort(function (a, c) { return c.variance - a.variance; });
      if (perUnit.length > 1) {
        body.push(h('div', { 'class': 'bg-drawer__block' }, h('h4', { 'class': 'bg-subhead' }, 'By unit'),
          ui.table({ dense: true, sortable: false,
            columns: [{ key: 'name', label: 'Unit', render: ui.cells.entity(function (r) { return r.colourVar; }) }, { key: 'plan', label: 'Budget', format: 'inrFull' },
              { key: 'used', label: 'Used', format: 'inrFull' }, { key: 'variance', label: 'Variance', align: 'right', numeric: true, render: function (v) { return varianceNode(v); } },
              { key: 'status', label: 'Status', render: ui.cells.status() }],
            rows: perUnit })));
      }
    }

    var counted = bills.filter(function (x) { return x.group === 1; }), waiting = bills.filter(function (x) { return x.group === 0; }), other = bills.filter(function (x) { return x.group === 2; });
    function sum(list) { return list.reduce(function (s, x) { return s + x.cost; }, 0); }
    var noBill = row.committed - sum(counted);
    var canOpenBills = !!(MK.router.isAllowed && MK.router.isAllowed(BILLS_PAGE));
    var billBlock = h('div', { 'class': 'bg-drawer__block' }, h('h4', { 'class': 'bg-subhead' }, 'Bills behind this line (' + fmt.num(bills.length) + ')'));
    if (bills.length) {
      billBlock.appendChild(ui.table({ dense: true, sortable: false, maxHeight: 336,
        columns: [{ key: 'number', label: 'Bill', render: ui.cells.twoLine('invoice', { maxWidth: 150 }) },
          { key: 'vendor', label: 'Vendor', render: ui.cells.twoLine('unit', { maxWidth: 150 }) },
          { key: 'cost', label: 'Amount', format: 'inrFull', title: 'What the bill costs this line: taxable value plus non-creditable GST' },
          { key: 'status', label: 'Status', render: ui.cells.status() }],
        rows: bills, rowClass: function (r) { return r.group === 2 ? 'is-muted' : ''; },
        onRowClick: canOpenBills ? function (r) { MK.router.navigate(BILLS_PAGE, { id: r.id }); } : null }));
      billBlock.appendChild(h('p', { 'class': 'bg-foot' },
        'Committed through bills ' + fmt.inrFull(sum(counted)) + (waiting.length ? ', in pipeline ' + fmt.inrFull(sum(waiting)) + ' (' + plural(waiting.length, 'bill', 'bills') + ')' : '') +
        (other.length ? '. ' + plural(other.length, 'draft or rejected bill is', 'draft or rejected bills are') + ' listed but not counted' : '') +
        (noBill > 0 ? '. Booked without a bill: ' + fmt.inrFull(noBill) : '') + '.'));
    } else {
      var why = b.basis && b.basis !== 'bills'
        ? 'No vendor bills are held for ' + MK.dates.monthLabel(sel.monthKey, true) + ' in the demo store: the ' + fmt.inrFull(row.committed) + ' committed here is the cost booked in the ledger.'
        : (isAggregatorLine(row)
          ? 'The ' + fmt.inrFull(row.committed) + ' committed here was deducted at source by ' + aggregatorNames() + ' and comes from their weekly statements; it never passes through a vendor bill.'
          : (row.committed > 0
            ? 'The ' + fmt.inrFull(row.committed) + ' committed here is booked without a vendor bill: payroll, transfers from the factory, stock counts, cash purchases or depreciation.'
            : 'Nothing has been billed or booked against this line for ' + periodText(b) + ' yet.'));
      billBlock.appendChild(ui.emptyState('No bill feeds this line', why, { icon: 'receipt', compact: true }));
    }
    body.push(billBlock);
    body.push(ui.sourceTag(sourcesOf(b, [row])));

    /* who may act on what is waiting: shown so the segregation of duties is visible from here too */
    var api = billApi(), may = null;
    if (api && waiting.length && typeof api.can === 'function') may = call(function () { return api.can('approve', waiting[0].bill); }, null);
    var footer = [];
    if (may && !may.ok) footer.push(h('span', { 'class': PAGE_CLASS + ' bg-drawer__hint' }, ui.icon('lock', 14), h('span', null, 'Approval: ' + may.reason)));
    /* the drill-through is offered only when it has something to show: the same unit, category and month that the block
       above just reported as empty would otherwise open a bill register filtered down to nothing */
    if (bills.length) {
      footer.push(ui.button({ label: waiting.length && may && may.ok ? 'Review in approvals' : 'Open bills', variant: 'primary', icon: 'receipt',
        disabledReason: canOpenBills ? '' : 'Your role cannot open the bills screen',
        onClick: function () { MK.router.navigate(BILLS_PAGE, sel.unitId === ALL ? { categoryId: sel.categoryId, monthKey: sel.monthKey } : { unitId: sel.unitId, categoryId: sel.categoryId, monthKey: sel.monthKey }); } }));
    }

    /* the drawer is mounted outside the page root: the wrapper carries the page class so the page stylesheet applies */
    return { title: row.label, subtitle: unit.name + ' - ' + periodText(b), status: row.status, body: h('div', { 'class': PAGE_CLASS + ' bg-drawer' }, body), footer: footer };
  }

  function openCategory(env, categoryId, onClose) {
    var sel = { monthKey: env.monthKey, unitId: env.unit.id, categoryId: categoryId };
    var content = drawerContent(sel);
    if (!content) return;
    if (openDrawer && openDrawer.d) { var old = openDrawer; openDrawer = null; old.d.close(); }
    var chipHost = h('span', null, ui.statusChip(content.status));
    var d = ui.drawer({ title: content.title, subtitle: content.subtitle, headerExtra: chipHost, width: 560, body: content.body, footer: content.footer,
      onClose: function () {
        if (openDrawer && openDrawer.d === d) openDrawer = null;
        if (typeof onClose === 'function') onClose();
      } });
    openDrawer = { d: d, sel: sel, chipHost: chipHost };
  }

  /** A re-render (store or persona change) refreshes the open drawer from fresh data, or closes it when the line left the scope. */
  function refreshDrawer() {
    if (!openDrawer) return;
    var cur = openDrawer;
    var content = drawerContent(cur.sel);
    if (!content) { cur.d.close(); return; }
    cur.d.setTitle(content.title, content.subtitle);
    ui.clear(cur.chipHost).appendChild(ui.statusChip(content.status));
    cur.d.setBody(content.body);
    cur.d.setFooter(content.footer);
  }

  /* ------------------------------------------------------------------ page */

  function render(rootEl, ctx) {
    var st = ctx.state;
    if (!MK.finance || typeof MK.finance.budget !== 'function') {
      rootEl.appendChild(ui.emptyState('Budget data is not loaded', 'The finance layer did not start, so there is no budget to show.', { icon: 'database' }));
      return;
    }
    var units = unitOptions();
    if (!units.length) {
      rootEl.appendChild(ui.emptyState('No unit in your scope', 'Your role has no outlet, factory or head-office cost centre assigned, so there is no budget to show.', { icon: 'lock' }));
      return;
    }
    var monthKeys = (MK.config && MK.config.months) || [];
    if (!monthKeys.length) {
      rootEl.appendChild(ui.emptyState('No budget months in the data', null, { icon: 'calendar' }));
      return;
    }

    /* the unit in view belongs to the persona who chose it: switching role starts the new persona on its own default
       (a director coming from the Bandra manager should land on the company, not on Bandra) */
    var userId = (ctx.user && ctx.user.id) || '';
    if (st.userId !== userId) { st.userId = userId; st.unit = null; st.hotAll = false; }

    /* month: the date filter decides (the month it ends in); the quick switch overrides until the filter changes */
    var f = ctx.filters || {};
    var filterKey = (f.from || '') + '|' + (f.to || '');
    if (st.filterKey !== filterKey) { st.filterKey = filterKey; st.month = null; }
    var lastKey = monthKeys[monthKeys.length - 1];
    var defaultMonth = f.to && monthKeys.indexOf(f.to.slice(0, 7)) !== -1 ? f.to.slice(0, 7) : lastKey;

    /* deep link: #/costs/budget?month=2026-08&unit=kalyan&category=repairs - applied once per distinct set of params */
    var p = ctx.params || {};
    var paramKey = [p.month || '', p.unit || '', p.category || ''].join('|');
    if (paramKey !== '||' && st.paramKey !== paramKey) {
      st.paramKey = paramKey;
      if (p.month && monthKeys.indexOf(p.month) !== -1) st.month = p.month;
      if (p.unit && byId(units, p.unit)) st.unit = p.unit;
      if (p.category) { st.pendingOpen = p.category; st.pendingFromLink = true; }
    } else if (paramKey === '||') {
      st.paramKey = null;
    }

    var monthKey = monthKeys.indexOf(st.month) !== -1 ? st.month : defaultMonth;
    var unit = byId(units, st.unit) || units[0];
    st.unit = unit.id;

    var months = monthKeys.map(function (k) {
      var mb = budgetOf(k, unit.id);
      return { monthKey: k, b: mb, partial: !!(mb && mb.period && mb.period.partial) };
    });
    var current = byId(months, monthKey, 'monthKey');
    var b = current && current.b;
    if (!b) {
      rootEl.appendChild(ui.emptyState('The budget could not be read for this month', null, { icon: 'database' }));
      return;
    }

    var env = { st: st, ctx: ctx, units: units, unit: unit, months: months, monthKey: monthKey, defaultMonth: defaultMonth, overridden: monthKey !== defaultMonth, b: b, hot: null, hotMax: null };
    if (unit.id === ALL) {
      env.hot = hotspots(monthKey, units);
      env.hotMax = env.hot.reduce(function (m, x) { return Math.max(m, x.unexplained); }, 0) || null;
    }

    safe(rootEl, 'Page header', function () { return header(env); });
    if (!(b.rows || []).length) {
      rootEl.appendChild(ui.card({ body: ui.emptyState('No budget lines for ' + unit.name, 'There is no plan and no spend for this unit in ' + periodText(b) + '.', { icon: 'wallet' }) }));
      refreshDrawer();
      return;
    }
    safe(rootEl, 'KPI tiles', function () { return kpis(env); });
    safe(rootEl, 'Open month note', function () { return openMonthNote(env); });
    safe(rootEl, 'Budget charts', function () { return ui.grid([7, 5], [varianceChart(env), byUnitChart(env)]); });
    safe(rootEl, 'Overrun hotspots', function () { return hotspotCard(env); });
    safe(rootEl, 'Budget by category', function () { return categoryTable(env); });

    /* a line picked from the hotspots (after the unit switch) or asked for by a deep link opens once */
    if (st.pendingOpen) {
      var categoryId = st.pendingOpen, fromLink = !!st.pendingFromLink;
      st.pendingOpen = null; st.pendingFromLink = false;
      openCategory(env, categoryId, fromLink ? function () {
        var cur = MK.router.current();
        /* closed by the user, still here: take the params out of the hash so the next re-render does not re-open the drawer.
           closed because the user left the page (a bill link): forget the params instead, so the same link works again later. */
        if (cur && cur.page && cur.page.id === PAGE_ID && cur.params && cur.params.category === categoryId) ctx.navigate(PAGE_ID, null, { replace: true });
        else st.paramKey = null;
      } : null);
    } else {
      refreshDrawer();
    }
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/costs/budget',
    group: 'Costs',
    title: 'Budget tracking',
    subtitle: 'Budget versus committed spend by category',
    units: 'all',
    roles: null,
    filters: ['date'],
    render: render
  });
})(window);
