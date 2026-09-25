#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Receiver of the work log of «Ладога · рыболовная карта» (site/log.js): what was pressed, how GPS and the
navigator behaved, errors — sent by the phones in small batches, and «Сообщить о проблеме» reports.

Runs on the site's VPS behind Caddy (a `handle /ladoga/api/*` route to 127.0.0.1:8791, see README.md here), as
the unprivileged user of the collector, and writes only to its state directory:

  <dir>/YYYY-MM-DD.jsonl         one line per batch: server time + the batch (no IP address is stored)
  <dir>/reports/<stamp>-<id>.json one file per «Сообщить о проблеме»
  <dir>/reports.jsonl            one line per report: time, install id, the person's words (for a quick look)

Files older than KEEP_DAYS are deleted. Python 3.8+ standard library only.

    ladoga_logs.py --dir /var/lib/ladoga-logs [--port 8791]
"""
import argparse
import json
import os
import re
import secrets
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEEP_DAYS = 60
MAX_LOG_BYTES = 512 * 1024
MAX_REPORT_BYTES = 1024 * 1024
MAX_EVENTS = 600
RATE_PER_MIN = 60
ID_RE = re.compile(r"^[a-z0-9]{4,40}$")
_lock = threading.Lock()
_hits = {}


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
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _lock, open(path, "a", encoding="utf-8") as fh:
        fh.write(line)


def prune(root):
    limit = time.time() - KEEP_DAYS * 86400
    for base in (root, os.path.join(root, "reports")):
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            path = os.path.join(base, name)
            if os.path.isfile(path) and name != "reports.jsonl" and os.path.getmtime(path) < limit:
                try:
                    os.remove(path)
                except OSError:
                    pass


class Handler(BaseHTTPRequestHandler):
    server_version = "ladoga-logs/1"
    root = "."

    def log_message(self, fmt, *args):  # no access log: it would hold the addresses
        pass

    def _send(self, code, body=b""):
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        if body:
            self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0].rstrip("/").endswith("/api/health"):
            self._send(200, b"ok")
        else:
            self._send(404)

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        kind = "log" if path.endswith("/api/log") else "report" if path.endswith("/api/report") else None
        if not kind:
            self._send(404)
            return
        client = (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()
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
        if kind == "log":
            append_line(os.path.join(self.root, f"{now:%Y-%m-%d}.jsonl"), batch)
        else:
            batch["text"] = str(obj.get("text") or "")[:2000]
            batch["screen"] = str(obj.get("screen") or "")[:40]
            batch["standalone"] = bool(obj.get("standalone"))
            os.makedirs(os.path.join(self.root, "reports"), exist_ok=True)
            name = f"{now:%Y%m%d-%H%M%S}-{secrets.token_hex(3)}.json"
            with open(os.path.join(self.root, "reports", name), "w", encoding="utf-8") as fh:
                json.dump(batch, fh, ensure_ascii=False, indent=1)
            append_line(os.path.join(self.root, "reports.jsonl"), {"rt": batch["rt"], "iid": batch["iid"], "app": batch["app"], "file": name, "text": batch["text"][:300]})
        self._send(204)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.environ.get("STATE_DIRECTORY", "/var/lib/ladoga-logs"))
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    os.makedirs(args.dir, exist_ok=True)
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
