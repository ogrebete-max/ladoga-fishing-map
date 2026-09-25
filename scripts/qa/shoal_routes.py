#!/usr/bin/env python3
"""How often does the navigator speak about shallow water on usual trips? (owner, 25.09.2026: «постоянно будет
предупреждать — тоже ни к чему»).

Runs the app's own shoalAhead() and depthAt() along usual boat routes at 25 km/h (a step every 3 s of travel, as
the navigator does), with the voice rules of navVoice(): one warning per shoal (a new one after 15 s without
shallow water ahead) and one more close to it; «под лодкой мелко» at most once a minute while moving.

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/shoal_routes.py [--base URL] [--shallow 2]
"""
import argparse
import json
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8794/")
ap.add_argument("--shallow", type=float, default=1.5)
args = ap.parse_args()

ROUTES = {
    "Новая Ладога → Волховская губа → о. Птинов": [[60.1245, 32.3060], [60.1600, 32.3000], [60.2000, 32.2600], [60.2400, 32.1000]],
    "Креницы → о. Сухо": [[60.1400, 32.2800], [60.2500, 32.2000], [60.4000, 32.0950]],
    "Кобона → Зеленцы → Кареджи": [[60.0280, 31.5200], [60.0000, 31.4200], [59.9990, 31.3800], [60.0600, 31.3700], [60.1150, 31.3900]],
    "Шлиссельбург → Кошкинский фарватер": [[59.9560, 31.0400], [59.9760, 31.0780], [59.9850, 31.1060], [59.9960, 31.1420]],
    "Свирица → Свирская губа → Сторожно": [[60.4750, 32.8900], [60.5300, 32.7800], [60.5400, 32.6500]],
}

JS = r"""
async ([route, shallow]) => {
  state.settings.shallow = shallow;
  await loadDepthDangers();
  const pts = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = { lat: route[i][0], lon: route[i][1] }, b = { lat: route[i + 1][0], lon: route[i + 1][1] };
    const brg = bearing(a, b), len = distM(a, b);
    for (let d = 0; d < len; d += 21) pts.push({ ...destPoint(a, brg, d), cog: brg });   // 3 s at 25 km/h
  }
  for (const p of pts) gridDepth(p);                        // start loading the grid files on the way
  await new Promise((r) => setTimeout(r, 4000));
  for (const p of pts) gridDepth(p);
  await new Promise((r) => setTimeout(r, 2500));
  const lv = levelNow(), sog = 25 / 3.6;
  let lastShoalT = -1e9, shoalN = 0, closeN = 0, episode = null, shallowAt = null, hereN = 0, t = 0, km = 0, noData = 0, shoalSaidT = -1e9, hereSaidT = -1e9;
  const said = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    t = i * 3; if (i) km += distM(pts[i - 1], p) / 1000;
    geo.me = { lat: p.lat, lon: p.lon, acc: 5, t: Date.now() }; geo.sog = sog; geo.cog = p.cog; geo.cogT = Date.now();
    const s = shoalAhead(geo.me);
    if (s) {
      if (!episode || t - lastShoalT > 15) { episode = { n: 0 }; }
      lastShoalT = t;
      if (episode.n === 0 && s.d <= Math.max(200, sog * 60)) { episode.n = 1; shoalN += 1; shoalSaidT = t; said.push(`${km.toFixed(1)} км: впереди мелко ${s.depth.toFixed(1)} м через ${s.d} м${s.point ? ' (точка)' : ''}`); }
      else if (episode.n === 1 && s.d <= 120 && s.depth < 1) { episode.n = 2; closeN += 1; shoalSaidT = t; }
    }
    const dep = depthAt(p);
    if (!dep) noData += 1;
    const now = dep ? (dep.value ?? dep.max) + lv : null;
    if (now != null && now > shallow + 0.5) shallowAt = null;
    if (now != null && now >= 0.2 && now <= shallow && (shallowAt == null || now <= shallowAt - 0.7) && t - hereSaidT > 30) {
      shallowAt = now; hereSaidT = t;
      if (t - shoalSaidT >= 90) { hereN += 1; said.push(`${km.toFixed(1)} км: под лодкой мелко ${now.toFixed(1)} м`); }
    }
  }
  return { km: +km.toFixed(1), minutes: Math.round(t / 60), shoal_warnings: shoalN, close_warnings: closeN, under_boat: hereN, no_depth_share: +(noData / pts.length).toFixed(2), said: said.slice(0, 12) };
}
"""

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_context(**pw.devices["Pixel 7"], locale="ru-RU").new_page()
    page.goto(args.base, wait_until="domcontentloaded")
    page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0 && chartState.gridIndex', timeout=60000)
    res = {}
    for name, route in ROUTES.items():
        res[name] = page.evaluate(JS, [route, args.shallow])
    b.close()
print(json.dumps({"level": "as on the site now", "shallow_setting_m": args.shallow, "routes": res}, ensure_ascii=False, indent=1))
