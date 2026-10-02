# Miya Kebabs ERP - look-and-feel mockup: build specification

This folder is a throwaway, client-facing **mockup**. It is not the product and shares no
code with it (the product is Java/Spring, see the repo `CLAUDE.md`). Its only job is to let
the client see and click what the finished system could feel like, on believable data.

Read this file fully before writing code. `docs/RESEARCH.md` (facts, prices, cost
benchmarks) and `docs/DATA-FEASIBILITY.md` (what each sales channel can and cannot
provide) are equally binding. `docs/API.md` documents the data layer once it exists.

---

## 1. Scope

Client brief areas (from "A - Current State & Vision"):

| # | Area | In the mockup |
|---|---|---|
| 1 | Revenue intelligence | **Full** - the centrepiece. Outlet / city / channel / medium / time-slot / dish reporting; tax, markup and commission audit; payout reconciliation |
| 2 | Cost structure at restaurant | **Partial** - structured COGS, expense categories, per-outlet unit economics, cost-control flags. No AI bill verification |
| 3 | Cost structure at banking level | **Partial** - two-tier maker-checker (bill approval, then payment-batch release), budget tracking. TDS/GST only as fields on a bill. No Zoho, no bank connection, no AI |
| 7 | Banking | **Light** - today's 18 current accounts vs a consolidated target structure; cost-centre tree with spend. No balances, no cash flow |
| 8 | Factory | **Partial** - production, yield, dispatch to outlets at transfer price, factory unit economics, inventory, payables |
| - | Vendor onboarding | **Full workflow**, with verification clearly labelled as simulated |
| 4, 5, 6, 9 | Cash flow, balance sheet, compliances, forecasting | **Out.** Do not build, do not hint at with empty menu items |

Emphasis requested by the client team: **analytics and dashboards that help management
decide**, over transactional depth.

Non-goals: authentication, real integrations, mobile layout below 1024px (must not break,
need not be pretty), dark theme, printing, i18n, accessibility beyond sensible basics
(keyboard focus visible, labels on inputs, table twin for charts).

## 2. Hard constraints

1. **Runs by double-clicking `index.html`** from the file system, offline. Therefore:
   classic `<script src>` tags only - **no ES modules, no `import`, no `fetch`/XHR of
   local files, no service workers, no build step, no CDN links, no web fonts.**
2. One global namespace: `window.MK`. Every JS file is an IIFE that attaches to it and
   must tolerate being loaded when its optional dependencies are absent.
3. Data-layer files (`js/core/kernel.js`, everything in `js/data/`) must also run under
   **Node** with no DOM (they are checked by `tools/check-data.js`). Use
   `(function (root) { ... })(typeof window !== 'undefined' ? window : globalThis);`.
4. **No emojis anywhere** - UI, data, comments. Icons are inline SVG from `MK.ui.icon()`.
5. **No hard-coded colours in JS or page CSS.** Use the CSS custom properties in
   `css/tokens.css` (read them in JS through `MK.charts.token('--name')`).
6. Light theme only.
7. Untrusted-looking strings (vendor names, notes, anything a user typed) go into the DOM
   with `textContent` / `MK.ui.h()` children, never string-concatenated `innerHTML`.
8. Money is integer **paise-free rupees** in data (whole rupees, `Math.round`), formatted
   only at the edge with `MK.fmt.inr()`. Indian digit grouping; lakh (L) and crore (Cr)
   for compact values. Percentages to one decimal.
9. Deterministic: the same dataset on every load and every machine. Only `MK.rng(seed)`;
   never `Math.random()`, never `Date.now()` for data. "Today" is `MK.config.today`.
10. localStorage holds **only mutable workflow state and UI preferences** (see section 7).
    Generated analytics data is rebuilt in memory on every load (target: under 600 ms).
11. Every number on screen must come from the data layer. No literal figures in page code,
    including in insight sentences.
12. **Never show a data point attributed to a channel unless
    `MK.config.capabilities` marks it available for that channel** (section 9).

## 3. Files and load order

