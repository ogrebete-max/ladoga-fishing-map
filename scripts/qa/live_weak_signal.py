#!/usr/bin/env python3
"""Weak signal on the water: the LIVE site with its service worker, data files answered by the network only after
a delay. Does the app start from the cached data (fast) or wait for the network (network-first)? Chromium, 3 loads.

  python scripts/qa/live_weak_signal.py
"""
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_qa import LIVE, OUT, QA_JS  # noqa: E402

DELAY = 8.0


def main():
    res = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        dev = dict(p.devices['Pixel 7'])
        dev.pop('default_browser_type', None)
        ctx = b.new_context(**dev, service_workers='allow', locale='ru-RU')
        ctx.add_init_script(QA_JS)
        page = ctx.new_page()
        page.goto(LIVE, wait_until='domcontentloaded', timeout=90000)
        page.wait_for_function('() => typeof state !== "undefined" && state.M.length > 0', timeout=90000)
        for _ in range(60):
            ok = page.evaluate('''async () => { const r = await navigator.serviceWorker.getRegistration(); if (!r || !r.active || !navigator.serviceWorker.controller) return false;
                for (const k of await caches.keys()) if (k.startsWith('ladoga-v') && (await (await caches.open(k)).keys()).some((q) => q.url.includes('data/points.json'))) return true; return false; }''')
            if ok:
                break
            page.wait_for_timeout(1000)
        res['sw_ready'] = ok
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function('() => __qa.marks.data', timeout=60000)
        res['normal_reload_data_ms'] = page.evaluate('Math.round(__qa.marks.data)')
        hits = []

        def slow(route, request):
            hits.append(request.url.split('/')[-1])
            time.sleep(DELAY)
            route.continue_()
        ctx.route(re.compile(r'.*/data/(points|context)\.json.*'), slow)
        t0 = time.time()
        page.reload(wait_until='domcontentloaded', timeout=90000)
        page.wait_for_function('() => __qa.marks.data', timeout=90000)
        res['weak_signal_data_ms'] = page.evaluate('Math.round(__qa.marks.data)')
        res['weak_signal_tile_ms'] = page.evaluate('Math.round(__qa.marks.tile || 0)')
        res['intercepted'] = hits
        res['delay_s'] = DELAY
        res['wall_s'] = round(time.time() - t0, 1)
        b.close()
    print(json.dumps(res, ensure_ascii=False))
    (OUT / 'live_weak_signal.json').write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
