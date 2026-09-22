'use strict';

/* Ладога · рыболовная карта.
   Static page: data/points.json (reports + markers) and data/context.json
   (species calendar, rules, zones, extra map layers) built by scripts/build_data.py. */

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

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

const state = {
  R: [], M: [], ctx: {}, meta: {},
  pass: [],
  f: defaultFilters(),
  tab: 'today',
  seasonMonth: new Date().getMonth() + 1,
  selected: null,
  me: null, watchId: null, follow: false, centerOnFix: false,
  compassHeading: null, compassOn: false,
  nav: null, arrived: false,
  fav: new Set(store.get('ladoga-fav', [])),
  mine: store.get('ladoga-mine', []),
  base: store.get('ladoga-base', 'sat'),
  overlays: Object.assign({ seamarks: false, heat: false, cluster: true, radius: false, seasonZones: false, rules: false, lines: true, mine: true, genshtab: false, isobaths: false }, store.get('ladoga-overlays', {})),
  genshtabOpacity: store.get('ladoga-genshtab-opacity', 0.8),
  overlayOpacity: store.get('ladoga-overlay-opacity', 0.7),
};

function defaultFilters() {
  return { fish: new Set(), months: new Set(), season: 'all', cls: new Set(['A', 'B', 'C']), kinds: new Set(Object.keys(KINDS).filter((k) => k !== 'service')), sources: new Set(), core: false, yearMin: 0, fav: false, depthOnly: false };
}

/* ---------- utilities ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
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
const RUMBS = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
const rumb = (deg) => RUMBS[Math.round(deg / 22.5) % 16];
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
const monthOf = (r) => (r.date && r.date.length >= 7 ? +r.date.slice(5, 7) : 0);
const yearOf = (r) => (r.date ? +r.date.slice(0, 4) : 0);
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
};
let toastTimer;
function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
async function copy(text, label = 'Скопировано') {
  try { await navigator.clipboard.writeText(text); toast(`${label}: ${text}`); }
  catch { window.prompt('Скопируйте:', text); }
}
function download(name, text, type = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const pointKey = (lat, lon) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 19, worldCopyJump: false })
  .setView([60.2, 32.15], 10);
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

const ESRI_ATTR = 'Снимки © <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics';
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">участники OpenStreetMap</a>';
const BASES = {
  sat: {
    name: 'Спутник',
    make: () => L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 18, attribution: ESRI_ATTR, crossOrigin: 'anonymous' }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 18, crossOrigin: 'anonymous' }),
    ]),
  },
  osm: {
    name: 'Схема OpenStreetMap',
    make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_ATTR, crossOrigin: 'anonymous' }),
  },
  topo: {
    name: 'Топографическая (OpenTopoMap)',
    make: () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc', attribution: `${OSM_ATTR}, © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)` }),
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
}

const layers = {
  seamarks: L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 18, attribution: '© <a href="https://www.openseamap.org" target="_blank" rel="noopener">OpenSeaMap</a>', zIndex: 5 }),
  heat: L.heatLayer([], { radius: 24, blur: 20, maxZoom: 13, minOpacity: 0.3, gradient: { 0.2: '#2c7fb8', 0.45: '#41b6c4', 0.65: '#ffffb2', 0.85: '#fd8d3c', 1: '#e31a1c' } }),
  cluster: L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 44, spiderfyDistanceMultiplier: 1.4, disableClusteringAtZoom: 15, chunkedLoading: true }),
  plain: L.layerGroup(),
  radius: L.circle([60.1037, 32.294], { radius: 55000, color: '#fff', weight: 1.5, dashArray: '6 8', fill: false, interactive: false }),
  seasonZones: L.layerGroup(),
  rules: L.layerGroup(),
  lines: L.layerGroup(),
  mine: L.layerGroup(),
  genshtab: L.layerGroup(),
  isobaths: L.layerGroup(),
  nav: L.layerGroup(),
  me: L.layerGroup(),
  select: L.layerGroup(),
};
layers.nav.addTo(map); layers.me.addTo(map); layers.select.addTo(map);

function applyOverlays() {
  const o = state.overlays;
  const toggle = (layer, on) => { if (on && !map.hasLayer(layer)) layer.addTo(map); if (!on && map.hasLayer(layer)) map.removeLayer(layer); };
  toggle(layers.seamarks, o.seamarks);
  toggle(layers.heat, o.heat);
  toggle(layers.cluster, o.cluster);
  toggle(layers.plain, !o.cluster);
  toggle(layers.radius, o.radius);
  toggle(layers.seasonZones, o.seasonZones);
  toggle(layers.rules, o.rules);
  toggle(layers.lines, o.lines);
  toggle(layers.mine, o.mine);
  toggle(layers.genshtab, o.genshtab);
  toggle(layers.isobaths, o.isobaths);
  if (o.isobaths) ensureIsobaths();
  if (o.genshtab) layers.genshtab.eachLayer((l) => l.setOpacity(state.genshtabOpacity));
  for (const [key, ov] of Object.entries(extraOverlays)) {
    toggle(ov.layer, !!o[key]);
    ov.layer.setOpacity?.(state.overlayOpacity);
  }
  store.set('ladoga-overlays', o);
}

/* ---------- filtering & rendering ---------- */
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

function markerIcon(m, rs) {
  const kind = m.kind;
  if (!CATCH_KINDS.has(kind)) {
    const sub = state.R[m.r[0]].sub || '';
    const glyph = SERVICE_GLYPH[sub] || { launch: '⚓', ice_incident: '!', hazard: '' }[kind] || '';
    return L.divIcon({ className: '', html: `<div class="shape ${kind} ${sub}">${glyph}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
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
  const size = n > 1 || exact ? 22 : 18;
  return L.divIcon({ className: '', html: `<div class="${cls}" style="${style}">${n > 1 ? n : ''}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function render() {
  state.pass = state.R.map(passes);
  const markers = [];
  const heat = [];
  let nM = 0, nR = 0;
  state.M.forEach((m, idx) => {
    const rs = m.r.filter((i) => state.pass[i]);
    if (!rs.length) return;
    nM += 1; nR += rs.length;
    const mk = L.marker([m.lat, m.lon], { icon: markerIcon(m, rs), keyboard: false, riseOnHover: true });
    mk.on('click', () => openPoint(idx));
    markers.push(mk);
    if (CATCH_KINDS.has(m.kind)) heat.push([m.lat, m.lon, Math.min(1, 0.35 + rs.length * 0.2)]);
  });
  layers.cluster.clearLayers();
  layers.plain.clearLayers();
  if (state.overlays.cluster) layers.cluster.addLayers(markers); else markers.forEach((mk) => layers.plain.addLayer(mk));
  layers.heat.setLatLngs(heat);
  $('#counter').textContent = `${nM} ${plural(nM, 'точка', 'точки', 'точек')} · ${nR} ${plural(nR, 'запись', 'записи', 'записей')}`;
  renderActiveFilters();
  if (['filter', 'data'].includes(state.tab)) refreshCounts();
}

function renderActiveFilters() {
  const f = state.f, chips = [];
  if (f.fish.size) chips.push(['fish', [...f.fish].join(', ')]);
  if (f.months.size) chips.push(['months', [...f.months].sort((a, b) => a - b).map((m) => MONTHS[m - 1]).join(', ')]);
  if (f.season !== 'all') chips.push(['season', SEASON_TEXT[f.season]]);
  if (f.cls.size < 3) chips.push(['cls', `класс ${[...f.cls].sort().join('')}`]);
  if (f.sources.size) chips.push(['sources', `${f.sources.size} ${plural(f.sources.size, 'источник', 'источника', 'источников')}`]);
  if (f.core) chips.push(['core', '≤55 км']);
  if (f.yearMin) chips.push(['yearMin', `с ${f.yearMin} г.`]);
  if (f.fav) chips.push(['fav', '★ избранное']);
  if (f.depthOnly) chips.push(['depthOnly', 'с глубиной']);
  if (f.kinds.size < Object.keys(KINDS).length) chips.push(['kinds', `${f.kinds.size} из ${Object.keys(KINDS).length} слоёв`]);
  $('#activeFilters').innerHTML = chips.map(([k, t]) => `<button type="button" data-clear="${k}">${esc(t)}</button>`).join('');
}
$('#activeFilters').addEventListener('click', (e) => {
  const k = e.target.closest('[data-clear]')?.dataset.clear;
  if (!k) return;
  const d = defaultFilters();
  state.f[k] = d[k];
  render();
  if (state.tab === 'filter') showTab('filter');
});

/* ---------- sheet ---------- */
const sheet = $('#sheet');
function setSheet(s) { sheet.dataset.state = s; }
$('#sheetClose').addEventListener('click', () => setSheet('peek'));
// Turning the phone gives the map the screen back; the panel is one tap away.
window.matchMedia('(orientation: landscape) and (max-height: 540px) and (max-width: 1100px)').addEventListener?.('change', (e) => { if (e.matches) setSheet('peek'); });
$('#btnPanel').addEventListener('click', () => { if (!$('#sheetBody').innerHTML.trim()) showTab('filter'); setSheet('full'); });
$('#sheetHandle').addEventListener('click', () => setSheet(sheet.dataset.state === 'peek' ? 'half' : sheet.dataset.state === 'half' ? 'full' : 'peek'));
(() => { // drag the handle to resize
  let y0 = null, s0 = null;
  const handle = $('#sheetHandle');
  handle.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; s0 = sheet.dataset.state; }, { passive: true });
  handle.addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (Math.abs(dy) < 25) return;
    const order = ['peek', 'half', 'full'];
    const i = order.indexOf(s0) + (dy < 0 ? 1 : -1);
    setSheet(order[Math.max(0, Math.min(2, i))]);
  });
})();
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  showTab(b.dataset.tab);
  if (sheet.dataset.state === 'peek') setSheet('half');
});
function showTab(tab) {
  state.tab = tab;
  if (tab !== 'point') { state.selected = null; layers.select.clearLayers(); }
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const body = $('#sheetBody');
  body.innerHTML = ({ today: todayHtml, filter: filterHtml, places: placesHtml, season: seasonHtml, fish: fishHtml, depth: depthHtml, rules: rulesHtml, layers: layersHtml, data: dataHtml }[tab] || (() => ''))();
  body.scrollTop = 0;
  if (tab === 'filter' || tab === 'data') refreshCounts();
}

