#!/usr/bin/env python3
"""The app on other days of the year (owner, 25.09.2026: the boat season is over — prepare the winter and the spring).

Opens the app with the phone's clock set to a given day (Playwright clock) and writes what a person sees then:
«Сегодня» (warnings, bans, conditions, «Где искать сейчас», the ice block), «Правила → Действует сегодня», which
layers are on (Опасный лёд), which records are hidden or shown by season (smelt nets in April–May), the season
label. The weather and the server's live data are those of today — only the calendar moves.

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/season_timetravel.py [--base URL] [--days 2027-01-20,2027-04-15,...]
"""
import argparse
import datetime as dt
import json
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8794/")
ap.add_argument("--days", default="2026-12-10,2027-01-20,2027-03-20,2027-04-15,2027-05-10,2027-06-25,2027-08-15")
ap.add_argument("--out", default="")
args = ap.parse_args()

res = {}
with sync_playwright() as pw:
    b = pw.chromium.launch()
    for day in args.days.split(","):
        ctx = b.new_context(**pw.devices["Pixel 7"], locale="ru-RU", timezone_id="Europe/Moscow")
        page = ctx.new_page()
        page.clock.install(time=dt.datetime.fromisoformat(f"{day}T10:00:00+03:00"))
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(args.base, wait_until="domcontentloaded")
        page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=60000)
        page.clock.run_for(4000)
        page.wait_for_timeout(1500)
        info = page.evaluate("""() => ({
          date: new Date().toLocaleDateString('ru-RU'),
          iceZonesOn: !!state.overlays.iceZones,
          netsShown: state.R.filter((r) => /мереж/i.test(r.title || '') && passes(r)).length,
          staleHidden: state.R.filter((r) => !isCurrent(r)).length,
          bansToday: (typeof bansToday === 'function' ? bansToday() : []).map((b) => `${b.species}: ${b.dates}`.slice(0, 140)),
        })""")
        page.evaluate("showPage('today')")
        page.clock.run_for(1500)
        page.wait_for_timeout(800)
        info["today"] = page.evaluate("document.getElementById('page').innerText").replace("\n\n", "\n")[:2600]
        info["bans_card"] = page.evaluate("(document.querySelector('#page .danger-card, #page .ok-card') || {}).innerText || ''")
        page.evaluate("showPage('rules')")
        page.clock.run_for(1000)
        page.wait_for_timeout(600)
        t = page.evaluate("document.getElementById('page').innerText")
        i = t.find("Действует сегодня")
        info["rules_today"] = t[i:i + 700] if i >= 0 else t[:300]
        info["errors"] = errs
        res[day] = info
        ctx.close()
    b.close()
text = json.dumps(res, ensure_ascii=False, indent=1)
if args.out:
    open(args.out, "w", encoding="utf-8").write(text)
print(text)
