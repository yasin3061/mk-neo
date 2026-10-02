# Research digest and binding model parameters

Distilled on 18 Sep 2026 from six researched and independently re-checked topics (raw JSON
with source URLs: `docs/research-raw/`). Where the public record was silent the value is an
**assumption** and is marked (A). These numbers are starting parameters for the generator;
tune *parameters* (never patch outputs) until the calibration targets in section 9 hold.

## 1. The brand, as publicly visible

- Miya Kebabs: kebab / shawarma QSR, launched 2021 (parent: Al Arabian Express, Nashik).
  Public outlets: Bandra (Pali Hill), Andheri West (Oshiwara), Fort, Kalyan West, Koregaon
  Park and Baner (Pune). The mockup shows **five**: the four Mumbai-region outlets plus
  Koregaon Park (client decision).
- No public mention of a central kitchen. The **factory is the client's internal fact**:
  show it as "Factory (Central Kitchen)", city Mumbai, with no street address.
- Trading is evening and late-night led. Hours: Bandra 17:00-03:45, Andheri 12:45-03:00,
  Fort 12:45-03:30, Kalyan 13:00-23:45, Koregaon Park 12:30-02:00 (A).
  **Business day = 12:00 to 04:00 next morning**; hour buckets 12..27 (24 = midnight, 27 = 3 am).
- **No biryani on any current menu. Rolls are sold only in Pune.** No beverages on aggregator menus.
- Relative delivery volume (rank only): Andheri > Bandra > Koregaon Park ~ Kalyan ~ Fort.
- Aggregator menu prices are 40-67% above the dine-in card on hero items and only 5-25% on
  low-ticket items. Kalyan has its **own, lower aggregator price list**. Zomato prices are
  not publicly visible; assume Zomato = Swiggy (A).
- Do not put brand-story text, founder names, ratings or "bestseller" badges in the mockup.

## 2. Outlets (parameters)

| id | Display name | City | Sq ft | Seats | Opened | Hours (business day) | Electricity | Steady monthly net sales | Stream mix of net sales (dine-in / takeaway / Swiggy / Zomato) |
|---|---|---|---|---|---|---|---|---|---|
| bandra | Bandra | Mumbai | 450 | 18 | Dec 2021 | 17-27.75 | Mumbai licensee | ~Rs 28 L | 28 / 17 / 17 / 38 |
| andheri | Andheri | Mumbai | 650 | 28 | Mar 2024 | 12.75-27 | Mumbai licensee | ~Rs 31 L | 17 / 12 / 38 / 33 |
| fort | Fort | Mumbai | 500 | 24 | Aug 2024 | 12.75-27.5 | Mumbai licensee | ~Rs 21 L | 22 / 28 / 20 / 30 |
| kalyan | Kalyan | Kalyan (Mumbai region) | 500 | 26 | Jun 2023 | 13-23.75 | MSEDCL | ~Rs 19 L | 26 / 14 / 25 / 35 |
| koregaon | Koregaon Park | Pune | 400 | 8 | Jul 2025 | 12.5-26 | MSEDCL | ramps ~Rs 13 L (Apr) to ~Rs 20 L (Sep) | 6 / 9 / 40 / 45 |
| factory | Factory (Central Kitchen) | Mumbai | 2,500 | - | 2023 | - | Mumbai licensee | no sales | - |
| ho | Head office | Mumbai | - | - | - | - | - | no sales (cost centre) | - |

Network: roughly Rs 1.15-1.25 crore net sales a month, 700-800 orders a day.
"City" reporting: Mumbai region (Bandra, Andheri, Fort, Kalyan) vs Pune (Koregaon Park).

Characters the data must show (emergent from parameters):

- **Andheri** - biggest sales, delivery-led, highest aggregator ads (about 5.5% of aggregator
  menu value) and discounts (about 10-12%): effective take rate far above contract, EBITDA thin.
- **Bandra** - evening-only, strongest dine-in and Zomato, best EBITDA %; rent per sq ft is the watch item.
- **Fort** - office district: relatively strong weekday lunch and takeaway, weak Sundays and
  late evenings relative to others; rent is about 12-13% of sales, EBITDA low.
