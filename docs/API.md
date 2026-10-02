# Data layer: the entry point for page authors

One model produces every number in the mockup. Pages read it through the namespaces below and never
compute, cache or hard-code a figure. Details live in three companion documents:

- [API-sales.md](API-sales.md) - `MK.config`, the sales engine (`MK.db`) and the `MK.data.*` selectors
- [API-finance.md](API-finance.md) - `MK.finance.*` (ledger, P&L, unit economics, food cost, budget, payables) and `MK.factory.*`
- [API-workflow.md](API-workflow.md) - `MK.workflow.bill / batch / vendor` and `MK.audit`

This page adds the map, the rules every page must follow, `MK.seed`, `MK.insights` and ten recipes.
`node tools/check-data.js` asserts everything stated here (683 assertions; run it after touching any data file - the last section fails when the samples quoted in these documents drift from the code).

## 1. Map

Load order (fixed in `index.html`): `kernel.js`, `config.js`, `engine.js`, `sales.js`, `finance.js`, `factory.js`, `forecast.js`, `seed.js`,
`workflow.js`, `insights.js`. `app.js` runs `MK.engine.run()` and then `MK.seed.apply()`; finance and factory build lazily on
the first call. Everything also loads under Node (`require` the files in that order, read `globalThis.MK`).

| Namespace | What it is for | Scoped to the persona | Details |
|---|---|---|---|
| `MK.calendar`, `MK.fmt`, `MK.dates`, `MK.rng`, `MK.hash`, `MK.store`, `MK.session`, `MK.bus` | frozen demo clock (today = 17 Sep 2026, data 1 Apr - 16 Sep), formatting, ISO dates, seeded randomness, storage, personas and rights, events | - | `js/core/kernel.js` |
| `MK.config` | master data and every model parameter: units, channels, streams, slots, dishes and recipes, items and price series, the demand seed, events, channel terms, sources, capabilities, expense categories, cost centres, bank accounts, vendors, rosters and cost parameters | no (master data) | API-sales 3 |
| `MK.engine`, `MK.db` | the order-by-order simulation and its typed-array cubes, payout cycles, last 14 days of orders. **Internal and unscoped - never read it in a page** | no | API-sales 4 |
| `MK.data` | sales selectors: `summary`, `series`, `breakdown`, `matrix`, `dishes`, `channelEconomics`, `payouts`, `auditFlags`, `recentOrders`; helpers `can`, `capability`, `posPriceOn`, `aggPriceOn`, `dishSoldAt`, `recipeCost` | yes | API-sales 2 |
| `MK.finance` | the cost ledger and what is read from it: `pnl`, `pnlTrend`, `unitEconomics`, `foodCost`, `dishCost`, `ledger`, `budgetPlan`, `budget`, `payables`, `vendorSpend`, `costCentreSpend` (`raw.*` is unscoped, for seed and checks only) | yes (`dishCost` is master data) | API-finance 2 |
| `MK.factory` | central kitchen: `summary`, `production`, `dispatch`, `costing`, `pnl`, `purchases`, `inventory` (`raw.*` unscoped) | yes - empty without the factory in scope | API-finance 3 |
| `MK.forecast` | statistical forecasting, no learning: `daily`, `monthEnd`, `accuracy`, `upcoming` (Layer 1, the outlook), `purchaseSuggestions`, `lineProjection` (Layer 3, embedded in the factory and in bill review), `settings` / `setSettings` (the two dials), `OPTIONS` (`raw.*` unscoped, for checks) | yes - the outlook by outlet; the suggestions and the projection need the factory or the unit in scope | API-forecast |
| `MK.workflow` | state machines with role, scope and segregation checks: `bill.*`, `batch.*`, `vendor.*`, `bulk`, `labels`, `errors` | reads yes; transitions check the actor | API-workflow |
| `MK.audit` | `log`, `list`, `count`, `trail`, `toTimeline` | yes | API-workflow 4 |
| `MK.seed` | the workflow state the demo opens with | - | section 5 below |
| `MK.insights` | rule-based "needs attention" list | yes | section 6 below |

## 2. The filter object and the period rules

```js
f = { from: '2026-09-01', to: '2026-09-16', outletIds: null, channelIds: null, mediumIds: null }   // MK.filters.get() can be passed as is
```

