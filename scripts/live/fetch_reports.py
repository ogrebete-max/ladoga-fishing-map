#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Monitor of fresh angler reports for «Ладога · рыболовная карта» (see README.md next to this file).

Runs every day from a systemd timer on the site's VPS and keeps ONE growing file, reports.json, that the web app
reads next to the static points: fresh fishing reports from the forum of the Питерский клуб рыбаков (fisher.spb.ru)
and from public Telegram channels, fresh incidents on the ice and on the water (47news.ru, the rescuers' channel)
and new official notices (rules, ice, navigation; targets in watch.json). Reports and incidents are only ever added,
never removed: an old fishing place stays a fishing place, and the app decides how long an incident is shown.

The script decides what is due: the forum and Telegram are read every SEASON_CHECK_DAYS days in season (1 December –
30 April, the ice, and June – August) and every OFFSEASON_CHECK_DAYS days otherwise; the 47news RSS holds about one
day of news and is read on every run; each notice target has its own `every_days`.

Telegram is not reachable from the Moscow VPS: a GitHub Actions copy of this script (--only tg --name tg) publishes
tg.json to the branch live-tg, and the VPS merges it on every run (--relay-tg URL).

Nothing of a post is copied: records carry templated facts (place, fish, gear, depth, catch, ice) and the link to the
post; author names and usernames are never stored (see reports_extract.py).

Python 3.8+ standard library only.

    fetch_reports.py --out DIR [--only pkr,news47,tg,notices] [--force] [--budget SECONDS] [--known points.json]
                     [--relay-tg URL] [--since YYYY-MM-DD] [--name reports] [--keep-days N] [--watch watch.json]

Writes DIR/<name>.json atomically, keeps the last seen message ids, HTTP validators and a small index of hashed
words (to recognise reposts) in DIR/<name>_state.json, logs one line per source. Exit code 0 whenever the file was
written, even if some sources failed.
"""
import argparse
import datetime as dt
import gzip
import hashlib
import http.client
import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import reports_extract as rx  # noqa: E402

SCHEMA = 1
USER_AGENT = "ladoga-fishing-map/1.0 (+https://195.133.61.136/ladoga/)"
MSK = rx.MSK

# ---- cadence: the timer fires every day, the script decides what is due ----
SEASON_CHECK_DAYS = 3         # forum and Telegram in season …
OFFSEASON_CHECK_DAYS = 5      # … and out of it (the owner: «раз в 3–5 дней, сезон — не сезон»)
SEASON_MONTHS = (12, 1, 2, 3, 4, 6, 7, 8)   # the ice (1 Dec – 30 Apr) and the summer (1 Jun – 31 Aug)
DUE_SLACK_H = 3               # a daily timer with a random delay must not slip a whole day
RETRY_AFTER_FAIL_H = 20       # a failed source is tried again on the next daily run
NOTICES_DEFAULT_DAYS = 7
NEWS47_EVERY_RUN = True       # the RSS holds about one day of news: read it on every run

# ---- sources ----
NEWS47_RSS = "https://47news.ru/rss/"
NEWS47_MAX_ARTICLES = 4       # article pages per run, only for items the RSS text cannot place or classify
PKR_CATALOG = "https://fisher.spb.ru/news/message-bycatalog.php?category={cat}&water={w}&StartValue={s}"
PKR_LIST = "https://fisher.spb.ru/news/"
PKR_PAGE_SIZE = 10
PKR_MAX_PAGES = 3             # per water and run: at most ~6 messages per water in any 5 days (2025–2026)
# fisher.spb.ru catalog: all southern waters of «Ладожское озеро» (the northern ones are skipped by the extractor)
# and the lower rivers: Волхов (only below Старая Ладога is kept), Свирь, Сясь, Нева (only its source).
PKR_WATERS = [(5, w) for w in sorted(rx.CATALOG_DEFAULT)] + [(2, 134), (2, 143), (2, 145), (2, 191), (7, 28)]
TG_CHANNELS = list(rx.TG_SOURCES)  # originals first, the aggregator (novosti_s_vodoemov) last
TG_MAX_PAGES = 12             # t.me/s shows ~20 posts per page; the busiest channel posts ~40 a day
TG_FIRST_MAX_PAGES = 30       # the first run goes back to --since
DEFAULT_SINCE = "2026-08-25"  # the static dataset has fisher.spb.ru up to 28.08.2026 and Telegram up to 22.09.2026

# ---- store ----
KEEP_NOTICES = 60
NOTICE_MAX_AGE_DAYS = 120     # a dated notice older than this is not added (a target may set "max_age_days")
TEXT_INDEX_DAYS = 60
TEXT_SIM = 0.6                # a repost: this share of words in common …
TEXT_SIM_DAYS = 3             # … within this many days
NEAR_SAME_M = 100             # same source, same date, this close: the same report
LAUNCH_NEAR_M = 60            # a parking this close to a known one is not new
INCIDENT_NEAR_M = 1500        # the same incident from two sources: same kind, ±1 day, this close or the same place
SAME_FACTS_KM = 30            # a repost placed elsewhere by another source (catalog pin vs the place in the text) …
SAME_FACTS_DAYS = 3           # … and dated by its own post (a channel reposting a club report two days later)
NEWS47_SEEN_KEEP = 600


# ----------------------------------------------------------------------------------------------- helpers

def now_msk():
    return dt.datetime.now(MSK).replace(microsecond=0)


def iso(t):
    if t is None:
        return None
    if isinstance(t, (int, float)):
        t = dt.datetime.fromtimestamp(t, MSK)
    if isinstance(t, dt.datetime):
        return t.astimezone(MSK).isoformat(timespec="seconds")
    return t.isoformat()


def parse_iso(s):
    try:
        t = dt.datetime.fromisoformat(s)
        return t if t.tzinfo else t.replace(tzinfo=MSK)
    except (TypeError, ValueError):
        return None


def trim(s, limit):
    s = rx.norm_ws(s)
    if len(s) <= limit:
        return s
    cut = s[: limit - 1]
    sp = cut.rfind(" ")
    if sp > limit * 0.6:
        cut = cut[:sp]
    return cut.rstrip(" ,;:–-") + "…"


def short_hash(s, n=10):
    return hashlib.sha1((s or "").encode("utf-8")).hexdigest()[:n]


# ------------------------------------------------------------------------------------------------- HTTP

class FetchError(Exception):
    pass


class Response:
    def __init__(self, url, status, headers, body):
        self.url, self.status, self.headers, self.body = url, status, headers, body

    def text(self, fallback="utf-8"):
        ctype = (self.headers.get("Content-Type") if self.headers else "") or ""
        m = re.search(r"charset=[\"']?([\w-]+)", ctype, re.I)
        for enc in ((m.group(1) if m else None), fallback, "utf-8", "cp1251"):
            if not enc:
                continue
            try:
                return self.body.decode(enc)
            except (LookupError, UnicodeDecodeError):
                continue
        return self.body.decode("utf-8", "replace")


class Http:
    """Polite urllib client (as in fetch_live.py): ≤ 1 request per 1.1 s per host, timeouts, retries with backoff,
    gzip, a total time budget, conditional GET when asked. TLS certificates are always verified."""

    BACKOFF = (3.0, 8.0, 15.0)

    def __init__(self, state, deadline, min_interval=1.1):
        self.validators = state.setdefault("http", {})
        self.deadline = deadline
        self.min_interval = min_interval
        self.last_start = {}
        self.count = 0
        self.per_host = {}
        ctx = ssl.create_default_context()  # verification ON; never disabled
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))

    def time_left(self):
        return self.deadline - time.monotonic()

    def get(self, url, timeout=20.0, retries=2, conditional=False, validate=None, max_bytes=8 << 20):
        host = urllib.parse.urlsplit(url).hostname or ""
        last_err = "not attempted"
        for attempt in range(retries + 1):
            if attempt:
                pause = self.BACKOFF[min(attempt - 1, len(self.BACKOFF) - 1)]
                if self.time_left() < pause + 10:
                    last_err += "; no time left to retry"
                    break
                time.sleep(pause)
            wait = self.last_start.get(host, -1e9) + self.min_interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            left = self.time_left()
            if left < 8:
                last_err = "time budget exhausted"
                break
            t = max(5.0, min(timeout, left - 3))
            headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate", "Accept": "*/*"}
            v = self.validators.get(url) if conditional else None
            if v:
                if v.get("etag"):
                    headers["If-None-Match"] = v["etag"]
                if v.get("last_modified"):
                    headers["If-Modified-Since"] = v["last_modified"]
            self.last_start[host] = time.monotonic()
            self.count += 1
            self.per_host[host] = self.per_host.get(host, 0) + 1
            try:
                with self.opener.open(urllib.request.Request(url, headers=headers), timeout=t) as resp:
                    body = self._read(resp, t + 15, max_bytes)
                    status, hdrs = resp.status, resp.headers
            except urllib.error.HTTPError as e:
                if e.code == 304:
                    return Response(url, 304, e.headers, b"")
                last_err = f"HTTP {e.code} {e.reason}"
                if e.code in (408, 425, 429, 500, 502, 503, 504):
                    continue
                break
            except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
                reason = e.reason if isinstance(e, urllib.error.URLError) else e
                if isinstance(reason, ssl.SSLCertVerificationError):  # never retried, never switched off
                    raise FetchError(f"TLS certificate verification failed for {host}: "
                                     f"{getattr(reason, 'verify_message', None) or reason} (verification stays on)")
                last_err = f"{type(reason).__name__}: {reason}"
                continue
            enc = (hdrs.get("Content-Encoding") or "").lower()
            try:
                if enc in ("gzip", "x-gzip"):
                    body = gzip.decompress(body)
                elif enc == "deflate":
                    try:
                        body = zlib.decompress(body)
                    except zlib.error:
                        body = zlib.decompress(body, -zlib.MAX_WBITS)
            except (OSError, EOFError, zlib.error) as e:
                last_err = f"broken {enc} body: {e}"
                continue
            if validate is not None and not validate(body):
                last_err = f"incomplete response ({len(body)} bytes)"
                continue
            if conditional:
                etag, lm = hdrs.get("ETag"), hdrs.get("Last-Modified")
                if etag or lm:
                    self.validators[url] = {"etag": etag, "last_modified": lm}
                else:
                    self.validators.pop(url, None)
            return Response(url, status, hdrs, body)
        raise FetchError(last_err)

    @staticmethod
    def _read(resp, limit_s, max_bytes):
        start, chunks, n = time.monotonic(), [], 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            chunks.append(chunk)
            n += len(chunk)
            if n > max_bytes:
                raise FetchError(f"response larger than {max_bytes} bytes")
            if time.monotonic() - start > limit_s:
                raise TimeoutError(f"body not received in {limit_s:.0f} s")
        return b"".join(chunks)


def rss_complete(body):
    return body.rstrip().endswith(b"</rss>")


def pkr_complete(body):
    return b"</html>" in body[-4096:].lower()


def tg_complete(body):
    return b"</html>" in body[-4096:].lower()


def page_complete(body):
    return b"article-text" in body and b"</html>" in body[-8192:].lower()


# ------------------------------------------------------------------------------------------------- files

def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else None
    except (OSError, ValueError, TypeError):
        return None


def write_atomic(path, data):
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def dumps(obj, pretty=False):
    if pretty:
        return json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8")
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class LockBusy(Exception):
    pass


def _lock(out_dir, name):
    """One run at a time per output (a manual run next to the timer's)."""
    path = os.path.join(out_dir, f".fetch_reports_{name}.lock")
    f = open(path, "a+")
    try:
        try:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except ImportError:
            import msvcrt
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
    except ImportError:
        pass
    except OSError:
        f.close()
        raise LockBusy(f"another fetch_reports.py run holds {path}")
    return f


# ---------------------------------------------------------------------------------------- known dataset

class Known:
    """What site/data/points.json already has: links, (source, id) pairs, points by source and date, parkings."""

    def __init__(self, data=None):
        self.urls, self.sids, self.by_src_date, self.launch = set(), set(), {}, []
        for r in (data or {}).get("reports") or []:
            if not isinstance(r, dict):
                continue
            src = r.get("src") or ""
            for k in ("url", "orig"):
                if r.get(k):
                    self.urls.add(rx.norm_url(r[k]))
            for s in re.split(r";\s*", str(r.get("sid") or "")):
                s = s.strip()
                if not s:
                    continue
                self.sids.add((src, s))
                if s.startswith("http"):
                    self.urls.add(rx.norm_url(s))
                m = re.match(r"tg:([\w]+/\d+)$", s)
                if m:
                    self.urls.add(rx.norm_url("t.me/" + m.group(1)))
                m = re.match(r"47news:(\d+)$", s)
                if m:
                    self.urls.add(rx.norm_url(f"47news.ru/articles/{m.group(1)}"))
            try:
                la, lo = float(r["lat"]), float(r["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            if r.get("date"):
                self.by_src_date.setdefault((src, str(r["date"])[:10]), []).append((la, lo))
            if r.get("kind") in ("launch", "parking"):
                self.launch.append((la, lo))

    @classmethod
    def load(cls, path):
        if not path:
            return cls()
        data = load_json(path)
        if data is None:
            raise ValueError(f"cannot read {path}")
        return cls(data)

    def has(self, rec):
        if rec.get("url") and rx.norm_url(rec["url"]) in self.urls:
            return True
        return bool(rec.get("sid")) and (rec.get("src"), str(rec["sid"])) in self.sids


# ------------------------------------------------------------------------------------------------ store

def _date(s):
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


INCIDENT_KINDS = ("ice_incident", "water_incident")


class Store:
    """The append-only content of <name>.json and the deduplication of new records."""

    def __init__(self, prev, state, known, today):
        self.reports = [r for r in prev.get("reports") or [] if isinstance(r, dict) and r.get("id")]
        self.incidents = [r for r in prev.get("incidents") or [] if isinstance(r, dict) and r.get("id")]
        self.notices = [r for r in prev.get("notices") or [] if isinstance(r, dict) and r.get("id")]
        self.ids = {r["id"] for r in self.reports + self.incidents}
        self.known = known
        self.today = today
        self.index = rx.TextIndex(state.get("index") or [])
        self.origs = dict(state.get("orig") or {})
        self.stats = {}

    def _count(self, src, what):
        s = self.stats.setdefault(src, {})
        s[what] = s.get(what, 0) + 1

    def _near_same(self, rec):
        d, la, lo = rec.get("date"), rec["lat"], rec["lon"]
        for r in self.reports:
            if r.get("src") == rec.get("src") and r.get("date") == d and r.get("kind") == rec.get("kind") \
                    and rx.hav(la, lo, r["lat"], r["lon"]) <= NEAR_SAME_M:
                return True
        for a, b in self.known.by_src_date.get((rec.get("src"), d), []):
            if rx.hav(la, lo, a, b) <= NEAR_SAME_M:
                return True
        return False

    def _near_launch(self, rec):
        pts = [(r["lat"], r["lon"]) for r in self.reports if r.get("kind") == "launch"] + self.known.launch
        return any(rx.hav(rec["lat"], rec["lon"], a, b) <= LAUNCH_NEAR_M for a, b in pts)

    def _same_facts(self, rec):
        """A report reposted by another source (the channels copy the club's forum and VK): the same date
        ±SAME_FACTS_DAYS, the same fish and the same depth or catch, within SAME_FACTS_KM. Works on the server without
        any post text."""
        fish, depth, catch = rec.get("fish") or [], rec.get("depth"), rec.get("catch")
        d = _date(rec.get("date"))
        if not fish or not (depth or catch) or not d:
            return False
        for r in self.reports:
            if r.get("src") == rec.get("src") or r.get("kind") != "fishing" or (r.get("fish") or []) != fish:
                continue
            rd = _date(r.get("date"))
            if not rd or abs((rd - d).days) > SAME_FACTS_DAYS:
                continue
            if not ((depth and r.get("depth") == depth) or (catch and r.get("catch") == catch)):
                continue
            if rx.hav(rec["lat"], rec["lon"], r["lat"], r["lon"]) <= SAME_FACTS_KM * 1000:
                return True
        return False

    def _aggregator_dup(self, rec):
        """build_points_2026: a report of the club's aggregator channel with the same place ±1 day as a club report."""
        d = _date(rec.get("date"))
        if not d:
            return False
        for r in self.reports:
            if r.get("src") == rx.PKR_SRC and r.get("place") == rec.get("place"):
                rd = _date(r.get("date"))
                if rd and abs((rd - d).days) <= 1:
                    return True
        return False

    def _incident_dup(self, rec):
        d = _date(rec.get("date"))
        for r in self.incidents:
            rd = _date(r.get("date"))
            if r.get("kind") != rec.get("kind") or not rd or not d or abs((rd - d).days) > 1:
                continue
            if r.get("place") == rec.get("place") or rx.hav(rec["lat"], rec["lon"], r["lat"], r["lon"]) <= INCIDENT_NEAR_M:
                return True
        return False

    def add_post(self, recs, src_key, text=None, orig=None):
        """Add the records of one post (several places of one post share its text). Returns how many were added."""
        recs = [r for r in recs if r]
        have = [r for r in recs if r["id"] in self.ids]
        for _ in have:
            self._count(src_key, "have")
        recs = [r for r in recs if r["id"] not in self.ids]
        if not recs:
            return 0
        if text:
            sim, k = self.index.best(text, recs[0].get("date"), days=TEXT_SIM_DAYS)
            if sim >= TEXT_SIM:
                self._count(src_key, "repost")
                return 0
        oh = short_hash(rx.norm_url(orig)) if orig else None
        if oh and oh in self.origs:
            self._count(src_key, "repost")
            return 0
        added = 0
        for rec in recs:
            rec = {k: v for k, v in rec.items() if not k.startswith("_")}
            why = self._reject(rec)
            if why:
                self._count(src_key, why)
                continue
            rec["added"] = self.today.isoformat()
            (self.incidents if rec["kind"] in INCIDENT_KINDS else self.reports).append(rec)
            self.ids.add(rec["id"])
            self._count(src_key, "added")
            added += 1
        if added:
            if text:
                self.index.add(recs[0]["id"], recs[0].get("date"), text)
            if oh:
                self.origs[oh] = recs[0].get("date") or self.today.isoformat()
        return added

    def _reject(self, rec):
        if rec["id"] in self.ids:
            return "have"
        if self.known.has(rec):
            return "in_dataset"
        if rec["kind"] in INCIDENT_KINDS:
            return "same_incident" if self._incident_dup(rec) else None
        if rec["kind"] == "launch":
            return "parking_known" if self._near_launch(rec) else None
        if rec.get("src") != rx.PKR_SRC and self._near_same(rec):
            return "same_place_date"
        if rec.get("src") == rx.TG_SOURCES["novosti_s_vodoemov"] and self._aggregator_dup(rec):
            return "aggregator_dup"
        if rec["kind"] == "fishing" and self._same_facts(rec):
            return "same_facts"
        return None

    def merge_relay(self, relay):
        """Records of the Telegram copy (tg.json of the GitHub Action): no texts, the other rules apply."""
        n = 0
        for rec in (relay.get("reports") or []) + (relay.get("incidents") or []):
            if not isinstance(rec, dict) or not rec.get("id") or rec.get("lat") is None or rec.get("lon") is None:
                continue
            if not rx.in_bbox(float(rec["lat"]), float(rec["lon"])):
                continue
            rec = {k: v for k, v in rec.items() if k != "added"}
            n += self.add_post([rec], "tg")
        return n

    def prune(self, keep_days):
        """The GitHub copy keeps what it found in the last keep_days (the server's store keeps everything)."""
        if not keep_days:
            return
        cut = (self.today - dt.timedelta(days=keep_days)).isoformat()
        self.reports = [r for r in self.reports if (r.get("added") or r.get("date") or "") >= cut]
        self.incidents = [r for r in self.incidents if (r.get("added") or r.get("date") or "") >= cut]

    def state_index(self):
        since = (self.today - dt.timedelta(days=TEXT_INDEX_DAYS)).isoformat()
        return self.index.entries(since), {k: v for k, v in self.origs.items() if v >= since}


def newest_first(recs):
    return sorted(recs, key=lambda r: (r.get("date") or "", r.get("added") or "", r.get("id") or ""), reverse=True)


# ----------------------------------------------------------------------------------------------- context

class Ctx:
    def __init__(self, now, state, http, store, force, deadline, since, log):
        self.now, self.state, self.http, self.store = now, state, http, store
        self.force, self.deadline, self.since, self.log = force, deadline, since, log

    def time_left(self):
        return self.deadline - time.monotonic()


def season_mode(now):
    return "season" if now.month in SEASON_MONTHS else "offseason"


def check_days(now):
    return SEASON_CHECK_DAYS if season_mode(now) == "season" else OFFSEASON_CHECK_DAYS


def due(src_state, now, days, force):
    """(due?, why). Forced runs, never checked, a failure a day ago, or `days` since the last good check."""
    if force:
        return True, "forced"
    ok, tried = src_state.get("ok"), src_state.get("try")
    t = now.timestamp()
    if src_state.get("error") and tried and t - tried >= RETRY_AFTER_FAIL_H * 3600:
        return True, "retry after a failure"
    if not ok:
        return True, "first check"
    return t - ok >= days * 86400 - DUE_SLACK_H * 3600, ""


def next_due(src_state, now, days):
    ok = src_state.get("ok")
    if not ok:
        return now
    return dt.datetime.fromtimestamp(ok + days * 86400 - DUE_SLACK_H * 3600, MSK).replace(microsecond=0)


# ------------------------------------------------------------------------------------------- collectors

def collect_news47(ctx):
    st = ctx.state.setdefault("news47", {})
    seen = list(st.get("seen") or [])
    seen_set = set(seen)
    r = ctx.http.get(NEWS47_RSS, timeout=20, retries=2, validate=rss_complete)
    items = rx.rss_items(r.body)
    found, fetched, pending, why_counts = 0, 0, 0, {}
    for it in sorted(items, key=lambda x: x["published"] or ctx.now):
        if it["id"] in seen_set:
            continue
        pub = (it["published"] or ctx.now).astimezone(MSK).date()
        rid, sid = f"news47:{it['id']}", f"47news:{it['id']}"
        rec, why = rx.incident_extract(it["title"], it["summary"], pub, rx.NEWS47_SRC, it["url"], rid, sid)
        if not rec and why in rx.RECHECK_REASONS and rx.news_candidate(it["title"], it["summary"]):
            if fetched >= NEWS47_MAX_ARTICLES or ctx.time_left() < 20:
                pending += 1  # stays unseen: read on the next run while it is still in the RSS
                continue
            fetched += 1
            try:
                page = ctx.http.get(it["url"], timeout=20, retries=1, validate=page_complete)
            except FetchError as e:
                pending += 1
                ctx.log(f"{'news47':<16} article {it['url']} not read: {trim(str(e), 120)}")
                continue
            art = rx.parse_47news_article(page.body)
            if art is None:
                pending += 1
                continue
            when = (art["published"].date() if art["published"] else pub)
            rec, why = rx.incident_extract(art["title"] or it["title"], "\n".join(rx.lead_paragraphs(art["paras"])),
                                           when, rx.NEWS47_SRC, it["url"], rid, sid)
        seen.append(it["id"])
        seen_set.add(it["id"])
        why_counts[why] = why_counts.get(why, 0) + 1
        if rec:
            found += ctx.store.add_post([rec], "news47")
    st["seen"] = seen[-NEWS47_SEEN_KEEP:]
    skipped = ", ".join(f"{k} {v}" for k, v in sorted(why_counts.items()) if k != "ok")
    return {"status": "ok", "summary": f"rss {len(items)} items, new incidents {found}, articles read {fetched}"
                                       + (f", {pending} left for the next run" if pending else "")
                                       + (f"; skipped: {skipped}" if skipped else "")}


def collect_pkr(ctx):
    st = ctx.state.setdefault("pkr", {})
    waters = st.setdefault("waters", {})
    pages = found = seen_msgs = 0
    problems, failed = [], False
    for cat, w in PKR_WATERS:
        if ctx.time_left() < 15:
            problems.append("run time budget exhausted before all waters")
            failed = True
            break
        ws = waters.setdefault(f"{cat}:{w}", {})
        top = ws.get("top")
        new_top = top
        stopped = False
        for page_no in range(PKR_MAX_PAGES):
            url = PKR_CATALOG.format(cat=cat, w=w, s=page_no * PKR_PAGE_SIZE)
            try:
                r = ctx.http.get(url, timeout=25, retries=2, validate=pkr_complete)
            except FetchError as e:
                problems.append(f"{cat}:{w} {trim(str(e), 80)}")
                stopped = True
                break
            pages += 1
            page = rx.parse_pkr_page(r.body)
            msgs = page["messages"]
            if msgs:  # the newest id of the water is remembered even when nothing passes --since
                new_top = max(new_top or 0, msgs[0]["id"])
            older = False
            for m in msgs:
                if (top is not None and m["id"] <= top) or m["date"] < ctx.since:
                    older = True
                    continue
                seen_msgs += 1
                new_top = max(new_top or 0, m["id"])
                rec, why = rx.pkr_extract(m, cat, w)
                if rec:
                    found += ctx.store.add_post([rec], "pkr", text=rec.get("_text"))
                else:
                    ctx.store._count("pkr", why)
            if older or len(msgs) < PKR_PAGE_SIZE or (page["total"] or 0) <= (page_no + 1) * PKR_PAGE_SIZE:
                break
            if page_no == PKR_MAX_PAGES - 1:
                problems.append(f"{cat}:{w} more than {PKR_MAX_PAGES} pages of new messages")
        if new_top is not None and not stopped:  # after a failure the next run reads the water again
            ws["top"] = new_top
        failed = failed or stopped
    res = {"status": "ok" if not problems else "partial", "retry": failed,
           "summary": f"{len(PKR_WATERS)} waters, {pages} pages, {seen_msgs} new messages, new reports {found}"}
    if problems:
        res["error"] = "; ".join(problems[:4])
    return res


def tg_fetch_page(ctx, channel, before=None):
    url = f"https://t.me/s/{channel}" + (f"?before={before}" if before else "")
    r = ctx.http.get(url, timeout=25, retries=2, validate=tg_complete)
    return rx.parse_tg_page(r.body, channel), rx.tg_older_link(r.body)


def collect_tg(ctx):
    st = ctx.state.setdefault("tg", {})
    chans = st.setdefault("channels", {})
    pages = found = new_posts = 0
    problems, failed = [], False
    for ch in TG_CHANNELS:
        if ctx.time_left() < 15:
            problems.append("run time budget exhausted before all channels")
            failed = True
            break
        cs = chans.setdefault(ch, {})
        top = cs.get("top")
        cap = TG_MAX_PAGES if top else TG_FIRST_MAX_PAGES
        new_top = top
        before, got = None, {}
        reached = stopped = False
        for page_no in range(cap):
            if ctx.time_left() < 12:
                problems.append(f"{ch}: stopped by the time budget")
                stopped = True
                break
            try:
                msgs, older = tg_fetch_page(ctx, ch, before)
            except FetchError as e:
                problems.append(f"{ch}: {trim(str(e), 80)}")
                stopped = True
                break
            pages += 1
            if not msgs:
                reached = True
                break
            if page_no == 0:  # the newest id of the channel is remembered even when nothing passes --since
                new_top = max(new_top or 0, max(m["id"] for m in msgs))
            for m in msgs:
                if top is not None and m["id"] <= top:
                    reached = True
                    continue
                if m["date"] is None or m["date"] < ctx.since:
                    reached = True
                    continue
                got[m["id"]] = m
            low = min(m["id"] for m in msgs)
            if reached or not older or (before is not None and low >= before):
                reached = True
                break
            before = low
        if not reached and not stopped and got:
            problems.append(f"{ch}: more than {cap} pages of new posts, the oldest were not read")
        for m in sorted(got.values(), key=lambda x: x["id"]):
            new_posts += 1
            if ch in rx.TG_INCIDENT_CHANNELS:
                rec, why = rx.incident_extract("", m["text"], m["date"], rx.TG_SOURCES[ch], f"https://t.me/{ch}/{m['id']}",
                                               f"tg:{ch}/{m['id']}", f"tg:{ch}/{m['id']}")
                if rec:
                    found += ctx.store.add_post([rec], "tg")
                continue
            recs, why = rx.tg_extract(m, ch)
            if recs:
                found += ctx.store.add_post(recs, "tg", text=m["text"], orig=rx.orig_link(m.get("hrefs")))
            else:
                ctx.store._count("tg", why)
        if new_top is not None and not (stopped and not reached):  # after a failure the next run reads again
            cs["top"] = new_top
        failed = failed or stopped
    res = {"status": "ok" if not problems else "partial", "retry": failed,
           "summary": f"{len(TG_CHANNELS)} channels, {pages} pages, {new_posts} new posts, new records {found}"}
    if problems:
        res["error"] = "; ".join(problems[:4])
    return res


def collect_relay(ctx, url):
    r = ctx.http.get(url, timeout=25, retries=1)
    relay = json.loads(r.text("utf-8"))
    if not isinstance(relay, dict) or relay.get("v") != SCHEMA:
        raise ValueError("not a tg.json of this monitor")
    n = ctx.store.merge_relay(relay)
    return relay, {"status": "relay", "summary": f"{len(relay.get('reports') or [])} reports and "
                                                 f"{len(relay.get('incidents') or [])} incidents in the copy "
                                                 f"(collected {relay.get('generated')}), new {n}"}


def load_watch(path):
    """watch.json (official pages to watch): {"v": 1, "targets": [...]}. None when missing."""
    if not path or not os.path.exists(path):
        return None
    data = load_json(path)
    if not data or not isinstance(data.get("targets"), list):
        raise ValueError(f"{path}: no targets")
    return [t for t in data["targets"] if isinstance(t, dict) and t.get("id") and t.get("url")]


def notice_items(target, resp):
    """Items of a watched page: an RSS feed is read as XML (its regex is the fallback), a page by its regex."""
    ttype = (target.get("type") or "html").lower()
    if ttype == "rss":
        try:
            out = []
            for it in rx.rss_items(resp.body):
                out.append({"url": urllib.parse.urljoin(target.get("base") or target["url"], it["url"]),
                            "title": it["title"], "summary": it["summary"],
                            "date": it["published"].date() if it["published"] else None})
            if out or not target.get("item"):
                return out
        except (ValueError,) + ET_ERRORS:
            if not target.get("item"):
                raise
    if not target.get("item"):
        raise ValueError("no item regex for an html target")
    text = resp.text()
    out = []
    for it in rx.extract_notice_items(text, target["item"], target.get("base") or target["url"]):
        it["date"] = rx.parse_date_any(it.pop("date_raw", ""))
        out.append(it)
    return out


def collect_notices(ctx, targets):
    st = ctx.state.setdefault("notices", {})
    have = {n["id"] for n in ctx.store.notices}
    lines, errors, checked = [], {}, 0
    for t in targets:
        tid = t["id"]
        ts = st.setdefault(tid, {})
        days = t.get("every_days") or NOTICES_DEFAULT_DAYS
        ok, why = due(ts, ctx.now, days, ctx.force)
        if not ok:
            continue
        if ctx.time_left() < 12:
            errors[tid] = "skipped: run time budget exhausted"
            continue
        ts["try"] = ctx.now.timestamp()
        try:
            resp = ctx.http.get(t["url"], timeout=25, retries=2, conditional=True)
            items = [] if resp.status == 304 else notice_items(t, resp)
            inc = re.compile(t["include"], re.I) if t.get("include") else None
            exc = re.compile(t["exclude"], re.I) if t.get("exclude") else None
        except (FetchError, ValueError, re.error, KeyError, ET_ERRORS) as e:
            msg = trim(f"{type(e).__name__}: {e}" if not isinstance(e, FetchError) else str(e), 200)
            ts.update(error=msg)
            errors[tid] = msg
            continue
        checked += 1
        new = 0
        oldest = ctx.now.date() - dt.timedelta(days=int(t.get("max_age_days") or NOTICE_MAX_AGE_DAYS))
        for it in items:
            text = f"{it['title']} {it.get('summary') or ''}"
            if inc and not (inc.search(it["title"]) or inc.search(text)):
                continue
            if exc and exc.search(text):
                continue
            nid = f"{tid}:{short_hash(rx.norm_url(it['url']))}"
            if nid in have:
                continue
            d = it.get("date")
            if d and d < oldest:
                continue
            n = {"id": nid, "date": d.isoformat() if d else None, "title": trim(it["title"], 220), "url": it["url"],
                 "src": t.get("name") or tid, "topic": t.get("topic") or "", "added": ctx.now.date().isoformat()}
            ctx.store.notices.append({k: v for k, v in n.items() if v})
            have.add(nid)
            new += 1
        ts["ok"] = ctx.now.timestamp()
        ts.pop("error", None)
        lines.append(f"{tid} {len(items)} items" + (f" (+{new})" if new else "") + (" not modified" if resp.status == 304 else ""))
    ctx.store.notices = sorted(ctx.store.notices, key=lambda n: (n.get("date") or n.get("added") or "", n["id"]),
                               reverse=True)[:KEEP_NOTICES]
    return checked, lines, errors


try:
    from xml.etree.ElementTree import ParseError as _ParseError
    ET_ERRORS = (_ParseError,)
except ImportError:  # pragma: no cover
    ET_ERRORS = ()


# ------------------------------------------------------------------------------------------------- run

ALL_SOURCES = ("news47", "pkr", "tg", "notices")


def sources_list(targets):
    out = [{"id": "pkr", "name": rx.PKR_SRC, "url": PKR_LIST},
           {"id": "news47", "name": rx.NEWS47_SRC, "url": "https://47news.ru/"}]
    out += [{"id": f"tg:{ch}", "name": rx.TG_SOURCES[ch], "url": f"https://t.me/s/{ch}"} for ch in TG_CHANNELS]
    out += [{"id": f"notices:{t['id']}", "name": t.get("name") or t["id"], "url": t["url"]} for t in targets or []]
    return out


def run(out_dir, name="reports", now=None, http=None, force=False, only=None, budget=240.0, log=print, known=None,
        relay_tg=None, since=None, keep_days=0, watch_path=None):
    """Collect what is due and write out_dir/<name>.json. Returns the written dict."""
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{name}.json")
    state_path = os.path.join(out_dir, f"{name}_state.json")
    prev = load_json(out_path) or {}
    state = load_json(state_path) or {}
    now = now or now_msk()
    deadline = time.monotonic() + budget
    http = http or Http(state, deadline)
    since = since or rx.parse_date_any(DEFAULT_SINCE)
    known = known if isinstance(known, Known) else Known()
    store = Store(prev, state, known, now.date())
    ctx = Ctx(now, state, http, store, force, deadline, since, log)
    only = set(only or ALL_SOURCES)
    src_state = state.setdefault("src", {})
    checked = dict(prev.get("checked") or {})
    errors = {}
    t_run = time.monotonic()
    days = check_days(now)
    try:
        targets = load_watch(watch_path if watch_path is not None else os.path.join(HERE, "watch.json"))
    except ValueError as e:
        targets = None
        errors["notices"] = trim(str(e), 200)

    def block(key, fn, cadence_days):
        ss = src_state.setdefault(key, {})
        t0 = time.monotonic()
        if cadence_days is not None:
            ok, why = due(ss, now, cadence_days, force)
            if not ok:
                log(f"{key:<16} cached   next check {iso(next_due(ss, now, cadence_days))}")
                if ss.get("error") or ss.get("problem"):
                    errors[key] = ss.get("error") or ss.get("problem")
                return
        if ctx.time_left() < 15:
            errors[key] = "skipped: run time budget exhausted"
            log(f"{key:<16} skipped  run time budget exhausted")
            return
        ss["try"] = now.timestamp()
        try:
            res = fn(ctx)
        except Exception as e:  # a source must never break the others
            msg = trim(f"{type(e).__name__}: {e}" if not isinstance(e, FetchError) else str(e), 300)
            ss["error"] = msg
            errors[key] = msg
            log(f"{key:<16} FAILED   {msg} ({time.monotonic() - t0:.1f} s)")
            return
        ss["ok"] = now.timestamp()
        ss.pop("error", None)
        ss.pop("problem", None)
        checked[key] = iso(now)
        if res.get("error"):
            errors[key] = ss["problem"] = trim(res["error"], 300)
            if res.get("retry"):  # a page did not come: try again on the next daily run, not in 3–5 days
                ss["error"] = errors[key]
        stats = store.stats.get(key) or {}
        extra = ", ".join(f"{k} {v}" for k, v in sorted(stats.items()) if k != "added")
        log(f"{key:<16} {res['status']:<8} {res.get('summary', '')}" + (f"; dropped: {extra}" if extra else "")
            + (f"; problems: {trim(res['error'], 160)}" if res.get("error") else "") + f" ({time.monotonic() - t0:.1f} s)")

    if "news47" in only:
        block("news47", collect_news47, None if NEWS47_EVERY_RUN else days)
    if "pkr" in only:  # the club's originals before the channels' copies of them
        block("pkr", collect_pkr, days)
    if "tg" in only and relay_tg:
        t0 = time.monotonic()
        try:
            relay, res = collect_relay(ctx, relay_tg)
            rc = (relay.get("checked") or {}).get("tg")
            if rc:
                checked["tg"] = rc
            if (relay.get("errors") or {}).get("tg"):
                errors["tg"] = trim("in the GitHub copy: " + str(relay["errors"]["tg"]), 300)
            stats = store.stats.get("tg") or {}
            extra = ", ".join(f"{k} {v}" for k, v in sorted(stats.items()) if k != "added")
            log(f"{'tg':<16} {res['status']:<8} {res['summary']}" + (f"; dropped: {extra}" if extra else "")
                + f" ({time.monotonic() - t0:.1f} s)")
        except (FetchError, ValueError) as e:
            errors["tg"] = trim(f"relay: {e}", 300)
            log(f"{'tg':<16} FAILED   relay: {trim(str(e), 200)}")
    if "tg" in only and not relay_tg:
        block("tg", collect_tg, days)
    if "notices" in only:
        if targets is None:
            log(f"{'notices':<16} skipped  no watch.json" if "notices" not in errors else
                f"{'notices':<16} FAILED   {errors['notices']}")
        else:
            n, lines, errs = collect_notices(ctx, targets)
            for tid, msg in errs.items():
                errors[f"notices:{tid}"] = msg
            if n:
                checked["notices"] = iso(now)
            log(f"{'notices':<16} {'ok' if n else 'cached':<8} " + ("; ".join(lines) if lines else "nothing due")
                + (f"; problems: {', '.join(errs)}" if errs else ""))

    store.prune(keep_days)
    forum_key = "pkr" if "pkr" in only else "tg"
    out = {
        "v": SCHEMA,
        "generated": iso(now),
        "mode": season_mode(now),
        "next_check": iso(next_due(src_state.get(forum_key) or {}, now, days)),
        "checked": {k: checked[k] for k in ALL_SOURCES if checked.get(k)},
        "errors": errors,
        "sources": sources_list(targets),
        "reports": newest_first(store.reports),
        "incidents": newest_first(store.incidents),
        "notices": store.notices,
    }
    data = dumps(out)
    write_atomic(out_path, data)
    state["v"] = SCHEMA
    state["index"], state["orig"] = store.state_index()
    try:
        write_atomic(state_path, dumps(state))
    except OSError as e:
        log(f"warning: {name}_state.json not written: {e}")
    hosts = ", ".join(f"{h} {n}" for h, n in sorted(getattr(http, "per_host", {}).items()))
    log(f"wrote {out_path}: {len(data) / 1024:.1f} KB, {len(out['reports'])} reports, {len(out['incidents'])} incidents, "
        f"{len(out['notices'])} notices; {getattr(http, 'count', '?')} requests ({hosts or 'none'}), "
        f"{time.monotonic() - t_run:.1f} s, errors: {', '.join(errors) or 'none'}")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Monitor of fresh angler reports for «Ладога · рыболовная карта»")
    ap.add_argument("--out", required=True, help="output directory (<name>.json, <name>_state.json)")
    ap.add_argument("--only", default="", help="comma-separated sources: " + ", ".join(ALL_SOURCES))
    ap.add_argument("--force", action="store_true", help="ignore the 3/5-day cadence and the notice intervals")
    ap.add_argument("--budget", type=float, default=240.0, help="total time budget in seconds (default 240)")
    ap.add_argument("--known", default="", help="site/data/points.json: records already on the map are not added")
    ap.add_argument("--relay-tg", default="", help="URL of tg.json made by the GitHub Action: merged instead of "
                                                   "reading Telegram (t.me does not answer from the VPS)")
    ap.add_argument("--since", default=DEFAULT_SINCE, help=f"oldest post date on a first run (default {DEFAULT_SINCE})")
    ap.add_argument("--name", default="reports", help="output name (default reports; the GitHub copy uses tg)")
    ap.add_argument("--keep-days", type=int, default=0, help="drop reports and incidents older than N days "
                                                             "(the GitHub copy: 120; default 0 = keep all)")
    ap.add_argument("--watch", default=None, help="watch.json with the official pages (default: next to this script)")
    args = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, ValueError):
        pass
    only = {x.strip() for x in args.only.split(",") if x.strip()} or None
    bad = (only or set()) - set(ALL_SOURCES)
    if bad:
        print(f"error: unknown source(s): {', '.join(sorted(bad))}", file=sys.stderr)
        return 2
    if not re.fullmatch(r"[\w.-]+", args.name):
        print("error: --name must be a plain file name", file=sys.stderr)
        return 2
    since = rx.parse_date_any(args.since)
    if not since:
        print(f"error: --since {args.since!r} is not a date", file=sys.stderr)
        return 2
    try:
        known = Known.load(args.known) if args.known else Known()
    except ValueError as e:
        print(f"error: --known: {e}", file=sys.stderr)
        return 2
    try:
        os.makedirs(args.out, exist_ok=True)
        lock = _lock(args.out, args.name)
    except LockBusy as e:
        print(f"skipped: {e}", file=sys.stderr)
        return 0  # the other run writes the file
    except OSError as e:
        print(f"error: cannot use {args.out}: {e}", file=sys.stderr)
        return 2
    try:
        run(args.out, name=args.name, force=args.force, only=only, budget=args.budget, known=known,
            relay_tg=args.relay_tg or None, since=since, keep_days=args.keep_days, watch_path=args.watch)
    except OSError as e:
        print(f"error: {args.name}.json not written: {e}", file=sys.stderr)
        return 1
    finally:
        lock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
