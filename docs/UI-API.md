# UI-API - shell, router, filters and UI kit

Contract for page authors. Code from this file; you should not need to read `js/core/*.js`.
Live reference of every component: `#/system/styleguide` (source: `js/pages/styleguide.js`). It is registered with `nav: false`, as is
`#/system/styleguide-charts`: both hold typed sample figures, so they open by URL only and never appear in the client-facing menu.

Ground rules
- A page file is one IIFE that calls `MK.router.register({...})`. It never edits `index.html`, the shell or the kit.
- Every component returns a **DOM node** unless marked *controller*. Children may be strings, numbers, nodes, arrays, `null`/`false`.
- Strings always become text nodes. Never build HTML strings from data.
- No colours in page code. Pass token **names** (`'--ch-swiggy'`) where a colour is needed; use classes otherwise.
- Numbers on screen come from the data layer, formatted with `MK.fmt`. (Only the styleguide types sample figures.)
- `var ui = MK.ui, h = ui.h;` is assumed in the examples.

---

## 1. Router - `MK.router`

### register(def)
```js
MK.router.register({
  id: 'revenue-sales',            // unique; also gives the page root the class 'pg-revenue-sales'
  route: '#/revenue/sales',       // exact hash; '#/revenue/sales/x/y' also matches -> ctx.params.path = ['x','y']
  group: 'Revenue',               // Overview | Revenue | Costs | Approvals | Vendors | Factory | Banking | System
  title: 'Sales explorer', subtitle: 'optional one-liner shown next to the title',
  units: 'outlets',               // 'all' everyone | 'outlets' personas with >= 1 outlet | 'factory' personas with the factory
  roles: null,                    // or ['checker', 'director'] - roles allowed to open it
  filters: ['date', 'outlet', 'channel', 'medium'],   // global filters the page honours; [] hides the filter bar
  icon: 'chart',                  // optional, defaults by page id
  navLabel: 'Sales',              // optional shorter menu label (menu text fits ~24 characters); defaults to title
  nav: true,                      // false = routable by URL but no menu item (the two styleguide pages); default true
  render: function (root, ctx) { /* build into root; may return a cleanup function */ }
});
```
Registering an existing `id` replaces the page (this is how a built page overrides its stub). Routes start with `#/`: any other
fragment (`#mk-content` from the skip link, an in-page anchor) is not a route, and the router keeps the current screen.
Nav order: groups in the order above, pages in script order. A group with a single menu page shows no heading. `nav: false`
pages are left out of the menu and out of that count, and are never the fallback for an unknown route; the client-facing menu
therefore lists only the screens of SPEC section 8.
`units` and `roles` only decide who gets the menu item and may open the route; scoping the numbers is the data layer's job.

### ctx (second argument of render)
| field | meaning |
|---|---|
| `ctx.filters` | `{from, to, outletIds, channelIds, mediumIds, preset}` - the global filter state **narrowed to the dimensions the page declared in `filters`**. An undeclared dimension is `null` (= all; for `date`: `from`, `to` and `preset` are `null` = the whole data range), because it has no control in the filter bar and may still hold a value set on another screen. Pass `ctx.filters` to selectors as is; **never call `MK.filters.get()` from a page** - it returns the unnarrowed global state |
| `ctx.user` | current persona (`MK.session.current()`) |
| `ctx.params` | query params of the hash as strings, e.g. `#/vendors?id=V-014` -> `{id: 'V-014'}`; extra path segments in `params.path` |
| `ctx.state` | plain object kept per route across re-renders and navigation (selected tab, open record id, table sort). Not persisted |
| `ctx.navigate(route, params, opts)` | same as `MK.router.navigate` |
| `ctx.rerender()` | re-run `render` now (synchronously), keeping scroll position |

