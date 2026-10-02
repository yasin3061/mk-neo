/*
 * Reconciliation, calibration and behaviour checks of the mockup's data layer (docs/RESEARCH.md section 9).
 *
 *   node tools/check-data.js          run every check; exit code 1 when any assertion fails
 *   node tools/check-data.js --hash   print the determinism hashes and the build timings of one fresh run as JSON (used by the main run)
 *   MK_DEMAND_SEED=mk-sales-v9 node tools/check-data.js    try a candidate demand seed without editing config.js: every band
 *                                     and every event assertion must hold before a new seed is adopted in MK.config.demand.seed
 *
 * The data files are classic browser scripts that also load under Node: they are required here in the
 * load order of index.html and attach to globalThis.MK. MK.store falls back to memory, so nothing is
 * written anywhere. No test framework: a failed assertion is a line in the report.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['js/core/kernel.js', 'js/data/config.js', 'js/data/engine.js', 'js/data/sales.js', 'js/data/finance.js', 'js/data/factory.js',
  'js/data/forecast.js', 'js/data/seed.js', 'js/data/workflow.js', 'js/data/insights.js'];

function ms(since) { return Number(process.hrtime.bigint() - since) / 1e6; }

const tLoad = process.hrtime.bigint();
FILES.forEach(function (f) { require(path.join(ROOT, f)); });
const MK = globalThis.MK;
const loadMs = ms(tLoad);
if (process.env.MK_DEMAND_SEED) MK.config.demand.seed = process.env.MK_DEMAND_SEED;   /* candidate seed; the child processes of section 8 inherit it */

/* ------------------------------------------------------------------ build + hashes */

const timing = { load: loadMs };
let t = process.hrtime.bigint(); MK.engine.run(); timing.engine = ms(t);
t = process.hrtime.bigint(); MK.finance.build(); timing.finance = ms(t);
t = process.hrtime.bigint(); const seedResult = MK.seed.apply(); timing.seed = ms(t);

const COLLS = ['vendors', 'bills', 'batches', 'audit'];
const DEFAULT_FILTER = { from: '2026-09-01', to: MK.calendar.dataEnd };   /* "This month", the filter the app opens with */

function storeJson() { return JSON.stringify(COLLS.map(function (n) { return MK.store.coll(n).all(); })); }
function hashes() {
  return { sales: MK.db.checksum, finance: MK.finance.raw.checksum(), factory: MK.factory.raw.checksum(),
    store: MK.hash(storeJson()), insights: MK.hash(JSON.stringify(MK.insights.list(DEFAULT_FILTER))), forecast: MK.forecast.raw.checksum() };
}

/* --hash also reports the build timings of its own fresh process: section 8 takes the best sample, so a busy machine does not fail the build-time check */
if (process.argv.indexOf('--hash') !== -1) { process.stdout.write(JSON.stringify(Object.assign(hashes(), { timing: timing }))); process.exit(0); }

/* ------------------------------------------------------------------------ reporting */

const D = MK.dates, fmt = MK.fmt, cfg = MK.config, db = MK.db, cal = MK.calendar;
const sections = [];
let current = null, failures = 0, passes = 0;