- Dates are inclusive **business dates** (a business day runs 12:00 to 04:00 next morning); missing = whole data range; both ends are
  clamped into the data, so the echoed range never crosses. `null`, missing or `[]` = all; a single id may be given as a string.
  Channel and medium combine through the four valid streams. `f` may be `null`.
- Sales selectors take `f` directly. Every summary carries `prev` (the preceding period of equal length) for deltas.
- Finance works in **whole months**: pass a month key (`'2026-08'`), an ISO date (its month), `{ from, to }` or `'fy'`. For a page driven by the
  global filter use the month of `f.to`, or `{ from: f.from, to: f.to }` for a range. **September is month to date** (16 of 30 days; fixed
  costs accrue pro rata): show `result.period.label` / `period.note` wherever a September figure appears.
- Factory range selectors take `{ from, to, outletIds }`; costs exist by month (`costMonths`, `costing`, `pnl`, `purchases`).
- Payout cycles use calendar weeks, not business days: reconcile by cycle, never by summing days.
- Workflow reads (`bill.list`, `payables`, batches, vendors, audit) describe the store **now**; the date filter does not apply to them.

## 3. Scope: enforced here, not in pages

Every public selector intersects what is asked for with `MK.session.allowedUnitIds()` / `allowedOutletIds()` at call time. Ask for anything;
you receive only what the persona may see, **in the same shape**: with nothing left in scope, for an unknown id and for a month outside the
data every documented key is still there - `totals`, `perOrder`, `breakEven`, `variance`, `period`, `targets` and the like are zero-filled
objects, lists are empty - and nothing throws. The few keys that are `null` by contract are named next to their samples (API-finance
Conventions, API-sales 2.1 and 2.6). The check compares the recursive key set of every selector as the Director with the same call as an
out-of-scope persona. Reads by id are scoped too: `bill.get`, `bill.budgetImpact` and `bill.duplicateCheck` tell nothing about another unit's bill.

| Persona | Sales (`MK.data`) | Finance | Factory | Workflow reads |
|---|---|---|---|---|
| Director, checker, maker, payer | all five outlets | all seven units; `'all'` gives the company view | everything | everything |
| Outlet manager, Bandra | Bandra only, whatever `outletIds` says | Bandra only (`pnl('all')` is Bandra) | empty results | Bandra bills and events, vendors serving Bandra, batches made purely of Bandra bills (none in the seed) |
| Factory manager | zeroed / empty, never an error | the factory only (`pnl('all')` is the factory view) | everything; outlet sales are withheld: `pnl().networkNetSales` is `null` and the two network ratios are rounded to 0.1% so the sales cannot be worked back | factory bills, vendors serving the factory, the factory payment batches |

Do not cache selector results across `session:changed`; the router re-renders the page for you. Do not read `MK.db`, `MK.finance.raw`,
`MK.factory.raw` or `MK.store.coll(...)` for display - they are unscoped. Actions: ask `MK.workflow.<entity>.can(action, record)` and show the
disabled button with its `reason`; the transition itself re-checks role, unit scope and segregation of duties.

## 4. Source tags, estimates and what a channel cannot provide (binding)

1. **Tag every block of channel data** with its source from `MK.config.sources` (`petpooja`, `swiggy_annexure`, `zomato_settlement`, `erp`,
   `estimate`). Selectors tell you which: `result.source` on sales results (always `petpooja` - the gross order data of Swiggy and Zomato
   orders comes from the POS too, so **never tag a sales figure with `MK.config.channels[].source`**; that field and `statementSource` name
   the weekly statement of an aggregator); `sources.actual` / `sources.estimated` on `channelEconomics` (`sources.actual` lists only the
   statements that cover orders of the range, with `actualThrough` per channel); on payout cycles **`row.source` is the statement source
   only when the row has a statement and `'estimate'` until then** (`row.statementSource` says which report is awaited); `order.source` and
   `order.feesSource` on orders; `sources` on `pnl`, `unitEconomics`, `budget` and `costCentreSpend`. Cost, factory and workflow data are `erp`.
