'use strict';

/* Wind sea near the angler: fetch table (data/fetch.json, built by scripts/build_fetch.py) + SPM-1984 shallow-water,
   fetch-limited formulas. Reference for the app (ES2019, no dependencies, plain functions like app.js).

     const fd = await fetch('data/fetch.json').then((r) => r.json());
     const w = waveAt(fd, 60.13, 32.23, 350, 9, { levelM: -0.9, durationH: 6 });
     // -> { hs_m, ts_s, fetch_km, depth_m, length_m, limited, cell: { level, lat, lon, size_km, iso, river, approx, dist_km } }
     boatVerdict(w.hs_m, 9, 'inflatable');   // -> { verdict: 'нельзя', level: 2, reason: 'ветер 9 м/с ≥ 8 м/с …' }

   windDirDeg is the meteorological direction the wind comes FROM (Open-Meteo wind_direction_10m), speed in m/s at 10 m.
   Accuracy: about ±30 % (see research/wave_report.md). Do not show under ice. */

const FETCH_G = 9.81;
const FETCH_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/* SPM-1984 (Shore Protection Manual, ch. 3, shallow-water forecasting equations with UA = 0.71 U^1.23):
   significant height Hs (m) and period Ts (s) for wind U (m/s, 10 m), fetch F (km), depth d (m). */
function spm1984(U, F_km, d) {
  if (!(U > 0.3) || !(F_km > 0)) return { hs: 0, ts: 0 };
  const UA = 0.71 * Math.pow(U, 1.23);
  const k = FETCH_G / (UA * UA);
  const x = k * Math.max(d, 0.1);
  const ta = Math.tanh(0.530 * Math.pow(x, 0.75));
  const tb = Math.tanh(0.833 * Math.pow(x, 0.375));
  const hs = 0.283 * ta * Math.tanh(0.00565 * Math.sqrt(k * F_km * 1000) / ta) / k;
  const ts = 7.54 * tb * Math.tanh(0.0379 * Math.cbrt(k * F_km * 1000) / tb) * UA / FETCH_G;
  return { hs, ts };
}

/* Decode the quadtree once (cached on the data object). Leaf = { f: [16 km], d: [16 m], iso?, mask?, alt? }. */
function fetchIndex(fd) {
  if (fd._root) return fd._root;
  const A = fd.alphabet || FETCH_B64;
  const val = {};
  for (let i = 0; i < 64; i++) val[A[i]] = i;
  const fc = fd.fetch_code, dc = fd.depth_code;
  const fk = Math.log(fc.max_km / fc.min_km) / 63, dk = Math.log(dc.max_m / dc.min_m) / 63;
  const Fkm = (ch) => fc.min_km * Math.exp(val[ch] * fk);
  const Dm = (ch) => dc.min_m * Math.exp(val[ch] * dk);
  let pos = 0, nf = 0, ni = 0, nm = 0;
  const code = () => {
    const v = val[fd.tree[pos >> 1]];
    const c = pos & 1 ? v & 7 : v >> 3;
    pos++;
    return c;
  };
  const full = () => {
    const f = new Array(16), d = new Array(16);
    for (let k = 0; k < 16; k++) { f[k] = Fkm(fd.fetch[16 * nf + k]); d[k] = Dm(fd.depth[16 * nf + k]); }
    nf++;
    return { f, d };
  };
  const iso = () => {
    const f = Fkm(fd.iso[2 * ni]), d = Dm(fd.iso[2 * ni + 1]);
    ni++;
    return { f: new Array(16).fill(f), d: new Array(16).fill(d), iso: true };
  };
  const parse = () => {
    const c = code();
    if (c === 0) return null;                                 // no water
    if (c === 2) return [parse(), parse(), parse(), parse()]; // NW, NE, SW, SE
    if (c === 1) return full();
    if (c === 3) return iso();
    const leaf = full();                                      // 4, 5: lake record + river/canal sub-cells
    const m = fd.mix.substr(3 * nm++, 3);
    leaf.mask = (val[m[0]] << 12) | (val[m[1]] << 6) | val[m[2]];
    leaf.alt = c === 4 ? iso() : full();
    return leaf;
  };
  const g = fd.grid, root = new Array(g.ny * g.nx);
  for (let i = 0; i < root.length; i++) root[i] = parse();
  Object.defineProperty(fd, '_root', { value: root, enumerable: false });
  return root;
}