function section(title) { current = { title: title, lines: [], failed: 0, passed: 0 }; sections.push(current); }
function check(name, ok, detail) {
  if (ok) { passes++; current.passed++; } else { failures++; current.failed++; current.lines.push('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  return ok;
}
function eq(name, actual, expected) { return check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); }
function note(text) { current.lines.push('  ' + text); }
function sum(list, f) { let s = 0; for (let i = 0; i < list.length; i++) s += f ? f(list[i]) : list[i]; return s; }
function byId(list) { const m = {}; list.forEach(function (x) { m[x.id] = x; }); return m; }
function noThrow(name, fn) { try { return fn(); } catch (e) { check(name + ' does not throw', false, e && e.message); return undefined; } }
function as(userId, fn) { const before = MK.session.current().id; MK.session.set(userId); try { return fn(); } finally { MK.session.set(before); } }

const OUTLETS = MK.session.OUTLET_IDS, FULL = { from: cal.dataStart, to: cal.dataEnd };
MK.session.set('u_director');

/* ========================================================== 1. sales reconcile to the rupee */

section('1. Net sales agree across every dimension (RESEARCH 9.1)');
(function () {
  let cubeNet = 0, cubeOrders = 0;
  for (let d = 0; d < db.dims.ND; d++) for (let o = 0; o < db.dims.NO; o++) for (let s = 0; s < db.dims.NS; s++) { cubeNet += db.dayMeasure(d, o, s, 'netSales'); cubeOrders += db.dayMeasure(d, o, s, 'orders'); }
  const filters = { 'full year': FULL, 'August': { from: '2026-08-01', to: '2026-08-31' }, 'Andheri + Fort on Zomato, 10 Jul - 5 Sep': { from: '2026-07-10', to: '2026-09-05', outletIds: ['andheri', 'fort'], channelIds: ['zomato'] },
    'dine-in only, September': { from: '2026-09-01', to: '2026-09-16', mediumIds: ['dinein'] } };
  Object.keys(filters).forEach(function (label) {
    const f = filters[label], total = MK.data.summary(f);
    MK.data.DIMENSIONS.forEach(function (dim) {
      const b = MK.data.breakdown(f, dim);
      eq(label + ': net sales by ' + dim, sum(b.rows, function (r) { return r.netSales; }), total.netSales);
      if (!b.dishLevel) eq(label + ': orders by ' + dim, sum(b.rows, function (r) { return r.orders; }), total.orders);
    });
    const m = MK.data.matrix(f, 'outlet', 'channel', 'netSales');
    eq(label + ': outlet x channel matrix total', m.total, total.netSales);
    eq(label + ': matrix row totals', sum(m.rowTotals), total.netSales);
    eq(label + ': matrix column totals', sum(m.colTotals), total.netSales);
    const ser = MK.data.series(f, { measure: 'netSales', grain: 'week', by: 'stream' });
    eq(label + ': weekly series by stream', sum(ser.series, function (s) { return sum(s.values); }), total.netSales);
    eq(label + ': dishes() total', MK.data.dishes(f).totals.netSales, total.netSales);
  });
  eq('summary(full year) = raw day cube, net sales', MK.data.summary(FULL).netSales, cubeNet);
  eq('summary(full year) = raw day cube, orders', MK.data.summary(FULL).orders, cubeOrders);
  const s = MK.data.summary(FULL);
  eq('net sales = item value + packaging - restaurant discount', s.grossItemValue + s.packaging - s.restaurantDiscount, s.netSales);
  eq('GST = collected by restaurant + aggregator memo', s.gstCollectedByRestaurant + s.gstMemoAggregator, s.gst);
  /* every non-dish row carries the split, so no page has to present memo GST as the restaurant's own */
  let splitBad = 0, splitRows = 0;
  ['outlet', 'city', 'channel', 'medium', 'stream', 'slot', 'hour', 'dow', 'week', 'month'].forEach(function (dim) {
    const b = MK.data.breakdown(FULL, dim);
    b.rows.forEach(function (r) { splitRows++; if (typeof r.gstCollectedByRestaurant !== 'number' || r.gstCollectedByRestaurant + r.gstMemoAggregator !== r.gst) splitBad++; });
    if (sum(b.rows, function (r) { return r.gstMemoAggregator; }) !== s.gstMemoAggregator) splitBad++;
  });
  eq('breakdown rows whose GST split is missing or does not add up, of ' + splitRows, splitBad, 0);
  const byChannel = MK.data.breakdown(FULL, 'channel').rows;
  check('memo GST sits on the aggregators only, payable GST on the POS only', byChannel.every(function (r) { return r.id === 'petpooja' ? r.gstMemoAggregator === 0 && r.gstCollectedByRestaurant === r.gst : r.gstCollectedByRestaurant === 0 && r.gstMemoAggregator === r.gst; }));
  eq('matrix accepts the split as a measure', MK.data.matrix(FULL, 'outlet', 'channel', 'gstMemoAggregator').total, s.gstMemoAggregator);
  /* filter reading: a single id as a string is that id, not "all"; an out-of-range request echoes a range that does not cross */
  const august = { from: '2026-08-01', to: '2026-08-31' };
  eq('outletIds given as a string selects that outlet', MK.data.summary(Object.assign({ outletIds: 'bandra' }, august)).netSales, MK.data.summary(Object.assign({ outletIds: ['bandra'] }, august)).netSales);
  eq('channelIds given as a string selects that channel', MK.data.summary(Object.assign({ channelIds: 'zomato' }, august)).netSales, MK.data.summary(Object.assign({ channelIds: ['zomato'] }, august)).netSales);
  [{ from: '2030-01-01', to: '2030-12-31' }, { from: '2020-01-01', to: '2020-02-01' }].forEach(function (f) {
    const r = MK.data.summary(f);
    check('range outside the data is echoed clamped and empty (' + f.from + ')', r.from <= r.to && r.from >= cal.dataStart && r.to <= cal.dataEnd && r.netSales === 0 && r.days === 0, r.from + ' .. ' + r.to);
  });
  /* Swiggy's discount split is provisional past the last annexure; the note says from when */
  eq('provisional note: September', JSON.stringify((MK.data.summary(DEFAULT_FILTER).provisional || {}).swiggyDiscountSplitFrom), JSON.stringify(D.addDays(cfg.channelTerms.swiggy.settledThrough, 1)));
  check('provisional note: on every sales result of the range', ['breakdown', 'matrix', 'series', 'dishes'].every(function (k) {
    const r = k === 'breakdown' ? MK.data.breakdown(DEFAULT_FILTER, 'channel') : k === 'matrix' ? MK.data.matrix(DEFAULT_FILTER, 'outlet', 'channel', 'netSales') : k === 'series' ? MK.data.series(DEFAULT_FILTER, {}) : MK.data.dishes(DEFAULT_FILTER);
    return r.provisional && r.provisional.swiggyDiscountSplitFrom > cfg.channelTerms.swiggy.settledThrough; }));
  eq('provisional note: none for a settled month', MK.data.summary(august).provisional, null);
  eq('provisional note: none without Swiggy', MK.data.summary({ from: '2026-09-01', to: '2026-09-16', channelIds: ['petpooja', 'zomato'] }).provisional, null);
  check('channels: order data always comes from the POS; the statement source is named apart', cfg.channels.every(function (c) {
    return c.salesSource === 'petpooja' && (c.kind === 'aggregator' ? c.statementSource === cfg.channelTerms[c.id].statementSource : c.statementSource === null); }) &&
    ['summary', 'breakdown'].every(function (k) { return (k === 'summary' ? MK.data.summary(FULL) : MK.data.breakdown(FULL, 'channel')).source === 'petpooja'; }));
  note('grand total ' + fmt.inrFull(cubeNet) + ' net sales, ' + fmt.num(cubeOrders) + ' orders over ' + db.dims.ND + ' business days');
})();

/* ===================================================== 2. recent orders aggregate to the cube */

section('2. recentOrders aggregate exactly to the cube (RESEARCH 9.2)');
(function () {
  const cells = {};
  db.recentOrders.forEach(function (o) {
    const k = o.businessDate + '|' + o.outletId + '|' + o.streamId, c = cells[k] || (cells[k] = { orders: 0, cancelled: 0, net: 0, gst: 0 });
    if (o.status === 'cancelled') c.cancelled++; else c.orders++;
    c.net += o.netSales; c.gst += o.gst.amount;
  });
  let bad = 0, n = 0;
  D.range(db.recentFrom, db.recentTo).forEach(function (date) {
    const d = db.dayIdx(date);
    db.outletIds.forEach(function (oid, o) { db.streamIds.forEach(function (sid, s) {
      const c = cells[date + '|' + oid + '|' + sid] || { orders: 0, cancelled: 0, net: 0, gst: 0 }; n++;
      if (c.orders !== db.dayMeasure(d, o, s, 'orders') || c.cancelled !== db.dayMeasure(d, o, s, 'cancelled') || c.net !== db.dayMeasure(d, o, s, 'netSales') || c.gst !== db.dayMeasure(d, o, s, 'gst')) bad++;
    }); });
  });
  eq('cells (day x outlet x stream) that differ from the cube, of ' + n, bad, 0);
  eq('window is the last 14 business days', D.diffDays(db.recentFrom, db.recentTo) + 1, 14);
  eq('window ends on the last data day', db.recentTo, cal.dataEnd);
  const sel = MK.data.recentOrders({ from: db.recentFrom, to: db.recentTo }, { limit: 5 });
  eq('selector total = raw list', sel.total, db.recentOrders.length);
  eq('selector sum of netSales = summary', sum(db.recentOrders, function (o) { return o.netSales; }), MK.data.summary({ from: db.recentFrom, to: db.recentTo }).netSales);
})();

/* ========================================================= 3. payout cycles and their fees */

section('3. Payout cycles reconcile with their orders (RESEARCH 9.3)');
(function () {
  const F = db.F, NF = db.dims.NF, NO = db.dims.NO, NA = db.dims.NA;
  function cubeSums(p) {
    const o = db.index.outlet[p.outletId], a = db.index.aggregator[p.channelId], out = { grossValue: 0, discount: 0, netSales: 0, gst: 0, serviceFee: 0, collectionFee: 0, otherFees: 0, gstOnFees: 0, tds: 0, orders: 0 };
    for (let d = 0; d < db.dims.ND; d++) for (let part = 0; part < 2; part++) {
      const date = D.addDays(db.days[d], part);
      if (date < p.period.from || date > p.period.to) continue;
      const base = (((d * NO + o) * NA + a) * 2 + part) * NF;
      Object.keys(out).forEach(function (k) { out[k] += db.feeCube[base + F[k]]; });
    }
    return out;
  }
  let arithmetic = 0, feeLines = 0, settled = 0, memo = 0;
  db.payouts.forEach(function (p) {
    [p.statement, p.expected].forEach(function (b) {
      if (b && b.netPayout !== b.netBillValue - b.serviceFee - b.collectionFee - b.gstOnFees - b.tds - b.ads - b.refundsAndCancellations - b.otherDeductions) arithmetic++;
    });
    if (!p.statement) return;
    settled++;
    const c = cubeSums(p), s = p.statement;
    if (c.serviceFee !== s.serviceFee || c.collectionFee !== s.collectionFee || c.gstOnFees !== s.gstOnFees || c.tds !== s.tds || c.netSales !== s.netBillValue ||
      c.grossValue !== s.grossValue || c.discount !== s.restaurantDiscount || c.otherFees !== s.otherDeductionsDetail.platformFees || c.orders !== p.orderCount) feeLines++;
    if (c.gst !== s.gstRetained9_5) memo++;
  });
  eq('cycles whose net payout arithmetic fails (statement and expected blocks)', arithmetic, 0);

  /* TDS is 0.1% of the net bill value of every statement, to the rupee */
  let tdsAll = 0, nbvAll = 0, tdsOff = 0;
  db.payouts.forEach(function (p) { const b = p.statement || p.expected; tdsAll += b.tds; nbvAll += b.netBillValue; if (Math.abs(b.tds - cfg.channelTerms[p.channelId].tdsPct * b.netBillValue) > 0.5 + 1e-6) tdsOff++; });
  eq('cycles whose TDS line is not round(0.1% x net bill value)', tdsOff, 0);
  check('TDS over all cycles is 0.1% of net bill value', tdsAll / nbvAll > 0.00099 && tdsAll / nbvAll < 0.00101, (tdsAll / nbvAll * 100).toFixed(4) + '%');

  /* a row says where its figures come from: a statement once there is one, an estimate until then */
  eq('payout rows whose source disagrees with the presence of a statement', db.payouts.filter(function (p) { return (p.source === 'estimate') !== !p.statement || p.statementSource !== cfg.channelTerms[p.channelId].statementSource || (p.statement && p.source !== p.statementSource); }).length, 0);

  /* order-level fees: one definition of totalDeductions (TDS is a tax credit, on its own line) */
  const feeOrders = db.recentOrders.filter(function (o) { return o.fees; });
  eq('orders whose totalDeductions is not service + collection + other + GST on fees', feeOrders.filter(function (o) { const f = o.fees; return f.totalDeductions !== f.serviceFee + f.collectionFee + f.otherFees + f.gstOnFees || f.netReceivable !== o.netSales - f.totalDeductions - f.tds; }).length, 0);
  /* the long-distance fee of an unsettled order is an expected value, never an order-specific charge */
  const ld = cfg.channelTerms.zomato.longDistanceFee, estZomato = feeOrders.filter(function (o) { return o.channelId === 'zomato' && o.fees.kind === 'estimated'; });
  check('estimated Zomato orders carry no order-specific long-distance fee', estZomato.length > 500 && estZomato.every(function (o) { return o.fees.otherFees < ld.min; }), 'max ' + Math.max.apply(null, estZomato.map(function (o) { return o.fees.otherFees; })));
  const ldPerOrder = sum(estZomato, function (o) { return o.fees.otherFees; }) / estZomato.length, ldExpected = ld.orderShare * (ld.min + ld.max) / 2;
  check('their estimate averages the expected fee per order', Math.abs(ldPerOrder - ldExpected) < 0.05, ldPerOrder.toFixed(3) + ' vs ' + ldExpected);
  check('settled Zomato orders still show the fee that was charged', feeOrders.some(function (o) { return o.channelId === 'zomato' && o.fees.kind === 'actual' && o.fees.otherFees >= ld.min; }));

  /* the ads estimate of an unsettled cycle ignores the cycles the spike rule flags */
  const kpSwiggy = db.payouts.filter(function (p) { return p.outletId === 'koregaon' && p.channelId === 'swiggy'; }), kpOpen = kpSwiggy[kpSwiggy.length - 1];
  const planned = cfg.aggregatorAds.pctOfMenuValue.koregaon, estShare = kpOpen.expected.ads / kpOpen.expected.grossValue;
  check('Koregaon Park Swiggy: the open cycle is estimated at the usual ads share, not at the doubled one', !kpOpen.statement && estShare > planned * (1 - cfg.aggregatorAds.cycleNoise) && estShare < planned * (1 + cfg.aggregatorAds.cycleNoise), (estShare * 100).toFixed(2) + '%');
  eq('settled cycles whose statement lines differ from the sum of their orders, of ' + settled, feeLines, 0);
  eq('settled cycles whose section 9(5) GST memo differs from their orders', memo, 0);

  /* order-level actual fees for cycles that lie fully inside the 14-day order window */
  const byPayout = {};
  db.recentOrders.forEach(function (o) { if (o.payoutId && o.fees) (byPayout[o.payoutId] || (byPayout[o.payoutId] = [])).push(o); });
  let orderLevel = 0, orderCycles = 0, kinds = 0;
  db.payouts.forEach(function (p) {
    const orders = byPayout[p.id] || [];
    orders.forEach(function (o) { if ((o.fees.kind === 'actual') !== !!p.statement) kinds++; });
    if (!p.statement || p.period.from <= db.recentFrom) return;   /* orders after midnight of the first window day belong to the day before */
    orderCycles++;
    const s = p.statement;
    if (sum(orders, function (o) { return o.fees.serviceFee; }) !== s.serviceFee || sum(orders, function (o) { return o.fees.collectionFee; }) !== s.collectionFee ||
      sum(orders, function (o) { return o.fees.gstOnFees; }) !== s.gstOnFees || sum(orders, function (o) { return o.fees.tds; }) !== s.tds) orderLevel++;
  });
  check('at least five settled cycles can be rebuilt from order objects', orderCycles >= 5, 'found ' + orderCycles);
  eq('cycles whose order-level actual fees differ from the statement, of ' + orderCycles, orderLevel, 0);
  eq('orders whose fees.kind disagrees with the settlement state of their cycle', kinds, 0);

  let aggNet = 0;
  for (let d = 0; d < db.dims.ND; d++) for (let o = 0; o < NO; o++) db.streamIds.forEach(function (sid, s) { if (byId(cfg.streams)[sid].channelId !== 'petpooja') aggNet += db.dayMeasure(d, o, s, 'netSales'); });
  eq('sum of net bill value over all cycles = aggregator net sales', sum(db.payouts, function (p) { return (p.statement || p.expected).netBillValue; }), aggNet);

  /* feasibility: what is settled on the demo date */
  eq('Swiggy settled through', cfg.channelTerms.swiggy.settledThrough, '2026-09-12');
  eq('Zomato settled through', cfg.channelTerms.zomato.settledThrough, '2026-09-06');
  const late = db.payouts.filter(function (p) { return p.statement && p.period.to > cfg.channelTerms[p.channelId].settledThrough; });
  eq('cycles with a statement beyond the settled-through date', late.length, 0);
  eq('Zomato 7-13 Sep is awaiting its statement at every outlet', db.payouts.filter(function (p) { return p.channelId === 'zomato' && p.period.from === '2026-09-07' && p.status === 'AWAITING_STATEMENT'; }).length, OUTLETS.length);

  /* the three seeded statement exceptions are found by rule */
  const disputed = db.payouts.filter(function (p) { return p.status === 'DISPUTED'; }), shortPaid = db.payouts.filter(function (p) { return p.status === 'SHORT_PAID'; });
  check('one disputed cycle: Swiggy at Bandra, 23-29 Aug, about Rs 14,800', disputed.length === 1 && disputed[0].outletId === 'bandra' && disputed[0].channelId === 'swiggy' && disputed[0].period.from === '2026-08-23' && Math.abs(disputed[0].variance - 14800) <= 200,
    JSON.stringify(disputed.map(function (p) { return [p.id, p.variance]; })));
  check('two short-paid cycles: Zomato at Fort charged 24% against 22%', shortPaid.length === 2 && shortPaid.every(function (p) { return p.outletId === 'fort' && p.channelId === 'zomato' && Math.abs(p.statement.serviceFeePct - 0.24) < 0.002; }),
    JSON.stringify(shortPaid.map(function (p) { return [p.id, p.statement.serviceFeePct]; })));
  const flags = MK.data.auditFlags(FULL).flags;
  check('ads spike flagged for Swiggy at Koregaon Park', flags.some(function (x) { return x.type === 'ads' && x.outletId === 'koregaon' && x.channelId === 'swiggy'; }));
  check('stale aggregator price flagged for mutton seekh', flags.some(function (x) { return x.type === 'markup' && x.dishId === 'mutton_seekh' && x.severity === 'high' && x.data.stalePriceChange; }));
  const ce = MK.data.channelEconomics(FULL);
  eq('channel economics: actual + estimated net sales = aggregator net sales', ce.total.actual.netSales + ce.total.estimated.netSales, aggNet);

  /* whole-rupee roll-ups: channels = outlets = total for every money key, and a month = the sum of its days */
  const MONEY = ['grossValue', 'restaurantDiscount', 'netSales', 'gstMemo', 'serviceFee', 'collectionFee', 'otherFees', 'gstOnFees', 'tds', 'ads', 'refunds', 'unclassified', 'otherDeductions', 'totalDeductions', 'netPayout'];
  let rollBad = 0, rollChecked = 0;
  const weeks = []; for (let w = D.weekStart(cal.dataStart); w <= cal.dataEnd; w = D.addDays(w, 7)) weeks.push({ from: D.max(w, cal.dataStart), to: D.min(D.addDays(w, 6), cal.dataEnd) });
  weeks.concat([FULL, { from: '2026-08-01', to: '2026-08-31' }, DEFAULT_FILTER]).forEach(function (f) {
    const r = MK.data.channelEconomics(f);
    ['actual', 'estimated'].forEach(function (kind) { MONEY.forEach(function (k) {
      rollChecked++;
      if (sum(r.channels, function (c) { return c[kind][k]; }) !== r.total[kind][k] || sum(r.byOutlet, function (o) { return o[kind][k]; }) !== r.total[kind][k]) rollBad++;
      if (!Number.isInteger(r.total[kind][k])) rollBad++;
    }); });
  });
  eq('channel economics roll-ups (channels, outlets) that differ from the total, of ' + rollChecked, rollBad, 0);
  const augDays = D.range('2026-08-01', '2026-08-31').map(function (d) { return MK.data.channelEconomics({ from: d, to: d }).total.actual; }), augMonth = MK.data.channelEconomics({ from: '2026-08-01', to: '2026-08-31' }).total.actual;
  eq('August = the sum of its days (ads, refunds, unclassified, net payout)', JSON.stringify(['ads', 'refunds', 'unclassified', 'netPayout'].map(function (k) { return sum(augDays, function (b) { return b[k]; }); })),
    JSON.stringify(['ads', 'refunds', 'unclassified', 'netPayout'].map(function (k) { return augMonth[k]; })));

  /* no statement in the range: nothing is presented as an actual */
  const tail = MK.data.channelEconomics({ from: '2026-09-14', to: '2026-09-16' }), RATES = ['serviceFeePct', 'contractedServiceFeePct', 'contractedTakeRate', 'effectiveTakeRate', 'allInCostPctOfMenu', 'realisationPctOfMenu'];
  check('14-16 Sep: the actual block has no data, null rates, no statement source and no waterfall', tail.total.actual.hasData === false && RATES.every(function (k) { return tail.total.actual[k] === null; }) &&
    tail.sources.actual.length === 0 && tail.waterfall.length === 0 && tail.total.estimated.hasData && tail.total.estimated.effectiveTakeRate > 0.2);
  const last7 = MK.data.channelEconomics({ from: '2026-09-10', to: '2026-09-16' }), z7 = last7.channels.filter(function (c) { return c.channelId === 'zomato'; })[0];
  check('last 7 days: Zomato has no actual block, and only the Swiggy annexure is named as a source', z7.actual.hasData === false && z7.actual.effectiveTakeRate === null && z7.actualThrough === null &&
    last7.sources.actual.join() === 'swiggy_annexure' && last7.actualThrough.swiggy === cfg.channelTerms.swiggy.settledThrough && last7.waterfall.length > 0);

  /* markup audit: the flag is the RESEARCH rule, the rupees use the realisation formula with the prices of each day */
  const af = MK.data.auditFlags(DEFAULT_FILTER), markup = af.flags.filter(function (x) { return x.type === 'markup'; });
  check('markup flags: every listed outlet has a markup below its take rate and realises less than the POS price',
    markup.length > 0 && markup.every(function (x) { return x.data.outlets.every(function (o) { return o.markupPct < o.effectiveTakeRate && o.realisationPerPortion < o.posPrice &&
      Math.abs(o.realisationPerPortion - o.aggPrice * (1 - o.discountPct) * (1 - o.effectiveTakeRate)) < 1e-9 && o.markupPct < o.breakEvenMarkupPct; }) && Math.abs(x.amount - sum(x.data.outlets, function (o) { return o.amount; })) <= x.data.outlets.length; }));
  const ms = af.markupSummary;
  check('markup summary: listings below break-even include every flagged one, and say how many there are in all', ms.listings >= ms.belowBreakEven && ms.belowBreakEven >= ms.belowTakeRate &&
    ms.belowTakeRate === sum(markup, function (x) { return x.data.outlets.length; }) && ms.lostRealisation >= sum(markup, function (x) { return x.amount; }) - markup.length, JSON.stringify(ms));
  const window8 = MK.insights.window(DEFAULT_FILTER), seekh = MK.data.auditFlags({ from: window8.from, to: window8.to }).flags.filter(function (x) { return x.dishId === 'mutton_seekh'; })[0];
  let seekhExpected = 0;
  seekh.data.outlets.forEach(function (o) {
    const oi = db.index.outlet[o.outletId], di = db.index.dish.mutton_seekh, keep = (1 - o.discountPct) * (1 - o.effectiveTakeRate);
    for (let d = db.dayIdx(window8.from); d <= db.dayIdx(window8.to); d++) db.streamIds.forEach(function (sid, si) {
      if (byId(cfg.streams)[sid].channelId === 'petpooja') return;
      seekhExpected += db.dishQty(d, oi, si, di) * Math.max(0, MK.data.posPriceOn('mutton_seekh', db.days[d]) - MK.data.aggPriceOn('mutton_seekh', o.outletId, db.days[d]) * keep);
    });
  });
  eq('mutton seekh impact uses the POS price in force on each day (Rs 450 before 1 Aug, Rs 480 after)', seekh.amount, Math.round(seekhExpected));
  check('take-rate evidence ends where the statements end', af.takeRates.length === OUTLETS.length && af.takeRates.every(function (t) {
    return t.windowTo === cfg.channelTerms.swiggy.settledThrough && t.requestedTo === cal.dataEnd && t.settledThrough.zomato === cfg.channelTerms.zomato.settledThrough && t.breakEvenMarkupPct > t.effectiveTakeRate; }));
  note(db.payouts.length + ' cycles: ' + ['MATCHED', 'SHORT_PAID', 'DISPUTED', 'AWAITING_STATEMENT', 'IN_CYCLE'].map(function (s) { return db.payouts.filter(function (p) { return p.status === s; }).length + ' ' + s; }).join(', '));
})();

/* ================================================ 4 + 5. factory / outlet tie-out, factory P&L */

section('4-5. Factory dispatch = outlet factory-sourced food cost; factory P&L identities (RESEARCH 9.4, 9.5)');
(function () {
  let cogs = 0, logistics = 0, pnlBad = 0, varBad = 0, rmBad = 0, company = 0, foodBad = 0, salesBad = 0, feeBad = 0;
  cfg.months.forEach(function (mk) {
    const info = MK.finance.raw.monthInfo(mk), range = { from: info.from, to: info.to }, disp = byId(MK.factory.dispatch(range).outlets), p = MK.factory.pnl(mk);
    let transfer = 0;
    OUTLETS.forEach(function (o) {
      const lines = MK.finance.raw.ledger({ unitId: o, monthKey: mk });
      const factorySourced = sum(lines.filter(function (l) { return l.categoryId === 'cogs_factory' || (l.categoryId === 'cogs_variance' && l.component === 'factory'); }), function (l) { return l.amount; });
      if (factorySourced !== MK.factory.raw.dispatchToOutlet(mk, o).value || factorySourced !== disp[o].transferValue) cogs++;
      transfer += factorySourced;
      const fc = MK.finance.foodCost(mk, o).rows[0], pl = MK.finance.pnl(o, mk);
      if (fc.actual !== pl.totals.foodCost || fc.actualFactory !== factorySourced) foodBad++;
      if (pl.totals.netSales !== db.monthlyMeasure(mk, o, null, 'netSales')) salesBad++;
      /* aggregator lines: one per channel, category and kind (statement | estimate), each the rounded figure of the sales layer */
      db.aggregatorIds.forEach(function (ch) {
        const fees = db.feesByMonth(mk, o, ch);
        [['actual', false], ['estimated', true]].forEach(function (kind) {
          const f = fees[kind[0]], want = { agg_commission: f.serviceFee, agg_collection: f.collectionFee, agg_other: Math.round(f.otherFees) + Math.round(f.unclassified), agg_gst_on_fees: f.gstOnFees, agg_ads: f.ads, agg_refunds: f.refunds };
          Object.keys(want).forEach(function (cat) {
            const got = sum(lines.filter(function (l) { return l.categoryId === cat && l.channelId === ch && l.estimated === kind[1]; }), function (l) { return l.amount; });
            if (got !== Math.round(want[cat])) feeBad++;
          });
        });
      });
    });
    if (transfer !== p.transferValue) cogs++;
    const allocated = sum(MK.finance.raw.ledger({ unitId: 'outlets', monthKey: mk, categoryId: 'logistics_allocation' }), function (l) { return l.amount; });
    if (allocated !== p.logisticsRecovery || allocated !== p.logisticsCost) logistics++;
    if (p.transferValue + p.logisticsRecovery - p.rmConsumed - p.conversion.total - p.logisticsCost !== p.absorption) pnlBad++;
    if (p.rmConsumed + p.conversion.total + p.logisticsCost !== p.totalCost) pnlBad++;
    if (sum(Object.keys(p.variance), function (k) { return p.variance[k]; }) !== p.absorption) varBad++;
    if (sum(MK.finance.raw.ledger({ unitId: 'factory', monthKey: mk, categoryId: 'raw_materials' }), function (l) { return l.amount; }) !== p.rmConsumed) rmBad++;
    if (MK.factory.costing(mk).totals.rmCost !== p.rmConsumed) rmBad++;
    /* company EBITDA = outlets + factory absorption - head office */
    const all = MK.finance.pnl('all', mk).totals, outletsEbitda = sum(OUTLETS, function (o) { return MK.finance.pnl(o, mk).totals.ebitda; }), ho = MK.finance.pnl('ho', mk).totals;
    if (all.ebitda !== outletsEbitda + p.absorption + ho.ebitda) company++;
  });
  eq('outlet-months where factory-sourced food cost differs from the dispatch value', cogs, 0);
  eq('outlet-months where P&L food cost differs from foodCost()', foodBad, 0);
  eq('outlet-months where P&L net sales differ from the sales cube', salesBad, 0);
  eq('aggregator cost lines (outlet x month x channel x category x statement / estimate) that differ from the payout data', feeBad, 0);
  eq('months where the logistics pool is not charged out to the rupee', logistics, 0);
  eq('months where transfer value + recovery - costs differs from absorption', pnlBad, 0);
  eq('months where the variance analysis does not add up to absorption', varBad, 0);
  eq('months where raw materials consumed differ between ledger, costing and factory P&L', rmBad, 0);
  eq('months where company EBITDA differs from outlets + absorption - head office', company, 0);

  /* actual and estimated never blend: every selector that returns September aggregator costs says how much of them is an estimate */
  let estBad = 0, estChecked = 0;
  OUTLETS.concat(['outlets', 'all']).forEach(function (sel) {
    cfg.months.forEach(function (mk) {
      const want = MK.finance.pnl(sel, mk).totals.estimatedPart, ue = MK.finance.unitEconomics(sel, mk), bd = MK.finance.budget(mk, sel), cc = MK.finance.costCentreSpend(mk);
      estChecked++;
      if (ue.estimatedPart !== want || sum(ue.byStream, function (x) { return x.estimatedPart; }) !== want || bd.totals.estimatedPart !== want) estBad++;
      if (Math.abs(ue.perOrder.channelCostsEstimated * ue.orders - want) > 1e-6 || ue.breakEven.estimatedPart !== want) estBad++;
      if (sel === 'all' && (cc.estimatedPart !== want || cc.tree.estimatedPart !== want || sum(cc.tree.children, function (n) { return n.estimatedPart; }) !== want)) estBad++;
      /* an estimate is never reported as committed or actual */
      bd.rows.forEach(function (r) { if (r.estimatedPart && (r.used !== r.committed + r.pipeline + r.estimatedPart || r.actual + r.estimatedPart !== sum(MK.finance.raw.ledger({ unitIds: bd.unitIds, monthKey: mk, categoryId: r.categoryId }), function (l) { return l.amount; }))) estBad++; });
    });
  });
  eq('unit economics / budget / cost centres whose estimated part differs from the P&L, of ' + estChecked, estBad, 0);
  const sepAll = MK.finance.pnl('all', '2026-09').totals;
  check('September carries an estimated tail and every result names the sources', sepAll.estimatedPart > 0 && [MK.finance.unitEconomics('all', '2026-09'), MK.finance.budget('2026-09', 'all'), MK.finance.costCentreSpend('2026-09')].every(function (r) {
    return r.sources && r.sources.aggregatorEstimated === 'estimate' && r.sources.costs === 'erp'; }));
  check('budget rows say their basis in their own words, not in the source-tag vocabulary', MK.finance.budget('2026-08', 'all').rows.every(function (r) { return r.source === undefined && ['bills', 'bills+ledger', 'ledger'].indexOf(r.basis) !== -1; }));

  /* whole-rupee roll-ups of the unit economics: the streams add up to the P&L lines */
  let streamBad = 0;
  OUTLETS.concat(['outlets']).forEach(function (sel) { cfg.months.forEach(function (mk) {
    const ue = MK.finance.unitEconomics(sel, mk), t = MK.finance.pnl(sel, mk).totals;
    if (sum(ue.byStream, function (x) { return x.foodCost; }) !== t.foodCost || sum(ue.byStream, function (x) { return x.packaging; }) !== t.cogs - t.foodCost ||
      sum(ue.byStream, function (x) { return x.channelCosts; }) !== t.channelCosts || sum(ue.byStream, function (x) { return x.netSales; }) !== t.netSales) streamBad++;
  }); });
  eq('outlet-months whose stream roll-up differs from the P&L (food cost, packaging, channel costs, net sales)', streamBad, 0);

  /* one definition of food cost: the dish table of the sales layer = foodCost() of the finance layer (packaging is carried apart) */
  let dishBad = 0;
  ['2026-05', '2026-08'].forEach(function (mk) {
    const info = MK.finance.raw.monthInfo(mk), dz = MK.data.dishes({ from: info.from, to: info.to }), fc = MK.finance.foodCost(mk), fcDish = byId(fc.dishes.map(function (x) { return { id: x.dishId, x: x }; }));
    dz.rows.forEach(function (r) {
      if (Math.abs(r.costPerPortion - fcDish[r.id].x.costPerPortion) > 1e-6 || Math.abs(r.foodCostPct - fcDish[r.id].x.foodCostPct) > 1e-9) dishBad++;
      if (r.contribution !== r.netSales - r.theoreticalCost || r.contributionAfterPackaging !== r.contribution - r.packagingCost || !(r.packagingCost > 0)) dishBad++;
    });
    if (Math.abs(sum(dz.rows, function (r) { return r.theoreticalCost; }) - fc.totals.theoretical) > 60) dishBad++;   /* whole-rupee rounding of 12 dishes and of the ledger lines */
  });
  eq('dishes whose food cost differs between MK.data.dishes() and MK.finance.foodCost()', dishBad, 0);

  /* stock reconciles: opening + good output - dispatch - write-offs = closing, for every SKU */
  const st = MK.factory.raw.state(); let stock = 0;
  for (let k = 0; k < st.NK; k++) {
    let bal = st.openingHg[k];
    for (let d = 0; d < st.ND; d++) {
      bal += st.goodHg[d * st.NK + k] - st.expiredHg[d * st.NK + k] - st.qaHg[d * st.NK + k];
      for (let o = 0; o < st.NO; o++) bal -= st.dispatchHg[(d * st.NO + o) * st.NK + k];
      if (bal !== st.closingHg[d * st.NK + k]) { stock++; break; }
    }
  }
  eq('finished-goods SKUs whose daily stock does not reconcile', stock, 0);
  let rmStock = 0;
  for (let r = 0; r < st.NR; r++) {
    let bal = st.rmOpening[r];
    for (let d = 0; d < st.ND; d++) { bal += st.rmBuyQty[d * st.NR + r] - st.rmUse[d * st.NR + r]; if (Math.abs(bal - st.rmStockEnd[d * st.NR + r]) > 1e-6) { rmStock++; break; } }
  }
  eq('raw materials whose daily stock does not reconcile', rmStock, 0);
})();

/* ============================================================= 6. seed: bills vs the ledger */

const bills = MK.store.coll('bills').all(), batches = MK.store.coll('batches').all(), vendors = MK.store.coll('vendors').all(), audit = MK.store.coll('audit').all();
const vendorById = byId(vendors), billById = byId(bills);
const COMPLETE_BILL_MONTHS = cfg.months.filter(function (m) { return m >= MK.seed.params.billsFromMonth && !MK.finance.raw.monthInfo(m).partial; });

function isExtra(b) { return b.status === 'REJECTED' || b.flags.indexOf('DUPLICATE_INVOICE') !== -1; }
/* what a bill costs by category: amount + GST (no input credit), allocated by its expense lines */
function partsOf(b) { return MK.workflow.bill.expenseParts(b); }

section('6a. Seeded bills tie out to the ledger (RESEARCH 9.6)');
(function () {
  check('seed applied', seedResult.ok && seedResult.seeded, JSON.stringify(seedResult));
  eq('complete billed months', COMPLETE_BILL_MONTHS.join(','), '2026-07,2026-08');
  const fromBills = {}, fromLedger = {};
  bills.forEach(function (b) {
    if (isExtra(b) || COMPLETE_BILL_MONTHS.indexOf(b.monthKey) === -1) return;
    partsOf(b).forEach(function (p) { const k = b.unitId + '|' + p.categoryId + '|' + b.monthKey; fromBills[k] = (fromBills[k] || 0) + p.amount; });
  });
  MK.finance.raw.ledger({ billableOnly: true }).forEach(function (l) {
    if (COMPLETE_BILL_MONTHS.indexOf(l.monthKey) === -1) return;
    const k = l.unitId + '|' + l.categoryId + '|' + l.monthKey; fromLedger[k] = (fromLedger[k] || 0) + l.amount;
  });
  const keys = Object.keys(fromLedger), off = keys.filter(function (k) { return fromBills[k] !== fromLedger[k]; });
  check('every unit x category x month of billable ledger lines has bills of exactly that value (' + keys.length + ' cells)', off.length === 0,
    off.slice(0, 5).map(function (k) { return k + ': bills ' + (fromBills[k] || 0) + ' vs ledger ' + fromLedger[k]; }).join('; '));
  const stray = Object.keys(fromBills).filter(function (k) { return fromLedger[k] === undefined; });
  eq('bill cells without a ledger line', stray.length, 0);
  eq('bills before the first billed month', bills.filter(function (b) { return b.monthKey < MK.seed.params.billsFromMonth; }).length, 0);

  /* the open month never bills more than the month can cost */
  const sepOver = [];
  const sepBills = {}, sepLedger = {};
  bills.forEach(function (b) { if (!isExtra(b) && b.monthKey === '2026-09') partsOf(b).forEach(function (p) { const k = b.unitId + '|' + p.categoryId; sepBills[k] = (sepBills[k] || 0) + p.amount; }); });
  MK.finance.raw.ledger({ billableOnly: true, monthKey: '2026-09' }).forEach(function (l) { const k = l.unitId + '|' + l.categoryId; sepLedger[k] = (sepLedger[k] || 0) + (l.fullMonthAmount !== null ? l.fullMonthAmount : l.amount); });
  Object.keys(sepBills).forEach(function (k) { if (sepBills[k] > (sepLedger[k] || 0) + 2) sepOver.push(k + ' ' + sepBills[k] + ' > ' + sepLedger[k]); });
  check('September bills stay within the month\'s ledger lines (full-month figure for fixed lines)', sepOver.length === 0, sepOver.slice(0, 4).join('; '));

  /* GST is a cost: nothing sits in payables that the ledger does not carry */
  const closed = bills.filter(function (b) { return !isExtra(b) && COMPLETE_BILL_MONTHS.indexOf(b.monthKey) !== -1; });
  eq('closed months: amount + GST of the bills = the billable ledger lines', sum(closed, function (b) { return b.amount + b.gstAmount; }),
    sum(MK.finance.raw.ledger({ billableOnly: true }).filter(function (l) { return COMPLETE_BILL_MONTHS.indexOf(l.monthKey) !== -1; }), function (l) { return l.amount; }));
  const lpg = bills.filter(function (b) { return b.categoryId === 'gas_lpg' && b.unitId === 'bandra' && b.monthKey === '2026-08'; });
  eq('LPG is billed at the all-in cylinder price (GST inside it, not on top)', sum(lpg, function (b) { return b.amount + b.gstAmount; }), Math.round(cfg.outletCosts.bandra.lpgCylinders * cfg.tariffs.lpgCylinder19kg[cfg.months.indexOf('2026-08')]));
  check('GST is charged at the rate of the supply', bills.every(function (b) { return b.gstAmount <= Math.ceil(b.amount * 0.18) + 1; }) && bills.some(function (b) { return b.vendorId === 'v_poultry' && b.gstAmount === 0; }) && bills.some(function (b) { return b.vendorId === 'v_dairy' && b.gstAmount > 0; }));

  /* budget: the basis is decided per month - bills from the first billed month, the ledger before it - and ties to the ledger either way */
  const extrasByMonth = {};
  bills.forEach(function (b) { if (b.flags.indexOf('DUPLICATE_INVOICE') !== -1 && ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'IN_BATCH', 'PAID'].indexOf(b.status) !== -1) extrasByMonth[b.monthKey] = (extrasByMonth[b.monthKey] || 0) + b.amount + b.gstAmount; });
  cfg.months.filter(function (m) { return !MK.finance.raw.monthInfo(m).partial; }).forEach(function (m) {
    const bd = MK.finance.budget(m, 'all'), ledger = sum(MK.finance.raw.ledger({ monthKey: m }), function (l) { return l.amount; });
    eq('budget basis ' + m, bd.basis, m >= MK.seed.params.billsFromMonth ? 'bills' : 'ledger');
    eq('budget ' + m + ': committed + pipeline = the ledger (the duplicate invoice aside)', bd.totals.committed + bd.totals.pipeline - (extrasByMonth[m] || 0), ledger);
    eq('budget ' + m + ': actual = the ledger, nothing estimated in a closed month', bd.totals.actual + '|' + bd.totals.estimatedPart, ledger + '|0');
  });
  const may = MK.finance.budget('2026-05', 'bandra'), mayRow = function (id) { return may.rows.filter(function (r) { return r.categoryId === id; })[0]; };
  check('May at Bandra is read from the ledger: rent and electricity are committed in full', may.basis === 'ledger' && mayRow('rent').committed === cfg.outletCosts.bandra.rent && mayRow('electricity').committed > 0 && mayRow('rent').basis === 'ledger');
  check('the May LPG spike shows with the seed applied: gas is over plan at every unit', OUTLETS.concat(['factory']).every(function (u) { return MK.finance.budget('2026-05', u).rows.filter(function (r) { return r.categoryId === 'gas_lpg'; })[0].status === 'OVER'; }));
  check('insights for May and June still find the gas overrun', MK.insights.list({ from: '2026-05-01', to: '2026-06-30' }).some(function (x) { return x.id === 'budget|gas_lpg'; }));
})();