/* ----- Filter tab ----- */
function counts(fn) {
  const out = new Map();
  for (const r of state.R) for (const k of [].concat(fn(r))) if (k) out.set(k, (out.get(k) || 0) + 1);
  return out;
}
function filterHtml() {
  const f = state.f;
  const catchR = state.R.filter((r) => CATCH_KINDS.has(r.kind));
  const fishCounts = new Map();
  for (const r of catchR) for (const x of r.fish || []) fishCounts.set(x, (fishCounts.get(x) || 0) + 1);
  const fish = [...fishCounts.entries()].sort((a, b) => b[1] - a[1]);
  const monthCounts = Array(13).fill(0);
  for (const r of catchR) monthCounts[monthOf(r)] += 1;
  const kindCounts = counts((r) => r.kind);
  const srcCounts = [...counts((r) => r.src).entries()].sort((a, b) => b[1] - a[1]);
  const years = state.R.map(yearOf).filter(Boolean);
  const minY = Math.min(...years), maxY = Math.max(...years);
  return `
    <details class="card legend-card" id="legend" ${store.get('ladoga-hint-v1', false) ? '' : 'open'}><summary><b>Что на карте</b></summary>
      <div class="legend">
        <span><span class="pin" style="display:inline-block;width:14px;height:14px;background:#2f9e44"></span> отчёт рыбака, цвет = рыба</span>
        <span><span class="pin multi" style="display:inline-grid;width:18px;height:18px;background:#e0b000">4</span> 4 отчёта в одном месте</span>
        <span><span class="pin A" style="display:inline-block;width:14px;height:14px;background:#f08c00"></span> точный GPS рыбака</span>
        <span><span class="pin obs" style="display:inline-block;width:14px;height:14px;border-color:#748ffc"></span> наблюдение рыбы</span>
        <span>${kindSwatch('launch')} спуск, слип, парковка</span>
        <span>${kindSwatch('structure')} банка, свал, гряда</span>
        <span>${kindSwatch('hazard')} опасность</span>
        <span>${kindSwatch('ice_incident')} случай на льду</span>
        <span><span class="marker-cluster" style="display:inline-grid;width:22px;height:22px"><div style="width:18px;height:18px;margin:2px;font-size:10px">12</div></span> группа точек — нажмите</span>
        <span><span class="zone-tag" style="--zc:#f08c00;pointer-events:none">Судак</span> зона сезона</span>
      </div>
      <p class="small muted" style="margin-bottom:0">Нажмите на точку — отчёты, координаты и «Вести к точке». Долгое нажатие на карту — поставить свою точку.</p>
    </details>
    <h3>Перейти</h3>
    <div class="chips">${PLACES.map((p, i) => `<button type="button" class="chip" data-place="${i}">${esc(p[0])}</button>`).join('')}</div>
    <h3>Рыба</h3>
    <div class="chips">${fish.filter(([name, n], i) => i < 12 || f.fish.has(name)).map(fishChip).join('')}</div>
    ${fish.length > 12 ? `<details><summary class="small">Ещё ${fish.length - 12} ${plural(fish.length - 12, 'вид', 'вида', 'видов')} (редкие)</summary><div class="chips">${fish.filter(([name], i) => i >= 12 && !f.fish.has(name)).map(fishChip).join('')}</div></details>` : ''}
    <h3>Месяц отчёта</h3>
    <div class="months">${MONTHS.map((m, i) => `<button type="button" class="chip ${f.months.has(i + 1) ? 'on' : ''}" data-month="${i + 1}">${m}<span class="n">${monthCounts[i + 1]}</span></button>`).join('')}</div>
    <div class="row" style="margin-top:8px">
      <div class="seg" id="seasonSeg">${[['all', 'Круглый год'], ['ice', '❄ Лёд'], ['open_water', '🌊 Вода']].map(([k, t]) => `<button type="button" data-season="${k}" class="${f.season === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <button type="button" class="chip" id="thisMonth">Этот месяц</button>
    </div>
    <h3>Что показывать</h3>
    ${Object.entries(KINDS).map(([k, v]) => `<label class="check"><input type="checkbox" data-kind="${k}" ${f.kinds.has(k) ? 'checked' : ''}> ${kindSwatch(k)} ${esc(v.label)} <span class="muted small">${kindCounts.get(k) || 0}</span></label>`).join('')}
    <h3>Достоверность координат</h3>
    ${['A', 'B', 'C'].map((c) => `<label class="check"><input type="checkbox" data-cls="${c}" ${f.cls.has(c) ? 'checked' : ''}> <span class="badge ${c}">${c}</span> <span class="small">${esc(CLASS_TEXT[c])}</span></label>`).join('')}
    <h3>Свежесть</h3>
    <div class="row"><span id="yearLabel" class="small">${f.yearMin ? `отчёты с ${f.yearMin} года` : 'все годы'}</span></div>
    <input type="range" id="yearMin" min="${minY - 1}" max="${maxY}" step="1" value="${f.yearMin || minY - 1}">
    <h3>Источник</h3>
    <div class="chips">${srcCounts.map(([s, n]) => `<button type="button" class="chip ${f.sources.has(s) ? 'on' : ''}" data-src="${esc(s)}">${esc(s)} <span class="n">${n}</span></button>`).join('')}</div>
    <label class="check"><input type="checkbox" id="coreOnly" ${f.core ? 'checked' : ''}> Только до 55 км от Новой Ладоги</label>
    <label class="check"><input type="checkbox" id="favOnly" ${f.fav ? 'checked' : ''}> Только ★ избранное (${state.fav.size})</label>
    <div class="btns"><button type="button" class="btn ghost" id="resetFilters">Сбросить фильтры</button></div>
    <hr>
    <p class="small muted">Крупная точка с числом — несколько отчётов в одном месте (в пределах 30 м). Точка с зелёной обводкой — точный GPS рыбака. Кольцо без заливки — наблюдение рыбы, а не рыбалка.</p>`;
}
function fishChip([name, n]) {
  return `<button type="button" class="chip ${state.f.fish.has(name) ? 'on' : ''}" data-fish="${esc(name)}"><span class="dot" style="background:${FISH_COLORS[name] || OTHER_COLOR}"></span>${esc(name)} <span class="n">${n}</span></button>`;
}
function kindSwatch(k) {
  if (CATCH_KINDS.has(k)) return `<span class="pin ${k === 'observation' ? 'obs' : ''}" style="display:inline-block;width:12px;height:12px;${k === 'observation' ? 'border-color:#2f9e44' : 'background:#2f9e44'}"></span>`;
  return `<span class="shape ${k}" style="display:inline-grid;width:12px;height:12px;font-size:8px">${k === 'launch' ? '⚓' : k === 'ice_incident' ? '!' : k === 'service' ? '⌂' : ''}</span>`;
}
function refreshCounts() { /* counts are static per dataset; the counter in the top bar shows the filtered total */ }

$('#sheetBody').addEventListener('click', (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;
  const f = state.f;
  const toggleSet = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));
  if (d.wxplace) { store.set('ladoga-wx-place', d.wxplace); loadWeather(true).then(() => { if (state.tab === 'weather') $('#sheetBody').innerHTML = weatherHtml(); }); $$('[data-wxplace]').forEach((b) => b.classList.toggle('on', b === t)); return; }
  if (d.tabLink) { e.preventDefault(); showTab(d.tabLink); setSheet(desktopLayout() ? 'full' : 'full'); return; }
  if (d.openMarker != null) { e.preventDefault(); const m = state.M[+d.openMarker]; if (m) { map.setView([m.lat, m.lon], Math.max(map.getZoom(), 14)); openPoint(+d.openMarker); } return; }
  if (d.place != null) { const p = PLACES[+d.place]; map.setView([p[1], p[2]], p[3]); closeSheetOnPhone(); return; }
  if (d.fish) { toggleSet(f.fish, d.fish); t.classList.toggle('on'); render(); return; }
  if (d.month) { toggleSet(f.months, +d.month); t.classList.toggle('on'); render(); return; }
  if (d.season) { f.season = d.season; $$('#seasonSeg button').forEach((b) => b.classList.toggle('on', b === t)); render(); return; }
  if (d.src) { toggleSet(f.sources, d.src); t.classList.toggle('on'); render(); return; }
  if (t.id === 'thisMonth') { f.months = new Set([new Date().getMonth() + 1]); render(); showTab('filter'); return; }
  if (t.id === 'resetFilters') { state.f = defaultFilters(); render(); showTab('filter'); return; }
  if (d.smonth) { if (state.season) { setAutoplay(false); showSeasonMonth(+d.smonth); } else { state.seasonMonth = +d.smonth; showTab('season'); drawSeasonZones(); } return; }
  if (d.act) handleAction(d.act, t);
});
$('#sheetBody').addEventListener('change', (e) => {
  const t = e.target, f = state.f;
  if (t.dataset.kind) { t.checked ? f.kinds.add(t.dataset.kind) : f.kinds.delete(t.dataset.kind); render(); }
  else if (t.dataset.cls) { t.checked ? f.cls.add(t.dataset.cls) : f.cls.delete(t.dataset.cls); render(); }
  else if (t.id === 'coreOnly') { f.core = t.checked; render(); }
  else if (t.id === 'favOnly') { f.fav = t.checked; render(); }
  else if (t.id === 'depthOnly') { f.depthOnly = t.checked; render(); }
  else if (t.dataset.overlay) {
    state.overlays[t.dataset.overlay] = t.checked;
    if (t.dataset.overlay === 'cluster') render();
    if (t.dataset.overlay === 'seasonZones') drawSeasonZones();
    if (t.dataset.overlay === 'rules') drawRules();
    applyOverlays();
  } else if (t.name === 'base') setBase(t.value);
});
$('#sheetBody').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'yearMin') {
    const v = +t.value, min = +t.min;
    state.f.yearMin = v > min ? v : 0;
    $('#yearLabel').textContent = state.f.yearMin ? `отчёты с ${state.f.yearMin} года` : 'все годы';
    clearTimeout(t._timer); t._timer = setTimeout(render, 150);
  } else if (t.id === 'genshtabOpacity') {
    state.genshtabOpacity = +t.value; store.set('ladoga-genshtab-opacity', state.genshtabOpacity);
    layers.genshtab.eachLayer((l) => l.setOpacity(state.genshtabOpacity));
  } else if (t.id === 'overlayOpacity') {
    state.overlayOpacity = +t.value; store.set('ladoga-overlay-opacity', state.overlayOpacity); applyOverlays();
  }
});

/* ----- Point details ----- */
function openPoint(idx) {
  const m = state.M[idx];
  state.selected = idx;
  state.tab = 'point';
  $$('#tabs button').forEach((b) => b.classList.remove('active'));
  layers.select.clearLayers();
  L.marker([m.lat, m.lon], { interactive: false, icon: L.divIcon({ className: '', html: '<div class="target-ring"></div>', iconSize: [34, 34], iconAnchor: [17, 17] }) }).addTo(layers.select);
  const rs = m.r.map((i) => ({ r: state.R[i], ok: state.pass[i] }))
    .sort((a, b) => (b.ok - a.ok) || String(b.r.date || '').localeCompare(String(a.r.date || '')));
  const fish = [...new Set(rs.flatMap((x) => x.r.fish || []))];
  const first = rs[0].r;
  const title = CATCH_KINDS.has(m.kind) ? (fish.length ? fish.join(', ') : 'Рыба не указана') : (first.title || KINDS[m.kind].short);
  const key = pointKey(m.lat, m.lon);
  const launch = nearestLaunch(m);
  $('#sheetBody').innerHTML = `
    <h2>${esc(title)}</h2>
    <p class="muted small">${esc(KINDS[m.kind].short)} · ${esc(first.sector || '')} · ${first.dist != null ? `${String(first.dist).replace('.', ',')} км от Новой Ладоги` : ''}</p>
    <div class="card">
      <div class="coord">${fmtDec(m.lat, m.lon)}</div>
      <div class="coord">${fmtDM(m.lat, m.lon)}</div>
      <div class="btns" style="margin:8px 0 0">
        <button type="button" class="btn small ghost" data-act="copy-dec">Копировать</button>
        <button type="button" class="btn small ghost" data-act="copy-dm">Копировать (ГГ°ММ.ммм)</button>
      </div>
      <div id="pointFromMe" class="small" style="margin-top:6px"></div>
    </div>
    <div class="btns">
      <button type="button" class="btn" data-act="nav">🧭 Вести к точке</button>
      <a class="btn ghost" href="${esc(yandexRoute(launch ? launch : m))}" target="_blank" rel="noopener">🚗 ${launch ? `Доехать до «${esc(launch.title)}»` : 'Доехать (Яндекс)'}</a>
      <button type="button" class="btn ghost" data-act="fav">${state.fav.has(key) ? '★ В избранном' : '☆ В избранное'}</button>
      <button type="button" class="btn ghost" data-act="share">↗ Поделиться</button>
    </div>
    ${launch ? `<p class="small muted">Ближайший спуск / гавань «${esc(launch.title)}» — ${fmtDist(launch.d)} от точки по прямой.</p>` : ''}
    <details><summary>Открыть в другом приложении</summary>
      <div class="btns">
        <a class="btn small ghost" href="yandexnavi://build_route_on_map?lat_to=${m.lat}&lon_to=${m.lon}">Яндекс Навигатор</a>
        <a class="btn small ghost" href="https://yandex.ru/maps/?pt=${m.lon},${m.lat}&z=14&l=sat" target="_blank" rel="noopener">Яндекс Карты</a>
        <a class="btn small ghost" href="https://www.google.com/maps/search/?api=1&query=${m.lat},${m.lon}" target="_blank" rel="noopener">Google Карты</a>
        <a class="btn small ghost" href="https://maps.apple.com/?ll=${m.lat},${m.lon}&q=${encodeURIComponent(title)}" target="_blank" rel="noopener">Apple Карты</a>
        <a class="btn small ghost" href="https://osmand.net/map?pin=${m.lat},${m.lon}#15/${m.lat}/${m.lon}" target="_blank" rel="noopener">OsmAnd</a>
        <a class="btn small ghost" href="geo:${m.lat},${m.lon}?q=${m.lat},${m.lon}(${encodeURIComponent(title)})">Другое (geo:)</a>
        <button type="button" class="btn small ghost" data-act="gpx-one">GPX для эхолота / Navionics</button>
      </div>
    </details>
    <h3>${rs.length} ${plural(rs.length, 'запись', 'записи', 'записей')} в этом месте</h3>
    ${rs.map(({ r, ok }) => reportHtml(r, ok)).join('')}`;
  $('#sheetBody').scrollTop = 0;
  setSheet(desktopLayout() ? 'full' : 'half');
  keepInView(m.lat, m.lon);
  updatePointFromMe();
  history.replaceState(null, '', `#pt=${m.lat.toFixed(5)},${m.lon.toFixed(5)}`);
}
function reportHtml(r, ok) {
  const extra = [r.depth && `глубина ${r.depth}`, r.method && r.method, r.catch && `улов: ${r.catch}`].filter(Boolean).join(' · ');
  const links = [safeUrl(r.url) && `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.srcd || r.src)}</a>`, safeUrl(r.orig) && `<a href="${esc(r.orig)}" target="_blank" rel="noopener">первоисточник</a>`].filter(Boolean).join(' · ') || esc(r.srcd || r.src);
  return `<div class="report ${ok ? '' : 'dim'}">
    <div><b>${esc((r.fish || []).join(', ') || r.title || KINDS[r.kind].short)}</b> · ${esc(fmtDate(r.date))}${r.season ? ` · ${r.season === 'ice' ? '❄ лёд' : '🌊 вода'}` : ''} <span class="badge ${r.cls}" title="${esc(CLASS_TEXT[r.cls])}">${r.cls}</span></div>
    ${r.title && (r.fish || []).length ? `<div class="small">${esc(r.title)}</div>` : ''}
    ${r.comment ? `<div>${esc(r.comment)}</div>` : ''}
    ${extra ? `<div class="small">${esc(extra)}</div>` : ''}
    <div class="meta">${links}${r.prec ? ` · точность ±${r.prec} м` : ''}${r.raw ? ` · в источнике: <span class="coord">${esc(r.raw)}</span>` : ''}</div>
  </div>`;
}
// On a phone the open panel covers the lower half: move the map so the chosen place sits above it.
function keepInView(lat, lon) {
  if (desktopLayout()) return;
  // The panel may still be sliding, so use where it will end up rather than where it is now.
  setTimeout(() => {
    const p = map.latLngToContainerPoint([lat, lon]);
    const size = map.getSize();
    const st = sheet.dataset.state;
    const sheetTop = size.y - (st === 'full' ? size.y - 64 : st === 'half' ? size.y * 0.52 : 104);
    if (phoneLandscape()) {
      const panelRight = st === 'peek' ? 0 : Math.min(360, size.x * 0.48);
      const targetX = panelRight + (size.x - panelRight) / 2;
      map.panBy([p.x - targetX, 0]);
      return;
    }
    const targetY = Math.max(90, sheetTop / 2);
    if (p.y > sheetTop - 30 || p.y < 70) map.panBy([p.x - size.x / 2, p.y - targetY]);
  }, 260);
}
function nearestLaunch(m) {
  let best = null;
  state.M.forEach((x) => {
    if (x.kind !== 'launch') return;
    const d = distM(m, x);
    if (d > 150 && d < 30000 && (!best || d < best.d)) best = { lat: x.lat, lon: x.lon, d, title: state.R[x.r[0]].title || 'спуск' };
  });
  return best;
}
const yandexRoute = (p) => `https://yandex.ru/maps/?rtext=~${p.lat},${p.lon}&rtt=auto`;
function updatePointFromMe() {
  const el = $('#pointFromMe');
  if (!el || state.selected == null) return;
  const m = state.M[state.selected];
  if (!state.me) { el.innerHTML = '<span class="muted">Нажмите ◎ вверху, чтобы видеть расстояние и курс от вас.</span>'; return; }
  const d = distM(state.me, m), b = bearing(state.me, m);
  el.textContent = `От вас ${fmtDist(d)} · курс ${Math.round(b)}° (${rumb(b)})`;
}
function handleAction(act, el) {
  const m = state.selected != null ? state.M[state.selected] : null;
  if (act === 'copy-dec' && m) copy(fmtDec(m.lat, m.lon));
  else if (act === 'copy-dm' && m) copy(fmtDM(m.lat, m.lon));
  else if (act === 'nav' && m) {
    const rs = m.r.map((i) => state.R[i]);
    const fish = [...new Set(rs.flatMap((r) => r.fish || []))];
    startNav({ lat: m.lat, lon: m.lon, title: fish.join(', ') || rs[0].title || KINDS[m.kind].short });
  } else if (act === 'fav' && m) {
    const k = pointKey(m.lat, m.lon);
    state.fav.has(k) ? state.fav.delete(k) : state.fav.add(k);
    store.set('ladoga-fav', [...state.fav]);
    el.textContent = state.fav.has(k) ? '★ В избранном' : '☆ В избранное';
    render();
  } else if (act === 'share' && m) sharePoint(m.lat, m.lon, 'Точка на Ладоге');
  else if (act === 'gpx-one' && m) download(`ladoga_${m.lat.toFixed(4)}_${m.lon.toFixed(4)}.gpx`, gpx([{ lat: m.lat, lon: m.lon, name: 'Ладога', desc: m.r.map((i) => state.R[i].comment || '').join('; ') }]));
  else if (act === 'gpx-filter') download('ladoga_filtered.gpx', gpx(filteredWaypoints()));
  else if (act === 'gpx-mine') download('ladoga_my_points.gpx', gpx(state.mine.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name, desc: new Date(p.t).toLocaleString('ru-RU') }))));
  else if (act === 'mine-nav') { const p = state.mine.find((x) => x.id === el.dataset.id) || state.mineCard; if (p) startNav({ lat: p.lat, lon: p.lon, title: p.name }); }
  else if (act === 'mine-share') { const p = state.mine.find((x) => x.id === el.dataset.id) || state.mineCard; if (p) sharePoint(p.lat, p.lon, p.name); }
  else if (act === 'mine-del') { state.mine = state.mine.filter((x) => x.id !== el.dataset.id); store.set('ladoga-mine', state.mine); drawMine(); closeSheetOnPhone(); if (desktopLayout()) showTab('data'); }
  else if (act === 'show-zone') showZone(el.dataset.zone);
  else if (act === 'play-year') playYear();
  else if (act === 'sos-copy' && state.me) copy(`${fmtDM(state.me.lat, state.me.lon)} (${fmtDec(state.me.lat, state.me.lon)})`, 'Координаты');
  else if (act === 'sos-share' && state.me) { const txt = `Нужна помощь. Я на Ладоге: ${fmtDM(state.me.lat, state.me.lon)} (${fmtDec(state.me.lat, state.me.lon)}), ${sectorName(state.me)}`; if (navigator.share) navigator.share({ text: txt }).catch(() => {}); else copy(txt, 'Текст'); }
  else if (act === 'sos-locate') { startWatch(true); toast('Определяю место…'); setTimeout(() => { if (state.tab === 'sos') openSos(); }, 4000); }
  else if (act === 'open-weather') openWeather();
  else if (act === 'zone-open') { const z = (state.ctx.season_zones || []).find((x) => x.id === el.dataset.zoneId); if (z) { const l = zoneLayer(z, '#fab005', (z.name || '').slice(0, 30)); if (l) { layers.seasonZones.clearLayers(); l.addTo(layers.seasonZones); state.overlays.seasonZones = true; applyOverlays(); map.fitBounds(l.getBounds(), { padding: [30, 30], maxZoom: 13 }); } openZoneCard(z); } }
  else if (act === 'offline') downloadOffline(el);
  else if (act === 'track-toggle') { setTracking(!state.track.on); showTab('data'); }
  else if (act === 'track-gpx') { if (state.track.pts.length > 1) download(`ladoga_track_${new Date().toISOString().slice(0, 10)}.gpx`, trackGpx()); else toast('Трек пуст'); }
  else if (act === 'track-clear') { if (window.confirm('Стереть записанный трек?')) { state.track = { on: false, pts: [] }; store.set(TRACK_KEY, state.track); drawTrack(); showTab('data'); } }
  else if (act === 'wx-refresh') { el.textContent = 'Обновляю…'; loadWeather(true).then(() => { if (state.tab === 'weather') $('#sheetBody').innerHTML = weatherHtml(); }); }
  else if (act === 'place-show') showPlace(+el.dataset.zone);
  else if (act === 'place-nav') { const z = (state.ctx.season_zones || [])[+el.dataset.zone]; if (z) startNav({ ...zoneCenter(z), title: z.name || 'Район' }); }
  else if (act === 'copy-link') copy(location.href.split('#')[0], 'Ссылка');
  else if (act === 'locate-retry') { stopWatch(); startWatch(true); closeSheetOnPhone(); }
  else if (act === 'filter-fish') { state.f.fish = new Set([el.dataset.name]); render(); drawSeasonZones(); toast(`На карте: ${el.dataset.name}`); closeSheetOnPhone(); }
  else if (act === 'month-filter') enterSeasonMode(false);
  else if (act === 'close-card') { closeSheetOnPhone(); if (desktopLayout()) showTab('filter'); }
  else if (act === 'zone-nav') startNav({ lat: +el.dataset.lat, lon: +el.dataset.lon, title: el.dataset.name });
  else if (act === 'hint-legend') { showTab('filter'); setSheet(desktopLayout() ? 'full' : 'half'); const l = $('#legend'); if (l) l.open = true; }
}
async function sharePoint(lat, lon, title) {
  const url = `${location.origin}${location.pathname}#pt=${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (navigator.share) { try { await navigator.share({ title, text: `${title}: ${fmtDec(lat, lon)}`, url }); return; } catch { /* cancelled */ } }
  copy(url, 'Ссылка');
}
function gpx(points) {
  const x = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ladoga-fishing-map" xmlns="http://www.topografix.com/GPX/1/1">\n${points.map((p) => `  <wpt lat="${p.lat}" lon="${p.lon}"><name>${x(p.name)}</name><desc>${x(String(p.desc || '').slice(0, 800))}</desc></wpt>`).join('\n')}\n</gpx>\n`;
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

/* ----- Season tab ----- */
function speciesList() { return (state.ctx.species || []).filter((s) => s && s.name_ru); }
// "Лещ (и подлещик)" → "Лещ": the name the reports use, for colours and the fish filter.
const SPECIES_ALIAS = { 'Кумжа': 'Форель' };
function speciesKey(s) {
  const first = String(s.name_ru || '').split(/[\s(]/)[0];
  return SPECIES_ALIAS[first] || first;
}
const speciesColor = (s) => FISH_COLORS[speciesKey(s)] || OTHER_COLOR;
const ACT = ['не ловится / запрет', 'слабо', 'хорошо', 'пик'];
const dots = (v) => `<span title="${ACT[v]}">${'●'.repeat(v)}${'○'.repeat(3 - v)}</span>`;
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
function seasonHtml() {
  const mo = state.seasonMonth;
  const sp = speciesList();
  const hydro = (state.ctx.hydro_calendar || []).find((h) => +h.month === mo);
  const ice = isIceMonth(mo);
  const byMonth = Array(13).fill(0);
  const fishInMonth = new Map();
  for (const r of state.R) {
    if (!CATCH_KINDS.has(r.kind)) continue;
    const mm = monthOf(r);
    byMonth[mm] += 1;
    if (mm === mo) for (const x of r.fish || []) fishInMonth.set(x, (fishInMonth.get(x) || 0) + 1);
  }
  const max = Math.max(1, ...byMonth.slice(1));
  const ranked = sp.map((s) => ({ s, v: +(s.activity_by_month || [])[mo - 1] || 0, p: +(s.presence_by_month || [])[mo - 1] || 0 }))
    .sort((a, b) => b.v - a.v || b.p - a.p);
  const catchable = ranked.filter((x) => x.v > 0);
  const offLimits = ranked.filter((x) => x.v === 0 && x.p >= 2);
  const iceStats = state.ctx.ice_from_angler_reports?.areas || {};
  const iceRows = [11, 12, 1, 2, 3, 4].includes(mo) ? Object.entries(iceStats) : [];
  const q = (o) => (o ? `~${esc(o.median || '?')} (обычно ${esc(o.q25 || '?')}–${esc(o.q75 || '?')})` : '?');
  return `
    <div class="months" style="margin-top:6px">${MONTHS.map((m, i) => `<button type="button" class="chip ${mo === i + 1 ? 'on' : ''}" data-smonth="${i + 1}">${m}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px">
      <button type="button" class="btn small ${state.season ? '' : 'ghost'}" data-act="play-year">${state.season ? '✕ Выйти из режима месяцев' : '▶ Год по месяцам'}</button>
      <label class="check" style="padding:0"><input type="checkbox" data-overlay="seasonZones" ${state.overlays.seasonZones ? 'checked' : ''}> зоны на карте</label>
    </div>
    <h2>Ладога в ${MONTHS_IN[mo - 1]} ${ice ? '❄' : '🌊'}</h2>
    ${hydro ? `<div class="card small">${hydro.events ? `<p style="margin-top:0">${esc(hydro.events)}</p>` : ''}<dl class="kv">${hydro.ice ? `<dt>Лёд</dt><dd>${esc(hydro.ice)}</dd>` : ''}${hydro.water_temp_c ? `<dt>Вода</dt><dd>${esc(hydro.water_temp_c)}${/°/.test(hydro.water_temp_c) ? '' : ' °C'}</dd>` : ''}${hydro.level ? `<dt>Уровень</dt><dd>${esc(hydro.level)}</dd>` : ''}</dl></div>` : ''}
    ${iceRows.length ? `<details><summary class="small">Первый и последний лёд по отчётам рыбаков</summary>${iceRows.map(([area, v]) => `<div class="small" style="margin:4px 0"><b>${esc(area)}</b>: первый лёд ${q(v.first_ice_report)}, последний ${q(v.last_ice_report)}${v.winters_used ? `; зим в выборке: ${v.winters_used}` : ''}</div>`).join('')}</details>` : ''}
    <h3>Что ловится в ${MONTHS_IN[mo - 1]}</h3>
    ${sp.length ? '' : '<p class="muted">Справка по видам ещё собирается.</p>'}
    ${catchable.map(({ s, v }) => `<div class="card">
        <h4><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${speciesColor(s)}"></span> ${esc(s.name_ru)} <span class="muted small">${dots(v)} ${ACT[v]}</span></h4>
        ${methodFor(s, ice) ? `<div class="small">${esc(methodFor(s, ice))}</div>` : ''}
        ${zonesFor(s, mo).map((z) => `<div class="small muted">📍 ${esc(z.name || '')}${z.note ? ` — ${esc(z.note)}` : ''}</div>`).join('')}
        <div class="btns" style="margin:6px 0 0"><button type="button" class="btn small ghost" data-act="filter-fish" data-name="${esc(speciesKey(s))}">Показать на карте</button></div>
      </div>`).join('')}
    ${offLimits.length ? `<h3>Есть в районе, но ловить нельзя или бесполезно</h3>
      ${offLimits.map(({ s, p }) => `<div class="small" style="margin:6px 0">🚫 <b>${esc(s.name_ru)}</b> — ${['', 'единично', 'обычен', 'массовый ход или скопления'][p]}${s.protected ? ', охраняется (Красная книга ЛО)' : ', запретный срок или не берёт'}.${s.presence_note ? ` ${esc(s.presence_note)}` : ''}</div>`).join('')}` : ''}
    ${timeseriesHtml(mo)}
    <h3>Точки на карте по месяцам (все годы)</h3>
    <div class="bars">${byMonth.slice(1).map((n, i) => `<div class="${i + 1 === mo ? 'cur' : ''}" style="height:${Math.round((n / max) * 100)}%" title="${MONTHS_FULL[i]}: ${n}"></div>`).join('')}</div>
    <div class="bars-labels">${MONTHS.map((m) => `<span>${m}</span>`).join('')}</div>
    <p class="small">${fishInMonth.size ? `В ${MONTHS_IN[mo - 1]} на карте чаще всего отмечали: ${[...fishInMonth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, n]) => `${esc(f)} (${n})`).join(', ')}.` : `Отчётов за ${MONTHS_FULL[mo - 1]} пока нет.`}</p>
    <div class="btns"><button type="button" class="btn" data-act="month-filter">Показать отчёты за ${MONTHS_FULL[mo - 1]}</button></div>
    ${(state.ctx.wind_effects || []).length ? `<details><summary>Ветер, уровень воды и отрыв льда</summary>${state.ctx.wind_effects.map((w) => `<div class="card small"><b>${esc(w.wind || '')}</b><br>${esc(w.effect || '')}${w.fishing ? `<br>${esc(w.fishing)}` : ''}</div>`).join('')}</details>` : ''}
    ${sp.length ? `<h3>Календарь клёва</h3>${calendarTable(sp, mo, 'activity_by_month')}
      <p class="small muted">0 — запрет или почти не ловится, 1 — слабо, 2 — хорошо, 3 — пик. Составлено по научным работам (Правдин, Калесник, Лоция, Институт озероведения РАН, Красная книга ЛО) и сверено с 18,5 тыс. отчётов fisher.spb.ru; в конкретный год всё сдвигается на 2–3 недели.</p>
      <details><summary>Календарь присутствия: миграции, нерест, ход</summary>${calendarTable(sp.filter((s) => (s.presence_by_month || []).length), mo, 'presence_by_month')}
      <p class="small muted">Есть ли рыба в южных губах и устьях — независимо от запретов: 3 — массовый ход, нерест или нагул, 0 — ушла глубже или на север.</p></details>` : ''}`;
}
// Dated reports with and without coordinates (Telegram, forums): what people caught, and where, month by month.
function timeseriesHtml(mo) {
  const ts = state.ctx.timeseries;
  if (!ts || !ts.total) return '';
  const bm = ts.by_month || [];
  const max = Math.max(1, ...bm);
  const fish = Object.entries(ts.by_fish || {}).map(([f, arr]) => [f, +arr[mo - 1] || 0]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const areas = Object.entries(ts.by_sector || {}).map(([k, v]) => [k, +(v.by_month || [])[mo - 1] || 0, v.fish || {}]).filter(([k, n]) => n && !/не уточн/i.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return `<h3>Что ловили в ${MONTHS_IN[mo - 1]} — по ${ts.total.toLocaleString('ru-RU')} ${plural(ts.total, 'датированному отчёту', 'датированным отчётам', 'датированным отчётам')}</h3>
    <div class="bars">${bm.map((n, i) => `<div class="${i + 1 === mo ? 'cur' : ''}" style="height:${Math.round((n / max) * 100)}%" title="${MONTHS_FULL[i]}: ${n}"></div>`).join('')}</div>
    <div class="bars-labels">${MONTHS.map((m) => `<span>${m}</span>`).join('')}</div>
    ${fish.length ? `<div class="chips" style="margin-top:8px">${fish.map(([f, n]) => `<button type="button" class="chip" data-act="filter-fish" data-name="${esc(f)}"><span class="dot" style="background:${FISH_COLORS[f] || OTHER_COLOR}"></span>${esc(f)} <span class="n">${n}</span></button>`).join('')}</div>` : ''}
    ${areas.length ? `<p class="small" style="margin-bottom:0"><b>Где чаще всего рыбачили:</b></p>${areas.map(([k, n, f]) => `<div class="small">• ${esc(k)} — ${n} ${plural(n, 'отчёт', 'отчёта', 'отчётов')}</div>`).join('')}` : ''}
    <p class="small muted">Источники: ${(ts.by_source || []).slice(0, 5).map(([s2, n]) => `${esc(s2)} (${n})`).join(', ')}. Это то, о чём пишут рыбаки, а не учёт рыбы.</p>`;
}
function methodFor(s, ice) {
  const bm = s.best_methods || {};
  return (ice ? bm.ice : bm.open_water) || '';
}
function zonesFor(s, mo) {
  return (s.zones || []).filter((z) => !monthList(z.months).length || monthList(z.months).includes(mo));
}
function calendarTable(sp, mo, field) {
  return `<table class="cal"><tr><th></th>${MONTHS.map((m, i) => `<th class="${i + 1 === mo ? 'cur' : ''}">${m[0].toUpperCase()}</th>`).join('')}</tr>
    ${sp.map((s) => `<tr><td>${esc(s.name_ru.replace(/\s*\(.*\)/, ''))}</td>${Array.from({ length: 12 }, (_, i) => { const v = +(s[field] || [])[i] || 0; return `<td class="c v${v} ${i + 1 === mo ? 'cur' : ''}" title="${esc(s.name_ru)}, ${MONTHS_FULL[i]}: ${v}">${v || ''}</td>`; }).join('')}</tr>`).join('')}
  </table>`;
}
// A zone is a circle (lat/lon/radius_km), a polygon, or a line with a width (line_buffer).
// Its outline never catches taps — a tap on the water must reach the map and the points. Each drawn
// zone gets a small label instead; the label opens the zone's card in the panel, which has a clear ✕.
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
// Kept for the species buttons: outline plus label, both leading to the zone card.
function zoneLayer(z, color, label) {
  const shape = zoneShape(z, color);
  if (!shape) return null;
  return L.featureGroup([shape, zoneTag(z, color, label, () => openZoneCard(z))]);
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
    const text = open.length ? open.slice(0, 2).map(shortName).join(', ') + (open.length > 2 ? ` +${open.length - 2}` : '') : `🚫 ${closed.slice(0, 2).map(shortName).join(', ')}`;
    zoneTag(z, color, text, () => openZoneCard(z)).addTo(layers.seasonZones);
  }
}
function openZoneCard(z) {
  const mo = state.seasonMonth;
  const { open, closed } = zoneSpecies(z, mo);
  const st = placeStats(z);
  const src = [].concat(z.sources || [], z.source_url || []).filter(safeUrl);
  state.tab = 'zone';
  $$('#tabs button').forEach((b) => b.classList.remove('active'));
  $('#sheetBody').innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">
      <h2 style="margin-right:8px">${esc(z.name || 'Район')}</h2>
      <button type="button" class="btn small ghost" data-act="close-card">✕ Закрыть</button>
    </div>
    <p class="small muted">${z.depth_m ? `Глубины ${esc(z.depth_m)} м. ` : ''}${monthsText(z.months) ? `Сезон: ${esc(monthsText(z.months))}.` : ''}</p>
    ${open.length ? `<p><b>В ${MONTHS_IN[mo - 1]} ловят:</b> ${open.map((s) => `${esc(shortName(s))} ${dots(activity(s, mo))}`).join(', ')}</p>` : ''}
    ${closed.length ? `<p class="small">🚫 <b>Есть, но ловить нельзя:</b> ${closed.map((s) => esc(shortName(s))).join(', ')}</p>` : ''}
    ${z.description || z.note ? `<p class="small">${esc(z.description || z.note)}</p>` : ''}
    ${st.n ? `<p class="small"><b>Отчётов на карте внутри:</b> ${st.n} — ${st.fish.slice(0, 6).map(([f, c]) => `${esc(f)} ${c}`).join(', ')}</p>` : ''}
    ${st.access.length ? `<p class="small">⚓ ${st.access.slice(0, 3).map((a) => `<a href="#" data-open-marker="${a.idx}">${esc(a.title.replace(/^Слип \/ старт на воду: |^Парковка \/ выход к воде: /, ''))}</a>${a.d > 0 ? ` (${fmtDist(a.d)})` : ''}`).join(' · ')}</p>` : ''}
    ${z.precision_m ? `<p class="small muted">Граница района условная, ±${String(Math.round(z.precision_m / 100) / 10).replace('.', ',')} км.</p>` : ''}
    <div class="btns">
      <button type="button" class="btn" data-act="zone-nav" data-lat="${zoneAnchor(z)[0]}" data-lon="${zoneAnchor(z)[1]}" data-name="${esc(z.name || 'Район')}">🧭 Вести сюда</button>
      <button type="button" class="btn ghost" data-act="close-card">Закрыть</button>
    </div>
    ${src.length ? `<p class="small">${src.slice(0, 4).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">источник ${i + 1}</a>`).join(' · ')}</p>` : ''}`;
  $('#sheetBody').scrollTop = 0;
  setSheet(desktopLayout() ? 'full' : 'half');
  const [la, lo] = zoneAnchor(z);
  keepInView(la, lo);
}
function showZone(id) {
  const [si, zi] = id.split(':').map(Number);
  const s = speciesList()[si];
  const z = s?.zones?.[zi];
  if (!z) return;
  const geo = speciesZoneGeo(z);
  const l = zoneLayer(geo, speciesColor(s), `${shortName(s)}: ${(z.name || '').slice(0, 28)}`);
  if (!l) return;
  layers.seasonZones.clearLayers();
  l.addTo(layers.seasonZones);
  state.overlays.seasonZones = true; applyOverlays();
  map.fitBounds(l.getBounds(), { padding: [40, 40], maxZoom: 13 });
  openZoneCard(geo);
}

/* Season mode: the whole map follows one month — its reports, where they cluster, and the zones of the
   fish that bite then. A banner on the map steps through the year (◀ ▶) or plays it. */
function seasonSummary(mo) {
  const sp = speciesList();
  const best = sp.filter((s) => activity(s, mo) >= 2).sort((a, b) => activity(b, mo) - activity(a, mo)).map(shortName);
  const n = state.R.filter((r) => CATCH_KINDS.has(r.kind) && monthOf(r) === mo).length;
  return { best, n };
}
function enterSeasonMode(autoplay) {
  if (!state.season) {
    state.season = { months: new Set(state.f.months), heat: state.overlays.heat, zones: state.overlays.seasonZones };
  }
  state.overlays.heat = true; state.overlays.seasonZones = true; applyOverlays();
  document.body.classList.add('season-mode');
  $('#monthBanner').hidden = false;
  closeSheetOnPhone();
  showSeasonMonth(state.seasonMonth);
  setAutoplay(autoplay);
}
function showSeasonMonth(mo) {
  state.seasonMonth = mo;
  state.f.months = new Set([mo]);
  render();
  drawSeasonZones();
  const { best, n } = seasonSummary(mo);
  const name = MONTHS_FULL[mo - 1];
  $('#mbMonth').textContent = `${name[0].toUpperCase()}${name.slice(1)}`;
  $('#mbFish').textContent = `${best.length ? `Клюёт: ${best.slice(0, 5).join(', ').toLowerCase()}` : 'Клёв слабый'}. На карте ${n} ${plural(n, 'отчёт', 'отчёта', 'отчётов')} за ${MONTHS_FULL[mo - 1]} (все годы); цветные зоны — где эта рыба держится.`;
  if (state.tab === 'season') showTab('season');
}
function setAutoplay(on) {
  clearInterval(state.playing);
  state.playing = on ? setInterval(() => showSeasonMonth(state.seasonMonth % 12 + 1), 2600) : null;
  $('#mbPlay').textContent = on ? '⏸' : '▶︎';
  $('#mbPlay').setAttribute('aria-label', on ? 'Пауза' : 'Играть');
}
function exitSeasonMode() {
  setAutoplay(false);
  const saved = state.season;
  state.season = null;
  document.body.classList.remove('season-mode');
  $('#monthBanner').hidden = true;
  if (saved) { state.f.months = saved.months; state.overlays.heat = saved.heat; state.overlays.seasonZones = saved.zones; }
  applyOverlays();
  render();
  drawSeasonZones();
}
function playYear() { if (state.season) exitSeasonMode(); else enterSeasonMode(true); }
$('#mbPrev').addEventListener('click', () => { setAutoplay(false); showSeasonMonth((state.seasonMonth + 10) % 12 + 1); });
$('#mbNext').addEventListener('click', () => { setAutoplay(false); showSeasonMonth(state.seasonMonth % 12 + 1); });
$('#mbPlay').addEventListener('click', () => setAutoplay(!state.playing));
$('#mbClose').addEventListener('click', exitSeasonMode);

/* ----- Fish tab ----- */
function fishHtml() {
  const sp = speciesList();
  if (!sp.length) return '<p class="muted">Справка по видам ещё собирается.</p>';
  const mo = new Date().getMonth() + 1;
  const miniBars = (arr, dim) => {
    const vals = Array.from({ length: 12 }, (_, i) => +(arr || [])[i] || 0);
    const mx = Math.max(1, ...vals);
    return `<div class="bars" style="height:30px">${vals.map((v, i) => `<div class="${i + 1 === mo ? 'cur' : ''}" style="height:${v ? Math.max(8, (v / mx) * 100) : 4}%;${v ? '' : 'opacity:.3;'}${dim ? 'background:#91a7b3' : ''}"></div>`).join('')}</div>`;
  };
  // Allowed fish first, then the protected ones; each card is short, the details fold out.
  const ordered = [...sp].sort((a, b) => (!!a.protected - !!b.protected));
  return `<p class="small muted">Когда и где ловится каждая рыба. Столбики — клёв по месяцам (тёмный — сейчас). «Подробнее» — где держится, нерест, перемещения, как ловить и её зоны на карте.</p>
    ${ordered.map((s) => {
      const si = sp.indexOf(s);
      const mentions = s.forum_evidence?.mentions_by_month || [];
      const total = mentions.reduce((a, b) => a + (+b || 0), 0);
      return `<div class="card">
      <h4><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${speciesColor(s)}"></span> ${esc(s.name_ru)} ${s.protected ? '<span class="badge" style="background:#ffe3e3;color:#a61e1e">🚫 охраняется</span>' : ''}</h4>
      ${miniBars(s.activity_by_month)}
      <div class="bars-labels">${MONTHS.map((m) => `<span>${m[0]}</span>`).join('')}</div>
      ${s.ice_vs_open ? `<p class="small" style="margin-bottom:0">${esc(s.ice_vs_open)}</p>` : ''}
      <div class="btns" style="margin:8px 0 0">
        ${s.protected ? '' : `<button type="button" class="btn small" data-act="filter-fish" data-name="${esc(speciesKey(s))}">На карте</button>`}
      </div>
      <details><summary class="small"><b>Подробнее</b></summary>
        ${s.latin ? `<p class="small muted"><i>${esc(s.latin)}</i></p>` : ''}
        ${s.status ? `<p class="small"><b>Статус:</b> ${esc(s.status)}</p>` : ''}
        ${s.habitat_summary ? `<p class="small"><b>Где держится:</b> ${esc(s.habitat_summary)}</p>` : ''}
        ${s.spawning ? `<p class="small"><b>Нерест:</b> ${esc([monthsText(s.spawning.months), s.spawning.place, s.spawning.temp_c ? `вода ${s.spawning.temp_c}${/°/.test(s.spawning.temp_c) ? '' : ' °C'}` : ''].filter((x) => x && typeof x === 'string').join('; '))}</p>` : ''}
        ${s.migration_summary ? `<p class="small"><b>Перемещения по сезонам:</b> ${esc(s.migration_summary)}</p>` : ''}
        ${s.best_methods ? `<p class="small">${s.best_methods.ice ? `<b>❄ Со льда:</b> ${esc(s.best_methods.ice)}<br>` : ''}${s.best_methods.open_water ? `<b>🌊 По воде:</b> ${esc(s.best_methods.open_water)}` : ''}</p>` : ''}
        ${total ? `<div class="small muted">Сколько раз упоминали в отчётах fisher.spb.ru по месяцам (всего ${total}):</div>${miniBars(mentions, true)}<div class="bars-labels">${MONTHS.map((m) => `<span>${m[0]}</span>`).join('')}</div>` : ''}
        ${(s.zones || []).length ? `<p class="small" style="margin-bottom:0"><b>Зоны на карте:</b></p><div class="btns" style="margin-top:4px">${(s.zones || []).map((z, zi) => `<button type="button" class="btn small ghost" data-act="show-zone" data-zone="${si}:${zi}">📍 ${esc((z.name || 'зона').slice(0, 42))}${monthsText(z.months) ? ` · ${esc(monthsText(z.months))}` : ''}</button>`).join('')}</div>` : ''}
        ${(s.sources || []).length ? `<details><summary class="small">Источники (${s.sources.length})</summary>${s.sources.map((u) => (safeUrl(u) ? `<div class="small"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(safeDecode(u.replace(/^https?:\/\//, '')).slice(0, 70))}</a></div>` : `<div class="small">${esc(u)}</div>`)).join('')}</details>` : ''}
      </details>
    </div>`;
    }).join('')}`;
}
function safeDecode(u) { try { return decodeURIComponent(u); } catch { return u; } }

/* ----- Depth tab ----- */
const GENSHTAB_ATTR = 'Топокарта Генштаба СССР 1:100 000 (скан <a href="https://maps.vlasenko.net/soviet-military-topographic-map/map100k.html" target="_blank" rel="noopener">maps.vlasenko.net</a>)';
const ISOBATH_ATTR = 'Изобаты (модель): GLDB v2, Kourzeneva &amp; Choulga, CC BY — не для навигации';
function buildDepthLayers() {
  const d = state.ctx.depth || {};
  layers.genshtab.clearLayers();
  for (const o of d.overlays || []) {
    if (!Array.isArray(o.bounds)) continue;
    L.imageOverlay(o.url, o.bounds, { opacity: state.genshtabOpacity, attribution: GENSHTAB_ATTR, interactive: false, className: 'genshtab' })
      .addTo(layers.genshtab);
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
        return { color: m <= 4 ? '#74c0fc' : m <= 10 ? '#339af0' : m <= 20 ? '#1c7ed6' : '#1864ab', weight: m % 10 === 0 ? 2.2 : 1.3, opacity: 0.85, dashArray: m <= 4 ? '3 4' : null };
      },
      onEachFeature: (f, l) => l.bindTooltip(`${f.properties.depth_m} м (модель, ±0,5–1 км)`, { sticky: true }),
      attribution: ISOBATH_ATTR,
    }).addTo(layers.isobaths);
  } catch { state.isobathsLoaded = false; toast('Не удалось загрузить изобаты'); }
}
function depthHtml() {
  const d = state.ctx.depth || {};
  const o = state.overlays;
  const withDepth = state.R.filter((r) => r.depth).length;
  const apps = d.phone_workflows || [];
  const [main, ...others] = apps;
  const appCard = (a, open) => `<details class="card" ${open ? 'open' : ''}><summary><b>${esc(a.app)}</b></summary>
      <ol class="small" style="padding-left:18px;margin:6px 0">${(a.steps || []).map((st) => `<li style="margin:3px 0">${esc(st)}</li>`).join('')}</ol>
      <dl class="kv small">${a.gpx_import ? `<dt>GPX</dt><dd>${esc(a.gpx_import)}</dd>` : ''}${a.depth_coverage_ladoga ? `<dt>Ладога</dt><dd>${esc(a.depth_coverage_ladoga)}</dd>` : ''}${a.cost ? `<dt>Цена</dt><dd>${esc(a.cost)}</dd>` : ''}</dl>
    </details>`;
  return `
    <h2>Глубины</h2>
    <p class="small">Самые свежие и точные глубины — у рыбаков с эхолотами: их изобаты собирает Garmin (Quickdraw) и показывает бесплатно в телефоне. На сайт эти данные переносить нельзя, поэтому схема такая: <b>глубины — в ActiveCaptain, наши точки — туда же файлом GPX</b>.</p>
    <div class="btns"><button type="button" class="btn small" data-act="gpx-filter">GPX: точки по фильтру</button><a class="btn small ghost" href="downloads/ladoga_points.gpx" download>GPX: все точки</a></div>
    ${main ? appCard(main, true) : ''}
    ${others.length ? `<details><summary class="small">Другие приложения: ${others.map((a) => esc(String(a.app).split(/[ (,]/)[0])).join(', ')}</summary>${others.map((a) => appCard(a, false)).join('')}</details>` : ''}
    <h3>На этой карте — общий рельеф дна</h3>
    <p class="small muted">Помогают понять, где свал, банка или яма. Точным цифрам не верьте: съёмка старая, уровень Ладоги меняется на ±1 м (в 2026 году он примерно на 90 см ниже нормы).</p>
    ${(d.overlays || []).length ? `<div class="card">
      <label class="check" style="padding-top:0"><input type="checkbox" data-overlay="genshtab" ${o.genshtab ? 'checked' : ''}> <b>Старая армейская карта (Генштаб 1:100 000)</b></label>
      <div class="small">Изобаты 2, 5, 10 и 20 м, отметки глубин, камни, отмели (Пересуха и Сидорова у Птинова), мысы, маяки. Съёмка 1970–80-х годов; наложена на GPS с точностью 10–25 м. ${d.overlays.length} ${plural(d.overlays.length, 'лист', 'листа', 'листов')}; листа с о. Сухо (P-36-125) в открытом доступе нет.</div>
      <div class="small muted" style="margin-top:6px">Прозрачность</div>
      <input type="range" id="genshtabOpacity" min="0.25" max="1" step="0.05" value="${state.genshtabOpacity}">
      <p class="small muted" style="margin-bottom:0">Файлы по 1–2 МБ, грузятся только при включении. Слой справочный, открытой лицензии у старых карт нет.</p>
    </div>` : ''}
    ${d.isobaths ? `<div class="card">
      <label class="check" style="padding-top:0"><input type="checkbox" data-overlay="isobaths" ${o.isobaths ? 'checked' : ''}> <b>Изобаты 2–70 м (открытая модель GLDB)</b></label>
      <div class="small">Грубая модель дна с сеткой ~0,5×0,9 км: где губа мелкая, где уходит на 10–20 м. Линии ошибаются на 0,5–1 км — <b>не для навигации</b>.</div>
      <div class="btns" style="margin-bottom:0"><a class="btn small ghost" href="downloads/ladoga_isobaths_model.gpx" download>Изобаты в GPX</a></div>
    </div>` : ''}
    <label class="check"><input type="checkbox" id="depthOnly" ${state.f.depthOnly ? 'checked' : ''}> Показать только отчёты, где рыбак указал глубину (${withDepth})</label>
    <details><summary class="small">А можно Navionics прямо на эту карту?</summary>
      <p class="small">Только с ключом Garmin Navionics Web API (заявку подаёт владелец сайта на garmin.com, из России могут отказать). Бесплатный тариф разрешает лишь отдельное окно с картой Navionics без наших точек, поверх — только платный. Для «глубины + точки» проще ActiveCaptain или Navionics Boating в телефоне.</p>
    </details>`;
}

/* ----- Today tab: the first screen — weather, what bites now and where, bans in force, ice ----- */
const RU_MONTH_STEMS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
// "с 1 апреля по 15 июня", "01.04–15.06", "1 апреля — 15 июня" → [[m,d],[m,d]]; null when the text has no dates.
function parseDateRange(text) {
  const t = String(text || '').toLowerCase();
  const num = t.match(/(\d{1,2})\.(\d{1,2})\s*(?:[-–—]|по|до)\s*(\d{1,2})\.(\d{1,2})/);
  if (num) return [[+num[2], +num[1]], [+num[4], +num[3]]];
  const words = [...t.matchAll(/(\d{1,2})\s+([а-яё]+)/g)].map((m) => {
    const mi = RU_MONTH_STEMS.findIndex((stem) => m[2].startsWith(stem) && !(stem === 'ма' && !/^ма[яй]/.test(m[2])));
    return mi >= 0 ? [mi + 1, +m[1]] : null;
  }).filter(Boolean);
  return words.length >= 2 ? [words[0], words[1]] : null;
}
function inRange(range, date = new Date()) {
  const md = (date.getMonth() + 1) * 100 + date.getDate();
  const a = range[0][0] * 100 + range[0][1], b = range[1][0] * 100 + range[1][1];
  return a <= b ? md >= a && md <= b : md >= a || md <= b;
}
function todayHtml() {
  const mo = new Date().getMonth() + 1;
  const sp = speciesList();
  const best = sp.filter((s) => activity(s, mo) >= 1).sort((a, b) => activity(b, mo) - activity(a, mo));
  const ice = isIceMonth(mo);
  const hydro = (state.ctx.hydro_calendar || []).find((h) => +h.month === mo);
  const wx = state.wx?.fc?.current ? state.wx : null;
  const warns = wx ? wxWarnings(wx) : [];
  const bans = bansToday();
  const zones = (state.ctx.season_zones || []).map((z) => ({ z, ...zoneSpecies(z, mo) })).filter((x) => x.open.length)
    .sort((a, b) => activity(b.open[0], mo) - activity(a.open[0], mo)).slice(0, 5);
  const n = state.R.filter((r) => CATCH_KINDS.has(r.kind) && monthOf(r) === mo).length;
  const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return `
    <h2>Сегодня, ${esc(date)} ${ice ? '❄' : '🌊'}</h2>
    ${wx ? `<button type="button" class="card today-wx" data-act="open-weather">
        <span>${windArrow(wx.fc.current.wind_direction_10m, 22)}</span>
        <span><b>${Math.round(wx.fc.current.wind_speed_10m)} м/с ${rumb(wx.fc.current.wind_direction_10m)}</b>, порывы ${Math.round(wx.fc.current.wind_gusts_10m)} · ${Math.round(wx.fc.current.temperature_2m)}° · ${hPaToMm(wx.fc.current.pressure_msl)} мм<br><span class="muted small">${esc(wxPlace().name)} · прогноз и волна →</span></span>
      </button>` : '<p class="small muted">Погода загрузится, когда будет интернет.</p>'}
    ${warns.map((w) => `<div class="card small wx-${w.level}">${w.level === 'danger' ? '⚠️ ' : w.level === 'warn' ? '🌊 ' : 'ℹ️ '}${esc(w.text)}</div>`).join('')}
    ${bans.length ? `<div class="card small wx-danger"><b>Сегодня действует:</b>${bans.map(banLine).join('')}<div style="margin-top:6px"><a href="#" data-tab-link="rules">Размеры, нормы и все правила →</a></div></div>` : `<p class="small">✅ Сезонных запретов на любительский лов сегодня нет. <a href="#" data-tab-link="rules">Размеры и нормы →</a></p>`}
    <h3>Что ловится в ${MONTHS_IN[mo - 1]}</h3>
    ${best.length ? `<div class="chips">${best.slice(0, 8).map((s) => `<button type="button" class="chip" data-act="filter-fish" data-name="${esc(speciesKey(s))}"><span class="dot" style="background:${speciesColor(s)}"></span>${esc(shortName(s))} ${dots(activity(s, mo))}</button>`).join('')}</div>` : '<p class="small muted">Справка по рыбе загружается…</p>'}
    ${best[0] && methodFor(best[0], ice) ? `<p class="small"><b>${esc(shortName(best[0]))}:</b> ${esc(methodFor(best[0], ice))}</p>` : ''}
    ${zones.length ? `<h3>Где искать сейчас</h3>${zones.map(({ z, open }) => `<button type="button" class="card today-zone" data-act="zone-open" data-zone-id="${esc(z.id)}"><b>${esc(z.name)}</b><br><span class="small">${open.slice(0, 3).map((s) => esc(shortName(s))).join(', ')}${z.depth_m ? ` · ${esc(z.depth_m)} м` : ''}</span></button>`).join('')}` : ''}
    ${hydro ? `<h3>Вода и лёд</h3><p class="small">${esc(hydro.events || '')}</p>` : ''}
    <div class="btns">
      <button type="button" class="btn" data-act="month-filter">Отчёты за ${MONTHS_FULL[mo - 1]} на карте (${n})</button>
      <button type="button" class="btn ghost" data-tab-link="places">Места</button>
      <button type="button" class="btn ghost" data-tab-link="depth">Глубины</button>
    </div>`;
}

/* ----- Places tab: a guide to the named areas, built from the season zones and the reports inside them ----- */
function pointInPolygon(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToSegmentM(p, a, b) {
  // Equirectangular projection is plenty at these distances.
  const k = Math.cos(toRad(p.lat)) * 111320, m = 110540;
  const ax = (a[1] - p.lon) * k, ay = (a[0] - p.lat) * m, bx = (b[1] - p.lon) * k, by = (b[0] - p.lat) * m;
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
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
function zoneCenter(z) {
  if (z.lat != null && z.lon != null) return { lat: +z.lat, lon: +z.lon };
  const pts = z.polygon || z.line || [];
  return { lat: pts.reduce((a, p) => a + p[0], 0) / pts.length, lon: pts.reduce((a, p) => a + p[1], 0) / pts.length };
}
function placesHtml() {
  const zones = state.ctx.season_zones || [];
  if (!zones.length) return '<p class="muted">Справочник мест ещё собирается.</p>';
  const mo = new Date().getMonth() + 1;
  const sp = speciesList();
  const order = zones.map((z, i) => ({ z, i, n: placeStats(z).n })).sort((a, b) => b.n - a.n);
  return `<p class="small muted">Районы южной Ладоги: что там за дно, какая рыба и когда, где спуститься на воду и чего опасаться. Цифры по рыбе — отчёты с этой карты внутри района.</p>
    ${order.map(({ z, i }) => {
      const st = placeStats(z);
      const max = Math.max(1, ...st.months);
      const nowSp = sp.filter((s) => (s.zones || []).some((x) => x.zone_id === z.id && monthList(x.months).includes(mo)));
      return `<div class="card">
        <h4>${esc(z.name || 'Район')}</h4>
        <div class="small muted">${z.depth_m ? `глубины ${esc(z.depth_m)} м · ` : ''}${monthsText(z.months) ? `сезон: ${esc(monthsText(z.months))}` : ''}</div>
        ${nowSp.filter((s) => +(s.activity_by_month || [])[mo - 1] > 0).length ? `<div class="small" style="margin-top:4px">В ${MONTHS_IN[mo - 1]} ловят: ${nowSp.filter((s) => +(s.activity_by_month || [])[mo - 1] > 0).map((s) => esc(s.name_ru.replace(/\s*\(.*\)/, ''))).join(', ')}</div>` : ''}
        ${nowSp.filter((s) => !(+(s.activity_by_month || [])[mo - 1] > 0)).length ? `<div class="small muted">🚫 Есть, но ловить нельзя: ${nowSp.filter((s) => !(+(s.activity_by_month || [])[mo - 1] > 0)).map((s) => esc(s.name_ru.replace(/\s*\(.*\)/, ''))).join(', ')}</div>` : ''}
        ${st.n ? `<div class="small" style="margin-top:4px"><b>${st.n} ${plural(st.n, 'отчёт', 'отчёта', 'отчётов')} на карте:</b> ${st.fish.slice(0, 6).map(([f, c]) => `${esc(f)} ${c}`).join(', ')}</div>
          <div class="bars" style="height:26px">${st.months.map((v, k) => `<div class="${k + 1 === mo ? 'cur' : ''}" style="height:${v ? Math.max(8, (v / max) * 100) : 4}%;${v ? '' : 'opacity:.3'}" title="${MONTHS_FULL[k]}: ${v}"></div>`).join('')}</div>
          <div class="bars-labels">${MONTHS.map((m) => `<span>${m[0]}</span>`).join('')}</div>` : ''}
        <details><summary class="small">Описание</summary><p class="small">${esc(z.description || z.note || '')}</p></details>
        ${st.access.length ? `<div class="small">⚓ ${st.access.slice(0, 3).map((a) => `<a href="#" data-open-marker="${a.idx}">${esc(a.title.replace(/^Слип \/ старт на воду: |^Парковка \/ выход к воде: /, ''))}</a>${a.d > 0 ? ` (${fmtDist(a.d)})` : ''}`).join(' · ')}</div>` : ''}
        ${st.hazards.length ? `<div class="small">⚠️ ${st.hazards.slice(0, 3).map((h) => `<a href="#" data-open-marker="${h.idx}">${esc(h.title)}</a>`).join(' · ')}${st.hazards.length > 3 ? ` и ещё ${st.hazards.length - 3}` : ''}</div>` : ''}
        <div class="btns" style="margin-bottom:0">
          <button type="button" class="btn small" data-act="place-show" data-zone="${i}">Показать</button>
          <button type="button" class="btn small ghost" data-act="place-nav" data-zone="${i}">🧭 Вести сюда</button>
        </div>
      </div>`;
    }).join('')}`;
}
function showPlace(i) {
  const z = (state.ctx.season_zones || [])[i];
  if (!z) return;
  const l = zoneLayer(z, '#fab005', (z.name || 'Район').slice(0, 30));
  if (!l) return;
  layers.seasonZones.clearLayers();
  l.addTo(layers.seasonZones);
  state.overlays.seasonZones = true; applyOverlays();
  map.fitBounds(l.getBounds(), { padding: [30, 30], maxZoom: 13 });
  openZoneCard(z);
}

/* ----- Rules tab ----- */
// Which part of a closed-season text is in force on a date. The rules mix plain ranges ("1 мая – 15 июня")
// with ice-bound ones ("с распаления льда до 20 июня", "с 15 сентября до ледостава"); ice dates are taken
// as the typical ones for the south of Ladoga (break-up ~15 April, freeze-up ~15 December).
const ICE_BREAKUP = [4, 15], FREEZE_UP = [12, 15];
function monthDay(txt) {
  const m = String(txt).toLowerCase().match(/(\d{1,2})\s+([а-яё]+)/);
  if (!m) return null;
  const mi = RU_MONTH_STEMS.findIndex((stem) => m[2].startsWith(stem) && !(stem === 'ма' && !/^ма[яй]/.test(m[2])));
  return mi >= 0 ? [mi + 1, +m[1]] : null;
}
function activeParts(text, date = new Date()) {
  const out = [];
  // "Ладожское озеро: с … до 20 июня и с 15 сентября до ледостава" → both halves keep «Ладожское озеро:».
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
  const who = motor ? `🚤 Моторы запрещены — ${(c.species.match(/\(([^)]+)\)/) || [])[1] || c.area || ''}` : `🚫 ${c.species || 'все виды'}`;
  return `<div style="margin-top:4px">• <b>${esc(who)}</b>: ${esc(c.now || c.dates || '')}${!motor && c.area ? ` <span class="muted">(${esc(c.area)})</span>` : ''}</div>`;
}
function rulesHtml() {
  const g = state.ctx.regulations || {};
  const ice = state.ctx.ice_rules || [];
  if (!Object.keys(g).length && !ice.length) return '<p class="muted">Правила ещё собираются.</p>';
  const cs = g.closed_seasons || [];
  const now = bansToday();
  const forbidden = cs.filter((c) => /круглый год \(запретные виды\)/i.test(c.dates || ''));
  const seasons = cs.filter((c) => !isMotorBan(c) && !forbidden.includes(c));
  const motors = cs.filter(isMotorBan);
  const sizes = g.size_limits || [], bags = g.bag_limits || [];
  const species = [...new Set([...sizes.map((x) => x.species), ...bags.map((x) => x.species)])];
  const amateurAreas = (g.prohibited_areas || []).filter((a) => !/^\[Промысел\]|справочно/i.test(`${a.name} ${a.applies_to}`));
  const tradeAreas = (g.prohibited_areas || []).filter((a) => !amateurAreas.includes(a));
  const incidents = state.R.filter((r) => r.kind === 'ice_incident').length;
  return `
    <h2>Правила и запреты</h2>
    <div class="card small">Выжимка из Правил рыболовства Западного бассейна (приказ № 620 в ред. № 747, действует с 01.09.2024 до 01.09.2027). Перед поездкой сверяйтесь с текстом: ${safeUrl(g.url) ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">официальная публикация</a>` : ''}${(g.consolidated_text_urls || []).filter(safeUrl).map((u, i) => ` · <a href="${esc(u)}" target="_blank" rel="noopener">${i ? 'Гарант' : 'КонсультантПлюс'}</a>`).join('')}.</div>
    <h3>Действует сегодня</h3>
    ${now.length ? `<div class="card small wx-danger">${now.map(banLine).join('')}</div>` : '<p class="small">Сегодня сезонных запретов на любительский лов в этом районе нет — действуют только общие правила ниже.</p>'}
    <h3>Размер и норма вылова</h3>
    <table class="rules-table"><tr><th>Рыба</th><th>Не меньше</th><th>В сутки</th></tr>
      ${species.map((sp) => { const sz = sizes.find((x) => x.species === sp); const bg = bags.find((x) => x.species === sp); return `<tr><td>${esc(sp)}</td><td>${sz ? `${esc(sz.min_cm)} см` : '—'}</td><td>${bg ? esc(bg.limit) : '—'}</td></tr>`; }).join('')}
    </table>
    ${bags.filter((b) => b.note).map((b) => `<p class="small muted">${esc(b.species)}: ${esc(b.note)}</p>`).join('')}
    <h3>Запретные сроки</h3>
    ${seasons.map((c) => `<div class="card small"><b>${esc(c.species)}</b>: ${esc(c.dates)}<br><span class="muted">${esc(c.area || '')}${c.article ? ` · ${esc(c.article)}` : ''}</span>${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</div>`).join('')}
    ${forbidden.length ? `<h3>Ловить нельзя никогда</h3>${forbidden.map((c) => `<div class="small" style="margin:4px 0">🚫 ${esc(c.species)} <span class="muted">(${esc(c.area || '')})</span></div>`).join('')}<p class="small muted">Случайно пойманную рыбу запрещённых видов и меньше разрешённого размера сразу отпускают.</p>` : ''}
    ${motors.length ? `<h3>Лодки с мотором</h3>${motors.map((c) => `<div class="card small"><b>${esc((c.species.match(/\(([^)]+)\)/) || [])[1] || '')}</b>: ${esc(c.dates)}<br><span class="muted">${esc(c.area || '')}</span></div>`).join('')}<p class="small muted">Запрет на моторы касается рыболовства с моторных лодок в эти сроки; «до ледостава» и «с распаления льда» — по факту на водоёме.</p>` : ''}
    ${(g.gear_rules || []).length ? `<h3>Снасти и способы</h3>${g.gear_rules.map((b) => `<div class="small" style="margin:5px 0">• ${esc(typeof b === 'string' ? b : b.rule || '')}</div>`).join('')}` : ''}
    ${amateurAreas.length ? `<h3>Запретные места</h3>
      <label class="check"><input type="checkbox" data-overlay="rules" ${state.overlays.rules ? 'checked' : ''}> Показать на карте</label>
      ${amateurAreas.map((a) => `<div class="card small"><b>${esc(a.name)}</b>${a.period ? ` — ${esc(a.period)}` : ''}<br>${esc(a.description || '')}</div>`).join('')}` : ''}
    ${tradeAreas.length ? `<details><summary class="small">Запреты для промысла (любителей не касаются, справочно): ${tradeAreas.length}</summary>${tradeAreas.map((a) => `<div class="small" style="margin:6px 0"><b>${esc(a.name.replace(/^\[Промысел\]\s*/, ''))}</b>${a.period ? ` — ${esc(a.period)}` : ''}. ${esc(a.description || '')}</div>`).join('')}</details>` : ''}
    ${(state.ctx.practical?.boat_rules || []).length ? `<h3>Лодка и мотор (ГИМС, 2026)</h3>${state.ctx.practical.boat_rules.map((b) => `<details class="card small"><summary><b>${esc(b.title)}</b></summary><p>${esc(b.text)}</p>${safeUrl(b.source_url) ? `<a href="${esc(b.source_url)}" target="_blank" rel="noopener">источник</a>` : ''}</details>`).join('')}` : ''}
    ${(state.ctx.practical?.ice_rules_general || []).length ? `<h3>Выход на лёд</h3>${state.ctx.practical.ice_rules_general.map((b) => `<details class="card small"><summary><b>${esc(b.title)}</b></summary><p>${esc(b.text)}</p>${safeUrl(b.source_url) ? `<a href="${esc(b.source_url)}" target="_blank" rel="noopener">источник</a>` : ''}</details>`).join('')}` : ''}
    ${ice.length ? `<h3>Лёд: запреты и безопасность</h3>${ice.map((b) => `<details class="card small"><summary><b>${esc(b.title || b.type || '')}</b></summary><p>${esc(b.description || b.summary || '')}</p>${safeUrl(b.source_url) ? `<a href="${esc(b.source_url)}" target="_blank" rel="noopener">источник</a>` : ''}</details>`).join('')}` : ''}
    ${incidents ? `<p class="small">На карте ${incidents} ${plural(incidents, 'случай', 'случая', 'случаев')} на льду (оранжевые точки) за 2009–2026: отрывы льдин, провалы, машины под лёд. Это и опасные места, и места, куда массово выходят рыбаки.</p>` : ''}`;
}
// Prohibited areas on the map: circles for zones, lines and polygons as drawn by the rules, markers for named points.
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
    const tag = L.marker(c, { icon: L.divIcon({ className: 'zone-tag-wrap', html: `<button type="button" class="zone-tag" style="--zc:${color}">🚫 ${esc(label.slice(0, 34))}</button>`, iconSize: null }), zIndexOffset: -400 });
    tag.on('click', () => {
      state.tab = 'rule';
      $$('#tabs button').forEach((b) => b.classList.remove('active'));
      $('#sheetBody').innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h2>${esc(label)}</h2><button type="button" class="btn small ghost" data-act="close-card">✕</button></div>
        <p class="small"><b>${esc(a.period || '')}</b>${a.applies_to ? ` · ${esc(a.applies_to)}` : ''}</p><p class="small">${esc(a.description || '')}</p>${a.article ? `<p class="small muted">${esc(a.article)}</p>` : ''}${safeUrl(a.source_url) ? `<a class="small" href="${esc(a.source_url)}" target="_blank" rel="noopener">текст правил</a>` : ''}`;
      setSheet(desktopLayout() ? 'full' : 'half');
    });
    tag.addTo(layers.rules);
  }
}

/* ----- Layers tab ----- */
function layersHtml() {
  const o = state.overlays;
  const extra = Object.entries(extraOverlays);
  return `
    <h3>Подложка</h3>
    ${Object.entries(BASES).map(([k, b]) => `<label class="check"><input type="radio" name="base" value="${k}" ${state.base === k ? 'checked' : ''}> ${esc(b.name)}</label>`).join('')}
    <h3>Поверх карты</h3>
    <label class="check"><input type="checkbox" data-overlay="cluster" ${o.cluster ? 'checked' : ''}> Группировать близкие точки</label>
    <label class="check"><input type="checkbox" data-overlay="heat" ${o.heat ? 'checked' : ''}> Тепловая карта активности</label>
    <label class="check"><input type="checkbox" data-overlay="seamarks" ${o.seamarks ? 'checked' : ''}> Морские знаки, буи, маяки (OpenSeaMap)</label>
    <label class="check"><input type="checkbox" data-overlay="lines" ${o.lines ? 'checked' : ''}> Фарватеры</label>
    <label class="check"><input type="checkbox" data-overlay="seasonZones" ${o.seasonZones ? 'checked' : ''}> Сезонные зоны рыбы (месяц — во вкладке «Сезон»)</label>
    <label class="check"><input type="checkbox" data-overlay="rules" ${o.rules ? 'checked' : ''}> Запретные районы</label>
    <label class="check"><input type="checkbox" data-overlay="radius" ${o.radius ? 'checked' : ''}> Круг 55 км от Новой Ладоги</label>
    <label class="check"><input type="checkbox" data-overlay="mine" ${o.mine ? 'checked' : ''}> Мои точки (${state.mine.length})</label>
    ${extra.length ? `<h3>Старые и специальные карты</h3>
      ${extra.map(([k, ov]) => `<label class="check"><input type="checkbox" data-overlay="${k}" ${o[k] ? 'checked' : ''}> ${esc(ov.name)}</label>${ov.note ? `<div class="small muted" style="margin:-4px 0 4px 26px">${esc(ov.note)}</div>` : ''}`).join('')}
      <div class="small">Прозрачность старых карт</div>
      <input type="range" id="overlayOpacity" min="0.2" max="1" step="0.05" value="${state.overlayOpacity}">` : ''}
    <h3>Без интернета</h3>
    <p class="small">На воде связь пропадает. Приблизьте карту к месту рыбалки и сохраните спутниковую подложку этого района в телефон — она откроется и без сети. Точки, справочники и старые карты сохраняются вместе с ней.</p>
    <div class="btns"><button type="button" class="btn" data-act="offline">📥 Сохранить карту этого района</button></div>
    ${store.get('ladoga-offline-at', 0) ? `<p class="small muted">Последний раз сохраняли ${new Date(store.get('ladoga-offline-at', 0)).toLocaleString('ru-RU')}.</p>` : ''}
    <p class="small muted">Просмотренные участки тоже остаются в телефоне, пока браузер не очистит память.</p>`;
}

/* ----- Data tab ----- */
function dataHtml() {
  const s = state.meta.stats || {};
  const sources = state.ctx.sources || [];
  const byStatus = (st) => sources.filter((x) => x.status === st);
  return `
    <h2>О данных</h2>
    <p>Все точки взяты из открытых публикаций: рыболовные отчёты с геометками, координаты, которые рыбаки сами выложили, наблюдения на iNaturalist и GBIF, карты OpenStreetMap, сводки МЧС. Каждая запись ведёт на свой источник.</p>
    <div class="card small">
      <b>Как читать.</b> Густые скопления точек и тепловая карта показывают, где <i>чаще публикуют</i> отчёты: у Новой Ладоги и Кобоны больше рыбаков и дорог. Это не доказательство, что рыбы там больше.
    </div>
    <dl class="kv">
      <dt>Записей</dt><dd>${s.reports ?? state.R.length}</dd>
      <dt>Точек на карте</dt><dd>${s.markers ?? state.M.length}</dd>
      <dt>Данные от</dt><dd>${esc(state.meta.generated || '')}</dd>
    </dl>
    <h3>Источники</h3>
    ${(s.by_source || []).map(([name, n]) => `<div class="small">${esc(name)} — ${n}</div>`).join('')}
    <h3>Классы достоверности</h3>
    ${['A', 'B', 'C'].map((c) => `<div class="small"><span class="badge ${c}">${c}</span> ${esc(CLASS_TEXT[c])} — ${(s.by_class || []).find((x) => x[0] === c)?.[1] || 0}</div>`).join('')}
    <h3>Скачать</h3>
    <div class="btns">
      <button type="button" class="btn small" data-act="gpx-filter">GPX: точки по фильтру</button>
      <a class="btn small ghost" href="downloads/ladoga_points.gpx" download>GPX: все точки</a>
      <a class="btn small ghost" href="downloads/ladoga_reports.csv" download>CSV (Excel)</a>
      <a class="btn small ghost" href="downloads/ladoga_reports.geojson" download>GeoJSON</a>
    </div>
    <p class="small muted">GPX открывается в Navionics, Garmin (эхолоты/картплоттеры через ActiveCaptain или карту памяти), OsmAnd, Locus, Яндекс Навигаторе — через «Открыть в…».</p>
    <h3>Мой трек</h3>
    <p class="small">${state.track.pts.length > 1 ? `Записано ${fmtDist(trackLength(state.track.pts))}, ${state.track.pts.length} точек${state.track.on ? ' — запись идёт' : ''}.` : (state.track.on ? 'Запись идёт — жду GPS.' : 'Трек показывает на карте, где вы прошли на лодке или по льду; его можно сохранить в GPX. Запись идёт, пока карта открыта.')}</p>
    <div class="btns"><button type="button" class="btn small" data-act="track-toggle">${state.track.on ? '⏹ Остановить запись' : '⏺ Записывать трек'}</button>${state.track.pts.length > 1 ? '<button type="button" class="btn small ghost" data-act="track-gpx">Скачать GPX</button><button type="button" class="btn small ghost" data-act="track-clear">Стереть</button>' : ''}</div>
    <h3>Мои точки (${state.mine.length})</h3>
    <p class="small muted">Долгое нажатие на карту или «📍 Отметить» в навигаторе сохраняет вашу точку в этом телефоне.</p>
    ${state.mine.map((p) => `<div class="card small"><b>${esc(p.name)}</b> <span class="coord">${fmtDec(p.lat, p.lon)}</span><div class="btns"><button type="button" class="btn small" data-act="mine-nav" data-id="${esc(p.id)}">🧭 Вести</button><button type="button" class="btn small ghost" data-act="mine-del" data-id="${esc(p.id)}">Удалить</button></div></div>`).join('')}
    ${state.mine.length ? '<button type="button" class="btn small ghost" data-act="gpx-mine">Скачать мои точки (GPX)</button>' : ''}
    ${sources.length ? `<h3>Что проверено при сборе</h3>
      <details><summary class="small">Использовано: ${byStatus('used').length}</summary>${byStatus('used').map(srcLine).join('')}</details>
      <details><summary class="small">Нет данных / закрыто / требует входа: ${sources.length - byStatus('used').length}</summary>${sources.filter((x) => x.status !== 'used').map(srcLine).join('')}</details>` : ''}`;
}
function srcLine(x) {
  return `<div class="small" style="margin:4px 0">${safeUrl(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name || x.url)}</a>` : esc(x.name)} <span class="muted">— ${esc(x.status)}${x.note ? `: ${esc(x.note)}` : ''}</span></div>`;
}

/* ---------- my points ---------- */
function drawMine() {
  layers.mine.clearLayers();
  for (const p of state.mine) {
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: '<div class="shape mine"><b>★</b></div>', iconSize: [20, 20], iconAnchor: [10, 20] }) })
      .on('click', () => openMineCard(p))
      .addTo(layers.mine);
  }
}
function openMineCard(p) {
  state.tab = 'mine';
  $$('#tabs button').forEach((b) => b.classList.remove('active'));
  $('#sheetBody').innerHTML = `
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h2>★ ${esc(p.name)}</h2><button type="button" class="btn small ghost" data-act="close-card">✕ Закрыть</button></div>
    <div class="card"><div class="coord">${fmtDec(p.lat, p.lon)}</div><div class="coord">${fmtDM(p.lat, p.lon)}</div>
      <div class="small muted">${p.t ? new Date(p.t).toLocaleString('ru-RU') : 'точка по ссылке'}</div></div>
    <div class="btns">
      <button type="button" class="btn" data-act="mine-nav" data-id="${esc(p.id)}">🧭 Вести сюда</button>
      <a class="btn ghost" href="${esc(yandexRoute(p))}" target="_blank" rel="noopener">🚗 Доехать</a>
      <button type="button" class="btn ghost" data-act="mine-share" data-id="${esc(p.id)}">↗ Поделиться</button>
      ${p.link ? '' : `<button type="button" class="btn ghost" data-act="mine-del" data-id="${esc(p.id)}">Удалить</button>`}
    </div>`;
  state.mineCard = p;
  setSheet(desktopLayout() ? 'full' : 'half');
}
function addMine(lat, lon, suggested) {
  const name = window.prompt('Название точки (сохранится только в этом телефоне):', suggested);
  if (name == null) return;
  state.mine.push({ id: String(Date.now()), lat: +lat.toFixed(6), lon: +lon.toFixed(6), name: name.trim() || suggested, t: Date.now() });
  store.set('ladoga-mine', state.mine);
  state.overlays.mine = true; applyOverlays();
  drawMine();
  toast('Точка сохранена');
}
map.on('click', () => { if (!desktopLayout() && sheet.dataset.state !== 'peek') setSheet('peek'); });
map.on('contextmenu', (e) => addMine(e.latlng.lat, e.latlng.lng, `Моя точка ${new Date().toLocaleDateString('ru-RU')}`));

/* ---------- location & navigator ---------- */
const meMarker = L.marker([0, 0], { interactive: false, icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) });
const meCircle = L.circle([0, 0], { radius: 1, color: '#1c7ed6', weight: 1, fillOpacity: 0.1, interactive: false });
const navLine = L.polyline([], { color: '#fa5252', weight: 3, dashArray: '8 8', interactive: false });
const navTarget = L.marker([0, 0], { interactive: false, icon: L.divIcon({ className: '', html: '<div class="target-ring"></div>', iconSize: [34, 34], iconAnchor: [17, 17] }) });

// Layout helpers: a desktop has a permanent side panel; a phone on its side has a fold-away one.
const phoneLandscape = () => window.matchMedia('(orientation: landscape) and (max-height: 540px) and (max-width: 1100px)').matches;
const desktopLayout = () => window.matchMedia('(min-width: 900px) and (min-height: 541px)').matches;
const closeSheetOnPhone = () => { if (!desktopLayout()) setSheet('peek'); };

// Telegram, VK and other apps open links in their own browser, which seldom passes a site the location.
function platformInfo() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inApp = (iOS && typeof navigator.standalone === 'undefined') || /Telegram|FBAN|FBAV|Instagram|VKClient|Line\/|; wv\)/i.test(ua);
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return { iOS, inApp, installed };
}
function inAppBrowser() { return platformInfo().inApp; }

// Location: a quick coarse fix first (Safari answers it in a second or two from Wi-Fi), then a
// high-accuracy watch that keeps improving. No timeout on the watch — on the water GPS may need a minute.
function startWatch(center) {
  if (!navigator.geolocation) { showLocationHelp('unsupported'); return; }
  state.centerOnFix = center;
  if (state.watchId != null) {
    if (center && state.me) map.setView([state.me.lat, state.me.lon], Math.max(map.getZoom(), 13));
    return;
  }
  if (inAppBrowser() && !store.get('ladoga-inapp-warned', false)) { store.set('ladoga-inapp-warned', true); showLocationHelp('inapp'); }
  $('#btnLocate').classList.add('on', 'busy');
  if (!state.me) toast('Определяю, где вы… Если телефон спросит — разрешите геопозицию', 4000);
  navigator.geolocation.getCurrentPosition(onFix, onGeoError, { enableHighAccuracy: false, maximumAge: 120000, timeout: 15000 });
  state.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 3000 });
}
function stopWatch() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null; state.me = null;
  layers.me.clearLayers();
  $('#btnLocate').classList.remove('on', 'busy');
}
function onFix(pos) {
  const c = pos.coords;
  // A coarse Wi-Fi fix must not overwrite a good GPS one that arrived a moment earlier.
  if (state.me && state.me.acc < c.accuracy && Date.now() - state.me.t < 10000) return;
  state.me = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed, heading: c.heading, t: Date.now() };
  state.geoError = null;
  $('#btnLocate').classList.remove('busy');
  if (!layers.me.hasLayer(meMarker)) { meMarker.addTo(layers.me); meCircle.addTo(layers.me); }
  meMarker.setLatLng([c.latitude, c.longitude]);
  meCircle.setLatLng([c.latitude, c.longitude]).setRadius(c.accuracy || 1);
  if (state.centerOnFix) { map.setView([c.latitude, c.longitude], Math.max(map.getZoom(), 13)); state.centerOnFix = false; }
  addTrackPoint(state.me);
  updateNav();
  updatePointFromMe();
}
function onGeoError(err) {
  state.geoError = err.code;
  if (err.code === 1) {
    stopWatch();
    showLocationHelp(inAppBrowser() ? 'inapp' : 'denied');
  } else if (!state.me) {
    // POSITION_UNAVAILABLE or TIMEOUT: the watch keeps running and answers once the phone finds itself.
    toast(err.code === 3 ? 'GPS пока ищет спутники. На открытом месте это до минуты; Wi-Fi ускоряет' : 'Телефон пока не знает, где он: проверьте, что геолокация включена', 5000);
  }
  updateNav();
}
function showLocationHelp(kind) {
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const chromeIOS = /CriOS/.test(ua), yandex = /YaBrowser/.test(ua);
  const url = location.href.split('#')[0];
  let title = 'Разрешите геопозицию', lead = '', steps = [];
  if (kind === 'unsupported') { title = 'Браузер не сообщает место'; lead = 'Откройте карту в Safari (iPhone) или Chrome (Android).'; }
  else if (kind === 'inapp') {
    title = iOS ? 'Откройте карту в Safari' : 'Откройте карту в браузере';
    lead = 'Ссылка открылась внутри Telegram или другого приложения. Его встроенный браузер почти никогда не даёт сайтам геопозицию — навигатор к точке там не заработает.';
    steps = iOS
      ? ['Нажмите «Открыть в Safari» ниже.', 'Не открылось — нажмите «⋯» или значок компаса в углу экрана и выберите «Открыть в Safari».', 'В Safari нажмите «Поделиться» → «На экран „Домой“» — карта будет открываться как приложение.']
      : ['Нажмите «⋮» в углу экрана → «Открыть в браузере» (или «в Chrome»).'];
  } else if (iOS) {
    lead = 'iPhone не пускает этот сайт к геопозиции. Проверьте по порядку:';
    steps = [
      '<b>Настройки → Конфиденциальность и безопасность → Службы геолокации</b> — включены.',
      `Там же ниже: <b>${chromeIOS ? 'Chrome' : yandex ? 'Яндекс Браузер' : 'Сайты Safari'}</b> → «При использовании приложения» и включите <b>«Точная геопозиция»</b>.`,
      'В Safari слева в адресной строке нажмите <b>«аА»</b> (или значок ⚙︎) → <b>«Настройки веб-сайта»</b> → <b>Геопозиция → «Разрешить»</b>.',
      'Вернитесь сюда и нажмите «Попробовать ещё раз». Если снова тихо — закройте вкладку и откройте карту заново.',
    ];
  } else {
    lead = 'Браузер не пускает этот сайт к геопозиции:';
    steps = [
      'Нажмите на значок замка слева от адреса → <b>Разрешения → Геоданные → Разрешить</b>.',
      '<b>Настройки → Местоположение</b> телефона — включено; для браузера — «Разрешить во время использования» и «Точное местоположение».',
      'Вернитесь и нажмите «Попробовать ещё раз».',
    ];
  }
  state.tab = 'help';
  $$('#tabs button').forEach((b) => b.classList.remove('active'));
  $('#sheetBody').innerHTML = `<h2>${esc(title)}</h2>${lead ? `<p>${esc(lead)}</p>` : ''}
    ${steps.length ? `<ol class="small" style="padding-left:18px">${steps.map((x) => `<li style="margin:6px 0">${x}</li>`).join('')}</ol>` : ''}
    <div class="btns">
      ${kind === 'inapp' && iOS ? `<a class="btn" href="x-safari-${esc(url)}">Открыть в Safari</a>` : ''}
      <button type="button" class="btn ${kind === 'inapp' ? 'ghost' : ''}" data-act="copy-link">Скопировать ссылку</button>
      ${kind !== 'unsupported' ? '<button type="button" class="btn ghost" data-act="locate-retry">Попробовать ещё раз</button>' : ''}
    </div>
    <p class="small muted">Без геопозиции карта, точки, фильтры и выгрузка GPX работают — не работают только «где я» и «вести к точке». Для навигации на воде GPX можно открыть в ActiveCaptain, Navionics или OsmAnd (вкладка «Глубины»).</p>`;
  $('#sheetBody').scrollTop = 0;
  setSheet('full');
}
$('#btnLocate').addEventListener('click', () => {
  if (state.watchId != null && !state.nav && state.me) {
    const c = map.getCenter();
    if (distM({ lat: c.lat, lon: c.lng }, state.me) < 50) { stopWatch(); toast('Геопозиция выключена'); return; }
  }
  startWatch(true);
});

function startNav(target) {
  state.nav = target; state.arrived = false; state.follow = true;
  store.set('ladoga-nav', target);
  document.body.classList.add('navigating');
  $('#navHud').hidden = false;
  $('#navTitle').textContent = `К точке: ${target.title}`;
  $('#navCenter').classList.add('on');
  layers.nav.clearLayers();
  navLine.addTo(layers.nav); navTarget.setLatLng([target.lat, target.lon]).addTo(layers.nav);
  setSheet('peek');
  startWatch(false);
  updateNav();
  if (!state.me) map.setView([target.lat, target.lon], Math.max(map.getZoom(), 12));
  requestWakeLock();
}
function stopNav() {
  state.nav = null;
  store.set('ladoga-nav', null);
  document.body.classList.remove('navigating');
  $('#navHud').hidden = true;
  layers.nav.clearLayers();
  releaseWakeLock();
}
function updateNav() {
  if (!state.nav) return;
  const t = state.nav;
  if (!state.me) {
    $('#navDist').textContent = '—';
    $('#navSub').innerHTML = state.geoError === 1 ? 'Геопозиция запрещена — <a href="#" id="navHelp" style="color:#4cc0dc">как включить</a>' : 'Жду GPS… разрешите геопозицию, если спросит';
    $('#navHelp')?.addEventListener('click', (e) => { e.preventDefault(); showLocationHelp(inAppBrowser() ? 'inapp' : 'denied'); });
    return;
  }
  const d = distM(state.me, t), b = bearing(state.me, t);
  navLine.setLatLngs([[state.me.lat, state.me.lon], [t.lat, t.lon]]);
  const moving = state.me.speed != null && state.me.speed > 0.8;
  const heading = state.compassOn && state.compassHeading != null ? state.compassHeading : (moving && state.me.heading != null && !Number.isNaN(state.me.heading) ? state.me.heading : null);
  const arrow = $('#navArrow');
  arrow.classList.toggle('north', heading == null);
  arrow.querySelector('svg').style.transform = `rotate(${Math.round(heading == null ? b : b - heading)}deg)`;
  $('#navDist').textContent = fmtDist(d);
  const parts = [`курс ${Math.round(b)}° ${rumb(b)}`];
  if (moving) {
    const kmh = state.me.speed * 3.6;
    parts.push(`${kmh.toFixed(kmh < 10 ? 1 : 0).replace('.', ',')} км/ч`);
    const min = d / state.me.speed / 60;
    parts.push(`≈ ${min < 60 ? `${Math.max(1, Math.round(min))} мин` : `${(min / 60).toFixed(1).replace('.', ',')} ч`}`);
  }
  parts.push(`GPS ±${Math.round(state.me.acc || 0)} м`);
  if (heading == null) parts.push('стрелка: от севера');
  $('#navSub').textContent = parts.join(' · ');
  if (state.follow) {
    if (d > 150) map.fitBounds(L.latLngBounds([[state.me.lat, state.me.lon], [t.lat, t.lon]]), { ...navPadding(), maxZoom: 17, animate: false });
    else map.setView([state.me.lat, state.me.lon], 17, { animate: false });
  }
  if (d < 25 && !state.arrived) { state.arrived = true; navigator.vibrate?.([200, 100, 200]); toast('Вы на точке 🎣', 4000); }
  if (d > 60) state.arrived = false;
}
// Keep both ends of the course clear of the HUD on top and the sheet (bottom on a phone, left on a desktop).
function navPadding() {
  const hud = $('#navHud').getBoundingClientRect();
  const wide = desktopLayout();
  return { paddingTopLeft: [wide ? 430 : 40, hud.bottom + 30], paddingBottomRight: [40, wide || phoneLandscape() ? 40 : 130] };
}
map.on('dragstart', () => { if (state.nav) { state.follow = false; $('#navCenter').classList.remove('on'); } });
$('#navCenter').addEventListener('click', () => { state.follow = !state.follow; $('#navCenter').classList.toggle('on', state.follow); updateNav(); });
$('#navStop').addEventListener('click', stopNav);
$('#navTrack').addEventListener('click', () => setTracking(!state.track.on));
$('#navMark').addEventListener('click', () => {
  if (!state.me) { toast('Ещё нет GPS'); return; }
  addMine(state.me.lat, state.me.lon, `Метка ${new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
});
$('#navCompass').addEventListener('click', async () => {
  if (state.compassOn) { state.compassOn = false; $('#navCompass').classList.remove('on'); updateNav(); return; }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') { toast('Компас не разрешён'); return; }
    }
  } catch { toast('Компас недоступен'); return; }
  state.compassOn = true;
  $('#navCompass').classList.add('on');
  toast('Держите телефон горизонтально — стрелка покажет направление на точку');
});
function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
  if (h == null) return;
  const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  state.compassHeading = (h + screenAngle + 360) % 360;
  if (state.compassOn && state.nav) {
    const now = Date.now();
    if (!onOrientation.t || now - onOrientation.t > 150) { onOrientation.t = now; updateNav(); }
  }
}
window.addEventListener('deviceorientationabsolute', onOrientation);
window.addEventListener('deviceorientation', onOrientation);

