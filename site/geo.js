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
  rotT: 0, progZoom: false, fastSince: 0, hiddenAt: 0, pressed: false, restartT: 0,
};
const nav = {
  on: false, target: null, start: null, d: null, brg: null, arrived: false, arriveT: 0, hold: false,
  zSpeed: 17, zoomCand: null, zoomCandT: 0, autoZoomPaused: false, firstPlace: true, lastTouch: 0, followBefore: null,
  offSince: 0, offCourse: null, hazard: null, hazardSeen: {}, banner: '', depth: null, depthT: 0, left: null, leftT: 0,
  audio: null, lastFields: 0, trail: [], said: {},
};

/* ---------- demo: a boat going to the Varetsky banks, to try the navigator at home ---------- */
// The route runs over 3–5 m of water north of Птинов: a shallow bank ahead, a leg off course, then arrival.
const DEMO = { on: false, timer: null, speed: 10, route: [[60.2835, 32.0845], [60.2870, 32.0835], [60.2905, 32.0955], [60.2907, 32.0985], [60.298, 32.107]], seg: 0, pos: null, t: 0 };
function destPoint(p, brg, d) {
  const lat = p.lat + (d * Math.cos(toRad(brg))) / 111320;
  return { lat, lon: p.lon + (d * Math.sin(toRad(brg))) / (111320 * Math.cos(toRad(lat))) };
}
function startDemo() {
  if (nav.on) { toast('Сначала завершите навигацию'); return; }
  if (geo.watchId != null && geo.watchId !== 'demo') gps.clear(geo.watchId);
  Object.assign(geo, { watchId: 'demo', me: null, hist: [], sog: null, cog: null, cogVec: null, fastSince: 0, courseRot: false });
  layers.me.clearLayers();
  Object.assign(DEMO, { on: true, seg: 0, t: 0, pos: { lat: DEMO.route[0][0], lon: DEMO.route[0][1] } });
  $('#demoTag').hidden = false;
  startNav({ lat: 60.298, lon: 32.107, title: 'Варецкие банки · демо' });
  clearInterval(DEMO.timer);
  DEMO.timer = setInterval(demoTick, 1000);
  demoTick();
}
function demoTick() {
  if (!DEMO.on) return;
  let step = DEMO.speed, hdg = 0, speed = DEMO.speed;
  if (DEMO.seg < DEMO.route.length - 1) {
    while (step > 0 && DEMO.seg < DEMO.route.length - 1) {
      const to = { lat: DEMO.route[DEMO.seg + 1][0], lon: DEMO.route[DEMO.seg + 1][1] };
      const d = distM(DEMO.pos, to);
      hdg = bearing(DEMO.pos, to);
      if (d <= step) { DEMO.pos = to; step -= d; DEMO.seg += 1; } else { DEMO.pos = destPoint(DEMO.pos, hdg, step); step = 0; }
    }
  } else {
    // At the point: a slow drift in a circle, to show «держу точку» and the drift.
    DEMO.t += 1; hdg = (DEMO.t * 8) % 360; speed = 0.4;
    DEMO.pos = destPoint(DEMO.pos, hdg, 0.4);
  }
  onFix({ coords: { latitude: DEMO.pos.lat, longitude: DEMO.pos.lon, accuracy: 4, speed, heading: hdg }, timestamp: Date.now() });
}
function stopDemo() {
  if (!DEMO.on) return;
  clearInterval(DEMO.timer);
  DEMO.on = false;
  $('#demoTag').hidden = true;
  if (geo.watchId === 'demo') { geo.watchId = null; geo.me = null; geo.sog = null; geo.cog = null; layers.me.clearLayers(); }
  if (geo.follow !== 'free') setFollow('free');
  updateLocateBtn();
  toast('Демо закончено');
}

/* ---------- the dark screen: recording and navigation go on, the OLED screen spends almost nothing ---------- */
const saver = { on: false, tapT: 0, pendingT: 0 };
function showSaver() {
  if (saver.on) return;
  const top = topLayer();
  if (top?.kind === 'modal') {
    // Called from a sheet: the sheet closes through Back first, and the screen goes dark once it has
    // (the popstate of that Back must not wake it at once — ui.js asks saverAfterBack()).
    if (top.attached) { saver.pendingT = Date.now(); closeTop(); return; }
    closeTop();
  }
  saver.on = true;
  const el = document.createElement('div');
  el.className = 'saver'; el.id = 'saver';
  el.innerHTML = '<b id="saverMain"></b><span id="saverSub"></span><small>Экран почти не тратит заряд, GPS и голос работают. Вернуть карту — нажмите и держите секунду.<br>Не блокируйте телефон кнопкой: тогда телефон останавливает приложение.</small>';
  logEvent('saver_on');
  // A long press, not a double tap: a phone in a pocket or a glove taps twice by itself.
  el.addEventListener('pointerdown', () => { clearTimeout(saver.holdT); saver.holdT = setTimeout(hideSaver, 900); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => clearTimeout(saver.holdT));
  document.body.appendChild(el);
  map.getContainer().style.visibility = 'hidden';
  updateSaver();
}
// The Back that closed the sheet under «Погасить экран»: true once, within 2 s of the tap.
function saverAfterBack() {
  const t = saver.pendingT;
  saver.pendingT = 0;
  return !!t && Date.now() - t < 2000;
}
function hideSaver() {
  if (!saver.on) return;
  saver.on = false;
  $('#saver')?.remove();
  map.getContainer().style.visibility = '';
  map.invalidateSize();
  if (geo.follow !== 'free' && geo.me) placeBoat(null, false);
}
function updateSaver() {
  if (!saver.on) return;
  const me = geo.me, t = trk.cur;
  let main = '', sub = '';
  if (nav.on) {
    main = me ? (nav.hold ? `Снос ${Math.round(nav.d || 0)} м` : fmtDist(nav.retrace ? nav.retrace.left : nav.d ?? distM(me, nav.target))) : '—';
    sub = me ? `на ${Math.round(nav.brg ?? bearing(me, nav.target))}° ${rumb(nav.brg ?? 0)} · ${speedValue(geo.sog)} ${speedUnit()}` : 'Жду GPS';
  } else if (t) {
    main = fmtClock(trackDur(t));
    sub = `Запись · ${fmtDist(t.dist)} · ${me ? `GPS ±${Math.round(me.acc)} м` : 'жду GPS'}`;
  } else if (guard.on) {
    main = guard.anchor ? `${Math.round(guard.d || 0)} м` : '…';
    sub = guard.anchor ? `Сторож: от места · тревога после ${guard.r} м` : 'Сторож запоминает место';
  } else { hideSaver(); return; }
  $('#saverMain').textContent = main;
  $('#saverSub').textContent = sub;
}

/* ---------- position ---------- */
// Every GPS request goes through here. In a browser it is navigator.geolocation; an app build for iPhone/Android
// (a Capacitor shell with background location — the only way to keep a track with the phone locked) puts its own
// object with the same three calls into window.LadogaNative.gps, and nothing else in the app changes.
const gps = {
  src: () => window.LadogaNative?.gps || navigator.geolocation,
  watch: (ok, err, opts) => gps.src().watchPosition(ok, err, opts),
  once: (ok, err, opts) => gps.src().getCurrentPosition(ok, err, opts),
  clear: (id) => gps.src().clearWatch(id),
};
function geoStart({ follow = null } = {}) {
  if (!navigator.geolocation) { showLocationHelp('unsupported'); return false; }
  if (follow) geo.wantFollow = follow;
  if (geo.watchId != null) { if (geo.me && geo.wantFollow) applyWantFollow(); return true; } // also the demo
  if (platformInfo().inApp && !store.get('ladoga-inapp-warned', false)) { store.set('ladoga-inapp-warned', true); showLocationHelp('inapp'); }
  geo.searching = true; geo.error = null;
  // A quick coarse fix first (Safari answers it in a second or two from Wi‑Fi), then a high-accuracy watch
  // without a timeout: on the water GPS may need a minute.
  gps.once(onFix, onGeoError, { enableHighAccuracy: false, maximumAge: 120000, timeout: 15000 });
  geo.watchId = gps.watch(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 1000 });
  store.set('ladoga-geo-on', true);
  if (!geo.me) toast(isIOS() ? 'Определяю, где вы… iPhone спросит — выберите «При использовании приложения», тогда он не будет спрашивать каждый раз' : 'Определяю, где вы… Если телефон спросит — разрешите геопозицию', 5000);
  updateLocateBtn();
  logEvent('geo_start');
  return true;
}
function restartWatch() {
  if (geo.watchId == null || geo.watchId === 'demo') return;
  gps.clear(geo.watchId);
  geo.watchId = gps.watch(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 1000 });
  geo.restartT = Date.now();
}
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// At launch: GPS comes on by itself only if the phone already allows it for good (no question on the screen), and
// only for someone who used it last time. An iPhone that asks on every launch was given «Разрешить один раз»:
// say once how to make it «При использовании приложения».
async function geoAutoStart() {
  let st = '';
  try { st = (await navigator.permissions?.query({ name: 'geolocation' }))?.state || ''; } catch { /* old Safari */ }
  logEvent('geo_permission', { state: st || 'unknown' });
  if (st === 'granted' && store.get('ladoga-geo-on', false) && geo.watchId == null) geoStart({});
  else if (st === 'prompt' && isIOS() && store.get('ladoga-geo-on', false) && Date.now() - store.get('ladoga-ios-geo-tip', 0) > 3 * 86400000) {
    store.set('ladoga-ios-geo-tip', Date.now());
    setTimeout(() => showLocationHelp('ios-once'), 1500);
  }
}
function geoRestart() {
  if (DEMO.on) stopDemo();
  if (geo.watchId != null && geo.watchId !== 'demo') gps.clear(geo.watchId);
  geo.watchId = null;
  geoStart({ follow: geo.follow !== 'free' ? geo.follow : 'north' });
}
function geoStop() {
  if (DEMO.on) stopDemo();
  if (geo.watchId != null && geo.watchId !== 'demo') gps.clear(geo.watchId);
  geo.watchId = null; geo.me = null; geo.searching = false; geo.sog = null; geo.cog = null; geo.hist = [];
  layers.me.clearLayers();
  setFollow('free');
  updateLocateBtn(); renderChips();
}
function onFix(pos) {
  const c = pos.coords;
  const t = Date.now();
  const acc = c.accuracy || 9999;
  // The same fix once more (a saved copy handed out again): nothing new, and no zero speed out of it.
  if (geo.me && c.latitude === geo.me.lat && c.longitude === geo.me.lon && pos.timestamp && pos.timestamp === geo.me.ts) return;
  // A coarse Wi‑Fi fix must not overwrite a good GPS one that arrived a moment earlier.
  if (geo.me && acc > Math.max(50, geo.me.acc * 2) && t - geo.me.t < 10000) return;
  const p = { lat: c.latitude, lon: c.longitude, acc, t, ts: pos.timestamp || 0 };
  const first = !geo.me;
  geo.searching = false; geo.error = null;
  if (acc <= 100) motion(p, c);
  geo.me = { ...p, sog: geo.sog, cog: geo.cog };
  geo.hist.push(p);
  while (geo.hist.length > 2 && t - geo.hist[0].t > 30000) geo.hist.shift();
  logFix(p, c);
  // Turn the picture first, then move the boat: its glide to the new fix then runs in the new picture.
  if (geo.follow !== 'free' && !geo.pressed && !saver.on) applyRotation();
  drawMe();
  if (geo.wantFollow) applyWantFollow();
  else if (first && !nav.on && geo.follow === 'free') updateLocateBtn();
  if (nav.on) navOnFix(); else followMe();
  if (typeof trackOnFix === 'function') trackOnFix(geo.me);
  guardOnFix(geo.me);
  if (geo.mobWait) { geo.mobWait = false; manOverboard(); }
  updateCardLive();
  updateLocateBtn();
  renderChips();
}
// Speed over ground and course over ground (§8.4). The speed is the phone's own (GPS Doppler), as it is: it is
// right at 5 and at 150 km/h. An iPhone says −1 when it does not know — that is «no value», not a speed (mixed into
// an average it pulled the figure down, worst at high speed). Without it: the way made over the last 4 s.
function motion(p, c) {
  let v = null;
  if (Number.isFinite(c.speed) && c.speed >= 0) v = c.speed;
  else {
    const ref = findHist(p.t, 4000);
    if (ref) v = distM(ref, p) < Math.max(ref.acc, p.acc) / 2 ? 0 : distM(ref, p) / ((p.t - ref.t) / 1000);
  }
  if (v != null) geo.sog = v;
  // Standing still: the wander of the fix is not speed.
  const ref5 = findHist(p.t, 5000);
  if (geo.sog != null && geo.sog * 3.6 < 1 && ref5 && distM(ref5, p) < p.acc) geo.sog = 0;
  // Course up starts after 3 s at 5 km/h or more and stops below 3 km/h: the picture does not swing at a drift.
  const kmh = (geo.sog || 0) * 3.6;
  if (kmh >= 5) { if (!geo.fastSince) geo.fastSince = p.t; if (p.t - geo.fastSince >= 3000) geo.courseRot = true; } else geo.fastSince = 0;
  if (kmh < 3) geo.courseRot = false;
  let h = null;
  // The phone's course is −1 or NaN when unknown (iPhone), the same as no value.
  if (geo.sog != null && geo.sog * 3.6 >= 3 && Number.isFinite(c.heading) && c.heading >= 0) h = c.heading;
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
    if (!geo.pressed && (geo.follow === 'compass' || (geo.follow === 'course' && !geo.courseRot))) { applyRotation(); placeBoat(null, false); }
    if (nav.on) updateNavArrow();
  });
}
window.addEventListener('deviceorientationabsolute', onOrientation);
window.addEventListener('deviceorientation', onOrientation);

