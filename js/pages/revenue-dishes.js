/*
 * #/revenue/dishes - Dishes (client brief area 1: dish-level reporting, markup audit by dish).
 *
 * Blocks: KPI row, league table of the menu (portions, net sales, share, realised price, recipe cost, contribution,
 * menu-engineering class), menu-engineering scatter with what each quadrant asks for, dish x channel heat table, and
 * "Price and markup by channel": POS price, the selected outlet's aggregator list price, markup and the estimated net
 * realisation per aggregator portion after that outlet's effective take rate.
 *
 * Sales come from MK.data.dishes / MK.data.matrix (Petpooja POS), recipe costs from MK.finance through MK.data.dishes
 * (captured in ERP), markup exceptions and take rates from MK.data.auditFlags (settled statements). The page adds no
 * contract maths of its own: realisation per portion is the data layer's figure for a flagged dish, and the same
 * documented formula on the data layer's take rate and discount share for the others. Menu classes, thresholds and the
 * stale-price anomaly are found by the data layer's rules - no dish is named in code.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;

  /* ------------------------------------------------------------------ vocabulary */

  var MEASURES = {
    qty: { label: 'Portions', noun: 'portions', format: 'num' },
    netSales: { label: 'Net sales', noun: 'net sales', format: 'inr' }
  };
  var MEASURE_OPTIONS = [{ value: 'qty', label: 'Portions' }, { value: 'netSales', label: 'Net sales' }];
  var SHOW_OPTIONS = [{ value: 'value', label: 'Value' }, { value: 'row', label: '% of dish' }, { value: 'col', label: '% of channel' }];

  /* menu-engineering classes as MK.data.dishes names them; quadrant captions in the order the scatter wants (top right, top left, bottom left, bottom right) */
  var CLASSES = {
    star: { label: 'Star', plural: 'Stars', tone: 'good', action: 'Popular and profitable. Protect them: keep them prominent, hold price and portion.' },
    plowhorse: { label: 'Plough horse', plural: 'Plough horses', tone: 'info', action: 'Popular but thin. Test a small price rise or trim the recipe cost; never discount them.' },
    puzzle: { label: 'Puzzle', plural: 'Puzzles', tone: 'warn', action: 'Profitable but slow. Give them a better menu position, a photo, a combo with a best seller.' },
    dog: { label: 'Dog', plural: 'Dogs', tone: 'neutral', action: 'Neither popular nor profitable. Simplify or drop, unless the dish completes a basket.' }
  };
  var CLASS_ORDER = ['star', 'plowhorse', 'puzzle', 'dog'];
  var QUADRANT_ORDER = ['star', 'puzzle', 'dog', 'plowhorse'];

  var STATUS = {
    stale: { rank: 0, label: 'Stale list price', tone: 'critical', icon: 'alert-triangle', title: 'The POS price changed and the aggregator list was not updated (audit flag, high).' },
    flagged: { rank: 1, label: 'Below take rate', tone: 'serious', icon: 'alert-triangle', title: 'Audit flag: the aggregator markup is below the effective take rate of the outlet.' },
    below: { rank: 2, label: 'Below POS price', tone: 'warn', icon: 'arrow-down', title: 'An aggregator portion is estimated to net less than the POS price.' },
    ok: { rank: 3, label: 'Above POS price', tone: 'good', icon: 'check', title: 'An aggregator portion is estimated to net at least the POS price.' },
    unknown: { rank: 4, label: 'No take rate', tone: 'neutral', icon: 'info', title: 'No settled statement covers this outlet, so the net per portion cannot be estimated.' },
    unlisted: { rank: 5, label: 'Not listed', tone: 'neutral', icon: 'minus', title: 'The dish is not sold at this outlet.' }
  };

  var SCATTER_HEIGHT = 420;          /* px - layout, not data */
  var MATRIX_CELLS_PCT = 45;         /* share of the matrix width given to the channel cells */
  var TOP_N = 3;                     /* dishes counted in the concentration tile */
  var ITEMS_FIELD = 'order.items';   /* capability behind every dish-level figure (docs/DATA-FEASIBILITY.md section 3) */

  /* ------------------------------------------------------------------ small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function has(list, value) { return Array.isArray(list) && list.indexOf(value) !== -1; }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''; }
  function plural(n, word) { return fmt.num(n) + ' ' + word + (n === 1 ? '' : (/sh$/.test(word) ? 'es' : 's')); }
  function sum(list) { return (list || []).reduce(function (t, v) { return t + (isNum(v) ? v : 0); }, 0); }

  function andList(items) {
    var list = (items || []).filter(Boolean);
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function rangeLabel(from, to) {
    if (!from || !to) return '';
    if (from === to) return MK.dates.label(from, 'd MMM yyyy');
    var sameYear = from.slice(0, 4) === to.slice(0, 4);
    return MK.dates.label(from, sameYear ? 'd MMM' : 'd MMM yyyy') + ' - ' + MK.dates.label(to, 'd MMM yyyy');
  }

  function say(measure, v) { return !isNum(v) ? '-' : (measure === 'netSales' ? fmt.inr(v) : fmt.num(v)); }

  function extremes(values) {
    var hi = -1, lo = -1;
    (values || []).forEach(function (v, i) {
      if (!isNum(v)) return;
      if (hi === -1 || v > values[hi]) hi = i;
      if (lo === -1 || v < values[lo]) lo = i;
    });
    return hi === -1 ? null : { hi: hi, lo: lo };
  }

  function categoryLabel(id) {
    var list = (MK.config && MK.config.categories) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
    return id || '';
  }

  function dishSubline(row) {
    return [categoryLabel(row.category), row.veg ? 'veg' : null, row.isAttach ? 'add-on' : null].filter(Boolean).join(' - ');
  }

  /* ---- channels: the POS channel is what the business calls "in-store" */

  function channels() { return (MK.config && MK.config.channels) || []; }
  function channelInfo(id) {
    var list = channels();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function isAggregator(col) { var c = channelInfo(col.id); return !!c && c.kind === 'aggregator'; }
  function chLong(col) { var c = channelInfo(col.id); return c && c.kind === 'pos' && c.short ? c.short + ' (' + c.label + ')' : col.label; }

  function sourceOf(result) { return (result && result.source) || 'petpooja'; }

  /* ---- DOM bits */

  function tableFoot(children) { return h('div', { 'class': 'ds-tablefoot' }, children); }

  function note(content, iconName) {
    return h('p', { 'class': 'ds-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, content));
  }

  /**
   * The provisional caption every sales result carries (API.md section 4.5): a range running past Swiggy's last payout
   * annexure is provisional on the restaurant-funded share of the Swiggy discount, and so on dish net sales.
   * `null` for a settled range, with Swiggy out of the selection and with an empty scope.
   */
  function provisionalNote(result) {
    var p = result && result.provisional;
    if (!p || !p.swiggyDiscountSplitFrom) return null;
    return note('Swiggy discount split confirmed with the annexure: Swiggy orders from ' +
      MK.dates.label(p.swiggyDiscountSplitFrom, 'd MMM yyyy') +
      ' are as relayed to the POS, so their restaurant-funded discount and net sales are provisional.', 'info');
  }

  /** Two-line column header: keeps a nine-column table inside the page at 1280px. */
  function th2(top, bottom) { return h('span', { 'class': 'ds-th2' }, top, h('br'), h('span', { 'class': 'ds-th2__sub' }, bottom)); }

  /** Figure with a muted second line (a total under a per-portion value); the rows are two lines tall already. */
  function stacked(main, sub) { return h('div', { 'class': 'ds-stacked' }, h('div', null, main), h('div', { 'class': 'mk-xs mk-muted' }, sub)); }

  /** Columns marked hidden exist for the CSV only. */
  function visible(columns) { return columns.filter(function (c) { return !c.hidden; }); }

  /** Columns for MK.ui.downloadCsv: string labels, raw values, presentation-only columns left out. */
  function csvColumns(columns) {
    return columns.filter(function (c) { return c.csv !== false; }).map(function (c) { return { key: c.key, label: c.csvLabel || c.label, value: c.csvValue }; });
  }

  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[revenue-dishes] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  /* ------------------------------------------------------------------ header: purpose, scope, KPI row */

  function intro(env) {
    var s = env.s;
    return h('p', { 'class': 'ds-intro' },
      'What sells, what it earns and where the price list leaks: the menu ranked, each dish placed by popularity and contribution, its channel mix, and the aggregator markup tested against what the aggregators keep. ',
      h('strong', { 'class': 'ds-intro__period' }, rangeLabel(s.from, s.to) + ', ' + plural(s.days, 'day') + '.'));
  }

  function scopeNote(ctx) {
    var allowed = MK.session.allowedOutletIds();
    var all = MK.session.OUTLET_IDS || [];
    if (!allowed.length || allowed.length >= all.length) return null;
    var names = ((MK.config && MK.config.outlets) || []).filter(function (o) { return has(allowed, o.id); }).map(function (o) { return o.name; });
    var who = ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel : 'Your role';
    return ui.callout('info', null, who + ' sees ' + andList(names) + ' only. Every figure on this page is already limited to that scope, and the price table offers ' +
      (allowed.length === 1 ? 'that outlet\'s list' : 'those outlets\' lists') + '.', { icon: 'lock' });
  }

  function totalsOf(d) {
    var rows = d.rows || [], costed = d.hasCost ? rows.filter(function (r) { return isNum(r.theoreticalCost); }) : [];
    var cost = sum(costed.map(function (r) { return r.theoreticalCost; })), net = sum(costed.map(function (r) { return r.netSales; })), qty = sum(costed.map(function (r) { return r.qty; }));
    return { cost: cost, contribution: sum(costed.map(function (r) { return r.contribution; })), costedNet: net, costedQty: qty,
      foodCostPct: net ? cost / net : null, contributionPerPortion: qty ? (net - cost) / qty : null, complete: costed.length === rows.length };
  }

  function kpiBlock(env, goToPrices) {
    var s = env.s, d = env.d, rows = d.rows, t = env.totals, tiles = [];
    var prev = s.prev && s.prev.from ? s.prev : null;
    var same = prev && prev.complete !== false && prev.days === s.days;
    var qtyDelta = !prev ? null : (same ? fmt.delta(s.items, prev.items) : fmt.delta(s.items / s.days, prev.items / prev.days));
    if (qtyDelta && qtyDelta.value === null) qtyDelta = null;

    tiles.push({ label: 'Portions sold', value: fmt.num(d.totals.qty), delta: qtyDelta, icon: 'dish',
      sub: fmt.num(s.itemsPerOrder, 2) + ' per order', title: prev ? 'Change against ' + rangeLabel(prev.from, prev.to) + (same ? '' : ' (daily averages)') + '.' : null });

    var sold = rows.filter(function (r) { return r.qty > 0; });
    if (sold.length) {
      var best = sold[0];
      tiles.push({ label: 'Best seller', value: fmt.pct(best.salesShare), sub: (best.short || best.name) + ', share of net sales', title: best.name + ': ' + fmt.inr(best.netSales) + ' from ' + fmt.num(best.qty) + ' portions.' });
      var top = sold.slice(0, TOP_N);
      tiles.push({ label: 'Top ' + fmt.num(top.length) + ' dishes', value: fmt.pct(sum(top.map(function (r) { return r.salesShare; }))),
        sub: 'of net sales from ' + fmt.num(top.length) + ' of ' + fmt.num(sold.length) + ' dishes', title: andList(top.map(function (r) { return r.name; })) });
    }

    if (d.hasCost && isNum(t.foodCostPct)) {
      tiles.push({ label: 'Recipe food cost', value: fmt.pct(t.foodCostPct), sub: fmt.inr(t.cost) + ' at recipe',
        title: 'Theoretical cost of the portions sold (factory items at transfer price, local items, dish packaging) as a share of their net sales. Actual food cost, with wastage, is on Costs / Food cost.' });
      /* the data layer's own weighted average, so the tile and the line across the menu-engineering chart are one figure */
      var avgContribution = d.thresholds && isNum(d.thresholds.contributionPerPortion) ? d.thresholds.contributionPerPortion : t.contributionPerPortion;
      tiles.push({ label: 'Avg contribution', value: fmt.inrFull(Math.round(avgContribution)), sub: 'per portion; ' + fmt.inr(t.contribution) + ' in all',
        title: 'Net sales less recipe cost, per portion sold - the line that splits the menu-engineering chart.' });
    }

    var flags = env.markupFlags;
    if (flags.length) {
      var stale = flags.some(function (x) { return x.data && x.data.stalePriceChange; });
      tiles.push({ label: 'Markup alerts', value: fmt.num(flags.length), tone: stale ? 'critical' : 'warn', onClick: goToPrices,
        sub: fmt.inr(sum(flags.map(function (x) { return x.amount; }))) + ' lost on ' + (flags.length === 1 ? 'that dish' : 'those dishes'),
        title: 'Dishes the audit rule flags: the aggregator markup does not even cover the effective take rate of the outlet, or a POS price change never reached the aggregator list. ' +
          'The figure is what their aggregator portions netted below the POS price in the period. Opens the price table below.' });
    } else {
      tiles.push({ label: 'Markup alerts', value: fmt.num(0), sub: 'no dish flagged in the period', onClick: goToPrices });
    }

    return h('div', { 'class': 'ds-kpiblock' },
      h('div', { 'class': 'ds-kpis', dataset: { count: String(tiles.length) } }, tiles.map(function (x) { return ui.statTile(x); })),
      provisionalNote(s),
      ui.sourceTag(d.hasCost ? [sourceOf(d), 'erp'] : sourceOf(d)));
  }

  /* ------------------------------------------------------------------ A: league table */

  function classChip(id) {
    var c = CLASSES[id];
    return c ? ui.chip(c.label, c.tone) : h('span', { 'class': 'mk-faint' }, '-');
  }

  function takeawayLeague(env) {
    var d = env.d, sold = d.rows.filter(function (r) { return r.qty > 0; }), parts = [];
    if (!sold.length) return '';
    var best = sold[0];
    parts.push(best.name + ' leads with ' + fmt.inr(best.netSales) + ' (' + fmt.pct(best.salesShare) + ' of net sales)' +
      (sold.length > 1 ? '; ' + sold[sold.length - 1].name + ' is the smallest at ' + fmt.inr(sold[sold.length - 1].netSales) + '.' : '.'));
    if (d.hasCost) {
      var costed = sold.filter(function (r) { return isNum(r.contribution); });
      var cx = extremes(costed.map(function (r) { return r.contribution; })), fx = extremes(costed.map(function (r) { return r.foodCostPct; }));
      if (cx) parts.push(costed[cx.hi].name + ' earns the most contribution, ' + fmt.inr(costed[cx.hi].contribution) + '.');
      if (fx && fx.hi !== fx.lo) parts.push('Recipe cost runs from ' + fmt.pct(costed[fx.lo].foodCostPct) + ' (' + (costed[fx.lo].short || costed[fx.lo].name) + ') to ' +
        fmt.pct(costed[fx.hi].foodCostPct) + ' (' + (costed[fx.hi].short || costed[fx.hi].name) + ') of net sales.');
    }
    return parts.join(' ');
  }

  function leagueBlock(env, st) {
    var d = env.d, t = env.totals;
    var columns = [
      { key: 'name', label: 'Dish', render: ui.cells.twoLine(dishSubline, { maxWidth: 220 }) },
      { key: 'qty', label: 'Portions', format: 'num' },
      { key: 'netSales', label: 'Net sales', format: 'inr', render: ui.cells.bar(null, '--series-1') },
      { key: 'salesShare', label: 'Share', format: 'pct', csvLabel: 'Share of net sales' },
      { key: 'avgRealisation', label: th2('Realised', 'per portion'), csvLabel: 'Average realised price per portion', align: 'right',
        title: 'Net sales divided by portions: after restaurant-funded discounts, with the order\'s packaging charge spread over its lines, net of GST.',
        render: function (v) { return isNum(v) ? fmt.inrFull(Math.round(v)) : '-'; } }
    ];
    if (d.hasCost) {
      columns.push({ key: 'foodCostPct', label: th2('Food cost', 'at recipe'), csvLabel: 'Theoretical food cost %', format: 'pct', render: ui.cells.heat(null, null),
        title: 'Theoretical: recipe cost of the portions sold as a share of their net sales. Darker is costlier.' });
      columns.push({ key: 'contributionPerPortion', label: th2('Contribution', 'per portion'), csvLabel: 'Contribution per portion', align: 'right',
        title: 'Net sales less recipe cost, per portion; the second line is the total contribution of the dish in the period.',
        render: function (v, row) { return isNum(v) ? stacked(fmt.inrFull(Math.round(v)), fmt.inr(row.contribution) + ' in all') : '-'; } });
      columns.push({ key: 'contribution', label: '', csvLabel: 'Contribution in the period', hidden: true });
      columns.push({ key: 'menuClass', label: 'Class', sortValue: function (row) { var i = CLASS_ORDER.indexOf(row.menuClass); return i === -1 ? null : i; },
        render: function (v) { return classChip(v); }, csvValue: function (row) { return CLASSES[row.menuClass] ? CLASSES[row.menuClass].label : ''; } });
    }
    var footer = { name: plural(d.rows.length, 'dish'), qty: d.totals.qty, netSales: d.totals.netSales, salesShare: d.totals.netSales ? 1 : null,
      avgRealisation: d.totals.qty ? fmt.inrFull(Math.round(d.totals.netSales / d.totals.qty)) : '' };
    if (d.hasCost) {
      footer.foodCostPct = isNum(t.foodCostPct) ? fmt.pct(t.foodCostPct) : '';
      footer.contributionPerPortion = isNum(t.contributionPerPortion) ? stacked(fmt.inrFull(Math.round(t.contributionPerPortion)), fmt.inr(t.contribution) + ' in all') : '';
      footer.menuClass = '';
    }

    var foot = [note('Net sales are net of GST and of restaurant-funded discounts, with each order\'s packaging charge spread over its lines, so the dishes add up to total net sales. ' +
      (d.hasCost ? 'Food cost is theoretical - the recipe at this month\'s prices (factory items at transfer price, local items, dish packaging for delivery and takeaway); wastage shows on Costs / Food cost.'
        : 'Recipe costs are not loaded, so cost and contribution are left out.'), 'info')];
    foot.push(ui.sourceTag(d.hasCost ? [sourceOf(d), 'erp'] : sourceOf(d)));

    return ui.card({ title: 'Menu league table', subtitle: takeawayLeague(env), flush: true,
      actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', title: 'Download this table',
        onClick: function () { ui.downloadCsv('dish-league_' + env.s.from + '_' + env.s.to + '.csv', csvColumns(columns), d.rows); } }),
      body: [ui.table({ columns: visible(columns), rows: d.rows, footer: footer, sortable: true, sort: st.leagueSort || { key: 'netSales', dir: 'desc' },
        onSort: function (s) { st.leagueSort = s; }, empty: 'No dishes sold for this selection' }), tableFoot(foot)] });
  }

  /* ------------------------------------------------------------------ B: menu engineering */

  function classGroups(env) {
    var rows = env.d.rows.filter(function (r) { return r.qty > 0 && CLASSES[r.menuClass]; });
    var net = sum(rows.map(function (r) { return r.netSales; })), con = sum(rows.map(function (r) { return r.contribution; }));
    return CLASS_ORDER.map(function (id) {
      var list = rows.filter(function (r) { return r.menuClass === id; });
      return { id: id, def: CLASSES[id], rows: list, salesShare: net ? sum(list.map(function (r) { return r.netSales; })) / net : null,
        contributionShare: con ? sum(list.map(function (r) { return r.contribution; })) / con : null };
    });
  }

  function takeawayMenu(env, groups) {
    var thr = env.d.thresholds, parts = [];
    var names = function (g) { return andList(g.rows.map(function (r) { return r.short || r.name; })); };
    var avg = fmt.inrFull(Math.round(thr.contributionPerPortion));
    var by = {};
    groups.forEach(function (g) { by[g.id] = g; });
    var stars = by.star.rows.length, horses = by.plowhorse.rows.length, dogs = by.dog.rows.length;
    if (stars) {
      parts.push(names(by.star) + (stars === 1 ? ' is the star' : ' are the stars') + ': popular and above the ' + avg + ' average contribution per portion (' +
        fmt.pct(by.star.contributionShare) + ' of all contribution).');
    } else {
      parts.push('No dish is both popular and above the ' + avg + ' average contribution per portion.');
    }
    if (horses) parts.push(names(by.plowhorse) + (horses === 1 ? ' brings ' : ' bring ') + fmt.pct(by.plowhorse.salesShare) + ' of net sales but ' + (horses === 1 ? 'earns' : 'earn') + ' below that average.');
    if (dogs) parts.push(names(by.dog) + (dogs === 1 ? ' neither sells nor earns.' : ' neither sell nor earn.'));
    return parts.join(' ');
  }

  function menuBlock(env) {
    var d = env.d;
    if (!d.hasCost || !d.thresholds) {
      return ui.card({ title: 'Menu engineering', body: ui.emptyState('Recipe costs are not loaded',
        'The popularity and contribution view needs the recipe cost of every dish from the cost model. Sales figures above are unaffected.', { icon: 'calculator', compact: true }) });
    }
    var groups = classGroups(env), thr = d.thresholds;
    var points = d.rows.filter(function (r) { return r.qty > 0 && isNum(r.contributionPerPortion) && isNum(r.popularity); }).map(function (r) {
      return { id: r.id, name: r.short || r.name, x: r.popularity, y: Math.round(r.contributionPerPortion), size: r.netSales };
    });
    var attach = d.rows.filter(function (r) { return r.isAttach && r.qty > 0; }).map(function (r) { return r.short || r.name; });
    var chart = MK.charts.mount(null, { id: 'ds-menu', kind: 'scatter', height: SCATTER_HEIGHT, title: 'Menu engineering: popularity against contribution', subtitle: takeawayMenu(env, groups),
      data: { points: points, xLabel: 'Popularity (share of portions sold)', yLabel: 'Contribution per portion', sizeLabel: 'Net sales',
        xFormat: 'pct', yFormat: 'inrFull', sizeFormat: 'inr', nameHeader: 'Dish',
        quadrants: { x: thr.popularity, y: thr.contributionPerPortion, labels: QUADRANT_ORDER.map(function (id) { return CLASSES[id].plural; }) } },
      note: thr.rule + ' (lines at ' + fmt.pct(thr.popularity) + ' and ' + fmt.inrFull(Math.round(thr.contributionPerPortion)) + '). Dot size is net sales.' +
        (attach.length ? ' ' + andList(attach) + (attach.length === 1 ? ' is an add-on' : ' are add-ons') + ': low contribution per portion by design, judge ' + (attach.length === 1 ? 'it' : 'them') + ' by how often ' + (attach.length === 1 ? 'it rides' : 'they ride') + ' along.' : '') });
    chart.el.appendChild(ui.sourceTag([sourceOf(d), 'erp']));

    var panel = ui.card({ title: 'What each quadrant asks for', subtitle: 'The standard menu-engineering playbook, applied to the dishes in the selection',
      body: h('div', { 'class': 'ds-classes' }, groups.map(function (g) {
        return h('div', { 'class': ['ds-class', g.rows.length ? '' : 'is-empty'] },
          h('div', { 'class': 'ds-class__head' }, ui.chip(g.def.plural, g.def.tone), h('span', { 'class': 'ds-class__count mk-num' }, plural(g.rows.length, 'dish')),
            g.rows.length ? h('span', { 'class': 'ds-class__shares mk-num' }, fmt.pct(g.salesShare) + ' of net sales, ' + fmt.pct(g.contributionShare) + ' of contribution') : null),
          g.rows.length ? h('div', { 'class': 'ds-class__dishes' }, andList(g.rows.map(function (r) { return r.short || r.name; }))) : null,
          h('div', { 'class': 'ds-class__action' }, g.rows.length ? g.def.action : 'No dish in this quadrant for the selection.'));
      })),
      footer: ui.sourceTag([sourceOf(d), 'erp']) });

    return h('div', { 'class': 'mk-grid mk-grid--12 ds-menugrid' }, h('div', { 'class': 'mk-col-7 ds-cell' }, chart.el), h('div', { 'class': 'mk-col-5 ds-cell' }, panel));
  }

  /* ------------------------------------------------------------------ C: dish x channel heat table */

  function takeawayMatrix(measure, m) {
    var def = MEASURES[measure];
    if (!m.rows.length || !m.cols.length) return '';
    var agg = m.cols.filter(isAggregator);
    if (!agg.length || agg.length === m.cols.length) {
      var cx = extremes(m.colTotals), rx = extremes(m.rowTotals);
      if (m.cols.length > 1 && cx) return chLong(m.cols[cx.hi]) + ' carries the most ' + def.noun + ': ' + say(measure, m.colTotals[cx.hi]) + ' of ' + say(measure, m.total) + '.';
      return rx ? 'Only ' + chLong(m.cols[0]) + ' is in the selection: ' + m.rows[rx.hi].label + ' leads with ' + say(measure, m.rowTotals[rx.hi]) + ' of ' + say(measure, m.total) + (measure === 'qty' ? ' portions.' : '.') : '';
    }
    var dep = m.rows.map(function (r, i) {
      if (!(m.rowTotals[i] > 0)) return null;
      var a = 0;
      m.cols.forEach(function (c, j) { if (isAggregator(c)) a += m.values[i][j]; });
      return a / m.rowTotals[i];
    });
    var ex = extremes(dep), via = andList(agg.map(function (c) { return c.label; }));
    if (!ex) return '';
    var all = m.total ? sum(m.cols.map(function (c, j) { return isAggregator(c) ? m.colTotals[j] : 0; })) / m.total : null;
    if (ex.hi === ex.lo) return m.rows[ex.hi].label + ': ' + fmt.pct(dep[ex.hi]) + ' of ' + def.noun + ' through ' + via + '.';
    return 'Most delivery-led: ' + m.rows[ex.hi].label + ', ' + fmt.pct(dep[ex.hi]) + ' of its ' + def.noun + ' through ' + via + '; least: ' + m.rows[ex.lo].label + ' with ' +
      fmt.pct(dep[ex.lo]) + '. Across the menu it is ' + fmt.pct(all) + '.';
  }

  function matrixBlock(env, st) {
    var subtitle = h('span', null, '');
    var body = h('div', { 'class': 'ds-matrix' });
    var current = { columns: [], rows: [] };

    function paint() {
      var measure = st.mMeasure, show = st.mShow, def = MEASURES[measure];
      var m = MK.data.matrix(env.f, 'dish', 'channel', measure);
      var share = show !== 'value';
      var rows = m.rows.map(function (r, i) {
        var row = { id: r.id, label: r.label, sub: dishSubline(env.dishById[r.id] || r), total: m.rowTotals[i], share: m.total ? m.rowTotals[i] / m.total : null };
        m.cols.forEach(function (c, j) {
          var v = m.values[i][j];
          row['c_' + c.id] = show === 'row' ? (m.rowTotals[i] ? v / m.rowTotals[i] : null) : (show === 'col' ? (m.colTotals[j] ? v / m.colTotals[j] : null) : v);
        });
        return row;
      }).filter(function (row) { return row.total > 0; });
      var flat = [];
      rows.forEach(function (row) { m.cols.forEach(function (c) { if (isNum(row['c_' + c.id])) flat.push(row['c_' + c.id]); }); });
      var hi = flat.length ? Math.max.apply(null, flat) : 0;
      var cellFormat = share ? 'pct' : def.format, cellWidth = Math.floor(MATRIX_CELLS_PCT / Math.max(1, m.cols.length)) + '%';

      var columns = [{ key: 'label', label: 'Dish', render: ui.cells.twoLine('sub', { maxWidth: 240 }) }];
      m.cols.forEach(function (c) {
        var blind = MK.data.can(c.id, ITEMS_FIELD) === 'no';
        columns.push(blind
          ? { key: 'c_' + c.id, label: chLong(c), align: 'right', sortable: false, csv: false, render: function () { return ui.notProvided(c.label); } }
          : { key: 'c_' + c.id, label: chLong(c), format: cellFormat, align: 'right', width: cellWidth, render: ui.cells.heat(0, hi) });
      });
      columns.push({ key: 'total', label: 'All channels', format: def.format, render: ui.cells.bar(null, '--series-1') });
      columns.push({ key: 'share', label: 'Share', format: 'pct', csvLabel: 'Share of ' + def.noun });

      var footer = { label: 'All dishes', total: m.total, share: m.total ? fmt.pct(1) : '' }, mix = { label: 'Channel share', total: '', share: '' };
      m.cols.forEach(function (c, j) {
        var part = m.total ? m.colTotals[j] / m.total : null;
        footer['c_' + c.id] = show === 'row' ? part : (show === 'col' ? (m.colTotals[j] ? 1 : null) : m.colTotals[j]);
        mix['c_' + c.id] = fmt.pct(part);
      });

      current = { columns: columns, rows: rows };
      subtitle.textContent = takeawayMatrix(measure, m);
      ui.clear(body);
      body.appendChild(ui.table({ columns: columns, rows: rows, footer: show === 'value' && m.cols.length > 1 ? [footer, mix] : [footer], sortable: true,
        sort: st.mSort || { key: 'total', dir: 'desc' }, onSort: function (s) { st.mSort = s; }, empty: 'No dishes sold for this selection' }));
      var reading = show === 'row' ? 'Each row adds up to ' + fmt.pct(1, 0) + ': how a dish\'s ' + def.noun + ' split by channel.'
        : (show === 'col' ? 'Each column adds up to ' + fmt.pct(1, 0) + ': what a channel\'s ' + def.noun + ' are made of.'
          : 'Darker cells carry more ' + def.noun + '. Aggregator net sales are at aggregator menu prices, so their share of net sales runs above their share of portions.');
      body.appendChild(tableFoot([note(reading, 'info'), ui.sourceTag(sourceOf(m))]));
    }

    paint();
    return ui.card({ title: 'Dish by channel', subtitle: subtitle, flush: true, body: body, actions: [
      ui.segmented({ ariaLabel: 'Measure', size: 'sm', value: st.mMeasure, options: MEASURE_OPTIONS, onChange: function (v) { st.mMeasure = v; paint(); } }),
      ui.segmented({ ariaLabel: 'Show cells as', size: 'sm', value: st.mShow, options: SHOW_OPTIONS, onChange: function (v) { st.mShow = v; paint(); } }),
      ui.button({ label: 'CSV', icon: 'download', size: 'sm', title: 'Download this table',
        onClick: function () { ui.downloadCsv('dish-by-channel_' + env.s.from + '_' + env.s.to + '.csv', csvColumns(current.columns), current.rows); } })
    ] });
  }

  /* ------------------------------------------------------------------ D: price and markup by channel */

  /** Filter for the price analysis: menu prices are master data, so the channel and medium filters do not apply to it. */
  function priceFilter(f) { return { from: f.from, to: f.to, outletIds: f.outletIds }; }

  function aggregatorIds() { return channels().filter(function (c) { return c.kind === 'aggregator'; }).map(function (c) { return c.id; }); }

  /** The weekly statements that actually back a take-rate row: `settledThrough` is keyed per aggregator and null where none covers it. */
  function settledChannels(rate) {
    var through = (rate && rate.settledThrough) || {};
    return channels().filter(function (c) { return c.kind === 'aggregator' && c.statementSource && through[c.id]; });
  }
  function statementSources(rate) { return settledChannels(rate).map(function (c) { return c.statementSource; }); }
  /** "Swiggy through 12 Sep, Zomato through 6 Sep" - the evidence dates the docs ask take rates to be quoted with. */
  function settledThroughText(rate) {
    var through = (rate && rate.settledThrough) || {};
    return andList(settledChannels(rate).map(function (c) { return c.label + ' through ' + MK.dates.label(through[c.id], 'd MMM'); }));
  }

  function priceRows(env, outletId) {
    var pf = priceFilter(env.f), rate = null, byDish = {};
    (env.audit.takeRates || []).forEach(function (t) { if (t.outletId === outletId) rate = t; });
    env.markupFlags.forEach(function (x) { byDish[x.dishId] = x; });
    var hasRate = !!rate && isNum(rate.effectiveTakeRate);
    var qm = MK.data.matrix({ from: pf.from, to: pf.to, outletIds: [outletId], channelIds: aggregatorIds() }, 'dish', 'channel', 'qty');
    var qtyOf = {};
    qm.rows.forEach(function (r, i) { qtyOf[r.id] = qm.rowTotals[i]; });

    var rows = env.d.rows.map(function (r) {
      var agg = r.aggPriceByOutlet ? r.aggPriceByOutlet[outletId] : null, listed = isNum(agg);
      var flag = byDish[r.id] || null, at = null;
      if (flag && flag.data && flag.data.outlets) flag.data.outlets.forEach(function (o) { if (o.outletId === outletId) at = o; });
      /* the data layer's own figure where it flags the dish; otherwise its documented formula on its own take rate and discount share */
      var net = at && isNum(at.realisationPerPortion) ? at.realisationPerPortion
        : (listed && hasRate ? agg * (1 - (rate.discountPct || 0)) * (1 - rate.effectiveTakeRate) : null);
      var gap = isNum(net) && isNum(r.posPrice) ? net - r.posPrice : null;
      var qty = listed ? (qtyOf[r.id] || 0) : null;
      var status = !listed ? 'unlisted' : (!isNum(net) ? 'unknown' : (at && flag.data.stalePriceChange ? 'stale' : (at ? 'flagged' : (gap < 0 ? 'below' : 'ok'))));
      return { id: r.id, name: r.name, short: r.short, sub: dishSubline(r), posPrice: r.posPrice, aggPrice: listed ? agg : null,
        markupPct: listed && r.posPrice ? agg / r.posPrice - 1 : null, net: net, gap: gap, gapPct: isNum(gap) && r.posPrice ? gap / r.posPrice : null,
        aggQty: qty, shortfall: isNum(gap) && gap < 0 && qty ? -gap * qty : null, status: status, ownPrice: listed && isNum(r.aggPrice) && agg !== r.aggPrice, flag: flag };
    });
    return { rows: rows, rate: hasRate ? rate : null, source: sourceOf(qm) };
  }

  function takeawayPrices(env, outlet, data) {
    var listed = data.rows.filter(function (r) { return r.status !== 'unlisted'; }), parts = [];
    if (!listed.length) return outlet.label + ' has no dish on an aggregator list in this selection.';
    if (!data.rate) return 'No settled aggregator statement covers ' + outlet.label + ' up to ' + MK.dates.label(env.s.to, 'd MMM yyyy') + ', so the net per portion cannot be estimated; prices and markup are shown as listed.';
    var rate = data.rate, evidence = settledThroughText(rate);
    parts.push('At ' + outlet.label + ' the aggregators keep ' + fmt.pct(rate.effectiveTakeRate) + ' of net sales, after restaurant-funded discounts of ' + fmt.pct(rate.discountPct) +
      ' of menu value (settled statements from ' + MK.dates.label(rate.windowFrom, 'd MMM') + (evidence ? ', ' + evidence : '') + '). A dish needs a markup of ' +
      fmt.pct(rate.breakEvenMarkupPct) + ' to net its POS price.');
    var short = listed.filter(function (r) { return isNum(r.gap) && r.gap < 0; });
    parts.push(short.length ? fmt.num(short.length) + ' of ' + plural(listed.length, 'listed dish') + ' fall short, worth ' + fmt.inr(sum(short.map(function (r) { return r.shortfall; }))) + ' over the period.'
      : 'Every listed dish clears it.');
    var own = listed.filter(function (r) { return r.ownPrice; });
    if (own.length && env.outlets.length > 1) parts.push(outlet.label + ' runs its own aggregator list: ' + fmt.num(own.length) + ' of ' + fmt.num(listed.length) + ' prices differ from the other outlets.');
    return parts.join(' ');
  }

  function statusChip(id) {
    var s = STATUS[id] || STATUS.unknown;
    return ui.chip(s.label, s.tone, { icon: s.icon, title: s.title });
  }

  function priceBlock(env, st) {
    var outlets = env.outlets;
    if (!outlets.length) return null;
    /* the pick stays the reader's: narrowing the outlet filter must not silently overwrite it, so it is resolved per paint */
    function chosen() {
      var picked = outlets.filter(function (o) { return o.id === st.priceOutlet; })[0];
      return picked || outlets[0];
    }

    var subtitle = h('span', null, '');
    var body = h('div', { 'class': 'ds-prices' });
    var current = { columns: [], rows: [] };
    var money = function (v) { return isNum(v) ? fmt.inrFull(Math.round(v)) : h('span', { 'class': 'mk-faint' }, '-'); };

    function paint() {
      var outlet = chosen();
      var data = priceRows(env, outlet.id), toLabel = MK.dates.label(env.s.to, 'd MMM yyyy');
      var columns = [
        { key: 'name', label: 'Dish', render: ui.cells.twoLine('sub', { maxWidth: 200 }) },
        { key: 'posPrice', label: th2('POS', 'price'), csvLabel: 'POS price', align: 'right', render: money },
        { key: 'aggPrice', label: th2('Aggregator', 'list price'), csvLabel: 'Aggregator list price, ' + outlet.label, align: 'right',
          render: function (v, row) { return row.status === 'unlisted' ? h('span', { 'class': 'mk-muted' }, 'Not listed') : money(v); } },
        { key: 'markupPct', label: 'Markup', format: 'pct', title: 'Aggregator list price over POS price.' },
        { key: 'net', label: h('span', { 'class': 'ds-th2' }, ui.estimateBadge(), h('br'), h('span', { 'class': 'ds-th2__sub' }, 'net per portion')),
          csvLabel: 'Estimated net realisation per aggregator portion', align: 'right',
          title: 'Aggregator list price x (1 - restaurant-funded discount share) x (1 - effective take rate) for ' + outlet.label + '. Not a settled figure: the statement settles fees, not menu prices.',
          render: money },
        { key: 'gap', label: th2('Against', 'POS price'), csvLabel: 'Net realisation less POS price', align: 'right',
          render: function (v, row) {
            if (!isNum(v)) return h('span', { 'class': 'mk-faint' }, '-');
            /* under a rupee either way the money reads as zero, so the percentage carries the direction on its own */
            var whole = Math.round(v), pct = (row.gapPct > 0 ? '+' : '') + fmt.pct(row.gapPct);
            var label = whole === 0 ? pct : (v > 0 ? '+' : '') + fmt.inrFull(whole) + ' (' + pct + ')';
            return ui.deltaBadge({ label: label, dir: v > 0 ? 'up' : (v < 0 ? 'down' : 'flat') }, 'up');
          } },
        { key: 'shortfall', label: th2('Short of POS', 'in the period'), csvLabel: 'Shortfall against POS price in the period', align: 'right',
          title: 'Aggregator portions of the period at this outlet x the gap to the POS price.',
          render: function (v, row) { return isNum(row.aggQty) ? stacked(isNum(v) ? fmt.inr(v) : '-', plural(row.aggQty, 'portion')) : h('span', { 'class': 'mk-faint' }, '-'); } },
        { key: 'aggQty', label: '', csvLabel: 'Aggregator portions in the period', hidden: true },
        { key: 'status', label: 'Reading', sortValue: function (row) { return STATUS[row.status] ? STATUS[row.status].rank : null; }, render: function (v) { return statusChip(v); },
          csvValue: function (row) { return STATUS[row.status] ? STATUS[row.status].label : ''; } }
      ];
      current = { columns: columns, rows: data.rows, outlet: outlet };
      subtitle.textContent = takeawayPrices(env, outlet, data);

      var listed = data.rows.filter(function (r) { return r.status !== 'unlisted'; });
      var footer = { name: plural(listed.length, 'listed dish'),
        shortfall: stacked(fmt.inr(sum(listed.map(function (r) { return r.shortfall; }))), plural(sum(listed.map(function (r) { return r.aggQty; })), 'portion')) };

      ui.clear(body);
      body.appendChild(ui.table({ columns: visible(columns), rows: data.rows, footer: footer, sortable: true, sort: st.priceSort || { key: 'status', dir: 'asc' },
        onSort: function (s) { st.priceSort = s; }, rowClass: function (row) { return row.status === 'unlisted' ? 'is-muted' : ''; }, empty: 'No dishes for this selection' }));

      var unlisted = data.rows.filter(function (r) { return r.status === 'unlisted'; }).map(function (r) { return r.short || r.name; });
      var sum2 = env.audit.markupSummary;
      var foot = [];
      /* the two readings are different rules and the data layer keeps them apart: the flags are the narrow one, markupSummary the wide one */
      if (sum2 && sum2.listings) {
        foot.push(note('Two readings, two rules, across every outlet in the selection: ' + fmt.num(sum2.belowTakeRate) + ' of ' + plural(sum2.listings, 'listing') +
          ' carry a markup that does not even cover the take rate - those are the audit flags. A further tier only shows once discounts and charges are taken: ' +
          fmt.num(sum2.belowBreakEven) + ' listings realise less than the POS price, ' + fmt.inr(sum2.lostRealisation) + ' over the period, because break-even needs a markup of ' +
          fmt.pct(sum2.breakEvenMarkupPct.min) + ' to ' + fmt.pct(sum2.breakEvenMarkupPct.max) + ' depending on the outlet.', 'scale'));
      }
      foot.push(note([ui.estimateBadge(), ' Net per portion is an estimate: the aggregator list price, less ' + outlet.label + '\'s restaurant-funded discount share, less its effective take rate (commission, collection fee, GST on fees, ads, refunds). ' +
        (data.rate ? 'Both rates are actuals from settled statements from ' + MK.dates.label(data.rate.windowFrom, 'd MMM yyyy') +
          (settledThroughText(data.rate) ? ' (' + settledThroughText(data.rate) + ')' : '') + '; contract rates are assumed and not used here. ' : '') +
        'Prices are the menu prices in force on ' + toLabel + '; both lists are the restaurant\'s own. The channel and medium filters do not apply to this table.' +
        (unlisted.length ? ' ' + andList(unlisted) + (unlisted.length === 1 ? ' is' : ' are') + ' not sold at ' + outlet.label + '.' : '')]));
      foot.push(ui.sourceTag([data.source].concat(data.rate ? statementSources(data.rate) : [])));
      body.appendChild(tableFoot(foot));
    }

    var picker = ui.select({ ariaLabel: 'Outlet whose aggregator price list is shown', size: 'sm', value: chosen().id, disabled: outlets.length < 2,
      options: outlets.map(function (o) { return { value: o.id, label: o.label }; }), onChange: function (v) { st.priceOutlet = v; paint(); } });

    paint();
    var card = ui.card({ id: 'ds-price-card', title: 'Price and markup by channel', subtitle: subtitle, flush: true, body: body, actions: [
      h('span', { 'class': 'mk-small mk-muted' }, 'Aggregator list of'), picker,
      ui.button({ label: 'CSV', icon: 'download', size: 'sm', title: 'Download this table',
        onClick: function () { ui.downloadCsv('price-and-markup_' + current.outlet.id + '_' + env.s.to + '.csv', csvColumns(current.columns), current.rows); } })
    ] });

    /* the seeded anomaly, as the data layer reports it: a POS price change that the aggregator lists never followed */
    var alerts = env.markupFlags.filter(function (x) { return x.data && x.data.stalePriceChange; }).map(function (x) {
      var c = x.data.stalePriceChange, where = (x.data.outlets || []).length;
      return ui.callout('serious', x.title, x.detail + '.' + (c.note ? ' Reason logged for the change: ' + lowerFirst(c.note) + '.' : '') + ' Across ' +
        plural(where, 'outlet') + ' the aggregator portions of the period netted ' + fmt.inr(x.amount) + ' less than the POS price would have.',
        { actions: x.route ? ui.link('Open the audit', x.route, { icon: 'arrow-right' }) : null });
    });
    return h('div', { 'class': 'mk-stack ds-pricewrap' }, alerts, card);
  }

  /* ------------------------------------------------------------------ empty state */

  function emptyView(ctx) {
    if (!MK.session.allowedOutletIds().length) {
      var who = ctx.user && ctx.user.name ? ctx.user.name : 'This role';
      return ui.card({ body: ui.emptyState('No outlet sales in your scope',
        who + ' has no customer-facing outlet in scope, and the factory sells no dishes of its own. Switch to a role that covers an outlet to see the menu.', { icon: 'store' }) });
    }
    var f = ctx.filters || {};
    var clash = f.channelIds && f.channelIds.length && f.mediumIds && f.mediumIds.length;
    return ui.card({ body: ui.emptyState('No dishes sold for this selection',
      clash ? 'The channel and medium filters do not overlap: dine-in and takeaway are sold in-store, delivery runs through the aggregators. Reset the filters to see the menu again.'
        : 'No orders were recorded for these filters. Widen the date range or reset the filters.',
      { icon: 'filter', action: ui.button({ label: 'Reset filters', icon: 'refresh', onClick: function () { MK.filters.reset(); } }) }) });
  }

  /* ------------------------------------------------------------------ page */

  function render(rootEl, ctx) {
    var st = ctx.state, f = ctx.filters || {};
    if (!MEASURES[st.mMeasure]) st.mMeasure = 'qty';
    if (!SHOW_OPTIONS.some(function (o) { return o.value === st.mShow; })) st.mShow = 'value';

    var s = MK.data.summary(f);
    if (!s || !s.orders) { rootEl.appendChild(emptyView(ctx)); return; }

    var d = MK.data.dishes(f) || { rows: [], totals: { qty: 0, netSales: 0 }, hasCost: false };
    var audit = MK.data.auditFlags(priceFilter(f)) || { flags: [], takeRates: [] };
    var env = { f: f, s: s, d: d, audit: audit,
      markupFlags: (audit.flags || []).filter(function (x) { return x.type === 'markup' && x.dishId; }),
      /* the price list is master data, so the picker follows the outlet filter and the persona only - not the channel or medium filter */
      outlets: (MK.data.breakdown(priceFilter(f), 'outlet').rows || []).map(function (r) { return { id: r.id, label: r.label }; }) };
    env.totals = totalsOf(d);
    env.dishById = {};
    d.rows.forEach(function (r) { env.dishById[r.id] = r; });

    var priceAnchor = h('div', { 'class': 'ds-anchor' });
    function goToPrices() {
      if (!priceAnchor.scrollIntoView) return;
      priceAnchor.scrollIntoView({ block: 'start' });
      var target = rootEl.querySelector('#ds-price-card select, #ds-price-card button');
      if (target && target.focus) target.focus({ preventScroll: true });   /* keyboard users land in the card they asked for */
    }

    rootEl.appendChild(intro(env));
    var scope = scopeNote(ctx);
    if (scope) rootEl.appendChild(scope);
    safe(rootEl, 'The KPI row', function () { return kpiBlock(env, goToPrices); });

    safe(rootEl, 'The league table', function () { return leagueBlock(env, st); });

    rootEl.appendChild(ui.sectionTitle('Menu engineering', 'Popularity against contribution per portion: which dishes to protect, reprice, promote or drop'));
    safe(rootEl, 'The menu-engineering view', function () { return menuBlock(env); });

    rootEl.appendChild(ui.sectionTitle('Channels', 'Where each dish sells'));
    safe(rootEl, 'The dish by channel table', function () { return matrixBlock(env, st); });

    priceAnchor.appendChild(ui.sectionTitle('Price and markup', 'POS price against each outlet\'s aggregator list, and what an aggregator portion nets after the aggregators\' cut'));
    rootEl.appendChild(priceAnchor);
    safe(rootEl, 'The price and markup table', function () { return priceBlock(env, st); });
  }

  MK.router.register({
    id: 'revenue-dishes',
    route: '#/revenue/dishes',
    group: 'Revenue',
    title: 'Dishes',
    subtitle: 'Dish performance, menu engineering and channel pricing',
    units: 'outlets',
    roles: null,
    filters: ['date', 'outlet', 'channel', 'medium'],
    render: render
  });
})(window);
