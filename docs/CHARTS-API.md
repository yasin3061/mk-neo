# MK.charts - chart kit API

`js/core/charts.js` + `css/charts.css`. Depends only on `kernel.js`, the global `echarts`
(vendor/echarts.min.js, 5.6.0) and the DOM. It is the only file that writes ECharts options;
pages describe *data*, the wrapper owns the look (SPEC section 4).

Live reference with one example of every kind: `#/system/styleguide-charts`
(`js/pages/styleguide-charts.js`; registered with `nav: false`, so it opens by URL and is not in the menu).

```js
MK.charts.mount(parent, spec)        -> controller { el, update(partialSpec), dispose() }
MK.charts.card(parent, spec)         alias of mount
MK.charts.sparkline(el, values, opts) -> the <svg> element
MK.charts.token('--ch-swiggy')       -> '#eda100'        computed value of a CSS custom property
MK.charts.colourFor(kind, idOrIndex) -> '--ch-swiggy'    the token NAME (pass it as colourVar, or use in var())
MK.charts.colour(kind, idOrIndex)    -> '#eda100'        colourFor + token in one step
MK.charts.disposeAll(container)      dispose every chart mounted inside container (all charts if omitted)
MK.charts.format(format)             -> function (value, where) - the formatter a chart would use
MK.charts.kinds                      ['line','area','bar','hbar','stackedBar','hstackedBar','heatmap','waterfall','scatter','divergingBar']
```

---

## 1. mount(parent, spec)

Builds a card inside `parent`: header (title, subtitle, optional segmented controls, Chart | Table
toggle), legend (top-left, under the title), plot, optional note. `parent` may be `null`: the card is
built detached and you append `controller.el` yourself (it starts drawing as soon as it has a size).
The header wraps: when a measure or grouping control does not fit beside the title (half- and
third-width cards) the tools move under the title, right-aligned; the title is never squeezed.

```js
var chart = MK.charts.mount(parent, {
  id: 'sales-trend',          // optional but recommended: stable key for remembered UI state (see 1.3)
  kind: 'line',               // one of MK.charts.kinds - required
  title: 'Daily net sales',   // card heading; also the default series name and the table caption
  subtitle: 'Last 30 days',   // optional
  height: 280,                // px, the WHOLE plot area including axis labels. Default 280
  data: { ... },              // per kind, section 2 - required
  format: 'inr',              // section 3. Default 'num'
  zeroBaseline: true,         // line / area only: false lets the y-axis start near the data (rates, percentages). Bars always start at zero
  controls: [                 // optional segmented controls for MEASURE or GROUPING only (filters live in the global bar)
    { id: 'measure', label: 'Measure', value: 'sales', options: [{ value: 'sales', label: 'Net sales' }, { value: 'orders', label: 'Orders' }] }
  ],
  onControl: function (id, value) { chart.update({ ... }); },
  onClick: function (datum) { },   // drill-through, section 4. Setting it also turns the cursor into a pointer
  table: 'auto',              // 'auto' (default) builds the table twin from data; or { columns, rows }, section 5
  note: 'small print under the plot',
  emptyText: 'No data for this selection',   // optional override
  bare: false                 // true: no surface, ring or padding - for a chart inside another card, tab or drawer
});
```

### 1.1 Controller

| Member | Behaviour |
|---|---|
| `el` | The card element (`<section class="mk-chart">`). |
| `update(partialSpec)` | Shallow-merges into the spec and redraws **without animation**. Keeps the card, its size, the Chart/Table choice, hidden series and control values. `data` is replaced wholesale, never deep-merged. Passing `controls` resets their values. Returns the controller. |
| `dispose()` | Disposes the ECharts instance and observer and removes the card from the DOM. Safe to call twice. |

### 1.2 Lifecycle rules

- One ECharts instance per mount. Resizing is automatic (one `ResizeObserver` per card, coalesced to
  an animation frame). Never call `echarts` yourself.
- The router calls `MK.charts.disposeAll(root)` before re-rendering a page. If you mount charts inside
  something you tear down yourself (drawer, modal, tab body), call `disposeAll(thatElement)` first.
  As a safety net, every `mount()` also disposes charts whose card has left the document.