section('6b. Seeded workflow state: invariants and the intended queues');
(function () {
  const users = byId(MK.session.users);
  let payable = 0, chrono = 0, seg = 0, roles = 0, batchLink = 0, paid = 0, novendor = 0, month = 0, linesBad = 0;
  bills.forEach(function (b) {
    if (b.payable !== b.amount + b.gstAmount - b.tdsAmount) payable++;
    const times = [b.createdAt, b.submittedAt, b.decidedAt, b.paidAt].filter(Boolean);
    for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) chrono++;
    if (b.createdAt.slice(0, 10) < b.invoiceDate) chrono++;
    if (b.decidedBy && (b.decidedBy === b.createdBy || b.decidedBy === b.submittedBy)) seg++;
    if (['maker', 'outlet_manager', 'factory_manager'].indexOf(users[b.createdBy].role) === -1 || (b.decidedBy && users[b.decidedBy].role !== 'checker')) roles++;
    if (users[b.createdBy].unitIds.indexOf(b.unitId) === -1) roles++;
    const inBatch = b.status === 'IN_BATCH' || b.status === 'PAID';
    if (inBatch && !(b.batchId && byId(batches)[b.batchId] && byId(batches)[b.batchId].billIds.indexOf(b.id) !== -1)) batchLink++;
    if (!inBatch && b.batchId) batchLink++;
    if (b.status === 'PAID' && !(b.utr && b.paidAt)) paid++;
    if (!vendorById[b.vendorId]) novendor++;
    if (!/^\d{4}-\d{2}$/.test(b.monthKey) || b.monthKey > b.invoiceDate.slice(0, 7)) month++;
    if (b.lines && (b.lines[0].categoryId !== b.categoryId || b.lines[0].amount !== b.amount || sum(b.lines, function (l) { return l.amount; }) > b.amount + b.gstAmount)) linesBad++;
  });
  eq('bills where payable differs from amount + GST - TDS', payable, 0);
  eq('bills whose timestamps run backwards', chrono, 0);
  eq('bills decided by the person who raised or submitted them', seg, 0);
  eq('bills created or decided by the wrong role, or outside the creator\'s units', roles, 0);
  eq('bills whose batch link is inconsistent', batchLink, 0);
  eq('paid bills without UTR or payment time', paid, 0);
  eq('bills of unknown vendors', novendor, 0);
  eq('bills with an invalid expense month', month, 0);
  eq('bills with inconsistent expense lines', linesBad, 0);
  eq('rent bills carry their non-creditable GST as a second expense line', bills.filter(function (b) { return b.categoryId === 'rent' && !(b.lines && b.lines[1].categoryId === 'rent_gst' && b.lines[1].amount === b.gstAmount); }).length, 0);
  check('TDS only with a descriptive label, never a section number', bills.every(function (b) { return (b.tdsAmount > 0) === !!b.tdsLabel && !/19[24]|\bsection\b/i.test(b.tdsLabel || ''); }));
  check('utility bills carry no GST and no TDS', bills.every(function (b) { return vendorById[b.vendorId].type !== 'utility' || (b.gstAmount === 0 && b.tdsAmount === 0); }));
  eq('invoice numbers unique per vendor (but for the one intended duplicate)', bills.length - Object.keys(bills.reduce(function (m, b) { m[b.vendorId + '|' + b.invoiceNo] = 1; return m; }, {})).length, 1);

  let batchBad = 0;
  batches.forEach(function (p) {
    const own = p.billIds.map(function (id) { return billById[id]; });
    if (p.total !== sum(own, function (b) { return b.payable; })) batchBad++;
    if (users[p.createdBy].role !== 'payer' || (p.releasedBy && users[p.releasedBy].role !== 'director') || p.releasedBy === p.createdBy) batchBad++;
    if (p.status === 'PAID' && !own.every(function (b) { return b.status === 'PAID'; })) batchBad++;
    if ((p.status === 'PENDING_RELEASE' || p.status === 'RELEASED') && !own.every(function (b) { return b.status === 'IN_BATCH'; })) batchBad++;
    if ([p.createdAt, p.submittedAt, p.releasedAt, p.paidAt].filter(Boolean).some(function (x, i, a) { return i > 0 && x < a[i - 1]; })) batchBad++;
  });
  eq('batches with a wrong total, actor, bill state or time order', batchBad, 0);

  let auditBad = 0;
  audit.forEach(function (e, i) { if (e.id !== 'AUD-' + String(i + 1).padStart(6, '0') || (i > 0 && e.at < audit[i - 1].at)) auditBad++; });
  eq('audit events out of sequence or out of time order', auditBad, 0);
  check('no seeded event at or after the demo clock start', audit.every(function (e) { return e.at < cal.today + 'T' + MK.seed.params.nowTime; }));
  check('every seeded date is on or before today', bills.every(function (b) { return b.invoiceDate <= cal.today && b.createdAt.slice(0, 10) <= cal.today; }));

  /* the queues the demo opens with */
  const by = {}; bills.forEach(function (b) { (by[b.status] || (by[b.status] = [])).push(b); });
  const n = function (s) { return (by[s] || []).length; };
  check('July is fully paid', bills.filter(function (b) { return b.monthKey === '2026-07'; }).every(function (b) { return b.status === 'PAID'; }));
  const august = bills.filter(function (b) { return b.monthKey === '2026-08'; }), augustPaid = august.filter(function (b) { return b.status === 'PAID'; }).length;
  check('most of August is paid (at least 60%; 30-day invoices of late August are not due yet)', augustPaid >= 0.6 * august.length, augustPaid + ' of ' + august.length);
  check('what is left of August is approved, in a batch or in the queue - nothing forgotten', august.every(function (b) { return b.status !== 'DRAFT'; }));
  check('checker\'s queue: 8 to 12 bills submitted', n('SUBMITTED') >= 8 && n('SUBMITTED') <= 12, 'got ' + n('SUBMITTED'));
  check('some bills under review', n('UNDER_REVIEW') >= 2 && n('UNDER_REVIEW') <= 8, 'got ' + n('UNDER_REVIEW'));
  check('a few drafts, including one by the Bandra manager and one by the factory manager', n('DRAFT') >= 3 && n('DRAFT') <= 10 &&
    by.DRAFT.some(function (b) { return b.createdBy === 'u_om_bandra' && b.unitId === 'bandra'; }) && by.DRAFT.some(function (b) { return b.createdBy === 'u_fm' && b.unitId === 'factory'; }), 'got ' + n('DRAFT'));
  check('exactly two rejected bills, each with a reason', n('REJECTED') === 2 && by.REJECTED.every(function (b) { return b.rejectionReason && b.rejectionReason.length > 20; }), 'got ' + n('REJECTED'));
  const queue = (by.SUBMITTED || []).concat(by.UNDER_REVIEW || []);
  const dupes = queue.filter(function (b) { return b.flags.indexOf('DUPLICATE_INVOICE') !== -1; });
  check('one bill in the queue trips the duplicate-invoice check', dupes.length === 1 && MK.workflow.bill.duplicateCheck(dupes[0]).hasExact, 'got ' + dupes.length);
  eq('bills flagged as duplicates anywhere else', bills.filter(function (b) { return b.flags.length && dupes.indexOf(b) === -1; }).length, 0);
  const over = queue.filter(function (b) { const bi = MK.workflow.bill.budgetImpact(b); return dupes.indexOf(b) === -1 && bi.available && bi.status === 'OVER'; });
  check('a bill in the queue would push its budget line over plan', over.length >= 1, 'got ' + over.length);
  check('the large one-off repair went back once and is in the queue again', queue.some(function (b) { return b.categoryId === 'repairs' && b.amount >= MK.seed.params.oneOff.evidenceThreshold &&
    MK.audit.trail('bill', b.id).some(function (e) { return e.action === 'bill.reject'; }); }));
  const approved = by.APPROVED || [];
  check('approved bills await the next run, some of them overdue', approved.length >= 20 && approved.some(function (b) { return b.dueDate < cal.today; }) && approved.some(function (b) { return b.dueDate >= cal.today; }),
    approved.length + ' approved, ' + approved.filter(function (b) { return b.dueDate < cal.today; }).length + ' overdue');
  const pending = batches.filter(function (p) { return p.status === 'PENDING_RELEASE'; }), released = batches.filter(function (p) { return p.status === 'RELEASED'; });
  /* runs are twice a week since the credit terms were made payable, so a batch is about half the size of a weekly one */
  check('one batch awaits the director: 5 to 12 bills, Rs 3 to 9 lakh', pending.length === 1 && pending[0].billIds.length >= 5 && pending[0].billIds.length <= 12 && pending[0].total >= 300000 && pending[0].total <= 900000,
    JSON.stringify(pending.map(function (p) { return [p.id, p.billIds.length, p.total]; })));
  check('one batch is released and awaits UTRs', released.length === 1 && !released[0].utr && !released[0].paidAt, 'got ' + released.length);
  check('past batches are paid with a UTR per bill', batches.filter(function (p) { return p.status === 'PAID'; }).length >= 15 && batches.every(function (p) { return ['PAID', 'PENDING_RELEASE', 'RELEASED'].indexOf(p.status) !== -1; }));
  /* payment discipline: the process can meet the credit terms of the vendor master */
  const paidBills = by.PAID || [], lateBills = paidBills.filter(function (b) { return b.paidOn > b.dueDate; }), lateByVendor = {};
  paidBills.forEach(function (b) { const v = lateByVendor[b.vendorId] || (lateByVendor[b.vendorId] = { n: 0, late: 0 }); v.n++; if (b.paidOn > b.dueDate) v.late++; });
  check('paid bills carry the payment date (the release of their batch)', paidBills.every(function (b) { const pb = byId(batches)[b.batchId]; return b.paidOn === pb.releasedAt.slice(0, 10) && b.paidOn <= b.paidAt.slice(0, 10); }));
  check('under 15% of paid bills went out after the due date', lateBills.length < 0.15 * paidBills.length, lateBills.length + ' of ' + paidBills.length);
  const alwaysLate = Object.keys(lateByVendor).filter(function (v) { return lateByVendor[v].n >= 5 && lateByVendor[v].late === lateByVendor[v].n; });
  eq('vendors that are paid late every single time', alwaysLate.join(), '');
  check('rent is never paid late', paidBills.filter(function (b) { return b.categoryId === 'rent'; }).every(function (b) { return b.paidOn <= b.dueDate; }));
  const late7 = lateBills.filter(function (b) { return vendorById[b.vendorId].creditDays <= 7; }).length;
  check('what runs late is short-credit supplies', late7 >= 0.9 * lateBills.length, late7 + ' of ' + lateBills.length);
  /* payables: money released to the bank is in transit, not overdue */
  const pay = MK.finance.payables(), inReleased = bills.filter(function (b) { return b.status === 'IN_BATCH' && released.some(function (p) { return p.id === b.batchId; }); });
  eq('payables.inTransit = the bills of the released batch', pay.inTransit.amount + '|' + pay.inTransit.count, sum(inReleased, function (b) { return b.payable; }) + '|' + inReleased.length);
  const openLate = bills.filter(function (b) { return ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'IN_BATCH'].indexOf(b.status) !== -1 && b.dueDate < cal.today && inReleased.indexOf(b) === -1; });
  eq('payables.overdue leaves them out', pay.overdue.amount + '|' + pay.overdue.count, sum(openLate, function (b) { return b.payable; }) + '|' + openLate.length);
  eq('payables buckets add up to the total', sum(pay.buckets, function (x) { return x.amount; }), pay.total);

  /* every timeline is a chain: a step starts in the state the step before it ended in */
  let broken = 0, firstBroken = '';
  bills.forEach(function (b) {
    const trail = MK.audit.trail('bill', b.id); let state = null;
    trail.forEach(function (e, i) { if (i > 0 && e.from !== state && !broken++) firstBroken = b.id + ' ' + e.action + ' from ' + e.from + ' after ' + state; state = e.to; });
    if (trail.length && state !== b.status) { if (!broken++) firstBroken = b.id + ' ends in ' + state + ', bill is ' + b.status; }
  });
  check('bill timelines are unbroken state chains that end in the bill\'s state (' + bills.length + ' trails)', broken === 0, broken + ' broken, first: ' + firstBroken);
  check('a decision is always preceded by its review step', bills.filter(function (b) { return b.decidedAt; }).every(function (b) { return b.reviewedAt && b.reviewedAt <= b.decidedAt &&
    MK.audit.trail('bill', b.id).some(function (e) { return e.action === 'bill.review'; }); }));

  check('UTRs are unique', (function () { const u = bills.filter(function (b) { return b.utr; }).map(function (b) { return b.utr; }); return Object.keys(u.reduce(function (m, x) { m[x] = 1; return m; }, {})).length === u.length; })());

  /* vendors */
  eq('every vendor of the master is in the store', vendors.length, cfg.vendors.length);
  eq('final vendor states follow the master', vendors.filter(function (v) { return v.state !== byId(cfg.vendors)[v.id].state; }).map(function (v) { return v.id; }).join(','), '');
  const st = {}; vendors.forEach(function (v) { (st[v.state] || (st[v.state] = [])).push(v); });
  check('one vendor each in NEEDS_REVIEW, VERIFYING, DRAFT and REJECTED; none left VERIFIED', ['NEEDS_REVIEW', 'VERIFYING', 'DRAFT', 'REJECTED'].every(function (s) { return (st[s] || []).length === 1; }) && !st.VERIFIED);
  const review = st.NEEDS_REVIEW[0];
  check('the vendor in review has a low bank name match with simulated evidence', review.nameMatch < 85 && review.verification.bank.nameMatchScore < review.verification.bank.threshold && review.verification.simulated === true && review.verification.reasons.length > 0,
    review.id + ' ' + review.nameMatch);
  check('the rejected vendor carries a reason', !!st.REJECTED[0].rejectionReason && st.REJECTED[0].rejectedBy === 'u_checker');
  check('approved vendors were verified and approved by the checker, never by their maker', st.APPROVED.every(function (v) { return v.approvedBy === 'u_checker' && v.createdBy === 'u_maker' && v.verification.outcome === 'VERIFIED' &&
    v.history.some(function (h) { return h.action === 'vendor.approve'; }); }));
  check('utilities need no verification', vendors.filter(function (v) { return v.type === 'utility'; }).every(function (v) { return v.state === 'APPROVED' && v.verification.preChecks.applicable === false && !v.verification.bank && !v.gstin; }));
  check('every GSTIN passes the checksum and embeds the PAN', vendors.filter(function (v) { return v.gstin; }).every(function (v) { return MK.data.gstinCheckChar(v.gstin.slice(0, 14)) === v.gstin.charAt(14) && v.gstin.slice(2, 12) === v.pan && v.gstin.slice(0, 2) === '27'; }));
  check('only masked bank accounts are stored', vendors.every(function (v) { return !v.bankAccount && (!v.bankAccountMasked || /^X+\d{4}$/.test(v.bankAccountMasked)); }));
  check('no bill was raised while its vendor was not approved', bills.every(function (b) {
    const h = vendorById[b.vendorId].history, approvedAt = h.filter(function (x) { return x.action === 'vendor.approve'; })[0], lost = h.filter(function (x) { return x.action === 'vendor.bankChange' || x.action === 'vendor.taxChange'; })[0];
    return approvedAt && b.createdAt >= approvedAt.at && (!lost || b.createdAt < lost.at);
  }));

  const size = sum(COLLS, function (c) { return JSON.stringify(MK.store.coll(c).all()).length; });
  check('stored JSON is comfortably under 1.5 MB', size < 1.25 * 1024 * 1024, fmt.num(size) + ' bytes');
  note(bills.length + ' bills (' + MK.workflow.bill.STATES.map(function (s) { return n(s) + ' ' + s; }).join(', ') + '), ' + batches.length + ' batches, ' + vendors.length + ' vendors, ' + audit.length + ' audit events, ' +
    fmt.num(Math.round(size / 1024)) + ' KB stored');
  note('pending release: ' + pending.map(function (p) { return p.id + ' ' + p.billIds.length + ' bills ' + fmt.inrFull(p.total); }).join('') + '; awaiting UTRs: ' + released.map(function (p) { return p.id + ' ' + p.billIds.length + ' bills ' + fmt.inrFull(p.total); }).join(''));
})();

