/*
 * MK.finance - the cost model: one monthly LEDGER of cost lines for every unit (five outlets, the
 * factory, head office), and everything read from it: P&L, unit economics, food cost, recipe cost
 * cards, budgets, payables, vendor spend, cost-centre spend.
 * (docs/SPEC.md 6.4, docs/RESEARCH.md sections 5 and 7, docs/API-finance.md)
 *
 * Coherence rules this file keeps:
 *   - food cost = recipe cost of what was sold (factory SKUs at transfer price + local items) + variance;
 *     the factory-sourced part (recipe + over-draw) equals MK.factory's dispatch value to the outlet;
 *   - aggregator costs are the sales layer's numbers: statement values for settled periods, contract
 *     estimates for the unsettled tail, and the estimated part is carried separately on every line;
 *   - the factory's logistics pool is charged to the outlets to the rupee; the company P&L is the
 *     outlets at transfer prices + the factory's over / under absorption + head office;
 *   - September is month to date: monthly fixed costs accrue pro rata to the days elapsed.
 * Role scope is applied at call time in every public selector (MK.session.allowedUnitIds()); only the
 * unscoped ledger and its aggregates are cached. MK.finance.raw is for the seed and check layers.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});
  var finance = MK.finance = MK.finance || {};
  finance.ready = false;

  /* ===================================================================== model parameters
   * Parameters the cost model needs that MK.config does not carry, and the CALIBRATED values that
   * replace "before tuning" figures of MK.config (RESEARCH.md section 5) so that the outlet EBITDA
   * bands hold. Pre-tuning config values are in brackets. These belong in config.js once adopted.
   */
  var MODEL = {
    seed: 'mk-finance-v1',

    /* The calibrated rosters are master data: MK.config.wages.staffing (11 / 13 / 12 / 11 / 8). */
    repairsPctOfSales: 0.009,             /* [0.015] average; the month's figure is lumpy */
    /* Koregaon Park opened in July 2025 and is still under warranty; Kalyan, the oldest suburban fit-out, runs at the RESEARCH.md rate */
    repairsPctOfSalesByOutlet: { koregaon: 0.004, kalyan: 0.015 },
    repairs: { amcShare: 0.35, jobSpread: 1.95 },   /* month = expected x (amcShare + jobSpread x u^2), u uniform: the mean is 1 */
    housekeepingPctOfSales: 0.005,        /* [0.006] */
    housekeepingPctOfSalesByOutlet: { kalyan: 0.006 },   /* the RESEARCH.md rate */
    /* Local marketing as a share of net sales, by month where it moves. Koregaon Park tapers its
     * launch-phase spend; the six-month average stays near the 2.5% of RESEARCH.md. Kalyan keeps the RESEARCH.md 1.5%. */
    localMarketingPct: { bandra: 0.010, andheri: 0.010, fort: 0.010, kalyan: 0.015, koregaon: [0.035, 0.030, 0.025, 0.020, 0.015, 0.015] },   /* [0.015, 0.012, 0.010, 0.015, 0.025] */
    /*
     * Charcoal follows what goes through the tandoor: weighted portions of the month (a kebab plate = 1) priced so that the
     * average complete month costs the monthly figure of MK.config.outletCosts (RESEARCH.md section 5).
     */
    charcoalWeightByCategory: { signature_kebabs: 1, classic_kebabs: 1, seekh_kebabs: 1, gravy: 0.5, appetisers: 0.4, breads: 0.25 },
    staffAccommodation: { bandra: 20000, andheri: 20000, fort: 15000, koregaon: 12000 },    /* [25000, 25000, 20000, 15000]; Kalyan has none */
    localOverUseMonthNoise: 0.10,         /* month-to-month spread of the over-use of local items */
    foodCostPctReference: 0.335,          /* only used when MK.factory is not loaded (it owns the over-use rate) */
    internetPerMonth: 1500,               /* head-office share of office costs billed by the internet provider */

    posShareOfPosAndInternet: 1700,       /* Rs of config.outletCostsCommon.posAndInternet billed by the POS vendor; the rest is internet */

    /* Which vendor supplies a locally bought item. A vendor that does not serve the outlet means a cash purchase (not billable). */
    localVendorByItem: { L_KHUBZ: 'v_dry', L_RUMALI: 'v_dry', L_ONION: 'v_veg', L_SALADVEG: 'v_veg', L_FRIES: 'v_dry', L_PICKLE: 'v_dry', L_SAUCE: 'v_dry',
      L_OIL: 'v_oil', L_BUTTER: 'v_dairy', L_CREAM: 'v_dairy', L_CURD: 'v_dairy', L_CASHEW: 'v_dry', L_ZAATAR: 'v_dry', L_SPICE: 'v_dry' },
    /* How a vendor bills. Anything not listed bills monthly. Credit days come from MK.config.vendors. */
    billingFrequency: { v_poultry: 'weekly', v_mutton: 'weekly', v_lpg_mum: 'per-delivery', v_lpg_pune: 'per-delivery',   /* meat arrives daily against challans; the tax invoice is weekly */
      v_dairy: 'weekly', v_veg: 'weekly', v_dry: 'weekly', v_oil: 'weekly', v_pack: 'weekly', v_charcoal: 'weekly', v_hk: 'weekly' },

    /* Cost behaviour for break-even: these move with sales; everything else is treated as fixed in the month. */
    variableCategories: ['cogs_factory', 'cogs_local', 'cogs_variance', 'packaging', 'agg_commission', 'agg_collection', 'agg_other', 'agg_gst_on_fees',
      'agg_ads', 'agg_refunds', 'card_mdr', 'charcoal', 'housekeeping', 'local_marketing', 'logistics_allocation'],

    /* The budget: set in March 2026, before the quarter. It knows the seasonal pattern and the contracts,
     * not the LPG spike, the ads overspend, the compressor failure or the pace of the Koregaon Park ramp. */
    budget: {
      netSales: { bandra: [2900000, 2900000, 2900000, 2900000, 2900000, 2900000], andheri: [3200000, 3200000, 3200000, 3200000, 3200000, 3200000],
        fort: [2200000, 2200000, 2200000, 2200000, 2200000, 2200000], kalyan: [2000000, 2000000, 2000000, 2000000, 2000000, 2000000],
        koregaon: [1350000, 1400000, 1450000, 1500000, 1550000, 1600000] },
      adsPctOfMenuValue: { bandra: 0.03, andheri: 0.04, fort: 0.03, kalyan: 0.035, koregaon: 0.045 },
      foodCostVarianceAllowancePts: 0.010,
      headroomPct: 0.03,
      referenceMonthIdx: 0                 /* April stands in for the January-March run-rate the ratios were taken from */
    },

    /* Cost-centre departments: share of a category by department; payroll follows the roster instead. */
    departments: {
      outlet: { names: ['Kitchen', 'Service', 'Delivery desk'],
        kitchenRoles: ['tandoor_cook', 'shawarma_cook', 'commis'], sharedRoles: { helper: [0.5, 0, 0.5] },
        byCategory: { cogs_factory: [1, 0, 0], cogs_local: [1, 0, 0], cogs_variance: [1, 0, 0], packaging: [0, 0, 1], gas_lpg: [1, 0, 0], charcoal: [1, 0, 0],
          electricity: [0.6, 0.4, 0], water: [0.7, 0.3, 0], repairs: [0.7, 0.3, 0], logistics_allocation: [1, 0, 0],
          agg_commission: [0, 0, 1], agg_collection: [0, 0, 1], agg_other: [0, 0, 1], agg_gst_on_fees: [0, 0, 1], agg_ads: [0, 0, 1], agg_refunds: [0, 0, 1] } },
      factory: { names: ['Production', 'Stores', 'Dispatch'],
        byCategory: { raw_materials: [1, 0, 0], production_consumables: [1, 0, 0], gas_lpg: [1, 0, 0], electricity: [0.75, 0.25, 0], water: [1, 0, 0], repairs: [0.7, 0.3, 0],
          lab_pest_licence: [1, 0, 0], rent: [0.65, 0.25, 0.10], rent_gst: [0.65, 0.25, 0.10], office_admin: [0, 1, 0], vehicle_rent: [0, 0, 1], vehicle_fuel: [0, 0, 1], pune_run: [0, 0, 1],
          depreciation: [0.8, 0.2, 0] } },
      ho: { names: ['Finance', 'Admin'], financeRoles: ['Finance manager', 'Accountant'],
        byCategory: { professional_fees: [1, 0], software: [0.6, 0.4] } }
    }
  };

  var COMMITTED = { APPROVED: 1, IN_BATCH: 1, PAID: 1 }, PIPELINE = { SUBMITTED: 1, UNDER_REVIEW: 1 };
  var B = null;   /* built, unscoped state */

  /* ------------------------------------------------------------------ helpers */

  function ratio(a, b) { return b ? a / b : 0; }
  function num(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function byId(list) { var m = Object.create(null); list.forEach(function (x) { m[x.id] = x; }); return m; }   /* no prototype: 'constructor' is not an id */
  function round50(x) { return Math.round(x / 50) * 50; }

  function monthInfo(monthKey) {
    if (MK.factory && MK.factory.raw && MK.factory.raw.monthInfo) return MK.factory.raw.monthInfo(monthKey);
    if (typeof monthKey !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
      return { monthKey: null, label: '', from: null, to: null, daysInMonth: 0, elapsedDays: 0, partial: false, prorata: 0, periodLabel: '' };
    }
    var D = MK.dates, cal = MK.calendar, from = monthKey + '-01', dim = D.daysInMonth(monthKey), end = D.monthEnd(from), to = end > cal.dataEnd ? cal.dataEnd : end;
    var elapsed = from > cal.dataEnd || to < cal.dataStart ? 0 : D.diffDays(D.max(from, cal.dataStart), to) + 1, partial = elapsed < dim;
    return { monthKey: monthKey, label: D.monthLabel(monthKey, true), from: from, to: to, daysInMonth: dim, elapsedDays: elapsed, partial: partial, prorata: elapsed / dim,
      periodLabel: partial ? D.label(from) + ' - ' + D.label(to) + ' (month to date, ' + elapsed + ' of ' + dim + ' days)' : D.monthLabel(monthKey, true) };
  }

  /** Budget figures are clean: rounded up to the next 500 / 1,000 / 5,000 / 10,000 by size. */
  function clean(x) {
    if (x <= 0) return 0;
    var step = x < 10000 ? 500 : x < 100000 ? 1000 : x < 1000000 ? 5000 : 10000;
    return Math.ceil(x / step) * step;
  }

  /* -------------------------------------------------------------------- build */

  function build() {
    var cfg = MK.config, db = MK.engine.run(), dm = db.dims, NO = dm.NO, NS = dm.NS, NDI = dm.NDI, NMO = dm.NMO;
    var fac = MK.factory && MK.factory.raw && MK.factory.raw.state() ? MK.factory.raw : null;
    var unitIds = cfg.outlets.map(function (u) { return u.id; }), NU = unitIds.length, unitById = byId(cfg.outlets);
    var cats = cfg.expenseCategories, NC = cats.length, catIdx = {}, catById = byId(cats), vendorById = byId(cfg.vendors);
    cats.forEach(function (c, i) { catIdx[c.id] = i; });
    var unitIdx = {}; unitIds.forEach(function (id, i) { unitIdx[id] = i; });
    var localItems = cfg.items.local, packItems = byId(cfg.items.packaging), localIdx = {}, fpById = byId(cfg.items.factoryProducts);
    localItems.forEach(function (it, i) { localIdx[it.id] = i; });
    var variable = {}; MODEL.variableCategories.forEach(function (id) { variable[id] = true; });
    var infos = cfg.months.map(monthInfo), common = cfg.outletCostsCommon, tariffs = cfg.tariffs, wages = cfg.wages;

    var lines = [], amt = new Float64Array(NU * NMO * NC), est = new Float64Array(NU * NMO * NC), seq = 0;

    function billingOf(vendorId) {
      var v = vendorById[vendorId]; if (!v) return null;
      return { frequency: MODEL.billingFrequency[vendorId] || 'monthly', creditDays: v.creditDays };
    }
    /* o: { vendorId, basis, note, estimated, interUnit, component, channelId, fullMonthAmount } */
    function add(unitId, mi, categoryId, amount, o) {
      amount = Math.round(amount);
      if (!amount) return null;
      o = o || {};
      var vendorId = o.vendorId && vendorById[o.vendorId] && vendorById[o.vendorId].unitIds.indexOf(unitId) !== -1 ? o.vendorId : null;
      var partial = infos[mi].partial && o.fullMonthAmount !== undefined && o.fullMonthAmount !== null;
      var line = { id: 'L-' + unitId + '-' + cfg.months[mi] + '-' + (++seq), unitId: unitId, monthKey: cfg.months[mi], categoryId: categoryId, group: catById[categoryId].group,
        vendorId: vendorId, amount: amount, basis: o.basis || '', note: o.note || (o.vendorId && !vendorId ? 'Cash purchase - no registered vendor serves this unit' : ''),
        billable: !!vendorId, billing: billingOf(vendorId), estimated: !!o.estimated, estimatedPart: o.estimated ? amount : 0,
        accrual: partial ? 'prorata' : 'actual', fullMonthAmount: partial ? Math.round(o.fullMonthAmount) : null,
        interUnit: !!o.interUnit, component: o.component || null, channelId: o.channelId || null, behaviour: variable[categoryId] ? 'variable' : 'fixed' };
      lines.push(Object.freeze(line));
      var ix = (unitIdx[unitId] * NMO + mi) * NC + catIdx[categoryId];
      amt[ix] += amount; if (o.estimated) est[ix] += amount;
      return line;
    }
    /* a monthly fixed cost: accrues pro rata in the month to date */
    function fixed(unitId, mi, categoryId, monthly, o) { o = o || {}; o.fullMonthAmount = monthly; return add(unitId, mi, categoryId, monthly * infos[mi].prorata, o); }

    /* ---- recipe cost per portion by dish x medium x month (factory at transfer price, local at the month's price) ---- */
    function priceOf(item, mi) { return item.prices[mi]; }
    function lineCost(item, qty, mi) { return item.unit === 'pc' ? priceOf(item, mi) * qty : priceOf(item, mi) * qty / 1000; }
    var MEDIUMS = ['dinein', 'takeaway', 'delivery'];
    var dishFactory = new Float64Array(NDI), dishLocal = new Float64Array(NMO * NDI), dishPack = new Float64Array(NMO * NDI * 3), orderPack = new Float64Array(NMO * 3);
    cfg.dishes.forEach(function (dish, di) {
      dish.recipe.factory.forEach(function (l) { dishFactory[di] += fpById[l.sku].transferPrice * l.g / 1000; });
      for (var mi = 0; mi < NMO; mi++) {
        dish.recipe.local.forEach(function (l) { dishLocal[mi * NDI + di] += lineCost(localItems[localIdx[l.itemId]], l.qty, mi); });
        MEDIUMS.forEach(function (med, k) { (dish.recipe.packaging[med] || []).forEach(function (l) { dishPack[(mi * NDI + di) * 3 + k] += lineCost(packItems[l.itemId], l.qty, mi); }); });
      }
    });
    for (var mi0 = 0; mi0 < NMO; mi0++) MEDIUMS.forEach(function (med, k) { (cfg.orderPackaging[med] || []).forEach(function (l) { orderPack[mi0 * 3 + k] += lineCost(packItems[l.itemId], l.qty, mi0); }); });
    var streamMedium = cfg.streams.map(function (s) { return MEDIUMS.indexOf(s.mediumId); });

    /* ---- monthly dish net sales (the sales cube keeps quantities by month, net sales by day) ---- */
    var dishNet = new Float64Array(NMO * NO * NDI);
    for (var d = 0; d < dm.ND; d++) for (var o1 = 0; o1 < NO; o1++) for (var s1 = 0; s1 < NS; s1++) for (var di1 = 0; di1 < NDI; di1++) {
      var net1 = db.dishDayCube[((((d * NO + o1) * NS + s1) * NDI) + di1) * dm.NDM + db.DM.net];
      if (net1) dishNet[(db.dayMonth[d] * NO + o1) * NDI + di1] += net1;
    }

    /* ---- outlet facts kept for the selectors ---- */
    var theoFactory = new Float64Array(NMO * NO), theoLocal = new Float64Array(NMO * NO), theoByStream = new Float64Array(NMO * NO * NS), packByStream = new Float64Array(NMO * NO * NS);
    var actualFactory = new Float64Array(NMO * NO), varianceFactory = new Float64Array(NMO * NO), varianceLocal = new Float64Array(NMO * NO);
    var refSales = new Float64Array(NO), fullMonths = 0;
    infos.forEach(function (info, mi) { if (info.partial) return; fullMonths += 1; for (var o = 0; o < NO; o++) refSales[o] += db.monthlyMeasure(cfg.months[mi], db.outletIds[o], null, 'netSales'); });
    for (var o2 = 0; o2 < NO; o2++) refSales[o2] = ratio(refSales[o2], fullMonths);

    function rosterOf(outletId) { return has(wages.staffing, outletId) ? wages.staffing[outletId] : []; }
    function grossPayroll(outletId) { return rosterOf(outletId).reduce(function (t, n, i) { return t + n * wages.roles[i].gross; }, 0); }
    function headcount(outletId) { return rosterOf(outletId).reduce(function (t, n) { return t + n; }, 0); }
    function repairsPct(outletId) { var p = MODEL.repairsPctOfSalesByOutlet[outletId]; return p === undefined ? MODEL.repairsPctOfSales : p; }
    function housekeepingPct(outletId) { var p = MODEL.housekeepingPctOfSalesByOutlet[outletId]; return p === undefined ? MODEL.housekeepingPctOfSales : p; }

    /* ---- tandoor load by month x outlet (weighted portions), and the charcoal rate per unit of load ---- */
    var tandoorWeight = cfg.dishes.map(function (dish) { return MODEL.charcoalWeightByCategory[dish.category] || 0; });
    var tandoorLoad = new Float64Array(NMO * NO), charcoalRate = new Float64Array(NO);
    for (var mt = 0; mt < NMO; mt++) for (var ot = 0; ot < NO; ot++) for (var st2 = 0; st2 < NS; st2++) for (var dt = 0; dt < NDI; dt++) {
      if (tandoorWeight[dt]) tandoorLoad[mt * NO + ot] += db.monthDishQty[((mt * NO + ot) * NS + st2) * NDI + dt] * tandoorWeight[dt];
    }
    db.outletIds.forEach(function (id, o) {
      var load = 0; infos.forEach(function (info, mi) { if (!info.partial) load += tandoorLoad[mi * NO + o]; });
      charcoalRate[o] = ratio(cfg.outletCosts[id].charcoal * fullMonths, load);
    });
    function marketingPct(outletId, mi) { var p = MODEL.localMarketingPct[outletId]; return Array.isArray(p) ? p[mi] : (p === undefined ? cfg.outletCosts[outletId].localMarketingPct : p); }

    /* =============================== outlets =============================== */
    db.outletIds.forEach(function (outletId, o) {
      var unit = unitById[outletId], oc = cfg.outletCosts[outletId], landlord = 'v_ll_' + outletId;
      var overUse = fac ? fac.overUseRate(outletId) : (oc.foodCostVariancePts || 0) / MODEL.foodCostPctReference;
      var repairsRng = MK.rng(MODEL.seed + '|repairs|' + outletId), useRng = MK.rng(MODEL.seed + '|local-over-use|' + outletId);
      var elecVendor = unit.electricityZone === 'msedcl' ? 'u_elec_msedcl' : 'u_elec_mum', lpgVendor = unit.region === 'Pune' ? 'v_lpg_pune' : 'v_lpg_mum';

      for (var mi = 0; mi < NMO; mi++) {
        var mk = cfg.months[mi], net = db.monthlyMeasure(mk, outletId, null, 'netSales');
        /* -- recipe cost of what was sold -- */
        var facT = 0, locByItem = new Float64Array(localItems.length), pack = 0;
        for (var s = 0; s < NS; s++) {
          var med = streamMedium[s], orders = db.monthCube[((mi * NO + o) * NS + s) * dm.NM + db.M.orders], sTheo = 0, sPack = orders * orderPack[mi * 3 + med];
          for (var di = 0; di < NDI; di++) {
            var q = db.monthDishQty[((mi * NO + o) * NS + s) * NDI + di];
            if (!q) continue;
            facT += q * dishFactory[di]; sTheo += q * (dishFactory[di] + dishLocal[mi * NDI + di]); sPack += q * dishPack[(mi * NDI + di) * 3 + med];
            var rec = cfg.dishes[di].recipe.local;
            for (var li = 0; li < rec.length; li++) { var it = localIdx[rec[li].itemId]; locByItem[it] += q * lineCost(localItems[it], rec[li].qty, mi); }
          }
          theoByStream[(mi * NO + o) * NS + s] = sTheo; packByStream[(mi * NO + o) * NS + s] = sPack; pack += sPack;
        }
        var facLine = add(outletId, mi, 'cogs_factory', facT, { basis: 'Recipe x portions sold, factory products at transfer price', interUnit: true, component: 'recipe' });
        var byVendor = {}, locT = 0;
        for (var it2 = 0; it2 < localItems.length; it2++) { var vKey = MODEL.localVendorByItem[localItems[it2].id] || 'cash'; byVendor[vKey] = (byVendor[vKey] || 0) + locByItem[it2]; }
        Object.keys(byVendor).forEach(function (v) {
          var l = add(outletId, mi, 'cogs_local', byVendor[v], { vendorId: v === 'cash' ? null : v, basis: 'Recipe x portions sold at the price of the month', component: 'recipe' });
          if (l) locT += l.amount;
        });
        /* -- variance: factory products drawn above recipe (= dispatch - recipe) and local items used above recipe -- */
        var facTheoAmt = facLine ? facLine.amount : 0, dispatched = fac ? fac.dispatchToOutlet(mk, outletId).value : Math.round(facTheoAmt * (1 + overUse));
        var vFac = add(outletId, mi, 'cogs_variance', dispatched - facTheoAmt, { basis: 'Factory dispatches at transfer price less recipe requirement', note: 'Wastage and portioning on factory products', interUnit: true, component: 'factory' });
        var vLoc = add(outletId, mi, 'cogs_variance', locT * overUse * (1 + useRng.range(-MODEL.localOverUseMonthNoise, MODEL.localOverUseMonthNoise)), { basis: 'Stock count: local items used above recipe', note: 'Wastage and portioning on local purchases', component: 'local' });
        theoFactory[mi * NO + o] = facTheoAmt; theoLocal[mi * NO + o] = locT; actualFactory[mi * NO + o] = dispatched;
        varianceFactory[mi * NO + o] = vFac ? vFac.amount : 0; varianceLocal[mi * NO + o] = vLoc ? vLoc.amount : 0;
        add(outletId, mi, 'packaging', pack, { vendorId: 'v_pack', basis: 'Per-dish and per-order packaging by medium', component: 'recipe' });

        /* -- aggregator costs: the sales layer's statement values, estimates for the unsettled tail -- */
        db.aggregatorIds.forEach(function (channelId) {
          var fees = db.feesByMonth(mk, outletId, channelId);
          [['actual', false, 'Payout statement'], ['estimated', true, 'Estimated at contracted rates']].forEach(function (kind) {
            var f = fees[kind[0]], opt = function (note) { return { basis: kind[2], note: note || '', estimated: kind[1], channelId: channelId }; };
            add(outletId, mi, 'agg_commission', f.serviceFee, opt());
            add(outletId, mi, 'agg_collection', f.collectionFee, opt());
            add(outletId, mi, 'agg_other', f.otherFees, opt('Platform and long-distance fees'));
            add(outletId, mi, 'agg_other', f.unclassified, opt('Unclassified deduction - to be disputed'));
            add(outletId, mi, 'agg_gst_on_fees', f.gstOnFees, opt('18% GST on fees, no input credit'));
            add(outletId, mi, 'agg_ads', f.ads, opt('Deducted from payouts, 18% GST included'));
            add(outletId, mi, 'agg_refunds', f.refunds, opt());
          });
        });
        add(outletId, mi, 'card_mdr', db.paymentMixByMonth(mk, outletId).card * cfg.cardMdrPct, { basis: (cfg.cardMdrPct * 100).toFixed(1) + '% of card receipts' });

        /* -- people -- */
        var gross = grossPayroll(outletId), heads = headcount(outletId);
        fixed(outletId, mi, 'salaries', gross, { basis: heads + ' staff x wage table' });
        fixed(outletId, mi, 'employer_oncosts', gross * wages.employerOnCostPct, { basis: (wages.employerOnCostPct * 100) + '% of gross (PF, ESIC, bonus accrual)' });
        fixed(outletId, mi, 'staff_meals', heads * common.staffMealsPerHead, { basis: heads + ' staff x Rs ' + common.staffMealsPerHead });
        var accom = has(MODEL.staffAccommodation, outletId) ? MODEL.staffAccommodation[outletId] : oc.staffAccommodation;
        fixed(outletId, mi, 'staff_accommodation', accom, { vendorId: 'v_accom', basis: 'Shared staff flat' });

        /* -- occupancy and utilities -- */
        fixed(outletId, mi, 'rent', oc.rent, { vendorId: landlord, basis: 'Lease, Rs ' + oc.rentPerSqft + ' per sq ft' });
        fixed(outletId, mi, 'rent_gst', oc.rent * common.rentGstPct, { vendorId: landlord, basis: '18% GST on rent, no input credit' });
        fixed(outletId, mi, 'cam', oc.cam, { vendorId: landlord, basis: 'Society / CAM charges' });
        var kwh = oc.electricityKwh * tariffs.electricitySeason[mi], rate = tariffs.electricityPerKwh[unit.electricityZone];
        fixed(outletId, mi, 'electricity', kwh * rate, { vendorId: elecVendor, basis: Math.round(kwh) + ' kWh x Rs ' + rate });
        fixed(outletId, mi, 'gas_lpg', oc.lpgCylinders * tariffs.lpgCylinder19kg[mi], { vendorId: lpgVendor, basis: oc.lpgCylinders + ' cylinders x Rs ' + tariffs.lpgCylinder19kg[mi] });
        var charcoal = charcoalRate[o] * tandoorLoad[mi * NO + o];
        add(outletId, mi, 'charcoal', charcoal, { vendorId: 'v_charcoal', basis: Math.round(charcoal / tariffs.charcoalPerKg) + ' kg x Rs ' + tariffs.charcoalPerKg + ' (follows the tandoor portions sold)' });
        fixed(outletId, mi, 'water', oc.water, { vendorId: 'u_water', basis: 'Municipal water' });

        /* -- operations -- */
        add(outletId, mi, 'housekeeping', net * housekeepingPct(outletId), { vendorId: 'v_hk', basis: (housekeepingPct(outletId) * 100).toFixed(1) + '% of net sales' });
        var expected = repairsPct(outletId) * refSales[o], u = repairsRng.next();
        fixed(outletId, mi, 'repairs', round50(expected * MODEL.repairs.amcShare), { vendorId: 'v_amc', basis: 'Refrigeration and equipment AMC', component: 'amc' });
        fixed(outletId, mi, 'repairs', round50(expected * MODEL.repairs.jobSpread * u * u), { vendorId: 'v_amc', basis: 'Repair jobs in the month', component: 'jobs' });
        (oc.oneOffs || []).forEach(function (x) { if (x.month === mk) add(outletId, mi, x.categoryId, x.amount, { vendorId: 'v_amc', basis: 'One-off', note: x.label, component: 'one_off' }); });
        fixed(outletId, mi, 'pest_waste', common.pestControl, { vendorId: 'v_pest', basis: 'Pest-control contract' });
        fixed(outletId, mi, 'pest_waste', common.waste, { vendorId: 'v_waste', basis: 'Waste collection contract' });
        fixed(outletId, mi, 'pos_internet', MODEL.posShareOfPosAndInternet, { vendorId: 'v_pos', basis: 'POS subscription' });
        fixed(outletId, mi, 'pos_internet', common.posAndInternet - MODEL.posShareOfPosAndInternet, { vendorId: 'v_internet', basis: 'Internet' });
        fixed(outletId, mi, 'licences_insurance', common.licencesAndInsurance, { vendorId: 'v_insure', basis: 'Annual premiums and licences spread monthly' });
        fixed(outletId, mi, 'petty_cash', oc.pettyCash, { basis: 'Imprest' });
        var mPct = marketingPct(outletId, mi);
        add(outletId, mi, 'local_marketing', net * mPct, { vendorId: 'v_print', basis: (mPct * 100).toFixed(1) + '% of net sales' });
        if (fac) add(outletId, mi, 'logistics_allocation', fac.logistics(mk).byOutlet[outletId] || 0, { basis: 'Factory logistics pool by kg dispatched; the Pune run is charged to Koregaon Park', interUnit: true });
        fixed(outletId, mi, 'depreciation', oc.depreciation, { basis: 'Straight line' });
      }
    });

    /* =============================== factory =============================== */
    if (fac) cfg.months.forEach(function (mk, mi) {
      fac.costLines(mk).forEach(function (l) {
        add('factory', mi, l.categoryId, l.amount, { vendorId: l.vendorId, basis: l.basis, note: l.note, component: l.bucket, fullMonthAmount: l.accrual === 'prorata' ? l.fullMonthAmount : null });
      });
    });

    /* ============================= head office ============================= */
    var ho = cfg.headOffice, hoGross = ho.staffing.reduce(function (t, x) { return t + x.count * x.gross; }, 0), hoHeads = ho.staffing.reduce(function (t, x) { return t + x.count; }, 0);
    cfg.months.forEach(function (mk, mi) {
      fixed('ho', mi, 'salaries', hoGross, { basis: hoHeads + ' staff' });
      fixed('ho', mi, 'employer_oncosts', hoGross * ho.employerOnCostPct, { basis: (ho.employerOnCostPct * 100) + '% of gross' });
      fixed('ho', mi, 'rent', ho.officeRent, { vendorId: 'v_ll_factory', basis: 'Office space in the factory estate' });
      fixed('ho', mi, 'rent_gst', ho.officeRent * ho.rentGstPct, { vendorId: 'v_ll_factory', basis: '18% GST on rent, no input credit' });
      fixed('ho', mi, 'software', ho.software, { basis: 'Accounting, payroll and ERP subscriptions, paid by company card' });
      fixed('ho', mi, 'professional_fees', ho.caRetainer, { vendorId: 'v_ca', basis: 'CA retainer' });
      fixed('ho', mi, 'office_admin', MODEL.internetPerMonth, { vendorId: 'v_internet', basis: 'Internet' });
      fixed('ho', mi, 'office_admin', ho.officeAdmin - MODEL.internetPerMonth, { basis: 'Stationery, courier, sundries' });
    });

    /* ---- index ---- */
    var byUnitMonth = {};
    lines.forEach(function (l) { var k = l.unitId + '|' + l.monthKey; (byUnitMonth[k] || (byUnitMonth[k] = [])).push(l); });

    B = { cfg: cfg, db: db, fac: fac, facState: fac ? fac.state() : null, unitIds: unitIds, unitIdx: unitIdx, NU: NU, NMO: NMO, NC: NC, NO: NO, NS: NS, NDI: NDI, cats: cats, catIdx: catIdx, catById: catById, vendorById: vendorById,
      infos: infos, lines: lines, byUnitMonth: byUnitMonth, amt: amt, est: est, variable: variable,
      dishFactory: dishFactory, dishLocal: dishLocal, dishPack: dishPack, orderPack: orderPack, dishNet: dishNet, MEDIUMS: MEDIUMS, streamMedium: streamMedium,
      theoFactory: theoFactory, theoLocal: theoLocal, theoByStream: theoByStream, packByStream: packByStream, actualFactory: actualFactory, varianceFactory: varianceFactory, varianceLocal: varianceLocal,
      refSales: refSales, rosterOf: rosterOf, grossPayroll: grossPayroll, headcount: headcount, marketingPct: marketingPct, repairsPct: repairsPct, housekeepingPct: housekeepingPct,
      planCache: {}, cardCache: {}, netCache: new Float64Array(NMO * NO), ordersCache: new Float64Array(NMO * NO) };
    for (var m3 = 0; m3 < NMO; m3++) for (var o3 = 0; o3 < NO; o3++) {
      B.netCache[m3 * NO + o3] = db.monthlyMeasure(cfg.months[m3], db.outletIds[o3], null, 'netSales');
      B.ordersCache[m3 * NO + o3] = db.monthlyMeasure(cfg.months[m3], db.outletIds[o3], null, 'orders');
    }
    var h = 2166136261 >>> 0;
    for (var i = 0; i < amt.length; i++) { h ^= amt[i]; h = Math.imul(h, 16777619) >>> 0; }
    B.checksum = h >>> 0;
    finance.ready = true;
    return B;
  }

  function state() {
    /* rebuild when the sales engine or the factory model underneath was rebuilt */
    if (B && (B.db !== MK.db || (B.fac && B.facState !== B.fac.state()))) { B = null; finance.ready = false; }
    if (B) return B;
    try { if (MK.config && MK.engine && typeof MK.engine.run === 'function') build(); } catch (e) { B = null; if (root.console) root.console.error('[MK.finance] build failed', e); }
    return B;
  }

  /** Builds the ledger once ({ force: true } rebuilds, e.g. after MK.engine.run({ force: true })). */
  finance.build = function (opts) { if (opts && opts.force) { B = null; finance.ready = false; if (MK.factory && MK.factory.build) MK.factory.build({ force: true }); } return !!state(); };

  /* -------------------------------------------------------------------- scope */

  /** Unit selection -> unit indices inside the persona's scope. sel: unit id | 'all' | 'outlets' | array of ids | null (= all). */
  function resolveUnits(sel) {
    var st = state(); if (!st) return [];
    var allowed = MK.session.allowedUnitIds(), want;
    if (sel === null || sel === undefined || sel === 'all' || sel === 'company') want = st.unitIds;
    else if (sel === 'outlets') want = st.db.outletIds;
    else want = Array.isArray(sel) ? sel : [sel];
    var out = [];
    st.unitIds.forEach(function (id, i) { if (want.indexOf(id) !== -1 && allowed.indexOf(id) !== -1) out.push(i); });
    return out;
  }

  /** Period -> month indices (whole months). p: 'YYYY-MM' | ISO date | { from, to } | 'fy' | null (= the current month). */
  function resolveMonths(p) {
    var st = state(); if (!st) return [];
    var months = st.cfg.months, last = months.length - 1;
    function idx(v, fallback) { if (typeof v !== 'string' || v.length < 7) return fallback; var i = months.indexOf(v.slice(0, 7)); return i < 0 ? (v.slice(0, 7) < months[0] ? 0 : (v.slice(0, 7) > months[last] ? last : fallback)) : i; }
    if (p === 'fy' || p === 'all') return months.map(function (m, i) { return i; });
    if (p && typeof p === 'object') {
      var a = idx(p.from, 0), b = idx(p.to, last); if (a > b) { var t = a; a = b; b = t; }
      var out = []; for (var i = a; i <= b; i++) out.push(i); return out;
    }
    if (typeof p === 'string') { var one = months.indexOf(p.slice(0, 7)); return one < 0 ? [] : [one]; }
    return [last];
  }

  /* The period block of a result that has no month (unknown month key, or the model is not built): same keys, nothing in them. */
  function emptyPeriod() { return { months: [], from: null, to: null, label: '', partial: false, elapsedDays: 0, daysInMonth: 0, note: '' }; }

  function periodOf(monthIdx) {
    var st = B, D = MK.dates;
    if (!st || !monthIdx.length) return emptyPeriod();
    var first = st.infos[monthIdx[0]], lastInfo = st.infos[monthIdx[monthIdx.length - 1]], partial = monthIdx.some(function (i) { return st.infos[i].partial; });
    var label = monthIdx.length === 1 ? first.periodLabel : D.monthLabel(first.monthKey, true) + ' - ' + (lastInfo.partial ? D.label(lastInfo.to, 'd MMM yyyy') : D.monthLabel(lastInfo.monthKey, true));
    return { months: monthIdx.map(function (i) { return st.cfg.months[i]; }), from: first.from, to: lastInfo.to, label: label, partial: partial,
      elapsedDays: lastInfo.elapsedDays, daysInMonth: lastInfo.daysInMonth,
      note: partial ? D.monthLabel(lastInfo.monthKey) + ' is month to date (' + lastInfo.elapsedDays + ' of ' + lastInfo.daysInMonth + ' days): monthly fixed costs are accrued pro rata so margins stay comparable' : '' };
  }

  /* ---------------------------------------------------------------------- P&L */

  function isOutletIdx(u) { return u < B.NO; }

  /** Unscoped P&L arithmetic over unit and month indices. */
  function computePnl(units, months) {
    var st = B, cfg = st.cfg, NC = st.NC, NMO = st.NMO;
    var hasFactory = !!st.fac && units.indexOf(st.unitIdx.factory) !== -1, others = units.filter(function (u) { return u !== st.unitIdx.factory; });
    var factoryOnly = hasFactory && !others.length;
    var sums = new Float64Array(NC), ests = new Float64Array(NC), netSales = 0, orders = 0, c;
    var lineUnits = factoryOnly ? units : others;
    lineUnits.forEach(function (unit) {
      months.forEach(function (mi) {
        var base = (unit * NMO + mi) * NC;
        for (c = 0; c < NC; c++) { sums[c] += st.amt[base + c]; ests[c] += st.est[base + c]; }
        if (isOutletIdx(unit)) { netSales += st.netCache[mi * st.NO + unit]; orders += st.ordersCache[mi * st.NO + unit]; }
      });
    });
    var transferValue = 0, logisticsRecovery = 0, absorption = 0, factoryDep = 0;
    if (hasFactory && st.fac) months.forEach(function (mi) {
      var p = st.fac.pnl(cfg.months[mi]); if (!p) return;
      transferValue += p.transferValue; logisticsRecovery += p.logisticsRecovery; absorption += p.absorption; factoryDep += p.depreciation;
    });
    var pctBase = factoryOnly ? transferValue : netSales, labels = {};
    cfg.expenseGroups.forEach(function (g) { labels[g.id] = g.label; });
    var lines = [], totals = { netSales: netSales, orders: orders, cogs: 0, grossMargin: 0, grossMarginPct: 0, channelCosts: 0, opex: 0, ebitda: 0, ebitdaPct: 0, depreciation: 0, ebit: 0,
      foodCost: 0, foodCostPct: 0, estimatedPart: 0, factoryAbsorption: hasFactory && !factoryOnly ? absorption : null, headOffice: null,
      transferValue: hasFactory ? transferValue : null, logisticsRecovery: hasFactory ? logisticsRecovery : null };
    st.cats.forEach(function (cat, ci) {
      var amount = sums[ci];
      if (cat.id === 'depreciation' && hasFactory && !factoryOnly) amount += factoryDep;
      if (!amount) return;
      lines.push({ key: cat.id, label: cat.label, group: cat.group, groupLabel: labels[cat.group], amount: amount, pctOfSales: ratio(amount, pctBase), estimatedPart: ests[ci] });
      totals.estimatedPart += ests[ci];
      if (cat.group === 'cogs') totals.cogs += amount; else if (cat.group === 'channel') totals.channelCosts += amount; else if (cat.group === 'below_ebitda') totals.depreciation += amount; else totals.opex += amount;
      if (cat.id === 'cogs_factory' || cat.id === 'cogs_local' || cat.id === 'cogs_variance') totals.foodCost += amount;
    });
    if (hasFactory && !factoryOnly) {
      /* a cost line: under-absorption is positive, over-absorption negative */
      var depAt = lines.length; for (var i = 0; i < lines.length; i++) if (lines[i].group === 'below_ebitda') { depAt = i; break; }
      lines.splice(depAt, 0, { key: 'factory_absorption', label: 'Factory under / (over) absorption', group: 'factory', groupLabel: 'Factory (central kitchen)', amount: -absorption, pctOfSales: ratio(-absorption, pctBase), estimatedPart: 0 });
      totals.opex += -absorption;
    }
    var hoIdx = st.unitIdx.ho;
    if (others.indexOf(hoIdx) !== -1) { totals.headOffice = 0; months.forEach(function (mi) { for (c = 0; c < NC; c++) totals.headOffice += st.amt[(hoIdx * NMO + mi) * NC + c]; }); }
    var revenue = factoryOnly ? transferValue + logisticsRecovery : netSales;
    totals.notionalRevenue = factoryOnly ? revenue : null;
    totals.grossMargin = revenue - totals.cogs; totals.grossMarginPct = ratio(totals.grossMargin, pctBase);
    totals.ebitda = revenue - totals.cogs - totals.channelCosts - totals.opex; totals.ebitdaPct = ratio(totals.ebitda, pctBase);
    totals.ebit = totals.ebitda - totals.depreciation; totals.foodCostPct = ratio(totals.foodCost, netSales);
    var groups = [];
    cfg.expenseGroups.concat([{ id: 'factory', label: 'Factory (central kitchen)' }]).forEach(function (g) {
      var t = 0, e = 0, n = 0; lines.forEach(function (l) { if (l.group === g.id) { t += l.amount; e += l.estimatedPart; n += 1; } });
      if (n) groups.push({ id: g.id, label: g.label, amount: t, pctOfSales: ratio(t, pctBase), estimatedPart: e });
    });
    return { lines: lines, groups: groups, totals: totals, pctBase: factoryOnly ? 'transferValue' : 'netSales', view: factoryOnly ? 'factory' : (hasFactory ? 'company' : 'units') };
  }

  function emptyTotals() {
    return { netSales: 0, orders: 0, cogs: 0, grossMargin: 0, grossMarginPct: 0, channelCosts: 0, opex: 0, ebitda: 0, ebitdaPct: 0, depreciation: 0, ebit: 0, foodCost: 0, foodCostPct: 0,
      estimatedPart: 0, factoryAbsorption: null, headOffice: null, transferValue: null, logisticsRecovery: null, notionalRevenue: null };
  }

  /**
   * pnl(unitSel, period) - P&L of a unit, of all outlets ('outlets') or of the company ('all': the outlets at
   * transfer prices + the factory's under / over absorption + head office). Cost lines are positive amounts.
   */
  finance.pnl = function (unitSel, period) {
    var st = state(), units = resolveUnits(unitSel), months = resolveMonths(period);
    var out = { unitIds: [], period: periodOf(months), lines: [], groups: [], totals: emptyTotals(), prev: null, pctBase: 'netSales', view: 'units',
      sources: { costs: 'erp', aggregatorActual: ['swiggy_annexure', 'zomato_settlement'], aggregatorEstimated: 'estimate' } };
    if (!st || !units.length || !months.length) return out;
    var res = computePnl(units, months);
    out.unitIds = units.map(function (u) { return st.unitIds[u]; });
    out.lines = res.lines; out.groups = res.groups; out.totals = res.totals; out.pctBase = res.pctBase; out.view = res.view;
    /* the preceding period of equal length, for deltas */
    var n = months.length, first = months[0];
    if (first - n >= 0) { var pm = []; for (var i = first - n; i < first; i++) pm.push(i); out.prev = computePnl(units, pm).totals; out.prev.months = pm.map(function (i) { return st.cfg.months[i]; }); }
    return out;
  };

  /** pnlTrend(unitSel) - one row of P&L totals per month. */
  finance.pnlTrend = function (unitSel) {
    var st = state(), units = resolveUnits(unitSel), out = { unitIds: [], months: [], rows: [], view: 'units' };
    if (!st || !units.length) return out;
    out.unitIds = units.map(function (u) { return st.unitIds[u]; });
    st.cfg.months.forEach(function (mk, mi) {
      var res = computePnl(units, [mi]), t = res.totals, info = st.infos[mi];
      out.view = res.view; out.months.push(mk);
      out.rows.push({ monthKey: mk, label: info.label, partial: info.partial, periodLabel: info.periodLabel, netSales: t.netSales, orders: t.orders, cogs: t.cogs, foodCost: t.foodCost, foodCostPct: t.foodCostPct,
        grossMargin: t.grossMargin, grossMarginPct: t.grossMarginPct, channelCosts: t.channelCosts, channelCostsPct: ratio(t.channelCosts, t.netSales), opex: t.opex, opexPct: ratio(t.opex, t.netSales),
        ebitda: t.ebitda, ebitdaPct: t.ebitdaPct, depreciation: t.depreciation, factoryAbsorption: t.factoryAbsorption, headOffice: t.headOffice, transferValue: t.transferValue, estimatedPart: t.estimatedPart });
    });
    return out;
  };

  /* ----------------------------------------------------------- unit economics */

  /** Sum of a day-cube measure over outlet units, months and one stream (from the monthly roll-up of the sales layer). */
  function streamMeasure(outletUnits, months, s, measure) {
    var st = B, d = st.db, t = 0;
    outletUnits.forEach(function (u) { months.forEach(function (mi) { t += d.monthCube[((mi * st.NO + u) * st.NS + s) * d.dims.NM + d.M[measure]]; }); });
    return t;
  }

  /**
   * unitEconomics(unitSel, period) - per order, per sq ft, per seat, contribution by stream and break-even sales
   * for outlets; per kg dispatched for the factory.
   */
  finance.unitEconomics = function (unitSel, period) {
    var st = state(), units = resolveUnits(unitSel), months = resolveMonths(period);
    /* nothing in scope (or an unknown month): every block is present and zero-filled, so a page never meets a null it did not expect */
    var out = { unitIds: [], period: periodOf(months), orders: 0, netSales: 0, estimatedPart: 0,
      perOrder: { netSales: 0, foodCost: 0, packaging: 0, channelCosts: 0, channelCostsEstimated: 0, opex: 0, ebitda: 0 },
      perSqft: { sqft: 0, monthsEquivalent: 0, netSalesPerSqftPerMonth: 0, rentPerSqftPerMonth: 0, ebitdaPerSqftPerMonth: 0 },
      perSeat: { seats: 0, days: 0, dineInSalesPerSeatPerDay: 0, netSalesPerSeatPerDay: 0 }, byStream: [],
      breakEven: { fixedCostsPerMonth: 0, variableCostPct: 0, variableCostEstimatedPct: 0, estimatedPart: 0, contributionMarginPct: 0, breakEvenSalesPerMonth: null, netSalesRunRatePerMonth: 0, marginOfSafetyPct: null },
      perKg: { dispatchKg: 0, transferValue: 0, rawMaterials: 0, conversion: 0, logistics: 0, absorption: 0 }, view: 'units',
      sources: { costs: 'erp', aggregatorActual: ['swiggy_annexure', 'zomato_settlement'], aggregatorEstimated: 'estimate' } };
    if (!st || !units.length || !months.length) return out;
    var cfg = st.cfg, res = computePnl(units, months), t = res.totals, outletUnits = units.filter(isOutletIdx);
    out.unitIds = units.map(function (u) { return st.unitIds[u]; }); out.view = res.view; out.orders = t.orders; out.netSales = t.netSales;
    out.estimatedPart = t.estimatedPart;        /* aggregator charges of the unsettled tail inside channelCosts, at assumed contract rates */
    /* blocks that do not apply to the view are null by contract: perKg outside the factory view, the outlet blocks inside it */
    if (res.view === 'factory') {
      out.perOrder = null; out.perSqft = null; out.perSeat = null; out.breakEven = null;
      var kg = 0, rm = 0, conv = 0, log = 0;
      months.forEach(function (mi) { var p = st.fac.pnl(cfg.months[mi]); if (p) kg += p.dispatchKg; });
      res.lines.forEach(function (l) {
        if (l.key === 'raw_materials') rm += l.amount; else if (l.group === 'logistics') log += l.amount; else if (l.group !== 'below_ebitda') conv += l.amount;
      });
      out.perKg = { dispatchKg: kg, transferValue: ratio(t.transferValue, kg), rawMaterials: ratio(rm, kg), conversion: ratio(conv, kg), logistics: ratio(log, kg), absorption: ratio(t.ebitda, kg) };
      return out;
    }
    out.perKg = null;
    if (!outletUnits.length) return out;      /* head office alone: the outlet blocks stay zero-filled */
    out.perOrder = { netSales: ratio(t.netSales, t.orders), foodCost: ratio(t.foodCost, t.orders), packaging: ratio(t.cogs - t.foodCost, t.orders), channelCosts: ratio(t.channelCosts, t.orders),
      channelCostsEstimated: ratio(t.estimatedPart, t.orders),     /* the part of channelCosts that is an estimate */
      opex: ratio(t.opex, t.orders), ebitda: ratio(t.ebitda, t.orders) };

    /* one pass over the ledger lines in scope: channel costs by channel, variable cost, fixed cost of a full month */
    var byChannel = {}, estByChannel = {}, cardMdr = 0, variableCost = 0, variableEstimated = 0, fixedMonthly = 0;
    outletUnits.forEach(function (u) { months.forEach(function (mi) {
      (st.byUnitMonth[st.unitIds[u] + '|' + cfg.months[mi]] || []).forEach(function (l) {
        if (l.group === 'below_ebitda') return;
        if (l.channelId) { byChannel[l.channelId] = (byChannel[l.channelId] || 0) + l.amount; estByChannel[l.channelId] = (estByChannel[l.channelId] || 0) + l.estimatedPart; }
        if (l.categoryId === 'card_mdr') cardMdr += l.amount;
        if (l.behaviour === 'variable') { variableCost += l.amount; variableEstimated += l.estimatedPart; } else fixedMonthly += l.fullMonthAmount !== null ? l.fullMonthAmount : l.amount;
      });
    }); });

    /* contribution by stream: recipe cost of the stream plus its share of the variance, its packaging, and its channel's costs */
    var theoAll = 0, inStore = 0, theo = cfg.streams.map(function (stream, s) {
      var v = 0; outletUnits.forEach(function (u) { months.forEach(function (mi) { v += st.theoByStream[(mi * st.NO + u) * st.NS + s]; }); });
      theoAll += v; if (stream.channelId === 'petpooja') inStore += streamMeasure(outletUnits, months, s, 'netSales');
      return v;
    });
    /* shared lines are split in whole rupees and the last stream that carries a share takes the residual, so the streams add up to the P&L line */
    var packagingLine = t.cogs - t.foodCost, foodLeft = t.foodCost, packLeft = packagingLine, mdrLeft = cardMdr, lastFood = -1, lastPack = -1, lastInStore = -1;
    var packExact = cfg.streams.map(function (stream, s) {
      var v = 0; outletUnits.forEach(function (u) { months.forEach(function (mi) { v += st.packByStream[(mi * st.NO + u) * st.NS + s]; }); });
      return v;
    });
    cfg.streams.forEach(function (stream, s) { if (theo[s] > 0) lastFood = s; if (packExact[s] > 0) lastPack = s; if (stream.channelId === 'petpooja' && streamMeasure(outletUnits, months, s, 'netSales') > 0) lastInStore = s; });
    cfg.streams.forEach(function (stream, s) {
      var o = { streamId: stream.id, label: stream.label, channelId: stream.channelId, mediumId: stream.mediumId, colourVar: stream.colourVar,
        orders: streamMeasure(outletUnits, months, s, 'orders'), netSales: streamMeasure(outletUnits, months, s, 'netSales'), foodCost: 0, packaging: 0, channelCosts: 0, estimatedPart: 0 };
      o.foodCost = s === lastFood ? foodLeft : Math.round(ratio(theo[s], theoAll) * t.foodCost); foodLeft -= o.foodCost;
      o.packaging = s === lastPack ? packLeft : Math.round(packExact[s]); packLeft -= o.packaging;
      if (stream.channelId === 'petpooja') { o.channelCosts = s === lastInStore ? mdrLeft : Math.round(ratio(o.netSales, inStore) * cardMdr); mdrLeft -= o.channelCosts; }
      else { o.channelCosts = byChannel[stream.channelId] || 0; o.estimatedPart = estByChannel[stream.channelId] || 0; }   /* estimatedPart: the unsettled tail inside channelCosts */
      o.contribution = o.netSales - o.foodCost - o.packaging - o.channelCosts; o.contributionPct = ratio(o.contribution, o.netSales);
      o.perOrder = { netSales: ratio(o.netSales, o.orders), foodCost: ratio(o.foodCost, o.orders), packaging: ratio(o.packaging, o.orders), channelCosts: ratio(o.channelCosts, o.orders),
        channelCostsEstimated: ratio(o.estimatedPart, o.orders), contribution: ratio(o.contribution, o.orders) };
      out.byStream.push(o);
    });

    var sqft = 0, seats = 0, rent = 0, days = 0, monthsEquivalent = 0, dineIn = streamMeasure(outletUnits, months, 0, 'netSales');
    outletUnits.forEach(function (u) { sqft += cfg.outlets[u].sqft; seats += cfg.outlets[u].seats; });
    months.forEach(function (mi) { days += st.infos[mi].elapsedDays; monthsEquivalent += st.infos[mi].prorata; });
    res.lines.forEach(function (l) { if (l.key === 'rent') rent = l.amount; });
    out.perSqft = { sqft: sqft, monthsEquivalent: monthsEquivalent, netSalesPerSqftPerMonth: ratio(t.netSales, sqft * monthsEquivalent), rentPerSqftPerMonth: ratio(rent, sqft * monthsEquivalent),
      ebitdaPerSqftPerMonth: ratio(t.ebitda, sqft * monthsEquivalent) };
    out.perSeat = { seats: seats, days: days, dineInSalesPerSeatPerDay: ratio(dineIn, seats * days), netSalesPerSeatPerDay: ratio(t.netSales, seats * days) };

    /* break-even: the fixed costs of a full month over the contribution margin ratio of the period */
    fixedMonthly = fixedMonthly / months.length;
    var cm = 1 - ratio(variableCost, t.netSales), runRate = ratio(t.netSales, monthsEquivalent), breakEven = cm > 0 ? fixedMonthly / cm : null;
    out.breakEven = { fixedCostsPerMonth: Math.round(fixedMonthly), variableCostPct: ratio(variableCost, t.netSales),
      variableCostEstimatedPct: ratio(variableEstimated, t.netSales), estimatedPart: variableEstimated,     /* how much of the variable cost is an estimate */
      contributionMarginPct: cm,
      breakEvenSalesPerMonth: breakEven === null ? null : Math.round(breakEven), netSalesRunRatePerMonth: Math.round(runRate),
      marginOfSafetyPct: breakEven === null || runRate <= 0 ? null : 1 - breakEven / runRate };
    return out;
  };

  /* ---------------------------------------------------------------- food cost */

  /** foodCost(period, unitSel?) - theoretical (recipe) vs actual food cost by outlet, the variance in rupees and points, and the by-dish recipe cost. */
  finance.foodCost = function (period, unitSel) {
    var st = state(), months = resolveMonths(period), units = resolveUnits(unitSel === undefined ? 'outlets' : unitSel).filter(function (u) { return st && isOutletIdx(u); });
    var redFlagPct = MK.config ? MK.config.outletCostsCommon.foodCostRedFlagPct : 0.38;
    var tot = { outletId: null, label: 'Total', netSales: 0, theoreticalFactory: 0, theoreticalLocal: 0, varianceFactory: 0, varianceLocal: 0, actualFactory: 0 };
    var out = { period: periodOf(months), rows: [], totals: finishFoodRow({ outletId: null, label: 'Total', netSales: 0, theoreticalFactory: 0, theoreticalLocal: 0, varianceFactory: 0, varianceLocal: 0, actualFactory: 0 }, redFlagPct),
      dishes: [], redFlagPct: redFlagPct, source: 'erp' };
    if (!st || !months.length || !units.length) return out;
    var cfg = st.cfg, NO = st.NO, SUMMED = ['netSales', 'theoreticalFactory', 'theoreticalLocal', 'varianceFactory', 'varianceLocal', 'actualFactory'];
    units.forEach(function (u) {
      var r = { outletId: st.unitIds[u], label: cfg.outlets[u].name, colourVar: cfg.outlets[u].colourVar, netSales: 0, theoreticalFactory: 0, theoreticalLocal: 0, varianceFactory: 0, varianceLocal: 0, actualFactory: 0 };
      months.forEach(function (mi) {
        var k = mi * NO + u;
        r.netSales += st.netCache[k]; r.theoreticalFactory += st.theoFactory[k]; r.theoreticalLocal += st.theoLocal[k];
        r.varianceFactory += st.varianceFactory[k]; r.varianceLocal += st.varianceLocal[k]; r.actualFactory += st.actualFactory[k];
      });
      SUMMED.forEach(function (key) { tot[key] += r[key]; });
      out.rows.push(finishFoodRow(r, out.redFlagPct));
    });
    out.totals = finishFoodRow(tot, out.redFlagPct);
    /* by dish: recipe cost of the portions sold in scope; rounded so that the rows add up to the theoretical total */
    var rows = [], exact = [];
    cfg.dishes.forEach(function (dish, di) {
      var qty = 0, cost = 0, net = 0;
      units.forEach(function (u) { months.forEach(function (mi) {
        var q = 0; for (var s = 0; s < st.NS; s++) q += st.db.monthDishQty[((mi * NO + u) * st.NS + s) * st.NDI + di];
        qty += q; cost += q * (st.dishFactory[di] + st.dishLocal[mi * st.NDI + di]); net += st.dishNet[(mi * NO + u) * st.NDI + di];
      }); });
      if (!qty) return;
      rows.push({ dishId: dish.id, name: dish.name, short: dish.short, category: dish.category, qty: qty, netSales: net, theoreticalCost: Math.round(cost), costPerPortion: cost / qty, foodCostPct: ratio(cost, net) });
      exact.push(cost);
    });
    var target = out.totals.theoretical, given = 0, big = 0;
    rows.forEach(function (r, i) { given += r.theoreticalCost; if (exact[i] > exact[big]) big = i; });
    if (rows.length) rows[big].theoreticalCost += target - given;
    out.dishes = rows.sort(function (a, b) { return b.theoreticalCost - a.theoreticalCost; });
    return out;
  };

  function finishFoodRow(r, redFlagPct) {
    r.theoretical = r.theoreticalFactory + r.theoreticalLocal; r.variance = r.varianceFactory + r.varianceLocal; r.actual = r.theoretical + r.variance;
    r.actualLocal = r.theoreticalLocal + r.varianceLocal;
    r.theoreticalPct = ratio(r.theoretical, r.netSales); r.actualPct = ratio(r.actual, r.netSales); r.variancePts = r.actualPct - r.theoreticalPct; r.variancePctOfTheoretical = ratio(r.variance, r.theoretical);
    r.redFlag = r.actualPct > redFlagPct;
    return r;
  }

  /**
   * dishCost(dishId, outletId, date) or dishCost(dishId, { outletId, mediumId | streamId, monthKey | date })
   * - the recipe cost card: factory items at transfer price + local items at the month's price + packaging for the medium.
   * MK.data.dishes() reads `food` (the food cost, as in foodCost() and the P&L) and `packagingCost` separately; `total` is their sum.
   */
  finance.dishCost = function (dishId, a, b) {
    var st = state(); if (!st) return null;
    var cfg = st.cfg, ctx = a && typeof a === 'object' ? a : { outletId: a, date: b };
    var months = cfg.months, monthKey = ctx.monthKey || (typeof ctx.date === 'string' ? ctx.date.slice(0, 7) : months[months.length - 1]);
    var mi = months.indexOf(monthKey); if (mi < 0) { mi = monthKey < months[0] ? 0 : months.length - 1; monthKey = months[mi]; }
    var mediumId = ctx.mediumId || null;
    if (!mediumId && ctx.streamId) cfg.streams.forEach(function (s) { if (s.id === ctx.streamId) mediumId = s.mediumId; });
    if (st.MEDIUMS.indexOf(mediumId) === -1) mediumId = 'dinein';
    var outletId = typeof ctx.outletId === 'string' ? ctx.outletId : null, date = typeof ctx.date === 'string' && ctx.date.length === 10 ? ctx.date : st.infos[mi].to;
    if (typeof dishId !== 'string' || !has(st.db.index.dish, dishId)) return null;     /* unknown id, including names that live on Object.prototype */
    var key = dishId + '|' + outletId + '|' + mediumId + '|' + monthKey + '|' + date;
    if (has(st.cardCache, key)) return st.cardCache[key];
    var di = st.db.index.dish[dishId];
    var dish = cfg.dishes[di], fpById = byId(cfg.items.factoryProducts), localById = byId(cfg.items.local), packById = byId(cfg.items.packaging);
    function priced(list, table) {
      return (list || []).map(function (l) {
        var it = table[l.itemId], perPiece = it.unit === 'pc', price = it.prices[mi];
        return { itemId: it.id, name: it.name, qty: l.qty, unit: perPiece ? 'pc' : (it.unit === 'l' ? 'ml' : 'g'), price: price, priceUnit: it.unit, cost: perPiece ? price * l.qty : price * l.qty / 1000 };
      });
    }
    var card = { dishId: dish.id, name: dish.name, short: dish.short, category: dish.category, veg: dish.veg, outletId: outletId, monthKey: monthKey, date: date, mediumId: mediumId,
      soldHere: outletId ? MK.data.dishSoldAt(dish.id, outletId) : true,
      factoryItems: dish.recipe.factory.map(function (l) { var p = fpById[l.sku]; return { sku: p.id, name: p.name, grams: l.g, transferPrice: p.transferPrice, cost: p.transferPrice * l.g / 1000 }; }),
      localItems: priced(dish.recipe.local, localById), packagingItems: priced(has(dish.recipe.packaging, mediumId) ? dish.recipe.packaging[mediumId] : [], packById),
      factoryCost: st.dishFactory[di], localCost: st.dishLocal[mi * st.NDI + di], packagingCost: st.dishPack[(mi * st.NDI + di) * 3 + st.MEDIUMS.indexOf(mediumId)],
      packagingByMedium: { dinein: st.dishPack[(mi * st.NDI + di) * 3], takeaway: st.dishPack[(mi * st.NDI + di) * 3 + 1], delivery: st.dishPack[(mi * st.NDI + di) * 3 + 2] },
      orderPackaging: { dinein: st.orderPack[mi * 3], takeaway: st.orderPack[mi * 3 + 1], delivery: st.orderPack[mi * 3 + 2] } };
    card.food = card.factoryCost + card.localCost; card.total = card.food + card.packagingCost;
    card.posPrice = MK.data.posPriceOn(dish.id, date); card.aggPrice = outletId ? MK.data.aggPriceOn(dish.id, outletId, date) : null;
    card.foodCostPctPos = ratio(card.food, card.posPrice); card.foodCostPctAgg = card.aggPrice ? card.food / card.aggPrice : null;
    st.cardCache[key] = Object.freeze(card);
    return card;
  };

  /* ------------------------------------------------------------------- ledger */

  function filterLines(filter, unitIdxList) {
    var st = B, f = filter || {}, months = resolveMonths(f.monthKey || f.period || (f.from || f.to ? { from: f.from, to: f.to } : 'fy')).map(function (i) { return st.cfg.months[i]; });
    var unitIds = unitIdxList.map(function (u) { return st.unitIds[u]; });
    var catsWanted = f.categoryIds || (f.categoryId ? [f.categoryId] : null);
    var out = [];
    unitIds.forEach(function (unitId) { months.forEach(function (mk) {
      (st.byUnitMonth[unitId + '|' + mk] || []).forEach(function (l) {
        if (catsWanted && catsWanted.indexOf(l.categoryId) === -1) return;
        if (f.group && l.group !== f.group) return;
        if (f.vendorId && l.vendorId !== f.vendorId) return;
        if (f.billableOnly && !l.billable) return;
        out.push(l);
      });
    }); });
    return out;
  }

  /**
   * ledger(filter) - the raw cost lines inside the persona's scope (read-only objects).
   * filter: { unitId | unitIds | 'all' | 'outlets', monthKey | { from, to }, categoryId | categoryIds, group, vendorId, billableOnly }
   */
  finance.ledger = function (filter) {
    var st = state(); if (!st) return [];
    var f = filter || {};
    return filterLines(f, resolveUnits(f.unitIds || f.unitId || 'all'));
  };

  /* ------------------------------------------------------------------- budget */

  /** The plan of one unit and month by category (unscoped, cached): model expectation as of March, rounded to clean figures. */
  function planFor(u, mi) {
    var st = B, key = u + '|' + mi; if (st.planCache[key]) return st.planCache[key];
    var cfg = st.cfg, bp = MODEL.budget, unitId = st.unitIds[u], ref = bp.referenceMonthIdx, NC = st.NC, plan = new Float64Array(NC), head = 1 + bp.headroomPct;
    function set(catId, value) { plan[st.catIdx[catId]] += value; }
    function refAmt(unit, catId) { return st.amt[(unit * st.NMO + ref) * NC + st.catIdx[catId]]; }
    var lpgRef = cfg.tariffs.lpgBudgetReference, lpgNow = cfg.tariffs.lpgCylinder19kg[mi];
    if (isOutletIdx(u)) {
      var sales = bp.netSales[unitId][mi], refNet = st.netCache[ref * st.NO + u];
      ['cogs_factory', 'cogs_local', 'packaging', 'agg_commission', 'agg_collection', 'agg_other', 'agg_gst_on_fees', 'agg_refunds', 'card_mdr', 'charcoal', 'logistics_allocation'].forEach(function (c) { set(c, ratio(refAmt(u, c), refNet) * sales); });
      var refFees = st.db.feesByMonth(cfg.months[ref], unitId, null).total;
      set('agg_ads', bp.adsPctOfMenuValue[unitId] * ratio(refFees.grossValue, refNet) * sales);
      set('cogs_variance', bp.foodCostVarianceAllowancePts * sales);
      set('housekeeping', st.housekeepingPct(unitId) * sales); set('repairs', st.repairsPct(unitId) * sales); set('local_marketing', st.marketingPct(unitId, mi) * sales);
      /* fixed lines: the ledger's full-month figures, with gas at the price the budget was set on */
      (st.byUnitMonth[unitId + '|' + cfg.months[mi]] || []).forEach(function (l) {
        if (l.behaviour !== 'fixed' || l.categoryId === 'repairs') return;
        var full = l.fullMonthAmount !== null ? l.fullMonthAmount : l.amount;
        set(l.categoryId, l.categoryId === 'gas_lpg' ? full * lpgRef / lpgNow : full);
      });
    } else {
      var networkBudget = 0, networkRef = 0;
      st.db.outletIds.forEach(function (id, o) { networkBudget += bp.netSales[id][mi]; networkRef += st.netCache[ref * st.NO + o]; });
      (st.byUnitMonth[unitId + '|' + cfg.months[mi]] || []).forEach(function (l) {
        var full = l.fullMonthAmount !== null ? l.fullMonthAmount : l.amount;
        if (l.categoryId === 'raw_materials' || l.categoryId === 'production_consumables') return;
        if (l.categoryId === 'vehicle_fuel' || l.categoryId === 'pune_run') return;     /* driven by kg and by runs: planned at the monthly figure below */
        set(l.categoryId, l.categoryId === 'gas_lpg' ? full * lpgRef / lpgNow : full);
      });
      if (unitId === 'factory') { var fpar = cfg.factoryParams; set('vehicle_fuel', fpar.vans.count * fpar.vans.fuelAndTollsEach); set('pune_run', fpar.puneRunExtra); }
      if (unitId === 'factory' && st.fac) {
        /* raw materials at standard prices for the budgeted volume; consumables on the budgeted transfer value */
        var p = st.fac.pnl(cfg.months[ref]), scale = ratio(networkBudget, networkRef);
        if (p) { set('raw_materials', (p.rmConsumed + p.variance.rmPrice) * scale); set('production_consumables', cfg.factoryParams.productionConsumablesPctOfTransferValue * p.transferValue * scale); }
      }
    }
    for (var c = 0; c < NC; c++) plan[c] = clean(plan[c] * head);
    st.planCache[key] = plan;
    return plan;
  }

  /** budgetPlan(monthKey, unitSel) - the budget by category: { rows: [{ categoryId, label, group, plan, planToDate }], totals }. */
  finance.budgetPlan = function (monthKey, unitSel) {
    var st = state(), months = resolveMonths(monthKey), units = resolveUnits(unitSel);
    var out = { monthKey: months.length && st ? st.cfg.months[months[0]] : monthKey, unitIds: [], period: months.length && st ? st.infos[months[0]] : monthInfo(null), rows: [], totals: { plan: 0, planToDate: 0 }, netSalesPlan: 0, basis: MK.config ? MK.config.budgetPolicy.basis : '' };
    if (!st || !months.length || !units.length) return out;
    var mi = months[0], info = st.infos[mi], sums = new Float64Array(st.NC);
    out.unitIds = units.map(function (u) { return st.unitIds[u]; });
    units.forEach(function (u) { var p = planFor(u, mi); for (var c = 0; c < st.NC; c++) sums[c] += p[c]; if (isOutletIdx(u)) out.netSalesPlan += MODEL.budget.netSales[st.unitIds[u]][mi]; });
    st.cats.forEach(function (cat, ci) {
      if (!sums[ci]) return;
      var row = { categoryId: cat.id, label: cat.label, group: cat.group, plan: sums[ci], planToDate: Math.round(sums[ci] * info.prorata) };
      out.rows.push(row); out.totals.plan += row.plan; out.totals.planToDate += row.planToDate;
    });
    return out;
  };

  /* bills written by the seed / workflow layers: read leniently, never throw */
  function billsAll() { try { var a = MK.store.coll('bills').all(); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function billUnit(b) { return b.unitId || b.outletId || null; }
  function billMonth(b) { return b.monthKey || b.periodMonth || String(b.billDate || b.invoiceDate || b.date || '').slice(0, 7); }
  function billAmount(b) { return num(b.amount, num(b.total, 0)); }
  function billPayable(b) { return num(b.netPayable, num(b.payable, num(b.total, billAmount(b)))); }
  /*
   * What a bill costs, by category: [{ categoryId, amount }]. The restaurant pays GST at 5% without input tax credit, so the GST
   * on a purchase is part of its cost: a bill is expensed at amount + GST (before TDS), which is also what the ledger line it
   * belongs to carries. Expense lines, when present, say where the parts go (rent -> rent, its GST -> rent_gst); whatever they
   * leave unallocated stays with the first line.
   */
  function billParts(b) {
    var cost = billAmount(b) + num(b.gstAmount, 0);
    if (Array.isArray(b.lines) && b.lines.length && b.lines[0] && b.lines[0].categoryId) {
      var parts = b.lines.map(function (l) { return { categoryId: l.categoryId, amount: num(l.amount, 0) }; }), allocated = 0;
      parts.forEach(function (x) { allocated += x.amount; });
      parts[0].amount += cost - allocated;
      return parts;
    }
    return [{ categoryId: b.categoryId || b.expenseCategoryId || null, amount: cost }];
  }
  /* First month whose costs pass through vendor bills: the seed's parameter, else the earliest expense month in the store. */
  function billsFromMonth(bills) {
    if (MK.seed && MK.seed.params && typeof MK.seed.params.billsFromMonth === 'string') return MK.seed.params.billsFromMonth;
    var first = null;
    bills.forEach(function (b) { var m = b ? billMonth(b) : ''; if (/^\d{4}-\d{2}$/.test(m) && (first === null || m < first)) first = m; });
    return first;
  }

  /**
   * budget(monthKey, unitSel) - plan vs committed (bills APPROVED, IN_BATCH, PAID) vs pipeline (SUBMITTED, UNDER_REVIEW) by category.
   * The basis is decided per MONTH: a month whose costs pass through vendor bills (from MK.seed.params.billsFromMonth on, while the
   * store holds bills) is read from the bills, every earlier month from the ledger - so April to June never show as unspent.
   * Lines that never pass through a vendor bill (payroll, aggregator deductions, factory transfers, accruals) always take the ledger.
   * Aggregator charges of the unsettled tail are estimates: they are reported as estimatedPart and are never part of committed or actual.
   */
  finance.budget = function (monthKey, unitSel) {
    var st = state(), months = resolveMonths(monthKey), units = resolveUnits(unitSel), policy = MK.config ? MK.config.budgetPolicy : { warnAtPct: 0.9, overAtPct: 1 };
    var out = { monthKey: months.length && st ? st.cfg.months[months[0]] : monthKey, unitIds: [], period: months.length && st ? st.infos[months[0]] : monthInfo(null), basis: 'ledger', rows: [],
      totals: { plan: 0, planToDate: 0, committed: 0, pipeline: 0, estimatedPart: 0, used: 0, actual: 0, variance: 0 },
      counts: { OK: 0, WATCH: 0, OVER: 0 }, policy: policy, sources: { costs: 'erp', aggregatorActual: ['swiggy_annexure', 'zomato_settlement'], aggregatorEstimated: 'estimate' } };
    if (!st || !months.length || !units.length) return out;
    var mi = months[0], mk = st.cfg.months[mi], info = st.infos[mi], NC = st.NC, unitIds = units.map(function (u) { return st.unitIds[u]; });
    var plan = new Float64Array(NC), actual = new Float64Array(NC), estimated = new Float64Array(NC), nonBillable = new Float64Array(NC), committed = new Float64Array(NC), pipeline = new Float64Array(NC),
      billCount = new Int32Array(NC), flex = new Float64Array(NC), recurring = new Uint8Array(NC);
    out.unitIds = unitIds;
    units.forEach(function (u) {
      var p = planFor(u, mi), k = isOutletIdx(u) ? ratio(st.netCache[mi * st.NO + u] / info.prorata, MODEL.budget.netSales[st.unitIds[u]][mi]) : 1;
      for (var c = 0; c < NC; c++) { plan[c] += p[c]; flex[c] += p[c] * (st.variable[st.cats[c].id] ? k : 1); }
      (st.byUnitMonth[st.unitIds[u] + '|' + mk] || []).forEach(function (l) {
        var c = st.catIdx[l.categoryId];
        if (l.estimated) { estimated[c] += l.amount; return; }          /* an estimate is neither actual nor committed */
        actual[c] += l.amount;
        if (!l.billable) nonBillable[c] += l.amount; else if (l.billing.frequency !== 'monthly') recurring[c] = 1;   /* more bills still to come in an open month */
      });
    });
    var bills = billsAll(), from = bills.length ? billsFromMonth(bills) : null, useBills = from !== null && mk >= from;
    if (useBills) bills.forEach(function (b) {
      if (!b || unitIds.indexOf(billUnit(b)) === -1 || billMonth(b) !== mk) return;
      var bucket = COMMITTED[b.status] ? committed : PIPELINE[b.status] ? pipeline : null; if (!bucket) return;
      billParts(b).forEach(function (part) { var c = st.catIdx[part.categoryId]; if (c === undefined) return; bucket[c] += part.amount; billCount[c] += 1; });
    });
    out.basis = useBills ? 'bills' : 'ledger';
    st.cats.forEach(function (cat, ci) {
      if (!plan[ci] && !actual[ci] && !estimated[ci] && !committed[ci] && !pipeline[ci]) return;
      var com = useBills ? committed[ci] + nonBillable[ci] : actual[ci], pipe = useBills ? pipeline[ci] : 0, est = estimated[ci], used = com + est + pipe;
      /* an open month is judged against the full-month plan when bills drive it, against the plan to date when accruals do */
      var base = !useBills && info.partial ? Math.round(plan[ci] * info.prorata) : plan[ci];
      var status = com + est > base * policy.overAtPct ? 'OVER' : (used > base * policy.overAtPct ? 'WATCH' : (useBills && info.partial && recurring[ci] && used >= base * policy.warnAtPct ? 'WATCH' : 'OK'));
      var row = { categoryId: cat.id, label: cat.label, group: cat.group, plan: plan[ci], planToDate: Math.round(plan[ci] * info.prorata), flexedPlan: Math.round(flex[ci]), comparedWith: base,
        committed: com, pipeline: pipe, estimatedPart: est, actual: actual[ci], used: used, remaining: base - used, variance: used - base, utilisation: ratio(used, base), status: status,
        basis: useBills && actual[ci] !== nonBillable[ci] ? (nonBillable[ci] ? 'bills+ledger' : 'bills') : 'ledger', billCount: billCount[ci] };
      out.rows.push(row); out.counts[status] += 1;
      out.totals.plan += row.plan; out.totals.planToDate += row.planToDate; out.totals.committed += com; out.totals.pipeline += pipe; out.totals.estimatedPart += est; out.totals.used += used;
      out.totals.actual += row.actual; out.totals.variance += row.variance;
    });
    return out;
  };

  /* ----------------------------------------------------------------- payables */

  /* the ageing buckets, and one more for money that has left: bills of a batch the director has released, waiting for the bank reference */
  var AGE_BUCKETS = [{ id: 'not_due', label: 'Not yet due' }, { id: 'd1_7', label: 'Overdue 1-7 days' }, { id: 'd8_30', label: 'Overdue 8-30 days' }, { id: 'd31_60', label: 'Overdue 31-60 days' }, { id: 'd60_plus', label: 'Overdue 60+ days' },
    { id: 'in_transit', label: 'Released to the bank - UTR awaited' }];
  var IN_TRANSIT = 5;

  /**
   * payables(asOf) - open bills (submitted to in-batch) by ageing bucket, by vendor and by unit; due within 7 days; overdue. Empty-safe.
   * A bill whose payment batch is RELEASED has been paid as far as the vendor is concerned: it stays open until the UTR is
   * recorded, but it is reported as inTransit and is neither overdue nor due.
   */
  finance.payables = function (asOf) {
    var D = MK.dates, today = typeof asOf === 'string' && asOf.length === 10 ? asOf : MK.calendar.today, allowed = MK.session.allowedUnitIds();
    var out = { asOf: today, total: 0, approved: 0, awaitingApproval: 0, overdue: { amount: 0, count: 0 }, dueIn7Days: { amount: 0, count: 0, bills: [] }, inTransit: { amount: 0, count: 0 }, count: 0,
      buckets: AGE_BUCKETS.map(function (b) { return { id: b.id, label: b.label, amount: 0, count: 0 }; }), byVendor: [], byUnit: [] };
    var vendors = {}, units = {}, vendorById = MK.config ? byId(MK.config.vendors) : {}, unitById = MK.config ? byId(MK.config.outlets) : {};
    try { (MK.store.coll('vendors').all() || []).forEach(function (v) { if (v && v.id) vendorById[v.id] = v; }); } catch (e) { /* master data only */ }
    var released = {};
    try { (MK.store.coll('batches').all() || []).forEach(function (pb) { if (pb && pb.id && pb.status === 'RELEASED') released[pb.id] = true; }); } catch (e2) { /* no batches */ }
    billsAll().forEach(function (b) {
      if (!b || !(COMMITTED[b.status] || PIPELINE[b.status]) || b.status === 'PAID') return;
      var unitId = billUnit(b); if (allowed.indexOf(unitId) === -1) return;
      var amount = billPayable(b); if (!amount) return;
      var v = vendorById[b.vendorId] || null, billDate = b.billDate || b.invoiceDate || b.date || today;
      var due = typeof b.dueDate === 'string' && b.dueDate.length === 10 ? b.dueDate : D.addDays(billDate, v ? num(v.creditDays, 0) : 0);
      var transit = b.status === 'IN_BATCH' && !!b.batchId && released[b.batchId] === true;
      var late = D.diffDays(due, today), bi = transit ? IN_TRANSIT : late <= 0 ? 0 : late <= 7 ? 1 : late <= 30 ? 2 : late <= 60 ? 3 : 4;
      var isLate = !transit && late > 0, isDue = !transit && late <= 0 && D.diffDays(today, due) <= 7;
      out.total += amount; out.count += 1; out.buckets[bi].amount += amount; out.buckets[bi].count += 1;
      if (PIPELINE[b.status]) out.awaitingApproval += amount; else out.approved += amount;
      if (transit) { out.inTransit.amount += amount; out.inTransit.count += 1; }
      if (isLate) { out.overdue.amount += amount; out.overdue.count += 1; }
      else if (isDue) { out.dueIn7Days.amount += amount; out.dueIn7Days.count += 1; out.dueIn7Days.bills.push({ id: b.id, vendorId: b.vendorId, unitId: unitId, amount: amount, dueDate: due, status: b.status }); }
      var vk = b.vendorId || 'unknown';
      var vr = has(vendors, vk) ? vendors[vk] : (vendors[vk] = { vendorId: b.vendorId || null, name: v ? v.name : 'Unknown vendor', total: 0, overdue: 0, dueIn7Days: 0, inTransit: 0, count: 0, oldestDueDate: due, buckets: [0, 0, 0, 0, 0, 0] });
      vr.total += amount; vr.count += 1; vr.buckets[bi] += amount; if (transit) vr.inTransit += amount; if (isLate) vr.overdue += amount; else if (isDue) vr.dueIn7Days += amount; if (due < vr.oldestDueDate) vr.oldestDueDate = due;
      var ur = has(units, unitId) ? units[unitId] : (units[unitId] = { unitId: unitId, label: unitById[unitId] ? unitById[unitId].name : unitId, total: 0, overdue: 0, dueIn7Days: 0, inTransit: 0, count: 0, buckets: [0, 0, 0, 0, 0, 0] });
      ur.total += amount; ur.count += 1; ur.buckets[bi] += amount; if (transit) ur.inTransit += amount; if (isLate) ur.overdue += amount; else if (isDue) ur.dueIn7Days += amount;
    });
    out.byVendor = Object.keys(vendors).map(function (k) { return vendors[k]; }).sort(function (a, b) { return b.total - a.total; });
    out.byUnit = Object.keys(units).map(function (k) { return units[k]; }).sort(function (a, b) { return b.total - a.total; });
    out.dueIn7Days.bills.sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : b.amount - a.amount; });
    return out;
  };

  /* ---------------------------------------------- vendor spend, cost centres */

  /** vendorSpend(vendorId) - monthly spend history of a vendor from the ledger (units in scope), by unit and by category. */
  finance.vendorSpend = function (vendorId) {
    var st = state(), out = { vendorId: vendorId, months: MK.config ? MK.config.months.slice() : [], values: [], total: 0, byUnit: [], byCategory: [], billing: null, averagePerMonth: 0 };
    if (!st) return out;
    var units = resolveUnits('all'), byUnit = {}, byCat = {}, fullMonths = 0, fullTotal = 0;
    out.values = out.months.map(function () { return 0; });
    /* how the vendor bills is master data: present whatever the scope, null for an unknown vendor */
    if (typeof vendorId === 'string' && st.vendorById[vendorId]) out.billing = { frequency: MODEL.billingFrequency[vendorId] || 'monthly', creditDays: st.vendorById[vendorId].creditDays };
    filterLines({ vendorId: vendorId }, units).forEach(function (l) {
      var mi = out.months.indexOf(l.monthKey); out.values[mi] += l.amount; out.total += l.amount;
      byUnit[l.unitId] = (byUnit[l.unitId] || 0) + l.amount; byCat[l.categoryId] = (byCat[l.categoryId] || 0) + l.amount;
    });
    st.infos.forEach(function (info, mi) { if (!info.partial) { fullMonths += 1; fullTotal += out.values[mi]; } });
    out.averagePerMonth = Math.round(ratio(fullTotal, fullMonths));
    out.byUnit = Object.keys(byUnit).map(function (id) { return { unitId: id, amount: byUnit[id] }; }).sort(function (a, b) { return b.amount - a.amount; });
    out.byCategory = Object.keys(byCat).map(function (id) { return { categoryId: id, label: st.catById[id].label, amount: byCat[id] }; }).sort(function (a, b) { return b.amount - a.amount; });
    return out;
  };

  /** Department shares of one ledger line of a unit. */
  function departmentShares(unitType, line, payrollShares) {
    var dep = MODEL.departments[unitType], n = dep.names.length, c = line.categoryId;
    if (['salaries', 'employer_oncosts', 'staff_meals', 'staff_accommodation'].indexOf(c) !== -1) {
      if (unitType === 'factory') return line.component === 'logistics' ? [0, 0, 1] : payrollShares;
      return payrollShares;
    }
    if (dep.byCategory[c]) return dep.byCategory[c];
    var rest = []; for (var i = 0; i < n; i++) rest.push(0);
    rest[unitType === 'factory' ? 0 : 1] = 1;    /* everything else: Service at an outlet, Production at the factory, Admin at head office */
    return rest;
  }

  function payrollSharesOf(unitId, unitType) {
    var st = B, cfg = st.cfg, dep = MODEL.departments[unitType], shares = dep.names.map(function () { return 0; }), total = 0;
    if (unitType === 'outlet') {
      st.rosterOf(unitId).forEach(function (n, i) {
        var role = cfg.wages.roles[i], pay = n * role.gross, split = dep.kitchenRoles.indexOf(role.id) !== -1 ? [1, 0, 0] : (dep.sharedRoles[role.id] || [0, 1, 0]);
        split.forEach(function (x, k) { shares[k] += pay * x; }); total += pay;
      });
    } else if (unitType === 'factory') {
      (st.fac ? MK.factory.raw.staffing() : []).forEach(function (x) { if (x.logistics) return; var k = Math.max(0, dep.names.indexOf(x.dept)); shares[k] += x.count * x.gross; total += x.count * x.gross; });
    } else {
      cfg.headOffice.staffing.forEach(function (x) { var k = dep.financeRoles.indexOf(x.role) !== -1 ? 0 : 1; shares[k] += x.count * x.gross; total += x.count * x.gross; });
    }
    return shares.map(function (x) { return ratio(x, total); });
  }

  /**
   * costCentreSpend(period) - MK.config.costCentres with spend from the ledger (EBITDA-level costs plus depreciation).
   * A unit's spend includes what it is charged by the factory (transfers, logistics); the company node reports those
   * inter-unit charges separately so that spendAfterElimination is cash cost only.
   */
  finance.costCentreSpend = function (period) {
    var st = state(), months = resolveMonths(period), cfgTree = MK.config ? MK.config.costCentres : null;
    /* every node carries spend and estimatedPart (the aggregator charges of the unsettled tail inside spend, at assumed contract rates) */
    var emptyTree = { id: cfgTree ? cfgTree.id : null, label: cfgTree ? cfgTree.label : '', unitId: null, spend: 0, estimatedPart: 0, children: [], interUnitCharges: 0, spendAfterElimination: 0 };
    var out = { period: periodOf(months), tree: emptyTree, interUnitCharges: 0, estimatedPart: 0,
      sources: { costs: 'erp', aggregatorActual: ['swiggy_annexure', 'zomato_settlement'], aggregatorEstimated: 'estimate' } };
    if (!st || !months.length) return out;
    var allowed = MK.session.allowedUnitIds(), monthKeys = months.map(function (i) { return st.cfg.months[i]; }), inter = 0, unitById = byId(st.cfg.outlets);
    function unitSpend(unitId) {
      var unit = unitById[unitId], type = unit.type, names = MODEL.departments[type].names, payroll = payrollSharesOf(unitId, type), total = 0, est = 0;
      var dept = names.map(function () { return 0; }), deptEst = names.map(function () { return 0; });
      monthKeys.forEach(function (mk) { (st.byUnitMonth[unitId + '|' + mk] || []).forEach(function (l) {
        total += l.amount; est += l.estimatedPart; if (l.interUnit) inter += l.amount;
        departmentShares(type, l, payroll).forEach(function (x, k) { dept[k] += l.amount * x; deptEst[k] += l.estimatedPart * x; });
      }); });
      return { total: total, estimated: est, dept: dept.map(Math.round), deptEst: deptEst.map(Math.round) };
    }
    function walk(node) {
      if (node.unitId && allowed.indexOf(node.unitId) === -1) return null;
      var res = { id: node.id, label: node.label, unitId: node.unitId, spend: 0, estimatedPart: 0, children: [] };
      if (node.unitId && node.children.length && node.children[0].unitId === node.unitId) {
        var u = unitSpend(node.unitId), given = 0, givenEst = 0, biggestEst = 0;
        res.spend = u.total; res.estimatedPart = u.estimated;
        node.children.forEach(function (ch, k) {
          res.children.push({ id: ch.id, label: ch.label, unitId: ch.unitId, spend: u.dept[k] || 0, estimatedPart: u.deptEst[k] || 0, children: [] });
          given += u.dept[k] || 0; givenEst += u.deptEst[k] || 0; if ((u.deptEst[k] || 0) > (u.deptEst[biggestEst] || 0)) biggestEst = k;
        });
        if (res.children.length) { res.children[0].spend += res.spend - given; res.children[biggestEst].estimatedPart += res.estimatedPart - givenEst; }   /* rounding, so departments add up to the unit */
        return res;
      }
      node.children.forEach(function (ch) { var c = walk(ch); if (c) { res.children.push(c); res.spend += c.spend; res.estimatedPart += c.estimatedPart; } });
      return res.children.length || node.unitId ? res : null;
    }
    var tree = walk(st.cfg.costCentres);
    if (tree) { tree.interUnitCharges = inter; tree.spendAfterElimination = tree.spend - inter; out.tree = tree; out.estimatedPart = tree.estimatedPart; }
    out.interUnitCharges = inter;
    return out;
  };

  /* ------------------------------------------------------- raw, unscoped access */
  /* For MK.seed (bills are generated from the billable lines) and tools/check-data.js. Pages must use the scoped selectors. */

  finance.raw = {
    model: MODEL,
    monthInfo: monthInfo,
    state: state,
    checksum: function () { var st = state(); return st ? st.checksum : 0; },
    /** Every ledger line, unscoped. filter as in MK.finance.ledger. */
    ledger: function (filter) { var st = state(); if (!st) return []; var f = filter || {}, want = f.unitIds || (f.unitId && f.unitId !== 'all' ? [f.unitId] : st.unitIds); if (f.unitId === 'outlets') want = st.db.outletIds; return filterLines(f, want.map(function (id) { return st.unitIdx[id]; }).filter(function (i) { return i !== undefined; })); },
    /** Unscoped P&L (same shape as MK.finance.pnl without prev). */
    pnl: function (unitSel, period) {
      var st = state(); if (!st) return null;
      var want = unitSel === 'all' || !unitSel ? st.unitIds : unitSel === 'outlets' ? st.db.outletIds : (Array.isArray(unitSel) ? unitSel : [unitSel]);
      return computePnl(want.map(function (id) { return st.unitIdx[id]; }).filter(function (i) { return i !== undefined; }), resolveMonths(period));
    },
    roster: function (outletId) { var st = state(); return st ? st.rosterOf(outletId).slice() : []; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.MK;
})(typeof window !== 'undefined' ? window : globalThis);