/* ---------- the «me» marker: a dot with a direction cone; in navigation a boat arrow ---------- */
// Made with its own icon: the default one would first ask for vendor/images/marker-icon.png (there is none).
const meMarker = L.marker([0, 0], { icon: meIcon('dot'), interactive: false, keyboard: false, rotateWithView: true, rotation: 0, zIndexOffset: 1000 });
const meCircle = L.circle([0, 0], { radius: 1, color: '#1c7ed6', weight: 1, fillOpacity: 0.14, interactive: false });
// `glide`: the icon moves to a new fix in 0.9 s (CSS), in step with the map that glides under it (placeBoat).
function meIcon(kind, stale, cone) {
  if (kind === 'boat') return L.divIcon({ className: `boat glide${stale ? ' stale' : ''}`, html: '<svg viewBox="0 0 100 100"><path d="M50 6 82 90 50 71 18 90Z"/></svg>', iconSize: [32, 32], iconAnchor: [16, 16] });
  return L.divIcon({ className: 'glide', html: `<div class="me-wrap${stale ? ' stale' : ''}">${cone ? '<div class="me-cone"></div>' : ''}<div class="me-dot"></div></div>`, iconSize: [60, 60], iconAnchor: [30, 30] });
}
function drawMe() {
  const me = geo.me;
  if (!me) return;
  if (!layers.me.hasLayer(meMarker)) { geo.iconKey = ''; meCircle.addTo(layers.me); meMarker.addTo(layers.me); }
  meMarker.setLatLng([me.lat, me.lon]);
  // The error circle cannot glide with the boat; while the map follows and the fix is good it is not needed.
  const hideCircle = geo.follow !== 'free' && me.acc <= 25;
  meCircle.setLatLng([me.lat, me.lon]).setRadius(me.acc || 1).setStyle({ opacity: hideCircle ? 0 : 1, fillOpacity: hideCircle ? 0 : 0.14 });
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
  if (mode === 'north' && map.getBearing() !== 0) map.setBearing(0);
  if (f && geo.me) { applyRotation(true); placeBoat(null, true); }
  updateLocateBtn(); updateCompassBtn(); refreshMeIcon(); drawMe();
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
  if (!geo.me || geo.follow === 'free' || saver.on) return;
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
  const turning = nav.on && label !== 'Север';
  b.classList.toggle('on', turning); b.setAttribute('aria-pressed', String(turning));
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
  // leaflet-rotate puts every marker in its new place on a turn: the boat must jump with the picture, not glide
  // after it (the glide is for a new fix only).
  const box = map.getContainer();
  box.classList.add('no-glide');
  // The map turns round the boat, not round the middle of the screen: the boat stands low (72 % of the height), and a
  // turn about the middle swung it up to 90 px sideways on every step, gliding back a second later (26.09.2026).
  // (Not while the map glides or zooms: that animation would overwrite the shift — placeBoat sets it right then.)
  const me = geo.me, hold = me && geo.follow !== 'free' && !geo.pressed && !map._animatingZoom && !map._panAnim?._inProgress;
  const before = hold ? map.latLngToContainerPoint([me.lat, me.lon]) : null;
  map.setBearing((cur + diff + 360) % 360);
  if (before) {
    const moved = map.latLngToContainerPoint([me.lat, me.lon]).subtract(before);
    if (Math.abs(moved.x) >= 1 || Math.abs(moved.y) >= 1) map.panBy(moved, { animate: false, noMoveStart: true });
  }
  void box.offsetWidth;
  box.classList.remove('no-glide');
}

/* ---------- keep the boat where it belongs on screen ---------- */
// Boat in the middle of the free area (north up) or at 72 % of its height (course up); z = zoom to step to.
// On a new fix the map glides there in 0.9 s, straight and even, and the boat icon glides with it (.glide in CSS):
// the boat stays put on the screen and the water moves under it — the way the «СПб Топливо» navigator does it.
function placeBoat(z, glide = true) {
  const me = geo.me;
  if (!me || geo.follow === 'free' || geo.pressed) return;
  const fr = mapFreeRect();
  // Course (or compass) up: low on the screen whatever the bearing. It was decided by the bearing: a map not turned yet
  // (the start, before the first course) or left exactly on north put the boat in the middle, and the next turn threw
  // it 140 px down, gliding (26.09.2026).
  const rotated = geo.follow === 'course' || geo.follow === 'compass';
  const yShare = rotated ? 0.72 : 0.5;
  const want = L.point((fr.left + fr.right) / 2, fr.top + yShare * (fr.bottom - fr.top));
  const boat = map.latLngToContainerPoint([me.lat, me.lon]);
  // Never past the edge of the area: Leaflet would pull the map straight back, and the two fought on every fix
  // (the map jerked once a second when someone was near the edge, e.g. in Saint Petersburg).
  if (boat.distanceTo(want) >= 1 && (z == null || z === map.getZoom())) {
    const mid = map.getSize().divideBy(2);
    const to = map._limitCenter(map.containerPointToLatLng(mid.add(boat.subtract(want))), map.getZoom(), map.options.maxBounds);
    const shift = map.latLngToContainerPoint(to).subtract(mid);
    const far = Math.abs(shift.x) > map.getSize().x || Math.abs(shift.y) > map.getSize().y;
    if (Math.abs(shift.x) >= 1 || Math.abs(shift.y) >= 1) {
      map.panBy(shift, glide && !far ? { animate: true, duration: 0.9, easeLinearity: 1, noMoveStart: true } : { animate: false });
    }
  }
  if (!geo.outsideSaid && !MAX_BOUNDS.contains([me.lat, me.lon])) {
    geo.outsideSaid = true;
    toast('Вы за пределами карты района — она держится у своего края', 5000);
  }
  if (z != null && z !== map.getZoom()) {
    geo.progZoom = true;
    // Leaflet starts a zoom animation only on the next frame: until then getZoom() still says the old zoom.
    geo.zoomTarget = z; geo.zoomTargetT = Date.now();
    map.setZoomAround([me.lat, me.lon], z, { animate: true });
  }
}
map.on('zoomend', () => { geo.progZoom = false; geo.zoomTarget = null; updateZoomAuto(); if (geo.follow !== 'free' && !geo.pressed) placeBoat(null, false); });
// A finger on the map lets go of the boat at once — a drag, a pinch, a double tap or the wheel — and the map stays
// where the hand put it: no fix moves it. It comes back to the boat by the «К лодке» button, or by itself
// (Настройки → «Возвращать к лодке»), counted from the moment the finger is lifted and never under a finger
// or with a card open.
function letGo() {
  geo.userTouchT = Date.now();
  if (nav.wholeView) { nav.wholeView = false; setTimeout(updateZoomAuto, 0); }
  if (nav.on) nav.lastTouch = Date.now();
  if (geo.follow === 'free') return;
  if (nav.on) nav.followBefore = geo.follow;
  map.stop?.();
  setFollow('free');
  logEvent('map_free');
}
geo.userTouchT = 0;
{
  const box = map.getContainer();
  box.addEventListener('pointerdown', () => { geo.pressed = true; geo.userTouchT = Date.now(); if (nav.on) nav.lastTouch = Date.now(); }, { capture: true, passive: true });
  const up = () => { if (!geo.pressed) return; geo.pressed = false; geo.userTouchT = Date.now(); if (nav.on) { nav.lastTouch = Date.now(); updateRecenter(); } };
  window.addEventListener('pointerup', up, { passive: true });
  window.addEventListener('pointercancel', up, { passive: true });
  box.addEventListener('touchstart', (e) => { if (e.touches.length > 1) letGo(); }, { capture: true, passive: true });
  box.addEventListener('wheel', letGo, { capture: true, passive: true });
  box.addEventListener('dblclick', letGo, { capture: true, passive: true });
}
map.on('dragstart', letGo);
// A zoom by the user's own fingers or wheel: the zoom stays theirs until «Авто» is pressed again.
map.on('zoomstart', () => {
  if (geo.progZoom || !nav.on || Date.now() - geo.userTouchT > 1500) return;
  nav.autoZoomPaused = true; nav.lastTouch = Date.now();
  updateRecenter(); updateZoomAuto();
});
// +/− on screen and on the keyboard. Leaflet silently drops a zoom asked for during a zoom animation (250 ms):
// a press then counts from where the animation is going and waits for its end, so every press is a step.
geo.zoomWant = null;
function userZoom(dir) {
  if (nav.on) { nav.autoZoomPaused = true; nav.lastTouch = Date.now(); updateRecenter(); updateZoomAuto(); }
  const pending = geo.zoomTarget != null && Date.now() - geo.zoomTargetT < 1000 ? geo.zoomTarget : null;
  const from = geo.zoomWant ?? pending ?? (map._animatingZoom ? map._animateToZoom : map.getZoom());
  const z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), from + dir));
  if (z === from) return;
  geo.zoomWant = z;
  applyUserZoom();
  updateZoomAuto();
}
function applyUserZoom() {
  const z = geo.zoomWant;
  if (z == null) return;
  const pending = geo.zoomTarget != null && Date.now() - geo.zoomTargetT < 1000;
  if (map._animatingZoom || pending) { map.once('zoomend', () => setTimeout(applyUserZoom, 0)); return; }
  geo.zoomWant = null;
  if (z === map.getZoom()) return;
  if (geo.follow !== 'free' && geo.me) { geo.progZoom = true; map.setZoomAround([geo.me.lat, geo.me.lon], z); }
  else map.setZoom(z);
}
function updateZoomAuto() {
  const el = $('#zoomAuto');
  if (!el) return;
  el.hidden = !nav.on;
  const route = $('#zoomRoute');
  if (route) {
    route.hidden = !nav.on;
    const on = !!(nav.on && nav.wholeView && geo.follow === 'free');
    route.classList.toggle('on', on); route.setAttribute('aria-pressed', String(on));
  }
  el.classList.toggle('on', !!(state.settings.autoZoom && !nav.autoZoomPaused));
}

