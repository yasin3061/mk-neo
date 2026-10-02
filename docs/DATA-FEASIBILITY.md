# Channel data feasibility (binding)

What each sales channel can actually supply to a restaurant's ERP, researched on 18 Sep
2026 and re-checked by an independent skeptical reviewer per channel. Raw findings with
source URLs are in `docs/research-raw/{swiggy,zomato,petpooja}.json`.

**The rule:** the mockup must never attribute a data point to a channel that the channel
does not provide. When unsure, leave it out. Every tile, table and drawer that shows
channel data carries a small source tag (section 2).

## 1. How the data really arrives

| Source | What it is | Freshness | Honest label in the UI |
|---|---|---|---|
| **Petpooja POS** | The POS is the single source of *gross* order data for all three channels: in-store bills originate in it, and Swiggy / Zomato orders are relayed into it (order, items, prices, discount total, taxes, packaging, status events). It knows nothing about commissions or payouts. | Pull API is T-1 (yesterday's close). Report export is the guaranteed fallback. API access needs Petpooja's Growth plan and per-outlet credentials and is not publicly documented. | `Petpooja POS - synced daily` |
| **Swiggy payout annexure** | Weekly spreadsheet downloaded from the Swiggy partner portal and **uploaded** into the ERP. There is no settlement API. Contains per-order service fee, collection charges, GST on fees, TDS, discount shares, cancellations, complaint refunds, ads and other deductions, net payout, settlement date, bank UTR. | Period Sunday-Saturday (cut at month-end), settled the following Tuesday. | `Swiggy payout annexure - uploaded weekly` |
| **Zomato settlement report** | Same idea: weekly report **uploaded** into the ERP. Per-order commissionable value, service fee, payment mechanism fee, GST on fees, TDS, GST paid by Zomato under section 9(5), compensation / recoupment, penalties; payout-level additions and deductions (ads, Hyperpure, adjustments); UTR. | Orders Monday-Sunday, paid on or before the following Thursday. | `Zomato settlement report - uploaded weekly` |
| **ERP (this system)** | Expenses, bills, approvals, vendors, budgets, factory production batches, yields, overheads, cost per kg, stock counts. | Live | `Captured in ERP` |
| Partner dashboards (Swiggy / Zomato) | Funnel, ads performance, ratings, reviews, complaints detail, peer benchmarks, new-vs-repeat mix. **Portal only - no API, no export feed.** | - | **Not imported. Do not show.** Listed on the Data sources page as "available only inside the partner dashboard". |

Consequences the whole mockup must respect:

1. **Actual commission, fees, TDS and net payout exist only for settled weeks** (after the
   statement is uploaded). For orders in an unsettled period the ERP may show an
   **estimate at the contracted rate, labelled "Estimated"**, never an actual.
   In the demo dataset (today = Thu 17 Sep 2026):
   - Swiggy: last settled period 6-12 Sep (settled Tue 15 Sep). 13-16 Sep is unsettled -> estimated.
   - Zomato: last settled week 31 Aug-6 Sep (paid Thu 10 Sep). Week 7-13 Sep is due today
     and its report is not yet uploaded -> estimated, status "Awaiting statement". 14-16 Sep -> estimated.
2. **No customer data for aggregator orders** - no name, phone, address, locality, new vs
   repeat, cohorts, LTV. The mockup has no customer analytics at all (in-store phone capture
   covers only a minority of counter bills, so it is left out too).
3. **GST on aggregator orders is a memo line**: "5% GST collected and paid by Swiggy / Zomato
   under section 9(5)". It is never restaurant revenue and never GST payable. GST on in-store
   bills is collected by the restaurant and is payable.
4. Sales figures are **net of GST**. "Net sales" = item value + packaging charge - restaurant-funded discounts.
5. The Income-tax Act 2025 has applied since 1 Apr 2026: do not print 1961-Act section
   numbers. Use descriptive labels: "TDS by e-commerce operator (0.1%)", "TDS - rent",
   "TDS - contractor / transport", "TDS - professional fees".
6. Outlets trade past midnight (to about 3:45 am). Dashboards use a **business day of
   12:00 noon to 04:00 next morning**; payout statements use calendar weeks. The payout
   reconciliation therefore matches on order id, not on day totals.
7. Rates (commission %, fee %) are **assumed contract rates** and labelled so; real rates are confidential per outlet.

## 2. Source tags

`MK.config.sources` defines these ids; pages render them with `MK.ui.sourceTag(id)` if the
UI kit offers it, else as a muted caption.

| id | Caption |
|---|---|
| `petpooja` | Petpooja POS - synced daily (through 16 Sep) |
| `swiggy_annexure` | Swiggy payout annexure - uploaded weekly (through 12 Sep) |
| `zomato_settlement` | Zomato settlement report - uploaded weekly (through 6 Sep) |
| `erp` | Captured in ERP |
| `estimate` | Estimated at contracted rates - actuals arrive with the weekly statement |

## 3. Capability matrix (`MK.config.capabilities`)

Values: `yes`, `partial` (available with the stated limitation), `no`. `n/a` where the
concept does not apply. Pages call `MK.data.can(channelId, fieldKey)` and must not render
a `no` field as data - they render "Not provided by <channel>" where a reader would expect it.

### Order level

| fieldKey | Petpooja (in-store) | Swiggy | Zomato | Note |
|---|---|---|---|---|
| `order.id` | yes (invoice no. per outlet per day) | yes | yes | Petpooja invoice numbers are not globally unique: key on outlet + business date + invoice no. Aggregator order id kept alongside |
| `order.timestamp` | yes | yes | yes | |
| `order.status` | yes (success / cancelled / complimentary) | yes | yes | Aggregator status events as recorded by the POS |
| `order.items` | yes | yes | yes | item, qty, unit price, line total, category, veg flag |
| `order.subtotal` | yes | yes | yes | |
| `order.packagingCharge` | yes | yes | yes | |
| `order.discountTotal` | yes | yes | yes | |
| `order.discountRestaurantFunded` | yes | partial - settled weeks only (annexure); live relay discount is unsplit | yes | |
| `order.discountPlatformFunded` | n/a | partial - weekly, by campaign, in the annexure | partial - only if Petpooja stores Zomato's discount category | Omit from the mockup's order view; never reduces restaurant net |
| `order.gst` | yes - collected by restaurant, payable | memo - collected and paid by Swiggy u/s 9(5) | memo - collected and paid by Zomato u/s 9(5) | |
| `order.paymentMode` | yes (cash / card / UPI / wallet) | no | partial - prepaid vs cash-on-delivery flag only | |
| `order.customerName` | no (left out of the mockup) | no | no | |
| `order.customerPhone` | no (left out of the mockup) | no | no | |
| `order.customerAddress` | n/a | no | no | No locality, pincode, heat maps |
| `order.newVsRepeat` | no | no | no | |
| `order.prepTime` | no (needs kitchen display add-on) | partial - derived from accepted -> food-ready status times; depends on staff marking ready | partial - same | Show only as "derived from POS status times" |
| `order.riderWait` | n/a | partial - derived (arrived -> picked up) | no | Left out of the mockup |
| `order.deliveredTime` | n/a | partial - where the delivered event is relayed | partial - same | Show "where available" |
| `order.cancelReason` | yes (reason, approver) | partial - "cancelled by" only weekly from the annexure | yes (Zomato rejection / timeout reason) | |
| `order.deliveryDistance` | n/a | no (annexure only; left out) | no (settlement only; left out) | |
| `order.rating` | no | no | no | Portal only |
| `order.adAttribution` | n/a | no | no | |
| `order.feesActual` | n/a | partial - settled weeks only | partial - settled weeks only | commission / service fee, collection or payment-mechanism fee, GST on fees, TDS, order-level payout |
| `order.feesEstimated` | n/a | yes (ERP estimate, labelled) | yes (ERP estimate, labelled) | contract rate x base |

### Payout level (weekly, per outlet, per aggregator)

| fieldKey | Swiggy | Zomato | Note |
|---|---|---|---|
| `payout.period`, `payout.settlementDate`, `payout.utr` | yes | yes | UTR allows a match to the bank credit (the mockup shows the UTR, no bank feed) |
| `payout.grossValue`, `payout.restaurantDiscount`, `payout.netBillValue` | yes | yes | |
| `payout.commission` (service fee % and amount) | yes | yes | |
| `payout.collectionFee` | yes - "payment collection charges" 2% | yes - "payment mechanism fee" 1.84% | |
| `payout.gstOnFees` (18%) | yes | yes | Non-creditable for a 5% restaurant -> a real cost |
| `payout.gstRetained9_5` | yes | yes | Memo: retained and paid by the aggregator |
| `payout.tds` (0.1%) | yes | yes | A recoverable tax credit (asset), not an expense |
| `payout.tcs` | nil | nil | Show nothing |
| `payout.adsDeducted` | yes | yes | The only reconcilable ads number |
| `payout.refundsAndCancellations` | yes | yes | Complaint refunds, merchant share of cancellations, penalties; may land in a later cycle than the order |
| `payout.otherDeductions` | yes - small "other platform fees" line | yes - long-distance fee, other deductions, prior-week adjustments | Keep small; label unexplained amounts "to be disputed" |
| `payout.netPayout` | yes | yes | |

### Not imported - never show as data

Funnel (impressions, menu opens, cart, orders), ads performance (impressions, clicks /
visits, ROAS, CPC / CPV), ratings and reviews, complaint text, peer benchmarks, new vs
repeat customer mix, rider details and GPS, customer-side fees (platform fee, delivery fee,
surge, tips), payment instrument split for aggregator orders, competitor data, dish-level
ratings, any "live feed" of payouts.

### Petpooja inventory and central-kitchen module

| fieldKey | Availability | Note |
|---|---|---|
| `inv.purchases` (supplier, invoice, items, qty, price, tax) | partial | Subject to Petpooja API enablement; report export fallback |
| `inv.recipes`, `inv.theoreticalConsumption` | partial | Theoretical only; as good as recipe upkeep |
| `inv.closingStock` | partial | Book balance; physical only when counts are posted |
| `inv.wastage` | partial | Depends on staff logging |
| `inv.indents`, `inv.transfers` (factory -> outlet) | partial | Quantities and transfer value |
| Production batches, yields, factory overheads, cost per kg, actual food cost % | - | **Captured in ERP**, reconciled against Petpooja transfers. Never attributed to Petpooja |
| Rent, salaries, utilities, other overheads | - | **Captured in ERP** |

## 4. What this means for each screen

- **Sales dashboards** (outlet, channel, medium, time slot, dish): fully supported from Petpooja for all three channels. Tag `petpooja`.
- **Orders list**: item lines, amounts, status for all channels. Payment mode only for in-store (and prepaid / COD for Zomato). No customer columns. Fees column: "Actual" for settled periods, "Estimated" otherwise.
- **Tax, markup and commission audit**: waterfall and take rates use **settled periods only** for actuals, with the unsettled tail shown separately as estimated. Payout reconciliation lists weekly cycles per outlet per aggregator with statuses Matched / Short paid / Disputed / Awaiting statement. Markup audit compares POS menu price with aggregator menu price per outlet (both prices are the restaurant's own data).
- **Data sources page**: renders section 1 and section 3 verbatim, plus an "Upload statement" affordance (non-functional button with a note) so the weekly upload step is visible.
