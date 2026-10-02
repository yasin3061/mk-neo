# Workflow and audit API (`js/data/workflow.js`)

`MK.workflow` (bills, payment batches, vendors) and `MK.audit`, per SPEC section 7. Everything below was
captured from a Node run of the shipped code. The file needs `js/core/kernel.js`; `MK.config` (categories,
bank accounts, units, vendor master, budget policy) and `MK.finance.budget` are feature-detected. It writes
only the `MK.store` collections `vendors`, `bills`, `batches`, `audit` and the key `prefs.workflowClock`.

## 1. Conventions

- Every transition returns `{ ok: true, record }` or `{ ok: false, error }` and **never throws**. Form-style
  validation failures add `fields: { fieldName: message }` (the first message is `error`). A no-op edit returns
  `{ ok: true, record, unchanged: true }` and writes nothing.
- Checks run in this order and nothing is written until all pass: record exists -> **permission** (role, unit scope,
  segregation of duties - judged by `MK.session.can`, whose `reason` text is returned as is) -> **state** -> inputs.
- One call is one unit of work: all records and audit events it touches are flushed together, one store write per
  collection. Records are copy-on-write; `record` in the result is the stored object - treat it as read-only.
- Money is whole rupees (`Math.round` on input). Dates are `YYYY-MM-DD`, timestamps `YYYY-MM-DDTHH:MM`.
- Status field names: bills and batches use **`status`**, vendors use **`state`**.
- Reads (`list`, `get`, `counts`, `MK.audit.list`, ...) are scoped to `MK.session.allowedUnitIds()` at call time. A bill is
  visible when its unit is allowed; a vendor when it serves at least one allowed unit; a batch (and its events, which carry
  totals) only when every unit in it is allowed. Finance, seed and check code that needs everything reads
  `MK.store.coll('bills').all()` directly.
- Optional last argument of every transition, **for the seeder only**: `{ actorId, at, audit }`.
  `actorId` = acting persona (permission is checked for that persona with the same kernel rules); `at` = timestamp
  (`'YYYY-MM-DD'` means 10:00 that day); `audit: false` skips the audit event (vendors still keep their embedded history).
  Without it the actor is `MK.session.current()` and the time is the **demo clock**: `MK.calendar.today` + a time of day
  that starts at 10:00 (or one minute after the latest event already stamped today), advances one minute per successful
  action and is kept in `prefs.workflowClock = { date, minute }`. "Reset demo" clears it with the rest of the store.
- `MK.workflow.bulk(fn)` runs many transitions as one unit of work (one write per collection at the end). If `fn` throws,
  nothing is written and the error is rethrown. Use it for seeding; a failing transition inside it leaves no partial writes.

```js
MK.workflow.bulk(function () {
  var o = { actorId: 'u_maker', at: '2026-04-01T10:15' };
  MK.config.vendors.forEach(function (m) {
    MK.workflow.vendor.create(m, o);                       // id and nameMatch of the master are honoured; state always starts at DRAFT
    if (m.state === 'DRAFT') return;
    MK.workflow.vendor.submit(m.id, o);                    if (m.state === 'VERIFYING') return;
    MK.workflow.vendor.runVerification(m.id, o);           // v_print lands in NEEDS_REVIEW (name match 38%), all others VERIFIED
    if (m.state === 'APPROVED') MK.workflow.vendor.approve(m.id, { actorId: 'u_checker', at: '2026-04-01T15:00' });
  });
});
```

The shipped seed (`js/data/seed.js`, described in docs/API.md section 5) replays 33 vendors and 683 bills (40 payment batches) through these transitions in about
140 ms and keeps bill and batch audit rows from 1 Sep 2026 only (1,225 events; 1.14 MB stored in all). Earlier measurements with a throw-away
data set, in Node 24: the 32 master vendors seed in 13 ms; 1,441 bills taken through create -> submit -> approve ->
batch -> release -> paid (23 batches, 8,825 audit events) seed in about 150-170 ms, identical on every run. That much audit
is 3.4 MB of JSON (bills 0.9 MB, vendors 0.1 MB) - too close to the localStorage quota. **Seed old history with
`audit: false`** (timelines stay complete, see `MK.audit.trail`): with audit kept for the last five weeks only it is 1,608
events / 0.6 MB. Interactive actions against that large store take 25-30 ms (almost all of it the kernel serialising
the collections); `bill.list` / `counts` about 1 ms, `MK.audit.list` 2-3 ms.

