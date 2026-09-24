'use strict';

/* Ладога · рыболовная карта — core: data, the map and its layers, depth, weather, offline packs.
   The interface lives next door: content.js (pages, cards, sheets), tracks.js (tracks and marks),
   geo.js (location, follow, navigation), ui.js (layout, the layers stack and Back, controls, boot).
   Data: data/points.json (reports + markers) and data/context.json, built by scripts/build_data.py. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
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
  overlays: Object.assign({ seamarks: false, heat: false, cluster: true, radius: false, seasonZones: false, rules: false, lines: true, mine: true, tracks: false, genshtab: false, isobaths: false, charts: false, chartIso: false, shade: false, gridIso: false, community: false, myDepth: true, satDay: false, vvp: false }, store.get('ladoga-overlays', {})),
  chartOpacity: store.get('ladoga-chart-opacity', 1),
  genshtabOpacity: store.get('ladoga-genshtab-opacity', 0.8),
  overlayOpacity: store.get('ladoga-overlay-opacity', 0.7),
  settings: Object.assign({ theme: 'system', units: 'kmh', autoZoom: true, navShowPoints: false, keepAwake: false, sound: true, arrivalR: 30, orient: 'course', autoReturn: 15, shallow: 2 }, store.get('ladoga-settings', {})),
  home: store.get('ladoga-home', null) || HOME_DEFAULT,
  car: store.get('ladoga-car', null), // {lat, lon, t}: «К машине»
  navHide: false,
  shown: { markers: 0, reports: 0 },
};
function saveSettings() { store.set('ladoga-settings', state.settings); }
state.overlays.isobaths = false;

function defaultFilters() {
  return { fish: new Set(), months: new Set(), season: 'all', cls: new Set(['A', 'B', 'C']), kinds: new Set(Object.keys(KINDS).filter((k) => k !== 'service' && k !== 'ice_incident')), sources: new Set(), core: false, yearMin: 0, fav: false, depthOnly: false };
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
// Phone, phone on its side, tablet, computer. Set before the map is made, so Leaflet starts with the real size
// of its box (ui.js keeps the class up to date on every resize).
function layoutClass() {
  const w = innerWidth, h = innerHeight;
  const cls = h < 480 && w < 1100 ? 'land' : w < 600 ? 'compact' : w < 1024 ? 'medium' : 'expanded';
  if (document.body.dataset.layout !== cls) document.body.dataset.layout = cls;
  return cls;
}
layoutClass();
// Wide enough for Saint Petersburg, Kirishi and the whole road to the lake: someone following themselves on
// the way (or trying the app at home) must be able to have the map centred on them.
const MAX_BOUNDS = L.latLngBounds([59.2, 29.3], [61.7, 35.0]);
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
    name: 'Схема', attr: OSM_ATTR, thumb: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', water: '#aad3df',
    make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, crossOrigin: 'anonymous', errorTileUrl: NO_TILE }),
  },
  topo: {
    name: 'Топо', attr: `${OSM_ATTR}, OpenTopoMap (CC-BY-SA)`, thumb: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', water: '#97d2e3',
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
  // Water between the tiles: the ГосГисЦентр maps leave open water transparent — under a light map it must be
  // light water, not the dark sea of the satellite view (it showed as dark squares on the lake).
  map.getContainer().style.setProperty('--map-bg', BASES[key].water || (key === 'sat' ? '#1d3a47' : '#a6dcf5'));
  const a = $('#attrLine');
  if (a) a.textContent = `${BASES[key].attr || ''}${state.overlays.charts ? ' · ГУНиО' : ''}`;
}
// A z10 tile over the Volkhov bay: the preview of each base map in the layers sheet.
function baseThumb(key) {
  const b = BASES[key], t = b?.thumb;
  if (!t) return '';
  const z = 10, x = lon2x(32.2, z), y = lat2y(60.2, z);
  return L.Util.template(t.replace('{s}', 'a'), { z, x, y: b.tms ? 2 ** z - 1 - y : y });
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
  // The satellite of the day: live tiles online, the saved picture of the area offline.
  const satOnline = o.satDay && navigator.onLine;
  if (satOnline) toggle(satDayLayer(), true); else if (SAT_DAY.layer) toggle(SAT_DAY.layer, false);
  showSatSnapshot(o.satDay && !navigator.onLine);
  if (o.vvp && !depthModel.vvp) loadVvpDepths();
  toggle(layers.isobaths, o.isobaths);
  toggle(chartState.isoLayer, o.chartIso);
  if (o.chartIso) loadChartIsobaths();
  if (depthModel.shade) toggle(depthModel.shade, !!o.shade);
  if (o.gridIso && !depthModel.iso) loadGridIsolines();
  if (depthModel.iso) toggle(depthModel.iso, !!o.gridIso);
  if (o.community && !depthModel.community) loadCommunityDepth();
  if (depthModel.community) toggle(depthModel.community, !!o.community);
  if (depthModel.communityDup) toggle(depthModel.communityDup, !!o.community && !o.chartIso);
  drawIsoLabels();
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
  declutterPoiLabels();
}
map.on('zoomend', () => updatePoiVisibility());
// Names of banks, capes and islands never sit on top of each other: hazards and banks keep their place first,
// then landmarks; a name that would overlap one already placed waits for a closer zoom.
function declutterPoiLabels() {
  cancelAnimationFrame(state.declutterFrame);
  state.declutterFrame = requestAnimationFrame(() => {
    if (map.getZoom() < 13) return;
    const rank = (el) => { const c = el.previousElementSibling?.classList; return c?.contains('hazard') ? 0 : c?.contains('structure') ? 1 : 2; };
    const labels = [...map.getContainer().querySelectorAll('.poi .poi-label')];
    labels.forEach((el) => el.classList.remove('crowded'));
    const boxes = labels.map((el) => ({ el, r: el.getBoundingClientRect(), k: rank(el) })).filter((x) => x.r.width)
      .sort((a, b) => a.k - b.k || a.r.top - b.r.top);
    const placed = [];
    for (const x of boxes) {
      const r = x.r;
      if (placed.some((p) => r.left < p.right + 2 && r.right > p.left - 2 && r.top < p.bottom + 1 && r.bottom > p.top - 1)) x.el.classList.add('crowded');
      else placed.push(r);
    }
  });
}
map.on('zoomend moveend', declutterPoiLabels);
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
// chartState.items: the chart sheets (numbers, titles, scales, bounds) for the lists and «show this chart»;
// what is drawn are the tiles only.
const chartState = { items: [], tiles: [], iso: null, isoLines: null, isoLayer: L.layerGroup(), grid: null };
function buildCharts() {
  chartState.items = (state.ctx.depth?.charts || []).map((c) => ({ ...c, b: L.latLngBounds(c.bounds) }))
    .sort((a, b) => b.scale - a.scale); // overview first, the most detailed on top
}
// Sharp chart tiles cut straight from the original scans (scripts/build_chart_tiles.py):
// «charts» to z15 everywhere plus z16 inside the 1:10 000 / 1:25 000 sheets, «genshtab» to z14.
// Their description comes inside context.json (so it is there offline and without one more request);
// tiles/index.json is only the fallback, tried again later if the network fails.
const CLEAR_TILE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
async function loadChartTiles(attempt = 0) {
  try {
    const idx = state.ctx.depth?.tiles?.layers ? state.ctx.depth.tiles
      : await fetch('tiles/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null));
    if (!idx || !Array.isArray(idx.layers)) throw new Error('no tile index');
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
  } catch {
    // No whole-sheet pictures instead (10 megapixels each: a phone chokes on them) — just try again a bit later.
    chartState.tiles = [];
    if (attempt < 6) setTimeout(() => loadChartTiles(attempt + 1), Math.min(60000, 3000 * 2 ** attempt));
  }
}
function updateCharts() {
  const on = state.overlays.charts;
  for (const t of chartState.tiles) {
    if (on && !map.hasLayer(t.layer)) t.layer.addTo(map);
    if (!on && map.hasLayer(t.layer)) map.removeLayer(t.layer);
    t.layer.setOpacity(state.chartOpacity);
  }
}

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
// The depth model digitised from 18 000 chart soundings (data/depth_grid.json → data/depth/depth_*.json, one file
// per chart, 50 m cells, 25 m in the 1:10 000 sheets; median error 0,27 m). A file loads only when a depth inside
// it is asked for; row 0 is the northernmost, values are depth × scale in Uint16 LE (base64), nodata 65535.
async function loadDepthGrid() {
  const url = state.ctx.depth?.grid;
  if (!url || chartState.gridIndex) return;
  try {
    const idx = await fetch(url).then((r) => (r.ok ? r.json() : null));
    if (!idx?.files) return;
    idx.files.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));
    chartState.gridIndex = idx;
    chartState.gridFiles = new Map();
    if (typeof onDepthReady === 'function') onDepthReady();
  } catch { /* no grid */ }
}
function gridFile(f) {
  let g = chartState.gridFiles.get(f.file);
  if (g) return g.u ? g : null;
  g = { loading: true };
  chartState.gridFiles.set(f.file, g);
  fetch(f.file).then((r) => r.json()).then((j) => {
    const bin = atob(j.data), u = new Uint16Array(bin.length >> 1);
    for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    Object.assign(g, { ...j, data: null, u, loading: false });
    if (typeof onDepthReady === 'function') onDepthReady();
  }).catch(() => chartState.gridFiles.delete(f.file));
  return null;
}
function gridDepth(p) {
  const idx = chartState.gridIndex;
  if (!idx) return null;
  for (const f of idx.files) {
    const [[S, W], [N, E]] = f.bounds;
    if (p.lat < S || p.lat > N || p.lon < W || p.lon > E) continue;
    const g = gridFile(f);
    if (!g) continue; // still loading: the next file or the isobaths answer meanwhile
    const fx = (p.lon - W) / g.dlon - 0.5, fy = (N - p.lat) / g.dlat - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    let s = 0, w = 0;
    for (const [dy, dx, k] of [[0, 0, (1 - tx) * (1 - ty)], [0, 1, tx * (1 - ty)], [1, 0, (1 - tx) * ty], [1, 1, tx * ty]]) {
      const y = y0 + dy, x = x0 + dx;
      if (y < 0 || x < 0 || y >= g.ny || x >= g.nx) continue;
      const v = g.u[y * g.nx + x];
      if (v !== (g.nodata ?? 65535)) { s += (k * v) / (g.scale || 10); w += k; }
    }
    if (w > 0.05) return s / w;
  }
  return null;
}
// The lake stands about 0,9 m below its long-term mean in 2026: chart depths are that much deeper than the water now.
// The lake level against the charts' zero (their mean long-term level, +5,1 m БС): negative — the water is lower now
// and every charted depth is that much shallower. The server brings a fresh value (data/live.json, the Волго-Балт
// level at Сясьские Рядки); without it, the depth model's own figure for the year.
function levelNow() {
  const c = state.live?.level?.depth_correction?.m;
  if (Number.isFinite(+c) && Math.abs(c) < 3) return +c;
  return +(chartState.gridIndex?.level_2026_correction_m ?? -0.9);
}
// Where that figure comes from, for the small print: «Волго-Балт, Сясьские Рядки, 22.09» or «оценка на 2026 год».
function levelSourceText() {
  const c = state.live?.level?.depth_correction;
  if (c && Number.isFinite(+c.m)) return `${c.from || 'сводка'}${c.date ? `, ${fmtDate(String(c.date).slice(0, 10))}` : ''}`;
  return 'оценка на 2026 год';
}
const fmtM = (v, digits = 1) => String(Math.round(v * 10 ** digits) / 10 ** digits).replace('.', ',');
// Chart depth → the water there is now: «≈ 1,9 м сейчас (по карте 2,6)».
function depthNowText(dep) {
  if (!dep) return '';
  const lv = levelNow();
  if (dep.value != null) return `≈ ${fmtM(Math.max(0, dep.value + lv))} м сейчас (по карте ${fmtM(dep.value)})`;
  return `${fmtM(Math.max(0, dep.min + lv), 0)}–${fmtM(Math.max(0, dep.max + lv), 0)} м сейчас (по карте ${dep.min}–${dep.max})`;
}
// Depth at a place: the digitised grid if the place is on it, else the chart isobaths: on a line → "≈ 5 м";
// between two → "5–10 м". null off the charts.
function depthAt(p) {
  const gd = gridDepth(p);
  if (gd != null && gd >= 0) {
    const v = gd < 10 ? Math.round(gd * 10) / 10 : Math.round(gd);
    return { text: `≈ ${String(v).replace('.', ',')} м`, min: v, max: v, value: v, model: true };
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

/* ---------- the depth model from the chart soundings: colour shading, isolines every metre ---------- */
const ISO_COLORS = { 1: '#e8590c', 2: '#f08c00', 3: '#74c0fc', 4: '#4dabf7', 5: '#339af0', 6: '#228be6', 7: '#1c7ed6', 8: '#1971c2', 10: '#1864ab', 12: '#364fc7', 15: '#3b5bdb', 20: '#5f3dc4', 25: '#6741d9', 30: '#212529' };
const isoColor = (m) => ISO_COLORS[m] || (m < 3 ? '#e8590c' : m < 10 ? '#1c7ed6' : '#5f3dc4');
const depthModel = { shade: null, iso: null, isoLoading: null, labels: [], labelLayer: L.layerGroup(), community: null, communityDup: null, communityLoading: null, communityLabels: [], communityIsoLabels: [], communityMarks: [] };
// The shading exists only over water: with its coverage (tiles/depth_cover.json, runs of y per column) no tile
// is asked for over land — no 404s, no wasted requests on a weak signal.
const CoveredTiles = L.TileLayer.extend({
  _isValidTile(coords) {
    const cover = this.options.cover;
    if (cover) {
      const runs = cover[coords.z]?.[coords.x];
      if (!runs) return false;
      let hit = false;
      for (let i = 0; i < runs.length && !hit; i += 2) hit = coords.y >= runs[i] && coords.y <= runs[i + 1];
      if (!hit) return false;
    }
    return L.TileLayer.prototype._isValidTile.call(this, coords);
  },
});
function buildDepthModel() {
  const sh = state.ctx.depth?.shade;
  if (sh?.url && !depthModel.shade) {
    depthModel.shade = new CoveredTiles(sh.url, {
      pane: 'charts', zIndex: 0, minZoom: 8, maxZoom: 18, minNativeZoom: +sh.minZoom || 9, maxNativeZoom: +sh.maxNativeZoom || 15,
      opacity: 0.85, errorTileUrl: CLEAR_TILE, bounds: regionBounds().pad(0.05),
    });
    if (sh.cover) {
      fetch(sh.cover).then((r) => (r.ok ? r.json() : null)).then((cover) => {
        if (!cover) return;
        depthModel.shade.options.cover = cover;
        if (map.hasLayer(depthModel.shade)) depthModel.shade.redraw();
      }).catch(() => {});
    }
  }
}
// Isolines every metre near the shore (1–8, 10, 12, 15, 20, 25, 30 m), drawn on canvas; depth labels from z13.
function loadGridIsolines() {
  const url = state.ctx.depth?.isolines;
  if (!url || depthModel.isoLoading) return depthModel.isoLoading;
  depthModel.isoLoading = fetch(url).then((r) => r.json()).then((gj) => {
    const renderer = L.canvas({ padding: 0.3 });
    depthModel.iso = L.geoJSON(gj, {
      renderer, interactive: false,
      style: (f) => { const m = +f.properties.depth_m; return { color: isoColor(m), weight: m <= 2 ? 2.2 : m % 5 === 0 ? 2 : 1.2, opacity: 0.9, interactive: false }; },
    });
    depthModel.labels = isoLabelPoints(gj, 1500);
    applyOverlays();
    return depthModel.iso;
  }).catch(() => { depthModel.isoLoading = null; return null; });
  return depthModel.isoLoading;
}
// A label every `stepM` metres along each line (and one on any line longer than 300 m).
function isoLabelPoints(gj, stepM) {
  const out = [];
  for (const f of gj.features || []) {
    const m = +f.properties.depth_m;
    const parts = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const part of parts) {
      let run = stepM / 2, total = 0;
      for (let i = 1; i < part.length; i++) {
        const a = { lat: part[i - 1][1], lon: part[i - 1][0] }, b = { lat: part[i][1], lon: part[i][0] };
        const d = distM(a, b);
        total += d; run += d;
        if (run >= stepM && total > 300) { run = 0; out.push({ lat: b.lat, lon: b.lon, m }); }
      }
    }
  }
  return out;
}
// Depth labels on screen, decluttered: one per cell of ~30 px, rocks and banks first, then line labels, then soundings.
// They are laid out for a margin around the view, so panning (a boat followed every second) redraws them only when
// the view leaves that margin or the zoom changes — not hundreds of labels rebuilt on every fix.
function drawIsoLabels(force = true) {
  const layer = depthModel.labelLayer;
  const z = map.getZoom();
  if (!force && depthModel.labelsZ === z && depthModel.labelsBox?.contains(map.getBounds())) return;
  layer.clearLayers();
  depthModel.labelsZ = null; depthModel.labelsBox = null;
  const iso = state.overlays.gridIso && depthModel.labels.length;
  const com = state.overlays.community && depthModel.community;
  const vvp = state.overlays.vvp && depthModel.vvp?.length;
  const mine = state.overlays.myDepth && typeof myDepthPoints === 'function' ? myDepthPoints() : [];
  if ((!iso && !com && !vvp && !mine.length) || z < 13) { if (map.hasLayer(layer)) map.removeLayer(layer); return; }
  if (!map.hasLayer(layer)) layer.addTo(map);
  const size = map.getSize();
  const view = map.getBounds().pad(0.35);
  depthModel.labelsZ = z; depthModel.labelsBox = view;
  const mx = size.x * 0.4, my = size.y * 0.4;
  const cell = z >= 16 ? 24 : z >= 15 ? 28 : 34;
  const taken = new Set();
  let n = 0;
  const num = (m) => String(Math.round(m * 10) / 10).replace('.', ',');
  const add = (p, cls, text) => {
    if (n > 1100 || !view.contains([p.lat, p.lon])) return;
    const pt = map.latLngToContainerPoint([p.lat, p.lon]);
    if (pt.x < -mx || pt.y < -my || pt.x > size.x + mx || pt.y > size.y + my) return;
    const key = `${Math.floor(pt.x / cell)}:${Math.floor(pt.y / (cell * 0.66))}`;
    if (taken.has(key)) return;
    taken.add(key); n += 1;
    L.marker([p.lat, p.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: `<span class="iso-label ${cls}">${text}</span>`, iconSize: null }) }).addTo(layer);
  };
  for (const p of mine) add(p, 'my', num(p.m));
  if (vvp) for (const p of depthModel.vvp) add(p, `vvp${p.k === 'fairway' ? ' fairway' : ''}`, num(p.m));
  if (com) for (const p of depthModel.communityMarks) add(p, 'community rock', `${p.rock ? '✚' : 'б'} ${num(p.m)}`);
  if (iso) for (const p of depthModel.labels) add(p, p.m <= 2 ? 'shallow' : '', String(p.m));
  if (com) for (const p of depthModel.communityIsoLabels) add(p, 'community', num(p.m));
  if (com && z >= 14) for (const p of depthModel.communityLabels) add(p, 'community sounding', num(p.m));
}
map.on('moveend zoomend', () => { if (state.overlays.gridIso || state.overlays.community || state.overlays.myDepth || state.overlays.vvp) drawIsoLabels(false); });
// Fresh soundings of the Volkhov mouth and bar (ENC 2023 read off a Волго-Балт scheme): shown at the charts' zero
// (the mean long-term level) like every other depth on the map; research/fresh_depth.md.
function loadVvpDepths() {
  const url = state.ctx.depth?.vvp;
  if (!url || depthModel.vvpLoading) return;
  depthModel.vvpLoading = fetch(url).then((r) => r.json()).then((gj) => {
    depthModel.vvp = (gj.features || []).map((f) => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], m: +f.properties.m, d: +f.properties.d, k: f.properties.k }));
    drawIsoLabels();
  }).catch(() => { depthModel.vvpLoading = null; });
}
// Community depth files (openly published Garmin / GPX / KML contours and soundings), when there are any.
// Community depth files: freegpsmap 2007 and S. Novikov 2005 Garmin maps — amateur digitising of the same ГУНиО
// charts, filling places the chart isolines miss (Petrokrepost bay, the Neva source, the deep lake). Lines that
// repeat the chart isolines (dup_chart) are drawn only while that layer is off.
function loadCommunityDepth() {
  const url = state.ctx.depth?.community;
  if (!url || depthModel.communityLoading) return depthModel.communityLoading;
  depthModel.communityLoading = fetch(url).then((r) => r.json()).then((gj) => {
    const renderer = L.canvas({ padding: 0.3 });
    const feats = gj.features || [];
    const lineStyle = (f) => ({ color: +f.properties.depth_m <= 2 ? '#c2255c' : '#ae3ec9', weight: 1.4, opacity: 0.85, dashArray: '6 4', interactive: false });
    const lines = feats.filter((f) => f.properties?.kind === 'contour');
    depthModel.community = L.geoJSON({ type: 'FeatureCollection', features: lines.filter((f) => !f.properties.dup_chart) }, { renderer, interactive: false, style: lineStyle });
    depthModel.communityDup = L.geoJSON({ type: 'FeatureCollection', features: lines.filter((f) => f.properties.dup_chart) }, { renderer, interactive: false, style: lineStyle });
    depthModel.communityIsoLabels = isoLabelPoints({ features: lines }, 1800);
    depthModel.communityLabels = []; depthModel.communityMarks = [];
    for (const f of feats) {
      if (f.properties?.kind !== 'sounding' || f.properties.depth_m == null) continue;
      const coords = f.geometry.type === 'MultiPoint' ? f.geometry.coordinates : [f.geometry.coordinates];
      const note = f.properties.note || '';
      for (const c of coords) {
        const p = { lat: c[1], lon: c[0], m: +f.properties.depth_m };
        if (/камень|банка/.test(note)) depthModel.communityMarks.push({ ...p, rock: note === 'камень' });
        else depthModel.communityLabels.push(p);
      }
    }
    applyOverlays();
    return depthModel.community;
  }).catch(() => { depthModel.communityLoading = null; return null; });
  return depthModel.communityLoading;
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
      name: t.name.replace(/^Генштаб\s*/i, 'Генштаб ').replace(/\s*\(.*\)$/, ''), full: t.name, attr: t.attribution || 'nakarte.me', thumb: t.url, tms: !!t.tms,
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
  ice: { label: 'Замер льда', color: '#1c7ed6', glyph: '❄' },
  other: { label: 'Другое', color: '#495057', glyph: '★' },
};
function saveMine() { store.set('ladoga-mine', state.mine); }
// «32 см · 3 дн. назад»: an ice measurement is only as good as its age.
function iceMarkText(p) {
  if (!p.ice) return '';
  const days = Math.floor((Date.now() - p.t) / 86400000);
  return `${p.ice.cm != null ? `${p.ice.cm} см` : 'лёд'}${p.ice.water ? ', вода на льду' : ''} · ${days < 1 ? 'сегодня' : days === 1 ? 'вчера' : `${days} дн. назад`}`;
}
function drawMine() {
  layers.mine.clearLayers();
  if (state.car) {
    L.marker([state.car.lat, state.car.lon], { icon: L.divIcon({ className: 'hit', html: '<div class="car-dot" aria-label="Машина">🚗</div>', iconSize: [44, 44], iconAnchor: [22, 22] }), keyboard: false, zIndexOffset: 500 })
      .on('click', () => { if (typeof openCarCard === 'function') openCarCard(); })
      .addTo(layers.mine);
  }
  for (const p of state.mine) {
    const t = TAGS[p.tag] || TAGS.other;
    const dep = p.ice ? `<span class="poi-label">${esc(iceMarkText(p))}</span>` : p.depth != null ? `<span class="poi-label">${String(p.depth).replace('.', ',')} м</span>` : '';
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'hit', html: `<div class="mark-dot" style="background:${t.color}">${esc(t.glyph)}</div>${dep}`, iconSize: [44, 44], iconAnchor: [22, 22] }), keyboard: false })
      .on('click', () => openMineCard(p))
      .addTo(layers.mine);
  }
}
function addMine({ lat, lon, name, tag = 'other', trackId = null, note = '', depth = null }) {
  const p = { id: `m${Date.now()}${Math.random().toString(36).slice(2, 5)}`, lat: +lat.toFixed(6), lon: +lon.toFixed(6), name, t: Date.now(), tag, trackId, note, depth };
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

/* ---------- weather: wind, waves, fog, storms, pressure (Open-Meteo, no key) ----------
   The wind matters most on Ladoga: an offshore wind (south-east to west) pushes the ice off the south
   shore with anglers on it, and any strong wind raises a steep wave in the shallow bays. The warnings look
   as far as 14:00 tomorrow: in the evening an angler decides about tomorrow morning. */
const WX_PLACES = [
  { id: 'here', name: 'Здесь', here: true },
  { id: 'volkhov', name: 'Волховская губа', lat: 60.2, lon: 32.25 },
  { id: 'kobona', name: 'Кобона, Леднево', lat: 60.07, lon: 31.5 },
  { id: 'shlis', name: 'Шлиссельбург', lat: 59.97, lon: 31.1 },
  { id: 'svir', name: 'Свирская губа', lat: 60.5, lon: 32.85 },
];
const WX_KEY = 'ladoga-wx-v2';
const hPaToMm = (h) => Math.round(h * 0.750062);
function windArrow(dir, size = 16) {
  // Meteorological direction is where the wind comes FROM; the arrow shows where it blows.
  return `<span class="wx-arrow" style="width:${size}px;height:${size}px;transform:rotate(${Math.round(dir + 180)}deg)">↑</span>`;
}

/* ---------- sun and moon: the formulas of SunCalc (V. Agafonkin, BSD-2) after aa.quae.nl — minutes of accuracy,
   all on the phone, offline. Times are epoch milliseconds. ---------- */
const ASTRO = (() => {
  const rad = Math.PI / 180, dayMs = 86400000, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397, J0 = 0.0009;
  const toDays = (t) => t / dayMs - 0.5 + J1970 - J2000;
  const fromJulian = (j) => (j + 0.5 - J1970) * dayMs;
  const ra = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const altitude = (H, phi, de) => Math.asin(Math.sin(phi) * Math.sin(de) + Math.cos(phi) * Math.cos(de) * Math.cos(H));
  const anomaly = (d) => rad * (357.5291 + 0.98560028 * d);
  const eclLon = (M) => M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  const sunCoords = (d) => { const L = eclLon(anomaly(d)); return { dec: dec(L, 0), ra: ra(L, 0) }; };
  const moonCoords = (d) => {
    const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.22935 * d);
    const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F);
    return { ra: ra(l, b), dec: dec(l, b), dist: 385001 - 20905 * Math.cos(M) };
  };
  // Rise and set (−0.833°), civil dawn and dusk (−6°), noon — of the day whose solar noon is nearest to t.
  function sun(t, lat, lon) {
    const lw = rad * -lon, phi = rad * lat, d = toDays(t);
    const n = Math.round(d - J0 - lw / (2 * Math.PI));
    const ds = J0 + lw / (2 * Math.PI) + n;
    const M = anomaly(ds), L = eclLon(M), de = dec(L, 0);
    const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const at = (h) => {
      const c = (Math.sin(h * rad) - Math.sin(phi) * Math.sin(de)) / (Math.cos(phi) * Math.cos(de));
      if (c < -1 || c > 1) return null;
      const Jset = J2000 + J0 + (Math.acos(c) + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
      return [fromJulian(Jnoon - (Jset - Jnoon)), fromJulian(Jset)];
    };
    const rs = at(-0.833), cv = at(-6);
    const up = altitude(0, phi, de) > 0;
    return { noon: fromJulian(Jnoon), rise: rs?.[0], set: rs?.[1], dawn: cv?.[0], dusk: cv?.[1], polarDay: !rs && up, polarNight: !rs && !up };
  }
  const moonAlt = (t, lat, lon) => {
    const d = toDays(t), c = moonCoords(d);
    return altitude(rad * (280.16 + 360.9856235 * d) + rad * lon - c.ra, rad * lat, c.dec);
  };
  // Phase 0 new … 0.5 full … 1 new; fraction lit 0–1.
  function moonLight(t) {
    const d = toDays(t), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
    const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
    const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(m.dec) * Math.cos(s.dec) - Math.cos(m.dec) * Math.sin(s.dec) * Math.cos(s.ra - m.ra));
    return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI };
  }
  // Moonrise, moonset and the upper culmination within [t0, t0 + 24 h): the altitude every 10 minutes.
  function moonDay(t0, lat, lon) {
    const step = 600000, h0 = 0.133 * rad;
    let prev = moonAlt(t0, lat, lon) - h0, rise = null, set = null, top = -9, topT = null;
    for (let t = t0 + step; t <= t0 + dayMs; t += step) {
      const a = moonAlt(t, lat, lon) - h0;
      if (prev < 0 && a >= 0 && rise == null) rise = t - (step * a) / (a - prev);
      if (prev >= 0 && a < 0 && set == null) set = t - (step * a) / (a - prev);
      if (a > top) { top = a; topT = t; }
      prev = a;
    }
    return { rise, set, transit: top > 0 ? topT : null };
  }
  return { sun, moonLight, moonDay };
})();
// Kept for the «По солнцу» palette: today's rise and set at the south of Ladoga.
function sunTimes(date = new Date(), lat = 60.2, lon = 32.2) { return ASTRO.sun(+date, lat, lon); }
const MOON_NAMES = [[0.03, 'новолуние'], [0.22, 'растущий серп'], [0.28, 'первая четверть'], [0.47, 'растущая луна'],
  [0.53, 'полнолуние'], [0.72, 'убывающая луна'], [0.78, 'последняя четверть'], [0.97, 'убывающий серп'], [1.01, 'новолуние']];
