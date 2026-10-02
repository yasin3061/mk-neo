# API-forecast - `MK.forecast`

Statistical forecasting of the kind every mid-market ERP ships: no learning, no black box, every figure explainable in
one sentence to the person who has to act on it. Source file `js/data/forecast.js`; loads after `factory.js` and
before `seed.js`; Node-loadable; deterministic (no randomness - a pure function of `MK.db`, `MK.config` and the two
settings). The checks are in `tools/check-data.js`, section "Forecasting".

Two of the three layers of ERP forecasting are built. **Layer 1**, the ambient outlook on the Overview: the projected
month-end, a dashed forecast with a band on the trend chart, and the measured accuracy. **Layer 3**, suggestions
embedded where the decision is taken: what the factory should order this week, and where a budget line is heading
while a bill is under review. The planner workspace (Layer 2, a grid of overrides) is deliberately not built.

## 1. The engine

```
forecast(outlet, day) = level(outlet) x dayOfWeekIndex(outlet, weekday) x eventFactor(outlet, day)
```

| Term | How it is found | Window |
|---|---|---|
| `level` | exponentially smoothed daily net sales after the weekday pattern and the known events are taken out (alpha = 2 / (7N + 1)) | the last N weeks - the **reactiveness** setting: 4, 8 or 12 |
| `dayOfWeekIndex` | ratio of each weekday to its centred seven-day moving average, normalised to a mean of 1 | the last 12 weeks |
| `eventFactor` | the multipliers of `MK.config.events`: `effects[].mult` filtered by outlet and weekday; an effect limited to a medium is weighted by that medium's share of the outlet's sales, one limited to hours by their share of the trading day | festivals, holidays and sport only - **weather is never applied to a future day** (it is taken out of history, because after the day the rain is a fact) |

Horizon 45 days from today (17 Sep to 31 Oct 2026), which is why the event calendar now carries **Navratri (11-19 Oct,
-10% at the Mumbai outlets, -16% at Kalyan and Koregaon Park, paneer and hummus up, kebabs down)** and **Dussehra
(20 Oct, +18%)**. The engine never generates orders past `dataEnd`, so these entries change nothing in the data.

**Accuracy is measured, not assumed.** Each of the last eight Monday-to-Sunday weeks is forecast from the data
available on the Sunday before it (an ex-ante backtest) and compared with what happened. From those misses come:

- WAPE (absolute misses as a share of actual sales) by outlet-day and by week, and its complement, accuracy;
- bias (signed misses as a share of actual);
- the same-day-last-week baseline, the guess every forecast has to beat;
- the width of the 80% band: 1.28 relative standard errors, the daily misses for one day, the weekly misses scaled
  by the square root of the length for a sum of days; outlets are added as if their misses move together (rain and
  festivals hit every outlet at once).

On today's dataset, all outlets, balanced: **daily WAPE 11.1%, weekly 3.6%** (same-day-last-week 14.1% / 4.8%),
bias -3.1%; by week Reactive scores 2.8%, Balanced 3.6%, Steady 4.3%.

## 2. Settings - the two dials

```js
MK.forecast.settings()      // -> { weeks: 8, safetyDays: { fresh: 0.5, dry: 10 } }
MK.forecast.setSettings({ weeks: 4 })                       // Reactive | Balanced (8) | Steady (12)
MK.forecast.setSettings({ safetyDays: { fresh: 1 } })       // fresh 0-3 in halves; dry (and frozen) 0-14 whole days
MK.forecast.OPTIONS         // { reactiveness: [{value, label, caption}], safety: {fresh: {min, max, step, ...}, dry: {...}}, model }
MK.forecast.reactivenessLabel(8)                            // 'Balanced'
```

Values are snapped to the dial's range; an unknown reactiveness is ignored. Settings live in `prefs.forecast`, so a
change does **not** make the router repaint the page: the page that owns a dial repaints the figures it moves
(`forecast:changed` is emitted on `MK.bus` for anything else). The defaults match the kitchen's own practice: fresh is
topped up to 2.5 days (1 lead + 1 review + 0.5 safety); dry and frozen are reordered at 13 days of cover (3 lead + 10
safety) up to 20.

