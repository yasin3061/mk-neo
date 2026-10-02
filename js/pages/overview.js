/*
 * Overview - the management cockpit (#/overview).
 *
 * Two variants behind one route:
 *   - sales view   for every persona with at least one outlet in scope (the data layer narrows it to Bandra for the outlet manager);
 *   - factory view for a persona whose only unit is the central kitchen (no sales scope), so the screen is never a page of zeros.
 *
 * Every figure comes from MK.data / MK.finance / MK.factory / MK.workflow / MK.insights and is formatted with MK.fmt.
 * Aggregator take rates use settled statements only; anything estimated carries MK.ui.estimateBadge() and the estimate source tag.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, dates = MK.dates;

  var SPARK_DAYS = 30;          /* window of the scorecard sparkline, ending on the last day of the filter */
  var INSIGHT_LIMIT = 10;       /* "Needs attention" shows the top items; the rest stay one click away */
  var MARKER_LIMIT = 8;         /* past this many event markers the single-day weather markers are dropped */
  var WEEKEND_DOWS = [5, 6];    /* Saturday, Sunday (0 = Monday) */
  var SHORT_EVENT_DAYS = 3;     /* an event of up to this many days gets one marker instead of a begin / end pair */
  var MIX_BUCKET_LIMIT = 8;    /* bars that fit the side chart; a longer range switches from weeks to months */

  var SEVERITIES = [
    { id: 'critical', label: 'Critical', tone: 'critical', icon: 'alert-triangle' },
    { id: 'warning', label: 'Warning', many: 'warnings', tone: 'warn', icon: 'eye' },
    { id: 'info', label: 'For information', tone: 'info', icon: 'info' },
    { id: 'good', label: 'Going well', tone: 'good', icon: 'check-circle' }
  ];
  var STATUS_RANK = { RISK: 2, WATCH: 1, OK: 0 };

  /* ------------------------------------------------------------ helpers */

  function rangeLabel(from, to, withYear) {
    var end = dates.label(to, withYear ? 'd MMM yyyy' : undefined);
    return from === to ? end : dates.label(from) + ' - ' + end;
  }

  function sum(list) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += (list[i] || 0);
    return total;
  }

  function indexOfExtreme(list, wantMax) {
    var best = -1;
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] !== 'number' || isNaN(list[i])) continue;
      if (best === -1 || (wantMax ? list[i] > list[best] : list[i] < list[best])) best = i;
    }
    return best;
  }

  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : many); }

  /* A change that rounds to zero still comes back signed ('-0.0%', '+0.0 pts'); a signed zero reads as an error on a tile. */
  function signless(d) {
    var c = d && typeof d.label === 'string' ? d.label.charAt(0) : '';
    if ((c === '-' || c === '+') && parseFloat(d.label.slice(1)) === 0) return { value: d.value, label: d.label.slice(1), dir: d.dir };
    return d;
  }
  function deltaOf(cur, prev) { return signless(MK.fmt.delta(cur, prev)); }
  function pointsOf(cur, prev) { return signless(MK.fmt.points(cur, prev)); }

  function sentence(parts) {
    var out = parts.filter(Boolean).join('; ');
    return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
  }

  /* 95% not 95.0%, but 1.5% stays 1.5% */
  function pctShort(x) { return fmt.pct(x, Math.abs(x * 100 - Math.round(x * 100)) < 0.05 ? 0 : 1); }

  function bandText(band) { return band ? 'Target ' + pctShort(band[0]) + ' to ' + pctShort(band[1]) : null; }

  function isAllowed(pageId) {
    try { return !!MK.router.isAllowed(pageId); } catch (e) { return false; }
  }

  /* onClick for a tile or row: only when the persona may open the target screen */
  function goTo(ctx, pageId, params) {
    if (!isAllowed(pageId)) return null;
    return function () { ctx.navigate(pageId, params); };
  }

  function pageForRoute(route) {
    var base = String(route || '').split('?')[0];
    var pages = MK.router.pages();
    for (var i = 0; i < pages.length; i++) if (pages[i].route === base) return pages[i];
    return null;
  }

  function outletConfig(id) {
    var list = (MK.config && MK.config.outlets) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function aggregatorIds() {
    return ((MK.config && MK.config.channels) || []).filter(function (c) { return c.kind === 'aggregator'; }).map(function (c) { return c.id; });
  }

  /* A channel-attributed measure may only be shown for channels that supply it (DATA-FEASIBILITY.md section 3). */
  function channelSupplies(channelId, fieldKey) {
    return MK.data.can(channelId, fieldKey) !== 'no';
  }

  /* Through which date the uploaded statements actually cover orders of the range - an actual take rate is only
     evidence up to there, never to the end of the filter (API.md section 4.3). */
  function actualThroughText(ce) {
    var at = (ce && ce.actualThrough) || {};
    var parts = ((MK.config && MK.config.channels) || []).filter(function (c) { return c.kind === 'aggregator' && at[c.id]; })
      .map(function (c) { return c.label + ' to ' + dates.label(at[c.id]); });
    return parts.length ? 'Statements cover ' + parts.join(' and ') : '';
  }

  /* which aggregators have a statement inside the range: two periods with different coverage are not comparable */
  function actualCoverage(ce) {
    var at = (ce && ce.actualThrough) || {};
    return Object.keys(at).filter(function (k) { return at[k]; }).sort().join('|');
  }

  function sourceEnd(ids) {
    var tag = ui.sourceTag(ids);
    tag.classList.add('ov-source-end');
    return tag;
  }

  function sourceFlat(ids) {
    var tag = ui.sourceTag(ids);
    tag.classList.add('ov-source-flat');
    return tag;
  }

  /* statement-style list: label on the left (may wrap), figure on the right (never wraps) */
  function statement(rows) {
    return h('div', { 'class': 'ov-lines' }, rows.filter(Boolean).map(function (r) {
      return h('div', { 'class': ['ov-line', r.total ? 'ov-line--total' : ''] },
        h('span', { 'class': 'ov-line__label' }, r.label), h('span', { 'class': 'ov-line__value' }, r.value));
    }));
  }

  /* small line inside a stat tile: icon + text (+ optional leading node such as the estimate badge) */
  function tileLine(lead, content, title) {
    var leadNode = typeof lead === 'string' ? ui.icon(lead, 12) : lead;
    return h('span', { 'class': 'ov-tileline', title: title || null }, leadNode ? h('span', { 'class': 'ov-tileline__lead' }, leadNode) : null, h('span', null, content));
  }

  /* stat tile with extra lines placed above its sparkline */
  function tile(options, lines) {
    var el = ui.statTile(options);
    var spark = el.querySelector('.mk-tile__spark');
    (lines || []).filter(Boolean).forEach(function (line) { el.insertBefore(line, spark); });
    return el;
  }

  /* one block failing (the data layer is tuned in parallel) must not take the cockpit down */
  function block(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[overview] ' + name + ' failed', e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', e && e.message ? e.message : String(e)));
    }
  }

  /* a supporting read that fails degrades its block instead of the page */
  function safe(read, fallback) {
    try { return read(); } catch (e) {
      if (root.console) root.console.error('[overview] data read failed', e);
      return fallback;
    }
  }


  /* ---- Looking ahead: the forecast outlook (Layer 1). The block repaints itself when the reactiveness dial moves and
     asks the trend chart (built later on the page) to redraw its forecast tail; nothing else on the page is touched. */
  function outlookSection(ctx, f, live) {
    if (!MK.forecast || typeof MK.forecast.monthEnd !== 'function') return null;
    var host = h('div', { 'class': 'ov-outlook' });
    var OPT = MK.forecast.OPTIONS || {};
    function effectText(e) { return fmt.pct(Math.abs(e)) + (e < 0 ? ' lower' : ' higher'); }
    function span(e) { return e.from === e.to ? dates.label(e.from, 'EEE d MMM') : dates.label(e.from) + ' to ' + dates.label(e.to); }
    function shortName(id) { var cfg = outletConfig(id); return cfg ? (cfg.short || cfg.name) : id; }
    function dishNote(e) {
      var ups = e.dishes.filter(function (x) { return x.mult > 1; }).map(function (x) { return x.name; });
      var downs = e.dishes.filter(function (x) { return x.mult < 1; });
      var parts = [];
      if (ups.length) parts.push(ups.slice(0, 3).join(', ') + (ups.length > 3 ? ' and ' + plural(ups.length - 3, 'more') : '') + ' up');
      if (downs.length) parts.push(plural(downs.length, 'dish', 'dishes') + ' down');
      return parts.join('; ');
    }
    function listOf(names) { return names.length < 3 ? names.join(' and ') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]; }

    function paint() {
      ui.clear(host);
      var me = safe(function () { return MK.forecast.monthEnd(f); }, null);
      if (!me || !me.available) return;
      var acc = safe(function () { return MK.forecast.accuracy(f); }, null) || {};
      var up = safe(function () { return MK.forecast.upcoming(f); }, []) || [];
      var s = me.settings || MK.forecast.settings();
      var tiles = [];

      /* the month-end projection, with the plain run-rate as the figure everybody would otherwise reach for */
      var past = (MK.config.events || []).filter(function (e) { return e.kind !== 'weather' && e.to >= me.from && e.from <= MK.calendar.dataEnd && e.to <= MK.calendar.dataEnd; }).map(function (e) { return e.label; });
      var why = '';
      if (me.runRate < me.projected && past.length) why = ' - the days so far carried ' + listOf(past) + ', which the forecast does not expect to repeat';
      else if (me.runRate > me.projected && me.events.length) why = ' - ' + listOf(me.events) + ' is still to come';
      tiles.push(tile({
        label: 'Projected month-end net sales, ' + me.label, icon: 'chart', value: fmt.inr(me.projected),
        delta: me.lastMonth && me.lastMonth.netSales ? deltaOf(me.projected, me.lastMonth.netSales) : null, deltaNote: me.lastMonth ? 'vs ' + me.lastMonth.label : null,
        sub: fmt.inr(me.toDate) + ' to date + ' + fmt.inr(me.remaining) + ' forecast for the ' + plural(me.daysLeft, 'day', 'days') + ' left',
        title: me.method
      }, [
        tileLine('scale', 'Likely range ' + fmt.inr(me.lo) + ' to ' + fmt.inr(me.hi), '80% band: eight months in ten would land inside it, judged on the misses of the last ' + (acc.weeks || 8) + ' weeks of forecasts'),
        tileLine(null, 'A plain run-rate would say ' + fmt.inr(me.runRate) + why, 'Net sales to date divided by the days gone, times the days in the month')
      ]));

      /* measured accuracy: the ex-ante backtest, with the baseline the model has to beat */
      var weekly = typeof acc.weeklyAccuracy === 'number' ? acc.weeklyAccuracy : null;
      tiles.push(tile({
        label: 'Forecast accuracy, last ' + (acc.weeks || 8) + ' weeks', icon: 'check-circle', value: weekly === null ? '-' : fmt.pct(weekly),
        sub: weekly === null ? 'Not enough history yet' : 'week by week; ' + fmt.pct(acc.accuracy) + ' outlet by outlet, day by day',
        title: 'Each of the last ' + (acc.weeks || 8) + ' weeks was forecast from the data available on the Sunday before it and compared with what happened. Accuracy = 1 - WAPE, the absolute misses as a share of actual sales.'
      }, [
        typeof acc.bias === 'number' ? tileLine('scale', 'Runs ' + fmt.pct(Math.abs(acc.bias), 1) + (acc.bias < 0 ? ' low' : ' high') + ' on average', 'Bias: the signed misses as a share of actual sales. A steady lean is something a planner can correct for; a growing one says the level has moved.') : null,
        typeof acc.weeklyNaiveAccuracy === 'number' ? tileLine(null, 'Same-day-last-week guess: ' + fmt.pct(acc.weeklyNaiveAccuracy) + ' by week', 'The baseline every forecast has to beat: take last week\'s figure for the same weekday') : null
      ]));

      /* the calendar ahead */
      var first = up[0], groups = [];
      if (first) {
        var byEff = {}, order = [];
        first.byOutlet.forEach(function (x) { var k = String(Math.round(x.effect * 100)); if (!byEff[k]) { byEff[k] = []; order.push(k); } byEff[k].push(shortName(x.outletId)); });
        groups = order.map(function (k) { return byEff[k].join(', ') + ' ' + (+k > 0 ? '+' : '') + k + '%'; });
      }
      tiles.push(tile({
        label: 'Coming up', icon: 'calendar', value: first ? first.label : 'Nothing marked',
        sub: first ? span(first) + ': net sales ' + effectText(first.effect) + ' than a plain ' + (first.days > 1 ? 'week' : 'day') : 'No festival, holiday or sport in the event calendar for the next six weeks',
        title: first ? 'The expected effect of the event calendar entry on the outlets in view; the weekday pattern applies on top' : null
      }, [
        first && groups.length > 1 ? tileLine(null, groups.join('; ')) : null,
        first && first.dishes && first.dishes.length ? tileLine('dish', dishNote(first), 'The dishes the calendar entry moves; the purchase suggestions in the factory follow the same shift') : null,
        up[1] ? tileLine('calendar', 'Then ' + up[1].label + ', ' + span(up[1]) + ': ' + effectText(up[1].effect)) : null
      ]));

      /* the dial: one setting, shown next to the figures it moves, scored on the same backtest */
      var seg = ui.segmented({ size: 'sm', ariaLabel: 'Forecast reactiveness', value: s.weeks,
        options: (OPT.reactiveness || []).map(function (o) { return { value: o.value, label: o.label + ' - ' + o.value + ' wk' }; }),
        onChange: function (v) {
          MK.forecast.setSettings({ weeks: v }); paint();
          if (MK.latency) MK.latency.veil(host, { profile: 'recalc' });   /* the tiles; the chart tail veils itself on update() */
          if (typeof live.refreshTrend === 'function') live.refreshTrend();
        } });
      var cur = (OPT.reactiveness || []).filter(function (o) { return o.value === s.weeks; })[0];
      var scored = (acc.bySetting || []).map(function (x) { return x.label + ' ' + fmt.pct(x.weeklyAccuracy); }).join(', ');
      var dial = h('div', { 'class': 'ov-dial' },
        h('span', { 'class': 'ov-dial__label' }, ui.icon('refresh', 14), 'Forecast reactiveness'),
        seg,
        h('span', { 'class': 'ov-dial__note' }, (cur ? cur.label + ' ' + cur.caption + '. ' : '') + (scored ? 'On the last ' + (acc.weeks || 8) + ' weeks each setting would have scored ' + scored + ' by week.' : '')));
      ui.append(host,
        h('div', { 'class': 'ov-outlook__tiles' }, tiles),
        h('div', { 'class': 'ov-strip' },
          h('div', { 'class': 'ov-stripnotes' }, dial,
            h('div', { 'class': 'ov-footnote' }, 'Forecast = the level of the last ' + s.weeks + ' weeks x the weekday pattern x the event calendar (festivals, holidays and sport; never the weather). ' +
              'The band and the accuracy come from forecasting each of the last ' + (acc.weeks || 8) + ' weeks from the Sunday before it. ' +
              'The dial moves every forecast figure here, the purchase suggestions in the factory and the month-end note on bills under review.')),
          sourceFlat(['petpooja', 'forecast'])));
    }
    paint();
    return h('div', { 'class': 'ov-section' },
      ui.sectionTitle('Looking ahead', 'Where ' + dates.monthLabel(dates.monthKey(MK.calendar.today), true) + ' is heading for the outlets in view, how the forecasts have been doing, and what the calendar holds.'),
      host);
  }

  /* Cost ratios: the latest complete month the selected period touches, else the month to date. */
  function costMonthFor(unitSel, from, to) {
    var trend = MK.finance.pnlTrend(unitSel);
    var rows = (trend && trend.rows) || [];
    var mFrom = from.slice(0, 7), mTo = to.slice(0, 7);
    var inRange = rows.filter(function (r) { return r.monthKey >= mFrom && r.monthKey <= mTo; });
    var complete = inRange.filter(function (r) { return !r.partial; });
    var pick = complete.length ? complete[complete.length - 1] : (inRange.length ? inRange[inRange.length - 1] : rows[rows.length - 1]);
    if (!pick) return null;
    return {
      monthKey: pick.monthKey, partial: !!pick.partial, label: pick.label,
      caption: pick.label + (pick.partial ? ', month to date' : ', complete month'),
      history: rows.filter(function (r) { return r.monthKey <= pick.monthKey; })
    };
  }

  /* --------------------------------------------- approvals and payments */

  function flowSection(ctx) {
    var tiles = [];
    var payables = MK.finance.payables();

    var counts = MK.workflow.bill.counts();
    var mayApprove = MK.session.can('bill.approve');
    var stages = ['SUBMITTED', 'UNDER_REVIEW'].map(function (state) {
      var c = counts.byStatus && counts.byStatus[state];
      return c && c.count ? fmt.num(c.count) + ' ' + ui.statusInfo(state).label.toLowerCase() : null;
    }).filter(Boolean);
    tiles.push(tile({
      label: 'Bills awaiting approval', icon: 'receipt', value: fmt.num(counts.awaitingApproval),
      sub: counts.awaitingApproval ? fmt.inr(counts.awaitingApprovalPayable) + ' payable' + (stages.length ? ' - ' + stages.join(', ') : '') : 'The approval queue is clear',
      onClick: goTo(ctx, 'approvals-bills')
    }, [counts.awaitingApproval ? (mayApprove.ok ? tileLine('check', 'Yours to review and decide') : tileLine('lock', 'Approval: ' + mayApprove.reason, 'Roles and segregation of duties are enforced by the workflow')) : null]));

    var inTransit = payables.inTransit && payables.inTransit.count ? payables.inTransit : null;
    tiles.push(tile({
      label: 'Payables due in 7 days', icon: 'calendar', value: fmt.inr(payables.dueIn7Days.amount),
      sub: plural(payables.dueIn7Days.count, 'bill', 'bills') + ' falling due, of ' + fmt.inr(payables.total) + ' open in all',
      tone: payables.overdue.count ? 'warn' : null,
      onClick: goTo(ctx, 'approvals-payables')
    }, [
      payables.overdue.count ? tileLine('clock', fmt.inr(payables.overdue.amount) + ' already past due (' + plural(payables.overdue.count, 'bill', 'bills') + ')') : tileLine('check', 'Nothing is past due'),
      inTransit ? tileLine('bank', fmt.inr(inTransit.amount) + ' released to the bank, UTR awaited',
        'The money has left the account, so these bills count as neither due nor overdue until the payer records the UTR') : null
    ]));

    var pending = MK.workflow.batch.list({ status: 'PENDING_RELEASE' });
    var batchCounts = MK.workflow.batch.counts();
    /* a persona with a partial scope (outlet manager) only ever sees batches made purely of its own bills: hide the empty tile */
    if (pending.length || MK.session.seesAllUnits()) {
      var first = pending[0];
      var mayRelease = first ? MK.workflow.batch.can('release', first) : null;
      var batchSub = 'Nothing is waiting for release';
      if (pending.length === 1) batchSub = first.number + ' - ' + plural(first.billIds.length, 'bill', 'bills') + (first.submittedAt ? ', submitted ' + dates.label(first.submittedAt.slice(0, 10)) : '');
      else if (pending.length > 1) batchSub = plural(pending.length, 'batch', 'batches') + ', ' + plural(sum(pending.map(function (b) { return b.billIds.length; })), 'bill', 'bills');
      tiles.push(tile({
        label: pending.length > 1 ? 'Payment batches awaiting release' : 'Payment batch awaiting release', icon: 'wallet',
        value: pending.length ? fmt.inr(sum(pending.map(function (b) { return b.total; }))) : fmt.num(pending.length),
        sub: batchSub, tone: pending.length ? 'warn' : null,
        onClick: goTo(ctx, 'approvals-payments')
      }, [
        mayRelease ? (mayRelease.ok ? tileLine('check', 'Yours to release or reject') : tileLine('lock', 'Release: ' + mayRelease.reason, 'Roles and segregation of duties are enforced by the workflow')) : null,
        batchCounts.RELEASED ? tileLine('external', plural(batchCounts.RELEASED, 'released batch', 'released batches') + ' still waiting for UTRs') : null
      ]));
    }

    return h('div', { 'class': 'ov-section' },
      ui.sectionTitle('Approvals and payments', 'The queue as it stands on ' + dates.label(payables.asOf, 'd MMM yyyy') + ', for every unit you can see - the date and outlet filters do not apply here'),
      h('div', { 'class': 'ov-flow ov-flow--' + tiles.length }, tiles),
      sourceFlat('erp'));
  }

  /* ------------------------------------------------------ needs attention */

  function insightNode(ins, sev) {
    var page = pageForRoute(ins.route);
    var open = page && isAllowed(page.id);
    var metric = ins.metric && typeof fmt[ins.metric.format] === 'function' ? fmt[ins.metric.format](ins.metric.value) : null;
    var attrs = { 'class': 'ov-ins ov-ins--' + sev.tone };
    if (open) attrs.href = ins.route;
    return h(open ? 'a' : 'div', attrs,
      h('span', { 'class': 'ov-ins__icon' }, ui.icon(sev.icon, 16), h('span', { 'class': 'mk-sr' }, sev.label + ': ')),
      h('span', { 'class': 'ov-ins__main' },
        h('span', { 'class': 'ov-ins__title' }, ins.title),
        h('span', { 'class': 'ov-ins__detail', title: ins.detail }, ins.detail),
        h('span', { 'class': 'ov-ins__meta' },
          h('span', { 'class': 'ov-ins__area' }, ins.area),
          ins.period ? h('span', null, ins.period) : null,
          open ? h('span', { 'class': 'ov-ins__go' }, 'Open ' + (page.navLabel || page.title), ui.icon('arrow-right', 12)) : null)),
      metric ? h('span', { 'class': 'ov-ins__metric' },
        h('span', { 'class': 'ov-ins__value' }, metric),
        h('span', { 'class': 'ov-ins__label' }, ins.metric.label)) : null);
  }

  function attentionCard(insights, counts, filters, sources) {
    var shown = insights.slice(0, INSIGHT_LIMIT);
    var body;
    if (!shown.length) {
      body = ui.emptyState('Nothing needs attention', 'No rule fired for this period and scope.', { icon: 'check-circle', compact: true });
    } else {
      body = h('div', { 'class': 'ov-attn' }, SEVERITIES.map(function (sev) {
        var items = shown.filter(function (i) { return i.severity === sev.id; });
        if (!items.length) return null;
        return h('div', { 'class': 'ov-attn__group' },
          h('div', { 'class': 'ov-attn__head' }, ui.chip(sev.label, sev.tone, { icon: sev.icon }), h('span', { 'class': 'mk-small mk-muted' }, plural(items.length, 'item', 'items'))),
          items.map(function (ins) { return insightNode(ins, sev); }));
      }));
    }
    var win = MK.insights.window(filters);
    var tally = SEVERITIES.map(function (sev) { return counts[sev.id] ? fmt.num(counts[sev.id]) + ' ' + (counts[sev.id] > 1 && sev.many ? sev.many : sev.label.toLowerCase()) : null; }).filter(Boolean).join(', ');
    return ui.card({
      title: 'Needs attention', className: 'ov-attncard',
      subtitle: shown.length
        ? 'Top ' + fmt.num(shown.length) + ' of ' + plural(counts.total, 'finding', 'findings') + ' (' + tally + '), ranked by severity and rupee impact - each opens the screen that explains it'
        : null,
      body: body,
      footer: [
        h('div', { 'class': 'ov-footnote' }, 'Performance rules look at ' + win.label + ' so that a short filter still has enough history; queue items (bills, payables, batches, vendors) are as of ' + dates.label(MK.calendar.today, 'd MMM yyyy') + '. ',
          ui.link('See the rules and their thresholds', '#/system/rules', { icon: 'arrow-right' })),
        sourceFlat(sources)
      ]
    });
  }

  /* ------------------------------------------------------------ sales view */

  function renderSales(rootEl, ctx) {
    var st = ctx.state, f = ctx.filters;
    var from = f.from || MK.calendar.dataStart, to = f.to || MK.calendar.dataEnd;
    var unitSel = f.outletIds && f.outletIds.length ? f.outletIds : 'outlets';
    var aggIds = aggregatorIds();

    var s = MK.data.summary(f);
    if (!s.orders) {
      rootEl.appendChild(ui.card({ body: ui.emptyState('No sales in this selection', 'No completed orders fall inside ' + rangeLabel(from, to, true) + ' for the outlets selected. Widen the date range or clear the outlet filter.', { icon: 'chart' }) }));
      block(rootEl, 'Approvals and payments', function () { return flowSection(ctx); });
      return;
    }

    var hasPrev = !!(s.prev && s.prev.from && s.prev.complete);
    var prevLabel = hasPrev ? 'vs ' + rangeLabel(s.prev.from, s.prev.to) : null;
    var byOutlet = MK.data.breakdown(f, 'outlet');
    var outletRows = byOutlet.rows.filter(function (r) { return r.orders > 0 || r.netSales > 0; });
    var daily = MK.data.series(f, { measure: 'netSales', grain: 'day', by: null });
    var insights = safe(function () { return MK.insights.list(f); }, []);
    var insightCounts = safe(function () { return MK.insights.counts(f); }, { total: insights.length });
    var cm = safe(function () { return costMonthFor(unitSel, from, to); }, null);
    var live = { refreshTrend: null };   /* the outlook block asks the trend chart to redraw its forecast tail */

    /* ---- hero + KPI tiles */
    block(rootEl, 'Headline figures', function () {
      var bestIdx = indexOfExtreme(daily.total, true), worstIdx = indexOfExtreme(daily.total, false);
      var leader = outletRows.slice().sort(function (a, b) { return b.netSales - a.netSales; })[0];
      var facts = [
        { label: 'Average per day', value: fmt.inr(s.netSalesPerDay) },
        daily.buckets.length > 1 && bestIdx > -1 ? { label: 'Best day - ' + dates.label(daily.buckets[bestIdx].key, 'EEE d MMM'), value: fmt.inr(daily.total[bestIdx]) } : null,
        daily.buckets.length > 1 && worstIdx > -1 ? { label: 'Slowest day - ' + dates.label(daily.buckets[worstIdx].key, 'EEE d MMM'), value: fmt.inr(daily.total[worstIdx]) } : null,
        leader && outletRows.length > 1 ? { label: 'Leading outlet - ' + leader.label, value: fmt.inr(leader.netSales) } : null
      ];
      var heroCard = ui.card({
        className: 'ov-herocard',
        body: h('div', { 'class': 'ov-herobody' }, [
          ui.hero({
            label: 'Net sales, ' + rangeLabel(from, to, true),
            value: fmt.inr(s.netSales),
            delta: hasPrev ? deltaOf(s.netSales, s.prev.netSales) : null,
            deltaNote: prevLabel,
            sub: (outletRows.length > 1 ? plural(outletRows.length, 'outlet', 'outlets') : outletRows[0].label) + ' over ' + plural(s.days, 'day', 'days') + ', net of GST and discounts' +
              (hasPrev ? '' : ' - no full preceding period in the data to compare with')
          }),
          statement(facts)
        ]),
        footer: sourceFlat(s.source || 'petpooja')
      });

      /* orders and AOV */
      var ordersDaily = MK.data.series(f, { measure: 'orders', grain: 'day', by: null }).total;
      var aovDaily = MK.data.series(f, { measure: 'aov', grain: 'day', by: null }).total;
      var tiles = [];
      tiles.push(tile({
        label: 'Orders', icon: 'receipt', value: fmt.num(s.orders),
        delta: hasPrev ? deltaOf(s.orders, s.prev.orders) : null,
        sub: fmt.num(Math.round(s.ordersPerDay)) + ' a day', spark: ordersDaily, onClick: goTo(ctx, 'revenue-sales')
      }));
      tiles.push(tile({
        label: 'Average order value', icon: 'coins', value: fmt.inrFull(Math.round(s.aov)),
        delta: hasPrev ? deltaOf(s.aov, s.prev.aov) : null,
        sub: fmt.num(s.itemsPerOrder, 1) + ' items an order', spark: aovDaily, onClick: goTo(ctx, 'revenue-dishes')
      }));

      /* aggregator share of net sales (gross order data, relayed into the POS for every channel) */
      var byChannel = MK.data.breakdown(f, 'channel');
      var aggRows = byChannel.rows.filter(function (r) { return aggIds.indexOf(r.id) !== -1 && channelSupplies(r.id, 'order.subtotal'); });
      var aggShare = s.netSales ? sum(aggRows.map(function (r) { return r.netSales; })) / s.netSales : null;
      var prevTotal = sum(byChannel.rows.map(function (r) { return r.prevNetSales; }));
      var prevAggShare = hasPrev && prevTotal ? sum(aggRows.map(function (r) { return r.prevNetSales; })) / prevTotal : null;
      tiles.push(tile({
        label: 'Aggregator share of sales', icon: 'layers', value: fmt.pct(aggShare),
        delta: prevAggShare !== null ? pointsOf(aggShare, prevAggShare) : null, goodWhen: 'neutral',
        sub: aggRows.map(function (r) { return r.label + ' ' + fmt.pct(r.share); }).join(' - '),
        title: aggRows.map(function (r) { return r.label; }).join(' and ') + ' net sales as a share of all net sales', onClick: goTo(ctx, 'revenue-sales')
      }));

      /* effective take rate: settled statements only, the unsettled tail stays apart and is labelled */
      var ce = MK.data.channelEconomics(f);
      var act = ce.total.actual, est = ce.total.estimated;
      var hasActual = act.orders > 0, hasEstimate = est.orders > 0;
      var prevCe = hasPrev ? MK.data.channelEconomics({ from: s.prev.from, to: s.prev.to, outletIds: f.outletIds }) : null;
      var prevAct = prevCe && prevCe.total.actual.orders > 0 ? prevCe.total.actual : null;
      /* the two periods must rest on the same statements, or the change of rate is a change of coverage */
      var comparable = prevAct && actualCoverage(prevCe) === actualCoverage(ce);
      var gapRule = MK.insights.RULES && MK.insights.RULES.takeRate ? MK.insights.RULES.takeRate.gapPts : null;
      var showsEstimate = false;
      if (hasActual) {
        tiles.push(tile({
          label: 'Aggregator take rate', icon: 'scale', value: fmt.pct(act.effectiveTakeRate),
          delta: comparable ? pointsOf(act.effectiveTakeRate, prevAct.effectiveTakeRate) : null, goodWhen: 'down',
          sub: 'Contract ' + fmt.pct(act.contractedTakeRate) + (ce.ratesAssumed ? ' (assumed)' : ''),
          tone: gapRule !== null && act.effectiveTakeRate - act.contractedTakeRate >= gapRule ? 'warn' : null,
          title: 'Everything the aggregators keep (fees, GST on fees, ads, refunds) as a share of aggregator net sales - settled statements only',
          onClick: goTo(ctx, 'revenue-audit')
        }, [
          tileLine('check', fmt.inr(act.netSales) + ' of sales settled'),
          actualThroughText(ce) ? tileLine('calendar', actualThroughText(ce), 'An actual take rate is evidence only through these dates, not to the end of the selected period') : null,
          hasEstimate ? tileLine(ui.estimateBadge('Not settled'), fmt.inr(est.netSales) + ' left out') : null
        ]));
        showsEstimate = hasEstimate;
      } else if (hasEstimate) {
        tiles.push(tile({
          label: 'Aggregator take rate', icon: 'scale', value: fmt.pct(est.effectiveTakeRate),
          sub: [ui.estimateBadge(), ' at contract terms' + (ce.ratesAssumed ? ' (assumed)' : '')],
          title: 'No statement has been uploaded for this period yet',
          onClick: goTo(ctx, 'revenue-audit')
        }, [tileLine('clock', 'No settled statement in this period - actuals arrive with the weekly upload')]));
        showsEstimate = true;
      } else {
        tiles.push(tile({ label: 'Aggregator take rate', icon: 'scale', value: '-', sub: 'No aggregator orders in this selection' }));
      }

      /* cost ratios: finance works in whole months */
      var pnl = cm ? MK.finance.pnl(unitSel, cm.monthKey) : null;
      if (pnl) {
        var t = pnl.totals, prevT = pnl.prev;
        var prevMonthNote = prevT && prevT.months && prevT.months.length ? 'vs ' + dates.monthLabel(prevT.months[prevT.months.length - 1]) : null;
        var fc = MK.finance.foodCost(cm.monthKey, unitSel);
        tiles.push(tile({
          label: 'Food cost %', icon: 'dish', value: fmt.pct(t.foodCostPct),
          delta: prevT ? pointsOf(t.foodCostPct, prevT.foodCostPct) : null, deltaNote: prevMonthNote, goodWhen: 'down',
          sub: cm.caption, spark: cm.history.map(function (r) { return r.foodCostPct; }),
          tone: fc && fc.totals && fc.totals.redFlag ? 'critical' : null,
          title: 'Actual food cost (factory transfers, local purchases and variance) as a share of net sales',
          onClick: goTo(ctx, 'costs-cogs')
        }, [fc && fc.totals ? tileLine(null, 'Recipe ' + fmt.pct(fc.totals.theoreticalPct) + ', variance ' + pointsOf(fc.totals.actualPct, fc.totals.theoreticalPct).label) : null]));
        tiles.push(tile({
          label: 'Outlet EBITDA %', icon: 'calculator', value: fmt.pct(t.ebitdaPct),
          delta: prevT ? pointsOf(t.ebitdaPct, prevT.ebitdaPct) : null, deltaNote: prevMonthNote,
          sub: cm.caption, spark: cm.history.map(function (r) { return r.ebitdaPct; }),
          title: 'Outlet-level EBITDA before head office and factory absorption, as a share of net sales',
          onClick: goTo(ctx, 'costs-unit-economics')
        }, [t.estimatedPart > 0 ? tileLine(ui.estimateBadge(), fmt.inr(t.estimatedPart) + ' of costs', 'Aggregator costs of the unsettled weeks are in this margin at contract rates until the weekly statements arrive') : tileLine('check', fmt.inr(t.ebitda) + ' on ' + fmt.inr(t.netSales) + ' of sales')]));
        if (t.estimatedPart > 0) showsEstimate = true;
      }

      var sources = ['petpooja', 'swiggy_annexure', 'zomato_settlement', 'erp'];
      if (showsEstimate) sources.push('estimate');
      var notes = [];
      if (pnl) {
        notes.push(h('div', { 'class': 'ov-footnote' }, pnl.period.partial
          ? 'Cost ratios: ' + pnl.period.note + '.'
          : 'Cost ratios are for ' + cm.label + ', the latest complete month the selected period touches.'));
      }
      /* the range runs past the last Swiggy annexure: say so where the net sales figures are (API.md section 4.5) */
      if (s.provisional) {
        notes.push(h('div', { 'class': 'ov-footnote', title: s.provisional.note },
          'Swiggy net sales from ' + dates.label(s.provisional.swiggyDiscountSplitFrom) +
          ' are as relayed to the POS: the restaurant-funded discount split is confirmed with the weekly annexure.'));
      }
      return h('div', { 'class': 'ov-section' },
        ui.grid([4, 8], [heroCard, h('div', { 'class': 'ov-kpis' }, tiles)], { className: 'ov-top' }),
        h('div', { 'class': 'ov-strip' },
          notes.length ? h('div', { 'class': 'ov-stripnotes' }, notes) : null,
          sourceFlat(sources)));
    });

    /* ---- looking ahead (forecast, Layer 1) */
    block(rootEl, 'Looking ahead', function () { return outlookSection(ctx, f, live); });

    /* ---- approvals and payments */
    block(rootEl, 'Approvals and payments', function () { return flowSection(ctx); });

    /* ---- trend + channel mix */
    block(rootEl, 'Sales trend and channel mix', function () {
      st.group = st.group || 'total';

      function markersFor(buckets) {
        var labelOf = {}, first = buckets[0].key, last = buckets[buckets.length - 1].key;
        buckets.forEach(function (b) { labelOf[b.key] = b.label; });
        var markers = [], running = [];
        (MK.config.events || []).forEach(function (e) {
          if (!e.marker || e.to < first || e.from > last) return;
          if (e.from === e.to) { if (labelOf[e.from]) markers.push({ label: e.label, atLabel: labelOf[e.from], kind: e.kind, single: true }); return; }
          if (dates.diffDays(e.from, e.to) < SHORT_EVENT_DAYS) {
            /* a festival of two or three days gets one marker, on its first day inside the range */
            var at = e.from >= first ? e.from : first;
            if (labelOf[at]) markers.push({ label: e.label, atLabel: labelOf[at], kind: e.kind });
            return;
          }
          var placed = false;
          if (e.from >= first && labelOf[e.from]) { markers.push({ label: e.label + ' begins', atLabel: labelOf[e.from], kind: e.kind }); placed = true; }
          if (e.to <= last && labelOf[e.to]) { markers.push({ label: e.label + ' ends', atLabel: labelOf[e.to], kind: e.kind }); placed = true; }
          if (!placed) running.push(e.label);
        });
        var dropped = 0;
        if (markers.length > MARKER_LIMIT) {
          var kept = markers.filter(function (m) { return !(m.single && m.kind === 'weather'); });
          dropped = markers.length - kept.length;
          markers = kept;
        }
        return { markers: markers.map(function (m) { return { label: m.label, atLabel: m.atLabel }; }), running: running, dropped: dropped };
      }

      /* The hero already carries the period total, its best and its slowest day: the chart's job is the shape of the
         period, so the takeaway states the weekly rhythm and the direction of travel inside it. */
      function takeaway(ser, group) {
        if (group === 'total') {
          if (ser.buckets.length < 2) return 'One business day in the selection - widen the date range to see the daily pattern.';
          var parts = [];
          var we = [], wd = [];
          ser.buckets.forEach(function (b, i) { (WEEKEND_DOWS.indexOf(dates.dow(b.key)) !== -1 ? we : wd).push(ser.total[i] || 0); });
          if (we.length && wd.length) {
            var weAvg = sum(we) / we.length, wdAvg = sum(wd) / wd.length;
            if (wdAvg > 0) parts.push('Saturdays and Sundays average ' + fmt.inr(weAvg) + ', ' + fmt.pct(Math.abs(weAvg / wdAvg - 1)) + (weAvg >= wdAvg ? ' above' : ' below') + ' a weekday');
          }
          var half = Math.floor(ser.buckets.length / 2);
          if (half >= 2) {
            var firstAvg = sum(ser.total.slice(0, half)) / half, lastAvg = sum(ser.total.slice(ser.buckets.length - half)) / half;
            if (firstAvg > 0) parts.push('the last ' + plural(half, 'day', 'days') + ' average ' + fmt.inr(lastAvg) + ', ' +
              fmt.pct(Math.abs(lastAvg / firstAvg - 1)) + (lastAvg >= firstAvg ? ' above' : ' below') + ' the first ' + plural(half, 'day', 'days'));
          }
          if (!parts.length) {
            var best = indexOfExtreme(ser.total, true);
            if (best > -1) parts.push('best day ' + dates.label(ser.buckets[best].key, 'EEE d MMM') + ' at ' + fmt.inr(ser.total[best]));
          }
          return sentence(parts);
        }
        var totals = ser.series.map(function (x) { return { id: x.id, label: x.label, value: sum(x.values) }; }).sort(function (a, b) { return b.value - a.value; });
        var all = sum(totals.map(function (x) { return x.value; }));
        if (!totals.length || !all) return '';
        var lead = totals[0].label + ' leads with ' + fmt.pct(totals[0].value / all) + ' of net sales' +
          (totals[1] ? ', then ' + totals[1].label + ' at ' + fmt.pct(totals[1].value / all) : '');
        /* which member gained or lost the most share against the preceding period of the same length */
        var mover = null;
        if (hasPrev) {
          var rows = safe(function () { return MK.data.breakdown(f, group).rows; }, []);
          var prevAll = sum(rows.map(function (r) { return r.prevNetSales || 0; }));
          if (prevAll) {
            rows.forEach(function (r) {
              var shift = (r.share || 0) - (r.prevNetSales || 0) / prevAll;
              if (!mover || Math.abs(shift) > Math.abs(mover.shift)) mover = { label: r.label, shift: shift, share: r.share, prevShare: (r.prevNetSales || 0) / prevAll };
            });
          }
        }
        if (mover && Math.abs(mover.shift) >= 0.005) {
          lead += '; ' + mover.label + ' moved the most, ' + pointsOf(mover.share, mover.prevShare).label + ' of share against the preceding period';
        }
        return lead;
      }

      function trendSpec(group) {
        var by = group === 'total' ? null : group;
        var ser = by ? MK.data.series(f, { measure: 'netSales', grain: 'day', by: by }) : daily;
        /* the total view carries the forecast to month-end when the period runs up to the latest data */
        var fcd = !by && to === MK.calendar.dataEnd && MK.forecast ? safe(function () { return MK.forecast.daily(f); }, null) : null;
        if (fcd && !fcd.days.length) fcd = null;
        var buckets = fcd ? ser.buckets.concat(fcd.days.map(function (d) { return { key: d.date, label: d.label }; })) : ser.buckets;
        var mk = markersFor(buckets);
        var data = { labels: buckets.map(function (b) { return b.label; }), labelHeader: 'Business day', markers: mk.markers };
        if (by) {
          /* net sales by channel come from the POS relay for every channel; keep only members whose gross order data is supplied */
          var members = ser.series.filter(function (x) { return by !== 'channel' || channelSupplies(x.id, 'order.subtotal'); });
          data.series = members.map(function (x) { return { id: x.id, name: x.label, values: x.values }; });
          data.colourBy = by;
          data.showTotal = true;
        } else {
          data.values = fcd ? ser.total.concat(fcd.days.map(function (d) { return d.value; })) : ser.total;
          data.name = 'Net sales';
          if (fcd) {
            var pad = ser.buckets.map(function () { return null; });
            data.forecast = { fromIndex: ser.buckets.length, label: 'Forecast', bandLabel: '80% band',
              lo: pad.concat(fcd.days.map(function (d) { return d.lo; })), hi: pad.concat(fcd.days.map(function (d) { return d.hi; })) };
          }
        }
        var notes = [];
        if (fcd) notes.push('Dashed: the forecast to ' + dates.label(fcd.to) + ' with its 80% band - the level of the last ' + fcd.settings.weeks + ' weeks x the weekday pattern x the event calendar; the band comes from the last 8 weeks of forecast misses.');
        if (mk.running.length) notes.push('Running through the whole period: ' + mk.running.join(', ') + '.');
        if (mk.dropped) notes.push(plural(mk.dropped, 'single-day weather marker is', 'single-day weather markers are') + ' left out at this range; shorten the period to see them.');
        var hours = (MK.config && MK.config.hours) || [];
        if (hours.length) notes.push('A business day runs from the ' + hours[0].label + ' hour through the ' + hours[hours.length - 1].label + ' hour of the next morning.');
        return { data: data, subtitle: takeaway(ser, group), note: notes.join(' ') };
      }

      var spec = trendSpec(st.group);
      var trend = MK.charts.mount(null, {
        id: 'ov-trend', kind: 'line', title: 'Daily net sales', subtitle: spec.subtitle, height: 280, format: 'inr',
        data: spec.data, note: spec.note,
        controls: [{ id: 'group', label: 'Group by', value: st.group, options: [{ value: 'total', label: 'Total' }, { value: 'channel', label: 'By channel' }, { value: 'medium', label: 'By medium' }] }],
        onControl: function (id, value) { st.group = value; live.refreshTrend(); }
      });
      var trendSource = sourceEnd(spec.data.forecast ? [daily.source || 'petpooja', 'forecast'] : (daily.source || 'petpooja'));
      trend.el.appendChild(trendSource);
      live.refreshTrend = function () {
        var next = trendSpec(st.group);
        trend.update(next);
        var tag = sourceEnd(next.data.forecast ? [daily.source || 'petpooja', 'forecast'] : (daily.source || 'petpooja'));
        trend.el.replaceChild(tag, trendSource); trendSource = tag;
      };

      var mixEl;
      if (outletRows.length > 1) {
        var m = MK.data.matrix(f, 'outlet', 'channel', 'netSales');
        var colIdx = [];
        m.cols.forEach(function (c, j) { if (channelSupplies(c.id, 'order.subtotal')) colIdx.push(j); });
        var dep = m.rows.map(function (r, i) {
          var agg = sum(colIdx.filter(function (j) { return aggIds.indexOf(m.cols[j].id) !== -1; }).map(function (j) { return m.values[i][j]; }));
          return { label: r.label, share: m.rowTotals[i] ? agg / m.rowTotals[i] : 0 };
        }).sort(function (a, b) { return b.share - a.share; });
        var mix = MK.charts.mount(null, {
          id: 'ov-mix', kind: 'hstackedBar', title: 'Channel mix by outlet', height: 280, format: 'inr',
          subtitle: dep[0].label + ' leans most on aggregators (' + fmt.pct(dep[0].share) + ' of its net sales), ' + dep[dep.length - 1].label + ' least (' + fmt.pct(dep[dep.length - 1].share) + ')',
          data: {
            categories: m.rows.map(function (r) { return r.short || r.label; }), categoryHeader: 'Outlet', colourBy: 'channel', percent: true,
            series: colIdx.map(function (j) { return { id: m.cols[j].id, name: m.cols[j].label, values: m.rows.map(function (r, i) { return m.values[i][j]; }) }; })
          }
        });
        mix.el.appendChild(sourceEnd(m.source || 'petpooja'));
        mixEl = mix.el;
      } else {
        /* one outlet in view: a mix by outlet would be a single bar, so show how the mix moves over time (weeks, or months on a long range) */
        var mixGrain = 'week';
        var wk = MK.data.series(f, { measure: 'netSales', grain: mixGrain, by: 'channel' });
        if (wk.buckets.length > MIX_BUCKET_LIMIT) { mixGrain = 'month'; wk = MK.data.series(f, { measure: 'netSales', grain: mixGrain, by: 'channel' }); }
        var members = wk.series.filter(function (x) { return channelSupplies(x.id, 'order.subtotal'); });
        var tot = members.map(function (x) { return { id: x.id, label: x.label, value: sum(x.values) }; });
        var all = sum(tot.map(function (x) { return x.value; }));
        var aggTot = tot.filter(function (x) { return aggIds.indexOf(x.id) !== -1; }).sort(function (a, b) { return b.value - a.value; });
        var weekly = MK.charts.mount(null, {
          id: 'ov-mix-time', kind: 'hstackedBar', title: mixGrain === 'week' ? 'Channel mix by week' : 'Channel mix by month', height: 280, format: 'inr',
          subtitle: all ? 'Aggregators bring ' + fmt.pct(sum(aggTot.map(function (x) { return x.value; })) / all) + ' of ' + outletRows[0].label + ' net sales' +
            (aggTot[0] ? '; ' + aggTot[0].label + ' is the larger at ' + fmt.pct(aggTot[0].value / all) : '') : '',
          data: {
            categories: wk.buckets.map(function (b) { return b.label; }), categoryHeader: mixGrain === 'week' ? 'Week' : 'Month', colourBy: 'channel', percent: true,
            series: members.map(function (x) { return { id: x.id, name: x.label, values: x.values }; })
          },
          note: mixGrain === 'week' ? 'Weeks start on Monday; the first and last week may be partial.' : 'The first and last month may be partial.'
        });
        weekly.el.appendChild(sourceEnd(wk.source || 'petpooja'));
        mixEl = weekly.el;
      }
      return ui.grid([8, 4], [trend.el, mixEl], { className: 'ov-charts' });
    });

    /* ---- outlet scorecard */
    block(rootEl, 'Outlet scorecard', function () {
      var m = MK.data.matrix(f, 'outlet', 'channel', 'netSales');
      var aggCols = [];
      m.cols.forEach(function (c, j) { if (aggIds.indexOf(c.id) !== -1 && channelSupplies(c.id, 'order.subtotal')) aggCols.push(j); });
      var rowIndex = {};
      m.rows.forEach(function (r, i) { rowIndex[r.id] = i; });

      var sparkFrom = dates.max(MK.calendar.dataStart, dates.addDays(to, -(SPARK_DAYS - 1)));
      var sparkDays = dates.diffDays(sparkFrom, to) + 1;
      var sparkSeries = {};
      MK.data.series({ from: sparkFrom, to: to, outletIds: f.outletIds }, { measure: 'netSales', grain: 'day', by: 'outlet' }).series
        .forEach(function (x) { sparkSeries[x.id] = x.values; });

      var byUnit = {};
      insights.forEach(function (ins) { if (ins.unitId) (byUnit[ins.unitId] = byUnit[ins.unitId] || []).push(ins); });

      var estimatedPart = 0;
      var rows = outletRows.map(function (r) {
        var cfg = outletConfig(r.id) || {};
        var t = cm ? MK.finance.pnl(r.id, cm.monthKey).totals : {};
        var own = byUnit[r.id] || [];
        var crit = own.filter(function (i) { return i.severity === 'critical'; });
        var warn = own.filter(function (i) { return i.severity === 'warning'; });
        var status = crit.length ? 'RISK' : (warn.length ? 'WATCH' : 'OK');
        var lead = crit[0] || warn[0];
        var i = rowIndex[r.id];
        var agg = i === undefined ? null : sum(aggCols.map(function (j) { return m.values[i][j]; }));
        estimatedPart += t.estimatedPart || 0;
        return {
          id: r.id, outlet: r.label, place: cfg.city || cfg.region || '',
          netSales: r.netSales, growth: hasPrev ? deltaOf(r.netSales, r.prevNetSales) : null,
          orders: r.orders, aov: r.aov, aggShare: agg === null || !r.netSales ? null : agg / r.netSales,
          foodCostPct: t.foodCostPct, ebitdaPct: t.ebitdaPct, trend: sparkSeries[r.id] || [],
          status: status,
          statusNote: lead ? lead.title + (crit.length + warn.length > 1 ? ' (+' + fmt.num(crit.length + warn.length - 1) + ' more)' : '') : 'No critical or warning finding for this outlet'
        };
      });

      var columns = [
        { key: 'outlet', label: 'Outlet', render: ui.cells.twoLine('place', { maxWidth: 150 }), sortable: true },
        { key: 'netSales', label: 'Net sales', format: 'inr', render: ui.cells.bar(null, '--series-1') },
        { key: 'growth', label: 'Change', align: 'right', render: ui.cells.delta('up'), title: prevLabel || 'No full preceding period in the data' },
        { key: 'orders', label: 'Orders', format: 'num' },
        { key: 'aov', label: 'AOV', format: 'inrFull', title: 'Average order value' },
        { key: 'aggShare', label: 'Agg. share', format: 'pct', title: aggCols.map(function (j) { return m.cols[j].label; }).join(' and ') + ' share of each outlet\'s net sales' },
        { key: 'foodCostPct', label: 'Food cost', format: 'pct', render: ui.cells.heat(null, null), title: cm ? 'Food cost as a share of net sales, ' + cm.caption : null },
        { key: 'ebitdaPct', label: 'EBITDA', format: 'pct', render: ui.cells.heat(null, null, { scale: 'div', mid: 0 }), title: cm ? 'Outlet EBITDA as a share of net sales, ' + cm.caption : null },
        { key: 'trend', label: fmt.num(sparkDays) + '-day trend', render: ui.cells.spark('--series-1'), sortable: false, title: 'Daily net sales, ' + rangeLabel(sparkFrom, to) },
        { key: 'status', label: 'Status', sortable: true, sortValue: function (row) { return STATUS_RANK[row.status]; },
          render: function (value, row) { return ui.statusChip(value, { title: row.statusNote }); } }
      ];
      var csvColumns = [
        { key: 'outlet', label: 'Outlet' }, { key: 'netSales', label: 'Net sales' },
        { key: 'growth', label: 'Change vs previous period', value: function (row) { return row.growth ? row.growth.value : null; } },
        { key: 'orders', label: 'Orders' }, { key: 'aov', label: 'AOV' }, { key: 'aggShare', label: 'Aggregator share' },
        { key: 'foodCostPct', label: 'Food cost % (' + (cm ? cm.caption : '') + ')' }, { key: 'ebitdaPct', label: 'EBITDA % (' + (cm ? cm.caption : '') + ')' },
        { key: 'status', label: 'Status' }, { key: 'statusNote', label: 'Leading finding' }
      ];
      /* with no full preceding period in the data the change column would be a column of dashes */
      if (!hasPrev) {
        columns = columns.filter(function (c) { return c.key !== 'growth'; });
        csvColumns = csvColumns.filter(function (c) { return c.key !== 'growth'; });
      }

      var allTotals = cm ? MK.finance.pnl(unitSel, cm.monthKey).totals : {};
      var aggAll = sum(aggCols.map(function (j) { return m.colTotals[j]; }));
      var footer = rows.length > 1 ? {
        outlet: plural(rows.length, 'outlet', 'outlets'), netSales: s.netSales,
        growth: hasPrev ? (ui.deltaBadge(deltaOf(s.netSales, s.prev.netSales), 'up') || '') : '',
        orders: s.orders, aov: s.aov, aggShare: s.netSales ? aggAll / s.netSales : null,
        foodCostPct: allTotals.foodCostPct, ebitdaPct: allTotals.ebitdaPct
      } : null;

      var bySales = rows.slice().sort(function (a, b) { return b.netSales - a.netSales; });
      var byMargin = rows.filter(function (r) { return typeof r.ebitdaPct === 'number'; }).sort(function (a, b) { return b.ebitdaPct - a.ebitdaPct; });
      var byFood = rows.filter(function (r) { return typeof r.foodCostPct === 'number'; }).sort(function (a, b) { return b.foodCostPct - a.foodCostPct; });
      var subtitle;
      if (rows.length > 1) {
        subtitle = bySales[0].outlet + ' sells the most (' + fmt.inr(bySales[0].netSales) + ')' +
          (byMargin.length ? '; ' + byMargin[0].outlet + ' earns the best margin (' + fmt.pct(byMargin[0].ebitdaPct) + ') and ' + byMargin[byMargin.length - 1].outlet + ' the thinnest (' + fmt.pct(byMargin[byMargin.length - 1].ebitdaPct) + ')' : '') +
          (byFood.length ? '; food cost is highest at ' + byFood[0].outlet + ' (' + fmt.pct(byFood[0].foodCostPct) + ')' : '');
      } else {
        /* one outlet in view: the figures are already in the tiles above, so the subtitle carries what the row adds - its standing */
        var only = rows[0];
        subtitle = only.status === 'OK'
          ? only.outlet + ': no critical or warning finding in this period.'
          : only.outlet + ' is ' + ui.statusInfo(only.status).label.toLowerCase() + ' - ' + only.statusNote + '.';
      }

      var open = goTo(ctx, 'costs-unit-economics');
      var sources = ['petpooja', 'erp', 'swiggy_annexure', 'zomato_settlement'];
      if (estimatedPart > 0) sources.push('estimate');
      return ui.card({
        title: 'Outlet scorecard', subtitle: subtitle, flush: true, className: 'ov-score',
        actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', onClick: function () { ui.downloadCsv('outlet-scorecard-' + from + '-to-' + to + '.csv', csvColumns, rows); } }),
        body: ui.table({
          columns: columns, rows: rows, sortable: true, footer: footer,
          sort: st.sort || { key: 'netSales', dir: 'desc' }, onSort: function (next) { st.sort = next; },
          onRowClick: open ? function (row) { ctx.navigate('costs-unit-economics', { outlet: row.id }); } : null,
          empty: 'No outlet has sales in this selection'
        }),
        footer: [
          h('div', { 'class': 'ov-footnote' },
            'Sales columns cover ' + rangeLabel(from, to, true) + '; food cost and EBITDA are for ' + (cm ? cm.caption : 'the month') + '. ',
            estimatedPart > 0 ? [ui.estimateBadge('Part estimated'), ' EBITDA includes ' + fmt.inr(estimatedPart) + ' of aggregator costs at contract rates until the weekly statements arrive. '] : null,
            'Status is the most severe finding for the outlet in the list below' + (open ? '; select a row to open the unit economics screen.' : '.')),
          sourceFlat(sources)
        ]
      });
    });

    /* ---- needs attention */
    block(rootEl, 'Needs attention', function () {
      return attentionCard(insights, insightCounts, f, ['petpooja', 'swiggy_annexure', 'zomato_settlement', 'erp']);
    });
  }

  /* ---------------------------------------------------------- factory view */

  function renderFactory(rootEl, ctx) {
    var f = ctx.filters;
    var from = f.from || MK.calendar.dataStart, to = f.to || MK.calendar.dataEnd;
    var range = { from: from, to: to };

    rootEl.appendChild(ui.callout('info', 'Factory view', 'Your scope is the central kitchen, which has no customer sales. This cockpit therefore shows production, supply to the outlets, factory cost and your approvals queue.'));

    var sm = MK.factory.summary(range);
    if (!sm.days) {
      rootEl.appendChild(ui.card({ body: ui.emptyState('No production in this period', 'Nothing was produced or dispatched between ' + rangeLabel(from, to, true) + '. Widen the date range.', { icon: 'factory' }) }));
      block(rootEl, 'Approvals and payments', function () { return flowSection(ctx); });
      return;
    }
    var prev = sm.prev && sm.prev.complete ? sm.prev : null;
    var prevLabel = prev ? 'vs ' + rangeLabel(prev.from, prev.to) : null;
    var targets = sm.targets || {};
    var production = MK.factory.production(range);
    var dispatch = MK.factory.dispatch(range);
    var insights = safe(function () { return MK.insights.list(f); }, []);
    var insightCounts = safe(function () { return MK.insights.counts(f); }, { total: insights.length });

    var costMonths = sm.costMonths || [];
    var completeMonths = costMonths.filter(function (c) { return !c.partial; });
    var costMonth = completeMonths.length ? completeMonths[completeMonths.length - 1] : costMonths[costMonths.length - 1];

    function below(value, band) { return band && value < band[0]; }
    function above(value, band) { return band && value > band[1]; }

    /* ---- hero + KPI tiles */
    block(rootEl, 'Headline figures', function () {
      var servedOutlets = dispatch.outlets.filter(function (o) { return o.dispatchKg > 0; });
      var heroCard = ui.card({
        className: 'ov-herocard',
        body: h('div', { 'class': 'ov-herobody' }, [
          ui.hero({
            label: 'Transfer value dispatched, ' + rangeLabel(from, to, true),
            value: fmt.inr(sm.transferValue),
            delta: prev ? deltaOf(sm.transferValue, prev.transferValue) : null, deltaNote: prevLabel,
            sub: fmt.kg(sm.dispatchKg) + ' to ' + plural(servedOutlets.length, 'outlet', 'outlets') + ' at transfer prices' + (prev ? '' : ' - no full preceding period in the data to compare with')
          }),
          statement([
            { label: 'Indented by the outlets', value: fmt.kg(sm.indentKg) },
            { label: 'Good output after process wastage', value: fmt.kg(sm.outputKg) },
            { label: 'Expiry and QA write-offs (' + fmt.pct(sm.writeOffPct, 2) + ' of production)', value: fmt.kg(sm.writeOffKg, 1) },
            costMonth ? { label: 'Cost per kg, ' + costMonth.label + (costMonth.partial ? ' to date' : ''), value: fmt.inrFull(costMonth.costPerKg, 2) } : null
          ])
        ]),
        footer: sourceFlat(sm.source || 'erp')
      });

      var dailyActual = production.buckets.map(function (b, i) { return sum(production.series.map(function (x) { return x.actual[i]; })); });
      var flagged = production.yieldFlags || [];
      var tiles = [
        tile({
          label: 'Production', icon: 'factory', value: fmt.kg(sm.grossKg), delta: prev ? deltaOf(sm.grossKg, prev.grossKg) : null,
          sub: fmt.kg(sm.kgPerDay) + ' a day', spark: dailyActual, onClick: goTo(ctx, 'factory-production')
        }, [tileLine(null, 'Plan ' + fmt.kg(sm.planKg))]),
        tile({
          label: 'Plan adherence', icon: 'check-circle', value: fmt.pct(sm.planAdherence), delta: prev ? pointsOf(sm.planAdherence, prev.planAdherence) : null,
          sub: bandText(targets.planAdherence), tone: below(sm.planAdherence, targets.planAdherence) ? 'warn' : null, onClick: goTo(ctx, 'factory-production')
        }),
        tile({
          label: 'Fill rate to outlets', icon: 'truck', value: fmt.pct(sm.fillRate), delta: prev ? pointsOf(sm.fillRate, prev.fillRate) : null,
          sub: 'Mumbai ' + fmt.pct(sm.fillRateMumbai) + ' - Pune ' + fmt.pct(sm.fillRatePune),
          tone: below(sm.fillRateMumbai, targets.fillRateMumbai) || below(sm.fillRatePune, targets.fillRatePune) ? 'warn' : null,
          onClick: goTo(ctx, 'factory-production')
        }, [targets.fillRateMumbai && targets.fillRatePune ? tileLine(null, 'Targets from ' + pctShort(targets.fillRateMumbai[0]) + ' (daily supply) and ' + pctShort(targets.fillRatePune[0]) + ' (alternate days)') : null]),
        tile({
          label: 'Yield against standard', icon: 'scale', value: fmt.pct(sm.yieldIndex), delta: prev ? pointsOf(sm.yieldIndex, prev.yieldIndex) : null,
          sub: flagged.length ? plural(flagged.length, 'product', 'products') + ' flagged below standard' : 'No product flagged below standard',
          tone: flagged.length ? 'warn' : null, title: 'Production-weighted yield, where ' + fmt.pct(1, 0) + ' means every product is at its standard yield',
          onClick: goTo(ctx, 'factory-production')
        }, [flagged.length ? tileLine('alert-triangle', flagged[0].name + ': ' + fmt.inr(flagged[0].value) + ' of extra input') : null]),
        tile({
          label: 'Process wastage', icon: 'trash', value: fmt.pct(sm.wastagePct), delta: prev ? pointsOf(sm.wastagePct, prev.wastagePct) : null, goodWhen: 'down',
          sub: bandText(targets.wastagePct), tone: above(sm.wastagePct, targets.wastagePct) ? 'warn' : null, onClick: goTo(ctx, 'factory-overview')
        }),
        tile({
          label: 'Capacity used', icon: 'layers', value: fmt.pct(sm.capacityUtilisation), delta: prev ? pointsOf(sm.capacityUtilisation, prev.capacityUtilisation) : null, goodWhen: 'neutral',
          sub: fmt.kg(sm.kgPerDay) + ' of ' + fmt.kg(sm.capacityKgPerDay) + ' a day',
          tone: above(sm.capacityUtilisation, targets.capacityUtilisation) ? 'warn' : null, onClick: goTo(ctx, 'factory-overview')
        }, [bandText(targets.capacityUtilisation) ? tileLine(null, bandText(targets.capacityUtilisation)) : null])
      ];
      return h('div', { 'class': 'ov-section' },
        ui.grid([4, 8], [heroCard, h('div', { 'class': 'ov-kpis' }, tiles)], { className: 'ov-top' }),
        h('div', { 'class': 'ov-strip' }, sourceFlat(sm.source || 'erp')));
    });

    /* ---- approvals and payments */
    block(rootEl, 'Approvals and payments', function () { return flowSection(ctx); });

    /* ---- production against plan + factory cost */
    block(rootEl, 'Production and factory cost', function () {
      var plan = production.buckets.map(function (b, i) { return Math.round(sum(production.series.map(function (x) { return x.plan[i]; })) * 10) / 10; });
      var actual = production.buckets.map(function (b, i) { return Math.round(sum(production.series.map(function (x) { return x.actual[i]; })) * 10) / 10; });
      var floor = targets.planAdherence ? targets.planAdherence[0] : 1;
      var shortBuckets = actual.filter(function (v, i) { return plan[i] > 0 && v / plan[i] < floor; }).length;
      var grainWord = production.grain === 'day' ? 'day' : (production.grain === 'week' ? 'week' : 'month');
      var chart = MK.charts.mount(null, {
        id: 'ov-prod', kind: 'line', height: 280, format: 'kg', zeroBaseline: false,
        title: (production.grain === 'day' ? 'Daily' : (production.grain === 'week' ? 'Weekly' : 'Monthly')) + ' production against plan',
        subtitle: 'Produced ' + fmt.kg(sm.grossKg) + ' against a plan of ' + fmt.kg(sm.planKg) + ' (' + fmt.pct(sm.planAdherence) + '); ' +
          fmt.num(shortBuckets) + ' of ' + plural(production.buckets.length, grainWord, grainWord + 's') + ' fell below the ' + pctShort(floor) + ' adherence floor',
        data: {
          labels: production.buckets.map(function (b) { return b.label; }), labelHeader: production.grain === 'day' ? 'Day' : 'Period',
          series: [{ id: 'plan', name: 'Plan', values: plan, colourVar: '--series-muted' }, { id: 'actual', name: 'Produced', values: actual, colourVar: '--ot-factory' }]
        },
        note: production.grain === 'day' ? null : 'The first and last period may be partial.'
      });
      chart.el.appendChild(sourceEnd(production.source || 'erp'));

      var costCard;
      if (costMonth) {
        var fp = MK.factory.pnl(costMonth.monthKey);
        var costing = MK.factory.costing(costMonth.monthKey);
        var inBand = targets.absorptionPct && fp.absorptionPct >= targets.absorptionPct[0] && fp.absorptionPct <= targets.absorptionPct[1];
        costCard = ui.card({
          title: 'Factory cost and absorption', className: 'ov-costcard',
          subtitle: (fp.period && (fp.period.periodLabel || fp.period.label)) || costMonth.label,
          body: h('div', { 'class': 'ov-herobody' }, [
            statement([
              { label: 'Transfer value to outlets', value: fmt.inrFull(fp.transferValue) },
              { label: 'Logistics recovered from outlets', value: fmt.inrFull(fp.logisticsRecovery) },
              { label: 'Raw materials consumed', value: fmt.inrFull(-fp.rmConsumed) },
              { label: 'Conversion: labour, utilities, overhead', value: fmt.inrFull(-fp.conversion.total) },
              { label: 'Logistics cost', value: fmt.inrFull(-fp.logisticsCost) },
              { label: 'Over / (under) absorption', value: fmt.inrFull(fp.absorption), total: true }
            ]),
            h('div', { 'class': 'ov-chipline' },
              ui.chip((fp.absorption < 0 ? 'Under-absorbed by ' : 'Over-absorbed by ') + fmt.pct(Math.abs(fp.absorptionPct)) + ' of transfer value',
                inBand ? 'good' : 'warn', { icon: inBand ? 'check-circle' : 'alert-triangle' }),
              bandText(targets.absorptionPct) ? h('span', { 'class': 'mk-small mk-muted' }, bandText(targets.absorptionPct)) : null),
            statement([
              costing && costing.totals ? { label: 'Cost per kg', value: fmt.inrFull(costing.totals.costPerKg, 2) } : null,
              costing && costing.totals ? { label: 'Transfer price per kg', value: fmt.inrFull(costing.totals.transferPricePerKg, 2) } : null,
              { label: 'Factory cost, share of network sales', value: fmt.pct(fp.factoryCostPctOfNetworkSales) }
            ]),
            costMonth.partial ? h('div', { 'class': 'ov-footnote' }, 'Month to date: monthly fixed costs are accrued pro rata so the ratios stay comparable.') : null
          ]),
          footer: [isAllowed('factory-overview') ? ui.link('Open factory economics', MK.router.href('factory-overview')) : null, sourceFlat(fp.source || 'erp')]
        });
      } else {
        costCard = ui.card({ title: 'Factory cost and absorption', body: ui.emptyState('No cost month in this period', null, { compact: true }) });
      }
      return ui.grid([8, 4], [chart.el, costCard], { className: 'ov-charts' });
    });

    /* ---- supply to outlets */
    block(rootEl, 'Supply to outlets', function () {
      var bands = {};
      (dispatch.byRegion || []).forEach(function (r) { bands[r.id] = r.target; });
      var rows = dispatch.outlets.map(function (o) {
        var band = o.alternateDaySupply ? bands.pune : bands.mumbai;
        return {
          id: o.id, outlet: o.label, supply: (o.alternateDaySupply ? 'Alternate-day run' : 'Daily supply') + ', ' + plural(o.supplyDays, 'supply day', 'supply days'),
          indentKg: o.indentKg, dispatchKg: o.dispatchKg, shortKg: Math.round((o.indentKg - o.dispatchKg) * 10) / 10,
          fillRate: o.fillRate, transferValue: o.transferValue, band: band,
          status: band && o.fillRate < band[0] ? 'WATCH' : 'OK'
        };
      });
      var worst = rows.slice().sort(function (a, b) { return a.fillRate - b.fillRate; })[0];
      var open = goTo(ctx, 'factory-production');
      var regionNote = (dispatch.byRegion || []).map(function (r) {
        var band = bandText(r.target);
        return r.label + ': ' + fmt.pct(r.fillRate) + (band ? ', ' + band.toLowerCase() : '');
      }).join('. ');
      return ui.card({
        title: 'Supply to outlets', flush: true, className: 'ov-score',
        subtitle: worst ? worst.outlet + ' has the lowest fill rate at ' + fmt.pct(worst.fillRate) + ' (' + fmt.kg(worst.shortKg, 1) + ' short of its indents); the network is at ' + fmt.pct(dispatch.totals.fillRate) : null,
        body: ui.table({
          sortable: true, sort: ctx.state.supplySort || { key: 'transferValue', dir: 'desc' }, onSort: function (next) { ctx.state.supplySort = next; },
          columns: [
            { key: 'outlet', label: 'Outlet', render: ui.cells.twoLine('supply', { maxWidth: 240 }) },
            { key: 'indentKg', label: 'Indented', format: 'kg' },
            { key: 'dispatchKg', label: 'Dispatched', format: 'kg' },
            { key: 'shortKg', label: 'Short', format: function (v) { return fmt.kg(v, 1); }, align: 'right' },
            { key: 'fillRate', label: 'Fill rate', format: 'pct', render: ui.cells.heat(null, null) },
            { key: 'transferValue', label: 'Transfer value', format: 'inr', render: ui.cells.bar(null, '--series-1'), width: 200 },
            { key: 'status', label: 'Against target', sortable: false, render: function (value, row) { return ui.statusChip(value, { title: bandText(row.band) }); } }
          ],
          rows: rows,
          footer: { outlet: 'All outlets', indentKg: dispatch.totals.indentKg, dispatchKg: dispatch.totals.dispatchKg,
            shortKg: fmt.kg(Math.round((dispatch.totals.indentKg - dispatch.totals.dispatchKg) * 10) / 10, 1), fillRate: dispatch.totals.fillRate, transferValue: dispatch.totals.transferValue },
          onRowClick: open ? function () { ctx.navigate('factory-production'); } : null,
          empty: 'Nothing was dispatched in this period'
        }),
        footer: [
          h('div', { 'class': 'ov-footnote' }, (regionNote ? regionNote + '. ' : '') +
            'Indents include re-indented shortfalls' + (open ? '; select a row to open production and dispatch.' : '.')),
          sourceFlat(dispatch.source || 'erp')
        ]
      });
    });

    /* ---- needs attention */
    block(rootEl, 'Needs attention', function () { return attentionCard(insights, insightCounts, f, ['erp']); });
  }

  /* ---------------------------------------------------------------- page */

  function render(rootEl, ctx) {
    var outlets = MK.session.allowedOutletIds() || [];
    var units = MK.session.allowedUnitIds() || [];
    if (outlets.length) { renderSales(rootEl, ctx); return; }
    if (units.indexOf('factory') !== -1 && MK.factory) { renderFactory(rootEl, ctx); return; }
    rootEl.appendChild(ui.card({ body: ui.emptyState('Nothing in your scope yet', 'This persona has no outlet and no factory assigned, so there is nothing to summarise. Switch persona from the top bar.', { icon: 'store' }) }));
    block(rootEl, 'Approvals and payments', function () { return flowSection(ctx); });
  }

  MK.router.register({
    id: 'overview',
    route: '#/overview',
    group: 'Overview',
    title: 'Overview',
    subtitle: 'Management cockpit for the selected period',
    units: 'all',
    roles: null,
    filters: ['date', 'outlet'],
    render: render
  });
})(window);