/* ---------- navigation to a point ---------- */
function startNav(target, { quiet = false } = {}) {
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
    offSince: 0, offCourse: null, hazard: null, banner: '', depth: null, depthT: 0, left: null, retrace: null, inReeds: false, reedsIn: 0, reedsOut: 0,
    trail: [], said: {},
  });
  store.set('ladoga-nav', { ...nav.target, t: Date.now() });
  loadReeds();
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
  updateZoomAuto(); updateCompassBtn(); refreshMeIcon(); updateVoiceBtn();
  // The way there is recorded by itself, so there is always a way back (owner, 26.09.2026: «вернуться по маршруту —
  // наиважнейшая функция»; a forgotten «Трек» must not cost it). Settings → «Писать трек при навигации».
  if (state.settings.autoTrack !== false && !trk.cur && !DEMO.on) startRec({ auto: true });
  else if (!store.get('ladoga-nav-hint', false)) { store.set('ladoga-nav-hint', true); toast('Экран не будет гаснуть — навигатор расходует заряд, возьмите пауэрбанк', 6000); }
  if (!quiet) say(geo.me ? `Ведём к точке ${nav.target.title}. ${sayDist(distM(geo.me, nav.target))}` : `Ведём к точке ${nav.target.title}`, { force: true });
  logEvent('nav_start', { d: geo.me ? Math.round(distM(geo.me, nav.target)) : null, rec: !!trk.cur });
}
function stopNavState() {
  layers.nav.clearLayers(); layers.navHazards.clearLayers();
  setBanner(null);
  $('#recenter').hidden = true;
}
function stopNav() {
  if (!nav.on) return;
  nav.on = false;
  hideSaver();
  if (DEMO.on) stopDemo();
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
const navTrail = L.polyline([], { color: '#1c7ed6', weight: 3, opacity: 0.85, interactive: false });
const navArrive = L.circle([0, 0], { radius: 30, color: '#2b8a3e', weight: 2, dashArray: '4 6', fill: false, interactive: false });
function drawNavTarget() {
  layers.nav.clearLayers();
  navTrail.setLatLngs([]).addTo(layers.nav);
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
  if (me) {
    const lv = levelNow();
    for (const z of dangersNear(me, 1200)) {
      const now = Math.max(0, z.depth + lv);
      if (now > (+state.settings.shallow || 1.5) + 1) continue;
      L.marker([z.lat, z.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'danger-pt', html: `<span>+${fmtM(now)}</span>`, iconSize: [0, 0] }) }).addTo(layers.navHazards);
    }
  }
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
/* ---------- shallow water ahead: the depth model along the course, like a plotter's «safety depth» alarm ----------
   Every 3 s while moving: points along the course up to about 2 minutes of travel (300 m – 1,5 km), straight and
   10° to each side (the boat drifts and turns); the nearest place shallower than «Предупреждать о глубине меньше»
   with today's level is the shoal ahead. Where the water under the boat is already that shallow, only a clearly
   shallower place ahead counts (no nagging in a shallow bay). On the ice depth warnings are off. */
