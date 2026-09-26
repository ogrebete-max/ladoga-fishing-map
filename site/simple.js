/* «Простой вид» — a trial (26.09.2026). The owner: «человек приехал на рыбалку… не хочет тыкать по всем кнопкам, а
   просто приехать, поставить машину, спустить лодку, выбрать маршрут; может быть, посмотреть погоду и запреты».
   On the map: one line of the day (can one go out, the bans; on the ice — how dangerous), the car, and one big button
   for the next step of the day: «Куда плыть?» («Куда идти?» on the ice), then «Назад по треку» / «К машине по треку»
   once away from where the track began. The layers sheet has three pictures of the map and five switches; «Сегодня»,
   «Правила» and the settings show what matters first and fold the rest. Nothing is taken out of the app — all of it is
   one tap deeper; SOS, «Человек за бортом», «Назад по треку», «К машине», «Сторож места», «Опасный лёд» are never put
   away. On only through the link ?view=simple (?view=full turns it off) until the owner decides: the others see the
   app as it was. research/simple_mode.md */

const isSimple = () => state.settings.view === 'simple';
const viewTrial = () => store.get('ladoga-view-trial', false);
const iceNow = () => isIceMonth(new Date().getMonth() + 1);
const whereWord = () => (iceNow() ? 'Куда идти?' : 'Куда плыть?');

// The link turns the trial on or off; the parameter is taken out of the address so a shared link does not carry it.
(function viewFromLink() {
  const q = new URLSearchParams(location.search).get('view');
  if (q !== 'simple' && q !== 'full') return;
  store.set('ladoga-view-trial', true);
  state.settings.view = q;
  saveSettings();
  const u = new URL(location.href);
  u.searchParams.delete('view');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  if (typeof logEvent === 'function') logEvent('view', { v: q, from: 'link' });
})();

function applyView() {
  document.body.dataset.view = isSimple() ? 'simple' : 'full';
  renderChips();
  updateGoBtn();
  const top = topLayer();
  if (top?.kind === 'page') renderPage(top, true);
  else if (top?.kind === 'modal' && top.key === 'layers') renderModalBody(top, true);
}

