/*
 * MK.data - public, SCOPED sales selectors over MK.db (docs/SPEC.md 6.4, docs/API-sales.md).
 * Every selector resolves the filter at call time and intersects the requested outlets with
 * MK.session.allowedOutletIds(), so a persona switch re-scopes every number. Nothing scoped is cached.
 * Filter: f = { from, to, outletIds, channelIds, mediumIds } - ISO dates; null / missing / [] = all.
 * Unknown ids are ignored; a scope that ends up empty gives zeroed results; selectors never throw.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});
  var data = MK.data || (MK.data = {});
  var D = MK.dates;

  /* base measures accumulated per group; derived measures are computed from these */
  /* gstOwn / gstMemo split the GST of a group by who collects it: the restaurant (in-store) or the aggregator (memo, section 9(5)) */
  var B = { orders: 0, cancelled: 1, cancelledValue: 2, grossItemValue: 3, packaging: 4, discount: 5, netSales: 6, gst: 7, items: 8, qty: 9, gstOwn: 10, gstMemo: 11 };
  var NB = 12;
  var MEASURES = ['orders', 'netSales', 'grossSales', 'aov', 'items', 'itemsPerOrder', 'restaurantDiscount', 'discountPct', 'cancelled', 'cancelRate', 'qty',
    'gstCollectedByRestaurant', 'gstMemoAggregator'];
  var DISH_MEASURES = ['qty', 'netSales', 'grossSales', 'orders'];
  var DIMS = ['outlet', 'city', 'channel', 'medium', 'stream', 'slot', 'hour', 'dow', 'dish', 'category', 'day', 'week', 'month'];

  function db() {
    if (!MK.db && MK.engine && typeof MK.engine.run === 'function') { try { MK.engine.run(); } catch (e) { return null; } }
    return MK.db || null;
  }
  function ratio(a, b) { return b > 0 ? a / b : 0; }
  function isIso(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  /* an id list of the filter: an array, or a single id given as a string; null / [] / anything else = all */
  function list(v) { return typeof v === 'string' && v ? [v] : (Array.isArray(v) && v.length ? v : null); }

  /* ------------------------------------------------------------------ scope */

  /** Filter -> day range, outlet indices (persona-scoped) and stream indices. Never throws. */
  function resolve(f) {
    var d = db(), cfg = MK.config;
    f = f || {};
    var start = cfg ? cfg.dataStart : MK.calendar.dataStart, end = cfg ? cfg.dataEnd : MK.calendar.dataEnd;
    var from = isIso(f.from) ? f.from : start, to = isIso(f.to) ? f.to : end;
    if (from > to) { var t = from; from = to; to = t; }
    /* both ends are clamped into the data, so the echoed range never crosses even when the request lies wholly outside it (empty stays true then) */
    var sc = { db: d, from: D.min(D.max(from, start), end), to: D.max(D.min(to, end), start), d0: 0, d1: -1, outlets: [], streams: [], aggs: [], empty: true };
    if (!d || !cfg || from > end || to < start) return sc;
    sc.d0 = d.dayIdx(sc.from); sc.d1 = d.dayIdx(sc.to);
    var allowed = MK.session.allowedOutletIds(), wantO = list(f.outletIds), wantC = list(f.channelIds), wantM = list(f.mediumIds);
    d.outletIds.forEach(function (id, i) { if (allowed.indexOf(id) !== -1 && (!wantO || wantO.indexOf(id) !== -1)) sc.outlets.push(i); });
    cfg.streams.forEach(function (s, i) {
      if ((wantC && wantC.indexOf(s.channelId) === -1) || (wantM && wantM.indexOf(s.mediumId) === -1)) return;
      sc.streams.push(i);
      var a = d.aggregatorIds.indexOf(s.channelId);
      if (a !== -1) sc.aggs.push(a);
    });
    sc.empty = !(sc.outlets.length && sc.streams.length && sc.d1 >= sc.d0);
    return sc;
  }

  /** The equal-length period immediately before [from, to], clipped to dataStart. */
  function prevRange(sc) {
    var n = D.diffDays(sc.from, sc.to) + 1, start = MK.config.dataStart;
    var to = D.addDays(sc.from, -1), from = D.addDays(sc.from, -n);
    if (to < start) return { from: null, to: null, days: 0, complete: false };
    return { from: D.max(from, start), to: to, days: D.diffDays(D.max(from, start), to) + 1, complete: from >= start };
  }
  function withRange(sc, r) {
    var c = {}; Object.keys(sc).forEach(function (k) { c[k] = sc[k]; });
    if (!r.from) { c.empty = true; c.d0 = 0; c.d1 = -1; return c; }
    c.from = r.from; c.to = r.to; c.d0 = sc.db.dayIdx(r.from); c.d1 = sc.db.dayIdx(r.to);
    c.empty = !(sc.db && sc.outlets.length && sc.streams.length && c.d1 >= c.d0);
    return c;
  }

  /* ------------------------------------------------------------- dimensions */
  /*
   * A dimension maps one cube axis to group positions. axis: 'day' | 'outlet' | 'stream' | 'hour' | 'dish'.
   * map[i] = group position of axis index i (or -1 to skip). 'slot' works on the hour axis of the hour
   * cube and on the slot axis of the dish cube; 'hour' cannot be combined with dish dimensions.
   */
  function dimension(name, sc) {
    var cfg = MK.config, d = sc.db, keys = [], map, i;
    function keyed(axis, size, entries, keyOf) {
      var pos = {}, m = new Int32Array(size).fill(-1);
      entries.forEach(function (e) {
        var k = keyOf(e.item);
        if (!k) return;
        if (pos[k.id] === undefined) { pos[k.id] = keys.length; keys.push(k); }
        m[e.index] = pos[k.id];
      });
      return { name: name, axis: axis, keys: keys, map: m };
    }
    var outletCfg = function (idx) { return cfg.outlets.filter(function (o) { return o.id === d.outletIds[idx]; })[0]; };
    var scopedOutlets = sc.outlets.map(function (idx) { return { index: idx, item: outletCfg(idx) }; });
    var scopedStreams = sc.streams.map(function (idx) { return { index: idx, item: cfg.streams[idx] }; });
    function byId(arr, id) { for (var j = 0; j < arr.length; j++) if (arr[j].id === id) return arr[j]; return null; }

    switch (name) {
      case 'outlet': return keyed('outlet', d.dims.NO, scopedOutlets, function (o) { return { id: o.id, label: o.name, short: o.short, colourVar: o.colourVar }; });
      case 'city': return keyed('outlet', d.dims.NO, scopedOutlets, function (o) { var r = cfg.regions.filter(function (x) { return x.label === o.region; })[0]; return { id: r.id, label: r.label, colourVar: null }; });
      case 'channel': return keyed('stream', d.dims.NS, scopedStreams, function (s) { var c = byId(cfg.channels, s.channelId); return { id: c.id, label: c.label, colourVar: c.colourVar }; });
      case 'medium': return keyed('stream', d.dims.NS, scopedStreams, function (s) { var m = byId(cfg.mediums, s.mediumId); return { id: m.id, label: m.label, colourVar: m.colourVar }; });
      case 'stream': return keyed('stream', d.dims.NS, scopedStreams, function (s) { return { id: s.id, label: s.label, colourVar: s.colourVar }; });
      case 'hour':
        return keyed('hour', d.dims.H, cfg.hours.map(function (h, idx) { return { index: idx, item: h }; }), function (h) { return { id: String(h.hour), label: h.label, hour: h.hour, slotId: h.slotId, colourVar: null }; });
      case 'slot':
        var dim = keyed('hour', d.dims.H, cfg.hours.map(function (h, idx) { return { index: idx, item: h }; }), function (h) { var s = byId(cfg.slots, h.slotId); return { id: s.id, label: s.label, range: s.range, colourVar: null }; });
        dim.slotAxis = true;
        return dim;
      case 'dow':
        map = new Int32Array(d.dims.ND);
        for (i = 0; i < d.dims.ND; i++) map[i] = d.dayDow[i];
        return { name: name, axis: 'day', keys: D.DOWS.map(function (l, j) { return { id: String(j), label: l, colourVar: null }; }), map: map };
      case 'dish':
      case 'category':
        var soldSomewhere = cfg.dishes.map(function (dish, idx) { return { index: idx, item: dish }; }).filter(function (e) {
          return sc.outlets.some(function (o) { return data.dishSoldAt(e.item.id, d.outletIds[o]); });
        });
        return keyed('dish', d.dims.NDI, soldSomewhere, name === 'dish'
          ? function (x) { return { id: x.id, label: x.name, short: x.short, category: x.category, veg: x.veg, colourVar: null }; }
          : function (x) { var c = byId(cfg.categories, x.category); return { id: c.id, label: c.label, colourVar: null }; });
      case 'day':
      case 'week':
      case 'month':
        map = new Int32Array(d.dims.ND).fill(-1);
        var pos = {};
        for (i = sc.d0; i <= sc.d1; i++) {
          var iso = d.days[i], k = name === 'day' ? iso : name === 'week' ? D.weekStart(iso) : D.monthKey(iso);
          if (pos[k] === undefined) {
            pos[k] = keys.length;
            keys.push({ id: k, key: k, from: iso, to: iso, label: name === 'month' ? D.monthLabel(k, true) : D.label(iso, 'd MMM'), colourVar: null });
          }
          keys[pos[k]].to = iso;
          map[i] = pos[k];
        }
        if (name === 'week') keys.forEach(function (w) { w.label = D.label(w.from, 'd MMM') + ' - ' + D.label(w.to, 'd MMM'); });
        return { name: name, axis: 'day', keys: keys, map: map };
      default: return null;
    }
  }

  /* -------------------------------------------------------------- accumulate */
  /*
   * Group position of a cell = sum of the five axis maps of a dimension; the maps of the axes a
   * dimension does not use are all zero, so every kernel below runs one uniform, branch-free body
   * (small monomorphic loops keep the JIT from bouncing between optimised and interpreted code).
   */
  var FIRST_HOUR_OF_SLOT = [0, 4, 7, 11];

  function axisMaps(dim, dm) {
    var m = { day: new Int32Array(dm.ND), outlet: new Int32Array(dm.NO), stream: new Int32Array(dm.NS), hour: new Int32Array(dm.H), dish: new Int32Array(dm.NDI), slot: new Int32Array(dm.SL) };
    if (!dim) return m;
    var target = m[dim.axis];
    for (var i = 0; i < target.length; i++) target[i] = dim.map[i] < 0 ? 0 : dim.map[i];   /* skipped members hold zeros only */
    if (dim.axis === 'hour' && dim.slotAxis) for (var s = 0; s < dm.SL; s++) m.slot[s] = dim.map[FIRST_HOUR_OF_SLOT[s]];
    return m;
  }

  var CUBE_GST = 7;   /* offset of gst in the hour and day cubes (MK.db.M.gst) */

  function accDay(v, cube, d0, d1, outlets, streams, NO, NS, NM, R, C, nCol, gstSlot) {
    for (var day = d0; day <= d1; day++) for (var oi = 0; oi < outlets.length; oi++) for (var si = 0; si < streams.length; si++) {
      var o = outlets[oi], s = streams[si];
      var g = ((R.day[day] + R.outlet[o] + R.stream[s]) * nCol + C.day[day] + C.outlet[o] + C.stream[s]) * NB, base = ((day * NO + o) * NS + s) * NM;
      for (var b = 0; b < NM; b++) v[g + b] += cube[base + b];
      v[g + gstSlot[s]] += cube[base + CUBE_GST];
    }
  }

  function accHour(v, cube, d0, d1, outlets, streams, NO, NS, H, NM, R, C, nCol, gstSlot) {
    for (var day = d0; day <= d1; day++) for (var oi = 0; oi < outlets.length; oi++) for (var si = 0; si < streams.length; si++) {
      var o = outlets[oi], s = streams[si], r = R.day[day] + R.outlet[o] + R.stream[s], c = C.day[day] + C.outlet[o] + C.stream[s], slot = gstSlot[s];
      for (var h = 0; h < H; h++) {
        var g = ((r + R.hour[h]) * nCol + c + C.hour[h]) * NB, base = (((day * NO + o) * NS + s) * H + h) * NM;
        for (var b = 0; b < NM; b++) v[g + b] += cube[base + b];
        v[g + slot] += cube[base + CUBE_GST];
      }
    }
  }

  /* dish cubes carry qty, gross, net, lines at offsets 0..3 (MK.db.DM) -> qty (and items), grossItemValue, netSales, orders */
  var B_QTY = B.qty, B_ITEMS = B.items, B_GROSS = B.grossItemValue, B_NET = B.netSales, B_ORDERS = B.orders;

  function accDish(v, cube, d0, d1, outlets, streams, NO, NS, NDI, NDM, R, C, nCol) {
    for (var day = d0; day <= d1; day++) for (var oi = 0; oi < outlets.length; oi++) for (var si = 0; si < streams.length; si++) {
      var o = outlets[oi], s = streams[si], r = R.day[day] + R.outlet[o] + R.stream[s], c = C.day[day] + C.outlet[o] + C.stream[s];
      for (var di = 0; di < NDI; di++) {
        var g = ((r + R.dish[di]) * nCol + c + C.dish[di]) * NB, base = ((((day * NO + o) * NS + s) * NDI) + di) * NDM;
        v[g + B_QTY] += cube[base]; v[g + B_ITEMS] += cube[base]; v[g + B_GROSS] += cube[base + 1]; v[g + B_NET] += cube[base + 2]; v[g + B_ORDERS] += cube[base + 3];
      }
    }
  }

  function accDishSlot(v, cube, d0, d1, outlets, streams, NO, NS, SL, NDI, NDM, R, C, nCol) {
    for (var day = d0; day <= d1; day++) for (var oi = 0; oi < outlets.length; oi++) for (var si = 0; si < streams.length; si++) {
      var o = outlets[oi], s = streams[si], r = R.day[day] + R.outlet[o] + R.stream[s], c = C.day[day] + C.outlet[o] + C.stream[s];
      for (var sl = 0; sl < SL; sl++) for (var di = 0; di < NDI; di++) {
        var g = ((r + R.slot[sl] + R.dish[di]) * nCol + c + C.slot[sl] + C.dish[di]) * NB, base = (((((day * NO + o) * NS + s) * SL + sl) * NDI) + di) * NDM;
        v[g + B_QTY] += cube[base]; v[g + B_ITEMS] += cube[base]; v[g + B_GROSS] += cube[base + 1]; v[g + B_NET] += cube[base + 2]; v[g + B_ORDERS] += cube[base + 3];
      }
    }
  }

  /**
   * Sums the base measures into values[(row * nCol + col) * NB + b] for up to two dimensions,
   * using the cheapest cube that carries every requested axis (day, hour, dish or dish x slot).
   */
  function accumulate(sc, rowDim, colDim) {
    var d = sc.db, dm = d.dims, nRow = rowDim ? rowDim.keys.length : 1, nCol = colDim ? colDim.keys.length : 1;
    var out = { values: new Float64Array(Math.max(1, nRow * nCol) * NB), nRow: nRow, nCol: nCol, cube: 'day', supported: true };
    var dims = [rowDim, colDim].filter(Boolean);
    var needDish = dims.some(function (x) { return x.axis === 'dish'; }), needHour = dims.some(function (x) { return x.axis === 'hour'; });
    if (needDish && dims.some(function (x) { return x.axis === 'hour' && !x.slotAxis; })) { out.supported = false; return out; }
    out.cube = needDish ? (needHour ? 'dishSlot' : 'dish') : needHour ? 'hour' : 'day';
    if (sc.empty || !nRow || !nCol) return out;
    var R = axisMaps(rowDim, dm), C = axisMaps(colDim, dm), v = out.values;
    /* which base slot the GST of a stream belongs to: collected by the restaurant, or a memo of the aggregator */
    var gstSlot = new Int32Array(dm.NS);
    for (var s = 0; s < dm.NS; s++) gstSlot[s] = d.aggregatorIds.indexOf(MK.config.streams[s].channelId) === -1 ? B.gstOwn : B.gstMemo;
    if (out.cube === 'day') accDay(v, d.dayCube, sc.d0, sc.d1, sc.outlets, sc.streams, dm.NO, dm.NS, dm.NM, R, C, nCol, gstSlot);
    else if (out.cube === 'hour') accHour(v, d.hourCube, sc.d0, sc.d1, sc.outlets, sc.streams, dm.NO, dm.NS, dm.H, dm.NM, R, C, nCol, gstSlot);
    else if (out.cube === 'dish') accDish(v, d.dishDayCube, sc.d0, sc.d1, sc.outlets, sc.streams, dm.NO, dm.NS, dm.NDI, dm.NDM, R, C, nCol);
    else accDishSlot(v, d.dishCube, sc.d0, sc.d1, sc.outlets, sc.streams, dm.NO, dm.NS, dm.SL, dm.NDI, dm.NDM, R, C, nCol);
    return out;
  }

  /** Every measure for the base vector starting at offset g. dishLevel limits what is meaningful. */
  function measuresOf(v, g, dishLevel) {
    var orders = v[g + B.orders], gross = v[g + B.grossItemValue] + v[g + B.packaging], net = v[g + B.netSales];
    if (dishLevel) return { qty: v[g + B.qty], netSales: net, grossSales: v[g + B.grossItemValue], orders: orders };
    return {
      orders: orders, netSales: net, grossSales: gross, grossItemValue: v[g + B.grossItemValue], packaging: v[g + B.packaging],
      restaurantDiscount: v[g + B.discount], discountPct: ratio(v[g + B.discount], gross),
      /* gst = the two parts that follow; only gstCollectedByRestaurant is payable by the restaurant - never label 'gst' alone as payable */
      gst: v[g + B.gst], gstCollectedByRestaurant: v[g + B.gstOwn], gstMemoAggregator: v[g + B.gstMemo],
      aov: ratio(net, orders), items: v[g + B.items], itemsPerOrder: ratio(v[g + B.items], orders),
      cancelled: v[g + B.cancelled], cancelledValue: v[g + B.cancelledValue], cancelRate: ratio(v[g + B.cancelled], orders + v[g + B.cancelled])
    };
  }
  function measureValue(v, g, measure, dishLevel) {
    var m = measuresOf(v, g, dishLevel);
    return Object.prototype.hasOwnProperty.call(m, measure) ? m[measure] : null;
  }
  /** Sum of base vectors over a set of group offsets. */
  function sumGroups(v, offsets) {
    var t = new Float64Array(NB);
    for (var i = 0; i < offsets.length; i++) for (var b = 0; b < NB; b++) t[b] += v[offsets[i] + b];
    return t;
  }

  /* ------------------------------------------------------------------ summary */

  function totalsOf(sc) {
    var acc = sc.db ? accumulate(sc, null, null) : { values: new Float64Array(NB) };
    /* the GST split is part of every measure set: in-store GST is collected by the restaurant and payable, aggregator GST is a memo (section 9(5)) */
    var m = measuresOf(acc.values, 0, false), days = sc.empty ? 0 : sc.d1 - sc.d0 + 1;
    m.from = sc.from; m.to = sc.to; m.days = days;
    m.ordersPerDay = ratio(m.orders, days); m.netSalesPerDay = ratio(m.netSales, days);
    return m;
  }

  /**
   * Swiggy relays one unsplit discount total; its restaurant-funded share is confirmed only by the payout annexure
   * (capability order.discountRestaurantFunded = partial). The model has no platform-funded discounts, so the figures stand,
   * but a range that runs past the last settled Swiggy date is provisional on that point: { swiggyDiscountSplitFrom, note } or null.
   */
  function provisionalOf(sc) {
    var cfg = MK.config, t = cfg && cfg.channelTerms ? cfg.channelTerms.swiggy : null;
    if (!t || !sc.db || sc.empty || sc.to <= t.settledThrough) return null;
    if (!sc.streams.some(function (si) { return cfg.streams[si].channelId === 'swiggy'; })) return null;
    return { swiggyDiscountSplitFrom: D.max(sc.from, D.addDays(t.settledThrough, 1)),
      note: 'Swiggy restaurant-funded discount and net sales from this date are as relayed to the POS; the discount split is confirmed with the payout annexure' };
  }

  /**
   * Headline measures for the filter, plus the same measures for the immediately preceding
   * equal-length period under prev (clipped to dataStart; prev.complete says whether it was clipped).
   */
  data.summary = function (f) {
    var sc = resolve(f), out = totalsOf(sc), pr = sc.db ? prevRange(sc) : { from: null, to: null, days: 0, complete: false };
    var prev = totalsOf(sc.db ? withRange(sc, pr) : sc);
    prev.from = pr.from; prev.to = pr.to; prev.days = pr.days; prev.complete = pr.complete;
    out.prev = prev;
    out.source = 'petpooja';
    out.provisional = provisionalOf(sc);
    return out;
  };

  /* ------------------------------------------------------------------- series */

  /**
   * series(f, { measure, grain, by }) - grain 'day' | 'week' | 'month' (weeks start on Monday);
   * by null | 'outlet' | 'city' | 'channel' | 'medium' | 'stream'.
   */
  data.series = function (f, opts) {
    opts = opts || {};
    var measure = MEASURES.indexOf(opts.measure) !== -1 ? opts.measure : 'netSales';
    var grain = ['day', 'week', 'month'].indexOf(opts.grain) !== -1 ? opts.grain : 'day';
    var by = ['outlet', 'city', 'channel', 'medium', 'stream'].indexOf(opts.by) !== -1 ? opts.by : null;
    var sc = resolve(f), out = { measure: measure, grain: grain, by: by, from: sc.from, to: sc.to, buckets: [], series: [], total: [], source: 'petpooja', provisional: provisionalOf(sc) };
    if (!sc.db || sc.empty) return out;
    var time = dimension(grain, sc), group = by ? dimension(by, sc) : null;
    var acc = accumulate(sc, group, time), nB = time.keys.length, v = acc.values, r, c;
    out.buckets = time.keys.map(function (k) { return { key: k.key, label: k.label, from: k.from, to: k.to }; });
    for (r = 0; r < (group ? group.keys.length : 0); r++) {
      var vals = [];
      for (c = 0; c < nB; c++) vals.push(measureValue(v, (r * nB + c) * NB, measure, false));
      out.series.push({ id: group.keys[r].id, label: group.keys[r].label, colourVar: group.keys[r].colourVar, values: vals });
    }
    for (c = 0; c < nB; c++) {
      var offs = [];
      for (r = 0; r < acc.nRow; r++) offs.push((r * nB + c) * NB);
      out.total.push(measureValue(sumGroups(v, offs), 0, measure, false));
    }
    if (!group) out.series.push({ id: 'all', label: 'All', colourVar: null, values: out.total.slice() });
    return out;
  };

  /* ---------------------------------------------------------------- breakdown */

  /**
   * breakdown(f, by) - one row per member of the dimension with every measure, its share of net
   * sales and the previous-period net sales and orders. Dish dimensions carry qty, netSales,
   * grossSales and orders (= orders containing the dish) only.
   */
  data.breakdown = function (f, by) {
    var sc = resolve(f), out = { by: by, from: sc.from, to: sc.to, rows: [], total: null, dishLevel: by === 'dish' || by === 'category', source: 'petpooja', provisional: provisionalOf(sc) };
    out.total = totalsOf(sc);
    if (!sc.db || sc.empty || DIMS.indexOf(by) === -1) return out;
    var dim = dimension(by, sc), acc = accumulate(sc, dim, null), v = acc.values;
    var isTime = dim.axis === 'day' && by !== 'dow', prevV = null;
    if (!isTime) {
      var psc = withRange(sc, prevRange(sc));
      if (!psc.empty) prevV = accumulate(psc, dimension(by, psc), null).values;
    }
    dim.keys.forEach(function (k, r) {
      var row = measuresOf(v, r * NB, out.dishLevel);
      Object.keys(k).forEach(function (p) { row[p] = k[p]; });
      row.share = ratio(row.netSales, out.total.netSales);
      row.prevNetSales = prevV ? prevV[r * NB + B.netSales] : null;
      row.prevOrders = prevV ? prevV[r * NB + B.orders] : null;
      out.rows.push(row);
    });
    return out;
  };

  /* ------------------------------------------------------------------- matrix */

  /** matrix(f, rowDim, colDim, measure) - values[r][c], with row, column and grand totals computed from summed bases. */
  data.matrix = function (f, rowName, colName, measure) {
    var sc = resolve(f);
    var out = { rowDim: rowName, colDim: colName, measure: measure, from: sc.from, to: sc.to, rows: [], cols: [], values: [], rowTotals: [], colTotals: [], total: 0, supported: true, source: 'petpooja', provisional: provisionalOf(sc) };
    if (DIMS.indexOf(rowName) === -1 || DIMS.indexOf(colName) === -1 || MEASURES.indexOf(measure) === -1) { out.supported = false; return out; }
    if (!sc.db || sc.empty) return out;
    var rd = dimension(rowName, sc), cd = dimension(colName, sc);
    var dishLevel = rd.axis === 'dish' || cd.axis === 'dish';
    if (dishLevel && DISH_MEASURES.indexOf(measure) === -1) { out.supported = false; return out; }
    var acc = accumulate(sc, rd, cd);
    if (!acc.supported) { out.supported = false; return out; }
    var v = acc.values, nR = rd.keys.length, nC = cd.keys.length, r, c, all = [];
    out.rows = rd.keys; out.cols = cd.keys;
    for (r = 0; r < nR; r++) {
      var line = [], offs = [];
      for (c = 0; c < nC; c++) { line.push(measureValue(v, (r * nC + c) * NB, measure, dishLevel)); offs.push((r * nC + c) * NB); all.push((r * nC + c) * NB); }
      out.values.push(line);
      out.rowTotals.push(measureValue(sumGroups(v, offs), 0, measure, dishLevel));
    }
    for (c = 0; c < nC; c++) {
      var colOffs = [];
      for (r = 0; r < nR; r++) colOffs.push((r * nC + c) * NB);
      out.colTotals.push(measureValue(sumGroups(v, colOffs), 0, measure, dishLevel));
    }
    out.total = measureValue(sumGroups(v, all), 0, measure, dishLevel);
    return out;
  };

  /* ------------------------------------------------------------------- dishes */

  /**
   * Recipe cost of one portion from MK.finance.dishCost(dishId, { outletId, streamId, mediumId, monthKey }):
   * { food, packaging } in rupees, or null. FOOD cost (factory items + local items) is what "food cost %" means everywhere
   * (MK.finance.foodCost, the P&L); per-dish packaging is carried next to it, never inside it. A provider that answers with a
   * plain number is taken to give the food cost.
   */
  function dishCostOf(dishId, ctx) {
    try {
      var c = MK.finance.dishCost(dishId, ctx);
      if (typeof c === 'number') return { food: c, packaging: 0 };
      if (c && typeof c.food === 'number') return { food: c.food, packaging: typeof c.packagingCost === 'number' ? c.packagingCost : 0 };
      if (c && typeof c.cost === 'number') return { food: c.cost, packaging: 0 };
    } catch (e) { /* fall through */ }
    return null;
  }

  /**
   * dishes(f) - dish league table. Cost, contribution and the menu-engineering class are present
   * only when MK.finance.dishCost exists at call time (hasCost says which).
   */
  data.dishes = function (f) {
    var sc = resolve(f), cfg = MK.config;
    var hasCost = !!(MK.finance && typeof MK.finance.dishCost === 'function');
    var RULE = 'Popular = at least 70% of an equal share of portions; profitable = contribution per portion at or above the weighted average';
    var out = { from: sc.from, to: sc.to, rows: [], totals: { qty: 0, netSales: 0, grossSales: 0 }, hasCost: false,
      thresholds: hasCost ? { popularity: 0, contributionPerPortion: 0, rule: RULE } : null, source: 'petpooja', provisional: provisionalOf(sc) };
    if (!sc.db || sc.empty) return out;
    var d = sc.db, dm = d.dims;
    var chanIds = cfg.channels.map(function (c) { return c.id; });
    var rows = cfg.dishes.map(function (dish) {
      var byChannel = {};
      chanIds.forEach(function (c) { byChannel[c] = { qty: 0, netSales: 0 }; });
      return { id: dish.id, name: dish.name, short: dish.short, category: dish.category, veg: dish.veg, isAttach: !!dish.isAttach,
        qty: 0, orders: 0, netSales: 0, grossSales: 0, byChannel: byChannel, cost: 0, pack: 0, costKnown: hasCost };
    });
    /* qty by month x outlet x stream x dish inside the range: the grain at which recipe cost varies */
    var qtyAt = new Float64Array(dm.NMO * dm.NO * dm.NS * dm.NDI);
    for (var day = sc.d0; day <= sc.d1; day++) for (var oi = 0; oi < sc.outlets.length; oi++) for (var si = 0; si < sc.streams.length; si++) {
      var o = sc.outlets[oi], s = sc.streams[si], stream = cfg.streams[s];
      for (var di = 0; di < dm.NDI; di++) {
        var b = ((((day * dm.NO + o) * dm.NS + s) * dm.NDI) + di) * dm.NDM, q = d.dishDayCube[b + d.DM.qty];
        if (!q) continue;
        var net = d.dishDayCube[b + d.DM.net], gross = d.dishDayCube[b + d.DM.gross], lines = d.dishDayCube[b + d.DM.lines];
        var row = rows[di];
        row.qty += q; row.netSales += net; row.grossSales += gross; row.orders += lines;
        row.byChannel[stream.channelId].qty += q; row.byChannel[stream.channelId].netSales += net;
        qtyAt[((d.dayMonth[day] * dm.NO + o) * dm.NS + s) * dm.NDI + di] += q;
      }
    }
    if (hasCost) {
      for (var qi = 0; qi < qtyAt.length; qi++) {
        if (!qtyAt[qi]) continue;
        var dIdx = qi % dm.NDI, sIdx = Math.floor(qi / dm.NDI) % dm.NS, oIdx = Math.floor(qi / (dm.NDI * dm.NS)) % dm.NO, mIdx = Math.floor(qi / (dm.NDI * dm.NS * dm.NO));
        var unit = dishCostOf(rows[dIdx].id, { outletId: d.outletIds[oIdx], streamId: cfg.streams[sIdx].id, mediumId: cfg.streams[sIdx].mediumId, monthKey: d.monthKeys[mIdx] });
        if (unit === null) rows[dIdx].costKnown = false; else { rows[dIdx].cost += unit.food * qtyAt[qi]; rows[dIdx].pack += unit.packaging * qtyAt[qi]; }
      }
    }
    var scopeOutletIds = sc.outlets.map(function (i) { return d.outletIds[i]; });
    rows = rows.filter(function (r) { return scopeOutletIds.some(function (id) { return data.dishSoldAt(r.id, id); }); });
    rows.forEach(function (r) { out.totals.qty += r.qty; out.totals.netSales += r.netSales; out.totals.grossSales += r.grossSales; });
    var withCost = rows.filter(function (r) { return r.costKnown && r.qty > 0; });
    var avgContribution = ratio(withCost.reduce(function (t, r) { return t + (r.netSales - r.cost); }, 0), withCost.reduce(function (t, r) { return t + r.qty; }, 0));
    var fairShare = rows.length ? 1 / rows.length : 0, popularityCut = 0.7 * fairShare;
    rows.forEach(function (r) {
      var prices = {}, counts = {}, best = null;
      scopeOutletIds.forEach(function (id) { var p = data.aggPriceOn(r.id, id, sc.to); if (p !== null) { prices[id] = p; counts[p] = (counts[p] || 0) + 1; } });
      Object.keys(counts).forEach(function (p) { if (best === null || counts[p] > counts[best]) best = p; });
      r.posPrice = data.posPriceOn(r.id, sc.to);
      r.aggPrice = best === null ? null : +best;
      r.aggPriceByOutlet = prices;
      r.markupPct = r.aggPrice === null ? null : r.aggPrice / r.posPrice - 1;
      r.salesShare = ratio(r.netSales, out.totals.netSales);
      r.popularity = ratio(r.qty, out.totals.qty);
      r.avgRealisation = ratio(r.netSales, r.qty);
      if (r.costKnown) {
        /* food cost only (the definition of MK.finance.foodCost); money columns are whole rupees that add up across a row */
        r.theoreticalCost = Math.round(r.cost);
        r.costPerPortion = ratio(r.cost, r.qty);
        r.contribution = r.netSales - r.theoreticalCost;
        r.contributionPerPortion = ratio(r.netSales - r.cost, r.qty);
        r.foodCostPct = ratio(r.cost, r.netSales);
        r.packagingCost = Math.round(r.pack);                 /* per-dish packaging of the delivery and takeaway portions; the per-order bag is not a dish cost */
        r.contributionAfterPackaging = r.contribution - r.packagingCost;
        var popular = r.popularity >= popularityCut, profitable = r.contributionPerPortion >= avgContribution;
        r.menuClass = r.qty === 0 ? null : popular ? (profitable ? 'star' : 'plowhorse') : (profitable ? 'puzzle' : 'dog');
      }
      delete r.cost; delete r.pack; delete r.costKnown;
    });
    rows.sort(function (x, y) { return y.netSales - x.netSales; });
    out.rows = rows;
    out.hasCost = hasCost && withCost.length > 0;
    out.thresholds = out.hasCost ? { popularity: popularityCut, contributionPerPortion: avgContribution, rule: RULE } : null;
    return out;
  };

  /* --------------------------------------------------------- channel economics */

  var FEE_KEYS = ['orders', 'grossValue', 'discount', 'netSales', 'gst', 'feeBase', 'serviceFee', 'serviceFeeContract', 'collectionFee', 'otherFees', 'gstOnFees', 'gstOnFeesContract', 'tds'];

  function feeBlock() { var b = { ads: 0, refunds: 0, unclassified: 0 }; FEE_KEYS.forEach(function (k) { b[k] = 0; }); return b; }

  /** Adds the fee-cube cells of one outlet x aggregator over a day range into blocks.actual / blocks.estimated. */
  function addFees(d, d0, d1, o, a, blocks) {
    var dm = d.dims, F = d.F;
    for (var day = d0; day <= d1; day++) for (var p = 0; p < 2; p++) {
      var cell = ((day * dm.NO + o) * dm.NA + a) * 2 + p, tgt = d.cellSettled[(day * dm.NA + a) * 2 + p] ? blocks.actual : blocks.estimated;
      for (var k = 0; k < FEE_KEYS.length; k++) tgt[FEE_KEYS[k]] += d.feeCube[cell * dm.NF + F[FEE_KEYS[k]]];
      tgt.ads += d.alloc.ads[cell]; tgt.refunds += d.alloc.refunds[cell]; tgt.unclassified += d.alloc.unclassified[cell];
    }
  }

  /**
   * Public shape of one block. Every amount is a sum of whole rupees (cycle-level ads, refunds and unclassified deductions
   * are split over the cells of a cycle in whole rupees by the engine), so channels, outlets and the total tie to the rupee.
   * A block without orders has hasData: false and null for every rate: "no statement (or no estimate) for this period" is
   * not a take rate of 0% and must not be shown as one.
   */
  function finishBlock(b, kind) {
    var deductions = b.serviceFee + b.collectionFee + b.otherFees + b.gstOnFees + b.ads + b.refunds + b.unclassified;
    var contract = b.serviceFeeContract + b.collectionFee + b.otherFees + b.gstOnFeesContract, has = b.orders > 0;
    function rate(a, base) { return has && base > 0 ? a / base : null; }
    return {
      kind: kind, hasData: has, orders: b.orders, grossValue: b.grossValue, restaurantDiscount: b.discount, netSales: b.netSales, gstMemo: b.gst,
      serviceFee: b.serviceFee, collectionFee: b.collectionFee, otherFees: b.otherFees, gstOnFees: b.gstOnFees, tds: b.tds,
      ads: b.ads, refunds: b.refunds, unclassified: b.unclassified, otherDeductions: b.otherFees + b.unclassified,
      totalDeductions: deductions, netPayout: b.netSales - deductions - b.tds,
      serviceFeePct: rate(b.serviceFee, b.feeBase), contractedServiceFeePct: rate(b.serviceFeeContract, b.feeBase),
      contractedTakeRate: rate(contract, b.netSales), effectiveTakeRate: rate(deductions, b.netSales),
      allInCostPctOfMenu: rate(b.discount + deductions, b.grossValue),
      realisationPctOfMenu: rate(b.netSales - deductions, b.grossValue)
    };
  }
  function mergeBlocks(list) {
    var t = feeBlock();
    list.forEach(function (b) { Object.keys(t).forEach(function (k) { t[k] += b[k]; }); });
    return t;
  }

  /**
   * channelEconomics(f) - aggregator money trail from gross menu value to net payout.
   * actual = orders covered by an uploaded statement; estimated = the unsettled tail at contract
   * terms. The two are never blended. Take rates are computed on the actual block only.
   */
  data.channelEconomics = function (f) {
    var sc = resolve(f), cfg = MK.config;
    var out = { from: sc.from, to: sc.to, ratesAssumed: true, settledThrough: {}, actualThrough: {}, channels: [], byOutlet: [], total: null, instore: null, waterfall: [], sources: { actual: [], estimated: 'estimate' } };
    var emptyPair = { actual: finishBlock(feeBlock(), 'actual'), estimated: finishBlock(feeBlock(), 'estimated') };
    out.total = emptyPair;
    out.instore = { orders: 0, grossSales: 0, restaurantDiscount: 0, netSales: 0, gstCollected: 0 };
    /* settledThrough is master data and keyed for every aggregator; actualThrough = the last calendar date of the RANGE a statement covers (null = none) */
    if (cfg) cfg.channels.forEach(function (c) { if (c.kind === 'aggregator' && cfg.channelTerms[c.id]) { out.settledThrough[c.id] = cfg.channelTerms[c.id].settledThrough; out.actualThrough[c.id] = null; } });
    if (!sc.db || sc.empty) return out;
    var d = sc.db, perChannel = {}, perOutlet = {};
    sc.aggs.forEach(function (a) {
      var id = d.aggregatorIds[a];
      perChannel[id] = { actual: feeBlock(), estimated: feeBlock() };
      sc.outlets.forEach(function (o) {
        var oid = d.outletIds[o], cell = { actual: feeBlock(), estimated: feeBlock() };
        addFees(d, sc.d0, sc.d1, o, a, cell);
        if (!perOutlet[oid]) perOutlet[oid] = { actual: [], estimated: [], byChannel: {} };
        perOutlet[oid].actual.push(cell.actual); perOutlet[oid].estimated.push(cell.estimated);
        perOutlet[oid].byChannel[id] = { actual: finishBlock(cell.actual, 'actual'), estimated: finishBlock(cell.estimated, 'estimated') };
        perChannel[id].actual = mergeBlocks([perChannel[id].actual, cell.actual]);
        perChannel[id].estimated = mergeBlocks([perChannel[id].estimated, cell.estimated]);
      });
    });
    var allActual = [], allEstimated = [];
    Object.keys(perChannel).forEach(function (id) {
      var ch = cfg.channels.filter(function (c) { return c.id === id; })[0];
      allActual.push(perChannel[id].actual); allEstimated.push(perChannel[id].estimated);
      /* a statement is a source of this result only when it actually covers orders of the range */
      if (perChannel[id].actual.orders > 0) {
        out.sources.actual.push(cfg.channelTerms[id].statementSource);
        out.actualThrough[id] = D.min(sc.to, out.settledThrough[id]);
      }
      out.channels.push({ channelId: id, label: ch.label, colourVar: ch.colourVar, settledThrough: out.settledThrough[id], actualThrough: out.actualThrough[id],
        actual: finishBlock(perChannel[id].actual, 'actual'), estimated: finishBlock(perChannel[id].estimated, 'estimated') });
    });
    sc.outlets.forEach(function (o) {
      var oid = d.outletIds[o], po = perOutlet[oid];
      if (!po) return;
      var oc = cfg.outlets.filter(function (x) { return x.id === oid; })[0];
      out.byOutlet.push({ outletId: oid, label: oc.name, colourVar: oc.colourVar, actual: finishBlock(mergeBlocks(po.actual), 'actual'),
        estimated: finishBlock(mergeBlocks(po.estimated), 'estimated'), byChannel: po.byChannel });
    });
    out.total = { actual: finishBlock(mergeBlocks(allActual), 'actual'), estimated: finishBlock(mergeBlocks(allEstimated), 'estimated') };

    /* in-store side of the same period, for the GST handling split */
    var inSc = {}; Object.keys(sc).forEach(function (k) { inSc[k] = sc[k]; });
    inSc.streams = sc.streams.filter(function (s) { return d.aggregatorIds.indexOf(cfg.streams[s].channelId) === -1; });
    inSc.empty = !inSc.streams.length;
    var ins = totalsOf(inSc);
    out.instore = { orders: ins.orders, grossSales: ins.grossSales, restaurantDiscount: ins.restaurantDiscount, netSales: ins.netSales, gstCollected: ins.gst };

    /* the waterfall tells the story of settled orders only; without any there is no story (not twelve rows of zeros) */
    var a = out.total.actual;
    out.waterfall = !a.hasData ? [] : [
      { id: 'grossValue', label: 'Gross menu value', amount: a.grossValue, kind: 'total' },
      { id: 'restaurantDiscount', label: 'Restaurant-funded discounts', amount: -a.restaurantDiscount, kind: 'decrease' },
      { id: 'netSales', label: 'Net sales', amount: a.netSales, kind: 'subtotal' },
      { id: 'serviceFee', label: 'Service fee / commission', amount: -a.serviceFee, kind: 'decrease' },
      { id: 'collectionFee', label: 'Collection / payment fee', amount: -a.collectionFee, kind: 'decrease' },
      { id: 'otherFees', label: 'Other platform fees', amount: -a.otherFees, kind: 'decrease' },
      { id: 'gstOnFees', label: 'GST on fees (18%)', amount: -a.gstOnFees, kind: 'decrease' },
      { id: 'tds', label: 'TDS by e-commerce operator (0.1%)', amount: -a.tds, kind: 'decrease' },
      { id: 'ads', label: 'Ads deducted', amount: -a.ads, kind: 'decrease' },
      { id: 'refunds', label: 'Refunds and cancellations', amount: -a.refunds, kind: 'decrease' },
      { id: 'unclassified', label: 'Unclassified deductions', amount: -a.unclassified, kind: 'decrease' },
      { id: 'netPayout', label: 'Net payout', amount: a.netPayout, kind: 'total' }
    ];
    return out;
  };

  /* ------------------------------------------------------------------ payouts */

  function payoutsInScope(sc) {
    if (!sc.db || !sc.outlets.length || !sc.aggs.length) return [];
    var outletIds = sc.outlets.map(function (i) { return sc.db.outletIds[i]; }), aggIds = sc.aggs.map(function (i) { return sc.db.aggregatorIds[i]; });
    return sc.db.payouts.filter(function (p) { return outletIds.indexOf(p.outletId) !== -1 && aggIds.indexOf(p.channelId) !== -1; });
  }

  /** payouts(f) - payout cycles whose period overlaps the date range, newest first, with totals by status. */
  data.payouts = function (f) {
    var sc = resolve(f), out = { from: sc.from, to: sc.to, rows: [], totals: { cycles: 0, expected: 0, actual: 0, variance: 0, awaiting: 0 }, byStatus: {} };
    ['MATCHED', 'SHORT_PAID', 'DISPUTED', 'AWAITING_STATEMENT', 'IN_CYCLE'].forEach(function (s) { out.byStatus[s] = { count: 0, amount: 0 }; });
    var rows = payoutsInScope(sc).filter(function (p) { return p.period.from <= sc.to && p.period.to >= sc.from; });
    rows.sort(function (x, y) { return x.period.from === y.period.from ? (x.outletId < y.outletId ? -1 : 1) : (x.period.from < y.period.from ? 1 : -1); });
    rows.forEach(function (p) {
      out.totals.cycles += 1;
      out.byStatus[p.status].count += 1;
      if (p.statement) {
        out.totals.expected += p.expected.netPayout; out.totals.actual += p.statement.netPayout; out.totals.variance += p.variance;
        out.byStatus[p.status].amount += p.statement.netPayout;
      } else {
        out.totals.awaiting += p.expected.netPayout;
        out.byStatus[p.status].amount += p.expected.netPayout;
      }
    });
    out.rows = rows;
    return out;
  };

  /* -------------------------------------------------------------- audit flags */

  /**
   * auditFlags(f) - exceptions found by rule (thresholds in MK.config.auditRules):
   * commission above contract, short payment / unexplained deductions, ads spike vs trailing
   * average, aggregator markup below the outlet's effective take rate (RESEARCH.md section 3), plus the
   * GST handling split and a summary of how many listings realise less than the POS price at all.
   */
  data.auditFlags = function (f) {
    var sc = resolve(f), cfg = MK.config, rules = cfg ? cfg.auditRules : {};
    var out = { from: sc.from, to: sc.to, flags: [], counts: { high: 0, medium: 0, low: 0 }, gstSplit: null, takeRates: [],
      markupSummary: { listings: 0, belowBreakEven: 0, belowTakeRate: 0, lostRealisation: 0, breakEvenMarkupPct: { min: null, max: null } } };
    out.gstSplit = { collectedByRestaurant: 0, memoByAggregator: {}, note: cfg ? cfg.gst.note : '' };
    if (cfg) cfg.channels.forEach(function (c) { if (c.kind === 'aggregator') out.gstSplit.memoByAggregator[c.id] = 0; });
    if (!sc.db || sc.empty) return out;
    var d = sc.db, flags = out.flags;
    function outletName(id) { return cfg.outlets.filter(function (o) { return o.id === id; })[0].name; }
    function channelName(id) { return cfg.channels.filter(function (c) { return c.id === id; })[0].label; }

    /* 1-3: statement-driven rules on the payout cycles in range */
    var inScope = payoutsInScope(sc);
    inScope.forEach(function (p) {
      if (!p.statement || p.period.from > sc.to || p.period.to < sc.from) return;
      var where = channelName(p.channelId) + ' at ' + outletName(p.outletId) + ', ' + p.period.label;
      p.reasons.forEach(function (r) {
        if (r.code === 'COMMISSION_RATE_ABOVE_CONTRACT' && r.chargedPct - r.contractPct > rules.commissionTolerancePct) {
          flags.push({ id: 'commission|' + p.id, type: 'commission', severity: 'high', outletId: p.outletId, channelId: p.channelId, payoutId: p.id, period: p.period,
            title: 'Commission charged above contract', detail: where + ': service fee charged at ' + MK.fmt.pct(r.chargedPct) + ' against the contracted ' + MK.fmt.pct(r.contractPct),
            amount: r.amount, data: { chargedPct: r.chargedPct, contractPct: r.contractPct } });
        }
        if (r.code === 'UNCLASSIFIED_DEDUCTION') {
          flags.push({ id: 'payout|' + p.id, type: 'payout', severity: 'high', outletId: p.outletId, channelId: p.channelId, payoutId: p.id, period: p.period,
            title: p.status === 'DISPUTED' ? 'Payout short-paid - dispute raised' : 'Payout short-paid', detail: where + ': unclassified deduction on the statement',
            amount: r.amount, data: { status: p.status, variance: p.variance, dispute: p.dispute } });
        }
      });
      /* ads spike: this cycle's ads share of menu value against the trailing settled cycles of the same outlet and channel */
      var trail = inScope.filter(function (q) { return q.statement && q.outletId === p.outletId && q.channelId === p.channelId && q.cycleIndex < p.cycleIndex; })
        .sort(function (x, y) { return y.cycleIndex - x.cycleIndex; }).slice(0, rules.adsTrailingCycles);
      if (trail.length >= 2) {
        /* median, so that one spike does not hide the next */
        var shares = trail.map(function (q) { return q.statement.ads / q.statement.grossValue; }).sort(function (x, y) { return x - y; }), mid = shares.length >> 1;
        var avg = shares.length % 2 ? shares[mid] : (shares[mid - 1] + shares[mid]) / 2, share = p.statement.ads / p.statement.grossValue;
        if (share > rules.adsSpikeRatio * avg) {
          flags.push({ id: 'ads|' + p.id, type: 'ads', severity: 'medium', outletId: p.outletId, channelId: p.channelId, payoutId: p.id, period: p.period,
            title: 'Ads deduction spike', detail: where + ': ads were ' + MK.fmt.pct(share) + ' of menu value against a trailing average of ' + MK.fmt.pct(avg),
            amount: Math.round(p.statement.ads - avg * p.statement.grossValue), data: { adsShare: share, trailingShare: avg, ads: p.statement.ads } });
        }
      }
    });

    /*
     * 4: markup audit. Take rates: settled orders of the trailing 8 weeks to f.to. The statements behind them end at each
     * aggregator's settled-through date, so every row says how far the evidence really goes (settledThrough, windowTo).
     * A portion sold on an aggregator realises  aggregator price x (1 - restaurant discount share) x (1 - effective take rate);
     * it nets less than the counter price when the markup is below  1 / ((1 - d) x (1 - t)) - 1  (breakEvenMarkupPct), which
     * is true of most listings and is reported once, in markupSummary. The FLAG is the exception rule of RESEARCH.md section 3:
     * a markup that does not even cover the effective take rate. Its rupee amount is the realisation lost against the POS
     * price on the aggregator portions of the range, at the menu prices in force on each day.
     */
    var w1 = sc.d1, w0 = Math.max(0, w1 - 55), through = {}, windowTo = null;
    sc.aggs.forEach(function (a) {
      var id = d.aggregatorIds[a], last = D.min(d.days[w1], cfg.channelTerms[id].settledThrough);
      through[id] = last >= d.days[w0] ? last : null;
      if (through[id] && (windowTo === null || through[id] > windowTo)) windowTo = through[id];
    });
    sc.outlets.forEach(function (o) {
      var oid = d.outletIds[o], blocks = { actual: feeBlock(), estimated: feeBlock() };
      sc.aggs.forEach(function (a) { addFees(d, w0, w1, o, a, blocks); });
      var fb = finishBlock(blocks.actual, 'actual');
      if (!fb.hasData || fb.netSales <= 0) return;
      var disc = ratio(fb.restaurantDiscount, fb.grossValue), keep = (1 - disc) * (1 - fb.effectiveTakeRate);
      out.takeRates.push({ outletId: oid, label: outletName(oid), effectiveTakeRate: fb.effectiveTakeRate, contractedTakeRate: fb.contractedTakeRate, discountPct: disc,
        breakEvenMarkupPct: keep > 0 ? 1 / keep - 1 : null, windowFrom: d.days[w0], windowTo: windowTo, requestedTo: d.days[w1], settledThrough: through });
    });
    var aggStreams = sc.streams.filter(function (si) { return d.aggregatorIds.indexOf(cfg.streams[si].channelId) !== -1; }), ms = out.markupSummary;
    out.takeRates.forEach(function (tr) {
      if (tr.breakEvenMarkupPct === null) return;
      if (ms.breakEvenMarkupPct.min === null || tr.breakEvenMarkupPct < ms.breakEvenMarkupPct.min) ms.breakEvenMarkupPct.min = tr.breakEvenMarkupPct;
      if (ms.breakEvenMarkupPct.max === null || tr.breakEvenMarkupPct > ms.breakEvenMarkupPct.max) ms.breakEvenMarkupPct.max = tr.breakEvenMarkupPct;
    });
    if (sc.aggs.length) {
      cfg.dishes.forEach(function (dish, di) {
        var hits = [], impact = 0;
        out.takeRates.forEach(function (tr) {
          var agg = data.aggPriceOn(dish.id, tr.outletId, sc.to), pos = data.posPriceOn(dish.id, sc.to);
          if (agg === null) return;
          var keep = (1 - tr.discountPct) * (1 - tr.effectiveTakeRate), realisation = agg * keep, markup = agg / pos - 1;
          ms.listings += 1;
          if (realisation >= pos) return;
          var o = d.index.outlet[tr.outletId], qty = 0, lost = 0;
          for (var day = sc.d0; day <= sc.d1; day++) {
            var q = 0;
            for (var k = 0; k < aggStreams.length; k++) q += d.dishQty(day, o, aggStreams[k], di);
            if (!q) continue;
            qty += q;
            lost += q * Math.max(0, d.priceOn(day, o, 'pos', di) - d.priceOn(day, o, 'agg', di) * keep);   /* the menu prices of that day */
          }
          ms.belowBreakEven += 1; ms.lostRealisation += lost;
          if (markup >= tr.effectiveTakeRate) return;
          ms.belowTakeRate += 1; impact += lost;
          hits.push({ outletId: tr.outletId, posPrice: pos, aggPrice: agg, markupPct: markup, effectiveTakeRate: tr.effectiveTakeRate, discountPct: tr.discountPct,
            breakEvenMarkupPct: tr.breakEvenMarkupPct, realisationPerPortion: realisation, lostPerPortion: pos - realisation, qty: qty, amount: Math.round(lost) });
        });
        if (!hits.length) return;
        var stale = null;
        dish.priceChanges.forEach(function (c) {
          if (c.list !== 'pos' || c.date > sc.to) return;
          var mirrored = dish.priceChanges.some(function (x) { return x.list === 'agg' && x.date >= c.date && x.date <= sc.to; });
          if (!mirrored) stale = { date: c.date, from: dish.posPrice, to: c.price, note: c.note };
        });
        flags.push({ id: 'markup|' + dish.id, type: 'markup', severity: stale ? 'high' : (impact >= (rules.markupImpactMediumRs || 25000) ? 'medium' : 'low'), outletId: null, channelId: null, dishId: dish.id,
          title: stale ? 'Aggregator price not updated after a POS price change' : 'Aggregator markup below the effective take rate',
          detail: dish.name + ': aggregator markup of ' + rangeLabel(hits, 'markupPct', pctLabel) + ' is below the effective take rate of ' + rangeLabel(hits, 'effectiveTakeRate', pctLabel) + ' at ' +
            hits.length + (hits.length === 1 ? ' outlet' : ' outlets') + ', before any discount; a portion realises ' + rangeLabel(hits, 'realisationPerPortion', rupeeLabel) +
            ' against a POS price of ' + rangeLabel(hits, 'posPrice', rupeeLabel) +
            (stale ? '; POS price moved from ' + rupeeLabel(stale.from) + ' to ' + rupeeLabel(stale.to) + ' on ' + D.label(stale.date, 'd MMM') + ' and the aggregator lists were not updated' : ''),
          amount: Math.round(impact), data: { outlets: hits, stalePriceChange: stale } });
      });
    }
    ms.lostRealisation = Math.round(ms.lostRealisation);

    /* 5: GST handling split for the period */
    var s = totalsOf(sc);
    out.gstSplit.collectedByRestaurant = s.gstCollectedByRestaurant;
    data.channelEconomics(f).channels.forEach(function (c) { out.gstSplit.memoByAggregator[c.channelId] = c.actual.gstMemo + c.estimated.gstMemo; });

    function pctLabel(x) { return MK.fmt.pct(x); }
    function rupeeLabel(x) { return MK.fmt.inrFull(Math.round(x)); }
    /* 'a' or 'a to b' over the outlets of a flag */
    function rangeLabel(hits, key, show) {
      var values = hits.map(function (x) { return x[key]; }), lo = show(Math.min.apply(null, values)), hi = show(Math.max.apply(null, values));
      return lo === hi ? lo : lo + ' to ' + hi;
    }
    var rank = { high: 0, medium: 1, low: 2 };
    flags.sort(function (x, y) { return rank[x.severity] - rank[y.severity] || (y.amount || 0) - (x.amount || 0); });
    flags.forEach(function (fl) { out.counts[fl.severity] += 1; fl.route = '#/revenue/audit'; });
    return out;
  };

  /* ------------------------------------------------------------ recent orders */

  /**
   * recentOrders(f, { limit, offset, search, status }) - the last 14 business days, newest first.
   * search matches order id, POS reference, aggregator order id and dish names; status 'completed' | 'cancelled'.
   */
  data.recentOrders = function (f, opts) {
    opts = opts || {};
    var sc = resolve(f), limit = opts.limit > 0 ? Math.floor(opts.limit) : 50, offset = opts.offset > 0 ? Math.floor(opts.offset) : 0;
    var out = { from: null, to: null, windowFrom: null, windowTo: null, total: 0, limit: limit, offset: offset, rows: [] };
    if (!sc.db) return out;
    var d = sc.db;
    out.windowFrom = d.recentFrom; out.windowTo = d.recentTo;
    out.from = D.max(sc.from, d.recentFrom); out.to = D.min(sc.to, d.recentTo);
    if (sc.empty || out.from > out.to) return out;
    var outletIds = sc.outlets.map(function (i) { return d.outletIds[i]; }), streamIds = sc.streams.map(function (i) { return d.streamIds[i]; });
    var q = typeof opts.search === 'string' ? opts.search.trim().toLowerCase() : '', status = opts.status === 'completed' || opts.status === 'cancelled' ? opts.status : null;
    var all = d.recentOrders, n = 0;
    for (var i = 0; i < all.length; i++) {
      var o = all[i];
      if (o.businessDate < out.from || o.businessDate > out.to) continue;
      if (outletIds.indexOf(o.outletId) === -1 || streamIds.indexOf(o.streamId) === -1) continue;
      if (status && o.status !== status) continue;
      if (q && !(o.id.toLowerCase().indexOf(q) !== -1 || o.posRef.toLowerCase().indexOf(q) !== -1 ||
        o.items.some(function (l) { return l.name.toLowerCase().indexOf(q) !== -1; }))) continue;
      if (n >= offset && out.rows.length < limit) out.rows.push(o);
      n++;
    }
    out.total = n;
    return out;
  };

  data.MEASURES = MEASURES.slice();
  data.DISH_MEASURES = DISH_MEASURES.slice();
  data.DIMENSIONS = DIMS.slice();

  if (typeof module !== 'undefined' && module.exports) module.exports = root.MK;
})(typeof window !== 'undefined' ? window : globalThis);