## 3. Layer 1 - the outlook (scoped like `MK.data`: the filter's outlets within the persona's)

### `daily(f, {to})`

The forecast by business day from today to `to` (default: the end of today's month).

```js
{ from: '2026-09-17', to: '2026-09-30', outletIds: [...], settings, method, source: 'forecast',
  days: [{ date: '2026-09-17', label: '17 Sep', dow: 3, value: 369684, lo: 302190, hi: 437179, events: [] }, ...],
  total: 5733866, lo: 5453297, hi: 6014435 }
```

The band of the sum is narrower than the sum of the daily bands. `events` lists the calendar entries in force on the
day for the outlets in scope.

### `monthEnd(f)`

Where the current month lands: `toDate` (actual, = `MK.data.summary` of the month so far) + `remaining` (= `daily().total`)
= `projected`, with `lo` / `hi`, the plain `runRate` for comparison, `lastMonth` and the events still to come.

```js
{ available: true, monthKey: '2026-09', label: 'Sep 2026', from, to, daysInMonth: 30, daysDone: 16, daysLeft: 14,
  toDate: 6122422, remaining: 5733866, remainingLo, remainingHi, projected: 11856288, lo: 11575719, hi: 12136857,
  runRate: 11479541, lastMonth: { monthKey: '2026-08', label: 'Aug 2026', netSales: 12145952 }, events: [], settings, method }
```

The projection sits above the run-rate because the first half of September carried Shravan and Ganesh Chaturthi,
which the forecast does not expect to repeat - the whole point of a weekday- and event-aware method over a run-rate.

### `accuracy(f)`

```js
{ available: true, weeks: 8, from: '2026-07-20', to: '2026-09-13', settingUsed: 8, settingLabel: 'Balanced',
  wape: 0.111, accuracy: 0.889, weeklyWape: 0.036, weeklyAccuracy: 0.964, bias: -0.031,
  naiveWape: 0.141, naiveAccuracy, weeklyNaiveWape: 0.048, weeklyNaiveAccuracy,
  points: [{ weekStart, weekEnd, actual, forecast, naive }, ... 8],
  bySetting: [{ weeks: 4, label: 'Reactive', wape, accuracy, weeklyWape, weeklyAccuracy }, { weeks: 8, ... }, { weeks: 12, ... }] }
```

`bySetting` scores every reactiveness setting on the same backtest, which is how the dial's note can say what each
would have done.

### `upcoming(f, days)`

Festivals, holidays and sport inside the next `days` days (default: the horizon) for the outlets in scope: `{ id, label,
kind, from, to, days, effect, byOutlet: [{ outletId, effect }], dishes: [{ id, name, mult }] }`, sorted by date. `effect` is
the sales-weighted uplift of the entry alone (Navratri -12% over the five outlets).

## 4. Layer 3 - embedded suggestions

### `purchaseSuggestions()` - needs the factory in the persona's scope

The MRP chain the factory already uses for its indents, run on the forecast: forecast net sales -> the recent dish mix
of each outlet (portions per rupee over the last 28 days, reshaped by an event's `dishMult` / `categoryMult` with the
portions held) -> recipe grams -> factory products, plus the outlet's recent over-use against recipe -> raw materials
by the bill of materials, with the process-wastage allowance -> net of stock on hand -> an order-up-to quantity.

| Storage | Delivery takes | Ordered | Rule |
|---|---|---|---|
| fresh | 1 day | every day | order every day up to delivery + 1 day until the next order + safety days of forecast use |
| frozen | 2 days | once a week | reorder when cover <= delivery + safety; order up to delivery + 7 days until the next order + safety; lots of 1 |
| dry | 3 days | once a week | as frozen; lots of 5 |

The "days until the next order" (the review period of a periodic-review policy) is the ordering rhythm of the supply line,
not a tuning constant: in the product it comes from the vendor's delivery calendar on the item master, so a butter supplier
who delivered daily would make butter a daily item. The working says it in those words ("ordered once a week and delivered
in 2 days, so an order must last ..."); each row also carries `rhythm` and `delivery` for the screen.

```js
{ asOf: '2026-09-17', horizonDays: 7, settings, wastagePct: 0.0225, overUse: [{ outletId, rate }], portionsPerDay: 1524, method, source: 'erp',
  rows: [{ rmId: 'RM_CHICKEN', name, unit: 'kg', storage: 'fresh', dial: 'fresh', vendorId, vendorName,
           onHand: 239.6, usePerDay: 165.55, recentUsePerDay: 159.28, coverDays: 1.4, leadDays: 1, reviewDays: 1, safetyDays: 0.5, targetDays: 2.5, reorderDays: 1.5,
           wantedQty: 420, orderQty: 181, price: 255, value: 46155, status: 'ORDER_TODAY', orderBy: '2026-09-17', deliverBy: '2026-09-18', reason, working: [4 lines] }, ...17],
  totals: { today: { items: 10, value: 82893 }, week: { items: 4, value: 42455 }, later: 3 } }
```

`status` is `ORDER_TODAY`, `ORDER_THIS_WEEK` (with the day the reorder point is reached) or `NO_ORDER`. `working`
is the four-line explanation shown behind the "Why" button: forecast use and how it was built, the cover wanted,
the stock position and the order, the rule that fired. Forecast use lands within 15% of the kitchen's own trailing
average on every item (checked), so the figure is one the factory manager can recognise. The whole company's demand
is used whatever the persona's outlet scope - only kilograms leave the function, exactly as `MK.factory.inventory`
shows a kitchen its daily use.

### `lineProjection(unitId, categoryId, monthKey, billAmount)`

Where a budget line is heading by month-end, built on the ledger accrual to date (what has been consumed, whether or
not its bill has arrived):

| `method` | When | Projection |
|---|---|---|
| `sales` | lines that move with sales: groups `cogs` and `channel`, the factory's raw materials, consumables and fuel | accrual x (sales to date + forecast of the rest) / sales to date |
| `plan-rest` | everything else | accrual to date + plan x days left / days in month (a one-off already accrued is counted once, never run-rated) |
| `plan` | a line with nothing accrued yet | the larger of the bills so far and the plan |

```js
{ available: true, unitId: 'andheri', categoryId: 'cogs_local', monthKey: '2026-09', bill: 32361, salesRatio: 1.888,
  plan: 310000, accrued: 169168, used: 141344, usedPct: 0.456, billShare: 0.104, projected: 319427, utilisation: 1.030,
  method: 'sales', basis: 'bills', group: 'cogs', daysDone: 16, daysLeft: 14, daysInMonth: 30, monthEnd: '2026-09-30',
  status: 'OVER', overBy: 9427, settings, source: 'forecast' }
```

The bill under review is **not** added on top - its cost is already inside the accrual it documents - but `billShare`
is returned for the sentence. Only the month in progress gets a projection: a complete month returns `{ available:
false, reason: 'complete' }`, an unknown line `'no-line'`. Status uses `MK.config.budgetPolicy` (`warnAtPct`,
`overAtPct`). The story this tells on the seeded data: local food cost at Andheri has bills for 46% of its September
plan and is heading for 103% of it.

## 5. Where it shows

| Screen | What | Dial |
|---|---|---|
| Overview, "Looking ahead" | projected month-end tile (with the band and the run-rate for contrast), accuracy tile (weekly and daily, bias, the baseline), "Coming up" tile; the trend chart carries the dashed forecast to month-end with its 80% band when the period runs to the latest data and the view is the total | forecast reactiveness (segmented), repaints the block and the chart tail |
| Factory / Inventory, "Suggested purchases, next 7 days" | the suggestion table with the working behind every quantity | safety days for fresh, safety days for dry and frozen (steppers), repaint the table |
| Approvals / Bills, review drawer, "Budget impact" | one sentence on where the line lands by month-end, a callout when it heads near or over plan | none - follows the reactiveness set on the Overview |

The source tag `forecast` (`MK.config.sources.forecast`) marks every figure that comes from here.

## 6. `raw` - unscoped, for checks

`raw.model` (the parameters), `raw.defaults`, `raw.base()`, `raw.modelFor(weeks)`, `raw.eventFactor(outletId, iso,
exAnte)`, `raw.rawMaterialNeed()`, `raw.checksum()` (settings, levels, horizon totals and backtest misses - part of the
determinism check), `raw.reset()`.
