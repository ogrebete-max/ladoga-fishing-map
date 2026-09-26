#!/usr/bin/env python3
"""The angler's day, task by task, in both views: «Все функции» (the app as it is) and «Простой» (simple.js).

The owner (26.09.2026): what does a person who has just arrived need — «приехать, поставить машину, спустить
лодку, выбрать маршрут; может быть, погода и запреты» — and nothing else in front of him. A tester's run: each
task is done the shortest way the screen offers, the taps are counted, the scrolling in screens, the choices on
the way (buttons and rows in view), and the task must really be done at the end (the navigator leads to the chosen
place, the way back has started…). The start map is measured by research/raw/ux_fisher/ux_measure.js (the same
figures as in research/ux_fisher_review.md).

Tasks: T1 «Можно ли сегодня выходить?» (open water: the verdict for the boat; ice: the dangers) · T2 the bans of
today · T3 mark the car · T4 choose a good place near and go there · T5 a mark («Поклёвка») · T6 back by the track
from the spot · T7 SOS.

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/simple_tasks.py [--base URL]
Output: research/raw/simple_mode/tasks.json and shots/…; exit code 1 when a task was not done.
"""
import argparse
import datetime as dt
import json
import math
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8794/")
args = ap.parse_args()
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "research" / "raw" / "simple_mode"
SHOTS = OUT / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)
MEASURE = ROOT / "research" / "raw" / "ux_fisher" / "ux_measure.js"
SLIP = (60.1255, 32.3120)  # the launch at Новая Ладога (the Волхов mouth)
MPD = 111195.0
SEASONS = {"sep": "2026-09-26T09:00:00+03:00", "jan": "2027-01-20T09:00:00+03:00"}
# In view = on the screen, not under a sheet, not scrolled away: the choices a person has in front of him.
IN_VIEW = """(() => { const vh = innerHeight, vw = innerWidth;
  const els = [...document.querySelectorAll('button, a[href], summary, input:not([type=hidden]), select, [role=button], .leaflet-marker-icon.leaflet-interactive')];
  return els.filter((e) => { const r = e.getBoundingClientRect(); if (!r.width || !r.height || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
    for (let x = e; x && x.nodeType === 1; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; }
    const t = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), Math.min(vh - 1, Math.max(0, r.top + r.height / 2)));
    return t && (e === t || e.contains(t) || t.contains(e)); }).length; })()"""
results, fails = [], []


class Task:
    def __init__(self, page, view, season, key, name):
        self.page, self.view, self.season, self.key, self.name = page, view, season, key, name
        self.taps, self.scroll, self.choices, self.words, self.notes = 0, 0.0, [], 0, []

    def tap(self, sel, note=''):
        self.choices.append(self.page.evaluate(IN_VIEW))
        loc = self.page.locator(sel).first
        loc.scroll_into_view_if_needed()
        loc.click()
        self.taps += 1
        if note:
            self.notes.append(note)
        self.page.wait_for_timeout(700)

    def scroll_to(self, sel, box='#pageBody'):
        """Scrolling needed to bring sel into view, in screens of that box (it stays scrolled)."""
        s = self.page.evaluate("""([sel, box]) => { const e = document.querySelector(sel), b = document.querySelector(box);
          if (!e || !b) return null; const r = e.getBoundingClientRect(), br = b.getBoundingClientRect();
          const need = Math.max(0, r.bottom - br.bottom + 12); b.scrollTop += need; return need / b.clientHeight; }""", [sel, box])
        if s:
            self.scroll += s
        self.page.wait_for_timeout(300)

    def read(self, sel):
        self.words += self.page.evaluate("(sel) => { const e = document.querySelector(sel); return e ? e.innerText.split(/\\s+/).filter(Boolean).length : 0; }", sel)

    def done(self, ok, detail):
        r = {"view": self.view, "season": self.season, "task": self.key, "name": self.name, "ok": bool(ok), "taps": self.taps,
             "scroll_screens": round(self.scroll, 1), "choices_on_the_way": self.choices, "words_read": self.words,
             "detail": detail, "notes": self.notes}
        results.append(r)
        print(f"{'OK  ' if ok else 'FAIL'} [{self.view}/{self.season}] {self.name}: {self.taps} наж., прокрутка {r['scroll_screens']} экр., выбор по пути {self.choices}, {detail}")
        if not ok:
            fails.append(f"{self.view}/{self.season} {self.name}")
        self.page.screenshot(path=str(SHOTS / f"task_{self.season}_{self.view}_{self.key}.png"))


def fix(page, lat, lon, speed=0.0, heading=-1):
    page.evaluate(f"onFix({{ coords: {{ latitude: {lat}, longitude: {lon}, accuracy: 5, speed: {speed}, heading: {heading} }}, timestamp: Date.now() }}); true")


