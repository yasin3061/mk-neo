# Sales data layer API (`js/data/config.js`, `engine.js`, `sales.js`)

Everything below was captured from a Node run of the shipped code (samples trimmed, numbers real, persona = Director).
Load order: `kernel.js`, `config.js`, `engine.js`, `sales.js`. `app.js` calls `MK.engine.run()` at boot;
selectors also call it lazily, so they work in any order after the three files are loaded.

Conventions

- Money is whole rupees. Rates and shares are fractions (`0.22`). Dates are ISO `YYYY-MM-DD`; order
  timestamps are calendar-local `YYYY-MM-DDTHH:MM`. A **business day** runs 12:00 noon to 04:00 next
  morning: an order placed at 01:30 on 17 Sep has `businessDate: '2026-09-16'`, `hour: 25`.
- **Net sales** = item value + packaging charge - restaurant-funded discount, **net of GST**.
  `grossSales` = item value + packaging charge (menu value before discount). Cancelled orders add
  nothing to sales; they are counted in `cancelled` / `cancelledValue` only.
- Public selectors (`MK.data.*`) are **scoped**: requested outlets are intersected with
  `MK.session.allowedOutletIds()` at call time. `MK.db.*` is **unscoped raw data for the finance,
  factory and seed layers only** - pages must never read it for display.
- Selectors never throw. Unknown ids are ignored - including ids that are names on `Object.prototype` such as
  `'constructor'` (route parameters are user-editable); an empty resulting scope returns zeroed results with
  the same shape (empty `rows` / `series`). Keys that are `null` by contract are marked so next to their sample.
- Every sales result carries `source: 'petpooja'` (order data always comes from the POS, for Swiggy and Zomato
  orders too) and `provisional` (section 2.1).
- The demand seed is a parameter (`MK.config.demand.seed = 'mk-sales-v825'`, chosen so that every marked event shows in
  the data and every calibration band holds); every sample below moves with it.
- Build time: about 220-250 ms cold in Node 24; selectors 0.3-11 ms warm over the full financial year
  (`summary` 0.3 ms, `dishes` 8 ms, `auditFlags` 11 ms).

## 1. Filter object

```js
f = { from: '2026-09-01', to: '2026-09-16', outletIds: null, channelIds: null, mediumIds: null }
```

- `from` / `to`: inclusive business dates; missing or invalid = data start / data end; swapped if reversed. **Both ends are
  clamped into** `2026-04-01 .. 2026-09-16`, so the echoed `from <= to` always holds; a request that lies wholly outside the
  data gives a zeroed result with `days: 0`. `MK.filters.get()` can be passed as is (extra keys are ignored).
- `outletIds`, `channelIds`, `mediumIds`: an array of ids, or **a single id as a string** (`outletIds: 'bandra'` reads as
  `['bandra']`); `null`, missing or `[]` = all. Channel and medium combine through
  the four valid streams (`channelIds:['swiggy'], mediumIds:['dinein']` selects nothing -> zeroed result).
- `f` itself may be `null` (= everything the persona may see).

## 2. Selectors

### 2.1 `MK.data.summary(f)`

```js
MK.data.summary({ from: '2026-09-01', to: '2026-09-16' })
{ orders: 11427, netSales: 6122422, grossSales: 6545700, grossItemValue: 6426900, packaging: 118800,
  restaurantDiscount: 423278, discountPct: 0.0647,          // discount / grossSales
  gst: 307280,                                              // = the two parts below; never label `gst` alone as payable
  gstCollectedByRestaurant: 112380,                         // in-store: collected by the restaurant, payable
  gstMemoAggregator: 194900,                                // memo: collected and paid by Swiggy / Zomato u/s 9(5)
  aov: 535.7856,                                            // netSales / orders
  items: 22793, itemsPerOrder: 1.9947,
  cancelled: 181, cancelledValue: 95860, cancelRate: 0.0156,    // cancelled / (orders + cancelled)
  from: '2026-09-01', to: '2026-09-16', days: 16, ordersPerDay: 714.1875, netSalesPerDay: 382651.375,
  prev: { ...same measures..., from: '2026-08-16', to: '2026-08-31', days: 16, complete: true },
  source: 'petpooja',
  provisional: { swiggyDiscountSplitFrom: '2026-09-13',     // null by contract - see below
                 note: 'Swiggy restaurant-funded discount and net sales from this date are as relayed to the POS; the discount split is confirmed with the payout annexure' } }
```

`prev` is the immediately preceding period of equal length, clipped to data start. `prev.complete` is
`false` when it was clipped (fewer days) and `prev.from === null` with zeroed measures when nothing precedes.

`provisional` (on `summary`, `series`, `breakdown`, `matrix` and `dishes`): Swiggy relays one unsplit discount total; its
restaurant-funded share is confirmed only by the weekly annexure (capability `order.discountRestaurantFunded` = `partial`).
The model has no platform-funded discounts, so the figures stand, but a range that runs past Swiggy's settled-through date
(12 Sep) is provisional on that point: caption it "Swiggy discount split confirmed with the annexure". It is `null` when the
range ends on or before that date, when Swiggy is filtered out, and with an empty scope.

### 2.2 `MK.data.series(f, { measure, grain, by })`

- `measure`: one of `MK.data.MEASURES` = `orders, netSales, grossSales, aov, items, itemsPerOrder,
  restaurantDiscount, discountPct, cancelled, cancelRate, qty, gstCollectedByRestaurant, gstMemoAggregator`
  (default `netSales`; `qty` exists for dish dimensions only - here its values are `null`).
- `grain`: `'day'` (default) | `'week'` (Monday-start, first and last bucket may be partial) | `'month'`.
- `by`: `null` | `'outlet'` | `'city'` | `'channel'` | `'medium'` | `'stream'`.

