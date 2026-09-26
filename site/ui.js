'use strict';

/* Ладога · рыболовная карта — the shell (design/UX_SPEC.md §4–6, §14): the layout class for phone, phone on
   its side, tablet and computer; one stack of everything open over the map, tied to the browser history so
   Android «Назад», the iPhone swipe, Esc and the mouse back button close exactly one thing; sections, the card,
   sheets, map buttons, keyboard, day and night palettes, start-up. */

/* ---------- layout (the class itself: layoutClass() in app.js) ---------- */
const isCompact = () => document.body.dataset.layout === 'compact';
// The part of the map not covered by the card, a page panel, the navigation bars or the map buttons.
function mapFreeRect() {
  const c = map.getContainer().getBoundingClientRect();
  const r = { left: 0, top: 0, right: c.width, bottom: c.height };
  for (const id of ['card', 'page', 'navTop', 'navBottom']) {
    const el = document.getElementById(id);
    if (!el || el.hidden) continue;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const L0 = b.left - c.left, T0 = b.top - c.top, R0 = b.right - c.left, B0 = b.bottom - c.top;
    if (R0 <= 1 || L0 >= c.width - 1 || B0 <= 1 || T0 >= c.height - 1) continue;
    if (b.width >= c.width * 0.6) { if (T0 <= 1) r.top = Math.max(r.top, B0); else r.bottom = Math.min(r.bottom, T0); }
    else if (L0 <= 1) r.left = Math.max(r.left, R0);
    else r.right = Math.min(r.right, L0);
  }
  const mode = document.body.dataset.mode;
  if (mode !== 'nav') {
    const top = $('.mu-top'), right = $('.mu-right');
    if (top && mode !== 'full' && getComputedStyle(top).display !== 'none') {
      const b = top.getBoundingClientRect();
      if (b.height && b.left - c.left < r.right - 100) r.top = Math.max(r.top, b.bottom - c.top + 8);
    }
    if (right) { const b = right.getBoundingClientRect(); if (b.width && b.left - c.left > r.left + 100) r.right = Math.min(r.right, b.left - c.left - 8); }
  } else r.top += 8;
  if (r.right - r.left < 120 || r.bottom - r.top < 120) return { left: 0, top: 0, right: c.width, bottom: c.height };
  return r;
}
function fitPadding(maxZoom = 15) {
  const fr = mapFreeRect(), size = map.getSize();
  return { paddingTopLeft: [fr.left + 20, fr.top + 20], paddingBottomRight: [size.x - fr.right + 20, size.y - fr.bottom + 20], maxZoom };
}
// Pan so a place sits in the free part of the map (above the card on a phone, beside the panel elsewhere).
function keepInView(lat, lon) {
  const fr = mapFreeRect();
  const p = map.latLngToContainerPoint([lat, lon]);
  const m = 56;
  if (p.x > fr.left + m && p.x < fr.right - m && p.y > fr.top + m && p.y < fr.bottom - m) return;
  const want = L.point((fr.left + fr.right) / 2, (fr.top + fr.bottom) / 2);
  const size = map.getSize();
  map.panTo(map.containerPointToLatLng(L.point(size.x / 2, size.y / 2).add(p.subtract(want))), { animate: true });
}

