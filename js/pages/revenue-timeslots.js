/*
 * #/revenue/timeslots - Time slots (client brief area 1: time-slot reporting).
 *
 * The business day runs 12:00 noon to 04:00 next morning (hour buckets 12..27, labelled by MK.config.hours).
 * Blocks: KPI row, day-of-week x hour heatmap, slot mix by outlet and by channel, peak-hour table per outlet,
 * weekday vs weekend by outlet, and kitchen prep time on aggregator orders (order-level status times, last 14 days).
 *
 * Every figure comes from MK.data.* (the Petpooja POS feed) and is formatted with MK.fmt. Day-of-week figures are
 * averages per trading day: the sums of the data layer divided by how often that weekday falls in the period, so a
 * range holding three Tuesdays and two Mondays is still read fairly. Takeaways under the titles are composed from
 * those values by rule (highest lunch share, earliest close, lowest weekend lift) - no outlet is named in code.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;

  /* ------------------------------------------------------------------ vocabulary */

  var MEASURES = {
    orders: { label: 'Orders', noun: 'orders', format: 'num' },
    netSales: { label: 'Net sales', noun: 'net sales', format: 'inr' }
  };
  var MEASURE_OPTIONS = [{ value: 'orders', label: 'Orders' }, { value: 'netSales', label: 'Net sales' }];

  /* day types (0 = Monday): the engine trades Saturday and Sunday as the weekend and Friday as a day of its own */
  var DAY_TYPES = [{ id: 'weekday', dows: [0, 1, 2, 3] }, { id: 'friday', dows: [4] }, { id: 'weekend', dows: [5, 6] }].map(function (t) {
    var names = MK.dates.DOWS, first = names[t.dows[0]], last = names[t.dows[t.dows.length - 1]];
    return { id: t.id, dows: t.dows, label: t.dows.length > 1 ? first + '-' + last : first };
  });
  var LUNCH_SLOT = 'lunch', LATE_SLOT = 'latenight';

  var HEAT_HEIGHT = 300, MIX_HEIGHT = 250, WEEK_HEIGHT = 250;   /* px - layout, not data */
  var EARLY_CLOSE_GAP_HOURS = 1;     /* an outlet closing this much before every other one is called out */
  var LUNCH_SKEW_PTS = 0.05;         /* weekday-vs-weekend lunch share gap worth a sentence */
  var SEQ_STEPS = ['--seq-100', '--seq-150', '--seq-200', '--seq-250', '--seq-300', '--seq-350', '--seq-400', '--seq-450', '--seq-500', '--seq-550', '--seq-600', '--seq-650', '--seq-700'];

  /* ------------------------------------------------------------------ small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function has(list, value) { return Array.isArray(list) && list.indexOf(value) !== -1; }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''; }
  function plural(n, word) { return fmt.num(n) + ' ' + word + (n === 1 ? '' : 's'); }

  function andList(items) {
    var list = (items || []).filter(Boolean);
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function rangeLabel(from, to) {
    if (!from || !to) return '';
    if (from === to) return MK.dates.label(from, 'd MMM yyyy');
    var sameYear = from.slice(0, 4) === to.slice(0, 4);
    return MK.dates.label(from, sameYear ? 'd MMM' : 'd MMM yyyy') + ' - ' + MK.dates.label(to, 'd MMM yyyy');
  }

  /** A value of the selected measure in a sentence or a cell. Averages of orders keep one decimal while they are small. */
  function say(measure, v) {
    if (!isNum(v)) return '-';
    if (measure === 'netSales') return fmt.inr(v);
    return fmt.num(v, v < 100 && Math.round(v) !== v ? 1 : 0);
  }

  function chartFormat(measure) {
    if (measure === 'netSales') return 'inr';
    return function (v, where) { return where === 'axis' || where === 'label' ? fmt.num(Math.round(v)) : say('orders', v); };
  }

  function sum(list) { return (list || []).reduce(function (t, v) { return t + (isNum(v) ? v : 0); }, 0); }

  function extremes(values) {
    var hi = -1, lo = -1;
    (values || []).forEach(function (v, i) {
      if (!isNum(v)) return;
      if (hi === -1 || v > values[hi]) hi = i;
      if (lo === -1 || v < values[lo]) lo = i;
    });
    return hi === -1 ? null : { hi: hi, lo: lo };
  }

  function colIndex(m, id) {
    for (var j = 0; j < m.cols.length; j++) if (m.cols[j].id === id) return j;
    return -1;
  }

  /** How often each weekday (0 = Monday) falls inside the inclusive range. */
  function dowCounts(from, to) {
    var n = [0, 0, 0, 0, 0, 0, 0];
    if (!from || !to) return n;
    var days = MK.dates.diffDays(from, to) + 1, first = MK.dates.dow(from);
    for (var i = 0; i < days; i++) n[(first + i) % 7]++;
    return n;
  }

  function withOutlet(f, outletId) {
    var out = {}, src = f || {};
    Object.keys(src).forEach(function (k) { out[k] = src[k]; });
    out.outletIds = [outletId];
    return out;
  }

  /* ---- hours: labelled the way MK.config.hours labels them; trading hours are business-day decimals (27.75 = 3:45 am) */

  function hourLabel(hour) {
    var list = (MK.config && MK.config.hours) || [];
    for (var i = 0; i < list.length; i++) if (list[i].hour === hour) return list[i].label;
    var h24 = ((hour % 24) + 24) % 24, h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return h12 + (h24 < 12 ? ' am' : ' pm');
  }

  function clockLabel(dec) {
    if (!isNum(dec)) return '';
    var whole = Math.floor(dec + 1e-9), mins = Math.round((dec - whole) * 60);
    if (mins === 60) { whole += 1; mins = 0; }
    var base = hourLabel(whole);
    if (!mins) return base;
    var parts = base.split(' ');
    return parts[0] + ':' + (mins < 10 ? '0' : '') + mins + (parts[1] ? ' ' + parts[1] : '');
  }

  function outletConfig(id) {
    var list = (MK.config && MK.config.outlets) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function tradingHours(id) {
    var o = outletConfig(id);
    return o && o.hours && isNum(o.hours.open) && isNum(o.hours.close) ? o.hours : null;
  }

  function slotConfig(id) {
    var list = (MK.config && MK.config.slots) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /** True when the outlet's trading hours overlap the slot at all (an outlet that opens after lunch never trades lunch). */
  function tradesSlot(hours, cfg) {
    if (!hours || !cfg || !isNum(cfg.fromHour) || !isNum(cfg.toHour)) return true;
    return hours.open < cfg.toHour && hours.close > cfg.fromHour;
  }

  /** True when no outlet with sales in the selection is open during the slot: a zero there is "closed", not "quiet". */
  function slotClosedForAll(env, slotId) {
    var cfg = slotConfig(slotId);
    if (!cfg || !env.outletRows.length) return false;
    return env.outletRows.every(function (r) {
      var hrs = tradingHours(r.id);
      return hrs ? !tradesSlot(hrs, cfg) : false;
    });
  }

  /** True when the outlet is open for the whole of the hour bucket (a part-hour at opening or closing is not a fair "quietest hour"). */
  function isFullHour(hours, hour) {
    if (!hours) return true;
    return hour >= Math.ceil(hours.open - 1e-9) && hour + 1 <= hours.close + 1e-9;
  }

  /* ---- channels: the POS channel is what the business calls "in-store" */

  function channelInfo(id) {
    var list = (MK.config && MK.config.channels) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function chLong(col) { var c = channelInfo(col.id); return c && c.kind === 'pos' && c.short ? c.short + ' (' + c.label + ')' : col.label; }
  function chInline(col) { var c = channelInfo(col.id); return c && c.kind === 'pos' && c.short ? lowerFirst(c.short) : col.label; }

  function sourceOf(result) { return (result && result.source) || 'petpooja'; }

  /* ---- DOM bits */

  function tableFoot(children) { return h('div', { 'class': 'ts-tablefoot' }, children); }

  /** Two-line column header: keeps a seven-column table inside a two-thirds card at 1280px. */
  function th2(top, bottom) { return h('span', { 'class': 'ts-th2' }, top, h('br'), h('span', { 'class': 'ts-th2__sub' }, bottom)); }

  function note(text, iconName) {
    return h('p', { 'class': 'ts-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, text));
  }

  /**
   * The provisional caption every sales result carries (API.md section 4.5): a range running past Swiggy's last payout
   * annexure is provisional on the restaurant-funded share of the Swiggy discount, and so on net sales and slot shares.
   * `null` for a settled range, with Swiggy out of the selection and with an empty scope.
   */
  function provisionalNote(result) {
    var p = result && result.provisional;
    if (!p || !p.swiggyDiscountSplitFrom) return null;
    return note('Swiggy discount split confirmed with the annexure: Swiggy orders from ' +
      MK.dates.label(p.swiggyDiscountSplitFrom, 'd MMM yyyy') +
      ' are as relayed to the POS, so their restaurant-funded discount and net sales are provisional.', 'info');
  }

  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[revenue-timeslots] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  /* ------------------------------------------------------------------ header: purpose, scope, KPI row */

  function intro(env) {
    var s = env.s;
    return h('p', { 'class': 'ts-intro' },
      'When the orders come in: by weekday and hour, by slot for every outlet and channel, each outlet\'s peak and quiet hours, and weekends against weekdays. ',
      h('strong', { 'class': 'ts-intro__period' }, rangeLabel(s.from, s.to) + ', ' + plural(s.days, 'day') + '.'),
      ' The business day runs from ' + env.dayFrom + ' to ' + env.dayTo + ' the next morning; orders after midnight belong to the day that started.');
  }

  function scopeNote(ctx) {
    var allowed = MK.session.allowedOutletIds();
    var all = MK.session.OUTLET_IDS || [];
    if (!allowed.length || allowed.length >= all.length) return null;
    var names = ((MK.config && MK.config.outlets) || []).filter(function (o) { return has(allowed, o.id); }).map(function (o) { return o.name; });
    var who = ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel : 'Your role';
    return ui.callout('info', null, who + ' sees ' + andList(names) + ' only. Every figure on this page is already limited to that scope, so the outlet comparisons show ' +
      (allowed.length === 1 ? 'one outlet' : 'those outlets') + '.', { icon: 'lock' });
  }

  function kpiBlock(env) {
    var s = env.s, f = env.f, n = env.dowN;
    var hours = MK.data.breakdown(f, 'hour'), slots = MK.data.breakdown(f, 'slot'), dows = MK.data.breakdown(f, 'dow');
    var tiles = [];

    var hx = extremes(hours.rows.map(function (r) { return r.orders > 0 ? r.orders : null; }));
    if (hx) {
      var top = hours.rows[hx.hi];
      tiles.push({ label: 'Busiest hour', value: top.label, icon: 'clock',
        sub: fmt.pct(s.orders ? top.orders / s.orders : null) + ' of orders, ' + say('orders', top.orders / env.days) + ' a day',
        title: 'The hour of the business day with the most orders in the period.' });
    }

    var perDay = dows.rows.map(function (r) { var c = n[+r.id]; return c && r.netSales > 0 ? r.netSales / c : null; });
    var dx = extremes(perDay);
    if (dx) {
      tiles.push({ label: 'Busiest day', value: dows.rows[dx.hi].label, icon: 'calendar',
        sub: fmt.inr(perDay[dx.hi]) + ' on an average ' + dows.rows[dx.hi].label + (dx.lo !== dx.hi ? '; quietest ' + dows.rows[dx.lo].label + ' ' + fmt.inr(perDay[dx.lo]) : ''),
        title: 'Net sales per trading day of each weekday in the period.' });
    }

    var prevTotal = s.prev && s.prev.from ? s.prev.netSales : null;
    slots.rows.forEach(function (r) {
      /* a slot no outlet in the selection is open for is "Closed", not a 0% share: the zero carries no message */
      if (!r.netSales && !r.orders && slotClosedForAll(env, r.id)) {
        tiles.push({ label: r.label + ' share', value: 'Closed', sub: r.range + ', outside the trading hours in view',
          title: 'No outlet in the selection is open between ' + r.range + ', so the slot carries no orders.' });
        return;
      }
      var share = s.netSales ? r.netSales / s.netSales : null;
      var prevShare = prevTotal && isNum(r.prevNetSales) ? r.prevNetSales / prevTotal : null;
      var delta = isNum(share) && isNum(prevShare) ? fmt.points(share, prevShare) : null;
      if (delta && delta.dir === 'flat') delta = { value: delta.value, label: fmt.num(0, 1) + ' pts', dir: 'flat' };
      tiles.push({ label: r.label + ' share', value: fmt.pct(share), delta: delta, goodWhen: 'neutral',
        sub: fmt.inr(r.netSales) + ', ' + r.range,
        title: r.label + ' (' + r.range + ') as a share of net sales' + (delta ? '; change in points against ' + rangeLabel(s.prev.from, s.prev.to) : '') + '.' });
    });

    return h('div', { 'class': 'ts-kpiblock' },
      h('div', { 'class': 'ts-kpis' }, tiles.map(function (t) { return ui.statTile(t); })),
      provisionalNote(s),
      ui.sourceTag(sourceOf(s)));
  }

  /* ------------------------------------------------------------------ A: day of week x hour heatmap */

  function heatSpec(env, measure) {
    var def = MEASURES[measure], n = env.dowN;
    var m = MK.data.matrix(env.f, 'dow', 'hour', measure);
    var counts = m.rows.map(function (r) { return n[+r.id] || 0; });
    var values = m.rows.map(function (r, i) {
      return m.cols.map(function (c, j) { var v = m.values[i][j]; return counts[i] && v > 0 ? v / counts[i] : null; });
    });
    var dayAvg = m.rows.map(function (r, i) { return counts[i] && m.rowTotals[i] > 0 ? m.rowTotals[i] / counts[i] : null; });

    var peak = null;
    values.forEach(function (row, i) { row.forEach(function (v, j) { if (isNum(v) && (!peak || v > peak.v)) peak = { i: i, j: j, v: v }; }); });
    var parts = [];
    if (peak) {
      parts.push('Busiest hour of the week: ' + m.rows[peak.i].label + ' ' + m.cols[peak.j].label + ', ' + say(measure, peak.v) +
        (measure === 'orders' ? ' orders' : '') + ' on an average ' + m.rows[peak.i].label + '.');
    }
    var dx = extremes(dayAvg);
    if (dx && dx.hi !== dx.lo) {
      parts.push(m.rows[dx.hi].label + ' is the strongest day at ' + say(measure, dayAvg[dx.hi]) + (measure === 'orders' ? ' orders' : '') + ', ' +
        m.rows[dx.lo].label + ' the quietest at ' + say(measure, dayAvg[dx.lo]) + ' (' + fmt.delta(dayAvg[dx.lo], dayAvg[dx.hi]).label + ').');
    }

    var used = counts.filter(function (c) { return c > 0; });
    var lo = used.length ? Math.min.apply(null, used) : 0, hi = used.length ? Math.max.apply(null, used) : 0;
    var basis = 'Each cell is the average for that weekday: the period holds ' + (lo === hi ? fmt.num(lo) : fmt.num(lo) + ' to ' + fmt.num(hi)) + ' of each' +
      (used.length < counts.length ? ' (weekdays outside the period stay blank)' : '') + '. Blank hours: no orders, the outlets in the selection are closed.';

    return {
      title: def.label + ' by day of week and hour', subtitle: parts.join(' '), format: chartFormat(measure), note: basis,
      data: { rows: m.rows.map(function (r) { return r.label; }), cols: m.cols.map(function (c) { return c.label; }), values: values, min: 0,
        valueLabel: def.label + ' in the hour, average day', rowHeader: 'Day', colHeader: 'Hour' },
      source: sourceOf(m)
    };
  }

  function heatBlock(env, st) {
    var spec = heatSpec(env, st.measure);
    var chart = MK.charts.mount(null, { id: 'ts-heat', kind: 'heatmap', height: HEAT_HEIGHT, title: spec.title, subtitle: spec.subtitle,
      format: spec.format, data: spec.data, note: spec.note });
    chart.el.appendChild(ui.sourceTag(spec.source));
    return {
      el: chart.el,
      setMeasure: function (value) {
        var next = heatSpec(env, value);
        chart.update({ title: next.title, subtitle: next.subtitle, format: next.format, data: next.data, note: next.note });
      }
    };
  }

  /* ------------------------------------------------------------------ B: slot mix by outlet and by channel */

  /** Shares of each slot per row of an (entity x slot) matrix. */
  function slotShares(m) {
    return m.rows.map(function (r, i) {
      return m.cols.map(function (c, j) { return m.rowTotals[i] ? m.values[i][j] / m.rowTotals[i] : null; });
    });
  }

  /** Share of one slot across every row but one (pooled, not an average of percentages). */
  function pooledShareWithout(m, j, skip) {
    var part = 0, total = 0;
    m.rows.forEach(function (r, i) { if (i === skip) return; part += m.values[i][j]; total += m.rowTotals[i]; });
    return total ? part / total : null;
  }

  function takeawayOutletMix(env, measure, m) {
    var def = MEASURES[measure], shares = slotShares(m), parts = [];
    if (!m.rows.length) return '';
    if (m.rows.length === 1) {
      var hrs = tradingHours(m.rows[0].id);
      /* a slot the outlet does not trade in (no sales at all) is left out of the sentence; the trading hours say why */
      return m.rows[0].label + ': ' + m.cols.map(function (c, j) { return shares[0][j] > 0 ? lowerFirst(c.label) + ' ' + fmt.pct(shares[0][j]) : null; }).filter(Boolean).join(', ') +
        ' of ' + def.noun + (hrs ? '. Trades ' + clockLabel(hrs.open) + ' to ' + clockLabel(hrs.close) + '.' : '.');
    }
    var jl = colIndex(m, LUNCH_SLOT);
    if (jl !== -1) {
      var lx = extremes(shares.map(function (row) { return row[jl]; }));
      if (lx && shares[lx.hi][jl] > 0) {
        parts.push(m.cols[jl].label + ' carries ' + fmt.pct(shares[lx.hi][jl]) + ' of ' + m.rows[lx.hi].label + '\'s ' + def.noun + ', the highest in the selection (' +
          fmt.pct(pooledShareWithout(m, jl, lx.hi)) + ' across the others).');
      }
    }
    var jn = colIndex(m, LATE_SLOT);
    if (jn !== -1) {
      var closes = m.rows.map(function (r) { var t = tradingHours(r.id); return t ? t.close : null; });
      var cx = extremes(closes);
      if (cx) {
        var next = Math.min.apply(null, closes.filter(function (c, i) { return isNum(c) && i !== cx.lo; }));
        if (isNum(next) && next - closes[cx.lo] >= EARLY_CLOSE_GAP_HOURS) {
          parts.push(m.rows[cx.lo].label + ' takes its last orders at ' + clockLabel(closes[cx.lo]) + ', so ' + lowerFirst(m.cols[jn].label) + ' is ' + fmt.pct(shares[cx.lo][jn]) +
            ' of its ' + def.noun + ' against ' + fmt.pct(pooledShareWithout(m, jn, cx.lo)) + ' elsewhere.');
        }
      }
    }
    return parts.join(' ');
  }

  function takeawayChannelMix(env, measure, m) {
    var def = MEASURES[measure], shares = slotShares(m);
    if (!m.rows.length) return '';
    var tops = shares.map(function (row) { var x = extremes(row); return x ? x.hi : -1; });
    var parts = [];
    if (m.rows.length === 1) {
      return chLong(m.rows[0]) + ': ' + m.cols.map(function (c, j) { return lowerFirst(c.label) + ' ' + fmt.pct(shares[0][j]); }).join(', ') + ' of ' + def.noun + '.';
    }
    var same = tops.every(function (t) { return t === tops[0]; });
    if (same && tops[0] !== -1) {
      var col = shares.map(function (row) { return row[tops[0]]; }), cx = extremes(col);
      parts.push(m.cols[tops[0]].label + ' is the largest slot on every channel (' + fmt.pct(col[cx.lo]) + ' to ' + fmt.pct(col[cx.hi]) + ' of ' + def.noun + ').');
    }
    var jn = colIndex(m, LATE_SLOT);
    if (jn !== -1) {
      var late = shares.map(function (row) { return row[jn]; }), lx = extremes(late);
      if (lx && lx.hi !== lx.lo) {
        parts.push(m.cols[jn].label + ' weighs most on ' + chInline(m.rows[lx.hi]) + ' (' + fmt.pct(late[lx.hi]) + ') and least on ' + chInline(m.rows[lx.lo]) + ' (' + fmt.pct(late[lx.lo]) + ').');
      }
    }
    return parts.join(' ');
  }

  function mixSpec(env, measure, by) {
    var def = MEASURES[measure];
    var m = MK.data.matrix(env.f, by, 'slot', measure);
    var series = m.cols.map(function (c, j) {
      return { id: c.id, name: c.label, values: m.rows.map(function (r, i) { return m.values[i][j]; }) };
    });
    var byOutlet = by === 'outlet';
    /* a missing segment is either a quiet slot or a shut one: say which outlets are simply not open then */
    var shut = !byOutlet ? [] : m.rows.map(function (r) {
      var hrs = tradingHours(r.id);
      var out = !hrs ? [] : m.cols.filter(function (c) { return !tradesSlot(hrs, slotConfig(c.id)); });
      return out.length ? r.label + ' at ' + lowerFirst(andList(out.map(function (c) { return c.label; }))) : null;
    }).filter(Boolean);
    return {
      title: 'Slot mix by ' + by + ': ' + def.noun, format: def.format,
      subtitle: byOutlet ? takeawayOutletMix(env, measure, m) : takeawayChannelMix(env, measure, m),
      data: { categories: m.rows.map(function (r) { return byOutlet ? r.label : chLong(r); }), categoryHeader: byOutlet ? 'Outlet' : 'Channel', percent: true, series: series },
      note: m.cols.map(function (c) { return c.label + ' ' + c.range; }).join(', ') + '. Every bar adds up to ' + fmt.pct(1, 0) + ' of its ' + by + '; the table view gives the values.' +
        (shut.length ? ' Closed, so no segment at all: ' + andList(shut) + '.' : ''),
      source: sourceOf(m)
    };
  }

  function mixBlock(env, st, by) {
    var spec = mixSpec(env, st.measure, by);
    var chart = MK.charts.mount(null, { id: 'ts-mix-' + by, kind: 'hstackedBar', height: MIX_HEIGHT, title: spec.title, subtitle: spec.subtitle,
      format: spec.format, data: spec.data, note: spec.note });
    chart.el.appendChild(ui.sourceTag(spec.source));
    return {
      el: chart.el,
      setMeasure: function (value) {
        var next = mixSpec(env, value, by);
        chart.update({ title: next.title, subtitle: next.subtitle, format: next.format, data: next.data, note: next.note });
      }
    };
  }

  /* ------------------------------------------------------------------ C: peak hours per outlet */

  function profileStrip(row) {
    var top = row.peakValue || 0;
    return h('div', { 'class': 'ts-strip', role: 'img', 'aria-label': row.label + ': busiest at ' + row.peakLabel + (row.quietLabel ? ', quietest full hour ' + row.quietLabel : '') },
      row.profile.map(function (p) {
        var open = p.value > 0;
        var step = open && top ? Math.min(SEQ_STEPS.length - 1, Math.floor((p.value / top) * (SEQ_STEPS.length - 1))) : 0;
        return h('span', { 'class': ['ts-strip__cell', open ? '' : 'is-closed'], title: p.label + ': ' + (open ? fmt.pct(p.share) + ' of the day' : 'no orders'),
          style: open ? { background: 'var(' + SEQ_STEPS[step] + ')' } : null });
      }));
  }

  function peakRows(env, measure) {
    var m = MK.data.matrix(env.f, 'outlet', 'hour', measure);
    var rows = m.rows.map(function (r, i) {
      var hrs = tradingHours(r.id), total = m.rowTotals[i], values = m.values[i];
      var peak = -1, quiet = -1;
      m.cols.forEach(function (c, j) {
        var v = values[j];
        if (!(v > 0)) return;
        if (peak === -1 || v > values[peak]) peak = j;
        if (isFullHour(hrs, c.hour) && (quiet === -1 || v < values[quiet])) quiet = j;
      });
      if (quiet === peak) quiet = -1;
      return {
        id: r.id, label: r.label, colourVar: r.colourVar,
        hours: hrs ? clockLabel(hrs.open) + ' - ' + clockLabel(hrs.close) : '',
        peakLabel: peak === -1 ? null : m.cols[peak].label, peakHour: peak === -1 ? null : m.cols[peak].hour,
        peakValue: peak === -1 ? null : values[peak],
        peakShare: peak === -1 || !total ? null : values[peak] / total,
        peakPerDay: peak === -1 ? null : values[peak] / env.days,
        quietLabel: quiet === -1 ? null : m.cols[quiet].label, quietHour: quiet === -1 ? null : m.cols[quiet].hour,
        quietShare: quiet === -1 || !total ? null : values[quiet] / total,
        quietPerDay: quiet === -1 ? null : values[quiet] / env.days,
        ratio: peak !== -1 && quiet !== -1 && values[quiet] ? values[peak] / values[quiet] : null,
        profile: m.cols.map(function (c, j) { return { label: c.label, value: values[j], share: total ? values[j] / total : null }; })
      };
    }).filter(function (r) { return r.peakLabel; });
    return { m: m, rows: rows };
  }

  function takeawayPeak(measure, rows) {
    var def = MEASURES[measure];
    if (!rows.length) return '';
    if (rows.length === 1) {
      var r = rows[0];
      return r.label + ' peaks at ' + r.peakLabel + ' with ' + fmt.pct(r.peakShare) + ' of the day\'s ' + def.noun +
        (r.quietLabel ? '; its quietest full trading hour is ' + r.quietLabel + ' (' + fmt.pct(r.quietShare) + ').' : '.');
    }
    var hx = extremes(rows.map(function (r) { return r.peakHour; }));
    var sx = extremes(rows.map(function (r) { return r.peakShare; }));
    var parts = [];
    parts.push(rows[hx.lo].peakHour === rows[hx.hi].peakHour
      ? 'Every outlet peaks at ' + rows[hx.hi].peakLabel + '.'
      : 'Peaks fall between ' + rows[hx.lo].peakLabel + ' (' + rows[hx.lo].label + ') and ' + rows[hx.hi].peakLabel + ' (' + rows[hx.hi].label + ').');
    parts.push(rows[sx.hi].label + ' is the most concentrated, with ' + fmt.pct(rows[sx.hi].peakShare) + ' of its ' + def.noun + ' in one hour; ' +
      rows[sx.lo].label + ' the most even at ' + fmt.pct(rows[sx.lo].peakShare) + '.');
    return parts.join(' ');
  }

  function peakBlock(env, st) {
    var subtitle = h('span', null, '');
    var body = h('div', { 'class': 'ts-peak' });
    var current = { columns: [], rows: [] };

    function paint() {
      var measure = st.measure, def = MEASURES[measure];
      var data = peakRows(env, measure), first = data.m.cols[0], last = data.m.cols[data.m.cols.length - 1];
      var columns = [
        { key: 'label', label: 'Outlet', csvLabel: 'Outlet', render: function (value, row) {
          return h('div', null,
            h('div', { 'class': 'mk-strong mk-nowrap' }, row.colourVar ? h('span', { 'class': 'mk-legend-dot', style: { background: 'var(' + row.colourVar + ')' } }) : null, value),
            row.hours ? h('div', { 'class': 'mk-xs mk-muted ts-hours' }, 'Open ' + row.hours) : null);
        } },
        { key: 'hours', label: '', csvLabel: 'Trading hours', hidden: true },
        { key: 'peakLabel', label: th2('Busiest', 'hour'), csvLabel: 'Busiest hour', sortValue: function (row) { return row.peakHour; }, align: 'right' },
        { key: 'peakShare', label: th2('Share of day', 'busiest hour'), csvLabel: 'Busiest hour, share of day', format: 'pct', render: ui.cells.bar(null, '--series-1') },
        { key: 'peakPerDay', label: th2(def.label + ' in it', 'per day'), csvLabel: def.label + ' in the busiest hour, per day', align: 'right', render: function (v) { return say(measure, v); } },
        { key: 'quietLabel', label: th2('Quietest', 'full hour'), csvLabel: 'Quietest full trading hour', sortValue: function (row) { return row.quietHour; }, align: 'right',
          title: 'Among the hours the outlet is open from start to finish; the part-hours at opening and closing are left out.',
          render: function (v) { return v || h('span', { 'class': 'mk-faint' }, '-'); } },
        { key: 'quietShare', label: th2('Share of day', 'quietest hour'), csvLabel: 'Quietest hour, share of day', format: 'pct' },
        { key: 'ratio', label: th2('Peak', 'to quiet'), csvLabel: 'Peak to quiet ratio', align: 'right', title: 'Busiest hour divided by the quietest full trading hour.',
          render: function (v) { return isNum(v) ? fmt.num(v, 1) + 'x' : '-'; } },
        { key: 'profile', label: th2('Day profile', (first ? first.label : '') + ' to ' + (last ? last.label : '')), sortable: false, csv: false,
          render: function (v, row) { return profileStrip(row); } }
      ];
      var csvColumns = columns.filter(function (c) { return c.csv !== false; }).map(function (c) { return { key: c.key, label: c.csvLabel }; });
      columns = columns.filter(function (c) { return !c.hidden; });
      current = { columns: csvColumns, rows: data.rows };
      subtitle.textContent = takeawayPeak(measure, data.rows);
      ui.clear(body);
      body.appendChild(ui.table({ columns: columns, rows: data.rows, sortable: true, sort: st.peakSort || null, onSort: function (s) { st.peakSort = s; },
        empty: 'No orders for this selection' }));
      body.appendChild(tableFoot([
        note('Shares are of the outlet\'s own ' + def.noun + ' in the period. The day profile shades each hour against the outlet\'s own peak: a pale evening at one outlet and a pale lunch at another are both spare capacity; blank hours are closed.', 'info'),
        ui.sourceTag(sourceOf(data.m))
      ]));
    }

    paint();
    return {
      el: ui.card({ title: 'Peak and quiet hours by outlet', subtitle: subtitle, flush: true, body: body,
        actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', title: 'Download this table',
          onClick: function () { ui.downloadCsv('peak-hours_' + env.s.from + '_' + env.s.to + '.csv', current.columns, current.rows); } }) }),
      setMeasure: paint
    };
  }

  /* ------------------------------------------------------------------ D: weekday vs weekend by outlet */

  function dayTypeAverages(m, i, n) {
    var out = {};
    DAY_TYPES.forEach(function (t) {
      var days = 0, total = 0;
      m.cols.forEach(function (c, j) { if (has(t.dows, +c.id)) { days += n[+c.id] || 0; total += m.values[i][j]; } });
      out[t.id] = days ? total / days : null;
    });
    return out;
  }

  function weekRows(env, measure) {
    var n = env.dowN;
    var m = MK.data.matrix(env.f, 'outlet', 'dow', measure);
    var rows = m.rows.map(function (r, i) {
      var avg = dayTypeAverages(m, i, n);
      var row = { id: r.id, label: r.label, colourVar: r.colourVar, weekday: avg.weekday, friday: avg.friday, weekend: avg.weekend,
        lift: avg.weekday > 0 && isNum(avg.weekend) ? avg.weekend / avg.weekday - 1 : null, lunchWeekday: null, lunchWeekend: null, lunchClosed: false };
      /* the lunch share of each day type needs the outlet's own day x slot grid */
      var ds = MK.data.matrix(withOutlet(env.f, r.id), 'dow', 'slot', measure), jl = colIndex(ds, LUNCH_SLOT);
      if (ds.supported !== false && jl !== -1) {
        DAY_TYPES.forEach(function (t) {
          if (t.id === 'friday') return;
          var part = 0, total = 0;
          ds.rows.forEach(function (dr, di) { if (has(t.dows, +dr.id)) { part += ds.values[di][jl]; total += ds.rowTotals[di]; } });
          row[t.id === 'weekday' ? 'lunchWeekday' : 'lunchWeekend'] = total ? part / total : null;
        });
        var hrs = tradingHours(r.id), cfg = slotConfig(ds.cols[jl].id);
        row.lunchClosed = !!(hrs && cfg && !tradesSlot(hrs, cfg));
      }
      return row;
    });
    return { m: m, rows: rows, lunchLabel: (function () { var s = slotConfig(LUNCH_SLOT); return s ? s.label : 'Lunch'; })() };
  }

  function signed(v) { return isNum(v) ? fmt.delta(1 + v, 1).label : '-'; }

  function takeawayWeek(measure, data) {
    var def = MEASURES[measure], rows = data.rows.filter(function (r) { return isNum(r.lift); });
    if (!rows.length) return 'The period holds no full comparison of ' + DAY_TYPES[0].label + ' against ' + DAY_TYPES[2].label + ' days: widen the date range.';
    var wd = DAY_TYPES[0].label, we = DAY_TYPES[2].label, parts = [];
    if (rows.length === 1) {
      var only = rows[0];
      parts.push('At ' + only.label + ' a ' + we + ' day runs ' + signed(only.lift) + ' in ' + def.noun + ' against a ' + wd + ' day' +
        (isNum(only.friday) && only.weekday > 0 ? '; a ' + DAY_TYPES[1].label + ' runs ' + signed(only.friday / only.weekday - 1) : '') + '.');
    } else {
      var lx = extremes(rows.map(function (r) { return r.lift; })), low = rows[lx.lo], high = rows[lx.hi];
      var others = rows.filter(function (r) { return r !== low; });
      var pooled = sum(others.map(function (r) { return r.weekend; })) / sum(others.map(function (r) { return r.weekday; })) - 1;
      var negatives = rows.filter(function (r) { return r.lift < 0; });
      if (negatives.length === 1 && negatives[0] === low) {
        parts.push(low.label + ' is the only outlet that trades down at the weekend: a ' + we + ' day runs ' + signed(low.lift) + ' against a ' + wd + ' day, at the other outlets ' + signed(pooled) + '.');
      } else {
        parts.push('Weekend lift runs from ' + signed(low.lift) + ' at ' + low.label + ' to ' + signed(high.lift) + ' at ' + high.label + ' (' + we + ' day against ' + wd + ' day).');
      }
    }
    var skew = null;
    data.rows.forEach(function (r) {
      if (!isNum(r.lunchWeekday) || !isNum(r.lunchWeekend)) return;
      var gap = r.lunchWeekday - r.lunchWeekend;
      if (gap >= LUNCH_SKEW_PTS && (!skew || gap > skew.gap)) skew = { row: r, gap: gap };
    });
    if (skew) {
      parts.push(data.lunchLabel + ' is ' + fmt.pct(skew.row.lunchWeekday) + ' of ' + skew.row.label + '\'s ' + wd + ' ' + def.noun + ' and ' + fmt.pct(skew.row.lunchWeekend) +
        ' at the weekend: a weekday-lunch business.');
    }
    return parts.join(' ');
  }

  /** The chart's own takeaway: how far apart the outlets are, and how many lose trade at the weekend. */
  function takeawayWeekChart(measure, data) {
    var def = MEASURES[measure], rows = data.rows.filter(function (r) { return isNum(r.lift); });
    if (!rows.length) return 'Each bar is a ' + lowerFirst(DAY_TYPES[2].label) + ' day against a ' + lowerFirst(DAY_TYPES[0].label) + ' day';
    var lx = extremes(rows.map(function (r) { return r.lift; }));
    var down = rows.filter(function (r) { return r.lift < 0; });
    var span = rows.length === 1
      ? rows[0].label + ' runs ' + signed(rows[0].lift) + ' in ' + def.noun + ' on a ' + DAY_TYPES[2].label + ' day'
      : 'From ' + signed(rows[lx.lo].lift) + ' at ' + rows[lx.lo].label + ' to ' + signed(rows[lx.hi].lift) + ' at ' + rows[lx.hi].label;
    if (!down.length) return span + '; every outlet trades up at the weekend.';
    if (down.length === rows.length) return span + '; every outlet trades down at the weekend.';
    return span + '; ' + andList(down.map(function (r) { return r.label; })) + (down.length === 1 ? ' is the one that trades down.' : ' trade down.');
  }

  function weekChartSpec(measure, data) {
    var def = MEASURES[measure], rows = data.rows.filter(function (r) { return isNum(r.lift); });
    return {
      title: 'Weekend against weekday: ' + def.noun,
      subtitle: takeawayWeekChart(measure, data),
      data: { categories: rows.map(function (r) { return r.label; }), values: rows.map(function (r) { return r.lift; }), name: 'Weekend day vs weekday day',
        zeroLabel: DAY_TYPES[0].label + ' day', posLabel: 'Weekend day brings more', negLabel: 'Weekend day brings less', categoryHeader: 'Outlet' }
    };
  }

  function weekBlock(env, st) {
    var first = weekRows(env, st.measure), spec = weekChartSpec(st.measure, first);
    /* one outlet in scope would make a one-bar chart, which says less than the sentence above the table: the table takes the width */
    var wantChart = first.rows.length > 1;
    var chart = !wantChart ? null : MK.charts.mount(null, { id: 'ts-week', kind: 'divergingBar', height: WEEK_HEIGHT, format: 'pct',
      title: spec.title, subtitle: spec.subtitle, data: spec.data, emptyText: 'The period needs both weekdays and a weekend' });
    if (chart) chart.el.appendChild(ui.sourceTag(sourceOf(first.m)));

    var subtitle = h('span', null, '');
    var body = h('div', { 'class': 'ts-week' });
    function lunchCell(v, row) {
      if (row.lunchClosed) return h('span', { 'class': 'mk-muted' }, 'Closed');
      return isNum(v) ? fmt.pct(v) : '-';
    }
    function paintTable(measure, data) {
      var perDay = function (v) { return say(measure, v); };
      var columns = [
        { key: 'label', label: 'Outlet', render: ui.cells.entity(function (row) { return row.colourVar; }) },
        { key: 'weekday', label: th2(DAY_TYPES[0].label, 'per day'), align: 'right', render: perDay },
        { key: 'friday', label: th2(DAY_TYPES[1].label, 'per day'), align: 'right', render: perDay },
        { key: 'weekend', label: th2(DAY_TYPES[2].label, 'per day'), align: 'right', render: perDay },
        { key: 'lift', label: th2('Weekend', 'lift'), align: 'right', render: ui.cells.delta('up'), title: DAY_TYPES[2].label + ' day against ' + DAY_TYPES[0].label + ' day' },
        { key: 'lunchWeekday', label: th2(data.lunchLabel + ' share', DAY_TYPES[0].label), align: 'right', render: lunchCell },
        { key: 'lunchWeekend', label: th2(data.lunchLabel + ' share', DAY_TYPES[2].label), align: 'right', render: lunchCell }
      ];
      subtitle.textContent = takeawayWeek(measure, data);
      ui.clear(body);
      /* not sortable: the sort arrows would push a seven-column table past its card at 1280px, and the chart beside it already ranks the outlets */
      body.appendChild(ui.table({ columns: columns, rows: data.rows, empty: 'No orders for this selection' }));
      var n = env.dowN, counts = DAY_TYPES.map(function (t) { return plural(sum(t.dows.map(function (d) { return n[d]; })), t.label + ' day'); });
      body.appendChild(tableFoot([
        note('Averages per trading day; the period holds ' + andList(counts) + '. Friday is shown on its own: an office lunch and a weekend evening in one day.', 'info'),
        ui.sourceTag(sourceOf(data.m))
      ]));
    }
    paintTable(st.measure, first);

    var tableCard = ui.card({ title: 'Weekday and weekend trading by outlet', subtitle: subtitle, flush: true, body: body });
    var el = !chart ? tableCard : h('div', { 'class': 'mk-grid mk-grid--12 ts-weekgrid' },
      h('div', { 'class': 'mk-col-4 ts-cell' }, chart.el),
      h('div', { 'class': 'mk-col-8 ts-cell' }, tableCard));
    return {
      el: el,
      setMeasure: function (value) {
        var data = weekRows(env, value), next = weekChartSpec(value, data);
        if (chart) chart.update({ title: next.title, subtitle: next.subtitle, data: next.data });
        paintTable(value, data);
      }
    };
  }

  /* ------------------------------------------------------------------ E: kitchen prep time on aggregator orders */

  var PREP_FIELD = 'order.prepTime';

  function minutes(v) { return isNum(v) ? fmt.num(v, 1) + ' min' : '-'; }

  function prepBlock(env) {
    if (typeof MK.data.recentOrders !== 'function' || typeof MK.data.can !== 'function') return null;
    var channels = ((MK.config && MK.config.channels) || []);
    var capable = channels.filter(function (c) { return MK.data.can(c.id, PREP_FIELD) !== 'no'; });
    if (!capable.length) return null;                                 /* the data layer does not expose prep time at all: leave the block out */

    var probe = MK.data.recentOrders(env.f, { limit: 1, status: 'completed' });
    var res = probe && probe.total > 1 ? MK.data.recentOrders(env.f, { limit: probe.total, status: 'completed' }) : probe;
    var orders = ((res && res.rows) || []).filter(function (o) { return capable.some(function (c) { return c.id === o.channelId; }); });
    var windowLabel = res && res.windowFrom ? rangeLabel(res.windowFrom, res.windowTo) : '';
    var kept = res && res.windowFrom ? 'the last ' + plural(MK.dates.diffDays(res.windowFrom, res.windowTo) + 1, 'day') : 'the most recent days';
    var derived = 'Derived from POS status times, where staff mark orders ready.';
    var title = 'Kitchen prep time on aggregator orders';

    if (!orders.length) {
      var ids = function (list) { return typeof list === 'string' ? [list] : (list || []); };
      var chSel = ids(env.f.channelIds), mdSel = ids(env.f.mediumIds);
      var selected = channels.filter(function (c) { return !chSel.length || has(chSel, c.id); });
      var blind = selected.filter(function (c) { return MK.data.can(c.id, PREP_FIELD) === 'no'; });
      var onlyBlind = selected.length > 0 && blind.length === selected.length;
      /* which combinations of channel and medium the current filter still admits for a channel that can time its orders */
      var live = ((MK.config && MK.config.streams) || []).filter(function (s) {
        return capable.some(function (c) { return c.id === s.channelId; }) && (!chSel.length || has(chSel, s.channelId)) && (!mdSel.length || has(mdSel, s.mediumId));
      });
      var mediumLabels = capable.map(function (c) {
        var own = ((MK.config && MK.config.streams) || []).filter(function (s) { return s.channelId === c.id; });
        return own.length ? (((MK.config && MK.config.mediums) || []).filter(function (m) { return m.id === own[0].mediumId; })[0] || {}).label : null;
      }).filter(Boolean);
      var inWindow = !(res && res.windowFrom) || (env.s.from <= res.windowTo && env.s.to >= res.windowFrom);
      var why;
      if (onlyBlind) {
        why = 'Prep time exists only for ' + andList(capable.map(function (c) { return c.label; })) + ' orders relayed into the POS. Include an aggregator in the channel filter to see it.';
      } else if (!live.length) {
        why = andList(capable.map(function (c) { return c.label; })) + ' orders are ' + lowerFirst(andList(mediumLabels.filter(function (l, i, a) { return a.indexOf(l) === i; }))) +
          ' only, and the medium filter leaves none of them in the selection. Clear the medium filter to see prep times.';
      } else if (!inWindow) {
        why = 'Order-level status times are kept for ' + kept + (windowLabel ? ' (' + windowLabel + ')' : '') + '. Move the date range into that window to see prep times.';
      } else {
        why = 'No ' + andList(capable.map(function (c) { return c.label; })) + ' order in this selection falls inside ' + kept + (windowLabel ? ' (' + windowLabel + ')' : '') + '.';
      }
      return ui.card({ title: title, subtitle: derived, body: [
        blind.length ? h('div', { 'class': 'mk-row mk-row--wrap' }, blind.map(function (c) { return ui.notProvided(c.label, 'In-store bills carry no kitchen status times'); })) : null,
        h('p', { 'class': 'ts-prep-empty' }, why),
        ui.sourceTag('petpooja')] });
    }
    if (!orders.some(function (o) { return isNum(o.prepMinutes); })) return null;

    var present = capable.filter(function (c) { return orders.some(function (o) { return o.channelId === c.id; }); });
    var slots = (MK.config && MK.config.slots) || [];
    function stats(list) {
      var marked = list.filter(function (o) { return isNum(o.prepMinutes); }), total = sum(marked.map(function (o) { return o.prepMinutes; }));
      return { orders: list.length, marked: marked.length, minutes: total, avg: marked.length ? total / marked.length : null,
        markedShare: list.length ? marked.length / list.length : null };
    }
    function rowFor(id, label, range, list) {
      var all = stats(list), row = { id: id, label: label, range: range, avg: all.avg, minutes: all.minutes, marked: all.marked, orders: all.orders, markedShare: all.markedShare };
      present.forEach(function (c) { row['c_' + c.id] = stats(list.filter(function (o) { return o.channelId === c.id; })).avg; });
      return row;
    }
    var rows = slots.map(function (s) { return rowFor(s.id, s.label, s.range, orders.filter(function (o) { return o.slotId === s.id; })); })
      .filter(function (r) { return r.orders > 0; });
    var total = rowFor('all', 'All slots', '', orders);

    var columns = [{ key: 'label', label: 'Slot', render: ui.cells.twoLine('range') }];
    present.forEach(function (c) {
      columns.push({ key: 'c_' + c.id, label: c.label + ', average', align: 'right', render: function (v) { return minutes(v); } });
    });
    if (present.length > 1) columns.push({ key: 'avg', label: 'Both, average', align: 'right', render: function (v) { return h('strong', null, minutes(v)); } });
    columns.push({ key: 'marked', label: 'Orders marked ready', format: 'num' });
    columns.push({ key: 'markedShare', label: 'Share of aggregator orders', format: 'pct', render: ui.cells.bar(1, '--series-1') });

    var footer = { label: total.label, avg: minutes(total.avg), marked: total.marked, markedShare: fmt.pct(total.markedShare) };
    present.forEach(function (c) { footer['c_' + c.id] = minutes(total['c_' + c.id]); });

    /* the decision here is where to put a second hand on the pass, so the sentence names the slow slot and the gap to the rest
       (rounded averages of two slots can read alike, so "fastest" is not said unless it stands clear of the others) */
    var timed = rows.filter(function (r) { return isNum(r.avg); }), sx = extremes(timed.map(function (r) { return r.avg; }));
    var takeaway;
    if (sx && timed.length > 1) {
      var slow = timed[sx.hi], others = timed.filter(function (r) { return r !== slow; });
      var restMarked = sum(others.map(function (r) { return r.marked; })), rest = restMarked ? sum(others.map(function (r) { return r.minutes; })) / restMarked : null;
      takeaway = slow.label + ' is the slow slot at ' + minutes(slow.avg) +
        (isNum(rest) ? ', ' + minutes(slow.avg - rest) + ' above the other slots together' : '') + '; ' +
        fmt.pct(total.markedShare) + ' of aggregator orders carry a ready mark.';
    } else {
      takeaway = 'The average is ' + minutes(total.avg) + ' across ' + plural(timed.length, 'slot') + '; ' +
        fmt.pct(total.markedShare) + ' of aggregator orders carry a ready mark.';
    }

    var partial = present.filter(function (c) { return MK.data.can(c.id, PREP_FIELD) === 'partial'; });
    /* the channels the matrix says cannot time an order stay named under the table, so the gap is visible and not just absent */
    var blindHere = channels.filter(function (c) { return MK.data.can(c.id, PREP_FIELD) === 'no'; });
    return ui.card({ title: title, subtitle: takeaway, flush: true, body: [
      ui.table({ columns: columns, rows: rows, footer: footer, dense: true, empty: 'No aggregator orders in ' + kept + ' for this selection' }),
      tableFoot([
        blindHere.length ? h('div', { 'class': 'mk-row mk-row--wrap' }, blindHere.map(function (c) { return ui.notProvided(c.label, 'In-store bills carry no kitchen status times'); })) : null,
        note(derived + ' Accepted to food ready, completed ' + andList(present.map(function (c) { return c.label; })) + ' orders, ' + rangeLabel(res.from, res.to) +
          ' (order-level times are kept for ' + kept + '). ' + (partial.length ? 'Orders without a ready mark are left out of the averages. ' : '') +
          'In-store bills carry no kitchen status times, so they are not shown.', 'info'),
        ui.sourceTag('petpooja')
      ])] });
  }

  /* ------------------------------------------------------------------ empty state */

  function emptyView(ctx) {
    if (!MK.session.allowedOutletIds().length) {
      var who = ctx.user && ctx.user.name ? ctx.user.name : 'This role';
      return ui.card({ body: ui.emptyState('No outlet sales in your scope',
        who + ' has no customer-facing outlet in scope, and the factory takes no orders of its own. Switch to a role that covers an outlet to see trading hours.', { icon: 'store' }) });
    }
    var f = ctx.filters || {};
    var clash = f.channelIds && f.channelIds.length && f.mediumIds && f.mediumIds.length;
    return ui.card({ body: ui.emptyState('No orders for this selection',
      clash ? 'The channel and medium filters do not overlap: dine-in and takeaway are sold in-store, delivery runs through the aggregators. Reset the filters to see orders again.'
        : 'No orders were recorded for these filters. Widen the date range or reset the filters.',
      { icon: 'filter', action: ui.button({ label: 'Reset filters', icon: 'refresh', onClick: function () { MK.filters.reset(); } }) }) });
  }

  /* ------------------------------------------------------------------ page */

  function render(rootEl, ctx) {
    var st = ctx.state, f = ctx.filters || {};
    if (!MEASURES[st.measure]) st.measure = 'orders';

    var s = MK.data.summary(f);
    if (!s || !s.orders) { rootEl.appendChild(emptyView(ctx)); return; }

    var hoursCfg = (MK.config && MK.config.hours) || [];
    var env = { f: f, s: s, days: s.days || 1, dowN: dowCounts(s.from, s.to),
      outletRows: (MK.data.breakdown(f, 'outlet').rows || []),
      dayFrom: hoursCfg.length ? hoursCfg[0].label : '', dayTo: hoursCfg.length ? hourLabel(hoursCfg[hoursCfg.length - 1].hour + 1) : '' };

    rootEl.appendChild(intro(env));
    var scope = scopeNote(ctx);
    if (scope) rootEl.appendChild(scope);
    safe(rootEl, 'The KPI row', function () { return kpiBlock(env); });

    /* one measure switch drives every block below it, so they always answer the same question */
    var blocks = [];
    function block(parent, name, build) {
      safe(parent, name, function () { var b = build(); blocks.push(b); return b.el; });
    }
    rootEl.appendChild(ui.sectionTitle('The week, hour by hour', 'Where the kitchen is stretched and where it idles', [
      h('span', { 'class': 'mk-small mk-muted' }, 'Measure'),
      ui.segmented({ ariaLabel: 'Measure for every block below', value: st.measure, options: MEASURE_OPTIONS,
        onChange: function (value) {
          st.measure = value;
          blocks.forEach(function (b) {
            try { b.setMeasure(value); } catch (e) { if (root.console) root.console.error('[revenue-timeslots] measure switch', e); }
          });
        } })
    ]));
    block(rootEl, 'The day and hour heatmap', function () { return heatBlock(env, st); });

    rootEl.appendChild(ui.sectionTitle('Slot mix', 'Lunch, evening, dinner and late night as a share of each outlet and each channel'));
    var pair = h('div', { 'class': 'mk-grid mk-grid--2 ts-pair' });
    block(pair, 'Slot mix by outlet', function () { return mixBlock(env, st, 'outlet'); });
    block(pair, 'Slot mix by channel', function () { return mixBlock(env, st, 'channel'); });
    rootEl.appendChild(pair);

    rootEl.appendChild(ui.sectionTitle('Peaks, quiet hours and weekends', 'Per outlet: when to staff up, and which hours and days have room to grow'));
    block(rootEl, 'The peak-hour table', function () { return peakBlock(env, st); });
    block(rootEl, 'Weekday against weekend', function () { return weekBlock(env, st); });

    safe(rootEl, 'Kitchen prep time', function () {
      var card = prepBlock(env);
      if (!card) return null;
      return ui.stack([ui.sectionTitle('Kitchen speed', 'Aggregator orders only: their status times are the ones that reach the POS'), card]);
    });
  }

  MK.router.register({
    id: 'revenue-timeslots',
    route: '#/revenue/timeslots',
    group: 'Revenue',
    title: 'Time slots',
    subtitle: 'When the orders come in, by day and hour',
    units: 'outlets',
    roles: null,
    filters: ['date', 'outlet', 'channel', 'medium'],
    render: render
  });
})(window);
