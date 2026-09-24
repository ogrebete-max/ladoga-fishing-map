#!/usr/bin/env python3
"""Owner's report 23.09.2026: near the edge of the area (Saint Petersburg) with ◎ on, the map jerked once a second,
everything lagged and the track could not be stopped.

Reproduces it in iPhone 15 WebKit: GPS near the western edge, follow «north», zoomed out to z9 (as in the owner's
video), fixes every second; measures how often the map centre jumps and back, then records a track, pauses it and
stops / saves it through the sheets, timing each step.

  python -m http.server 8792 --directory site      # another terminal
  python scripts/qa/edge_follow.py [--base URL] [--lat 59.935 --lon 30.32] [--zoom 9]
"""
import argparse
import json
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://localhost:8792/')
ap.add_argument('--lat', type=float, default=59.935)
ap.add_argument('--lon', type=float, default=30.32)
ap.add_argument('--zoom', type=int, default=9)
ap.add_argument('--engine', default='webkit')
args = ap.parse_args()

IOS_JS = "try { if (navigator.standalone === undefined) Object.defineProperty(Navigator.prototype, 'standalone', { get: () => false, configurable: true }); } catch (e) {}"
out = {'base': args.base, 'at': [args.lat, args.lon], 'zoom': args.zoom}
with sync_playwright() as pw:
    browser = getattr(pw, args.engine).launch()
    dev = pw.devices['iPhone 15'] if args.engine == 'webkit' else pw.devices['Pixel 7']
    ctx = browser.new_context(**dev, geolocation={'latitude': args.lat, 'longitude': args.lon, 'accuracy': 8}, permissions=['geolocation'], locale='ru-RU')
    ctx.add_init_script(IOS_JS)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(args.base, wait_until='load')
    page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=30000)
    page.evaluate("store.set('ladoga-hint-v2', true); updateHint()")
    page.click('#btnLocate')
    fix_no = [0]

    def fix():
        fix_no[0] += 1
        d = 0.00002 * (fix_no[0] % 3)
        ctx.set_geolocation({'latitude': args.lat + d, 'longitude': args.lon + d, 'accuracy': 8})

    for _ in range(4):
        fix(); page.wait_for_timeout(1000)
    page.evaluate(f"map.setZoom({args.zoom}, {{ animate: false }})")
    out['follow'] = page.evaluate('geo.follow')
    # 6 s of fixes, the map centre sampled every 100 ms: count the reversals of its movement.
    samples = []
    t0 = time.time()
    while time.time() - t0 < 6:
        if int((time.time() - t0) * 10) % 10 == 0:
            fix()
        c = page.evaluate('(() => { const c = map.getCenter(); return [c.lat, c.lng]; })()')
        samples.append(c)
        page.wait_for_timeout(100)
    moves = [((b[0] - a[0]) * 111320, (b[1] - a[1]) * 55600) for a, b in zip(samples, samples[1:])]
    big = [m for m in moves if abs(m[0]) + abs(m[1]) > 200]
    out['center_moves_over_200m'] = len(big)
    out['follow_after'] = page.evaluate('geo.follow')
    out['me'] = page.evaluate('geo.me && [geo.me.lat, geo.me.lon]')
    out['center_end'] = samples[-1]
    # A track: start, pause, stop, save — each through the real buttons.
    steps = []

    def step(name, fn, check, timeout=5000):
        t = time.time()
        try:
            fn()
            page.wait_for_function(check, timeout=timeout)
            steps.append([name, 'ok', round((time.time() - t) * 1000)])
        except Exception as e:  # noqa: BLE001
            steps.append([name, 'FAIL', str(e)[:160], page.evaluate('ui.stack.map((l) => l.kind + ":" + (l.key || l.page || ""))')])

    step('start', lambda: page.click('#btnTrack'), 'trk.cur && trk.cur.state === "rec"')
    for _ in range(3):
        fix(); page.wait_for_timeout(1000)
    step('open sheet', lambda: page.click('#btnTrack'), 'topLayer() && topLayer().key === "rec"')
    step('pause', lambda: page.click('#modalBody [data-act="rec-pause"]'), 'trk.cur.state === "paused"')
    for _ in range(2):
        fix(); page.wait_for_timeout(1000)
    step('stop', lambda: page.click('#modalBody [data-act="rec-stop"]'), 'topLayer() && topLayer().key === "track-save"')
    for _ in range(2):
        fix(); page.wait_for_timeout(1000)
    step('save', lambda: page.click('#modalFoot [data-act="track-save"]'), '!trk.cur && topLayer() && topLayer().kind === "card"')
    out['steps'] = steps
    out['errors'] = errors
    page.screenshot(path='research/raw/qa/edge_follow_end.png')
    browser.close()
print(json.dumps(out, ensure_ascii=False, indent=1))