## 2. Record shapes

### Bill (`bills`)

```js
{ id: 'BILL-2609-0001', number: 'BILL-2609-0001',   // same string today: key on id, display number. BILL-<yy><mm of creation>-<4-digit running no. in that month>
  unitId: 'bandra', vendorId: 'v_ll_bandra', categoryId: 'rent',             // categoryId must apply to the unit type (MK.config.expenseCategories[].units)
  invoiceNo: 'PHR/26-27/0612', invoiceDate: '2026-09-01', dueDate: '2026-09-11',   // dueDate defaults to invoiceDate + vendor.creditDays (landlords: 10)
  monthKey: '2026-09',       // expense month the cost belongs to; defaults to the invoice month (a utility bill dated 6 Sep for August carries '2026-08')
  description: 'Shop rent, September 2026',
  amount: 270000,            // taxable value, before GST
  gstAmount: 48600,          // the bill COSTS amount + gstAmount: a 5% restaurant takes no input credit (see expenseParts below)
  lines: [{ categoryId: 'rent', amount: 270000 }, { categoryId: 'rent_gst', amount: 48600 }],   // optional expense lines, else null - see below
  tdsLabel: 'TDS - rent',    // 'TDS - rent' | 'TDS - contractor / transport' | 'TDS - professional fees' | null - never a section number
  tdsAmount: 27000,
  payable: 291600,           // = amount + gstAmount - tdsAmount, recomputed on every save
  attachments: [{ name: 'PHR-0612.pdf' }],
  status: 'PAID',            // DRAFT | SUBMITTED | UNDER_REVIEW | APPROVED | REJECTED | IN_BATCH | PAID
  createdBy: 'u_om_bandra', createdAt: '2026-09-17T10:00',
  submittedBy: 'u_om_bandra', submittedAt: '2026-09-17T10:01',
  reviewedBy: 'u_checker', reviewedAt: '2026-09-17T10:02',   // who took it up for review and when (a decision on a SUBMITTED bill reviews it in the same minute); cleared on resubmission
  decidedBy: 'u_checker', decidedAt: '2026-09-17T10:02',     // approve or reject; cleared on resubmission
  rejectionReason: null,     // kept while the maker corrects the bill; cleared on resubmission
  batchId: 'PB-2609-01',     // set as soon as a DRAFT batch reserves the bill; null again if the bill is removed or the batch is rejected
  paidAt: '2026-09-17T10:06', utr: 'HDFCN26260917001',        // paidAt = when the bank reference was recorded
  paidOn: '2026-09-17',      // the payment date = the day the batch was released to the bank; compare THIS with dueDate (absent until PAID)
  notes: '',
  flags: [] }                // 'DUPLICATE_INVOICE' | 'POSSIBLE_DUPLICATE', evaluated on create, update and submit (labels: MK.workflow.bill.FLAGS)
```

The budget month of a bill is its `monthKey` (the expense month; the month of `invoiceDate` unless the bill says otherwise - billers invoice
after the month has closed). **What a bill costs is `amount + gstAmount`**: the restaurant pays GST at 5% without input tax credit, so the GST on
a purchase is part of its cost, and the ledger line a seeded bill belongs to is that all-in figure (LPG: the cylinder price already includes its
18%). TDS only changes who is paid. `MK.workflow.bill.expenseParts(bill)` returns the cost by category, and `MK.finance.budget` reads bills by the
same rule. `lines` is the optional allocation: the first line repeats the bill's own category and amount, further lines send GST to a category of
its own and may add up to at most `gstAmount` (rent invoices: `rent` + `rent_gst`); GST the lines leave unallocated stays with the bill's own
category. An edit that changes unit, category, amount or GST without restating `lines` drops them.