2. **Actual and estimated never blend.** Aggregator fees are actual only for settled cycles (Swiggy through 12 Sep, Zomato through 6 Sep);
   the tail is an estimate at assumed contract rates. `channelEconomics` returns `actual` and `estimated` blocks separately (the waterfall and
   the take rates use `actual` only); payouts carry `estimated: true`, `statement: null` and `source: 'estimate'`; orders carry `fees.kind`;
   every P&L line and total, every `pnlTrend` row, `unitEconomics` (top level, per order, per stream, break-even), every `budget` row and
   total (outside `committed` and `actual`) and every `costCentreSpend` node carries `estimatedPart`. Show the estimated part separately and
   label it with the `estimate` caption; an insight that quotes a month with an estimated part says so in the sentence.
3. **No statement is not a zero.** When a range holds no settled orders for a channel the `actual` block has `hasData: false` and `null`
   rates, `sources.actual` leaves that statement out and `waterfall` is `[]` ("Last 7 days" has no Zomato statement). Render "no statement
   for this period", never "0.0%". Quote take-rate evidence through the settled dates (`auditFlags().takeRates[].settledThrough`,
   `windowTo`), not to the end of the filter.
4. **Contract rates are assumed** (`ratesAssumed: true`): say "assumed" next to any contracted rate.
5. **Check before you render a channel field**: `MK.data.can(channelId, fieldKey)` returns `'yes' | 'partial' | 'no'`. For `'no'` render
   "Not provided by <channel>" (`MK.ui.notProvided`), for `'partial'` show the limitation from `MK.data.capability(fieldKey).note`.
   Orders already carry only what their channel supplies (no customer fields anywhere; payment mode in-store only; Zomato prepaid / COD flag;
   Swiggy's restaurant-funded discount split only once the cycle is settled; no order-specific long-distance fee before the settlement
   report). Sales results whose range runs past Swiggy's last annexure carry `provisional: { swiggyDiscountSplitFrom, note }`: caption it
   "Swiggy discount split confirmed with the annexure". Aggregated charts may only use measures every included channel has.
6. **GST**: sales are net of GST. In-store GST is collected by the restaurant and payable; aggregator GST is a memo ("collected and paid by
   Swiggy / Zomato under section 9(5)") - use `gstCollectedByRestaurant` and `gstMemoAggregator` (on `summary`, on every non-dish
   `breakdown` row and as `matrix` / `series` measures), never add the memo to revenue or payables and never label `gst` alone as payable.
   On the cost side GST is a cost: a 5% restaurant takes no input credit, so every ledger line, P&L line and budget figure is GST-inclusive
   and a bill costs `amount + gstAmount`.
7. TDS is shown with descriptive labels only (`bill.tdsLabel`, "TDS by e-commerce operator (0.1%)"); no section numbers. It is a recoverable
   credit on its own line, never part of `totalDeductions` (orders and channel economics use one definition), and it is 0.1% of the net bill
   value of every statement to the rupee.
8. Nothing from partner dashboards exists in the data (`MK.config.notImported`): no funnel, ads performance, ratings, customer mix.

## 5. `MK.seed` - the state the demo opens with

`MK.seed.apply()` -> `{ ok, seeded, version, counts }`. No-op when `MK.store.get('seedVersion').version === MK.seed.version`
(`'mk-seed-v4'`; a browser holding an older seed reseeds on the next load);
`apply({ force: true })` clears the four collections and seeds again ("Reset demo": `MK.store.resetAll()` then `apply()`).
`MK.seed.isSeeded()`, `MK.seed.version`, `MK.seed.params` (every rule parameter), `MK.seed.plan()` (the invoice plan, unscoped, for checks).

The seed writes no record by hand. It turns the billable ledger lines of July onwards (`params.billsFromMonth`) into 690 vendor invoices by
billing pattern and **replays eleven weeks of accounts-payable work through the real `MK.workflow` transitions**, in time order, as the
personas who would have done it (maker and the two unit managers enter, checker reviews and decides, payer runs the payment batches, director
releases, payer records UTRs). The replay stops at 10:00 on 17 Sep 2026; whatever was in flight is the queue on screen. About 140 ms,
identical on every machine (Node and browser).

