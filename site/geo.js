'use strict';

/* Ладога · рыболовная карта — location, follow, compass, map rotation and navigation to a point
   (design/UX_SPEC.md §7–8). The map holds on to the boat the way a car navigator or a Garmin plotter does:
   ◎ cycles free → north up → course up; a drag frees the map, and in navigation it comes back by itself. */

// Magnetic declination in the south of Ladoga (WMM2025, 60.2° N 32.2° E, 2026): about 12° east.
// The compass points to magnetic north; the map and GPS course to true north.
const DECLINATION = 12;

const geo = {
  watchId: null, me: null, hist: [], sog: null, cog: null, cogT: 0, cogVec: null,
  heading: null, headingT: 0, headVec: null, hasCompass: false, compassOn: false, compassAcc: null,
  follow: 'free', wantFollow: null, searching: false, error: null, iconKey: '',
  rotT: 0, progZoom: false, fastSince: 0, hiddenAt: 0,
};
const nav = {
  on: false, target: null, start: null, d: null, brg: null, arrived: false, arriveT: 0, hold: false,
  zSpeed: 17, zoomCand: null, zoomCandT: 0, autoZoomPaused: false, firstPlace: true, lastTouch: 0, followBefore: null,
  offSince: 0, offCourse: null, hazard: null, hazardSeen: {}, banner: '', depth: null, depthT: 0, left: null, leftT: 0,
  audio: null, lastFields: 0,
};

/* ---------- position ---------- */
function geoStart({ follow = null } = {}) {
  if (!navigator.geolocation) { showLocationHelp('unsupported'); return false; }
  if (follow) geo.wantFollow = follow;
  if (geo.watchId != null) { if (geo.me && geo.wantFollow) applyWantFollow(); return true; }
  if (platformInfo().inApp && !store.get('ladoga-inapp-warned', false)) { store.set('ladoga-inapp-warned', true); showLocationHelp('inapp'); }
  geo.searching = true; geo.error = null;
  // A quick coarse fix first (Safari answers it in a second or two from Wi‑Fi), then a high-accuracy watch
  // without a timeout: on the water GPS may need a minute.
  navigator.geolocation.getCurrentPosition(onFix, onGeoError, { enableHighAccuracy: false, maximumAge: 120000, timeout: 15000 });
  geo.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 1000 });
  if (!geo.me) toast('Определяю, где вы… Если телефон спросит — разрешите геопозицию', 4000);
  updateLocateBtn();
  return true;
}
function restartWatch() {
  if (geo.watchId == null) return;
  navigator.geolocation.clearWatch(geo.watchId);
  geo.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 1000 });
}
function geoRestart() {
  if (geo.watchId != null) navigator.geolocation.clearWatch(geo.watchId);
  geo.watchId = null;
  geoStart({ follow: geo.follow !== 'free' ? geo.follow : 'north' });
}
function geoStop() {
  if (geo.watchId != null) navigator.geolocation.clearWatch(geo.watchId);
  geo.watchId = null; geo.me = null; geo.searching = false; geo.sog = null; geo.cog = null; geo.hist = [];
  layers.me.clearLayers();
  setFollow('free');
  updateLocateBtn(); renderChips();
}
function onFix(pos) {
  const c = pos.coords;
  const t = Date.now();
  const acc = c.accuracy || 9999;
  // A coarse Wi‑Fi fix must not overwrite a good GPS one that arrived a moment earlier.
  if (geo.me && acc > Math.max(50, geo.me.acc * 2) && t - geo.me.t < 10000) return;
  const p = { lat: c.latitude, lon: c.longitude, acc, t };
  const first = !geo.me;
  geo.searching = false; geo.error = null;
  if (acc <= 50) motion(p, c);
  geo.me = { ...p, sog: geo.sog, cog: geo.cog };
  geo.hist.push(p);
  while (geo.hist.length > 2 && t - geo.hist[0].t > 30000) geo.hist.shift();
  drawMe();
  if (geo.wantFollow) applyWantFollow();
  else if (first && !nav.on && geo.follow === 'free') updateLocateBtn();
  if (nav.on) navOnFix(); else followMe();
  if (typeof trackOnFix === 'function') trackOnFix(geo.me);
  updateCardLive();
  updateLocateBtn();
  renderChips();
}
// Speed over ground and course over ground, filtered (§8.4).
function motion(p, c) {
  let v = null;
  if (c.speed != null && !Number.isNaN(c.speed) && p.acc <= 30) v = c.speed;
  else {
    const ref = findHist(p.t, 5000);
    if (ref) v = distM(ref, p) / ((p.t - ref.t) / 1000);
  }
  if (v != null) geo.sog = geo.sog == null ? v : geo.sog + 0.4 * (v - geo.sog);
  // Standing still: the wander of the fix is not speed.
  const ref5 = findHist(p.t, 5000);
  if (geo.sog != null && geo.sog * 3.6 < 1 && ref5 && distM(ref5, p) < p.acc) geo.sog = 0;
  // Course up starts after 3 s at 5 km/h or more and stops below 3 km/h: the picture does not swing at a drift.
  const kmh = (geo.sog || 0) * 3.6;
  if (kmh >= 5) { if (!geo.fastSince) geo.fastSince = p.t; if (p.t - geo.fastSince >= 3000) geo.courseRot = true; } else geo.fastSince = 0;
  if (kmh < 3) geo.courseRot = false;
  let h = null;
  if (geo.sog != null && geo.sog * 3.6 >= 3 && c.heading != null && !Number.isNaN(c.heading)) h = c.heading;
  else {
    const ref10 = findHist(p.t, 10000);
    if (ref10 && distM(ref10, p) > 2 * p.acc && geo.sog != null && geo.sog * 3.6 >= 1) h = bearing(ref10, p);
  }
  if (h != null) {
    const x = Math.sin(toRad(h)), y = Math.cos(toRad(h));
    if (!geo.cogVec || p.t - geo.cogT > 20000) geo.cogVec = { x, y };
    else { geo.cogVec.x += 0.3 * (x - geo.cogVec.x); geo.cogVec.y += 0.3 * (y - geo.cogVec.y); }
    geo.cog = (Math.atan2(geo.cogVec.x, geo.cogVec.y) * 180 / Math.PI + 360) % 360;
    geo.cogT = p.t;
  }
}
function findHist(t, age) {
  for (let i = geo.hist.length - 1; i >= 0; i--) if (t - geo.hist[i].t >= age) return geo.hist[i];
  return null;
}
const courseValid = () => geo.cog != null && geo.sog != null && geo.sog * 3.6 >= 3 && Date.now() - geo.cogT < 15000;
const compassFresh = () => geo.compassOn && geo.heading != null && Date.now() - geo.headingT < 3000;
// What the boat is pointing at: the GPS course when moving, the compass when standing (if allowed).
function headingNow() {
  if (courseValid()) return { h: geo.cog, src: 'gps' };
  if (compassFresh()) return { h: geo.heading, src: 'compass' };
  return null;
}
function onGeoError(err) {
  geo.error = err.code;
  if (err.code === 1) {
    const wasOn = geo.watchId != null;
    geoStop();
    if (wasOn || nav.on) showLocationHelp(platformInfo().inApp ? 'inapp' : 'denied');
  } else if (!geo.me) {
    // POSITION_UNAVAILABLE or TIMEOUT: the watch keeps running and answers once the phone finds itself.
    toast(err.code === 3 ? 'GPS пока ищет спутники. На открытом месте это до минуты' : 'Телефон пока не знает, где он: проверьте, что геолокация включена', 5000);
  }
  updateLocateBtn();
}