Limits on what a form may send (every action re-serialises whole collections into localStorage): `invoiceNo` 40 characters, `description` and
`notes` 500 each, reasons 3 to 500 characters of typed text (an object or a number is not a reason), `amount` up to Rs 5 crore, `gstAmount` up to
28% of `amount`, `invoiceDate` from the start of the financial year to today, `monthKey` from April of the financial year to the current month,
`dueDate` at most 180 days after the invoice date.
Shared vocabulary for the finance layer:
`MK.workflow.bill.COMMITTED_STATES = ['APPROVED','IN_BATCH','PAID']`, `PIPELINE_STATES = ['SUBMITTED','UNDER_REVIEW']`,
`PAYABLE_STATES = ['APPROVED','IN_BATCH']` (approved and not yet paid).

### Batch (`batches`)

```js
{ id: 'PB-2609-01', number: 'PB-2609-01',          // PB-<yy><mm of creation>-<2-digit running no. in that month>
  bankAccountId: 'ba01',                           // an id of MK.config.bankAccounts.current or .target; defaults to the first current account
  billIds: ['BILL-2609-0001'], unitIds: ['bandra'],   // unitIds = distinct units of the bills (drives scope)
  total: 291600,                                   // sum of the bills' payable, recomputed on every change
  status: 'PAID',                                  // DRAFT | PENDING_RELEASE | RELEASED | PAID | REJECTED
  createdBy: 'u_payer', createdAt: '2026-09-17T10:03', submittedBy: 'u_payer', submittedAt: '2026-09-17T10:04',
  releasedBy: 'u_director', releasedAt: '2026-09-17T10:05',
  rejectedBy: null, rejectedAt: null, rejectionReason: null,
  paidBy: 'u_payer', paidAt: '2026-09-17T10:06',
  utr: 'HDFCN26260917001' }                        // null when UTRs were recorded per bill (they are on the bills)
```

### Vendor (`vendors`)

The master fields of `MK.config.vendors` plus workflow fields. Only a masked account number is ever stored.

```js
{ id: 'v_print',                       // master id, or 'v_' + slug of the name for vendors created in the UI
  name, type: 'vendor' | 'utility', category, unitIds: [...], creditDays: 30, pan, gstin, bankName, ifsc,
  bankAccountMasked: 'XXXXXXXX8846', accountHolderName: 'Imtiyaz R Khan', expenseCategoryIds: [...], tdsLabel: null,
  contactName: null, email: null, phone: null, address: null,
  nameMatch: 38,                       // last penny-drop name match, 0-100; null until verified and after any bank-detail edit
  state: 'NEEDS_REVIEW',               // DRAFT | VERIFYING | VERIFIED | NEEDS_REVIEW | APPROVED | REJECTED
  verification: {
    preChecks: { ok: true, applicable: true, failed: [],
      checks: [{ id: 'pan_format', label: 'PAN format', ok: true, skipped: false, detail: 'Valid format - holder type: Individual / proprietor' }, ...] },
    gstin: { applicable: true, gstin, legalName: 'INKWELL PRINT AND MEDIA', tradeName, status: 'Active' | 'Cancelled',
             taxpayerType: 'Regular' | 'Composition', constitution: 'Individual / proprietor', stateCode: '27', stateName: 'Maharashtra',
             registeredOn: '2020-06-20', source: 'GST registry lookup - simulated in this mockup', simulated: true },   // { applicable: false, note, simulated } without a GSTIN
    bank: { ifsc, bankName, accountMasked, accountStatus: 'Active', registeredName: 'IMTIYAZ R KHAN', nameMatchScore: 0.38, threshold: 0.85,
            method: 'Penny drop (Re 1 credit) - simulated in this mockup', reference: 'PD29774657', simulated: true },
    outcome: 'NEEDS_REVIEW',           // 'VERIFIED' | 'NEEDS_REVIEW' | null (not run, or reset by an edit)
    reasons: ['Bank account name match is 38%, below the 85% threshold (account held as IMTIYAZ R KHAN)'],
    runAt: '2026-04-01T11:05', runBy: 'u_maker',
    simulated: true },                 // always true - show MK.workflow.SIMULATED_NOTE ('Simulated in this mockup') next to gstin / bank
  createdBy, createdAt, updatedBy, updatedAt, approvedBy, approvedAt, rejectedBy, rejectedAt, rejectionReason, overrideReason,
  history: [{ at, actorId, actorName, action: 'vendor.create', from: null, to: 'DRAFT', note, changes? }, ...] }
```