| Pattern | Lines | Invoice |
|---|---|---|
| monthly in advance | rent (+ its non-creditable GST as a second expense line, `lines`), CAM, staff accommodation, AMC, POS, internet, insurance | dated the 1st, full-month amount |
| weekly | meat, dairy, vegetables, dry goods and bread, oil, packaging, charcoal, housekeeping, production consumables | Monday-Sunday periods cut at month end; amounts follow the unit's daily sales, the factory's actual daily purchases or dispatches |
| per delivery | LPG | cylinders x the month's all-in cylinder price, two to four deliveries a month |
| monthly in arrears | pest control, waste, repairs jobs, local marketing, CA retainer, van rental, Pune run, lab testing | last day of the month; none yet for September |
| utilities | electricity, water | dated the 5th to 11th of the next month, `monthKey` = the month consumed; none yet for September |

**GST is inside the cost.** A ledger line is the all-in cost of the purchase; an invoice splits its share of the line into
`amount = cost / (1 + rate)` and `gstAmount` = the rest, at the rate of the supply (meat, vegetables, staff housing and billers 0%; dairy, dry
goods, oil and charcoal 5%; everything else 18%, LPG included - the cylinder price of `MK.config.tariffs` is the all-in retail price, so a
three-cylinder drop at Rs 2,701 is a bill of 6,867 + 1,236 = 8,103). A rent invoice carries its GST as the `rent_gst` line. For the complete
months (July, August) **`amount + gstAmount` of the bills of a unit x category adds up to the billable ledger lines to the rupee** (rejected
bills and the flagged duplicate aside); nothing sits in payables that the P&L does not carry. TDS (rent, contractor / transport, professional
fees) only changes who is paid. April to June live in the ledger only; `MK.finance.budget` reads those months from the ledger.

**Payment process.** Runs are twice a week so that seven-day credit can be met: the main account `ba01` on Mondays and Thursdays, factory
purchases `ba15` on Wednesdays and Fridays; a run takes every approved bill falling due within six days; the director releases the next
working day - **that is the payment date, `bill.paidOn`** - and the payer records the UTRs two working days later. Credit terms in the
vendor master are ones this process can meet (rent and staff housing due on the 11th; meat, vegetables and dairy 7 days; LPG 15). 55 of
526 paid bills (10%) still went out after the due date, all of them seven-day supplies (meat, dairy, vegetables) and about half of them
invoices from Kalyan and Koregaon Park that reach head office late with the weekly courier; no vendor is late every time and rent never is.

Seeded state: 683 bills - 526 PAID, 19 IN_BATCH, 118 APPROVED (1 overdue), 5 UNDER_REVIEW (the Kalyan compressor bill among them, sent back
once), 8 SUBMITTED, 5 DRAFT (2 by the Bandra manager, 2 by the factory manager), 2 REJECTED; 40 payment batches - `PB-2609-09` PENDING_RELEASE
(8 factory bills, Rs 4.97 L) and `PB-2609-08` RELEASED awaiting UTRs (11 bills of the five outlets, Rs 1.13 L, reported by
`MK.finance.payables()` as `inTransit`, not as overdue); 33 vendors; 1,225 audit events (vendor events since April, bill and batch events
since 1 Sep - earlier steps, the review step included, come from `MK.audit.trail`); 1.14 MB stored.

## 6. `MK.insights.list(f)`

Returns the management insights the rules find, for the persona and the filter, sorted by severity and then by `impact` (rupees):

```js
{ id: 'foodcost|kalyan', severity: 'critical',            // 'critical' | 'warning' | 'info' | 'good'
  area: 'Costs',                                          // 'Revenue' | 'Costs' | 'Approvals' | 'Factory' | 'Vendors'
  title: 'Kalyan food cost runs 3.9 pts above recipe',
  detail: 'Actual food cost is 39.2% of net sales against a recipe cost of 35.3% (Jul 2026 - 16 Sep 2026): ...',
  metric: { label: 'Food cost variance', value: 184036, format: 'inr' },   // render with MK.fmt[format](value); format is 'inr' | 'pct' | 'num'
  route: '#/costs/cogs', unitId: 'kalyan',                // unitId may be null
  impact: 184036, period: 'Jul 2026 - 16 Sep 2026',
  rule: 'foodcost' }                                      // the family of finding it belongs to (MK.insights.FAMILIES[].id)
```