Lifecycle: the router re-runs `render` (debounced 60 ms, current page only) on `filters:changed` (only if `filters` is non-empty),
`session:changed` and `store:changed` (any key except `prefs`). Before each run it calls the previous cleanup function, then
`MK.charts.disposeAll(root)`, then empties `root`. Scroll position is kept on re-render and reset when another page opens. Keyboard
focus (and the caret of a text box) is restored when the same kind of element sits at the same place in the new DOM, so a search box
may call `ctx.rerender()` on every keystroke. Drawers, modals and popovers are closed when the hash changes (new page **or** new
params), never on a plain re-render - except popovers whose anchor disappeared with the old DOM. Normally a drawer is opened from a
click handler. To honour a deep link (`#/vendors?id=V-014`, e.g. from an insight) open it from `render` once per id, because a plain
re-render keeps the drawer that is already open. **When the user closes that drawer the id must leave the hash too** - `ctx.params`
stays the same until the hash changes, so the next re-render (the store write of the approval that just happened) would open the
drawer again:
```js
if (ctx.params.id && st.opened !== ctx.params.id) {
  var id = ctx.params.id;
  st.opened = id;
  openVendor(id, function onClose() {                 // pass this as the drawer's onClose
    st.opened = null;
    var cur = MK.router.current();                    // already the NEW route when navigation is what closed the drawer
    if (cur && cur.page.id === 'vendors' && cur.params.id === id) ctx.navigate('vendors', null, { replace: true });
  });
}
```
The guard tells the two ways a drawer closes apart: the router moves `current()` to the new route *before* it closes the overlays,
so `current().params.id === id` is only true when the user (or your own `d.close()` after a workflow action) closed it. `replace: true`
keeps Back pointing at the screen the user came from instead of re-opening the record.
`render` must be idempotent and cheap, and **must not write to `MK.store`** (that would loop).
A `render` that throws shows an error card with the message and logs to the console; the rest of the app keeps working.

```js
render: function (root, ctx) {
  var st = ctx.state; st.tab = st.tab || 'review';
  root.appendChild(ui.tabs({ items: TABS, value: st.tab, onChange: function (id) { st.tab = id; ctx.rerender(); } }));
  var timer = setInterval(tick, 1000);
  return function cleanup() { clearInterval(timer); };
}
```

### Other functions
| call | returns / effect |
|---|---|
| `navigate(route, params, {replace})` | `route` is a hash (`'#/approvals/bills'`) or a page id (`'approvals-bills'`); `params` become the query string. Same hash -> re-render. `replace: true` swaps the current history entry instead of adding one. The route is resolved **synchronously**: when `navigate` returns, `current()` is the new page and its first render has run |
| `href(idOrRoute, params)` | the hash string, for `h('a', {href: ...})` or `ui.link` |
| `rerender()` | re-render the current page now |
| `current()` | `{page, params}` or `null` |
| `pages()` / `allowedPages(user?)` | registered pages in nav order / those the persona may open |
| `isAllowed(pageOrId, user?)` | boolean |
| `start({content, page, nav})`, `renderNav()` | used by `app.js` only |
| `GROUPS` | the group names in nav order |

```js
ui.statTile({ label: 'Bills awaiting approval', value: n, onClick: function () { ctx.navigate('approvals-bills', { tab: 'review' }); } });
ui.link('See the payout reconciliation', MK.router.href('revenue-audit'));
```
Events on `MK.bus`: `route:changed` `{page, params}` (after the top bar is updated, before render).

---

## 2. Filters - `MK.filters`

State lives in `prefs.filters`; every change emits `filters:changed` with the new `get()` object.
All presets are relative to `MK.calendar.dataEnd` (frozen clock), clamped to `dataStart..dataEnd`.

| call | meaning |
|---|---|
| `get()` | `{from, to, outletIds, channelIds, mediumIds, preset}`; ISO dates; id arrays or `null` = all. `outletIds` is already limited to the persona's outlets; a selection that covers every option is normalised to `null` |
| `set(partial)` | `{preset}` with `last7 \| last30 \| thisMonth \| lastMonth \| thisQuarter \| fytd \| custom`; `{from, to}` implies `custom`; `{outletIds \| channelIds \| mediumIds: [...] \| null}` |
| `reset()` | back to This month / all |
| `isDefault(showList?)` | true when the listed controls are at their defaults |
| `describe()` | `'1 Sep - 16 Sep 2026, 16 days'` - handy as a card subtitle |
| `summary(kind)` | `'All outlets'`, `'Bandra'`, `'Bandra +2'` for kind `outlet \| channel \| medium` |
| `options(kind)` | `[{id, label, colourVar}]` - from `MK.config` when loaded, else kernel fallbacks; outlets limited to the persona |
| `presets()` / `range(presetId)` | `[{id, label, from, to}]` / `{from, to}` |
| `mountBar(container, showList)` | used by the shell; pages only declare `filters: [...]` in `register` |