- The first paint animates (280 ms); every later redraw is instant, so filter changes feel snappy.
- The card never scrolls: the plot is sized to `height` with its axis labels inside, and the table
  twin is paged to the same height, so switching Chart/Table never moves the layout.
- Cards do not set their own outer height. To equalise a row, make the card the grid item
  (`grid.appendChild(MK.charts.mount(null, spec).el)`) or make the cell a flex column.

### 1.3 Remembered UI state

Chart/Table choice and hidden legend series are remembered in memory per `location.hash + spec.id`
(falls back to `title`), so they survive the router re-rendering the page on a filter change. Give
two cards on one page different `id`s (or titles).

---

## 2. Kinds and data shapes

Common conventions:

- `values` arrays align by index with `labels` / `categories`. `null` means "no value": a gap in a
  line, no bar, an empty heat cell. Never pass `NaN` or strings.
- **Series colour.** Order of precedence: `series[i].colourVar` -> entity colour when
  `data.colourBy` is `'channel' | 'medium' | 'outlet'` (the series `id` must then be the entity id:
  `petpooja|swiggy|zomato`, `dinein|takeaway|delivery`, an outlet id or `factory`) -> `--series-1..8`
  by position. Use `colourBy` for entities so a filter never repaints the survivors. A 9th positional
  series is drawn in `--series-muted` with one console warning - fold the tail into "Other" instead.
- `colourVar` is always a token name from `css/tokens.css` (`'--ch-swiggy'`), never a colour literal.
- A legend appears for two or more series (none for one). Legend items toggle series; the last
  visible series cannot be hidden. The toggle applies to **both views of the card**: a hidden series
  leaves the table twin too, and totals and percentage shares are computed over the visible series in
  the chart and in the table alike. In table view a legend with toggles stays visible (it says which
  series the table includes); a legend that only explains marks is hidden there.
- **One y-axis, always.** All series of one chart share a unit. Two measures = two charts.

### 2.1 `line` / `area`

```js
data: {
  labels: ['1 Sep', '2 Sep', ...],                  // x positions, in order
  series: [{ id, name, values: [], colourVar? }],   // or the single-series shorthand below
  values: [], name: 'Net sales', colourVar: '--seq-500',
  colourBy: 'channel',                              // optional, see above
  markers: [{ label: 'Ganeshotsav', atLabel: '14 Sep' }],   // vertical event markers with a caption on top
  emphasise: 'kalyan',                              // that series in its colour, the rest in grey; legend shows it + restLabel
  restLabel: 'Other outlets',                       // default 'Others'
  showTotal: true,                                  // adds a Total row to the tooltip and a Total column to the table
  labelHeader: 'Day',                               // first column header of the table twin (default 'Period')
  forecast: { fromIndex: 169, label: 'Forecast',    // single-series only: values from fromIndex on are a forecast, drawn dashed
              lo: [], hi: [], bandLabel: '80% band' } // optional band, arrays aligned with labels (null before fromIndex)
}
```

**Forecast tail.** With `forecast` on a single-series line the values before `fromIndex` are drawn solid and end in
the usual dot and direct label (the last actual); the values from `fromIndex - 1` on continue as a dashed line in
the same colour, a hairline marker captioned `label` stands on the first forecast point, and `lo` / `hi` fill a
wash between them. The tooltip names forecast points `label` and adds a `bandLabel` row with the range. The table
twin lists the forecast values like any other. Ignored when several series are visible (a channel split has no
forecast).

2px lines, axis-trigger tooltip with a crosshair listing every series at that x (value first, then
name, a short line key). Every line ends in an 8px dot with a 2px surface ring. Line ends are
direct-labelled when there are at most 4 series and the labels do not collide (one series: its last
value; several: their names; `emphasise`: only that series) - otherwise the legend carries identity.
`area` adds a 10% wash under each line (not stacked); use it for one series, two at most. Marker
captions that would collide go to a second row, then to the tooltip.

`onClick` fires for a click anywhere in the plot and reports the x position (section 4).