/* ---------- compass ---------- */
function compassNeedsPermission() { return typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'; }
const canCompass = () => geo.hasCompass || compassNeedsPermission();
// Call from a tap: iOS asks the user only inside a gesture.
function enableCompass() {
  if (geo.compassOn) return Promise.resolve(true);
  const done = (ok) => {
    if (ok) {
      geo.compassOn = true;
      if (!store.get('ladoga-compass-warned', false)) { store.set('ladoga-compass-warned', true); toast('Компас сбивают мотор, стальной корпус и магнитный держатель', 5000); }
    }
    return ok;
  };
  if (!compassNeedsPermission()) return Promise.resolve(done(true));
  try {
    return DeviceOrientationEvent.requestPermission().then((r) => done(r === 'granted'), () => done(false));
  } catch { return Promise.resolve(false); }
}
let orientFrame = 0;
function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) { h = e.webkitCompassHeading; geo.compassAcc = e.webkitCompassAccuracy; }
  else if ((e.absolute || e.type === 'deviceorientationabsolute') && typeof e.alpha === 'number') h = 360 - e.alpha;
  if (h == null) return;
  geo.hasCompass = true;
  const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  const hdg = (h + screenAngle + DECLINATION + 360) % 360;
  const x = Math.sin(toRad(hdg)), y = Math.cos(toRad(hdg));
  if (!geo.headVec || Date.now() - geo.headingT > 2000) geo.headVec = { x, y };
  else { geo.headVec.x += 0.25 * (x - geo.headVec.x); geo.headVec.y += 0.25 * (y - geo.headVec.y); }
  geo.heading = (Math.atan2(geo.headVec.x, geo.headVec.y) * 180 / Math.PI + 360) % 360;
  geo.headingT = Date.now();
  if (!geo.compassOn || orientFrame) return;
  orientFrame = requestAnimationFrame(() => {
    orientFrame = 0;
    refreshMeIcon();
    if (geo.follow === 'compass' || (geo.follow === 'course' && !geo.courseRot)) { applyRotation(); placeBoat(null); }
    if (nav.on) updateNavArrow();
  });
}
window.addEventListener('deviceorientationabsolute', onOrientation);
window.addEventListener('deviceorientation', onOrientation);

/* ---------- the «me» marker: a dot with a direction cone; in navigation a boat arrow ---------- */
const meMarker = L.marker([0, 0], { interactive: false, keyboard: false, rotateWithView: true, rotation: 0, zIndexOffset: 1000 });
const meCircle = L.circle([0, 0], { radius: 1, color: '#1c7ed6', weight: 1, fillOpacity: 0.14, interactive: false });
function meIcon(kind, stale, cone) {
  if (kind === 'boat') return L.divIcon({ className: `boat${stale ? ' stale' : ''}`, html: '<svg viewBox="0 0 100 100"><path d="M50 6 82 90 50 71 18 90Z"/></svg>', iconSize: [32, 32], iconAnchor: [16, 16] });
  return L.divIcon({ className: '', html: `<div class="me-wrap${stale ? ' stale' : ''}">${cone ? '<div class="me-cone"></div>' : ''}<div class="me-dot"></div></div>`, iconSize: [60, 60], iconAnchor: [30, 30] });
}
function drawMe() {
  const me = geo.me;
  if (!me) return;
  if (!layers.me.hasLayer(meMarker)) { geo.iconKey = ''; meCircle.addTo(layers.me); meMarker.addTo(layers.me); }
  meMarker.setLatLng([me.lat, me.lon]);
  meCircle.setLatLng([me.lat, me.lon]).setRadius(me.acc || 1);
  refreshMeIcon();
}
function refreshMeIcon() {
  if (!geo.me || !layers.me.hasLayer(meMarker)) return;
  const stale = Date.now() - geo.me.t > 10000;
  const hd = headingNow();
  const kind = nav.on ? 'boat' : 'dot';
  const key = `${kind}|${stale}|${hd ? 1 : 0}`;
  if (key !== geo.iconKey) { geo.iconKey = key; meMarker.setIcon(meIcon(kind, stale, !!hd)); }
  const rot = hd ? hd.h : (geo.cog ?? 0);
  if (Math.abs(angleDiff((meMarker.options.rotation || 0) * 180 / Math.PI, rot)) > 1) meMarker.setRotation(toRad(rot));
}