/* ---------- the stack: cards, sheets, pages and modes are history entries ---------- */
const ui = { stack: [], seq: 0, endingNav: false, closingAll: false, backPending: 0, sub: {}, lastPage: null, notices: [] };
const shown = { page: '', pageLayer: null, card: 0, cardLayer: null, modal: 0 };
const topLayer = () => ui.stack[ui.stack.length - 1] || null;
const attachedCount = () => ui.stack.filter((l) => l.attached).length;
const baseUrl = () => location.pathname + location.search;
// A close handler that fails must not leave the interface half-closed (26.09.2026: the month show stayed on after ✕,
// its handler had thrown): the rest of the closing goes on, and the error still reaches the work log a moment later.
function runClose(l, info) {
  try { l.onClose?.(l, info); } catch (e) { setTimeout(() => { throw e; }); }
}
function openLayer(layer, { replace = false, detached = false } = {}) {
  layer.id = ++ui.seq;
  const top = topLayer();
  // Where the keyboard was: back there when the layer closes (a closed sheet left the focus nowhere, and Tab started
  // from the end of the page — the desktop keys check, 26.09.2026). A layer that replaces another takes its place.
  const act = document.activeElement;
  layer.returnFocus = replace && top ? top.returnFocus : act && act !== document.body ? act : null;
  if (replace && top) {
    ui.stack.pop();
    runClose(top, { replaced: true });
    layer.attached = top.attached;
    ui.stack.push(layer);
    if (layer.attached) history.replaceState({ l: attachedCount() }, '', layer.url || baseUrl());
  } else {
    layer.attached = !detached;
    ui.stack.push(layer);
    if (layer.attached) history.pushState({ l: attachedCount() }, '', layer.url || baseUrl());
  }
  syncChrome();
  return layer;
}
function popLayer(info = {}) {
  const l = ui.stack.pop();
  if (!l) return;
  runClose(l, info);
  if (l.confirmed && l.onConfirm) l.onConfirm(l);
  // Once the layer is really gone from the screen (the caller redraws after this): the focus back where it was.
  // Shown = has boxes on the page: offsetParent is null for anything position: fixed — the map itself and the
  // buttons over it — and the focus never came back to the map after «Новая точка» (26.09.2026).
  const back = l.returnFocus;
  if (back) {
    setTimeout(() => {
      const shown = (el) => el.isConnected && el.getClientRects().length > 0;
      const now = document.activeElement;
      const lost = !now || now === document.body || !shown(now);
      if (lost && shown(back)) { try { back.focus({ preventScroll: true }); } catch { /* not focusable any more */ } }
    }, 0);
  }
}
// ✕, «Готово», «Назад»: one layer. Through history, so the browser and the interface never disagree.
function closeTop() {
  const top = topLayer();
  if (!top) return;
  if (!top.attached) { popLayer(); syncChrome(); return; }
  if (Date.now() - ui.backPending < 500) return; // a double tap must not close two things
  ui.backPending = Date.now();
  history.back();
}
function closeLayers(n) {
  while (n > 0 && ui.stack.length && !topLayer().attached) { popLayer(); n -= 1; }
  const attached = ui.stack.slice(Math.max(0, ui.stack.length - n)).filter((l) => l.attached).length;
  if (attached) { ui.backPending = Date.now(); history.go(-attached); }
  else { ui.endingNav = false; ui.closingAll = false; syncChrome(); }
}
// «Карта» in the bar: everything over the map closes, except the navigation.
function closeAll() {
  let n = 0;
  for (let i = ui.stack.length - 1; i >= 0 && ui.stack[i].kind !== 'nav'; i -= 1) n += 1;
  if (!n) return;
  ui.closingAll = true;
  closeLayers(n);
}
function dropTop() { popLayer(); syncChrome(); }
function reattach(layer) { layer.attached = true; history.pushState({ l: attachedCount() }, '', baseUrl()); syncChrome(); }
window.addEventListener('popstate', (e) => {
  ui.backPending = 0;
  // Back wakes the screen first — unless this Back closed the sheet where «Погасить экран» was tapped.
  const darkAfter = typeof saverAfterBack === 'function' && saverAfterBack();
  if (!darkAfter && typeof saver !== 'undefined' && saver.on) hideSaver();
  if (darkAfter) setTimeout(showSaver, 0);
  const want = e.state?.l ?? 0;
  while (attachedCount() > want) {
    const top = topLayer();
    if (!top) break;
    if (top.attached && top.guard && !ui.endingNav && !top.guard()) { top.attached = false; continue; }
    popLayer();
  }
  if (ui.closingAll) {
    while (ui.stack.length && topLayer().kind !== 'nav') popLayer();
    ui.closingAll = false;
  }
  ui.endingNav = false;
  syncChrome();
});
const SURFACE = new Set(['page', 'card', 'peek', 'nav', 'full', 'months']);
function surfaceLayer() { for (let i = ui.stack.length - 1; i >= 0; i -= 1) if (SURFACE.has(ui.stack[i].kind)) return ui.stack[i]; return null; }
function modeLayer() { for (let i = ui.stack.length - 1; i >= 0; i -= 1) if (['nav', 'full', 'months'].includes(ui.stack[i].kind)) return ui.stack[i]; return null; }