```js
MK.charts.mount(el, { kind: 'line', title: 'Daily net sales by channel', format: 'inr',
  data: { labels: s.labels, colourBy: 'channel', showTotal: true,
          series: [{ id: 'petpooja', name: 'Petpooja', values: a }, { id: 'swiggy', name: 'Swiggy', values: b }] } });

MK.charts.mount(el, { kind: 'area', title: 'Net sales', format: 'inr',
  data: { labels: s.labels, values: totals, name: 'Net sales' } });

MK.charts.mount(el, { kind: 'line', title: 'Food cost % by outlet', format: 'pct', zeroBaseline: false,
  data: { labels: weeks, colourBy: 'outlet', emphasise: 'kalyan', restLabel: 'Other outlets', series: byOutlet } });
```

### 2.2 `bar` / `hbar`

```js
data: {
  categories: ['Bandra', 'Andheri', ...],           // sort order is yours
  values: [], name: 'Net sales', colourVar: '--series-1',     // single series: ONE colour for every bar
  series: [{ id, name, values: [], colourVar? }],   // or grouped series, side by side with a 2px gap
  colourBy: 'channel',
  highlight: 'Kalyan',                              // single series: that category in colour, the rest grey
  target: 1200000,                                  // single series: a number -> a solid rule; an array -> one tick per category
  targetName: 'Plan',                               // default 'Target'; appears in legend, tooltip and table
  categoryHeader: 'Outlet'                          // first column header of the table twin (default 'Category')
}
```

Bars are at most 24px thick, 4px rounded at the data end, square at the baseline, and always start
at zero. Negative values are supported (rounded end and label flip). Value labels sit at the bar tip
only for a single series with at most 12 categories; otherwise the axis, tooltip and table carry the
values. `target` is ignored for grouped series.

Category labels of vertical charts (`bar`, `stackedBar`, `waterfall`, up to 12 categories) never split
a word. Each label is wrapped at word boundaries onto at most two lines of its band. If any label
cannot be set that way (a word wider than the band, or a third line needed) all labels of that chart
are slanted by 35 degrees instead - whole names, truncated only where the card edge or the height
budget (28% of `height`) forces it - and the console warns once. Treat that warning as a request:
long names belong in `hbar` / `hstackedBar`, or the card needs more width.

```js
MK.charts.mount(el, { kind: 'bar', title: 'Net sales by outlet', format: 'inr',
  data: { categories: outletNames, values: sales, name: 'Net sales', target: plan, targetName: 'Plan' } });

MK.charts.mount(el, { kind: 'hbar', title: 'Net sales by dish', format: 'inr',
  data: { categories: names, values: sales, name: 'Net sales', categoryHeader: 'Dish' } });
```

### 2.3 `stackedBar` / `hstackedBar`

```js
data: {
  categories: [], series: [{ id, name, values: [], colourVar? }], colourBy: 'channel',
  percent: true,                                    // normalise every bar to 100% (axis 0-100%)
  categoryHeader: 'Outlet'
}
```

Values must be non-negative. 2px surface gap between segments; only the outermost segment has the
rounded end. Legend always. A segment is labelled only where the text fits inside it with padding
(in practice: horizontal stacks); the rest is in the tooltip, which lists every segment of the bar
plus the total. Absolute mode with at most 12 categories prints the total at the bar tip. Percent
mode: tooltip shows share and value; the table shows shares plus the absolute total. Hiding a series
from the legend renormalises percent mode and recomputes the totals - in the chart and in the table.

```js
MK.charts.mount(el, { kind: 'stackedBar', title: 'Net sales by month and medium', format: 'inr',
  data: { categories: months, colourBy: 'medium', series: byMedium } });

MK.charts.mount(el, { kind: 'hstackedBar', title: 'Channel mix by outlet', format: 'inr',
  data: { categories: outletNames, colourBy: 'channel', percent: true, series: byChannel } });
```

### 2.4 `heatmap`