```js
MK.data.series(f, { measure: 'netSales', grain: 'week', by: 'channel' })
{ measure: 'netSales', grain: 'week', by: 'channel', from: '2026-09-01', to: '2026-09-16',
  buckets: [ { key: '2026-08-31', label: '1 Sep - 6 Sep', from: '2026-09-01', to: '2026-09-06' },
             { key: '2026-09-07', label: '7 Sep - 13 Sep', from: '2026-09-07', to: '2026-09-13' },
             { key: '2026-09-14', label: '14 Sep - 16 Sep', from: '2026-09-14', to: '2026-09-16' } ],
  series: [ { id: 'petpooja', label: 'Petpooja POS', colourVar: '--ch-petpooja', values: [811779, 1030581, 389911] },
            { id: 'swiggy', label: 'Swiggy', colourVar: '--ch-swiggy', values: [704906, 773556, 279779] },
            { id: 'zomato', label: 'Zomato', colourVar: '--ch-zomato', values: [872868, 918651, 340391] } ],
  total: [2389553, 2722788, 1010081],     // ratio measures are recomputed from summed bases, never averaged
  source: 'petpooja', provisional: { swiggyDiscountSplitFrom: '2026-09-13', note: '...' } }
```

Bucket keys: day = the date, week = the Monday of the week, month = `YYYY-MM` (label `Sep 2026`).
With `by: null` there is one series `{ id: 'all', label: 'All', values: total }`. Only members inside the scope appear.

### 2.3 `MK.data.breakdown(f, by)`

`by`: any of `MK.data.DIMENSIONS` = `outlet, city, channel, medium, stream, slot, hour, dow, dish, category, day, week, month`.

```js
MK.data.breakdown(f, 'outlet')
{ by: 'outlet', from, to, dishLevel: false, source: 'petpooja', provisional: {...} | null,
  total: { ...exactly the summary(f) measures, without prev... },
  rows: [ { id: 'bandra', label: 'Bandra', short: 'Bandra', colourVar: '--ot-1',
            orders: 2618, netSales: 1478123, grossSales: 1537949, grossItemValue: 1512609, packaging: 25340,
            restaurantDiscount: 59826, discountPct: 0.0389,
            gst: 74223, gstCollectedByRestaurant: 34179, gstMemoAggregator: 40044,   // every non-dish row carries the split
            aov: 564.6001, items: 5583, itemsPerOrder: 2.1325, cancelled: 27, cancelledValue: 16951, cancelRate: 0.0102,
            share: 0.2414,                                  // of total net sales
            prevNetSales: 1382163, prevOrders: 2464 },      // previous equal-length period; null for day / week / month
          ... ] }
```

A "GST" column by outlet, city, slot, hour, day of week or time grain must use `gstCollectedByRestaurant` (payable) and
show `gstMemoAggregator` as a memo; `gst` is their sum and must never be labelled payable. On a `channel` row the memo part is 0
for `petpooja` and the collected part is 0 for the aggregators.

Row identity fields per dimension: `outlet` {id, label, short, colourVar}; `city` {id: 'mumbai'|'pune', label};
`channel` / `medium` / `stream` {id, label, colourVar}; `slot` {id, label, range}; `hour` {id: '20', label: '8 pm', hour: 20, slotId};
`dow` {id: '0'..'6' (0 = Monday), label: 'Mon'}; `dish` {id, label, short, category, veg}; `category` {id, label};
time grains {id, key, label, from, to}. Rows come in config order (time ascending), never sorted by value.

Dish dimensions (`dish`, `category`) set `dishLevel: true` and rows carry only:

```js
{ id: 'angara_shawarma', label: 'Angara Chicken Shawarma', short: 'Angara Shawarma', category: 'shawarma', veg: false, colourVar: null,
  qty: 5738, netSales: 1387017, grossSales: 1453724,
  orders: 4508,                     // orders containing the dish - not additive across dishes
  share: 0.2265, prevNetSales: 1309207, prevOrders: 4268 }
```

Dish net sales include the order's packaging charge and discount spread over its lines pro rata, so that
**sum of dish netSales = total netSales to the rupee**. Dish `grossSales` is menu price x qty (no packaging).

### 2.4 `MK.data.matrix(f, rowDim, colDim, measure)`

Any two dimensions of 2.3 (also on the same axis, e.g. `channel` x `medium`, `dow` x `week`). Restrictions:
`hour` cannot be combined with `dish` / `category` (use `slot`); with a dish dimension the measure must be one of
`MK.data.DISH_MEASURES` = `qty, netSales, grossSales, orders`. Unsupported or unknown -> `supported: false`, empty arrays.

```js
MK.data.matrix(f, 'outlet', 'channel', 'netSales')
{ rowDim: 'outlet', colDim: 'channel', measure: 'netSales', from, to, supported: true, source: 'petpooja', provisional: {...} | null,
  rows: [ { id: 'bandra', label: 'Bandra', short: 'Bandra', colourVar: '--ot-1' }, ...5 ],
  cols: [ { id: 'petpooja', label: 'Petpooja POS', colourVar: '--ch-petpooja' }, { id: 'swiggy', ... }, { id: 'zomato', ... } ],
  values: [ [679394, 281698, 517031], [469891, 630012, 565287], [542333, 221758, 292304], [369781, 227564, 288347], [170872, 397209, 468941] ],
  rowTotals: [1478123, 1665190, 1056395, 885692, 1037022], colTotals: [2232271, 1758241, 2131910], total: 6122422 }
```

Typical calls: `matrix(f, 'dow', 'hour', 'orders')` (heatmap), `matrix(f, 'dish', 'channel', 'qty')`,
`matrix(f, 'outlet', 'slot', 'netSales')`, `matrix(f, 'channel', 'medium', 'orders')` (impossible pairs are 0),
`matrix(f, 'outlet', 'channel', 'gstMemoAggregator')` (the GST split is a measure like any other).

### 2.5 `MK.data.dishes(f)`

