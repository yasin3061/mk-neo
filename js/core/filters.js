/*
 * MK.filters - the one global filter row (date range, outlet, channel, medium) and its state.
 * State lives inside the 'prefs' store key and every change emits 'filters:changed'.
 * All date presets are relative to MK.calendar (the frozen demo clock), never the wall clock.
 * The data layer is optional: option lists come from MK.config when present, else from the kernel.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.ui) return;
  var ui = MK.ui, h = ui.h, D = MK.dates;

  var PRESETS = [
    { id: 'last7', label: 'Last 7 days' },
    { id: 'last30', label: 'Last 30 days' },
    { id: 'thisMonth', label: 'This month' },
    { id: 'lastMonth', label: 'Last month' },
    { id: 'thisQuarter', label: 'This quarter' },
    { id: 'fytd', label: 'FY to date' },
    { id: 'custom', label: 'Custom range' }
  ];
  var DEFAULT_PRESET = 'thisMonth';
  var KINDS = {
    outlet: { key: 'outletIds', all: 'All outlets', title: 'Outlets', icon: 'store' },
    channel: { key: 'channelIds', all: 'All channels', title: 'Channels', icon: 'layers' },
    medium: { key: 'mediumIds', all: 'All mediums', title: 'Order mediums', icon: 'dish' }
  };
  var FALLBACK_CHANNELS = [{ id: 'petpooja', label: 'Petpooja POS' }, { id: 'swiggy', label: 'Swiggy' }, { id: 'zomato', label: 'Zomato' }];
  var FALLBACK_MEDIUMS = [{ id: 'dinein', label: 'Dine-in' }, { id: 'takeaway', label: 'Takeaway' }, { id: 'delivery', label: 'Delivery' }];

  function capitalise(id) { return id.charAt(0).toUpperCase() + id.slice(1); }
  function isIso(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function clampDate(iso) { return D.max(MK.calendar.dataStart, D.min(MK.calendar.dataEnd, iso)); }

  /* ------------------------------------------------------------- options */

  function fromConfig(listName, fallback, prefix) {
    var list = MK.config && Array.isArray(MK.config[listName]) && MK.config[listName].length ? MK.config[listName] : null;
    var source = list ? list.map(function (x) { return { id: x.id, label: x.label || x.name || x.short || capitalise(String(x.id)) }; }) : fallback;
    return source.map(function (x) { return { id: x.id, label: x.label, colourVar: prefix + x.id }; });
  }

  function options(kind) {
    if (kind === 'channel') return fromConfig('channels', FALLBACK_CHANNELS, '--ch-');
    if (kind === 'medium') return fromConfig('mediums', FALLBACK_MEDIUMS, '--md-');
    var allowed = MK.session.allowedOutletIds();
    var list;
    if (MK.config && Array.isArray(MK.config.outlets) && MK.config.outlets.length) {
      list = MK.config.outlets.filter(function (o) { return o.type !== 'factory'; }).map(function (o, i) {
        return { id: o.id, label: o.short || o.name || capitalise(String(o.id)), colourVar: o.colourVar || '--ot-' + (i + 1) };
      });
    } else {
      list = MK.session.OUTLET_IDS.map(function (id, i) { return { id: id, label: capitalise(id), colourVar: '--ot-' + (i + 1) }; });
    }
    return list.filter(function (o) { return allowed.indexOf(o.id) !== -1; });
  }

  /** Selection limited to the valid options; null when it means "everything". */
  function clean(ids, opts) {
    if (!Array.isArray(ids) || !ids.length) return null;
    var picked = opts.filter(function (o) { return ids.indexOf(o.id) !== -1; }).map(function (o) { return o.id; });
    return picked.length === 0 || picked.length === opts.length ? null : picked;
  }

  /* --------------------------------------------------------------- dates */

  function rangeFor(presetId, custom) {
    var end = MK.calendar.dataEnd, start = MK.calendar.dataStart;
    var from, to = end;
    switch (presetId) {
      case 'last7': from = D.addDays(end, -6); break;
      case 'last30': from = D.addDays(end, -29); break;
      case 'lastMonth':
        to = D.addDays(D.monthStart(end), -1);
        from = D.monthStart(to);
        break;
      case 'thisQuarter':
        var month = +end.slice(5, 7);
        var qStart = month - ((month - 1) % 3);
        from = end.slice(0, 5) + (qStart < 10 ? '0' : '') + qStart + '-01';
        break;
      case 'fytd':
        var year = +end.slice(0, 4) - (+end.slice(5, 7) < 4 ? 1 : 0);
        from = year + '-04-01';
        break;
      case 'custom':
        from = custom && isIso(custom.from) ? custom.from : D.monthStart(end);
        to = custom && isIso(custom.to) ? custom.to : end;
        break;
      default: from = D.monthStart(end);
    }
    from = clampDate(from);
    to = clampDate(to);
    if (from > to) { var swap = from; from = to; to = swap; }
    if (from < start) from = start;
    return { from: from, to: to };
  }

  function rangeLabel(r) {
    var sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
    if (r.from === r.to) return D.label(r.to, 'd MMM yyyy');
    return D.label(r.from, sameYear ? 'd MMM' : 'd MMM yyyy') + ' - ' + D.label(r.to, 'd MMM yyyy');
  }

  /* --------------------------------------------------------------- state */

  function blank() { return { preset: DEFAULT_PRESET, from: null, to: null, outletIds: null, channelIds: null, mediumIds: null }; }

  function load() {
    var saved = (MK.store.get('prefs', {}) || {}).filters || {};
    var s = blank();
    if (PRESETS.some(function (p) { return p.id === saved.preset; })) s.preset = saved.preset;
    if (isIso(saved.from)) s.from = saved.from;
    if (isIso(saved.to)) s.to = saved.to;
    ['outletIds', 'channelIds', 'mediumIds'].forEach(function (k) { if (Array.isArray(saved[k]) && saved[k].length) s[k] = saved[k].slice(); });
    return s;
  }

  var state = load();

  function persist() {
    var prefs = MK.store.get('prefs', {}) || {};
    prefs.filters = { preset: state.preset, from: state.from, to: state.to, outletIds: state.outletIds, channelIds: state.channelIds, mediumIds: state.mediumIds };
    MK.store.set('prefs', prefs);
  }

  function get() {
    var r = rangeFor(state.preset, state);
    return {
      from: r.from, to: r.to,
      outletIds: clean(state.outletIds, options('outlet')),
      channelIds: clean(state.channelIds, options('channel')),
      mediumIds: clean(state.mediumIds, options('medium')),
      preset: state.preset
    };
  }

  /** set({preset}) | set({from, to}) (implies preset 'custom') | set({outletIds, channelIds, mediumIds}) - null means all. */
  function set(partial) {
    partial = partial || {};
    if (partial.preset && PRESETS.some(function (p) { return p.id === partial.preset; })) state.preset = partial.preset;
    if (partial.from !== undefined || partial.to !== undefined) {
      if (!partial.preset) state.preset = 'custom';
      var r = rangeFor('custom', { from: partial.from || state.from, to: partial.to || state.to });
      state.from = r.from;
      state.to = r.to;
    }
    Object.keys(KINDS).forEach(function (kind) {
      var key = KINDS[kind].key;
      if (partial[key] !== undefined) state[key] = clean(partial[key], options(kind));
    });
    persist();
    MK.bus.emit('filters:changed', get());
  }

  function reset() {
    state = blank();
    persist();
    MK.bus.emit('filters:changed', get());
  }

  function isDefault(showList) {
    var shown = showList && showList.length ? showList : ['date', 'outlet', 'channel', 'medium'];
    var f = get();
    return !shown.some(function (kind) {
      if (kind === 'date') return f.preset !== DEFAULT_PRESET;
      return KINDS[kind] ? f[KINDS[kind].key] !== null : false;
    });
  }

  function summary(kind) {
    var opts = options(kind), ids = get()[KINDS[kind].key];
    if (!ids) return opts.length === 1 ? opts[0].label : KINDS[kind].all;
    var firstOpt = opts.filter(function (o) { return o.id === ids[0]; })[0];
    return (firstOpt ? firstOpt.label : ids[0]) + (ids.length > 1 ? ' +' + (ids.length - 1) : '');
  }

  function describe() {
    var f = get();
    var days = D.diffDays(f.from, f.to) + 1;
    return rangeLabel(f) + ', ' + days + (days === 1 ? ' day' : ' days');
  }

  /* ----------------------------------------------------------------- bar */

  var mounted = null; /* {container, showList, refresh} */

  function menuRow(o) {
    return h('button', { type: 'button', role: o.role || 'menuitem', 'aria-checked': o.role ? 'false' : null, 'class': 'mk-menu__item', 'data-autofocus': o.autofocus ? '' : null, onClick: o.onClick },
      o.lead || null,
      h('span', { 'class': 'mk-menu__main' }, o.label),
      o.hint ? h('span', { 'class': 'mk-menu__hint' }, o.hint) : null,
      o.tick ? h('span', { 'class': 'mk-menu__tick' }) : null);
  }

  function openDatePopover(anchor) {
    var pop = null;
    var current = get();
    var fromInput = ui.form.dateInput({ value: current.from, min: MK.calendar.dataStart, max: MK.calendar.dataEnd, ariaLabel: 'From date' });
    var toInput = ui.form.dateInput({ value: current.to, min: MK.calendar.dataStart, max: MK.calendar.dataEnd, ariaLabel: 'To date' });
    var error = h('div', { 'class': 'mk-field__error', style: { gridColumn: '1 / -1' } });
    error.hidden = true;
    var custom = h('div', { 'class': 'mk-menu__custom' },
      h('label', null, 'From', fromInput), h('label', null, 'To', toInput), error,
      ui.button({ label: 'Apply range', variant: 'primary', size: 'sm', onClick: function () {
        if (!isIso(fromInput.value) || !isIso(toInput.value)) { error.hidden = false; ui.clear(error).appendChild(root.document.createTextNode('Pick both dates')); return; }
        if (pop) pop.close();
        set({ preset: 'custom', from: fromInput.value, to: toInput.value });
      } }));
    custom.hidden = current.preset !== 'custom';

    var rows = PRESETS.map(function (p) {
      var selected = p.id === current.preset;
      var row = menuRow({
        label: p.label, tick: true, autofocus: selected,
        hint: p.id === 'custom' ? null : rangeLabel(rangeFor(p.id)),
        onClick: function () {
          if (p.id === 'custom') { custom.hidden = false; if (pop) pop.reposition(); fromInput.focus(); return; }
          if (pop) pop.close();
          set({ preset: p.id });
        }
      });
      if (selected) { row.classList.add('is-selected'); row.lastChild.appendChild(ui.icon('check')); }
      return row;
    });
    pop = ui.popover(anchor, [h('div', { 'class': 'mk-menu__heading' }, 'Date range'), rows, custom], { width: 300 });
  }

  function openMultiPopover(anchor, kind) {
    var meta = KINDS[kind], opts = options(kind);
    var boxes = {};
    function box() { return h('input', { type: 'checkbox', 'class': 'mk-menu__check', tabindex: -1, 'aria-hidden': 'true' }); }
    function sync() {
      var ids = get()[meta.key];
      Object.keys(boxes).forEach(function (id) {
        var on = id === '*' ? !ids : !!ids && ids.indexOf(id) !== -1;
        boxes[id].input.checked = on;
        boxes[id].row.setAttribute('aria-checked', on ? 'true' : 'false');
        boxes[id].row.classList.toggle('is-selected', id === '*' && on);
      });
    }
    function makeRow(id, label, colourVar, onClick) {
      var input = box();
      var row = menuRow({ role: 'menuitemcheckbox', label: label, autofocus: id === '*', onClick: onClick,
        lead: [input, colourVar ? h('span', { 'class': 'mk-menu__swatch', style: { background: 'var(' + colourVar + ')' } }) : null] });
      boxes[id] = { input: input, row: row };
      return row;
    }
    var rows = [makeRow('*', meta.all, null, function () { var p = {}; p[meta.key] = null; set(p); sync(); })];
    rows.push(h('div', { 'class': 'mk-menu__sep', role: 'separator' }));
    opts.forEach(function (opt) {
      rows.push(makeRow(opt.id, opt.label, opt.colourVar, function () {
        var ids = (get()[meta.key] || []).slice();
        var at = ids.indexOf(opt.id);
        if (at === -1) ids.push(opt.id); else ids.splice(at, 1);
        var p = {}; p[meta.key] = ids.length ? ids : null;
        set(p); sync();
      }));
    });
    ui.popover(anchor, [h('div', { 'class': 'mk-menu__heading' }, meta.title), rows], { width: 240 });
    sync();
  }

  /**
   * mountBar(container, ['date', 'outlet', 'channel', 'medium']) - renders only the requested controls, plus
   * "Reset filters" when one of them is not at its default. An empty list hides the bar.
   */
  function mountBar(container, showList) {
    var show = (showList || []).filter(function (k) { return k === 'date' || KINDS[k]; });
    ui.clear(container);
    mounted = null;
    if (!show.length) { container.hidden = true; return; }
    container.hidden = false;
    container.setAttribute('role', 'toolbar');
    container.setAttribute('aria-label', 'Filters');

    var updaters = [];
    ['date', 'outlet', 'channel', 'medium'].forEach(function (kind) {
      if (show.indexOf(kind) === -1) return;
      var value = h('span', { 'class': 'mk-fctl__val' });
      if (kind === 'date') {
        var dateBtn = h('button', { type: 'button', 'class': 'mk-fctl', onClick: function () { openDatePopover(dateBtn); } }, ui.icon('calendar'), value, ui.icon('chevron-down', 14));
        container.appendChild(dateBtn);
        updaters.push(function (f) {
          var preset = PRESETS.filter(function (p) { return p.id === f.preset; })[0];
          value.textContent = f.preset === 'custom' ? rangeLabel(f) : preset.label;
          dateBtn.classList.toggle('is-set', f.preset !== DEFAULT_PRESET);
          dateBtn.setAttribute('aria-label', 'Date range: ' + value.textContent);
        });
        return;
      }
      var opts = options(kind);
      if (!opts.length) return;
      if (kind === 'outlet' && opts.length === 1) {
        container.appendChild(h('span', { 'class': 'mk-fctl mk-fctl--locked', title: 'Your role is limited to this outlet' }, ui.icon('lock', 14), h('span', { 'class': 'mk-fctl__val' }, opts[0].label)));
        return;
      }
      var btn = h('button', { type: 'button', 'class': 'mk-fctl', onClick: function () { openMultiPopover(btn, kind); } }, ui.icon(KINDS[kind].icon), value, ui.icon('chevron-down', 14));
      container.appendChild(btn);
      updaters.push(function (f) {
        value.textContent = summary(kind);
        btn.classList.toggle('is-set', f[KINDS[kind].key] !== null);
        btn.setAttribute('aria-label', KINDS[kind].title + ': ' + value.textContent);
      });
    });

    var resetBtn = ui.button({ label: 'Reset filters', variant: 'text', size: 'sm', onClick: reset });
    var rangeText = h('span', { 'class': 'mk-filterbar__range' });
    container.appendChild(resetBtn);
    container.appendChild(h('span', { 'class': 'mk-filterbar__spacer' }));
    if (show.indexOf('date') !== -1) container.appendChild(rangeText);

    function refresh() {
      var f = get();
      updaters.forEach(function (fn) { fn(f); });
      resetBtn.hidden = isDefault(show);
      rangeText.textContent = describe();
    }
    mounted = { container: container, showList: show, refresh: refresh };
    refresh();
  }

  MK.bus.on('filters:changed', function () { if (mounted) mounted.refresh(); });

  MK.bus.on('session:changed', function () {
    var before = JSON.stringify(state.outletIds);
    state.outletIds = clean(state.outletIds, options('outlet'));
    if (mounted) mountBar(mounted.container, mounted.showList);
    if (JSON.stringify(state.outletIds) !== before) { persist(); MK.bus.emit('filters:changed', get()); }
  });

  MK.bus.on('store:changed', function (evt) {
    if (evt && evt.key === '*') { state = blank(); if (mounted) mounted.refresh(); }
  });

  MK.filters = {
    get: get, set: set, reset: reset, mountBar: mountBar, isDefault: isDefault, describe: describe,
    options: options, summary: summary,
    presets: function () { return PRESETS.map(function (p) { var r = p.id === 'custom' ? null : rangeFor(p.id); return { id: p.id, label: p.label, from: r && r.from, to: r && r.to }; }); },
    range: function (presetId) { return rangeFor(presetId, state); }
  };
})(window);
