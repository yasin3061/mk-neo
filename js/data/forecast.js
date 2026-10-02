/*
 * Forecasting - the statistical layer that every mid-market ERP ships: no learning, no black box, every figure
 * explainable in one sentence to the person who has to act on it.
 *
 *   Layer 1 (the dashboard outlook)   projected month-end net sales, a dashed forecast with an 80% band on the trend
 *                                     chart, and the measured accuracy of the last eight weeks of forecasts
 *   Layer 3 (embedded suggestions)    the factory's suggested purchases for the next seven days, and the month-end
 *                                     projection of a budget line while a bill is under review
 *
 * The engine, per outlet and business day:
 *
 *   forecast(outlet, day) = level(outlet) x dayOfWeekIndex(outlet, weekday) x eventFactor(outlet, day)
 *
 *   level             exponentially smoothed daily sales of the last N weeks, after the weekday pattern and the known
 *                     events are taken out (N = the "reactiveness" setting: 4, 8 or 12 weeks)
 *   dayOfWeekIndex    ratio of each weekday to its centred seven-day moving average, over the last twelve weeks
 *   eventFactor       the uplift or dip of the event calendar (MK.config.events): festivals, holidays and sport are
 *                     known in advance and are applied; weather is not and is never applied to a future day
 *
 * Accuracy is measured, not assumed: for each of the last eight weeks a forecast is made from the data available on the
 * Sunday before it (an ex-ante backtest) and compared with what happened. WAPE, bias and the width of the band all come
 * from those misses; the same-day-last-week guess is reported next to it as the baseline the model has to beat.
 *
 * Purchase suggestions follow the MRP chain the factory already uses for its indents: forecast net sales -> the recent
 * dish mix of each outlet (reshaped by an event's dish effects) -> recipe grams per dish -> factory products (plus the
 * outlet's recent over-use against recipe) -> raw materials by the bill of materials, with a process-wastage allowance
 * -> net of stock on hand -> an order-up-to quantity covering lead time + review period + the safety-days setting.
 *
 * Settings (MK.forecast.settings / setSettings) live in prefs so the router does not repaint the page on a change; the
 * pages that own a dial repaint the figures it moves. Scope: the sales selectors obey the persona's outlets like
 * MK.data; the purchase suggestions and the budget projection are built from the whole company's demand and expose
 * only kilograms and a ratio, exactly as MK.factory.inventory exposes a kitchen's daily use to its manager.
 *
 * Everything here is a pure function of MK.db, MK.config and the settings: deterministic, no randomness, Node-loadable.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK) return;
  var forecast = MK.forecast = MK.forecast || {};

  /* ---------------------------------------------------------------- model parameters */

  var MODEL = {
    horizonDays: 45,            /* 17 Sep .. 31 Oct: long enough to carry the October festivals */
    backtestWeeks: 8,           /* ex-ante weekly forecasts compared with what happened */
    dowWeeks: 12,               /* window of the weekday pattern */
    mixDays: 28,                /* window of the dish mix behind the purchase suggestions */
    bandZ: 1.28,                /* 80% band: 1.28 standard errors either side */
    purchaseDays: 7,            /* the suggestion list looks at the coming week */
    eveningShareOfDay: 1.5,     /* an effect limited to evening hours weighs those hours at 1.5x the average hour */
    leadDays: { fresh: 1, frozen: 2, dry: 3 },       /* order today, delivered in this many days */
    reviewDays: { fresh: 1, frozen: 7, dry: 7 },     /* fresh is ordered every day; dry and frozen once a week */
    lot: { fresh: 1, frozen: 1, dry: 5 },            /* order quantities are rounded up to this many units */
    variableCategories: ['raw_materials', 'production_consumables', 'vehicle_fuel', 'pune_run'],   /* beside the cogs and channel groups */
    variableGroups: ['cogs', 'channel']
  };

  /* defaults match the kitchen's own practice: fresh is topped up to 2.5 days (1 lead + 1 review + 0.5 safety), dry and
     frozen are reordered at 13 days of cover (3 lead + 10 safety) up to 20 */
  var DEFAULTS = { weeks: 8, safetyDays: { fresh: 0.5, dry: 10 } };
  var REACTIVENESS = [
    { value: 4, label: 'Reactive', caption: 'follows the last 4 weeks closely' },
    { value: 8, label: 'Balanced', caption: 'weighs the last 8 weeks' },
    { value: 12, label: 'Steady', caption: 'weighs the last 12 weeks' }
  ];
  var SAFETY = {
    fresh: { id: 'fresh', label: 'Fresh: safety cover', min: 0, max: 3, step: 0.5, unit: 'days', applies: ['fresh'] },
    dry: { id: 'dry', label: 'Dry and frozen: safety cover', min: 0, max: 14, step: 1, unit: 'days', applies: ['dry', 'frozen'] }
  };
  forecast.OPTIONS = { reactiveness: REACTIVENESS, safety: SAFETY, model: MODEL };

  /* ---------------------------------------------------------------- helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function round(v, dp) { var m = Math.pow(10, dp || 0); return Math.round(v * m) / m; }
  function sum(list) { var t = 0; for (var i = 0; i < list.length; i++) t += list[i] || 0; return t; }
  function mean(list) { return list.length ? sum(list) / list.length : 0; }
  function sd(list) { if (list.length < 2) return 0; var m = mean(list), t = 0; list.forEach(function (x) { t += (x - m) * (x - m); }); return Math.sqrt(t / (list.length - 1)); }
  function clampStep(v, spec) {
    if (!isNum(v)) return null;
    var snapped = Math.round(v / spec.step) * spec.step;
    return Math.max(spec.min, Math.min(spec.max, round(snapped, 2)));
  }
  function mediumOf(streamId) { return /_delivery$/.test(streamId) ? 'delivery' : (/dinein$/.test(streamId) ? 'dinein' : 'takeaway'); }

  /* ---------------------------------------------------------------- settings */

  forecast.settings = function () {
    var prefs = MK.store.get('prefs', {}) || {}, s = prefs.forecast || {};
    var weeks = REACTIVENESS.some(function (o) { return o.value === s.weeks; }) ? s.weeks : DEFAULTS.weeks;
    var sdays = s.safetyDays || {};
    var fresh = clampStep(sdays.fresh, SAFETY.fresh), dry = clampStep(sdays.dry, SAFETY.dry);
    return { weeks: weeks, safetyDays: { fresh: fresh === null ? DEFAULTS.safetyDays.fresh : fresh, dry: dry === null ? DEFAULTS.safetyDays.dry : dry } };
  };

  /** setSettings({weeks} | {safetyDays: {fresh, dry}}) - values are snapped to the dial's range; returns the settings in force. */
  forecast.setSettings = function (patch) {
    var cur = forecast.settings(), next = { weeks: cur.weeks, safetyDays: { fresh: cur.safetyDays.fresh, dry: cur.safetyDays.dry } };
    patch = patch || {};
    if (REACTIVENESS.some(function (o) { return o.value === patch.weeks; })) next.weeks = patch.weeks;
    if (patch.safetyDays) {
      var f = clampStep(patch.safetyDays.fresh, SAFETY.fresh), d = clampStep(patch.safetyDays.dry, SAFETY.dry);
      if (f !== null) next.safetyDays.fresh = f;
      if (d !== null) next.safetyDays.dry = d;
    }
    var prefs = MK.store.get('prefs', {}) || {};
    prefs.forecast = next;
    MK.store.set('prefs', prefs);
    MK.bus.emit('forecast:changed', next);
    return next;
  };
  forecast.reactivenessLabel = function (weeks) { var o = REACTIVENESS.filter(function (x) { return x.value === weeks; })[0]; return o ? o.label : String(weeks) + ' weeks'; };

  /* ---------------------------------------------------------------- event calendar */

  /* the multiplier an event calendar entry puts on an outlet's net sales on a day; weather is ex post knowledge only */
  function eventFactorFor(B, o, iso, exAnte) {
    var dow = MK.dates.dow(iso), m = 1, evs = MK.config.events || [];
    for (var e = 0; e < evs.length; e++) {
      var ev = evs[e];
      if (ev.from > iso || ev.to < iso) continue;
      if (exAnte && ev.kind === 'weather') continue;
      var fx = ev.effects || [];
      for (var k = 0; k < fx.length; k++) {
        var x = fx[k];
        if (x.outlets && x.outlets.indexOf(B.outletIds[o]) === -1) continue;
        if (x.dows && x.dows.indexOf(dow) === -1) continue;
        var w = 1;
        if (x.mediums) { w = 0; x.mediums.forEach(function (md) { w += B.mediumShare[o][md] || 0; }); }
        if (x.hours) w *= Math.min(1, (x.hours[1] - x.hours[0]) / (MK.db.dims.H || 16) * MODEL.eveningShareOfDay);
        m *= 1 + (x.mult - 1) * w;
      }
    }
    return m;
  }

  function eventsOn(iso, outletId, exAnte) {
    return (MK.config.events || []).filter(function (ev) {
      if (ev.from > iso || ev.to < iso) return false;
      if (exAnte && ev.kind === 'weather') return false;
      return !ev.effects || ev.effects.some(function (x) { return !x.outlets || x.outlets.indexOf(outletId) !== -1; });
    });
  }

  /* dish weights of an event: dishMult and categoryMult reshape the mix, the total number of portions stays */
  function dishMultsOn(iso) {
    var out = null;
    (MK.config.events || []).forEach(function (ev) {
      if (ev.from > iso || ev.to < iso || ev.kind === 'weather') return;
      if (!ev.dishMult && !ev.categoryMult) return;
      out = out || MK.config.dishes.map(function () { return 1; });
      MK.config.dishes.forEach(function (dish, i) {
        if (ev.dishMult && ev.dishMult[dish.id]) out[i] *= ev.dishMult[dish.id];
        if (ev.categoryMult && ev.categoryMult[dish.category]) out[i] *= ev.categoryMult[dish.category];
      });
    });
    return out;
  }

  /* ---------------------------------------------------------------- the base facts (settings-independent) */

  var B = null;
  function base() {
    if (B && B.db === MK.db) return B;
    var db = MK.db, ND = db.dims.ND, NO = db.dims.NO, NS = db.dims.NS, NDI = db.dims.NDI, o, d, s;
    var out = { db: db, ND: ND, NO: NO, outletIds: db.outletIds.slice(), y: [], mediumShare: [], mix: [], mixSales: [] };

    /* daily net sales per outlet, and the medium shares of the last eight weeks (weights of medium-limited event effects) */
    for (o = 0; o < NO; o++) {
      var row = new Float64Array(ND), share = { dinein: 0, takeaway: 0, delivery: 0 }, tot = 0;
      for (d = 0; d < ND; d++) {
        for (s = 0; s < NS; s++) {
          var v = db.dayMeasure(d, o, s, 'netSales') || 0;
          row[d] += v;
          if (d >= ND - 56) { share[mediumOf(db.streamIds[s])] += v; tot += v; }
        }
      }
      Object.keys(share).forEach(function (k) { share[k] = tot ? share[k] / tot : 0; });
      out.y.push(row); out.mediumShare.push(share);
    }

    /* ex-post base: sales with every known event taken out (weather included - after the day, the rain is a fact) */
    out.b = out.y.map(function (row, oi) {
      var b = new Float64Array(ND);
      for (var i = 0; i < ND; i++) b[i] = row[i] / eventFactorFor(out, oi, db.days[i], false);
      return b;
    });

    /* dish mix per outlet: portions of each dish per rupee of net sales over the last four weeks */
    for (o = 0; o < NO; o++) {
      var per = new Float64Array(NDI), sales = 0;
      for (d = Math.max(0, ND - MODEL.mixDays); d < ND; d++) {
        sales += out.y[o][d];
        for (s = 0; s < NS; s++) for (var k = 0; k < NDI; k++) per[k] += db.dishQty(d, o, s, k) || 0;
      }
      for (var k2 = 0; k2 < NDI; k2++) per[k2] = sales ? per[k2] / sales : 0;
      out.mix.push(per); out.mixSales.push(sales);
    }
    B = out;
    M = {};
    return out;
  }

  /* weekday index of an outlet from the twelve weeks ending at day index `end` (inclusive): ratio to the centred moving average */
  function dowIndex(Bx, o, end) {
    var db = Bx.db, b = Bx.b[o], acc = [0, 0, 0, 0, 0, 0, 0], n = [0, 0, 0, 0, 0, 0, 0];
    var from = Math.max(3, end - MODEL.dowWeeks * 7 + 1), to = Math.min(end, Bx.ND - 4);
    for (var d = from; d <= to; d++) {
      var ma = 0;
      for (var j = -3; j <= 3; j++) ma += b[d + j];
      ma /= 7;
      if (ma > 0) { acc[db.dayDow[d]] += b[d] / ma; n[db.dayDow[d]] += 1; }
    }
    var idx = acc.map(function (a, i) { return n[i] ? a / n[i] : 1; });
    var m = mean(idx);
    return idx.map(function (v) { return m ? v / m : 1; });
  }

  /* level of an outlet as of day index `end`: exponential smoothing of the de-seasonalised base over the last `weeks` weeks */
  function levelAt(Bx, o, end, weeks, idx) {
    var db = Bx.db, b = Bx.b[o], n = weeks * 7, start = Math.max(0, end - n + 1);
    var alpha = 2 / (n + 1), lvl = null, warm = [];
    for (var d = start; d <= end; d++) {
      var v = b[d] / (idx[db.dayDow[d]] || 1);
      if (warm.length < 7) { warm.push(v); lvl = mean(warm); continue; }
      lvl = lvl + alpha * (v - lvl);
    }
    return lvl || 0;
  }

  /* ---------------------------------------------------------------- the model for one reactiveness setting */

  var M = {};
  function model(weeks) {
    var Bx = base();
    if (M[weeks]) return M[weeks];
    var db = Bx.db, D = MK.dates, last = Bx.ND - 1, NO = Bx.NO, o;
    var out = { weeks: weeks, idx: [], level: [], horizon: [], backtest: null };

    for (o = 0; o < NO; o++) {
      var idx = dowIndex(Bx, o, last);
      out.idx.push(idx);
      out.level.push(levelAt(Bx, o, last, weeks, idx));
    }
    /* the horizon: today onwards */
    var dayIso = MK.calendar.today;
    for (var t = 0; t < MODEL.horizonDays; t++) {
      var dow = D.dow(dayIso), row = { date: dayIso, dow: dow, byOutlet: new Float64Array(NO), eventFactor: new Float64Array(NO) };
      for (o = 0; o < NO; o++) {
        row.eventFactor[o] = eventFactorFor(Bx, o, dayIso, true);
        row.byOutlet[o] = out.level[o] * out.idx[o][dow] * row.eventFactor[o];
      }
      out.horizon.push(row);
      dayIso = D.addDays(dayIso, 1);
    }

    /* ex-ante backtest: each of the last eight Monday-to-Sunday weeks forecast from the Sunday before it */
    var lastSunday = last; while (db.dayDow[lastSunday] !== 6) lastSunday--;
    var bt = { weeks: [], daily: [], naiveAbs: 0, abs: 0, signed: 0, actual: 0, sigmaDaily: [], sigmaWeekly: [] };
    var perOutletDaily = [], perOutletWeekly = [];
    for (o = 0; o < NO; o++) { perOutletDaily.push([]); perOutletWeekly.push([]); }
    for (var w = MODEL.backtestWeeks; w >= 1; w--) {
      var origin = lastSunday - 7 * w;         /* the Sunday the forecast is made on; the week is origin+1 .. origin+7 */
      if (origin < 28) continue;
      var week = { weekStart: db.days[origin + 1], weekEnd: db.days[origin + 7], actual: 0, forecast: 0, naive: 0, byOutlet: [] };
      for (o = 0; o < NO; o++) {
        var idxO = dowIndex(Bx, o, origin), lvl = levelAt(Bx, o, origin, weeks, idxO), fa = 0, fs = 0, na = 0;
        for (var j = 1; j <= 7; j++) {
          var di = origin + j, iso = db.days[di];
          var f = lvl * idxO[db.dayDow[di]] * eventFactorFor(Bx, o, iso, true);
          var a = Bx.y[o][di], nv = Bx.y[o][di - 7];
          bt.daily.push({ date: iso, outletIdx: o, actual: a, forecast: f, naive: nv });
          if (f > 0) perOutletDaily[o].push(a / f - 1);
          fa += a; fs += f; na += nv;
          bt.abs += Math.abs(a - f); bt.naiveAbs += Math.abs(a - nv); bt.signed += f - a; bt.actual += a;
        }
        if (fs > 0) perOutletWeekly[o].push(fa / fs - 1);
        week.byOutlet.push({ actual: fa, forecast: fs, naive: na });
        week.actual += fa; week.forecast += fs; week.naive += na;
      }
      bt.weeks.push(week);
    }
    for (o = 0; o < NO; o++) { bt.sigmaDaily.push(sd(perOutletDaily[o])); bt.sigmaWeekly.push(sd(perOutletWeekly[o])); }
    out.backtest = bt;
    M[weeks] = out;
    return out;
  }

  /* ---------------------------------------------------------------- scope */

  function outletIdx(f) {
    var Bx = base(), allowed = MK.session.allowedOutletIds();
    var wanted = f && f.outletIds && f.outletIds.length ? (Array.isArray(f.outletIds) ? f.outletIds : [f.outletIds]) : null;
    var out = [];
    Bx.outletIds.forEach(function (id, i) {
      if (allowed.indexOf(id) === -1) return;
      if (wanted && wanted.indexOf(id) === -1) return;
      out.push(i);
    });
    return out;
  }

  /* relative standard error of a sum over `days` days for a set of outlets: one day uses the daily misses, a longer sum
     the weekly misses scaled by the square root of its length (misses average out over a month, not over a day);
     outlets are added as if their misses move together, because they do - rain and festivals hit every outlet at once */
  function relSigma(mdl, outlets, days) {
    var n = Math.max(1, days), num = 0, den = 0;
    outlets.forEach(function (o) {
      var share = sum(mdl.horizon.slice(0, n).map(function (r) { return r.byOutlet[o]; }));
      var s = n === 1 ? mdl.backtest.sigmaDaily[o] : mdl.backtest.sigmaWeekly[o] * Math.sqrt(7 / n);
      num += s * share; den += share;
    });
    return den ? num / den : 0;
  }

  /* ---------------------------------------------------------------- public: Layer 1 */

  /**
   * daily(f, {to}) - the forecast by business day from today to `to` (default: the end of today's month) for the
   * outlets in scope. Each day: value, an 80% band, the events in force. `source` is 'forecast'.
   */
  forecast.daily = function (f, opts) {
    opts = opts || {};
    var s = forecast.settings(), mdl = model(s.weeks), outlets = outletIdx(f || {}), D = MK.dates;
    var to = opts.to || D.monthEnd(MK.calendar.today);
    var out = { from: MK.calendar.today, to: to, days: [], total: 0, lo: 0, hi: 0, outletIds: outlets.map(function (i) { return base().outletIds[i]; }),
      settings: s, method: methodNote(s), source: 'forecast' };
    if (!outlets.length) return out;
    mdl.horizon.forEach(function (row) {
      if (row.date > to) return;
      var v = 0; outlets.forEach(function (o) { v += row.byOutlet[o]; });
      var sig = relSigma(mdl, outlets, 1);
      var labels = {};
      outlets.forEach(function (o) { eventsOn(row.date, base().outletIds[o], true).forEach(function (ev) { labels[ev.id] = ev.label; }); });
      out.days.push({ date: row.date, label: D.label(row.date), dow: row.dow, value: Math.round(v),
        lo: Math.round(v * Math.max(0, 1 - MODEL.bandZ * sig)), hi: Math.round(v * (1 + MODEL.bandZ * sig)),
        events: Object.keys(labels).map(function (k) { return labels[k]; }) });
      out.total += Math.round(v);
    });
    var sigSum = relSigma(mdl, outlets, out.days.length);
    out.lo = Math.round(out.total * Math.max(0, 1 - MODEL.bandZ * sigSum));
    out.hi = Math.round(out.total * (1 + MODEL.bandZ * sigSum));
    return out;
  };

  function methodNote(s) {
    return 'Level of the last ' + s.weeks + ' weeks x weekday pattern x event calendar; 80% band from the last ' + MODEL.backtestWeeks + ' weeks of forecast misses';
  }

  /**
   * monthEnd(f) - where the current month lands: net sales to date (actual) plus the forecast of the remaining days,
   * with the band, the plain run-rate for comparison and last month's actual.
   */
  forecast.monthEnd = function (f) {
    var D = MK.dates, cal = MK.calendar, monthKey = D.monthKey(cal.today);
    var outlets = outletIdx(f || {}), ids = outlets.map(function (i) { return base().outletIds[i]; });
    var out = { available: false, monthKey: monthKey, label: D.monthLabel(monthKey, true), outletIds: ids, source: 'forecast' };
    if (!outlets.length) return out;
    var from = D.monthStart(cal.today), to = D.monthEnd(cal.today);
    var daysInMonth = D.daysInMonth(monthKey), daysDone = D.diffDays(from, cal.dataEnd) + 1;
    var toDate = MK.data.summary({ from: from, to: cal.dataEnd, outletIds: ids }).netSales || 0;
    var rest = forecast.daily({ outletIds: ids }, { to: to });
    var prevKey = D.monthKey(D.addDays(from, -1)), prevFrom = D.monthStart(D.addDays(from, -1)), prevTo = D.addDays(from, -1);
    var lastMonth = MK.data.summary({ from: prevFrom, to: prevTo, outletIds: ids }).netSales || 0;
    out.available = true;
    out.from = from; out.to = to; out.daysInMonth = daysInMonth; out.daysDone = daysDone; out.daysLeft = daysInMonth - daysDone;
    out.toDate = toDate; out.remaining = rest.total; out.remainingLo = rest.lo; out.remainingHi = rest.hi;
    out.projected = toDate + rest.total; out.lo = toDate + rest.lo; out.hi = toDate + rest.hi;
    out.runRate = daysDone ? Math.round(toDate / daysDone * daysInMonth) : 0;
    out.lastMonth = { monthKey: prevKey, label: D.monthLabel(prevKey, true), netSales: lastMonth };
    out.events = rest.days.reduce(function (acc, d) { d.events.forEach(function (e) { if (acc.indexOf(e) === -1) acc.push(e); }); return acc; }, []);
    out.settings = rest.settings; out.method = rest.method;
    return out;
  };

  /**
   * accuracy(f) - how the last eight weekly forecasts did for the outlets in scope: WAPE (and accuracy = 1 - WAPE),
   * bias, the same-day-last-week baseline, the week-by-week points, and what each reactiveness setting would have scored.
   */
  forecast.accuracy = function (f) {
    var s = forecast.settings(), outlets = outletIdx(f || {});
    var out = { available: false, weeks: MODEL.backtestWeeks, settingUsed: s.weeks, settingLabel: forecast.reactivenessLabel(s.weeks), source: 'forecast' };
    if (!outlets.length) return out;
    /* wape: by outlet and day (the hardest test); weeklyWape: by week over the outlets in scope (what a month-end projection rests on) */
    function score(weeks) {
      var mdl = model(weeks), bt = mdl.backtest, abs = 0, naive = 0, signed = 0, actual = 0, wAbs = 0, wNaive = 0;
      bt.daily.forEach(function (r) {
        if (outlets.indexOf(r.outletIdx) === -1) return;
        abs += Math.abs(r.actual - r.forecast); naive += Math.abs(r.actual - r.naive); signed += r.forecast - r.actual; actual += r.actual;
      });
      var points = bt.weeks.map(function (w) {
        var a = 0, fc = 0, nv = 0;
        outlets.forEach(function (o) { a += w.byOutlet[o].actual; fc += w.byOutlet[o].forecast; nv += w.byOutlet[o].naive; });
        wAbs += Math.abs(a - fc); wNaive += Math.abs(a - nv);
        return { weekStart: w.weekStart, weekEnd: w.weekEnd, actual: Math.round(a), forecast: Math.round(fc), naive: Math.round(nv) };
      });
      return { weeks: weeks, label: forecast.reactivenessLabel(weeks), wape: actual ? abs / actual : null, naiveWape: actual ? naive / actual : null, bias: actual ? signed / actual : null,
        weeklyWape: actual ? wAbs / actual : null, weeklyNaiveWape: actual ? wNaive / actual : null, points: points };
    }
    var cur = score(s.weeks);
    out.available = cur.wape !== null;
    out.wape = cur.wape; out.accuracy = cur.wape === null ? null : 1 - cur.wape; out.bias = cur.bias; out.naiveWape = cur.naiveWape;
    out.naiveAccuracy = cur.naiveWape === null ? null : 1 - cur.naiveWape;
    out.weeklyWape = cur.weeklyWape; out.weeklyAccuracy = cur.weeklyWape === null ? null : 1 - cur.weeklyWape;
    out.weeklyNaiveWape = cur.weeklyNaiveWape; out.weeklyNaiveAccuracy = cur.weeklyNaiveWape === null ? null : 1 - cur.weeklyNaiveWape;
    out.points = cur.points;
    out.from = cur.points.length ? cur.points[0].weekStart : null; out.to = cur.points.length ? cur.points[cur.points.length - 1].weekEnd : null;
    out.bySetting = REACTIVENESS.map(function (o) {
      var sc = score(o.value);
      return { weeks: o.value, label: o.label, wape: sc.wape, accuracy: sc.wape === null ? null : 1 - sc.wape, weeklyWape: sc.weeklyWape, weeklyAccuracy: sc.weeklyWape === null ? null : 1 - sc.weeklyWape };
    });
    return out;
  };

  /**
   * upcoming(f, days) - festivals, holidays and sport inside the next `days` days (default: the whole horizon) for the
   * outlets in scope, each with its expected effect on net sales and the dishes it moves.
   */
  forecast.upcoming = function (f, days) {
    var Bx = base(), D = MK.dates, cal = MK.calendar, s = forecast.settings(), mdl = model(s.weeks);
    var outlets = outletIdx(f || {}), horizon = days || MODEL.horizonDays, until = D.addDays(cal.today, horizon - 1);
    var out = [];
    if (!outlets.length) return out;
    (MK.config.events || []).forEach(function (ev) {
      if (ev.kind === 'weather' || ev.to < cal.today || ev.from > until) return;
      var num = 0, den = 0, byOutlet = {};
      mdl.horizon.forEach(function (row) {
        if (row.date < ev.from || row.date > ev.to) return;
        outlets.forEach(function (o) {
          var plain = row.byOutlet[o] / (row.eventFactor[o] || 1);
          /* the effect of this event alone, not of everything on the day */
          var alone = 1;
          (ev.effects || []).forEach(function (x) {
            if (x.outlets && x.outlets.indexOf(Bx.outletIds[o]) === -1) return;
            if (x.dows && x.dows.indexOf(row.dow) === -1) return;
            var w = 1;
            if (x.mediums) { w = 0; x.mediums.forEach(function (md) { w += Bx.mediumShare[o][md] || 0; }); }
            alone *= 1 + (x.mult - 1) * w;
          });
          num += plain * (alone - 1); den += plain;
          var id = Bx.outletIds[o];
          byOutlet[id] = byOutlet[id] || { num: 0, den: 0 };
          byOutlet[id].num += plain * (alone - 1); byOutlet[id].den += plain;
        });
      });
      if (!den) return;
      var dishes = [];
      if (ev.dishMult) Object.keys(ev.dishMult).forEach(function (id) { var dish = MK.config.dishes.filter(function (x) { return x.id === id; })[0]; if (dish) dishes.push({ id: id, name: dish.name, mult: ev.dishMult[id] }); });
      out.push({ id: ev.id, label: ev.label, kind: ev.kind, from: ev.from, to: ev.to, days: D.diffDays(ev.from, ev.to) + 1,
        effect: num / den, byOutlet: Object.keys(byOutlet).map(function (id) { return { outletId: id, effect: byOutlet[id].den ? byOutlet[id].num / byOutlet[id].den : 0 }; }),
        dishes: dishes.sort(function (a, b) { return b.mult - a.mult; }) });
    });
    return out.sort(function (a, b) { return a.from < b.from ? -1 : 1; });
  };

  /* ---------------------------------------------------------------- Layer 3: purchase suggestions */

  function factoryInScope() { return MK.session.allowedUnitIds().indexOf('factory') !== -1; }

  /* raw-material need per day over the horizon, by the MRP chain, for the whole company (unscoped by design) */
  function rawMaterialNeed(mdl) {
    var Bx = base(), cfg = MK.config, D = MK.dates, NO = Bx.NO;
    var products = cfg.items.factoryProducts, rms = cfg.items.rawMaterials, dishes = cfg.dishes;
    var skuIdx = {}, rmIdx = {};
    products.forEach(function (p, k) { skuIdx[p.id] = k; });
    rms.forEach(function (r, i) { rmIdx[r.id] = i; });
    var grams = dishes.map(function (dish) { var g = new Float64Array(products.length); dish.recipe.factory.forEach(function (l) { g[skuIdx[l.sku]] += l.g; }); return g; });
    var overUse = Bx.outletIds.map(function (id) { return MK.factory && MK.factory.raw ? MK.factory.raw.overUseRate(id) : 0; });
    var band = cfg.factoryParams.wastageTargetPct, waste = (band[0] + band[1]) / 2;
    var need = mdl.horizon.map(function (row) {
      var fp = new Float64Array(products.length), rm = new Float64Array(rms.length), portions = 0;
      var mults = dishMultsOn(row.date);
      for (var o = 0; o < NO; o++) {
        var sales = row.byOutlet[o], mix = Bx.mix[o], w = [], tot = 0, totW = 0;
        for (var k = 0; k < mix.length; k++) { var base0 = sales * mix[k]; w.push(base0 * (mults ? mults[k] : 1)); tot += base0; totW += w[k]; }
        var norm = totW ? tot / totW : 1;   /* an event reshapes the mix; the portions stay what the sales forecast implies */
        for (k = 0; k < mix.length; k++) {
          var q = w[k] * norm; if (!q) continue;
          portions += q;
          for (var p = 0; p < products.length; p++) if (grams[k][p]) fp[p] += q * grams[k][p] / 1000 * (1 + overUse[o]);
        }
      }
      for (var p2 = 0; p2 < products.length; p2++) {
        if (!fp[p2]) continue;
        products[p2].bom.forEach(function (line) { rm[rmIdx[line[0]]] += fp[p2] * line[1] / (1 - waste); });
      }
      return { date: row.date, fp: fp, rm: rm, portions: portions };
    });
    return { need: need, waste: waste, overUse: overUse, rms: rms, products: products, D: D };
  }

  /**
   * purchaseSuggestions() - what the central kitchen should order, item by item, for the coming week: forecast use,
   * stock on hand, the cover wanted (lead time + review period + safety days) and the order quantity, each with its
   * working. Empty unless the factory is in the persona's scope.
   */
  forecast.purchaseSuggestions = function () {
    var s = forecast.settings(), D = MK.dates, cal = MK.calendar, fmt = MK.fmt;
    var out = { asOf: cal.today, horizonDays: MODEL.purchaseDays, settings: s, rows: [], totals: { today: { items: 0, value: 0 }, week: { items: 0, value: 0 }, later: 0 },
      method: 'Forecast portions x recipes (+ outlet over-use) -> factory products -> bill of materials (+ process wastage), net of stock on hand', source: 'erp' };
    if (!factoryInScope() || !MK.factory || typeof MK.factory.inventory !== 'function') return out;
    var inv = MK.factory.inventory();
    if (!inv || !inv.rawMaterials || !inv.rawMaterials.length) return out;
    var mdl = model(s.weeks), R = rawMaterialNeed(mdl);
    out.wastagePct = R.waste;
    out.overUse = base().outletIds.map(function (id, i) { return { outletId: id, rate: R.overUse[i] }; });
    var stockOf = {}; inv.rawMaterials.forEach(function (r) { stockOf[r.rmId] = r; });

    R.rms.forEach(function (rm, i) {
      var row = stockOf[rm.id]; if (!row) return;
      var storage = rm.storage || 'dry', dial = storage === 'fresh' ? 'fresh' : 'dry';
      var lead = MODEL.leadDays[storage], review = MODEL.reviewDays[storage], safety = s.safetyDays[dial], lot = MODEL.lot[storage];
      var targetDays = lead + review + safety, reorderDays = lead + safety;
      function needOver(days) {   /* use over the next `days` days from today (fractions take a share of the next day) */
        var t = 0, whole = Math.floor(days), frac = days - whole;
        for (var d = 0; d < whole && d < R.need.length; d++) t += R.need[d].rm[i];
        if (frac > 0 && whole < R.need.length) t += frac * R.need[whole].rm[i];
        return t;
      }
      var weekNeed = needOver(MODEL.purchaseDays), usePerDay = weekNeed / MODEL.purchaseDays;
      var onHand = row.stockQty, cover = usePerDay > 0 ? onHand / usePerDay : null;
      var wanted = needOver(targetDays), raw = Math.max(0, wanted - onHand);
      var orderQty = raw > 0 ? Math.ceil(raw / lot) * lot : 0;
      /* the ordering rhythm in the kitchen's own words: how often the item is ordered and how long delivery takes */
      var rhythm = review === 1 ? 'ordered every day' : (review === 7 ? 'ordered once a week' : 'ordered every ' + fmtDays(review));
      var delivery = lead === 1 ? 'delivered the next day' : 'delivered in ' + fmtDays(lead);
      var status, orderBy = null, deliverBy = null, reason;
      if (storage === 'fresh') {
        status = orderQty > 0 ? 'ORDER_TODAY' : 'NO_ORDER';
        orderBy = orderQty > 0 ? cal.today : null;
        reason = orderQty > 0 ? 'Ordered every day: tomorrow\'s delivery tops the stock up to ' + fmtDays(targetDays) + ' of use' : 'Stock already covers ' + fmtDays(targetDays) + ' of use';
      } else if (cover !== null && cover <= reorderDays) {
        status = 'ORDER_TODAY'; orderBy = cal.today;
        reason = 'Stock of ' + fmtDays(cover) + ' is at or under the reorder point of ' + fmtDays(reorderDays) + ' (delivery time plus safety cover), so it goes on this week\'s order';
      } else if (cover !== null && cover - reorderDays < MODEL.purchaseDays) {
        var inDays = Math.max(0, Math.floor(cover - reorderDays));
        status = 'ORDER_THIS_WEEK'; orderBy = D.addDays(cal.today, inDays);
        wanted = needOver(inDays + targetDays) - needOver(inDays);   /* the order placed on that day covers from then */
        raw = Math.max(0, wanted - Math.max(0, onHand - needOver(inDays)));
        orderQty = raw > 0 ? Math.ceil(raw / lot) * lot : 0;
        reason = 'Stock reaches the reorder point of ' + fmtDays(reorderDays) + ' (delivery time plus safety cover) on ' + D.label(orderBy, 'EEE d MMM');
      } else {
        status = 'NO_ORDER'; orderQty = 0;
        reason = cover === null ? 'No forecast use' : 'Stock of ' + fmtDays(cover) + ' lasts beyond the week; it comes up again at next week\'s order';
      }
      if (orderBy) deliverBy = D.addDays(orderBy, lead);
      var value = Math.round(orderQty * (row.price || 0));
      var working = [
        'Forecast use ' + qtyText(usePerDay, rm.unit) + ' a day over the next ' + MODEL.purchaseDays + ' days: forecast portions x recipes, + ' + fmt.pct(mean(R.overUse), 1) + ' outlet over-use against recipe, + ' + fmt.pct(R.waste, 1) + ' process wastage' +
          (isNum(row.avgDailyUse) ? ' (recent average ' + qtyText(row.avgDailyUse, rm.unit) + ' a day)' : ''),
        rm.name + ' is ' + rhythm + ' and ' + delivery + ', so an order must last the ' + fmtDays(lead) + ' of delivery plus the ' + fmtDays(review) + ' until the next order, plus ' + fmtDays(safety) + ' of safety cover: ' +
          fmtDays(targetDays) + ' of use = ' + qtyText(wanted, rm.unit),
        'On hand ' + qtyText(onHand, rm.unit) + (cover !== null ? ' (' + fmtDays(cover) + ' of use)' : '') +
          (orderQty > 0 ? ' -> order ' + qtyText(raw, rm.unit) + (orderQty !== round(raw, 1) ? ', rounded up to ' + qtyText(orderQty, rm.unit) + ' (lots of ' + lot + ')' : '') : ' -> nothing to order'),
        reason + '.'
      ];
      out.rows.push({ rmId: rm.id, name: rm.name, unit: rm.unit, storage: storage, dial: dial, vendorId: row.vendorId, vendorName: row.vendorName,
        onHand: round(onHand, 1), usePerDay: round(usePerDay, 2), recentUsePerDay: isNum(row.avgDailyUse) ? round(row.avgDailyUse, 2) : null,
        coverDays: cover === null ? null : round(cover, 1), leadDays: lead, reviewDays: review, rhythm: rhythm, delivery: delivery, safetyDays: safety, targetDays: targetDays, reorderDays: reorderDays,
        wantedQty: round(wanted, 1), orderQty: round(orderQty, 1), price: row.price, value: value, status: status, orderBy: orderBy, deliverBy: deliverBy, reason: reason, working: working });
      if (status === 'ORDER_TODAY') { out.totals.today.items += 1; out.totals.today.value += value; }
      else if (status === 'ORDER_THIS_WEEK') { out.totals.week.items += 1; out.totals.week.value += value; }
      else out.totals.later += 1;
    });
    var rank = { ORDER_TODAY: 0, ORDER_THIS_WEEK: 1, NO_ORDER: 2 };
    out.rows.sort(function (a, b) { return rank[a.status] - rank[b.status] || b.value - a.value || (a.name < b.name ? -1 : 1); });
    out.portionsPerDay = Math.round(mean(R.need.slice(0, MODEL.purchaseDays).map(function (n) { return n.portions; })));
    return out;
  };

  function fmtDays(v) { var whole = Math.abs(v - Math.round(v)) < 0.05, n = whole ? MK.fmt.num(Math.round(v)) : MK.fmt.num(v, 1); return n + (Math.abs(v - 1) < 0.05 ? ' day' : ' days'); }
  function qtyText(v, unit) { var n = Math.abs(v - Math.round(v)) < 0.05 ? MK.fmt.num(Math.round(v)) : MK.fmt.num(v, 1); return n + ' ' + (unit || 'kg'); }

  /* ---------------------------------------------------------------- Layer 3: a budget line at month-end */

  /* (sales to date + forecast of the rest) / sales to date for a unit, company-wide for the factory and head office */
  function salesRatio(unitId) {
    var Bx = base(), D = MK.dates, cal = MK.calendar, s = forecast.settings(), mdl = model(s.weeks);
    var outlets = [];
    Bx.outletIds.forEach(function (id, i) { if (unitId === 'factory' || unitId === 'ho' || unitId === 'all' || id === unitId) outlets.push(i); });
    if (!outlets.length) return null;
    var from = Bx.db.dayIdx(D.monthStart(cal.today)), toDate = 0, rest = 0, monthEnd = D.monthEnd(cal.today);
    for (var d = Math.max(0, from); d < Bx.ND; d++) outlets.forEach(function (o) { toDate += Bx.y[o][d]; });
    mdl.horizon.forEach(function (row) { if (row.date <= monthEnd) outlets.forEach(function (o) { rest += row.byOutlet[o]; }); });
    return toDate ? (toDate + rest) / toDate : null;
  }

  /**
   * lineProjection(unitId, categoryId, monthKey, billAmount) - where a budget line is heading by month-end, built on the
   * ledger accrual to date (what has been consumed, whether or not its bill has arrived):
   *   sales      lines that move with sales (cogs, channel costs, the factory's raw materials): accrual x the sales forecast
   *   plan-rest  everything else: the accrual to date plus the plan for the days left - the forecast adds nothing to a
   *              fixed line, and a one-off already accrued is counted once rather than run-rated
   *   plan       a line with no accrual yet: the larger of the bills so far and the plan
   * The bill under review is not added on top - its cost is already inside the accrual it documents - but its share of the
   * plan is returned for the sentence. Only the month in progress gets a projection; a complete month needs none.
   */
  forecast.lineProjection = function (unitId, categoryId, monthKey, billAmount) {
    var D = MK.dates, cal = MK.calendar;
    var out = { available: false, unitId: unitId, categoryId: categoryId, monthKey: monthKey, bill: isNum(billAmount) ? billAmount : 0, source: 'forecast' };
    if (!unitId || !categoryId || !monthKey || !MK.finance || typeof MK.finance.budget !== 'function') return out;
    if (monthKey !== D.monthKey(cal.today)) { out.reason = monthKey < D.monthKey(cal.today) ? 'complete' : 'future'; return out; }
    var b; try { b = MK.finance.budget(monthKey, unitId); } catch (e) { return out; }
    if (!b || !b.rows || !b.period || !b.period.partial) { out.reason = 'complete'; return out; }
    var row = null;
    for (var i = 0; i < b.rows.length; i++) if (b.rows[i].categoryId === categoryId) { row = b.rows[i]; break; }
    if (!row || !isNum(row.plan) || row.plan <= 0) { out.reason = 'no-line'; return out; }
    var variable = MODEL.variableGroups.indexOf(row.group) !== -1 || MODEL.variableCategories.indexOf(categoryId) !== -1;
    var accrued = row.actual || 0, used = row.used || 0, daysLeft = b.period.daysInMonth - b.period.elapsedDays, projected, method;
    if (!accrued) {
      projected = Math.max(used, row.plan); method = 'plan';
    } else if (variable) {
      var ratio = salesRatio(unitId);
      if (ratio === null) { out.reason = 'no-sales'; return out; }
      projected = Math.round(accrued * ratio); method = 'sales'; out.salesRatio = ratio;
    } else {
      projected = Math.round(accrued + row.plan * daysLeft / b.period.daysInMonth); method = 'plan-rest';
    }
    var policy = (MK.config && MK.config.budgetPolicy) || { warnAtPct: 0.9, overAtPct: 1 };
    var util = projected / row.plan;
    out.available = true;
    out.plan = row.plan; out.accrued = accrued; out.used = used; out.usedPct = used / row.plan; out.billShare = out.bill / row.plan;
    out.projected = projected; out.utilisation = util; out.method = method; out.basis = row.basis; out.group = row.group;
    out.daysDone = b.period.elapsedDays; out.daysLeft = daysLeft; out.daysInMonth = b.period.daysInMonth;
    out.monthEnd = b.period.monthKey + '-' + (b.period.daysInMonth < 10 ? '0' : '') + b.period.daysInMonth;
    out.status = util > policy.overAtPct ? 'OVER' : util >= policy.warnAtPct ? 'NEAR' : 'WITHIN';
    out.overBy = Math.max(0, projected - row.plan);
    out.settings = forecast.settings();
    return out;
  };

  /* ---------------------------------------------------------------- raw, for checks */

  forecast.raw = {
    model: MODEL,
    defaults: DEFAULTS,
    base: base,
    modelFor: model,
    eventFactor: function (outletId, iso, exAnte) { var Bx = base(); return eventFactorFor(Bx, Bx.outletIds.indexOf(outletId), iso, exAnte !== false); },
    rawMaterialNeed: function () { return rawMaterialNeed(model(forecast.settings().weeks)); },
    checksum: function () {
      var s = forecast.settings(), mdl = model(s.weeks);
      return MK.hash(JSON.stringify([s, mdl.level.map(function (v) { return Math.round(v); }), mdl.horizon.map(function (r) { return Math.round(sum(Array.prototype.slice.call(r.byOutlet))); }),
        Math.round(mdl.backtest.abs), Math.round(mdl.backtest.naiveAbs)]));
    },
    reset: function () { B = null; M = {}; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.MK;
})(typeof window !== 'undefined' ? window : globalThis);
