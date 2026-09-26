#!/usr/bin/env python3
"""The way out through a channel in the reeds, alone (the first part of fisher_day.py, a few minutes): the navigator
must not keep saying «Мелко впереди» and «Поверните левее на 145°» along a channel the charts do not know — only for
the first seconds, until it sees it is in a channel — and must speak again on open water.

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/channel_quiet.py [--base URL]
"""
import argparse
import datetime as dt
import json
import math
import random
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8794/")
args = ap.parse_args()
rnd = random.Random(5)
MPD = 6371008.8 * math.pi / 180
LAUNCH = (60.1265, 32.3035)
K = math.cos(math.radians(LAUNCH[0]))
ll = lambda x, y: (LAUNCH[0] + y / MPD, LAUNCH[1] + x / (MPD * K))

# the same channel as fisher_day.py: ~2 km of bends north-north-east from the Волхов mouth, then open water
CHANNEL = [(0.0, 0.0)]
x, y, h = 0.0, 0.0, 15.0
for b in [55, -60, 70, -45, 80, -75, 35, -50, 65, -70, 40, -55, 75, -60, 50, -40, 60, -65, 45, -35, 30, -55, 70, -40, 55, -50]:
    for _ in range(int((60 + rnd.random() * 20) / 4)):
        x += 4 * math.sin(math.radians(h)); y += 4 * math.cos(math.radians(h)); CHANNEL.append((x, y))
    for _ in range(3):
        h += b / 3
        x += 4 * math.sin(math.radians(h)); y += 4 * math.cos(math.radians(h)); CHANNEL.append((x, y))
end = CHANNEL[-1]
OPEN = [(end[0] - 0.3 * s, end[1] + s) for s in range(4, 1200, 4)]  # then open water to the north
WAY = [(p, 5.0, True) for p in CHANNEL[::1]] + [(p, 8.0, False) for p in OPEN[::2]]

with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(**{**pw.devices["Pixel 7"], "device_scale_factor": 1}, locale="ru-RU", service_workers="block")
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.clock.install(time=dt.datetime.fromisoformat("2026-09-27T06:40:00+03:00"))
    page.goto(args.base, wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=90000)
    page.evaluate("store.set('ladoga-hint-v2', true); navigator.geolocation.watchPosition = () => 42; navigator.geolocation.getCurrentPosition = () => {}; navigator.geolocation.clearWatch = () => {};")
    page.clock.run_for(3000)
    t_lat, t_lon = ll(OPEN[-1][0], OPEN[-1][1] + 800)
    page.evaluate(f"onFix({{ coords: {{ latitude: {LAUNCH[0]}, longitude: {LAUNCH[1]}, accuracy: 5, speed: 0, heading: -1 }}, timestamp: Date.now() }}); state.settings.autoTrack = false; startNav({{ lat: {t_lat}, lon: {t_lon}, title: 'Точка за протокой' }})")
    page.clock.run_for(1500)
    counts = {"ch": {"steps": 0, "shoal": 0, "course": 0}, "open": {"steps": 0, "shoal": 0, "course": 0}}
    reeds_at = None
    prev = WAY[0][0]
    for i, (p, spd, in_ch) in enumerate(WAY):
        hdg = (math.degrees(math.atan2(p[0] - prev[0], p[1] - prev[1])) + 360) % 360
        prev = p
        la, lo = ll(p[0] + rnd.gauss(0, 1.5), p[1] + rnd.gauss(0, 1.5))
        s = page.evaluate(f"(() => {{ onFix({{ coords: {{ latitude: {la}, longitude: {lo}, accuracy: 5, speed: {spd}, heading: {hdg} }}, timestamp: Date.now() }}); const b = document.getElementById('navBanner'); return {{ banner: b.hidden ? '' : b.innerText, reeds: nav.inReeds }}; }})()")
        page.clock.run_for(1000)
        c = counts["ch" if in_ch else "open"]
        c["steps"] += 1
        c["shoal"] += "Мелко" in s["banner"]
        c["course"] += "Поверните" in s["banner"]
        if s["reeds"] and reeds_at is None:
            reeds_at = i
    said = page.evaluate("logState.buf.filter((e) => e.e === 'voice').map((e) => e.text)")
    reeds_log = page.evaluate("logState.buf.filter((e) => e.e === 'reeds_in' || e.e === 'reeds_out').map((e) => e.e)")
    b.close()
out = {"counts": counts, "reeds_from_step": reeds_at, "reeds_log": reeds_log, "voice": said[-12:], "errors": errs}
print(json.dumps(out, ensure_ascii=False, indent=1))
ok = counts["ch"]["shoal"] <= 12 and counts["ch"]["course"] <= 12 and "reeds_out" in reeds_log and not errs
print("OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
