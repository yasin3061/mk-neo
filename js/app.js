/*
 * Boot: prepare the (optional) data layer, build the shell, start the router.
 * Nothing here assumes that a data file or a page file is present - the shell must come up on its own.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  var doc = root.document;
  if (!MK || !MK.ui || !MK.router) {
    if (root.console) root.console.error('[MK.app] kernel, ui or router did not load - check the script tags in index.html');
    return;
  }
  var ui = MK.ui, h = ui.h;

  /* ---------------------------------------------------------- data layer */

  function isSeeded() {
    if (typeof MK.seed.isSeeded === 'function') return !!MK.seed.isSeeded();
    return MK.store.get('c.vendors', null) !== null || MK.store.get('c.bills', null) !== null;
  }

  /** Returns a list of human-readable problems; empty when everything that exists ran cleanly. */
  function prepareData() {
    var problems = [];
    /* The simulation runs first: the seed is allowed to read finance figures that depend on it. */
    if (MK.engine && typeof MK.engine.run === 'function' && !(MK.engine.ready === true || (MK.db && MK.db.ready === true))) {
      try { MK.engine.run(); }
      catch (e) { problems.push('the sales simulation stopped (' + (e && e.message ? e.message : e) + ')'); if (root.console) root.console.error('[MK.app] engine.run failed', e); }
    }
    if (MK.seed && typeof MK.seed.apply === 'function') {
      try { if (!isSeeded()) MK.seed.apply(); }
      catch (e2) { problems.push('the workflow seed could not be written (' + (e2 && e2.message ? e2.message : e2) + ')'); if (root.console) root.console.error('[MK.app] seed.apply failed', e2); }
    }
    return problems;
  }

  function showBanner(message) {
    var el = doc.getElementById('mk-banner');
    if (!el) return;
    ui.clear(el);
    if (!message) { el.hidden = true; return; }
    ui.append(el, ui.icon('alert-triangle', 14), h('span', null, message));
    el.hidden = false;
  }

  function resetDemo() {
    return ui.confirm({
      title: 'Reset demo data?',
      message: 'Bills, payment batches, vendors and the audit trail go back to the original demo state. Filters and the selected role are cleared too. This cannot be undone.',
      confirmLabel: 'Reset and reload', tone: 'danger'
    }).then(function (res) {
      if (!res.ok) return false;
      MK.store.resetAll();
      if (MK.seed && typeof MK.seed.apply === 'function') {
        try { MK.seed.apply(); } catch (e) { if (root.console) root.console.error('[MK.app] reseed failed', e); }
      }
      root.location.reload();
      return true;
    });
  }

  /* --------------------------------------------------------------- shell */

  function buildSidebar(sidebar) {
    var nav = h('nav', { 'class': 'mk-nav', 'aria-label': 'Screens' });
    ui.append(ui.clear(sidebar),
      h('div', { 'class': 'mk-brand' },
        h('div', { 'class': 'mk-brand__mark', 'aria-hidden': 'true' }, 'MK'),
        h('div', { 'class': 'mk-brand__text' },
          h('div', { 'class': 'mk-brand__name' }, 'Miya Kebabs'),
          h('div', { 'class': 'mk-brand__tag' }, 'ERP preview'))),
      nav,
      h('div', { 'class': 'mk-sidebar__foot' }, ui.icon('info', 14), h('span', null, 'Demo dataset - figures are illustrative')));
    return nav;
  }

  function buildTopbar(topbar) {
    var crumb = h('div', { 'class': 'mk-topbar__crumb' });
    var title = h('h1', { 'class': 'mk-topbar__title' });

    var roleBtn = h('button', { type: 'button', 'class': 'mk-role', onClick: openRoleMenu });
    function paintRole() {
      var u = MK.session.current();
      ui.append(ui.clear(roleBtn),
        ui.avatar(u.initials, { accent: true }),
        h('span', { 'class': 'mk-role__text' }, h('span', { 'class': 'mk-role__name' }, u.name), h('span', { 'class': 'mk-role__label' }, u.roleLabel)),
        ui.icon('chevron-down', 14));
      roleBtn.setAttribute('aria-label', 'Viewing as ' + u.name + ', ' + u.roleLabel + '. Switch role');
    }
    function openRoleMenu() {
      var me = MK.session.current();
      var items = [{ heading: 'View the preview as' }].concat(MK.session.users.map(function (u) {
        return { label: u.name, sub: u.roleLabel, avatar: u.initials, selected: u.id === me.id, onSelect: function () {
          if (u.id === MK.session.current().id) return;
          MK.session.set(u.id);
          ui.toast('Numbers, menus and permitted actions now follow this role.', { title: 'Viewing as ' + u.name + ' - ' + u.roleLabel, tone: 'info' });
        } };
      }));
      ui.menu(roleBtn, items, { align: 'right', width: 280 });
    }

    var moreBtn = ui.iconButton('more', 'More options', function () {
      var on = !!(MK.latency && MK.latency.enabled());
      ui.menu(moreBtn, [
        MK.latency ? { label: (on ? 'Turn off' : 'Turn on') + ' simulated loading', sub: on ? 'Screens and charts appear at once' : 'Loaders while screens and charts fetch their data', icon: 'clock',
          onSelect: function () { MK.latency.setEnabled(!on); ui.toast(on ? 'Simulated loading is off: screens appear at once' : 'Simulated loading is on'); } } : null,
        { label: 'Reset demo data', sub: 'Restore the original workflow state', icon: 'refresh', danger: true, onSelect: function () { resetDemo(); } }
      ].filter(Boolean), { align: 'right', width: 280 });
    });

    var asOf = MK.dates.label(MK.calendar.dataEnd, 'd MMM yyyy');
    ui.append(ui.clear(topbar),
      h('div', { 'class': 'mk-topbar__titles' }, crumb, title),
      h('div', { 'class': 'mk-topbar__right' },
        h('span', { 'class': 'mk-stamp', title: 'The demo dataset is frozen at this date (' + MK.calendar.fyLabel + ')' }, ui.icon('clock', 14), 'Data as of ', h('strong', null, asOf)),
        roleBtn, moreBtn));
    paintRole();
    MK.bus.on('session:changed', paintRole);

    return function setPage(page) {
      crumb.textContent = page.group !== page.title ? page.group : '';
      crumb.hidden = !crumb.textContent;
      ui.append(ui.clear(title), page.title, page.subtitle ? h('small', null, page.subtitle) : null);
    };
  }

  /**
   * "Skip to content" moves keyboard focus into the content column. It must not change the hash: in a hash-routed app
   * '#mk-content' would read as an unknown route (the router also ignores plain fragments, as a second line of defence).
   */
  function wireSkipLink(content) {
    var skip = doc.querySelector('.mk-skip');
    if (!skip || !content) return;
    skip.addEventListener('click', function (e) {
      e.preventDefault();
      content.focus();
    });
  }

  /**
   * The content column reserves a scrollbar gutter; the top bar and the filter row do not scroll. Publishing the gutter
   * width lets css/base.css give the bars exactly the same measure as the page, so titles, filters and cards line up
   * at every window width (including past 1440px, where the page is centred).
   */
  function syncGutter(content) {
    if (!content) return;
    function measure() { doc.documentElement.style.setProperty('--gutter-w', Math.max(0, content.offsetWidth - content.clientWidth) + 'px'); }
    measure();
    root.addEventListener('resize', measure); /* browser zoom changes the scrollbar's CSS width and fires resize */
  }

  function boot() {
    var problems = prepareData();

    var nav = buildSidebar(doc.getElementById('mk-sidebar'));
    var setPage = buildTopbar(doc.getElementById('mk-topbar'));
    var filterBar = doc.getElementById('mk-filterbar');
    var content = doc.getElementById('mk-content');
    wireSkipLink(content);
    syncGutter(content);

    MK.bus.on('route:changed', function (evt) {
      setPage(evt.page);
      if (MK.filters && typeof MK.filters.mountBar === 'function') MK.filters.mountBar(filterBar, evt.page.filters);
      else filterBar.hidden = true;
    });

    if (problems.length) showBanner('The demo data could not be prepared completely: ' + problems.join('; ') + '. Some screens may be empty.');

    MK.router.start({ content: content, page: doc.getElementById('mk-page'), nav: nav });
  }

  MK.app = { resetDemo: resetDemo, showBanner: showBanner };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
