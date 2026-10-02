/*
 * Data sources (#/system/data-sources) - the honesty page.
 *
 * Four sections, all of them read out of the model rather than typed:
 *   A  How data arrives - one card per entry in MK.config.sources (the POS, the two weekly statements and the ERP
 *      itself) with what it supplies, the route, the frequency, the date it is good through, the Petpooja API
 *      caveat, and an "Upload weekly statement" button per aggregator that explains the step and does nothing else.
 *      The estimated-versus-actual rule sits under them, with the unsettled tail counted from MK.config.channelTerms.
 *   B  What each channel can and cannot tell us - MK.config.capabilities in full, grouped by order level, payout
 *      level and inventory, each cell read through MK.data.can so the page and the rest of the app answer alike.
 *   C  Deliberately not shown - MK.config.notImported with the reason each item is missing.
 *   D  About this preview - what the dataset is, what is assumed, what is simulated, the figures that describe it
 *      and the reset control.
 *
 * Every figure comes from the data layer and is formatted with MK.fmt; counts that the data layer scopes (orders,
 * bills, vendors) are shown as the persona's own, and a persona without outlet sales sees that said plainly rather
 * than a zero. No channel-attributed field is printed anywhere: where a reader would expect one that the channel
 * does not supply, MK.ui.notProvided says so.
 *
 * Page-local state (ctx.state): none beyond what the modals hold themselves.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates;

  var PAGE_ID = 'data-sources';   /* the router gives the page root the class .pg-data-sources */

  /* The order the cards are drawn in; 'estimate' is a rule, not a route, so it is explained under them instead. */
  var SOURCE_ORDER = ['petpooja', 'swiggy_annexure', 'zomato_settlement', 'erp'];

  var SUPPLIES = {
    petpooja: 'The single source of gross order data for all three channels: in-store bills start here and Swiggy ' +
      'and Zomato orders are relayed into it. Order and item lines, prices, discount totals, taxes, packaging ' +
      'charges and status events. It knows nothing about commissions or payouts.',
    swiggy_annexure: 'The weekly payout annexure: per-order service fee, payment collection charges, GST on those ' +
      'fees, TDS, discount shares, cancellations, complaint refunds, ads and other deductions, the net payout, the ' +
      'settlement date and the bank reference.',
    zomato_settlement: 'The weekly settlement report: commissionable value, service fee, payment mechanism fee, GST ' +
      'on those fees, TDS, the GST the platform collects and pays under section 9(5), compensation and penalties, ' +
      'payout-level additions and deductions, and the bank reference.',
    erp: 'Everything captured and approved in this system: expenses and vendor bills with their approvals, vendors ' +
      'and their verification, budgets, payment batches, factory production, yields and cost per kg, stock counts ' +
      'and overheads.'
  };

  var CAVEATS = {
    petpooja: 'The pull API has to be enabled by Petpooja - it needs their Growth plan and per-outlet credentials, ' +
      'and it is not publicly documented. The scheduled report export is the fallback and needs no enablement, so ' +
      'the daily sync is safe either way.',
    swiggy_annexure: 'There is no settlement API. The annexure is downloaded from the partner portal and uploaded ' +
      'here, which is why fees are an estimate until the week is settled.',
    zomato_settlement: 'There is no settlement API. The report is downloaded from the partner portal and uploaded ' +
      'here, which is why fees are an estimate until the week is settled.',
    erp: null
  };

  /* Capability groups, in the order of DATA-FEASIBILITY section 3. */
  var CAP_GROUPS = [
    { prefix: 'order.', title: 'Order level', lead: 'What the ERP knows about a single order.' },
    { prefix: 'payout.', title: 'Payout level', lead: 'Weekly, per outlet, per aggregator - only ever from an uploaded statement.' },
    { prefix: 'inv.', title: 'Inventory and central kitchen', lead: 'The Petpooja inventory module; production, yields and cost per kg are captured in the ERP instead.' }
  ];

  var CAP_TONE = {
    yes: { label: 'Yes', tone: 'good', icon: 'check-circle' },
    partial: { label: 'Partial', tone: 'warn', icon: 'alert-triangle' },
    no: { label: 'No', tone: 'serious', icon: 'x-circle' }
  };

  /* Why an item of MK.config.notImported is not here. Matched on the item text, with a safe default. */
  var NOT_IMPORTED_REASONS = [
    { test: /funnel|impression.*menu open|cart/i,
      reason: 'Portal only. Impressions, menu opens and carts live in the aggregator\'s own analytics, with no API and no export, so they could never be tied back to an order.' },
    { test: /ads performance|roas|cpc/i,
      reason: 'Portal only. The one advertising figure that can be reconciled is the amount deducted on the weekly statement, and that one is shown.' },
    { test: /rating|review|complaint/i,
      reason: 'Portal only. Ratings, reviews and complaint text are never released through a feed, and a figure nobody can verify does not belong in a management report.' },
    { test: /new vs repeat|repeat customer|cohort/i,
      reason: 'Needs customer identity, which no aggregator shares with a restaurant. There is no customer analytics anywhere in this system.' },
    { test: /customer-side fees|platform fee|delivery fee|surge|tips/i,
      reason: 'Charged to the customer and kept by the aggregator. It never reaches the restaurant, in any report.' },
    { test: /payment instrument|prepaid|instrument split/i,
      reason: 'Masked by the aggregator: the statement shows one net payout, not how the customer paid.' },
    { test: /live feed/i,
      reason: 'No such feed exists. Payouts arrive as a weekly statement, and this system says so rather than implying otherwise.' },
    { test: /rider|gps/i,
      reason: 'Belongs to the delivery fleet, not to the restaurant. Only a partial derived wait time is visible, so it is left out.' },
    { test: /competitor|benchmark/i,
      reason: 'Shown inside the partner dashboard against anonymised peers; there is no feed and no way to check it.' }
  ];
  var NOT_IMPORTED_DEFAULT = 'Partner dashboard only - no API and no export feed, so it cannot be brought in, reconciled or trusted.';

  /* ------------------------------------------------------------------ helpers */

  function guard(name, fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; }
    catch (e) { if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e); return fallback; }
  }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function muted(text, title) { return h('span', { 'class': 'mk-muted', title: title || null }, text); }
  function dateText(iso) { return iso ? D.label(iso, 'd MMM yyyy') : null; }
  function sentence(list) {
    if (list.length < 2) return list.join('');
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }
  /** How many units of each kind the master data holds, so two blocks never quote different totals. */
  function unitMix() {
    var units = (MK.config && MK.config.outlets) || [], mix = { outlet: 0, factory: 0, ho: 0, total: units.length };
    units.forEach(function (u) { if (mix[u.type] !== undefined) mix[u.type] += 1; });
    return mix;
  }
  function unitMixText(mix) {
    var parts = [];
    if (mix.outlet) parts.push(plural(mix.outlet, 'outlet'));
    if (mix.factory) parts.push(plural(mix.factory, 'central kitchen'));
    if (mix.ho) parts.push('head office');
    return sentence(parts);
  }
  /** The card header says how often and how current; the source tag underneath carries the full caption. */
  function cardSubtitle(source) {
    var parts = [];
    if (source.frequency) parts.push(source.frequency);
    if (source.through) parts.push('data through ' + dateText(source.through));
    return parts.length ? parts.join(' - ') : null;
  }

  /** MK.workflow.SIMULATED_NOTE reads as a standalone chip ("Simulated in this mockup"); inside a sentence it is lower case. */
  function simulatedNote() {
    var note = (MK.workflow && MK.workflow.SIMULATED_NOTE) || 'simulated';
    return note.charAt(0).toLowerCase() + note.slice(1);
  }

  function reasonFor(item) {
    for (var i = 0; i < NOT_IMPORTED_REASONS.length; i++) {
      if (NOT_IMPORTED_REASONS[i].test.test(item)) return NOT_IMPORTED_REASONS[i].reason;
    }
    return NOT_IMPORTED_DEFAULT;
  }

  function capKeys(prefix) {
    var caps = (MK.config && MK.config.capabilities) || {};
    return Object.keys(caps).filter(function (k) { return k.indexOf(prefix) === 0; });
  }
  function rawCap(fieldKey, channelId) {
    var c = guard('capability', function () { return MK.data.capability(fieldKey); }, null);
    return c ? c[channelId] : null;
  }
  function capValue(fieldKey, channelId) {
    if (rawCap(fieldKey, channelId) === 'n/a') return 'n/a';
    return guard('can', function () { return MK.data.can(channelId, fieldKey); }, 'no');
  }
  /** How many of the fields of a group the channel supplies, ignoring the ones that do not apply to it. */
  function capTally(prefix, channelId) {
    var applicable = 0, supplied = 0, full = 0;
    capKeys(prefix).forEach(function (k) {
      var v = capValue(k, channelId);
      if (v === 'n/a') return;
      applicable += 1;
      if (v === 'yes' || v === 'partial') supplied += 1;
      if (v === 'yes') full += 1;
    });
    return { applicable: applicable, supplied: supplied, full: full };
  }

  /* ------------------------------------------------------- per-render environment */

  function buildEnv(ctx) {
    var cfg = MK.config || {};
    var env = { ctx: ctx, st: ctx.state, user: ctx.user || MK.session.current() };
    env.sources = cfg.sources || {};
    env.channels = cfg.channels || [];
    env.terms = cfg.channelTerms || {};
    env.notImported = cfg.notImported || [];
    env.today = (MK.calendar && MK.calendar.today) || '';
    env.dataStart = (MK.calendar && MK.calendar.dataStart) || env.today;
    env.dataEnd = (MK.calendar && MK.calendar.dataEnd) || env.today;

    env.byStatement = {};
    env.channels.forEach(function (c) { if (c.statementSource) env.byStatement[c.statementSource] = c; });

    env.allowedUnits = guard('allowedUnitIds', function () { return MK.session.allowedUnitIds(); }, []);
    env.seesAll = guard('seesAllUnits', function () { return MK.session.seesAllUnits(); }, false);
    env.unitName = function (id) {
      var found = null;
      (cfg.outlets || []).forEach(function (u) { if (u.id === id) found = u; });
      return found ? found.name : id;
    };
    return env;
  }

  /* ------------------------------------------------------------------ section A */

  /** The weekly upload is head-office work; a persona scoped to one unit sees the button with the reason. */
  function uploadRight(env) {
    if (env.seesAll) return { ok: true, reason: '' };
    var names = env.allowedUnits.map(env.unitName).join(', ');
    return { ok: false, reason: 'Weekly statements cover the whole company and are uploaded at head office. Your access covers ' + names + '.' };
  }

  function unsettled(env, channel) {
    var terms = env.terms[channel.id];
    if (!terms || !terms.settledThrough) return null;
    var from = D.addDays(terms.settledThrough, 1);
    if (from > env.dataEnd) return { days: 0, from: from, to: env.dataEnd };
    return { days: D.diffDays(terms.settledThrough, env.dataEnd), from: from, to: env.dataEnd };
  }

  function uploadModal(env, channel, source) {
    var terms = env.terms[channel.id] || {};
    var tail = unsettled(env, channel);
    var m = ui.modal({
      title: 'Upload the ' + channel.label + ' ' + (terms.statementName || 'statement'),
      subtitle: source.frequency + ' - ' + source.route,
      size: 'lg',
      body: h('div', { 'class': 'pg-data-sources ds-modal' },
        ui.callout('info', 'Nothing is uploaded in this preview',
          'The button is here so the weekly step is visible where it belongs. No file is accepted and no figure changes.'),
        ui.keyValue([
          ['Cycle', terms.cycle ? terms.cycle.label : null],
          ['Settled through', dateText(terms.settledThrough)],
          ['Last statement settled on', dateText(terms.lastSettlementDate)],
          ['Orders still awaiting a statement', tail && tail.days
            ? h('span', { 'class': 'ds-inline' },
              plural(tail.days, 'day') + ', ' + D.label(tail.from, 'd MMM') + ' to ' + D.label(tail.to, 'd MMM yyyy'),
              ui.estimateBadge())
            : muted('None - every order in the dataset is settled')],
          ['Customer details in the statement', ui.notProvided(channel.label,
            channel.label + ' does not share customer name, phone or address with restaurants in any report.')]
        ], { cols: 2 }),
        h('p', { 'class': 'ds-text' },
          'When the file is uploaded the ERP matches it to the orders the POS already holds, order by order, and the ' +
          'fees for that period stop being an estimate: commission, collection fee, GST on fees, TDS, ads and refunds ' +
          'become the figures the statement states, and the payout cycle moves from "Awaiting statement" to matched, ' +
          'short paid or disputed. Day totals are never used for the match - the two sides cut their weeks differently.'),
        ui.sourceTag([source.id, 'estimate'])),
      footer: ui.button({ label: 'Close', variant: 'primary', onClick: function () { m.close(); } })
    });
    return m;
  }

  function sourceCard(env, id) {
    var source = env.sources[id];
    if (!source) return null;
    var channel = env.byStatement[id] || null;
    var terms = channel ? (env.terms[channel.id] || {}) : {};
    var tail = channel ? unsettled(env, channel) : null;

    var facts = [
      ['How it arrives', source.route]
    ];

    if (id === 'petpooja') {
      var t = capTally('order.', 'petpooja');
      facts.push(['Order fields supplied', fmt.num(t.supplied) + ' of ' + plural(t.applicable, 'field') + ' that apply to an in-store order']);
      facts.push(['Commission and payout', ui.notProvided('Petpooja POS',
        'The POS records the order. Commissions, fees and payouts exist only in the aggregator statements.')]);
    } else if (channel) {
      var p = capTally('payout.', channel.id);
      facts.push(['Payout fields supplied', fmt.num(p.supplied) + ' of ' + plural(p.applicable, 'field') + ' at payout level']);
      facts.push(['Settlement cycle', terms.cycle ? terms.cycle.label : null]);
      facts.push(['Settled through', terms.settledThrough
        ? h('span', { 'class': 'ds-inline' }, dateText(terms.settledThrough),
          tail && tail.days ? ui.estimateBadge(plural(tail.days, 'day') + ' estimated') : null)
        : null]);
      facts.push(['Ratings and reviews', capValue('order.rating', channel.id) === 'no'
        ? ui.notProvided(channel.label, channel.label + ' keeps ratings and reviews inside the partner dashboard; there is no feed for them.')
        : null]);
    } else if (id === 'erp') {
      var cats = ((MK.config && MK.config.expenseCategories) || []).length;
      var mix = unitMix();
      facts.push(['Covers', plural(cats, 'expense category', 'expense categories') + ' across ' + unitMixText(mix)]);
    }

    var actions = null;
    if (channel) {
      var may = uploadRight(env);
      actions = ui.button({
        label: 'Upload weekly statement', icon: 'upload', size: 'sm',
        disabledReason: may.ok ? '' : may.reason,
        onClick: function () { uploadModal(env, channel, source); }
      });
    }

    return ui.card({
      className: 'ds-source',
      title: source.label,
      subtitle: cardSubtitle(source),
      actions: actions,
      body: h('div', { 'class': 'ds-source__body' },
        h('p', { 'class': 'ds-text' }, SUPPLIES[id] || source.route),
        ui.keyValue(facts),
        CAVEATS[id] ? h('p', { 'class': 'ds-note' }, ui.icon('info', 14), h('span', null, CAVEATS[id])) : null),
      footer: ui.sourceTag([id])
    });
  }

  function estimateRule(env) {
    var lines = [], settled = [], estimatedDays = 0;
    env.channels.forEach(function (c) {
      var terms = env.terms[c.id];
      if (!terms || !terms.settledThrough) return;
      var tail = unsettled(env, c);
      settled.push(dateText(terms.settledThrough) + ' for ' + c.label);
      if (tail && tail.days) estimatedDays = Math.max(estimatedDays, tail.days);
      lines.push(h('li', { 'class': 'ds-rule__item' },
        h('span', { 'class': 'ds-rule__chip' }, ui.chip(c.label, 'neutral', { dotVar: c.colourVar, outline: true })),
        h('span', null, 'Actuals through ' + dateText(terms.settledThrough) +
          (tail && tail.days
            ? '; ' + plural(tail.days, 'day') + ' to ' + D.label(tail.to, 'd MMM yyyy') + ' are estimated at the assumed contract rates.'
            : '; every order in the dataset is settled.'))));
    });

    var sub = settled.length
      ? 'Actuals run to ' + sentence(settled) + (estimatedDays
        ? '; up to ' + plural(estimatedDays, 'day') + ' of trading after that are estimated.'
        : '; nothing in this dataset is estimated.')
      : (env.sources.estimate && env.sources.estimate.caption) || '';

    return ui.card({
      className: 'ds-rule',
      title: 'Estimated or actual - never a blend',
      subtitle: sub,
      body: h('div', { 'class': 'ds-rule__body' },
        h('p', { 'class': 'ds-text' },
          'Commission, fees, TDS and the net payout are facts only once the weekly statement is uploaded. For orders ' +
          'in a period that is not settled yet the ERP shows a figure computed at the contracted rate and marks it ' +
          'estimated. The two are reported separately on every screen that carries them, and a period with no ' +
          'statement is shown as having none - never as zero.'),
        h('ul', { 'class': 'ds-rule__list' }, lines),
        h('p', { 'class': 'ds-note' }, ui.estimateBadge(),
          h('span', null, 'This badge marks every estimated figure in the system. Contract rates are assumed: the ' +
            'real ones are confidential and differ by outlet.'))),
      footer: ui.sourceTag(['swiggy_annexure', 'zomato_settlement', 'estimate'])
    });
  }

  /* ------------------------------------------------------------------ section B */

  function capCell(fieldKey, channelId) {
    var v = capValue(fieldKey, channelId);
    if (v === 'n/a') return h('span', { 'class': 'mk-faint', title: 'Does not apply to this channel' }, '-');
    var m = CAP_TONE[v] || CAP_TONE.no;
    return ui.chip(m.label, m.tone, { icon: m.icon });
  }

  function capLegend() {
    return h('div', { 'class': 'ds-legend' },
      h('span', { 'class': 'mk-label' }, 'How to read this'),
      h('span', { 'class': 'ds-legend__item' }, ui.chip(CAP_TONE.yes.label, 'good', { icon: CAP_TONE.yes.icon }), 'supplied in full'),
      h('span', { 'class': 'ds-legend__item' }, ui.chip(CAP_TONE.partial.label, 'warn', { icon: CAP_TONE.partial.icon }), 'supplied with the limitation in the note'),
      h('span', { 'class': 'ds-legend__item' }, ui.chip(CAP_TONE.no.label, 'serious', { icon: CAP_TONE.no.icon }), 'not supplied - the ERP never shows it'),
      h('span', { 'class': 'ds-legend__item' }, h('span', { 'class': 'mk-faint' }, '-'), 'does not apply to that channel'));
  }

  function capGroupTable(env, group) {
    var keys = capKeys(group.prefix);
    if (!keys.length) return null;

    var rows = keys.map(function (k) {
      var c = guard('capability', function () { return MK.data.capability(k); }, null) || {};
      return { key: k, label: c.label || k, note: c.note || '', petpooja: capValue(k, 'petpooja'),
        swiggy: capValue(k, 'swiggy'), zomato: capValue(k, 'zomato') };
    });

    var columns = [{ key: 'label', label: 'What the ERP would show', wrap: true, width: 230 }];
    env.channels.forEach(function (ch) {
      columns.push({ key: ch.id, label: ch.label, align: 'center', width: 104,
        title: ch.kind === 'pos' ? 'In-store orders, recorded in the POS'
          : 'Orders relayed into the POS and settled on the weekly ' + ch.label + ' statement',
        render: function (v, r) { return capCell(r.key, ch.id); } });
    });
    columns.push({ key: 'note', label: 'Note', wrap: true, width: 340,
      render: function (v) { return v ? v : h('span', { 'class': 'mk-faint' }, '-'); } });

    var parts = [];
    env.channels.forEach(function (ch) {
      var t = capTally(group.prefix, ch.id);
      if (!t.applicable) return;
      var qualifier = '';
      if (t.full < t.supplied) qualifier = t.full ? ' (' + fmt.num(t.full) + ' in full)' : ' (each with a limitation)';
      parts.push(ch.label + ' ' + fmt.num(t.supplied) + ' of ' + fmt.num(t.applicable) + qualifier);
    });

    return h('div', { 'class': 'ds-capgroup' },
      h('div', { 'class': 'ds-capgroup__head' },
        h('h4', { 'class': 'mk-h3' }, group.title),
        h('p', { 'class': 'ds-capgroup__lead' }, group.lead +
          (parts.length ? ' Fields supplied: ' + parts.join('; ') + '.' : ''))),
      ui.table({ columns: columns, rows: rows, dense: true, empty: 'No field in this group' }));
  }

  function capabilityCard(env) {
    var groups = CAP_GROUPS.map(function (g) { return capGroupTable(env, g); }).filter(Boolean);
    var total = CAP_GROUPS.reduce(function (t, g) { return t + capKeys(g.prefix).length; }, 0);
    if (!groups.length) {
      return ui.card({ title: 'Capability matrix', body: ui.emptyState('No capability matrix in the master data') });
    }
    return ui.card({
      className: 'ds-caps', flush: true,
      title: 'Capability matrix',
      subtitle: plural(total, 'field') + ' checked one by one. Every screen in this system asks the same question ' +
        'before it prints a channel figure, and says "not provided" where the answer is no.',
      body: h('div', { 'class': 'ds-caps__body' }, capLegend(), groups),
      footer: ui.sourceTag(['petpooja', 'swiggy_annexure', 'zomato_settlement'], { prefix: 'Covers' })
    });
  }

  /* ------------------------------------------------------------------ section C */

  function notImportedCard(env) {
    var rows = env.notImported.map(function (item) { return { item: item, reason: reasonFor(item) }; });
    return ui.card({
      className: 'ds-notimported', flush: true,
      title: 'Left out on purpose',
      subtitle: plural(rows.length, 'item') + ' an aggregator dashboard displays that this system does not. Each one ' +
        'is left out because it cannot be reconciled, not because it was forgotten.',
      body: ui.table({
        dense: true,
        columns: [
          { key: 'item', label: 'Not shown anywhere', wrap: true, width: 300,
            render: function (v) { return h('span', { 'class': 'ds-nope' }, ui.icon('x-circle', 14), v); } },
          { key: 'reason', label: 'Why', wrap: true }
        ],
        rows: rows, empty: 'Nothing is excluded'
      }),
      footer: h('div', { 'class': 'ds-foot' },
        h('p', { 'class': 'ds-note' }, ui.icon('info', 14),
          h('span', null, 'There is no customer analytics anywhere in this system: no name, phone, address, locality, ' +
            'new-versus-repeat mix or cohort. The aggregators do not share it, and in-store phone capture covers too ' +
            'few counter bills to be worth reporting.')),
        ui.sourceTag(['erp']))
    });
  }

  /* ------------------------------------------------------------------ section D */

  function datasetFacts(env) {
    var days = guard('days', function () { return D.diffDays(env.dataStart, env.dataEnd) + 1; }, 0);
    var orders = guard('summary', function () {
      return MK.data.summary({ from: env.dataStart, to: env.dataEnd }).orders;
    }, 0);
    var bills = guard('bill.counts', function () { return MK.workflow.bill.counts().total; }, 0);
    var vendors = guard('vendor.counts', function () { return MK.workflow.vendor.counts().total; }, 0);
    var batches = guard('batch.counts', function () { return MK.workflow.batch.counts().total; }, 0);
    var events = guard('audit.count', function () { return MK.audit.count({}); }, 0);
    var mix = unitMix();
    var dishes = ((MK.config && MK.config.dishes) || []).length;

    return [
      { label: 'Days of trading simulated', value: fmt.num(days),
        sub: D.label(env.dataStart, 'd MMM') + ' to ' + D.label(env.dataEnd, 'd MMM yyyy') },
      { label: 'Orders generated', value: orders ? fmt.num(orders) : muted('Not in your scope'),
        sub: orders ? 'order by order, with item lines and prices' : 'outlet sales are outside your access' },
      { label: 'Vendor invoices', value: fmt.num(bills), sub: 'replayed through the approval workflow' },
      { label: 'Vendors', value: fmt.num(vendors), sub: fmt.num(batches) + ' payment batches built from their bills' },
      { label: 'Audit events', value: fmt.num(events), sub: 'every one of them written by a real transition' },
      { label: 'Units modelled', value: fmt.num(mix.total),
        sub: unitMixText(mix) + '; ' + plural(dishes, 'dish', 'dishes') + ' on the menu' }
    ];
  }

  function aboutCard(env) {
    var may = guard('demo.reset right', function () { return MK.session.can('demo.reset'); }, { ok: false, reason: '' });
    var canReset = !!(MK.app && typeof MK.app.resetDemo === 'function');
    var ratesAssumed = false;
    Object.keys(env.terms).forEach(function (k) { if (env.terms[k] && env.terms[k].ratesAssumed) ratesAssumed = true; });

    var resetBtn = ui.button({
      label: 'Reset demo data', icon: 'refresh', variant: 'secondary',
      disabledReason: may.ok ? (canReset ? '' : 'The reset control is part of the shell and is not loaded.') : may.reason,
      title: 'Clears the stored workflow state and replays the seed',
      onClick: function () { if (MK.app && MK.app.resetDemo) MK.app.resetDemo(); }
    });

    var points = [
      ['The figures', 'An illustrative dataset, generated by model rather than copied from the business, and frozen at ' +
        D.label(env.today, 'd MMM yyyy') + '. It is internally consistent: sales, costs, payouts, bills and the factory ' +
        'all reconcile to the rupee, so every screen can be read against every other.'],
      ['The outlets and the menu', 'The outlet list, the dishes and the price points follow the chain\'s public listings. ' +
        'Sales volumes, costs and margins do not: they are modelled.'],
      ['The rates', ratesAssumed
        ? 'Commission and fee percentages are assumed contract rates, labelled as assumed wherever they appear. Real rates are confidential and differ by outlet.'
        : 'Commission and fee percentages come from the channel terms held in the model.'],
      ['The verification', 'Vendor pre-checks are real and deterministic - GSTIN format and check character, the PAN ' +
        'inside the GSTIN, IFSC format. The registry lookup and the penny-drop name match are ' + simulatedNote() +
        ' and say so on every screen that shows them.'],
      ['The connections', 'Nothing here is connected to Petpooja, to Swiggy, to Zomato or to a bank. The preview runs ' +
        'entirely in this browser, and the workflow state it keeps is the only thing it stores.']
    ];

    return ui.card({
      className: 'ds-about',
      title: 'What is real, what is modelled and what is simulated',
      subtitle: 'The dataset behind every screen, described by the dataset itself.',
      actions: resetBtn,
      body: h('div', { 'class': 'ds-about__body' },
        h('div', { 'class': 'ds-facts' }, datasetFacts(env).map(function (t) { return ui.statTile(t); })),
        ui.keyValue(points)),
      footer: h('div', { 'class': 'ds-foot' },
        h('p', { 'class': 'ds-note' }, ui.icon('refresh', 14),
          h('span', null, 'Resetting clears the bills, payment batches, vendors and audit events this preview holds ' +
            'and replays the original demo state. Sales, costs and payouts are rebuilt on every load and are never stored.')),
        ui.sourceTag(['petpooja', 'erp']))
    });
  }

  /* ------------------------------------------------------------------ render */

  function intro(env) {
    return h('div', { 'class': 'ds-intro' },
      h('p', { 'class': 'ds-intro__text' },
        'Where every number in this system comes from, how often it arrives, and what each channel simply cannot ' +
        'tell a restaurant. Nothing is attributed to a source that does not provide it; where a figure is expected ' +
        'and unavailable, the screen says so instead of estimating quietly.'),
      h('p', { 'class': 'ds-intro__who' }, ui.icon('user', 14),
        h('span', null, 'Signed in as ' + (env.user ? env.user.name : '') + (env.user ? ' - ' + env.user.roleLabel : '') +
          '. The dataset figures below count what you may see; the routes and the capability matrix are the same for everyone.')));
  }

  function render(rootEl, ctx) {
    var env = buildEnv(ctx);

    rootEl.appendChild(intro(env));

    rootEl.appendChild(ui.sectionTitle('How data arrives',
      'Four routes in, two of them a weekly upload. Nothing streams and nothing is guessed.'));

    var cards = SOURCE_ORDER.map(function (id) { return sourceCard(env, id); }).filter(Boolean);
    if (!cards.length) {
      rootEl.appendChild(ui.emptyState('No source master data', 'The routes are part of the master data.', { icon: 'database' }));
    } else {
      rootEl.appendChild(ui.grid(2, cards));
      rootEl.appendChild(estimateRule(env));
    }

    rootEl.appendChild(ui.sectionTitle('What each channel can and cannot tell us',
      'The matrix the whole system is held to, checked before any channel figure is printed.'));
    rootEl.appendChild(capabilityCard(env));

    rootEl.appendChild(ui.sectionTitle('Deliberately not shown',
      'Numbers a partner dashboard displays that this system will not repeat.'));
    rootEl.appendChild(notImportedCard(env));

    rootEl.appendChild(ui.sectionTitle('About this preview', 'The dataset, the assumptions and the reset.'));
    rootEl.appendChild(aboutCard(env));
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/system/data-sources',
    group: 'System',
    title: 'Data sources',
    subtitle: 'What each channel provides and what it does not',
    units: 'all',
    roles: null,
    filters: [],
    render: render
  });
})(window);