/* ---------- follow: ◎ free → north up → course up ---------- */
function setFollow(mode) {
  geo.follow = mode;
  const f = mode !== 'free';
  // While the map holds on to the boat, pinch, wheel and double tap zoom around the centre and keep holding.
  map.options.touchZoom = f ? 'center' : true;
  map.options.scrollWheelZoom = f ? 'center' : true;
  map.options.doubleClickZoom = f ? 'center' : true;
  if (mode === 'north' && map.getBearing() !== 0) map.setBearing(0);
  if (f && geo.me) { applyRotation(true); placeBoat(null); }
  updateLocateBtn(); updateCompassBtn(); refreshMeIcon();
  if (nav.on) updateRecenter();
}
function setFollowFree() { if (!nav.on && geo.follow !== 'free') setFollow('free'); }
function applyWantFollow() {
  const want = geo.wantFollow;
  geo.wantFollow = null;
  if (!geo.me) return;
  if (!nav.on && map.getZoom() < 13) map.setView([geo.me.lat, geo.me.lon], 15, { animate: false });
  setFollow(want);
}
function followMe() {
  if (!geo.me || geo.follow === 'free') return;
  applyRotation();
  placeBoat(null);
}
function onLocateClick() {
  if (geo.watchId == null) { geoStart({ follow: 'north' }); return; }
  if (!geo.me) { geo.wantFollow = 'north'; toast('Ищу спутники… На открытом месте это до минуты'); return; }
  if (geo.follow === 'free') { setFollow('north'); return; }
  if (geo.follow === 'north') {
    if (geo.sog != null && geo.sog * 3.6 >= 5) setFollow('course');
    else if (canCompass()) enableCompass().then((ok) => { if (ok) setFollow('compass'); else toast('Компас не разрешён'); });
    else toast('Поворот карты по курсу — когда поедете');
    return;
  }
  setFollow('north');
}
function updateLocateBtn() {
  const b = $('#btnLocate');
  if (!b) return;
  const st = geo.watchId == null ? 'nofix' : !geo.me ? 'searching' : geo.follow;
  if (b.dataset.state === st) return;
  b.dataset.state = st;
  const icon = { nofix: 'my-location', searching: 'location-searching', free: 'my-location', north: 'my-location', course: 'navigation', compass: 'explore' }[st];
  const label = { nofix: 'Где я', searching: 'Ищу спутники', free: 'Вернуться ко мне', north: 'Слежение, север вверх — нажмите: по курсу', course: 'По курсу — нажмите: север вверх', compass: 'По компасу — нажмите: север вверх' }[st];
  b.innerHTML = ic(icon);
  b.setAttribute('aria-label', label); b.title = `${label} (L)`;
}
// The compass button: an arrow that always points north on screen; a tap sets north up.
function updateCompassBtn() {
  const b = $('#btnCompass');
  if (!b) return;
  const bear = map.getBearing();
  const show = nav.on || Math.abs(angleDiff(0, bear)) > 0.5;
  b.hidden = !show;
  if (!show) return;
  b.querySelector('svg').style.transform = `rotate(${bear}deg)`;
  const label = nav.on ? ({ north: 'Север', course: 'Курс', compass: 'Компас' }[geo.follow === 'free' ? (nav.followBefore || 'north') : geo.follow] || 'Север') : 'Север';
  $('#compassLabel').textContent = label;
  b.setAttribute('aria-label', nav.on ? `Ориентация карты: ${label.toLowerCase()}` : 'Север вверх');
}
map.on('rotate', () => updateCompassBtn());
function onCompassClick() {
  if (!nav.on) { if (geo.follow === 'course' || geo.follow === 'compass') setFollow('north'); else map.setBearing(0); updateCompassBtn(); return; }
  // In navigation: Север → По курсу → По компасу → Север.
  const cur = geo.follow === 'free' ? (nav.followBefore || 'north') : geo.follow;
  const next = cur === 'north' ? 'course' : cur === 'course' && canCompass() ? 'compass' : 'north';
  const go = () => { nav.followBefore = next; setFollow(next); toast({ north: 'Север вверх', course: 'Карта по курсу', compass: 'Карта по компасу' }[next]); };
  if (next === 'compass') enableCompass().then((ok) => { if (ok) go(); else { nav.followBefore = 'north'; setFollow('north'); } });
  else go();
}