/* ================================================================== 7. calibration bands */

section('7. Calibration bands (RESEARCH sections 2, 3, 5 and 7)');
(function () {
  /*
   * target = the band of RESEARCH.md; accept = the band this check enforces. They differ only where the authors of the
   * model documented a deviation (docs/API-finance.md section 5), so a drift beyond the documented figure still fails.
   */
  const rows = [], rowByName = {};
  function band(name, label, value, target, accept, why) {
    const a = accept || target, inTarget = value >= target[0] && value <= target[1], ok = value >= a[0] && value <= a[1];
    let row = rowByName[name];
    if (!row) { row = rowByName[name] = { name: name, values: [], target: target, status: 'ok', why: '' }; rows.push(row); }
    row.values.push((label ? label + ' ' : '') + value);
    if (!ok) row.status = 'FAIL'; else if (!inTarget && row.status === 'ok') { row.status = 'accepted'; row.why = why || ''; }
    check(name + (label ? ' ' + label : ''), ok, value + ' outside ' + JSON.stringify(a));
  }
  const r1 = function (x) { return Math.round(x * 10) / 10; }, pc = function (x) { return Math.round(x * 1000) / 10; }, mon = function (mk) { return D.monthLabel(mk); };
  const fullMonths = cfg.months.filter(function (m) { return !MK.finance.raw.monthInfo(m).partial; }), steadyMonths = ['2026-07', '2026-08'];

  /* scale */
  fullMonths.forEach(function (mk) { band('network net sales, Rs crore', mon(mk), Math.round(db.monthlyMeasure(mk, null, null, 'netSales') / 1e5) / 100, [1.15, 1.25], [1.08, 1.32], 'May carries IPL and Eid; April and June sit just under'); });
  band('orders per day, full year', '', r1(MK.data.summary(FULL).ordersPerDay), [700, 800]);

  /* AOV, July-August */
  const steady = { from: '2026-07-01', to: '2026-08-31' };
  function aov(extra) { const s = MK.data.summary(Object.assign({}, steady, extra)); return { gross: Math.round(s.grossSales / s.orders), net: Math.round(s.aov) }; }
  band('delivery AOV gross, standard list, Rs', '', aov({ mediumIds: ['delivery'], outletIds: ['bandra', 'andheri', 'fort', 'koregaon'] }).gross, [600, 680]);
  band('delivery AOV gross, Kalyan, Rs', '', aov({ mediumIds: ['delivery'], outletIds: ['kalyan'] }).gross, [560, 600]);
  band('delivery AOV after discount, Rs', '', aov({ mediumIds: ['delivery'] }).net, [540, 610]);
  band('in-store AOV blended, Rs', '', aov({ channelIds: ['petpooja'] }).net, [430, 520]);
  band('dine-in ticket, Rs', '', aov({ mediumIds: ['dinein'] }).net, [650, 1000]);
  band('takeaway ticket, Rs', '', aov({ mediumIds: ['takeaway'] }).net, [250, 400]);

  /* outlet economics */
  const ebitdaTarget = { bandra: [15, 18], andheri: [8, 11], fort: [5, 8], kalyan: [6, 9] };
  Object.keys(ebitdaTarget).forEach(function (o) {
    steadyMonths.forEach(function (mk) {
      /* Kalyan: the roster follows the trade (11 heads, the lightest Mumbai payroll) instead of being sized to land in the band, so July sits above it;
       * August carries the compressor. Both are documented in API-finance section 5. */
      const kalyan = o === 'kalyan';
      band('EBITDA % ' + o, mon(mk), pc(MK.finance.pnl(o, mk).totals.ebitdaPct), ebitdaTarget[o], kalyan ? (mk === '2026-08' ? [1, 9] : [6, 11.5]) : null,
        'low rent on a roster sized by the trade, not by the band; August carries the Rs 68,000 compressor and Shravan');
    });
  });
  band('EBITDA % koregaon, April', '', pc(MK.finance.pnl('koregaon', '2026-04').totals.ebitdaPct), [-8, -4]);
  band('EBITDA % koregaon, September to date', '', pc(MK.finance.pnl('koregaon', '2026-09').totals.ebitdaPct), [5, 8], [0.5, 8], 'documented: a small profit in the Shravan / Ganeshotsav fortnight, not yet +5 (API-finance section 5)');
  const kp = MK.finance.pnlTrend('koregaon').rows;
  const kpMean = function (rows) { return sum(rows, function (r) { return r.ebitda; }) / sum(rows, function (r) { return r.netSales; }); };
  check('Koregaon Park ramps from a loss to a small profit that holds in the open month', kp[0].ebitda < 0 && kp[3].ebitda > 0 && kp[4].ebitda > 0 && kp[5].ebitda > 0 && kpMean(kp.slice(3)) > kpMean(kp.slice(0, 3)) + 0.04,
    kp.map(function (r) { return pc(r.ebitdaPct); }).join(' '));
  band('Koregaon Park net sales, Rs lakh', 'Apr', Math.round(kp[0].netSales / 1e4) / 10, [12.5, 15.5]);
  band('Koregaon Park net sales, Rs lakh', 'Aug', Math.round(kp[4].netSales / 1e4) / 10, [19.5, 21.5]);
  fullMonths.forEach(function (mk) { band('company EBITDA %', mon(mk), pc(MK.finance.pnl('all', mk).totals.ebitdaPct), [5, 9], mk === '2026-06' ? [3, 9] : null, 'June: chicken at Rs 290 against the Rs 270 standard in the weakest sales month (documented)'); });

  /* rosters: one source (config), ordered by the trade */
  const heads = {}, payroll = {};
  OUTLETS.forEach(function (o) { const r = MK.finance.raw.roster(o); heads[o] = sum(r); payroll[o] = sum(r.map(function (n, i) { return n * cfg.wages.roles[i].gross; })); });
  check('rosters come from MK.config.wages.staffing and match outletCosts.headcount', OUTLETS.every(function (o) { return JSON.stringify(MK.finance.raw.roster(o)) === JSON.stringify(cfg.wages.staffing[o]) && heads[o] === cfg.outletCosts[o].headcount; }) && !MK.finance.raw.model.staffing);
  check('Andheri has the largest team; Kalyan the lightest Mumbai payroll; Koregaon Park the smallest team', OUTLETS.every(function (o) { return o === 'andheri' || heads.andheri > heads[o]; }) &&
    ['bandra', 'andheri', 'fort'].every(function (o) { return payroll.kalyan < payroll[o] && heads.kalyan <= heads[o]; }) && OUTLETS.every(function (o) { return o === 'koregaon' || heads.koregaon < heads[o]; }), JSON.stringify(heads));
  const pplPct = function (o) { return MK.finance.pnl(o, '2026-07').groups.filter(function (g) { return g.id === 'people'; })[0].pctOfSales; };
  check('Kalyan no longer carries the heaviest people cost of the network', pplPct('kalyan') <= pplPct('fort') + 0.005, pc(pplPct('kalyan')) + ' vs Fort ' + pc(pplPct('fort')));

  /* consumption-driven lines move with consumption */
  const lineOf = function (unit, cat, mk) { return sum(MK.finance.raw.ledger({ unitId: unit, monthKey: mk, categoryId: cat }), function (l) { return l.amount; }); };
  OUTLETS.forEach(function (o) {
    const series = fullMonths.map(function (mk) { return lineOf(o, 'charcoal', mk); }), mean = sum(series) / series.length;
    check('charcoal at ' + o + ' follows the tandoor: it differs by month and averages the configured monthly figure', Object.keys(series.reduce(function (m, x) { m[x] = 1; return m; }, {})).length === series.length && Math.abs(mean - cfg.outletCosts[o].charcoal) <= 2,
      series.join(' '));
  });
  const mumbaiCharcoal = function (mk) { return sum(OUTLETS.filter(function (o) { return o !== 'koregaon'; }), function (o) { return lineOf(o, 'charcoal', mk); }); };
  check('charcoal of the Mumbai-region outlets peaks in the Eid month (Koregaon Park is still ramping)', fullMonths.every(function (mk) { return mumbaiCharcoal('2026-05') >= mumbaiCharcoal(mk); }), fullMonths.map(mumbaiCharcoal).join(' '));
  const fuel = fullMonths.map(function (mk) { return lineOf('factory', 'vehicle_fuel', mk); }), pune = fullMonths.map(function (mk) { return lineOf('factory', 'pune_run', mk); });
  check('fuel and the Pune run follow kg and runs, around their configured monthly figures', Object.keys(fuel.reduce(function (m, x) { m[x] = 1; return m; }, {})).length === fuel.length &&
    Math.abs(sum(fuel) / fuel.length - cfg.factoryParams.vans.count * cfg.factoryParams.vans.fuelAndTollsEach) <= 2 && Math.abs(sum(pune) / pune.length - cfg.factoryParams.puneRunExtra) <= 2 && pune[0] !== pune[1], fuel.join(' ') + ' | ' + pune.join(' '));
  check('the logistics pool no longer mirrors depreciation', fullMonths.every(function (mk) { return MK.factory.pnl(mk).logisticsCost !== MK.finance.pnl('all', mk).totals.depreciation; }));
  function rentPct(o, mk) { return pc(MK.finance.pnl(o, mk).lines.filter(function (l) { return l.key === 'rent'; })[0].pctOfSales); }
  steadyMonths.forEach(function (mk) { band('rent % of sales, Bandra', mon(mk), rentPct('bandra', mk), [9, 10]); });
  steadyMonths.forEach(function (mk) { band('rent % of sales, Fort', mon(mk), rentPct('fort', mk), [12, 13]); });
  const scores = OUTLETS.map(function (o) { return { o: o, net: sum(fullMonths, function (mk) { return MK.finance.pnl(o, mk).totals.netSales; }), e: sum(fullMonths, function (mk) { return MK.finance.pnl(o, mk).totals.ebitda; }) }; });
  eq('highest sales: Andheri', scores.slice().sort(function (a, b) { return b.net - a.net; })[0].o, 'andheri');
  eq('best EBITDA %: Bandra', scores.slice().sort(function (a, b) { return b.e / b.net - a.e / a.net; })[0].o, 'bandra');

  /* food cost */
  fullMonths.forEach(function (mk) {
    const fc = MK.finance.foodCost(mk), k = fc.rows.filter(function (r) { return r.outletId === 'kalyan'; })[0];
    band('food cost theoretical %, network', mon(mk), pc(fc.totals.theoreticalPct), [33, 34], [32.5, 34.5], 'within half a point');
    band('Kalyan food cost variance, pts', mon(mk), pc(k.variancePts), [3, 4], [3, 4.3], 'parameter is +3.6; the monthly spread of local over-use adds up to half a point');
    check('Kalyan is the red flag and the only one, ' + mk, k.redFlag && fc.rows.filter(function (r) { return r.redFlag; }).length === 1);
    check('other outlets stay within 0.5 to 2 pts, ' + mk, fc.rows.every(function (r) { return r.outletId === 'kalyan' || (r.variancePts > 0.005 && r.variancePts < 0.02); }));
  });

  /* aggregator realisation and take rates */
  const ce = MK.data.channelEconomics(FULL);
  ce.byOutlet.forEach(function (o) { band('aggregator realisation % of menu value', o.outletId, pc(o.actual.realisationPctOfMenu), [52, 62], [52, 63.5], 'documented: top edge at Bandra and Fort'); });
  const gap = {}; ce.byOutlet.forEach(function (o) { gap[o.outletId] = o.actual.effectiveTakeRate - o.actual.contractedTakeRate; });
  check('effective take rate is furthest above contract at the two ads-heavy outlets', ['bandra', 'fort', 'kalyan'].every(function (o) { return gap.andheri > gap[o] && gap.koregaon > gap[o]; }));
  const fortDow = MK.data.breakdown(Object.assign({ outletIds: ['fort'] }, steady), 'dow').rows, allDow = MK.data.breakdown(steady, 'dow').rows;
  check('Fort: Sundays are weak while the network peaks at weekends', fortDow[6].netSales < fortDow[2].netSales && allDow[5].netSales > allDow[2].netSales);

  /* factory */
  const facts = fullMonths.map(function (mk) { const info = MK.finance.raw.monthInfo(mk); return { mk: mk, s: MK.factory.summary({ from: info.from, to: info.to }), p: MK.factory.pnl(mk) }; });
  facts.forEach(function (x) { band('fill rate Mumbai %', mon(x.mk), pc(x.s.fillRateMumbai), [97, 99]); });
  facts.forEach(function (x) { band('fill rate Pune %', mon(x.mk), pc(x.s.fillRatePune), [92, 95]); });
  facts.forEach(function (x) { band('capacity utilisation %', mon(x.mk), pc(x.s.capacityUtilisation), [68, 82]); });
  facts.forEach(function (x) { band('wastage %', mon(x.mk), pc(x.s.wastagePct), [1.5, 3]); });
  facts.forEach(function (x) { band('plan adherence %', mon(x.mk), pc(x.s.planAdherence), [95, 100]); });
  facts.forEach(function (x) { band('write-offs %', mon(x.mk), Math.round(x.s.writeOffPct * 10000) / 100, [0, 0.5], [0, 0.55], 'rounding at the upper edge'); });
  facts.forEach(function (x) { band('absorption % of transfer value', mon(x.mk), pc(x.p.absorptionPct), [-3, 3], x.mk >= '2026-05' && x.mk <= '2026-07' ? [-6.5, 3] : null, 'seeded stories: chicken above the Rs 270 standard May-July, on top of the LPG spike'); });
  /* the two seeded cost stories are visible where they belong in the variance analysis */
  const varOf = function (mk) { return MK.factory.pnl(mk).variance; };
  check('gas: utilities run over standard from May to July, in the two peak months by more than in April', ['2026-05', '2026-06', '2026-07'].every(function (mk) { return varOf(mk).utilities < -10000; }) &&
    ['2026-05', '2026-06'].every(function (mk) { return varOf(mk).utilities < -15000 && varOf(mk).utilities < varOf('2026-04').utilities; }),
    cfg.months.map(function (mk) { return varOf(mk).utilities; }).join(' '));
  check('chicken: the purchase-price variance is the largest driver of the June and July under-absorption', ['2026-06', '2026-07'].every(function (mk) { const v = varOf(mk); return Object.keys(v).every(function (k) { return v.rmPrice <= v[k]; }); }) && varOf('2026-09').rmPrice > 0);
  eq('standard conversion split adds up to the transfer-price conversion', sum(Object.keys(MK.factory.raw.model.stdConversionSplit), function (k) { return MK.factory.raw.model.stdConversionSplit[k]; }), cfg.factoryConversionPerKg);
  facts.forEach(function (x) { band('transfer value % of network sales', mon(x.mk), pc(x.p.transferValuePctOfNetworkSales), [22, 24], [22, 25.5], 'documented: recipe requirement 23.3-23.6 plus outlet over-use'); });
  facts.forEach(function (x) { band('factory cost % of network sales', mon(x.mk), pc(x.p.factoryCostPctOfNetworkSales), [8, 9], [7, 9], 'documented: absorption was given priority (API-finance section 5)'); });
  function seekhYield(mk) { const info = MK.finance.raw.monthInfo(mk); return Math.round(MK.factory.production({ from: info.from, to: info.to }).rows.filter(function (r) { return r.sku === 'FP03'; })[0].actualYield * 1000) / 1000; }
  band('chicken seekh mix yield, July (standard 1.06)', '', seekhYield('2026-07'), [1.05, 1.07]);
  band('chicken seekh mix yield, August (seeded drop)', '', seekhYield('2026-08'), [0.98, 1.0]);
  function ppv(mk, rm) { return MK.factory.purchases(mk).rows.filter(function (r) { return r.rmId === rm; })[0].ppv; }
  check('chicken price variance is favourable in Aug and Sep, onions unfavourable', ppv('2026-08', 'RM_CHICKEN') < 0 && ppv('2026-09', 'RM_CHICKEN') < 0 && ppv('2026-08', 'RM_ONION') > 0 && ppv('2026-09', 'RM_ONION') > 0);
  check('gas is over budget at every unit in August; at least two budget lines are over plan', OUTLETS.concat(['factory']).every(function (u) { return MK.finance.budget('2026-08', u).rows.filter(function (r) { return r.categoryId === 'gas_lpg'; })[0].status === 'OVER'; }) &&
    MK.finance.budget('2026-08', 'all').counts.OVER >= 2);

  function cell(text, width) { text = String(text); while (text.length < width) text += ' '; return text; }
  note(cell('measure', 47) + cell('research target', 17) + cell('status', 10) + 'measured');
  rows.forEach(function (r) { note(cell(r.name, 47) + cell(r.target[0] + ' to ' + r.target[1], 17) + cell(r.status, 10) + r.values.join('  ') + (r.why ? '   [' + r.why + ']' : '')); });
})();