```js
{ from, to, source: 'petpooja', provisional: {...} | null, totals: { qty: 22793, netSales: 6122422, grossSales: 6426900 },
  hasCost: true,                    // false when MK.finance.dishCost is absent -> no cost fields at all
  thresholds: { popularity: 0.0583, contributionPerPortion: 177.7536, rule: 'Popular = at least 70% of an equal share ...' },  // null without cost, and with an empty scope
  rows: [ { id: 'angara_shawarma', name: 'Angara Chicken Shawarma', short: 'Angara Shawarma', category: 'shawarma', veg: false, isAttach: false,
            qty: 5738, orders: 4508, netSales: 1387017, grossSales: 1453724,
            byChannel: { petpooja: { qty: 2429, netSales: 457672 }, swiggy: { qty: 1505, netSales: 422002 }, zomato: { qty: 1804, netSales: 507343 } },
            posPrice: 185,                                   // POS price in force on f.to
            aggPrice: 309,                                   // most common aggregator price among the outlets in scope (null if not listed)
            aggPriceByOutlet: { bandra: 309, andheri: 309, fort: 309, kalyan: 275, koregaon: 309 },
            markupPct: 0.6703,                               // aggPrice / posPrice - 1
            salesShare: 0.2265, popularity: 0.2517,          // share of net sales / of portions
            avgRealisation: 241.7248,                        // netSales / qty
            // only when hasCost. FOOD cost only - the definition of MK.finance.foodCost() and of the P&L:
            theoreticalCost: 476564, costPerPortion: 83.054, foodCostPct: 0.3436,
            contribution: 910453,                            // netSales - theoreticalCost, whole rupees
            contributionPerPortion: 158.6708,
            packagingCost: 19709,                            // per-dish packaging of the delivery and takeaway portions, carried apart
            contributionAfterPackaging: 890744,              // contribution - packagingCost (the per-order bag is not a dish cost)
            menuClass: 'plowhorse' },                        // 'star' | 'plowhorse' | 'puzzle' | 'dog' | null (no sales)
          ... ] }                                            // sorted by netSales descending; only dishes sold at an outlet in scope
```

Contract with the finance layer (feature-detected on every call):
`MK.finance.dishCost(dishId, { outletId, streamId, mediumId, monthKey })` -> the recipe cost card; `dishes()` reads `food`
(factory items + local items) and `packagingCost` from it. A provider that answers with a plain `number` or `{ cost }` is taken
to give the food cost with no packaging. It is called once per dish x outlet x stream x month that has sales in the range (at
most 1,440 calls). Returning `null` or throwing for any combination drops the cost fields for that dish.
A dish therefore shows the same `costPerPortion` and `foodCostPct` on the Dishes and the COGS screens, and the rows add up to
`MK.finance.foodCost().totals.theoretical` for the same month (whole-rupee rounding of twelve rows aside).
Menu-engineering rule: popular = share of portions >= 70% of an equal share (1 / number of dishes); profitable =
contribution per portion (before packaging) >= the portion-weighted average contribution.

### 2.6 `MK.data.channelEconomics(f)`

Aggregator money trail. **`actual`** = orders whose payout cycle has an uploaded statement; **`estimated`** = the
unsettled tail at contract terms (ads at the median share of the last unflagged settled cycles, refunds at the contract
assumption, the Zomato long-distance fee at its expected value per order). They are separate blocks everywhere and are never
added together by this selector. Cycle-level amounts (ads, refunds, unclassified deductions) are split over the cells of a cycle
(business day x part of day) **in whole rupees by largest remainder** in proportion to menu value, so a date range that cuts a
cycle gets its pro-rata share and **channels, outlets, days and months all add up to the total to the rupee**.
Petpooja / dine-in / takeaway filters leave `channels` empty.

```js
{ from, to, ratesAssumed: true,
  settledThrough: { swiggy: '2026-09-12', zomato: '2026-09-06' },       // master data, always keyed for both aggregators
  actualThrough:  { swiggy: '2026-09-12', zomato: '2026-09-06' },       // last calendar date of the RANGE a statement covers; null = none
  sources: { actual: ['swiggy_annexure', 'zomato_settlement'],          // only the statements that cover orders of the range ([] when none does)
             estimated: 'estimate' },
  channels: [ { channelId: 'swiggy', label: 'Swiggy', colourVar: '--ch-swiggy', settledThrough: '2026-09-12', actualThrough: '2026-09-12', actual: BLOCK, estimated: BLOCK }, ... ],
  byOutlet: [ { outletId, label, colourVar, actual: BLOCK, estimated: BLOCK, byChannel: { swiggy: { actual, estimated }, zomato: {...} } }, ... ],
  total: { actual: BLOCK, estimated: BLOCK },
  instore: { orders: 4560, grossSales: 2262650, restaurantDiscount: 30379, netSales: 2232271, gstCollected: 112380 },
  waterfall: [ { id: 'grossValue', label: 'Gross menu value', amount: 2390807, kind: 'total' },
               { id: 'restaurantDiscount', label: 'Restaurant-funded discounts', amount: -220596, kind: 'decrease' },
               { id: 'netSales', label: 'Net sales', amount: 2170211, kind: 'subtotal' },
               ... serviceFee, collectionFee, otherFees, gstOnFees, tds, ads, refunds, unclassified (all negative) ...,
               { id: 'netPayout', label: 'Net payout', amount: 1381834, kind: 'total' } ] }   // built from total.actual only; [] when it has no data

BLOCK (total.estimated for 1-16 Sep):
{ kind: 'estimated', hasData: true, orders: 3018, grossValue: 1892243, restaurantDiscount: 172303, netSales: 1719940, gstMemo: 86179,
  serviceFee: 391215, collectionFee: 34010, otherFees: 6848, gstOnFees: 77825, tds: 1721,
  ads: 86230, refunds: 21339, unclassified: 0,
  otherDeductions: 6848,          // otherFees + unclassified (the statement's "other deductions" line)
  totalDeductions: 617467,        // everything the aggregator keeps, TDS excluded (TDS is a recoverable tax credit)
  netPayout: 1100752,             // netSales - totalDeductions - tds
  serviceFeePct: 0.2246, contractedServiceFeePct: 0.2246,      // on the fee base of each aggregator
  contractedTakeRate: 0.2965,     // (contract service fee + collection + other fees + GST on them) / netSales
  effectiveTakeRate: 0.359,       // totalDeductions / netSales  (adds ads, refunds, unclassified, over-charges)
  allInCostPctOfMenu: 0.4174,     // (restaurant discount + totalDeductions) / grossValue
  realisationPctOfMenu: 0.5826 }  // (netSales - totalDeductions) / grossValue
```