// Everything visible follows the stack: body[data-mode], which panel shows, which bar, the map size.
function syncChrome() {
  const body = document.body;
  const s = surfaceLayer();
  const m = modeLayer();
  const mode = m ? m.kind : 'browse';
  const top = topLayer();
  const pageOn = s?.kind === 'page';
  const cardOn = s?.kind === 'card';
  const modalOn = top?.kind === 'modal';
  const r0 = map.getContainer().getBoundingClientRect();
  body.dataset.mode = mode;
  $('#page').hidden = !pageOn;
  if (pageOn) renderPage(s);
  $('#card').hidden = !cardOn;
  if (cardOn) renderCard(s);
  $('#modal').hidden = !modalOn;
  if (modalOn) renderModal(top);
  body.classList.toggle('card-open', cardOn);
  body.classList.toggle('panel-open', pageOn || (cardOn && !isCompact()));
  body.classList.toggle('modal-open', modalOn);
  const navOn = mode === 'nav';
  $('#navTop').hidden = !navOn; $('#navBottom').hidden = !navOn;
  if (!navOn) { $('#navBanner').hidden = true; $('#recenter').hidden = true; }
  $('#monthBanner').hidden = mode !== 'months';
  $('#btnFullExit').hidden = mode !== 'full';
  const cur = pageOn ? s.page : 'map';
  $$('#navBar [data-page]').forEach((b) => { if (b.dataset.page === cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (pageOn) ui.lastPage = s.page;
  updateHint();
  renderChips();
  // The map area changed (a panel beside it, the bar under it, navigation): the picture stays where it was on screen.
  const r1 = map.getContainer().getBoundingClientRect();
  if (r0.left !== r1.left || r0.top !== r1.top || r0.width !== r1.width || r0.height !== r1.height) {
    map.invalidateSize({ pan: false });
    const dx = r1.left - r0.left, dy = r1.top - r0.top;
    if ((dx || dy) && geo.follow === 'free') map.panBy([dx, dy], { animate: false });
    if (geo.follow !== 'free') requestAnimationFrame(() => placeBoat(null));
  }
}

/* ---------- section pages ---------- */
const PAGES = {
  today: { title: 'Сегодня', html: () => todayHtml() },
  guide: { title: 'Клёв', tabs: [['places', 'Места'], ['season', 'Сезон'], ['fish', 'Рыба'], ['tackle', 'Снасти']], html: (s) => ({ places: placesHtml, season: seasonHtml, fish: fishHtml, tackle: tackleHtml }[s] || placesHtml)() },
  rules: { title: 'Правила', html: () => rulesHtml() },
  me: { title: 'Моё', tabs: [['tracks', 'Треки'], ['points', 'Точки'], ['offline', 'Без сети'], ['more', 'Настройки']], html: (s) => ({ tracks: tracksPageHtml, points: mePointsHtml, offline: offlineHtml, more: moreHtml }[s] || tracksPageHtml)() },
};
function showPage(page, sub) {
  if (page === 'map') { closeAll(); return; }
  const P = PAGES[page];
  if (!P) return;
  sub = sub || ui.sub[page] || P.tabs?.[0]?.[0];
  ui.sub[page] = sub;
  const top = topLayer();
  if (top?.kind === 'page') {
    if (top.page === page && top.sub === sub) return;
    openLayer({ kind: 'page', page, sub }, { replace: true });
  } else openLayer({ kind: 'page', page, sub });
}
function onNavItem(page) {
  if (page === 'map') { closeAll(); return; }
  const top = topLayer();
  if (top?.kind === 'page' && top.page === page) {
    if (!isCompact()) closeTop(); else $('#pageBody').scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  showPage(page);
}
function pageHtml(layer) { return PAGES[layer.page].html(layer.sub); }
function renderPage(layer, force = false) {
  const key = `${layer.id}:${layer.sub}`;
  if (!force && shown.page === key) return;
  const b = $('#pageBody');
  const prev = shown.pageLayer;
  if (prev) { prev.scrolls = prev.scrolls || {}; prev.scrolls[prev.shownSub] = b.scrollTop; }
  shown.page = key; shown.pageLayer = layer; layer.shownSub = layer.sub;
  const P = PAGES[layer.page];
  $('#pageTitle').textContent = P.title;
  $('#pageTabs').innerHTML = (P.tabs || []).map(([k, t]) => `<button type="button" role="tab" data-sub="${k}" aria-selected="${k === layer.sub}">${t}</button>`).join('');
  b.innerHTML = pageHtml(layer);
  b.scrollTop = layer.scrolls?.[layer.sub] || 0;
  if (layer.page === 'me' && layer.sub === 'offline') storageLine();
}
// Re-draw the visible page (after weather, a download step, a filter…) keeping its scroll.
function refreshPage(page) {
  const s = surfaceLayer();
  if (s?.kind !== 'page' || (page && s.page !== page)) return;
  const b = $('#pageBody'), top = b.scrollTop;
  const focusId = document.activeElement?.id;
  b.innerHTML = pageHtml(s);
  b.scrollTop = top;
  if (focusId) document.getElementById(focusId)?.focus?.({ preventScroll: true });
  if (s.page === 'me' && s.sub === 'offline') storageLine();
}
// «Показать на карте» from a page: on a phone the page steps aside (Back brings it back); elsewhere the map is beside it.
function revealMap() {
  if (isCompact() && surfaceLayer()?.kind === 'page') openLayer({ kind: 'peek' });
}

/* ---------- the card over the map ---------- */
function openCard(conf, opts = {}) {
  const top = topLayer();
  const replace = opts.replace ?? (!!top && (top.kind === 'card' || (top.kind === 'modal' && top.replaceable)));
  return openLayer({ kind: 'card', size: 'short', ...conf }, { replace, detached: opts.detached });
}
function renderCard(layer) {
  const idx = ui.stack.indexOf(layer);
  const below = ui.stack[idx - 1];
  const back = !isCompact() && below?.kind === 'page';
  $('#cardBack').hidden = !back;
  if (back) $('#cardBack').setAttribute('aria-label', `Назад: ${PAGES[below.page].title}`);
  if (shown.card === layer.id) return;
  const prev = shown.cardLayer;
  if (prev && prev !== layer) prev.scroll = $('#cardBody').scrollTop;
  shown.card = layer.id; shown.cardLayer = layer;
  $('#card').dataset.size = layer.size || 'short';
  $('#cardTitle').textContent = layer.title;
  $('#cardSub').textContent = layer.sub || '';
  $('#cardSub').hidden = !layer.sub;
  $('#cardBody').innerHTML = layer.body(layer);
  $('#cardBody').scrollTop = layer.scroll || 0;
  updateMoreToggle();
  layer.onShow?.(layer);
  if (!layer.focused) { layer.focused = true; requestAnimationFrame(() => requestAnimationFrame(() => focusCard(layer))); }
}
function focusCard(layer) {
  const f = layer.focus;
  if (!f || surfaceLayer() !== layer) return;
  if (!nav.on && geo.follow !== 'free') setFollow('free');
  if (f.bounds) map.fitBounds(f.bounds, fitPadding(15));
  else keepInView(f.lat, f.lon);
}
function refreshCard() {
  const s = surfaceLayer();
  if (s?.kind !== 'card') return;
  const b = $('#cardBody'), top = b.scrollTop;
  shown.card = 0;
  s.focused = true;
  renderCard(s);
  b.scrollTop = top;
}
function setCardSize(size) {
  const s = surfaceLayer();
  if (s?.kind !== 'card') return;
  s.size = size;
  $('#card').dataset.size = size;
  updateMoreToggle();
}
function toggleCardSize() { setCardSize($('#card').dataset.size === 'full' ? 'short' : 'full'); }
function updateMoreToggle() {
  const full = $('#card').dataset.size === 'full';
  $$('#cardBody .more-toggle').forEach((b) => { b.innerHTML = full ? `Свернуть ${ic('keyboard-arrow-up')}` : `Подробнее ${ic('keyboard-arrow-down')}`; });
}
// Drag the head: up — details, down — shorter, down again — closed.
(() => {
  const head = $('#cardHead');
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (!isCompact() || e.target.closest('button')) return;
    drag = { y0: e.clientY, t0: performance.now(), id: e.pointerId };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y0;
    $('#card').style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  });
  const end = (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y0, v = dy / Math.max(1, performance.now() - drag.t0);
    drag = null;
    $('#card').style.transform = '';
    const full = $('#card').dataset.size === 'full';
    if (dy < -40 || v < -0.3) setCardSize('full');
    else if (dy > 40 || v > 0.3) { if (full) setCardSize('short'); else closeTop(); }
    else if (Math.abs(dy) < 6) toggleCardSize();
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', () => { drag = null; $('#card').style.transform = ''; });
  new ResizeObserver(() => {
    const c = $('#card');
    document.body.style.setProperty('--card-h', `${c.hidden ? 0 : c.offsetHeight}px`);
  }).observe($('#card'));
})();

/* ---------- sheets over everything ---------- */
function openModal(conf, opts = {}) {
  return openLayer({ kind: 'modal', ...conf }, { replace: opts.replace, detached: opts.detached });
}
function renderModal(layer) {
  if (shown.modal === layer.id) return;
  shown.modal = layer.id;
  $('#modal').className = `modal ${layer.cls || ''}`;
  renderModalBody(layer);
  const foot = layer.foot ? layer.foot(layer) : '';
  $('#modalFoot').hidden = !foot;
  $('#modalFoot').innerHTML = foot;
  $('#modalBody').scrollTop = layer.scroll || 0;
  if (!layer.shownOnce) { layer.shownOnce = true; layer.onShow?.(layer); }
}
function renderModalBody(layer, keepScroll = false) {
  if (!layer || topLayer() !== layer) return;
  const b = $('#modalBody');
  const top = b.scrollTop;
  $('#modalTitle').textContent = typeof layer.title === 'function' ? layer.title(layer) : layer.title;
  b.innerHTML = layer.body(layer);
  if (keepScroll) b.scrollTop = top;
}

/* ---------- modes: year by months, full screen ---------- */
function enterSeasonMode(autoplay) {
  if (!ui.stack.some((l) => l.kind === 'months')) {
    openLayer({ kind: 'months', onClose: () => seasonModeOff() });
    seasonModeOn();
  }
  setAutoplay(autoplay);
}
function closeDownTo(kind) {
  const i = ui.stack.findIndex((l) => l.kind === kind);
  if (i >= 0) closeLayers(ui.stack.length - i);
}
function toggleFull(opts = {}) {
  if (ui.stack.some((l) => l.kind === 'full')) { closeDownTo('full'); return; }
  if (nav.on) return;
  openLayer({ kind: 'full', onClose: () => { state.fullArea = null; if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); } }, { replace: !!opts.replace });
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  else if (platformInfo().iOS && !platformInfo().installed && !store.get('ladoga-full-hint', false)) {
    store.set('ladoga-full-hint', true);
    toast('Для полного экрана без адресной строки добавьте карту на экран «Домой»', 6000);
  }
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && ui.stack.some((l) => l.kind === 'full')) closeDownTo('full');
});
function goHome() {
  setFollowFree();
  if (map.getBearing() !== 0 && !nav.on) map.setBearing(0);
  map.fitBounds(state.fullArea || homeBounds(), fitPadding(state.fullArea ? 15 : 14));
}