/* ============================================== marked events are visible in the generated data */

section('Dated demand events show in the data (RESEARCH section 6)');
(function () {
  /*
   * A reseed must not lose a story that carries a chart marker. Each event day is compared with plain days of the same
   * weekday under the same season-long conditions (named below); the thresholds sit well inside the configured effect.
   */
  function orders(date, outletId, mediumIds) { return MK.data.summary({ from: date, to: date, outletIds: outletId ? [outletId] : null, mediumIds: mediumIds || null }).orders; }
  function ratio(days, base, outletId, mediumIds) {
    return (sum(days, function (d) { return orders(d, outletId, mediumIds); }) / days.length) / (sum(base, function (d) { return orders(d, outletId, mediumIds); }) / base.length);
  }
  const shown = [];
  /* Bakri Eid, Wed 27 - Thu 28 May (+35%): against the Wednesdays and Thursdays of the two weeks before (IPL on, mid-month) */
  OUTLETS.forEach(function (o) { const r = ratio(['2026-05-27', '2026-05-28'], ['2026-05-13', '2026-05-14', '2026-05-20', '2026-05-21'], o); shown.push(o + ' ' + r.toFixed(2)); check('Bakri Eid lifts orders by at least 20% at ' + o, r >= 1.20, r.toFixed(3)); });
  /* Independence Day, Sat 15 Aug (+10%): against the two following Saturdays, both inside Shravan like the day itself */
  const ind = ratio(['2026-08-15'], ['2026-08-22', '2026-08-29']);
  check('Independence Day is above the Shravan Saturdays around it', ind > 1.03, ind.toFixed(3));
  /* Ganesh Chaturthi, Mon 14 Sep (-20% / -35%): against the Shravan Mondays 17 and 24 Aug */
  const gcAll = ratio(['2026-09-14'], ['2026-08-17', '2026-08-24']), gcK = ['kalyan', 'koregaon'].map(function (o) { return ratio(['2026-09-14'], ['2026-08-17', '2026-08-24'], o); });
  check('Ganesh Chaturthi is a visibly quiet day, at Kalyan and Koregaon Park too', gcAll < 0.93 && gcK.every(function (r) { return r < 0.95; }), gcAll.toFixed(3) + ' | ' + gcK.map(function (r) { return r.toFixed(3); }).join(' '));
  /* 15-16 Sep stay muted (-8% / -18%): against the plain Tuesdays and Wednesdays of mid-July and mid-August (before Shravan); Koregaon Park's ramp is left out */
  const four = ['bandra', 'andheri', 'fort', 'kalyan'], muted = sum(['2026-09-15', '2026-09-16'], function (d) { return sum(four, function (o) { return orders(d, o); }); }) / 2 /
    (sum(['2026-07-14', '2026-07-15', '2026-08-11', '2026-08-12'], function (d) { return sum(four, function (o) { return orders(d, o); }); }) / 4);
  check('15-16 Sep stay below a plain mid-week day at the Mumbai-region outlets', muted < 0.97, muted.toFixed(3));
  check('and at Kalyan in particular', ratio(['2026-09-15', '2026-09-16'], ['2026-07-14', '2026-07-15', '2026-08-11', '2026-08-12'], 'kalyan') < 0.97, ratio(['2026-09-15', '2026-09-16'], ['2026-07-14', '2026-07-15', '2026-08-11', '2026-08-12'], 'kalyan').toFixed(3));
  /* extreme rain, Tue 21 Jul (-40%) */
  OUTLETS.forEach(function (o) { const r = ratio(['2026-07-21'], ['2026-07-14', '2026-07-28'], o); check('the extreme-rain day empties ' + o, r < 0.80, r.toFixed(3)); });
  /* heavy-rain days (delivery +22%, in-store -35%): against the same weekday a week before and after */
  cfg.events.filter(function (e) { return /^rain_2026/.test(e.id); }).forEach(function (e) {
    const base = [D.addDays(e.from, -7), D.addDays(e.from, 7)].filter(function (d) { return d >= cal.dataStart && d <= cal.dataEnd && !cfg.events.some(function (x) { return x.kind === 'weather' && x.id !== 'monsoon' && x.from <= d && d <= x.to; }); });
    const del = ratio([e.from], base, null, ['delivery']), ins = ratio([e.from], base, null, ['dinein', 'takeaway']);
    check('heavy rain on ' + e.from + ': delivery up, in-store down', del > 1.02 && ins < 0.85, 'delivery ' + del.toFixed(3) + ', in-store ' + ins.toFixed(3));
  });
  note('Bakri Eid uplift by outlet: ' + shown.join('  ') + '; Independence Day x' + ind.toFixed(2) + '; Ganesh Chaturthi x' + gcAll.toFixed(2) + '; 15-16 Sep x' + muted.toFixed(2));
})();

/* ================================================================ 9. scope by persona */

