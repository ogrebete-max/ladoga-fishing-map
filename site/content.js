'use strict';

/* Ладога · рыболовная карта — what the screens say: cards over the map (a point, an area, my point,
   a closed area), the section pages (Сегодня, Клёв, Правила, Моё), the sheets (layers and filter, search,
   SOS, help) and the one dispatcher for their buttons (handleAction). Layout and Back are in ui.js. */

const listRow = ({ icon = 'chevron-right', title, sub = '', attrs = '', right = '' }) =>
  `<button type="button" class="list-row" ${attrs}>${icon ? ic(icon) : ''}<span class="lr-main"><span class="lr-title">${title}</span>${sub ? `<span class="lr-sub">${sub}</span>` : ''}</span>${right}</button>`;
const cardFromMe = (p) => {
  const me = typeof geo !== 'undefined' ? geo.me : null;
  const parts = [];
  if (me) { const d = distM(me, p), b = bearing(me, p); parts.push(`<b>${fmtDist(d)}</b> от вас · ${Math.round(b)}° ${rumb(b)}`); }
  const dep = depthAt(p);
  if (dep) parts.push(`глубина ${esc(dep.text)} по карте${dep.value != null ? `, сейчас ≈ ${fmtM(Math.max(0, dep.value + levelNow()))}` : ''}`);
  return parts.length ? parts.join(' · ') : '<span class="muted">Нажмите ◎ на карте — появятся расстояние и курс от вас.</span>';
};
// Distance, course and depth in the open card follow the boat.
function updateCardLive() {
  const el = $('#cardFromMe');
  if (el && el.dataset.lat) el.innerHTML = cardFromMe({ lat: +el.dataset.lat, lon: +el.dataset.lon });
}
function onDepthReady() { updateCardLive(); if (typeof updateNavFields === 'function') updateNavFields(true); }
const fromMeLine = (p) => `<p class="fromme" id="cardFromMe" data-lat="${p.lat}" data-lon="${p.lon}">${cardFromMe(p)}</p>`;
const moreToggle = () => `<button type="button" class="more-toggle" data-act="card-more">Подробнее ${ic('keyboard-arrow-down')}</button>`;
const selectRing = (lat, lon) => {
  layers.select.clearLayers();
  L.marker([lat, lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: '<div class="target-ring"></div>', iconSize: [34, 34], iconAnchor: [17, 17] }) }).addTo(layers.select);
};

/* ---------- point card ---------- */
function pointTitle(m) {
  const rs = m.r.map((i) => state.R[i]);
  const fish = [...new Set(rs.flatMap((r) => r.fish || []))];
  return CATCH_KINDS.has(m.kind) ? (fish.length ? fish.join(', ') : 'Рыба не указана') : (rs[0].title || KINDS[m.kind].short);
}
function openPoint(idx, opts = {}) {
  const m = state.M[idx];
  if (!m) return;
  const first = state.R[m.r[0]];
  const sub = [KINDS[m.kind].short, first.sector, first.dist != null ? `${String(first.dist).replace('.', ',')} км от Новой Ладоги` : ''].filter(Boolean).join(' · ');
  openCard({
    key: `pt:${idx}`, title: pointTitle(m), sub, url: `#pt=${m.lat.toFixed(5)},${m.lon.toFixed(5)}`,
    body: () => pointBodyHtml(idx),
    focus: { lat: m.lat, lon: m.lon },
    onShow: () => { state.selected = idx; selectRing(m.lat, m.lon); },
    onClose: () => { if (state.selected === idx) state.selected = null; layers.select.clearLayers(); },
  }, opts);
}
function pointBodyHtml(idx) {
  const m = state.M[idx];
  const rs = m.r.map((i) => ({ r: state.R[i], ok: state.pass[i] }))
    .sort((a, b) => (b.ok - a.ok) || String(b.r.date || '').localeCompare(String(a.r.date || '')));
  const fav = state.fav.has(pointKey(m.lat, m.lon));
  const launch = nearestLaunch(m);
  return `${fromMeLine(m)}
    <div class="card-actions">
      <button type="button" class="btn main" data-act="nav">${ic('navigation')}Вести</button>
      <button type="button" class="tile-btn ${fav ? 'on' : ''}" data-act="fav">${ic(fav ? 'star-fill' : 'star')}<span>${fav ? 'Сохранено' : 'Сохранить'}</span></button>
      <button type="button" class="tile-btn" data-act="share">${ic('share')}<span>Поделиться</span></button>
      <button type="button" class="tile-btn" data-act="point-more">${ic('more-horiz')}<span>Ещё</span></button>
    </div>
    <div class="card">
      <div class="coord">${fmtDec(m.lat, m.lon)}</div>
      <div class="coord">${fmtDM(m.lat, m.lon)}</div>
      <div class="btns" style="margin:8px 0 0">
        <button type="button" class="btn small ghost" data-act="copy-dec">${ic('content-copy')}Копировать</button>
        <button type="button" class="btn small ghost" data-act="copy-dm">ГГ°ММ,ммм</button>
      </div>
    </div>
    ${moreToggle()}
    <h3>${rs.length} ${plural(rs.length, 'запись', 'записи', 'записей')} в этом месте</h3>
    ${rs.map(({ r, ok }) => reportHtml(r, ok)).join('')}
    ${launch ? `<p class="small muted">Ближайший спуск / гавань «${esc(launch.title)}» — ${fmtDist(launch.d)} от точки по прямой.</p>` : ''}`;
}
function reportHtml(r, ok) {
  const age = ageText(r.date), stale = !isCurrent(r);
  const extra = [r.depth && `глубина ${r.depth}`, r.method && r.method, r.catch && `улов: ${r.catch}`].filter(Boolean).join(' · ');
  const links = [safeUrl(r.url) && `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.srcd || r.src)}</a>`, safeUrl(r.orig) && `<a href="${esc(r.orig)}" target="_blank" rel="noopener">первоисточник</a>`].filter(Boolean).join(' · ') || esc(r.srcd || r.src);
  return `<div class="report ${ok ? '' : 'dim'}">
    <div><b>${esc((r.fish || []).join(', ') || r.title || KINDS[r.kind].short)}</b> · ${esc(fmtDate(r.date))}${age ? ` <span class="age ${isFresh(r) ? 'fresh' : ''}">${age}</span>` : ''}${r.season ? ` · ${r.season === 'ice' ? '❄ лёд' : '🌊 вода'}` : ''} <span class="badge ${r.cls}" title="${esc(CLASS_TEXT[r.cls])}">${r.cls}</span></div>
    ${r.title && (r.fish || []).length ? `<div class="small">${esc(r.title)}</div>` : ''}
    ${r.comment ? `<div>${esc(r.comment)}</div>` : ''}
    ${extra ? `<div class="small">${esc(extra)}</div>` : ''}
    ${r.why && (stale || r.months) ? `<div class="small ${stale ? 'stale-note' : ''}">${stale ? 'Устарело: ' : ''}${esc(r.why)}</div>` : ''}
    <div class="meta">${links}${r.prec ? ` · точность ±${r.prec} м` : ''}${r.raw ? ` · в источнике: <span class="coord">${esc(r.raw)}</span>` : ''}</div>
  </div>`;
}
// «Ещё» of a point: routes by car, other apps, GPX for a sonar, my own point here.
function openPointMenu(p, title) {
  openModal({
    title: 'Ещё',
    body: () => `
      <a class="list-row" href="${esc(yandexRoute(nearestLaunch(p) || p))}" target="_blank" rel="noopener">${ic('directions-car')}<span class="lr-main"><span class="lr-title">Доехать на машине</span><span class="lr-sub">${nearestLaunch(p) ? `до спуска «${esc(nearestLaunch(p).title)}», Яндекс Карты` : 'Яндекс Карты'}</span></span></a>
      ${listRow({ icon: 'download', title: 'GPX для эхолота / Navionics', attrs: `data-act="gpx-here" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${esc(title)}"` })}
      ${listRow({ icon: 'content-copy', title: 'Скопировать координаты', sub: fmtDM(p.lat, p.lon), attrs: `data-act="copy-text" data-text="${esc(`${fmtDM(p.lat, p.lon)} (${fmtDec(p.lat, p.lon)})`)}"` })}
      ${listRow({ icon: 'add', title: 'Поставить свою точку здесь', attrs: `data-act="new-point" data-lat="${p.lat}" data-lon="${p.lon}"` })}
      <h3>Открыть в другом приложении</h3>
      <a class="list-row" href="yandexnavi://build_route_on_map?lat_to=${p.lat}&lon_to=${p.lon}">${ic('near-me')}<span class="lr-main"><span class="lr-title">Яндекс Навигатор</span></span></a>
      <a class="list-row" href="https://yandex.ru/maps/?pt=${p.lon},${p.lat}&z=14&l=sat" target="_blank" rel="noopener">${ic('map')}<span class="lr-main"><span class="lr-title">Яндекс Карты</span></span></a>
      <a class="list-row" href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}" target="_blank" rel="noopener">${ic('map')}<span class="lr-main"><span class="lr-title">Google Карты</span></span></a>
      <a class="list-row" href="https://maps.apple.com/?ll=${p.lat},${p.lon}&q=${encodeURIComponent(title)}" target="_blank" rel="noopener">${ic('map')}<span class="lr-main"><span class="lr-title">Apple Карты</span></span></a>
      <a class="list-row" href="https://osmand.net/map?pin=${p.lat},${p.lon}#15/${p.lat}/${p.lon}" target="_blank" rel="noopener">${ic('map')}<span class="lr-main"><span class="lr-title">OsmAnd</span></span></a>
      <a class="list-row" href="geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}(${encodeURIComponent(title)})">${ic('location-on')}<span class="lr-main"><span class="lr-title">Другое приложение (geo:)</span></span></a>`,
  });
}

/* ---------- area (season zone) card ---------- */
function openZoneCard(z, opts = {}) {
  const mo = state.seasonMonth;
  const { open, closed } = zoneSpecies(z, mo);
  const st = placeStats(z);
  const src = [].concat(z.sources || [], z.source_url || []).filter(safeUrl);
  const [la, lo] = zoneAnchor(z);
  const b = zoneBounds(z);
  const isHome = state.home?.name === z.name;
  openCard({
    key: `zone:${z.id || z.name}`, title: z.name || 'Район',
    sub: [z.depth_m ? `глубины ${z.depth_m} м` : '', monthsText(z.months) ? `сезон: ${monthsText(z.months)}` : ''].filter(Boolean).join(' · '),
    focus: b ? { bounds: b } : { lat: la, lon: lo },
    body: () => `${fromMeLine({ lat: la, lon: lo })}
      <div class="card-actions">
        <button type="button" class="btn main" data-act="zone-nav" data-lat="${la}" data-lon="${lo}" data-name="${esc(z.name || 'Район')}">${ic('navigation')}Вести сюда</button>
        <button type="button" class="tile-btn" data-act="zone-full" data-zone-id="${esc(z.id || '')}">${ic('fullscreen')}<span>Весь экран</span></button>
        <button type="button" class="tile-btn ${isHome ? 'on' : ''}" data-act="set-home" data-zone-id="${esc(z.id || '')}">${ic('home')}<span>${isHome ? 'Мой район' : 'Сделать моим'}</span></button>
        <button type="button" class="tile-btn" data-act="share-here" data-lat="${la}" data-lon="${lo}" data-name="${esc(z.name || 'Район')}">${ic('share')}<span>Поделиться</span></button>
      </div>
      ${open.length ? `<p><b>В ${MONTHS_IN[mo - 1]} ловят:</b> ${open.map((s) => `${esc(shortName(s))} ${dots(activity(s, mo))}`).join(', ')}</p>` : ''}
      ${closed.length ? `<p class="small"><b>Есть, но ловить нельзя:</b> ${closed.map((s) => esc(shortName(s))).join(', ')}</p>` : ''}
      ${moreToggle()}
      ${z.description || z.note ? `<p class="small">${esc(z.description || z.note)}</p>` : ''}
      ${st.n ? `<p class="small"><b>Отчётов на карте внутри:</b> ${st.n} — ${st.fish.slice(0, 6).map(([f, c]) => `${esc(f)} ${c}`).join(', ')}</p>` : ''}
      ${st.access.length ? `<h3>Спуски рядом</h3>${st.access.slice(0, 4).map((a) => listRow({ icon: 'anchor', title: esc(a.title.replace(/^Слип \/ старт на воду: |^Парковка \/ выход к воде: /, '')), sub: a.d > 0 ? `${fmtDist(a.d)} от района` : 'в районе', attrs: `data-open-marker="${a.idx}"` })).join('')}` : ''}
      ${st.hazards.length ? `<h3>Опасности</h3>${st.hazards.slice(0, 5).map((h) => listRow({ icon: 'warning', title: esc(h.title), attrs: `data-open-marker="${h.idx}"` })).join('')}` : ''}
      ${z.precision_m ? `<p class="small muted">Граница района условная, ±${String(Math.round(z.precision_m / 100) / 10).replace('.', ',')} км.</p>` : ''}
      ${src.length ? `<p class="small">${src.slice(0, 4).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">источник ${i + 1}</a>`).join(' · ')}</p>` : ''}`,
    onShow: () => {
      layers.select.clearLayers();
      const l = zoneShape(z, '#fab005');
      if (l) l.addTo(layers.select);
    },
    onClose: () => layers.select.clearLayers(),
  }, opts);
}
function showPlace(i, opts = {}) {
  const z = (state.ctx.season_zones || [])[i];
  if (z) openZoneCard(z, opts);
}
function showZone(id, opts = {}) {
  const [si, zi] = id.split(':').map(Number);
  const s = speciesList()[si];
  const z = s?.zones?.[zi];
  if (!z) return;
  const geoZ = speciesZoneGeo(z);
  openZoneCard({ ...geoZ, name: `${shortName(s)}: ${z.name || geoZ.name || 'зона'}` }, opts);
}