/* ---------- status chips, filter badge, hint and notices ---------- */
function renderChips() {
  const el = $('#statusChips');
  if (!el) return;
  const chips = [];
  const wx = state.wx;
  // The simple view (simple.js): one line of the day — can one go out, the bans, the ice — instead of the weather chip.
  if (typeof isSimple === 'function' && isSimple()) chips.push(dayChipHtml());
  else if (wx?.fc?.current) {
    const warns = wxWarnings(wx);
    const danger = warns.find((w) => w.level === 'danger'), warn = warns.find((w) => w.level === 'warn');
    const c = wx.fc.current;
    const old = !navigator.onLine || Date.now() - wx.at > 3 * 3600000;
    // A warning (to 14:00 tomorrow) says itself on the chip; otherwise the wind now — and the forecast's age once
    // it is older than 6 h (no signal on the water for hours).
    const aged = Date.now() - wx.at > 6 * 3600000 ? ` · прогноз ${fmtDur(Date.now() - wx.at).replace(/ \d+ мин$/, '')} назад` : '';
    if (danger || warn) chips.push(`<button type="button" class="schip ${danger ? 'danger' : 'warn'}" data-chip="wx">${ic('warning')}${esc((danger || warn).short)}${aged}</button>`);
    else chips.push(`<button type="button" class="schip" data-chip="wx" aria-label="Погода">${windArrow(c.wind_direction_10m, 14)} ${Math.round(c.wind_speed_10m)} м/с · ${Math.round(c.temperature_2m)}°${aged || (old ? ` · ${fmtTime(wx.at)}` : '')}</button>`);
  }
  // The car: «К машине» one tap away, with the distance, while away from it. Not marked — or yesterday's mark far from
  // here — and the GPS on: «Отметить машину», the angler's first step at the launch (26.09.2026: it could be marked
  // only by starting a track).
  if (!nav.on) {
    const me = geo.me && Date.now() - geo.me.t < 60000 ? geo.me : null;
    const dc = state.car && me ? distM(me, state.car) : null;
    const old = state.car && Date.now() - state.car.t > 12 * 3600000 && dc != null && dc > 5000;
    if (state.car && !old) { if (dc == null || dc > 150) chips.push(`<button type="button" class="schip" data-chip="car">🚗 К машине${dc != null ? ` · ${fmtDist(dc)}` : ''}</button>`); }
    else if (me) chips.push('<button type="button" class="schip" data-chip="car-mark">🚗 Отметить машину</button>');
  }
  if (!navigator.onLine) chips.push(`<button type="button" class="schip offline ${regionSaved() ? '' : 'warn'}" data-chip="offline">${ic('cloud-off')}${regionSaved() ? 'Без сети' : 'Без сети · район не скачан'}</button>`);
  if (geo.me && geo.me.acc > 50 && Date.now() - geo.me.t < 15000) chips.push(`<button type="button" class="schip gps" data-chip="gps">GPS ±${Math.round(geo.me.acc / 10) * 10} м</button>`);
  if (guard.on) chips.push(`<button type="button" class="schip warn" data-chip="guard">${ic('warning')}Сторож · ${guard.anchor ? `${Math.round(guard.d || 0)} м` : 'запоминаю место'}</button>`);
  // With a depth layer on but the map too far out for the digits: one tap brings them.
  const o = state.overlays;
  // Only for the paper charts, whose figures need z14: the shading and isolines on by default speak at any zoom.
  if (o.charts && map.getZoom() >= 11 && map.getZoom() < 14 && !nav.on && !(typeof isSimple === 'function' && isSimple())) chips.push(`<button type="button" class="schip" data-chip="zoom-depth">${ic('add')}Приблизить: цифры глубин</button>`);
  const af = activeFilters();
  if (af.length && !ui.stack.some((l) => l.kind === 'months')) chips.push(`<button type="button" class="schip" data-chip="filter">${ic('tune')}${esc(af.map((x) => x[1]).join(' · ').slice(0, 42))}<span class="x" data-chip="filter-clear" role="button" aria-label="Сбросить фильтр">✕</span></button>`);
  const html = chips.join('');
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
}
function onFilterChange() {
  const n = activeFilters().length;
  const b = $('#filterCount');
  if (b) { b.hidden = !n; b.textContent = n; }
  const sl = $('#shownLine');
  if (sl) sl.textContent = shownLine();
  renderChips();
}
function showNotice(n) { ui.notices.push(n); updateHint(); }
function updateHint() {
  const el = $('#hint');
  if (!el) return;
  const free = !ui.stack.length;
  const n = ui.notices[0];
  // (Not in the simple view: its big button says what to do, and the hint names «⌂», which it has put away.)
  if (!n && free && !store.get('ladoga-hint-v2', false) && !(typeof isSimple === 'function' && isSimple())) {
    // Once, and without a card to dismiss: the owner found the big card in the way (24.09.2026).
    store.set('ladoga-hint-v2', true);
    setTimeout(() => toast('Нажмите на точку — подробности и «Вести». ◎ — где я, ⌂ — ваш район', 6000), 1500);
  }
  if (!free || !n) { el.hidden = true; return; }
  const key = n ? `n${ui.notices.length}:${n.text}` : 'hint';
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    if (n) el.innerHTML = `<p>${esc(n.text)}</p><span class="btns" style="margin:0">${n.actions.map(([t, , primary], i) => `<button type="button" class="btn small ${primary ? '' : 'ghost'}" data-notice="${i}">${esc(t)}</button>`).join('')}</span>`;
    else el.innerHTML = `<p><b>Нажмите на точку</b> — подробности и «Вести». ${ic('my-location')} — где я, ${ic('home')} — ваш район.</p><button type="button" class="btn small" data-notice="hint">Понятно</button>`;
  }
  el.hidden = false;
}
$('#hint').addEventListener('click', (e) => {
  const b = e.target.closest('[data-notice]');
  if (!b) return;
  if (b.dataset.notice === 'hint') { store.set('ladoga-hint-v2', true); updateHint(); return; }
  const n = ui.notices.shift();
  updateHint();
  n?.actions[+b.dataset.notice]?.[1]?.();
});