Pre-check ids: `pan_format`, `gstin_format`, `gstin_checksum` (mod-36 check character), `gstin_state`, `pan_in_gstin`
(PAN = GSTIN characters 3-12), `ifsc_format`, `ifsc_bank` (bank code against the bank name; skipped for codes outside the
reference list), `account_format` (9-18 digits raw, or the stored masked form). Without a GSTIN the GSTIN checks are skipped
(unregistered vendor). Utilities: `{ ok: true, applicable: false, checks: [] }` and verification passes without registry or bank data.

### Audit event (`audit`)

```js
{ id: 'AUD-000017', at: '2026-09-17T10:06', actorId: 'u_payer', actorName: 'Sana Shaikh', role: 'payer', roleLabel: 'Payer',
  entity: 'bill',                      // 'bill' | 'batch' | 'vendor' | 'system'
  entityId: 'BILL-2609-0001', entityLabel: 'BILL-2609-0001 - Pali Hill Realty LLP',
  unitId: 'bandra',                    // bills; null for batches and vendors, which carry unitIds: [...] instead
  action: 'bill.paid', actionLabel: 'Payment recorded', from: 'IN_BATCH', to: 'PAID',
  note: 'UTR HDFCN26260917001, payment batch PB-2609-01',
  changes: [],                         // edits: [{ field, before, after }]
  refId: 'PB-2609-01' }                // only on bill events driven by a batch
```

Actions: `bill.create update submit review approve reject reopen inBatch batchRejected paid` (+ derived `bill.released`),
`batch.create addBill removeBill submit release reject markPaid`,
`vendor.create update bankChange taxChange submit verify approve override reject`. Labels: `MK.workflow.labels.action`.

## 3. State machines (`MK.workflow.<entity>.TRANSITIONS`)

Bill

| transition | from | to | kernel right | notes |
|---|---|---|---|---|
| `update` | DRAFT, REJECTED | DRAFT | `bill.edit` (own bills only, except the finance maker) | editing a rejected bill reopens it; refused while `batchId` is set |
| `submit` | DRAFT | SUBMITTED | `bill.submit` (own only, except maker) | re-validates; vendor must still be APPROVED; refreshes flags; clears the previous decision |
| `startReview` | SUBMITTED | UNDER_REVIEW | `bill.review` | segregated from `createdBy` and `submittedBy` |
| `approve` | UNDER_REVIEW | APPROVED | `bill.approve` | segregated; vendor must be APPROVED; note mandatory when another live bill has the same vendor invoice number |
| `reject` | UNDER_REVIEW | REJECTED | `bill.reject` | segregated; reason mandatory (3+ characters) |
| `reopen` | REJECTED | DRAFT | `bill.edit` | no field change |
| `enterBatch` | APPROVED | IN_BATCH | - | by `batch.submit` |
| `leaveBatch` | IN_BATCH | APPROVED | - | by `batch.reject`; `batchId` cleared |
| `pay` | IN_BATCH | PAID | - | by `batch.markPaid`; sets `utr`, `paidAt` |

`approve` / `reject` called on a SUBMITTED bill first take it up for review as the same actor (both steps validated up
front, two audit events, one timestamp), so a page may skip `startReview`.

Batch: SPEC's `RELEASED -> PAID | REJECTED` is read as: the director either releases or rejects a pending batch; a released batch can only be paid.

| transition | from | to | kernel right | notes |
|---|---|---|---|---|
| `edit` (`addBill`, `removeBill`) | DRAFT | DRAFT | `batch.create` | |
| `submit` | DRAFT | PENDING_RELEASE | `batch.submit` | at least one bill; every bill APPROVED, reserved by this batch, vendor APPROVED; bills -> IN_BATCH |
| `release` | PENDING_RELEASE | RELEASED | `batch.release` | segregated from `createdBy` / `submittedBy`; refused while any vendor in it is not APPROVED; bills stay IN_BATCH |
| `reject` | PENDING_RELEASE | REJECTED | `batch.reject` | segregated; reason mandatory; bills -> APPROVED with `batchId: null` |
| `markPaid` | RELEASED | PAID | `batch.markPaid` | one UTR for the batch or one per bill; bills -> PAID |

