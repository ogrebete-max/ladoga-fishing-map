'use strict';

/* Ладога · рыболовная карта — the wind sea near the shore (research/wave_report.md): a fetch table
   (data/fetch.json, scripts/build_fetch.py — for every water cell, how far the open water stretches upwind in
   16 directions and how deep it is) and the SPM-1984 shallow-water fetch-limited formulas. The open-lake wave
   model of Open-Meteo sits 10–23 km out in the lake; this is the wave where the boat is. Accuracy about ±30 %;
   not shown under ice. The functions below are scripts/fetch_wave.js (tested there with node). */

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

/* ---------- the app's side ---------- */
const FETCH_TABLE = { data: null, loading: null };
function loadFetchTable() {
  const url = state.ctx.depth?.fetch;
  if (!url || FETCH_TABLE.loading) return FETCH_TABLE.loading;
  FETCH_TABLE.loading = fetch(url).then((r) => r.json()).then((d) => {
    FETCH_TABLE.data = d;
    if (typeof refreshPage === 'function') refreshPage('today');
  }).catch(() => { FETCH_TABLE.loading = null; });
  return FETCH_TABLE.loading;
}
// The wave at a place for a wind (from where it blows, m/s): {hs, ts, fetch_km} or null (no table, ice, far from water).
// k — the forecast hour: the wind's duration from the same side limits a young sea.
function shoreWave(lat, lon, dir, speed, k = null) {
  const fd = FETCH_TABLE.data;
  if (!fd || dir == null || speed == null || isIceMonth(new Date().getMonth() + 1)) return null;
  let durationH;
  const h = state.wx?.fc?.hourly;
  if (h && k != null) durationH = steadyWindHours(h.wind_direction_10m, h.wind_speed_10m, k);
  const dep = typeof gridDepth === 'function' ? gridDepth({ lat, lon }) : null;
  const w = waveAt(fd, lat, lon, dir, speed, { levelM: levelNow(), durationH, localDepthM: dep ?? undefined, searchKm: 1.5 });
  // Far out in the deep lake (fetch over 50 km, over 15 m of water) the formula runs a third high: the wave model
  // of Open-Meteo is the better figure there (research/wave_report.md).
  if (!w || !Number.isFinite(w.hs_m) || (w.fetch_km > 50 && w.depth_m > 15)) return null;
  return { hs: w.hs_m, ts: w.ts_s, fetch_km: w.fetch_km, limited: w.limited };
}