```js
data: {
  rows: ['Mon', ...], cols: ['11:00', ...],
  values: [[...cols], ...rows],                     // values[rowIndex][colIndex]; null = empty cell
  min: 0, max: undefined,                           // scale ends; default 0 (or the lowest negative) .. highest value
  valueLabel: 'Orders per hour',                    // caption of the scale legend
  cellLabels: undefined,                            // default: see below; true: label every cell; false: never print values in cells
  rowHeader: 'Day', colHeader: 'Hour'               // table twin headers
}
```

Blue sequential ramp `--seq-100..700` through `visualMap`, compact scale legend under the title, 2px
surface gap between cells, cell tooltip with the value, then "row, col". Direct labels are selective: a
grid of up to 40 cells (outlet x channel) prints every value; a larger grid (day of week x hour) prints
only the peak of each row, and the scale legend, tooltip and table twin carry the rest. Nothing is
printed when the text does not fit a cell. `cellLabels: true` forces every cell, `false` none. The ink
switches to the surface colour on dark cells. Rows run top to bottom
in the order given. The table twin is the matrix; when it has more than 8 columns it is transposed
so it stays narrow.

```js
MK.charts.mount(el, { kind: 'heatmap', title: 'Orders by day and hour', format: 'num', height: 300,
  data: { rows: MK.dates.DOWS, cols: hours, values: matrix, valueLabel: 'Orders' } });
```

### 2.5 `waterfall`

```js
data: {
  steps: [{ label: 'Net sales', value: 4780000, kind: 'total' },     // kind: 'total' | 'minus' | 'plus'
          { label: 'Commission', value: 1051600, kind: 'minus' }, ...],
  kindLabels: { total: 'Subtotal', minus: 'Deduction', plus: 'Addition' },   // legend / tooltip / table wording
  stepHeader: 'Line'                                // table twin header (default 'Step')
}
```

`total` sets the running figure to `value` (use it for the opening figure, subtotals and the
closing figure). `minus` / `plus` move the running figure by `|value|` - pass magnitudes, the sign
comes from `kind`. A missing `kind` is inferred from the sign of `value`. Totals are drawn in
`--ink-2`, decreases in `--div-neg-2`, increases in `--seq-500`, with hairline connectors and a
signed value label above each bar. A step may cross zero (loss-making P&L). Tooltip: step value and
running total. Keep it to about 12 steps. Step labels follow the rule of section 2.2: two wrapped lines
where the words fit, slanted whole names in a narrow card (a nine-step bridge wants a full-width card).

```js
MK.charts.mount(el, { kind: 'waterfall', title: 'Gross menu value to net payout', format: 'inr', height: 320,
  data: { steps: e.steps, kindLabels: { total: 'Subtotal', minus: 'Deduction' } } });
```

### 2.6 `scatter`

```js
data: {
  points: [{ id, name, x, y, size? }],              // size is optional (dot area, 12-26px)
  xLabel: 'Plates sold', yLabel: 'Contribution per plate', sizeLabel: 'Net sales',
  xFormat: 'num', yFormat: 'inrFull', sizeFormat: 'inr',      // each as in section 3 (spec.format is not used)
  quadrants: { x: 1900, y: 130, labels: ['Stars', 'Puzzles', 'Dogs', 'Plowhorses'] },   // topRight, topLeft, bottomLeft, bottomRight
  highlight: 'mutton-seekh' | ['id', ...],          // those points in colour, the rest grey
  colourVar: '--series-1', nameHeader: 'Dish'
}
```

One colour. Every point is direct-labelled with its name; ECharts `labelLayout` moves or hides
labels that would overlap (the table twin always has them all). Quadrant guides are solid hairlines
with muted corner captions, drawn behind the dots and their names (guides and the event markers of
`line` sit above the gridlines and below the data), and both guides are always inside the axis range. Each dot has a
pointer target of at least 28px and grows on hover. Axes do not start at zero.

```js
MK.charts.mount(el, { kind: 'scatter', title: 'Menu engineering', height: 360,
  data: { points: dishes.map(function (d) { return { id: d.id, name: d.name, x: d.qty, y: d.contribution, size: d.netSales }; }),
          xLabel: 'Plates sold', yLabel: 'Contribution per plate', sizeLabel: 'Net sales',
          xFormat: 'num', yFormat: 'inrFull', sizeFormat: 'inr',
          quadrants: { x: medianQty, y: medianContribution, labels: ['Stars', 'Puzzles', 'Dogs', 'Plowhorses'] } } });
```