**No statement in the range is not a take rate of 0%.** A block without orders has `hasData: false`, zero amounts and `null`
for all six rates; render it as "no statement for this period", never as `0.0%`:

```js
MK.data.channelEconomics({ from: '2026-09-14', to: '2026-09-16' })
  .total.actual   -> { kind: 'actual', hasData: false, orders: 0, ...amounts 0..., serviceFeePct: null, contractedServiceFeePct: null,
                       contractedTakeRate: null, effectiveTakeRate: null, allInCostPctOfMenu: null, realisationPctOfMenu: null }
  .sources.actual -> []            .actualThrough -> { swiggy: null, zomato: null }            .waterfall -> []
```

"Last 7 days" (10-16 Sep) has a Swiggy actual block (10-12 Sep) and no Zomato one: `sources.actual` is `['swiggy_annexure']`,
`actualThrough.zomato` is `null`. Use `actual.effectiveTakeRate` vs `actual.contractedTakeRate` for "effective vs contracted"
(1-16 Sep: 36.2% vs 30.1%) and say through which date the statements run (`actualThrough`); label anything from `estimated`
with source tag `estimate`. `ads` amounts include 18% GST (it is the amount deducted).

### 2.7 `MK.data.payouts(f)`

Payout cycles (one per outlet x aggregator x cycle) whose period overlaps `[from, to]`, newest first. Cycles use
**calendar** dates (an order after midnight belongs to the next calendar day), so reconciliation is by order, not by
business-day totals. Swiggy: Sunday-Saturday, **cut at month-end** (30-31 Aug and 1-5 Sep are two cycles), settled the
Tuesday after the week. Zomato: Monday-Sunday, paid the Thursday after; its first cycle starts before the data
(`partial: true`).

```js
MK.data.payouts({ from: '2026-08-23', to: '2026-08-29', outletIds: ['bandra'], channelIds: ['swiggy'] })
{ from, to,
  totals: { cycles: 1, expected: 68314, actual: 53514, variance: 14800,   // settled cycles only
            awaiting: 0 },                                                // expected net payout of unsettled cycles
  byStatus: { MATCHED: { count, amount }, SHORT_PAID: {...}, DISPUTED: { count: 1, amount: 53514 }, AWAITING_STATEMENT: {...}, IN_CYCLE: {...} },
  rows: [ { id: 'PO-SW-bandra-2026-08-23', outletId: 'bandra', channelId: 'swiggy', cycleIndex: 25,
      period: { from: '2026-08-23', to: '2026-08-29', label: '23 Aug - 29 Aug' }, partial: false, orderCount: 185,
      settlementDate: '2026-09-01', utr: 'ICICN26244703102',              // utr null until settled
      source: 'swiggy_annexure',   // where the FIGURES on the row come from: the statement once there is one, 'estimate' until then
      statementSource: 'swiggy_annexure',   // the report that settles (or will settle) the cycle - for "awaiting the <report>" texts
      estimated: false,
      status: 'DISPUTED',          // MATCHED | SHORT_PAID | DISPUTED | AWAITING_STATEMENT | IN_CYCLE
      reasons: [ { code: 'UNCLASSIFIED_DEDUCTION', amount: 14800, detail: 'Deduction on the statement with no classification - to be disputed' } ],
      statement: { grossValue: 111643, restaurantDiscount: 7781, netBillValue: 103862,
                   serviceFee: 24005, serviceFeePct: 0.22,                // of the aggregator's fee base, to 0.1%
                   collectionFee: 2193, gstOnFees: 4796,
                   gstRetained9_5: 5210,                                  // memo - not part of the payout arithmetic
                   tds: 104,                                              // round(0.1% x netBillValue) on every cycle
                   ads: 3503,                                             // ads include 18% GST
                   refundsAndCancellations: 621,
                   otherDeductions: 15126, otherDeductionsDetail: { platformFees: 326, unclassified: 14800 },
                   netPayout: 53514 },
      expected:  { ...same keys at contract terms..., otherDeductions: 326, netPayout: 68314 },
      variance: 14800,             // expected.netPayout - statement.netPayout; null while there is no statement
      dispute: { raisedOn: '2026-09-03', amount: 14800, status: 'OPEN', label: 'Unclassified deduction' } } ] }
```

- `netPayout = netBillValue - serviceFee - collectionFee - gstOnFees - tds - ads - refundsAndCancellations - otherDeductions` (both blocks).
- **TDS** is 0.1% of the net bill value of the statement: `tds = round(0.001 x netBillValue)` on every cycle (over all 275 cycles
  0.1000%); the order-level amounts are whole-rupee steps of the cycle's running total, so the orders of a cycle add up to the line.
- Settled cycle: `statement` and `expected` both present; ads and refunds are taken as billed in both, so variance comes only
  from a rate above contract or an unclassified deduction. Status: `|variance| <= MK.config.auditRules.payoutToleranceRs` (50)
  -> `MATCHED`; otherwise `DISPUTED` when a dispute has been raised, else `SHORT_PAID`.
- Unsettled cycle: `statement: null`, `utr: null`, `variance: null`, `estimated: true`, **`source: 'estimate'`** (tag the row
  with the `estimate` caption, and use `statementSource` only to say which report is awaited), `expected` = the estimate: contract
  fees; ads at the median ads share of the last four settled cycles **that did not trip the ads-spike rule** (the planned share when
  fewer than two remain - Koregaon Park Swiggy 13-19 Sep is estimated at 5.7% of menu value, not at the doubled 12.3-12.6% of the two
  cycles before); refunds at the contract
  assumption. `AWAITING_STATEMENT` = period over, report not uploaded (Zomato 7-13 Sep); `IN_CYCLE` = period still running
  (Swiggy 13-19 Sep, Zomato 14-20 Sep).