Vendor

| transition | from | to | kernel right | notes |
|---|---|---|---|---|
| `update` | any | unchanged | `vendor.edit` | non-sensitive fields |
| `sensitiveEdit` (inside `update`) | VERIFYING, VERIFIED, NEEDS_REVIEW, APPROVED, REJECTED | VERIFYING | `vendor.edit` | **any change to bank account, IFSC, bank name or account holder** clears `verification.bank` and `nameMatch`; a change to GSTIN or PAN clears `verification.gstin`; a name change clears both. Approval, override and rejection fields are cleared. A DRAFT stays DRAFT. Audit action `vendor.bankChange` when a bank field changed, else `vendor.taxChange` |
| `submit` | DRAFT | VERIFYING | `vendor.verify` | needs PAN, IFSC and account (not for utilities) |
| `runVerification` | VERIFYING | VERIFIED or NEEDS_REVIEW | `vendor.verify` | a DRAFT is submitted first. VERIFIED when every pre-check passes, the simulated GSTIN status is Active and the name match is >= 0.85 |
| `approve` | VERIFIED | APPROVED | `vendor.approve` | segregated from `createdBy` and `updatedBy` |
| `override` | NEEDS_REVIEW | APPROVED | `vendor.approve` | segregated; reason mandatory, stored in `overrideReason` |
| `reject` | VERIFIED, NEEDS_REVIEW | REJECTED | `vendor.reject` | segregated; reason mandatory |

Only APPROVED vendors can be billed (`create`, `update`, `submit`, `approve` of a bill) or paid (`batch.create`, `addBill`,
`submit`, `release`). A bank-detail change on an approved vendor therefore blocks its open bills until the checker approves it again.

Simulation rules (always `simulated: true`): the GSTIN answer is derived from `MK.rng('verify|gstin|' + id + '|' + gstin)`
- master vendors always Active / Regular, others 8% Cancelled, 12% Composition. The penny drop is derived from
`MK.rng('verify|bank|' + id + '|' + ifsc + '|' + maskedAccount)`: a record with a numeric `nameMatch` (the master) keeps that
score and is "registered" in its `accountHolderName`; otherwise the bank-registered name is the account holder as typed when it
differs from the vendor name, else a deterministic variant (exact, `M/S` prefix, truncated to 24 characters, or - 6% of the time,
35% for proprietor PANs - a personal name), and the score comes from a real string comparison of that name with the vendor name.
Same id and details -> same result on every machine.

## 4. Functions

`options` = the seeder argument of section 1. All `can()` helpers return `{ ok, reason }` for the current persona and are meant for
`disabledReason` on buttons; they check permission and state, not typed inputs (`batch.can('submit')` also reports an empty
batch, `batch.can('release')` a vendor that is no longer approved).

### `MK.workflow.bill`