let wakeLock = null;
async function requestWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; } }
function releaseWakeLock() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.nav) requestWakeLock(); });

$('#btnLayers').addEventListener('click', () => { showTab('layers'); setSheet(desktopLayout() ? 'full' : 'half'); });

/* ---------- context layers ---------- */
function drawLines() {
  layers.lines.clearLayers();
  for (const line of state.ctx.lines || []) {
    const coords = (line.coords || []).map((p) => (Array.isArray(p) ? p : [p.lat, p.lon]));
    if (coords.length < 2) continue;
    L.polyline(coords, { color: '#ffd43b', weight: 2, opacity: 0.9, dashArray: '10 6' })
      .bindTooltip(line.name || 'Фарватер', { sticky: true }).addTo(layers.lines);
  }
}
function addExtraTileLayers() {
  for (const [i, t] of (state.ctx.tile_layers || []).entries()) {
    if (!t || !t.url || String(t.works_in_browser).toLowerCase() === 'no') continue;
    if (/arcgisonline|openstreetmap\.org|opentopomap|openseamap/i.test(t.url)) continue; // built in already
    const opts = { maxZoom: 19, maxNativeZoom: +t.max_zoom || 17, minZoom: +t.min_zoom || 0, attribution: t.attribution || '', tms: !!t.tms, subdomains: t.subdomains || 'abc', zIndex: 4 };
    const key = `extra${i}`;
    extraOverlays[key] = { name: t.name || `Слой ${i + 1}`, note: t.note || t.description || '', layer: L.tileLayer(t.url, opts) };
  }
}

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
  const names = [[0.03, 'новолуние', '🌑'], [0.22, 'растущий серп', '🌒'], [0.28, 'первая четверть', '🌓'], [0.47, 'растущая луна', '🌔'],
    [0.53, 'полнолуние', '🌕'], [0.72, 'убывающая луна', '🌖'], [0.78, 'последняя четверть', '🌗'], [0.97, 'убывающий серп', '🌘'], [1.01, 'новолуние', '🌑']];
  const [, name, icon] = names.find(([edge]) => phase < edge);
  return { name, icon, illum, age: Math.round(age) };
}
function wxPlace() { return WX_PLACES.find((p) => p.id === store.get('ladoga-wx-place', 'volkhov')) || WX_PLACES[0]; }
async function loadWeather(force = false) {
  const place = wxPlace();
  const cached = store.get(WX_KEY, null);
  if (!force && cached && cached.place === place.id && Date.now() - cached.at < 30 * 60000) { state.wx = cached; renderWxPill(); return cached; }
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
  renderWxPill();
  return state.wx;
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
      out.push({ level: 'danger', text: `Отжимной ветер ${rumb(h.wind_direction_10m[k])} ${Math.round(h.wind_speed_10m[k])} м/с (порывы ${Math.round(h.wind_gusts_10m[k])}) с ${h.time[k].slice(11, 16)}: у южного берега (Кобона, Леднево, Креницы, Сухо) может оторвать лёд. Далеко от берега не уходите, следите за трещинами.` });
    }
  } else {
    const windy = next(12).filter((k) => h.wind_speed_10m[k] >= 8 || h.wind_gusts_10m[k] >= 13);
    const waves = wx.sea?.hourly?.wave_height ? next(12).map((k) => wx.sea.hourly.wave_height[k] ?? 0) : [];
    const maxWave = waves.length ? Math.max(...waves) : 0;
    if (windy.length || maxWave >= 0.7) {
      out.push({ level: 'warn', text: `Ближайшие 12 ч: ветер до ${Math.round(Math.max(...next(12).map((k) => h.wind_gusts_10m[k])))} м/с в порывах${maxWave ? `, волна до ${maxWave.toFixed(1).replace('.', ',')} м` : ''}. В мелких губах волна короткая и крутая — на надувной лодке далеко не уходите.` });
    }
    const northStorm = next(24).filter((k) => (h.wind_direction_10m[k] >= 300 || h.wind_direction_10m[k] <= 60) && h.wind_speed_10m[k] >= 10);
    if (northStorm.length) out.push({ level: 'warn', text: 'Сильный северный ветер: нагон воды и высокая волна у южного берега, выход из устьев и каналов опасен.' });
  }
  // Pressure trend over 3 hours.
  const p0 = h.pressure_msl[i0], p3 = h.pressure_msl[Math.max(0, i0 - 3)];
  if (p0 != null && p3 != null && Math.abs(p0 - p3) >= 3) out.push({ level: 'info', text: `Давление ${p0 > p3 ? 'быстро растёт' : 'быстро падает'} (${p0 > p3 ? '+' : '−'}${Math.abs(Math.round((p0 - p3) * 0.75))} мм за 3 ч) — клёв в такие часы часто хуже.` });
  return out;
}
function renderWxPill() {
  const pill = $('#wxPill');
  const wx = state.wx;
  if (!pill || !wx?.fc?.current) return;
  const c = wx.fc.current;
  const warn = wxWarnings(wx).some((w) => w.level === 'danger');
  pill.hidden = false;
  pill.classList.toggle('danger', warn);
  pill.innerHTML = `${warn ? '⚠️ ' : ''}${windArrow(c.wind_direction_10m, 13)} ${Math.round(c.wind_speed_10m)} м/с ${rumb(c.wind_direction_10m)} · ${Math.round(c.temperature_2m)}°`;
  // The Today tab shows the same forecast.
  if (state.tab === 'today') { const b = $('#sheetBody'), top = b.scrollTop; b.innerHTML = todayHtml(); b.scrollTop = top; }
}
function weatherHtml() {
  const wx = state.wx;
  const place = wxPlace();
  const header = `<div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h2>Погода на Ладоге</h2><button type="button" class="btn small ghost" data-act="close-card">✕</button></div>
    <div class="chips">${WX_PLACES.map((p) => `<button type="button" class="chip ${p.id === place.id ? 'on' : ''}" data-wxplace="${p.id}">${esc(p.name)}</button>`).join('')}</div>`;
  if (!wx?.fc?.current) return `${header}<p class="muted">Загружаю прогноз… Нужен интернет.</p>`;
  const fc = wx.fc, c = fc.current, h = fc.hourly, i0 = wxNowIndex(fc);
  const p3 = h.pressure_msl[Math.max(0, i0 - 3)], p24 = h.pressure_msl[Math.max(0, i0 - 24)];
  const trend = (a, b) => {
    if (a == null || b == null) return '';
    const mm = Math.round((a - b) * 0.75);
    return mm === 0 ? 'без изменений' : `${mm > 0 ? '+' : '−'}${Math.abs(mm)} мм`;
  };
  const wave = wx.sea?.hourly?.wave_height?.[i0];
  const moon = moonInfo();
  const sunrise = fc.daily?.sunrise?.find((t) => t.slice(0, 10) === c.time.slice(0, 10)) || fc.daily?.sunrise?.[1];
  const sunset = fc.daily?.sunset?.find((t) => t.slice(0, 10) === c.time.slice(0, 10)) || fc.daily?.sunset?.[1];
  const warnings = wxWarnings(wx);
  const hours = Array.from({ length: 48 }, (_, k) => i0 + k).filter((k) => k < h.time.length && (k - i0) % 3 === 0);
  const age = Math.round((Date.now() - wx.at) / 60000);
  return `${header}
    ${warnings.map((w) => `<div class="card small wx-${w.level}">${w.level === 'danger' ? '⚠️ ' : w.level === 'warn' ? '🌊 ' : 'ℹ️ '}${esc(w.text)}</div>`).join('')}
    <div class="wx-now">
      <div class="wx-big">${windArrow(c.wind_direction_10m, 30)}<div><b>${Math.round(c.wind_speed_10m)} м/с</b><span>${rumb(c.wind_direction_10m)}, порывы ${Math.round(c.wind_gusts_10m)}</span></div></div>
      <div class="wx-big"><div><b>${Math.round(c.temperature_2m)}°</b><span>облачность ${Math.round(c.cloud_cover)}%</span></div></div>
    </div>
    <dl class="kv">
      <dt>Давление</dt><dd>${hPaToMm(c.pressure_msl)} мм рт. ст.; за 3 ч ${trend(h.pressure_msl[i0], p3)}, за сутки ${trend(h.pressure_msl[i0], p24)}</dd>
      ${wave != null ? `<dt>Волна</dt><dd>${String(wave.toFixed(1)).replace('.', ',')} м (модель; в губах круче, чем в открытом озере)</dd>` : ''}
      ${sunrise ? `<dt>Солнце</dt><dd>восход ${sunrise.slice(11, 16)}, закат ${sunset ? sunset.slice(11, 16) : '—'}</dd>` : ''}
      <dt>Луна</dt><dd>${moon.icon} ${moon.name}, освещена на ${moon.illum}%</dd>
    </dl>
    <h3>Ближайшие 2 суток</h3>
    <div class="wx-hours">${hours.map((k) => `<div class="wx-h ${h.wind_speed_10m[k] >= 8 ? 'windy' : ''}">
      <span class="t">${k - i0 < 24 ? '' : 'завтра '}${h.time[k].slice(11, 16)}</span>
      ${windArrow(h.wind_direction_10m[k], 16)}
      <b>${Math.round(h.wind_speed_10m[k])}</b><span class="g">${Math.round(h.wind_gusts_10m[k])}</span>
      <span>${Math.round(h.temperature_2m[k])}°</span>
      ${h.precipitation_probability?.[k] >= 30 ? `<span class="rain">💧${h.precipitation_probability[k]}%</span>` : '<span class="rain"></span>'}
    </div>`).join('')}</div>
    <p class="small muted">Ветер в м/с: крупно — средний, мелко — порывы; стрелка — куда дует. Прогноз <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>, обновлён ${age < 1 ? 'только что' : `${age} мин назад`}. Отжимной для южного берега — ветер с юго-востока, юга и юго-запада.</p>
    ${(state.ctx.practical?.weather?.hazards || []).length ? `<details><summary><b>Опасная погода на Ладоге</b></summary>${state.ctx.practical.weather.hazards.map((h2) => `<div class="card small"><b>${esc(h2.title)}</b><br>${esc(h2.text)}</div>`).join('')}</details>` : ''}
    ${(state.ctx.practical?.weather?.thresholds || []).length ? `<details><summary><b>Цифры: ветер, волна, лёд</b></summary><table class="rules-table">${state.ctx.practical.weather.thresholds.map((t2) => `<tr><td>${esc(t2.what)}</td><td>${esc(t2.value)}</td></tr>`).join('')}</table></details>` : ''}
    <div class="btns"><button type="button" class="btn small ghost" data-act="wx-refresh">Обновить</button></div>`;
}
function openWeather() {
  state.tab = 'weather';
  $$('#tabs button').forEach((b) => b.classList.remove('active'));
  $('#sheetBody').innerHTML = weatherHtml();
  $('#sheetBody').scrollTop = 0;
  setSheet(desktopLayout() ? 'full' : 'full');
  if (!state.wx) loadWeather().then(() => { if (state.tab === 'weather') $('#sheetBody').innerHTML = weatherHtml(); });
}
$('#wxPill').addEventListener('click', openWeather);

