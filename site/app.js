'use strict';

/* Ладога · рыболовная карта — core: data, the map and its layers, depth, weather, offline packs.
   The interface lives next door: content.js (pages, cards, sheets), tracks.js (tracks and marks),
   geo.js (location, follow, navigation), ui.js (layout, the layers stack and Back, controls, boot).
   Data: data/points.json (reports + markers) and data/context.json, built by scripts/build_data.py. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_IN = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const FISH_COLORS = {
  'Судак': '#f08c00', 'Щука': '#2f9e44', 'Окунь': '#e0b000', 'Лещ': '#a0522d', 'Плотва': '#748ffc',
  'Сиг': '#1c7ed6', 'Ряпушка': '#4dabf7', 'Корюшка': '#12b886', 'Лосось': '#e64980', 'Форель': '#f06595',
  'Палия': '#ae3ec9', 'Налим': '#5c4033', 'Жерех': '#9c36b5', 'Язь': '#d9480f', 'Густера': '#91a7ff',
  'Ёрш': '#868e96', 'Синец': '#3bc9db', 'Уклейка': '#adb5bd',
};
const OTHER_COLOR = '#6c757d';
const KINDS = {
  fishing: { label: 'Рыболовные отчёты', short: 'Отчёт' },
  observation: { label: 'Наблюдения рыбы (фото, iNaturalist, GBIF)', short: 'Наблюдение' },
  structure: { label: 'Банки, свалы, ямы (структура)', short: 'Структура' },
  hazard: { label: 'Мели, камни, опасности', short: 'Опасность' },
  landmark: { label: 'Ориентиры: маяки, мысы, острова', short: 'Ориентир' },
  launch: { label: 'Спуски лодок, гавани, базы', short: 'Спуск / гавань' },
  ice_incident: { label: 'Происшествия на льду (МЧС)', short: 'Происшествие на льду' },
  service: { label: 'Базы, магазины, заправки, больницы, спасатели', short: 'Сервис' },
};
const SERVICE_GLYPH = { base: '⌂', shop: '🎣', fuel: '⛽', hospital: '✚', rescue: '⛑', parking: 'P' };
const CATCH_KINDS = new Set(['fishing', 'observation']);
const DATED_KINDS = new Set(['fishing', 'observation', 'ice_incident']);
const CLASS_TEXT = {
  A: 'точные GPS-координаты, опубликованные рыбаком',
  B: 'геометка публичного отчёта, фото или наблюдения',
  C: 'место по описанию, карте или названию — приблизительно',
};
const SEASON_TEXT = { ice: 'лёд', open_water: 'открытая вода' };
const PLACES = [
  ['Новая Ладога', 60.118, 32.30, 12], ['Креницы', 60.16, 32.24, 12], ['Волховская губа', 60.21, 32.25, 11],
  ['о. Птинов', 60.254, 32.079, 13], ['Варецкие банки', 60.298, 32.107, 13], ['о. Сухо', 60.406, 32.092, 13],
  ['Дубно', 60.235, 31.983, 13], ['Лигово', 60.241, 31.779, 13], ['Вороново', 60.286, 32.60, 12],
  ['Устье Сяси', 60.15, 32.56, 13], ['Нижний Волхов', 60.06, 32.32, 12], ['Кобона', 60.03, 31.55, 12],
  ['Шлиссельбург', 59.95, 31.03, 12], ['Свирская губа', 60.49, 32.85, 11],
];
const EXTRA_PLACES = [['Сясьстрой', 60.14, 32.56], ['Лаврово', 59.96, 31.52], ['Леднево', 60.1, 31.53], ['Кареджи', 60.12, 31.39],
  ['Осиновец', 60.12, 31.07], ['Свирица', 60.47, 32.9], ['Сторожно', 60.53, 32.62]];
// The downloaded area and the default «Мой район».
const REGION = { s: 59.85, w: 30.9, n: 60.8, e: 33.4 };
const HOME_DEFAULT = { name: 'Вся южная Ладога', ...REGION };

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

const state = {
  R: [], M: [], ctx: {}, meta: {},
  pass: [],
  f: defaultFilters(),
  seasonMonth: new Date().getMonth() + 1,
  selected: null,
  fav: new Set(store.get('ladoga-fav', [])),
  mine: store.get('ladoga-mine', []),
  base: store.get('ladoga-base', 'sat'),
  overlays: Object.assign({ seamarks: false, heat: false, cluster: true, radius: false, seasonZones: false, rules: false, lines: true, mine: true, tracks: false, genshtab: false, isobaths: false, charts: false, chartIso: false }, store.get('ladoga-overlays', {})),
  chartOpacity: store.get('ladoga-chart-opacity', 0.85),
  genshtabOpacity: store.get('ladoga-genshtab-opacity', 0.8),
  overlayOpacity: store.get('ladoga-overlay-opacity', 0.7),
  settings: Object.assign({ theme: 'system', units: 'kmh', autoZoom: true, navShowPoints: false, keepAwake: false, sound: true, arrivalR: 30, orient: 'course', autoReturn: 15, shallow: 2 }, store.get('ladoga-settings', {})),
  home: store.get('ladoga-home', null) || HOME_DEFAULT,
  navHide: false,
  shown: { markers: 0, reports: 0 },
};
function saveSettings() { store.set('ladoga-settings', state.settings); }

function defaultFilters() {
  return { fish: new Set(), months: new Set(), season: 'all', cls: new Set(['A', 'B', 'C']), kinds: new Set(Object.keys(KINDS).filter((k) => k !== 'service')), sources: new Set(), core: false, yearMin: 0, fav: false, depthOnly: false };
}

/* ---------- utilities ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const ic = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const toRad = (d) => d * Math.PI / 180;
function distM(a, b) {
  const R = 6371008.8, p1 = toRad(a.lat), p2 = toRad(b.lat), dp = p2 - p1, dl = toRad(b.lon - a.lon);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Signed difference b − a in degrees, −180…180.
const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;
const RUMBS = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
const rumb = (deg) => RUMBS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const RUMBS8 = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
const rumb8 = (deg) => RUMBS8[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
function fmtDist(m) {
  if (m < 1000) return `${Math.round(m)} м`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} км`;
}
function fmtDM(lat, lon) {
  const part = (v, pos, neg) => {
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return `${v >= 0 ? pos : neg} ${d}°${m.toFixed(3).padStart(6, '0')}′`;
  };
  return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`;
}
const fmtDec = (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
function fmtDate(d) {
  if (!d) return 'дата неизвестна';
  const [y, m, day] = d.split('-');
  if (day) return `${+day} ${MONTHS[+m - 1]} ${y}`;
  if (m) return `${MONTHS[+m - 1]} ${y}`;
  return y;
}
const fmtTime = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (t) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
// "1 ч 05 мин", "12 мин", "40 с"
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
}
// Timer: "1:12" (minutes) or "1:12:40" (hours).
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
// Speed from m/s in the chosen units: "18,4" / "0". Below 10 with a tenth, above in whole numbers.
function speedValue(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const v = state.settings.units === 'kn' ? ms * 1.943844 : ms * 3.6;
  if (v < 1) return '0';
  return v < 10 ? v.toFixed(1).replace('.', ',') : String(Math.round(v));
}
const speedUnit = () => (state.settings.units === 'kn' ? 'узлов' : 'км/ч');
const monthOf = (r) => (r.date && r.date.length >= 7 ? +r.date.slice(5, 7) : 0);
const yearOf = (r) => (r.date ? +r.date.slice(0, 4) : 0);
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
};
let toastTimer;
// toast('Сохранено') · toast('Трек удалён', { action: 'Отменить', onAction, ms: 10000 })
function toast(text, opts = {}) {
  if (typeof opts === 'number') opts = { ms: opts };
  const el = $('#toast');
  $('#toastText').textContent = text;
  const b = $('#toastAction');
  b.hidden = !opts.action;
  if (opts.action) {
    b.textContent = opts.action;
    b.onclick = () => { el.classList.remove('show'); opts.onAction?.(); };
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), opts.ms || (opts.action ? 8000 : 2600));
}
async function copy(text, label = 'Скопировано') {
  try { await navigator.clipboard.writeText(text); toast(`${label}: ${text}`); }
  catch { toast(text, 12000); }
}
function download(name, text, type = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// Share a file where the phone can (AirDrop, Telegram, Navionics…), otherwise save it.
async function shareFile(name, text, type = 'application/gpx+xml') {
  try {
    const file = new File([text], name, { type });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  download(name, text, type);
}
const pointKey = (lat, lon) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
function platformInfo() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inApp = (iOS && typeof navigator.standalone === 'undefined') || /Telegram|FBAN|FBAV|Instagram|VKClient|Line\/|; wv\)/i.test(ua);
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return { iOS, inApp, installed, android: /Android/i.test(ua) };
}

/* ---------- map ---------- */
const MAX_BOUNDS = L.latLngBounds([59.45, 30.2], [61.2, 34.1]);
const homeBounds = () => L.latLngBounds([state.home.s, state.home.w], [state.home.n, state.home.e]);
const map = L.map('map', {
  zoomControl: false, attributionControl: false, maxZoom: 18, minZoom: 8, worldCopyJump: false,
  maxBounds: MAX_BOUNDS, maxBoundsViscosity: 1.0,
  // Turning the map is programmatic only (course / compass): two fingers in gloves would turn it by accident.
  rotate: true, bearing: 0, touchRotate: false, shiftKeyRotate: false, rotateControl: false, compassBearing: false,
});
(() => { // The last view comes back after a restart; outside the area — «Мой район».
  const v = store.get('ladoga-view', null);
  if (v && MAX_BOUNDS.contains([v.lat, v.lon]) && v.z >= 8) map.setView([v.lat, v.lon], Math.min(18, v.z), { animate: false });
  else map.fitBounds(homeBounds(), { animate: false });
})();
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
let viewTimer;
map.on('moveend', () => {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { const c = map.getCenter(); store.set('ladoga-view', { lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5), z: map.getZoom() }); }, 1000);
});