section('9. Persona scope on every public selector (RESEARCH 9.9)');
(function () {
  const f = { from: '2026-08-01', to: '2026-09-16' };
  const directorBandra = { s: MK.data.summary({ from: f.from, to: f.to, outletIds: ['bandra'] }), recent: MK.data.recentOrders({ outletIds: ['bandra'] }, { limit: 1 }).total,
    pnl: MK.finance.pnl('bandra', '2026-08').totals, factory: JSON.stringify(MK.factory.summary(f)), directorAll: MK.data.summary(f).netSales,
    augustSales: MK.factory.pnl('2026-08').networkNetSales, augustRatio: MK.factory.pnl('2026-08').transferValuePctOfNetworkSales };

  as('u_om_bandra', function () {
    const only = function (list, get) { return list.every(function (x) { return get(x) === 'bandra'; }); };
    const s = noThrow('summary', function () { return MK.data.summary(f); });
    eq('Bandra manager: summary = the director\'s Bandra figures', JSON.stringify([s.netSales, s.orders, s.gst]), JSON.stringify([directorBandra.s.netSales, directorBandra.s.orders, directorBandra.s.gst]));
    check('Bandra manager: summary is smaller than the network', s.netSales < directorBandra.directorAll);
    eq('Bandra manager: asking for Andheri returns zero', MK.data.summary({ from: f.from, to: f.to, outletIds: ['andheri'] }).netSales, 0);
    eq('Bandra manager: breakdown by outlet', MK.data.breakdown(f, 'outlet').rows.map(function (r) { return r.id; }).join(), 'bandra');
    eq('Bandra manager: breakdown by city', MK.data.breakdown(f, 'city').rows.filter(function (r) { return r.netSales > 0; }).map(function (r) { return r.id; }).join(), 'mumbai');
    eq('Bandra manager: series by outlet', MK.data.series(f, { by: 'outlet' }).series.map(function (x) { return x.id; }).join(), 'bandra');
    eq('Bandra manager: series total', sum(MK.data.series(f, { grain: 'month' }).total), s.netSales);
    eq('Bandra manager: matrix rows', MK.data.matrix(f, 'outlet', 'channel', 'netSales').rows.map(function (r) { return r.id; }).join(), 'bandra');
    eq('Bandra manager: dishes total', MK.data.dishes(f).totals.netSales, s.netSales);
    check('Bandra manager: the Pune-only roll is not listed', !MK.data.dishes(f).rows.some(function (r) { return r.id === 'bc_roll'; }));
    eq('Bandra manager: channel economics by outlet', MK.data.channelEconomics(f).byOutlet.map(function (o) { return o.outletId; }).join(), 'bandra');
    check('Bandra manager: payouts', only(MK.data.payouts(f).rows, function (p) { return p.outletId; }) && MK.data.payouts(f).rows.length > 0);
    const af = MK.data.auditFlags(f);
    check('Bandra manager: audit flags and take rates', af.flags.every(function (x) { return x.outletId === 'bandra' || (x.outletId === null && x.data.outlets.every(function (o) { return o.outletId === 'bandra'; })); }) && only(af.takeRates, function (x) { return x.outletId; }));
    const ro = MK.data.recentOrders(null, { limit: 5000 });
    check('Bandra manager: recent orders', only(ro.rows, function (o) { return o.outletId; }) && ro.total === directorBandra.recent && ro.total > 0);

    eq('Bandra manager: pnl(all) is Bandra', JSON.stringify(MK.finance.pnl('all', '2026-08').totals), JSON.stringify(directorBandra.pnl));
    eq('Bandra manager: pnl(andheri) is empty', MK.finance.pnl('andheri', '2026-08').totals.netSales, 0);
    eq('Bandra manager: pnl(factory) is empty', MK.finance.pnl('factory', '2026-08').totals.transferValue || 0, 0);
    eq('Bandra manager: pnlTrend(all)', MK.finance.pnlTrend('all').unitIds.join(), 'bandra');
    eq('Bandra manager: unitEconomics(all)', MK.finance.unitEconomics('all', '2026-08').unitIds.join(), 'bandra');
    eq('Bandra manager: foodCost rows', MK.finance.foodCost('2026-08').rows.map(function (r) { return r.outletId; }).join(), 'bandra');
    check('Bandra manager: ledger', only(MK.finance.ledger({ unitId: 'all' }), function (l) { return l.unitId; }) && MK.finance.ledger({ unitId: 'kalyan' }).length === 0);
    eq('Bandra manager: budget', MK.finance.budget('2026-08', 'all').unitIds.join(), 'bandra');
    eq('Bandra manager: budget plan', MK.finance.budgetPlan('2026-08', 'all').unitIds.join(), 'bandra');
    const pay = MK.finance.payables();
    check('Bandra manager: payables', only(pay.byUnit, function (u) { return u.unitId; }) && pay.total === sum(bills.filter(function (b) { return b.unitId === 'bandra' && ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'IN_BATCH'].indexOf(b.status) !== -1; }), function (b) { return b.payable; }));
    eq('Bandra manager: spend with a factory-only vendor', MK.finance.vendorSpend('v_poultry').total, 0);
    const tree = JSON.stringify(MK.finance.costCentreSpend('2026-08').tree);
    check('Bandra manager: cost-centre tree', tree.indexOf('cc_bandra') !== -1 && tree.indexOf('cc_andheri') === -1 && tree.indexOf('cc_factory') === -1 && tree.indexOf('cc_ho') === -1);

    const fs1 = noThrow('factory.summary', function () { return MK.factory.summary(f); });
    check('Bandra manager: factory selectors are empty', fs1.dispatchKg === 0 && fs1.transferValue === 0 && MK.factory.production(f).rows.length === 0 && MK.factory.dispatch(f).rows.length === 0 &&
      MK.factory.costing('2026-08').rows.length === 0 && !MK.factory.pnl('2026-08').transferValue && MK.factory.purchases('2026-08').rows.length === 0 && MK.factory.inventory().rawMaterials.length === 0);

    /* reads by id do not leak other units either */
    const foreign = bills.filter(function (b) { return b.unitId === 'andheri'; })[0], impact = MK.workflow.bill.budgetImpact(foreign.id), impactRec = MK.workflow.bill.budgetImpact(foreign);
    check('Bandra manager: budgetImpact of another unit\'s bill tells nothing, by id or by record', [impact, impactRec].every(function (x) { return x.available === false && x.unitId === null && x.categoryId === null && x.amount === 0 && x.monthKey === null; }), JSON.stringify(impact));
    eq('Bandra manager: duplicateCheck of another unit\'s bill id', JSON.stringify(MK.workflow.bill.duplicateCheck(foreign.id)), JSON.stringify({ hasExact: false, hasPossible: false, matches: [] }));
    check('Bandra manager: bills', only(MK.workflow.bill.list(), function (b) { return b.unitId; }) && MK.workflow.bill.list().length > 50 && MK.workflow.bill.get(bills.filter(function (b) { return b.unitId === 'factory'; })[0].id) === null);
    check('Bandra manager: vendors serve Bandra', MK.workflow.vendor.list().every(function (v) { return v.unitIds.indexOf('bandra') !== -1; }) && MK.workflow.vendor.get('v_poultry') === null);
    check('Bandra manager: only batches made purely of Bandra bills', MK.workflow.batch.list().every(function (p) { return p.unitIds.join() === 'bandra'; }) && MK.workflow.batch.get(batches[batches.length - 1].id) === null);
    check('Bandra manager: audit events', MK.audit.list().every(function (e) { return e.unitId ? e.unitId === 'bandra' : (!e.unitIds || (e.entity === 'batch' ? e.unitIds.join() === 'bandra' : e.unitIds.indexOf('bandra') !== -1)); }) &&
      MK.audit.trail('bill', bills.filter(function (b) { return b.unitId === 'andheri'; })[0].id).length === 0);
    const ins = MK.insights.list(DEFAULT_FILTER);
    check('Bandra manager: insights', ins.length > 0 && ins.every(function (x) { return x.unitId === 'bandra' || x.unitId === null; }) && !ins.some(function (x) { return /Andheri|Kalyan|Fort|Koregaon|Factory/.test(x.title + x.detail); }),
      ins.filter(function (x) { return /Andheri|Kalyan|Fort|Koregaon|Factory/.test(x.title + x.detail); }).map(function (x) { return x.id; }).join());
  });

  as('u_fm', function () {
    const s = noThrow('summary', function () { return MK.data.summary(f); });
    check('factory manager: summary is zeroed', s.netSales === 0 && s.orders === 0 && s.prev && s.prev.netSales === 0);
    MK.data.DIMENSIONS.forEach(function (dim) { const b = noThrow('breakdown ' + dim, function () { return MK.data.breakdown(f, dim); }); check('factory manager: breakdown by ' + dim + ' is empty', b && sum(b.rows, function (r) { return r.netSales; }) === 0 && b.total.netSales === 0); });
    const ser = noThrow('series', function () { return MK.data.series(f, { by: 'outlet', grain: 'week' }); });
    check('factory manager: series is empty', ser && ser.series.length === 0 && sum(ser.total) === 0);
    const mx = noThrow('matrix', function () { return MK.data.matrix(f, 'outlet', 'channel', 'netSales'); });
    check('factory manager: matrix is empty', mx && mx.total === 0 && mx.rows.length === 0);
    const dz = noThrow('dishes', function () { return MK.data.dishes(f); });
    check('factory manager: dishes is empty', dz && dz.rows.length === 0 && dz.totals.netSales === 0);
    const ce = noThrow('channelEconomics', function () { return MK.data.channelEconomics(f); });
    check('factory manager: channel economics is empty', ce && ce.byOutlet.length === 0 && ce.total.actual.netSales === 0 && ce.total.estimated.netSales === 0);
    const po = noThrow('payouts', function () { return MK.data.payouts(f); });
    check('factory manager: payouts is empty', po && po.rows.length === 0 && po.totals.cycles === 0);
    const af = noThrow('auditFlags', function () { return MK.data.auditFlags(f); });
    check('factory manager: audit flags is empty', af && af.flags.length === 0 && af.takeRates.length === 0);
    const ro = noThrow('recentOrders', function () { return MK.data.recentOrders(f); });
    check('factory manager: recent orders is empty', ro && ro.rows.length === 0 && ro.total === 0);

    eq('factory manager: pnl(all) is the factory view', MK.finance.pnl('all', '2026-08').view + '|' + MK.finance.pnl('all', '2026-08').unitIds.join(), 'factory|factory');
    eq('factory manager: pnl(bandra) is empty', MK.finance.pnl('bandra', '2026-08').totals.netSales, 0);
    eq('factory manager: food cost has no outlets', MK.finance.foodCost('2026-08').rows.length, 0);
    check('factory manager: ledger, budget, payables', MK.finance.ledger({}).every(function (l) { return l.unitId === 'factory'; }) && MK.finance.budget('2026-08', 'all').unitIds.join() === 'factory' &&
      MK.finance.payables().byUnit.every(function (u) { return u.unitId === 'factory'; }) && MK.finance.payables().total > 0);
    /* identical but for the network ratio, which he gets rounded (below) */
    const stripRatio = function (json) { const o = JSON.parse(json); o.costMonths.forEach(function (m) { delete m.factoryCostPctOfNetworkSales; }); return JSON.stringify(o); };
    eq('factory manager: factory selectors match the director\'s', stripRatio(JSON.stringify(MK.factory.summary(f))), stripRatio(directorBandra.factory));
    const fmPnl = MK.factory.pnl('2026-08');
    eq('factory manager: network sales are withheld from the factory P&L', fmPnl.networkNetSales, null);
    /* a ratio rounded to 0.1% leaves an interval of sales figures, tens of thousands of rupees wide, that all fit the transfer value */
    const r3 = fmPnl.transferValuePctOfNetworkSales;
    check('factory manager: the network ratios are too coarse to work the sales back from the transfer value', fmPnl.transferValue / (r3 - 0.0005) - fmPnl.transferValue / (r3 + 0.0005) > 25000 &&
      Math.abs(r3 * 1000 - Math.round(r3 * 1000)) < 1e-9 && Math.abs(r3 - directorBandra.augustRatio) <= 0.0005 && MK.factory.summary(f).costMonths.every(function (m) { return Math.abs(m.factoryCostPctOfNetworkSales * 1000 - Math.round(m.factoryCostPctOfNetworkSales * 1000)) < 1e-9; }),
      String(Math.round(fmPnl.transferValue / fmPnl.transferValuePctOfNetworkSales)));
    check('factory manager: bills, vendors, batches', MK.workflow.bill.list().every(function (b) { return b.unitId === 'factory'; }) && MK.workflow.vendor.list().every(function (v) { return v.unitIds.indexOf('factory') !== -1; }) &&
      MK.workflow.batch.list().length > 5 && MK.workflow.batch.list().every(function (p) { return p.unitIds.join() === 'factory'; }));
    const ins = noThrow('insights', function () { return MK.insights.list(DEFAULT_FILTER); });
    check('factory manager: insights are about the factory', ins && ins.length > 0 && ins.every(function (x) { return ['Factory', 'Approvals', 'Vendors', 'Costs'].indexOf(x.area) !== -1 && (x.unitId === 'factory' || x.unitId === null || x.id.indexOf('fill|') === 0); }) &&
      !ins.some(function (x) { return x.area === 'Revenue'; }));
  });

  ['u_checker', 'u_maker', 'u_payer'].forEach(function (u) { as(u, function () { eq(u + ' sees the whole network', MK.data.summary(f).netSales, directorBandra.directorAll); }); });

  /*
   * Same shape whatever the scope: every key the director's result has must exist in the result of a persona with nothing in
   * scope (and for a month outside the data), and wherever the director gets an object the empty result has an object too.
   * Arrays are compared by their first element when both have one. Keys that are null by documented contract are listed.
   */
  const NULLABLE = { 'pnl.prev': 1, 'factory.summary.prev': 1, 'summary.provisional': 1, 'breakdown.provisional': 1, 'series.provisional': 1, 'matrix.provisional': 1, 'dishes.provisional': 1 };
  function shapeDiff(full, empty, path, out) {
    if (full === null || typeof full !== 'object') return out;
    if (Array.isArray(full)) { if (!Array.isArray(empty)) out.push(path + ' is not an array'); else if (full.length && empty.length) shapeDiff(full[0], empty[0], path + '[]', out); return out; }
    if (empty === null || typeof empty !== 'object' || Array.isArray(empty)) { if (!NULLABLE[path]) out.push(path + ' is ' + (empty === null ? 'null' : typeof empty)); return out; }
    Object.keys(full).forEach(function (k) { if (!(k in empty)) out.push(path + '.' + k + ' is missing'); else shapeDiff(full[k], empty[k], path + '.' + k, out); });
    return out;
  }
  const AUG = '2026-08', OUTSIDE = '2026-10', outletCalls = {
    'summary': function () { return MK.data.summary(f); }, 'breakdown': function () { return MK.data.breakdown(f, 'outlet'); }, 'series': function () { return MK.data.series(f, { by: 'channel' }); },
    'matrix': function () { return MK.data.matrix(f, 'outlet', 'channel', 'netSales'); }, 'dishes': function () { return MK.data.dishes(f); }, 'channelEconomics': function () { return MK.data.channelEconomics(f); },
    'payouts': function () { return MK.data.payouts(f); }, 'auditFlags': function () { return MK.data.auditFlags(f); }, 'recentOrders': function () { return MK.data.recentOrders(f); },
    'pnl': function () { return MK.finance.pnl('andheri', AUG); }, 'pnlTrend': function () { return MK.finance.pnlTrend('andheri'); }, 'unitEconomics': function () { return MK.finance.unitEconomics('andheri', AUG); },
    'foodCost': function () { return MK.finance.foodCost(AUG); }, 'budget': function () { return MK.finance.budget(AUG, 'andheri'); }, 'budgetPlan': function () { return MK.finance.budgetPlan(AUG, 'andheri'); },
    'vendorSpend': function () { return MK.finance.vendorSpend('v_ll_andheri'); } };
  const factoryCalls = {
    'factory.summary': function () { return MK.factory.summary(f); }, 'factory.production': function () { return MK.factory.production(f); }, 'factory.dispatch': function () { return MK.factory.dispatch(f); },
    'factory.costing': function () { return MK.factory.costing(AUG); }, 'factory.pnl': function () { return MK.factory.pnl(AUG); }, 'factory.purchases': function () { return MK.factory.purchases(AUG); },
    'factory.inventory': function () { return MK.factory.inventory(); }, 'unitEconomics(factory)': function () { return MK.finance.unitEconomics('factory', AUG); }, 'pnl(factory)': function () { return MK.finance.pnl('factory', AUG); } };
  const monthCalls = {
    'pnl': function (m) { return MK.finance.pnl('all', m); }, 'unitEconomics': function (m) { return MK.finance.unitEconomics('andheri', m); }, 'foodCost': function (m) { return MK.finance.foodCost(m); },
    'budget': function (m) { return MK.finance.budget(m, 'all'); }, 'budgetPlan': function (m) { return MK.finance.budgetPlan(m, 'all'); }, 'costCentreSpend': function (m) { return MK.finance.costCentreSpend(m); },
    'factory.costing': function (m) { return MK.factory.costing(m); }, 'factory.pnl': function (m) { return MK.factory.pnl(m); }, 'factory.purchases': function (m) { return MK.factory.purchases(m); } };
  const full = {}, problems = [];
  Object.keys(outletCalls).forEach(function (k) { full[k] = outletCalls[k](); });
  Object.keys(factoryCalls).forEach(function (k) { full[k] = factoryCalls[k](); });
  as('u_fm', function () { Object.keys(outletCalls).forEach(function (k) { const e = noThrow(k + ' (factory manager)', outletCalls[k]); shapeDiff(full[k], e, k.replace(/\(.*$/, ''), problems); }); });
  as('u_om_bandra', function () { Object.keys(factoryCalls).forEach(function (k) { const e = noThrow(k + ' (Bandra manager)', factoryCalls[k]); shapeDiff(full[k], e, k.replace(/\(.*$/, ''), problems); }); });
  Object.keys(monthCalls).forEach(function (k) { const e = noThrow(k + ' (month outside the data)', function () { return monthCalls[k](OUTSIDE); }); shapeDiff(monthCalls[k](AUG), e, k, problems); });
  check('results keep their shape with nothing in scope and for a month outside the data (' + (Object.keys(outletCalls).length + Object.keys(factoryCalls).length + Object.keys(monthCalls).length) + ' calls)', problems.length === 0, problems.slice(0, 8).join('; '));

  /* ids that are names on Object.prototype are unknown ids, not crashes (route parameters are user-editable) */
  const NASTY = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'], threw = [];
  NASTY.forEach(function (id) {
    const calls = { posPriceOn: function () { return MK.data.posPriceOn(id, '2026-08-01'); }, aggPriceOn: function () { return MK.data.aggPriceOn(id, id, '2026-08-01'); }, aggPriceOnOutlet: function () { return MK.data.aggPriceOn('butter_naan', id, '2026-08-01'); },
      dishSoldAt: function () { return MK.data.dishSoldAt(id, 'bandra'); }, recipeCost: function () { return MK.data.recipeCost(id, {}); }, recipeCostMedium: function () { return MK.data.recipeCost('butter_naan', { mediumId: id }); },
      orderPackagingCost: function () { return MK.data.orderPackagingCost(id, '2026-08'); }, dishCost: function () { return MK.finance.dishCost(id, { outletId: id, mediumId: id }); }, dishCostMedium: function () { return MK.finance.dishCost('butter_naan', { mediumId: id, outletId: id }); },
      pnl: function () { return MK.finance.pnl(id, id); }, summary: function () { return MK.data.summary({ outletIds: [id], channelIds: id }); }, vendorSpend: function () { return MK.finance.vendorSpend(id); },
      can: function () { return MK.data.can(id, id); }, billGet: function () { return MK.workflow.bill.get(id); } };
    Object.keys(calls).forEach(function (k) { try { const r = calls[k](); if ((k === 'posPriceOn' || k === 'aggPriceOn' || k === 'recipeCost' || k === 'dishCost') && r !== null) threw.push(k + '(' + id + ') -> ' + JSON.stringify(r)); if (k === 'dishSoldAt' && r !== false) threw.push(k + '(' + id + ') is true'); if (k === 'orderPackagingCost' && r !== 0) threw.push(k); } catch (e) { threw.push(k + '(' + id + ') threw ' + e.message); } });
  });
  check('prototype names are unknown ids: null / false / 0, never a throw', threw.length === 0, threw.slice(0, 5).join('; '));
  check('toTimeline tolerates junk', [undefined, null, 'x', 7, [null], [undefined, {}]].every(function (v) { try { return Array.isArray(MK.audit.toTimeline(v)); } catch (e) { return false; } }));
  eq('switching back: the director sees the network again (nothing scoped was cached)', MK.data.summary(f).netSales, directorBandra.directorAll);
  eq('selectors tolerate junk filters', MK.data.summary({ from: 'x', to: null, outletIds: ['nowhere'], channelIds: [] }).netSales, 0);
})();

/* ================================================= capability matrix (DATA-FEASIBILITY 3) */

section('Channel capability matrix and what orders may carry (DATA-FEASIBILITY sections 2-3)');
(function () {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'DATA-FEASIBILITY.md'), 'utf8');
  const part3 = md.slice(md.indexOf('## 3.'), md.indexOf('## 4.'));
  const WORD = { yes: 'yes', partial: 'partial', no: 'no', 'n/a': 'n/a', memo: 'yes', nil: 'no' };
  let table = '', keys = 0;
  const missing = [], wrong = [];
  part3.split(/\r?\n/).forEach(function (line) {
    if (/^### /.test(line)) table = /Order level/.test(line) ? 'order' : /Payout level/.test(line) ? 'payout' : /inventory/.test(line) ? 'inv' : '';
    if (!/^\| `/.test(line)) return;
    const cells = line.split('|').slice(1, -1).map(function (c) { return c.trim(); });
    (cells[0].match(/`([a-z]+\.[A-Za-z0-9_]+)`/g) || []).forEach(function (tick) {
      const key = tick.replace(/`/g, ''), cap = cfg.capabilities[key]; keys++;
      if (!cap) { missing.push(key); return; }
      const first = function (cell) { const m = /^(yes|partial|no|n\/a|memo|nil)\b/i.exec(cell || ''); return m ? WORD[m[1].toLowerCase()] : null; };
      const expected = table === 'order' ? { petpooja: first(cells[1]), swiggy: first(cells[2]), zomato: first(cells[3]) }
        : table === 'payout' ? { petpooja: 'n/a', swiggy: first(cells[1]), zomato: first(cells[2]) } : { petpooja: first(cells[1]), swiggy: 'n/a', zomato: 'n/a' };
      ['petpooja', 'swiggy', 'zomato'].forEach(function (ch) { if (expected[ch] && cap[ch] !== expected[ch]) wrong.push(key + '.' + ch + ' = ' + cap[ch] + ', document says ' + expected[ch]); });
    });
  });
  check('the document lists at least 40 field keys', keys >= 40, 'parsed ' + keys);
  check('every fieldKey of DATA-FEASIBILITY section 3 exists in MK.config.capabilities', missing.length === 0, missing.join(', '));
  check('capability values agree with the document', wrong.length === 0, wrong.slice(0, 6).join('; '));
  check('capability values are yes | partial | no | n/a', Object.keys(cfg.capabilities).every(function (k) { return ['petpooja', 'swiggy', 'zomato'].every(function (ch) { return ['yes', 'partial', 'no', 'n/a'].indexOf(cfg.capabilities[k][ch]) !== -1; }); }));
  eq('MK.data.can folds n/a and unknowns into no', [MK.data.can('petpooja', 'order.customerAddress'), MK.data.can('swiggy', 'order.paymentMode'), MK.data.can('zomato', 'order.paymentMode'), MK.data.can('swiggy', 'nope'), MK.data.can('nobody', 'order.id')].join(), 'no,no,partial,no,no');
  eq('source tags', Object.keys(cfg.sources).sort().join(), 'erp,estimate,forecast,petpooja,swiggy_annexure,zomato_settlement');
  check('source tags state how far the data goes', cfg.sources.petpooja.through === cal.dataEnd && cfg.sources.swiggy_annexure.through === cfg.channelTerms.swiggy.settledThrough && cfg.sources.zomato_settlement.through === cfg.channelTerms.zomato.settledThrough);

  /* order property -> the capability that must allow it. A property is "carried" when it is neither undefined nor null. */
  const FIELD = { id: 'order.id', invoiceNo: 'order.id', posRef: 'order.id', placedAt: 'order.timestamp', status: 'order.status', items: 'order.items', subtotal: 'order.subtotal', packagingCharge: 'order.packagingCharge',
    discountTotal: 'order.discountTotal', discountRestaurantFunded: 'order.discountRestaurantFunded', gst: 'order.gst', paymentMode: 'order.paymentMode', paymentFlag: 'order.paymentMode', prepMinutes: 'order.prepTime', cancel: 'order.cancelReason' };
  const STRUCTURAL = ['aggregatorOrderId', 'outletId', 'channelId', 'mediumId', 'streamId', 'businessDate', 'hour', 'slotId', 'itemCount', 'netSales', 'cancelledValue', 'total', 'source', 'seq', 'payoutId', 'fees', 'feesSource', 'timeline'];
  const FORBIDDEN = /customer|phone|address|locality|pincode|repeat|rating|review|distance|rider|adAttribution|campaign|platformFunded|tip|surge/i;
  const payoutById = db.payoutById;
  const bad = { capability: 0, unknown: 0, forbidden: 0, fees: 0, swiggyDiscount: 0, payment: 0, cancel: 0, delivered: 0 };
  const firstBad = {};
  function flag(kind, o, what) { bad[kind]++; if (!firstBad[kind]) firstBad[kind] = o.id + ' ' + what; }
  db.recentOrders.forEach(function (o) {
    Object.keys(o).forEach(function (k) {
      const carried = o[k] !== null && o[k] !== undefined;
      if (FORBIDDEN.test(k)) flag('forbidden', o, k);
      if (FIELD[k]) { if (carried && MK.data.can(o.channelId, FIELD[k]) === 'no') flag('capability', o, k); }
      else if (STRUCTURAL.indexOf(k) === -1) flag('unknown', o, k);
    });
    (function walk(v) { if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { if (!Array.isArray(v) && FORBIDDEN.test(k)) flag('forbidden', o, 'nested key ' + k); walk(v[k]); }); })(o);
    if (o.fees) {
      const need = o.fees.kind === 'actual' ? 'order.feesActual' : 'order.feesEstimated';
      if (MK.data.can(o.channelId, need) === 'no') flag('fees', o, need);
      if ((o.fees.kind === 'actual') !== !!(payoutById[o.payoutId] && payoutById[o.payoutId].statement)) flag('fees', o, 'kind');
      if ((o.fees.kind === 'actual') === (o.feesSource === 'estimate')) flag('fees', o, 'source tag');
    }
    const settled = !!(o.payoutId && payoutById[o.payoutId] && payoutById[o.payoutId].statement);
    if (o.channelId === 'swiggy' && !settled && o.discountRestaurantFunded !== null) flag('swiggyDiscount', o, 'unsplit relay discount');
    if (o.channelId === 'zomato' && ['prepaid', 'cod'].indexOf(o.paymentFlag) === -1) flag('payment', o, 'paymentFlag');
    if (o.channelId === 'petpooja' && o.status === 'completed' && ['UPI', 'Card', 'Cash'].indexOf(o.paymentMode) === -1) flag('payment', o, 'paymentMode');
    if (o.cancel && o.channelId === 'swiggy' && (o.cancel.reason !== undefined || !settled)) flag('cancel', o, 'swiggy gives "cancelled by" only, and only with the annexure');
    if (o.timeline && o.timeline.deliveredAt && MK.data.can(o.channelId, 'order.deliveredTime') === 'no') flag('delivered', o, 'deliveredAt');
  });
  Object.keys(bad).forEach(function (k) { check('orders violating: ' + k + ' (of ' + db.recentOrders.length + ')', bad[k] === 0, bad[k] + ', first: ' + firstBad[k]); });
  check('GST treatment follows the channel', db.recentOrders.every(function (o) { return o.gst.treatment === (o.channelId === 'petpooja' ? 'collected_by_restaurant' : 'memo_collected_by_aggregator'); }));
})();

/* ====================================================================== insights */

