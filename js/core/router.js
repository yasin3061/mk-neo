/*
 * MK.router - hash router, page registry and sidebar navigation.
 * Pages self-register (see docs/UI-API.md); nothing else knows about them. The router owns the page
 * lifecycle: cleanup -> dispose charts -> render, a per-route state object, scroll preservation on
 * re-render, scope / role based visibility, and an error boundary around every render.
 */
(function (root) {
  'use strict';

  var MK = root.MK;
  if (!MK || !MK.ui) return;
  var ui = MK.ui, h = ui.h, doc = root.document;

  var GROUPS = ['Overview', 'Revenue', 'Costs', 'Approvals', 'Vendors', 'Factory', 'Banking', 'System'];
  var PAGE_ICONS = {
    'overview': 'home',
    'revenue-sales': 'chart', 'revenue-timeslots': 'clock', 'revenue-dishes': 'dish', 'revenue-audit': 'shield-check', 'revenue-orders': 'receipt',
    'costs-unit-economics': 'coins', 'costs-cogs': 'scale', 'costs-budget': 'calculator',
    'approvals-bills': 'check-circle', 'approvals-payments': 'wallet', 'approvals-payables': 'calendar',
    'vendors': 'truck',
    'factory-overview': 'factory', 'factory-production': 'layers', 'factory-inventory': 'box',
    'banking': 'bank',
    'audit-trail': 'list', 'data-sources': 'database', 'styleguide': 'grid', 'styleguide-charts': 'chart'
  };
  /* The sidebar is 232px wide: long page titles get a shorter menu label (the full title stays in the top bar). */
  var NAV_LABELS = { 'revenue-audit': 'Tax & commission audit' };
  var RERENDER_MS = 60;
  var APP_NAME = 'Miya Kebabs ERP';

  var pages = [];
  var states = {};           /* route -> plain object that survives re-renders */
  var current = null;        /* {page, params, cleanup} */
  var els = null;            /* {content, page, nav} */
  var started = false;
  var rendering = false;
  var timer = null;
  var resolvedHash = null;   /* hash that produced the current page; lets the hashchange handler skip echoes */

  /* ------------------------------------------------------------ registry */

  function register(def) {
    if (!def || !def.id || !def.route || typeof def.render !== 'function') {
      if (root.console) root.console.error('[MK.router] register() needs id, route and render', def);
      return;
    }
    var page = {
      id: def.id, route: def.route, group: GROUPS.indexOf(def.group) === -1 ? 'System' : def.group,
      title: def.title || def.id, subtitle: def.subtitle || '', icon: def.icon || PAGE_ICONS[def.id] || 'list',
      navLabel: def.navLabel || NAV_LABELS[def.id] || def.title || def.id,
      units: def.units || def.scopes || 'all', roles: Array.isArray(def.roles) && def.roles.length ? def.roles : null,
      nav: def.nav !== false, /* nav: false = routable by URL, no menu item (developer reference pages) */
      filters: Array.isArray(def.filters) ? def.filters.slice() : [], render: def.render
    };
    var at = -1;
    pages.forEach(function (p, i) { if (p.id === page.id) at = i; });
    if (at === -1) pages.push(page); else pages[at] = page;
    if (started) { renderNav(); resolve(); }
  }

  function isAllowed(page, user) {
    var u = user || MK.session.current();
    if (!page) return false;
    if (page.roles && page.roles.indexOf(u.role) === -1) return false;
    if (page.units === 'outlets') return u.unitIds.some(function (id) { return id !== 'factory'; });
    if (page.units === 'factory') return u.unitIds.indexOf('factory') !== -1;
    return true;
  }

  function ordered() {
    return pages.slice().sort(function (a, b) {
      return (GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group)) || (pages.indexOf(a) - pages.indexOf(b));
    });
  }

  function allowedPages(user) { return ordered().filter(function (p) { return isAllowed(p, user); }); }

  /** Where an unknown or forbidden route lands: the first allowed screen of the menu (a nav: false page only as a last resort). */
  function homePage(user) {
    var list = allowedPages(user);
    return list.filter(function (p) { return p.nav; })[0] || list[0] || null;
  }

  function byId(id) { return pages.filter(function (p) { return p.id === id; })[0] || null; }

  /* ------------------------------------------------------------- matching */

  function parseHash(hash) {
    var raw = hash || '';
    var q = raw.indexOf('?');
    var path = (q === -1 ? raw : raw.slice(0, q)).replace(/\/+$/, '');
    var params = {};
    if (q !== -1) {
      raw.slice(q + 1).split('&').forEach(function (pair) {
        if (!pair) return;
        var eq = pair.indexOf('=');
        var k = eq === -1 ? pair : pair.slice(0, eq), v = eq === -1 ? '' : pair.slice(eq + 1);
        try { params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* malformed pair */ }
      });
    }
    return { path: path, params: params };
  }

  function match(path) {
    var best = null;
    pages.forEach(function (p) {
      if (p.route === path) { best = { page: p, rest: [] }; return; }
      if (path.indexOf(p.route + '/') === 0 && (!best || (best.rest.length && p.route.length > best.page.route.length))) {
        best = { page: p, rest: path.slice(p.route.length + 1).split('/').filter(Boolean) };
      }
    });
    return best;
  }

  function buildHash(route, params) {
    var page = route && route.charAt(0) !== '#' ? byId(route) : null;
    var base = page ? page.route : route;
    var query = Object.keys(params || {}).filter(function (k) { return params[k] !== null && params[k] !== undefined && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return base + (query ? '?' + query : '');
  }

  /**
   * navigate('#/approvals/bills') | navigate('approvals-bills', {id: 'B-1042'}) | navigate('vendors', null, {replace: true})
   * replace: true swaps the current history entry (Back then skips the hash being left - used when a deep-linked drawer closes).
   * The route is resolved synchronously, so router.current() is already the new page when navigate() returns and a
   * debounced re-render can never run against the old params; the hashchange echo is ignored through resolvedHash.
   */
  function navigate(route, params, o) {
    var target = buildHash(route, params);
    if (root.location.hash !== target) {
      if (o && o.replace) root.location.replace(target); /* same document: only the fragment changes */
      else root.location.hash = target;
    }
    resolve();
  }

  /* ------------------------------------------------------------ lifecycle */

  function teardown() {
    if (!current) return;
    if (typeof current.cleanup === 'function') {
      try { current.cleanup(); } catch (e) { if (root.console) root.console.error('[MK.router] cleanup failed', e); }
    }
    current.cleanup = null;
    if (els && MK.charts && typeof MK.charts.disposeAll === 'function') {
      try { MK.charts.disposeAll(els.page); } catch (e2) { if (root.console) root.console.error('[MK.router] chart disposal failed', e2); }
    }
  }

  function defaultFilters() {
    var end = MK.calendar.dataEnd;
    return { from: MK.dates.monthStart(end), to: end, outletIds: null, channelIds: null, mediumIds: null, preset: 'thisMonth' };
  }

  /**
   * The filter object a page receives: the global state narrowed to the dimensions the page declared in `filters`.
   * A dimension the page does not honour has no control in the filter bar, so a value left over from another screen
   * (Channel = Swiggy set on the Sales explorer) must not reach it: undeclared dimensions are null, which selectors read as "all".
   */
  function filtersFor(page) {
    var f = MK.filters && typeof MK.filters.get === 'function' ? MK.filters.get() : defaultFilters(); /* a fresh object on every call */
    var honours = page.filters;
    if (honours.indexOf('outlet') === -1) f.outletIds = null;
    if (honours.indexOf('channel') === -1) f.channelIds = null;
    if (honours.indexOf('medium') === -1) f.mediumIds = null;
    if (honours.indexOf('date') === -1) { f.from = null; f.to = null; f.preset = null; }
    return f;
  }

  /* Focus survives a re-render when the same kind of element sits at the same position in the new DOM:
     this is what keeps a search box usable while every keystroke re-renders the page. */
  function markFocus() {
    var a = doc.activeElement;
    if (!a || a === doc.body || a === els.page || !els.page.contains(a)) return null;
    var path = [];
    for (var n = a; n && n !== els.page; n = n.parentNode) path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
    var sel = null;
    try { if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd]; } catch (e) { sel = null; }
    return { path: path, tag: a.tagName, type: a.type, sel: sel };
  }

  function restoreFocus(mark) {
    if (!mark) return;
    var n = els.page;
    for (var i = 0; i < mark.path.length && n; i++) n = n.childNodes[mark.path[i]];
    if (!n || n.tagName !== mark.tag || n.type !== mark.type || typeof n.focus !== 'function') return;
    try {
      n.focus({ preventScroll: true });
      if (mark.sel && typeof n.setSelectionRange === 'function') n.setSelectionRange(mark.sel[0], mark.sel[1]);
    } catch (e) { /* not focusable after all */ }
  }

  function draw(resetScroll) {
    if (!current || !els) return;
    if (rendering) { schedule(); return; }
    rendering = true;
    root.clearTimeout(timer);
    timer = null;
    var page = current.page;
    var keepTop = els.content.scrollTop;
    var focusMark = resetScroll ? null : markFocus();
    /* Hold the height while the page is rebuilt so the scroll position cannot collapse. */
    els.page.style.minHeight = resetScroll ? '' : els.page.offsetHeight + 'px';
    teardown();
    ui.clear(els.page);
    els.page.className = 'mk-page pg-' + page.id;
    var ctx = {
      filters: filtersFor(page),
      user: MK.session.current(),
      params: current.params,
      state: states[page.route] || (states[page.route] = {}),
      navigate: navigate,
      rerender: function () { draw(false); }
    };
    try {
      try {
        var result = page.render(els.page, ctx);
        if (typeof result === 'function') current.cleanup = result;
      } catch (e) {
        /* Page-level error boundary: a tidy card instead of a blank screen. */
        if (root.console) root.console.error('[MK.router] render failed for ' + page.id, e);
        teardown();
        ui.clear(els.page);
        els.page.appendChild(ui.errorCard('"' + page.title + '" could not be drawn', e,
          'The rest of the preview keeps working. Pick another screen from the menu, or use "Reset demo data" in the top-right menu if this persists.'));
      }
      els.page.style.minHeight = '';
      els.content.scrollTop = resetScroll ? 0 : keepTop;
      restoreFocus(focusMark);
      if (typeof ui.closeOrphans === 'function') ui.closeOrphans();
      /* the preview shows the screen arriving: a navigation loads at full length, a filter or persona change shorter (MK.latency) */
      if (MK.latency && typeof MK.latency.afterRender === 'function') MK.latency.afterRender(els.page, { navigated: !!resetScroll, pageId: page.id });
    } finally {
      rendering = false; /* never leave the router locked, whatever happened above */
    }
  }

  function schedule() {
    root.clearTimeout(timer);
    timer = root.setTimeout(function () { timer = null; draw(false); }, RERENDER_MS);
  }

  function restoreHash() {
    if (resolvedHash === null) return;
    try { root.history.replaceState(root.history.state, '', resolvedHash || '#'); }
    catch (e) { root.location.replace(resolvedHash || '#'); } /* fires hashchange, which the echo check above ignores */
  }

  function rememberRoute(hash) {
    var prefs = MK.store.get('prefs', {}) || {};
    if (prefs.lastRoute === hash) return;
    prefs.lastRoute = hash;
    MK.store.set('prefs', prefs);
  }

  function resolve() {
    if (!started) return;
    var parsed = parseHash(root.location.hash);
    var user = MK.session.current();
    var found = match(parsed.path);
    if (!found || !isAllowed(found.page, user)) {
      var fallback = homePage(user);
      if (!fallback) {
        teardown();
        current = null;
        ui.clear(els.page).appendChild(ui.emptyState('No screens are available for this role', 'Switch role from the top-right corner.', { icon: 'lock' }));
        return;
      }
      if (parsed.path !== fallback.route) root.location.replace(fallback.route); /* same-document, no history entry */
      found = { page: fallback, rest: [] };
      parsed = { path: fallback.route, params: {} };
    }
    var params = parsed.params;
    if (found.rest.length) params.path = found.rest;

    resolvedHash = root.location.hash;
    var samePage = !!current && current.page.id === found.page.id;
    if (samePage && JSON.stringify(current.params) === JSON.stringify(params)) { current.page = found.page; draw(false); return; }

    /* The hash is the source of truth: a new page or new params closes every overlay; only a new page resets the scroll.
       `current` moves to the new route BEFORE the overlays close, so an onClose handler can tell why it runs:
       router.current() still carries its record id -> the user closed the drawer; anything else -> navigation did. */
    teardown();
    var next = { page: found.page, params: params, cleanup: null };
    current = next;
    if (typeof ui.closeAll === 'function') ui.closeAll();
    if (current !== next) return; /* an onClose handler navigated on; that navigation has already been resolved and drawn */
    doc.title = found.page.title + ' - ' + APP_NAME;
    markActive();
    rememberRoute(root.location.hash);
    MK.bus.emit('route:changed', { page: found.page, params: params });
    draw(!samePage);
  }

  /* ------------------------------------------------------------------ nav */

  var navLinks = {};

  function markActive() {
    Object.keys(navLinks).forEach(function (id) {
      var on = !!current && current.page.id === id;
      navLinks[id].classList.toggle('is-active', on);
      if (on) navLinks[id].setAttribute('aria-current', 'page'); else navLinks[id].removeAttribute('aria-current');
      if (on) revealInNav(navLinks[id]);
    });
  }

  /** Keep the active item visible when the menu is taller than the window (scrolls the menu only, never the page). */
  function revealInNav(link) {
    var host = els && els.nav;
    if (!host || host.scrollHeight <= host.clientHeight) return;
    var box = link.getBoundingClientRect(), frame = host.getBoundingClientRect();
    if (box.top < frame.top + 8) host.scrollTop -= frame.top + 8 - box.top;
    else if (box.bottom > frame.bottom - 8) host.scrollTop += box.bottom - frame.bottom + 8;
  }

  /** Build (or rebuild) the grouped navigation for the current persona into the container given to start(). */
  function renderNav(container) {
    var host = container || (els && els.nav);
    if (!host) return;
    ui.clear(host);
    navLinks = {};
    var visible = allowedPages().filter(function (p) { return p.nav; });
    GROUPS.forEach(function (group) {
      var inGroup = visible.filter(function (p) { return p.group === group; });
      if (!inGroup.length) return;
      var registered = pages.filter(function (p) { return p.nav && p.group === group; }).length;
      var solo = registered === 1; /* a group that only ever has one screen needs no heading */
      var headingId = 'mk-nav-' + group.toLowerCase();
      host.appendChild(h('div', { 'class': ['mk-nav__group', solo ? 'mk-nav__group--solo' : ''], role: 'group', 'aria-labelledby': solo ? null : headingId, 'aria-label': solo ? group : null },
        solo ? null : h('div', { 'class': 'mk-nav__heading', id: headingId }, group),
        inGroup.map(function (p) {
          var a = h('a', { 'class': 'mk-nav__item', href: p.route, title: p.navLabel !== p.title ? p.title : (p.subtitle || null) }, ui.icon(p.icon), h('span', null, p.navLabel));
          navLinks[p.id] = a;
          return a;
        })));
    });
    markActive();
  }

  /* ---------------------------------------------------------------- start */

  /** start({content, page, nav}) - content is the scrolling region, page the render root inside it, nav the sidebar list. */
  function start(o) {
    if (started) return;
    els = { content: o.content, page: o.page, nav: o.nav };
    started = true;
    renderNav();

    root.addEventListener('hashchange', function () {
      var hash = root.location.hash;
      if (hash === resolvedHash) return; /* echo of a navigation that is already resolved */
      /* A plain fragment ('#mk-content' from a skip link, any in-page anchor) is not a route: keep the screen and put the route back. */
      if (current && hash.length > 1 && hash.indexOf('#/') !== 0) { restoreHash(); return; }
      resolve();
    });
    MK.bus.on('session:changed', function () {
      renderNav();
      if (current && isAllowed(current.page)) schedule(); else resolve();
    });
    MK.bus.on('filters:changed', function () { if (current && current.page.filters.length) schedule(); });
    MK.bus.on('store:changed', function (evt) {
      var key = evt && evt.key;
      if (key === 'prefs' || key === '*') return; /* prefs: role, filters and last route have their own events; '*' is followed by a reload */
      if (current) schedule();
    });

    if (!root.location.hash || root.location.hash === '#') {
      var last = (MK.store.get('prefs', {}) || {}).lastRoute;
      var remembered = last ? match(parseHash(last).path) : null;
      if (remembered && isAllowed(remembered.page)) root.location.replace(last);
    }
    resolve();
  }

  MK.router = {
    GROUPS: GROUPS.slice(),
    register: register,
    start: start,
    navigate: navigate,
    rerender: function () { if (current) draw(false); },
    current: function () { return current ? { page: current.page, params: current.params } : null; },
    pages: function () { return ordered(); },
    allowedPages: allowedPages,
    isAllowed: function (pageOrId, user) { return isAllowed(typeof pageOrId === 'string' ? byId(pageOrId) : pageOrId, user); },
    href: function (id, params) { return buildHash(id, params); },
    renderNav: renderNav
  };
})(window);
