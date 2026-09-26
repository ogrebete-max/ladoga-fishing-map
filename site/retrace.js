'use strict';

/* Ладога · рыболовная карта — «Назад по треку»: the way back is the line the boat really went.
   South Ladoga is reeds: a boat goes kilometres along channels 5–15 m wide where nothing is seen over the reeds, and a
   missed channel means being lost (owner, 26.09.2026: «вернуться по маршруту — наиважнейшая функция»). So the arrow
   never points across the reeds, and a step off the line is told at once.
   - rtBuild(segs): the recorded segments turned into one line from the last point to the first: GPS jumps dropped,
     the loops of fishing and drifting cut out (the line comes back within RT.loopM of itself), the stretches that
     were not recorded (the phone asleep, no signal) kept as marked gaps;
   - rtLocate(path, me, prev): where the boat is on the line — along it, and how far to the side (+ right);
   - rtAim(path, loc, me, opt): the spot the arrow shows — as far along the line as a straight run from the boat stays
     inside the channel: on a straight stretch far ahead, at a bend the bend itself;
   - rtTurn(path, along, within): the next turn of the line ahead: how far, left or right, how sharp;
   - rtGapAhead(path, along, within): the next stretch that was not recorded.
   Pure geometry on a flat local projection (a lake is small): no map and no page. geo.js calls it on every fix;
   scripts/qa/test_retrace.js runs it under Node. */

const RT = {
  loopM: 10,       // the line coming back this close to itself closes a loop…
  loopMinM: 40,    // …if the loop is at least this long (a shorter wiggle is GPS noise)
  gapM: 30,        // two recorded pieces further apart than this: the stretch between was not recorded
  gapT: 90000,     // …or this long without a point, over more than gapJumpM
  gapJumpM: 60,
  stepGapM: 40,    // …or a step this long taking more than stepGapT: fixes were missing (a lock under 30 s leaves no
  stepGapT: 5000,  //    break in the recording, and a straight 90 m across a bend of a channel is not the way)
  jumpM: 250,      // one step longer than this is a gap or a GPS jump, never a boat
  simplifyM: 1.5,  // the line is simplified to this: the bends of a channel stay
};
const RT_R = 6371008.8;

// Metres on the flat local projection of a line (x east, y north); k = cos of the line's latitude.
function rtXY(k, p) { return { x: p.lon * Math.PI / 180 * RT_R * k, y: p.lat * Math.PI / 180 * RT_R }; }
const rtD = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Distance from p to the segment a–b.
function rtSegDist(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}
// Signed difference b − a of two headings, −180…180 (+ = to the right).
const rtAngle = (a, b) => ((b - a + 540) % 360) - 180;