/* ---------- my point, a closed area ---------- */
function openMineCard(p, opts = {}) {
  const t = TAGS[p.tag] || TAGS.other;
  openCard({
    key: `mine:${p.id}`, title: p.name, sub: `${t.label}${p.t ? ` · ${fmtDay(p.t)} ${fmtTime(p.t)}` : ''}${p.link ? ' · по ссылке' : ''}`,
    url: `#pt=${p.lat.toFixed(5)},${p.lon.toFixed(5)}`,
    focus: { lat: p.lat, lon: p.lon },
    body: () => `${fromMeLine(p)}
      <div class="card-actions">
        <button type="button" class="btn main" data-act="mine-nav" data-id="${esc(p.id)}">${ic('navigation')}Вести</button>
        ${p.link ? `<button type="button" class="tile-btn" data-act="mine-keep" data-id="${esc(p.id)}">${ic('star')}<span>Сохранить</span></button>` : ''}
        <button type="button" class="tile-btn" data-act="mine-share" data-id="${esc(p.id)}">${ic('share')}<span>Поделиться</span></button>
        <button type="button" class="tile-btn" data-act="mine-menu" data-id="${esc(p.id)}">${ic('more-horiz')}<span>Ещё</span></button>
      </div>
      ${p.depth != null ? `<p><b>Глубина по вашему эхолоту: ${String(p.depth).replace('.', ',')} м</b></p>` : ''}
      ${p.ice ? `<p><b>Лёд: ${p.ice.cm != null ? `${p.ice.cm} см` : 'толщина не записана'}</b>${p.ice.kind ? `, ${esc(p.ice.kind)}` : ''}${p.ice.water ? ', вода на льду' : ''} · ${esc(iceMarkText(p).split(' · ').pop())}</p><p class="small muted">Замер на одном месте ничего не говорит о льде в сотне метров: у устьев, камышей и ключей лёд тоньше.</p>` : ''}
      <div class="card"><div class="coord">${fmtDec(p.lat, p.lon)}</div><div class="coord">${fmtDM(p.lat, p.lon)}</div></div>
      ${p.note ? `<p>${esc(p.note)}</p>` : ''}`,
    onShow: () => selectRing(p.lat, p.lon),
    onClose: () => layers.select.clearLayers(),
  }, opts);
}
const findMine = (id) => state.mine.find((x) => x.id === id) || (state.linkPoint?.id === id ? state.linkPoint : null);
function openMineMenu(p) {
  openModal({
    title: p.name,
    body: () => `
      ${listRow({ icon: 'edit', title: 'Переименовать', attrs: `data-act="mine-rename" data-id="${esc(p.id)}"` })}
      ${listRow({ icon: 'download', title: 'GPX', attrs: `data-act="gpx-here" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${esc(p.name)}"` })}
      <a class="list-row" href="${esc(yandexRoute(p))}" target="_blank" rel="noopener">${ic('directions-car')}<span class="lr-main"><span class="lr-title">Доехать на машине</span><span class="lr-sub">Яндекс Карты</span></span></a>
      ${listRow({ icon: 'content-copy', title: 'Скопировать координаты', sub: fmtDM(p.lat, p.lon), attrs: `data-act="copy-text" data-text="${esc(`${fmtDM(p.lat, p.lon)} (${fmtDec(p.lat, p.lon)})`)}"` })}
      ${p.link ? '' : listRow({ icon: 'delete', title: '<span style="color:var(--danger)">Удалить точку</span>', attrs: `data-act="mine-del" data-id="${esc(p.id)}"` })}`,
  });
}
function openRuleCard(a, label) {
  openCard({
    key: `rule:${a.name}`, title: label, sub: [a.period, a.applies_to].filter(Boolean).join(' · '),
    body: () => `<p>${esc(a.description || '')}</p>${a.article ? `<p class="small muted">${esc(a.article)}</p>` : ''}${safeUrl(a.source_url) ? `<p><a href="${esc(a.source_url)}" target="_blank" rel="noopener">Текст правил</a></p>` : ''}
      <div class="btns"><button type="button" class="btn ghost" data-page-link="rules">Все правила</button></div>`,
  });
}

/* ---------- Сегодня: warnings, bans, the conditions of the day, weather, water and ice, where to look ---------- */
// The boats the verdicts are for (research/product_ideas.md §5.7): the wave and the mean wind that keep each ashore.
const BOATS = {
  pvc: { name: 'Надувная', of: 'на надувной', wave: 0.5, wind: 8 },
  motor: { name: 'Мотолодка', of: 'на лёгкой мотолодке', wave: 0.75, wind: 10 },
  cabin: { name: 'Катер', of: 'на катере', wave: 1.25, wind: 15 },
};
// «можно / осторожно / нельзя» for a boat by the wind and, when it is known, the wave near the shore.
function boatVerdict(boat, wind, gust, hs) {
  const b = BOATS[boat];
  if (!b) return null;
  let level = 0;
  if (wind >= b.wind || (hs != null && hs >= b.wave)) level = 2;
  else if (wind >= b.wind * 0.75 || gust >= b.wind + 3 || (hs != null && hs >= b.wave * 0.7)) level = 1;
  return { level, word: ['можно', 'осторожно', 'нельзя'][level] };
}
// Species with reports on the time of day (Клёв › Снасти), joined with the calendar by name.
function condSpecies(mo = new Date().getMonth() + 1) {
  const cal = speciesList();
  return tackleSpecies().map((tk) => {
    const key = tk.name_ru.split(/[/ (]/)[0];
    const s = cal.find((x) => speciesKey(x) === key);
    return s ? { key, tk, s, act: activity(s, mo) } : null;
  }).filter(Boolean);
}
// Morning: civil dawn to sunrise + 2 h; evening: sunset − 2 h to civil dusk; day between; night the rest.
function lightWindows(day, lat = 60.2, lon = 32.2) {
  const s = ASTRO.sun(+day, lat, lon), H = 3600000;
  const rise = s.rise ?? s.noon - 9 * H, set = s.set ?? s.noon + 9 * H;
  const dawn = s.dawn ?? rise - H, dusk = s.dusk ?? set + H; // white nights: no civil dusk at all
  return { 'утро': [dawn, rise + 2 * H], 'день': [rise + 2 * H, set - 2 * H], 'вечер': [set - 2 * H, dusk], 'ночь': [dusk, dawn + 24 * H], white: !s.dusk };
}
// The best hours of a species by the share of reports in each part of the day — the next two windows from now.
function bestHours(tk, ice, now = Date.now()) {
  const season = tk[ice ? 'ice' : 'open_water'] || {};
  const tod = Object.fromEntries((season.time_of_day || []).map((x) => [x.name, +x.share || 0]));
  if (!Object.keys(tod).length) return null;
  const light = ['утро', 'день', 'вечер'];
  const top = Math.max(...light.map((k) => tod[k] || 0));
  const good = light.filter((k) => (tod[k] || 0) >= 0.8 * top);
  const wins = [];
  for (const add of [0, 1]) {
    const w = lightWindows(localDay(now, add));
    if (good.length === 3) wins.push({ k: 'день', a: w['утро'][0], b: w['вечер'][1], add, all: true });
    else for (const k of good) wins.push({ k, a: w[k][0], b: w[k][1], add });
  }
  const next = wins.filter((x) => x.b > now).sort((x, y) => x.a - y.a).slice(0, 2);
  return { next, all: good.length === 3, night: tod['ночь'] >= 0.25 ? tod['ночь'] : 0, n: season.n_reports || 0, tod };
}
function winText(w, now = Date.now()) {
  const span = `${fmtTime(w.a)}–${fmtTime(w.b)}`;
  if (w.a <= now) return `сейчас, до ${fmtTime(w.b)}`;
  const day = w.add === 0 ? 'сегодня' : 'завтра';
  return `${day} ${w.all ? 'весь светлый день' : { 'утро': 'утром', 'день': 'днём', 'вечер': 'вечером' }[w.k]} ${span}`;
}
// The forecast over one window: the strongest mean wind and gust, and its direction.
function wxOver(a, b) {
  const fc = state.wx?.fc;
  if (!fc) return null;
  const h = fc.hourly;
  const ks = h.time.map((t, k) => [Date.parse(t), k]).filter(([t]) => t + 3600000 > a && t < b).map(([, k]) => k);
  if (!ks.length) return null;
  const top = ks.reduce((m, k) => (h.wind_speed_10m[k] > h.wind_speed_10m[m] ? k : m), ks[0]);
  return { wind: Math.round(h.wind_speed_10m[top]), gust: Math.round(Math.max(...ks.map((k) => h.wind_gusts_10m[k]))), dir: h.wind_direction_10m[top], k: top };
}
function seasonLine(c, mo) {
  const v = c.act, prev = activity(c.s, (mo + 10) % 12 + 1), next = activity(c.s, mo % 12 + 1);
  const ban = bansToday().find((b) => !isMotorBan(b) && b.species.toLowerCase().includes(c.key.toLowerCase().slice(0, 4)));
  if (ban) return `<b class="v-bad">запрет</b>: ${esc(ban.now)}${ban.area ? ` <span class="muted">(${esc(ban.area)})</span>` : ''}`;
  if (c.s.protected) return '<b class="v-bad">охраняется — ловить нельзя</b>';
  const word = ['не сезон', 'слабо', 'хорошо', 'пик'][v];
  const trend = v && prev > v ? `, сезон на спаде (в ${MONTHS_IN[(mo + 10) % 12]} было лучше)` : v && next > v ? `, сезон набирает силу (в ${MONTHS_IN[mo % 12]} лучше)` : '';
  return `<b>${word}</b> ${dots(v)}${trend}`;
}
function conditionsHtml() {
  const mo = new Date().getMonth() + 1;
  const ice = isIceMonth(mo);
  const list = condSpecies(mo).filter((c) => c.act > 0 || c.key === store.get('ladoga-cond-fish', ''));
  if (!list.length) return '';
  list.sort((a, b) => b.act - a.act);
  const pick = list.find((c) => c.key === store.get('ladoga-cond-fish', '')) || list[0];
  const hrs = bestHours(pick.tk, ice);
  const place = wxPlace();
  const boat = state.settings.boat;
  const lines = [];
  lines.push(`<div class="cond-row"><span class="cond-cap">Сезон</span><span>${seasonLine(pick, mo)}</span></div>`);
  if (hrs) {
    const when = hrs.next.map((w) => winText(w)).join('; ');
    lines.push(`<div class="cond-row"><span class="cond-cap">Время</span><span>${hrs.all ? 'весь светлый день, утро и вечер чуть лучше' : when}${hrs.all ? `: ${when}` : ''}${hrs.night ? `. Ночью тоже ловят — ${Math.round(hrs.night * 100)} % отчётов` : ''} <span class="muted small">(по ${hrs.n.toLocaleString('ru-RU')} ${plural(hrs.n, 'отчёту', 'отчётам', 'отчётам')} ${ice ? 'со льда' : 'с открытой воды'})</span></span></div>`);
  }
  const water = typeof liveWaterLine === 'function' ? liveWaterLine() : '';
  if (water) lines.push(`<div class="cond-row"><span class="cond-cap">Вода</span><span>${water}</span></div>`);
  // Going out: the wind (and the shore wave) over the next good window, for the chosen boat.
  if (!ice && state.wx?.fc && hrs?.next.length) {
    const outs = hrs.next.map((w) => {
      const o = wxOver(Math.max(w.a, Date.now()), w.b);
      if (!o) return '';
      const wave = typeof shoreWave === 'function' ? shoreWave(place.lat, place.lon, o.dir, o.wind, o.k) : null;
      const v = boat ? boatVerdict(boat, o.wind, o.gust, wave?.hs) : null;
      const cls = v ? ['v-ok', 'v-warn', 'v-bad'][v.level] : '';
      return `<div>${esc(winText(w).replace(/^сейчас, до/, 'сейчас (до'))}${w.a <= Date.now() ? ')' : ''}: ${rumb(o.dir)} ${o.wind} м/с, порывы ${o.gust}${wave ? `, волна у берега ≈ ${String(wave.hs.toFixed(1)).replace('.', ',')} м` : ''}${v ? ` — <b class="${cls}">${BOATS[boat].of} ${v.word}</b>` : ''}</div>`;
    }).filter(Boolean);
    const motorBans = boat && boat !== 'pvc' ? bansToday().filter(isMotorBan) : [];
    const motorSeasonal = motorBanParts(motorBans).seasonal.size > 0;
    lines.push(`<div class="cond-row"><span class="cond-cap">Выход</span><span>${outs.join('') || 'нет прогноза на эти часы'}
      ${motorSeasonal ? `<div class="small v-bad">С мотором сейчас ловить нельзя: ${esc(motorBanSummary(motorBans))}.</div>` : ''}
      <div class="seg boat-seg" style="margin-top:6px">${Object.entries(BOATS).map(([k, b]) => `<button type="button" data-set="boat" data-val="${k}" class="${boat === k ? 'on' : ''}">${b.name}</button>`).join('')}</div>
      ${boat ? '' : '<div class="small muted">Выберите свою лодку — скажу, можно ли на ней выходить.</div>'}</span></div>`);
  }
  if (ice && typeof iceRisksHtml === 'function') lines.push(`<div class="cond-row"><span class="cond-cap">Лёд</span><span>${iceRisksHtml(true)}</span></div>`);
  // For reference only: the Moon and the pressure — what people look for, and what our 23 000 reports do not back.
  const moon = moonInfo();
  const fc = state.wx?.fc;
  let pres = '';
  if (fc) {
    const h = fc.hourly, i0 = wxNowIndex(fc), p = h.pressure_msl[i0], p24 = h.pressure_msl[Math.max(0, i0 - 24)];
    if (p != null) pres = ` Давление ${hPaToMm(p)} мм${p24 != null ? `, за сутки ${Math.round((p - p24) * 0.75) >= 0 ? '+' : '−'}${Math.abs(Math.round((p - p24) * 0.75))}` : ''}.`;
  }
  return `<h3 id="cond">Условия дня</h3>
    <div class="chips">${list.slice(0, 8).map((c) => `<button type="button" class="chip ${c === pick ? 'on' : ''}" data-cond="${esc(c.key)}"><span class="dot" style="background:${speciesColor(c.s)}"></span>${esc(shortName(c.s))} ${dots(c.act)}</button>`).join('')}</div>
    <div class="card cond">
      ${lines.join('')}
      <p class="small muted" style="margin:8px 0 0">${moon.name[0].toUpperCase()}${moon.name.slice(1)}, ${moon.illum} %${moon.transit ? `, в зените в ${fmtTime(moon.transit)}` : ''}.${pres} По 23 тыс. ладожских отчётов ни Луна, ни давление улов не предсказывают — справочно.</p>
      <div class="btns" style="margin-bottom:0">
        <button type="button" class="btn small" data-act="filter-fish" data-name="${esc(pick.key)}">${ic('map')}${esc(shortName(pick.s))} на карте</button>
        <button type="button" class="btn small ghost" data-act="cond-tackle" data-name="${esc(pick.tk.name_ru)}">На что ловить</button>
      </div>
    </div>`;
}
// Today's motor-boat bans in two kinds (25.09.2026: the card said «Волховский … р-ны — круглый год» in any month):
// the seasonal bans of whole districts — from the ice break-up to 20 June, from 15 September to the freeze-up — and
// the year-round bans of single waters (the Свирская губа, the Neva source, a few rivers), which are listed apart.
const motorDistrict = (c) => (((c.species || '').match(/\(([^)]+)\)/) || [])[1] || c.area || '').replace(/ р-н$/, '');
function motorBanParts(motor) {
  const seasonal = new Map(), always = [];
  for (const c of motor) {
    for (const part of String(c.now || '').split('; ')) {
      if (!part.trim()) continue;
      if (/круглый год/i.test(part)) {
        const place = part.replace(/^\s*круглый год:\s*/i, '').replace(/:\s*круглый год\s*$/i, '').replace(/Ладожское озеро \(Свирская губа\)/, 'Свирская губа')
          .replace(/\s*\((?:от|так в тексте)[^)]*\)/g, '').trim();
        if (place && !always.includes(place)) always.push(place);
      } else {
        const period = (part.match(/(с распаления льда до \d+ [а-яё]+|с \d+ [а-яё]+ до ледостава)/i) || [])[1] || part.replace(/^[^:]*:\s*/, '');
        if (!seasonal.has(period)) seasonal.set(period, new Set());
        seasonal.get(period).add(motorDistrict(c));
      }
    }
  }
  return { seasonal, always };
}
// «Волховский, Кировский, Всеволожский р-ны — с 15 сентября до ледостава (обычно середина декабря)»
function motorBanSummary(motor) {
  const { seasonal } = motorBanParts(motor);
  return [...seasonal.entries()].map(([period, ds]) => `${[...ds].join(', ')} ${ds.size > 1 ? 'р-ны' : 'р-н'} — ${period}${/ледостава/.test(period) ? ' (обычно середина декабря)' : /распаления/.test(period) ? ' (лёд сходит обычно во второй половине апреля)' : ''}`).join('; ');
}
// Official storm and emergency warnings of МЧС (from our server's live.json) that are still in force.
function officialWarnings() {
  const now = Date.now();
  return (state.live?.mchs?.warnings || []).filter((w) => {
    const to = Date.parse(w.valid_to || ''), from = Date.parse(w.published || w.valid_from || '');
    return Number.isFinite(to) ? to > now : Number.isFinite(from) && now - from < 36 * 3600000;
  }).map((w) => ({ title: String(w.title || 'предупреждение').replace(/^ПРЕДУПРЕЖДЕНИЕ\s*/i, 'предупреждение ').toLowerCase().replace(/^./, (c) => c.toUpperCase()), text: w.text || '', url: w.url, emergency: w.level === 'emergency' }));
}
// What is closed today, short: each fish ban on its own line, the motor-boat bans of the districts in one.
function bansTodayCard(bans) {
  const fish = bans.filter((c) => !isMotorBan(c)), motor = bans.filter(isMotorBan);
  const { seasonal, always } = motorBanParts(motor);
  const alwaysLine = always.length ? `<div class="ban-line small">Круглый год моторы запрещены только в отдельных местах: ${esc(always.join('; '))}.</div>` : '';
  if (!fish.length && !seasonal.size) return `<div class="card small ok-card">Сезонных запретов на любительский лов сегодня нет.${alwaysLine} <button type="button" class="btn small ghost" data-page-link="rules">Размеры и нормы</button></div>`;
  return `<div class="card small danger-card"><b>Сегодня действует:</b>
    ${fish.map(banLine).join('')}
    ${seasonal.size ? `<div class="ban-line">• <b>Рыбалка с моторных лодок запрещена</b>: ${esc(motorBanSummary(motor))}. <details class="inline"><summary class="small">Где именно</summary>${motor.map(banLine).join('')}</details></div>` : ''}
    ${alwaysLine}
    <div style="margin-top:6px"><button type="button" class="btn small ghost" data-page-link="rules">Размеры, нормы и все правила</button></div></div>`;
}
function todayHtml() {
  const mo = new Date().getMonth() + 1;
  const ice = isIceMonth(mo);
  const hydro = (state.ctx.hydro_calendar || []).find((h) => +h.month === mo);
  const bans = bansToday();
  const zones = (state.ctx.season_zones || []).map((z) => ({ z, ...zoneSpecies(z, mo) })).filter((x) => x.open.length)
    .sort((a, b) => activity(b.open[0], mo) - activity(a.open[0], mo)).slice(0, 5);
  const n = state.R.filter((r) => CATCH_KINDS.has(r.kind) && monthOf(r) === mo).length;
  const date = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const { installed } = platformInfo();
  const later = (k) => Date.now() < store.get(k, 0);
  const warnings = state.wx?.fc ? wxWarnings(state.wx) : [];
  return `
    <p class="muted" style="margin-top:0">${esc(date[0].toUpperCase() + date.slice(1))} · ${ice ? '❄ лёд' : '🌊 открытая вода'}</p>
    ${!navigator.onLine ? `<div class="card small warn-card">Нет сети${state.wx?.at ? ` · прогноз от ${fmtTime(state.wx.at)} ${fmtDay(state.wx.at)}` : ''}. Карта, точки, справочники и навигатор работают${regionSaved() ? '' : ' там, где карта уже была открыта'}.</div>` : ''}
    ${warnings.map((w) => `<div class="card small wx-${w.level}">${w.level === 'danger' ? `${ic('warning')} <b>Опасно.</b> ` : `${ic('warning')} `}${esc(w.text)}</div>`).join('')}
    ${officialWarnings().map((w) => `<details class="card small wx-${w.emergency ? 'danger' : 'warn'}"><summary>${ic('warning')} <b>МЧС: ${esc(w.title)}</b></summary><p>${esc(w.text)}</p>${safeUrl(w.url) ? `<a href="${esc(w.url)}" target="_blank" rel="noopener">источник</a>` : ''}</details>`).join('')}
    ${bansTodayCard(bans)}
    ${conditionsHtml()}
    ${weatherBlock()}
    ${typeof waterIceHtml === 'function' ? waterIceHtml(ice) : ''}
    ${freshHtml()}
    ${zones.length ? `<h3>Где искать сейчас</h3>${zones.map(({ z, open }) => listRow({ icon: 'location-on', title: esc(z.name), sub: `${open.slice(0, 3).map((s) => esc(shortName(s))).join(', ')}${z.depth_m ? ` · ${esc(z.depth_m)} м` : ''}`, attrs: `data-act="zone-open" data-zone-id="${esc(z.id)}"` })).join('')}` : ''}
    ${hydro ? `<h3>Ладога в ${MONTHS_IN[mo - 1]}</h3><p class="small">${esc(hydro.events || '')}</p>` : ''}
    <div class="btns">
      <button type="button" class="btn" data-act="month-filter">${ic('play-arrow')}Отчёты за ${MONTHS_FULL[mo - 1]} на карте (${n})</button>
      <button type="button" class="btn ghost" data-page-link="guide" data-sub="places">Места</button>
      <button type="button" class="btn ghost" data-act="depth-help">Глубины и эхолот</button>
    </div>
    ${navigator.onLine && !regionSaved() && !later('ladoga-later-download') ? `<div class="card">
      <b>Скачайте район для работы без сети</b>
      <p class="small">На воде связь пропадает. ~${PACKS[0].estMB() + (PACKS[1].estMB() || 30)} МБ, лучше по Wi‑Fi.</p>
      <div class="btns" style="margin-bottom:0"><button type="button" class="btn" data-page-link="me" data-sub="offline">${ic('download')}Скачать</button><button type="button" class="btn ghost" data-act="later" data-key="ladoga-later-download">Позже</button></div>
    </div>` : ''}
    ${!installed && !later('ladoga-later-install') ? `<div class="card">
      <b>Установите на телефон</b>
      <p class="small">Иконка на экране, карта во весь экран, работа без интернета.</p>
      <div class="btns" style="margin-bottom:0"><button type="button" class="btn" data-act="install">Установить</button><button type="button" class="btn ghost" data-act="later" data-key="ladoga-later-install">Позже</button></div>
    </div>` : ''}`;
}
// «Свежие отчёты»: what anglers reported this week (the map has them with a green ring), and when the server looked.
function freshHtml() {
  const list = freshReports(7);
  const f = state.fresh;
  const checked = f?.checked ? Object.values(f.checked).filter(Boolean).sort().pop() : null;
  const when = checked ? `проверено ${fmtDay(Date.parse(checked))}${f.next_check ? `, следующая проверка ${fmtDay(Date.parse(f.next_check))}` : ''}` : '';
  const news = (f?.notices || []).filter((n) => n.date && Date.now() - Date.parse(n.date) < 10 * 86400000).slice(0, 3);
  if (!list.length && !news.length) return when ? `<p class="small muted">Свежих отчётов с Ладоги за неделю нет · ${esc(when)}</p>` : '';
  return `${list.length ? `<h3>Свежие отчёты рыбаков</h3>
    ${list.slice(0, 5).map((r) => {
      const idx = state.M.findIndex((m) => m.r.some((i) => state.R[i] === r));
      return listRow({ icon: 'set-meal', title: esc(`${(r.fish || []).join(', ') || 'рыбалка'} — ${r.place || r.title || r.sector || ''}`), sub: esc([ageText(r.date) || fmtDate(r.date), r.depth ? `глубина ${r.depth}` : '', r.method || '', r.src].filter(Boolean).join(' · ')), attrs: idx >= 0 ? `data-open-marker="${idx}"` : '' });
    }).join('')}
    <p class="small muted">${list.length > 5 ? `Ещё ${list.length - 5} на карте — с зелёным кольцом. ` : ''}${esc(when)}</p>` : ''}
    ${news.map((n) => `<div class="card small">${ic('gavel')} <b>${esc(n.src || 'Официально')}:</b> ${esc(n.title)} <span class="muted">${esc(fmtDate(n.date))}</span>${safeUrl(n.url) ? ` · <a href="${esc(n.url)}" target="_blank" rel="noopener">открыть</a>` : ''}</div>`).join('')}`;
}
/* ---------- Вода и лёд: the level against the charts, the water temperature, ice risks, official reports ---------- */
// Signs of danger on the ice from the saved forecast (the last three days and the next one). They only ever add
// caution: none of them says the ice is safe.
function iceRisks() {
  const fc = state.wx?.fc;
  const out = [];
  const md = (new Date().getMonth() + 1) * 100 + new Date().getDate();
  if (fc) {
    const h = fc.hourly, i0 = wxNowIndex(fc);
    const past = (n) => Array.from({ length: n }, (_, k) => i0 - n + k).filter((k) => k >= 0);
    const next = (n) => Array.from({ length: n }, (_, k) => i0 + k).filter((k) => k < h.time.length);
    const warm = past(72).filter((k) => h.temperature_2m[k] > 0);
    const tmax = Math.max(...past(72).map((k) => h.temperature_2m[k]));
    if (warm.length >= 24) out.push({ level: warm.length >= 60 ? 'danger' : 'warn', text: `Оттепель: ${fmtM(warm.length / 24)} сут выше нуля за три дня (до +${Math.round(tmax)} °C). Лёд белеет и пропитывается водой; после трёх суток оттепели прочность падает примерно на четверть (МЧС).` });
    const rain = [...past(48), ...next(24)].reduce((a2, k) => a2 + (h.rain?.[k] || 0), 0);
    if (rain >= 1) out.push({ level: 'warn', text: `Дождь на лёд: ${fmtM(rain)} мм за двое суток и прогноз на сутки. На льду вода, лёд рыхлый.` });
    const cold = Math.min(...next(24).map((k) => h.temperature_2m[k]));
    if (warm.length >= 12 && cold <= -10) out.push({ level: 'warn', text: `После оттепели мороз до ${Math.round(cold)} °C — ждите новых трещин.` });
    const off = wxWarnings(state.wx).find((w) => /^Отжимной/.test(w.short || ''));
    if (off) out.push({ level: 'danger', text: off.text });
  }
  if (md >= 310 && md <= 531) out.push({ level: 'warn', text: 'Поздний лёд: прочность снижается, у берегов и в устьях — вода на льду и промоины; весной припай отрывает особенно часто.' });
  if (md >= 1101 || md <= 110) out.push({ level: 'warn', text: 'Первый лёд тонкий и неровный, особенно в устьях Волхова, Сяси и Свири — там течение подмывает его снизу.' });
  return out;
}
function iceRisksHtml(short = false) {
  const risks = iceRisks();
  if (short) {
    if (!risks.length) return 'явных признаков опасности по прогнозу нет — это не гарантия: смотрите лёд сами и сводки МЧС';
    const bad = risks.some((r) => r.level === 'danger');
    return `<b class="${bad ? 'v-bad' : 'v-warn'}">${risks.length} ${plural(risks.length, 'признак', 'признака', 'признаков')} опасности</b> — ниже, в «Лёд»`;
  }
  return risks.length ? risks.map((r) => `<div class="card small wx-${r.level === 'danger' ? 'danger' : 'warn'}">${esc(r.text)}</div>`).join('')
    : '<p class="small">По прогнозу явных признаков опасности нет. Это не гарантия: отрыв бывает и при 40–60 см льда.</p>';
}
// «Вода 13,4 °C в открытом озере (22.09), остывает» — from the server's copy of the NOAA MUR analysis.
function liveWaterLine() {
  const w = state.live?.water_temp?.mur || state.live?.water_temp;
  if (!w) return '';
  if (w.under_ice) return `подо льдом (спутник, ${esc(fmtDate(String(w.date || '').slice(0, 10)))})`;
  const t = +w.open_lake_c;
  if (!Number.isFinite(t)) return '';
  const was = +w.week_ago_c;
  const trend = Number.isFinite(was) ? (t < was - 0.4 ? `, остывает (неделю назад ${fmtM(was)})` : t > was + 0.4 ? `, прогревается (неделю назад ${fmtM(was)})` : ', держится') : '';
  return `${fmtM(t)} °C в открытом озере (спутник, ${esc(fmtDate(String(w.date || '').slice(0, 10)))})${trend}. В мелких губах днём на 1–3 °C иначе.`;
}
// «Лёд по отчётам рыбаков»: the thickness and the cracks anglers wrote about this week (scripts/live/fetch_reports.py
// takes them out of the reports: «лёд 15 см», «трещины», «вода на льду»).
function iceReportsHtml() {
  const since = Date.now() - 7 * 86400000;
  const list = state.R.filter((r) => r.ice && (r.ice.cm || r.ice.flags?.length) && r.date && Date.parse(r.date) >= since)
    .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 6);
  if (!list.length) return '';
  return `<p class="small"><b>Лёд по отчётам рыбаков за неделю:</b> ${list.map((r) => `${esc(r.place || r.sector || '')} — ${[r.ice.cm ? `${esc(r.ice.cm)} см` : '', (r.ice.flags || []).map(esc).join(', ')].filter(Boolean).join(', ')} (${esc(ageText(r.date) || fmtDate(r.date))})`).join('; ')}. Лёд меняется за часы — проверяйте пешнёй.</p>`;
}
function waterIceHtml(ice) {
  const live = state.live || {};
  const lv = levelNow();
  const g = live.level?.grealm;
  const m = live.level?.mchs;
  const out = [];
  out.push(`<h3 id="water">${ice ? 'Лёд и вода' : 'Вода'}</h3>`);
  if (ice) {
    out.push(iceRisksHtml());
    out.push(iceReportsHtml());
    out.push(`<button type="button" class="btn small" data-act="${guard.on ? 'guard-sheet' : 'guard-on'}">${ic('warning')}${guard.on ? 'Сторож места включён' : 'Сторож льдины: предупредить, если место относит'}</button>`);
  }
  const review = live.mchs?.ice_review;
  const fcUrl = live.mchs?.forecast?.url;
  if (review?.text) {
    const when = review.obs_date || review.date;
    const places = (review.places || []).filter((p) => p.label || p.cm?.length);
    out.push(`<details class="card small" ${ice ? 'open' : ''}><summary><b>Обзор льда МЧС${when ? `, ${esc(fmtDate(String(when).slice(0, 10)))}` : ''}</b></summary>
      ${places.length ? `<div class="ice-places">${places.map((p) => `<button type="button" class="chip" data-act="ice-place" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${esc(`${p.name}: ${p.label || ''}`)}">${esc(p.name)} <b>${esc(p.label || '')}</b></button>`).join('')}</div>` : ''}
      <p>${esc(review.text)}</p>${review.forecast ? `<p><b>Прогноз:</b> ${esc(review.forecast)}</p>` : ''}
      ${safeUrl(review.url || fcUrl) ? `<a href="${esc(review.url || fcUrl)}" target="_blank" rel="noopener">источник</a> · ` : ''}<span class="muted">данные на дату наблюдения; лёд меняется за часы; при запрете выхода на лёд — не выходить</span></details>`);
  }
  const storm = live.mchs?.storm;
  if (storm && (storm.wind || storm.waves)) {
    const waves = storm.waves && typeof storm.waves === 'object' ? Object.entries(storm.waves).map(([k, v]) => `район ${k}: ${v}`).join('; ') : '';
    const span = [storm.valid_from, storm.valid_to].filter(Boolean).map((t) => `${fmtDay(Date.parse(t))} ${fmtTime(Date.parse(t))}`).join(' – ');
    out.push(`<details class="card small"><summary><b>Шторм-прогноз МЧС</b>${span ? ` <span class="muted">${esc(span)}</span>` : ''}</summary>${storm.wind ? `<p><b>Ветер:</b> ${esc(storm.wind)}</p>` : ''}${waves ? `<p><b>Волна:</b> ${esc(waves)}</p>` : ''}${storm.visibility ? `<p>${esc(storm.visibility)}</p>` : ''}${safeUrl(fcUrl) ? `<a href="${esc(fcUrl)}" target="_blank" rel="noopener">источник</a>` : ''}</details>`);
  }
  const ims = live.ice_season;
  if (ims?.sectors && (ice || Object.values(ims.sectors).some((x) => x.state !== 'water'))) {
    const word = { ice: 'лёд', water: 'вода', mixed: 'частично лёд' };
    out.push(`<p class="small"><b>Лёд по спутнику</b> (IMS, клетки 4 км, ${esc(fmtDate(String(ims.date || '').slice(0, 10)))}): ${Object.values(ims.sectors).map((x) => `${esc(x.name)} — ${word[x.state] || esc(x.state)}`).join('; ')}. Разводья и трещины такой снимок не видит.</p>`);
  }
  const water = liveWaterLine();
  if (water && !ice) out.push(`<p class="small"><b>Температура воды:</b> ${water}</p>`);
  const vb = live.level?.volgobalt;
  const fair = (vb?.depths || []).find((x) => /Ладог|Волхов/i.test(x.name || ''));
  out.push(`<p class="small"><b>Уровень:</b> ${lv < 0 ? `ниже среднего многолетнего на ${fmtM(-lv)} м` : `выше среднего на ${fmtM(lv)} м`} (${esc(levelSourceText())}) — все глубины на картах сейчас ${lv < 0 ? 'меньше' : 'больше'} на столько же; навигатор это учитывает.${g && Number.isFinite(+g.anomaly_m) ? ` По спутнику (${esc(fmtDate(String(g.date || '').slice(0, 10)))}) — на ${fmtM(Math.abs(g.anomaly_m))} м ${g.anomaly_m < 0 ? 'ниже' : 'выше'} обычного для ${MONTHS_GEN[new Date(g.date || Date.now()).getMonth()]} за 1993–2020.` : ''}${m?.text ? ` МЧС: ${esc(String(m.text).slice(0, 220))}` : ''} При южном ветре у южного берега ещё мельче (сгон до 0,6 м), при северном — глубже.</p>`);
  if (fair?.expected_cm) out.push(`<p class="small"><b>Судовой ход ${esc(String(fair.name).replace(/^Ст\.?\s*Ладога\s*-\s*Устье$/i, 'Старая Ладога — устье Волхова'))}:</b> ожидается ${fmtM(fair.expected_cm / 100)} м при гарантированной ${fmtM((fair.guaranteed_cm || 0) / 100)} м (Волго-Балт${vb.decade ? `, ${['', 'I', 'II', 'III'][vb.decade]} декада` : ''}).</p>`);
  const nw = live.level?.meteonw;
  if (nw?.petrokrepost_cm) out.push(`<p class="small muted">Петрокрепость: ${nw.petrokrepost_cm} см над нулём поста (Северо-Западное УГМС, ${esc(fmtTime(Date.parse(nw.time)))}${safeUrl(nw.url) ? `, <a href="${esc(nw.url)}" target="_blank" rel="noopener">meteo.nw.ru</a>` : ''}).</p>`);
  if (ice) out.push(`<div class="btns"><button type="button" class="btn small ghost" data-act="sat-open">${ic('layers')}Спутник: лёд сегодня</button></div>`);
  return out.join('');
}
function weatherBlock() {
  const wx = state.wx;
  const place = wxPlace();
  // The forecast below may be another place's: while the picked one loads, or when it could not load (no signal).
  const other = wx?.fc?.current && wx.place !== place.id;
  const wxNote = !other ? '' : state.wxLoading ? 'Загружаю погоду…'
    : `Нет связи: прогноз для «${esc(place.name)}» не загрузился, ниже — для «${esc(wx.at_place?.name || '')}».`;
  const chips = `<div class="chips" style="margin:6px 0">${WX_PLACES.map((p) => `<button type="button" class="chip ${p.id === place.id ? 'on' : ''}" data-wxplace="${p.id}">${p.here ? ic('my-location') : ''}${esc(p.name)}</button>`).join('')}</div>
    <p class="small muted" id="wxLoading" ${wxNote ? '' : 'hidden'}>${wxNote}</p>`;
  if (!wx?.fc?.current) return `<h3 id="wx">Погода</h3>${chips}<p class="muted">${navigator.onLine ? 'Загружаю прогноз…' : 'Прогноз загрузится, когда появится интернет.'}</p>`;
  const fc = wx.fc, h = fc.hourly, i0 = wxNowIndex(fc);
  const age = Math.round((Date.now() - wx.at) / 60000);
  // An old forecast (no signal on the water): «now» is read from its hours, and its age is said up front.
  const cur = age < 90 ? fc.current : { wind_speed_10m: h.wind_speed_10m[i0], wind_direction_10m: h.wind_direction_10m[i0], wind_gusts_10m: h.wind_gusts_10m[i0], temperature_2m: h.temperature_2m[i0], pressure_msl: h.pressure_msl[i0], cloud_cover: fc.current.cloud_cover };
  const p3 = h.pressure_msl[Math.max(0, i0 - 3)], p24 = h.pressure_msl[Math.max(0, i0 - 24)];
  const trend = (a, b) => {
    if (a == null || b == null) return '';
    const mm = Math.round((a - b) * 0.75);
    return mm === 0 ? 'без изменений' : `${mm > 0 ? '+' : '−'}${Math.abs(mm)} мм`;
  };
  const sea = wx.sea, wave = sea?.hourly?.wave_height?.[i0];
  const cellKm = sea?.latitude != null && wx.at_place ? distM(wx.at_place, { lat: sea.latitude, lon: sea.longitude }) / 1000 : null;
  const at = wx.at_place || place;
  const shore = typeof shoreWave === 'function' ? shoreWave(at.lat, at.lon, cur.wind_direction_10m, cur.wind_speed_10m, i0) : null;
  const moon = moonInfo(), sun = sunTimes(new Date(), at.lat, at.lon);
  const hours = Array.from({ length: 48 }, (_, k) => i0 + k).filter((k) => k < h.time.length && (k - i0) % 3 === 0);
  const mm = (k) => h.precipitation?.[k];
  const today = h.time[i0].slice(0, 10), d1 = new Date(`${today}T12:00`); d1.setDate(d1.getDate() + 1);
  const tomorrow = `${d1.getFullYear()}-${String(d1.getMonth() + 1).padStart(2, '0')}-${String(d1.getDate()).padStart(2, '0')}`;
  const dayTag = (k) => { const d = h.time[k].slice(0, 10); return d === today ? '' : +h.time[k].slice(11, 13) < 6 ? 'ночь ' : d === tomorrow ? 'завтра ' : 'послезавтра '; };
  return `<h3 id="wx">Погода: ${esc(wx.at_place?.name || place.name)}</h3>
    ${chips}
    ${age > 360 ? `<div class="card small warn-card">${ic('cloud-off')} Прогноз от ${fmtTime(wx.at)} ${fmtDay(wx.at)} — ${fmtDur(Date.now() - wx.at)} назад. Обновится, когда появится сеть.</div>` : ''}
    <div class="wx-now">
      <div class="wx-big">${windArrow(cur.wind_direction_10m, 30)}<div><b>${Math.round(cur.wind_speed_10m)} м/с</b><span>${rumb(cur.wind_direction_10m)}, порывы ${Math.round(cur.wind_gusts_10m)}</span></div></div>
      <div class="wx-big"><div><b>${Math.round(cur.temperature_2m)}°</b><span>облачность ${Math.round(cur.cloud_cover ?? 0)} %</span></div></div>
    </div>
    <dl class="kv">
      <dt>Давление</dt><dd>${hPaToMm(cur.pressure_msl)} мм рт. ст.; за 3 ч ${trend(h.pressure_msl[i0], p3)}, за сутки ${trend(h.pressure_msl[i0], p24)}</dd>
      ${shore ? `<dt>Волна у берега</dt><dd>≈ ${String(shore.hs.toFixed(1)).replace('.', ',')} м, период ${String(shore.ts.toFixed(0))} с — оценка по ветру и разгону (${Math.round(shore.fetch_km)} км открытой воды с ${rumb(cur.wind_direction_10m)}), ±30 %</dd>` : ''}
      ${wave != null ? `<dt>Волна в озере</dt><dd>${String(wave.toFixed(1)).replace('.', ',')} м — модель${cellKm != null && cellKm > 3 ? `: открытое озеро в ${Math.round(cellKm)} км к ${rumb(bearing(at, { lat: sea.latitude, lon: sea.longitude }))}` : ''}; в губах волна короче и круче</dd>` : ''}
      ${sun.rise ? `<dt>Солнце</dt><dd>рассвет ${fmtTime(sun.dawn ?? sun.rise)}, восход ${fmtTime(sun.rise)}, закат ${fmtTime(sun.set)}, темно с ${fmtTime(sun.dusk ?? sun.set)}</dd>` : ''}
      <dt>Луна</dt><dd>${moon.name}, освещена на ${moon.illum} %${moon.rise ? `, восход ${fmtTime(moon.rise)}` : ''}${moon.set ? `, заход ${fmtTime(moon.set)}` : ''}</dd>
    </dl>
    <div class="wx-hours">${hours.map((k) => {
      const t = h.time[k], fog = h.visibility?.[k] != null && h.visibility[k] < 1000, storm = (h.weather_code?.[k] || 0) >= 95;
      const shoreK = typeof shoreWave === 'function' ? shoreWave(at.lat, at.lon, h.wind_direction_10m[k], h.wind_speed_10m[k], k) : null;
      const waveK = shoreK ? shoreK.hs : sea?.hourly?.wave_height?.[k];
      return `<div class="wx-h ${h.wind_speed_10m[k] >= 8 || h.wind_gusts_10m[k] >= 13 ? 'windy' : ''}">
      <span class="t">${dayTag(k)}${t.slice(11, 16)}</span>
      ${windArrow(h.wind_direction_10m[k], 16)}
      <b>${Math.round(h.wind_speed_10m[k])}</b><span class="g">${Math.round(h.wind_gusts_10m[k])}</span>
      <span>${Math.round(h.temperature_2m[k])}°</span>
      <span class="rain" title="осадки">${storm ? '⚡' : fog ? '🌫' : h.precipitation_probability?.[k] >= 30 ? `💧${h.precipitation_probability[k]}%` : mm(k) >= 0.2 ? `💧${String(mm(k).toFixed(1)).replace('.', ',')}` : ''}</span>
      ${waveK != null ? `<span class="wv" title="волна, м">${String(waveK.toFixed(1)).replace('.', ',')} м</span>` : ''}
    </div>`;
    }).join('')}</div>
    <p class="small muted">Ветер в м/с: крупно — средний, мелко — порывы; стрелка — куда дует. 💧 — вероятность осадков, 🌫 — туман, ⚡ — гроза; внизу — волна${shore ? ' у берега (оценка)' : ' (модель, открытое озеро)'}. Прогноз Open-Meteo, обновлён ${age < 1 ? 'только что' : age < 120 ? `${age} мин назад` : `в ${fmtTime(wx.at)} ${fmtDay(wx.at)}`}. Отжимной для южного берега — ветер с юго-востока, юга и юго-запада.</p>
    ${(state.ctx.practical?.weather?.hazards || []).length ? `<details><summary>Опасная погода на Ладоге</summary>${state.ctx.practical.weather.hazards.map((h2) => `<div class="card small"><b>${esc(h2.title)}</b><br>${esc(h2.text)}</div>`).join('')}</details>` : ''}
    ${(state.ctx.practical?.weather?.thresholds || []).length ? `<details><summary>Цифры: ветер, волна, лёд</summary><table class="rules-table">${state.ctx.practical.weather.thresholds.map((t2) => `<tr><td>${esc(t2.what)}</td><td>${esc(t2.value)}</td></tr>`).join('')}</table></details>` : ''}
    <div class="btns"><button type="button" class="btn small ghost" data-act="wx-refresh">${ic('restart-alt')}Обновить прогноз</button></div>`;
}

/* ---------- Клёв › Места ---------- */
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
      const bites = nowSp.filter((s) => activity(s, mo) > 0), banned = nowSp.filter((s) => !(activity(s, mo) > 0));
      return `<div class="card">
        <h4>${esc(z.name || 'Район')}</h4>
        <div class="small muted">${z.depth_m ? `глубины ${esc(z.depth_m)} м · ` : ''}${monthsText(z.months) ? `сезон: ${esc(monthsText(z.months))}` : ''}</div>
        ${bites.length ? `<div class="small" style="margin-top:4px">В ${MONTHS_IN[mo - 1]} ловят: ${bites.map((s) => esc(shortName(s))).join(', ')}</div>` : ''}
        ${banned.length ? `<div class="small muted">Есть, но ловить нельзя: ${banned.map((s) => esc(shortName(s))).join(', ')}</div>` : ''}
        ${st.n ? `<div class="small" style="margin-top:4px"><b>${st.n} ${plural(st.n, 'отчёт', 'отчёта', 'отчётов')} на карте:</b> ${st.fish.slice(0, 6).map(([f, c]) => `${esc(f)} ${c}`).join(', ')}</div>
          <div class="bars" style="height:26px">${st.months.map((v, k) => `<div class="${k + 1 === mo ? 'cur' : ''}" style="height:${v ? Math.max(8, (v / max) * 100) : 4}%;${v ? '' : 'opacity:.3'}" title="${MONTHS_FULL[k]}: ${v}"></div>`).join('')}</div>
          <div class="bars-labels">${MONTHS.map((m) => `<span>${m[0]}</span>`).join('')}</div>` : ''}
        <details><summary class="small">Описание</summary><p class="small">${esc(z.description || z.note || '')}</p></details>
        <div class="btns" style="margin-bottom:0">
          <button type="button" class="btn small" data-act="place-show" data-zone="${i}">${ic('map')}На карте</button>
          <button type="button" class="btn small ghost" data-act="place-nav" data-zone="${i}">${ic('navigation')}Вести сюда</button>
        </div>
      </div>`;
    }).join('')}`;
}

/* ---------- Клёв › Сезон ---------- */
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
  const ranked = sp.map((s) => ({ s, v: activity(s, mo), p: +(s.presence_by_month || [])[mo - 1] || 0 })).sort((a, b) => b.v - a.v || b.p - a.p);
  const catchable = ranked.filter((x) => x.v > 0);
  const offLimits = ranked.filter((x) => x.v === 0 && x.p >= 2);
  const iceStats = state.ctx.ice_from_angler_reports?.areas || {};
  const iceRows = [11, 12, 1, 2, 3, 4].includes(mo) ? Object.entries(iceStats) : [];
  const q = (o) => (o ? `~${esc(o.median || '?')} (обычно ${esc(o.q25 || '?')}–${esc(o.q75 || '?')})` : '?');
  return `
    <div class="months" style="margin-top:6px">${MONTHS.map((m, i) => `<button type="button" class="chip ${mo === i + 1 ? 'on' : ''}" data-smonth="${i + 1}">${m}</button>`).join('')}</div>
    <div class="btns"><button type="button" class="btn" data-act="play-year">${ic('play-arrow')}Год по месяцам на карте</button></div>
    <h2>Ладога в ${MONTHS_IN[mo - 1]} ${ice ? '❄' : '🌊'}</h2>
    ${hydro ? `<div class="card small">${hydro.events ? `<p style="margin-top:0">${esc(hydro.events)}</p>` : ''}<dl class="kv">${hydro.ice ? `<dt>Лёд</dt><dd>${esc(hydro.ice)}</dd>` : ''}${hydro.water_temp_c ? `<dt>Вода</dt><dd>${esc(hydro.water_temp_c)}${/°/.test(hydro.water_temp_c) ? '' : ' °C'}</dd>` : ''}${hydro.level ? `<dt>Уровень</dt><dd>${esc(hydro.level)}</dd>` : ''}</dl></div>` : ''}
    ${iceRows.length ? `<details><summary>Первый и последний лёд по отчётам рыбаков</summary>${iceRows.map(([area, v]) => `<div class="small" style="margin:4px 0"><b>${esc(area)}</b>: первый лёд ${q(v.first_ice_report)}, последний ${q(v.last_ice_report)}${v.winters_used ? `; зим в выборке: ${v.winters_used}` : ''}</div>`).join('')}</details>` : ''}
    <h3>Что ловится в ${MONTHS_IN[mo - 1]}</h3>
    ${sp.length ? '' : '<p class="muted">Справка по видам ещё собирается.</p>'}
    ${catchable.map(({ s, v }) => `<div class="card">
        <h4><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${speciesColor(s)}"></span> ${esc(s.name_ru)} <span class="muted small">${dots(v)} ${ACT[v]}</span></h4>
        ${methodFor(s, ice) ? `<div class="small">${esc(methodFor(s, ice))}</div>` : ''}
        ${zonesFor(s, mo).map((z) => `<div class="small muted">• ${esc(z.name || '')}${z.note ? ` — ${esc(z.note)}` : ''}</div>`).join('')}
        <div class="btns" style="margin:6px 0 0"><button type="button" class="btn small ghost" data-act="filter-fish" data-name="${esc(speciesKey(s))}">${ic('map')}На карте</button></div>
      </div>`).join('')}
    ${offLimits.length ? `<h3>Есть в районе, но ловить нельзя или бесполезно</h3>
      ${offLimits.map(({ s, p }) => `<div class="small" style="margin:6px 0"><b>${esc(s.name_ru)}</b> — ${['', 'единично', 'обычен', 'массовый ход или скопления'][p]}${s.protected ? ', охраняется (Красная книга ЛО)' : ', запретный срок или не берёт'}.${s.presence_note ? ` ${esc(s.presence_note)}` : ''}</div>`).join('')}` : ''}
    ${timeseriesHtml(mo)}
    <h3>Точки на карте по месяцам (все годы)</h3>
    <div class="bars">${byMonth.slice(1).map((n, i) => `<div class="${i + 1 === mo ? 'cur' : ''}" style="height:${Math.round((n / max) * 100)}%" title="${MONTHS_FULL[i]}: ${n}"></div>`).join('')}</div>
    <div class="bars-labels">${MONTHS.map((m) => `<span>${m}</span>`).join('')}</div>
    <p class="small">${fishInMonth.size ? `В ${MONTHS_IN[mo - 1]} на карте чаще всего отмечали: ${[...fishInMonth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, n]) => `${esc(f)} (${n})`).join(', ')}.` : `Отчётов за ${MONTHS_FULL[mo - 1]} пока нет.`}</p>
    <div class="btns"><button type="button" class="btn ghost" data-act="month-filter">Отчёты за ${MONTHS_FULL[mo - 1]} на карте</button></div>
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
  const areas = Object.entries(ts.by_sector || {}).map(([k, v]) => [k, +(v.by_month || [])[mo - 1] || 0]).filter(([k, n]) => n && !/не уточн/i.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return `<h3>Что ловили в ${MONTHS_IN[mo - 1]} — по ${ts.total.toLocaleString('ru-RU')} ${plural(ts.total, 'датированному отчёту', 'датированным отчётам', 'датированным отчётам')}</h3>
    <div class="bars">${bm.map((n, i) => `<div class="${i + 1 === mo ? 'cur' : ''}" style="height:${Math.round((n / max) * 100)}%" title="${MONTHS_FULL[i]}: ${n}"></div>`).join('')}</div>
    <div class="bars-labels">${MONTHS.map((m) => `<span>${m}</span>`).join('')}</div>
    ${fish.length ? `<div class="chips" style="margin-top:8px">${fish.map(([f, n]) => `<button type="button" class="chip" data-act="filter-fish" data-name="${esc(f)}"><span class="dot" style="background:${FISH_COLORS[f] || OTHER_COLOR}"></span>${esc(f)} <span class="n">${n}</span></button>`).join('')}</div>` : ''}
    ${areas.length ? `<p class="small" style="margin-bottom:0"><b>Где чаще всего рыбачили:</b></p>${areas.map(([k, n]) => `<div class="small">• ${esc(k)} — ${n} ${plural(n, 'отчёт', 'отчёта', 'отчётов')}</div>`).join('')}` : ''}
    <p class="small muted">Источники: ${(ts.by_source || []).slice(0, 5).map(([s2, n]) => `${esc(s2)} (${n})`).join(', ')}. Это то, о чём пишут рыбаки, а не учёт рыбы.</p>`;
}
function calendarTable(sp, mo, field) {
  return `<table class="cal"><tr><th></th>${MONTHS.map((m, i) => `<th class="${i + 1 === mo ? 'cur' : ''}">${m[0].toUpperCase()}</th>`).join('')}</tr>
    ${sp.map((s) => `<tr><td>${esc(s.name_ru.replace(/\s*\(.*\)/, ''))}</td>${Array.from({ length: 12 }, (_, i) => { const v = +(s[field] || [])[i] || 0; return `<td class="c v${v} ${i + 1 === mo ? 'cur' : ''}" title="${esc(s.name_ru)}, ${MONTHS_FULL[i]}: ${v}">${v || ''}</td>`; }).join('')}</tr>`).join('')}
  </table>`;
}

/* ---------- Клёв › Рыба ---------- */
function safeDecode(u) { try { return decodeURIComponent(u); } catch { return u; } }
function fishHtml() {
  const sp = speciesList();
  if (!sp.length) return '<p class="muted">Справка по видам ещё собирается.</p>';
  const mo = new Date().getMonth() + 1;
  const miniBars = (arr, dim) => {
    const vals = Array.from({ length: 12 }, (_, i) => +(arr || [])[i] || 0);
    const mx = Math.max(1, ...vals);
    return `<div class="bars" style="height:30px">${vals.map((v, i) => `<div class="${i + 1 === mo ? 'cur' : ''}" style="height:${v ? Math.max(8, (v / mx) * 100) : 4}%;${v ? '' : 'opacity:.3;'}${dim ? 'background:#91a7b3' : ''}"></div>`).join('')}</div>`;
  };
  const ordered = [...sp].sort((a, b) => (!!a.protected - !!b.protected));
  return `<p class="small muted">Когда и где ловится каждая рыба. Столбики — клёв по месяцам (тёмный — сейчас). «Подробнее» — где держится, нерест, перемещения, как ловить и её зоны на карте.</p>
    ${ordered.map((s) => {
      const si = sp.indexOf(s);
      const mentions = s.forum_evidence?.mentions_by_month || [];
      const total = mentions.reduce((a, b) => a + (+b || 0), 0);
      return `<div class="card">
      <h4><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${speciesColor(s)}"></span> ${esc(s.name_ru)} ${s.protected ? '<span class="badge" style="background:#ffe3e3;color:#a61e1e">охраняется</span>' : ''}</h4>
      ${miniBars(s.activity_by_month)}
      <div class="bars-labels">${MONTHS.map((m) => `<span>${m[0]}</span>`).join('')}</div>
      ${s.ice_vs_open ? `<p class="small" style="margin-bottom:0">${esc(s.ice_vs_open)}</p>` : ''}
      ${s.protected ? '' : `<div class="btns" style="margin:8px 0 0"><button type="button" class="btn small" data-act="filter-fish" data-name="${esc(speciesKey(s))}">${ic('map')}На карте</button></div>`}
      <details><summary class="small">Подробнее</summary>
        ${s.latin ? `<p class="small muted"><i>${esc(s.latin)}</i></p>` : ''}
        ${s.status ? `<p class="small"><b>Статус:</b> ${esc(s.status)}</p>` : ''}
        ${s.habitat_summary ? `<p class="small"><b>Где держится:</b> ${esc(s.habitat_summary)}</p>` : ''}
        ${s.spawning ? `<p class="small"><b>Нерест:</b> ${esc([monthsText(s.spawning.months), s.spawning.place, s.spawning.temp_c ? `вода ${s.spawning.temp_c}${/°/.test(s.spawning.temp_c) ? '' : ' °C'}` : ''].filter((x) => x && typeof x === 'string').join('; '))}</p>` : ''}
        ${s.migration_summary ? `<p class="small"><b>Перемещения по сезонам:</b> ${esc(s.migration_summary)}</p>` : ''}
        ${s.best_methods ? `<p class="small">${s.best_methods.ice ? `<b>Со льда:</b> ${esc(s.best_methods.ice)}<br>` : ''}${s.best_methods.open_water ? `<b>По воде:</b> ${esc(s.best_methods.open_water)}` : ''}</p>` : ''}
        ${total ? `<div class="small muted">Сколько раз упоминали в отчётах fisher.spb.ru по месяцам (всего ${total}):</div>${miniBars(mentions, true)}<div class="bars-labels">${MONTHS.map((m) => `<span>${m[0]}</span>`).join('')}</div>` : ''}
        ${(s.zones || []).length ? `<p class="small" style="margin-bottom:0"><b>Зоны на карте:</b></p><div class="btns" style="margin-top:4px">${(s.zones || []).map((z, zi) => `<button type="button" class="btn small ghost" data-act="show-zone" data-zone="${si}:${zi}">${esc((z.name || 'зона').slice(0, 42))}${monthsText(z.months) ? ` · ${esc(monthsText(z.months))}` : ''}</button>`).join('')}</div>` : ''}
        ${(s.sources || []).length ? `<details><summary class="small">Источники (${s.sources.length})</summary>${s.sources.map((u) => (safeUrl(u) ? `<div class="small"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(safeDecode(u.replace(/^https?:\/\//, '')).slice(0, 70))}</a></div>` : `<div class="small">${esc(u)}</div>`)).join('')}</details>` : ''}
      </details>
    </div>`;
    }).join('')}`;
}

/* ---------- Клёв › Снасти: what anglers actually caught on, from ~23,000 reports, plus expert notes ---------- */
function tackleSpecies() { return state.ctx.tackle?.species || []; }
function pct(x) { return `${Math.round((+x || 0) * 100)}%`; }
function shareBars(items, n = 6) {
  const list = (items || []).filter((x) => +x.share > 0).slice(0, n);
  if (!list.length) return '<p class="small muted">Мало данных.</p>';
  const max = Math.max(...list.map((x) => +x.share));
  return `<div class="hbars">${list.map((x) => `<div class="hbar"><span class="hbar-name">${esc(x.name)}</span><span class="hbar-track"><span style="width:${Math.max(4, (x.share / max) * 100)}%"></span></span><span class="hbar-val">${pct(x.share)}</span></div>`).join('')}</div>`;
}
function tackleHtml() {
  const list = tackleSpecies();
  if (!list.length) return '<p class="muted">Справочник снастей ещё собирается.</p>';
  const mo = new Date().getMonth() + 1;
  if (!state.tackleSeason) state.tackleSeason = isIceMonth(mo) ? 'ice' : 'open_water';
  if (!state.tackleFish || !list.some((s) => s.name_ru === state.tackleFish)) state.tackleFish = list[0].name_ru;
  const s = list.find((x) => x.name_ru === state.tackleFish);
  const season = state.tackleSeason;
  const d = s[season] || {};
  const ex = s.expert || {};
  const gear = state.ctx.tackle?.gear_lists?.[season === 'ice' ? 'ice' : 'open_water'] || [];
  const packed = new Set(store.get(`ladoga-pack-${season}`, []));
  const monthRow = (s.by_month || []).find((m) => +m.month === mo);
  const sizes = (d.lure_sizes || []).map((x) => ({ ...x, top: (x.top || []).filter((t) => x.unit !== 'г' || t.value <= 40) })).filter((x) => x.top.length);
  return `
    <p class="small muted">На что ловили — по ${Number(state.ctx.tackle?.total || 0).toLocaleString('ru-RU')} отчётам рыбаков южной Ладоги за 2004–2026 годы (fisher.spb.ru, Telegram, форумы) и советам опытных ладожских рыболовов. Проценты — как часто снасть упоминали в удачных отчётах.</p>
    <div class="seg" style="margin:6px 0">${[['ice', '❄ Со льда'], ['open_water', '🌊 По открытой воде']].map(([k, t]) => `<button type="button" data-tseason="${k}" class="${season === k ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div class="chips" style="margin:8px 0">${list.map((x) => `<button type="button" class="chip ${x.name_ru === s.name_ru ? 'on' : ''}" data-tfish="${esc(x.name_ru)}"><span class="dot" style="background:${FISH_COLORS[x.name_ru.split(/[/ ]/)[0]] || OTHER_COLOR}"></span>${esc(x.name_ru)}</button>`).join('')}</div>
    <h2>${esc(s.name_ru)} ${season === 'ice' ? 'со льда' : 'по воде'}</h2>
    ${s.legal ? `<div class="card small warn-card">${esc(s.legal)}</div>` : ''}
    ${d.n_reports ? `<p class="small muted">${d.n_reports.toLocaleString('ru-RU')} ${plural(d.n_reports, 'отчёт', 'отчёта', 'отчётов')}${d.depth_m?.median ? ` · глубина обычно ${String(d.depth_m.p25).replace('.', ',')}–${String(d.depth_m.p75).replace('.', ',')} м` : ''}${d.fish_weight_g?.median ? ` · типичная рыба ${d.fish_weight_g.median >= 1000 ? `${String((d.fish_weight_g.median / 1000).toFixed(1)).replace('.', ',')} кг` : `${Math.round(d.fish_weight_g.median)} г`}` : ''}</p>` : '<p class="small muted">В этот сезон отчётов почти нет.</p>'}
    ${(d.methods || []).length ? `<h3>Снасть</h3>${shareBars(d.methods)}` : ''}
    ${(d.baits || []).length ? `<h3>Приманка и наживка</h3>${shareBars(d.baits)}` : ''}
    ${sizes.length ? `<p class="small"><b>Размеры, которые называли:</b> ${sizes.slice(0, 4).map((x) => `${esc(x.lure)} — ${x.top.slice(0, 3).map((t) => `${t.value} ${esc(x.unit)}`).join(', ')}`).join('; ')}</p>` : ''}
    ${(d.lure_colours || []).length ? `<p class="small"><b>Цвета:</b> ${d.lure_colours.slice(0, 6).map((x) => `${esc(x.lure)} — ${esc(x.colour)}`).join('; ')}</p>` : ''}
    ${d.mormyshka_material ? `<p class="small"><b>Мормышки:</b> ${Object.entries(d.mormyshka_material).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} (${v})`).join(', ')}</p>` : ''}
    ${d.groundbait_share >= 0.1 ? `<p class="small"><b>Прикормка:</b> упоминают в ${pct(d.groundbait_share)} отчётов</p>` : ''}
    ${(d.time_of_day || []).length ? `<h3>Время суток</h3>${shareBars(d.time_of_day, 4)}` : ''}
    ${(d.tips || []).length ? `<h3>Советы</h3>${d.tips.map((t) => `<p class="small">• ${esc(t)}</p>`).join('')}` : ''}
    ${ex[season === 'ice' ? 'ice' : 'open_water'] ? `<details class="card small" open><summary>Как ловят ладожские рыболовы</summary><p>${esc(ex[season === 'ice' ? 'ice' : 'open_water'])}</p>${(ex.sources || []).filter(safeUrl).slice(0, 3).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">источник ${i + 1}</a>`).join(' · ')}</details>` : ''}
    ${(d.examples || []).length ? `<h3>Кто на что поймал</h3>${d.examples.map((e) => `<div class="card small"><b>${esc(fmtDate(e.date))}, ${esc(e.place || '')}</b><br>${esc(e.text)}${safeUrl(e.source_url) ? `<br><a href="${esc(e.source_url)}" target="_blank" rel="noopener">отчёт</a>` : ''}</div>`).join('')}` : ''}
    ${monthRow && monthRow.n ? `<p class="small"><b>В ${MONTHS_IN[mo - 1]}</b> (${monthRow.n} ${plural(monthRow.n, 'отчёт', 'отчёта', 'отчётов')}): ${(monthRow.top_methods || []).slice(0, 3).map((m) => `${esc(m.name)} ${pct(m.share)}`).join(', ')}</p>` : ''}
    ${(s.by_area || []).length ? `<details><summary class="small">По районам</summary>${s.by_area.slice(0, 8).map((a) => `<p class="small"><b>${esc(a.area)}</b> (${a.n}): ${(a.top_methods || []).slice(0, 3).map((m) => `${esc(m.name)} ${pct(m.share)}`).join(', ')}${a.depth_median ? `; ~${String(a.depth_median).replace('.', ',')} м` : ''}</p>`).join('')}</details>` : ''}
    ${gear.length ? `<h3>${season === 'ice' ? 'Что взять на лёд' : 'Что взять на воду'}</h3>
      <p class="small muted">Отмечайте, что уже уложили — список запомнится в телефоне.</p>
      ${gear.map((g, i) => `<label class="check pack"><input type="checkbox" data-pack="${season}:${i}" ${packed.has(i) ? 'checked' : ''}><span><b>${esc(g.item)}</b><br><span class="small muted">${esc(g.why || '')}</span></span></label>`).join('')}
      <button type="button" class="btn small ghost" data-act="pack-clear" data-season="${season}">Снять все отметки</button>` : ''}`;
}