/* Table record at a point, or null outside the table / on land. */
function fetchLeaf(fd, lat, lon) {
  const g = fd.grid, root = fetchIndex(fd);
  const r = Math.floor((g.N - lat) / g.dlat), c = Math.floor((lon - g.W) / g.dlon);
  if (!(r >= 0 && c >= 0 && r < g.ny && c < g.nx)) return null;
  let node = root[r * g.nx + c], top = g.N - r * g.dlat, left = g.W + c * g.dlon, h = g.dlat, w = g.dlon, level = 0;
  while (Array.isArray(node)) {
    h /= 2; w /= 2; level++;
    const i = lat < top - h ? 1 : 0, j = lon >= left + w ? 1 : 0;
    top -= i * h; left += j * w;
    node = node[2 * i + j];
  }
  if (!node) return null;
  let rec = node, river = false;
  if (node.mask) {
    const h4 = h / 4, w4 = w / 4;
    const i = Math.min(3, Math.max(0, Math.floor((top - lat) / h4)));
    const j = Math.min(3, Math.max(0, Math.floor((lon - left) / w4)));
    if ((node.mask >> (4 * i + j)) & 1) {
      rec = node.alt; river = true; level += 2;
      top -= i * h4; left += j * w4; h = h4; w = w4;
    }
  }
  const lat0 = top - h / 2;
  return {
    f: rec.f, d: rec.d, iso: !!rec.iso, river, level, lat: lat0, lon: left + w / 2,
    size_km: Math.round(h * 111.2 * 100) / 100,
  };
}

/* Wind sea at (lat, lon). opts:
     levelM      lake level anomaly, m (depths in the table are from the long-term mean level; 2026: about -0.9)
     durationH   hours the wind has blown from about this direction (SPM duration limit); omit = unlimited
     localDepthM depth at the point (depth model, chart datum) -> breaking cap Hs <= 0.55 * depth
     searchKm    if the point is on land in the table (GPS on the shore, in reeds), use the most exposed water
                 cell on the nearest ring within this distance (default 1 km); null if none
   Returns null when there is no water nearby or the point is outside the table. */
function waveAt(fd, lat, lon, windDirDeg, windSpeedMs, opts) {
  opts = opts || {};
  const dir = ((windDirDeg % 360) + 360) % 360;
  const x = dir / 22.5, k0 = Math.floor(x) % 16, k1 = (k0 + 1) % 16, t = x - Math.floor(x);
  const fetchIn = (lf) => lf.f[k0] * (1 - t) + lf.f[k1] * t;
  let leaf = fetchLeaf(fd, lat, lon), dist = 0;
  if (!leaf) {
    const R = opts.searchKm == null ? 1 : opts.searchKm, cosl = Math.cos(lat * Math.PI / 180);
    for (let s = 0.2; s <= R + 1e-9 && !leaf; s += 0.2) {
      for (let b = 0; b < 360; b += 15) {
        const a = b * Math.PI / 180;
        const lf = fetchLeaf(fd, lat + s / 111.2 * Math.cos(a), lon + s / (111.2 * cosl) * Math.sin(a));
        if (lf && (!leaf || fetchIn(lf) > fetchIn(leaf))) leaf = lf;
      }
      dist = s;
    }
    if (!leaf) return null;
  }
  const U = Math.max(0, +windSpeedMs || 0);
  const levelM = opts.levelM || 0;
  let F = fetchIn(leaf);
  const d = Math.max(0.3, leaf.d[k0] * (1 - t) + leaf.d[k1] * t + levelM);
  let limited = 'fetch';
  if (opts.durationH > 0 && U > 0.3) {       // SPM-1984: g t / UA = 68.8 (g F / UA^2)^(2/3)
    const UA = 0.71 * Math.pow(U, 1.23);
    const Fd = UA * UA / FETCH_G * Math.pow(FETCH_G * opts.durationH * 3600 / (68.8 * UA), 1.5) / 1000;
    if (Fd < F) { F = Fd; limited = 'duration'; }
  }
  const w = spm1984(U, F, d);
  if (opts.localDepthM != null) {
    const dl = Math.max(0.1, opts.localDepthM + levelM);
    if (w.hs > 0.55 * dl) { w.hs = 0.55 * dl; limited = 'depth'; }
  }
  let L = 0;                                  // wavelength at depth d (Eckart / Fenton approximation)
  if (w.ts > 0) {
    const L0 = FETCH_G * w.ts * w.ts / (2 * Math.PI);
    L = L0 * Math.pow(Math.tanh(Math.pow(2 * Math.PI * d / L0, 0.75)), 2 / 3);
  }
  return {
    hs_m: w.hs, ts_s: w.ts, fetch_km: F, depth_m: d, length_m: L, limited,
    cell: {
      level: leaf.level, lat: leaf.lat, lon: leaf.lon, size_km: leaf.size_km,
      iso: leaf.iso, river: leaf.river, approx: dist > 0, dist_km: Math.round(dist * 10) / 10,
    },
  };
}