// Douglas–Peucker on one unbroken run of points, iteratively.
function rtSimplify(run, tol) {
  if (run.length < 3) return run;
  const keep = new Uint8Array(run.length);
  keep[0] = 1; keep[run.length - 1] = 1;
  const stack = [[0, run.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i += 1) { const d = rtSegDist(run[i], run[a], run[b]); if (d > fd) { fd = d; far = i; } }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return run.filter((_, i) => keep[i]);
}

/* The way along a recorded track: segs = [[[lat, lon, t, acc, sog], …], …] in the recorded order. Back (from the
   last point to the first) by default; { forward: true } — the same way again, from the first point to the last.
   → { k, pts: [{lat, lon, x, y}], gap: [edge i→i+1 not recorded], cum: [m along], len, gapLen, forward } or null. */
function rtBuild(segs, opt = {}) {
  const raw = [];
  for (const s of segs || []) for (let i = 0; i < s.length; i += 1) if (s[i] && Number.isFinite(+s[i][0]) && Number.isFinite(+s[i][1])) raw.push({ p: s[i], first: i === 0 });
  if (raw.length < 2) return null;
  const k = Math.cos(+raw[0].p[0] * Math.PI / 180);
  // 1. The recorded order; «gap» on a point: the stretch that led to it was not recorded.
  const rec = [];
  for (const { p, first } of raw) {
    const q = { lat: +p[0], lon: +p[1], t: +p[2] || 0, acc: +p[3] || 0, gap: false, ...rtXY(k, { lat: +p[0], lon: +p[1] }) };
    const prev = rec[rec.length - 1];
    if (prev) {
      const d = rtD(prev, q), dt = q.t && prev.t ? q.t - prev.t : 0;
      if (d > RT.jumpM || (first && d > RT.gapM) || (dt > RT.gapT && d > RT.gapJumpM) || (dt > RT.stepGapT && d > RT.stepGapM)) q.gap = true;
    }
    rec.push(q);
  }
  // 2. GPS jumps: a point that goes far off and comes back (a spike), or a weak point far off its neighbours.
  const clean = [];
  for (let i = 0; i < rec.length; i += 1) {
    const q = rec[i], a = clean[clean.length - 1], b = rec[i + 1];
    if (a && b && !q.gap && !b.gap) {
      const da = rtD(a, q), db = rtD(q, b), ab = rtD(a, b);
      if (da > 40 && db > 40 && ab < 0.35 * (da + db)) continue;
      if (q.acc > 20 && rtSegDist(q, a, b) > Math.max(2 * q.acc, 25)) continue;
    }
    clean.push(q);
  }
  // 3. Backwards: the way home starts where the recording ended. The stretch that led to a point in the recording
  //    is, on the way home, the one that leaves it. Forward: as recorded.
  const back = [];
  if (opt.forward) {
    for (let i = 0; i < clean.length; i += 1) { const q = clean[i]; back.push({ lat: q.lat, lon: q.lon, x: q.x, y: q.y, gapNext: !!clean[i + 1]?.gap }); }
  } else {
    for (let i = clean.length - 1; i >= 0; i -= 1) { const q = clean[i]; back.push({ lat: q.lat, lon: q.lon, x: q.x, y: q.y, gapNext: q.gap }); }
  }
  // 4. Loops: where the way home comes back within loopM of a point it already has, the loop between is cut — the
  //    circles of fishing and drifting, a dead-end channel entered and left, the same channel gone twice.
  const out = [], along = [];
  const grid = new Map(), cell = RT.loopM;
  for (const q0 of back) {
    const q = { ...q0 };
    let hit = -1;
    if (out.length) {
      const last = out[out.length - 1];
      const here = along[along.length - 1] + rtD(last, q);
      const cx = Math.floor(q.x / cell), cy = Math.floor(q.y / cell);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const e of grid.get(`${cx + dx},${cy + dy}`) || []) {
            if (out[e.i] !== e.q || (hit >= 0 && e.i >= hit)) continue;
            if (rtD(e.q, q) <= RT.loopM && here - along[e.i] >= RT.loopMinM) hit = e.i;
          }
        }
      }
    }
    if (hit >= 0) { out.length = hit + 1; along.length = hit + 1; out[hit].gapNext = false; }
    along.push(out.length ? along[along.length - 1] + rtD(out[out.length - 1], q) : 0);
    out.push(q);
    const key = `${Math.floor(q.x / cell)},${Math.floor(q.y / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ i: out.length - 1, q });
  }
  // 5. Simplified between the gaps: the bends stay, the noise between them goes.
  const pts = [], gap = [];
  let run = [];
  const flush = (brokenAfter) => {
    const s = rtSimplify(run, RT.simplifyM);
    for (let i = 0; i < s.length; i += 1) { pts.push({ lat: s[i].lat, lon: s[i].lon, x: s[i].x, y: s[i].y }); gap.push(false); }
    if (brokenAfter && gap.length) gap[gap.length - 1] = true;
    run = [];
  };
  for (let i = 0; i < out.length; i += 1) { run.push(out[i]); if (out[i].gapNext && i < out.length - 1) flush(true); }
  if (run.length) flush(false);
  gap.pop(); // gap[i] is the edge i → i+1: one fewer than the points
  if (pts.length < 2) return null;
  const cum = [0];
  let gapLen = 0;
  for (let i = 1; i < pts.length; i += 1) { const d = rtD(pts[i - 1], pts[i]); cum.push(cum[i - 1] + d); if (gap[i - 1]) gapLen += d; }
  return { k, pts, gap, cum, len: cum[cum.length - 1], gapLen, forward: !!opt.forward };
}

// The place on the line `along` metres from its start.
function rtPointAt(path, along) {
  const n = path.pts.length;
  if (along <= 0) return { ...path.pts[0], seg: 0, along: 0 };
  if (along >= path.len) return { ...path.pts[n - 1], seg: n - 2, along: path.len, end: true };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (path.cum[mid] <= along) lo = mid; else hi = mid; }
  const a = path.pts[lo], b = path.pts[lo + 1], l = path.cum[lo + 1] - path.cum[lo], t = l ? (along - path.cum[lo]) / l : 0;
  return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon), x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), seg: lo, along };
}
// The line's own heading between two places on it, degrees clockwise from north.
function rtHeading(path, a, b) {
  const p = rtPointAt(path, a), q = rtPointAt(path, b);
  return (Math.atan2(q.x - p.x, q.y - p.y) * 180 / Math.PI + 360) % 360;
}
function rtProject(path, i, P) {
  const a = path.pts[i], b = path.pts[i + 1];
  const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((P.x - a.x) * vx + (P.y - a.y) * vy) / l2)) : 0;
  const d = Math.hypot(P.x - (a.x + t * vx), P.y - (a.y + t * vy));
  const cross = vx * (P.y - a.y) - vy * (P.x - a.x); // > 0: P lies to the left of a → b
  return { seg: i, t, d, off: cross > 0 ? -d : d, along: path.cum[i] + t * Math.sqrt(l2) };
}

/* Where the boat is on the line: { seg, t, along, d (m to the line), off (+ right of the way, − left) }.
   From the last place on (prev), never back along the line on a jitter: a place more than 30 m behind wins only
   when it is clearly nearer; lost (> 60 m off) — the whole line is searched. */
function rtLocate(path, me, prev) {
  const P = rtXY(path.k, me), n = path.pts.length;
  const scan = (from, to) => {
    let best = null;
    for (let i = Math.max(0, from); i < Math.min(n - 1, to); i += 1) { const r = rtProject(path, i, P); if (!best || r.d < best.d) best = r; }
    return best;
  };
  let best = prev ? scan(prev.seg - 40, prev.seg + 400) : scan(0, n - 1);
  if (prev && (!best || best.d > 60)) { const all = scan(0, n - 1); if (!best || all.d < best.d - 20) best = all; }
  if (prev && best && best.along < prev.along - 30) {
    const ahead = scan(prev.seg, prev.seg + 400);
    if (ahead && ahead.d <= best.d + 15) best = ahead;
  }
  return best;
}

/* The spot the arrow shows. On the line: the farthest place up to `look` metres ahead (10 s of the speed, 30–150 m;
   shorter the further the boat is off the line, so the arrow pulls back onto it) that a straight run from the boat
   reaches without leaving `corridor` metres of the line — so at a bend of the channel the arrow shows the bend, not
   the next stretch across the reeds. Off the line: back to it, a little ahead.
   Tuned on scripts/qa/test_retrace.js (a 15 m channel, a bend every 60–80 m, phone GPS ±3 m): the boat by its GPS
   stays within 4,5 m of the line 95 % of the time and the arrow barely jitters (95 % of its moves under 20°); the old
   arrow — at the line 150 m ahead — cut 25–35 m into the reeds at the bends. */
const RT_AIM = { corridor: 4, shrinkM: 8, minLook: 15 };
function rtAim(path, loc, me, opt = {}) {
  const P = rtXY(path.k, me);
  const corridor = opt.corridor ?? RT_AIM.corridor, minLook = RT_AIM.minLook;
  let look = Math.max(30, Math.min(150, (opt.sog || 0) * 10));
  look = Math.max(minLook, look * Math.max(0.2, 1 - loc.d / RT_AIM.shrinkM));
  if (loc.d > corridor * 1.5) return rtPointAt(path, Math.min(path.len, loc.along + Math.max(minLook, Math.min(20, loc.d))));
  let aim = rtPointAt(path, Math.min(path.len, loc.along + minLook));
  for (let s = minLook + 4; s <= look; s += 4) {
    const c = rtPointAt(path, loc.along + s);
    let inside = true;
    for (let i = loc.seg + 1; i <= c.seg && inside; i += 1) if (rtSegDist(path.pts[i], P, c) > corridor) inside = false;
    if (!inside) break;
    aim = c;
    if (c.end) break;
  }
  return aim;
}

// Is any of the line between two places on it not recorded?
function rtGapBetween(path, a, b) {
  const i0 = rtPointAt(path, Math.max(0, a)).seg, i1 = rtPointAt(path, Math.min(path.len, b)).seg;
  for (let i = i0; i <= i1; i += 1) if (path.gap[i]) return true;
  return false;
}

/* The next turn of the line within `within` metres ahead: { d, angle (+ right), dir: 'left'|'right', at }.
   A turn is a change of the line's own heading of 40° or more over 15 m on each side; its whole size is read over
   30 m before and after, so a bend made of small steps counts in full. Turns inside a gap are not told. */
function rtTurn(path, along, within = 250) {
  const W = 15, end = Math.min(path.len - W, along + within);
  for (let a = along + 10; a <= end; a += 5) {
    const turn = rtAngle(rtHeading(path, a - W, a), rtHeading(path, a, a + W));
    if (Math.abs(turn) < 40) continue;
    let best = { a, turn };
    for (let b = a + 2; b <= Math.min(end, a + 20); b += 2) {
      const t2 = rtAngle(rtHeading(path, b - W, b), rtHeading(path, b, b + W));
      if (Math.abs(t2) > Math.abs(best.turn)) best = { a: b, turn: t2 };
    }
    if (rtGapBetween(path, best.a - W, best.a + W)) { a = best.a + W; continue; }
    const whole = rtAngle(rtHeading(path, best.a - 30, best.a - 10), rtHeading(path, best.a + 10, best.a + 30));
    const angle = Math.abs(whole) > Math.abs(best.turn) && Math.sign(whole) === Math.sign(best.turn) ? whole : best.turn;
    return { d: Math.max(0, best.a - along), angle, dir: angle > 0 ? 'right' : 'left', at: best.a };
  }
  return null;
}

// The next stretch that was not recorded, within `within` metres ahead: { d, len, seg } or null.
function rtGapAhead(path, along, within = 200) {
  for (let i = rtPointAt(path, along).seg; i < path.pts.length - 1 && path.cum[i] <= along + within; i += 1) {
    if (path.gap[i] && path.cum[i + 1] > along) return { d: Math.max(0, path.cum[i] - along), len: path.cum[i + 1] - path.cum[i], seg: i };
  }
  return null;
}

if (typeof module !== 'undefined') module.exports = { RT, rtXY, rtBuild, rtPointAt, rtHeading, rtLocate, rtAim, rtTurn, rtGapAhead, rtGapBetween, rtAngle };
