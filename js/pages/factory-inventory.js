/*
 * Factory / Inventory (#/factory/inventory) - what the central kitchen is holding this morning, what has to be
 * ordered today, what has to ship first, and what the factory owes its suppliers.
 *
 * Blocks: purpose line -> KPI row (stock value, thinnest fresh and dry cover, items at reorder level, batches
 * expiring within a day, write-offs this month) -> raw-material price trend beside "Needs attention today"
 * -> suggested purchases for the coming week (the forecast's MRP chain with two safety dials, MK.forecast.purchaseSuggestions)
 * -> raw-material stock book with a days-of-cover meter against the target band of its storage class
 * -> finished goods by SKU with their batches in FEFO order -> factory payables by supplier.
 *
 * Every figure comes from MK.factory.inventory / summary / purchases, MK.finance.payables, MK.workflow.bill / batch
 * and MK.config (cover targets, price series, LPG tariff), formatted with MK.fmt. Scope is the data layer's job:
 * MK.factory.* is empty for a persona without the central kitchen, so the page falls back to an empty state instead
 * of an exception. The only action here is raising a purchase bill; it is shown with the reason from
 * MK.workflow.bill.can('create') when the persona may not take it, so the segregation of duties stays visible.
 *
 * Sources: the stock book balance and purchases arrive through Petpooja (a partial capability - the page prints the
 * limitation from MK.data.capability); counts, batch records, standard costs and bills are captured in the ERP.
 *
 * Page-local state (ctx.state): item (price trend), sortRm, sortFg, sortPay.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates;

  var PAGE_ID = 'factory-inventory';   /* the router gives the page root the class .pg-factory-inventory */
  var FACTORY_UNIT = 'factory';
  var OPEN_STATES = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'IN_BATCH'];
  var PIPELINE_STATES = ['SUBMITTED', 'UNDER_REVIEW'];
  var NOW_HOURS = 24, SOON_HOURS = 48;
  var STORAGE_LABEL = { fresh: 'Fresh', frozen: 'Frozen', dry: 'Dry' };
  var STORAGE_ORDER = ['fresh', 'frozen', 'dry'];
  var LPG_ITEM_ID = 'tariff_lpg_cylinder';
  var SEASON_DAYS = 14;   /* an event long enough to move a monthly purchase price, not a single trading day */
  var LEVEL_PCT = 0.0005; /* half of the last digit the price sentence prints: below it, a gap is "level" */

  /* ------------------------------------------------------------------ helpers */

  function guard(name, fn, fallback) {
    try { var v = fn(); return v === undefined || v === null ? fallback : v; }
    catch (e) { if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e); return fallback; }
  }
  /* one decimal, dropped when the figure is whole: "720.7 kg" but "672 kg", "1.5 d" but "3 d" */
  function num1(v) {
    if (typeof v !== 'number' || isNaN(v)) return fmt.num(v);
    return Math.abs(v - Math.round(v)) < 0.05 ? fmt.num(Math.round(v)) : fmt.num(v, 1);
  }
  function qty(v, unit) { return num1(v) + ' ' + (unit || 'kg'); }
  function days(v) { return num1(v) + ' d'; }
  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function day(iso, style) { return iso ? D.label(String(iso).slice(0, 10), style || 'd MMM') : '-'; }
  function hoursLabel(n) { return fmt.num(n) + ' h'; }
  function dash() { return h('span', { 'class': 'mk-faint' }, '-'); }
  function storageLabel(s) { return STORAGE_LABEL[s] || s || '-'; }
  function has(list, x) { return !!list && list.indexOf(x) !== -1; }

  function categoryLabel(id) {
    var list = (MK.config && MK.config.expenseCategories) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
    return null;
  }

  /*
   * Petpooja supplies the inventory module only in part (DATA-FEASIBILITY section 3). Where a reader would take the
   * figure for a counted, live balance, print the limitation the capability matrix states - or, for a field the POS
   * cannot give at all, say so with the kit's "not provided" line rather than showing a number.
   */
  function capabilityNote(fieldKey) {
    var cap = guard('data.capability', function () { return MK.data.capability(fieldKey); }, null);
    var state = guard('data.can', function () { return MK.data.can('petpooja', fieldKey); }, null);
    if (!cap) return null;
    if (state === 'no') return ui.notProvided('Petpooja POS', cap.note || '');
    if (state !== 'partial' || !cap.note) return null;
    return h('p', { 'class': 'fi-note' }, ui.icon('info', 14), h('span', null, cap.label + ': ' + cap.note + '.'));
  }

  function sourceFoot(ids, fieldKey) {
    var note = fieldKey ? capabilityNote(fieldKey) : null;
    return h('div', { 'class': 'fi-foot' }, note, ui.sourceTag(ids));
  }

  /* ------------------------------------------------------- per-render environment */

  function emptyInventory() {
    return { asOf: MK.calendar.today, rawMaterials: [], finishedGoods: [], coverTargets: {},
      totals: { rmValue: 0, fgValue: 0, reorderCount: 0, expiringCount: 0 }, source: 'erp' };
  }

  function flattenLots(finishedGoods) {
    var out = [];
    (finishedGoods || []).forEach(function (g) {
      var perKg = g.stockKg > 0 ? g.value / g.stockKg : 0;
      (g.lots || []).forEach(function (lot) {
        out.push({ sku: g.sku, name: g.name, kg: lot.kg, value: lot.kg * perKg, producedOn: lot.producedOn,
          expiresOn: lot.expiresOn, hoursLeft: lot.hoursLeft, status: lot.status, shelfLifeHours: g.shelfLifeHours });
      });
    });
    return out.sort(function (a, b) { return a.hoursLeft - b.hoursLeft; });
  }

  function coverStat(rows, storage, targets) {
    var band = (targets || {})[storage] || null;
    var list = rows.filter(function (r) { return r.storage === storage && typeof r.daysOfCover === 'number'; });
    var thinnest = null;
    list.forEach(function (r) { if (!thinnest || r.daysOfCover < thinnest.daysOfCover) thinnest = r; });
    return { storage: storage, band: band, count: list.length, thinnest: thinnest,
      below: band ? list.filter(function (r) { return r.daysOfCover < band[0]; }).length : 0,
      above: band ? list.filter(function (r) { return r.daysOfCover > band[1]; }).length : 0 };
  }

  function buildEnv(ctx) {
    var W = MK.workflow;
    var env = { ctx: ctx, st: ctx.state, user: ctx.user || MK.session.current(), today: MK.calendar.today };
    env.monthKey = D.monthKey(MK.calendar.dataEnd);
    env.monthFrom = D.monthStart(MK.calendar.dataEnd);
    env.monthTo = MK.calendar.dataEnd;

    env.inv = guard('factory.inventory', function () { return MK.factory.inventory(); }, null) || emptyInventory();
    env.rm = env.inv.rawMaterials || [];
    env.fg = env.inv.finishedGoods || [];
    env.targets = env.inv.coverTargets || {};
    env.totals = env.inv.totals || { rmValue: 0, fgValue: 0, reorderCount: 0, expiringCount: 0 };
    env.lots = flattenLots(env.fg);
    env.expiringNow = env.lots.filter(function (l) { return l.hoursLeft <= NOW_HOURS; });
    env.expiringSoon = env.lots.filter(function (l) { return l.hoursLeft <= SOON_HOURS; });
    env.reorder = env.rm.filter(function (r) { return r.status === 'REORDER' || r.status === 'LOW'; });

    env.summary = guard('factory.summary', function () {
      return MK.factory.summary({ from: env.monthFrom, to: env.monthTo });
    }, null) || {};
    env.purchases = guard('factory.purchases', function () { return MK.factory.purchases(env.monthKey); }, null)
      || { rows: [], byVendor: [], totals: {}, period: {} };
    env.purchaseOf = {};
    (env.purchases.rows || []).forEach(function (r) { env.purchaseOf[r.rmId] = r; });

    env.bills = guard('bill.list factory', function () {
      return W.bill.list({ unitId: FACTORY_UNIT, status: OPEN_STATES });
    }, []);
    env.payables = guard('finance.payables', function () { return MK.finance.payables(env.today); }, null) || { byUnit: [] };
    env.factoryDue = (env.payables.byUnit || []).filter(function (u) { return u.unitId === FACTORY_UNIT; })[0] || null;
    env.pendingBatches = guard('batch.list pending', function () { return W.batch.list({ status: 'PENDING_RELEASE' }); }, [])
      .filter(function (b) { return has(b.unitIds, FACTORY_UNIT); });
    env.mayRaiseBill = guard('bill.can create', function () {
      return W.bill.can('create', { unitId: FACTORY_UNIT });
    }, { ok: false, reason: '' });

    env.items = priceItems(env);
    env.empty = !env.rm.length && !env.fg.length;
    return env;
  }

  function vendorName(id) {
    if (!id) return '-';
    return guard('vendor.nameOf', function () { return MK.workflow.vendor.nameOf(id); }, id) || id;
  }

  /* ------------------------------------------------------------------ price trend */

  /*
   * Selectable series for the price card: every raw material the stock book carries, plus the commercial LPG
   * cylinder, whose price series and budget reference are model parameters in MK.config.tariffs (gas is not a stock
   * item, so it never appears in the stock tables - but it is the second price story of the year).
   */
  function priceItems(env) {
    var out = [];
    env.rm.forEach(function (r) {
      out.push({ id: r.rmId, name: r.name, unit: r.unit, series: (r.priceSeries || []).slice(),
        standard: r.stdPrice, standardName: 'Standard cost', vendorName: r.vendorName,
        purchase: env.purchaseOf[r.rmId] || null });
    });
    var t = (MK.config && MK.config.tariffs) || null;
    var gasLabel = categoryLabel('gas_lpg');
    if (env.rm.length && t && t.lpgCylinder19kg && t.lpgCylinder19kg.length && gasLabel) {
      out.push({ id: LPG_ITEM_ID, name: gasLabel, unit: 'cylinder', series: t.lpgCylinder19kg.slice(),
        standard: t.lpgBudgetReference, standardName: 'Budget reference', vendorName: null, purchase: null,
        footnote: 'Budgets were set on the January cylinder price, which is why gas runs over plan at every unit.' });
    }
    return out;
  }

  function currentItem(env) {
    var st = env.st, list = env.items, i;
    for (i = 0; i < list.length; i++) if (list[i].id === st.item) return list[i];
    /* default: the raw material the factory spent most on this month - the price that moves the cost per kg */
    var best = null;
    list.forEach(function (it) {
      var v = it.purchase ? it.purchase.value : 0;
      if (!best || v > (best.purchase ? best.purchase.value : 0)) best = it;
    });
    if (best) st.item = best.id;
    return best || null;
  }

  function monthLabels() {
    return ((MK.config && MK.config.months) || []).map(function (m) { return D.monthLabel(m); });
  }

  function priceMarkers() {
    var months = (MK.config && MK.config.months) || [];
    var out = [];
    ((MK.config && MK.config.events) || []).forEach(function (e) {
      if (!e.marker || e.kind !== 'festival' || !e.from || !e.to) return;
      if (D.diffDays(e.from, e.to) < SEASON_DAYS) return;
      var mk = D.monthKey(e.from);
      if (months.indexOf(mk) !== -1) out.push({ label: e.label, atLabel: D.monthLabel(mk) });
    });
    return out;
  }

  function monthAt(months, i) { return i === null || !months[i] ? '' : D.monthLabel(months[i]); }

  function extremes(series, months) {
    var lo = null, hi = null;
    series.forEach(function (v, i) {
      if (typeof v !== 'number') return;
      if (lo === null || v < series[lo]) lo = i;
      if (hi === null || v > series[hi]) hi = i;
    });
    return { lo: lo, hi: hi, loLabel: monthAt(months, lo), hiLabel: monthAt(months, hi) };
  }

  function priceSubtitle(item) {
    var months = (MK.config && MK.config.months) || [];
    var s = item.series || [];
    if (!s.length) return '';
    var last = s[s.length - 1], lastLabel = monthAt(months, s.length - 1) || monthAt(months, months.length - 1);
    var ext = extremes(s, months);
    var per = ' per ' + item.unit;
    var text = item.name + ' is priced at ' + fmt.inrFull(last) + per + ' in ' + lastLabel;
    if (typeof item.standard === 'number' && item.standard > 0) {
      var gap = (last - item.standard) / item.standard;
      var against = 'the ' + fmt.inrFull(item.standard) + ' ' + item.standardName.toLowerCase();
      /* below the precision the sentence prints, "0.0% above" would be noise: say it is level instead */
      text += Math.abs(gap) < LEVEL_PCT ? ', level with ' + against
        : ', ' + fmt.pct(Math.abs(gap), 1) + (gap < 0 ? ' below ' : ' above ') + against;
    }
    if (ext.lo !== null && ext.hi !== null && ext.lo !== ext.hi) {
      text += '; the range since ' + monthAt(months, 0) + ' is ' + fmt.inrFull(s[ext.lo]) + ' (' + ext.loLabel +
        ') to ' + fmt.inrFull(s[ext.hi]) + ' (' + ext.hiLabel + ')';
    }
    return text + '.';
  }

  function priceNote(item, env) {
    if (item.footnote) return item.footnote;
    var p = item.purchase;
    if (!p) return '';
    if (!p.qty) return 'Nothing was bought in ' + (env.purchases.period ? env.purchases.period.label : '') + '.';
    var side = p.ppv < 0 ? 'below' : (p.ppv > 0 ? 'above' : 'at');
    return plural(p.deliveries, 'delivery', 'deliveries') + ' of ' + qty(p.qty, item.unit) + ' in ' +
      (env.purchases.period ? env.purchases.period.label : '') + ', worth ' + fmt.inr(p.value) + '; ' +
      (p.ppv === 0 ? 'bought at standard' : fmt.inr(Math.abs(p.ppv)) + ' ' + side + ' standard cost (' +
        fmt.pct(Math.abs(p.ppvPct), 1) + ')') + '. Supplier: ' + (item.vendorName || '-') + '.';
  }

  function priceCard(env) {
    var item = currentItem(env);
    var holder = h('div', { 'class': 'fi-plot' });
    var select = ui.select({
      ariaLabel: 'Raw material', size: 'sm', value: item ? item.id : '',
      options: env.items.map(function (it) { return { value: it.id, label: it.name }; }),
      onChange: function (v) { env.st.item = v; env.ctx.rerender(); }
    });
    var card = ui.card({
      title: 'Purchase price trend', subtitle: item ? priceSubtitle(item) : '',
      actions: select, className: 'fi-pricecard', body: holder,
      footer: sourceFoot(['petpooja', 'erp'], 'inv.purchases')
    });
    card.mountChart = function () {
      if (!item || !item.series.length || !MK.charts) {
        holder.appendChild(ui.emptyState('No price series for this item', null, { compact: true }));
        return;
      }
      var std = item.series.map(function () { return item.standard; });
      /* one stable id for the card: changing the item must not throw away the reader's Chart / Table choice */
      MK.charts.mount(holder, {
        id: 'fi-price', kind: 'line', format: 'inrFull', height: 232, zeroBaseline: false, bare: true,
        note: priceNote(item, env),
        data: {
          labels: monthLabels(), labelHeader: 'Month', markers: priceMarkers(),
          series: [
            { id: 'paid', name: 'Purchase price', values: item.series, colourVar: '--seq-500' },
            { id: 'std', name: item.standardName, values: std, colourVar: '--series-muted' }
          ]
        }
      });
    };
    return card;
  }

  /* ------------------------------------------------------------------ intro and KPIs */

  function intro(env) {
    var who = env.user ? env.user.roleLabel : '';
    return h('div', { 'class': 'fi-intro' },
      h('p', { 'class': 'fi-intro__text' },
        'Stock as it stands on ' + day(env.inv.asOf, 'd MMM yyyy') + ', before the morning dispatch: what has to be ' +
        'ordered today, what has to leave the chiller first, and what the central kitchen owes its suppliers.'),
      h('p', { 'class': 'fi-intro__who' }, ui.icon('user', 14),
        h('span', null, 'Signed in as ' + (env.user ? env.user.name : '') + (who ? ' - ' + who : '') +
          '. Stock, purchases and bills are already narrowed to what you may see.')));
  }

  function coverTile(env, storage) {
    var stat = coverStat(env.rm, storage, env.targets);
    var band = stat.band;
    var bandText = band ? 'target ' + num1(band[0]) + ' to ' + num1(band[1]) + ' days' : '';
    if (!stat.thinnest) {
      return { label: storageLabel(storage) + ' cover', value: '-', sub: 'No ' + storageLabel(storage).toLowerCase() + ' item in stock' };
    }
    var d = stat.thinnest.daysOfCover;
    var tone = band && d < band[0] ? 'critical' : (band && d > band[1] ? 'warn' : null);
    return {
      label: storageLabel(storage) + ' cover, thinnest item',
      value: days(d), tone: tone, icon: storage === 'dry' ? 'box' : 'layers',
      sub: stat.thinnest.name + '; ' + bandText,
      title: plural(stat.count, storageLabel(storage).toLowerCase() + ' item') + ' in stock, ' +
        plural(stat.below, 'item') + ' below the band and ' + plural(stat.above, 'item') + ' above it'
    };
  }

  function kpis(env) {
    var t = env.totals;
    var stockValue = (t.rmValue || 0) + (t.fgValue || 0);
    var sum = env.summary || {};
    var prev = sum.prev || null;
    var writeOffTarget = (sum.targets && sum.targets.writeOffPct) || null;
    var expiringKg = 0, expiringValue = 0;
    env.expiringNow.forEach(function (l) { expiringKg += l.kg; expiringValue += l.value; });
    var reorderNames = env.reorder.map(function (r) { return r.name; }).join(', ');

    var tiles = [
      { label: 'Stock value', value: fmt.inr(stockValue), icon: 'box',
        sub: fmt.inr(t.rmValue) + ' raw material, ' + fmt.inr(t.fgValue) + ' finished goods' },
      coverTile(env, 'fresh'),
      coverTile(env, 'dry'),
      { label: 'At or below reorder level', value: fmt.num(t.reorderCount), icon: 'alert-triangle',
        tone: t.reorderCount ? 'warn' : null,
        sub: reorderNames || 'Every item is above its reorder point',
        title: reorderNames },
      { label: 'Batches expiring within a day', value: fmt.num(env.expiringNow.length), icon: 'clock',
        tone: env.expiringNow.length ? 'critical' : null,
        sub: env.expiringNow.length
          ? qty(expiringKg) + ' worth ' + fmt.inr(expiringValue) + '; ' + fmt.num(env.expiringSoon.length) + ' within ' + hoursLabel(SOON_HOURS)
          : fmt.num(env.expiringSoon.length) + ' batches within ' + hoursLabel(SOON_HOURS) },
      { label: 'Write-offs, ' + (sum.costMonths && sum.costMonths.length ? sum.costMonths[0].label : env.monthKey),
        value: typeof sum.writeOffKg === 'number' ? qty(sum.writeOffKg) : '-', icon: 'trash',
        delta: prev ? fmt.points(sum.writeOffPct, prev.writeOffPct) : null, goodWhen: 'down',
        deltaNote: prev ? 'vs the period before' : null,
        sub: typeof sum.writeOffPct === 'number'
          ? fmt.pct(sum.writeOffPct, 2) + ' of output' + (writeOffTarget ? ', target under ' + fmt.pct(writeOffTarget[1], 1) : '')
          : '' }
    ];
    return h('div', { 'class': 'fi-kpiblock' },
      h('div', { 'class': 'fi-kpis' }, tiles.map(function (o) { return ui.statTile(o); })),
      ui.sourceTag(['petpooja', 'erp']));
  }

  /* ------------------------------------------------------------------ needs attention */

  function alertRow(name, meta, chip) {
    return h('li', { 'class': 'fi-alert' },
      h('div', { 'class': 'fi-alert__main' },
        h('span', { 'class': 'fi-alert__name' }, name),
        h('span', { 'class': 'fi-alert__meta' }, meta)),
      h('span', { 'class': 'fi-alert__chip' }, chip));
  }

  function attentionCard(env) {
    var body = [];
    var may = env.mayRaiseBill || { ok: false, reason: '' };

    if (env.reorder.length) {
      body.push(h('div', { 'class': 'fi-block' },
        h('h4', { 'class': 'fi-block__title' }, 'At or below reorder level'),
        h('ul', { 'class': 'fi-list' }, env.reorder.map(function (r) {
          return alertRow(r.name,
            qty(r.stockQty, r.unit) + ' on hand against a reorder level of ' + qty(r.reorderLevelQty, r.unit) +
            '; last delivery ' + day(r.lastPurchaseDate) + ' from ' + (r.vendorName || '-'),
            ui.chip(days(r.daysOfCover) + ' cover', r.status === 'LOW' ? 'critical' : 'warn', { icon: 'alert-triangle' }));
        }))));
    }

    if (env.expiringSoon.length) {
      body.push(h('div', { 'class': 'fi-block' },
        h('h4', { 'class': 'fi-block__title' }, 'Use first - batches within ' + hoursLabel(SOON_HOURS)),
        h('ul', { 'class': 'fi-list' }, env.expiringSoon.slice(0, 6).map(function (l) {
          return alertRow(l.name,
            qty(l.kg) + ' made on ' + day(l.producedOn) + ', use by ' + day(l.expiresOn) + ' - ' + fmt.inr(l.value) + ' at transfer price',
            ui.chip(hoursLabel(l.hoursLeft) + ' left', l.hoursLeft <= NOW_HOURS ? 'critical' : 'warn',
              { icon: l.hoursLeft <= NOW_HOURS ? 'alert-triangle' : 'clock' }));
        }))));
      if (env.expiringSoon.length > 6) {
        body.push(h('p', { 'class': 'fi-note' }, ui.icon('info', 14),
          h('span', null, 'The full batch list is in the finished-goods table below.')));
      }
    }

    if (!body.length) {
      body.push(ui.emptyState('Nothing needs a decision this morning',
        'No item sits at its reorder level and no batch expires within ' + hoursLabel(SOON_HOURS) + '.',
        { icon: 'check-circle', compact: true }));
    }

    var raise = ui.button({
      label: 'Raise a purchase bill', icon: 'plus', variant: 'primary', size: 'sm',
      disabledReason: may.ok ? '' : may.reason,
      title: may.ok ? 'Opens the bills queue, where the supplier bill is entered' : '',
      onClick: function () { env.ctx.navigate('approvals-bills'); }
    });

    return ui.card({
      title: 'Needs attention today',
      subtitle: plural(env.reorder.length, 'item') + ' to order and ' + plural(env.expiringSoon.length, 'batch', 'batches') +
        ' to move within ' + hoursLabel(SOON_HOURS) + '.',
      className: 'fi-attention',
      body: h('div', { 'class': 'fi-attention__body' }, body),
      footer: h('div', { 'class': 'fi-foot fi-foot--actions' },
        h('div', { 'class': 'fi-actions' }, raise, ui.link('Factory payables', MK.router.href('approvals-payables'), { icon: 'arrow-right' })),
        ui.sourceTag(['erp']))
    });
  }

  /* ------------------------------------------------------------------ raw materials */

  function coverCell(cover, storage, targets) {
    var band = (targets || {})[storage] || null;
    if (typeof cover !== 'number') return dash();
    if (!band) return h('span', { 'class': 'mk-num' }, days(cover));
    var lo = band[0], hi = band[1];
    var tone = cover < lo ? 'critical' : (cover > hi ? 'warn' : 'good');
    return h('div', {
      'class': 'fi-cover',
      title: num1(cover) + ' days of cover against a target band of ' + num1(lo) + ' to ' + num1(hi) + ' days for ' +
        storageLabel(storage).toLowerCase() + ' storage'
    }, ui.meter({ size: 'sm', value: Math.min(cover, hi), max: hi, tone: tone, target: lo / hi, label: null,
      targetLabel: 'Band starts at ' + num1(lo) + ' days', valueLabel: days(cover) }));
  }

  function reorderCell(row) {
    if (row.status === 'LOW') return ui.chip('Low', 'critical', { icon: 'alert-triangle', title: 'Under a day of cover' });
    if (row.status === 'REORDER') {
      return ui.chip('Reorder', 'warn', { icon: 'alert-triangle', title: 'At or near the reorder level of ' + qty(row.reorderLevelQty, row.unit) });
    }
    return h('span', { 'class': 'mk-faint', title: 'Above the reorder level of ' + qty(row.reorderLevelQty, row.unit) }, '-');
  }

  function priceCell(row) {
    var gap = row.stdPrice ? (row.price - row.stdPrice) / row.stdPrice : null;
    return h('div', { 'class': 'fi-cell2' },
      h('span', { 'class': 'mk-num' }, fmt.inrFull(row.price)),
      gap === null ? null : h('span', { 'class': 'fi-cell2__sub' },
        ui.deltaBadge(fmt.delta(row.price, row.stdPrice), 'down', { note: 'vs standard' })));
  }

  function rawMaterialCard(env) {
    var st = env.st;
    var rows = env.rm.map(function (r) {
      return { rmId: r.rmId, name: r.name, unit: r.unit, storage: r.storage, stockQty: r.stockQty, value: r.value,
        avgDailyUse: r.avgDailyUse, daysOfCover: r.daysOfCover, reorderLevelQty: r.reorderLevelQty, status: r.status,
        lastPurchaseDate: r.lastPurchaseDate, price: r.price, stdPrice: r.stdPrice, vendorName: r.vendorName,
        sub: storageLabel(r.storage) + ' - ' + (r.vendorName || '-') };
    });
    var below = rows.filter(function (r) {
      var band = env.targets[r.storage];
      return band && r.daysOfCover < band[0];
    }).length;

    var columns = [
      { key: 'name', label: 'Raw material', sortable: true, width: 184, render: ui.cells.twoLine('sub', { maxWidth: 176 }) },
      { key: 'stockQty', label: 'On hand', align: 'right', sortable: true, width: 92,
        render: function (v, row) { return qty(v, row.unit); } },
      { key: 'value', label: 'Stock value', format: 'inr', align: 'right', sortable: true, width: 96 },
      { key: 'avgDailyUse', label: 'Used a day', align: 'right', sortable: true, width: 92,
        title: 'Average daily consumption over the recent production run',
        render: function (v, row) { return qty(v, row.unit); } },
      { key: 'daysOfCover', label: 'Days of cover', sortable: true, width: 156,
        title: 'Cover against the target band of the storage class',
        render: function (v, row) { return coverCell(v, row.storage, env.targets); } },
      { key: 'status', label: 'Reorder', sortable: true, width: 96, render: function (v, row) { return reorderCell(row); } },
      { key: 'lastPurchaseDate', label: 'Last delivery', align: 'right', sortable: true, width: 96,
        render: function (v) { return day(v); } },
      { key: 'price', label: 'Last price', align: 'right', sortable: true, width: 116,
        title: 'Latest purchase price against the standard cost the transfer price is built on',
        render: function (v, row) { return priceCell(row); } }
    ];

    return ui.card({
      title: 'Raw material stock book',
      subtitle: plural(rows.length, 'item') + ' worth ' + fmt.inr(env.totals.rmValue) + '; ' +
        (env.totals.reorderCount ? fmt.num(env.totals.reorderCount) + ' at the reorder level' : 'none at the reorder level') +
        ', ' + (below ? plural(below, 'item') + ' under the cover band' : 'none under the cover band') + '.',
      flush: true, className: 'fi-tablecard',
      actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', onClick: function () {
        ui.downloadCsv('factory-raw-material-stock.csv', [
          { key: 'name', label: 'Raw material' }, { key: 'storage', label: 'Storage' }, { key: 'unit', label: 'Unit' },
          { key: 'stockQty', label: 'On hand' }, { key: 'value', label: 'Stock value' },
          { key: 'avgDailyUse', label: 'Used a day' }, { key: 'daysOfCover', label: 'Days of cover' },
          { key: 'reorderLevelQty', label: 'Reorder level' }, { key: 'status', label: 'Status' },
          { key: 'lastPurchaseDate', label: 'Last delivery' }, { key: 'price', label: 'Last price' },
          { key: 'stdPrice', label: 'Standard cost' }, { key: 'vendorName', label: 'Supplier' }
        ], rows);
      } }),
      body: ui.table({
        columns: columns, rows: rows, dense: true,
        sort: st.sortRm || { key: 'daysOfCover', dir: 'asc' }, onSort: function (s) { st.sortRm = s; },
        empty: 'No raw material in stock',
        rowClass: function (r) { return r.status === 'OK' ? '' : 'is-strong'; },
        footer: { name: 'All raw materials', value: env.totals.rmValue }
      }),
      footer: sourceFoot(['petpooja', 'erp'], 'inv.closingStock')
    });
  }

  /* ------------------------------------------------------------------ finished goods */

  function lotChips(row) {
    return h('div', { 'class': 'fi-lots' }, row.lots.map(function (lot) {
      var tone = lot.hoursLeft <= NOW_HOURS ? 'critical' : (lot.status === 'USE_FIRST' ? 'warn' : 'neutral');
      return ui.chip(qty(lot.kg) + ' - ' + hoursLabel(lot.hoursLeft), tone, {
        icon: lot.hoursLeft <= NOW_HOURS ? 'alert-triangle' : 'clock',
        title: 'Made on ' + day(lot.producedOn, 'd MMM yyyy') + ', use by ' + day(lot.expiresOn, 'd MMM yyyy')
      });
    }));
  }

  function fgStatusCell(row) {
    if (row.status === 'EXPIRING') return ui.chip('Expiring', 'critical', { icon: 'alert-triangle' });
    if (row.status === 'USE_FIRST') return ui.chip('Use first', 'warn', { icon: 'clock' });
    return h('span', { 'class': 'fi-ok' }, 'In date');
  }

  function finishedGoodsCard(env) {
    var st = env.st;
    var rows = env.fg.map(function (g) {
      var first = (g.lots || [])[0] || null;
      return { sku: g.sku, name: g.name, stockKg: g.stockKg, value: g.value, avgDailyDispatchKg: g.avgDailyDispatchKg,
        daysOfCover: g.daysOfCover, shelfLifeHours: g.shelfLifeHours, lots: g.lots || [], status: g.status,
        urgency: first ? first.hoursLeft : null };
    });
    var atRisk = 0;
    env.expiringNow.forEach(function (l) { atRisk += l.value; });

    var columns = [
      { key: 'name', label: 'Finished SKU', sortable: true, width: 212, render: ui.cells.twoLine('sku', { maxWidth: 202 }) },
      { key: 'stockKg', label: 'In stock', align: 'right', sortable: true, width: 96,
        render: function (v) { return qty(v); } },
      { key: 'value', label: 'At transfer price', format: 'inr', align: 'right', sortable: true, width: 116 },
      { key: 'avgDailyDispatchKg', label: 'Dispatched a day', align: 'right', sortable: true, width: 120,
        render: function (v) { return qty(v); } },
      { key: 'daysOfCover', label: 'Cover', align: 'right', sortable: true, width: 84,
        title: 'Days of dispatch the finished stock covers',
        render: function (v) { return typeof v === 'number' ? days(v) : dash(); } },
      { key: 'shelfLifeHours', label: 'Shelf life', align: 'right', sortable: true, width: 92,
        render: function (v) { return hoursLabel(v); } },
      { key: 'urgency', label: 'Batches, oldest first', sortable: true, wrap: true,
        title: 'FEFO: the batch with the earliest use-by date ships first',
        render: function (v, row) { return lotChips(row); } },
      { key: 'status', label: 'Status', sortable: true, width: 108, render: function (v, row) { return fgStatusCell(row); } }
    ];

    return ui.card({
      title: 'Finished goods and their batches',
      subtitle: plural(rows.length, 'SKU') + ' worth ' + fmt.inr(env.totals.fgValue) + '; ' +
        (env.expiringNow.length
          ? plural(env.expiringNow.length, 'batch', 'batches') + ' worth ' + fmt.inr(atRisk) + ' must ship within ' + hoursLabel(NOW_HOURS)
          : 'no batch expires within ' + hoursLabel(NOW_HOURS)) + '.',
      flush: true, className: 'fi-tablecard',
      body: ui.table({
        columns: columns, rows: rows, dense: true,
        sort: st.sortFg || { key: 'urgency', dir: 'asc' }, onSort: function (s) { st.sortFg = s; },
        empty: 'No finished stock',
        rowClass: function (r) { return r.status === 'OK' ? '' : 'is-strong'; },
        footer: { name: 'All finished goods', value: env.totals.fgValue }
      }),
      /* batches, shelf lives and transfer prices are the ERP's own records - no Petpooja limitation applies here */
      footer: h('div', { 'class': 'fi-foot' },
        h('p', { 'class': 'fi-note' }, ui.icon('info', 14),
          h('span', null, 'Batch weights, production dates and transfer prices come from the production records; ' +
            'the use-by date is the production date plus the shelf life of the SKU.')),
        ui.sourceTag(['erp']))
    });
  }

  /* ------------------------------------------------------------------ factory payables */

  function payableRows(env) {
    var by = {}, order = [];
    env.bills.forEach(function (b) {
      var k = b.vendorId || '-';
      if (!by[k]) { by[k] = { vendorId: k, name: vendorName(k), count: 0, payable: 0, awaiting: 0, nextDue: null }; order.push(k); }
      var r = by[k];
      r.count += 1;
      r.payable += b.payable || 0;
      if (has(PIPELINE_STATES, b.status)) r.awaiting += b.payable || 0;
      if (b.dueDate && (!r.nextDue || b.dueDate < r.nextDue)) r.nextDue = b.dueDate;
    });
    return order.map(function (k) { return by[k]; }).sort(function (a, b) { return b.payable - a.payable; });
  }

  function payablesCard(env) {
    var st = env.st;
    var due = env.factoryDue;
    var rows = payableRows(env);
    var total = due ? due.total : rows.reduce(function (t, r) { return t + r.payable; }, 0);
    var count = due ? due.count : rows.reduce(function (t, r) { return t + r.count; }, 0);
    var awaiting = rows.reduce(function (t, r) { return t + r.awaiting; }, 0);

    var summary = ui.keyValue([
      ['Open bills', h('strong', null, fmt.inrFull(total))],
      ['Bills', plural(count, 'bill')],
      ['Due within a week', due ? fmt.inrFull(due.dueIn7Days) : fmt.inrFull(0)],
      ['Overdue', due && due.overdue ? h('span', { 'class': 'mk-bad' }, ui.icon('alert-triangle', 14), fmt.inrFull(due.overdue)) : h('span', { 'class': 'fi-ok' }, 'None')],
      ['Awaiting approval', awaiting ? fmt.inrFull(awaiting) : h('span', { 'class': 'fi-ok' }, 'None')],
      ['Released, reference awaited', due && due.inTransit ? fmt.inrFull(due.inTransit) : h('span', { 'class': 'fi-ok' }, 'None')]
    ], { cols: 2 });

    var columns = [
      { key: 'name', label: 'Supplier', sortable: true, maxWidth: 260 },
      { key: 'count', label: 'Bills', align: 'right', sortable: true, width: 76 },
      { key: 'payable', label: 'Payable', format: 'inr', sortable: true, width: 200, render: ui.cells.bar(null, '--seq-500') },
      { key: 'awaiting', label: 'Awaiting approval', format: 'inr', align: 'right', sortable: true, width: 140,
        render: function (v) { return v ? fmt.inrFull(v) : dash(); } },
      { key: 'nextDue', label: 'Next due', align: 'right', sortable: true, width: 104, render: function (v) { return day(v); } }
    ];

    var batchNote = null;
    if (env.pendingBatches.length) {
      var b = env.pendingBatches[0];
      batchNote = ui.callout('info', 'A payment batch is waiting for the director',
        b.number + ' holds ' + plural(b.billIds.length, 'bill') + ' worth ' + fmt.inrFull(b.total) + '.',
        { actions: ui.link('Payment batches', MK.router.href('approvals-payments'), { icon: 'arrow-right' }) });
    }

    return ui.card({
      title: 'What the factory owes',
      subtitle: 'Open supplier bills for the central kitchen, by supplier: ' + fmt.inr(total) + ' across ' +
        plural(rows.length, 'supplier') + '.',
      className: 'fi-paycard',
      body: h('div', { 'class': 'fi-pay' },
        summary, batchNote,
        h('div', { 'class': 'fi-pay__table' }, ui.table({
          columns: columns, rows: rows, dense: true, maxHeight: 300,
          sort: st.sortPay || { key: 'payable', dir: 'desc' }, onSort: function (s) { st.sortPay = s; },
          empty: 'No open bills for the central kitchen',
          footer: { name: 'All suppliers', count: count, payable: total, awaiting: awaiting || '-' }
        }))),
      footer: h('div', { 'class': 'fi-foot fi-foot--actions' },
        h('div', { 'class': 'fi-actions' },
          ui.link('Ageing and overdue', MK.router.href('approvals-payables'), { icon: 'arrow-right' }),
          ui.link('Bills queue', MK.router.href('approvals-bills'), { icon: 'arrow-right' })),
        ui.sourceTag(['erp']))
    });
  }


  /* ------------------------------------------------------------------ suggested purchases (forecast, Layer 3) */

  var SUGGEST_STATUS = { ORDER_TODAY: { label: 'Order today', tone: 'warn' }, ORDER_THIS_WEEK: { label: 'This week', tone: 'info' }, NO_ORDER: { label: 'Covered', tone: 'good' } };

  /* the working behind one quantity, in a popover: forecast use, the cover wanted, the stock position, the rule that fired */
  function workingButton(row) {
    var btn = ui.button({ label: 'Why', size: 'sm', variant: 'ghost', title: 'How this quantity was arrived at' });
    btn.addEventListener('click', function () {
      ui.popover(btn, h('div', { 'class': 'pg-factory-inventory fi-working' },
        h('div', { 'class': 'fi-working__title' }, row.name),
        h('ol', { 'class': 'fi-working__steps' }, row.working.map(function (line) { return h('li', null, line); }))), { width: 440, align: 'right' });
    });
    return btn;
  }

  /* What to order, item by item, from MK.forecast.purchaseSuggestions(). The two safety dials sit above the table and
     repaint it in place; the reactiveness of the demand forecast is set on the Overview and only quoted here. */
  function suggestionsCard(env) {
    if (!MK.forecast || typeof MK.forecast.purchaseSuggestions !== 'function') return null;
    var body = h('div', { 'class': 'fi-suggest' });
    var rowsNow = [];
    var card = ui.card({
      title: 'Suggested purchases, next 7 days', subtitle: ' ', className: 'fi-tablecard', flush: true,
      actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', onClick: function () {
        ui.downloadCsv('factory-suggested-purchases.csv', [
          { key: 'name', label: 'Raw material' }, { key: 'storage', label: 'Storage' }, { key: 'vendorName', label: 'Supplier' }, { key: 'unit', label: 'Unit' },
          { key: 'onHand', label: 'On hand' }, { key: 'usePerDay', label: 'Forecast use a day' }, { key: 'recentUsePerDay', label: 'Recent use a day' },
          { key: 'coverDays', label: 'Days of cover' }, { key: 'targetDays', label: 'Cover wanted' }, { key: 'orderQty', label: 'Order' }, { key: 'orderBy', label: 'Order by' },
          { key: 'deliverBy', label: 'Delivery' }, { key: 'price', label: 'Price' }, { key: 'value', label: 'Value' }, { key: 'status', label: 'Status' }, { key: 'reason', label: 'Reason' }
        ], rowsNow);
      } }),
      body: body,
      footer: ui.sourceTag(['erp', 'forecast'])
    });
    var subEl = card.querySelector('.mk-card__subtitle');

    /* recalc: a dial moved - the table is fetched again while the dials stay in reach (MK.latency) */
    function paint(recalc) {
      var ps = guard('forecast.purchaseSuggestions', function () { return MK.forecast.purchaseSuggestions(); }, null);
      ui.clear(body);
      rowsNow = ps ? ps.rows : [];
      if (!ps || !ps.rows.length) {
        subEl.textContent = '';
        body.appendChild(ui.emptyState('Nothing to suggest', 'The forecast works from the raw-material stock book, which is empty in this scope.', { compact: true, icon: 'box' }));
        return;
      }
      var t = ps.totals, s = ps.settings, S = MK.forecast.OPTIONS.safety;
      subEl.textContent = (t.today.items ? plural(t.today.items, 'item') + ' to order today worth ' + fmt.inr(t.today.value) : 'Nothing to order today') +
        (t.week.items ? ', ' + plural(t.week.items, 'item') + ' later this week worth ' + fmt.inr(t.week.value) : '') +
        (t.later ? ', ' + plural(t.later, 'item') + ' covered beyond the week' : '') +
        '. Built on a forecast of about ' + fmt.num(ps.portionsPerDay) + ' portions a day across the outlets.';
      var dials = h('div', { 'class': 'fi-dials' },
        ui.stepper({ label: S.fresh.label, value: s.safetyDays.fresh, min: S.fresh.min, max: S.fresh.max, step: S.fresh.step, unit: S.fresh.unit, size: 'sm',
          title: 'Days of forecast use kept in hand beyond the lead time and the daily review of fresh items',
          onChange: function (v) { MK.forecast.setSettings({ safetyDays: { fresh: v } }); paint(true); } }),
        ui.stepper({ label: S.dry.label, value: s.safetyDays.dry, min: S.dry.min, max: S.dry.max, step: S.dry.step, unit: S.dry.unit, size: 'sm',
          title: 'Days of forecast use kept in hand beyond the lead time and the weekly review of dry and frozen items',
          onChange: function (v) { MK.forecast.setSettings({ safetyDays: { dry: v } }); paint(true); } }),
        h('span', { 'class': 'fi-dials__note' }, 'Demand forecast: ' + MK.forecast.reactivenessLabel(s.weeks) + ' (the last ' + s.weeks + ' weeks), set on the Overview. ' +
          'Fresh items are ordered every day and delivered the next day; dry and frozen items once a week, delivered in 3 and 2 days. An order must last until the next delivery, plus the safety cover. Quantities are rounded up to whole lots.'));
      var columns = [
        { key: 'name', label: 'Raw material', width: 184, render: ui.cells.twoLine('sub', { maxWidth: 176 }) },
        { key: 'status', label: 'Action', width: 104, render: function (v) { var st = SUGGEST_STATUS[v] || { label: v, tone: 'neutral' }; return ui.chip(st.label, st.tone); } },
        { key: 'onHand', label: 'On hand', align: 'right', width: 88, render: function (v, row) { return qty(v, row.unit); } },
        { key: 'usePerDay', label: 'Forecast use a day', align: 'right', width: 136, title: 'Forecast portions x recipes, with the outlets\' over-use against recipe and the process wastage allowance; the recent average is the kitchen\'s own trailing figure',
          render: function (v, row) {
            return h('div', { 'class': 'fi-cell2' }, h('span', { 'class': 'mk-num' }, qty(v, row.unit)),
              typeof row.recentUsePerDay === 'number' ? h('span', { 'class': 'fi-cell2__sub' }, 'recent ' + qty(row.recentUsePerDay, row.unit)) : null);
          } },
        { key: 'coverDays', label: 'Cover', align: 'right', width: 76, title: 'Stock on hand in days of forecast use', render: function (v) { return typeof v === 'number' ? days(v) : dash(); } },
        { key: 'targetDays', label: 'Wanted', align: 'right', width: 76, title: 'Days of use an order must last: the delivery time, the days until the next order, and the safety cover', render: function (v) { return days(v); } },
        { key: 'orderQty', label: 'Order', align: 'right', width: 96, render: function (v, row) { return v > 0 ? h('strong', { 'class': 'mk-num' }, qty(v, row.unit)) : dash(); } },
        { key: 'orderBy', label: 'Order by', align: 'right', width: 120, title: 'When to place the order; fresh items are ordered every day, dry and frozen items once a week', render: function (v, row) {
          var rhythm = row.reviewDays === 1 ? 'daily order' : 'weekly order';
          return v ? h('div', { 'class': 'fi-cell2' }, h('span', null, day(v, 'EEE d MMM')), h('span', { 'class': 'fi-cell2__sub' }, rhythm + ', delivery ' + day(row.deliverBy)))
            : h('div', { 'class': 'fi-cell2' }, dash(), h('span', { 'class': 'fi-cell2__sub' }, rhythm));
        } },
        { key: 'value', label: 'Value', format: 'inr', align: 'right', width: 96 },
        { key: 'why', label: '', width: 64, render: function (v, row) { return workingButton(row); } }
      ];
      var rows = ps.rows.map(function (r) { var o = {}; Object.keys(r).forEach(function (k) { o[k] = r[k]; }); o.sub = storageLabel(r.storage) + ' - ' + (r.vendorName || '-'); return o; });
      var tableEl = ui.table({ columns: columns, rows: rows, dense: true, empty: 'Nothing to suggest',
        rowClass: function (r) { return r.status === 'NO_ORDER' ? '' : 'is-strong'; },
        footer: { name: 'Orders this week', value: t.today.value + t.week.value } });
      ui.append(body, dials, tableEl);
      if (recalc && MK.latency) MK.latency.part(tableEl, 'table', 'Recalculating the orders', 'recalc');
    }
    paint();
    return card;
  }

  /* ------------------------------------------------------------------ render */

  function render(rootEl, ctx) {
    var env = buildEnv(ctx);
    rootEl.appendChild(intro(env));

    if (env.empty) {
      rootEl.appendChild(ui.emptyState('No central-kitchen stock in your scope',
        'Stock counts, production batches and factory purchases belong to the central kitchen. Switch to a persona ' +
        'that carries the factory to see them.', { icon: 'factory' }));
      return;
    }

    rootEl.appendChild(kpis(env));

    var price = priceCard(env);
    rootEl.appendChild(h('div', { 'class': 'fi-split' }, price, attentionCard(env)));
    price.mountChart();

    var suggest = suggestionsCard(env);
    if (suggest) rootEl.appendChild(suggest);

    rootEl.appendChild(ui.sectionTitle('Stock book',
      'Cover is measured against the target band for the storage class: ' +
      STORAGE_ORDER.filter(function (s) { return env.targets[s]; }).map(function (s) {
        var b = env.targets[s];
        return storageLabel(s).toLowerCase() + ' ' + num1(b[0]) + ' to ' + num1(b[1]) + ' days';
      }).join(', ') + '.'));
    rootEl.appendChild(rawMaterialCard(env));
    rootEl.appendChild(finishedGoodsCard(env));
    rootEl.appendChild(payablesCard(env));
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/factory/inventory',
    group: 'Factory',
    title: 'Inventory',
    subtitle: 'Stock, days of cover and raw material prices',
    units: 'factory',
    roles: null,
    filters: [],
    render: render
  });
})(window);