```js
var f = ctx.filters;                                   // inside render - already narrowed to the page's declared filters
var s = MK.data.summary(f);                            // selectors take the filter object as is
MK.filters.set({ outletIds: ['andheri'] });            // drill-through from a chart click, then navigate
MK.filters.set({ from: '2026-08-01', to: '2026-08-31' });
var caption = MK.filters.describe();
```
Behaviour: date control = popover of presets (bold + tick on the selected one; Custom shows two native date inputs limited to the data
range). Outlet / channel / medium = checkbox popovers with an "All" row; changes apply live. A persona with one outlet sees a locked
chip; a persona with none (factory manager) gets no outlet control. On role change, outlet selections the new persona cannot see are dropped.
"Reset filters" appears only when a shown control is non-default. Never put filters inside a chart card.
A value set on one screen stays in the global state (it is back when the user returns), but it only reaches pages that declare that
dimension - the router narrows `ctx.filters`, so what the bar shows is always exactly what the numbers use.

---

## 3. UI kit - `MK.ui`

### 3.1 DOM helpers
| call | notes |
|---|---|
| `h(tag, attrs?, ...children)` | attrs: `class` (string or array, falsy entries dropped), `style` (object; `'--x'` keys allowed), `dataset` (object), `onClick`/`onInput`/... handlers, `aria-*`, `for`, boolean attributes (`true` sets, `false`/`null` skips), `value`/`checked`/`disabled` set as properties. SVG tags are namespaced |
| `icon(name, size = 16)` | inline SVG, stroke 1.75, `currentColor`. Names: `home overview chart clock dish shield-check receipt coins scale calculator check-circle x-circle alert-triangle info building factory store truck box bank wallet layers grid list database users user chevron-down chevron-up chevron-right chevron-left arrow-up arrow-down arrow-right plus minus check x search filter download upload edit more refresh external calendar paperclip lock eye file copy trash`. `iconNames()` lists them |
| `clear(node)` / `append(parent, ...children)` | empty a node / append with the same child rules as `h`; both return the node |
| `token('--name')` | computed value of a CSS custom property |
| `format(fmt, value, row?)` | `fmt`: `'inr' \| 'inrFull' \| 'num' \| 'num1' \| 'pct' \| 'kg' \| 'date' \| function (value, row)`; blanks -> `'-'` |
| `dateTime(at)` | `'2026-09-16T14:32'`, `'2026-09-16'` or epoch ms -> `'16 Sep 2026, 14:32'` |
| `uid(prefix?)` | unique id string |

```js
var row = h('div', { class: ['mk-row', isLate && 'mk-bad'], onClick: open, 'aria-label': 'Open ' + bill.id },
  ui.icon('receipt'), h('strong', null, bill.vendorName), MK.fmt.inrFull(bill.amount));
```

### 3.2 Layout
| call | notes |
|---|---|
| `grid(cols, children, {tight, start, className})` | `cols` number 1-6 = equal columns; `cols` array = spans on a 12-column grid, repeating: `grid([8, 4], [a, b])` |
| `row(children, {wrap, between, end, top, gap: 1\|2\|3\|4\|6})` | horizontal flex, centred, 8px gap |
| `stack(children, gap?)` | vertical flex; gap `1 2 3 5 6` (x4px), default 16px |
| `sectionTitle(title, sub?, actions?)` | heading between groups of cards |
| `card({title, subtitle, actions, body, footer, flush, className, id})` | `flush: true` removes body padding (tables). `card.bodyEl` is the body container |

The page root is already a vertical stack with 16px gaps: append cards and grids straight into `root`.
```js
root.appendChild(ui.grid([8, 4], [
  ui.card({ title: 'Outlet scorecard', flush: true, body: ui.table({ columns: cols, rows: rows }) }),
  ui.card({ title: 'Needs attention', body: insightList, footer: ui.link('All insights', '#/overview') })
]));
```