```
index.html
css/tokens.css [exists]  css/base.css  css/components.css  css/charts.css
css/pages/<group>.css    one per nav group: overview, revenue, costs, approvals, vendors, factory, banking, system
vendor/echarts.min.js                       Apache ECharts 5.6.0 (local copy)   [exists]
js/core/kernel.js        MK namespace, calendar, fmt, dates, rng, store, session/roles   [exists]
js/data/config.js        master data, calendar, channel terms, capabilities
js/data/engine.js        order-by-order sales simulation -> cubes, recent orders, payouts
js/data/sales.js         MK.data.* selectors over the sales cubes
js/data/finance.js       cost model, outlet P&L, unit economics, budgets, food cost
js/data/factory.js       production, yield, dispatch, inventory, product costing
js/data/seed.js          vendors, bills, payment batches, audit seed (consistent with finance)
js/data/workflow.js      state machines: bill, batch, vendor (+ audit writes)
js/data/insights.js      rule-based management insights derived from the above
js/core/ui.js            DOM helpers and components
js/core/charts.js        ECharts wrapper, theme, table twin
js/core/filters.js       global filter bar + state
js/core/router.js        hash router, nav, page registry
js/pages/*.js            one file per page (names fixed in section 8)
js/pages/styleguide.js, js/pages/styleguide-charts.js    `#/system/styleguide*` - living reference of the UI kit and chart kinds
js/app.js                boot
tools/check-data.js      Node reconciliation checks        tools/serve.js  static server for previews [exists]
docs/SPEC.md  docs/RESEARCH.md  docs/DATA-FEASIBILITY.md  docs/API.md (data layer)
docs/UI-API.md (shell, router, filters, UI kit)  docs/CHARTS-API.md (chart wrapper)
```

`index.html` lists every stylesheet and script above in that order, including all page
files from section 8 and all `css/pages/*.css`, so page authors never edit `index.html`.
A script or stylesheet that does not exist yet must not break boot (a 404 on a classic
script tag is harmless; `app.js` must not assume any page or data file is present).

## 4. Visual system

Feel: calm, dense, finance-grade; a tool a CFO trusts. Warm off-white page, white cards
with a hairline ring, near-black ink, one restrained brand accent used sparingly (nav
marker, primary button, focus ring). Generous whitespace inside cards, tight tables.
System font stack only: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.

Layout: fixed left sidebar (232px; brand block, grouped nav, "demo dataset" note at the
bottom), top bar (page title + breadcrumb on the left; global search is NOT needed; on the
right: data-as-of stamp, role switcher, reset-demo in a menu). Content max-width 1440px,
12-column grid, 16px gutters, cards with 16-20px padding and 10px radius.

Tokens (`css/tokens.css`, already validated - do not change values):

```
--page #f9f9f7   --surface #fcfcfb   --surface-2 #f3f2ee   --ring rgba(11,11,11,.10)
--ink #0b0b0b    --ink-2 #52514e     --ink-3 #898781       --grid #e1e0d9  --axis #c3c2b7
--accent #8a2f14 (brand ember; UI only, never a data series)   --accent-ink #ffffff
--focus #2a78d6
Entity colours (fixed; colour follows the entity, never its rank):
  --ch-petpooja #2a78d6   --ch-swiggy #eda100   --ch-zomato #e34948
  --md-dinein #4a3aa7     --md-takeaway #1baf7a --md-delivery #eb6834
  --ot-1..5 #2a78d6 #eb6834 #1baf7a #eda100 #e87ba4   (outlets, in config order)  --ot-factory #4a3aa7
  --series-1..8 #2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #4a3aa7 #e34948  (generic categorical, fixed order)
Sequential (blue ramp) --seq-100 #cde2fb ... --seq-700 #0d366b ; diverging blue <-> red with midpoint #f0efec
Status (reserved; always with icon + label): --st-good #0ca30c --st-warn #fab219 --st-serious #ec835a --st-critical #d03b3b
  text variants: --st-good-ink #006300  --st-critical-ink #a32222
```

Chart rules (enforced by `MK.charts`, follow them in page code too):

- Pick the form by the job: single value -> stat tile; magnitude -> bar (one colour for all
  bars; never a value-ramp on nominal categories); trend -> 2px line; part-to-whole ->
  stacked bar; grid of magnitudes -> heatmap on the blue sequential ramp; one series is the
  point -> emphasis (accent colour + grey rest); above/below target -> diverging bar.
- **Never a dual-axis chart.** Two measures of different scale -> two charts or small multiples.
- No pies or donuts except a single part-to-whole with <= 5 slices where shares differ clearly; prefer a stacked bar.
- Bars <= 24px thick, 4px rounded data end, 2px surface gap between stacked segments. Lines 2px. Hairline solid gridlines, no dashed grids. Area fill ~10% opacity.
- Legend always present for >= 2 series; none for one. Direct labels selectively (endpoint, extreme), never on every point. Text is ink, never the series colour.
- Tooltips on every chart (axis-trigger crosshair on line/area; item tooltip on bar/cell), values formatted with `MK.fmt`.
- Every chart card has a "Table" toggle rendering the same data as a table (done by `MK.charts.card`).
- Filters live in the one global filter row, never inside a chart card. A chart card may have a small segmented control for *measure or grouping* only.
- More than ~7 categories carrying meaning -> a table (optionally with inline bars), not more colours.
- Swiggy amber, takeaway aqua and some outlet colours are below 3:1 on the surface: those charts must show visible labels or rely on the table twin (already provided).

## 5. Kernel (exists: `js/core/kernel.js` - read it, do not rewrite it)

`MK.fmt` (inr, inrFull, num, pct, delta, date helpers), `MK.dates`, `MK.rng(seed)`,
`MK.store` (namespaced, versioned localStorage with in-memory fallback for Node),
`MK.session` (personas, current user, `can(action, ctx)`, `allowedOutletIds()`), `MK.bus`
(tiny pub/sub: `on`, `emit`). Events used across the app: `session:changed`,
`filters:changed`, `store:changed`, `route:changed`.

### 5.1 Shell, UI kit and charts (contract between the shell authors and the page authors)

Exact signatures are documented by their authors in `docs/UI-API.md` and `docs/CHARTS-API.md`; the names below are fixed.

**Router (`js/core/router.js`)** - pages self-register; nothing else knows about them:

```js
MK.router.register({
  id: 'revenue-sales', route: '#/revenue/sales', group: 'Revenue', title: 'Sales explorer',
  subtitle: 'optional one-liner under the title',
  units: 'outlets',            // 'all' | 'outlets' | 'factory' - which personas get the nav item (by their unit scope)
  roles: null,                 // or an array of roles allowed to open it
  filters: ['date', 'outlet', 'channel', 'medium'],   // which global filters the page honours; [] hides the bar
  render: function (root, ctx) { /* build DOM into root; may return a cleanup function */ }
});
```

`ctx = { filters, user, params, navigate(route), rerender() }`. The router re-runs `render`
on `filters:changed`, `session:changed` and `store:changed` (debounced), after disposing the
page's charts, so `render` must be idempotent and cheap. Page-local UI state that must
survive a re-render (selected tab, open record) lives in `ctx.state` (a plain object kept per
route by the router). Unknown or forbidden routes fall back to the first allowed page.

**UI kit (`js/core/ui.js`)** - `MK.ui.h(tag, attrs, ...children)` (hyperscript; strings become
text nodes), `icon(name)`, `grid(cols, children)`, `card({title, subtitle, actions, body, footer})`,
`hero({label, value, delta, sub})`, `statTile({label, value, delta, goodWhen, sub, spark, onClick})`,
`kpiRow(tiles)`, `table({columns, rows, onRowClick, dense, footer, empty, sortable, maxHeight})`
(columns: `{key, label, align, format, render, width}`; supports inline bar cells via
`render: MK.ui.cells.bar(max, colourVar)` and heat cells via `MK.ui.cells.heat(min, max)`),
`chip(label, tone)`, `statusChip(state)` (maps every bill / batch / vendor / payout state to a
tone + icon + label), `tabs`, `segmented`, `select`, `drawer`, `modal`, `confirm`, `toast`,
`form` helpers (`field`, `input`, `textarea`, `moneyInput`, `dateInput`), `timeline(events)`,
`meter({value, max, tone, label})`, `emptyState`, `callout(tone, title, body)`,
`notProvided(channelName)`, `keyValue(pairs)`, `downloadCsv(filename, columns, rows)`.

**Charts (`js/core/charts.js`)** - depends only on the kernel, ECharts and the DOM.
One call builds a card with title, chart, tooltip, legend and the table twin:

```js
MK.charts.mount(parent, {
  title, subtitle, height,                 // height of the plot area incl. axis labels
  kind: 'line' | 'area' | 'bar' | 'hbar' | 'stackedBar' | 'hstackedBar' | 'heatmap' | 'waterfall' | 'scatter' | 'divergingBar',
  data: { ... },                           // per kind, see UI-API.md
  format: 'inr' | 'num' | 'pct' | function,
  controls: [{ id, options: [{value, label}], value }], onControl: function (id, value) {},
  onClick: function (datum) {},            // drill-through
  table: 'auto' | { columns, rows },
  note: 'small print under the chart'
});
MK.charts.sparkline(el, values, { colourVar, emphasiseLast })   // inline SVG, no ECharts
MK.charts.token('--ch-swiggy')                                   // read a CSS custom property
MK.charts.colourFor('channel' | 'medium' | 'outlet' | 'series', idOrIndex)
MK.charts.disposeAll(container)
```

The wrapper owns the house style from section 4 (thin bars, hairline grid, 2px lines, no
dual axis, ink text, tooltips formatted through `MK.fmt`, resize handling). Page authors
never build raw ECharts options unless a form is missing - then add a kind to the wrapper.

**Filters (`js/core/filters.js`)** - `MK.filters.get()` returns the filter object of section
6.4; `MK.filters.set(partial)`; `MK.filters.mountBar(container, showList)`. Date presets:
Last 7 days, Last 30 days, This month, Last month, This quarter, FY to date, Custom - all
relative to `MK.calendar` (frozen demo clock), default This month. Outlet, channel and
medium are multi-selects; the outlet list is already limited to the persona's scope.
State persists in `prefs` and emits `filters:changed`.

## 6. Data layer

### 6.1 Entities (in `MK.config`)

- `today` = `2026-09-17`; data covers `2026-04-01` .. `2026-09-16` (169 days), FY 2026-27.
- `outlets` (order fixed): `bandra`, `andheri`, `fort`, `kalyan` (Mumbai region) and
  `koregaon` (Koregaon Park, Pune), plus `factory` (type `factory`, not customer facing) and
  `ho` (type `ho`, head-office cost centre: no sales, appears only in costs, bills and cost centres).
  Each: id, name, short, city, area, type, sqft, seats, openedOn, colourVar, manager user id.
- `channels`: `petpooja` (kind `pos`, the in-store POS: dine-in and takeaway), `swiggy`,
  `zomato` (kind `aggregator`, delivery). `mediums`: `dinein`, `takeaway`, `delivery`.
  `streams` (the only valid channel x medium pairs): `pp_dinein`, `pp_takeaway`,
  `sw_delivery`, `zo_delivery`. The factory has no sales.
- Business day = 12:00 noon to 04:00 next morning (outlets trade to about 3:45 am). Hour buckets
  12..27 (24 = midnight, 27 = 3 am), all attributed to the business day. `slots`: `lunch` 12-16,
  `evening` 16-19, `dinner` 19-23, `latenight` 23-04. Each outlet has its own opening hours
  (Bandra opens at 17:00; Kalyan closes 23:45) - see RESEARCH.md section 2.
- `dishes`: the 12 real menu items in RESEARCH.md section 3 with category, veg flag, POS price,
  aggregator price **per outlet** (Kalyan has its own list; the roll is Koregaon Park only), recipe (bill of materials in factory
  products + locally bought items + packaging for delivery/takeaway).
- `items`: raw materials (factory buys), factory products (semi-finished/finished, unit kg
  or pieces, standard yield, standard cost, transfer price), outlet-local purchase items.
- `events`: dated demand effects (Eid al-Adha, IPL window, monsoon heavy-rain days,
  Shravan, Ganeshotsav, month-start salary days), each with per-medium / per-outlet
  multipliers. Exact dates come from RESEARCH.md.
- `channelTerms`: contracted commission %, payment-gateway/collection fee %, GST on fees,
  TDS 194-O %, payout cycle and lag, per aggregator (values from RESEARCH.md).
- `capabilities`: the channel data-availability matrix (section 9).
- `expenseCategories`, `costCentres`, `bankAccounts` (18 current-state accounts + target
  structure), `users` (personas), `budgetPolicy`.

### 6.2 Outlet personalities (the stories the data must tell)

The generator is parameter-driven so these emerge from the model, never from patched numbers.

| Outlet | Character | What management should notice |
|---|---|---|
| Andheri | Highest sales, delivery-heavy, strong late night, high aggregator ads and discounts | Big sales, thin margin: effective aggregator take rate well above contract once ads and discounts are counted |
| Bandra | Evening-only flagship, strongest dine-in and Zomato, highest rent per sq ft | Best EBITDA %; rent is the watch item |
| Fort | Office district: weekday lunch peaks, weak weekends and dinners, high takeaway | Under-used evenings and weekends; low aggregator dependence |
| Kalyan | Suburban, lower AOV and rent, growing orders | Actual food cost runs 3-4 points above theoretical (wastage / portioning) - a control problem, not a pricing one |
| Koregaon Park | Newest (opened Jul 2025), delivery-led, still ramping, sells rolls, supplied from Mumbai on alternate days | Moving from loss to small profit; logistics cost per kg and fill rate are the drag |
| Factory | Central kitchen supplying all five; no customers | Yield dip on one product line in Aug; chicken price swing; capacity utilisation; fill rate to Pune |

Exact parameters, dates and the seeded exceptions are in RESEARCH.md sections 3-7.
Seeded anomalies for the audit screens (all generated by rule, flagged by rule):
one aggregator payout short-paid; one period where an aggregator charged a commission
rate above contract at one outlet; one dish whose aggregator menu price was not updated
after a POS price change (markup anomaly); duplicate vendor invoice attempt in the bills
queue; two budget lines over plan; one vendor whose bank name match is low.

### 6.3 Simulation (`engine.js`)

Order-by-order for every day, outlet and stream: demand model (base x outlet ramp x
day-of-week x month-start x events x weather x noise) -> orders per hour -> each order gets
item lines drawn from the dish mix for that outlet/stream/slot -> prices by channel ->
restaurant-funded discount by campaign -> GST 5% (collected by the aggregator under
section 9(5) for aggregator orders, by the restaurant for POS orders) -> per-order
aggregator charges. **Fee visibility follows DATA-FEASIBILITY.md section 1: every aggregator
order carries `fees.kind = "actual"` only if its payout period is settled (statement uploaded),
else `"estimated"`; selectors return actual and estimated amounts separately and never blend
them silently.** Accumulate into typed-array cubes; keep full order objects only for
the last 14 days (`MK.db.recentOrders`). Build weekly payout cycles per outlet x
aggregator with expected vs actual, using each aggregator's own cycle (Swiggy Sunday-Saturday
cut at month-end, settled Tuesday; Zomato Monday-Sunday, paid by Thursday) and statuses
MATCHED, SHORT_PAID, DISPUTED, AWAITING_STATEMENT, IN_CYCLE. Company scale target: roughly
700-800 orders/day, about Rs 1.15-1.25 crore net sales per month (RESEARCH.md section 2).

### 6.4 Selectors (names fixed; exact shapes documented by the authors in `docs/API.md`)

Filter object everywhere: `f = { from, to, outletIds, channelIds, mediumIds }` (ISO dates;
`null`/missing = all). **Every selector intersects `f.outletIds` with
`MK.session.allowedOutletIds()`** - role scope is enforced in the data layer, never in pages.
Every summary returns the same measures for the immediately preceding period of equal
length under `prev` so tiles can show deltas.

```
MK.data.summary(f)                       orders, grossSales, restaurantDiscount, netSales, gst, aov, itemsPerOrder, cancelled..., prev
MK.data.series(f, {measure, grain, by})  grain day|week|month; by null|outlet|city|channel|medium
MK.data.breakdown(f, by)                 by outlet|city|channel|medium|stream|slot|hour|dow|dish|category
MK.data.matrix(f, rowDim, colDim, measure)   e.g. outlet x channel, dow x hour, dish x channel
MK.data.dishes(f)                        qty, net sales, theoretical cost, contribution, popularity, menu-engineering class, POS vs aggregator price, markup %
MK.data.channelEconomics(f)              gross menu value -> discounts -> net sales -> commission -> gateway fee -> GST on fees -> TDS -> ads -> net payout; effective vs contracted take rate
MK.data.payouts(f)                       payout cycles: expected, actual, variance, status, reasons
MK.data.auditFlags(f)                    commission / markup / tax / payout exceptions
MK.data.recentOrders(f, opts)            order list (last 14 days) with only channel-available fields populated
MK.finance.pnl(outletId|'all'|'factory', monthKey)      lines with group, amount, % of sales; totals
MK.finance.pnlTrend(outletId)            by month
MK.finance.unitEconomics(outletId, monthKey)   per-order and per-sq-ft economics
MK.finance.foodCost(monthKey)            theoretical vs actual by outlet, variance value
MK.finance.budget(monthKey, outletId)    per category: budget, committed (approved + paid bills), pipeline (submitted), variance, status
MK.finance.payables(asOf)                ageing by vendor, due this week, overdue (from bills)
MK.factory.summary(f) .production(f) .costing(monthKey) .dispatch(f) .inventory() .pnl(monthKey)
MK.insights.list(f)                      [{severity, area, title, detail, route}] computed by rule
MK.workflow.bill.*  .batch.*  .vendor.*  each returns {ok, error}; validates role + segregation; writes MK.audit
```

Reconciliation is mandatory and checked in Node (`tools/check-data.js`): totals by outlet
= totals by channel = totals by dish = grand total; payouts = sum of the orders they
cover; outlet COGS = recipe cost of what was sold + modelled variance; factory dispatch
value = outlets' factory-sourced COGS; seeded bills per month and category = the P&L
line they belong to; budget "committed" moves when a bill is approved in the UI.

## 7. Workflow state (localStorage, through `MK.store`)

Collections: `vendors`, `bills`, `batches`, `audit`, plus `prefs` (role, filters, last
route). Seeded on first load by `MK.seed.apply()`; "Reset demo data" clears and reseeds.

```
Bill    DRAFT -> SUBMITTED -> UNDER_REVIEW -> APPROVED | REJECTED ; REJECTED -> DRAFT (edit, resubmit)
        APPROVED -> IN_BATCH (batch submitted) -> PAID (UTR recorded) ; batch rejected -> back to APPROVED
