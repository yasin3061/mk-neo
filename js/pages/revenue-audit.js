/*
 * #/revenue/audit - Tax, markup & commission audit (client brief area 1, last row).
 *
 * The screen that proves every aggregator rupee is accounted for:
 *   status strip   per aggregator: statements uploaded through, next expected statement, the "Upload statement" step
 *   KPI row        settled money trail, take rate against the assumed contract, taxes, open disputes
 *   waterfall      menu value -> net payout for SETTLED periods only (control: both | Swiggy | Zomato)
 *   unsettled tail the same lines for the periods without a statement - an estimate, kept apart and labelled
 *   take rates     contracted vs effective by outlet
 *   exceptions     MK.data.auditFlags: commission above contract, short payments, ads spikes, markup anomalies
 *   taxes          GST payable by the restaurant vs the section 9(5) memo; GST on fees; TDS receivable
 *   payouts        every cycle per outlet per aggregator, status filter, drawer with statement vs expected lines
 *
 * Honesty rule (docs/DATA-FEASIBILITY.md): actual fees and payouts exist only where a statement was uploaded. Everything
 * newer is an estimate at assumed contract rates - it carries MK.ui.estimateBadge() and is never added to an actual.
 * Every figure comes from MK.data.* / MK.config and is formatted with MK.fmt; role scope is applied by the data layer.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;

  /* ------------------------------------------------------------------ vocabulary (layout constants, never data) */

  var PAGE_CLASS = 'pg-revenue-audit';
  var WF_HEIGHT = 340;            /* px */
  var TR_HEIGHT = 300;            /* px */
  var RECON_MAX_HEIGHT = 470;     /* px - the reconciliation table scrolls inside its card */
  var RECON_SHOWN = 60;           /* cycles built at once (about four screenfuls); the rest arrive on "Show all".
                                     A financial year holds a few hundred cycles and each builds nine cells with chips,
                                     badges and entity dots, which is the difference between a 60 ms and a 550 ms render. */
  var EXCEPTIONS_SHOWN = 6;       /* rows before "Show all" */
  var BOTH = 'both';

  var STATUSES = ['MATCHED', 'SHORT_PAID', 'DISPUTED', 'AWAITING_STATEMENT', 'IN_CYCLE'];
  var UNRESOLVED = { SHORT_PAID: true, DISPUTED: true };

  /*
   * The money trail, in statement order. `block` is the key on a channelEconomics BLOCK, `payout` the key on a payout
   * statement, `cap` the capability key of DATA-FEASIBILITY.md section 3, `axis` the short wording for a chart axis.
   */
  var LINES = [
    { id: 'grossValue', block: 'grossValue', payout: 'grossValue', cap: 'payout.grossValue', kind: 'total', label: 'Menu value', axis: 'Menu value' },
    { id: 'restaurantDiscount', block: 'restaurantDiscount', payout: 'restaurantDiscount', cap: 'payout.restaurantDiscount', kind: 'minus', label: 'Restaurant-funded discount', axis: 'Restaurant discount' },
    { id: 'netBillValue', block: 'netSales', payout: 'netBillValue', cap: 'payout.netBillValue', kind: 'total', label: 'Net bill value', axis: 'Net bill value' },
    { id: 'serviceFee', block: 'serviceFee', payout: 'serviceFee', cap: 'payout.commission', kind: 'minus', label: 'Service fee (commission)', axis: 'Service fee' },
    { id: 'collectionFee', block: 'collectionFee', payout: 'collectionFee', cap: 'payout.collectionFee', kind: 'minus', label: 'Collection / payment-mechanism fee', axis: 'Collection / payment fee' },
    { id: 'gstOnFees', block: 'gstOnFees', payout: 'gstOnFees', cap: 'payout.gstOnFees', kind: 'minus', label: 'GST on fees', axis: 'GST on fees' },
    { id: 'ads', block: 'ads', payout: 'ads', cap: 'payout.adsDeducted', kind: 'minus', label: 'Ads deducted', axis: 'Ads' },
    { id: 'refunds', block: 'refunds', payout: 'refundsAndCancellations', cap: 'payout.refundsAndCancellations', kind: 'minus', label: 'Refunds and cancellations', axis: 'Refunds' },
    { id: 'otherDeductions', block: 'otherDeductions', payout: 'otherDeductions', cap: 'payout.otherDeductions', kind: 'minus', label: 'Other deductions', axis: 'Other deductions' },
    { id: 'tds', block: 'tds', payout: 'tds', cap: 'payout.tds', kind: 'minus', label: 'TDS by e-commerce operator', axis: 'TDS withheld' },
    { id: 'netPayout', block: 'netPayout', payout: 'netPayout', cap: 'payout.netPayout', kind: 'total', label: 'Net payout', axis: 'Net payout' }
  ];

  var SEVERITY = {
    high: { label: 'High', tone: 'critical' },
    medium: { label: 'Medium', tone: 'warn' },
    low: { label: 'Low', tone: 'neutral' }
  };

  var FLAG_TYPES = {
    commission: { label: 'Commission', icon: 'scale', amountLabel: 'over-charged', noun: 'commission over-charge' },
    payout: { label: 'Payout', icon: 'wallet', amountLabel: 'short-paid', noun: 'short payment' },
    ads: { label: 'Ads', icon: 'chart', amountLabel: 'above the usual share', noun: 'ads spike' },
    markup: { label: 'Markup', icon: 'dish', amountLabel: 'realisation lost in range', noun: 'markup exception' }
  };

  /* ------------------------------------------------------------------ small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function has(list, value) { return Array.isArray(list) && list.indexOf(value) !== -1; }
  function share(part, whole) { return isNum(part) && isNum(whole) && whole > 0 ? part / whole : null; }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''; }

  function total(rows, pick) {
    var t = 0;
    (rows || []).forEach(function (r) { var v = pick(r); if (isNum(v)) t += v; });
    return t;
  }

  function plural(n, word, many) { return fmt.num(n) + ' ' + (n === 1 ? word : (many || word + 's')); }

  function andList(items) {
    var list = (items || []).filter(Boolean);
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function day(iso, style) { return iso ? MK.dates.label(iso, style || 'd MMM yyyy') : '-'; }

  function rangeLabel(from, to) {
    if (!from || !to) return '';
    if (from === to) return day(from);
    return MK.dates.label(from, from.slice(0, 4) === to.slice(0, 4) ? 'd MMM' : 'd MMM yyyy') + ' - ' + day(to);
  }

  /* "less service fee": lower the first letter unless the label opens with an abbreviation (GST, TDS) */
  function less(label) {
    var s = String(label || '');
    var second = s.charAt(1);
    return 'less ' + (second && second === second.toLowerCase() && second !== second.toUpperCase() ? lowerFirst(s) : s);
  }

  /* size of a gap between two rates, in percentage points, without a sign */
  function pts(x) { return fmt.num(Math.abs(x) * 100, 1) + ' pts'; }

  function signed(n) { return isNum(n) ? (n > 0 ? '+' : '') + fmt.inrFull(n) : '-'; }

  function guard(name, fn, fallback) {
    try { return fn(); } catch (e) {
      if (root.console) root.console.error('[revenue-audit] ' + name, e);
      return fallback;
    }
  }

  /* one block failing (the data layer is tuned in parallel) must not take the screen down */
  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[revenue-audit] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  /* ---- master data */

  function cfg() { return MK.config || {}; }
  function byId(list, id) { for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i]; return null; }
  function channelInfo(id) { return byId(cfg().channels, id); }
  function outletInfo(id) { return byId(cfg().outlets, id); }
  function outletName(id) { var o = outletInfo(id); return o ? o.name : String(id || ''); }
  function channelName(id) { var c = channelInfo(id); return c ? c.label : String(id || ''); }
  function aggregators() { return (cfg().channels || []).filter(function (c) { return c.kind === 'aggregator'; }); }
  function termsOf(channelId) { return (cfg().channelTerms || {})[channelId] || null; }
  function statementSource(channelId) { var t = termsOf(channelId), c = channelInfo(channelId); return (t && t.statementSource) || (c && c.source) || null; }
  function tolerance() { var r = cfg().auditRules; return r && isNum(r.payoutToleranceRs) ? r.payoutToleranceRs : null; }
  function today() { return (MK.calendar && MK.calendar.today) || cfg().today || null; }

  /* A channel-attributed field may only be shown when the capability matrix says the channel supplies it. */
  function supplies(channelId, fieldKey) { return MK.data.can(channelId, fieldKey) !== 'no'; }

  function lineLabel(ln, channelId) {
    var one = channelId && channelId !== BOTH ? termsOf(channelId) : null;
    var any = one || termsOf((aggregators()[0] || {}).id);
    /* one aggregator in view: call each line what that aggregator's own statement calls it */
    if (ln.id === 'serviceFee' && one && one.serviceFeeLabel) return one.serviceFeeLabel;
    if (ln.id === 'collectionFee' && one && one.collectionFeeLabel) return one.collectionFeeLabel;
    if (ln.id === 'gstOnFees') {
      var rate = any && isNum(any.gstOnFeesPct) ? any.gstOnFeesPct : (cfg().gst && cfg().gst.onAggregatorFeesPct);
      return ln.label + (isNum(rate) ? ' (' + fmt.pct(rate, 0) + ')' : '');
    }
    if (ln.id === 'tds') return (any && any.tdsLabel) || ln.label;
    return ln.label;
  }

  /* ---- DOM bits */

  function note(text, iconName) {
    return h('p', { 'class': 'ra-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, text));
  }

  function tableFoot(children) { return h('div', { 'class': 'ra-tablefoot' }, children); }

  /* entity dot: the colour follows the entity through its token name, never a literal */
  function dot(colourVar) { return h('span', { 'class': 'ra-dot', 'aria-hidden': 'true', style: { background: 'var(' + colourVar + ')' } }); }

  /* source tag without the kit's top margin, for places where the page owns the spacing */
  function sourceFlat(ids) {
    var tag = ui.sourceTag(ids);
    tag.classList.add('ra-source-flat');
    return tag;
  }

  /* body of a card that may be stretched by its row: keeps the foot at the bottom edge */
  function fill(children) { return h('div', { 'class': 'ra-fill' }, children); }

  /* Drawers and modals live outside the page root: the wrapper carries the page class so the page stylesheet applies. */
  function overlayBody(children) { return h('div', { 'class': [PAGE_CLASS, 'ra-overlay'] }, children); }

  /* small line inside a stat tile: icon or badge, then text */
  function tileLine(lead, content, title) {
    var leadNode = typeof lead === 'string' ? ui.icon(lead, 12) : lead;
    return h('span', { 'class': 'ra-tileline', title: title || null },
      leadNode ? h('span', { 'class': 'ra-tileline__lead' }, leadNode) : null, h('span', null, content));
  }

  function tile(options, lines) {
    var el = ui.statTile(options);
    (lines || []).filter(Boolean).forEach(function (line) { el.appendChild(line); });
    return el;
  }

  /* ------------------------------------------------------------------ channel selection inside a card */

  function lensOptions(ce) {
    var list = (ce && ce.channels) || [];
    var opts = list.map(function (c) { return { value: c.channelId, label: c.label }; });
    if (list.length > 1) opts.unshift({ value: BOTH, label: 'Both' });
    return opts;
  }

  function lensValue(ce, wanted) {
    var opts = lensOptions(ce);
    for (var i = 0; i < opts.length; i++) if (opts[i].value === wanted) return wanted;
    return opts.length ? opts[0].value : BOTH;
  }

  function lensChannels(ce, lens) {
    return ((ce && ce.channels) || []).filter(function (c) { return lens === BOTH || c.channelId === lens; });
  }

  function lensBlock(ce, lens, part) {
    if (!ce) return null;
    if (lens === BOTH) return ce.total ? ce.total[part] : null;
    var c = lensChannels(ce, lens)[0];
    return c ? c[part] : null;
  }

  /*
   * Channels of the lens whose uploaded statement actually covers orders of the range (API.md section 4.1 and 4.3:
   * only the statements that cover the range may be named as a source, and "no statement" is not a zero).
   */
  function settledChannels(ce, lens) {
    return lensChannels(ce, lens).filter(function (c) { return !!c.actualThrough && c.actual && c.actual.orders > 0; });
  }

  function lensSources(ce, lens) {
    return settledChannels(ce, lens).map(function (c) { return statementSource(c.channelId); }).filter(Boolean);
  }

  /*
   * The statements behind a settled-only card: those that cover the range. When none does, the card is empty and the
   * honest caption is the statement it is waiting for - its "uploaded through" date says why there is nothing to draw.
   */
  function settledSources(ce, lens) {
    var covered = lensSources(ce, lens);
    if (covered.length) return covered;
    return lensChannels(ce, lens).map(function (c) { return statementSource(c.channelId); }).filter(Boolean);
  }

  /* part 'actual' names only the channels that a statement covers; otherwise every channel of the lens */
  function lensWho(ce, lens, part) {
    var list = part === 'actual' ? settledChannels(ce, lens) : lensChannels(ce, lens);
    return andList(list.map(function (c) { return c.label; }));
  }

  /* Dates inside the filter range that a statement covers, and the tail that it does not, per aggregator. */
  function coverage(ce, lens) {
    var settled = [], tail = [];
    lensChannels(ce, lens).forEach(function (c) {
      var through = c.settledThrough || (ce.settledThrough || {})[c.channelId];
      if (!through) return;
      if (ce.from <= through && c.actual && c.actual.orders > 0) settled.push(c.label + ' ' + rangeLabel(ce.from, MK.dates.min(ce.to, through)));
      var tailFrom = MK.dates.max(ce.from, MK.dates.addDays(through, 1));
      if (tailFrom <= ce.to && c.estimated && c.estimated.orders > 0) tail.push(c.label + ' ' + rangeLabel(tailFrom, ce.to));
    });
    return { settled: settled, tail: tail };
  }

  /* ------------------------------------------------------------------ header: purpose, scope */

  function intro(env) {
    var ce = env.ce;
    var days = ce && ce.from && ce.to ? MK.dates.diffDays(ce.from, ce.to) + 1 : null;
    return h('p', { 'class': 'ra-intro' },
      'Where every aggregator rupee went, from the menu price to the bank credit. Actuals exist only for periods with an uploaded statement; ' +
      'anything newer is an estimate at assumed contract rates and is kept apart. ',
      ce && ce.from ? h('strong', { 'class': 'ra-intro__period' }, rangeLabel(ce.from, ce.to) + (days ? ', ' + plural(days, 'day') : '') + '.') : null);
  }

  function scopeNote(ctx) {
    var allowed = MK.session.allowedOutletIds();
    var all = MK.session.OUTLET_IDS || [];
    if (!allowed.length || allowed.length >= all.length) return null;
    var names = allowed.map(outletName);
    var who = ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel : 'Your role';
    return ui.callout('info', null, who + ' sees ' + andList(names) + ' only. Every figure, payout cycle and exception on this page is already limited to that scope.', { icon: 'lock' });
  }

  /* ------------------------------------------------------------------ status strip: statements per aggregator */

  function statementState(env, ch) {
    var terms = termsOf(ch.id) || {};
    var src = (cfg().sources || {})[statementSource(ch.id)] || null;
    function waiting(list) { return ((list && list.rows) || []).filter(function (r) { return r.channelId === ch.id && r.estimated; }); }
    /* The amount still shown as an estimate follows the outlet filter, like every other figure on this page;
       the next expected statement is a fact of the system, so it is read from the unfiltered cycles. */
    var pending = waiting(env.tailScoped || env.tail);
    var next = null;
    waiting(env.tail).forEach(function (r) { if (!next || r.period.from < next.period.from) next = r; });
    var periods = {};
    pending.forEach(function (r) { periods[r.period.from] = true; });
    return {
      channel: ch, terms: terms, source: src,
      through: terms.settledThrough || (src && src.through) || null,
      lastSettlement: terms.lastSettlementDate || null,
      next: next, pending: pending, pendingPeriods: Object.keys(periods).length,
      pendingAmount: total(pending, function (r) { return r.expected && r.expected.netPayout; })
    };
  }

  function dueText(settlementDate) {
    var now = today();
    if (!settlementDate || !now) return '';
    var n = MK.dates.diffDays(now, settlementDate);
    if (n === 0) return 'due today';
    return n > 0 ? 'in ' + plural(n, 'day') : plural(-n, 'day') + ' overdue';
  }

  function fact(label, value, sub) {
    return h('div', { 'class': 'ra-fact' },
      h('div', { 'class': 'ra-fact__label' }, label),
      h('div', { 'class': 'ra-fact__value' }, value),
      sub ? h('div', { 'class': 'ra-fact__sub' }, sub) : null);
  }

  function statusCard(env, ch) {
    var s = statementState(env, ch);
    var inFilter = !env.f.channelIds || has(env.f.channelIds, ch.id);
    var nextValue, nextSub;
    if (s.next) {
      nextValue = s.next.period.label;
      nextSub = [ui.statusChip(s.next.status), ' ', day(s.next.settlementDate, 'EEE d MMM') + ', ' + dueText(s.next.settlementDate)];
    } else {
      nextValue = '-';
      nextSub = 'No cycle is waiting for a statement';
    }
    var body = h('div', { 'class': 'ra-stat' },
      h('div', { 'class': 'ra-stat__head' },
        h('div', { 'class': 'ra-stat__who' },
          dot(ch.colourVar),
          h('span', { 'class': 'ra-stat__name' }, ch.label),
          h('span', { 'class': 'ra-stat__doc' }, (s.terms.statementName || 'statement') + (s.source && s.source.frequency ? ', uploaded ' + lowerFirst(s.source.frequency) : ''))),
        ui.button({ label: 'Upload statement', icon: 'upload', size: 'sm', onClick: function () { openUpload(env, s); } })),
      h('div', { 'class': 'ra-stat__facts' },
        fact('Statements uploaded through', day(s.through), s.lastSettlement ? 'Last settlement ' + day(s.lastSettlement, 'EEE d MMM') : null),
        fact('Next expected statement', nextValue, nextSub),
        fact('Shown as estimates until then', s.pending.length ? [fmt.inr(s.pendingAmount), ' ', ui.estimateBadge()] : fmt.inr(0),
          s.pending.length ? 'Net payout of ' + plural(s.pending.length, 'cycle') + ' over ' + plural(s.pendingPeriods, 'period') : 'Every cycle has its statement')),
      h('div', { 'class': 'ra-stat__rule' }, ui.icon('calendar', 12),
        h('span', null, (s.terms.cycle && s.terms.cycle.label) || ''),
        inFilter ? null : h('span', { 'class': 'ra-stat__off' }, 'Not in the channel filter: left out of the figures below')));
    /* the card quotes channel figures (statement coverage and the payout still carried as an estimate), so it names its sources */
    var srcIds = [statementSource(ch.id) || 'erp'];
    if (s.pending.length) srcIds.push('estimate');
    return ui.card({ body: body, className: 'ra-statcard', footer: sourceFlat(srcIds) });
  }

  function statusStrip(env) {
    var list = aggregators();
    if (!list.length) return null;
    return h('div', { 'class': 'ra-strip' }, list.map(function (ch) { return statusCard(env, ch); }));
  }

  /* "Upload statement" only explains the weekly step: there is no settlement API and nothing is uploaded in the mockup. */
  function openUpload(env, s) {
    var ch = s.channel, tol = tolerance();
    var docName = s.terms.statementName || 'statement';
    var steps = [
      'Download the ' + docName + (s.next ? ' for ' + s.next.period.label : '') + ' from the ' + ch.label + ' partner portal. ' + ch.label +
        ' offers no settlement API, so this stays a weekly manual step.',
      'Upload it here. Every line is matched to its Petpooja order by order id - payout weeks follow the calendar while a business day runs past midnight, so day totals never tie.',
      'The estimates of that period become actuals. A cycle is Matched when the bank credit is within ' + (tol === null ? 'the tolerance' : fmt.inrFull(tol)) +
        ' of the expected payout; anything else is flagged with its reason and can be disputed.'
    ];
    var m = ui.modal({
      title: 'Upload the ' + ch.label + ' ' + docName,
      subtitle: s.source ? s.source.caption : null,
      body: overlayBody([
        ui.callout('info', 'Explained here, not performed', 'This mockup holds a fixed demo dataset, so the button only shows where the weekly step sits. Nothing is uploaded or changed.'),
        h('ol', { 'class': 'ra-steps' }, steps.map(function (text) { return h('li', null, text); })),
        ui.keyValue([
          ['Uploaded through', day(s.through)],
          ['Last settlement', s.lastSettlement ? day(s.lastSettlement, 'EEE d MMM') : null],
          ['Next statement', s.next ? s.next.period.label : null],
          ['Expected on', s.next ? day(s.next.settlementDate, 'EEE d MMM') + ', ' + dueText(s.next.settlementDate) : null],
          ['Cycle', (s.terms.cycle && s.terms.cycle.label) || null]
        ]),
        h('div', { 'class': 'ra-drop', 'aria-disabled': 'true' }, ui.icon('upload', 18),
          h('span', null, 'File upload is switched off in this mockup'))
      ]),
      footer: [
        MK.router.isAllowed('data-sources') ? ui.button({ label: 'What each statement supplies', variant: 'ghost', icon: 'database', onClick: function () { m.close(); env.ctx.navigate('data-sources'); } }) : null,
        ui.button({ label: 'Close', variant: 'primary', onClick: function () { m.close(); } })
      ]
    });
  }

  /* ------------------------------------------------------------------ KPI row */

  function openItems(env) {
    var rows = (env.allPayouts && env.allPayouts.rows) || [];
    var disputed = rows.filter(function (r) { return r.dispute && r.dispute.status === 'OPEN'; });
    var shortPaid = rows.filter(function (r) { return r.status === 'SHORT_PAID'; });
    return {
      disputed: disputed, shortPaid: shortPaid,
      disputedAmount: total(disputed, function (r) { return r.dispute.amount; }),
      shortAmount: total(shortPaid, function (r) { return r.variance; })
    };
  }

  function takeRateTile(env, c) {
    var act = c.actual || {}, est = c.estimated || {};
    var gapRule = MK.insights && MK.insights.RULES && MK.insights.RULES.takeRate ? MK.insights.RULES.takeRate.gapPts : null;
    var assumed = env.ce.ratesAssumed ? ' (assumed)' : '';
    if (act.orders > 0) {
      var gap = act.effectiveTakeRate - act.contractedTakeRate;
      return tile({
        label: c.label + ' take rate', icon: 'scale', value: fmt.pct(act.effectiveTakeRate),
        delta: fmt.points(act.effectiveTakeRate, act.contractedTakeRate), goodWhen: 'down', deltaNote: 'vs contract',
        tone: isNum(gapRule) && gap >= gapRule ? 'warn' : null,
        title: 'Everything ' + c.label + ' keeps (fees, GST on fees, ads, refunds, unclassified deductions) as a share of net bill value, settled orders only'
      }, [tileLine('file', 'Contract ' + fmt.pct(act.contractedTakeRate) + assumed + ' on ' + fmt.inr(act.netSales) + ' settled')]);
    }
    if (est.orders > 0) {
      return tile({ label: c.label + ' take rate', icon: 'scale', value: fmt.pct(est.effectiveTakeRate) },
        [tileLine(ui.estimateBadge(), 'No settled statement in this range: contract terms' + assumed)]);
    }
    return tile({ label: c.label + ' take rate', icon: 'scale', value: '-', sub: 'No ' + c.label + ' orders in this selection' });
  }

  function kpiBlock(env) {
    var ce = env.ce, act = ce.total.actual, est = ce.total.estimated;
    var hasAct = act.orders > 0, hasEst = est.orders > 0;
    var open = openItems(env);
    var feeGst = cfg().gst && isNum(cfg().gst.onAggregatorFeesPct) ? cfg().gst.onAggregatorFeesPct : null;
    var tiles = [];

    tiles.push(tile({
      label: 'Menu value, settled periods', icon: 'receipt', value: hasAct ? fmt.inr(act.grossValue) : '-',
      sub: hasAct ? plural(act.orders, 'order') + ' covered by a statement' : 'No settled statement in this range',
      title: 'Aggregator menu value (items and packaging, before discounts) of the orders whose payout statement has been uploaded'
    }, [hasEst ? tileLine('clock', fmt.inr(est.grossValue) + ' more awaits its statement') : null]));

    tiles.push(tile({
      label: 'Net payout, settled', icon: 'bank', value: hasAct ? fmt.inr(act.netPayout) : '-',
      sub: hasAct ? fmt.pct(share(act.netPayout, act.grossValue)) + ' of menu value reached the bank' : null,
      title: 'Bank credits as per the uploaded statements'
    }, [hasEst ? tileLine(ui.estimateBadge(), fmt.inr(est.netPayout) + ' expected for the unsettled tail') : null]));

    ce.channels.forEach(function (c) { tiles.push(takeRateTile(env, c)); });

    if (ce.channels.length === 1) {
      tiles.push(tile({
        label: 'Service fee charged', icon: 'coins', value: hasAct ? fmt.pct(act.serviceFeePct) : '-',
        delta: hasAct ? fmt.points(act.serviceFeePct, act.contractedServiceFeePct) : null, goodWhen: 'down', deltaNote: 'vs contract',
        sub: hasAct ? null : 'No settled statement in this range'
      }, [hasAct ? tileLine('file', 'Contract ' + fmt.pct(act.contractedServiceFeePct) + (ce.ratesAssumed ? ' (assumed)' : '') + ' of the fee base') : null]));
    }

    tiles.push(tile({
      label: 'Restaurant-funded discounts', icon: 'coins', value: hasAct ? fmt.inr(act.restaurantDiscount) : '-',
      sub: hasAct ? fmt.pct(share(act.restaurantDiscount, act.grossValue)) + ' of settled menu value' : null
    }, [hasEst ? tileLine(ui.estimateBadge(), fmt.inr(est.restaurantDiscount) + ' in the unsettled tail') : null]));

    tiles.push(tile({
      label: 'Ads deducted', icon: 'chart', value: hasAct ? fmt.inr(act.ads) : '-',
      sub: hasAct ? fmt.pct(share(act.ads, act.netSales)) + ' of net bill value' + (feeGst !== null ? ', incl. ' + fmt.pct(feeGst, 0) + ' GST' : '') : null,
      title: 'The amount the aggregators deducted for ads in the statements - the only reconcilable ads figure'
    }, [hasEst ? tileLine(ui.estimateBadge(), fmt.inr(est.ads) + ' at the trailing share') : null]));

    tiles.push(tile({
      label: 'TDS receivable', icon: 'shield-check', value: hasAct ? fmt.inrFull(act.tds) : '-',
      sub: 'Recoverable tax credit, not a cost',
      title: 'Tax deducted by the e-commerce operators from the payouts: claimed back in the income-tax return'
    }, [hasEst ? tileLine(ui.estimateBadge(), fmt.inrFull(est.tds) + ' more in the unsettled tail') : null]));

    var firstOpen = open.disputed[0] || open.shortPaid[0] || null;
    tiles.push(tile({
      label: 'Amount under dispute', icon: 'alert-triangle', value: fmt.inrFull(open.disputedAmount),
      tone: open.disputedAmount > 0 ? 'critical' : (open.shortAmount > 0 ? 'warn' : null),
      sub: open.disputed.length ? plural(open.disputed.length, 'open dispute') + ', all periods' : 'No open dispute in any period',
      title: 'Open disputes are a balance, not a flow: shown for the whole data range whatever the date filter says',
      onClick: firstOpen ? function () { openPayout(env, firstOpen); } : null
    }, [open.shortPaid.length ? tileLine('alert-triangle', fmt.inrFull(open.shortAmount) + ' short-paid in ' + plural(open.shortPaid.length, 'cycle') + ', not yet disputed') : null]));

    var sources = hasAct ? ce.sources.actual.slice() : [];
    if (hasEst) sources.push(ce.sources.estimated);
    return h('div', { 'class': 'ra-kpiblock' },
      h('div', { 'class': ['ra-kpis', 'ra-kpis--' + tiles.length] }, tiles),
      sources.length ? sourceFlat(sources) : null);
  }

  /* ------------------------------------------------------------------ waterfall (settled) and the unsettled tail */

  function wfTakeaway(ce, lens, block) {
    if (!block || !(block.orders > 0)) return 'No settled statement covers this selection yet - see the estimate below.';
    /* name only the aggregators a statement actually covers here: in a short range that can be one of the two */
    var who = lensWho(ce, lens, 'actual') || lensWho(ce, lens);
    var cuts = [
      { name: 'collection and payment fees', value: block.collectionFee }, { name: 'GST on fees', value: block.gstOnFees },
      { name: 'ads', value: block.ads }, { name: 'refunds and cancellations', value: block.refunds }, { name: 'other deductions', value: block.otherDeductions }
    ].sort(function (a, b) { return b.value - a.value; });
    var several = settledChannels(ce, lens).length > 1;
    return fmt.pct(share(block.netPayout, block.grossValue)) + ' of the settled ' + who + ' menu value reaches the bank. Restaurant-funded discounts take ' +
      fmt.pct(share(block.restaurantDiscount, block.grossValue)) + ', the aggregator' + (several ? 's keep ' : ' keeps ') + fmt.pct(share(block.totalDeductions, block.grossValue)) +
      (cuts[0].value > 0 ? ' - after the service fee the largest cut is ' + cuts[0].name + ' at ' + fmt.inr(cuts[0].value) : '') + '.';
  }

  function wfSpec(env, lens) {
    var ce = env.ce, block = lensBlock(ce, lens, 'actual');
    var live = !!block && block.orders > 0;
    var cover = coverage(ce, lens);
    var rows = live ? LINES.map(function (ln) {
      var v = block[ln.block];
      return { line: lineLabel(ln, lens), amount: ln.kind === 'minus' ? -v : v, ofMenu: share(v, block.grossValue), ofNet: ln.id === 'grossValue' ? null : share(v, block.netSales) };
    }) : [];
    return {
      subtitle: wfTakeaway(ce, lens, block),
      data: { steps: live ? LINES.map(function (ln) { return { label: ln.axis, value: block[ln.block], kind: ln.kind }; }) : [],
        kindLabels: { total: 'Subtotal', minus: 'Deduction' }, stepHeader: 'Line' },
      table: { columns: [{ key: 'line', label: 'Line' }, { key: 'amount', label: 'Amount', format: 'inrFull', align: 'right' },
        { key: 'ofMenu', label: '% of menu value', format: 'pct', align: 'right' }, { key: 'ofNet', label: '% of net bill value', format: 'pct', align: 'right' }], rows: rows },
      note: (cover.settled.length ? 'Settled orders only: ' + cover.settled.join(', ') + '. ' : '') +
        'TDS lowers the bank credit but is a recoverable tax credit, not a cost.' + (ce.ratesAssumed ? ' Contract rates are assumed.' : ''),
      sources: settledSources(ce, lens)
    };
  }

  function tailCard(env, lens, control) {
    var ce = env.ce;
    var est = lensBlock(ce, lens, 'estimated'), act = lensBlock(ce, lens, 'actual');
    var cover = coverage(ce, lens);
    var host = fill([]);
    if (!est || !(est.orders > 0)) {
      host.appendChild(ui.emptyState('Nothing is estimated in this selection', 'Every ' + (lensWho(ce, lens) || 'aggregator') +
        ' order in the range is covered by an uploaded statement, so the waterfall above is the whole story.', { icon: 'check-circle', compact: true }));
      return ui.card({ title: 'Unsettled tail', subtitle: 'Orders newer than the last uploaded statement', body: host });
    }
    var hasAct = !!act && act.orders > 0;
    var rows = LINES.map(function (ln) {
      return { id: ln.id, kind: ln.kind, line: lineLabel(ln, lens), amount: est[ln.block], ofNet: ln.id === 'grossValue' ? null : share(est[ln.block], est.netSales),
        settledOfNet: hasAct && ln.id !== 'grossValue' ? share(act[ln.block], act.netSales) : null };
    });
    var table = ui.table({
      dense: true,
      columns: [
        { key: 'line', label: 'Line', render: function (v, row) { return h('span', { 'class': row.kind === 'total' ? 'mk-strong' : null }, row.kind === 'minus' ? less(v) : v); } },
        { key: 'amount', label: 'Estimated', format: 'inrFull', title: 'Estimated at assumed contract rates' },
        { key: 'ofNet', label: '% of net bill', format: 'pct', title: 'Share of the estimated net bill value' },
        hasAct ? { key: 'settledOfNet', label: 'Settled, %', format: 'pct', title: 'The same line in the settled periods of this range, from the statements - for comparison' } : null
      ],
      rows: rows,
      rowClass: function (row) { return row.kind === 'total' ? 'is-strong' : ''; }
    });
    host.appendChild(table);
    host.appendChild(tableFoot([
      note('Fees at contract terms, ads at the trailing settled share, refunds at the contract assumption. The figures are replaced by actuals when the statement is uploaded and are never added to the settled amounts.', 'info'),
      sourceFlat(['petpooja', ce.sources.estimated])
    ]));
    return ui.card({
      title: 'Unsettled tail', actions: [control || null, ui.estimateBadge()], flush: true,
      subtitle: fmt.inr(est.netPayout) + ' net payout expected on ' + plural(est.orders, 'order') + (cover.tail.length ? ' (' + cover.tail.join(', ') + ')' : '') +
        ' - ' + fmt.pct(est.effectiveTakeRate) + ' take rate at contract terms' +
        (hasAct ? ' against ' + fmt.pct(act.effectiveTakeRate) + ' actually charged on the settled ' + lensWho(ce, lens, 'actual') + ' orders' : '') + '.',
      body: host
    });
  }

  function moneyTrail(env, parent, tailHost) {
    var ce = env.ce, st = env.st;
    st.wfLens = lensValue(ce, st.wfLens);
    var opts = lensOptions(ce);
    var first = wfSpec(env, st.wfLens);
    var tag = ui.sourceTag(first.sources);

    function paintTail() {
      MK.charts.disposeAll(tailHost);
      ui.clear(tailHost).appendChild(tailCard(env, st.wfLens));
    }

    var chart = MK.charts.mount(null, {
      id: 'ra-waterfall', kind: 'waterfall', format: 'inr', height: WF_HEIGHT,
      title: 'From menu value to money in the bank', subtitle: first.subtitle, data: first.data, table: first.table, note: first.note,
      emptyText: 'No settled statement covers this selection yet',
      controls: opts.length > 1 ? [{ id: 'lens', label: 'Aggregator', value: st.wfLens, options: opts }] : null,
      onControl: function (id, value) {
        st.wfLens = value;
        var next = wfSpec(env, value);
        chart.update({ subtitle: next.subtitle, data: next.data, table: next.table, note: next.note });
        var fresh = ui.sourceTag(next.sources);
        tag.parentNode.replaceChild(fresh, tag);
        tag = fresh;
        paintTail();
      }
    });
    chart.el.appendChild(tag);
    parent.appendChild(chart.el);
    paintTail();
  }

  /* No statement covers the selection at all: the estimate is the whole story, so it leads and carries the aggregator switch. */
  function tailOnly(env, parent) {
    var ce = env.ce, st = env.st;
    st.wfLens = lensValue(ce, st.wfLens);
    var opts = lensOptions(ce);
    var through = ce.channels.map(function (c) { return c.label + ' through ' + day(c.settledThrough); });
    parent.appendChild(ui.callout('info', 'No uploaded statement covers this selection yet',
      'Statements are in for ' + andList(through) + '. Every fee, take rate and payout for ' + rangeLabel(ce.from, ce.to) +
      ' is therefore an estimate at assumed contract rates; the waterfall and the take-rate comparison appear once a statement covers part of the range.'));
    var host = h('div', { 'class': 'ra-cell' });
    function paint() {
      var control = opts.length > 1 ? ui.segmented({ ariaLabel: 'Aggregator', size: 'sm', value: st.wfLens, options: opts, onChange: function (v) { st.wfLens = v; paint(); } }) : null;
      ui.clear(host).appendChild(tailCard(env, st.wfLens, control));
    }
    paint();
    parent.appendChild(host);
  }

  /* ------------------------------------------------------------------ contracted vs effective take rate by outlet */

  function trRows(ce, lens) {
    return ((ce && ce.byOutlet) || []).map(function (o) {
      var b = lens === BOTH ? o.actual : (o.byChannel && o.byChannel[lens] ? o.byChannel[lens].actual : null);
      if (!b || !(b.orders > 0)) return null;
      return { id: o.outletId, label: o.label, netSales: b.netSales, contracted: b.contractedTakeRate, effective: b.effectiveTakeRate,
        gap: b.effectiveTakeRate - b.contractedTakeRate, gapLabel: fmt.points(b.effectiveTakeRate, b.contractedTakeRate).label,
        adsPct: share(b.ads, b.netSales), refundsPct: share(b.refunds, b.netSales), feePct: b.serviceFeePct, feeContractPct: b.contractedServiceFeePct };
    }).filter(Boolean).sort(function (a, b) { return b.gap - a.gap; });
  }

  function trTakeaway(ce, lens, rows) {
    if (!rows.length) return 'No settled statement covers this selection yet.';
    var assumed = ce.ratesAssumed ? ' (assumed)' : '';
    var top = rows[0], low = rows[rows.length - 1];
    if (rows.length === 1) {
      return top.label + ' gives up ' + fmt.pct(top.effective) + ' of net bill value against a contracted ' + fmt.pct(top.contracted) + assumed + ', ' + pts(top.gap) +
        (top.gap >= 0 ? ' above' : ' below') + ' it; ads alone are ' + fmt.pct(top.adsPct) + '.';
    }
    return top.label + ' runs ' + pts(top.gap) + (top.gap >= 0 ? ' above' : ' below') + ' its contract' + assumed + ', the widest gap; ads alone are ' + fmt.pct(top.adsPct) +
      ' of its net bill value. ' + low.label + ' is the closest, ' + pts(low.gap) + (low.gap >= 0 ? ' above.' : ' below.');
  }

  function trSpec(env, lens) {
    var ce = env.ce, rows = trRows(ce, lens);
    return {
      subtitle: trTakeaway(ce, lens, rows),
      data: { categories: rows.map(function (r) { return r.label; }), categoryHeader: 'Outlet',
        series: [{ id: 'contracted', name: 'Contracted' + (ce.ratesAssumed ? ' (assumed)' : ''), colourVar: '--series-muted', values: rows.map(function (r) { return r.contracted; }) },
          { id: 'effective', name: 'Effective, from statements', colourVar: '--series-1', values: rows.map(function (r) { return r.effective; }) }] },
      table: { columns: [{ key: 'label', label: 'Outlet' }, { key: 'contracted', label: 'Contracted', format: 'pct', align: 'right' },
        { key: 'effective', label: 'Effective', format: 'pct', align: 'right' }, { key: 'gapLabel', label: 'Gap', align: 'right' },
        { key: 'adsPct', label: 'Ads', format: 'pct', align: 'right' }, { key: 'refundsPct', label: 'Refunds', format: 'pct', align: 'right' }], rows: rows },
      sources: settledSources(ce, lens)
    };
  }

  function takeRates(env) {
    var ce = env.ce, st = env.st;
    st.trLens = lensValue(ce, st.trLens);
    var opts = lensOptions(ce);
    var first = trSpec(env, st.trLens);
    var tag = ui.sourceTag(first.sources);
    var chart = MK.charts.mount(null, {
      id: 'ra-takerates', kind: 'bar', format: 'pct', height: TR_HEIGHT,
      title: 'Contracted vs effective take rate by outlet', subtitle: first.subtitle, data: first.data, table: first.table,
      emptyText: 'No settled statement covers this selection yet',
      note: 'Share of net bill value, settled orders only, widest gap first. Effective adds ads, refunds, unclassified deductions and any over-charge to the contracted fees.',
      controls: opts.length > 1 ? [{ id: 'lens', label: 'Aggregator', value: st.trLens, options: opts }] : null,
      onControl: function (id, value) {
        st.trLens = value;
        var next = trSpec(env, value);
        chart.update({ subtitle: next.subtitle, data: next.data, table: next.table });
        var fresh = ui.sourceTag(next.sources);
        tag.parentNode.replaceChild(fresh, tag);
        tag = fresh;
      }
    });
    chart.el.appendChild(tag);
    return chart.el;
  }

  /* ------------------------------------------------------------------ exceptions */

  function findPayout(env, id) {
    var lists = [env.payouts, env.allPayouts, env.tail];
    for (var i = 0; i < lists.length; i++) {
      var hit = byId((lists[i] && lists[i].rows) || [], id);
      if (hit) return hit;
    }
    return null;
  }

  function openFlag(env, flag) {
    if (flag.type === 'markup') { openMarkup(env, flag); return; }
    var payout = flag.payoutId ? findPayout(env, flag.payoutId) : null;
    if (payout) openPayout(env, payout);
    else ui.toast('The payout cycle behind this exception is outside your scope.', { tone: 'info' });
  }

  function exceptionRow(env, flag) {
    var sev = SEVERITY[flag.severity] || SEVERITY.low;
    var type = FLAG_TYPES[flag.type] || { label: flag.type, icon: 'alert-triangle', amountLabel: 'at stake' };
    var payout = flag.payoutId ? findPayout(env, flag.payoutId) : null;
    return h('button', { type: 'button', 'class': ['ra-ex', 'ra-ex--' + sev.tone], onClick: function () { openFlag(env, flag); } },
      h('span', { 'class': 'ra-ex__icon' }, ui.icon(type.icon, 16)),
      h('span', { 'class': 'ra-ex__main' },
        h('span', { 'class': 'ra-ex__title' }, flag.title),
        h('span', { 'class': 'ra-ex__detail' }, flag.detail),
        h('span', { 'class': 'ra-ex__meta' },
          ui.chip(sev.label, sev.tone, { title: sev.label + ' severity' }), ui.chip(type.label),
          payout ? ui.statusChip(payout.status) : null,
          h('span', { 'class': 'ra-ex__go' }, flag.type === 'markup' ? 'Open price check' : 'Open payout cycle', ui.icon('chevron-right', 12)))),
      h('span', { 'class': 'ra-ex__metric' },
        h('span', { 'class': 'ra-ex__value' }, fmt.inrFull(flag.amount)),
        h('span', { 'class': 'ra-ex__label' }, type.amountLabel)));
  }

  /* how many payout cycles the carried exceptions sit on (one cycle can trip two rules) */
  function carriedCycles(list) {
    var seen = {}, n = 0;
    list.forEach(function (fl) { if (fl.payoutId && !seen[fl.payoutId]) { seen[fl.payoutId] = true; n++; } });
    return n;
  }

  /* What the markup rule looked at, so the flagged dishes are not read as the whole pricing story (API-sales 2.8). */
  function markupNote(env) {
    var ms = (env.flags && env.flags.markupSummary) || null;
    if (!ms || !(ms.listings > 0) || !ms.breakEvenMarkupPct) return null;
    var span = ms.breakEvenMarkupPct;
    return note('Menu prices: ' + fmt.num(ms.belowBreakEven) + ' of ' + plural(ms.listings, 'aggregator listing') +
      ' realise less than the counter price once the discount share and the charges are taken (break-even markup ' +
      fmt.pct(span.min, 0) + ' to ' + fmt.pct(span.max, 0) + ' by outlet). Only the ' + fmt.num(ms.belowTakeRate) +
      ' whose markup does not even cover the take rate are raised as exceptions, one per dish.', 'info');
  }

  function exceptionsCard(env) {
    var st = env.st;
    var current = (env.flags && env.flags.flags) || [];
    var seen = {};
    current.forEach(function (fl) { seen[fl.id] = true; });
    /* a cycle that is still short-paid or disputed stays on the list whatever the date filter says */
    var carried = ((env.allFlags && env.allFlags.flags) || []).filter(function (fl) {
      if (seen[fl.id] || !fl.payoutId) return false;
      var p = findPayout(env, fl.payoutId);
      return !!p && UNRESOLVED[p.status] === true;
    });
    var all = current.length + carried.length;
    var body = h('div', { 'class': 'ra-exlist' });

    function group(title, list, limit) {
      if (!list.length) return;
      body.appendChild(h('div', { 'class': 'ra-exgroup' }, h('span', { 'class': 'mk-eyebrow' }, title), h('span', { 'class': 'ra-exgroup__count' }, fmt.num(list.length))));
      list.slice(0, limit).forEach(function (fl) { body.appendChild(exceptionRow(env, fl)); });
    }

    if (!all) {
      body.appendChild(ui.emptyState('No exceptions in this selection', 'Every settled cycle is within tolerance of its contract terms, ads are in line with their trailing share and no aggregator price sits below the take rate.',
        { icon: 'check-circle', compact: true }));
    } else {
      var room = st.exAll ? Infinity : EXCEPTIONS_SHOWN;
      var carriedShown = Math.min(carried.length, room);
      group('Unresolved from other periods', carried, carriedShown);
      group(env.flags ? 'In ' + rangeLabel(env.flags.from, env.flags.to) : 'In this period', current, Math.max(0, room - carriedShown));
      if (all > EXCEPTIONS_SHOWN) {
        body.appendChild(h('div', { 'class': 'ra-exmore' }, ui.button({
          label: st.exAll ? 'Show fewer' : 'Show all ' + fmt.num(all), variant: 'text', size: 'sm', iconRight: st.exAll ? 'chevron-up' : 'chevron-down',
          onClick: function () { st.exAll = !st.exAll; env.ctx.rerender(); }
        })));
      }
    }

    /* Two different kinds of money: what an aggregator deducted and what a menu price gave away. They are never added up. */
    var onStatement = current.filter(function (fl) { return fl.type !== 'markup'; });
    var onMenu = current.filter(function (fl) { return fl.type === 'markup'; });
    var kinds = [];
    if (onStatement.length) kinds.push(fmt.inr(total(onStatement, function (fl) { return fl.amount; })) + ' of aggregator deductions to question');
    if (onMenu.length) kinds.push(fmt.inr(total(onMenu, function (fl) { return fl.amount; })) + ' of realisation lost on under-priced listings');
    var subtitle = all ? plural(current.length, 'exception') + ' in the range' + (kinds.length ? ': ' + andList(kinds) : '') +
      (carried.length ? '. ' + fmt.inrFull(total(carried, function (fl) { return fl.amount; })) + ' on ' + plural(carriedCycles(carried), 'cycle') + ' of earlier periods is still unresolved' : '') +
      '. Highest severity first.' : 'Rules run on every settled statement and on the menu prices in force';
    var sources = ((env.ce && env.ce.sources.actual) || []).concat(['petpooja']);
    return ui.card({ title: 'Exceptions', subtitle: subtitle, flush: true, className: 'ra-excard',
      body: fill([body, tableFoot([markupNote(env), sourceFlat(sources)])]) });
  }

  /* Markup check of one dish: POS price vs aggregator price per outlet against what the aggregator keeps there. */
  function openMarkup(env, flag) {
    var data = flag.data || {}, outlets = data.outlets || [], stale = data.stalePriceChange;
    var sev = SEVERITY[flag.severity] || SEVERITY.low;
    var rows = outlets.map(function (o) {
      return { outlet: outletName(o.outletId), posPrice: o.posPrice, aggPrice: o.aggPrice, markupPct: o.markupPct, takeRate: o.effectiveTakeRate,
        breakEven: isNum(o.breakEvenMarkupPct) ? o.breakEvenMarkupPct : null,
        realised: o.realisationPerPortion, gap: o.realisationPerPortion - o.posPrice, qty: o.qty };
    });
    /* the break-even markup is a newer field of the rule: shown when the data layer supplies it, else the take rate alone */
    var hasBreakEven = rows.length > 0 && rows.every(function (r) { return r.breakEven !== null; });
    var d = ui.drawer({
      title: flag.title, subtitle: rangeLabel(env.flags.from, env.flags.to), width: 560,
      headerExtra: ui.chip(sev.label + ' severity', sev.tone),
      body: overlayBody([
        h('p', { 'class': 'ra-lead' }, flag.detail + '.'),
        stale ? ui.callout('warn', 'Price change not mirrored on the aggregator list',
          'The POS price moved from ' + fmt.inrFull(stale.from) + ' to ' + fmt.inrFull(stale.to) + ' on ' + day(stale.date) + (stale.note ? ' (' + lowerFirst(stale.note) + ')' : '') +
          '; the aggregator menus still carry the old markup.') : null,
        ui.keyValue([['Realisation lost in the range', h('strong', null, fmt.inrFull(flag.amount))],
          ['Aggregator portions in the range', fmt.num(total(outlets, function (o) { return o.qty; }))]]),
        ui.table({
          dense: true,
          columns: [
            { key: 'outlet', label: 'Outlet', render: function (v, r) { return h('div', null, h('div', null, v), hasBreakEven ? h('div', { 'class': 'mk-xs mk-muted' }, 'take rate ' + fmt.pct(r.takeRate)) : null); } },
            { key: 'posPrice', label: 'POS', format: 'inrFull', title: 'In-store menu price' },
            { key: 'aggPrice', label: 'Aggregator', align: 'right', title: 'Price on the aggregator menu of this outlet, and its markup over the POS price',
              render: function (v, r) { return h('div', null, h('div', null, fmt.inrFull(v)), h('div', { 'class': 'mk-xs mk-muted' }, fmt.pct(r.markupPct) + ' markup')); } },
            hasBreakEven
              ? { key: 'breakEven', label: 'Break-even', align: 'right', title: 'Markup at which a delivery portion nets the POS price, given the outlet\'s discount share and effective take rate (settled orders, trailing weeks)',
                render: function (v) { return fmt.pct(v); } }
              : { key: 'takeRate', label: 'Take rate', format: 'pct', title: 'Effective take rate of the outlet: settled orders, trailing weeks' },
            { key: 'realised', label: 'Realised', align: 'right', title: 'Aggregator price less the discount share and the take rate, per portion - and how far that is from the POS price',
              render: function (v, r) {
                return h('div', null, h('div', null, fmt.inrFull(Math.round(v))),
                  h('div', { 'class': ['mk-xs', r.gap < 0 ? 'mk-bad' : 'mk-good'] }, signed(Math.round(r.gap)) + ' vs POS'));
              } },
            { key: 'qty', label: 'Qty', format: 'num', title: 'Aggregator portions sold in the range' }
          ],
          rows: rows
        }),
        note('A delivery portion should net at least the in-store price. Realised = aggregator price x (1 - discount share) x (1 - effective take rate)' +
          (hasBreakEven ? '; the break-even markup is the markup at which that equals the POS price' : '') +
          '. Both menu prices are the restaurant\'s own data; the take rate comes from the settled statements.', 'info'),
        ui.sourceTag(['petpooja'].concat((env.ce && env.ce.sources.actual) || []))
      ]),
      footer: [
        ui.button({ label: 'Dish prices and markup', icon: 'dish', onClick: function () { d.close(); env.ctx.navigate('revenue-dishes'); } }),
        ui.button({ label: 'Close', variant: 'primary', onClick: function () { d.close(); } })
      ]
    });
  }

  /* ------------------------------------------------------------------ GST and TDS handling */

  function taxRow(o) {
    return h('div', { 'class': 'ra-tax' },
      h('div', { 'class': 'ra-tax__main' },
        h('div', { 'class': 'ra-tax__title' }, o.dotVar ? dot(o.dotVar) : null, o.title),
        h('div', { 'class': 'ra-tax__text' }, o.text)),
      h('div', { 'class': 'ra-tax__side' },
        h('div', { 'class': 'ra-tax__amount' }, o.amount),
        o.extra ? h('div', { 'class': 'ra-tax__extra' }, o.extra) : null,
        ui.chip(o.treatment, o.tone, { icon: o.icon })));
  }

  function taxCard(env) {
    var split = (env.flags && env.flags.gstSplit) || { collectedByRestaurant: 0, memoByAggregator: {} };
    var ce = env.ce, act = ce.total.actual, est = ce.total.estimated;
    var gst = cfg().gst || {};
    var salesRate = isNum(gst.salesPct) ? fmt.pct(gst.salesPct, 0) + ' ' : '';
    var pos = (cfg().channels || []).filter(function (c) { return c.kind === 'pos'; })[0];
    var inFilter = function (id) { return !env.f.channelIds || has(env.f.channelIds, id); };
    var memoTotal = 0, rows = [];

    if (pos && inFilter(pos.id)) {
      rows.push(taxRow({
        dotVar: pos.colourVar, title: salesRate + 'GST on in-store bills',
        text: 'Collected by the restaurant on the ' + pos.label + ' bill and paid by the restaurant with its return.',
        amount: supplies(pos.id, 'order.gst') ? fmt.inrFull(split.collectedByRestaurant) : ui.notProvided(pos.label),
        treatment: 'Payable', tone: 'warn', icon: 'receipt'
      }));
    }
    aggregators().forEach(function (ch) {
      if (!inFilter(ch.id)) return;
      var v = split.memoByAggregator ? split.memoByAggregator[ch.id] : null;
      if (isNum(v)) memoTotal += v;
      rows.push(taxRow({
        dotVar: ch.colourVar, title: salesRate + 'GST on ' + ch.label + ' orders',
        text: 'Collected from the customer and paid to the government by ' + ch.label + ' under section 9(5). Never restaurant revenue, never payable by the restaurant.',
        amount: supplies(ch.id, 'order.gst') ? fmt.inrFull(isNum(v) ? v : 0) : ui.notProvided(ch.label),
        treatment: 'Memo only', tone: 'neutral', icon: 'info'
      }));
    });
    if (ce.channels.length) {
      var feeRate = isNum(gst.onAggregatorFeesPct) ? fmt.pct(gst.onAggregatorFeesPct, 0) + ' ' : '';
      rows.push(taxRow({
        title: feeRate + 'GST on aggregator fees',
        text: 'Charged by the aggregators on their fees and deducted from the payout. A ' + salesRate.trim() + ' restaurant takes no input credit, so it is a real cost.',
        amount: act.orders > 0 ? fmt.inrFull(act.gstOnFees) : '-',
        extra: est.orders > 0 ? [ui.estimateBadge(), ' ' + fmt.inrFull(est.gstOnFees) + ' more'] : null,
        treatment: 'Cost', tone: 'serious', icon: 'coins'
      }));
      rows.push(taxRow({
        title: (termsOf(ce.channels[0].channelId) || {}).tdsLabel || 'TDS by e-commerce operator',
        text: 'Withheld by the aggregators from each payout. It is a tax credit claimed back in the return - an asset, not an expense.',
        amount: act.orders > 0 ? fmt.inrFull(act.tds) : '-',
        extra: est.orders > 0 ? [ui.estimateBadge(), ' ' + fmt.inrFull(est.tds) + ' more'] : null,
        treatment: 'Receivable', tone: 'good', icon: 'shield-check'
      }));
    }

    var charged = split.collectedByRestaurant + memoTotal;
    var netOfGst = 'Sales everywhere on this system are net of GST.';
    var subtitle = netOfGst;
    if (split.collectedByRestaurant > 0 && memoTotal > 0) {
      subtitle = 'Customers were charged ' + fmt.inr(charged) + ' of GST in the range; only ' + fmt.inr(split.collectedByRestaurant) + ' (' +
        fmt.pct(share(split.collectedByRestaurant, charged)) + ') is for the restaurant to pay. ' + netOfGst;
    } else if (memoTotal > 0) {
      subtitle = 'The ' + fmt.inr(memoTotal) + ' of GST on these orders was collected and paid by the aggregators: none of it is for the restaurant to pay. ' + netOfGst;
    } else if (split.collectedByRestaurant > 0) {
      subtitle = 'The ' + fmt.inr(split.collectedByRestaurant) + ' of GST on in-store bills is for the restaurant to pay. ' + netOfGst;
    }
    var sources = ['petpooja'];
    if (ce.channels.length && act.orders > 0) sources = sources.concat(ce.sources.actual);
    if (ce.channels.length && est.orders > 0) sources.push(ce.sources.estimated);
    return ui.card({ title: 'GST and TDS handling', subtitle: subtitle, flush: true, className: 'ra-taxcard',
      body: fill([h('div', { 'class': 'ra-taxlist' }, rows), tableFoot([sourceFlat(sources)])]) });
  }

  /* ------------------------------------------------------------------ payout reconciliation */

  function reasonSentences(row) {
    var who = channelName(row.channelId), tol = tolerance(), out = [];
    (row.reasons || []).forEach(function (r) {
      if (r.code === 'COMMISSION_RATE_ABOVE_CONTRACT') {
        out.push(who + ' charged its service fee at ' + fmt.pct(r.chargedPct) + ' against the contracted ' + fmt.pct(r.contractPct) +
          ' (assumed). The extra fee and the GST on it come to ' + fmt.inrFull(r.amount) + '.');
      } else if (r.code === 'UNCLASSIFIED_DEDUCTION') {
        out.push('The statement carries a deduction of ' + fmt.inrFull(r.amount) + ' with no classification. It is treated as short-paid until ' + who + ' explains it.');
      } else if (r.detail) {
        out.push(r.detail + (isNum(r.amount) ? ' (' + fmt.inrFull(r.amount) + ').' : '.'));
      }
    });
    if (row.dispute) {
      out.push('A dispute for ' + fmt.inrFull(row.dispute.amount) + ' was raised on ' + day(row.dispute.raisedOn) + ' and is ' + String(row.dispute.status || '').toLowerCase() + '.');
    } else if (row.status === 'SHORT_PAID') {
      out.push('No dispute has been raised yet.');
    }
    if (row.status === 'MATCHED') {
      out.push('The bank credit agrees with the expected payout' + (tol === null ? '.' : ' within the tolerance of ' + fmt.inrFull(tol) + '.') +
        ' Ads and refunds are taken as billed, so a variance can only come from a rate above contract or an unclassified deduction.');
    }
    if (row.status === 'AWAITING_STATEMENT') {
      out.push('The period is over but the ' + ((termsOf(row.channelId) || {}).statementName || 'statement') + ' has not been uploaded. It was expected on ' +
        day(row.settlementDate, 'EEE d MMM') + ' (' + dueText(row.settlementDate) + '). Until then every figure below is an estimate at assumed contract rates.');
    }
    if (row.status === 'IN_CYCLE') {
      out.push('The cycle is still running through ' + day(row.period.to, 'EEE d MMM') + '; its statement is expected on ' + day(row.settlementDate, 'EEE d MMM') +
        '. Every figure below is an estimate at assumed contract rates for the orders so far.');
    }
    return out;
  }

  function payoutLines(row) {
    var ch = row.channelId, st = row.statement, ex = row.expected || {};
    return LINES.map(function (ln) {
      var e = ex[ln.payout], s = st ? st[ln.payout] : null, sub = null;
      if (ln.id === 'serviceFee') {
        sub = 'Rate ' + fmt.pct(ex.serviceFeePct) + ' expected' + (st ? ', ' + fmt.pct(st.serviceFeePct) + ' charged' : '');
      } else if (ln.id === 'otherDeductions') {
        var det = (st || ex).otherDeductionsDetail;
        var feeName = (termsOf(ch) || {}).otherFeeLabel || 'Platform fees';
        if (det) sub = feeName + ' ' + fmt.inrFull(det.platformFees) + (det.unclassified ? ', unclassified ' + fmt.inrFull(det.unclassified) : '');
      }
      var diff = isNum(e) && isNum(s) ? s - e : null;
      return { id: ln.id, kind: ln.kind, line: lineLabel(ln, ch), sub: sub, expected: isNum(e) ? e : null, statement: s, diff: diff,
        adverse: isNum(diff) && ((ln.kind === 'minus' && diff > 0) || (ln.id === 'netPayout' && diff < 0)),
        provided: supplies(ch, ln.cap) };
    });
  }

  function openPayout(env, row, onClose) {
    var who = channelName(row.channelId), settled = !!row.statement;
    var lines = payoutLines(row);
    var toneOf = { MATCHED: 'good', SHORT_PAID: 'critical', DISPUTED: 'serious', AWAITING_STATEMENT: 'warn', IN_CYCLE: 'info' };
    var titleOf = { MATCHED: 'Matched to the bank credit', SHORT_PAID: 'Paid less than expected', DISPUTED: 'Short payment under dispute',
      AWAITING_STATEMENT: 'Statement not uploaded yet', IN_CYCLE: 'Cycle still running' };
    var columns = [
      { key: 'line', label: 'Line', render: function (v, r) {
        return h('div', null, h('div', { 'class': r.kind === 'total' ? 'mk-strong' : null }, r.kind === 'minus' ? less(v) : v), r.sub ? h('div', { 'class': 'mk-xs mk-muted' }, r.sub) : null);
      } },
      { key: 'expected', label: settled ? 'Expected' : 'Estimated', format: 'inrFull', title: 'At assumed contract terms' }
    ];
    if (settled) {
      columns.push({ key: 'statement', label: 'Statement', align: 'right', render: function (v, r) { return r.provided ? fmt.inrFull(v) : ui.notProvided(who); } });
      columns.push({ key: 'diff', label: 'Difference', align: 'right', render: function (v, r) {
        if (!isNum(v) || !r.provided) return h('span', { 'class': 'mk-faint' }, '-');
        if (v === 0) return h('span', { 'class': 'mk-muted' }, fmt.inrFull(0));
        return h('span', { 'class': r.adverse ? 'mk-bad mk-strong' : 'mk-strong' }, signed(v));
      } });
    }
    var sentences = reasonSentences(row);
    var memo = (row.statement || row.expected || {}).gstRetained9_5;
    var d = ui.drawer({
      title: who + ' payout - ' + outletName(row.outletId),
      /* the period label already carries a dash ("14 Sep - 20 Sep"), so the parts are separated by commas, as elsewhere */
      subtitle: [row.period.label + (row.partial ? ' (part cycle)' : ''), plural(row.orderCount, 'order'), row.id].join(', '),
      headerExtra: ui.statusChip(row.status), width: 560, onClose: onClose,
      body: overlayBody([
        ui.callout(toneOf[row.status] || 'neutral', titleOf[row.status] || null, h('div', { 'class': 'ra-reasons' }, sentences.map(function (s) { return h('p', null, s); }))),
        ui.keyValue([
          ['Period', supplies(row.channelId, 'payout.period') ? rangeLabel(row.period.from, row.period.to) : ui.notProvided(who)],
          [settled ? 'Settled on' : 'Statement expected', supplies(row.channelId, 'payout.settlementDate') ? day(row.settlementDate, 'EEE d MMM') + ' ' + row.settlementDate.slice(0, 4) : ui.notProvided(who)],
          ['Bank UTR', !supplies(row.channelId, 'payout.utr') ? ui.notProvided(who) : (row.utr ? h('span', { 'class': 'ra-mono' }, row.utr) : h('span', { 'class': 'mk-muted' }, 'Arrives with the statement'))],
          ['Expected payout', settled ? fmt.inrFull(row.expected.netPayout) : [fmt.inrFull(row.expected.netPayout), ' ', ui.estimateBadge()]],
          ['Actual payout', settled ? h('strong', null, fmt.inrFull(row.statement.netPayout)) : h('span', { 'class': 'mk-muted' }, 'Awaiting the statement')],
          ['Variance', settled ? h('span', { 'class': row.variance > (tolerance() || 0) ? 'mk-bad mk-strong' : null }, fmt.inrFull(row.variance) + (row.variance > (tolerance() || 0) ? ' short' : '')) : null]
        ]),
        h('div', { 'class': 'ra-linehead' },
          h('h4', { 'class': 'mk-h3' }, settled ? 'Statement lines against the contract' : 'Estimated lines'),
          settled ? null : ui.estimateBadge()),
        ui.table({ dense: true, columns: columns, rows: lines, rowClass: function (r) { return r.kind === 'total' ? 'is-strong' : ''; } }),
        isNum(memo) && supplies(row.channelId, 'payout.gstRetained9_5')
          ? note('Memo: ' + fmt.inrFull(memo) + ' of GST on these orders was collected and paid by ' + who + ' under section 9(5). It is not part of the payout arithmetic, not revenue and not payable by the restaurant.', 'info') : null,
        ui.sourceTag(settled ? [row.source] : ['petpooja', 'estimate'])
      ]),
      footer: [
        ui.button({ label: 'Lines as CSV', icon: 'download', onClick: function () {
          ui.downloadCsv(row.id + '.csv', [{ key: 'line', label: 'Line' }, { key: 'expected', label: settled ? 'Expected' : 'Estimated' },
            { key: 'statement', label: 'Statement' }, { key: 'diff', label: 'Difference' }], lines);
        } }),
        ui.button({ label: 'Close', variant: 'primary', onClick: function () { d.close(); } })
      ]
    });
    return d;
  }

  function reconRows(payouts) {
    return ((payouts && payouts.rows) || []).map(function (r) {
      return { id: r.id, raw: r, period: r.period.label, periodFrom: r.period.from, outlet: outletName(r.outletId), channel: channelName(r.channelId),
        settlementDate: r.settlementDate, utr: r.utr, expected: r.expected ? r.expected.netPayout : null, actual: r.statement ? r.statement.netPayout : null,
        variance: r.variance, status: r.status, estimated: !!r.estimated };
    });
  }

  /**
   * The kit's table sorts only the rows it is handed, so a capped table has to be sorted before it is cut - otherwise
   * "worst variance first" would mean "worst of the first sixty". Same rules as the kit: the value comes from the
   * column's sortValue or its key, delta objects sort by .value, numbers compare numerically, blanks go last and ties
   * keep their original order.
   */
  function sortValueOf(col, row) {
    var v = typeof col.sortValue === 'function' ? col.sortValue(row) : row[col.key];
    if (v && typeof v === 'object' && 'value' in v) v = v.value;
    return v;
  }

  function isBlank(v) { return v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v)); }

  function compareValues(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
  }

  function sortRows(rows, columns, sort) {
    if (!sort || !sort.key) return rows;
    var col = null;
    columns.forEach(function (c) { if (c && c.key === sort.key) col = c; });
    if (!col) return rows;
    var sign = sort.dir === 'asc' ? 1 : -1;
    return rows.map(function (r, i) { return { r: r, i: i, v: sortValueOf(col, r) }; }).sort(function (x, y) {
      var xb = isBlank(x.v), yb = isBlank(y.v);
      if (xb || yb) return xb && yb ? x.i - y.i : (xb ? 1 : -1);
      return sign * compareValues(x.v, y.v) || x.i - y.i;
    }).map(function (x) { return x.r; });
  }

  function reconCard(env) {
    var st = env.st, p = env.payouts, tol = tolerance() || 0;
    var rows = reconRows(p);
    st.status = st.status && (st.status === 'ALL' || has(STATUSES, st.status)) ? st.status : 'ALL';
    var shown = st.status === 'ALL' ? rows : rows.filter(function (r) { return r.status === st.status; });
    var settledRows = shown.filter(function (r) { return !r.estimated; }), openRows = shown.filter(function (r) { return r.estimated; });

    var tabs = ui.tabs({
      ariaLabel: 'Payout status', value: st.status,
      items: [{ id: 'ALL', label: 'All', count: rows.length }].concat(STATUSES.map(function (s) {
        return { id: s, label: ui.statusInfo(s).label, count: p.byStatus && p.byStatus[s] ? p.byStatus[s].count : 0 };
      })),
      onChange: function (id) { st.status = id; st.allCycles = false; env.ctx.rerender(); }
    });

    var columns = [
      { key: 'period', label: 'Cycle', sortValue: function (r) { return r.periodFrom; }, render: function (v, r) { return r.raw.partial ? h('span', { title: 'Part cycle: the data starts inside it' }, v + ' *') : v; } },
      { key: 'outlet', label: 'Outlet' },
      { key: 'channel', label: 'Channel', render: ui.cells.entity(function (r) { var c = channelInfo(r.raw.channelId); return c ? c.colourVar : null; }) },
      { key: 'settlementDate', label: 'Settled', title: 'Date of the bank credit; for a cycle without a statement, the date it is due',
        render: function (v, r) { return r.estimated ? h('span', { 'class': 'mk-muted', title: 'Statement due ' + day(v, 'EEE d MMM') + ', ' + dueText(v) }, 'due ' + day(v, 'd MMM')) : day(v, 'd MMM'); } },
      { key: 'utr', label: 'UTR', render: function (v) { return v ? h('span', { 'class': 'ra-mono' }, v) : h('span', { 'class': 'mk-faint' }, '-'); } },
      { key: 'expected', label: 'Expected', format: 'inrFull', render: function (v, r) { return r.estimated ? h('span', { 'class': 'ra-est' }, ui.estimateBadge('Est.'), fmt.inrFull(v)) : fmt.inrFull(v); } },
      { key: 'actual', label: 'Actual', format: 'inrFull' },
      { key: 'variance', label: 'Variance', format: 'inrFull', title: 'Expected minus actual: a positive figure is money not received',
        render: function (v) {
          if (!isNum(v)) return h('span', { 'class': 'mk-faint' }, '-');
          return h('span', { 'class': v > tol ? 'mk-bad mk-strong' : (v === 0 ? 'mk-muted' : null) }, fmt.inrFull(v));
        } },
      /* the longest label is shortened inside the table so that nine columns fit a 1280px window; the tab above spells it out */
      { key: 'status', label: 'Status', render: function (v) { return v === 'AWAITING_STATEMENT' ? ui.statusChip(v, { label: 'Awaiting', title: ui.statusInfo(v).label }) : ui.statusChip(v); } }
    ];

    /* one footer row: sticky footer rows of a scrolling kit table would sit on top of each other */
    var footer = null, openExpected = total(openRows, function (r) { return r.expected; });
    if (settledRows.length) {
      footer = { period: 'Settled', outlet: plural(settledRows.length, 'cycle'),
        expected: total(settledRows, function (r) { return r.expected; }), actual: total(settledRows, function (r) { return r.actual; }),
        variance: total(settledRows, function (r) { return r.variance; }) };
    } else if (openRows.length) {
      footer = { period: 'Not settled', outlet: plural(openRows.length, 'cycle'),
        expected: h('span', { 'class': 'ra-est' }, ui.estimateBadge('Est.'), fmt.inrFull(openExpected)) };
    }

    var unresolvedElsewhere = ((env.allPayouts && env.allPayouts.rows) || []).filter(function (r) { return UNRESOLVED[r.status] && !byId(rows, r.id); });
    var empty = ui.emptyState(rows.length ? 'No ' + lowerFirst(ui.statusInfo(st.status).label) + ' cycles in ' + rangeLabel(p.from, p.to) : 'No payout cycle overlaps this selection',
      rows.length ? (UNRESOLVED[st.status] && unresolvedElsewhere.length ? plural(unresolvedElsewhere.length, 'unresolved cycle') + ' sit outside this date range.' : 'Pick another status or widen the date range.')
        : 'Payout cycles exist for Swiggy and Zomato orders only. Include an aggregator in the channel filter or widen the date range.',
      { icon: 'wallet', compact: true, action: rows.length && UNRESOLVED[st.status] && unresolvedElsewhere.length
        ? ui.button({ label: 'Show the financial year to date', size: 'sm', onClick: function () { MK.filters.set({ preset: 'fytd' }); } }) : null });

    /* sorted over every cycle in the selection, then cut: the footer totals, the subtitle and the CSV stay over the whole set */
    var ordered = sortRows(shown, columns, st.sort);
    var capped = !st.allCycles && ordered.length > RECON_SHOWN;
    var table = ui.table({
      dense: true, sortable: true, columns: columns, rows: capped ? ordered.slice(0, RECON_SHOWN) : ordered,
      footer: footer, maxHeight: RECON_MAX_HEIGHT, empty: empty,
      sort: st.sort || null, onSort: function (s) { st.sort = s; env.ctx.rerender(); },
      onRowClick: function (r) { openPayout(env, r.raw); }
    });

    var t = p.totals || {};
    var settledCount = rows.filter(function (r) { return !r.estimated; }).length;
    var subtitle = 'One row per outlet, aggregator and payout cycle';
    if (rows.length) {
      subtitle = plural(rows.length, 'cycle') + ' overlap ' + rangeLabel(p.from, p.to) + ': ' + (settledCount
        ? fmt.num(settledCount) + ' settled for ' + fmt.inr(t.actual) + ' against ' + fmt.inr(t.expected) + ' expected (' + (t.variance > tol ? fmt.inrFull(t.variance) + ' short' : 'no variance') + ')' +
          (t.awaiting > 0 ? '; ' + fmt.inr(t.awaiting) + ' more is estimated and waits for its statement' : '')
        : 'none has its statement yet, ' + fmt.inr(t.awaiting) + ' is estimated') + '. Open a row for the statement lines.';
    }

    var sources = [];
    rows.forEach(function (r) { var s = r.estimated ? 'estimate' : r.raw.source; if (s && !has(sources, s)) sources.push(s); });

    return ui.card({
      title: 'Payout reconciliation', subtitle: subtitle, flush: true, className: 'ra-recon',
      actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', disabled: !shown.length, onClick: function () {
        ui.downloadCsv('payout-reconciliation.csv', [
          { key: 'id', label: 'Cycle id' }, { key: 'period', label: 'Period' }, { key: 'outlet', label: 'Outlet' }, { key: 'channel', label: 'Aggregator' },
          { key: 'settlementDate', label: 'Settlement date' }, { key: 'utr', label: 'UTR' }, { key: 'expected', label: 'Expected' }, { key: 'actual', label: 'Actual' },
          { key: 'variance', label: 'Variance' }, { key: 'status', label: 'Status' }, { key: 'estimated', label: 'Estimated', value: function (r) { return r.estimated ? 'yes' : 'no'; } }
        ], shown);
      } }),
      body: [h('div', { 'class': 'ra-recon__tabs' }, tabs), table, tableFoot([
        /* what the table holds is said plainly: the totals under it and the CSV always cover every cycle in the selection */
        capped ? h('p', { 'class': 'ra-note ra-recon__more' }, ui.icon('list', 14),
          h('span', null, 'Showing ' + fmt.num(RECON_SHOWN) + ' of ' + plural(ordered.length, 'cycle') +
            (st.sort ? ', sorted as you asked' : ', newest first') + '. The totals below and the CSV cover all of them.'),
          ui.button({ label: 'Show all ' + fmt.num(ordered.length), variant: 'text', size: 'sm',
            onClick: function () { st.allCycles = true; env.ctx.rerender(); } })) : null,
        note('Matched = the bank credit is within ' + fmt.inrFull(tol) + ' of the expected payout at assumed contract terms. Cycles follow each aggregator\'s calendar week; orders are matched by order id because a business day runs past midnight.' +
          (shown.some(function (r) { return r.raw.partial; }) ? ' * = part cycle: the data starts inside it.' : ''), 'info'),
        sources.length ? sourceFlat(sources) : null
      ])]
    });
  }

  /* ------------------------------------------------------------------ page */

  function render(rootEl, ctx) {
    var st = ctx.state, f = ctx.filters || {};
    var cal = MK.calendar || {};
    var env = { ctx: ctx, st: st, f: f };

    env.ce = guard('channelEconomics', function () { return MK.data.channelEconomics(f); }, null);
    env.payouts = guard('payouts', function () { return MK.data.payouts(f); }, null);
    env.flags = guard('auditFlags', function () { return MK.data.auditFlags(f); }, null);
    /* open items are a balance, not a flow: read them over the whole data range, same outlet and channel filters */
    var wide = { from: cal.dataStart, to: cal.dataEnd, outletIds: f.outletIds, channelIds: f.channelIds };
    env.allPayouts = guard('payouts (all periods)', function () { return MK.data.payouts(wide); }, null);
    env.allFlags = guard('auditFlags (all periods)', function () { return MK.data.auditFlags(wide); }, null);
    /* statement status is a fact of the system, not of the filter: cycles newer than the oldest "settled through" */
    env.tail = guard('payouts (unsettled)', function () {
      var through = aggregators().map(function (c) { return (termsOf(c.id) || {}).settledThrough; }).filter(Boolean).sort()[0];
      return through && cal.dataEnd && through < cal.dataEnd ? MK.data.payouts({ from: MK.dates.addDays(through, 1), to: cal.dataEnd }) : null;
    }, null);
    /* the same cycles narrowed to the outlets on screen, so the strip never quotes an amount the rest of the page leaves out */
    env.tailScoped = !env.tail || !f.outletIds || !f.outletIds.length ? env.tail
      : guard('payouts (unsettled, selected outlets)', function () {
        return MK.data.payouts({ from: env.tail.from, to: env.tail.to, outletIds: f.outletIds });
      }, env.tail);

    if (!env.ce || !env.ce.total) {
      rootEl.appendChild(ui.emptyState('The audit figures are not available', 'The sales data layer did not answer. Reload the page; if this stays, reset the demo data from the menu at the top right.', { icon: 'alert-triangle' }));
      return;
    }

    rootEl.appendChild(intro(env));
    safe(rootEl, 'Scope note', function () { return scopeNote(ctx); });
    safe(rootEl, 'Statement status', function () { return statusStrip(env); });

    var ce = env.ce;
    var anyOrders = ce.channels.length && (ce.total.actual.orders > 0 || ce.total.estimated.orders > 0);
    if (!anyOrders) {
      var onlyPos = f.channelIds && f.channelIds.length && !ce.channels.length;
      rootEl.appendChild(ui.card({ body: ui.emptyState(onlyPos ? 'The channel filter holds in-store sales only' : 'No aggregator orders in this selection',
        onlyPos ? 'Commission, payouts and statements exist for Swiggy and Zomato orders. In-store bills carry no aggregator fees; their GST is shown below.'
          : 'Widen the date range or the outlet filter to audit commissions and payouts.',
        { icon: 'filter', action: onlyPos ? ui.button({ label: 'Include Swiggy and Zomato', variant: 'primary', onClick: function () { MK.filters.set({ channelIds: null }); } }) : null }) }));
      safe(rootEl, 'GST and TDS handling', function () { return taxCard(env); });
      return;
    }

    safe(rootEl, 'Key figures', function () { return kpiBlock(env); });

    if (ce.total.actual.orders > 0) {
      var tailHost = h('div', { 'class': 'ra-cell' });
      safe(rootEl, 'Money trail', function () { moneyTrail(env, rootEl, tailHost); return null; });
      var rateHost = h('div', { 'class': 'ra-cell' });
      safe(rateHost, 'Take rates', function () { return takeRates(env); });
      /* start-aligned: a card stops at its content instead of stretching into a half-empty panel */
      rootEl.appendChild(ui.grid([7, 5], [tailHost, rateHost], { className: 'ra-pair', start: true }));
    } else {
      safe(rootEl, 'Unsettled tail', function () { tailOnly(env, rootEl); return null; });
    }

    var exHost = h('div', { 'class': 'ra-cell' }), taxHost = h('div', { 'class': 'ra-cell' });
    safe(exHost, 'Exceptions', function () { return exceptionsCard(env); });
    safe(taxHost, 'GST and TDS handling', function () { return taxCard(env); });
    rootEl.appendChild(ui.grid([7, 5], [exHost, taxHost], { className: 'ra-pair', start: true }));

    safe(rootEl, 'Payout reconciliation', function () { return env.payouts ? reconCard(env) : null; });

    /* deep link: #/revenue/audit?payout=<cycle id> opens the cycle once; closing it takes the id out of the hash */
    var wanted = ctx.params && ctx.params.payout;
    if (wanted && st.opened !== wanted) {
      st.opened = wanted;
      var hit = findPayout(env, wanted);
      if (hit) {
        openPayout(env, hit, function () {
          st.opened = null;
          var cur = MK.router.current();
          if (cur && cur.page.id === 'revenue-audit' && cur.params.payout === wanted) ctx.navigate('revenue-audit', null, { replace: true });
        });
      }
    }
  }

  MK.router.register({
    id: 'revenue-audit',
    route: '#/revenue/audit',
    group: 'Revenue',
    title: 'Tax, markup & commission audit',
    subtitle: 'From gross menu value to net payout',
    units: 'outlets',
    roles: null,
    filters: ['date', 'outlet', 'channel'],
    render: render
  });
})(window);