/* ---------- rotation (leaflet-rotate) ---------- */
function desiredTop() {
  if (geo.follow === 'north') return 0;
  if (geo.follow === 'course') {
    if (geo.courseRot && courseValid()) return geo.cog;
    if (!geo.courseRot && compassFresh()) return geo.heading; // standing: the compass, if allowed
    return null; // otherwise the picture freezes on the last course
  }
  if (geo.follow === 'compass') return compassFresh() ? geo.heading : null;
  return null;
}
function applyRotation(force = false) {
  const H = desiredTop();
  if (H == null) return;
  const now = performance.now();
  if (!force && now - geo.rotT < 250) return;
  const cur = map.getBearing();
  const target = (360 - H) % 360;
  let diff = angleDiff(cur, target);
  const dead = geo.follow === 'compass' ? 3 : 5;
  if (!force && Math.abs(diff) < dead) return;
  if (!force) {
    const dt = geo.rotT ? Math.min(1, (now - geo.rotT) / 1000) : 0.25;
    const maxStep = Math.max(22.5, 90 * dt);
    if (Math.abs(diff) > maxStep) diff = Math.sign(diff) * maxStep;
  }
  geo.rotT = now;
  map.setBearing((cur + diff + 360) % 360);
}

/* ---------- keep the boat where it belongs on screen ---------- */
// Boat in the middle of the free area (north up) or at 72 % of its height (course up); z = zoom to step to.
function placeBoat(z) {
  const me = geo.me;
  if (!me || geo.follow === 'free') return;
  const fr = mapFreeRect();
  const rotated = Math.abs(angleDiff(0, map.getBearing())) > 0.5 && (geo.follow === 'course' || geo.follow === 'compass');
  const yShare = rotated ? 0.72 : 0.5;
  const want = L.point((fr.left + fr.right) / 2, fr.top + yShare * (fr.bottom - fr.top));
  const boat = map.latLngToContainerPoint([me.lat, me.lon]);
  // A screen-space shift (the map pane itself never rotates), cheaper than a new view on every fix.
  if (boat.distanceTo(want) >= 3) map.panBy(boat.subtract(want), { animate: false });
  if (z != null && z !== map.getZoom()) {
    geo.progZoom = true;
    map.setZoomAround([me.lat, me.lon], z, { animate: true });
  }
}
map.on('zoomend', () => { geo.progZoom = false; updateZoomAuto(); });
map.on('dragstart', () => {
  if (nav.on) {
    if (geo.follow !== 'free') { nav.followBefore = geo.follow; setFollow('free'); }
    nav.lastTouch = Date.now();
    updateRecenter();
  } else if (geo.follow !== 'free') setFollow('free');
});
map.on('zoomstart', () => {
  if (geo.progZoom || !nav.on) return;
  nav.autoZoomPaused = true; nav.lastTouch = Date.now();
  updateRecenter(); updateZoomAuto();
});
// +/− on screen and on the keyboard.
function userZoom(dir) {
  if (nav.on) { nav.autoZoomPaused = true; nav.lastTouch = Date.now(); updateRecenter(); }
  const z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), map.getZoom() + dir));
  if (z === map.getZoom()) return;
  if (geo.follow !== 'free' && geo.me) { geo.progZoom = true; map.setZoomAround([geo.me.lat, geo.me.lon], z); }
  else map.setZoom(z);
  updateZoomAuto();
}
function updateZoomAuto() {
  const el = $('#zoomAuto');
  if (el) el.hidden = !(nav.on && state.settings.autoZoom && !nav.autoZoomPaused);
}

