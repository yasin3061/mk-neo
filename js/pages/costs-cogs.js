/*
 * #/costs/cogs - Food cost (COGS): client brief area 2, "proper structuring of COGS".
 *
 * Food cost is booked by whole month, so the page works in months: the global date filter decides which month(s) are
 * shown (the running month is month to date) and a page-local quick switch (ctx.state) flips to any other month.
 *
 * Blocks, in reading order:
 *   header          purpose, month switch, how theoretical and actual cost are arrived at
 *   KPI tiles       network theoretical %, actual %, variance in points and in rupees, worst outlet
 *   red-flag note   outlets above the red-flag threshold, in words
 *   by outlet       theoretical vs actual % (grouped bars) and variance value (the worst outlet highlighted)
 *   structure       factory items, local items and variance as a share of actual food cost; the outlet table
 *   outlet in focus actual vs theoretical by month against the red flag, and the outlet's COGS statement
 *   recipe cards    dish list -> bill of materials (factory items at transfer price, local items, packaging by medium),
 *                   price, cost and contribution by way of selling, and the price / food cost history of the dish
 *
 * Theoretical cost = recipes x quantities sold (Petpooja); actual = factory transfers, local purchases and stock counts
 * captured in the ERP. Every figure comes from MK.finance / MK.data / MK.config and is formatted with MK.fmt.
 * Role scope is applied by the data layer; the page only decides which blocks make sense for what it receives.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;

  /* ------------------------------------------------------------------ layout constants (pixels and UI rules, never data) */

  var RANGE = 'range';
  var H_CHART = 280;
  var H_HISTORY = 200;
  var H_STRUCTURE = 240;
  var C_THEORETICAL = '--series-muted', C_ACTUAL = '--series-1', C_FLAG = '--div-neg-2';
  var C_FACTORY = '--ot-factory', C_LOCAL = '--series-3', C_VARIANCE = '--series-8', C_PACKAGING = '--series-4';
  var SOURCES_THEORETICAL = ['erp', 'petpooja'];
  var MEDIUMS = ['dinein', 'takeaway', 'delivery'];

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

  /** Signed gap between two shares, in points: "+4.1 pts". */
  function pts(cur, base) { return isNum(cur) && isNum(base) ? fmt.points(cur, base).label : '-'; }
  /** Unsigned size of a gap in points: "4.1 pts". */
  function ptsSize(frac) { return isNum(frac) ? fmt.num(Math.abs(frac) * 100, 1) + ' pts' : '-'; }

  /** Rupees per portion: two decimals, because a garnish costs less than a rupee. */
  function perPortion(v) { return isNum(v) ? fmt.inrFull(v, 2) : '-'; }
  function menuPrice(v) { return isNum(v) ? fmt.inrFull(v) : '-'; }
  function rate(v, unit) { return isNum(v) ? fmt.inrFull(v, v % 1 ? 2 : 0) + ' / ' + unit : '-'; }
  function qty(v, unit) { return isNum(v) ? fmt.num(v, v % 1 ? 1 : 0) + ' ' + unit : '-'; }

  function note(text, iconName, extra) {
    return h('p', { 'class': 'cg-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, text), extra || null);
  }

  function sourceEnd(ids) {
    var tag = ui.sourceTag(ids);
    tag.classList.add('cg-source-end');
    return tag;
  }

  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[costs-cogs] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  function call(fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; } catch (e) {
      if (root.console) root.console.error('[costs-cogs] data call failed', e);
      return fallback;
    }
  }

  function byId(list, id, key) {
    var k = key || 'id';
    for (var i = 0; i < (list || []).length; i++) if (list[i][k] === id) return list[i];
    return null;
  }

  function rowOf(fc, outletId) { return byId(fc && fc.rows, outletId, 'outletId'); }

  /* ------------------------------------------------------------------ outlets, months, period */

  function outletOptions() {
    var allowed = MK.session.allowedOutletIds();
    return ((MK.config && MK.config.outlets) || []).filter(function (o) { return o.type === 'outlet' && allowed.indexOf(o.id) !== -1; })
      .map(function (o) { return { id: o.id, name: o.name, label: o.short || o.name, colourVar: o.colourVar }; });
  }

  function mediumLabel(id) {
    var m = byId((MK.config && MK.config.mediums) || [], id);
    return m ? m.label : id;
  }

  function categoryLabel(id) {
    var c = byId((MK.config && MK.config.categories) || [], id);
    return c ? c.label : id;
  }

  /** "Swiggy and Zomato", from the channel master. */
  function aggregatorNames() {
    var names = ((MK.config && MK.config.channels) || []).filter(function (c) { return c.kind === 'aggregator'; }).map(function (c) { return c.label; });
    return names.length ? andList(names) : 'the aggregators';
  }

  function monthName(m) { return MK.dates.monthLabel(m.monthKey, false) + (m.partial ? ' MTD' : ''); }

  function touchedMonths(f, months) {
    var keys = months.map(function (m) { return m.monthKey; });
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

  function shortPeriod(period) {
    if (!period) return '';
    if (period.months && period.months.length === 1 && period.partial) return rangeLabel(period.from, period.to) + ', month to date';
    return period.label || '';
  }

  /* ------------------------------------------------------------------ header */

  function header(env) {
    var st = env.st, ctx = env.ctx, period = env.fc.period || {};
    var box = h('section', { 'class': 'cg-head' });

    box.appendChild(h('p', { 'class': 'cg-intro' },
      'What the food sold should have cost according to the recipes, against what the outlets actually consumed - by outlet, by source and by dish. ',
      h('strong', null, (period.label || monthsLabel(env.keys, true)) + '.')));

    var options = env.months.map(function (m) { return { value: m.monthKey, label: monthName(m) }; });
    if (env.touched.length > 1) options.push({ value: RANGE, label: monthsLabel(env.touched, false) });
    box.appendChild(h('div', { 'class': 'cg-period' },
      h('div', { 'class': 'cg-period__switch' },
        h('span', { 'class': 'mk-label' }, 'Month'),
        ui.segmented({ ariaLabel: 'Month', size: 'sm', value: env.sel, options: options, onChange: function (v) { st.period = v; ctx.rerender(); } })),
      h('div', { 'class': 'cg-period__label' }, ui.icon('calendar', 14), h('span', { 'class': 'mk-muted' }, 'Period'), h('strong', null, period.label || '-'))));

    var notes = h('div', { 'class': 'cg-notes' });
    notes.appendChild(note('Theoretical cost comes from the recipes (bill of materials) multiplied by the quantities sold in Petpooja. Actual cost comes from factory transfers at transfer price, ' +
      'local purchases and the stock counts captured in the ERP. The gap between the two is wastage, over-portioning and unrecorded use.', 'info'));
    var f = ctx.filters || {};
    if (period.partial) notes.appendChild(note('The running month is month to date (' + rangeLabel(period.from, period.to) + '): sales, transfers and purchases are actuals to date.', 'clock'));
    if (env.overridden) {
      notes.appendChild(note('Quick switch: showing ' + monthsLabel(env.keys, true) + ', while the date filter covers ' + rangeLabel(f.from, f.to) + '.', 'calendar',
        ui.button({ label: 'Back to the filter period', variant: 'text', size: 'sm', onClick: function () { st.period = null; ctx.rerender(); } })));
    } else if (!filterIsWholeMonths(f)) {
      notes.appendChild(note('Food cost is reported by whole month: the date filter (' + rangeLabel(f.from, f.to) + ') touches ' + monthsLabel(env.touched, true) + ', shown here in full' +
        (period.partial ? ' to date.' : '.'), 'calendar'));
    }
    box.appendChild(notes);
    return box;
  }

  /* ------------------------------------------------------------------ KPI tiles */

  function worstBy(rows, key) {
    var best = null;
    (rows || []).forEach(function (r) { if (isNum(r[key]) && (!best || r[key] > best[key])) best = r; });
    return best;
  }

  function kpis(env) {
    var fc = env.fc, t = fc.totals || {}, p = env.prevFc ? env.prevFc.totals : null;
    var vs = env.prevFc ? 'vs ' + env.prevShort : '';
    var flagged = (fc.rows || []).filter(function (r) { return r.redFlag; });
    var tiles = [];

    tiles.push({ label: 'Theoretical food cost', icon: 'dish', value: fmt.pct(t.theoreticalPct), goodWhen: 'down',
      delta: p ? pointsDelta(t.theoreticalPct, p.theoreticalPct) : null, deltaNote: vs,
      sub: fmt.inr(t.theoretical) + ' at recipe', title: 'Recipe cost of everything sold, as a share of net sales' });

    tiles.push({ label: 'Actual food cost', icon: 'scale', value: fmt.pct(t.actualPct), goodWhen: 'down', tone: t.redFlag ? 'critical' : null,
      delta: p ? pointsDelta(t.actualPct, p.actualPct) : null, deltaNote: vs,
      sub: fmt.inr(t.actual) + ' consumed', title: 'Factory transfers and local purchases adjusted by stock counts, as a share of net sales' });

    tiles.push({ label: 'Variance to recipe', value: pts(t.actualPct, t.theoreticalPct), goodWhen: 'down',
      delta: p ? pointsDelta(t.variancePts, p.variancePts) : null, deltaNote: vs,
      sub: fmt.pct(t.variancePctOfTheoretical) + ' above recipe cost', title: 'Actual less theoretical food cost, in points of net sales' });

    tiles.push({ label: 'Variance value', icon: 'coins', value: fmt.inr(t.variance), goodWhen: 'down',
      delta: p && !(fc.period && fc.period.partial) ? pctDelta(t.variance, p.variance) : null, deltaNote: vs,
      sub: 'Factory items ' + fmt.inr(t.varianceFactory) + ', local ' + fmt.inr(t.varianceLocal),
      title: 'What wastage, over-portioning and unrecorded use cost in rupees' });

    if ((fc.rows || []).length > 1) {
      var worst = worstBy(fc.rows, 'variancePts');
      /* the tile is only marked when the outlet is genuinely a problem: a "worst" outlet in a healthy network is not a warning */
      tiles.push({ label: 'Worst outlet', icon: 'alert-triangle', value: worst.label, tone: worst.redFlag ? 'critical' : null,
        sub: pts(worst.actualPct, worst.theoreticalPct) + ', ' + fmt.inr(worst.variance) + (worst.redFlag ? ' - above the ' + fmt.pct(fc.redFlagPct) + ' red flag' : ''),
        title: 'The outlet whose actual food cost sits furthest above its recipe cost',
        onClick: function () { env.st.outlet = worst.outletId; env.ctx.rerender(); } });
    } else {
      tiles.push({ label: 'Red-flag threshold', icon: 'alert-triangle', value: fmt.pct(fc.redFlagPct), tone: flagged.length ? 'critical' : null,
        sub: isNum(t.actualPct) ? 'Actual is ' + ptsSize(t.actualPct - fc.redFlagPct) + (t.actualPct > fc.redFlagPct ? ' above it' : ' below it') : null,
        title: 'Actual food cost above this share of net sales is treated as a control problem' });
    }

    var wrap = h('div', { 'class': 'cg-kpiblock' }, ui.kpiRow(tiles));
    var tag = ui.sourceTag(SOURCES_THEORETICAL);
    tag.classList.add('cg-source-flat');
    wrap.appendChild(tag);
    return wrap;
  }

  /* ------------------------------------------------------------------ red-flag note */

  function redFlagNote(env) {
    var fc = env.fc, t = fc.totals || {};
    var flagged = (fc.rows || []).filter(function (r) { return r.redFlag; }).sort(function (a, b) { return b.variance - a.variance; });
    if (!flagged.length) return null;
    var box = h('div', { 'class': 'cg-flags' });
    flagged.forEach(function (r) {
      var text = 'Actual food cost is ' + fmt.pct(r.actualPct) + ' of net sales against a recipe cost of ' + fmt.pct(r.theoreticalPct) + '. The ' + ptsSize(r.variancePts) +
        ' gap cost ' + fmt.inrFull(r.variance) + ' in ' + shortPeriod(fc.period) + ' (' + fmt.inrFull(r.varianceFactory) + ' on factory items, ' + fmt.inrFull(r.varianceLocal) + ' on local items).';
      if ((fc.rows || []).length > 1) {
        text += ' Its recipe cost is ' + pts(r.theoreticalPct, t.theoreticalPct) + ' from the network\'s ' + fmt.pct(t.theoreticalPct) + ', while its variance is ' + ptsSize(r.variancePts) +
          ' against ' + ptsSize(t.variancePts) + ' network-wide: a control problem at the outlet (wastage, portioning, unrecorded use), not a pricing one.';
      }
      box.appendChild(ui.callout('critical', r.label + ' is above the ' + fmt.pct(fc.redFlagPct) + ' red flag', text,
        { actions: env.outlets.length > 1 && env.focus && env.focus.id !== r.outletId
          ? ui.button({ label: 'Focus on ' + r.label, size: 'sm', onClick: function () { env.st.outlet = r.outletId; env.ctx.rerender(); } }) : null }));
    });
    return box;
  }

  /* ------------------------------------------------------------------ by outlet: theoretical vs actual, variance value */

  function focusByLabel(env, label) {
    var hit = null;
    env.outlets.forEach(function (o) { if (o.label === label || o.name === label) hit = o; });
    if (!hit || (env.focus && env.focus.id === hit.id)) return;
    env.st.outlet = hit.id;
    env.ctx.rerender();
  }

  function compareChart(env) {
    var fc = env.fc, rows = fc.rows || [], t = fc.totals || {};
    var flagged = rows.filter(function (r) { return r.redFlag; });
    var top = rows.slice().sort(function (a, b) { return b.actualPct - a.actualPct; })[0];
    var subtitle;
    if (rows.length > 1) {
      subtitle = top.label + ' runs at ' + fmt.pct(top.actualPct) + ' against a recipe cost of ' + fmt.pct(top.theoreticalPct) + '. ' +
        (flagged.length ? andList(flagged.map(function (r) { return r.label; })) + (flagged.length > 1 ? ' are' : ' is the only outlet') + ' above the ' + fmt.pct(fc.redFlagPct) + ' red flag'
          : 'No outlet is above the ' + fmt.pct(fc.redFlagPct) + ' red flag') + '; the network is at ' + fmt.pct(t.actualPct) + '.';
    } else {
      subtitle = top.label + ': actual ' + fmt.pct(top.actualPct) + ' against a recipe cost of ' + fmt.pct(top.theoreticalPct) + '; the red flag is ' + fmt.pct(fc.redFlagPct) + '.';
    }
    var chart = MK.charts.mount(null, {
      id: 'cg-compare', kind: 'bar', format: 'pct', height: H_CHART,
      title: 'Theoretical vs actual food cost, % of net sales', subtitle: subtitle,
      data: { categories: rows.map(function (r) { return r.label; }), categoryHeader: 'Outlet',
        series: [{ id: 'theoretical', name: 'Theoretical (recipe)', colourVar: C_THEORETICAL, values: rows.map(function (r) { return r.theoreticalPct; }) },
          { id: 'actual', name: 'Actual', colourVar: C_ACTUAL, values: rows.map(function (r) { return r.actualPct; }) }] },
      table: { columns: [{ key: 'label', label: 'Outlet' }, { key: 'theoreticalPct', label: 'Theoretical', format: 'pct', align: 'right' },
        { key: 'actualPct', label: 'Actual', format: 'pct', align: 'right' }, { key: 'gap', label: 'Variance', align: 'right' },
        { key: 'flag', label: 'Red flag ' + fmt.pct(fc.redFlagPct) }],
        rows: rows.map(function (r) { return { label: r.label, theoreticalPct: r.theoreticalPct, actualPct: r.actualPct, gap: pts(r.actualPct, r.theoreticalPct), flag: r.redFlag ? 'Above' : 'Below' }; }) },
      onClick: env.outlets.length > 1 ? function (d) { focusByLabel(env, d.category); } : null,
      note: 'Red flag: actual food cost above ' + fmt.pct(fc.redFlagPct) + ' of net sales.' + (env.outlets.length > 1 ? ' Select an outlet\'s bars to put it in focus below.' : '')
    });
    chart.el.appendChild(sourceEnd(SOURCES_THEORETICAL));
    return chart.el;
  }

  function varianceChart(env) {
    var fc = env.fc, t = fc.totals || {};
    if (env.outlets.length < 2) return varianceByMonth(env);
    var rows = (fc.rows || []).slice().sort(function (a, b) { return b.variance - a.variance; });
    var first = rows[0], second = rows[1];
    var subtitle = first.label + ' loses ' + fmt.inr(first.variance) + ' to variance' +
      (t.variance > 0 ? ', ' + fmt.pct(first.variance / t.variance, 0) + ' of the network\'s ' + fmt.inr(t.variance) : '') +
      (second && second.variance > 0 ? ' and ' + fmt.num(first.variance / second.variance, 1) + ' times ' + second.label + ', the next outlet.' : '.');
    var chart = MK.charts.mount(null, {
      id: 'cg-variance', kind: 'bar', format: 'inr', height: H_CHART,
      title: 'Variance value by outlet', subtitle: subtitle,
      data: { categories: rows.map(function (r) { return r.label; }), values: rows.map(function (r) { return r.variance; }), name: 'Variance value',
        highlight: first.label, categoryHeader: 'Outlet' },
      table: { columns: [{ key: 'label', label: 'Outlet' }, { key: 'variance', label: 'Variance', format: 'inrFull', align: 'right' },
        { key: 'varianceFactory', label: 'Factory items', format: 'inrFull', align: 'right' }, { key: 'varianceLocal', label: 'Local items', format: 'inrFull', align: 'right' },
        { key: 'share', label: 'Share of network', format: 'pct', align: 'right' }],
        rows: rows.map(function (r) { return { label: r.label, variance: r.variance, varianceFactory: r.varianceFactory, varianceLocal: r.varianceLocal, share: t.variance > 0 ? r.variance / t.variance : null }; }) },
      onClick: function (d) { focusByLabel(env, d.category); },
      note: 'Actual less theoretical food cost in rupees: what wastage, over-portioning and unrecorded use cost in ' + shortPeriod(fc.period) + '.'
    });
    chart.el.appendChild(sourceEnd(SOURCES_THEORETICAL));
    return chart.el;
  }

  /** One outlet in scope: a comparison across outlets says nothing, so the variance is shown across months instead. */
  function varianceByMonth(env) {
    var o = env.focus;
    var points = env.months.map(function (m) { return { m: m, r: rowOf(m.fc, o.id) }; }).filter(function (x) { return x.r; });
    var worst = null;
    points.forEach(function (x) { if (!x.m.partial && (!worst || x.r.variance > worst.r.variance)) worst = x; });
    var chart = MK.charts.mount(null, {
      id: 'cg-variance-month', kind: 'bar', format: 'inr', height: H_CHART,
      title: 'Variance value by month, ' + o.name,
      subtitle: worst ? MK.dates.monthLabel(worst.m.monthKey, true) + ' was the costliest full month: ' + fmt.inr(worst.r.variance) + ' above recipe (' + pts(worst.r.actualPct, worst.r.theoreticalPct) + ').' : '',
      data: { categories: points.map(function (x) { return monthName(x.m); }), values: points.map(function (x) { return x.r.variance; }), name: 'Variance value', categoryHeader: 'Month' },
      note: 'Actual less theoretical food cost in rupees.' + (points.length && points[points.length - 1].m.partial ? ' The running month is to date.' : '')
    });
    chart.el.appendChild(sourceEnd(SOURCES_THEORETICAL));
    return chart.el;
  }

  /* ------------------------------------------------------------------ structure of COGS and the outlet table */

  function structureChart(env) {
    var fc = env.fc, t = fc.totals || {};
    var rows = (fc.rows || []).slice();
    var bars = rows.map(function (r) { return { label: r.label, f: r.theoreticalFactory, l: r.theoreticalLocal, v: Math.max(0, r.variance), actual: r.actual }; });
    if (rows.length > 1) bars.push({ label: 'All outlets', f: t.theoreticalFactory, l: t.theoreticalLocal, v: Math.max(0, t.variance), actual: t.actual });
    var worst = rows.slice().sort(function (a, b) { return (b.actual > 0 ? b.variance / b.actual : 0) - (a.actual > 0 ? a.variance / a.actual : 0); })[0];
    var subtitle = t.actual > 0 ? 'Factory items at recipe are ' + fmt.pct(t.theoreticalFactory / t.actual, 0) + ' of actual food cost and local items ' + fmt.pct(t.theoreticalLocal / t.actual, 0) + '. ' : '';
    if (worst && worst.actual > 0) {
      subtitle += rows.length > 1
        ? 'Variance takes ' + fmt.pct(worst.variance / worst.actual) + ' of ' + worst.label + '\'s food cost against ' + fmt.pct(t.actual > 0 ? t.variance / t.actual : null) + ' across all outlets.'
        : 'Variance takes ' + fmt.pct(worst.variance / worst.actual) + ' of it.';
    }
    var chart = MK.charts.mount(null, {
      id: 'cg-structure', kind: 'hstackedBar', format: 'inr', height: H_STRUCTURE,
      title: 'Structure of actual food cost', subtitle: subtitle,
      data: { categories: bars.map(function (b) { return b.label; }), categoryHeader: 'Outlet', percent: true,
        series: [{ id: 'factory', name: 'Factory items, at recipe', colourVar: C_FACTORY, values: bars.map(function (b) { return b.f; }) },
          { id: 'local', name: 'Local purchases, at recipe', colourVar: C_LOCAL, values: bars.map(function (b) { return b.l; }) },
          { id: 'variance', name: 'Variance (wastage and portioning)', colourVar: C_VARIANCE, values: bars.map(function (b) { return b.v; }) }] },
      note: (bars.length === 1 ? 'The bar is ' + bars[0].label + '\'s actual food cost.' : 'Each bar is an outlet\'s actual food cost.') +
        ' Factory items are charged at transfer price; local purchases are bought by the outlet at the month\'s prices.'
    });
    chart.el.appendChild(sourceEnd(SOURCES_THEORETICAL));
    return chart.el;
  }

  /** A food cost share, marked with icon and ink (never colour alone) when it is above the red flag. */
  function flagged(value, isAbove, threshold) {
    if (!isAbove) return fmt.pct(value);
    return h('span', { 'class': 'cg-flagged', title: 'Above the ' + fmt.pct(threshold) + ' red flag' }, ui.icon('alert-triangle', 14),
      h('span', { 'class': 'mk-sr' }, 'Above the red flag: '), fmt.pct(value));
  }

  function outletTable(env) {
    var fc = env.fc, t = fc.totals || {}, st = env.st;
    var rows = fc.rows || [];
    var clickable = env.outlets.length > 1;
    /* five columns is what a 7/12 card holds at 1280px without scrolling sideways; net sales is in the statement below and in the CSV */
    var varianceBar = ui.cells.bar(null, C_ACTUAL, { format: 'inrFull' });
    var columns = [
      { key: 'label', label: 'Outlet', render: ui.cells.entity(function (r) { return r.colourVar; }) },
      { key: 'theoreticalPct', label: 'Recipe %', format: 'pct', title: 'Theoretical food cost as a share of net sales' },
      { key: 'actualPct', label: 'Actual %', align: 'right', numeric: true, title: 'Actual food cost as a share of net sales; marked when above the ' + fmt.pct(fc.redFlagPct) + ' red flag',
        render: function (v, r) { return flagged(v, r.redFlag, fc.redFlagPct); } },
      { key: 'variancePts', label: 'Variance', align: 'right', sortValue: function (r) { return r.variancePts; },
        render: function (v, r) { return pts(r.actualPct, r.theoreticalPct); } },
      { key: 'variance', label: 'Variance value', format: 'inrFull', render: function (v, r, col, c) {
        return h('div', { 'class': 'cg-varcell' }, varianceBar(v, r, col, c),
          h('div', { 'class': 'cg-varcell__split', title: 'Variance on factory items and on local items' }, 'Factory ' + fmt.inrFull(r.varianceFactory) + ', local ' + fmt.inrFull(r.varianceLocal)));
      } }
    ];
    var table = ui.table({
      columns: columns, rows: rows, dense: true, sortable: true,
      sort: st.sortOutlets || { key: 'variance', dir: 'desc' }, onSort: function (s) { st.sortOutlets = s; },
      rowClass: function (r) { return clickable && env.focus && r.outletId === env.focus.id ? 'is-selected' : ''; },
      onRowClick: clickable ? function (r) { st.outlet = r.outletId; env.ctx.rerender(); } : null,
      footer: rows.length > 1 ? { label: 'All outlets', theoreticalPct: t.theoreticalPct, actualPct: flagged(t.actualPct, t.redFlag, fc.redFlagPct), variancePts: pts(t.actualPct, t.theoreticalPct),
        variance: fmt.inrFull(t.variance) } : null,
      empty: 'No outlet food cost for this period'
    });
    return ui.card({ title: 'Food cost by outlet', flush: true, className: 'cg-fill',
      subtitle: shortPeriod(fc.period) + (clickable ? '. Select a row to put the outlet in focus below.' : '.'),
      actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', onClick: function () {
        ui.downloadCsv('food-cost-by-outlet-' + env.keys.join('_') + '.csv', [
          { key: 'label', label: 'Outlet' }, { key: 'netSales', label: 'Net sales' }, { key: 'theoretical', label: 'Theoretical food cost' }, { key: 'theoreticalPct', label: 'Theoretical %' },
          { key: 'actual', label: 'Actual food cost' }, { key: 'actualPct', label: 'Actual %' }, { key: 'variance', label: 'Variance value' }, { key: 'variancePts', label: 'Variance, share of net sales' },
          { key: 'varianceFactory', label: 'Variance on factory items' }, { key: 'varianceLocal', label: 'Variance on local items' }, { key: 'redFlag', label: 'Above red flag' }], rows);
      } }),
      body: table, footer: ui.sourceTag(SOURCES_THEORETICAL) });
  }

  /* ------------------------------------------------------------------ outlet in focus: trend and COGS statement */

  function focusTitle(env) {
    var o = env.focus;
    var control = env.outlets.length > 1 ? ui.segmented({ ariaLabel: 'Outlet in focus', size: 'sm', value: o.id,
      options: env.outlets.map(function (x) { return { value: x.id, label: x.label }; }),
      onChange: function (v) { env.st.outlet = v; env.ctx.rerender(); } }) : null;
    return ui.sectionTitle('Outlet in focus: ' + o.name, 'Month by month, the cost statement, and the recipe cards at this outlet\'s menu prices', control);
  }

  function trendChart(env) {
    var o = env.focus, flag = env.fc.redFlagPct;
    var points = env.months.map(function (m) { return { m: m, r: rowOf(m.fc, o.id) }; });
    var labels = points.map(function (x) { return MK.dates.monthLabel(x.m.monthKey, false); });
    var actual = points.map(function (x) { return x.r && x.r.netSales > 0 ? x.r.actualPct : null; });
    var theoretical = points.map(function (x) { return x.r && x.r.netSales > 0 ? x.r.theoreticalPct : null; });
    var known = points.filter(function (x) { return x.r && x.r.netSales > 0; });
    var above = known.filter(function (x) { return x.r.redFlag; });
    var gaps = known.map(function (x) { return x.r.variancePts; });
    var subtitle = '';
    if (known.length) {
      subtitle = o.name + '\'s actual cost sits ' + (gaps.length > 1 && Math.min.apply(null, gaps) !== Math.max.apply(null, gaps)
        ? ptsSize(Math.min.apply(null, gaps)) + ' to ' + ptsSize(Math.max.apply(null, gaps)) : ptsSize(gaps[0])) + ' above its recipe cost; ' +
        (above.length ? 'it is above the ' + fmt.pct(flag) + ' red flag in ' + fmt.num(above.length) + ' of ' + fmt.num(known.length) + ' months.' : 'it stays below the ' + fmt.pct(flag) + ' red flag in every month.');
    }
    var last = points[points.length - 1];
    /* the selected month is marked, except the last one: the line-end labels already sit there */
    var markers = env.keys.length === 1 && env.keys[0] !== env.months[env.months.length - 1].monthKey
      ? [{ label: 'Selected month', atLabel: MK.dates.monthLabel(env.keys[0], false) }] : [];
    var chart = MK.charts.mount(null, {
      id: 'cg-trend', kind: 'line', format: 'pct', height: H_CHART, zeroBaseline: false,
      title: 'Actual vs theoretical food cost by month, ' + o.name, subtitle: subtitle,
      data: { labels: labels, labelHeader: 'Month', markers: markers,
        series: [{ id: 'actual', name: 'Actual', colourVar: C_ACTUAL, values: actual },
          { id: 'theoretical', name: 'Theoretical (recipe)', colourVar: C_THEORETICAL, values: theoretical },
          { id: 'flag', name: 'Red flag', colourVar: C_FLAG, values: points.map(function () { return flag; }) }] },
      note: last && last.m.partial ? labels[labels.length - 1] + ' = ' + shortPeriod(last.m.fc.period) + '.' : null
    });
    chart.el.appendChild(sourceEnd(SOURCES_THEORETICAL));
    return chart.el;
  }

  function statement(rows) {
    return h('dl', { 'class': 'cg-stmt' }, rows.filter(Boolean).map(function (r) {
      return h('div', { 'class': ['cg-stmt__row', r.kind ? 'cg-stmt__row--' + r.kind : ''], title: r.title || null },
        h('dt', { 'class': 'cg-stmt__label' }, r.sign ? h('span', { 'class': 'cg-stmt__sign', 'aria-hidden': 'true' }, r.sign) : null,
          r.dotVar ? h('span', { 'class': 'mk-legend-dot', style: { background: 'var(' + r.dotVar + ')' } }) : null, h('span', { 'class': 'cg-stmt__text' }, r.label)),
        h('dd', { 'class': 'cg-stmt__value' }, r.value),
        h('dd', { 'class': 'cg-stmt__share' }, r.share || ''));
    }));
  }

  function statementCard(env) {
    var o = env.focus, fc = env.fc, r = rowOf(fc, o.id);
    if (!r || !(r.netSales > 0)) {
      return ui.card({ title: 'Food cost statement, ' + o.name, className: 'cg-fill', body: ui.emptyState('No sales in this period', 'There is no food cost to explain for ' + o.name + ' in ' + shortPeriod(fc.period) + '.', { compact: true }) });
    }
    function share(v) { return r.netSales > 0 ? fmt.pct(v / r.netSales) : ''; }
    var rows = [
      { kind: 'start', label: 'Net sales', value: fmt.inrFull(r.netSales), share: 'net of GST' },
      { sign: '+', dotVar: C_FACTORY, label: 'Factory items, at recipe', title: 'What the recipes call for, at transfer price', value: fmt.inrFull(r.theoreticalFactory), share: share(r.theoreticalFactory) },
      { sign: '+', dotVar: C_LOCAL, label: 'Local purchases, at recipe', title: 'What the recipes call for, at the month\'s purchase prices', value: fmt.inrFull(r.theoreticalLocal), share: share(r.theoreticalLocal) },
      { kind: 'total', sign: '=', label: 'Theoretical food cost', value: fmt.inrFull(r.theoretical), share: fmt.pct(r.theoreticalPct) },
      { sign: '+', dotVar: C_VARIANCE, label: 'Factory items above recipe', title: 'Dispatched by the central kitchen above what the recipes call for', value: fmt.inrFull(r.varianceFactory), share: share(r.varianceFactory) },
      { sign: '+', dotVar: C_VARIANCE, label: 'Local items above recipe', title: 'Used above recipe according to the stock count', value: fmt.inrFull(r.varianceLocal), share: share(r.varianceLocal) },
      { kind: r.redFlag ? 'total-bad' : 'total', sign: '=', label: 'Actual food cost', value: fmt.inrFull(r.actual), share: fmt.pct(r.actualPct) }
    ];
    var subtitle = shortPeriod(fc.period) + ': ' + fmt.inrFull(r.variance) + ' (' + fmt.pct(r.variancePctOfTheoretical) + ') was consumed above what the recipes call for - ' +
      fmt.pct(r.variance > 0 ? r.varianceFactory / r.variance : null, 0) + ' of it on factory items.';
    return ui.card({ title: 'Food cost statement, ' + o.name, subtitle: subtitle, className: 'cg-fill',
      body: [statement(rows),
        note('Factory transfers of ' + fmt.inrFull(r.actualFactory) + ' equal what the central kitchen dispatched to ' + o.name + ' in the period; local items of ' + fmt.inrFull(r.actualLocal) + ' follow purchases and the stock count.', 'factory')],
      footer: ui.sourceTag(SOURCES_THEORETICAL) });
  }

  /* ------------------------------------------------------------------ recipe cost cards */

  function dishList(env) {
    var fc = env.fc;
    var sold = (fc.dishes || []).filter(function (d) { return d.qty > 0; });
    if (sold.length) return sold.map(function (d) { return { dishId: d.dishId, short: d.short || d.name, name: d.name, category: d.category, qty: d.qty, costPerPortion: d.costPerPortion, foodCostPct: d.foodCostPct, theoreticalCost: d.theoreticalCost }; });
    /* nothing sold in scope (a persona without outlets): the recipes are master data, so the cards still work */
    return ((MK.config && MK.config.dishes) || []).map(function (d) {
      var c = call(function () { return MK.finance.dishCost(d.id, { mediumId: 'dinein', monthKey: env.costMonth }); }, null);
      return { dishId: d.id, short: d.short || d.name, name: d.name, category: d.category, qty: null, costPerPortion: c ? c.food : null, foodCostPct: c ? c.foodCostPctPos : null, theoreticalCost: null };
    });
  }

  function dishTable(env) {
    var st = env.st, list = env.dishes, hasSales = list.some(function (d) { return d.qty > 0; });
    var columns = [{ key: 'short', label: 'Dish', render: ui.cells.twoLine(function (r) { return categoryLabel(r.category); }, { maxWidth: 124 }) }];
    if (hasSales) columns.push({ key: 'qty', label: 'Sold', format: 'num', title: 'Portions sold in the period (Petpooja)' });
    columns.push({ key: 'costPerPortion', label: 'Cost', align: 'right', numeric: true, title: 'Recipe cost of one portion', render: function (v) { return perPortion(v); } });
    columns.push({ key: 'foodCostPct', label: 'Food cost %', format: 'pct', render: ui.cells.heat(null, null, { format: 'pct' }),
      title: hasSales ? 'Recipe cost of what was sold over its net sales, all channels' : 'Recipe cost over the POS price' });
    var top = list.slice().sort(function (a, b) { return num(b.foodCostPct) - num(a.foodCostPct); })[0];
    return ui.card({ title: 'Dishes by recipe cost', flush: true,
      subtitle: top ? top.name + ' carries the heaviest food cost: ' + fmt.pct(top.foodCostPct) + (hasSales ? ' of its net sales' : ' of its POS price') + '. Select a dish for its recipe card.' : null,
      body: ui.table({ columns: columns, rows: list, dense: true, sortable: true,
        sort: st.sortDishes || { key: 'foodCostPct', dir: 'desc' }, onSort: function (s) { st.sortDishes = s; },
        rowClass: function (r) { return r.dishId === env.dishId ? 'is-selected' : ''; },
        onRowClick: function (r) { st.dish = r.dishId; env.ctx.rerender(); } }),
      footer: ui.sourceTag(hasSales ? SOURCES_THEORETICAL : 'erp') });
  }

  var ITEM_KINDS = {
    factory: { colourVar: C_FACTORY, title: 'Made in the central kitchen, charged at transfer price' },
    local: { colourVar: C_LOCAL, title: 'Bought by the outlet at the month\'s price' },
    packaging: { colourVar: C_PACKAGING, title: 'Per-dish packaging for this way of selling' }
  };

  /** Bill-of-materials item: source dot, name and a muted second line; both lines truncate so a long name never widens the table. */
  function itemCell(row) {
    var kind = ITEM_KINDS[row.kind] || ITEM_KINDS.local;
    return h('div', { 'class': 'cg-item', title: row.name + ' - ' + kind.title },
      h('span', { 'class': 'mk-legend-dot', style: { background: 'var(' + kind.colourVar + ')' } }),
      h('div', { 'class': 'cg-item__text' }, h('div', { 'class': 'cg-item__name' }, row.name), h('div', { 'class': 'cg-item__sub' }, row.sub)));
  }

  function bomRows(card) {
    var rows = [];
    (card.factoryItems || []).forEach(function (i) {
      rows.push({ kind: 'factory', name: i.name, sub: 'Factory ' + i.sku + ', at transfer price', qty: qty(i.grams, 'g'), rate: rate(i.transferPrice, 'kg'), cost: i.cost });
    });
    (card.localItems || []).forEach(function (i) {
      rows.push({ kind: 'local', name: i.name, sub: 'Local purchase', qty: qty(i.qty, i.unit), rate: rate(i.price, i.priceUnit), cost: i.cost });
    });
    (card.packagingItems || []).forEach(function (i) {
      rows.push({ kind: 'packaging', name: i.name, sub: 'Packaging, ' + mediumLabel(card.mediumId).toLowerCase(), qty: qty(i.qty, i.unit), rate: rate(i.price, i.priceUnit), cost: i.cost });
    });
    return rows;
  }

  function bomLegend() {
    function item(colourVar, text) { return h('span', { 'class': 'cg-bomlegend__item' }, h('span', { 'class': 'mk-legend-dot', style: { background: 'var(' + colourVar + ')' } }), text); }
    return h('div', { 'class': 'cg-bomlegend' }, item(C_FACTORY, 'Factory item at transfer price'), item(C_LOCAL, 'Local purchase'), item(C_PACKAGING, 'Packaging'));
  }

  function sellingTable(env, cards) {
    var selected = env.medium;
    function price(c) { return c.mediumId === 'delivery' ? c.aggPrice : c.posPrice; }
    function line(label, fn, cls) {
      var row = { line: label, cls: cls || '' };
      cards.forEach(function (c) { row[c.mediumId] = fn(c, price(c)); });
      return row;
    }
    var rows = [
      line('Price list', function (c) { return c.mediumId === 'delivery' ? 'Aggregator' : 'POS'; }),
      line('Menu price', function (c, p) { return menuPrice(p); }),
      line('Food cost', function (c) { return perPortion(c.food); }),
      line('Dish packaging', function (c) { return perPortion(c.packagingCost); }),
      line('Total cost', function (c) { return perPortion(c.total); }, 'is-strong'),
      line('Contribution', function (c, p) { return isNum(p) ? perPortion(p - c.total) : '-'; }, 'is-strong'),
      line('Food cost, % of price', function (c, p) { return isNum(p) && p > 0 ? fmt.pct(c.food / p) : '-'; }),
      line('Contribution, % of price', function (c, p) { return isNum(p) && p > 0 ? fmt.pct((p - c.total) / p) : '-'; })
    ];
    var columns = [{ key: 'line', label: 'Per portion' }].concat(cards.map(function (c) {
      return { key: c.mediumId, align: 'right', numeric: true, className: c.mediumId === selected ? 'cg-col-selected' : '', label: mediumLabel(c.mediumId) };
    }));
    return ui.table({ columns: columns, rows: rows, dense: true, sortable: false, rowClass: function (r) { return r.cls; } });
  }

  function recipeCard(env) {
    var st = env.st, o = env.focus, dishId = env.dishId;
    var opts = { monthKey: env.costMonth };
    if (o) opts.outletId = o.id;
    var cards = MEDIUMS.map(function (m) { return call(function () { return MK.finance.dishCost(dishId, Object.assign({ mediumId: m }, opts)); }, null); }).filter(Boolean);
    var card = byId(cards, env.medium, 'mediumId');
    if (!card) return ui.card({ title: 'Recipe cost card', body: ui.emptyState('No recipe for this dish', 'The recipe master has no bill of materials for the selected dish.', { compact: true }) });

    var rows = bomRows(card);
    var total = card.total;
    var bom = ui.table({ dense: true, sortable: false,
      columns: [
        { key: 'name', label: 'Item', render: function (v, r) { return itemCell(r); } },
        { key: 'qty', label: 'Quantity', align: 'right', numeric: true },
        { key: 'rate', label: 'Rate', align: 'right', numeric: true },
        { key: 'cost', label: 'Cost', align: 'right', numeric: true, render: function (v) { return perPortion(v); } },
        { key: 'share', label: '% of cost', align: 'right', numeric: true, render: function (v, r) { return total > 0 ? fmt.pct(r.cost / total) : '-'; } }],
      rows: rows,
      footer: [
        { name: 'Factory items', cost: perPortion(card.factoryCost), share: total > 0 ? fmt.pct(card.factoryCost / total) : '-' },
        { name: 'Local items', cost: perPortion(card.localCost), share: total > 0 ? fmt.pct(card.localCost / total) : '-' },
        { name: 'Food cost', cost: perPortion(card.food), share: total > 0 ? fmt.pct(card.food / total) : '-' },
        { name: 'Dish packaging, ' + mediumLabel(card.mediumId).toLowerCase(), cost: perPortion(card.packagingCost), share: total > 0 ? fmt.pct(card.packagingCost / total) : '-' },
        { name: 'Total cost per portion', cost: perPortion(card.total), share: fmt.pct(total > 0 ? 1 : null, 0) }],
      empty: 'The recipe has no items' });

    var where = o ? o.name : 'all outlets';
    var subtitle = MK.dates.monthLabel(env.costMonth, true) + (o ? ', ' + where : '') + ': food cost ' + perPortion(card.food) + ' a portion = ' + fmt.pct(card.foodCostPctPos) + ' of the ' +
      menuPrice(card.posPrice) + ' POS price' + (isNum(card.aggPrice) ? ' and ' + fmt.pct(card.foodCostPctAgg) + ' of the ' + menuPrice(card.aggPrice) + ' aggregator price.' : '.');

    var body = [];
    if (o && card.soldHere === false) body.push(ui.callout('info', null, card.name + ' is not on the menu at ' + o.name + '; the card shows the recipe and the POS price only.'));
    body.push(h('div', { 'class': 'cg-recipe__chips' }, ui.chip(categoryLabel(card.category)), ui.chip(card.veg ? 'Vegetarian' : 'Non-vegetarian', card.veg ? 'good' : 'neutral'),
      ui.chip('POS ' + menuPrice(card.posPrice), 'neutral', { dotVar: '--ch-petpooja' }),
      isNum(card.aggPrice) ? ui.chip('Aggregators ' + menuPrice(card.aggPrice), 'neutral', { title: 'The restaurant\'s own menu price on ' + aggregatorNames() + ' at ' + where }) : null));
    body.push(h('div', { 'class': 'cg-recipe__block' }, h('div', { 'class': 'cg-subhead' }, h('h4', null, 'Bill of materials, per portion'), bomLegend()), bom));
    /* the caveat rides the sub-head, not only the small print: delivery contribution looks the best of the three until the aggregator takes its cut */
    body.push(h('div', { 'class': 'cg-recipe__block' }, h('div', { 'class': 'cg-subhead' }, h('h4', null, 'Price, cost and contribution by way of selling'),
      h('span', { 'class': 'cg-subnote' }, ui.icon('alert-triangle', 13), h('span', null, 'Delivery contribution is before ' + aggregatorNames() + ' take their fees'))), sellingTable(env, cards)));

    var op = card.orderPackaging || {};
    var auditPage = MK.router.isAllowed && MK.router.isAllowed('revenue-audit') ? 'revenue-audit' : null;
    body.push(h('div', { 'class': 'cg-recipe__notes' },
      note('Contribution is the menu price less food cost and dish packaging, before aggregator fees and before the once-per-order bag, seal and tissue (' +
        perPortion(op.takeaway) + ' takeaway, ' + perPortion(op.delivery) + ' delivery). Menu prices are before GST.', 'info',
        auditPage ? ui.link('What the aggregators take', MK.router.href(auditPage), { icon: 'arrow-right' }) : null),
      !isNum(card.aggPrice) ? note(o ? 'No aggregator price: the dish is not listed at ' + o.name + '.' : 'Aggregator prices differ by outlet and no outlet is in your scope, so only the POS price is shown.', 'info') : null));

    return ui.card({ title: card.name, subtitle: subtitle, flush: true, className: 'cg-recipe',
      actions: ui.segmented({ ariaLabel: 'Packaging for', size: 'sm', value: env.medium,
        options: MEDIUMS.map(function (m) { return { value: m, label: mediumLabel(m) }; }), onChange: function (v) { st.medium = v; env.ctx.rerender(); } }),
      body: body, footer: ui.sourceTag('erp') });
  }

  function priceChangesFor(dish, outletId) {
    return ((dish && dish.priceChanges) || []).filter(function (c) { return !c.outletId || !outletId || c.outletId === outletId; });
  }

  function historyCard(env) {
    var o = env.focus, dishId = env.dishId;
    var dish = byId((MK.config && MK.config.dishes) || [], dishId);
    var rows = env.months.map(function (m) {
      var opts = { mediumId: 'dinein', monthKey: m.monthKey };
      if (o) opts.outletId = o.id;
      var c = call(function () { return MK.finance.dishCost(dishId, opts); }, null);
      return c ? { monthKey: m.monthKey, month: monthName(m), label: MK.dates.monthLabel(m.monthKey, false), posPrice: c.posPrice, aggPrice: c.aggPrice, food: c.food, pctPos: c.foodCostPctPos, pctAgg: c.foodCostPctAgg } : null;
    }).filter(Boolean);
    if (!rows.length) return null;

    var changes = priceChangesFor(dish, o && o.id);
    var canPrice = MK.data && typeof MK.data.posPriceOn === 'function';
    var markers = [], sentences = [];
    changes.forEach(function (c) {
      var monthKey = c.date.slice(0, 7);
      var at = byId(rows, monthKey, 'monthKey');
      if (!at) return;
      var idx = rows.indexOf(at), before = idx > 0 ? rows[idx - 1] : null;
      var isPos = c.list === 'pos';
      var dayBefore = MK.dates.addDays(c.date, -1);
      var oldPrice = canPrice ? call(function () { return isPos ? MK.data.posPriceOn(dishId, dayBefore) : (o ? MK.data.aggPriceOn(dishId, o.id, dayBefore) : null); }, null) : null;
      markers.push({ label: (isPos ? 'POS' : 'Aggregator') + ' price ' + (isNum(oldPrice) ? menuPrice(oldPrice) + ' to ' : 'now ') + menuPrice(c.price), atLabel: at.label });
      var text = MK.dates.label(c.date, 'd MMM yyyy') + ': ' + (isPos ? 'POS' : 'aggregator') + ' price ' + (isNum(oldPrice) ? 'moved from ' + menuPrice(oldPrice) + ' to ' : 'set to ') + menuPrice(c.price) +
        (c.note ? ' (' + c.note.charAt(0).toLowerCase() + c.note.slice(1) + ')' : '') + '.';
      var key = isPos ? 'pctPos' : 'pctAgg';
      if (before && isNum(before[key]) && isNum(at[key])) {
        text += ' Food cost went from ' + fmt.pct(before[key]) + ' of the price in ' + before.label + ' to ' + fmt.pct(at[key]) + ' in ' + at.label +
          ', while the recipe cost moved from ' + perPortion(before.food) + ' to ' + perPortion(at.food) + ' a portion.';
      }
      if (isPos && before && isNum(before.aggPrice) && isNum(at.aggPrice)) {
        text += before.aggPrice === at.aggPrice
          ? ' The aggregator price' + (o ? ' at ' + o.name : '') + ' stayed at ' + menuPrice(at.aggPrice) + ', so the delivery markup over the POS price narrowed from ' +
            fmt.pct(before.aggPrice / before.posPrice - 1) + ' to ' + fmt.pct(at.aggPrice / at.posPrice - 1) + '.'
          : ' The aggregator price' + (o ? ' at ' + o.name : '') + ' moved from ' + menuPrice(before.aggPrice) + ' to ' + menuPrice(at.aggPrice) + '.';
      }
      sentences.push(text);
    });

    var first = rows[0], last = rows[rows.length - 1];
    var moved = 'the recipe cost moved from ' + perPortion(first.food) + ' in ' + first.label + ' to ' + perPortion(last.food) + ' in ' + last.label;
    var subtitle = sentences.length
      ? fmt.num(sentences.length) + (sentences.length === 1 ? ' menu price change' : ' menu price changes') + ' in the data' + (o ? ' at ' + o.name : '') + '; ' + moved + '.'
      : 'No menu price change in the data: ' + moved + ' with local purchase prices.';
    var hasAgg = rows.some(function (r) { return isNum(r.pctAgg); });
    /* the chart carries its own takeaway: where the food cost share started, where it is now, and what the aggregator price does to it */
    var chartSub = '';
    if (isNum(last.pctPos)) {
      var movedPts = isNum(first.pctPos) && Math.abs(last.pctPos - first.pctPos) >= 0.0005;
      chartSub = movedPts
        ? 'At the POS price the share went from ' + fmt.pct(first.pctPos) + ' in ' + first.label + ' to ' + fmt.pct(last.pctPos) + ' in ' + last.label + ' (' + pts(last.pctPos, first.pctPos) + ')'
        : 'At the POS price the share is ' + fmt.pct(last.pctPos) + ' in ' + last.label + ', steady across the months';
      chartSub += isNum(last.pctAgg)
        ? '; the higher aggregator price carries it down to ' + fmt.pct(last.pctAgg) + '.'
        : '.';
    }
    var series = [{ id: 'pos', name: 'At POS price', colourVar: '--ch-petpooja', values: rows.map(function (r) { return isNum(r.pctPos) ? r.pctPos : null; }) }];
    if (hasAgg) series.push({ id: 'agg', name: 'At aggregator price', colourVar: C_THEORETICAL, values: rows.map(function (r) { return isNum(r.pctAgg) ? r.pctAgg : null; }) });

    var host = h('div', { 'class': 'cg-history' });
    sentences.forEach(function (s) { host.appendChild(ui.callout('info', null, s, { icon: 'info' })); });
    MK.charts.mount(host, {
      id: 'cg-history', kind: 'line', format: 'pct', height: H_HISTORY, zeroBaseline: false, bare: true,
      title: 'Food cost as a share of the menu price', subtitle: chartSub,
      data: { labels: rows.map(function (r) { return r.label; }), labelHeader: 'Month', markers: markers, series: series },
      table: { columns: [{ key: 'month', label: 'Month' }, { key: 'posPrice', label: 'POS price', format: 'inrFull', align: 'right' },
        { key: 'aggPrice', label: 'Aggregator price', format: 'inrFull', align: 'right' }, { key: 'foodText', label: 'Food cost / portion', align: 'right' },
        { key: 'pctPos', label: '% of POS price', format: 'pct', align: 'right' }, { key: 'pctAgg', label: '% of aggregator price', format: 'pct', align: 'right' }],
        rows: rows.map(function (r) { return { month: r.month, posPrice: r.posPrice, aggPrice: r.aggPrice, foodText: perPortion(r.food), pctPos: r.pctPos, pctAgg: r.pctAgg }; }) },
      note: 'Menu prices on the last day of each month; factory items stay at the standard transfer price, local items follow the month\'s purchase price.'
    });
    return ui.card({ title: 'Price and cost history, ' + (dish ? dish.short || dish.name : dishId), subtitle: subtitle, className: 'cg-fill',
      body: host, footer: ui.sourceTag('erp') });
  }

  /* ------------------------------------------------------------------ page */

  function render(rootEl, ctx) {
    var st = ctx.state;
    if (!MK.finance || typeof MK.finance.foodCost !== 'function') {
      rootEl.appendChild(ui.emptyState('Cost data is not loaded', 'The finance layer did not start, so there is no food cost to show.', { icon: 'database' }));
      return;
    }
    var monthKeys = (MK.config && MK.config.months) || [];
    var months = monthKeys.map(function (k) {
      var fc = call(function () { return MK.finance.foodCost(k); }, null);
      return fc ? { monthKey: k, fc: fc, partial: !!(fc.period && fc.period.partial) } : null;
    }).filter(Boolean);
    if (!months.length) {
      rootEl.appendChild(ui.emptyState('No cost months in the data', null, { icon: 'calendar' }));
      return;
    }

    /* the outlet in focus belongs to the persona who chose it: a role switch starts the new persona on its own default */
    var userId = (ctx.user && ctx.user.id) || '';
    if (st.userId !== userId) { st.userId = userId; st.outlet = null; }

    /* period: the date filter decides; the quick switch overrides until the filter changes */
    var f = ctx.filters || {};
    var filterKey = (f.from || '') + '|' + (f.to || '');
    if (st.filterKey !== filterKey) { st.filterKey = filterKey; st.period = null; }
    var touched = touchedMonths(f, months);
    var defaultSel = touched.length > 1 ? RANGE : touched[0];
    var known = months.some(function (m) { return m.monthKey === st.period; }) || (st.period === RANGE && touched.length > 1);
    var sel = known ? st.period : defaultSel;
    var keys = sel === RANGE ? touched : [sel];
    var single = keys.length === 1 ? byId(months, keys[0], 'monthKey') : null;
    var fc = single ? single.fc : call(function () { return MK.finance.foodCost({ from: keys[0], to: keys[keys.length - 1] }); }, null);
    if (!fc) {
      rootEl.appendChild(ui.emptyState('Food cost could not be read for this period', null, { icon: 'database' }));
      return;
    }
    var prevIdx = single ? months.indexOf(single) - 1 : -1;
    var outlets = outletOptions().filter(function (o) { return !!rowOf(fc, o.id); });

    /* outlet in focus: keep the choice while it stays in scope; start with the outlet furthest above its recipe cost */
    var focus = byId(outlets, st.outlet);
    if (!focus && outlets.length) {
      var worst = worstBy(fc.rows, 'variancePts');
      focus = (worst && byId(outlets, worst.outletId)) || outlets[0];
    }

    var env = {
      st: st, ctx: ctx, months: months, touched: touched, sel: sel, keys: keys, overridden: sel !== defaultSel,
      fc: fc, prevFc: prevIdx >= 0 ? months[prevIdx].fc : null, prevShort: prevIdx >= 0 ? MK.dates.monthLabel(months[prevIdx].monthKey, false) : '',
      outlets: outlets, focus: focus || null,
      costMonth: keys[keys.length - 1],
      medium: MEDIUMS.indexOf(st.medium) !== -1 ? st.medium : 'delivery'
    };

    safe(rootEl, 'Page header', function () { return header(env); });

    if (!outlets.length) {
      var who = ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel : 'Your role';
      rootEl.appendChild(ui.card({ body: ui.emptyState('No outlet food cost in your scope',
        who + ' has no outlet assigned, and food cost is measured where the food is sold. The recipe cost cards below are master data: they show what every dish draws from the central kitchen and what it costs per portion.',
        { icon: 'lock', action: MK.router.isAllowed && MK.router.isAllowed('factory-overview') ? ui.link('Open factory economics', MK.router.href('factory-overview'), { icon: 'arrow-right' }) : null }) }));
    } else if (outlets.length === 1) {
      /* one outlet in scope: nothing to compare across outlets, so the same questions are answered across months */
      safe(rootEl, 'KPI tiles', function () { return kpis(env); });
      safe(rootEl, 'Red-flag note', function () { return redFlagNote(env); });
      safe(rootEl, 'Trend and variance', function () { return ui.grid([7, 5], [trendChart(env), varianceByMonth(env)]); });
      safe(rootEl, 'Structure and statement', function () { return ui.grid([6, 6], [structureChart(env), statementCard(env)]); });
    } else {
      safe(rootEl, 'KPI tiles', function () { return kpis(env); });
      safe(rootEl, 'Red-flag note', function () { return redFlagNote(env); });
      safe(rootEl, 'Food cost by outlet', function () { return ui.grid([7, 5], [compareChart(env), varianceChart(env)]); });
      safe(rootEl, 'Structure of food cost', function () { return ui.grid([5, 7], [structureChart(env), outletTable(env)]); });
      safe(rootEl, 'Outlet in focus', function () { return focusTitle(env); });
      safe(rootEl, 'Trend and statement', function () { return ui.grid([6, 6], [trendChart(env), statementCard(env)]); });
    }

    /* recipe cost cards */
    env.dishes = dishList(env);
    if (!env.dishes.length) return;
    var chosen = byId(env.dishes, st.dish, 'dishId');
    if (!chosen) chosen = env.dishes.slice().sort(function (a, b) { return num(b.foodCostPct) - num(a.foodCostPct); })[0];
    env.dishId = chosen.dishId;

    rootEl.appendChild(ui.sectionTitle('Recipe cost cards',
      'What one portion costs' + (env.focus ? ' at ' + env.focus.name + '\'s menu prices' : '') + ', ' + MK.dates.monthLabel(env.costMonth, true) + ': factory items at transfer price, local items, packaging by way of selling'));
    safe(rootEl, 'Recipe cost cards', function () {
      return ui.grid([5, 7], [ui.stack([dishTable(env), historyCard(env)], null, 'cg-leftcol'), recipeCard(env)], { start: true });
    });
  }

  MK.router.register({
    id: 'costs-cogs',
    route: '#/costs/cogs',
    group: 'Costs',
    title: 'Food cost (COGS)',
    subtitle: 'Theoretical versus actual food cost',
    units: 'all',
    roles: null,
    filters: ['date'],
    render: render
  });
})(window);