Batch   DRAFT -> PENDING_RELEASE -> RELEASED -> PAID | REJECTED
Vendor  DRAFT -> VERIFYING -> VERIFIED | NEEDS_REVIEW -> APPROVED (payable) | REJECTED ; any bank-detail edit -> VERIFYING
```

Personas (fictional) and rights:

| Persona | Role | Sees | May do |
|---|---|---|---|
| Arif Merchant | Director (management) | everything | release / reject payment batches (not his own) |
| Neha Kulkarni | Finance checker | everything | review, approve, reject bills and vendors (never her own submissions) |
| Rohit Pawar | Finance maker | everything | create / submit bills, onboard and edit vendors |
| Sana Shaikh | Payer | everything | build and submit payment batches, record UTRs |
| Vikram Shetty | Outlet manager, Bandra | Bandra only, every screen and export | raise bill drafts for Bandra |
| Joseph D'Souza | Factory manager | factory only | raise bill drafts for the factory |

Rules: rejection needs a reason; only APPROVED vendors can be billed; segregation is
enforced in `MK.workflow` (UI shows the disabled action with the reason); every transition
writes an audit event (who, role, when, entity, from -> to, note, before/after for edits).
Vendor verification in this mockup: real deterministic pre-checks (GSTIN format and
checksum, PAN embedded in GSTIN, IFSC format) plus **simulated** registry and penny-drop
results, always labelled "Simulated in this mockup".

## 8. Pages (file -> route -> content). Nav groups in this order.

**Overview**
- `overview.js` -> `#/overview` - management cockpit: one hero figure (net sales for the
  period) with delta; KPI row (orders, AOV, aggregator take rate, food cost %, outlet
  EBITDA %, bills awaiting approval, payables due in 7 days); daily net-sales trend with
  event markers; outlet scorecard table (sales, growth, food cost %, EBITDA %, sparkline,
  status chip); channel mix; "Needs attention" insight list from `MK.insights`, each linking
  to the screen that explains it.

