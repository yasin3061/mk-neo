/*
 * UI kit reference (#/system/styleguide). Every component of MK.ui with believable restaurant-finance content.
 * The sample figures on this page are typed inline on purpose: it documents the kit, it is not a data screen.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.router || !MK.ui) return;
  var ui = MK.ui, h = ui.h, fmt = MK.fmt;

  var OUTLETS = [
    { outlet: 'Bandra', city: 'Mumbai', sales: 3284000, growth: 0.062, foodCost: 0.318, ebitda: 0.214, take: 0.287, status: 'OK', trend: [92, 96, 101, 99, 104, 109, 112] },
    { outlet: 'Andheri', city: 'Mumbai', sales: 2716000, growth: 0.041, foodCost: 0.327, ebitda: 0.118, take: 0.341, status: 'WATCH', trend: [80, 84, 83, 88, 87, 90, 93] },
    { outlet: 'Fort', city: 'Mumbai', sales: 1942000, growth: -0.018, foodCost: 0.309, ebitda: 0.163, take: 0.262, status: 'OK', trend: [66, 64, 67, 63, 65, 62, 64] },
    { outlet: 'Kalyan', city: 'Mumbai', sales: 1608000, growth: 0.087, foodCost: 0.358, ebitda: 0.096, take: 0.279, status: 'RISK', trend: [44, 47, 49, 52, 51, 55, 58] },
    { outlet: 'Koregaon Park', city: 'Pune', sales: 1187000, growth: 0.143, foodCost: 0.334, ebitda: 0.021, take: 0.294, status: 'WATCH', trend: [28, 31, 35, 34, 39, 42, 46] }
  ];

  var BILLS = [
    { id: 'BL-1042', vendor: 'Al-Noor Poultry Suppliers', unit: 'Factory', category: 'Raw material - chicken', amount: 486200, due: '2026-09-19', state: 'UNDER_REVIEW' },
    { id: 'BL-1041', vendor: 'Adani Electricity Mumbai', unit: 'Bandra', category: 'Electricity', amount: 84350, due: '2026-09-22', state: 'SUBMITTED' },
    { id: 'BL-1038', vendor: 'Shree Packaging Co.', unit: 'Andheri', category: 'Packaging and tissue', amount: 38900, due: '2026-09-18', state: 'APPROVED' },
    { id: 'BL-1033', vendor: 'Mahanagar Gas Ltd', unit: 'Factory', category: 'Gas and fuel', amount: 61240, due: '2026-09-12', state: 'IN_BATCH' },
    { id: 'BL-1029', vendor: 'Konkan Cold Chain Logistics Private Limited', unit: 'Koregaon Park', category: 'Logistics', amount: 72800, due: '2026-09-10', state: 'REJECTED' }
  ];

  var ALL_STATES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'IN_BATCH', 'PAID', 'PENDING_RELEASE', 'RELEASED',
    'VERIFYING', 'VERIFIED', 'NEEDS_REVIEW', 'MATCHED', 'SHORT_PAID', 'PENDING', 'DISPUTED', 'OK', 'WATCH', 'RISK', 'WITHIN', 'NEAR', 'OVER'];

  var AUDIT = [
    { actor: 'Neha Kulkarni', role: 'Finance checker', action: 'Bill approved', from: 'UNDER_REVIEW', to: 'APPROVED', at: '2026-09-16T17:42', note: 'Rate matches the August contract. Quantity tallies with factory GRN 2214.' },
    { actor: 'Neha Kulkarni', role: 'Finance checker', action: 'Review started', from: 'SUBMITTED', to: 'UNDER_REVIEW', at: '2026-09-16T17:05' },
    { actor: 'Rohit Pawar', role: 'Finance maker', action: 'Bill submitted', from: 'DRAFT', to: 'SUBMITTED', at: '2026-09-16T11:18', note: 'Invoice AN/26-27/0913 attached. TDS not applicable (goods).' },
    { actor: "Joseph D'Souza", role: 'Factory manager', action: 'Draft raised', at: '2026-09-15T19:30' }
  ];

  function section(title, sub, children) {
    return ui.stack([ui.sectionTitle(title, sub), children], 3);
  }

  function sampleDrawer() {
    var d = ui.drawer({
      title: 'BL-1042 - Al-Noor Poultry Suppliers', subtitle: 'Raw material - chicken - Factory', headerExtra: ui.statusChip('UNDER_REVIEW'), width: 540,
      body: [
        ui.keyValue([['Invoice number', 'AN/26-27/0913'], ['Invoice date', '14 Sep 2026'], ['Taxable value', fmt.inrFull(463048)], ['GST 5%', fmt.inrFull(23152)],
          ['Bill total', h('strong', null, fmt.inrFull(486200))], ['Due date', '19 Sep 2026'], ['Attachment', h('span', { 'class': 'mk-row mk-gap-1' }, ui.icon('paperclip', 14), 'invoice-0913.pdf')]]),
        ui.callout('warn', 'Budget impact', 'Approving this bill takes raw material - chicken to 93% of the September budget for the factory.'),
        ui.meter({ label: 'Raw material - chicken, September', value: 0.93, max: 1, valueLabel: '93% of ' + fmt.inr(3850000) }),
        h('div', null, h('h4', { 'class': 'mk-h3 mk-mb-3' }, 'Activity'), ui.timeline(AUDIT.slice(1)))
      ],
      footer: [
        ui.button({ label: 'Reject', variant: 'danger', onClick: function () {
          ui.confirm({ title: 'Reject this bill?', message: 'The maker gets it back as a draft with your reason.', confirmLabel: 'Reject bill', tone: 'danger', requireReason: true, reasonLabel: 'Reason for rejection' })
            .then(function (res) { if (res.ok) { d.close(); ui.toast(res.reason, { title: 'Bill rejected', tone: 'critical' }); } });
        } }),
        ui.button({ label: 'Approve', variant: 'primary', icon: 'check', onClick: function () { d.close(); ui.toast('BL-1042 is ready for the next payment batch.', { title: 'Bill approved', tone: 'good' }); } })
      ]
    });
  }

  function sampleModal() {
    var amount = ui.form.moneyInput({ value: 250000 });
    var m = ui.modal({
      title: 'Record payment reference', subtitle: 'Batch PB-0031 - 6 bills - HDFC Bank current account',
      body: ui.form.group([
        ui.form.row([
          ui.form.field({ label: 'UTR number', required: true, control: ui.form.input({ placeholder: 'HDFCR52026091600123456', mono: true }) }),
          ui.form.field({ label: 'Value date', control: ui.form.dateInput({ value: '2026-09-16', min: '2026-04-01', max: '2026-09-16' }) })
        ]),
        ui.form.field({ label: 'Amount paid', control: amount, hint: 'Whole rupees. The batch total is ' + fmt.inrFull(250000) + '.' })
      ]),
      footer: [ui.button({ label: 'Cancel', variant: 'ghost', onClick: function () { m.close(); } }),
        ui.button({ label: 'Save reference', variant: 'primary', onClick: function () { m.close(); ui.toast('Recorded ' + fmt.inrFull(amount.getValue() || 0) + ' against PB-0031.', { tone: 'good' }); } })]
    });
  }

  function render(rootEl, ctx) {
    var st = ctx.state;
    st.tab = st.tab || 'review';
    st.measure = st.measure || 'sales';

    rootEl.appendChild(ui.callout('info', 'Living reference for page authors',
      'Everything below is built with MK.ui exactly as documented in docs/UI-API.md. Figures on this page are typed samples, not the demo dataset. ' +
      'This page and the chart kit are not in the menu; they open by URL only.',
      { actions: ui.link('Chart kit', '#/system/styleguide-charts', { icon: 'arrow-right' }) }));

    /* hero and tiles */
    rootEl.appendChild(section('Hero figure and stat tiles', 'One hero per page; tiles carry a delta with an arrow, never colour alone',
      ui.grid([4, 8], [
        ui.card({ body: ui.hero({ label: 'Net sales, 1 - 16 Sep 2026', value: fmt.inr(10737000), delta: { label: '+5.4%', dir: 'up' }, deltaNote: 'vs 16 - 31 Aug', sub: '14,920 orders across 5 outlets' }) }),
        ui.kpiRow([
          { label: 'Orders', value: fmt.num(14920), delta: { label: '+3.1%', dir: 'up' }, spark: [880, 910, 905, 960, 1010, 940, 990], icon: 'receipt' },
          { label: 'Average order value', value: fmt.inrFull(720), delta: { label: '-1.2%', dir: 'down' }, sub: 'vs prev period' },
          { label: 'Aggregator take rate', value: fmt.pct(0.302), delta: { label: '+1.4 pts', dir: 'up' }, goodWhen: 'down', tone: 'warn', title: 'Commission, fees, ads and discounts as a share of aggregator sales' },
          { label: 'Food cost', value: fmt.pct(0.326), delta: { label: '-0.6 pts', dir: 'down' }, goodWhen: 'down' },
          { label: 'Bills awaiting approval', value: '7', sub: fmt.inr(1284000) + ' in value', onClick: function () { ui.toast('A clickable tile navigates to the screen that explains it.'); } },
          { label: 'Payables due in 7 days', value: fmt.inr(2146000), delta: { label: '0.0%', dir: 'flat' } }
        ])
      ])));

    /* buttons and chips */
    rootEl.appendChild(section('Buttons, chips and workflow states', null, ui.grid(2, [
      ui.card({ title: 'Buttons', subtitle: 'One primary action per view; blocked actions stay visible and say why', body: ui.stack([
        ui.row([ui.button({ label: 'Approve bill', variant: 'primary', icon: 'check' }), ui.button({ label: 'Export CSV', icon: 'download' }), ui.button({ label: 'Reject', variant: 'danger' }),
          ui.button({ label: 'Cancel', variant: 'ghost' }), ui.button({ label: 'View bills behind this line', variant: 'text' })], { wrap: true }),
        ui.row([ui.button({ label: 'New bill', variant: 'primary', icon: 'plus', size: 'sm' }), ui.button({ label: 'Filter', icon: 'filter', size: 'sm' }), ui.iconButton('edit', 'Edit'), ui.iconButton('more', 'More'),
          ui.button({ label: 'Release batch', variant: 'primary', disabledReason: 'Segregation of duties: you cannot act on your own submission' }), ui.button({ label: 'Disabled', disabled: true })], { wrap: true })
      ], 3) }),
      ui.card({ title: 'Chips', subtitle: 'statusChip() maps every workflow, payout and health state to tone + icon + label', body: ui.stack([
        ui.row(ALL_STATES.map(function (s) { return ui.statusChip(s); }), { wrap: true }),
        ui.row([ui.chip('Mumbai'), ui.chip('Petpooja POS', null, { dotVar: '--ch-petpooja' }), ui.chip('Swiggy', null, { dotVar: '--ch-swiggy' }), ui.chip('Zomato', null, { dotVar: '--ch-zomato' }),
          ui.chip('TDS - contractor / transport', 'info'), ui.chip('Simulated in this mockup', 'neutral', { icon: 'info', outline: true })], { wrap: true })
      ], 3) })
    ])));

    /* tables */
    var scorecardCols = [
      { key: 'outlet', label: 'Outlet', render: ui.cells.twoLine('city'), sortable: true },
      { key: 'sales', label: 'Net sales', format: 'inr', render: ui.cells.bar(null, '--series-1'), sortable: true, width: 220 },
      { key: 'growth', label: 'Growth', align: 'right', render: ui.cells.delta('up'), sortable: true },
      { key: 'foodCost', label: 'Food cost %', format: 'pct', render: ui.cells.heat(0.30, 0.37), sortable: true },
      { key: 'take', label: 'Take rate %', format: 'pct', render: ui.cells.heat(0.25, 0.35), sortable: true },
      { key: 'ebitda', label: 'EBITDA %', format: 'pct', sortable: true },
      { key: 'trend', label: '7-day trend', render: ui.cells.spark('--series-1') },
      { key: 'status', label: 'Status', render: ui.cells.status() }
    ];
    var billCols = [
      { key: 'id', label: 'Bill' },
      /* the long text of the table lives in one two-line cell with a width limit, so every row stays two lines tall at any card width */
      { key: 'vendor', label: 'Vendor', render: ui.cells.twoLine(function (row) { return row.category + ' - ' + row.unit; }, { maxWidth: 190 }) },
      { key: 'amount', label: 'Amount', format: 'inrFull' }, { key: 'due', label: 'Due', format: 'date' }, { key: 'state', label: 'State', render: ui.cells.status() }
    ];
    rootEl.appendChild(section('Tables', 'Click a header to sort; numerics are right-aligned with tabular figures', ui.stack([
      ui.card({ title: 'Outlet scorecard', subtitle: 'Inline bars for magnitude, heat cells on the blue ramp, delta and status cells', flush: true,
        actions: ui.button({ label: 'CSV', icon: 'download', size: 'sm', onClick: function () { ui.downloadCsv('outlet-scorecard-sample.csv', scorecardCols.slice(0, 6), OUTLETS); } }),
        body: ui.table({ columns: scorecardCols, rows: OUTLETS, sort: st.sort || { key: 'sales', dir: 'desc' }, onSort: function (s) { st.sort = s; },
          footer: { outlet: 'All outlets', sales: 10737000, foodCost: 0.326, take: 0.302, ebitda: 0.142 } }) }),
      ui.grid([8, 4], [
        ui.card({ title: 'Dense table with clickable rows', subtitle: 'Rows are focusable; Enter opens the record. Cells stay on one line; long names truncate with a tooltip', flush: true,
          body: ui.table({ columns: billCols, rows: BILLS, dense: true, sortable: true, maxHeight: 220, onRowClick: function () { sampleDrawer(); } }) }),
        ui.card({ title: 'Empty table', flush: true, body: ui.table({ columns: billCols.slice(0, 3), rows: [], empty: 'No bills match these filters' }) })
      ])
    ], 4)));

    /* tabs, segmented, select */
    var tabPanel = h('div', { 'class': 'mk-muted mk-small' }, 'Selected tab: ' + st.tab + ' - the router keeps this in ctx.state across re-renders.');
    rootEl.appendChild(section('Tabs, segmented control and select', null, ui.card({ body: ui.stack([
      ui.tabs({ items: [{ id: 'review', label: 'Awaiting review', count: 7 }, { id: 'approved', label: 'Approved', count: 12 }, { id: 'paid', label: 'Paid', count: 148 }, { id: 'rejected', label: 'Rejected', count: 2 }],
        value: st.tab, onChange: function (id) { st.tab = id; tabPanel.textContent = 'Selected tab: ' + id + ' - the router keeps this in ctx.state across re-renders.'; } }),
      tabPanel,
      ui.row([
        ui.segmented({ ariaLabel: 'Measure', value: st.measure, options: [{ value: 'sales', label: 'Net sales' }, { value: 'orders', label: 'Orders' }, { value: 'aov', label: 'AOV' }], onChange: function (v) { st.measure = v; } }),
        ui.segmented({ ariaLabel: 'Grain', size: 'sm', value: 'week', options: [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] }),
        ui.select({ ariaLabel: 'Month', value: '2026-09', options: [{ value: '2026-09', label: 'September 2026' }, { value: '2026-08', label: 'August 2026' }, { value: '2026-07', label: 'July 2026' }] }),
        ui.form.search({ placeholder: 'Search vendors', width: 220 })
      ], { wrap: true, gap: 3 })
    ], 4) })));

    /* forms */
    var gstin = ui.form.input({ value: '27AAFCM1234K1Z', placeholder: '27AAAAA0000A1Z5', mono: true, maxLength: 15 });
    var gstField = ui.form.field({ label: 'GSTIN', required: true, control: gstin, hint: '15 characters; the PAN sits inside positions 3 to 12' });
    gstField.setError('GSTIN must be 15 characters - 14 entered');
    var ifscField = ui.form.field({ label: 'IFSC', control: ui.form.input({ value: 'HDFC0000542', mono: true, maxLength: 11 }) });
    ifscField.setOk('Format is valid - HDFC Bank');
    rootEl.appendChild(section('Form fields', 'Labels are bound to inputs; errors are inline, under the field', ui.card({ body: ui.form.group([
      ui.form.row([
        ui.form.field({ label: 'Vendor legal name', required: true, control: ui.form.input({ value: 'Al-Noor Poultry Suppliers' }) }),
        gstField, ifscField
      ], 3),
      ui.form.row([
        ui.form.field({ label: 'Bill amount', required: true, control: ui.form.moneyInput({ value: 486200 }), hint: 'Formats with Indian digit grouping when you leave the field' }),
        ui.form.field({ label: 'Invoice date', control: ui.form.dateInput({ value: '2026-09-14', min: '2026-04-01', max: '2026-09-16' }) }),
        ui.form.field({ label: 'Expense category', control: ui.form.select({ value: 'rm', options: [{ value: 'rm', label: 'Raw material - chicken' }, { value: 'pk', label: 'Packaging and tissue' }, { value: 'el', label: 'Electricity' }, { value: 'rent', label: 'Rent' }] }) })
      ], 3),
      ui.form.field({ label: 'Note to the checker', optional: true, control: ui.form.textarea({ placeholder: 'Anything the approver should know', rows: 2 }) }),
      ui.form.checkbox({ label: 'TDS applies to this bill (contractor / transport)', checked: true })
    ]) })));

    /* overlays */
    rootEl.appendChild(section('Drawer, modal, confirm, menu and toasts', 'Esc closes the top layer; focus is trapped inside dialogs and returns to the trigger', ui.card({ body: ui.row([
      ui.button({ label: 'Open review drawer', icon: 'external', onClick: sampleDrawer }),
      ui.button({ label: 'Open modal', onClick: sampleModal }),
      ui.button({ label: 'Confirm with reason', onClick: function () {
        ui.confirm({ title: 'Override verification?', message: 'The bank name match for this vendor is low (62%). Approving makes the vendor payable.', confirmLabel: 'Approve vendor', requireReason: true })
          .then(function (res) { ui.toast(res.ok ? 'Override recorded: ' + res.reason : 'Nothing was changed.', { tone: res.ok ? 'good' : 'info' }); });
      } }),
      (function () {
        var btn = ui.button({ label: 'Row menu', iconRight: 'chevron-down', onClick: function () {
          ui.menu(btn, [{ label: 'Open vendor profile', icon: 'user' }, { label: 'Download CSV', icon: 'download' },
            { label: 'Edit bill', icon: 'edit', disabled: true, title: 'Only drafts can be edited' }, { separator: true }, { label: 'Withdraw bill', icon: 'trash', danger: true }]);
        } });
        return btn;
      })(),
      ui.button({ label: 'Toast: success', variant: 'ghost', onClick: function () { ui.toast('Batch PB-0031 sent to the director for release.', { title: 'Batch submitted', tone: 'good' }); } }),
      ui.button({ label: 'Toast: warning', variant: 'ghost', onClick: function () { ui.toast('Invoice AN/26-27/0913 already exists for this vendor.', { title: 'Possible duplicate', tone: 'warn' }); } }),
      ui.button({ label: 'Toast: error', variant: 'ghost', onClick: function () { ui.toast('Only approved vendors can be billed.', { tone: 'critical' }); } })
    ], { wrap: true }) })));

    /* timeline, meters, callouts */
    rootEl.appendChild(section('Timeline, meters and callouts', null, ui.grid(3, [
      ui.card({ title: 'Audit timeline', subtitle: 'Actor, role, action, from and to state, note, time', body: ui.timeline(AUDIT) }),
      ui.card({ title: 'Meters', subtitle: 'Tone by threshold; the track is a lighter step of the same ramp', body: ui.stack([
        ui.meter({ label: 'Rent - Bandra', value: 412000, max: 425000, valueLabel: '97% of ' + fmt.inr(425000) }),
        ui.meter({ label: 'Packaging and tissue - Andheri', value: 68400, max: 60000, valueLabel: '114% of ' + fmt.inr(60000) }),
        ui.meter({ label: 'Staff cost - Fort', value: 0.61, max: 1, valueLabel: '61%' }),
        ui.meter({ label: 'Fill rate to Pune', value: 0.91, max: 1, goodWhen: 'up', target: 0.97, targetLabel: 'Target 97%' }),
        ui.meter({ label: 'Factory capacity used', value: 0.74, max: 1, tone: 'neutral', size: 'sm' })
      ], 4) }),
      ui.stack([
        ui.callout('critical', 'Payout short-paid', 'Zomato paid ' + fmt.inrFull(18420) + ' less than expected for Andheri, week of 7 Sep.', { actions: ui.button({ label: 'Open', size: 'sm' }) }),
        ui.callout('warn', 'Possible duplicate invoice', 'Invoice number AN/26-27/0913 was already submitted on 12 Sep.'),
        ui.callout('good', 'All pre-checks passed', 'GSTIN checksum, embedded PAN and IFSC format are valid.'),
        ui.callout('info', 'Simulated in this mockup', 'Registry lookup and penny-drop results are generated, not fetched.'),
        ui.callout('neutral', null, 'Aggregator orders: GST is collected and paid by the aggregator under section 9(5).')
      ], 2)
    ])));

    /* small parts */
    rootEl.appendChild(section('Key-value, not provided, steps, empty and error states', null, ui.grid(2, [
      ui.card({ title: 'Order detail, channel aware', subtitle: 'Fields a channel does not share are said so, never guessed', body: ui.keyValue([
        ['Order', 'ZO-7741920385'], ['Channel', ui.chip('Zomato', null, { dotVar: '--ch-zomato' })], ['Items', 'Chicken Seekh Kebab x2, Roomali Roti x4'],
        ['Net sales', fmt.inrFull(742)], ['Customer name', ui.notProvided('Zomato')], ['Customer phone', ui.notProvided('Zomato')], ['Rider wait time', ui.notProvided('Zomato')]
      ]) }),
      ui.stack([
        ui.card({ title: 'Wizard steps', body: ui.steps({ items: ['Business', 'Tax ids', 'Bank account', 'Review'], current: 2 }) }),
        ui.card({ title: 'Summary strip', body: ui.keyValue([['Vendors', '64'], ['Payable', '58'], ['Needs review', '3'], ['Average payment days', '21']], { stacked: true }) })
      ], 4),
      ui.card({ body: ui.emptyState('No payment batches yet', 'Approved bills that are due appear here once the payer builds a batch.', { icon: 'wallet', action: ui.button({ label: 'Build a batch', variant: 'primary', icon: 'plus' }) }) }),
      ui.errorCard('"Sales explorer" could not be drawn', new Error("Cannot read properties of undefined (reading 'summary')"), 'This is what the router shows when a page throws while rendering.')
    ])));

    /* icons */
    rootEl.appendChild(section('Icons', 'MK.ui.icon(name) - inline SVG, 16px, stroke 1.75, inherits the text colour', ui.card({ body:
      h('div', { 'class': 'mk-grid mk-grid--6 mk-grid--tight' }, ui.iconNames().map(function (name) {
        return h('div', { 'class': 'mk-row mk-small mk-muted' }, h('span', { style: { color: 'var(--ink)' }, 'class': 'mk-row' }, ui.icon(name)), name);
      })) })));
  }

  /* nav: false - a developer reference with typed sample figures: reachable by URL, never listed in the client-facing menu */
  MK.router.register({
    id: 'styleguide', route: '#/system/styleguide', group: 'System', title: 'UI kit', nav: false,
    subtitle: 'Living reference of the shell components', units: 'all', roles: null, filters: [], render: render
  });
})(window);
