#!/usr/bin/env python3
"""One first visit of the LIVE site on a throttled mobile connection (Chromium, Pixel 7): when do the data,
the first points and the first satellite tile appear, and how many bytes does the data weigh. Two page loads.

  python scripts/qa/live_slow_net.py
"""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_qa import QA_JS, LIVE, OUT  # noqa: E402

NETS = [('медленный 4G', 1600, 150), ('плохой 3G', 400, 400)]  # kbit/s down, RTT ms


def main():
    res = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, kbps, rtt in NETS:
            dev = dict(p.devices['Pixel 7'])
            dev.pop('default_browser_type', None)
            ctx = b.new_context(**dev, service_workers='block', locale='ru-RU')
            ctx.add_init_script(QA_JS)
            page = ctx.new_page()
            cdp = ctx.new_cdp_session(page)
            cdp.send('Network.enable')
            cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': rtt, 'downloadThroughput': kbps * 1024 / 8, 'uploadThroughput': 750 * 1024 / 8})
            t0 = time.time()
            page.goto(LIVE, wait_until='domcontentloaded', timeout=180000)
            page.wait_for_function('() => __qa.marks.tile && __qa.marks.marker', timeout=180000)
            m = page.evaluate('''() => { const n = performance.getEntriesByType('navigation')[0];
                const r = performance.getEntriesByType('resource');
                const pick = (s) => { const x = r.find((e) => e.name.includes(s)); return x ? { kb: Math.round(x.transferSize / 1024), decodedKb: Math.round(x.decodedBodySize / 1024), end: Math.round(x.responseEnd) } : null; };
                const local = r.filter((e) => e.name.startsWith(location.origin));
                return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), data: Math.round(__qa.marks.data), marker: Math.round(__qa.marks.marker), tile: Math.round(__qa.marks.tile),
                  points: pick('data/points.json'), context: pick('data/context.json'), appjs: pick('app.js'),
                  localTransferKb: Math.round(local.reduce((a, e) => a + (e.transferSize || 0), 0) / 1024) }; }''')
            m['wall_s'] = round(time.time() - t0, 1)
            res[name] = m
            print(name, json.dumps(m, ensure_ascii=False))
            ctx.close()
        b.close()
    (OUT / 'live_slow_net.json').write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