/* ---------- day and night ---------- */
function applyTheme() {
  const s = state.settings.theme;
  let night;
  if (s === 'night') night = true;
  else if (s === 'day') night = false;
  else if (s === 'sun') { const st = sunTimes(); const now = Date.now(); night = st.polarNight ? true : st.polarDay ? false : (now < st.rise || now > st.set); }
  else night = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = night ? 'night' : 'day';
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = night ? '#000000' : '#0050b3';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
setInterval(applyTheme, 5 * 60000);

/* ---------- wiring ---------- */
for (const id of ['pageBody', 'cardBody', 'modalBody', 'modalFoot', 'navBanner']) {
  const el = document.getElementById(id);
  el.addEventListener('click', onContentClick);
  el.addEventListener('change', onContentChange);
  el.addEventListener('input', onContentInput);
}
$('#pageTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sub]');
  const s = surfaceLayer();
  if (!b || s?.kind !== 'page') return;
  s.sub = b.dataset.sub; ui.sub[s.page] = s.sub;
  renderPage(s, true);
});
$('#pageClose').addEventListener('click', closeTop);
$('#cardClose').addEventListener('click', () => {
  const s = surfaceLayer();
  const below = ui.stack[ui.stack.indexOf(s) - 1];
  // Beside a page (tablet, computer) ✕ closes the whole panel; the arrow goes back to the page.
  if (!isCompact() && below?.kind === 'page' && topLayer() === s) closeLayers(2); else closeTop();
});
$('#cardBack').addEventListener('click', closeTop);
$('#modalClose').addEventListener('click', closeTop);
$('#modalScrim').addEventListener('click', closeTop);
$('#navBar').addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b) onNavItem(b.dataset.page); });
$('#railFull').addEventListener('click', () => toggleFull());
$('#railKeys').addEventListener('click', openKeysHelp);
$('#searchBtn').addEventListener('click', openSearch);
$('#filterBtn').addEventListener('click', () => openLayersSheet('filter'));
$('#btnLayers').addEventListener('click', () => openLayersSheet('layers'));
$('#btnFull').addEventListener('click', () => toggleFull());
$('#btnFullExit').addEventListener('click', () => closeDownTo('full'));
$('#btnSos').addEventListener('click', openSos);
$('#zoomIn').addEventListener('click', () => userZoom(1));
$('#zoomOut').addEventListener('click', () => userZoom(-1));
$('#btnHome').addEventListener('click', goHome);
$('#btnLocate').addEventListener('click', onLocateClick);
$('#btnTrack').addEventListener('click', onTrackButton);
$('#btnCompass').addEventListener('click', onCompassClick);
$('#navEnd').addEventListener('click', () => confirmEndNav(false));
$('#navTrack').addEventListener('click', onTrackButton);
$('#navMark').addEventListener('click', quickMark);
$('#navMore').addEventListener('click', openNavMore);
$('#recenter').addEventListener('click', () => recenter(false));
$('#nfDepthBox').addEventListener('click', openDepthInfo);
$('#zoomAuto').addEventListener('click', toggleAutoZoom);
$('#zoomRoute').addEventListener('click', () => wholeRoute());
$('#ntVoice').addEventListener('click', toggleVoice);
$('#btnDark').addEventListener('click', showSaver);
$('#mbPrev').addEventListener('click', () => { setAutoplay(false); showSeasonMonth((state.seasonMonth + 10) % 12 + 1); });
$('#mbNext').addEventListener('click', () => { setAutoplay(false); showSeasonMonth(state.seasonMonth % 12 + 1); });
$('#mbPlay').addEventListener('click', () => setAutoplay(!state.playing));
$('#mbClose').addEventListener('click', () => closeDownTo('months'));
$('#statusChips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-chip]');
  if (!c) return;
  const k = c.dataset.chip;
  if (k === 'day') openDaySheet();
  else if (k === 'wx') { showPage('today'); if (!c.classList.contains('danger') && !c.classList.contains('warn')) setTimeout(() => document.getElementById('wx')?.scrollIntoView({ block: 'start' }), 80); }
  else if (k === 'offline') showPage('me', 'offline');
  else if (k === 'gps') toast(`Точность GPS ±${Math.round(geo.me?.acc || 0)} м. На открытом месте, подальше от стен и мостов, будет точнее`, 5000);
  else if (k === 'filter-clear') { resetFilters(); toast('Фильтр сброшен'); }
  else if (k === 'filter') openLayersSheet('filter');
  else if (k === 'zoom-depth') { setFollowFree(); map.setZoom(14); }
  else if (k === 'car') { if (geo.me) goToCar(); else openCarCard(); }
  else if (k === 'car-mark') markCarHere();
  else if (k === 'guard') openGuardSheet();
});
map.on('zoomend', () => renderChips());
// A tap on the empty map closes the card; a long press (right click) puts a point there.
map.on('click', () => {
  if (state.playing) setAutoplay(false);
  const top = topLayer();
  if (top?.kind === 'card' && !nav.on) closeTop();
});
map.getContainer().addEventListener('pointerdown', () => { if (state.playing) setAutoplay(false); }, { passive: true });
map.on('contextmenu', (e) => {
  if (nav.on || topLayer()?.kind === 'modal') return;
  openNewPoint(e.latlng.lat, e.latlng.lng, { replace: topLayer()?.kind === 'card' });
});
// A mouse over the map (computer, tablet with a mouse): coordinates and the chart depth under the pointer.
if (matchMedia('(pointer: fine)').matches) {
  let hoverT = 0;
  map.on('mousemove', (e) => {
    const now = performance.now();
    if (now - hoverT < 90) return;
    hoverT = now;
    const el = $('#cursorInfo');
    const p = { lat: e.latlng.lat, lon: e.latlng.lng };
    const d = depthAt(p);
    el.textContent = `${fmtDM(p.lat, p.lon)}${d ? ` · ${d.text}` : ''}`;
    el.hidden = false;
  });
  map.on('mouseout', () => { $('#cursorInfo').hidden = true; });
}
window.addEventListener('online', () => { renderChips(); refreshPage(); loadWeather(); loadLive(); applyOverlays(); });
window.addEventListener('offline', () => applyOverlays()); // the satellite of the day: the saved picture instead
window.addEventListener('offline', () => { renderChips(); refreshPage(); });
let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const before = document.body.dataset.layout;
    layoutClass();
    if (before !== document.body.dataset.layout) { shown.card = 0; syncChrome(); }
    map.invalidateSize();
    if (geo.follow !== 'free') placeBoat(null);
  }, 80);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

