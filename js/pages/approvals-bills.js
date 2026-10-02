/*
 * Approvals / Bills (#/approvals/bills) - tier one of the two-tier maker-checker.
 *
 * Blocks: purpose line with what the persona may do -> KPI row -> unpaid bills by unit and stage + "needs a closer look"
 * -> the bills card (status tabs, search and quick filters, paged table, CSV) -> review drawer (fields, budget impact,
 * duplicate check, vendor, timeline, action bar) and the new / edit bill form drawer.
 *
 * Every figure comes from MK.workflow / MK.audit / MK.finance and is formatted with MK.fmt. Access is never filtered
 * here: reads are scoped by the data layer, and every action asks MK.workflow.bill.can() so that a blocked action is
 * shown disabled with the reason (tooltip and muted text under the action bar).
 *
 * Page-local state (ctx.state): userId, tab, search, unit, category, month, flagged, page, pageSize, sort, openId,
 * paramSig / linked (deep links: ?id= ?tab= ?unit= ?category= ?month= ?flagged=1 ?q=).
 * Drawers and modals live outside the page root; their content sits in a wrapper that carries the page class so the
 * page stylesheet applies. The module keeps one `live` object so an open drawer always talks to the latest render.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates, doc = root.document;

  var PAGE_ID = 'approvals-bills';
  var PAGE_CLASS = 'pg-approvals-bills';
  var ALL = 'ALL';
  var PAGE_SIZES = [25, 50, 100];
  var STATUS_ORDER = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'IN_BATCH', 'PAID', 'REJECTED'];
  var OPEN_STAGES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'IN_BATCH'];
  var UNDECIDED = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'REJECTED'];
  var DUE_SOON_DAYS = 7;          /* same horizon as MK.finance.payables().dueIn7Days; never printed */
  var ATTENTION_ROWS = 5;
  var MAX_ATTACHMENTS = 5;
  var MONEY_FIELDS = { amount: 1, gstAmount: 1, tdsAmount: 1, payable: 1 };
  var DATE_FIELDS = { invoiceDate: 1, dueDate: 1 };
  var FIELD_LABELS = {
    unitId: 'Unit', vendorId: 'Vendor', categoryId: 'Category', invoiceNo: 'Vendor invoice no.', invoiceDate: 'Invoice date', dueDate: 'Due date',
    monthKey: 'Expense month', description: 'Description', amount: 'Amount', gstAmount: 'GST', tdsLabel: 'TDS type', tdsAmount: 'TDS',
    payable: 'Payable', notes: 'Notes', attachments: 'Attachment', lines: 'Expense lines'
  };

  /* what the open overlays need from the latest render */
  var live = { ctx: null, st: null, env: null, card: null, repaint: null, markSelected: null, drawer: null, form: null };

  /* ------------------------------------------------------------------ helpers */

  function guard(name, fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; }
    catch (e) { if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e); return fallback; }
  }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function day(iso, style) { return iso ? D.label(String(iso).slice(0, 10), style || 'd MMM yyyy') : '-'; }
  function monthName(key) { return key ? D.monthLabel(key, true) : '-'; }
  function pipelineStates() { return (MK.workflow.bill.PIPELINE_STATES || ['SUBMITTED', 'UNDER_REVIEW']).slice(); }
  function committedStates() { return (MK.workflow.bill.COMMITTED_STATES || ['APPROVED', 'IN_BATCH', 'PAID']).slice(); }
  function stateLabel(s) { var L = MK.workflow && MK.workflow.labels && MK.workflow.labels.state; return (L && L[s]) || ui.statusInfo(s).label; }
  function flagLabel(code) { var L = MK.workflow && MK.workflow.labels && MK.workflow.labels.flag; return (L && L[code]) || ''; }
  function userName(id) { var u = id ? MK.session.userById(id) : null; return u ? u.name : (id || '-'); }
  function userRole(id) { var u = id ? MK.session.userById(id) : null; return u ? u.roleLabel : ''; }
  function has(list, x) { return !!list && list.indexOf(x) !== -1; }
  function blank(v) { return v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v)); }
  function lower(s) { return String(s || '').toLowerCase(); }
  function lowerFirst(s) { s = String(s || ''); return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

  function lookups() {
    var units = {}, unitOrder = [], cats = {}, vendors = {}, names = {};
    ((MK.config && MK.config.outlets) || []).forEach(function (u) { units[u.id] = u; unitOrder.push(u.id); });
    ((MK.config && MK.config.expenseCategories) || []).forEach(function (c) { cats[c.id] = c; });
    guard('vendor.list', function () { return MK.workflow.vendor.list(); }, []).forEach(function (v) { vendors[v.id] = v; });
    return {
      units: units, unitOrder: unitOrder, cats: cats, vendors: vendors,
      unitName: function (id) { return units[id] ? units[id].name : (id || '-'); },
      unitShort: function (id) { return units[id] ? (units[id].short || units[id].name) : (id || '-'); },
      unitColour: function (id) { return units[id] ? units[id].colourVar : null; },
      catLabel: function (id) { return cats[id] ? cats[id].label : (id || '-'); },
      vendorName: function (id) {
        if (vendors[id]) return vendors[id].name;
        if (!Object.prototype.hasOwnProperty.call(names, id)) names[id] = guard('vendor.nameOf', function () { return MK.workflow.vendor.nameOf(id); }, id || '-');
        return names[id];
      }
    };
  }

  function dot(colourVar) {
    return h('span', { 'class': 'ab-dot', 'aria-hidden': 'true', style: colourVar ? { background: 'var(' + colourVar + ')' } : null });
  }

  function unitTag(env, unitId) {
    return h('span', { 'class': 'ab-unit', title: env.look.unitName(unitId) }, dot(env.look.unitColour(unitId)), env.look.unitShort(unitId));
  }

  /* ------------------------------------------------------------------ per-render environment */

  function buildEnv(ctx) {
    var W = MK.workflow;
    var env = { ctx: ctx, st: ctx.state, user: ctx.user || MK.session.current(), look: lookups(), today: MK.calendar.today, released: {} };
    env.allowedUnits = MK.session.allowedUnitIds();
    env.counts = guard('bill.counts', function () { return W.bill.counts(); }, null) ||
      { total: 0, totalPayable: 0, awaitingApproval: 0, awaitingApprovalPayable: 0, byStatus: {} };
    env.undecided = guard('bill.list undecided', function () { return W.bill.list({ status: UNDECIDED }); }, []);
    env.impacts = {};
    env.undecided.forEach(function (b) { env.impacts[b.id] = guard('bill.budgetImpact', function () { return W.bill.budgetImpact(b); }, null); });
    env.mayCreate = MK.session.can('bill.create');
    env.mayApprove = MK.session.can('bill.approve');
    env.waitDays = (MK.insights && MK.insights.RULES && MK.insights.RULES.approvals && MK.insights.RULES.approvals.waitDays) || null;
    return env;
  }

  function byStatus(env, status) { var s = env.counts.byStatus && env.counts.byStatus[status]; return s || { count: 0, payable: 0 }; }

  /* a bill whose payment batch was released is with the bank: neither overdue nor due (the rule of MK.finance.payables) */
  function isReleased(b, env) {
    if (b.status !== 'IN_BATCH' || !b.batchId) return false;
    if (Object.prototype.hasOwnProperty.call(env.released, b.id)) return env.released[b.id];
    var out = false;
    var pb = guard('batch.get', function () { return MK.workflow.batch.get(b.batchId); }, null);
    if (pb) out = pb.status === 'RELEASED' || pb.status === 'PAID';
    else {
      /* the batch mixes units outside the persona's scope: the bill's own trail still carries the release step */
      out = guard('audit.trail', function () { return MK.audit.trail('bill', b.id); }, []).some(function (e) { return e && e.action === 'bill.released'; });
    }
    env.released[b.id] = out;
    return out;
  }

  function dueInfo(b, env) {
    if (!b.dueDate) return { kind: 'none' };
    if (b.status === 'PAID') {
      var late = b.paidOn ? D.diffDays(b.dueDate, b.paidOn) : 0;
      return { kind: 'paid', paidOn: b.paidOn || null, late: late > 0 ? late : 0 };
    }
    if (b.status === 'REJECTED') return { kind: 'closed' };
    if (isReleased(b, env)) return { kind: 'transit' };
    var days = D.diffDays(env.today, b.dueDate);
    if (days < 0) return { kind: 'overdue', days: -days };
    if (days <= DUE_SOON_DAYS) return { kind: 'soon', days: days };
    return { kind: 'later', days: days };
  }

  function waitingDays(b, env) {
    return b.submittedAt && has(pipelineStates(), b.status) ? D.diffDays(b.submittedAt.slice(0, 10), env.today) : null;
  }

  function flagCodes(b, env) {
    var out = (b.flags || []).slice();
    var impact = env.impacts[b.id];
    if (impact && impact.available && impact.status === 'OVER' && !impact.alreadyCommitted) out.push('OVER_BUDGET');
    return out;
  }

  function overBudgetTitle(impact, env) {
    if (!impact || !impact.available) return '';
    return 'Takes ' + lowerFirst(env.look.catLabel(impact.categoryId)) + ' at ' + env.look.unitName(impact.unitId) + ' to ' + fmt.pct(impact.utilisationAfter, 0) +
      ' of the ' + monthName(impact.monthKey) + ' plan of ' + fmt.inr(impact.budget);
  }

  function flagChip(code, b, env) {
    if (code === 'DUPLICATE_INVOICE') return ui.chip('Duplicate', 'critical', { icon: 'copy', title: flagLabel(code) || 'Duplicate invoice suspected' });
    if (code === 'POSSIBLE_DUPLICATE') return ui.chip('Possible duplicate', 'warn', { icon: 'copy', title: flagLabel(code) });
    if (code === 'OVER_BUDGET') return ui.chip('Over budget', 'serious', { icon: 'alert-triangle', title: overBudgetTitle(env.impacts[b.id], env) });
    return ui.chip(code, 'neutral');
  }

  function flagText(code) {
    return code === 'DUPLICATE_INVOICE' ? 'Duplicate invoice suspected' : code === 'POSSIBLE_DUPLICATE' ? 'Possible duplicate' : code === 'OVER_BUDGET' ? 'Over budget' : code;
  }

  function toRow(b, env) {
    var codes = flagCodes(b, env);
    return {
      id: b.id, bill: b, number: b.number, vendorName: env.look.vendorName(b.vendorId), unitName: env.look.unitName(b.unitId),
      categoryLabel: env.look.catLabel(b.categoryId), invoiceNo: b.invoiceNo, invoiceDate: b.invoiceDate, dueDate: b.dueDate, monthKey: b.monthKey,
      amount: b.amount, gstAmount: b.gstAmount, tdsAmount: b.tdsAmount, payable: b.payable, status: b.status, statusLabel: stateLabel(b.status),
      flagCodes: codes, flagText: codes.map(flagText).join('; ')
    };
  }

  /* ------------------------------------------------------------------ state */

  function defaultTab(env) {
    if (env.mayApprove.ok) return byStatus(env, 'SUBMITTED').count || !byStatus(env, 'UNDER_REVIEW').count ? 'SUBMITTED' : 'UNDER_REVIEW';
    if (env.mayCreate.ok) return 'DRAFT';
    return ALL;
  }

  function reviewTab(env) { return byStatus(env, 'SUBMITTED').count || !byStatus(env, 'UNDER_REVIEW').count ? 'SUBMITTED' : 'UNDER_REVIEW'; }

  function normaliseState(st, env) {
    if (st.userId !== env.user.id) {                 /* first render, or the persona changed: land on that persona's queue */
      st.userId = env.user.id; st.tab = defaultTab(env); st.page = 0;
      if (st.unit && st.unit !== ALL && !has(env.allowedUnits, st.unit)) st.unit = ALL;
    }
    if (st.tab !== ALL && !has(STATUS_ORDER, st.tab)) st.tab = defaultTab(env);
    st.search = typeof st.search === 'string' ? st.search : '';
    st.unit = st.unit || ALL;
    st.category = st.category || ALL;
    st.month = st.month || null;
    st.flagged = !!st.flagged;
    st.page = st.page > 0 ? Math.floor(st.page) : 0;
    if (!has(PAGE_SIZES, st.pageSize)) st.pageSize = PAGE_SIZES[0];
  }

  function applyParams(st, ctx, env) {
    var p = ctx.params || {};
    var sig = ['tab', 'unit', 'unitId', 'category', 'categoryId', 'month', 'monthKey', 'flagged', 'q'].map(function (k) { return p[k] || ''; }).join('|');
    if (st.paramSig === sig) return;
    st.paramSig = sig;
    if (!sig.replace(/\|/g, '')) return;
    /* a link shows exactly what it asks for: the quick filters a previous link left behind never narrow it further */
    st.search = ''; st.unit = ALL; st.category = ALL; st.month = null; st.flagged = false;
    var tab = String(p.tab || '').toUpperCase().replace(/[\s-]+/g, '_');
    if (tab === 'REVIEW' || tab === 'AWAITING') st.tab = reviewTab(env);
    else if (tab === ALL || has(STATUS_ORDER, tab)) st.tab = tab;
    var unit = p.unit || p.unitId; if (unit && has(env.allowedUnits, unit)) st.unit = unit;
    var cat = p.category || p.categoryId; if (cat && env.look.cats[cat]) st.category = cat;
    var month = p.month || p.monthKey; if (month && /^\d{4}-\d{2}$/.test(month)) st.month = month;
    if (p.flagged) st.flagged = p.flagged === '1' || p.flagged === 'true';
    if (p.q) st.search = String(p.q);
    if ((unit || cat || month || p.q || p.flagged) && !p.tab) st.tab = ALL;
    st.page = 0;
  }

  /* a tile, a chart segment or a list link shows exactly what it counts: the quick filters of the register are reset first */
  function showInTable(change) {
    if (!live.st || !live.ctx) return;
    var s0 = live.st;
    s0.search = ''; s0.unit = ALL; s0.category = ALL; s0.month = null; s0.flagged = false;
    change(s0); s0.page = 0;
    live.ctx.rerender();
    if (live.card && live.card.scrollIntoView) live.card.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------------------------ intro */

  function intro(env) {
    var u = env.user, parts = [];
    if (env.mayApprove.ok) parts.push('you review, approve or reject bills raised by others');
    if (env.mayCreate.ok) {
      var names = env.allowedUnits.length === (MK.session.ALL_UNITS || []).length ? 'every unit' : env.allowedUnits.map(env.look.unitName).join(', ');
      parts.push('you raise and submit bills for ' + names + '; the decision sits with the finance checker');
    }
    if (!parts.length) {
      parts.push('you can follow every bill in your scope but not change it (' + lowerFirst(env.mayApprove.reason) + ')');
      if (MK.session.can('batch.release').ok) parts.push('your turn comes at tier two, when a payment batch of approved bills is released');
      else if (MK.session.can('batch.create').ok) parts.push('your work starts once a bill is approved: you put it into a payment batch');
    }
    return h('p', { 'class': 'ab-intro' },
      'Tier one of the two-tier maker-checker: a maker enters the vendor bill, the finance checker decides it against the budget and the duplicate check, and only an approved bill can reach a payment batch. ',
      h('span', { 'class': 'ab-intro__who' }, 'As ' + u.name + ' (' + u.roleLabel + ') ' + parts.join('; ') + '.'));
  }

  /* ------------------------------------------------------------------ KPI row */

  function kpis(env) {
    var W = MK.workflow, pipe = pipelineStates();
    var queue = env.undecided.filter(function (b) { return has(pipe, b.status); });
    var sub = byStatus(env, 'SUBMITTED'), rev = byStatus(env, 'UNDER_REVIEW'), app = byStatus(env, 'APPROVED'), inb = byStatus(env, 'IN_BATCH'), rej = byStatus(env, 'REJECTED');

    var oldest = queue.filter(function (b) { return !!b.submittedAt; }).sort(function (a, b) { return a.submittedAt < b.submittedAt ? -1 : (a.submittedAt > b.submittedAt ? 1 : 0); })[0] || null;
    var oldestDays = oldest ? D.diffDays(oldest.submittedAt.slice(0, 10), env.today) : null;
    var slow = env.waitDays !== null && oldestDays !== null && oldestDays >= env.waitDays;

    var approved = guard('bill.list approved', function () { return W.bill.list({ status: 'APPROVED' }); }, []);
    var late = approved.filter(function (b) { return b.dueDate && b.dueDate < env.today; });
    var lateValue = late.reduce(function (t, b) { return t + (b.payable || 0); }, 0);

    var monthStart = D.monthStart(env.today);
    var rejections = guard('audit.count', function () { return MK.audit.count({ entity: 'bill', action: 'bill.reject', from: monthStart }); }, 0);

    var dup = 0, over = 0, flagged = 0;
    env.undecided.forEach(function (b) {
      var codes = flagCodes(b, env);
      if (!codes.length) return;
      flagged += 1;
      if (has(codes, 'DUPLICATE_INVOICE') || has(codes, 'POSSIBLE_DUPLICATE')) dup += 1;
      if (has(codes, 'OVER_BUDGET')) over += 1;
    });
    /* the two reasons overlap, so never print them as if they added up to the headline */
    var flagBits = [];
    if (over) flagBits.push(fmt.num(over) + ' on a budget line over plan');
    if (dup) flagBits.push(fmt.num(dup) + ' repeating a vendor invoice number');
    var flagSub = flagged ? flagBits.join(', ') + (dup && over ? ' - a bill can be both' : '')
      : 'No duplicate or over-budget bill is open';

    return [
      { label: 'Awaiting review', icon: 'receipt', value: fmt.num(env.counts.awaitingApproval),
        sub: fmt.inr(env.counts.awaitingApprovalPayable) + ' payable - ' + fmt.num(sub.count) + ' submitted, ' + fmt.num(rev.count) + ' under review',
        title: 'Bills submitted by a maker and not yet approved or rejected', tone: slow ? 'warn' : null,
        onClick: function () { showInTable(function (st) { st.tab = reviewTab(env); }); } },
      { label: 'Oldest waiting', icon: 'clock', value: oldest ? plural(oldestDays, 'day') : '-',
        sub: oldest ? oldest.number + ' - ' + env.look.vendorName(oldest.vendorId) + ', submitted ' + day(oldest.submittedAt, 'd MMM') : 'Nothing is waiting for a decision',
        title: oldest ? 'Open the bill that has waited longest for a decision' : null, tone: slow ? 'warn' : null,
        onClick: oldest ? function () { openBill(oldest.id); } : null },
      { label: 'Approved, awaiting payment', icon: 'wallet', value: fmt.inr(app.payable),
        sub: plural(app.count, 'bill') + ' not yet in a batch' + (late.length ? ' - ' + fmt.num(late.length) + ' overdue (' + fmt.inr(lateValue) + ')' : '') + '; ' + fmt.num(inb.count) + ' more in a payment batch',
        title: 'Approved bills the payer has not yet put into a payment batch', tone: late.length ? 'warn' : null,
        onClick: function () { showInTable(function (st) { st.tab = 'APPROVED'; }); } },
      { label: 'Rejections this month', icon: 'x-circle', value: fmt.num(rejections),
        sub: rejections
          ? 'Sent back since ' + day(monthStart, 'd MMM') + ' - ' + (rej.count ? plural(rej.count, 'bill is', 'bills are') + ' still with the maker' : 'all have since been corrected or reopened')
          : 'No bill has been sent back since ' + day(monthStart, 'd MMM'),
        title: 'Bills the checker sent back to the maker since ' + day(monthStart, 'd MMM') + '; the line below counts those still sitting rejected',
        onClick: function () { showInTable(function (st) { st.tab = 'REJECTED'; }); } },
      { label: 'Flagged before a decision', icon: 'alert-triangle', value: fmt.num(flagged),
        sub: flagSub,
        title: 'Drafts, submitted, under-review and rejected bills that carry a duplicate or over-budget flag', tone: dup ? 'critical' : (over ? 'warn' : null),
        onClick: function () { showInTable(function (st) { st.tab = ALL; st.flagged = true; }); } }
    ];
  }

  /* ------------------------------------------------------------------ unpaid bills by unit and stage */

  function stageChart(env) {
    var open = guard('bill.list open', function () { return MK.workflow.bill.list({ status: OPEN_STAGES }); }, []);
    var sums = {}, totals = {}, grand = 0, awaiting = 0, ready = 0, pipe = pipelineStates();
    open.forEach(function (b) {
      var u = sums[b.unitId] || (sums[b.unitId] = {});
      u[b.status] = (u[b.status] || 0) + (b.payable || 0);
      totals[b.unitId] = (totals[b.unitId] || 0) + (b.payable || 0);
      grand += b.payable || 0;
      if (has(pipe, b.status)) awaiting += b.payable || 0;
      else if (b.status !== 'DRAFT') ready += b.payable || 0;
    });
    var unitIds = env.look.unitOrder.filter(function (id) { return totals[id] > 0; });
    Object.keys(totals).forEach(function (id) { if (!has(unitIds, id) && totals[id] > 0) unitIds.push(id); });
    var top = unitIds.slice().sort(function (a, b) { return totals[b] - totals[a]; })[0] || null;
    var subtitle = !top ? 'No unpaid bill in your scope'
      : (unitIds.length > 1
        ? fmt.inr(grand) + ' is unpaid across ' + plural(unitIds.length, 'unit') + '; ' + env.look.unitName(top) + ' holds the most at ' + fmt.inr(totals[top]) + ', ' + fmt.pct(grand ? totals[top] / grand : 0, 0) + ' of it. '
        : fmt.inr(grand) + ' is unpaid at ' + env.look.unitName(top) + '. ') +
        (awaiting ? fmt.inr(awaiting) + ' of that still needs the checker, ' + fmt.inr(ready) + ' is approved and waiting to be paid.'
          : 'Nothing needs the checker; ' + fmt.inr(ready) + ' is approved and waiting to be paid.');
    var nameToId = {};
    unitIds.forEach(function (id) { nameToId[env.look.unitName(id)] = id; });

    var host = h('div', { 'class': 'ab-cell' });
    if (!MK.charts || typeof MK.charts.mount !== 'function') { host.appendChild(ui.card({ title: 'Unpaid bills by unit and stage', body: ui.emptyState('Charts are not loaded', null, { compact: true }) })); return host; }
    var chart = MK.charts.mount(null, {
      id: 'ab-stage', kind: 'hstackedBar', title: 'Unpaid bills by unit and stage', subtitle: subtitle, format: 'inr',
      height: Math.max(168, 64 + unitIds.length * 46),
      data: {
        categories: unitIds.map(env.look.unitName), categoryHeader: 'Unit',
        series: OPEN_STAGES.map(function (s) { return { id: s, name: stateLabel(s), values: unitIds.map(function (id) { return (sums[id] && sums[id][s]) || 0; }) }; })
      },
      emptyText: 'No unpaid bill in your scope',
      note: 'Payable value (amount plus GST, less TDS). Click a segment to list those bills below.',
      onClick: function (d) {
        if (!d || !d.seriesId) return;
        showInTable(function (st) { st.tab = d.seriesId; st.unit = nameToId[d.category] || ALL; });
      }
    });
    chart.el.appendChild(ui.sourceTag(['erp']));
    host.appendChild(chart.el);
    return host;
  }

  /* ------------------------------------------------------------------ needs a closer look */

  function attentionCard(env) {
    var pipe = pipelineStates();
    var queue = env.undecided.filter(function (b) { return has(pipe, b.status); });
    var items = [];
    queue.forEach(function (b) {
      var codes = flagCodes(b, env), reasons = [], score = 0;
      var due = dueInfo(b, env), wait = waitingDays(b, env), impact = env.impacts[b.id];
      if (has(codes, 'DUPLICATE_INVOICE')) { reasons.push(flagChip('DUPLICATE_INVOICE', b, env)); score += 100; }
      if (due.kind === 'overdue') { reasons.push(ui.chip('Overdue ' + plural(due.days, 'day'), 'critical', { icon: 'clock' })); score += 50; }
      if (has(codes, 'OVER_BUDGET')) { reasons.push(ui.chip(fmt.pct(impact.utilisationAfter, 0) + ' of plan', 'serious', { icon: 'alert-triangle', title: overBudgetTitle(impact, env) })); score += 30 + Math.min(25, Math.max(0, ((impact.utilisationAfter || 1) - 1) * 10)); }
      if (has(codes, 'POSSIBLE_DUPLICATE')) { reasons.push(flagChip('POSSIBLE_DUPLICATE', b, env)); score += 20; }
      if (env.waitDays !== null && wait !== null && wait >= env.waitDays) { reasons.push(ui.chip('Waiting ' + plural(wait, 'day'), 'warn', { icon: 'clock' })); score += 10; }
      if (reasons.length) items.push({ bill: b, reasons: reasons, score: score });
    });
    items.sort(function (a, b) { return b.score - a.score || (b.bill.payable || 0) - (a.bill.payable || 0); });

    var body;
    if (!queue.length) body = ui.emptyState('Nothing is waiting for a decision', 'Submitted bills appear here when they carry a duplicate, budget, due-date or waiting-time flag.', { compact: true, icon: 'check-circle' });
    else if (!items.length) body = ui.callout('good', 'Nothing in the queue is flagged', 'None of the ' + plural(queue.length, 'bill') + ' awaiting review repeats an invoice, breaks a budget line, is overdue or has waited long.');
    else {
      body = h('ul', { 'class': 'ab-att' }, items.slice(0, ATTENTION_ROWS).map(function (it) {
        var b = it.bill;
        return h('li', null, h('button', { type: 'button', 'class': 'ab-att__row', 'aria-label': 'Open ' + b.number, onClick: function () { openBill(b.id); } },
          h('span', { 'class': 'ab-att__top' },
            h('span', { 'class': 'ab-att__title' }, h('span', { 'class': 'ab-mono' }, b.number), h('span', { 'class': 'ab-att__vendor' }, env.look.vendorName(b.vendorId))),
            h('span', { 'class': 'ab-att__amt' }, fmt.inrFull(b.payable))),
          h('span', { 'class': 'ab-att__meta' }, env.look.unitName(b.unitId) + ' - ' + env.look.catLabel(b.categoryId) + ' - ' + stateLabel(b.status)),
          h('span', { 'class': 'ab-att__chips' }, it.reasons)));
      }));
    }
    var more = items.length > ATTENTION_ROWS ? plural(items.length - ATTENTION_ROWS, 'more bill') + ' - ' : '';
    var subtitle = !queue.length ? 'The review queue is empty'
      : items.length
        ? (items.length === queue.length ? plural(items.length, 'bill') : fmt.num(items.length) + ' of the ' + plural(queue.length, 'bill')) +
          ' awaiting review ' + (items.length === 1 ? 'needs' : 'need') + ' a second look - duplicate, over budget, overdue or waiting too long, worst first'
        : plural(queue.length, 'bill') + ' awaiting review; none is a duplicate, over budget, overdue or waiting too long';
    var card = ui.card({
      title: 'Needs a closer look', className: 'ab-attcard',
      subtitle: subtitle,
      body: body,
      footer: h('div', { 'class': 'ab-cardfoot' },
        items.length ? h('span', { 'class': 'ab-cardfoot__more' }, more, ui.button({ label: 'Show the review queue', variant: 'text', size: 'sm', onClick: function () { showInTable(function (st) { st.tab = reviewTab(env); }); } })) : null,
        ui.sourceTag(['erp']))
    });
    return h('div', { 'class': 'ab-cell' }, card);
  }

  /* ------------------------------------------------------------------ bills card */

  function cell2(top, bottom, className) {
    return h('div', { 'class': ['ab-cell2', className] }, h('span', { 'class': 'ab-cell2__top' }, top), bottom ? h('span', { 'class': 'ab-cell2__sub' }, bottom) : null);
  }

  function dueCell(row, env) {
    var b = row.bill, info = dueInfo(b, env), sub = null;
    if (info.kind === 'overdue') sub = h('span', { 'class': 'ab-late' }, ui.icon('alert-triangle', 12), 'Overdue ' + plural(info.days, 'day'));
    else if (info.kind === 'soon') sub = h('span', { 'class': 'ab-soon' }, ui.icon('clock', 12), info.days === 0 ? 'Due today' : 'Due in ' + plural(info.days, 'day'));
    else if (info.kind === 'transit') sub = h('span', { title: 'The payment batch was released to the bank; the bank reference is awaited' }, 'With the bank');
    else if (info.kind === 'paid') {
      sub = h('span', { title: info.paidOn ? 'Paid on ' + day(info.paidOn) : null },
        info.late ? 'Paid ' + plural(info.late, 'day') + ' late' : (info.paidOn ? 'Paid ' + day(info.paidOn, 'd MMM') : 'Paid'));
    }
    return cell2(day(b.dueDate, 'd MMM yyyy'), sub);
  }

  function statusCell(row, env) {
    var wait = waitingDays(row.bill, env);
    return h('div', { 'class': 'ab-status' }, ui.statusChip(row.status),
      wait !== null ? h('span', { 'class': 'ab-cell2__sub' }, wait === 0 ? 'Submitted today' : 'Waiting ' + plural(wait, 'day')) : null);
  }

  function tableColumns(env) {
    return [
      { key: 'number', label: 'Bill', sortable: true, sortWords: ['oldest bill first', 'newest bill first'],
        render: function (v, r) { return cell2(h('span', { 'class': 'ab-mono' }, v), unitTag(env, r.bill.unitId)); } },
      { key: 'vendorName', label: 'Vendor / category', sortable: true, sortWords: ['vendor A to Z', 'vendor Z to A'],
        render: function (v, r) { return h('div', { 'class': 'ab-cell2 ab-clip', title: v + ' - ' + r.categoryLabel }, h('span', { 'class': 'ab-cell2__top ab-strong' }, v), h('span', { 'class': 'ab-cell2__sub' }, r.categoryLabel)); } },
      { key: 'invoiceDate', label: 'Vendor invoice', sortable: true, sortWords: ['oldest invoice first', 'newest invoice first'],
        render: function (v, r) { return h('div', { 'class': 'ab-cell2 ab-clip ab-clip--inv', title: r.invoiceNo }, h('span', { 'class': 'ab-cell2__top ab-mono' }, r.invoiceNo || '-'), h('span', { 'class': 'ab-cell2__sub' }, day(v, 'd MMM yyyy'))); } },
      { key: 'dueDate', label: 'Due', sortable: true, sortWords: ['due soonest first', 'due latest first'], render: function (v, r) { return dueCell(r, env); } },
      { key: 'payable', label: 'Payable', format: 'inrFull', sortable: true, sortWords: ['smallest first', 'largest first'], title: 'Amount plus GST, less TDS' },
      { key: 'status', label: 'Status', sortable: true, sortWords: ['earliest stage first', 'latest stage first'], sortValue: function (r) { return STATUS_ORDER.indexOf(r.status); }, render: function (v, r) { return statusCell(r, env); } },
      { key: 'flagText', label: 'Flags', sortable: true, sortWords: ['fewest flags first', 'most flags first'], sortValue: function (r) { return r.flagCodes.length || null; },
        render: function (v, r) { return r.flagCodes.length ? h('div', { 'class': 'ab-flags' }, r.flagCodes.map(function (c) { return flagChip(c, r.bill, env); })) : h('span', { 'class': 'mk-faint', 'aria-label': 'No flags' }, '-'); } }
    ];
  }

  function csvColumns() {
    return [
      { key: 'number', label: 'Bill' }, { key: 'vendorName', label: 'Vendor' }, { key: 'unitName', label: 'Unit' }, { key: 'categoryLabel', label: 'Category' },
      { key: 'invoiceNo', label: 'Vendor invoice no.' }, { key: 'invoiceDate', label: 'Invoice date' }, { key: 'dueDate', label: 'Due date' },
      { key: 'monthKey', label: 'Expense month' }, { key: 'amount', label: 'Amount' }, { key: 'gstAmount', label: 'GST' }, { key: 'tdsAmount', label: 'TDS' },
      { key: 'payable', label: 'Payable' }, { key: 'statusLabel', label: 'Status' }, { key: 'flagText', label: 'Flags' }
    ];
  }

  function sortRows(rows, sort, cols) {
    if (!sort || !sort.key) return rows;
    var col = cols.filter(function (c) { return c.key === sort.key; })[0];
    if (!col) return rows;
    var sign = sort.dir === 'asc' ? 1 : -1;
    return rows.map(function (r, i) { return { r: r, i: i, v: typeof col.sortValue === 'function' ? col.sortValue(r) : r[col.key] }; }).sort(function (x, y) {
      var xb = blank(x.v), yb = blank(y.v);
      if (xb || yb) return xb && yb ? x.i - y.i : (xb ? 1 : -1);
      var c = typeof x.v === 'number' && typeof y.v === 'number' ? x.v - y.v : String(x.v).localeCompare(String(y.v), 'en', { numeric: true, sensitivity: 'base' });
      return sign * c || x.i - y.i;
    }).map(function (x) { return x.r; });
  }

  function billsCard(env) {
    var st = env.st, W = MK.workflow, cols = tableColumns(env);
    var lastRows = [], lastAll = [];

    function query() {
      var f = {};
      if (st.unit !== ALL) f.unitId = st.unit;
      if (st.category !== ALL) f.categoryId = st.category;
      if (st.month) f.monthKey = st.month;
      if (st.search && st.search.trim()) f.search = st.search.trim();
      var rows = guard('bill.list', function () { return W.bill.list(f); }, []).map(function (b) { return toRow(b, env); });
      if (st.flagged) rows = rows.filter(function (r) { return r.flagCodes.length > 0; });
      return rows;
    }

    var subtitle = h('span', null);
    var tabsHost = h('div', { 'class': 'ab-toolbar__tabs' });
    var chipsHost = h('span', { 'class': 'ab-filterchips' });
    var pagerHost = h('div', { 'class': 'ab-pager' });
    var emptyHost = h('div');

    var table = ui.table({
      dense: true, sortable: false, columns: cols, rows: [], empty: emptyHost, className: 'ab-table',
      sort: st.sort || null, onSort: function (s) { st.sort = s; st.page = 0; paint(); },
      rowClass: function (r) { return r.id === st.openId ? 'is-selected' : ''; },
      onRowClick: function (r) { openBill(r.id); }
    });

    var search = ui.form.search({ value: st.search, placeholder: 'Search vendor, bill or invoice no.', width: 248, ariaLabel: 'Search bills by vendor, bill number or vendor invoice number',
      onInput: function (v) { st.search = v; st.page = 0; paint(); } });

    var unitSelect = env.allowedUnits.length > 1 ? ui.select({ ariaLabel: 'Unit', size: 'sm', value: st.unit,
      options: [{ value: ALL, label: 'All units' }].concat(env.look.unitOrder.filter(function (id) { return has(env.allowedUnits, id); }).map(function (id) { return { value: id, label: env.look.unitName(id) }; })),
      onChange: function (v) { st.unit = v || ALL; st.page = 0; paint(); } }) : null;

    var catIds = {};
    guard('bill.list cats', function () { return W.bill.list(); }, []).forEach(function (b) { catIds[b.categoryId] = true; });
    if (st.category !== ALL) catIds[st.category] = true;
    var catSelect = ui.select({ ariaLabel: 'Expense category', size: 'sm', value: st.category,
      options: [{ value: ALL, label: 'All categories' }].concat(Object.keys(catIds).map(function (id) { return { value: id, label: env.look.catLabel(id) }; })
        .sort(function (a, b) { return a.label.localeCompare(b.label); })),
      onChange: function (v) { st.category = v || ALL; st.page = 0; paint(); } });

    var flaggedBox = ui.form.checkbox({ label: 'Flagged only', checked: st.flagged, onChange: function (on) { st.flagged = on; st.page = 0; paint(); } });

    var csvBtn = ui.button({ label: 'CSV', icon: 'download', size: 'sm', title: 'Download the bills listed below', onClick: function () {
      ui.downloadCsv('bills-' + lower(st.tab === ALL ? 'all' : st.tab) + '-' + env.today + '.csv', csvColumns(), lastAll);
    } });
    var newBtn = ui.button({ label: 'New bill', icon: 'plus', variant: 'primary', size: 'sm', disabledReason: env.mayCreate.ok ? '' : env.mayCreate.reason,
      onClick: function () { openForm(null); } });

    function narrowed() { return !!(st.search && st.search.trim()) || st.unit !== ALL || st.category !== ALL || st.flagged || !!st.month; }

    function clearQuick() {
      st.search = ''; st.unit = ALL; st.category = ALL; st.flagged = false; st.month = null; st.page = 0;
      env.ctx.rerender();
    }

    function paintTabs(countBy, total) {
      var hadFocus = tabsHost.contains(doc.activeElement);
      var tabs = ui.tabs({ ariaLabel: 'Bill status', value: st.tab,
        items: [{ id: ALL, label: 'All', count: total }].concat(STATUS_ORDER.map(function (s) { return { id: s, label: stateLabel(s), count: countBy[s] || 0 }; })),
        onChange: function (id) { st.tab = id; st.page = 0; paint(); } });
      ui.clear(tabsHost).appendChild(tabs);
      if (hadFocus) { var on = tabs.querySelector('[aria-selected="true"]'); if (on) on.focus(); }
    }

    function paintChips() {
      ui.clear(chipsHost);
      if (st.month) chipsHost.appendChild(ui.button({ label: 'Expense month ' + monthName(st.month), iconRight: 'x', size: 'sm', title: 'Show every expense month again',
        onClick: function () { st.month = null; st.page = 0; paint(); } }));
      if (narrowed()) chipsHost.appendChild(ui.button({ label: 'Clear filters', variant: 'text', size: 'sm', onClick: clearQuick }));
    }

    function paintEmpty(total) {
      ui.clear(emptyHost);
      if (!env.counts.total) {
        emptyHost.appendChild(ui.emptyState('No bills in your scope yet', env.mayCreate.ok ? 'Raise the first one with New bill.' : 'Bills raised for your units will appear here.', { compact: true, icon: 'receipt' }));
        return;
      }
      if (!total && narrowed()) {
        var q = st.search && st.search.trim();
        emptyHost.appendChild(ui.emptyState(q ? 'No bill matches "' + q + '"' : 'No bill matches these filters',
          q ? 'The search looks at the vendor name, the bill number and the vendor invoice number.' : 'Nothing is left after the unit, category and flag filters of this list.',
          { compact: true, icon: q ? 'search' : 'filter', action: ui.button({ label: 'Clear the quick filters', size: 'sm', onClick: clearQuick }) }));
        return;
      }
      var label = st.tab === ALL ? '' : lower(stateLabel(st.tab));
      emptyHost.appendChild(ui.emptyState(st.tab === ALL ? 'No bills to show' : 'No bill is ' + label + ' right now',
        narrowed() ? 'Other tabs still hold bills for these filters.' : (st.tab === 'DRAFT' && env.mayCreate.ok ? 'Start one with New bill.' : 'Pick another tab to see the rest of the register.'),
        { compact: true, icon: 'receipt', action: st.tab !== ALL ? ui.button({ label: 'Show all bills', size: 'sm', onClick: function () { st.tab = ALL; st.page = 0; paint(); } }) : null }));
    }

    function paintPager(total, pages) {
      ui.clear(pagerHost);
      var first = total ? st.page * st.pageSize + 1 : 0, last = Math.min(total, (st.page + 1) * st.pageSize);
      pagerHost.appendChild(h('span', { 'class': 'ab-pager__count' }, total ? 'Showing ' + fmt.num(first) + ' - ' + fmt.num(last) + ' of ' + plural(total, 'bill') : 'No bills to show'));
      pagerHost.appendChild(h('span', { 'class': 'ab-pager__controls' },
        h('span', { 'class': 'mk-muted' }, 'Rows'),
        ui.select({ ariaLabel: 'Rows per page', size: 'sm', value: String(st.pageSize),
          options: PAGE_SIZES.map(function (n) { return { value: String(n), label: fmt.num(n) }; }),
          onChange: function (v) { st.pageSize = +v || PAGE_SIZES[0]; st.page = 0; paint(); } }),
        h('span', { 'class': 'ab-pager__page' }, 'Page ' + fmt.num(st.page + 1) + ' of ' + fmt.num(pages)),
        ui.button({ icon: 'chevron-left', size: 'sm', title: 'Previous page', ariaLabel: 'Previous page', disabled: st.page <= 0, onClick: function () { st.page -= 1; paint(); } }),
        ui.button({ icon: 'chevron-right', size: 'sm', title: 'Next page', ariaLabel: 'Next page', disabled: st.page >= pages - 1, onClick: function () { st.page += 1; paint(); } })));
    }

    function paint() {
      var all = query(), countBy = {};
      all.forEach(function (r) { countBy[r.status] = (countBy[r.status] || 0) + 1; });
      var rows = st.tab === ALL ? all : all.filter(function (r) { return r.status === st.tab; });
      rows = sortRows(rows, st.sort, cols);
      var pages = Math.max(1, Math.ceil(rows.length / st.pageSize));
      if (st.page > pages - 1) st.page = pages - 1;
      lastAll = rows;
      lastRows = rows.slice(st.page * st.pageSize, (st.page + 1) * st.pageSize);

      paintTabs(countBy, all.length); paintChips(); paintEmpty(all.length);
      table.setRows(lastRows);
      paintPager(rows.length, pages);

      var value = rows.reduce(function (t, r) { return t + (r.payable || 0); }, 0);
      var sortCol = st.sort && st.sort.key ? cols.filter(function (c) { return c.key === st.sort.key; })[0] : null;
      var order = sortCol && sortCol.sortWords ? sortCol.sortWords[st.sort.dir === 'asc' ? 0 : 1] : 'newest first';
      subtitle.textContent = plural(rows.length, 'bill') + ', ' + fmt.inr(value) + ' payable' + (st.tab === ALL ? '' : ' - ' + lower(stateLabel(st.tab))) +
        ' - ' + order;
      csvBtn.disabled = !rows.length;
    }

    function markSelected() {
      if (!doc.contains(table)) return;
      var trs = table.querySelectorAll('tbody tr');
      var shown = table.getSort() ? sortRows(lastRows, table.getSort(), cols) : lastRows;
      shown.forEach(function (r, i) { if (trs[i]) trs[i].classList.toggle('is-selected', r.id === st.openId); });
    }

    var card = ui.card({
      title: 'Bill register', subtitle: subtitle, flush: true, className: 'ab-register',
      actions: [csvBtn, newBtn],
      body: [
        h('div', { 'class': 'ab-toolbar' }, tabsHost),
        h('div', { 'class': 'ab-filters' }, search, unitSelect, catSelect, flaggedBox, chipsHost,
          !env.mayCreate.ok ? h('span', { 'class': 'ab-filters__why' }, ui.icon('lock', 12), 'New bill: ' + lowerFirst(env.mayCreate.reason)) : null),
        table, pagerHost
      ],
      footer: ui.sourceTag(['erp'])
    });
    live.card = card; live.repaint = paint; live.markSelected = markSelected;
    paint();
    return card;
  }

  /* ================================================================== review drawer */

  function section(title, extra, children) {
    return h('section', { 'class': 'ab-sec' },
      h('div', { 'class': 'ab-sec__head' }, h('h3', { 'class': 'mk-h3 ab-sec__title' }, title), extra || null),
      children);
  }

  function ledgerRow(label, value, o) {
    o = o || {};
    return h('tr', { 'class': ['ab-ledger__row', o.total ? 'ab-ledger__row--total' : ''] },
      h('th', { scope: 'row' }, h('span', { 'class': 'ab-ledger__label' }, label), o.sub ? h('span', { 'class': 'ab-ledger__sub' }, o.sub) : null),
      h('td', null, value));
  }

  function amountsBlock(bill, env) {
    var parts = guard('bill.expenseParts', function () { return MK.workflow.bill.expenseParts(bill); }, []);
    var books = parts.map(function (p) { return env.look.catLabel(p.categoryId) + ' ' + fmt.inrFull(p.amount); }).join(' + ');
    return h('table', { 'class': 'ab-ledger' }, h('tbody', null,
      ledgerRow('Bill amount', fmt.inrFull(bill.amount), { sub: 'Taxable value, before GST' }),
      ledgerRow('GST charged', fmt.inrFull(bill.gstAmount || 0), { sub: 'No input credit: it is part of the cost' }),
      (bill.tdsAmount || bill.tdsLabel) ? ledgerRow(bill.tdsLabel || 'TDS', fmt.inrFull(-(bill.tdsAmount || 0)), { sub: 'Withheld and deposited with the tax department' }) : null,
      ledgerRow('Payable to the vendor', fmt.inrFull(bill.payable), { total: true, sub: books ? 'Cost booked: ' + books : null })));
  }

  function person(id, at) {
    if (!id && !at) return null;
    return h('span', null, userName(id), at ? h('span', { 'class': 'ab-muted' }, ', ' + ui.dateTime(at)) : null);
  }

  function detailsBlock(bill, env) {
    var due = dueInfo(bill, env), dueNode = h('span', { 'class': 'ab-inline' }, day(bill.dueDate));
    if (due.kind === 'overdue') dueNode.appendChild(ui.chip('Overdue ' + plural(due.days, 'day'), 'critical', { icon: 'alert-triangle' }));
    else if (due.kind === 'soon') dueNode.appendChild(ui.chip(due.days === 0 ? 'Due today' : 'Due in ' + plural(due.days, 'day'), 'warn', { icon: 'clock' }));
    else if (due.kind === 'transit') dueNode.appendChild(ui.chip('Released to the bank', 'info'));
    else if (due.kind === 'paid' && due.late) dueNode.appendChild(ui.chip('Paid ' + plural(due.late, 'day') + ' late', 'neutral'));
    var files = (bill.attachments || []).filter(function (a) { return a && a.name; });
    var paymentsOk = guard('router.isAllowed', function () { return MK.router.isAllowed('approvals-payments'); }, false);
    return [
      ui.keyValue([
        ['Vendor invoice no.', h('span', { 'class': 'ab-mono' }, bill.invoiceNo || '-')],
        ['Invoice date', day(bill.invoiceDate)],
        ['Due date', dueNode],
        ['Expense month', monthName(bill.monthKey)],
        ['Unit', unitTag(env, bill.unitId)],
        ['Category', env.look.catLabel(bill.categoryId)],
        ['Raised by', person(bill.createdBy, bill.createdAt)],
        ['Submitted by', person(bill.submittedBy, bill.submittedAt)],
        ['Review started', person(bill.reviewedBy, bill.reviewedAt)],
        [bill.status === 'REJECTED' ? 'Rejected by' : 'Decided by', person(bill.decidedBy, bill.decidedAt)],
        ['Payment batch', bill.batchId ? (paymentsOk ? ui.link(bill.batchId, MK.router.href('approvals-payments', { id: bill.batchId })) : bill.batchId) : null],
        ['Paid on', bill.paidOn ? day(bill.paidOn) : null],
        ['Bank reference (UTR)', bill.utr ? h('span', { 'class': 'ab-mono' }, bill.utr) : null],
        ['Attachment', files.length ? h('span', { 'class': 'ab-files' }, files.map(function (a) { return h('span', { 'class': 'ab-file' }, ui.icon('paperclip', 12), a.name); })) : h('span', { 'class': 'ab-muted' }, 'None attached')]
      ], { cols: 2 }),
      bill.description ? h('div', { 'class': 'ab-text' }, h('div', { 'class': 'mk-label' }, 'Description'), h('p', null, bill.description)) : null,
      bill.notes ? h('div', { 'class': 'ab-text' }, h('div', { 'class': 'mk-label' }, 'Note from the maker'), h('p', null, bill.notes)) : null
    ];
  }

  function impactSentence(bill, impact, env) {
    var line = lowerFirst(env.look.catLabel(impact.categoryId)) + ' at ' + env.look.unitName(impact.unitId);
    var plan = 'the ' + monthName(impact.monthKey) + ' plan of ' + fmt.inr(impact.budget);
    var tail = impact.remainingAfter < 0 ? fmt.inr(-impact.remainingAfter) + ' over plan' : fmt.inr(impact.remainingAfter) + ' still available';
    var share = impact.utilisationAfter === null ? '' : ' - ' + fmt.pct(impact.utilisationAfter, 0) + ' of ' + plan;
    var text;
    if (impact.alreadyCommitted) {
      text = 'This bill (' + fmt.inrFull(impact.amount) + ' with GST) is already counted as committed. ' + env.look.catLabel(impact.categoryId) + ' at ' + env.look.unitName(impact.unitId) +
        ' stands at ' + fmt.inr(impact.afterThis) + share + ', ' + tail + '.';
    } else {
      var lead = bill.status === 'DRAFT' || bill.status === 'REJECTED' || !bill.status ? 'Once approved, this bill adds ' : 'Approving this bill adds ';
      text = lead + fmt.inrFull(impact.amount) + ' (amount plus GST) and takes ' + line + ' to ' + fmt.inr(impact.afterThis) + share + ', ' + tail + '.';
    }
    if (impact.pipeline) text += ' ' + fmt.inr(impact.pipeline) + ' sits in the approval pipeline for this line' + (has(pipelineStates(), bill.status) ? ', this bill included.' : '.');
    return text;
  }

  function budgetBlock(bill, env, compact) {
    var impact = guard('bill.budgetImpact', function () { return MK.workflow.bill.budgetImpact(bill); }, null);
    if (!impact || !impact.available) {
      return h('p', { 'class': 'ab-quiet' }, ui.icon('info', 14),
        impact && impact.categoryId && impact.monthKey ? 'No budget line exists for ' + lowerFirst(env.look.catLabel(impact.categoryId)) + ' at ' + env.look.unitName(impact.unitId) + ' in ' + monthName(impact.monthKey) + '.'
          : 'The budget impact appears once the unit, the category and the invoice date are known.');
    }
    var tone = impact.status === 'OVER' ? 'critical' : (impact.status === 'NEAR' ? 'warn' : 'good');
    var sentence = impactSentence(bill, impact, env);
    return h('div', { 'class': 'ab-budget' },
      ui.meter({ label: env.look.catLabel(impact.categoryId) + ' - ' + env.look.unitName(impact.unitId) + ', ' + monthName(impact.monthKey),
        value: impact.afterThis, max: impact.budget || 1, tone: tone,
        valueLabel: (impact.utilisationAfter === null ? '-' : fmt.pct(impact.utilisationAfter, 0)) + ' of ' + fmt.inr(impact.budget) }),
      compact ? null : ui.keyValue([
        ['Plan', fmt.inrFull(impact.budget)], ['Committed', fmt.inrFull(impact.committed)], ['In pipeline', fmt.inrFull(impact.pipeline)],
        [impact.alreadyCommitted ? 'Line stands at' : 'After this bill', h('strong', null, fmt.inrFull(impact.afterThis))]
      ], { stacked: true }),
      impact.status === 'WITHIN' ? h('p', { 'class': 'ab-budget__text' }, sentence)
        : ui.callout(impact.status === 'OVER' ? 'serious' : 'warn', impact.status === 'OVER' ? 'This bill belongs to a line over plan' : 'This line is close to its plan', sentence),
      aheadNote(bill, impact, env));
  }

  /* where the line is heading by month-end (forecast, Layer 3): a sales-driven line follows the sales forecast, a fixed
     line its run-rate; only the month in progress gets a projection, a complete month needs none */
  function aheadNote(bill, impact, env) {
    if (!MK.forecast || typeof MK.forecast.lineProjection !== 'function') return null;
    var p = guard('forecast.lineProjection', function () { return MK.forecast.lineProjection(impact.unitId, impact.categoryId, impact.monthKey, impact.alreadyCommitted ? 0 : impact.amount); }, null);
    if (!p || !p.available) return null;
    var line = lowerFirst(env.look.catLabel(impact.categoryId)) + ' at ' + env.look.unitName(impact.unitId);
    var how = p.method === 'sales' ? 'On the sales forecast (' + MK.forecast.reactivenessLabel(p.settings.weeks).toLowerCase() + ', the last ' + p.settings.weeks + ' weeks) the cost accrued so far'
      : (p.method === 'plan-rest' ? 'The cost accrued so far plus the plan for the ' + plural(p.daysLeft, 'day') + ' left' : 'With nothing accrued yet, the plan');
    var text = how + ' puts ' + line + ' at ' + fmt.inr(p.projected) + ' by ' + day(p.monthEnd) + ' - ' + fmt.pct(p.utilisation, 0) + ' of plan' +
      (p.status === 'OVER' ? ', ' + fmt.inr(p.overBy) + ' over' : '') + '. Bills so far ' + (p.basis === 'ledger' ? 'and accruals ' : '') + 'cover ' + fmt.pct(p.usedPct, 0) + ' of the plan; this bill is ' + fmt.pct(p.billShare, 0) + ' of it.';
    if (p.status === 'WITHIN') return h('p', { 'class': 'ab-budget__text ab-budget__ahead' }, ui.icon('chart', 14), h('span', null, text));
    return ui.callout(p.status === 'OVER' ? 'serious' : 'warn', p.status === 'OVER' ? 'Heading over plan by month-end' : 'Heading close to plan by month-end', text, { icon: 'chart' });
  }
  function aheadAvailable(bill) {
    if (!bill || !MK.forecast || typeof MK.forecast.lineProjection !== 'function') return false;
    var p = guard('forecast.lineProjection', function () { return MK.forecast.lineProjection(bill.unitId, bill.categoryId, bill.monthKey, 0); }, null);
    return !!(p && p.available);
  }

  function budgetChip(bill) {
    var impact = guard('bill.budgetImpact', function () { return MK.workflow.bill.budgetImpact(bill); }, null);
    return impact && impact.available && impact.status ? ui.statusChip(impact.status) : null;
  }

  function duplicateBlock(check, env, onOpen) {
    if (!check || !check.matches || !check.matches.length) {
      return h('p', { 'class': 'ab-quiet ab-quiet--ok' }, ui.icon('check-circle', 14),
        'No other bill of this vendor carries the same invoice number, and none has the same amount close to this invoice date.');
    }
    var list = h('ul', { 'class': 'ab-dups' }, check.matches.map(function (m) {
      if (!m.inScope) {
        return h('li', { 'class': 'ab-dup' }, h('div', { 'class': 'ab-dup__top' }, h('span', { 'class': 'ab-mono' }, m.number), h('span', { 'class': 'ab-muted' }, env.look.unitName(m.unitId) + ' - outside your units')),
          h('div', { 'class': 'ab-dup__meta' }, m.label));
      }
      return h('li', { 'class': 'ab-dup' },
        h('div', { 'class': 'ab-dup__top' },
          typeof onOpen === 'function' ? h('button', { type: 'button', 'class': 'mk-link ab-linkbtn ab-mono', title: 'Open ' + m.number, onClick: function () { onOpen(m.billId); } }, m.number) : h('span', { 'class': 'ab-mono' }, m.number),
          ui.statusChip(m.status), h('span', { 'class': 'ab-dup__amt' }, fmt.inrFull(m.payable))),
        h('div', { 'class': 'ab-dup__meta' }, m.label + ' - invoice ' + (m.invoiceNo || '-') + ' of ' + day(m.invoiceDate) + ', ' + env.look.unitName(m.unitId) + ', bill amount ' + fmt.inrFull(m.amount)));
    }));
    var needsNote = check.hasExact && MK.workflow.errors && MK.workflow.errors.duplicateNeedsNote;
    return ui.callout(check.hasExact ? 'critical' : 'warn', check.hasExact ? 'Duplicate invoice suspected' : 'Possible duplicate',
      [h('p', { 'class': 'ab-callout__lead' }, plural(check.matches.length, 'other bill matches', 'other bills match') + ' this one. Paying both would pay the vendor twice.'), list,
        needsNote ? h('p', { 'class': 'ab-callout__foot' }, needsNote + '.') : null]);
  }

  function vendorBlock(bill, env) {
    var v = guard('vendor.get', function () { return MK.workflow.vendor.get(bill.vendorId); }, null);
    if (!v) return h('p', { 'class': 'ab-quiet' }, ui.icon('info', 14), env.look.vendorName(bill.vendorId) + ' - the vendor record is outside your scope.');
    var spend = guard('finance.vendorSpend', function () { return MK.finance && MK.finance.vendorSpend ? MK.finance.vendorSpend(v.id) : null; }, null);
    var vendorsOk = guard('router.isAllowed', function () { return MK.router.isAllowed('vendors'); }, false);
    var spendNode = null;
    if (spend && spend.months && spend.months.length && spend.total) {
      var spark = h('span', { 'class': 'ab-vspend__spark' });
      if (MK.charts && typeof MK.charts.sparkline === 'function') guard('sparkline', function () { MK.charts.sparkline(spark, spend.values, { colourVar: '--series-1', emphasiseLast: true }); return true; }, false);
      var lastKey = spend.months[spend.months.length - 1], lastVal = spend.values[spend.values.length - 1];
      spendNode = h('div', { 'class': 'ab-vspend' },
        h('div', { 'class': 'ab-vspend__text' },
          h('div', { 'class': 'mk-label' }, 'Spend booked' + (MK.session.seesAllUnits() ? '' : ' at your units') + ', ' + D.monthLabel(spend.months[0]) + ' - ' + monthName(lastKey)),
          h('div', { 'class': 'ab-vspend__num' }, fmt.inr(spend.total),
            h('span', { 'class': 'ab-muted' }, (spend.averagePerMonth ? ' - ' + fmt.inr(spend.averagePerMonth) + ' an average full month' : '') + ', ' + fmt.inr(lastVal) + ' so far in ' + D.monthLabel(lastKey)))),
        spark);
    }
    return h('div', { 'class': 'ab-vendor' },
      h('div', { 'class': 'ab-vendor__head' },
        h('div', { 'class': 'ab-vendor__name' }, h('strong', null, v.name), h('span', { 'class': 'ab-muted' }, [v.category, v.type === 'utility' ? 'Utility biller' : null].filter(Boolean).join(' - '))),
        ui.statusChip(v.state)),
      v.state !== 'APPROVED' ? ui.callout('warn', 'Vendor is not approved for billing',
        'Currently ' + lower(stateLabel(v.state)) + '. A bill of this vendor cannot be submitted, approved or paid until the checker approves the vendor again.') : null,
      ui.keyValue([
        ['Credit terms', plural(v.creditDays || 0, 'day')],
        ['TDS type', v.tdsLabel || 'None on the vendor master'],
        ['GSTIN', v.gstin ? h('span', { 'class': 'ab-mono' }, v.gstin) : h('span', { 'class': 'ab-muted' }, 'Unregistered')],
        ['Bank account', v.bankName ? h('span', null, v.bankName + ' ', h('span', { 'class': 'ab-mono' }, v.bankAccountMasked || '')) : null],
        ['Bank name match', typeof v.nameMatch === 'number' ? h('span', { 'class': 'ab-inline' }, fmt.pct(v.nameMatch / 100, 0), ui.chip('Simulated', 'neutral', { outline: true, icon: 'info', title: MK.workflow.SIMULATED_NOTE || 'Simulated in this mockup' })) : null]
      ], { cols: 2 }),
      typeof v.nameMatch === 'number' ? h('p', { 'class': 'ab-quiet ab-small' }, ui.icon('info', 12),
        'The penny-drop name match against the bank record is ' + lower(MK.workflow.SIMULATED_NOTE || 'simulated in this mockup') + '; no live bank or registry call is made.') : null,
      spendNode,
      vendorsOk ? h('div', null, ui.link('Open the vendor profile', MK.router.href('vendors', { id: v.id }), { icon: 'arrow-right' })) : null);
  }

  function changeText(c) {
    function show(v, field) {
      if (blank(v)) return 'blank';
      if (MONEY_FIELDS[field] && typeof v === 'number') return fmt.inrFull(v);
      if (DATE_FIELDS[field]) return day(v);
      if (field === 'monthKey') return monthName(v);
      if (Array.isArray(v)) return v.length ? v.map(function (x) { return x && x.name ? x.name : (x && x.categoryId ? x.categoryId : String(x)); }).join(', ') : 'none';
      if (typeof v === 'object') return 'changed';
      return String(v);
    }
    return (FIELD_LABELS[c.field] || c.field) + ': ' + show(c.before, c.field) + ' -> ' + show(c.after, c.field);
  }

  function timelineBlock(bill) {
    var events = guard('audit.trail', function () { return typeof MK.audit.trail === 'function' ? MK.audit.trail('bill', bill.id) : null; }, null);
    if (!events) events = guard('audit.list', function () { return MK.audit.list({ entity: 'bill', entityId: bill.id, order: 'asc' }); }, []);
    var items = [];
    events.forEach(function (e) {
      var t = guard('audit.toTimeline', function () { return MK.audit.toTimeline([e])[0]; }, null);
      if (!t) return;
      if (e.changes && e.changes.length) t = Object.assign({}, t, { note: e.changes.filter(function (c) { return c && c.field; }).map(changeText).join('; ') });
      items.push(t);
    });
    items.reverse();
    return ui.timeline(items, { empty: 'No activity recorded for this bill yet' });
  }

  /* ---- decision dialogs */

  function decisionDialog(kind, bill, env, done) {
    var approve = kind === 'approve';
    var flagged = has(bill.flags, 'DUPLICATE_INVOICE');
    var mustWrite = !approve || flagged;
    var text = ui.form.textarea({ rows: 3, maxLength: 500, name: 'decisionNote',
      placeholder: approve ? (flagged ? 'Why this is not a double payment' : 'Anything the payer or an auditor should know') : 'What the maker must correct before resubmitting' });
    text.setAttribute('data-autofocus', '');
    var field = ui.form.field({ label: approve ? 'Approval note' : 'Reason for rejection', control: text, required: mustWrite, optional: !mustWrite,
      hint: approve ? (flagged ? 'Required here: say why paying this invoice is not a double payment. The note stays on the audit trail.' : 'Recorded on the audit trail with your name and the time.')
        : 'The maker sees this reason and gets the bill back for correction.' });
    var impact = env.impacts[bill.id] || guard('bill.budgetImpact', function () { return MK.workflow.bill.budgetImpact(bill); }, null);
    var summary = h('div', { 'class': PAGE_CLASS + ' ab-decide' },
      ui.keyValue([
        ['Vendor', env.look.vendorName(bill.vendorId)],
        ['Unit and category', env.look.unitName(bill.unitId) + ' - ' + env.look.catLabel(bill.categoryId)],
        ['Payable', h('strong', null, fmt.inrFull(bill.payable))],
        ['Budget line', impact && impact.available ? h('span', { 'class': 'ab-inline' }, ui.statusChip(impact.status), fmt.pct(impact.utilisationAfter, 0) + ' of plan ' + (impact.alreadyCommitted ? 'now' : 'after this bill')) : null]
      ]),
      approve && flagged ? ui.callout('critical', 'Duplicate invoice suspected', flagLabel('DUPLICATE_INVOICE') + '.') : null,
      field,
      ui.sourceTag(['erp']));
    var m = null;
    var confirm = ui.button({ label: approve ? 'Approve bill' : 'Reject bill', variant: approve ? 'primary' : 'danger', icon: approve ? 'check' : 'x', onClick: function () {
      var note = text.value.trim();
      var res = guard('bill.' + kind, function () { return approve ? MK.workflow.bill.approve(bill.id, note) : MK.workflow.bill.reject(bill.id, note); }, { ok: false, error: 'The action could not be completed' });
      if (!res.ok) { field.setError(res.error); text.focus(); return; }
      m.close();
      done(res);
    } });
    m = ui.modal({
      title: (approve ? 'Approve ' : 'Reject ') + bill.number + '?',
      subtitle: approve ? 'The bill becomes payable and moves to the payer for a payment batch.' : 'The bill goes back to ' + userName(bill.createdBy) + ' with your reason.',
      body: summary,
      footer: [ui.button({ label: 'Cancel', variant: 'ghost', onClick: function () { m.close(); } }), confirm]
    });
  }

  /* ---- the drawer */

  function openBill(id, o) {
    o = o || {};
    if (live.form) return;
    if (live.drawer) { live.drawer.show(id); return; }
    var st = live.st;
    var state = { id: id, error: null, linked: o.linked || null };
    var chipHost = h('span', { 'class': PAGE_CLASS + ' ab-headchip' });
    var bodyHost = h('div', { 'class': PAGE_CLASS + ' ab-drawer' });
    var footHost = h('div', { 'class': PAGE_CLASS + ' ab-actions' });
    var closedByEdit = false;

    var d = ui.drawer({
      title: id, subtitle: ' ', headerExtra: chipHost, width: 560, body: bodyHost, footer: footHost, loaderLabel: 'Fetching the bill',
      onClose: function () {
        live.drawer = null;
        if (closedByEdit) return;
        if (live.st) live.st.openId = null;
        if (live.markSelected) live.markSelected();
        if (state.linked) {
          var cur = MK.router.current();
          if (live.st) live.st.linked = null;
          if (cur && cur.page.id === PAGE_ID && cur.params.id === state.linked && live.ctx) live.ctx.navigate(PAGE_ID, null, { replace: true });
        }
      }
    });

    function run(name, fn, okText) {
      var res = guard(name, fn, { ok: false, error: 'The action could not be completed' });
      if (res.ok) { state.error = null; ui.toast(okText(res.record), { tone: 'good' }); }
      else state.error = res.error;
      refresh();
      if (d.el && d.el.focus) d.el.focus();
    }

    function actionBar(bill, env) {
      var W = MK.workflow, user = MK.session.current();
      var buttons = [], blocked = [];
      function add(action, label, opts, onClick) {
        var may = guard('bill.can', function () { return W.bill.can(action, bill); }, { ok: false, reason: 'Not available' });
        if (!may.ok) blocked.push({ label: label, reason: may.reason });
        buttons.push(ui.button(Object.assign({ label: label, disabledReason: may.ok ? '' : (may.reason || 'Not available'), onClick: onClick }, opts || {})));
      }
      var decided = function (verb, tone) { return function (res) { state.error = null; ui.toast(res.record.number + ' ' + verb, { tone: tone }); refresh(); if (d.el && d.el.focus) d.el.focus(); }; };

      if (bill.status === 'DRAFT' || bill.status === 'REJECTED') {
        if (bill.status === 'REJECTED') add('reopen', 'Reopen as draft', { icon: 'refresh' }, function () { run('bill.reopen', function () { return W.bill.reopen(bill.id); }, function (r) { return r.number + ' reopened as a draft'; }); });
        add('update', bill.status === 'REJECTED' ? 'Edit and correct' : 'Edit', { icon: 'edit' }, function () {
          closedByEdit = true; d.close();
          openForm(bill, { reopenOnClose: true, linked: state.linked });
        });
        if (bill.status === 'DRAFT') add('submit', 'Submit for approval', { variant: 'primary', icon: 'arrow-right' }, function () { run('bill.submit', function () { return W.bill.submit(bill.id); }, function (r) { return r.number + ' submitted to the finance checker'; }); });
      } else if (bill.status === 'SUBMITTED' || bill.status === 'UNDER_REVIEW') {
        if (bill.status === 'SUBMITTED') add('startReview', 'Start review', { icon: 'eye' }, function () { run('bill.startReview', function () { return W.bill.startReview(bill.id); }, function (r) { return r.number + ' taken up for review'; }); });
        add('reject', 'Reject', { variant: 'danger', icon: 'x' }, function () { decisionDialog('reject', bill, live.env || env, decided('rejected and sent back to the maker', 'warn')); });
        add('approve', 'Approve', { variant: 'primary', icon: 'check' }, function () { decisionDialog('approve', bill, live.env || env, decided('approved - ready for a payment batch', 'good')); });
      }

      var why = [];
      var seen = {};
      blocked.forEach(function (b) { (seen[b.reason] = seen[b.reason] || []).push(b.label); });
      Object.keys(seen).forEach(function (reason) { why.push(seen[reason].join(', ') + ': ' + lowerFirst(reason) + '.'); });
      var mine = user.id === bill.createdBy || user.id === bill.submittedBy;
      if (blocked.length && has(pipelineStates(), bill.status)) {
        var split = mine
          ? 'You raised this bill, so under maker-checker its decision sits with someone else.'
          : 'Tier one is decided by the finance checker, never by the person who raised the bill.';
        if (MK.session.can('batch.release').ok) split += ' Your turn comes at tier two, when the payment batch is released.';
        else if (MK.session.can('batch.create').ok) split += ' Your turn comes once it is approved, when it goes into a payment batch.';
        why.push(split);
      } else if (blocked.length && (bill.status === 'DRAFT' || bill.status === 'REJECTED')) {
        why.push('A draft is changed and submitted by ' + userName(bill.createdBy) + ', who raised it, or by the finance maker.');
      }

      var next = null;
      if (bill.status === 'APPROVED') next = 'Approved by ' + userName(bill.decidedBy) + '. Next: the payer adds it to a payment batch and the director releases the payment.';
      else if (bill.status === 'IN_BATCH') next = 'In payment batch ' + (bill.batchId || '') + (isReleased(bill, live.env || env) ? ', released to the bank - waiting for the bank reference.' : ' - waiting for the director to release it.');
      else if (bill.status === 'PAID') next = 'Paid' + (bill.paidOn ? ' on ' + day(bill.paidOn) : '') + (bill.utr ? ', bank reference ' + bill.utr : '') + '. Nothing more to do on this bill.';

      return [
        h('div', { 'class': 'ab-actions__row' },
          next ? h('span', { 'class': 'ab-actions__next' }, ui.icon(bill.status === 'PAID' ? 'check-circle' : 'info', 14), next) : null,
          buttons.length ? h('span', { 'class': 'ab-actions__buttons' }, buttons) : null),
        why.length ? h('div', { 'class': 'ab-actions__why' }, ui.icon('lock', 12), h('span', null, why.join(' '))) : null
      ];
    }

    function refresh() {
      var env = live.env || buildEnv(live.ctx);
      var keep = d.body ? d.body.scrollTop : 0;
      var bill = guard('bill.get', function () { return MK.workflow.bill.get(state.id); }, null);
      ui.clear(chipHost); ui.clear(bodyHost); ui.clear(footHost);
      if (!bill) {
        d.setTitle(state.id, 'Not available');
        bodyHost.appendChild(ui.emptyState('This bill is outside your scope', 'It belongs to a unit ' + MK.session.current().name + ' is not assigned to, or it no longer exists.', { icon: 'lock' }));
        footHost.appendChild(h('div', { 'class': 'ab-actions__row' }, h('span', { 'class': 'ab-actions__buttons' }, ui.button({ label: 'Close', onClick: function () { d.close(); } }))));
        return;
      }
      d.setTitle(bill.number + ' - ' + env.look.vendorName(bill.vendorId),
        env.look.unitName(bill.unitId) + ' - ' + env.look.catLabel(bill.categoryId) + ' - expense month ' + monthName(bill.monthKey));
      chipHost.appendChild(ui.statusChip(bill.status));

      var check = guard('bill.duplicateCheck', function () { return MK.workflow.bill.duplicateCheck(bill); }, null);
      ui.append(bodyHost,
        state.error ? ui.callout('critical', 'The action was refused', state.error) : null,
        bill.status === 'REJECTED' && bill.rejectionReason ? ui.callout('critical', 'Rejected by ' + userName(bill.decidedBy) + (bill.decidedAt ? ' on ' + ui.dateTime(bill.decidedAt) : ''), bill.rejectionReason) : null,
        section('Amounts', null, amountsBlock(bill, env)),
        section('Bill details', null, detailsBlock(bill, env)),
        section('Budget impact', budgetChip(bill), budgetBlock(bill, env)),
        section('Duplicate check', check && check.matches && check.matches.length ? ui.chip(plural(check.matches.length, 'match', 'matches'), check.hasExact ? 'critical' : 'warn') : null,
          duplicateBlock(check, env, function (otherId) { if (live.drawer) live.drawer.show(otherId); })),
        section('Vendor', null, vendorBlock(bill, env)),
        section('Timeline', h('span', { 'class': 'ab-muted ab-small' }, 'Newest first'), timelineBlock(bill)),
        ui.sourceTag(aheadAvailable(bill) ? ['erp', 'forecast'] : ['erp']));
      ui.append(footHost, actionBar(bill, env));
      if (d.body) d.body.scrollTop = keep;
    }

    live.drawer = {
      id: function () { return state.id; },
      show: function (nextId) {
        state.id = nextId; state.error = null; if (live.st) live.st.openId = nextId; refresh(); if (d.body) d.body.scrollTop = 0; if (live.markSelected) live.markSelected();
        if (MK.latency && d.body) MK.latency.part(d.body, 'record', 'Fetching the bill', 'navigate');
      },
      refresh: refresh,
      close: function () { d.close(); }
    };
    if (st) st.openId = id;
    refresh();
    if (live.markSelected) live.markSelected();
  }

  /* ================================================================== new / edit bill form */

  function monthOptions() {
    var out = [], key = MK.calendar.dataStart.slice(0, 7), end = MK.calendar.today.slice(0, 7), guardN = 0;
    while (key <= end && guardN < 24) {
      out.push({ value: key, label: monthName(key) });
      var y = +key.slice(0, 4), m = +key.slice(5, 7) + 1;
      if (m > 12) { m = 1; y += 1; }
      key = y + '-' + (m < 10 ? '0' : '') + m;
      guardN += 1;
    }
    return out.reverse();
  }

  function openForm(existing, o) {
    o = o || {};
    if (live.form) return;
    var W = MK.workflow, env = live.env || buildEnv(live.ctx), today = MK.calendar.today;
    var st = live.st || {};
    var units = env.look.unitOrder.filter(function (id) { return has(env.allowedUnits, id) && guard('bill.can create', function () { return W.bill.can('create', { unitId: id }).ok; }, false); });
    var fs = existing ? {
      id: existing.id, status: existing.status, unitId: existing.unitId, vendorId: existing.vendorId, categoryId: existing.categoryId, invoiceNo: existing.invoiceNo || '',
      invoiceDate: existing.invoiceDate || '', dueDate: existing.dueDate || '', monthKey: existing.monthKey && existing.monthKey !== (existing.invoiceDate || '').slice(0, 7) ? existing.monthKey : '',
      description: existing.description || '', amount: existing.amount, gstAmount: existing.gstAmount || 0, tdsLabel: existing.tdsLabel || '', tdsAmount: existing.tdsAmount || 0,
      attachments: (existing.attachments || []).map(function (a) { return { name: a.name }; }), notes: existing.notes || '', dueTouched: true, tdsTouched: true, dueFromRecord: true
    } : {
      id: null, status: null, unitId: units.length === 1 ? units[0] : (st.unit && st.unit !== ALL && has(units, st.unit) ? st.unit : ''), vendorId: '', categoryId: '', invoiceNo: '',
      invoiceDate: today, dueDate: '', monthKey: '', description: '', amount: null, gstAmount: null, tdsLabel: '', tdsAmount: null, attachments: [], notes: '', dueTouched: false, tdsTouched: false, dueFromRecord: false
    };
    if (existing && !has(units, fs.unitId)) units.push(fs.unitId);
    var errors = {}, topError = null, saved = false, savedId = existing ? existing.id : null;
    var fields = {}, controls = {};
    var bodyHost = h('div', { 'class': PAGE_CLASS + ' ab-form' });
    var footHost = h('div', { 'class': PAGE_CLASS + ' ab-actions' });
    var topHost = h('div', { 'class': 'ab-form__top' }), dupHost = h('div'), budgetHost = h('div'), payableHost = h('div', { 'class': 'ab-payable' }),
      filesHost = h('div', { 'class': 'ab-files ab-files--edit' }), vendorHint = h('div', { 'class': 'mk-field__hint' }), tdsHint = h('div', { 'class': 'mk-field__hint' }), dueHint = h('div', { 'class': 'mk-field__hint' });

    var d = ui.drawer({
      title: existing ? 'Edit ' + existing.number : 'New bill', width: 560, loader: false,
      subtitle: existing ? (existing.status === 'REJECTED' ? 'Saving a rejected bill reopens it as a draft' : 'Draft - not yet with the finance checker') : 'Saved as a draft first; submitting sends it to the finance checker',
      body: bodyHost, footer: footHost,
      onClose: function () {
        live.form = null;
        /* the deep-linked id travels with the record so closing the review drawer still clears it from the hash */
        if (savedId && (saved || o.reopenOnClose)) openBill(savedId, { linked: o.linked });
      }
    });
    live.form = { close: function () { d.close(); } };

    function vendorOf(id) { return id ? guard('vendor.get', function () { return W.vendor.get(id); }, null) : null; }

    function vendorOptions() {
      if (!fs.unitId) return [];
      var list = guard('vendor.list', function () { return W.vendor.list({ unitId: fs.unitId }); }, []);
      var okList = list.filter(function (v) { return v.state === 'APPROVED'; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      var rest = list.filter(function (v) { return v.state !== 'APPROVED'; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      return okList.map(function (v) { return { value: v.id, label: v.name + (v.category ? ' - ' + v.category : '') }; })
        .concat(rest.map(function (v) { return { value: v.id, label: v.name + ' - ' + lower(stateLabel(v.state)) + ', cannot be billed', disabled: v.id !== fs.vendorId }; }));
    }

    function categoryOptions() {
      if (!fs.unitId) return [];
      var cats = guard('bill.categoriesFor', function () { return W.bill.categoriesFor(fs.unitId); }, []);
      var v = vendorOf(fs.vendorId), usual = (v && v.expenseCategoryIds) || [];
      var first = cats.filter(function (c) { return has(usual, c.id); }), rest = cats.filter(function (c) { return !has(usual, c.id); });
      return first.map(function (c) { return { value: c.id, label: c.label + ' (usual for this vendor)' }; }).concat(rest.map(function (c) { return { value: c.id, label: c.label }; }));
    }

    function applyVendorDefaults() {
      var v = vendorOf(fs.vendorId);
      if (v) {
        var cats = guard('bill.categoriesFor', function () { return W.bill.categoriesFor(fs.unitId); }, []).map(function (c) { return c.id; });
        var usual = (v.expenseCategoryIds || []).filter(function (id) { return has(cats, id); });
        if (usual.length && !has(usual, fs.categoryId)) fs.categoryId = usual[0];
      }
      applyDue(); applyTds();
    }

    function applyDue() {
      var v = vendorOf(fs.vendorId);
      if (!fs.dueTouched && v && fs.invoiceDate) fs.dueDate = D.addDays(fs.invoiceDate, v.creditDays || 0);
    }

    function applyTds() {
      if (fs.tdsTouched || !fs.vendorId) return;
      var s = guard('bill.suggestTds', function () { return W.bill.suggestTds(fs.vendorId, fs.amount || 0); }, null);
      if (!s) return;
      fs.tdsLabel = s.applies && s.tdsLabel ? s.tdsLabel : '';
      fs.tdsAmount = s.applies ? s.tdsAmount : 0;
    }

    function payload() {
      var p = { unitId: fs.unitId, vendorId: fs.vendorId, categoryId: fs.categoryId, invoiceNo: fs.invoiceNo.trim(), invoiceDate: fs.invoiceDate, dueDate: fs.dueDate || undefined,
        description: fs.description.trim(), amount: fs.amount || 0, gstAmount: fs.gstAmount || 0, tdsLabel: fs.tdsLabel || null, tdsAmount: fs.tdsAmount || 0,
        attachments: fs.attachments.map(function (a) { return { name: a.name }; }), notes: fs.notes.trim() };
      if (fs.monthKey) p.monthKey = fs.monthKey; else if (savedId && fs.invoiceDate) p.monthKey = fs.invoiceDate.slice(0, 7);
      return p;
    }

    function formState() {
      return { id: savedId || undefined, status: fs.status || undefined, unitId: fs.unitId, vendorId: fs.vendorId, categoryId: fs.categoryId, invoiceNo: fs.invoiceNo, invoiceDate: fs.invoiceDate,
        monthKey: fs.monthKey || undefined, amount: fs.amount || 0, gstAmount: fs.gstAmount || 0, tdsAmount: fs.tdsAmount || 0 };
    }

    function paintFiles() {
      ui.clear(filesHost);
      fs.attachments.forEach(function (a, i) {
        filesHost.appendChild(h('span', { 'class': 'ab-file' }, ui.icon('paperclip', 12), a.name,
          h('button', { type: 'button', 'class': 'ab-file__x', 'aria-label': 'Remove ' + a.name, title: 'Remove', onClick: function () { fs.attachments.splice(i, 1); paintFiles(); } }, ui.icon('x', 12))));
      });
      if (!fs.attachments.length) filesHost.appendChild(h('span', { 'class': 'ab-muted ab-small' }, 'No file chosen'));
    }

    function paintLive() {
      /* payable preview - arithmetic on what the user typed; the data layer recomputes it on save */
      ui.clear(payableHost);
      var pay = (fs.amount || 0) + (fs.gstAmount || 0) - (fs.tdsAmount || 0);
      ui.append(payableHost, h('span', { 'class': 'mk-label' }, 'Payable to the vendor'), h('strong', { 'class': 'ab-payable__num' }, fs.amount ? fmt.inrFull(pay) : '-'),
        h('span', { 'class': 'ab-muted ab-small' }, 'Amount plus GST, less TDS'));

      ui.clear(dupHost);
      if (fs.vendorId && (fs.invoiceNo.trim() || fs.amount)) {
        var check = guard('bill.duplicateCheck', function () { return W.bill.duplicateCheck(formState()); }, null);
        if (check && check.matches && check.matches.length) dupHost.appendChild(duplicateBlock(check, env, null));
      }

      ui.clear(budgetHost);
      if (fs.unitId && fs.categoryId && fs.amount) budgetHost.appendChild(h('div', { 'class': 'ab-form__budget' }, h('div', { 'class': 'mk-label' }, 'Budget impact'), budgetBlock(formState(), env, true)));

      var v = vendorOf(fs.vendorId);
      vendorHint.textContent = v ? 'Credit terms ' + plural(v.creditDays || 0, 'day') + (v.tdsLabel ? ' - ' + v.tdsLabel : ' - no TDS type on the vendor master') : 'Only approved vendors can be billed; the others are listed with their state.';
      dueHint.textContent = fs.dueFromRecord ? 'As saved on the bill' + (v ? ' - vendor credit terms are ' + plural(v.creditDays || 0, 'day') : '')
        : (v && !fs.dueTouched ? 'Prefilled from the vendor credit terms (' + plural(v.creditDays || 0, 'day') + ')' : (fs.dueTouched ? 'Set by hand' : 'Prefilled once the vendor is chosen'));
      var s = fs.vendorId ? guard('bill.suggestTds', function () { return W.bill.suggestTds(fs.vendorId, fs.amount || 0); }, null) : null;
      tdsHint.textContent = s ? (s.applies ? s.note + ' (' + fmt.pct(s.rate, 0) + '): ' + fmt.inrFull(s.tdsAmount) : s.note) : 'Descriptive TDS types only; the amount is indicative.';
    }

    function showErrors() {
      Object.keys(fields).forEach(function (k) { fields[k].setError(errors[k] || ''); });
      ui.clear(topHost);
      if (topError) topHost.appendChild(ui.callout('critical', 'The bill could not be saved', topError));
    }

    function field(name, opts) { var f = ui.form.field(opts); fields[name] = f; return f; }

    /* a field the user corrects stops showing the error of the last save */
    function touch(name) { if (errors[name]) { delete errors[name]; if (fields[name]) fields[name].setError(''); } }

    function build(focusName) {
      ui.clear(bodyHost);
      fields = {}; controls = {};
      var oneUnit = units.length <= 1;
      controls.unit = ui.form.select({ name: 'unitId', value: fs.unitId, placeholder: 'Select a unit', disabled: oneUnit && !!fs.unitId,
        options: units.map(function (id) { return { value: id, label: env.look.unitName(id) }; }),
        onChange: function (v) {
          fs.unitId = v; delete errors.unitId;
          var stillThere = guard('vendor.list', function () { return W.vendor.list({ unitId: v }); }, []).some(function (x) { return x.id === fs.vendorId; });
          if (!stillThere) fs.vendorId = '';
          var cats = guard('bill.categoriesFor', function () { return W.bill.categoriesFor(v); }, []).map(function (c) { return c.id; });
          if (!has(cats, fs.categoryId)) fs.categoryId = '';
          applyVendorDefaults(); build('unitId');
        } });
      controls.vendor = ui.form.select({ name: 'vendorId', value: fs.vendorId, placeholder: fs.unitId ? 'Select a vendor' : 'Select the unit first', disabled: !fs.unitId, options: vendorOptions(),
        onChange: function (v) { fs.vendorId = v; delete errors.vendorId; applyVendorDefaults(); build('vendorId'); } });
      controls.category = ui.form.select({ name: 'categoryId', value: fs.categoryId, placeholder: fs.unitId ? 'Select a category' : 'Select the unit first', disabled: !fs.unitId, options: categoryOptions(),
        onChange: function (v) { fs.categoryId = v; touch('categoryId'); paintLive(); } });
      controls.month = ui.form.select({ name: 'monthKey', value: fs.monthKey, options: [{ value: '', label: 'Same as the invoice month' }].concat(monthOptions()),
        onChange: function (v) { fs.monthKey = v; touch('monthKey'); paintLive(); } });
      controls.invoiceNo = ui.form.input({ name: 'invoiceNo', value: fs.invoiceNo, mono: true, maxLength: 40, placeholder: 'As printed on the invoice',
        onInput: function (v) { fs.invoiceNo = v; touch('invoiceNo'); paintLive(); } });
      controls.invoiceDate = ui.form.dateInput({ name: 'invoiceDate', value: fs.invoiceDate, min: MK.calendar.dataStart, max: today,
        onChange: function (v) { fs.invoiceDate = v; touch('invoiceDate'); touch('dueDate'); applyDue(); if (controls.dueDate) controls.dueDate.value = fs.dueDate || ''; paintLive(); } });
      controls.dueDate = ui.form.dateInput({ name: 'dueDate', value: fs.dueDate, min: fs.invoiceDate || MK.calendar.dataStart,
        onChange: function (v) { fs.dueDate = v; touch('dueDate'); fs.dueTouched = !!v; fs.dueFromRecord = false; if (!v) { applyDue(); controls.dueDate.value = fs.dueDate || ''; } paintLive(); } });
      controls.description = ui.form.textarea({ name: 'description', value: fs.description, rows: 2, maxLength: 500, placeholder: 'What was bought or which period the invoice covers',
        onInput: function (v) { fs.description = v; touch('description'); } });
      controls.amount = ui.form.moneyInput({ name: 'amount', value: fs.amount, onChange: function (n) {
        fs.amount = n; touch('amount'); touch('gstAmount'); touch('tdsAmount'); applyTds();
        if (!fs.tdsTouched) { controls.tdsAmount.setValue(fs.tdsAmount || null); controls.tdsLabel.setValue(fs.tdsLabel || ''); }
        paintLive();
      } });
      controls.gstAmount = ui.form.moneyInput({ name: 'gstAmount', value: fs.gstAmount, onChange: function (n) { fs.gstAmount = n; touch('gstAmount'); paintLive(); } });
      controls.tdsLabel = ui.form.select({ name: 'tdsLabel', value: fs.tdsLabel, options: [{ value: '', label: 'No TDS' }].concat((W.bill.TDS_LABELS || []).map(function (l) { return { value: l, label: l }; })),
        onChange: function (v) { fs.tdsLabel = v; touch('tdsLabel'); touch('tdsAmount'); fs.tdsTouched = true; if (!v) { fs.tdsAmount = 0; controls.tdsAmount.setValue(null); } paintLive(); } });
      controls.tdsAmount = ui.form.moneyInput({ name: 'tdsAmount', value: fs.tdsAmount || null, onChange: function (n) { fs.tdsAmount = n; touch('tdsAmount'); touch('tdsLabel'); fs.tdsTouched = true; paintLive(); } });
      controls.notes = ui.form.textarea({ name: 'notes', value: fs.notes, rows: 2, maxLength: 500, placeholder: 'Anything the checker should know', onInput: function (v) { fs.notes = v; touch('notes'); } });

      var picker = h('input', { type: 'file', 'class': 'mk-sr', multiple: true, tabindex: -1, 'aria-hidden': 'true', onChange: function () {
        var list = picker.files || [];
        for (var i = 0; i < list.length && fs.attachments.length < MAX_ATTACHMENTS; i++) fs.attachments.push({ name: String(list[i].name).slice(0, 120) });
        picker.value = '';
        paintFiles();
      } });
      var pickBtn = ui.button({ label: 'Choose file', icon: 'paperclip', size: 'sm', onClick: function () { picker.click(); } });

      ui.append(bodyHost,
        topHost,
        ui.form.group([
          ui.form.row([
            field('unitId', { label: 'Unit', required: true, control: controls.unit, hint: oneUnit ? 'Limited to your unit' : 'Limited to the units you are assigned to' }),
            field('vendorId', { label: 'Vendor', required: true, control: h('div', null, controls.vendor, vendorHint) })
          ]),
          ui.form.row([
            field('categoryId', { label: 'Expense category', required: true, control: controls.category }),
            field('monthKey', { label: 'Expense month', optional: true, control: controls.month, hint: 'The month the cost belongs to, when the invoice comes later' })
          ]),
          ui.form.row([
            field('invoiceNo', { label: 'Vendor invoice no.', required: true, control: controls.invoiceNo }),
            field('invoiceDate', { label: 'Invoice date', required: true, control: controls.invoiceDate }),
            field('dueDate', { label: 'Due date', control: h('div', null, controls.dueDate, dueHint) })
          ], 3),
          dupHost,
          field('description', { label: 'Description', optional: true, control: controls.description }),
          ui.form.row([
            field('amount', { label: 'Bill amount', required: true, control: controls.amount, hint: 'Taxable value, before GST' }),
            field('gstAmount', { label: 'GST amount', optional: true, control: controls.gstAmount, hint: 'Part of the cost: no input credit' })
          ]),
          ui.form.row([
            field('tdsLabel', { label: 'TDS type', optional: true, control: h('div', null, controls.tdsLabel, tdsHint) }),
            field('tdsAmount', { label: 'TDS amount', optional: true, control: controls.tdsAmount })
          ]),
          payableHost,
          budgetHost,
          field('attachments', { label: 'Invoice attachment', optional: true, control: h('div', { 'class': 'ab-attach' }, h('div', { 'class': 'ab-attach__row' }, pickBtn, picker, filesHost)),
            hint: 'Only the file name is recorded in this mockup - nothing is uploaded.' }),
          field('notes', { label: 'Note to the checker', optional: true, control: controls.notes })
        ]),
        ui.sourceTag(['erp']));
      paintFiles(); paintLive(); showErrors();
      if (focusName) { var el = bodyHost.querySelector('[name="' + focusName + '"]'); if (el && !el.disabled) el.focus(); }
    }

    function fail(res) {
      errors = res.fields || {}; topError = res.error || 'The bill could not be saved';
      showErrors();
      if (d.body) d.body.scrollTop = 0;
      var firstBad = Object.keys(errors)[0], el = firstBad ? bodyHost.querySelector('[name="' + firstBad + '"]') : null;
      if (el && !el.disabled) el.focus();
    }

    function save(thenSubmit) {
      errors = {}; topError = null;
      var res = guard('bill.save', function () { return savedId ? W.bill.update(savedId, payload()) : W.bill.create(payload()); }, { ok: false, error: 'The bill could not be saved' });
      if (!res.ok) { fail(res); return; }
      savedId = res.record.id; fs.id = savedId; fs.status = res.record.status;
      if (thenSubmit) {
        var sub = guard('bill.submit', function () { return W.bill.submit(savedId); }, { ok: false, error: 'The bill could not be submitted' });
        if (!sub.ok) {
          d.setTitle('Edit ' + res.record.number, 'Saved as a draft - not yet submitted');
          fail({ error: 'Saved as draft ' + res.record.number + ', but it could not be submitted: ' + sub.error, fields: sub.fields });
          paintFoot();
          return;
        }
        ui.toast(sub.record.number + ' submitted to the finance checker', { tone: 'good' });
      } else ui.toast('Draft ' + res.record.number + ' saved', { tone: 'good' });
      saved = true;
      d.close();
    }

    function paintFoot() {
      ui.clear(footHost);
      var bill = savedId ? guard('bill.get', function () { return W.bill.get(savedId); }, null) : null;
      var maySave = bill ? W.bill.can('update', bill) : (fs.unitId ? W.bill.can('create', { unitId: fs.unitId }) : MK.session.can('bill.create'));
      var maySubmit = bill && bill.status === 'DRAFT' ? W.bill.can('submit', bill) : MK.session.can('bill.submit');
      var why = [];
      if (!maySave.ok) why.push('Save: ' + lowerFirst(maySave.reason) + '.');
      if (!maySubmit.ok && maySubmit.reason !== maySave.reason) why.push('Submit: ' + lowerFirst(maySubmit.reason) + '.');
      ui.append(footHost,
        h('div', { 'class': 'ab-actions__row' }, h('span', { 'class': 'ab-actions__buttons' },
          ui.button({ label: 'Cancel', variant: 'ghost', onClick: function () { d.close(); } }),
          ui.button({ label: savedId ? 'Save changes' : 'Save draft', icon: 'file', disabledReason: maySave.ok ? '' : maySave.reason, onClick: function () { save(false); } }),
          ui.button({ label: 'Submit for approval', variant: 'primary', icon: 'arrow-right', disabledReason: maySubmit.ok ? (maySave.ok ? '' : maySave.reason) : maySubmit.reason, onClick: function () { save(true); } }))),
        h('div', { 'class': 'ab-actions__why' }, ui.icon(why.length ? 'lock' : 'info', 12),
          h('span', null, why.length ? why.join(' ') : 'After submission the bill is decided by the finance checker - the person who raised it can never approve it.')));
    }

    if (!existing) applyVendorDefaults();
    build(null);
    paintFoot();
    var firstInput = bodyHost.querySelector(fs.unitId ? '[name="vendorId"]' : '[name="unitId"]');
    if (firstInput && !firstInput.disabled) firstInput.focus();
  }

  /* ================================================================== render */

  function render(rootEl, ctx) {
    var st = ctx.state;
    if (!MK.workflow || !MK.workflow.bill || !MK.audit) {
      rootEl.appendChild(ui.emptyState('Bills are not available', 'The workflow data layer did not load, so there is nothing to approve yet.', { icon: 'receipt' }));
      return;
    }
    var env = buildEnv(ctx);
    normaliseState(st, env);
    applyParams(st, ctx, env);
    live.ctx = ctx; live.st = st; live.env = env;

    rootEl.appendChild(intro(env));
    rootEl.appendChild(h('div', { 'class': 'ab-kpis' }, kpis(env).map(function (t) { return ui.statTile(t); })));
    rootEl.appendChild(h('div', { 'class': 'ab-glance' }, stageChart(env), attentionCard(env)));
    rootEl.appendChild(billsCard(env));

    /* overlays outlive a re-render: bring an open review drawer up to date (store change, persona change) */
    if (live.drawer) live.drawer.refresh();

    /* deep link: #/approvals/bills?id=BILL-... opens the drawer once per id */
    var wanted = ctx.params && ctx.params.id;
    if (wanted && st.linked !== wanted && !live.form) {
      st.linked = wanted;
      if (live.drawer) live.drawer.show(wanted); else openBill(wanted, { linked: wanted });
    }

    return function cleanup() {
      live.card = null; live.repaint = null; live.markSelected = null;
    };
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/approvals/bills',
    group: 'Approvals',
    title: 'Bills',
    subtitle: 'Maker-checker approval of vendor bills',
    units: 'all',
    roles: null,
    filters: [],
    render: render
  });
})(window);
