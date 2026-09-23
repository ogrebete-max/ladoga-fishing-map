'use strict';

/* Ладога · рыболовная карта — tracks and marks (design/UX_SPEC.md §9–10).
   A track is written while the app is open and the screen is on (browsers give no location in the
   background); it lives in IndexedDB, is listed in «Моё › Треки» and goes out as GPX. Marks and my points
   are one list (state.mine, localStorage) with tags: поклёвка, улов, зацеп, мель, лунка, другое. */

// IndexedDB «ladoga» v1, store «tracks»; localStorage if the browser refuses IndexedDB (some private modes).
const trackStore = {
  p: null, fb: false,
  open() {
    if (!this.p) this.p = new Promise((res, rej) => {
      if (!('indexedDB' in window)) { rej(new Error('no indexedDB')); return; }
      const r = indexedDB.open('ladoga', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('tracks')) r.result.createObjectStore('tracks', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('blocked'));
    });
    return this.p;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('tracks', mode);
      const q = fn(tx.objectStore('tracks'));
      tx.oncomplete = () => res(q?.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  },
  async all() {
    if (!this.fb) { try { return (await this.run('readonly', (s) => s.getAll())) || []; } catch { this.fb = true; } }
    return store.get('ladoga-tracks-fb', []);
  },
  async put(t) {
    if (!this.fb) { try { await this.run('readwrite', (s) => s.put(t)); return; } catch { this.fb = true; } }
    const l = store.get('ladoga-tracks-fb', []).filter((x) => x.id !== t.id);
    l.push(t); store.set('ladoga-tracks-fb', l);
  },
  async del(id) {
    if (!this.fb) { try { await this.run('readwrite', (s) => s.delete(id)); return; } catch { this.fb = true; } }
    store.set('ladoga-tracks-fb', store.get('ladoga-tracks-fb', []).filter((x) => x.id !== id));
  },
};

const trk = { list: [], cur: null, lastFixT: 0, activeSince: 0, durBefore: 0, dirty: 0, lastSave: 0, line: null };
const TRACK_COLOR = '#e8590c';

/* ---------- numbers ---------- */
function trackDur(t) {
  if (t === trk.cur && t.state === 'rec' && trk.activeSince) return trk.durBefore + (Date.now() - trk.activeSince);
  if (t === trk.cur) return trk.durBefore;
  return t.dur || 0;
}
const trackMarks = (t) => state.mine.filter((p) => p.trackId === t.id);
function trackStats(t) {
  const dur = trackDur(t);
  const avg = t.moving > 60000 ? t.dist / (t.moving / 1000) : dur > 60000 ? t.dist / (dur / 1000) : null;
  return { dur, avg, marks: trackMarks(t).length };
}
function trackMeta(t) {
  const st = trackStats(t);
  return `${fmtDay(t.start)} · ${fmtTime(t.start)}–${fmtTime(t.end || t.start)} · ${fmtDist(t.dist)} · ${fmtDur(st.dur)}${st.marks ? ` · ${st.marks} ${plural(st.marks, 'метка', 'метки', 'меток')}` : ''}`;
}
function statsHtml(t) {
  const st = trackStats(t);
  return `<div class="stat-row">
    <span><b>${fmtDist(t.dist)}</b></span><span><b>${fmtClock(st.dur)}</b></span>
    ${t.moving ? `<span>в движении ${fmtDur(t.moving)}</span>` : ''}
    ${st.avg ? `<span>ср. ${speedValue(st.avg)} ${speedUnit()}</span>` : ''}
    ${t.vmax ? `<span>макс. ${speedValue(t.vmax)} ${speedUnit()}</span>` : ''}
    <span>${st.marks} ${plural(st.marks, 'метка', 'метки', 'меток')}</span>
  </div>`;
}
const trackLatLngs = (t) => t.segs.filter((s) => s.length > 1).map((s) => s.map((p) => [p[0], p[1]]));
function trackBounds(t) {
  const pts = t.segs.flat();
  if (!pts.length) return null;
  return L.latLngBounds(pts.map((p) => [p[0], p[1]]));
}

/* ---------- recording ---------- */
async function saveCurTrack(force = false) {
  const t = trk.cur;
  if (!t) return;
  if (!force && trk.dirty < 20 && Date.now() - trk.lastSave < 30000) return;
  t.dur = trackDur(t);
  trk.dirty = 0; trk.lastSave = Date.now();
  try { await trackStore.put(t); } catch { /* storage full or blocked */ }
}
window.addEventListener('pagehide', () => saveCurTrack(true));
function startRec() {
  if (trk.cur) { openRecSheet(); return; }
  const now = Date.now();
  trk.cur = { id: `t${now}`, name: '', state: 'rec', start: now, end: now, dist: 0, dur: 0, moving: 0, vmax: 0, segs: [[]], color: TRACK_COLOR };
  trk.durBefore = 0; trk.activeSince = now; trk.lastFixT = 0;
  trk.list.unshift(trk.cur);
  saveCurTrack(true);
  geoStart({});
  wakeUpdate();
  toast('Пишу трек. Держите приложение открытым — в фоне браузер трек не пишет', 5000);
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }
  if (geo.me) trackOnFix(geo.me);
  drawCurTrack(); updateTrackUi(); refreshPage('me');
}
function newSegment() {
  const t = trk.cur;
  if (t && t.segs[t.segs.length - 1].length) t.segs.push([]);
}
// Every fix while recording: a point when accuracy ≤ 50 m, ≥ 5 s and ≥ 5 m from the last one (as OsmAnd does).
function trackOnFix(me) {
  const t = trk.cur;
  if (!t || t.state !== 'rec' || (typeof DEMO !== 'undefined' && DEMO.on)) return;
  const now = me.t;
  if (trk.lastFixT && now - trk.lastFixT > 6 * 60000) newSegment(); // a long silence starts a new segment
  trk.lastFixT = now;
  if (me.acc > 50) return;
  const seg = t.segs[t.segs.length - 1];
  const last = seg[seg.length - 1];
  if (last) {
    const dt = now - last[2];
    const d = distM({ lat: last[0], lon: last[1] }, me);
    if (dt < 5000 || d < 5) return;
    t.dist += d;
    if (d / (dt / 1000) >= 0.5) t.moving += dt;
  }
  seg.push([+me.lat.toFixed(6), +me.lon.toFixed(6), now, Math.round(me.acc), geo.sog != null ? +geo.sog.toFixed(2) : null]);
  if (geo.sog != null && geo.sog < 45) t.vmax = Math.max(t.vmax, geo.sog);
  t.end = now;
  trk.dirty += 1;
  saveCurTrack();
  drawCurTrack();
}
// Back from the background: the gap is not counted and the line breaks there.
function trackOnResume(gap) {
  const t = trk.cur;
  if (!t || t.state !== 'rec') return;
  if (trk.activeSince) {
    // the time the page slept is left out of the duration
    const sleptFrom = Date.now() - gap;
    trk.durBefore += Math.max(0, sleptFrom - trk.activeSince);
    trk.activeSince = Date.now();
  }
  newSegment();
  saveCurTrack(true);
}
function pauseRec() {
  const t = trk.cur;
  if (!t || t.state !== 'rec') return;
  t.state = 'paused';
  trk.durBefore += Date.now() - trk.activeSince; trk.activeSince = 0;
  saveCurTrack(true); updateTrackUi(); wakeUpdate(); refreshPage('me');
}
function resumeRec() {
  const t = trk.cur;
  if (!t || t.state === 'rec') return;
  t.state = 'rec'; trk.activeSince = Date.now(); trk.lastFixT = 0;
  newSegment();
  geoStart({});
  saveCurTrack(true); updateTrackUi(); wakeUpdate(); refreshPage('me');
}
function defaultTrackName(t) {
  const first = t.segs.flat()[0];
  const where = first ? placeName({ lat: first[0], lon: first[1] }) : 'Ладога';
  return `${where} · ${fmtDay(t.start)}, ${fmtTime(t.start)}`;
}
function finishRec(name) {
  const t = trk.cur;
  if (!t) return;
  t.state = 'done'; t.name = (name || '').trim() || defaultTrackName(t);
  t.dur = trackDur(t);
  trk.cur = null; trk.durBefore = 0; trk.activeSince = 0;
  trackStore.put(t);
  drawCurTrack(); drawSavedTracks(); updateTrackUi(); wakeUpdate(); refreshPage('me');
  toast('Трек сохранён — он в «Моё › Треки»', { action: 'Все треки', onAction: () => showPage('me', 'tracks') });
}
function deleteTrack(id) {
  const i = trk.list.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [t] = trk.list.splice(i, 1);
  if (trk.cur === t) { trk.cur = null; trk.durBefore = 0; trk.activeSince = 0; wakeUpdate(); }
  trackStore.del(id);
  drawCurTrack(); drawSavedTracks(); updateTrackUi(); refreshPage('me');
  toast('Трек удалён', {
    action: 'Отменить', ms: 10000,
    onAction: () => { if (t.state !== 'done') t.state = 'done'; trk.list.splice(i, 0, t); trackStore.put(t); drawSavedTracks(); refreshPage('me'); },
  });
}