| call | returns / notes |
|---|---|
| `list(filter)` | scoped records, newest first. `filter`: `{ status (string or array), unitId, unitIds, vendorId, categoryId, batchId, createdBy, from, to (invoice date), monthKey (expense month), flagged, unbatched, search }` |
| `get(id)` | record or `null` (also when out of scope) |
| `counts(filter)` | `{ total, totalPayable, awaitingApproval, awaitingApprovalPayable, byStatus: { STATUS: { count, payable } } }` |
| `categoriesFor(unitId)` | expense categories that apply to the unit |
| `expenseParts(billOrFormState)` | `[{ categoryId, amount }]` - what the bill costs by category: `amount + gstAmount`, allocated by `lines` when present (rent bill: `[{ rent, 270000 }, { rent_gst, 48600 }]`; a packaging bill of 10,000 + 1,800 GST: `[{ packaging, 11800 }]`) |
| `suggestTds(vendorId, amount)` | `{ tdsLabel, rate, tdsAmount, applies, note }` from the vendor's TDS type; indicative rates (rent 10% above Rs 50,000 a bill, contractor / transport 2% above Rs 30,000, professional fees 10%) |
| `can(action, idOrRecord)` | `action`: `create` (pass `{ unitId }`), `update`, `submit`, `startReview`, `approve`, `reject`, `reopen` |
| `create(draft, options)` | `draft`: `{ unitId, vendorId, categoryId, invoiceNo, invoiceDate, amount, dueDate?, monthKey?, description?, gstAmount?, tdsLabel?, tdsAmount?, lines?, attachments?, notes? }` -> DRAFT |
| `update(id, patch, options)` | same keys as `draft`; audit carries `changes` (incl. `payable`) |
| `submit(id, options)`, `startReview(id, options)`, `approve(id, note?, options)`, `reject(id, reason, options)`, `reopen(id, options)` | see section 3 |
| `duplicateCheck(billOrIdOrFormState)` | `{ hasExact, hasPossible, matches: [{ reason: 'SAME_INVOICE_NO' \| 'SAME_AMOUNT_WITHIN_7_DAYS', label, inScope, billId, number, unitId, status, invoiceNo, invoiceDate, amount, payable }] }`. Exact = same vendor + same invoice number ignoring case and spaces, any unit. Possible = same vendor, same `amount`, same unit, invoice dates within 7 days (the amount of live form state may be a string). Rejected bills are ignored. Matches outside the persona's units come with `inScope: false` and only `number` and `unitId`. A bill id or record of a unit outside the persona's scope reads as nothing (no matches) |
| `budgetImpact(billOrIdOrFormState)` | `{ available, monthKey, unitId, categoryId, amount, budget, committed, pipeline, afterThis, remainingAfter, utilisationAfter, status: 'WITHIN' \| 'NEAR' \| 'OVER' \| null, alreadyCommitted }`. Uses `MK.finance.budget(monthKey, unitId)` when present and accepts an array or `{ lines \| rows \| categories \| items }` whose entries have `categoryId` (or `id`), `plan` (or `budget`), `committed`, `pipeline`; the month looked up is the bill's expense month and `budget` in the result is that plan figure. `amount` = what the bill costs its own category (`expenseParts(bill)[0].amount`: amount + GST, less what its lines send elsewhere); `afterThis = committed + amount` unless the bill is already in a committed state; thresholds from `MK.config.budgetPolicy`. Without the finance layer or a matching line: `available: false`, numbers `null`. **Scoped**: an id, or a record, of a unit outside the persona's scope gives `available: false` with `unitId`, `categoryId` and `monthKey` `null` and `amount: 0` |

### `MK.workflow.batch`

| call | returns / notes |
|---|---|
| `list(filter)` | `{ status, from, to (created date), search }`, newest first; `get(id)`; `bills(id)` -> the bill records; `counts()` -> `{ total, DRAFT, PENDING_RELEASE, RELEASED, PAID, REJECTED }` |
| `eligibleBills(filter)` | approved, unbatched bills by due date: `[{ bill, eligible, reason }]` (`reason` e.g. vendor no longer approved) |
| `bankAccounts()` | `[{ id, bank, masked, purpose, label }]` - current accounts not marked for closure; the first is the default |
| `can(action, idOrRecord)` | `create`, `edit`, `submit`, `release`, `reject`, `markPaid` |
| `create(billIds, bankAccountId?, options)` | DRAFT batch; bills are reserved (`batchId`) but stay APPROVED |
| `addBill(id, billId, options)`, `removeBill(id, billId, options)` | DRAFT only |
| `submit(id, options)`, `release(id, options)`, `reject(id, reason, options)` | see section 3 |
| `markPaid(id, { utr } \| { utrByBill: { billId: utr } }, options)` | UTR = 10-22 letters or digits (spaces removed, upper-cased); with `utrByBill` every bill needs one (`utr` may serve as the fallback). Bills get `utr`, `paidAt` (now) and `paidOn` (the release date of the batch) |
| `toCsv(id)` | `{ ok, filename: 'payment-batch-PB-2609-01.csv', columns: [{ key, label }], rows, total, count, debitAccount }`; one row per bill with `beneficiaryName, accountMasked, ifsc, amount, narration (max 30 chars), paymentMode ('NEFT' \| 'Biller payment'), billNumber, invoiceNo, unit`. Pass `filename, columns, rows` straight to `MK.ui.downloadCsv` |

