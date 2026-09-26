#!/usr/bin/env python3
"""The owner's report of 26.09.2026 (screenshots through the «СПб Топливо» session), reproduced:
  1. «По месяцам» → ✕ does not close the banner; the log has «TypeError: … this._map._animating · leaflet-heat.js»;
  2. the navigator to a point 13,7 km away, standing still, ГосГисЦентр base: zoomed in to 100 m — only water,
     «Авто» and «Ко мне» do nothing;
  3. the weather places on «Сегодня» first did not react, then slowly.

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/owner_repro_0926.py [--base URL]
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
out = {}
with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(**pw.devices["Pixel 7"], locale="ru-RU")
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.goto(args.base, wait_until="domcontentloaded")
    page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=60000)
    page.evaluate("store.set('ladoga-hint-v2', true); updateHint()")
    page.wait_for_timeout(1500)
    ggc = page.evaluate("Object.keys(BASES).find((k) => /ggc|госгис/i.test(k + (BASES[k].name || ''))) || ''")
    if ggc:
        page.evaluate(f"setBase('{ggc}')")
    out["base"] = ggc
    # 1. The month show, then its ✕.
    page.evaluate("typeof openMonths === 'function' ? openMonths() : (document.querySelector('[data-act=\"months\"]') || {}).click?.()")
    page.wait_for_timeout(800)
    opened = page.evaluate("!document.getElementById('monthBanner').hidden")
    if not opened:
        page.evaluate("seasonModeOn(); openLayer({ kind: 'months', onClose: seasonModeOff })")
        page.wait_for_timeout(500)
    page.click("#mbPlay"); page.wait_for_timeout(1500)
    page.click("#mbClose"); page.wait_for_timeout(1500)
    out["months_closed"] = page.evaluate("document.getElementById('monthBanner').hidden")
    out["errors_after_months"] = list(errs)
    # The same ✕ when something inside the redraw fails: the show must still close, the error must reach the log.
    page.evaluate("seasonModeOn(); openLayer({ kind: 'months', onClose: () => seasonModeOff() })")
    page.wait_for_timeout(500)
    page.evaluate("window.__render = render; render = () => { render = window.__render; throw new Error('qa: render failed'); }; true")
    page.click("#mbClose"); page.wait_for_timeout(1200)
    out["months_closed_despite_error"] = page.evaluate("document.getElementById('monthBanner').hidden")
    out["error_logged"] = page.evaluate("logState.buf.some((e) => e.e === 'error' && /qa: render failed/.test(JSON.stringify(e)))")
    errs[:] = [e for e in errs if "qa: render failed" not in e]
    # 2. The navigator, standing still 13,7 km from the point.
    page.evaluate("navigator.geolocation.watchPosition = () => 42; navigator.geolocation.getCurrentPosition = () => {}; navigator.geolocation.clearWatch = () => {};")
    me = (60.03, 31.20)
    page.evaluate(f"startNav({{ lat: 59.953, lon: 31.035, title: 'Начало: Шлиссельбург' }})")
    t0 = int(time.time() * 1000)
    for i in range(4):
        page.evaluate(f"onFix({{ coords: {{ latitude: {me[0]}, longitude: {me[1]}, accuracy: 7, speed: 0, heading: -1 }}, timestamp: {t0 + i * 1000} }})")
        page.wait_for_timeout(700)
    snap = "({ z: map.getZoom(), follow: geo.follow, auto: nav.autoZoomPaused, rec: !document.getElementById('recenter').hidden, dist: document.getElementById('ntDist').textContent, boatOnScreen: (() => { const p = map.latLngToContainerPoint([geo.me.lat, geo.me.lon]); const s = map.getSize(); return p.x >= 0 && p.y >= 0 && p.x <= s.x && p.y <= s.y; })(), targetOnScreen: (() => { const p = map.latLngToContainerPoint([nav.target.lat, nav.target.lon]); const s = map.getSize(); return p.x >= 0 && p.y >= 0 && p.x <= s.x && p.y <= s.y; })() })"
    out["nav_start"] = page.evaluate(snap)
    for _ in range(3):
        page.click("#zoomIn"); page.wait_for_timeout(500)
    out["after_zoom_in"] = page.evaluate(snap)
    page.click("#zoomAuto"); page.wait_for_timeout(1500)
    out["after_auto"] = page.evaluate(snap)
    # a drag, then «Ко мне»
    box = page.evaluate("(() => { const r = map.getContainer().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()")
    page.mouse.move(box["x"], box["y"]); page.mouse.down(); page.mouse.move(box["x"] - 150, box["y"] - 120, steps=8); page.mouse.up()
    page.wait_for_timeout(600)
    out["after_drag"] = page.evaluate(snap)
    if out["after_drag"]["rec"]:
        page.click("#recenter"); page.wait_for_timeout(1500)
    out["after_recenter"] = page.evaluate(snap)
    # the owner's way: fingers zoomed in (the map is let go and the zoom is his), then «Авто»
    page.mouse.move(box["x"], box["y"])
    for _ in range(4):
        page.mouse.wheel(0, -400); page.wait_for_timeout(350)
    page.wait_for_timeout(600)
    out["after_fingers"] = page.evaluate(snap)
    page.click("#zoomAuto"); page.wait_for_timeout(1500)
    out["after_auto_free"] = page.evaluate(snap)
    # «Путь»: the whole way on one screen
    page.click("#zoomRoute"); page.wait_for_timeout(1200)
    out["after_route"] = page.evaluate(snap)
    out["errors"] = errs
    b.close()
print(json.dumps(out, ensure_ascii=False, indent=1))