### 3.3 Figures
| call | notes |
|---|---|
| `hero({label, value, delta, goodWhen, deltaNote, sub})` | the single >= 48px figure of a page |
| `statTile({label, value, delta, goodWhen, deltaNote, sub, spark, sparkColourVar, onClick, icon, tone, title})` | `delta` = object from `MK.fmt.delta` / `MK.fmt.points` (`{label, dir}`); `goodWhen: 'up' (default) \| 'down' \| 'neutral'` decides good/bad ink, the arrow carries direction; `spark`: number array (drawn when `MK.charts.sparkline` exists); `onClick` makes the tile a button; `tone: 'warn' \| 'critical' \| 'good'` adds an edge marker |
| `kpiRow([tileOptions \| node, ...])` | responsive row of tiles (auto-fit, min 168px) |
| `deltaBadge(delta, goodWhen, {note, size: 'lg'})` | the arrow + label used above; `null` when there is no delta |

```js
var s = MK.data.summary(ctx.filters);
root.appendChild(ui.kpiRow([
  { label: 'Orders', value: MK.fmt.num(s.orders), delta: MK.fmt.delta(s.orders, s.prev.orders) },
  { label: 'Food cost', value: MK.fmt.pct(fc.actualPct), delta: MK.fmt.points(fc.actualPct, fc.prevPct), goodWhen: 'down' }
]));
```

### 3.4 Table
`table({columns, rows, onRowClick, dense, footer, empty, sortable, sort, onSort, maxHeight, rowClass, caption, className})`
-> wrapper node with `setRows(rows)` and `getSort()`.

