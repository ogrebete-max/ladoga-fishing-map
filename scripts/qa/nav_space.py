#!/usr/bin/env python3
"""How much of the screen the navigator leaves to the map (the owner, 28.09.2026: «экран карты и самих значков
навигации занимает пол-экрана… в горизонтальном просто полэкрана»).

The navigator on the road (a car at 110 km/h, 159 km to go — as on the owner's screenshots) on four screens:
iPhone installed to the home screen, standing and on its side (the notch and the home bar as on a real iPhone:
the safe-area insets are set by hand, a browser here has none), Android standing and on its side. For each: the
height of the top panel and of the bottom one, or the width of the side panel, and the share of the screen the map
keeps for the boat and the route (the free area the navigator itself uses to place the boat). A screenshot of each.

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/nav_space.py [--base URL] [--tag after] [--min-share 0.66]
Exit code 1 when the map keeps less than --min-share of any screen, or when panels cover each other.
"""
import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8794/")
ap.add_argument("--tag", default="now")
ap.add_argument("--min-share", type=float, default=0.0)
ap.add_argument("--scheme", default="light", choices=["light", "dark"])
args = ap.parse_args()
ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = ROOT / "research" / "raw" / "qa" / "nav_space"
SHOTS.mkdir(parents=True, exist_ok=True)
IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
AND = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
# name, engine, width, height, UA, safe-area insets t r b l (an installed iPhone app: under the status bar and the home bar)
SCREENS = [
    ("iPhone standing", "webkit", 390, 844, IOS, (47, 0, 34, 0)),
    ("iPhone on its side", "webkit", 844, 390, IOS, (0, 47, 21, 47)),
    ("Android standing", "chromium", 412, 839, AND, (24, 0, 0, 0)),
    ("Android on its side", "chromium", 863, 360, AND, (0, 0, 0, 0)),
]
MEASURE = """() => {
  const r = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return b.width && b.height ? [b.left, b.top, b.right, b.bottom].map(Math.round) : null; };
  const fr = mapFreeRect(), c = map.getContainer().getBoundingClientRect();
  const free = Math.max(0, fr.right - fr.left) * Math.max(0, fr.bottom - fr.top);
  const words = (id) => { const e = document.getElementById(id); if (!e || e.hidden || !e.textContent.trim()) return null;
    const rg = document.createRange(); rg.selectNodeContents(e); const b = rg.getBoundingClientRect(), o = e.getBoundingClientRect();
    const l = Math.max(b.left, o.left), rr = Math.min(b.right, o.right - parseFloat(getComputedStyle(e).paddingRight));
    return rr > l ? [l, Math.max(b.top, o.top), rr, Math.min(b.bottom, o.bottom)].map(Math.round) : null; };
  const vis = {};
  for (const id of ['ntDist', 'ntLine2', 'ntTarget', 'nfSpeed', 'nfCourse', 'nfDepth']) vis[id] = words(id);
  for (const id of ['ntVoice', 'ntGps', 'navEnd', 'navTrack', 'navMark', 'navMore']) vis[id] = r(id);
  return { vw: innerWidth, vh: innerHeight, layout: document.body.dataset.layout, top: r('navTop'), bottom: r('navBottom'),
    map: [c.left, c.top, c.right, c.bottom].map(Math.round), free: [fr.left, fr.top, fr.right, fr.bottom].map(Math.round),
    share: free / (innerWidth * innerHeight), vis,
    texts: { dist: document.getElementById('ntDist').textContent, line2: document.getElementById('ntLine2').textContent, target: document.getElementById('ntTarget').textContent } };
}"""
out, bad = [], []
with sync_playwright() as pw:
    for name, engine, w, h, ua, (st, sr, sb, sl) in SCREENS:
        b = getattr(pw, engine).launch()
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, is_mobile=engine == "chromium", has_touch=True, user_agent=ua, locale="ru-RU", service_workers="block", color_scheme=args.scheme)
        ctx.add_init_script("Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:160]))
        page.goto(args.base, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=90000)
        page.evaluate(f"""document.documentElement.style.setProperty('--safe-t', '{st}px'); document.documentElement.style.setProperty('--safe-r', '{sr}px');
          document.documentElement.style.setProperty('--safe-b', '{sb}px'); document.documentElement.style.setProperty('--safe-l', '{sl}px');
          store.set('ladoga-hint-v2', true); store.set('ladoga-ios-geo-tip', Date.now()); updateHint();
          navigator.geolocation.watchPosition = () => 42; navigator.geolocation.getCurrentPosition = () => {{}}; navigator.geolocation.clearWatch = () => {{}}; true""")
        # a car on the road towards a point 159 km away, as on the owner's screenshots
        page.evaluate("state.settings.autoTrack = true; startNav({ lat: 60.62, lon: 34.95, title: 'Судак' }); true")
        for i in range(6):
            page.evaluate(f"onFix({{ coords: {{ latitude: {60.02 + i * 0.0006}, longitude: {30.33 + i * 0.0012}, accuracy: 2, speed: 30.5, heading: 63 }}, timestamp: Date.now() }}); true")
            page.wait_for_timeout(700)
        page.wait_for_timeout(1500)
        m = page.evaluate(MEASURE)
        m["name"] = name
        m["errors"] = errs
        if m["share"] < args.min_share:
            bad.append(f"{name}: карте {m['share']:.0%}")
        # panels must not cover each other's words and buttons
        ids = [k for k, v in m["vis"].items() if v]
        for i, a in enumerate(ids):
            for k in ids[i + 1:]:
                A, B = m["vis"][a], m["vis"][k]
                if A[0] < B[2] - 1 and B[0] < A[2] - 1 and A[1] < B[3] - 1 and B[1] < A[3] - 1:
                    bad.append(f"{name}: {a} × {k}")
        if errs:
            bad.append(f"{name}: ошибки {errs[:2]}")
        out.append(m)
        top = m["top"]; bot = m["bottom"]
        if m["layout"] == "compact":
            desc = f"верхняя панель {top[3] - top[1] if top else 0} px, нижняя {bot[3] - bot[1] if bot else 0} px из {m['vh']}"
        else:
            desc = f"боковая панель {max(top[2] if top else 0, bot[2] if bot else 0)} px из {m['vw']}"
        print(f"{name} ({m['vw']}×{m['vh']}): {desc}; карте остаётся {m['share']:.0%} экрана")
        page.screenshot(path=str(SHOTS / f"{args.tag}_{name.replace(' ', '_')}.png"))
        b.close()
(SHOTS / f"{args.tag}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("RESULT:", "OK" if not bad else f"FAIL {bad}")
sys.exit(1 if bad else 0)
