#!/usr/bin/env node
/* «Назад по треку» (site/retrace.js) on a day like the owner's (26.09.2026): out from the launch along a winding
   channel in the reeds (15 m wide, a bend every 60–80 m), across open water to the spot, an hour of fishing and
   drifting, a stretch not recorded (the phone locked in the channel), GPS noise ±3 m, a point every second as the
   recorder writes them. Then the way back: a boat that steers at the arrow must stay inside the channel all the way
   and come out at the launch.

   node scripts/qa/test_retrace.js            (exit code 1 on a failure)
*/
'use strict';
const path = require('path');
const assert = require('assert');
const rt = require(path.join(__dirname, '..', '..', 'site', 'retrace.js'));

const LAT0 = 60.10, LON0 = 32.30, M_PER_DEG = 6371008.8 * Math.PI / 180;
const K = Math.cos(LAT0 * Math.PI / 180);
const ll = (x, y) => ({ lat: LAT0 + y / M_PER_DEG, lon: LON0 + x / (M_PER_DEG * K) });
const xy = (p) => ({ x: (p.lon - LON0) * M_PER_DEG * K, y: (p.lat - LAT0) * M_PER_DEG });
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i += 1) s += rnd(); return (s - 3) / 0.7071; }; // ≈ N(0,1)
const segDist = (p, a, b) => {
  const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
};
const toLine = (p, line) => { let d = Infinity; for (let i = 0; i < line.length - 1; i += 1) d = Math.min(d, segDist(p, line[i], line[i + 1])); return d; };
// GPS error the way a phone has it: a slow wander (σ 3 m, ~20 s memory) plus a little jitter; `white` — the harsh
// case of a fresh error every second.
function gpsNoise({ sigma = 3, rho = 0.95, jitter = 0.7, white = false } = {}) {
  if (white) return () => ({ x: sigma * gauss(), y: sigma * gauss() });
  let nx = sigma * gauss(), ny = sigma * gauss();
  const s = sigma * Math.sqrt(1 - rho * rho);
  return () => { nx = rho * nx + s * gauss(); ny = rho * ny + s * gauss(); return { x: nx + jitter * gauss(), y: ny + jitter * gauss() }; };
}

// The true way out, in metres from the launch: a winding channel 2.2 km north-east, then 2 km of open water.
const CHANNEL = [];
{
  let x = 0, y = 0, h = 20;
  CHANNEL.push({ x, y });
  const bends = [55, -60, 70, -45, 80, -75, 35, -50, 65, -70, 40, -55, 75, -60, 50, -40, 60, -65, 45, -35, 30, -55, 70, -40, 55, -50, 25, -45, 60, -30];
  for (const b of bends) {
    const len = 60 + rnd() * 20;
    for (let s = 0; s < len; s += 4) { x += 4 * Math.sin(h * Math.PI / 180); y += 4 * Math.cos(h * Math.PI / 180); CHANNEL.push({ x, y }); }
    // a bend: the heading turns by b over ~12 m
    for (let s = 0; s < 3; s += 1) { h += b / 3; x += 4 * Math.sin(h * Math.PI / 180); y += 4 * Math.cos(h * Math.PI / 180); CHANNEL.push({ x, y }); }
  }
}
const chEnd = CHANNEL[CHANNEL.length - 1];
const OPEN = [];
for (let s = 4; s <= 2000; s += 4) OPEN.push({ x: chEnd.x + s * 0.6, y: chEnd.y + s * 0.8 });
const SPOT = OPEN[OPEN.length - 1];
const TRUE_OUT = CHANNEL.concat(OPEN);
const channelLen = CHANNEL.reduce((a, p, i) => (i ? a + Math.hypot(p.x - CHANNEL[i - 1].x, p.y - CHANNEL[i - 1].y) : 0), 0);