### `MK.workflow.vendor`

| call | returns / notes |
|---|---|
| `list(filter)` | `{ state, type, unitId, category, search }`; `get(id)`; `nameOf(id)` (any vendor, name only); `counts()` -> `{ total, DRAFT, ... }` |
| `can(action, idOrRecord)` | `create`, `update`, `submit`, `runVerification`, `approve`, `override`, `reject` |
| `preChecks(vendorLike)` | pure; works on live form state (`bankAccount` raw or `bankAccountMasked`); shape in section 2 |
| `create(draft, options)` | `{ name, unitIds, type?, category?, creditDays?, pan, gstin?, bankName, ifsc, bankAccount \| bankAccountMasked, accountHolderName?, expenseCategoryIds?, tdsLabel?, contactName?, email?, phone?, address?, id?, nameMatch? }` -> DRAFT. A raw `bankAccount` is masked before it is stored. Refused for a duplicate GSTIN or name |
| `update(id, patch, options)` | see section 3; passing `bankAccount` always counts as a bank-detail change |
| `submit(id, options)`, `runVerification(id, options)`, `approve(id, note?, options)`, `override(id, reason, options)`, `reject(id, reason, options)` | see section 3 |

### `MK.audit`

| call | returns / notes |
|---|---|
| `log(event, options)` | appends `{ entity, action, entityId?, entityLabel?, unitId?, unitIds?, from?, to?, note?, changes?, actionLabel?, actorId?, at? }`; e.g. the seeder's `{ entity: 'system', action: 'seed.applied', note }` |
| `list(filter)` | scoped events, newest first. `{ entity, entityId, actorId, unitId, action (string or array), from, to (date or timestamp, inclusive), search, order: 'asc', limit, offset }`. Events without any unit (system) are visible to everyone |
| `count(filter)` | number of matches |
| `trail(entity, entityId)` | oldest-first history of one record: stored events plus steps derived from the record's own timestamps (`derived: true`) where no stored event covers them - the review step before a decision (from `reviewedAt`), the batch release on a bill's timeline, and complete timelines for history seeded with `audit: false`. Every trail is an unbroken chain: a step starts in the state the step before it ended in, and the last step ends in the record's state. Empty when the record is out of scope |
| `toTimeline(events)` | maps to the `MK.ui.timeline` fields `{ actor, role, action, from, to, note, at }` (labels, not codes; no state chips for edits). Anything that is not an array gives `[]`; empty entries are skipped |

Other exports: `MK.workflow.labels = { state, action, flag }`, `MK.workflow.errors`, `MK.workflow.SIMULATED_NOTE`, `MK.workflow.bulk(fn)`.

## 5. Error strings

From the kernel (returned unchanged): `Not permitted for the <role label> role`, `Outside your assigned outlet`,
`Segregation of duties: you cannot act on your own submission`, `Only the person who raised this can change it`.

State: `This <bill | payment batch | vendor> is <State>; only a <...> that is <State or State> can be <verb>` with, for a vendor
approval, ` - use an override with a reason` or ` - run the verification first`.