/* Hours the wind has blown from about the same direction up to hour i (for opts.durationH):
   going back while the direction stays within ±45° of the current one and the speed >= 60 % of it. */
function steadyWindHours(dirs, speeds, i) {
  let n = 0;
  for (let k = i; k >= 0; k--) {
    const dd = Math.abs(((dirs[k] - dirs[i]) % 360 + 540) % 360 - 180);
    if (dd > 45 || !(speeds[k] >= 0.6 * speeds[i])) break;
    n++;
  }
  return n;
}

/* Default limits (§5.7): wave from the boat's papers overrides them — pass { maxWave, maxWind, name }. */
const BOATS = {
  inflatable: { name: 'надувная лодка', gen: 'надувной лодки', maxWave: 0.5, maxWind: 8 },
  light: { name: 'лёгкая мотолодка', gen: 'лёгкой мотолодки', maxWave: 0.75, maxWind: 10 },
  cabin: { name: 'катер', gen: 'катера', maxWave: 1.25, maxWind: null },
};

/* «можно / осторожно / нельзя» for a boat. hs: m (null = not estimated), wind: m/s. «осторожно» when the estimate
   is within its ±30 % of the wave limit (hs >= limit / 1.3) or the wind is within 2 m/s of the wind limit. */
function boatVerdict(hs, wind, boat) {
  const b = typeof boat === 'string' ? BOATS[boat] : Object.assign({}, boat);
  if (!b) throw new Error('unknown boat ' + boat);
  const gen = b.gen || 'вашей лодки';                   // custom boats: { maxWave, maxWind, gen? }
  const m = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('.', ',');
  const ms = (v) => String(Math.round(v));
  const hasHs = hs != null && isFinite(hs);
  const over = [], near = [];
  if (hasHs && b.maxWave != null) {
    if (hs >= b.maxWave) over.push(`волна ~${m(hs)} м ≥ ${m(b.maxWave)} м`);
    else if (hs * 1.3 >= b.maxWave) near.push(`волна ~${m(hs)} м близка к пределу ${m(b.maxWave)} м (оценка ±30 %)`);
  }
  if (wind != null && b.maxWind != null) {
    if (wind >= b.maxWind) over.push(`ветер ${ms(wind)} м/с ≥ ${b.maxWind} м/с`);
    else if (wind >= b.maxWind - 2) near.push(`ветер ${ms(wind)} м/с близок к пределу ${b.maxWind} м/с`);
  }
  if (over.length) return { verdict: 'нельзя', level: 2, reason: `${over.join(', ')} — предел для ${gen}` };
  if (near.length) return { verdict: 'осторожно', level: 1, reason: `${near.join('; ')}; держитесь у берега` };
  const parts = [];
  if (hasHs) parts.push(`волна ~${m(hs)} м`);
  if (wind != null) parts.push(`ветер ${ms(wind)} м/с`);
  return {
    verdict: 'можно', level: 0,
    reason: `${parts.join(', ') || 'нет данных'} — в пределах для ${gen}${hasHs ? '' : ' (волна не оценена)'}`,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { spm1984, fetchIndex, fetchLeaf, waveAt, steadyWindHours, boatVerdict, BOATS };
}