/* ---------- navigation to a point ---------- */
function startNav(target) {
  unlockAudio();
  if (compassNeedsPermission() && !geo.compassOn) enableCompass(); // iOS asks here, inside the tap on «Вести»
  else if (!compassNeedsPermission()) geo.compassOn = true;
  const top = topLayer();
  const replace = !!top && ['card', 'modal'].includes(top.kind);
  const again = nav.on; // a new target while navigating: same screen, new point
  if (again) { stopNavState(); if (replace) closeTop(); }
  Object.assign(nav, {
    on: true, target: { lat: +target.lat, lon: +target.lon, title: target.title || 'Точка' }, start: null, d: null, arrived: false, hold: false,
    zSpeed: 17, zoomCand: null, autoZoomPaused: false, firstPlace: true, lastTouch: 0, followBefore: null,
    offSince: 0, offCourse: null, hazard: null, banner: '', depth: null, depthT: 0, left: null,
  });
  store.set('ladoga-nav', { ...nav.target, t: Date.now() });
  if (!again) openLayer({ kind: 'nav', guard: navGuard, onClose: stopNav }, { replace });
  state.navHide = true; applyOverlays();
  drawNavTarget();
  $('#ntTarget').textContent = `→ ${nav.target.title}`;
  geoStart({});
  setFollow(state.settings.orient === 'course' ? 'course' : 'north');
  if (!geo.me) map.setView([nav.target.lat, nav.target.lon], Math.max(map.getZoom(), 13), { animate: false });
  wakeUpdate();
  navOnFix();
  updateNavFields(true);
  updateZoomAuto(); updateCompassBtn(); refreshMeIcon();
  if (!store.get('ladoga-nav-hint', false)) { store.set('ladoga-nav-hint', true); toast('Экран не будет гаснуть — навигатор расходует заряд, возьмите пауэрбанк', 6000); }
}
function stopNavState() {
  layers.nav.clearLayers(); layers.navHazards.clearLayers();
  setBanner(null);
  $('#recenter').hidden = true;
}
function stopNav() {
  if (!nav.on) return;
  nav.on = false;
  stopNavState();
  nav.target = null;
  store.set('ladoga-nav', null);
  state.navHide = false; applyOverlays();
  geo.iconKey = '';
  if (geo.me) setFollow('north'); else { setFollow('free'); map.setBearing(0); }
  wakeUpdate(); refreshMeIcon(); updateZoomAuto(); updateCompassBtn();
}
// Back / Esc in navigation asks first: a stray swipe must not drop the route.
function navGuard() {
  if (ui.endingNav) return true;
  setTimeout(() => confirmEndNav(true), 0);
  return false;
}
function confirmEndNav(detached = false) {
  if (!nav.on) return;
  openModal({
    key: 'nav-end', title: `Завершить навигацию к «${nav.target.title}»?`,
    body: () => (trk.cur?.state === 'rec' ? '<p>Запись трека продолжится.</p>' : '<p class="muted small">Карта останется на месте.</p>'),
    foot: () => `<button type="button" class="btn ghost" data-act="nav-continue">Продолжить</button><button type="button" class="btn danger" data-act="nav-end">Завершить</button>`,
    // Closed any other way than «Завершить»: navigation goes on, and Back must ask again next time.
    onClose: () => {
      if (ui.endingNav) return;
      const navL = ui.stack.find((l) => l.kind === 'nav');
      if (navL && !navL.attached) { navL.attached = true; history.pushState({ l: attachedCount() }, '', baseUrl()); }
    },
  }, { detached });
}
const navTargetIcon = L.divIcon({ className: '', html: '<div class="target-ring"></div>', iconSize: [34, 34], iconAnchor: [17, 17] });
const navLine = L.polyline([], { color: '#b00020', weight: 3, dashArray: '9 7', interactive: false });
const navArrive = L.circle([0, 0], { radius: 30, color: '#2b8a3e', weight: 2, dashArray: '4 6', fill: false, interactive: false });
function drawNavTarget() {
  layers.nav.clearLayers();
  navLine.setLatLngs([]).addTo(layers.nav);
  L.marker([nav.target.lat, nav.target.lon], { interactive: false, keyboard: false, icon: navTargetIcon }).addTo(layers.nav);
  L.marker([nav.target.lat, nav.target.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: `<svg class="i" style="width:28px;height:28px;color:#b00020;filter:drop-shadow(0 0 2px #fff)"><use href="#i-flag"/></svg>`, iconSize: [28, 28], iconAnchor: [4, 26] }) }).addTo(layers.nav);
}
// Shoals and hazards from the sailing directions, with their depths — the only points left on the map in navigation.
let HAZARDS = null;
function hazards() {
  if (HAZARDS && HAZARDS.n === state.M.length) return HAZARDS;
  HAZARDS = [];
  HAZARDS.n = state.M.length;
  state.M.forEach((m) => {
    if (m.kind !== 'hazard' && m.kind !== 'structure') return;
    const r = state.R[m.r[0]];
    // A bank is a danger to a boat only when it is shallow: the least depth from the sailing directions, ≤ 3 m.
    const least = parseFloat(String(r.depth || '').replace(',', '.'));
    if (r.kind === 'structure' && (!/банк|мел|риф|кос[аы]|камн|луд|отмел|гряд/i.test(`${r.title} ${r.comment}`) || !(least <= 3))) return;
    if (r.kind === 'hazard' && least > 3) return;
    HAZARDS.push({ lat: m.lat, lon: m.lon, name: poiLabel(r) || r.title || 'опасность', title: r.title || 'Опасность', depth: r.depth || '' });
  });
  return HAZARDS;
}
function drawNavHazards() {
  layers.navHazards.clearLayers();
  const me = geo.me;
  if (!nav.on) return;
  const t = nav.target;
  const from = me || nav.start || t;
  for (const h of hazards()) {
    const nearBoat = me && distM(me, h) < 1000;
    const nearLine = distToSegmentM(h, [from.lat, from.lon], [t.lat, t.lon]) < 300;
    if (!nearBoat && !nearLine) continue;
    L.marker([h.lat, h.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'poi', html: `<div class="shape hazard"></div><span class="poi-label" style="display:block">${esc(h.name)}</span>`, iconSize: [20, 18], iconAnchor: [10, 9] }) }).addTo(layers.navHazards);
  }
}
function hazardAhead(me) {
  const moving = courseValid();
  const range = Math.max(400, (geo.sog || 0) * 120);
  let best = null;
  for (const h of hazards()) {
    const d = distM(me, h);
    if (d > (moving ? range : 150)) continue;
    if (moving && Math.abs(angleDiff(geo.cog, bearing(me, h))) > 45) continue;
    if (!best || d < best.d) best = { ...h, d };
  }
  return best;
}
let hazardsDrawnAt = 0;
function navOnFix() {
  if (!nav.on) return;
  const me = geo.me, t = nav.target;
  if (me) {
    if (!nav.start) nav.start = { lat: me.lat, lon: me.lon };
    nav.d = distM(me, t); nav.brg = bearing(me, t);
    navLine.setLatLngs([[me.lat, me.lon], [t.lat, t.lon]]);
    const fresh = Date.now() - me.t < 10000;
    // Arrival: the radius never smaller than the GPS error allows.
    const R = Math.max(+state.settings.arrivalR || 30, Math.min(100, 1.5 * me.acc));
    if (nav.d < 500) { navArrive.setLatLng([t.lat, t.lon]).setRadius(R); if (!layers.nav.hasLayer(navArrive)) navArrive.addTo(layers.nav); }
    else if (layers.nav.hasLayer(navArrive)) layers.nav.removeLayer(navArrive);
    if (fresh && !nav.arrived && nav.d <= R) {
      nav.arrived = true; nav.arriveT = Date.now(); nav.hold = false; nav.left = null;
      navigator.vibrate?.([200, 100, 200]);
      beep('arrive');
    } else if (nav.arrived && nav.d > 2 * R) {
      nav.arrived = false; nav.hold = false; nav.left = nav.d; nav.leftT = Date.now();
    }
    if (nav.arrived && !nav.hold && Date.now() - nav.arriveT > 20000) nav.hold = true;
    // Off course: moving, far from the point, heading more than 30° away for 10 s.
    if (courseValid() && nav.d > 200) {
      const diff = angleDiff(geo.cog, nav.brg);
      if (Math.abs(diff) > 30) { if (!nav.offSince) nav.offSince = Date.now(); if (Date.now() - nav.offSince > 10000) nav.offCourse = diff; }
      else if (Math.abs(diff) < 15) { nav.offSince = 0; nav.offCourse = null; }
      else if (nav.offCourse != null) nav.offCourse = diff;
    } else { nav.offSince = 0; nav.offCourse = null; }
    // A shoal ahead — one at a time, the nearest; the sound no more than once in 5 minutes for the same one.
    const hz = fresh ? hazardAhead(me) : null;
    if (hz) {
      const k = `${hz.lat},${hz.lon}`;
      if (!nav.hazardSeen[k] || Date.now() - nav.hazardSeen[k] > 300000) { nav.hazardSeen[k] = Date.now(); beep('hazard'); navigator.vibrate?.([100, 60, 100, 60, 100]); }
    }
    nav.hazard = hz;
    if (Date.now() - hazardsDrawnAt > 5000) { hazardsDrawnAt = Date.now(); drawNavHazards(); }
  }
  if (geo.follow !== 'free' && me) {
    applyRotation();
    placeBoat(autoZoom());
  } else if (!me && geo.follow !== 'free') {
    /* waiting for GPS: the target stays on screen */
  }
  updateNavFields();
  refreshMeIcon();
}
// Two minutes of travel ahead on screen, and the point in view on approach (§7.3).
function autoZoom() {
  if (!state.settings.autoZoom || nav.autoZoomPaused || !geo.me) return null;
  const me = geo.me, fr = mapFreeRect();
  const freeH = fr.bottom - fr.top, freeW = fr.right - fr.left;
  const rotated = geo.follow === 'course' || geo.follow === 'compass';
  const aheadPx = rotated ? 0.72 * freeH : 0.45 * Math.min(freeW, freeH);
  const k = 156543.03 * Math.cos(toRad(me.lat));
  const sog = geo.sog || 0;
  if (sog * 3.6 >= 3) nav.zSpeed = Math.floor(Math.log2(k * aheadPx / Math.max(150, sog * 120)));
  const d = nav.d ?? Infinity;
  const zd = d < 2000 ? Math.floor(Math.log2(k * 0.8 * aheadPx / Math.max(d, 15))) : -Infinity;
  let z = nav.hold ? 18 : Math.max(nav.zSpeed, zd);
  z = Math.max(12, Math.min(18, z));
  const cur = map.getZoom();
  if (nav.firstPlace) { nav.firstPlace = false; nav.zoomCand = null; return z; }
  if (z === cur) { nav.zoomCand = null; return null; }
  if (nav.zoomCand !== z) { nav.zoomCand = z; nav.zoomCandT = Date.now(); return null; }
  if (Date.now() - nav.zoomCandT < (z > cur ? 4000 : 8000)) return null;
  nav.zoomCandT = Date.now();
  return cur + Math.sign(z - cur);
}
function recenter() {
  nav.autoZoomPaused = false;
  nav.firstPlace = true;
  setFollow(nav.followBefore || (state.settings.orient === 'course' ? 'course' : 'north'));
  nav.followBefore = null;
  updateRecenter(); updateZoomAuto();
  navOnFix();
}
function updateRecenter() {
  const el = $('#recenter');
  const show = nav.on && (geo.follow === 'free' || nav.autoZoomPaused);
  el.hidden = !show;
  if (!show) return;
  const ar = +state.settings.autoReturn;
  const left = ar ? ar * 1000 - (Date.now() - nav.lastTouch) : Infinity;
  $('#recenterText').textContent = left <= 3000 ? `Вернуться ко мне · ${Math.max(1, Math.ceil(left / 1000))}` : 'Вернуться ко мне';
}
function wholeRoute() {
  if (!nav.on) return;
  nav.followBefore = geo.follow === 'free' ? nav.followBefore : geo.follow;
  setFollow('free');
  map.setBearing(0);
  const pts = [[nav.target.lat, nav.target.lon]];
  if (geo.me) pts.push([geo.me.lat, geo.me.lon]);
  map.fitBounds(L.latLngBounds(pts), fitPadding());
  nav.lastTouch = Date.now();
  updateRecenter();
}