/* ---------- track: where the boat or the walk on the ice went, saved on the phone ---------- */
const TRACK_KEY = 'ladoga-track-v1';
state.track = store.get(TRACK_KEY, { on: false, pts: [] });
const trackLine = L.polyline(state.track.pts.map((p) => [p[0], p[1]]), { color: '#ffd43b', weight: 3, opacity: 0.9, interactive: false });
function trackLength(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += distM({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] });
  return m;
}
function drawTrack() {
  trackLine.setLatLngs(state.track.pts.map((p) => [p[0], p[1]]));
  if (state.track.pts.length && !map.hasLayer(trackLine)) trackLine.addTo(map);
  const btn = $('#navTrack');
  if (btn) { btn.classList.toggle('on', state.track.on); btn.textContent = state.track.on ? '⏹ Трек' : '⏺ Трек'; }
}
function setTracking(on) {
  state.track.on = on;
  store.set(TRACK_KEY, state.track);
  if (on) { startWatch(false); requestWakeLock(); toast('Пишу трек. Держите карту открытой — телефон не пишет трек из фона.', 4500); }
  else toast(`Трек остановлен: ${fmtDist(trackLength(state.track.pts))}`);
  drawTrack();
}
function addTrackPoint(me) {
  if (!state.track.on || !me || me.acc > 60) return;
  const last = state.track.pts[state.track.pts.length - 1];
  if (last && distM({ lat: last[0], lon: last[1] }, me) < 12) return;
  state.track.pts.push([+me.lat.toFixed(6), +me.lon.toFixed(6), Date.now()]);
  if (state.track.pts.length % 5 === 0) store.set(TRACK_KEY, state.track);
  drawTrack();
}
function trackGpx() {
  const pts = state.track.pts;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ladoga-fishing-map" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>Ладога ${new Date(pts[0]?.[2] || Date.now()).toLocaleDateString('ru-RU')}</name><trkseg>\n${pts.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`).join('\n')}\n</trkseg></trk>\n</gpx>\n`;
}