/* ---------- on the map ---------- */
function drawCurTrack() {
  const t = trk.cur;
  if (!t) { layers.trackCur.clearLayers(); trk.line = null; return; }
  const ll = trackLatLngs(t);
  if (!trk.line) { layers.trackCur.clearLayers(); trk.line = L.polyline(ll, { color: TRACK_COLOR, weight: 4, opacity: 0.95, interactive: false }).addTo(layers.trackCur); }
  else trk.line.setLatLngs(ll);
  // Marks of this track stay visible even in navigation, when my other points are put away.
  const n = trackMarks(t).length;
  if (trk.marksDrawn !== n) {
    trk.marksDrawn = n;
    layers.trackCur.eachLayer((l) => { if (l !== trk.line) layers.trackCur.removeLayer(l); });
    for (const p of trackMarks(t)) {
      const tg = TAGS[p.tag] || TAGS.other;
      L.marker([p.lat, p.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: `<div class="mark-dot" style="background:${tg.color}">${esc(tg.glyph)}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(layers.trackCur);
    }
  }
}
function drawSavedTracks() {
  layers.tracks.clearLayers();
  if (!state.overlays.tracks) return;
  for (const t of trk.list) {
    if (t === trk.cur || t.state !== 'done') continue;
    const ll = trackLatLngs(t);
    if (!ll.length) continue;
    L.polyline(ll, { color: TRACK_COLOR, weight: 3, opacity: 0.7 }).on('click', () => openTrackCard(t.id)).addTo(layers.tracks);
  }
}
// What the recording is doing right now: GPS quality, how many points, a warning when nothing comes.
function recGpsHtml() {
  const t = trk.cur;
  if (!t) return '';
  if (typeof DEMO !== 'undefined' && DEMO.on) return '<span class="gps-dot y"></span> Демо: в трек не пишется';
  if (t.state === 'paused') return '<span class="gps-dot"></span> Пауза: точки не пишутся';
  const me = geo.me;
  const n = t.segs.reduce((a, sg) => a + sg.length, 0);
  if (!me) return '<span class="gps-dot r"></span> Жду GPS — трек начнёт писаться, как только телефон найдёт спутники';
  const age = Date.now() - me.t;
  const cls = age > 10000 ? 'r' : me.acc <= 10 ? 'g' : me.acc <= 30 ? 'y' : 'r';
  const gps = age > 10000 ? `нет сигнала ${fmtClock(age)}` : `GPS ±${Math.round(me.acc)} м`;
  return `<span class="gps-dot ${cls}"></span> ${gps} · ${n} ${plural(n, 'точка', 'точки', 'точек')} в треке${me.acc > 50 ? ' · точность слабая, точки ждут' : ''}`;
}
// The pill on the map, the button in navigation, the open recording sheet — once a second.
function updateTrackUi() {
  const t = trk.cur;
  const rec = t?.state === 'rec', paused = t?.state === 'paused';
  document.body.classList.toggle('rec-on', !!t);
  const pill = $('#btnTrack');
  if (pill) {
    pill.classList.toggle('rec', rec); pill.classList.toggle('paused', paused);
    const txt = rec ? (geo.me ? `Запись ${fmtClock(trackDur(t))} · ${fmtDist(t.dist)}` : `Запись ${fmtClock(trackDur(t))} · жду GPS`) : paused ? `Пауза ${fmtClock(trackDur(t))}` : 'Трек';
    const el = $('#trackPillText');
    if (el.textContent !== txt) el.textContent = txt;
    pill.setAttribute('aria-label', rec ? 'Идёт запись трека — управление' : paused ? 'Запись на паузе — управление' : 'Записать трек');
  }
  const nb = $('#navTrack');
  if (nb) {
    nb.classList.toggle('rec', rec);
    const txt = t ? fmtClock(trackDur(t)) : 'Трек';
    const icon = rec ? 'pause' : paused ? 'play-arrow' : 'fiber-manual-record';
    if (nb.dataset.icon !== icon) { nb.dataset.icon = icon; nb.querySelector('use').setAttribute('href', `#i-${icon}`); }
    if ($('#navTrackText').textContent !== txt) $('#navTrackText').textContent = txt;
  }
  if (t) {
    const html = statsHtml(t);
    $$('.rec-stats').forEach((el) => { if (el.innerHTML !== html) el.innerHTML = html; });
    const g = recGpsHtml();
    $$('.rec-gps').forEach((el) => { if (el.innerHTML !== g) el.innerHTML = g; });
  }
}
function onTrackButton() {
  if (!trk.cur) startRec(); else openRecSheet();
}

/* ---------- sheets ---------- */
function openRecSheet(opts = {}) {
  const t = trk.cur;
  if (!t) return;
  openModal({
    key: 'rec',
    title: () => (trk.cur?.state === 'rec' ? 'Идёт запись трека' : 'Запись на паузе'),
    body: () => `<div class="rec-stats">${statsHtml(t)}</div>
      <div class="rec-gps">${recGpsHtml()}</div>
      <div class="tag-grid" style="grid-template-columns:repeat(3,1fr)">
        ${t.state === 'rec' ? `<button type="button" data-act="rec-pause">${ic('pause')}Пауза</button>` : `<button type="button" data-act="rec-resume">${ic('play-arrow')}Продолжить</button>`}
        <button type="button" data-act="rec-mark">${ic('flag')}Метка</button>
        <button type="button" data-act="rec-stop" style="color:var(--danger)">${ic('stop')}Стоп</button>
      </div>
      <button type="button" class="btn ghost" data-act="saver" style="width:100%">${ic('restart-alt')}Погасить экран — запись продолжится</button>
      <p class="small muted">Сайт пишет трек, только пока открыт: не блокируйте телефон кнопкой и не сворачивайте приложение. Чтобы беречь заряд — «Погасить экран»: чёрный экран почти не тратит батарею, двойное касание возвращает карту. Все треки — в «Моё › Треки».</p>`,
  }, opts);
}
function openSaveSheet(opts = {}) {
  const t = trk.cur;
  if (!t) return;
  pauseRec();
  openModal({
    key: 'track-save', title: 'Сохранить трек',
    body: () => `<label class="small muted" for="tsName">Название</label>
      <input type="text" id="tsName" value="${esc(defaultTrackName(t))}" autocomplete="off">
      <div style="margin-top:10px">${statsHtml(t)}</div>
      <div class="btns"><button type="button" class="btn ghost" data-act="track-continue">${ic('play-arrow')}Продолжить запись</button><button type="button" class="btn textdanger" data-act="track-discard">${ic('delete')}Удалить трек</button></div>`,
    foot: () => `<button type="button" class="btn" data-act="track-save">${ic('check-circle')}Сохранить</button>`,
  }, opts);
}
function openTrackCard(id, opts = {}) {
  const t = trk.list.find((x) => x.id === id);
  if (!t) return;
  const b = trackBounds(t);
  openCard({
    key: `track:${id}`, title: t.name || (t === trk.cur ? 'Идущая запись' : 'Трек'), sub: trackMeta(t),
    focus: b ? { bounds: b } : null,
    body: () => `${statsHtml(t)}
      <div class="card-actions">
        <button type="button" class="btn main" data-act="track-share" data-id="${esc(id)}">${ic('share')}GPX</button>
        <button type="button" class="tile-btn" data-act="track-nav-start" data-id="${esc(id)}">${ic('navigation')}<span>К началу</span></button>
        <button type="button" class="tile-btn" data-act="track-menu" data-id="${esc(id)}">${ic('more-horiz')}<span>Ещё</span></button>
      </div>
      ${trackMarks(t).length ? `<h3>Метки</h3>${trackMarks(t).map((p) => listRow({ icon: '', title: `<span class="tag-dot" style="background:${(TAGS[p.tag] || TAGS.other).color}"></span> ${esc(p.name)}`, sub: `${(TAGS[p.tag] || TAGS.other).label} · ${fmtTime(p.t)}`, attrs: `data-act="mine-open" data-id="${esc(p.id)}"` })).join('')}` : ''}`,
    onShow: () => {
      layers.select.clearLayers();
      const ll = trackLatLngs(t);
      if (ll.length) L.polyline(ll, { color: TRACK_COLOR, weight: 5, opacity: 1, interactive: false }).addTo(layers.select);
      const s = t.segs.flat()[0];
      if (s) L.circleMarker([s[0], s[1]], { radius: 6, color: '#fff', weight: 2, fillColor: '#2b8a3e', fillOpacity: 1, interactive: false }).addTo(layers.select);
    },
    onClose: () => layers.select.clearLayers(),
  }, opts);
}
function openTrackMenu(id) {
  const t = trk.list.find((x) => x.id === id);
  if (!t) return;
  openModal({
    title: t.name || 'Трек',
    body: () => `
      ${listRow({ icon: 'map', title: 'Показать на карте', attrs: `data-act="track-show" data-id="${esc(id)}"` })}
      ${listRow({ icon: 'share', title: 'Поделиться GPX', sub: 'в Navionics, OsmAnd, мессенджер', attrs: `data-act="track-share" data-id="${esc(id)}"` })}
      ${t === trk.cur ? '' : listRow({ icon: 'edit', title: 'Переименовать', attrs: `data-act="track-rename" data-id="${esc(id)}"` })}
      ${listRow({ icon: 'delete', title: '<span style="color:var(--danger)">Удалить</span>', attrs: `data-act="track-del" data-id="${esc(id)}"` })}`,
  });
}
function trackGpx(t) {
  const marks = trackMarks(t);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ladoga-fishing-map" xmlns="http://www.topografix.com/GPX/1/1">
${marks.map((p) => `<wpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.t).toISOString()}</time><name>${xmlEsc(p.name)}</name><type>${xmlEsc((TAGS[p.tag] || TAGS.other).label)}</type></wpt>`).join('\n')}
<trk><name>${xmlEsc(t.name || defaultTrackName(t))}</name>
${t.segs.filter((s) => s.length).map((s) => `<trkseg>\n${s.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`).join('\n')}\n</trkseg>`).join('\n')}
</trk>
</gpx>
`;
}
// Thumbnail: the track squeezed into 56×56.
function trackThumb(t) {
  const pts = t.segs.flat();
  if (pts.length < 2) return '<svg class="track-thumb" viewBox="0 0 56 56"></svg>';
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of pts) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
  const k = Math.cos(toRad((s + n) / 2));
  const span = Math.max((n - s), (e - w) * k, 1e-6);
  const step = Math.max(1, Math.floor(pts.length / 80));
  const xy = (p) => `${(4 + ((p[1] - w) * k / span) * 48).toFixed(1)},${(52 - ((p[0] - s) / span) * 48).toFixed(1)}`;
  const d = t.segs.filter((sg) => sg.length > 1).map((sg) => `M${sg.filter((_, i) => i % step === 0 || i === sg.length - 1).map(xy).join('L')}`).join('');
  return `<svg class="track-thumb" viewBox="0 0 56 56"><path d="${d}"/></svg>`;
}
function tracksPageHtml() {
  const t = trk.cur;
  const done = trk.list.filter((x) => x !== t);
  return `
    ${t ? `<div class="card ${t.state === 'rec' ? 'danger-card' : 'warn-card'}">
      <b>${t.state === 'rec' ? '● Идёт запись' : 'Запись на паузе'}</b>
      <div class="rec-stats">${statsHtml(t)}</div>
      <div class="rec-gps">${recGpsHtml()}</div>
      <div class="btns" style="margin-bottom:0">
        ${t.state === 'rec' ? `<button type="button" class="btn ghost" data-act="rec-pause">${ic('pause')}Пауза</button>` : `<button type="button" class="btn ghost" data-act="rec-resume">${ic('play-arrow')}Продолжить</button>`}
        <button type="button" class="btn ghost" data-act="rec-mark">${ic('flag')}Метка</button>
        <button type="button" class="btn danger" data-act="rec-stop">${ic('stop')}Стоп</button>
      </div>
    </div>` : `<button type="button" class="btn" data-act="rec-start" style="width:100%;min-height:56px">${ic('fiber-manual-record')}Начать запись трека</button>`}
    ${done.length ? done.map((x) => `<div class="track-row">
        <button type="button" class="list-row" data-act="track-open" data-id="${esc(x.id)}">${trackThumb(x)}<span class="lr-main"><span class="lr-title">${esc(x.name || defaultTrackName(x))}</span><span class="lr-sub">${esc(trackMeta(x))}</span></span></button>
        <button type="button" class="icon-btn" data-act="track-menu" data-id="${esc(x.id)}" aria-label="Действия с треком">${ic('more-vert')}</button>
      </div>`).join('') : '<p class="muted">Сохранённых треков пока нет. Нажмите «Трек» на карте — запись начнётся сразу.</p>'}
    <label class="check switch"><span>Показывать все треки на карте</span><input type="checkbox" data-overlay="tracks" ${state.overlays.tracks ? 'checked' : ''}></label>
    <div class="btns"><button type="button" class="btn small ghost" data-act="gpx-import">${ic('add')}Загрузить GPX</button>${trk.list.length || state.mine.length ? `<button type="button" class="btn small ghost" data-act="gpx-backup">${ic('download')}Всё моё в GPX</button>` : ''}</div>
    <p class="small muted">Трек пишется, пока приложение открыто и экран включён: браузеры не дают геопозицию в фоне. Поэтому при записи экран не гаснет. Треки хранятся только в этом телефоне — сохраняйте важные в GPX.</p>`;
}

/* ---------- marks and my points ---------- */
// «⚑ Метка»: saved at once where the boat is; a sheet with tags stays 8 s for a tap.
function quickMark() {
  const me = geo.me;
  if (typeof DEMO !== 'undefined' && DEMO.on) { toast('В демо метки не сохраняются'); return; }
  if (!me) { toast('Ещё нет GPS — метку поставить некуда'); return; }
  const p = addMine({ lat: me.lat, lon: me.lon, name: `Метка ${fmtTime(Date.now())}`, tag: 'other', trackId: trk.cur?.id || null });
  drawCurTrack();
  const top = topLayer();
  openModal({
    key: 'mark', title: `Метка ${fmtTime(p.t)} сохранена`, markId: p.id,
    body: () => `<div class="tag-grid">${Object.entries(TAGS).map(([k, t]) => `<button type="button" data-tag="${k}"><span class="tag-dot" style="background:${t.color}"></span>${t.label}</button>`).join('')}</div>
      <input type="text" id="markDepth" inputmode="decimal" placeholder="Глубина по эхолоту, м" autocomplete="off">
      <div class="btns"><button type="button" class="btn ghost" data-act="mark-name">${ic('edit')}Добавить название</button><button type="button" class="btn textdanger" data-act="mark-del">${ic('delete')}Удалить метку</button></div>`,
    onShow: (layer) => {
      layer.timer = setTimeout(() => { if (topLayer() === layer && !layer.touched) closeTop(); }, 8000);
      $('#modal').addEventListener('pointerdown', () => { layer.touched = true; }, { once: true });
    },
    onClose: (layer) => clearTimeout(layer.timer),
  }, { replace: top?.kind === 'modal' });
}
function onTagPick(tag, el) {
  const layer = topLayer();
  if (!layer) return;
  if (layer.markId) {
    const p = state.mine.find((x) => x.id === layer.markId);
    if (p) { p.tag = tag; p.name = `${TAGS[tag].label} ${fmtTime(p.t)}`; saveMine(); drawMine(); trk.marksDrawn = -1; drawCurTrack(); }
    closeTop();
    toast(`Метка: ${TAGS[tag].label}`);
    return;
  }
  if (layer.key === 'new-point') {
    layer.tag = tag;
    $$('#modalBody [data-tag]').forEach((b) => b.classList.toggle('on', b === el));
  }
}
// «Новая точка здесь»: long press on the map, right click, or «Ещё» of a point.
function openNewPoint(lat, lon, opts = {}) {
  openModal({
    key: 'new-point', title: 'Новая точка', tag: 'other', lat, lon,
    body: () => `<p class="coord" style="margin-top:0">${fmtDM(lat, lon)}<br><span class="small muted">${fmtDec(lat, lon)}${geo.me ? ` · ${fmtDist(distM(geo.me, { lat, lon }))} от вас` : ''}${depthAt({ lat, lon }) ? ` · глубина по карте ${esc(depthAt({ lat, lon }).text)}` : ''}</span></p>
      <div class="tag-grid">${Object.entries(TAGS).map(([k, t]) => `<button type="button" data-tag="${k}" class="${k === 'other' ? 'on' : ''}"><span class="tag-dot" style="background:${t.color}"></span>${t.label}</button>`).join('')}</div>
      <input type="text" id="npName" placeholder="Название (можно не писать)" autocomplete="off">
      <input type="text" id="npDepth" inputmode="decimal" placeholder="Глубина по эхолоту, м (можно не писать)" autocomplete="off" style="margin-top:8px">
      <div class="btns"><button type="button" class="btn ghost" data-act="np-nav">${ic('navigation')}Вести сюда</button><button type="button" class="btn ghost" data-act="copy-text" data-text="${esc(`${fmtDM(lat, lon)} (${fmtDec(lat, lon)})`)}">${ic('content-copy')}Координаты</button></div>`,
    foot: () => `<button type="button" class="btn ghost" data-act="close-top">Отмена</button><button type="button" class="btn" data-act="np-save">Сохранить</button>`,
    onConfirm: (layer) => {
      const p = addMine({ lat, lon, name: layer.value || `${TAGS[layer.tag]?.label || 'Точка'} ${fmtDay(Date.now())}`, tag: layer.tag, depth: layer.depth });
      toast('Точка сохранена — Моё › Точки', { action: 'Показать', onAction: () => openMineCard(p) });
      refreshPage('me');
    },
  }, opts);
}
function openRename(current, onSave, opts = {}) {
  openModal({
    key: 'rename', title: 'Название',
    body: () => `<input type="text" id="renameInput" value="${esc(current)}" autocomplete="off">`,
    foot: () => `<button type="button" class="btn ghost" data-act="close-top">Отмена</button><button type="button" class="btn" data-act="rename-save">Сохранить</button>`,
    onShow: () => { const i = $('#renameInput'); i?.focus(); i?.select(); },
    onConfirm: (layer) => { if (layer.value && layer.value.trim()) onSave(layer.value.trim()); },
  }, opts);
}
function handleTrackAction(act, el) {
  const d = el.dataset;
  const t = d.id ? trk.list.find((x) => x.id === d.id) : null;
  const confirmWith = (value) => { const l = topLayer(); if (l) { l.value = value; l.confirmed = true; } closeTop(); };
  switch (act) {
    case 'rec-start': startRec(); break;
    case 'rec-sheet': openRecSheet(); break;
    case 'rec-pause': pauseRec(); if (topLayer()?.key === 'rec') renderModalBody(topLayer()); break;
    case 'rec-resume': resumeRec(); if (topLayer()?.key === 'rec') renderModalBody(topLayer()); break;
    case 'rec-mark': quickMark(); break;
    case 'rec-stop': openSaveSheet({ replace: topLayer()?.kind === 'modal' }); break;
    case 'track-save': {
      const name = $('#tsName')?.value || '';
      const id = trk.cur?.id;
      finishRec(name);
      if (id) openTrackCard(id, { replace: true });
      break;
    }
    case 'saver': showSaver(); break;
    case 'track-continue': closeTop(); resumeRec(); break;
    case 'track-discard': { const id = trk.cur?.id; closeTop(); if (id) deleteTrack(id); break; }
    case 'track-open': if (t) openTrackCard(t.id); break;
    case 'track-show': if (t) openTrackCard(t.id, { replace: true }); break;
    case 'track-menu': if (t) openTrackMenu(t.id); break;
    case 'track-share': if (t) shareFile(`ladoga_${fileStamp(t.start)}.gpx`, trackGpx(t)); break;
    case 'track-rename': if (t) openRename(t.name || defaultTrackName(t), (name) => { t.name = name; trackStore.put(t); refreshPage('me'); refreshCard(); }, { replace: true }); break;
    case 'track-del': if (t) { closeAll(); deleteTrack(t.id); } break;
    case 'track-nav-start': if (t) { const s = t.segs.flat()[0]; if (s) startNav({ lat: s[0], lon: s[1], title: `Начало: ${t.name || 'трек'}` }); } break;
    case 'mark-name': {
      const p = state.mine.find((x) => x.id === topLayer()?.markId);
      if (p) openRename(p.name, (name) => { p.name = name; saveMine(); drawMine(); refreshPage('me'); }, { replace: true });
      break;
    }
    case 'mark-del': {
      const id = topLayer()?.markId;
      const i = state.mine.findIndex((x) => x.id === id);
      if (i < 0) break;
      const [p] = state.mine.splice(i, 1);
      saveMine(); drawMine(); trk.marksDrawn = -1; drawCurTrack();
      closeTop();
      toast('Метка удалена', { action: 'Отменить', ms: 10000, onAction: () => { state.mine.splice(i, 0, p); saveMine(); drawMine(); trk.marksDrawn = -1; drawCurTrack(); } });
      break;
    }
    case 'np-save': { const l = topLayer(); if (l) l.depth = parseDepth($('#npDepth')?.value); confirmWith($('#npName')?.value.trim() || ''); break; }
    case 'depthset-show': { const s = depthSets.list.find((x) => x.id === d.id); if (s) { state.overlays.myDepth = true; applyOverlays(); closeAll(); setFollowFree(); setTimeout(() => map.fitBounds(depthSetBounds(s), fitPadding(16)), 60); } break; }
    case 'depthset-del': {
      const i = depthSets.list.findIndex((x) => x.id === d.id);
      if (i < 0) break;
      const [s] = depthSets.list.splice(i, 1);
      depthSets.del(s.id); applyOverlays(); refreshPage('me');
      toast('Замеры удалены', { action: 'Отменить', ms: 10000, onAction: () => { depthSets.list.splice(i, 0, s); depthSets.put(s); applyOverlays(); refreshPage('me'); } });
      break;
    }
    case 'np-nav': { const l = topLayer(); if (l) startNav({ lat: l.lat, lon: l.lon, title: 'Точка на карте' }); break; }
    case 'rename-save': confirmWith($('#renameInput')?.value || ''); break;
    case 'gpx-import': pickGpx(); break;
    case 'gpx-backup': backupGpx(); break;
    default: return false;
  }
  return true;
}

/* ---------- my depths: echo-sounder readings in marks, and imported soundings (CSV / GPX) ---------- */
// A separate small database, so the tracks database never needs an upgrade.
const depthSets = {
  p: null, list: [],
  open() {
    if (!this.p) this.p = new Promise((res, rej) => {
      if (!('indexedDB' in window)) { rej(new Error('no indexedDB')); return; }
      const r = indexedDB.open('ladoga-depths', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('sets')) r.result.createObjectStore('sets', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.p;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('sets', mode);
      const q = fn(tx.objectStore('sets'));
      tx.oncomplete = () => res(q?.result);
      tx.onerror = () => rej(tx.error);
    });
  },
  async load() { try { this.list = (await this.run('readonly', (s) => s.getAll())) || []; } catch { this.list = []; } this.list.sort((a, b) => b.t - a.t); },
  put(x) { return this.run('readwrite', (s) => s.put(x)).catch(() => toast('Не удалось сохранить замеры в телефоне')); },
  del(id) { return this.run('readwrite', (s) => s.delete(id)).catch(() => {}); },
};
// All my depth readings as label points: imported soundings and marks with a depth.
function myDepthPoints() {
  const out = [];
  for (const s of depthSets.list) for (const [lat, lon, m] of s.pts) out.push({ lat, lon, m });
  for (const p of state.mine) if (p.depth != null && Number.isFinite(+p.depth)) out.push({ lat: p.lat, lon: p.lon, m: +p.depth });
  return out;
}
const parseDepth = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) && x >= 0 && x < 250 ? Math.round(x * 10) / 10 : null; };
// CSV from a sonar app (Deeper and others): columns latitude / longitude / depth in any order and language,
// or just three numbers per line. Feet are converted; readings closer than ~10 m are averaged.
function parseDepthCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = [';', '\t', ','].find((d) => lines[0].includes(d)) || ',';
  const split = (l) => l.split(delim).map((x) => x.trim().replace(/^"|"$/g, ''));
  let head = split(lines[0]).map((h) => h.toLowerCase());
  const col = (...names) => head.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  let iLat = col('latitude', 'lat', 'широта'), iLon = col('longitude', 'lon', 'lng', 'долгота'), iDep = col('depth', 'глубина', 'water depth', 'z');
  let start = 1;
  if (iLat < 0 || iLon < 0 || iDep < 0) {
    const first = split(lines[0]).map((x) => parseFloat(x.replace(',', '.')));
    if (first.length >= 3 && first.slice(0, 3).every(Number.isFinite)) { iLat = 0; iLon = 1; iDep = 2; start = 0; head = []; } else return [];
  }
  const feet = /ft|feet|фут/.test(head[iDep] || '');
  const cells = new Map();
  for (let i = start; i < lines.length; i++) {
    const c = split(lines[i]);
    const lat = parseFloat(String(c[iLat]).replace(',', '.')), lon = parseFloat(String(c[iLon]).replace(',', '.'));
    let dep = parseFloat(String(c[iDep]).replace(',', '.'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(dep)) continue;
    if (feet) dep *= 0.3048;
    dep = Math.abs(dep);
    if (dep > 250 || !MAX_BOUNDS.contains([lat, lon])) continue;
    const key = `${Math.round(lat / 0.00009)}:${Math.round(lon / 0.00018)}`;
    const cell = cells.get(key) || { lat: 0, lon: 0, d: 0, n: 0 };
    cell.lat += lat; cell.lon += lon; cell.d += dep; cell.n += 1;
    cells.set(key, cell);
  }
  return [...cells.values()].map((c) => [+(c.lat / c.n).toFixed(6), +(c.lon / c.n).toFixed(6), Math.round((c.d / c.n) * 10) / 10]);
}
async function addDepthSet(name, pts) {
  if (!pts.length) return null;
  const set = { id: `d${Date.now()}`, name, t: Date.now(), n: pts.length, pts };
  depthSets.list.unshift(set);
  await depthSets.put(set);
  state.overlays.myDepth = true; applyOverlays();
  return set;
}
function depthSetBounds(set) { return L.latLngBounds(set.pts.map((p) => [p[0], p[1]])); }

/* ---------- GPX in and out: points and tracks from a Garmin, Navionics, OsmAnd…; one backup file ---------- */
function pickGpx() {
  const inp = Object.assign(document.createElement('input'), { type: 'file' });
  // iPhone greys out .gpx when a type filter is set: no filter there.
  if (!platformInfo().iOS) inp.accept = '.gpx,.csv,.txt,application/gpx+xml,application/xml,text/xml,text/csv,text/plain';
  inp.onchange = () => { if (inp.files?.[0]) importFile(inp.files[0]); };
  inp.click();
}
// GPX (points, tracks, depths inside) or CSV (sonar soundings).
function importFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const text = String(reader.result || '');
    if (/^\s*</.test(text)) { importGpxText(text, file.name); return; }
    const pts = parseDepthCsv(text);
    if (!pts.length) { toast('В файле нет глубин этого района. Нужны столбцы: широта, долгота, глубина', 7000); return; }
    const set = await addDepthSet(file.name.replace(/\.(csv|txt)$/i, ''), pts);
    refreshPage('me');
    toast(`Загружено ${set.n} ${plural(set.n, 'замер', 'замера', 'замеров')} глубины — слой «Мои замеры глубин»`, { action: 'Показать', onAction: () => { setFollowFree(); map.fitBounds(depthSetBounds(set), fitPadding(16)); } });
  };
  reader.readAsText(file);
}
const TAG_BY_TYPE = Object.fromEntries(Object.entries(TAGS).map(([k, t]) => [t.label.toLowerCase(), k]));
function importGpxText(text, fileName) {
  const file = { name: fileName };
  {
    try {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw new Error('bad xml');
      const txt = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
      const inArea = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && MAX_BOUNDS.contains([lat, lon]);
      let nPts = 0, nTrk = 0, outside = 0;
      const soundings = [];
      // Depth in a waypoint or track point: <depth>, Garmin <gpxx:Depth>, OsmAnd/Locus extensions.
      const gpxDepth = (el) => {
        const hit = [...el.getElementsByTagName('*')].find((x) => /^(depth|gpxx:depth|gpxtpx:depth)$/i.test(x.localName || x.nodeName) || /depth$/i.test(x.localName || ''));
        return hit ? parseDepth(hit.textContent) : null;
      };
      const seen = new Set(state.mine.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`));
      for (const w of doc.getElementsByTagName('wpt')) {
        const lat = +w.getAttribute('lat'), lon = +w.getAttribute('lon');
        if (!inArea(lat, lon)) { outside += 1; continue; }
        const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        state.mine.push({ id: `m${Date.now()}${nPts}${Math.random().toString(36).slice(2, 5)}`, lat: +lat.toFixed(6), lon: +lon.toFixed(6), name: txt(w, 'name') || 'Точка из GPX', t: Date.parse(txt(w, 'time')) || Date.now(), tag: TAG_BY_TYPE[txt(w, 'type').toLowerCase()] || 'other', trackId: null, note: txt(w, 'desc') || txt(w, 'cmt'), depth: gpxDepth(w) });
        nPts += 1;
      }
      for (const el of [...doc.getElementsByTagName('trk'), ...doc.getElementsByTagName('rte')]) {
        const lists = el.tagName === 'rte' ? [el.getElementsByTagName('rtept')] : [...el.getElementsByTagName('trkseg')].map((sg) => sg.getElementsByTagName('trkpt'));
        const segs = [];
        for (const pts of lists) {
          const seg = [];
          for (const p of pts) {
            const lat = +p.getAttribute('lat'), lon = +p.getAttribute('lon');
            if (!inArea(lat, lon)) continue;
            seg.push([+lat.toFixed(6), +lon.toFixed(6), Date.parse(txt(p, 'time')) || 0, null, null]);
            const dp = gpxDepth(p);
            if (dp != null) soundings.push([+lat.toFixed(6), +lon.toFixed(6), dp]);
          }
          if (seg.length > 1) segs.push(seg);
        }
        if (!segs.length) continue;
        let dist = 0;
        for (const sg of segs) for (let i = 1; i < sg.length; i++) dist += distM({ lat: sg[i - 1][0], lon: sg[i - 1][1] }, { lat: sg[i][0], lon: sg[i][1] });
        const times = segs.flat().map((p) => p[2]).filter(Boolean);
        const start = times.length ? Math.min(...times) : Date.now(), end = times.length ? Math.max(...times) : start;
        const t = { id: `t${Date.now()}${nTrk}`, name: txt(el, 'name') || file.name.replace(/\.gpx$/i, ''), state: 'done', start, end, dist, dur: end - start, moving: 0, vmax: 0, segs, color: TRACK_COLOR, imported: true };
        trk.list.push(t); trackStore.put(t);
        nTrk += 1;
      }
      trk.list.sort((a, b) => b.start - a.start);
      saveMine(); drawMine();
      if (nTrk && !state.overlays.tracks) { state.overlays.tracks = true; applyOverlays(); }
      drawSavedTracks();
      if (soundings.length) addDepthSet(`Глубины из ${file.name.replace(/\.gpx$/i, '')}`, soundings).then(() => refreshPage('me'));
      refreshPage('me');
      toast(nPts || nTrk ? `Загружено: ${nPts} ${plural(nPts, 'точка', 'точки', 'точек')}, ${nTrk} ${plural(nTrk, 'трек', 'трека', 'треков')}${soundings.length ? `, ${soundings.length} ${plural(soundings.length, 'замер', 'замера', 'замеров')} глубины` : ''}${outside ? `; вне района пропущено ${outside}` : ''}` : 'В файле нет точек и треков этого района', 6000);
    } catch { toast('Не удалось прочитать файл — нужен GPX или CSV', 5000); }
  }
}
// Everything of mine in one GPX: a backup, or to carry over to a sonar / another phone.
function backupGpx() {
  const done = trk.list.filter((t) => t !== trk.cur);
  const wpts = state.mine.map((p) => `<wpt lat="${p.lat}" lon="${p.lon}">${p.t ? `<time>${new Date(p.t).toISOString()}</time>` : ''}<name>${xmlEsc(p.name)}</name>${p.note ? `<desc>${xmlEsc(p.note)}</desc>` : ''}<type>${xmlEsc((TAGS[p.tag] || TAGS.other).label)}</type></wpt>`).join('\n');
  const trks = done.map((t) => `<trk><name>${xmlEsc(t.name || defaultTrackName(t))}</name>\n${t.segs.filter((sg) => sg.length).map((sg) => `<trkseg>\n${sg.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] ? `<time>${new Date(p[2]).toISOString()}</time>` : ''}</trkpt>`).join('\n')}\n</trkseg>`).join('\n')}\n</trk>`).join('\n');
  shareFile(`ladoga_moe_${fileStamp()}.gpx`, `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ladoga-fishing-map" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n${trks}\n</gpx>\n`);
}

/* ---------- start-up: load, migrate the old single track, offer to continue a broken recording ---------- */
async function loadTracks() {
  let list = [];
  try { list = await trackStore.all(); } catch { list = []; }
  const old = store.get('ladoga-track-v1', null);
  if (old && Array.isArray(old.pts) && old.pts.length > 1) {
    const pts = old.pts;
    const t = { id: `t${pts[0][2] || Date.now()}`, name: `Трек из прошлой версии, ${fmtDay(pts[0][2] || Date.now())}`, state: 'done', start: pts[0][2] || Date.now(), end: pts[pts.length - 1][2] || Date.now(), dist: 0, dur: 0, moving: 0, vmax: 0, segs: [pts.map((p) => [p[0], p[1], p[2], null, null])], color: TRACK_COLOR };
    for (let i = 1; i < pts.length; i++) t.dist += distM({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] });
    t.dur = t.end - t.start;
    list.push(t);
    try { await trackStore.put(t); } catch { /* ignore */ }
  }
  if (old) { try { localStorage.removeItem('ladoga-track-v1'); } catch { /* ignore */ } }
  list.sort((a, b) => b.start - a.start);
  trk.list = list;
  const open = list.find((x) => x.state === 'rec' || x.state === 'paused');
  if (open) {
    trk.cur = open; trk.durBefore = open.dur || 0; trk.activeSince = 0;
    const was = open.state;
    open.state = 'paused';
    showNotice({
      text: was === 'rec' ? `Запись трека прервалась в ${fmtTime(open.end)} — приложение закрылось.` : `Трек на паузе с ${fmtTime(open.end)}.`,
      actions: [['Продолжить запись', () => resumeRec(), true], ['Сохранить трек', () => openSaveSheet()]],
    });
  }
  drawCurTrack(); drawSavedTracks(); updateTrackUi();
  await depthSets.load();
  if (depthSets.list.length) applyOverlays();
}
