#!/usr/bin/env python3
"""Do JS event listeners grow during navigation by themselves? Chromium 1280×720, three 3-minute runs:
the boat standing still at the point, the boat moving at 20 km/h, and the map without navigation (control).
Listeners, DOM and heap are read through CDP after a forced garbage collection.

  python scripts/qa/listeners_probe.py
"""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_qa import BASE, OUT, QA_JS, dest, net_cache_handler  # noqa: E402
import re  # noqa: E402

TGT = (60.2980, 32.1070)


def metrics(ctx, page):
    cdp = ctx.new_cdp_session(page)
    cdp.send('HeapProfiler.collectGarbage')
    cdp.send('Performance.enable')
    m = {x['name']: x['value'] for x in cdp.send('Performance.getMetrics')['metrics']}
    cdp.detach()
    return {'listeners': int(m['JSEventListeners']), 'nodes': int(m['Nodes']), 'dom': page.evaluate('document.getElementsByTagName("*").length'),
            'heapMB': round(m['JSHeapUsedSize'] / 1048576, 2), 'tiles': page.evaluate('document.querySelectorAll("img.leaflet-tile").length')}


def run(p, mode):
    b = p.chromium.launch()
    start = dest(TGT[0], TGT[1], 200, 1600) if mode == 'moving' else TGT
    ctx = b.new_context(viewport={'width': 1280, 'height': 720}, permissions=['geolocation'], geolocation={'latitude': start[0], 'longitude': start[1], 'accuracy': 5})
    ctx.add_init_script(QA_JS)
    ctx.route(re.compile(r'^https?://(?!localhost|127\.0\.0\.1)'), net_cache_handler)
    page = ctx.new_page()
    page.goto(BASE)
    page.wait_for_function('() => typeof state !== "undefined" && state.M.length > 0')
    if mode != 'browse':
        page.evaluate('([a, b]) => startNav({ lat: a, lon: b, title: "QA" })', list(TGT))
    t0 = time.time()
    out = []
    step = 0
    while time.time() - t0 < 185:
        el = time.time() - t0
        if mode == 'moving':
            d = min(1600, 5.556 * el)
            pos = dest(start[0], start[1], 20, d)
            ctx.set_geolocation({'latitude': pos[0], 'longitude': pos[1], 'accuracy': 5})
        elif mode == 'still':
            ctx.set_geolocation({'latitude': TGT[0] + 0.00001 * (step % 3), 'longitude': TGT[1], 'accuracy': 5})
        step += 1
        if int(el) in (10, 60, 120, 180) and not any(o['t'] == int(el) for o in out):
            out.append({'t': int(el), **metrics(ctx, page)})
        page.wait_for_timeout(1000)
    b.close()
    return out


def main():
    res = {}
    with sync_playwright() as p:
        for mode in ('still', 'moving', 'browse'):
            res[mode] = run(p, mode)
            print(mode, json.dumps(res[mode]))
    (OUT / 'listeners_probe.json').write_text(json.dumps(res, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
