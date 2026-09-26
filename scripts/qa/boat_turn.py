#!/usr/bin/env python3
"""The boat on the screen while the map follows the course: it stands in the lower third and stays there.

The recheck of 26.09.2026 found two faults, both seen as the boat jumping on the screen:
  - the map turned about the middle of the screen while the boat stands low: each step of a turn swung the boat
    sideways, and it glided back a second later;
  - with the map not turned yet (the start, before the first course) or left exactly on north the boat was put in
    the middle, turned — low: the first turn threw it 120 px down, gliding.

Two runs, the boat's place measured every 50 ms (Pixel 7, a clock of its own):
  1. north from the start, a 90° turn to the east over 10 s, east;
  2. a channel winding round north, the map turning both ways across 0°/360°: 340° ↔ 20°, 4 s each.

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/boat_turn.py [--base URL]
"""
import argparse
import datetime as dt
import math
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8794/")
args = ap.parse_args()

MPD = 6371008.8 * math.pi / 180
LAT0, LON0 = 60.20, 32.20
K = math.cos(math.radians(LAT0))
SPEED = 6  # m/s, about 22 km/h
# where the boat is and where it should be: the middle across, 72 % down the free area (the map on the course)
PLACE = """(() => { const fr = mapFreeRect(); const low = geo.follow === 'course' || geo.follow === 'compass';
  const want = { x: (fr.left + fr.right) / 2, y: fr.top + (low ? 0.72 : 0.5) * (fr.bottom - fr.top) };
  const p = map.latLngToContainerPoint([geo.me.lat, geo.me.lon]);
  return [Math.hypot(p.x - want.x, p.y - want.y), map.getBearing(), geo.follow]; })()"""
fails = []


def check(name, ok, detail):
    print(f"{'OK  ' if ok else 'FAIL'} {name}: {detail}")
    if not ok:
        fails.append(name)


def drive(page, headings):
    """One fix a second along the given headings; the boat's place 20 times a second. → [(second, px, bearing, follow)]"""
    x = y = 0.0
    out = []
    for sec, h in enumerate(headings):
        x += SPEED * math.sin(math.radians(h)); y += SPEED * math.cos(math.radians(h))
        la, lo = LAT0 + y / MPD, LON0 + x / (MPD * K)
        page.evaluate(f"onFix({{ coords: {{ latitude: {la}, longitude: {lo}, accuracy: 5, speed: {SPEED}, heading: {h} }}, timestamp: Date.now() }})")
        for _ in range(20):
            page.clock.run_for(50)
            px, bearing, follow = page.evaluate(PLACE)
            out.append((sec, px, bearing, follow))
    return out


def start(pw, errs):
    b = pw.chromium.launch()
    ctx = b.new_context(**{**pw.devices["Pixel 7"], "device_scale_factor": 1}, locale="ru-RU", service_workers="block")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.clock.install(time=dt.datetime.fromisoformat("2026-09-27T10:00:00+03:00"))
    page.goto(args.base, wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=90000)
    # GPS from the test only; no track, a fixed zoom (the auto zoom would move the picture on its own)
    page.evaluate("store.set('ladoga-hint-v2', true); navigator.geolocation.watchPosition = () => 42; navigator.geolocation.getCurrentPosition = () => {}; navigator.geolocation.clearWatch = () => {}; state.settings.autoTrack = false; state.settings.autoZoom = false; true")
    page.clock.run_for(2000)
    t = (LAT0 + 3000 / MPD, LON0 + 3000 / (MPD * K))
    page.evaluate(f"onFix({{ coords: {{ latitude: {LAT0}, longitude: {LON0}, accuracy: 5, speed: 0, heading: -1 }}, timestamp: Date.now() }}); startNav({{ lat: {t[0]}, lon: {t[1]}, title: 'Точка' }}); map.setZoom(15, {{ animate: false }}); true")
    page.clock.run_for(1500)
    return b, page


with sync_playwright() as pw:
    # 1. A 90° turn.
    errs = []
    b, page = start(pw, errs)
    heads = [0] * 12 + [9 * (i + 1) for i in range(10)] + [90] * 18
    s = drive(page, heads)
    b.close()
    turn = [z[1] for z in s if 12 <= z[0] < 26]
    after = [z[1] for z in s if z[0] >= 30]
    follows = {z[3] for z in s}
    check("Поворот на 90°: лодка на своём месте", max(turn) <= 10,
          f"дальше всего {max(turn):.1f} px от места (можно 10), обычно {sorted(turn)[len(turn) // 2]:.1f} px; карта повернулась на {360 - s[-1][2]:.0f}°")
    check("После поворота: лодка стоит", max(after) <= 3, f"дальше всего {max(after):.1f} px")
    check("Карта всё время по курсу", follows == {"course"}, ", ".join(sorted(follows)))
    check("Без ошибок на странице", not errs, "; ".join(errs[:3]) or "ошибок нет")

    # 2. A channel winding round north (the map's bearing lands on 0 exactly several times).
    errs = []
    b, page = start(pw, errs)
    heads = [340] * 4 + [20] * 4 + [340] * 4 + [20] * 4 + [0] * 4  # the course follows in ~4 s (smoothed)
    s = drive(page, [0] * 6 + heads)
    b.close()
    wind = [z for z in s if z[0] >= 6]
    worst = max(wind, key=lambda z: z[1])
    signed = [((z[2] + 180) % 360) - 180 for z in wind]  # the map's turn, − to the left of north, + to the right
    check("Протока вокруг севера: лодка не прыгает", worst[1] <= 10,
          f"дальше всего {worst[1]:.1f} px от места (можно 10) на {worst[0] - 5}-й секунде; "
          f"карта поворачивалась от {min(signed):+.0f}° до {max(signed):+.0f}° через север")
    check("Без ошибок на странице", not errs, "; ".join(errs[:3]) or "ошибок нет")

print("RESULT:", "PASS" if not fails else f"FAIL ({len(fails)})")
sys.exit(1 if fails else 0)
