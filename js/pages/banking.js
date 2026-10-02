/*
 * Banking (#/banking) - the account structure and the cost-centre structure. Deliberately NO balances, no cash
 * position and no transactions: cash flow is outside the scope of this system, and the screen says so.
 *
 * Blocks: purpose line and the "no balances" note -> KPI row (accounts today, banks today, accounts marked to close,
 * accounts in the target structure, transactions a month) -> the eighteen current accounts as a table with an
 * activity bar and a Keep / Merge / Close recommendation -> the target structure drawn in plain HTML and CSS
 * (one bank, four accounts, with the current accounts that fold into each) and a computed consolidation summary
 * -> spend by cost-centre group beside the Company / region / unit / department tree for a chosen month.
 *
 * Every figure comes from MK.config.bankAccounts, MK.config.outlets and MK.finance.costCentreSpend, formatted with
 * MK.fmt. The account master carries a masked last four and an activity level and nothing else - there is no
 * balance in the data layer to print. Cost-centre spend is scoped by the data layer: the Bandra manager sees the
 * company, the Mumbai region and Bandra, the factory manager the company and the factory, and an empty scope falls
 * back to an empty state. The payment-batch action is shown with the reason from MK.workflow.batch.can, so the
 * segregation of duties around the payments account stays visible.
 *
 * Page-local state (ctx.state): month (cost centres), expanded (tree), sortAcc.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates;

  var PAGE_ID = 'banking';   /* the router gives the page root the class .pg-banking */
  var ACTIVITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low', dormant: 'Dormant' };
  /* how busy an account is is not good or bad news - only "dormant" is a housekeeping flag, so only it is toned */
  var ACTIVITY_TONE = { high: 'neutral', medium: 'neutral', low: 'neutral', dormant: 'warn' };
  /* the three recommendations are a plan, not a traffic light: closing an account is the intended outcome, not a warning */
  var RECOMMENDATION = {
    keep: { label: 'Keep', tone: 'good' },
    merge: { label: 'Merge', tone: 'info' },
    close: { label: 'Close', tone: 'neutral' }
  };

  /* ------------------------------------------------------------------ helpers */

  function guard(name, fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; }
    catch (e) { if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e); return fallback; }
  }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function dash() { return h('span', { 'class': 'mk-faint' }, '-'); }
  function distinct(list, key) {
    var seen = {}, out = [];
    (list || []).forEach(function (x) { var v = x[key]; if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out;
  }
  function sumBy(list, key) { return (list || []).reduce(function (t, x) { return t + (x[key] || 0); }, 0); }

  function unitLookup() {
    var byId = {};
    ((MK.config && MK.config.outlets) || []).forEach(function (u) { byId[u.id] = u; });
    return {
      name: function (id) { return byId[id] ? byId[id].name : (id || '-'); },
      short: function (id) { return byId[id] ? (byId[id].short || byId[id].name) : (id || '-'); },
      colour: function (id) { return byId[id] ? byId[id].colourVar : null; }
    };
  }

  function dot(colourVar) {
    return h('span', { 'class': 'bk-dot', 'aria-hidden': 'true', style: colourVar ? { background: 'var(' + colourVar + ')' } : null });
  }

  /* ------------------------------------------------------- per-render environment */

  function buildEnv(ctx) {
    var cfg = MK.config || {};
    var env = { ctx: ctx, st: ctx.state, user: ctx.user || MK.session.current(), look: unitLookup() };
    var accounts = (cfg.bankAccounts && cfg.bankAccounts.current) || [];

    env.accounts = accounts;
    env.target = (cfg.bankAccounts && cfg.bankAccounts.target) || [];
    env.closeOutright = (cfg.bankAccounts && cfg.bankAccounts.closeOutright) || [];
    env.byId = {};
    accounts.forEach(function (a) { env.byId[a.id] = a; });
    env.banks = distinct(accounts, 'bank');
    env.targetBanks = distinct(env.target, 'bank');
    env.txnsTotal = sumBy(accounts, 'txnsPerMonth');
    env.counts = { keep: 0, merge: 0, close: 0 };
    accounts.forEach(function (a) { if (env.counts[a.recommendation] !== undefined) env.counts[a.recommendation] += 1; });
    env.folded = env.target.reduce(function (t, x) { return t + ((x.replaces || []).length); }, 0);
    /* the accounts nothing folds into: they simply stop */
    env.closed = env.closeOutright.filter(function (id) { return !!env.byId[id]; });
    env.closedDormant = env.closed.filter(function (id) { return env.byId[id].activity === 'dormant'; }).length;
    env.closedTxns = env.closed.reduce(function (s, id) { return s + (env.byId[id].txnsPerMonth || 0); }, 0);

    env.months = (cfg.months || []).slice();
    if (env.months.indexOf(env.st.month) === -1) env.st.month = env.months[env.months.length - 1] || null;
    env.spend = guard('costCentreSpend', function () { return MK.finance.costCentreSpend(env.st.month); }, null)
      || { period: {}, tree: null, interUnitCharges: 0, estimatedPart: 0, sources: {} };
    env.tree = env.spend.tree || null;
    env.groups = env.tree ? (env.tree.children || []) : [];

    env.mayBatch = guard('batch.can create', function () { return MK.workflow.batch.can('create'); }, { ok: false, reason: '' });
    return env;
  }

  /* ------------------------------------------------------------------ intro and KPIs */

  function intro(env) {
    return h('div', { 'class': 'bk-intro' },
      h('p', { 'class': 'bk-intro__text' },
        'Structure, not money: which current accounts exist today, which of them fold into which, and which cost ' +
        'centre carries the spend. Balances, cash positions and transactions are not part of this system.'),
      h('p', { 'class': 'bk-intro__who' }, ui.icon('user', 14),
        h('span', null, 'Signed in as ' + (env.user ? env.user.name : '') +
          (env.user ? ' - ' + env.user.roleLabel : '') + '. The cost-centre tree is already narrowed to what you may see.')));
  }

  function kpis(env) {
    var tiles = [
      { label: 'Current accounts today', value: fmt.num(env.accounts.length), icon: 'bank',
        sub: 'across ' + plural(env.banks.length, 'bank') },
      { label: 'Banks today', value: fmt.num(env.banks.length), icon: 'building',
        sub: 'down to ' + plural(env.targetBanks.length, 'bank') + ' in the target structure' },
      { label: 'Accounts folded into the target', value: fmt.num(env.folded), icon: 'x-circle',
        sub: plural(env.closed.length, 'account') + ' close outright' +
          (env.closedDormant ? ', ' + fmt.num(env.closedDormant) + ' of them dormant already' : ''),
        title: 'The recommendation on each account is in the table below: ' + plural(env.counts.keep, 'account') +
          ' kept, ' + fmt.num(env.counts.merge) + ' merged, ' + fmt.num(env.counts.close) + ' closed' },
      { label: 'Accounts in the target structure', value: fmt.num(env.target.length), icon: 'layers',
        sub: 'from ' + fmt.num(env.accounts.length) + ' today, all at ' + plural(env.targetBanks.length, 'bank') },
      { label: 'Transactions a month', value: fmt.num(env.txnsTotal), icon: 'refresh',
        sub: 'carried by the ' + fmt.num(env.accounts.length) + ' accounts today' }
    ];
    return h('div', { 'class': 'bk-kpiblock' },
      h('div', { 'class': 'bk-kpis' }, tiles.map(function (o) { return ui.statTile(o); })),
      ui.sourceTag(['erp']));
  }

  /* ------------------------------------------------------------------ current accounts */

  function accountsCard(env) {
    var st = env.st, look = env.look;
    var rows = env.accounts.map(function (a) {
      return { id: a.id, bank: a.bank, masked: a.masked, type: a.type, purpose: a.purpose, unitId: a.unitId,
        unitName: look.name(a.unitId), txnsPerMonth: a.txnsPerMonth, activity: a.activity,
        recommendation: a.recommendation, note: a.note };
    });
    var busiest = rows.slice().sort(function (x, y) { return y.txnsPerMonth - x.txnsPerMonth; })[0] || null;

    var columns = [
      { key: 'bank', label: 'Bank and account', sortable: true, width: 188,
        render: ui.cells.twoLine(function (r) { return r.type + ' - ' + r.masked; }, { maxWidth: 178 }) },
      { key: 'purpose', label: 'What it is used for', sortable: true, maxWidth: 260 },
      { key: 'unitName', label: 'Unit', sortable: true, width: 132,
        render: function (v, r) { return h('span', { 'class': 'bk-unit' }, dot(look.colour(r.unitId)), look.short(r.unitId)); } },
      { key: 'txnsPerMonth', label: 'Transactions a month', sortable: true, width: 172, format: 'num',
        title: 'Activity level in the account master - the ERP holds no transactions',
        render: ui.cells.bar(null, '--seq-500') },
      { key: 'activity', label: 'Activity', sortable: true, width: 104,
        render: function (v) { return ui.chip(ACTIVITY_LABEL[v] || v, ACTIVITY_TONE[v] || 'neutral'); } },
      { key: 'recommendation', label: 'Recommendation', sortable: true, width: 140,
        render: function (v, r) {
          var m = RECOMMENDATION[v] || { label: v, tone: 'neutral' };
          return ui.chip(m.label, m.tone, { title: r.note || '', icon: v === 'keep' ? 'check' : (v === 'close' ? 'x' : 'arrow-right') });
        } }
    ];

    return ui.card({
      title: 'All ' + plural(env.accounts.length, 'current account'),
      subtitle: plural(env.accounts.length, 'account') + ' at ' + plural(env.banks.length, 'bank') + ' carrying ' +
        plural(env.txnsTotal, 'transaction') + ' a month' +
        (busiest ? '; the busiest is ' + busiest.bank + ' ' + busiest.masked + ' with ' +
          fmt.num(busiest.txnsPerMonth) + ', ' + fmt.pct(busiest.txnsPerMonth / (env.txnsTotal || 1), 0) +
          ' of the load' : '') + '.',
      flush: true, className: 'bk-tablecard',
      actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', onClick: function () {
        ui.downloadCsv('bank-accounts.csv', [
          { key: 'bank', label: 'Bank' }, { key: 'masked', label: 'Account' }, { key: 'type', label: 'Type' },
          { key: 'purpose', label: 'Purpose' }, { key: 'unitName', label: 'Unit' },
          { key: 'txnsPerMonth', label: 'Transactions a month' }, { key: 'activity', label: 'Activity' },
          { key: 'recommendation', label: 'Recommendation' }, { key: 'note', label: 'Note' }
        ], rows);
      } }),
      body: ui.table({
        columns: columns, rows: rows, dense: true,
        sort: st.sortAcc || { key: 'txnsPerMonth', dir: 'desc' }, onSort: function (s) { st.sortAcc = s; },
        empty: 'No bank accounts in the master',
        rowClass: function (r) { return r.recommendation === 'keep' ? 'is-strong' : ''; },
        footer: { bank: 'All accounts', purpose: plural(env.counts.keep, 'account') + ' kept, ' +
          fmt.num(env.counts.merge) + ' merged, ' + fmt.num(env.counts.close) + ' closed', txnsPerMonth: env.txnsTotal }
      }),
      footer: h('div', { 'class': 'bk-foot' },
        h('p', { 'class': 'bk-note' }, ui.icon('lock', 14),
          h('span', null, 'Account numbers are held masked and no balance is stored: this system approves and ' +
            'releases payments, it does not hold the cash book.')),
        ui.sourceTag(['erp']))
    });
  }

  /* ------------------------------------------------------------------ target structure */

  function accountChip(env, id) {
    var a = env.byId[id];
    if (!a) return null;
    return ui.chip(a.masked, 'neutral', {
      outline: true, dotVar: env.look.colour(a.unitId),
      title: a.bank + ' - ' + a.purpose + ' (' + env.look.name(a.unitId) + ', ' + fmt.num(a.txnsPerMonth) + ' transactions a month)'
    });
  }

  function targetBox(env, t) {
    var ids = (t.replaces || []).filter(function (id) { return !!env.byId[id]; });
    var txns = ids.reduce(function (s, id) { return s + (env.byId[id].txnsPerMonth || 0); }, 0);
    var action = null;
    if (t.id === 'bt2') {
      var may = env.mayBatch || { ok: false, reason: '' };
      action = ui.button({
        label: 'Build a payment batch', size: 'sm', variant: 'secondary', icon: 'wallet',
        disabledReason: may.ok ? '' : may.reason,
        onClick: function () { env.ctx.navigate('approvals-payments'); }
      });
    }
    return h('div', { 'class': 'bk-target', role: 'group', 'aria-label': t.name },
      h('div', { 'class': 'bk-target__head' },
        h('span', { 'class': 'bk-target__name' }, t.name),
        h('span', { 'class': 'bk-target__bank' }, t.bank)),
      h('p', { 'class': 'bk-target__purpose' }, t.purpose),
      h('div', { 'class': 'bk-target__chips' }, ids.map(function (id) { return accountChip(env, id); })),
      h('div', { 'class': 'bk-target__foot' },
        plural(ids.length, 'account') + (ids.length === 1 ? ' folds in' : ' fold in') + ', ' +
        plural(txns, 'transaction') + ' a month'),
      action ? h('div', { 'class': 'bk-target__action' }, action) : null);
  }

  function consolidationText(env) {
    return plural(env.accounts.length, 'current account') + ' at ' + plural(env.banks.length, 'bank') + ' become ' +
      plural(env.target.length, 'account') + ' at ' + plural(env.targetBanks.length, 'bank') + ': ' +
      fmt.num(env.folded) + ' have their activity folded into the ' + fmt.num(env.target.length) + ' and ' +
      fmt.num(env.closed.length) + ' close outright (' + plural(env.closedTxns, 'transaction') +
      ' a month between them). Every credit and every payment then lands in one place, tagged by unit, so ' +
      'month-end reconciliation reads ' + plural(env.target.length, 'statement') + ' from ' +
      plural(env.targetBanks.length, 'bank') + ' instead of ' + plural(env.accounts.length, 'statement') +
      ' from ' + plural(env.banks.length, 'bank') + '.';
  }

  function structureCard(env) {
    if (!env.target.length) {
      return ui.card({ title: 'The target structure', body: ui.emptyState('No target structure in the master') });
    }
    var closed = env.closed;
    var bank = env.targetBanks[0] || '';

    var diagram = h('div', { 'class': 'bk-diagram' },
      h('div', { 'class': 'bk-source' },
        h('span', { 'class': 'bk-source__eyebrow' }, plural(env.targetBanks.length, 'bank') + ' for the whole company'),
        h('span', { 'class': 'bk-source__name' }, bank)),
      h('div', { 'class': 'bk-stem', 'aria-hidden': 'true' }),
      h('div', { 'class': 'bk-targets' }, env.target.map(function (t) { return targetBox(env, t); })));

    var closedRow = closed.length ? h('div', { 'class': 'bk-closed' },
      h('span', { 'class': 'bk-closed__label' }, ui.icon('x-circle', 14), 'Closed outright'),
      h('ul', { 'class': 'bk-closed__list' }, closed.map(function (id) {
        var a = env.byId[id];
        return h('li', { 'class': 'bk-closed__item' }, accountChip(env, id),
          h('span', { 'class': 'bk-closed__note' }, a.note || a.purpose));
      }))) : null;

    return ui.card({
      title: 'The target structure',
      subtitle: plural(env.target.length, 'account') + ' at ' + plural(env.targetBanks.length, 'bank') +
        ', each with a single job; together they carry the ' + plural(env.txnsTotal - env.closedTxns, 'transaction') +
        ' a month that survive the consolidation.',
      className: 'bk-structure',
      body: h('div', { 'class': 'bk-structure__body' }, diagram, closedRow,
        h('p', { 'class': 'bk-summary' }, consolidationText(env))),
      footer: h('div', { 'class': 'bk-foot' }, ui.sourceTag(['erp']))
    });
  }

  /* ------------------------------------------------------------------ cost centres */

  function flattenTree(node, depth, expanded, out, small) {
    if (!node) return out;
    var kids = node.children || [];
    var open = kids.length ? isExpanded(node, depth, expanded, small) : false;
    out.push({ id: node.id, label: node.label, unitId: node.unitId, spend: node.spend || 0,
      estimatedPart: node.estimatedPart || 0, depth: depth, hasChildren: kids.length > 0, open: open,
      childCount: kids.length });
    if (open) kids.forEach(function (k) { flattenTree(k, depth + 1, expanded, out, small); });
    return out;
  }

  /*
   * Default: the company and the groups whose children are themselves groups; departments start folded away, because
   * the Director's tree is 30 nodes deep. A persona whose scope is one unit has nothing to fold away - the whole tree
   * then opens, so the factory manager sees Production, Stores and Dispatch without hunting for the chevron.
   */
  var SMALL_TREE = 12;
  function defaultOpen(node, depth, small) {
    if (small) return true;
    if (depth > 1) return false;
    return (node.children || []).some(function (k) { return (k.children || []).length > 0; });
  }
  function isExpanded(node, depth, expanded, small) {
    if (Object.prototype.hasOwnProperty.call(expanded, node.id)) return !!expanded[node.id];
    return defaultOpen(node, depth, small);
  }

  function treeCell(env, row) {
    var label = h('span', { 'class': 'bk-tree__label' },
      row.unitId ? dot(env.look.colour(row.unitId)) : null, row.label);
    var indent = h('span', { 'class': 'bk-tree__indent', 'aria-hidden': 'true', style: { width: (row.depth * 16) + 'px' } });
    if (!row.hasChildren) {
      return h('div', { 'class': 'bk-tree bk-tree--leaf' }, indent, h('span', { 'class': 'bk-tree__spacer', 'aria-hidden': 'true' }), label);
    }
    var btn = h('button', {
      'class': 'bk-tree__toggle', type: 'button', 'aria-expanded': String(row.open),
      title: (row.open ? 'Collapse ' : 'Expand ') + row.label + ' (' + plural(row.childCount, 'cost centre') + ')',
      onClick: function () {
        env.st.expanded[row.id] = !row.open;
        env.ctx.rerender();
      }
    }, ui.icon(row.open ? 'chevron-down' : 'chevron-right', 14), label);
    return h('div', { 'class': 'bk-tree' }, indent, btn);
  }

  function groupsChart(env, parent) {
    if (env.groups.length < 2 || !MK.charts) return null;
    /* the plot is a third of the content column: a unit's short name keeps the category axis readable */
    function short(g) { return g.unitId ? env.look.short(g.unitId) : g.label; }
    var sorted = env.groups.slice().sort(function (a, b) { return (b.spend || 0) - (a.spend || 0); });
    var top = sorted[0], total = env.tree.spend || 0;
    var second = sorted[1];
    var sub = total > 0
      ? short(top) + ' carries ' + fmt.pct(top.spend / total, 1) + ' of the ' + fmt.inr(total) +
        ' the company spent, ' + fmt.inr(top.spend - second.spend) + ' more than ' + short(second) + '.'
      : 'Nothing was posted to a cost centre in this month.';
    /* the estimated part and the source belong to the block, not the plot: chartFoot() carries them once */
    var note = 'Bars count inter-unit charges at both ends - once at the outlet that receives the transfer and once ' +
      'at the central kitchen that makes it. The tree beside them says how much.';
    return MK.charts.mount(parent, {
      id: 'bk-groups', kind: 'hbar', format: 'inr', height: 232,
      title: 'Spend by cost-centre group', subtitle: sub, note: note,
      data: {
        categories: sorted.map(short),
        values: sorted.map(function (g) { return g.spend || 0; }),
        name: 'Spend', colourVar: '--seq-500', categoryHeader: 'Cost centre group'
      }
    });
  }

  /* the chart is not a ui.card, so its source line (and the estimate badge the bars carry) is appended beside it */
  function chartFoot(env) {
    var est = env.spend.estimatedPart || 0;
    return h('div', { 'class': 'bk-foot' },
      est ? h('p', { 'class': 'bk-note' }, ui.estimateBadge(),
        h('span', null, fmt.inr(est) + ' of the bars is computed at the contracted aggregator rates, not settled; ' +
          'the tree splits it out per cost centre.')) : null,
      ui.sourceTag(est ? ['erp', 'estimate'] : ['erp']));
  }

  function costCentreCard(env) {
    var st = env.st;
    if (!env.tree) {
      return ui.card({ title: 'Cost centres', body: ui.emptyState('No cost centre in your scope',
        'Spend is shown for the units you may see.', { icon: 'layers' }) });
    }
    var total = env.tree.spend || 0;
    var nodes = countNodes(env.tree);
    var rows = flattenTree(env.tree, 0, st.expanded, [], nodes <= SMALL_TREE);
    var period = env.spend.period || {};
    var est = env.spend.estimatedPart || 0;

    var monthSelect = ui.select({
      ariaLabel: 'Month', size: 'sm', value: st.month,
      options: env.months.map(function (m) { return { value: m, label: D.monthLabel(m, true) }; }),
      onChange: function (v) { st.month = v; env.ctx.rerender(); }
    });

    var columns = [
      { key: 'label', label: 'Cost centre', render: function (v, r) { return treeCell(env, r); } },
      { key: 'spend', label: 'Spend', format: 'inr', width: 240, render: ui.cells.bar(total, '--seq-500') },
      { key: 'share', label: 'Share', format: 'pct', align: 'right', width: 88,
        title: 'Share of company spend for the month' },
      { key: 'estimatedPart', label: 'of which estimated', format: 'inr', align: 'right', width: 132,
        title: 'Aggregator costs of a week that has not been settled yet, computed at the contracted rates',
        render: function (v) { return v ? h('span', { 'class': 'mk-num' }, fmt.inr(v)) : dash(); } }
    ];

    var table = ui.table({
      columns: columns, dense: true,
      rows: rows.map(function (r) {
        r.share = total > 0 ? r.spend / total : 0;
        return r;
      }),
      rowClass: function (r) { return r.depth === 0 ? 'is-strong' : (r.depth > 2 ? 'is-muted' : ''); },
      empty: 'No cost centre in your scope'
    });

    var notes = [];
    if (env.spend.interUnitCharges) {
      notes.push(h('p', { 'class': 'bk-note' }, ui.icon('info', 14),
        h('span', null, 'Spend counts inter-unit charges twice - once at the outlet that receives the transfer and ' +
          'once at the central kitchen that makes it: ' + fmt.inr(env.spend.interUnitCharges) + ' this month. After ' +
          'eliminating them the company spends ' + fmt.inr(env.tree.spendAfterElimination || 0) + '.')));
    }
    if (est) {
      notes.push(h('p', { 'class': 'bk-note' }, ui.estimateBadge(),
        h('span', null, fmt.inr(est) + ' of this month is computed at the contracted aggregator rates; the actuals ' +
          'arrive with the weekly statements and are never blended into the settled figures.')));
    }

    return ui.card({
      title: 'Cost-centre structure',
      subtitle: 'Company, region, unit and department for ' + (period.label || st.month) + '. ' +
        plural(rows.length, 'row') + ' shown of ' + plural(nodes, 'cost centre') +
        (rows.length < nodes ? '; open a row to see the departments under it.' : '.'),
      actions: monthSelect, flush: true, className: 'bk-treecard',
      body: table,
      footer: h('div', { 'class': 'bk-foot' }, notes, ui.sourceTag(est ? ['erp', 'estimate'] : ['erp']))
    });
  }

  function countNodes(node) {
    if (!node) return 0;
    return 1 + (node.children || []).reduce(function (t, k) { return t + countNodes(k); }, 0);
  }

  /* ------------------------------------------------------------------ render */

  function render(rootEl, ctx) {
    if (!ctx.state.expanded) ctx.state.expanded = {};
    var env = buildEnv(ctx);

    rootEl.appendChild(intro(env));
    rootEl.appendChild(ui.callout('info', 'No balances on this screen',
      'The ERP approves and releases payments; it does not hold the cash book. What it knows about a bank account ' +
      'is its bank, a masked last four, what it is used for, which unit it belongs to and how busy it is.'));

    if (!env.accounts.length) {
      rootEl.appendChild(ui.emptyState('No bank account master', 'The account structure is part of the master data.', { icon: 'bank' }));
    } else {
      rootEl.appendChild(kpis(env));
      rootEl.appendChild(accountsCard(env));
      rootEl.appendChild(structureCard(env));
    }

    rootEl.appendChild(ui.sectionTitle('Cost centres',
      'Where the spend sits once every bill, payroll line and accrual is posted - the structure the target accounts are tagged against.'));

    if (env.groups.length >= 2) {
      var split = h('div', { 'class': 'bk-split' });
      var plot = h('div', { 'class': 'bk-plot' });
      split.appendChild(plot);
      split.appendChild(costCentreCard(env));
      rootEl.appendChild(split);
      var chart = groupsChart(env, plot);
      if (chart) plot.appendChild(chartFoot(env));
      else plot.appendChild(ui.emptyState('No group to compare', null, { compact: true }));
    } else {
      rootEl.appendChild(costCentreCard(env));
    }
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/banking',
    group: 'Banking',
    title: 'Banking',
    subtitle: 'Current accounts, target structure and cost centres',
    units: 'all',
    roles: null,
    filters: [],
    render: render
  });
})(window);