**Revenue**
- `revenue-sales.js` -> `#/revenue/sales` - explorer: outlet-wise across channels,
  channel-wise across outlets, city, medium; outlet x channel matrix; trend with grouping switch.
- `revenue-timeslots.js` -> `#/revenue/timeslots` - day-of-week x hour heatmap; slot mix by outlet and by channel; peak-hour table.
- `revenue-dishes.js` -> `#/revenue/dishes` - dish league table with inline bars; dish x channel; menu-engineering view (popularity vs contribution, labelled points); POS vs aggregator price and markup.
- `revenue-audit.js` -> `#/revenue/audit` - "Tax, markup & commission audit": channel economics waterfall (gross to net payout), contracted vs effective take rate by outlet, GST handling split (collected by aggregator vs by restaurant), payout reconciliation table with status, exception list.
- `revenue-orders.js` -> `#/revenue/orders` - last 14 days order list, channel-aware detail drawer that shows unavailable fields as "Not provided by <channel>".

**Costs**
- `costs-unit-economics.js` -> `#/costs/unit-economics` - per-outlet P&L for a month (incl. factory), side-by-side outlet comparison as % of sales with heat shading, P&L waterfall for the selected outlet, per-order economics, EBITDA % trend small multiples.
- `costs-cogs.js` -> `#/costs/cogs` - structured COGS: theoretical vs actual food cost by outlet, variance value, recipe cost cards per dish (factory items at transfer price + local items + packaging), wastage.
- `costs-budget.js` -> `#/costs/budget` - budget vs actual by category and outlet, meters, variance table, committed vs pipeline, link to the bills behind a line.