// Outside the downloaded area without internet the map shows a light hatch rather than a grey void.
const NO_TILE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#d7dee3"/><path d="M0 256L256 0M-64 64L64-64M192 320L320 192M0 128L128 0M128 256L256 128" stroke="#b8c3ca" stroke-width="6"/></svg>')}`;
const ESRI_ATTR = 'Снимки © Esri, Maxar, Earthstar Geographics';
const OSM_ATTR = '© участники OpenStreetMap';
const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const BASES = {
  sat: {
    name: 'Спутник', attr: ESRI_ATTR, thumb: SAT_URL,
    make: () => L.layerGroup([
      L.tileLayer(SAT_URL, { maxZoom: 18, maxNativeZoom: 18, crossOrigin: 'anonymous', errorTileUrl: NO_TILE }),
      L.tileLayer(LABELS_URL, { maxZoom: 18, maxNativeZoom: 18, crossOrigin: 'anonymous' }),
    ]),
  },
  osm: {
    name: 'Схема', attr: OSM_ATTR, thumb: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, crossOrigin: 'anonymous', errorTileUrl: NO_TILE }),
  },
  topo: {
    name: 'Топо', attr: `${OSM_ATTR}, OpenTopoMap (CC-BY-SA)`, thumb: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    make: () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 18, maxNativeZoom: 17, subdomains: 'abc', errorTileUrl: NO_TILE }),
  },
};
const extraOverlays = {}; // filled from context.tile_layers
let baseLayer = null;
function setBase(key) {
  if (!BASES[key]) key = 'sat';
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = BASES[key].layer || (BASES[key].layer = BASES[key].make());
  baseLayer.addTo(map);
  if (baseLayer.bringToBack) baseLayer.bringToBack();
  state.base = key;
  store.set('ladoga-base', key);
  const a = $('#attrLine');
  if (a) a.textContent = `${BASES[key].attr || ''}${state.overlays.charts ? ' · ГУНиО' : ''}`;
}
// A z10 tile over the Volkhov bay: the preview of each base map in the layers sheet.
function baseThumb(key) {
  const t = BASES[key]?.thumb;
  if (!t) return '';
  const z = 10, x = lon2x(32.2, z), y = lat2y(60.2, z);
  return L.Util.template(t.replace('{s}', 'a'), { z, x, y });
}

// Chart panes sit inside the rotating pane, above the base map and below points and zones.
map.createPane('charts', map.getPane('rotatePane'));
map.getPane('charts').style.zIndex = 250;
map.getPane('charts').style.pointerEvents = 'none';

const layers = {
  seamarks: L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 18, maxNativeZoom: 18, zIndex: 5 }),
  heat: L.heatLayer([], { radius: 24, blur: 20, maxZoom: 13, minOpacity: 0.3, gradient: { 0.2: '#2c7fb8', 0.45: '#41b6c4', 0.65: '#ffffb2', 0.85: '#fd8d3c', 1: '#e31a1c' } }),
  cluster: L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 44, spiderfyDistanceMultiplier: 1.4, disableClusteringAtZoom: 15, chunkedLoading: true }),
  plain: L.layerGroup(),
  pois: L.layerGroup(),
  radius: L.circle([60.1037, 32.294], { radius: 55000, color: '#fff', weight: 1.5, dashArray: '6 8', fill: false, interactive: false }),
  seasonZones: L.layerGroup(),
  rules: L.layerGroup(),
  lines: L.layerGroup(),
  mine: L.layerGroup(),
  tracks: L.layerGroup(),
  genshtab: L.layerGroup(),
  isobaths: L.layerGroup(),
  navHazards: L.layerGroup(),
  trackCur: L.layerGroup(),
  nav: L.layerGroup(),
  me: L.layerGroup(),
  select: L.layerGroup(),
};
layers.trackCur.addTo(map); layers.nav.addTo(map); layers.navHazards.addTo(map); layers.me.addTo(map); layers.select.addTo(map);

// In navigation the points, zones and heat are put away (unless «Показать точки рядом»); charts, lanes and marks stay.
function applyOverlays() {
  const o = state.overlays;
  const hide = state.navHide && !state.settings.navShowPoints;
  const toggle = (layer, on) => { if (on && !map.hasLayer(layer)) layer.addTo(map); if (!on && map.hasLayer(layer)) map.removeLayer(layer); };
  toggle(layers.seamarks, o.seamarks);
  toggle(layers.heat, o.heat && !state.navHide);
  toggle(layers.cluster, o.cluster && !hide);
  toggle(layers.plain, !o.cluster && !hide);
  toggle(layers.radius, o.radius && !state.navHide);
  toggle(layers.seasonZones, o.seasonZones && !state.navHide);
  toggle(layers.rules, o.rules && !state.navHide);
  toggle(layers.lines, o.lines);
  toggle(layers.mine, o.mine && !hide);
  toggle(layers.tracks, o.tracks && !state.navHide);
  toggle(layers.genshtab, o.genshtab);
  toggle(layers.isobaths, o.isobaths);
  toggle(chartState.isoLayer, o.chartIso);
  if (o.chartIso) loadChartIsobaths();
  updateCharts();
  if (o.isobaths) ensureIsobaths();
  if (o.genshtab) layers.genshtab.eachLayer((l) => l.setOpacity(state.genshtabOpacity));
  for (const [key, ov] of Object.entries(extraOverlays)) {
    toggle(ov.layer, !!o[key]);
    ov.layer.setOpacity?.(state.overlayOpacity);
  }
  updatePoiVisibility();
  store.set('ladoga-overlays', o);
  const a = $('#attrLine');
  if (a) a.textContent = `${BASES[state.base]?.attr || ''}${o.charts ? ' · ГУНиО' : ''}`;
}

/* ---------- filtering & rendering ---------- */
// Points of interest show from zoom 11 (or at once when the filter asks only for them); names from 13.
function updatePoiVisibility() {
  const onlyPoi = ![...state.f.kinds].some((k) => CATCH_KINDS.has(k));
  const show = (map.getZoom() >= 11 || onlyPoi) && !(state.navHide && !state.settings.navShowPoints);
  if (show && !map.hasLayer(layers.pois)) layers.pois.addTo(map);
  if (!show && map.hasLayer(layers.pois)) map.removeLayer(layers.pois);
  map.getContainer().classList.toggle('labels-on', map.getZoom() >= 13);
}
map.on('zoomend', () => updatePoiVisibility());
// "Банка Железница (Железницкие банки)" + "1,2 м (наименьшая…)" → "Железница 1,2 м".
function poiLabel(r) {
  const name = String(r.title || '').replace(/^(Банка|Банки)\s+/i, '').replace(/\s*\(.*\)\s*/g, ' ').replace(/^Створный знак:\s*/, '').trim();
  const depth = String(r.depth || '').match(/[\d,.]+(?:\s*[–-]\s*[\d,.]+)?\s*м/);
  return `${name.slice(0, 28)}${depth ? ` ${depth[0]}` : ''}`;
}