/* ---------- the day in one line ---------- */
// level: 0 можно, 1 осторожно, 2 нельзя / опасно, null — not known (no forecast, or no boat chosen and no warning).
function dayVerdict() {
  const now = Date.now(), ice = iceNow();
  const warns = state.wx?.fc ? wxWarnings(state.wx) : [];
  const danger = warns.find((w) => w.level === 'danger'), warn = warns.find((w) => w.level === 'warn');
  const mchs = typeof officialWarnings === 'function' ? officialWarnings() : [];
  const bans = bansToday();
  const fish = [...new Set(bans.filter((b) => !isMotorBan(b)).map((b) => String(b.species || 'все виды').replace(/\s*\(.*?\)\s*/g, ' ').trim().toLowerCase()).filter(Boolean))];
  const motor = motorBanParts(bans.filter(isMotorBan)).seasonal.size > 0;
  const o = state.wx?.fc ? wxOver(now, now + 3 * 3600000) : null;
  const d = { ice, warns, danger, warn, mchs, fish, motor, o, wave: null, level: null, word: '', short: '' };
  if (ice) {
    // On the ice the app never says «можно»: nobody sees the ice from a phone.
    const risks = typeof iceRisks === 'function' ? iceRisks() : [];
    d.risks = risks;
    const bad = !!danger || risks.some((r) => r.level === 'danger') || mchs.some((w) => w.emergency);
    d.level = bad ? 2 : 1;
    d.word = bad ? 'Лёд: опасно' : 'Лёд: осторожно';
    d.short = danger?.short || (risks.length ? `${risks.length} ${plural(risks.length, 'признак', 'признака', 'признаков')} опасности` : 'смотрите лёд сами');
    return d;
  }
  if (!o) { d.word = navigator.onLine ? 'Прогноз загружается' : 'Нет прогноза'; return d; }
  const boat = state.settings.boat, place = wxPlace();
  d.wave = typeof shoreWave === 'function' ? shoreWave(place.lat, place.lon, o.dir, o.wind, o.k) : null;
  const v = boat ? boatVerdict(boat, o.wind, o.gust, d.wave?.hs) : null;
  let level = v ? v.level : null;
  if (danger) level = 2;
  else if (warn) level = Math.max(level ?? 1, 1);
  d.level = level;
  d.wind = `${rumb(o.dir)} ${o.wind} м/с${o.gust >= o.wind + 3 ? `, порывы ${o.gust}` : ''}`;
  d.word = level == null ? 'Можно ли выходить?' : ['Можно выходить', 'Осторожно', 'Лучше не выходить'][level];
  d.short = d.wind;
  return d;
}
function dayChipHtml() {
  const d = dayVerdict();
  const cls = d.level == null ? '' : ['ok', 'warn', 'danger'][d.level];
  const icon = d.ice ? ic('ac-unit') : d.level === 0 ? ic('check-circle') : d.level ? ic('warning') : '';
  const ban = d.fish.length ? ' · запрет' : '';
  return `<button type="button" class="schip day ${cls}" data-chip="day" aria-label="Сегодня: ${esc(d.word)}">${icon}${esc(d.word)}${d.short ? ` · ${esc(d.short)}` : ''}${ban}</button>`;
}
function openDaySheet() {
  openModal({
    key: 'day', title: iceNow() ? 'Сегодня на льду' : 'Сегодня на воде', cls: 'day-sheet',
    body: () => daySheetHtml(),
    foot: () => `<button type="button" class="btn ghost" data-act="close-top">Закрыть</button><button type="button" class="btn" data-act="where-open">${ic('near-me')}${whereWord()}</button>`,
  });
}
function daySheetHtml() {
  const d = dayVerdict();
  const cls = d.level == null ? '' : ['v-ok', 'v-warn', 'v-bad'][d.level];
  const rows = [`<div class="day-big ${cls}">${esc(d.word)}</div>`];
  if (!d.ice && d.o) {
    rows.push(`<div class="day-row"><b>Ветер</b><span>${esc(d.wind || '')}${d.wave ? `; волна у берега ≈ ${fmtM(d.wave.hs)} м` : ''} <span class="muted small">— ближайшие 3 часа</span></span></div>`);
    const boat = state.settings.boat;
    rows.push(`<div class="day-row"><b>Лодка</b><span>${boat ? '' : '<span class="small">На чём вы выходите? Скажу, можно ли:</span>'}<div class="seg boat-seg">${Object.entries(BOATS).map(([k, b]) => `<button type="button" data-set="boat" data-val="${k}" class="${boat === k ? 'on' : ''}">${b.name}</button>`).join('')}</div></span></div>`);
  }
  // (On the ice the offshore wind is one of the ice risks below too: once.)
  for (const w of [d.danger, d.warn].filter((w) => w && !(d.risks || []).some((r) => r.text === w.text))) rows.push(`<div class="card small wx-${w.level}">${ic('warning')} ${esc(w.text)}</div>`);
  if (d.ice) {
    rows.push(d.risks.length ? d.risks.map((r) => `<div class="card small wx-${r.level === 'danger' ? 'danger' : 'warn'}">${esc(r.text)}</div>`).join('')
      : '<p class="small">По прогнозу явных признаков опасности нет. Это не гарантия: смотрите лёд сами, пешнёй — перед каждым шагом на незнакомом месте.</p>');
  }
  for (const w of d.mchs) rows.push(`<div class="card small wx-${w.emergency ? 'danger' : 'warn'}">${ic('warning')} <b>МЧС: ${esc(w.title)}</b></div>`);
  rows.push(`<div class="day-row"><b>Запреты</b><span>${d.fish.length ? `<span class="v-bad">ловить нельзя: ${esc(d.fish.join(', '))}</span>` : 'на любительский лов сегодня нет'}${d.motor ? '<br><span class="v-bad">с моторной лодки ловить нельзя в части районов</span>' : ''}</span></div>`);
  const bite = condSpecies(new Date().getMonth() + 1).filter((c) => c.act >= 2).sort((x, y) => y.act - x.act).slice(0, 4).map((c) => c.key.toLowerCase());
  if (bite.length) rows.push(`<div class="day-row"><b>Клюёт</b><span>${esc(bite.join(', '))}</span></div>`);
  rows.push(`<div class="btns"><button type="button" class="btn small ghost" data-act="day-weather">${ic('sunny')}Погода по часам</button><button type="button" class="btn small ghost" data-page-link="rules">${ic('gavel')}Правила: размеры и нормы</button></div>`);
  return rows.join('');
}