**Approvals**
- `approvals-bills.js` -> `#/approvals/bills` - status tabs, table, new-bill form (maker), review drawer (checker) with budget impact, vendor history, duplicate-invoice warning, approve / reject with reason, timeline.
- `approvals-payments.js` -> `#/approvals/payments` - approved-and-due list, build batch (payer), release (director), record UTRs, export batch as CSV (Blob download), batch timeline.
- `approvals-payables.js` -> `#/approvals/payables` - ageing buckets, due this week, overdue, by vendor and by outlet.

**Vendors**
- `vendors.js` -> `#/vendors` - list with state chips and filters; onboarding wizard with live pre-checks; simulated verification evidence panel; checker approve / override with reason; vendor profile (spend trend, bills, payment days); bank-detail edit resets verification.

**Factory**
- `factory-overview.js` -> `#/factory/overview` - factory unit economics: output, cost per kg by product (raw material / labour / utilities / overhead), transfer value, over- or under-recovery, yield, wastage, capacity utilisation, fill rate.
- `factory-production.js` -> `#/factory/production` - plan vs actual by product, yield trend, dispatch matrix product x outlet, indent vs dispatched.
- `factory-inventory.js` -> `#/factory/inventory` - raw material and finished stock, days of cover, reorder and expiry flags, price trend for key raw materials, factory payables summary.