- Invariant (checked): `(row.source === 'estimate') === !row.statement`.
- Reason codes: `COMMISSION_RATE_ABOVE_CONTRACT` `{ amount, chargedPct, contractPct, detail }` (amount = fee difference + GST on it),
  `UNCLASSIFIED_DEDUCTION` `{ amount, detail }`.
- In the dataset: 275 cycles - 257 MATCHED, 2 SHORT_PAID (Zomato at Fort, 3-9 and 10-16 Aug, 24% charged vs 22%), 1 DISPUTED
  (Swiggy at Bandra 23-29 Aug), 5 AWAITING_STATEMENT, 10 IN_CYCLE.

### 2.8 `MK.data.auditFlags(f)`

```js
MK.data.auditFlags({ from: '2026-07-23', to: '2026-09-16' })           // the eight-week window the insights use for the opening filter
{ from, to, counts: { high: 4, medium: 6, low: 0 },                    // full year: 4 / 6 / 0; August: 4 / 5 / 0; 1-16 Sep: 1 / 4 / 1
  flags: [ { id: 'commission|PO-ZO-fort-2026-08-10', type: 'commission',       // 'commission' | 'payout' | 'ads' | 'markup'
             severity: 'high',                                                 // 'high' | 'medium' | 'low'
             outletId: 'fort', channelId: 'zomato', payoutId: 'PO-ZO-fort-2026-08-10', period: { from, to, label },
             title: 'Commission charged above contract',
             detail: 'Zomato at Fort, 10 Aug - 16 Aug: service fee charged at 24.0% against the contracted 22.0%',
             amount: 2849, data: { chargedPct: 0.24, contractPct: 0.22 }, route: '#/revenue/audit' }, ... ],
  gstSplit: { collectedByRestaurant: 397651, memoByAggregator: { swiggy: 312189, zomato: 381400 }, note: 'Restaurant service at 5% ...' },   // always keyed for both aggregators
  takeRates: [ { outletId: 'bandra', label: 'Bandra', effectiveTakeRate: 0.3375, contractedTakeRate: 0.2924, discountPct: 0.0599,
                 breakEvenMarkupPct: 0.6056,                          // 1 / ((1 - discountPct) x (1 - effectiveTakeRate)) - 1
                 windowFrom: '2026-07-23',                            // trailing 8 weeks to f.to ...
                 windowTo: '2026-09-12',                              // ... but the evidence ENDS with the latest statement in it
                 requestedTo: '2026-09-16',
                 settledThrough: { swiggy: '2026-09-12', zomato: '2026-09-06' } }, ... ],     // per aggregator; null = no statement in the window
  markupSummary: { listings: 56,                                      // dish x outlet listings on the aggregators
                   belowBreakEven: 52,                                // realise less than the POS price after discount and charges
                   belowTakeRate: 19,                                 // of which the markup does not even cover the take rate (= the flags)
                   lostRealisation: 1525868,                          // Rs, all 52, aggregator portions of the range
                   breakEvenMarkupPct: { min: 0.6056, max: 0.8754 } } }   // by outlet: Bandra 61%, Fort 61%, Kalyan 66%, Andheri 77%, Koregaon Park 88%
```

Rules (thresholds in `MK.config.auditRules`), applied to settled cycles overlapping the range and sorted high -> low, then by amount:

| type | rule | `data` |
|---|---|---|
| `commission` | statement service-fee rate above contract by more than 0.25 points | `{ chargedPct, contractPct }` |
| `payout` | unclassified deduction on the statement (short payment) | `{ status, variance, dispute }` |
| `ads` | ads share of menu value > 1.6 x the median of the previous (up to four, at least two) settled cycles of the same outlet and channel | `{ adsShare, trailingShare, ads }` |
| `markup` | one flag per dish: aggregator markup (menu prices on `f.to`) **below the outlet's effective take rate** - the exception rule of RESEARCH.md section 3; `high` when a POS price change was not mirrored on the aggregator list (`data.stalePriceChange`), else `medium` if the lost realisation in the range >= Rs 25,000 (`auditRules.markupImpactMediumRs`), else `low` | `{ outlets: [{ outletId, posPrice, aggPrice, markupPct, effectiveTakeRate, discountPct, breakEvenMarkupPct, realisationPerPortion, lostPerPortion, qty, amount }], stalePriceChange: { date, from, to, note } \| null }` |

What the markup flag does and does not say. A portion sold on an aggregator realises `aggPrice x (1 - discountPct) x (1 - effectiveTakeRate)`;
it nets less than the counter price whenever the markup is below `breakEvenMarkupPct` (61-88% by outlet), which is true of 52 of the 56
listings - that is reported **once**, in `markupSummary`, and is not an exception. The flag is the narrower rule "the markup does not even
cover the take rate, before any discount" (19 listings, five dishes). Titles, details and the `markup|others` insight are worded accordingly;
do not caption the flag list as "the items that net less than the POS price".
Markup flags have `outletId: null`, `channelId: null`, `dishId`, and `amount` = the realisation lost against the POS price on the
aggregator portions of the range, **accumulated day by day at the menu prices in force on each day** (mutton seekh before 1 Aug is measured
against Rs 450, from 1 Aug against Rs 480); `data.outlets[].amount` adds up to it. `takeRates` are computed from settled orders only;
quote them as "settled statements from `windowFrom` (Swiggy through 12 Sep, Zomato through 6 Sep)", never as running to `requestedTo`.
`gstSplit` covers the whole filter range (actual and estimated orders alike - GST comes from the POS).

### 2.9 `MK.data.recentOrders(f, { limit, offset, search, status })`

Last 14 business days only (`2026-09-03 .. 2026-09-16`), newest `placedAt` first. `limit` default 50; `search` matches order id,
POS reference and dish names (case-insensitive); `status`: `'completed'` | `'cancelled'` | omitted = both.

```js
{ from: '2026-09-03', to: '2026-09-16',                 // filter range intersected with the window
  windowFrom: '2026-09-03', windowTo: '2026-09-16',
  total: 10309,                                         // orders matching the filter INCLUDING cancelled ones (10,161 completed + 148 cancelled); pass status to count one kind
  limit: 50, offset: 0, rows: [ ORDER, ... ] }
```