// The recorder (site/tracks.js trackOnFix): a fix a second, a point when ≥ 1 s and ≥ 4 m (≥ 10 m when slow) from
// the last; a new segment after the phone slept. Here: 18 km/h out, 90 s not recorded in the middle of the channel,
// an hour of fishing and drifting within ~40 m of the spot.
function record() {
  const segs = [[]];
  let t = Date.parse('2026-09-26T06:00:00Z'), last = null;
  const noise = gpsNoise();
  const put = (truth, slow) => {
    const e = noise();
    const p = { x: truth.x + e.x, y: truth.y + e.y };
    t += 1000;
    if (last && (Math.hypot(p.x - last.x, p.y - last.y) < (slow ? 10 : 4))) return;
    const g = ll(p.x, p.y);
    segs[segs.length - 1].push([+g.lat.toFixed(6), +g.lon.toFixed(6), t, 4, slow ? 0.3 : 5]);
    last = p;
  };
  // along the way out at 5 m/s: resample the true line every 5 m
  const way = [];
  for (let i = 1; i < TRUE_OUT.length; i += 1) {
    const a = TRUE_OUT[i - 1], b = TRUE_OUT[i], l = Math.hypot(b.x - a.x, b.y - a.y);
    for (let s = 0; s < l; s += 5) way.push({ x: a.x + (b.x - a.x) * s / l, y: a.y + (b.y - a.y) * s / l });
  }
  const sleepFrom = Math.floor(way.length * 0.22), sleepTo = sleepFrom + 18; // 18 fixes × 5 m = 90 m unrecorded, 90 s
  for (let i = 0; i < way.length; i += 1) {
    if (i >= sleepFrom && i < sleepTo) { t += 1000; continue; }
    if (i === sleepTo) segs.push([]);
    put(way[i], false);
  }
  // fishing: an hour of drifting and circling round the spot
  let d = { x: SPOT.x, y: SPOT.y };
  for (let s = 0; s < 3600; s += 1) {
    d = { x: d.x + 0.3 * gauss(), y: d.y + 0.3 * gauss() };
    if (Math.hypot(d.x - SPOT.x, d.y - SPOT.y) > 40) d = { x: SPOT.x + (d.x - SPOT.x) * 0.9, y: SPOT.y + (d.y - SPOT.y) * 0.9 };
    put(d, true);
  }
  return { segs, sleepAt: way[sleepFrom], sleepEnd: way[sleepTo] };
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); }

// ---- 1. the way back from the recording
const rec = record();
const nRec = rec.segs.reduce((a, s) => a + s.length, 0);
const p = rt.rtBuild(rec.segs);
check('путь построен', p && p.pts.length > 10, p ? `${p.pts.length} точек из ${nRec} записанных, ${Math.round(p.len)} м` : 'null');
const first = xy(p.pts[0]), lastPt = xy(p.pts[p.pts.length - 1]);
check('начинается у места рыбалки', Math.hypot(first.x - SPOT.x, first.y - SPOT.y) < 45, `${Math.round(Math.hypot(first.x - SPOT.x, first.y - SPOT.y))} м от точки`);
check('кончается у старта (слип)', Math.hypot(lastPt.x, lastPt.y) < 12, `${Math.round(Math.hypot(lastPt.x, lastPt.y))} м от старта`);
const trueLen = channelLen + 2000;
check('час рыбалки вырезан (петли)', p.len < trueLen * 1.12 + 80, `длина пути ${Math.round(p.len)} м при пути туда ${Math.round(trueLen)} м`);
check('провал записи отмечен', p.gapLen > 60 && p.gapLen < 130, `не записано ${Math.round(p.gapLen)} м`);
let worst = 0;
for (let i = 0; i < p.pts.length; i += 1) {
  const q = xy(p.pts[i]);
  if (p.gap[i] || (i && p.gap[i - 1]) || Math.hypot(q.x - SPOT.x, q.y - SPOT.y) < 60) continue; // the gap; the fishing place itself
  worst = Math.max(worst, toLine(q, TRUE_OUT));
}
check('все точки пути на настоящей дороге (±12 м: это ошибка GPS при записи)', worst <= 12, `худшая ${worst.toFixed(1)} м`);

