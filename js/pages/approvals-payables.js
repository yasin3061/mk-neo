/*
 * Approvals / Payables (#/approvals/payables) - what the company owes today and what is about to slip past credit terms.
 *
 * Blocks: purpose line -> KPI row (total payable, due in seven days, overdue, vendors with overdue, released to the bank)
 * -> ageing buckets bar next to the "Due this week / Overdue" list -> ageing by vendor or by unit with inline bars
 * -> payment discipline (paid on time against paid late, by month, and the vendors whose bills slipped) -> vendor drawer
 * with the open bills behind a balance.
 *
 * Every figure comes from MK.finance.payables(MK.calendar.today), MK.workflow.bill / batch / vendor and MK.config, and is
 * formatted with MK.fmt. Scope is the data layer's job: payables(), bill.list() and vendor.list() are already narrowed to
 * the persona, so every persona gets the same screen over its own material (the factory manager sees the factory balance,
 * the Bandra manager the Bandra balance) and an empty scope falls back to an empty state. The screen is read-only - there
 * is no action to segregate here; the maker-checker actions live on Bills and Payment batches, which this page links to.
 *
 * Page-local state (ctx.state): userId, dueTab, group, sortDue, sortAge, sortLate, linked.
 * The vendor drawer lives outside the page root; its content sits in a wrapper carrying the page class so the page
 * stylesheet applies. The module keeps one `live` object so an open drawer always talks to the latest render.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates;

  var PAGE_ID = 'approvals-payables';
  var PAGE_CLASS = 'pg-approvals-payables';
  var OPEN_STATES = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'IN_BATCH'];
  var DUE_SOON_DAYS = 7;
  /* short axis labels for the ageing chart; the full label of the data layer is the tooltip of the chart and of the column */
  var SHORT_BUCKET = {
    not_due: 'Not due', d1_7: '1-7 days', d8_30: '8-30 days', d31_60: '31-60 days',
    d60_plus: '60+ days', in_transit: 'With the bank'
  };
  /* the ageing table puts ten columns in one content column: its headers are shorter still, with the full label on hover */
  var COL_BUCKET = {
    not_due: 'Not due', d1_7: '1-7', d8_30: '8-30', d31_60: '31-60', d60_plus: '60+', in_transit: 'With bank'
  };
  var LATE_ROWS = 60;

  var live = { ctx: null, env: null, drawer: null };

  /* ------------------------------------------------------------------ helpers */

  function guard(name, fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; }
    catch (e) { if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e); return fallback; }
  }
  function has(list, x) { return !!list && list.indexOf(x) !== -1; }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function day(iso, style) { return iso ? D.label(String(iso).slice(0, 10), style || 'd MMM yyyy') : '-'; }
  function sum(list, key) { return list.reduce(function (t, x) { return t + (x[key] || 0); }, 0); }
  function wrap(cls, children) { return h('div', { 'class': PAGE_CLASS + ' ' + cls }, children); }
  function share(part, whole) { return whole > 0 ? fmt.pct(part / whole, 1) : fmt.pct(0, 1); }
  function dash() { return h('span', { 'class': 'mk-faint' }, '-'); }
  /* an empty bucket reads as a dash: a wall of zeroes hides the buckets that carry something */
  function money(v) { return v ? h('span', { 'class': 'mk-num' }, fmt.inr(v)) : dash(); }

  /* days between the due date and today: positive = past due, negative = still to come */
  function daysPast(dueDate, today) { return dueDate ? D.diffDays(dueDate, today) : null; }

  function dueLabel(dueDate, today) {
    var n = daysPast(dueDate, today);
    if (n === null) return '';
    if (n > 0) return 'Overdue ' + plural(n, 'day');
    if (n === 0) return 'Due today';
    if (n === -1) return 'Due tomorrow';
    return 'Due in ' + plural(-n, 'day');
  }

  /*
   * The due date of one bill. A bill whose batch the director has already released has left the bank: the data layer
   * keeps it out of overdue and out of dueIn7Days, so the cell must not call it late either - it says "With the bank".
   * Amber is reserved for the seven-day window; a date further out stays in the muted ink, or every open bill reads urgent.
   */
  function dueCell(dueDate, today, inTransit) {
    var n = daysPast(dueDate, today);
    if (inTransit) {
      return h('div', { 'class': 'py-cell2' }, h('span', { 'class': 'mk-num' }, day(dueDate, 'd MMM')),
        h('span', { 'class': 'py-cell2__sub' }, 'With the bank'));
    }
    var text = dueLabel(dueDate, today);
    var cls = n > 0 ? 'py-late' : (n !== null && n >= -DUE_SOON_DAYS ? 'py-soon' : 'py-cell2__sub');
    return h('div', { 'class': 'py-cell2' },
      h('span', { 'class': 'mk-num' }, day(dueDate, 'd MMM')),
      text ? h('span', { 'class': cls }, n > 0 ? ui.icon('alert-triangle', 12) : null, text) : null);
  }

  /*
   * Oldest due date of a vendor or a unit. The data layer counts every open bill, bills already released to the bank
   * included, so a date in the past on a row with nothing overdue belongs to a bill that has left the bank - say that
   * rather than call it late and contradict the ageing buckets of the same row.
   */
  function oldestCell(dueDate, hasOverdue, today) {
    if (!dueDate) return dash();
    var n = daysPast(dueDate, today), late = n > 0 && hasOverdue, text;
    if (n > 0 && !hasOverdue) text = 'With the bank';   /* nothing overdue on this row: the older bill has left the bank */
    else if (n > 0) text = plural(n, 'day') + ' late';
    else if (n === 0) text = 'Due today';
    else text = 'in ' + plural(-n, 'day');
    return h('div', { 'class': 'py-cell2' }, h('span', { 'class': 'mk-num' }, day(dueDate, 'd MMM')),
      h('span', { 'class': late ? 'py-late' : 'py-cell2__sub' }, late ? ui.icon('alert-triangle', 12) : null, text));
  }

  function lookups() {
    var units = {}, vendors = {}, names = {};
    ((MK.config && MK.config.outlets) || []).forEach(function (u) { units[u.id] = u; });
    guard('vendor.list', function () { return MK.workflow.vendor.list(); }, []).forEach(function (v) { vendors[v.id] = v; });
    return {
      units: units, vendors: vendors,
      unitName: function (id) { return units[id] ? units[id].name : (id || '-'); },
      unitShort: function (id) { return units[id] ? (units[id].short || units[id].name) : (id || '-'); },
      unitColour: function (id) { return units[id] ? units[id].colourVar : null; },
      vendor: function (id) { return vendors[id] || null; },
      vendorName: function (id) {
        if (vendors[id]) return vendors[id].name;
        if (!Object.prototype.hasOwnProperty.call(names, id)) names[id] = guard('vendor.nameOf', function () { return MK.workflow.vendor.nameOf(id); }, id || '-');
        return names[id];
      },
      /* credit days come from the vendor master; never invented when the record is out of reach */
      creditDays: function (id) { var v = vendors[id]; return v && typeof v.creditDays === 'number' ? v.creditDays : null; }
    };
  }

  function dot(colourVar) {
    return h('span', { 'class': 'py-dot', 'aria-hidden': 'true', style: colourVar ? { background: 'var(' + colourVar + ')' } : null });
  }
  function unitTag(look, unitId) {
    return h('span', { 'class': 'py-unit', title: look.unitName(unitId) }, dot(look.unitColour(unitId)), look.unitShort(unitId));
  }

  function billHref(id) { return MK.router.href('approvals-bills', { id: id }); }

  /* ------------------------------------------------------------------ per-render environment */

  function buildEnv(ctx) {
    var W = MK.workflow;
    var env = { ctx: ctx, st: ctx.state, user: ctx.user || MK.session.current(), today: MK.calendar.today, look: lookups() };
    env.p = guard('finance.payables', function () { return MK.finance.payables(env.today); }, null) || emptyPayables(env.today);
    env.buckets = env.p.buckets || [];
    env.open = guard('bill.list open', function () { return W.bill.list({ status: OPEN_STATES }); }, []);
    env.paid = guard('bill.list paid', function () { return W.bill.list({ status: 'PAID' }); }, []);

    /* a bill of a RELEASED batch has left the bank: the data layer reports it as in transit, never as overdue. The batch
       is readable only when every unit in it is in scope, so this map may be incomplete for a single-unit persona. */
    env.released = {};
    guard('batch.list released', function () { return W.batch.list({ status: 'RELEASED' }); }, []).forEach(function (b) { env.released[b.id] = b; });
    env.inTransitBill = function (b) { return !!(b.batchId && env.released[b.batchId]); };

    env.overdueRows = env.open.filter(function (b) {
      return b.dueDate && daysPast(b.dueDate, env.today) > 0 && !env.inTransitBill(b);
    }).sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : (a.dueDate > b.dueDate ? 1 : 0); });
    env.oldestOverdue = env.overdueRows.length ? daysPast(env.overdueRows[0].dueDate, env.today) : null;
    /* the derived list and the data layer agree whenever every payment batch is visible; say so when they cannot */
    env.overdueHidden = Math.max(0, (env.p.overdue.count || 0) - env.overdueRows.length);

    env.vendorsOverdue = (env.p.byVendor || []).filter(function (v) { return v.overdue > 0; });
    env.discipline = discipline(env.paid);
    return env;
  }

  function emptyPayables(today) {
    return { asOf: today, total: 0, approved: 0, awaitingApproval: 0, count: 0, overdue: { amount: 0, count: 0 },
      dueIn7Days: { amount: 0, count: 0, bills: [] }, inTransit: { amount: 0, count: 0 }, buckets: [], byVendor: [], byUnit: [] };
  }

  /* on time against late, by payment month and by vendor - the payment date is the release of the batch (bill.paidOn) */
  function discipline(paid) {
    var months = {}, vendors = {}, order = [];
    paid.forEach(function (b) {
      if (!b.paidOn) return;
      var key = b.paidOn.slice(0, 7);
      var m = months[key] || (months[key] = { key: key, onTime: 0, late: 0, count: 0, lateCount: 0, days: 0 });
      var v = vendors[b.vendorId] || (vendors[b.vendorId] = { vendorId: b.vendorId, paid: 0, paidValue: 0, lateCount: 0, lateValue: 0, days: 0, lastLate: null });
      if (!months[key].seen) { months[key].seen = true; order.push(key); }
      var late = !!(b.dueDate && b.paidOn > b.dueDate), by = late ? D.diffDays(b.dueDate, b.paidOn) : 0;
      m.count += 1; v.paid += 1; v.paidValue += b.payable || 0;
      if (late) {
        m.late += b.payable || 0; m.lateCount += 1; m.days += by;
        v.lateCount += 1; v.lateValue += b.payable || 0; v.days += by;
        if (!v.lastLate || b.paidOn > v.lastLate) v.lastLate = b.paidOn;
      } else {
        m.onTime += b.payable || 0;
      }
    });
    order.sort();
    var rows = order.map(function (k) { return months[k]; });
    var totals = rows.reduce(function (t, m) {
      t.onTime += m.onTime; t.late += m.late; t.count += m.count; t.lateCount += m.lateCount; t.days += m.days; return t;
    }, { onTime: 0, late: 0, count: 0, lateCount: 0, days: 0 });
    return {
      months: rows, totals: totals, latest: rows.length ? rows[rows.length - 1] : null,
      vendors: Object.keys(vendors).map(function (k) { return vendors[k]; }).filter(function (v) { return v.lateCount > 0; })
        .sort(function (a, b) { return b.lateValue - a.lateValue; })
    };
  }

  function normaliseState(st, env) {
    if (st.userId !== env.user.id) { st.userId = env.user.id; st.dueTab = null; st.group = null; }
    if (!has(['soon', 'overdue'], st.dueTab)) st.dueTab = env.overdueRows.length ? 'overdue' : 'soon';
    if (!has(['vendor', 'unit'], st.group)) st.group = 'vendor';
  }

  /* ------------------------------------------------------------------ intro */

  function intro(env) {
    var p = env.p;
    return h('div', { 'class': 'py-intro' },
      h('p', { 'class': 'py-intro__text' },
        'What the company owes on the bills that are open right now, aged against the due date each vendor\'s credit terms set. ',
        h('span', { 'class': 'py-intro__who' }, p.count
          ? 'Balance as at ' + day(p.asOf) + ', over ' + plural(p.count, 'open bill') + ' in your scope.'
          : 'No bill in your scope is open as at ' + day(p.asOf) + '.')),
      h('p', { 'class': 'py-intro__note' }, ui.icon('info', 14),
        'A bill counts as payable from the moment it is entered and leaves this balance when the bank reference is recorded. ' +
        'Bills of a batch the director has already released sit under "Released to the bank": the money has gone out, so they are neither due nor overdue.'));
  }

  /* ------------------------------------------------------------------ KPI row */

  function kpis(env) {
    var p = env.p, look = env.look;
    var soon = p.dueIn7Days, biggest = env.vendorsOverdue.length ? env.vendorsOverdue[0] : null;
    var withBalance = (p.byVendor || []).length;
    var firstDue = soon.bills && soon.bills.length ? soon.bills[0].dueDate : null;

    function goDue(tab) {
      return function () {
        env.st.dueTab = tab; env.ctx.rerender();
        var el = root.document.getElementById('py-due');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      };
    }

    return [
      { label: 'Total payable', icon: 'wallet', value: fmt.inr(p.total),
        sub: p.count
          ? plural(p.count, 'open bill') + ' - ' + fmt.inr(p.approved) + ' approved for payment' +
            (p.awaitingApproval ? ', ' + fmt.inr(p.awaitingApproval) + ' still with the checker' : ', nothing left with the checker')
          : 'No open bill in your scope',
        title: 'Bills entered and not yet paid: submitted, under review, approved and in a payment batch' },
      { label: 'Due within ' + plural(DUE_SOON_DAYS, 'day'), icon: 'clock', value: fmt.inr(soon.amount),
        sub: soon.count ? plural(soon.count, 'bill') + (firstDue ? ', the first on ' + day(firstDue, 'd MMM') : '') + ' - ' + share(soon.amount, p.total) + ' of the balance'
          : 'Nothing falls due in the next ' + plural(DUE_SOON_DAYS, 'day'),
        title: 'Open bills whose due date falls between today and ' + day(D.addDays(p.asOf, DUE_SOON_DAYS)) + ', excluding bills already released to the bank',
        onClick: goDue('soon') },
      { label: 'Overdue', icon: 'alert-triangle', value: fmt.inr(p.overdue.amount), tone: p.overdue.count ? 'critical' : 'good',
        sub: p.overdue.count
          ? plural(p.overdue.count, 'bill') + ' past the due date' + (env.oldestOverdue ? ', the oldest by ' + plural(env.oldestOverdue, 'day') : '') + ' - ' + share(p.overdue.amount, p.total) + ' of the balance'
          : 'Every open bill is inside its credit terms',
        title: 'Open bills whose due date has passed. A bill of a released batch is reported as in transit instead',
        onClick: goDue('overdue') },
      { label: 'Vendors with overdue', icon: 'users', value: fmt.num(env.vendorsOverdue.length), tone: env.vendorsOverdue.length ? 'warn' : null,
        sub: biggest
          ? look.vendorName(biggest.vendorId) + ' is the largest at ' + fmt.inr(biggest.overdue) + ' - of ' + plural(withBalance, 'vendor') + ' with an open balance'
          : (withBalance ? 'None of the ' + plural(withBalance, 'vendor') + ' with an open balance is past its terms' : 'No vendor carries an open balance'),
        title: 'Vendors carrying at least one bill past its due date' },
      { label: 'Released to the bank', icon: 'bank', value: fmt.inr(p.inTransit.amount),
        sub: p.inTransit.count
          ? plural(p.inTransit.count, 'bill') + ' paid in the bank portal, bank reference awaited - neither due nor overdue'
          : 'Every released batch has its bank reference',
        title: 'Bills of a payment batch the director has released; the payer has still to record the UTR',
        onClick: function () { env.ctx.navigate('approvals-payments'); } }
    ];
  }

  /* ------------------------------------------------------------------ ageing chart */

  function ageingChart(env) {
    var p = env.p, buckets = env.buckets;
    var labels = buckets.map(function (b) { return SHORT_BUCKET[b.id] || b.label; });
    var values = buckets.map(function (b) { return b.amount; });
    var overdueBuckets = buckets.filter(function (b) { return b.id !== 'not_due' && b.id !== 'in_transit'; });
    var worst = overdueBuckets.reduce(function (m, b) { return !m || b.amount > m.amount ? b : m; }, null);

    var subtitle;
    if (!p.total) {
      subtitle = 'No open bill in your scope';
    } else if (p.overdue.amount > 0) {
      subtitle = fmt.inr(p.overdue.amount) + ' of ' + fmt.inr(p.total) + ' (' + share(p.overdue.amount, p.total) + ') has passed its due date' +
        (worst && worst.amount > 0 ? ', the largest block ' + (SHORT_BUCKET[worst.id] || worst.label).toLowerCase() + ' past due at ' + fmt.inr(worst.amount) +
          ' over ' + plural(worst.count, 'bill') : '') +
        '; ' + fmt.inr(p.dueIn7Days.amount) + ' more falls due within ' + plural(DUE_SOON_DAYS, 'day');
    } else {
      subtitle = 'Nothing has passed its due date: ' + fmt.inr(p.dueIn7Days.amount) + ' of ' + fmt.inr(p.total) + ' (' + share(p.dueIn7Days.amount, p.total) +
        ') falls due within ' + plural(DUE_SOON_DAYS, 'day') + ', the rest later' +
        (p.inTransit.amount ? '; ' + fmt.inr(p.inTransit.amount) + ' is with the bank awaiting a reference' : '');
    }

    /* horizontal: the bucket names read straight, and the card survives the narrow half-column at 1280px */
    var c = MK.charts.mount(null, {
      id: 'py-ageing', kind: 'hbar', title: 'Payables ageing', subtitle: subtitle, height: 240, format: 'inr',
      data: { categories: labels, values: values, name: 'Payable', categoryHeader: 'Ageing bucket' },
      table: {
        columns: [{ key: 'bucket', label: 'Ageing bucket' }, { key: 'bills', label: 'Bills', format: 'num', align: 'right' },
          { key: 'amount', label: 'Payable', format: 'inrFull', align: 'right' }, { key: 'sharePct', label: 'Share', format: 'pct', align: 'right' }],
        rows: buckets.map(function (b) { return { bucket: b.label, bills: b.count, amount: b.amount, sharePct: p.total > 0 ? b.amount / p.total : 0 }; })
      },
      note: 'Days counted from the due date, which is the invoice date plus the vendor\'s credit days. "With the bank" holds the bills of a released batch, awaiting their reference.',
      emptyText: 'No open bill in your scope'
    });
    c.el.appendChild(h('div', { 'class': 'py-chartsrc' }, ui.sourceTag(['erp'])));
    return c.el;
  }

  /* ------------------------------------------------------------------ due this week / overdue */

  function dueCard(env) {
    var st = env.st, look = env.look, p = env.p;
    var holder = h('div');

    function rowsFor(tab) {
      if (tab === 'overdue') {
        return env.overdueRows.map(function (b) {
          return { id: b.id, number: b.number, vendorId: b.vendorId, vendorName: look.vendorName(b.vendorId), unitId: b.unitId,
            dueDate: b.dueDate, amount: b.payable || 0, status: b.status, days: daysPast(b.dueDate, env.today) };
        });
      }
      return (p.dueIn7Days.bills || []).map(function (b) {
        return { id: b.id, number: b.id, vendorId: b.vendorId, vendorName: look.vendorName(b.vendorId), unitId: b.unitId,
          dueDate: b.dueDate, amount: b.amount || 0, status: b.status, days: daysPast(b.dueDate, env.today) };
      });
    }

    function paint() {
      var rows = rowsFor(st.dueTab);
      /* a half-width card: the unit travels on the second line of the vendor cell rather than in a column of its own */
      var columns = [
        { key: 'dueDate', label: 'Due', width: 88, render: function (v) { return dueCell(v, env.today); } },
        { key: 'vendorName', label: 'Vendor / bill', render: function (v, row) {
          return h('div', { 'class': 'py-cell2 py-clip py-clip--half' },
            h('span', { 'class': 'py-cell2__top mk-strong', title: v }, h('span', null, v)),
            h('span', { 'class': 'py-cell2__sub' }, ui.link(row.number, billHref(row.id), { title: 'Open the bill' }),
              h('span', { 'class': 'py-cell2__unit' }, unitTag(look, row.unitId))));
        } },
        { key: 'status', label: 'Status', width: 116, render: ui.cells.status() },
        { key: 'amount', label: 'Payable', format: 'inrFull', width: 92 }
      ];
      ui.clear(holder);
      holder.appendChild(ui.table({
        columns: columns, rows: rows, dense: true, sortable: true, maxHeight: 316,
        sort: st.sortDue || { key: 'dueDate', dir: 'asc' }, onSort: function (s) { st.sortDue = s; },
        rowClass: function (row) { return row.days > 0 ? 'is-strong' : ''; },
        onRowClick: function (row) { env.ctx.navigate('approvals-bills', { id: row.id }); },
        footer: rows.length ? { vendorName: plural(rows.length, 'bill'), amount: sum(rows, 'amount') } : null,
        empty: st.dueTab === 'overdue'
          ? ui.emptyState('Nothing is past its due date', 'Every open bill in your scope is still inside the credit terms of its vendor.', { compact: true, icon: 'check-circle' })
          : ui.emptyState('Nothing falls due in the next ' + plural(DUE_SOON_DAYS, 'day'),
            p.total ? 'The open balance falls due later. The ageing chart shows when.' : 'There is no open bill in your scope.', { compact: true, icon: 'calendar' })
      }));
    }

    var tabs = ui.tabs({ ariaLabel: 'Due window', value: st.dueTab, onChange: function (id) { st.dueTab = id; paint(); },
      items: [{ id: 'overdue', label: 'Overdue', count: env.overdueRows.length }, { id: 'soon', label: 'Due within ' + plural(DUE_SOON_DAYS, 'day'), count: p.dueIn7Days.count }] });

    var note = env.overdueHidden
      ? h('p', { 'class': 'py-listnote' }, ui.icon('lock', 13),
        plural(env.overdueHidden, 'overdue bill') + ' of the ' + fmt.inr(p.overdue.amount) + ' above sits in a payment batch that mixes units outside your scope, so it is not listed here.')
      : null;

    var card = ui.card({
      id: 'py-due', title: 'Due this week and overdue', flush: true,
      subtitle: p.overdue.count
        ? fmt.inr(p.overdue.amount) + ' is already overdue and ' + fmt.inr(p.dueIn7Days.amount) + ' falls due within ' + plural(DUE_SOON_DAYS, 'day') + ' - open a row for the bill'
        : fmt.inr(p.dueIn7Days.amount) + ' falls due within ' + plural(DUE_SOON_DAYS, 'day') + ', nothing is overdue - open a row for the bill',
      body: [h('div', { 'class': 'py-toolbar' }, tabs), holder, note],
      footer: ui.sourceTag(['erp'])
    });
    paint();
    return card;
  }

  /* ------------------------------------------------------------------ ageing by vendor / by unit */

  function ageingTable(env) {
    var st = env.st, look = env.look, p = env.p, buckets = env.buckets;
    var holder = h('div');

    function vendorRows() {
      return (p.byVendor || []).map(function (v) {
        var row = { key: v.vendorId, id: v.vendorId, kind: 'vendor', name: v.name, total: v.total, count: v.count,
          overdue: v.overdue, oldestDueDate: v.oldestDueDate, creditDays: look.creditDays(v.vendorId), sub: null };
        var rec = look.vendor(v.vendorId);
        row.sub = [rec && rec.category, row.creditDays === null ? null : 'credit ' + plural(row.creditDays, 'day')].filter(Boolean).join(' - ');
        buckets.forEach(function (b, i) { row['b' + i] = (v.buckets && v.buckets[i]) || 0; });
        return row;
      });
    }

    /* the data layer gives no oldest due date per unit: take it from the open bills of that unit, the same way it does
       for a vendor - every open bill counts, including those already released to the bank */
    function unitOldest(unitId) {
      var best = null;
      env.open.forEach(function (b) { if (b.unitId === unitId && b.dueDate && (!best || b.dueDate < best)) best = b.dueDate; });
      return best;
    }

    function unitRows() {
      return (p.byUnit || []).map(function (u) {
        var row = { key: u.unitId, id: u.unitId, kind: 'unit', name: u.label, total: u.total, count: u.count,
          overdue: u.overdue, oldestDueDate: unitOldest(u.unitId), creditDays: null, sub: null };
        buckets.forEach(function (b, i) { row['b' + i] = (u.buckets && u.buckets[i]) || 0; });
        return row;
      });
    }

    function paint() {
      var byVendor = st.group === 'vendor';
      var rows = byVendor ? vendorRows() : unitRows();
      /* ten columns have to sit inside the content column at 1280px: keep every one of them narrow */
      var columns = [
        { key: 'name', label: byVendor ? 'Vendor' : 'Unit', maxWidth: 270, render: function (v, row) {
          return h('div', { 'class': 'py-cell2 py-clip py-clip--name' },
            h('span', { 'class': 'py-cell2__top mk-strong' }, byVendor ? null : dot(look.unitColour(row.id)), h('span', { title: v }, v)),
            h('span', { 'class': 'py-cell2__sub', title: row.sub || null }, row.sub || plural(row.count, 'open bill')));
        } },
        { key: 'total', label: 'Open balance', format: 'inrFull', width: 148, render: ui.cells.bar(null, '--series-1', { format: 'inrFull' }) }
      ];
      buckets.forEach(function (b, i) {
        columns.push({ key: 'b' + i, label: COL_BUCKET[b.id] || SHORT_BUCKET[b.id] || b.label, title: b.label, format: 'inr', align: 'right', width: 72,
          render: function (v) { return money(v); } });
      });
      /* the credit days of a vendor ride on the second line of its name cell, so no column of their own: nine columns are
         what the content column holds at 1280px, and a tenth pushed the oldest due date out of sight */
      columns.push({ key: 'oldestDueDate', label: 'Oldest due', width: 96, render: function (v, row) { return oldestCell(v, row.overdue > 0, env.today); } });

      var footer = { name: byVendor ? plural(rows.length, 'vendor') : plural(rows.length, 'unit'), total: sum(rows, 'total') };
      buckets.forEach(function (b, i) { var t = sum(rows, 'b' + i); footer['b' + i] = t ? h('span', { 'class': 'mk-num' }, fmt.inr(t)) : dash(); });

      ui.clear(holder);
      holder.appendChild(ui.table({
        columns: columns, rows: rows, dense: true, sortable: true, maxHeight: 460,
        sort: (byVendor ? st.sortAge : st.sortAgeUnit) || { key: 'total', dir: 'desc' },
        onSort: function (s) { if (byVendor) st.sortAge = s; else st.sortAgeUnit = s; },
        rowClass: function (row) { return row.overdue > 0 ? 'is-strong' : ''; },
        onRowClick: function (row) {
          if (row.kind === 'vendor') openVendor(row.id, { linked: null });
          else env.ctx.navigate('approvals-bills', { unit: row.id, tab: 'ALL' });
        },
        footer: rows.length > 1 ? footer : null,
        empty: ui.emptyState('No open balance', 'Nothing is owed on the bills in your scope right now.', { compact: true, icon: 'check-circle' })
      }));
    }

    var top = (p.byVendor || [])[0], topUnit = (p.byUnit || [])[0];
    var sub;
    if (st.group === 'vendor') {
      sub = top ? plural((p.byVendor || []).length, 'vendor') + ' carry the balance; ' + top.name + ' is the largest at ' + fmt.inr(top.total) +
        ' (' + share(top.total, p.total) + ') over ' + plural(top.count, 'bill') + '. Open a row for the bills behind it'
        : 'No vendor carries an open balance in your scope';
    } else {
      sub = topUnit ? plural((p.byUnit || []).length, 'unit') + ' carry the balance; ' + topUnit.label + ' is the largest at ' + fmt.inr(topUnit.total) +
        ' (' + share(topUnit.total, p.total) + ') over ' + plural(topUnit.count, 'bill') + '. Open a row for its bills'
        : 'No unit carries an open balance in your scope';
    }

    var card = ui.card({
      title: 'Ageing by ' + (st.group === 'vendor' ? 'vendor' : 'unit'), flush: true, subtitle: sub,
      actions: ui.segmented({ ariaLabel: 'Group the ageing by', size: 'sm', value: st.group,
        options: [{ value: 'vendor', label: 'By vendor' }, { value: 'unit', label: 'By unit' }],
        onChange: function (v) { st.group = v; env.ctx.rerender(); } }),
      body: holder, footer: ui.sourceTag(['erp'])
    });
    paint();
    return card;
  }

  /* ------------------------------------------------------------------ payment discipline */

  function disciplineChart(env) {
    var d = env.discipline;
    if (!d.months.length) return null;
    var paidTotal = d.totals.onTime + d.totals.late;
    var last = d.latest, lastTotal = last.onTime + last.late;
    var subtitle = lastTotal
      ? share(last.onTime, lastTotal) + ' of the ' + fmt.inr(lastTotal) + ' paid in ' + D.monthLabel(last.key) + ' went out on or before the due date' +
        (last.lateCount ? '; ' + fmt.inr(last.late) + ' over ' + plural(last.lateCount, 'bill') + ' slipped, by ' + fmt.num(last.days / last.lateCount, 1) + ' days on average'
          : '; nothing slipped past its terms')
      : 'No payment recorded in ' + D.monthLabel(last.key);

    var c = MK.charts.mount(null, {
      id: 'py-discipline', kind: 'stackedBar', title: 'Paid on time against paid late', subtitle: subtitle, height: 240, format: 'inr',
      data: {
        categories: d.months.map(function (m) { return D.monthLabel(m.key, true); }),
        categoryHeader: 'Month paid',
        /* the two segments are a verdict, not two identities: the late one wears the critical status token, never a
           categorical slot, so red on this page always means "past the due date" */
        series: [
          { id: 'ontime', name: 'On or before the due date', colourVar: '--series-1', values: d.months.map(function (m) { return m.onTime; }) },
          { id: 'late', name: 'After the due date', colourVar: '--st-critical', values: d.months.map(function (m) { return m.late; }) }
        ]
      },
      note: 'By the value of the bills paid in the month. The payment date is the day the director released the batch, compared with the due date the vendor\'s credit terms set. ' +
        fmt.inr(d.totals.late) + ' of ' + fmt.inr(paidTotal) + ' (' + share(d.totals.late, paidTotal) + ') went out late over the period shown.'
    });
    c.el.appendChild(h('div', { 'class': 'py-chartsrc' }, ui.sourceTag(['erp'])));
    return c.el;
  }

  function lateVendorsCard(env) {
    var look = env.look, d = env.discipline;
    var rows = d.vendors.slice(0, LATE_ROWS).map(function (v) {
      return { id: v.vendorId, name: look.vendorName(v.vendorId), lateCount: v.lateCount, paid: v.paid, lateValue: v.lateValue,
        avgDays: v.lateCount ? v.days / v.lateCount : 0, creditDays: look.creditDays(v.vendorId), lastLate: v.lastLate };
    });
    var body;
    if (!rows.length) {
      body = ui.emptyState('Nothing slipped past its terms',
        env.paid.length ? 'Every one of the ' + plural(env.paid.length, 'bill') + ' paid in your scope went out on or before its due date.'
          : 'No bill in your scope has been paid yet.', { compact: true, icon: 'check-circle' });
    } else {
      body = ui.table({
        dense: true, sortable: true, maxHeight: 316, sort: env.st.sortLate || { key: 'lateValue', dir: 'desc' },
        onSort: function (s) { env.st.sortLate = s; },
        columns: [
          { key: 'name', label: 'Vendor', maxWidth: 190, render: function (v, row) {
            return h('div', { 'class': 'py-cell2 py-clip py-clip--half' }, h('span', { 'class': 'py-cell2__top mk-strong', title: v }, h('span', null, v)),
              h('span', { 'class': 'py-cell2__sub' }, plural(row.lateCount, 'bill') + ' of ' + fmt.num(row.paid) + ' late' +
                (row.creditDays === null ? '' : ' - credit ' + plural(row.creditDays, 'day'))));
          } },
          { key: 'lateValue', label: 'Paid late', format: 'inrFull', width: 148, render: ui.cells.bar(null, '--st-critical', { format: 'inrFull' }) },
          { key: 'avgDays', label: 'Days late', title: 'Average days between the due date and the payment date', format: 'num1', align: 'right', width: 84 },
          { key: 'lastLate', label: 'Last slip', width: 84, render: function (v) { return h('span', { 'class': 'mk-num' }, day(v, 'd MMM')); } }
        ],
        rows: rows,
        onRowClick: function (row) { openVendor(row.id, { linked: null }); },
        footer: rows.length > 1 ? { name: plural(rows.length, 'vendor'), lateValue: sum(rows, 'lateValue') } : null
      });
    }
    return ui.card({
      title: 'Vendors whose bills slipped', className: 'py-latecard', flush: !!rows.length,
      subtitle: rows.length
        ? plural(d.totals.lateCount, 'bill') + ' of ' + fmt.num(d.totals.count) + ' went out after the due date - ' + rows[0].name + ' carries the most at ' + fmt.inr(rows[0].lateValue)
        : 'Payment discipline against the credit terms in the vendor master',
      body: body, footer: ui.sourceTag(['erp'])
    });
  }

  /* ------------------------------------------------------------------ vendor drawer */

  function section(title, extra, children) {
    return h('section', { 'class': 'py-sec' }, h('div', { 'class': 'py-sec__head' }, h('h4', { 'class': 'mk-h3 py-sec__title' }, title), extra || null), children);
  }

  function batchNote(env, bill) {
    if (!bill.batchId) return null;
    var b = env.released[bill.batchId] || guard('batch.get', function () { return MK.workflow.batch.get(bill.batchId); }, null);
    if (!b) return 'In payment batch ' + bill.batchId;
    return 'In ' + b.number + ' - ' + ui.statusInfo(b.status).label.toLowerCase();
  }

  function drawerBody(vendorId, env) {
    var look = env.look, p = env.p, rec = look.vendor(vendorId);
    var line = (p.byVendor || []).filter(function (v) { return v.vendorId === vendorId; })[0] || null;
    var bills = guard('bill.list vendor', function () { return MK.workflow.bill.list({ vendorId: vendorId, status: OPEN_STATES }); }, []);
    var paid = guard('bill.list vendor paid', function () { return MK.workflow.bill.list({ vendorId: vendorId, status: 'PAID' }); }, []);
    var lateBills = paid.filter(function (b) { return b.dueDate && b.paidOn && b.paidOn > b.dueDate; });
    var lateDays = lateBills.reduce(function (t, b) { return t + D.diffDays(b.dueDate, b.paidOn); }, 0);
    var creditDays = look.creditDays(vendorId);
    var overdueHere = bills.filter(function (b) { return b.dueDate && daysPast(b.dueDate, env.today) > 0 && !env.inTransitBill(b); });

    var blocked = rec && rec.state && rec.state !== 'APPROVED'
      ? ui.callout('warn', 'This vendor is not approved for payment',
        'The vendor record stands at "' + ui.statusInfo(rec.state).label + '", so its approved bills cannot enter a payment batch until the checker approves it again. ' +
        (line ? fmt.inr(line.total) + ' is waiting on that.' : ''))
      : null;

    var summary = ui.keyValue([
      ['Open balance', h('strong', { 'class': 'mk-num' }, fmt.inrFull(line ? line.total : sum(bills.map(function (b) { return { v: b.payable }; }), 'v')))],
      ['Open bills', plural(bills.length, 'bill')],
      line ? ['Overdue', line.overdue ? h('span', { 'class': 'py-late' }, ui.icon('alert-triangle', 12), fmt.inrFull(line.overdue)) : h('span', { 'class': 'mk-muted' }, 'None')] : null,
      line ? ['Due within ' + plural(DUE_SOON_DAYS, 'day'), line.dueIn7Days ? fmt.inrFull(line.dueIn7Days) : h('span', { 'class': 'mk-muted' }, 'None')] : null,
      line && line.inTransit ? ['Released to the bank', fmt.inrFull(line.inTransit)] : null,
      ['Credit days', creditDays === null ? h('span', { 'class': 'mk-faint' }, 'Not in the vendor master') : plural(creditDays, 'day')],
      line && line.oldestDueDate ? ['Oldest due date', h('span', null, day(line.oldestDueDate) + ' - ',
        daysPast(line.oldestDueDate, env.today) > 0 && !line.overdue ? 'with the bank' : dueLabel(line.oldestDueDate, env.today).toLowerCase())] : null,
      rec && rec.category ? ['Category', rec.category] : null,
      rec && rec.unitIds ? ['Units served', rec.unitIds.map(look.unitShort).join(', ')] : null
    ].filter(Boolean), { cols: 2 });

    var billRows = bills.map(function (b) {
      var transit = env.inTransitBill(b);
      return { id: b.id, number: b.number, invoiceNo: b.invoiceNo, invoiceDate: b.invoiceDate, dueDate: b.dueDate,
        unitId: b.unitId, amount: b.payable || 0, status: b.status, batchNote: batchNote(env, b), inTransit: transit,
        days: transit ? 0 : daysPast(b.dueDate, env.today) };
    });

    var table = ui.table({
      dense: true, sortable: true, maxHeight: 320, sort: { key: 'dueDate', dir: 'asc' },
      columns: [
        { key: 'dueDate', label: 'Due', width: 100, render: function (v, row) { return dueCell(v, env.today, row.inTransit); } },
        { key: 'number', label: 'Bill', render: function (v, row) {
          return h('div', { 'class': 'py-cell2 py-clip py-clip--drawer' },
            h('span', { 'class': 'py-cell2__top' }, ui.link(v, billHref(row.id), { title: 'Open the bill' })),
            h('span', { 'class': 'py-cell2__sub', title: row.invoiceNo }, row.invoiceNo + ' - ' + day(row.invoiceDate, 'd MMM')));
        } },
        { key: 'unitId', label: 'Unit', width: 104, sortValue: function (row) { return look.unitName(row.unitId); }, render: function (v) { return unitTag(look, v); } },
        { key: 'status', label: 'Status', width: 128, render: function (v, row) {
          return h('div', { 'class': 'py-cell2' }, ui.statusChip(v), row.batchNote ? h('span', { 'class': 'py-cell2__sub', title: row.batchNote }, row.batchNote) : null);
        } },
        { key: 'amount', label: 'Payable', format: 'inrFull', width: 100 }
      ],
      rows: billRows,
      rowClass: function (row) { return row.days > 0 ? 'is-strong' : ''; },
      footer: billRows.length ? { number: plural(billRows.length, 'bill'), amount: sum(billRows, 'amount') } : null,
      empty: ui.emptyState('No open bill', 'Everything billed by this vendor has been paid.', { compact: true, icon: 'check-circle' })
    });

    var history = paid.length
      ? h('p', { 'class': 'py-histline' },
        lateBills.length
          ? h('span', null, plural(lateBills.length, 'bill') + ' of the ' + fmt.num(paid.length) + ' paid to this vendor went out after the due date, by ' +
            fmt.num(lateDays / lateBills.length, 1) + ' days on average - ' + fmt.inrFull(sum(lateBills.map(function (b) { return { v: b.payable }; }), 'v')) + ' in all.')
          : h('span', null, 'All ' + plural(paid.length, 'bill') + ' paid to this vendor went out on or before the due date.'))
      : h('p', { 'class': 'py-histline mk-muted' }, 'No bill of this vendor has been paid yet.');

    return wrap('py-drawer', [
      blocked,
      summary,
      overdueHere.length ? ui.callout('critical', plural(overdueHere.length, 'bill') + ' past the due date',
        'The oldest fell due on ' + day(overdueHere[0].dueDate) + ', ' + plural(daysPast(overdueHere[0].dueDate, env.today), 'day') + ' ago.') : null,
      section('Open bills', h('span', { 'class': 'py-sec__meta mk-num' }, fmt.inrFull(sum(billRows, 'amount'))), table),
      section('Payment history', null, history),
      h('div', { 'class': 'py-drawersrc' }, ui.sourceTag(['erp']))
    ]);
  }

  function openVendor(vendorId, opts) {
    opts = opts || {};
    if (live.drawer) { live.drawer.show(vendorId, opts.linked || null); return; }
    var state = { id: vendorId, linked: opts.linked || null };
    var chip = h('span', { 'class': PAGE_CLASS + ' py-headchip' });

    var d = ui.drawer({ title: vendorId, width: 560, headerExtra: chip, body: null, footer: null, onClose: function () {
      live.drawer = null;
      if (state.linked && live.ctx) {
        var cur = MK.router.current();
        if (cur && cur.page && cur.page.id === PAGE_ID && cur.params && cur.params.vendor === state.linked) live.ctx.navigate(PAGE_ID, null, { replace: true });
      }
    } });

    function refresh() {
      var env = live.env; if (!env) return;
      var look = env.look, rec = look.vendor(state.id);
      var line = (env.p.byVendor || []).filter(function (v) { return v.vendorId === state.id; })[0] || null;
      var name = (rec && rec.name) || (line && line.name) || look.vendorName(state.id);
      ui.clear(chip);
      if (!rec && !line) {
        d.setTitle(state.id, null);
        d.setBody(wrap('py-drawer', ui.emptyState('This vendor is not visible to you',
          'A vendor is visible only when it serves a unit in your scope (' + MK.session.allowedUnitIds().map(look.unitName).join(', ') + '), or the id does not exist.', { icon: 'lock' })));
        d.setFooter(null);
        return;
      }
      if (rec && rec.state) chip.appendChild(ui.statusChip(rec.state));
      d.setTitle(name, line ? fmt.inrFull(line.total) + ' open over ' + plural(line.count, 'bill') : 'No open balance');
      d.setBody(drawerBody(state.id, env));
      d.setFooter(wrap('py-foot', h('div', { 'class': 'py-foot__row' },
        ui.link('All bills of this vendor', MK.router.href('approvals-bills', { q: name, tab: 'ALL' }), { icon: 'receipt' }),
        ui.button({ label: 'Close', variant: 'ghost', onClick: function () { d.close(); } }))));
    }

    live.drawer = { show: function (next, linked) { state.id = next; state.linked = linked || null; refresh(); }, refresh: refresh, close: function () { d.close(); } };
    refresh();
  }

  /* ------------------------------------------------------------------ render */

  function render(rootEl, ctx) {
    var st = ctx.state;
    var env = buildEnv(ctx);
    normaliseState(st, env);
    live.ctx = ctx; live.env = env;

    /* deep link: #/approvals/payables?vendor=v_dry opens that vendor's drawer, once per id */
    var wanted = (ctx.params && ctx.params.vendor) || null, openLinked = false;
    if (wanted && st.linked !== wanted) { st.linked = wanted; openLinked = true; }
    if (!wanted) st.linked = null;

    rootEl.appendChild(intro(env));
    rootEl.appendChild(h('div', { 'class': 'py-kpis' }, kpis(env).map(function (t) { return ui.statTile(t); })));

    if (!env.p.count) {
      rootEl.appendChild(ui.card({
        body: ui.emptyState('Nothing is payable right now',
          'No bill in your scope is open: everything entered has been paid, or no bill has been raised yet. Bills appear here from the moment they are entered on the Bills screen.',
          { icon: 'wallet', action: ui.link('Go to Bills', MK.router.href('approvals-bills')) }),
        footer: ui.sourceTag(['erp'])
      }));
      if (live.drawer) live.drawer.refresh();
      return function cleanup() { live.ctx = null; };
    }

    rootEl.appendChild(h('div', { 'class': 'py-work' }, ageingChart(env), dueCard(env)));
    rootEl.appendChild(ageingTable(env));

    var chart = disciplineChart(env);
    rootEl.appendChild(ui.sectionTitle('Payment discipline', 'What slipped past the credit terms once it was paid, and who carries it'));
    rootEl.appendChild(h('div', { 'class': 'py-work py-work--bottom' },
      chart || ui.card({ title: 'Paid on time against paid late', body: ui.emptyState('No payment recorded yet', 'A bill joins this view once its bank reference is recorded.', { compact: true, icon: 'bank' }), footer: ui.sourceTag(['erp']) }),
      lateVendorsCard(env)));

    /* overlays outlive a re-render: bring an open drawer up to date (store change, persona change) */
    if (live.drawer) live.drawer.refresh();
    if (openLinked) openVendor(wanted, { linked: wanted });

    return function cleanup() { live.ctx = null; };
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/approvals/payables',
    group: 'Approvals',
    title: 'Payables',
    subtitle: 'Ageing, due this week and overdue',
    units: 'all',
    roles: null,
    filters: [],
    render: render
  });
})(window);
