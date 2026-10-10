#!/usr/bin/env python3
"""How smoothly the map follows a finger (the owner, 10.10.2026: «карта постоянно подвисает, плохо подгружается и
плохо листается», iPhone; a measurement from the «Топливо» chat on a Pixel 7 with the processor slowed 4×: the
finger dragged the map 2.1 s instead of ~0.4 s, frames stood 1.2 s — the drawing, not the scripts or the network).

A Pixel 7 in Chromium, the processor slowed 4× (as that measurement), the map at «Мой район» (the whole south
Ladoga — the owner pressed it again and again) and closer. Five drags of the map with a finger (touch events: a
mouse makes the browser look for the element under it at every move, a finger does not), 24 steps each; the time of
every frame is recorded. For each setting: how long the drags took, the longest frame, frames over 50 ms. Settings:
the app as it opens (day / night), and with one suspect off at a time (the depth charts, the reeds, the points, the
Esri names) — to see what the drawing spends its time on.

Found with it on 10.10.2026: all ~450 points of interest were on the page at once (now only those near the view),
and at night a CSS filter over the map panes was worked out on every frame (now a dark layer, app.js «nightshade»).
WebKit is not slowed by this script (no such tool in it): compare old and new code there in turn.

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/drag_frames.py [--base URL] [--only day,night] [--rate 4] [--max-frame 120]
Exit code 1 when a setting listed in --check has its longest drag frame above --max-frame ms.
"""
import argparse
import json
import pathlib
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8794/")
ap.add_argument("--rate", type=float, default=4)
ap.add_argument("--only", default="")
ap.add_argument("--check", default="")
ap.add_argument("--max-frame", type=float, default=120)
args = ap.parse_args()
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "research" / "raw" / "qa" / "drag_frames"
OUT.mkdir(parents=True, exist_ok=True)

# name: (theme, extra JS after load, extra CSS)
SETTINGS = {
    "day": ("day", "", ""),
    "night": ("night", "", ""),
    "day-nocharts": ("day", "state.overlays.charts = false; applyOverlays();", ""),
    "day-noreeds": ("day", "state.overlays.reeds = false; applyOverlays();", ""),
    "day-nopoints": ("day", "state.overlays.cluster = false; map.removeLayer(layers.cluster || L.layerGroup()); document.querySelectorAll('.leaflet-marker-pane').forEach((p) => p.style.display = 'none');", ""),
    "day-nolabels": ("day", "", ".leaflet-tile-pane .leaflet-layer:nth-child(2) { display: none !important; }"),
}
FRAMES = """(() => { window.__fr = []; let on = true; window.__frStop = () => { on = false; };
  const loop = (t) => { window.__fr.push(t); if (on) requestAnimationFrame(loop); }; requestAnimationFrame(loop); true; })()"""


def drag(cdp, page, cx, cy, dx, dy, steps=24, step_ms=16):
    """A finger, not a mouse: touch events (a mouse makes the browser look for the element under it at every move,
    which a finger on a phone does not)."""
    t0 = time.time()
    pt = lambda x, y: [{"x": x, "y": y, "id": 1, "radiusX": 8, "radiusY": 8, "force": 1}]
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pt(cx, cy)})
    for i in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pt(cx + dx * i / steps, cy + dy * i / steps)})
        page.wait_for_timeout(step_ms)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    return time.time() - t0


def measure(pw, name, view):
    theme, js, css = SETTINGS[name]
    b = pw.chromium.launch()
    ctx = b.new_context(**pw.devices["Pixel 7"], locale="ru-RU", service_workers="block")
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:160]))
    page.goto(args.base, wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=90000)
    page.evaluate(f"store.set('ladoga-hint-v2', true); setSetting('theme', '{theme}'); true")
    if css:
        page.add_style_tag(content=css)
    if js:
        page.evaluate(js + "; true")
    if view == "home":
        page.evaluate("map.fitBounds(homeBounds(), { animate: false }); true")
    else:
        page.evaluate("map.setView([60.2, 32.25], 12, { animate: false }); true")
    # every tile in, then the processor slowed as in the measurement
    page.wait_for_timeout(6000)
    cdp = ctx.new_cdp_session(page)
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": args.rate})
    page.wait_for_timeout(1500)
    vw, vh = page.viewport_size["width"], page.viewport_size["height"]
    cx, cy = vw / 2, vh * 0.55
    durs, gaps_all, long_all = [], [], []
    for k in range(5):
        page.evaluate(FRAMES)
        page.wait_for_timeout(300)
        dx, dy = ((-1) ** k) * 140, ((-1) ** (k + 1)) * 100
        durs.append(drag(cdp, page, cx, cy, dx, dy))
        page.wait_for_timeout(1200)
        fr = page.evaluate("(() => { window.__frStop(); return window.__fr; })()")
        gaps = [b2 - a for a, b2 in zip(fr, fr[1:])]
        gaps_all.append(max(gaps) if gaps else 0)
        long_all.append(sum(1 for g in gaps if g > 50))
    page.screenshot(path=str(OUT / f"{name}_{view}.png"))
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    tiles = page.evaluate("document.querySelectorAll('.leaflet-tile-loaded').length")
    b.close()
    return {"setting": name, "view": view, "drag_s": round(statistics.median(durs), 2), "drag_s_all": [round(x, 2) for x in durs],
            "max_frame_ms": round(statistics.median(gaps_all)), "max_frame_ms_all": [round(x) for x in gaps_all],
            "frames_over_50ms": long_all, "tiles": tiles, "errors": errs}


names = [n for n in (args.only.split(",") if args.only else SETTINGS) if n]
res, bad = [], []
with sync_playwright() as pw:
    for view in ("home", "z12"):
        for n in names:
            r = measure(pw, n, view)
            res.append(r)
            print(f"{n:<16} {view:<5} перетаскивание {r['drag_s']} с {r['drag_s_all']}, самый долгий кадр {r['max_frame_ms']} мс {r['max_frame_ms_all']}, кадров >50 мс {r['frames_over_50ms']}, плиток {r['tiles']}{', ошибки ' + str(r['errors'][:1]) if r['errors'] else ''}")
            if n in args.check.split(",") and r["max_frame_ms"] > args.max_frame:
                bad.append(f"{n}/{view}: {r['max_frame_ms']} мс")
(OUT / "results.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print("RESULT:", "OK" if not bad else f"FAIL {bad}")
sys.exit(1 if bad else 0)
