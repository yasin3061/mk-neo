/*
 * MK.seed - the workflow state the demo opens with: vendors, vendor bills, payment batches and the
 * audit trail (docs/SPEC.md section 7, docs/API.md).
 *
 * Nothing here is a hand-written record. The seed replays eleven weeks of accounts-payable work through
 * the real MK.workflow transitions, in chronological order, as the personas who would have done it:
 *
 *   ledger lines with a vendor (MK.finance)  ->  invoices by billing pattern  ->  maker enters and submits
 *   ->  checker approves (or rejects)  ->  payer builds the weekly payment batch  ->  director releases
 *   ->  payer records the UTRs.
 *
 * The replay stops at 10:00 on MK.calendar.today, so whatever was still in flight at that moment is the
 * queue the demo shows: drafts, bills awaiting the checker, approved bills waiting for the next run, a
 * batch waiting for the director and one waiting for UTRs. Stories are rules with parameters (PARAMS):
 * a vendor that changed its bank account loses its approval, a one-off repair is sent back for
 * paperwork, a vendor mails an invoice twice. Every amount comes from the ledger. A ledger line is the
 * all-in cost of the purchase - a 5% restaurant takes no input tax credit, so the GST on a vendor
 * invoice is part of the cost - and an invoice splits its share of the line into amount + GST at the
 * rate of the supply. For a complete month the bills of a unit x category therefore add up, amount
 * plus GST, to the ledger lines to the rupee.
 *
 * Deterministic: MK.rng only, no clock. Writes the MK.store collections vendors, bills, batches, audit
 * and the key 'seedVersion'; apply() is a no-op when that key already names this version.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});

  var VERSION = 'mk-seed-v4';   /* bump whenever the seeded content changes: browsers holding an older seed reseed on the next load */
  var COLLECTIONS = ['vendors', 'bills', 'batches', 'audit'];

  /* ================================================================== parameters */

  var PARAMS = {
    billsFromMonth: '2026-07',            /* earlier months live only in the ledger */
    auditFrom: '2026-09-01',              /* bill and batch steps before the open month are replayed without audit rows (storage size); MK.audit.trail derives them from the records */
    nowTime: '10:00',                     /* the replay stops here on MK.calendar.today; the demo clock of MK.workflow starts at the same minute */

    /* Onboarding of the vendor master when the ERP went live. */
    onboarding: { createOn: '2026-04-01', approveOn: '2026-04-02' },

    /* Working days between the invoice date and the day the finance maker enters the bill: [lag, probability]. */
    entryLag: [[1, 0.80], [2, 0.17], [3, 0.03]],
    /* Paper invoices of the far outlets reach head office with the weekly courier: extra working days before the maker sees them. */
    courierDelayWorkingDays: { kalyan: 2, koregaon: 4 },   /* delivery invoices only; landlords, billers and service vendors mail theirs to head office */
    /* Working days between submission and the checker's decision. A bill that is not decided the next working day was opened for review on
     * that day and then waited (a query to the unit, a missing paper): it sits UNDER_REVIEW until the decision. */
    approvalLag: [[1, 0.78], [2, 0.14], [4, 0.08]],
    reviewAfterWorkingDays: 1,
    /* Bills at or above this value wait for supporting papers more often. */
    largeBill: { amount: 75000, approvalLag: [[1, 0.45], [2, 0.25], [4, 0.30]] },
    makerLastSubmitMinute: 17 * 60,       /* a bill entered after 17:00 is submitted the next working morning */

    /* Unit managers raise the bills for what is delivered to their own door, and send them to finance every few days. */
    managerBills: {
      u_om_bandra: { unitId: 'bandra', categoryIds: ['charcoal', 'housekeeping'], submitAfterDays: [3, 5] },
      u_fm: { unitId: 'factory', categoryIds: ['production_consumables', 'gas_lpg'], submitAfterDays: [3, 5] }
    },

    /*
     * Payment runs by paying bank account (MK.config.bankAccounts.current), twice a week so that seven-day credit (meat, dairy,
     * vegetables) can be met: a weekly invoice dated Sunday is entered on Monday, approved by Wednesday and paid with the second
     * run of the week. dows: 0 = Monday. What still runs late is what reaches finance late (the courier from the far outlets).
     */
    paymentRuns: [
      { id: 'main', bankAccountId: 'ba01', dows: [0, 3], units: ['bandra', 'andheri', 'fort', 'kalyan', 'koregaon', 'ho'] },
      { id: 'factory', bankAccountId: 'ba15', dows: [2, 4], units: ['factory'] }
    ],
    runMinute: 16 * 60,                   /* the payer builds and submits the batch at 16:00 ... */
    runCutoffMinute: 12 * 60,             /* ... from the bills that were approved by noon */
    payHorizonDays: 6,                    /* a run takes every approved bill falling due before the following run can pay it */
    releaseAfterWorkingDays: 1,           /* the director releases the next working day at 11:15: that is the payment date (bill.paidOn) */
    utrAfterWorkingDays: 2,               /* bank confirmations are recorded two working days after the release, at 16:30 */

    /* GST on the invoice by type of supply (rate on the pre-tax amount). Anything not listed is a service or a good at 18% (LPG included:
     * the cylinder price of MK.config.tariffs is the all-in retail price). The ledger line is the GST-inclusive cost; see splitGst(). */
    gstByVendorCategory: { 'Poultry': 0, 'Mutton': 0, 'Vegetables': 0, 'Dairy': 0.05, 'Dry goods and spices': 0.05, 'Oil': 0.05, 'Charcoal': 0.05, 'Staff accommodation': 0 },
    gstDefault: 0.18,

    /* Monthly lines invoiced in advance on the 1st for the full month; every other monthly line is invoiced on the last day of the month. */
    advanceCategories: ['rent', 'rent_gst', 'cam', 'staff_accommodation', 'pos_internet', 'office_admin', 'licences_insurance', 'repairs'],
    oneOffInvoiceDaysBeforeMonthEnd: 4,
    utilityBillDayOfNextMonth: 5,         /* plus the unit's position, so the billers' dates are spread over the 5th to the 11th */

    /* What the invoice says where the ledger's costing basis would read oddly on a bill. */
    invoiceText: { rent: 'Rent', local_marketing: 'Printing, flyers and local promotions', licences_insurance: 'Insurance premium instalment',
      vehicle_rent: 'Refrigerated van rental', staff_accommodation: 'Staff accommodation', water: 'Municipal water charges' },

    lpg: { cylindersPerDelivery: { outlet: 3, factory: 6 }, firstDay: 2, minSpacingDays: 8 },
    weeklyQuantityJitter: 0.08,           /* fixed weekly supplies (charcoal) vary by this much from week to week */

    /*
     * Vendors whose master state is not APPROVED although they have been billed for months: they were approved at
     * onboarding with the details below and lost the approval through a recent sensitive edit (SPEC section 7).
     */
    priorDetails: {
      v_print: { change: 'bank', on: '2026-09-10T12:10', verify: true,
        was: { bankName: 'Bank of Baroda', ifsc: 'BARB0BANDRA', bankAccountMasked: 'XXXXXXXX3120', accountHolderName: 'Inkwell Print and Media', nameMatch: 96 } },
      v_lab: { change: 'identity', on: '2026-09-16T15:40', verify: false,
        was: { name: 'AccuTest Food Labs', pan: 'AHLPA2586J', gstin: '27AHLPA2586J1Z4', accountHolderName: 'AccuTest Food Labs', bankAccountMasked: 'XXXXXXXX4410' } }
    },
    /* Vendors that reached the master late: [created at, decided at]. */
    lateVendors: { v_pack2: ['2026-09-15T16:20', null], v_frozen: ['2026-09-07T11:30', '2026-09-08T15:05'] },

    /* A one-off repair at or above this value goes back once for the second quotation and the director's note. */
    oneOff: { evidenceThreshold: 50000, resubmitAfterWorkingDays: 11,
      rejection: 'One-off repair above the approval limit: attach the second quotation and the director\'s approval note, then resubmit',
      resubmitNote: 'Second quotation and the director\'s approval mail attached' },

    /* Two invoices the checker sent back and nobody has corrected yet. */
    rejections: [
      { unitId: 'fort', categoryId: 'packaging', periodTo: '2026-09-06',
        reason: 'Quantity on the invoice does not match the goods receipt note - two cartons short. Ask the vendor for a revised invoice or a credit note' },
      { unitId: 'koregaon', categoryId: 'staff_accommodation', monthKey: '2026-09',
        reason: 'Invoice is made out to the outlet manager instead of the company and carries no GSTIN of ours. Ask for a corrected invoice' }
    ],

    /* The vendor mailed an invoice again after it had been paid; the maker entered it without noticing. */
    duplicate: { vendorId: 'v_pack', unitId: 'andheri', periodTo: '2026-08-09', enteredAt: '2026-09-16T15:10',
      note: 'Invoice received again by e-mail from the vendor on 16 Sep' }
  };

  /* ===================================================================== helpers */

  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function stampOf(date, minute) { return date + 'T' + pad(Math.floor(minute / 60), 2) + ':' + pad(minute % 60, 2); }
  function minutesLater(stamp, n) { return stampOf(stamp.slice(0, 10), (+stamp.slice(11, 13)) * 60 + (+stamp.slice(14, 16)) + n); }
  function isWorkingDay(iso) { return MK.dates.dow(iso) <= 4; }
  /**
   * The n-th working day after iso. n = 0: iso itself when it is a working day, else the next one. From a weekend the first
   * working day after it is the Monday: an invoice dated Sunday that takes one working day to reach finance is entered on Monday.
   */
  function addWorkingDays(iso, n) {
    var d = iso;
    if (!isWorkingDay(d)) { while (!isWorkingDay(d)) d = MK.dates.addDays(d, 1); if (n > 0) n -= 1; }
    for (var i = 0; i < n; i++) { d = MK.dates.addDays(d, 1); while (!isWorkingDay(d)) d = MK.dates.addDays(d, 1); }
    return d;
  }
  function pickLag(rng, table) {
    var u = rng.next(), acc = 0;
    for (var i = 0; i < table.length; i++) { acc += table[i][1]; if (u < acc) return table[i][0]; }
    return table[table.length - 1][0];
  }
  function byId(list) { var m = {}; list.forEach(function (x) { m[x.id] = x; }); return m; }
  function sum(list) { var t = 0; for (var i = 0; i < list.length; i++) t += list[i]; return t; }

  /** Whole-rupee split of `total` in proportion to `weights`; the rounding residue goes on the last non-zero share. */
  function splitExact(total, weights) {
    var w = sum(weights), out = [], given = 0, last = -1;
    for (var i = 0; i < weights.length; i++) {
      var x = w > 0 ? Math.round(total * weights[i] / w) : 0;
      out.push(x); given += x; if (weights[i] > 0) last = i;
    }
    if (last >= 0) out[last] += total - given;
    return out;
  }

  /* Tiny binary heap of events ordered by (at, seq): the replay is a discrete-event simulation. */
  function Queue() { this.items = []; this.seq = 0; }
  Queue.prototype.before = function (a, b) { return a.at < b.at || (a.at === b.at && a.seq < b.seq); };
  Queue.prototype.push = function (at, run) {
    var a = this.items, e = { at: at, seq: this.seq++, run: run }, i = a.length;
    a.push(e);
    while (i > 0) { var p = (i - 1) >> 1; if (!this.before(a[i], a[p])) break; var t = a[i]; a[i] = a[p]; a[p] = t; i = p; }
  };
  Queue.prototype.pop = function () {
    var a = this.items, top = a[0], end = a.pop();
    if (a.length) {
      a[0] = end;
      for (var i = 0; ;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < a.length && this.before(a[l], a[m])) m = l;
        if (r < a.length && this.before(a[r], a[m])) m = r;
        if (m === i) break;
        var t = a[i]; a[i] = a[m]; a[m] = t; i = m;
      }
    }
    return top;
  };

  /* ================================================================ invoice plan */

  /** Weekly invoice periods of a month: Monday to Sunday, cut at the month ends; stubs shorter than four days join their neighbour. */
  function weeklyPeriods(monthKey) {
    var D = MK.dates, from = monthKey + '-01', end = D.monthEnd(from), out = [], start = from;
    while (start <= end) {
      var to = D.min(D.addDays(D.weekStart(start), 6), end);
      out.push({ from: start, to: to });
      start = D.addDays(to, 1);
    }
    function days(p) { return D.diffDays(p.from, p.to) + 1; }
    if (out.length > 1 && days(out[0]) < 4) { out[1].from = out[0].from; out.shift(); }
    if (out.length > 1 && days(out[out.length - 1]) < 4) { out[out.length - 2].to = out[out.length - 1].to; out.pop(); }
    return out;
  }

  /**
   * Turns the billable ledger lines of July onwards into planned invoices. Returns plain objects:
   * { key, unitId, vendorId, categoryId, monthKey, invoiceDate, amount, lines, description, goods, pattern, periodFrom, periodTo }.
   */
  function planInvoices() {
    var cfg = MK.config, D = MK.dates, cal = MK.calendar, db = MK.db;
    var vendorById = byId(cfg.vendors), unitById = byId(cfg.outlets), catById = byId(cfg.expenseCategories);
    var unitOrder = {}; cfg.outlets.forEach(function (u, i) { unitOrder[u.id] = i; });
    var advance = {}; PARAMS.advanceCategories.forEach(function (c) { advance[c] = true; });
    var fac = MK.factory && MK.factory.raw ? MK.factory.raw : null, facState = fac ? fac.state() : null;
    var months = cfg.months.filter(function (m) { return m >= PARAMS.billsFromMonth; });
    var plan = [];

    /* day-level weights */
    function outletNetByDay(unitId) {
      var o = db.index.outlet[unitId], out = new Float64Array(db.dims.ND);
      for (var d = 0; d < db.dims.ND; d++) for (var s = 0; s < db.dims.NS; s++) out[d] += db.dayMeasure(d, o, s, 'netSales');
      return out;
    }
    var netCache = {};
    function netByDay(unitId) { return netCache[unitId] || (netCache[unitId] = outletNetByDay(unitId)); }
    function factoryPurchasesByDay(vendorId) {
      var out = new Float64Array(facState.ND), map = fac.model.rmVendorByCategory;
      facState.rms.forEach(function (rm, r) {
        if (map[rm.vendorCategory] !== vendorId) return;
        for (var d = 0; d < facState.ND; d++) out[d] += facState.rmBuyValue[d * facState.NR + r];
      });
      return out;
    }
    function factoryDispatchByDay() {
      var out = new Float64Array(facState.ND), per = facState.NO * facState.NK;
      for (var d = 0; d < facState.ND; d++) for (var i = 0; i < per; i++) out[d] += facState.dispatchValue[d * per + i];
      return out;
    }
    function weightOver(byDay, from, to) {
      var a = db.dayIdx(D.max(from, cal.dataStart)), b = db.dayIdx(D.min(to, cal.dataEnd)), t = 0;
      if (a < 0 || b < 0) return 0;
      for (var d = a; d <= b; d++) t += byDay[d];
      return t;
    }

    function push(line, o) {
      var unit = unitById[line.unitId];
      o.key = [line.unitId, line.vendorId, o.categoryId || line.categoryId, o.invoiceDate, o.tag || ''].join('|');
      o.unitId = line.unitId; o.vendorId = line.vendorId; o.categoryId = o.categoryId || line.categoryId; o.monthKey = line.monthKey;
      o.unitSort = unitOrder[line.unitId]; o.unitCode = unit.code; o.lines = o.lines || null;
      plan.push(o);
    }
    function monthLabel(mk) { return D.monthLabel(mk, true); }
    function textOf(line) { return PARAMS.invoiceText[line.categoryId] || line.basis || catById[line.categoryId].label; }
    function periodLabel(p) { return D.label(p.from) + ' - ' + D.label(p.to); }

    months.forEach(function (mk) {
      var info = MK.finance.raw.monthInfo(mk), mi = cfg.months.indexOf(mk), complete = !info.partial;
      var monthEnd = D.monthEnd(mk + '-01'), periods = weeklyPeriods(mk);
      var lines = MK.finance.raw.ledger({ monthKey: mk, billableOnly: true });

      /* the landlord puts rent and its GST on one invoice: the GST line rides on the rent bill as a second expense line */
      var rentGst = {};
      lines.forEach(function (l) { if (l.categoryId === 'rent_gst') rentGst[l.unitId + '|' + l.vendorId] = l; });

      lines.forEach(function (line) {
        var vendor = vendorById[line.vendorId], full = line.fullMonthAmount !== null ? line.fullMonthAmount : line.amount;
        if (line.categoryId === 'rent_gst') return;

        /* ---- utilities: the biller's invoice arrives after the month has closed ---- */
        if (vendor.type === 'utility') {
          var billDate = D.addDays(D.addDays(monthEnd, PARAMS.utilityBillDayOfNextMonth), unitOrder[line.unitId]);
          if (!complete || billDate > cal.dataEnd) return;
          push(line, { pattern: 'utility', invoiceDate: billDate, amount: line.amount, goods: false,
            description: textOf(line) + ', ' + monthLabel(mk) + (line.categoryId === 'electricity' && line.basis ? ' (' + line.basis + ')' : '') });
          return;
        }

        /* ---- weekly supplies ---- */
        if (line.billing.frequency === 'weekly') {
          var byDay, fixedSupply = line.accrual === 'prorata' || line.behaviour === 'fixed';
          if (line.unitId === 'factory') byDay = line.categoryId === 'raw_materials' ? factoryPurchasesByDay(line.vendorId) : factoryDispatchByDay();
          else byDay = fixedSupply ? null : netByDay(line.unitId);
          var jitter = MK.rng('seed|weekly|' + line.unitId + '|' + line.vendorId + '|' + line.categoryId + '|' + mk);
          var weights = periods.map(function (p) {
            if (byDay) return weightOver(byDay, p.from, p.to);
            return (D.diffDays(p.from, p.to) + 1) * (1 + jitter.range(-PARAMS.weeklyQuantityJitter, PARAMS.weeklyQuantityJitter));
          });
          var amounts;
          if (complete) amounts = splitExact(line.amount, weights);
          else {
            /* open month: the ledger line runs to the last data day; only weeks that have ended are invoiced */
            var base = byDay ? weightOver(byDay, info.from, info.to) : sum(weights), total = byDay ? line.amount : full;
            amounts = weights.map(function (w, i) { return periods[i].to <= cal.dataEnd && base > 0 ? Math.round(total * w / base) : 0; });
          }
          periods.forEach(function (p, i) {
            if (amounts[i] <= 0 || p.to > cal.dataEnd) return;
            var what = line.categoryId === 'raw_materials' ? vendor.category + ' for production'
              : line.categoryId === 'cogs_local' ? vendor.category + ' for the outlet kitchen'
              : line.categoryId === 'charcoal' ? 'Charcoal, ' + MK.fmt.kg(Math.round(amounts[i] / cfg.tariffs.charcoalPerKg))
              : line.categoryId === 'production_consumables' ? 'Production consumables (gloves, vacuum bags, labels, sanitiser)'
              : catById[line.categoryId].label;
            push(line, { pattern: 'weekly', invoiceDate: p.to, periodFrom: p.from, periodTo: p.to, amount: amounts[i], goods: true,
              description: what + ', ' + periodLabel(p) });
          });
          return;
        }

        /* ---- LPG: one invoice per cylinder delivery ---- */
        if (line.billing.frequency === 'per-delivery') {
          var price = cfg.tariffs.lpgCylinder19kg[mi], cylinders = Math.round(full / price);
          var perDrop = PARAMS.lpg.cylindersPerDelivery[unitById[line.unitId].type] || 3, drops = Math.max(1, Math.ceil(cylinders / perDrop));
          var spacing = Math.max(PARAMS.lpg.minSpacingDays, Math.floor(28 / drops)), counts = [], dates = [];
          for (var k = 0; k < drops; k++) {
            counts.push(Math.floor(cylinders / drops) + (k < cylinders % drops ? 1 : 0));
            dates.push(D.addDays(mk + '-01', Math.min(27, PARAMS.lpg.firstDay - 1 + k * spacing + unitOrder[line.unitId] % 3)));
          }
          var dropAmounts = complete ? splitExact(line.amount, counts) : counts.map(function (c) { return Math.round(c * price); });
          dates.forEach(function (date, k2) {
            if (date > cal.dataEnd || dropAmounts[k2] <= 0) return;
            push(line, { pattern: 'delivery', invoiceDate: date, amount: dropAmounts[k2], goods: true,
              description: '19 kg commercial LPG x ' + counts[k2] + ' cylinders, delivered ' + D.label(date) });
          });
          return;
        }

        /* ---- monthly: in advance on the 1st, a one-off job when it happened, everything else on the last day ---- */
        var oneOff = line.component === 'one_off', inAdvance = advance[line.categoryId] && !oneOff && line.component !== 'jobs';
        if (inAdvance) {
          var o = { pattern: 'advance', invoiceDate: mk + '-01', amount: full, goods: false,
            description: textOf(line) + ', ' + monthLabel(mk) +
              (line.categoryId === 'rent' && line.basis ? ' - ' + line.basis : '') };
          var gst = line.categoryId === 'rent' ? rentGst[line.unitId + '|' + line.vendorId] : null;
          if (gst) {
            var gstFull = gst.fullMonthAmount !== null ? gst.fullMonthAmount : gst.amount;
            o.gstAmount = gstFull;
            o.lines = [{ categoryId: 'rent', amount: full }, { categoryId: 'rent_gst', amount: gstFull }];
          }
          push(line, o);
          return;
        }
        if (!complete) return;   /* the month has not closed: no invoice yet */
        push(line, { pattern: oneOff ? 'one_off' : 'arrears', tag: line.component || '', goods: false,
          invoiceDate: oneOff ? D.addDays(monthEnd, -PARAMS.oneOffInvoiceDaysBeforeMonthEnd) : monthEnd, amount: line.amount,
          description: oneOff ? (line.note || 'One-off repair') + ' - one-off repair job' : textOf(line) + ', ' + monthLabel(mk) });
      });
    });

    plan.sort(function (a, b) {
      return a.invoiceDate < b.invoiceDate ? -1 : a.invoiceDate > b.invoiceDate ? 1 : a.unitSort !== b.unitSort ? a.unitSort - b.unitSort : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
    splitGst(plan, vendorById);
    separateLookalikes(plan);
    numberInvoices(plan, vendorById);
    return plan;
  }

  /*
   * Up to here `amount` is the invoice's share of the ledger line, i.e. the all-in cost. The invoice shows it as a taxable value
   * plus GST at the rate of the supply: amount = cost / (1 + rate), GST = the rest, so amount + GST is the ledger share to the
   * rupee. A rent invoice already carries its GST (the ledger keeps rent and the non-creditable GST on it as two lines).
   */
  function splitGst(plan, vendorById) {
    plan.forEach(function (b) {
      if (b.gstAmount !== undefined) { b.cost = b.amount + b.gstAmount; return; }
      var v = vendorById[b.vendorId], rate = v.type === 'utility' ? 0 : PARAMS.gstByVendorCategory[v.category];
      if (rate === undefined) rate = PARAMS.gstDefault;
      b.cost = b.amount;
      b.amount = Math.round(b.cost / (1 + rate));
      b.gstAmount = b.cost - b.amount;
    });
  }

  /*
   * MK.workflow warns about a possible duplicate when one vendor bills one unit the same amount twice within seven
   * days. Real weekly quantities differ; where the arithmetic happens to produce twins, a rupee moves between the two
   * invoices so the month total is untouched and only intended duplicates are flagged.
   */
  function separateLookalikes(plan) {
    var D = MK.dates, recent = {}, groups = {};
    function groupKey(b) { return [b.unitId, b.vendorId, b.categoryId, b.monthKey, b.pattern].join('|'); }
    plan.forEach(function (b) { (groups[groupKey(b)] || (groups[groupKey(b)] = [])).push(b); });
    function hasTwin(b, list) {
      for (var i = list.length - 1; i >= 0 && D.diffDays(list[i].invoiceDate, b.invoiceDate) <= 7; i--) if (list[i].amount === b.amount) return true;
      return false;
    }
    plan.forEach(function (b) {
      var k = b.vendorId + '|' + b.unitId, list = recent[k] || (recent[k] = []), group = groups[groupKey(b)];
      /* a single monthly invoice keeps its amount: there the warning, should it ever fire, is the honest outcome */
      for (var guard = 0; group.length > 1 && !b.lines && guard < 5 && hasTwin(b, list); guard++) {
        var at = group.indexOf(b), sibling = group[at + 1] || group[at - 1];
        b.amount += 1; sibling.amount -= 1;
      }
      list.push(b);
    });
  }

  /* Invoice numbers: every vendor has its own series and style, rising with the invoice date; billers quote the consumer number and the bill month. */
  function numberInvoices(plan, vendorById) {
    var NOISE = { and: 1, pvt: 1, ltd: 1, llp: 1, the: 1, of: 1 }, series = {}, consumers = {};
    function seriesOf(vendor) {
      if (series[vendor.id]) return series[vendor.id];
      var rng = MK.rng('seed|invoice-series|' + vendor.id);
      var words = vendor.name.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(function (w) { return w && !NOISE[w.toLowerCase()]; });
      var s = { rng: rng, initials: words.slice(0, 3).map(function (w) { return w.charAt(0).toUpperCase(); }).join(''), style: rng.int(0, 3), serial: rng.int(140, 3800) };
      return (series[vendor.id] = s);
    }
    plan.forEach(function (b) {
      var vendor = vendorById[b.vendorId];
      if (vendor.type === 'utility') {
        var ck = vendor.id + '|' + b.unitId;
        if (!consumers[ck]) consumers[ck] = '0' + pad(MK.rng('seed|consumer|' + ck).int(10000000000, 99999999999), 11);
        b.invoiceNo = consumers[ck] + '/' + b.monthKey.slice(5, 7) + b.monthKey.slice(2, 4);
      } else {
        var s = seriesOf(vendor);
        s.serial += s.rng.int(2, 23);
        var n = pad(s.serial, 4);
        b.invoiceNo = s.style === 0 ? s.initials + '/26-27/' + n : s.style === 1 ? s.initials + '-2627-' + n : s.style === 2 ? 'INV/' + s.initials + '/' + n : s.initials + '/' + n + '/26-27';
      }
      var file = b.invoiceNo.replace(/[^A-Za-z0-9]+/g, '-');
      b.attachments = [{ name: file + '.pdf' }];
      if (b.goods) b.attachments.push({ name: 'GRN-' + b.unitCode + '-' + b.invoiceDate.replace(/-/g, '') + '.pdf' });
    });
  }

  /* ====================================================================== replay */

  function replay(plan) {
    var cfg = MK.config, W = MK.workflow, D = MK.dates, cal = MK.calendar;
    var NOW = stampOf(cal.today, (+PARAMS.nowTime.slice(0, 2)) * 60 + (+PARAMS.nowTime.slice(3, 5)));
    var vendorById = byId(cfg.vendors), queue = new Queue(), vendorApproved = {}, live = [];
    var counts = { transitions: 0 };

    function must(res, what) {
      if (!res || !res.ok) throw new Error('MK.seed: ' + what + ' failed - ' + (res ? res.error : 'no result'));
      counts.transitions++;
      return res.record;
    }
    function opts(actorId, at, alwaysAudit) { return { actorId: actorId, at: at, audit: alwaysAudit || at.slice(0, 10) >= PARAMS.auditFrom }; }
    function schedule(at, run) { if (at < NOW) queue.push(at, run); }

    /* ---------------------------------------------------------------- vendors */

    cfg.vendors.forEach(function (master, i) {
      var late = PARAMS.lateVendors[master.id], prior = PARAMS.priorDetails[master.id];
      var createAt = late ? late[0] : stampOf(PARAMS.onboarding.createOn, 10 * 60 + i * 3);
      var decideAt = late ? late[1] : stampOf(PARAMS.onboarding.approveOn, 11 * 60 + i * 2);
      var first = master;
      if (prior) { first = {}; Object.keys(master).forEach(function (k) { first[k] = master[k]; }); Object.keys(prior.was).forEach(function (k) { first[k] = prior.was[k]; }); }
      var target = prior ? 'APPROVED' : master.state;

      var submitAt = minutesLater(createAt, 1), verifyAt = minutesLater(createAt, 2);
      schedule(createAt, function () { must(W.vendor.create(first, opts('u_maker', createAt, true)), 'create vendor ' + master.id); });
      if (target !== 'DRAFT') schedule(submitAt, function () { must(W.vendor.submit(master.id, opts('u_maker', submitAt, true)), 'submit vendor ' + master.id); });
      if (target !== 'DRAFT' && target !== 'VERIFYING') schedule(verifyAt, function () { must(W.vendor.runVerification(master.id, opts('u_maker', verifyAt, true)), 'verify vendor ' + master.id); });
      if (decideAt && (target === 'APPROVED' || target === 'REJECTED')) schedule(decideAt, function () {
        if (target === 'REJECTED') { must(W.vendor.reject(master.id, master.rejectionReason || 'Verification evidence not accepted', opts('u_checker', decideAt, true)), 'reject vendor ' + master.id); return; }
        must(W.vendor.approve(master.id, opts('u_checker', decideAt, true)), 'approve vendor ' + master.id);
        vendorApproved[master.id] = true;
      });

      /* the sensitive edit that withdrew an existing approval */
      if (prior) schedule(prior.on, function () {
        var patch = {};
        Object.keys(prior.was).forEach(function (k) { if (k !== 'nameMatch') patch[k] = master[k]; });
        must(W.vendor.update(master.id, patch, opts('u_maker', prior.on, true)), 'edit vendor ' + master.id);
        vendorApproved[master.id] = false;
      });
      if (prior && prior.verify) schedule(minutesLater(prior.on, 2), function () {
        must(W.vendor.runVerification(master.id, opts('u_maker', minutesLater(prior.on, 2), true)), 're-verify vendor ' + master.id);
      });
    });

    /* ------------------------------------------------------------------ bills */

    function creatorOf(b) {
      var ids = Object.keys(PARAMS.managerBills);
      for (var i = 0; i < ids.length; i++) { var m = PARAMS.managerBills[ids[i]]; if (m.unitId === b.unitId && m.categoryIds.indexOf(b.categoryId) !== -1) return ids[i]; }
      return 'u_maker';
    }
    function draftOf(b, extra) {
      var tds = W.bill.suggestTds(b.vendorId, b.amount);
      var d = { unitId: b.unitId, vendorId: b.vendorId, categoryId: b.categoryId, invoiceNo: b.invoiceNo, invoiceDate: b.invoiceDate, monthKey: b.monthKey,
        description: b.description, amount: b.amount, gstAmount: b.gstAmount, tdsLabel: tds.applies ? tds.tdsLabel : null, tdsAmount: tds.applies ? tds.tdsAmount : 0,
        lines: b.lines, attachments: b.attachments, notes: '' };
      if (extra) Object.keys(extra).forEach(function (k) { d[k] = extra[k]; });
      return d;
    }
    function matches(b, rule) {
      return b.unitId === rule.unitId && (!rule.vendorId || b.vendorId === rule.vendorId) && (!rule.categoryId || b.categoryId === rule.categoryId) &&
        (!rule.periodTo || b.periodTo === rule.periodTo) && (!rule.monthKey || (b.monthKey === rule.monthKey && !b.periodTo));
    }

    /* Decision by the checker; skipped while the vendor is not approved (the bill then simply waits, as it would in real life). */
    function scheduleDecision(b, submitAt, rng, forcedLag, rejection) {
      var large = b.amount >= PARAMS.largeBill.amount;
      var lag = forcedLag || pickLag(rng, large ? PARAMS.largeBill.approvalLag : PARAMS.approvalLag);
      var decideOn = addWorkingDays(submitAt.slice(0, 10), lag), decideAt = stampOf(decideOn, 11 * 60 + rng.int(0, 360));
      if (lag >= 2) {
        var reviewAt = stampOf(addWorkingDays(submitAt.slice(0, 10), PARAMS.reviewAfterWorkingDays), 15 * 60 + rng.int(0, 120));
        schedule(reviewAt, function () { if (vendorApproved[b.vendorId]) { must(W.bill.startReview(b.id, opts('u_checker', reviewAt, b.keepAudit)), 'review ' + b.id); b.status = 'UNDER_REVIEW'; } });
      }
      schedule(decideAt, function () {
        if (!vendorApproved[b.vendorId]) return;
        if (rejection) { must(W.bill.reject(b.id, rejection, opts('u_checker', decideAt, b.keepAudit)), 'reject ' + b.id); b.status = 'REJECTED'; return; }
        must(W.bill.approve(b.id, opts('u_checker', decideAt, b.keepAudit)), 'approve ' + b.id);
        b.status = 'APPROVED'; b.decidedAt = decideAt;
      });
      return decideAt;
    }

    plan.forEach(function (b) {
      var rng = MK.rng('seed|flow|' + b.key), creator = creatorOf(b), manager = PARAMS.managerBills[creator] || null;
      var createAt, submitAt;
      if (manager) {
        createAt = stampOf(D.addDays(b.invoiceDate, 1), 11 * 60 + rng.int(0, 300));
        submitAt = stampOf(D.addDays(createAt.slice(0, 10), rng.int(manager.submitAfterDays[0], manager.submitAfterDays[1])), 12 * 60 + rng.int(0, 180));
      } else {
        var minute = 10 * 60 + rng.int(0, 465);
        createAt = stampOf(addWorkingDays(b.invoiceDate, pickLag(rng, PARAMS.entryLag) + (b.goods ? PARAMS.courierDelayWorkingDays[b.unitId] || 0 : 0)), minute);
        submitAt = minute > PARAMS.makerLastSubmitMinute ? stampOf(addWorkingDays(createAt.slice(0, 10), 1), 10 * 60 + 30 + rng.int(0, 30))
          : stampOf(createAt.slice(0, 10), minute + rng.int(2, 20));
      }
      var rejection = null;
      PARAMS.rejections.forEach(function (r) { if (matches(b, r)) rejection = r.reason; });
      var oneOff = b.pattern === 'one_off' && b.amount >= PARAMS.oneOff.evidenceThreshold;
      b.keepAudit = oneOff;   /* this bill's history is the story: keep every step of it in the audit log */

      schedule(createAt, function () {
        if (!vendorApproved[b.vendorId]) return;   /* cannot be billed today; nothing to enter */
        var rec = must(W.bill.create(draftOf(b), opts(creator, createAt, b.keepAudit)), 'create bill ' + b.key);
        b.id = rec.id; b.dueDate = rec.dueDate; b.status = 'DRAFT'; live.push(b);

        schedule(submitAt, function () {
          if (!vendorApproved[b.vendorId]) return;
          must(W.bill.submit(b.id, opts(creator, submitAt, b.keepAudit)), 'submit ' + b.id);
          b.status = 'SUBMITTED';
          if (!oneOff) { scheduleDecision(b, submitAt, rng, rejection ? 1 : 0, rejection); return; }

          /* the one-off repair: sent back for paperwork, corrected and resubmitted; the second decision waits for the director's note */
          var rejectedAt = scheduleDecision(b, submitAt, rng, 1, PARAMS.oneOff.rejection);
          var againOn = addWorkingDays(rejectedAt.slice(0, 10), PARAMS.oneOff.resubmitAfterWorkingDays), againAt = stampOf(againOn, 12 * 60 + rng.int(0, 60));
          schedule(againAt, function () {
            var files = b.attachments.concat([{ name: 'Quotation-2-' + b.unitCode + '.pdf' }, { name: 'Director-approval-mail.pdf' }]);
            must(W.bill.update(b.id, { attachments: files, notes: PARAMS.oneOff.resubmitNote }, opts('u_maker', againAt, true)), 'correct ' + b.id);
            b.status = 'DRAFT';
          });
          var resubmitAt = minutesLater(againAt, 5);
          schedule(resubmitAt, function () {
            must(W.bill.submit(b.id, opts('u_maker', resubmitAt, true)), 'resubmit ' + b.id);
            b.status = 'SUBMITTED';
            scheduleDecision(b, resubmitAt, rng, 4, null);
          });
        });
      });
    });

    /* the invoice that arrived twice */
    var dup = PARAMS.duplicate, original = null;
    plan.forEach(function (b) { if (b.vendorId === dup.vendorId && matches(b, dup)) original = b; });
    var copyId = null;
    if (original) schedule(dup.enteredAt, function () {
      if (!original.id || !vendorApproved[original.vendorId]) return;
      copyId = must(W.bill.create(draftOf(original, { notes: dup.note, attachments: [{ name: 'Fwd-' + original.attachments[0].name }] }), opts('u_maker', dup.enteredAt)), 'create the duplicate').id;
    });
    if (original) schedule(minutesLater(dup.enteredAt, 4), function () {
      if (copyId) must(W.bill.submit(copyId, opts('u_maker', minutesLater(dup.enteredAt, 4))), 'submit the duplicate');
    });

    /* ---------------------------------------------------------- payment runs */

    var utrSerial = MK.rng('seed|utr');
    function utrFor(b, date) {
      var julian = pad(D.diffDays(date.slice(0, 4) + '-01-01', date) + 1, 3), n = pad(utrSerial.int(0, 999999), 6);
      return vendorById[b.vendorId].type === 'utility' ? 'BBPS' + date.slice(2, 4) + julian + n + '0' : 'HDFCN' + date.slice(2, 4) + julian + n;
    }

    PARAMS.paymentRuns.forEach(function (run) { run.dows.forEach(function (dow) {
      var day = D.addDays(D.weekStart(PARAMS.billsFromMonth + '-01'), dow);
      for (; day <= cal.today; day = D.addDays(day, 7)) (function (runDate) {
        var runAt = stampOf(runDate, PARAMS.runMinute);
        schedule(runAt, function () {
          var horizon = D.addDays(runDate, PARAMS.payHorizonDays), cutoff = stampOf(runDate, PARAMS.runCutoffMinute);
          var due = live.filter(function (b) { return b.status === 'APPROVED' && b.decidedAt < cutoff && !b.batchId && run.units.indexOf(b.unitId) !== -1 && vendorApproved[b.vendorId] && b.dueDate <= horizon; })
            .sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : (a.id < b.id ? -1 : 1); });
          if (!due.length) return;
          var batch = must(W.batch.create(due.map(function (b) { return b.id; }), run.bankAccountId, opts('u_payer', runAt)), 'create batch ' + runDate);
          due.forEach(function (b) { b.batchId = batch.id; });
          var submitAt = stampOf(runDate, PARAMS.runMinute + 5);
          schedule(submitAt, function () {
            must(W.batch.submit(batch.id, opts('u_payer', submitAt)), 'submit ' + batch.id);
            due.forEach(function (b) { b.status = 'IN_BATCH'; });
          });

          var releaseOn = addWorkingDays(runDate, PARAMS.releaseAfterWorkingDays), releaseAt = stampOf(releaseOn, 11 * 60 + 15);
          schedule(releaseAt, function () {
            must(W.batch.release(batch.id, opts('u_director', releaseAt)), 'release ' + batch.id);
            var paidOn = addWorkingDays(releaseOn, PARAMS.utrAfterWorkingDays), paidAt = stampOf(paidOn, 16 * 60 + 30);
            schedule(paidAt, function () {
              var utrByBill = {};
              due.forEach(function (b) { utrByBill[b.id] = utrFor(b, releaseOn); });
              must(W.batch.markPaid(batch.id, { utrByBill: utrByBill }, opts('u_payer', paidAt)), 'record UTRs ' + batch.id);
              due.forEach(function (b) { b.status = 'PAID'; });
            });
          });
        });
      })(day);
    }); });

    /* ------------------------------------------------------------------- run */

    while (queue.items.length) { var e = queue.pop(); e.run(); }
    return counts;
  }

  /* ========================================================================= API */

  function isSeeded() {
    var mark = MK.store.get('seedVersion', null);
    return !!mark && mark.version === VERSION;
  }

  /**
   * apply({ force }) -> { ok, seeded, version, counts } | { ok: false, error }.
   * No-op when this version is already in the store; { force: true } clears the four collections and seeds again
   * (call it after MK.store.resetAll(), or on its own).
   */
  function apply(options) {
    var force = !!(options && options.force);
    if (isSeeded() && !force) return { ok: true, seeded: false, version: VERSION, counts: MK.store.get('seedVersion', {}).counts || null };
    if (!MK.config || !MK.engine || !MK.finance || !MK.finance.raw || !MK.workflow) return { ok: false, error: 'MK.seed needs config, engine, finance and workflow to be loaded' };

    MK.engine.run();
    MK.finance.build();

    /* a clean slate: a half-written or older seed must not leak into the replay */
    COLLECTIONS.forEach(function (name) { if (MK.store.get('c.' + name, null) !== null) MK.store.remove('c.' + name); });
    var prefs = MK.store.get('prefs', null);
    if (prefs && prefs.workflowClock) { delete prefs.workflowClock; MK.store.set('prefs', prefs); }

    var plan = planInvoices(), stats;
    MK.workflow.bulk(function () {
      stats = replay(plan);
      var n = { vendors: MK.config.vendors.length, invoices: plan.length };
      MK.audit.log({ entity: 'system', action: 'seed.applied', actionLabel: 'Demo data prepared', actorId: 'u_maker',
        at: stampOf(MK.calendar.today, 9 * 60 + 58), note: 'Demo dataset ' + VERSION + ': ' + n.vendors + ' vendors and ' + n.invoices + ' vendor invoices replayed through the approval workflow' });
    });

    var counts = {};
    COLLECTIONS.forEach(function (name) { counts[name] = MK.store.coll(name).all().length; });
    counts.transitions = stats.transitions;
    MK.store.set('seedVersion', { version: VERSION, appliedOn: MK.calendar.today, counts: counts });
    return { ok: true, seeded: true, version: VERSION, counts: counts };
  }

  MK.seed = {
    version: VERSION,
    params: PARAMS,
    isSeeded: isSeeded,
    apply: apply,
    /** The invoice plan behind the seeded bills (unscoped; for tools/check-data.js). */
    plan: function () { MK.engine.run(); MK.finance.build(); return planInvoices(); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.MK;
})(typeof window !== 'undefined' ? window : globalThis);
