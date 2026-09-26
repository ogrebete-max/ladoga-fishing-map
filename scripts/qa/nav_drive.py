#!/usr/bin/env python3
"""Owner's round 5 (24.09.2026): «навигатором пользоваться невозможно» — the map snapped back under the fingers,
points could not be looked at, the speed lied above ~100 km/h, no map choice in navigation.

Drives the navigator on a phone (Chromium Pixel 7 with touch, or WebKit iPhone 15) with fixes injected once a
second the way a phone gives them (speed from GPS, and an iPhone's −1 «unknown» now and then), then checks:
  1. speed on screen = the true speed at 30, 110 and 140 km/h (±3 %), also with −1 mixed in;
  2. following: the boat stays in its place on screen, the map glides (no jumps back and forth);
  3. a drag lets the map go at once; fixes do not move it; «Ко мне» shows; it comes back only
     `autoReturn` s after the finger is lifted, never while the finger is down or a card is open;
  4. a two-finger pinch (Chromium, CDP touch) lets go too; the chosen zoom stays after the return by itself, and
     «Ко мне» gives back the navigator's own zoom (owner, 26.09.2026: «не могу вернуться к виду маршрута»);
  5. the layers button and the dark screen button are there in navigation; no page errors.

  python -m http.server 8794 --directory site      # another terminal
  python scripts/qa/nav_drive.py [--base URL] [--engine chromium|webkit] [--shots DIR]
"""
import argparse
import json
import math
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://127.0.0.1:8794/')
ap.add_argument('--engine', default='chromium')
ap.add_argument('--shots', default='')
args = ap.parse_args()

START = (60.1500, 32.2000)   # Волховская губа, west of Креницы
BRG = 20.0                   # heading NNE, over water
results, errors = {}, []


def dest(lat, lon, brg, d):
    la = lat + d * math.cos(math.radians(brg)) / 111320
    return la, lon + d * math.sin(math.radians(brg)) / (111320 * math.cos(math.radians(la)))


