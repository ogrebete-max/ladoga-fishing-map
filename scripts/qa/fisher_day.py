#!/usr/bin/env python3
"""An angler's day on south Ladoga, the way the owner described it (26.09.2026), played on the app with a fake clock
and a fake GPS:
  1. arrives at the launch, marks the car;
  2. reads where and what: «Сегодня» (weather, what is closed today), «Клёв», a fishing point's card;
  3. picks the point and goes («Вести»): out along a winding channel in the reeds (15 m wide, a bend every 60–80 m),
     90 s not recorded in the middle of it (the phone locked), then open water to the point; the track records
     itself;
  4. fishes: drifts and circles round the point, puts two marks (поклёвка, улов);
  5. goes back: «Ещё» → «Назад по своему треку», steering only by the arrow (from where his GPS puts him), with a
     push of 25 m off the line half-way; the reeds must never be entered — the boat's true distance from the middle of
     the channel is measured all the way;
  6. at the launch: «К машине»; the track is saved.
Everything the app shows and says on the way is written down: banners, the second line of the panel, the voice.

  python -m http.server 8794 --bind 127.0.0.1 --directory site     # another terminal
  python scripts/qa/fisher_day.py [--base URL] [--shots DIR] [--device "iPhone 13"]
Exit code 1 on a failed check.
"""
import argparse
import datetime as dt
import json
import math
import os
import random
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8794/")
ap.add_argument("--shots", default="research/raw/qa/fisher_day")
ap.add_argument("--device", default="iPhone 13")
ap.add_argument("--seed", type=int, default=5)
args = ap.parse_args()
os.makedirs(args.shots, exist_ok=True)
rnd = random.Random(args.seed)

R = 6371008.8
MPD = R * math.pi / 180
LAUNCH = (60.1265, 32.3035)  # the Волхов mouth at Новая Ладога: the way out goes north into the Волховская губа
K = math.cos(math.radians(LAUNCH[0]))


def ll(x, y):
    return (LAUNCH[0] + y / MPD, LAUNCH[1] + x / (MPD * K))


def xy(lat, lon):
    return ((lon - LAUNCH[1]) * MPD * K, (lat - LAUNCH[0]) * MPD)


def seg_dist(p, a, b):
    vx, vy = b[0] - a[0], b[1] - a[1]
    l2 = vx * vx + vy * vy
    t = max(0, min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) if l2 else 0
    return math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy))


def to_line(p, line):
    return min(seg_dist(p, line[i], line[i + 1]) for i in range(len(line) - 1))


class Noise:
    """Phone GPS: a slow wander (σ 3 m, ~20 s memory) plus a little jitter."""
    def __init__(self, sigma=3.0, rho=0.95, jitter=0.7):
        self.s, self.rho, self.j = sigma * math.sqrt(1 - rho * rho), rho, jitter
        self.nx, self.ny = rnd.gauss(0, sigma), rnd.gauss(0, sigma)

    def __call__(self):
        self.nx = self.rho * self.nx + self.s * rnd.gauss(0, 1)
        self.ny = self.rho * self.ny + self.s * rnd.gauss(0, 1)
        return self.nx + rnd.gauss(0, self.j), self.ny + rnd.gauss(0, self.j)


# The channel: north-north-east from the launch, ~2 km of bends.
CHANNEL = [(0.0, 0.0)]
x, y, h = 0.0, 0.0, 15.0
for b in [55, -60, 70, -45, 80, -75, 35, -50, 65, -70, 40, -55, 75, -60, 50, -40, 60, -65, 45, -35, 30, -55, 70, -40, 55, -50]:
    for _ in range(int((60 + rnd.random() * 20) / 4)):
        x += 4 * math.sin(math.radians(h)); y += 4 * math.cos(math.radians(h)); CHANNEL.append((x, y))
    for _ in range(3):
        h += b / 3
        x += 4 * math.sin(math.radians(h)); y += 4 * math.cos(math.radians(h)); CHANNEL.append((x, y))
