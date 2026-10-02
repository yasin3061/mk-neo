/*
 * #/revenue/orders - Recent orders (the last 14 business days kept order by order).
 *
 * The screen where data feasibility is most visible: every row and every line of the detail drawer is gated by the
 * capability matrix (MK.data.can / MK.data.capability), so a field a channel does not share is never shown as data.
 *
 *   intro        what the list is, for which business days
 *   KPI row      orders, net sales, AOV, cancellations, share of aggregator orders whose fees are actual
 *   visuals      completed orders per business day by channel (click a day to list it) + where fee data stands
 *   orders       status tabs, channel quick filter, search, paging, CSV; row click opens the order drawer
 *   drawer       items, amounts (GST worded per treatment), fee block (actual | estimated), status timeline with the
 *                derived preparation time, payment, customer - each driven by the capability matrix
 *
 * Page-local state (ctx.state): status, channel, search, page, pageSize, day, openId, opened (deep link).
 * The quick filters, the search and the pager repaint the orders card only; the router re-runs render() for the
 * global filters, the persona and the store. Every figure comes from MK.data.* / MK.config and is formatted by MK.fmt.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;
  var doc = root.document;

  /* ------------------------------------------------------------------ vocabulary (layout constants, never data) */

  var PAGE_ID = 'revenue-orders';
  var PAGE_CLASS = 'pg-revenue-orders';
  var ALL = 'all';
  var PAGE_SIZES = [25, 50, 100];
  var CHART_HEIGHT = 292;          /* px */
  var DRAWER_WIDTH = 560;          /* px */

  var STATUS_TABS = [
    { id: ALL, label: 'All orders' },
    { id: 'completed', label: 'Completed' },
    { id: 'cancelled', label: 'Cancelled' }
  ];
  var STATUS_LOOK = {
    completed: { label: 'Completed', tone: 'good', icon: 'check-circle' },
    cancelled: { label: 'Cancelled', tone: 'critical', icon: 'x-circle' }
  };

  /* status events of an aggregator order as the POS records them; `cap` is the capability key that governs the step */
  var STEPS = [
    { prop: 'placedAt', label: 'Placed', cap: 'order.timestamp' },
    { prop: 'acceptedAt', label: 'Accepted by the outlet', cap: 'order.status' },
    { prop: 'foodReadyAt', label: 'Food ready', cap: 'order.status', missing: 'Staff did not mark this order ready, so no preparation time can be derived' },
    { prop: 'pickedUpAt', label: 'Picked up by the rider', cap: 'order.status' },
    { prop: 'deliveredAt', label: 'Delivered', cap: 'order.deliveredTime', missing: 'The delivered event was not relayed for this order' }
  ];

  var CUSTOMER_FIELDS = [
    { cap: 'order.customerName', prop: 'customerName' },
    { cap: 'order.customerPhone', prop: 'customerPhone' },
    { cap: 'order.customerAddress', prop: 'customerAddress' }
  ];

  var FEE_BASE_LABEL = { net_plus_gst: 'net bill value plus GST', net: 'net bill value' };
  var PAYMENT_FLAG_LABEL = { prepaid: 'Prepaid online', cod: 'Cash on delivery' };

  /* the one open drawer of this page: { ctrl, order, env, prevBtn, nextBtn, pos } */
  var live = null;

  /* ------------------------------------------------------------------ small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function plural(n, word, many) { return fmt.num(n) + ' ' + (n === 1 ? word : (many || word + 's')); }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''; }
  /* a contract rate: one decimal, two when the rate needs them (1.84%) */
  function rate(x) { return fmt.pct(x, Math.abs(x * 1000 - Math.round(x * 1000)) > 1e-6 ? 2 : 1); }

  function guard(name, fn, fallback) {
    try { return fn(); } catch (e) {
      if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e);
      return fallback;
    }
  }

  /* one block failing (the data layer is tuned in parallel) must not take the screen down */
  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  /* ---- master data */

  function cfg() { return MK.config || {}; }
  function byId(list, id) { for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i]; return null; }
  function channelInfo(id) { return byId(cfg().channels, id) || { id: id, label: String(id || ''), short: String(id || ''), kind: 'pos', colourVar: null }; }
  function outletInfo(id) { return byId(cfg().outlets, id); }
  /* an outlet name column carries the full name, as on every other screen (the short form is for tabs and unit chips) */
  function outletName(id) { var o = outletInfo(id); return o ? o.name : String(id || ''); }
  function mediumName(id) { var m = byId(cfg().mediums, id); return m ? m.label : String(id || ''); }
  function slotInfo(id) { return byId(cfg().slots, id); }
  function categoryName(id) { var c = byId(cfg().categories, id); return c ? c.label : ''; }
  function termsOf(channelId) { return (cfg().channelTerms || {})[channelId] || {}; }
  function sourceInfo(id) { return (cfg().sources || {})[id] || null; }
  function sourceLabel(id) { var s = sourceInfo(id); return s ? s.label : String(id || ''); }
  function isAggregator(ch) { return !!ch && ch.kind === 'aggregator'; }

  /* ---- capability matrix (DATA-FEASIBILITY.md section 3) - the only authority on what may be shown per channel */

  function can(channelId, key) { return guard('can ' + key, function () { return MK.data.can(channelId, key); }, 'no'); }
  function capability(key) { return guard('capability ' + key, function () { return MK.data.capability(key); }, null); }
  function rawCap(channelId, key) { var c = capability(key); return c ? c[channelId] : null; }
  function capLabel(key, fallback) { var c = capability(key); return (c && c.label) || fallback || key; }
  function capNote(key) { var c = capability(key); return (c && c.note) || ''; }
  function notApplicable(channelId, key) { return rawCap(channelId, key) === 'n/a'; }

  /* value of a channel field: null when the concept does not apply, "Not provided by ..." when the channel withholds it */
  function gated(order, key, build) {
    if (notApplicable(order.channelId, key)) return null;
    var level = can(order.channelId, key);
    if (level === 'no') return ui.notProvided(channelInfo(order.channelId).label);
    return build(level);
  }

  /* ---- dates and times */

  function clock(at) { return typeof at === 'string' && at.length >= 16 ? at.slice(11, 16) : ''; }
  function calendarDate(at) { return typeof at === 'string' && at.length >= 10 ? at.slice(0, 10) : null; }
  function day(iso, style) { return iso ? MK.dates.label(iso, style || 'd MMM yyyy') : '-'; }
  function rangeLabel(from, to) {
    if (!from || !to) return '';
    if (from === to) return day(from);
    return day(from, from.slice(0, 4) === to.slice(0, 4) ? 'd MMM' : 'd MMM yyyy') + ' - ' + day(to);
  }
  function longDay(iso) { return iso ? MK.dates.label(iso, 'EEE d MMM') + ' ' + iso.slice(0, 4) : '-'; }
  /* "12 pm to 4 am", read from the first and the last trading slot of the configuration */
  function businessDayHours() {
    var slots = cfg().slots || [];
    if (!slots.length) return '';
    var open = String(slots[0].range || '').split(' - ')[0], close = String(slots[slots.length - 1].range || '').split(' - ')[1];
    return open && close ? open + ' to ' + close : '';
  }
  function afterMidnight(order) { var c = calendarDate(order.placedAt); return !!c && c !== order.businessDate; }

  /* ---- DOM bits */

  /* source tag without the kit's top margin, for places where the page owns the spacing */
  function sourceFlat(ids, wrap) {
    var tag = ui.sourceTag(ids);
    tag.classList.add('ro-source-flat');
    if (wrap) tag.classList.add('ro-source-wrap');     /* narrow card: the kit's one-line captions may wrap */
    return tag;
  }
  function dot(colourVar, lead) {
    return h('span', { 'class': ['ro-dot', lead ? 'ro-dot--lead' : ''], 'aria-hidden': 'true', style: colourVar ? { background: 'var(' + colourVar + ')' } : null });
  }

  /* keeping the keyboard where it was across a repaint of a block this page rebuilds itself */
  var FOCUSABLE = 'button, select, input, a[href], [tabindex]';
  function focusSpot(host) {
    var list = host.querySelectorAll(FOCUSABLE);
    for (var i = 0; i < list.length; i++) if (list[i] === doc.activeElement) return i;
    return -1;
  }
  function restoreFocus(host, spot) {
    if (spot < 0) return;
    var list = host.querySelectorAll(FOCUSABLE);
    if (!list.length) return;
    var order = [Math.min(spot, list.length - 1)];
    for (var d = 1; d < list.length; d++) { order.push(spot + d); order.push(spot - d); }
    for (var i = 0; i < order.length; i++) {
      var el = list[order[i]];
      if (el && !el.disabled) { el.focus(); return; }
    }
  }

  function dash(title) { return h('span', { 'class': 'mk-faint', title: title || null }, '-'); }
  function mono(text) { return h('span', { 'class': 'ro-mono' }, text); }
  function note(content, iconName) { return h('p', { 'class': 'ro-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, content)); }
  function channelChip(ch, useShort) { return ui.chip(useShort ? (ch.short || ch.label) : ch.label, null, { dotVar: ch.colourVar || null, title: ch.label }); }

  function statusChip(status) {
    var look = STATUS_LOOK[status];
    return look ? ui.chip(look.label, look.tone, { icon: look.icon }) : ui.statusChip(status);
  }

  function actualChip(order) {
    return ui.chip('Actual', 'neutral', { icon: 'check', title: 'From the ' + sourceLabel(order.feesSource) });
  }
  /* the same statement in the weight a dense table can carry: the estimate keeps its badge, the settled figure a quiet word */
  function actualMark(order) {
    return h('span', { 'class': 'ro-fee__mark mk-xs mk-muted', title: 'From the ' + sourceLabel(order.feesSource) }, 'Actual');
  }

  function section(title, body, extra) {
    return h('section', { 'class': 'ro-sec' },
      h('div', { 'class': 'ro-sec__head' }, h('h4', { 'class': 'mk-h3 ro-sec__title' }, title), extra || null),
      body);
  }

  /* label / amount lines: [{label, sub, amount, kind: 'plain' | 'minus' | 'total' | 'memo', negate, tag}] */
  function ledger(lines) {
    return h('table', { 'class': 'ro-ledger' }, h('tbody', null, lines.filter(Boolean).map(function (ln) {
      var negative = (ln.kind === 'minus' || ln.negate) && ln.amount !== 0;
      var amount = isNum(ln.amount) ? fmt.inrFull(negative ? -Math.abs(ln.amount) : ln.amount) : (ln.amount || dash());
      return h('tr', { 'class': 'ro-ledger__row ro-ledger__row--' + (ln.kind || 'plain') },
        h('th', { scope: 'row' }, h('span', { 'class': 'ro-ledger__label' }, ln.label), ln.sub ? h('span', { 'class': 'ro-ledger__sub' }, ln.sub) : null),
        h('td', null, amount, ln.tag ? h('span', { 'class': 'ro-ledger__tag' }, ln.tag) : null));
    })));
  }

  /* ---- data access (guarded: a selector that throws leaves an empty, documented shape) */

  function recent(f, opts) {
    var res = guard('recentOrders', function () { return MK.data.recentOrders(f, opts); }, null);
    return res && Array.isArray(res.rows) ? res : { from: null, to: null, windowFrom: null, windowTo: null, total: 0, limit: (opts && opts.limit) || 0, offset: 0, rows: [] };
  }

  /* an order by id, anywhere the persona may look (null filter = the whole scope) */
  function findOrder(id) {
    if (!id) return null;
    var rows = recent(null, { search: String(id), limit: 50 }).rows;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }

  /* ================================================================== intro */

  function intro(env) {
    var days = MK.dates.diffDays(env.win.from, env.win.to) + 1;
    return h('p', { 'class': 'ro-intro' },
      'Every order the POS recorded in the last ' + plural(days, 'business day') + ', ',
      h('span', { 'class': 'ro-intro__period' }, rangeLabel(env.win.from, env.win.to)),
      '. A row and its detail show only what the order\'s channel actually shares; aggregator fees are actual once the weekly statement is uploaded and an estimate until then.');
  }

  /* ================================================================== KPI row */

  function tileLine(lead, text) {
    return h('span', { 'class': 'ro-tileline' }, lead ? h('span', { 'class': 'ro-tileline__lead' }, lead) : null, h('span', null, text));
  }

  function kpiBlock(env, onCancelled) {
    var s = env.summary, ce = env.ce;
    var prev = s.prev && s.prev.from ? s.prev : null;
    var versus = prev ? 'vs prior ' + plural(prev.days, 'day') : null;
    function delta(key) { return prev ? fmt.delta(s[key], prev[key]) : null; }

    var actual = ce ? ce.total.actual.orders : 0, estimated = ce ? ce.total.estimated.orders : 0, aggOrders = actual + estimated;
    var tiles = [
      ui.statTile({ label: 'Completed orders', icon: 'receipt', value: fmt.num(s.orders), delta: delta('orders'), deltaNote: versus,
        sub: isNum(s.ordersPerDay) && s.orders ? fmt.num(s.ordersPerDay) + ' a day' : null }),
      ui.statTile({ label: 'Net sales', icon: 'coins', value: fmt.inr(s.netSales), delta: delta('netSales'), deltaNote: versus, sub: 'Net of GST and discounts' }),
      ui.statTile({ label: 'Average order value', icon: 'calculator', value: s.orders ? fmt.inrFull(Math.round(s.aov)) : '-', delta: s.orders ? delta('aov') : null, deltaNote: versus,
        sub: s.orders ? fmt.num(s.itemsPerOrder, 1) + ' items an order' : null }),
      ui.statTile({ label: 'Cancelled orders', icon: 'x-circle', value: fmt.num(s.cancelled), delta: delta('cancelled'), goodWhen: 'down', deltaNote: versus,
        title: s.cancelled ? 'Show the cancelled orders in the list' : null,
        sub: s.cancelled ? fmt.pct(s.cancelRate) + ' of orders placed, ' + fmt.inr(s.cancelledValue) + ' not billed' : 'Nothing cancelled in this selection',
        onClick: s.cancelled ? onCancelled : null }),
      ui.statTile({ label: 'Fees from statements', icon: 'shield-check', value: aggOrders ? fmt.pct(actual / aggOrders, 0) : '-',
        title: 'Share of aggregator orders whose fees come from an uploaded weekly statement; the rest carry an estimate',
        sub: !aggOrders ? 'No aggregator orders in this selection'
          : (estimated ? tileLine(ui.estimateBadge('Est.'), plural(estimated, 'order') + ' await a statement') : 'All ' + plural(aggOrders, 'aggregator order') + ' settled') })
    ];
    var sources = ['petpooja'];
    if (ce && aggOrders) {
      if (actual) sources = sources.concat(ce.sources.actual || []);
      if (estimated) sources.push(ce.sources.estimated || 'estimate');
    }
    /* the selector marks the days whose Swiggy discount split the annexure has not confirmed yet - say so next to the figures */
    var prov = s.provisional;
    return h('div', { 'class': 'ro-kpiblock' },
      h('div', { 'class': 'ro-kpis' }, tiles),
      sourceFlat(sources),
      prov && prov.swiggyDiscountSplitFrom
        ? note(h('span', { title: prov.note || null },
          'Swiggy discount split confirmed with the annexure: net sales and restaurant-funded discount for orders from ',
          h('span', { 'class': 'mk-strong' }, day(prov.swiggyDiscountSplitFrom, 'd MMM')),
          ' are as relayed to the POS until the next upload.'), 'info')
        : null);
  }

  /* ================================================================== visuals */

  function dayChart(env, onDay) {
    var sr = guard('series', function () { return MK.data.series(env.wf, { measure: 'orders', grain: 'day', by: 'channel' }); }, null);
    var buckets = (sr && sr.buckets) || [], totals = (sr && sr.total) || [];
    var hi = -1, lo = -1;
    totals.forEach(function (v, i) {
      if (!isNum(v)) return;
      if (hi === -1 || v > totals[hi]) hi = i;
      if (lo === -1 || v < totals[lo]) lo = i;
    });
    var subtitle = 'Widen the outlet, channel or medium filter to see the daily pattern';
    if (hi !== -1 && totals[hi] > 0) {
      subtitle = day(buckets[hi].key, 'EEE d MMM') + ' was the busiest day with ' + plural(totals[hi], 'order');
      if (lo !== hi) {
        subtitle += totals[lo] > 0
          ? ', ' + fmt.pct(totals[hi] / totals[lo] - 1, 0) + ' more than the quietest (' + day(buckets[lo].key, 'EEE d MMM') + ', ' + plural(totals[lo], 'order') + ')'
          : '; nothing was sold on ' + day(buckets[lo].key, 'EEE d MMM');
      }
      subtitle += '. Select a day to list its orders.';
    }
    var chart = MK.charts.mount(null, {
      id: 'ro-orders-per-day', kind: 'stackedBar', title: 'Completed orders per business day', subtitle: subtitle, height: CHART_HEIGHT, format: 'num',
      data: {
        categories: buckets.map(function (b) { return b.label; }), colourBy: 'channel', categoryHeader: 'Business day',
        series: ((sr && sr.series) || []).map(function (s) { return { id: s.id, name: s.label, values: s.values }; })
      },
      onClick: function (d) {
        var i = d && d.datum && isNum(d.datum.index) ? d.datum.index : -1;
        if (i >= 0 && buckets[i]) onDay(buckets[i].key);
      },
      emptyText: 'No completed orders in this selection'
    });
    chart.el.classList.add('ro-chart');
    chart.el.appendChild(ui.sourceTag((sr && sr.source) || 'petpooja'));
    return chart.el;
  }

  function feeStatusCard(env) {
    var ce = env.ce;
    var channels = (ce && ce.channels) || [];
    var sources = [], anyEstimate = false;
    var items = channels.map(function (c) {
      var ch = channelInfo(c.channelId), terms = termsOf(c.channelId);
      var actual = c.actual.orders, estimated = c.estimated.orders, all = actual + estimated;
      var statement = terms.statementSource || ch.statementSource;
      var statementName = sourceLabel(statement) || 'weekly statement';
      if (actual && statement) sources.push(statement);
      if (estimated) anyEstimate = true;
      var settledTo = c.settledThrough || (ce.settledThrough || {})[c.channelId];
      var awaiting = !c.actual.hasData;           /* no statement covers any order of this selection - not a zero */
      return h('div', { 'class': 'ro-fs__item' },
        h('div', { 'class': 'ro-fs__head' },
          dot(ch.colourVar),
          h('span', { 'class': 'ro-fs__name' }, ch.label),
          h('span', { 'class': 'ro-fs__doc' }, statementName)),
        awaiting ? null : ui.meter({ label: 'Orders with actual fees', value: actual, max: all || 1, tone: 'neutral', size: 'sm',
          valueLabel: all ? fmt.num(actual) + ' of ' + fmt.num(all) : 'No orders' }),
        awaiting
          ? h('p', { 'class': 'ro-fs__text' }, 'No ' + statementName + ' covers these orders yet, so every one of them carries an estimate. ', ui.estimateBadge())
          : h('p', { 'class': 'ro-fs__text' },
            settledTo ? 'Uploaded through ' + day(settledTo, 'd MMM') + '. ' : null,
            estimated ? [plural(estimated, 'newer order') + ' at assumed contract rates until the next upload ', ui.estimateBadge()]
              : (all ? 'Every order in this selection is settled.' : null)));
    });
    var instore = ce && ce.instore && ce.instore.orders ? ce.instore.orders : 0;
    var body = h('div', { 'class': 'ro-fs' },
      items.length ? items : h('p', { 'class': 'ro-fs__text' }, 'No aggregator orders in this selection.'),
      instore ? note(plural(instore, 'in-store order') + ' carry no aggregator fees (a dash in the list).', 'info') : null);
    if (anyEstimate) sources.push((ce.sources && ce.sources.estimated) || 'estimate');
    if (!sources.length) sources.push('petpooja');
    return ui.card({ title: 'Where the fee figures stand', subtitle: 'Actual fees exist only for weeks with an uploaded statement', className: 'ro-feecard',
      body: body, footer: sourceFlat(sources, true) });
  }

  /* ================================================================== orders table */

  function whenCell(v, o) {
    return gated(o, 'order.timestamp', function () {
      var late = afterMidnight(o);
      return h('div', { 'class': 'ro-when' },
        h('div', { 'class': 'mk-strong' }, day(o.businessDate, 'EEE d MMM')),
        h('div', { 'class': 'mk-xs mk-muted', title: late ? 'Placed after midnight on ' + day(calendarDate(o.placedAt)) + '; it belongs to the business day of ' + day(o.businessDate) : null },
          clock(o.placedAt), late ? ' on ' + day(calendarDate(o.placedAt), 'd MMM') : null));
    }) || dash();
  }

  function idCell(v, o) {
    return gated(o, 'order.id', function () {
      var agg = !!o.aggregatorOrderId;
      return h('div', { 'class': 'ro-id', title: capNote('order.id') || null },
        h('div', null, mono(agg ? o.aggregatorOrderId : o.posRef)),
        h('div', { 'class': 'mk-xs mk-muted' }, agg ? ['POS ', mono(o.posRef)] : 'Invoice no. ' + fmt.num(o.invoiceNo)));
    }) || dash();
  }

  function discountCell(v, o) {
    return gated(o, 'order.discountTotal', function () {
      return isNum(v) && v > 0 ? fmt.inrFull(v) : dash('No discount on this order');
    }) || dash();
  }

  function feesCell(v, o) {
    var ch = o.channelId;
    if (notApplicable(ch, 'order.feesActual') && notApplicable(ch, 'order.feesEstimated')) return dash('In-store order: no aggregator fees apply');
    if (!o.fees) return dash(o.status === 'cancelled' ? 'Cancelled order: no order-level fees' : 'No fee data for this order');
    var actual = o.fees.kind === 'actual';
    if (can(ch, actual ? 'order.feesActual' : 'order.feesEstimated') === 'no') return ui.notProvided(channelInfo(ch).short);
    return h('span', { 'class': 'ro-fee' },
      h('span', { 'class': 'ro-fee__amt mk-num' }, fmt.inrFull(o.fees.totalDeductions)),
      actual ? actualMark(o) : ui.estimateBadge());
  }

  function orderColumns() {
    return [
      { key: 'businessDate', label: 'Business date', title: (businessDayHours() ? 'A business day runs from ' + businessDayHours() + '. ' : '') + 'The clock time of the order is underneath', render: whenCell },
      { key: 'outletId', label: 'Outlet', render: function (v) { return outletName(v); } },
      { key: 'channelId', label: 'Channel', render: function (v) { return channelChip(channelInfo(v), true); } },
      { key: 'mediumId', label: 'Medium', render: function (v) { return mediumName(v); } },
      { key: 'id', label: 'Order id', title: 'Aggregator order id with the POS invoice reference underneath', render: idCell },
      { key: 'itemCount', label: 'Items', align: 'right', render: function (v, o) { return gated(o, 'order.items', function () { return fmt.num(v); }) || dash(); } },
      { key: 'netSales', label: 'Net value', align: 'right', title: 'Items plus packaging less discount, net of GST',
        render: function (v, o) {
          var off = o.status === 'cancelled';
          return h('span', { 'class': off ? 'mk-muted' : null,
            title: off && isNum(o.cancelledValue) ? 'Cancelled: ' + fmt.inrFull(o.cancelledValue) + ' of menu value was placed and none of it counts as sales' : null },
          fmt.inrFull(v));
        } },
      { key: 'discountTotal', label: 'Discount', align: 'right', render: discountCell },
      { key: 'status', label: 'Status', render: function (v, o) { return gated(o, 'order.status', function () { return statusChip(v); }) || dash(); } },
      { key: 'fees', label: 'Fees', align: 'right', title: 'Aggregator fees and GST on them: actual once the weekly statement is uploaded, estimated until then', render: feesCell }
    ];
  }

  function csvColumns() {
    function when(level, value) { return level === 'no' ? '' : value; }
    /* the export carries the words the screen shows, never an internal enum */
    function statusWord(o) { var look = STATUS_LOOK[o.status]; return look ? look.label : String(o.status || ''); }
    function gstWord(o) {
      if (!o.gst || can(o.channelId, 'order.gst') === 'no') return '';
      return o.gst.treatment === 'collected_by_restaurant'
        ? 'Collected by the restaurant - payable'
        : 'Collected and paid by ' + channelInfo(o.channelId).label + ' under section 9(5) - memo';
    }
    return [
      { label: 'Business date', value: function (o) { return o.businessDate; } },
      { label: 'Placed at', value: function (o) { return when(can(o.channelId, 'order.timestamp'), o.placedAt); } },
      { label: 'Outlet', value: function (o) { var u = outletInfo(o.outletId); return u ? u.name : o.outletId; } },
      { label: 'Channel', value: function (o) { return channelInfo(o.channelId).label; } },
      { label: 'Medium', value: function (o) { return mediumName(o.mediumId); } },
      { label: 'Aggregator order id', value: function (o) { return when(can(o.channelId, 'order.id'), o.aggregatorOrderId || ''); } },
      { label: 'POS invoice reference', value: function (o) { return when(can(o.channelId, 'order.id'), o.posRef); } },
      { label: 'Status', value: function (o) { return when(can(o.channelId, 'order.status'), statusWord(o)); } },
      { label: 'Items', value: function (o) { return when(can(o.channelId, 'order.items'), o.itemCount); } },
      { label: 'Item subtotal', value: function (o) { return when(can(o.channelId, 'order.subtotal'), o.subtotal); } },
      { label: 'Packaging charge', value: function (o) { return when(can(o.channelId, 'order.packagingCharge'), o.packagingCharge); } },
      { label: 'Discount', value: function (o) { return when(can(o.channelId, 'order.discountTotal'), o.discountTotal); } },
      { label: 'Net sales', value: function (o) { return o.netSales; } },
      { label: 'GST', value: function (o) { return o.gst && can(o.channelId, 'order.gst') !== 'no' ? o.gst.amount : ''; } },
      { label: 'GST treatment', value: gstWord },
      { label: 'Order total', value: function (o) { return o.total; } },
      { label: 'Fees basis', value: function (o) { return o.fees ? (o.fees.kind === 'actual' ? 'Actual' : 'Estimated') : ''; } },
      { label: 'Fees and GST on fees', value: function (o) { return o.fees ? o.fees.totalDeductions : ''; } },
      { label: 'TDS by e-commerce operator (recoverable)', value: function (o) { return o.fees ? o.fees.tds : ''; } },
      { label: 'Net receivable', value: function (o) { return o.fees ? o.fees.netReceivable : ''; } },
      { label: 'Fee source', value: function (o) { return o.feesSource ? sourceLabel(o.feesSource) : ''; } }
    ];
  }

  function ordersCard(env) {
    var st = env.st, f = env.f;
    var lastRows = [], lastTotal = 0;

    function tableFilter() {
      return { from: st.day || null, to: st.day || null, outletIds: f.outletIds, channelIds: st.channel !== ALL ? [st.channel] : f.channelIds, mediumIds: f.mediumIds };
    }
    function query(limit, offset, status) {
      return recent(tableFilter(), { limit: limit, offset: offset, search: st.search, status: status === ALL ? undefined : status });
    }

    /* ---- stable parts: the card is built once per render; paint() refreshes what depends on the page-local state */
    var subtitle = h('span', null);
    var tabsHost = h('div', { 'class': 'ro-toolbar__tabs' });
    var dayHost = h('span', { 'class': 'ro-toolbar__day' });
    var pagerHost = h('div', { 'class': 'ro-pager' });
    var sourceHost = h('div', { 'class': 'ro-sourcehost' });
    var emptyHost = h('div');

    var table = ui.table({
      dense: true, sortable: false, columns: orderColumns(), rows: [], empty: emptyHost, className: 'ro-table',
      caption: null,
      rowClass: function (o) { return o.id === st.openId ? 'is-selected' : ''; },
      onRowClick: function (o) { openDrawer(o, env); }
    });

    var search = ui.form.search({ value: st.search, placeholder: 'Search order id, POS invoice or dish', width: 264, ariaLabel: 'Search orders by order id, POS invoice reference or dish',
      onInput: function (v) { st.search = v; st.page = 0; paint(); } });

    var csvBtn = ui.button({ label: 'CSV', icon: 'download', size: 'sm', title: 'Download the matching orders with the fields each channel shares', onClick: function () {
      var all = query(Math.max(lastTotal, 1), 0, st.status).rows;
      ui.downloadCsv('orders-' + env.win.from + '-to-' + env.win.to + '.csv', csvColumns(), all);
    } });

    var channelSeg = null;
    if (env.channelOptions.length > 1) {
      channelSeg = ui.segmented({ ariaLabel: 'Channel', size: 'sm', value: st.channel,
        options: [{ value: ALL, label: 'All channels' }].concat(env.channelOptions.map(function (ch) {
          return { value: ch.id, label: [dot(ch.colourVar, true), ch.short || ch.label] };
        })),
        onChange: function (v) { st.channel = v; st.page = 0; paint(); } });
    }

    function paintTabs(shownTotal) {
      var hadFocus = tabsHost.contains(doc.activeElement);
      var counts = {};
      STATUS_TABS.forEach(function (t) { counts[t.id] = t.id === st.status ? shownTotal : query(1, 0, t.id).total; });
      var tabs = ui.tabs({ ariaLabel: 'Order status', value: st.status,
        items: STATUS_TABS.map(function (t) { return { id: t.id, label: t.label, count: counts[t.id] }; }),
        onChange: function (id) { st.status = id; st.page = 0; paint(); } });
      ui.clear(tabsHost).appendChild(tabs);
      if (hadFocus) { var on = tabs.querySelector('[aria-selected="true"]'); if (on) on.focus(); }
    }

    function paintDay() {
      ui.clear(dayHost);
      if (!st.day) return;
      dayHost.appendChild(ui.button({ label: 'Business day ' + day(st.day, 'EEE d MMM'), iconRight: 'x', size: 'sm', title: 'Show every business day again',
        onClick: function () { st.day = null; st.page = 0; paint(); } }));
    }

    function paintEmpty() {
      ui.clear(emptyHost);
      var hasSearch = !!(st.search && st.search.trim());
      var narrowed = hasSearch || st.status !== ALL || st.channel !== ALL || !!st.day;
      if (!env.scopeTotal) {
        /* nothing under the global filters at all: the quick filters of this list are not the reason */
        var crossed = !!((f.channelIds && f.channelIds.length) || (f.mediumIds && f.mediumIds.length));
        emptyHost.appendChild(ui.emptyState('No orders for these filters',
          crossed ? 'This combination of outlet, channel and medium has no orders: delivery belongs to Swiggy and Zomato, dine-in and takeaway to the POS.'
            : 'The outlets in this selection recorded no orders in these business days.',
          { compact: true, icon: 'filter', action: crossed ? ui.button({ label: 'Show every channel and medium', size: 'sm', onClick: function () { MK.filters.set({ channelIds: null, mediumIds: null }); } }) : null }));
        return;
      }
      emptyHost.appendChild(ui.emptyState(
        hasSearch ? 'No order matches "' + st.search.trim() + '"' : 'No orders for this selection',
        hasSearch ? 'The search looks at the order id, the POS invoice reference and the dish names of the last ' + plural(MK.dates.diffDays(env.win.from, env.win.to) + 1, 'business day') + '.'
          : 'Nothing is left after the status, channel and day filters of this list.',
        { compact: true, icon: hasSearch ? 'search' : 'filter',
          action: narrowed ? ui.button({ label: 'Clear the quick filters', size: 'sm', onClick: function () {
            st.search = ''; st.status = ALL; st.channel = ALL; st.day = null; st.page = 0; search.input.value = '';
            env.ctx.rerender();
          } }) : null }));
    }

    function paintPager(res, pages) {
      /* the pager is rebuilt on every paint: hand the keyboard back the control it was on (or its nearest live neighbour) */
      var spot = focusSpot(pagerHost);
      ui.clear(pagerHost);
      var first = res.total ? st.page * st.pageSize + 1 : 0, last = Math.min(res.total, (st.page + 1) * st.pageSize);
      pagerHost.appendChild(h('span', { 'class': 'ro-pager__count' }, res.total ? 'Showing ' + fmt.num(first) + ' - ' + fmt.num(last) + ' of ' + plural(res.total, 'order') : 'No orders to show'));
      pagerHost.appendChild(h('span', { 'class': 'ro-pager__controls' },
        h('span', { 'class': 'mk-muted' }, 'Rows'),
        ui.select({ ariaLabel: 'Rows per page', size: 'sm', value: String(st.pageSize),
          options: PAGE_SIZES.map(function (n) { return { value: String(n), label: fmt.num(n) }; }),
          onChange: function (v) { st.pageSize = +v || PAGE_SIZES[0]; st.page = 0; paint(); } }),
        h('span', { 'class': 'ro-pager__page' }, 'Page ' + fmt.num(st.page + 1) + ' of ' + fmt.num(pages)),
        ui.button({ icon: 'chevron-left', size: 'sm', title: 'Previous page', ariaLabel: 'Previous page', disabled: st.page <= 0, onClick: function () { turnPage(-1); } }),
        ui.button({ icon: 'chevron-right', size: 'sm', title: 'Next page', ariaLabel: 'Next page', disabled: st.page >= pages - 1, onClick: function () { turnPage(1); } })));
      restoreFocus(pagerHost, spot);
    }

    function paint() {
      var res = query(st.pageSize, st.page * st.pageSize, st.status);
      var pages = Math.max(1, Math.ceil(res.total / st.pageSize));
      if (st.page > pages - 1) { st.page = pages - 1; res = query(st.pageSize, st.page * st.pageSize, st.status); }
      lastRows = res.rows; lastTotal = res.total;

      paintTabs(res.total); paintDay(); paintEmpty();
      table.setRows(res.rows);
      paintPager(res, pages);

      var scope = st.day ? longDay(st.day) : rangeLabel(res.from || env.win.from, res.to || env.win.to);
      subtitle.textContent = plural(res.total, 'order') + ', newest first - ' + scope;

      var sources = [];
      res.rows.forEach(function (o) {
        if (o.source && sources.indexOf(o.source) === -1) sources.push(o.source);
      });
      res.rows.forEach(function (o) {
        if (o.feesSource && o.feesSource !== 'estimate' && sources.indexOf(o.feesSource) === -1) sources.push(o.feesSource);
      });
      if (res.rows.some(function (o) { return o.feesSource === 'estimate'; })) sources.push('estimate');
      if (!sources.length) sources.push('petpooja');
      ui.clear(sourceHost).appendChild(sourceFlat(sources));
      csvBtn.disabled = !res.total;
    }

    function markSelected() {
      var trs = table.querySelectorAll('tbody tr');
      lastRows.forEach(function (o, i) { if (trs[i]) trs[i].classList.toggle('is-selected', o.id === st.openId); });
    }

    function turnPage(dir) {
      var pages = Math.max(1, Math.ceil(lastTotal / st.pageSize));
      var next = st.page + dir;
      if (next < 0 || next > pages - 1) return false;
      st.page = next;
      paint();
      return true;
    }

    /* what the drawer and the rest of the page may ask of this card */
    env.rows = function () { return lastRows; };
    env.total = function () { return lastTotal; };
    env.offset = function () { return st.page * st.pageSize; };
    env.turnPage = turnPage;
    env.markSelected = function () { if (doc.contains(table)) markSelected(); };
    env.showDay = function (iso) { st.day = st.day === iso ? null : iso; st.page = 0; paint(); card.scrollIntoView({ block: 'nearest' }); };
    env.showStatus = function (status) { st.status = status; st.page = 0; paint(); card.scrollIntoView({ block: 'nearest' }); };

    var card = ui.card({
      title: 'Orders', subtitle: subtitle, flush: true, className: 'ro-orders',
      actions: [search, csvBtn],
      body: [
        h('div', { 'class': 'ro-toolbar' }, tabsHost, h('div', { 'class': 'ro-toolbar__right' }, dayHost, channelSeg)),
        table, pagerHost
      ],
      footer: sourceHost
    });
    paint();
    return card;
  }

  /* ================================================================== order drawer */

  function drawerTitle(o) {
    var ch = channelInfo(o.channelId);
    return (isAggregator(ch) ? ch.label + ' order ' : 'In-store bill ') + o.id;
  }

  function drawerSubtitle(o) {
    var u = outletInfo(o.outletId);
    return [u ? u.name : o.outletId, mediumName(o.mediumId), longDay(o.businessDate)].join(' - ');
  }

  function cancelCallout(o, ch) {
    var lines = [];
    var level = notApplicable(o.channelId, 'order.cancelReason') ? 'n/a' : can(o.channelId, 'order.cancelReason');
    var c = o.cancel || null;
    if (level === 'no') lines.push(h('p', null, 'Reason: ', ui.notProvided(ch.label)));
    else if (level === 'yes' || level === 'partial') {
      if (c && c.reason) lines.push(h('p', null, 'Reason: ' + c.reason + (c.approver ? ' - approved by the ' + lowerFirst(c.approver) : '')));
      else if (c && c.cancelledBy) lines.push(h('p', null, 'Cancelled by: ' + c.cancelledBy + ' (from the ' + sourceLabel(termsOf(o.channelId).statementSource) + ')'));
      else lines.push(h('p', null, level === 'partial' ? 'Reason not available yet for this order. ' + capNote('order.cancelReason') : 'No reason was recorded.'));
    }
    if (isNum(o.cancelledValue) && o.cancelledValue > 0) lines.push(h('p', null, fmt.inrFull(o.cancelledValue) + ' of menu value was placed; nothing of it is counted in sales or GST.'));
    return ui.callout('warn', 'Order cancelled' + (o.timeline && o.timeline.cancelledAt ? ' at ' + clock(o.timeline.cancelledAt) : ''), h('div', { 'class': 'ro-lines' }, lines), { icon: 'x-circle' });
  }

  function orderFacts(o, ch) {
    var slot = slotInfo(o.slotId), u = outletInfo(o.outletId);
    var late = afterMidnight(o);
    return ui.keyValue([
      isAggregator(ch) ? [ch.label + ' order id', gated(o, 'order.id', function () { return mono(o.aggregatorOrderId || o.id); })] : null,
      ['POS invoice', gated(o, 'order.id', function () {
        return h('span', { title: capNote('order.id') || null }, mono(o.posRef), h('span', { 'class': 'mk-muted' }, '  invoice no. ' + fmt.num(o.invoiceNo) + ' of the day'));
      })],
      ['Outlet', u ? u.name + (u.city ? ', ' + u.city : '') : o.outletId],
      ['Business day', longDay(o.businessDate)],
      ['Placed at', gated(o, 'order.timestamp', function () {
        return h('span', null, ui.dateTime(o.placedAt), late ? h('span', { 'class': 'mk-muted' }, '  after midnight, counted in the business day above') : null);
      })],
      slot ? ['Time slot', slot.label + ' (' + slot.range + ')'] : null
    ]);
  }

  function itemsTable(o, ch) {
    if (can(o.channelId, 'order.items') === 'no') return ui.notProvided(ch.label);
    return ui.table({
      dense: true, className: 'ro-items',
      columns: [
        { key: 'name', label: 'Item', render: function (v, l) { return h('div', null, h('div', null, v), h('div', { 'class': 'mk-xs mk-muted' }, [categoryName(l.category), l.veg ? 'Veg' : 'Non-veg'].filter(Boolean).join(', '))); } },
        { key: 'qty', label: 'Qty', format: 'num' },
        { key: 'unitPrice', label: 'Unit price', format: 'inrFull' },
        { key: 'lineTotal', label: 'Line total', format: 'inrFull' }
      ],
      rows: o.items || [],
      footer: can(o.channelId, 'order.subtotal') !== 'no' ? { name: 'Item subtotal', qty: o.itemCount, lineTotal: o.subtotal } : null,
      empty: 'No item lines on this order'
    });
  }

  function discountSub(o, ch) {
    if (!isNum(o.discountTotal) || o.discountTotal <= 0) return null;
    if (notApplicable(o.channelId, 'order.discountRestaurantFunded')) return null;
    var level = can(o.channelId, 'order.discountRestaurantFunded');
    if (level === 'no') return null;
    if (isNum(o.discountRestaurantFunded)) {
      return o.discountRestaurantFunded === o.discountTotal
        ? 'Funded by the restaurant in full'
        : fmt.inrFull(o.discountRestaurantFunded) + ' of it funded by the restaurant';
    }
    return level === 'partial' ? 'Restaurant-funded share not split yet. ' + capNote('order.discountRestaurantFunded') : null;
  }

  function amountsBlock(o, ch) {
    var cancelled = o.status === 'cancelled';
    var gstPct = cfg().gst && isNum(cfg().gst.salesPct) ? ' (' + fmt.pct(cfg().gst.salesPct, 0) + ')' : '';
    var lines = [
      { label: capLabel('order.subtotal', 'Item subtotal'), amount: can(o.channelId, 'order.subtotal') === 'no' ? ui.notProvided(ch.label) : o.subtotal },
      { label: capLabel('order.packagingCharge', 'Packaging charge'), amount: can(o.channelId, 'order.packagingCharge') === 'no' ? ui.notProvided(ch.label) : o.packagingCharge },
      { label: 'Discount', kind: 'minus', sub: discountSub(o, ch), amount: can(o.channelId, 'order.discountTotal') === 'no' ? ui.notProvided(ch.label) : o.discountTotal }
    ];
    if (cancelled) lines.push({ label: 'Cancelled value', sub: 'As placed - not counted in sales', kind: 'minus', amount: o.cancelledValue });
    lines.push({ label: 'Net sales', sub: 'Net of GST', kind: 'total', amount: o.netSales });

    var gst = o.gst || {};
    if (can(o.channelId, 'order.gst') === 'no') {
      lines.push({ label: 'GST', amount: ui.notProvided(ch.label) });
    } else if (gst.treatment === 'collected_by_restaurant') {
      lines.push({ label: 'GST collected by restaurant' + gstPct, sub: 'Payable by the restaurant', amount: gst.amount });
    } else {
      lines.push({ label: 'GST collected and paid by ' + ch.label + ' under section 9(5) - memo', kind: 'memo',
        sub: 'Never restaurant revenue and never GST payable by the restaurant', amount: gst.amount });
    }
    lines.push({ label: 'Order total', kind: 'total', amount: o.total,
      sub: isAggregator(ch) ? 'Food bill including GST. Customer-side delivery, platform and surge fees are not shared by ' + ch.label : 'Bill value including GST' });
    return ledger(lines);
  }

  function feesBlock(o, ch) {
    var terms = termsOf(o.channelId);
    if (notApplicable(o.channelId, 'order.feesActual') && notApplicable(o.channelId, 'order.feesEstimated')) {
      return { extra: null, body: note('Aggregator fees do not apply to an in-store order.', 'info'), source: null };
    }
    if (!o.fees) {
      return { extra: null, source: null, body: note(o.status === 'cancelled'
        ? 'No order-level fees: the order was cancelled. A cancellation charge, if any, arrives as a line of the weekly payout statement.'
        : 'No fee data for this order.', 'info') };
    }
    var fees = o.fees, actual = fees.kind === 'actual';
    if (can(o.channelId, actual ? 'order.feesActual' : 'order.feesEstimated') === 'no') return { extra: null, body: ui.notProvided(ch.label), source: null };

    var base = FEE_BASE_LABEL[terms.serviceFeeBase] || 'fee base';
    /* a rate read off the contract is an assumption (MK.config.channelTerms.ratesAssumed); a rate read off a statement is a fact */
    function contractRate(pct) { return isNum(pct) ? ' (' + rate(pct) + ' assumed)' : ''; }
    /* an estimated "other fee" is an expected value spread over every unsettled order - it must not read as a charge on THIS order */
    var expectedOther = !actual && !!terms.longDistanceFee;
    var lines = [
      { label: 'Net sales of the order', amount: o.netSales },
      { label: (terms.serviceFeeLabel || 'Service fee') + (isNum(fees.serviceFeePct) ? (actual ? ' (' + rate(fees.serviceFeePct) + ')' : contractRate(fees.serviceFeePct)) : ''), kind: 'minus', amount: fees.serviceFee,
        sub: 'On a fee base of ' + fmt.inrFull(fees.feeBase) + ' - ' + base },
      { label: (terms.collectionFeeLabel || 'Collection fee') + (actual ? '' : contractRate(terms.collectionFeePct)), kind: 'minus', amount: fees.collectionFee,
        sub: FEE_BASE_LABEL[terms.collectionFeeBase] ? 'On the ' + FEE_BASE_LABEL[terms.collectionFeeBase] : null },
      isNum(fees.otherFees) && fees.otherFees !== 0
        ? { label: expectedOther ? 'Other fees, at the expected rate' : (terms.otherFeeLabel || 'Other fees'), kind: 'minus', amount: fees.otherFees,
          sub: expectedOther ? 'Which orders travelled a long distance is only on the settlement report, so every unsettled order carries the same expected amount' : null }
        : null,
      { label: 'GST on fees' + (isNum(terms.gstOnFeesPct) ? ' (' + fmt.pct(terms.gstOnFeesPct, 0) + ')' : ''), kind: 'minus', amount: fees.gstOnFees, sub: 'Not creditable for a restaurant on the ' + (cfg().gst && isNum(cfg().gst.salesPct) ? fmt.pct(cfg().gst.salesPct, 0) + ' ' : '') + 'scheme - a real cost' },
      { label: 'Fees and GST on them', kind: 'total', negate: true, amount: fees.totalDeductions, tag: actual ? null : ui.estimateBadge('Est.') },
      { label: terms.tdsLabel || 'TDS by e-commerce operator', kind: 'minus', amount: fees.tds, sub: 'A recoverable tax credit, not an expense' },
      { label: 'Net receivable for this order', kind: 'total', amount: fees.netReceivable, tag: actual ? null : ui.estimateBadge('Est.') }
    ];
    var statement = sourceLabel(terms.statementSource);
    var basis = actual
      ? 'Actual: taken from the ' + statement + (o.payoutId ? ', payout cycle ' + o.payoutId : '') + '.'
      : 'Estimated at the assumed contract rate' + (isNum(fees.serviceFeePct) ? ' of ' + rate(fees.serviceFeePct) : '') + ' on a fee base of ' + fmt.inrFull(fees.feeBase) +
        '. The ' + statement + ' for this period is not uploaded yet; actual figures replace the estimate when it is.';
    return {
      extra: actual ? actualChip(o) : ui.estimateBadge(),
      source: o.feesSource,
      body: h('div', { 'class': 'ro-stack' },
        note(basis, actual ? 'check-circle' : 'clock'),
        ledger(lines),
        note(['Order-level fees only: ads, refunds and other cycle-level deductions sit on the weekly payout. ',
          o.payoutId ? h('span', { 'class': 'ro-note__link' }, ui.link('Open the payout cycle', MK.router.href('revenue-audit', { payout: o.payoutId }), { icon: 'arrow-right' })) : null], 'info'))
    };
  }

  function timelineBlock(o, ch) {
    var t = o.timeline || null;
    if (!t) {
      /* in-store bill: one event; the kitchen time is governed by the matrix like everything else */
      return ui.keyValue([
        ['Billed at', gated(o, 'order.timestamp', function () { return ui.dateTime(o.placedAt); })],
        [capLabel('order.prepTime', 'Preparation time'), gated(o, 'order.prepTime', function () { return isNum(o.prepMinutes) ? fmt.num(o.prepMinutes) + ' min' : dash(); })],
        [capLabel('order.deliveredTime', 'Delivered time'), gated(o, 'order.deliveredTime', function () { return dash(); })]
      ]);
    }
    var cancelled = o.status === 'cancelled';
    var prepLevel = notApplicable(o.channelId, 'order.prepTime') ? 'n/a' : can(o.channelId, 'order.prepTime');
    var items = [];
    STEPS.forEach(function (s) {
      var at = t[s.prop];
      if (notApplicable(o.channelId, s.cap)) return;
      if (can(o.channelId, s.cap) === 'no') { items.push({ label: s.label, state: 'off', detail: ui.notProvided(ch.label) }); return; }
      if (!at && cancelled) return;                               /* the order never got this far - do not list it as missing */
      var detail = null;
      if (!at) detail = s.missing || 'Not relayed for this order';
      if (s.prop === 'foodReadyAt' && at && prepLevel !== 'n/a') {
        detail = prepLevel === 'no' ? ['Preparation time: ', ui.notProvided(ch.label)]
          : (isNum(o.prepMinutes) ? [h('strong', null, 'Preparation ' + fmt.num(o.prepMinutes) + ' min'), ' - derived from POS status times (accepted to food ready), not reported by ' + ch.label] : null);
      }
      items.push({ label: s.label, at: at, state: at ? 'done' : 'off', detail: detail });
    });
    if (t.cancelledAt) items.push({ label: 'Cancelled', at: t.cancelledAt, state: 'stop' });
    return h('ol', { 'class': 'ro-steps' }, items.map(function (it) {
      return h('li', { 'class': 'ro-step ro-step--' + it.state },
        h('span', { 'class': 'ro-step__dot', 'aria-hidden': 'true' }, it.state === 'done' ? ui.icon('check', 12) : (it.state === 'stop' ? ui.icon('x', 12) : null)),
        h('div', { 'class': 'ro-step__main' },
          h('div', { 'class': 'ro-step__line' }, h('span', { 'class': 'ro-step__label' }, it.label),
            it.at ? h('span', { 'class': 'ro-step__time mk-num', title: ui.dateTime(it.at) }, clock(it.at)) : null),
          it.detail ? h('div', { 'class': 'ro-step__detail' }, it.detail) : null));
    }));
  }

  function paymentBlock(o, ch) {
    var value = gated(o, 'order.paymentMode', function (level) {
      if (level === 'yes') return o.paymentMode ? h('strong', null, o.paymentMode) : h('span', { 'class': 'mk-muted' }, o.status === 'cancelled' ? 'No payment taken - the order was cancelled' : 'Not recorded');
      var flag = o.paymentFlag ? (PAYMENT_FLAG_LABEL[o.paymentFlag] || o.paymentFlag) : null;
      return h('span', null, flag ? h('strong', null, flag) : dash(), h('div', { 'class': 'mk-xs mk-muted' }, capNote('order.paymentMode') || (ch.label + ' shares a limited payment flag only')));
    });
    return ui.keyValue([[capLabel('order.paymentMode', 'Payment mode'), value]]);
  }

  function customerBlock(o, ch) {
    var fields = CUSTOMER_FIELDS.filter(function (fld) { return !notApplicable(o.channelId, fld.cap); });
    var shared = fields.filter(function (fld) { return can(o.channelId, fld.cap) !== 'no'; });
    if (!isAggregator(ch) && !shared.length) {
      return note('Customer capture is not part of this preview: phone capture covers only a minority of counter bills, so no customer data is shown for in-store orders.', 'info');
    }
    return h('div', { 'class': 'ro-stack' },
      ui.keyValue(fields.map(function (fld) {
        return [capLabel(fld.cap), gated(o, fld.cap, function () { return o[fld.prop] || dash(); })];
      })),
      isAggregator(ch) ? note(ch.label + ' masks customer details: the restaurant never receives the name, phone number or address, so the ERP holds no customer data for this order.', 'lock') : null);
  }

  function orderBody(o) {
    var ch = channelInfo(o.channelId);
    var fees = feesBlock(o, ch);
    var sources = [o.source || 'petpooja'];
    if (fees.source && sources.indexOf(fees.source) === -1) sources.push(fees.source);
    /* "cancelled by" reaches the ERP only through the weekly statement: tag it where the callout quotes it */
    var cancelStatement = o.status === 'cancelled' && o.cancel && o.cancel.cancelledBy ? termsOf(o.channelId).statementSource : null;
    if (cancelStatement && sources.indexOf(cancelStatement) === -1) sources.push(cancelStatement);
    return h('div', { 'class': PAGE_CLASS + ' ro-overlay' },
      h('div', { 'class': 'ro-meta' }, statusChip(o.status), channelChip(ch, false), ui.chip(mediumName(o.mediumId)),
        h('span', { 'class': 'ro-meta__value' }, h('span', { 'class': 'ro-meta__label' }, 'Net sales '), h('strong', { 'class': 'mk-num' }, fmt.inrFull(o.netSales)))),
      o.status === 'cancelled' ? cancelCallout(o, ch) : null,
      section('Order', orderFacts(o, ch)),
      section('Items', itemsTable(o, ch)),
      section('Amounts', amountsBlock(o, ch)),
      section('Aggregator fees', fees.body, fees.extra),
      section(o.timeline ? 'Status timeline' : 'Kitchen and service', timelineBlock(o, ch),
        o.timeline ? h('span', { 'class': 'mk-xs mk-muted' }, capNote('order.status')) : null),
      section('Payment', paymentBlock(o, ch)),
      section('Customer', customerBlock(o, ch)),
      ui.sourceTag(sources));
  }

  function showInDrawer(order, keepScroll) {
    if (!live) return;
    live.order = order;
    live.ctrl.setTitle(drawerTitle(order), drawerSubtitle(order));
    var top = live.ctrl.body.scrollTop;
    live.ctrl.setBody(orderBody(order));
    live.ctrl.body.scrollTop = keepScroll ? top : 0;

    var env = live.env, rows = env.rows ? env.rows() : [], i = -1;
    rows.forEach(function (r, k) { if (r.id === order.id) i = k; });
    var total = env.total ? env.total() : 0, at = i === -1 ? -1 : env.offset() + i;
    live.prevBtn.disabled = at <= 0;
    live.nextBtn.disabled = at === -1 || at >= total - 1;
    live.pos.textContent = at === -1 ? '' : 'Order ' + fmt.num(at + 1) + ' of ' + fmt.num(total) + ' in the list';
    if (doc.activeElement === doc.body || !live.ctrl.el.contains(doc.activeElement)) {
      var target = !live.nextBtn.disabled ? live.nextBtn : (!live.prevBtn.disabled ? live.prevBtn : live.closeBtn);
      target.focus();
    }
  }

  function stepDrawer(dir) {
    if (!live || !live.order) return;
    var env = live.env, rows = env.rows(), i = -1;
    rows.forEach(function (r, k) { if (r.id === live.order.id) i = k; });
    if (i === -1) return;
    var j = i + dir;
    if (j < 0 || j > rows.length - 1) {
      if (!env.turnPage(dir)) return;
      rows = env.rows();
      j = dir > 0 ? 0 : rows.length - 1;
    }
    if (rows[j]) openDrawer(rows[j], env);
  }

  function openDrawer(order, env) {
    env.st.openId = order.id;
    if (!live) {
      var prevBtn = ui.button({ label: 'Previous', icon: 'chevron-left', title: 'Previous order in the list', onClick: function () { stepDrawer(-1); } });
      var nextBtn = ui.button({ label: 'Next', iconRight: 'chevron-right', title: 'Next order in the list', onClick: function () { stepDrawer(1); } });
      var closeBtn = ui.button({ label: 'Close', variant: 'primary', onClick: function () { if (live) live.ctrl.close(); } });
      closeBtn.setAttribute('data-autofocus', '');
      var pos = h('span', { 'class': 'mk-grow mk-small mk-muted' });
      live = { env: env, order: order, prevBtn: prevBtn, nextBtn: nextBtn, closeBtn: closeBtn, pos: pos, ctrl: null };
      live.ctrl = ui.drawer({
        title: drawerTitle(order), subtitle: drawerSubtitle(order), width: DRAWER_WIDTH, body: null, footer: [pos, prevBtn, nextBtn, closeBtn],
        onClose: function () {
          var was = live;
          live = null;
          if (was && was.env) was.env.onDrawerClosed(was.order ? was.order.id : null);
        }
      });
    }
    live.env = env;
    showInDrawer(order, false);
    env.markSelected();
  }

  /* a router re-render (filters, persona, store) keeps the drawer: point it at the new page state, or close it when
     the order left the persona's scope */
  function syncDrawer(env) {
    if (!live) { env.st.openId = null; return; }
    live.env = env;
    var fresh = live.order ? findOrder(live.order.id) : null;
    if (!fresh) { live.ctrl.close(); return; }
    env.st.openId = fresh.id;
    showInDrawer(fresh, true);
    env.markSelected();
  }

  /* ================================================================== render */

  function render(rootEl, ctx) {
    var st = ctx.state, f = ctx.filters || {};
    if (STATUS_TABS.every(function (t) { return t.id !== st.status; })) st.status = ALL;
    st.channel = st.channel || ALL;
    st.search = typeof st.search === 'string' ? st.search : '';
    st.page = st.page > 0 ? Math.floor(st.page) : 0;
    if (PAGE_SIZES.indexOf(st.pageSize) === -1) st.pageSize = PAGE_SIZES[0];
    st.day = st.day || null;

    var scopeFilter = { from: null, to: null, outletIds: f.outletIds || null, channelIds: f.channelIds || null, mediumIds: f.mediumIds || null };
    var probe = recent(scopeFilter, { limit: 1 });            /* the window of the list and the number of orders under the global filters */
    var outlets = guard('allowedOutletIds', function () { return MK.session.allowedOutletIds(); }, []);

    if (!outlets.length || !probe.windowFrom || !probe.windowTo) {
      if (live) live.ctrl.close();
      rootEl.appendChild(ui.card({ body: ui.emptyState(
        outlets.length ? 'No recent orders are available' : 'No outlet in your scope',
        outlets.length ? 'The order-level list covers the most recent business days only and none are loaded yet.'
          : 'Orders belong to outlets. ' + (ctx.user && ctx.user.name ? ctx.user.name + ' looks after a unit without customer sales' : 'This persona has no outlet') + ', so there is no order list to show.',
        { icon: 'receipt' }) }));
      return;
    }

    var win = { from: probe.windowFrom, to: probe.windowTo };
    if (st.day && (st.day < win.from || st.day > win.to)) st.day = null;
    var wf = { from: win.from, to: win.to, outletIds: scopeFilter.outletIds, channelIds: scopeFilter.channelIds, mediumIds: scopeFilter.mediumIds };

    var env = { ctx: ctx, st: st, f: scopeFilter, wf: wf, win: win, scopeTotal: probe.total };
    env.summary = guard('summary', function () { return MK.data.summary(wf); }, null) || { orders: 0, netSales: 0, aov: 0, itemsPerOrder: 0, cancelled: 0, cancelledValue: 0, cancelRate: 0, ordersPerDay: 0, prev: null };
    env.ce = guard('channelEconomics', function () { return MK.data.channelEconomics(wf); }, null);

    /* channels that have orders under the global filters: the quick filter offers only those */
    var mix = guard('breakdown', function () { return MK.data.breakdown(wf, 'channel'); }, null);
    env.channelOptions = ((mix && mix.rows) || []).filter(function (r) { return (r.orders || 0) + (r.cancelled || 0) > 0; }).map(function (r) { return channelInfo(r.id); });
    if (st.channel !== ALL && !env.channelOptions.some(function (c) { return c.id === st.channel; })) st.channel = ALL;

    env.rows = function () { return []; };
    env.markSelected = function () {};
    env.onDrawerClosed = function (closedId) {
      st.openId = null;
      env.markSelected();
      if (st.opened && closedId === st.opened) {
        var wanted = st.opened;
        st.opened = null;
        var cur = MK.router.current();
        if (cur && cur.page.id === PAGE_ID && cur.params.id === wanted) ctx.navigate(PAGE_ID, null, { replace: true });
      }
    };

    rootEl.appendChild(intro(env));
    safe(rootEl, 'Key figures', function () { return kpiBlock(env, function () { if (env.showStatus) env.showStatus('cancelled'); }); });

    var chartHost = h('div', { 'class': 'ro-cell' }), feeHost = h('div', { 'class': 'ro-cell' });
    safe(chartHost, 'Orders per day', function () { return dayChart(env, function (iso) { if (env.showDay) env.showDay(iso); }); });
    safe(feeHost, 'Fee status', function () { return feeStatusCard(env); });
    rootEl.appendChild(ui.grid([7, 5], [chartHost, feeHost], { className: 'ro-pair' }));

    safe(rootEl, 'Orders', function () { return ordersCard(env); });

    syncDrawer(env);

    /* deep link: #/revenue/orders?id=<order id> opens the order once; closing it takes the id out of the hash */
    var wantedId = ctx.params && ctx.params.id;
    if (wantedId && st.opened !== wantedId) {
      st.opened = wantedId;
      var hit = findOrder(wantedId);
      if (hit) openDrawer(hit, env);
    }
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/revenue/orders',
    group: 'Revenue',
    title: 'Recent orders',
    subtitle: 'Order by order, with only the fields each channel shares',
    units: 'outlets',
    roles: null,
    filters: ['outlet', 'channel', 'medium'],
    render: render
  });
})(window);
