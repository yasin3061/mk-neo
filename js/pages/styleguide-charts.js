/*
 * #/system/styleguide-charts - living reference of every chart kind in MK.charts.
 *
 * The figures on this page are static samples typed here on purpose: the page documents the chart
 * kit and must render even when the data layer is absent. No other page may hold literal figures.
 * Relies only on kernel.js, charts.js and the DOM.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});
  var doc = root.document;
  if (!doc) return;

  /* ------------------------------------------------------------------ sample data */

  var OUTLETS = [
    { id: 'bandra', name: 'Bandra' },
    { id: 'andheri', name: 'Andheri' },
    { id: 'fort', name: 'Fort' },
    { id: 'kalyan', name: 'Kalyan' },
    { id: 'koregaon', name: 'Koregaon Park' }
  ];
  var OUTLET_NAMES = OUTLETS.map(function (o) { return o.name; });

  /* 1-16 Sep, whole rupees */
  var NET_SALES = [1982400, 1641300, 1118600, 963200, 708500];
  var ORDERS = [4120, 4685, 3390, 3540, 1730];
  var SALES_PLAN = [1900000, 1700000, 1250000, 900000, 800000];
  var ORDERS_PLAN = [4000, 4800, 3600, 3300, 1900];
  var AOV_PLAN = [475, 355, 345, 270, 420];

  /* net sales by channel per outlet, same period; rows add up to NET_SALES */
  var CHANNEL_SPLIT = [
    { id: 'petpooja', name: 'Petpooja (in-store)', values: [1091200, 512400, 789300, 461800, 331200] },
    { id: 'swiggy', name: 'Swiggy', values: [358900, 739600, 148700, 289500, 168400] },
    { id: 'zomato', name: 'Zomato', values: [532300, 389300, 180600, 211900, 208900] }
  ];

  /* thirty days of daily net sales by channel: weekly rhythm, a salary-week lift, one washed-out day, a festival lift */
  function dailyByChannel() {
    var start = '2026-08-18', days = 30;
    var dowLift = [0.9, 0.88, 0.93, 0.98, 1.12, 1.3, 1.24]; /* Mon..Sun */
    var base = { petpooja: 172000, swiggy: 108000, zomato: 96000 };
    var rng = MK.rng('styleguide-charts');
    var labels = [], out = { petpooja: [], swiggy: [], zomato: [] };
    for (var i = 0; i < days; i++) {
      var iso = MK.dates.addDays(start, i);
      var lift = dowLift[MK.dates.dow(iso)];
      var day = +iso.slice(8, 10);
      if (day <= 5) lift *= 1.08;                       /* salary week */
      if (iso >= '2026-09-14') lift *= 1.12;            /* festival */
      var rain = iso === '2026-08-27';
      labels.push(MK.dates.label(iso));
      out.petpooja.push(Math.round(base.petpooja * lift * (rain ? 0.62 : 1) * rng.range(0.95, 1.05) / 100) * 100);
      out.swiggy.push(Math.round(base.swiggy * lift * (rain ? 1.28 : 1) * rng.range(0.94, 1.06) / 100) * 100);
      out.zomato.push(Math.round(base.zomato * lift * (rain ? 1.22 : 1) * rng.range(0.94, 1.06) / 100) * 100);
    }
    return { labels: labels, series: out };
  }

  /* orders by day of week and hour (business day runs 11:00 to 02:00) */
  function ordersByHour() {
    var hours = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
    var shape = [14, 38, 56, 44, 20, 13, 15, 26, 47, 68, 74, 58, 34, 19, 9];
    var dowLift = [0.86, 0.84, 0.9, 0.95, 1.12, 1.32, 1.24];
    var lateLift = [1, 1, 1, 1.05, 1.35, 1.5, 1.1];
    var values = MK.dates.DOWS.map(function (dow, d) {
      return hours.map(function (h, i) {
        var wobble = 0.94 + (MK.hash(dow + h) % 13) / 100;
        return Math.round(shape[i] * dowLift[d] * (h >= 22 ? lateLift[d] : 1) * wobble);
      });
    });
    return { rows: MK.dates.DOWS.slice(), cols: hours.map(function (h) { return (h % 24 < 10 ? '0' : '') + (h % 24) + ':00'; }), values: values };
  }

  var WATERFALL = [
    { label: 'Gross menu value', value: 5242000, kind: 'total' },
    { label: 'Restaurant discounts', value: 462000, kind: 'minus' },
    { label: 'Net sales', value: 4780000, kind: 'total' },
    { label: 'Commission', value: 1051600, kind: 'minus' },
    { label: 'Gateway fee', value: 90800, kind: 'minus' },
    { label: 'GST on fees', value: 205600, kind: 'minus' },
    { label: 'TDS withheld', value: 4800, kind: 'minus' },
    { label: 'Ads', value: 231000, kind: 'minus' },
    { label: 'Net payout', value: 3196200, kind: 'total' }
  ];

  var DISHES = [
    { id: 'chicken-seekh', name: 'Chicken Seekh Kebab', x: 3120, y: 148, size: 8.9 },
    { id: 'mutton-seekh', name: 'Mutton Seekh Kebab', x: 2260, y: 176, size: 8.1 },
    { id: 'malai-tikka', name: 'Chicken Malai Tikka', x: 1840, y: 162, size: 5.9 },
    { id: 'chicken-roll', name: 'Chicken Seekh Roll', x: 3480, y: 92, size: 6.6 },
    { id: 'mutton-roll', name: 'Mutton Seekh Roll', x: 1510, y: 118, size: 3.9 },
    { id: 'chicken-biryani', name: 'Chicken Dum Biryani', x: 2790, y: 134, size: 8.4 },
    { id: 'mutton-biryani', name: 'Mutton Dum Biryani', x: 1320, y: 171, size: 5.2 },
    { id: 'butter-chicken', name: 'Butter Chicken', x: 960, y: 156, size: 3.4 },
    { id: 'paneer-tikka', name: 'Paneer Tikka', x: 720, y: 104, size: 1.8 },
    { id: 'shahi-tukda', name: 'Shahi Tukda', x: 1180, y: 64, size: 1.6 }
  ];

  var BUDGET = {
    categories: ['Marketing', 'Repairs & maintenance', 'Gas & fuel', 'Housekeeping', 'Tissue & consumables', 'Rent', 'Electricity', 'Packaging', 'Staff cost'],
    values: [21000, 12800, 6200, 4500, 3100, 0, -18500, -27400, -42000]
  };

  var SPARKS = [
    { name: 'Bandra', values: [118, 121, 117, 124, 129, 126, 131, 128, 134, 133, 138, 141], format: 'inr', scale: 1000 },
    { name: 'Andheri', values: [102, 104, 101, 99, 103, 105, 104, 102, 106, 103, 104, 103], format: 'inr', scale: 1000 },
    { name: 'Fort', values: [74, 72, 75, 71, 69, 70, 68, 69, 66, 67, 65, 64], format: 'inr', scale: 1000 },
    { name: 'Kalyan', values: [52, 54, 53, 57, 58, 57, 60, 62, 61, 63, 66, 68], format: 'inr', scale: 1000 },
    { name: 'Koregaon Park', values: [null, null, 18, 24, 27, 33, 36, 41, 40, 44, 47, 51], format: 'inr', scale: 1000 },
    { name: 'Factory (no sales)', values: [], format: 'inr', scale: 1000 }
  ];

  /* ------------------------------------------------------------------ DOM helpers */

  function el(tag, className, text) {
    var n = doc.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function section(parent, title, hint) {
    var s = el('div', 'mk-cg__section');
    s.appendChild(el('h2', '', title));
    if (hint) s.appendChild(el('p', '', hint));
    parent.appendChild(s);
  }

  function slot(parent, width) {
    var s = el('div', 'mk-cg__w' + width);
    parent.appendChild(s);
    return s;
  }

  /* ------------------------------------------------------------------ page */

  function render(rootEl) {
    var charts = MK.charts;
    var page = el('div', 'mk-cg');
    rootEl.appendChild(page);

    if (!charts) {
      page.appendChild(el('p', 'mk-cg__intro', 'The chart kit (js/core/charts.js) is not loaded.'));
      return null;
    }

    var intro = el('p', 'mk-cg__intro',
      'Every chart in the product is one call to MK.charts.mount(). This page shows each kind with static sample figures ' +
      '(illustrative only - they are not read from the demo dataset). Hover for tooltips, use the legend to hide a series, ' +
      'and switch any card to its table twin with the toggle at the top right. This reference is not in the menu; it opens by URL, like the ');
    var kitLink = el('a', 'mk-link', 'UI kit');
    kitLink.href = '#/system/styleguide';
    intro.appendChild(kitLink);
    intro.appendChild(doc.createTextNode('.'));
    page.appendChild(intro);

    var daily = dailyByChannel();
    var byHour = ordersByHour();

    /* ---- trend */
    section(page, 'Trend', 'line, area - 2px lines, crosshair tooltip, end-of-line dot, event markers');

    charts.mount(slot(page, 8), {
      id: 'sg-line', kind: 'line', format: 'inr', height: 300,
      title: 'Daily net sales by channel',
      subtitle: 'Last 30 days, all outlets',
      data: {
        labels: daily.labels, colourBy: 'channel', showTotal: true, labelHeader: 'Day',
        series: [
          { id: 'petpooja', name: 'Petpooja (in-store)', values: daily.series.petpooja },
          { id: 'swiggy', name: 'Swiggy', values: daily.series.swiggy },
          { id: 'zomato', name: 'Zomato', values: daily.series.zomato }
        ],
        markers: [
          { label: 'Heavy rain', atLabel: '27 Aug' },
          { label: 'Salary week', atLabel: '1 Sep' },
          { label: 'Ganeshotsav', atLabel: '14 Sep' }
        ]
      },
      note: 'Channel colours are fixed to the entity: Petpooja blue, Swiggy amber, Zomato red. Hiding a series never repaints the others.'
    });

    var total = daily.labels.map(function (_, i) { return daily.series.petpooja[i] + daily.series.swiggy[i] + daily.series.zomato[i]; });
    charts.mount(slot(page, 4), {
      id: 'sg-area', kind: 'area', format: 'inr', height: 300,
      title: 'Net sales, all channels',
      subtitle: 'Single series: no legend, value at the line end',
      data: { labels: daily.labels, labelHeader: 'Day', name: 'Net sales', values: total, colourVar: '--seq-500' }
    });

    var weeks = ['W1 Jul', 'W2 Jul', 'W3 Jul', 'W4 Jul', 'W1 Aug', 'W2 Aug', 'W3 Aug', 'W4 Aug', 'W1 Sep', 'W2 Sep'];
    charts.mount(slot(page, 6), {
      id: 'sg-emphasis', kind: 'line', format: 'pct', height: 260, zeroBaseline: false,
      title: 'Food cost % by outlet',
      subtitle: 'Emphasis: one series is the point, the rest are context',
      data: {
        labels: weeks, labelHeader: 'Week', colourBy: 'outlet', emphasise: 'kalyan', restLabel: 'Other outlets',
        series: [
          { id: 'bandra', name: 'Bandra', values: [0.312, 0.309, 0.314, 0.311, 0.308, 0.313, 0.31, 0.309, 0.312, 0.311] },
          { id: 'andheri', name: 'Andheri', values: [0.322, 0.325, 0.321, 0.324, 0.327, 0.323, 0.326, 0.322, 0.325, 0.324] },
          { id: 'fort', name: 'Fort', values: [0.305, 0.307, 0.303, 0.306, 0.304, 0.308, 0.305, 0.303, 0.306, 0.304] },
          { id: 'kalyan', name: 'Kalyan', values: [0.331, 0.336, 0.342, 0.339, 0.347, 0.351, 0.349, 0.356, 0.353, 0.358] },
          { id: 'koregaon', name: 'Koregaon Park', values: [0.334, 0.329, 0.331, 0.326, 0.328, 0.323, 0.325, 0.321, 0.322, 0.319] }
        ]
      }
    });

    /* ---- controls + update() */
    var measures = {
      sales: { values: NET_SALES, format: 'inr', name: 'Net sales', target: SALES_PLAN, subtitle: '1-16 Sep, against the month-to-date plan' },
      orders: { values: ORDERS, format: 'num', name: 'Orders', target: ORDERS_PLAN, subtitle: '1-16 Sep, against the month-to-date plan' },
      aov: { values: NET_SALES.map(function (v, i) { return Math.round(v / ORDERS[i]); }), format: 'inrFull', name: 'Average order value', target: AOV_PLAN, subtitle: '1-16 Sep, net sales per order against plan' }
    };
    function measureSpec(key) {
      var m = measures[key];
      return { format: m.format, subtitle: m.subtitle, data: { categories: OUTLET_NAMES, categoryHeader: 'Outlet', name: m.name, values: m.values, target: m.target, targetName: 'Plan' } };
    }
    var controlled = charts.mount(slot(page, 6), {
      id: 'sg-controls', kind: 'bar', height: 260,
      title: 'Outlet comparison',
      subtitle: measures.sales.subtitle, format: measures.sales.format, data: measureSpec('sales').data,
      controls: [{ id: 'measure', label: 'Measure', value: 'sales', options: [{ value: 'sales', label: 'Net sales' }, { value: 'orders', label: 'Orders' }, { value: 'aov', label: 'AOV' }] }],
      onControl: function (id, value) { controlled.update(measureSpec(value)); },
      note: 'A card may carry one small control for measure or grouping. It calls onControl, and the page answers with update() - the card, its toggle state and its size stay put.'
    });

    /* ---- magnitude */
    section(page, 'Magnitude', 'bar, hbar - one colour for all bars, 24px cap, rounded data end');

    var clickLog = el('p', 'mk-cg__log', 'Click a bar: the onClick datum appears here.');
    var hbarSlot = slot(page, 6);
    charts.mount(hbarSlot, {
      id: 'sg-hbar', kind: 'hbar', format: 'inr', height: 260,
      title: 'Net sales by dish',
      subtitle: 'Horizontal for long names; sort order is the caller\'s',
      data: {
        categoryHeader: 'Dish', name: 'Net sales',
        categories: DISHES.slice().sort(function (a, b) { return b.size - a.size; }).map(function (d) { return d.name; }),
        values: DISHES.slice().sort(function (a, b) { return b.size - a.size; }).map(function (d) { return Math.round(d.size * 100000); })
      },
      onClick: function (datum) { clickLog.textContent = 'onClick -> category "' + datum.category + '", value ' + MK.fmt.inrFull(datum.value); }
    });
    hbarSlot.appendChild(clickLog);

    charts.mount(slot(page, 6), {
      id: 'sg-grouped', kind: 'bar', format: 'inr', height: 260,
      title: 'Net sales by outlet and channel',
      subtitle: 'Grouped series sit side by side with a 2px gap',
      data: { categories: OUTLET_NAMES, categoryHeader: 'Outlet', colourBy: 'channel', series: CHANNEL_SPLIT }
    });

    /* ---- part to whole */
    section(page, 'Part to whole', 'stackedBar, hstackedBar - 2px surface gap, legend always, labels only where they fit');

    charts.mount(slot(page, 6), {
      id: 'sg-hstack', kind: 'hstackedBar', format: 'inr', height: 260,
      title: 'Channel mix by outlet',
      subtitle: 'Percent mode: every bar normalised to 100%',
      data: { categories: OUTLET_NAMES, categoryHeader: 'Outlet', colourBy: 'channel', percent: true, series: CHANNEL_SPLIT }
    });

    charts.mount(slot(page, 6), {
      id: 'sg-stack', kind: 'stackedBar', format: 'inr', height: 260,
      title: 'Net sales by outlet, split by channel',
      subtitle: 'Absolute mode: total at the bar tip',
      data: { categories: OUTLET_NAMES, categoryHeader: 'Outlet', colourBy: 'channel', series: CHANNEL_SPLIT }
    });

    /* ---- grid of magnitudes */
    section(page, 'Grid of magnitudes', 'heatmap - one hue, light to dark, with a scale legend');

    charts.mount(slot(page, 12), {
      id: 'sg-heatmap', kind: 'heatmap', format: 'num', height: 300,
      title: 'Orders by day of week and hour',
      subtitle: 'Average orders per hour, all outlets',
      data: { rows: byHour.rows, cols: byHour.cols, values: byHour.values, valueLabel: 'Orders per hour', rowHeader: 'Day', colHeader: 'Hour' },
      note: 'A grid this size labels only the peak of each row; the scale, the tooltip and the table twin carry the rest. Grids of up to 40 cells label every cell.'
    });

    /* ---- bridge */
    section(page, 'Bridge', 'waterfall - how a starting figure becomes an ending figure');

    charts.mount(slot(page, 12), {
      id: 'sg-waterfall', kind: 'waterfall', format: 'inr', height: 320,
      title: 'Aggregator orders: gross menu value to net payout',
      subtitle: 'August, Swiggy and Zomato, all outlets',
      data: { steps: WATERFALL, kindLabels: { total: 'Subtotal', minus: 'Deduction' } }
    });

    /* ---- relationship */
    section(page, 'Relationship', 'scatter - one colour, every point named, quadrant guides');

    charts.mount(slot(page, 8), {
      id: 'sg-scatter', kind: 'scatter', height: 360,
      title: 'Menu engineering: popularity against contribution',
      subtitle: 'Dot size shows net sales',
      data: {
        points: DISHES, nameHeader: 'Dish',
        xLabel: 'Plates sold', yLabel: 'Contribution per plate', sizeLabel: 'Net sales (lakh)',
        xFormat: 'num', yFormat: 'inrFull', sizeFormat: function (v) { return MK.fmt.inr(v * 100000); },
        quadrants: { x: 1900, y: 130, labels: ['Stars', 'Puzzles', 'Dogs', 'Plowhorses'] }
      }
    });

    /* ---- polarity */
    charts.mount(slot(page, 4), {
      id: 'sg-diverging', kind: 'divergingBar', format: 'inrFull', height: 360,
      title: 'Budget variance by category',
      subtitle: 'Bandra, August',
      data: { categories: BUDGET.categories, values: BUDGET.values, name: 'Variance', zeroLabel: 'Budget', posLabel: 'Under budget', negLabel: 'Over budget' }
    });

    /* ---- sparklines + empty state + rules */
    section(page, 'Small things', 'sparkline, empty state, house rules');

    var sparkPanel = el('div', 'mk-cg__panel');
    sparkPanel.appendChild(el('h3', '', 'Sparklines'));
    var table = el('table', 'mk-cg__sparks');
    var thead = el('thead'), hr = el('tr');
    [['Outlet', ''], ['12-week trend', ''], ['Latest week', 'is-num']].forEach(function (h) {
      var th = el('th', h[1], h[0]);
      th.setAttribute('scope', 'col');
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    SPARKS.forEach(function (row, i) {
      var tr = el('tr');
      var th = el('th', '', row.name);
      th.setAttribute('scope', 'row');
      tr.appendChild(th);
      var cell = el('td');
      var scaled = row.values.map(function (v) { return v === null ? null : v * row.scale * 7; });
      charts.sparkline(cell, scaled, { label: row.name + ' weekly net sales', format: row.format, area: i === 0, colourVar: '--seq-500' });
      tr.appendChild(cell);
      var last = scaled.length ? scaled[scaled.length - 1] : null;
      tr.appendChild(el('td', 'is-num', last === null ? '-' : MK.fmt.inr(last)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    sparkPanel.appendChild(table);
    slot(page, 4).appendChild(sparkPanel);

    charts.mount(slot(page, 4), {
      id: 'sg-empty', kind: 'bar', format: 'inr', height: 220,
      title: 'Empty state',
      subtitle: 'What a card shows when a filter leaves nothing',
      data: { categories: [], values: [] }
    });

    var rules = el('div', 'mk-cg__panel');
    rules.appendChild(el('h3', '', 'House rules'));
    var list = el('ol', 'mk-cg__rules');
    [
      'The job picks the form: magnitude is a bar, trend is a line, share is a stacked bar, a grid is a heatmap.',
      'One y-axis, always. Two measures means two charts.',
      'Colour follows the entity, never its rank. Eight hues at most.',
      'One series, one colour. Never shade bars by their own value.',
      'Text is ink. Identity sits in the mark beside it.',
      'A legend for two or more series; direct labels only where they fit.',
      'Every value is reachable without hovering: labels or the table twin.',
      'Filters live in the global bar, never inside a card.'
    ].forEach(function (text) { list.appendChild(el('li', '', text)); });
    rules.appendChild(list);
    slot(page, 4).appendChild(rules);

    return function cleanup() { charts.disposeAll(rootEl); };
  }

  var page = {
    id: 'styleguide-charts',
    route: '#/system/styleguide-charts',
    group: 'System',
    title: 'Chart kit',
    subtitle: 'Every chart kind in MK.charts, on sample figures',
    units: 'all',
    roles: null,
    nav: false, /* developer reference with typed sample figures: reachable by URL, not listed in the client-facing menu */
    filters: [],
    render: render
  };

  if (MK.charts) MK.charts.styleguide = page; /* lets the page be mounted by hand when the router is absent */
  if (MK.router && typeof MK.router.register === 'function') MK.router.register(page);
})(typeof window !== 'undefined' ? window : globalThis);
