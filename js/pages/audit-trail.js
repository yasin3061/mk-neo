/*
 * Audit trail (#/system/audit) - the activity log over MK.audit.list.
 *
 * Blocks: purpose line -> page-local filter bar (entity, action, actor, unit, date range, free text)
 * -> KPI row for the filtered range (events, approvals, rejections, segregation refusals where any were
 * logged, distinct actors, records touched) -> events per day as a single-colour bar chart beside the
 * actions-by-persona table (the maker-checker split made visible) -> the log itself, newest first, paged,
 * with a drawer per record holding its full timeline and the before / after rows of every edit.
 *
 * Every figure is MK.audit.count / MK.audit.list output formatted with MK.fmt; the log is scoped by the
 * data layer, so a persona with one unit simply sees fewer rows and the option lists shrink with them.
 * Filters are page-local (the page declares no global filters): the global date filter drives sales and
 * cost screens, while an audit log is read against its own window.
 *
 * Page-local state (ctx.state): f (the filter object), page (zero-based), sort is fixed newest first.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates;

  var PAGE_ID = 'audit-trail';        /* the router gives the page root the class .pg-audit-trail */
  var PAGE_SIZE = 50;
  var DAY_GRAIN_LIMIT = 92;           /* beyond this many days the bar chart counts weeks, and says so */

  var ENTITY = {
    bill: { label: 'Bill', plural: 'Bills', icon: 'receipt', page: 'approvals-bills' },
    batch: { label: 'Payment batch', plural: 'Payment batches', icon: 'wallet', page: 'approvals-payments' },
    vendor: { label: 'Vendor', plural: 'Vendors', icon: 'truck', page: 'vendors' },
    system: { label: 'System', plural: 'System', icon: 'database', page: null }
  };

  /* Action groups. The audit log stores an action id per event; these decide what a tile counts. */
  var ENTERED = ['bill.create', 'bill.update', 'bill.submit', 'bill.reopen',
    'vendor.create', 'vendor.update', 'vendor.bankChange', 'vendor.taxChange', 'vendor.submit'];
  var REVIEWED = ['bill.review', 'vendor.verify'];
  var APPROVED = ['bill.approve', 'vendor.approve', 'vendor.override', 'batch.release'];
  var REJECTED = ['bill.reject', 'vendor.reject', 'batch.reject'];
  var PAYMENT = ['batch.create', 'batch.addBill', 'batch.removeBill', 'batch.submit', 'batch.markPaid',
    'bill.inBatch', 'bill.batchRejected', 'bill.released', 'bill.paid'];
  var RAISED = ['bill.create', 'bill.submit', 'vendor.create', 'vendor.submit', 'batch.create', 'batch.submit'];

  function setOf(list) { var m = {}; list.forEach(function (a) { m[a] = 1; }); return m; }
  var IS_ENTERED = setOf(ENTERED), IS_REVIEWED = setOf(REVIEWED), IS_APPROVED = setOf(APPROVED),
    IS_REJECTED = setOf(REJECTED), IS_PAYMENT = setOf(PAYMENT), IS_RAISED = setOf(RAISED);

  /* ------------------------------------------------------------------ helpers */

  function guard(name, fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; }
    catch (e) { if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e); return fallback; }
  }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function dash(title) { return h('span', { 'class': 'mk-faint', title: title || null }, '-'); }
  function dayOf(at) { return String(at || '').slice(0, 10); }

  /** 'bankAccountMasked' -> 'Bank account masked' - audit change rows carry field names, not labels. */
  function humanise(key) {
    var s = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
  }
  /* Field names the generic rule would mangle ('Pan', 'Gstin') or state too literally. */
  var FIELD_LABELS = {
    pan: 'PAN', gstin: 'GSTIN', ifsc: 'IFSC', utr: 'Bank reference (UTR)',
    gstAmount: 'GST amount', tdsAmount: 'TDS amount', tdsLabel: 'TDS type',
    bankAccountMasked: 'Bank account (masked)', accountHolderName: 'Account holder name',
    bankName: 'Bank', unitIds: 'Units served', expenseCategoryIds: 'Expense categories',
    creditDays: 'Credit days', invoiceNo: 'Vendor invoice number', monthKey: 'Expense month'
  };
  function fieldLabel(key) { return FIELD_LABELS[key] || humanise(key); }
  function entityMeta(entity) { return ENTITY[entity] || { label: humanise(entity) || 'Record', icon: 'file', page: null }; }
  /** State code -> the one label the kit and the workflow agree on; '' when the event moved no state. */
  function stateLabel(state) {
    if (!state) return '';
    var labels = (MK.workflow && MK.workflow.labels && MK.workflow.labels.state) || {};
    return labels[state] || ui.statusInfo(state).label;
  }
  function actionLabel(e) {
    var labels = (MK.workflow && MK.workflow.labels && MK.workflow.labels.action) || {};
    return e.actionLabel || labels[e.action] || humanise(e.action);
  }
  /* A refusal is only ever shown when the log really carries one; nothing is invented here. */
  function isRefusal(e) { return /refus|denied|blocked/i.test(String(e.action) + ' ' + String(e.actionLabel || '')); }

  function unitLookup() {
    var byId = {};
    ((MK.config && MK.config.outlets) || []).forEach(function (u) { byId[u.id] = u; });
    return {
      has: function (id) { return !!byId[id]; },
      name: function (id) { return byId[id] ? byId[id].name : (id || ''); },
      short: function (id) { return byId[id] ? (byId[id].short || byId[id].name) : (id || ''); },
      colour: function (id) { return byId[id] ? byId[id].colourVar : null; }
    };
  }
  function dot(colourVar) {
    return h('span', { 'class': 'at-dot', 'aria-hidden': 'true', style: colourVar ? { background: 'var(' + colourVar + ')' } : null });
  }

  /* ------------------------------------------------------------------ the filter window */

  var PRESETS = [
    { value: 'last7', label: '7 days' },
    { value: 'last30', label: '30 days' },
    { value: 'month', label: 'This month' },
    { value: 'all', label: 'Everything' }
  ];

  function presetRange(preset, today) {
    if (preset === 'last7') return { from: D.addDays(today, -6), to: today };
    if (preset === 'last30') return { from: D.addDays(today, -29), to: today };
    if (preset === 'month') return { from: D.monthStart(today), to: today };
    return { from: null, to: null };
  }

  function defaultFilter() {
    return { preset: 'month', from: null, to: null, entity: '', action: '', actorId: '', unitId: '', search: '' };
  }
  function isDefaultFilter(f) {
    var d = defaultFilter(), k;
    for (k in d) { if (Object.prototype.hasOwnProperty.call(d, k) && f[k] !== d[k]) return false; }
    return true;
  }

  /* ------------------------------------------------------- per-render environment */

  /** What the persona's own log actually contains - the only values the controls may offer. */
  function buildIndex(all) {
    var entities = {}, actions = {}, actors = {}, units = {};
    all.forEach(function (e) {
      entities[e.entity] = (entities[e.entity] || 0) + 1;
      var a = actions[e.action] || (actions[e.action] = { label: actionLabel(e), n: 0, entities: {} });
      a.n += 1; a.entities[e.entity] = 1;
      var p = actors[e.actorId] || (actors[e.actorId] = { label: e.actorName, role: e.roleLabel, n: 0 });
      p.n += 1;
      if (e.unitId) units[e.unitId] = 1;
      (e.unitIds || []).forEach(function (u) { units[u] = 1; });
    });
    return { entities: entities, actions: actions, actors: actors, units: units };
  }

  function buildEnv(ctx) {
    var st = ctx.state;
    if (!st.f) st.f = defaultFilter();
    if (typeof st.page !== 'number' || st.page < 0) st.page = 0;
    /* a To before a From is a slip, not a query: correct it so the controls and the numbers agree */
    if (st.f.preset === 'custom' && st.f.from && st.f.to && st.f.from > st.f.to) {
      var swap = st.f.from; st.f.from = st.f.to; st.f.to = swap;
    }

    var env = { ctx: ctx, st: st, f: st.f, look: unitLookup() };
    env.user = ctx.user || MK.session.current();
    env.today = (MK.calendar && MK.calendar.today) || '';
    env.dataStart = (MK.calendar && MK.calendar.dataStart) || env.today;

    /* everything this persona may see, for the option lists and for the "of N" sub-labels */
    env.all = guard('audit.list all', function () { return MK.audit.list({}); }, []);
    env.allCount = env.all.length;
    env.index = buildIndex(env.all);
    env.unitIds = guard('allowedUnitIds', function () { return MK.session.allowedUnitIds(); }, [])
      .filter(function (id) { return env.index.units[id] && env.look.has(id); });

    /* a persona change can retire an option the filter still holds: drop it rather than
       filter by something no control shows (which would read as an empty log) */
    if (st.f.entity && !env.index.entities[st.f.entity]) st.f.entity = '';
    var act = env.index.actions[st.f.action];
    if (st.f.action && (!act || (st.f.entity && !act.entities[st.f.entity]))) st.f.action = '';
    if (st.f.actorId && !env.index.actors[st.f.actorId]) st.f.actorId = '';
    if (st.f.unitId && env.unitIds.indexOf(st.f.unitId) < 0) st.f.unitId = '';

    var span = st.f.preset === 'custom' ? { from: st.f.from, to: st.f.to } : presetRange(st.f.preset, env.today);
    env.from = span.from || null;
    env.to = span.to || null;

    var q = {};
    if (env.from) q.from = env.from;
    if (env.to) q.to = env.to;
    if (st.f.entity) q.entity = st.f.entity;
    if (st.f.action) q.action = st.f.action;
    if (st.f.actorId) q.actorId = st.f.actorId;
    if (st.f.unitId) q.unitId = st.f.unitId;
    if (st.f.search) q.search = st.f.search;
    env.query = q;
    env.rows = guard('audit.list', function () { return MK.audit.list(q); }, []);
    env.count = env.rows.length;

    /* the window actually covered, so captions never claim days the log does not hold */
    var dates = env.rows.map(function (e) { return dayOf(e.at); });
    var allDates = env.all.map(function (e) { return dayOf(e.at); });
    env.logFirst = allDates.length ? allDates[allDates.length - 1] : env.dataStart;
    env.logLast = allDates.length ? allDates[0] : env.today;
    env.windowFrom = env.from || (dates.length ? dates[dates.length - 1] : env.logFirst);
    env.windowTo = env.to || (dates.length ? dates[0] : env.logLast);
    if (env.windowFrom > env.windowTo) env.windowFrom = env.windowTo;

    env.pages = Math.max(1, Math.ceil(env.count / PAGE_SIZE));
    if (st.page > env.pages - 1) st.page = env.pages - 1;
    env.page = st.page;
    env.pageRows = env.rows.slice(env.page * PAGE_SIZE, env.page * PAGE_SIZE + PAGE_SIZE);
    return env;
  }

  /** A count beside an option, without "(simulated) (33)" when the label already ends in a bracket. */
  function withCount(label, n) {
    return /\)$/.test(label) ? label + ' - ' + fmt.num(n) : label + ' (' + fmt.num(n) + ')';
  }

  /** Option lists built from what the persona can actually see, so no filter ever leads to a dead end. */
  function options(env) {
    var ix = env.index;

    var entityOpts = [{ value: '', label: 'All record types' }];
    ['bill', 'batch', 'vendor', 'system'].forEach(function (k) {
      if (ix.entities[k]) entityOpts.push({ value: k, label: withCount(entityMeta(k).plural, ix.entities[k]) });
    });

    var actionOpts = [{ value: '', label: 'All actions' }];
    Object.keys(ix.actions).sort(function (a, b) {
      var la = ix.actions[a].label, lb = ix.actions[b].label;
      return la === lb ? 0 : (la < lb ? -1 : 1);
    }).forEach(function (k) {
      /* only actions the chosen record type really carries - 'system' names its actions 'seed.*' */
      if (env.f.entity && !ix.actions[k].entities[env.f.entity]) return;
      actionOpts.push({ value: k, label: withCount(ix.actions[k].label, ix.actions[k].n) });
    });

    var actorOpts = [{ value: '', label: 'Everyone' }];
    Object.keys(ix.actors).sort(function (a, b) { return ix.actors[b].n - ix.actors[a].n; }).forEach(function (k) {
      actorOpts.push({ value: k, label: ix.actors[k].label + ' - ' + ix.actors[k].role });
    });

    var unitOpts = [{ value: '', label: 'All units' }];
    env.unitIds.forEach(function (id) { unitOpts.push({ value: id, label: env.look.name(id) }); });

    return { entity: entityOpts, action: actionOpts, actor: actorOpts, unit: unitOpts };
  }

  /* ------------------------------------------------------------------ filter bar */

  function filterCard(env) {
    var st = env.st, f = env.f, opts = options(env);
    function set(key, value) { f[key] = value; st.page = 0; env.ctx.rerender(); }

    /* the Custom pill appears only once a date has been typed, so the control always shows the window in force */
    var presetOptions = f.preset === 'custom' ? PRESETS.concat([{ value: 'custom', label: 'Custom' }]) : PRESETS;
    var presets = ui.segmented({
      ariaLabel: 'Period', size: 'sm', value: f.preset,
      options: presetOptions,
      onChange: function (v) { if (v === 'custom') return; f.from = null; f.to = null; set('preset', v); }
    });

    var span = f.preset === 'custom' ? { from: f.from, to: f.to } : presetRange(f.preset, env.today);
    function setDate(which, iso) {
      var cur = f.preset === 'custom' ? { from: f.from, to: f.to } : presetRange(f.preset, env.today);
      f.from = which === 'from' ? (iso || null) : (cur.from || env.logFirst);
      f.to = which === 'to' ? (iso || null) : (cur.to || env.logLast);
      set('preset', 'custom');
    }

    var fields = [
      ui.form.field({ label: 'Record type', control: ui.select({ size: 'sm', block: true, value: f.entity, options: opts.entity,
        onChange: function (v) { f.action = ''; set('entity', v); } }) }),
      ui.form.field({ label: 'Action', control: ui.select({ size: 'sm', block: true, value: f.action, options: opts.action,
        onChange: function (v) { set('action', v); } }) }),
      ui.form.field({ label: 'Who', control: ui.select({ size: 'sm', block: true, value: f.actorId, options: opts.actor,
        onChange: function (v) { set('actorId', v); } }) }),
      ui.form.field({ label: 'Unit', control: ui.select({ size: 'sm', block: true, value: f.unitId, options: opts.unit,
        onChange: function (v) { set('unitId', v); } }) }),
      ui.form.field({ label: 'From', control: ui.form.dateInput({ value: span.from || env.logFirst, min: env.dataStart, max: env.today,
        ariaLabel: 'From date', onChange: function (v) { setDate('from', v); } }) }),
      ui.form.field({ label: 'To', control: ui.form.dateInput({ value: span.to || env.logLast, min: env.dataStart, max: env.today,
        ariaLabel: 'To date', onChange: function (v) { setDate('to', v); } }) }),
      ui.form.field({ label: 'Search', control: ui.form.search({ value: f.search, placeholder: 'Record, note or person',
        ariaLabel: 'Search the audit trail', onInput: function (v) { f.search = v; st.page = 0; env.ctx.rerender(); } }) })
    ];

    var head = h('div', { 'class': 'at-filters__head' },
      h('div', { 'class': 'at-filters__presets' }, h('span', { 'class': 'mk-label' }, 'Period'), presets),
      h('div', { 'class': 'at-filters__result' },
        h('strong', null, plural(env.count, 'event')),
        h('span', { 'class': 'mk-muted' }, ' of ' + fmt.num(env.allCount) + ' you may see, ' +
          D.label(env.windowFrom, 'd MMM') + ' to ' + D.label(env.windowTo, 'd MMM yyyy')),
        isDefaultFilter(f) ? null : ui.button({ label: 'Clear filters', variant: 'text', size: 'sm', icon: 'x',
          onClick: function () { env.st.f = defaultFilter(); env.st.page = 0; env.ctx.rerender(); } })));

    return ui.card({ className: 'at-filters', body: h('div', null, head, h('div', { 'class': 'at-filters__grid' }, fields)) });
  }

  /* ------------------------------------------------------------------ KPI row */

  function countWhere(rows, test) {
    var n = 0;
    rows.forEach(function (e) { if (test(e)) n += 1; });
    return n;
  }

  /** Approvals taken by somebody who also raised or submitted the same record, inside this window. */
  function segregationClashes(rows) {
    var raisedBy = {}, clashes = 0;
    rows.forEach(function (e) {
      if (!e.entityId || !IS_RAISED[e.action]) return;
      var key = e.entity + '|' + e.entityId;
      if (!raisedBy[key]) raisedBy[key] = {};
      raisedBy[key][e.actorId] = 1;
    });
    rows.forEach(function (e) {
      if (!e.entityId || !IS_APPROVED[e.action]) return;
      var seen = raisedBy[e.entity + '|' + e.entityId];
      if (seen && seen[e.actorId]) clashes += 1;
    });
    return clashes;
  }

  function kpis(env, stats) {
    var tiles = [
      { label: 'Events in range', value: fmt.num(env.count), icon: 'list',
        sub: fmt.num(env.allCount) + ' in the whole log you may see' },
      { label: 'Approvals', value: fmt.num(stats.approved), icon: 'check-circle',
        sub: 'bills, vendors and payment releases' },
      { label: 'Rejections', value: fmt.num(stats.rejected), icon: 'x-circle', tone: stats.rejected ? 'warn' : null,
        sub: stats.rejected ? 'each one carries the reason typed at the time' : 'nothing sent back in this range' }
    ];
    /* only rendered when the log really holds refusals - the demo store logs completed actions, not blocked ones */
    if (stats.refusals > 0) {
      tiles.push({ label: 'Segregation refusals', value: fmt.num(stats.refusals), icon: 'shield-check', tone: 'warn',
        sub: 'actions the rules blocked' });
    }
    tiles.push({ label: 'People active', value: fmt.num(stats.actors), icon: 'users',
      sub: stats.topActor ? stats.topActor.name + ' most active with ' + plural(stats.topActor.events, 'event') : 'nobody active in this range' });
    var parts = [];
    if (stats.bills) parts.push(plural(stats.bills, 'bill'));
    if (stats.vendors) parts.push(plural(stats.vendors, 'vendor'));
    if (stats.batches) parts.push(plural(stats.batches, 'payment batch', 'payment batches'));
    tiles.push({ label: 'Records touched', value: fmt.num(stats.records), icon: 'layers',
      sub: parts.length ? parts.join(', ') : 'no record acted on in this range' });
    return h('div', { 'class': 'at-kpiblock' }, ui.kpiRow(tiles), ui.sourceTag(['erp']));
  }

  function buildStats(env) {
    var rows = env.rows;
    var actors = {}, records = { bill: {}, batch: {}, vendor: {} };
    rows.forEach(function (e) {
      var a = actors[e.actorId] || (actors[e.actorId] = { id: e.actorId, name: e.actorName, role: e.roleLabel,
        events: 0, entered: 0, reviewed: 0, approved: 0, rejected: 0, payment: 0, last: '' });
      a.events += 1;
      if (IS_ENTERED[e.action]) a.entered += 1;
      if (IS_REVIEWED[e.action]) a.reviewed += 1;
      if (IS_APPROVED[e.action]) a.approved += 1;
      if (IS_REJECTED[e.action]) a.rejected += 1;
      if (IS_PAYMENT[e.action]) a.payment += 1;
      if (e.at > a.last) a.last = e.at;
      if (e.entityId && records[e.entity]) records[e.entity][e.entityId] = 1;
    });
    var list = Object.keys(actors).map(function (k) { return actors[k]; }).sort(function (x, y) { return y.events - x.events; });
    var bills = Object.keys(records.bill).length, batches = Object.keys(records.batch).length, vendors = Object.keys(records.vendor).length;
    return {
      byActor: list,
      actors: list.length,
      topActor: list[0] || null,
      approved: countWhere(rows, function (e) { return !!IS_APPROVED[e.action]; }),
      rejected: countWhere(rows, function (e) { return !!IS_REJECTED[e.action]; }),
      entered: countWhere(rows, function (e) { return !!IS_ENTERED[e.action]; }),
      reviewed: countWhere(rows, function (e) { return !!IS_REVIEWED[e.action]; }),
      payment: countWhere(rows, function (e) { return !!IS_PAYMENT[e.action]; }),
      refusals: countWhere(rows, isRefusal),
      clashes: segregationClashes(rows),
      bills: bills, batches: batches, vendors: vendors,
      records: bills + batches + vendors
    };
  }

  /* ------------------------------------------------------------------ events over time */

  function buckets(env) {
    var from = env.windowFrom, to = env.windowTo;
    var days = guard('date range', function () { return D.range(from, to); }, []);
    if (!days.length) return null;
    var weekly = days.length > DAY_GRAIN_LIMIT;
    var counts = {};
    env.rows.forEach(function (e) {
      var d = dayOf(e.at);
      var key = weekly ? D.weekStart(d) : d;
      counts[key] = (counts[key] || 0) + 1;
    });
    var keys = [];
    if (weekly) {
      var seen = {};
      days.forEach(function (d) { var w = D.weekStart(d); if (!seen[w]) { seen[w] = 1; keys.push(w); } });
    } else { keys = days; }
    return {
      weekly: weekly,
      keys: keys,
      labels: keys.map(function (k) { return D.label(k, 'd MMM'); }),
      values: keys.map(function (k) { return counts[k] || 0; })
    };
  }

  function timeChart(env, parent) {
    var b = buckets(env);
    if (!b || !MK.charts) return null;
    var peak = 0, peakAt = 0, active = 0, total = 0;
    b.values.forEach(function (v, i) { total += v; if (v > 0) active += 1; if (v > peak) { peak = v; peakAt = i; } });
    if (!total) return null;                       /* an axis with no bars says less than an empty state */
    var unit = b.weekly ? 'week' : 'day';
    var sub = (b.weekly ? 'Busiest week began ' : 'Busiest day: ') + b.labels[peakAt] +
      ' with ' + plural(peak, 'event') + '. ' + fmt.num(active) + ' of ' + plural(b.keys.length, unit) +
      ' in the window carry activity, ' + plural(Math.round(total / Math.max(1, active)), 'event') + ' on average.';
    return MK.charts.mount(parent, {
      id: 'at-volume', kind: 'bar', format: 'num', height: 196,
      title: b.weekly ? 'Events per week' : 'Events per day',
      subtitle: sub,
      note: b.weekly ? 'Counted by week because the window is longer than ' + plural(DAY_GRAIN_LIMIT, 'day') + '.'
        : 'One bar per calendar day of the window, including days with nothing on them.',
      data: {
        categories: b.labels, values: b.values, name: 'Events',
        colourVar: '--seq-500', categoryHeader: b.weekly ? 'Week beginning' : 'Day'
      }
    });
  }

  /* ------------------------------------------------------------------ actions by persona */

  function personaCard(env, stats) {
    var rows = stats.byActor.map(function (a) {
      return { name: a.name, role: a.role, events: a.events, entered: a.entered, reviewed: a.reviewed,
        approved: a.approved, rejected: a.rejected, payment: a.payment, last: a.last };
    });
    var maxEvents = rows.reduce(function (m, r) { return Math.max(m, r.events); }, 0);

    var sub;
    if (!env.count) {
      sub = 'Nothing was recorded in this window, so there is nothing to split.';
    } else if (!stats.approved) {
      sub = 'No approval falls in this window; the split below is what each person did.';
    } else if (stats.clashes) {
      sub = plural(stats.approved, 'approval') + ' in this window, ' + fmt.num(stats.clashes) +
        ' of them taken by the person who raised the record.';
    } else {
      sub = plural(stats.approved, 'approval') + ' in this window, none of them by the person who raised the record.';
    }

    var columns = [
      { key: 'name', label: 'Person', sortable: true, render: ui.cells.twoLine('role', { maxWidth: 180 }) },
      { key: 'entered', label: 'Entered', format: 'num', sortable: true,
        title: 'Raised, edited or submitted a bill or a vendor' },
      { key: 'reviewed', label: 'Checked', format: 'num', sortable: true,
        title: 'Took a bill up for review, or ran a vendor verification' },
      { key: 'approved', label: 'Approved', format: 'num', sortable: true,
        title: 'Approved a bill or a vendor, or released a payment batch to the bank' },
      { key: 'rejected', label: 'Rejected', format: 'num', sortable: true,
        title: 'Sent a bill, a vendor or a payment batch back, always with a reason' },
      { key: 'payment', label: 'Paid', format: 'num', sortable: true,
        title: 'Built or changed a payment batch and recorded the bank references' },
      { key: 'events', label: 'Events', format: 'num', sortable: true, render: ui.cells.bar(maxEvents || null, '--seq-500'),
        title: 'Every event this person is on, the columns beside it and any system event included' }
    ];

    return ui.card({
      title: 'Actions by person', subtitle: sub, flush: true, className: 'at-personacard',
      body: ui.table({
        columns: columns, rows: rows, dense: true,
        sort: env.st.sortPersona || { key: 'events', dir: 'desc' },
        onSort: function (s) { env.st.sortPersona = s; },
        empty: 'Nobody acted in this window',
        footer: { name: 'Everyone', entered: stats.entered, reviewed: stats.reviewed,
          approved: stats.approved, rejected: stats.rejected, payment: stats.payment, events: env.count }
      }),
      footer: h('div', { 'class': 'at-foot' },
        h('p', { 'class': 'at-note' }, ui.icon('shield-check', 14),
          h('span', null, 'Who may take which step is enforced when the action is taken, not here: this table only ' +
            'reports what the log holds.')),
        ui.sourceTag(['erp']))
    });
  }

  /* ------------------------------------------------------------------ record drawer */

  function changeTable(changes) {
    return ui.table({
      dense: true,
      columns: [
        { key: 'field', label: 'Field', render: function (v) { return h('span', { 'class': 'mk-strong' }, fieldLabel(v)); } },
        { key: 'before', label: 'Before', maxWidth: 190, render: function (v) { return v === null || v === undefined || v === '' ? dash('Empty before the edit') : String(v); } },
        { key: 'after', label: 'After', maxWidth: 190, render: function (v) { return v === null || v === undefined || v === '' ? dash('Cleared by the edit') : String(v); } }
      ],
      rows: (changes || []).map(function (c) { return { field: c.field, before: c.before, after: c.after }; }),
      empty: 'No field-level change recorded'
    });
  }

  function unitsOf(e) {
    if (e.unitId) return [e.unitId];
    return (e.unitIds || []).slice();
  }

  /* Bills and payment batches carry a reference a person can quote; a vendor's id is an internal key,
     so the record is named by its name instead and the label is split into reference + what it is about. */
  function hasReference(e) { return !!e.entityId && (e.entity === 'bill' || e.entity === 'batch'); }
  function splitLabel(e) {
    var label = String(e.entityLabel || '');
    if (hasReference(e) && label.indexOf(e.entityId) === 0) {
      return { ref: e.entityId, rest: label.slice(e.entityId.length).replace(/^\s*-\s*/, '') };
    }
    var i = label.indexOf(' - ');
    if (i > 0) return { ref: label.slice(0, i), rest: label.slice(i + 3) };
    return { ref: label || entityMeta(e.entity).label, rest: '' };
  }

  function openRecord(env, event) {
    var meta = entityMeta(event.entity);
    var trail = event.entityId
      ? guard('audit.trail', function () { return MK.audit.trail(event.entity, event.entityId); }, [])
      : [];
    if (!trail.length) trail = [event];
    var timeline = guard('audit.toTimeline', function () { return MK.audit.toTimeline(trail); }, []);
    var latest = trail[trail.length - 1] || event;
    var units = unitsOf(event);
    var edits = trail.filter(function (e) { return e.changes && e.changes.length; });

    var facts = ui.keyValue([
      ['Record type', h('span', { 'class': 'at-entity' }, ui.icon(meta.icon, 14), meta.label)],
      ['Reference', hasReference(event) ? event.entityId
        : (event.entityId ? null : dash('This event belongs to no single record'))],
      ['Unit', units.length
        ? h('span', { 'class': 'at-units' }, units.map(function (u) {
          return h('span', { 'class': 'at-unit' }, dot(env.look.colour(u)), env.look.name(u));
        }))
        : dash('Applies to every unit')],
      ['Steps recorded', plural(trail.length, 'step')],
      ['First step', ui.dateTime(trail[0] ? trail[0].at : event.at)],
      ['Latest step', ui.dateTime(latest.at) + ' - ' + actionLabel(latest)]
    ], { cols: 2 });

    var body = [facts];

    if (edits.length) {
      body.push(h('div', { 'class': 'at-drawer__block' },
        h('h4', { 'class': 'mk-h3' }, 'Field changes'),
        h('p', { 'class': 'at-note' }, ui.icon('edit', 14),
          h('span', null, plural(edits.length, 'edit') + ' on this record, with the value before and after each one.')),
        edits.map(function (e) {
          return h('div', { 'class': 'at-change' },
            h('div', { 'class': 'at-change__head' },
              h('span', { 'class': 'mk-strong' }, actionLabel(e)),
              h('span', { 'class': 'mk-muted mk-small' }, ui.dateTime(e.at) + ' - ' + e.actorName + ', ' + e.roleLabel)),
            changeTable(e.changes));
        })));
    }

    body.push(h('div', { 'class': 'at-drawer__block' },
      h('h4', { 'class': 'mk-h3' }, 'Timeline'),
      timeline.length ? ui.timeline(timeline) : ui.emptyState('No timeline for this event', null, { compact: true, icon: 'clock' })));

    body.push(ui.sourceTag(['erp']));

    var footer = [];
    if (meta.page && event.entityId && guard('isAllowed', function () { return MK.router.isAllowed(meta.page); }, false)) {
      footer.push(ui.button({
        label: 'Open this ' + meta.label.toLowerCase(), icon: 'external',
        onClick: function () { d.close(); env.ctx.navigate(meta.page, { id: event.entityId }); }
      }));
    }
    footer.push(ui.button({ label: 'Close', variant: 'ghost', onClick: function () { d.close(); } }));

    /* the drawer lives outside the page root: its body carries the page class so the page stylesheet reaches it */
    var d = ui.drawer({
      title: event.entityLabel || actionLabel(event),
      subtitle: meta.label + (hasReference(event) ? ' - ' + event.entityId : ''),
      headerExtra: latest.to ? ui.statusChip(latest.to) : null,
      width: 560, body: h('div', { 'class': 'pg-audit-trail at-drawer' }, body), footer: footer
    });
    return d;
  }

  /* ------------------------------------------------------------------ the log */

  /** Two compact lines - the day above the time - so the log keeps its width for the record and the note. */
  function whenCell(at) {
    var day = dayOf(at), time = String(at || '').slice(11, 16);
    return h('span', { 'class': 'at-when', title: ui.dateTime(at) },
      h('span', { 'class': 'at-when__day' }, D.label(day, 'd MMM yyyy')),
      time ? h('span', { 'class': 'at-when__time mk-num' }, time) : null);
  }

  function stateCell(r) {
    if (!r.from && !r.to) return dash('No state change');
    if (!r.from) return ui.statusChip(r.to);
    if (!r.to) return ui.statusChip(r.from);
    if (r.from === r.to) return h('span', { 'class': 'at-states' }, ui.statusChip(r.to), h('span', { 'class': 'at-states__same' }, 'unchanged'));
    return h('span', { 'class': 'at-states' }, ui.statusChip(r.from), ui.icon('arrow-right', 14), ui.statusChip(r.to));
  }

  /** Reference above, what it is about below - so a bill number is never cut in half. */
  function recordCell(r) {
    var meta = entityMeta(r.entity);
    var p = splitLabel(r.event);
    var second = p.rest || meta.label;
    return h('span', { 'class': 'at-record', title: meta.label + ' - ' + (r.event.entityLabel || meta.label) },
      h('span', { 'class': 'at-record__ref' }, ui.icon(meta.icon, 13), h('span', null, p.ref)),
      p.ref === second ? null : h('span', { 'class': 'at-record__sub' }, second));
  }

  function unitCell(env, r) {
    var units = unitsOf(r.event);
    if (!units.length) return dash('Applies to every unit');
    if (units.length === 1) return h('span', { 'class': 'at-unit' }, dot(env.look.colour(units[0])), env.look.short(units[0]));
    return ui.chip(plural(units.length, 'unit'), 'neutral', {
      outline: true, icon: 'layers',
      title: units.map(function (u) { return env.look.name(u); }).join(', ')
    });
  }

  function csvColumns() {
    return [
      { key: 'at', label: 'Time' },
      { key: 'actorName', label: 'Person' },
      { key: 'roleLabel', label: 'Role' },
      { key: 'action', label: 'Action id' },
      { key: 'actionText', label: 'Action' },
      { key: 'entity', label: 'Record type' },
      { key: 'entityId', label: 'Reference' },
      { key: 'entityLabel', label: 'Record' },
      { key: 'unitText', label: 'Unit' },
      { key: 'from', label: 'From state' },
      { key: 'to', label: 'To state' },
      { key: 'note', label: 'Note' }
    ];
  }

  function logCard(env) {
    var rows = env.pageRows.map(function (e) {
      return {
        id: e.id, at: e.at, actorName: e.actorName, roleLabel: e.roleLabel, action: e.action,
        actionText: actionLabel(e), entity: e.entity, entityId: e.entityId,
        entityLabel: e.entityLabel || entityMeta(e.entity).label, entityText: entityMeta(e.entity).label,
        from: e.from, to: e.to, note: e.note, event: e
      };
    });

    var columns = [
      { key: 'at', label: 'When', width: 96, sortValue: function (r) { return r.at; },
        title: 'Recorded on the demo clock when the action was taken',
        render: function (v) { return whenCell(v); } },
      { key: 'actorName', label: 'Who', render: ui.cells.twoLine('roleLabel', { maxWidth: 132 }) },
      /* the action names itself in full - it wraps rather than losing its last words to an ellipsis */
      { key: 'actionText', label: 'Action', wrap: true, width: 150 },
      { key: 'entityLabel', label: 'Record', className: 'at-recordcell',
        render: function (v, r) { return recordCell(r); } },
      { key: 'unit', label: 'Unit', render: function (v, r) { return unitCell(env, r); } },
      { key: 'state', label: 'From and to', width: 158, className: 'at-statecell',
        render: function (v, r) { return stateCell(r); } },
      { key: 'note', label: 'Note', wrap: true, width: 190,
        render: function (v) { return v ? v : dash('No note'); } }
    ];

    var first = env.count ? env.page * PAGE_SIZE + 1 : 0;
    var last = Math.min(env.count, (env.page + 1) * PAGE_SIZE);
    var pager = h('div', { 'class': 'at-pager' },
      h('span', { 'class': 'at-pager__count mk-muted mk-small' },
        env.count ? 'Showing ' + fmt.num(first) + ' to ' + fmt.num(last) + ' of ' + plural(env.count, 'event') : 'Nothing to show'),
      h('div', { 'class': 'at-pager__buttons' },
        ui.button({ label: 'Newer', icon: 'chevron-left', size: 'sm', disabled: env.page === 0,
          onClick: function () { env.st.page = Math.max(0, env.page - 1); env.ctx.rerender(); } }),
        h('span', { 'class': 'at-pager__page mk-small' }, 'Page ' + fmt.num(env.page + 1) + ' of ' + fmt.num(env.pages)),
        ui.button({ label: 'Older', iconRight: 'chevron-right', size: 'sm', disabled: env.page >= env.pages - 1,
          onClick: function () { env.st.page = Math.min(env.pages - 1, env.page + 1); env.ctx.rerender(); } })));

    var exportBtn = ui.button({
      label: 'Export CSV', icon: 'download', size: 'sm', disabled: !env.count,
      title: 'Every event that matches the filters, not just this page',
      onClick: function () {
        var all = env.rows.map(function (e) {
          var units = unitsOf(e);
          return { at: e.at, actorName: e.actorName, roleLabel: e.roleLabel, action: e.action, actionText: actionLabel(e),
            entity: entityMeta(e.entity).label, entityId: e.entityId || '', entityLabel: e.entityLabel || '',
            unitText: units.map(function (u) { return env.look.name(u); }).join(' / '),
            from: stateLabel(e.from), to: stateLabel(e.to), note: e.note || '' };
        });
        ui.downloadCsv('audit-trail-' + env.windowFrom + '-to-' + env.windowTo + '.csv', csvColumns(), all);
        ui.toast(plural(all.length, 'event') + ' exported.', { tone: 'good' });
      }
    });

    return ui.card({
      title: 'Activity log',
      subtitle: 'Newest first. Open a row for the record\'s full timeline and the value of every field before and after an edit.',
      actions: exportBtn, flush: true, className: 'at-logcard',
      body: ui.table({
        columns: columns, rows: rows, dense: true,
        onRowClick: function (r) { openRecord(env, r.event); },
        empty: ui.emptyState('No event matches these filters',
          'Widen the period or clear a filter. The log holds every workflow action of the units you may see.',
          { icon: 'search', compact: true })
      }),
      footer: h('div', { 'class': 'at-foot' }, pager, ui.sourceTag(['erp']))
    });
  }

  /* ------------------------------------------------------------------ render */

  function intro(env) {
    return h('div', { 'class': 'at-intro' },
      h('p', { 'class': 'at-intro__text' },
        'Every state change of a bill, a payment batch or a vendor is written here as it happens, with the person, ' +
        'the role, the time, the states it moved between and the reason typed at the time. Nothing in this log can ' +
        'be edited; it is the record of what the approval rules allowed.'),
      h('p', { 'class': 'at-intro__who' }, ui.icon('user', 14),
        h('span', null, 'Signed in as ' + (env.user ? env.user.name : '') + (env.user ? ' - ' + env.user.roleLabel : '') +
          '. The log is already narrowed to the units you may see: ' + plural(env.allCount, 'event') + ' from ' +
          D.label(env.logFirst, 'd MMM') + ' to ' + D.label(env.logLast, 'd MMM yyyy') + '.')));
  }

  function render(rootEl, ctx) {
    var env = buildEnv(ctx);

    rootEl.appendChild(intro(env));

    if (!env.allCount) {
      rootEl.appendChild(ui.emptyState('No activity in your scope',
        'The audit trail shows the workflow actions of the units you may see. Nothing has been recorded for them yet.',
        { icon: 'shield-check' }));
      return;
    }

    rootEl.appendChild(filterCard(env));

    var stats = buildStats(env);
    rootEl.appendChild(kpis(env, stats));

    var plot = h('div', { 'class': 'at-plot' });
    rootEl.appendChild(plot);
    var chart = timeChart(env, plot);
    if (chart) {
      var tag = ui.sourceTag(['erp']);
      tag.classList.add('at-source-end');
      chart.el.appendChild(tag);
    } else {
      plot.appendChild(ui.card({
        title: 'Events per day',
        body: ui.emptyState('No activity between ' + D.label(env.windowFrom, 'd MMM') + ' and ' +
          D.label(env.windowTo, 'd MMM yyyy'),
          'Widen the period or clear a filter to see where the work sits.', { icon: 'chart', compact: true }),
        footer: ui.sourceTag(['erp'])
      }));
    }

    rootEl.appendChild(personaCard(env, stats));
    rootEl.appendChild(logCard(env));
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/system/audit',
    group: 'System',
    title: 'Audit trail',
    subtitle: 'Every workflow action, who did it and when',
    units: 'all',
    roles: null,
    filters: [],
    render: render
  });
})(window);