**The rules are a catalogue with dials, not a code file.** `MK.insights.FAMILIES` names the 21 families of finding (the prefix of the
finding id) with what each watches, the window it looks at, the severities it raises, the screen it opens and the dials it uses;
`MK.insights.THRESHOLDS` lists the 16 dials with their range and step; `MK.insights.DEFAULTS` holds the shipped values and
`MK.insights.RULES` the values in force (the same object, updated in place, so a page may keep a reference). `setThreshold(ref, value)`
snaps to the dial and keeps the value in `prefs.insights` (the router does not repaint on prefs; the page that owns the dial repaints
itself and emits `insights:changed`), `resetThresholds(ref?)` restores one or every default, `thresholds()` returns the dials in force
and `catalogue(f)` the families with what fires now for the filter (`{ rules, settings, window, totals: { rules, withDials, firing,
counts, changed } }`). The System / Rules page (`#/system/rules`) renders the catalogue; "Needs attention" links to it.

All text is composed from selector values with `MK.fmt` - no figure and no claim is typed in (who carries a markup amount, which variance
drives an under-absorption and how much of a month is estimated are all computed); approve a bill or release a batch and the list changes on
the next call. Warm cost: about 11 ms for the opening filter, about 16 ms for the full year, about 50 ms for the first call after a build.
Performance rules look at the filter range extended back to at least eight weeks (`MK.insights.window(f)`; without `MK.config` it returns the
same keys with `null`), monthly rules at the latest complete month in it, queue rules at the store as it is now. Take-rate insights quote
their evidence as "Settled statements from 23 Jul (Swiggy through 12 Sep, Zomato through 6 Sep)". `MK.insights.counts(f)` gives
`{ critical, warning, info, good, total }`; thresholds are in `MK.insights.RULES`. With an outlet filter the factory rules are skipped.
30 insights for the director on the opening filter (5 critical, 15 warning, 7 info, 3 good), 7 for the Bandra manager, 10 for the factory manager.

## 7. The stories in the data and where each shows up

Every story emerges from parameters and rules; none is a patched number. The demand seed is a parameter too
(`MK.config.demand.seed = 'mk-sales-v825'`): it was picked so that every dated event with a chart marker is visible in the generated data
at every outlet (Bakri Eid x1.23-1.35 by outlet, Independence Day x1.09, Ganesh Chaturthi x0.84, 15-16 Sep x0.90, the extreme-rain day and
the six heavy-rain days) and every calibration band holds; the check asserts each of them, so a reseed cannot silently lose a story.