**Banking**
- `banking.js` -> `#/banking` - current 18 accounts (bank, purpose, outlet, activity level) vs proposed consolidated structure; cost-centre tree with spend. No balances.

**System**
- `audit-trail.js` -> `#/system/audit` - filterable activity log.
- `data-sources.js` -> `#/system/data-sources` - per channel: what is pulled, by which route, how often, and what is not available; mock-data disclaimer; reset demo.
- `system-rules.js` -> `#/system/rules` - the catalogue behind "Needs attention": one card per rule (what it watches, the window, the severities, the screen it opens) with a dial on every threshold; "fires now" repaints in place and the Overview follows.

Outlet manager and factory manager see a reduced nav (only what their scope makes
meaningful); hiding is done by `MK.router` from page metadata `{roles, scopes}`.

## 9. Channel data feasibility (binding)

Read `docs/DATA-FEASIBILITY.md` - it is the authority. Summary of what it imposes: Petpooja
is the only source of gross order data (all three channels, synced daily); aggregator fees
and payouts come only from **weekly uploaded statements**, so actuals exist only for settled
periods and everything newer is an **estimate, labelled as such**; there is **no customer
data** for aggregator orders and no customer analytics anywhere; funnel, ads performance,
ratings and benchmarks are portal-only and are **not shown**; GST on aggregator orders is a
memo line (collected and paid by the aggregator under section 9(5)); every channel-data
block carries a source tag from `MK.config.sources`.

`MK.config.capabilities` = `{ fieldKey: { label, petpooja, swiggy, zomato, note } }` with
values `yes | partial | no`, populated from `docs/DATA-FEASIBILITY.md`. The engine may
compute anything internally, but **pages must check `MK.data.can(channelId, fieldKey)`
before rendering a channel-attributed field**, and show "Not provided by <channel>" (muted)
where a reader would otherwise expect it. Aggregated charts must only use measures
available for every channel included. The Data sources page renders this matrix verbatim.

## 10. Definition of done

Opens from `file://` with no console errors; every route renders for every persona; role
switch re-scopes all numbers; filters re-render every chart on the page; workflows survive
reload and reset cleanly; `node tools/check-data.js` passes; no emoji, no CDN reference, no
hard-coded colour, no dual-axis chart; nothing shown that section 9 forbids.