Orders carry **only what the channel can supply** (check `MK.data.can(channelId, fieldKey)` before rendering a field):

```js
// in-store (petpooja)
{ id: 'BAN-20260916-0123', invoiceNo: 123, posRef: 'BAN-20260916-0123', aggregatorOrderId: null,
  outletId: 'bandra', channelId: 'petpooja', mediumId: 'dinein', streamId: 'pp_dinein',
  businessDate: '2026-09-16', placedAt: '2026-09-17T00:48', hour: 24, slotId: 'latenight', status: 'completed',
  items: [ { dishId: 'zaatar_hummus', name: "Za'atar Naan with Hummus", category: 'appetisers', veg: true, qty: 1, unitPrice: 420, lineTotal: 420 }, ... ],
  itemCount: 4, subtotal: 985, packagingCharge: 0, discountTotal: 0, discountRestaurantFunded: 0,
  netSales: 985, cancelledValue: 0, gst: { amount: 49, treatment: 'collected_by_restaurant' }, total: 1034,
  source: 'petpooja', seq: 768031,                      // seq = internal ordering key inside the business day
  paymentMode: 'UPI' }                                  // 'UPI' | 'Card' | 'Cash'; null when cancelled
// cancelled in-store adds: cancel: { reason: 'Duplicate bill punched', approver: 'Shift supervisor' }

// aggregator (swiggy, settled cycle)
{ id: '214547442164521', aggregatorOrderId: '214547442164521', invoiceNo: 143, posRef: 'KPK-20260912-0143',
  outletId: 'koregaon', channelId: 'swiggy', mediumId: 'delivery', streamId: 'sw_delivery',
  businessDate: '2026-09-12', placedAt: '2026-09-12T23:40', hour: 23, slotId: 'latenight', status: 'completed',
  items: [...], itemCount: 2, subtotal: 680, packagingCharge: 10, discountTotal: 136,
  discountRestaurantFunded: 136,                        // null on Swiggy orders of an unsettled cycle (relay discount is unsplit)
  netSales: 554, cancelledValue: 0, gst: { amount: 28, treatment: 'memo_collected_by_aggregator' }, total: 582, source: 'petpooja',
  payoutId: 'PO-SW-koregaon-2026-09-06',
  fees: { kind: 'actual',                               // 'actual' (cycle settled) | 'estimated'; null on cancelled orders
          feeBase: 582, serviceFeePct: 0.24, serviceFee: 140, collectionFee: 12, otherFees: 2, gstOnFees: 28,
          tds: 1,                                       // a recoverable tax credit, on its own line - NOT part of totalDeductions
          totalDeductions: 182,                         // serviceFee + collectionFee + otherFees + gstOnFees: the same definition as channelEconomics
          netReceivable: 371 },                         // netSales - totalDeductions - tds
  feesSource: 'swiggy_annexure',                        // | 'zomato_settlement' | 'estimate'
  prepMinutes: null,                                    // derived accepted -> food ready; null when staff did not mark ready
  timeline: { placedAt, acceptedAt, foodReadyAt, pickedUpAt, deliveredAt /* null where not relayed */, cancelledAt } }
// zomato adds paymentFlag: 'prepaid' | 'cod'. Cancelled: zomato -> cancel: { reason }; swiggy -> cancel: { cancelledBy } once the
// cycle is settled, else cancel: null. There are no customer fields, no ratings, no distance on any order.

// estimated fees (zomato, 16 Sep - no statement yet)
fees: { kind: 'estimated', feeBase: 319, serviceFeePct: 0.22, serviceFee: 70, collectionFee: 6, otherFees: 3, gstOnFees: 14, tds: 0, totalDeductions: 93, netReceivable: 226 },
feesSource: 'estimate'
```

Order ids: in-store `id = posRef` = outlet code + business date + daily invoice number (invoice numbers run per outlet per
business day across all channels, in time order); aggregator `id` = the aggregator's numeric order id (Swiggy 15 digits,
Zomato 10), with `invoiceNo` / `posRef` alongside. Cancelled orders keep `subtotal`, `packagingCharge`, `discountTotal` as
placed but have `netSales: 0`, `gst.amount: 0`, `total: 0`, so summing `netSales` over any order list reconciles with the cubes.
Order-level fees exclude cycle-level ads, refunds and other deductions.

Two rules for estimated fees (DATA-FEASIBILITY: an order-level estimate is "contract rate x base"):

- **Long-distance fee (Zomato).** Which orders were long-distance is known only from the settlement report
  (`order.deliveryDistance` is `no`). A settled order shows the fee it was charged (Rs 20-40 on about 8% of orders); an unsettled
  order carries the **expected value per order** (8% x Rs 30 = Rs 2.4, kept in whole rupees by a running carry over the cycle),
  so `otherFees` of an estimated Zomato order is Rs 2-3 and never points at an individual order.
- **TDS** on an order is the whole-rupee step of its cycle's running total (Rs 0 or 1 on most orders); show it on its own line as
  a recoverable credit. A per-order take rate is `fees.totalDeductions / netSales` - TDS is not a cost.

### 2.10 Config helpers on `MK.data`

| call | returns |
|---|---|
| `can(channelId, fieldKey)` | `'yes'` \| `'partial'` \| `'no'` (`n/a`, unknown channel or field -> `'no'`) |
| `capability(fieldKey)` | `{ label, petpooja, swiggy, zomato, note }` (raw, values may be `'n/a'`) or `null` |
| `posPriceOn(dishId, iso)` / `aggPriceOn(dishId, outletId, iso)` | menu price in force; `aggPriceOn` is `null` where the dish is not listed; both `null` for an unknown dish |
| `dishSoldAt(dishId, outletId)` | boolean (the roll is Koregaon Park only; `false` for an unknown dish) |
| `recipeCost(dishId, { monthKey, mediumId })` | `{ factory: 50.76, local: 32.63, packaging: 4.2, food: 83.39, total: 87.59 }` unrounded Rs per portion (Angara shawarma, August, delivery): factory SKUs at transfer price, local items at the month's price, per-dish packaging for `delivery` / `takeaway` (none for `dinein`); `null` for an unknown dish |
| `orderPackagingCost(mediumId, monthKey)` | once-per-order packaging cost (bag, seal, tissue); 0 for an unknown medium |
| `gstinCheckChar(first14)` | GSTIN check character (mod-36); every vendor GSTIN in `MK.config.vendors` validates |