| Story | Where a page finds it | Insight id |
|---|---|---|
| Kalyan: actual food cost 3.5-4.0 pts above recipe, above the 38% red flag | `MK.finance.foodCost(month).rows` (`variancePts`, `redFlag`); Costs / COGS | `foodcost|kalyan` |
| Andheri (and Koregaon Park): effective take rate 7-8 pts above contract once ads and refunds are counted | `MK.data.channelEconomics(f).byOutlet[].actual`; `auditFlags(f).takeRates`; Revenue / Audit | `takerate|andheri`, `takerate|koregaon` |
| Fort: weak weekends and evenings, rent 12-13% of sales | `matrix(f, 'outlet', 'dow' or 'slot', 'netSales')`; `pnl('fort', month)` | `underuse|fort`, `rent|fort` |
| Bandra: best EBITDA %, rent the watch item | `pnl` / `pnlTrend('bandra')` | `margin|bandra` |
| Koregaon Park: from a loss of 5.8% in April to a profit of 4.5% in August (2.8% for 1-16 Sep, with its estimated part quoted); fill rate 93-95% on the alternate-day run; logistics per kg about 3.4x Mumbai | `pnlTrend('koregaon')`; `MK.factory.dispatch(f)` | `ramp|koregaon`, `fill|koregaon` |
| Zomato charged 24% against 22% at Fort, weeks of 3 and 10 Aug | `MK.data.payouts(f)` (SHORT_PAID), `auditFlags(f)` type `commission` | `commission|fort|zomato` |
| Swiggy short-paid Bandra by Rs 14,800, 23-29 Aug, dispute open | `payouts(f)` (DISPUTED), `auditFlags` type `payout`; Bandra budget line `agg_other` | `payout|PO-SW-bandra-2026-08-23` |
| Swiggy ads doubled at Koregaon Park, 30 Aug - 5 Sep (the open cycle is still estimated at the usual share) | `auditFlags` type `ads` | `ads|koregaon|swiggy` |
| Mutton seekh: POS price 450 -> 480 on 1 Aug, aggregator list not updated. Four more items are listed at a markup that does not even cover the take rate; 52 of 56 listings realise less than the POS price once discounts and charges are taken (break-even markup 61-88% by outlet) | `auditFlags` type `markup` and `markupSummary`; `MK.data.dishes(f)` (`markupPct`) | `markup|mutton_seekh`, `markup|others` |
| LPG budget set at the January price: gas over plan at every unit from May (also with the seed applied - April to June are read from the ledger) | `MK.finance.budget(month, unit)` | `budget|gas_lpg` |
| Kalyan compressor, Rs 68,000 one-off in August: bill sent back once, under review again, takes repairs to 342% of plan | ledger `component: 'one_off'`; `bill.list({ unitId: 'kalyan', categoryId: 'repairs' })`, `budgetImpact`, `MK.audit.trail` | `budget|repairs`, `approvals|budget` |
| Chicken seekh mix yield 106% -> 99.3% in August | `MK.factory.production(f).yieldFlags`, `series` | `yield|FP03` |
| Chicken bought below standard Aug-Sep, onions, oil and mutton above | `MK.factory.purchases(month)` | `ppv|RM_CHICKEN` (good), `ppv|RM_ONION`, `ppv|RM_OIL`, `ppv|RM_MUTTON` |
| Factory under-absorbs by 4-5% in June and July: chicken at Rs 284-290 against the Rs 270 standard is the driver (`variance.rmPrice`), the LPG spike shows as an unfavourable `variance.utilities` from May to July | `MK.factory.pnl(month)`, `summary(f).costMonths` | `absorption|2026-07` (names its two largest drivers) |
| Charcoal follows the tandoor (peak in the Eid month); fuel and the Pune run follow kg and runs | ledger lines `charcoal`, `vehicle_fuel`, `pune_run` (`basis`) | - |
| Duplicate vendor invoice in the checker's queue (Ecowrap, Andheri; the original is paid) | `bill.list({ flagged: true })`, `bill.duplicateCheck` | `approvals|duplicate|<bill id>` |
| Bills waiting three days or more; overdue payables; far-outlet invoices arrive late by courier | `bill.list({ status: PIPELINE_STATES })`, `MK.finance.payables()` (`overdue`, `inTransit`) | `approvals|waiting`, `payables|overdue` |
| Payment batch waiting for the director; one released without UTRs | `MK.workflow.batch.list({ status })` | `batch|PB-2609-09`, `batch|PB-2609-08` |
| Inkwell Print and Media moved its bank account to a personal name on 10 Sep: approval withdrawn, name match 19%, five approved bills cannot be paid | `vendor.get('v_print')` (`verification`, `history`), `batch.eligibleBills()` (`eligible: false`, `reason`) | `vendor|v_print` |
| AccuTest Food Labs became a Pvt Ltd on 16 Sep (new PAN, GSTIN, account): verification pending. GreenLeaf Containers is a draft. Crescent Frozen Foods was rejected at onboarding | `vendor.list({ state })` | `vendor|v_lab` |
| 18 bank accounts today vs four proposed; factory and main payment accounts are the two in use by the batches | `MK.config.bankAccounts`, `batch.bankAccountId` | - |

## 8. Ten recipes

