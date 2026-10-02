/*
 * Vendors (#/vendors) - the vendor master and the complete onboarding workflow.
 *
 * Blocks: purpose line with what the persona may do -> KPI row -> top vendors by spend + what a state
 * other than "Approved" is holding up -> the vendor register (state tabs with counts, search, unit and
 * type filters, table, CSV) -> the onboarding wizard (four steps in a wide modal, live deterministic
 * pre-checks from MK.workflow.vendor.preChecks, create as a draft, then run the verification)
 * -> the vendor profile drawer (state machine, details with a masked account behind an eye toggle,
 * verification evidence, spend history, recent bills, timeline, actions by persona).
 *
 * Verification is SIMULATED: every result carries MK.workflow.SIMULATED_NOTE. Utility billers have no
 * tax or bank identity to verify and say so instead of showing evidence.
 *
 * Every figure comes from MK.workflow / MK.finance / MK.audit and is formatted with MK.fmt. Access is
 * never filtered here: reads are scoped by the data layer, and every action asks MK.workflow.vendor.can()
 * so that a blocked action stays visible, disabled, with the reason the kernel returns.
 *
 * Page-local state (ctx.state): userId, tab, search, unit, type, sort, openId, paramSig, linked.
 * Overlays (drawer, wizard, edit form, dialogs) live outside the page root, so their content sits in
 * wrappers that carry the page class and the module keeps one `live` object pointing at the latest render.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates;

  var PAGE_ID = 'vendors';
  var PAGE_CLASS = 'pg-vendors';
  var ALL = 'ALL';
  var STATE_ORDER = ['DRAFT', 'VERIFYING', 'VERIFIED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'];
  var ONBOARDING_STATES = ['DRAFT', 'VERIFYING', 'VERIFIED', 'NEEDS_REVIEW'];
  var OPEN_BILL_STATES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'IN_BATCH'];
  var SPEND_MONTHS = 3;              /* the table column and the ranking window; never printed as a figure */
  var TOP_VENDORS = 8;               /* one-colour bars: the tail is folded into a single "other vendors" bar */
  var ATTENTION_ROWS = 6;
  var BILL_ROWS = 6;
  var CHART_HEIGHT = 300;
  var DRAWER_CHART_HEIGHT = 200;

  var STEPS = ['Business details', 'Tax identity', 'Bank account', 'Documents and review'];
  var TAX_CHECKS = ['pan_format', 'gstin_format', 'gstin_checksum', 'gstin_state', 'pan_in_gstin'];
  var BANK_CHECKS = ['ifsc_format', 'ifsc_bank', 'account_format'];
  var STEP_OF_FIELD = {
    name: 0, type: 0, category: 0, unitIds: 0, creditDays: 0, tdsLabel: 0, contactName: 0, email: 0, phone: 0, address: 0,
    pan: 1, gstin: 1,
    bankName: 2, ifsc: 2, bankAccount: 2, bankAccountMasked: 2, accountHolderName: 2
  };
  var DOC_TYPES = [
    { id: 'gst', label: 'GST registration certificate' },
    { id: 'pan', label: 'PAN card copy' },
    { id: 'cheque', label: 'Cancelled cheque or bank letter' },
    { id: 'fssai', label: 'FSSAI licence (food suppliers)' },
    { id: 'agreement', label: 'Signed rate agreement', utility: true },
    { id: 'connection', label: 'Latest bill or connection letter', utility: true, utilityOnly: true }
  ];
  /* Which evidence an edit clears (API-workflow section 3): a name change clears both. */
  var BANK_FIELDS = ['bankName', 'ifsc', 'bankAccount', 'bankAccountMasked', 'accountHolderName', 'name'];
  var REGISTRY_FIELDS = ['pan', 'gstin', 'name'];
  var FIELD_LABELS = {
    name: 'Legal name', type: 'Type', category: 'Category', unitIds: 'Units served', creditDays: 'Credit days',
    pan: 'PAN', gstin: 'GSTIN', bankName: 'Bank', ifsc: 'IFSC', bankAccountMasked: 'Bank account',
    accountHolderName: 'Account holder', expenseCategoryIds: 'Expense categories', tdsLabel: 'TDS type',
    contactName: 'Contact', email: 'Email', phone: 'Phone', address: 'Address'
  };
  var TDS_OPTIONS = ['TDS - rent', 'TDS - contractor / transport', 'TDS - professional fees'];

  /* what the open overlays need from the latest render */
  var live = { ctx: null, st: null, env: null, drawer: null, wizard: null, form: null, markSelected: null, attention: null };

  /* ------------------------------------------------------------------ helpers */

  function guard(name, fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; }
    catch (e) { if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e); return fallback; }
  }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function isAre(n) { return n === 1 ? 'is' : 'are'; }
  function day(iso, style) { return iso ? D.label(String(iso).slice(0, 10), style || 'd MMM yyyy') : '-'; }
  function monthName(key) { return key ? D.monthLabel(key, true) : '-'; }
  function has(list, x) { return !!list && list.indexOf(x) !== -1; }
  function lower(s) { return String(s || '').toLowerCase(); }
  function lowerFirst(s) { s = String(s || ''); return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
  /* Lower-case a label mid-sentence, but leave acronyms (PAN, GSTIN, IFSC, TDS type) alone. */
  function lowerLabel(s) {
    s = String(s || '');
    return s.length > 1 && s.charAt(1) === s.charAt(1).toUpperCase() && s.charAt(1) !== s.charAt(1).toLowerCase() ? s : lowerFirst(s);
  }
  function trim(s) { return String(s === null || s === undefined ? '' : s).trim(); }
  /* A value that arrives lower-cased from the data layer ('monthly') still opens a sentence properly. */
  function sentence(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function sum(list) { var t = 0; (list || []).forEach(function (x) { t += x || 0; }); return t; }
  function userName(id) { var u = id ? MK.session.userById(id) : null; return u ? u.name : (id || '-'); }
  function stateLabel(s) {
    var L = MK.workflow && MK.workflow.labels && MK.workflow.labels.state;
    return (L && L[s]) || ui.statusInfo(s).label;
  }
  function simNote() { return (MK.workflow && MK.workflow.SIMULATED_NOTE) || 'Simulated in this mockup'; }
  /* Refusal wording belongs to the data layer: a form message says exactly what the transition would say. */
  function errText(key, fallback) {
    var E = MK.workflow && MK.workflow.errors;
    return (E && E[key]) || fallback;
  }
  function simChip() { return ui.chip(simNote(), 'neutral', { icon: 'info', outline: true, title: 'Registry and penny-drop results are generated by rule, not fetched from a real service.' }); }
  function mono(text) { return h('span', { 'class': 'vn-mono' }, text); }
  function muted(text) { return h('span', { 'class': 'vn-muted' }, text); }

  function lookups() {
    var units = {}, order = [], cats = {};
    ((MK.config && MK.config.outlets) || []).forEach(function (u) { units[u.id] = u; order.push(u.id); });
    ((MK.config && MK.config.expenseCategories) || []).forEach(function (c) { cats[c.id] = c; });
    return {
      units: units, unitOrder: order, cats: cats,
      unitName: function (id) { return units[id] ? units[id].name : (id || '-'); },
      unitShort: function (id) { return units[id] ? (units[id].short || units[id].name) : (id || '-'); },
      unitColour: function (id) { return units[id] ? units[id].colourVar : null; },
      catLabel: function (id) { return cats[id] ? cats[id].label : (id || '-'); }
    };
  }

  function unitNames(ids, look) { return (ids || []).map(look.unitName).join(', '); }

  /* Units served, short enough for a table cell; the full list is the tooltip. */
  function unitsCell(ids, look) {
    ids = ids || [];
    if (!ids.length) return muted('None');
    var full = unitNames(ids, look);
    return h('span', { 'class': 'vn-units', title: full }, ids.length === 1 ? look.unitShort(ids[0]) : plural(ids.length, 'unit'));
  }

  function typeLabel(v) { return v.type === 'utility' ? 'Utility biller' : 'Vendor'; }

  /* ------------------------------------------------------------------ per-render environment */

  function buildEnv(ctx) {
    var W = MK.workflow;
    var env = { ctx: ctx, st: ctx.state, user: ctx.user || MK.session.current(), look: lookups() };
    env.allowedUnits = guard('allowedUnitIds', function () { return MK.session.allowedUnitIds(); }, []);
    env.counts = guard('vendor.counts', function () { return W.vendor.counts(); }, null) || { total: 0 };
    STATE_ORDER.forEach(function (s) { if (typeof env.counts[s] !== 'number') env.counts[s] = 0; });
    env.vendors = guard('vendor.list', function () { return W.vendor.list(); }, []);
    env.spend = {};
    env.vendors.forEach(function (v) {
      env.spend[v.id] = guard('finance.vendorSpend', function () {
        return MK.finance && MK.finance.vendorSpend ? MK.finance.vendorSpend(v.id) : null;
      }, null);
    });
    env.months = guard('config.months', function () { return (MK.config && MK.config.months) || []; }, []);
    env.recentMonths = env.months.slice(-SPEND_MONTHS);
    env.openBills = {};
    guard('bill.list open', function () { return W.bill.list({ status: OPEN_BILL_STATES }); }, []).forEach(function (b) {
      var o = env.openBills[b.vendorId] || (env.openBills[b.vendorId] = { count: 0, payable: 0 });
      o.count += 1; o.payable += b.payable || 0;
    });
    env.mayCreate = guard('vendor.can create', function () { return W.vendor.can('create'); }, { ok: false, reason: 'Not available' });
    env.mayApprove = guard('session.can approve', function () { return MK.session.can('vendor.approve'); }, { ok: false, reason: '' });
    env.thisMonth = MK.calendar.today.slice(0, 7);
    env.window3 = env.recentMonths.length
      ? monthName(env.recentMonths[0]) + ' to ' + day(MK.calendar.dataEnd)
      : 'the data range';
    return env;
  }

  function spend3(env, vendorId) {
    var s = env.spend[vendorId];
    return s && s.values ? sum(s.values.slice(-SPEND_MONTHS)) : 0;
  }
  function openOf(env, vendorId) { return env.openBills[vendorId] || { count: 0, payable: 0 }; }
  function verifiedOn(v) { return v.verification && v.verification.runAt ? v.verification.runAt : null; }
  function addedThisMonth(env) {
    return env.vendors.filter(function (v) { return trim(v.createdAt).slice(0, 7) === env.thisMonth; });
  }
  function notApproved(env) {
    return env.vendors.filter(function (v) { return v.state !== 'APPROVED'; });
  }

  /* The most recent edit that reset the verification, if the record has not been approved since. */
  function resetEvent(v) {
    var hits = (v.history || []).filter(function (e) { return e && (e.action === 'vendor.bankChange' || e.action === 'vendor.taxChange'); });
    var last = hits.length ? hits[hits.length - 1] : null;
    if (!last) return null;
    if (v.approvedAt && v.approvedAt >= last.at) return null;
    return last;
  }

  /*
   * What that edit actually did, read off the fields it touched rather than off the audit action name:
   * the action is 'vendor.bankChange' as soon as one bank field moved, even when the name, PAN and GSTIN
   * moved with it and the registry result was cleared too.
   */
  function resetImpact(reset) {
    var fields = (reset.changes || []).map(function (c) { return c && c.field; });
    var bank = fields.some(function (f) { return has(BANK_FIELDS, f); });
    var registry = fields.some(function (f) { return has(REGISTRY_FIELDS, f); });
    if (!bank && !registry) bank = reset.action === 'vendor.bankChange';
    var cleared = bank && registry ? 'the penny-drop evidence and the GST registry result'
      : (bank ? 'the penny-drop evidence' : 'the GST registry result');
    var title = bank && registry ? 'Bank details and tax identity changed'
      : (bank ? 'Bank details changed' : 'Name or tax identity changed');
    return {
      bank: bank, registry: registry, cleared: cleared, title: title + ' - verification reset',
      wasApproved: reset.from === 'APPROVED',
      fields: fields.filter(Boolean).map(function (f) { return lowerLabel(FIELD_LABELS[f] || f); })
    };
  }

  /* One sentence saying why a vendor is not payable, always taken from the record. */
  function whyNotApproved(v) {
    if (v.state === 'REJECTED') return v.rejectionReason ? v.rejectionReason : 'Turned down at onboarding.';
    var reasons = v.verification && v.verification.reasons;
    if (reasons && reasons.length) return reasons.join('; ') + '.';
    var reset = resetEvent(v);
    if (reset) {
      var im = resetImpact(reset);
      return userName(reset.actorId) + ' changed ' + (im.fields.length ? im.fields.join(', ') : 'the verified details') +
        ' on ' + day(reset.at) + ', which cleared ' + im.cleared + '.';
    }
    if (v.state === 'DRAFT') return 'Still a draft: the maker has not sent it for verification.';
    if (v.state === 'VERIFYING') return 'Sent for verification; the registry and penny-drop results are not back yet.';
    if (v.state === 'VERIFIED') return 'Verification passed; waiting for the finance checker to approve it.';
    return 'Waiting on the onboarding workflow.';
  }

  /* ------------------------------------------------------------------ page state */

  function normaliseState(st, env) {
    if (st.userId !== env.user.id) {
      st.userId = env.user.id;
      st.tab = defaultTab(env);
      if (st.unit && st.unit !== ALL && !has(env.allowedUnits, st.unit)) st.unit = ALL;
    }
    if (st.tab !== ALL && !has(STATE_ORDER, st.tab)) st.tab = defaultTab(env);
    st.search = typeof st.search === 'string' ? st.search : '';
    st.unit = st.unit || ALL;
    st.type = st.type || ALL;
  }

  /* The register opens whole: the attention card above it is what points at the records that need a decision. */
  function defaultTab() { return ALL; }

  function applyParams(st, ctx) {
    var p = ctx.params || {};
    var sig = ['tab', 'state', 'unit', 'type', 'q'].map(function (k) { return p[k] || ''; }).join('|');
    if (st.paramSig === sig) return;
    st.paramSig = sig;
    if (!sig.replace(/\|/g, '')) return;
    var tab = String(p.tab || p.state || '').toUpperCase().replace(/[\s-]+/g, '_');
    if (tab === ALL || has(STATE_ORDER, tab)) st.tab = tab;
    if (p.unit) st.unit = p.unit;
    if (p.type === 'vendor' || p.type === 'utility') st.type = p.type;
    if (p.q) st.search = String(p.q);
  }

  /* A tile or a list link shows exactly what it counts: the register's own filters are cleared first. */
  function showInTable(change) {
    if (!live.st || !live.ctx) return;
    var st = live.st;
    st.search = ''; st.unit = ALL; st.type = ALL;
    change(st);
    live.ctx.rerender();
    if (live.card && live.card.scrollIntoView) live.card.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------------------------ intro */

  function intro(env) {
    var parts = [];
    if (env.mayCreate.ok) parts.push('you onboard vendors, edit the master and run the verification');
    if (env.mayApprove.ok) parts.push('you approve, override or reject what the maker has verified - never a record you raised or last changed yourself');
    if (!parts.length) {
      parts.push('you can follow every vendor in your scope but not change one (' + lowerFirst(env.mayCreate.reason || 'not permitted for your role') + ')');
    }
    return h('p', { 'class': 'vn-intro' },
      'Every bill and every payment runs through this master: only an approved vendor can be billed or paid, and a change to bank details withdraws that approval until the checker grants it again. ',
      h('span', { 'class': 'vn-intro__who' }, 'As ' + env.user.name + ' (' + env.user.roleLabel + ') ' + parts.join('; ') + '.'));
  }

  /* ------------------------------------------------------------------ KPI row */

  function kpis(env) {
    var total = env.counts.total || 0;
    var onboarding = 0;
    ONBOARDING_STATES.forEach(function (s) { onboarding += env.counts[s] || 0; });
    var added = addedThisMonth(env);
    var blockedVendors = notApproved(env).filter(function (v) { return openOf(env, v.id).count > 0; });
    var blockedBills = sum(blockedVendors.map(function (v) { return openOf(env, v.id).count; }));
    var blockedValue = sum(blockedVendors.map(function (v) { return openOf(env, v.id).payable; }));

    var onboardingSub = ONBOARDING_STATES.filter(function (s) { return env.counts[s]; })
      .map(function (s) { return fmt.num(env.counts[s]) + ' ' + lower(stateLabel(s)); }).join(', ');
    var addedSub = STATE_ORDER.filter(function (s) { return added.filter(function (v) { return v.state === s; }).length; })
      .map(function (s) { return fmt.num(added.filter(function (v) { return v.state === s; }).length) + ' ' + lower(stateLabel(s)); }).join(', ');

    return [
      { label: 'Approved and payable', value: fmt.num(env.counts.APPROVED), icon: 'check-circle',
        sub: total ? fmt.pct(env.counts.APPROVED / total, 0) + ' of ' + plural(total, 'vendor') + ' in your scope' : 'No vendor in your scope',
        onClick: function () { showInTable(function (st) { st.tab = 'APPROVED'; }); } },
      { label: 'Awaiting verification or review', value: fmt.num(onboarding), icon: 'clock',
        tone: env.counts.NEEDS_REVIEW ? 'warn' : null,
        sub: onboardingSub || 'Nothing in onboarding',
        onClick: function () {
          showInTable(function (st) {
            st.tab = env.counts.NEEDS_REVIEW ? 'NEEDS_REVIEW' : (env.counts.VERIFIED ? 'VERIFIED' : (env.counts.VERIFYING ? 'VERIFYING' : (env.counts.DRAFT ? 'DRAFT' : ALL)));
          });
        } },
      { label: 'Rejected', value: fmt.num(env.counts.REJECTED), icon: 'x-circle',
        sub: env.counts.REJECTED ? 'Turned down at onboarding' : 'None turned down',
        onClick: function () { showInTable(function (st) { st.tab = 'REJECTED'; }); } },
      { label: 'Added this month', value: fmt.num(added.length), icon: 'plus',
        sub: monthName(env.thisMonth) + (addedSub ? ' - ' + addedSub : ' - no new vendor yet') },
      { label: 'Open bills blocked by vendor state', value: fmt.inr(blockedValue), icon: 'lock',
        tone: blockedBills ? 'critical' : null, goodWhen: 'down',
        sub: blockedBills ? plural(blockedBills, 'open bill') + ' of ' + plural(blockedVendors.length, 'vendor') + ' that ' + isAre(blockedVendors.length) + ' not approved'
          : (total ? 'Every vendor with open bills is approved' : 'No vendor in your scope'),
        onClick: function () { if (live.attention && live.attention.scrollIntoView) live.attention.scrollIntoView({ block: 'nearest' }); } }
    ];
  }

  /* ------------------------------------------------------------------ top vendors by spend */

  function spendChart(env) {
    var host = h('div', { 'class': 'vn-cell' });
    var rows = env.vendors.map(function (v) { return { v: v, amount: spend3(env, v.id) }; })
      .filter(function (r) { return r.amount > 0; })
      .sort(function (a, b) { return b.amount - a.amount; });
    var window3 = env.window3;

    if (!MK.charts || typeof MK.charts.mount !== 'function' || !rows.length) {
      host.appendChild(ui.card({ title: 'Where the vendor spend goes', subtitle: window3,
        body: ui.emptyState(rows.length ? 'Charts are not loaded' : 'No vendor spend booked in this window',
          rows.length ? null : 'Spend appears here as soon as bills are booked against a vendor in your units.', { icon: 'coins', compact: true }),
        footer: ui.sourceTag(['erp']) }));
      return host;
    }

    var top = rows.slice(0, TOP_VENDORS);
    var tail = rows.slice(TOP_VENDORS);
    var totalSpend = sum(rows.map(function (r) { return r.amount; }));
    var categories = top.map(function (r) { return r.v.name; });
    var values = top.map(function (r) { return r.amount; });
    if (tail.length) {
      categories.push('Other vendors');
      values.push(sum(tail.map(function (r) { return r.amount; })));
    }
    var lead = rows[0];
    var subtitle = lead.v.name + ' is the largest at ' + fmt.inr(lead.amount) + ', ' + fmt.pct(lead.amount / totalSpend, 0) +
      ' of the ' + fmt.inr(totalSpend) + ' booked with ' + plural(rows.length, 'vendor') + ' from ' + window3 + '.';
    if (rows.length > 1) {
      var topShare = sum(top.map(function (r) { return r.amount; })) / totalSpend;
      subtitle += ' The ' + plural(top.length, 'vendor') + ' named here carry ' + fmt.pct(topShare, 0) + ' of it' +
        (tail.length ? '; the other ' + plural(tail.length, 'vendor') + ' sit in the last bar.' : '.');
    }

    var chart = MK.charts.mount(null, {
      id: 'vn-topspend', kind: 'hbar', format: 'inr', height: CHART_HEIGHT,
      title: 'Where the vendor spend goes', subtitle: subtitle,
      data: { categories: categories, values: values, name: 'Spend', colourVar: '--series-1', categoryHeader: 'Vendor' },
      table: {
        columns: [{ key: 'vendor', label: 'Vendor' }, { key: 'category', label: 'Category' }, { key: 'state', label: 'State' },
          { key: 'amount', label: 'Spend', format: 'inrFull', align: 'right' }, { key: 'share', label: 'Share', format: 'pct', align: 'right' }],
        rows: rows.map(function (r) {
          return { vendor: r.v.name, category: r.v.category, state: stateLabel(r.v.state), amount: r.amount, share: r.amount / totalSpend };
        })
      },
      onClick: function (d) {
        var hit = rows.filter(function (r) { return r.v.name === d.category; })[0];
        if (hit) { openVendor(hit.v.id); return; }
        showInTable(function (st) { st.tab = ALL; });          /* the folded tail: the register is where those vendors are */
      },
      note: 'Booked cost including GST, from the expense ledger of the units you may see. ' + monthName(env.months[env.months.length - 1]) + ' runs to ' + day(MK.calendar.dataEnd) + '.'
    });
    chart.el.appendChild(h('div', { 'class': 'vn-chartsrc' }, ui.sourceTag(['erp'])));
    host.appendChild(chart.el);
    return host;
  }

  /* ------------------------------------------------------------------ what a non-approved state holds up */

  function attentionCard(env) {
    var rows = notApproved(env).map(function (v) {
      var open = openOf(env, v.id);
      return { v: v, open: open, spend: spend3(env, v.id) };
    }).sort(function (a, b) {
      if (b.open.payable !== a.open.payable) return b.open.payable - a.open.payable;
      return b.spend - a.spend;
    });

    var body;
    if (!rows.length) {
      body = ui.emptyState('Every vendor in your scope is approved', 'Nothing is waiting on onboarding, and no bill is held up by a vendor state.', { icon: 'check-circle', compact: true });
    } else {
      body = h('ul', { 'class': 'vn-att' }, rows.slice(0, ATTENTION_ROWS).map(function (r) {
        var money = r.open.count
          ? plural(r.open.count, 'open bill') + ' worth ' + fmt.inrFull(r.open.payable) + ' cannot be paid'
          : (r.spend ? 'No open bill; ' + fmt.inr(r.spend) + ' booked ' + env.window3 : 'No open bill');
        return h('li', null, h('button', {
          type: 'button', 'class': 'vn-att__row', title: 'Open ' + r.v.name,
          onClick: function () { openVendor(r.v.id); }
        },
          h('span', { 'class': 'vn-att__top' },
            h('span', { 'class': 'vn-att__name' }, r.v.name),
            ui.statusChip(r.v.state)),
          h('span', { 'class': 'vn-att__money' }, money),
          h('span', { 'class': 'vn-att__why' }, whyNotApproved(r.v))));
      }));
    }

    var blocked = rows.filter(function (r) { return r.open.count > 0; });
    var subtitle = rows.length
      ? plural(rows.length, 'vendor is', 'vendors are') + ' not approved for billing or payment' +
        (blocked.length ? ', and ' + plural(blocked.length, 'of them holds', 'of them hold') + ' up ' +
          fmt.inrFull(sum(blocked.map(function (r) { return r.open.payable; }))) + ' of open bills.' : '.')
      : 'Only an approved vendor can be billed or paid.';

    var card = ui.card({
      title: 'Not payable right now', subtitle: subtitle, className: 'vn-fill',
      body: body,
      footer: h('div', { 'class': 'vn-cardfoot' },
        rows.length > ATTENTION_ROWS ? h('span', { 'class': 'vn-cardfoot__more' }, ui.icon('info', 12),
          plural(rows.length - ATTENTION_ROWS, 'more vendor', 'more vendors') + ' in the register below') : h('span'),
        ui.sourceTag(['erp']))
    });
    live.attention = card;
    return h('div', { 'class': 'vn-cell' }, card);
  }

  /* ------------------------------------------------------------------ the register */

  function toRow(env, v) {
    var open = openOf(env, v.id);
    return {
      id: v.id, vendor: v, name: v.name,
      sub: [v.category, v.type === 'utility' ? 'Utility biller' : null].filter(Boolean).join(' - '),
      category: v.category, type: typeLabel(v), unitIds: v.unitIds || [], unitCount: (v.unitIds || []).length,
      unitText: unitNames(v.unitIds, env.look),
      state: v.state, stateLabel: stateLabel(v.state), gstin: v.gstin || '', creditDays: v.creditDays,
      verifiedOn: verifiedOn(v), spend: spend3(env, v.id), openBills: open.count, openPayable: open.payable
    };
  }

  function filteredRows(env, st) {
    var q = lower(trim(st.search));
    return env.vendors.filter(function (v) {
      if (st.tab !== ALL && v.state !== st.tab) return false;
      if (st.unit !== ALL && !has(v.unitIds || [], st.unit)) return false;
      if (st.type !== ALL && v.type !== st.type) return false;
      if (q) {
        var hay = lower([v.name, v.category, v.gstin, v.pan, v.bankName, v.ifsc, v.contactName].filter(Boolean).join(' '));
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).map(function (v) { return toRow(env, v); });
  }

  function registerColumns(env) {
    return [
      { key: 'name', label: 'Vendor', sortable: true, render: ui.cells.twoLine('sub', { maxWidth: 200 }) },
      { key: 'unitCount', label: 'Units', sortable: true, title: 'Units this vendor serves',
        render: function (value, row) { return unitsCell(row.unitIds, env.look); } },
      { key: 'state', label: 'State', sortable: true, render: ui.cells.status() },
      { key: 'gstin', label: 'GSTIN', sortable: true, maxWidth: 140,
        render: function (value, row) {
          if (row.vendor.type === 'utility') return muted('Not applicable');
          return value ? mono(value) : muted('Unregistered');
        } },
      { key: 'creditDays', label: 'Credit days', align: 'right', format: 'num', sortable: true },
      { key: 'verifiedOn', label: 'Last verification', sortable: true,
        render: function (value, row) {
          if (row.vendor.type === 'utility') return muted('Not required');
          return value ? h('span', { 'class': 'vn-nowrap', title: ui.dateTime(value) }, day(value)) : muted('Not run yet');
        } },
      { key: 'spend', label: 'Spend, last ' + plural(SPEND_MONTHS, 'month'), format: 'inr', sortable: true, width: 170,
        title: 'Cost booked against this vendor in ' + (env.recentMonths.length ? env.recentMonths.map(monthName).join(', ') : 'the recent months'),
        render: ui.cells.bar(null, '--series-1') }
    ];
  }

  function csvColumns(env) {
    return [
      { key: 'name', label: 'Vendor' }, { key: 'category', label: 'Category' }, { key: 'type', label: 'Type' },
      { key: 'unitText', label: 'Units served' }, { key: 'stateLabel', label: 'State' }, { key: 'gstin', label: 'GSTIN' },
      { key: 'creditDays', label: 'Credit days' }, { key: 'verifiedOn', label: 'Last verification' },
      { key: 'spend', label: 'Spend last ' + plural(SPEND_MONTHS, 'month') }, { key: 'openBills', label: 'Open bills' },
      { key: 'openPayable', label: 'Open bill value' }
    ];
  }

  function registerCard(env, ctx) {
    var st = env.st;
    var rows = filteredRows(env, st);

    var tabs = ui.tabs({
      ariaLabel: 'Vendor state',
      items: [{ id: ALL, label: 'All vendors', count: env.counts.total }].concat(STATE_ORDER.map(function (s) {
        return { id: s, label: stateLabel(s), count: env.counts[s] || 0 };
      })),
      value: st.tab,
      onChange: function (id) { st.tab = id; ctx.rerender(); }
    });

    var unitOptions = [{ value: ALL, label: 'All units served' }].concat(
      env.look.unitOrder.filter(function (id) { return has(env.allowedUnits, id); })
        .map(function (id) { return { value: id, label: env.look.unitName(id) }; }));

    var search = ui.form.search({
      value: st.search, placeholder: 'Search name, category, GSTIN, PAN', width: 260, ariaLabel: 'Search vendors',
      onInput: function (value) { st.search = value; ctx.rerender(); }
    });

    var filters = h('div', { 'class': 'vn-filters' },
      search,
      ui.select({ ariaLabel: 'Unit served', size: 'sm', value: st.unit, options: unitOptions,
        onChange: function (v) { st.unit = v; ctx.rerender(); } }),
      ui.segmented({ ariaLabel: 'Vendor type', size: 'sm', value: st.type,
        options: [{ value: ALL, label: 'All types' }, { value: 'vendor', label: 'Vendors' }, { value: 'utility', label: 'Utility billers' }],
        onChange: function (v) { st.type = v; ctx.rerender(); } }),
      h('span', { 'class': 'vn-filters__count' }, plural(rows.length, 'vendor') + ' shown'));

    var table = ui.table({
      columns: registerColumns(env), rows: rows, dense: true,
      sort: st.sort || { key: 'spend', dir: 'desc' },
      onSort: function (s) { st.sort = s; },
      rowClass: function (row) { return row.id === st.openId ? 'is-selected' : ''; },
      onRowClick: function (row) { openVendor(row.id); },
      empty: env.counts.total
        ? ui.emptyState('No vendor matches these filters', 'Clear the search or pick another state tab.', { icon: 'search', compact: true })
        : ui.emptyState('No vendor in your scope', 'You see the vendors that serve at least one of your units. ' + env.user.name + ' is assigned to ' + (env.allowedUnits.length ? unitNames(env.allowedUnits, env.look) : 'no unit') + '.', { icon: 'lock', compact: true }),
      footer: rows.length ? { name: plural(rows.length, 'vendor') + ' shown', spend: sum(rows.map(function (r) { return r.spend; })) } : null
    });

    var actions = [
      ui.button({ label: 'CSV', icon: 'download', size: 'sm', disabled: !rows.length,
        onClick: function () { ui.downloadCsv('vendors.csv', csvColumns(env), rows); } }),
      ui.button({ label: 'Onboard vendor', variant: 'primary', icon: 'plus',
        disabledReason: env.mayCreate.ok ? '' : (env.mayCreate.reason || 'Not available'),
        onClick: function () { openWizard(); } })
    ];

    var card = ui.card({
      title: 'Vendor register', flush: true, className: 'vn-register',
      subtitle: 'A vendor becomes payable only in the Approved state; the tabs follow the onboarding state machine.',
      actions: actions,
      body: [h('div', { 'class': 'vn-toolbar' }, tabs), filters, table],
      footer: ui.sourceTag(['erp'])
    });
    live.card = card;
    live.markSelected = function () {
      var host = card.bodyEl || card;
      var trs = host.querySelectorAll ? host.querySelectorAll('tbody tr') : [];
      for (var i = 0; i < trs.length; i++) {
        var match = rows[i] && rows[i].id === (live.st ? live.st.openId : null);
        trs[i].classList.toggle('is-selected', !!match);
      }
    };
    return card;
  }

  /* ------------------------------------------------------------------ masked value with an eye toggle */

  /* The kit has no secret field: this is the page's own reveal control (a plain button + aria-pressed). */
  function maskedDisplay(masked) {
    if (!masked) return muted('Not on file');
    var shown = false;
    var text = h('span', { 'class': 'vn-mono' });
    var btn = h('button', { type: 'button', 'class': 'vn-eye', 'aria-pressed': 'false', onClick: function () { shown = !shown; paint(); } }, ui.icon('eye', 14));
    function paint() {
      text.textContent = shown ? masked : String(masked).replace(/[^X]/g, 'X');
      btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
      btn.setAttribute('title', shown ? 'Hide the last digits' : 'Show the last digits');
      btn.setAttribute('aria-label', shown ? 'Hide the last digits of the account number' : 'Show the last digits of the account number');
    }
    paint();
    return h('span', { 'class': 'vn-secret' }, text, btn);
  }

  /* Text box whose content is hidden until the eye is pressed. Returns the wrapper; .input is the <input>. */
  function secretInput(opts) {
    opts = opts || {};
    var input = ui.form.input({
      value: opts.value, placeholder: opts.placeholder, type: 'password', mono: true, maxLength: opts.maxLength,
      inputMode: 'numeric', name: opts.name, ariaLabel: opts.ariaLabel, onInput: opts.onInput
    });
    var shown = false;
    var btn = h('button', { type: 'button', 'class': 'vn-eye', 'aria-pressed': 'false', title: 'Show the number', 'aria-label': 'Show the account number',
      onClick: function () {
        shown = !shown;
        input.type = shown ? 'text' : 'password';
        btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
        btn.setAttribute('title', shown ? 'Hide the number' : 'Show the number');
        btn.setAttribute('aria-label', shown ? 'Hide the account number' : 'Show the account number');
        input.focus();
      } }, ui.icon('eye', 14));
    var wrap = h('span', { 'class': 'vn-secret vn-secret--input' }, input, btn);
    wrap.input = input;
    return wrap;
  }

  /* ------------------------------------------------------------------ pre-check list */

  function checkIcon(c) {
    if (c.skipped) return h('span', { 'class': 'vn-check__mark vn-check__mark--skip' }, ui.icon('minus', 14));
    return h('span', { 'class': 'vn-check__mark vn-check__mark--' + (c.ok ? 'ok' : 'bad') }, ui.icon(c.ok ? 'check-circle' : 'x-circle', 14));
  }

  function checkList(pre, only) {
    if (!pre || !pre.applicable) {
      return h('p', { 'class': 'vn-quiet' }, ui.icon('info', 14), (pre && pre.note) || 'No tax or bank identity to check.');
    }
    var checks = (pre.checks || []).filter(function (c) { return !only || has(only, c.id); });
    if (!checks.length) return h('p', { 'class': 'vn-quiet' }, ui.icon('info', 14), 'Nothing to check yet - fill the fields above.');
    return h('ul', { 'class': 'vn-checks' }, checks.map(function (c) {
      return h('li', { 'class': ['vn-check', c.skipped ? 'is-skipped' : (c.ok ? 'is-ok' : 'is-bad')] },
        checkIcon(c),
        h('span', { 'class': 'vn-check__main' },
          h('span', { 'class': 'vn-check__label' }, c.label),
          h('span', { 'class': 'vn-check__detail' }, c.detail)));
    }));
  }

  function checkSummary(pre, only) {
    if (!pre || !pre.applicable) return null;
    var checks = (pre.checks || []).filter(function (c) { return !only || has(only, c.id); });
    var failed = checks.filter(function (c) { return !c.ok && !c.skipped; });
    var skipped = checks.filter(function (c) { return c.skipped; });
    if (!checks.length) return null;
    if (!failed.length) {
      return ui.chip(plural(checks.length - skipped.length, 'check') + ' passed', 'good', { icon: 'check-circle' });
    }
    return ui.chip(plural(failed.length, 'check fails', 'checks fail'), 'critical', { icon: 'alert-triangle' });
  }

  /* ------------------------------------------------------------------ verification evidence */

  function registryBlock(v) {
    var g = v.verification && v.verification.gstin;
    if (!g) {
      return h('p', { 'class': 'vn-quiet' }, ui.icon('info', 14),
        v.gstin ? 'The registry lookup has not been run against the GSTIN on file yet.' : 'No GSTIN on file: the vendor is treated as unregistered under GST.');
    }
    if (!g.applicable) return h('p', { 'class': 'vn-quiet' }, ui.icon('info', 14), g.note || 'No GSTIN to look up.');
    var statusTone = g.status === 'Active' ? 'good' : 'critical';
    return h('div', { 'class': 'vn-evi' },
      ui.keyValue([
        ['Legal name in the registry', h('strong', null, g.legalName)],
        ['Trade name', g.tradeName || null],
        ['GSTIN', mono(g.gstin)],
        ['Registration status', ui.chip(g.status, statusTone, { icon: statusTone === 'good' ? 'check-circle' : 'alert-triangle' })],
        ['Taxpayer type', g.taxpayerType],
        ['Constitution', g.constitution],
        ['State', g.stateCode + ' - ' + g.stateName],
        ['Registered on', g.registeredOn ? day(g.registeredOn) : null]
      ], { cols: 2 }),
      h('p', { 'class': 'vn-evi__src' }, ui.icon('info', 12), g.source));
  }

  function bankBlock(v) {
    var b = v.verification && v.verification.bank;
    if (!b) {
      return h('p', { 'class': 'vn-quiet' }, ui.icon('info', 14),
        v.state === 'DRAFT' ? 'The penny drop runs when the vendor is sent for verification.'
          : 'The bank evidence was cleared by an edit to the bank details. Run the verification again.');
    }
    var score = typeof b.nameMatchScore === 'number' ? b.nameMatchScore : null;
    var threshold = typeof b.threshold === 'number' ? b.threshold : null;
    var pass = score !== null && threshold !== null && score >= threshold;
    return h('div', { 'class': 'vn-evi' },
      ui.keyValue([
        ['Account holder as entered', v.accountHolderName || null],
        ['Name registered with the bank', h('strong', null, b.registeredName)],
        ['Account', maskedDisplay(b.accountMasked || v.bankAccountMasked)],
        ['Bank and IFSC', h('span', { 'class': 'vn-inline' }, b.bankName || v.bankName || '-', mono(b.ifsc || v.ifsc || ''))],
        ['Account status', ui.chip(b.accountStatus, b.accountStatus === 'Active' ? 'good' : 'warn', { icon: b.accountStatus === 'Active' ? 'check-circle' : 'alert-triangle' })],
        ['Reference', mono(b.reference)]
      ], { cols: 2 }),
      score === null ? null : ui.meter({
        label: 'Name match against the vendor name', value: score, max: 1, goodWhen: 'up',
        criticalAt: threshold, warnAt: threshold, target: threshold,
        targetLabel: 'Threshold ' + fmt.pct(threshold, 0),
        valueLabel: fmt.pct(score, 0) + ' of a threshold of ' + fmt.pct(threshold, 0)
      }),
      h('p', { 'class': 'vn-evi__note' },
        score === null ? 'No name match on file.'
          : (pass
            ? 'The bank holds this account in a name that matches the vendor, so the penny drop raises nothing. '
            : 'The bank holds this account as ' + b.registeredName + ' while the vendor is ' + v.name + '. ') +
          'A match below the threshold advises the checker; never auto-rejects.'),
      h('p', { 'class': 'vn-evi__src' }, ui.icon('info', 12), b.method));
  }

  function verificationBlock(v, o) {
    o = o || {};
    if (v.type === 'utility') {
      return h('div', { 'class': 'vn-evi' },
        ui.callout('info', 'No verification required',
          'A utility biller is paid through the biller itself, so there is no tax identity and no bank account of its own to verify. It becomes payable as soon as it is approved.'));
    }
    var ver = v.verification || null;
    var pre = ver && ver.preChecks;
    var out = [];
    if (ver && ver.outcome) {
      var tone = ver.outcome === 'VERIFIED' ? 'good' : 'warn';
      var reasons = (ver.reasons && ver.reasons.length && !o.reasonsShownAbove) ? ver.reasons.join('; ') + '.' : null;
      out.push(ui.callout(tone, 'Verification ' + (ver.outcome === 'VERIFIED' ? 'passed' : 'needs a human decision'),
        [
          reasons ? h('p', { 'class': 'vn-evi__lead' }, reasons)
            : (ver.reasons && ver.reasons.length ? null : h('p', { 'class': 'vn-evi__lead' }, 'Every pre-check passed, the GSTIN is active in the registry and the bank name match is above the threshold.')),
          h('p', { 'class': 'vn-evi__lead' }, 'Run by ' + userName(ver.runBy) + ' on ' + ui.dateTime(ver.runAt) + '.')
        ]));
    } else if (v.state === 'VERIFYING' || v.state === 'DRAFT') {
      var kept = ver && (ver.gstin || ver.bank);
      var wipe = resetEvent(v);
      if (kept) {
        out.push(ui.callout('info', 'Part of the evidence was cleared',
          'The ' + (ver.bank ? 'registry lookup' : 'penny drop') + ' has to be run again against the details now on file; what survived the edit is shown below.'));
      } else if (wipe) {
        out.push(ui.callout('info', 'The evidence was cleared by an edit',
          userName(wipe.actorId) + ' changed ' + (resetImpact(wipe).fields.join(', ') || 'the verified details') + ' on ' + ui.dateTime(wipe.at) +
          ', so both the registry lookup and the penny drop have to be run again against the details now on file.'));
      } else {
        out.push(ui.callout('info', 'Verification not run yet',
          'The registry lookup and the penny drop have not been run against the details on file.'));
      }
    }
    out.push(h('div', { 'class': 'vn-evi__group' },
      h('h4', { 'class': 'vn-evi__title' }, 'GST registry lookup', simChip()),
      registryBlock(v)));
    out.push(h('div', { 'class': 'vn-evi__group' },
      h('h4', { 'class': 'vn-evi__title' }, 'Bank account penny drop', simChip()),
      bankBlock(v)));
    out.push(h('div', { 'class': 'vn-evi__group' },
      h('h4', { 'class': 'vn-evi__title' }, 'Deterministic pre-checks', checkSummary(pre)),
      checkList(pre)));
    return h('div', { 'class': 'vn-evi' }, out);
  }

  /* ------------------------------------------------------------------ profile drawer */

  function section(title, extra, children) {
    return h('section', { 'class': 'vn-sec' },
      h('div', { 'class': 'vn-sec__head' }, h('h3', { 'class': 'mk-h3 vn-sec__title' }, title), extra || null),
      children);
  }

  /* A rejected record never reaches Approved, so its last step says where it actually stopped. */
  function stateSteps(v) {
    var rejected = v.state === 'REJECTED';
    var items = ['Draft', 'Verifying', 'Verified / Needs review', rejected ? stateLabel('REJECTED') : 'Approved'];
    var idx = { DRAFT: 0, VERIFYING: 1, VERIFIED: 2, NEEDS_REVIEW: 2, APPROVED: 3, REJECTED: 3 };
    return ui.steps({ items: items, current: idx[v.state] === undefined ? 0 : idx[v.state] });
  }

  function nextStepText(v, env) {
    if (v.state === 'DRAFT') return 'Next: the finance maker sends it for verification and runs the registry and bank checks.';
    if (v.state === 'VERIFYING') return 'Next: run the verification. The result decides whether it goes to the checker clean or with a reason to look at.';
    if (v.state === 'VERIFIED') return 'Next: the finance checker approves it. Only then can it be billed or paid.';
    if (v.state === 'NEEDS_REVIEW') return 'Next: the finance checker either overrides with a written reason or rejects it. The evidence below is the whole case.';
    if (v.state === 'APPROVED') {
      var open = openOf(env, v.id);
      return 'Approved by ' + userName(v.approvedBy) + (v.approvedAt ? ' on ' + ui.dateTime(v.approvedAt) : '') + '. ' +
        (open.count ? plural(open.count, 'open bill') + ' worth ' + fmt.inrFull(open.payable) + ' can move through approval and payment.' : 'No open bill at the moment.');
    }
    if (v.state === 'REJECTED') return 'Rejected at onboarding. A maker can edit the details and send it for verification again.';
    return '';
  }

  function detailsBlock(v, env) {
    var open = openOf(env, v.id);
    var cats = (v.expenseCategoryIds || []).map(env.look.catLabel).join(', ');
    return ui.keyValue([
      ['Type', typeLabel(v)],
      ['Category', v.category || null],
      ['Units served', h('span', { title: unitNames(v.unitIds, env.look) }, unitNames(v.unitIds, env.look))],
      ['Credit terms', plural(v.creditDays || 0, 'day')],
      ['Expense lines', cats || null],
      ['TDS type', v.tdsLabel || 'None on the vendor master'],
      ['Contact', v.contactName || null],
      ['Email', v.email || null],
      ['Phone', v.phone || null],
      ['Address', v.address || null],
      ['PAN', v.type === 'utility' ? muted('Not applicable') : (v.pan ? mono(v.pan) : muted('Not on file'))],
      ['GSTIN', v.type === 'utility' ? muted('Not applicable') : (v.gstin ? mono(v.gstin) : muted('Unregistered'))],
      ['Bank', v.bankName || (v.type === 'utility' ? muted('Paid through the biller') : muted('Not on file'))],
      ['IFSC', v.ifsc ? mono(v.ifsc) : null],
      ['Bank account', v.type === 'utility' ? null : maskedDisplay(v.bankAccountMasked)],
      ['Account holder', v.accountHolderName || null],
      ['Open bills', open.count ? plural(open.count, 'bill') + ' - ' + fmt.inrFull(open.payable) : muted('None open')],
      ['Onboarded by', v.createdBy ? userName(v.createdBy) + (v.createdAt ? ', ' + ui.dateTime(v.createdAt) : '') : null],
      ['Last edited by', v.updatedBy ? userName(v.updatedBy) + (v.updatedAt ? ', ' + ui.dateTime(v.updatedAt) : '') : null]
    ], { cols: 2 });
  }

  function spendBlock(v, env, chartHost) {
    var s = env.spend[v.id] || guard('finance.vendorSpend', function () { return MK.finance.vendorSpend(v.id); }, null);
    /* the host is reused across records, so a chart drawn for the record before must go before an early return */
    function noChart() {
      if (!chartHost) return;
      guard('charts.disposeAll drawer', function () { MK.charts.disposeAll(chartHost); return true; }, false);
      ui.clear(chartHost);
    }
    if (!s || !s.months || !s.months.length) {
      noChart();
      return h('p', { 'class': 'vn-quiet' }, ui.icon('info', 14), 'No spend history for this vendor.');
    }
    var lastKey = s.months[s.months.length - 1];
    if (!s.total) {
      noChart();
      return h('p', { 'class': 'vn-quiet' }, ui.icon('info', 14),
        'No cost has been booked against this vendor in your units between ' + monthName(s.months[0]) + ' and ' + monthName(lastKey) + '.');
    }
    var peak = 0, peakKey = s.months[0];
    s.values.forEach(function (x, i) { if (x > peak) { peak = x; peakKey = s.months[i]; } });
    var lastVal = s.values[s.values.length - 1];

    if (MK.charts && typeof MK.charts.mount === 'function' && chartHost) {
      guard('charts.disposeAll drawer', function () { MK.charts.disposeAll(chartHost); return true; }, false);
      ui.clear(chartHost);
      guard('charts.mount drawer', function () {
        MK.charts.mount(chartHost, {
          id: 'vn-vendor-spend-' + v.id, kind: 'bar', format: 'inr', height: DRAWER_CHART_HEIGHT, bare: true,
          title: 'Monthly spend', subtitle: 'Largest month ' + monthName(peakKey) + ' at ' + fmt.inr(peak) + '; ' +
            monthName(lastKey) + ' stands at ' + fmt.inr(lastVal) + ' to ' + day(MK.calendar.dataEnd) + '.',
          data: { categories: s.months.map(function (m) { return D.monthLabel(m); }), values: s.values, name: 'Spend', colourVar: '--series-1', categoryHeader: 'Month' },
          note: monthName(lastKey) + ' is a part month, to ' + day(MK.calendar.dataEnd) + '.'
        });
        return true;
      }, false);
    }

    return h('div', { 'class': 'vn-spend' },
      chartHost || null,
      ui.keyValue([
        ['Booked ' + monthName(s.months[0]) + ' to ' + monthName(lastKey), h('strong', null, fmt.inrFull(s.total))],
        ['Average full month', s.averagePerMonth ? fmt.inrFull(s.averagePerMonth) : null],
        ['How it bills', s.billing ? sentence(s.billing.frequency) + ', ' + plural(s.billing.creditDays || 0, 'day') + ' credit' : null],
        ['Largest unit', s.byUnit && s.byUnit.length ? env.look.unitName(s.byUnit[0].unitId) + ' - ' + fmt.inr(s.byUnit[0].amount) : null],
        ['Largest expense line', s.byCategory && s.byCategory.length ? s.byCategory[0].label + ' - ' + fmt.inr(s.byCategory[0].amount) : null]
      ], { cols: 2 }));
  }

  function billsBlock(v, env) {
    var bills = guard('bill.list vendor', function () { return MK.workflow.bill.list({ vendorId: v.id }); }, []);
    if (!bills.length) return h('p', { 'class': 'vn-quiet' }, ui.icon('info', 14), 'No bill has been raised against this vendor in your units.');
    var rows = bills.slice(0, BILL_ROWS).map(function (b) {
      return { id: b.id, number: b.number, unit: env.look.unitName(b.unitId), category: env.look.catLabel(b.categoryId),
        invoiceDate: b.invoiceDate, dueDate: b.dueDate, payable: b.payable, status: b.status };
    });
    var billsOk = guard('router.isAllowed bills', function () { return MK.router.isAllowed('approvals-bills'); }, false);
    var table = ui.table({
      dense: true,
      columns: [
        { key: 'number', label: 'Bill', maxWidth: 140 },
        { key: 'unit', label: 'Unit', render: ui.cells.twoLine('category', { maxWidth: 150 }) },
        { key: 'dueDate', label: 'Due', format: 'date' },
        { key: 'payable', label: 'Payable', format: 'inrFull' },
        { key: 'status', label: 'State', render: ui.cells.status() }
      ],
      rows: rows,
      onRowClick: billsOk ? function (row) { if (live.ctx) live.ctx.navigate('approvals-bills', { id: row.id }); } : null
    });
    return h('div', { 'class': 'vn-bills' }, table,
      h('p', { 'class': 'vn-bills__foot' },
        plural(bills.length, 'bill') + ' in your units' + (bills.length > rows.length ? '; the ' + fmt.num(rows.length) + ' newest are shown.' : '.'),
        billsOk ? ' ' : null,
        billsOk ? ui.link('Open the bills register', MK.router.href('approvals-bills', { q: v.name }), { icon: 'arrow-right' }) : null));
  }

  function changeText(c, env) {
    function show(value, field) {
      if (value === null || value === undefined || value === '') return 'blank';
      if (field === 'unitIds') return Array.isArray(value) && value.length ? unitNames(value, env.look) : 'none';
      if (field === 'expenseCategoryIds') return Array.isArray(value) && value.length ? value.map(env.look.catLabel).join(', ') : 'none';
      if (field === 'creditDays') return plural(Number(value) || 0, 'day');
      if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
      if (typeof value === 'object') return 'changed';
      return String(value);
    }
    return (FIELD_LABELS[c.field] || c.field) + ': ' + show(c.before, c.field) + ' to ' + show(c.after, c.field);
  }

  function timelineBlock(v, env) {
    var events = guard('audit.trail vendor', function () {
      return typeof MK.audit.trail === 'function' ? MK.audit.trail('vendor', v.id) : null;
    }, null);
    if (!events || !events.length) events = guard('audit.list vendor', function () { return MK.audit.list({ entity: 'vendor', entityId: v.id, order: 'asc' }); }, []);
    var items = [];
    (events || []).forEach(function (e) {
      var t = guard('audit.toTimeline', function () { return MK.audit.toTimeline([e])[0]; }, null);
      if (!t) return;
      if (e.changes && e.changes.length) {
        var extra = e.changes.filter(function (c) { return c && c.field; }).map(function (c) { return changeText(c, env); }).join('; ');
        t = Object.assign({}, t, { note: t.note ? t.note + ' - ' + extra : extra });
      }
      items.push(t);
    });
    if (!items.length) {
      items = (v.history || []).map(function (e) {
        return { actor: e.actorName, action: (MK.workflow.labels.action && MK.workflow.labels.action[e.action]) || e.action, from: e.from, to: e.to, note: e.note, at: e.at };
      });
    }
    items.reverse();
    return ui.timeline(items, { empty: 'No activity recorded for this vendor yet' });
  }

  /* ---- decisions */

  function decide(kind, v, env, done) {
    var W = MK.workflow;
    var titles = {
      approve: { title: 'Approve ' + v.name + '?', message: 'The vendor becomes payable: its bills can be approved and put into a payment batch.', label: 'Approve vendor', tone: 'primary', reason: false,
        reasonLabel: 'Note for the audit trail', reasonPlaceholder: 'Optional - what you checked before approving' },
      override: { title: 'Override the verification and approve ' + v.name + '?', message: 'The verification came back with a reason to look at. Approving anyway is recorded against your name with your reason.', label: 'Override and approve', tone: 'primary', reason: true,
        reasonLabel: 'Reason for the override', reasonPlaceholder: 'Why this account is safe to pay despite the flag' },
      reject: { title: 'Reject ' + v.name + '?', message: 'The vendor cannot be billed or paid. The maker sees your reason and can correct the details and try again.', label: 'Reject vendor', tone: 'danger', reason: true,
        reasonLabel: 'Reason for rejection', reasonPlaceholder: 'What the vendor must produce before it can be onboarded' }
    };
    var o = titles[kind];
    var evidence = h('div', { 'class': PAGE_CLASS + ' vn-decide' },
      ui.keyValue([
        ['Vendor', v.name],
        ['State now', ui.statusChip(v.state)],
        ['Units served', unitNames(v.unitIds, env.look)],
        ['Bank name match', typeof v.nameMatch === 'number' ? h('span', { 'class': 'vn-inline' }, fmt.pct(v.nameMatch / 100, 0), simChip()) : null],
        ['Account holder with the bank', v.verification && v.verification.bank ? v.verification.bank.registeredName : null]
      ]),
      v.verification && v.verification.reasons && v.verification.reasons.length
        ? ui.callout(kind === 'reject' ? 'critical' : 'warn', 'What the verification flagged', v.verification.reasons.join('; ') + '.')
        : null);

    ui.confirm({
      title: o.title, message: o.message, body: evidence, confirmLabel: o.label, tone: o.tone,
      requireReason: o.reason, reasonLabel: o.reasonLabel, reasonPlaceholder: o.reasonPlaceholder
    }).then(function (res) {
      if (!res.ok) return;
      var out = guard('vendor.' + kind, function () {
        if (kind === 'approve') return W.vendor.approve(v.id, res.reason);   /* the note, when the checker wrote one, lands in the audit trail */
        if (kind === 'override') return W.vendor.override(v.id, res.reason);
        return W.vendor.reject(v.id, res.reason);
      }, { ok: false, error: 'The action could not be completed' });
      done(out, kind);
    });
  }

  function openVendor(id, o) {
    o = o || {};
    if (live.wizard || live.form) return;
    if (live.drawer) { live.drawer.show(id); return; }

    var state = { id: id, error: null, linked: o.linked || null };
    var chipHost = h('span', { 'class': PAGE_CLASS + ' vn-headchip' });
    var bodyHost = h('div', { 'class': PAGE_CLASS + ' vn-drawer' });
    var footHost = h('div', { 'class': PAGE_CLASS + ' vn-actions' });
    var chartHost = h('div', { 'class': 'vn-spend__chart' });
    var closedByEdit = false;

    var d = ui.drawer({
      title: id, subtitle: ' ', headerExtra: chipHost, width: 560, body: bodyHost, footer: footHost,
      onClose: function () {
        live.drawer = null;
        guard('charts.disposeAll close', function () { MK.charts.disposeAll(chartHost); return true; }, false);
        if (closedByEdit) return;
        if (live.st) live.st.openId = null;
        if (live.markSelected) live.markSelected();
        if (state.linked) {
          var cur = guard('router.current', function () { return MK.router.current(); }, null);
          if (live.st) live.st.linked = null;
          if (cur && cur.page.id === PAGE_ID && cur.params.id === state.linked && live.ctx) live.ctx.navigate(PAGE_ID, null, { replace: true });
        }
      }
    });

    function after(res, verb, tone) {
      if (res && res.ok) { state.error = null; ui.toast(verb, { tone: tone || 'good' }); }
      else state.error = (res && res.error) || 'The action could not be completed';
      refresh();
      if (d.el && d.el.focus) d.el.focus();
    }

    function actionBar(v, env) {
      var W = MK.workflow, buttons = [], blocked = [];
      function add(action, label, opts, onClick) {
        var may = guard('vendor.can ' + action, function () { return W.vendor.can(action, v); }, { ok: false, reason: 'Not available' });
        if (!may.ok) blocked.push({ label: label, reason: may.reason });
        buttons.push(ui.button(Object.assign({ label: label, disabledReason: may.ok ? '' : (may.reason || 'Not available'), onClick: onClick }, opts || {})));
      }

      add('update', 'Edit details', { icon: 'edit' }, function () {
        closedByEdit = true;
        d.close();
        openEdit(v);
      });

      if (v.state === 'DRAFT' || v.state === 'VERIFYING') {
        add('runVerification', 'Run verification', { variant: 'primary', icon: 'shield-check' }, function () {
          var res = guard('vendor.runVerification', function () { return W.vendor.runVerification(v.id); }, { ok: false, error: 'The action could not be completed' });
          after(res, res.ok ? 'Verification finished: ' + lower(stateLabel(res.record.state)) + ' (' + lower(simNote()) + ')' : '', res.ok && res.record.state === 'VERIFIED' ? 'good' : 'warn');
        });
      }
      if (v.state === 'VERIFIED') {
        add('reject', 'Reject', { variant: 'danger', icon: 'x' }, function () { decide('reject', v, env, function (res) { after(res, 'Vendor rejected', 'warn'); }); });
        add('approve', 'Approve vendor', { variant: 'primary', icon: 'check' }, function () { decide('approve', v, env, function (res) { after(res, 'Vendor approved - it can be billed and paid', 'good'); }); });
      }
      if (v.state === 'NEEDS_REVIEW') {
        add('reject', 'Reject', { variant: 'danger', icon: 'x' }, function () { decide('reject', v, env, function (res) { after(res, 'Vendor rejected', 'warn'); }); });
        add('override', 'Override and approve', { variant: 'primary', icon: 'check' }, function () { decide('override', v, env, function (res) { after(res, 'Vendor approved with a recorded override', 'good'); }); });
      }

      var why = [], seen = {}, user = MK.session.current();
      blocked.forEach(function (b) { (seen[b.reason] = seen[b.reason] || []).push(b.label); });
      Object.keys(seen).forEach(function (reason) { why.push(seen[reason].join(', ') + ': ' + lowerFirst(reason) + '.'); });
      var decidable = v.state === 'VERIFIED' || v.state === 'NEEDS_REVIEW';
      var ownRecord = user.id === v.createdBy || user.id === v.updatedBy;
      if (env.mayApprove.ok && decidable) {
        why.push(ownRecord
          ? 'Maker-checker: this is the record you raised or last edited, so its decision belongs to someone else.'
          : 'Maker-checker: the maker prepares and verifies, the checker decides - and a vendor the checker raised or last edited herself is refused here.');
      } else if (blocked.length && env.mayCreate.ok && decidable) {
        why.push('The maker prepares and verifies; the decision sits with the finance checker.');
      }

      return [
        h('div', { 'class': 'vn-actions__row' },
          h('span', { 'class': 'vn-actions__next' }, ui.icon(v.state === 'APPROVED' ? 'check-circle' : 'info', 14), nextStepText(v, env)),
          buttons.length ? h('span', { 'class': 'vn-actions__buttons' }, buttons) : null),
        why.length ? h('div', { 'class': 'vn-actions__why' }, ui.icon('lock', 12), h('span', null, why.join(' '))) : null
      ];
    }

    function refresh() {
      var env = live.env || buildEnv(live.ctx);
      var keep = d.body ? d.body.scrollTop : 0;
      var v = guard('vendor.get', function () { return MK.workflow.vendor.get(state.id); }, null);
      ui.clear(chipHost); ui.clear(bodyHost); ui.clear(footHost);
      if (!v) {
        d.setTitle(state.id, 'Not available');
        bodyHost.appendChild(ui.emptyState('This vendor is outside your scope',
          'It serves no unit ' + MK.session.current().name + ' is assigned to, or it no longer exists.', { icon: 'lock' }));
        footHost.appendChild(h('div', { 'class': 'vn-actions__row' },
          h('span', { 'class': 'vn-actions__buttons' }, ui.button({ label: 'Close', onClick: function () { d.close(); } }))));
        return;
      }

      d.setTitle(v.name, [v.category, typeLabel(v), unitNames(v.unitIds, env.look)].filter(Boolean).join(' - '));
      chipHost.appendChild(ui.statusChip(v.state));

      var banners = [];
      if (state.error) banners.push(ui.callout('critical', 'The action was refused', state.error));
      if (v.state === 'REJECTED' && v.rejectionReason) {
        banners.push(ui.callout('critical', 'Rejected by ' + userName(v.rejectedBy) + (v.rejectedAt ? ' on ' + ui.dateTime(v.rejectedAt) : ''), v.rejectionReason));
      }
      var reasonsShown = false;
      if (v.state === 'NEEDS_REVIEW') {
        reasonsShown = !!(v.verification && v.verification.reasons && v.verification.reasons.length);
        banners.push(ui.callout('warn', 'The checker has to decide this one',
          (reasonsShown ? v.verification.reasons.join('; ') + '. ' : '') +
          'The evidence below is simulated and advisory: it never approves or rejects anything by itself.'));
      }
      var reset = resetEvent(v);
      if (reset && v.state !== 'APPROVED') {
        var im = resetImpact(reset);
        var open = openOf(env, v.id);
        banners.push(ui.callout('serious', im.title,
          userName(reset.actorId) + ' changed ' + (im.fields.length ? im.fields.join(', ') : 'the verified details') +
          ' on ' + ui.dateTime(reset.at) + ', which ' +
          (im.wasApproved ? 'withdrew the approval and cleared ' : 'sent the record back for verification and cleared ') + im.cleared + '. ' +
          (open.count ? plural(open.count, 'open bill') + ' worth ' + fmt.inrFull(open.payable) + ' cannot be paid until the checker approves the vendor again.'
            : 'It cannot be billed or paid until the checker approves it.')));
      }
      if (v.overrideReason) {
        banners.push(ui.callout('info', 'Approved with an override by ' + userName(v.approvedBy), v.overrideReason));
      }

      ui.append(bodyHost,
        banners,
        section('Onboarding state', ui.statusChip(v.state), h('div', { 'class': 'vn-state' }, stateSteps(v))),
        section('Details', null, detailsBlock(v, env)),
        section('Verification evidence', v.type === 'utility' ? null : simChip(), verificationBlock(v, { reasonsShownAbove: reasonsShown })),
        section('Spend history', null, spendBlock(v, env, chartHost)),
        section('Recent bills', null, billsBlock(v, env)),
        section('Timeline', h('span', { 'class': 'vn-muted vn-small' }, 'Newest first'), timelineBlock(v, env)),
        ui.sourceTag(['erp']));
      ui.append(footHost, actionBar(v, env));
      if (d.body) d.body.scrollTop = keep;
    }

    live.drawer = {
      id: function () { return state.id; },
      show: function (nextId) {
        state.id = nextId; state.error = null;
        if (live.st) live.st.openId = nextId;
        refresh();
        if (d.body) d.body.scrollTop = 0;
        if (live.markSelected) live.markSelected();
      },
      refresh: refresh,
      close: function () { d.close(); }
    };
    if (live.st) live.st.openId = id;
    refresh();
    if (live.markSelected) live.markSelected();
  }

  /* ------------------------------------------------------------------ shared form pieces */

  function categoryOptions() {
    var seen = {}, out = [];
    ((MK.config && MK.config.vendors) || []).forEach(function (v) { if (v.category && !seen[v.category]) { seen[v.category] = 1; out.push(v.category); } });
    out.sort();
    return out;
  }

  function unitPicker(fs, allowedUnits, look, onChange) {
    var host = h('div', { 'class': 'vn-units__pick' });
    look.unitOrder.filter(function (id) { return has(allowedUnits, id); }).forEach(function (id) {
      host.appendChild(ui.form.checkbox({
        label: look.unitName(id), checked: has(fs.unitIds, id),
        onChange: function (on) {
          fs.unitIds = fs.unitIds.filter(function (u) { return u !== id; });
          if (on) fs.unitIds.push(id);
          if (onChange) onChange();
        }
      }));
    });
    return host;
  }

  /* Live form state -> the shape MK.workflow.vendor.preChecks expects. */
  function preCheckState(fs) {
    return {
      type: fs.type, name: fs.name, pan: fs.pan, gstin: fs.gstin, ifsc: fs.ifsc, bankName: fs.bankName,
      bankAccount: fs.bankAccount, bankAccountMasked: fs.bankAccountMasked, accountHolderName: fs.accountHolderName || fs.name
    };
  }
  function runPreChecks(fs) {
    return guard('vendor.preChecks', function () { return MK.workflow.vendor.preChecks(preCheckState(fs)); },
      { ok: false, applicable: true, checks: [], failed: [] });
  }

  function businessFields(fs, env, onAny, fields) {
    fields = fields || {};
    var cats = categoryOptions();
    var nameField = ui.form.field({
      label: 'Legal name', required: true,
      control: ui.form.input({ value: fs.name, placeholder: 'As printed on the invoice and the GST certificate', maxLength: 80, onInput: function (v) { fs.name = v; onAny(); } })
    });
    fields.name = nameField;
    var tradeField = ui.form.field({
      label: 'Trade name', optional: true,
      hint: 'The name on the signboard when it differs. The registry lookup returns the trade name on file with GST, and the evidence panel shows both.',
      control: ui.form.input({ value: fs.tradeName, placeholder: 'Only if it differs from the legal name', maxLength: 80, onInput: function (v) { fs.tradeName = v; } })
    });
    var isOther = !!fs.category && !has(cats, fs.category);
    var otherCat = ui.form.input({ value: isOther ? fs.category : '', placeholder: 'Type the category', maxLength: 60, onInput: function (v) { fs.category = v; onAny(); } });
    var otherField = ui.form.field({ label: 'New category', control: otherCat });
    otherField.hidden = !isOther;
    var catSelect = ui.select({
      block: true, value: fs.category ? (isOther ? '__other' : fs.category) : '', placeholder: 'Choose a category',
      options: cats.map(function (c) { return { value: c, label: c }; }).concat([{ value: '__other', label: 'Other (type it below)' }]),
      onChange: function (v) {
        if (v === '__other') { otherField.hidden = false; fs.category = otherCat.value; otherCat.focus(); }
        else { otherField.hidden = true; fs.category = v; }
        onAny();
      }
    });

    var typeControl = ui.segmented({
      ariaLabel: 'Vendor type', value: fs.type,
      options: [{ value: 'vendor', label: 'Vendor' }, { value: 'utility', label: 'Utility biller' }],
      onChange: function (v) { fs.type = v; onAny(); }
    });

    fields.category = ui.form.field({ label: 'Category', required: true, control: catSelect });
    fields.unitIds = ui.form.field({
      label: 'Units served', required: true, control: unitPicker(fs, env.allowedUnits, env.look, onAny),
      hint: 'The vendor appears to the managers of the units you tick, and its bills may only be raised there.'
    });
    fields.creditDays = ui.form.field({ label: 'Credit days', required: true,
      control: ui.form.input({ value: fs.creditDays, inputMode: 'numeric', maxLength: 3, onInput: function (v) { fs.creditDays = v; onAny(); } }),
      hint: 'Prefilled with the commonest term on the vendor master. Payment runs are twice a week, so short terms have to be met by the next run.' });

    return ui.form.group([
      ui.form.row([nameField, tradeField]),
      ui.form.row([
        fields.category,
        ui.form.field({ label: 'Type', control: typeControl, hint: 'A utility biller is paid through the biller itself and has no tax or bank identity to verify.' })
      ]),
      otherField,
      fields.unitIds,
      ui.form.row([
        fields.creditDays,
        ui.form.field({ label: 'TDS type', optional: true,
          control: ui.select({ block: true, value: fs.tdsLabel,
            options: [{ value: '', label: 'None' }].concat(TDS_OPTIONS.map(function (t) { return { value: t, label: t }; })),
            onChange: function (v) { fs.tdsLabel = v; } }),
          hint: 'Tax deducted from the payment and paid to the government on the vendor\'s behalf; it changes what is paid out, never what the bill costs.' })
      ]),
      ui.form.row([
        ui.form.field({ label: 'Contact person', optional: true, control: ui.form.input({ value: fs.contactName, maxLength: 60, onInput: function (v) { fs.contactName = v; } }) }),
        ui.form.field({ label: 'Email', optional: true, control: ui.form.input({ value: fs.email, type: 'email', maxLength: 80, onInput: function (v) { fs.email = v; } }) }),
        ui.form.field({ label: 'Phone', optional: true, control: ui.form.input({ value: fs.phone, maxLength: 20, onInput: function (v) { fs.phone = v; } }) })
      ], 3),
      ui.form.field({ label: 'Address', optional: true, control: ui.form.textarea({ value: fs.address, rows: 2, maxLength: 200, onInput: function (v) { fs.address = v; } }) })
    ]);
  }

  function taxFields(fs, onAny, fields) {
    if (fs.type === 'utility') {
      return ui.callout('info', 'No tax identity for a utility biller',
        'Electricity and water are paid to the biller against a consumer number, so there is no GSTIN or PAN to hold and nothing to verify here.');
    }
    var gstin = ui.form.input({ value: fs.gstin, placeholder: 'State code, PAN, entity number, Z, check character', mono: true, maxLength: 15,
      onInput: function (v) { fs.gstin = v.toUpperCase(); onAny(); } });
    var pan = ui.form.input({ value: fs.pan, placeholder: 'Five letters, four digits, one letter', mono: true, maxLength: 10,
      onInput: function (v) { fs.pan = v.toUpperCase(); onAny(); } });
    fields.gstin = ui.form.field({ label: 'GSTIN', control: gstin, optional: true, hint: 'Leave it blank for a vendor that is not registered under GST; the GST checks are then skipped.' });
    fields.pan = ui.form.field({ label: 'PAN', required: true, control: pan, hint: 'The PAN sits inside the GSTIN, so the two are checked against each other.' });
    return ui.form.group([ui.form.row([fields.gstin, fields.pan])]);
  }

  function bankFields(fs, onAny, fields, o) {
    o = o || {};
    if (fs.type === 'utility') {
      return ui.callout('info', 'No bank account for a utility biller',
        'The biller is paid through the utility payment channel, not by a transfer to an account, so there is no account to penny-drop.');
    }
    var holder = ui.form.input({ value: fs.accountHolderName, placeholder: 'Exactly as the bank holds it', maxLength: 80,
      onInput: function (v) { fs.accountHolderName = v; onAny(); } });
    var account = secretInput({ value: fs.bankAccount, placeholder: o.accountPlaceholder || 'Account number', maxLength: 18, ariaLabel: 'Bank account number',
      onInput: function (v) { fs.bankAccount = v.replace(/[^0-9]/g, ''); onAny(); } });
    var confirmAcc = secretInput({ value: fs.bankAccountConfirm, placeholder: 'Type it again', maxLength: 18, ariaLabel: 'Confirm the bank account number',
      onInput: function (v) { fs.bankAccountConfirm = v.replace(/[^0-9]/g, ''); onAny(); } });
    var ifsc = ui.form.input({ value: fs.ifsc, placeholder: 'Four letters, a zero, then six letters or digits', mono: true, maxLength: 11,
      onInput: function (v) { fs.ifsc = v.toUpperCase(); onAny(); } });
    var bank = ui.form.input({ value: fs.bankName, placeholder: 'Bank the account is with', maxLength: 60,
      onInput: function (v) { fs.bankName = v; onAny(); } });

    fields.accountHolderName = ui.form.field({ label: 'Account holder name', required: true, control: holder,
      hint: 'The penny drop compares this with the name the bank has on the account.' });
    fields.bankAccount = ui.form.field({ label: 'Account number', required: !o.optionalAccount, control: account,
      hint: o.accountHint || 'Digits only. Only the masked number is kept on the master.' });
    fields.bankAccountConfirm = ui.form.field({ label: 'Confirm account number', required: !o.optionalAccount, control: confirmAcc });
    fields.ifsc = ui.form.field({ label: 'IFSC', required: true, control: ifsc });
    fields.bankName = ui.form.field({ label: 'Bank name', required: true, control: bank });

    return ui.form.group([
      fields.accountHolderName,
      ui.form.row([fields.bankAccount, fields.bankAccountConfirm]),
      ui.form.row([fields.ifsc, fields.bankName])
    ]);
  }

  /* Page-local check: the two account boxes have to agree before anything is sent. */
  function accountsMatch(fs) {
    if (!fs.bankAccount && !fs.bankAccountConfirm) return { ok: true, empty: true };
    return { ok: fs.bankAccount === fs.bankAccountConfirm, empty: false };
  }

  /* No typed figure on this screen: the prefilled term is the commonest one already on the master. */
  function commonCreditDays() {
    var tally = {}, best = '', bestN = 0;
    ((MK.config && MK.config.vendors) || []).forEach(function (v) {
      if (typeof v.creditDays !== 'number') return;
      tally[v.creditDays] = (tally[v.creditDays] || 0) + 1;
      if (tally[v.creditDays] > bestN) { bestN = tally[v.creditDays]; best = String(v.creditDays); }
    });
    return best;
  }

  function emptyForm() {
    return {
      name: '', tradeName: '', category: '', type: 'vendor', unitIds: [], creditDays: commonCreditDays(), tdsLabel: '',
      contactName: '', email: '', phone: '', address: '',
      gstin: '', pan: '', bankName: '', ifsc: '', accountHolderName: '', bankAccount: '', bankAccountConfirm: '',
      bankAccountMasked: '', docs: {}
    };
  }

  /* ------------------------------------------------------------------ onboarding wizard */

  function openWizard() {
    if (live.wizard || live.form) return;
    var env = live.env || buildEnv(live.ctx);
    var W = MK.workflow;
    var fs = emptyForm();
    var step = 0, created = null, verified = null, fields = {};
    var stepsHost = h('div', { 'class': 'vn-wiz__steps' });
    var panelHost = h('div', { 'class': 'vn-wiz__panel' });
    var errorHost = h('div', { 'class': 'vn-wiz__error' });
    var bodyHost = h('div', { 'class': PAGE_CLASS + ' vn-wiz' }, stepsHost, errorHost, panelHost);
    var footHost = h('div', { 'class': PAGE_CLASS + ' vn-actions' });

    var m = ui.modal({
      title: 'Onboard a vendor', size: 'lg',
      subtitle: 'The maker enters and verifies, the finance checker approves. Verification results are ' + lower(simNote()) + '.',
      body: bodyHost, footer: footHost,
      onClose: function () {
        live.wizard = null;
        if (created) openVendor(created.id);
      }
    });
    live.wizard = { close: function () { m.close(); } };

    function setError(message, title) {
      ui.clear(errorHost);
      if (message) errorHost.appendChild(ui.callout('critical', title || 'The vendor could not be saved', message));
    }

    function checksPanel(only, title) {
      var host = h('div', { 'class': 'vn-wiz__checks' });
      function paint() {
        var pre = runPreChecks(fs);
        ui.clear(host);
        ui.append(host,
          h('div', { 'class': 'vn-sec__head' }, h('h4', { 'class': 'mk-h3 vn-sec__title' }, title), checkSummary(pre, only)),
          checkList(pre, only));
      }
      host.paint = paint;
      paint();
      return host;
    }

    function docPanel() {
      var list = h('div', { 'class': 'vn-docs' });
      var utility = fs.type === 'utility';
      DOC_TYPES.filter(function (doc) { return utility ? doc.utility : !doc.utilityOnly; }).forEach(function (doc) {
        var nameHost = h('span', { 'class': 'vn-docs__file' });
        function paint() {
          ui.clear(nameHost);
          if (fs.docs[doc.id]) ui.append(nameHost, ui.icon('paperclip', 12), fs.docs[doc.id]);
          else ui.append(nameHost, muted('Not attached'));
        }
        var box = ui.form.checkbox({
          label: doc.label, checked: !!fs.docs[doc.id],
          onChange: function (on) {
            if (on) fs.docs[doc.id] = doc.id + '-' + (trim(fs.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vendor') + '.pdf';
            else delete fs.docs[doc.id];
            paint();
          }
        });
        paint();
        list.appendChild(h('div', { 'class': 'vn-docs__row' }, box, nameHost));
      });
      return h('div', null,
        ui.callout('info', 'Documents are not uploaded in this mockup',
          'Ticking a document stands in for attaching the scan an onboarding pack would carry. The names below are generated from the vendor name.' +
          (utility ? ' A utility biller has no GST, PAN or bank paperwork of its own, so its pack is shorter.' : '')),
        list);
    }

    function reviewPanel() {
      var pre = runPreChecks(fs);
      var docs = Object.keys(fs.docs).map(function (k) { return fs.docs[k]; });
      return h('div', { 'class': 'vn-review' },
        ui.keyValue([
          ['Legal name', fs.name || muted('Not given')],
          ['Trade name', fs.tradeName || null],
          ['Category', fs.category || muted('Not given')],
          ['Type', fs.type === 'utility' ? 'Utility biller' : 'Vendor'],
          ['Units served', fs.unitIds.length ? unitNames(fs.unitIds, env.look) : muted('None picked')],
          ['Credit days', fs.creditDays ? plural(Number(fs.creditDays) || 0, 'day') : muted('Not given')],
          ['TDS type', fs.tdsLabel || 'None'],
          ['Contact', [fs.contactName, fs.email, fs.phone].filter(Boolean).join(' - ') || null],
          ['GSTIN', fs.type === 'utility' ? muted('Not applicable') : (fs.gstin ? mono(fs.gstin) : muted('Unregistered'))],
          ['PAN', fs.type === 'utility' ? muted('Not applicable') : (fs.pan ? mono(fs.pan) : muted('Not given'))],
          ['Bank', fs.type === 'utility' ? muted('Paid through the biller') : (fs.bankName || muted('Not given'))],
          ['IFSC', fs.type === 'utility' ? null : (fs.ifsc ? mono(fs.ifsc) : muted('Not given'))],
          ['Account holder', fs.type === 'utility' ? null : (fs.accountHolderName || fs.name || null)],
          ['Account number', fs.type === 'utility' ? null : (fs.bankAccount ? maskedDisplay(fs.bankAccount.replace(/.(?=.{4})/g, 'X')) : muted('Not given'))],
          ['Documents', docs.length ? docs.join(', ') : muted('None attached')]
        ], { cols: 2 }),
        h('div', { 'class': 'vn-sec__head' }, h('h4', { 'class': 'mk-h3 vn-sec__title' }, 'Pre-checks on what you entered'), checkSummary(pre)),
        checkList(pre),
        ui.callout('info', 'What happens when you create it',
          'The vendor is saved as a draft in your name. Running the verification then ' +
          (fs.type === 'utility'
            ? 'records that a utility biller has no tax identity and no account of its own to check, and leaves it verified.'
            : 'performs the registry lookup and the penny drop (' + lower(simNote()) + ') and leaves it either verified or needing review.') +
          ' Approving it is the finance checker\'s decision, never the maker\'s.'));
    }

    function donePanel() {
      var v = guard('vendor.get created', function () { return W.vendor.get(created.id); }, created) || created;
      var out = [];
      out.push(ui.callout('good', v.name + ' created as a draft',
        'Saved in your name at ' + ui.dateTime(v.createdAt) + '. It cannot be billed or paid until the finance checker approves it.'));
      if (verified) {
        var tone = verified.state === 'VERIFIED' ? 'good' : 'warn';
        out.push(ui.callout(tone, 'Verification finished: ' + stateLabel(verified.state),
          (verified.verification && verified.verification.reasons && verified.verification.reasons.length
            ? verified.verification.reasons.join('; ') + '.'
            : 'Every pre-check passed, the GSTIN is active in the registry and the bank name match is above the threshold.') +
          ' Approving it is now the finance checker\'s decision.'));
        out.push(h('div', { 'class': 'vn-sec__head' }, h('h4', { 'class': 'mk-h3 vn-sec__title' }, 'Verification evidence'), simChip()));
        out.push(verificationBlock(v));
      } else {
        out.push(h('div', { 'class': 'vn-sec__head' }, h('h4', { 'class': 'mk-h3 vn-sec__title' }, 'Pre-checks on the saved record'), checkSummary(v.verification && v.verification.preChecks)));
        out.push(checkList(v.verification && v.verification.preChecks));
      }
      out.push(ui.sourceTag(['erp']));
      return h('div', { 'class': 'vn-review' }, out);
    }

    /* One message at the top of the step, and the same message on the field when that step is on screen. */
    function refuse(message, fieldKey) {
      setError(message, 'This step is not finished');
      if (fieldKey && fields[fieldKey] && fields[fieldKey].setError) fields[fieldKey].setError(message);
      return false;
    }

    function validateStep(index) {
      setError(null);
      Object.keys(fields).forEach(function (k) { if (fields[k] && fields[k].setError) fields[k].setError(''); });
      if (index === 0) {
        if (!trim(fs.name)) return refuse(errText('vendorName', 'Enter the vendor name'), 'name');
        if (!trim(fs.category)) return refuse('Choose or type a category', 'category');
        if (!fs.unitIds.length) return refuse(errText('vendorUnits', 'Select at least one unit the vendor serves'), 'unitIds');
        var days = Number(fs.creditDays);
        if (!isFinite(days) || days < 0 || days > 120) return refuse(errText('creditDays', 'Credit days are out of range'), 'creditDays');
        return true;
      }
      if (index === 1) {
        if (fs.type === 'utility') return true;
        if (!trim(fs.pan)) return refuse('Enter the PAN before verification', 'pan');
        return true;
      }
      if (index === 2) {
        if (fs.type === 'utility') return true;
        var match = accountsMatch(fs);
        if (match.empty) return refuse('Enter the bank account number before verification', 'bankAccount');
        if (!match.ok) return refuse('The two account numbers do not match', 'bankAccountConfirm');
        if (!trim(fs.ifsc)) return refuse('Enter the IFSC before verification', 'ifsc');
        if (!trim(fs.bankName)) return refuse('Enter the name of the bank the account is with', 'bankName');
        return true;
      }
      return true;
    }

    function draft() {
      var d = {
        name: trim(fs.name), type: fs.type, category: trim(fs.category), unitIds: fs.unitIds.slice(),
        creditDays: Number(fs.creditDays), tdsLabel: trim(fs.tdsLabel) || null,
        contactName: trim(fs.contactName), email: trim(fs.email), phone: trim(fs.phone), address: trim(fs.address)
      };
      if (fs.type !== 'utility') {
        d.pan = trim(fs.pan); d.gstin = trim(fs.gstin); d.bankName = trim(fs.bankName); d.ifsc = trim(fs.ifsc);
        d.bankAccount = trim(fs.bankAccount); d.accountHolderName = trim(fs.accountHolderName) || trim(fs.name);
      }
      return d;
    }

    function create() {
      for (var i = 0; i < STEPS.length - 1; i++) {
        if (validateStep(i)) continue;
        if (step !== i) { step = i; paint(); validateStep(i); }   /* show the message on the step that owns the field */
        return;
      }
      var res = guard('vendor.create', function () { return W.vendor.create(draft()); }, { ok: false, error: 'The vendor could not be created' });
      if (!res.ok) {
        setError(res.error);
        if (res.fields) {
          var first = Object.keys(res.fields)[0];
          Object.keys(res.fields).forEach(function (k) { if (fields[k] && fields[k].setError) fields[k].setError(res.fields[k]); });
          var target = STEP_OF_FIELD[first];
          if (target !== undefined && target !== step) { step = target; paint(); }
        }
        return;
      }
      created = res.record;
      ui.toast(created.name + ' saved as a draft', { tone: 'good' });
      paint();
    }

    function runVerification() {
      var res = guard('vendor.runVerification wizard', function () { return W.vendor.runVerification(created.id); }, { ok: false, error: 'The verification could not be run' });
      if (!res.ok) { setError(res.error); return; }
      verified = res.record;
      ui.toast('Verification finished: ' + lower(stateLabel(verified.state)) + ' (' + lower(simNote()) + ')',
        { tone: verified.state === 'VERIFIED' ? 'good' : 'warn' });
      paint();
    }

    function paint() {
      ui.clear(stepsHost); ui.clear(panelHost); ui.clear(footHost);
      fields = {};

      if (created) {
        m.setTitle(created.name, 'Draft created - ' + (verified ? 'verification run, the checker decides next' : 'run the verification to finish onboarding'));
        stepsHost.appendChild(ui.steps({ items: STEPS, current: STEPS.length - 1 }));
        panelHost.appendChild(donePanel());
        var mayRun = guard('vendor.can runVerification', function () { return W.vendor.can('runVerification', created.id); }, { ok: false, reason: 'Not available' });
        ui.append(footHost, h('div', { 'class': 'vn-actions__row' },
          h('span', { 'class': 'vn-actions__next' }, ui.icon('info', 14),
            verified ? 'The record is now with the finance checker.' : 'Running the verification is the last step the maker can take.'),
          h('span', { 'class': 'vn-actions__buttons' },
            ui.button({ label: 'Open the vendor profile', icon: 'external', onClick: function () { m.close(); } }),
            verified ? null : ui.button({ label: 'Run verification', variant: 'primary', icon: 'shield-check',
              disabledReason: mayRun.ok ? '' : (mayRun.reason || 'Not available'), onClick: runVerification }))));
        return;
      }

      m.setTitle('Onboard a vendor', STEPS[step]);
      stepsHost.appendChild(ui.steps({ items: STEPS, current: step }));

      if (step === 0) {
        panelHost.appendChild(businessFields(fs, env, function () { /* the checks of later steps read fs when they are painted */ }, fields));
      } else if (step === 1) {
        var taxChecks = fs.type === 'utility' ? null : checksPanel(TAX_CHECKS, 'Live pre-checks');
        panelHost.appendChild(taxFields(fs, function () { if (taxChecks) taxChecks.paint(); }, fields));
        if (taxChecks) panelHost.appendChild(taxChecks);
      } else if (step === 2) {
        var bankChecks = fs.type === 'utility' ? null : checksPanel(BANK_CHECKS, 'Live pre-checks');
        var matchHost = h('div');
        var repaintBank = function () {
          if (bankChecks) bankChecks.paint();
          ui.clear(matchHost);
          var match = accountsMatch(fs);
          if (!match.empty) {
            matchHost.appendChild(match.ok
              ? h('p', { 'class': 'vn-quiet vn-quiet--ok' }, ui.icon('check-circle', 14), 'Both account numbers are the same.')
              : h('p', { 'class': 'vn-quiet vn-quiet--bad' }, ui.icon('alert-triangle', 14), 'The two account numbers do not match.'));
          }
        }
        panelHost.appendChild(bankFields(fs, repaintBank, fields));
        panelHost.appendChild(matchHost);
        if (bankChecks) panelHost.appendChild(bankChecks);
        repaintBank();
      } else {
        panelHost.appendChild(docPanel());
        panelHost.appendChild(reviewPanel());
      }

      var last = step === STEPS.length - 1;
      ui.append(footHost, h('div', { 'class': 'vn-actions__row' },
        h('span', { 'class': 'vn-actions__next' }, ui.icon('info', 14),
          last ? 'Creating it saves a draft; nothing is payable until the checker approves.' : 'Nothing is saved until the last step.'),
        h('span', { 'class': 'vn-actions__buttons' },
          ui.button({ label: 'Cancel', variant: 'ghost', onClick: function () { m.close(); } }),
          step > 0 ? ui.button({ label: 'Back', icon: 'chevron-left', onClick: function () { step -= 1; paint(); } }) : null,
          last
            ? ui.button({ label: 'Create vendor (draft)', variant: 'primary', icon: 'check', onClick: create })
            : ui.button({ label: 'Next', variant: 'primary', iconRight: 'chevron-right', onClick: function () { if (validateStep(step)) { step += 1; paint(); } } }))));
    }

    paint();
  }

  /* ------------------------------------------------------------------ edit form (maker) */

  function openEdit(v) {
    if (live.form || live.wizard) return;
    var env = live.env || buildEnv(live.ctx);
    var W = MK.workflow;
    var fields = {};
    var fs = {
      name: v.name || '', tradeName: '', category: v.category || '', type: v.type || 'vendor',
      unitIds: (v.unitIds || []).slice(), creditDays: String(v.creditDays === undefined ? '' : v.creditDays),
      tdsLabel: v.tdsLabel || '', contactName: v.contactName || '', email: v.email || '', phone: v.phone || '', address: v.address || '',
      gstin: v.gstin || '', pan: v.pan || '', bankName: v.bankName || '', ifsc: v.ifsc || '',
      accountHolderName: v.accountHolderName || '', bankAccount: '', bankAccountConfirm: '',
      bankAccountMasked: v.bankAccountMasked || '', docs: {}
    };
    var errHost = h('div', { 'class': 'vn-wiz__error' });
    var warnHost = h('div', { 'class': 'vn-wiz__error' });
    var checksHost = h('div');
    var bodyHost = h('div', { 'class': PAGE_CLASS + ' vn-wiz' });
    var footHost = h('div', { 'class': PAGE_CLASS + ' vn-actions' });
    var saved = false;

    var m = ui.modal({
      title: 'Edit ' + v.name, size: 'lg',
      subtitle: 'Changing the account number, the IFSC, the bank, the account holder or the name resets the verification.',
      body: bodyHost, footer: footHost,
      onClose: function () { live.form = null; if (!saved) openVendor(v.id); }
    });
    live.form = { close: function () { m.close(); } };

    function bankTouched() {
      return trim(fs.bankAccount) !== '' || trim(fs.ifsc) !== trim(v.ifsc || '') ||
        trim(fs.bankName) !== trim(v.bankName || '') || trim(fs.accountHolderName) !== trim(v.accountHolderName || '');
    }
    function taxTouched() {
      return trim(fs.pan) !== trim(v.pan || '') || trim(fs.gstin) !== trim(v.gstin || '') || trim(fs.name) !== trim(v.name || '');
    }

    function paintWarning() {
      ui.clear(warnHost);
      var bank = bankTouched(), tax = taxTouched();
      if (!bank && !tax) return;
      var lines = [];
      if (bank) lines.push('the penny-drop evidence and the name match are cleared');
      if (tax) lines.push('the GST registry result is cleared');
      var tail = v.state === 'DRAFT'
        ? ' The vendor is still a draft, so it stays a draft.'
        : (v.state === 'APPROVED'
          ? ' The vendor goes back to Verifying and its approval is withdrawn: open bills cannot be approved or paid until the checker approves it again.'
          : ' The vendor goes back to Verifying and has to be verified and approved again.');
      warnHost.appendChild(ui.callout('serious', 'This change resets the verification',
        'Saving will clear the evidence on file - ' + lines.join(' and ') + '.' + tail));
    }

    function paintChecks() {
      var pre = runPreChecks(Object.assign({}, fs, { bankAccountMasked: trim(fs.bankAccount) ? '' : fs.bankAccountMasked }));
      ui.clear(checksHost);
      ui.append(checksHost,
        h('div', { 'class': 'vn-sec__head' }, h('h4', { 'class': 'mk-h3 vn-sec__title' }, 'Live pre-checks'), checkSummary(pre)),
        checkList(pre));
    }

    function onAny() { paintWarning(); paintChecks(); }

    ui.append(bodyHost,
      errHost, warnHost,
      businessFields(fs, env, onAny, fields),
      h('div', { 'class': 'vn-divider' }),
      taxFields(fs, onAny, fields),
      h('div', { 'class': 'vn-divider' }),
      bankFields(fs, onAny, fields, {
        optionalAccount: true,
        accountPlaceholder: 'Leave blank to keep the account on file',
        accountHint: 'On file: ' + (v.bankAccountMasked || 'none') + '. Type a full number only to replace it; only the masked number is kept.'
      }),
      checksHost);
    onAny();

    function setError(message) {
      ui.clear(errHost);
      if (message) errHost.appendChild(ui.callout('critical', 'The change could not be saved', message));
    }

    function patch() {
      var p = {
        name: trim(fs.name), category: trim(fs.category), unitIds: fs.unitIds.slice(), creditDays: Number(fs.creditDays),
        tdsLabel: trim(fs.tdsLabel) || null, contactName: trim(fs.contactName), email: trim(fs.email),
        phone: trim(fs.phone), address: trim(fs.address)
      };
      if (fs.type !== 'utility') {
        p.pan = trim(fs.pan); p.gstin = trim(fs.gstin); p.bankName = trim(fs.bankName); p.ifsc = trim(fs.ifsc);
        p.accountHolderName = trim(fs.accountHolderName);
        if (trim(fs.bankAccount)) p.bankAccount = trim(fs.bankAccount);
      }
      return p;
    }

    function save() {
      Object.keys(fields).forEach(function (k) { if (fields[k] && fields[k].setError) fields[k].setError(''); });
      if (trim(fs.bankAccount) || trim(fs.bankAccountConfirm)) {
        var match = accountsMatch(fs);
        if (!match.ok) { if (fields.bankAccountConfirm) fields.bankAccountConfirm.setError('The two account numbers do not match'); return; }
      }
      var res = guard('vendor.update', function () { return W.vendor.update(v.id, patch()); }, { ok: false, error: 'The change could not be saved' });
      if (!res.ok) {
        setError(res.error);
        if (res.fields) Object.keys(res.fields).forEach(function (k) { if (fields[k] && fields[k].setError) fields[k].setError(res.fields[k]); });
        return;
      }
      saved = true;
      m.close();
      if (res.unchanged) ui.toast('Nothing was changed', { tone: 'info' });
      else ui.toast(res.record.name + ' updated - now ' + lower(stateLabel(res.record.state)), { tone: bankTouched() || taxTouched() ? 'warn' : 'good' });
      openVendor(v.id);
    }

    function confirmThenSave() {
      if (!bankTouched() && !taxTouched()) { save(); return; }
      if (v.state === 'DRAFT') { save(); return; }
      var what = bankTouched() ? 'bank details' : 'name or tax identity';
      ui.confirm({
        title: 'Change the ' + what + ' of ' + v.name + '?',
        message: 'The verification evidence on file is cleared and the vendor goes back to Verifying' +
          (v.state === 'APPROVED' ? ', which withdraws its approval. Its open bills cannot be approved or paid until the checker approves it again.' : '.'),
        confirmLabel: 'Save and reset verification', tone: 'danger'
      }).then(function (res) { if (res.ok) save(); });
    }

    ui.append(footHost, h('div', { 'class': 'vn-actions__row' },
      h('span', { 'class': 'vn-actions__next' }, ui.icon('info', 14),
        'Every field change is written to the audit trail with the value before and after.'),
      h('span', { 'class': 'vn-actions__buttons' },
        ui.button({ label: 'Cancel', variant: 'ghost', onClick: function () { m.close(); } }),
        ui.button({ label: 'Save changes', variant: 'primary', icon: 'check', onClick: confirmThenSave }))));
  }

  /* ------------------------------------------------------------------ page */

  function render(rootEl, ctx) {
    var env = buildEnv(ctx);
    var st = ctx.state;
    live.ctx = ctx; live.st = st; live.env = env; live.attention = null; live.card = null; live.markSelected = null;

    normaliseState(st, env);
    applyParams(st, ctx);

    rootEl.appendChild(intro(env));
    rootEl.appendChild(h('div', { 'class': 'vn-kpis' }, kpis(env).map(function (t) { return ui.statTile(t); })));

    if (env.counts.total) {
      rootEl.appendChild(ui.grid([7, 5], [spendChart(env), attentionCard(env)]));
    }
    rootEl.appendChild(registerCard(env, ctx));

    if (live.markSelected) live.markSelected();

    /* deep link: open the record once per id, and take the id out of the hash when the drawer closes */
    if (ctx.params.id && st.linked !== ctx.params.id) {
      var id = ctx.params.id;
      st.linked = id;
      openVendor(id, { linked: id });
    } else if (live.drawer) {
      live.drawer.refresh();
    }
  }

  MK.router.register({
    id: 'vendors',
    route: '#/vendors',
    group: 'Vendors',
    title: 'Vendors',
    subtitle: 'Onboarding, verification and vendor profiles',
    units: 'all',
    roles: null,
    filters: [],
    render: render
  });
})(window);