// iPhone ignores user-scalable=no: a pinch outside the map would zoom the whole page and lose the buttons.
document.addEventListener('gesturestart', (e) => { if (!map.getContainer().contains(e.target)) e.preventDefault(); }, { passive: false });

/* ---------- keyboard (by physical key: works in the Russian layout too) ---------- */
document.addEventListener('keydown', (e) => {
  const field = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
  if (e.code === 'Escape') {
    if (field) { if (field.value) { field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })); } else field.blur(); return; }
    const top = topLayer();
    if (!top) return;
    if (top.kind === 'nav') confirmEndNav(false); else closeTop();
    e.preventDefault();
    return;
  }
  if (field || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.code;
  const top = topLayer();
  if (top?.kind === 'modal') return;
  if (k === 'Equal' || k === 'NumpadAdd') { userZoom(1); e.preventDefault(); return; }
  if (k === 'Minus' || k === 'NumpadSubtract') { userZoom(-1); e.preventDefault(); return; }
  if (k === 'KeyN') { if (nav.on) setFollow('north'); else { if (geo.follow === 'course' || geo.follow === 'compass') setFollow('north'); map.setBearing(0); } return; }
  if (nav.on) return;
  if (k.startsWith('Arrow') && !map.getContainer().contains(document.activeElement)) {
    const d = 100, off = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[k];
    if (off) { setFollowFree(); map.panBy(off); e.preventDefault(); }
    return;
  }
  if (k === 'KeyF') toggleFull();
  else if (k === 'KeyL') onLocateClick();
  else if (k === 'KeyH') goHome();
  else if (k === 'KeyM') openLayersSheet('layers');
  else if (k === 'Slash') { e.preventDefault(); if (e.shiftKey) openKeysHelp(); else openSearch(); }
  else if (k === 'BracketLeft') { if (top?.kind === 'page' || top?.kind === 'card') closeTop(); else if (ui.lastPage) showPage(ui.lastPage); }
  else if (/^Digit[1-5]$/.test(k)) onNavItem(['map', 'today', 'guide', 'rules', 'me'][+k.slice(5) - 1]);
});