function passes(r) {
  const f = state.f;
  if (!f.kinds.has(r.kind)) return false;
  if (!f.cls.has(r.cls)) return false;
  if (f.sources.size && !f.sources.has(r.src)) return false;
  if (f.core && r.zone !== 'core') return false;
  if (CATCH_KINDS.has(r.kind) && f.fish.size && !(r.fish || []).some((x) => f.fish.has(x))) return false;
  if (DATED_KINDS.has(r.kind)) {
    if (f.months.size && !f.months.has(monthOf(r))) return false;
    if (f.season !== 'all' && r.season !== f.season) return false;
    if (f.yearMin && yearOf(r) < f.yearMin) return false;
  } else if (f.fish.size || f.months.size || f.season !== 'all' || f.yearMin) {
    // With a catch filter on, keep only the structure of the lake visible, not its hazards noise.
    if (!['structure', 'landmark', 'launch', 'hazard'].includes(r.kind)) return false;
  }
  if (f.fav && !state.fav.has(pointKey(r.lat, r.lon))) return false;
  if (f.depthOnly && !r.depth) return false;
  return true;
}

// Every mark is a 44×44 target with the visible dot in the middle: easy to hit in gloves.
function markerIcon(m, rs) {
  const kind = m.kind;
  if (!CATCH_KINDS.has(kind)) {
    const sub = state.R[m.r[0]].sub || '';
    const glyph = SERVICE_GLYPH[sub] || { launch: '⚓', ice_incident: '!', hazard: '' }[kind] || '';
    const label = ['structure', 'hazard', 'landmark'].includes(kind) ? `<span class="poi-label">${esc(poiLabel(state.R[m.r[0]]))}</span>` : '';
    return L.divIcon({ className: 'hit poi', html: `<div class="shape ${kind} ${sub}">${glyph}</div>${label}`, iconSize: [44, 44], iconAnchor: [22, 22] });
  }
  const counts = {};
  for (const i of rs) for (const f of state.R[i].fish || []) counts[f] = (counts[f] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const color = FISH_COLORS[top] || OTHER_COLOR;
  const exact = rs.some((i) => state.R[i].cls === 'A');
  const obs = rs.every((i) => state.R[i].kind === 'observation');
  const fav = state.fav.has(pointKey(m.lat, m.lon));
  const n = rs.length;
  const cls = ['pin', exact ? 'A' : '', obs ? 'obs' : '', n > 1 ? 'multi' : '', fav ? 'fav' : ''].join(' ');
  const style = obs ? `border-color:${color}` : `background:${color}`;
  return L.divIcon({ className: 'hit', html: `<div class="${cls}" style="${style}">${n > 1 ? n : ''}</div>`, iconSize: [44, 44], iconAnchor: [22, 22] });
}

function render() {
  state.pass = state.R.map(passes);
  const markers = [];
  const pois = [];
  const heat = [];
  let nM = 0, nR = 0;
  state.M.forEach((m, idx) => {
    const rs = m.r.filter((i) => state.pass[i]);
    if (!rs.length) return;
    nM += 1; nR += rs.length;
    const mk = L.marker([m.lat, m.lon], { icon: markerIcon(m, rs), keyboard: false, riseOnHover: true });
    mk.on('click', () => openPoint(idx));
    if (CATCH_KINDS.has(m.kind)) markers.push(mk); else pois.push(mk);
    if (CATCH_KINDS.has(m.kind)) heat.push([m.lat, m.lon, Math.min(1, 0.35 + rs.length * 0.2)]);
  });
  layers.cluster.clearLayers();
  layers.plain.clearLayers();
  layers.pois.clearLayers();
  pois.forEach((mk) => layers.pois.addLayer(mk));
  updatePoiVisibility();
  if (state.overlays.cluster) layers.cluster.addLayers(markers); else markers.forEach((mk) => layers.plain.addLayer(mk));
  layers.heat.setLatLngs(heat);
  state.shown = { markers: nM, reports: nR };
  if (typeof onFilterChange === 'function') onFilterChange();
}

// What the filter narrows, as short words for the chip on the map and the badge on the filter button.
function activeFilters() {
  const f = state.f, chips = [];
  if (f.fish.size) chips.push(['fish', [...f.fish].join(', ').toLowerCase()]);
  if (f.months.size) chips.push(['months', [...f.months].sort((a, b) => a - b).map((m) => MONTHS[m - 1]).join(', ')]);
  if (f.season !== 'all') chips.push(['season', SEASON_TEXT[f.season]]);
  if (f.cls.size < 3) chips.push(['cls', `класс ${[...f.cls].sort().join('')}`]);
  if (f.sources.size) chips.push(['sources', `${f.sources.size} ${plural(f.sources.size, 'источник', 'источника', 'источников')}`]);
  if (f.core) chips.push(['core', '≤55 км']);
  if (f.yearMin) chips.push(['yearMin', `с ${f.yearMin} г.`]);
  if (f.fav) chips.push(['fav', 'избранное']);
  if (f.depthOnly) chips.push(['depthOnly', 'с глубиной']);
  const dk = defaultFilters().kinds;
  if (f.kinds.size !== dk.size || [...f.kinds].some((k) => !dk.has(k))) chips.push(['kinds', `слоёв ${f.kinds.size} из ${Object.keys(KINDS).length}`]);
  return chips;
}
function resetFilters() { state.f = defaultFilters(); render(); drawSeasonZones(); }

/* ---------- navigation charts (ГУНиО 1:10 000–1:125 000) and depth ---------- */
const chartState = { items: [], tiles: [], iso: null, isoLines: null, isoLayer: L.layerGroup(), grid: null };
function buildCharts() {
  chartState.items = (state.ctx.depth?.charts || []).map((c) => ({ ...c, layer: null, b: L.latLngBounds(c.bounds) }))
    .sort((a, b) => b.scale - a.scale); // overview first, the most detailed on top
}
// Sharp chart tiles cut straight from the original scans (tiles/index.json, scripts/build_chart_tiles.py):
// «charts» to z15 everywhere plus z16 inside the 1:10 000 / 1:25 000 sheets, «genshtab» to z14.
const CLEAR_TILE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
async function loadChartTiles() {
  try {
    const idx = await fetch('tiles/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null));
    if (!idx || !Array.isArray(idx.layers)) return;
    chartState.index = idx;
    const mk = (l, extra = {}) => L.tileLayer(l.url, {
      pane: 'charts', minZoom: 8, maxZoom: 18, minNativeZoom: +l.minZoom || 9, maxNativeZoom: +l.maxNativeZoom || 15,
      bounds: l.bounds ? L.latLngBounds(l.bounds) : undefined, errorTileUrl: CLEAR_TILE, keepBuffer: 3, ...extra,
    });
    const charts = idx.layers.find((l) => l.id === 'charts');
    if (charts) {
      chartState.tiles = [{ layer: mk(charts, { zIndex: 2 }) }];
      for (const r of charts.detail?.regions || []) {
        chartState.tiles.push({ layer: mk(charts, { zIndex: 3, minZoom: 16, minNativeZoom: 16, maxNativeZoom: 16, bounds: L.latLngBounds(r.bounds) }) });
      }
    }
    const gs = idx.layers.find((l) => l.id === 'genshtab');
    if (gs) {
      layers.genshtab.clearLayers();
      mk(gs, { zIndex: 1, opacity: state.genshtabOpacity }).addTo(layers.genshtab);
    }
    applyOverlays();
  } catch { chartState.tiles = []; }
}
// Only the charts that suit the zoom and touch the view are on the map, so a phone loads a few files, not 32.
function updateCharts() {
  const on = state.overlays.charts;
  if (chartState.tiles.length) {
    for (const t of chartState.tiles) {
      if (on && !map.hasLayer(t.layer)) t.layer.addTo(map);
      if (!on && map.hasLayer(t.layer)) map.removeLayer(t.layer);
      t.layer.setOpacity(state.chartOpacity);
    }
    for (const c of chartState.items) if (c.layer && map.hasLayer(c.layer)) map.removeLayer(c.layer);
    return;
  }
  const z = map.getZoom();
  const view = map.getBounds().pad(0.3);
  for (const c of chartState.items) {
    const want = on && z >= c.zmin && z <= c.zmax && view.intersects(c.b);
    if (want && !c.layer) c.layer = L.imageOverlay(c.url, c.bounds, { pane: 'charts', opacity: state.chartOpacity, interactive: false });
    if (want && !map.hasLayer(c.layer)) c.layer.addTo(map);
    if (!want && c.layer && map.hasLayer(c.layer)) map.removeLayer(c.layer);
    if (c.layer) c.layer.setOpacity(state.chartOpacity);
  }
  chartState.items.filter((c) => c.layer && map.hasLayer(c.layer)).forEach((c) => c.layer.bringToFront());
}
map.on('moveend zoomend', () => { if (!chartState.tiles.length) updateCharts(); });

async function loadChartIsobaths() {
  const url = state.ctx.depth?.chart_isobaths;
  if (!url) return null;
  if (chartState.iso) return chartState.iso;
  chartState.iso = fetch(url).then((r) => r.json()).then((gj) => {
    const lines = [];
    for (const f of gj.features || []) {
      const depth = +f.properties.depth_m;
      const parts = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
      for (const part of parts) {
        const pts = part.map(([lon, lat]) => [lat, lon]);
        let s = 90, w = 180, n = -90, e = -180;
        for (const [la, lo] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
        lines.push({ depth, pts, s, w, n, e, chart: f.properties.chart });
      }
    }
    chartState.isoLines = lines;
    L.geoJSON(gj, {
      style: (f) => {
        const m = +f.properties.depth_m;
        return { color: m <= 2 ? '#e8590c' : m <= 5 ? '#1c7ed6' : m <= 10 ? '#1864ab' : m <= 20 ? '#5f3dc4' : '#212529', weight: m === 5 || m === 10 ? 2.4 : 1.6, opacity: 0.9, interactive: false };
      },
    }).addTo(chartState.isoLayer);
    if (typeof onDepthReady === 'function') onDepthReady();
    return lines;
  }).catch(() => { chartState.iso = null; return null; });
  return chartState.iso;
}
// A depth grid digitised from the chart soundings (data/depth_grid.json): {lat0, lon0, dlat, dlon, rows, cols, scale, data}.
async function loadDepthGrid() {
  const url = state.ctx.depth?.grid;
  if (!url || chartState.grid) return;
  try {
    const g = await fetch(url).then((r) => (r.ok ? r.json() : null));
    if (g && Array.isArray(g.data)) { chartState.grid = g; if (typeof onDepthReady === 'function') onDepthReady(); }
  } catch { /* no grid */ }
}
function gridDepth(p) {
  const g = chartState.grid;
  if (!g) return null;
  const fy = (p.lat - g.lat0) / g.dlat, fx = (p.lon - g.lon0) / g.dlon;
  const y0 = Math.floor(fy), x0 = Math.floor(fx);
  if (y0 < 0 || x0 < 0 || y0 >= g.rows - 1 || x0 >= g.cols - 1) return null;
  const at = (y, x) => { const v = g.data[y * g.cols + x]; return v == null || v < -900 ? null : v / (g.scale || 1); };
  const v00 = at(y0, x0), v01 = at(y0, x0 + 1), v10 = at(y0 + 1, x0), v11 = at(y0 + 1, x0 + 1);
  const vals = [v00, v01, v10, v11];
  if (vals.some((v) => v == null)) {
    const ok = vals.filter((v) => v != null);
    return ok.length >= 2 ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
  }
  const tx = fx - x0, ty = fy - y0;
  return v00 * (1 - tx) * (1 - ty) + v01 * tx * (1 - ty) + v10 * (1 - tx) * ty + v11 * tx * ty;
}
// Depth at a place: the digitised grid if the place is on it, else the chart isobaths: on a line → "≈ 5 м";
// between two → "5–10 м". null off the charts.
function depthAt(p) {
  const gd = gridDepth(p);
  if (gd != null && gd >= 0) {
    const v = gd < 10 ? Math.round(gd * 10) / 10 : Math.round(gd);
    return { text: `≈ ${String(v).replace('.', ',')} м`, min: v, max: v, value: v };
  }
  const lines = chartState.isoLines;
  if (!lines) return null;
  const pad = 0.03;
  const best = new Map();
  for (const l of lines) {
    if (p.lat < l.s - pad || p.lat > l.n + pad || p.lon < l.w - pad * 2 || p.lon > l.e + pad * 2) continue;
    let d = Infinity;
    for (let i = 0; i < l.pts.length - 1; i++) d = Math.min(d, distToSegmentM(p, l.pts[i], l.pts[i + 1]));
    if (d < (best.get(l.depth) ?? Infinity)) best.set(l.depth, d);
  }
  const near = [...best.entries()].filter(([, d]) => d < 2500).sort((a, b) => a[1] - b[1]);
  if (!near.length) return null;
  const [d1, a] = near[0];
  if (a < 80) return { text: `≈ ${d1} м`, min: d1, max: d1, value: d1 };
  const other = near.find(([dep]) => dep !== d1);
  if (!other) return { text: `около ${d1} м`, min: d1, max: d1, value: d1 };
  const lo = Math.min(d1, other[0]), hi = Math.max(d1, other[0]);
  return { text: `${lo}–${hi} м`, min: lo, max: hi, value: null };
}
function distToSegmentM(p, a, b) {
  // Equirectangular projection is plenty at these distances.
  const k = Math.cos(toRad(p.lat)) * 111320, m = 110540;
  const ax = (a[1] - p.lon) * k, ay = (a[0] - p.lat) * m, bx = (b[1] - p.lon) * k, by = (b[0] - p.lat) * m;
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

const GENSHTAB_ATTR = 'Топокарта Генштаба СССР 1:100 000 (скан maps.vlasenko.net)';
function buildDepthLayers() {
  const d = state.ctx.depth || {};
  layers.genshtab.clearLayers();
  for (const o of d.overlays || []) {
    if (!Array.isArray(o.bounds)) continue;
    L.imageOverlay(o.url, o.bounds, { opacity: state.genshtabOpacity, interactive: false, className: 'genshtab' }).addTo(layers.genshtab);
  }
}
async function ensureIsobaths() {
  const url = state.ctx.depth?.isobaths;
  if (!url || state.isobathsLoaded) return;
  state.isobathsLoaded = true;
  try {
    const gj = await fetch(url).then((r) => r.json());
    L.geoJSON(gj, {
      style: (f) => {
        const m = +f.properties.depth_m;
        return { color: m <= 4 ? '#74c0fc' : m <= 10 ? '#339af0' : m <= 20 ? '#1c7ed6' : '#1864ab', weight: m % 10 === 0 ? 2.2 : 1.3, opacity: 0.85, dashArray: m <= 4 ? '3 4' : null, interactive: false };
      },
    }).addTo(layers.isobaths);
  } catch { state.isobathsLoaded = false; toast('Не удалось загрузить изобаты'); }
}

/* ---------- lanes, extra tile layers ---------- */
function drawLines() {
  layers.lines.clearLayers();
  for (const line of state.ctx.lines || []) {
    const coords = (line.coords || []).map((p) => (Array.isArray(p) ? p : [p.lat, p.lon]));
    if (coords.length < 2) continue;
    const reef = line.kind === 'reef';
    L.polyline(coords, { color: reef ? '#fa5252' : '#ffd43b', weight: reef ? 4 : 2.5, opacity: 0.9, dashArray: reef ? '2 6' : '10 6', lineCap: 'round', interactive: false })
      .addTo(layers.lines);
  }
}
function addExtraTileLayers() {
  for (const t of state.ctx.tile_layers || []) {
    if (!t.url || BASES[t.key]) continue;
    BASES[t.key] = {
      name: t.name.replace(/^Генштаб\s*/i, 'Генштаб ').replace(/\s*\(.*\)$/, ''), full: t.name, attr: t.attribution || 'nakarte.me', thumb: t.tms ? null : t.url,
      make: () => L.tileLayer(t.url, { maxZoom: 18, maxNativeZoom: +t.max_zoom || 14, tms: !!t.tms, subdomains: t.subdomains || 'abc', errorTileUrl: NO_TILE }),
    };
  }
  if (!BASES[state.base]) state.base = 'sat';
}

/* ---------- species, seasons and zones ---------- */
function speciesList() { return (state.ctx.species || []).filter((s) => s && s.name_ru); }
// "Лещ (и подлещик)" → "Лещ": the name the reports use, for colours and the fish filter.
const SPECIES_ALIAS = { 'Кумжа': 'Форель' };
function speciesKey(s) {
  const first = String(s.name_ru || '').split(/[\s(]/)[0];
  return SPECIES_ALIAS[first] || first;
}
const speciesColor = (s) => FISH_COLORS[speciesKey(s)] || OTHER_COLOR;
const ACT = ['не ловится / запрет', 'слабо', 'хорошо', 'пик'];
const dots = (v) => `<span class="dots" title="${ACT[v]}">${'●'.repeat(v)}${'○'.repeat(3 - v)}</span>`;
const monthList = (arr) => (Array.isArray(arr) ? arr : []).map(Number).filter((m) => m >= 1 && m <= 12);
function seasonZoneById(id) { return id ? (state.ctx.season_zones || []).find((z) => z.id === id) : null; }
function monthsText(arr) {
  const ms = monthList(arr);
  if (!ms.length) return '';
  if (ms.length === 12) return 'круглый год';
  return ms.map((m) => MONTHS[m - 1]).join(', ');
}
function isIceMonth(mo) {
  const h = (state.ctx.hydro_calendar || []).find((x) => +x.month === mo);
  if (h && h.ice) return /^\s*(лёд|лед|ледостав|становление|подл)/i.test(h.ice);
  return [12, 1, 2, 3].includes(mo);
}
function methodFor(s, ice) {
  const bm = s.best_methods || {};
  return (ice ? bm.ice : bm.open_water) || '';
}
function zonesFor(s, mo) {
  return (s.zones || []).filter((z) => !monthList(z.months).length || monthList(z.months).includes(mo));
}
const shortName = (s) => String(s.name_ru || '').replace(/\s*\(.*\)/, '').replace(/ озёрный.*| озерный.*/, '');
function activity(s, mo) { return +(s.activity_by_month || [])[mo - 1] || 0; }
function zoneSpecies(z, mo) {
  const sp = speciesList().filter((s) => (s.zones || []).some((sz) => sz.zone_id === z.id && (!monthList(sz.months).length || monthList(sz.months).includes(mo))));
  const open = sp.filter((s) => activity(s, mo) > 0).sort((a, b) => activity(b, mo) - activity(a, mo));
  const closed = sp.filter((s) => activity(s, mo) === 0);
  return { open, closed };
}
// A species zone borrows the outline of the season zone it refers to (zone_id), keeping its own months and note.
function speciesZoneGeo(z) {
  const base = seasonZoneById(z.zone_id);
  return base ? { ...base, ...z, polygon: base.polygon, line: base.line, buffer_width_km: base.buffer_width_km, radius_km: z.radius_km || base.radius_km, description: base.description, id: base.id } : z;
}
// A zone is a circle (lat/lon/radius_km), a polygon, or a line with a width (line_buffer).
// Its outline never catches taps — a tap on the water must reach the map and the points. Each drawn
// zone gets a small label instead; the label opens the zone's card.
function zoneShape(z, color, dim = false) {
  const style = { color, weight: dim ? 1.5 : 2.5, opacity: dim ? 0.6 : 0.95, fillColor: color, fillOpacity: dim ? 0.05 : 0.16, dashArray: dim ? '3 6' : null, interactive: false };
  const pts = (arr) => (arr || []).map((p) => (Array.isArray(p) ? [+p[0], +p[1]] : [+p.lat, +p.lon]));
  if (Array.isArray(z.polygon) && z.polygon.length > 2) return L.polygon(pts(z.polygon), style);
  if (Array.isArray(z.line) && z.line.length > 1) {
    const km = +z.buffer_width_km || 1;
    return L.polyline(pts(z.line), { color, weight: Math.max(6, Math.min(26, km * 7)), opacity: dim ? 0.25 : 0.4, lineCap: 'round', interactive: false });
  }
  if (z.lat != null && z.lon != null) return L.circle([+z.lat, +z.lon], { ...style, radius: (+z.radius_km || 1) * 1000 });
  return null;
}
function zoneCenter(z) {
  if (z.lat != null && z.lon != null) return { lat: +z.lat, lon: +z.lon };
  const pts = z.polygon || z.line || [];
  return { lat: pts.reduce((a, p) => a + p[0], 0) / pts.length, lon: pts.reduce((a, p) => a + p[1], 0) / pts.length };
}
function zoneAnchor(z) {
  if (Array.isArray(z.line) && z.line.length > 1) { const p = z.line[Math.floor(z.line.length / 2)]; return [+p[0], +p[1]]; }
  const c = zoneCenter(z);
  return [c.lat, c.lon];
}
function zoneTag(z, color, text, onClick) {
  const html = `<button type="button" class="zone-tag" style="--zc:${color}">${esc(text)}</button>`;
  const m = L.marker(zoneAnchor(z), { icon: L.divIcon({ className: 'zone-tag-wrap', html, iconSize: null }), keyboard: false, zIndexOffset: -500 });
  m.on('click', onClick);
  return m;
}
function zoneLayer(z, color, label) {
  const shape = zoneShape(z, color);
  if (!shape) return null;
  return L.featureGroup([shape, zoneTag(z, color, label, () => openZoneCard(z))]);
}
// What the zones say for the month: colour = the fish that bites best there now, label = up to two fish.
function drawSeasonZones() {
  layers.seasonZones.clearLayers();
  if (!state.overlays.seasonZones) return;
  const mo = state.seasonMonth;
  const chosen = state.f.fish;
  for (const z of state.ctx.season_zones || []) {
    let { open, closed } = zoneSpecies(z, mo);
    if (chosen.size) { open = open.filter((s) => chosen.has(speciesKey(s))); closed = closed.filter((s) => chosen.has(speciesKey(s))); }
    if (!open.length && !closed.length) continue;
    const color = open.length ? speciesColor(open[0]) : '#868e96';
    const shape = zoneShape(z, color, !open.length);
    if (!shape) continue;
    shape.addTo(layers.seasonZones);
    const text = open.length ? open.slice(0, 2).map(shortName).join(', ') + (open.length > 2 ? ` +${open.length - 2}` : '') : `нельзя: ${closed.slice(0, 2).map(shortName).join(', ')}`;
    zoneTag(z, color, text, () => openZoneCard(z)).addTo(layers.seasonZones);
  }
}
function pointInPolygon(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Distance from a point to the zone's edge (0 inside).
function zoneDistM(z, p) {
  if (Array.isArray(z.polygon) && z.polygon.length > 2) {
    if (pointInPolygon(p.lat, p.lon, z.polygon)) return 0;
    let best = Infinity;
    for (let i = 0; i < z.polygon.length; i++) best = Math.min(best, distToSegmentM(p, z.polygon[i], z.polygon[(i + 1) % z.polygon.length]));
    return best;
  }
  if (Array.isArray(z.line) && z.line.length > 1) {
    let best = Infinity;
    for (let i = 0; i < z.line.length - 1; i++) best = Math.min(best, distToSegmentM(p, z.line[i], z.line[i + 1]));
    return Math.max(0, best - ((+z.buffer_width_km || 1) * 1000) / 2);
  }
  return Math.max(0, distM(p, { lat: +z.lat, lon: +z.lon }) - (+z.radius_km || 1) * 1000);
}
function placeStats(z) {
  if (z._stats) return z._stats;
  const fish = new Map(), months = Array(12).fill(0);
  let n = 0;
  const access = [], hazards = [];
  state.M.forEach((m, idx) => {
    const d = zoneDistM(z, m);
    const kind = m.kind;
    if (CATCH_KINDS.has(kind) && d === 0) {
      for (const i of m.r) {
        const r = state.R[i];
        if (!CATCH_KINDS.has(r.kind)) continue;
        n += 1;
        const mo = monthOf(r);
        if (mo) months[mo - 1] += 1;
        for (const f of r.fish || []) fish.set(f, (fish.get(f) || 0) + 1);
      }
    } else if (kind === 'launch' && d < 4000) access.push({ idx, d, title: state.R[m.r[0]].title || 'Спуск' });
    else if ((kind === 'hazard' || kind === 'ice_incident') && d < 1500) hazards.push({ idx, title: state.R[m.r[0]].title || KINDS[kind].short });
  });
  access.sort((a, b) => a.d - b.d);
  z._stats = { n, fish: [...fish.entries()].sort((a, b) => b[1] - a[1]), months, access, hazards };
  return z._stats;
}
// Bounds without a map: a circle's own getBounds() needs one.
function zoneBounds(z) {
  const pts = (arr) => arr.map((p) => (Array.isArray(p) ? [+p[0], +p[1]] : [+p.lat, +p.lon]));
  if (Array.isArray(z.polygon) && z.polygon.length > 2) return L.latLngBounds(pts(z.polygon));
  if (Array.isArray(z.line) && z.line.length > 1) return L.latLngBounds(pts(z.line)).pad(0.15);
  if (z.lat != null && z.lon != null) {
    const r = +z.radius_km || 1, dLat = r / 111, dLon = r / (111 * Math.cos(toRad(+z.lat)));
    return L.latLngBounds([+z.lat - dLat, +z.lon - dLon], [+z.lat + dLat, +z.lon + dLon]);
  }
  return null;
}

/* Season mode: the whole map follows one month — its reports, where they cluster, and the zones of the
   fish that bite then. A banner on the map steps through the year (‹ ›) or plays it. */
function seasonSummary(mo) {
  const sp = speciesList();
  const best = sp.filter((s) => activity(s, mo) >= 2).sort((a, b) => activity(b, mo) - activity(a, mo)).map(shortName);
  const n = state.R.filter((r) => CATCH_KINDS.has(r.kind) && monthOf(r) === mo).length;
  return { best, n };
}
function showSeasonMonth(mo) {
  state.seasonMonth = mo;
  state.f.months = new Set([mo]);
  render();
  drawSeasonZones();
  const { best, n } = seasonSummary(mo);
  const name = MONTHS_FULL[mo - 1];
  $('#mbMonth').textContent = `${name[0].toUpperCase()}${name.slice(1)}`;
  $('#mbFish').textContent = `${best.length ? `Клюёт: ${best.slice(0, 5).join(', ').toLowerCase()}` : 'Клёв слабый'}. Отчётов за ${MONTHS_FULL[mo - 1]}: ${n} (все годы); цветные зоны — где эта рыба держится.`;
}
function setAutoplay(on) {
  clearInterval(state.playing);
  state.playing = on ? setInterval(() => showSeasonMonth(state.seasonMonth % 12 + 1), 2600) : null;
  $('#mbPlay').innerHTML = ic(on ? 'pause' : 'play-arrow');
  $('#mbPlay').setAttribute('aria-label', on ? 'Пауза' : 'Играть');
}
function seasonModeOn() {
  state.season = { months: new Set(state.f.months), heat: state.overlays.heat, zones: state.overlays.seasonZones };
  state.overlays.heat = true; state.overlays.seasonZones = true; applyOverlays();
  showSeasonMonth(state.seasonMonth);
}
function seasonModeOff() {
  setAutoplay(false);
  const saved = state.season;
  state.season = null;
  if (saved) { state.f.months = saved.months; state.overlays.heat = saved.heat; state.overlays.seasonZones = saved.zones; }
  applyOverlays();
  render();
  drawSeasonZones();
}

/* ---------- rules: which closed seasons are in force today ---------- */
const RU_MONTH_STEMS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
function inRange(range, date = new Date()) {
  const md = (date.getMonth() + 1) * 100 + date.getDate();
  const a = range[0][0] * 100 + range[0][1], b = range[1][0] * 100 + range[1][1];
  return a <= b ? md >= a && md <= b : md >= a || md <= b;
}
// The rules mix plain ranges ("1 мая – 15 июня") with ice-bound ones ("с распаления льда до 20 июня",
// "с 15 сентября до ледостава"); ice dates are the typical ones for the south of Ladoga.
const ICE_BREAKUP = [4, 15], FREEZE_UP = [12, 15];
function monthDay(txt) {
  const m = String(txt).toLowerCase().match(/(\d{1,2})\s+([а-яё]+)/);
  if (!m) return null;
  const mi = RU_MONTH_STEMS.findIndex((stem) => m[2].startsWith(stem) && !(stem === 'ма' && !/^ма[яй]/.test(m[2])));
  return mi >= 0 ? [mi + 1, +m[1]] : null;
}
function activeParts(text, date = new Date()) {
  const out = [];
  const parts = [];
  for (const seg of String(text || '').split(';')) {
    const m = seg.match(/^\s*([^:]{2,80}):\s*(.*)$/);
    const prefix = m ? `${m[1].trim()}: ` : '';
    for (const sub of (m ? m[2] : seg).split(/\sи\s(?=с\s)/)) parts.push(prefix + sub.trim());
  }
  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    if (/круглый год/i.test(p)) { out.push(p); continue; }
    let range = null;
    const fromIce = p.match(/распалени[яе] льда\s*(?:до|по)\s*(\d{1,2}\s+[а-яё]+)/i);
    const toFreeze = p.match(/с\s+(\d{1,2}\s+[а-яё]+)\s+до\s+ледостава/i);
    const plain = p.match(/(\d{1,2}\s+[а-яё]+)\s*[–—-]\s*(\d{1,2}\s+[а-яё]+)/);
    if (fromIce) range = [ICE_BREAKUP, monthDay(fromIce[1])];
    else if (toFreeze) range = [monthDay(toFreeze[1]), FREEZE_UP];
    else if (plain) range = [monthDay(plain[1]), monthDay(plain[2])];
    if (range && range[0] && range[1] && inRange(range, date)) out.push(p);
  }
  return out;
}
function bansToday(date = new Date()) {
  const out = [];
  for (const c of state.ctx.regulations?.closed_seasons || []) {
    if (/круглый год \(запретные виды\)/i.test(c.dates || '')) continue; // shown apart as protected species
    if (/вне рамки карты|северная часть Ладоги/i.test(`${c.area} ${c.species}`)) continue; // not this map's water
    const parts = activeParts(c.dates || c.period || '', date);
    if (parts.length) out.push({ ...c, now: parts.join('; ') });
  }
  return out;
}
const isMotorBan = (c) => /маломерных судов с моторами/i.test(c.species || '');
function banLine(c) {
  const motor = isMotorBan(c);
  const who = motor ? `Моторы запрещены — ${(c.species.match(/\(([^)]+)\)/) || [])[1] || c.area || ''}` : `${c.species || 'все виды'}`;
  return `<div class="ban-line">• <b>${esc(who)}</b>: ${esc(c.now || c.dates || '')}${!motor && c.area ? ` <span class="muted">(${esc(c.area)})</span>` : ''}</div>`;
}
// Prohibited areas on the map: circles for zones, lines and polygons as drawn by the rules; a label opens the card.
function drawRules() {
  layers.rules.clearLayers();
  if (!state.overlays.rules) return;
  for (const a of state.ctx.regulations?.prohibited_areas || []) {
    const trade = /^\[Промысел\]|справочно/i.test(`${a.name} ${a.applies_to}`);
    const color = trade ? '#868e96' : '#e03131';
    const style = { color, weight: 2, fillColor: color, fillOpacity: trade ? 0.04 : 0.12, dashArray: trade ? '4 6' : null, interactive: false };
    const label = a.name.replace(/^\[Промысел\]\s*/, trade ? 'Промысел: ' : '');
    const shapes = [];
    if (Array.isArray(a.polygon) && a.polygon.length > 2) shapes.push(L.polygon(a.polygon, style));
    if (Array.isArray(a.line) && a.line.length > 1) shapes.push(L.polyline(a.line, { ...style, weight: 3 }));
    for (const z of a.zones || []) if (z.lat != null) shapes.push(L.circle([z.lat, z.lon], { ...style, radius: z.radius_m || 1000 }));
    if (!shapes.length) for (const r of a.reference_points || []) if (r.lat != null) shapes.push(L.circle([r.lat, r.lon], { ...style, radius: 500 }));
    if (!shapes.length) continue;
    shapes.forEach((s) => s.addTo(layers.rules));
    const c = L.featureGroup(shapes).getBounds().getCenter();
    const tag = L.marker(c, { icon: L.divIcon({ className: 'zone-tag-wrap', html: `<button type="button" class="zone-tag" style="--zc:${color}">Запрет: ${esc(label.slice(0, 34))}</button>`, iconSize: null }), zIndexOffset: -400 });
    tag.on('click', () => openRuleCard(a, label));
    tag.addTo(layers.rules);
  }
}

/* ---------- my points and marks (small list, kept in localStorage) ---------- */
const TAGS = {
  bite: { label: 'Поклёвка', color: '#1c7ed6', glyph: '~' },
  catch: { label: 'Улов', color: '#2b8a3e', glyph: '✓' },
  snag: { label: 'Зацеп', color: '#5c4033', glyph: '#' },
  shoal: { label: 'Мель', color: '#e8590c', glyph: '!' },
  hole: { label: 'Лунка', color: '#5f3dc4', glyph: 'o' },
  other: { label: 'Другое', color: '#495057', glyph: '★' },
};
function saveMine() { store.set('ladoga-mine', state.mine); }
function drawMine() {
  layers.mine.clearLayers();
  for (const p of state.mine) {
    const t = TAGS[p.tag] || TAGS.other;
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'hit', html: `<div class="mark-dot" style="background:${t.color}">${esc(t.glyph)}</div>`, iconSize: [44, 44], iconAnchor: [22, 22] }), keyboard: false })
      .on('click', () => openMineCard(p))
      .addTo(layers.mine);
  }
}
function addMine({ lat, lon, name, tag = 'other', trackId = null, note = '' }) {
  const p = { id: `m${Date.now()}${Math.random().toString(36).slice(2, 5)}`, lat: +lat.toFixed(6), lon: +lon.toFixed(6), name, t: Date.now(), tag, trackId, note };
  state.mine.push(p);
  saveMine();
  if (!state.overlays.mine) { state.overlays.mine = true; applyOverlays(); }
  drawMine();
  return p;
}

/* ---------- exports ---------- */
async function sharePoint(lat, lon, title) {
  const url = `${location.origin}${location.pathname}#pt=${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (navigator.share) { try { await navigator.share({ title, text: `${title}: ${fmtDec(lat, lon)}`, url }); return; } catch (e) { if (e?.name === 'AbortError') return; } }
  copy(url, 'Ссылка');
}
const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function gpx(points) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ladoga-fishing-map" xmlns="http://www.topografix.com/GPX/1/1">\n${points.map((p) => `  <wpt lat="${p.lat}" lon="${p.lon}">${p.t ? `<time>${new Date(p.t).toISOString()}</time>` : ''}<name>${xmlEsc(p.name)}</name><desc>${xmlEsc(String(p.desc || '').slice(0, 800))}</desc>${p.type ? `<type>${xmlEsc(p.type)}</type>` : ''}</wpt>`).join('\n')}\n</gpx>\n`;
}
function filteredWaypoints() {
  const out = [];
  state.M.forEach((m, n) => {
    const rs = m.r.filter((i) => state.pass[i]).map((i) => state.R[i]);
    if (!rs.length) return;
    const fish = [...new Set(rs.flatMap((r) => r.fish || []))];
    out.push({ lat: m.lat, lon: m.lon, name: `L${n + 1} ${fish.slice(0, 2).join(', ') || rs[0].title || KINDS[m.kind].short}`, desc: rs.map((r) => `${r.date || ''} ${r.src}: ${r.comment || ''}`).join('; ') });
  });
  return out;
}
const fileStamp = (t = Date.now()) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`; };

/* ---------- weather: wind, waves, pressure, sun and moon (Open-Meteo, no key) ----------
   The wind matters most on Ladoga: an offshore wind (south-east to west) pushes the ice off the south
   shore with anglers on it, and any strong wind raises a steep wave in the shallow bays. */
const WX_PLACES = [
  { id: 'volkhov', name: 'Волховская губа', lat: 60.2, lon: 32.25 },
  { id: 'kobona', name: 'Кобона, Леднево', lat: 60.07, lon: 31.5 },
  { id: 'shlis', name: 'Шлиссельбург', lat: 59.97, lon: 31.1 },
  { id: 'svir', name: 'Свирская губа', lat: 60.5, lon: 32.85 },
];
const WX_KEY = 'ladoga-wx-v1';
const hPaToMm = (h) => Math.round(h * 0.750062);
function windArrow(dir, size = 16) {
  // Meteorological direction is where the wind comes FROM; the arrow shows where it blows.
  return `<span class="wx-arrow" style="width:${size}px;height:${size}px;transform:rotate(${Math.round(dir + 180)}deg)">↑</span>`;
}
function moonInfo(date = new Date()) {
  const synodic = 29.530588853;
  const known = Date.UTC(2000, 0, 6, 18, 14);
  const age = (((date - known) / 86400000) % synodic + synodic) % synodic;
  const phase = age / synodic;
  const illum = Math.round(((1 - Math.cos(2 * Math.PI * phase)) / 2) * 100);
  const names = [[0.03, 'новолуние'], [0.22, 'растущий серп'], [0.28, 'первая четверть'], [0.47, 'растущая луна'],
    [0.53, 'полнолуние'], [0.72, 'убывающая луна'], [0.78, 'последняя четверть'], [0.97, 'убывающий серп'], [1.01, 'новолуние']];
  const [, name] = names.find(([edge]) => phase < edge);
  return { name, illum, age: Math.round(age) };
}
function wxPlace() { return WX_PLACES.find((p) => p.id === store.get('ladoga-wx-place', 'volkhov')) || WX_PLACES[0]; }
async function loadWeather(force = false) {
  const place = wxPlace();
  const cached = store.get(WX_KEY, null);
  if (!force && cached && cached.place === place.id && Date.now() - cached.at < 30 * 60000) { state.wx = cached; onWeather(); return cached; }
  const q = `latitude=${place.lat}&longitude=${place.lon}&timezone=Europe%2FMoscow&forecast_days=3`;
  try {
    const [fc, sea] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?${q}&wind_speed_unit=ms&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover,precipitation,weather_code&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,precipitation_probability&daily=sunrise,sunset&past_days=1`).then((r) => r.json()),
      fetch(`https://marine-api.open-meteo.com/v1/marine?${q}&hourly=wave_height&past_days=1`).then((r) => r.json()).catch(() => null),
    ]);
    if (!fc || !fc.current) throw new Error('no data');
    state.wx = { at: Date.now(), place: place.id, fc, sea };
    store.set(WX_KEY, state.wx);
  } catch {
    if (cached) state.wx = cached;
  }
  onWeather();
  return state.wx;
}
function onWeather() {
  if (typeof renderChips === 'function') renderChips();
  if (typeof refreshPage === 'function') refreshPage('today');
}
// Hour index of "now" in the hourly arrays.
function wxNowIndex(fc) {
  const now = fc.current?.time?.slice(0, 13);
  const i = fc.hourly.time.findIndex((t) => t.slice(0, 13) === now);
  return i < 0 ? 0 : i;
}
function wxWarnings(wx) {
  const fc = wx.fc, h = fc.hourly, i0 = wxNowIndex(fc);
  const out = [];
  const month = new Date().getMonth() + 1;
  const ice = isIceMonth(month) || [11, 12, 4].includes(month);
  const next = (n) => Array.from({ length: n }, (_, k) => i0 + k).filter((k) => k < h.time.length);
  const offshore = (d) => d >= 112 && d <= 260; // SE, S, SW, WSW — from the land for the south shore
  if (ice) {
    const risky = next(24).filter((k) => offshore(h.wind_direction_10m[k]) && (h.wind_speed_10m[k] >= 6 || h.wind_gusts_10m[k] >= 10));
    if (risky.length) {
      const k = risky[0];
      out.push({ level: 'danger', short: `Отжимной ветер ${Math.round(h.wind_speed_10m[k])} м/с`, text: `Отжимной ветер ${rumb(h.wind_direction_10m[k])} ${Math.round(h.wind_speed_10m[k])} м/с (порывы ${Math.round(h.wind_gusts_10m[k])}) с ${h.time[k].slice(11, 16)}: у южного берега (Кобона, Леднево, Креницы, Сухо) может оторвать лёд. Далеко от берега не уходите, следите за трещинами.` });
    }
  } else {
    const windy = next(12).filter((k) => h.wind_speed_10m[k] >= 8 || h.wind_gusts_10m[k] >= 13);
    const waves = wx.sea?.hourly?.wave_height ? next(12).map((k) => wx.sea.hourly.wave_height[k] ?? 0) : [];
    const maxWave = waves.length ? Math.max(...waves) : 0;
    if (windy.length || maxWave >= 0.7) {
      const gust = Math.round(Math.max(...next(12).map((k) => h.wind_gusts_10m[k])));
      out.push({ level: 'warn', short: `Ветер до ${gust} м/с`, text: `Ближайшие 12 ч: ветер до ${gust} м/с в порывах${maxWave ? `, волна до ${maxWave.toFixed(1).replace('.', ',')} м` : ''}. В мелких губах волна короткая и крутая — на надувной лодке далеко не уходите.` });
    }
    const northStorm = next(24).filter((k) => (h.wind_direction_10m[k] >= 300 || h.wind_direction_10m[k] <= 60) && h.wind_speed_10m[k] >= 10);
    if (northStorm.length) out.push({ level: 'warn', short: 'Сильный северный ветер', text: 'Сильный северный ветер: нагон воды и высокая волна у южного берега, выход из устьев и каналов опасен.' });
  }
  const p0 = h.pressure_msl[i0], p3 = h.pressure_msl[Math.max(0, i0 - 3)];
  if (p0 != null && p3 != null && Math.abs(p0 - p3) >= 3) out.push({ level: 'info', text: `Давление ${p0 > p3 ? 'быстро растёт' : 'быстро падает'} (${p0 > p3 ? '+' : '−'}${Math.abs(Math.round((p0 - p3) * 0.75))} мм за 3 ч) — клёв в такие часы часто хуже.` });
  return out;
}
// Sunrise and sunset for the south of Ladoga (NOAA approximation, ±2 min): the «По солнцу» palette works offline.
function sunTimes(date = new Date(), lat = 60.2, lon = 32.2) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((date - start) / 86400000);
  const g = (2 * Math.PI / 365) * (day - 1);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(90.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosH > 1) return { polarNight: true };
  if (cosH < -1) return { polarDay: true };
  const ha = Math.acos(cosH) / rad;
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const rise = midnight + (720 - 4 * (lon + ha) - eqt) * 60000;
  const set = midnight + (720 - 4 * (lon - ha) - eqt) * 60000;
  return { rise, set };
}

