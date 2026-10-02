/*
 * MK.engine - order-by-order sales simulation (docs/SPEC.md 6.3, docs/RESEARCH.md sections 2-4 and 6).
 * MK.engine.run() builds MK.db: typed-array cubes, the last 14 days of orders, aggregator payout
 * cycles and the monthly roll-ups the finance and factory layers read. Everything is derived from
 * MK.config through MK.rng - no clock, no Math.random, no patched outputs.
 * MK.db is UNSCOPED raw data. Pages must go through the scoped selectors in js/data/sales.js.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});
  var engine = MK.engine = MK.engine || {};
  engine.ready = false;

  var H = 16, SL = 4, HOUR0 = 12, RECENT_DAYS = 14;
  /* measures of the hour and day cubes, in stride order */
  var M = { orders: 0, cancelled: 1, cancelledValue: 2, grossItemValue: 3, packaging: 4, discount: 5, netSales: 6, gst: 7, items: 8 };
  var NM = 9;
  /* measures of the dish cube */
  var DM = { qty: 0, gross: 1, net: 2, lines: 3 };
  var NDM = 4;
  /* measures of the aggregator fee cube (per business day x outlet x aggregator x part-of-day) */
  var F = { orders: 0, grossValue: 1, discount: 2, netSales: 3, gst: 4, feeBase: 5, serviceFee: 6, serviceFeeContract: 7, collectionFee: 8, otherFees: 9, gstOnFees: 10, gstOnFeesContract: 11, tds: 12 };
  var NF = 13;

  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function slotOfHourIdx(h) { var hr = h + HOUR0; return hr < 16 ? 0 : hr < 19 ? 1 : hr < 23 ? 2 : 3; }
  function cumulative(weights) {
    var out = new Float64Array(weights.length), t = 0, i;
    for (i = 0; i < weights.length; i++) t += weights[i];
    var c = 0;
    for (i = 0; i < weights.length; i++) { c += t > 0 ? weights[i] / t : 0; out[i] = c; }
    out[weights.length - 1] = 1;
    return out;
  }
  function median(values) {
    var v = values.slice().sort(function (x, y) { return x - y; }), mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }
  function drawCum(cum, u) { var i = 0, n = cum.length - 1; while (i < n && u > cum[i]) i++; return i; }

  /* ------------------------------------------------------------ payout cycles */

  /**
   * Cycles of one aggregator covering every calendar date an order can fall on
   * (dataStart .. dataEnd + 1, because trading runs past midnight).
   * Swiggy: Sunday-Saturday, cut at month-end, settled the Tuesday after the week.
   * Zomato: Monday-Sunday, paid the Thursday after the week.
   */
  function buildCycles(terms, calDates, today, dataStart) {
    var D = MK.dates, cycles = [], cycleOfCal = new Int32Array(calDates.length), last = null;
    for (var c = 0; c < calDates.length; c++) {
      var iso = calDates[c], dow = D.dow(iso);
      var sinceStart = (dow - terms.cycle.weekStartDow + 7) % 7;
      var weekFrom = D.addDays(iso, -sinceStart), weekTo = D.addDays(weekFrom, 6);
      var from = weekFrom, to = weekTo;
      if (terms.cycle.cutAtMonthEnd) { from = D.max(from, D.monthStart(iso)); to = D.min(to, D.monthEnd(iso)); }
      if (!last || last.from !== from) {
        var settleOffset = ((terms.cycle.settlementDow - D.dow(weekTo)) + 7) % 7 || 7;
        last = {
          index: cycles.length, from: from, to: to, weekFrom: weekFrom, weekTo: weekTo,
          settlementDate: D.addDays(weekTo, settleOffset),
          settled: to <= terms.settledThrough,
          partial: from < dataStart,
          unsettledStatus: to <= terms.settledThrough ? null : (to >= today ? 'IN_CYCLE' : 'AWAITING_STATEMENT')
        };
        cycles.push(last);
      }
      cycleOfCal[c] = last.index;
    }
    return { cycles: cycles, cycleOfCal: cycleOfCal };
  }

  /* ------------------------------------------------------------------- build */

  function build(cfg) {
    var D = MK.dates;
    var days = D.range(cfg.dataStart, cfg.dataEnd), ND = days.length;
    var calDates = days.concat([D.addDays(cfg.dataEnd, 1)]);
    var outlets = cfg.outlets.filter(function (o) { return o.type === 'outlet'; }), NO = outlets.length;
    var streams = cfg.streams, NS = streams.length;
    var dishes = cfg.dishes, NDI = dishes.length;
    var aggIds = cfg.channels.filter(function (c) { return c.kind === 'aggregator'; }).map(function (c) { return c.id; }), NA = aggIds.length;
    var monthKeys = cfg.months, NMO = monthKeys.length;

    var dayIndex = Object.create(null), dayDow = new Int8Array(ND), dayMonth = new Int8Array(ND), i, o, s, h, a;
    for (i = 0; i < ND; i++) { dayIndex[days[i]] = i; dayDow[i] = D.dow(days[i]); dayMonth[i] = monthKeys.indexOf(D.monthKey(days[i])); }
    /* id -> index maps without a prototype: an id such as 'constructor' or '__proto__' must read as unknown */
    var outletIndex = Object.create(null), streamIndex = Object.create(null), dishIndex = Object.create(null), aggIndex = Object.create(null);
    outlets.forEach(function (x, k) { outletIndex[x.id] = k; });
    streams.forEach(function (x, k) { streamIndex[x.id] = k; });
    dishes.forEach(function (x, k) { dishIndex[x.id] = k; });
    aggIds.forEach(function (x, k) { aggIndex[x] = k; });

    /* stream facts as flat arrays for the hot loop */
    var streamMedium = streams.map(function (x) { return x.mediumId; });
    var streamAgg = streams.map(function (x) { return aggIndex[x.channelId] === undefined ? -1 : aggIndex[x.channelId]; });
    var mediumIdx = { dinein: 0, takeaway: 1, delivery: 2 };

    /* ---- hour shares: profile x outlet slot character x opening hours, normalised per outlet ---- */
    function hourShares(outlet, kind, dayType) {
      var prof = cfg.demand.hourProfile[kind], sm = cfg.demand.slotMult[outlet.id] || {};
      var mult = sm[dayType] || sm.all || {}, w = new Float64Array(H), t = 0;
      for (var k = 0; k < H; k++) {
        var hr = k + HOUR0, open = Math.max(0, Math.min(hr + 1, outlet.hours.close) - Math.max(hr, outlet.hours.open));
        var slotId = cfg.slots[slotOfHourIdx(k)].id;
        w[k] = prof[k] * (mult[slotId] === undefined ? 1 : mult[slotId]) * open;
        t += w[k];
      }
      for (k = 0; k < H; k++) w[k] = t > 0 ? w[k] / t : 0;
      return w;
    }
    var share = outlets.map(function (outlet) {
      return { instore: { weekday: hourShares(outlet, 'instore', 'weekday'), weekend: hourShares(outlet, 'instore', 'weekend') },
        aggregator: { weekday: hourShares(outlet, 'aggregator', 'weekday'), weekend: hourShares(outlet, 'aggregator', 'weekend') } };
    });

    /* ---- ramp, day-of-week, month phase ---- */
    var refIdx = D.diffDays(cfg.dataStart, cfg.demand.ramp.refDate);
    function dayFactor(oIdx, dIdx) {
      var outlet = outlets[oIdx], iso = days[dIdx];
      var flat = cfg.demand.ramp.flatAfter[outlet.id];
      var rampDay = flat ? Math.min(dIdx, D.diffDays(cfg.dataStart, flat)) : dIdx;
      var ramp = Math.pow(1 + (cfg.demand.ramp.monthlyGrowth[outlet.id] || 0), (rampDay - refIdx) / 30.4375);
      var dom = +iso.slice(8, 10), dim = D.daysInMonth(D.monthKey(iso)), mp = cfg.demand.monthPhase;
      var phase = dom <= mp.firstDays ? mp.firstMult : (dom > dim - mp.lastDays ? (mp.lastMult[outlet.id] || 1) : 1);
      return ramp * cfg.demand.dow[outlet.id][dayDow[dIdx]] * phase;
    }

    /* ---- prices in force by day: [day][outlet][list 0 = POS, 1 = aggregator][dish], 0 = not sold ---- */
    var price = new Int32Array(ND * NO * 2 * NDI);
    for (i = 0; i < ND; i++) for (o = 0; o < NO; o++) for (var di = 0; di < NDI; di++) {
      var sold = MK.data.dishSoldAt(dishes[di].id, outlets[o].id);
      price[((i * NO + o) * 2 + 0) * NDI + di] = sold ? MK.data.posPriceOn(dishes[di].id, days[i]) : 0;
      price[((i * NO + o) * 2 + 1) * NDI + di] = sold ? (MK.data.aggPriceOn(dishes[di].id, outlets[o].id, days[i]) || 0) : 0;
    }

    /* ---- dish mix: weights by outlet x medium x slot, reshaped on event days ---- */
    var om = cfg.orderModel;
    var naanIdx = dishIndex.butter_naan;
    var isNaanCat = dishes.map(function (x) { return om.naanAttach.categories.indexOf(x.category) !== -1; });
    var doubleChance = dishes.map(function (x) { return om.doubleQtyChance[x.category] === undefined ? om.doubleQtyChance['default'] : om.doubleQtyChance[x.category]; });
    var MEDIUMS = ['dinein', 'takeaway', 'delivery'];
    function mixTables(activeEvents) {
      var t = [];
      for (var oi = 0; oi < NO; oi++) for (var mi = 0; mi < 3; mi++) for (var si = 0; si < SL; si++) {
        var w = new Float64Array(NDI), base = om.dishWeights[MEDIUMS[mi]];
        var slotM = om.slotCategoryMult[cfg.slots[si].id] || {}, outM = om.outletCategoryMult[outlets[oi].id] || {};
        for (var k = 0; k < NDI; k++) {
          var dish = dishes[k];
          if (dish.isAttach || !MK.data.dishSoldAt(dish.id, outlets[oi].id)) { w[k] = 0; continue; }
          var v = (base[dish.id] || 0) * (slotM[dish.category] || 1) * (outM[dish.category] || 1);
          for (var e = 0; e < activeEvents.length; e++) {
            var ev = activeEvents[e];
            if (ev.dishMult && ev.dishMult[dish.id]) v *= ev.dishMult[dish.id];
            if (ev.categoryMult && ev.categoryMult[dish.category]) v *= ev.categoryMult[dish.category];
          }
          w[k] = v;
        }
        t.push(cumulative(w));
      }
      return t;
    }
    var baseMix = mixTables([]);
    var mainsCum = MEDIUMS.map(function (m) { return cumulative(om.mainsCount[m]); });

    /* ---- events per day ---- */
    var eventsByDay = days.map(function (iso) { return cfg.events.filter(function (ev) { return ev.from <= iso && iso <= ev.to; }); });
    function eventMult(evs, outletId, mediumId, hr, dow) {
      var m = 1;
      for (var e = 0; e < evs.length; e++) {
        var fx = evs[e].effects || [];
        for (var k = 0; k < fx.length; k++) {
          var x = fx[k];
          if (x.mediums && x.mediums.indexOf(mediumId) === -1) continue;
          if (x.outlets && x.outlets.indexOf(outletId) === -1) continue;
          if (x.hours && (hr < x.hours[0] || hr >= x.hours[1])) continue;
          if (x.dows && x.dows.indexOf(dow) === -1) continue;
          m *= x.mult;
        }
      }
      return m;
    }
    function cancelMult(evs, kind) {
      var m = 1;
      for (var e = 0; e < evs.length; e++) if (evs[e].cancelMult && evs[e].cancelMult[kind]) m *= evs[e].cancelMult[kind];
      return m;
    }

    /* ---- aggregator terms, cycles and seeded rate overrides (by calendar date) ---- */
    var terms = aggIds.map(function (id) { return cfg.channelTerms[id]; });
    var cyc = terms.map(function (t) { return buildCycles(t, calDates, cfg.today, cfg.dataStart); });
    var contractRate = terms.map(function (t) { return outlets.map(function (x) { return t.serviceFeePctByOutlet[x.id] === undefined ? t.serviceFeePct : t.serviceFeePctByOutlet[x.id]; }); });
    var overrideRate = new Float64Array(NA * NO * calDates.length);
    cfg.channelExceptions.forEach(function (ex) {
      if (ex.kind !== 'rate_override') return;
      var ai = aggIndex[ex.channelId], oi = outletIndex[ex.outletId];
      if (ai === undefined || oi === undefined) return;
      for (var c = 0; c < calDates.length; c++) if (calDates[c] >= ex.from && calDates[c] <= ex.to) overrideRate[(ai * NO + oi) * calDates.length + c] = ex.serviceFeePct;
    });

    /* ---- storage ---- */
    var hourCube = new Int32Array(ND * NO * NS * H * NM);
    var dishCube = new Int32Array(ND * NO * NS * SL * NDI * NDM);
    var feeCube = new Int32Array(ND * NO * NA * 2 * NF);
    var cycAcc = cyc.map(function (c) { return new Float64Array(c.cycles.length * NO * NF); });
    /* long-distance fee already put on the orders of an unsettled cycle (per cycle x outlet), see genOrders */
    var cycLdEstimated = cyc.map(function (c) { return new Int32Array(c.cycles.length * NO); });
    var ldExpectedPerOrder = terms.map(function (t) { var ld = t.longDistanceFee; return ld ? ld.orderShare * (ld.min + ld.max) / 2 : 0; });
    var paymentMix = new Float64Array(NMO * NO * 3);
    var recent = [], recentFrom = ND - RECENT_DAYS;
    var lineQty = new Int32Array(NDI), touched = new Int32Array(NDI), lineAmt = new Int32Array(NDI);

    var seed = cfg.demand.seed, noiseCfg = cfg.demand.dayNoise;
    var netRng = MK.rng(seed + '|network-noise');
    var outletNoiseRng = outlets.map(function (x) { return MK.rng(seed + '|outlet-noise|' + x.id); });
    function noise(rng, sd) { return 1 + Math.max(-noiseCfg.clip, Math.min(noiseCfg.clip, rng.normal(0, sd))); }
    var payCum = cumulative([cfg.paymentMix.upi, cfg.paymentMix.card, cfg.paymentMix.cash]), PAY = ['UPI', 'Card', 'Cash'];
    var gstPct = cfg.gst.salesPct, feeGstPct = cfg.gst.onAggregatorFeesPct;

    function clock(dIdx, minuteOfBusinessDay) {
      var hr = HOUR0 + Math.floor(minuteOfBusinessDay / 60), mi = minuteOfBusinessDay % 60;
      var date = hr >= 24 ? calDates[dIdx + 1] : days[dIdx];
      return date + 'T' + pad(hr % 24, 2) + ':' + pad(mi, 2);
    }

    /* ---- the simulation: day -> outlet -> stream -> hour -> orders ---- */
    for (var d = 0; d < ND; d++) {
      var iso = days[d], dow = dayDow[d], evs = eventsByDay[d], dayType = dow >= 5 ? 'weekend' : 'weekday';
      var reshaped = evs.some(function (ev) { return ev.dishMult || ev.categoryMult; });
      var mix = reshaped ? mixTables(evs) : baseMix;
      var netNoise = noise(netRng, noiseCfg.networkSd);
      var cancelAgg = cancelMult(evs, 'aggregator'), cancelIn = cancelMult(evs, 'instore');
      var isRecent = d >= recentFrom;

      for (o = 0; o < NO; o++) {
        var outlet = outlets[o];
        var level = dayFactor(o, d) * netNoise * noise(outletNoiseRng[o], noiseCfg.outletSd);
        var dayOrders = isRecent ? [] : null;

        for (s = 0; s < NS; s++) {
          var stream = streams[s], medium = streamMedium[s], mIdx = mediumIdx[medium], ai = streamAgg[s], isAgg = ai >= 0;
          var rng = MK.rng(seed + '|' + iso + '|' + outlet.id + '|' + stream.id);
          var detail = isRecent ? MK.rng(seed + '|detail|' + iso + '|' + outlet.id + '|' + stream.id) : null;
          var base = cfg.demand.baseOrders[outlet.id][stream.id] * level;
          var shares = share[o][isAgg ? 'aggregator' : 'instore'][dayType];
          var pCancel = isAgg ? cfg.cancellation.aggregator[outlet.id] * cancelAgg : cfg.cancellation.instore * cancelIn;
          var disc = isAgg ? cfg.discounts.aggregator[outlet.id] : cfg.discounts.instore;

          for (h = 0; h < H; h++) {
            if (shares[h] <= 0) continue;
            var n = rng.poisson(base * shares[h] * eventMult(evs, outlet.id, medium, h + HOUR0, dow));
            if (n > 0) genOrders(n, rng, detail, dayOrders, d, o, s, h, mIdx, ai, pCancel, disc, mix[(o * 3 + mIdx) * SL + slotOfHourIdx(h)]);
          }
        }
        if (isRecent) finishOutletDay(dayOrders, outlet, iso);
      }
    }

    /*
     * n orders of one outlet x stream x hour. Kept as a small function of its own so the JIT
     * optimises it early; it allocates nothing unless the day is inside the recent-orders window.
     */
    function genOrders(n, rng, detail, dayOrders, d, o, s, h, mIdx, ai, pCancel, disc, cum) {
      var isAgg = ai >= 0, medium = MEDIUMS[mIdx], hr = h + HOUR0, sl = slotOfHourIdx(h);
      var pack = cfg.packagingCharge[medium], naanChance = om.naanAttach.chance[medium], naanTwo = om.naanAttach.twoPiecesChance[medium];
      var priceBase = ((d * NO + o) * 2 + (isAgg ? 1 : 0)) * NDI;
      var t = isAgg ? terms[ai] : null;
      var cell = (((d * NO + o) * NS + s) * H + h) * NM;
      var dcell = ((((d * NO + o) * NS + s) * SL + sl) * NDI) * NDM;
      var part = hr >= 24 ? 1 : 0, cal = d + part, keep = dayOrders !== null;
      var mCum = mainsCum[mIdx], j, di2;

      for (var k = 0; k < n; k++) {
        /* -- item lines -- */
        var cancelled = rng.next() < pCancel;
        var mains = 1 + drawCum(mCum, rng.next()), nt = 0, naan = 0;
        for (j = 0; j < mains; j++) {
          di2 = drawCum(cum, rng.next());
          var q = rng.next() < doubleChance[di2] ? 2 : 1;
          if (lineQty[di2] === 0) touched[nt++] = di2;
          lineQty[di2] += q;
          if (isNaanCat[di2]) for (var u = 0; u < q; u++) if (rng.next() < naanChance) naan += rng.next() < naanTwo ? 2 : 1;
        }
        if (naan > 0) { if (lineQty[naanIdx] === 0) touched[nt++] = naanIdx; lineQty[naanIdx] += naan; }

        /* -- money: whole rupees at the point each value becomes a fact -- */
        var gross = 0, items = 0, big = 0;
        for (j = 0; j < nt; j++) {
          di2 = touched[j];
          lineAmt[j] = lineQty[di2] * price[priceBase + di2];
          gross += lineAmt[j]; items += lineQty[di2];
          if (lineAmt[j] > lineAmt[big]) big = j;
        }
        var packaging = pack.base > 0 ? Math.min(pack.max, pack.base + pack.perExtraLine * (nt - 1)) : 0;
        var discount = rng.next() < disc.orderShare ? Math.round(Math.min(disc.pct * gross, disc.cap)) : 0;
        var net = gross + packaging - discount;
        var gst = Math.round(gstPct * net);
        var payIdx = isAgg ? -1 : drawCum(payCum, rng.next());
        var longDistance = (isAgg && t.longDistanceFee && rng.next() < t.longDistanceFee.orderShare) ? rng.int(t.longDistanceFee.min, t.longDistanceFee.max) : 0;
        var fees = null;

        if (cancelled) {
          hourCube[cell + M.cancelled] += 1;
          hourCube[cell + M.cancelledValue] += net;
        } else {
          hourCube[cell + M.orders] += 1;
          hourCube[cell + M.grossItemValue] += gross;
          hourCube[cell + M.packaging] += packaging;
          hourCube[cell + M.discount] += discount;
          hourCube[cell + M.netSales] += net;
          hourCube[cell + M.gst] += gst;
          hourCube[cell + M.items] += items;

          /* dish-level net sales: packaging charge and discount spread over the lines pro rata, remainder on the largest line */
          var adj = packaging - discount, spread = 0, b;
          for (j = 0; j < nt; j++) {
            if (j === big) continue;
            var lineAdj = Math.round(adj * lineAmt[j] / gross);
            spread += lineAdj;
            b = dcell + touched[j] * NDM;
            dishCube[b + DM.qty] += lineQty[touched[j]];
            dishCube[b + DM.gross] += lineAmt[j];
            dishCube[b + DM.net] += lineAmt[j] + lineAdj;
            dishCube[b + DM.lines] += 1;
          }
          b = dcell + touched[big] * NDM;
          dishCube[b + DM.qty] += lineQty[touched[big]];
          dishCube[b + DM.gross] += lineAmt[big];
          dishCube[b + DM.net] += lineAmt[big] + (adj - spread);
          dishCube[b + DM.lines] += 1;

          if (!isAgg) {
            paymentMix[(dayMonth[d] * NO + o) * 3 + payIdx] += net + gst;
          } else {
            /* aggregator charges per the contract; the statement rate applies once the cycle is settled */
            var cycleIdx = cyc[ai].cycleOfCal[cal], settled = cyc[ai].cycles[cycleIdx].settled;
            var withGst = net + gst;
            var feeBase = t.serviceFeeBase === 'net_plus_gst' ? withGst : net;
            var rateC = contractRate[ai][o], ov = overrideRate[(ai * NO + o) * calDates.length + cal];
            var rateA = settled && ov > 0 ? ov : rateC;
            var svcC = Math.round(rateC * feeBase), svcA = Math.round(rateA * feeBase);
            var coll = Math.round(t.collectionFeePct * (t.collectionFeeBase === 'net_plus_gst' ? withGst : net));
            var fc = (((d * NO + o) * NA + ai) * 2 + part) * NF, pc = (cycleIdx * NO + o) * NF, acc = cycAcc[ai];
            /*
             * Long-distance fee: which orders were long-distance is known only from the settlement report. A settled order
             * carries the fee it was charged; an unsettled one carries the expected value per order (share x mean fee), kept
             * in whole rupees by a running carry over the cycle, so the estimate never points at an individual order.
             */
            var ldFee = longDistance;
            if (!settled && ldExpectedPerOrder[ai] > 0) {
              var ldIx = cycleIdx * NO + o;
              ldFee = Math.round(ldExpectedPerOrder[ai] * (acc[pc + F.orders] + 1)) - cycLdEstimated[ai][ldIx];
              cycLdEstimated[ai][ldIx] += ldFee;
            }
            var other = Math.round(t.otherFeePct * (t.otherFeeBase === 'net_plus_gst' ? withGst : net)) + ldFee;
            var gstC = Math.round(feeGstPct * (svcC + coll + other)), gstA = Math.round(feeGstPct * (svcA + coll + other));
            /*
             * TDS is 0.1% of the net bill value of the statement. Rounding it on each order (typically Rs 0.4 to 0.7) would
             * lose about a tenth of it, so the order amount is the whole-rupee step of the cycle's running total: the orders
             * of a cycle always add up to round(rate x net bill value of the cycle).
             */
            var tds = Math.round(t.tdsPct * (acc[pc + F.netSales] + net)) - acc[pc + F.tds];
            feeCube[fc + F.orders] += 1; acc[pc + F.orders] += 1;
            feeCube[fc + F.grossValue] += gross + packaging; acc[pc + F.grossValue] += gross + packaging;
            feeCube[fc + F.discount] += discount; acc[pc + F.discount] += discount;
            feeCube[fc + F.netSales] += net; acc[pc + F.netSales] += net;
            feeCube[fc + F.gst] += gst; acc[pc + F.gst] += gst;
            feeCube[fc + F.feeBase] += feeBase; acc[pc + F.feeBase] += feeBase;
            feeCube[fc + F.serviceFee] += svcA; acc[pc + F.serviceFee] += svcA;
            feeCube[fc + F.serviceFeeContract] += svcC; acc[pc + F.serviceFeeContract] += svcC;
            feeCube[fc + F.collectionFee] += coll; acc[pc + F.collectionFee] += coll;
            feeCube[fc + F.otherFees] += other; acc[pc + F.otherFees] += other;
            feeCube[fc + F.gstOnFees] += gstA; acc[pc + F.gstOnFees] += gstA;
            feeCube[fc + F.gstOnFeesContract] += gstC; acc[pc + F.gstOnFeesContract] += gstC;
            feeCube[fc + F.tds] += tds; acc[pc + F.tds] += tds;
            if (keep) {
              /* totalDeductions = what the aggregator keeps as a cost (same definition as MK.data.channelEconomics); TDS is a
               * recoverable tax credit and stays on its own line: netReceivable = netSales - totalDeductions - tds */
              fees = { kind: settled ? 'actual' : 'estimated', feeBase: feeBase, serviceFeePct: rateA, serviceFee: svcA, collectionFee: coll,
                otherFees: other, gstOnFees: gstA, tds: tds, totalDeductions: svcA + coll + other + gstA, netReceivable: net - (svcA + coll + other + gstA) - tds };
            }
          }
        }

        if (keep) dayOrders.push(makeOrder(d, o, h, sl, cal, outlets[o], streams[s], ai, t, detail, dayOrders.length, nt, priceBase, cancelled, items, gross, packaging, discount, net, gst, payIdx, fees));
        for (j = 0; j < nt; j++) lineQty[touched[j]] = 0;
      }
    }

    /* ---- recent-order objects: only fields the channel can supply (DATA-FEASIBILITY.md section 3) ---- */
    function makeOrder(d, o, h, sl, cal, outlet, stream, ai, t, detail, seqNo, nt, priceBase, cancelled, items, gross, packaging, discount, net, gst, payIdx, fees) {
      var hr = h + HOUR0, isAgg = ai >= 0, medium = stream.mediumId, iso = days[d];
      var lo = Math.max(hr, outlet.hours.open), hi = Math.min(hr + 1, outlet.hours.close);
      var minute = Math.min(59, Math.floor((lo + detail.next() * (hi - lo) - hr) * 60));
      var mob = h * 60 + minute, lines = [];
      for (var j2 = 0; j2 < nt; j2++) {
        var dish = dishes[touched[j2]];
        lines.push({ dishId: dish.id, name: dish.name, category: dish.category, veg: dish.veg, qty: lineQty[touched[j2]], unitPrice: price[priceBase + touched[j2]], lineTotal: lineAmt[j2] });
      }
      var ord = {
        id: null, invoiceNo: 0, posRef: null, aggregatorOrderId: null,
        outletId: outlet.id, channelId: stream.channelId, mediumId: medium, streamId: stream.id,
        businessDate: iso, placedAt: clock(d, mob), hour: hr, slotId: cfg.slots[sl].id,
        status: cancelled ? 'cancelled' : 'completed',
        items: lines, itemCount: items, subtotal: gross, packagingCharge: packaging, discountTotal: discount, discountRestaurantFunded: discount,
        netSales: cancelled ? 0 : net, cancelledValue: cancelled ? net : 0,
        gst: { amount: cancelled ? 0 : gst, treatment: isAgg ? 'memo_collected_by_aggregator' : 'collected_by_restaurant' },
        total: cancelled ? 0 : net + gst,
        source: 'petpooja', seq: mob * 1000 + (seqNo % 1000)
      };
      if (!isAgg) {
        ord.paymentMode = cancelled ? null : PAY[payIdx];
        if (cancelled) ord.cancel = { reason: detail.pick(cfg.cancellation.reasons.petpooja), approver: detail.pick(cfg.cancellation.approvers) };
      } else {
        var cycle = cyc[ai].cycles[cyc[ai].cycleOfCal[cal]];
        var seq = ((d * 57600 + mob * 60 + detail.int(0, 59)) * 5 + o);
        ord.aggregatorOrderId = ai === aggIndex.swiggy ? String(214500000000000 + seq * 1000 + detail.int(0, 999)) : String(7300000000 + seq * 10 + detail.int(0, 9));
        ord.payoutId = payoutId(aggIds[ai], outlet.id, cycle.from);
        /* Swiggy relays an unsplit discount; the restaurant-funded share is confirmed only by the annexure */
        if (aggIds[ai] === 'swiggy' && !cycle.settled) ord.discountRestaurantFunded = null;
        ord.fees = fees;
        ord.feesSource = fees ? (fees.kind === 'actual' ? t.statementSource : 'estimate') : null;
        if (aggIds[ai] === 'zomato') ord.paymentFlag = detail.next() < cfg.zomatoPrepaidShare ? 'prepaid' : 'cod';
        var accepted = mob + detail.int(0, 2), tl = { placedAt: ord.placedAt, acceptedAt: null, foodReadyAt: null, pickedUpAt: null, deliveredAt: null, cancelledAt: null };
        if (cancelled) {
          tl.cancelledAt = clock(d, mob + detail.int(1, 12));
          ord.cancel = aggIds[ai] === 'zomato' ? { reason: detail.pick(cfg.cancellation.reasons.zomato) }
            : (cycle.settled ? { cancelledBy: detail.pick(cfg.cancellation.reasons.swiggyCancelledBy) } : null);
          ord.prepMinutes = null;
        } else {
          var prep = 7 + Math.round(items * 1.5) + detail.int(0, 9) + (sl === 2 ? 3 : 0);
          var markedReady = detail.next() < 0.9, pickup = accepted + prep + detail.int(2, 9);
          tl.acceptedAt = clock(d, accepted);
          tl.foodReadyAt = markedReady ? clock(d, accepted + prep) : null;
          tl.pickedUpAt = clock(d, pickup);
          tl.deliveredAt = detail.next() < 0.85 ? clock(d, pickup + detail.int(12, 32)) : null;
          ord.prepMinutes = markedReady ? prep : null;
        }
        ord.timeline = tl;
      }
      return ord;
    }

    /* POS invoice numbers run per outlet per business day in time order, across all channels. */
    function finishOutletDay(list, outletCfg, isoDate) {
      list.sort(function (x, y) { return x.seq - y.seq; });
      for (var q2 = 0; q2 < list.length; q2++) {
        var ord = list[q2];
        ord.invoiceNo = q2 + 1;
        ord.posRef = outletCfg.code + '-' + isoDate.replace(/-/g, '') + '-' + pad(q2 + 1, 4);
        ord.id = ord.aggregatorOrderId || ord.posRef;
        recent.push(ord);
      }
    }

    function payoutId(channelId, outletId, from) { return 'PO-' + (channelId === 'swiggy' ? 'SW' : 'ZO') + '-' + outletId + '-' + from; }

    /* ---- payout cycles: one record per outlet x aggregator x cycle ---- */
    var payouts = [], payoutById = {};
    /* cycle-level amounts spread over the fee-cube cells of the cycle in proportion to menu value (unrounded) */
    var allocAds = new Int32Array(ND * NO * NA * 2), allocRefunds = new Int32Array(ND * NO * NA * 2), allocUnclassified = new Int32Array(ND * NO * NA * 2);
    var rules = cfg.auditRules;

    /*
     * Whole-rupee split of a cycle-level amount over the cells of the cycle in proportion to their menu value (largest
     * remainder), so that the cells add up to the statement line exactly and every roll-up of cells - by day, month,
     * channel or outlet - is a sum of integers that ties to the rupee.
     */
    function allocate(target, total, cellIdx, weights, weightSum) {
      var n = cellIdx.length, given = 0, k;
      if (!n || !total || weightSum <= 0) return;
      var frac = new Float64Array(n);
      for (k = 0; k < n; k++) {
        var exact = total * weights[k] / weightSum, whole = Math.floor(exact);
        target[cellIdx[k]] = whole; frac[k] = exact - whole; given += whole;
      }
      for (var left = total - given; left > 0; left--) {
        var best = 0;
        for (k = 1; k < n; k++) if (frac[k] > frac[best]) best = k;
        target[cellIdx[best]] += 1; frac[best] = -1;
      }
    }

    function linesFrom(v, serviceFee, gstOnFees, ads, refunds, unclassified) {
      var l = {
        grossValue: v[F.grossValue], restaurantDiscount: v[F.discount], netBillValue: v[F.netSales],
        serviceFee: serviceFee, serviceFeePct: v[F.feeBase] > 0 ? Math.round(serviceFee / v[F.feeBase] * 1000) / 1000 : 0,   /* to 0.1%: per-order rounding blurs the 4th decimal */
        collectionFee: v[F.collectionFee], gstOnFees: gstOnFees, gstRetained9_5: v[F.gst], tds: v[F.tds],
        ads: ads, refundsAndCancellations: refunds, otherDeductions: v[F.otherFees] + unclassified,
        otherDeductionsDetail: { platformFees: v[F.otherFees], unclassified: unclassified }
      };
      l.netPayout = l.netBillValue - l.serviceFee - l.collectionFee - l.gstOnFees - l.tds - l.ads - l.refundsAndCancellations - l.otherDeductions;
      return l;
    }

    for (a = 0; a < NA; a++) {
      var tm = terms[a], channelId = aggIds[a];
      for (o = 0; o < NO; o++) {
        var prevNet = null, usualAdsShares = [];   /* ads share of menu value of the settled cycles that did not trip the spike rule */
        for (var ci = 0; ci < cyc[a].cycles.length; ci++) {
          var cy = cyc[a].cycles[ci], v = cycAcc[a].subarray((ci * NO + o) * NF, (ci * NO + o + 1) * NF);
          if (v[F.orders] === 0) continue;
          var pid = payoutId(channelId, outlets[o].id, cy.from), prng = MK.rng(seed + '|payout|' + pid);
          var adsMult = 1, unclassified = 0, dispute = null;
          for (var xi = 0; xi < cfg.channelExceptions.length; xi++) {
            var ex = cfg.channelExceptions[xi];
            if (ex.channelId !== channelId || ex.outletId !== outlets[o].id) continue;
            if (ex.kind === 'ads_multiplier' && cy.from >= ex.from && cy.from <= ex.to) adsMult *= ex.mult;
            if (ex.kind === 'unclassified_deduction' && cy.from === ex.from && cy.settled) {
              unclassified += ex.amount;
              if (ex.disputeRaisedOn) dispute = { raisedOn: ex.disputeRaisedOn, amount: ex.amount, status: 'OPEN', label: ex.label };
            }
          }
          var adsNoise = 1 + prng.range(-cfg.aggregatorAds.cycleNoise, cfg.aggregatorAds.cycleNoise), refundNoise = prng.range(0.6, 1.4);
          var refundBase = prevNet === null ? v[F.netSales] : prevNet;
          var rec = {
            id: pid, outletId: outlets[o].id, channelId: channelId, cycleIndex: ci,
            period: { from: cy.from, to: cy.to, label: D.label(cy.from, 'd MMM') + ' - ' + D.label(cy.to, 'd MMM') },
            partial: cy.partial, orderCount: v[F.orders], settlementDate: cy.settlementDate,
            /* source = where the figures on this row come from; statementSource = the report that settles (or will settle) the cycle */
            source: cy.settled ? tm.statementSource : 'estimate', statementSource: tm.statementSource,
            utr: null, status: null, reasons: [], statement: null, expected: null, variance: null, dispute: null, estimated: !cy.settled
          };
          if (cy.settled) {
            var ads = Math.round(cfg.aggregatorAds.pctOfMenuValue[outlets[o].id] * adsNoise * adsMult * v[F.grossValue]);
            var refunds = Math.round(tm.refundsPctOfNet * refundBase * refundNoise);
            rec.statement = linesFrom(v, v[F.serviceFee], v[F.gstOnFees], ads, refunds, unclassified);
            rec.expected = linesFrom(v, v[F.serviceFeeContract], v[F.gstOnFeesContract], ads, refunds, 0);
            rec.variance = rec.expected.netPayout - rec.statement.netPayout;
            var jd = D.diffDays(cy.settlementDate.slice(0, 4) + '-01-01', cy.settlementDate) + 1;
            rec.utr = tm.utrPrefix + cy.settlementDate.slice(2, 4) + pad(jd, 3) + pad(prng.int(0, 999999), 6);
            var overCharge = (v[F.serviceFee] - v[F.serviceFeeContract]) + (v[F.gstOnFees] - v[F.gstOnFeesContract]);
            if (overCharge > rules.payoutToleranceRs) {
              rec.reasons.push({ code: 'COMMISSION_RATE_ABOVE_CONTRACT', amount: overCharge, chargedPct: rec.statement.serviceFeePct, contractPct: rec.expected.serviceFeePct,
                detail: 'Service fee charged above the contracted rate (fee difference plus GST on it)' });
            }
            if (unclassified > 0) rec.reasons.push({ code: 'UNCLASSIFIED_DEDUCTION', amount: unclassified, detail: 'Deduction on the statement with no classification - to be disputed' });
            rec.dispute = dispute;
            rec.status = Math.abs(rec.variance) <= rules.payoutToleranceRs ? 'MATCHED' : (dispute ? 'DISPUTED' : 'SHORT_PAID');
            /* a cycle the audit rule would flag as an ads spike says nothing about the usual spend: keep it out of the trailing window */
            var thisShare = ads / v[F.grossValue], usual = usualAdsShares.slice(-rules.adsTrailingCycles);
            if (usual.length < 2 || thisShare <= rules.adsSpikeRatio * median(usual)) usualAdsShares.push(thisShare);
          } else {
            /* No statement yet: estimate at contract terms; ads at the median share of the last unflagged settled cycles
             * (the planned share when fewer than two exist), refunds at the contract assumption. */
            var tail = usualAdsShares.slice(-rules.adsTrailingCycles), adsShare = cfg.aggregatorAds.pctOfMenuValue[outlets[o].id];
            if (tail.length >= 2) adsShare = median(tail);
            rec.expected = linesFrom(v, v[F.serviceFeeContract], v[F.gstOnFeesContract], Math.round(adsShare * v[F.grossValue]), Math.round(tm.refundsPctOfNet * refundBase), 0);
            rec.status = cy.unsettledStatus;
          }
          prevNet = v[F.netSales];
          payouts.push(rec); payoutById[pid] = rec;

          /* spread the cycle-level amounts over the cells (business day, part of day) that fall in this cycle */
          var used = rec.statement || rec.expected, c0 = Math.max(0, D.diffDays(cfg.dataStart, cy.from)), c1 = Math.min(ND, D.diffDays(cfg.dataStart, cy.to));
          var cellIdx = [], cellWeight = [];
          for (var c = c0; c <= c1; c++) {
            for (var part3 = 0; part3 < 2; part3++) {
              var dd = c - part3;
              if (dd < 0 || dd >= ND) continue;
              var ix = ((dd * NO + o) * NA + a) * 2 + part3;
              if (feeCube[ix * NF + F.grossValue] > 0) { cellIdx.push(ix); cellWeight.push(feeCube[ix * NF + F.grossValue]); }
            }
          }
          allocate(allocAds, used.ads, cellIdx, cellWeight, v[F.grossValue]);
          allocate(allocRefunds, used.refundsAndCancellations, cellIdx, cellWeight, v[F.grossValue]);
          allocate(allocUnclassified, used.otherDeductionsDetail.unclassified, cellIdx, cellWeight, v[F.grossValue]);
        }
      }
    }

    /* ---- day cube (hours summed) and monthly roll-ups ---- */
    var dayCube = new Int32Array(ND * NO * NS * NM);
    var monthCube = new Float64Array(NMO * NO * NS * NM);
    var monthDishQty = new Float64Array(NMO * NO * NS * NDI);
    var dishDayCube = new Int32Array(ND * NO * NS * NDI * NDM); /* dish cube with the slots summed */
    for (d = 0; d < ND; d++) for (o = 0; o < NO; o++) for (s = 0; s < NS; s++) {
      var dc = ((d * NO + o) * NS + s) * NM, mc = ((dayMonth[d] * NO + o) * NS + s) * NM, m;
      for (h = 0; h < H; h++) { var hc = (((d * NO + o) * NS + s) * H + h) * NM; for (m = 0; m < NM; m++) dayCube[dc + m] += hourCube[hc + m]; }
      for (m = 0; m < NM; m++) monthCube[mc + m] += dayCube[dc + m];
      for (var d4 = 0; d4 < NDI; d4++) {
        var dd4 = ((((d * NO + o) * NS + s) * NDI) + d4) * NDM;
        for (var s4 = 0; s4 < SL; s4++) {
          var sd4 = (((((d * NO + o) * NS + s) * SL + s4) * NDI) + d4) * NDM;
          for (m = 0; m < NDM; m++) dishDayCube[dd4 + m] += dishCube[sd4 + m];
        }
        monthDishQty[((dayMonth[d] * NO + o) * NS + s) * NDI + d4] += dishDayCube[dd4 + DM.qty];
      }
    }

    /* is the fee-cube cell covered by a settled statement? 1 = actual, 0 = estimated */
    var cellSettled = new Uint8Array(ND * NA * 2);
    for (d = 0; d < ND; d++) for (a = 0; a < NA; a++) for (var p5 = 0; p5 < 2; p5++) cellSettled[(d * NA + a) * 2 + p5] = cyc[a].cycles[cyc[a].cycleOfCal[d + p5]].settled ? 1 : 0;

    var checksum = 2166136261 >>> 0;
    for (i = 0; i < dayCube.length; i++) { checksum ^= dayCube[i]; checksum = Math.imul(checksum, 16777619) >>> 0; }
    for (i = 0; i < payouts.length; i++) { checksum ^= (payouts[i].statement || payouts[i].expected).netPayout; checksum = Math.imul(checksum, 16777619) >>> 0; }

    /* newest first by the calendar time the order was placed */
    recent.sort(function (x, y) { return x.placedAt < y.placedAt ? 1 : x.placedAt > y.placedAt ? -1 : (x.posRef < y.posRef ? 1 : -1); });

    var db = {
      ready: true, checksum: checksum >>> 0,
      days: days, calDates: calDates, dayDow: dayDow, dayMonth: dayMonth, monthKeys: monthKeys,
      outletIds: outlets.map(function (x) { return x.id; }), streamIds: streams.map(function (x) { return x.id; }),
      dishIds: dishes.map(function (x) { return x.id; }), aggregatorIds: aggIds,
      dims: { ND: ND, NO: NO, NS: NS, H: H, SL: SL, NDI: NDI, NA: NA, NMO: NMO, NM: NM, NDM: NDM, NF: NF, HOUR0: HOUR0 },
      M: M, DM: DM, F: F,
      index: { day: dayIndex, outlet: outletIndex, stream: streamIndex, dish: dishIndex, aggregator: aggIndex },
      hourCube: hourCube, dayCube: dayCube, dishCube: dishCube, dishDayCube: dishDayCube, feeCube: feeCube, cellSettled: cellSettled,
      alloc: { ads: allocAds, refunds: allocRefunds, unclassified: allocUnclassified },
      monthCube: monthCube, monthDishQty: monthDishQty, paymentMix: paymentMix,
      cycles: { swiggy: cyc[aggIndex.swiggy].cycles, zomato: cyc[aggIndex.zomato].cycles },
      payouts: payouts, payoutById: payoutById,
      recentOrders: recent, recentFrom: days[recentFrom], recentTo: days[ND - 1],
      priceTable: price
    };
    attachAccessors(db);
    return db;
  }

  /* ------------------------------------------------ internal raw accessors */
  /* Unscoped helpers for the finance, factory and seed layers. Ids in, plain numbers out; unknown ids give 0. */

  function attachAccessors(db) {
    var dm = db.dims, ix = db.index;
    function has(map, id) { return Object.prototype.hasOwnProperty.call(map, id); }

    db.dayIdx = function (iso) { return has(ix.day, iso) ? ix.day[iso] : -1; };
    db.monthIdx = function (monthKey) { return db.monthKeys.indexOf(monthKey); };

    /** One measure of the day cube by indices. measure is a key of db.M. */
    db.dayMeasure = function (dayIdx, outletIdx, streamIdx, measure) {
      return db.dayCube[((dayIdx * dm.NO + outletIdx) * dm.NS + streamIdx) * dm.NM + db.M[measure]];
    };

    /** Portions of a dish sold on a business day at an outlet on a stream (all slots). */
    db.dishQty = function (dayIdx, outletIdx, streamIdx, dishIdx) {
      return db.dishDayCube[((((dayIdx * dm.NO + outletIdx) * dm.NS + streamIdx) * dm.NDI) + dishIdx) * dm.NDM + db.DM.qty];
    };

    /** Portions of a dish sold in a month. streamId null = all streams. */
    db.monthlyDishQty = function (monthKey, outletId, streamId, dishId) {
      var m = db.monthIdx(monthKey);
      if (m < 0 || !has(ix.outlet, outletId) || !has(ix.dish, dishId)) return 0;
      var t = 0;
      for (var s = 0; s < dm.NS; s++) {
        if (streamId && db.streamIds[s] !== streamId) continue;
        t += db.monthDishQty[((m * dm.NO + ix.outlet[outletId]) * dm.NS + s) * dm.NDI + ix.dish[dishId]];
      }
      return t;
    };

    /** A day-cube measure summed over a month. outletId null = all outlets, streamId null = all streams. */
    db.monthlyMeasure = function (monthKey, outletId, streamId, measure) {
      var m = db.monthIdx(monthKey), mi = db.M[measure];
      if (m < 0 || mi === undefined) return 0;
      var t = 0;
      for (var o = 0; o < dm.NO; o++) {
        if (outletId && db.outletIds[o] !== outletId) continue;
        for (var s = 0; s < dm.NS; s++) {
          if (streamId && db.streamIds[s] !== streamId) continue;
          t += db.monthCube[((m * dm.NO + o) * dm.NS + s) * dm.NM + mi];
        }
      }
      return t;
    };

    /**
     * Aggregator charges on the orders of a month (business-day month), split by whether a settled
     * statement covers them. Cycle-level ads / refunds / unclassified deductions are the whole-rupee
     * pro-rata share of each cycle (MK.db.alloc), so months add up to the statements. channelId null = both aggregators.
     */
    db.feesByMonth = function (monthKey, outletId, channelId) {
      var m = db.monthIdx(monthKey), F = db.F, keys = ['orders', 'grossValue', 'discount', 'netSales', 'gst', 'serviceFee', 'serviceFeeContract', 'collectionFee', 'otherFees', 'gstOnFees', 'tds'];
      function blank() { var b = { ads: 0, refunds: 0, unclassified: 0 }; keys.forEach(function (k) { b[k] = 0; }); return b; }
      var out = { actual: blank(), estimated: blank(), total: null };
      if (m >= 0) {
        for (var d = 0; d < dm.ND; d++) {
          if (db.dayMonth[d] !== m) continue;
          for (var o = 0; o < dm.NO; o++) {
            if (outletId && db.outletIds[o] !== outletId) continue;
            for (var a = 0; a < dm.NA; a++) {
              if (channelId && db.aggregatorIds[a] !== channelId) continue;
              for (var p = 0; p < 2; p++) {
                var cell = ((d * dm.NO + o) * dm.NA + a) * 2 + p, tgt = db.cellSettled[(d * dm.NA + a) * 2 + p] ? out.actual : out.estimated;
                for (var k = 0; k < keys.length; k++) tgt[keys[k]] += db.feeCube[cell * dm.NF + F[keys[k]]];
                tgt.ads += db.alloc.ads[cell]; tgt.refunds += db.alloc.refunds[cell]; tgt.unclassified += db.alloc.unclassified[cell];
              }
            }
          }
        }
      }
      out.total = blank();
      Object.keys(out.total).forEach(function (k) { out.total[k] = out.actual[k] + out.estimated[k]; });
      return out;
    };

    /** In-store receipts (net sales + GST) of a month by tender. outletId null = all outlets. */
    db.paymentMixByMonth = function (monthKey, outletId) {
      var m = db.monthIdx(monthKey), out = { upi: 0, card: 0, cash: 0 };
      if (m < 0) return out;
      for (var o = 0; o < dm.NO; o++) {
        if (outletId && db.outletIds[o] !== outletId) continue;
        var b = (m * dm.NO + o) * 3;
        out.upi += db.paymentMix[b]; out.card += db.paymentMix[b + 1]; out.cash += db.paymentMix[b + 2];
      }
      return out;
    };

    /** Menu price in force: list 'pos' | 'agg'. 0 when the dish is not sold at the outlet. */
    db.priceOn = function (dayIdx, outletIdx, list, dishIdx) {
      return db.priceTable[((dayIdx * dm.NO + outletIdx) * 2 + (list === 'agg' ? 1 : 0)) * dm.NDI + dishIdx];
    };
  }

  /* --------------------------------------------------------------------- run */

  /** Builds MK.db once. A second call is a no-op unless { force: true }. Returns MK.db. */
  engine.run = function (opts) {
    if (engine.ready && MK.db && !(opts && opts.force)) return MK.db;
    if (!MK.config) throw new Error('MK.config is not loaded');
    MK.db = build(MK.config);
    engine.ready = true;
    return MK.db;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.MK;
})(typeof window !== 'undefined' ? window : globalThis);