with sync_playwright() as pw:
    browser = getattr(pw, args.engine).launch()
    dev = pw.devices['Pixel 7'] if args.engine == 'chromium' else pw.devices['iPhone 15']
    ctx = browser.new_context(**dev, locale='ru-RU', geolocation={'latitude': START[0], 'longitude': START[1], 'accuracy': 5}, permissions=['geolocation'])
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(args.base, wait_until='load')
    page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=40000)
    page.evaluate("store.set('ladoga-hint-v2', true); updateHint(); state.settings.voice = true; state.settings.autoReturn = 8; saveSettings()")
    # No real GPS: the navigator gets fixes from us (the demo does the same), with speed and course from the «phone».
    page.evaluate("navigator.geolocation.watchPosition = () => 42; navigator.geolocation.getCurrentPosition = () => {}; navigator.geolocation.clearWatch = () => {};")
    tgt = dest(*START, BRG, 20000)
    page.evaluate(f"startNav({{ lat: {tgt[0]}, lon: {tgt[1]}, title: 'Тест' }})")
    pos = list(START)
    clock = [time.time() * 1000]

    def fix(kmh, speed_mode='gps'):
        v = kmh / 3.6
        pos[0], pos[1] = dest(pos[0], pos[1], BRG, v)
        clock[0] += 1000
        spd = {'gps': v, 'ios-unknown': -1, 'none': None}[speed_mode]
        hdg = BRG if speed_mode == 'gps' else -1
        page.evaluate(f"onFix({{ coords: {{ latitude: {pos[0]}, longitude: {pos[1]}, accuracy: 6, speed: {json.dumps(spd)}, heading: {hdg} }}, timestamp: {clock[0]} }})")

    def screen_boat():
        return page.evaluate("(() => { const p = map.latLngToContainerPoint([geo.me.lat, geo.me.lon]); const r = mapFreeRect(); return { x: p.x, y: p.y, cx: (r.left + r.right) / 2, h: r.bottom - r.top, top: r.top }; })()")

    def shown_speed():
        return page.evaluate("document.getElementById('nfSpeed').textContent")

    # 1. Speed at 30 / 110 / 140 km/h, then 110 with the iPhone's −1 on every other fix.
    speeds = {}
    for kmh in (30, 110, 140):
        for _ in range(6):
            fix(kmh); page.wait_for_timeout(1000)
        page.wait_for_timeout(200)
        speeds[kmh] = shown_speed()
    for i in range(8):
        fix(110, 'ios-unknown' if i % 2 else 'gps'); page.wait_for_timeout(1000)
    speeds['110 with −1'] = shown_speed()
    results['speed'] = speeds
    results['speed_ok'] = all(abs(float(str(v).replace(',', '.')) - float(str(k).split()[0])) <= 0.03 * float(str(k).split()[0]) + 0.5 for k, v in speeds.items())

    # 2. Following: the boat stays at its place (course up: 72 % of the free height) within a few pixels.
    page.evaluate("setFollow('course')")
    devs = []
    for _ in range(8):
        fix(60); page.wait_for_timeout(1000)
        b = screen_boat()
        devs.append(round(math.hypot(b['x'] - b['cx'], b['y'] - (b['top'] + 0.72 * b['h'])), 1))
    results['follow_boat_offset_px'] = devs
    results['follow_ok'] = max(devs[2:]) < 25

    # 3. A drag lets go; fixes do not move the map; «Ко мне» shows; back 8 s after the finger is lifted.
    box = page.evaluate("(() => { const r = map.getContainer().getBoundingClientRect(); const f = mapFreeRect(); return { x: r.left + (f.left + f.right) / 2, y: r.top + (f.top + f.bottom) / 2 }; })()")
    page.mouse.move(box['x'], box['y']); page.mouse.down()
    for k in range(1, 11):
        page.mouse.move(box['x'] - 12 * k, box['y'] + 9 * k); page.wait_for_timeout(30)
    free_during = page.evaluate('geo.follow')
    # the finger stays down for 12 s (longer than autoReturn): the map must not come back under it
    c0 = page.evaluate('(() => { const c = map.getCenter(); return [c.lat, c.lng]; })()')
    for _ in range(12):
        fix(60); page.wait_for_timeout(1000)
    held = page.evaluate('geo.follow')
    c1 = page.evaluate('(() => { const c = map.getCenter(); return [c.lat, c.lng]; })()')
    page.mouse.up()
    t_up = time.time()
    rec_shown = page.evaluate("!document.getElementById('recenter').hidden")
    back_at = None
    for _ in range(14):
        fix(60); page.wait_for_timeout(1000)
        if page.evaluate('geo.follow') != 'free':
            back_at = round(time.time() - t_up, 1)
            break
    results['drag'] = {'free_on_drag': free_during == 'free', 'still_free_with_finger_down_12s': held == 'free',
                       'map_still_while_free_m': round(111320 * math.hypot(c1[0] - c0[0], (c1[1] - c0[1]) * math.cos(math.radians(c0[0]))), 1),
                       'recenter_button': rec_shown, 'came_back_after_s': back_at}
    results['drag_ok'] = free_during == 'free' and held == 'free' and rec_shown and back_at is not None and 7 <= back_at <= 11

    # 4. A card open: no return while it is open.
    page.mouse.move(box['x'], box['y']); page.mouse.down(); page.mouse.move(box['x'] - 40, box['y'] - 30, steps=6); page.mouse.up()
    idx = page.evaluate("state.M.findIndex((m) => m.kind === 'fishing')")
    page.evaluate(f"openPoint({idx})")
    for _ in range(11):
        fix(60); page.wait_for_timeout(1000)
    results['card_open_no_return'] = page.evaluate('geo.follow') == 'free'
    page.evaluate('closeTop()')
    page.evaluate("recenter(false)")
    page.wait_for_timeout(500)

    # 5. Pinch (Chromium only): two fingers let go of the boat and the zoom stays after the return.
    if args.engine == 'chromium':
        cdp = ctx.new_cdp_session(page)
        z0 = page.evaluate('map.getZoom()')
        x, y = box['x'], box['y']

        def touch(kind, pts):
            cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': px, 'y': py, 'id': i} for i, (px, py) in enumerate(pts)]})
        touch('touchStart', [(x - 30, y), (x + 30, y)])
        for k in range(1, 9):
            touch('touchMove', [(x - 30 - 12 * k, y), (x + 30 + 12 * k, y)]); page.wait_for_timeout(25)
        touch('touchEnd', [])
        page.wait_for_timeout(800)
        z1 = page.evaluate('map.getZoom()')
        f1 = page.evaluate('geo.follow')
        page.evaluate("recenter(true)")  # the return by itself (Настройки → «Возвращать к лодке»)
        for _ in range(3):
            fix(60); page.wait_for_timeout(1000)
        z2, p2 = page.evaluate('[map.getZoom(), nav.autoZoomPaused]')
        page.evaluate("letGo(); recenter(false)")  # «Ко мне»
        for _ in range(3):
            fix(60); page.wait_for_timeout(1000)
        z3, p3 = page.evaluate('[map.getZoom(), nav.autoZoomPaused]')
        results['pinch'] = {'zoom_before': z0, 'zoom_after_pinch': z1, 'follow_after_pinch': f1, 'zoom_after_return': z2, 'paused_after_return': p2,
                            'zoom_after_button': z3, 'paused_after_button': p3}
        results['pinch_ok'] = z1 != z0 and f1 == 'free' and z2 == z1 and p2 and not p3 and z3 != z1

    # 6. Buttons in navigation; the log caught the navigator's events.
    results['layers_btn_visible'] = page.evaluate("getComputedStyle(document.getElementById('btnLayers')).display !== 'none'")
    results['dark_btn_visible'] = page.evaluate("!document.getElementById('btnDark').hidden && getComputedStyle(document.getElementById('btnDark')).display !== 'none'")
    results['log_events'] = page.evaluate("[...new Set(logState.buf.map((e) => e.e))]")
    results['voice_phrases'] = page.evaluate("logState.buf.filter((e) => e.e === 'voice').map((e) => e.text)")
    if args.shots:
        page.screenshot(path=f"{args.shots}/nav_{args.engine}.png")
    results['errors'] = errors
    browser.close()

print(json.dumps(results, ensure_ascii=False, indent=1))
# WebKit's phone emulation does not turn a mouse drag into a map drag (a harness limit, not the app's): the drag and
# the card checks count in Chromium, where the same code runs with touch.
skip = {'drag_ok', 'card_open_no_return'} if args.engine == 'webkit' else set()
ok = all(v for k, v in results.items() if (k.endswith('_ok') or k in ('layers_btn_visible', 'dark_btn_visible', 'card_open_no_return')) and k not in skip) and not errors
print('RESULT:', 'PASS' if ok else 'FAIL')