/* ---------- Правила: one page with an anchor row ---------- */
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
  const anchors = [['r-today', 'Сегодня'], ['r-sizes', 'Размеры'], ['r-seasons', 'Сроки'], ['r-areas', 'Запретные места'], ['r-boat', 'Лодка'], ['r-ice', 'Лёд']];
  return `
    <nav class="anchors">${anchors.map(([id, t]) => `<button type="button" data-anchor="${id}">${t}</button>`).join('')}</nav>
    <button type="button" class="card" data-act="sos" style="display:flex;gap:12px;align-items:center"><span class="fab sos" style="flex:none;box-shadow:none">SOS</span><span><b>SOS и телефоны</b><br><span class="small">112, МЧС, ГИМС, больницы рядом и что делать на оторванной льдине</span></span></button>
    <div class="card small">Выжимка из Правил рыболовства Западного бассейна (приказ № 620 в ред. № 747, действует с 01.09.2024 до 01.09.2027). Перед поездкой сверяйтесь с текстом: ${safeUrl(g.url) ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">официальная публикация</a>` : ''}${(g.consolidated_text_urls || []).filter(safeUrl).map((u, i) => ` · <a href="${esc(u)}" target="_blank" rel="noopener">${i ? 'Гарант' : 'КонсультантПлюс'}</a>`).join('')}.</div>
    ${(state.fresh?.notices || []).length ? `<details class="card small"><summary><b>Новое от ведомств</b> <span class="muted">${state.fresh.checked?.notices ? `· проверено ${esc(fmtDay(Date.parse(state.fresh.checked.notices)))}` : ''}</span></summary>
      ${state.fresh.notices.slice(0, 10).map((n) => `<div style="margin:6px 0">${esc(fmtDate(n.date))} · <b>${esc(n.src || '')}</b>: ${safeUrl(n.url) ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)}</div>`).join('')}
      <p class="muted" style="margin-bottom:0">Сервер раз в неделю проверяет сайты Росрыболовства, Правительства и МЧС Ленобласти, Волго-Балта и публикацию правовых актов. Новое появляется здесь со ссылкой; сами правила в приложении обновляются после проверки.</p></details>` : ''}
    <h3 id="r-today">Действует сегодня</h3>
    ${now.length ? `<div class="card small danger-card">${now.map(banLine).join('')}</div>` : '<p class="small">Сегодня сезонных запретов на любительский лов в этом районе нет — действуют только общие правила ниже.</p>'}
    <h3 id="r-sizes">Размер и норма вылова</h3>
    <table class="rules-table"><tr><th>Рыба</th><th>Не меньше</th><th>В сутки</th></tr>
      ${species.map((sp) => { const sz = sizes.find((x) => x.species === sp); const bg = bags.find((x) => x.species === sp); return `<tr><td>${esc(sp)}</td><td>${sz ? `${esc(sz.min_cm)} см` : '—'}</td><td>${bg ? esc(bg.limit) : '—'}</td></tr>`; }).join('')}
    </table>
    ${bags.filter((b) => b.note).map((b) => `<p class="small muted">${esc(b.species)}: ${esc(b.note)}</p>`).join('')}
    <h3 id="r-seasons">Запретные сроки</h3>
    ${seasons.map((c) => `<div class="card small"><b>${esc(c.species)}</b>: ${esc(c.dates)}<br><span class="muted">${esc(c.area || '')}${c.article ? ` · ${esc(c.article)}` : ''}</span>${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</div>`).join('')}
    ${forbidden.length ? `<h3>Ловить нельзя никогда</h3>${forbidden.map((c) => `<div class="small" style="margin:4px 0">• ${esc(c.species)} <span class="muted">(${esc(c.area || '')})</span></div>`).join('')}<p class="small muted">Случайно пойманную рыбу запрещённых видов и меньше разрешённого размера сразу отпускают.</p>` : ''}
    <h3 id="r-areas">Запретные места</h3>
    ${amateurAreas.length ? `<label class="check switch"><span>Показать на карте</span><input type="checkbox" data-overlay="rules" ${state.overlays.rules ? 'checked' : ''}></label>
      ${amateurAreas.map((a) => `<div class="card small"><b>${esc(a.name)}</b>${a.period ? ` — ${esc(a.period)}` : ''}<br>${esc(a.description || '')}</div>`).join('')}` : '<p class="small muted">Нет данных.</p>'}
    ${tradeAreas.length ? `<details><summary class="small">Запреты для промысла (любителей не касаются, справочно): ${tradeAreas.length}</summary>${tradeAreas.map((a) => `<div class="small" style="margin:6px 0"><b>${esc(a.name.replace(/^\[Промысел\]\s*/, ''))}</b>${a.period ? ` — ${esc(a.period)}` : ''}. ${esc(a.description || '')}</div>`).join('')}</details>` : ''}
    ${(g.gear_rules || []).length ? `<h3>Снасти и способы</h3>${g.gear_rules.map((b) => `<div class="small" style="margin:5px 0">• ${esc(typeof b === 'string' ? b : b.rule || '')}</div>`).join('')}` : ''}
    <h3 id="r-boat">Лодка и мотор</h3>
    ${motors.length ? `${motors.map((c) => `<div class="card small"><b>${esc((c.species.match(/\(([^)]+)\)/) || [])[1] || '')}</b>: ${esc(c.dates)}<br><span class="muted">${esc(c.area || '')}</span></div>`).join('')}<p class="small muted">Запрет на моторы касается рыболовства с моторных лодок в эти сроки; «до ледостава» и «с распаления льда» — по факту на водоёме.</p>` : ''}
    ${(state.ctx.practical?.boat_rules || []).map((b) => `<details class="card small"><summary>${esc(b.title)}</summary><p>${esc(b.text)}</p>${safeUrl(b.source_url) ? `<a href="${esc(b.source_url)}" target="_blank" rel="noopener">источник</a>` : ''}</details>`).join('')}
    <h3 id="r-ice">Лёд</h3>
    ${(state.ctx.practical?.ice_rules_general || []).map((b) => `<details class="card small"><summary>${esc(b.title)}</summary><p>${esc(b.text)}</p>${safeUrl(b.source_url) ? `<a href="${esc(b.source_url)}" target="_blank" rel="noopener">источник</a>` : ''}</details>`).join('')}
    ${ice.map((b) => `<details class="card small"><summary>${esc(b.title || b.type || '')}</summary><p>${esc(b.description || b.summary || '')}</p>${safeUrl(b.source_url) ? `<a href="${esc(b.source_url)}" target="_blank" rel="noopener">источник</a>` : ''}</details>`).join('')}
    ${(state.ctx.ice_zones || []).length ? `<p class="small">${state.ctx.ice_zones.length} ${plural(state.ctx.ice_zones.length, 'место', 'места', 'мест')}, где за 2005–2026 проваливались под лёд и отрывало льдины (сводки МЧС, спасателей, рыбаков), — на карте слоем «Опасный лёд»: <button type="button" class="chip" data-act="icez-show">показать</button></p>` : ''}`;
}

/* ---------- Моё › Точки, Без сети, Ещё ---------- */
function mePointsHtml() {
  const f = state.pointsFilter || 'all';
  const me = typeof geo !== 'undefined' ? geo.me : null;
  const favs = state.M.map((m, idx) => ({ m, idx })).filter(({ m }) => state.fav.has(pointKey(m.lat, m.lon)));
  const mine = state.mine.filter((p) => f === 'all' || f === 'mine' || p.tag === f);
  const chips = [['all', 'Все'], ['fav', `Избранные отчёты (${favs.length})`], ['mine', 'Мои точки'], ...Object.entries(TAGS).map(([k, t]) => [k, t.label])];
  const rowMine = (p) => {
    const t = TAGS[p.tag] || TAGS.other;
    return listRow({ icon: '', title: `<span class="tag-dot" style="background:${t.color}"></span> ${esc(p.name)}`, sub: `${t.label} · ${p.t ? `${fmtDay(p.t)} ${fmtTime(p.t)}` : ''}${me ? ` · ${fmtDist(distM(me, p))} от вас` : ''}`, attrs: `data-act="mine-open" data-id="${esc(p.id)}"`, right: ic('chevron-right') });
  };
  return `
    ${state.car ? listRow({ icon: 'directions-car', title: 'Машина', sub: `отмечена ${fmtDay(state.car.t)} ${fmtTime(state.car.t)}${me ? ` · ${fmtDist(distM(me, state.car))} от вас` : ''}`, attrs: 'data-act="car-card"', right: ic('chevron-right') }) : ''}
    <div class="chips" style="margin:4px 0 8px">${chips.map(([k, t]) => `<button type="button" class="chip ${f === k ? 'on' : ''}" data-points-filter="${k}">${esc(t)}</button>`).join('')}</div>
    ${f === 'all' || f === 'fav' ? `${f === 'all' && favs.length ? '<h3>Избранные отчёты</h3>' : ''}${favs.map(({ m, idx }) => listRow({ icon: 'star-fill', title: esc(pointTitle(m)), sub: `${esc(state.R[m.r[0]].sector || '')}${me ? ` · ${fmtDist(distM(me, m))} от вас` : ''}`, attrs: `data-open-marker="${idx}"` })).join('')}${f === 'fav' && !favs.length ? '<p class="muted">Нажмите «Сохранить» в карточке точки — она появится здесь.</p>' : ''}` : ''}
    ${f !== 'fav' ? `${f === 'all' && mine.length ? '<h3>Мои точки и метки</h3>' : ''}${mine.slice().reverse().map(rowMine).join('')}${!mine.length ? '<p class="muted">Своих точек пока нет. Долгое нажатие на карту (или правый клик) — «Новая точка»; «Метка» при записи трека и в навигаторе сохраняет место сразу.</p>' : ''}` : ''}
    <div class="btns"><button type="button" class="btn small ghost" data-act="gpx-import">${ic('add')}Загрузить GPX или CSV</button>${state.mine.length ? `<button type="button" class="btn small ghost" data-act="gpx-mine">${ic('download')}Мои точки в GPX</button>` : ''}</div>
    <p class="small muted">GPX с точками и треками из Garmin, Navionics, OsmAnd, Locus или другого телефона добавится сюда и на карту.</p>
    <h3>Мои замеры глубин</h3>
    <p class="small">Самые свежие глубины — ваши: впишите глубину по эхолоту в метку или новую точку, либо загрузите файл замеров — CSV со столбцами «широта, долгота, глубина» (например, выгрузка Deeper) или GPX с глубинами. На карте они подписываются зелёным при приближении (слой «Мои замеры глубин»).</p>
    ${depthSets.list.map((s) => `<div class="track-row"><button type="button" class="list-row" data-act="depthset-show" data-id="${esc(s.id)}">${ic('water')}<span class="lr-main"><span class="lr-title">${esc(s.name)}</span><span class="lr-sub">${s.n} ${plural(s.n, 'замер', 'замера', 'замеров')} · ${fmtDay(s.t)}</span></span></button><button type="button" class="icon-btn" data-act="depthset-del" data-id="${esc(s.id)}" aria-label="Удалить замеры">${ic('delete')}</button></div>`).join('')}`;
}
function offlineHtml() {
  const { iOS, installed } = platformInfo();
  const core = packInfo('core'), charts = packInfo('charts');
  const running = offline.running;
  const pr = offline.progress;
  const mainMB = PACKS[0].estMB() + (PACKS[1].estMB() || 30);
  const regionStatus = () => {
    if (running && running.includes('core') && pr) return progressHtml(pr);
    if (core?.complete && (charts?.complete || !charts)) return `<div class="small">${ic('check-circle')} Загружен · ${new Date(core.at).toLocaleDateString('ru-RU')}</div>`;
    if (core) return `<div class="small">${ic('warning')} Скачано не всё (${core.done} из ${core.total}) — нажмите «Докачать»</div>`;
    return '<div class="small muted">Не скачан</div>';
  };
  const mainBtn = running && running.includes('core')
    ? `<button type="button" class="btn ghost" data-act="pack-stop">${ic('pause')}Пауза</button>`
    : `<button type="button" class="btn" data-act="region-download">${ic('download')}${core?.complete ? 'Обновить' : core ? 'Докачать' : `Скачать район · ~${mainMB} МБ`}</button>`;
  const saved = regionSaved();
  // The charts and the depth data were rebuilt after this phone saved them: the saved copy is the old one.
  const built = Date.parse(state.ctx.depth?.tiles?.generated || '') || 0;
  const stale = saved && charts?.at && charts.at < built;
  return `
    ${stale ? `<div class="card small warn-card">${ic('warning')} Навигационные карты и данные обновились ${esc(fmtDate(state.ctx.depth.tiles.generated))} (точнее совмещены листы). В телефоне — прежние: нажмите «Обновить», лучше по Wi‑Fi (~${mainMB} МБ).</div>` : ''}
    <div class="card">
      <b>Чтобы всё работало без интернета</b>
      <div class="checklist">
        <div class="step ${installed ? 'done' : ''}"><span class="num">${installed ? '✓' : 1}</span><span class="txt">Установить приложение${installed ? ' — установлено' : ' на телефон (или компьютер)'}</span>${installed ? '' : '<button type="button" class="btn small" data-act="install">Как</button>'}</div>
        <div class="step ${saved ? 'done' : ''}"><span class="num">${saved ? '✓' : 2}</span><span class="txt">Скачать район${saved ? ' — скачан' : ' — кнопка ниже, лучше по Wi‑Fi'}</span></div>
      </div>
      <p class="small muted" style="margin-bottom:0">Сохраняется всё: само приложение, точки, справочники, правила, карта района, навигационные карты и глубины. Дальше оно открывается с иконки и работает без сети — на iPhone, Android и компьютере. Без сети не будет только свежей погоды.</p>
    </div>
    <div class="card">
      <b>Район южной Ладоги</b>
      <div id="packMain" style="margin:6px 0">${regionStatus()}</div>
      <div class="small muted">Карта района (спутник: весь район обзорно и берег у мест крупно), навигационные карты глубин, приложение и все данные.</div>
      ${iOS && !installed ? `<div class="card small warn-card" style="margin-top:8px">На iPhone сначала установите приложение на экран «Домой» и качайте в нём: скачанное в Safari в приложение не попадёт. <button type="button" class="btn small ghost" data-act="install">Как установить</button></div>` : ''}
      <div class="btns" style="margin-bottom:0">${mainBtn}</div>
    </div>
    ${extraPackCard('detail', 'Подробная карта у берега', 'Самый крупный масштаб спутника в 1 км от мест рыбалки, слипов и банок. Лучше по Wi‑Fi.')}
    ${extraPackCard('genshtab', 'Армейская карта 1:100 000', 'Листы Генштаба 1970–80-х: изобаты 2–20 м, камни, отмели. Справочно — навигационные карты точнее.')}
    <h3>Без сети работает</h3>
    <div class="ok-list">${['карта района (скачанная часть)', 'GPS, навигатор, компас', 'треки и метки', 'точки, справочники, правила', 'глубины по навигационным картам'].map((t) => `<div>${ic('check-circle')} ${t}</div>`).join('')}</div>
    <h3>Не работает</h3>
    <div class="ok-list muted">${[`погода${state.wx?.at ? ` (последняя — ${fmtDay(state.wx.at)} ${fmtTime(state.wx.at)})` : ''}`, 'маршрут на машине', 'ссылки на источники'].map((t) => `<div>${ic('cloud-off')} ${t}</div>`).join('')}</div>
    <p class="small muted" id="storageLine"></p>
    <button type="button" class="btn small textdanger" data-act="pack-delete">${ic('delete')}Удалить все сохранённые карты</button>`;
}
function extraPackCard(id, title, note) {
  const pack = PACKS.find((p) => p.id === id);
  if (!pack) return '';
  const info = packInfo(id), running = offline.running === id, pr = offline.progress;
  const mb = pack.estMB();
  return `<div class="card">
      <b>${esc(title)}</b>${mb ? ` <span class="muted small">~${mb} МБ</span>` : ''}
      <div id="pack-${id}" class="small" style="margin:6px 0">${running && pr ? progressHtml(pr) : info ? (info.complete ? `${ic('check-circle')} Загружена` : `Скачано ${info.done} из ${info.total}`) : '<span class="muted">Не скачана</span>'}</div>
      <div class="small muted">${esc(note)}</div>
      <div class="btns" style="margin-bottom:0">${running ? `<button type="button" class="btn small ghost" data-act="pack-stop">${ic('pause')}Пауза</button>` : `<button type="button" class="btn small ghost" data-act="pack-run" data-pack="${id}">${info?.complete ? 'Обновить' : info ? 'Докачать' : 'Скачать'}</button>`}</div>
    </div>`;
}
function progressHtml(pr) {
  const share = pr.total ? (pr.done + pr.failed) / pr.total : 0;
  const secs = (Date.now() - pr.t0) / 1000;
  const left = share > 0.02 ? Math.round((secs / share - secs) / 60) : null;
  return `<div class="pack-bar"><span style="width:${Math.round(share * 100)}%"></span></div>
    <div class="small">${Math.round(share * 100)} % · ${Math.round(pr.bytes / 1048576)} МБ${left != null ? ` · осталось ~${Math.max(1, left)} мин` : ''}${pr.failed ? ` · не скачалось ${pr.failed}` : ''}</div>`;
}
function onPackProgress() {
  // Start and end redraw the page (buttons change); in between only the bar moves.
  if (offline.shownRunning !== offline.running) { offline.shownRunning = offline.running; refreshPage('me'); renderChips(); return; }
  if (!offline.running) return;
  const pr = offline.progress;
  const el = $(offline.running.includes('core') ? '#packMain' : `#pack-${offline.running}`);
  if (el && pr) el.innerHTML = progressHtml(pr);
  else refreshPage('me');
}
async function storageLine() {
  try {
    const est = await navigator.storage?.estimate?.();
    const el = $('#storageLine');
    if (el && est) el.textContent = `Занято в телефоне: ${Math.round((est.usage || 0) / 1048576)} МБ${est.quota ? ` из доступных ~${Math.round(est.quota / 1073741824)} ГБ` : ''}.`;
  } catch { /* ignore */ }
}
const seg = (key, options, value) => `<div class="seg">${options.map(([v, t]) => `<button type="button" data-set="${key}" data-val="${v}" class="${String(value) === String(v) ? 'on' : ''}">${t}</button>`).join('')}</div>`;
const sw = (key, label, sub = '') => `<label class="check switch"><span>${label}${sub ? `<br><span class="small muted">${sub}</span>` : ''}</span><input type="checkbox" data-setting="${key}" ${state.settings[key] ? 'checked' : ''}></label>`;
function moreHtml() {
  const s = state.settings;
  const st = state.meta.stats || {};
  const sources = state.ctx.sources || [];
  const used = sources.filter((x) => x.status === 'used');
  const { installed } = platformInfo();
  return `
    <div class="card">
      <b>Попробовать навигатор дома</b>
      <p class="small">Демо: лодка сама идёт к Варецким банкам — видно скорость, курс, глубину под лодкой, предупреждение о мели, уход с курса и прибытие. Геопозиция не нужна; завершить — кнопкой «Завершить».</p>
      <button type="button" class="btn" data-act="demo">${ic('navigation')}Запустить демо</button>
    </div>
    <h3>Экран</h3>
    <div class="small muted">Тема</div>
    ${seg('theme', [['system', 'Как в системе'], ['sun', 'По солнцу'], ['day', 'День'], ['night', 'Ночь']], s.theme)}
    ${sw('keepAwake', 'Не гасить экран', 'Пока приложение открыто. В навигации и при записи трека экран не гаснет всегда.')}
    <h3>Навигатор</h3>
    <div class="small muted">Карта в навигации</div>
    ${seg('orient', [['course', 'По курсу'], ['north', 'Север вверх']], s.orient)}
    <div class="small muted" style="margin-top:8px">Скорость</div>
    ${seg('units', [['kmh', 'км/ч'], ['kn', 'узлы']], s.units)}
    <div class="small muted" style="margin-top:8px">Радиус прибытия</div>
    ${seg('arrivalR', [[15, '15 м'], [30, '30 м'], [50, '50 м'], [100, '100 м']], s.arrivalR)}
    <div class="small muted" style="margin-top:8px">Сдвинули карту пальцем — вернуть её к лодке через</div>
    ${seg('autoReturn', [[10, '10 с'], [20, '20 с'], [60, '1 мин'], [0, 'никогда']], s.autoReturn)}
    <p class="small muted" style="margin:4px 0 0">Отсчёт — с момента, когда палец убран; пока открыта карточка точки, карта стоит.</p>
    <div class="small muted" style="margin-top:8px">Предупреждать о глубине меньше</div>
    ${seg('shallow', [[1, '1 м'], [1.5, '1,5 м'], [2, '2 м'], [3, '3 м']], s.shallow)}
    ${sw('autoZoom', 'Автомасштаб', 'Масштаб по скорости и расстоянию до точки')}
    ${sw('sound', 'Звук прибытия и опасности')}
    ${sw('voice', 'Голосовые подсказки', 'Сколько до точки, «правее/левее», мель впереди, «вы на месте» — можно не смотреть на экран')}
    ${sw('navShowPoints', 'Точки рыбаков в навигации', 'Места ловли и ваши метки остаются на карте')}
    <h3>Мой район</h3>
    <p class="small">${esc(state.home.name)} — кнопка ${ic('home')} на карте показывает его целиком. Сделать своим можно любой район в его карточке.</p>
    ${state.home.name !== HOME_DEFAULT.name ? '<button type="button" class="btn small ghost" data-act="home-reset">Вернуть всю южную Ладогу</button>' : ''}
    <h3>Геопозиция</h3>
    <p class="small">Включается сама, когда нужна: ◎ на карте, «Вести», запись трека.${platformInfo().iOS ? ' iPhone спрашивает каждый раз? <a href="#" data-act="ios-geo-help">Как сделать, чтобы не спрашивал</a>.' : ''}</p>
    <button type="button" class="btn small ghost" data-act="geo-off">${ic('location-disabled')}Выключить геопозицию сейчас</button>
    <h3>Журнал работы</h3>
    ${sw('sendLog', 'Отправлять журнал работы', 'Что нажимали, как работали GPS и навигатор, ошибки — чтобы находить и исправлять проблемы. Места — с точностью до километра, без телефонов.')}
    <label class="small" style="display:block;margin:8px 0 4px">Как вас зовут — необязательно, чтобы по журналу было понятно, у кого что не так</label>
    <input type="text" id="whoName" maxlength="40" autocomplete="nickname" value="${esc(s.whoName || '')}" placeholder="Имя или прозвище" style="width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink)">
    <button type="button" class="btn small" data-act="report-problem">${ic('warning')}Сообщить о проблеме</button>
    <h3>Приложение</h3>
    <div class="btns">
      ${installed ? '' : `<button type="button" class="btn small" data-act="install">${ic('download')}${platformInfo().iOS || platformInfo().android ? 'Установить на телефон' : 'Установить приложение'}</button>`}
      <button type="button" class="btn small ghost" data-act="depth-help">Глубины и эхолот</button>
      <button type="button" class="btn small ghost" data-act="keys">${ic('keyboard')}Клавиши (ПК)</button>
      <button type="button" class="btn small ghost" data-act="copy-link">Ссылка на карту</button>
    </div>
    <h3>Экспорт</h3>
    <div class="btns">
      <button type="button" class="btn small" data-act="gpx-backup">${ic('download')}Всё моё в GPX (точки и треки)</button>
      <button type="button" class="btn small ghost" data-act="gpx-import">${ic('add')}Загрузить GPX</button>
      <button type="button" class="btn small ghost" data-act="gpx-filter">GPX: точки по фильтру</button>
      <a class="btn small ghost" href="downloads/ladoga_points.gpx" download>GPX: все точки</a>
      <a class="btn small ghost" href="downloads/ladoga_reports.csv" download>CSV (Excel)</a>
      <a class="btn small ghost" href="downloads/ladoga_reports.geojson" download>GeoJSON</a>
    </div>
    <p class="small muted">GPX открывается в Navionics, Garmin ActiveCaptain, OsmAnd, Locus — через «Открыть в…» или «Поделиться».</p>
    <h3>О данных</h3>
    <p class="small">Все точки взяты из открытых публикаций: рыболовные отчёты с геометками, координаты, которые рыбаки сами выложили, наблюдения на iNaturalist и GBIF, OpenStreetMap, сводки МЧС. Каждая запись ведёт на свой источник. Густые скопления показывают, где <i>чаще публикуют</i> отчёты, а не обязательно где больше рыбы.</p>
    <dl class="kv small"><dt>Записей</dt><dd>${st.reports ?? state.R.length}</dd><dt>Точек на карте</dt><dd>${st.markers ?? state.M.length}</dd><dt>Данные от</dt><dd>${esc(state.meta.generated || '')}</dd></dl>
    <details><summary class="small">Источники и классы достоверности</summary>
      ${(st.by_source || []).map(([name, n]) => `<div class="small">${esc(name)} — ${n}</div>`).join('')}
      <p class="small">${['A', 'B', 'C'].map((c) => `<span class="badge ${c}">${c}</span> ${esc(CLASS_TEXT[c])} — ${(st.by_class || []).find((x) => x[0] === c)?.[1] || 0}`).join('<br>')}</p>
    </details>
    ${sources.length ? `<details><summary class="small">Что проверено при сборе: использовано ${used.length}, без данных ${sources.length - used.length}</summary>${sources.map((x) => `<div class="small" style="margin:4px 0">${safeUrl(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name || x.url)}</a>` : esc(x.name)} <span class="muted">— ${esc(x.status)}${x.note ? `: ${esc(x.note)}` : ''}</span></div>`).join('')}</details>` : ''}
    <p class="small muted">Карта: Leaflet (BSD), leaflet-rotate (GPL-3.0), Leaflet.markercluster (MIT), Leaflet.heat (BSD). Подложки: Esri World Imagery, OpenStreetMap, OpenTopoMap, nakarte.me; снимок дня — NASA EOSDIS GIBS. Навигационные карты ГУНиО МО, Генштаб — сканы из открытых архивов. Волна у берега — формулы SPM-1984, глубины озера вне карт — GLDB v2 (Choulga et al., CC BY). Уровень и сводки — Волго-Балт, G-REALM (NASA/USDA), ГУ МЧС по ЛО, Северо-Западное УГМС, температура воды — MUR SST (NASA JPL). Не для судовождения.</p>`;
}

/* ---------- Глубины и эхолот (help sheet) ---------- */
function openDepthHelp() {
  const d = state.ctx.depth || {};
  const apps = d.phone_workflows || [];
  const appCard = (a, open) => `<details class="card" ${open ? 'open' : ''}><summary>${esc(a.app)}</summary>
      <ol class="small" style="padding-left:18px;margin:6px 0">${(a.steps || []).map((st) => `<li style="margin:3px 0">${esc(st)}</li>`).join('')}</ol>
      <dl class="kv small">${a.gpx_import ? `<dt>GPX</dt><dd>${esc(a.gpx_import)}</dd>` : ''}${a.depth_coverage_ladoga ? `<dt>Ладога</dt><dd>${esc(a.depth_coverage_ladoga)}</dd>` : ''}${a.cost ? `<dt>Цена</dt><dd>${esc(a.cost)}</dd>` : ''}</dl>
    </details>`;
  openModal({
    title: 'Глубины и эхолот',
    body: () => `
      <p class="small">Глубины в приложении (включаются в «Слоях»): <b>навигационные карты ГУНиО</b> 1:10 000–1:125 000 — резкие, с отметками глубин (цифры видны при приближении — когда линейка внизу показывает 300 м и меньше); <b>цветная заливка и изобаты через 1 м</b> — модель дна, построенная по 18 тыс. отметкам глубин, распознанным с этих карт (ошибка в среднем 0,3 м, в 90 % мест до 1 м); изобаты, снятые с карт. У каждой точки, в навигаторе и под лодкой показана глубина по этой модели.</p>
      <div class="card small warn-card">Глубины на картах — от среднего многолетнего уровня озера. В 2026 году вода примерно на 0,9 м ниже, значит реально мельче. Съёмка 1930–80-х годов; не для судовождения.</div>
      ${state.ctx.depth?.community ? '<p class="small"><b>Любительские карты глубин Garmin</b> (freegpsmap 2007, С. Новиков 2005) — 25 тыс. отметок и 800 изобат, оцифрованных рыбаками с тех же карт ГУНиО. Совпадают с картами в пределах 15–20 м и дополняют их там, где изобат нет: бухта Петрокрепость, исток Невы, глубокая часть. Отметки видны подписями при сильном приближении, камни — ✚.</p>' : ''}
      <p class="small"><b>Garmin Quickdraw</b> (глубины с эхолотов рыбаков в ActiveCaptain) выгрузить нельзя: Garmin показывает их только внутри своих приложений после входа в аккаунт, открытой выгрузки нет. Можно держать ActiveCaptain рядом и переносить туда наши точки файлом GPX. А <b>свои замеры</b> — глубину по вашему эхолоту в метках или файл CSV/GPX с глубинами — можно загрузить сюда: «Моё › Точки › Мои замеры глубин».</p>
      <div class="btns"><button type="button" class="btn small" data-act="gpx-filter">GPX: точки по фильтру</button><a class="btn small ghost" href="downloads/ladoga_points.gpx" download>GPX: все точки</a>${d.isobaths ? '<a class="btn small ghost" href="downloads/ladoga_isobaths_model.gpx" download>Изобаты (модель) в GPX</a>' : ''}</div>
      ${apps.map((a, i) => appCard(a, i === 0)).join('')}
      <h3>Карты ГУНиО на этой карте</h3>
      ${[...new Map(chartState.items.map((c) => [c.chart, c])).values()].sort((a, b) => a.scale - b.scale).map((c) => listRow({ icon: 'map', title: `№ ${esc(c.chart)} ${esc(c.title || '')}`, sub: `1:${Number(c.scale).toLocaleString('ru-RU')}, ${esc(c.year || '')}`, attrs: `data-act="chart-show" data-chart="${esc(c.chart)}"` })).join('')}
      <h3>Банки и мели из лоции</h3>
      <p class="small">${state.M.filter((m) => m.kind === 'structure' || m.kind === 'hazard').length} точек с наименьшими глубинами (Железница 1,2 м, Астречье 0,8 м, Варецкие Луды, Сухская 2,6 м…) видны при приближении, подписи — ещё ближе. В навигации приложение предупреждает о мели впереди по курсу.</p>
      <details><summary class="small">А можно Navionics прямо на эту карту?</summary>
        <p class="small">Только с ключом Garmin Navionics Web API (заявку подаёт владелец сайта, из России могут отказать); поверх своих данных — только платно. Для «глубины + точки» проще ActiveCaptain или Navionics Boating в телефоне.</p>
      </details>`,
  });
}

/* ---------- layers and filter sheet ---------- */
function layersSheetTabs(tab) {
  return `<nav class="subtabs" style="position:sticky;top:0;background:var(--bg);z-index:2;margin:0 -16px 6px">${[['layers', 'Слои'], ['filter', 'Фильтр']].map(([k, t]) => `<button type="button" data-sheet-tab="${k}" aria-selected="${k === tab}">${t}</button>`).join('')}</nav>`;
}
function shownLine() {
  const total = state.M.length;
  return `Показано ${state.shown.markers} из ${total} ${plural(total, 'точки', 'точек', 'точек')}`;
}
function openLayersSheet(tab = 'layers', opts = {}) {
  openModal({
    key: 'layers', title: 'Слои и фильтр', tab,
    body: (layer) => `${layersSheetTabs(layer.tab)}<p class="small muted" id="shownLine" style="margin:0 0 6px">${shownLine()}</p>${layer.tab === 'filter' ? filterTabHtml() : layersTabHtml()}`,
    foot: () => `<button type="button" class="btn ghost" data-act="filters-reset">Сбросить всё</button><button type="button" class="btn" data-act="close-top">Готово</button>`,
  }, opts);
}
function layersTabHtml() {
  const o = state.overlays;
  const extra = Object.entries(extraOverlays);
  const hasCharts = chartState.items.length || chartState.tiles.length;
  return `
    <div class="chips" style="margin:2px 0 4px">
      <button type="button" class="chip" data-act="preset" data-preset="depth">${ic('water')}Глубины</button>
      <button type="button" class="chip" data-act="preset" data-preset="chart">${ic('anchor')}Карта ГУНиО</button>
      <button type="button" class="chip" data-act="preset" data-preset="now">${ic('set-meal')}Рыбалка сейчас</button>
      <button type="button" class="chip" data-act="preset" data-preset="clean">${ic('map')}Чистая карта</button>
    </div>
    <h3 style="margin-top:4px">Подложка</h3>
    <div class="base-tiles">${Object.entries(BASES).map(([k, b]) => `<button type="button" class="base-tile ${state.base === k ? 'on' : ''}" data-act="base-set" data-base="${k}" style="${baseThumb(k) ? `background-image:url('${baseThumb(k)}')` : ''}" title="${esc(b.full || b.name)}">${esc(b.name)}</button>`).join('')}</div>
    <h3>Глубины</h3>
    ${hasCharts ? `<label class="check switch"><span><b>Навигационные карты ГУНиО</b><br><span class="small muted">цифры глубин, изобаты, камни, створы; цифры читаются при приближении</span></span><input type="checkbox" data-overlay="charts" ${o.charts ? 'checked' : ''}></label>
      <div class="small muted">Прозрачность карт</div>
      <input type="range" id="chartOpacity" min="0.3" max="1" step="0.05" value="${state.chartOpacity}">` : ''}
    ${state.ctx.depth?.shade?.url ? `<label class="check switch"><span><b>Цветная заливка глубин</b><br><span class="small muted">модель дна по отметкам глубин карт: от светлого мелководья к тёмной глубине</span></span><input type="checkbox" data-overlay="shade" ${o.shade ? 'checked' : ''}></label>` : ''}
    ${state.ctx.depth?.isolines ? `<label class="check switch"><span><b>Изобаты через 1 м</b><br><span class="small muted">1–8, 10, 12, 15, 20… м по той же модели, с подписями глубин</span></span><input type="checkbox" data-overlay="gridIso" ${o.gridIso ? 'checked' : ''}></label>` : ''}
    ${state.ctx.depth?.chart_isobaths ? `<label class="check switch"><span>Изобаты 2–30 м, снятые с карт</span><input type="checkbox" data-overlay="chartIso" ${o.chartIso ? 'checked' : ''}></label>` : ''}
    <label class="check switch"><span><b>Мои замеры глубин</b><br><span class="small muted">глубины из ваших меток и загруженных файлов эхолота, зелёные подписи</span></span><input type="checkbox" data-overlay="myDepth" ${o.myDepth ? 'checked' : ''}></label>
    ${state.ctx.depth?.vvp ? `<label class="check switch"><span><b>Глубины ВВП 2023 — устье Волхова</b><br><span class="small muted">300 свежих отметок фарватера и бара (электронная карта ВВП 2023 по схеме Волго-Балта); фарватер и устье на 1,4–1,8 м глубже старых карт. Числа приведены к нулю карт — сейчас мельче на ${fmtM(-levelNow())} м</span></span><input type="checkbox" data-overlay="vvp" ${o.vvp ? 'checked' : ''}></label>` : ''}
    ${state.ctx.depth?.community ? `<label class="check switch"><span>Любительские карты глубин Garmin<br><span class="small muted">freegpsmap 2007, С. Новиков 2005: оцифровка тех же карт ГУНиО, дополняет их в бухте Петрокрепость, у истока Невы и в глубокой части; отметки подписями при приближении, камни ✚</span></span><input type="checkbox" data-overlay="community" ${o.community ? 'checked' : ''}></label>` : ''}
    ${(state.ctx.depth?.overlays || []).length ? `<label class="check switch"><span>Старая армейская карта 1:100 000<br><span class="small muted">Генштаб 1970–80-х, справочно: навигационные карты и модель дна точнее</span></span><input type="checkbox" data-overlay="genshtab" ${o.genshtab ? 'checked' : ''}></label>
      ${o.genshtab ? `<input type="range" id="genshtabOpacity" min="0.25" max="1" step="0.05" value="${state.genshtabOpacity}">` : ''}` : ''}
    <button type="button" class="btn small ghost" data-act="depth-help">Глубины и эхолот — как пользоваться</button>
    <h3>Спутник</h3>
    <label class="check switch"><span><b>Снимок дня (NASA)</b><br><span class="small muted">вчерашний или сегодняшний снимок 250 м: кромка льда, разводья, отрыв; облака закрывают — листайте дни</span></span><input type="checkbox" data-overlay="satDay" ${o.satDay ? 'checked' : ''}></label>
    ${o.satDay ? satControlsHtml() : ''}
    <h3>На карте</h3>
    <label class="check switch"><span>Группировать близкие точки</span><input type="checkbox" data-overlay="cluster" ${o.cluster ? 'checked' : ''}></label>
    <label class="check switch"><span>Сезонные зоны рыбы<br><span class="small muted">месяц: ${MONTHS_FULL[state.seasonMonth - 1]}</span></span><input type="checkbox" data-overlay="seasonZones" ${o.seasonZones ? 'checked' : ''}></label>
    ${(state.ctx.ice_zones || []).length ? `<label class="check switch"><span><b>Опасный лёд</b><br><span class="small muted">${state.ctx.ice_zones.length} мест, где проваливались и отрывало льдины за 2005–2026; с ноября по апрель включается сам</span></span><input type="checkbox" data-overlay="iceZones" ${o.iceZones ? 'checked' : ''}></label>` : ''}
    <label class="check switch"><span>Запретные районы</span><input type="checkbox" data-overlay="rules" ${o.rules ? 'checked' : ''}></label>
    <label class="check switch"><span>Фарватеры</span><input type="checkbox" data-overlay="lines" ${o.lines ? 'checked' : ''}></label>
    <label class="check switch"><span>Морские знаки, буи, маяки (OpenSeaMap)</span><input type="checkbox" data-overlay="seamarks" ${o.seamarks ? 'checked' : ''}></label>
    <label class="check switch"><span>Мои точки (${state.mine.length})</span><input type="checkbox" data-overlay="mine" ${o.mine ? 'checked' : ''}></label>
    <label class="check switch"><span>Мои треки</span><input type="checkbox" data-overlay="tracks" ${o.tracks ? 'checked' : ''}></label>
    <label class="check switch"><span>Тепловая карта активности</span><input type="checkbox" data-overlay="heat" ${o.heat ? 'checked' : ''}></label>
    <label class="check switch"><span>Круг 55 км от Новой Ладоги</span><input type="checkbox" data-overlay="radius" ${o.radius ? 'checked' : ''}></label>
    ${extra.length ? `<h3>Старые и специальные карты</h3>
      ${extra.map(([k, ov]) => `<label class="check switch"><span>${esc(ov.name)}${ov.note ? `<br><span class="small muted">${esc(ov.note)}</span>` : ''}</span><input type="checkbox" data-overlay="${k}" ${o[k] ? 'checked' : ''}></label>`).join('')}
      <div class="small muted">Прозрачность старых карт</div>
      <input type="range" id="overlayOpacity" min="0.2" max="1" step="0.05" value="${state.overlayOpacity}">` : ''}`;
}
// Day ◀ ▶, ice/water colours, and the picture kept for the ice without signal.
function satControlsHtml() {
  const date = SAT_DAY.date || satLatest();
  const snap = store.get('ladoga-sat-snap', null);
  return `<div class="row" style="margin:4px 0 8px">
      <button type="button" class="icon-btn" data-act="sat-prev" aria-label="День раньше">${ic('chevron-left')}</button>
      <b style="min-width:7.5em;text-align:center">${esc(fmtDate(date))}</b>
      <button type="button" class="icon-btn" data-act="sat-next" aria-label="День позже" ${date >= satLatest() ? 'disabled' : ''}>${ic('chevron-right')}</button>
      <button type="button" class="chip ${SAT_DAY.bands ? 'on' : ''}" data-act="sat-bands">Лёд / вода</button>
    </div>
    <p class="small muted" style="margin-top:0">${SAT_DAY.bands ? 'Лёд и снег — бирюзовые, открытая вода — чёрная, облака — белёсые.' : 'Как видно глазом из космоса. Толщину льда снимок не показывает, узкие трещины не видны.'} Снимок — на момент пролёта (около 11–12 ч), лёд уносит за часы. NASA EOSDIS GIBS.</p>
    <div class="btns" style="margin-top:0"><button type="button" class="btn small ghost" data-act="sat-save">${ic('download')}Сохранить снимок района</button></div>
    ${snap ? `<p class="small">Сохранён снимок за ${esc(fmtDate(snap.date))}${snap.bands ? ' (лёд/вода)' : ''} — без сети он и покажется.</p>` : ''}`;
}
function kindSwatch(k) {
  if (CATCH_KINDS.has(k)) return `<span class="pin ${k === 'observation' ? 'obs' : ''}" style="display:inline-block;width:12px;height:12px;${k === 'observation' ? 'border-color:#2f9e44' : 'background:#2f9e44'}"></span>`;
  return `<span class="shape ${k}" style="display:inline-grid;width:12px;height:12px;font-size:8px">${k === 'launch' ? '⚓' : k === 'ice_incident' ? '!' : k === 'service' ? '⌂' : ''}</span>`;
}
function fishChip([name, n]) {
  return `<button type="button" class="chip ${state.f.fish.has(name) ? 'on' : ''}" data-fish="${esc(name)}"><span class="dot" style="background:${FISH_COLORS[name] || OTHER_COLOR}"></span>${esc(name)} <span class="n">${n}</span></button>`;
}
function filterTabHtml() {
  const f = state.f;
  const catchR = state.R.filter((r) => CATCH_KINDS.has(r.kind));
  const fishCounts = new Map();
  for (const r of catchR) for (const x of r.fish || []) fishCounts.set(x, (fishCounts.get(x) || 0) + 1);
  const fish = [...fishCounts.entries()].sort((a, b) => b[1] - a[1]);
  const monthCounts = Array(13).fill(0);
  for (const r of catchR) monthCounts[monthOf(r)] += 1;
  const kindCounts = new Map();
  let stale = 0;
  for (const r of state.R) { if (!f.archive && !isCurrent(r)) { stale += 1; continue; } kindCounts.set(r.kind, (kindCounts.get(r.kind) || 0) + 1); }
  const srcCounts = new Map();
  for (const r of state.R) srcCounts.set(r.src, (srcCounts.get(r.src) || 0) + 1);
  const years = state.R.map(yearOf).filter(Boolean);
  const minY = Math.min(...years), maxY = Math.max(...years);
  return `
    <h3 style="margin-top:4px">Рыба</h3>
    <div class="chips">${fish.filter(([name], i) => i < 12 || f.fish.has(name)).map(fishChip).join('')}</div>
    ${fish.length > 12 ? `<details><summary class="small">Ещё ${fish.length - 12} ${plural(fish.length - 12, 'вид', 'вида', 'видов')} (редкие)</summary><div class="chips">${fish.filter(([name], i) => i >= 12 && !f.fish.has(name)).map(fishChip).join('')}</div></details>` : ''}
    <h3>Месяц отчёта</h3>
    <div class="months">${MONTHS.map((m, i) => `<button type="button" class="chip ${f.months.has(i + 1) ? 'on' : ''}" data-month="${i + 1}">${m}<span class="n">${monthCounts[i + 1]}</span></button>`).join('')}</div>
    <div class="row" style="margin-top:8px">
      <div class="seg" id="seasonSeg">${[['all', 'Круглый год'], ['ice', '❄ Лёд'], ['open_water', '🌊 Вода']].map(([k, t]) => `<button type="button" data-season="${k}" class="${f.season === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <button type="button" class="chip" data-act="this-month">Этот месяц</button>
    </div>
    <h3>Что показывать</h3>
    ${Object.entries(KINDS).map(([k, v]) => `<label class="check"><input type="checkbox" data-kind="${k}" ${f.kinds.has(k) ? 'checked' : ''}> ${kindSwatch(k)} ${esc(v.label)} <span class="muted small">${kindCounts.get(k) || 0}</span></label>`).join('')}
    <label class="check"><input type="checkbox" id="archiveOn" ${f.archive ? 'checked' : ''}> Показать и устаревшее (архив) ${f.archive ? '' : `<span class="muted small">${stale}</span>`}</label>
    <p class="small muted" style="margin:2px 0 0">Устаревшее — то, что было верно день, неделю или одну зиму: сети и топляки прошлых лет, трещины прошлых зим, давние происшествия. Ничего не удалено: места, где проваливались и отрывало лёд, — в слое «Опасный лёд»; места ловли остаются всегда.</p>
    <details><summary>Ещё фильтры</summary>
      <h3>Достоверность координат</h3>
      ${['A', 'B', 'C'].map((c) => `<label class="check"><input type="checkbox" data-cls="${c}" ${f.cls.has(c) ? 'checked' : ''}> <span class="badge ${c}">${c}</span> <span class="small">${esc(CLASS_TEXT[c])}</span></label>`).join('')}
      <h3>Свежесть</h3>
      <div class="small" id="yearLabel">${f.yearMin ? `отчёты с ${f.yearMin} года` : 'все годы'}</div>
      <input type="range" id="yearMin" min="${minY - 1}" max="${maxY}" step="1" value="${f.yearMin || minY - 1}">
      <h3>Источник</h3>
      <div class="chips">${[...srcCounts.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `<button type="button" class="chip ${f.sources.has(s) ? 'on' : ''}" data-src="${esc(s)}">${esc(s)} <span class="n">${n}</span></button>`).join('')}</div>
      <label class="check"><input type="checkbox" id="coreOnly" ${f.core ? 'checked' : ''}> Только до 55 км от Новой Ладоги</label>
      <label class="check"><input type="checkbox" id="favOnly" ${f.fav ? 'checked' : ''}> Только избранное (${state.fav.size})</label>
      <label class="check"><input type="checkbox" id="depthOnly" ${f.depthOnly ? 'checked' : ''}> Только отчёты с глубиной</label>
    </details>
    <details class="card"><summary>Что на карте</summary>
      <div class="legend">
        <span><span class="pin" style="display:inline-block;width:14px;height:14px;background:#2f9e44"></span> отчёт рыбака, цвет = рыба</span>
        <span><span class="pin multi" style="display:inline-grid;width:18px;height:18px;background:#e0b000">4</span> 4 отчёта в одном месте</span>
        <span><span class="pin A" style="display:inline-block;width:14px;height:14px;background:#f08c00"></span> точный GPS рыбака</span>
        <span><span class="pin obs" style="display:inline-block;width:14px;height:14px;border-color:#748ffc"></span> наблюдение рыбы</span>
        <span>${kindSwatch('launch')} спуск, слип, парковка</span>
        <span>${kindSwatch('structure')} банка, свал, гряда</span>
        <span>${kindSwatch('hazard')} опасность</span>
        <span>${kindSwatch('ice_incident')} случай на льду</span>
      </div>
      <p class="small muted" style="margin-bottom:0">Нажмите на точку — отчёты, координаты и «Вести». Долгое нажатие на карту (правый клик) — поставить свою точку.</p>
    </details>`;
}
// Quick sets of layers: depths for reading the bottom, the fishing of this month, a clean map.
function applyPreset(k) {
  const o = state.overlays;
  for (const x of ['heat', 'seasonZones', 'rules', 'charts', 'chartIso', 'isobaths', 'genshtab', 'radius', 'shade', 'gridIso', 'community', 'satDay', 'vvp']) o[x] = false;
  if (k === 'depth') {
    if (state.ctx.depth?.shade?.url) { o.shade = true; o.gridIso = !!state.ctx.depth?.isolines; } else { o.charts = true; o.chartIso = true; }
    o.lines = true;
    if (map.getZoom() < 12) map.setZoom(12);
    toast('Глубины: заливка и изобаты через 1 м по отметкам карт. Приблизьте — появятся подписи глубин', 5000);
  } else if (k === 'chart') {
    o.charts = true; o.lines = true;
    if (map.getZoom() < 13) map.setZoom(13);
    toast('Навигационные карты ГУНиО. Приблизьте карту, чтобы читать цифры глубин (линейка внизу — 300 м и меньше)', 6000);
  } else if (k === 'now') {
    const mo = new Date().getMonth() + 1;
    state.seasonMonth = mo;
    o.seasonZones = true;
    state.f.months = new Set([mo]); state.f.season = 'all';
    toast(`Рыбалка сейчас: зоны рыбы и отчёты за ${MONTHS_FULL[mo - 1]}`, 4000);
  } else {
    state.f = defaultFilters();
    o.cluster = true; o.lines = true;
    toast('Чистая карта: только точки и фарватеры');
  }
  applyOverlays(); drawSeasonZones(); drawRules(); render();
  refreshLayersSheet();
}
function refreshLayersSheet() {
  const t = topLayer();
  if (t?.key === 'layers') renderModalBody(t, true);
}

/* ---------- search ---------- */
function searchPlaces(q) {
  const t = q.trim().toLowerCase().replace(/ё/g, 'е');
  if (t.length < 2) return [];
  const hit = (name) => String(name || '').toLowerCase().replace(/ё/g, 'е').includes(t);
  const me = typeof geo !== 'undefined' ? geo.me : null;
  const far = (p) => (me ? ` · ${fmtDist(distM(me, p))} от вас` : '');
  const out = [];
  (state.ctx.season_zones || []).forEach((z, i) => { if (hit(z.name)) out.push({ type: 'zone', i, name: z.name, note: `район${far(zoneCenter(z))}`, icon: 'location-on' }); });
  PLACES.forEach((p, i) => { if (hit(p[0])) out.push({ type: 'place', i, name: p[0], note: `место${far({ lat: p[1], lon: p[2] })}`, icon: 'map' }); });
  state.mine.forEach((p) => { if (hit(p.name) || hit(p.note)) out.push({ type: 'mine', i: p.id, name: p.name, note: `моя точка${far(p)}`, icon: 'bookmark' }); });
  (typeof trk !== 'undefined' ? trk.list : []).forEach((tr) => { if (hit(tr.name)) out.push({ type: 'track', i: tr.id, name: tr.name, note: `трек · ${fmtDay(tr.start)}`, icon: 'route' }); });
  state.M.forEach((m, idx) => {
    if (CATCH_KINDS.has(m.kind)) return;
    const r = state.R[m.r[0]];
    if (hit(r.title) || hit(r.comment)) out.push({ type: 'marker', i: idx, name: r.title || KINDS[m.kind].short, note: `${KINDS[m.kind].short}${far(m)}`, icon: m.kind === 'launch' ? 'anchor' : m.kind === 'hazard' ? 'warning' : 'location-on' });
  });
  return out.slice(0, 40);
}
function searchRow(r) {
  return listRow({ icon: r.icon || 'location-on', title: esc(r.name), sub: esc(r.note || ''), attrs: `data-search="${r.type}:${esc(String(r.i))}" data-name="${esc(r.name)}" data-note="${esc(r.note || '')}"` });
}
function searchDefaultHtml() {
  const mo = new Date().getMonth() + 1;
  const recent = store.get('ladoga-recent', []);
  const zones = (state.ctx.season_zones || []);
  return `
    ${listRow({ icon: 'home', title: 'Вся южная Ладога', sub: 'показать район целиком', attrs: 'data-search="region:0"' })}
    ${state.home.name !== HOME_DEFAULT.name ? listRow({ icon: 'home', title: `Мой район: ${esc(state.home.name)}`, attrs: 'data-search="home:0"' }) : ''}
    ${recent.length ? `<h3>Недавние</h3>${recent.map(searchRow).join('')}` : ''}
    ${zones.length ? `<h3>Районы</h3>${zones.map((z, i) => { const { open } = zoneSpecies(z, mo); return searchRow({ type: 'zone', i, name: z.name, note: open.length ? `сейчас: ${open.slice(0, 3).map(shortName).join(', ').toLowerCase()}` : 'район', icon: 'location-on' }); }).join('')}` : ''}
    <h3>Места</h3>${PLACES.map((p, i) => searchRow({ type: 'place', i, name: p[0], note: 'перейти', icon: 'map' })).join('')}`;
}
function openSearch() {
  openModal({
    key: 'search', title: 'Поиск', cls: 'full', replaceable: true,
    body: () => `<div class="search-input"><input type="search" id="searchInput" placeholder="Место, слип, банка, моя точка…" autocomplete="off" enterkeyhint="search" aria-label="Поиск"><button type="button" class="icon-btn" data-act="search-clear" aria-label="Очистить">${ic('close')}</button></div>
      <div id="searchResults">${searchDefaultHtml()}</div>`,
    onShow: () => { const i = $('#searchInput'); if (i && !matchMedia('(pointer: coarse)').matches) i.focus(); else i?.focus({ preventScroll: true }); },
  });
}
function onSearchInput(v) {
  const res = searchPlaces(v);
  $('#searchResults').innerHTML = v.trim().length < 2 ? searchDefaultHtml() : res.length ? res.map(searchRow).join('') : '<p class="muted">Ничего не нашлось.</p>';
}
function pickSearch(el) {
  const [type, id] = el.dataset.search.split(':');
  const name = el.dataset.name, note = el.dataset.note;
  if (['zone', 'place', 'marker', 'mine', 'track'].includes(type)) {
    const recent = store.get('ladoga-recent', []).filter((r) => !(r.type === type && String(r.i) === id));
    recent.unshift({ type, i: id, name, note, icon: el.querySelector('use')?.getAttribute('href')?.slice(3) });
    store.set('ladoga-recent', recent.slice(0, 5));
  }
  setFollowFree();
  if (type === 'zone') showPlace(+id, { replace: true });
  else if (type === 'marker') {
    const m = state.M[+id];
    if (!state.f.kinds.has(m.kind)) { state.f.kinds.add(m.kind); render(); }
    openPoint(+id, { replace: true });
  } else if (type === 'mine') { const p = findMine(id); if (p) openMineCard(p, { replace: true }); }
  else if (type === 'track') openTrackCard(id, { replace: true });
  else {
    closeTop();
    if (type === 'place') { const p = PLACES[+id]; map.setView([p[1], p[2]], p[3]); }
    else if (type === 'region') map.fitBounds(regionBounds(), fitPadding());
    else if (type === 'home') map.fitBounds(homeBounds(), fitPadding());
  }
}

/* ---------- SOS ---------- */
function openSos() {
  const pr = state.ctx.practical || {};
  const em = pr.emergency || {};
  const phones = em.phones || [{ name: 'Единый номер экстренных служб', phone: '112' }];
  openModal({
    key: 'sos', title: 'Экстренная помощь', cls: 'full sos',
    body: () => {
      const me = typeof geo !== 'undefined' ? geo.me : null;
      const from = me || { lat: map.getCenter().lat, lon: map.getCenter().lng };
      const rescue = nearestServices(from, ['rescue'], 3);
      const hosp = nearestServices(from, ['hospital'], 3);
      return `
      <a class="btn sos-call" href="tel:112">${ic('phone-in-talk')}Позвонить 112</a>
      <p class="small muted">112 работает без SIM-карты и без денег на счёте, через любую сеть, которая ловит.</p>
      <button type="button" class="btn danger" data-act="mob" style="width:100%">${ic('warning')}Человек за бортом — вести назад к месту</button>
      <div class="card">
        <b>Где я — продиктуйте спасателям</b>
        ${me ? `<div class="coord big" style="margin-top:4px">${fmtDM(me.lat, me.lon)}</div>
          <div class="coord">${fmtDec(me.lat, me.lon)} · точность ±${Math.round(me.acc || 0)} м${Date.now() - me.t > 60000 ? ` · ${fmtDur(Date.now() - me.t)} назад` : ''}</div>
          <div style="margin-top:4px"><b>${esc(sectorName(me))}</b>; до Новой Ладоги ${fmtDist(distM(me, { lat: 60.1037, lon: 32.294 }))}</div>
          <div class="btns" style="margin-bottom:0"><button type="button" class="btn" data-act="sos-copy">${ic('content-copy')}Скопировать</button><button type="button" class="btn ghost" data-act="sos-share">${ic('share')}Отправить координаты</button></div>`
        : `<p class="small">Геопозиция не включена.</p><div class="btns" style="margin-bottom:0"><button type="button" class="btn" data-act="sos-locate">${ic('my-location')}Определить, где я</button></div>`}
      </div>
      <h3>Телефоны</h3>
      ${phones.map((p) => `<a class="phone-row" href="${esc(telHref(p.phone))}"><b>${esc(p.phone)}</b><span>${esc(p.name || '')}</span></a>`).join('')}
      ${(em.what_to_do || []).length ? `<h3>Что делать</h3>${em.what_to_do.map((w, i) => `<details class="card small" ${i === 0 ? 'open' : ''}><summary>${esc(w.title)}</summary><p>${esc(w.text)}</p></details>`).join('')}` : ''}
      ${rescue.length ? `<h3>Спасатели рядом</h3>${rescue.map((s) => `<div class="card small"><b>${esc(s.title)}</b> · ${fmtDist(s.d)}<br>${esc(s.comment)}<div class="btns" style="margin-bottom:0"><a class="btn small ghost" href="${esc(yandexRoute(s))}" target="_blank" rel="noopener">${ic('directions-car')}Маршрут</a></div></div>`).join('')}` : ''}
      ${hosp.length ? `<h3>Больницы</h3>${hosp.map((s) => `<div class="card small"><b>${esc(s.title)}</b> · ${fmtDist(s.d)}<br>${esc(s.comment)}<div class="btns" style="margin-bottom:0"><a class="btn small ghost" href="${esc(yandexRoute(s))}" target="_blank" rel="noopener">${ic('directions-car')}Маршрут</a></div></div>`).join('')}` : ''}
      ${(pr.coverage || []).length ? `<h3>Связь на воде</h3>${pr.coverage.map((c) => `<p class="small"><b>${esc(c.operator)}</b>: ${esc(c.note)}</p>`).join('')}` : ''}`;
    },
  });
}

/* ---------- help sheets: location, install, keys ---------- */
function showLocationHelp(kind) {
  const ua = navigator.userAgent;
  const { iOS } = platformInfo();
  const chromeIOS = /CriOS/.test(ua), yandex = /YaBrowser/.test(ua);
  const url = location.href.split('#')[0];
  let title = 'Разрешите геопозицию', lead = '', steps = [];
  if (kind === 'unsupported') { title = 'Браузер не сообщает место'; lead = 'Откройте карту в Safari (iPhone), Chrome или Edge.'; }
  else if (kind === 'ios-once') {
    title = 'Чтобы iPhone не спрашивал каждый раз';
    lead = 'iPhone снова спрашивает про геопозицию — значит, в прошлый раз было выбрано «Разрешить один раз». Так он будет спрашивать при каждом запуске.';
    steps = [
      'Когда iPhone спросит, выберите <b>«При использовании приложения»</b> — не «Разрешить один раз».',
      '<b>Настройки → Конфиденциальность и безопасность → Службы геолокации → Сайты Safari</b> → «При использовании приложения» и включите <b>«Точная геопозиция»</b>.',
      '<b>Настройки → Приложения → Safari → Геопозиция → «Разрешить»</b> (в iOS 17 и раньше: Настройки → Safari → Геопозиция).',
      'Если карта стоит на экране «Домой» дважды (например, из разных профилей Safari), у каждой копии своё разрешение — в той, что спрашивает, ответьте «При использовании приложения».',
    ];
  }
  else if (kind === 'inapp') {
    title = iOS ? 'Откройте карту в Safari' : 'Откройте карту в браузере';
    lead = 'Ссылка открылась внутри Telegram или другого приложения. Его встроенный браузер почти никогда не даёт сайтам геопозицию — навигатор там не заработает.';
    steps = iOS
      ? ['Нажмите «Открыть в Safari» ниже.', 'Не открылось — нажмите «⋯» или значок компаса в углу экрана и выберите «Открыть в Safari».', 'В Safari нажмите «Поделиться» → «На экран „Домой“» — карта будет открываться как приложение.']
      : ['Нажмите «⋮» в углу экрана → «Открыть в браузере» (или «в Chrome»).'];
  } else if (iOS) {
    lead = 'iPhone не пускает этот сайт к геопозиции. Проверьте по порядку:';
    steps = [
      '<b>Настройки → Конфиденциальность и безопасность → Службы геолокации</b> — включены.',
      `Там же ниже: <b>${chromeIOS ? 'Chrome' : yandex ? 'Яндекс Браузер' : 'Сайты Safari'}</b> → «При использовании приложения» и включите <b>«Точная геопозиция»</b>.`,
      'В Safari слева в адресной строке нажмите <b>«аА»</b> → <b>«Настройки веб-сайта»</b> → <b>Геопозиция → «Разрешить»</b>.',
      'Вернитесь сюда и нажмите «Попробовать ещё раз».',
    ];
  } else if (platformInfo().android) {
    lead = 'Браузер не пускает этот сайт к геопозиции:';
    steps = [
      'Нажмите на значок слева от адреса → <b>Разрешения → Геоданные → Разрешить</b>.',
      '<b>Настройки → Местоположение</b> телефона — включено; для браузера — «Разрешить во время использования» и «Точное местоположение».',
      'Вернитесь и нажмите «Попробовать ещё раз».',
    ];
  } else {
    lead = 'Браузер не пускает этот сайт к геопозиции:';
    steps = [
      'Нажмите на значок слева от адреса → <b>Разрешения для сайта → Местоположение → Разрешить</b>.',
      'Windows: <b>Параметры → Конфиденциальность и защита → Расположение</b> — включено, и для браузера тоже.',
      'У компьютера без GPS место определяется по Wi‑Fi — приблизительно.',
    ];
  }
  openModal({
    title,
    body: () => `${lead ? `<p>${esc(lead)}</p>` : ''}
      ${steps.length ? `<ol class="small" style="padding-left:18px">${steps.map((x) => `<li style="margin:6px 0">${x}</li>`).join('')}</ol>` : ''}
      <div class="btns">
        ${kind === 'inapp' && iOS ? `<a class="btn" href="x-safari-${esc(url)}">Открыть в Safari</a>` : ''}
        ${kind !== 'unsupported' && kind !== 'ios-once' ? `<button type="button" class="btn" data-act="locate-retry">${ic('my-location')}Попробовать ещё раз</button>` : ''}
        <button type="button" class="btn ghost" data-act="copy-link">Скопировать ссылку</button>
      </div>
      <p class="small muted">Без геопозиции карта, точки, фильтры и GPX работают — не работают только «где я», навигатор и треки.</p>`,
  });
}
// «Сообщить о проблеме»: a few words from the person, and the log of the last 40 minutes goes with them.
function openProblemReport() {
  openModal({
    key: 'report', title: 'Сообщить о проблеме',
    body: () => `<p class="small">Что не получилось или работало не так? Пара слов хватит: «карта прыгает», «не пишется трек», «скорость врёт».</p>
      <textarea id="problemText" rows="4" style="width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink)" placeholder="Что случилось"></textarea>
      <p class="small muted">Вместе с сообщением уйдёт журнал работы за последние 40 минут: нажатия, работа GPS и навигатора, ошибки. Места — с точностью до километра.</p>`,
    foot: () => `<button type="button" class="btn ghost" data-act="close-top">Отмена</button><button type="button" class="btn" data-act="report-send">Отправить</button>`,
  });
  setTimeout(() => $('#problemText')?.focus(), 200);
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Установлено — ищите иконку «Ладога»'); refreshPage('today'); });
async function install() {
  if (installPrompt) { installPrompt.prompt(); try { await installPrompt.userChoice; } catch { /* ignore */ } installPrompt = null; return; }
  showInstallHelp();
}
function showInstallHelp() {
  const { iOS, inApp, android } = platformInfo();
  const url = location.href.split('#')[0].split('?')[0];
  const steps = inApp
    ? [iOS ? 'Нажмите «Открыть в Safari». Не открылось — скопируйте ссылку и вставьте её в адресную строку <b>Safari</b>.' : 'Нажмите «⋮» в углу экрана → «Открыть в браузере» (Chrome).',
       iOS ? 'В Safari нажмите «Поделиться» — квадрат со стрелкой вверх.' : 'В Chrome откройте меню «⋮».',
       iOS ? 'Выберите <b>«На экран „Домой“»</b> и нажмите «Добавить».' : 'Выберите <b>«Установить приложение»</b> или «Добавить на главный экран».']
    : iOS
      ? ['Нажмите «Поделиться» — квадрат со стрелкой вверх (в Safari внизу или вверху экрана).',
         'Прокрутите список и выберите <b>«На экран „Домой“»</b>.',
         'Нажмите «Добавить». Иконка «Ладога» появится на экране как обычное приложение.']
      : android
        ? ['Откройте меню браузера (три точки ⋮).', 'Выберите <b>«Установить приложение»</b> или «Добавить на главный экран».', 'Подтвердите установку.']
        : ['Chrome или Edge: значок установки справа в адресной строке (монитор со стрелкой) или меню «⋯» → <b>«Приложения» → «Установить Ладога»</b>.', 'Приложение откроется в своём окне и появится в меню «Пуск».'];
  openModal({
    title: 'Установить приложение',
    body: () => `<p class="small">После установки карта открывается с иконки, без адресной строки, на весь экран. Скачанный район, точки и справочники работают без интернета.</p>
      ${inApp ? '<div class="card small warn-card"><b>Сейчас открыто не в браузере.</b> Это встроенный браузер Telegram или другого приложения: в нём нет установки и не работает геопозиция. Нужен Safari (iPhone) или Chrome (Android).</div>' : ''}
      <ol class="small" style="padding-left:18px">${steps.map((x) => `<li style="margin:6px 0">${x}</li>`).join('')}</ol>
      <div class="btns">
        ${inApp && iOS ? `<a class="btn" href="x-safari-${esc(url)}">Открыть в Safari</a>` : ''}
        <button type="button" class="btn ghost" data-act="copy-link">Скопировать ссылку</button>
      </div>`,
  });
}
function openKeysHelp() {
  const keys = [['Esc', 'закрыть карточку, лист, режим'], ['+ / −', 'масштаб'], ['← ↑ → ↓', 'сдвинуть карту'], ['F', 'карта на весь экран'], ['L', 'где я'], ['H', 'мой район'], ['N', 'север вверх'], ['M', 'слои и фильтр'], ['/', 'поиск'], ['[', 'свернуть / развернуть панель'], ['1–5', 'разделы: Карта, Сегодня, Клёв, Правила, Моё'], ['?', 'этот список']];
  openModal({
    title: 'Клавиши',
    body: () => `<table class="rules-table">${keys.map(([k, t]) => `<tr><td><b class="coord">${k}</b></td><td>${t}</td></tr>`).join('')}</table>
      <p class="small muted">Работают при любой раскладке. Правый клик по карте — поставить точку или вести сюда.</p>`,
  });
}
// A yes/no sheet instead of window.confirm (which looks foreign in an installed app).
function confirmSheet({ title, text = '', ok = 'Да', okCls = 'danger', cancel = 'Отмена', onOk }) {
  openModal({
    title,
    body: () => (text ? `<p>${text}</p>` : ''),
    foot: () => `<button type="button" class="btn ghost" data-act="close-top">${esc(cancel)}</button><button type="button" class="btn ${okCls}" data-act="confirm-ok">${esc(ok)}</button>`,
    onConfirm: onOk,
  });
}

/* ---------- the dispatcher for buttons in pages, cards and sheets ---------- */
function handleAction(act, el) {
  const d = el.dataset;
  const m = state.selected != null ? state.M[state.selected] : null;
  switch (act) {
    case 'close-top': closeTop(); break;
    case 'confirm-ok': { const t = topLayer(); if (t) t.confirmed = true; closeTop(); break; }
    case 'card-more': toggleCardSize(); break;
    case 'copy-dec': if (m) copy(fmtDec(m.lat, m.lon)); break;
    case 'copy-dm': if (m) copy(fmtDM(m.lat, m.lon)); break;
    case 'copy-text': copy(d.text, 'Скопировано'); break;
    case 'nav': if (m) startNav({ lat: m.lat, lon: m.lon, title: pointTitle(m) }); break;
    case 'fav': if (m) {
      const k = pointKey(m.lat, m.lon);
      if (state.fav.has(k)) state.fav.delete(k); else state.fav.add(k);
      store.set('ladoga-fav', [...state.fav]);
      const on = state.fav.has(k);
      el.classList.toggle('on', on);
      el.innerHTML = `${ic(on ? 'star-fill' : 'star')}<span>${on ? 'Сохранено' : 'Сохранить'}</span>`;
      toast(on ? 'В избранном — Моё › Точки' : 'Убрано из избранного');
      render();
    } break;
    case 'share': if (m) sharePoint(m.lat, m.lon, pointTitle(m)); break;
    case 'point-more': if (m) openPointMenu(m, pointTitle(m)); break;
    case 'share-here': sharePoint(+d.lat, +d.lon, d.name || 'Точка на Ладоге'); break;
    case 'gpx-here': download(`ladoga_${(+d.lat).toFixed(4)}_${(+d.lon).toFixed(4)}.gpx`, gpx([{ lat: +d.lat, lon: +d.lon, name: d.name || 'Ладога' }])); break;
    case 'gpx-filter': download('ladoga_filtered.gpx', gpx(filteredWaypoints())); break;
    case 'gpx-mine': download('ladoga_my_points.gpx', gpx(state.mine.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name, desc: p.note, t: p.t, type: TAGS[p.tag]?.label })))); break;
    case 'new-point': openNewPoint(+d.lat, +d.lon, { replace: true }); break;
    case 'mine-open': { const p = findMine(d.id); if (p) openMineCard(p); break; }
    case 'mine-nav': { const p = findMine(d.id); if (p) startNav({ lat: p.lat, lon: p.lon, title: p.name }); break; }
    case 'mine-share': { const p = findMine(d.id); if (p) sharePoint(p.lat, p.lon, p.name); break; }
    case 'mine-menu': { const p = findMine(d.id); if (p) openMineMenu(p); break; }
    case 'mine-keep': { const p = findMine(d.id); if (p) { const saved = addMine({ lat: p.lat, lon: p.lon, name: 'Точка по ссылке' }); openMineCard(saved, { replace: true }); toast('Сохранено — Моё › Точки'); } break; }
    case 'mine-rename': { const p = findMine(d.id); if (p) openRename(p.name, (name) => { p.name = name; saveMine(); drawMine(); refreshPage('me'); refreshCard(); }); break; }
    case 'mine-del': {
      const p = findMine(d.id);
      if (!p) break;
      const i = state.mine.indexOf(p);
      state.mine.splice(i, 1); saveMine(); drawMine();
      closeAll();
      refreshPage('me');
      toast('Точка удалена', { action: 'Отменить', ms: 10000, onAction: () => { state.mine.splice(i, 0, p); saveMine(); drawMine(); refreshPage('me'); } });
      break;
    }
    case 'show-zone': showZone(d.zone); break;
    case 'play-year': enterSeasonMode(true); break;
    case 'month-filter': enterSeasonMode(false); break;
    case 'chart-show': {
      const parts = chartState.items.filter((c) => c.chart === d.chart);
      if (!parts.length) break;
      state.overlays.charts = true; applyOverlays();
      const b = parts.reduce((acc, c) => acc.extend(c.b), L.latLngBounds(parts[0].bounds));
      closeAll();
      setFollowFree();
      setTimeout(() => map.fitBounds(b, fitPadding()), 50);
      break;
    }
    case 'base-set': setBase(d.base); $$('.base-tile').forEach((b) => b.classList.toggle('on', b.dataset.base === d.base)); break;
    case 'pack-clear': store.set(`ladoga-pack-${d.season}`, []); refreshPage(); break;
    case 'sos': openSos(); break;
    case 'sos-copy': if (geo.me) copy(`${fmtDM(geo.me.lat, geo.me.lon)} (${fmtDec(geo.me.lat, geo.me.lon)})`, 'Координаты'); break;
    case 'sos-share': if (geo.me) {
      const txt = `Нужна помощь. Я на Ладоге: ${fmtDM(geo.me.lat, geo.me.lon)} (${fmtDec(geo.me.lat, geo.me.lon)}), ${sectorName(geo.me)}`;
      if (navigator.share) navigator.share({ text: txt }).catch(() => {}); else copy(txt, 'Текст');
    } break;
    case 'sos-locate': geoStart({ reason: 'sos' }); toast('Определяю место…'); break;
    case 'zone-open': { const z = (state.ctx.season_zones || []).find((x) => x.id === d.zoneId); if (z) openZoneCard(z); break; }
    case 'region-download': runPacks(['core', 'charts'], { refresh: !!packInfo('core')?.complete }); refreshPage('me'); break;
    case 'pack-run': runPacks([d.pack], { refresh: !!packInfo(d.pack)?.complete }); refreshPage('me'); break;
    case 'pack-stop': offline.cancel = true; break;
    case 'pack-delete': confirmSheet({ title: 'Удалить сохранённые карты?', text: 'Приложение, точки и треки останутся. Карты района снова будут грузиться из интернета — на воде без сети их не будет.', ok: 'Удалить', onOk: deletePacks }); break;
    case 'wx-refresh': el.textContent = 'Обновляю…'; loadWeather(true); break;
    case 'place-show': showPlace(+d.zone); break;
    case 'place-nav': { const z = (state.ctx.season_zones || [])[+d.zone]; if (z) { const [la, lo] = zoneAnchor(z); startNav({ lat: la, lon: lo, title: z.name || 'Район' }); } break; }
    case 'zone-nav': startNav({ lat: +d.lat, lon: +d.lon, title: d.name }); break;
    case 'set-home': {
      const z = (state.ctx.season_zones || []).find((x) => x.id === d.zoneId);
      const b = z && zoneBounds(z);
      if (!b) break;
      state.home = { name: z.name, s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
      store.set('ladoga-home', state.home);
      el.classList.add('on'); el.innerHTML = `${ic('home')}<span>Мой район</span>`;
      toast(`Мой район: ${z.name} — кнопка «дом» на карте`);
      break;
    }
    case 'zone-full': {
      // The chosen area on the whole screen; ⌂ comes back to it, «Выйти» to the usual view.
      const z = (state.ctx.season_zones || []).find((x) => x.id === d.zoneId);
      const b = z && zoneBounds(z);
      if (!b) break;
      state.fullArea = b;
      toggleFull({ replace: topLayer()?.kind === 'card' });
      setTimeout(() => map.fitBounds(b, fitPadding(15)), 60);
      break;
    }
    case 'home-reset': state.home = HOME_DEFAULT; store.set('ladoga-home', null); refreshPage('me'); toast('Мой район — вся южная Ладога'); break;
    case 'copy-link': copy(location.href.split('#')[0], 'Ссылка'); break;
    case 'locate-retry': closeTop(); geoRestart(); break;
    case 'geo-off': geoStop(); store.set('ladoga-geo-on', false); toast('Геопозиция выключена'); break;
    case 'ios-geo-help': showLocationHelp('ios-once'); break;
    case 'icez-show': {
      state.overlays.iceZones = true; store.set('ladoga-icez-hand', true); applyOverlays();
      const zs = state.ctx.ice_zones || [];
      if (zs.length) { revealMap(); setTimeout(() => map.fitBounds(L.latLngBounds(zs.map((z) => [z.lat, z.lon])).pad(0.1), fitPadding()), 60); }
      break;
    }
    case 'report-problem': openProblemReport(); break;
    case 'report-send': {
      const text = $('#problemText')?.value || '';
      if (!text.trim()) { toast('Напишите в двух словах, что случилось'); break; }
      el.disabled = true;
      sendProblemReport(text).then((how) => {
        closeTop();
        toast(how === 'server' ? 'Отправлено. Спасибо — разберёмся' : how ? 'Сообщение сохранено — отправьте его в Telegram или почтой' : 'Не получилось отправить — попробуйте, когда будет сеть', 5000);
      });
      break;
    }
    case 'filter-fish': {
      state.f.fish = new Set([d.name]);
      render(); drawSeasonZones();
      revealMap();
      toast(`На карте: ${d.name}`);
      break;
    }
    case 'this-month': state.f.months = new Set([new Date().getMonth() + 1]); render(); refreshLayersSheet(); break;
    case 'filters-reset': resetFilters(); refreshLayersSheet(); break;
    case 'preset': applyPreset(d.preset); break;
    case 'depth-help': openDepthHelp(); break;
    case 'sat-prev': satShift(-1); break;
    case 'sat-next': satShift(1); break;
    case 'sat-bands': SAT_DAY.bands = !SAT_DAY.bands; satDayLayer(); refreshLayersSheet(); break;
    case 'sat-save': saveSatSnapshot(); break;
    case 'car-card': openCarCard(); break;
    case 'ice-place': { closeAll(); setFollowFree(); const la = +d.lat, lo = +d.lon; setTimeout(() => { map.setView([la, lo], 12); selectRing(la, lo); toast(d.name, 6000); }, 60); break; }
    case 'sat-open': state.overlays.satDay = true; SAT_DAY.bands = true; applyOverlays(); closeAll(); if (map.getZoom() > 10) map.setZoom(10); toast('Снимок NASA: лёд бирюзовый, вода чёрная. Дни листаются в «Слоях»', 5000); break;
    case 'cond-tackle': state.tackleFish = d.name; state.tackleSeason = isIceMonth(new Date().getMonth() + 1) ? 'ice' : 'open_water'; showPage('guide', 'tackle'); break;
    case 'install': install(); break;
    case 'keys': openKeysHelp(); break;
    case 'later': store.set(d.key, Date.now() + 7 * 86400000); refreshPage('today'); break;
    case 'search-clear': { const i = $('#searchInput'); if (i) { i.value = ''; onSearchInput(''); i.focus(); } break; }
    default:
      if (typeof handleTrackAction === 'function' && handleTrackAction(act, el)) break;
      if (typeof handleNavAction === 'function') handleNavAction(act, el);
  }
}
// Clicks inside pages, cards and sheets.
function onContentClick(e) {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;
  const f = state.f;
  const toggleSet = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));
  if (t.tagName === 'A' && t.getAttribute('href') === '#') e.preventDefault();
  if (d.pageLink) { showPage(d.pageLink, d.sub); return; }
  if (d.anchor) { document.getElementById(d.anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  if (d.sheetTab) { const l = topLayer(); if (l) { l.tab = d.sheetTab; renderModalBody(l); } return; }
  if (d.pointsFilter) { state.pointsFilter = d.pointsFilter; refreshPage('me'); return; }
  if (d.set) { setSetting(d.set, d.val); $$(`[data-set="${d.set}"]`).forEach((b) => b.classList.toggle('on', b === t)); return; }
  if (d.wxplace) {
    store.set('ladoga-wx-place', d.wxplace);
    state.wxLoading = d.wxplace;
    $$('[data-wxplace]').forEach((b) => b.classList.toggle('on', b === t));
    const note = $('#wxLoading'); if (note) { note.textContent = 'Загружаю погоду…'; note.hidden = false; }
    loadWeather(false);
    return;
  }
  if (d.cond) { store.set('ladoga-cond-fish', d.cond); refreshPage('today'); return; }
  if (d.search) { pickSearch(t); return; }
  if (d.tseason) { state.tackleSeason = d.tseason; refreshPage(); return; }
  if (d.tfish) { state.tackleFish = d.tfish; refreshPage(); return; }
  if (d.openMarker != null) { const idx = +d.openMarker; const mk = state.M[idx]; if (mk) { if (!state.f.kinds.has(mk.kind)) { state.f.kinds.add(mk.kind); render(); } openPoint(idx); } return; }
  if (d.fish) { toggleSet(f.fish, d.fish); t.classList.toggle('on'); render(); drawSeasonZones(); return; }
  if (d.month) { toggleSet(f.months, +d.month); t.classList.toggle('on'); render(); return; }
  if (d.season) { f.season = d.season; $$('#seasonSeg button').forEach((b) => b.classList.toggle('on', b === t)); render(); return; }
  if (d.src) { toggleSet(f.sources, d.src); t.classList.toggle('on'); render(); return; }
  if (d.smonth) { state.seasonMonth = +d.smonth; refreshPage(); drawSeasonZones(); return; }
  if (d.tag && typeof onTagPick === 'function') { onTagPick(d.tag, t); return; }
  if (d.iceKind) { const l = topLayer(); if (l) l.iceKind = d.iceKind; $$('[data-ice-kind]').forEach((b) => b.classList.toggle('on', b === t)); return; }
  if (d.act) handleAction(d.act, t);
}
function onContentChange(e) {
  const t = e.target, f = state.f;
  if (t.dataset.kind) { if (t.checked) f.kinds.add(t.dataset.kind); else f.kinds.delete(t.dataset.kind); render(); }
  else if (t.dataset.cls) { if (t.checked) f.cls.add(t.dataset.cls); else f.cls.delete(t.dataset.cls); render(); }
  else if (t.id === 'coreOnly') { f.core = t.checked; render(); }
  else if (t.id === 'favOnly') { f.fav = t.checked; render(); }
  else if (t.id === 'depthOnly') { f.depthOnly = t.checked; render(); }
  else if (t.id === 'archiveOn') { f.archive = t.checked; render(); refreshLayersSheet(); }
  else if (t.dataset.pack) {
    const [season, i] = t.dataset.pack.split(':');
    const set = new Set(store.get(`ladoga-pack-${season}`, []));
    if (t.checked) set.add(+i); else set.delete(+i);
    store.set(`ladoga-pack-${season}`, [...set]);
  } else if (t.dataset.setting) { setSetting(t.dataset.setting, t.checked); }
  else if (t.hasAttribute('data-night')) { setSetting('theme', t.checked ? 'night' : 'day'); }
  else if (t.dataset.overlay) {
    const k = t.dataset.overlay;
    state.overlays[k] = t.checked;
    if (k === 'cluster') render();
    if (k === 'seasonZones') drawSeasonZones();
    if (k === 'iceZones') store.set('ladoga-icez-hand', true);
    if (k === 'rules') drawRules();
    if (k === 'tracks' && typeof drawSavedTracks === 'function') drawSavedTracks();
    applyOverlays();
    if (k === 'genshtab' || k === 'satDay') refreshLayersSheet();
  }
}
function onContentInput(e) {
  const t = e.target;
  if (t.id === 'markDepth') {
    const layer = topLayer();
    const p = layer?.markId && state.mine.find((x) => x.id === layer.markId);
    if (p) { layer.touched = true; p.depth = parseDepth(t.value); saveMine(); clearTimeout(t._timer); t._timer = setTimeout(() => { drawMine(); drawIsoLabels(); }, 400); }
    return;
  }
  if (t.id === 'whoName') { state.settings.whoName = t.value.trim().slice(0, 40); saveSettings(); return; }
  if (t.id === 'searchInput') onSearchInput(t.value);
  else if (t.id === 'yearMin') {
    const v = +t.value, min = +t.min;
    state.f.yearMin = v > min ? v : 0;
    $('#yearLabel').textContent = state.f.yearMin ? `отчёты с ${state.f.yearMin} года` : 'все годы';
    clearTimeout(t._timer); t._timer = setTimeout(render, 150);
  } else if (t.id === 'chartOpacity') {
    state.chartOpacity = +t.value; store.set('ladoga-chart-opacity', state.chartOpacity); updateCharts();
  } else if (t.id === 'genshtabOpacity') {
    state.genshtabOpacity = +t.value; store.set('ladoga-genshtab-opacity', state.genshtabOpacity);
    layers.genshtab.eachLayer((l) => l.setOpacity(state.genshtabOpacity));
  } else if (t.id === 'overlayOpacity') {
    state.overlayOpacity = +t.value; store.set('ladoga-overlay-opacity', state.overlayOpacity); applyOverlays();
  }
}
function setSetting(key, raw) {
  const s = state.settings;
  const v = typeof raw === 'boolean' ? raw : /^\d+$/.test(String(raw)) ? +raw : raw;
  s[key] = v;
  saveSettings();
  if (key === 'theme') applyTheme();
  if (key === 'keepAwake' && typeof wakeUpdate === 'function') wakeUpdate();
  if (key === 'navShowPoints') applyOverlays();
  if (typeof onSettingChange === 'function') onSettingChange(key);
}