/* ---------- «Куда плыть?» ---------- */
function whereFrom() {
  const me = geo.me && Date.now() - geo.me.t < 300000 ? geo.me : null;
  if (me) return { p: me, gps: true };
  const c = map.getCenter();
  return { p: { lat: c.lat, lon: c.lng }, gps: false };
}
function whereRow({ title, sub, act, attrs = '', mapAct = '', mapAttrs = '' }) {
  return `<div class="where-row"><div class="wr-text"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>
    ${mapAct ? `<button type="button" class="icon-btn" data-act="${mapAct}" ${mapAttrs} aria-label="Показать на карте">${ic('map')}</button>` : ''}
    <button type="button" class="btn small" data-act="${act}" ${attrs}>${ic('navigation')}Вести</button></div>`;
}
function whereHtml() {
  const { p, gps } = whereFrom();
  const mo = new Date().getMonth() + 1, ice = iceNow();
  const zones = (state.ctx.season_zones || []).map((z, i) => {
    const [la, lo] = zoneAnchor(z);
    return { z, i, open: zoneSpecies(z, mo).open, d: distM(p, { lat: la, lon: lo }) };
  }).filter((x) => x.open.length).sort((a, b) => a.d - b.d).slice(0, 5);
  const mine = state.mine.filter((m) => m.lat != null).map((m) => ({ m, d: distM(p, m) })).sort((a, b) => a.d - b.d).slice(0, 5);
  const launches = ice ? [] : state.M.map((m, idx) => ({ m, idx })).filter((x) => x.m.kind === 'launch')
    .map((x) => ({ ...x, d: distM(p, x.m) })).sort((a, b) => a.d - b.d).slice(0, 3);
  return `
    ${gps ? '' : `<div class="card small warn-card">GPS не включён — расстояния от середины карты. <button type="button" class="btn small ghost" data-act="where-gps">${ic('my-location')}Где я</button></div>`}
    <h3 style="margin-top:4px">Где клюёт в ${MONTHS_IN[mo - 1]} — ближе всего</h3>
    ${zones.length ? zones.map((x) => whereRow({
    title: esc(x.z.name || 'Район'),
    sub: `${fmtDist(x.d)} · ловят: ${x.open.slice(0, 3).map((s) => esc(shortName(s).toLowerCase())).join(', ')}${x.z.depth_m ? ` · глубины ${esc(x.z.depth_m)} м` : ''}`,
    act: 'place-nav', attrs: `data-zone="${x.i}"`, mapAct: 'where-place-show', mapAttrs: `data-zone="${x.i}"`,
  })).join('') : '<p class="small muted">В этом месяце в районах из справочника рыбу не ловят (нерест, запреты).</p>'}
    ${mine.length ? `<h3>Мои места</h3>${mine.map((x) => whereRow({ title: esc(x.m.name || 'Моя точка'), sub: fmtDist(x.d), act: 'mine-nav', attrs: `data-id="${esc(x.m.id)}"` })).join('')}` : ''}
    ${launches.length ? `<h3>Спуск на воду рядом</h3>${launches.map((x) => whereRow({ title: esc(pointTitle(x.m)), sub: fmtDist(x.d), act: 'where-point-nav', attrs: `data-idx="${x.idx}"` })).join('')}` : ''}
    <p class="small muted">Или нажмите на любую точку на карте — в её карточке тоже есть «Вести». Путь записывается сам, по нему вернётесь тем же путём.</p>`;
}
function openWhereSheet() {
  openModal({ key: 'where', title: whereWord(), cls: 'where-sheet', body: () => whereHtml() });
}

/* ---------- the big button: the next step of the day ---------- */
function goState() {
  if (!isSimple() || nav.on || document.body.dataset.mode !== 'browse') return null;
  const me = geo.me && Date.now() - geo.me.t < 120000 ? geo.me : null;
  const t = trk.cur;
  if (t && t.state === 'rec' && me) {
    const first = t.segs.flat()[0];
    if (first && distM(me, { lat: first[0], lon: first[1] }) > 300) {
      const car = typeof carTrack === 'function' && carTrack();
      return { act: car ? 'car' : 'back', label: car ? 'К машине по треку' : 'Назад по треку', icon: 'restart-alt' };
    }
  }
  return { act: 'where', label: whereWord(), icon: 'near-me' };
}
function updateGoBtn() {
  const b = $('#btnGo');
  if (!b) return;
  const s = goState();
  b.hidden = !s;
  if (!s) return;
  const html = `${ic(s.icon)}<span>${s.label}</span>`;
  if (b.dataset.html !== html) { b.dataset.html = html; b.innerHTML = html; }
  b.dataset.go = s.act;
}
$('#btnGo')?.addEventListener('click', () => {
  const a = $('#btnGo').dataset.go;
  if (typeof logEvent === 'function') logEvent('tap', { id: `go-${a}` });
  if (a === 'where') openWhereSheet();
  else if (a === 'car') goToCar();
  else if (a === 'back') { const tr = retraceTrack(); if (tr) startRetrace(tr); }
});
setInterval(() => { if (!document.hidden) updateGoBtn(); }, 2000);

