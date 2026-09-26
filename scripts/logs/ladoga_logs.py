#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Work log receiver of the owner's apps on this VPS: «Ладога · рыболовная карта» (site/log.js) and, the same way,
«СПб Топливо» or any other app — what was pressed, how GPS and the navigator behaved, errors, and the problem
reports people send. The owner (25.09.2026): «кто что нажимает, кто чем пользуется, кто чем не пользуется, у кого
что получается» — hence the stats page as well.

Runs behind Caddy (routes /ladoga/api/* and /applog/*), as the unprivileged user of the collectors, and writes
only to its state directory, one folder per app:

  <dir>/<app>/YYYY-MM-DD.jsonl          one line per batch: server time + the batch (no IP address is stored)
  <dir>/<app>/reports/<stamp>-<id>.json one file per «Сообщить о проблеме»
  <dir>/<app>/reports.jsonl             one line per report (a quick look)
  <dir>/stats.key                       the secret of the stats page (made on the first start)

  POST /ladoga/api/log | /ladoga/api/report          → app «ladoga»
  POST /applog/<app>/log | /applog/<app>/report      → any app (a-z, 0-9, «-»)
  GET  /ladoga/api/stats?key=…&days=7 | /applog/stats?key=…   → the page «Кто чем пользуется» (Russian)
  GET  …/health                                      → ok

Files older than KEEP_DAYS are deleted. Python 3.8+ standard library only.

    ladoga_logs.py --dir /var/lib/ladoga-logs [--port 8791]
"""
import argparse
import collections
import html
import json
import os
import re
import secrets
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

KEEP_DAYS = 60
MAX_LOG_BYTES = 512 * 1024
MAX_REPORT_BYTES = 1024 * 1024
MAX_EVENTS = 600
RATE_PER_MIN = 60
ID_RE = re.compile(r"^[a-z0-9]{4,40}$")
APP_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,19}$")
MSK = timezone(timedelta(hours=3))
_lock = threading.Lock()
_hits = {}

APP_NAMES = {"ladoga": "Ладога · рыболовная карта", "fuel": "СПб Топливо"}
# What a tap's «what» means, for the page (site/log.js records data-act / data-page / id of the element).
LABELS = {
    "today": "раздел «Сегодня»", "map": "раздел «Карта»", "guide": "раздел «Справочник»", "me": "раздел «Я»", "rules": "правила",
    "btnLocate": "«Где я»", "btnLayers": "слои и фильтр", "btnSos": "SOS", "btnTrack": "трек (кнопка на карте)", "btnHome": "мой район",
    "btnDark": "тёмный экран", "btnCompass": "компас / ориентация", "zoomIn": "приблизить", "zoomOut": "отдалить", "zoomAuto": "автомасштаб",
    "recenter": "«Ко мне» в навигации", "navEnd": "завершить навигацию", "navTrack": "трек в навигации", "navMark": "метка в навигации",
    "navMore": "меню навигации", "nav": "«Вести» к точке", "marker": "точка на карте", "fav": "сохранить точку", "share": "поделиться",
    "point-more": "«Ещё» у точки", "saver": "тёмный экран (из меню)", "guard-on": "сторож места", "mob": "человек за бортом",
    "report-problem": "«Сообщить о проблеме»", "report-send": "отправил сообщение о проблеме", "nav-layers": "карта в навигации",
    "base-set": "смена подложки", "preset": "быстрые слои", "filter-fish": "рыба на карте", "month-filter": "отчёты за месяц",
    "depth-help": "глубины и эхолот", "install": "установить приложение", "locate-retry": "повтор геопозиции", "demo": "демо навигатора",
    "car-go": "к машине", "retrace": "назад по треку", "icez-show": "опасный лёд", "zone-open": "район", "sat-prev": "снимок дня",
    "zoomRoute": "«Путь» в навигации", "mbClose": "закрыть показ «По месяцам»", "mbPlay": "«По месяцам»: пуск / пауза",
    "mbPrev": "«По месяцам»: назад", "mbNext": "«По месяцам»: вперёд", "filters-reset": "сбросить фильтр", "modalClose": "закрыть окно",
    "wx-refresh": "обновить погоду", "filterBtn": "фильтр",
}
# Buttons named by what they choose (site/log.js TAP_KEYS): «wxplace:kobona» → «погода: Кобона».
TAP_KINDS = {"wxplace": "погода", "chip": "чип", "preset": "быстрые слои", "set": "настройка", "cond": "условия дня", "tseason": "снасти: сезон",
             "tfish": "снасти: рыба", "sheetTab": "вкладка", "pointsFilter": "мои точки", "pageLink": "переход", "notice": "подсказка",
             "month": "месяц", "smonth": "месяц сезона", "season": "сезон", "tag": "отметка", "pack": "скачать район", "theme": "тема",
             "size": "размер", "iceKind": "лёд", "openMarker": "точка из списка", "zone": "район"}
WX_PLACE_NAMES = {"here": "Здесь", "volkhov": "Волховская губа", "kobona": "Кобона", "shlis": "Шлиссельбург", "svir": "Свирская губа"}
FEATURES = ["today", "map", "guide", "rules", "me", "btnLocate", "nav", "btnTrack", "btnLayers", "base-set", "marker", "fav", "share",
            "btnDark", "guard-on", "mob", "btnSos", "report-problem", "car-go", "retrace", "demo", "install", "depth-help", "icez-show"]
# The navigator's and the track's own events, as the page names them.
LADOGA_EVENTS = {"geo_start": "включали геопозицию", "nav_start": "начинали навигацию", "nav_arrived": "дошли до точки",
                 "map_free": "сдвигали карту в навигации", "recenter": "возврат к лодке", "shoal_ahead": "мель впереди",
                 "voice": "голосовых подсказок", "saver_on": "тёмный экран", "guard_on": "сторож места", "guard_alarm": "тревог сторожа",
                 "mob": "человек за бортом", "gap": "перерывов в треке (телефон заблокирован)", "report_sent": "сообщений о проблемах"}

# «СПб Топливо» (spb-fuel-intelligence, web/log.js): its taps are the button's data-drive (`drive-…`, the navigator),
# data-screen (`screen-…`, the bottom bar), another data-attribute, or the id.
FUEL_LABELS = {
    "screen-drive": "«Навигатор» (внизу)", "screen-map": "«Карта» (внизу)", "screen-list": "«Список» (внизу)", "club-tab": "«Клуб» (внизу)",
    "locateButton": "«Рядом со мной»", "mapLocate": "«⌖» на карте", "driveButton": "«За рулём» на карте", "driveListButton": "«За рулём» в списке",
    "aboutButton": "«i» — о данных и настройки", "clubButton": "«Клуб» в шапке", "installButton": "«Установить»", "sourcesButton": "«Источники и методика»",
    "nearbySearchButton": "«Проверить по адресу»", "mapAreaButton": "«Искать в этой области»", "refreshButton": "«Обновить данные»",
    "grade": "марка в списке", "map-grade": "марка на карте", "area": "СПб / область", "status": "фильтр по статусу", "timeline": "«появилось»",
    "card-main": "карточка АЗС", "map-pin": "метка на карте", "popup-open": "«Открыть и отметить» на карте", "drawerClose": "закрыть окно",
    "mark-seen": "«есть / нет» на карточке", "compose-grade": "марка в отметке", "compose-queue": "очередь в отметке", "quick-grade": "быстрая марка у колонки",
    "verdict": "👍 / 👎 чужой отметке", "thanks-station": "«Спасибо» за отметку", "delete-station": "удалить отметку", "own": "«👁 Свои»",
    "own-open": "«Свои» за сутки", "own-station": "АЗС в «Свои»", "push": "уведомления вкл/выкл", "scout-station": "АЗС из подсказки",
    "passed-station": "проехал АЗС — отметить", "nearby-station": "АЗС рядом", "feed-station": "отметка в «Свои сообщают»",
    "drive-close": "«🗺» из навигатора", "drive-recenter": "«⌖» вернуть карту к машине", "drive-route-toggle": "линия маршрута",
    "drive-theme": "«◐» настройки навигатора", "drive-grades": "«Моя марка»", "drive-grade": "выбор марки в навигаторе", "drive-own": "«👁 Свои» в навигаторе",
    "drive-mark": "отметка из навигатора", "drive-pick": "марка у колонки", "drive-send-look": "«Отправить» у колонки", "drive-queue": "очередь у колонки",
    "drive-answer": "ответ на вопрос на остановке", "drive-skip": "«не видел» на остановке", "drive-vote": "👍 / 👎 у колонки",
    "drive-route": "«Маршрут в Яндексе»", "drive-yandex": "«В Яндексе»", "drive-card": "карточка из навигатора", "drive-target": "«Дальше»: другая АЗС",
    "drive-passenger": "«я пассажир»", "drive-start-mode": "первый экран", "drive-theme-mode": "тема экрана", "drive-location-help": "«Что делать» с местом",
    "drive-pin": "метка в навигаторе", "drive-problem": "«Сообщить о проблеме» из навигатора", "driveOfferYes": "«Включить» навигатор на ходу",
    "driveOfferNo": "«Не сейчас» навигатору", "problemOpen": "«Сообщить о проблеме»", "problemSend": "отправил сообщение о проблеме",
    "locationProblem": "«Не помогло — сообщить»", "workLogSend": "журнал работы вкл/выкл", "analyticsToggle": "статистика вкл/выкл",
    "locationYes": "«Да, точка на месте»", "locationNo": "«Нет, не там»", "locationRecheck": "«Проверить место ещё раз»",
    "locationByAddress": "«Искать АЗС по адресу»", "locationRetry": "«Попробовать ещё раз» (место)", "openInSafari": "«Открыть в Safari»",
    "routeLink": "маршрут из карточки", "yandexLink": "Яндекс из карточки", "trafficLink": "пробки из карточки", "copyCoords": "скопировать координаты",
    "code-share": "поделиться кодом клуба", "invite-share": "отправить приглашение", "toast": "всплывающее сообщение",
    "drive-pick-close": "«Готово» в настройках навигатора", "drive-untap": "назад к своей АЗС в навигаторе", "drive-list": "список из навигатора",
    "problemWithLog": "журнал к сообщению вкл/выкл", "copyLink": "скопировать ссылку", "locationCopyLink": "скопировать ссылку (место)",
    "collectorDetails": "«Подробнее» об источниках", "own-back": "назад из «Свои»", "own-more": "ещё АЗС в «Свои»",
    "return-yes": "подтвердил возврат в клуб", "return-no": "отклонил возврат в клуб", "invite-revoke": "отозвать приглашение",
    "login-code": "код входа участнику", "remove": "удалить из клуба", "award": "благодарность клуба", "grant": "добавить приглашения",
    "ban": "исключить из клуба", "unban": "вернуть в клуб", "leaflet-popup-close-button": "закрыть подсказку на карте",
}
FUEL_FEATURES = ["screen-drive", "screen-map", "screen-list", "locateButton", "card-main", "map-pin", "mark-seen", "compose-grade",
                 "drive-mark", "drive-send-look", "drive-answer", "verdict", "thanks-station", "own", "drive-own", "drive-route",
                 "drive-yandex", "drive-target", "drive-grades", "nearbySearchButton", "status", "push", "installButton", "club-tab",
                 "problemOpen", "drive-problem"]
FUEL_EVENTS = {"nav_start": "открывали навигатор", "drive_offer": "навигатор предложен на ходу", "map_free": "сдвигали карту в навигаторе",
               "recenter": "возвращали карту к машине", "mark_sent": "отметок ушло", "mark_queued": "отметок ждали связи",
               "mark_refused": "отметок не принято", "mark_expired": "отметок так и не ушло", "geo_error": "сбоев геопозиции",
               "gps_odd": "странностей GPS (грубое место, пропуски)", "report_sent": "сообщений о проблемах",
               "reload": "перезагрузок на новую версию", "boot_failed": "приложение не загрузилось", "stalled": "«Приложение не загрузилось» на экране",
               "load_error": "не догрузился файл приложения"}
# Per app: the names of its taps, what it offers (for «Чем не пользуются») and its own events.
APP_LABELS = {"ladoga": LABELS, "fuel": FUEL_LABELS}
APP_FEATURES = {"ladoga": FEATURES, "fuel": FUEL_FEATURES}
APP_EVENTS = {"ladoga": ("Навигатор и трек", LADOGA_EVENTS), "fuel": ("Навигатор, GPS и отметки", FUEL_EVENTS)}
COUNTED = set(LADOGA_EVENTS) | set(FUEL_EVENTS) | {"fresh_merged"}
# СПб Топливо is published on GitHub Pages, not on this server: its phones send from that origin (text/plain, so no
# preflight), and this lets the app read the answer and so know a batch arrived. The stats page never gets it.
CORS_ORIGINS = ("https://ogrebete-max.github.io",)


def utcnow():
    return datetime.now(timezone.utc)


def clean_events(events):
    out = []
    for ev in events[:MAX_EVENTS]:
        if not isinstance(ev, dict) or not isinstance(ev.get("e"), str) or not isinstance(ev.get("t"), (int, float)):
            continue
        item = {}
        for k, v in list(ev.items())[:24]:
            if not isinstance(k, str) or len(k) > 24:
                continue
            if isinstance(v, str):
                item[k] = v[:400]
            elif isinstance(v, (int, float, bool)) or v is None:
                item[k] = v
        out.append(item)
    return out


def clean_batch(obj):
    if not isinstance(obj, dict) or obj.get("v") != 1 or not isinstance(obj.get("events"), list):
        return None
    iid, sid = str(obj.get("iid") or ""), str(obj.get("sid") or "")
    if not ID_RE.match(iid) or (sid and not ID_RE.match(sid)):
        return None
    return {"iid": iid, "sid": sid, "app": str(obj.get("app") or "")[:12], "ua": str(obj.get("ua") or "")[:200],
            "who": re.sub(r"[\x00-\x1f<>]", "", str(obj.get("who") or ""))[:40],
            "sent": obj.get("sent") if isinstance(obj.get("sent"), (int, float)) else None,
            "events": clean_events(obj["events"])}


def rate_ok(key):
    now = time.time()
    with _lock:
        hits = [t for t in _hits.get(key, []) if now - t < 60]
        if len(hits) >= RATE_PER_MIN:
            _hits[key] = hits
            return False
        hits.append(now)
        _hits[key] = hits
        if len(_hits) > 5000:
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > 60]:
                _hits.pop(k, None)
    return True


def append_line(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _lock, open(path, "a", encoding="utf-8") as fh:
        fh.write(line)


def prune(root):
    limit = time.time() - KEEP_DAYS * 86400
    for base, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            if name.endswith((".jsonl", ".json")) and name not in ("reports.jsonl", "stats.key") and os.path.getmtime(path) < limit:
                try:
                    os.remove(path)
                except OSError:
                    pass


def route(path):
    """(app, action) of a request path, or (None, None)."""
    parts = [p for p in path.split("?")[0].split("/") if p]
    if len(parts) >= 3 and parts[0] == "ladoga" and parts[1] == "api":
        return "ladoga", parts[2]
    if len(parts) >= 2 and parts[0] == "applog":
        if len(parts) == 2 and parts[1] in ("stats", "health"):
            return None, parts[1]
        if len(parts) >= 3 and APP_RE.match(parts[1]):
            return parts[1], parts[2]
    return None, None


# ---------- the page «Кто чем пользуется» ----------
def device_of(ua):
    ua = ua or ""
    if re.search(r"iPhone|iPad|iPod", ua):
        return "iPhone" if "iPhone" in ua else "iPad"
    if "Android" in ua:
        m = re.search(r"Android [\d.]+; ([^;)]+)", ua)
        return f"Android{(' · ' + m.group(1).strip()) if m else ''}"
    if "Windows" in ua:
        return "Windows"
    if "Mac OS" in ua:
        return "Mac"
    return "другое"


def read_app(root, app, days):
    since = (utcnow() - timedelta(days=days)).date()
    batches = []
    base = os.path.join(root, app)
    if not os.path.isdir(base):
        return batches, []
    for name in sorted(os.listdir(base)):
        m = re.match(r"(\d{4}-\d{2}-\d{2})\.jsonl$", name)
        if not m or datetime.strptime(m.group(1), "%Y-%m-%d").date() < since:
            continue
        with open(os.path.join(base, name), encoding="utf-8") as fh:
            for line in fh:
                try:
                    batches.append(json.loads(line))
                except ValueError:
                    pass
    reports = []
    rp = os.path.join(base, "reports.jsonl")
    if os.path.exists(rp):
        with open(rp, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("rt", "")[:10] >= since.isoformat():
                    reports.append(r)
    return batches, reports


def fmt_t(ms):
    try:
        return datetime.fromtimestamp(ms / 1000, MSK).strftime("%d.%m %H:%M")
    except (TypeError, ValueError, OSError):
        return ""


def fmt_rt(rt):
    """The server's time of a report (ISO, UTC) in Moscow time, like the rest of the page."""
    try:
        return datetime.fromisoformat(rt).astimezone(MSK).strftime("%d.%m %H:%M")
    except (TypeError, ValueError):
        return str(rt or "")[5:16].replace("T", " ")


def app_stats(batches):
    people = {}
    feat = collections.Counter()
    feat_people = collections.defaultdict(set)
    errors = collections.Counter()
    perm = collections.Counter()
    nav = collections.Counter()
    for b in batches:
        p = people.setdefault(b["iid"], {"who": "", "device": device_of(b.get("ua")), "sessions": set(), "first": None, "last": None,
                                         "taps": collections.Counter(), "errors": 0, "standalone": None, "app": ""})
        if b.get("who"):
            p["who"] = b["who"]
        p["app"] = b.get("app") or p["app"]
        for e in b.get("events", []):
            t = e.get("t")
            p["first"] = t if p["first"] is None or (t and t < p["first"]) else p["first"]
            p["last"] = t if p["last"] is None or (t and t > p["last"]) else p["last"]
            name = e.get("e")
            if name == "start":
                p["sessions"].add(b.get("sid"))
                if e.get("standalone") is not None:
                    p["standalone"] = bool(e.get("standalone"))
            elif name == "tap":
                what = str(e.get("what") or "")
                feat[what] += 1
                feat_people[what].add(b["iid"])
                p["taps"][what] += 1
            elif name == "error":
                p["errors"] += 1
                errors[f"{e.get('msg', '')} · {e.get('src', '')}:{e.get('line', '')}"] += 1
            elif name == "geo_permission":
                perm[e.get("state") or "?"] += 1
            elif name == "fix" and e.get("odd"):
                nav["gps_odd"] += 1
            elif name in COUNTED:
                nav[name] += 1
    return people, feat, feat_people, errors, perm, nav


def render_stats(root, days):
    e = html.escape
    apps = sorted(a for a in os.listdir(root) if os.path.isdir(os.path.join(root, a)) and APP_RE.match(a)) if os.path.isdir(root) else []
    out = [f"<h1>Кто чем пользуется</h1><p class=m>За {days} дн. · обновлено {utcnow().astimezone(MSK):%d.%m.%Y %H:%M} · "
           f"<a href='?key={{KEY}}&days=1'>сутки</a> · <a href='?key={{KEY}}&days=7'>неделя</a> · <a href='?key={{KEY}}&days=30'>месяц</a></p>"]
    if not apps:
        out.append("<p>Пока ни одного журнала: приложения ещё ничего не прислали.</p>")
    for app in apps:
        batches, reports = read_app(root, app, days)
        people, feat, feat_people, errors, perm, nav = app_stats(batches)
        names = APP_LABELS.get(app, {})

        def label(k, names=names):
            if k in names:
                return names[k]
            kind, _, val = k.partition(":")
            if val and kind in TAP_KINDS:
                return f"{TAP_KINDS[kind]}: {WX_PLACE_NAMES.get(val, val) if kind == 'wxplace' else val}"
            return k
        sessions = sum(len(p["sessions"]) for p in people.values())
        out.append(f"<h2>{e(APP_NAMES.get(app, app))}</h2>")
        out.append(f"<div class=kpi><b>{len(people)}</b> телефонов <b>{sessions}</b> запусков <b>{nav.get('nav_start', 0)}</b> навигаций "
                   f"<b>{len(reports)}</b> сообщений о проблемах <b>{sum(errors.values())}</b> ошибок</div>")
        if reports:
            out.append("<h3>Что пишут о проблемах</h3><ul>" + "".join(
                f"<li><span class=m>{e(fmt_rt(r.get('rt', '')))}</span> {e(r.get('who') or '')} «{e(r.get('text') or '')}»</li>"
                for r in reports[-30:][::-1]) + "</ul>")
        if people:
            rows = []
            for iid, p in sorted(people.items(), key=lambda kv: -(kv[1]["last"] or 0)):
                top = ", ".join(f"{e(label(k))} {v}" for k, v in p["taps"].most_common(5))
                name = e(p["who"]) or f"<span class=m>без имени · {e(iid[-5:])}</span>"
                inst = "" if p["standalone"] is None else (" · установлено" if p["standalone"] else " · в браузере")
                rows.append(f"<tr><td>{name}<br><span class=m>{e(p['device'])}{inst}</span></td><td>{len(p['sessions'])}</td>"
                            f"<td>{fmt_t(p['last'])}</td><td>{top or '—'}</td><td>{p['errors'] or ''}</td></tr>")
            out.append("<h3>Люди</h3><table><tr><th>Кто</th><th>Запусков</th><th>Последний раз</th><th>Чем пользуется</th><th>Ошибок</th></tr>"
                       + "".join(rows) + "</table>")
            used = [(k, v, len(feat_people[k])) for k, v in feat.most_common(25)]
            out.append("<h3>Чем пользуются</h3><table><tr><th>Что</th><th>Нажатий</th><th>Людей</th></tr>" + "".join(
                f"<tr><td>{e(label(k))}</td><td>{v}</td><td>{n}</td></tr>" for k, v, n in used) + "</table>")
            unused = [label(k) for k in APP_FEATURES.get(app, []) if not feat.get(k)]
            if unused:
                out.append(f"<h3>Чем не пользуются</h3><p>{e(', '.join(unused))}</p>")
            if app in APP_EVENTS:
                title, events = APP_EVENTS[app]
                out.append(f"<h3>{e(title)}</h3><p>" + " · ".join(f"{e(events[k])}: <b>{nav[k]}</b>" for k in events if nav.get(k)) + "</p>")
            if perm:
                out.append("<h3>Геопозиция при запуске</h3><p>" + " · ".join(
                    f"{e({'granted': 'разрешена', 'prompt': 'спрашивает', 'denied': 'запрещена'}.get(k, k))}: {v}" for k, v in perm.most_common()) + "</p>")
            if errors:
                out.append("<h3>Ошибки</h3><ul>" + "".join(f"<li><b>{v}</b> × {e(k)}</li>" for k, v in errors.most_common(15)) + "</ul>")
    style = ("body{font:15px/1.45 system-ui,sans-serif;margin:0 auto;padding:12px 16px;max-width:900px;color:#111;background:#fff}"
             "h1{font-size:22px}h2{margin-top:28px;border-bottom:2px solid #0050b3}h3{margin:18px 0 6px}"
             ".m{color:#666;font-size:13px}.kpi b{font-size:20px;margin-left:12px}.kpi b:first-child{margin-left:0}"
             "table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left;vertical-align:top}"
             "@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.m{color:#aaa}td,th{border-color:#333}}")
    return (f"<!doctype html><html lang=ru><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<meta name=robots content=noindex><title>Кто чем пользуется</title><style>{style}</style><body>{''.join(out)}</body></html>")


class Handler(BaseHTTPRequestHandler):
    server_version = "ladoga-logs/2"
    root = "."
    key = ""

    def log_message(self, fmt, *args):  # no access log: it would hold the addresses
        pass

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", cors=False):
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin") or ""
        if cors and origin in CORS_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        if body:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        app, action = route(self.path)
        if action == "health":
            # An app on another origin asks here whether it may read the answers (web/log.js of СПб Топливо).
            self._send(200, b"ok", cors=True)
            return
        if action == "stats":
            q = parse_qs(urlparse(self.path).query)
            if not self.key or not secrets.compare_digest(q.get("key", [""])[0], self.key):
                self._send(404)
                return
            try:
                days = max(1, min(60, int(q.get("days", ["7"])[0])))
            except ValueError:
                days = 7
            page = render_stats(self.root, days).replace("{KEY}", html.escape(self.key))
            self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
            return
        self._send(404)

    def do_POST(self):
        app, kind = route(self.path)
        if not app or kind not in ("log", "report"):
            self._send(404, cors=True)
            return
        client = (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[-1].strip()
        if not rate_ok(client):
            self._send(429, cors=True)
            return
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = 0
        limit = MAX_LOG_BYTES if kind == "log" else MAX_REPORT_BYTES
        if size <= 0 or size > limit:
            self._send(413 if size > limit else 400, cors=True)
            return
        try:
            obj = json.loads(self.rfile.read(size).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send(400, cors=True)
            return
        batch = clean_batch(obj)
        if not batch:
            self._send(400, cors=True)
            return
        now = utcnow()
        batch["rt"] = now.isoformat(timespec="seconds")
        base = os.path.join(self.root, app)
        if kind == "log":
            append_line(os.path.join(base, f"{now:%Y-%m-%d}.jsonl"), batch)
        else:
            batch["text"] = str(obj.get("text") or "")[:2000]
            batch["screen"] = str(obj.get("screen") or "")[:40]
            batch["standalone"] = bool(obj.get("standalone"))
            os.makedirs(os.path.join(base, "reports"), exist_ok=True)
            name = f"{now:%Y%m%d-%H%M%S}-{secrets.token_hex(3)}.json"
            with open(os.path.join(base, "reports", name), "w", encoding="utf-8") as fh:
                json.dump(batch, fh, ensure_ascii=False, indent=1)
            append_line(os.path.join(base, "reports.jsonl"), {"rt": batch["rt"], "iid": batch["iid"], "who": batch["who"], "app": batch["app"],
                                                              "file": name, "text": batch["text"][:300]})
        self._send(204, cors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.environ.get("STATE_DIRECTORY", "/var/lib/ladoga-logs"))
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    os.makedirs(args.dir, exist_ok=True)
    key_path = os.path.join(args.dir, "stats.key")
    if not os.path.exists(key_path):
        with open(key_path, "w", encoding="utf-8") as fh:
            fh.write(secrets.token_urlsafe(18))
        os.chmod(key_path, 0o600)
    with open(key_path, encoding="utf-8") as fh:
        Handler.key = fh.read().strip()
    Handler.root = args.dir
    prune(args.dir)

    def pruner():
        while True:
            time.sleep(6 * 3600)
            prune(args.dir)
    threading.Thread(target=pruner, daemon=True).start()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"ladoga-logs on {args.host}:{args.port}, writing to {args.dir}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
