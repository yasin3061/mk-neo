/*
 * MK.workflow and MK.audit - maker-checker state machines for bills, payment batches and vendors
 * (docs/SPEC.md section 7). Pure logic over the MK.store collections 'vendors', 'bills', 'batches'
 * and 'audit'; records are plain JSON. No DOM, no wall clock, no randomness beyond MK.rng(seed).
 *
 * Contract of every transition: it returns { ok: true, record } or { ok: false, error } and never
 * throws on bad input. Checks run in a fixed order - record exists, permission (role, unit scope and
 * segregation of duties, all from MK.session.can), current state, required inputs - and nothing is
 * written until every check has passed. One call = one unit of work: all records and audit events it
 * touches are flushed to the store together, once per collection.
 *
 * Every transition accepts an optional last argument { actorId, at, audit } that overrides the acting
 * persona and the timestamp. It exists for the seeder (history before "today"); pages never pass it.
 * Without it the actor is MK.session.current() and the time is the demo clock: MK.calendar.today plus
 * a time of day that advances one minute per action and is kept in prefs, so the audit order is
 * stable across reloads.
 *
 * Full reference: docs/API-workflow.md.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});

  /* ------------------------------------------------------------ constants */

  var STATE_LABELS = {
    DRAFT: 'Draft', SUBMITTED: 'Submitted', UNDER_REVIEW: 'Under review', APPROVED: 'Approved', REJECTED: 'Rejected',
    IN_BATCH: 'In payment batch', PAID: 'Paid', PENDING_RELEASE: 'Pending release', RELEASED: 'Released to bank',
    VERIFYING: 'Verifying', VERIFIED: 'Verified', NEEDS_REVIEW: 'Needs review'
  };

  /*
   * Transition tables. from = states the transition may start in, to = resulting state, right = the
   * MK.session.can() action that guards it, segregate = record fields naming people the actor must
   * differ from (the kernel applies the rule; listing two fields means two checks).
   * Transitions without a right are driven by a payment batch and cannot be called directly.
   */
  var BILL_TRANSITIONS = {
    update:      { from: ['DRAFT', 'REJECTED'], to: 'DRAFT', right: 'bill.edit', verb: 'edited' },
    submit:      { from: ['DRAFT'], to: 'SUBMITTED', right: 'bill.submit', verb: 'submitted' },
    startReview: { from: ['SUBMITTED'], to: 'UNDER_REVIEW', right: 'bill.review', segregate: ['createdBy', 'submittedBy'], verb: 'taken up for review' },
    approve:     { from: ['UNDER_REVIEW'], to: 'APPROVED', right: 'bill.approve', segregate: ['createdBy', 'submittedBy'], verb: 'approved' },
    reject:      { from: ['UNDER_REVIEW'], to: 'REJECTED', right: 'bill.reject', segregate: ['createdBy', 'submittedBy'], verb: 'rejected', reason: true },
    reopen:      { from: ['REJECTED'], to: 'DRAFT', right: 'bill.edit', verb: 'reopened' },
    enterBatch:  { from: ['APPROVED'], to: 'IN_BATCH', right: null, verb: 'included in a payment batch' },
    leaveBatch:  { from: ['IN_BATCH'], to: 'APPROVED', right: null, verb: 'returned to approved' },
    pay:         { from: ['IN_BATCH'], to: 'PAID', right: null, verb: 'marked paid' }
  };

  var BATCH_TRANSITIONS = {
    edit:     { from: ['DRAFT'], to: 'DRAFT', right: 'batch.create', verb: 'changed' },
    submit:   { from: ['DRAFT'], to: 'PENDING_RELEASE', right: 'batch.submit', verb: 'submitted for release' },
    release:  { from: ['PENDING_RELEASE'], to: 'RELEASED', right: 'batch.release', segregate: ['createdBy', 'submittedBy'], verb: 'released' },
    reject:   { from: ['PENDING_RELEASE'], to: 'REJECTED', right: 'batch.reject', segregate: ['createdBy', 'submittedBy'], verb: 'rejected', reason: true },
    markPaid: { from: ['RELEASED'], to: 'PAID', right: 'batch.markPaid', verb: 'marked paid' }
  };

  var VENDOR_TRANSITIONS = {
    update:          { from: ['DRAFT', 'VERIFYING', 'VERIFIED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'], to: null, right: 'vendor.edit', verb: 'edited' },
    sensitiveEdit:   { from: ['VERIFYING', 'VERIFIED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'], to: 'VERIFYING', right: 'vendor.edit', verb: 'edited' },
    submit:          { from: ['DRAFT'], to: 'VERIFYING', right: 'vendor.verify', verb: 'sent for verification' },
    runVerification: { from: ['VERIFYING'], to: ['VERIFIED', 'NEEDS_REVIEW'], right: 'vendor.verify', verb: 'verified' },
    approve:         { from: ['VERIFIED'], to: 'APPROVED', right: 'vendor.approve', segregate: ['createdBy', 'updatedBy'], verb: 'approved',
                       hints: { NEEDS_REVIEW: 'use an override with a reason', DRAFT: 'run the verification first', VERIFYING: 'run the verification first' } },
    override:        { from: ['NEEDS_REVIEW'], to: 'APPROVED', right: 'vendor.approve', segregate: ['createdBy', 'updatedBy'], verb: 'approved with an override', reason: true },
    reject:          { from: ['VERIFIED', 'NEEDS_REVIEW'], to: 'REJECTED', right: 'vendor.reject', segregate: ['createdBy', 'updatedBy'], verb: 'rejected', reason: true }
  };

  var ACTION_LABELS = {
    'bill.create': 'Bill drafted', 'bill.update': 'Bill edited', 'bill.submit': 'Submitted for approval', 'bill.review': 'Review started',
    'bill.approve': 'Bill approved', 'bill.reject': 'Bill rejected', 'bill.reopen': 'Reopened for correction',
    'bill.inBatch': 'Included in payment batch', 'bill.batchRejected': 'Returned to approved', 'bill.released': 'Released to bank', 'bill.paid': 'Payment recorded',
    'batch.create': 'Payment batch created', 'batch.addBill': 'Bill added to batch', 'batch.removeBill': 'Bill removed from batch',
    'batch.submit': 'Submitted for release', 'batch.release': 'Released to bank', 'batch.reject': 'Batch rejected', 'batch.markPaid': 'Payments confirmed',
    'vendor.create': 'Vendor drafted', 'vendor.update': 'Vendor details edited', 'vendor.bankChange': 'Bank details changed - verification reset',
    'vendor.taxChange': 'Name or tax identity changed - verification reset', 'vendor.submit': 'Sent for verification',
    'vendor.verify': 'Verification completed (simulated)', 'vendor.approve': 'Vendor approved', 'vendor.override': 'Vendor approved with override', 'vendor.reject': 'Vendor rejected'
  };

  /* Descriptive labels only: the Income-tax Act 2025 applies, so no 1961-Act section numbers (DATA-FEASIBILITY.md). */
  var TDS_LABELS = ['TDS - rent', 'TDS - contractor / transport', 'TDS - professional fees'];
  /* Indicative rates for the form helper suggestTds(); perBillThreshold = no deduction at or below this bill value. */
  var TDS_RULES = {
    'TDS - rent': { rate: 0.10, perBillThreshold: 50000 },
    'TDS - contractor / transport': { rate: 0.02, perBillThreshold: 30000 },
    'TDS - professional fees': { rate: 0.10, perBillThreshold: 0 }
  };

  var FLAG_LABELS = {
    DUPLICATE_INVOICE: 'Same vendor and invoice number as another bill',
    POSSIBLE_DUPLICATE: 'Same vendor and amount within 7 days at this unit'
  };

  /* Shared vocabulary for the finance layer: which bill states count against a budget, wait for a decision, or are still owed. */
  var COMMITTED_STATES = ['APPROVED', 'IN_BATCH', 'PAID'];
  var PIPELINE_STATES = ['SUBMITTED', 'UNDER_REVIEW'];
  var PAYABLE_STATES = ['APPROVED', 'IN_BATCH'];

  var NAME_MATCH_THRESHOLD = 0.85;
  var DUPLICATE_WINDOW_DAYS = 7;
  /* Upper bounds on what a form may send. Every action re-serialises whole collections into localStorage, so free text is capped;
   * amounts and dates are held to what a bill of this business can be. */
  var LIMITS = { invoiceNo: 40, description: 500, notes: 500, reason: 500, amount: 50000000, gstShareOfAmount: 0.28, dueDaysAfterInvoice: 180 };
  var SIMULATED_NOTE = 'Simulated in this mockup';

  var ERR = {
    billNotFound: 'Bill not found', batchNotFound: 'Payment batch not found', vendorNotFound: 'Vendor not found',
    badTimestamp: 'Invalid timestamp - use YYYY-MM-DDTHH:MM',
    rejectionReason: 'A rejection reason is required', overrideReason: 'An override reason is required',
    duplicateNeedsNote: 'A note is required to approve a bill flagged as a duplicate invoice',
    noBills: 'Select at least one approved bill', emptyBatch: 'A payment batch needs at least one bill',
    noBankAccount: 'Select the bank account to pay from',
    utrBatch: 'Enter the UTR for the batch', unitRequired: 'Select the unit the bill belongs to',
    vendorRequired: 'Select a vendor', categoryRequired: 'Select an expense category', invoiceNoRequired: 'Enter the vendor invoice number',
    invoiceDate: 'Enter a valid invoice date (YYYY-MM-DD)', dueDate: 'Enter a valid due date (YYYY-MM-DD)',
    monthKey: 'Enter the expense month as YYYY-MM', linesAmount: 'Every expense line needs an amount greater than zero',
    linesShape: 'Expense lines must start with the category and amount of the bill, and may add no more than its GST',
    dueBeforeInvoice: 'Due date cannot be before the invoice date', amount: 'Enter a bill amount greater than zero',
    gstNegative: 'GST amount cannot be negative', gstTooLarge: 'GST cannot exceed 28% of the bill amount', amountTooLarge: 'Bill amount is above the limit of Rs 5 crore for a single bill',
    invoiceNoTooLong: 'Vendor invoice number is limited to 40 characters', textTooLong: 'Description and notes are limited to 500 characters each',
    invoiceDateTooOld: 'Invoice date is before the start of the financial year', monthKeyRange: 'Expense month must lie in the financial year, up to the current month',
    dueTooFar: 'Due date cannot be more than 180 days after the invoice date', reasonTooLong: 'Reasons are limited to 500 characters', tdsNegative: 'TDS amount cannot be negative', tdsTooLarge: 'TDS cannot exceed the bill amount',
    tdsLabelRequired: 'Choose a TDS type for the TDS amount', tdsLabelUnknown: 'Unknown TDS type',
    vendorName: 'Enter the vendor name', vendorUnits: 'Select at least one unit the vendor serves', vendorType: 'Vendor type must be vendor or utility',
    creditDays: 'Credit days must be between 0 and 120', auditEntity: 'Audit entity must be bill, batch, vendor or system', auditAction: 'Audit event needs an action'
  };

  /* --------------------------------------------------------- small helpers */

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function upper(v) { return str(v).toUpperCase(); }
  function pad(n, width) { var s = String(n); while (s.length < width) s = '0' + s; return s; }
  function ok(record, extra) { var r = { ok: true, record: record }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }
  function fail(error, fields) { var r = { ok: false, error: error }; if (fields) r.fields = fields; return r; }
  /* Shallow copy that keeps unknown keys (a seeder may hang its own fields on a record). A key loop is several times faster than Object.assign for records of this width. */
  function copy(rec) {
    var out = {}, keys = Object.keys(rec);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = rec[keys[i]];
    return out;
  }
  function label(state) { return STATE_LABELS[state] || String(state); }
  function money(n) { return MK.fmt.inrFull(n); }

  var lastValidDate = '';
  function isIsoDate(s) {
    if (s && s === lastValidDate) return true; /* a seeder stamps many actions on the same day */
    var valid = typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && MK.dates.addDays(s, 0) === s;
    if (valid) lastValidDate = s;
    return valid;
  }

  /** 'YYYY-MM-DD' -> 10:00 on that day; 'YYYY-MM-DDTHH:MM[:SS]' -> minute precision; anything else -> null. */
  function normaliseStamp(v) {
    var s = str(v);
    if (isIsoDate(s)) return s + 'T10:00';
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(:\d{2})?$/.exec(s);
    if (!m || !isIsoDate(m[1]) || +m[2] > 23 || +m[3] > 59) return null;
    return m[1] + 'T' + m[2] + ':' + m[3];
  }

  /** Whole rupees, or null when empty, or NaN when not a number. */
  function rupees(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? Math.round(n) : NaN;
  }

  function uniqueStrings(list) {
    var seen = {}, out = [];
    (Array.isArray(list) ? list : []).forEach(function (v) { var s = str(v); if (s && !seen[s]) { seen[s] = 1; out.push(s); } });
    return out;
  }

  function allUnits() { return MK.session.ALL_UNITS; }
  function unitExists(id) { return allUnits().indexOf(id) !== -1; }
  function sortUnits(ids) { return allUnits().filter(function (u) { return ids.indexOf(u) !== -1; }); }

  function unitInfo(id) {
    var list = (MK.config && MK.config.outlets) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return { id: id, name: id, type: id === 'factory' ? 'factory' : id === 'ho' ? 'ho' : 'outlet' };
  }

  function categoryInfo(id) {
    var list = (MK.config && MK.config.expenseCategories) || null;
    if (!list) return undefined; /* config not loaded: category ids cannot be validated */
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function bankAccountInfo(id) {
    var ba = MK.config && MK.config.bankAccounts;
    if (!ba) return undefined;
    var list = (ba.current || []).concat(ba.target || []);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function isMasterVendor(id) {
    var list = (MK.config && MK.config.vendors) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return true;
    return false;
  }

  function printable(v) {
    if (v === undefined || v === null) return null;
    if (Array.isArray(v)) return v.map(function (x) { return x && typeof x === 'object' ? (x.name || JSON.stringify(x)) : String(x); }).join(', ');
    return v;
  }

  function diffFields(before, after, keys) {
    var out = [];
    keys.forEach(function (k) {
      var a = before[k], b = after[k];
      var same = (a && typeof a === 'object') || (b && typeof b === 'object') ? JSON.stringify(a) === JSON.stringify(b) : a === b;
      if (!same) out.push({ field: k, before: printable(a), after: printable(b) });
    });
    return out;
  }

  /* ------------------------------------------------- storage: unit of work */
  /*
   * While a unit of work is open, reads and writes go to working copies of the collections and are
   * flushed with one replaceAll() per dirty collection on commit (the kernel serialises a whole
   * collection on every write, so record-by-record upserts would be quadratic when seeding).
   * Records are never mutated in place: a transition copies, changes and saves.
   */

  var work = null;

  function newWork() { return { tables: {}, counters: {}, clockNext: null, clockDirty: false }; }

  function table(name) {
    var t = work.tables[name];
    if (!t) {
      var rows = MK.store.coll(name).all().slice();
      t = work.tables[name] = { rows: rows, pos: null, dirty: false, byVendor: null };
      if (name !== 'audit') { /* the audit log is append-only and never looked up by id */
        t.pos = Object.create(null);
        for (var i = 0; i < rows.length; i++) t.pos[rows[i].id] = i;
      }
    }
    return t;
  }

  function rowsOf(name) { return work ? table(name).rows : MK.store.coll(name).all(); }

  function find(name, id) {
    if (id === null || id === undefined || id === '') return null;
    if (work) { var t = table(name), p = t.pos[id]; return p === undefined ? null : t.rows[p]; }
    return MK.store.coll(name).byId(id);
  }

  /* Only called inside a unit of work. */
  function save(name, rec) {
    var t = table(name), p = t.pos ? t.pos[rec.id] : undefined;
    if (p === undefined) {
      if (t.pos) t.pos[rec.id] = t.rows.length;
      t.rows.push(rec);
      if (t.byVendor && rec.vendorId) (t.byVendor[rec.vendorId] || (t.byVendor[rec.vendorId] = [])).push(t.rows.length - 1);
    } else {
      if (t.byVendor && t.rows[p].vendorId !== rec.vendorId) t.byVendor = null; /* rebuilt on next use */
      t.rows[p] = rec;
    }
    t.dirty = true;
    return rec;
  }

  function commit(w) {
    ['vendors', 'bills', 'batches', 'audit'].forEach(function (name) {
      var t = w.tables[name];
      if (t && t.dirty) MK.store.coll(name).replaceAll(t.rows);
    });
    if (w.clockDirty) {
      var prefs = MK.store.get('prefs', {}) || {};
      prefs.workflowClock = { date: MK.calendar.today, minute: w.clockNext };
      MK.store.set('prefs', prefs);
    }
  }

  /** Runs one transition. Joins an open unit of work (MK.workflow.bulk), otherwise commits on success and discards on failure. */
  function unitOfWork(fn) {
    var outer = !!work, res;
    if (!outer) work = newWork();
    try { res = fn(); }
    catch (e) {
      if (!outer) work = null;
      if (root.console) root.console.error('[MK.workflow]', e);
      return fail('Unexpected error: ' + (e && e.message ? e.message : e));
    }
    if (!outer) { var w = work; work = null; if (res && res.ok) commit(w); }
    return res;
  }

  /** Bills of one vendor (unscoped). Indexed inside a unit of work so that seeding stays linear. */
  function billsOfVendor(vendorId) {
    if (!work) return MK.store.coll('bills').all().filter(function (b) { return b.vendorId === vendorId; });
    var t = table('bills');
    if (!t.byVendor) {
      t.byVendor = Object.create(null);
      for (var i = 0; i < t.rows.length; i++) { var v = t.rows[i].vendorId; if (v) (t.byVendor[v] || (t.byVendor[v] = [])).push(i); }
    }
    return (t.byVendor[vendorId] || []).map(function (p) { return t.rows[p]; });
  }

  /** BILL-2609-0142, PB-2609-07: prefix, year and month of creation, running number within the month. */
  function nextNumber(collName, prefix, at, width) {
    var stem = prefix + '-' + at.slice(2, 4) + at.slice(5, 7) + '-';
    var last = work.counters[stem];
    if (last === undefined) {
      last = 0;
      rowsOf(collName).forEach(function (r) {
        if (typeof r.number === 'string' && r.number.indexOf(stem) === 0) { var n = parseInt(r.number.slice(stem.length), 10); if (n > last) last = n; }
      });
    }
    work.counters[stem] = last + 1;
    return stem + pad(last + 1, width);
  }

  /* ------------------------------------------------ actor, clock, permission */

  var CLOCK_START_MINUTE = 10 * 60, CLOCK_LAST_MINUTE = 23 * 60 + 59;

  function readClock() {
    var today = MK.calendar.today;
    var c = (MK.store.get('prefs', {}) || {}).workflowClock;
    if (c && c.date === today && typeof c.minute === 'number' && isFinite(c.minute)) return c.minute;
    /* First action of a fresh store: start after anything the seeder already stamped today. */
    var minute = CLOCK_START_MINUTE;
    rowsOf('audit').forEach(function (e) {
      if (typeof e.at === 'string' && e.at.slice(0, 10) === today) {
        var m = (+e.at.slice(11, 13)) * 60 + (+e.at.slice(14, 16));
        if (isFinite(m) && m >= minute) minute = m + 1;
      }
    });
    return minute;
  }

  function nextDemoStamp() {
    var minute = work.clockNext === null ? readClock() : work.clockNext;
    work.clockNext = minute + 1;
    work.clockDirty = true;
    var shown = Math.min(minute, CLOCK_LAST_MINUTE); /* past 23:59 the stamp stops; audit ids keep the order */
    return MK.calendar.today + 'T' + pad(Math.floor(shown / 60), 2) + ':' + pad(shown % 60, 2);
  }

  /** Resolves the acting user and the timestamp policy of one call. */
  function begin(options) {
    options = options || {};
    var actor = MK.session.current(), at = null;
    if (options.actorId !== undefined && options.actorId !== null) {
      actor = MK.session.userById(options.actorId);
      if (!actor) return fail('Unknown user: ' + str(options.actorId));
    }
    if (options.at !== undefined && options.at !== null) {
      at = normaliseStamp(options.at);
      if (!at) return fail(ERR.badTimestamp);
    }
    return { ok: true, actor: actor, at: at, audit: options.audit !== false };
  }

  /* The demo clock ticks once per call, and only when the call actually writes. */
  function stamp(ctx) { return ctx.at || (ctx.at = nextDemoStamp()); }

  /*
   * MK.session.can() always judges the current persona. For the seeder's actor override the same
   * kernel rules are evaluated for another user by swapping session.current for the duration of the
   * call; the rights table itself stays in the kernel.
   */
  function canAs(actor, action, c) {
    var session = MK.session;
    if (!actor || session.current().id === actor.id) return session.can(action, c);
    var original = session.current;
    session.current = function () { return actor; };
    try { return session.can(action, c); } finally { session.current = original; }
  }

  /**
   * Role, unit scope and segregation of duties, all judged by the kernel; its reason text is returned as is.
   * The kernel compares the actor with one person per call, so a transition that lists two fields is checked twice.
   */
  function permissionError(actor, transition, rec, unitId) {
    if (!transition.right) return 'This step is driven by the payment batch';
    var people = transition.segregate || ['createdBy'], checked = {};
    for (var i = 0; i < people.length; i++) {
      var who = rec[people[i]] || undefined;
      if (i > 0 && (!who || checked[who])) continue;
      checked[who] = 1;
      var c = { createdBy: who };
      if (unitId) c.unitId = unitId;
      var may = canAs(actor, transition.right, c);
      if (!may.ok) return may.reason;
    }
    return '';
  }

  function stateError(transition, state, noun) {
    if (transition.from.indexOf(state) !== -1) return '';
    var hint = transition.hints && transition.hints[state];
    return 'This ' + noun + ' is ' + label(state) + '; only a ' + noun + ' that is ' + transition.from.map(label).join(' or ') + ' can be ' + transition.verb + (hint ? ' - ' + hint : '');
  }

  /** Permission first, then state. Returns an error string or ''. */
  function guard(actor, transition, rec, unitId, stateField, noun, assumeState) {
    return permissionError(actor, transition, rec, unitId) || stateError(transition, assumeState || rec[stateField], noun);
  }

  /* ---------------------------------------------------------------- audit */

  var AUDIT_ENTITIES = ['bill', 'batch', 'vendor', 'system'];

  function writeAudit(ctx, e) {
    if (!ctx.audit) return null;
    var t = table('audit');
    var ev = {
      id: 'AUD-' + pad(t.rows.length + 1, 6), at: stamp(ctx),
      actorId: ctx.actor.id, actorName: ctx.actor.name, role: ctx.actor.role, roleLabel: ctx.actor.roleLabel,
      entity: e.entity, entityId: e.entityId || null, entityLabel: e.entityLabel || '', unitId: e.unitId || null,
      action: e.action, actionLabel: e.actionLabel || ACTION_LABELS[e.action] || e.action,
      from: e.from || null, to: e.to || null, note: e.note || '', changes: e.changes || []
    };
    if (e.unitIds && e.unitIds.length) ev.unitIds = e.unitIds.slice(); /* records that span units: batches, vendors */
    if (e.refId) ev.refId = e.refId;                                  /* bill events driven by a batch point at it */
    t.rows.push(ev);
    t.dirty = true;
    return ev;
  }

  function allowedMap() { var m = {}; MK.session.allowedUnitIds().forEach(function (id) { m[id] = 1; }); return m; }

  function unitsVisible(unitIds, allowed, needAll) {
    if (!unitIds || !unitIds.length) return true;
    var hit = 0;
    for (var i = 0; i < unitIds.length; i++) if (allowed[unitIds[i]]) hit++;
    return needAll ? hit === unitIds.length : hit > 0;
  }

  /* A batch event may carry totals across units, so it needs every unit; a vendor event needs any one. */
  function auditVisible(e, allowed) {
    if (e.unitId) return !!allowed[e.unitId];
    return unitsVisible(e.unitIds, allowed, e.entity === 'batch');
  }

  var auditCache = { raw: null, sorted: null };
  function newestFirst(a, b) { return a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a.at < b.at ? 1 : -1); }

  /* Raw, unscoped and newest first; cached against the identity of the stored array (it is replaced on every write). */
  function sortedAudit() {
    var raw = rowsOf('audit');
    if (!work && auditCache.raw === raw) return auditCache.sorted;
    var sorted = raw.slice().sort(newestFirst);
    if (!work) auditCache = { raw: raw, sorted: sorted };
    return sorted;
  }

  function auditMatcher(filter) {
    var f = filter || {};
    var from = f.from ? str(f.from) : '', to = f.to ? str(f.to) : '';
    if (to && to.length === 10) to += 'T23:59'; /* a date-only upper bound includes the whole day */
    var search = str(f.search).toLowerCase();
    var entities = f.entity ? [].concat(f.entity) : null, actions = f.action ? [].concat(f.action) : null;
    return function (e) {
      if (entities && entities.indexOf(e.entity) === -1) return false;
      if (f.entityId && e.entityId !== f.entityId) return false;
      if (f.actorId && e.actorId !== f.actorId) return false;
      if (actions && actions.indexOf(e.action) === -1) return false;
      if (f.unitId && e.unitId !== f.unitId && !(e.unitIds && e.unitIds.indexOf(f.unitId) !== -1)) return false;
      if (from && e.at < from) return false;
      if (to && e.at > to) return false;
      if (search && (e.entityLabel + ' ' + e.note + ' ' + e.actorName + ' ' + e.actionLabel).toLowerCase().indexOf(search) === -1) return false;
      return true;
    };
  }

  function auditQuery(filter) {
    var all = sortedAudit(), match = auditMatcher(filter), out = [];
    var allowed = MK.session.seesAllUnits() ? null : allowedMap();
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (allowed && !auditVisible(e, allowed)) continue;
      if (match(e)) out.push(e);
    }
    return out;
  }

  MK.audit = {
    ENTITIES: AUDIT_ENTITIES,

    /**
     * Appends one event. event: { entity, action, entityId?, entityLabel?, unitId?, unitIds?, from?, to?, note?, changes?, actionLabel?,
     * actorId?, at? } - actor and time default to the current persona and the demo clock.
     */
    log: function (event, options) {
      return unitOfWork(function () {
        var e = event || {};
        var ctx = begin({ actorId: has(e, 'actorId') ? e.actorId : (options || {}).actorId, at: has(e, 'at') ? e.at : (options || {}).at });
        if (!ctx.ok) return ctx;
        if (AUDIT_ENTITIES.indexOf(e.entity) === -1) return fail(ERR.auditEntity);
        if (!str(e.action)) return fail(ERR.auditAction);
        return ok(writeAudit(ctx, {
          entity: e.entity, entityId: e.entityId, entityLabel: str(e.entityLabel), unitId: unitExists(e.unitId) ? e.unitId : null,
          unitIds: sortUnits(uniqueStrings(e.unitIds)), action: str(e.action), actionLabel: str(e.actionLabel), from: e.from, to: e.to,
          note: str(e.note), changes: Array.isArray(e.changes) ? e.changes : []
        }));
      });
    },

    /**
     * Events the current persona may see, newest first.
     * filter: { entity, entityId, actorId, unitId, action, from, to, search, order: 'desc' | 'asc', limit, offset }
     * (entity and action accept a string or an array; from / to are ISO dates or 'YYYY-MM-DDTHH:MM', inclusive).
     */
    list: function (filter) {
      var f = filter || {}, out = auditQuery(f);
      if (f.order === 'asc') out.reverse();
      var offset = f.offset > 0 ? Math.floor(f.offset) : 0;
      if (offset || f.limit > 0) out = out.slice(offset, f.limit > 0 ? offset + Math.floor(f.limit) : undefined);
      return out;
    },

    count: function (filter) { return auditQuery(filter).length; },

    /**
     * Oldest-first history of one record, for a timeline: the stored events plus steps derived from the
     * facts on the records themselves (derived: true) wherever no stored event covers them. That gives a
     * bill the release of its payment batch (a batch event, shown here without batch totals) and gives
     * history seeded with { audit: false } a complete timeline. Empty when the record is out of scope.
     */
    trail: function (entity, entityId) {
      var facts = entity === 'bill' ? billFacts(billApi.get(entityId)) : entity === 'batch' ? batchFacts(batchApi.get(entityId))
        : entity === 'vendor' ? vendorFacts(vendorApi.get(entityId)) : null;
      if (!facts) return [];
      var stored = MK.audit.list({ entity: entity, entityId: entityId, order: 'asc' }), seen = {};
      stored.forEach(function (e) { seen[e.action + '|' + e.at] = 1; });
      var extra = facts.filter(function (d) { return !seen[d.action + '|' + d.at]; });
      return extra.length ? stored.concat(extra).sort(function (a, b) { return -newestFirst(a, b); }) : stored;
    },

    /** Maps events onto the field names MK.ui.timeline() expects. Edits (from = to) show no state chips. */
    toTimeline: function (events) {
      return (Array.isArray(events) ? events : []).filter(function (e) { return !!e && typeof e === 'object'; }).map(function (e) {
        var moved = e.from !== e.to;
        return { actor: e.actorName, role: e.roleLabel, action: e.actionLabel, from: moved ? e.from : null, to: moved ? e.to : null, note: e.note, at: e.at };
      });
    }
  };

  /* -------------------------------------------------------------- vendors */

  var VENDOR_FIELDS = ['name', 'type', 'category', 'unitIds', 'creditDays', 'pan', 'gstin', 'bankName', 'ifsc', 'bankAccountMasked',
    'accountHolderName', 'expenseCategoryIds', 'tdsLabel', 'contactName', 'email', 'phone', 'address'];
  var VENDOR_BANK_FIELDS = ['bankAccountMasked', 'ifsc', 'bankName', 'accountHolderName'];
  var VENDOR_TAX_FIELDS = ['gstin', 'pan'];

  var GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var GST_STATES = {
    '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
    '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
    '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
    '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra',
    '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
    '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other territory'
  };
  var PAN_HOLDER_TYPES = {
    P: 'Individual / proprietor', C: 'Company', F: 'Firm / LLP', H: 'Hindu undivided family', A: 'Association of persons', T: 'Trust',
    B: 'Body of individuals', L: 'Local authority', J: 'Artificial juridical person', G: 'Government'
  };
  var IFSC_BANKS = {
    HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', SBIN: 'State Bank of India', UTIB: 'Axis Bank', KKBK: 'Kotak Mahindra Bank', BARB: 'Bank of Baroda',
    MAHB: 'Bank of Maharashtra', YESB: 'Yes Bank', IDFB: 'IDFC First Bank', PUNB: 'Punjab National Bank', CNRB: 'Canara Bank',
    UBIN: 'Union Bank of India', INDB: 'IndusInd Bank', FDRL: 'Federal Bank', IBKL: 'IDBI Bank', BKID: 'Bank of India',
    CBIN: 'Central Bank of India', IOBA: 'Indian Overseas Bank', SRCB: 'Saraswat Co-operative Bank', COSB: 'Cosmos Co-operative Bank'
  };
  /* Fictional account-holder names for the simulated "account is in a different name" outcome. */
  var SIM_PERSON_NAMES = ['RAFIQ A SAYED', 'SUNITA P DESHMUKH', 'MAHESH K RANE', 'FARIDA H LOKHANDWALA', 'DINESH B GUPTA', 'ANTHONY J PEREIRA', 'KAVITA S NAIR', 'SALIM Y PATEL'];

  /** Check character for the first 14 characters of a GSTIN (the published mod-36 algorithm), or null. */
  function gstinCheckChar(first14) {
    var sum = 0;
    for (var i = 0; i < 14; i++) {
      var v = GSTIN_CHARS.indexOf(first14.charAt(i));
      if (v < 0) return null;
      var p = v * (i % 2 === 0 ? 1 : 2);
      sum += Math.floor(p / 36) + (p % 36);
    }
    return GSTIN_CHARS.charAt((36 - (sum % 36)) % 36);
  }

  function maskAccount(raw) { var d = str(raw).replace(/\s+/g, ''); return 'XXXXXXXX' + d.slice(-4); }
  function bankNameKey(s) { return upper(s).replace(/[^A-Z0-9]/g, ''); }

  function preCheck(id, labelText, passed, detail, skipped) { return { id: id, label: labelText, ok: !!passed, skipped: !!skipped, detail: detail }; }

  /**
   * Real, deterministic pre-checks on a vendor-like object (a stored record or live form state):
   * PAN format, GSTIN format, GSTIN check character, GSTIN state code, PAN embedded in the GSTIN,
   * IFSC format, IFSC bank code against the bank name, account number format.
   */
  function vendorPreChecks(v) {
    v = v || {};
    if (v.type === 'utility') return { ok: true, applicable: false, checks: [], failed: [], note: 'Utility biller - paid through the biller, no tax or bank details to verify' };
    var checks = [];
    var pan = upper(v.pan), gstin = upper(v.gstin), ifsc = upper(v.ifsc);

    var panOk = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan);
    checks.push(preCheck('pan_format', 'PAN format', panOk,
      !pan ? 'PAN is missing' : panOk ? 'Valid format - holder type: ' + (PAN_HOLDER_TYPES[pan.charAt(3)] || 'not recognised') : 'Expected 5 letters, 4 digits, 1 letter'));

    if (!gstin) {
      checks.push(preCheck('gstin_format', 'GSTIN format', true, 'No GSTIN given - vendor treated as unregistered under GST', true));
    } else {
      var formatOk = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin);
      checks.push(preCheck('gstin_format', 'GSTIN format', formatOk, formatOk ? '15 characters in the expected pattern' : 'Expected 2-digit state code, PAN, entity number, Z and a check character'));
      if (formatOk) {
        var expected = gstinCheckChar(gstin.slice(0, 14)), sumOk = expected === gstin.charAt(14);
        checks.push(preCheck('gstin_checksum', 'GSTIN check character', sumOk, sumOk ? 'Check character ' + expected + ' is correct' : 'Check character should be ' + expected + ', found ' + gstin.charAt(14)));
        var state = GST_STATES[gstin.slice(0, 2)];
        checks.push(preCheck('gstin_state', 'GSTIN state code', !!state, state ? gstin.slice(0, 2) + ' - ' + state : 'Unknown state code ' + gstin.slice(0, 2)));
      } else {
        checks.push(preCheck('gstin_checksum', 'GSTIN check character', false, 'Not evaluated - the GSTIN format is invalid', true));
      }
      var embedded = gstin.slice(2, 12), embedOk = panOk && embedded === pan;
      checks.push(preCheck('pan_in_gstin', 'PAN matches GSTIN characters 3 to 12', embedOk, embedOk ? 'PAN is embedded in the GSTIN' : 'GSTIN carries ' + (embedded || '-') + ', PAN given is ' + (pan || '-')));
    }

    var ifscOk = /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc);
    checks.push(preCheck('ifsc_format', 'IFSC format', ifscOk, !ifsc ? 'IFSC is missing' : ifscOk ? 'Valid format' : 'Expected 4 letters, a zero, then 6 letters or digits'));
    if (ifscOk) {
      var known = IFSC_BANKS[ifsc.slice(0, 4)], given = str(v.bankName);
      var bankOk = !known || !given || bankNameKey(known) === bankNameKey(given);
      checks.push(preCheck('ifsc_bank', 'IFSC belongs to the named bank', bankOk,
        !known ? 'Bank code ' + ifsc.slice(0, 4) + ' is not in the reference list' : bankOk ? ifsc.slice(0, 4) + ' - ' + known : 'IFSC belongs to ' + known + ', bank given is ' + given, !known));
    }

    var raw = str(v.bankAccount).replace(/\s+/g, ''), masked = str(v.bankAccountMasked);
    var acctOk = raw ? /^[0-9]{9,18}$/.test(raw) : /^X{4,}[0-9]{4}$/.test(masked);
    checks.push(preCheck('account_format', 'Bank account number', acctOk, raw || masked ? (acctOk ? 'Valid format' : 'Expected 9 to 18 digits') : 'Account number is missing'));

    var failed = checks.filter(function (c) { return !c.ok; }).map(function (c) { return c.id; });
    return { ok: failed.length === 0, applicable: true, checks: checks, failed: failed };
  }

  /* Name comparison used by the simulated penny drop: legal-form words are noise, the rest is edit distance. */
  var NAME_NOISE = { M: 1, S: 1, MS: 1, MESSRS: 1, PVT: 1, PRIVATE: 1, LTD: 1, LIMITED: 1, LLP: 1, AND: 1, THE: 1, CO: 1, COMPANY: 1 };
  function nameKey(s) {
    return upper(s).replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').split(' ').filter(function (w) { return w && !NAME_NOISE[w]; }).join(' ');
  }
  function editDistance(a, b) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  function nameSimilarity(a, b) {
    a = nameKey(a); b = nameKey(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    var ratio = 1 - editDistance(a, b) / Math.max(a.length, b.length);
    var shorter = a.length < b.length ? a : b, longer = a.length < b.length ? b : a;
    if (shorter.length >= 8 && longer.indexOf(shorter) === 0) ratio = Math.max(ratio, 0.9); /* banks truncate long names */
    return ratio;
  }

  /* SIMULATED GST registry answer, derived from the vendor id and GSTIN. Vendors of the seeded master always resolve as active. */
  function simulateRegistry(v) {
    if (!str(v.gstin)) return { applicable: false, note: 'No GSTIN - vendor declared as unregistered under GST', simulated: true };
    var rng = MK.rng('verify|gstin|' + v.id + '|' + upper(v.gstin));
    var master = isMasterVendor(v.id);
    var cancelled = !master && rng.chance(0.08);
    var composition = !master && rng.chance(0.12);
    var registeredOn = rng.int(2017, 2023) + '-' + pad(rng.int(1, 12), 2) + '-' + pad(rng.int(1, 28), 2);
    var pan = upper(v.pan);
    return {
      applicable: true, gstin: upper(v.gstin), legalName: upper(v.name), tradeName: str(v.name),
      status: cancelled ? 'Cancelled' : 'Active', taxpayerType: composition ? 'Composition' : 'Regular',
      constitution: PAN_HOLDER_TYPES[pan.charAt(3)] || 'Not recognised', stateCode: upper(v.gstin).slice(0, 2),
      stateName: GST_STATES[upper(v.gstin).slice(0, 2)] || null, registeredOn: registeredOn,
      source: 'GST registry lookup - ' + SIMULATED_NOTE.toLowerCase(), simulated: true
    };
  }

  /*
   * SIMULATED penny drop, derived from the vendor id and the bank details. A master vendor whose bank
   * details are untouched keeps the name-match score of MK.config (nameMatch, 0-100); any bank edit
   * clears that score, so the re-run is derived afresh from the new details.
   */
  function simulatePennyDrop(v) {
    var rng = MK.rng('verify|bank|' + v.id + '|' + upper(v.ifsc) + '|' + str(v.bankAccountMasked));
    var holder = str(v.accountHolderName) || str(v.name);
    var registered, score;
    if (typeof v.nameMatch === 'number') {
      registered = upper(holder);
      score = Math.round(v.nameMatch) / 100;
    } else {
      if (nameKey(holder) !== nameKey(v.name)) registered = upper(holder);           /* the form already names someone else */
      else {
        var proprietor = upper(v.pan).charAt(3) === 'P', u = rng.next();
        if (u < (proprietor ? 0.35 : 0.06)) registered = rng.pick(SIM_PERSON_NAMES); /* account held in a personal name */
        else if (u < 0.55) registered = upper(holder);
        else if (u < 0.80) registered = 'M/S ' + upper(holder);
        else registered = upper(holder).slice(0, 24).trim();                          /* bank field limit */
      }
      var base = nameSimilarity(v.name, registered), jitter = rng.next();
      score = Math.round((base >= 0.9 ? 0.90 + 0.09 * jitter : base * (0.85 + 0.15 * jitter)) * 100) / 100;
    }
    var ifsc = upper(v.ifsc);
    return {
      ifsc: ifsc, bankName: IFSC_BANKS[ifsc.slice(0, 4)] || str(v.bankName) || null, accountMasked: str(v.bankAccountMasked) || null,
      accountStatus: 'Active', registeredName: registered, nameMatchScore: score, threshold: NAME_MATCH_THRESHOLD,
      method: 'Penny drop (Re 1 credit) - ' + SIMULATED_NOTE.toLowerCase(), reference: 'PD' + pad(rng.int(0, 99999999), 8), simulated: true
    };
  }

  function emptyVerification(v) { return { preChecks: vendorPreChecks(v), gstin: null, bank: null, outcome: null, reasons: [], runAt: null, runBy: null, simulated: true }; }

  function vendorLabel(v) { return v.name; }
  function vendorName(id) { var v = find('vendors', id); return v ? v.name : str(id); }

  function vendorInScope(v, allowed) { return !allowed || unitsVisible(v.unitIds, allowed, false); }
  function scopeOrNull() { return MK.session.seesAllUnits() ? null : allowedMap(); }

  function vendorIdFor(name) {
    var slug = str(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'vendor';
    var id = 'v_' + slug, n = 1;
    while (find('vendors', id)) id = 'v_' + slug + '_' + (++n);
    return id;
  }

  /* Builds the editable field set from a draft or a patch laid over an existing record, and validates it. */
  function vendorFields(src, base) {
    src = src || {};
    function pick(k, d) { return has(src, k) ? src[k] : (base ? base[k] : d); }
    var f = {}, errors = {};
    f.name = str(pick('name', ''));
    f.type = str(pick('type', 'vendor')) || 'vendor';
    f.category = str(pick('category', ''));
    f.unitIds = sortUnits(uniqueStrings(pick('unitIds', [])));
    var days = pick('creditDays', 30);
    f.creditDays = days === '' || days === null || days === undefined ? 30 : Math.round(Number(days));
    var utility = f.type === 'utility';
    f.pan = utility ? null : (upper(pick('pan', '')) || null);
    f.gstin = utility ? null : (upper(pick('gstin', '')) || null);
    f.bankName = str(pick('bankName', '')) || null;
    f.ifsc = upper(pick('ifsc', '')) || null;
    f.bankAccountMasked = has(src, 'bankAccount') && str(src.bankAccount) ? maskAccount(src.bankAccount) : (str(pick('bankAccountMasked', '')) || null);
    f.accountHolderName = str(pick('accountHolderName', '')) || (utility ? null : f.name || null);
    f.expenseCategoryIds = uniqueStrings(pick('expenseCategoryIds', []));
    f.tdsLabel = str(pick('tdsLabel', '')) || null;
    ['contactName', 'email', 'phone', 'address'].forEach(function (k) { f[k] = str(pick(k, '')) || null; });

    if (!f.name) errors.name = ERR.vendorName;
    if (f.type !== 'vendor' && f.type !== 'utility') errors.type = ERR.vendorType;
    if (!f.unitIds.length) errors.unitIds = ERR.vendorUnits;
    uniqueStrings(pick('unitIds', [])).forEach(function (u) { if (!unitExists(u)) errors.unitIds = 'Unknown unit: ' + u; });
    if (!isFinite(f.creditDays) || f.creditDays < 0 || f.creditDays > 120) errors.creditDays = ERR.creditDays;
    if (f.tdsLabel && TDS_LABELS.indexOf(f.tdsLabel) === -1) errors.tdsLabel = ERR.tdsLabelUnknown;
    f.expenseCategoryIds.forEach(function (c) { if (categoryInfo(c) === null) errors.expenseCategoryIds = 'Unknown expense category: ' + c; });
    if (has(src, 'bankAccount') && str(src.bankAccount) && !/^[0-9]{9,18}$/.test(str(src.bankAccount).replace(/\s+/g, ''))) errors.bankAccount = 'Bank account number must be 9 to 18 digits';

    var selfId = base ? base.id : null;
    rowsOf('vendors').forEach(function (o) {
      if (o.id === selfId) return;
      if (f.gstin && o.gstin === f.gstin) errors.gstin = 'A vendor with this GSTIN already exists: ' + o.name;
      else if (f.name && str(o.name).toLowerCase() === f.name.toLowerCase()) errors.name = 'A vendor named ' + o.name + ' already exists';
    });
    var keys = Object.keys(errors);
    return keys.length ? fail(errors[keys[0]], errors) : { ok: true, fields: f };
  }

  function vendorMissingForVerification(v) {
    if (v.type === 'utility') return '';
    if (!v.pan) return 'Enter the PAN before verification';
    if (!v.ifsc) return 'Enter the IFSC before verification';
    if (!v.bankAccountMasked) return 'Enter the bank account number before verification';
    return '';
  }

  function vendorHistory(v, ctx, action, from, to, note, changes) {
    var h = (v.history || []).slice();
    var entry = { at: stamp(ctx), actorId: ctx.actor.id, actorName: ctx.actor.name, action: action, from: from, to: to, note: note || '' };
    if (changes && changes.length) entry.changes = changes;
    h.push(entry);
    return h;
  }

  /* Saves a vendor after a transition: embedded history plus the audit event. */
  function commitVendor(ctx, next, action, from, note, changes) {
    next.history = vendorHistory(next, ctx, action, from, next.state, note, changes);
    save('vendors', next);
    writeAudit(ctx, { entity: 'vendor', entityId: next.id, entityLabel: vendorLabel(next), unitIds: next.unitIds, action: action, from: from, to: next.state, note: note, changes: changes });
    return ok(next);
  }

  function vendorTransition(id, name, options, apply) {
    return unitOfWork(function () {
      var ctx = begin(options); if (!ctx.ok) return ctx;
      var v = find('vendors', id); if (!v) return fail(ERR.vendorNotFound);
      var err = guard(ctx.actor, VENDOR_TRANSITIONS[name], v, null, 'state', 'vendor'); if (err) return fail(err);
      return apply(ctx, v);
    });
  }

  /* A reason is free text of at least three characters. */
  /* A reason is typed text: anything else (an object, a number, an event) is not a reason, however it stringifies. */
  function reasonGiven(reason) { return typeof reason === 'string' && reason.trim().length >= 3 && reason.trim().length <= LIMITS.reason; }

  function runVerificationOn(ctx, v, from) {
    var next = copy(v), reasons = [];
    var pre = vendorPreChecks(next), utility = next.type === 'utility';
    var registry = utility ? null : simulateRegistry(next), bank = utility ? null : simulatePennyDrop(next);
    pre.checks.forEach(function (c) { if (!c.ok) reasons.push('Pre-check failed: ' + c.label + ' - ' + c.detail); });
    if (registry && registry.applicable && registry.status !== 'Active') reasons.push('GSTIN status is ' + registry.status + ' in the registry lookup');
    if (bank && bank.nameMatchScore < NAME_MATCH_THRESHOLD) {
      reasons.push('Bank account name match is ' + MK.fmt.pct(bank.nameMatchScore, 0) + ', below the ' + MK.fmt.pct(NAME_MATCH_THRESHOLD, 0) + ' threshold (account held as ' + bank.registeredName + ')');
    }
    next.state = reasons.length ? 'NEEDS_REVIEW' : 'VERIFIED';
    next.verification = { preChecks: pre, gstin: registry, bank: bank, outcome: next.state, reasons: reasons, runAt: stamp(ctx), runBy: ctx.actor.id, simulated: true };
    if (bank) next.nameMatch = Math.round(bank.nameMatchScore * 100);
    var note = utility ? 'Utility biller - no tax or bank verification applies'
      : (reasons.length ? reasons.join('; ') : 'Pre-checks passed; GSTIN ' + (registry.applicable ? registry.status.toLowerCase() : 'not applicable') + '; bank name match ' + MK.fmt.pct(bank.nameMatchScore, 0)) + ' (' + SIMULATED_NOTE.toLowerCase() + ')';
    return commitVendor(ctx, next, 'vendor.verify', from, note);
  }

  var vendorApi = {
    STATES: ['DRAFT', 'VERIFYING', 'VERIFIED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'],
    TRANSITIONS: VENDOR_TRANSITIONS,
    NAME_MATCH_THRESHOLD: NAME_MATCH_THRESHOLD,

    /** Vendors serving at least one unit of the current persona. filter: { state, type, unitId, category, search } */
    list: function (filter) {
      var f = filter || {}, allowed = scopeOrNull(), states = f.state ? [].concat(f.state) : null, q = str(f.search).toLowerCase();
      return rowsOf('vendors').filter(function (v) {
        if (!vendorInScope(v, allowed)) return false;
        if (states && states.indexOf(v.state) === -1) return false;
        if (f.type && v.type !== f.type) return false;
        if (f.unitId && v.unitIds.indexOf(f.unitId) === -1) return false;
        if (f.category && v.category !== f.category) return false;
        if (q && (v.name + ' ' + v.category + ' ' + (v.gstin || '') + ' ' + (v.pan || '')).toLowerCase().indexOf(q) === -1) return false;
        return true;
      });
    },

    get: function (id) { var v = find('vendors', id); return v && vendorInScope(v, scopeOrNull()) ? v : null; },

    /** Display name for any vendor id, regardless of scope (a name is not sensitive; the record is). */
    nameOf: function (id) { return vendorName(id); },

    counts: function () {
      var out = { total: 0 };
      vendorApi.STATES.forEach(function (s) { out[s] = 0; });
      vendorApi.list().forEach(function (v) { out[v.state] = (out[v.state] || 0) + 1; out.total++; });
      return out;
    },

    /** Dry run for buttons: { ok, reason }. action: create | update | submit | runVerification | approve | override | reject */
    can: function (action, idOrRecord) {
      if (action === 'create') { var may = MK.session.can('vendor.create', {}); return { ok: may.ok, reason: may.reason }; }
      var t = VENDOR_TRANSITIONS[action]; if (!t) return { ok: false, reason: 'Unknown action' };
      var v = typeof idOrRecord === 'string' ? find('vendors', idOrRecord) : idOrRecord;
      if (!v) return { ok: false, reason: ERR.vendorNotFound };
      var assume = action === 'runVerification' && v.state === 'DRAFT' ? 'VERIFYING' : null;
      var err = guard(MK.session.current(), t, v, null, 'state', 'vendor', assume);
      return { ok: !err, reason: err };
    },

    preChecks: vendorPreChecks,

    /**
     * draft: { name, type?, category, unitIds, creditDays?, pan, gstin?, bankName, ifsc, bankAccount | bankAccountMasked,
     * accountHolderName?, expenseCategoryIds?, tdsLabel?, contactName?, email?, phone?, address?, id?, nameMatch? }.
     * Always starts in DRAFT. id and nameMatch are honoured for the seeder (master records of MK.config).
     */
    create: function (draft, options) {
      return unitOfWork(function () {
        var ctx = begin(options); if (!ctx.ok) return ctx;
        var may = canAs(ctx.actor, 'vendor.create', {}); if (!may.ok) return fail(may.reason);
        draft = draft || {};
        var v = vendorFields(draft, null); if (!v.ok) return v;
        var id = str(draft.id);
        if (id) {
          if (!/^[a-z][a-z0-9_]{1,40}$/.test(id)) return fail('Vendor id must be lower-case letters, digits and underscores');
          if (find('vendors', id)) return fail('A vendor with id ' + id + ' already exists');
        } else id = vendorIdFor(v.fields.name);
        var rec = Object.assign({ id: id }, v.fields, {
          nameMatch: typeof draft.nameMatch === 'number' ? draft.nameMatch : null, state: 'DRAFT', verification: null,
          createdBy: ctx.actor.id, createdAt: stamp(ctx), updatedBy: null, updatedAt: null, approvedBy: null, approvedAt: null,
          rejectedBy: null, rejectedAt: null, rejectionReason: null, overrideReason: null, history: []
        });
        rec.verification = emptyVerification(rec);
        return commitVendor(ctx, rec, 'vendor.create', null, 'Vendor drafted for ' + rec.unitIds.map(function (u) { return unitInfo(u).name; }).join(', '));
      });
    },

    /**
     * Edits any whitelisted field. A change to the bank account, IFSC, bank name or account holder
     * clears the bank verification; a change to GSTIN, PAN or the name clears the registry result;
     * either one sends a vendor that was past DRAFT back to VERIFYING and withdraws its approval.
     */
    update: function (id, patch, options) {
      return unitOfWork(function () {
        var ctx = begin(options); if (!ctx.ok) return ctx;
        var v = find('vendors', id); if (!v) return fail(ERR.vendorNotFound);
        var err = guard(ctx.actor, VENDOR_TRANSITIONS.update, v, null, 'state', 'vendor'); if (err) return fail(err);
        var checked = vendorFields(patch, v); if (!checked.ok) return checked;
        var f = checked.fields, changes = diffFields(v, f, VENDOR_FIELDS);
        var reentered = has(patch, 'bankAccount') && str(patch.bankAccount) !== '';
        if (reentered && !changes.some(function (c) { return c.field === 'bankAccountMasked'; })) {
          changes.push({ field: 'bankAccountMasked', before: v.bankAccountMasked, after: f.bankAccountMasked }); /* same last four, number re-entered */
        }
        if (!changes.length) return ok(v, { unchanged: true });
        function touched(list) { return changes.some(function (c) { return list.indexOf(c.field) !== -1; }); }
        /* The name is matched against both the registry and the bank account, so a rename invalidates both results. */
        var nameChanged = touched(['name']), bankEdited = touched(VENDOR_BANK_FIELDS);
        var bankChanged = bankEdited || nameChanged, taxChanged = touched(VENDOR_TAX_FIELDS) || nameChanged;

        var next = Object.assign(copy(v), f, { updatedBy: ctx.actor.id, updatedAt: stamp(ctx) });
        var from = v.state, action = 'vendor.update', note = changes.length + (changes.length === 1 ? ' field changed' : ' fields changed');
        if (bankChanged || taxChanged) {
          var old = v.verification || {};
          next.verification = emptyVerification(next);
          if (!taxChanged) next.verification.gstin = old.gstin || null;
          if (!bankChanged) next.verification.bank = old.bank || null;
          if (bankChanged) next.nameMatch = null; /* the score belonged to the previous account */
          if (v.state !== 'DRAFT') {
            next.state = VENDOR_TRANSITIONS.sensitiveEdit.to;
            next.approvedBy = null; next.approvedAt = null; next.overrideReason = null;
            next.rejectedBy = null; next.rejectedAt = null; next.rejectionReason = null;
            action = bankEdited ? 'vendor.bankChange' : 'vendor.taxChange';
            note = (bankEdited ? 'Bank details changed' : 'Name or tax identity changed') + ': verification reset' + (from === 'APPROVED' ? ' and approval withdrawn - the vendor cannot be billed or paid until it is approved again' : '');
          }
        } else {
          next.verification = Object.assign({}, v.verification || emptyVerification(next), { preChecks: vendorPreChecks(next) });
        }
        return commitVendor(ctx, next, action, from, note, changes);
      });
    },

    /** DRAFT -> VERIFYING. */
    submit: function (id, options) {
      return vendorTransition(id, 'submit', options, function (ctx, v) {
        var missing = vendorMissingForVerification(v); if (missing) return fail(missing);
        var next = copy(v); next.state = 'VERIFYING';
        return commitVendor(ctx, next, 'vendor.submit', v.state, 'Pre-checks ' + (vendorPreChecks(v).ok ? 'passed' : 'have failures') + '; registry and bank verification requested');
      });
    },

    /** VERIFYING -> VERIFIED | NEEDS_REVIEW (a DRAFT is first sent for verification). Results are simulated and say so. */
    runVerification: function (id, options) {
      return unitOfWork(function () {
        var ctx = begin(options); if (!ctx.ok) return ctx;
        var v = find('vendors', id); if (!v) return fail(ERR.vendorNotFound);
        var implicit = v.state === 'DRAFT', err;
        if (implicit) {
          err = guard(ctx.actor, VENDOR_TRANSITIONS.submit, v, null, 'state', 'vendor'); if (err) return fail(err);
        }
        err = guard(ctx.actor, VENDOR_TRANSITIONS.runVerification, v, null, 'state', 'vendor', implicit ? 'VERIFYING' : null); if (err) return fail(err);
        var missing = vendorMissingForVerification(v); if (missing) return fail(missing);
        if (implicit) {
          var sent = copy(v); sent.state = 'VERIFYING';
          v = commitVendor(ctx, sent, 'vendor.submit', 'DRAFT', 'Registry and bank verification requested').record;
        }
        return runVerificationOn(ctx, v, 'VERIFYING');
      });
    },

    /** VERIFIED -> APPROVED (payable). */
    approve: function (id, note, options) {
      if (note && typeof note === 'object') { options = note; note = ''; }
      return vendorTransition(id, 'approve', options, function (ctx, v) {
        var next = copy(v);
        next.state = 'APPROVED'; next.approvedBy = ctx.actor.id; next.approvedAt = stamp(ctx); next.overrideReason = null;
        return commitVendor(ctx, next, 'vendor.approve', v.state, str(note) || 'Verification evidence accepted');
      });
    },

    /** NEEDS_REVIEW -> APPROVED with a mandatory reason. */
    override: function (id, reason, options) {
      return vendorTransition(id, 'override', options, function (ctx, v) {
        if (!reasonGiven(reason)) return fail(ERR.overrideReason);
        var next = copy(v), r = str(reason);
        next.state = 'APPROVED'; next.approvedBy = ctx.actor.id; next.approvedAt = stamp(ctx); next.overrideReason = r;
        return commitVendor(ctx, next, 'vendor.override', v.state, 'Override: ' + r);
      });
    },

    /** VERIFIED | NEEDS_REVIEW -> REJECTED with a mandatory reason. */
    reject: function (id, reason, options) {
      return vendorTransition(id, 'reject', options, function (ctx, v) {
        if (!reasonGiven(reason)) return fail(ERR.rejectionReason);
        var next = copy(v), r = str(reason);
        next.state = 'REJECTED'; next.rejectedBy = ctx.actor.id; next.rejectedAt = stamp(ctx); next.rejectionReason = r;
        return commitVendor(ctx, next, 'vendor.reject', v.state, r);
      });
    }
  };

  /* ----------------------------------------------------------------- bills */

  var BILL_EDITABLE = ['unitId', 'vendorId', 'categoryId', 'invoiceNo', 'invoiceDate', 'dueDate', 'monthKey', 'description', 'amount', 'gstAmount',
    'tdsLabel', 'tdsAmount', 'lines', 'attachments', 'notes'];

  function billLabel(b) { return b.number + ' - ' + vendorName(b.vendorId); }
  function invoiceKey(s) { return upper(s).replace(/\s+/g, ''); }

  /* The expense month of a bill: the period the cost belongs to (a utility bill dated 6 Sep covers August). Defaults to the invoice month. */
  function billMonth(b) { return b.monthKey || str(b.invoiceDate).slice(0, 7); }
  function isMonthKey(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(s); }

  /* The financial year (April to March) the demo clock sits in: first day, and the month of "today". */
  function financialYear() {
    var today = MK.calendar.today, y = +today.slice(0, 4), start = (+today.slice(5, 7) >= 4 ? y : y - 1) + '-04-01';
    return { from: start, fromMonth: start.slice(0, 7), toMonth: today.slice(0, 7) };
  }

  /**
   * What a bill costs, by expense category: [{ categoryId, amount }]. GST on a purchase cannot be credited by a 5% restaurant,
   * so it is part of the cost: a bill is expensed at amount + GST (TDS only changes who is paid). Expense lines say where the
   * parts go (rent -> rent, its GST -> rent_gst); whatever they leave unallocated stays with the bill's own category.
   * MK.finance.budget() reads bills by the same rule.
   */
  function expenseParts(b) {
    var cost = (rupees(b.amount) || 0) + (rupees(b.gstAmount) || 0);
    if (Array.isArray(b.lines) && b.lines.length) {
      var parts = b.lines.map(function (l) { return { categoryId: l.categoryId, amount: rupees(l.amount) || 0 }; }), allocated = 0;
      parts.forEach(function (x) { allocated += x.amount; });
      parts[0].amount += cost - allocated;
      return parts;
    }
    return [{ categoryId: b.categoryId || null, amount: cost }];
  }

  /* Optional expense allocation of a bill: [{ categoryId, amount }] in whole rupees, or null. */
  function cleanLines(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return list.map(function (l) { return { categoryId: str(l && l.categoryId), amount: rupees(l ? l.amount : null) }; });
  }

  /* Normalised invoice number of a stored bill. Records are copy-on-write, so the object identity is a safe cache key. */
  var invoiceKeys = typeof WeakMap === 'function' ? new WeakMap() : null;
  function storedInvoiceKey(b) {
    if (!invoiceKeys) return invoiceKey(b.invoiceNo);
    var k = invoiceKeys.get(b);
    if (k === undefined) { k = invoiceKey(b.invoiceNo); invoiceKeys.set(b, k); }
    return k;
  }

  function vendorBillable(vendor, purpose) {
    if (!vendor) return 'Vendor not found';
    if (vendor.state !== 'APPROVED') return 'Vendor ' + vendor.name + ' is not approved for ' + purpose + ' (currently ' + label(vendor.state) + ')';
    return '';
  }

  function cleanAttachments(list) {
    return (Array.isArray(list) ? list : []).map(function (a) { return { name: str(a && typeof a === 'object' ? a.name : a).slice(0, 120) }; })
      .filter(function (a) { return a.name; });
  }

  /* Builds and validates the editable fields of a bill from a draft, or from a patch laid over an existing bill. */
  function billFields(src, base) {
    src = src || {};
    function pick(k, d) { return has(src, k) ? src[k] : (base ? base[k] : d); }
    var f = {}, e = {};
    f.unitId = str(pick('unitId', ''));
    f.vendorId = str(pick('vendorId', ''));
    f.categoryId = str(pick('categoryId', ''));
    f.invoiceNo = str(pick('invoiceNo', ''));
    f.invoiceDate = str(pick('invoiceDate', ''));
    f.description = str(pick('description', ''));
    f.amount = rupees(pick('amount', null));
    f.gstAmount = rupees(pick('gstAmount', 0)) || 0;
    f.tdsAmount = rupees(pick('tdsAmount', 0)) || 0;
    f.tdsLabel = str(pick('tdsLabel', '')) || null;
    f.attachments = cleanAttachments(pick('attachments', []));
    f.notes = str(pick('notes', ''));

    if (!f.unitId) e.unitId = ERR.unitRequired; else if (!unitExists(f.unitId)) e.unitId = 'Unknown unit: ' + f.unitId;
    var vendor = f.vendorId ? find('vendors', f.vendorId) : null;
    if (!f.vendorId) e.vendorId = ERR.vendorRequired;
    else { var vErr = vendorBillable(vendor, 'billing'); if (vErr) e.vendorId = vErr; }
    var cat = f.categoryId ? categoryInfo(f.categoryId) : null;
    if (!f.categoryId) e.categoryId = ERR.categoryRequired;
    else if (cat === null) e.categoryId = 'Unknown expense category: ' + f.categoryId;
    else if (cat && !e.unitId && cat.units.indexOf(unitInfo(f.unitId).type) === -1) e.categoryId = 'Expense category ' + cat.label + ' does not apply to ' + unitInfo(f.unitId).name;
    var fy = financialYear();
    if (!f.invoiceNo) e.invoiceNo = ERR.invoiceNoRequired;
    else if (f.invoiceNo.length > LIMITS.invoiceNo) e.invoiceNo = ERR.invoiceNoTooLong;
    if (f.description.length > LIMITS.description || f.notes.length > LIMITS.notes) e.description = ERR.textTooLong;
    if (!isIsoDate(f.invoiceDate)) e.invoiceDate = ERR.invoiceDate;
    else if (f.invoiceDate > MK.calendar.today) e.invoiceDate = 'Invoice date cannot be after today (' + MK.dates.label(MK.calendar.today, 'd MMM yyyy') + ')';
    else if (f.invoiceDate < fy.from) e.invoiceDate = ERR.invoiceDateTooOld;

    /* Due date: as given; otherwise invoice date plus the vendor's credit days (also when the patch moved the invoice date or vendor). */
    var dueGiven = has(src, 'dueDate') && str(src.dueDate) !== '';
    var moved = base && (f.invoiceDate !== base.invoiceDate || f.vendorId !== base.vendorId);
    if (dueGiven) f.dueDate = str(src.dueDate);
    else if (base && base.dueDate && !moved) f.dueDate = base.dueDate;
    else f.dueDate = isIsoDate(f.invoiceDate) ? MK.dates.addDays(f.invoiceDate, vendor && isFinite(vendor.creditDays) ? vendor.creditDays : 0) : '';
    if (f.dueDate && !isIsoDate(f.dueDate)) e.dueDate = ERR.dueDate;
    else if (f.dueDate && !e.invoiceDate && f.dueDate < f.invoiceDate) e.dueDate = ERR.dueBeforeInvoice;
    else if (f.dueDate && !e.invoiceDate && MK.dates.diffDays(f.invoiceDate, f.dueDate) > LIMITS.dueDaysAfterInvoice) e.dueDate = ERR.dueTooFar;

    /* Expense month: as given; otherwise it follows the invoice date unless the bill already names a different period. */
    var monthGiven = has(src, 'monthKey') && str(src.monthKey) !== '';
    var ownMonth = base && base.monthKey && base.monthKey !== str(base.invoiceDate).slice(0, 7);
    f.monthKey = monthGiven ? str(src.monthKey) : (ownMonth ? base.monthKey : f.invoiceDate.slice(0, 7));
    if (monthGiven && !isMonthKey(f.monthKey)) e.monthKey = ERR.monthKey;
    else if (monthGiven && (f.monthKey < fy.fromMonth || f.monthKey > fy.toMonth)) e.monthKey = ERR.monthKeyRange;

    if (f.amount === null || isNaN(f.amount) || f.amount <= 0) e.amount = ERR.amount;
    else if (f.amount > LIMITS.amount) e.amount = ERR.amountTooLarge;
    if (isNaN(f.gstAmount) || f.gstAmount < 0) e.gstAmount = ERR.gstNegative;
    else if (!e.amount && f.gstAmount > Math.ceil(f.amount * LIMITS.gstShareOfAmount)) e.gstAmount = ERR.gstTooLarge;
    if (isNaN(f.tdsAmount) || f.tdsAmount < 0) e.tdsAmount = ERR.tdsNegative;
    else if (!e.amount && f.tdsAmount > f.amount) e.tdsAmount = ERR.tdsTooLarge;
    if (f.tdsLabel && TDS_LABELS.indexOf(f.tdsLabel) === -1) e.tdsLabel = ERR.tdsLabelUnknown;
    else if (f.tdsAmount > 0 && !f.tdsLabel) e.tdsLabel = ERR.tdsLabelRequired;

    /*
     * Expense lines (optional): how the bill hits the budget when it is more than "amount to categoryId". The first line repeats
     * the bill's own category and amount; further lines expense non-creditable GST to a category of its own (rent -> rent_gst),
     * so together they can add at most the GST. An edit of category, amount or GST that does not restate the lines drops them.
     */
    var restated = has(src, 'lines');
    var reshaped = base && (f.categoryId !== base.categoryId || f.amount !== base.amount || f.gstAmount !== base.gstAmount || f.unitId !== base.unitId);
    f.lines = restated ? cleanLines(src.lines) : (base && !reshaped ? (base.lines || null) : null);
    if (f.lines && restated) {
      var extra = 0, unitType = e.unitId ? null : unitInfo(f.unitId).type;
      f.lines.forEach(function (l, i) {
        var lc = categoryInfo(l.categoryId);
        if (lc === null) e.lines = e.lines || 'Unknown expense category: ' + l.categoryId;
        else if (lc && unitType && lc.units.indexOf(unitType) === -1) e.lines = e.lines || 'Expense category ' + lc.label + ' does not apply to ' + unitInfo(f.unitId).name;
        if (l.amount === null || isNaN(l.amount) || l.amount <= 0) e.lines = e.lines || ERR.linesAmount;
        else if (i > 0) extra += l.amount;
      });
      if (!e.lines && !e.amount && (f.lines[0].categoryId !== f.categoryId || f.lines[0].amount !== f.amount || extra > f.gstAmount)) e.lines = ERR.linesShape;
    }

    f.payable = (f.amount || 0) + (f.gstAmount || 0) - (f.tdsAmount || 0); /* whole rupees in, whole rupees out */
    var order = ['unitId', 'vendorId', 'categoryId', 'invoiceNo', 'invoiceDate', 'dueDate', 'monthKey', 'amount', 'gstAmount', 'tdsAmount', 'tdsLabel', 'lines', 'description'];
    for (var i = 0; i < order.length; i++) if (e[order[i]]) return fail(e[order[i]], e);
    return { ok: true, fields: f };
  }

  /* Other live bills that look like the same invoice. Rejected bills are ignored: they will never be paid. */
  function duplicateScan(b) {
    var out = { exact: [], possible: [] };
    if (!b || !b.vendorId) return out;
    var key = invoiceKey(b.invoiceNo), dated = isIsoDate(b.invoiceDate), amount = rupees(b.amount);   /* a form field delivers the amount as a string */
    billsOfVendor(b.vendorId).forEach(function (o) {
      if (o.id === b.id || o.status === 'REJECTED') return;
      if (key && storedInvoiceKey(o) === key) out.exact.push(o);
      else if (dated && amount > 0 && o.amount === amount && o.unitId === b.unitId &&
        Math.abs(MK.dates.diffDays(o.invoiceDate, b.invoiceDate)) <= DUPLICATE_WINDOW_DAYS) out.possible.push(o);
    });
    return out;
  }

  function billFlags(b) {
    var d = duplicateScan(b), flags = [];
    if (d.exact.length) flags.push('DUPLICATE_INVOICE');
    if (d.possible.length) flags.push('POSSIBLE_DUPLICATE');
    return flags;
  }

  function billAudit(ctx, b, action, from, note, changes, refId) {
    writeAudit(ctx, { entity: 'bill', entityId: b.id, entityLabel: billLabel(b), unitId: b.unitId, action: action, from: from, to: b.status, note: note, changes: changes, refId: refId });
  }

  function billGuard(actor, name, b, assumeState) { return guard(actor, BILL_TRANSITIONS[name], b, b.unitId, 'status', 'bill', assumeState); }

  /* Editing: permission, then the batch lock (the more useful message for a bill reserved by a draft batch), then state. */
  function billEditError(actor, b) {
    var t = BILL_TRANSITIONS.update;
    return permissionError(actor, t, b, b.unitId) ||
      (b.batchId ? 'This bill is in payment batch ' + b.batchId + ' and cannot be edited' : '') ||
      stateError(t, b.status, 'bill');
  }

  function resolveBill(idOrRecord) { return typeof idOrRecord === 'string' ? find('bills', idOrRecord) : (idOrRecord || null); }
  /* For the read helpers: an id resolves only inside the persona's units, and a record of another unit reads as nothing. */
  function resolveBillInScope(idOrRecord) {
    var b = typeof idOrRecord === 'string' ? billApi.get(idOrRecord) : (idOrRecord && typeof idOrRecord === 'object' ? idOrRecord : null);
    return b && (!b.unitId || allowedMap()[b.unitId]) ? b : null;
  }

  /* The decision step shared by approve and reject. A SUBMITTED bill is first taken up for review by the same actor. */
  function decideBill(id, name, text, options) {
    return unitOfWork(function () {
      var ctx = begin(options); if (!ctx.ok) return ctx;
      var b = find('bills', id); if (!b) return fail(ERR.billNotFound);
      var implicit = b.status === 'SUBMITTED', err;
      if (implicit) { err = billGuard(ctx.actor, 'startReview', b); if (err) return fail(err); }
      err = billGuard(ctx.actor, name, b, implicit ? 'UNDER_REVIEW' : null); if (err) return fail(err);

      var note = typeof text === 'string' ? str(text).slice(0, LIMITS.notes) : '';
      if (name === 'reject') {
        if (!reasonGiven(text)) return fail(ERR.rejectionReason);
      } else {
        var vErr = vendorBillable(find('vendors', b.vendorId), 'billing');
        if (vErr) return fail(vErr + ' - the bill cannot be approved until the vendor is approved again');
        if (!note && duplicateScan(b).exact.length) return fail(ERR.duplicateNeedsNote);
      }

      var next = copy(b), from = b.status;
      if (implicit) {
        next.status = 'UNDER_REVIEW'; next.reviewedBy = ctx.actor.id; next.reviewedAt = stamp(ctx);
        billAudit(ctx, next, 'bill.review', from, '');
        from = 'UNDER_REVIEW';
      }
      next.status = BILL_TRANSITIONS[name].to;
      next.decidedBy = ctx.actor.id; next.decidedAt = stamp(ctx);
      next.rejectionReason = name === 'reject' ? note : null;
      if (!next.reviewedBy) next.reviewedBy = ctx.actor.id;
      if (!next.reviewedAt) next.reviewedAt = next.decidedAt;
      save('bills', next);
      billAudit(ctx, next, name === 'reject' ? 'bill.reject' : 'bill.approve', from, note);
      return ok(next);
    });
  }

  function budgetLines(res) {
    if (Array.isArray(res)) return res;
    if (res && typeof res === 'object') return res.lines || res.rows || res.categories || res.items || [];
    return [];
  }

  var billApi = {
    STATES: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'IN_BATCH', 'PAID'],
    TRANSITIONS: BILL_TRANSITIONS,
    COMMITTED_STATES: COMMITTED_STATES,
    PIPELINE_STATES: PIPELINE_STATES,
    PAYABLE_STATES: PAYABLE_STATES,
    TDS_LABELS: TDS_LABELS,
    FLAGS: FLAG_LABELS,

    /**
     * Bills of the units the current persona may see, newest first.
     * filter: { status, unitId, unitIds, vendorId, categoryId, batchId, createdBy, from, to (invoice date), monthKey, flagged, unbatched, search }
     */
    list: function (filter) {
      var f = filter || {}, allowed = allowedMap(), statuses = f.status ? [].concat(f.status) : null;
      var units = f.unitIds && f.unitIds.length ? f.unitIds : (f.unitId ? [f.unitId] : null), q = str(f.search).toLowerCase();
      var out = rowsOf('bills').filter(function (b) {
        if (!allowed[b.unitId]) return false;
        if (units && units.indexOf(b.unitId) === -1) return false;
        if (statuses && statuses.indexOf(b.status) === -1) return false;
        if (f.vendorId && b.vendorId !== f.vendorId) return false;
        if (f.categoryId && b.categoryId !== f.categoryId) return false;
        if (f.batchId && b.batchId !== f.batchId) return false;
        if (f.createdBy && b.createdBy !== f.createdBy) return false;
        if (f.from && b.invoiceDate < f.from) return false;
        if (f.to && b.invoiceDate > f.to) return false;
        if (f.monthKey && billMonth(b) !== f.monthKey) return false;
        if (f.flagged && !(b.flags && b.flags.length)) return false;
        if (f.unbatched && b.batchId) return false;
        if (q && (b.number + ' ' + b.invoiceNo + ' ' + b.description + ' ' + vendorName(b.vendorId)).toLowerCase().indexOf(q) === -1) return false;
        return true;
      });
      return out.sort(function (a, b) { return a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : (a.createdAt < b.createdAt ? 1 : -1); });
    },

    get: function (id) { var b = find('bills', id); return b && allowedMap()[b.unitId] ? b : null; },

    /** Count and payable value per status for the persona's units, plus the approval queue (SUBMITTED + UNDER_REVIEW). */
    counts: function (filter) {
      var out = { total: 0, totalPayable: 0, awaitingApproval: 0, awaitingApprovalPayable: 0, byStatus: {} };
      billApi.STATES.forEach(function (s) { out.byStatus[s] = { count: 0, payable: 0 }; });
      billApi.list(filter).forEach(function (b) {
        var s = out.byStatus[b.status] || (out.byStatus[b.status] = { count: 0, payable: 0 });
        s.count++; s.payable += b.payable; out.total++; out.totalPayable += b.payable;
        if (PIPELINE_STATES.indexOf(b.status) !== -1) { out.awaitingApproval++; out.awaitingApprovalPayable += b.payable; }
      });
      return out;
    },

    /** What a bill (record or form state) costs by expense category: [{ categoryId, amount }], amount + GST allocated by its expense lines. */
    expenseParts: function (billLike) { return billLike && typeof billLike === 'object' ? expenseParts(billLike) : []; },

    /** Expense categories that apply to a unit (for the bill form). */
    categoriesFor: function (unitId) {
      var type = unitInfo(unitId).type;
      return ((MK.config && MK.config.expenseCategories) || []).filter(function (c) { return c.units.indexOf(type) !== -1; });
    },

    /** Indicative TDS for the form: { tdsLabel, rate, tdsAmount, applies, note } from the vendor's TDS type. Thresholds are per bill only. */
    suggestTds: function (vendorId, amount) {
      var v = find('vendors', vendorId), lbl = v ? v.tdsLabel : null, rule = lbl ? TDS_RULES[lbl] : null, amt = rupees(amount) || 0;
      if (!rule) return { tdsLabel: null, rate: 0, tdsAmount: 0, applies: false, note: 'No TDS type on the vendor master' };
      var applies = amt > rule.perBillThreshold;
      return { tdsLabel: applies ? lbl : null, rate: rule.rate, tdsAmount: applies ? Math.round(amt * rule.rate) : 0, applies: applies,
        note: applies ? 'Indicative rate on the pre-tax amount' : 'Bill value is within the threshold of ' + money(rule.perBillThreshold) };
    },

    /** Dry run for buttons: { ok, reason }. action: create (pass { unitId }) | update | submit | startReview | approve | reject | reopen */
    can: function (action, idOrRecord) {
      if (action === 'create') {
        var c = idOrRecord && idOrRecord.unitId ? { unitId: idOrRecord.unitId } : {};
        var may = MK.session.can('bill.create', c); return { ok: may.ok, reason: may.reason };
      }
      var t = BILL_TRANSITIONS[action]; if (!t || !t.right) return { ok: false, reason: 'Unknown action' };
      var b = resolveBill(idOrRecord); if (!b) return { ok: false, reason: ERR.billNotFound };
      var actor = MK.session.current(), err;
      if (action === 'update') err = billEditError(actor, b);
      else if ((action === 'approve' || action === 'reject') && b.status === 'SUBMITTED') err = billGuard(actor, 'startReview', b) || billGuard(actor, action, b, 'UNDER_REVIEW');
      else err = billGuard(actor, action, b);
      return { ok: !err, reason: err };
    },

    /**
     * draft: { unitId, vendorId, categoryId, invoiceNo, invoiceDate, dueDate?, description?, amount, gstAmount?, tdsLabel?, tdsAmount?, attachments?, notes? }
     * The vendor must be APPROVED. dueDate defaults to invoiceDate + the vendor's credit days.
     */
    create: function (draft, options) {
      return unitOfWork(function () {
        var ctx = begin(options); if (!ctx.ok) return ctx;
        var unitId = str((draft || {}).unitId);
        if (unitId && !unitExists(unitId)) return fail('Unknown unit: ' + unitId);
        var may = canAs(ctx.actor, 'bill.create', unitId ? { unitId: unitId } : {}); if (!may.ok) return fail(may.reason);
        var checked = billFields(draft, null); if (!checked.ok) return checked;
        var at = stamp(ctx), number = nextNumber('bills', 'BILL', at, 4), f = checked.fields;
        /* The bill record, in full. id and number are the same string today; key on id, display number. */
        var rec = {
          id: number, number: number, unitId: f.unitId, vendorId: f.vendorId, categoryId: f.categoryId,
          invoiceNo: f.invoiceNo, invoiceDate: f.invoiceDate, dueDate: f.dueDate, monthKey: f.monthKey, description: f.description,
          lines: f.lines, amount: f.amount, gstAmount: f.gstAmount, tdsLabel: f.tdsLabel, tdsAmount: f.tdsAmount, payable: f.payable,
          attachments: f.attachments, status: 'DRAFT', createdBy: ctx.actor.id, createdAt: at,
          submittedBy: null, submittedAt: null, reviewedBy: null, reviewedAt: null, decidedBy: null, decidedAt: null, rejectionReason: null,
          batchId: null, paidAt: null, utr: null, notes: f.notes, flags: []
        };
        rec.flags = billFlags(rec);
        save('bills', rec);
        billAudit(ctx, rec, 'bill.create', null, money(rec.payable) + ' payable, invoice ' + rec.invoiceNo + ', ' + unitInfo(rec.unitId).name);
        return ok(rec);
      });
    },

    /** DRAFT or REJECTED only. Editing a REJECTED bill takes it back to DRAFT (SPEC: REJECTED -> DRAFT, edit, resubmit). */
    update: function (id, patch, options) {
      return unitOfWork(function () {
        var ctx = begin(options); if (!ctx.ok) return ctx;
        var b = find('bills', id); if (!b) return fail(ERR.billNotFound);
        var err = billEditError(ctx.actor, b); if (err) return fail(err);
        var checked = billFields(patch, b); if (!checked.ok) return checked;
        var f = checked.fields;
        if (f.unitId !== b.unitId) { /* moving a bill to another unit needs rights there too */
          var may = canAs(ctx.actor, 'bill.edit', { unitId: f.unitId, createdBy: b.createdBy }); if (!may.ok) return fail(may.reason);
        }
        var changes = diffFields(b, f, BILL_EDITABLE.concat(['payable']));
        if (!changes.length) return ok(b, { unchanged: true });
        var next = Object.assign(copy(b), f, { status: 'DRAFT' });
        next.flags = billFlags(next);
        save('bills', next);
        billAudit(ctx, next, 'bill.update', b.status, changes.length + (changes.length === 1 ? ' field changed' : ' fields changed'), changes);
        return ok(next);
      });
    },

    /** DRAFT -> SUBMITTED. Re-validates the bill (the vendor may have lost its approval since the draft) and refreshes the duplicate flags. */
    submit: function (id, options) {
      return unitOfWork(function () {
        var ctx = begin(options); if (!ctx.ok) return ctx;
        var b = find('bills', id); if (!b) return fail(ERR.billNotFound);
        var err = billGuard(ctx.actor, 'submit', b); if (err) return fail(err);
        var checked = billFields({}, b); if (!checked.ok) return checked;
        var next = copy(b);
        next.status = 'SUBMITTED'; next.submittedBy = ctx.actor.id; next.submittedAt = stamp(ctx);
        next.reviewedBy = null; next.reviewedAt = null; next.decidedBy = null; next.decidedAt = null; next.rejectionReason = null;
        next.flags = billFlags(next);
        save('bills', next);
        billAudit(ctx, next, 'bill.submit', b.status, next.flags.map(function (k) { return FLAG_LABELS[k]; }).join('; '));
        return ok(next);
      });
    },

    /** SUBMITTED -> UNDER_REVIEW. */
    startReview: function (id, options) {
      return unitOfWork(function () {
        var ctx = begin(options); if (!ctx.ok) return ctx;
        var b = find('bills', id); if (!b) return fail(ERR.billNotFound);
        var err = billGuard(ctx.actor, 'startReview', b); if (err) return fail(err);
        var next = copy(b); next.status = 'UNDER_REVIEW'; next.reviewedBy = ctx.actor.id; next.reviewedAt = stamp(ctx);
        save('bills', next);
        billAudit(ctx, next, 'bill.review', b.status, '');
        return ok(next);
      });
    },

    /** UNDER_REVIEW -> APPROVED. A note is mandatory when another live bill carries the same vendor invoice number. */
    approve: function (id, note, options) {
      if (note && typeof note === 'object') { options = note; note = ''; }
      return decideBill(id, 'approve', note, options);
    },

    /** UNDER_REVIEW -> REJECTED; the reason is mandatory. */
    reject: function (id, reason, options) { return decideBill(id, 'reject', reason, options); },

    /** REJECTED -> DRAFT without changing any field. */
    reopen: function (id, options) {
      return unitOfWork(function () {
        var ctx = begin(options); if (!ctx.ok) return ctx;
        var b = find('bills', id); if (!b) return fail(ERR.billNotFound);
        var err = billGuard(ctx.actor, 'reopen', b); if (err) return fail(err);
        var next = copy(b); next.status = 'DRAFT';
        save('bills', next);
        billAudit(ctx, next, 'bill.reopen', b.status, b.rejectionReason ? 'Rejected earlier: ' + b.rejectionReason : '');
        return ok(next);
      });
    },

    /**
     * Live duplicate check for a stored bill, a bill id or unsaved form state { id?, vendorId, unitId, invoiceNo, invoiceDate, amount }.
     * Matches outside the persona's units are reported without their details.
     */
    duplicateCheck: function (billLike) {
      var b = resolveBillInScope(billLike), scan = duplicateScan(b), allowed = allowedMap(), matches = [];
      function add(o, reason, text) {
        var inScope = !!allowed[o.unitId];
        matches.push(inScope
          ? { reason: reason, label: text, inScope: true, billId: o.id, number: o.number, unitId: o.unitId, status: o.status, invoiceNo: o.invoiceNo, invoiceDate: o.invoiceDate, amount: o.amount, payable: o.payable }
          : { reason: reason, label: text, inScope: false, billId: null, number: o.number, unitId: o.unitId, status: null, invoiceNo: null, invoiceDate: null, amount: null, payable: null });
      }
      scan.exact.forEach(function (o) { add(o, 'SAME_INVOICE_NO', 'Same vendor and invoice number'); });
      scan.possible.forEach(function (o) { add(o, 'SAME_AMOUNT_WITHIN_7_DAYS', 'Same vendor and amount within ' + DUPLICATE_WINDOW_DAYS + ' days'); });
      return { hasExact: scan.exact.length > 0, hasPossible: scan.possible.length > 0, matches: matches };
    },

    /**
     * What approving this bill does to its budget line (category x unit x expense month), from MK.finance.budget when that layer is loaded.
     * Returns { available, monthKey, unitId, categoryId, amount, budget, committed, pipeline, afterThis, remainingAfter, utilisationAfter,
     * status: 'WITHIN' | 'NEAR' | 'OVER' | null, alreadyCommitted }. amount = what the bill costs its own category: amount + GST (no input
     * credit), less what its expense lines send elsewhere (the GST of a rent bill goes to rent_gst). A bill id or record outside the
     * persona's units reads as nothing: available false, every field null.
     */
    budgetImpact: function (billLike) {
      var b = resolveBillInScope(billLike) || {};
      var out = { available: false, monthKey: isMonthKey(str(b.monthKey)) ? b.monthKey : (isIsoDate(b.invoiceDate) ? b.invoiceDate.slice(0, 7) : null), unitId: b.unitId || null, categoryId: b.categoryId || null,
        amount: b.categoryId ? expenseParts(b)[0].amount : 0, budget: null, committed: null, pipeline: null, afterThis: null, remainingAfter: null, utilisationAfter: null,
        status: null, alreadyCommitted: COMMITTED_STATES.indexOf(b.status) !== -1 };
      if (!out.monthKey || !out.unitId || !out.categoryId || !MK.finance || typeof MK.finance.budget !== 'function') return out;
      var line = null;
      try {
        var lines = budgetLines(MK.finance.budget(out.monthKey, out.unitId));
        for (var i = 0; i < lines.length; i++) if (lines[i] && (lines[i].categoryId || lines[i].id) === out.categoryId) { line = lines[i]; break; }
      } catch (e) { line = null; }
      /* MK.finance.budget() calls the figure 'plan'; 'budget' is accepted for any other provider of the same contract */
      var planned = line ? (typeof line.budget === 'number' ? line.budget : line.plan) : null;
      if (typeof planned !== 'number') return out;
      var policy = (MK.config && MK.config.budgetPolicy) || { warnAtPct: 0.9, overAtPct: 1 };
      out.available = true;
      out.budget = planned; out.committed = line.committed || 0; out.pipeline = line.pipeline || 0;
      out.afterThis = out.committed + (out.alreadyCommitted ? 0 : out.amount);
      out.remainingAfter = out.budget - out.afterThis;
      out.utilisationAfter = out.budget > 0 ? out.afterThis / out.budget : null;
      out.status = out.budget <= 0 ? (out.afterThis > 0 ? 'OVER' : 'WITHIN')
        : out.utilisationAfter > policy.overAtPct ? 'OVER' : out.utilisationAfter >= policy.warnAtPct ? 'NEAR' : 'WITHIN';
      return out;
    }
  };

  /* --------------------------------------------------------------- batches */

  function batchLabel(p) { return p.number; }
  function batchInScope(p, allowed) { return !allowed || unitsVisible(p.unitIds, allowed, true); }

  function resolveBankAccount(id) {
    var given = str(id);
    if (!given) { /* default: the main operating account of the current structure */
      var ba = MK.config && MK.config.bankAccounts, first = ba && ba.current && ba.current[0];
      if (!first) return fail(ERR.noBankAccount);
      return { ok: true, id: first.id };
    }
    if (bankAccountInfo(given) === null) return fail('Unknown bank account: ' + given);
    return { ok: true, id: given };
  }

  /* A bill may join a batch when it is approved, not already in a batch, and its vendor is still approved. */
  function billBatchable(b, batchId) {
    if (!b) return ERR.billNotFound;
    if (b.status !== 'APPROVED') return 'Bill ' + b.number + ' is ' + label(b.status) + '; only approved bills can be added to a payment batch';
    if (b.batchId && b.batchId !== batchId) return 'Bill ' + b.number + ' is already in payment batch ' + b.batchId;
    var vErr = vendorBillable(find('vendors', b.vendorId), 'payment');
    return vErr ? vErr + ' - bill ' + b.number : '';
  }

  /* Paying is refused while any vendor in the batch is not APPROVED, for example after a bank-detail change. */
  function batchVendorError(p) {
    for (var i = 0; i < p.billIds.length; i++) {
      var b = find('bills', p.billIds[i]), vErr = vendorBillable(b ? find('vendors', b.vendorId) : null, 'payment');
      if (vErr) return vErr + ' - bill ' + (b ? b.number : p.billIds[i]) + '; reject the batch or wait for the vendor to be approved again';
    }
    return '';
  }

  function batchTotals(billIds) {
    var total = 0, units = [];
    billIds.forEach(function (id) { var b = find('bills', id); if (b) { total += b.payable; if (units.indexOf(b.unitId) === -1) units.push(b.unitId); } });
    return { total: total, unitIds: sortUnits(units) };
  }

  function batchAudit(ctx, p, action, from, note) {
    writeAudit(ctx, { entity: 'batch', entityId: p.id, entityLabel: batchLabel(p), unitIds: p.unitIds, action: action, from: from, to: p.status, note: note });
  }

  function batchTransition(id, name, options, apply) {
    return unitOfWork(function () {
      var ctx = begin(options); if (!ctx.ok) return ctx;
      var p = find('batches', id); if (!p) return fail(ERR.batchNotFound);
      var err = guard(ctx.actor, BATCH_TRANSITIONS[name], p, null, 'status', 'payment batch'); if (err) return fail(err);
      return apply(ctx, p);
    });
  }

  function cleanUtr(v) { return upper(v).replace(/\s+/g, ''); }
  function utrValid(u) { return /^[A-Z0-9]{10,22}$/.test(u); }

  function moveBills(ctx, p, transitionName, action, note, change) {
    var t = BILL_TRANSITIONS[transitionName];
    p.billIds.forEach(function (billId) {
      var b = find('bills', billId), next = copy(b);
      next.status = t.to;
      change(next);
      save('bills', next);
      billAudit(ctx, next, action, b.status, note, null, p.id);
    });
  }

  var batchApi = {
    STATES: ['DRAFT', 'PENDING_RELEASE', 'RELEASED', 'PAID', 'REJECTED'],
    TRANSITIONS: BATCH_TRANSITIONS,

    /** Batches whose bills all belong to units the persona may see, newest first. filter: { status, from, to (created date), search } */
    list: function (filter) {
      var f = filter || {}, allowed = scopeOrNull(), statuses = f.status ? [].concat(f.status) : null, q = str(f.search).toLowerCase();
      return rowsOf('batches').filter(function (p) {
        if (!batchInScope(p, allowed)) return false;
        if (statuses && statuses.indexOf(p.status) === -1) return false;
        if (f.from && p.createdAt.slice(0, 10) < f.from) return false;
        if (f.to && p.createdAt.slice(0, 10) > f.to) return false;
        if (q && (p.number + ' ' + (p.utr || '')).toLowerCase().indexOf(q) === -1) return false;
        return true;
      }).sort(function (a, b) { return a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : (a.createdAt < b.createdAt ? 1 : -1); });
    },

    get: function (id) { var p = find('batches', id); return p && batchInScope(p, scopeOrNull()) ? p : null; },

    /** The bill records of a batch, in batch order (empty when the batch is outside the persona's scope). */
    bills: function (id) {
      var p = batchApi.get(id);
      return p ? p.billIds.map(function (b) { return find('bills', b); }).filter(Boolean) : [];
    },

    counts: function () {
      var out = { total: 0 };
      batchApi.STATES.forEach(function (s) { out[s] = 0; });
      batchApi.list().forEach(function (p) { out[p.status]++; out.total++; });
      return out;
    },

    /** Approved bills not yet in a batch, earliest due date first: [{ bill, eligible, reason }] (reason = why it cannot be paid yet). */
    eligibleBills: function (filter) {
      var f = Object.assign({}, filter || {}, { status: 'APPROVED', unbatched: true });
      return billApi.list(f).map(function (b) { var why = billBatchable(b, null); return { bill: b, eligible: !why, reason: why }; })
        .sort(function (a, b) { return a.bill.dueDate === b.bill.dueDate ? (a.bill.id < b.bill.id ? -1 : 1) : (a.bill.dueDate < b.bill.dueDate ? -1 : 1); });
    },

    /** Accounts a batch can be paid from: [{ id, bank, masked, purpose, label }]; the first one is the default. */
    bankAccounts: function () {
      var ba = MK.config && MK.config.bankAccounts;
      return ((ba && ba.current) || []).filter(function (a) { return a.recommendation !== 'close'; })
        .map(function (a) { return { id: a.id, bank: a.bank, masked: a.masked, purpose: a.purpose, label: a.bank + ' ' + a.masked + ' - ' + a.purpose }; });
    },

    /** Dry run for buttons: { ok, reason }. action: create | edit | submit | release | reject | markPaid */
    can: function (action, idOrRecord) {
      if (action === 'create') { var may = MK.session.can('batch.create', {}); return { ok: may.ok, reason: may.reason }; }
      var t = BATCH_TRANSITIONS[action]; if (!t) return { ok: false, reason: 'Unknown action' };
      var p = typeof idOrRecord === 'string' ? find('batches', idOrRecord) : idOrRecord;
      if (!p) return { ok: false, reason: ERR.batchNotFound };
      var err = guard(MK.session.current(), t, p, null, 'status', 'payment batch');
      if (!err && action === 'submit' && !p.billIds.length) err = ERR.emptyBatch;
      if (!err && action === 'release') err = batchVendorError(p);
      return { ok: !err, reason: err };
    },

    /** Creates a DRAFT batch. The bills are reserved for it (batchId set) but stay APPROVED until the batch is submitted. */
    create: function (billIds, bankAccountId, options) {
      return unitOfWork(function () {
        var ctx = begin(options); if (!ctx.ok) return ctx;
        var may = canAs(ctx.actor, 'batch.create', {}); if (!may.ok) return fail(may.reason);
        var ids = uniqueStrings(billIds); if (!ids.length) return fail(ERR.noBills);
        var acct = resolveBankAccount(bankAccountId); if (!acct.ok) return acct;
        for (var i = 0; i < ids.length; i++) { var why = billBatchable(find('bills', ids[i]), null); if (why) return fail(why); }
        var at = stamp(ctx), number = nextNumber('batches', 'PB', at, 2), sums = batchTotals(ids);
        var rec = { id: number, number: number, bankAccountId: acct.id, billIds: ids, unitIds: sums.unitIds, total: sums.total, status: 'DRAFT',
          createdBy: ctx.actor.id, createdAt: at, submittedBy: null, submittedAt: null, releasedBy: null, releasedAt: null,
          rejectedBy: null, rejectedAt: null, rejectionReason: null, paidBy: null, paidAt: null, utr: null };
        save('batches', rec);
        ids.forEach(function (id) { var next = copy(find('bills', id)); next.batchId = rec.id; save('bills', next); });
        batchAudit(ctx, rec, 'batch.create', null, ids.length + (ids.length === 1 ? ' bill, ' : ' bills, ') + money(rec.total));
        return ok(rec);
      });
    },

    addBill: function (id, billId, options) {
      return batchTransition(id, 'edit', options, function (ctx, p) {
        if (p.billIds.indexOf(billId) !== -1) return ok(p, { unchanged: true });
        var b = find('bills', billId), why = billBatchable(b, p.id); if (why) return fail(why);
        var next = copy(p); next.billIds = p.billIds.concat([billId]);
        var sums = batchTotals(next.billIds); next.total = sums.total; next.unitIds = sums.unitIds;
        save('batches', next);
        var nb = copy(b); nb.batchId = p.id; save('bills', nb);
        batchAudit(ctx, next, 'batch.addBill', p.status, b.number + ' added, ' + money(b.payable) + '; batch total ' + money(next.total));
        return ok(next);
      });
    },

    removeBill: function (id, billId, options) {
      return batchTransition(id, 'edit', options, function (ctx, p) {
        if (p.billIds.indexOf(billId) === -1) return fail('Bill ' + str(billId) + ' is not in this batch');
        var b = find('bills', billId), next = copy(p);
        next.billIds = p.billIds.filter(function (x) { return x !== billId; });
        var sums = batchTotals(next.billIds); next.total = sums.total; next.unitIds = sums.unitIds;
        save('batches', next);
        if (b) { var nb = copy(b); nb.batchId = null; save('bills', nb); }
        batchAudit(ctx, next, 'batch.removeBill', p.status, (b ? b.number : billId) + ' removed; batch total ' + money(next.total));
        return ok(next);
      });
    },

    /** DRAFT -> PENDING_RELEASE; every bill moves APPROVED -> IN_BATCH. */
    submit: function (id, options) {
      return batchTransition(id, 'submit', options, function (ctx, p) {
        if (!p.billIds.length) return fail(ERR.emptyBatch);
        for (var i = 0; i < p.billIds.length; i++) { var why = billBatchable(find('bills', p.billIds[i]), p.id); if (why) return fail(why); }
        var next = copy(p), sums = batchTotals(p.billIds);
        next.status = 'PENDING_RELEASE'; next.total = sums.total; next.unitIds = sums.unitIds;
        next.submittedBy = ctx.actor.id; next.submittedAt = stamp(ctx);
        save('batches', next);
        batchAudit(ctx, next, 'batch.submit', p.status, p.billIds.length + (p.billIds.length === 1 ? ' bill, ' : ' bills, ') + money(next.total));
        moveBills(ctx, next, 'enterBatch', 'bill.inBatch', 'Payment batch ' + next.number + ' submitted for release', function (b) { b.batchId = next.id; });
        return ok(next);
      });
    },

    /** PENDING_RELEASE -> RELEASED. Blocked while any vendor in the batch is not APPROVED (for example after a bank-detail change). */
    release: function (id, options) {
      return batchTransition(id, 'release', options, function (ctx, p) {
        var blocked = batchVendorError(p); if (blocked) return fail(blocked);
        var next = copy(p);
        next.status = 'RELEASED'; next.releasedBy = ctx.actor.id; next.releasedAt = stamp(ctx);
        save('batches', next);
        batchAudit(ctx, next, 'batch.release', p.status, money(next.total) + ' released for payment from ' + next.bankAccountId);
        return ok(next);
      });
    },

    /** PENDING_RELEASE -> REJECTED with a mandatory reason; the bills return to APPROVED and can be batched again. */
    reject: function (id, reason, options) {
      return batchTransition(id, 'reject', options, function (ctx, p) {
        if (!reasonGiven(reason)) return fail(ERR.rejectionReason);
        var next = copy(p), r = str(reason);
        next.status = 'REJECTED'; next.rejectedBy = ctx.actor.id; next.rejectedAt = stamp(ctx); next.rejectionReason = r;
        save('batches', next);
        batchAudit(ctx, next, 'batch.reject', p.status, r);
        moveBills(ctx, next, 'leaveBatch', 'bill.batchRejected', 'Payment batch ' + next.number + ' rejected: ' + r, function (b) { b.batchId = null; });
        return ok(next);
      });
    },

    /** RELEASED -> PAID. payment: { utr } (one UTR for the whole batch) or { utrByBill: { billId: utr } } (every bill needs one). */
    markPaid: function (id, payment, options) {
      return batchTransition(id, 'markPaid', options, function (ctx, p) {
        var pay = payment || {}, single = cleanUtr(pay.utr), byBill = {};
        if (pay.utrByBill && typeof pay.utrByBill === 'object') {
          for (var i = 0; i < p.billIds.length; i++) {
            var u = cleanUtr(pay.utrByBill[p.billIds[i]]) || single;
            if (!u) return fail('UTR missing for bill ' + p.billIds[i]);
            if (!utrValid(u)) return fail('UTR looks invalid (10 to 22 letters and digits): ' + u);
            byBill[p.billIds[i]] = u;
          }
        } else {
          if (!single) return fail(ERR.utrBatch);
          if (!utrValid(single)) return fail('UTR looks invalid (10 to 22 letters and digits): ' + single);
          p.billIds.forEach(function (b) { byBill[b] = single; });
        }
        var next = copy(p), at = stamp(ctx);
        next.status = 'PAID'; next.paidBy = ctx.actor.id; next.paidAt = at; next.utr = pay.utrByBill ? null : single;
        save('batches', next);
        batchAudit(ctx, next, 'batch.markPaid', p.status, pay.utrByBill ? 'UTR recorded per bill' : 'UTR ' + single);
        p.billIds.forEach(function (billId) {
          var b = find('bills', billId), nb = copy(b);
          /* paidOn = the day the bank was instructed (the release); paidAt = when the reference was recorded in the ERP */
          nb.status = BILL_TRANSITIONS.pay.to; nb.utr = byBill[billId]; nb.paidAt = at; nb.paidOn = (p.releasedAt || at).slice(0, 10);
          save('bills', nb);
          billAudit(ctx, nb, 'bill.paid', b.status, 'UTR ' + byBill[billId] + ', payment batch ' + next.number, null, next.id);
        });
        return ok(next);
      });
    },

    /**
     * Bank-upload style sheet, one row per bill: { ok, filename, columns: [{ key, label }], rows: [{...}], total, count, debitAccount }.
     * Feeds MK.ui.downloadCsv(filename, columns, rows) as is. Account numbers stay masked: this is a mockup.
     */
    toCsv: function (id) {
      var p = batchApi.get(id); if (!p) return fail(ERR.batchNotFound);
      var columns = [
        { key: 'beneficiaryName', label: 'Beneficiary name' }, { key: 'accountMasked', label: 'Beneficiary account (masked)' }, { key: 'ifsc', label: 'IFSC' },
        { key: 'amount', label: 'Amount (Rs)' }, { key: 'narration', label: 'Narration' }, { key: 'paymentMode', label: 'Mode' },
        { key: 'billNumber', label: 'Bill' }, { key: 'invoiceNo', label: 'Vendor invoice' }, { key: 'unit', label: 'Unit' }
      ];
      var rows = batchApi.bills(id).map(function (b) {
        var v = find('vendors', b.vendorId) || {}, utility = v.type === 'utility';
        return {
          beneficiaryName: v.accountHolderName || v.name || b.vendorId, accountMasked: v.bankAccountMasked || '', ifsc: v.ifsc || '',
          amount: b.payable, narration: ('MK ' + b.number + ' ' + invoiceKey(b.invoiceNo)).slice(0, 30),
          paymentMode: utility ? 'Biller payment' : 'NEFT', billNumber: b.number, invoiceNo: b.invoiceNo, unit: unitInfo(b.unitId).name
        };
      });
      var acct = bankAccountInfo(p.bankAccountId) || null;
      return { ok: true, filename: 'payment-batch-' + p.number + '.csv', columns: columns, rows: rows, total: p.total, count: rows.length,
        debitAccount: acct ? { id: acct.id, bank: acct.bank, masked: acct.masked || null, name: acct.name || acct.purpose || null } : { id: p.bankAccountId, bank: null, masked: null, name: null } };
    }
  };

  /* ------------------------------------------- history derived from records */
  /* Audit-shaped steps read off the timestamps a record carries. MK.audit.trail() uses them to fill what the stored log lacks. */

  function factStep(list, entity, entityId, entityLabel, unitId, at, userId, action, from, to, note, refId) {
    if (!at) return;
    var u = MK.session.userById(userId);
    var ev = { id: 'DRV-' + entityId + '-' + pad(list.length + 1, 2), at: at, actorId: userId || null, actorName: u ? u.name : 'Not recorded',
      role: u ? u.role : null, roleLabel: u ? u.roleLabel : '', entity: entity, entityId: entityId, entityLabel: entityLabel, unitId: unitId,
      action: action, actionLabel: ACTION_LABELS[action] || action, from: from, to: to, note: note || '', changes: [], derived: true };
    if (refId) ev.refId = refId;
    list.push(ev);
  }

  function billFacts(b) {
    if (!b) return null;
    var out = [], name = billLabel(b), p = b.batchId ? find('batches', b.batchId) : null;
    function step(at, userId, action, from, to, note, refId) { factStep(out, 'bill', b.id, name, b.unitId, at, userId, action, from, to, note, refId); }
    step(b.createdAt, b.createdBy, 'bill.create', null, 'DRAFT', '');
    step(b.submittedAt, b.submittedBy || b.createdBy, 'bill.submit', 'DRAFT', 'SUBMITTED', '');
    /* every decision passes through UNDER_REVIEW; a record from before reviewedAt existed is taken up at the moment it was decided */
    if (b.reviewedBy && (b.reviewedAt || b.decidedAt)) step(b.reviewedAt || b.decidedAt, b.reviewedBy, 'bill.review', 'SUBMITTED', 'UNDER_REVIEW', '');
    if (b.rejectionReason) step(b.decidedAt, b.decidedBy, 'bill.reject', 'UNDER_REVIEW', 'REJECTED', b.rejectionReason);
    else step(b.decidedAt, b.decidedBy, 'bill.approve', 'UNDER_REVIEW', 'APPROVED', '');
    if (p && p.status !== 'DRAFT') step(p.submittedAt, p.submittedBy, 'bill.inBatch', 'APPROVED', 'IN_BATCH', 'Payment batch ' + p.number + ' submitted for release', p.id);
    if (p) step(p.releasedAt, p.releasedBy, 'bill.released', 'IN_BATCH', 'IN_BATCH', 'Payment batch ' + p.number + ' released to the bank', p.id);
    step(b.paidAt, p ? p.paidBy : null, 'bill.paid', 'IN_BATCH', 'PAID', 'UTR ' + b.utr + (p ? ', payment batch ' + p.number : ''), p ? p.id : null);
    return out;
  }

  function batchFacts(p) {
    if (!p) return null;
    var out = [], n = p.billIds.length;
    function step(at, userId, action, from, to, note) { factStep(out, 'batch', p.id, batchLabel(p), null, at, userId, action, from, to, note); }
    step(p.createdAt, p.createdBy, 'batch.create', null, 'DRAFT', '');
    step(p.submittedAt, p.submittedBy, 'batch.submit', 'DRAFT', 'PENDING_RELEASE', n + (n === 1 ? ' bill, ' : ' bills, ') + money(p.total));
    step(p.releasedAt, p.releasedBy, 'batch.release', 'PENDING_RELEASE', 'RELEASED', '');
    step(p.rejectedAt, p.rejectedBy, 'batch.reject', 'PENDING_RELEASE', 'REJECTED', p.rejectionReason);
    step(p.paidAt, p.paidBy, 'batch.markPaid', 'RELEASED', 'PAID', p.utr ? 'UTR ' + p.utr : 'UTR recorded per bill');
    return out;
  }

  function vendorFacts(v) {
    if (!v) return null;
    var out = [];
    (v.history || []).forEach(function (h) {
      factStep(out, 'vendor', v.id, vendorLabel(v), null, h.at, h.actorId, h.action, h.from, h.to, h.note);
      if (h.changes && out.length) out[out.length - 1].changes = h.changes;
    });
    return out;
  }

  /* --------------------------------------------------------------- exports */

  MK.workflow = {
    bill: billApi,
    batch: batchApi,
    vendor: vendorApi,
    labels: { state: STATE_LABELS, action: ACTION_LABELS, flag: FLAG_LABELS },
    errors: ERR,
    SIMULATED_NOTE: SIMULATED_NOTE,

    /**
     * Runs fn with every transition inside it sharing one unit of work: a single store write per
     * collection at the end. Meant for the seeder. If fn throws, nothing is written and the error is rethrown.
     */
    bulk: function (fn) {
      if (work) return fn();
      work = newWork();
      var w = work, out;
      try { out = fn(); } catch (e) { work = null; throw e; }
      work = null;
      commit(w);
      return out;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.MK;
})(typeof window !== 'undefined' ? window : globalThis);