section('Insights: the seeded stories are detected by rule, from computed values');
(function () {
  const pc1 = function (x) { return Math.round(x * 1000) / 10; };
  const list = MK.insights.list(DEFAULT_FILTER), ids = list.map(function (x) { return x.id; });
  const pendingId = batches.filter(function (p) { return p.status === 'PENDING_RELEASE'; })[0].id;
  const expected = { 'Kalyan food-cost variance': 'foodcost|kalyan', 'Andheri take rate vs contract': 'takerate|andheri', 'Fort weekend / evening under-use': 'underuse|fort', 'Koregaon Park ramp': 'ramp|koregaon',
    'Koregaon Park fill rate': 'fill|koregaon', 'Zomato rate overcharge at Fort': 'commission|fort|zomato', 'Swiggy short payment at Bandra': 'payout|PO-SW-bandra-2026-08-23', 'ads spike': 'ads|koregaon|swiggy',
    'mutton seekh markup anomaly': 'markup|mutton_seekh', 'items realising less than the POS price': 'markup|others', 'LPG budget overrun': 'budget|gas_lpg', 'chicken seekh yield drop': 'yield|FP03',
    'favourable chicken price variance': 'ppv|RM_CHICKEN', 'bills waiting 3 days or more': 'approvals|waiting', 'overdue payables': 'payables|overdue', 'batch awaiting release': 'batch|' + pendingId, 'vendor needing review': 'vendor|v_print' };
  Object.keys(expected).forEach(function (story) { check('detected: ' + story, ids.indexOf(expected[story]) !== -1, expected[story] + ' not in the list'); });
  eq('the favourable variance is good news', (list.filter(function (x) { return x.id === 'ppv|RM_CHICKEN'; })[0] || {}).severity, 'good');
  check('Bandra leads on margin', ids.indexOf('margin|bandra') !== -1);
  eq('insight ids are unique', Object.keys(ids.reduce(function (m, x) { m[x] = 1; return m; }, {})).length, ids.length);
  const rank = { critical: 0, warning: 1, info: 2, good: 3 };
  check('shape of every insight', list.every(function (x) {
    return rank[x.severity] !== undefined && MK.insights.AREAS.indexOf(x.area) !== -1 && x.title && x.detail && /^#\//.test(x.route) && x.metric && x.metric.label && typeof x.metric.value === 'number' &&
      ['inr', 'pct', 'num'].indexOf(x.metric.format) !== -1 && typeof fmt[x.metric.format] === 'function' && (x.unitId === null || MK.session.ALL_UNITS.indexOf(x.unitId) !== -1) && typeof x.impact === 'number';
  }));
  check('sorted by severity, then by impact', list.every(function (x, i) { return i === 0 || rank[list[i - 1].severity] < rank[x.severity] || (list[i - 1].severity === x.severity && list[i - 1].impact >= x.impact); }));
  const plainText = new RegExp('^[\\x20-\\x7E' + fmt.rupee + ']*$');   /* printable ASCII plus the rupee sign MK.fmt writes */
  check('no emoji or decorative characters in any sentence', list.every(function (x) { return plainText.test(x.title + x.detail + x.metric.label); }));
  eq('tolerates a missing filter', MK.insights.list().length > 0, true);

  /* sentences that quote evidence say how far it goes, and claims are computed */
  const take = list.filter(function (x) { return x.id === 'takerate|andheri'; })[0], through = function (ch) { return D.label(cfg.channelTerms[ch].settledThrough); };
  check('take-rate insight: the statements are quoted through their settled dates, not to the end of the filter', !!take && take.detail.indexOf('Swiggy through ' + through('swiggy')) !== -1 && take.detail.indexOf('Zomato through ' + through('zomato')) !== -1 &&
    take.period.indexOf(D.label(cal.dataEnd)) === -1, take && take.period);
  const ramp = list.filter(function (x) { return x.id === 'ramp|koregaon'; })[0], open = MK.finance.pnlTrend('koregaon').rows[5];
  check('ramp insight: the open month is quoted with its estimated part', !!ramp && open.estimatedPart > 0 && ramp.detail.indexOf(fmt.inr(open.estimatedPart) + ' of aggregator charges estimated') !== -1, ramp && ramp.detail);
  const others = list.filter(function (x) { return x.id === 'markup|others'; })[0], w8 = MK.insights.window(DEFAULT_FILTER), af8 = MK.data.auditFlags({ from: w8.from, to: w8.to });
  const minorFlags = af8.flags.filter(function (x) { return x.type === 'markup' && !x.data.stalePriceChange; }), minorSum = sum(minorFlags, function (x) { return x.amount; });
  const attachSum = sum(minorFlags.filter(function (x) { return byId(cfg.dishes)[x.dishId].isAttach; }), function (x) { return x.amount; });
  check('markup insight: who carries the amount is computed (attach items ' + pc1(attachSum / minorSum) + '%)', !!others && (attachSum / minorSum >= MK.insights.RULES.markup.attachMajorityShare) === /Attach items carry/.test(others.detail) &&
    others.detail.indexOf('carry most of it') === -1 && others.detail.indexOf(fmt.num(af8.markupSummary.belowBreakEven) + ' of ' + fmt.num(af8.markupSummary.listings) + ' dish listings') !== -1, others && others.detail);
  eq('insights.window() without a filter', JSON.stringify(Object.keys(MK.insights.window()).sort()), JSON.stringify(['completeMonth', 'filterFrom', 'from', 'label', 'monthFrom', 'monthTo', 'months', 'to']));

  /* "no literal figures": string literals of the source carry no digits (bucket ids of MK.finance.payables aside) */
  const src = fs.readFileSync(path.join(ROOT, 'js', 'data', 'insights.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const literals = src.match(/'(?:[^'\\\n]|\\.)*'/g) || [];
  const withDigits = literals.filter(function (s) { return /\d/.test(s) && !/^'(d\d+_(\d+|plus)|-01)'$/.test(s); });
  check('no figure is typed into an insight sentence', withDigits.length === 0, withDigits.slice(0, 5).join(' '));

  /* the text follows the data: a resolved queue item leaves the list (exercised below, in the workflow section) */
  timing.insights = Infinity;   /* best of three warm calls: the figure a re-render pays, not what the machine was doing at that moment */
  for (let i = 0; i < 3; i++) { const t0 = process.hrtime.bigint(); MK.insights.list(DEFAULT_FILTER); timing.insights = Math.min(timing.insights, ms(t0)); }
  note(list.length + ' insights for the opening filter: ' + ['critical', 'warning', 'info', 'good'].map(function (s) { return list.filter(function (x) { return x.severity === s; }).length + ' ' + s; }).join(', '));
})();

/* ===================================================== 8. determinism and build time */

const before = hashes();

section('8. Determinism and build time (RESEARCH 9.8)');
(function () {
  const runs = [0, 1].map(function () { return JSON.parse(execFileSync(process.execPath, [__filename, '--hash'], { encoding: 'utf8' })); });
  ['sales', 'finance', 'factory', 'store', 'insights', 'forecast'].forEach(function (k) {
    check(k + ' hash: two fresh processes and this run agree', runs[0][k] === runs[1][k] && runs[0][k] === before[k], JSON.stringify([runs[0][k], runs[1][k], before[k]]));
  });
  eq('apply() again is a no-op', JSON.stringify([MK.seed.apply().seeded, MK.hash(storeJson())]), JSON.stringify([false, before.store]));
  eq('isSeeded()', MK.seed.isSeeded(), true);
  /* a forced rebuild in this process: same checksums again, and a second timing sample (the first one includes JIT warm-up and whatever else the machine was doing) */
  let t2 = process.hrtime.bigint(); MK.engine.run({ force: true }); const engineAgain = ms(t2);
  t2 = process.hrtime.bigint(); MK.finance.build({ force: true }); const financeAgain = ms(t2);
  eq('forced rebuild gives the same checksums', JSON.stringify([MK.db.checksum, MK.finance.raw.checksum(), MK.factory.raw.checksum()]), JSON.stringify([before.sales, before.finance, before.factory]));
  eq('insights are unchanged after the rebuild', MK.hash(JSON.stringify(MK.insights.list(DEFAULT_FILTER))), before.insights);
  const build = Math.min(timing.engine + timing.finance, engineAgain + financeAgain);
  check('engine + finance + factory build under 600 ms (best of two)', build < 600, Math.round(build) + ' ms');
  /* a first boot is a fresh process: this one and the two hash runs are three samples of it; the quietest one is the machine-independent figure */
  const boots = [timing].concat(runs.map(function (r) { return r.timing; })).map(function (x) { return x.engine + x.finance + x.seed; });
  check('first boot including the seed under 600 ms (best of three fresh processes)', Math.min.apply(null, boots) < 600, boots.map(Math.round).join(' / ') + ' ms');
  note('rebuild: engine ' + Math.round(engineAgain) + ' ms, finance + factory ' + Math.round(financeAgain) + ' ms');
  check('insights for one filter under 60 ms (warm, best of three)', timing.insights < 60, Math.round(timing.insights) + ' ms');
  note('load ' + Math.round(timing.load) + ' ms, engine ' + Math.round(timing.engine) + ' ms, finance + factory ' + Math.round(timing.finance) + ' ms, seed ' + Math.round(timing.seed) + ' ms (first load only), insights ' + Math.round(timing.insights) + ' ms');
  note('hashes ' + JSON.stringify(before));
})();

/* ============================================== workflow: refusals and budget movement */

section('Workflow refusal paths; approving a bill moves budget "committed" (RESEARCH 9.6, SPEC 7)');
(function () {
  const W = MK.workflow;
  function refused(name, res, pattern) { check('refused: ' + name, res && res.ok === false && pattern.test(res.error || ''), res ? (res.ok ? 'was accepted' : res.error) : 'no result'); }
  function unchanged(name, fn) { const h = MK.hash(storeJson()); fn(); eq('store untouched after: ' + name, MK.hash(storeJson()), h); }

  const queue = bills.filter(function (b) { return b.status === 'SUBMITTED'; });
  const plain = queue.filter(function (b) { return !b.flags.length && b.createdBy === 'u_maker' && vendorById[b.vendorId].state === 'APPROVED'; })[0];
  const dup = queue.filter(function (b) { return b.flags.indexOf('DUPLICATE_INVOICE') !== -1; })[0];
  const paidBill = bills.filter(function (b) { return b.status === 'PAID'; })[0], draftOfMaker = bills.filter(function (b) { return b.status === 'DRAFT' && b.createdBy === 'u_maker'; })[0];
  const pending = batches.filter(function (p) { return p.status === 'PENDING_RELEASE'; })[0], released = batches.filter(function (p) { return p.status === 'RELEASED'; })[0];
  const blocked = bills.filter(function (b) { return b.status === 'APPROVED' && b.vendorId === 'v_print'; })[0];

  unchanged('all refusals below', function () {
    as('u_maker', function () { refused('the maker approving a bill', W.bill.approve(plain.id), /Not permitted for the Finance maker role/); });
    as('u_payer', function () { refused('the payer releasing the batch', W.batch.release(pending.id), /Not permitted for the Payer role/); });
    as('u_director', function () { refused('the director approving a bill', W.bill.approve(plain.id), /Not permitted/); refused('rejecting a batch without a reason', W.batch.reject(pending.id, ' '), /rejection reason is required/); });
    as('u_checker', function () {
      refused('rejecting a bill without a reason', W.bill.reject(plain.id, ''), /rejection reason is required/);
      refused('approving a duplicate invoice without a note', W.bill.approve(dup.id), /note is required/);
      refused('approving a paid bill', W.bill.approve(paidBill.id), /only a bill that is Under review can be approved/);
      refused('approving a vendor that needs review without an override', W.vendor.approve('v_print'), /use an override with a reason/);
      refused('an override without a reason', W.vendor.override('v_print', ''), /override reason is required/);
      refused('the checker creating a bill', W.bill.create({ unitId: 'bandra' }), /Not permitted/);
    });
    as('u_om_bandra', function () {
      refused('the Bandra manager billing Andheri', W.bill.create({ unitId: 'andheri', vendorId: 'v_pack', categoryId: 'packaging', invoiceNo: 'X-1', invoiceDate: '2026-09-15', amount: 100 }), /Outside your assigned outlet/);
      refused('the Bandra manager submitting the maker\'s draft', W.bill.submit(bills.filter(function (b) { return b.status === 'DRAFT' && b.createdBy === 'u_maker' && b.unitId === 'bandra'; })[0] ? bills.filter(function (b) { return b.status === 'DRAFT' && b.createdBy === 'u_maker' && b.unitId === 'bandra'; })[0].id : draftOfMaker.id), /Only the person who raised this|Outside your assigned outlet/);
      refused('the Bandra manager onboarding a vendor', W.vendor.create({ name: 'Test', unitIds: ['bandra'] }), /Not permitted/);
    });
    as('u_maker', function () {
      refused('billing a vendor that is not approved', W.bill.create({ unitId: 'bandra', vendorId: 'v_print', categoryId: 'local_marketing', invoiceNo: 'X-2', invoiceDate: '2026-09-15', amount: 5000 }), /not approved for billing \(currently Needs review\)/);
      refused('a category that does not apply to the unit', W.bill.create({ unitId: 'ho', vendorId: 'v_ca', categoryId: 'charcoal', invoiceNo: 'X-3', invoiceDate: '2026-09-15', amount: 5000 }), /does not apply to/);
      refused('an invoice dated after today', W.bill.create({ unitId: 'ho', vendorId: 'v_ca', categoryId: 'professional_fees', invoiceNo: 'X-4', invoiceDate: '2026-09-18', amount: 5000 }), /cannot be after today/);
      refused('expense lines that do not match the bill', W.bill.create({ unitId: 'ho', vendorId: 'v_ca', categoryId: 'professional_fees', invoiceNo: 'X-5', invoiceDate: '2026-09-15', amount: 5000, gstAmount: 900, lines: [{ categoryId: 'professional_fees', amount: 4000 }] }), /Expense lines must start/);
      refused('editing a paid bill', W.bill.update(paidBill.id, { amount: 1 }), /cannot be edited|only a bill that is Draft or Rejected/);
      refused('a duplicate GSTIN', W.vendor.create({ name: 'Copycat Traders', unitIds: ['factory'], pan: 'AAGFN4821K', gstin: vendorById.v_poultry.gstin, bankName: 'HDFC Bank', ifsc: 'HDFC0000001', bankAccount: '123456789012' }), /GSTIN already exists/);
    });
    as('u_payer', function () {
      refused('batching a bill whose vendor lost its approval', W.batch.create([blocked.id]), /not approved for payment/);
      refused('batching a bill that is not approved', W.batch.create([plain.id]), /only approved bills/);
      refused('recording UTRs on a batch that is not released', W.batch.markPaid(pending.id, { utr: 'HDFCN26260123456' }), /only a payment batch that is Released/);
      refused('an invalid UTR', W.batch.markPaid(released.id, { utr: 'abc' }), /UTR looks invalid/);
    });
    as('u_maker', function () {
      const okDraft = { unitId: 'ho', vendorId: 'v_ca', categoryId: 'professional_fees', invoiceNo: 'X-6', invoiceDate: '2026-09-15', amount: 5000 };
      const bad = function (patch) { return W.bill.create(Object.assign({}, okDraft, patch)); };
      refused('an amount above the ceiling', bad({ amount: 1e15 }), /above the limit/);
      refused('an invoice number of 5,000 characters', bad({ invoiceNo: new Array(5001).join('9') }), /limited to 40 characters/);
      refused('a description of 5,000 characters', bad({ description: new Array(5001).join('x') }), /limited to 500 characters/);
      refused('GST far above any rate', bad({ amount: 100, gstAmount: 99999 }), /GST cannot exceed/);
      refused('an invoice dated before the financial year', bad({ invoiceDate: '2019-01-01' }), /before the start of the financial year/);
      refused('an expense month outside the financial year', bad({ monthKey: '2031-01' }), /Expense month must lie/);
      refused('a due date decades away', bad({ dueDate: '2099-01-01' }), /more than 180 days/);
    });
    as('u_checker', function () {
      refused('a rejection reason that is not text', W.bill.reject(plain.id, {}), /rejection reason is required/);
      refused('a rejection reason of 5,000 characters', W.bill.reject(plain.id, new Array(5001).join('r')), /rejection reason is required/);
    });
    as('u_director', function () { refused('a batch rejection reason that is not text', W.batch.reject(pending.id, ['x', 'y', 'z']), /rejection reason is required/); });
    as('u_checker', function () { check('kernel: segregation of duties is enforced on top of the role', /Segregation of duties/.test(MK.session.can('bill.approve', { createdBy: 'u_checker' }).reason)); });
    check('pre-checks catch a wrong GSTIN check character', W.vendor.preChecks({ pan: 'AAGFN4821K', gstin: '27AAGFN4821K1Z9', ifsc: 'HDFC0002841', bankName: 'HDFC Bank', bankAccount: '123456789012' }).failed.indexOf('gstin_checksum') !== -1);
  });

  /* the live duplicate warning works on form state, where the amount is a string */
  as('u_checker', function () {
    const like = bills.filter(function (b) { return b.status === 'PAID' && b.vendorId === 'v_pack'; })[0], form = { vendorId: like.vendorId, unitId: like.unitId, invoiceNo: 'NEW-1', invoiceDate: D.addDays(like.invoiceDate, 3) };
    check('possible duplicate: same amount typed into a form field, within 7 days', W.bill.duplicateCheck(Object.assign({ amount: String(like.amount) }, form)).hasPossible && W.bill.duplicateCheck(Object.assign({ amount: like.amount }, form)).hasPossible &&
      !W.bill.duplicateCheck(Object.assign({ amount: String(like.amount + 1) }, form)).hasPossible && !W.bill.duplicateCheck(Object.assign({ amount: String(like.amount) }, form, { invoiceDate: D.addDays(like.invoiceDate, 8) })).hasPossible);
  });

  /* budget: pipeline -> committed on approval */
  const month = plain.monthKey, lineOf = function () { return MK.finance.budget(month, plain.unitId).rows.filter(function (r) { return r.categoryId === plain.categoryId; })[0]; };
  const b0 = lineOf(), insightsBefore = MK.insights.list(DEFAULT_FILTER).length;
  as('u_checker', function () { check('the checker approves a submitted bill', W.bill.approve(plain.id).ok); });
  const b1 = lineOf();
  const plainCost = W.bill.expenseParts(plain)[0].amount;
  check('a bill costs its budget line amount + GST (no input credit)', plainCost === plain.amount + plain.gstAmount - sum((plain.lines || []).slice(1), function (l) { return l.amount; }) && W.bill.budgetImpact(plain).amount === plainCost);
  eq('budget committed rises by what the bill costs', b1.committed - b0.committed, plainCost);
  eq('budget pipeline falls by what the bill costs', b0.pipeline - b1.pipeline, plainCost);
  eq('the approval wrote two audit events on the demo clock (review, approve)', MK.audit.list({ entityId: plain.id, from: cal.today }).map(function (e) { return e.action + '@' + e.at.slice(11); }).join(), 'bill.approve@10:00,bill.review@10:00');

  /* the duplicate can be approved only with a note; the director releases; the payer records UTRs */
  as('u_checker', function () { check('a duplicate is approved once a note explains it', W.bill.approve(dup.id, 'Second copy of a paid invoice - to be rejected in real life; approved here to test the rule').ok); });
  as('u_director', function () { check('the director releases the pending batch', W.batch.release(pending.id).ok); });
  as('u_payer', function () { check('the payer records a UTR for the released batch', W.batch.markPaid(released.id, { utr: 'HDFCN26260999001' }).ok); });
  check('its bills are paid', MK.store.coll('bills').all().filter(function (b) { return b.batchId === released.id; }).every(function (b) { return b.status === 'PAID' && b.utr === 'HDFCN26260999001'; }));
  const after = MK.insights.list(DEFAULT_FILTER).map(function (x) { return x.id; });
  check('insights follow the store: the released batch is no longer "awaiting release"', after.indexOf('batch|' + pending.id) !== -1 && MK.insights.list(DEFAULT_FILTER).filter(function (x) { return x.id === 'batch|' + pending.id; })[0].severity === 'info' && after.indexOf('batch|' + released.id) === -1, insightsBefore + ' before');

  /* a bank-detail edit withdraws the approval and blocks payment */
  as('u_maker', function () { check('the maker edits a vendor\'s bank account', W.vendor.update('v_poultry', { bankAccount: '50200011223344', ifsc: 'HDFC0002841' }).ok); });
  eq('the vendor drops back to VERIFYING', MK.store.coll('vendors').byId('v_poultry').state, 'VERIFYING');
  const poultryBill = MK.store.coll('bills').all().filter(function (b) { return b.vendorId === 'v_poultry' && b.status === 'APPROVED'; })[0];
  if (poultryBill) as('u_payer', function () { refused('paying a vendor after a bank-detail change', W.batch.create([poultryBill.id]), /not approved for payment \(currently Verifying\)/); });

  /* reset: the demo returns to exactly the seeded state */
  MK.store.resetAll();
  eq('after resetAll() nothing is seeded', MK.seed.isSeeded(), false);
  const again = MK.seed.apply({ force: true });
  check('reseed', again.ok && again.seeded);
  eq('the reseeded store is identical to the first seed', MK.hash(storeJson()), before.store);
})();

/* ======================================================================== forecasting */

section('Forecasting: the outlook, its measured accuracy, the purchase suggestions and the month-end projection (API-forecast)');
(function () {
  const F = MK.forecast;
  F.setSettings({ weeks: 8, safetyDays: { fresh: 0.5, dry: 10 } });
  eq('defaults: balanced (8 weeks), fresh 0.5 day, dry 10 days', JSON.stringify(F.settings()), JSON.stringify({ weeks: 8, safetyDays: { fresh: 0.5, dry: 10 } }));
  /* Layer 1: the outlook */
  const d = F.daily({});
  eq('daily(): from today to the end of the month', d.from + '..' + d.to, cal.today + '..' + D.monthEnd(cal.today));
  eq('daily(): one entry per remaining day', d.days.length, D.diffDays(cal.today, D.monthEnd(cal.today)) + 1);
  check('daily(): consecutive dates', d.days.every(function (x, i) { return i === 0 || x.date === D.addDays(d.days[i - 1].date, 1); }));
  eq('daily(): the total is the sum of the days', d.total, sum(d.days, function (x) { return x.value; }));
  check('daily(): every day positive, lo <= value <= hi', d.days.every(function (x) { return x.value > 0 && x.lo <= x.value && x.value <= x.hi; }));
  check('daily(): the band of the sum is narrower than the sum of the daily bands', (d.hi - d.lo) < sum(d.days, function (x) { return x.hi - x.lo; }), (d.hi - d.lo) + ' vs ' + sum(d.days, function (x) { return x.hi - x.lo; }));
  const fcWe = d.days.filter(function (x) { return x.dow >= 5; }), fcWd = d.days.filter(function (x) { return x.dow < 5; });
  check('daily(): Saturdays and Sundays forecast above the weekdays, as in the data', sum(fcWe, function (x) { return x.value; }) / fcWe.length > sum(fcWd, function (x) { return x.value; }) / fcWd.length);
  const me = F.monthEnd({});
  eq('monthEnd(): to date = MK.data.summary of the month so far', me.toDate, MK.data.summary({ from: D.monthStart(cal.today), to: cal.dataEnd }).netSales);
  eq('monthEnd(): projected = to date + the forecast of the rest', me.projected, me.toDate + me.remaining);
  eq('monthEnd(): the rest is daily() of the same outlets', me.remaining, d.total);
  check('monthEnd(): within 15% of a plain run-rate and of last month', Math.abs(me.projected / me.runRate - 1) < 0.15 && Math.abs(me.projected / me.lastMonth.netSales - 1) < 0.15, [me.projected, me.runRate, me.lastMonth.netSales].join(' / '));
  check('monthEnd(): above the run-rate - Shravan and Ganesh Chaturthi held the first half of September down', me.projected > me.runRate, me.projected + ' vs ' + me.runRate);
  const acc = F.accuracy({});
  eq('accuracy(): eight backtest weeks', acc.points.length, 8);
  check('accuracy(): each backtest week\'s actual is the sales of that week', acc.points.every(function (p) { return p.actual === MK.data.summary({ from: p.weekStart, to: p.weekEnd }).netSales; }));
  check('accuracy(): backtest weeks run Monday to Sunday and end before today', acc.points.every(function (p) { return D.dow(p.weekStart) === 0 && D.dow(p.weekEnd) === 6 && p.weekEnd < cal.today; }));
  check('accuracy(): daily WAPE between 5% and 20%, weekly under 10%', acc.wape > 0.05 && acc.wape < 0.20 && acc.weeklyWape < 0.10, acc.wape.toFixed(3) + ' / ' + acc.weeklyWape.toFixed(3));
  check('accuracy(): beats the same-day-last-week baseline by day and by week', acc.wape < acc.naiveWape && acc.weeklyWape < acc.weeklyNaiveWape, acc.naiveWape.toFixed(3) + ' / ' + acc.weeklyNaiveWape.toFixed(3));
  check('accuracy(): bias within +/-5%', Math.abs(acc.bias) < 0.05, acc.bias.toFixed(3));
  eq('accuracy(): every reactiveness setting is scored', acc.bySetting.map(function (x) { return x.weeks; }).join(','), '4,8,12');
  note('accuracy: daily WAPE ' + (acc.wape * 100).toFixed(1) + '%, weekly ' + (acc.weeklyWape * 100).toFixed(1) + '%; same-day-last-week ' + (acc.naiveWape * 100).toFixed(1) + '% / ' + (acc.weeklyNaiveWape * 100).toFixed(1) + '%; bias ' + (acc.bias * 100).toFixed(1) + '%; by setting ' + acc.bySetting.map(function (x) { return x.label + ' ' + (x.weeklyWape * 100).toFixed(1) + '%'; }).join(', ') + ' (weekly)');
  /* the event calendar beyond the data */
  const oct = cfg.events.filter(function (e) { return e.from > cal.dataEnd; });
  eq('two calendar entries lie beyond the data (Navratri, Dussehra) and the engine ignores them', oct.map(function (e) { return e.id; }).join(','), 'navratri,dussehra');
  check('eventFactor: Navratri dampens Kalyan more than Bandra', F.raw.eventFactor('kalyan', '2026-10-12') < F.raw.eventFactor('bandra', '2026-10-12') && F.raw.eventFactor('bandra', '2026-10-12') < 1);
  check('eventFactor: Dussehra lifts every outlet', OUTLETS.every(function (o) { return F.raw.eventFactor(o, '2026-10-20') > 1.1; }));
  eq('eventFactor: weather is never applied to a forecast day (the 4 Aug rain)', F.raw.eventFactor('bandra', '2026-08-04', true), 1);
  check('eventFactor: weather is taken out of history (ex post)', F.raw.eventFactor('bandra', '2026-08-04', false) !== 1);
  check('eventFactor: a festival is applied ex ante and ex post alike (Shravan, 2 Sep)', Math.abs(F.raw.eventFactor('bandra', '2026-09-02', true) - 0.93) < 1e-9 && F.raw.eventFactor('bandra', '2026-09-02', false) < 0.93);
  const up = F.upcoming({});
  eq('upcoming(): Navratri, then Dussehra', up.map(function (e) { return e.id; }).join(','), 'navratri,dussehra');
  check('upcoming(): Navratri lowers, Dussehra lifts, and Navratri moves the veg dishes up', up[0].effect < -0.08 && up[1].effect > 0.1 && up[0].dishes[0].mult > 1, up[0].effect + ' / ' + up[1].effect);
  /* Layer 3: purchase suggestions */
  const ps = F.purchaseSuggestions();
  eq('purchaseSuggestions(): one row per raw material', ps.rows.length, cfg.items.rawMaterials.length);
  check('purchaseSuggestions(): the working has four lines on every row', ps.rows.every(function (r) { return r.working.length === 4; }));
  check('purchaseSuggestions(): forecast use within 15% of the kitchen\'s recent average on every item', ps.rows.every(function (r) { return Math.abs(r.usePerDay / r.recentUsePerDay - 1) < 0.15; }), ps.rows.map(function (r) { return r.rmId + ' ' + (r.usePerDay / r.recentUsePerDay).toFixed(2); }).join(' '));
  check('purchaseSuggestions(): fresh items are ordered today or covered, never "this week"', ps.rows.filter(function (r) { return r.storage === 'fresh'; }).every(function (r) { return r.status !== 'ORDER_THIS_WEEK' && (!r.orderBy || r.orderBy === cal.today); }));
  check('purchaseSuggestions(): order quantities are whole lots and value = quantity x price', ps.rows.every(function (r) { const lot = F.raw.model.lot[r.storage]; return Math.abs(r.orderQty / lot - Math.round(r.orderQty / lot)) < 1e-9 && r.value === Math.round(r.orderQty * r.price); }));
  check('purchaseSuggestions(): an order placed today tops the stock up to the cover wanted', ps.rows.filter(function (r) { return r.status === 'ORDER_TODAY'; }).every(function (r) { return r.onHand + r.orderQty >= r.wantedQty - 0.05; }));
  eq('purchaseSuggestions(): the totals add up', ps.totals.today.value + ps.totals.week.value, sum(ps.rows.filter(function (r) { return r.orderQty > 0; }), function (r) { return r.value; }));
  check('purchaseSuggestions(): chicken is the largest order of the day', ps.rows[0].rmId === 'RM_CHICKEN' && ps.rows[0].status === 'ORDER_TODAY', ps.rows[0].rmId);
  const chicken = ps.rows[0].orderQty;
  F.setSettings({ safetyDays: { fresh: 2 } });
  const chickenMore = F.purchaseSuggestions().rows.filter(function (r) { return r.rmId === 'RM_CHICKEN'; })[0].orderQty;
  check('the fresh safety dial raises the chicken order in real time', chickenMore > chicken, chicken + ' -> ' + chickenMore);
  F.setSettings({ safetyDays: { fresh: 0.5 } });
  eq('and back again', F.purchaseSuggestions().rows[0].orderQty, chicken);
  eq('an out-of-range setting is snapped to the dial', F.setSettings({ safetyDays: { fresh: 9 } }).safetyDays.fresh, 3);
  eq('an unknown reactiveness is ignored', F.setSettings({ weeks: 5 }).weeks, 8);
  F.setSettings({ safetyDays: { fresh: 0.5 } });
  /* Layer 3: a budget line at month-end */
  const lp = F.lineProjection('andheri', 'cogs_local', '2026-09', 10000);
  check('lineProjection(): a sales-driven line scales the accrual by the sales forecast; the bill under review is a share, not an addition', lp.available && lp.method === 'sales' && lp.projected === Math.round(lp.accrued * lp.salesRatio) && lp.billShare === 10000 / lp.plan, JSON.stringify(lp));
  check('lineProjection(): local food cost at Andheri is heading over its September plan although its bills so far sit under half of it', lp.status === 'OVER' && lp.utilisation > 1 && lp.usedPct < 0.5, lp.utilisation + ' / ' + lp.usedPct);
  const lpRent = F.lineProjection('andheri', 'rent', '2026-09', 0);
  check('lineProjection(): a fixed line is the accrual so far plus the plan for the days left (rent at Andheri lands just under plan)', lpRent.available && lpRent.method === 'plan-rest' && lpRent.projected === Math.round(lpRent.accrued + lpRent.plan * lpRent.daysLeft / lpRent.daysInMonth) && lpRent.utilisation < 1 && lpRent.status === 'NEAR', JSON.stringify(lpRent));
  eq('lineProjection(): an unknown category has no line', F.lineProjection('andheri', 'no_such_category', '2026-09', 0).reason, 'no-line');
  eq('lineProjection(): a complete month has no projection', F.lineProjection('andheri', 'rent', '2026-08', 0).reason, 'complete');
  check('lineProjection(): the factory\'s raw materials follow company-wide sales', F.lineProjection('factory', 'raw_materials', '2026-09', 0).method === 'sales');
  /* the reactiveness dial moves every figure, deterministically */
  const was = F.raw.checksum();
  F.setSettings({ weeks: 4 });
  check('the reactiveness dial moves the projection', F.monthEnd({}).projected !== me.projected && F.raw.checksum() !== was);
  F.setSettings({ weeks: 8 });
  eq('back on balanced: the same checksum', F.raw.checksum(), was);
  F.raw.reset();
  eq('a rebuild gives the same checksum', F.raw.checksum(), was);
  /* scope */
  as('u_om_bandra', function () {
    eq('Bandra manager: the outlook covers Bandra only', F.daily({}).outletIds.join(','), 'bandra');
    eq('Bandra manager: no purchase suggestions (no factory in scope)', F.purchaseSuggestions().rows.length, 0);
    eq('Bandra manager: a Bandra line projects, an Andheri line does not', [F.lineProjection('bandra', 'cogs_local', '2026-09', 0).available, F.lineProjection('andheri', 'cogs_local', '2026-09', 0).available].join(','), 'true,false');
  });
  as('u_fm', function () {
    eq('factory manager: no sales outlook', F.monthEnd({}).available, false);
    eq('factory manager: the full suggestion list', F.purchaseSuggestions().rows.length, cfg.items.rawMaterials.length);
    eq('factory manager: the factory budget projects', F.lineProjection('factory', 'raw_materials', '2026-09', 0).available, true);
  });
  const prefs = MK.store.get('prefs', {}); delete prefs.forecast; MK.store.set('prefs', prefs);
})();

/* ======================================================================== the rules catalogue and its dials */

section('Rules catalogue (#/system/rules): every finding belongs to a rule, the dials move the list, the defaults restore it');
(function () {
  const I = MK.insights;
  I.resetThresholds();
  const was = MK.hash(JSON.stringify(I.list(DEFAULT_FILTER)));
  const cat = I.catalogue(DEFAULT_FILTER);
  eq('one catalogue entry per family of finding', cat.rules.length, I.FAMILIES.length);
  check('every finding on the opening filter is attributed to a catalogue rule', I.list(DEFAULT_FILTER).every(function (x) { return x.rule && cat.rules.some(function (r) { return r.id === x.rule; }); }));
  eq('the fires-now counts add up to the list', sum(cat.rules, function (r) { return r.fires.count; }), cat.totals.firing);
  eq('and the totals match counts()', JSON.stringify(cat.totals.counts), JSON.stringify(I.counts(DEFAULT_FILTER)));
  check('every family prefix is distinct and every finding id starts with exactly one of them', I.list(DEFAULT_FILTER).every(function (x) { return I.FAMILIES.filter(function (f) { return x.id.indexOf(f.prefix) === 0; }).length === 1; }));
  const refs = [].concat.apply([], cat.rules.map(function (r) { return r.thresholds.map(function (t) { return t.ref; }); })).concat(cat.settings.map(function (t) { return t.ref; }));
  check('every dial appears in the catalogue exactly once', refs.length === I.THRESHOLDS.length && refs.every(function (ref, i) { return refs.indexOf(ref) === i && I.THRESHOLDS.some(function (d) { return d.ref === ref; }); }), refs.join(','));
  check('every dial is at its default and its default is the shipped value', cat.totals.changed === 0 && I.THRESHOLDS.every(function (d) { return (d.rule ? I.RULES[d.rule][d.key] : I.RULES[d.key]) === (d.rule ? I.DEFAULTS[d.rule][d.key] : I.DEFAULTS[d.key]); }));
  check('every dial has a sensible range around its default', I.THRESHOLDS.every(function (d) { const def = d.rule ? I.DEFAULTS[d.rule][d.key] : I.DEFAULTS[d.key]; return d.min < d.max && def >= d.min && def <= d.max && d.step > 0; }));
  /* the dials move the list */
  const gap = I.RULES.takeRate.gapPts;
  I.setThreshold('takeRate.gapPts', 0.01);
  const loose = I.list(DEFAULT_FILTER).filter(function (x) { return x.rule === 'takerate'; }).length;
  I.setThreshold('takeRate.gapPts', 0.12);
  const tight = I.list(DEFAULT_FILTER).filter(function (x) { return x.rule === 'takerate'; }).length;
  check('loosening the take-rate gap finds more outlets than tightening it', loose > tight && tight === 0, loose + ' vs ' + tight);
  eq('the live RULES object follows the dial (pages read it directly)', I.RULES.takeRate.gapPts, 0.12);
  eq('catalogue() counts the change', I.catalogue(DEFAULT_FILTER).totals.changed, 1);
  I.setThreshold('approvals.waitDays', 1);
  check('a one-day wait puts more bills on the list than three days', I.list(DEFAULT_FILTER).filter(function (x) { return x.rule === 'approvals_waiting'; }).length === 1 && /bills have waited 1 day/.test(I.list(DEFAULT_FILTER).filter(function (x) { return x.rule === 'approvals_waiting'; })[0].title));
  eq('an out-of-range value is snapped to the dial', I.setThreshold('approvals.waitDays', 99), 14);
  eq('a value off the step is snapped to it', I.setThreshold('rent.warnPct', 0.1234), 0.125);
  eq('an unknown dial is refused', I.setThreshold('nonsense.key', 1), null);
  eq('the negative dial keeps its sign', I.setThreshold('absorption.underPct', -0.08), -0.08);
  I.resetThresholds('rent.warnPct');
  eq('resetting one dial leaves the others', JSON.stringify([I.RULES.rent.warnPct, I.RULES.approvals.waitDays]), JSON.stringify([I.DEFAULTS.rent.warnPct, 14]));
  I.resetThresholds();
  eq('reset restores every default', I.RULES.takeRate.gapPts + '|' + I.RULES.approvals.waitDays + '|' + I.RULES.absorption.underPct, gap + '|' + I.DEFAULTS.approvals.waitDays + '|' + I.DEFAULTS.absorption.underPct);
  eq('and the opening list is exactly what it was', MK.hash(JSON.stringify(I.list(DEFAULT_FILTER))), was);
  as('u_om_bandra', function () {
    const c = I.catalogue(DEFAULT_FILTER);
    eq('Bandra manager: the catalogue counts only Bandra\'s findings', c.totals.firing, I.list(DEFAULT_FILTER).length);
    check('Bandra manager: no factory rule fires', c.rules.filter(function (r) { return r.area === 'Factory'; }).every(function (r) { return r.fires.count === 0; }));
  });
})();

/* ===================================================== the API documents quote what the code does */

section('API documents are in step with the code (docs/API*.md)');
(function () {
  /*
   * Samples in the documents are captured from a run, so they drift when a parameter moves. These are the facts a page author
   * is most likely to rely on; when one fails, regenerate the samples of that document. Skipped for a candidate demand seed.
   */
  if (process.env.MK_DEMAND_SEED) { note('skipped: a candidate demand seed is being tried (MK_DEMAND_SEED)'); return; }
  const doc = function (name) { return fs.readFileSync(path.join(ROOT, 'docs', name), 'utf8'); };
  const api = doc('API.md'), sales = doc('API-sales.md'), finance = doc('API-finance.md'), workflow = doc('API-workflow.md');
  const quotes = function (text, what) { return text.indexOf(what) !== -1; };
  check('API.md and API-sales.md name the demand seed in force', quotes(api, '\'' + cfg.demand.seed + '\'') && quotes(sales, '\'' + cfg.demand.seed + '\''), cfg.demand.seed);
  check('API.md names the seed version', quotes(api, '\'' + MK.seed.version + '\''), MK.seed.version);
  const heads = OUTLETS.map(function (o) { return sum(cfg.wages.staffing[o]); }).join(' / ');
  check('the rosters quoted in API-finance.md and API-sales.md are the rosters of MK.config.wages.staffing', quotes(finance, heads) && quotes(sales, heads), heads);
  const s = MK.data.summary(DEFAULT_FILTER), ro = MK.data.recentOrders(null, {}), aug = MK.finance.pnl('all', '2026-08').totals;
  check('API-sales.md: the summary sample is the opening filter of today\'s dataset', quotes(sales, 'netSales: ' + s.netSales) && quotes(sales, 'orders: ' + s.orders), s.netSales + ' / ' + s.orders);
  check('API-sales.md: recentOrders().total is quoted with cancelled orders included', quotes(sales, 'total: ' + ro.total), String(ro.total));
  check('API-finance.md: the company P&L sample is August of today\'s dataset', quotes(finance, 'ebitda: ' + aug.ebitda) && quotes(finance, 'netSales: ' + aug.netSales), aug.ebitda + ' / ' + aug.netSales);
  check('API.md and API-workflow.md quote the seeded bill count', quotes(api, bills.length + ' bills') && quotes(workflow, bills.length + ' bills'), bills.length + ' bills');
  check('API-finance.md documents the keys added for estimates and scope', ['channelCostsEstimated', 'variableCostEstimatedPct', 'inTransit', 'estimatedPart', 'basis: \'bills\''].every(function (k) { return quotes(finance, k); }) &&
    ['hasData', 'actualThrough', 'markupSummary', 'provisional', 'statementSource', 'salesSource', 'breakEvenMarkupPct', 'contributionAfterPackaging'].every(function (k) { return quotes(sales, k); }));
  /* last of all: the count the entry document quotes is the count of this run (this assertion included) */
  const total = passes + failures + 1;
  check('API.md quotes the number of assertions of this file', quotes(api, '(' + total + ' assertions'), 'this run has ' + total);
})();

/* =========================================================================== report */

const line = '--------------------------------------------------------------------------------';
console.log('Miya Kebabs mockup - data layer checks (demo date ' + cal.today + ', data ' + cal.dataStart + ' .. ' + cal.dataEnd + ')');
console.log(line);
sections.forEach(function (s) {
  console.log((s.failed ? 'FAIL' : 'ok  ') + '  ' + s.title + '  [' + s.passed + ' passed' + (s.failed ? ', ' + s.failed + ' FAILED' : '') + ']');
  s.lines.forEach(function (l) { console.log('    ' + l); });
});
console.log(line);
console.log(failures ? failures + ' of ' + (passes + failures) + ' assertions FAILED' : 'All ' + passes + ' assertions passed');
process.exit(failures ? 1 : 0);