/* ---------- offline: save the satellite map of the visible area into the phone ---------- */
const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
function tilesFor(bounds, z0, z1) {
  const out = [];
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => { const r = toRad(lat); return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
  for (let z = z0; z <= z1; z++) {
    const x0 = lon2x(bounds.getWest(), z), x1 = lon2x(bounds.getEast(), z);
    const y0 = lat2y(bounds.getNorth(), z), y1 = lat2y(bounds.getSouth(), z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y });
  }
  return out;
}
async function downloadOffline(el) {
  if (!('caches' in window)) { toast('Этот браузер не умеет хранить карту без сети'); return; }
  const z0 = Math.max(9, map.getZoom());
  const z1 = Math.min(16, z0 + 3);
  const tiles = tilesFor(map.getBounds(), z0, z1);
  const urls = [];
  for (const t of tiles) urls.push(L.Util.template(SAT_URL, t));
  for (const t of tiles.filter((t) => t.z <= 14)) urls.push(L.Util.template(LABELS_URL, t));
  // Our own layers: the old army maps, the model isobaths and the data.
  for (const o of state.ctx.depth?.overlays || []) urls.push(new URL(o.url, location.href).href);
  if (state.ctx.depth?.isobaths) urls.push(new URL(state.ctx.depth.isobaths, location.href).href);
  if (tiles.length > 2600) { toast(`Слишком большой район (${tiles.length} фрагментов). Приблизьте карту к месту рыбалки.`, 5000); return; }
  const mb = Math.round((tiles.length * 30) / 1024);
  if (!window.confirm(`Сохранить в телефон спутниковую карту видимого района (приближения ${z0}–${z1}, около ${mb} МБ)? Нужен Wi‑Fi или быстрый интернет.`)) return;
  const cache = await caches.open('ladoga-tiles-v1');
  let done = 0, failed = 0, i = 0;
  const status = () => { el.textContent = `Сохраняю… ${Math.round(((done + failed) / urls.length) * 100)}%`; };
  const worker = async () => {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        const same = url.startsWith(location.origin);
        const res = await fetch(url, same ? {} : { mode: 'cors' });
        if (res.ok) { await cache.put(url, res); done += 1; } else failed += 1;
      } catch { failed += 1; }
      if ((done + failed) % 20 === 0) status();
    }
  };
  status();
  await Promise.all(Array.from({ length: 6 }, worker));
  el.textContent = '📥 Сохранить карту этого района';
  toast(failed ? `Сохранено ${done} из ${urls.length}; часть не скачалась — попробуйте ещё раз` : `Готово: карта района сохранена (${done} фрагментов). Она откроется и без интернета.`, 6000);
  store.set('ladoga-offline-at', Date.now());
}