```js
var f = MK.filters.get(), month = f.to.slice(0, 7);

// 1. Hero figure with delta
var s = MK.data.summary(f);
MK.fmt.inr(s.netSales); MK.fmt.delta(s.netSales, s.prev.netSales);              // '₹61.2 L', { label: '+5.0%', dir: 'up' }
s.provisional;                                                                  // { swiggyDiscountSplitFrom: '2026-09-13', note } -> small caption; null for settled ranges

// 2. Daily trend with event markers
var trend = MK.data.series(f, { measure: 'netSales', grain: 'day', by: null });
var markers = MK.config.events.filter(function (e) { return e.marker && e.from <= f.to && e.to >= f.from; });

// 3. Outlet scorecard: sales and growth from sales, margins from finance, sparkline from a series
MK.data.breakdown(f, 'outlet').rows.map(function (r) {
  var t = MK.finance.pnl(r.id, month).totals;
  return { outlet: r.label, netSales: r.netSales, growth: MK.fmt.delta(r.netSales, r.prevNetSales), foodCostPct: t.foodCostPct, ebitdaPct: t.ebitdaPct,
    estimatedPart: t.estimatedPart };                                           // > 0 in September: mark the margin as partly estimated
});
MK.data.series(f, { measure: 'netSales', grain: 'day', by: 'outlet' }).series;   // values per outlet for MK.charts.sparkline

// 4. Aggregator take rate: actuals only, estimate shown apart, and "no statement" is not 0%
var ce = MK.data.channelEconomics(f), a = ce.total.actual;
if (a.hasData) { a.effectiveTakeRate; a.contractedTakeRate; }                   // tag: ce.sources.actual, "through" ce.actualThrough; say "assumed" for the contract
else { /* "No statement for this period" - the rates are null, ce.sources.actual is [] and ce.waterfall is [] */ }
ce.total.estimated.netSales;                                                    // unsettled tail - tag MK.config.sources.estimate.caption
ce.waterfall;                                                                   // gross menu value -> net payout, settled orders only

// 5. Cost KPIs for the month of the filter
var t = MK.finance.pnl('outlets', month).totals;                                // foodCostPct, ebitdaPct, estimatedPart; period.note for September
MK.finance.pnl('all', month).lines;                                             // company view incl. 'factory_absorption' and head office

// 6. Approval and payables tiles
MK.workflow.bill.counts().awaitingApproval;                                     // SUBMITTED + UNDER_REVIEW in scope
var p = MK.finance.payables(); p.dueIn7Days.amount; p.overdue; p.inTransit;     // inTransit = released to the bank, UTR awaited: not overdue

// 7. Day-of-week x hour heatmap, and the peak-hour table
MK.data.matrix(f, 'dow', 'hour', 'orders');                                     // rows Mon..Sun, cols 12 pm..3 am, values[row][col]
MK.data.breakdown(f, 'hour').rows;

// 8. Order drawer that respects what the channel provides
var order = MK.data.recentOrders(f, { limit: 50 }).rows[0];                     // .total counts cancelled orders too unless status is passed
['order.paymentMode', 'order.prepTime', 'order.deliveredTime', 'order.cancelReason', 'order.feesActual'].forEach(function (key) {
  if (MK.data.can(order.channelId, key) === 'no') { /* MK.ui.notProvided(channel label) */ }
});
order.fees && order.fees.kind;                                                  // 'actual' | 'estimated' -> tag MK.config.sources[order.feesSource]
order.fees && order.fees.tds;                                                   // its own line ("recoverable credit"); totalDeductions excludes it

// 9. A budget line and the bills behind it
var line = MK.finance.budget('2026-08', 'kalyan').rows.filter(function (r) { return r.categoryId === 'repairs'; })[0];   // plan 31000, committed 37950, pipeline 68000, status 'OVER', basis 'bills'
MK.workflow.bill.list({ unitId: 'kalyan', categoryId: 'repairs', monthKey: '2026-08' });                                 // monthKey = expense month
MK.finance.budget('2026-05', 'bandra').basis;                                                                            // 'ledger': no bills before July, the month is read from the ledger

// 10. The checker's review drawer, then the decision
var bill = MK.workflow.bill.get(id);
MK.workflow.bill.budgetImpact(bill);        // { budget, committed, afterThis, amount /* amount + GST */, status: 'WITHIN' | 'NEAR' | 'OVER' }
MK.workflow.bill.duplicateCheck(bill);      // { hasExact, hasPossible, matches: [...] } - also on live form state, where the amount is a string
MK.finance.vendorSpend(bill.vendorId);      // spend history of the vendor
MK.audit.toTimeline(MK.audit.trail('bill', bill.id));   // an unbroken chain: create > submit > review > approve ...
var may = MK.workflow.bill.can('approve', bill);                 // { ok, reason } for the button
var res = MK.workflow.bill.approve(bill.id, note);               // { ok, record } | { ok: false, error }; the router re-renders on store:changed
```

More in the companion documents: payment batches (`batch.eligibleBills`, `create`, `submit`, `release`, `markPaid`, `toCsv`) and vendor
onboarding (`vendor.preChecks` on live form state, `create`, `runVerification`, `approve` / `override` / `reject`) in API-workflow 4; factory
cost per kg (`MK.factory.costing(month)`), dispatch matrix and inventory in API-finance 3; recipe cost cards (`MK.finance.dishCost`) in API-finance 2.5.

