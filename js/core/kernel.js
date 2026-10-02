/*
 * MK kernel: namespace, event bus, formatting, dates, seeded randomness, storage, session.
 * No DOM access in this file - it must load in the browser (classic script) and in Node.
 * Everything else in the mockup builds on this contract; extend it, do not fork it.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});
  MK.version = '0.1.0';

  /* The demo dataset is frozen in time. "Today" is never the wall clock. */
  MK.calendar = { today: '2026-09-17', dataStart: '2026-04-01', dataEnd: '2026-09-16', fyLabel: 'FY 2026-27' };

  /* ------------------------------------------------------------------ bus */

  var listeners = {};
  MK.bus = {
    on: function (evt, fn) {
      (listeners[evt] || (listeners[evt] = [])).push(fn);
      return function off() {
        listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; });
      };
    },
    emit: function (evt, payload) {
      (listeners[evt] || []).slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { if (root.console) root.console.error('[MK.bus] ' + evt, e); }
      });
    }
  };

  /* ------------------------------------------------------------------ fmt */

  var RUPEE = '₹';
  var MINUS = '-';

  function groupIndian(intStr) {
    if (intStr.length <= 3) return intStr;
    var last3 = intStr.slice(-3);
    var rest = intStr.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return rest + ',' + last3;
  }

  function trimZeros(s) { return s.indexOf('.') === -1 ? s : s.replace(/\.?0+$/, ''); }

  MK.fmt = {
    /** Plain number with Indian digit grouping. decimals defaults to 0. */
    num: function (n, decimals) {
      if (n === null || n === undefined || isNaN(n)) return '-';
      var d = decimals || 0;
      var neg = n < 0;
      var parts = Math.abs(n).toFixed(d).split('.');
      return (neg ? MINUS : '') + groupIndian(parts[0]) + (parts[1] ? '.' + parts[1] : '');
    },
    /** Full rupee amount: Rs 12,43,500 */
    inrFull: function (n, decimals) {
      if (n === null || n === undefined || isNaN(n)) return '-';
      return (n < 0 ? MINUS : '') + RUPEE + MK.fmt.num(Math.abs(n), decimals || 0);
    },
    /** Compact rupee amount for tiles, axes and tooltips: Rs 1.08 Cr, Rs 12.4 L, Rs 45,200 */
    inr: function (n) {
      if (n === null || n === undefined || isNaN(n)) return '-';
      var a = Math.abs(n), sign = n < 0 ? MINUS : '';
      if (a >= 1e7) return sign + RUPEE + trimZeros((a / 1e7).toFixed(2)) + ' Cr';
      if (a >= 1e5) return sign + RUPEE + trimZeros((a / 1e5).toFixed(a >= 1e6 ? 1 : 2)) + ' L';
      return sign + RUPEE + MK.fmt.num(Math.round(a));
    },
    /** Fraction to percent: 0.1234 -> 12.3% */
    pct: function (x, decimals) {
      if (x === null || x === undefined || isNaN(x) || !isFinite(x)) return '-';
      return (x * 100).toFixed(decimals === undefined ? 1 : decimals) + '%';
    },
    /** Relative change between two values. dir is 'up' | 'down' | 'flat'. */
    delta: function (cur, prev) {
      if (!prev || isNaN(prev) || isNaN(cur)) return { value: null, label: '-', dir: 'flat' };
      var v = (cur - prev) / Math.abs(prev);
      var dir = Math.abs(v) < 0.0005 ? 'flat' : (v > 0 ? 'up' : 'down');
      return { value: v, label: (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%', dir: dir };
    },
    /** Percentage-point change between two fractions: 0.34 vs 0.32 -> +2.0 pts */
    points: function (curFrac, prevFrac) {
      if (curFrac === null || prevFrac === null || isNaN(curFrac) || isNaN(prevFrac)) return { value: null, label: '-', dir: 'flat' };
      var v = (curFrac - prevFrac) * 100;
      var dir = Math.abs(v) < 0.05 ? 'flat' : (v > 0 ? 'up' : 'down');
      return { value: v, label: (v > 0 ? '+' : '') + v.toFixed(1) + ' pts', dir: dir };
    },
    kg: function (n, decimals) { return MK.fmt.num(n, decimals === undefined ? 0 : decimals) + ' kg'; },
    rupee: RUPEE
  };

  /* ---------------------------------------------------------------- dates */
  /* ISO 'YYYY-MM-DD' strings everywhere; all arithmetic in UTC so time zones never shift a day. */

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function toMs(iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)); }
  function fromMs(ms) {
    var d = new Date(ms);
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  MK.dates = {
    MONTHS: MONTHS,
    DOWS: DOWS,
    addDays: function (iso, n) { return fromMs(toMs(iso) + n * 86400000); },
    diffDays: function (a, b) { return Math.round((toMs(b) - toMs(a)) / 86400000); },
    /** Inclusive list of ISO dates. */
    range: function (from, to) {
      var out = [], n = MK.dates.diffDays(from, to);
      for (var i = 0; i <= n; i++) out.push(MK.dates.addDays(from, i));
      return out;
    },
    /** 0 = Monday ... 6 = Sunday */
    dow: function (iso) { return (new Date(toMs(iso)).getUTCDay() + 6) % 7; },
    monthKey: function (iso) { return iso.slice(0, 7); },
    monthStart: function (iso) { return iso.slice(0, 8) + '01'; },
    monthEnd: function (iso) {
      var y = +iso.slice(0, 4), m = +iso.slice(5, 7);
      return fromMs(Date.UTC(y, m, 0));
    },
    daysInMonth: function (monthKey) { return +MK.dates.monthEnd(monthKey + '-01').slice(8, 10); },
    /** Monday of the week containing iso. */
    weekStart: function (iso) { return MK.dates.addDays(iso, -MK.dates.dow(iso)); },
    min: function (a, b) { return a < b ? a : b; },
    max: function (a, b) { return a > b ? a : b; },
    /** style: 'd MMM' (default) | 'd MMM yyyy' | 'MMM yyyy' | 'MMM' | 'EEE' | 'EEE d MMM' */
    label: function (iso, style) {
      var d = +iso.slice(8, 10), m = MONTHS[+iso.slice(5, 7) - 1], y = iso.slice(0, 4);
      switch (style) {
        case 'd MMM yyyy': return d + ' ' + m + ' ' + y;
        case 'MMM yyyy': return m + ' ' + y;
        case 'MMM': return m;
        case 'EEE': return DOWS[MK.dates.dow(iso)];
        case 'EEE d MMM': return DOWS[MK.dates.dow(iso)] + ' ' + d + ' ' + m;
        default: return d + ' ' + m;
      }
    },
    monthLabel: function (monthKey, withYear) {
      return MONTHS[+monthKey.slice(5, 7) - 1] + (withYear ? ' ' + monthKey.slice(0, 4) : '');
    }
  };

  /* ------------------------------------------------------------------ rng */
  /* Deterministic. Never use Math.random() or the clock for data. */

  MK.hash = function (str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  /** MK.rng(seed) where seed is a number or any string key, e.g. MK.rng('sales|bandra|2026-04-01') */
  MK.rng = function (seed) {
    var s = (typeof seed === 'string' ? MK.hash(seed) : (seed >>> 0)) || 1;
    function next() {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    var spare = null;
    var api = {
      next: next,
      range: function (a, b) { return a + (b - a) * next(); },
      int: function (a, b) { return a + Math.floor(next() * (b - a + 1)); },
      chance: function (p) { return next() < p; },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      /** Index drawn in proportion to non-negative weights. */
      weighted: function (weights) {
        var total = 0, i;
        for (i = 0; i < weights.length; i++) total += weights[i];
        var r = next() * total;
        for (i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
        return weights.length - 1;
      },
      normal: function (mean, sd) {
        var z;
        if (spare !== null) { z = spare; spare = null; }
        else {
          var u = 0, v = 0;
          while (u === 0) u = next();
          v = next();
          var mag = Math.sqrt(-2 * Math.log(u));
          z = mag * Math.cos(2 * Math.PI * v);
          spare = mag * Math.sin(2 * Math.PI * v);
        }
        return (mean || 0) + (sd === undefined ? 1 : sd) * z;
      },
      poisson: function (lambda) {
        if (lambda <= 0) return 0;
        if (lambda > 30) return Math.max(0, Math.round(api.normal(lambda, Math.sqrt(lambda))));
        var L = Math.exp(-lambda), k = 0, p = 1;
        do { k++; p *= next(); } while (p > L);
        return k - 1;
      }
    };
    return api;
  };

  /* ---------------------------------------------------------------- store */
  /* Namespaced localStorage with an in-memory fallback (Node, or a browser that blocks storage). */

  var PREFIX = 'mk.v1.';
  var memory = {};
  var ls = null;
  try {
    if (root.localStorage) {
      root.localStorage.setItem(PREFIX + '__probe', '1');
      root.localStorage.removeItem(PREFIX + '__probe');
      ls = root.localStorage;
    }
  } catch (e) { ls = null; }

  var cache = {};

  MK.store = {
    persistent: !!ls,
    get: function (key, fallback) {
      if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
      var raw = null;
      try { raw = ls ? ls.getItem(PREFIX + key) : (Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null); } catch (e) { raw = null; }
      if (raw === null || raw === undefined) return fallback;
      try { cache[key] = JSON.parse(raw); return cache[key]; } catch (e2) { return fallback; }
    },
    set: function (key, value) {
      cache[key] = value;
      var raw = JSON.stringify(value);
      try { if (ls) ls.setItem(PREFIX + key, raw); else memory[key] = raw; } catch (e) { memory[key] = raw; }
      MK.bus.emit('store:changed', { key: key });
    },
    remove: function (key) {
      delete cache[key];
      delete memory[key];
      try { if (ls) ls.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
      MK.bus.emit('store:changed', { key: key });
    },
    /** Remove every key this app wrote (any schema version). */
    resetAll: function () {
      cache = {};
      memory = {};
      try {
        if (ls) {
          var doomed = [];
          for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k && k.indexOf('mk.') === 0) doomed.push(k); }
          doomed.forEach(function (k) { ls.removeItem(k); });
        }
      } catch (e) { /* ignore */ }
      MK.bus.emit('store:changed', { key: '*' });
    },
    /**
     * Array-of-records collection keyed by `id`.
     * all() returns the live array - treat it as read-only and write through upsert/remove/replaceAll.
     */
    coll: function (name) {
      var key = 'c.' + name;
      function all() { return MK.store.get(key, []); }
      return {
        all: all,
        byId: function (id) { var a = all(); for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null; },
        where: function (pred) { return all().filter(pred); },
        upsert: function (rec) {
          var a = all().slice(), found = false;
          for (var i = 0; i < a.length; i++) if (a[i].id === rec.id) { a[i] = rec; found = true; break; }
          if (!found) a.push(rec);
          MK.store.set(key, a);
          return rec;
        },
        remove: function (id) { MK.store.set(key, all().filter(function (r) { return r.id !== id; })); },
        replaceAll: function (arr) { MK.store.set(key, arr); }
      };
    }
  };

  /* -------------------------------------------------------------- session */
  /* Fictional personas. Unit ids are fixed here and MK.config.outlets must use the same ids. */

  var OUTLET_IDS = ['bandra', 'andheri', 'fort', 'kalyan', 'koregaon'];
  var ALL_UNITS = OUTLET_IDS.concat(['factory', 'ho']); /* ho = head office, a cost centre with no sales */

  var USERS = [
    { id: 'u_director', name: 'Arif Merchant', initials: 'AM', role: 'director', roleLabel: 'Director', unitIds: ALL_UNITS },
    { id: 'u_checker', name: 'Neha Kulkarni', initials: 'NK', role: 'checker', roleLabel: 'Finance checker', unitIds: ALL_UNITS },
    { id: 'u_maker', name: 'Rohit Pawar', initials: 'RP', role: 'maker', roleLabel: 'Finance maker', unitIds: ALL_UNITS },
    { id: 'u_payer', name: 'Sana Shaikh', initials: 'SS', role: 'payer', roleLabel: 'Payer', unitIds: ALL_UNITS },
    { id: 'u_om_bandra', name: 'Vikram Shetty', initials: 'VS', role: 'outlet_manager', roleLabel: 'Outlet manager, Bandra', unitIds: ['bandra'] },
    { id: 'u_fm', name: "Joseph D'Souza", initials: 'JD', role: 'factory_manager', roleLabel: 'Factory manager', unitIds: ['factory'] }
  ];

  /* action -> roles allowed. Segregation and scope checks are applied on top in can(). */
  var RIGHTS = {
    'bill.create': ['maker', 'outlet_manager', 'factory_manager'],
    'bill.edit': ['maker', 'outlet_manager', 'factory_manager'],
    'bill.submit': ['maker', 'outlet_manager', 'factory_manager'],
    'bill.review': ['checker'],
    'bill.approve': ['checker'],
    'bill.reject': ['checker'],
    'batch.create': ['payer'],
    'batch.submit': ['payer'],
    'batch.release': ['director'],
    'batch.reject': ['director'],
    'batch.markPaid': ['payer'],
    'vendor.create': ['maker'],
    'vendor.edit': ['maker'],
    'vendor.verify': ['maker', 'checker'],
    'vendor.approve': ['checker'],
    'vendor.reject': ['checker'],
    'demo.reset': ['director', 'checker', 'maker', 'payer', 'outlet_manager', 'factory_manager']
  };

  /* actions where the actor must differ from whoever created / submitted the record */
  var SEGREGATED = { 'bill.review': 1, 'bill.approve': 1, 'bill.reject': 1, 'batch.release': 1, 'batch.reject': 1, 'vendor.approve': 1, 'vendor.reject': 1 };
  /* actions limited to records the actor created */
  var OWN_ONLY = { 'bill.edit': 1, 'bill.submit': 1 };

  MK.session = {
    OUTLET_IDS: OUTLET_IDS,
    ALL_UNITS: ALL_UNITS,
    users: USERS,
    userById: function (id) { for (var i = 0; i < USERS.length; i++) if (USERS[i].id === id) return USERS[i]; return null; },
    current: function () {
      var prefs = MK.store.get('prefs', {});
      return MK.session.userById(prefs.userId) || USERS[0];
    },
    set: function (userId) {
      var prefs = MK.store.get('prefs', {});
      prefs.userId = userId;
      MK.store.set('prefs', prefs);
      MK.bus.emit('session:changed', MK.session.current());
    },
    /** Units (outlets + factory) the current persona may see. Selectors must intersect with this. */
    allowedUnitIds: function () { return MK.session.current().unitIds.slice(); },
    /** Customer-facing outlets only (no factory) the current persona may see. */
    allowedOutletIds: function () {
      return MK.session.current().unitIds.filter(function (id) { return id !== 'factory' && id !== 'ho'; });
    },
    seesAllUnits: function () { return MK.session.current().unitIds.length === ALL_UNITS.length; },
    /**
     * can(action, ctx) -> { ok, reason }
     * ctx.unitId   unit the record belongs to (scope check)
     * ctx.createdBy  user id that created / submitted the record (segregation and ownership checks)
     */
    can: function (action, ctx) {
      var u = MK.session.current();
      ctx = ctx || {};
      var roles = RIGHTS[action];
      if (!roles) return { ok: false, reason: 'Unknown action' };
      if (roles.indexOf(u.role) === -1) return { ok: false, reason: 'Not permitted for the ' + u.roleLabel + ' role' };
      if (ctx.unitId && u.unitIds.indexOf(ctx.unitId) === -1) return { ok: false, reason: 'Outside your assigned outlet' };
      if (SEGREGATED[action] && ctx.createdBy && ctx.createdBy === u.id) return { ok: false, reason: 'Segregation of duties: you cannot act on your own submission' };
      if (OWN_ONLY[action] && ctx.createdBy && ctx.createdBy !== u.id && u.role !== 'maker') return { ok: false, reason: 'Only the person who raised this can change it' };
      return { ok: true, reason: '' };
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MK;
})(typeof window !== 'undefined' ? window : globalThis);