/* ---------- SOS: phones, where I am in words a rescuer can take down, what to do on a drifting floe ---------- */
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
function openSos() {
  const pr = state.ctx.practical || {};
  const em = pr.emergency || {};
  const phones = em.phones || [{ name: 'Единый номер экстренных служб', phone: '112' }];
  const me = state.me;
  const from = me || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const rescue = nearestServices(from, ['rescue'], 3);
  const hosp = nearestServices(from, ['hospital'], 3);
  state.tab = 'sos';
  $$('#tabs button').forEach((b) => b.classList.remove('active'));
  $('#sheetBody').innerHTML = `
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h2>🆘 Экстренная помощь</h2><button type="button" class="btn small ghost" data-act="close-card">✕</button></div>
    <a class="btn sos-call" href="tel:112">📞 Позвонить 112</a>
    <p class="small muted">112 работает без SIM-карты и без денег на счёте, через любую сеть, которая ловит.</p>
    <div class="card">
      <b>Где я — продиктуйте спасателям</b>
      ${me ? `<div class="coord" style="font-size:16px;margin-top:4px">${fmtDM(me.lat, me.lon)}</div>
        <div class="coord">${fmtDec(me.lat, me.lon)} · точность ±${Math.round(me.acc || 0)} м</div>
        <div class="small"><b>${esc(sectorName(me))}</b>; до Новой Ладоги ${fmtDist(distM(me, { lat: 60.1037, lon: 32.294 }))}</div>
        <div class="btns" style="margin-bottom:0"><button type="button" class="btn small" data-act="sos-copy">Скопировать</button><button type="button" class="btn small ghost" data-act="sos-share">Отправить координаты</button></div>`
      : `<p class="small">Геопозиция не включена.</p><div class="btns" style="margin-bottom:0"><button type="button" class="btn small" data-act="sos-locate">📍 Определить, где я</button></div>`}
    </div>
    <h3>Телефоны</h3>
    ${phones.map((p) => `<a class="phone-row" href="${esc(telHref(p.phone))}"><b>${esc(p.phone)}</b><span>${esc(p.name || '')}</span></a>`).join('')}
    ${(em.what_to_do || []).length ? `<h3>Что делать</h3>${em.what_to_do.map((w, i) => `<details class="card small" ${i === 0 ? 'open' : ''}><summary><b>${esc(w.title)}</b></summary><p>${esc(w.text)}</p></details>`).join('')}` : ''}
    ${rescue.length ? `<h3>Спасатели рядом</h3>${rescue.map((s) => `<div class="card small"><b>${esc(s.title)}</b> · ${fmtDist(s.d)}<br>${esc(s.comment)}<div class="btns" style="margin-bottom:0"><a class="btn small ghost" href="${esc(yandexRoute(s))}" target="_blank" rel="noopener">🚗 Маршрут</a></div></div>`).join('')}` : ''}
    ${hosp.length ? `<h3>Больницы</h3>${hosp.map((s) => `<div class="card small"><b>${esc(s.title)}</b> · ${fmtDist(s.d)}<br>${esc(s.comment)}<div class="btns" style="margin-bottom:0"><a class="btn small ghost" href="${esc(yandexRoute(s))}" target="_blank" rel="noopener">🚗 Маршрут</a></div></div>`).join('')}` : ''}
    ${(pr.coverage || []).length ? `<h3>Связь на воде</h3>${pr.coverage.map((c) => `<p class="small"><b>${esc(c.operator)}</b>: ${esc(c.note)}</p>`).join('')}` : ''}`;
  $('#sheetBody').scrollTop = 0;
  setSheet('full');
}
// "3,2 км к СЗ от о. Птинов" — the way a rescuer on the phone can find a place on their own map.
function sectorName(p) {
  const places = PLACES.concat([['Сясьстрой', 60.14, 32.56], ['Лаврово', 59.96, 31.52], ['Леднево', 60.1, 31.53], ['Кареджи', 60.12, 31.39], ['Осиновец', 60.12, 31.07], ['Свирица', 60.47, 32.9], ['Сторожно', 60.53, 32.62]]);
  let best = null;
  for (const [name, lat, lon] of places) { const d = distM({ lat, lon }, p); if (!best || d < best.d) best = { d, name, lat, lon }; }
  if (!best) return '';
  if (best.d < 400) return `у места «${best.name}»`;
  return `${fmtDist(best.d)} к ${rumb(bearing(best, p))} от «${best.name}»`;
}
$('#btnSos').addEventListener('click', openSos);