| option | meaning |
|---|---|
| `columns[]` | `{key, label, align: 'left'\|'right'\|'center', format, render, width, maxWidth, wrap, sortable, sortValue(row), numeric, title, className}`. Numeric (right-aligned, tabular figures) when `format` is a number format or `align: 'right'` |
| `maxWidth`, `wrap` | Body cells **never wrap by default** (ids, dates, amounts and chips stay on one line; a table wider than its card scrolls sideways inside the wrapper). Long text is a per-column choice: `maxWidth: 240` (px) keeps one line and truncates with an ellipsis, full text as the tooltip; `wrap: true` lets the cell wrap (notes, insight sentences) |
| `render(value, row, col, ctx)` | returns node or string; `ctx = {rows, index}` |
| `sortable` | table-wide default; per-column `sortable` overrides. Numeric aware, blanks last, first click = descending for numbers. Delta objects sort by `.value` |
| `sort`, `onSort` | initial `{key, dir: 'asc'\|'desc'}` and a callback - store it in `ctx.state` so the sort survives re-renders |
| `onRowClick(row, event)` | rows become focusable; Enter / Space activate; clicks on inner buttons and links are ignored |
| `footer` | object keyed by column key (raw values are formatted with the column's `format`; strings and nodes pass through), or an array of such objects |
| `empty` | string or node shown when `rows` is empty |
| `maxHeight` | px number or CSS length: scrolls inside with sticky header and footer |
| `rowClass(row)` | e.g. `'is-selected'`, `'is-muted'`, `'is-strong'` |

Cell renderers - `MK.ui.cells`
| call | notes |
|---|---|
| `bar(max, colourVar = '--series-1', {format})` | inline bar + value; `max: null` = column maximum. One colour for all bars |
| `heat(min, max, {format, scale: 'div', mid, invert})` | shades the whole cell on the blue ramp (ink flips on dark steps); `null` bounds = column range. `scale: 'div'` = blue above `mid`, red below (`invert` swaps) |
| `delta(goodWhen)` | value is a delta object or a fraction |
| `status()` | value is a state -> `statusChip` |
| `spark(colourVar)` | value is a number array |
| `twoLine(subKey \| fn(row), {maxWidth = 280})` | bold value + muted second line; both lines truncate with an ellipsis at `maxWidth` px (tooltip = full text), so a long vendor name never makes the row taller. `{maxWidth: null}` removes the limit (combine with `wrap: true` on the column to wrap instead) |
| `entity(colourVar \| fn(row))` | colour dot + label, e.g. channels |

```js
ui.table({ sortable: true, sort: st.sort || { key: 'netSales', dir: 'desc' }, onSort: function (s) { st.sort = s; },
  columns: [{ key: 'name', label: 'Outlet', render: ui.cells.twoLine('city') },
            { key: 'netSales', label: 'Net sales', format: 'inr', render: ui.cells.bar(null, '--series-1') },
            { key: 'foodCostPct', label: 'Food cost %', format: 'pct', render: ui.cells.heat(null, null) }],
  rows: rows, footer: { name: 'All outlets', netSales: total }, onRowClick: function (r) { openOutlet(r.id); } });
```

### 3.5 Buttons, chips, states
| call | notes |
|---|---|
| `button({label, icon, iconRight, variant, size: 'sm', onClick, disabled, disabledReason, title, type, block, ariaLabel})` | `variant`: `'secondary'` (default) `'primary'` `'ghost'` `'danger'` `'text'`. `button('Label')` also works. **`disabledReason`** (non-empty string, e.g. `MK.session.can(...).reason`) keeps the button visible and focusable, blocks the click and shows the reason as tooltip - use it for segregation-of-duties |
| `iconButton(iconName, label, onClick, {variant, size, disabledReason})` | icon-only, `label` becomes tooltip and aria-label |
| `link(label, route, {icon, title})` | in-app anchor |
| `chip(label, tone, {icon, dotVar, outline, title})` | `tone`: `neutral info good warn serious critical`; `dotVar: '--ch-zomato'` adds an entity dot |
| `statusChip(state, {label, title})` | the one mapping of states to tone + icon + label |
| `statusInfo(state)` | `{tone, icon, label}` |
| `avatar(initials, {accent, size: 'sm'})` | |

States known to `statusChip` (case-insensitive; unknown states render neutral with a humanised label):
`DRAFT` Draft, `SUBMITTED` Submitted, `UNDER_REVIEW` Under review, `APPROVED` Approved, `REJECTED` Rejected, `IN_BATCH` In payment batch,
`PAID` Paid, `PENDING_RELEASE` Pending release, `RELEASED` Released to bank, `VERIFYING` Verifying, `VERIFIED` Verified,
`NEEDS_REVIEW` Needs review, `MATCHED` Matched, `SHORT_PAID` Short paid, `PENDING` Pending, `DISPUTED` Disputed, `OK` On track,
`WATCH` Watch, `RISK` At risk, `WITHIN` Within budget, `NEAR` Near limit, `OVER` Over budget, `OVERDUE` Overdue, `DUE_SOON` Due soon,
`NOT_DUE` Not due, `PASS` Pass, `FAIL` Fail, `SIMULATED` Simulated.

```js
var may = MK.session.can('bill.approve', { unitId: bill.unitId, createdBy: bill.createdBy });
var approve = ui.button({ label: 'Approve', variant: 'primary', icon: 'check', disabledReason: may.ok ? '' : may.reason,
  onClick: function () { var r = MK.workflow.bill.approve(bill.id); ui.toast(r.ok ? 'Bill approved' : r.error, { tone: r.ok ? 'good' : 'critical' }); } });
```

### 3.6 Tabs, segmented, select
| call | notes |
|---|---|
| `tabs({items: [{id, label, count}], value, onChange(id), ariaLabel})` | tab strip only; draw the panel yourself (usually `st.tab = id; ctx.rerender()`). Arrow keys move |
| `segmented({options: [{value, label}], value, onChange(value), size: 'sm', ariaLabel})` | for measure / grouping switches, including inside a card's `actions`. The `controls` of a chart card are the same control (one set of CSS rules styles both), so the two can sit side by side |
| `select({options: [{value, label, disabled}] \| [string], value, onChange(value), placeholder, size: 'sm', block, ariaLabel, disabled, name})` | native select; wrapper has `.input`, `.getValue()`, `.setValue(v)` |

```js
ui.card({ title: 'Outlet P&L', actions: ui.select({ ariaLabel: 'Month', value: st.month, options: months, size: 'sm',
  onChange: function (v) { st.month = v; ctx.rerender(); } }), body: pnlTable });
```

**`ui.stepper({label, value, min, max, step, unit, format(v), onChange(v), ariaLabel, title, size: 'sm'})`** - a labelled
figure with minus and plus buttons: the fine-tuning control for one model input (a safety margin, a number of days). The
value snaps to `step` inside `[min, max]`, the buttons disable at the ends, `onChange` fires on every click. The wrapper has
`getValue()` and `setValue(v)` (silent). Place it next to the figures it moves and repaint them in `onChange`, as the factory
inventory page does for its purchase suggestions.

### 3.7 Forms - `MK.ui.form` (also aliased as `ui.field`, `ui.input`, `ui.textarea`, `ui.moneyInput`, `ui.dateInput`, `ui.checkbox`, `ui.search`)
| call | notes |
|---|---|
| `form.field({label, control, hint, required, optional, error})` | binds the label to the first input inside `control`; wrapper has `.setError(msg)` (inline, sets `aria-invalid`), `.setOk(msg)`, `.input`, `.control`. Empty message clears |
| `form.input({value, placeholder, type, name, mono, maxLength, onInput(value, el), onChange(value, el), onEnter(value, el), disabled, readOnly, ariaLabel})` | returns the `<input>`; `mono: true` for GSTIN / PAN / IFSC / UTR (uppercase monospace) |
| `form.textarea({... , rows})` | returns the `<textarea>` |
| `form.moneyInput({value, placeholder, onChange(numberOrNull), name, disabled, ariaLabel})` | rupee prefix, Indian grouping on blur, raw digits on focus. Wrapper: `.getValue()` -> whole-rupee number or `null`, `.setValue(n)`, `.input` |
| `form.dateInput({value, min, max, onChange(iso), name, disabled, ariaLabel})` | native date input, ISO strings |
| `form.select(opts)` | `ui.select` at full width |
| `form.checkbox({label, checked, onChange(bool), name, disabled})` | label element, `.input` is the checkbox |
| `form.search({value, placeholder, onInput(value), width, ariaLabel})` | search box, `.input` |
| `form.row(fields, 2 \| 3)` / `form.group(children)` | side-by-side fields / vertical form container |

```js
var amount = ui.form.moneyInput({ value: bill.amount });
var amountField = ui.form.field({ label: 'Bill amount', required: true, control: amount });
function validate() { var ok = amount.getValue() > 0; amountField.setError(ok ? '' : 'Enter the bill amount'); return ok; }
body.appendChild(ui.form.group([ui.form.row([vendorField, amountField]), noteField]));
```
Keep typed values in `ctx.state` (or inside a drawer / modal, which live outside the page root): a store change re-renders the page
and would otherwise wipe half-filled inputs.

### 3.8 Overlays (*controllers*)
| call | notes |
|---|---|
| `drawer({title, subtitle, headerExtra, body, footer, width, onClose})` | right side, 480-560px (default 520), focus trap, Esc / backdrop close, focus returns to the trigger. Returns `{el, body, foot, close(), setTitle(t, sub), setBody(content), setFooter(content)}` |
| `modal({title, subtitle, body, footer, size: 'sm'\|'lg', dismissible, onClose})` | same controller. `dismissible: false` disables Esc / backdrop for the user; navigation (`closeAll()`) still closes it |
| `confirm({title, message, body, confirmLabel, cancelLabel, tone: 'primary'\|'danger', requireReason, reasonLabel, reasonPlaceholder, onConfirm(reason), onCancel()})` | returns `Promise<{ok, reason}>`, never rejects. `requireReason: true` blocks confirm until a reason is typed |
| `toast(message, {title, tone: 'info'\|'good'\|'warn'\|'critical', duration})` | bottom right, auto-dismiss (4.2 s), max 4 stacked. Returns `{close()}` |
| `popover(anchor, content, {align: 'left'\|'right', width, onClose})` | anchored panel; closes on outside click, Esc, scroll, resize. Calling it for an anchor that is already open closes it and returns `null`. Returns `{el, close(), reposition()}` |
| `menu(anchor, items, {align, width})` | items: `{label, sub, icon, avatar, hint, selected, danger, disabled, title, onSelect}` \| `{heading}` \| `{separator: true}`. If any item has `selected`, a tick column appears |
| `closeAll()` / `closeOrphans()` | close every popover, drawer and modal, `dismissible: false` ones included (the router does this when the hash changes) / close popovers whose anchor left the document (the router does this after each re-render) |

Overlays live outside the page root, so they survive page re-renders: after a workflow action refresh them yourself (`d.setBody(...)`).
Dialogs stack in opening order: a confirm or modal opened from a drawer puts its backdrop over the drawer, which is dimmed and cannot be
clicked until the top dialog closes (so "Approve" is unreachable while "Reject this bill?" is open). Popovers and toasts stay on top.
```js
var d = ui.drawer({ title: bill.id + ' - ' + bill.vendorName, headerExtra: ui.statusChip(bill.state), body: detail(bill), footer: [rejectBtn, approveBtn] });
ui.confirm({ title: 'Reject this bill?', requireReason: true, reasonLabel: 'Reason for rejection', confirmLabel: 'Reject', tone: 'danger' })
  .then(function (res) { if (!res.ok) return; MK.workflow.bill.reject(bill.id, res.reason); d.close(); ui.toast('Bill rejected', { tone: 'warn' }); });
```

### 3.9 Status and detail blocks
| call | notes |
|---|---|
| `timeline(events, {empty})` | `events[]`: `{actor, role, action, from, to, note, at, tone, icon}`; `from` / `to` are states (chips with an arrow); `at` ISO datetime or epoch ms; tone defaults from `to` |
| `meter({value, max, label, valueLabel, tone, goodWhen, warnAt, criticalAt, target, targetLabel, size: 'sm'})` | `tone: 'auto'` (default) from `value / max`: `goodWhen: 'down'` (budgets) warn >= 0.85, critical > 1.0; `goodWhen: 'up'` (fill rate) critical < 0.85, warn < 0.95. Or force `neutral good warn serious critical`. `target`: 0..1 marker. `valueLabel` defaults to the percentage |
| `callout(tone, title, body, {actions, icon})` | tone `neutral info good warn serious critical`; title or body may be `null` |
| `emptyState(title, body?, {icon, action, compact})` | also `emptyState({title, body, icon, action, compact})` |
| `sourceTag(idOrIds, {prefix}?)` | muted "SOURCE" caption with one pill per source id from `MK.config.sources` (`petpooja`, `swiggy_annexure`, `zomato_settlement`, `erp`, `estimate`). **Put one under every card or table that shows channel data** (pass it as the card footer or append after the chart) |
| `estimateBadge(label?)` | small amber "Estimated" chip. **Place next to any fee, take-rate or payout figure that is not from a settled statement** |
| `notProvided(channelName, note?)` | muted italic "Not provided by Swiggy" + info icon + tooltip. Use wherever `MK.data.can(channel, field)` is false |
| `keyValue(pairs, {cols: 2, stacked})` | pairs `[[label, value]]` or `[{label, value}]`; values may be nodes; `null` values are skipped |
| `steps({items: ['Business', 'Tax ids', 'Bank', 'Review'], current})` | wizard progress, zero-based |
| `errorCard(title, errorOrMessage, hint?)` | what the router shows when a page throws |
| `downloadCsv(filename, columns, rows)` | columns `[{key, label, value(row), csv: false to skip}]` - table column arrays work as is. Raw values, UTF-8 BOM, formula-safe, works on `file://`. Returns the CSV text |

```js
ui.keyValue([['Order', o.id], ['Net sales', MK.fmt.inrFull(o.netSales)],
  ['Customer phone', MK.data.can(o.channelId, 'customerPhone') ? o.customerPhone : ui.notProvided(channelName)]]);
ui.meter({ label: line.category, value: line.committed, max: line.budget, valueLabel: MK.fmt.pct(line.committed / line.budget, 0) + ' of ' + MK.fmt.inr(line.budget) });
ui.timeline(auditEvents.map(function (e) { return { actor: e.userName, role: e.roleLabel, action: e.action, from: e.from, to: e.to, note: e.note, at: e.at }; }));  // field names on the left are fixed; map yours onto them
```

---

## 4. CSS available to pages

Page-specific rules go in `css/pages/<group>.css`, prefixed with the page root class (`.pg-<page id> ...`), colours only as `var(--token)`.

| purpose | classes |
|---|---|
| Grid | `mk-grid` + `mk-grid--1..6` (equal columns) or `mk-grid--12` with children `mk-col-1..12`; `mk-grid--tight` (8px gap), `mk-grid--start` (top-align). 4-6 columns relax below 1180px |
| Flex | `mk-row` (+ `mk-row--wrap`, `--between`, `--end`, `--top`, `--baseline`), `mk-stack` (+ `mk-stack--1/2/3/5/6`), `mk-grow`, `mk-gap-1/2/3/4/6` |
| Spacing | `mk-mt-0/1/2/3/4/6`, `mk-mb-1/2/3/4/6`, `mk-pad-0`, `mk-divider` (hairline `<hr>`-like div) |
| Headings | `mk-h1` 24px, `mk-h2` 18px, `mk-h3` 15px, `mk-eyebrow` (small caps label), `mk-label` |
| Text | `mk-muted` (ink-2; the muted tone for anything a reader must read), `mk-faint` (ink-3; below 4.5:1 on every surface - icons, placeholders and disabled states only, never sentences), `mk-small` 12px, `mk-xs` 11px, `mk-strong`, `mk-num` (tabular figures), `mk-nowrap`, `mk-truncate`, `mk-right`, `mk-center`, `mk-good` / `mk-bad` / `mk-warn` (status ink - always next to an icon or sign), `mk-link`, `mk-sr` (screen-reader only) |
| Table rows | `is-selected`, `is-muted`, `is-strong` via `rowClass` |
| Legend dot | `mk-legend-dot` + inline `style="background: var(--ch-swiggy)"` |

Spacing scale is 4px (`--sp-1..8`), card radius `--radius`, type sizes `--fs-xs..hero`. Do not restyle `mk-*` component classes from page CSS.

## 5. Shell - `MK.app`
`MK.app.resetDemo()` opens the reset confirmation (clear store -> `MK.seed.apply()` -> reload); `MK.app.showBanner(message | '')` sets the slim
warning banner above the top bar. Boot order in `js/app.js`: `MK.engine.run()` (if present and not `MK.engine.ready`), then
`MK.seed.apply()` when the store is not seeded (`MK.seed.isSeeded()` if present, else presence of the `vendors` / `bills` collections),
each inside try/catch; then the shell; then `MK.router.start`. The shell also wires the "Skip to content" link (it focuses `#mk-content`
and never touches the hash) and publishes `--gutter-w`, the width of the content column's scrollbar gutter, which `css/base.css` uses to
give the top bar and the filter row the same measure as the page (24px gutters; past 1440px the same centred column).

## 6. Simulated latency - `MK.latency` (`js/core/latency.js`)

Nothing in the preview is fetched: every figure is computed in the browser before a screen is drawn. `MK.latency` makes the
preview behave the way the product will while its read models answer. After a draw, selected parts are veiled for a short
random time behind a skeleton or a spinner with a caption, then revealed with a fade. The content underneath is real and
already laid out, so nothing jumps.

| When | What is veiled | For how long |
|---|---|---|
| navigation to a screen (router) | stat tiles (skeleton bars under the label), every chart body ("Loading daily net sales"), every table ("Fetching rows"), the Overview headline block ("Loading the headline figures"), "Needs attention" ("Evaluating the rules"), the forecast tiles ("Running the forecast"), suggested purchases ("Planning the purchases") | tile 0.25-0.8 s, chart 0.7-1.9 s, table 0.5-1.3 s, block 0.9-2.0 s, each part its own random delay |
| a filter or persona change | the same parts | 0.6x |
| a chart whose data is swapped by a control or a dial (`controller.update`) | that chart body | 0.45x |
| a dial (forecast reactiveness, safety cover, a rule threshold) | only what it moves, the dial stays in reach | 0.45x |
| a drawer opening on a record (`ui.drawer`; `{loader: false}` for a form, `loaderLabel` for the caption) | the drawer body | 0.35-0.8 s |
| a write to the workflow store | nothing - the progress bar at the top runs for half a second | - |

Any other repaint (a tab, a sort, a local toggle) is instant. The styleguide pages are never veiled.

API: `afterRender(pageEl, {navigated, pageId})` (the router's hook), `veil(rootEl, {profile})`, `part(el, kind, label, profile)`
(returns the delay in ms, 0 when off), `pulse(ms)`, `clear(rootEl)`, `enabled()` / `setEnabled(on)`. Kinds: `tile chart table block
record mini`; profiles: `navigate refresh recalc`. The switch is "Turn off simulated loading" under More options in the top bar
(`prefs.latency`); `?instant` in the URL switches it off for a session.

The veil is CSS only (`.mk-loading` in `css/components.css`): classes and a `data-loading` caption on the element, the shimmer,
spinner and caption in pseudo-elements, so a page may rebuild the content underneath while it is loading. A page that adds a
block of its own calls `MK.latency.part(el, 'block', 'Caption')` after drawing it, or adds a selector to `TARGETS`. Durations
are random on purpose; the data layer stays deterministic and `tools/check-data.js` never loads this file.