def home(page):
    page.evaluate("closeAll(); true")
    page.wait_for_timeout(500)


def run(pw, view, season):
    b = pw.chromium.launch()
    dev = {**pw.devices["iPhone 13"], "viewport": {"width": 390, "height": 664}, "device_scale_factor": 2}
    dev.pop("default_browser_type", None)
    ctx = b.new_context(**dev, locale="ru-RU", service_workers="block")
    ctx.add_init_script("Object.defineProperty(navigator, 'standalone', { value: false, configurable: true })")
    ctx.add_init_script(MEASURE.read_text(encoding="utf-8"))
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.clock.install(time=dt.datetime.fromisoformat(SEASONS[season]))
    page.goto(args.base + f"?view={view}", wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=90000)
    page.evaluate("store.set('ladoga-hint-v2', true); store.set('ladoga-ios-geo-tip', Date.now()); navigator.geolocation.watchPosition = () => 42; navigator.geolocation.getCurrentPosition = () => {}; navigator.geolocation.clearWatch = () => {}; state.settings.boat = null; saveSettings(); true")
    page.clock.run_for(2500)
    fix(page, *SLIP)
    page.evaluate(f"map.setView([{SLIP[0]}, {SLIP[1]}], 12, {{ animate: false }}); true")
    page.clock.run_for(1500)
    m = page.evaluate("cfg => window.__uxMeasure(cfg)", {"jargon": []})
    results.append({"view": view, "season": season, "task": "map", "name": "Карта на старте", "ok": True,
                    "controls_view": m["controls_view"], "markers_view": m["markers_view"], "words_view": m["words_view"],
                    "chips": page.evaluate("[...document.querySelectorAll('#statusChips [data-chip]')].map((c) => c.textContent.trim())"),
                    "go": page.evaluate("document.getElementById('btnGo').hidden ? null : document.getElementById('btnGo').textContent")})
    print(f"     [{view}/{season}] карта: {m['controls_view']} кнопок и чипов в кадре, точек {m['markers_view']}, слов {m['words_view']}")
    page.screenshot(path=str(SHOTS / f"task_{season}_{view}_map.png"))
    ice = season == "jan"

    # T1 — can one go out today
    t = Task(page, view, season, "t1", "Можно ли выходить")
    if view == "simple":
        t.read('#statusChips [data-chip="day"]')
        if not ice:
            t.tap('#statusChips [data-chip="day"]')
            t.tap('#modalBody [data-set="boat"][data-val="motor"]', 'лодка выбрана один раз')
            word = page.evaluate("document.querySelector('#modalBody .day-big')?.textContent || ''")
            chip = page.evaluate("document.querySelector('#statusChips [data-chip=day]')?.textContent || ''")
            t.done(any(w in word for w in ("Можно", "Осторожно", "не выходить")), f"«{word}»; дальше без нажатий — на карте: «{chip}»")
        else:
            chip = page.evaluate("document.querySelector('#statusChips [data-chip=day]')?.textContent || ''")
            t.done("Лёд" in chip, f"на карте без нажатий: «{chip}»")
    else:
        t.tap('#navBar [data-page="today"]')
        if not ice:
            t.scroll_to('#pageBody .boat-seg [data-val="motor"]')
            t.tap('#pageBody .boat-seg [data-val="motor"]', 'лодка выбрана один раз, в «Условиях дня»')
            page.evaluate("document.getElementById('pageBody').scrollTop = 0")
            page.wait_for_timeout(300)
            t.read('#pageBody .today-sum')
            word = page.evaluate("document.querySelector('#pageBody .today-sum')?.textContent || ''")
            t.done(any(w in word for w in ("можно", "осторожно", "нельзя")), f"«{' '.join(word.split())[:90]}»; дальше — 1 нажатие («Сегодня»)")
        else:
            t.scroll_to('#pageBody #water')
            t.read('#pageBody')
            danger = page.evaluate("document.querySelectorAll('#pageBody .wx-danger, #pageBody .v-bad').length")
            t.done(danger > 0, f"опасности льда на «Сегодня»: {danger} отметок")
    home(page)

    # T2 — the bans of today
    t = Task(page, view, season, "t2", "Запреты сегодня")
    if view == "simple":
        t.tap('#statusChips [data-chip="day"]')
        t.read('#modalBody')
        txt = page.evaluate("[...document.querySelectorAll('#modalBody .day-row')].find((r) => /Запреты/.test(r.textContent))?.textContent || ''")
    else:
        t.tap('#navBar [data-page="today"]')
        t.read('#pageBody .today-sum')
        txt = page.evaluate("document.querySelector('#pageBody .today-sum')?.textContent || ''")
    t.done("Запреты" in txt, f"«{' '.join(txt.split())[:100]}»")
    home(page)

    # T3 — mark the car
    t = Task(page, view, season, "t3", "Отметить машину")
    t.tap('#statusChips [data-chip="car-mark"]')
    car = page.evaluate("!!state.car")
    t.done(car, "машина отмечена" if car else "не отмечена")
    home(page)

    # T4 — a good place near, and go
    t = Task(page, view, season, "t4", "Выбрать место рядом и поехать")
    near = page.evaluate(f"""(() => {{ const mo = new Date().getMonth() + 1, p = {{ lat: {SLIP[0]}, lon: {SLIP[1]} }};
      return (state.ctx.season_zones || []).map((z, i) => {{ const [la, lo] = zoneAnchor(z); return {{ i, name: z.name, open: zoneSpecies(z, mo).open.length, d: distM(p, {{ lat: la, lon: lo }}) }}; }})
        .filter((x) => x.open).sort((a, b) => a.d - b.d)[0]; }})()""")
    if view == "simple":
        t.tap('#btnGo')
        t.read('#modalBody')
        t.tap(f'#modalBody [data-act="place-nav"][data-zone="{near["i"]}"]', 'ближайшее место — первое в списке')
    else:
        t.tap('#navBar [data-page="guide"]')
        t.scroll_to(f'#pageBody [data-act="place-nav"][data-zone="{near["i"]}"]')
        t.read('#pageBody')
        t.tap(f'#pageBody [data-act="place-nav"][data-zone="{near["i"]}"]', 'список «Клёв › Места» — по числу отчётов, без расстояний')
    ok = page.evaluate("nav.on && !!trk.cur") and near["name"][:20] in page.evaluate("nav.target?.title || ''")
    t.done(ok, f"ведёт к «{near['name'][:40]}» ({near['d'] / 1000:.1f} км), трек пишется: {page.evaluate('!!trk.cur')}")

    # drive there: fixes every 2 s at ~30 km/h
    tgt = page.evaluate("[nav.target.lat, nav.target.lon]")
    lat, lon = SLIP
    for _ in range(400):
        d = math.hypot((tgt[0] - lat) * MPD, (tgt[1] - lon) * MPD * math.cos(math.radians(lat)))
        if d < 12:
            break
        step = min(16.0, d - 10)
        lat += (tgt[0] - lat) * MPD / d * step / MPD
        lon += (tgt[1] - lon) * MPD * math.cos(math.radians(lat)) / d * step / (MPD * math.cos(math.radians(lat)))
        fix(page, lat, lon, 8.0, 0)
        page.clock.run_for(2000)
    page.clock.run_for(3000)

    # T5 — a mark
    t = Task(page, view, season, "t5", "Метка «Поклёвка»")
    n0 = page.evaluate("state.mine.length")
    t.tap('#navMark')
    if page.locator('#modalBody [data-tag]').count():
        t.tap('#modalBody [data-tag]', 'тип метки')
    t.done(page.evaluate("state.mine.length") > n0, f"меток: {page.evaluate('state.mine.length')}")
    home(page)

    # T6 — back by the track: the navigation to the place ended, the track goes on
    page.evaluate("if (nav.on) { ui.endingNav = true; endNav(); } true")
    page.wait_for_timeout(800)
    page.evaluate("closeAll(); true")
    page.wait_for_timeout(500)
    fix(page, lat, lon)
    page.clock.run_for(2500)
    t = Task(page, view, season, "t6", "Назад по треку с места")
    if view == "simple":
        t.tap('#btnGo', f"кнопка: «{page.evaluate('document.getElementById(\"btnGo\").textContent')}»")
    else:
        t.tap('#btnTrack', 'пилюля записи')
        t.tap('[data-act="retrace"]')
    ok = page.evaluate("nav.on && !!nav.retrace")
    t.done(ok, f"ведёт: «{page.evaluate('nav.target?.title || nav.retraceTitle || \"\"')}», назад по треку: {ok}")
    page.evaluate("if (nav.on) { ui.endingNav = true; endNav(); } closeAll(); true")
    page.wait_for_timeout(600)

    # T7 — SOS
    t = Task(page, view, season, "t7", "SOS")
    t.tap('#btnSos')
    ok = page.evaluate("topLayer()?.cls === 'sos' || /112/.test(document.getElementById('modalBody')?.textContent || '')")
    t.done(ok, "лист SOS с 112" if ok else "нет")
    home(page)
    if errs:
        fails.append(f"{view}/{season}: ошибки страницы {errs[:2]}")
        print("page errors:", errs[:3])
    b.close()


with sync_playwright() as pw:
    for season in ("sep", "jan"):
        for view in ("full", "simple"):
            run(pw, view, season)
(OUT / "tasks.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
print("RESULT:", "PASS" if not fails else f"FAIL {fails}")
sys.exit(1 if fails else 0)