/* ---------- install on the phone, as the fuel app does ---------- */
let installPrompt = null;
function showInstallHelp() {
  const { iOS, inApp } = platformInfo();
  const url = location.href.split('#')[0].split('?')[0];
  const steps = inApp
    ? [iOS ? 'Нажмите «Открыть в Safari». Не открылось — скопируйте ссылку и вставьте её в адресную строку <b>Safari</b>.' : 'Нажмите «⋮» в углу экрана → «Открыть в браузере» (Chrome).',
       iOS ? 'В Safari нажмите «Поделиться» — квадрат со стрелкой вверх внизу экрана.' : 'В Chrome откройте меню «⋮».',
       iOS ? 'Выберите <b>«На экран „Домой“»</b> и нажмите «Добавить».' : 'Выберите <b>«Установить приложение»</b> или «Добавить на главный экран».']
    : iOS
      ? ['Нажмите «Поделиться» — квадрат со стрелкой вверх внизу экрана (в Safari).',
         'Прокрутите список и выберите <b>«На экран „Домой“»</b>.',
         'Нажмите «Добавить». Иконка «Ладога» появится на экране как обычное приложение.']
      : ['Откройте меню браузера (три точки ⋮).',
         'Выберите <b>«Установить приложение»</b> или «Добавить на главный экран».',
         'Подтвердите установку.'];
  state.tab = 'install';
  $$('#tabs button').forEach((b) => b.classList.remove('active'));
  $('#sheetBody').innerHTML = `
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h2>Установить на телефон</h2><button type="button" class="btn small ghost" data-act="close-card">✕</button></div>
    <p class="small">После установки карта открывается с иконки без адресной строки, на весь экран. Точки, справочники и просмотренные участки карты работают и без интернета — на воде это важно.</p>
    ${inApp ? '<div class="card small"><b>Сейчас открыто не в браузере.</b> Это встроенный браузер Telegram или другого приложения: в нём нет пункта «На экран „Домой“» и не работает геопозиция. Нужен Safari (iPhone) или Chrome (Android).</div>' : ''}
    <ol class="install-steps small">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>
    <div class="btns">
      ${inApp && iOS ? `<a class="btn" href="x-safari-${esc(url)}">Открыть в Safari</a>` : ''}
      <button type="button" class="btn ${inApp && iOS ? 'ghost' : ''}" data-act="copy-link">Скопировать ссылку</button>
    </div>`;
  $('#sheetBody').scrollTop = 0;
  setSheet('full');
}
(() => {
  const btn = $('#installButton');
  const { installed, inApp } = platformInfo();
  // iOS Safari never fires beforeinstallprompt, so the button stays visible everywhere
  // except inside an already installed window.
  btn.hidden = installed;
  if (inApp) btn.textContent = 'Открыть в браузере';
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; btn.hidden = false; });
  window.addEventListener('appinstalled', () => { installPrompt = null; btn.hidden = true; toast('Установлено — ищите иконку «Ладога»'); });
  btn.addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      return;
    }
    showInstallHelp();
  });
})();