function moonInfo(date = new Date(), lat = 60.2, lon = 32.2) {
  const { fraction, phase } = ASTRO.moonLight(+date);
  const [, name] = MOON_NAMES.find(([edge]) => phase < edge);
  const d0 = new Date(date); d0.setHours(0, 0, 0, 0);
  return { name, illum: Math.round(fraction * 100), phase, waxing: phase < 0.5, ...ASTRO.moonDay(+d0, lat, lon) };
}
const localDay = (t, add = 0) => { const d = new Date(t); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + add); return d; };

// Where the forecast is for: one of the fixed places, or «Здесь» — the boat, else the middle of the map.
function wxPlace() {
  const id = store.get('ladoga-wx-place', 'volkhov');
  const p = WX_PLACES.find((x) => x.id === id) || WX_PLACES[1];
  if (!p.here) return p;
  const me = typeof geo !== 'undefined' && geo.me && Date.now() - geo.me.t < 30 * 60000 ? geo.me : null;
  const c = me || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  return { ...p, lat: +c.lat.toFixed(3), lon: +c.lon.toFixed(3), name: me ? 'Здесь (где я)' : `Здесь (центр карты, ${placeName(c)})`, fromMe: !!me };
}
async function loadWeather(force = false) {
  const place = wxPlace();
  const cached = store.get(WX_KEY, null);
  const same = cached && cached.place === place.id && (!place.here || distM(cached.at_place || place, place) < 5000);
  if (!force && same && Date.now() - cached.at < 30 * 60000) { state.wx = cached; onWeather(); return cached; }
  const q = `latitude=${place.lat}&longitude=${place.lon}&timezone=Europe%2FMoscow`;
  try {
    const [fc, sea] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?${q}&cell_selection=sea&forecast_days=3&past_days=3&wind_speed_unit=ms&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover,precipitation,weather_code&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,precipitation_probability,precipitation,rain,snowfall,visibility,weather_code,cape&daily=sunrise,sunset`).then((r) => r.json()),
      fetch(`https://marine-api.open-meteo.com/v1/marine?${q}&forecast_days=3&past_days=3&hourly=wave_height,wave_period`).then((r) => r.json()).catch(() => null),
    ]);
    if (!fc || !fc.current) throw new Error('no data');
    state.wx = { at: Date.now(), place: place.id, at_place: { lat: place.lat, lon: place.lon, name: place.name }, fc, sea };
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
// Hour index of "now" in the hourly arrays (the saved forecast keeps working offline: now moves along it).
function wxNowIndex(fc) {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const now = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
  const i = fc.hourly.time.findIndex((t) => t.slice(0, 13) === now);
  if (i >= 0) return i;
  const j = fc.hourly.time.findIndex((t) => t.slice(0, 13) === fc.current?.time?.slice(0, 13));
  return j < 0 ? 0 : j;
}
// The hours the warnings look at: from now to 14:00 tomorrow, at least the next 12.
function wxHorizon(fc, i0) {
  const t = fc.hourly.time;
  const d = new Date(`${t[i0].slice(0, 10)}T12:00`); d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  const k14 = t.indexOf(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T14:00`);
  return Math.min(t.length - 1, Math.max(i0 + 12, k14 < 0 ? i0 + 24 : k14));
}
// "сегодня 15–19 ч", "ночью 01–05 ч", "завтра 05–11 ч" for the hours k0…k1 of the forecast.
function wxWhen(fc, i0, k0, k1) {
  const t = fc.hourly.time;
  const today = t[i0].slice(0, 10), day = t[k0].slice(0, 10), h0 = +t[k0].slice(11, 13), h1 = +t[k1].slice(11, 13) + 1;
  const range = k1 > k0 ? `${String(h0).padStart(2, '0')}–${String(h1 > 24 ? h1 - 24 : h1).padStart(2, '0')} ч` : `около ${String(h0).padStart(2, '0')} ч`;
  if (k0 === i0) return `сейчас и до ${t[k1].slice(0, 10) === today ? '' : 'завтра, '}${String(h1 % 24).padStart(2, '0')} ч`;
  if (day === today && t[k1].slice(0, 10) !== today) return `с ${String(h0).padStart(2, '0')} ч сегодня до ${String(h1 % 24).padStart(2, '0')} ч ${+t[k1].slice(11, 13) < 6 ? 'ночи' : 'завтра'}`;
  if (day === today) return `сегодня ${range}`;
  return h0 < 6 && k1 - k0 < 8 && h1 <= 8 ? `ночью ${range}` : `завтра ${range}`;
}
// Runs of consecutive hours that meet a test: [[k0, k1], …].
function wxRuns(ks, test) {
  const runs = [];
  for (const k of ks) {
    if (!test(k)) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === k - 1) last[1] = k; else runs.push([k, k]);
  }
  return runs;
}
function wxWarnings(wx) {
  const fc = wx.fc, h = fc.hourly, i0 = wxNowIndex(fc);
  const out = [];
  const month = new Date().getMonth() + 1;
  const ice = isIceMonth(month) || [11, 12, 4].includes(month);
  const end = wxHorizon(fc, i0);
  const ks = Array.from({ length: end - i0 + 1 }, (_, k) => i0 + k);
  const at = (arr, k) => (arr ? arr[k] : null);
  const offshore = (d) => d >= 112 && d <= 260; // SE, S, SW, WSW — from the land for the south shore
  const max = (list, arr) => Math.round(Math.max(...list.map((k) => arr[k] ?? 0)));
  if (ice) {
    const risky = wxRuns(ks, (k) => offshore(h.wind_direction_10m[k]) && (h.wind_speed_10m[k] >= 6 || h.wind_gusts_10m[k] >= 10));
    if (risky.length) {
      const [k0, k1] = risky[0], sp = max(ks.slice(k0 - i0, k1 - i0 + 1), h.wind_speed_10m);
      const drift = (sp * 0.025 * 3.6).toFixed(1).replace('.', ',');
      out.push({ level: 'danger', short: `Отжимной ветер ${sp} м/с`, text: `Отжимной ветер ${rumb(h.wind_direction_10m[k0])} до ${sp} м/с (порывы ${max(ks.slice(k0 - i0, k1 - i0 + 1), h.wind_gusts_10m)}) ${wxWhen(fc, i0, k0, k1)}: у южного берега (Кобона, Леднево, Креницы, Сухо) может оторвать лёд — оторванное поле уходит на север примерно на ${drift} км/ч. Далеко от берега не уходите, следите за трещинами.` });
    }
    const blizzard = wxRuns(ks, (k) => (at(h.snowfall, k) || 0) >= 0.3 && h.wind_speed_10m[k] >= 9);
    if (blizzard.length) {
      const [k0, k1] = blizzard[0];
      out.push({ level: 'warn', short: 'Метель', text: `Метель ${wxWhen(fc, i0, k0, k1)}: снег при ветре до ${max(ks.slice(k0 - i0, k1 - i0 + 1), h.wind_speed_10m)} м/с — на льду теряются ориентиры. Отметьте машину, пишите трек.` });
    }
  } else {
    const windy = wxRuns(ks, (k) => h.wind_speed_10m[k] >= 8 || h.wind_gusts_10m[k] >= 13);
    if (windy.length) {
      const [k0, k1] = windy[0];
      const span = ks.slice(k0 - i0, k1 - i0 + 1);
      const sp = max(span, h.wind_speed_10m), gust = max(span, h.wind_gusts_10m);
      const strong = sp >= 12 || gust >= 17;
      const w0 = wxWhen(fc, i0, k0, k1).replace(/^сейчас и /, '').replace(/^сегодня /, '').replace(/^с (\d+) ч сегодня до (\d+) ч.*$/, '$1–$2 ч');
      out.push({ level: strong ? 'danger' : 'warn', short: `Ветер ${sp}–${gust} м/с · ${w0}`, text: `${wxWhen(fc, i0, k0, k1).replace(/^./, (c) => c.toUpperCase())}: ветер ${rumb(h.wind_direction_10m[k0])} до ${sp} м/с, порывы до ${gust}. В мелких губах волна короткая и крутая${strong ? ' — на лодке не выходить' : ' — на надувной лодке далеко не уходите'}.${windy.length > 1 ? ` Ещё раз ${wxWhen(fc, i0, ...windy[1])}.` : ''}` });
    }
    const north = wxRuns(ks, (k) => (h.wind_direction_10m[k] >= 300 || h.wind_direction_10m[k] <= 60) && h.wind_speed_10m[k] >= 10);
    if (north.length) out.push({ level: 'warn', short: 'Сильный северный ветер', text: `Сильный северный ветер ${wxWhen(fc, i0, ...north[0])}: нагон воды и высокая волна у южного берега, выход из устьев и каналов опасен.` });
    const storm = wxRuns(ks, (k) => (at(h.weather_code, k) || 0) >= 95);
    if (storm.length) out.push({ level: 'danger', short: 'Гроза', text: `Гроза ${wxWhen(fc, i0, ...storm[0])}. Уйдите с воды заранее: на открытой воде лодка и удочка — самая высокая точка.` });
  }
  // Fog: under 1 km no sailing on the fairway; on the ice it takes away the shore.
  const fog = wxRuns(ks, (k) => at(h.visibility, k) != null && h.visibility[k] < 1000);
  if (fog.length) {
    const [k0, k1] = fog[0];
    const vis = Math.min(...ks.slice(k0 - i0, k1 - i0 + 1).map((k) => h.visibility[k]));
    out.push({ level: 'warn', short: `Туман · ${wxWhen(fc, i0, k0, k1).replace(/^сейчас и /, '').replace(/^сегодня /, '')}`, text: `Туман ${wxWhen(fc, i0, k0, k1)}, видимость до ${vis < 1000 ? `${Math.max(50, Math.round(vis / 50) * 50)} м` : '1 км'}. ${ice ? 'На льду легко потерять направление: отметьте машину, пишите трек, держите компас.' : 'На судовой ход не выходите; держитесь берега, включите трек — по нему легко вернуться.'}` });
  }
  return out;
}
/* ---------- fresh data from our server: lake level, water temperature, МЧС reports (data/live.json) ----------
   scripts/live/fetch_live.py gathers it every hour on the server (the sources give browsers no CORS or no https).
   The copy is kept in the phone: offline the last one is shown with its date. */
async function loadLive() {
  const saved = store.get('ladoga-live', null);
  if (!state.live && saved) state.live = saved;
  try {
    const live = await fetch('data/live.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null));
    if (live && typeof live === 'object') { state.live = live; store.set('ladoga-live', live); }
  } catch { /* offline, or the copy on GitHub Pages without a collector */ }
  if (typeof onDepthReady === 'function') onDepthReady();
  if (typeof refreshPage === 'function') refreshPage('today');
}

/* ---------- the satellite of the day: NASA GIBS (MODIS Terra, 250 m, every day; no key, CORS open) ----------
   Where the ice edge, the leads and the break-off are today — or what the water looks like. «Лёд/вода» is the
   7-2-1 band mix: ice and snow cyan, water black. One picture of the whole area can be kept for the ice. */
const SAT_DAY = { layer: null, date: null, bands: false };
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Terra passes about 11–12 h Moscow time and the picture is up 3–5 h later: before 16 h — yesterday's.
const satLatest = () => ymd(Date.now() - (new Date().getHours() < 16 ? 86400000 : 0));
function satLayerName(bands) { return bands ? 'MODIS_Terra_CorrectedReflectance_Bands721' : 'MODIS_Terra_CorrectedReflectance_TrueColor'; }
function satDayLayer() {
  const date = SAT_DAY.date || satLatest();
  const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${satLayerName(SAT_DAY.bands)}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
  if (!SAT_DAY.layer) SAT_DAY.layer = L.tileLayer(url, { maxZoom: 18, maxNativeZoom: 9, crossOrigin: 'anonymous', zIndex: 5, errorTileUrl: CLEAR_TILE, bounds: MAX_BOUNDS });
  else if (SAT_DAY.layer._url !== url) SAT_DAY.layer.setUrl(url);
  return SAT_DAY.layer;
}
function satShift(days) {
  const d = new Date(`${SAT_DAY.date || satLatest()}T12:00`);
  d.setDate(d.getDate() + days);
  if (ymd(d) > satLatest()) return;
  SAT_DAY.date = ymd(d);
  satDayLayer();
  if (typeof refreshLayersSheet === 'function') refreshLayersSheet();
}
// The picture of the whole area for offline use: one image from GIBS WMS in Web Mercator (so it lies exactly on
// the map), kept in the Cache with its date.
const SAT_SNAP = 'ladoga-sat-snap';
async function saveSatSnapshot() {
  const date = SAT_DAY.date || satLatest();
  const R = 6378137, x = (lon) => (lon * Math.PI / 180) * R, y = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
  const b = regionBounds(), W = 1600, H = Math.round(W * (y(b.getNorth()) - y(b.getSouth())) / (x(b.getEast()) - x(b.getWest())));
  const url = `https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${satLayerName(SAT_DAY.bands)}&STYLES=&CRS=EPSG:3857&BBOX=${x(b.getWest())},${y(b.getSouth())},${x(b.getEast())},${y(b.getNorth())}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/jpeg&TIME=${date}`;
  try {
    toast('Сохраняю снимок дня…');
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok || !/image/.test(res.headers.get('content-type') || '')) throw new Error('no image');
    const cache = await caches.open(SAT_SNAP);
    await cache.put('snapshot.jpg', res);
    store.set('ladoga-sat-snap', { date, bands: SAT_DAY.bands, at: Date.now(), bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]] });
    toast(`Снимок за ${fmtDate(date)} сохранён — откроется и без сети`, 4000);
  } catch { toast('Не удалось скачать снимок — нужен интернет', 4000); }
  if (typeof refreshLayersSheet === 'function') refreshLayersSheet();
}
async function showSatSnapshot(on) {
  if (!on) { if (SAT_DAY.snapLayer) map.removeLayer(SAT_DAY.snapLayer); return; }
  const info = store.get('ladoga-sat-snap', null);
  if (!info) return;
  try {
    const res = await (await caches.open(SAT_SNAP)).match('snapshot.jpg');
    if (!res) return;
    if (SAT_DAY.snapUrl) URL.revokeObjectURL(SAT_DAY.snapUrl);
    SAT_DAY.snapUrl = URL.createObjectURL(await res.blob());
    if (SAT_DAY.snapLayer) map.removeLayer(SAT_DAY.snapLayer);
    SAT_DAY.snapLayer = L.imageOverlay(SAT_DAY.snapUrl, info.bounds, { zIndex: 6, interactive: false }).addTo(map);
  } catch { /* no cache */ }
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
  for (const u of [d.isobaths, d.chart_isobaths, d.grid, d.isolines, d.community, d.vvp, d.fetch, d.shade?.cover, 'data/live.json']) if (u) files.push(u);
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
      const list = await tileList('charts');
      // the depth model files and the colour depth shading go with the charts
      try {
        const gi = chartState.gridIndex || (state.ctx.depth?.grid ? await fetch(state.ctx.depth.grid).then((r) => r.json()) : null);
        for (const f of gi?.files || []) list.push(new URL(f.file, location.href).href);
      } catch { /* no grid */ }
      const sh = state.ctx.depth?.shade;
      if (sh?.cover) list.push(new URL(sh.cover, location.href).href);
      if (sh?.list) {
        try {
          const txt = await fetch(sh.list, { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : ''));
          for (const line of txt.split(/\r?\n/)) if (line.trim()) list.push(new URL(line.trim(), location.href).href);
        } catch { /* no shading list */ }
      }
      return list;
    },
    // charts + the colour shading (~21 MB) + the depth grid (~7 MB) when the depth model is on the site
    estMB: () => (layerMB('charts') || 0) + (state.ctx.depth?.shade?.url ? 21 : 0) + (state.ctx.depth?.grid ? 7 : 0) || null,
  },
  {
    id: 'genshtab', name: 'Армейская карта 1:100 000',
    urls: async () => {
      return tileList('genshtab');
    },
    estMB: () => layerMB('genshtab'),
  },
  {
    id: 'detail', name: 'Подробный спутник у берега',
    urls: () => nearTiles(15, 15, 1).map((t) => L.Util.template(SAT_URL, t)),
    estMB: () => Math.round(nearTiles(15, 15, 1).length * 28 / 1024),
  },
];
// The tiles of one layer listed in tiles/index.json (a text file, one path per line).
async function tileList(id) {
  const list = [];
  try {
    const idx = chartState.index || await fetch('tiles/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null));
    const l = (idx?.layers || []).find((x) => x.id === id);
    if (l?.list) {
      const txt = await fetch(l.list, { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : ''));
      for (const line of txt.split(/\r?\n/)) if (line.trim()) list.push(new URL(line.trim(), location.href).href);
    }
  } catch { /* no tile index yet */ }
  return list;
}
function layerMB(id) {
  const l = (chartState.index?.layers || []).find((x) => x.id === id);
  return l?.total_bytes ? Math.round(l.total_bytes / 1048576) : null;
}
const packInfo = (id) => store.get(`ladoga-pack-${id}`, null);
const offline = { running: null, cancel: false, progress: null };
// Downloads the listed packs one after another; progress goes to offline.progress and to onPackProgress().
// refresh («Обновить»): our own files are fetched again even if saved — charts, data and the app change under the
// same names; the satellite tiles of Esri do not, and stay.
async function runPacks(ids, { refresh = false } = {}) {
  if (!('caches' in window)) { toast('Этот браузер не умеет хранить карту без сети'); return; }
  if (offline.running) { toast('Уже идёт загрузка'); return; }
  offline.running = ids.join('+'); offline.cancel = false;
  try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
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
          const same = url.startsWith(location.origin);
          if (!(refresh && same) && await cache.match(url)) { done += 1; pr.done += 1; continue; } // resume: what is saved stays saved
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
