'use strict';
/* node scripts/fetch_wave.test.js — checks fetch_wave.js against site/data/fetch.json and the Python twin in
   build_fetch.py (FetchTable). No dependencies. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spm1984, fetchLeaf, waveAt, steadyWindHours, boatVerdict } = require('./fetch_wave.js');

const fd = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site', 'data', 'fetch.json'), 'utf8'));
let n = 0;
const near = (a, b, tol, msg) => { assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`); n++; };

// 1. SPM-1984 reproduces the table of product_ideas.md §5.7
const table = [
  [8, 1, 3, 0.14], [8, 20, 6, 0.57, 2.9], [8, 110, 6, 0.87, 3.9],
  [10, 1, 3, 0.19], [10, 20, 6, 0.73, 3.2], [10, 110, 6, 1.05, 4.4],
  [15, 1, 3, 0.31], [15, 20, 6, 1.09, 3.8], [15, 110, 6, 1.41, 5.2],
];
for (const [U, F, d, hs, ts] of table) {
  const w = spm1984(U, F, d);
  near(w.hs, hs, 0.005, `Hs U=${U} F=${F} d=${d}`);
  if (ts) near(w.ts, ts, 0.05, `Ts U=${U} F=${F} d=${d}`);
}
assert.deepStrictEqual(spm1984(0, 10, 5), { hs: 0, ts: 0 });

// 2. decoder: every record consumed exactly once (stats), size budget
const size = fs.statSync(path.join(__dirname, '..', 'site', 'data', 'fetch.json')).size;
assert.ok(size <= 150000, `fetch.json ${size} bytes > 150 000`);
assert.strictEqual(fd.fetch.length % 16, 0);
assert.strictEqual(fd.fetch.length, fd.depth.length);

// 3. identical to the Python twin: [lat, lon, dir, U, hs, ts, F_km, d_m, level, river]
const vectors = [[60.131684, 32.231764, 0, 6, 0.615763, 3.265219, 116.333945, 5.202325, 2, false], [60.120491, 32.319319, 11.25, 6, 0.059885, 0.788551, 0.3364, 2.940236, 2, false], [60.064805, 32.345053, 47, 6, 0.127481, 1.280434, 1.545841, 5.202325, 0, false], [60.182467, 32.228, 200, 6, 0.209269, 1.735546, 5.592156, 1.870092, 0, false], [60.228772, 32.161988, 333.3, 6, 0.670246, 3.384003, 126.564446, 6.185645, 1, false], [60.406806, 32.090174, 0, 8, 1.182542, 4.415619, 90.223912, 19.698493, 2, false], [60.025646, 31.533428, 11.25, 8, 0.067197, 0.793423, 0.292165, 0.3, 2, false], [60.023129, 31.549124, 47, 8, 0.076891, 0.833999, 0.271662, 5.202325, 4, true], [60.598432, 32.812859, 200, 8, 0.44283, 2.51824, 10.262508, 6.919984, 1, false], [60.518875, 32.799904, 333.3, 8, 1.074373, 4.194461, 89.283036, 11.848037, 2, false], [60.479217, 32.892208, 0, 10, 0.153874, 1.202116, 0.635065, 5.202325, 2, false], [59.948739, 31.039084, 11.25, 10, 0.177777, 1.316576, 0.87433, 3.086912, 2, false], [60.13338, 31.108066, 47, 10, 1.411493, 4.839871, 112.213064, 10.961731, 1, false], [60.291664, 32.208344, 200, 10, 0.538841, 2.717895, 11.166041, 3.911018, 0, false], [60.708336, 32.791668, 333.3, 10, 1.299452, 4.516446, 60.586894, 15.721695, 1, false], [60.541668, 31.708334, 0, 13, 2.363708, 6.091851, 90.223912, 46.361326, 0, false], [60.1644, 31.28712, 11.25, 13, 1.909944, 5.679434, 132.098796, 11.688528, 0, false], [60.47188, 31.09109, 47, 13, 2.446113, 6.193653, 102.450494, 38.021952, 0, false], [60.36373, 31.82422, 200, 13, 0.917999, 3.508636, 17.061732, 6.361954, 0, false], [59.92566, 31.13678, 333.3, 13, 0.524462, 2.624981, 7.72821, 2.251586, 2, false], [59.97637, 31.4681, 0, 17, 1.276336, 4.81183, 61.623229, 4.730368, 0, false], [60.40248, 31.9017, 11.25, 17, 2.852463, 6.504829, 90.953481, 21.761888, 0, false], [60.77768, 31.02646, 47, 17, 3.152224, 6.800624, 80.413574, 56.073922, 0, false], [60.66696, 31.63402, 200, 17, 2.902382, 6.46473, 69.046159, 45.894002, 0, false], [59.9956, 31.20448, 333.3, 17, 1.458098, 4.971844, 58.621928, 5.847713, 0, false], [60.46058, 31.84099, 0, 6, 0.838351, 3.836325, 102.450494, 31.691711, 0, false], [60.37488, 31.06697, 11.25, 6, 0.865388, 3.873933, 116.333945, 26.202372, 0, false], [59.91603, 31.4249, 47, 6, 0.264501, 1.99007, 8.901135, 2.632334, 0, false], [60.49958, 31.97898, 200, 6, 0.590843, 3.164584, 40.60642, 17.566721, 0, false], [60.1553, 32.3739, 333.3, 6, 0.743473, 3.542874, 143.71567, 7.77846, 0, false], [60.28599, 31.65942, 0, 8, 1.337657, 4.705468, 132.098796, 19.698493, 0, false], [60.60672, 32.65749, 11.25, 8, 0.79168, 3.554125, 33.702509, 16.360213, 0, false], [60.35368, 33.09784, 47, 8, 0.132758, 1.187816, 0.818847, 5.202325, 0, false], [60.54568, 31.62984, 200, 8, 1.044166, 4.182371, 59.452745, 31.372258, 0, false], [60.78136, 31.20516, 333.3, 8, 1.197682, 4.563512, 79.456468, 59.674606, 0, false], [60.5787, 32.34256, 0, 10, 1.523154, 5.004011, 69.974025, 46.361326, 0, false], [60.68295, 31.69437, 11.25, 10, 1.583802, 5.148649, 74.715246, 64.744898, 0, false], [60.51358, 32.39592, 47, 10, 1.051083, 4.016057, 32.642428, 23.299608, 0, false], [60.4051, 32.05051, 200, 10, 0.809968, 3.428522, 21.999252, 8.9509, 0, false], [60.64957, 33.2717, 333.3, 10, 0.252262, 1.652174, 1.755324, 5.202325, 0, false], [60.30565, 32.57038, 0, 13, 1.426132, 4.755562, 61.623229, 8.369705, 1, false], [60.63261, 31.62149, 11.25, 13, 2.276592, 5.990829, 80.098969, 58.871217, 0, false], [60.22264, 32.58163, 47, 13, 0.435143, 2.161386, 3.220373, 3.262266, 1, false], [60.01797, 31.20274, 200, 13, 0.695235, 3.037455, 11.653219, 3.638989, 0, false], [59.98158, 31.52904, 333.3, 13, 1.061675, 4.427708, 74.754813, 4.672875, 1, false]];
for (const [lat, lon, dir, U, hs, ts, F, d, level, river] of vectors) {
  const w = waveAt(fd, lat, lon, dir, U);
  assert.ok(w, `no estimate at ${lat},${lon}`);
  const tag = `${lat},${lon} dir ${dir} U ${U}`;
  near(w.hs_m, hs, 1e-5 + 1e-5 * hs, `hs ${tag}`);
  near(w.ts_s, ts, 1e-5 + 1e-5 * ts, `ts ${tag}`);
  near(w.fetch_km, F, 1e-5 * F + 1e-6, `F ${tag}`);
  near(w.depth_m, d, 1e-5 * d, `d ${tag}`);
  assert.strictEqual(w.cell.level, level, `level ${tag}`);
  assert.strictEqual(w.cell.river, river, `river ${tag}`);
  assert.strictEqual(w.cell.approx, false);
}

// 4. behaviour at known places
const P3 = [60.541668, 31.708334];                            // open lake
assert.ok(fetchLeaf(fd, ...P3).f[0] > 50, 'open lake: long northern fetch');
const issad = fetchLeaf(fd, 60.064805, 32.345053);            // Volkhov river at Issad
assert.ok(issad.f.every((f) => f <= 2.01) && issad.iso, 'river: short isotropic fetch');
const nl = fetchLeaf(fd, 60.131684, 32.231764);               // lake off Novaya Ladoga: open to N, sheltered to S
assert.ok(nl.f[0] > 50 && nl.f[8] < 3, 'Novaya Ladoga: N long, S short');
const canal = fetchLeaf(fd, 60.023129, 31.549124);            // Novoladozhsky canal at Kobona: own sub-cell
assert.ok(canal.river && canal.f[0] < 1, 'canal sub-cell: short northern fetch');
assert.strictEqual(waveAt(fd, 59.90, 32.90, 0, 10), null, 'inland: null');
assert.strictEqual(waveAt(fd, 61.2, 31.0, 0, 10), null, 'outside the table: null');
// direction interpolation between N and NNE
const mid = waveAt(fd, ...P3, 11.25, 10);
near(mid.fetch_km, (fetchLeaf(fd, ...P3).f[0] + fetchLeaf(fd, ...P3).f[1]) / 2, 1e-9, 'interpolated fetch');
near(waveAt(fd, ...P3, 360 + 11.25, 10).hs_m, mid.hs_m, 1e-12, 'direction wraps');
// options: level anomaly lowers depth, duration and breaking limits only reduce the wave
const base = waveAt(fd, 60.291664, 32.208344, 0, 12);
const low = waveAt(fd, 60.291664, 32.208344, 0, 12, { levelM: -0.9 });
near(low.depth_m, base.depth_m - 0.9, 1e-9, 'level anomaly');
assert.ok(low.hs_m < base.hs_m);
const shortDur = waveAt(fd, 60.291664, 32.208344, 0, 12, { durationH: 2 });
assert.ok(shortDur.hs_m < base.hs_m && shortDur.limited === 'duration' && shortDur.fetch_km < base.fetch_km);
assert.strictEqual(waveAt(fd, 60.291664, 32.208344, 0, 12, { durationH: 48 }).hs_m, base.hs_m);
const capped = waveAt(fd, 60.291664, 32.208344, 0, 12, { localDepthM: 1.0 });
near(capped.hs_m, 0.55, 1e-12, 'breaking cap 0.55 d');
assert.strictEqual(capped.limited, 'depth');
// a point on the shore (GPS in the reeds): nearest water within 1 km, flagged approx
let shore = null;
for (let lon = 32.80; lon < 33.0 && !shore; lon += 0.0005) {  // east shore of Svirskaya guba at 60.60 N
  if (!fetchLeaf(fd, 60.60, lon)) shore = lon;                // first point of a table cell without water
}
assert.ok(shore, 'found the shore');
const ws = waveAt(fd, 60.60, shore, 270, 10);
assert.ok(ws && ws.cell.approx && ws.cell.dist_km <= 1 && ws.fetch_km > 1, 'shore fallback');
assert.strictEqual(waveAt(fd, 60.60, shore, 270, 10, { searchKm: 0 }), null);
// steady wind duration
assert.strictEqual(steadyWindHours([200, 210, 350, 355, 0, 5], [4, 5, 8, 9, 10, 10], 5), 4);
assert.strictEqual(steadyWindHours([0, 0, 0], [2, 9, 10], 2), 2);

// 5. boat verdicts (§5.7 limits)
const v = (hs, wind, boat) => boatVerdict(hs, wind, boat);
assert.strictEqual(v(0.6, 5, 'inflatable').verdict, 'нельзя');
assert.strictEqual(v(0.3, 8, 'inflatable').verdict, 'нельзя');
assert.strictEqual(v(0.42, 5, 'inflatable').verdict, 'осторожно');
assert.strictEqual(v(0.2, 6.5, 'inflatable').verdict, 'осторожно');
assert.strictEqual(v(0.2, 5, 'inflatable').verdict, 'можно');
assert.strictEqual(v(0.8, 7, 'light').verdict, 'нельзя');
assert.strictEqual(v(0.5, 9, 'light').verdict, 'осторожно');
assert.strictEqual(v(0.5, 7, 'light').verdict, 'можно');
assert.strictEqual(v(1.3, 20, 'cabin').verdict, 'нельзя');
assert.strictEqual(v(1.0, 20, 'cabin').verdict, 'осторожно');
assert.strictEqual(v(0.9, 20, 'cabin').verdict, 'можно');
assert.strictEqual(v(null, 9, 'inflatable').verdict, 'нельзя');
assert.strictEqual(v(0.35, 5, { name: 'моя лодка', maxWave: 0.4, maxWind: 7 }).verdict, 'осторожно');
assert.match(v(0.6, 9, 'inflatable').reason, /^волна ~0,6 м ≥ 0,5 м, ветер 9 м\/с ≥ 8 м\/с — предел для надувной лодки$/);
assert.match(v(0.2, 5, 'light').reason, /в пределах для лёгкой мотолодки/);
assert.throws(() => boatVerdict(0.1, 1, 'yacht'));

console.log(`fetch_wave.test.js: ok (${n} numeric checks, ${vectors.length} Python-twin vectors, fetch.json ${size} bytes)`);