/* ---------- first-visit hint ---------- */
function closeHint() { $('#hint').hidden = true; store.set('ladoga-hint-v1', true); }
$('#hintOk').addEventListener('click', closeHint);
$('[data-hint-legend]').addEventListener('click', () => { closeHint(); handleAction('hint-legend'); });

/* ---------- boot ---------- */
async function boot() {
  setBase(state.base);
  let points, ctx;
  try {
    [points, ctx] = await Promise.all([
      fetch('data/points.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('data/context.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({})),
    ]);
  } catch {
    $('#counter').textContent = 'не удалось загрузить данные';
    return;
  }
  state.R = points.reports; state.M = points.markers; state.meta = points; state.ctx = ctx || {};
  addExtraTileLayers();
  buildDepthLayers();
  applyOverlays();
  drawLines(); drawMine(); drawRules(); drawSeasonZones();
  render();
  showTab('today');
  const m = location.hash.match(/pt=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) {
    const p = { lat: +m[1], lon: +m[2] };
    let best = -1, bd = Infinity;
    state.M.forEach((x, i) => { const d = distM(p, x); if (d < bd) { bd = d; best = i; } });
    if (best >= 0 && bd < 60) { map.setView([state.M[best].lat, state.M[best].lon], 14); openPoint(best); }
    else {
      map.setView([p.lat, p.lon], 14);
      const shared = { id: 'link', lat: p.lat, lon: p.lon, name: 'Точка по ссылке', link: true };
      L.marker([p.lat, p.lon]).on('click', () => openMineCard(shared)).addTo(layers.select);
      openMineCard(shared);
    }
  }
  if (!store.get('ladoga-hint-v1', false)) $('#hint').hidden = false;
  drawTrack();
  if (state.track.on) startWatch(false);
  loadWeather();
  setInterval(() => loadWeather(), 30 * 60000);
  const resume = store.get('ladoga-nav', null);
  if (resume && resume.lat) startNav(resume);
}
boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
