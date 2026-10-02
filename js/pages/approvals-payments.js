/*
 * Approvals / Payment batches (#/approvals/payments) - tier two of the two-tier maker-checker.
 *
 * Blocks: purpose line (with the "no bank connection" note and what the persona may do) -> KPI row -> approved and unpaid
 * bills with selection, quick filters and "Create batch" (payer) next to "who acts next" and the due-window chart ->
 * batches card with status tabs -> payments released by week -> batch drawer (lines, totals by vendor and by unit,
 * timeline, actions by persona) with the "new batch" and "record bank references" dialogs.
 *
 * Every figure comes from MK.workflow / MK.audit / MK.config and is formatted with MK.fmt. Access is never filtered here:
 * reads are scoped by the data layer, and every action asks MK.workflow.batch.can() so that a blocked action stays
 * visible, disabled, with the reason of the kernel (tooltip and a muted line above the action bar).
 *
 * Page-local state (ctx.state): userId, tab, quick, unit, vendor, sel {billId: true}, sortBills, sortBatches, linked.
 * Drawers and modals live outside the page root; their content sits in wrappers that carry the page class so the page
 * stylesheet applies. The module keeps one `live` object so an open drawer always talks to the latest render.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates;

  var PAGE_ID = 'approvals-payments';
  var PAGE_CLASS = 'pg-approvals-payments';
  var ALL = 'ALL';
  var STATUSES = ['DRAFT', 'PENDING_RELEASE', 'RELEASED', 'PAID', 'REJECTED'];
  var OPEN_STATUSES = ['DRAFT', 'PENDING_RELEASE', 'RELEASED'];
  var DUE_SOON_DAYS = 7;                 /* same horizon as MK.finance.payables().dueIn7Days */
  var WINDOW_EDGES = [7, 14, 30];        /* due-window chart: days from today */
  var MODAL_LINES = 6;

  var live = { ctx: null, env: null, drawer: null };

  /* ------------------------------------------------------------------ helpers */

  function guard(name, fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; }
    catch (e) { if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e); return fallback; }
  }
  function has(list, x) { return !!list && list.indexOf(x) !== -1; }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function day(iso, style) { return iso ? D.label(String(iso).slice(0, 10), style || 'd MMM yyyy') : '-'; }
  function dateOf(stamp) { return stamp ? String(stamp).slice(0, 10) : null; }
  function userName(id) { var u = id ? MK.session.userById(id) : null; return u ? u.name : (id || '-'); }
  function userRole(id) { var u = id ? MK.session.userById(id) : null; return u ? u.roleLabel : ''; }
  function sum(list, key) { return list.reduce(function (t, x) { return t + (x[key] || 0); }, 0); }
  function stateLabel(s) { var L = MK.workflow && MK.workflow.labels && MK.workflow.labels.state; return (L && L[s]) || ui.statusInfo(s).label; }
  function errText(key, fallback) { var E = MK.workflow && MK.workflow.errors; return (E && E[key]) || fallback; }
  function wrap(cls, children) { return h('div', { 'class': PAGE_CLASS + ' ' + cls }, children); }
  function daysLabel(n) { return n === 0 ? 'Today' : plural(n, 'day'); }

  function lookups() {
    var units = {}, vendors = {}, names = {}, accounts = {}, targets = [];
    ((MK.config && MK.config.outlets) || []).forEach(function (u) { units[u.id] = u; });
    guard('vendor.list', function () { return MK.workflow.vendor.list(); }, []).forEach(function (v) { vendors[v.id] = v; });
    var ba = (MK.config && MK.config.bankAccounts) || {};
    (ba.current || []).forEach(function (a) { accounts[a.id] = a; });
    (ba.target || []).forEach(function (a) { accounts[a.id] = a; targets.push(a); });
    return {
      units: units, vendors: vendors,
      unitName: function (id) { return units[id] ? units[id].name : (id || '-'); },
      unitShort: function (id) { return units[id] ? (units[id].short || units[id].name) : (id || '-'); },
      unitColour: function (id) { return units[id] ? units[id].colourVar : null; },
      vendorName: function (id) {
        if (vendors[id]) return vendors[id].name;
        if (!Object.prototype.hasOwnProperty.call(names, id)) names[id] = guard('vendor.nameOf', function () { return MK.workflow.vendor.nameOf(id); }, id || '-');
        return names[id];
      },
      account: function (id) { return accounts[id] || null; },
      /* 'HDFC Bank XXXX4417' - the masked number is all the mockup ever holds */
      accountShort: function (id) { var a = accounts[id]; return a ? [a.bank, a.masked || a.name].filter(Boolean).join(' ') : (id || '-'); },
      accountPurpose: function (id) { var a = accounts[id]; return a ? (a.purpose || a.name || '') : ''; },
      /* the account of the proposed (target) structure that takes over a current account */
      targetOf: function (id) {
        for (var i = 0; i < targets.length; i++) if (has(targets[i].replaces, id)) return targets[i];
        return null;
      }
    };
  }

  /*
   * Accounts a batch may be paid from: the accounts the workflow offers (MK.workflow.batch.bankAccounts) that roll into the
   * payments account of the target banking structure - the one that takes over today's default payment account.
   */
  function payFromOptions(look) {
    var all = guard('batch.bankAccounts', function () { return MK.workflow.batch.bankAccounts(); }, []);
    if (!all.length) return { list: [], target: null };
    var target = look.targetOf(all[0].id);
    var list = target ? all.filter(function (a) { return has(target.replaces, a.id); }) : all;
    return { list: list.length ? list : all, target: target };
  }

  function dot(colourVar) {
    return h('span', { 'class': 'pm-dot', 'aria-hidden': 'true', style: colourVar ? { background: 'var(' + colourVar + ')' } : null });
  }
  function unitTag(look, unitId) {
    return h('span', { 'class': 'pm-unit', title: look.unitName(unitId) }, dot(look.unitColour(unitId)), look.unitShort(unitId));
  }

  function dueOf(dueDate, today) {
    if (!dueDate) return { kind: 'none', days: null };
    var days = D.diffDays(today, dueDate);
    if (days < 0) return { kind: 'overdue', days: -days };
    if (days <= DUE_SOON_DAYS) return { kind: 'soon', days: days };
    return { kind: 'later', days: days };
  }

  /* the marker sits under the date in a narrow column: compact wording keeps the payable column in view at 1280px */
  function dueCell(dueDate, due) {
    var marker = null;
    if (due.kind === 'overdue') marker = h('span', { 'class': 'pm-late', title: 'Overdue by ' + plural(due.days, 'day') }, ui.icon('alert-triangle', 12), plural(due.days, 'day') + ' late');
    else if (due.kind === 'soon') marker = h('span', { 'class': 'pm-soon', title: due.days === 0 ? 'Falls due today' : 'Falls due in ' + plural(due.days, 'day') },
      ui.icon('clock', 12), due.days === 0 ? 'Due today' : 'in ' + plural(due.days, 'day'));
    return h('div', { 'class': 'pm-cell2' }, h('span', { 'class': 'mk-num' }, day(dueDate, 'd MMM')), marker);
  }

  function ageOf(p, today) {
    var since = p.status === 'DRAFT' ? p.createdAt : p.status === 'PENDING_RELEASE' ? (p.submittedAt || p.createdAt) : p.status === 'RELEASED' ? (p.releasedAt || p.createdAt) : null;
    if (since) return { open: true, days: Math.max(0, D.diffDays(dateOf(since), today)), at: since };
    var end = p.status === 'PAID' ? p.paidAt : p.rejectedAt;
    return { open: false, days: end && p.createdAt ? Math.max(0, D.diffDays(dateOf(p.createdAt), dateOf(end))) : null, at: end };
  }

  /* who has to act on a batch, in words */
  function nextStep(p) {
    if (p.status === 'DRAFT') return 'Payer submits it for release';
    if (p.status === 'PENDING_RELEASE') return 'Director releases or rejects';
    if (p.status === 'RELEASED') return 'Payer records the bank references (UTRs)';
    return '';
  }

  function actionFor(p, env) {
    if (p.status === 'DRAFT' && env.role === 'payer') return 'Submit for release';
    if (p.status === 'PENDING_RELEASE' && env.role === 'director') return 'Release or reject';
    if (p.status === 'RELEASED' && env.role === 'payer') return 'Record UTRs';
    return '';
  }

  /* ------------------------------------------------------------------ per-render environment */

  function buildEnv(ctx) {
    var W = MK.workflow;
    var env = { ctx: ctx, st: ctx.state, user: ctx.user || MK.session.current(), today: MK.calendar.today, look: lookups() };
    env.role = env.user.role;
    env.mayCreate = guard('batch.can create', function () { return W.batch.can('create'); }, { ok: false, reason: '' });
    env.mayRelease = MK.session.can('batch.release');
    env.mayMarkPaid = MK.session.can('batch.markPaid');
    env.batches = guard('batch.list', function () { return W.batch.list(); }, []);
    env.byStatus = {};
    STATUSES.forEach(function (s) { env.byStatus[s] = []; });
    env.batches.forEach(function (p) { if (env.byStatus[p.status]) env.byStatus[p.status].push(p); });
    env.paidBills = guard('bill.list paid', function () { return W.bill.list({ status: 'PAID' }); }, []);
    env.payFrom = payFromOptions(env.look);
    env.eligible = guard('batch.eligibleBills', function () { return W.batch.eligibleBills(); }, []).map(function (e) {
      var b = e.bill;
      return { id: b.id, bill: b, eligible: !!e.eligible, reason: e.reason || '', number: b.number, invoiceNo: b.invoiceNo, vendorId: b.vendorId,
        vendorName: env.look.vendorName(b.vendorId), unitId: b.unitId, unitName: env.look.unitName(b.unitId), dueDate: b.dueDate, payable: b.payable || 0,
        due: dueOf(b.dueDate, env.today) };
    });
    return env;
  }

  function defaultTab(env) {
    var n = function (s) { return env.byStatus[s].length; };
    if (env.role === 'director') return n('PENDING_RELEASE') ? 'PENDING_RELEASE' : (n('RELEASED') ? 'RELEASED' : 'PAID');
    if (env.role === 'payer') return n('DRAFT') ? 'DRAFT' : (n('RELEASED') ? 'RELEASED' : (n('PENDING_RELEASE') ? 'PENDING_RELEASE' : 'PAID'));
    return n('PENDING_RELEASE') ? 'PENDING_RELEASE' : (n('RELEASED') ? 'RELEASED' : 'PAID');
  }

  function normaliseState(st, env) {
    if (st.userId !== env.user.id) { st.userId = env.user.id; st.tab = defaultTab(env); st.sel = {}; }
    if (!has(STATUSES, st.tab)) st.tab = defaultTab(env);
    if (!has(['all', 'overdue', 'soon'], st.quick)) st.quick = 'all';
    st.unit = st.unit || ALL;
    st.vendor = st.vendor || ALL;
    st.sel = st.sel && typeof st.sel === 'object' ? st.sel : {};
    /* a selection only holds bills that can still be batched by this persona */
    var ok = {};
    env.eligible.forEach(function (r) { if (r.eligible) ok[r.id] = true; });
    Object.keys(st.sel).forEach(function (id) { if (!ok[id] || !env.mayCreate.ok) delete st.sel[id]; });
    if (st.unit !== ALL && !env.eligible.some(function (r) { return r.unitId === st.unit; })) st.unit = ALL;
    if (st.vendor !== ALL && !env.eligible.some(function (r) { return r.vendorId === st.vendor; })) st.vendor = ALL;
  }

  /* ------------------------------------------------------------------ intro */

  function intro(env) {
    var u = env.user, parts = [];
    if (env.mayCreate.ok) parts.push('you group approved bills into a batch, submit it for release and record the bank references once it is paid');
    if (env.mayRelease.ok) parts.push('you release or reject the batches the payer submits - never one you built yourself');
    if (!parts.length) {
      /* the kernel's own words, in lower case inside the sentence; without a reason the clause is simply left out */
      var why = env.mayCreate.reason || env.mayRelease.reason || '';
      parts.push('you can follow every batch in your scope but not act on it' +
        (why ? ' (' + why.replace(/^./, function (c) { return c.toLowerCase(); }) + ')' : ''));
    }
    return h('div', { 'class': 'pm-intro' },
      h('p', { 'class': 'pm-intro__text' },
        'Tier two of the two-tier maker-checker: the payer groups approved bills into a payment batch, the director releases it, and the payer records the bank references (UTRs). ',
        h('span', { 'class': 'pm-intro__who' }, 'As ' + u.name + ' (' + u.roleLabel + ') ' + parts.join('; ') + '.')),
      h('p', { 'class': 'pm-intro__note' }, ui.icon('info', 14),
        'The payment itself is made in the bank portal. The ERP records the approval and the bank reference; there is no bank connection.'));
  }

  /* ------------------------------------------------------------------ KPI row */

  function paymentStats(bills, monthKey) {
    var list = bills.filter(function (b) { return b.paidOn && b.paidOn.slice(0, 7) === monthKey; });
    var timed = list.filter(function (b) { return !!b.decidedAt; });
    var daysTotal = timed.reduce(function (t, b) { return t + Math.max(0, D.diffDays(dateOf(b.decidedAt), b.paidOn)); }, 0);
    var late = list.filter(function (b) { return b.dueDate && b.paidOn > b.dueDate; }).length;
    return { count: list.length, value: sum(list, 'payable'), avgDays: timed.length ? daysTotal / timed.length : null, late: late, lateShare: list.length ? late / list.length : null };
  }

  function kpis(env) {
    var pending = env.byStatus.PENDING_RELEASE, released = env.byStatus.RELEASED;
    var monthKey = env.today.slice(0, 7), prevKey = D.addDays(D.monthStart(env.today), -1).slice(0, 7);
    var cur = paymentStats(env.paidBills, monthKey), prev = paymentStats(env.paidBills, prevKey);
    var oldestPending = pending.reduce(function (m, p) { var a = ageOf(p, env.today).days; return a > m ? a : m; }, 0);
    var oldestReleased = released.reduce(function (m, p) { var a = ageOf(p, env.today).days; return a > m ? a : m; }, 0);
    var ready = env.eligible.filter(function (r) { return r.eligible; });
    var overdue = env.eligible.filter(function (r) { return r.due.kind === 'overdue'; });
    var soon = env.eligible.filter(function (r) { return r.due.kind === 'soon'; });
    var blocked = env.eligible.length - ready.length;

    function goTab(tab) { return function () { env.st.tab = tab; env.ctx.rerender(); var el = root.document.getElementById('pm-batches'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); }; }

    return [
      { label: 'Awaiting release', icon: 'lock', value: fmt.inr(sum(pending, 'total')), tone: pending.length ? 'warn' : null,
        sub: pending.length ? plural(pending.length, 'batch', 'batches') + ', ' + plural(pending.reduce(function (t, p) { return t + p.billIds.length; }, 0), 'bill') + ' - waiting ' + daysLabel(oldestPending).toLowerCase() + ' for the director'
          : 'No batch is waiting for the director',
        title: 'Batches the payer has submitted and the director has not yet released or rejected', onClick: goTab('PENDING_RELEASE') },
      { label: 'Released, UTR awaited', icon: 'bank', value: fmt.inr(sum(released, 'total')),
        sub: released.length ? plural(released.length, 'batch', 'batches') + ', ' + plural(released.reduce(function (t, p) { return t + p.billIds.length; }, 0), 'bill') + ' - released ' + (oldestReleased === 0 ? 'today' : plural(oldestReleased, 'day') + ' ago')
          : 'Every released batch has its bank reference',
        title: 'Released by the director; the payer still has to record the bank references', onClick: goTab('RELEASED') },
      { label: 'Paid in ' + D.monthLabel(monthKey), icon: 'check-circle', value: fmt.inr(cur.value),
        sub: cur.count ? plural(cur.count, 'bill') + ' with a bank reference - ' + fmt.num(cur.count - cur.late) + ' of them paid on or before the due date' : 'No payment recorded yet this month',
        title: 'Bills with a recorded UTR whose payment date (the release of their batch) falls in ' + D.monthLabel(monthKey, true), onClick: goTab('PAID') },
      { label: 'Approval to payment', icon: 'clock', value: cur.avgDays === null ? '-' : fmt.num(cur.avgDays, 1) + ' days',
        delta: cur.avgDays !== null && prev.avgDays !== null ? fmt.delta(cur.avgDays, prev.avgDays) : null, goodWhen: 'down', deltaNote: prev.avgDays !== null ? 'vs ' + D.monthLabel(prevKey) : null,
        sub: cur.count ? 'average over ' + plural(cur.count, 'bill') + ' paid in ' + D.monthLabel(monthKey) : 'No payment recorded yet this month',
        title: 'Average days from the checker\'s approval of a bill to its payment date' },
      { label: 'Approved and unpaid', icon: 'wallet', value: fmt.inr(sum(env.eligible, 'payable')), tone: overdue.length ? 'warn' : null,
        sub: plural(env.eligible.length, 'bill') + ' - ' + fmt.num(overdue.length) + ' overdue, ' + fmt.num(soon.length) + ' due in ' + plural(DUE_SOON_DAYS, 'day') +
          (blocked ? ', ' + fmt.num(blocked) + ' blocked' : ''),
        title: 'Approved bills the payer has not yet put into a payment batch' }
    ];
  }

  /* ------------------------------------------------------------------ approved and unpaid */

  function approvedCard(env) {
    var st = env.st, look = env.look, all = env.eligible;
    var canSelect = env.mayCreate.ok;
    var holder = h('div', { 'class': 'pm-listhold' });
    var selInfo = h('div', { 'class': 'pm-selbar__info', 'aria-live': 'polite' });
    var shownInfo = h('span', { 'class': 'pm-listfoot__shown' });
    var clearBtn = ui.button({ label: 'Clear', variant: 'text', size: 'sm', onClick: function () { st.sel = {}; paint(); } });
    var createHold = h('span', { 'class': 'pm-selbar__go' });
    var headBox = null, shown = [];

    function count(kind) { return all.filter(function (r) { return r.due.kind === kind; }).length; }
    function filtered() {
      return all.filter(function (r) {
        if (st.quick === 'overdue' && r.due.kind !== 'overdue') return false;
        if (st.quick === 'soon' && r.due.kind !== 'soon') return false;
        if (st.unit !== ALL && r.unitId !== st.unit) return false;
        if (st.vendor !== ALL && r.vendorId !== st.vendor) return false;
        return true;
      });
    }
    function selectedRows() { return all.filter(function (r) { return st.sel[r.id]; }); }

    function paintSelection() {
      var sel = selectedRows(), hidden = sel.filter(function (r) { return shown.indexOf(r) === -1; }).length;
      ui.clear(selInfo);
      if (!canSelect) {
        ui.append(selInfo, h('span', { 'class': 'pm-why' }, ui.icon('lock', 14), 'Building a batch is the payer\'s job. ' + env.mayCreate.reason + '.'));
      } else if (!sel.length) {
        ui.append(selInfo, h('span', { 'class': 'mk-muted' }, 'Tick the bills that go into the next payment run. The running total appears here.'));
      } else {
        var vendors = {}; sel.forEach(function (r) { vendors[r.vendorId] = true; });
        ui.append(selInfo, h('strong', { 'class': 'mk-num' }, plural(sel.length, 'bill') + ' selected'),
          h('span', { 'class': 'pm-selbar__total mk-num' }, fmt.inrFull(sum(sel, 'payable'))),
          h('span', { 'class': 'mk-muted' }, plural(Object.keys(vendors).length, 'vendor') + (hidden ? ' - ' + fmt.num(hidden) + ' not shown by the current filter' : '')),
          clearBtn);
      }
      ui.clear(createHold);
      createHold.appendChild(ui.button({ label: 'Create batch', icon: 'plus', variant: 'primary',
        disabledReason: !canSelect ? env.mayCreate.reason : (!sel.length ? errText('noBills', 'Select at least one approved bill') : ''),
        onClick: function () { openCreate(selectedRows()); } }));
      if (headBox) {
        var pickable = shown.filter(function (r) { return r.eligible; });
        var picked = pickable.filter(function (r) { return st.sel[r.id]; }).length;
        headBox.checked = pickable.length > 0 && picked === pickable.length;
        headBox.indeterminate = picked > 0 && picked < pickable.length;
      }
    }

    function checkCell(v, row) {
      var why = !canSelect ? env.mayCreate.reason : (!row.eligible ? row.reason : '');
      var box = h('input', { type: 'checkbox', checked: !!st.sel[row.id], disabled: why ? true : null,
        onChange: function () {
          if (box.checked) st.sel[row.id] = true; else delete st.sel[row.id];
          var tr = box.closest ? box.closest('tr') : null;
          if (tr) tr.classList.toggle('is-selected', box.checked);
          paintSelection();
        } });
      return h('label', { 'class': 'mk-check', title: why || null }, box, h('span', { 'class': 'mk-sr' }, 'Select ' + row.number + ', ' + row.vendorName));
    }

    function paint() {
      shown = filtered();
      headBox = h('input', { type: 'checkbox', disabled: canSelect ? null : true,
        onChange: function () {
          var on = headBox.checked;
          shown.forEach(function (r) { if (!r.eligible) return; if (on) st.sel[r.id] = true; else delete st.sel[r.id]; });
          paint();
        } });
      var columns = [
        { key: 'sel', label: h('label', { 'class': 'mk-check', title: canSelect ? 'Select every bill shown' : env.mayCreate.reason }, headBox, h('span', { 'class': 'mk-sr' }, 'Select every bill shown')),
          width: 36, sortable: false, render: checkCell },
        { key: 'dueDate', label: 'Due', width: 96, render: function (v, row) { return dueCell(v, row.due); } },
        { key: 'vendorName', label: 'Vendor', render: function (v, row) {
          return h('div', { 'class': 'pm-cell2 pm-clip' },
            h('span', { 'class': 'pm-cell2__top mk-strong', title: v }, v),
            h('span', { 'class': 'pm-cell2__sub' },
              ui.link(row.number, MK.router.href('approvals-bills', { id: row.id }), { title: 'Open the bill' }),
              h('span', { title: row.invoiceNo }, ' - ' + row.invoiceNo),
              !row.eligible ? h('span', { 'class': 'pm-blocked', title: row.reason }, ui.icon('lock', 12), 'Blocked') : null));
        } },
        { key: 'unitName', label: 'Unit', width: 96, render: function (v, row) { return unitTag(look, row.unitId); } },
        { key: 'payable', label: 'Payable', format: 'inrFull', width: 96 }
      ];
      ui.clear(holder);
      holder.appendChild(ui.table({
        columns: columns, rows: shown, dense: true, sortable: true, maxHeight: 328,
        sort: st.sortBills || { key: 'dueDate', dir: 'asc' }, onSort: function (s) { st.sortBills = s; },
        rowClass: function (row) { return st.sel[row.id] ? 'is-selected' : (!row.eligible ? 'is-muted' : ''); },
        empty: all.length ? ui.emptyState('No approved bill matches these filters', 'Clear the quick filter, the unit or the vendor to see the full list.', { compact: true, icon: 'filter' })
          : ui.emptyState('Nothing is waiting for a payment batch', 'Bills appear here as soon as the finance checker approves them on the Bills screen.', { compact: true, icon: 'check-circle' })
      }));
      ui.clear(shownInfo);
      ui.append(shownInfo, 'Showing ' + plural(shown.length, 'bill') + ' of ' + fmt.num(all.length) + ' - ', h('strong', { 'class': 'mk-num' }, fmt.inrFull(sum(shown, 'payable'))), ' payable');
      paintSelection();
    }

    var unitOptions = [{ value: ALL, label: 'All units' }], vendorOptions = [{ value: ALL, label: 'All vendors' }], seenU = {}, seenV = {};
    ((MK.config && MK.config.outlets) || []).forEach(function (u) {
      if (all.some(function (r) { return r.unitId === u.id; }) && !seenU[u.id]) { seenU[u.id] = true; unitOptions.push({ value: u.id, label: u.name }); }
    });
    all.slice().sort(function (a, b) { return a.vendorName < b.vendorName ? -1 : (a.vendorName > b.vendorName ? 1 : 0); }).forEach(function (r) {
      if (!seenV[r.vendorId]) { seenV[r.vendorId] = true; vendorOptions.push({ value: r.vendorId, label: r.vendorName }); }
    });

    var filters = h('div', { 'class': 'pm-filters' },
      ui.segmented({ ariaLabel: 'Due date filter', size: 'sm', value: st.quick, onChange: function (v) { st.quick = v; paint(); },
        options: [{ value: 'all', label: 'All (' + fmt.num(all.length) + ')' }, { value: 'overdue', label: 'Overdue (' + fmt.num(count('overdue')) + ')' },
          { value: 'soon', label: 'Due within ' + plural(DUE_SOON_DAYS, 'day') + ' (' + fmt.num(count('soon')) + ')' }] }),
      h('span', { 'class': 'pm-filters__selects' },
        ui.select({ ariaLabel: 'Unit', size: 'sm', value: st.unit, options: unitOptions, onChange: function (v) { st.unit = v; paint(); } }),
        ui.select({ ariaLabel: 'Vendor', size: 'sm', value: st.vendor, options: vendorOptions, onChange: function (v) { st.vendor = v; paint(); } })));

    var blocked = all.filter(function (r) { return !r.eligible; });
    var card = ui.card({
      title: 'Approved and unpaid', flush: true, className: 'pm-approved',
      subtitle: all.length ? plural(all.length, 'approved bill') + ' not yet in a batch, earliest due date first' +
        (blocked.length ? '. ' + plural(blocked.length, 'bill') + ' cannot be paid until the vendor is approved again' : '') : 'Approved bills that are not yet in a payment batch',
      body: [filters, holder, h('div', { 'class': 'pm-listfoot' }, shownInfo), h('div', { 'class': 'pm-selbar' }, selInfo, createHold)],
      footer: ui.sourceTag(['erp'])
    });
    paint();
    return card;
  }

  /* ------------------------------------------------------------------ who acts next */

  function queueCard(env) {
    var look = env.look;
    var open = env.batches.filter(function (p) { return has(OPEN_STATUSES, p.status); });
    var mine = open.filter(function (p) { return !!actionFor(p, env); });
    var actor = env.role === 'payer' || env.role === 'director';
    var list = (mine.length || actor ? mine : open).slice().sort(function (a, b) { return ageOf(b, env.today).days - ageOf(a, env.today).days; });

    var body;
    if (!list.length) {
      body = actor
        ? ui.emptyState('Nothing is waiting on you', env.role === 'director' ? 'No batch is pending release. A batch lands here as soon as the payer submits it.' :
          'No draft to submit and no released batch without a bank reference.', { compact: true, icon: 'check-circle' })
        : ui.emptyState('No batch is in flight', env.batches.length ? 'Every batch in your scope is paid or closed.' :
          'A batch is visible to you only when every bill in it belongs to your unit. None does today; the payment status of your bills is on the Bills screen.', { compact: true, icon: 'wallet' });
    } else {
      body = h('ul', { 'class': 'pm-queue' }, list.map(function (p) {
        var age = ageOf(p, env.today), act = actionFor(p, env);
        return h('li', null, h('button', { type: 'button', 'class': 'pm-queue__row', onClick: function () { openBatch(p.id); }, 'aria-label': 'Open ' + p.number },
          h('span', { 'class': 'pm-queue__top' }, h('span', { 'class': 'pm-queue__no' }, p.number), ui.statusChip(p.status), h('span', { 'class': 'pm-queue__amt mk-num' }, fmt.inrFull(p.total))),
          h('span', { 'class': 'pm-queue__meta' }, plural(p.billIds.length, 'bill') + ' - ' + look.accountShort(p.bankAccountId) + ' - in this state ' + (age.days === 0 ? 'since today' : 'for ' + plural(age.days, 'day'))),
          h('span', { 'class': act ? 'pm-queue__act' : 'pm-queue__next' }, ui.icon(act ? 'arrow-right' : 'clock', 12), act ? 'Your move: ' + act.toLowerCase() : 'Next: ' + nextStep(p).toLowerCase())));
      }));
    }
    return ui.card({
      title: actor ? 'Waiting on you' : 'In flight - who acts next', className: 'pm-queuecard',
      subtitle: actor ? (env.role === 'director' ? 'Batches submitted by the payer for your release' : 'Drafts to submit and released batches without a bank reference')
        : 'Open batches in your scope and the role that moves them on',
      body: body, footer: ui.sourceTag(['erp'])
    });
  }

  /* ------------------------------------------------------------------ due-window chart */

  function windowsChart(env) {
    var labels = ['Overdue', 'Due in ' + fmt.num(WINDOW_EDGES[0]) + ' days'];
    for (var i = 1; i < WINDOW_EDGES.length; i++) labels.push(fmt.num(WINDOW_EDGES[i - 1] + 1) + '-' + fmt.num(WINDOW_EDGES[i]) + ' days');
    labels.push('Later');
    var values = labels.map(function () { return 0; }), counts = labels.map(function () { return 0; });
    env.eligible.forEach(function (r) {
      var idx;
      if (r.due.kind === 'overdue') idx = 0;
      else {
        idx = labels.length - 1;
        for (var k = 0; k < WINDOW_EDGES.length; k++) if (r.due.days <= WINDOW_EDGES[k]) { idx = k + 1; break; }
      }
      values[idx] += r.payable; counts[idx] += 1;
    });
    var total = values.reduce(function (t, v) { return t + v; }, 0), near = values[0] + values[1];
    var nearCount = counts[0] + counts[1];
    var subtitle;
    if (!total) subtitle = 'No approved bill is waiting for a batch';
    else if (values[0]) {
      subtitle = fmt.inr(near) + ' over ' + plural(nearCount, 'bill') + ' is overdue or falls due within ' + plural(WINDOW_EDGES[0], 'day') +
        ' - ' + fmt.pct(near / total, 0) + ' of the ' + fmt.inr(total) + ' waiting, and the size of the next run; ' +
        fmt.inr(values[0]) + ' over ' + plural(counts[0], 'bill') + ' is already past its due date';
    } else {
      subtitle = 'Nothing is past its due date: ' + fmt.inr(near) + ' over ' + plural(nearCount, 'bill') + ' falls due within ' + plural(WINDOW_EDGES[0], 'day') +
        ' - ' + fmt.pct(near / total, 0) + ' of the ' + fmt.inr(total) + ' waiting, and the size of the next run';
    }
    var c = MK.charts.mount(null, {
      id: 'pm-windows', kind: 'bar', title: 'Approved and unpaid by due window', subtitle: subtitle, height: 220, format: 'inr',
      data: { categories: labels, values: values, name: 'Payable', categoryHeader: 'Due window' },
      table: { columns: [{ key: 'window', label: 'Due window' }, { key: 'bills', label: 'Bills', format: 'num', align: 'right' }, { key: 'payable', label: 'Payable', format: 'inrFull', align: 'right' }],
        rows: labels.map(function (l, k) { return { window: l, bills: counts[k], payable: values[k] }; }) },
      emptyText: 'No approved bill is waiting for a batch'
    });
    c.el.appendChild(h('div', { 'class': 'pm-chartsrc' }, ui.sourceTag(['erp'])));
    return c.el;
  }

  /* ------------------------------------------------------------------ batches card */

  function batchesCard(env) {
    var st = env.st, look = env.look;
    var holder = h('div');

    function paint() {
      var rows = env.byStatus[st.tab].map(function (p) {
        var age = ageOf(p, env.today);
        return { id: p.id, batch: p, number: p.number, createdAt: p.createdAt, createdBy: userName(p.createdBy), bills: p.billIds.length, total: p.total,
          account: look.accountShort(p.bankAccountId), status: p.status, age: age, ageDays: age.days, utr: p.utr, reason: p.rejectionReason };
      });
      var columns = [
        { key: 'number', label: 'Batch', render: function (v, row) {
          return h('div', { 'class': 'pm-cell2' }, h('span', { 'class': 'mk-strong' }, v), h('span', { 'class': 'pm-cell2__sub' }, 'created ' + day(row.createdAt, 'd MMM yyyy'))); } },
        { key: 'createdBy', label: 'Created by', render: function (v, row) {
          return h('div', { 'class': 'pm-cell2' }, h('span', null, v), h('span', { 'class': 'pm-cell2__sub' }, userRole(row.batch.createdBy))); } },
        { key: 'bills', label: 'Bills', format: 'num', render: function (v, row) {
          return h('div', { 'class': 'pm-cell2 pm-cell2--num' }, h('span', { 'class': 'mk-num' }, fmt.num(v)),
            h('span', { 'class': 'pm-cell2__sub', title: row.batch.unitIds.map(look.unitName).join(', ') }, row.batch.unitIds.length === 1 ? look.unitShort(row.batch.unitIds[0]) : plural(row.batch.unitIds.length, 'unit'))); } },
        { key: 'total', label: 'Total', format: 'inrFull', render: ui.cells.bar(null, '--series-1', { format: 'inrFull' }), width: 220 },
        { key: 'account', label: 'Paid from (masked)', render: function (v, row) {
          return h('div', { 'class': 'pm-cell2 pm-clip' }, h('span', { 'class': 'mk-num' }, v), h('span', { 'class': 'pm-cell2__sub', title: look.accountPurpose(row.batch.bankAccountId) }, look.accountPurpose(row.batch.bankAccountId))); } },
        st.tab === 'PAID' ? { key: 'utr', label: 'Bank reference', sortable: false, render: function (v) { return v ? h('span', { 'class': 'pm-mono' }, v) : h('span', { 'class': 'mk-muted' }, 'One per bill'); } } : null,
        st.tab === 'REJECTED' ? { key: 'reason', label: 'Reason', maxWidth: 260, sortable: false } : null,
        { key: 'status', label: 'Status', render: ui.cells.status() },
        { key: 'ageDays', label: 'Age', align: 'right', render: function (v, row) {
          if (v === null) return h('span', { 'class': 'mk-faint' }, '-');
          return h('div', { 'class': 'pm-cell2 pm-cell2--num' }, h('span', { 'class': 'mk-num' }, daysLabel(v)),
            h('span', { 'class': 'pm-cell2__sub' }, row.age.open ? 'in this state' : (row.status === 'PAID' ? 'created to UTR' : 'created to rejection'))); } }
      ];
      var total = sum(rows, 'total');
      ui.clear(holder);
      holder.appendChild(ui.table({
        columns: columns, rows: rows, sortable: true, maxHeight: 420, sort: st.sortBatches || { key: 'number', dir: 'desc' }, onSort: function (s) { st.sortBatches = s; },
        onRowClick: function (row) { openBatch(row.id); },
        footer: rows.length > 1 ? { number: plural(rows.length, 'batch', 'batches'), bills: sum(rows, 'bills'), total: total } : null,
        empty: emptyFor(st.tab, env)
      }));
    }

    var tabs = ui.tabs({ ariaLabel: 'Batch status', value: st.tab, onChange: function (id) { st.tab = id; paint(); },
      items: STATUSES.map(function (s) { return { id: s, label: s === 'RELEASED' ? 'Released' : stateLabel(s), count: env.byStatus[s].length }; }) });

    var card = ui.card({
      id: 'pm-batches', title: 'Payment batches', flush: true,
      subtitle: env.batches.length ? plural(env.batches.length, 'batch', 'batches') + ' in your scope - open one for its bills, totals, timeline and actions' : 'No payment batch is visible in your scope',
      body: [h('div', { 'class': 'pm-toolbar' }, tabs), holder], footer: ui.sourceTag(['erp'])
    });
    paint();
    return card;
  }

  function emptyFor(tab, env) {
    if (!env.batches.length && !MK.session.seesAllUnits()) {
      return ui.emptyState('No payment batch in your scope', 'Batches usually mix bills of several units, and a batch is visible to you only when every bill in it belongs to ' +
        MK.session.allowedUnitIds().map(env.look.unitName).join(', ') + '. The payment status of each of your bills is on the Bills screen.', { compact: true, icon: 'wallet' });
    }
    var text = {
      DRAFT: ['No draft batch', 'A draft appears when the payer creates a batch without submitting it.'],
      PENDING_RELEASE: ['Nothing is waiting for release', 'A batch lands here when the payer submits it to the director.'],
      RELEASED: ['No released batch is waiting for a bank reference', 'Released batches stay here until the payer records the UTRs.'],
      PAID: ['No paid batch yet', 'A batch is paid once its bank references are recorded.'],
      REJECTED: ['No batch has been rejected', 'When the director rejects a batch its bills go back to Approved and can be batched again.']
    }[tab] || ['Nothing to show', null];
    return ui.emptyState(text[0], text[1], { compact: true, icon: 'wallet' });
  }

  /* ------------------------------------------------------------------ released by week */

  function weeklyChart(env) {
    var released = env.batches.filter(function (p) { return !!p.releasedAt; });
    if (!released.length) return null;
    var weeks = {}, accounts = [];
    released.forEach(function (p) {
      var wk = D.weekStart(dateOf(p.releasedAt));
      weeks[wk] = weeks[wk] || {};
      weeks[wk][p.bankAccountId] = (weeks[wk][p.bankAccountId] || 0) + p.total;
      if (!has(accounts, p.bankAccountId)) accounts.push(p.bankAccountId);
    });
    var keys = Object.keys(weeks).sort();
    var order = env.payFrom.list.map(function (a) { return a.id; });
    accounts.sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || (a < b ? -1 : 1); });
    var series = accounts.map(function (id) {
      var pos = order.indexOf(id);
      return { id: id, name: env.look.accountPurpose(id) || env.look.accountShort(id), colourVar: pos >= 0 && pos < 8 ? MK.charts.colourFor('series', pos) : '--series-muted',
        values: keys.map(function (k) { return weeks[k][id] || 0; }) };
    });
    var totals = keys.map(function (k) { return accounts.reduce(function (t, id) { return t + (weeks[k][id] || 0); }, 0); });
    var top = 0; totals.forEach(function (v, i) { if (v > totals[top]) top = i; });
    var grand = totals.reduce(function (t, v) { return t + v; }, 0);
    /* the running week is still open: the weekly average is taken over complete weeks only */
    var full = keys.filter(function (k) { return D.addDays(k, 6) < env.today; });
    var fullTotal = full.reduce(function (t, k) { return t + totals[keys.indexOf(k)]; }, 0);
    var subtitle = fmt.inr(grand) + ' released through ' + plural(released.length, 'batch', 'batches') + ' since ' + day(keys[0], 'd MMM') +
      (full.length ? ', about ' + fmt.inr(Math.round(fullTotal / full.length)) + ' a week over ' + plural(full.length, 'complete week') : '') +
      '; the week of ' + day(keys[top], 'd MMM') + ' was the largest at ' + fmt.inr(totals[top]);
    var c = MK.charts.mount(null, {
      id: 'pm-weekly', kind: 'stackedBar', title: 'Payments released by week', subtitle: subtitle, height: 240, format: 'inr',
      data: { categories: keys.map(function (k) { return day(k, 'd MMM'); }), series: series, categoryHeader: 'Week starting' },
      note: 'Week of the director\'s release, which is the payment date. Split by the account the batch was paid from.'
    });
    c.el.appendChild(h('div', { 'class': 'pm-chartsrc' }, ui.sourceTag(['erp'])));
    return c.el;
  }

  /* ------------------------------------------------------------------ new batch dialog */

  function openCreate(rows) {
    var env = live.env; if (!env || !rows.length) return;
    var look = env.look, W = MK.workflow, options = env.payFrom.list, target = env.payFrom.target;
    var unitIds = []; rows.forEach(function (r) { if (!has(unitIds, r.unitId)) unitIds.push(r.unitId); });
    var vendors = {}; rows.forEach(function (r) { vendors[r.vendorId] = (vendors[r.vendorId] || 0) + r.payable; });
    var preferred = options[0] ? options[0].id : '';
    if (unitIds.length === 1) options.forEach(function (a) { var c = look.account(a.id); if (c && c.unitId === unitIds[0]) preferred = a.id; });
    var earliest = rows.reduce(function (m, r) { return !m || r.dueDate < m ? r.dueDate : m; }, null);
    var overdue = rows.filter(function (r) { return r.due.kind === 'overdue'; }).length;

    var account = ui.form.select({ ariaLabel: 'Pay from', value: preferred, options: options.map(function (a) { return { value: a.id, label: a.label }; }) });
    var accountField = ui.form.field({ label: 'Pay from', required: true, control: account,
      hint: target ? 'Accounts that become the "' + target.name + '" (' + target.bank + ') of the proposed banking structure. Numbers stay masked.' : 'Numbers stay masked.' });
    var errorBox = h('div', { 'class': 'pm-formerror', role: 'alert' });

    var top = rows.slice().sort(function (a, b) { return b.payable - a.payable; });
    var lines = h('ul', { 'class': 'pm-lines' }, top.slice(0, MODAL_LINES).map(function (r) {
      return h('li', null, h('span', { 'class': 'pm-lines__name', title: r.vendorName }, r.vendorName), h('span', { 'class': 'pm-lines__meta' }, r.number + ' - due ' + day(r.dueDate, 'd MMM')),
        h('span', { 'class': 'pm-lines__amt mk-num' }, fmt.inrFull(r.payable)));
    }), top.length > MODAL_LINES ? h('li', { 'class': 'pm-lines__more' }, '+ ' + plural(top.length - MODAL_LINES, 'more bill') + ', ' + fmt.inrFull(sum(top.slice(MODAL_LINES), 'payable'))) : null);

    function run(submitToo) {
      ui.clear(errorBox);
      var res = W.batch.create(rows.map(function (r) { return r.id; }), account.getValue());
      if (!res.ok) { errorBox.appendChild(ui.callout('critical', 'The batch was not created', res.error)); return; }
      var rec = res.record, sub = submitToo ? W.batch.submit(rec.id) : null;
      env.st.sel = {};
      env.st.tab = sub && sub.ok ? 'PENDING_RELEASE' : 'DRAFT';
      m.close();
      if (sub && !sub.ok) {
        ui.toast(sub.error, { title: rec.number + ' saved as a draft - it could not be submitted', tone: 'warn' });
        openBatch(rec.id);
      } else if (sub) {
        ui.toast(plural(rec.billIds.length, 'bill') + ', ' + fmt.inrFull(rec.total) + '. It now waits for the director\'s release.', { title: rec.number + ' submitted for release', tone: 'good' });
      } else {
        ui.toast(plural(rec.billIds.length, 'bill') + ', ' + fmt.inrFull(rec.total) + '. The bills are reserved; submit the draft when it is complete.', { title: rec.number + ' saved as a draft', tone: 'info' });
      }
      if (live.ctx) live.ctx.rerender();
    }

    var m = ui.modal({
      title: 'New payment batch', subtitle: plural(rows.length, 'bill') + ' - ' + plural(Object.keys(vendors).length, 'vendor') + ' - ' + fmt.inrFull(sum(rows, 'payable')),
      body: wrap('pm-modal', [
        ui.keyValue([['Batch total', h('strong', { 'class': 'mk-num' }, fmt.inrFull(sum(rows, 'payable')))], ['Bills', fmt.num(rows.length)],
          ['Units', unitIds.map(look.unitShort).join(', ')], ['Earliest due date', day(earliest) + (overdue ? ' - ' + fmt.num(overdue) + ' overdue' : '')]], { cols: 2 }),
        lines, accountField,
        h('p', { 'class': 'pm-note' }, ui.icon('info', 14), 'Submitting sends the batch to the director. After the release the payment is made in the bank portal (CSV export), and the bank reference is recorded here.'),
        errorBox
      ]),
      footer: [ui.button({ label: 'Cancel', variant: 'ghost', onClick: function () { m.close(); } }),
        ui.button({ label: 'Save as draft', onClick: function () { run(false); } }),
        ui.button({ label: 'Create and submit for release', variant: 'primary', icon: 'arrow-right', onClick: function () { run(true); } })]
    });
  }

  /* ------------------------------------------------------------------ record bank references dialog */

  /* demo aid: a reference shaped like the ones banks issue (bank code, N, yy, day of year, serial) - deterministic per bill */
  function sampleUtr(p, key, look) {
    var a = look.account(p.bankAccountId), code = ((a && a.bank) || 'BANK').replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase();
    var when = dateOf(p.releasedAt) || MK.calendar.today, doy = D.diffDays(when.slice(0, 4) + '-01-01', when) + 1;
    var serial = String(MK.hash(p.id + '|' + key) % 1000000);
    while (serial.length < 6) serial = '0' + serial;
    return code + 'N' + when.slice(2, 4) + (doy < 100 ? '0' : '') + (doy < 10 ? '0' : '') + doy + serial;
  }

  function openUtr(batchId) {
    var env = live.env, W = MK.workflow; if (!env) return;
    var p = guard('batch.get', function () { return W.batch.get(batchId); }, null); if (!p) return;
    var look = env.look, bills = guard('batch.bills', function () { return W.batch.bills(batchId); }, []);
    var form = { mode: 'batch', utr: '', byBill: {} };
    var body = h('div', { 'class': 'pm-utr' });
    var errorBox = h('div', { 'class': 'pm-formerror', role: 'alert' });

    function paint() {
      ui.clear(body);
      if (form.mode === 'batch') {
        body.appendChild(ui.form.field({ label: 'UTR for the whole batch', required: true, hint: 'Letters and digits as shown by the bank portal. Every bill of the batch gets this reference.',
          control: ui.form.input({ value: form.utr, mono: true, maxLength: 24, placeholder: 'Bank reference', onInput: function (v) { form.utr = v; } }) }));
      } else {
        body.appendChild(h('div', { 'class': 'pm-utr__list' }, bills.map(function (b) {
          return h('div', { 'class': 'pm-utr__row' },
            h('div', { 'class': 'pm-cell2 pm-utr__who' }, h('span', { 'class': 'pm-cell2__top mk-strong', title: look.vendorName(b.vendorId) }, look.vendorName(b.vendorId)),
              h('span', { 'class': 'pm-cell2__sub' }, b.number + ' - ' + fmt.inrFull(b.payable))),
            ui.form.input({ value: form.byBill[b.id] || '', mono: true, maxLength: 24, placeholder: 'Bank reference', ariaLabel: 'UTR for ' + b.number, onInput: function (v) { form.byBill[b.id] = v; } }));
        })));
      }
    }

    function save() {
      ui.clear(errorBox);
      var res = W.batch.markPaid(batchId, form.mode === 'batch' ? { utr: form.utr } : { utrByBill: form.byBill });
      if (!res.ok) { errorBox.appendChild(ui.callout('critical', 'Nothing was recorded', res.error)); return; }
      m.close();
      env.st.tab = 'PAID';
      ui.toast(plural(res.record.billIds.length, 'bill') + ', ' + fmt.inrFull(res.record.total) + ' marked paid with ' + (form.mode === 'batch' ? 'one bank reference.' : 'a bank reference per bill.'),
        { title: res.record.number + ' is paid', tone: 'good' });
      if (live.ctx) live.ctx.rerender(); else if (live.drawer) live.drawer.refresh();
    }

    var m = ui.modal({
      title: 'Record bank references', subtitle: p.number + ' - ' + plural(bills.length, 'bill') + ' - ' + fmt.inrFull(p.total) + ' - ' + look.accountShort(p.bankAccountId), size: 'lg',
      body: wrap('pm-modal', [
        h('div', { 'class': 'pm-utr__head' },
          ui.segmented({ ariaLabel: 'How the bank paid', value: form.mode, onChange: function (v) { form.mode = v; ui.clear(errorBox); paint(); },
            options: [{ value: 'batch', label: 'One UTR for the batch' }, { value: 'bill', label: 'One UTR per bill' }] }),
          ui.button({ label: 'Fill sample references', variant: 'text', size: 'sm', title: 'Demo aid - in practice the references are copied from the bank portal',
            onClick: function () { form.utr = sampleUtr(p, 'batch', look); bills.forEach(function (b) { form.byBill[b.id] = sampleUtr(p, b.id, look); }); paint(); } })),
        body,
        h('p', { 'class': 'pm-note' }, ui.icon('info', 14), 'The references come from the bank portal after the upload is processed. Recording them closes the batch and marks its bills paid, with the release date as the payment date.'),
        errorBox
      ]),
      footer: [ui.button({ label: 'Cancel', variant: 'ghost', onClick: function () { m.close(); } }), ui.button({ label: 'Record and mark paid', variant: 'primary', icon: 'check', onClick: save })]
    });
    paint();
  }

  /* ------------------------------------------------------------------ batch drawer */

  function section(title, extra, children) {
    return h('section', { 'class': 'pm-sec' }, h('div', { 'class': 'pm-sec__head' }, h('h4', { 'class': 'mk-h3 pm-sec__title' }, title), extra || null), children);
  }

  function stageCallout(p, env, may) {
    var maker = userName(p.createdBy) + ' (' + userRole(p.createdBy) + ')';
    if (p.status === 'DRAFT') {
      return ui.callout('neutral', 'Draft - not yet with the director', 'Built by ' + maker + '. The bills are reserved for this batch but stay Approved until it is submitted. ' +
        (may.submit.ok ? 'You can still add or remove bills.' : 'Only the payer can change or submit it: ' + may.submit.reason + '.'));
    }
    if (p.status === 'PENDING_RELEASE') {
      return may.release.ok
        ? ui.callout('info', 'Second approval is yours', 'Built and submitted by ' + maker + '. You did not create this batch, so you may release or reject it. The kernel refuses a release by whoever created or submitted a batch.')
        : ui.callout('warn', 'Waiting for the director', 'Built and submitted by ' + maker + '. Release is blocked for you: ' + may.release.reason + '.');
    }
    if (p.status === 'RELEASED') {
      return ui.callout('info', 'Released - pay it in the bank portal', 'Released by ' + userName(p.releasedBy) + ' (' + userRole(p.releasedBy) + ') on ' + ui.dateTime(p.releasedAt) +
        '. The payer uploads the CSV in the bank portal and records the bank references here. ' + (may.markPaid.ok ? '' : 'Recording is blocked for you: ' + may.markPaid.reason + '.'));
    }
    if (p.status === 'REJECTED') {
      return ui.callout('critical', 'Rejected by ' + userName(p.rejectedBy) + ' on ' + ui.dateTime(p.rejectedAt), [h('span', null, p.rejectionReason || ''),
        h('span', { 'class': 'pm-callout__after' }, ' The bills went back to Approved and can be put into another batch.')]);
    }
    return ui.callout('good', 'Paid and closed', 'Bank references recorded by ' + userName(p.paidBy) + ' on ' + ui.dateTime(p.paidAt) + (p.utr ? ' - one UTR for the batch.' : ' - one UTR per bill.'));
  }

  function totalsTable(rows, firstLabel) {
    return ui.table({ dense: true, rows: rows, sortable: false,
      columns: [{ key: 'label', label: firstLabel, maxWidth: 230, render: function (v, row) { return row.node || v; } }, { key: 'bills', label: 'Bills', format: 'num', width: 56 },
        { key: 'amount', label: 'Payable', format: 'inrFull', render: ui.cells.bar(null, '--series-1', { format: 'inrFull' }), width: 200 }],
      footer: rows.length > 1 ? { label: 'Batch total', bills: sum(rows, 'bills'), amount: sum(rows, 'amount') } : null });
  }

  function drawerBody(p, bills, env, may, state) {
    var look = env.look, W = MK.workflow, editable = p.status === 'DRAFT';
    var target = look.targetOf(p.bankAccountId);

    var summary = ui.keyValue([
      ['Batch total', h('strong', { 'class': 'mk-num' }, fmt.inrFull(p.total))],
      ['Bills', fmt.num(p.billIds.length) + ' - ' + p.unitIds.map(look.unitShort).join(', ')],
      ['Paid from (masked)', h('span', null, h('span', { 'class': 'mk-num' }, look.accountShort(p.bankAccountId)), h('span', { 'class': 'pm-kvsub' }, look.accountPurpose(p.bankAccountId) +
        (target && target.id !== p.bankAccountId ? ' - becomes the "' + target.name + '" in the proposed structure' : '')))],
      ['Created', userName(p.createdBy) + ', ' + ui.dateTime(p.createdAt)],
      p.submittedAt ? ['Submitted', userName(p.submittedBy) + ', ' + ui.dateTime(p.submittedAt)] : null,
      p.releasedAt ? ['Released', userName(p.releasedBy) + ', ' + ui.dateTime(p.releasedAt)] : null,
      p.paidAt ? ['Paid', userName(p.paidBy) + ', ' + ui.dateTime(p.paidAt)] : null,
      p.paidAt ? ['Bank reference', p.utr ? h('span', { 'class': 'pm-mono' }, p.utr) : 'One per bill - see the bill lines'] : null
    ].filter(Boolean));

    /* bill lines */
    var lineCols = [
      { key: 'vendorName', label: 'Vendor / bill', render: function (v, row) {
        return h('div', { 'class': 'pm-cell2 pm-clip pm-clip--drawer' }, h('span', { 'class': 'pm-cell2__top mk-strong', title: v }, v),
          h('span', { 'class': 'pm-cell2__sub' }, ui.link(row.number, MK.router.href('approvals-bills', { id: row.id }), { title: 'Open the bill' }), h('span', { title: row.invoiceNo }, ' - ' + row.invoiceNo))); } },
      { key: 'unitId', label: 'Unit', render: function (v) { return unitTag(look, v); } },
      { key: 'dueDate', label: 'Due', render: function (v, row) {
        if (row.bill.status === 'PAID') {
          var lateBy = row.bill.paidOn && v ? D.diffDays(v, row.bill.paidOn) : 0;
          return h('div', { 'class': 'pm-cell2' }, h('span', { 'class': 'mk-num' }, day(v, 'd MMM')),
            lateBy > 0 ? h('span', { 'class': 'pm-late' }, ui.icon('alert-triangle', 12), 'Paid ' + plural(lateBy, 'day') + ' late') : h('span', { 'class': 'pm-cell2__sub' }, 'Paid ' + day(row.bill.paidOn, 'd MMM')));
        }
        if (p.status === 'RELEASED') return h('div', { 'class': 'pm-cell2' }, h('span', { 'class': 'mk-num' }, day(v, 'd MMM')), h('span', { 'class': 'pm-cell2__sub' }, 'With the bank'));
        return dueCell(v, dueOf(v, env.today));
      } },
      { key: 'payable', label: 'Payable', format: 'inrFull' },
      p.status === 'PAID' ? { key: 'utr', label: 'UTR', render: function (v) { return v ? h('span', { 'class': 'pm-mono' }, v) : '-'; } } : null,
      editable ? { key: 'rm', label: h('span', { 'class': 'mk-sr' }, 'Remove'), width: 40, render: function (v, row) {
        return ui.iconButton('x', 'Remove ' + row.number + ' from the batch', function () {
          var res = W.batch.removeBill(p.id, row.id);
          ui.toast(res.ok ? row.number + ' went back to the approved list.' : res.error, { title: res.ok ? 'Bill removed' : 'Not removed', tone: res.ok ? 'info' : 'critical' });
          if (res.ok) state.refresh();
        }, { size: 'sm', disabledReason: may.edit.ok ? '' : may.edit.reason });
      } } : null
    ];
    var lineRows = bills.map(function (b) {
      return { id: b.id, bill: b, number: b.number, invoiceNo: b.invoiceNo, vendorName: look.vendorName(b.vendorId), unitId: b.unitId, dueDate: b.dueDate, payable: b.payable, utr: b.utr };
    });
    var lines = ui.table({ dense: true, sortable: true, columns: lineCols, rows: lineRows, maxHeight: 320, sort: { key: 'payable', dir: 'desc' },
      footer: { vendorName: plural(lineRows.length, 'bill'), payable: sum(lineRows, 'payable') },
      empty: ui.emptyState('This batch has no bills', editable ? 'Add approved bills below, or leave the draft empty.' : null, { compact: true, icon: 'receipt' }) });

    /* add bills while draft */
    var adder = null;
    if (editable) {
      var candidates = env.eligible.filter(function (r) { return r.eligible; });
      var pick = ui.select({ ariaLabel: 'Approved bill to add', block: true, value: state.addId || '', placeholder: candidates.length ? 'Choose an approved bill, earliest due date first' : 'No approved bill is available',
        disabled: !candidates.length || !may.edit.ok,
        options: candidates.map(function (r) { return { value: r.id, label: day(r.dueDate, 'd MMM') + ' - ' + r.vendorName + ' - ' + look.unitShort(r.unitId) + ' - ' + fmt.inrFull(r.payable) + ' (' + r.number + ')' }; }),
        onChange: function (v) { state.addId = v; } });
      adder = h('div', { 'class': 'pm-adder' }, pick, ui.button({ label: 'Add to batch', icon: 'plus', disabledReason: may.edit.ok ? '' : may.edit.reason,
        onClick: function () {
          var id = pick.getValue();
          if (!id) { ui.toast('Choose an approved bill first.', { tone: 'warn' }); return; }
          var res = W.batch.addBill(p.id, id);
          ui.toast(res.ok ? 'The batch total is now ' + fmt.inrFull(res.record.total) + '.' : res.error, { title: res.ok ? 'Bill added' : 'Not added', tone: res.ok ? 'good' : 'critical' });
          if (res.ok) { state.addId = ''; state.refresh(); }
        } }));
    }

    /* totals */
    var byVendor = {}, byUnit = {};
    bills.forEach(function (b) {
      var v = byVendor[b.vendorId] || (byVendor[b.vendorId] = { label: look.vendorName(b.vendorId), bills: 0, amount: 0 });
      v.bills += 1; v.amount += b.payable;
      var u = byUnit[b.unitId] || (byUnit[b.unitId] = { label: look.unitName(b.unitId), node: unitTag(look, b.unitId), bills: 0, amount: 0 });
      u.bills += 1; u.amount += b.payable;
    });
    function sorted(map) { return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.amount - a.amount; }); }

    var trail = guard('audit.trail', function () { return MK.audit.toTimeline(MK.audit.trail('batch', p.id)); }, []).slice().reverse();

    return wrap('pm-drawer', [
      stageCallout(p, env, may),
      summary,
      section('Bills in this batch', h('span', { 'class': 'pm-sec__meta mk-num' }, fmt.inrFull(p.total)), [lines, adder]),
      bills.length ? section('Totals by vendor', h('span', { 'class': 'pm-sec__meta' }, plural(Object.keys(byVendor).length, 'vendor')), totalsTable(sorted(byVendor), 'Vendor')) : null,
      bills.length ? section('Totals by unit', h('span', { 'class': 'pm-sec__meta' }, plural(Object.keys(byUnit).length, 'unit')), totalsTable(sorted(byUnit), 'Unit')) : null,
      section('Timeline', null, ui.timeline(trail, { empty: 'No activity recorded for this batch' })),
      h('div', { 'class': 'pm-drawersrc' }, ui.sourceTag(['erp']))
    ]);
  }

  function drawerFooter(p, env, may, state) {
    var W = MK.workflow, buttons = [], reasons = [];
    function blocked(label, c) { if (!c.ok && c.reason) reasons.push(label + ': ' + c.reason); }

    /* a rejected batch has given its bills back to the approved queue: handing out a bank-upload sheet for it would
       invite a second payment, so the export is refused with the reason in the tooltip */
    var noCsv = p.status === 'REJECTED' ? 'This batch was rejected and its bills went back to Approved - export the batch that replaces it'
      : (p.billIds.length ? '' : errText('emptyBatch', 'A payment batch needs at least one bill'));
    buttons.push(h('span', { 'class': 'pm-foot__left' }, ui.button({ label: 'Export CSV', icon: 'download', title: 'Bank-upload sheet, one row per bill (account numbers stay masked)',
      disabledReason: noCsv,
      onClick: function () {
        var csv = guard('batch.toCsv', function () { return W.batch.toCsv(p.id); }, null);
        if (!csv || !csv.ok) { ui.toast((csv && csv.error) || 'The batch could not be exported.', { tone: 'critical' }); return; }
        ui.downloadCsv(csv.filename, csv.columns, csv.rows);
        ui.toast(plural(csv.count, 'row') + ', ' + fmt.inrFull(csv.total) + ' - upload it in the bank portal.', { title: csv.filename, tone: 'info' });
      } })));

    if (p.status === 'DRAFT') {
      blocked('Submit', may.submit);
      buttons.push(ui.button({ label: 'Submit for release', variant: 'primary', icon: 'arrow-right', disabledReason: may.submit.ok ? '' : may.submit.reason,
        onClick: function () {
          var res = W.batch.submit(p.id);
          ui.toast(res.ok ? 'It now waits for the director\'s release.' : res.error, { title: res.ok ? p.number + ' submitted for release' : 'Not submitted', tone: res.ok ? 'good' : 'critical' });
          if (res.ok) { env.st.tab = 'PENDING_RELEASE'; state.refresh(); }
        } }));
    } else if (p.status === 'PENDING_RELEASE') {
      blocked('Release', may.release);
      if (may.reject.reason !== may.release.reason) blocked('Reject', may.reject);
      buttons.push(ui.button({ label: 'Reject', variant: 'danger', disabledReason: may.reject.ok ? '' : may.reject.reason,
        onClick: function () {
          ui.confirm({ title: 'Reject ' + p.number + '?', message: 'The ' + plural(p.billIds.length, 'bill') + ' go back to Approved and the payer can put them into another batch. The reason is kept on the audit trail.',
            confirmLabel: 'Reject batch', tone: 'danger', requireReason: true, reasonLabel: 'Reason for rejection' }).then(function (ans) {
            if (!ans.ok) return;
            var res = W.batch.reject(p.id, ans.reason);
            ui.toast(res.ok ? ans.reason : res.error, { title: res.ok ? p.number + ' rejected' : 'Not rejected', tone: res.ok ? 'warn' : 'critical' });
            if (res.ok) { env.st.tab = 'REJECTED'; state.refresh(); }
          });
        } }));
      buttons.push(ui.button({ label: 'Release ' + fmt.inr(p.total), variant: 'primary', icon: 'check', disabledReason: may.release.ok ? '' : may.release.reason,
        onClick: function () {
          ui.confirm({ title: 'Release ' + p.number + '?', message: plural(p.billIds.length, 'bill') + ', ' + fmt.inrFull(p.total) + ' from ' + env.look.accountShort(p.bankAccountId) +
            '. Your release is the approval to pay; the payer then makes the payment in the bank portal.', confirmLabel: 'Release batch' }).then(function (ans) {
            if (!ans.ok) return;
            var res = W.batch.release(p.id);
            ui.toast(res.ok ? 'The payer can now pay it in the bank portal and record the bank references.' : res.error, { title: res.ok ? p.number + ' released' : 'Not released', tone: res.ok ? 'good' : 'critical' });
            if (res.ok) { env.st.tab = 'RELEASED'; state.refresh(); }
          });
        } }));
    } else if (p.status === 'RELEASED') {
      blocked('Record UTRs', may.markPaid);
      buttons.push(ui.button({ label: 'Record UTRs', variant: 'primary', icon: 'edit', disabledReason: may.markPaid.ok ? '' : may.markPaid.reason, onClick: function () { openUtr(p.id); } }));
    }

    return wrap('pm-foot', [
      reasons.length ? h('p', { 'class': 'pm-foot__why' }, ui.icon('lock', 14), reasons.join(' - ')) : null,
      h('div', { 'class': 'pm-foot__row' }, buttons)
    ]);
  }

  function openBatch(id, opts) {
    opts = opts || {};
    if (live.drawer) { live.drawer.show(id, opts.linked || null); return; }
    var state = { id: id, addId: '', linked: opts.linked || null };
    var chip = h('span', { 'class': PAGE_CLASS + ' pm-headchip' });

    var d = ui.drawer({ title: id, width: 560, headerExtra: chip, body: null, footer: null, onClose: function () {
      live.drawer = null;
      if (state.linked && live.ctx) {
        var cur = MK.router.current();
        if (cur && cur.page && cur.page.id === PAGE_ID && cur.params && cur.params.id === state.linked) live.ctx.navigate(PAGE_ID, null, { replace: true });
      }
    } });

    function refresh() {
      var env = live.env, W = MK.workflow; if (!env) return;
      var p = guard('batch.get', function () { return W.batch.get(state.id); }, null);
      ui.clear(chip);
      if (!p) {
        d.setTitle(state.id, null);
        d.setBody(wrap('pm-drawer', ui.emptyState('This batch is not visible to you', 'A batch is visible only when every bill in it belongs to a unit in your scope (' +
          MK.session.allowedUnitIds().map(env.look.unitName).join(', ') + '), or the number does not exist.', { icon: 'lock' })));
        d.setFooter(null);
        return;
      }
      var may = {};
      ['edit', 'submit', 'release', 'reject', 'markPaid'].forEach(function (a) { may[a] = guard('batch.can ' + a, function () { return W.batch.can(a, p); }, { ok: false, reason: '' }); });
      var bills = guard('batch.bills', function () { return W.batch.bills(p.id); }, []);
      chip.appendChild(ui.statusChip(p.status));
      d.setTitle(p.number, plural(p.billIds.length, 'bill') + ' - ' + fmt.inrFull(p.total) + ' - ' + env.look.accountShort(p.bankAccountId));
      d.setBody(drawerBody(p, bills, env, may, state));
      d.setFooter(drawerFooter(p, env, may, state));
    }

    /* after an action: repaint the drawer now and the page underneath (the router would also do it on store:changed) */
    state.refresh = function () { if (live.ctx) live.ctx.rerender(); else refresh(); };
    live.drawer = { show: function (next, linked) { state.id = next; state.addId = ''; state.linked = linked || null; refresh(); }, refresh: refresh, close: function () { d.close(); } };
    refresh();
  }

  /* ------------------------------------------------------------------ render */

  function render(rootEl, ctx) {
    var st = ctx.state;
    var env = buildEnv(ctx);
    normaliseState(st, env);
    live.ctx = ctx; live.env = env;

    /* deep link: #/approvals/payments?id=PB-... shows the batch's tab and opens its drawer, once per id */
    var wanted = (ctx.params && ctx.params.id) || null, openLinked = false;
    if (wanted && st.linked !== wanted) {
      st.linked = wanted; openLinked = true;
      var found = guard('batch.get', function () { return MK.workflow.batch.get(wanted); }, null);
      if (found) st.tab = found.status;
    }
    if (!wanted) st.linked = null;

    rootEl.appendChild(intro(env));
    rootEl.appendChild(h('div', { 'class': 'pm-kpis' }, kpis(env).map(function (t) { return ui.statTile(t); })));
    rootEl.appendChild(h('div', { 'class': 'pm-work' }, approvedCard(env), h('div', { 'class': 'pm-side' }, queueCard(env), windowsChart(env))));
    rootEl.appendChild(batchesCard(env));
    var weekly = weeklyChart(env);
    if (weekly) rootEl.appendChild(weekly);

    /* overlays outlive a re-render: bring an open drawer up to date (store change, persona change) */
    if (live.drawer) live.drawer.refresh();

    if (openLinked) openBatch(wanted, { linked: wanted });

    return function cleanup() { live.ctx = null; };
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/approvals/payments',
    group: 'Approvals',
    title: 'Payment batches',
    subtitle: 'Build, release and settle payment batches',
    units: 'all',
    roles: null,
    filters: [],
    render: render
  });
})(window);
