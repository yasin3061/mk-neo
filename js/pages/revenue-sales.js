/*
 * #/revenue/sales - Sales explorer (client brief area 1: outlet / city / channel / medium reporting).
 *
 * The client asked for two readings by name and each gets its own block:
 *   A  "Outlets across channels"  - outlet-wise data across all channels
 *   B  "Channels across outlets"  - channel-wise data across all outlets
 * then C the outlet x channel matrix, D the trend, E city and medium, F the two margin leaks
 * (restaurant-funded discounts and cancellations).
 *
 * Every figure comes from MK.data.* (the Petpooja POS feed) and is formatted with MK.fmt; the takeaway under
 * each title is composed from those values. Role scope is applied by the data layer, never here.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;

  /* ------------------------------------------------------------------ vocabulary */

  var MEASURES = {
    netSales: { label: 'Net sales', noun: 'net sales', format: 'inr', additive: true, prevKey: 'prevNetSales' },
    orders: { label: 'Orders', noun: 'orders', format: 'num', additive: true, prevKey: 'prevOrders' },
    aov: { label: 'Average order value', noun: 'average order value', format: 'inrFull', additive: false, prevKey: null }
  };
  var MEASURE_OPTIONS = [{ value: 'netSales', label: 'Net sales' }, { value: 'orders', label: 'Orders' }, { value: 'aov', label: 'AOV' }];
  var SHOW_OPTIONS = [{ value: 'value', label: 'Value' }, { value: 'row', label: '% of outlet' }, { value: 'col', label: '% of channel' }];
  var GRAIN_OPTIONS = [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }];
  var BY_OPTIONS = [{ value: 'total', label: 'Total' }, { value: 'outlet', label: 'Outlet' }, { value: 'city', label: 'City' },
    { value: 'channel', label: 'Channel' }, { value: 'medium', label: 'Medium' }];
  var BY_WORDS = { outlet: 'outlet', city: 'city', channel: 'channel', medium: 'medium' };

  /* capability keys (docs/DATA-FEASIBILITY.md section 3) behind the two leak measures */
  var FIELD_OF = { discountPct: 'order.discountRestaurantFunded', cancelRate: 'order.status' };

  var CHART_HEIGHT = 300;        /* px - layout, not data */
  var MATRIX_CELLS_PCT = 48;     /* share of the matrix width given to the channel cells, split equally between them */
  var DAY_GRAIN_UP_TO = 45;      /* days in the range up to which the trend opens on the day grain */
  var MAX_MARKERS = 6;           /* event captions a trend can carry before they crowd each other */
  var LONG_EVENT_DAYS = 7;       /* an event longer than this is marked where it begins */
  var WEEKEND_DOWS = { 4: true, 5: true, 6: true }; /* Fri, Sat, Sun (0 = Monday) */
  var DAYS_IN_WEEK = 7;
  var MIN_FULL_WEEKS = 3;        /* full weeks needed before the part-weeks at the edges are left out of the week view */

  /* ------------------------------------------------------------------ small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function has(list, value) { return Array.isArray(list) && list.indexOf(value) !== -1; }

  function say(measure, v) {
    if (!isNum(v)) return '-';
    return measure === 'netSales' ? fmt.inr(v) : (measure === 'orders' ? fmt.num(v) : fmt.inrFull(v));
  }

  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''; }
  function upperFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

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

  function plural(n, word) { return fmt.num(n) + ' ' + word + (n === 1 ? '' : 's'); }

  /** Indices of the largest and smallest number in a list (nulls skipped); null when there is none. */
  function extremes(values) {
    var hi = -1, lo = -1;
    (values || []).forEach(function (v, i) {
      if (!isNum(v)) return;
      if (hi === -1 || v > values[hi]) hi = i;
      if (lo === -1 || v < values[lo]) lo = i;
    });
    return hi === -1 ? null : { hi: hi, lo: lo };
  }

  /** Largest and smallest cell of a matrix, skipping empty cells. */
  function cellExtremes(values, skipZero) {
    var hi = null, lo = null;
    (values || []).forEach(function (row, i) {
      (row || []).forEach(function (v, j) {
        if (!isNum(v) || (skipZero && v <= 0)) return;
        if (!hi || v > hi.v) hi = { i: i, j: j, v: v };
        if (!lo || v < lo.v) lo = { i: i, j: j, v: v };
      });
    });
    return hi ? { hi: hi, lo: lo } : null;
  }

  /* ---- channels: the POS channel is what the business calls "in-store" */

  function channelInfo(id) {
    var list = (MK.config && MK.config.channels) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function isPos(col) { var c = channelInfo(col.id); return !!c && c.kind === 'pos'; }
  function isAggregator(col) { var c = channelInfo(col.id); return !!c && c.kind === 'aggregator'; }
  function chShort(col) { var c = channelInfo(col.id); return c && c.kind === 'pos' && c.short ? c.short : col.label; }
  function chLong(col) { var c = channelInfo(col.id); return c && c.kind === 'pos' && c.short ? c.short + ' (' + c.label + ')' : col.label; }
  function chInline(col) { return isPos(col) ? lowerFirst(chShort(col)) : col.label; }

  function sourceOf(result) { return (result && result.source) || 'petpooja'; }

  /* ---- comparison basis: the preceding period of equal length, as returned by MK.data.summary */

  function comparison(s) {
    var p = s && s.prev;
    if (!p || !p.from || !p.days) return { has: false, complete: false, label: '', days: 0 };
    return { has: true, complete: p.complete !== false && p.days === s.days, label: rangeLabel(p.from, p.to), days: p.days };
  }

  /** Change of an additive measure: totals when both periods are equally long, daily averages when the earlier one was clipped. */
  function growth(env, cur, prev) {
    if (!env.cmp.has || !isNum(cur) || !isNum(prev) || !prev) return null;
    var d = env.cmp.complete ? fmt.delta(cur, prev) : fmt.delta(cur / env.days, prev / env.cmp.days);
    return d && d.value !== null ? tidy(d, fmt.pct(0)) : null;
  }

  function rowGrowth(env, row, measure) {
    if (measure === 'aov') {
      if (!env.cmp.has || !row.prevOrders || !row.orders) return null;
      var d = fmt.delta(row.netSales / row.orders, row.prevNetSales / row.prevOrders);
      return d && d.value !== null ? tidy(d, fmt.pct(0)) : null;
    }
    return growth(env, row[measure], row[MEASURES[measure].prevKey]);
  }

  /** Fastest and slowest member of a breakdown against the previous period. */
  function movers(env, rows, measure) {
    var best = null, worst = null;
    (rows || []).forEach(function (r) {
      var d = rowGrowth(env, r, measure);
      if (!d) return;
      if (!best || d.value > best.delta.value) best = { row: r, delta: d };
      if (!worst || d.value < worst.delta.value) worst = { row: r, delta: d };
    });
    if (!best) return null;
    var biggest = Math.abs(worst.delta.value) > Math.abs(best.delta.value) ? worst : best;
    return { best: best, worst: worst, biggest: biggest };
  }

  /** "Strongest growth vs ..." - or, when every member is down, the one holding up best. */
  function strongestSentence(env, mv, nameOf) {
    if (!mv) return '';
    return (mv.best.delta.value >= 0 ? 'Strongest growth vs ' : 'Holding up best vs ') + env.cmp.label + ': ' + nameOf(mv.best.row) + ' (' + mv.best.delta.label + ').';
  }

  /** A change too small to show reads as a plain zero, never as "-0.0". */
  function tidy(delta, zeroLabel) {
    if (!delta || delta.dir !== 'flat' || delta.value === null) return delta;
    return { value: delta.value, label: zeroLabel, dir: 'flat' };
  }

  function moverSentence(env, rows, measure, nameOf) {
    if (!rows || rows.length < 2) return '';
    var mv = movers(env, rows, measure);
    if (!mv) return '';
    return 'Biggest mover vs ' + env.cmp.label + ': ' + nameOf(mv.biggest.row) + ' (' + mv.biggest.delta.label + ').';
  }

  /* ---- DOM bits */

  function tableFoot(children) { return h('div', { 'class': 'rs-tablefoot' }, children); }

  function note(text, iconName) {
    return h('p', { 'class': 'rs-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, text));
  }

  /**
   * The provisional caption every sales result carries (API.md section 4.5): a range that runs past Swiggy's last
   * payout annexure is provisional on the restaurant-funded share of the Swiggy discount, and therefore on net sales.
   * `null` when the range is settled, when Swiggy is out of the selection and with an empty scope.
   */
  function provisionalNote(result) {
    var p = result && result.provisional;
    if (!p || !p.swiggyDiscountSplitFrom) return null;
    return note('Swiggy discount split confirmed with the annexure: Swiggy orders from ' +
      MK.dates.label(p.swiggyDiscountSplitFrom, 'd MMM yyyy') +
      ' are as relayed to the POS, so their restaurant-funded discount and net sales are provisional.', 'info');
  }

  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[revenue-sales] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  /* ------------------------------------------------------------------ header: purpose, scope, KPI row */

  function intro(env) {
    var s = env.s, cmp = env.cmp, basis;
    if (!cmp.has) basis = 'There is no earlier period in the data to compare with.';
    else if (cmp.complete) basis = 'Changes compare with ' + cmp.label + '.';
    else {
      var dataStart = MK.config && MK.config.dataStart;
      basis = 'Changes compare daily averages with ' + cmp.label + ' (' + plural(cmp.days, 'day') +
        (dataStart ? ' - the data starts on ' + MK.dates.label(dataStart, 'd MMM yyyy') : '') + ').';
    }
    return h('p', { 'class': 'rs-intro' },
      'Where sales come from: outlet by channel, channel by outlet, the two read cell by cell, then the trend, city, medium and the two margin leaks. ',
      h('strong', { 'class': 'rs-intro__period' }, rangeLabel(s.from, s.to) + ', ' + plural(s.days, 'day') + '.'), ' ', basis);
  }

  function scopeNote(ctx) {
    var allowed = MK.session.allowedOutletIds();
    var all = MK.session.OUTLET_IDS || [];
    if (!allowed.length || allowed.length >= all.length) return null;
    var names = ((MK.config && MK.config.outlets) || []).filter(function (o) { return has(allowed, o.id); }).map(function (o) { return o.name; });
    var who = ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel : 'Your role';
    return ui.callout('info', null, who + ' sees ' + andList(names) + ' only. Every figure on this page is already limited to that scope, so the outlet comparisons show ' +
      (allowed.length === 1 ? 'one outlet' : 'those outlets') + '.', { icon: 'lock' });
  }

  function kpiBlock(env) {
    var s = env.s, p = s.prev || {}, cmp = env.cmp;
    var zeroPct = fmt.pct(0), zeroPts = fmt.num(0, 1) + ' pts';
    function total(cur, prev, curPerDay, prevPerDay) {
      if (!cmp.has) return null;
      return tidy(cmp.complete ? fmt.delta(cur, prev) : fmt.delta(curPerDay, prevPerDay), zeroPct);
    }
    function ratio(cur, prev) { return cmp.has ? tidy(fmt.delta(cur, prev), zeroPct) : null; }
    function pts(cur, prev) { return cmp.has ? tidy(fmt.points(cur, prev), zeroPts) : null; }
    var manyDays = s.days > 1;
    var discountNote = 'Restaurant-funded discounts as a share of gross sales (menu value plus packaging).';
    var partial = partialNote(env.channels.rows, FIELD_OF.discountPct);
    if (partial) discountNote += ' ' + partial;

    var tiles = [
      { label: 'Net sales', value: fmt.inr(s.netSales), delta: total(s.netSales, p.netSales, s.netSalesPerDay, p.netSalesPerDay),
        sub: manyDays ? fmt.inr(s.netSalesPerDay) + ' a day' : null, title: 'Item value plus packaging charge, less restaurant-funded discounts, net of GST.' },
      { label: 'Orders', value: fmt.num(s.orders), delta: total(s.orders, p.orders, s.ordersPerDay, p.ordersPerDay),
        sub: manyDays ? fmt.num(Math.round(s.ordersPerDay)) + ' a day' : null },
      { label: 'Avg order value', value: fmt.inrFull(s.aov), delta: ratio(s.aov, p.aov), sub: 'net sales per order' },
      { label: 'Items per order', value: fmt.num(s.itemsPerOrder, 2), delta: ratio(s.itemsPerOrder, p.itemsPerOrder),
        sub: fmt.num(s.items) + ' items sold' },
      { label: 'Discount %', value: fmt.pct(s.discountPct), delta: pts(s.discountPct, p.discountPct), goodWhen: 'down',
        sub: fmt.inr(s.restaurantDiscount) + ' restaurant-funded', title: discountNote },
      { label: 'Cancellation rate', value: fmt.pct(s.cancelRate), delta: pts(s.cancelRate, p.cancelRate), goodWhen: 'down',
        sub: fmt.num(s.cancelled) + ' orders, ' + fmt.inr(s.cancelledValue),
        title: 'Cancelled orders as a share of all orders placed. Cancelled orders add nothing to net sales.' }
    ];
    return h('div', { 'class': 'rs-kpiblock' },
      h('div', { 'class': 'rs-kpis' }, tiles.map(function (t) { return ui.statTile(t); })),
      provisionalNote(s),
      ui.sourceTag(sourceOf(s)));
  }

  /** The limitation text of a partially available field, for the channels in the list (null when every channel is a plain yes). */
  function partialNote(channelRows, fieldKey) {
    var partial = (channelRows || []).some(function (c) { return MK.data.can(c.id, fieldKey) === 'partial'; });
    if (!partial) return null;
    var cap = MK.data.capability(fieldKey);
    return cap && cap.note ? cap.note + '.' : null;
  }

  /* ------------------------------------------------------------------ A: outlets across channels */

  function takeawayA(env, measure, m) {
    var def = MEASURES[measure], n = m.rows.length, parts = [];
    if (!n) return '';
    if (n === 1) {
      if (def.additive) {
        if (!m.rowTotals[0]) return '';
        return m.rows[0].label + ': ' + m.cols.map(function (c, j) { return chInline(c) + ' ' + fmt.pct(m.values[0][j] / m.rowTotals[0]); }).join(', ') + ' of ' + def.noun + '.';
      }
      return m.rows[0].label + ': ' + m.cols.map(function (c, j) { return chInline(c) + ' ' + say(measure, m.values[0][j]); }).join(', ') + ' per order.';
    }
    var ex = extremes(m.rowTotals);
    if (!ex) return '';
    if (def.additive) {
      parts.push(m.rows[ex.hi].label + ' leads with ' + say(measure, m.rowTotals[ex.hi]) + ' (' + fmt.pct(m.total ? m.rowTotals[ex.hi] / m.total : null) + ' of ' + def.noun + '); ' +
        m.rows[ex.lo].label + ' is the smallest at ' + say(measure, m.rowTotals[ex.lo]) + '.');
    } else {
      /* the bars are per channel; the figures quoted are each outlet's ticket across the channels drawn, so say so */
      parts.push('Across the channels shown, ' + m.rows[ex.hi].label + ' has the largest ticket at ' + say(measure, m.rowTotals[ex.hi]) +
        ' and ' + m.rows[ex.lo].label + ' the smallest at ' + say(measure, m.rowTotals[ex.lo]) + '.');
    }
    parts.push(moverSentence(env, env.outlets.rows, measure, function (r) { return r.label; }));
    return parts.filter(Boolean).join(' ');
  }

  function specA(env, measure) {
    var def = MEASURES[measure];
    var m = MK.data.matrix(env.f, 'outlet', 'channel', measure);
    var order = m.rows.map(function (_, i) { return i; }).sort(function (a, b) { return (m.rowTotals[b] - m.rowTotals[a]) || (a - b); });
    var series = m.cols.map(function (c, j) {
      return { id: c.id, name: chLong(c), values: order.map(function (i) { var v = m.values[i][j]; return def.additive ? v : (v > 0 ? v : null); }) };
    });
    return {
      kind: def.additive ? 'hstackedBar' : 'hbar',
      format: def.format,
      title: 'Outlets across channels: ' + def.noun,
      subtitle: takeawayA(env, measure, m),
      data: { categories: order.map(function (i) { return m.rows[i].label; }), categoryHeader: 'Outlet', colourBy: 'channel', series: series },
      lookup: m.rows, source: sourceOf(m)
    };
  }

  function blockA(env, st) {
    var spec = specA(env, st.measure);
    var lookup = spec.lookup;
    var clickable = lookup.length > 1;
    var chart = MK.charts.mount(null, {
      id: 'rs-outlets', kind: spec.kind, format: spec.format, height: CHART_HEIGHT, title: spec.title, subtitle: spec.subtitle, data: spec.data,
      onClick: clickable ? function (datum) {
        var hit = lookup.filter(function (r) { return r.label === datum.category; })[0];
        if (hit) MK.filters.set({ outletIds: [hit.id] });
      } : null,
      note: clickable ? 'Sorted by the selected measure. Click a bar to filter the whole page to that outlet.' : null
    });
    chart.el.appendChild(ui.sourceTag(spec.source));
    return {
      el: chart.el,
      setMeasure: function (value) {
        var next = specA(env, value);
        lookup = next.lookup;
        chart.update({ kind: next.kind, format: next.format, title: next.title, subtitle: next.subtitle, data: next.data });
      }
    };
  }

  /* ------------------------------------------------------------------ B: channels across outlets */

  function takeawayB(env, measure, m) {
    var def = MEASURES[measure], n = m.cols.length, parts = [];
    if (!n) return '';
    var ex = extremes(m.colTotals);
    if (!ex) return '';
    if (def.additive) {
      if (n === 1) {
        var col = m.values.map(function (row) { return row[0]; });
        var exo = extremes(col);
        if (!exo || !m.colTotals[0]) return '';
        if (m.rows.length < 2) return chShort(m.cols[0]) + ' at ' + m.rows[0].label + ': ' + say(measure, m.colTotals[0]) + '.';
        return chShort(m.cols[0]) + ' only: ' + m.rows[exo.hi].label + ' brings ' + fmt.pct(col[exo.hi] / m.colTotals[0]) + ' of it, ' +
          m.rows[exo.lo].label + ' the least (' + fmt.pct(col[exo.lo] / m.colTotals[0]) + ').';
      }
      parts.push(chShort(m.cols[ex.hi]) + ' is the largest channel at ' + say(measure, m.colTotals[ex.hi]) + ' (' + fmt.pct(m.total ? m.colTotals[ex.hi] / m.total : null) + ' of ' + def.noun + ').');
      var agg = m.cols.filter(isAggregator), aggTotal = 0;
      m.cols.forEach(function (c, j) { if (isAggregator(c)) aggTotal += m.colTotals[j]; });
      if (agg.length > 1 && agg.length < n && m.total) {
        parts.push(andList(agg.map(function (c) { return c.label; })) + ' together bring ' + fmt.pct(aggTotal / m.total) + '.');
      }
      parts.push(moverSentence(env, env.channels.rows, measure, function (r) { return chShort(r); }));
      return parts.filter(Boolean).join(' ');
    }
    if (n === 1) return chShort(m.cols[0]) + ' orders average ' + say(measure, m.colTotals[0]) + '.';
    parts.push(upperFirst(chInline(m.cols[ex.hi])) + ' orders are the largest at ' + say(measure, m.colTotals[ex.hi]) + '; ' + chInline(m.cols[ex.lo]) + ' the smallest at ' +
      say(measure, m.colTotals[ex.lo]) + '.');
    /* the channel whose ticket differs most from outlet to outlet */
    var widest = null;
    m.cols.forEach(function (c, j) {
      var col = m.values.map(function (row) { return row[j] > 0 ? row[j] : null; });
      var e = extremes(col);
      if (!e || e.hi === e.lo) return;
      var spread = col[e.hi] - col[e.lo];
      if (!widest || spread > widest.spread) widest = { col: c, spread: spread, hi: e.hi, lo: e.lo, values: col };
    });
    if (widest) {
      parts.push('Widest spread between outlets: ' + chInline(widest.col) + ', from ' + say(measure, widest.values[widest.lo]) + ' at ' + m.rows[widest.lo].label +
        ' to ' + say(measure, widest.values[widest.hi]) + ' at ' + m.rows[widest.hi].label + '.');
    }
    return parts.join(' ');
  }

  function specB(env, measure) {
    var def = MEASURES[measure];
    var m = MK.data.matrix(env.f, 'outlet', 'channel', measure);
    var series = m.rows.map(function (r, i) {
      return { id: r.id, name: r.label, values: m.cols.map(function (c, j) { var v = m.values[i][j]; return def.additive ? v : (v > 0 ? v : null); }) };
    });
    return {
      kind: def.additive ? 'stackedBar' : 'bar',
      format: def.format,
      title: 'Channels across outlets: ' + def.noun,
      subtitle: takeawayB(env, measure, m),
      data: { categories: m.cols.map(chLong), categoryHeader: 'Channel', colourBy: 'outlet', series: series },
      lookup: m.cols, source: sourceOf(m)
    };
  }

  function blockB(env, st) {
    var spec = specB(env, st.measure);
    var lookup = spec.lookup;
    var clickable = lookup.length > 1;
    var chart = MK.charts.mount(null, {
      id: 'rs-channels', kind: spec.kind, format: spec.format, height: CHART_HEIGHT, title: spec.title, subtitle: spec.subtitle, data: spec.data,
      onClick: clickable ? function (datum) {
        var hit = lookup.filter(function (c) { return chLong(c) === datum.category; })[0];
        if (hit) MK.filters.set({ channelIds: [hit.id] });
      } : null,
      note: clickable ? 'Click a bar to filter the whole page to that channel.' : null
    });
    chart.el.appendChild(ui.sourceTag(spec.source));
    return {
      el: chart.el,
      setMeasure: function (value) {
        var next = specB(env, value);
        lookup = next.lookup;
        chart.update({ kind: next.kind, format: next.format, title: next.title, subtitle: next.subtitle, data: next.data });
      }
    };
  }

  /* ------------------------------------------------------------------ C: outlet x channel matrix */

  function takeawayC(env, measure, m) {
    var def = MEASURES[measure];
    if (!m.rows.length || !m.cols.length) return '';
    var cx = cellExtremes(m.values, true);
    if (!cx) return '';
    function cellName(c) { return m.rows[c.i].label + ' ' + chInline(m.cols[c.j]); }
    if (!def.additive) {
      return 'Tickets run from ' + say(measure, cx.lo.v) + ' (' + cellName(cx.lo) + ') to ' + say(measure, cx.hi.v) + ' (' + cellName(cx.hi) + '); the average across the selection is ' +
        say(measure, m.total) + '.';
    }
    var parts = ['Largest cell: ' + cellName(cx.hi) + ' at ' + say(measure, cx.hi.v) + ' (' + fmt.pct(m.total ? cx.hi.v / m.total : null) + ' of all ' + def.noun + ').'];
    var agg = m.cols.filter(isAggregator);
    if (agg.length && agg.length < m.cols.length) {
      var dep = m.rows.map(function (r, i) {
        var a = 0;
        m.cols.forEach(function (c, j) { if (isAggregator(c)) a += m.values[i][j]; });
        return m.rowTotals[i] ? a / m.rowTotals[i] : null;
      });
      var ex = extremes(dep);
      var via = ' of its ' + def.noun + ' through ' + andList(agg.map(function (c) { return c.label; }));
      if (ex && m.rows.length > 1) {
        parts.push('Most aggregator-dependent: ' + m.rows[ex.hi].label + ' (' + fmt.pct(dep[ex.hi]) + via + '); least: ' + m.rows[ex.lo].label + ' (' + fmt.pct(dep[ex.lo]) + ').');
      } else if (ex) {
        parts.push(m.rows[ex.hi].label + ' takes ' + fmt.pct(dep[ex.hi]) + via + '.');
      }
    }
    return parts.join(' ');
  }

  function matrixTable(env, st, m, measure, show) {
    var def = MEASURES[measure];
    var share = def.additive && show !== 'value';
    function cellValue(i, j) {
      var v = m.values[i][j];
      if (!def.additive) return v > 0 ? v : null;
      if (show === 'row') return m.rowTotals[i] ? v / m.rowTotals[i] : null;
      if (show === 'col') return m.colTotals[j] ? v / m.colTotals[j] : null;
      return v;
    }
    var rows = m.rows.map(function (r, i) {
      var row = { id: r.id, label: r.label, colourVar: r.colourVar, total: m.rowTotals[i], share: def.additive && m.total ? m.rowTotals[i] / m.total : null };
      m.cols.forEach(function (c, j) { row['c_' + c.id] = cellValue(i, j); });
      return row;
    });
    var flat = [];
    rows.forEach(function (row) { m.cols.forEach(function (c) { if (isNum(row['c_' + c.id])) flat.push(row['c_' + c.id]); }); });
    var lo = def.additive ? 0 : (flat.length ? Math.min.apply(null, flat) : 0);
    var hi = flat.length ? Math.max.apply(null, flat) : 0;
    var cellFormat = share ? 'pct' : def.format;

    var cellWidth = Math.floor(MATRIX_CELLS_PCT / Math.max(1, m.cols.length)) + '%';
    var columns = [{ key: 'label', label: 'Outlet', render: ui.cells.entity(function (row) { return row.colourVar; }) }];
    m.cols.forEach(function (c) {
      columns.push({ key: 'c_' + c.id, label: chLong(c), format: cellFormat, align: 'right', width: cellWidth, render: ui.cells.heat(lo, hi) });
    });
    if (m.cols.length > 1 || share) {
      columns.push(def.additive
        ? { key: 'total', label: 'All channels', format: def.format, render: ui.cells.bar(null, '--series-1') }
        : { key: 'total', label: 'All channels', format: def.format });
    }
    if (def.additive) columns.push({ key: 'share', label: 'Share of total', format: 'pct' });

    var footer = { label: 'All outlets', total: m.total, share: def.additive && m.total ? fmt.pct(1) : '' };
    var mix = { label: 'Channel share', total: '', share: '' };
    m.cols.forEach(function (c, j) {
      var key = 'c_' + c.id, part = m.total ? m.colTotals[j] / m.total : null;
      footer[key] = !def.additive ? m.colTotals[j] : (show === 'row' ? part : (show === 'col' ? (m.colTotals[j] ? 1 : null) : m.colTotals[j]));
      mix[key] = fmt.pct(part);
    });
    var footers = def.additive && show === 'value' && m.cols.length > 1 ? [footer, mix] : [footer];

    var clickable = m.rows.length > 1;
    return {
      columns: columns, rows: rows,
      node: ui.table({
        columns: columns, rows: rows, footer: footers, sortable: true, sort: st.cSort || null, onSort: function (sort) { st.cSort = sort; },
        caption: null, empty: 'No sales for this selection',
        onRowClick: clickable ? function (row) { MK.filters.set({ outletIds: [row.id] }); } : null
      }),
      clickable: clickable
    };
  }

  function blockC(env, st) {
    var f = env.f;
    var subtitle = h('span', null, '');
    var body = h('div', { 'class': 'rs-matrix' });
    var showSlot = h('span', { 'class': 'rs-slot' });
    var current = { columns: [], rows: [] };

    function paint() {
      var measure = st.measure, def = MEASURES[measure];
      var show = def.additive ? st.cShow : 'value';
      var m = MK.data.matrix(f, 'outlet', 'channel', measure);
      var t = matrixTable(env, st, m, measure, show);
      current = t;
      subtitle.textContent = takeawayC(env, measure, m);
      ui.clear(body);
      body.appendChild(t.node);
      var reading = !def.additive ? 'Average order value is net sales divided by orders, so it has no shares; totals are the averages of the outlet and of the channel.'
        : (show === 'row' ? 'Each row adds up to 100%: how an outlet\'s ' + def.noun + ' split by channel.'
          : (show === 'col' ? 'Each column adds up to 100%: which outlets a channel\'s ' + def.noun + ' come from.'
            : 'Darker cells carry more ' + def.noun + '; shares are of the total for the selection.'));
      body.appendChild(tableFoot([
        note(reading + (t.clickable ? ' Select a row to filter the page to that outlet.' : ''), 'info'),
        ui.sourceTag(sourceOf(m))
      ]));
    }

    function paintShow() {
      ui.clear(showSlot);
      if (!MEASURES[st.measure].additive) return;
      showSlot.appendChild(ui.segmented({ ariaLabel: 'Show cells as', size: 'sm', value: st.cShow, options: SHOW_OPTIONS,
        onChange: function (v) { st.cShow = v; paint(); } }));
    }

    var actions = [
      showSlot,
      ui.button({ label: 'CSV', icon: 'download', size: 'sm', title: 'Download this table',
        onClick: function () {
          var def = MEASURES[st.measure], view = def.additive && st.cShow !== 'value' ? (st.cShow === 'row' ? '-share-of-outlet' : '-share-of-channel') : '';
          ui.downloadCsv('sales-outlet-by-channel-' + st.measure + view + '_' + env.s.from + '_' + env.s.to + '.csv', current.columns, current.rows);
        } })
    ];
    paintShow();
    paint();
    return {
      el: ui.card({ title: 'Outlet x channel matrix', subtitle: subtitle, actions: actions, flush: true, body: body, className: 'rs-card' }),
      setMeasure: function () { paintShow(); paint(); }
    };
  }

  /* ------------------------------------------------------------------ D: trend */

  function autoGrain(days) { return days <= DAY_GRAIN_UP_TO ? 'day' : 'week'; }

  function trendMarkers(env, grain, buckets) {
    if (grain === 'month' || buckets.length < 3) return [];
    /* an event that starts on the first bucket has nothing before it to compare with, and its caption would sit on the axis */
    var firstTo = buckets[0].to;
    var events = ((MK.config && MK.config.events) || []).filter(function (e) { return e.marker && e.from > firstTo && e.from <= env.s.to; });
    if (events.length > MAX_MARKERS) {
      var keep = events.filter(function (e) { return e.kind !== 'weather'; });
      events = (keep.length ? keep : events).slice(0, MAX_MARKERS);
    }
    var byLabel = {}, out = [];
    events.forEach(function (e) {
      var bucket = buckets.filter(function (b) { return b.from <= e.from && e.from <= b.to; })[0];
      if (!bucket) return;
      var text = e.label + (MK.dates.diffDays(e.from, e.to) >= LONG_EVENT_DAYS ? ' begins' : '');
      if (byLabel[bucket.label]) { byLabel[bucket.label].label += ', ' + text; return; }
      byLabel[bucket.label] = { label: text, atLabel: bucket.label };
      out.push(byLabel[bucket.label]);
    });
    return out;
  }

  function takeawayD(env, grain, by, buckets, total, series, perDay) {
    var n = buckets.length;
    if (!n) return '';
    if (n < 2) return 'Only one ' + grain + ' in the selection - widen the date range to see a trend.';
    var each = perDay ? ' a day' : '';
    function bucketName(i) { return grain === 'day' ? MK.dates.label(buckets[i].key, 'EEE d MMM') : buckets[i].label; }
    var parts = [];

    if (!by || series.length < 2) {
      var only = by ? series[0] : null;                       /* a grouping with one member left in scope */
      var values = by ? (only ? only.values : null) : total;
      var ex = extremes(values);
      if (!ex) return '';
      parts.push((only ? only.name + ' - peak: ' : 'Peak: ') + bucketName(ex.hi) + ' at ' + fmt.inr(values[ex.hi]) + each + '; low: ' + bucketName(ex.lo) + ' at ' + fmt.inr(values[ex.lo]) + each + '.');
      if (grain === 'day' && n >= 7) {
        var we = 0, weN = 0, wd = 0, wdN = 0;
        values.forEach(function (v, i) {
          if (!isNum(v)) return;
          if (WEEKEND_DOWS[MK.dates.dow(buckets[i].key)]) { we += v; weN++; } else { wd += v; wdN++; }
        });
        if (weN && wdN && wd) {
          var lift = fmt.delta(we / weN, wd / wdN);
          parts.push('Friday to Sunday averages ' + fmt.inr(we / weN) + ' a day, ' + lift.label + ' against Monday to Thursday.');
        }
      }
      return parts.join(' ');
    }

    var wins = series.map(function () { return 0; });
    for (var i = 0; i < n; i++) {
      var top = -1;
      for (var k = 0; k < series.length; k++) {
        var v = series[k].values[i];
        if (isNum(v) && (top === -1 || v > series[top].values[i])) top = k;
      }
      if (top !== -1) wins[top]++;
    }
    var lead = extremes(wins);
    if (lead) {
      parts.push(series[lead.hi].name + (wins[lead.hi] === n ? ' is on top in all ' + plural(n, grain) + '.'
        : ' is on top in ' + fmt.num(wins[lead.hi]) + ' of ' + plural(n, grain) + '.'));
    }
    var rows = MK.data.breakdown(env.f, by).rows;
    var mv = movers(env, rows, 'netSales');
    if (mv && rows.length > 1) {
      var nameOf = function (r) { return by === 'channel' ? chInline(r) : r.label; };
      var up = nameOf(mv.best.row) + ' (' + mv.best.delta.label + ')', down = nameOf(mv.worst.row) + ' (' + mv.worst.delta.label + ')';
      parts.push(mv.best.delta.value < 0
        ? 'Against ' + env.cmp.label + ' every ' + BY_WORDS[by] + ' is down: ' + up + ' holds up best, ' + down + ' falls furthest.'
        : 'Against ' + env.cmp.label + ', ' + up + ' grows fastest and ' + down + (mv.worst.delta.value < 0 ? ' falls.' : ' slowest.'));
    }
    return parts.join(' ');
  }

  function specD(env, st) {
    var grain = st.grain || autoGrain(env.days);
    var by = st.by === 'total' ? null : st.by;
    var res = MK.data.series(env.f, { measure: 'netSales', grain: grain, by: by });
    var all = res.buckets || [];
    var perDay = grain !== 'day';
    var allSpans = all.map(function (b) { return MK.dates.diffDays(b.from, b.to) + 1; });
    /* week view: a part-week at either edge has a different weekday mix, so it is left out when enough full weeks remain */
    var keep = all.map(function (_, i) { return i; });
    var dropped = [];
    if (grain === 'week') {
      var full = keep.filter(function (i) { return allSpans[i] >= DAYS_IN_WEEK; });
      if (full.length >= MIN_FULL_WEEKS) {
        dropped = keep.filter(function (i) { return allSpans[i] < DAYS_IN_WEEK && (i === 0 || i === all.length - 1); });
        keep = keep.filter(function (i) { return dropped.indexOf(i) === -1; });
      }
    }
    var buckets = keep.map(function (i) { return all[i]; });
    var spans = keep.map(function (i) { return allSpans[i]; });
    function norm(values) {
      return keep.map(function (src, i) {
        var v = values ? values[src] : null;
        return isNum(v) ? (perDay ? Math.round(v / (spans[i] || 1)) : v) : null;
      });
    }
    var regions = ((MK.config && MK.config.regions) || []).map(function (r) { return r.id; });
    var total = norm(res.total);
    var series = (res.series || []).map(function (sr) {
      var out = { id: sr.id, name: by === 'channel' ? chLong(sr) : sr.label, values: norm(sr.values) };
      if (by === 'city') out.colourVar = MK.charts.colourFor('series', Math.max(0, regions.indexOf(sr.id)));
      return out;
    });
    var measureName = perDay ? 'Net sales per day' : 'Net sales';
    var data = { labels: buckets.map(function (b) { return b.label; }), labelHeader: upperFirst(grain), markers: trendMarkers(env, grain, buckets) };
    if (by) {
      data.series = series;
      data.showTotal = true;
      if (by !== 'city') data.colourBy = by;
    } else {
      data.values = total;
      data.name = measureName;
    }
    var partial = spans.some(function (d, i) { return perDay && d < (grain === 'week' ? DAYS_IN_WEEK : MK.dates.daysInMonth(buckets[i].key)); });
    var noteText = null;
    if (perDay) {
      noteText = 'Week and month views plot the average per trading day' + (partial ? ', so a part-period compares fairly with a full one.' : '.');
      if (dropped.length) {
        noteText += ' Part-weeks at the edge of the range (' + andList(dropped.map(function (i) { return all[i].label; })) + ') are left out so that every point is a full week.';
      }
    }
    return {
      kind: by ? 'line' : 'area',
      title: grain === 'day' ? 'Daily net sales' + (by ? ' by ' + BY_WORDS[by] : '')
        : 'Net sales per day, ' + grain + ' by ' + grain + (by ? ', by ' + BY_WORDS[by] : ''),
      subtitle: takeawayD(env, grain, by, buckets, total, series, perDay),
      data: data,
      note: noteText,
      grain: grain, source: sourceOf(res)
    };
  }

  function blockD(env, st) {
    var spec = specD(env, st);
    function chartSpec(sp) { return { kind: sp.kind, title: sp.title, subtitle: sp.subtitle, data: sp.data, note: sp.note }; }
    var first = chartSpec(spec);
    first.id = 'rs-trend';
    first.format = 'inr';
    first.height = CHART_HEIGHT + 20;
    first.controls = [
      { id: 'grain', label: 'Grain', value: spec.grain, options: GRAIN_OPTIONS },
      { id: 'by', label: 'Group by', value: st.by, options: BY_OPTIONS }
    ];
    first.onControl = function (id, value) {
      if (id === 'grain') st.grain = value; else st.by = value;
      chart.update(chartSpec(specD(env, st)));
    };
    var chart = MK.charts.mount(null, first);
    chart.el.appendChild(ui.sourceTag(spec.source));
    return chart.el;
  }

  /* ------------------------------------------------------------------ E: city and medium */

  function mixColumns(env, nameColumn, extra) {
    var cols = [
      nameColumn,
      { key: 'netSales', label: 'Net sales', format: 'inr', render: ui.cells.bar(null, '--series-1') },
      { key: 'share', label: 'Share', format: 'pct' },
      { key: 'orders', label: 'Orders', format: 'num' },
      { key: 'aov', label: 'AOV', format: 'inrFull' }
    ].concat(extra || []).concat([
      { key: 'discountPct', label: 'Discount %', format: 'pct', title: 'Restaurant-funded discounts as a share of gross sales' },
      { key: 'cancelRate', label: 'Cancelled', format: 'pct', title: 'Cancelled orders as a share of all orders placed' }
    ]);
    if (env.cmp.has) cols.push({ key: 'change', label: 'vs previous', align: 'right', render: ui.cells.delta('up'), title: 'Net sales against ' + env.cmp.label });
    return cols;
  }

  function mixFooter(env, total, label, extra) {
    var foot = { label: label, netSales: total.netSales, share: total.netSales ? fmt.pct(1) : '', orders: total.orders, aov: total.aov,
      discountPct: total.discountPct, cancelRate: total.cancelRate };
    var d = growth(env, env.s.netSales, env.s.prev ? env.s.prev.netSales : null);
    foot.change = d ? ui.deltaBadge(d, 'up') : '';
    Object.keys(extra || {}).forEach(function (k) { foot[k] = extra[k]; });
    return foot;
  }

  function cityBlock(env, st) {
    var res = MK.data.breakdown(env.f, 'city');
    var inScope = env.outlets.rows;
    var regions = (MK.config && MK.config.regions) || [];
    var rows = res.rows.map(function (r) {
      var region = regions.filter(function (g) { return g.id === r.id; })[0];
      var members = inScope.filter(function (o) { return region && has(region.outletIds, o.id); });
      var row = { id: r.id, label: r.label, outlets: members.map(function (o) { return o.label; }).join(', '), outletCount: members.length,
        netSales: r.netSales, share: r.share, orders: r.orders, aov: r.aov, discountPct: r.discountPct, cancelRate: r.cancelRate,
        perOutletDay: members.length ? r.netSales / members.length / env.days : null,
        change: growth(env, r.netSales, r.prevNetSales) };
      return row;
    });

    var subtitle = '';
    var ranked = rows.filter(function (r) { return isNum(r.perOutletDay); }).sort(function (a, b) { return b.perOutletDay - a.perOutletDay; });
    if (rows.length > 1 && ranked.length > 1) {
      var small = rows.slice().sort(function (a, b) { return a.netSales - b.netSales; })[0];
      var topR = ranked[0], lastR = ranked[ranked.length - 1];
      subtitle = small.label + ' brings ' + fmt.pct(small.share) + ' of net sales from ' + plural(small.outletCount, 'outlet') + '. Per outlet per day, ' +
        topR.label + ' runs at ' + fmt.inr(topR.perOutletDay) + ' against ' + fmt.inr(lastR.perOutletDay) + ' in ' + lastR.label + '.';
      var mv = movers(env, res.rows, 'netSales');
      if (mv) subtitle += ' ' + strongestSentence(env, mv, function (r) { return r.label; });
    } else if (rows.length === 1) {
      subtitle = rows[0].label + ' only: ' + plural(rows[0].outletCount, 'outlet') + ' in the selection, ' + fmt.inr(rows[0].perOutletDay) + ' per outlet per day.';
    }

    var columns = mixColumns(env, { key: 'label', label: 'City', render: ui.cells.twoLine('outlets', { maxWidth: 200 }) },
      [{ key: 'perOutletDay', label: 'Per outlet per day', format: 'inr', title: 'Net sales divided by the outlets in the selection and by the days in the range' }]);
    var outletCount = inScope.length;
    var table = ui.table({
      columns: columns, rows: rows, dense: false, sortable: true, sort: st.citySort || null, onSort: function (sort) { st.citySort = sort; },
      footer: mixFooter(env, res.total, 'All cities', { perOutletDay: outletCount ? res.total.netSales / outletCount / env.days : null }),
      empty: 'No sales for this selection'
    });
    return ui.card({ title: 'City comparison', subtitle: subtitle, flush: true, className: 'rs-card',
      body: [table, tableFoot([ui.sourceTag(sourceOf(res))])] });
  }

  function mediumBlock(env, st) {
    var res = MK.data.breakdown(env.f, 'medium');
    var rows = res.rows.map(function (r) {
      return { id: r.id, label: r.label, colourVar: r.colourVar, netSales: r.netSales, share: r.share, orders: r.orders, aov: r.aov,
        itemsPerOrder: r.itemsPerOrder, discountPct: r.discountPct, cancelRate: r.cancelRate, change: growth(env, r.netSales, r.prevNetSales) };
    });

    var subtitle = '';
    if (rows.length > 1) {
      var bySales = extremes(rows.map(function (r) { return r.netSales; }));
      var byAov = extremes(rows.map(function (r) { return r.orders ? r.aov : null; }));
      subtitle = rows[bySales.hi].label + ' brings ' + fmt.pct(rows[bySales.hi].share) + ' of net sales';
      if (byAov && byAov.hi !== byAov.lo && rows[byAov.lo].aov) {
        var ticket = 'the largest ticket at ' + fmt.inrFull(rows[byAov.hi].aov) + ', ' + fmt.num(rows[byAov.hi].aov / rows[byAov.lo].aov, 1) +
          ' times ' + lowerFirst(rows[byAov.lo].label) + ' (' + fmt.inrFull(rows[byAov.lo].aov) + ').';
        /* do not name the same medium twice in a row */
        subtitle += byAov.hi === bySales.hi ? ' and carries ' + ticket : '. ' + rows[byAov.hi].label + ' has ' + ticket;
      } else {
        subtitle += '.';
      }
      var mv = movers(env, res.rows, 'netSales');
      if (mv) subtitle += ' ' + strongestSentence(env, mv, function (r) { return r.label; });
    } else if (rows.length === 1) {
      subtitle = rows[0].label + ' only: ' + fmt.num(rows[0].orders) + ' orders at ' + fmt.inrFull(rows[0].aov) + ' each.';
    }

    var columns = mixColumns(env, { key: 'label', label: 'Medium', render: ui.cells.entity(function (row) { return row.colourVar; }) },
      [{ key: 'itemsPerOrder', label: 'Items per order', align: 'right', format: function (v) { return fmt.num(v, 2); } }]);
    var table = ui.table({
      columns: columns, rows: rows, sortable: true, sort: st.mediumSort || null, onSort: function (sort) { st.mediumSort = sort; },
      footer: mixFooter(env, res.total, 'All mediums', { itemsPerOrder: res.total.itemsPerOrder }),
      empty: 'No sales for this selection'
    });
    return ui.card({ title: 'Medium mix', subtitle: subtitle, flush: true, className: 'rs-card',
      body: [table, tableFoot([ui.sourceTag(sourceOf(res))])] });
  }

  /* ------------------------------------------------------------------ F: discounts and cancellations by outlet and channel */

  function leakTakeaway(env, measure, m, cells) {
    if (!m.rows.length) return '';
    var parts = [], cx = cellExtremes(cells, false);
    var ex = extremes(m.rowTotals);
    if (m.rows.length > 1 && ex) {
      parts.push(measure === 'discountPct'
        ? m.rows[ex.hi].label + ' gives away the most (' + fmt.pct(m.rowTotals[ex.hi]) + ' of gross sales); ' + m.rows[ex.lo].label + ' the least (' + fmt.pct(m.rowTotals[ex.lo]) + ').'
        : m.rows[ex.hi].label + ' loses the most orders to cancellation (' + fmt.pct(m.rowTotals[ex.hi]) + '); ' + m.rows[ex.lo].label + ' the fewest (' + fmt.pct(m.rowTotals[ex.lo]) + ').');
    }
    if (measure === 'discountPct') {
      var agg = { d: 0, g: 0, names: [] }, pos = { d: 0, g: 0 };
      env.channels.rows.forEach(function (c) {
        var bucket = isAggregator(c) ? agg : (isPos(c) ? pos : null);
        if (!bucket) return;
        bucket.d += c.restaurantDiscount; bucket.g += c.grossSales;
        if (bucket === agg) agg.names.push(c.label);
      });
      if (agg.g && pos.g) parts.push(andList(agg.names) + ' orders carry ' + fmt.pct(agg.d / agg.g) + ' against ' + fmt.pct(pos.d / pos.g) + ' in-store.');
      else if (cx && m.cols.length > 1) parts.push('Highest: ' + chInline(m.cols[cx.hi.j]) + ' at ' + m.rows[cx.hi.i].label + ', ' + fmt.pct(cx.hi.v) + '.');
    } else if (cx && (m.cols.length > 1 || m.rows.length > 1)) {
      parts.push('Hot spot: ' + chInline(m.cols[cx.hi.j]) + ' at ' + m.rows[cx.hi.i].label + ', ' + fmt.pct(cx.hi.v) + '.');
    }
    return parts.join(' ');
  }

  function leakBlock(env, st, measure, title, definition) {
    var m = MK.data.matrix(env.f, 'outlet', 'channel', measure);
    var orders = MK.data.matrix(env.f, 'outlet', 'channel', 'orders');
    var field = FIELD_OF[measure];
    var provided = m.cols.map(function (c) { return MK.data.can(c.id, field) !== 'no'; });
    /* a cell with no orders and no cancellations has no rate at all */
    var cells = m.values.map(function (row, i) {
      return row.map(function (v, j) {
        var placed = orders.values[i] ? orders.values[i][j] : 0;
        return provided[j] && (placed > 0 || v > 0) ? v : null;
      });
    });
    var flat = [];
    cells.forEach(function (row) { row.forEach(function (v) { if (isNum(v)) flat.push(v); }); });
    m.rowTotals.forEach(function (v) { if (isNum(v)) flat.push(v); });
    var lo = flat.length ? Math.min.apply(null, flat) : 0, hi = flat.length ? Math.max.apply(null, flat) : 0;

    var rows = m.rows.map(function (r, i) {
      var row = { id: r.id, label: r.label, colourVar: r.colourVar, all: m.rowTotals[i] };
      m.cols.forEach(function (c, j) { row['c_' + c.id] = cells[i][j]; });
      return row;
    });
    var columns = [{ key: 'label', label: 'Outlet', render: ui.cells.entity(function (row) { return row.colourVar; }) }];
    m.cols.forEach(function (c, j) {
      columns.push(provided[j]
        ? { key: 'c_' + c.id, label: chShort(c), title: chLong(c), format: 'pct', align: 'right', render: ui.cells.heat(lo, hi) }
        : { key: 'c_' + c.id, label: chShort(c), title: chLong(c), sortable: false, render: function () { return ui.notProvided(chShort(c)); } });
    });
    var allProvided = provided.every(Boolean);
    if (m.cols.length > 1 && allProvided) columns.push({ key: 'all', label: 'All channels', format: 'pct', align: 'right', render: ui.cells.heat(lo, hi) });

    var footer = { label: 'All outlets', all: m.total };
    m.cols.forEach(function (c, j) { footer['c_' + c.id] = provided[j] ? m.colTotals[j] : ''; });

    var sortKey = measure + 'Sort';
    var foot = [note(definition, 'info')];
    var partial = partialNote(m.cols, field);
    if (partial) foot.push(note(partial, 'alert-triangle'));
    if (measure === 'discountPct') {
      var prov = provisionalNote(m);
      if (prov) foot.push(prov);
    }
    foot.push(ui.sourceTag(sourceOf(m)));

    return ui.card({
      title: title, subtitle: leakTakeaway(env, measure, m, cells), flush: true, className: 'rs-card',
      body: [
        ui.table({ columns: columns, rows: rows, footer: footer, sortable: true, sort: st[sortKey] || null, onSort: function (sort) { st[sortKey] = sort; },
          empty: 'No sales for this selection' }),
        tableFoot(foot)
      ]
    });
  }

  /* ------------------------------------------------------------------ empty scope */

  function emptyView(ctx) {
    if (!MK.session.allowedOutletIds().length) {
      var who = ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel : 'This role';
      return ui.card({ body: ui.emptyState('No outlet sales in your scope',
        who + ' has no customer-facing outlet in scope, and the factory has no sales of its own. Switch to a role that covers an outlet to explore sales.', { icon: 'store' }) });
    }
    var f = ctx.filters || {};
    var clash = f.channelIds && f.channelIds.length && f.mediumIds && f.mediumIds.length;
    return ui.card({ body: ui.emptyState('No sales for this selection',
      clash ? 'The channel and medium filters do not overlap: dine-in and takeaway are sold in-store, delivery runs through the aggregators. Reset the filters to see sales again.'
        : 'No orders were recorded for these filters. Widen the date range or reset the filters.',
      { icon: 'filter', action: ui.button({ label: 'Reset filters', icon: 'refresh', onClick: function () { MK.filters.reset(); } }) }) });
  }

  /* ------------------------------------------------------------------ page */

  function render(rootEl, ctx) {
    var st = ctx.state, f = ctx.filters;
    if (!MEASURES[st.measure]) st.measure = 'netSales';
    if (!SHOW_OPTIONS.some(function (o) { return o.value === st.cShow; })) st.cShow = 'value';
    if (!BY_OPTIONS.some(function (o) { return o.value === st.by; })) st.by = 'total';
    if (!GRAIN_OPTIONS.some(function (o) { return o.value === st.grain; })) st.grain = null; /* null = pick by the length of the range */

    var s = MK.data.summary(f);
    if (!s || (!s.orders && !s.cancelled)) { rootEl.appendChild(emptyView(ctx)); return; }

    var env = { f: f, s: s, days: s.days || 1, cmp: comparison(s), outlets: MK.data.breakdown(f, 'outlet'), channels: MK.data.breakdown(f, 'channel') };

    rootEl.appendChild(intro(env));
    var scope = scopeNote(ctx);
    if (scope) rootEl.appendChild(scope);
    safe(rootEl, 'The KPI row', function () { return kpiBlock(env); });

    /* one measure switch drives the three outlet-and-channel blocks, so they always answer the same question */
    var blocks = [];
    function block(parent, name, build) {
      safe(parent, name, function () { var b = build(env, st); blocks.push(b); return b.el; });
    }
    rootEl.appendChild(ui.sectionTitle('Outlets and channels', 'The same sales read both ways, then cell by cell', [
      h('span', { 'class': 'mk-small mk-muted' }, 'Measure'),
      ui.segmented({ ariaLabel: 'Measure for the outlet and channel blocks', value: st.measure, options: MEASURE_OPTIONS,
        onChange: function (value) {
          st.measure = value;
          blocks.forEach(function (b) {
            try { b.setMeasure(value); } catch (e) { if (root.console) root.console.error('[revenue-sales] measure switch', e); }
          });
        } })
    ]));
    var pair = h('div', { 'class': 'mk-grid mk-grid--2 rs-pair' });
    block(pair, 'Outlets across channels', blockA);
    block(pair, 'Channels across outlets', blockB);
    rootEl.appendChild(pair);
    block(rootEl, 'The outlet x channel matrix', blockC);

    rootEl.appendChild(ui.sectionTitle('Trend', 'Group the line by outlet, city, channel or medium'));
    safe(rootEl, 'The trend', function () { return blockD(env, st); });

    rootEl.appendChild(ui.sectionTitle('City and medium', 'Mumbai region against Pune; dine-in, takeaway and delivery'));
    safe(rootEl, 'The city comparison', function () { return cityBlock(env, st); });
    safe(rootEl, 'The medium mix', function () { return mediumBlock(env, st); });

    rootEl.appendChild(ui.sectionTitle('Margin leaks before any cost', 'Discounts the restaurant funds and orders that never complete, by outlet and channel'));
    var leaks = h('div', { 'class': 'mk-grid mk-grid--2 rs-leaks' });
    safe(leaks, 'Discounts by outlet and channel', function () {
      return leakBlock(env, st, 'discountPct', 'Restaurant-funded discount %', 'Restaurant-funded discounts as a share of gross sales (menu value plus packaging). Darker is more given away.');
    });
    safe(leaks, 'Cancellations by outlet and channel', function () {
      return leakBlock(env, st, 'cancelRate', 'Cancellation rate', 'Cancelled orders as a share of all orders placed; they add nothing to net sales. Darker is more lost.');
    });
    rootEl.appendChild(leaks);
  }

  MK.router.register({
    id: 'revenue-sales',
    route: '#/revenue/sales',
    group: 'Revenue',
    title: 'Sales explorer',
    subtitle: 'Outlet-wise, channel-wise, city and medium',
    units: 'outlets',
    roles: null,
    filters: ['date', 'outlet', 'channel', 'medium'],
    render: render
  });
})(window);