const onIceNow = () => {
  const m = new Date().getMonth() + 1;
  if (!(m >= 11 || m <= 4)) return false;
  return Object.values(state.live?.ice_season?.sectors || {}).some((x) => x.state === 'ice');
};
// The corridor is a strip of fixed width along the course (±CORRIDOR_M), not a fan: a shoal 100 m off the side of
// a dredged channel is not «ahead» of a boat going along the channel (no warnings every minute there).
const CORRIDOR_M = 30;
function shoalAhead(me) {
  if (!courseValid() || geo.sog * 3.6 < 3 || !chartState.gridIndex || onIceNow()) return null;
  const lv = levelNow(), lim = +state.settings.shallow || 1.5;
  const hereDepth = depthAt(me);
  const hereNow = hereDepth?.value != null ? hereDepth.value + lv : null;
  const range = Math.min(1500, Math.max(300, geo.sog * 120));
  // Worth a word: going from deeper water into shallow, or — where it is already shallow — a place clearly shallower
  // than here (0,7 m) or under 0,8 m of water. Not every dip of a shallow bay.
  const counts = (now) => now <= lim && (hereNow == null || hereNow > lim + 0.3 || now <= hereNow - 0.7 || now < 0.8);
  let best = null;
  // The model along the course line and two lines CORRIDOR_M to the sides.
  for (const side of [0, -CORRIDOR_M, CORRIDOR_M]) {
    const start = side ? destPoint(me, (geo.cog + (side > 0 ? 90 : 270)) % 360, Math.abs(side)) : me;
    for (let d = 30; d <= range; d += d < 200 ? 30 : d < 600 ? 60 : 120) {
      const p = destPoint(start, geo.cog, d);
      const g = gridDepth(p);
      if (g == null || g < 0) continue;
      if (counts(g + lv)) { if (!best || d < best.d) best = { d, depth: Math.max(0, g + lv), lat: p.lat, lon: p.lon }; break; }
    }
  }
  // The danger points the model smooths: along-track distance and how far off the course line.
  const mid = destPoint(me, geo.cog, range / 2);
  for (const z of dangersNear(mid, range / 2 + CORRIDOR_M + 50)) {
    const dist = distM(me, z), a = toRad(angleDiff(geo.cog, bearing(me, z)));
    const along = dist * Math.cos(a), cross = Math.abs(dist * Math.sin(a));
    if (along < 20 || along > range || cross > CORRIDOR_M + Math.min(20, (geo.me?.acc || 0) / 2)) continue;
    if (counts(z.depth + lv) && (!best || along < best.d)) best = { d: Math.round(along), depth: Math.max(0, z.depth + lv), lat: z.lat, lon: z.lon, point: true };
  }
  return best;
}
// «Где вы»: a ban area of the fishing rules; in the ice months a place in «Опасный лёд». Said once per place and trip.
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ya, xa] = poly[i], [yb, xb] = poly[j];
    if ((ya > p.lat) !== (yb > p.lat) && p.lon < ((xb - xa) * (p.lat - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
function placeNotes(me) {
  const out = [];
  for (const a of state.ctx.regulations?.prohibited_areas || []) {
    if (/^\[Промысел\]|справочно/i.test(`${a.name} ${a.applies_to}`)) continue;
    let inside = Array.isArray(a.polygon) && a.polygon.length > 2 && pointInPoly(me, a.polygon);
    for (const z of a.zones || []) if (z.lat != null && distM(me, { lat: +z.lat, lon: +z.lon }) <= (z.radius_m || 1000)) inside = true;
    if (inside) out.push({ key: `ban:${a.name}`, text: `Запретный район: ${a.name}${a.period ? ` — ${a.period}` : ''}`, say: `Вы в запретном районе: ${a.name}` });
  }
  const m = new Date().getMonth() + 1;
  if (m >= 11 || m <= 4) {
    for (const z of state.ctx.ice_zones || []) {
      if (distM(me, z) > z.r) continue;
      const what = Object.keys(z.causes || {}).map((k) => ICE_CAUSE[k]).filter(Boolean).join(', ');
      out.push({ key: `icez:${z.id}`, text: `Опасный лёд: ${z.name} — ${what}`, say: `Осторожно, опасный лёд. ${z.name}: ${what}` });
    }
  }
  return out;
}
let hazardsDrawnAt = 0;
function navOnFix() {
  if (!nav.on) return;
  const me = geo.me, t = nav.target;
  if (me) {
    if (!nav.start) nav.start = { lat: me.lat, lon: me.lon };
    nav.d = distM(me, t);
    retraceStep(me);
    const aim = navAim();
    nav.brg = bearing(me, aim);
    // A thin line from the boat to what the arrow shows: the point itself, or on the way back the spot along the track.
    navLine.setLatLngs([[me.lat, me.lon], [aim.lat, aim.lon]]);
    const fresh = Date.now() - me.t < 10000;
    // Arrival: the radius never smaller than the GPS error allows.
    const R = Math.max(+state.settings.arrivalR || 30, Math.min(100, 1.5 * me.acc));
    if (nav.d < 500) { navArrive.setLatLng([t.lat, t.lon]).setRadius(R); if (!layers.nav.hasLayer(navArrive)) navArrive.addTo(layers.nav); }
    else if (layers.nav.hasLayer(navArrive)) layers.nav.removeLayer(navArrive);
    if (fresh && !nav.arrived && nav.d <= R) {
      nav.arrived = true; nav.arriveT = Date.now(); nav.hold = false; nav.left = null;
      logEvent('nav_arrived', { acc: Math.round(me.acc), retrace: !!nav.retrace });
      navigator.vibrate?.([200, 100, 200]);
      beep('arrive');
      // «К машине» by the track: the track is done, the last metres to the car go straight.
      const next = nav.retrace?.then;
      if (next && distM(me, next) > R) {
        setTimeout(() => {
          if (!nav.on || nav.retrace?.then !== next) return;
          startNav(next, { quiet: true });
          say(`Трек пройден. Дальше ${next.title === 'Машина' ? 'к машине' : `к точке ${next.title}`} ${sayDist(distM(geo.me || next, next))} по прямой`, { force: true });
        }, 2500);
      }
    } else if (nav.arrived && nav.d > 2 * R) {
      nav.arrived = false; nav.hold = false; nav.left = nav.d; nav.leftT = Date.now();
    }
    if (nav.arrived && !nav.hold && Date.now() - nav.arriveT > 20000) nav.hold = true;
    // Off course: moving, far from the point, heading more than 30° away for 10 s. On the way back by the track the
    // measure is the distance off the line instead (retraceStep).
    updateReeds(me);
    if (!nav.retrace && !nav.inReeds && courseValid() && nav.d > 200) {
      const diff = angleDiff(geo.cog, nav.brg);
      if (Math.abs(diff) > 30) { if (!nav.offSince) nav.offSince = Date.now(); if (Date.now() - nav.offSince > 10000) nav.offCourse = diff; }
      else if (Math.abs(diff) < 15) { nav.offSince = 0; nav.offCourse = null; }
      else if (nav.offCourse != null) nav.offCourse = diff;
    } else { nav.offSince = 0; nav.offCourse = null; }
    // A shoal ahead — one at a time, the nearest; the sound no more than once in 5 minutes for the same one. On the
    // way back along the track the boat has passed there already: quiet while on the line (the shallow channels of
    // the reeds would warn at every bend), told again as soon as it leaves the line.
    const onTrack = !!nav.retrace && !nav.retrace.offTrack;
    const hz = fresh && !onTrack ? hazardAhead(me) : null;
    if (hz) {
      const k = `${hz.lat},${hz.lon}`;
      if (!nav.hazardSeen[k] || Date.now() - nav.hazardSeen[k] > 300000) { nav.hazardSeen[k] = Date.now(); beep('hazard'); navigator.vibrate?.([100, 60, 100, 60, 100]); }
    }
    nav.hazard = hz;
    if (Date.now() - hazardsDrawnAt > 5000) { hazardsDrawnAt = Date.now(); drawNavHazards(); }
    if (Date.now() - (nav.shoalT || 0) > 3000) {
      nav.shoalT = Date.now();
      nav.shoal = fresh && !onTrack && !nav.inReeds ? shoalAhead(me) : null;
      if (nav.shoal && !nav.said[`shl${Math.round(nav.shoal.lat * 500)},${Math.round(nav.shoal.lon * 500)}`]) logEvent('shoal_ahead', { d: nav.shoal.d, depth: Math.round(nav.shoal.depth * 10) / 10 });
      const notes = fresh ? placeNotes(me) : [];
      nav.place = notes.find((n) => !nav.said[n.key]) || (nav.place && notes.some((n) => n.key === nav.place.key) ? nav.place : null);
    }
    // The way already made, drawn behind the boat (a recorded track draws itself).
    const last = nav.trail[nav.trail.length - 1];
    if (fresh && me.acc <= 50 && (!last || distM({ lat: last[0], lon: last[1] }, me) >= 10)) {
      nav.trail.push([me.lat, me.lon]);
      if (nav.trail.length > 4000) nav.trail.splice(0, nav.trail.length - 4000);
      navTrail.setLatLngs(trk.cur?.state === 'rec' ? [] : nav.trail);
    }
    navVoice();
  }
  if (saver.on && ((nav.hazard && nav.hazard.d < 300) || (nav.arrived && Date.now() - nav.arriveT < 3000))) hideSaver();
  if (geo.follow !== 'free' && me && !saver.on) {
    applyRotation();
    placeBoat(autoZoom());
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
  const d = nav.d ?? Infinity;
  const zd = d < 2000 ? Math.floor(Math.log2(k * 0.8 * aheadPx / Math.max(d, 15))) : -Infinity;
  // Standing (or drifting): the boat and the point together, so the way is seen — not 100 m of water around the boat
  // (owner, 26.09.2026: «увеличил и не могу вернуться к виду маршрута»).
  const moving = sog * 3.6 >= 3;
  // Two minutes of the way ahead; on the way back along the track one minute — the bends of a channel must be seen.
  if (moving) nav.zSpeed = Math.floor(Math.log2(k * aheadPx / (nav.retrace || nav.inReeds ? Math.max(100, sog * 60) : Math.max(150, sog * 120))));
  else if (Number.isFinite(d) && nav.target) nav.zSpeed = Math.floor(Math.log2(k * roomToward(nav.target, fr) / Math.max(d, 60)));
  let z = nav.hold ? 18 : moving ? Math.max(nav.zSpeed, zd) : nav.zSpeed;
  z = Math.max(9, Math.min(18, z));
  const cur = map.getZoom();
  if (nav.firstPlace) { nav.firstPlace = false; nav.zoomCand = null; return z; }
  if (z === cur) { nav.zoomCand = null; return null; }
  if (nav.zoomCand !== z) { nav.zoomCand = z; nav.zoomCandT = Date.now(); return null; }
  if (Date.now() - nav.zoomCandT < (z > cur ? 4000 : 8000)) return null;
  nav.zoomCandT = Date.now();
  return cur + Math.sign(z - cur);
}
// Pixels from the boat's place on the screen (as placeBoat keeps it) to the edge of the free area, the way the point
// lies on the screen now — less room for the point's own mark.
function roomToward(p, fr) {
  const rotated = geo.follow === 'course' || geo.follow === 'compass'; // as placeBoat keeps it
  const bx = (fr.left + fr.right) / 2, by = fr.top + (rotated ? 0.72 : 0.5) * (fr.bottom - fr.top);
  const a = toRad(bearing(geo.me, p) + map.getBearing());
  const dx = Math.sin(a), dy = -Math.cos(a);
  const tx = dx > 1e-6 ? (fr.right - bx) / dx : dx < -1e-6 ? (fr.left - bx) / dx : Infinity;
  const ty = dy > 1e-6 ? (fr.bottom - by) / dy : dy < -1e-6 ? (fr.top - by) / dy : Infinity;
  return Math.max(40, Math.min(tx, ty) - 28);
}
// Back to the boat. By the button — the navigator's own view again (its zoom too: «Ко мне» should give back the way);
// by itself after the finger was lifted — the zoom the user chose stays.
function recenter(auto) {
  nav.wholeView = false;
  if (auto !== true && state.settings.autoZoom) nav.autoZoomPaused = false;
  nav.firstPlace = !nav.autoZoomPaused;
  setFollow(nav.followBefore || (state.settings.orient === 'course' ? 'course' : 'north'));
  nav.followBefore = null;
  updateRecenter(); updateZoomAuto();
  navOnFix();
  logEvent('recenter', { auto: auto === true });
}
// The map may go back by itself only when nobody touches it and nothing is open over it (a card, a sheet).
const navCalm = () => !geo.pressed && topLayer()?.kind === 'nav';
function updateRecenter() {
  const el = $('#recenter');
  const show = nav.on && geo.follow === 'free';
  el.hidden = !show;
  if (!show) return;
  const ar = +state.settings.autoReturn;
  const left = ar && navCalm() ? ar * 1000 - (Date.now() - nav.lastTouch) : Infinity;
  $('#recenterText').textContent = left <= 5000 ? `Ко мне · ${Math.max(1, Math.ceil(left / 1000))}` : 'Ко мне';
}
function toggleAutoZoom() {
  if (!state.settings.autoZoom) { setSetting('autoZoom', true); nav.autoZoomPaused = false; }
  else nav.autoZoomPaused = !nav.autoZoomPaused;
  // On again after fingers had moved the map: the navigator takes the whole view back — the boat too, not only the
  // zoom (26.09.2026: «Авто» did nothing while the map was let go).
  if (!nav.autoZoomPaused) { nav.firstPlace = true; if (nav.on && geo.follow === 'free') recenter(); else navOnFix(); }
  updateZoomAuto();
  toast(nav.autoZoomPaused ? 'Масштаб ваш — навигатор его не меняет' : 'Автомасштаб: по скорости и расстоянию до точки');
}
function wholeRoute() {
  if (!nav.on) return;
  if (nav.wholeView) { recenter(false); return; }
  nav.wholeView = true;
  nav.followBefore = geo.follow === 'free' ? nav.followBefore : geo.follow;
  setFollow('free');
  map.setBearing(0);
  const pts = [[nav.target.lat, nav.target.lon]];
  if (geo.me) pts.push([geo.me.lat, geo.me.lon]);
  map.fitBounds(L.latLngBounds(pts), fitPadding());
  nav.lastTouch = Date.now();
  updateRecenter(); updateZoomAuto();
}

/* ---------- «Назад по треку»: the way home is the way you came ----------
   The owner (26.09.2026): the way back along the channels in the reeds is the most important thing — miss the channel
   and you are lost. The geometry is site/retrace.js: the line is the track reversed with the fishing loops cut out;
   the arrow shows the farthest spot along it that a straight run reaches without leaving the channel (at a bend —
   the bend); a step off the line, a turn ahead, a stretch not recorded are told on the screen and by voice. The way
   already passed is passable: on the line, the shoal warnings keep quiet. */
function startRetrace(t, { title, then, forward = false } = {}) {
  const path = rtBuild(t.segs, { forward });
  if (!path || path.len < 20) { toast('В треке пока нет пройденного пути'); return; }
  const end = path.pts[path.pts.length - 1], name = t.name || fmtTime(t.start);
  startNav({ lat: end.lat, lon: end.lon, title: title || (forward ? `Конец трека: ${name}` : `Начало трека: ${name}`) }, { quiet: true });
  nav.retrace = { path, trackId: t.id, loc: null, aim: null, via: null, turn: null, gap: null, left: path.len, off: 0, offTrack: null, wrong: false, drawnFrom: -1, then: then || null };
  drawRetrace();
  const gapNote = path.gapLen > 30 ? `. ${fmtDist(path.gapLen)} не записано — там смотрите по карте` : '';
  toast(`${forward ? 'По треку до конца' : 'Назад по треку до начала'}: ${fmtDist(path.len)}${gapNote}`, 6000);
  say(`${forward ? 'Ведём по треку. До конца' : 'Ведём назад по треку. До начала'} ${sayDist(path.len)}${path.gapLen > 30 ? '. Часть пути не записана' : ''}`, { force: true });
  logEvent('retrace_start', { len: Math.round(path.len), gap: Math.round(path.gapLen), n: path.pts.length, then: !!then, forward });
  navOnFix();
}
// A saved track from its card: along it towards the end that is farther from the boat — from the launch to
// yesterday's spot by the same channels, or from the spot back to the launch.
function goByTrack(t) {
  const flat = t.segs.flat();
  if (flat.length < 2) { toast('В треке пока нет пройденного пути'); return; }
  const a = { lat: flat[0][0], lon: flat[0][1] }, b = { lat: flat[flat.length - 1][0], lon: flat[flat.length - 1][1] };
  const me = geo.me && Date.now() - geo.me.t < 120000 ? geo.me : null;
  startRetrace(t, { forward: !!me && distM(me, a) < distM(me, b) });
}
// Where the arrow points: the spot along the track, or the target itself.
const navAim = () => (nav.retrace?.via || nav.target);
function retraceStep(me) {
  const r = nav.retrace;
  if (!r) return;
  const loc = r.loc = rtLocate(r.path, me, r.loc);
  if (!loc) return;
  const acc = me.acc || 5, sog = geo.sog || 0;
  r.aim = r.via = rtAim(r.path, loc, me, { sog, corridor: Math.max(4, Math.min(8, acc)) });
  r.left = r.path.len - loc.along + loc.d;
  r.off = loc.d;
  r.turn = rtTurn(r.path, loc.along, Math.max(150, sog * 25));
  r.gap = rtGapAhead(r.path, loc.along, 200);
  // Off the line by more than the GPS error explains, for 4 s; back on it below 60 % of that.
  const lim = Math.max(10, 1.5 * acc);
  if (loc.d > lim) { if (!r.offSince) r.offSince = Date.now(); } else if (loc.d < lim * 0.6) r.offSince = 0;
  r.offTrack = r.offSince && Date.now() - r.offSince > 4000 ? { d: loc.d, side: loc.off > 0 ? 'right' : 'left' } : null;
  // The wrong way: going along the line away from its end for 6 s.
  let against = false;
  if (courseValid() && loc.d < 40) against = Math.abs(angleDiff(rtHeading(r.path, Math.max(0, loc.along - 10), Math.min(r.path.len, loc.along + 10)), geo.cog)) > 120;
  if (against) { if (!r.wrongSince) r.wrongSince = Date.now(); } else r.wrongSince = 0;
  r.wrong = !!r.wrongSince && Date.now() - r.wrongSince > 6000;
  if (Math.abs(loc.seg - r.drawnFrom) >= 3) drawRetraceRest();
}
// The line home on the map: bright, with a white edge, over any base map; the stretches not recorded dashed; only
// what is still ahead (the rest redrawn every few points).
const rtCasing = L.polyline([], { color: '#fff', weight: 11, opacity: 0.85, interactive: false, lineCap: 'round', lineJoin: 'round' });
const rtLine = L.polyline([], { color: '#c2255c', weight: 5, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' });
const rtGaps = L.polyline([], { color: '#c2255c', weight: 4, opacity: 0.9, dashArray: '2 10', interactive: false, lineCap: 'round' });
function drawRetrace() {
  const r = nav.retrace;
  if (!r) return;
  for (const l of [rtCasing, rtLine, rtGaps]) if (!layers.nav.hasLayer(l)) l.addTo(layers.nav);
  r.drawnFrom = -1;
  drawRetraceRest();
}
function drawRetraceRest() {
  const r = nav.retrace;
  if (!r) return;
  const from = Math.max(0, r.loc ? r.loc.seg : 0);
  r.drawnFrom = from;
  const pts = r.path.pts, gap = r.path.gap;
  const solid = [], gaps = [];
  let run = [];
  for (let i = from; i < pts.length; i += 1) {
    run.push([pts[i].lat, pts[i].lon]);
    if (i < pts.length - 1 && gap[i]) { if (run.length > 1) solid.push(run); gaps.push([[pts[i].lat, pts[i].lon], [pts[i + 1].lat, pts[i + 1].lon]]); run = []; }
  }
  if (run.length > 1) solid.push(run);
  rtCasing.setLatLngs(solid); rtLine.setLatLngs(solid); rtGaps.setLatLngs(gaps);
}
/* In the reeds: a channel the charts do not know. The charts show land or under half a metre where the boat goes at
   speed, and the straight line to the point crosses the reeds — so «Мелко впереди» and «Поверните левее на 145°» went
   on all the way along a channel (the angler's day test, 26.09.2026: 199 shoal banners in one channel). In the reeds
   the navigator keeps quiet about the depth and the course until open water; the named dangers stay. «In the reeds»:
   inside a reed bed of OpenStreetMap for 3 s, or going at speed where the charts say under half a metre for 10 s;
   out: 1 m of water and more for 10 s. */
function reedsAt(p) {
  for (const q of REEDS.polys) {
    if (p.lat < q.s || p.lat > q.n || p.lon < q.w || p.lon > q.e) continue;
    let inside = false;
    const r = q.ring;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xa, ya] = r[i], [xb, yb] = r[j];
      if ((ya > p.lat) !== (yb > p.lat) && p.lon < ((xb - xa) * (p.lat - ya)) / (yb - ya) + xa) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
function updateReeds(me) {
  const now = Date.now(), sog = geo.sog || 0, lv = levelNow();
  if (!nav.depth || now - nav.depthT > 3000) { nav.depth = depthAt(me); nav.depthT = now; }
  const dep = nav.depth, d = dep ? (dep.value ?? dep.max) + lv : null;
  const inPoly = reedsAt(me);
  // A narrow channel: by the charts shallow (or land) 15 m to both sides of the course while the boat goes at speed —
  // the shoal look-ahead's side lines lie in the reeds there, and warned at every bend (the angler's day test).
  let narrow = false;
  if (courseValid() && sog >= 1.5) {
    const side = (b) => { const g = gridDepth(destPoint(me, (geo.cog + b) % 360, 15)); return g == null || g + lv < 0.5; };
    narrow = side(90) && side(270);
  }
  const inside = inPoly || narrow || (sog >= 1.5 && (d == null || d < 0.5));
  const open = !inPoly && !narrow && d != null && d >= 1;
  if (inside) { if (!nav.reedsIn) nav.reedsIn = now; } else nav.reedsIn = 0;
  if (open) { if (!nav.reedsOut) nav.reedsOut = now; } else nav.reedsOut = 0;
  if (!nav.inReeds && nav.reedsIn && now - nav.reedsIn > (inPoly ? 3000 : 6000)) {
    nav.inReeds = true; nav.shoal = null; nav.offSince = 0; nav.offCourse = null;
    if (!nav.said.reedsTold) { nav.said.reedsTold = true; toast('Протока или тростник: карты глубин их не знают — о мели и курсе не подсказываю до открытой воды', 6000); }
    logEvent('reeds_in', { poly: inPoly, narrow, d: d == null ? null : Math.round(d * 10) / 10 });
  }
  if (nav.inReeds && nav.reedsOut && now - nav.reedsOut > 10000) { nav.inReeds = false; logEvent('reeds_out'); }
}
// The track to go back by: the one being recorded, or the last one finished within 12 h.
function retraceTrack() {
  const t = trk.cur;
  if (t && t.segs.flat().length > 1) return t;
  const last = trk.list.find((x) => x.state === 'done' && x.segs?.flat().length > 1);
  return last && Date.now() - (last.end || last.start) < 12 * 3600000 ? last : null;
}
// «К машине»: along the track when the track began at the car (a boat in the reeds cannot go «по прямой»), the
// last metres straight.
function carTrack() {
  const c = state.car, t = retraceTrack();
  if (!c || !t) return null;
  const first = t.segs.flat()[0];
  return first && distM({ lat: first[0], lon: first[1] }, c) <= 400 ? t : null;
}

/* ---------- the navigation screen ---------- */
function updateNavArrow() {
  if (!nav.on) return;
  const me = geo.me;
  const box = $('#ntArrowBox'), arrow = $('#ntArrow');
  if (!me) { box.classList.add('north'); arrow.style.transform = 'rotate(0deg)'; return; }
  const brg = bearing(me, navAim());
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
  const d = nav.retrace ? nav.retrace.left : distM(me, t), brg = bearing(me, navAim());
  if (nav.hold) {
    // The big figure stays a distance (to the point = the drift); the words say what it is.
    const from = bearing(t, me);
    setText('#ntDist', `${Math.round(d)} м`);
    setText('#ntLine2', `Снос: ${rumb(from)} от точки · держу точку`);
  } else {
    setText('#ntDist', fmtDist(d));
    let eta = '';
    if (courseValid()) {
      const vmg = geo.sog * Math.cos(toRad(brg - geo.cog));
      if (vmg * 3.6 >= 1) { const ms = (d / vmg) * 1000; eta = `в ${fmtTime(now + ms)} (${fmtDur(ms)})`; }
      else if (vmg < -0.3) eta = 'удаляетесь';
    }
    // On the way back: the next turn of the channel instead of the bearing (the bearing of a spot 20 m ahead says little).
    const tr = nav.retrace?.turn;
    const where = tr && tr.d <= 300 ? `${turnWords(tr.angle)} через ${fmtDist(tr.d)}` : `на ${Math.round(brg)}° ${rumb(brg)}`;
    setText('#ntLine2', `${nav.retrace ? 'по треку · ' : ''}${where}${eta ? ` · ${eta}` : ''}`);
  }
  // GPS quality: colour and words, not colour alone.
  gpsDot.className = `gps-dot ${stale ? 'r' : me.acc <= 10 ? 'g' : me.acc <= 30 ? 'y' : 'r'}`;
  setText('#ntGpsText', DEMO.on ? 'ДЕМО' : stale ? `${fmtClock(age)} назад` : `±${Math.round(me.acc)} м`);
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
  // The big figure is the water there is NOW (the chart depth plus today's level against the charts' zero) —
  // the same figure the shoal warning counts; the chart's own is under it.
  const dep = nav.depth, lv = levelNow();
  const depText = !dep ? '—' : dep.value != null ? fmtM(Math.max(0, dep.value + lv)) : `${fmtM(Math.max(0, dep.min + lv), 0)}–${fmtM(Math.max(0, dep.max + lv), 0)}`;
  setText('#nfDepth', depText);
  const depUnit = $('#nfDepth')?.nextElementSibling;
  const du = !dep ? 'нет карты' : `м сейчас · карта ${dep.value != null ? fmtM(dep.value) : `${dep.min}–${dep.max}`}`;
  if (depUnit && depUnit.textContent !== du) depUnit.textContent = du;
  $('#nfDepthBox').classList.toggle('shallow', !!dep && (dep.value ?? dep.max) + lv <= (+state.settings.shallow || 1.5));
  updateNavArrow();
  navBanner();
  updateRecenter();
  updateTrackUi();
}
// «налево», «резко направо», «разворот налево» — the size of a turn of the track in words.
function turnWords(angle) {
  const a = Math.abs(angle), side = angle > 0 ? 'направо' : 'налево';
  return a >= 150 ? `разворот ${side}` : a >= 100 ? `резко ${side}` : side;
}
// One banner at a time: GPS lost > the way back (wrong way, off the track) > shoal ahead > a gap in the track > arrival > off course.
function navBanner() {
  const me = geo.me;
  let b = null;
  const age = me ? Date.now() - me.t : 0;
  const r = nav.retrace;
  if (me && age > 60000) b = { cls: 'danger', key: `gps${Math.floor(age / 1000)}`, html: `Нет сигнала GPS ${fmtClock(age)}. Выйдите на открытое место, не закрывайте приложение.` };
  else if (r?.wrong && !nav.arrived) b = { cls: 'danger', key: 'rtwrong', html: `${ic('restart-alt')} Не туда: трек ведёт в другую сторону — разворачивайтесь` };
  else if (r?.offTrack && !nav.arrived) {
    const o = r.offTrack, back = o.side === 'right' ? 'левее' : 'правее';
    b = { cls: o.d > 25 ? 'danger' : 'warn', key: `rtoff${o.side}${Math.round(o.d / 5)}`, html: `${ic(o.side === 'right' ? 'chevron-left' : 'chevron-right')} Вы ${o.side === 'right' ? 'правее' : 'левее'} трека на ${Math.round(o.d)} м — возьмите ${back}` };
  } else if (nav.hazard && !(nav.shoal && nav.shoal.d < nav.hazard.d)) {
    const h = nav.hazard;
    const where = courseValid() ? 'впереди' : 'рядом';
    b = { cls: h.d < 150 ? 'danger' : '', key: `hz${h.lat}${Math.round(h.d / 10)}`, html: `${ic('warning')} ${esc(h.name)} — ${fmtDist(h.d)} ${where}` };
  } else if (nav.shoal) {
    const s = nav.shoal;
    b = { cls: s.d < 150 || s.depth < 1 ? 'danger' : '', key: `sh${Math.round(s.d / 30)}${Math.round(s.depth * 10)}`, html: `${ic('warning')} Мелко впереди: ${s.depth < 0.5 ? 'меньше 0,5' : fmtM(s.depth)} м через ${fmtDist(s.d)}` };
  } else if (r?.gap && r.gap.d < 150 && !nav.arrived) {
    const g = r.gap;
    b = { cls: 'warn', key: `rtgap${g.seg}`, html: `${ic('warning')} ${g.d < 15 ? 'Здесь' : `Через ${fmtDist(g.d)}`} трек не записан: ${fmtDist(g.len)} по прямой — смотрите по карте` };
  } else if (nav.place && !nav.arrived) {
    b = { cls: '', key: `pl${nav.place.key}`, html: `${ic('warning')} ${esc(nav.place.text)}` };
  } else if (nav.arrived) {
    b = { cls: 'ok', key: `arr${nav.hold}`, html: `<span>${ic('check-circle')} ${nav.hold ? 'Держу точку' : 'Вы на месте'} · ${esc(nav.target.title)}</span><span class="nbb"><button type="button" data-act="nav-end-ask">Завершить</button><button type="button" data-act="nav-mark">Метка</button>${nav.hold ? '' : '<button type="button" data-act="nav-hold">Держать точку</button>'}</span>` };
  } else if (nav.left != null && Date.now() - nav.leftT < 10000) {
    b = { cls: '', key: `left${Math.round(nav.left)}`, html: `Ушли с точки на ${fmtDist(nav.left)}` };
  } else if (nav.offCourse != null) {
    const a = Math.round(Math.abs(nav.offCourse) / 5) * 5;
    b = { cls: '', key: `off${a}${nav.offCourse > 0}`, html: `${ic(nav.offCourse > 0 ? 'chevron-right' : 'chevron-left')} Поверните ${nav.offCourse > 0 ? 'правее' : 'левее'} на ${a}°` };
  } else if (guard.on) {
    // «Сторож места» on in navigation: its chip is put away with the others — say here that it watches.
    b = { cls: '', key: `guard${guard.anchor ? Math.round((guard.d || 0) / 5) : 'w'}`, html: `${ic('warning')} Сторож места: ${guard.anchor ? `${Math.round(guard.d || 0)} м от места, тревога дальше ${guard.r} м` : 'запоминаю место'}` };
  }
  setBanner(b);
}
function setBanner(b) {
  const el = $('#navBanner');
  const on = !!b;
  let changed = document.body.classList.contains('nav-banner-on') !== on;
  if (!b) { if (!el.hidden) { el.hidden = true; nav.banner = ''; } }
  else {
    if (nav.banner !== b.key) { nav.banner = b.key; el.className = `nav-banner ${b.cls}`; el.innerHTML = b.html; changed = true; }
    el.hidden = false;
  }
  if (!changed) return;
  document.body.classList.toggle('nav-banner-on', on);
  // The buttons under the banner take their places in this same frame: its height as it is now, then the fit. Left
  // to the size observer, that came two frames later, and on a phone on its side SOS stood on «Авто» meanwhile
  // (26.09.2026).
  if (on && el.offsetHeight) document.body.style.setProperty('--nb-h', `${el.offsetHeight}px`);
  navFit();
}
// The real heights of the navigation panel and the banner go to CSS (--nt-h, --nb-h): the banner, the compass
// and SOS stand below them however the text wraps (a two-row arrival banner used to cover SOS).
const navSizes = new ResizeObserver(() => {
  for (const [id, prop] of [['navTop', '--nt-h'], ['navBanner', '--nb-h']]) {
    const el = document.getElementById(id);
    if (!el.hidden && el.offsetHeight) document.body.style.setProperty(prop, `${el.offsetHeight}px`);
  }
  requestAnimationFrame(navFit); // the next frame: a change of the layout inside the observer would call it again at once
});
// The column grows when «Тёмный экран» shows up, «Авто» appears with the navigator: both count for navFit.
for (const id of ['navTop', 'navBanner', 'zoomAuto']) navSizes.observe(document.getElementById(id));
navSizes.observe($('.mu-right'));
// The right column (Слои, Тёмный экран, SOS) must not touch «+ − Авто»: where the height is short — iPhone SE in
// Safari, or any phone once a banner pushes the column down — it becomes a row along the top (26.09.2026: «+» covered
// SOS). Measured with the column in place, each time the sizes change.
function navFit() {
  const body = document.body;
  body.classList.remove('nav-row');
  if (body.dataset.mode !== 'nav') return;
  const rects = (sel) => [...document.querySelectorAll(sel)].filter((el) => !el.hidden && el.offsetParent).map((el) => el.getBoundingClientRect());
  const col = rects('.mu-right > .fab'), zoom = rects('#zoomGroup, #zoomAuto');
  const near = (a, b) => a.left < b.right + 8 && b.left < a.right + 8 && a.top < b.bottom + 8 && b.top < a.bottom + 8;
  if (col.some((a) => zoom.some((b) => near(a, b)))) body.classList.add('nav-row');
}
addEventListener('resize', () => requestAnimationFrame(navFit));
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
    case 'saver': showSaver(); break;
    case 'nav-layers': closeTop(); openLayersSheet('layers'); break;
    case 'guard-on': closeTop(); guardStart(); break;
    case 'mob': manOverboard(); break;
    case 'guard-sheet': closeTop(); openGuardSheet(); break;
    case 'guard-off': closeTop(); guardStop(); break;
    case 'guard-reset': closeTop(); Object.assign(guard, { anchor: null, pts: [], overT: 0, moveT: 0 }); toast('Сторож: запоминаю новое место'); break;
    case 'demo': startDemo(); break;
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
      ${retraceTrack() && !nav.retrace ? listRow({ icon: 'restart-alt', title: 'Назад по своему треку', sub: 'той же дорогой, что пришли: по протокам, в туман и в пургу', attrs: 'data-act="retrace"' }) : ''}
      ${state.car && nav.target?.title !== 'Машина' ? listRow({ icon: 'directions-car', title: 'К машине', sub: carTrack() ? 'по треку, последние метры по прямой' : geo.me ? `${fmtDist(distM(geo.me, state.car))} по прямой` : 'отмеченная машина', attrs: 'data-act="car-go"' }) : ''}
      ${listRow({ icon: 'warning', title: '<span style="color:var(--danger)">Человек за бортом</span>', sub: 'отметить место и сразу вести к нему', attrs: 'data-act="mob"' })}
      ${listRow({ icon: 'route', title: 'Весь путь', sub: 'я и точка на одном экране', attrs: 'data-act="nav-whole"' })}
      ${listRow({ icon: 'dark-mode', title: 'Тёмный экран', sub: 'навигация, трек и голос идут, заряд почти не тратится; вернуть карту — нажмите и держите секунду. Не блокируйте телефон кнопкой: тогда iPhone останавливает приложение', attrs: 'data-act="saver"' })}
      ${listRow({ icon: 'layers', title: 'Слои карты', sub: 'спутник, карты глубин, протоки, схема', attrs: 'data-act="nav-layers"' })}
      ${guard.on ? listRow({ icon: 'warning', title: 'Сторож места включён', sub: 'настроить или выключить', attrs: 'data-act="guard-sheet"' }) : listRow({ icon: 'warning', title: 'Сторож места', sub: 'скажу, если место относит: льдина, якорь', attrs: 'data-act="guard-on"' })}
      ${listRow({ icon: 'warning', title: 'Сообщить о проблеме', sub: 'что работает не так — с журналом за 40 минут', attrs: 'data-act="report-problem"' })}
      <details style="margin-top:8px"><summary><b>Настройки навигатора</b></summary>
      <h3>Карта</h3>
      <div class="seg">${[['north', 'Север'], ['course', 'По курсу'], ['compass', 'По компасу']].map(([k, t]) => `<button type="button" data-act="nav-orient" data-val="${k}" class="${cur === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <label class="check switch"><span>Автомасштаб<br><span class="small muted">по скорости и расстоянию до точки — то же, что «Авто» у «+ −»</span></span><input type="checkbox" data-setting="autoZoom" ${state.settings.autoZoom && !nav.autoZoomPaused ? 'checked' : ''}></label>
      ${sw('navShowPoints', 'Показать точки рыбаков')}
      <label class="check switch"><span>Ночная палитра</span><input type="checkbox" data-night ${document.documentElement.dataset.theme === 'night' ? 'checked' : ''}></label>
      ${sw('sound', 'Звук прибытия и опасности')}
      ${sw('voice', 'Голосовые подсказки', 'до точки, правее/левее, мель, прибытие')}
      ${sw('keepAwake', 'Не гасить экран и после навигации')}
      <div class="small muted" style="margin-top:8px">Радиус прибытия</div>
      ${seg('arrivalR', [[15, '15 м'], [30, '30 м'], [50, '50 м'], [100, '100 м']], state.settings.arrivalR)}
      <div class="small muted" style="margin-top:8px">Скорость</div>
      ${seg('units', [['kmh', 'км/ч'], ['kn', 'узлы']], state.settings.units)}
      </details>
      <p class="small muted">Цель: ${esc(nav.target.title)} · ${fmtDM(nav.target.lat, nav.target.lon)}</p>`,
  });
}
// «Глубина» on the navigation screen → where the figure comes from and how far to trust it (owner, 25.09.2026:
// the years and the accuracy are wanted, but not on the screen itself).
function openDepthInfo() {
  const me = geo.me, dep = me ? depthAt(me) : null, lv = levelNow(), src = me ? depthSource(me) : null;
  const near = me ? dangersNear(me, 300) : [];
  openModal({
    key: 'depth-info', title: 'Глубина под лодкой',
    body: () => `${dep ? `<p><b>${fmtM(Math.max(0, (dep.value ?? dep.min) + lv))} м сейчас</b> — по карте ${dep.value != null ? fmtM(dep.value) : `${dep.min}–${dep.max}`} м, уровень озера ${lv < 0 ? 'ниже' : 'выше'} среднего на ${fmtM(Math.abs(lv))} м (${esc(levelSourceText())}).</p>` : '<p>Здесь глубин на картах нет.</p>'}
      ${src ? `<p class="small">Откуда: навигационная ${esc(src.survey || 'карта')} — «${esc(src.title || src.id)}». Между отметками карты глубина рассчитана.</p>` : ''}
      ${dep?.danger ? '<p class="small"><b>Здесь рядом мель или камень</b> — глубина взята по ней, а не по расчёту.</p>' : ''}
      <p class="small">Насколько верить: обычно расчёт отличается от карты на 0,3 м, в одном месте из десяти — больше чем на метр. Отдельный камень расчёт сглаживает, поэтому ~900 известных мелей и камней (отметки карт над опасностями и мели, найденные сверкой с картами Garmin) навигатор учитывает отдельно: глубина — меньшая из двух.</p>
      <p class="small">Карты сняты в 1930–1990-х: устья заносит, фарватеры углубляют. На мелководье и у камней смотрите эхолот.${near.length ? ` Мелей и камней в 300 м от вас: ${near.length}.` : ''}</p>`,
  });
}
function onSettingChange(key) {
  if (key === 'voice') updateVoiceBtn();
  if (key === 'voiceName' || key === 'voiceRate') say('Через 60 метров налево. Впереди мелко: полтора метра', { force: true, test: true });
  if (key === 'boat') refreshPage('today');
  if (key === 'units') updateNavFields(true);
  if (key === 'autoZoom') { if (state.settings.autoZoom) nav.autoZoomPaused = false; updateZoomAuto(); if (nav.on) { nav.firstPlace = true; navOnFix(); } }
  if (key === 'orient' && nav.on && geo.follow !== 'free') setFollow(state.settings.orient === 'course' ? 'course' : 'north');
  if (key === 'guardR') { guard.r = +state.settings.guardR || 50; renderChips(); }
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
/* ---------- voice: short Russian phrases, so the phone can stay in the holder or under the dark screen ----------
   The browser's own speech (speechSynthesis): the first phrase is said inside the tap on «Вести» — iPhone lets a
   page speak only after that. A phrase is not repeated within a minute. */
const voiceState = { last: '', lastT: 0 };
/* Which of the phone's Russian voices speaks. The first Russian voice in the list was often a compressed or a male
   one — «голос очень противный… какой-нибудь хороший, приятный женский» (owner, 26.09.2026). By default the best
   female voice the phone has: an improved/premium one first (iPhone: «Милена (улучшенный)» once downloaded), one that
   needs the internet only while online. Settings → «Голос» lets the person pick any of them and hear it. */
const VOICE_FEMALE = /milena|милена|irina|ирина|svetlana|светлана|dariya|darya|дарья|дария|katya|катя|alena|alyona|алёна|алена|anna\b|анна|ekaterina|екатерина|tatyana|татьяна|google русский|female|женск/i;
const VOICE_MALE = /yuri|юрий|pavel|павел|dmitr|дмитрий|maxim|максим|aleksandr|александр|\bmale\b|мужск/i;
const VOICE_RU = { Milena: 'Милена', Yuri: 'Юрий', Irina: 'Ирина', Pavel: 'Павел', Svetlana: 'Светлана', Dmitry: 'Дмитрий', Dariya: 'Дарья', Katya: 'Катя' };
function ruVoices() {
  try { return speechSynthesis.getVoices().filter((v) => /^ru/i.test(v.lang)); } catch { return []; }
}
function voiceScore(v) {
  const n = `${v.name} ${v.voiceURI || ''}`;
  let s = 0;
  if (VOICE_FEMALE.test(n)) s += 30;
  if (VOICE_MALE.test(n)) s -= 30;
  if (/premium|премиум/i.test(n)) s += 25; else if (/enhanced|natural|neural|улучш/i.test(n)) s += 20;
  if (v.localService === false) s += navigator.onLine ? 5 : -100;
  if (v.default) s += 1;
  return s;
}
function pickVoice() {
  const list = ruVoices();
  if (!list.length) return null;
  const want = state.settings.voiceName;
  if (want) { const v = list.find((x) => x.name === want); if (v && (v.localService !== false || navigator.onLine)) return v; }
  return list.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0];
}
// «Милена · женский, улучшенный» — a voice as a person reads it in the list.
function voiceLabel(v) {
  let n = v.name.replace(/^Microsoft\s+/i, '').replace(/\s*-\s*Russian.*$/i, '').replace(/\s*\((Russian|Russia|русский)[^)]*\)\s*$/i, '').trim();
  const base = n.split(/[\s(]/)[0];
  if (VOICE_RU[base]) n = n.replace(base, VOICE_RU[base]);
  n = n.replace(/\(enhanced\)/i, '').replace(/\(premium\)/i, '').replace(/online|\(natural\)/ig, '').replace(/\s+/g, ' ').trim();
  const nm = `${v.name} ${v.voiceURI || ''}`;
  const tags = [VOICE_FEMALE.test(nm) ? 'женский' : VOICE_MALE.test(nm) ? 'мужской' : '',
    /premium/i.test(nm) ? 'премиум' : /enhanced|улучш/i.test(nm) ? 'улучшенный' : /natural|neural/i.test(nm) ? 'естественный' : '',
    v.localService === false ? 'нужен интернет' : ''].filter(Boolean);
  return `${n || v.name}${tags.length ? ` · ${tags.join(', ')}` : ''}`;
}
function say(text, { force = false, test = false } = {}) {
  if ((!state.settings.voice && !test) || !('speechSynthesis' in window) || !text) return;
  const now = Date.now();
  if (!force && text === voiceState.last && now - voiceState.lastT < 60000) return;
  if (!test) { voiceState.last = text; voiceState.lastT = now; }
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU'; u.rate = Math.max(0.7, Math.min(1.4, +state.settings.voiceRate || 1)); u.pitch = 1;
    const v = pickVoice();
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    if (!test) logEvent('voice', { text });
  } catch { /* no speech on this phone */ }
}
// The voice on the navigation screen: one tap, and it is seen at once whether it speaks (owner, 26.09.2026: «не нашёл
// кнопки голосовых команд, включить-выключить»; the switch lived only in the settings).
function toggleVoice() {
  unlockAudio();
  setSetting('voice', !state.settings.voice);
  if (state.settings.voice) say('Голос включён', { force: true });
  else { try { speechSynthesis.cancel(); } catch { /* no speech */ } }
  toast(state.settings.voice ? 'Голос включён' : 'Голос выключен — подсказки только на экране');
}
function updateVoiceBtn() {
  const b = $('#ntVoice');
  if (!b) return;
  const on = !!state.settings.voice;
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'Голосовые подсказки включены — выключить' : 'Голосовые подсказки выключены — включить');
  const use = b.querySelector('use'), icon = on ? '#i-volume-up' : '#i-volume-off';
  if (use.getAttribute('href') !== icon) use.setAttribute('href', icon);
  const cap = b.querySelector('span');
  if (cap) cap.textContent = on ? 'Голос' : 'Тихо';
}
// Voices come a moment after the page (Chrome, Android): the list in the settings is filled when they do.
try { speechSynthesis.addEventListener?.('voiceschanged', () => { if ($('#voiceSel')) refreshPage('me'); }); } catch { /* no speech */ }
// «1 километр 200 метров» reads better than «1,2 км»; metres rounded the way a person would say them.
function sayDist(m) {
  if (m >= 975 && m < 1000) m = 1000;
  if (m >= 10000) return `${Math.round(m / 1000)} километр${plural(Math.round(m / 1000), '', 'а', 'ов')}`;
  if (m >= 1000) { const all = Math.round(m / 100) * 100, km = Math.floor(all / 1000), r = all % 1000; return `${km} километр${plural(km, '', 'а', 'ов')}${r ? ` ${r} метров` : ''}`; }
  const r = m >= 200 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10;
  return `${r} метров`;
}
function sayDepth(d) {
  if (d < 0.4) return 'меньше полуметра';
  const h = Math.round(d * 2) / 2;
  if (h === 0.5) return 'полметра';
  if (h === 1.5) return 'полтора метра';
  return Number.isInteger(h) ? `${h} метр${plural(h, '', 'а', 'ов')}` : `${Math.floor(h)} с половиной метра`;
}
// Where the point is from the bow: «прямо», «правее», «левее», «сзади».
function sayWhere(diff) {
  const a = Math.abs(diff);
  if (a < 20) return 'прямо по курсу';
  if (a < 60) return diff > 0 ? 'чуть правее' : 'чуть левее';
  if (a < 135) return diff > 0 ? 'правее' : 'левее';
  return 'сзади, разворачивайтесь';
}
const SAY_MARKS = [5000, 2000, 1000, 500, 200, 100];
function navVoice() {
  if (!nav.on || !geo.me || !state.settings.voice) return;
  const said = nav.said;
  const d = nav.retrace ? nav.retrace.left : nav.d;
  if (d == null) return;
  const moving = courseValid();
  const diff = moving ? angleDiff(geo.cog, nav.brg) : null;
  if (nav.arrived) { if (!said.arrived) { said.arrived = true; say(`Вы на месте. ${nav.target.title}`, { force: true }); } return; }
  said.arrived = false;
  // The way back along the track: the wrong way, off the line, a stretch not recorded, the turns of the channel.
  const r = nav.retrace;
  if (r) {
    const now = Date.now();
    if (r.wrong) { if (now - (said.rtWrongT || 0) > 20000) { said.rtWrongT = now; beep('hazard'); say('Не туда! Трек в другую сторону, разворачивайтесь', { force: true }); } return; }
    if (r.offTrack) {
      if (now - (said.rtOffT || 0) > 15000) {
        said.rtOffT = now; said.rtOff = true;
        const o = r.offTrack;
        say(`Вы ${o.side === 'right' ? 'правее' : 'левее'} трека на ${sayDist(o.d)}. Возьмите ${o.side === 'right' ? 'левее' : 'правее'}`, { force: true });
      }
      return;
    }
    if (said.rtOff) { said.rtOff = false; say('Снова на треке', { force: true }); return; }
    if (r.gap && r.gap.d < 120 && said.rtGap !== r.gap.seg) {
      said.rtGap = r.gap.seg;
      say(`Внимание: дальше ${sayDist(r.gap.len)} трек не записан. Смотрите по карте`, { force: true });
      return;
    }
    // A turn once, a minute ahead at most (12 s of the speed, at least 60 m); a sharp one again close to it. Not more
    // often than every 8 s — a winding channel must not talk without a break.
    const tr = r.turn;
    if (tr && moving && now - (said.rtTurnT || 0) > 8000) {
      const sog = geo.sog || 0;
      const key = said.rtTurnAt != null && Math.abs(tr.at - said.rtTurnAt) < 35 ? said.rtTurnKey : Math.round(tr.at);
      if (key !== said.rtTurnKey) { said.rtTurnKey = key; said.rtTurnAt = tr.at; }
      const far = Math.max(60, sog * 12), near = Math.max(20, sog * 4), sharp = Math.abs(tr.angle) >= 100;
      if (tr.d <= far && tr.d > near && said.rtTurnFar !== key) { said.rtTurnFar = key; said.rtTurnT = now; say(`Через ${sayDist(tr.d)} ${turnWords(tr.angle)}`, { force: true }); return; }
      if (tr.d <= near && said.rtTurnNear !== key && (sharp || said.rtTurnFar !== key)) { said.rtTurnNear = key; said.rtTurnFar = key; said.rtTurnT = now; const w = turnWords(tr.angle); say(w[0].toUpperCase() + w.slice(1), { force: true }); return; }
    }
  }
  // Distance marks: once each, on the way in.
  for (const mark of SAY_MARKS) {
    if (d <= mark && d > mark * 0.6 && !said[`d${mark}`]) {
      SAY_MARKS.forEach((m2) => { if (m2 >= mark) said[`d${m2}`] = true; });
      say(`До точки ${sayDist(d)}${diff != null ? `, ${sayWhere(diff)}` : ''}`);
      return;
    }
  }
  if (nav.hazard && nav.hazard.d < 500 && said.hz !== nav.hazard.name) {
    said.hz = nav.hazard.name;
    const h = nav.hazard;
    const least = parseFloat(String(h.depth || '').replace(',', '.'));
    const what = String(h.title || h.name).replace(/\s*\(.*?\)\s*/g, ' ').trim();
    say(`Внимание! Впереди ${what}${Number.isFinite(least) ? `, глубина ${sayDepth(Math.max(0, least + levelNow()))}` : ''}, ${sayDist(h.d)}`, { force: true });
    return;
  }
  // One shoal ahead is one warning (and one more close to it), however the found spot shifts as the boat moves;
  // it counts as a new one after 15 s without shallow water ahead.
  // The banner shows a shoal up to two minutes ahead; the voice speaks a minute before it (at least 200 m), and once
  // more close to it only if there is under a metre of water there.
  if (nav.shoal) {
    const s = nav.shoal, now = Date.now();
    if (!said.shoal || now - said.shoal.seen > 15000) said.shoal = { n: 0, seen: now };
    said.shoal.seen = now;
    if (said.shoal.n === 0 && s.d <= Math.max(200, (geo.sog || 0) * 60)) { said.shoal.n = 1; said.shoalT = now; beep('hazard'); navigator.vibrate?.([100, 60, 100]); say(`Внимание! Впереди мелко: ${sayDepth(s.depth)}, через ${sayDist(s.d)}`, { force: true }); return; }
    if (said.shoal.n === 1 && s.d <= 120 && s.depth < 1) { said.shoal.n = 2; said.shoalT = now; say(`Мель! ${sayDist(s.d)}`, { force: true }); return; }
  }
  if (nav.place && !said[nav.place.key]) { said[nav.place.key] = true; say(nav.place.say, { force: true }); logEvent('place_note', { key: nav.place.key }); return; }
  // The water under the boat: said once when the boat comes into shallow water, again only if it gets half a metre
  // shallower still; out of it (0,5 m deeper than the limit) the next shallow stretch is a new one.
  const dep = nav.depth, lv = levelNow(), lim = +state.settings.shallow || 1.5;
  const now = dep ? (dep.value ?? dep.max) + lv : null;
  if (now != null && now > lim + 0.5) said.shallowAt = null;
  if (now != null && now >= 0.2 && !onIceNow() && moving && now <= lim && !(r && !r.offTrack) && !nav.inReeds && (said.shallowAt == null || now <= said.shallowAt - 0.7)
      && Date.now() - (said.shallowSaidT || 0) > 30000) {
    said.shallowAt = now; said.shallowSaidT = Date.now();
    // Just announced as the shoal ahead: coming onto it needs no second word.
    if (Date.now() - (said.shoalT || 0) < 90000) return;
    say(`Под лодкой мелко: ${sayDepth(now)}`, { force: true });
    return;
  }
  if (nav.offCourse != null && Date.now() - (said.offT || 0) > 30000) {
    said.offT = Date.now();
    const a = Math.round(Math.abs(nav.offCourse) / 10) * 10;
    say(`Поверните ${nav.offCourse > 0 ? 'правее' : 'левее'} на ${a} градусов`);
    return;
  }
  // Nothing said for 3 minutes (a long way, or on foot over the ice): how far, and where.
  if (Date.now() - voiceState.lastT > 180000) say(`До точки ${sayDist(d)}${diff != null ? `, ${sayWhere(diff)}` : ''}`, { force: true });
}

/* ---------- «Человек за бортом»: one tap marks the place and turns the boat back to it (as on every plotter) ----------
   The place is the last fix (a few seconds old at most); without GPS it is taken from the first fix that comes. */
function manOverboard() {
  unlockAudio();
  const me = geo.me && Date.now() - geo.me.t < 30000 ? geo.me : null;
  const go = (p) => {
    const t = Date.now();
    if (typeof addMine === 'function') addMine({ lat: p.lat, lon: p.lon, name: `Человек за бортом ${fmtTime(t)}`, tag: 'other' });
    // startNav() takes the place of the SOS sheet or the menu it was called from (no loop over closing layers: they close asynchronously).
    startNav({ lat: p.lat, lon: p.lon, title: `Человек за бортом ${fmtTime(t)}` });
    navigator.vibrate?.([300, 100, 300]);
    say('Человек за бортом! Место отмечено. Ведём назад', { force: true });
    logEvent('mob', { acc: Math.round(p.acc || 0) });
  };
  if (me) { go(me); return; }
  geo.mobWait = true;
  geoStart({});
  toast('Человек за бортом: жду GPS, место отмечу по первой точке', 6000);
}
/* ---------- «Сторож места»: tells when the place you stand on moves — an ice floe breaking off, an anchor dragging ----------
   None of the navigators anglers use does this from GPS (research/marine_nav_ru_cn.md), and floes with anglers
   on them break off at Ладога every spring. The place is the average of the first fixes; walking or going on at
   more than 3 km/h is you, not the ice — the place is taken again where you stop. An alarm: more than the set
   distance from the place for 20 s with a fix good enough to tell. */
const guard = { on: false, anchor: null, pts: [], r: 50, overT: 0, alarmT: 0, d: 0, t0: 0, moveT: 0 };
function guardStart() {
  unlockAudio();
  if (geo.watchId == null) geoStart({});
  Object.assign(guard, { on: true, anchor: null, pts: [], overT: 0, alarmT: 0, d: 0, t0: Date.now(), moveT: 0, r: +state.settings.guardR || 50 });
  say('Сторож включён. Если место начнёт относить, я предупрежу', { force: true });
  toast(`Сторож: запоминаю место. Тревога — если оно сдвинется больше чем на ${guard.r} м. Экран можно погасить кнопкой с луной`, 7000);
  wakeUpdate(); renderChips();
  logEvent('guard_on', { r: guard.r });
}
function guardStop() {
  guard.on = false;
  wakeUpdate(); renderChips();
  logEvent('guard_off');
  toast('Сторож выключен');
}
function guardOnFix(me) {
  if (!guard.on || me.acc > 35) return;
  // Going somewhere (on foot, on a snowmobile, the boat under way): the place is taken again where you stop.
  if (geo.sog != null && geo.sog * 3.6 > 3) { guard.moveT = Date.now(); guard.anchor = null; guard.pts = []; guard.overT = 0; return; }
  if (!guard.anchor) {
    if (guard.moveT && Date.now() - guard.moveT < 10000) return;
    guard.pts.push({ lat: me.lat, lon: me.lon });
    if (guard.pts.length >= 8) {
      const n = guard.pts.length;
      guard.anchor = { lat: guard.pts.reduce((a, p) => a + p.lat, 0) / n, lon: guard.pts.reduce((a, p) => a + p.lon, 0) / n };
      logEvent('guard_anchor');
    }
    return;
  }
  guard.d = distM(guard.anchor, me);
  if (guard.d > guard.r + me.acc / 2) {
    if (!guard.overT) guard.overT = Date.now();
    if (Date.now() - guard.overT > 20000 && Date.now() - guard.alarmT > 60000) { guard.alarmT = Date.now(); guardAlarm(); }
  } else guard.overT = 0;
}
function guardAlarm() {
  const me = geo.me, d = guard.d;
  hideSaver();
  navigator.vibrate?.([500, 200, 500, 200, 500]);
  beep('hazard'); setTimeout(() => beep('hazard'), 900);
  const drift = guard.anchor ? rumb(bearing(guard.anchor, me)) : '';
  say(`Внимание! Место сдвинулось на ${sayDist(d)}${drift ? ` к ${drift}` : ''}. Если вы на льду, возможно, льдину относит. Звоните 112.`, { force: true });
  logEvent('guard_alarm', { d: Math.round(d), acc: Math.round(me.acc) });
  openModal({
    key: 'guard-alarm', title: `Место сдвинулось на ${fmtDist(d)}`,
    body: () => `<p><b>Если вы на льду — возможно, льдину относит.</b> Не прыгайте через трещину и не идите по воде: звоните 112 и ждите спасателей на льдине.</p>
      <p>Ваши координаты для 112:<br><b class="coord">${fmtDM(me.lat, me.lon)}</b><br><span class="coord small">${fmtDec(me.lat, me.lon)}</span></p>
      <p class="small muted">Относит ${drift ? `на ${drift}` : ''}, ${fmtDist(d)} за ${fmtDur(Date.now() - guard.overT + 20000)}. Точность GPS ±${Math.round(me.acc)} м.</p>`,
    foot: () => `<a class="btn danger" href="tel:112">Позвонить 112</a><button type="button" class="btn ghost" data-act="guard-reset">Это я сам — новое место</button><button type="button" class="btn ghost" data-act="guard-off">Выключить сторож</button>`,
  });
}
function openGuardSheet() {
  openModal({
    key: 'guard', title: 'Сторож места',
    body: () => `<p>${guard.anchor ? `От места <b>${Math.round(guard.d || 0)} м</b>, тревога — после ${guard.r} м.` : 'Запоминаю место: постойте полминуты.'}</p>
      <p class="small">Работает, пока приложение открыто: экран можно погасить кнопкой с луной, но не блокируйте телефон кнопкой.</p>
      <div class="small muted">Тревога, если место сдвинулось больше чем на</div>
      ${seg('guardR', [[30, '30 м'], [50, '50 м'], [100, '100 м']], state.settings.guardR || 50)}`,
    foot: () => `<button type="button" class="btn ghost" data-act="guard-reset">Запомнить место заново</button><button type="button" class="btn danger" data-act="guard-off">Выключить</button>`,
  });
}

let wakeLock = null;
async function wakeUpdate() {
  const want = nav.on || trk.cur?.state === 'rec' || guard.on || state.settings.keepAwake;
  if (want && !wakeLock && document.visibilityState === 'visible' && navigator.wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      // After the toast that started this (e.g. «Пишу трек…»), not over it.
      if (!store.get('ladoga-wake-warned', false)) { store.set('ladoga-wake-warned', true); setTimeout(() => toast('Экран может погаснуть — отключите автоблокировку на время рыбалки', 6000), 5500); }
    }
  } else if (!want && wakeLock) {
    try { await wakeLock.release(); } catch { /* ignore */ }
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  const busy = nav.on || trk.cur?.state === 'rec' || guard.on;
  if (document.visibilityState === 'hidden') {
    geo.hiddenAt = Date.now();
    if (typeof saveCurTrack === 'function') saveCurTrack(true);
    // Not navigating, not recording: GPS off while the app is away (battery; and an iPhone asks again for every
    // new watch). ◎ turns it back on.
    if (!busy && geo.watchId != null && geo.watchId !== 'demo') { gps.clear(geo.watchId); geo.watchId = null; geo.searching = false; updateLocateBtn(); }
    return;
  }
  const gap = geo.hiddenAt ? Date.now() - geo.hiddenAt : 0;
  geo.hiddenAt = 0;
  wakeUpdate();
  // Fixes sometimes freeze after the page comes back: start the watch again — only for navigation or a recording.
  if (busy && geo.watchId != null) restartWatch();
  if (!busy && geo.follow !== 'free') setFollow('free');
  if (gap > 30000 && (nav.on || trk.cur?.state === 'rec')) {
    toast(`${fmtDur(gap)} телефон был заблокирован или приложение свёрнуто — трек в это время не писался. Чтобы писать с погашенным экраном, включайте «Тёмный экран» (кнопка с луной), а не блокировку.`, 9000);
    logEvent('gap', { ms: gap, nav: nav.on, rec: trk.cur?.state === 'rec' });
    if (typeof trackOnResume === 'function') trackOnResume(gap);
  }
});
// Once a second: stale fixes turn grey, timers run, the recenter countdown ticks.
setInterval(() => {
  if (document.hidden) return;
  const dark = $('#btnDark'), wantDark = nav.on || trk.cur?.state === 'rec' || guard.on;
  if (dark && dark.hidden === wantDark) dark.hidden = !wantDark;
  if (geo.me) refreshMeIcon();
  if (nav.on) {
    updateNavFields();
    const ar = +state.settings.autoReturn;
    if (ar && geo.follow === 'free' && navCalm() && Date.now() - nav.lastTouch > ar * 1000) recenter(true);
    // A watch that went quiet (it happens after the phone slept, or on a weak fix): start it again.
    if (geo.watchId != null && geo.watchId !== 'demo' && geo.me && Date.now() - geo.me.t > 20000 && Date.now() - geo.restartT > 30000) restartWatch();
  } else if (trk.cur?.state === 'rec' && geo.watchId != null && geo.watchId !== 'demo' && geo.me && Date.now() - geo.me.t > 20000 && Date.now() - geo.restartT > 30000) restartWatch();
  if (typeof updateTrackUi === 'function') updateTrackUi();
  updateSaver();
}, 1000);
