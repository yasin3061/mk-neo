/*
 * MK.factory - the central kitchen: indents, production, yield, dispatch, inventory, purchases, costing.
 * (docs/SPEC.md 6.4, docs/RESEARCH.md section 7, docs/API-finance.md)
 *
 * One physical model, run day by day from the outlets' dish sales in MK.db:
 *   recipe (BOM) x portions sold -> kg of each factory SKU an outlet needs (plus its over-use)
 *   -> outlet indents (Koregaon Park on alternate days) -> dispatch (fill rate) at transfer price
 *   -> production plan vs actual, wastage, FEFO expiry -> raw-material consumption through yield
 *   -> raw-material purchases at the monthly price series -> stock as of MK.calendar.today.
 * The factory cost-centre P&L sits on top: transfer value - raw materials consumed - conversion costs
 * = over / under absorption (standard-cost transfer pricing: standard RM cost + Rs 70 per kg).
 *
 * MK.factory.raw is UNSCOPED and only for the finance, seed and check layers. The public selectors
 * answer with empty results when the persona has no 'factory' unit in scope. They never throw.
 * Deterministic: MK.rng only, no clock. Quantities are kept in whole hectograms (0.1 kg) so stock
 * reconciles exactly; money is whole rupees at the point a value becomes a fact.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});
  var factory = MK.factory = MK.factory || {};
  factory.ready = false;

  /* ===================================================================== model parameters
   * Parameters of the factory model that MK.config does not carry. Anything marked CALIBRATED replaces
   * a "before tuning" figure of config.factoryParams (RESEARCH.md section 7 sized the kitchen for about
   * 14,500 kg a month; the simulated network draws about 9,900 kg, so the cost base is the smaller
   * kitchen that absorbs at Rs 70 per kg). These belong in config.js once the config owner adopts them.
   */
  var MODEL = {
    seed: 'mk-factory-v1',

    /* Outlet over-use of ingredients = config.outletCosts[o].foodCostVariancePts / this reference
     * (network theoretical food cost, RESEARCH.md section 5). Kalyan: 3.6 pts -> about 10.7% over recipe. */
    foodCostPctReference: 0.335,
    overUseDayNoise: 0.35,              /* day-to-day spread of the over-use rate, +/- share */

    /* Outlets in these regions are supplied on odd calendar dates only; a run carries the need up to the
     * next run (two days, or one when the 31st is followed by the 1st), so a month's runs cover that month. */
    alternateDayRegions: ['Pune'],

    /* Short shipment of an indent line: chance, and depth as a share of the line. */
    fill: {
      mumbai: { shortChance: 0.12, depth: [0.05, 0.28] },
      alternate: { shortChance: 0.60, depth: [0.03, 0.18] }
    },
    shortReasons: { mumbai: ['Production short of plan', 'QA hold on batch', 'Picking error'],
      alternate: ['Production short of plan', 'QA hold on batch', 'Van capacity on the Pune run', 'Cut-off missed for the Pune run'] },

    production: {
      bufferShare: 0.35,                /* finished stock kept on top of the next dispatch, as a share of the following day */
      forecastSd: 0.06, forecastClip: 0.15,
      adherence: [0.955, 1.0],          /* actual / plan on a normal day */
      badDayChance: 0.05, badDayAdherence: [0.85, 0.95],
      batchEveryDays: { FP05: 2, FP07: 2, FP08: 3 }   /* long-life items are cooked in batches */
    },
    qaWriteOff: { chance: 0.011, share: [0.2, 0.6] },  /* cold-chain / QA rejection of finished stock */
    yieldNoiseSd: 0.006,
    yieldExceptionRampDays: 6,          /* a seeded yield exception sets in, and is corrected, over this many days */

    /* Raw-material stock policy by storage class (days of average use). */
    rmPolicy: {
      fresh: { closingCoverDays: 1.5, lot: 1 },
      frozen: { reorderDays: 6, orderUpToDays: 9.5, lot: 1 },
      dry: { reorderDays: 15, orderUpToDays: 30, lot: 5 }
    },
    rmVendorByCategory: { poultry: 'v_poultry', mutton: 'v_mutton', dairy: 'v_dairy', vegetables: 'v_veg', dry_goods: 'v_dry', oil: 'v_oil' },

    /*
     * Standard conversion of Rs 70 per kg, split for line-level absorption analysis. Standards were set with the budgets, in
     * March: utilities at the January LPG price (MK.config.tariffs.lpgBudgetReference) come to about Rs 15 per kg at the planned
     * volume, so the LPG spike from May shows as an unfavourable utilities variance; overhead carries the rest.
     */
    stdConversionSplit: { labour: 30, utilities: 15, overhead: 25 },
    /* Fuel and tolls: half follows the delivery days of the month, half the kg carried; the Pune run is paid per run. Both are
     * priced so that the average complete month costs the monthly figure of MK.config.factoryParams. */
    logistics: { fuelShareByKg: 0.5 },
    /* Relative conversion effort per kg by SKU (1 = average): cooked and minced lines cost more to make. */
    conversionWeights: {
      FP01: { labour: 1.0, utilities: 0.8 }, FP02: { labour: 1.0, utilities: 0.8 }, FP03: { labour: 1.3, utilities: 1.0 },
      FP04: { labour: 1.3, utilities: 1.0 }, FP05: { labour: 1.2, utilities: 2.6 }, FP06: { labour: 0.9, utilities: 0.8 },
      FP07: { labour: 1.1, utilities: 1.8 }, FP08: { labour: 0.8, utilities: 0.6 }, FP09: { labour: 0.9, utilities: 0.6 }
    },

    /* CALIBRATED cost base (config.factoryParams holds the pre-tuning figures in brackets). */
    costBase: {
      rent: 100000,                     /* [225000] 2,500 sq ft industrial gala at Rs 40 per sq ft */
      staffing: [                       /* [15 staff, Rs 4.2 L] the roster of a 330 kg-a-day kitchen */
        { role: 'Production head', count: 1, gross: 70000, dept: 'Production' },
        { role: 'Chef de partie', count: 1, gross: 35000, dept: 'Production' },
        { role: 'Commis', count: 3, gross: 18500, dept: 'Production' },
        { role: 'Helper', count: 3, gross: 15500, dept: 'Production' },
        { role: 'Storekeeper and purchase', count: 1, gross: 27000, dept: 'Stores' }
      ],                                /* no drivers on the payroll: the refrigerated vans are hired with their drivers */
      electricityKwh: 5600,             /* [9500] */
      electricityDemandCharge: 38000,   /* [110000] */
      lpgCylinders: 22,                 /* [35] */
      waterAndWaste: 12000,             /* [15000] */
      admin: 15000,                     /* [20000] */
      labShare: 0.5, pestShare: 0.3,    /* split of lab / pest / licence; the rest is statutory fees (not billable) */
      waterBillShare: 0.4, adminInternet: 1500
    }
  };

  var S = null;   /* built state (unscoped) */

  /* ------------------------------------------------------------------ helpers */

  function r1(hg) { return hg / 10; }                       /* hectograms -> kg */
  function ratio(a, b) { return b > 0 ? a / b : 0; }
  function isIso(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function inScope() { return MK.session.allowedUnitIds().indexOf('factory') !== -1; }
  function seesAllOutlets() { return S && MK.session.allowedOutletIds().length === S.NO; }

  /** Calendar facts of a data month; September is month to date (fixed costs accrue pro rata). */
  function monthInfo(monthKey) {
    if (typeof monthKey !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
      return { monthKey: null, label: '', from: null, to: null, daysInMonth: 0, elapsedDays: 0, partial: false, prorata: 0, periodLabel: '' };
    }
    var D = MK.dates, cal = MK.calendar, from = monthKey + '-01';
    var dim = D.daysInMonth(monthKey), end = D.monthEnd(from), to = end > cal.dataEnd ? cal.dataEnd : end;
    var elapsed = from > cal.dataEnd || to < cal.dataStart ? 0 : D.diffDays(D.max(from, cal.dataStart), to) + 1;
    var partial = elapsed < dim;
    return { monthKey: monthKey, label: D.monthLabel(monthKey, true), from: from, to: to, daysInMonth: dim, elapsedDays: elapsed,
      partial: partial, prorata: elapsed / dim,
      periodLabel: partial ? D.label(from) + ' - ' + D.label(to) + ' (month to date, ' + elapsed + ' of ' + dim + ' days)' : D.monthLabel(monthKey, true) };
  }

  /* -------------------------------------------------------------------- build */

  function build() {
    var cfg = MK.config, db = MK.engine.run(), D = MK.dates, dm = db.dims;
    var ND = dm.ND, NO = dm.NO, NS = dm.NS, NDI = dm.NDI, NMO = dm.NMO;
    var products = cfg.items.factoryProducts, NK = products.length, rms = cfg.items.rawMaterials, NR = rms.length;
    var fp = cfg.factoryParams, P = MODEL.production;
    var skuIdx = {}, rmIdx = {};
    products.forEach(function (p, k) { skuIdx[p.id] = k; });
    rms.forEach(function (r, i) { rmIdx[r.id] = i; });
    var outlets = db.outletIds.map(function (id) { return cfg.outlets.filter(function (o) { return o.id === id; })[0]; });
    var alternate = outlets.map(function (o) { return fp.puneSupplyDays === 'alternate' && MODEL.alternateDayRegions.indexOf(o.region) !== -1; });
    var overUse = outlets.map(function (o) { return ((cfg.outletCosts[o.id] || {}).foodCostVariancePts || 0) / MODEL.foodCostPctReference; });
    var dayMonth = db.dayMonth, i, d, o, k, r, m;

    /* ---- 1. theoretical and needed kg per day x outlet x SKU ---- */
    var grams = new Float64Array(NDI * NK);
    cfg.dishes.forEach(function (dish, di) { dish.recipe.factory.forEach(function (l) { grams[di * NK + skuIdx[l.sku]] += l.g; }); });
    var theoKg = new Float64Array(ND * NO * NK), needKg = new Float64Array(ND * NO * NK);
    var qtyOff = db.DM.qty;
    for (o = 0; o < NO; o++) {
      var needRng = MK.rng(MODEL.seed + '|over-use|' + outlets[o].id);
      for (d = 0; d < ND; d++) {
        var cell = (d * NO + o) * NK;
        for (var di = 0; di < NDI; di++) {
          var q = 0;
          for (var s = 0; s < NS; s++) q += db.dishDayCube[((((d * NO + o) * NS + s) * NDI) + di) * dm.NDM + qtyOff];
          if (!q) continue;
          for (k = 0; k < NK; k++) if (grams[di * NK + k]) theoKg[cell + k] += q * grams[di * NK + k] / 1000;
        }
        var use = 1 + overUse[o] * (1 + needRng.range(-MODEL.overUseDayNoise, MODEL.overUseDayNoise));
        for (k = 0; k < NK; k++) needKg[cell + k] = theoKg[cell + k] * use;
      }
    }

    /* ---- 2. scheduled indents from need alone (hectograms); back-orders are added day by day ---- */
    var baseHg = new Int32Array(ND * NO * NK), baseTotal = new Int32Array(ND * NK);
    var oddDate = db.days.map(function (iso) { return (+iso.slice(8, 10)) % 2 === 1; });
    var supplyDay = function (oi, day) { return !alternate[oi] || (day < ND ? oddDate[day] : (+D.addDays(db.days[ND - 1], day - ND + 1).slice(8, 10)) % 2 === 1); };
    for (d = 0; d < ND; d++) for (o = 0; o < NO; o++) {
      if (!supplyDay(o, d)) continue;
      for (k = 0; k < NK; k++) {
        var need = needKg[(d * NO + o) * NK + k];
        if (alternate[o] && d + 1 < ND && !oddDate[d + 1]) need += needKg[((d + 1) * NO + o) * NK + k];
        var hg = Math.round(need * 10);
        baseHg[(d * NO + o) * NK + k] = hg; baseTotal[d * NK + k] += hg;
      }
    }
    /* beyond the data the planner uses the same day two weeks earlier (same weekday, same Pune-run parity) */
    function scheduled(day, sku) { while (day >= ND) day -= 14; return baseTotal[day * NK + sku]; }

    /* ---- 3. storage ---- */
    var indentHg = new Int32Array(ND * NO * NK), dispatchHg = new Int32Array(ND * NO * NK), dispatchValue = new Int32Array(ND * NO * NK);
    var planHg = new Int32Array(ND * NK), actualHg = new Int32Array(ND * NK), wasteHg = new Int32Array(ND * NK), goodHg = new Int32Array(ND * NK);
    var expiredHg = new Int32Array(ND * NK), qaHg = new Int32Array(ND * NK), closingHg = new Int32Array(ND * NK), openingHg = new Int32Array(NK);
    var yieldAct = new Float32Array(ND * NK);
    var rmUse = new Float64Array(ND * NR), rmUseStd = new Float64Array(ND * NR);
    var rmUseBySku = new Float64Array(NMO * NK * NR);
    var shorts = [];   /* { d, o, k, indentHg, dispatchHg, reason } */

    var shelfDays = products.map(function (p) { return Math.max(1, Math.round(p.shelfLifeHours / 24)); });
    var every = products.map(function (p) { return P.batchEveryDays[p.id] || 1; });
    var maxAge = 0; shelfDays.forEach(function (x) { if (x > maxAge) maxAge = x; });
    var lots = new Int32Array(NK * (maxAge + 1));           /* lots[k][age]; age 0 = produced today */
    var backHg = new Int32Array(NO * NK);
    var capacityHg = fp.capacityKgPerDay * 10;
    var wasteBand = fp.wastageTargetPct;

    var fillRng = outlets.map(function (x) { return MK.rng(MODEL.seed + '|fill|' + x.id); });
    var prodRng = MK.rng(MODEL.seed + '|production'), qaRng = MK.rng(MODEL.seed + '|qa'), yieldRng = MK.rng(MODEL.seed + '|yield');
    var forecastRng = MK.rng(MODEL.seed + '|forecast'), reasonRng = MK.rng(MODEL.seed + '|short-reason');

    /* mean yield of a SKU on a day: standard, except inside (and just after) a seeded exception month */
    var yieldPlan = products.map(function (p) {
      var arr = new Float64Array(ND).fill(p.stdYield);
      (fp.yieldExceptions || []).forEach(function (ex) {
        if (ex.sku !== p.id) return;
        var first = db.dayIdx(ex.month + '-01'); if (first < 0) return;
        var n = D.daysInMonth(ex.month), ramp = MODEL.yieldExceptionRampDays;
        var trough = (n * ex.yield - ramp * p.stdYield / 2) / (n - ramp / 2);   /* month average lands on ex.yield */
        for (var j = 0; j < n + ramp && first + j < ND; j++) {
          var t = j < ramp ? j / ramp : (j < n ? 1 : 1 - (j - n + 1) / ramp);
          arr[first + j] = p.stdYield + (trough - p.stdYield) * Math.max(0, t);
        }
      });
      return arr;
    });
    function noisy(rng, sd, clip) { return 1 + Math.max(-clip, Math.min(clip, rng.normal(0, sd))); }
    function stockOf(sku) { var t = 0; for (var a = 0; a <= maxAge; a++) t += lots[sku * (maxAge + 1) + a]; return t; }

    /* opening finished stock: what the last day before the data would have left for 1 April */
    for (k = 0; k < NK; k++) {
      var open = scheduled(0, k);
      for (var j0 = 1; j0 < every[k]; j0++) open += scheduled(j0, k);
      open = Math.round(open + P.bufferShare * scheduled(every[k], k));
      lots[k * (maxAge + 1) + 0] = open; openingHg[k] = open;
    }

    /* ---- 4. the day loop: dispatch -> write-offs -> production ---- */
    var desired = new Int32Array(NO);
    for (d = 0; d < ND; d++) {
      /* morning: yesterday's production is one day old */
      for (k = 0; k < NK; k++) { var b0 = k * (maxAge + 1); for (var a1 = maxAge; a1 > 0; a1--) lots[b0 + a1] = lots[b0 + a1 - 1]; lots[b0] = 0; }

      for (k = 0; k < NK; k++) {
        var price = products[k].transferPrice, want = 0, base = k * (maxAge + 1);
        for (o = 0; o < NO; o++) {
          desired[o] = 0;
          if (!supplyDay(o, d)) continue;
          var ind = baseHg[(d * NO + o) * NK + k] + backHg[o * NK + k];
          indentHg[(d * NO + o) * NK + k] = ind;
          if (ind <= 0) continue;
          var fm = alternate[o] ? MODEL.fill.alternate : MODEL.fill.mumbai;
          var shortShare = fillRng[o].next() < fm.shortChance ? fillRng[o].range(fm.depth[0], fm.depth[1]) : 0;
          desired[o] = Math.round(ind * (1 - shortShare));
          want += desired[o];
        }
        var avail = stockOf(k), stockShort = want > avail;
        if (stockShort) for (o = 0; o < NO; o++) desired[o] = Math.floor(desired[o] * avail / want);
        for (o = 0; o < NO; o++) {
          var ix = (d * NO + o) * NK + k, ind2 = indentHg[ix];
          if (ind2 <= 0) continue;
          var out = desired[o];
          dispatchHg[ix] = out;
          dispatchValue[ix] = Math.round(out * price / 10);
          backHg[o * NK + k] = ind2 - out;
          if (out < ind2) {
            var reasons = alternate[o] ? MODEL.shortReasons.alternate : MODEL.shortReasons.mumbai;
            shorts.push({ d: d, o: o, k: k, indentHg: ind2, dispatchHg: out, reason: stockShort ? 'Finished stock short' : reasonRng.pick(reasons) });
          }
          for (var a2 = maxAge; a2 >= 0 && out > 0; a2--) { var take = Math.min(out, lots[base + a2]); lots[base + a2] -= take; out -= take; }   /* FEFO */
        }
        /* lots that would be past shelf life tomorrow morning are written off */
        for (var a3 = shelfDays[k]; a3 <= maxAge; a3++) { expiredHg[d * NK + k] += lots[base + a3]; lots[base + a3] = 0; }
        if (qaRng.next() < MODEL.qaWriteOff.chance) {
          var share = qaRng.range(MODEL.qaWriteOff.share[0], MODEL.qaWriteOff.share[1]);
          for (var a4 = 0; a4 <= maxAge; a4++) { var cut = Math.round(lots[base + a4] * share); lots[base + a4] -= cut; qaHg[d * NK + k] += cut; }
        }
      }

      /* production plan: cover the coming dispatches plus a buffer, within capacity */
      var meanWaste = (wasteBand[0] + wasteBand[1]) / 2, planTotal = 0;
      for (k = 0; k < NK; k++) {
        var stock = stockOf(k), next = 0;
        if (d + 1 < ND) { for (o = 0; o < NO; o++) if (supplyDay(o, d + 1)) next += baseHg[((d + 1) * NO + o) * NK + k] + backHg[o * NK + k]; } else next = scheduled(d + 1, k);
        var target = next * noisy(forecastRng, P.forecastSd, P.forecastClip), plan = 0;
        if (every[k] === 1 || d % every[k] === 0) {
          for (var j1 = 2; j1 <= every[k]; j1++) target += scheduled(d + j1, k) * noisy(forecastRng, P.forecastSd, P.forecastClip);
          target += P.bufferShare * scheduled(d + every[k] + 1, k);
          plan = Math.max(0, Math.round((target - stock) / (1 - meanWaste)));
        } else if (stock < target * 1.05) {
          plan = Math.round((target * 1.10 - stock) / (1 - meanWaste));   /* top-up between batch days */
        }
        planHg[d * NK + k] = plan; planTotal += plan;
      }
      if (planTotal > capacityHg) for (k = 0; k < NK; k++) planHg[d * NK + k] = Math.floor(planHg[d * NK + k] * capacityHg / planTotal);
      var adherence = prodRng.next() < P.badDayChance ? prodRng.range(P.badDayAdherence[0], P.badDayAdherence[1]) : prodRng.range(P.adherence[0], P.adherence[1]);
      m = dayMonth[d];
      for (k = 0; k < NK; k++) {
        var act = Math.round(planHg[d * NK + k] * adherence), waste = Math.round(act * prodRng.range(wasteBand[0], wasteBand[1]));
        actualHg[d * NK + k] = act; wasteHg[d * NK + k] = waste; goodHg[d * NK + k] = act - waste;
        lots[k * (maxAge + 1)] = act - waste;
        closingHg[d * NK + k] = stockOf(k);
        var y = yieldPlan[k][d] * noisy(yieldRng, MODEL.yieldNoiseSd, 0.03);
        yieldAct[d * NK + k] = y;
        if (!act) continue;
        /* raw materials: BOM is per kg of output at standard yield; a yield miss scales the primary input
         * (or every input when the yield is on total input: cooked-down and emulsified products) */
        var p = products[k], adj = p.stdYield / y, kg = act / 10;
        for (var li = 0; li < p.bom.length; li++) {
          var ri = rmIdx[p.bom[li][0]], std = kg * p.bom[li][1], used = std * ((li === 0 || p.yieldBasis === 'total_input') ? adj : 1);
          rmUse[d * NR + ri] += used; rmUseStd[d * NR + ri] += std; rmUseBySku[(m * NK + k) * NR + ri] += used;
        }
      }
    }
    var finalLots = lots.slice();

    /* ---- 5. raw-material stock and purchases ---- */
    var rmBuyQty = new Float64Array(ND * NR), rmBuyValue = new Int32Array(ND * NR), rmStockEnd = new Float64Array(ND * NR);
    /* average daily use of a raw material over the 14 days to `day` (the first fortnight at the start) */
    function trail(rm, day) {
      var from = Math.max(0, day - 13), to = Math.min(Math.max(day, 13), ND - 1), t = 0;
      for (var x = from; x <= to; x++) t += rmUse[x * NR + rm];
      return t / (to - from + 1);
    }
    var rmOpening = new Float64Array(NR), rmAvgUse = new Float64Array(NR), rmLastBuy = new Int32Array(NR).fill(-1), rmDeliveries = new Int32Array(NMO * NR);
    for (r = 0; r < NR; r++) {
      var pol = MODEL.rmPolicy[rms[r].storage] || MODEL.rmPolicy.dry, rmRng = MK.rng(MODEL.seed + '|rm|' + rms[r].id);
      var stockQ = pol.closingCoverDays ? pol.closingCoverDays * trail(r, 0) : (pol.reorderDays + rmRng.next() * (pol.orderUpToDays - pol.reorderDays)) * trail(r, 0);
      stockQ = Math.ceil(stockQ); rmOpening[r] = stockQ;
      for (d = 0; d < ND; d++) {
        var avg = trail(r, d), useToday = rmUse[d * NR + r], buy = 0;
        if (pol.closingCoverDays) buy = useToday + pol.closingCoverDays * avg - stockQ;
        else if (stockQ - useToday < pol.reorderDays * avg) buy = pol.orderUpToDays * avg - (stockQ - useToday);
        if (buy > 0) {
          buy = Math.ceil(buy / pol.lot) * pol.lot;
          rmBuyQty[d * NR + r] = buy; rmBuyValue[d * NR + r] = Math.round(buy * rms[r].prices[dayMonth[d]]);
          rmLastBuy[r] = d; rmDeliveries[dayMonth[d] * NR + r] += 1;
          stockQ += buy;
        }
        stockQ -= useToday;
        rmStockEnd[d * NR + r] = stockQ;
      }
      rmAvgUse[r] = trail(r, ND - 1);
    }

    /* ---- 6. monthly facts ---- */
    var mo = [];
    for (m = 0; m < NMO; m++) {
      mo.push({ monthKey: db.monthKeys[m], days: 0, puneRuns: 0,
        dispatchKgHg: new Float64Array(NO * NK), indentHg: new Float64Array(NO * NK), dispatchValue: new Float64Array(NO * NK),
        valueByOutlet: new Float64Array(NO), kgHgByOutlet: new Float64Array(NO), theoKgByOutlet: new Float64Array(NO),
        plan: new Float64Array(NK), actual: new Float64Array(NK), good: new Float64Array(NK), waste: new Float64Array(NK), expired: new Float64Array(NK), qa: new Float64Array(NK),
        yieldWeighted: new Float64Array(NK), rmQty: new Float64Array(NR), rmStdQty: new Float64Array(NR), rmValueBySku: new Float64Array(NK), rmValueByRm: new Float64Array(NR),
        rmStdPriceValue: 0, rmConsumed: 0, buyQty: new Float64Array(NR), buyValue: new Float64Array(NR), ppv: new Float64Array(NR), transferValue: 0, dispatchHgTotal: 0, stockBuildHg: new Float64Array(NK) });
    }
    for (d = 0; d < ND; d++) {
      var M = mo[dayMonth[d]]; M.days += 1; if (oddDate[d] && alternate.some(Boolean)) M.puneRuns += 1;
      for (o = 0; o < NO; o++) for (k = 0; k < NK; k++) {
        var c2 = (d * NO + o) * NK + k;
        M.dispatchKgHg[o * NK + k] += dispatchHg[c2]; M.indentHg[o * NK + k] += indentHg[c2]; M.dispatchValue[o * NK + k] += dispatchValue[c2];
        M.valueByOutlet[o] += dispatchValue[c2]; M.kgHgByOutlet[o] += dispatchHg[c2]; M.theoKgByOutlet[o] += theoKg[c2];
        M.transferValue += dispatchValue[c2]; M.dispatchHgTotal += dispatchHg[c2]; M.stockBuildHg[k] -= dispatchHg[c2];
      }
      for (k = 0; k < NK; k++) {
        var c3 = d * NK + k;
        M.plan[k] += planHg[c3]; M.actual[k] += actualHg[c3]; M.good[k] += goodHg[c3]; M.waste[k] += wasteHg[c3];
        M.expired[k] += expiredHg[c3]; M.qa[k] += qaHg[c3]; M.yieldWeighted[k] += yieldAct[c3] * actualHg[c3];
        M.stockBuildHg[k] += goodHg[c3] - expiredHg[c3] - qaHg[c3];
      }
      for (r = 0; r < NR; r++) {
        M.rmQty[r] += rmUse[d * NR + r]; M.rmStdQty[r] += rmUseStd[d * NR + r];
        M.buyQty[r] += rmBuyQty[d * NR + r]; M.buyValue[r] += rmBuyValue[d * NR + r];
      }
    }
    /* raw materials consumed: a stored fact per SKU x raw material x month at the month's price */
    mo.forEach(function (M2, mi) {
      for (k = 0; k < NK; k++) for (r = 0; r < NR; r++) {
        var v = Math.round(rmUseBySku[(mi * NK + k) * NR + r] * rms[r].prices[mi]);
        M2.rmValueBySku[k] += v; M2.rmValueByRm[r] += v; M2.rmConsumed += v;
      }
      for (r = 0; r < NR; r++) {
        M2.rmStdPriceValue += M2.rmQty[r] * rms[r].stdPrice;
        M2.ppv[r] = Math.round(M2.buyQty[r] * (rms[r].prices[mi] - rms[r].stdPrice));
      }
    });

    S = {
      db: db, ND: ND, NO: NO, NK: NK, NR: NR, NMO: NMO, products: products, rms: rms, outlets: outlets, skuIdx: skuIdx, rmIdx: rmIdx,
      alternate: alternate, oddDate: oddDate, overUse: overUse, shelfDays: shelfDays, maxAge: maxAge, capacityHg: capacityHg,
      theoKg: theoKg, indentHg: indentHg, dispatchHg: dispatchHg, dispatchValue: dispatchValue,
      planHg: planHg, actualHg: actualHg, wasteHg: wasteHg, goodHg: goodHg, expiredHg: expiredHg, qaHg: qaHg, closingHg: closingHg, openingHg: openingHg,
      yieldAct: yieldAct, rmUse: rmUse, rmBuyQty: rmBuyQty, rmBuyValue: rmBuyValue, rmStockEnd: rmStockEnd, rmOpening: rmOpening,
      rmAvgUse: rmAvgUse, rmLastBuy: rmLastBuy, rmDeliveries: rmDeliveries, rmUseBySku: rmUseBySku,
      finalLots: finalLots, shorts: shorts, months: mo, costCache: {}
    };
    var h = 2166136261 >>> 0;
    function mix(v) { h ^= v; h = Math.imul(h, 16777619) >>> 0; }
    for (i = 0; i < dispatchValue.length; i++) mix(dispatchValue[i]);
    for (i = 0; i < actualHg.length; i++) mix(actualHg[i]);
    for (i = 0; i < rmBuyValue.length; i++) mix(rmBuyValue[i]);
    S.checksum = h >>> 0;
    factory.ready = true;
    return S;
  }

  function state() {
    if (S && S.db !== MK.db) { S = null; factory.ready = false; }   /* the sales engine was rebuilt */
    if (S) return S;
    try { if (MK.config && MK.engine && typeof MK.engine.run === 'function') build(); } catch (e) { S = null; if (root.console) root.console.error('[MK.factory] build failed', e); }
    return S;
  }

  /** Builds the factory model once ({ force: true } rebuilds). Safe to call from MK.engine.run or app boot. */
  factory.build = function (opts) { if (opts && opts.force) { S = null; factory.ready = false; } return !!state(); };

  /* -------------------------------------------------- cost lines of the factory unit */
  /*
   * Monthly cost lines of the factory cost centre, before they become ledger lines in MK.finance.
   * bucket: 'rm' | 'labour' | 'utilities' | 'overhead' | 'logistics' | 'below_ebitda'.
   * Fixed monthly costs accrue pro rata in the month to date (fullMonthAmount keeps the monthly figure).
   */
  function costLines(mi) {
    var st = state(); if (!st || mi < 0 || mi >= st.NMO) return [];
    if (st.costCache[mi]) return st.costCache[mi];
    var cfg = MK.config, fp = cfg.factoryParams, cb = MODEL.costBase, M = st.months[mi], info = monthInfo(M.monthKey), lines = [];
    function fixed(categoryId, bucket, monthly, vendorId, basis, note) {
      var amt = Math.round(monthly * info.prorata);
      if (amt) lines.push({ categoryId: categoryId, bucket: bucket, amount: amt, vendorId: vendorId || null, basis: basis, note: note || '', accrual: info.partial ? 'prorata' : 'actual', fullMonthAmount: Math.round(monthly) });
    }
    function actual(categoryId, bucket, amount, vendorId, basis, note) {
      var amt = Math.round(amount);
      if (amt) lines.push({ categoryId: categoryId, bucket: bucket, amount: amt, vendorId: vendorId || null, basis: basis, note: note || '', accrual: 'actual', fullMonthAmount: null });
    }
    /* raw materials: purchases by vendor (billable) plus the stock change, so that the lines sum to consumption */
    var byVendor = {}, bought = 0;
    st.rms.forEach(function (rm, r) {
      var v = MODEL.rmVendorByCategory[rm.vendorCategory] || null;
      byVendor[v] = (byVendor[v] || 0) + M.buyValue[r]; bought += M.buyValue[r];
    });
    Object.keys(byVendor).forEach(function (v) { actual('raw_materials', 'rm', byVendor[v], v === 'null' ? null : v, 'Purchases at the price of the month', 'Raw-material purchases'); });
    actual('raw_materials', 'rm', M.rmConsumed - bought, null, 'Stock count', 'Raw-material stock change (consumed less purchased)');
    actual('production_consumables', 'overhead', fp.productionConsumablesPctOfTransferValue * M.transferValue, 'v_hk', (fp.productionConsumablesPctOfTransferValue * 100).toFixed(1) + '% of transfer value', 'Gloves, vacuum bags, labels, sanitiser');

    var gross = 0, grossLogistics = 0;
    cb.staffing.forEach(function (x) { if (x.logistics) grossLogistics += x.count * x.gross; else gross += x.count * x.gross; });
    fixed('salaries', 'labour', gross, null, 'Roster x wage table', 'Production and stores staff');
    fixed('employer_oncosts', 'labour', gross * fp.employerOnCostPct, null, (fp.employerOnCostPct * 100) + '% of gross', 'PF, ESIC, bonus accrual');
    fixed('salaries', 'logistics', grossLogistics, null, 'Roster x wage table', 'Drivers (part of the logistics pool)');
    fixed('employer_oncosts', 'logistics', grossLogistics * fp.employerOnCostPct, null, (fp.employerOnCostPct * 100) + '% of gross', 'Drivers (part of the logistics pool)');
    fixed('rent', 'overhead', cb.rent, 'v_ll_factory', 'Lease', '');
    fixed('rent_gst', 'overhead', cb.rent * fp.rentGstPct, 'v_ll_factory', '18% GST on rent, no input credit', '');
    var kwh = cb.electricityKwh * cfg.tariffs.electricitySeason[mi], tariff = cfg.tariffs.electricityPerKwh.mumbai_licensee;
    fixed('electricity', 'utilities', kwh * tariff + cb.electricityDemandCharge, 'u_elec_mum', Math.round(kwh) + ' kWh x Rs ' + tariff + ' + demand charge', '');
    fixed('gas_lpg', 'utilities', cb.lpgCylinders * cfg.tariffs.lpgCylinder19kg[mi], 'v_lpg_mum', cb.lpgCylinders + ' cylinders x Rs ' + cfg.tariffs.lpgCylinder19kg[mi], '');
    fixed('water', 'utilities', cb.waterAndWaste * cb.waterBillShare, 'u_water', 'Municipal water', '');
    fixed('water', 'utilities', cb.waterAndWaste * (1 - cb.waterBillShare), 'v_waste', 'Wet-waste collection contract', '');
    fixed('repairs', 'overhead', fp.repairsAmc, 'v_amc', 'Cold-room and equipment AMC', '');
    fixed('lab_pest_licence', 'overhead', fp.labPestLicence * cb.labShare, 'v_lab', 'Monthly product testing', '');
    fixed('lab_pest_licence', 'overhead', fp.labPestLicence * cb.pestShare, 'v_pest', 'Pest-control contract', '');
    fixed('lab_pest_licence', 'overhead', fp.labPestLicence * (1 - cb.labShare - cb.pestShare), null, 'Statutory licence fees spread monthly', '');
    fixed('office_admin', 'overhead', cb.adminInternet, 'v_internet', 'Internet', '');
    fixed('office_admin', 'overhead', cb.admin - cb.adminInternet, null, 'Stationery, phones, sundries', '');
    fixed('vehicle_rent', 'logistics', fp.vans.count * fp.vans.rentEach, 'v_van', fp.vans.count + ' refrigerated vans', '');
    /* consumption-driven logistics: the drivers of this month against the average complete month */
    var avg = { days: 0, kgHg: 0, runs: 0, n: 0 };
    st.months.forEach(function (x) { if (monthInfo(x.monthKey).partial) return; avg.days += x.days; avg.kgHg += x.dispatchHgTotal; avg.runs += x.puneRuns; avg.n += 1; });
    var byKg = MODEL.logistics.fuelShareByKg, fuelMonthly = fp.vans.count * fp.vans.fuelAndTollsEach;
    actual('vehicle_fuel', 'logistics', fuelMonthly * (byKg * ratio(M.dispatchHgTotal * avg.n, avg.kgHg) + (1 - byKg) * ratio(M.days * avg.n, avg.days)), null,
      'Fuel cards and tolls: ' + M.days + ' delivery days, ' + MK.fmt.kg(Math.round(M.dispatchHgTotal / 10)) + ' carried', '');
    actual('pune_run', 'logistics', fp.puneRunExtra * ratio(M.puneRuns * avg.n, avg.runs), 'v_van', M.puneRuns + ' alternate-day runs to Koregaon Park', '');
    fixed('depreciation', 'below_ebitda', fp.depreciation, null, 'Straight line', '');
    st.costCache[mi] = lines;
    return lines;
  }

  /** Logistics pool of a month and its allocation to the outlets: the Pune run to the alternate-day outlets, the rest by kg. */
  function logisticsAllocation(mi) {
    var st = state(), out = { pool: 0, puneRun: 0, byOutlet: {}, perKgByOutlet: {} };
    if (!st || mi < 0 || mi >= st.NMO) return out;
    var M = st.months[mi], pune = 0, rest = 0, o;
    costLines(mi).forEach(function (l) { if (l.bucket !== 'logistics') return; if (l.categoryId === 'pune_run') pune += l.amount; else rest += l.amount; });
    var kgAll = 0, kgAlt = 0;
    for (o = 0; o < st.NO; o++) { kgAll += M.kgHgByOutlet[o]; if (st.alternate[o]) kgAlt += M.kgHgByOutlet[o]; }
    var amounts = [], given = 0, biggest = 0;
    for (o = 0; o < st.NO; o++) {
      var a = Math.round(ratio(M.kgHgByOutlet[o], kgAll) * rest + (st.alternate[o] ? ratio(M.kgHgByOutlet[o], kgAlt) * pune : 0));
      amounts.push(a); given += a; if (M.kgHgByOutlet[o] > M.kgHgByOutlet[biggest]) biggest = o;
    }
    if (kgAll > 0) amounts[biggest] += (pune + rest) - given;   /* rounding remainder, so the recovery equals the pool to the rupee */
    for (o = 0; o < st.NO; o++) { out.byOutlet[st.outlets[o].id] = kgAll > 0 ? amounts[o] : 0; out.perKgByOutlet[st.outlets[o].id] = ratio(amounts[o], M.kgHgByOutlet[o] / 10); }
    out.pool = kgAll > 0 ? pune + rest : 0; out.puneRun = pune;
    return out;
  }

  /* ---------------------------------------------------------------- monthly P&L */

  function bucketTotals(mi) {
    var t = { rm: 0, labour: 0, utilities: 0, overhead: 0, logistics: 0, below_ebitda: 0 };
    costLines(mi).forEach(function (l) { t[l.bucket] += l.amount; });
    return t;
  }

  function pnlFor(mi) {
    var st = state(), M = st.months[mi], cfg = MK.config, b = bucketTotals(mi), log = logisticsAllocation(mi), info = monthInfo(M.monthKey), k, r;
    var conversion = b.labour + b.utilities + b.overhead, revenue = M.transferValue + log.pool;
    var totalCost = b.rm + conversion + b.logistics, absorption = revenue - totalCost;
    /* why the factory over- or under-absorbed (favourable = positive) */
    var dispatchKg = M.dispatchHgTotal / 10, losses = 0, stockBuild = 0;
    for (k = 0; k < st.NK; k++) {
      var std = st.products[k].stdRmCost;
      losses += (M.waste[k] + M.expired[k] + M.qa[k]) / 10 * std; stockBuild += M.stockBuildHg[k] / 10 * std;
    }
    var stdQtyValue = 0;
    for (r = 0; r < st.NR; r++) stdQtyValue += M.rmStdQty[r] * st.rms[r].stdPrice;
    var split = MODEL.stdConversionSplit;
    var variance = {
      rmPrice: Math.round(M.rmStdPriceValue - M.rmConsumed),                 /* prices vs standard, on what was consumed */
      rmYield: Math.round(stdQtyValue - M.rmStdPriceValue),                  /* input used vs standard input for the output made */
      wastageAndWriteOffs: -Math.round(losses),
      finishedStockBuild: -Math.round(stockBuild),                           /* production not yet dispatched (expensed, RESEARCH.md 9.5) */
      labour: Math.round(dispatchKg * split.labour - b.labour),
      utilities: Math.round(dispatchKg * split.utilities - b.utilities),      /* the standard is at the January LPG price: the spike from May lands here */
      overhead: Math.round(dispatchKg * split.overhead - b.overhead),
      logistics: log.pool - b.logistics
    };
    var explained = 0; Object.keys(variance).forEach(function (key) { explained += variance[key]; });
    variance.other = absorption - explained;                                 /* standard-cost and rupee rounding */
    var networkSales = st.db.monthlyMeasure(M.monthKey, null, null, 'netSales');
    var labels = {}; cfg.expenseCategories.forEach(function (c) { labels[c.id] = c.label; });
    var byCat = {}, order = [];
    costLines(mi).forEach(function (l) {
      var key = l.categoryId + '|' + l.bucket;
      if (!byCat[key]) { byCat[key] = { categoryId: l.categoryId, label: labels[l.categoryId] || l.categoryId, bucket: l.bucket, amount: 0, pctOfTransferValue: 0 }; order.push(key); }
      byCat[key].amount += l.amount;
    });
    var lines = order.map(function (key) { var x = byCat[key]; x.pctOfTransferValue = ratio(x.amount, M.transferValue); return x; });
    return {
      monthKey: M.monthKey, period: info, transferValue: M.transferValue, logisticsRecovery: log.pool, notionalRevenue: revenue,
      dispatchKg: dispatchKg, rmConsumed: b.rm, conversion: { labour: b.labour, utilities: b.utilities, overhead: b.overhead, total: conversion },
      conversionAbsorbed: Math.round(dispatchKg * cfg.factoryConversionPerKg), logisticsCost: b.logistics, totalCost: totalCost,
      absorption: absorption, absorptionPct: ratio(absorption, M.transferValue), status: absorption >= 0 ? 'OVER_ABSORBED' : 'UNDER_ABSORBED',
      variance: variance, lines: lines, depreciation: b.below_ebitda,
      operatingCostExRm: conversion + b.logistics,
      networkNetSales: networkSales,
      factoryCostPctOfNetworkSales: ratio(conversion + b.logistics + b.below_ebitda, networkSales),
      transferValuePctOfNetworkSales: ratio(M.transferValue, networkSales),
      source: 'erp'
    };
  }

  /* ------------------------------------------------------------ range helpers */

  function resolveRange(f) {
    var st = state(), cal = MK.calendar; f = f || {};
    var from = isIso(f.from) ? f.from : cal.dataStart, to = isIso(f.to) ? f.to : cal.dataEnd;
    if (from > to) { var t = from; from = to; to = t; }
    from = MK.dates.max(from, cal.dataStart); to = MK.dates.min(to, cal.dataEnd);
    var ok = !!st && inScope() && from <= to;
    var outletIdx = [];
    if (st) st.outlets.forEach(function (x, i) { if (!Array.isArray(f.outletIds) || !f.outletIds.length || f.outletIds.indexOf(x.id) !== -1) outletIdx.push(i); });
    return { ok: ok, from: from, to: to, d0: ok ? st.db.dayIdx(from) : 0, d1: ok ? st.db.dayIdx(to) : -1, outletIdx: outletIdx };
  }

  function physical(d0, d1) {
    var st = S, out = { days: Math.max(0, d1 - d0 + 1), planKg: 0, grossKg: 0, goodKg: 0, wasteKg: 0, writeOffKg: 0, dispatchKg: 0, indentKg: 0, transferValue: 0,
      fill: { all: [0, 0], mumbai: [0, 0], alternate: [0, 0] }, yieldIndexNum: 0 };
    for (var d = d0; d <= d1; d++) {
      for (var k = 0; k < st.NK; k++) {
        var c = d * st.NK + k;
        out.planKg += st.planHg[c]; out.grossKg += st.actualHg[c]; out.goodKg += st.goodHg[c]; out.wasteKg += st.wasteHg[c];
        out.writeOffKg += st.expiredHg[c] + st.qaHg[c];
        out.yieldIndexNum += st.actualHg[c] * st.yieldAct[c] / st.products[k].stdYield;
        for (var o = 0; o < st.NO; o++) {
          var ix = (d * st.NO + o) * st.NK + k, grp = st.alternate[o] ? out.fill.alternate : out.fill.mumbai;
          out.dispatchKg += st.dispatchHg[ix]; out.indentKg += st.indentHg[ix]; out.transferValue += st.dispatchValue[ix];
          grp[0] += st.dispatchHg[ix]; grp[1] += st.indentHg[ix];
        }
      }
    }
    out.fill.all = [out.fill.mumbai[0] + out.fill.alternate[0], out.fill.mumbai[1] + out.fill.alternate[1]];
    var res = {
      days: out.days, planKg: r1(out.planKg), grossKg: r1(out.grossKg), outputKg: r1(out.goodKg), wastageKg: r1(out.wasteKg), writeOffKg: r1(out.writeOffKg),
      dispatchKg: r1(out.dispatchKg), indentKg: r1(out.indentKg), transferValue: out.transferValue,
      kgPerDay: ratio(out.dispatchKg / 10, out.days),
      planAdherence: ratio(out.grossKg, out.planKg), wastagePct: ratio(out.wasteKg, out.grossKg), writeOffPct: ratio(out.writeOffKg, out.grossKg),
      yieldIndex: ratio(out.yieldIndexNum, out.grossKg),                       /* 1 = at standard yield, production weighted */
      fillRate: ratio(out.fill.all[0], out.fill.all[1]), fillRateMumbai: ratio(out.fill.mumbai[0], out.fill.mumbai[1]), fillRatePune: ratio(out.fill.alternate[0], out.fill.alternate[1]),
      capacityUtilisation: ratio(out.grossKg, st.capacityHg * out.days), capacityKgPerDay: st.capacityHg / 10
    };
    return res;
  }

  function emptyPhysical() {
    return { days: 0, planKg: 0, grossKg: 0, outputKg: 0, wastageKg: 0, writeOffKg: 0, dispatchKg: 0, indentKg: 0, transferValue: 0, kgPerDay: 0, planAdherence: 0,
      wastagePct: 0, writeOffPct: 0, yieldIndex: 0, fillRate: 0, fillRateMumbai: 0, fillRatePune: 0, capacityUtilisation: 0, capacityKgPerDay: 0 };
  }

  function monthsInRange(from, to) {
    return S.months.map(function (M, i) { return i; }).filter(function (i) { var info = monthInfo(S.months[i].monthKey); return info.from <= to && info.to >= from; });
  }

  /* ---------------------------------------------------------- public selectors */

  /**
   * summary(f) - headline factory KPIs for a date range (f.from, f.to), with the previous equal-length period.
   * costMonths carries the cost-side headline of every month the range touches (costs exist by month only).
   */
  factory.summary = function (f) {
    var rg = resolveRange(f), out = emptyPhysical();
    var fpar = MK.config ? MK.config.factoryParams : null;
    out.from = rg.from; out.to = rg.to; out.prev = null; out.costMonths = []; out.source = 'erp';
    /* targets are constants: present whatever the scope. prev is null when nothing precedes the range (and with an empty scope). */
    out.targets = { fillRateMumbai: fpar ? fpar.fillRateTarget.mumbai : [0, 0], fillRatePune: fpar ? fpar.fillRateTarget.koregaon : [0, 0], wastagePct: fpar ? fpar.wastageTargetPct : [0, 0],
      planAdherence: [0.95, 1], capacityUtilisation: [0.68, 0.82], writeOffPct: [0, 0.005], absorptionPct: [-0.03, 0.03] };
    if (!rg.ok) return out;
    var cur = physical(rg.d0, rg.d1), n = rg.d1 - rg.d0 + 1, p0 = Math.max(0, rg.d0 - n), p1 = rg.d0 - 1;
    Object.keys(cur).forEach(function (key) { out[key] = cur[key]; });
    if (p1 >= p0) { out.prev = physical(p0, p1); out.prev.from = S.db.days[p0]; out.prev.to = S.db.days[p1]; out.prev.complete = (p1 - p0 + 1) === n; }
    var wholeNetwork = seesAllOutlets();
    out.costMonths = monthsInRange(rg.from, rg.to).map(function (mi) {
      var p = withheld(pnlFor(mi), wholeNetwork), good = 0; for (var k = 0; k < S.NK; k++) good += S.months[mi].good[k];
      return { monthKey: p.monthKey, label: p.period.label, partial: p.period.partial, transferValue: p.transferValue, rmConsumed: p.rmConsumed, conversion: p.conversion.total,
        absorption: p.absorption, absorptionPct: p.absorptionPct, costPerKg: ratio(p.rmConsumed + p.conversion.total, good / 10),
        factoryCostPctOfNetworkSales: p.factoryCostPctOfNetworkSales };
    });
    return out;
  };

  function bucketsFor(rg, grain) {
    var D = MK.dates, days = S.db.days, list = [], last = null;
    for (var d = rg.d0; d <= rg.d1; d++) {
      var key = grain === 'month' ? D.monthKey(days[d]) : grain === 'week' ? D.weekStart(days[d]) : days[d];
      if (!last || last.key !== key) { last = { key: key, from: days[d], to: days[d], d0: d, d1: d }; list.push(last); } else { last.to = days[d]; last.d1 = d; }
    }
    list.forEach(function (b) { b.label = grain === 'month' ? D.monthLabel(b.key, true) : (b.from === b.to ? D.label(b.from) : D.label(b.from) + ' - ' + D.label(b.to)); });
    return list;
  }

  /**
   * production(f, { grain }) - plan vs actual by SKU, yield vs standard, wastage, and a time series
   * (grain 'day' | 'week' | 'month'; default day up to 45 days, else week).
   */
  factory.production = function (f, opts) {
    var asked = opts && ['day', 'week', 'month'].indexOf(opts.grain) !== -1 ? opts.grain : null;
    var rg = resolveRange(f), out = { from: rg.from, to: rg.to, grain: asked || 'day', rows: [], totals: emptyPhysical(), buckets: [], series: [], yieldFlags: [], source: 'erp' };
    if (!rg.ok) return out;
    var st = S, grain = asked || (rg.d1 - rg.d0 + 1 <= 45 ? 'day' : 'week'), buckets = bucketsFor(rg, grain);
    out.grain = grain; out.totals = physical(rg.d0, rg.d1);
    out.buckets = buckets.map(function (b) { return { key: b.key, label: b.label, from: b.from, to: b.to }; });
    st.products.forEach(function (p, k) {
      var row = { sku: p.id, name: p.name, planKg: 0, actualKg: 0, outputKg: 0, wastageKg: 0, writeOffKg: 0, dispatchKg: 0, stdYield: p.stdYield, yieldNum: 0 };
      var ser = { sku: p.id, name: p.name, plan: [], actual: [], yield: [], stdYield: p.stdYield };
      buckets.forEach(function (b) {
        var pl = 0, ac = 0, yn = 0;
        for (var d = b.d0; d <= b.d1; d++) {
          var c = d * st.NK + k;
          pl += st.planHg[c]; ac += st.actualHg[c]; yn += st.yieldAct[c] * st.actualHg[c];
          row.outputKg += st.goodHg[c]; row.wastageKg += st.wasteHg[c]; row.writeOffKg += st.expiredHg[c] + st.qaHg[c];
          for (var o = 0; o < st.NO; o++) row.dispatchKg += st.dispatchHg[(d * st.NO + o) * st.NK + k];
        }
        row.planKg += pl; row.actualKg += ac; row.yieldNum += yn;
        ser.plan.push(r1(pl)); ser.actual.push(r1(ac)); ser.yield.push(ac > 0 ? yn / ac : null);
      });
      row.actualYield = ratio(row.yieldNum, row.actualKg); delete row.yieldNum;
      row.yieldVariancePct = row.actualYield ? row.actualYield / p.stdYield - 1 : 0;
      row.adherence = ratio(row.actualKg, row.planKg); row.wastagePct = ratio(row.wastageKg, row.actualKg);
      ['planKg', 'actualKg', 'outputKg', 'wastageKg', 'writeOffKg', 'dispatchKg'].forEach(function (key) { row[key] = r1(row[key]); });
      /* extra primary raw material bought because of the yield miss, at the standard price */
      var primary = st.rms[st.rmIdx[p.bom[0][0]]];
      row.yieldVarianceValue = row.actualYield ? Math.round(row.actualKg * p.bom[0][1] * (p.stdYield / row.actualYield - 1) * primary.stdPrice) : 0;
      if (row.yieldVariancePct <= -0.02) out.yieldFlags.push({ sku: p.id, name: p.name, stdYield: p.stdYield, actualYield: row.actualYield, yieldVariancePct: row.yieldVariancePct, value: row.yieldVarianceValue });
      out.rows.push(row); out.series.push(ser);
    });
    return out;
  };

  /** dispatch(f) - SKU x outlet matrix (kg and transfer value), indent vs dispatched, fill rates, largest short shipments. f.outletIds narrows the outlets. */
  factory.dispatch = function (f) {
    var rg = resolveRange(f), out = { from: rg.from, to: rg.to, outlets: [], rows: [], totals: { indentKg: 0, dispatchKg: 0, transferValue: 0, fillRate: 0 }, byRegion: [], shortShipments: [], source: 'erp' };
    if (!rg.ok) return out;
    var st = S, oi = rg.outletIdx, reg = { mumbai: [0, 0], alternate: [0, 0] };
    out.outlets = oi.map(function (o) { return { id: st.outlets[o].id, label: st.outlets[o].name, short: st.outlets[o].short, colourVar: st.outlets[o].colourVar, alternateDaySupply: st.alternate[o], indentKg: 0, dispatchKg: 0, transferValue: 0, fillRate: 0, supplyDays: 0 }; });
    st.products.forEach(function (p, k) {
      var row = { sku: p.id, name: p.name, transferPrice: p.transferPrice, kg: [], value: [], indentKg: 0, dispatchKg: 0, transferValue: 0, fillRate: 0 };
      oi.forEach(function (o, pos) {
        var kg = 0, ind = 0, val = 0;
        for (var d = rg.d0; d <= rg.d1; d++) { var ix = (d * st.NO + o) * st.NK + k; kg += st.dispatchHg[ix]; ind += st.indentHg[ix]; val += st.dispatchValue[ix]; }
        row.kg.push(r1(kg)); row.value.push(val); row.indentKg += ind; row.dispatchKg += kg; row.transferValue += val;
        var ot = out.outlets[pos]; ot.indentKg += ind; ot.dispatchKg += kg; ot.transferValue += val;
        var g = st.alternate[o] ? reg.alternate : reg.mumbai; g[0] += kg; g[1] += ind;
      });
      row.fillRate = ratio(row.dispatchKg, row.indentKg); row.indentKg = r1(row.indentKg); row.dispatchKg = r1(row.dispatchKg);
      out.rows.push(row);
    });
    out.outlets.forEach(function (ot, pos) {
      out.totals.indentKg += ot.indentKg; out.totals.dispatchKg += ot.dispatchKg; out.totals.transferValue += ot.transferValue;
      ot.fillRate = ratio(ot.dispatchKg, ot.indentKg); ot.indentKg = r1(ot.indentKg); ot.dispatchKg = r1(ot.dispatchKg);
      for (var d = rg.d0; d <= rg.d1; d++) if (!st.alternate[oi[pos]] || st.oddDate[d]) ot.supplyDays += 1;
    });
    out.totals.fillRate = ratio(out.totals.dispatchKg, out.totals.indentKg); out.totals.indentKg = r1(out.totals.indentKg); out.totals.dispatchKg = r1(out.totals.dispatchKg);
    var fp = MK.config.factoryParams.fillRateTarget;
    out.byRegion = [{ id: 'mumbai', label: 'Mumbai region (daily supply)', fillRate: ratio(reg.mumbai[0], reg.mumbai[1]), target: fp.mumbai },
      { id: 'pune', label: 'Pune (alternate-day supply)', fillRate: ratio(reg.alternate[0], reg.alternate[1]), target: fp.koregaon }];
    out.shortShipments = st.shorts.filter(function (x) { return x.d >= rg.d0 && x.d <= rg.d1 && oi.indexOf(x.o) !== -1; })
      .sort(function (x, y) { return (y.indentHg - y.dispatchHg) - (x.indentHg - x.dispatchHg) || x.d - y.d; }).slice(0, 25)
      .map(function (x) { return { date: st.db.days[x.d], outletId: st.outlets[x.o].id, sku: st.products[x.k].id, name: st.products[x.k].name, indentKg: r1(x.indentHg), dispatchedKg: r1(x.dispatchHg), shortKg: r1(x.indentHg - x.dispatchHg), reason: x.reason }; });
    return out;
  };

  /** costing(monthKey) - actual cost per kg by SKU split raw material / labour / utilities / overhead, against the standard and the transfer price. */
  factory.costing = function (monthKey) {
    var st = state(), mi = st ? st.db.monthIdx(monthKey) : -1;
    var out = { monthKey: monthKey, period: monthInfo(monthKey), rows: [],
      totals: { outputKg: 0, dispatchKg: 0, rmCost: 0, labour: 0, utilities: 0, overhead: 0, totalCost: 0, transferValue: 0, rmPerKg: 0, labourPerKg: 0, utilitiesPerKg: 0, overheadPerKg: 0, costPerKg: 0, stdRmPerKg: 0, transferPricePerKg: 0 },
      stdConversionPerKg: MK.config ? MK.config.factoryConversionPerKg : 0, stdConversionSplit: MODEL.stdConversionSplit, source: 'erp' };
    if (!st || mi < 0 || !inScope()) return out;
    var M = st.months[mi], b = bucketTotals(mi), overheadPerKg, wl = 0, wu = 0, goodAll = 0, k;
    for (k = 0; k < st.NK; k++) { var w = MODEL.conversionWeights[st.products[k].id] || { labour: 1, utilities: 1 }; wl += M.good[k] * w.labour; wu += M.good[k] * w.utilities; goodAll += M.good[k]; }
    overheadPerKg = ratio(b.overhead, goodAll / 10);
    var tot = { outputKg: 0, dispatchKg: 0, rm: 0, labour: 0, utilities: 0, overhead: 0, total: 0, transferValue: 0, stdRm: 0 };
    st.products.forEach(function (p, k2) {
      var w2 = MODEL.conversionWeights[p.id] || { labour: 1, utilities: 1 }, kg = M.good[k2] / 10, sent = 0, val = 0;
      for (var o = 0; o < st.NO; o++) { sent += M.dispatchKgHg[o * st.NK + k2]; val += M.dispatchValue[o * st.NK + k2]; }
      var labour = ratio(b.labour * M.good[k2] * w2.labour, wl), utilities = ratio(b.utilities * M.good[k2] * w2.utilities, wu), overhead = overheadPerKg * kg;
      var row = { sku: p.id, name: p.name, outputKg: kg, dispatchKg: r1(sent), transferValue: val,
        stdRmCost: p.stdRmCost, stdConversion: p.conversionPerKg, transferPrice: p.transferPrice,
        rmPerKg: ratio(M.rmValueBySku[k2], kg), labourPerKg: ratio(labour, kg), utilitiesPerKg: ratio(utilities, kg), overheadPerKg: ratio(overhead, kg),
        stdYield: p.stdYield, actualYield: ratio(M.yieldWeighted[k2], M.actual[k2]), wastagePct: ratio(M.waste[k2], M.actual[k2]) };
      row.conversionPerKg = row.labourPerKg + row.utilitiesPerKg + row.overheadPerKg;
      row.costPerKg = row.rmPerKg + row.conversionPerKg;
      row.marginPerKg = p.transferPrice - row.costPerKg;                      /* + = over-recovered at the transfer price */
      row.rmVariancePerKg = row.rmPerKg - p.stdRmCost;
      row.totalCost = Math.round(M.rmValueBySku[k2] + labour + utilities + overhead);
      tot.outputKg += kg; tot.dispatchKg += sent / 10; tot.rm += M.rmValueBySku[k2]; tot.labour += labour; tot.utilities += utilities; tot.overhead += overhead; tot.transferValue += val; tot.stdRm += kg * p.stdRmCost;
      out.rows.push(row);
    });
    tot.total = tot.rm + tot.labour + tot.utilities + tot.overhead;
    out.totals = { outputKg: tot.outputKg, dispatchKg: tot.dispatchKg, rmCost: tot.rm, labour: Math.round(tot.labour), utilities: Math.round(tot.utilities), overhead: Math.round(tot.overhead),
      totalCost: Math.round(tot.total), transferValue: tot.transferValue, rmPerKg: ratio(tot.rm, tot.outputKg), labourPerKg: ratio(tot.labour, tot.outputKg),
      utilitiesPerKg: ratio(tot.utilities, tot.outputKg), overheadPerKg: ratio(tot.overhead, tot.outputKg), costPerKg: ratio(tot.total, tot.outputKg),
      stdRmPerKg: ratio(tot.stdRm, tot.outputKg), transferPricePerKg: ratio(tot.transferValue, tot.dispatchKg) };
    return out;
  };

  /** pnl(monthKey) - the factory cost-centre P&L: transfer value - raw materials consumed - conversion costs = over / under absorption. */
  factory.pnl = function (monthKey) {
    var st = state(), mi = st ? st.db.monthIdx(monthKey) : -1;
    if (!st || mi < 0 || !inScope()) {
      /* same keys, nothing in them; status, networkNetSales and the two network ratios are null by contract when there is nothing to report */
      return { monthKey: monthKey, period: monthInfo(monthKey), transferValue: 0, logisticsRecovery: 0, notionalRevenue: 0, dispatchKg: 0, rmConsumed: 0,
        conversion: { labour: 0, utilities: 0, overhead: 0, total: 0 }, conversionAbsorbed: 0, logisticsCost: 0, totalCost: 0, absorption: 0, absorptionPct: 0, status: null,
        variance: { rmPrice: 0, rmYield: 0, wastageAndWriteOffs: 0, finishedStockBuild: 0, labour: 0, utilities: 0, overhead: 0, logistics: 0, other: 0 },
        lines: [], depreciation: 0, operatingCostExRm: 0, networkNetSales: null, factoryCostPctOfNetworkSales: null, transferValuePctOfNetworkSales: null, source: 'erp' };
    }
    return withheld(pnlFor(mi), seesAllOutlets());
  };

  /*
   * Outlet sales stay with the personas that see the outlets. The factory manager gets the two network ratios he is measured on,
   * rounded to a tenth of a percent - enough for a KPI tile, too coarse to work the sales figure back from the transfer value.
   */
  function withheld(p, wholeNetwork) {
    if (wholeNetwork) return p;
    p.networkNetSales = null;
    p.factoryCostPctOfNetworkSales = Math.round(p.factoryCostPctOfNetworkSales * 1000) / 1000;
    p.transferValuePctOfNetworkSales = Math.round(p.transferValuePctOfNetworkSales * 1000) / 1000;
    return p;
  }

  /** purchases(monthKey) - raw-material purchases by item and by vendor at the month's price, with purchase price variance against standard. */
  factory.purchases = function (monthKey) {
    var st = state(), mi = st ? st.db.monthIdx(monthKey) : -1;
    var out = { monthKey: monthKey, period: monthInfo(monthKey), rows: [], byVendor: [], totals: { value: 0, atStandard: 0, ppv: 0, ppvPct: 0, consumedValue: 0, stockChange: 0 }, months: MK.config ? MK.config.months.slice() : [], source: 'erp' };
    if (!st || mi < 0 || !inScope()) return out;
    var M = st.months[mi], vendors = {}, names = {};
    MK.config.vendors.forEach(function (v) { names[v.id] = v; });
    st.rms.forEach(function (rm, r) {
      var v = MODEL.rmVendorByCategory[rm.vendorCategory] || null, qty = M.buyQty[r], value = M.buyValue[r];
      out.rows.push({ rmId: rm.id, name: rm.name, unit: rm.unit, storage: rm.storage, vendorId: v, vendorName: v && names[v] ? names[v].name : null,
        qty: qty, value: value, price: rm.prices[mi], stdPrice: rm.stdPrice, ppv: M.ppv[r], ppvPct: ratio(rm.prices[mi] - rm.stdPrice, rm.stdPrice),
        deliveries: st.rmDeliveries[mi * st.NR + r], consumedQty: M.rmQty[r], consumedValue: M.rmValueByRm[r], priceSeries: rm.prices.slice() });
      if (!vendors[v]) vendors[v] = { vendorId: v, name: v && names[v] ? names[v].name : 'Unassigned', creditDays: v && names[v] ? names[v].creditDays : null, value: 0, ppv: 0 };
      vendors[v].value += value; vendors[v].ppv += M.ppv[r];
      out.totals.value += value; out.totals.ppv += M.ppv[r]; out.totals.atStandard += value - M.ppv[r];
    });
    out.totals.ppvPct = ratio(out.totals.ppv, out.totals.atStandard);
    out.totals.consumedValue = M.rmConsumed; out.totals.stockChange = out.totals.value - M.rmConsumed;
    out.byVendor = Object.keys(vendors).map(function (key) { return vendors[key]; }).sort(function (a, b) { return b.value - a.value; });
    return out;
  };

  /** inventory() - raw-material and finished-goods stock as of MK.calendar.today, days of cover, reorder and FEFO / expiry flags. */
  factory.inventory = function () {
    var st = state(), out = { asOf: MK.calendar.today, rawMaterials: [], finishedGoods: [], totals: { rmValue: 0, fgValue: 0, reorderCount: 0, expiringCount: 0 }, coverTargets: { fresh: [1, 3], frozen: [7, 10], dry: [15, 30] }, source: 'erp' };
    if (!st || !inScope()) return out;
    var last = st.ND - 1, mi = st.NMO - 1, D = MK.dates, names = {};
    MK.config.vendors.forEach(function (v) { names[v.id] = v.name; });
    st.rms.forEach(function (rm, r) {
      var pol = MODEL.rmPolicy[rm.storage] || MODEL.rmPolicy.dry, qty = st.rmStockEnd[last * st.NR + r], avg = st.rmAvgUse[r], cover = ratio(qty, avg);
      var reorderQty = pol.closingCoverDays ? avg * 1.0 : pol.reorderDays * avg;
      var status = pol.closingCoverDays ? (cover < 1 ? 'LOW' : 'OK') : (qty <= reorderQty * 1.15 ? 'REORDER' : 'OK');
      var v = MODEL.rmVendorByCategory[rm.vendorCategory] || null;
      out.rawMaterials.push({ rmId: rm.id, name: rm.name, unit: rm.unit, storage: rm.storage, stockQty: Math.round(qty * 10) / 10, value: Math.round(qty * rm.prices[mi]),
        avgDailyUse: avg, daysOfCover: cover, reorderLevelQty: Math.round(reorderQty), status: status,
        lastPurchaseDate: st.rmLastBuy[r] >= 0 ? st.db.days[st.rmLastBuy[r]] : null, price: rm.prices[mi], stdPrice: rm.stdPrice, priceSeries: rm.prices.slice(),
        vendorId: v, vendorName: v ? names[v] || null : null });
      out.totals.rmValue += Math.round(qty * rm.prices[mi]); if (status !== 'OK') out.totals.reorderCount += 1;
    });
    st.products.forEach(function (p, k) {
      var lotsOut = [], stock = 0, sent = 0, base = k * (st.maxAge + 1), worst = 'OK';
      for (var d = Math.max(0, last - 13); d <= last; d++) for (var o = 0; o < st.NO; o++) sent += st.dispatchHg[(d * st.NO + o) * st.NK + k];
      for (var a = st.maxAge; a >= 0; a--) {
        var hg = st.finalLots[base + a]; if (!hg) continue;
        /* production finishes around 18:00; stock is read at 08:00 on MK.calendar.today */
        var producedOn = st.db.days[last - a], hoursLeft = p.shelfLifeHours - ((a + 1) * 24 - 10);
        var status = hoursLeft <= 24 ? 'EXPIRING' : (lotsOut.length === 0 && a > 0 ? 'USE_FIRST' : 'OK');
        if (status === 'EXPIRING') worst = 'EXPIRING'; else if (status === 'USE_FIRST' && worst === 'OK') worst = 'USE_FIRST';
        lotsOut.push({ producedOn: producedOn, kg: r1(hg), expiresOn: D.addDays(producedOn, Math.floor((18 + p.shelfLifeHours) / 24)), hoursLeft: hoursLeft, status: status });
        stock += hg;
      }
      var avgKg = sent / 10 / Math.min(14, last + 1);
      out.finishedGoods.push({ sku: p.id, name: p.name, stockKg: r1(stock), value: Math.round(stock / 10 * p.transferPrice), avgDailyDispatchKg: avgKg, daysOfCover: ratio(stock / 10, avgKg),
        shelfLifeHours: p.shelfLifeHours, lots: lotsOut, status: worst });
      out.totals.fgValue += Math.round(stock / 10 * p.transferPrice); if (worst === 'EXPIRING') out.totals.expiringCount += 1;
    });
    return out;
  };

  /* ------------------------------------------------------- raw, unscoped access */
  /* For MK.finance, MK.seed and tools/check-data.js only. Pages must use the scoped selectors above. */

  factory.raw = {
    model: MODEL,
    monthInfo: monthInfo,
    state: state,
    checksum: function () { var st = state(); return st ? st.checksum : 0; },
    /** Over-use rate of an outlet (share above recipe), the driver of its food cost variance. */
    overUseRate: function (outletId) { var st = state(); if (!st) return 0; var i = st.db.index.outlet[outletId]; return i === undefined ? 0 : st.overUse[i]; },
    /** Transfer value and kg dispatched to an outlet in a month: the outlet's factory-sourced food cost. */
    dispatchToOutlet: function (monthKey, outletId) {
      var st = state(), mi = st ? st.db.monthIdx(monthKey) : -1, o = st ? st.db.index.outlet[outletId] : undefined;
      if (mi < 0 || o === undefined) return { value: 0, kg: 0, theoreticalKg: 0 };
      return { value: st.months[mi].valueByOutlet[o], kg: st.months[mi].kgHgByOutlet[o] / 10, theoreticalKg: st.months[mi].theoKgByOutlet[o] };
    },
    costLines: function (monthKey) { var st = state(); return st ? costLines(st.db.monthIdx(monthKey)) : []; },
    logistics: function (monthKey) { var st = state(); return logisticsAllocation(st ? st.db.monthIdx(monthKey) : -1); },
    pnl: function (monthKey) { var st = state(), mi = st ? st.db.monthIdx(monthKey) : -1; return mi < 0 ? null : pnlFor(mi); },
    staffing: function () { return MODEL.costBase.staffing; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.MK;
})(typeof window !== 'undefined' ? window : globalThis);
