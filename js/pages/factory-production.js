/*
 * #/factory/production - Production and dispatch of the central kitchen (client brief area 8).
 *
 * Everything on this screen is a quantity: what was planned, what came out of the kitchen, what the
 * yield was against the standard the transfer price was built on, what was lost to wastage and
 * write-offs, and what reached each outlet against what it asked for. Money appears only where a
 * quantity has to be valued (extra input at standard price, transfer value of a dispatch).
 *
 * The global date filter drives the whole screen (production and dispatch are daily data, unlike the
 * monthly cost view of Factory economics). Page-local state in ctx.state: the product whose yield
 * trend is drawn and the grain of the output trend.
 *
 * Blocks, in reading order:
 *   header      purpose, period, the yield exception found anywhere in the data (with a filter jump)
 *   KPI row     produced, plan adherence, yield, wastage, write-offs, dispatched, fill rate, capacity
 *   plan        plan against actual by product, and the output trend against capacity
 *   yield       yield by product against standard (diverging variance) and the trend of one product
 *   losses      wastage and write-offs by product, and indent against dispatch with the fill rate
 *   dispatch    the product x outlet matrix, then the largest short shipments with their reasons
 *
 * Source tags: production, yields and wastage are captured in the ERP; indents and transfers are
 * reconciled against Petpooja, which is what the capability matrix allows it to supply.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt, D = MK.dates;

  var PAGE_ID = 'factory-production';

  /* layout constants (pixels and UI rules, never data) */
  var H_PLAN = 360;
  var H_TREND = 360;
  var H_MATRIX = 360;
  var SHORT_ROWS_HEIGHT = 300;

  var SRC_ERP = ['erp'];
  var SRC_DISPATCH = ['erp', 'petpooja'];

  var GRAIN_LABELS = { day: 'Day', week: 'Week', month: 'Month' };
  var GRAIN_WORD = { day: 'day', week: 'week', month: 'month' };
  /* how far below the region's target a fill rate may sit before the meter reads critical rather than warn (UI rule, not data) */
  var FILL_WARN_BAND = 0.02;

  /* ------------------------------------------------------------------ small helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v) { return isNum(v) ? v : 0; }
  function r1(v) { return Math.round(num(v) * 10) / 10; }
  function money(v) { return isNum(v) ? fmt.inrFull(Math.round(v)) : '-'; }
  function sum(list) { var t = 0; (list || []).forEach(function (v) { t += num(v); }); return t; }

  function call(fn, fallback) {
    try { var v = fn(); return v === undefined ? fallback : v; } catch (e) {
      if (root.console) root.console.error('[' + PAGE_ID + '] data call failed', e);
      return fallback;
    }
  }

  function safe(parent, name, build) {
    try {
      var node = build();
      if (node) parent.appendChild(node);
    } catch (e) {
      if (root.console) root.console.error('[' + PAGE_ID + '] ' + name, e);
      parent.appendChild(ui.callout('warn', name + ' could not be drawn', String((e && e.message) || e)));
    }
  }

  function rangeLabel(from, to) {
    if (!from || !to) return '';
    if (from === to) return D.label(from, 'd MMM yyyy');
    var sameYear = from.slice(0, 4) === to.slice(0, 4);
    return D.label(from, sameYear ? 'd MMM' : 'd MMM yyyy') + ' - ' + D.label(to, 'd MMM yyyy');
  }

  function bandText(band, format) {
    if (!band || band.length !== 2) return '';
    var f = format || function (v) { return fmt.pct(v, 1); };
    return 'Target ' + f(band[0]) + ' to ' + f(band[1]);
  }
  function inBand(v, band) { return !band || !isNum(v) ? true : (v >= band[0] && v <= band[1]); }

  function tidy(delta, zeroLabel) {
    if (!delta || delta.value === null || delta.value === undefined) return null;
    if (delta.dir !== 'flat') return delta;
    return { value: delta.value, label: zeroLabel, dir: 'flat' };
  }
  function pointsDelta(cur, prev) { return isNum(cur) && isNum(prev) ? tidy(fmt.points(cur, prev), fmt.num(0, 1) + ' pts') : null; }

  function plural(n, one, many) { return fmt.num(n) + ' ' + (Math.abs(n) === 1 ? one : many); }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''; }

  function andList(items) {
    var list = (items || []).filter(Boolean);
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function note(text, iconName, extra) {
    return h('p', { 'class': 'fp-note' }, iconName ? ui.icon(iconName, 14) : null, h('span', null, text), extra || null);
  }

  function sourceEnd(ids) {
    var tag = ui.sourceTag(ids);
    tag.classList.add('fp-source-end');
    return tag;
  }

  /**
   * Grid cell wrapper. MK.charts rewrites the card's className on every draw (js/core/charts.js), which
   * drops the mk-col-* class MK.ui.grid puts on a child of a 12-column grid: the card would collapse the
   * first time a reader switches it to its table twin. Wrapping keeps the span on an element the kit
   * never touches; the card inside stretches to the row height.
   */
  function cell(node) { return node ? h('div', { 'class': 'fp-cell' }, node) : null; }

  function yieldText(v) { return isNum(v) ? fmt.num(v, 3) : '-'; }
  function yieldFormat(v, where) {
    if (!isNum(v)) return '-';
    return where === 'axis' ? fmt.num(v, 2) : fmt.num(v, 3);
  }
  function kg1(v) { return isNum(v) ? fmt.kg(v, 1) : '-'; }
  /** A share too small to print reads as a plain zero, never as "-0.0%". */
  function tidyPct(v) { return isNum(v) ? (Math.abs(v) < 0.0005 ? 0 : v) : null; }

  /** Muted note carrying the limitation the capability matrix states for a Petpooja field. */
  function capabilityNote(fieldKey, lead, tail) {
    if (!MK.data || typeof MK.data.capability !== 'function') return null;
    var cap = call(function () { return MK.data.capability(fieldKey); }, null);
    var can = call(function () { return MK.data.can('petpooja', fieldKey); }, null);
    if (!cap || can !== 'partial' || !cap.note) return null;
    return note(lead + ' ' + lowerFirst(cap.note) + '.' + (tail ? ' ' + tail : ''), 'info');
  }

  /** Inline bar growing left or right from a centred zero line - the kit has no diverging table cell. */
  function divBarCell(format) {
    return function (value, row, col, ctx) {
      var rows = (ctx && ctx.rows) || [];
      var max = 0;
      rows.forEach(function (r) { var v = r[col.key]; if (isNum(v)) max = Math.max(max, Math.abs(v)); });
      var share = (max > 0 && isNum(value)) ? Math.min(1, Math.abs(value) / max) : 0;
      var neg = isNum(value) && value < 0;
      return h('div', { 'class': 'fp-divbar' },
        h('span', { 'class': 'fp-divbar__track', 'aria-hidden': 'true' },
          h('span', {
            'class': ['fp-divbar__fill', neg ? 'is-neg' : 'is-pos'],
            style: { width: (share * 50).toFixed(1) + '%', left: neg ? (50 - share * 50).toFixed(1) + '%' : '50%' }
          })),
        h('span', { 'class': 'fp-divbar__value' }, ui.format(format || col.format, value, row)));
    };
  }

  function fillMeter(band) {
    return function (value, row) {
      var floor = (band && band.length === 2) ? band[0] : null;
      var tone = !isNum(value) ? 'neutral'
        : (floor === null ? 'auto' : (value >= floor ? 'good' : (value >= floor - FILL_WARN_BAND ? 'warn' : 'critical')));
      var meter = ui.meter({
        value: num(value), max: 1, size: 'sm', tone: tone, valueLabel: fmt.pct(value),
        label: row.outlet + ' fill rate',
        target: floor === null ? null : floor, targetLabel: floor === null ? null : 'Target ' + fmt.pct(floor, 0)
      });
      /* a page-owned wrapper fixes the column width; the meter itself is the kit's and is not restyled */
      return h('div', { 'class': 'fp-fill' }, meter);
    };
  }

  /* ------------------------------------------------------------------ environment */

  function grainOptions(days) {
    var list = [{ value: 'day', label: GRAIN_LABELS.day }];
    if (days >= 14) list.push({ value: 'week', label: GRAIN_LABELS.week });
    if (days >= 62) list.push({ value: 'month', label: GRAIN_LABELS.month });
    return list;
  }

  function buildEnv(ctx) {
    var st = ctx.state;
    var f = ctx.filters || {};
    var summary = call(function () { return MK.factory.summary(f); }, null);
    var range = { from: (summary && summary.from) || f.from, to: (summary && summary.to) || f.to };
    var days = num(summary && summary.days);
    var options = grainOptions(days);
    var grain = st.grain;
    var ok = false;
    options.forEach(function (o) { if (o.value === grain) ok = true; });
    if (!ok) grain = null;

    var env = {
      ctx: ctx, st: st, f: f, range: range, days: days, summary: summary,
      grainOptions: options, grain: grain,
      production: call(function () { return grain ? MK.factory.production(f, { grain: grain }) : MK.factory.production(f); }, null),
      dispatch: call(function () { return MK.factory.dispatch(f); }, null)
    };
    env.targets = (summary && summary.targets) || {};
    env.rows = (env.production && env.production.rows) || [];
    env.buckets = (env.production && env.production.buckets) || [];
    env.flags = (env.production && env.production.yieldFlags) || [];
    env.grain = (env.production && env.production.grain) || 'day';

    /* the product whose yield trend is drawn: a flagged one first, else the largest line */
    var wanted = st.sku;
    var known = false;
    env.rows.forEach(function (r) { if (r.sku === wanted) known = true; });
    if (!known) {
      var byFlag = env.flags.length ? env.flags[0].sku : null;
      /* no flag: open on the line furthest from its standard, which is the one worth looking at */
      var furthest = env.rows.slice().sort(function (a, b) { return num(a.yieldVariancePct) - num(b.yieldVariancePct); })[0];
      wanted = byFlag || (furthest ? furthest.sku : null);
    }
    env.sku = wanted;
    return env;
  }

  /** The data layer's own yield rule, applied month by month over the whole dataset. */
  function yieldExceptions(env) {
    var out = [];
    var all = call(function () { return MK.factory.production({ from: null, to: null }, { grain: 'month' }); }, null);
    ((all && all.buckets) || []).forEach(function (b) {
      var p = call(function () { return MK.factory.production({ from: b.from, to: b.to }); }, null);
      ((p && p.yieldFlags) || []).forEach(function (fl) {
        out.push({ bucket: b, flag: fl, inRange: b.from >= env.range.from && b.to <= env.range.to });
      });
    });
    out.sort(function (a, b) { return num(a.flag.yieldVariancePct) - num(b.flag.yieldVariancePct); });
    return out;
  }

  /* ------------------------------------------------------------------ header */

  function header(env) {
    var ctx = env.ctx, st = env.st, s = env.summary;
    var box = h('section', { 'class': 'fp-head' });

    box.appendChild(h('p', { 'class': 'fp-intro' },
      'What the kitchen planned to make, what it actually made and what reached each outlet: the plan, the yield against the standards the transfer prices ' +
      'were built on, what was lost on the way, and how much of every indent was filled.'));

    box.appendChild(h('div', { 'class': 'fp-period' },
      h('div', { 'class': 'fp-period__label' },
        ui.icon('calendar', 14), h('span', { 'class': 'mk-muted' }, 'Period'),
        h('strong', null, rangeLabel(env.range.from, env.range.to)),
        h('span', { 'class': 'mk-muted' }, plural(env.days, 'day', 'days') + ', grouped by ' + GRAIN_WORD[env.grain])),
      h('div', { 'class': 'fp-period__label' },
        ui.icon('factory', 14), h('span', { 'class': 'mk-muted' }, 'Capacity'),
        h('strong', null, fmt.kg(num(s && s.capacityKgPerDay), 0) + ' a day'))));

    if (env.flags.length) {
      /* "flagged" matches the KPI tile and the yield card: several lines may sit a shade under standard while
         only the ones the data layer flags are far enough below to be worth acting on. */
      box.appendChild(ui.callout('warn', plural(env.flags.length, 'product is', 'products are') + ' flagged below standard yield in this period',
        env.flags.map(function (fl) {
          return fl.name + ' at ' + yieldText(fl.actualYield) + ' against ' + yieldText(fl.stdYield) + ', ' +
            fmt.pct(Math.abs(num(fl.yieldVariancePct))) + ' below standard and ' + money(fl.value) + ' of extra raw material at standard prices';
        }).join('; ') + '.', { icon: 'alert-triangle' }));
    } else {
      var worst = yieldExceptions(env)[0];
      if (worst) {
        var fl = worst.flag, b = worst.bucket;
        box.appendChild(ui.callout('warn', 'A month in the data ran below standard yield',
          fl.name + ' ran at ' + yieldText(fl.actualYield) + ' against a standard of ' + yieldText(fl.stdYield) + ' in ' + b.label + ': ' +
          fmt.pct(Math.abs(num(fl.yieldVariancePct))) + ' below standard and ' + money(fl.value) + ' of extra raw material at standard prices. ' +
          (worst.inRange ? 'The period on screen is wider, so the average no longer trips the check.' : 'That month is outside the period on screen.'),
          {
            icon: 'alert-triangle',
            actions: ui.button({
              label: 'Show ' + b.label, variant: 'secondary', size: 'sm', icon: 'calendar',
              onClick: function () { st.sku = fl.sku; MK.filters.set({ from: b.from, to: b.to }); }
            })
          }));
      }
    }
    return box;
  }

  /* ------------------------------------------------------------------ KPI row */

  function kpis(env) {
    var s = env.summary, t = env.targets;
    var prev = (s && s.prev) || null;
    var d = env.dispatch;

    var tiles = [
      {
        label: 'Produced', icon: 'factory', value: fmt.kg(num(s && s.grossKg), 0),
        delta: prev ? fmt.delta(num(s && s.grossKg), num(prev.grossKg)) : null,
        sub: 'Plan ' + fmt.kg(num(s && s.planKg), 0) + ', ' + fmt.kg(num(s && s.kgPerDay), 0) + ' a day'
      },
      {
        label: 'Plan adherence', icon: 'check-circle', value: fmt.pct(num(s && s.planAdherence)),
        delta: prev ? pointsDelta(s && s.planAdherence, prev.planAdherence) : null,
        sub: bandText(t.planAdherence), tone: inBand(s && s.planAdherence, t.planAdherence) ? null : 'warn'
      },
      {
        label: 'Yield against standard', icon: 'scale', value: fmt.pct(num(s && s.yieldIndex)),
        delta: prev ? pointsDelta(s && s.yieldIndex, prev.yieldIndex) : null,
        sub: env.flags.length ? plural(env.flags.length, 'product', 'products') + ' flagged below standard' : 'No product flagged below standard',
        tone: env.flags.length ? 'warn' : null
      },
      {
        label: 'Process wastage', icon: 'trash', value: fmt.pct(num(s && s.wastagePct)), goodWhen: 'down',
        delta: prev ? pointsDelta(s && s.wastagePct, prev.wastagePct) : null,
        sub: fmt.kg(num(s && s.wastageKg), 0) + ' lost in process; ' + bandText(t.wastagePct).toLowerCase(),
        tone: inBand(s && s.wastagePct, t.wastagePct) ? null : 'warn'
      },
      {
        label: 'Expiry and QA write-offs', icon: 'x-circle', value: fmt.pct(num(s && s.writeOffPct)), goodWhen: 'down',
        delta: prev ? pointsDelta(s && s.writeOffPct, prev.writeOffPct) : null,
        sub: fmt.kg(num(s && s.writeOffKg), 1) + ' written off; ' + bandText(t.writeOffPct).toLowerCase(),
        tone: inBand(s && s.writeOffPct, t.writeOffPct) ? null : 'warn'
      },
      {
        label: 'Dispatched', icon: 'truck', value: fmt.kg(num(s && s.dispatchKg), 0),
        delta: prev ? fmt.delta(num(s && s.dispatchKg), num(prev.dispatchKg)) : null,
        sub: 'Worth ' + fmt.inr(num(s && s.transferValue)) + ' at transfer prices'
      },
      {
        label: 'Fill rate', icon: 'box', value: fmt.pct(num(s && s.fillRate)),
        delta: prev ? pointsDelta(s && s.fillRate, prev.fillRate) : null,
        sub: 'Mumbai ' + fmt.pct(num(s && s.fillRateMumbai)) + ', Pune ' + fmt.pct(num(s && s.fillRatePune)),
        tone: (inBand(s && s.fillRateMumbai, t.fillRateMumbai) && inBand(s && s.fillRatePune, t.fillRatePune)) ? null : 'warn'
      },
      {
        label: 'Capacity used', icon: 'layers', value: fmt.pct(num(s && s.capacityUtilisation)), goodWhen: 'neutral',
        sub: fmt.kg(num(s && s.kgPerDay), 0) + ' of ' + fmt.kg(num(s && s.capacityKgPerDay), 0) + ' a day',
        tone: inBand(s && s.capacityUtilisation, t.capacityUtilisation) ? null : 'warn',
        title: bandText(t.capacityUtilisation) + '. Below the band the fixed cost per kg rises; above it there is no room for a peak.'
      }
    ];
    /* The comparison is stated once under the row: the kit's per-tile note is nowrap, and repeating the same
       range on seven tiles is noise that also runs past a narrow tile. */
    var lines = [];
    if (d && d.totals && num(d.totals.indentKg) > 0) {
      lines.push('Outlets indented ' + fmt.kg(num(d.totals.indentKg), 0) + ' over the period; ' +
        fmt.kg(num(d.totals.dispatchKg), 0) + ' went out, ' + fmt.kg(num(d.totals.indentKg) - num(d.totals.dispatchKg), 1) + ' short.');
    }
    if (prev) lines.push('Change is measured against ' + rangeLabel(prev.from, prev.to) + ', the period before this one.');
    return h('div', { 'class': 'fp-kpiblock' }, ui.kpiRow(tiles),
      lines.length ? h('p', { 'class': 'fp-kpinote mk-small mk-muted' }, lines.join(' ')) : null,
      ui.sourceTag(SRC_DISPATCH));
  }

  /* ------------------------------------------------------------------ plan against actual */

  function planCard(env) {
    var rows = env.rows;
    if (!MK.charts) return null;
    if (!rows.length) return ui.card({ title: 'Plan against actual by product', body: ui.emptyState('Nothing was produced in this period', null, { compact: true }) });

    var sorted = rows.slice().sort(function (a, b) { return num(b.planKg) - num(a.planKg); });
    var s = env.summary;
    var behind = sorted.slice().sort(function (a, b) { return num(a.adherence) - num(b.adherence); })[0];
    var floor = env.targets.planAdherence ? env.targets.planAdherence[0] : null;
    var underFloor = isNum(floor) ? sorted.filter(function (r) { return num(r.adherence) < floor; }) : [];

    var chart = MK.charts.mount(null, {
      id: 'fp-plan', kind: 'hbar', height: H_PLAN, format: 'kg',
      title: 'Plan against actual by product',
      subtitle: 'Produced ' + fmt.kg(num(s && s.grossKg), 0) + ' against a plan of ' + fmt.kg(num(s && s.planKg), 0) + ', ' +
        fmt.pct(num(s && s.planAdherence)) + ' adherence. ' +
        (behind ? behind.name + ' is furthest behind at ' + fmt.pct(num(behind.adherence)) + ' of its plan' : '') +
        (underFloor.length ? '; ' + plural(underFloor.length, 'line sits', 'lines sit') + ' below the ' + fmt.pct(floor, 0) + ' floor.' : '.'),
      data: {
        categories: sorted.map(function (r) { return r.name; }),
        categoryHeader: 'Product',
        series: [
          { id: 'plan', name: 'Plan', colourVar: '--series-muted', values: sorted.map(function (r) { return r1(r.planKg); }) },
          { id: 'actual', name: 'Produced', colourVar: '--ot-factory', values: sorted.map(function (r) { return r1(r.actualKg); }) }
        ]
      },
      table: {
        columns: [
          { key: 'name', label: 'Product', maxWidth: 220 },
          { key: 'planKg', label: 'Plan', format: 'kg', align: 'right' },
          { key: 'actualKg', label: 'Produced', format: 'kg', align: 'right' },
          { key: 'outputKg', label: 'Good output', format: 'kg', align: 'right' },
          { key: 'adherence', label: 'Adherence', format: 'pct', align: 'right' }
        ],
        rows: sorted.map(function (r) {
          return { name: r.name, planKg: r1(r.planKg), actualKg: r1(r.actualKg), outputKg: r1(r.outputKg), adherence: num(r.adherence) };
        })
      },
      note: 'The plan is built from the next dispatches plus a buffer, inside the daily capacity. Good output is what is left after process wastage and is what the outlets can be sent.'
    });
    chart.el.appendChild(sourceEnd(SRC_ERP));
    return chart.el;
  }

  /* ------------------------------------------------------------------ output trend against capacity */

  function outputTrendCard(env) {
    var buckets = env.buckets, series = (env.production && env.production.series) || [];
    if (!MK.charts) return null;
    if (!buckets.length) return ui.card({ title: 'Output against capacity', body: ui.emptyState('Nothing was produced in this period', null, { compact: true }) });

    var perDay = num(env.summary && env.summary.capacityKgPerDay);
    var produced = buckets.map(function (b, i) { return r1(sum(series.map(function (x) { return x.actual[i]; }))); });
    var capacity = buckets.map(function (b) { return r1(perDay * bucketDays(b)); });
    var used = produced.map(function (v, i) { return capacity[i] > 0 ? v / capacity[i] : null; });

    var peak = 0, peakAt = 0, low = null, lowAt = 0;
    used.forEach(function (v, i) {
      if (!isNum(v)) return;
      if (v > peak) { peak = v; peakAt = i; }
      if (low === null || v < low) { low = v; lowAt = i; }
    });

    var chart = MK.charts.mount(null, {
      id: 'fp-output', kind: 'line', height: H_TREND, format: 'kg', zeroBaseline: true,
      title: 'Output against capacity',
      subtitle: 'The kitchen ran at ' + fmt.pct(num(env.summary && env.summary.capacityUtilisation)) + ' of its ' + fmt.kg(perDay, 0) +
        ' a day over the period' +
        (buckets.length > 1
          ? '; the busiest ' + GRAIN_WORD[env.grain] + ' was ' + buckets[peakAt].label + ' at ' + fmt.pct(peak) +
            ', the quietest ' + buckets[lowAt].label + ' at ' + fmt.pct(low) + '.'
          : ', on the single ' + GRAIN_WORD[env.grain] + ' the filter covers.'),
      controls: env.grainOptions.length > 1
        ? [{ id: 'grain', label: 'Group by', value: env.grain, options: env.grainOptions }]
        : null,
      onControl: function (id, value) { if (id === 'grain') { env.st.grain = value; env.ctx.rerender(); } },
      data: {
        labels: buckets.map(function (b) { return b.label; }),
        labelHeader: GRAIN_LABELS[env.grain],
        series: [
          { id: 'produced', name: 'Produced', colourVar: '--ot-factory', values: produced },
          { id: 'capacity', name: 'Capacity', colourVar: '--series-muted', values: capacity }
        ]
      },
      table: {
        columns: [
          { key: 'label', label: GRAIN_LABELS[env.grain] },
          { key: 'produced', label: 'Produced', format: 'kg', align: 'right' },
          { key: 'capacity', label: 'Capacity', format: 'kg', align: 'right' },
          { key: 'used', label: 'Capacity used', format: 'pct', align: 'right' }
        ],
        rows: buckets.map(function (b, i) { return { label: b.label, produced: produced[i], capacity: capacity[i], used: used[i] }; })
      },
      note: 'Capacity is ' + fmt.kg(perDay, 0) + ' a day for every day the period covers, so a short first or last ' + GRAIN_WORD[env.grain] + ' carries a smaller capacity line.'
    });
    chart.el.appendChild(sourceEnd(SRC_ERP));
    return chart.el;
  }

  function bucketDays(b) {
    if (!b || !b.from || !b.to) return 1;
    return Math.max(1, D.diffDays(b.from, b.to) + 1);
  }

  /* ------------------------------------------------------------------ yield */

  function yieldTableCard(env) {
    var rows = env.rows;
    if (!rows.length) return ui.card({ title: 'Yield against standard by product', body: ui.emptyState('Nothing was produced in this period', null, { compact: true }) });

    var st = env.st, ctx = env.ctx;
    var sorted = rows.slice().sort(function (a, b) { return num(a.yieldVariancePct) - num(b.yieldVariancePct); });
    var tableRows = sorted.map(function (r) {
      return {
        sku: r.sku, name: r.name, stdYield: num(r.stdYield), actualYield: num(r.actualYield),
        variance: tidyPct(r.yieldVariancePct), value: Math.round(num(r.yieldVarianceValue)), outputKg: r1(r.outputKg)
      };
    });

    var table = ui.table({
      dense: true,
      columns: [
        /* the five columns have to sit inside the seven-column card at 1280 without a nested sideways scroll */
        { key: 'name', label: 'Product', maxWidth: 160 },
        { key: 'stdYield', label: 'Standard', format: 'num1', align: 'right', render: function (v) { return yieldText(v); } },
        { key: 'actualYield', label: 'Actual', format: 'num1', align: 'right', render: function (v) { return yieldText(v); } },
        { key: 'variance', label: 'Against standard', format: 'pct', align: 'right', render: divBarCell('pct'), width: 150 },
        {
          key: 'value', label: 'Input vs standard', format: 'inrFull', align: 'right',
          title: 'Raw material used against the standard recipe, valued at standard prices: a positive figure is input the factory paid for above standard, a negative one is less input than the recipe allows'
        }
      ],
      rows: tableRows,
      rowClass: function (r) { return r.sku === env.sku ? 'is-selected' : ''; },
      onRowClick: function (r) { st.sku = r.sku; ctx.rerender(); }
    });

    var worst = sorted[0];
    /* count what the column actually prints: a variance too small to show as a percentage is not "under standard" */
    var below = sorted.filter(function (r) { return num(tidyPct(r.yieldVariancePct)) < 0; });
    return ui.card({
      title: 'Yield against standard by product', flush: true,
      subtitle: worst
        ? 'Yield is finished kilograms for each kilogram of primary input. ' +
          (below.length
            ? worst.name + ' is furthest below its standard at ' + yieldText(worst.actualYield) + ' against ' + yieldText(worst.stdYield) + ', ' +
              money(worst.yieldVarianceValue) + ' of raw material above the recipe' +
              (below.length > 1
                ? '; ' + plural(below.length, 'line ran', 'lines ran') + ' under standard' +
                  (env.flags.length ? ', ' + fmt.num(env.flags.length) + ' far enough below to be flagged.' : '.')
                : '.')
            : 'Every line ran at or above the standard it was costed on.') +
          ' Choose a row for its trend.'
        : '',
      body: table,
      footer: ui.sourceTag(SRC_ERP)
    });
  }

  function yieldTrendCard(env) {
    var series = (env.production && env.production.series) || [];
    var pick = null;
    series.forEach(function (s) { if (s.sku === env.sku) pick = s; });
    if (!MK.charts) return null;
    if (!pick || !env.buckets.length) {
      return ui.card({ title: 'Yield trend', body: ui.emptyState('No product selected', 'Choose a product in the yield table to see how its yield moved.', { compact: true }) });
    }

    var std = num(pick.stdYield);
    var values = pick.yield.map(function (v) { return isNum(v) ? Math.round(v * 1000) / 1000 : null; });
    var lowest = null, lowAt = 0, belowCount = 0;
    values.forEach(function (v, i) {
      if (!isNum(v)) return;
      if (v < std) belowCount += 1;
      if (lowest === null || v < lowest) { lowest = v; lowAt = i; }
    });

    var chart = MK.charts.mount(null, {
      id: 'fp-yield-trend', kind: 'line', height: H_TREND, format: yieldFormat, zeroBaseline: false,
      title: 'Yield trend - ' + pick.name,
      subtitle: lowest === null
        ? 'Nothing was produced on this line in the period.'
        : 'Standard ' + yieldText(std) + '. ' + (env.buckets.length === 1
          ? 'The one ' + GRAIN_WORD[env.grain] + ' the filter covers, ' + env.buckets[lowAt].label + ', ran at ' + yieldText(lowest) + '.'
          : 'The weakest ' + GRAIN_WORD[env.grain] + ' was ' + env.buckets[lowAt].label + ' at ' + yieldText(lowest) + ', and ' +
            (belowCount === 0
              ? 'no ' + GRAIN_WORD[env.grain] + ' came in under standard.'
              : belowCount === env.buckets.length
                ? 'every one of the ' + plural(env.buckets.length, GRAIN_WORD[env.grain], GRAIN_WORD[env.grain] + 's') + ' came in under standard.'
                : plural(belowCount, GRAIN_WORD[env.grain], GRAIN_WORD[env.grain] + 's') + ' of ' + fmt.num(env.buckets.length) + ' came in under standard.')),
      data: {
        labels: env.buckets.map(function (b) { return b.label; }),
        labelHeader: GRAIN_LABELS[env.grain],
        series: [
          { id: 'actual', name: 'Actual yield', colourVar: '--ot-factory', values: values },
          { id: 'standard', name: 'Standard', colourVar: '--series-muted', values: env.buckets.map(function () { return std; }) }
        ]
      },
      note: 'The standard is the yield the transfer price was costed on, so a run below it is raw material the factory pays for and does not recover. ' +
        'Choose another product in the table; the grouping follows the "Group by" control on Output against capacity.'
    });
    chart.el.appendChild(sourceEnd(SRC_ERP));
    return chart.el;
  }

  /* ------------------------------------------------------------------ wastage and write-offs */

  function wastageCard(env) {
    var rows = env.rows;
    if (!rows.length) return ui.card({ title: 'Wastage and write-offs', body: ui.emptyState('Nothing was produced in this period', null, { compact: true }) });

    var s = env.summary;
    var sorted = rows.slice().sort(function (a, b) { return num(b.wastageKg) + num(b.writeOffKg) - (num(a.wastageKg) + num(a.writeOffKg)); });
    var top = sorted[0];
    var worstShare = rows.slice().sort(function (a, b) { return num(b.wastagePct) - num(a.wastagePct); })[0];
    var writtenOff = rows.filter(function (r) { return num(r.writeOffKg) > 0; }).sort(function (a, b) { return num(b.writeOffKg) - num(a.writeOffKg); });
    var writeOffTotal = num(s && s.writeOffKg);
    var tableRows = sorted.map(function (r) {
      return { name: r.name, actualKg: r1(r.actualKg), wastageKg: r1(r.wastageKg), wastagePct: num(r.wastagePct), writeOffKg: r1(r.writeOffKg) };
    });

    var table = ui.table({
      dense: true,
      columns: [
        /* 130px keeps the three columns inside the half-width card at 1280: any wider and the card gets a nested
           sideways scroll. The full product name is the cell's tooltip. */
        { key: 'name', label: 'Product', maxWidth: 130 },
        {
          key: 'wastageKg', label: 'Process wastage', format: kg1, align: 'right', numeric: true,
          render: ui.cells.bar(null, '--series-2', { format: kg1 }),
          title: 'Trimmings, cooking loss and spillage, weighed at the factory'
        },
        { key: 'writeOffKg', label: 'Written off', format: kg1, align: 'right', numeric: true, title: 'Finished stock past its shelf life or rejected by quality control' }
      ],
      rows: tableRows,
      footer: { name: 'All products', wastageKg: r1(s && s.wastageKg), writeOffKg: r1(s && s.writeOffKg) }
    });

    var capNote = capabilityNote('inv.wastage', 'What Petpooja can supply on wastage:',
      'The process wastage here is weighed at the factory and captured in this ERP.');
    return ui.card({
      title: 'Wastage and write-offs', flush: true,
      subtitle: top
        ? fmt.kg(num(s && s.wastageKg), 0) + ' was lost in process, ' + fmt.pct(num(s && s.wastagePct)) + ' of what was made' +
          (bandText(env.targets.wastagePct) ? ' (' + lowerFirst(bandText(env.targets.wastagePct)) + ')' : '') + ', and ' +
          fmt.kg(writeOffTotal, 1) + ' was written off for expiry or a QA rejection. ' +
          top.name + ' loses the most, ' + fmt.kg(num(top.wastageKg), 1) + ' at ' + fmt.pct(num(top.wastagePct)) + ' of its own run' +
          (worstShare && worstShare.sku !== top.sku
            ? ', while ' + lowerFirst(worstShare.name) + ' gives up the largest share at ' + fmt.pct(num(worstShare.wastagePct)) + '.'
            : ', the largest share of any line.') +
          (writtenOff.length && writeOffTotal > 0
            ? ' The write-offs sit on ' + andList(writtenOff.slice(0, 2).map(function (r) { return lowerFirst(r.name) + ' (' + fmt.kg(num(r.writeOffKg), 1) + ')'; })) + '.'
            : '')
        : '',
      body: table,
      footer: [capNote, ui.sourceTag(SRC_ERP)]
    });
  }

  /* ------------------------------------------------------------------ indent, dispatch and fill rate */

  function fillRateCard(env) {
    var d = env.dispatch;
    var outlets = (d && d.outlets) || [];
    if (!outlets.length) return ui.card({ title: 'Indent against dispatch by outlet', body: ui.emptyState('Nothing was dispatched in this period', null, { compact: true }) });

    var bands = {};
    (d.byRegion || []).forEach(function (r) { bands[r.id] = r.target; });
    var sorted = outlets.slice().sort(function (a, b) { return num(a.fillRate) - num(b.fillRate); });
    var worst = sorted[0];
    var rows = sorted.map(function (o) {
      var band = (o.alternateDaySupply ? bands.pune : bands.mumbai) || null;
      return {
        id: o.id, outlet: o.label, supply: (o.alternateDaySupply ? 'Alternate-day run, ' : 'Daily, ') + plural(o.supplyDays, 'supply day', 'supply days'),
        indentKg: r1(o.indentKg), dispatchKg: r1(o.dispatchKg), shortKg: r1(num(o.indentKg) - num(o.dispatchKg)),
        fillRate: num(o.fillRate), band: band
      };
    });

    var table = ui.table({
      dense: true,
      columns: [
        { key: 'outlet', label: 'Outlet', render: ui.cells.twoLine('supply', { maxWidth: 140 }) },
        { key: 'indentKg', label: 'Indented', format: 'kg', align: 'right' },
        { key: 'dispatchKg', label: 'Dispatched', format: 'kg', align: 'right' },
        { key: 'shortKg', label: 'Short', format: kg1, align: 'right', numeric: true },
        {
          key: 'fillRate', label: 'Fill rate', format: 'pct', align: 'right', width: 160,
          render: function (v, row) { return fillMeter(row.band)(v, row); }
        }
      ],
      rows: rows,
      footer: {
        outlet: 'All outlets', indentKg: r1(d.totals && d.totals.indentKg), dispatchKg: r1(d.totals && d.totals.dispatchKg),
        shortKg: r1(num(d.totals && d.totals.indentKg) - num(d.totals && d.totals.dispatchKg)), fillRate: num(d.totals && d.totals.fillRate)
      }
    });

    var regions = (d.byRegion || []).map(function (r) {
      return r.label + ' ' + fmt.pct(num(r.fillRate)) + (r.target ? ' against ' + fmt.pct(r.target[0], 0) + ' to ' + fmt.pct(r.target[1], 0) : '');
    }).join('; ');

    return ui.card({
      title: 'Indent against dispatch by outlet', flush: true,
      subtitle: worst
        ? worst.label + ' is filled least at ' + fmt.pct(num(worst.fillRate)) +
          (worst.alternateDaySupply ? ', which is what an alternate-day van costs: a line missed at the cut-off waits two days.' : '.') +
          (regions ? ' ' + regions + '.' : '')
        : '',
      body: table,
      footer: [capabilityNote('inv.indents', 'Indents and transfers come from Petpooja:',
        'The transfer prices behind their value, and the production that fills them, are the ERP\'s own.'), ui.sourceTag(SRC_DISPATCH)]
    });
  }

  /* ------------------------------------------------------------------ dispatch matrix */

  function matrixCard(env) {
    var d = env.dispatch;
    var rows = (d && d.rows) || [], outlets = (d && d.outlets) || [];
    if (!MK.charts) return null;
    if (!rows.length || !outlets.length) return ui.card({ title: 'Dispatch by product and outlet', body: ui.emptyState('Nothing was dispatched in this period', null, { compact: true }) });

    var values = rows.map(function (r) { return (r.kg || []).map(function (v) { return isNum(v) ? r1(v) : null; }); });
    var topOutlet = outlets.slice().sort(function (a, b) { return num(b.dispatchKg) - num(a.dispatchKg); })[0];
    var topRow = rows.slice().sort(function (a, b) { return num(b.dispatchKg) - num(a.dispatchKg); })[0];
    var total = num(d.totals && d.totals.dispatchKg);

    var chart = MK.charts.mount(null, {
      id: 'fp-matrix', kind: 'heatmap', height: H_MATRIX, format: 'kg',
      title: 'Dispatch by product and outlet',
      subtitle: (topRow ? topRow.name + ' is the largest line at ' + fmt.kg(num(topRow.dispatchKg), 0) + ', ' + fmt.pct(total > 0 ? num(topRow.dispatchKg) / total : null) + ' of everything sent out' : '') +
        (topOutlet ? '; ' + topOutlet.label + ' takes the most at ' + fmt.kg(num(topOutlet.dispatchKg), 0) : '') + '.',
      data: {
        rows: rows.map(function (r) { return r.name; }),
        cols: outlets.map(function (o) { return o.short || o.label; }),
        values: values,
        valueLabel: 'Kilograms dispatched',
        rowHeader: 'Product', colHeader: 'Outlet'
      },
      note: 'Every cell is the kilograms that went from the kitchen to that outlet in the period; the whole matrix is worth ' +
        fmt.inr(num(d.totals && d.totals.transferValue)) + ' at transfer prices. Switch to Table for the figure in every cell.'
    });
    chart.el.appendChild(sourceEnd(SRC_DISPATCH));
    return chart.el;
  }

  /* ------------------------------------------------------------------ short shipments */

  function shortCard(env) {
    var d = env.dispatch;
    var list = (d && d.shortShipments) || [];
    if (!list.length) {
      return ui.card({
        title: 'Largest short shipments',
        body: ui.emptyState('Every indent was filled in this period', null, { compact: true, icon: 'check-circle' }),
        footer: ui.sourceTag(SRC_DISPATCH)
      });
    }

    var byReason = {}, order = [];
    list.forEach(function (r) {
      if (!byReason[r.reason]) { byReason[r.reason] = { reason: r.reason, count: 0, kg: 0 }; order.push(r.reason); }
      byReason[r.reason].count += 1;
      byReason[r.reason].kg += num(r.shortKg);
    });
    var reasons = order.map(function (k) { return byReason[k]; }).sort(function (a, b) { return b.kg - a.kg; });
    var names = {};
    ((d && d.outlets) || []).forEach(function (o) { names[o.id] = o.label; });

    var rows = list.map(function (r) {
      return {
        date: D.label(r.date, 'EEE d MMM'), outlet: names[r.outletId] || r.outletId, product: r.name,
        indentKg: r1(r.indentKg), dispatchedKg: r1(r.dispatchedKg), shortKg: r1(r.shortKg), reason: r.reason
      };
    });

    var st = env.st;
    var table = ui.table({
      dense: true, maxHeight: SHORT_ROWS_HEIGHT, sortable: true,
      /* the sort belongs to the page, not to the DOM: a filter or persona change re-renders this table */
      sort: st.shortSort || { key: 'shortKg', dir: 'desc' },
      onSort: function (s) { st.shortSort = s; },
      columns: [
        { key: 'date', label: 'Business day' },
        { key: 'outlet', label: 'Outlet' },
        { key: 'product', label: 'Product', maxWidth: 200 },
        { key: 'indentKg', label: 'Indented', format: 'kg', align: 'right' },
        { key: 'dispatchedKg', label: 'Dispatched', format: 'kg', align: 'right' },
        { key: 'shortKg', label: 'Short', format: kg1, align: 'right', numeric: true, render: ui.cells.bar(null, '--series-2', { format: kg1 }) },
        { key: 'reason', label: 'Reason', maxWidth: 220 }
      ],
      rows: rows
    });

    var top = reasons[0];
    return ui.card({
      title: 'Largest short shipments', flush: true,
      subtitle: top
        ? 'The ' + plural(list.length, 'largest line shortfall', 'largest line shortfalls') + ' of the period, against ' +
          fmt.kg(num(d.totals && d.totals.indentKg) - num(d.totals && d.totals.dispatchKg), 1) + ' short in all. ' +
          top.reason + ' is the biggest reason here, ' + fmt.kg(top.kg, 1) + ' across ' + plural(top.count, 'shipment', 'shipments') +
          '. Sort a column to read them another way.'
        : '',
      body: table,
      footer: ui.sourceTag(SRC_DISPATCH)
    });
  }

  /* ------------------------------------------------------------------ render */

  function render(rootEl, ctx) {
    if (!MK.factory || typeof MK.factory.summary !== 'function') {
      rootEl.appendChild(ui.callout('warn', 'The factory model is not loaded', 'This screen needs js/data/factory.js.'));
      return;
    }

    var env = buildEnv(ctx);
    var nothing = !env.rows.length && !((env.dispatch && env.dispatch.rows) || []).length && !num(env.summary && env.summary.planKg);
    if (nothing) {
      rootEl.appendChild(ui.emptyState('The central kitchen is not in your scope',
        (ctx.user && ctx.user.roleLabel ? ctx.user.roleLabel + ' sees' : 'Your role sees') +
        ' the outlets only, so there is no production to show. If the period is the problem, widen the date filter.',
        { icon: 'lock' }));
      return;
    }

    safe(rootEl, 'Header', function () { return header(env); });
    safe(rootEl, 'Key figures', function () { return kpis(env); });
    safe(rootEl, 'Plan against actual', function () {
      return ui.grid([7, 5], [cell(planCard(env)), cell(outputTrendCard(env))], { className: 'fp-row' });
    });
    safe(rootEl, 'Yield', function () {
      return ui.grid([7, 5], [cell(yieldTableCard(env)), cell(yieldTrendCard(env))], { className: 'fp-row' });
    });
    safe(rootEl, 'Losses and fill rate', function () {
      return ui.grid([5, 7], [cell(wastageCard(env)), cell(fillRateCard(env))], { className: 'fp-row' });
    });
    safe(rootEl, 'Dispatch matrix', function () { return matrixCard(env); });
    safe(rootEl, 'Short shipments', function () { return shortCard(env); });
  }

  MK.router.register({
    id: PAGE_ID,
    route: '#/factory/production',
    group: 'Factory',
    title: 'Production & dispatch',
    subtitle: 'Plan versus actual, yield and dispatch to outlets',
    units: 'factory',
    roles: null,
    filters: ['date'],
    render: render
  });
})(window);
