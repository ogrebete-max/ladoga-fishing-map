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
};
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
  tab: 'filter',
  seasonMonth: new Date().getMonth() + 1,
  selected: null,
  me: null, watchId: null, follow: false, centerOnFix: false,
  compassHeading: null, compassOn: false,
  nav: null, arrived: false,
  fav: new Set(store.get('ladoga-fav', [])),
  mine: store.get('ladoga-mine', []),
  base: store.get('ladoga-base', 'sat'),
  overlays: Object.assign({ seamarks: false, heat: false, cluster: true, radius: false, seasonZones: false, rules: false, lines: true, mine: true }, store.get('ladoga-overlays', {})),
  overlayOpacity: store.get('ladoga-overlay-opacity', 0.7),
};

function defaultFilters() {
  return { fish: new Set(), months: new Set(), season: 'all', cls: new Set(['A', 'B', 'C']), kinds: new Set(Object.keys(KINDS)), sources: new Set(), core: false, yearMin: 0, fav: false };
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
  return true;
}

function markerIcon(m, rs) {
  const kind = m.kind;
  if (!CATCH_KINDS.has(kind)) {
    const glyph = { launch: '⚓', ice_incident: '!', hazard: '' }[kind] ?? '';
    return L.divIcon({ className: '', html: `<div class="shape ${kind}">${glyph}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
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
  body.innerHTML = ({ filter: filterHtml, season: seasonHtml, fish: fishHtml, rules: rulesHtml, layers: layersHtml, data: dataHtml }[tab] || (() => ''))();
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
    <h3>Перейти</h3>
    <div class="chips">${PLACES.map((p, i) => `<button type="button" class="chip" data-place="${i}">${esc(p[0])}</button>`).join('')}</div>
    <h3>Рыба</h3>
    <div class="chips">${fish.map(([name, n]) => `<button type="button" class="chip ${f.fish.has(name) ? 'on' : ''}" data-fish="${esc(name)}"><span class="dot" style="background:${FISH_COLORS[name] || OTHER_COLOR}"></span>${esc(name)} <span class="n">${n}</span></button>`).join('')}</div>
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
function kindSwatch(k) {
  if (CATCH_KINDS.has(k)) return `<span class="pin ${k === 'observation' ? 'obs' : ''}" style="display:inline-block;width:12px;height:12px;${k === 'observation' ? 'border-color:#2f9e44' : 'background:#2f9e44'}"></span>`;
  return `<span class="shape ${k}" style="display:inline-grid;width:12px;height:12px;font-size:8px">${k === 'launch' ? '⚓' : k === 'ice_incident' ? '!' : ''}</span>`;
}
function refreshCounts() { /* counts are static per dataset; the counter in the top bar shows the filtered total */ }

$('#sheetBody').addEventListener('click', (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;
  const f = state.f;
  const toggleSet = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));
  if (d.place != null) { const p = PLACES[+d.place]; map.setView([p[1], p[2]], p[3]); if (window.innerWidth < 900) setSheet('peek'); return; }
  if (d.fish) { toggleSet(f.fish, d.fish); t.classList.toggle('on'); render(); return; }
  if (d.month) { toggleSet(f.months, +d.month); t.classList.toggle('on'); render(); return; }
  if (d.season) { f.season = d.season; $$('#seasonSeg button').forEach((b) => b.classList.toggle('on', b === t)); render(); return; }
  if (d.src) { toggleSet(f.sources, d.src); t.classList.toggle('on'); render(); return; }
  if (t.id === 'thisMonth') { f.months = new Set([new Date().getMonth() + 1]); render(); showTab('filter'); return; }
  if (t.id === 'resetFilters') { state.f = defaultFilters(); render(); showTab('filter'); return; }
  if (d.smonth) { state.seasonMonth = +d.smonth; showTab('season'); drawSeasonZones(); return; }
  if (d.act) handleAction(d.act, t);
});
$('#sheetBody').addEventListener('change', (e) => {
  const t = e.target, f = state.f;
  if (t.dataset.kind) { t.checked ? f.kinds.add(t.dataset.kind) : f.kinds.delete(t.dataset.kind); render(); }
  else if (t.dataset.cls) { t.checked ? f.cls.add(t.dataset.cls) : f.cls.delete(t.dataset.cls); render(); }
  else if (t.id === 'coreOnly') { f.core = t.checked; render(); }
  else if (t.id === 'favOnly') { f.fav = t.checked; render(); }
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
  setSheet(window.innerWidth < 900 ? 'half' : 'full');
  updatePointFromMe();
  history.replaceState(null, '', `#pt=${m.lat.toFixed(5)},${m.lon.toFixed(5)}`);
}
function reportHtml(r, ok) {
  const extra = [r.depth && `глубина ${r.depth}`, r.method && r.method, r.catch && `улов: ${r.catch}`].filter(Boolean).join(' · ');
  const links = [safeUrl(r.url) && `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.src)}</a>`, safeUrl(r.orig) && `<a href="${esc(r.orig)}" target="_blank" rel="noopener">первоисточник</a>`].filter(Boolean).join(' · ') || esc(r.src);
  return `<div class="report ${ok ? '' : 'dim'}">
    <div><b>${esc((r.fish || []).join(', ') || r.title || KINDS[r.kind].short)}</b> · ${esc(fmtDate(r.date))}${r.season ? ` · ${r.season === 'ice' ? '❄ лёд' : '🌊 вода'}` : ''} <span class="badge ${r.cls}" title="${esc(CLASS_TEXT[r.cls])}">${r.cls}</span></div>
    ${r.title && (r.fish || []).length ? `<div class="small">${esc(r.title)}</div>` : ''}
    ${r.comment ? `<div>${esc(r.comment)}</div>` : ''}
    ${extra ? `<div class="small">${esc(extra)}</div>` : ''}
    <div class="meta">${links}${r.prec ? ` · точность ±${r.prec} м` : ''}${r.raw ? ` · в источнике: <span class="coord">${esc(r.raw)}</span>` : ''}</div>
  </div>`;
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
  else if (act === 'mine-nav') { const p = state.mine.find((x) => x.id === el.dataset.id); if (p) startNav({ lat: p.lat, lon: p.lon, title: p.name }); }
  else if (act === 'mine-del') { state.mine = state.mine.filter((x) => x.id !== el.dataset.id); store.set('ladoga-mine', state.mine); drawMine(); showTab('data'); }
  else if (act === 'show-zone') showZone(el.dataset.zone);
  else if (act === 'filter-fish') { state.f.fish = new Set([el.dataset.name]); render(); toast(`На карте: ${el.dataset.name}`); if (window.innerWidth < 900) setSheet('peek'); }
  else if (act === 'month-filter') { state.f.months = new Set([state.seasonMonth]); render(); toast(`На карте отчёты за ${MONTHS_FULL[state.seasonMonth - 1]}`); if (window.innerWidth < 900) setSheet('peek'); }
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
function seasonHtml() {
  const mo = state.seasonMonth;
  const sp = speciesList();
  const hydro = (state.ctx.hydro_calendar || []).find((h) => +h.month === mo || String(h.month).toLowerCase().startsWith(MONTHS_FULL[mo - 1].slice(0, 3)));
  const catchR = state.R.filter((r) => CATCH_KINDS.has(r.kind) && state.pass[state.R.indexOf(r)] !== undefined);
  const byMonth = Array(13).fill(0);
  const fishInMonth = new Map();
  for (const r of state.R) {
    if (!CATCH_KINDS.has(r.kind)) continue;
    const mm = monthOf(r);
    byMonth[mm] += 1;
    if (mm === mo) for (const x of r.fish || []) fishInMonth.set(x, (fishInMonth.get(x) || 0) + 1);
  }
  const max = Math.max(1, ...byMonth.slice(1));
  const ranked = sp.map((s) => ({ s, v: +(s.activity_by_month || [])[mo - 1] || 0 })).sort((a, b) => b.v - a.v);
  const isIce = hydro ? /лёд|лед|ледостав/i.test(String(hydro.ice || '')) && !/нет|чист/i.test(String(hydro.ice || '')) : [12, 1, 2, 3].includes(mo);
  return `
    <div class="months" style="margin-top:6px">${MONTHS.map((m, i) => `<button type="button" class="chip ${mo === i + 1 ? 'on' : ''}" data-smonth="${i + 1}">${m}</button>`).join('')}</div>
    <h2>Ладога в ${MONTHS_IN[mo - 1]}</h2>
    ${hydro ? `<div class="card">${hydro.events ? `<p>${esc(hydro.events)}</p>` : ''}<dl class="kv">${hydro.ice ? `<dt>Лёд</dt><dd>${esc(hydro.ice)}</dd>` : ''}${hydro.water_temp_c != null && hydro.water_temp_c !== '' ? `<dt>Вода</dt><dd>${esc(hydro.water_temp_c)} °C</dd>` : ''}</dl></div>` : ''}
    <h3>Что ловится ${sp.length ? '(по литературе и практике)' : ''}</h3>
    ${sp.length ? ranked.map(({ s, v }) => `<div class="card" style="${v ? '' : 'opacity:.6'}">
        <h4><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${FISH_COLORS[s.name_ru] || OTHER_COLOR}"></span> ${esc(s.name_ru)} <span class="muted small">${'●'.repeat(v)}${'○'.repeat(3 - v)} ${['не ловится / запрет', 'слабо', 'хорошо', 'пик'][v]}</span></h4>
        ${methodFor(s, isIce) ? `<div class="small">${esc(methodFor(s, isIce))}</div>` : ''}
        ${zonesFor(s, mo).map((z) => `<div class="small muted">📍 ${esc(z.name || '')}${z.note ? ` — ${esc(z.note)}` : ''}</div>`).join('')}
      </div>`).join('') : '<p class="muted">Справка по видам ещё собирается — обновится в следующей версии данных.</p>'}
    <h3>Отчёты по месяцам (все годы)</h3>
    <div class="bars">${byMonth.slice(1).map((n, i) => `<div class="${i + 1 === mo ? 'cur' : ''}" style="height:${Math.round((n / max) * 100)}%" title="${MONTHS_FULL[i]}: ${n}"></div>`).join('')}</div>
    <div class="bars-labels">${MONTHS.map((m) => `<span>${m}</span>`).join('')}</div>
    <p class="small">${fishInMonth.size ? `В ${MONTHS_IN[mo - 1]} чаще всего сообщали: ${[...fishInMonth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, n]) => `${f} (${n})`).join(', ')}.` : `Отчётов за ${MONTHS_FULL[mo - 1]} пока нет.`}</p>
    <div class="btns">
      <button type="button" class="btn" data-act="month-filter">Показать отчёты за ${MONTHS_FULL[mo - 1]}</button>
    </div>
    <label class="check"><input type="checkbox" data-overlay="seasonZones" ${state.overlays.seasonZones ? 'checked' : ''}> Рисовать на карте зоны, где рыба держится в ${MONTHS_IN[mo - 1]}</label>
    ${sp.length ? `<h3>Календарь: когда ловится</h3>${calendarTable(sp, mo)}<p class="small muted">0 — запрет или почти не ловится, 1 — слабо, 2 — хорошо, 3 — пик. Обобщение по научным работам и отчётам рыболовов, конкретный год может сдвигаться на 2–3 недели.</p>` : ''}`;
}
function methodFor(s, ice) {
  const bm = s.best_methods || {};
  return (ice ? bm.ice : bm.open_water) || '';
}
function zonesFor(s, mo) {
  return (s.zones || []).filter((z) => !z.months || !z.months.length || z.months.map(Number).includes(mo));
}
function calendarTable(sp, mo) {
  return `<table class="cal"><tr><th></th>${MONTHS.map((m, i) => `<th class="${i + 1 === mo ? 'cur' : ''}">${m[0].toUpperCase()}</th>`).join('')}</tr>
    ${sp.map((s) => `<tr><td>${esc(s.name_ru)}</td>${Array.from({ length: 12 }, (_, i) => { const v = +(s.activity_by_month || [])[i] || 0; return `<td class="c v${v} ${i + 1 === mo ? 'cur' : ''}" title="${esc(s.name_ru)}, ${MONTHS_FULL[i]}: ${v}">${v || ''}</td>`; }).join('')}</tr>`).join('')}
  </table>`;
}
function zoneLayer(z, color, label) {
  const style = { color, weight: 2, fillOpacity: 0.12, dashArray: '4 6' };
  let layer = null;
  const poly = z.polygon || z.coords;
  if (Array.isArray(poly) && poly.length > 2) layer = L.polygon(poly.map((p) => (Array.isArray(p) ? p : [p.lat, p.lon])), style);
  else if (z.lat != null && z.lon != null) layer = L.circle([+z.lat, +z.lon], { ...style, radius: (+z.radius_km || 1) * 1000 });
  if (layer) layer.bindTooltip(label, { sticky: true }).bindPopup(`<b>${esc(label)}</b>${z.note ? `<br>${esc(z.note)}` : ''}${safeUrl(z.source_url) ? `<br><a href="${esc(z.source_url)}" target="_blank" rel="noopener">источник</a>` : ''}`);
  return layer;
}
function drawSeasonZones() {
  layers.seasonZones.clearLayers();
  if (!state.overlays.seasonZones) return;
  const mo = state.seasonMonth;
  for (const s of speciesList()) {
    if (state.f.fish.size && !state.f.fish.has(s.name_ru)) continue;
    for (const z of zonesFor(s, mo)) {
      const l = zoneLayer(z, FISH_COLORS[s.name_ru] || OTHER_COLOR, `${s.name_ru}: ${z.name || ''}`);
      if (l) l.addTo(layers.seasonZones);
    }
  }
  for (const z of state.ctx.season_zones || []) {
    if (z.months && z.months.length && !z.months.map(Number).includes(mo)) continue;
    const l = zoneLayer(z, '#fab005', z.name || 'Сезонная зона');
    if (l) l.addTo(layers.seasonZones);
  }
}
function showZone(id) {
  const [si, zi] = id.split(':').map(Number);
  const s = speciesList()[si];
  const z = s?.zones?.[zi];
  if (!z) return;
  const l = zoneLayer(z, FISH_COLORS[s.name_ru] || OTHER_COLOR, `${s.name_ru}: ${z.name || ''}`);
  if (!l) return;
  layers.seasonZones.clearLayers();
  l.addTo(layers.seasonZones);
  state.overlays.seasonZones = true; applyOverlays();
  map.fitBounds(l.getBounds(), { padding: [40, 40], maxZoom: 13 });
  if (window.innerWidth < 900) setSheet('peek');
}

/* ----- Fish tab ----- */
function fishHtml() {
  const sp = speciesList();
  if (!sp.length) return '<p class="muted">Справка по видам ещё собирается.</p>';
  const mo = new Date().getMonth() + 1;
  return `<p class="small muted">Где держится, когда нерест и как ловить. Кнопка «на карте» рисует зону, «фильтр» оставляет на карте только отчёты с этой рыбой.</p>
    ${sp.map((s, si) => `<div class="card">
      <h4><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${FISH_COLORS[s.name_ru] || OTHER_COLOR}"></span> ${esc(s.name_ru)} <span class="muted small"><i>${esc(s.latin || '')}</i></span></h4>
      ${s.status ? `<div class="small"><b>Статус:</b> ${esc(s.status)}</div>` : ''}
      <div class="bars" style="height:34px">${Array.from({ length: 12 }, (_, i) => { const v = +(s.activity_by_month || [])[i] || 0; return `<div class="${i + 1 === mo ? 'cur' : ''}" style="height:${v ? v * 33 : 4}%;${v ? '' : 'opacity:.3'}"></div>`; }).join('')}</div>
      <div class="bars-labels">${MONTHS.map((m) => `<span>${m[0]}</span>`).join('')}</div>
      ${s.habitat_summary ? `<p class="small">${esc(s.habitat_summary)}</p>` : ''}
      ${s.spawning ? `<p class="small"><b>Нерест:</b> ${esc([s.spawning.months && (Array.isArray(s.spawning.months) ? s.spawning.months.map((x) => (Number.isFinite(+x) ? MONTHS_FULL[+x - 1] : x)).join(', ') : s.spawning.months), s.spawning.place, s.spawning.temp_c != null && s.spawning.temp_c !== '' ? `при ${s.spawning.temp_c} °C` : ''].filter(Boolean).join('; '))}</p>` : ''}
      ${s.migration_summary ? `<p class="small"><b>Перемещения:</b> ${esc(s.migration_summary)}</p>` : ''}
      ${s.best_methods ? `<p class="small">${s.best_methods.ice ? `<b>Со льда:</b> ${esc(s.best_methods.ice)}<br>` : ''}${s.best_methods.open_water ? `<b>По воде:</b> ${esc(s.best_methods.open_water)}` : ''}</p>` : ''}
      <div class="btns">
        <button type="button" class="btn small" data-act="filter-fish" data-name="${esc(s.name_ru)}">Фильтр: ${esc(s.name_ru)}</button>
        ${(s.zones || []).map((z, zi) => `<button type="button" class="btn small ghost" data-act="show-zone" data-zone="${si}:${zi}">📍 ${esc(z.name || 'зона')}</button>`).join('')}
      </div>
      ${(s.sources || []).length ? `<details><summary class="small">Источники (${s.sources.length})</summary>${s.sources.map((u) => (safeUrl(u) ? `<div class="small"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, '').slice(0, 70))}</a></div>` : `<div class="small">${esc(u)}</div>`)).join('')}</details>` : ''}
    </div>`).join('')}`;
}