Ids are looked up in prototype-free maps: `'constructor'`, `'__proto__'`, `'toString'` and the like are unknown ids
(`null` / `false` / `0`), never a throw.

## 3. `MK.config` (declarative; the single place to tune the model)

| key | content |
|---|---|
| `today, dataStart, dataEnd, fyLabel, months` | `months` = `['2026-04' .. '2026-09']`; every monthly price array is aligned to it |
| `outlets` | 7 units in fixed order: `bandra, andheri, fort, kalyan, koregaon, factory, ho`. `{ id, name, short, code, type: 'outlet'\|'factory'\|'ho', city, area, region: 'Mumbai region'\|'Pune', sqft, seats, openedOn, hours: { open, close } \| null (business-day decimals, 27.75 = 3:45 am), electricityZone: 'mumbai_licensee'\|'msedcl'\|null, colourVar, managerUserId }` |
| `regions` | `[{ id: 'mumbai'\|'pune', label, outletIds }]` (the `city` dimension) |
| `channels` / `mediums` / `streams` | `{ id, label, colourVar, ... }`; channels add `kind: 'pos'\|'aggregator'`, `short`, **`salesSource: 'petpooja'`** (where the channel's ORDER data comes from - always the POS), **`statementSource`** (`'swiggy_annexure'` \| `'zomato_settlement'` \| `null` for the POS: the weekly upload that carries fees and payouts) and `source` (kept equal to `statementSource` for the aggregators because existing callers read it that way - **never tag a sales figure with `channel.source`**; sales selectors give their own `result.source`); streams `{ id, label, channelId, mediumId, colourVar }` |
| `slots` / `hours` | slots `{ id, label, fromHour, toHour, range }`; hours 12..27 `{ hour, label: '12 pm'..'3 am', slotId, nextCalendarDay }` |
| `categories`, `dishes` | dish `{ id, name, short, category, veg, isAttach?, posPrice, aggPrices: { outletId: price } (missing key = not sold), availableAt?, priceChanges: [{ date, list: 'pos'\|'agg', price, outletId?, note }], recipe: { factory: [{ sku, g }], local: [{ itemId, qty }], packaging: { delivery: [...], takeaway: [...] } } }` |
| `orderPackaging`, `packagingCharge` | cost-side once-per-order packaging; customer-side packaging charge rule per medium |
| `items` | `rawMaterials [{ id, name, unit, stdPrice, prices[6], vendorCategory, storage }]`, `factoryProducts [{ id: 'FP01'..'FP09', name, unit, stdRmCost, stdYield, yieldBasis?, shelfLifeHours, usedIn, bom: [[rmId, qtyPerKgOutput]], conversionPerKg: 70, transferPrice }]`, `local [{ id, name, unit: 'kg'\|'l'\|'pc', prices[6] }]`, `packaging [...]` |
| `demand`, `orderModel`, `discounts`, `cancellation`, `paymentMix`, `cardMdrPct`, `zomatoPrepaidShare`, `gst` | the demand and basket model (calibration knobs). `demand.seed` is a parameter too: `MK_DEMAND_SEED=<seed> node tools/check-data.js` tries a candidate; the event section and every band must pass before it is adopted. `demand.ramp.monthlyGrowth.koregaon` is 0.11 (the RESEARCH endpoints of about Rs 13 L in April and Rs 20 L by September need 11% a month, not the 7% quoted there) |
| `events` | `[{ id, label, kind, from, to, marker, effects: [{ mult, mediums?, outlets?, hours?: [from, to), dows? }], cancelMult?, dishMult?, categoryMult? }]` - use `marker: true` events for chart markers; every marked event is asserted to show in the data |
| `channelTerms.swiggy / .zomato` | `serviceFeePct, serviceFeePctByOutlet, serviceFeeBase: 'net_plus_gst'\|'net', collectionFeePct, collectionFeeBase, otherFeePct, longDistanceFee, gstOnFeesPct, tdsPct, tdsLabel, tcsPct, refundsPctOfNet, cycle: { weekStartDow, cutAtMonthEnd, settlementDow, label }, settledThrough, lastSettlementDate, statementSource, statementName, labels, ratesAssumed: true` |
| `aggregatorAds`, `channelExceptions`, `auditRules` | ads share by outlet; the three seeded statement exceptions (rule inputs); audit thresholds (`commissionTolerancePct, payoutToleranceRs, adsSpikeRatio, adsTrailingCycles, markupImpactMediumRs`) |
| `sources`, `notImported`, `capabilities` | source tags `{ id, label, caption, through, route, frequency }`; portal-only list; capability matrix keyed by the fieldKeys of DATA-FEASIBILITY.md (combined rows are split: `payout.period`, `payout.settlementDate`, `payout.utr`, ...; `inv.*` rows use the `petpooja` column) |
| `expenseGroups`, `expenseCategories` | category `{ id, label, group, units: ['outlet'\|'factory'\|'ho'], note }` in P&L order |
| `costCentres` | tree `{ id, label, unitId, children }` |
| `bankAccounts` | `current[18] { id, bank, masked, type, purpose, unitId, txnsPerMonth, activity, recommendation: 'keep'\|'merge'\|'close', note }`, `target[4] { id, bank, name, purpose, replaces }`, `closeOutright` |
| `vendors` | 33 records `{ id, name, type: 'vendor'\|'utility', category, unitIds, creditDays, pan, gstin, bankName, ifsc, bankAccountMasked, accountHolderName, nameMatch, state, expenseCategoryIds, tdsLabel }`. Credit terms the twice-weekly payment runs can meet: meat, vegetables and dairy 7 days, landlords and staff housing 10 (invoiced on the 1st, due on the 11th), LPG, charcoal, internet, POS, insurance and billers 15, oil and housekeeping 21, dry goods, packaging and services 30. Low name match: `v_print` (38, `NEEDS_REVIEW`); not yet approved: `v_lab` (`VERIFYING`), `v_pack2` (`DRAFT`); turned down at onboarding: `v_frozen` (`REJECTED`, with `rejectionReason`); utilities have no tax or bank fields. How the seed reaches these states: docs/API.md section 5 |
| `tariffs`, `wages`, `outletCosts`, `outletCostsCommon`, `factoryParams`, `headOffice`, `budgetPolicy` | cost parameters of RESEARCH.md sections 5 and 7 (`outletCosts[id].foodCostVariancePts`, `oneOffs`, `factoryParams.yieldExceptions`, ...). `wages.staffing` holds the **calibrated rosters the cost model uses** (11 / 13 / 12 / 11 / 8, equal to `outletCosts[id].headcount`); the pre-tuning headcounts of RESEARCH.md are kept as `outletCosts[id].researchHeadcount` (18 / 18 / 16 / 14 / 11) |

## 4. `MK.db` (internal, unscoped - finance, factory, seed and `tools/check-data.js` only)

`MK.engine.run(opts?)` builds it once (`{ force: true }` rebuilds); `MK.engine.ready` / `MK.db.ready` are `true` afterwards.
`MK.db.checksum` is identical on every run and machine (Node and browser).

- Index lists: `days[169]`, `calDates[170]`, `dayDow` (0 = Mon), `dayMonth`, `monthKeys`, `outletIds[5]`, `streamIds[4]`, `dishIds[12]`,
  `aggregatorIds ['swiggy','zomato']`, `index.{day,outlet,stream,dish,aggregator}` (id -> index, prototype-free maps), `dims { ND:169, NO:5, NS:4, H:16, SL:4, NDI:12, NA:2, NMO:6, NM:9, NDM:4, NF:13, HOUR0:12 }`.
- Cubes (Int32Array, whole rupees / counts), measure offsets in `M`, `DM`, `F`:
  - `hourCube[(((d*NO+o)*NS+s)*H+h)*NM + M.x]`, `dayCube[((d*NO+o)*NS+s)*NM + M.x]`; `M = { orders, cancelled, cancelledValue, grossItemValue, packaging, discount, netSales, gst, items }`
  - `dishCube[((((d*NO+o)*NS+s)*SL+slot)*NDI+dish)*NDM + DM.x]`, `dishDayCube[(((d*NO+o)*NS+s)*NDI+dish)*NDM + DM.x]`; `DM = { qty, gross, net, lines }`
  - `feeCube[(((d*NO+o)*NA+a)*2+part)*NF + F.x]`, part 0 = before midnight, 1 = after (next calendar day);
    `F = { orders, grossValue, discount, netSales, gst, feeBase, serviceFee, serviceFeeContract, collectionFee, otherFees, gstOnFees, gstOnFeesContract, tds }`;
    `cellSettled[(d*NA+a)*2+part]` = 1 when a statement covers the cell; `alloc.{ads,refunds,unclassified}[((d*NO+o)*NA+a)*2+part]` = the cell's share of
    the cycle-level amounts, **Int32 whole rupees split by largest remainder** so the cells of a cycle add up to its statement line exactly
  - `monthCube[((m*NO+o)*NS+s)*NM + M.x]`, `monthDishQty[((m*NO+o)*NS+s)*NDI+dish]`, `paymentMix[(m*NO+o)*3 + (0 upi | 1 card | 2 cash)]`, `priceTable`
- Accessors: `dayIdx(iso)`, `monthIdx(monthKey)` (-1 if unknown); `dayMeasure(dayIdx, outletIdx, streamIdx, 'netSales')`;
  `dishQty(dayIdx, outletIdx, streamIdx, dishIdx)`; `monthlyDishQty(monthKey, outletId, streamId|null, dishId)`;
  `monthlyMeasure(monthKey, outletId|null, streamId|null, measure)`; `priceOn(dayIdx, outletIdx, 'pos'|'agg', dishIdx)`;
  `paymentMixByMonth(monthKey, outletId|null)` -> `{ upi: 858067, card: 242233, cash: 258504 }` (Bandra, Aug; receipts incl. GST);
  `feesByMonth(monthKey, outletId|null, channelId|null)` ->

```js
MK.db.feesByMonth('2026-08', 'andheri', 'swiggy')
{ actual:    { orders: 2111, grossValue: 1325019, discount: 144354, netSales: 1180665, gst: 59100, serviceFee: 272571, serviceFeeContract: 272571,
               collectionFee: 24765, otherFees: 3806, gstOnFees: 54259, tds: 1180, ads: 72763, refunds: 7941, unclassified: 0 },
  estimated: { ...same keys, zero for a fully settled month... },
  total:     { ...actual + estimated... } }          // months are business-day months; September has both parts; every figure is a whole rupee
```

- `cycles.swiggy / .zomato`: `[{ index, from, to, weekFrom, weekTo, settlementDate, settled, partial, unsettledStatus }]`;
  `payouts` (array, shape of 2.7) and `payoutById`; `recentOrders` (array of 2.9 orders, all outlets), `recentFrom`, `recentTo`.

Reconciliation facts that hold (verified by `tools/check-data.js`): net sales by outlet = channel = medium = stream = slot = hour = dow =
dish = category = week = month = grand total to the rupee; the GST split adds up on every row; `recentOrders` aggregate exactly to the
cubes for their 14 days (orders, cancelled, net sales); for a settled cycle the order-level actual fees (TDS included) sum to the
statement lines; TDS of every cycle = round(0.1% x net bill value); channel economics by channel = by outlet = total for every money
key and a month = the sum of its days; the sum of `netBillValue` over all payouts = aggregator net sales; every marked demand event
shows in the data; two runs give the same `checksum`; with the Bandra manager persona every selector returns Bandra only, with the
factory manager every selector returns an empty / zeroed result of the same shape.
