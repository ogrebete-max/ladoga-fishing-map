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
}
FEATURES = ["today", "map", "guide", "rules", "me", "btnLocate", "nav", "btnTrack", "btnLayers", "base-set", "marker", "fav", "share",
            "btnDark", "guard-on", "mob", "btnSos", "report-problem", "car-go", "retrace", "demo", "install", "depth-help", "icez-show"]


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
            elif name in ("nav_start", "nav_arrived", "map_free", "recenter", "shoal_ahead", "guard_on", "guard_alarm", "mob", "gap",
                          "saver_on", "voice", "report_sent", "geo_start", "fresh_merged"):
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
        sessions = sum(len(p["sessions"]) for p in people.values())
        out.append(f"<h2>{e(APP_NAMES.get(app, app))}</h2>")
        out.append(f"<div class=kpi><b>{len(people)}</b> телефонов <b>{sessions}</b> запусков <b>{nav.get('nav_start', 0)}</b> навигаций "
                   f"<b>{len(reports)}</b> сообщений о проблемах <b>{sum(errors.values())}</b> ошибок</div>")
        if reports:
            out.append("<h3>Что пишут о проблемах</h3><ul>" + "".join(
                f"<li><span class=m>{e(r.get('rt', '')[5:16].replace('T', ' '))}</span> {e(r.get('who') or '')} «{e(r.get('text') or '')}»</li>"
                for r in reports[-30:][::-1]) + "</ul>")
        if people:
            rows = []
            for iid, p in sorted(people.items(), key=lambda kv: -(kv[1]["last"] or 0)):
                top = ", ".join(f"{e(LABELS.get(k, k))} {v}" for k, v in p["taps"].most_common(5))
                name = e(p["who"]) or f"<span class=m>без имени · {e(iid[-5:])}</span>"
                inst = "" if p["standalone"] is None else (" · установлено" if p["standalone"] else " · в браузере")
                rows.append(f"<tr><td>{name}<br><span class=m>{e(p['device'])}{inst}</span></td><td>{len(p['sessions'])}</td>"
                            f"<td>{fmt_t(p['last'])}</td><td>{top or '—'}</td><td>{p['errors'] or ''}</td></tr>")
            out.append("<h3>Люди</h3><table><tr><th>Кто</th><th>Запусков</th><th>Последний раз</th><th>Чем пользуется</th><th>Ошибок</th></tr>"
                       + "".join(rows) + "</table>")
            used = [(k, v, len(feat_people[k])) for k, v in feat.most_common(25)]
            out.append("<h3>Чем пользуются</h3><table><tr><th>Что</th><th>Нажатий</th><th>Людей</th></tr>" + "".join(
                f"<tr><td>{e(LABELS.get(k, k))}</td><td>{v}</td><td>{n}</td></tr>" for k, v, n in used) + "</table>")
            if app == "ladoga":
                unused = [LABELS.get(k, k) for k in FEATURES if not feat.get(k)]
                if unused:
                    out.append(f"<h3>Чем не пользуются</h3><p>{e(', '.join(unused))}</p>")
                labels = {"geo_start": "включали геопозицию", "nav_start": "начинали навигацию", "nav_arrived": "дошли до точки",
                          "map_free": "сдвигали карту в навигации", "recenter": "возврат к лодке", "shoal_ahead": "мель впереди",
                          "voice": "голосовых подсказок", "saver_on": "тёмный экран", "guard_on": "сторож места", "guard_alarm": "тревог сторожа",
                          "mob": "человек за бортом", "gap": "перерывов в треке (телефон заблокирован)", "report_sent": "сообщений о проблемах"}
                out.append("<h3>Навигатор и трек</h3><p>" + " · ".join(f"{e(labels[k])}: <b>{nav[k]}</b>" for k in labels if nav.get(k)) + "</p>")
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

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        if body:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        app, action = route(self.path)
        if action == "health":
            self._send(200, b"ok")
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
            self._send(404)
            return
        client = (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[-1].strip()
        if not rate_ok(client):
            self._send(429)
            return
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = 0
        limit = MAX_LOG_BYTES if kind == "log" else MAX_REPORT_BYTES
        if size <= 0 or size > limit:
            self._send(413 if size > limit else 400)
            return
        try:
            obj = json.loads(self.rfile.read(size).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send(400)
            return
        batch = clean_batch(obj)
        if not batch:
            self._send(400)
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
        self._send(204)


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