- **Kalyan** - lower price list and rent; **actual food cost 3-4 points above theoretical**
  (wastage and portioning); strongest Shravan / Ganeshotsav dip; closes before midnight.
- **Koregaon Park** - delivery-led, ramping from loss to small profit; supplied from the
  Mumbai factory on alternate days, so logistics per kg is high and fill rate lower; sells rolls.

## 3. Menu (12 items) and price lists

Prices in Rs. "Std agg" applies to Bandra, Andheri, Fort and Koregaon Park on both aggregators.

| id | Dish | Category | Veg | POS | Std agg | Kalyan agg | Notes |
|---|---|---|---|---|---|---|---|
| angara_shawarma | Angara Chicken Shawarma | Shawarma | no | 185 | 309 | 275 | volume leader on delivery and counter |
| bc_shawarma | Butter Chicken Shawarma | Shawarma | no | 220 | 340 | 305 | |
| paneer_shawarma | Angara Paneer Shawarma | Shawarma | yes | 185 | 309 | 275 | |
| changezi_tikka | Chicken Changezi Tikka | Signature kebabs | no | 390 | 540 | 510 | served with masala naan; top-rated delivery item |
| kashmiri_tikka | Chicken Kashmiri Tikka | Signature kebabs | no | 390 | 540 | 510 | |
| angara_tikka | Chicken Angara Tikka | Classic kebabs | no | 290 | 465 | 390 | |
| chicken_seekh | Chicken Seekh Kebabs | Seekh kebabs | no | 280 | 410 | 410 | |
| mutton_seekh | Mutton Seekh Kebabs | Seekh kebabs | no | 450 | 560 | 595 | low markup: aggregator net realisation falls below the POS price |
| butter_chicken | Butter Chicken | Gravy | no | 390 | 599 | 550 | |
| zaatar_hummus | Za'atar Naan with Hummus | Appetisers | yes | 420 | 540 | 545 | |
| butter_naan | Butter Naan | Breads | yes | 65 | 70 | 85 | attach item on most kebab and gravy orders; very low markup |
| bc_roll | Butter Chicken Roll | Rolls | no | 240 (A) | 340 | - | **Koregaon Park only** |