## 9. Guarantees checked by `tools/check-data.js`

Net sales agree across all thirteen dimensions, the matrix, the series and the dish table to the rupee, and the GST split adds up on every
row; filters read a single id given as a string and echo a clamped range; the 14-day order list aggregates to the cubes; settled cycles equal
the sum of their orders' fees, both payout blocks obey the net-payout arithmetic, TDS is 0.1% of net bill value on every cycle, a payout row is
tagged `estimate` exactly when it has no statement, order-level `totalDeductions` has one definition, estimated Zomato orders carry no
order-specific long-distance fee, the open Koregaon Park cycle is estimated at the usual ads share; channel economics by channel = by outlet =
total for every money key and a month = the sum of its days; a range without a statement yields no actuals; markup flags follow the RESEARCH
rule with day-by-day prices and the summary counts every listing below break-even; outlet factory-sourced food cost = factory dispatch value;
factory P&L, variance analysis and stock reconcile; aggregator ledger lines = payout data; `estimatedPart` is the same figure on the P&L, unit
economics, budget and cost centres; stream roll-ups tie to the P&L; one definition of food cost across the dish table and `foodCost()`;
`amount + GST` of the bills = the ledger for July and August, LPG is billed at the all-in cylinder price; the budget basis is decided per month
and committed + pipeline = the ledger for every complete month, with the May gas overrun visible after seeding; approving a bill moves budget
`pipeline` to `committed`; workflow invariants, payment discipline (under 15% late, no vendor always late, rent never late), in-transit
payables, unbroken audit trails with a review step before every decision, refusal paths, input bounds and reset; calibration bands with
documented deviations, rosters ordered by the trade, consumption-driven charcoal and fuel; every marked demand event visible in the data;
scope for the Bandra and factory managers on every public selector, no leak by bill id, results keeping their shape with nothing in scope and
for a month outside the data, prototype names treated as unknown ids; the capability matrix against DATA-FEASIBILITY.md and against every
order; every seeded story detected by an insight rule, with coverage and estimated parts stated in the sentences; two fresh processes, a
forced rebuild and the browser give identical hashes; first boot (engine + finance + factory + seed) stays under 600 ms in Node (about 430 ms);
the forecast outlook runs from today to month-end and adds up, its month-end projection equals sales to date plus the forecast of the rest, the
ex-ante backtest reproduces the weekly actuals and beats the same-day-last-week baseline, weather is never applied to a forecast day, the
October calendar entries lie beyond the data, the purchase suggestions reconcile to the kitchen's own trailing use within 15% on every item
and respond to the safety dials, the month-end projection of a budget line follows sales or run-rate by category and only exists for the
month in progress, the forecast is deterministic across settings changes and rebuilds, and every forecast selector obeys persona scope;
the API documents quote the seed, the rosters, the seeded counts and the headline samples of the dataset in force.

## 10. Known gaps

- September has no bills yet for utilities and monthly-in-arrears services, so on the bills basis those budget lines show no `committed` for
  September; the P&L (ledger accruals) is complete. Koregaon Park vegetables are cash purchases and never pass through a bill.
- The calibration deviations documented in API-finance section 5 are accepted by the check as explicit bands: Koregaon Park reaches a small
  profit (+2.8% to +4.5%) rather than +5%; Kalyan is above its band in July (10.0%) on a roster sized by the trade; company EBITDA is 4.2% in
  June (chicken at Rs 290); the factory under-absorbs by 4-5% in June and July; factory cost 7.2-7.7% of sales; transfer value 24.4-24.7%;
  write-offs 0.52% in August. The calibration is tight: only a few demand seeds in a hundred pass every band and every event assertion.
- `MK.config.channels[].source` is kept equal to `statementSource` for the aggregators because existing page code reads it as the statement
  source; `salesSource` (always `'petpooja'`) is the field that says where a channel's order data comes from.
- The styleguide pages (`js/pages/styleguide*.js`, outside the data layer) still print 1961-Act TDS section numbers in three sample labels;
  the data layer itself carries descriptive TDS labels only.
- Insights for queue rules ignore the date and outlet filters by design; `MK.finance.payables()` has no unit filter beyond the persona.