/* ---------- the navigation screen ---------- */
function updateNavArrow() {
  if (!nav.on) return;
  const me = geo.me;
  const box = $('#ntArrowBox'), arrow = $('#ntArrow');
  if (!me) { box.classList.add('north'); arrow.style.transform = 'rotate(0deg)'; return; }
  const brg = bearing(me, nav.target);
  const hd = headingNow();
  box.classList.toggle('north', !hd);
  arrow.style.transform = `rotate(${Math.round(hd ? angleDiff(hd.h, brg) : brg)}deg)`;
}
function updateNavFields(force = false) {
  if (!nav.on) return;
  const now = Date.now();
  if (!force && now - nav.lastFields < 900) return;
  nav.lastFields = now;
  const me = geo.me, t = nav.target;
  const setText = (sel, v) => { const el = $(sel); if (el && el.textContent !== v) el.textContent = v; };
  const gpsDot = $('#ntGps .gps-dot');
  if (!me) {
    setText('#ntDist', '—');
    setText('#ntLine2', geo.error === 1 ? 'Геопозиция запрещена' : 'Ищу спутники… На открытом месте это до минуты.');
    setText('#nfSpeed', '—'); setText('#nfCourse', '—'); setText('#nfCourseSrc', 'нет GPS');
    gpsDot.className = 'gps-dot'; setText('#ntGpsText', 'GPS');
    updateNavArrow(); navBanner(); updateRecenter();
    return;
  }
  const age = now - me.t;
  const stale = age > 10000;
  const d = distM(me, t), brg = bearing(me, t);
  if (nav.hold) {
    const from = bearing(t, me);
    setText('#ntDist', `Снос ${Math.round(d)} м`);
    setText('#ntLine2', `${rumb(from)} от точки · держу точку`);
  } else {
    setText('#ntDist', fmtDist(d));
    let eta = '';
    if (courseValid()) {
      const vmg = geo.sog * Math.cos(toRad(brg - geo.cog));
      if (vmg * 3.6 >= 1) { const ms = (d / vmg) * 1000; eta = `в ${fmtTime(now + ms)} (${fmtDur(ms)})`; }
      else if (vmg < -0.3) eta = 'удаляетесь';
    }
    setText('#ntLine2', `на ${Math.round(brg)}° ${rumb(brg)}${eta ? ` · ${eta}` : ''}`);
  }
  // GPS quality: colour and words, not colour alone.
  gpsDot.className = `gps-dot ${stale ? 'r' : me.acc <= 10 ? 'g' : me.acc <= 30 ? 'y' : 'r'}`;
  setText('#ntGpsText', stale ? `${fmtClock(age)} назад` : `±${Math.round(me.acc)} м`);
  // Speed, course, depth.
  $('#navBottom').classList.toggle('stale', stale);
  setText('#nfSpeed', speedValue(geo.sog));
  const unit = $('#nfSpeed')?.nextElementSibling; if (unit && unit.textContent !== speedUnit()) unit.textContent = speedUnit();
  $('#nfSpeed').parentElement.classList.toggle('stale', stale);
  const hd = headingNow();
  setText('#nfCourse', hd ? `${Math.round(hd.h)}°` : '—');
  setText('#nfCourseSrc', hd ? `${rumb(hd.h)} · ${hd.src === 'gps' ? 'по GPS' : 'компас'}` : (geo.sog != null && geo.sog * 3.6 < 3 ? 'стоим' : 'нет курса'));
  if (now - nav.depthT > 3000 || force) {
    nav.depthT = now;
    nav.depth = depthAt(me);
  }
  const dep = nav.depth;
  const depText = !dep ? '—' : dep.value != null ? String(dep.value).replace('.', ',') : `${dep.min}–${dep.max}`;
  setText('#nfDepth', depText);
  const depUnit = $('#nfDepth')?.nextElementSibling;
  const du = dep ? 'м · по карте' : 'нет карты';
  if (depUnit && depUnit.textContent !== du) depUnit.textContent = du;
  $('#nfDepthBox').classList.toggle('shallow', !!dep && (dep.value ?? dep.max) <= (+state.settings.shallow || 2));
  updateNavArrow();
  navBanner();
  updateRecenter();
  updateTrackUi();
}
// One banner at a time: GPS lost > shoal ahead > arrival > off course.
function navBanner() {
  const me = geo.me;
  let b = null;
  const age = me ? Date.now() - me.t : 0;
  if (me && age > 60000) b = { cls: 'danger', key: `gps${Math.floor(age / 1000)}`, html: `Нет сигнала GPS ${fmtClock(age)}. Выйдите на открытое место, не закрывайте приложение.` };
  else if (nav.hazard) {
    const h = nav.hazard;
    const where = courseValid() ? 'впереди' : 'рядом';
    b = { cls: h.d < 150 ? 'danger' : '', key: `hz${h.lat}${Math.round(h.d / 10)}`, html: `${ic('warning')} ${esc(h.name)} — ${fmtDist(h.d)} ${where}` };
  } else if (nav.arrived) {
    b = { cls: 'ok', key: `arr${nav.hold}`, html: `<span>${ic('check-circle')} ${nav.hold ? 'Держу точку' : 'Вы на месте'} · ${esc(nav.target.title)}</span><span class="nbb"><button type="button" data-act="nav-end-ask">Завершить</button><button type="button" data-act="nav-mark">Отметить</button>${nav.hold ? '' : '<button type="button" data-act="nav-hold">Держать точку</button>'}</span>` };
  } else if (nav.left != null && Date.now() - nav.leftT < 10000) {
    b = { cls: '', key: `left${Math.round(nav.left)}`, html: `Ушли с точки на ${fmtDist(nav.left)}` };
  } else if (nav.offCourse != null) {
    const a = Math.round(Math.abs(nav.offCourse) / 5) * 5;
    b = { cls: '', key: `off${a}${nav.offCourse > 0}`, html: `${ic(nav.offCourse > 0 ? 'chevron-right' : 'chevron-left')} Поверните ${nav.offCourse > 0 ? 'правее' : 'левее'} на ${a}°` };
  }
  setBanner(b);
}
function setBanner(b) {
  const el = $('#navBanner');
  if (!b) { if (!el.hidden) { el.hidden = true; nav.banner = ''; } return; }
  if (nav.banner !== b.key) { nav.banner = b.key; el.className = `nav-banner ${b.cls}`; el.innerHTML = b.html; }
  el.hidden = false;
}
// «Завершить»: the confirmation and the navigation leave together.
function endNav() {
  const i = ui.stack.findIndex((l) => l.kind === 'nav');
  if (i < 0) { closeTop(); return; }
  ui.endingNav = true;
  closeLayers(ui.stack.length - i);
}
function handleNavAction(act, el) {
  switch (act) {
    case 'nav-continue': closeTop(); break;
    case 'nav-end': endNav(); break;
    case 'nav-end-ask': confirmEndNav(false); break;
    case 'nav-hold': nav.hold = true; navBanner(); navOnFix(); break;
    case 'nav-mark': quickMark(); break;
    case 'nav-whole': closeTop(); wholeRoute(); break;
    case 'nav-orient': {
      const v = el.dataset.val;
      closeTop();
      const go = () => { nav.followBefore = v; setFollow(v); };
      if (v === 'compass') enableCompass().then((ok) => { if (ok) go(); }); else go();
      break;
    }
    default: return false;
  }
  return true;
}
function openNavMore() {
  const cur = geo.follow === 'free' ? (nav.followBefore || 'north') : geo.follow;
  openModal({
    key: 'nav-more', title: 'Навигация',
    body: () => `
      ${listRow({ icon: 'route', title: 'Весь путь', sub: 'я и точка на одном экране', attrs: 'data-act="nav-whole"' })}
      <h3>Карта</h3>
      <div class="seg">${[['north', 'Север'], ['course', 'По курсу'], ['compass', 'По компасу']].map(([k, t]) => `<button type="button" data-act="nav-orient" data-val="${k}" class="${cur === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      ${sw('autoZoom', 'Автомасштаб', 'по скорости и расстоянию до точки')}
      ${sw('navShowPoints', 'Показать точки рыбаков')}
      <label class="check switch"><span>Ночная палитра</span><input type="checkbox" data-night ${document.documentElement.dataset.theme === 'night' ? 'checked' : ''}></label>
      ${sw('sound', 'Звук прибытия и опасности')}
      ${sw('keepAwake', 'Не гасить экран и после навигации')}
      <div class="small muted" style="margin-top:8px">Радиус прибытия</div>
      ${seg('arrivalR', [[15, '15 м'], [30, '30 м'], [50, '50 м'], [100, '100 м']], state.settings.arrivalR)}
      <div class="small muted" style="margin-top:8px">Скорость</div>
      ${seg('units', [['kmh', 'км/ч'], ['kn', 'узлы']], state.settings.units)}
      <p class="small muted">Цель: ${esc(nav.target.title)} · ${fmtDM(nav.target.lat, nav.target.lon)}</p>`,
  });
}
function onSettingChange(key) {
  if (key === 'units') updateNavFields(true);
  if (key === 'autoZoom') { updateZoomAuto(); if (nav.on) { nav.firstPlace = true; navOnFix(); } }
  if (key === 'orient' && nav.on && geo.follow !== 'free') setFollow(state.settings.orient === 'course' ? 'course' : 'north');
}

/* ---------- sound, wake lock, the page going to the background ---------- */
function unlockAudio() {
  try {
    if (!nav.audio) nav.audio = new (window.AudioContext || window.webkitAudioContext)();
    if (nav.audio.state === 'suspended') nav.audio.resume();
    // iPhone: play even with the ring/silent switch on silent.
    if (navigator.audioSession && state.settings.sound) navigator.audioSession.type = 'playback';
  } catch { nav.audio = null; }
}
function beep(kind) {
  if (!state.settings.sound || !nav.audio) return;
  try {
    const ctx = nav.audio, t0 = ctx.currentTime + 0.02;
    const tones = kind === 'arrive' ? [[880, 0, 0.18], [1175, 0.22, 0.32]] : [[660, 0, 0.14], [660, 0.22, 0.14], [660, 0.44, 0.14]];
    for (const [f, s, dur] of tones) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + s);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + s + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0 + s); o.stop(t0 + s + dur + 0.05);
    }
  } catch { /* no sound */ }
}
let wakeLock = null;
async function wakeUpdate() {
  const want = nav.on || trk.cur?.state === 'rec' || state.settings.keepAwake;
  if (want && !wakeLock && document.visibilityState === 'visible' && navigator.wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      if (!store.get('ladoga-wake-warned', false)) { store.set('ladoga-wake-warned', true); toast('Экран может погаснуть — отключите автоблокировку на время рыбалки', 6000); }
    }
  } else if (!want && wakeLock) {
    try { await wakeLock.release(); } catch { /* ignore */ }
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { geo.hiddenAt = Date.now(); if (typeof saveCurTrack === 'function') saveCurTrack(true); return; }
  const gap = geo.hiddenAt ? Date.now() - geo.hiddenAt : 0;
  geo.hiddenAt = 0;
  wakeUpdate();
  // Fixes sometimes freeze after the page comes back: start the watch again.
  if (geo.watchId != null) restartWatch();
  if (gap > 30000 && (nav.on || trk.cur?.state === 'rec')) {
    toast(`Пока приложение было свёрнуто, навигация и трек не работали (${fmtDur(gap)}).`, 6000);
    if (typeof trackOnResume === 'function') trackOnResume(gap);
  }
});
// Once a second: stale fixes turn grey, timers run, the recenter countdown ticks.
setInterval(() => {
  if (document.hidden) return;
  if (geo.me) refreshMeIcon();
  if (nav.on) {
    updateNavFields();
    const ar = +state.settings.autoReturn;
    if (ar && (geo.follow === 'free' || nav.autoZoomPaused) && Date.now() - nav.lastTouch > ar * 1000) recenter();
  }
  if (typeof updateTrackUi === 'function') updateTrackUi();
}, 1000);