Seeded markup anomaly: on 1 Aug 2026 the POS price of Mutton Seekh Kebabs rose 450 -> 480
(mutton cost), but the aggregator list price was not updated. The markup audit must flag
it by rule (markup below the outlet's effective aggregator take rate).

AOV targets (emergent, check in calibration): delivery gross about Rs 600-680 (Kalyan about
Rs 560-600), after restaurant-funded discount about Rs 540-610; in-store blended about Rs
430-520 (counter / takeaway tickets Rs 250-400, dine-in tables Rs 650-1,000).
Packaging charge to the customer on delivery and takeaway: Rs 10-25 per order (A).

## 4. Channel terms (assumed contract rates - label them "assumed" in the UI)

| | Swiggy | Zomato |
|---|---|---|
| Service fee / commission | 22% (Koregaon Park 24%) | 22% (Koregaon Park 24%) |
| Fee base | item total + packaging - restaurant-funded discount + 5% GST | item total + packaging - restaurant-funded discount (commissionable value) |
| Collection / payment mechanism fee | 2.00% of the same base | 1.84% of order value |
| GST on all aggregator fees and ads | 18% (non-creditable, a real cost) | 18% |
| TDS by e-commerce operator | 0.1% of net bill value excl. taxes (recoverable asset, not an expense) | same |
| TCS | nil | nil |
| Other | small "other platform fees" about 0.3% of base | long-distance fee Rs 20-40 on about 8% of orders |
| Cycle | Sunday-Saturday, cut at month-end; settled following Tuesday | Monday-Sunday; paid by following Thursday |
| Refunds / cancellation recoveries | about 0.8% of channel net sales, often one cycle late | same |

Ads deducted from payouts (share of aggregator menu value): Andheri 5.5%, Koregaon Park 6%,
Kalyan 4%, Bandra 3%, Fort 3%. Restaurant-funded discounts on aggregators (share of menu
value): Andheri 11%, Koregaon Park 11%, Kalyan 8%, Bandra 6%, Fort 6%; in-store 1-2%.
Cancellation rate: aggregators 1.5-3% (higher on heavy-rain days), in-store about 0.5%.
In-store payment mix (A): UPI 62%, card 18%, cash 20%. Card MDR about 0.9% (A); UPI zero.

Seeded audit exceptions (generated and detected by rule):
1. Zomato charged 24% instead of the contracted 22% at Fort for the weeks 3-9 Aug and 10-16 Aug.
2. Swiggy period 23-29 Aug at Bandra short-paid by an unclassified deduction of about Rs 14,800 -> status Disputed.
3. Koregaon Park Swiggy ads deduction doubled in the period 30 Aug-5 Sep.

## 5. Outlet cost parameters (monthly, Rs, before tuning)

Food cost: network theoretical about 33-34% of net sales = factory transfers about 23% + local
purchases about 10.5% (khubz / rumali bread, vegetables, dairy top-ups, soft drinks, oil).
Actual = theoretical + variance: Bandra +0.8, Andheri +1.2, Fort +1.0, Koregaon Park +1.5,
**Kalyan +3.6** points. Above 38% is a red flag.

| Line | Bandra | Andheri | Fort | Kalyan | Koregaon Park | Basis / source |
|---|---|---|---|---|---|---|
| Rent | 2,70,000 | 2,15,000 | 2,60,000 | 47,500 | 92,000 | Rs/sq ft 600 / 330 / 520 / 95 / 230 (C&W + Sept-2026 listings) |
| GST on rent (non-creditable) | 18% | 18% | 18% | 18% | 18% | 5% restaurant without ITC: input GST is a cost |
| CAM / society | 6,000 | 7,000 | 8,000 | 3,000 | 4,000 | (A) |
| Headcount | 18 | 18 | 16 | 14 | 11 | roles below |
| Electricity kWh (base month) | 3,000 | 4,200 | 3,200 | 3,000 | 2,400 | x season: Apr 1.10, May 1.18, Jun 1.08, Jul 0.98, Aug 0.97, Sep 1.00 |
| LPG cylinders (19 kg) | 9 | 12 | 8 | 8 | 6 | x price series below |
| Charcoal | 15,000 | 18,000 | 12,000 | 12,000 | 8,000 | about Rs 40-60/kg (A) |
| Water | 2,500 | 3,000 | 2,500 | 2,000 | 2,000 | |
| Housekeeping and consumables (tissue paper, cleaning chemicals, gloves, foil, garbage bags) | about 0.6% of net sales | | | | | (A) |
| Delivery / takeaway packaging | Rs 16 per delivery order, Rs 7 per takeaway order | | | | | sourced range Rs 8-25 |
| Repairs and maintenance | about 1.5% of sales, lumpy; Kalyan compressor failure Rs 68,000 in Aug | | | | | |
| Local marketing | 1.5% | 1.2% | 1.0% | 1.5% | 2.5% | |
| Pest control / waste | 2,500 / 2,000 | same | same | same | same | |
| POS + internet | 2,900 | same | same | same | same | Petpooja about Rs 20,000/yr + internet Rs 1,200/mo |
| Licences + insurance | 3,500 | same | same | same | same | annual costs spread monthly |
| Petty cash / misc | 8,000 | 9,000 | 7,000 | 6,000 | 5,000 | |
| Staff meals | Rs 2,200 per head | | | | | (A) |
| Staff accommodation | 25,000 | 25,000 | 20,000 | 0 | 15,000 | (A) |
| Factory logistics allocation | by kg dispatched; Koregaon Park also bears the Pune run | | | | | |
| Depreciation (below EBITDA, show separately) | 18,000 | 24,000 | 20,000 | 16,000 | 22,000 | |

Wages (gross monthly, Mumbai 2026; floor = Maharashtra minimum wage about Rs 14,700-15,900):
outlet manager 35,000; cashier 17,500; tandoor / kebab cook 24,000; shawarma cook 21,000;
commis 18,500; helper / packer 15,500; cleaner 15,000. Employer on-costs about 20% of gross
(PF about 13% on capped base, ESIC 3.25%, bonus 8.33%); statutory bonus is accrued monthly.

Tariffs: electricity all-in about **Rs 10.5/kWh** (Mumbai licensees) and **Rs 12.9/kWh**
(MSEDCL: Kalyan, Pune). Commercial LPG 19 kg cylinder, Mumbai, 2026 (Rs): Apr 2,031; **May
3,024; Jun 3,067.5**; Jul 2,885.5; Aug 2,691.5; Sep 2,701 (Jan was 1,642.5). The May jump is
a real cost event: gas budgets set in March are blown from May onward.

Calibration targets (outlet EBITDA % of net sales, Jul-Aug steady state): Bandra 15-18,
Andheri 8-11, Fort 5-8, Kalyan 6-9, Koregaon Park about -6 in Apr rising to +5 to +8 by Sep.
Aggregator net realisation 52-62% of menu value. Rent % of sales: Bandra 9-10, Fort 12-13.
Company EBITDA after factory variance and head office: 5-9%.
Head office (cost centre `ho`): about Rs 4.2 L a month (accounts team, operations head,
HR / admin, software, CA retainer Rs 45,000, small office).

## 6. Demand model parameters

- Hour profile (share of a normal day; outlets clip to their own hours): 12-16 lunch about 20%
  (Fort weekdays about 32%), 16-19 about 14%, 19-23 dinner about 46%, 23-04 late night about 20%
  (Andheri and Bandra higher, Kalyan nil after 23:45). Aggregators skew later than in-store.
- Day of week: Mon-Thu 1.00, Fri 1.15, Sat 1.35, Sun 1.30. Fort: Sat 0.95, Sun 0.70.
  Kalyan: Tue and Thu 0.93.
- Month: days 1-7 +6%, last week -4% (stronger in Kalyan).
- Events 2026: IPL to 31 May (delivery +12% 19-23h, +18% at weekends); **Bakri Eid 27-28 May**
  (+35%, mutton items up sharply); monsoon from about 8 Jun: heavy-rain days 23 Jun, 7 Jul, 8
  Jul, 4 Aug, 19 Aug, 2 Sep (delivery +22%, in-store -35%, cancellations up) and **21 Jul
  extreme** (everything -40%, cancellations spike); **Shravan 13 Aug-11 Sep** (Kalyan and
  Koregaon Park -15%, others -7%); **Ganesh Chaturthi 14 Sep** (Kalyan / Koregaon Park -35%,
  others -20%), 15-16 Sep still muted; Independence Day 15 Aug +10%.
- Koregaon Park ramp: about +7% a month Apr -> Aug, then flat. Other outlets about +1% a month.
- Noise: day-level about +/-6%, plus Poisson at the order level.

## 7. Factory (central kitchen) parameters

Standard-cost transfer pricing: **transfer price = standard raw-material cost per kg +
standard conversion Rs 70 per kg**. Variances stay at the factory (cost centre; result =
over- or under-absorption, normally within +/-3% of transfer value). About 480 kg a day
dispatched, about 14,500 kg a month, transfer value about 23% of network net sales.

| SKU | Product | Std RM cost Rs/kg | Std yield (output / input) | Shelf life | Used in |
|---|---|---|---|---|---|
| FP01 | Marinated chicken tikka, red (Angara / Kashmiri / Changezi base) | 275 | 120% | 72 h | tikkas |
| FP02 | Shawarma chicken, marinated | 262 | 115% | 72 h | shawarmas, roll |
| FP03 | Chicken seekh mix | 258 | 106% | 48 h | chicken seekh |
| FP04 | Mutton seekh mix | 660 | 108% | 48 h | mutton seekh |
| FP05 | Makhani gravy base | 175 | 88% | 96 h | butter chicken, BC shawarma, roll |
| FP06 | Marinated paneer | 330 | 118% | 72 h | paneer shawarma |
| FP07 | Hummus | 145 | 210% (chickpea hydration) | 96 h | za'atar hummus |
| FP08 | Toum / garlic sauce | 200 | 100% | 120 h | shawarmas |
| FP09 | Naan dough, portioned | 36 | 160% | 48 h | naan, masala naan, za'atar naan |

Raw-material price series (Rs/kg unless stated; Apr -> Sep): boneless chicken thigh 268, 282,
290, 284, **262, 255** (softens in Shravan); mutton mince 748, 755, 765, 772, 780, 785;
paneer 320-335; onion 25, 24, 28, 38, **52, 55** (monsoon spike); tomato 20-35; refined oil
172-185 per litre; curd 78-84; cream 240-249 per litre; butter 570-630; maida 40-43;
chickpeas 105-118; cashew (broken) 640-700; LPG as above.

Seeded factory stories: chicken seekh mix yield falls from 106% to about 99% during August
(detected as a yield variance); purchase-price variance turns favourable Aug-Sep on chicken
and unfavourable on onions; gas under-absorption May-Jul; capacity utilisation 68-82%;
fill rate Mumbai outlets 97-99%, **Koregaon Park 92-95%** (alternate-day supply).

Factory monthly costs (Rs, before tuning): rent 2,25,000 (+18% GST); payroll 15 staff about
4,20,000 + 20% on-costs (production head 70,000; 2 CDP 35,000; 5 commis 18,500; 4 helpers
15,500; storekeeper 27,000; purchase / dispatch 27,000; QA and hygiene 30,000; 2 drivers
21,500); electricity about 9,500 kWh + demand charge about Rs 1.1 L; gas 35 cylinders x price;
2 refrigerated vans rented 35,000 each + fuel / tolls 25,000 each; Pune run extra about
45,000; repairs / AMC 10,000; lab, pest, licence 16,000; water and waste 15,000; production
consumables 1.5% of transfer value; admin 20,000; depreciation 65,000 (below EBITDA).

KPIs to present: output kg, cost per kg by SKU split RM / labour / utilities / overhead,
yield vs standard, wastage % (target 1.5-3%), production plan adherence (95-100%), fill
rate / OTIF, capacity utilisation, inventory days (fresh 1-3, frozen 7-10, dry 15-30),
expiry write-offs (< 0.5%), purchase price variance, over- / under-absorption, factory cost
as % of network sales (about 8-9%). Vendor credit: meat and vegetables 0-7 days, dairy 7,
dry goods and packaging 15-30, services 30.

## 8. Master data to invent (fictional, plausible, no emojis)

- About 28 vendors across: poultry, mutton, dairy, vegetables, dry goods and spices, oil,
  packaging, charcoal, LPG distributors, landlords (one per unit), pest control, waste,
  refrigeration AMC, internet, POS subscription, CA firm, housekeeping supplies, staff
  accommodation, refrigerated van rental, lab testing, printing / marketing, insurance,
  plus utility billers (electricity, water: type "utility", no bank details, no verification).
  GSTINs synthetic but format-valid with a correct checksum and state code 27; PANs
  fictional; bank accounts masked; IFSC format-valid. One vendor has a low bank-name match.
- 18 current-state bank accounts across several banks (one or more per outlet, legacy
  accounts, a salary account, a tax account) with purpose, unit, activity level (transactions
  a month) and a keep / merge / close recommendation; target structure of 3-4 accounts in one
  bank. **No balances, no account numbers beyond a masked last four.**
- Cost-centre tree: Company -> Mumbai region (Bandra, Andheri, Fort, Kalyan) / Pune
  (Koregaon Park) / Factory / Head office -> departments (Kitchen, Service, Delivery desk;
  Production, Stores, Dispatch; Finance, Admin).

## 9. Reconciliation and calibration checks (`tools/check-data.js` must assert these)

1. Sum of net sales by outlet = by channel = by medium = by dish = by hour = grand total (to the rupee).
2. Orders in `recentOrders` aggregate exactly to the cube for those days.
3. Settled payout cycles: sum of order-level actual fees = the cycle's statement lines; net payout = net bill value - fees - GST on fees - TDS - ads - refunds - other deductions.
4. Outlet factory-sourced COGS at transfer price = factory dispatch value to that outlet (period totals).
5. Factory: RM consumed x price + conversion costs = total cost; transfer value - total cost = absorption variance.
6. Seeded bills by unit x category x month sum to the matching P&L ledger lines; approving a bill moves budget "committed".
7. Calibration bands in sections 3, 5 and 7 hold (AOV, EBITDA %, food cost %, net realisation, fill rate, utilisation).
8. Determinism: two runs produce identical hashes. Build time under 600 ms in Node.
9. Scope: with the Bandra manager persona every selector returns Bandra-only figures; with the factory manager, sales selectors return empty results without throwing.