# keep the channel heading generally north
checks, notes = [], {}


def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": detail})
    print(f"{'OK  ' if ok else 'FAIL'} {name}: {detail}", flush=True)


SNAP = """() => {
  const b = document.getElementById('navBanner'), l2 = document.getElementById('ntLine2');
  const r = nav.retrace;
  return { banner: b && !b.hidden ? b.innerText.replace(/\\s+/g, ' ').trim() : '', line2: l2 ? l2.textContent : '',
    dist: (document.getElementById('ntDist') || {}).textContent || '', arrived: !!nav.arrived, on: !!nav.on,
    aim: r && r.aim ? [r.aim.lat, r.aim.lon] : null, off: r && r.loc ? r.loc.d : null, left: r ? r.left : null,
    rec: trk.cur ? trk.cur.state : null, title: nav.target ? nav.target.title : '' };
}"""

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    # the phone's screen at 1 pixel per point: the software renderer of a test browser draws the rotating map 9 times
    # faster than at the iPhone's ×3, and nothing checked here depends on the pixel density
    dev = {**pw.devices[args.device], "device_scale_factor": 1}
    ctx = browser.new_context(**dev, locale="ru-RU", timezone_id="Europe/Moscow", service_workers="block")
    ctx.add_init_script("Object.defineProperty(navigator, 'standalone', { value: false, configurable: true })")
    # what the app says: every phrase, with the voice and the speed
    ctx.add_init_script("""window.__said = []; try {
      const sp = speechSynthesis.speak.bind(speechSynthesis);
      speechSynthesis.speak = (u) => { window.__said.push({ t: Date.now(), text: u.text, voice: u.voice ? u.voice.name : '', rate: u.rate }); try { sp(u); } catch (e) {} };
    } catch (e) {}""")
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:240]))
    page.clock.install(time=dt.datetime.fromisoformat("2026-09-27T06:40:00+03:00"))
    page.goto(args.base, wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function('typeof state !== "undefined" && state.M && state.M.length > 0', timeout=90000)
    page.evaluate("store.set('ladoga-hint-v2', true); store.set('ladoga-ios-geo-tip', Date.now()); updateHint()")
    page.evaluate("navigator.geolocation.watchPosition = () => 42; navigator.geolocation.getCurrentPosition = () => {}; navigator.geolocation.clearWatch = () => {};")
    # the phone locked and unlocked: the page hidden and shown again, as the browser does it
    page.evaluate("""window.__vis = 'visible';
      Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true });
      Object.defineProperty(document, 'hidden', { get: () => window.__vis === 'hidden', configurable: true });""")
    page.clock.run_for(3000)

    def shot(name):
        page.screenshot(path=os.path.join(args.shots, f"{name}.png"))

    t_eval = []

    slow = []

    def fix(px, py, speed, heading, acc=5.0):
        lat, lon = ll(px, py)
        t0 = time.perf_counter()
        s = page.evaluate("([f, snap]) => { f.timestamp = Date.now(); onFix(f); return (new Function('return ' + snap))()(); }",
                          [{"coords": {"latitude": lat, "longitude": lon, "accuracy": acc, "speed": speed, "heading": heading}}, SNAP])
        t1 = time.perf_counter()
        t_eval.append(t1 - t0)
        page.clock.run_for(1000)
        t2 = time.perf_counter()
        if t2 - t0 > 2:
            slow.append(round(t2 - t0, 1))
            print(f"  slow step: fix {t1 - t0:.1f} s, clock {t2 - t1:.1f} s", flush=True)
        return s

    # ---- 1. at the launch: GPS on (◎), the car
    page.click("#btnLocate")
    noise = Noise()
    for _ in range(4):
        e = noise(); fix(e[0], e[1], 0, -1)
    chip = page.locator('[data-chip="car-mark"]')
    check("у слипа видна кнопка «Отметить машину»", chip.count() == 1 and chip.is_visible(), chip.inner_text() if chip.count() else "нет")
    if chip.count():
        chip.click(); page.clock.run_for(800)
    car = page.evaluate("state.car")
    check("машина отмечена одним нажатием", bool(car) and math.hypot(*xy(car["lat"], car["lon"])) < 15, json.dumps(car))
    shot("01_launch")

    # ---- 2. reading: «Сегодня», «Клёв», a point near the way
    page.evaluate("showPage('today')"); page.clock.run_for(1500)
    for _ in range(20):  # the forecast comes from the network: up to 20 s
        today = page.evaluate("document.getElementById('page').innerText")
        if "м/с" in today:
            break
        page.clock.run_for(1000); page.wait_for_timeout(300)
    # the test browser may have no internet: then the forecast must say so plainly, not break the page
    wx_ok = "м/с" in today or "Загружаю прогноз" in today or "когда появится интернет" in today
    check("«Сегодня»: погода (или честное «загружаю») и что запрещено сегодня", wx_ok and ("запрет" in today.lower()),
          f"{len(today)} символов, прогноз: {'есть' if 'м/с' in today else 'нет сети'}")
    shot("02_today")
    page.evaluate("showPage('guide')"); page.clock.run_for(1200)
    guide = page.evaluate("document.getElementById('page').innerText")
    check("«Клёв»/справочник открывается", len(guide) > 300, f"{len(guide)} символов")
    page.evaluate("closeAll()"); page.clock.run_for(600)
    # the fishing point: the nearest real one 2,5–5 km north of the launch
    pick = page.evaluate("""([lat0, lon0]) => {
      let best = null;
      state.M.forEach((m, i) => {
        if (m.kind === 'hazard' || m.kind === 'structure' || m.kind === 'service') return;
        const d = distM({ lat: lat0, lon: lon0 }, m), b = bearing({ lat: lat0, lon: lon0 }, m);
        if (d < 2800 || d > 5000 || !(b > 330 || b < 40)) return;
        if (!best || d < best.d) best = { i, d, lat: m.lat, lon: m.lon };
      });
      return best;
    }""", list(LAUNCH))
    check("нашлась точка ловли в 2,5–5 км к северу", bool(pick), json.dumps(pick))
    if not pick:
        print(json.dumps({"errors": errs}, ensure_ascii=False)); sys.exit(1)
    page.evaluate(f"openPoint({pick['i']})"); page.clock.run_for(1200)
    card = page.evaluate("(document.getElementById('card') || {}).innerText || ''")
    shot("03_point_card")
    go = page.locator('#card [data-act="nav"], #card button:has-text("Вести")').first
    check("в карточке точки есть «Вести»", go.count() == 1, card[:120].replace("\n", " · "))

    # the way out: the channel, then open water straight to the point
    SPOT = xy(pick["lat"], pick["lon"])
    ch_end = CHANNEL[-1]
    OPEN = []
    dx, dy = SPOT[0] - ch_end[0], SPOT[1] - ch_end[1]
    L = math.hypot(dx, dy)
    s = 4.0
    while s < L:
        OPEN.append((ch_end[0] + dx * s / L, ch_end[1] + dy * s / L)); s += 4.0
    OPEN.append(SPOT)
    WAY = CHANNEL + OPEN
    def resample(line, step, speed):
        """A place every `step` metres along the line, whatever its own spacing."""
        out, carry = [], 0.0
        for i in range(1, len(line)):
            a, b = line[i - 1], line[i]
            l = math.hypot(b[0] - a[0], b[1] - a[1])
            s = carry
            while s < l:
                out.append((a[0] + (b[0] - a[0]) * s / l, a[1] + (b[1] - a[1]) * s / l, speed))
                s += step
            carry = s - l
        return out
    # a fix a second: 18 km/h along the channel, 36 km/h over open water
    way = resample(CHANNEL, 5, 5.0) + resample([CHANNEL[-1]] + OPEN, 10, 10.0) + [(SPOT[0], SPOT[1], 0.5)]
    notes["way_out_m"] = round(sum(math.hypot(WAY[i][0] - WAY[i - 1][0], WAY[i][1] - WAY[i - 1][1]) for i in range(1, len(WAY))))

    # ---- 3. «Вести»
    go.click(); page.clock.run_for(1500)
    st = page.evaluate("({ on: nav.on, rec: trk.cur ? trk.cur.state : null, auto: trk.cur ? !!trk.cur.auto : null, voiceBtn: !document.getElementById('ntVoice').hidden, voiceOn: document.getElementById('ntVoice').classList.contains('on') })")
    check("«Вести»: навигация и трек пишется сам", st["on"] and st["rec"] == "rec" and st["auto"], json.dumps(st))
    check("в навигации видна кнопка голоса, включена", st["voiceBtn"] and st["voiceOn"], json.dumps(st))
    shot("04_nav_start")
    banners_out, sleep_from = {}, int(len(way) * 0.3)
    ch_noise = {"shoal": 0, "course": 0, "steps": 0}  # what the navigator said inside the channel on the way out
    sleep_to = sleep_from + 40  # 40 s locked in the channel: 200 m not recorded
    prev = way[0]
    print(f"out: {len(way)} steps", flush=True)
    for i, p in enumerate(way):
        if i % 200 == 0:
            print(f"  out {i}", flush=True)
        if i == sleep_from:
            page.evaluate("window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))")
        if sleep_from <= i < sleep_to:  # the phone locked: the page asleep, no fixes
            page.clock.run_for(1000); continue
        if i == sleep_to:
            page.evaluate("window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange'))")
        e = noise()
        hdg = (math.degrees(math.atan2(p[0] - prev[0], p[1] - prev[1])) + 360) % 360
        snap = fix(p[0] + e[0], p[1] + e[1], p[2], hdg)
        prev = p
        if snap["banner"]:
            banners_out[snap["banner"][:60]] = banners_out.get(snap["banner"][:60], 0) + 1
        if to_line((p[0], p[1]), CHANNEL) < 1 and not (sleep_from - 5 <= i < sleep_to + 15):
            ch_noise["steps"] += 1
            if "Мелко" in snap["banner"]:
                ch_noise["shoal"] += 1
            if "Поверните" in snap["banner"]:
                ch_noise["course"] += 1
        if i == len(way) // 5:
            shot("05_nav_channel")
    SLEEP_A, SLEEP_B = way[sleep_from], way[min(sleep_to, len(way) - 1)]
    notes["channel_out"] = ch_noise
    check("в протоке туда не пугает мелью (≤ 12 с, пока не понял, что это протока)", ch_noise["shoal"] <= 12, json.dumps(ch_noise))
    check("в протоке туда не командует «Поверните…»", ch_noise["course"] <= 12, json.dumps(ch_noise))
    for _ in range(6):
        e = noise(); snap = fix(SPOT[0] + e[0], SPOT[1] + e[1], 0.2, -1)
    check("дошёл до точки", snap["arrived"], snap["banner"])
    notes["banners_out"] = banners_out
    shot("06_arrived")
    n_pts = page.evaluate("trk.cur.segs.reduce((a, s) => a + s.length, 0)")
    n_segs = page.evaluate("trk.cur.segs.length")
    check("трек записан подробно (≥ 1 точка на 12 м)", n_pts >= notes["way_out_m"] / 12, f"{n_pts} точек на {notes['way_out_m']} м, кусков {n_segs}")

    # ---- 4. fishing: 12 minutes of drift round the spot, two marks
    d = list(SPOT)
    for k in range(360):
        d[0] += rnd.gauss(0, 0.6); d[1] += rnd.gauss(0, 0.6)
        if math.hypot(d[0] - SPOT[0], d[1] - SPOT[1]) > 40:
            d[0] = SPOT[0] + (d[0] - SPOT[0]) * 0.9; d[1] = SPOT[1] + (d[1] - SPOT[1]) * 0.9
        e = noise()
        if k % 2 == 0:
            fix(d[0] + e[0], d[1] + e[1], 0.3, -1)
        else:
            page.clock.run_for(1000)
        if k in (100, 250):
            page.click("#navMark"); page.clock.run_for(600)
            page.click('#modalBody [data-tag="bite"]' if k == 100 else '#modalBody [data-tag="catch"]'); page.clock.run_for(600)
    marks = page.evaluate("trackMarks(trk.cur).map((p) => p.tag)")
    check("две метки на треке (поклёвка, улов)", sorted(marks) == ["bite", "catch"], json.dumps(marks))
    shot("07_fishing")

    # ---- 5. back by the track
    page.click("#navMore"); page.clock.run_for(800)
    row = page.locator('#modalBody [data-act="retrace"]')
    check("в «Ещё» есть «Назад по своему треку»", row.count() == 1)
    row.first.click(); page.clock.run_for(1500)
    rt = page.evaluate("nav.retrace ? { len: nav.retrace.path.len, gap: nav.retrace.path.gapLen, n: nav.retrace.path.pts.length, title: nav.target.title } : null")
    check("возврат по треку начался", bool(rt), json.dumps(rt))
    check("петли рыбалки вырезаны: путь ≈ пути туда", rt and rt["len"] < notes["way_out_m"] * 1.15 + 60, f"{round(rt['len']) if rt else '—'} м при {notes['way_out_m']} м туда")
    check("провал записи в протоке виден", rt and rt["gap"] > 50, f"не записано {round(rt['gap']) if rt else 0} м")
    shot("08_back_start")
    boat = list(xy(*page.evaluate("[geo.me.lat, geo.me.lon]")))
    true_off, banners_back, line2s, pushed, reached = [], {}, set(), None, False
    back_noise = Noise()
    steps, spd_b = 0, 5.0
    first_turn_shot = off_shot = gap_shot = False
    print("back", flush=True)
    while steps < 2400:
        steps += 1
        if steps % 100 == 0:
            print(f"  back {steps}", flush=True)
        e = back_noise()
        seen = (boat[0] + e[0], boat[1] + e[1])
        snap = fix(seen[0], seen[1], spd_b, 0 if steps == 1 else hdg_b)
        if snap["banner"]:
            key = snap["banner"][:70]
            banners_back[key] = banners_back.get(key, 0) + 1
            if "трека на" in key and not off_shot:
                shot("10_back_off_track"); off_shot = True
            if "не записан" in key and not gap_shot:
                shot("11_back_gap"); gap_shot = True
        if "через" in snap["line2"] and ("налево" in snap["line2"] or "направо" in snap["line2"]):
            line2s.add(snap["line2"].split(" · ")[1] if " · " in snap["line2"] else snap["line2"])
            if not first_turn_shot:
                shot("09_back_turn"); first_turn_shot = True
        if snap["arrived"] or not snap["on"]:
            reached = True
            break
        aim = xy(*snap["aim"]) if snap["aim"] else xy(*page.evaluate("[nav.target.lat, nav.target.lon]"))
        # the helmsman: from where his GPS puts him, towards the spot the arrow shows, 5 m a second
        vx, vy = aim[0] - seen[0], aim[1] - seen[1]
        vl = math.hypot(vx, vy) or 1
        hdg_b = (math.degrees(math.atan2(vx, vy)) + 360) % 360
        spd = 5.0 if to_line(boat, CHANNEL) <= to_line(boat, OPEN) else 10.0
        step = (vx / vl * spd, vy / vl * spd)
        # a push off the line half-way along the channel: 25 m sideways over 10 s
        if pushed is None and to_line(boat, CHANNEL) < 8 and math.hypot(boat[0], boat[1]) < 1200 and steps > 60:
            pushed = steps
        if pushed is not None and pushed <= steps < pushed + 10:
            step = (step[0] * 0.3 + (-vy / vl) * 2.5, step[1] * 0.3 + (vx / vl) * 2.5)
        boat = [boat[0] + step[0], boat[1] + step[1]]
        spd_b = spd
        in_channel = to_line(boat, CHANNEL) <= to_line(boat, OPEN)
        # the stretch not recorded goes straight across the bends — told by the app, left out of the measure
        near_gap = math.hypot(boat[0] - SLEEP_A[0], boat[1] - SLEEP_A[1]) < 110 or math.hypot(boat[0] - SLEEP_B[0], boat[1] - SLEEP_B[1]) < 110
        if in_channel and not near_gap and not (pushed is not None and pushed <= steps < pushed + 25):
            true_off.append(to_line(boat, CHANNEL))
    shot("12_back_end")
    true_off.sort()
    p95 = true_off[int(len(true_off) * 0.95)] if true_off else 99
    notes["banners_back"] = banners_back
    notes["turns_on_screen"] = sorted(line2s)[:12]
    check("по стрелке дошёл до начала трека", reached, f"{steps} с, осталось {page.evaluate('nav.retrace ? Math.round(nav.retrace.left) : 0')} м")
    check("в протоке держался русла (95 % ≤ 10 м от середины, это с ошибкой GPS)", p95 <= 10, f"95 % ≤ {p95:.1f} м, макс. {true_off[-1] if true_off else 0:.1f} м")
    check("сдвиг с трека показан («Вы … трека на … м — возьмите …»)", any("трека на" in k for k in banners_back), "; ".join(k for k in banners_back if "трека" in k)[:160])
    check("повороты протоки показаны заранее", len(line2s) >= 5, "; ".join(sorted(line2s)[:6]))
    check("на обратном пути по треку нет ложных «Мелко впереди»", not any("Мелко" in k for k in banners_back), "; ".join(k for k in banners_back if "Мелко" in k)[:160])

    # ---- 6. to the car, the track saved
    said = page.evaluate("window.__said")
    back_said = [s["text"] for s in said]
    notes["voice"] = back_said[-40:]
    check("голосом: поворот заранее", any(s.startswith("Через") and ("налево" in s or "направо" in s) for s in back_said), "")
    check("голосом: сошли с трека и «Снова на треке»", any("трека на" in s for s in back_said) and any("Снова на треке" in s for s in back_said), "")
    check("голосом: предупреждение о незаписанном куске", any("не записан" in s for s in back_said), "")
    page.click("#navEnd"); page.clock.run_for(600)
    page.locator('#modalFoot [data-act="nav-end"], [data-act="nav-end"]').first.click(); page.clock.run_for(800)
    chip = page.locator('[data-chip="car"]')
    dcar = page.evaluate("state.car && geo.me ? Math.round(distM(geo.me, state.car)) : null")
    check("у слипа: машина рядом (кнопка «К машине» не нужна)", dcar is not None and dcar < 150, f"{dcar} м до машины")
    page.click("#btnTrack"); page.clock.run_for(600)
    page.locator('[data-act="rec-stop"]').first.click(); page.clock.run_for(600)
    page.locator('[data-act="track-save"]').first.click(); page.clock.run_for(1200)
    saved = page.evaluate("trk.list.filter((t) => t.state === 'done').map((t) => ({ name: t.name, pts: t.segs.reduce((a, s) => a + s.length, 0), marks: trackMarks(t).length }))")
    check("трек сохранён с метками", saved and saved[0]["marks"] == 2, json.dumps(saved, ensure_ascii=False)[:200])
    shot("13_saved")
    t_eval.sort()
    notes["fix_ms_p95"] = round(t_eval[int(len(t_eval) * 0.95)] * 1000)
    check("телефон успевает (обработка точки GPS, 95 % ≤ 250 мс в тесте)", notes["fix_ms_p95"] <= 250, f"{notes['fix_ms_p95']} мс")
    check("без ошибок на странице", not errs, "; ".join(errs[:3]))
    browser.close()

print(json.dumps(notes, ensure_ascii=False, indent=1))
bad = [c for c in checks if not c["ok"]]
print(f"\n{'ALL OK' if not bad else 'FAILED: ' + str(len(bad))}")
sys.exit(1 if bad else 0)