/* ---------- start ---------- */
async function boot() {
  layoutClass();
  map.invalidateSize({ pan: false }); // the box of the map is final only now (styles, safe areas)
  applyTheme();
  const hash = location.hash;
  history.replaceState({ l: 0 }, '', baseUrl());
  let points, ctx;
  try {
    [points, ctx] = await Promise.all([
      fetch('data/points.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('data/context.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({})),
    ]);
  } catch {
    toast('Не удалось загрузить данные — нужен интернет или скачанный район', 10000);
    return;
  }
  state.R = points.reports; state.M = points.markers; state.meta = points; state.ctx = ctx || {};
  addExtraTileLayers();
  setBase(state.base);
  buildCharts();
  buildDepthModel();
  loadChartTiles();
  applyOverlays();
  drawLines(); drawMine(); drawRules(); drawSeasonZones(); drawIceZones();
  render();
  loadChartIsobaths(); // the depth of each point and under the boat
  loadDepthGrid();
  loadDepthDangers();
  loadFetchTable(); // the wave near the shore
  await loadTracks();
  // A shared link (#pt=lat,lon) opens its point; no history entry was made by a tap, so ✕ closes it directly.
  const m = hash.match(/pt=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) {
    const p = { lat: +m[1], lon: +m[2] };
    let best = -1, bd = Infinity;
    state.M.forEach((x, i) => { const d = distM(p, x); if (d < bd) { bd = d; best = i; } });
    if (best >= 0 && bd < 60) { map.setView([state.M[best].lat, state.M[best].lon], 14, { animate: false }); openPoint(best, { detached: true }); }
    else {
      map.setView([p.lat, p.lon], 14, { animate: false });
      state.linkPoint = { id: 'link', lat: p.lat, lon: p.lon, name: 'Точка по ссылке', link: true, tag: 'other' };
      openMineCard(state.linkPoint, { detached: true });
    }
  }
  // Navigation never restarts by itself: a card asks.
  const saved = store.get('ladoga-nav', null);
  if (saved?.lat && Date.now() - (saved.t || 0) < 6 * 3600000) {
    showNotice({ text: `Продолжить навигацию к «${saved.title}»?`, actions: [['Продолжить', () => startNav(saved), true], ['Нет', () => store.set('ladoga-nav', null)]] });
  } else store.set('ladoga-nav', null);
  updateLocateBtn(); updateTrackUi(); updateCompassBtn(); onFilterChange();
  geoAutoStart();
  syncChrome();
  refreshLayersSheet(); refreshPage(); // opened while the data was still loading
  loadWeather();
  loadLive();
  loadReports();
  setInterval(() => { loadWeather(); loadLive(); }, 30 * 60000);
  setInterval(loadReports, 6 * 3600000);
}
boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