// ---- 2. going back: a boat steering at the arrow, GPS noise ±3 m, 5 m/s; how far from the channel's middle
function goBack(aimFn, label, noiseOpt = {}) {
  let boat = { x: first.x, y: first.y }, loc = null, maxOff = 0, maxOffAt = null, steps = 0, reached = false, lastLoc = null;
  const offs = [], seenOffs = [], noise = gpsNoise(noiseOpt);
  while (steps < 4000) {
    steps += 1;
    const e = noise();
    const seen = ll(boat.x + e.x, boat.y + e.y);
    loc = rt.rtLocate(p, seen, loc);
    seenOffs.push(loc.d); // what the navigator controls: the boat by its own GPS against the recorded line
    const aim = aimFn(loc, seen);
    const a = xy(aim), sn = xy(seen);
    // the helmsman knows only the arrow: from where his GPS puts him towards the spot it shows, 5 m a second
    const dx = a.x - sn.x, dy = a.y - sn.y, l = Math.hypot(dx, dy) || 1;
    boat = { x: boat.x + (dx / l) * 5, y: boat.y + (dy / l) * 5 };
    const inChannel = toLine(boat, CHANNEL) <= toLine(boat, OPEN);
    const off = toLine(boat, CHANNEL);
    const nearSleep = Math.hypot(boat.x - rec.sleepAt.x, boat.y - rec.sleepAt.y) < 110 || Math.hypot(boat.x - rec.sleepEnd.x, boat.y - rec.sleepEnd.y) < 110;
    if (inChannel && !nearSleep) { offs.push(off); if (off > maxOff) { maxOff = off; maxOffAt = { x: Math.round(boat.x), y: Math.round(boat.y) }; } }
    lastLoc = loc;
    if (Math.hypot(boat.x, boat.y) < 12) { reached = true; break; }
  }
  offs.sort((x, y) => x - y);
  seenOffs.sort((x, y) => x - y);
  return { label, reached, steps, maxOff, p95: offs[Math.floor(offs.length * 0.95)] || 0, maxOffAt, left: Math.round(p.len - (lastLoc ? lastLoc.along : 0)),
    lineP95: seenOffs[Math.floor(seenOffs.length * 0.95)] || 0, lineMax: seenOffs[seenOffs.length - 1] || 0 };
}
const neu = goBack((loc, seen) => rt.rtAim(p, loc, seen, { sog: 5 }), 'новое: стрелка по протоке');
const harsh = goBack((loc, seen) => rt.rtAim(p, loc, seen, { sog: 5 }), 'новое, резкий шум GPS', { white: true });
// The old way (before 26.09.2026): the arrow at the point of the line 150 m ahead of the nearest point.
const old = goBack((loc) => rt.rtPointAt(p, loc.along + 150), 'старое: точка в 150 м впереди');
check('по стрелке доходит до слипа', neu.reached, `${neu.steps} с, осталось ${neu.left} м`);
// The navigator's own work: the boat (by its GPS) on the recorded line.
check('держит лодку на записанной линии', neu.lineP95 <= 5 && neu.lineMax <= 9, `95 % ≤ ${neu.lineP95.toFixed(1)} м, макс. ${neu.lineMax.toFixed(1)} м (старый способ: 95 % ≤ ${old.lineP95.toFixed(1)} м)`);
// With the GPS error of the recording and of today added (σ 3 m each: ≈ 8 m at 95 % whatever the navigator does)
// against the middle of a 15 m channel.
check('в протоке держится русла с точностью GPS', neu.p95 <= 10.5 && neu.maxOff <= 15, `95 % ≤ ${neu.p95.toFixed(1)} м, макс. ${neu.maxOff.toFixed(1)} м от середины протоки (старый способ: 95 % ≤ ${old.p95.toFixed(1)} м, макс. ${old.maxOff.toFixed(1)} м)`);
check('лучше старого способа', neu.p95 < old.p95 * 0.6 && neu.lineP95 < old.lineP95 * 0.4, `новое ${neu.maxOff.toFixed(1)} м против старого ${old.maxOff.toFixed(1)} м`);
check('и при резком шуме GPS доходит и держится русла', harsh.reached && harsh.p95 <= 9 && harsh.maxOff <= 15, `95 % ≤ ${harsh.p95.toFixed(1)} м, макс. ${harsh.maxOff.toFixed(1)} м`);