/* ---------- the layers sheet: three pictures and five switches ---------- */
function simpleMapKind() {
  const o = state.overlays;
  if (state.base === 'osm') return 'scheme';
  if (state.base === 'sat' && o.shade && !o.charts) return 'shade';
  if (state.base === 'sat' && o.charts) return 'charts';
  return '';
}
function simpleLayersHtml() {
  const o = state.overlays, k = simpleMapKind();
  const tiles = [['charts', 'Спутник и карта глубин', 'цифры глубин, мели и камни с морских карт — видны при приближении'],
    ['shade', 'Глубины цветом', 'светлое — мелко, тёмное — глубоко'],
    ['scheme', 'Схема', 'дороги и посёлки: доехать до спуска']];
  const more = Object.keys(o).length;
  return `
    <div class="simple-maps">${tiles.map(([v, t, s]) => `<button type="button" class="list-row ${k === v ? 'on' : ''}" data-act="simple-map" data-val="${v}" aria-pressed="${k === v}">${ic(k === v ? 'check-circle' : 'map')}<span class="lr-main"><span class="lr-title">${t}</span><span class="lr-sub">${s}</span></span></button>`).join('')}</div>
    <h3>На карте</h3>
    <label class="check switch"><span><b>Протоки и тростник</b><br><span class="small muted">протоки синим — сверяйтесь со снимком</span></span><input type="checkbox" data-overlay="reeds" ${o.reeds ? 'checked' : ''}></label>
    <label class="check switch"><span>Мои точки (${state.mine.length})</span><input type="checkbox" data-overlay="mine" ${o.mine ? 'checked' : ''}></label>
    <label class="check switch"><span>Запретные районы</span><input type="checkbox" data-overlay="rules" ${o.rules ? 'checked' : ''}></label>
    ${(state.ctx.ice_zones || []).length ? `<label class="check switch"><span><b>Опасный лёд</b><br><span class="small muted">где проваливались и отрывало льдины</span></span><input type="checkbox" data-overlay="iceZones" ${o.iceZones ? 'checked' : ''}></label>` : ''}
    <button type="button" class="btn small ghost" data-act="layers-all" style="margin-top:10px">${ic('layers')}Все слои и фильтр (${more})</button>`;
}
function setSimpleMap(v) {
  const o = state.overlays;
  if (v === 'scheme') { setBase('osm'); o.charts = false; o.shade = false; o.gridIso = false; }
  else {
    if (state.base !== 'sat') setBase('sat');
    if (v === 'shade') { o.charts = false; o.shade = true; o.gridIso = !!state.ctx.depth?.isolines; }
    else { o.charts = true; o.shade = false; o.gridIso = false; }
  }
  applyOverlays();
  refreshLayersSheet();
}

/* ---------- actions ---------- */
function simpleAction(act, el) {
  const d = el.dataset;
  switch (act) {
    case 'where-open': openWhereSheet(); return true;
    case 'where-gps': closeTop(); locate(); return true;
    case 'where-point-nav': { const m = state.M[+d.idx]; if (m) startNav({ lat: m.lat, lon: m.lon, title: pointTitle(m) }); return true; }
    case 'where-place-show': closeTop(); handleAction('place-show', el); return true;
    case 'day-weather': showPage('today'); setTimeout(() => document.getElementById('wx')?.scrollIntoView({ block: 'start' }), 80); return true;
    case 'simple-map': setSimpleMap(d.val); return true;
    case 'layers-all': { const t = topLayer(); if (t?.key === 'layers') { t.all = true; shown.modal = null; renderModal(t); } return true; }
    default: return false;
  }
}

applyView();
