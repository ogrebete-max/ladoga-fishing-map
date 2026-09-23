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
  if (dep) parts.push(`глубина ${esc(dep.text)}`);
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

/* ---------- Сегодня: warnings, weather, bans, what bites and where, water and ice ---------- */
function todayHtml() {
  const mo = new Date().getMonth() + 1;
  const sp = speciesList();
  const best = sp.filter((s) => activity(s, mo) >= 1).sort((a, b) => activity(b, mo) - activity(a, mo));
  const ice = isIceMonth(mo);
  const hydro = (state.ctx.hydro_calendar || []).find((h) => +h.month === mo);
  const bans = bansToday();
  const zones = (state.ctx.season_zones || []).map((z) => ({ z, ...zoneSpecies(z, mo) })).filter((x) => x.open.length)
    .sort((a, b) => activity(b.open[0], mo) - activity(a.open[0], mo)).slice(0, 5);
  const n = state.R.filter((r) => CATCH_KINDS.has(r.kind) && monthOf(r) === mo).length;
  const date = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const { installed } = platformInfo();
  const later = (k) => Date.now() < store.get(k, 0);
  return `
    <p class="muted" style="margin-top:0">${esc(date[0].toUpperCase() + date.slice(1))} · ${ice ? '❄ лёд' : '🌊 открытая вода'}</p>
    ${!navigator.onLine ? `<div class="card small warn-card">Нет сети${state.wx?.at ? ` · погода от ${fmtTime(state.wx.at)}` : ''}. Карта, точки, справочники и навигатор работают${regionSaved() ? '' : ' там, где карта уже была открыта'}.</div>` : ''}
    ${navigator.onLine && !regionSaved() && !later('ladoga-later-download') ? `<div class="card">
      <b>Скачайте район для работы без сети</b>
      <p class="small">На воде связь пропадает. ~${PACKS[0].estMB() + (PACKS[1].estMB() || 30)} МБ, лучше по Wi‑Fi.</p>
      <div class="btns" style="margin-bottom:0"><button type="button" class="btn" data-page-link="me" data-sub="offline">${ic('download')}Скачать</button><button type="button" class="btn ghost" data-act="later" data-key="ladoga-later-download">Позже</button></div>
    </div>` : ''}
    ${!installed && !later('ladoga-later-install') ? `<div class="card">
      <b>Установите на телефон</b>
      <p class="small">Иконка на экране, карта во весь экран, работа без интернета.</p>
      <div class="btns" style="margin-bottom:0"><button type="button" class="btn" data-act="install">Установить</button><button type="button" class="btn ghost" data-act="later" data-key="ladoga-later-install">Позже</button></div>
    </div>` : ''}
    ${weatherBlock()}
    ${bans.length ? `<div class="card small danger-card"><b>Сегодня действует:</b>${bans.map(banLine).join('')}<div style="margin-top:6px"><button type="button" class="btn small ghost" data-page-link="rules">Размеры, нормы и все правила</button></div></div>` : `<div class="card small ok-card">Сезонных запретов на любительский лов сегодня нет. <button type="button" class="btn small ghost" data-page-link="rules">Размеры и нормы</button></div>`}
    <h3>Что ловится в ${MONTHS_IN[mo - 1]}</h3>
    ${best.length ? `<div class="chips">${best.slice(0, 8).map((s) => `<button type="button" class="chip" data-act="filter-fish" data-name="${esc(speciesKey(s))}"><span class="dot" style="background:${speciesColor(s)}"></span>${esc(shortName(s))} ${dots(activity(s, mo))}</button>`).join('')}</div>` : '<p class="small muted">Справка по рыбе загружается…</p>'}
    ${best[0] && methodFor(best[0], ice) ? `<p class="small"><b>${esc(shortName(best[0]))}:</b> ${esc(methodFor(best[0], ice))}</p>` : ''}
    ${zones.length ? `<h3>Где искать сейчас</h3>${zones.map(({ z, open }) => listRow({ icon: 'location-on', title: esc(z.name), sub: `${open.slice(0, 3).map((s) => esc(shortName(s))).join(', ')}${z.depth_m ? ` · ${esc(z.depth_m)} м` : ''}`, attrs: `data-act="zone-open" data-zone-id="${esc(z.id)}"` })).join('')}` : ''}
    ${hydro ? `<h3>Вода и лёд</h3><p class="small">${esc(hydro.events || '')}</p>` : ''}
    <div class="btns">
      <button type="button" class="btn" data-act="month-filter">${ic('play-arrow')}Отчёты за ${MONTHS_FULL[mo - 1]} на карте (${n})</button>
      <button type="button" class="btn ghost" data-page-link="guide" data-sub="places">Места</button>
      <button type="button" class="btn ghost" data-act="depth-help">Глубины и эхолот</button>
    </div>`;
}
function weatherBlock() {
  const wx = state.wx;
  const place = wxPlace();
  const chips = `<div class="chips" style="margin:6px 0">${WX_PLACES.map((p) => `<button type="button" class="chip ${p.id === place.id ? 'on' : ''}" data-wxplace="${p.id}">${esc(p.name)}</button>`).join('')}</div>`;
  if (!wx?.fc?.current) return `<h3 id="wx">Погода</h3>${chips}<p class="muted">${navigator.onLine ? 'Загружаю прогноз…' : 'Прогноз загрузится, когда появится интернет.'}</p>`;
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
  return `${warnings.map((w) => `<div class="card small wx-${w.level}">${w.level === 'danger' ? '<b>Опасно.</b> ' : ''}${esc(w.text)}</div>`).join('')}
    <h3 id="wx">Погода: ${esc(place.name)}</h3>
    ${chips}
    <div class="wx-now">
      <div class="wx-big">${windArrow(c.wind_direction_10m, 30)}<div><b>${Math.round(c.wind_speed_10m)} м/с</b><span>${rumb(c.wind_direction_10m)}, порывы ${Math.round(c.wind_gusts_10m)}</span></div></div>
      <div class="wx-big"><div><b>${Math.round(c.temperature_2m)}°</b><span>облачность ${Math.round(c.cloud_cover)}%</span></div></div>
    </div>
    <dl class="kv">
      <dt>Давление</dt><dd>${hPaToMm(c.pressure_msl)} мм рт. ст.; за 3 ч ${trend(h.pressure_msl[i0], p3)}, за сутки ${trend(h.pressure_msl[i0], p24)}</dd>
      ${wave != null ? `<dt>Волна</dt><dd>${String(wave.toFixed(1)).replace('.', ',')} м (модель; в губах круче, чем в открытом озере)</dd>` : ''}
      ${sunrise ? `<dt>Солнце</dt><dd>восход ${sunrise.slice(11, 16)}, закат ${sunset ? sunset.slice(11, 16) : '—'}</dd>` : ''}
      <dt>Луна</dt><dd>${moon.name}, освещена на ${moon.illum}%</dd>
    </dl>
    <div class="wx-hours">${hours.map((k) => `<div class="wx-h ${h.wind_speed_10m[k] >= 8 ? 'windy' : ''}">
      <span class="t">${k - i0 < 24 ? '' : 'завтра '}${h.time[k].slice(11, 16)}</span>
      ${windArrow(h.wind_direction_10m[k], 16)}
      <b>${Math.round(h.wind_speed_10m[k])}</b><span class="g">${Math.round(h.wind_gusts_10m[k])}</span>
      <span>${Math.round(h.temperature_2m[k])}°</span>
      <span class="rain">${h.precipitation_probability?.[k] >= 30 ? `${h.precipitation_probability[k]}%` : ''}</span>
    </div>`).join('')}</div>
    <p class="small muted">Ветер в м/с: крупно — средний, мелко — порывы; стрелка — куда дует. Прогноз Open-Meteo, обновлён ${age < 1 ? 'только что' : age < 120 ? `${age} мин назад` : `в ${fmtTime(wx.at)} ${fmtDay(wx.at)}`}. Отжимной для южного берега — ветер с юго-востока, юга и юго-запада.</p>
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
  const incidents = state.R.filter((r) => r.kind === 'ice_incident').length;
  const anchors = [['r-today', 'Сегодня'], ['r-sizes', 'Размеры'], ['r-seasons', 'Сроки'], ['r-areas', 'Запретные места'], ['r-boat', 'Лодка'], ['r-ice', 'Лёд']];
  return `
    <nav class="anchors">${anchors.map(([id, t]) => `<button type="button" data-anchor="${id}">${t}</button>`).join('')}</nav>
    <button type="button" class="card" data-act="sos" style="display:flex;gap:12px;align-items:center"><span class="fab sos" style="flex:none;box-shadow:none">SOS</span><span><b>SOS и телефоны</b><br><span class="small">112, МЧС, ГИМС, больницы рядом и что делать на оторванной льдине</span></span></button>
    <div class="card small">Выжимка из Правил рыболовства Западного бассейна (приказ № 620 в ред. № 747, действует с 01.09.2024 до 01.09.2027). Перед поездкой сверяйтесь с текстом: ${safeUrl(g.url) ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">официальная публикация</a>` : ''}${(g.consolidated_text_urls || []).filter(safeUrl).map((u, i) => ` · <a href="${esc(u)}" target="_blank" rel="noopener">${i ? 'Гарант' : 'КонсультантПлюс'}</a>`).join('')}.</div>
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
    ${incidents ? `<p class="small">На карте ${incidents} ${plural(incidents, 'случай', 'случая', 'случаев')} на льду (оранжевые точки) за 2009–2026: отрывы льдин, провалы, машины под лёд. Это и опасные места, и места, куда массово выходят рыбаки.</p>` : ''}`;
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
    <div class="chips" style="margin:4px 0 8px">${chips.map(([k, t]) => `<button type="button" class="chip ${f === k ? 'on' : ''}" data-points-filter="${k}">${esc(t)}</button>`).join('')}</div>
    ${f === 'all' || f === 'fav' ? `${f === 'all' && favs.length ? '<h3>Избранные отчёты</h3>' : ''}${favs.map(({ m, idx }) => listRow({ icon: 'star-fill', title: esc(pointTitle(m)), sub: `${esc(state.R[m.r[0]].sector || '')}${me ? ` · ${fmtDist(distM(me, m))} от вас` : ''}`, attrs: `data-open-marker="${idx}"` })).join('')}${f === 'fav' && !favs.length ? '<p class="muted">Нажмите «Сохранить» в карточке точки — она появится здесь.</p>' : ''}` : ''}
    ${f !== 'fav' ? `${f === 'all' && mine.length ? '<h3>Мои точки и метки</h3>' : ''}${mine.slice().reverse().map(rowMine).join('')}${!mine.length ? '<p class="muted">Своих точек пока нет. Долгое нажатие на карту (или правый клик) — «Новая точка»; «Метка» при записи трека и в навигаторе сохраняет место сразу.</p>' : ''}` : ''}
    <div class="btns"><button type="button" class="btn small ghost" data-act="gpx-import">${ic('add')}Загрузить GPX</button>${state.mine.length ? `<button type="button" class="btn small ghost" data-act="gpx-mine">${ic('download')}Мои точки в GPX</button>` : ''}</div>
    <p class="small muted">GPX с точками и треками из Garmin, Navionics, OsmAnd, Locus или другого телефона добавится сюда и на карту.</p>`;
}
function offlineHtml() {
  const { iOS, installed } = platformInfo();
  const core = packInfo('core'), charts = packInfo('charts'), detail = packInfo('detail');
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
  return `
    <p class="small">На воде и на льду связь пропадает. Скачайте район заранее по Wi‑Fi — карта, точки, справочники, глубины и навигатор будут работать без сети. Только этот участок Ладоги, без «карты мира».</p>
    <div class="card">
      <b>Район южной Ладоги</b>
      <div id="packMain" style="margin:6px 0">${regionStatus()}</div>
      <div class="small muted">Карта района (спутник: весь район обзорно и берег у мест крупно), навигационные карты глубин, приложение и все данные.</div>
      ${iOS && !installed ? `<div class="card small warn-card" style="margin-top:8px">На iPhone сначала установите приложение на экран «Домой» и качайте в нём: скачанное в Safari в приложение не попадёт. <button type="button" class="btn small ghost" data-act="install">Как установить</button></div>` : ''}
      <div class="btns" style="margin-bottom:0">${mainBtn}</div>
    </div>
    <div class="card">
      <b>Подробная карта у берега</b> <span class="muted small">~${PACKS[2].estMB()} МБ</span>
      <div id="packDetail" class="small" style="margin:6px 0">${running === 'detail' && pr ? progressHtml(pr) : detail ? (detail.complete ? `${ic('check-circle')} Загружена` : `Скачано ${detail.done} из ${detail.total}`) : '<span class="muted">Не скачана</span>'}</div>
      <div class="small muted">Самый крупный масштаб спутника в 1 км от мест рыбалки, слипов и банок. Лучше по Wi‑Fi.</div>
      <div class="btns" style="margin-bottom:0">${running === 'detail' ? `<button type="button" class="btn small ghost" data-act="pack-stop">${ic('pause')}Пауза</button>` : `<button type="button" class="btn small ghost" data-act="pack-run" data-pack="detail">${detail?.complete ? 'Обновить' : detail ? 'Докачать' : 'Скачать'}</button>`}</div>
    </div>
    <h3>Без сети работает</h3>
    <div class="ok-list">${['карта района (скачанная часть)', 'GPS, навигатор, компас', 'треки и метки', 'точки, справочники, правила', 'глубины по навигационным картам'].map((t) => `<div>${ic('check-circle')} ${t}</div>`).join('')}</div>
    <h3>Не работает</h3>
    <div class="ok-list muted">${[`погода${state.wx?.at ? ` (последняя — ${fmtDay(state.wx.at)} ${fmtTime(state.wx.at)})` : ''}`, 'маршрут на машине', 'ссылки на источники'].map((t) => `<div>${ic('cloud-off')} ${t}</div>`).join('')}</div>
    <p class="small muted" id="storageLine"></p>
    <button type="button" class="btn small textdanger" data-act="pack-delete">${ic('delete')}Удалить все сохранённые карты</button>`;
}
function progressHtml(pr) {
  const share = pr.total ? (pr.done + pr.failed) / pr.total : 0;
  const secs = (Date.now() - pr.t0) / 1000;
  const left = share > 0.02 ? Math.round((secs / share - secs) / 60) : null;
  return `<div class="pack-bar"><span style="width:${Math.round(share * 100)}%"></span></div>
    <div class="small">${Math.round(share * 100)} % · ${Math.round(pr.bytes / 1048576)} МБ${left != null ? ` · осталось ~${Math.max(1, left)} мин` : ''}${pr.failed ? ` · не скачалось ${pr.failed}` : ''}</div>`;
}
function onPackProgress() {
  if (!offline.running) { refreshPage('me'); renderChips(); return; }
  const pr = offline.progress;
  const el = $(offline.running === 'detail' ? '#packDetail' : '#packMain');
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
    <div class="small muted" style="margin-top:8px">Автовозврат к лодке после сдвига карты</div>
    ${seg('autoReturn', [[5, '5 с'], [15, '15 с'], [30, '30 с'], [0, 'никогда']], s.autoReturn)}
    <div class="small muted" style="margin-top:8px">Предупреждать о глубине меньше</div>
    ${seg('shallow', [[1, '1 м'], [2, '2 м'], [3, '3 м'], [5, '5 м']], s.shallow)}
    ${sw('autoZoom', 'Автомасштаб', 'Масштаб по скорости и расстоянию до точки')}
    ${sw('sound', 'Звук прибытия и опасности')}
    ${sw('navShowPoints', 'Точки рыбаков в навигации', 'Обычно в навигации они спрятаны')}
    <h3>Мой район</h3>
    <p class="small">${esc(state.home.name)} — кнопка ${ic('home')} на карте показывает его целиком. Сделать своим можно любой район в его карточке.</p>
    ${state.home.name !== HOME_DEFAULT.name ? '<button type="button" class="btn small ghost" data-act="home-reset">Вернуть всю южную Ладогу</button>' : ''}
    <h3>Геопозиция</h3>
    <p class="small">Включается сама, когда нужна: ◎ на карте, «Вести», запись трека.</p>
    <button type="button" class="btn small ghost" data-act="geo-off">${ic('location-disabled')}Выключить геопозицию сейчас</button>
    <h3>Приложение</h3>
    <div class="btns">
      ${installed ? '' : `<button type="button" class="btn small" data-act="install">${ic('download')}Установить на телефон</button>`}
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
    <p class="small muted">Карта: Leaflet (BSD), leaflet-rotate (GPL-3.0), Leaflet.markercluster (MIT), Leaflet.heat (BSD). Подложки: Esri World Imagery, OpenStreetMap, OpenTopoMap, nakarte.me. Навигационные карты ГУНиО МО, Генштаб — сканы из открытых архивов. Не для судовождения.</p>`;
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
      <p class="small">На карте три источника глубин (включаются в «Слоях»): <b>навигационные карты ГУНиО</b> 1:10 000–1:50 000 с тысячами отметок глубин — самое точное; <b>изобаты</b> по этим картам; грубая модель дна GLDB. У каждой точки, в навигаторе и под лодкой показана глубина по картам.</p>
      <div class="card small warn-card">Глубины на картах — от среднего многолетнего уровня озера. В 2026 году вода примерно на 0,9 м ниже, значит реально мельче. Съёмка 1930–80-х годов; не для судовождения.</div>
      <p class="small">Самые свежие глубины — у рыбаков с эхолотами: их собирает Garmin (Quickdraw) и показывает в телефоне бесплатно, но выгрузить их нельзя. Схема такая: <b>глубины — в ActiveCaptain, наши точки — туда же файлом GPX</b>.</p>
      <div class="btns"><button type="button" class="btn small" data-act="gpx-filter">GPX: точки по фильтру</button><a class="btn small ghost" href="downloads/ladoga_points.gpx" download>GPX: все точки</a>${d.isobaths ? '<a class="btn small ghost" href="downloads/ladoga_isobaths_model.gpx" download>Изобаты (модель) в GPX</a>' : ''}</div>
      ${apps.map((a, i) => appCard(a, i === 0)).join('')}
      <h3>Карты ГУНиО на этой карте</h3>
      ${[...new Map(chartState.items.map((c) => [c.chart, c])).values()].sort((a, b) => a.scale - b.scale).map((c) => listRow({ icon: 'map', title: `№ ${esc(c.chart)} ${esc(c.title || '')}`, sub: `1:${Number(c.scale).toLocaleString('ru-RU')}, ${esc(c.year || '')}`, attrs: `data-act="chart-show" data-chart="${esc(c.chart)}"` })).join('')}
      <h3>Банки и мели из лоции</h3>
      <p class="small">${state.M.filter((m) => m.kind === 'structure' || m.kind === 'hazard').length} точек с наименьшими глубинами (Железница 1,2 м, Астречье 0,8 м, Варецкие Луды, Сухская 2,6 м…) видны с масштаба 11, подписи — с 13. В навигации приложение предупреждает о мели впереди по курсу.</p>
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
      <button type="button" class="chip" data-act="preset" data-preset="now">${ic('set-meal')}Рыбалка сейчас</button>
      <button type="button" class="chip" data-act="preset" data-preset="clean">${ic('map')}Чистая карта</button>
    </div>
    <h3 style="margin-top:4px">Подложка</h3>
    <div class="base-tiles">${Object.entries(BASES).map(([k, b]) => `<button type="button" class="base-tile ${state.base === k ? 'on' : ''}" data-act="base-set" data-base="${k}" style="${baseThumb(k) ? `background-image:url('${baseThumb(k)}')` : ''}" title="${esc(b.full || b.name)}">${esc(b.name)}</button>`).join('')}</div>
    <h3>Глубины</h3>
    ${hasCharts ? `<label class="check switch"><span><b>Навигационные карты ГУНиО</b><br><span class="small muted">отметки глубин, изобаты, камни, створы · 1:10 000–1:50 000</span></span><input type="checkbox" data-overlay="charts" ${o.charts ? 'checked' : ''}></label>
      <div class="small muted">Прозрачность карт</div>
      <input type="range" id="chartOpacity" min="0.3" max="1" step="0.05" value="${state.chartOpacity}">` : ''}
    ${state.ctx.depth?.chart_isobaths ? `<label class="check switch"><span>Изобаты 2–30 м по навигационным картам</span><input type="checkbox" data-overlay="chartIso" ${o.chartIso ? 'checked' : ''}></label>` : ''}
    ${state.ctx.depth?.isobaths ? `<label class="check switch"><span>Модель дна GLDB<br><span class="small muted">грубо, ±0,5–1 км, не для навигации</span></span><input type="checkbox" data-overlay="isobaths" ${o.isobaths ? 'checked' : ''}></label>` : ''}
    ${(state.ctx.depth?.overlays || []).length ? `<label class="check switch"><span>Армейская карта 1:100 000<br><span class="small muted">изобаты 2–20 м, камни, отмели · 1970–80-е</span></span><input type="checkbox" data-overlay="genshtab" ${o.genshtab ? 'checked' : ''}></label>
      ${o.genshtab ? `<input type="range" id="genshtabOpacity" min="0.25" max="1" step="0.05" value="${state.genshtabOpacity}">` : ''}` : ''}
    <button type="button" class="btn small ghost" data-act="depth-help">Глубины и эхолот — как пользоваться</button>
    <h3>На карте</h3>
    <label class="check switch"><span>Группировать близкие точки</span><input type="checkbox" data-overlay="cluster" ${o.cluster ? 'checked' : ''}></label>
    <label class="check switch"><span>Сезонные зоны рыбы<br><span class="small muted">месяц: ${MONTHS_FULL[state.seasonMonth - 1]}</span></span><input type="checkbox" data-overlay="seasonZones" ${o.seasonZones ? 'checked' : ''}></label>
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
  for (const r of state.R) kindCounts.set(r.kind, (kindCounts.get(r.kind) || 0) + 1);
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
  for (const x of ['heat', 'seasonZones', 'rules', 'charts', 'chartIso', 'isobaths', 'genshtab', 'radius']) o[x] = false;
  if (k === 'depth') {
    o.charts = true; o.chartIso = true; o.lines = true;
    if (map.getZoom() < 12) map.setZoom(12);
    toast('Глубины: навигационные карты и изобаты. Цифры глубин читаются с масштаба 13–14', 5000);
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
        ${kind !== 'unsupported' ? `<button type="button" class="btn" data-act="locate-retry">${ic('my-location')}Попробовать ещё раз</button>` : ''}
        <button type="button" class="btn ghost" data-act="copy-link">Скопировать ссылку</button>
      </div>
      <p class="small muted">Без геопозиции карта, точки, фильтры и GPX работают — не работают только «где я», навигатор и треки.</p>`,
  });
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
    case 'mine-open': { const p = findMine(d.id); if (p) { revealMap(); openMineCard(p); } break; }
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
      setTimeout(() => { map.fitBounds(b, fitPadding()); if (!chartState.tiles.length) map.setZoom(Math.max(map.getZoom(), parts[0].zmin)); }, 50);
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
    case 'region-download': runPacks(['core', 'charts']); refreshPage('me'); break;
    case 'pack-run': runPacks([d.pack]); refreshPage('me'); break;
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
    case 'geo-off': geoStop(); toast('Геопозиция выключена'); break;
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
  if (d.wxplace) { store.set('ladoga-wx-place', d.wxplace); loadWeather(true); return; }
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
  if (d.act) handleAction(d.act, t);
}
function onContentChange(e) {
  const t = e.target, f = state.f;
  if (t.dataset.kind) { if (t.checked) f.kinds.add(t.dataset.kind); else f.kinds.delete(t.dataset.kind); render(); }
  else if (t.dataset.cls) { if (t.checked) f.cls.add(t.dataset.cls); else f.cls.delete(t.dataset.cls); render(); }
  else if (t.id === 'coreOnly') { f.core = t.checked; render(); }
  else if (t.id === 'favOnly') { f.fav = t.checked; render(); }
  else if (t.id === 'depthOnly') { f.depthOnly = t.checked; render(); }
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
    if (k === 'rules') drawRules();
    if (k === 'tracks' && typeof drawSavedTracks === 'function') drawSavedTracks();
    applyOverlays();
    if (k === 'genshtab') refreshLayersSheet();
  }
}
function onContentInput(e) {
  const t = e.target;
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