| situation | error |
|---|---|
| unknown record | `Bill not found` / `Payment batch not found` / `Vendor not found` |
| seeder options | `Unknown user: <id>`, `Invalid timestamp - use YYYY-MM-DDTHH:MM` |
| reasons | `A rejection reason is required`, `An override reason is required` (also for a reason that is not a string, shorter than 3 or longer than 500 characters) |
| bill fields | `Select the unit the bill belongs to`, `Unknown unit: <id>`, `Select a vendor`, `Vendor not found`, `Vendor <name> is not approved for billing (currently <State>)`, `Select an expense category`, `Unknown expense category: <id>`, `Expense category <label> does not apply to <unit>`, `Enter the vendor invoice number`, `Enter a valid invoice date (YYYY-MM-DD)`, `Invoice date cannot be after today (17 Sep 2026)`, `Enter a valid due date (YYYY-MM-DD)`, `Due date cannot be before the invoice date`, `Enter the expense month as YYYY-MM`, `Every expense line needs an amount greater than zero`, `Expense lines must start with the category and amount of the bill, and may add no more than its GST`, `Enter a bill amount greater than zero`, `GST amount cannot be negative`, `GST cannot exceed 28% of the bill amount`, `Bill amount is above the limit of Rs 5 crore for a single bill`, `Vendor invoice number is limited to 40 characters`, `Description and notes are limited to 500 characters each`, `Invoice date is before the start of the financial year`, `Expense month must lie in the financial year, up to the current month`, `Due date cannot be more than 180 days after the invoice date`, `TDS amount cannot be negative`, `TDS cannot exceed the bill amount`, `Choose a TDS type for the TDS amount`, `Unknown TDS type` |
| bill rules | `This bill is in payment batch <id> and cannot be edited`, `A note is required to approve a bill flagged as a duplicate invoice`, `Vendor <name> is not approved for billing (currently <State>) - the bill cannot be approved until the vendor is approved again` |
| batch | `Select at least one approved bill`, `A payment batch needs at least one bill`, `Select the bank account to pay from`, `Unknown bank account: <id>`, `Bill <no> is <State>; only approved bills can be added to a payment batch`, `Bill <no> is already in payment batch <id>`, `Bill <id> is not in this batch`, `Vendor <name> is not approved for payment (currently <State>) - bill <no>` (on release followed by `; reject the batch or wait for the vendor to be approved again`), `Enter the UTR for the batch`, `UTR missing for bill <id>`, `UTR looks invalid (10 to 22 letters and digits): <value>` |
| vendor | `Enter the vendor name`, `Vendor type must be vendor or utility`, `Select at least one unit the vendor serves`, `Unknown unit: <id>`, `Credit days must be between 0 and 120`, `Unknown TDS type`, `Unknown expense category: <id>`, `Bank account number must be 9 to 18 digits`, `A vendor with this GSTIN already exists: <name>`, `A vendor named <name> already exists`, `Vendor id must be lower-case letters, digits and underscores`, `A vendor with id <id> already exists`, `Enter the PAN before verification`, `Enter the IFSC before verification`, `Enter the bank account number before verification` |
| audit | `Audit entity must be bill, batch, vendor or system`, `Audit event needs an action` |
| internal fault | `Unexpected error: <message>` (also logged to the console) |

## 6. Notes for the seeder and for `tools/check-data.js`

- Drive every record through the transitions inside `MK.workflow.bulk`; never patch a status. Bill and batch numbers follow the
  `at` of creation, so seed in chronological order for tidy numbering.
- Stories that emerge by rule: a second bill with the same vendor and invoice number is flagged `DUPLICATE_INVOICE` on create and
  submit and cannot be approved without a note; `v_print` stops at NEEDS_REVIEW; a bank-detail edit on an approved vendor blocks
  its approved bills from batches and blocks the release of a pending batch that contains them.
- The shipped seed gives `v_print` and `v_lab` an approved history first (both have been billed since April) and lets a recent bank-detail /
  identity change withdraw the approval, so `v_print` reaches NEEDS_REVIEW with a name match computed by the penny-drop rule (19%), not the
  38 of the master. Details: docs/API.md section 5.
- Same-amount bills of one vendor at one unit within 7 days are flagged `POSSIBLE_DUPLICATE` (a warning only) - vary seeded
  quantities if that is not the story you want.
- Keep seeded events of `MK.calendar.today` before the time you want the demo clock to start from; the clock starts one minute
  after the latest of them (10:00 at the earliest).
- Invariants worth asserting: `payable = amount + gstAmount - tdsAmount`; `batch.total` = sum of its bills' `payable`; every
  IN_BATCH / PAID bill has a `batchId` whose batch lists it; every PAID bill has `utr`, `paidAt` and `paidOn` (= the release date of its batch);
  every decided bill has `reviewedAt <= decidedAt`; every `MK.audit.trail` is an unbroken state chain; every bill's vendor exists;
  with the Bandra manager persona `bill.list()`, `MK.audit.list()` and `vendor.list()` return Bandra-only material and
  `batch.list()` only batches made purely of Bandra bills; two seeding runs give identical JSON.