### 2.7 `divergingBar`

```js
data: {
  categories: [], values: [],                       // positive and negative values
  name: 'Variance',                                 // tooltip / table wording
  zeroLabel: 'Budget',                              // caption on the centre line
  posLabel: 'Under budget', negLabel: 'Over budget',   // optional legend
  invert: false,                                    // true swaps the two colours
  categoryHeader: 'Category'
}
```

Horizontal bars growing from a centred zero line on a symmetric axis; positive in `--div-pos-2`,
negative in `--div-neg-2`. The signed value label sits beside the zero line on the empty side of its
bar (a negative bar grows left, its label reads on the right of zero), so no label gutter is taken
from either end and the plot keeps its width in a third-width card; labels are dropped when even
that does not fit. The axis always reads `-bound / 0 / +bound` (edge labels aligned inwards); the
half-way ticks appear where five labels fit. Format the sign convention in the data (for budgets pass
`budget - actual` so that over-spend is negative and red).

```js
MK.charts.mount(el, { kind: 'divergingBar', title: 'Budget variance by category', format: 'inrFull',
  data: { categories: names, values: variance, name: 'Variance', zeroLabel: 'Budget',
          posLabel: 'Under budget', negLabel: 'Over budget' } });
```

---

## 3. Formats

`spec.format` (and `xFormat`, `yFormat`, `sizeFormat`, table column `format`):

| Value | Axis | Labels on marks | Tooltip | Table twin |
|---|---|---|---|---|
| `'inr'` | compact, **one unit per axis**, chosen by the top tick: lakh axis `₹0.5 L`, `₹1 L`; crore axis `₹0.3 Cr`, `₹0.6 Cr`, `₹1.2 Cr` (never `₹90 L` next to `₹1.2 Cr`) | `MK.fmt.inr` | `MK.fmt.inr` | full rupees `MK.fmt.inrFull` |
| `'inrFull'` | compact | `MK.fmt.inr` | `MK.fmt.inrFull` | `MK.fmt.inrFull` |
| `'num'` (default) | `MK.fmt.num`, whole-number ticks for whole-number data | same | same | same |
| `'pct'` | fractions in, `12%` | `12.3%` | `12.3%` | `12.3%` |
| `'kg'` | `MK.fmt.kg` | same | same | same |
| `function (value, where)` | `where` is `'axis' \| 'label' \| 'tooltip' \| 'table'`; return a string | | | |

Percentages are **fractions** (0.123 -> 12.3%). Money is whole rupees. Axis ticks are ECharts' clean
numbers; `divergingBar` and percent stacks use fixed clean ticks.

---

## 4. onClick(datum)

`{ seriesId, seriesName, category, value, datum }`

| Kind | seriesId / seriesName | category | value | datum |
|---|---|---|---|---|
| line, area | `null` | the x label under the pointer | `null` | `{ index, label, values: { seriesId: value } }` |
| bar, hbar | clicked series | category | bar value | `{ index, target }` |
| stackedBar, hstackedBar | clicked series | category | segment value | `{ index, share, total }` |
| heatmap | `null` | column label | cell value | `{ row, col, rowIndex, colIndex, value }` |
| waterfall | `null` / kind label | step label | step change (total: its value) | `{ index, kind, running, step }` |
| scatter | point id / name | point name | y | the point object you passed |
| divergingBar | `null` / `data.name` | category | value | `{ index }` |

---

## 5. Table twin

`table: 'auto'` derives a real `<table>` (caption, `<th scope>`) from `data`, formatted with the
chart's format at table precision, paged to the plot height. It follows the legend: series hidden in
the chart are left out, and totals and shares cover the visible series only, so the two views always
agree. A custom table is yours: legend toggles do not change it (and the legend is hidden in its
table view). Override when the chart shows a derived view of richer records:

```js
table: {
  columns: [{ key: 'day', label: 'Day' }, { key: 'kg', label: 'Dispatched', format: 'kg', align: 'right' }],
  rows: [{ day: '1 Sep', kg: 109 }, ...]
}
```

Numbers use the column `format`, else the chart's; `null` prints `-`; all-numeric columns align
right unless `align` says otherwise. If ECharts is missing the card shows the table only.

---

## 6. sparkline(el, values, opts)

Inline SVG, no ECharts. Replaces the content of `el` (pass `null` to just get the element back).

```js
MK.charts.sparkline(cell, weeklySales, {
  width: 96, height: 28,           // defaults
  colourVar: '--seq-500',          // colour of the emphasised last point (default)
  emphasiseLast: true,             // 3px dot on the last value
  area: false,                     // soft fill under the line
  format: 'inr',                   // used in the aria-label
  label: 'Bandra weekly net sales' // aria-label prefix
});
```

1.5px line in `--series-muted`; `null` values break the line; a flat series is drawn mid-height; an
empty series is a faint baseline. `role="img"` with an aria-label "first to last (change)".

---

## 7. Colours

```js
MK.charts.colourFor('channel', 'swiggy')   // '--ch-swiggy'
MK.charts.colourFor('medium', 'delivery')  // '--md-delivery'
MK.charts.colourFor('outlet', 'fort')      // '--ot-3'  (position of the id in MK.session.OUTLET_IDS)
MK.charts.colourFor('outlet', 'factory')   // '--ot-factory'  (also colourFor('factory'))
MK.charts.colourFor('series', 0)           // '--series-1' ... index 7 -> '--series-8'; beyond -> '--series-muted' + one warning
```

It returns the token **name**, so the same value works as a `colourVar`, in `MK.ui.cells.bar(max, colourVar)`
and in CSS (`'var(' + name + ')'`). Use `MK.charts.token(name)` or `MK.charts.colour(kind, id)` when
you need the computed colour.

---

## 8. Do and do not

1. Do pick the form by the job: magnitude -> `bar`/`hbar`, trend -> `line`, share -> `stackedBar`, grid -> `heatmap`, bridge -> `waterfall`, above/below -> `divergingBar`, one series is the story -> `emphasise` / `highlight`. A single number is a stat tile, not a chart.
2. Do not build a dual-axis chart, ever. Mismatched units in one chart are a caller bug; mount two charts or small multiples.
3. Do colour entities with `colourBy`; never assign colours by rank or by loop index over a filtered list.
4. Do not pass more than 8 series. Past about 7 meaningful categories use a table with inline bars.
5. Do not colour single-series bars by their own value. One series, one colour; `highlight` is the only exception.
6. Do keep filters in the global filter bar. A card control switches measure or grouping only, and answers through `update()`.
7. Do pass numbers, never pre-formatted strings; choose `format` and let the wrapper format axis, labels, tooltip and table consistently.
8. Do not write ECharts options, colours or fonts in page code. If a form is missing, add a kind to `charts.js`.
9. Do not show a channel-attributed measure the channel cannot provide (SPEC section 9) - the chart will draw whatever it is given.
10. Do give each card a stable `id`, mount into a container that is (or will be) in the document, and let the router's `disposeAll` clean up; call `disposeAll(el)` yourself for drawers, modals and tabs.

---

## 9. CSS hooks

`.mk-chart` (card) - modifiers `.mk-chart--bare`, `.is-table`; attribute `data-kind`. Parts:
`__head`, `__title`, `__subtitle`, `__tools`, `__controls`, `__seg`, `__legend`, `__body`, `__plot`,
`__table`, `__empty`, `__note`. Tooltip: `.mk-tip`. Sparkline: `.mk-spark`. Do not restyle these from
page CSS; change `css/charts.css`. The segmented control (`__seg`, `__segbtn`) takes its look from the
rules of `MK.ui.segmented` in `css/components.css` (shared selectors), so a chart control and a
`ui.segmented` next to it are identical. `.mk-chart__legend.has-toggles` marks a legend that stays
visible in table view. Notes, empty states and marker captions use `--ink-2`; `--ink-3` is kept for
canvas axis ticks and disabled legend entries.