/* ----- Rules tab ----- */
function listOf(items, fn) { return (items || []).length ? items.map(fn).join('') : ''; }
function objLine(o, keys) { return keys.map((k) => o[k]).filter((v) => v != null && v !== '').map((v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v)).join(' · '); }
function rulesHtml() {
  const g = state.ctx.regulations || {};
  const ice = state.ctx.ice_rules || [];
  const incidents = state.R.filter((r) => r.kind === 'ice_incident').length;
  if (!Object.keys(g).length && !ice.length) return '<p class="muted">Правила ещё собираются.</p>';
  return `
    <div class="card small">⚠️ Это выжимка для ориентира, а не юридический текст. Перед поездкой сверяйтесь с действующими Правилами рыболовства и сообщениями МЧС.</div>
    ${g.document ? `<p><b>${esc(g.document)}</b>${safeUrl(g.url) ? ` — <a href="${esc(g.url)}" target="_blank" rel="noopener">текст</a>` : ''}</p>` : ''}
    ${(g.amendments || []).length ? `<p class="small muted">Изменения: ${esc(g.amendments.map((a) => (typeof a === 'string' ? a : objLine(a, ['document', 'date', 'name', 'summary']))).join('; '))}</p>` : ''}
    ${(g.closed_seasons || []).length ? `<h3>Запретные сроки</h3>${listOf(g.closed_seasons, (c) => `<div class="card small"><b>${esc(c.species || 'все виды')}</b>: ${esc(c.dates || '')}${c.area ? `<br>${esc(c.area)}` : ''}${c.article ? ` <span class="muted">(${esc(c.article)})</span>` : ''}${c.note ? `<br>${esc(c.note)}` : ''}</div>`)}` : ''}
    ${(g.prohibited_areas || []).length ? `<h3>Запретные районы</h3>
      <label class="check"><input type="checkbox" data-overlay="rules" ${state.overlays.rules ? 'checked' : ''}> Показать на карте (где известны границы)</label>
      ${listOf(g.prohibited_areas, (a) => `<div class="card small"><b>${esc(a.name || '')}</b>${a.period ? ` — ${esc(a.period)}` : ''}<br>${esc(a.description || '')}${a.article ? ` <span class="muted">(${esc(a.article)})</span>` : ''}</div>`)}` : ''}
    ${(g.size_limits || []).length ? `<h3>Минимальный размер</h3><table class="cal">${listOf(g.size_limits, (s) => `<tr><td>${esc(s.species)}</td><td style="text-align:right">${esc(s.min_cm)} см</td></tr>`)}</table>` : ''}
    ${(g.bag_limits || []).length ? `<h3>Норма вылова</h3>${listOf(g.bag_limits, (b) => `<div class="small">• ${esc(typeof b === 'string' ? b : objLine(b, ['species', 'limit', 'per_day', 'note']))}</div>`)}` : ''}
    ${(g.gear_rules || []).length ? `<h3>Снасти и способы</h3>${listOf(g.gear_rules, (b) => `<div class="small">• ${esc(typeof b === 'string' ? b : objLine(b, ['rule', 'text', 'description', 'article']))}</div>`)}` : ''}
    ${ice.length ? `<h3>Лёд и безопасность</h3>${listOf(ice, (b) => `<div class="card small">${esc(typeof b === 'string' ? b : objLine(b, ['date', 'period', 'title', 'area', 'description', 'summary']))}${safeUrl(b.source_url || b.url) ? ` <a href="${esc(b.source_url || b.url)}" target="_blank" rel="noopener">источник</a>` : ''}</div>`)}` : ''}
    ${incidents ? `<p class="small">На карте ${incidents} ${plural(incidents, 'происшествие', 'происшествия', 'происшествий')} на льду (оранжевые точки): отрывы льдин, провалы — это и опасные места, и места, куда массово выходят рыбаки.</p>` : ''}`;
}
function drawRules() {
  layers.rules.clearLayers();
  if (!state.overlays.rules) return;
  for (const a of state.ctx.regulations?.prohibited_areas || []) {
    const l = zoneLayer(a, '#e03131', `Запрет: ${a.name || ''}`);
    if (l) l.addTo(layers.rules);
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
    <p class="small muted">Просмотренные участки карты сохраняются в телефоне и открываются без интернета, пока кэш не очистится.</p>`;
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
      .bindPopup(`<b>${esc(p.name)}</b><br><span class="coord">${fmtDec(p.lat, p.lon)}</span><br>${new Date(p.t).toLocaleString('ru-RU')}<br><a href="#" data-mine-nav="${esc(p.id)}">🧭 Вести сюда</a>`)
      .addTo(layers.mine);
  }
}
map.on('popupopen', (e) => {
  const a = e.popup.getElement()?.querySelector('[data-mine-nav]');
  if (a) a.addEventListener('click', (ev) => { ev.preventDefault(); const p = state.mine.find((x) => x.id === a.dataset.mineNav); if (p) { map.closePopup(); startNav({ lat: p.lat, lon: p.lon, title: p.name }); } });
});
function addMine(lat, lon, suggested) {
  const name = window.prompt('Название точки (сохранится только в этом телефоне):', suggested);
  if (name == null) return;
  state.mine.push({ id: String(Date.now()), lat: +lat.toFixed(6), lon: +lon.toFixed(6), name: name.trim() || suggested, t: Date.now() });
  store.set('ladoga-mine', state.mine);
  state.overlays.mine = true; applyOverlays();
  drawMine();
  toast('Точка сохранена');
}
map.on('contextmenu', (e) => addMine(e.latlng.lat, e.latlng.lng, `Моя точка ${new Date().toLocaleDateString('ru-RU')}`));

/* ---------- location & navigator ---------- */
const meMarker = L.marker([0, 0], { interactive: false, icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) });
const meCircle = L.circle([0, 0], { radius: 1, color: '#1c7ed6', weight: 1, fillOpacity: 0.1, interactive: false });
const navLine = L.polyline([], { color: '#fa5252', weight: 3, dashArray: '8 8', interactive: false });
const navTarget = L.marker([0, 0], { interactive: false, icon: L.divIcon({ className: '', html: '<div class="target-ring"></div>', iconSize: [34, 34], iconAnchor: [17, 17] }) });

function startWatch(center) {
  if (!navigator.geolocation) { toast('Этот браузер не сообщает геопозицию'); return; }
  state.centerOnFix = center;
  if (state.watchId != null) { if (center && state.me) map.setView([state.me.lat, state.me.lon], Math.max(map.getZoom(), 13)); return; }
  $('#btnLocate').classList.add('on');
  state.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function stopWatch() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null; state.me = null;
  layers.me.clearLayers();
  $('#btnLocate').classList.remove('on');
}
function onFix(pos) {
  const c = pos.coords;
  state.me = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed, heading: c.heading, t: pos.timestamp };
  if (!layers.me.hasLayer(meMarker)) { meMarker.addTo(layers.me); meCircle.addTo(layers.me); }
  meMarker.setLatLng([c.latitude, c.longitude]);
  meCircle.setLatLng([c.latitude, c.longitude]).setRadius(c.accuracy || 1);
  if (state.centerOnFix) { map.setView([c.latitude, c.longitude], Math.max(map.getZoom(), 13)); state.centerOnFix = false; }
  updateNav();
  updatePointFromMe();
}
function onGeoError(err) {
  if (err.code === 1) {
    stopWatch();
    const inApp = /Telegram|FBAN|FBAV|Instagram|VKClient|; wv\)/i.test(navigator.userAgent);
    toast(inApp ? 'Откройте ссылку в Safari или Chrome: встроенный браузер мессенджера не даёт геопозицию' : 'Геопозиция запрещена. Разрешите её этому сайту в настройках браузера', 6000);
  } else toast('Не удаётся определить место — жду сигнал GPS');
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
  if (!state.me) { $('#navDist').textContent = '—'; $('#navSub').textContent = 'Жду GPS… разрешите геопозицию, если спросит'; return; }
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
    if (d > 150) map.fitBounds(L.latLngBounds([[state.me.lat, state.me.lon], [t.lat, t.lon]]), { padding: [60, 60], maxZoom: 17, animate: false });
    else map.setView([state.me.lat, state.me.lon], 17, { animate: false });
  }
  if (d < 25 && !state.arrived) { state.arrived = true; navigator.vibrate?.([200, 100, 200]); toast('Вы на точке 🎣', 4000); }
  if (d > 60) state.arrived = false;
}
map.on('dragstart', () => { if (state.nav) { state.follow = false; $('#navCenter').classList.remove('on'); } });
$('#navCenter').addEventListener('click', () => { state.follow = !state.follow; $('#navCenter').classList.toggle('on', state.follow); updateNav(); });
$('#navStop').addEventListener('click', stopNav);
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

$('#btnLayers').addEventListener('click', () => { showTab('layers'); setSheet(window.innerWidth < 900 ? 'half' : 'full'); });

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
  applyOverlays();
  drawLines(); drawMine(); drawRules(); drawSeasonZones();
  render();
  showTab('filter');
  const m = location.hash.match(/pt=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) {
    const p = { lat: +m[1], lon: +m[2] };
    let best = -1, bd = Infinity;
    state.M.forEach((x, i) => { const d = distM(p, x); if (d < bd) { bd = d; best = i; } });
    if (best >= 0 && bd < 60) { map.setView([state.M[best].lat, state.M[best].lon], 14); openPoint(best); }
    else { map.setView([p.lat, p.lon], 14); L.marker([p.lat, p.lon]).addTo(layers.select).bindPopup(`Точка по ссылке<br>${fmtDec(p.lat, p.lon)}`).openPopup(); }
  }
  const resume = store.get('ladoga-nav', null);
  if (resume && resume.lat) startNav(resume);
}
boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