/* ---------- offline packs: this part of Ladoga, not the world ----------
   A pack is a list of URLs saved into its own cache (never trimmed by the service worker). The core pack
   holds the app, the data and the satellite map of the whole area at overview scales plus the shore near
   the places at close range; the charts pack holds the depth charts; the detail pack the closest satellite. */
const PACK_CACHE = 'ladoga-pack-v1';
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = toRad(lat); return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
function tilesFor(bounds, z0, z1) {
  const out = [];
  for (let z = z0; z <= z1; z++) {
    const x0 = lon2x(bounds.getWest(), z), x1 = lon2x(bounds.getEast(), z);
    const y0 = lat2y(bounds.getNorth(), z), y1 = lat2y(bounds.getSouth(), z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y });
  }
  return out;
}
const regionBounds = () => L.latLngBounds([REGION.s, REGION.w], [REGION.n, REGION.e]);
// Tiles within `km` of any place anglers use (reports, slips, banks, landmarks): the shore and the fishing grounds.
function nearTiles(z0, z1, km) {
  const out = new Map();
  const dLat = km / 111, dLon = km / 55.6;
  for (const m of state.M) {
    if (m.kind === 'service' || m.kind === 'ice_incident') continue;
    for (let z = z0; z <= z1; z++) {
      for (let x = lon2x(m.lon - dLon, z); x <= lon2x(m.lon + dLon, z); x++) {
        for (let y = lat2y(m.lat + dLat, z); y <= lat2y(m.lat - dLat, z); y++) out.set(`${z}/${x}/${y}`, { z, x, y });
      }
    }
  }
  return [...out.values()];
}
function appFiles() {
  const abs = (u) => new URL(u, location.href).href;
  const files = ['./', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
    'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/leaflet-rotate.js', 'vendor/leaflet.markercluster.js', 'vendor/MarkerCluster.css', 'vendor/leaflet-heat.js',
    'data/points.json', 'data/context.json', 'downloads/ladoga_points.gpx'];
  $$('script[src], link[rel="stylesheet"][href]').forEach((el) => files.push(el.getAttribute('src') || el.getAttribute('href')));
  const d = state.ctx.depth || {};
  for (const u of [d.isobaths, d.chart_isobaths, d.grid, d.isolines]) if (u) files.push(u);
  return [...new Set(files.map(abs))];
}
const PACKS = [
  {
    id: 'core', name: 'Карта района',
    urls: () => [
      ...appFiles(),
      ...tilesFor(regionBounds(), 9, 12).map((t) => L.Util.template(SAT_URL, t)),
      ...nearTiles(13, 14, 1).map((t) => L.Util.template(SAT_URL, t)),
      ...tilesFor(regionBounds(), 9, 12).map((t) => L.Util.template(LABELS_URL, t)),
    ],
    estMB: () => Math.round((tilesFor(regionBounds(), 9, 12).length * 2 + nearTiles(13, 14, 1).length) * 26 / 1024) + 3,
  },
  {
    id: 'charts', name: 'Навигационные карты глубин',
    urls: async () => {
      const list = [];
      try {
        const idx = chartState.index || await fetch('tiles/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null));
        for (const l of idx?.layers || []) {
          if (!l.list) continue;
          const txt = await fetch(l.list).then((r) => (r.ok ? r.text() : ''));
          for (const line of txt.split(/\r?\n/)) if (line.trim()) list.push(new URL(line.trim(), location.href).href);
        }
      } catch { /* no tile index yet */ }
      if (!list.length) for (const c of chartState.items) list.push(new URL(c.url, location.href).href);
      for (const o of state.ctx.depth?.overlays || []) list.push(new URL(o.url, location.href).href);
      return list;
    },
    estMB: () => {
      const bytes = (chartState.index?.layers || []).reduce((a, l) => a + (+l.total_bytes || 0), 0);
      return bytes ? Math.round(bytes / 1048576) : null;
    },
  },
  {
    id: 'detail', name: 'Подробный спутник у берега',
    urls: () => nearTiles(15, 15, 1).map((t) => L.Util.template(SAT_URL, t)),
    estMB: () => Math.round(nearTiles(15, 15, 1).length * 28 / 1024),
  },
];
const packInfo = (id) => store.get(`ladoga-pack-${id}`, null);
const offline = { running: null, cancel: false, progress: null };
// Downloads the listed packs one after another; progress goes to offline.progress and to onPackProgress().
async function runPacks(ids) {
  if (!('caches' in window)) { toast('Этот браузер не умеет хранить карту без сети'); return; }
  if (offline.running) { toast('Уже идёт загрузка'); return; }
  try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
  offline.running = ids.join('+'); offline.cancel = false;
  const lists = [];
  for (const id of ids) {
    const pack = PACKS.find((p) => p.id === id);
    if (pack) lists.push({ pack, urls: [...new Set(await pack.urls())] });
  }
  const total = lists.reduce((a, l) => a + l.urls.length, 0);
  const cache = await caches.open(PACK_CACHE);
  const pr = offline.progress = { total, done: 0, failed: 0, bytes: 0, t0: Date.now(), ids };
  const tell = () => { if (typeof onPackProgress === 'function') onPackProgress(); };
  tell();
  for (const { pack, urls } of lists) {
    let i = 0, done = 0, failed = 0;
    const worker = async () => {
      while (i < urls.length && !offline.cancel) {
        const url = urls[i++];
        try {
          if (await cache.match(url)) { done += 1; pr.done += 1; continue; } // resume: what is saved stays saved
          const same = url.startsWith(location.origin);
          const res = await fetch(url, same ? { cache: 'no-cache' } : { mode: 'cors' });
          if (!res.ok) { failed += 1; pr.failed += 1; continue; }
          const blob = await res.clone().blob();
          pr.bytes += blob.size;
          await cache.put(url, res);
          done += 1; pr.done += 1;
        } catch { failed += 1; pr.failed += 1; }
        if ((pr.done + pr.failed) % 20 === 0) tell();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    store.set(`ladoga-pack-${pack.id}`, { at: Date.now(), total: urls.length, done, failed, complete: !offline.cancel && failed === 0 });
    if (offline.cancel) break;
  }
  const cancelled = offline.cancel;
  offline.running = null;
  offline.progress = null;
  tell();
  toast(cancelled ? 'Загрузка на паузе — продолжится с того же места' : pr.failed ? `Сохранено ${pr.done} из ${pr.total}; остальное докачается повторным нажатием` : 'Район сохранён в телефоне — работает без интернета', 5000);
}
async function deletePacks() {
  await caches.delete(PACK_CACHE);
  for (const p of PACKS) store.set(`ladoga-pack-${p.id}`, null);
  toast('Сохранённые карты удалены');
  if (typeof onPackProgress === 'function') onPackProgress();
}
const regionSaved = () => !!(packInfo('core')?.complete);

/* ---------- SOS helpers ---------- */
function telHref(phone) { return `tel:${String(phone).replace(/[^\d+]/g, '')}`; }
function nearestServices(from, subs, n = 3) {
  const out = [];
  state.M.forEach((m, idx) => {
    const r = state.R[m.r[0]];
    if (m.kind !== 'service' || !subs.includes(r.sub)) return;
    out.push({ idx, d: distM(from, m), title: r.title || '', comment: r.comment || '', sub: r.sub, lat: m.lat, lon: m.lon });
  });
  return out.sort((a, b) => a.d - b.d).slice(0, n);
}
// "3,2 км к СЗ от «о. Птинов»" — the way a rescuer on the phone can find a place on their own map.
function sectorName(p) {
  const places = PLACES.concat(EXTRA_PLACES);
  let best = null;
  for (const [name, lat, lon] of places) { const d = distM({ lat, lon }, p); if (!best || d < best.d) best = { d, name, lat, lon }; }
  if (!best) return '';
  if (best.d < 400) return `у места «${best.name}»`;
  return `${fmtDist(best.d)} к ${rumb(bearing(best, p))} от «${best.name}»`;
}
// The name of the area a place is in: a season zone around it, else the nearest named place.
function placeName(p) {
  let best = null;
  for (const [name, lat, lon] of PLACES.concat(EXTRA_PLACES)) { const d = distM({ lat, lon }, p); if (!best || d < best.d) best = { d, name }; }
  if (best && best.d < 6000) return best.name;
  for (const z of state.ctx.season_zones || []) {
    if (!z.name || /пояс|побереж|^Вся|^Весь/i.test(z.name)) continue;
    if (zoneDistM(z, p) === 0) return z.name.replace(/\s*\(.*\)/, '');
  }
  return best ? best.name : 'Ладога';
}
const yandexRoute = (p) => `https://yandex.ru/maps/?rtext=~${p.lat},${p.lon}&rtt=auto`;
function nearestLaunch(m) {
  let best = null;
  state.M.forEach((x) => {
    if (x.kind !== 'launch') return;
    const d = distM(m, x);
    if (d > 150 && d < 30000 && (!best || d < best.d)) best = { lat: x.lat, lon: x.lon, d, title: state.R[x.r[0]].title || 'спуск' };
  });
  return best;
}
