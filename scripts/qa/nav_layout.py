#!/usr/bin/env python3
"""The navigator's buttons must not cover each other on any phone — SOS above all (26.09.2026: on iPhone SE «+» lay
over SOS; a banner pushed the right column down onto «+ −» on bigger phones too).

Screens as the browser really leaves them (Safari with its bars, Chrome with its bars, installed), upright and on
the side; each with no banner, with a two-line banner, and with the map let go («Ко мне» shown).

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/nav_layout.py [--base URL]
Exit code 1 if any two buttons touch (closer than 4 px) or a button leaves the screen.
"""
import argparse
import json
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8794/")
args = ap.parse_args()

IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
AND = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
SCREENS = [  # name, width, height, UA
    ("iPhone SE Safari", 375, 553, IOS),
    ("iPhone SE installed", 375, 647, IOS),
    ("iPhone 13 mini Safari", 375, 629, IOS),
    ("iPhone 13 Safari", 390, 664, IOS),
    ("iPhone 15 Pro Max Safari", 430, 739, IOS),
    ("Android 360×640", 360, 572, AND),
    ("Android Pixel 7 Chrome", 412, 780, AND),
    ("iPhone SE on its side", 667, 331, IOS),
    ("iPhone 13 on its side", 750, 340, IOS),
    ("Android on its side", 780, 360, AND),
]
IDS = ["btnCompass", "zoomRoute", "btnLayers", "btnDark", "btnSos", "zoomIn", "zoomOut", "zoomAuto", "recenter", "navBanner", "ntVoice", "ntGps"]
TEXT_IDS = ["ntDist", "ntLine2", "ntTarget"]  # the navigation panel's words: the voice switch must not lie over them
MEASURE = """(ids) => {
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el || el.hidden) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    out[id] = [b.left, b.top, b.right, b.bottom];
  }
  const nb = document.getElementById('navBottom').getBoundingClientRect(), nt = document.getElementById('navTop').getBoundingClientRect();
  const text = {};
  for (const id of ['ntDist', 'ntLine2', 'ntTarget']) {
    const el = document.getElementById(id); if (!el) continue;
    const range = document.createRange(); range.selectNodeContents(el);
    // what is seen: the words clipped by their own box (a long name ends in «…» before the voice switch)
    const b = range.getBoundingClientRect(), e = el.getBoundingClientRect();
    const l = Math.max(b.left, e.left), r = Math.min(b.right, e.right);
    if (r > l) text[id] = [l, Math.max(b.top, e.top), r, Math.min(b.bottom, e.bottom)];
  }
  return { rects: out, text, row: document.body.classList.contains('nav-row'), layout: document.body.dataset.layout,
    vw: innerWidth, vh: innerHeight, panels: { top: [nt.left, nt.top, nt.right, nt.bottom], bottom: [nb.left, nb.top, nb.right, nb.bottom] } };
}"""


def problems(m):
    bad = []
    r = m["rects"]
    ids = list(r)
    for i, a in enumerate(ids):
        A = r[a]
        if A[0] < -1 or A[1] < -1 or A[2] > m["vw"] + 1 or A[3] > m["vh"] + 1:
            bad.append(f"{a} off the screen")
        for b in ids[i + 1:]:
            B = r[b]
            if a == "navBanner" or b == "navBanner":
                # the banner is text across the map: only SOS and the column must stay clear of it
                if {a, b} & {"btnSos", "btnLayers", "btnDark", "btnCompass", "zoomRoute"} and A[0] < B[2] and B[0] < A[2] and A[1] < B[3] and B[1] < A[3]:
                    bad.append(f"{a} × {b}")
                continue
            if {a, b} == {"zoomIn", "zoomOut"}:
                continue
            if A[0] < B[2] + 4 and B[0] < A[2] + 4 and A[1] < B[3] + 4 and B[1] < A[3] + 4:
                bad.append(f"{a} × {b}")
        # nothing of the map's own buttons under the navigation panels (the panel's own voice switch and GPS are in it)
        if a not in ("navBanner", "ntVoice", "ntGps"):
            for pn, P in m["panels"].items():
                if P[2] - P[0] > 0 and A[0] < P[2] and P[0] < A[2] and A[1] < P[3] - 1 and P[1] + 1 < A[3]:
                    bad.append(f"{a} under the {pn} panel")
    for tid, T in m.get("text", {}).items():
        for a in ("ntVoice", "ntGps"):
            A = r.get(a)
            if A and A[0] < T[2] and T[0] < A[2] and A[1] < T[3] and T[1] < A[3]:
                bad.append(f"{a} over the text {tid}")
    return bad


report, failed = [], 0
with sync_playwright() as pw:
    b = pw.chromium.launch()
    for name, w, h, ua in SCREENS:
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, is_mobile=True, has_touch=True, user_agent=ua, locale="ru-RU")
        ctx.add_init_script("Object.defineProperty(navigator, 'standalone', { value: false, configurable: true })")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:160]))
        page.goto(args.base, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=60000)
        # the startup GPS check answers late (after startNav here): its iPhone tip would cover the map
        page.evaluate("store.set('ladoga-hint-v2', true); store.set('ladoga-ios-geo-tip', Date.now()); updateHint()")
        page.evaluate("navigator.geolocation.watchPosition = () => 42; navigator.geolocation.getCurrentPosition = () => {}; navigator.geolocation.clearWatch = () => {};")
        # a long name and a long second line: the worst case for the words beside the voice switch
        page.evaluate("state.settings.autoTrack = false; startNav({ lat: 59.953, lon: 31.035, title: 'Начало трека: Шлиссельбург, Кошкинский фарватер' })")
        t0 = int(time.time() * 1000)
        for i in range(3):
            page.evaluate(f"onFix({{ coords: {{ latitude: 60.03, longitude: 31.20, accuracy: 7, speed: 0, heading: -1 }}, timestamp: {t0 + i * 1000} }})")
            page.wait_for_timeout(400)
        page.evaluate("document.getElementById('btnDark').hidden = false")  # it shows when the screen can go dark
        page.wait_for_timeout(300)
        for case in ("plain", "banner", "free"):
            if case == "banner":
                # the navigator redraws its banner every second: hold this one for the check
                page.evaluate("navBanner = () => {}; document.querySelectorAll('.toast').forEach((t) => t.remove())")
                page.evaluate("setBanner({ cls: 'warn', key: 'qa', html: 'Мель впереди: 0,8 м через 240 м — возьмите правее, там глубже 2 м' })")
            if case == "free":
                page.evaluate("setBanner(null); letGo(); updateRecenter()")
            page.wait_for_timeout(500)
            m = page.evaluate(MEASURE, IDS)
            bad = problems(m)
            failed += bool(bad)
            report.append({"screen": name, "case": case, "layout": m["layout"], "row": m["row"], "problems": bad})
            if case == "banner":
                page.screenshot(path=f"research/raw/qa/nav_layout_{name.replace(' ', '_').replace('×', 'x')}.png")
        if errs:
            report.append({"screen": name, "errors": errs}); failed += 1
        ctx.close()
    b.close()
for r in report:
    print(json.dumps(r, ensure_ascii=False))
print("OK" if not failed else f"FAILED: {failed}")
sys.exit(1 if failed else 0)