// ---- 3. an L-turn: 200 m north, then 200 m east — a right turn of 90° told from 100 m
{
  const seg = [];
  for (let s = 0; s <= 200; s += 5) { const g = ll(0, s); seg.push([g.lat, g.lon, 0, 3]); }
  for (let s = 5; s <= 200; s += 5) { const g = ll(s, 200); seg.push([g.lat, g.lon, 0, 3]); }
  // recorded north then east; the way back goes west then south: a LEFT turn
  const q = rt.rtBuild([seg]);
  const turn = rt.rtTurn(q, 100, 250);
  check('поворот найден и налево', turn && turn.dir === 'left' && Math.abs(Math.abs(turn.angle) - 90) < 20 && Math.abs(turn.d - 100) < 15,
    turn ? `${turn.dir}, ${Math.round(turn.angle)}°, через ${Math.round(turn.d)} м` : 'нет');
  const straight = rt.rtTurn(q, 210, 150);
  check('на прямой поворотов нет', !straight, straight ? `${straight.dir} ${Math.round(straight.angle)}°` : 'нет');
  // off to the right of the way back (way back runs west on the first stretch): a point north of it is to the right
  const locR = rt.rtLocate(q, ll(100, 212), null);
  check('сторона: правее пути — «+»', locR.off > 0 && Math.abs(locR.d - 12) < 1.5, `off ${locR.off.toFixed(1)} м`);
  const locL = rt.rtLocate(q, ll(100, 188), null);
  check('сторона: левее пути — «−»', locL.off < 0, `off ${locL.off.toFixed(1)} м`);
}

// ---- 4. the aim at a bend is the bend: 60 m north, then east — from 40 m before the bend the arrow must not cut
{
  const seg = [];
  for (let s = 0; s <= 300; s += 4) { const g = ll(s, 0); seg.push([g.lat, g.lon, 0, 3]); } // recorded east…
  for (let s = 4; s <= 60; s += 4) { const g = ll(300, s); seg.push([g.lat, g.lon, 0, 3]); } // …then north
  const q = rt.rtBuild([seg]); // back: south 60 m, then west
  const me = ll(300, 40); // 40 m before the bend on the way back
  const loc = rt.rtLocate(q, me, null);
  const aim = rt.rtAim(q, loc, me, { sog: 8, corridor: 6 });
  const a = xy(aim);
  check('у поворота стрелка на повороте, не через тростник', Math.hypot(a.x - 300, a.y) < 12, `прицел (${Math.round(a.x)}, ${Math.round(a.y)}), поворот (300, 0)`);
}

// ---- 5. gaps ahead are told, with their length
{
  const g = rt.rtGapAhead(p, 0, p.len);
  check('впереди виден провал записи', g && g.len > 60, g ? `через ${Math.round(g.d)} м, ${Math.round(g.len)} м` : 'нет');
}

// ---- 6. a hairpin: the line comes back 25 m beside itself — the boat further along is not pulled back
{
  const seg = [];
  for (let s = 0; s <= 300; s += 4) { const g = ll(0, s); seg.push([g.lat, g.lon, 0, 3]); }
  for (let s = 4; s <= 25; s += 4) { const g = ll(s, 300); seg.push([g.lat, g.lon, 0, 3]); }
  for (let s = 300; s >= 0; s -= 4) { const g = ll(25, s); seg.push([g.lat, g.lon, 0, 3]); }
  const q = rt.rtBuild([seg]);
  let loc = rt.rtLocate(q, ll(0, 150), null); // on the way back this is the far leg (recorded first)
  const before = loc.along;
  loc = rt.rtLocate(q, ll(14, 160), loc);    // a jitter nearer to the other leg (11 m) than to its own (14 m)
  check('шпилька: не перескакивает назад по линии', loc.along >= before - 30, `было ${Math.round(before)} м, стало ${Math.round(loc.along)} м`);
}

let bad = 0;
for (const r of results) { console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}: ${r.detail}`); if (!r.ok) bad += 1; }
console.log(`\n${neu.label}: макс. ${neu.maxOff.toFixed(1)} м, 95 % ≤ ${neu.p95.toFixed(1)} м; ${old.label}: макс. ${old.maxOff.toFixed(1)} м, 95 % ≤ ${old.p95.toFixed(1)} м`);
console.log(bad ? `FAILED: ${bad}` : 'ALL OK');
process.exit(bad ? 1 : 0);
