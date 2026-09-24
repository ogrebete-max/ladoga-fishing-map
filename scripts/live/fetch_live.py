#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Collector of live official/public data for «Ладога · рыболовная карта» (see README.md next to this file).

Runs hourly from a systemd timer on the site's VPS and writes ONE compact JSON file, live.json, that the web
app reads: the МЧС Ленобласти daily forecast (ice review on Lake Ladoga, storm forecast, water levels on the
posts) and weather warnings, the G-REALM satellite lake level with its anomaly and depth correction, the
open-lake water temperature (MUR SST) and the ice season by the NOAA IMS 4-km analysis. These are sources the
browser cannot fetch itself (no CORS, http only, Russian government sites).

Every block is collected independently: a failing source never breaks the others, and the last good value is
kept (with its own date) until a fresh one arrives. Official texts are copied as is (only whitespace is
normalised and long texts are trimmed), never paraphrased.

Python 3.8+ standard library only.

    fetch_live.py --out DIR [--force] [--only mchs,level,water_temp,ice_season] [--budget SECONDS] [--relay URL]

Writes DIR/live.json atomically (and DIR/live.prev.json, the previous version), keeps HTTP validators,
item ids and timings in DIR/state.json, logs one line per block to stdout. Exit code 0 whenever live.json
was written, even if some blocks failed.
"""
import argparse
import csv
import datetime as dt
import email.utils
import gzip
import http.client
import io
import json
import math
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from html.parser import HTMLParser

SCHEMA = 1
USER_AGENT = "ladoga-fishing-map/1.0 (+https://195.133.61.136/ladoga/)"
MSK = dt.timezone(dt.timedelta(hours=3))  # Moscow time, no DST since 2014

MCHS_RSS = "https://47.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/rss"
MCHS_LIST = "https://47.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya"
MCHS_SOURCE = "ГУ МЧС России по Ленинградской области по данным ФГБУ «Северо-Западное УГМС»"
GREALM_URL = "https://earth.gsfc.nasa.gov/gwm/timeseries/lake000396.10d.2.txt"
GREALM_PAGE = "https://earth.gsfc.nasa.gov/gwm/lake/000396"
METEONW_URL = "http://www.meteo.nw.ru/weather/lo_levelsd.php"  # https does not work there (TLS handshake breaks)
VOLGOBALT_URL = ("https://volgo-balt.ru/activity/putevaya-informatsiya/"
                 "konsultatsiya-ob-ozhidaemykh-glubinakh-s-uchetom-prognozov-urovney-po-opornym-postam/")
VOLGOBALT_SOURCE = "ФБУ «Администрация «Волго-Балт», консультация об ожидаемых уровнях и глубинах по опорным постам"
# Depths of the site's charts and depth model are counted from the mean long-term level +5.10 m БС (posts Сухо
# and Сторожно), so an absolute level in m БС gives the depth correction directly: level − 5.10.
CHART_DATUM_BS_M = 5.10
MUR_BASE = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41"
IMS_URL = "https://noaadata.apps.nsidc.org/NOAA/G02156/4km/{y}/ims{y}{doy:03d}_00UTC_4km_v1.3.asc.gz"
IMS_PAGE = "https://nsidc.org/data/g02156/versions/1"

# How often a block goes back to its source (seconds). The МЧС RSS is read on every run.
INTERVAL = {"mchs": 0, "level.grealm": 6 * 3600, "level.volgobalt": 12 * 3600, "level.meteonw": 3 * 3600,
            "water_temp": 6 * 3600, "ice_season": 20 * 3600}
RETRY_AFTER_FAIL = 45 * 60      # a failed block is tried again on the next hourly run
IMS_OFF_MONTHS = range(6, 11)   # June–October: no ice on Ladoga, IMS is skipped unless --force

# Carried-over МЧС sub-blocks are dropped when they get this old (days); the storm forecast lives until its end.
MAX_AGE_DAYS = {"ice_review": 30, "hydro": 14, "sentence": 14, "table": 14}
WARNING_KEEP_H = 48

RU_MONTHS = {"января": 1, "январь": 1, "февраля": 2, "февраль": 2, "марта": 3, "март": 3, "апреля": 4,
             "апрель": 4, "мая": 5, "май": 5, "июня": 6, "июнь": 6, "июля": 7, "июль": 7, "августа": 8,
             "август": 8, "сентября": 9, "сентябрь": 9, "октября": 10, "октябрь": 10, "ноября": 11,
             "ноябрь": 11, "декабря": 12, "декабрь": 12}
MONTH_RE = "(" + "|".join(sorted(RU_MONTHS, key=len, reverse=True)) + ")"

# Places named in МЧС ice reviews → label position on the map (lat, lon; a point on the water near the place).
ICE_PLACES = [
    ("osinovets", "Осиновецкий маяк", r"Осиновец", 60.120, 31.095),
    ("kobona", "Кобона", r"Кобон", 60.035, 31.535),
    ("syasskie_ryadki", "Сясьские Рядки", r"Сясьск\w*\s+Рядк", 60.168, 32.485),
    ("storozhno", "Сторожно, м. Стороженский", r"Сторожн|Стороженск", 60.538, 32.627),
    ("torpakovka", "банка Северная Торпаковка", r"Торпаков", 60.608, 32.568),
    ("svir_bay", "Свирская губа", r"Свирск\w*\s+губ", 60.560, 32.780),
    ("volkhov_bay", "Волховская губа", r"Волховск\w*\s+губ", 60.270, 32.380),
    ("petrokrepost_bay", "бухта Петрокрепость", r"бухт\w*\s+Петрокрепост", 60.025, 31.290),
    ("neva_source", "исток Невы", r"исток\w*\s+(?:р\.\s*)?Нев", 59.955, 31.040),
    ("shlisselburg", "Шлиссельбург", r"Шлиссельбург", 59.948, 31.028),
    ("novaya_ladoga", "Новая Ладога", r"Нов\w+\s+Ладог", 60.125, 32.295),
    ("krenitsy", "Креницы", r"Креницы|Крениц\b", 60.132, 32.290),
    ("sukho", "о. Сухо", r"\bСухо\b", 60.408, 32.088),
    ("ptinov", "о. Птинов", r"Птинов", 60.228, 32.090),
    ("svirica", "Свирица", r"Свириц", 60.478, 32.890),
    ("zagubye", "Загубье", r"Загубь", 60.442, 32.790),
    ("voronovo", "Вороново", r"Воронов[оа]\b", 60.275, 32.650),
    ("morye", "Морье", r"\bМорь[ея]\b", 60.176, 31.020),
    ("kokkorevo", "Коккорево", r"Коккорев", 60.072, 31.085),
    ("chernoe", "Чёрное", r"\bЧ[её]рно(?:е|го|м)\b", 60.135, 31.600),
    ("lavrovo", "Лаврово", r"Лаврово", 59.975, 31.490),
    ("karedzhi", "о. Кареджи", r"Кареджи", 60.118, 31.382),
    ("zelentsy", "о-ва Зеленцы", r"Зеленц", 59.995, 31.455),
]
_ICE_PLACE_RES = [(key, name, re.compile(rx, re.I), lat, lon) for key, name, rx, lat, lon in ICE_PLACES]

# MUR SST points inside the MUR lake mask (mask 5 = lake, 13 = lake with ice). South of ~60.15° N the mask
# treats the bays as land, so these are open-lake points: «открытое озеро».
MUR_POINTS = [
    ("volkhov", "Волховская губа, открытая часть", 60.20, 32.25),
    ("petrokrepost", "юго-запад, бухта Петрокрепость", 60.10, 31.30),
    ("svir", "вход в Свирскую губу", 60.60, 32.70),
]

# NOAA IMS 4-km cells per sector (points on water; checked on the 23.09.2026 grid: all are water, code 1).
IMS_SECTORS = [
    ("volkhov", "Волховская губа", [(60.20, 32.25), (60.18, 32.40), (60.22, 32.10), (60.26, 32.35),
                                    (60.16, 32.20), (60.24, 32.50)]),
    ("svir", "Свирская губа", [(60.55, 32.60), (60.58, 32.72), (60.52, 32.72), (60.62, 32.62),
                               (60.50, 32.80), (60.60, 32.85)]),
    ("petrokrepost", "бухта Петрокрепость", [(60.02, 31.20), (60.05, 31.30), (60.08, 31.15),
                                             (60.00, 31.35), (60.10, 31.25)]),
    ("south_open", "юг открытого озера", [(60.35, 31.70), (60.40, 31.40), (60.40, 32.00), (60.30, 31.50),
                                          (60.45, 31.70), (60.35, 32.20)]),
    ("center", "центр озера", [(60.90, 31.30), (61.00, 31.60), (60.80, 31.00), (60.85, 31.80)]),
]


# ----------------------------------------------------------------------------------------------- helpers

def now_msk():
    return dt.datetime.now(MSK).replace(microsecond=0)


def iso(t):
    if t is None:
        return None
    if isinstance(t, dt.datetime):
        return t.astimezone(MSK).isoformat(timespec="seconds")
    return t.isoformat()


def parse_dt(s):
    """ISO datetime or date string → aware datetime (dates are midnight Moscow time); None on failure."""
    if not s or not isinstance(s, str):
        return None
    try:
        if len(s) == 10:
            d = dt.date.fromisoformat(s)
            return dt.datetime(d.year, d.month, d.day, tzinfo=MSK)
        t = dt.datetime.fromisoformat(s)
        return t if t.tzinfo else t.replace(tzinfo=MSK)
    except ValueError:
        return None


_WS = re.compile(r"[ \t\r\f\v  -​  　]+")


def norm_ws(s):
    return _WS.sub(" ", s or "").strip()


def trim(s, limit):
    """Trim to limit characters at a word boundary, marking the cut with an ellipsis."""
    s = norm_ws(s)
    if len(s) <= limit:
        return s
    cut = s[: limit - 1]
    sp = cut.rfind(" ")
    if sp > limit * 0.6:
        cut = cut[:sp]
    return cut.rstrip(" ,;:–-") + "…"


def mkdt(y, mo, d, h=0, mi=0):
    try:
        base = dt.datetime(y, mo, d, tzinfo=MSK)
    except ValueError:
        return None
    return base + dt.timedelta(hours=h, minutes=mi)  # h may be 24


def ru_date(day, month_word, year):
    mo = RU_MONTHS.get(month_word.lower())
    if not mo:
        return None
    try:
        return dt.date(int(year), mo, int(day))
    except ValueError:
        return None


class _TextExtractor(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tbody",
             "thead", "tfoot", "ul", "ol", "section", "article", "header", "footer", "blockquote", "pre", "hr",
             "dt", "dd", "caption"}
    SKIP = {"script", "style", "noscript", "template", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_lines(markup):
    """HTML → non-empty whitespace-normalised lines; every paragraph and table cell is its own line."""
    p = _TextExtractor()
    p.feed(markup or "")
    p.close()
    return [x for x in (norm_ws(s) for s in "".join(p.parts).split("\n")) if x]


class _TableExtractor(HTMLParser):
    """All <table>s of a page as lists of rows of cell texts (nested tables are separate tables)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.stack, self.skip = [], [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag == "table":
            self.stack.append([])
        elif not self.stack:
            return
        elif tag == "tr":
            self.stack[-1].append([])
        elif tag in ("td", "th"):
            if not self.stack[-1]:
                self.stack[-1].append([])
            self.stack[-1][-1].append([])
        elif tag in ("p", "br", "div", "li"):
            self.handle_data(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        elif tag == "table" and self.stack:
            t = self.stack.pop()
            self.tables.append([[norm_ws("".join(c)) for c in row] for row in t])

    def handle_data(self, data):
        if not self.skip and self.stack and self.stack[-1] and self.stack[-1][-1]:
            self.stack[-1][-1][-1].append(data)


def html_tables(markup):
    p = _TableExtractor()
    p.feed(markup or "")
    p.close()
    return p.tables


# Abbreviations after which a period does not end a sentence (мыс, река, остров, город, посёлок, …).
_ABBR = {"м", "р", "о", "г", "п", "д", "ст", "оз", "пос", "дер", "им", "ул", "губ", "зал", "о-в", "о-ва",
         "м-ка", "м-к", "пгт", "т", "н", "с", "бух", "руч", "пр", "св"}
_SENT_END = re.compile(r"[.!?]\s+(?=[«\"(]?[А-ЯЁA-Z0-9])")


def split_sentences(text):
    out, start = [], 0
    for m in _SENT_END.finditer(text):
        before = text[start:m.start()]
        word = re.search(r"([\w-]+)$", before)
        if m.group(0)[0] == "." and word:
            w = word.group(1)
            prev_char = before[: -len(w)].rstrip()[-1:] if before[: -len(w)].strip() else ""
            if w.lower() in _ABBR and not prev_char.isdigit():
                continue
        out.append(text[start:m.start() + 1].strip())
        start = m.end()
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return [s for s in out if s]


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
    """Polite urllib client: ≤ 1 request/s per host, timeouts, retries with backoff, gzip, a total time budget,
    conditional GET (ETag / Last-Modified kept in state.json). TLS certificates are always verified."""

    BACKOFF = (3.0, 8.0, 15.0)

    def __init__(self, state, deadline, min_interval=1.1):
        self.validators = state.setdefault("http", {})
        self.deadline = deadline
        self.min_interval = min_interval
        self.last_start = {}
        self.count = 0
        ctx = ssl.create_default_context()  # verification ON; never disabled
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))

    def time_left(self):
        return self.deadline - time.monotonic()

    def get(self, url, timeout=20.0, retries=2, conditional=False, validate=None, max_bytes=16 << 20, cache=None):
        """GET with retries. conditional=True sends the stored ETag/Last-Modified (a 304 comes back as status 304);
        cache (default: conditional) stores the validators of a 200 answer for the next run."""
        cache = conditional if cache is None else cache
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
            if cache:
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


# ------------------------------------------------------------------------------------------ G-REALM level

_GREALM_COLS = {  # our name → words of the column description in the file header
    "mission": "Satellite mission name",
    "date": "Calendar year/month/day",
    "height": "Target height variation with respect to",
    "ice": "potential frozen surface",
    "egm": "EGM2008 datum",
    "src": "data source",
}
_GREALM_DEFAULT = {"mission": 1, "date": 3, "height": 6, "ice": 14, "egm": 15, "src": 16}


def grealm_columns(text):
    """Column numbers (1-based) from the 'Column N: …' lines of the header, so a layout change is noticed."""
    cols = {}
    for m in re.finditer(r"^Column\s+(\d+)\s*:\s*(.+)$", text, re.M):
        n, desc = int(m.group(1)), m.group(2)
        for key, words in _GREALM_COLS.items():
            if key not in cols and words.lower() in desc.lower():
                cols[key] = n
    missing = [k for k in ("date", "height") if k not in cols]
    if missing and re.search(r"^Column\s+\d+", text, re.M):
        raise ValueError(f"G-REALM header changed: no column for {missing}")
    return {**_GREALM_DEFAULT, **cols}


def parse_grealm(text, norm_years=(1993, 2020), series_n=12):
    cols = grealm_columns(text)
    ci = {k: v - 1 for k, v in cols.items()}
    need = max(ci["date"], ci["height"]) + 1
    rows = []
    for line in text.splitlines():
        p = line.split()
        if len(p) < need or not re.fullmatch(r"\d{8}", p[ci["date"]]) or p[ci["date"]] == "99999999":
            continue
        try:
            h = float(p[ci["height"]])
            d = dt.date(int(p[ci["date"]][:4]), int(p[ci["date"]][4:6]), int(p[ci["date"]][6:]))
        except ValueError:
            continue
        if h >= 999 or h <= -999:
            continue
        ice = len(p) > ci["ice"] and p[ci["ice"]] == "1"
        prelim = len(p) > ci["src"] and p[ci["src"]] == "1"
        egm = None
        if len(p) > ci["egm"]:
            try:
                egm = float(p[ci["egm"]])
            except ValueError:
                pass
            if egm is not None and abs(egm) >= 9999:
                egm = None
        rows.append((d, h, ice, p[ci["mission"]] if len(p) > ci["mission"] else "", prelim, egm))
    if len(rows) < 100:
        raise ValueError(f"G-REALM: only {len(rows)} valid rows")
    rows.sort(key=lambda r: r[0])
    by_month = {m: [] for m in range(1, 13)}
    for d, h, *_ in rows:
        if norm_years[0] <= d.year <= norm_years[1]:
            by_month[d.month].append(h)
    thin = [m for m, v in by_month.items() if len(v) < 10]
    if thin:
        raise ValueError(f"G-REALM: too few {norm_years[0]}–{norm_years[1]} values for months {thin}")
    # The ice flag of this product is seasonal (set for February–May every year), so ice-flagged values stay
    # in the norms: excluding them would leave no norm at all for February–May. They are flagged instead.
    norms = {m: sum(v) / len(v) for m, v in by_month.items()}
    longterm = sum(norms.values()) / 12
    d, h, ice, mission, prelim, egm = rows[-1]
    out = {
        "date": d.isoformat(),
        "height_m": round(h, 2),
        "mission": mission,
        "ice_flag": ice,
        "preliminary": prelim,
        "month_norm_m": round(norms[d.month], 2),
        "anomaly_m": round(h - norms[d.month], 2),
        "longterm_mean_m": round(longterm, 3),
        "depth_correction_m": round(h - longterm, 2),
        "norm_period": f"{norm_years[0]}–{norm_years[1]}",
        "series_fields": ["date", "height_m", "anomaly_m", "ice_flag"],
        "series": [[r[0].isoformat(), round(r[1], 2), round(r[1] - norms[r[0].month], 2), int(r[2])]
                   for r in rows[-series_n:]],
        "month_norms_m": [round(norms[m], 2) for m in range(1, 13)],
        "n_values": len(rows),
    }
    if egm is not None:
        out["height_egm2008_m"] = round(egm, 2)
    return out


# ------------------------------------------------------------------------------------------ МЧС: RSS

YANDEX_NS = "http://news.yandex.ru"


def rss_complete(body):
    return body.rstrip().endswith(b"</rss>")


def page_complete(body):
    return b"</article>" in body


def parse_rss(xml_bytes):
    if b"<!DOCTYPE" in xml_bytes[:2000] or b"<!ENTITY" in xml_bytes:
        raise ValueError("RSS with DOCTYPE/ENTITY refused")
    root = ET.fromstring(xml_bytes)
    items = []
    for it in root.iter("item"):
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate")
        try:
            published = email.utils.parsedate_to_datetime(pub).astimezone(MSK) if pub else None
        except (TypeError, ValueError, IndexError):
            published = None
        m = re.search(r"/(\d+)/?$", link)
        items.append({
            "id": int(m.group(1)) if m else None,
            "title": norm_ws(it.findtext("title")),
            "url": link,
            "published": published,
            "html": it.findtext(f"{{{YANDEX_NS}}}full-text") or it.findtext("description") or "",
        })
    return items


def classify(title):
    t = (title or "").upper()
    if "ПРОГНОЗ ЧС" in t or "ЕЖЕДНЕВНЫЙ ПРОГНОЗ" in t:
        return "forecast"
    if "ПРЕДУПРЕЖДЕНИЕ" in t:
        return "warning"
    return "other"


def extract_article(page_html):
    """Inner HTML of <article itemprop="articleBody"> or None when the page is truncated."""
    m = re.search(r"<article[^>]*articleBody[^>]*>(.*?)</article>", page_html or "", re.S | re.I)
    return m.group(1) if m else None


def parse_page_meta(page_html):
    title = re.search(r"<h1[^>]*>(.*?)</h1>", page_html or "", re.S)
    pub = re.search(r"itemprop=\"datePublished\"[^>]*content=\"(\d{4}-\d\d-\d\d)[ T](\d\d):(\d\d)", page_html or "")
    published = None
    if pub:
        d = dt.date.fromisoformat(pub.group(1))
        published = mkdt(d.year, d.month, d.day, int(pub.group(2)), int(pub.group(3)))
    return {"title": norm_ws(re.sub(r"<[^>]+>", "", title.group(1))) if title else "", "published": published}


def forecast_target_date(title, published=None):
    m = re.search(r"на\s+(\d{1,2})\s+" + MONTH_RE + r"\s+(\d{4})", title or "", re.I)
    if m:
        return ru_date(m.group(1), m.group(2), m.group(3))
    m = re.search(r"на\s+(\d{1,2})\s+" + MONTH_RE, title or "", re.I)
    if m and published:
        return ru_date(m.group(1), m.group(2), published.year)
    return None


# ------------------------------------------------------------------------------------ МЧС: daily forecast

HYDRO_RE = re.compile(r"^\s*3\s*\.\s*Гидрологическая\s+обстановка\s*:?\s*(.*)$", re.I)
NEXT_SECTION_RE = re.compile(r"^\s*[4-9]\s*\.\s*[А-ЯЁ]")
TABLE_RE = re.compile(r"Сведения\s+об\s+уровнях\s+воды", re.I)
ICE_ANY_RE = re.compile(r"ОБЗОР\s+ЛЕДОВОЙ\s+ОБСТАНОВКИ", re.I)
STORM_RE = re.compile(r"^\s*ШТОРМ\s*[-‑–—]?\s*ПРОГНОЗ", re.I)
STOP_RES = (NEXT_SECTION_RE, TABLE_RE, ICE_ANY_RE, STORM_RE)
BOILER_RE = re.compile(r"имеются\s+\d+\s+стационарн\w*\s+гидро\w*\s+пост\w*[^.]*\.?", re.I)
HYDRO_KEYS = re.compile(r"Ладож|\bНев(?:а|ы|е|у|ой)\b|Волхов|Свир|Сяс|Петрокрепост|Шлиссельбург|Новоладож|"
                        r"Староладож|Н\.Л\.К|С\.Л\.К", re.I)


def forecast_complete(lines):
    """A forecast text is complete when a numbered section (4.–9.) follows the hydrology section."""
    start = next((i for i, ln in enumerate(lines) if HYDRO_RE.match(ln)), None)
    if start is None and not any(re.search(r"Метеорологическая\s+обстановка", ln, re.I) for ln in lines):
        return False
    return any(NEXT_SECTION_RE.match(ln) for ln in lines[(start or 0) + 1:])


def _cut_block(lines, start):
    out = [lines[start]]
    for ln in lines[start + 1:]:
        if any(r.search(ln) for r in STOP_RES):
            break
        out.append(ln)
    return out


def parse_forecast(lines, year):
    """Sub-blocks of an «Оперативный ежедневный прогноз ЧС»: hydrology sentences about Ladoga, the level
    sentence, the table of posts, the Ladoga ice review and the storm forecast. Missing parts are None."""
    h0 = next((i for i, ln in enumerate(lines) if HYDRO_RE.match(ln)), None)
    if h0 is not None:
        h1 = next((i for i in range(h0 + 1, len(lines)) if NEXT_SECTION_RE.match(lines[i])), len(lines))
        region = list(range(h0 + 1, h1))
        head_rest = HYDRO_RE.match(lines[h0]).group(1)
    else:
        region, head_rest = [], ""
    used = set()
    blocks = {}
    for i, ln in enumerate(lines):
        kind = None
        if TABLE_RE.search(ln):
            kind = "table"
        elif ICE_ANY_RE.search(ln):
            kind = "ice" if re.search(r"ЛАДОЖ", ln, re.I) else "ice_other"
        elif STORM_RE.search(ln):
            kind = "storm"
        if kind and kind not in blocks:
            blk = _cut_block(lines, i)
            blocks[kind] = blk
            used.update(range(i, i + len(blk)))
    free = [head_rest] + [lines[i] for i in region if i not in used]
    hydro = select_hydro_sentences(free)
    level = parse_level_sentences(hydro)
    table = parse_level_table(blocks["table"], year) if "table" in blocks else None
    if table:  # rivers outside the Ladoga basin and the map's area stay out of live.json
        table["posts"] = [p for p in table["posts"] if not TABLE_SKIP.match(p["post"])]
    return {
        "hydro": hydro or None,
        "sentence": level,
        "table": table if table and table["posts"] else None,
        "ice_review": parse_ice_review(blocks["ice"], year) if "ice" in blocks else None,
        "storm": parse_storm(blocks["storm"], year) if "storm" in blocks else None,
    }


def select_hydro_sentences(lines):
    text = BOILER_RE.sub(" ", " ".join(x for x in lines if x))
    out, prev_kept = [], False
    for s in split_sentences(norm_ws(text)):
        if len(s) < 8:
            continue
        if HYDRO_KEYS.search(s) or (prev_kept and re.search(r"уров|лед|вскрыт|ледостав|ледоход", s, re.I)):
            out.append(s)
            prev_kept = True
        else:
            prev_kept = False
    return out


LEVEL_SENT_RE = re.compile(
    r"Уровень\s+(?:воды\s+)?(?:(?:р\.|реки|оз\.|озера)\s*)?(?P<river>[А-ЯЁ][\w.]*)"
    r"\s*[–—-]\s*(?:(?:ст\.|пост|г\.|д\.|п\.|пгт\.?)\s*)?(?P<post>[А-ЯЁ][\w.]*(?:[\s-][А-ЯЁ][\w.]*)*)"
    r"\s*[–—-]\s*(?P<cm>[-−]?\d+)\s*см(?P<bs>\s*БС)?")
MARK_RE = re.compile(r"(?P<rel>ниже|выше)\s+(?P<mark>неблагоприятн\w*|опасн\w*)\s+(?:отметк\w*|уровн\w*)\s*"
                     r"(?P<cm>[-−]?\d+)\s*см", re.I)


def parse_level_sentences(sentences):
    """«Уровень р. Нева – ст. Петрокрепость – 328 см БС, ниже неблагоприятной отметки 330 см БС…»."""
    items, outlook = [], []
    for s in sentences or []:
        m = LEVEL_SENT_RE.search(s)
        if not m:
            if re.search(r"уров", s, re.I):
                outlook.append(s)
            continue
        it = {"post": f"{m.group('river')} – {m.group('post')}", "cm": int(m.group("cm").replace("−", "-")),
              "bs": bool(m.group("bs"))}
        mk = MARK_RE.search(s)
        if mk:
            it.update(relation=mk.group("rel").lower(), mark=mk.group("mark").lower(),
                      mark_cm=int(mk.group("cm").replace("−", "-")))
        items.append((it, s))
    if not items:
        return None
    out = {"text": " ".join(s for _, s in items), "items": [it for it, _ in items]}
    if outlook:
        out["outlook"] = outlook
    return out


_VALUE_RE = re.compile(r"^(?:[-+−]?\d+(?:[.,]\d+)?\*?|[-–—])$")
_POST_RE = re.compile(r"^[А-ЯЁа-яё][А-ЯЁа-яё.\s]*?\s*-\s*[А-ЯЁа-яё][А-ЯЁа-яё.\s]*\*?$")
_ROW_RE = re.compile(r"^(?P<name>[А-ЯЁа-яё][А-ЯЁа-яё.\s]*?-\s*[А-ЯЁа-яё][А-ЯЁа-яё.\s]*?)\s+"
                     r"(?P<vals>(?:[-+−]?\d+(?:[.,]\d+)?\*?|[-–—])(?:\s+(?:[-+−]?\d+(?:[.,]\d+)?\*?|[-–—]))+)"
                     r"\s*(?P<ice>.*)$")
_TABLE_COLS = [("zero_m_bs", r"Отметк"), ("level_cm", r"Уровень"), ("change_cm", r"Изменени"),
               ("norm_cm", r"Норма"), ("unfav_cm", r"Неблагоприятн"), ("danger_cm", r"Опасн"),
               ("ice", r"Ледов")]
LAKE_POSTS = re.compile(r"Петрокрепост|Свириц|Сясьские\s+Рядки", re.I)
TABLE_SKIP = re.compile(r"^(?:Луга|Оредеж|Нарва|Тосна|Ижора|Мга|Славянка)\s*-", re.I)


def _num(s):
    s = (s or "").strip().replace("−", "-").rstrip("*").replace(",", ".")
    if s in ("", "-", "–", "—"):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return int(v) if v.is_integer() and "." not in s else v


def parse_level_table(lines, year=None):
    """«Сведения об уровнях воды (в см над «0» поста)…»: one cell per line (the page uses a <p> per cell) or
    one row per line («Нева-Петрокрепость 0 398 3 434 - - разводья»)."""
    title = lines[0]
    t = None
    m = re.search(r"на\s+(\d{1,2})\s*час\w*\s*(?:утра\s*)?(\d{1,2})\.(\d{1,2})\.(\d{4})", title)
    if m:
        t = mkdt(int(m.group(4)), int(m.group(3)), int(m.group(2)), int(m.group(1)))
    body = lines[1:]
    start = None
    for i, ln in enumerate(body):
        nxt = body[i + 1] if i + 1 < len(body) else ""
        if (_POST_RE.match(ln) and _VALUE_RE.match(nxt)) or _ROW_RE.match(ln):
            start = i
            break
    if start is None:
        return None
    header = " ".join(body[:start])
    present = [(k, header.find(re.search(rx, header, re.I).group(0)))
               for k, rx in _TABLE_COLS if re.search(rx, header, re.I)]
    cols = [k for k, _ in sorted(present, key=lambda x: x[1])] or [k for k, _ in _TABLE_COLS]
    value_cols = [c for c in cols if c != "ice"]
    rows, cur = [], None
    rest = body[start:]
    for i, ln in enumerate(rest):
        rm = _ROW_RE.match(ln)
        nxt = rest[i + 1] if i + 1 < len(rest) else ""
        if rm and not _VALUE_RE.match(nxt):
            rows.append([rm.group("name")] + rm.group("vals").split() + ([rm.group("ice")] if rm.group("ice") else []))
            cur = None
        elif _POST_RE.match(ln) and _VALUE_RE.match(nxt):
            cur = [ln]
            rows.append(cur)
        elif cur is not None:
            cur.append(ln)
    posts = []
    for cells in rows:
        name = norm_ws(cells[0].rstrip("*"))
        vals, k = cells[1:], 0
        row = {"post": name}
        est = False
        for c in value_cols:
            if k < len(vals) and _VALUE_RE.match(vals[k]):
                est = est or vals[k].endswith("*")
                v = _num(vals[k])
                if v is not None:
                    row[c] = v
                k += 1
        ice = norm_ws(" ".join(vals[k:])).rstrip(";").strip()
        if ice and not re.fullmatch(r"нет\s+св\.?(?:едений)?", ice, re.I):
            row["ice"] = ice
        if est:
            row["est"] = True
        if LAKE_POSTS.search(name):
            row["lake"] = True
        posts.append(row)
    if not posts:
        return None
    return {"time": iso(t), "posts": posts}


def _clauses(text):
    """Sentences split further at «;» (the separator stays with its clause, so clauses join back as is)."""
    for sent in split_sentences(text):
        parts = [p.strip() for p in sent.split(";")]
        for k, c in enumerate(parts):
            if c:
                yield c + (";" if k < len(parts) - 1 else "")


_CM_RE = re.compile(r"(\d+)(?:\s*[-–—]\s*(\d+))?\s*см\b")
# A clause without a place name still describes the place of the previous clause only when it reads so
# («Местами лед трубчатый. На льду местами вода.»); «На юго-востоке…», «Снег на льду…» are lake-wide.
_CONTINUES_RE = re.compile(r"^(?:местами|на\s+льду|лед|лёд|толщина|здесь|там\s+же|у\s+берега|вдоль\s+берега|"
                           r"ближе\s+к\s+берегу|на\s+расстоянии|мористее\s+припая)\b", re.I)


def _thickness(clause):
    """Ice thickness values of a clause that speaks of «толщина»; «вода на льду до 10 см», snow and
    «на расстоянии 200 м» are not thickness."""
    if not re.search(r"толщин", clause, re.I):
        return []
    out, last = [], 0
    for m in _CM_RE.finditer(clause):
        seg = clause[last:m.start()]
        last = m.end()
        if re.search(r"вод|снег", seg, re.I) and not re.search(r"толщин", seg, re.I):
            continue
        a = int(m.group(1))
        b = int(m.group(2) or a)
        v = {"min": min(a, b), "max": max(a, b)}
        at = re.search(r"на\s+расстоянии\s+(\d+\s*(?:км|м))\s+от\s+берега", seg)
        if at:
            v["at"] = at.group(1) + " от берега"
        out.append((m.start(), v))
    return out


def parse_ice_review(lines, year=None):
    """«ОБЗОР ЛЕДОВОЙ ОБСТАНОВКИ НА ЛАДОЖСКОМ ОЗЕРЕ»: the text as is, the forecast part, and place → ice
    thickness pairs with map positions from ICE_PLACES."""
    body = lines[1:]
    obs, fc = [], []
    target = obs
    for ln in body:
        if re.match(r"^Прогноз\b", ln, re.I):
            target = fc
        target.append(ln)
    places, order = {}, []

    def entry(key):
        if key not in places:
            _, name, _, lat, lon = next(p for p in _ICE_PLACE_RES if p[0] == key)
            places[key] = {"id": key, "name": name, "lat": lat, "lon": lon, "cm": [], "text": []}
            order.append(key)
        return places[key]

    def add_text(e, n, clause):
        if not e["text"] or e["text"][-1][0] != n:
            e["text"].append((n, clause))

    n = 0
    for para in obs:
        cur = None
        n += 1  # clauses of different paragraphs are never adjacent
        for clause in _clauses(para):
            n += 1
            found = sorted({(m.start(), key) for key, _, rx, _, _ in _ICE_PLACE_RES for m in rx.finditer(clause)})
            seen, uniq = set(), []
            for pos, key in found:
                if key not in seen:
                    seen.add(key)
                    uniq.append((pos, key))
            vals = _thickness(clause)
            if uniq:
                for _, key in uniq:
                    add_text(entry(key), n, clause)
                for vpos, v in vals:
                    before = [k for p, k in uniq if p <= vpos]
                    entry(before[-1] if before else uniq[0][1])["cm"].append(v)
                cur = uniq[-1][1]
            elif cur and _CONTINUES_RE.match(clause):
                e = entry(cur)
                add_text(e, n, clause)
                e["cm"].extend(v for _, v in vals)
            else:
                cur = None
    out_places = []
    for key in order:
        e = places[key]
        parts, last = [], None
        for k, clause in e["text"]:  # adjacent clauses join as in the source, gaps are marked with «…»
            parts.append(clause if last is None else (" " if k == last + 1 else " … ") + clause)
            last = k
        e["text"] = trim("".join(parts), 220)
        if e["cm"]:
            e["label"] = " / ".join(f"{v['min']}–{v['max']}" if v["min"] != v["max"] else f"{v['min']}"
                                    for v in e["cm"]) + " см"
        else:
            del e["cm"]
        out_places.append(e)
    text = "\n".join(obs)
    res = {"text": trim(text, 2200), "places": out_places}
    if fc:
        res["forecast"] = trim("\n".join(fc), 700)
    m = re.search(r"береговых\s+наблюдений\s+(\d{1,2})\s+" + MONTH_RE, text, re.I)
    if m and year:
        res["obs_date"] = iso(ru_date(m.group(1), m.group(2), year))
    m = re.search(r"ИСЗ\s+(?:от\s+)?(\d{1,2})\s+" + MONTH_RE, text, re.I)
    if m and year:
        res["sat_date"] = iso(ru_date(m.group(1), m.group(2), year))
    m = re.search(r"Покрытость\s+(?:льдом\s+)?(?:акватории\s+)?озера\s+(?:льдом\s+)?составляет\s+"
                  r"(?:около\s+|примерно\s+)?(\d+)\s*%", text, re.I)
    if m:
        res["cover_pct"] = int(m.group(1))
    return res


_STORM_TITLE_RE = re.compile(
    r"(?:от\s+)?(\d{1,2})[:.](\d{2})\s+(\d{1,2})\s+" + MONTH_RE + r"\s*(\d{4})?\s*(?:г\.?)?\s*"
    r"до\s+(\d{1,2})[:.](\d{2})\s+(\d{1,2})\s+" + MONTH_RE + r"\s*(\d{4})?", re.I)
_STORM_FIELDS = [("wind", r"Ветер"), ("waves", r"Высота\s+волн"), ("precip", r"Осадки(?:\s*,\s*явления)?|Явления"),
                 ("visibility", r"Видимость"), ("air_temp", r"Температура\s+воздуха"),
                 ("water_temp", r"Температура\s+воды"), ("ice", r"Ледовая\s+обстановка|Лед")]


def parse_storm(lines, year=None):
    """«ШТОРМ-ПРОГНОЗ от 21:00 13 марта 2026 г. до 21:00 14 марта 2026 г.» + wind, waves by lake district,
    precipitation, visibility, air temperature — each value as is."""
    title = lines[0]
    # «от 21:00 13 марта 2026 г. до 21:00 14 марта 2026 г.» as is
    res = {"valid": STORM_RE.sub("", title, count=1).lstrip(" :.-–—").strip()}
    m = _STORM_TITLE_RE.search(title)
    if m:
        y1 = int(m.group(5) or year or 0)
        y2 = int(m.group(10) or m.group(5) or year or 0)
        if y1 and y2:
            f = mkdt(y1, RU_MONTHS[m.group(4).lower()], int(m.group(3)), int(m.group(1)), int(m.group(2)))
            t = mkdt(y2, RU_MONTHS[m.group(9).lower()], int(m.group(8)), int(m.group(6)), int(m.group(7)))
            res["valid_from"], res["valid_to"] = iso(f), iso(t)
    fields, waves = {}, {}
    cur = None
    for ln in lines[1:]:
        dm = re.match(r"^(\d)\s*район\s*:?\s*(.*)$", ln)
        if dm:
            cur = ("w", dm.group(1))
            if dm.group(2):
                waves[dm.group(1)] = dm.group(2)
            continue
        hit = None
        for key, rx in _STORM_FIELDS:
            fm = re.match(r"^(?:" + rx + r")\s*:\s*(.*)$", ln, re.I)
            if fm:
                hit = (key, fm.group(1))
                break
        if hit:
            cur = ("f", hit[0])
            if hit[1]:
                fields[hit[0]] = hit[1]
            continue
        if cur and cur[0] == "w":
            waves[cur[1]] = norm_ws((waves.get(cur[1], "") + " " + ln))
        elif cur:
            fields[cur[1]] = norm_ws(fields.get(cur[1], "") + " " + ln)
    for key in ("wind", "precip", "visibility", "air_temp", "water_temp", "ice"):
        if fields.get(key):
            res[key] = fields[key]
    if waves:
        res["waves"] = waves
    elif fields.get("waves"):
        res["waves"] = {"": fields["waves"]}
    wind = fields.get("wind", "")
    wm = re.search(r"(\d+)\s*[-–]\s*(\d+)\s*м/с", wind)
    if wm:
        res["wind_ms"] = [int(wm.group(1)), int(wm.group(2))]
    gm = re.search(r"порыв\w*\s*(?:до\s*)?(\d+)(?:\s*[-–]\s*(\d+))?\s*м/с", wind)
    if gm:
        res["gusts_ms"] = [int(gm.group(1)), int(gm.group(2) or gm.group(1))]
    res["text"] = trim("\n".join(lines[1:]), 700)  # the whole block as is; the fields above are its pieces
    return res


# ------------------------------------------------------------------------------------------ МЧС: warnings

_FROM_RE = re.compile(r"(?:начиная\s+)?с\s+(\d{1,2})(?:\s*[-–—]\s*\d{1,2})?\s*час\w*\s+(\d{1,2})\.(\d{1,2})", re.I)
_TO_RE = re.compile(r"до\s+(\d{1,2})\s*час\w*\s+(\d{1,2})\.(\d{1,2})", re.I)
_PERIOD_RE = re.compile(r"с\s+(\d{1,2})\s+до\s+(\d{1,2})\s*час\w*\s+(\d{1,2})\.(\d{1,2})", re.I)
_DAYS_RE = re.compile(r"(\d{1,2})(?:\s*(?:[-–—]|по|и)\s*(\d{1,2}))?\s+" + MONTH_RE, re.I)  # 21-22 / с 25 по 27
_NUMDATE_RE = re.compile(r"(?<![\d.])(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?![\d])")


def parse_validity(head, conseq, published):
    """Validity window of a warning from its wording: «Начиная с 21-24 часов 21.09 …», «С 21 часа 13.03
    до 21 часа 14.03», «22 сентября ночью и утром …», «21-22 сентября повышается вероятность …»."""
    if not published:
        return None, None
    year = published.year

    def yr(mo):
        if published.month == 12 and mo == 1:
            return year + 1
        if published.month == 1 and mo == 12:
            return year - 1
        return year

    # the issue date of the УГМС message («… от 21.09.2026:») is not a validity date
    body = re.sub(r"^.*?\bот\s+\d{1,2}\.\d{1,2}\.\d{4}\s*:?", " ", head, count=1, flags=re.S)
    frm = to = None
    m = _PERIOD_RE.search(body)
    if m:
        mo = int(m.group(4))
        frm = mkdt(yr(mo), mo, int(m.group(3)), int(m.group(1)))
        to = mkdt(yr(mo), mo, int(m.group(3)), int(m.group(2)))
    else:
        m = _FROM_RE.search(body)
        if m:
            mo = int(m.group(3))
            frm = mkdt(yr(mo), mo, int(m.group(2)), int(m.group(1)))
        m = _TO_RE.search(body)
        if m:
            mo = int(m.group(3))
            to = mkdt(yr(mo), mo, int(m.group(2)), int(m.group(1)))
    days = []
    for m in _DAYS_RE.finditer(body + " " + (conseq or "")):
        mo = RU_MONTHS[m.group(3).lower()]
        for d in (m.group(1), m.group(2)):
            if d:
                try:
                    days.append(dt.date(yr(mo), mo, int(d)))
                except ValueError:
                    pass
    for m in _NUMDATE_RE.finditer(body):
        mo = int(m.group(2))
        if 1 <= mo <= 12:
            try:
                days.append(dt.date(int(m.group(3) or yr(mo)), mo, int(m.group(1))))
            except ValueError:
                pass
    days = [d for d in days if abs((d - published.date()).days) <= 10]
    if frm is None and days:
        d = min(days)
        frm = mkdt(d.year, d.month, d.day)
    if to is None and days:
        d = max(days)
        to = mkdt(d.year, d.month, d.day, 24)
    if frm and to and to <= frm:
        to = None
    return frm, to


def parse_warning(item, lines):
    title = item.get("title") or ""
    level = "emergency" if title.upper().startswith("ЭКСТРЕННОЕ") else "warning"
    head, conseq = [], []
    target = head
    for ln in lines:
        if re.match(r"^В\s+связи\s+со?\s+сложившейся", ln, re.I):
            target = conseq
            continue
        if re.match(r"^РЕКОМЕНДАЦИИ", ln, re.I):
            break
        target.append(ln)
    text = trim(" ".join(head) if head else " ".join(lines), 450)
    # the consequence list is boilerplate («… происшествий на акваториях …»); only an ice line is kept, e.g.
    # «повышается вероятность отрыва прибрежных льдин с находящимися на них людьми»
    ice = [ln for ln in conseq if re.search(r"льдин|отрыв|провал\w*\s+(?:людей|под\s+л)|\bлед|\bлёд|\bльд", ln, re.I)]
    frm, to = parse_validity(" ".join(head), " ".join(conseq), item.get("published"))
    # every title ends with «НА ТЕРРИТОРИИ ЛЕНИНГРАДСКОЙ ОБЛАСТИ»: the tail is dropped, the rest is as is
    short = re.sub(r"\s+НА\s+ТЕРРИТОРИИ\s+ЛЕНИНГРАДСКОЙ\s+ОБЛАСТИ\s*$", "", title, flags=re.I)
    w = {"id": item.get("id"), "level": level, "title": short, "published": iso(item.get("published")),
         "text": text, "valid_from": iso(frm), "valid_to": iso(to), "url": item.get("url")}
    if ice:
        w["ice"] = trim(" ".join(ice), max(120, 600 - len(text)))
    return w


def warning_active(w, now):
    pub = parse_dt(w.get("published"))
    to = parse_dt(w.get("valid_to"))
    if to and to > now:
        return True
    return bool(pub and now - pub <= dt.timedelta(hours=WARNING_KEEP_H))


# ------------------------------------------------------------------------------------ MUR water temperature

def mur_url(lat, lon):
    dims = f"[last-7:7:last][({lat})][({lon})]"
    q = ",".join(v + dims for v in ("analysed_sst", "sea_ice_fraction", "mask"))
    return MUR_BASE + ".csv?" + urllib.parse.quote(q, safe="(),:.-")


def _f(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) else v


def parse_mur_csv(text):
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 3 or "analysed_sst" not in rows[0]:
        raise ValueError("unexpected ERDDAP answer: " + trim(text, 120))
    idx = {name: i for i, name in enumerate(rows[0])}
    out = []
    for r in rows[2:]:
        if len(r) < len(rows[0]):
            continue
        mask = _f(r[idx["mask"]]) if "mask" in idx else None
        out.append({"date": r[idx["time"]][:10], "sst": _f(r[idx["analysed_sst"]]),
                    "ice": _f(r[idx["sea_ice_fraction"]]) if "sea_ice_fraction" in idx else None,
                    "mask": int(mask) if mask is not None else None})
    if not out:
        raise ValueError("ERDDAP answer without data rows")
    return out


def mur_value(r):
    """(under_ice, temp_c). Under ice MUR relaxes to −1.8 °C (a sea-water convention): report «под льдом»."""
    if r is None or r["sst"] is None:
        return None, None
    if r["sst"] <= -0.5 or (r["ice"] is not None and r["ice"] >= 0.15):
        return True, None
    return False, round(max(r["sst"], 0.0), 1)


def mur_point(rows, pid, name, lat, lon):
    latest, prev = rows[-1], (rows[0] if len(rows) > 1 else None)
    under, temp = mur_value(latest)
    p = {"id": pid, "name": name, "lat": lat, "lon": lon, "date": latest["date"],
         "temp_c": temp, "under_ice": under}
    if latest["mask"] not in (5, 13):
        p["outside_lake_mask"] = True
    if latest["ice"] is not None:
        p["ice_fraction"] = round(latest["ice"], 2)
    if prev is not None:
        pu, pt = mur_value(prev)
        p["prev_date"], p["prev_c"], p["prev_under_ice"] = prev["date"], pt, pu
        if temp is not None and pt is not None:
            p["change_c"] = round(temp - pt, 1)
    return p


# ---------------------------------------------------------------------------------------- meteo.nw.ru

_METEONW_MARKER_RE = re.compile(
    r"\{[^{}]*?'abbr'\s*:\s*'(?P<abbr>[^']*)'[^{}]*?'latitude'\s*:\s*(?P<lat>-?[\d.]+)[^{}]*?"
    r"'longitude'\s*:\s*(?P<lon>-?[\d.]+)[^{}]*?'bubble'\s*:\s*'(?P<bubble>[^']*)'", re.S)


def parse_meteonw(text):
    posts = []
    for m in _METEONW_MARKER_RE.finditer(text):
        b = m.group("bubble")
        name = re.search(r"<b>(.*?)</b>", b)
        lvl = re.search(r"уровень:\s*<i>\s*(-?\d+)\s*</i>", b)
        if not (name and lvl):
            continue
        posts.append([norm_ws(name.group(1)), int(lvl.group(1))])
    if not posts:
        raise ValueError("no level markers on the page")
    flat = " ".join(html_to_lines(text))
    tm = re.search(r"Фактический\s+уровень\s+воды\s+за\s+(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2})\s*МСК", flat)
    t = mkdt(int(tm.group(3)), int(tm.group(2)), int(tm.group(1)), int(tm.group(4))) if tm else None
    res = {"time": iso(t), "posts_fields": ["name", "cm"], "posts": posts}
    pk = next((p for p in posts if re.search(r"Петрокрепост", p[0], re.I)), None)
    if pk:
        res["petrokrepost_cm"] = pk[1]
    return res


# ---------------------------------------------------------------------------------- Волго-Балт levels

VB_POSTS = [("syasskie_ryadki", r"^Ся\w*\s+Рядк", "Сясьские Рядки", True),  # the site writes «Сяськие Рядки»
            ("svirica", r"^Свириц", "Свирица", True),
            ("shlisselburg", r"^Шлиссельбург", "Шлиссельбург", False)]
# Only the Ladoga part of the consultation goes to live.json (not Белозерск, Череповец, Новгород, …).
VB_DEPTHS_KEEP = re.compile(r"Шлиссельбург|Свириц|Ладога\s*-\s*Устье", re.I)
ROMAN = ("I", "II", "III")


def _dec(s):
    v = _num(s)
    return float(v) if v is not None else None


def parse_volgobalt(markup, today):
    """«Консультация об ожидаемых уровнях и глубинах по опорным постам на <месяц> <год>»: levels in m БС and
    depths in cm for the I, II and III decade of the month; picks the decade of `today`."""
    tables = html_tables(markup)
    table = next((t for t in tables if re.search(r"ожидаемых\s+уровнях", " ".join(" ".join(r) for r in t), re.I)),
                 None)
    if table is None:
        raise ValueError("no consultation table on the page")
    text = " ".join(" ".join(c for c in r if c) for r in table)
    m = re.search(r"на\s+" + MONTH_RE + r"\s*(\d{4})", text, re.I)
    if not m:
        raise ValueError("consultation period not found")
    month, year = RU_MONTHS[m.group(1).lower()], int(m.group(2))
    last = (dt.date(year + (month == 12), month % 12 + 1, 1) - dt.timedelta(days=1)).day
    decades = [(dt.date(year, month, a), dt.date(year, month, b)) for a, b in ((1, 10), (11, 20), (21, last))]
    section, posts, depths, notes = None, [], [], []
    for row in table:
        cells = [c for c in row if c]
        if not cells:
            continue
        joined = " ".join(cells)
        if re.match(r"^А\s*\.\s*Уровни", joined, re.I):
            section = "levels"
            continue
        if re.match(r"^Б\s*\.\s*Глубины", joined, re.I):
            section = "depths"
            continue
        nums = [_dec(c) for c in cells[1:]]
        if len(cells) >= 3 and _dec(cells[0]) is None and all(v is not None for v in nums):
            vals = nums[1:4]
            if section == "levels":
                p = {"name": cells[0], "project_level_bs_m": nums[0], "values_bs_m": vals}
                for pid, rx, canon, lake in VB_POSTS:
                    if re.search(rx, cells[0], re.I):
                        p.update(id=pid, name=canon)
                        if canon != cells[0]:
                            p["name_src"] = cells[0]
                        if lake:
                            p["lake"] = True
                        posts.append(p)
                        break
            elif section == "depths" and VB_DEPTHS_KEEP.search(cells[0]):
                depths.append({"name": cells[0], "guaranteed_cm": int(nums[0]), "values_cm": [int(v) for v in vals]})
        elif section and len(cells) == 1 and len(joined) > 20:
            notes.append(joined)
    if not posts:
        raise ValueError("no level rows in the consultation")
    vb = {"title": f"Консультация об ожидаемых уровнях и глубинах по опорным постам на "
                   f"{m.group(1).lower()} {year} года",
          "period": f"{year}-{month:02d}", "decades": [[a.isoformat(), b.isoformat()] for a, b in decades],
          "posts": posts, "depths": depths, "notes": notes}
    vb.update(volgobalt_pick_decade(vb, today))
    return vb


def volgobalt_pick_decade(vb, today):
    """The decade of `today` within the consultation month (I: 1–10, II: 11–20, III: 21–end): its values become
    level_bs_m / expected_cm. A consultation for a later month uses its first decade, an old one its last."""
    y, mth = (int(x) for x in vb["period"].split("-"))
    if (y, mth) == (today.year, today.month):
        idx, status = (0 if today.day <= 10 else 1 if today.day <= 20 else 2), "current"
    elif (y, mth) > (today.year, today.month):
        idx, status = 0, "ahead"
    else:
        idx, status = 2, "past"
    posts = [dict(p, level_bs_m=p["values_bs_m"][min(idx, len(p["values_bs_m"]) - 1)]) for p in vb["posts"]]
    depths = [dict(d, expected_cm=d["values_cm"][min(idx, len(d["values_cm"]) - 1)]) for d in vb["depths"]]
    return {"period_status": status, "decade": idx + 1, "decade_from": vb["decades"][idx][0],
            "decade_to": vb["decades"][idx][1], "posts": posts, "depths": depths}


def volgobalt_depth_correction(vb, today):
    """level − 5.10 m БС at Сясьские Рядки (or Свирица) for the current decade; None if the consultation is
    older than two weeks after its month."""
    if not vb or not vb.get("posts"):
        return None
    end = parse_dt((vb.get("decades") or [[None, None]])[-1][1])
    if vb.get("period_status") == "past" and (not end or (today - end.date()).days > 15):
        return None
    post = next((p for p in vb["posts"] if p.get("id") == "syasskie_ryadki"), None) or \
        next((p for p in vb["posts"] if p.get("id") == "svirica"), None)
    if not post:
        return None
    d0, d1 = parse_dt(vb["decade_from"]), parse_dt(vb["decade_to"])

    def ru(x):
        return f"{x:.2f}".replace(".", ",")

    return {"m": round(post["level_bs_m"] - CHART_DATUM_BS_M, 2), "level_bs_m": post["level_bs_m"],
            "datum_bs_m": CHART_DATUM_BS_M, "source": "volgobalt", "from": f"Волго-Балт, {post['name']}",
            "note": (f"ожидаемый уровень {ru(post['level_bs_m'])} м БС на {ROMAN[vb['decade'] - 1]} декаду "
                     f"({d0:%d.%m}–{d1:%d.%m.%Y}) по консультации Волго-Балта минус нуль карт "
                     f"{ru(CHART_DATUM_BS_M)} м БС") if d0 and d1 else None,
            "date": vb["decade_from"], "valid_to": vb["decade_to"]}


# ------------------------------------------------------------------------------------------------ IMS

_WGS_A = 6378137.0
_WGS_F = 1 / 298.257223563
_WGS_E2 = _WGS_F * (2 - _WGS_F)
_WGS_E = math.sqrt(_WGS_E2)
IMS_N, IMS_CELL = 6144, 4000.0


def _t(phi):
    return math.tan(math.pi / 4 - phi / 2) / ((1 - _WGS_E * math.sin(phi)) / (1 + _WGS_E * math.sin(phi))) ** (_WGS_E / 2)


def ims_cell(lat, lon):
    """(row counted from the bottom = data line in the file, column) of the IMS 4-km grid: polar
    stereographic on WGS 84, true scale at 60° N, central meridian 80° W, origin at the lower-left corner.
    Checked against the grid: Valaam is the one land cell inside the lake."""
    phi, lam, pc = math.radians(lat), math.radians(lon + 80.0), math.radians(60.0)
    mc = math.cos(pc) / math.sqrt(1 - _WGS_E2 * math.sin(pc) ** 2)
    rho = _WGS_A * mc * _t(phi) / _t(pc)
    x, y = rho * math.sin(lam), -rho * math.cos(lam)
    half = IMS_N * IMS_CELL / 2
    return int((y + half) // IMS_CELL), int((x + half) // IMS_CELL)


def ims_read_rows(stream, rows):
    """Read only the needed grid rows from a (decompressing) line stream; stops after the last needed row."""
    need = set(rows)
    last = max(need)
    got, n = {}, 0
    for raw in stream:
        line = raw.rstrip(b"\r\n")
        if len(line) != IMS_N or not line.isdigit():
            continue
        if n in need:
            got[n] = line
        n += 1
        if n > last:
            break
    if len(got) < len(need):
        raise ValueError(f"IMS grid ended early: {n} rows")
    return got


def ims_summary(rows_data):
    out = {}
    for key, name, pts in IMS_SECTORS:
        cells = sorted({ims_cell(la, lo) for la, lo in pts})
        codes = [chr(rows_data[r][c]) for r, c in cells]
        ice, water = codes.count("3"), codes.count("1")
        n = ice + water
        state = "unknown" if not n else "ice" if ice * 3 >= n * 2 else "water" if water * 3 >= n * 2 else "mixed"
        out[key] = {"name": name, "state": state, "ice": ice, "water": water}
    return out


def ims_needed_rows():
    return sorted({ims_cell(la, lo)[0] for _, _, pts in IMS_SECTORS for la, lo in pts})


# ----------------------------------------------------------------------------------------- collectors

class Ctx:
    def __init__(self, now, prev, state, http, force, deadline):
        self.now, self.prev, self.state, self.http, self.force, self.deadline = now, prev, state, http, force, deadline

    def time_left(self):
        return self.deadline - time.monotonic()

    def prev_at(self, path):
        cur = self.prev
        for k in path:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(k)
        return cur


def _age_ok(block, now, days):
    t = parse_dt((block or {}).get("issued") or (block or {}).get("date"))
    return bool(t and now - t <= dt.timedelta(days=days))


def _storm_alive(storm, now):
    to = parse_dt((storm or {}).get("valid_to"))
    if to:
        return to + dt.timedelta(hours=6) > now
    return _age_ok(storm, now, 2)


def refresh_mchs(value, now):
    """Carried-over МЧС block: drop expired warnings, a finished storm forecast and very old sub-blocks."""
    if not isinstance(value, dict):
        return value
    v = dict(value)
    v["warnings"] = [w for w in v.get("warnings") or [] if warning_active(w, now)]
    if v.get("storm") and not _storm_alive(v["storm"], now):
        v["storm"] = None
    for key in ("ice_review", "hydro"):
        if v.get(key) and not _age_ok(v[key], now, MAX_AGE_DAYS[key]):
            v[key] = None
    return v


def refresh_level_mchs(value, now):
    if not isinstance(value, dict):
        return value
    v = dict(value)
    for key in ("sentence", "table"):
        if v.get(key) and not _age_ok(v[key], now, MAX_AGE_DAYS[key]):
            v[key] = None
    v["text"] = (v.get("sentence") or {}).get("text")
    return v


def collect_mchs(ctx):
    http, st = ctx.http, ctx.state.setdefault("mchs", {})
    seen = st.setdefault("seen", {})
    wstore = st.setdefault("warnings", {})
    now = ctx.now
    prev_m = ctx.prev_at(("mchs",)) or {}
    prev_l = ctx.prev_at(("level", "mchs")) or {}
    resp = http.get(MCHS_RSS, timeout=20, retries=2, conditional=bool(prev_m), cache=True, validate=rss_complete)
    if resp.status == 304:
        return {"values": {("mchs",): refresh_mchs(prev_m, now), ("level", "mchs"): refresh_level_mchs(prev_l, now)},
                "status": "not_modified", "summary": "RSS not modified",
                "source_date": (prev_m.get("forecast") or {}).get("date"), "url": MCHS_RSS}
    items = parse_rss(resp.body)
    if not items:
        raise ValueError("RSS without items")
    problems, pages = [], 0
    epoch = now.timestamp()

    def fetch_page_lines(it, key):
        nonlocal pages
        rec = seen[key]
        if pages >= 2 or rec.get("tries", 0) >= 4 or ctx.time_left() < 45 or epoch - rec.get("last", 0) < 50 * 60:
            return None
        rec["tries"] = rec.get("tries", 0) + 1
        rec["last"] = epoch
        pages += 1
        try:
            page = http.get(it["url"], timeout=20, retries=2, validate=page_complete)
        except FetchError as e:
            problems.append(f"page {key}: {e}")
            return None
        art = extract_article(page.text())
        return html_to_lines(art) if art else None

    forecasts = sorted((i for i in items if classify(i["title"]) == "forecast"),
                       key=lambda i: (i["published"] or dt.datetime.min.replace(tzinfo=MSK), i["id"] or 0),
                       reverse=True)
    parsed, done_titles = [], set()
    for it in forecasts:
        key = str(it["id"])
        rec = seen.setdefault(key, {"t": iso(it["published"]), "k": "forecast"})
        lines = html_to_lines(it["html"]) if it["html"] else []
        if not forecast_complete(lines):
            if it["title"] in done_titles:
                continue  # a duplicate of a forecast already read in full
            lines = fetch_page_lines(it, key) or lines
            if not forecast_complete(lines):
                problems.append(f"forecast {key}: incomplete text")
                continue
        rec["ok"] = True
        done_titles.add(it["title"])
        target = forecast_target_date(it["title"], it["published"])
        year = (target or (it["published"] or now).date()).year
        f = parse_forecast(lines, year)
        f["meta"] = {"id": it["id"], "title": it["title"], "date": iso(target),
                     "issued": iso(it["published"]), "url": it["url"]}
        parsed.append(f)

    def pick(key, prev_value, alive):
        """Newest forecast that has this sub-block; else the previous one while it is not too old."""
        for f in parsed:
            if f.get(key):
                v = dict(f[key]) if isinstance(f[key], dict) else {"text": f[key]}
                return {"date": f["meta"]["date"], "issued": f["meta"]["issued"], "url": f["meta"]["url"], **v}
        if prev_value and alive(prev_value):
            return prev_value
        return None

    ice = pick("ice_review", prev_m.get("ice_review"), lambda v: _age_ok(v, now, MAX_AGE_DAYS["ice_review"]))
    storm = pick("storm", prev_m.get("storm"), lambda v: _storm_alive(v, now))
    hydro = pick("hydro", prev_m.get("hydro"), lambda v: _age_ok(v, now, MAX_AGE_DAYS["hydro"]))
    sentence = pick("sentence", prev_l.get("sentence"), lambda v: _age_ok(v, now, MAX_AGE_DAYS["sentence"]))
    table = pick("table", prev_l.get("table"), lambda v: _age_ok(v, now, MAX_AGE_DAYS["table"]))

    # warnings: parse new items once, keep them in state.json, publish those of the last 48 h or still valid
    for it in items:
        if classify(it["title"]) != "warning":
            continue
        key = str(it["id"])
        seen.setdefault(key, {"t": iso(it["published"]), "k": "warning"})
        if key in wstore and wstore[key].get("text"):
            continue
        lines = html_to_lines(it["html"]) if it["html"] else []
        if not lines:
            lines = fetch_page_lines(it, key) or []
        if lines:
            wstore[key] = parse_warning(it, lines)
        else:
            problems.append(f"warning {key}: no text")
    for key in list(wstore):
        pub = parse_dt(wstore[key].get("published"))
        if not pub or now - pub > dt.timedelta(days=7):
            del wstore[key]
    for key in list(seen):
        t = parse_dt(seen[key].get("t"))
        if not t or now - t > dt.timedelta(days=10):
            del seen[key]
    warnings = sorted((w for w in wstore.values() if warning_active(w, now)),
                      key=lambda w: w.get("published") or "", reverse=True)[:6]

    fc_meta = parsed[0]["meta"] if parsed else prev_m.get("forecast")
    mchs = {"forecast": fc_meta, "hydro": hydro, "ice_review": ice, "storm": storm, "warnings": warnings,
            "source": MCHS_SOURCE, "url": MCHS_LIST}
    level = {"text": (sentence or {}).get("text"), "sentence": sentence, "table": table, "source": MCHS_SOURCE}
    pk = None
    if sentence:
        it0 = next((x for x in sentence.get("items", []) if re.search(r"Петрокрепост", x["post"], re.I)), None)
        if it0 and it0.get("bs"):
            pk = {"cm_bs": it0["cm"], "date": (sentence.get("issued") or "")[:10] or sentence.get("date"),
                  "from": "sentence"}
            if it0.get("mark_cm") is not None:
                pk.update(mark=it0.get("mark"), mark_cm_bs=it0["mark_cm"])
    if table:
        row = next((x for x in table.get("posts", []) if re.search(r"Нева.*Петрокрепост", x["post"], re.I)), None)
        tdate = (table.get("time") or table.get("date") or "")[:10]
        if row and row.get("zero_m_bs") == 0 and "level_cm" in row and (not pk or tdate > pk["date"]):
            pk = {"cm_bs": row["level_cm"], "date": tdate, "from": "table"}
            if "norm_cm" in row:
                pk["norm_cm_bs"] = row["norm_cm"]
    if pk:
        level["petrokrepost"] = pk
    summary = (f"rss {len(items)} items, forecast {fc_meta['id'] if fc_meta else '—'}"
               f" ({(fc_meta or {}).get('date') or '—'}), level sentence {'yes' if sentence else 'no'},"
               f" table {len(table['posts']) if table else 0} posts, ice review {'yes' if ice else 'no'},"
               f" storm {'yes' if storm else 'no'}, warnings {len(warnings)}, pages fetched {pages}")
    res = {"values": {("mchs",): mchs, ("level", "mchs"): level}, "status": "partial" if problems else "ok",
           "summary": summary, "source_date": (fc_meta or {}).get("date"), "url": MCHS_RSS}
    if problems:
        res["error"] = "; ".join(problems)
    return res


def collect_grealm(ctx):
    prev = ctx.prev_at(("level", "grealm"))
    resp = ctx.http.get(GREALM_URL, timeout=30, retries=2, conditional=bool(prev), cache=True,
                        validate=lambda b: b.endswith(b"\n") and b.count(b"\n") > 200)
    if resp.status == 304 and prev:
        return {"values": {("level", "grealm"): prev}, "status": "not_modified",
                "summary": f"not modified, {prev.get('date')} {prev.get('height_m')} m", "source_date": prev.get("date"),
                "url": GREALM_URL}
    g = parse_grealm(resp.text("ascii"))
    g.update(source="G-REALM (NASA/USDA), спутниковая альтиметрия, 10-дневный ряд", url=GREALM_PAGE,
             data_url=GREALM_URL)
    return {"values": {("level", "grealm"): g}, "status": "ok", "source_date": g["date"], "url": GREALM_URL,
            "summary": f"{g['date']} {g['height_m']:+.2f} m, anomaly {g['anomaly_m']:+.2f} vs month norm, "
                       f"depth correction {g['depth_correction_m']:+.2f}"}


def collect_volgobalt(ctx):
    resp = ctx.http.get(VOLGOBALT_URL, timeout=25, retries=2, conditional=bool(ctx.prev_at(("level", "volgobalt"))),
                        cache=True, validate=lambda b: b"</table>" in b and b"</html>" in b[-5000:])
    prev = ctx.prev_at(("level", "volgobalt"))
    if resp.status == 304 and prev:
        vb = dict(prev)
        vb.update(volgobalt_pick_decade(vb, ctx.now.date()))  # the decade may have changed since the last read
    else:
        vb = parse_volgobalt(resp.text(), ctx.now.date())
        vb.update(source=VOLGOBALT_SOURCE, url=VOLGOBALT_URL)
    pk = next((p for p in vb["posts"] if p.get("id") == "syasskie_ryadki"), vb["posts"][0])
    return {"values": {("level", "volgobalt"): vb}, "status": "not_modified" if resp.status == 304 else "ok",
            "source_date": vb["decade_from"], "url": VOLGOBALT_URL,
            "summary": f"{vb['period']} decade {vb['decade']} ({vb['period_status']}): {pk['name']} "
                       f"{pk['level_bs_m']:.2f} m БС (project {pk['project_level_bs_m']:.2f}), "
                       f"{len(vb['posts'])} posts, {len(vb['depths'])} depth sections"}


def collect_meteonw(ctx):
    resp = ctx.http.get(METEONW_URL, timeout=20, retries=1, validate=lambda b: b"markers" in b)
    m = parse_meteonw(resp.text("cp1251"))
    m.update(source="ФГБУ «Северо-Западное УГМС», фактический уровень воды", url=METEONW_URL,
             terms="При использовании материалов ссылка обязательна; не для коммерческого использования и не для "
                   "планирования мероприятий, связанных с риском")
    return {"values": {("level", "meteonw"): m}, "status": "ok", "source_date": m.get("time"), "url": METEONW_URL,
            "summary": f"{m.get('time')} Петрокрепость {m.get('petrokrepost_cm')} cm, {len(m['posts'])} posts"}


def collect_mur(ctx):
    points, problems = [], []
    for pid, name, lat, lon in MUR_POINTS:
        try:
            resp = ctx.http.get(mur_url(lat, lon), timeout=30, retries=1)
            points.append(mur_point(parse_mur_csv(resp.text("latin-1")), pid, name, lat, lon))
        except ValueError as e:
            problems.append(f"{pid}: {e}")
        except FetchError as e:  # the server is down or slow: do not spend the run's time on the other points
            problems.append(f"{pid}: {e}")
            break
    if not points:
        raise FetchError("; ".join(problems))
    prev_pts = {p.get("id"): p for p in (ctx.prev_at(("water_temp",)) or {}).get("points") or []}
    for pid, *_ in MUR_POINTS:  # a point that failed now keeps its previous value
        if pid not in {p["id"] for p in points} and pid in prev_pts:
            points.append(prev_pts[pid])
    points.sort(key=lambda p: [x[0] for x in MUR_POINTS].index(p["id"]) if p["id"] in [x[0] for x in MUR_POINTS] else 9)
    main = points[0]  # Волховская губа, 60.2° N 32.25° E: the headline figure («Вода в открытой Ладоге 13,4 °C»)
    wt = {"label": "открытое озеро", "date": main["date"], "open_lake_c": main.get("temp_c"),
          "under_ice": main.get("under_ice"), "week_ago_c": main.get("prev_c"), "week_ago_date": main.get("prev_date"),
          "points": points,
          "source": "MUR SST v4.1 (NASA JPL), NOAA CoastWatch ERDDAP; маска озера у MUR грубая — южные губы "
                    "считаются сушей, поэтому точки в открытой части",
          "url": MUR_BASE + ".html"}
    date = main["date"]
    s = (f"{main['id']} {main['date']} " + ("under ice" if main.get("under_ice") else f"{main.get('temp_c')} °C") +
         (f" (7 d: {main.get('change_c'):+.1f})" if main.get("change_c") is not None else "") + f", {len(points)} points")
    res = {"values": {("water_temp",): wt}, "status": "partial" if problems else "ok", "summary": s,
           "source_date": date, "url": MUR_BASE}
    if problems:
        res["error"] = "; ".join(problems)
    return res


def collect_ims(ctx):
    now_utc = ctx.now.astimezone(dt.timezone.utc)
    day = now_utc.date() if now_utc.hour >= 14 else now_utc.date() - dt.timedelta(days=1)  # posted ~13:10 UTC
    last_err = None
    for d in (day, day - dt.timedelta(days=1), day - dt.timedelta(days=2)):
        url = IMS_URL.format(y=d.year, doy=d.timetuple().tm_yday)
        prev = ctx.prev_at(("ice_season",))
        if prev and prev.get("date") == d.isoformat() and not ctx.force:
            return {"values": {("ice_season",): prev}, "status": "cached", "summary": f"{d} already read",
                    "source_date": d.isoformat(), "url": url}
        try:
            resp = ctx.http.get(url, timeout=40, retries=1, max_bytes=4 << 20)
        except FetchError as e:
            last_err = f"{url.rsplit('/', 1)[-1]}: {e}"
            if "HTTP 404" in str(e):
                continue
            raise FetchError(last_err)
        with gzip.GzipFile(fileobj=io.BytesIO(resp.body)) as gz:
            rows = ims_read_rows(gz, ims_needed_rows())
        sectors = ims_summary(rows)
        ice = {"date": d.isoformat(), "sectors": sectors, "file": url.rsplit("/", 1)[-1],
               "source": "NOAA/NSIDC IMS 4 км (G02156): лёд или вода по клеткам 4×4 км; разводья и трещины не видит",
               "url": IMS_PAGE}
        return {"values": {("ice_season",): ice}, "status": "ok", "source_date": d.isoformat(), "url": url,
                "summary": f"{d} " + ", ".join(f"{k} {v['state']}" for k, v in sectors.items())}
    raise FetchError(last_err or "no IMS file")


COLLECTORS = [
    ("mchs", collect_mchs, [("mchs",), ("level", "mchs")]),
    ("level.grealm", collect_grealm, [("level", "grealm")]),
    ("level.volgobalt", collect_volgobalt, [("level", "volgobalt")]),
    ("level.meteonw", collect_meteonw, [("level", "meteonw")]),
    ("water_temp", collect_mur, [("water_temp",)]),
    ("ice_season", collect_ims, [("ice_season",)]),
]


# ------------------------------------------------------------------------------------------------ output

def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
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


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def get_path(root, path):
    cur = root
    for k in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


# NASA, NOAA and NSIDC do not answer servers in Russia (checked from the Moscow VPS on 24.09.2026: connections
# time out). With --relay these blocks come from the copy of this script that GitHub Actions runs every 6 h
# (.github/workflows/live-foreign.yml, branch live-data, foreign.json) instead of from the sources.
RELAY_BLOCKS = ("level.grealm", "water_temp", "ice_season")


def set_path(root, path, value):
    cur = root
    for k in path[:-1]:
        cur = cur.setdefault(k, {})
    cur[path[-1]] = value


class LockBusy(Exception):
    pass


def _lock(out_dir):
    """One run at a time per output directory (a manual run next to the timer's)."""
    f = open(os.path.join(out_dir, ".fetch_live.lock"), "a+")
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
        raise LockBusy(f"another fetch_live.py run holds {out_dir}/.fetch_live.lock")
    return f


def due(ctx, name, has_prev):
    if ctx.force or not has_prev:
        return True
    b = ctx.state.get("blocks", {}).get(name, {})
    t = ctx.now.timestamp()
    if b.get("error") and t - b.get("try", 0) >= RETRY_AFTER_FAIL:
        return True
    return t - b.get("ok", 0) >= INTERVAL[name]


def run(out_dir, now=None, http=None, force=False, only=None, budget=110.0, log=print, relay=None):
    """Collect all blocks and write out_dir/live.json. Returns the live dict."""
    os.makedirs(out_dir, exist_ok=True)
    live_path = os.path.join(out_dir, "live.json")
    state_path = os.path.join(out_dir, "state.json")
    prev = load_json(live_path) or load_json(os.path.join(out_dir, "live.prev.json")) or {}
    state = load_json(state_path) or {}
    now = now or now_msk()
    deadline = time.monotonic() + budget
    http = http or Http(state, deadline)
    ctx = Ctx(now, prev, state, http, force, deadline)
    blocks_state = state.setdefault("blocks", {})
    prev_meta = (prev.get("meta") or {}).get("blocks") or {}
    live = {"schema": SCHEMA, "generated": iso(now), "level": {}, "mchs": None, "water_temp": None, "ice_season": None}
    meta_blocks, errors = {}, {}
    t_run = time.monotonic()
    relay_live = None
    if relay:
        try:
            r = http.get(relay, timeout=20, retries=1)
            relay_live = json.loads(r.text("utf-8"))
            if not isinstance(relay_live, dict):
                raise ValueError("not a live.json")
        except (FetchError, ValueError) as e:
            errors["relay"] = {"at": iso(now), "error": trim(str(e), 300)}
            log(f"{'relay':<16} FAILED   {trim(str(e), 200)}")

    for name, fn, paths in COLLECTORS:
        t0 = time.monotonic()
        has_prev = any(ctx.prev_at(p) for p in paths)
        pm = prev_meta.get(name) or {}
        bs = blocks_state.setdefault(name, {})

        def carry(status):
            for p in paths:
                v = ctx.prev_at(p)
                if p == ("mchs",):
                    v = refresh_mchs(v, now)
                elif p == ("level", "mchs"):
                    v = refresh_level_mchs(v, now)
                elif p == ("level", "volgobalt") and v:
                    try:
                        v = dict(v, **volgobalt_pick_decade(v, now.date()))
                    except (KeyError, ValueError, TypeError, IndexError):
                        pass
                set_path(live, p, v)
            meta_blocks[name] = {"status": status, "fetched_at": pm.get("fetched_at"),
                                 "source_date": pm.get("source_date"), "url": pm.get("url")}

        if only and name not in only and name.split(".")[0] not in only:
            carry("cached")
            log(f"{name:<16} cached   not requested (--only)")
            continue
        if relay and name in RELAY_BLOCKS:
            rb = ((relay_live or {}).get("meta") or {}).get("blocks", {}).get(name) or {}
            vals = [get_path(relay_live, q) for q in paths] if relay_live else []
            if any(v is not None for v in vals):
                for q, v in zip(paths, vals):
                    set_path(live, q, v)
                meta_blocks[name] = {"status": "relay", "fetched_at": rb.get("fetched_at"),
                                     "source_date": rb.get("source_date"), "url": rb.get("url")}
                log(f"{name:<16} relay    {rb.get('source_date')} (collected {rb.get('fetched_at')})")
            elif relay_live and rb.get("status") == "off_season":
                set_path(live, paths[0], None)
                meta_blocks[name] = {"status": "off_season", "fetched_at": None, "source_date": None, "url": None}
                log(f"{name:<16} relay    off season")
            else:
                carry("stale" if has_prev else "error")
                if relay_live:
                    errors[name] = {"at": iso(now), "error": "not in the relay copy"}
                log(f"{name:<16} relay    nothing new" + (" (previous value kept)" if has_prev else ""))
            continue
        if name == "ice_season" and now.month in IMS_OFF_MONTHS and not force:
            set_path(live, paths[0], None)
            meta_blocks[name] = {"status": "off_season", "fetched_at": None, "source_date": None, "url": None}
            log(f"{name:<16} skipped  June–October, no ice (use --force)")
            continue
        if not due(ctx, name, has_prev):
            carry("cached")
            left = INTERVAL[name] - (now.timestamp() - bs.get("ok", 0))
            log(f"{name:<16} cached   next check in {max(0, left) / 3600:.1f} h")
            continue
        if ctx.time_left() < 15:
            carry("stale" if has_prev else "error")
            errors[name] = {"at": iso(now), "error": "skipped: run time budget exhausted"}
            log(f"{name:<16} skipped  run time budget exhausted")
            continue
        bs["try"] = now.timestamp()
        try:
            res = fn(ctx)
        except Exception as e:  # a block must never break the others
            msg = f"{type(e).__name__}: {e}" if not isinstance(e, FetchError) else str(e)
            carry("stale" if has_prev else "error")
            errors[name] = {"at": iso(now), "error": trim(msg, 300)}
            bs.update(error=trim(msg, 300), error_at=iso(now))
            log(f"{name:<16} FAILED   {trim(msg, 200)}" + (" (previous value kept)" if has_prev else "") +
                f" ({time.monotonic() - t0:.1f} s)")
            continue
        for p, v in res["values"].items():
            set_path(live, p, v)
        meta_blocks[name] = {"status": res["status"], "fetched_at": iso(now), "source_date": res.get("source_date"),
                             "url": res.get("url")}
        bs["ok"] = now.timestamp()
        bs.pop("error", None)
        bs.pop("error_at", None)
        if res.get("error"):
            errors[name] = {"at": iso(now), "error": trim(res["error"], 300)}
            bs.update(error=trim(res["error"], 300), error_at=iso(now), ok=bs.get("ok", 0))
        log(f"{name:<16} {res['status']:<8} {res.get('summary', '')}"
            + (f"; problems: {trim(res['error'], 160)}" if res.get("error") else "") + f" ({time.monotonic() - t0:.1f} s)")

    lv = live["level"]
    g = lv.get("grealm")
    dc_g = None
    if g and g.get("depth_correction_m") is not None:
        dc_g = {"m": g["depth_correction_m"], "source": "grealm", "from": "G-REALM",
                "note": f"спутниковый уровень минус средний за {g.get('norm_period', '1993–2020')}; глубины карт — "
                        "от среднего многолетнего уровня", "date": g.get("date")}
    try:
        dc_v = volgobalt_depth_correction(lv.get("volgobalt"), now.date())
    except (KeyError, TypeError, ValueError):
        dc_v = None
    # The absolute level in m БС (Волго-Балт) is the direct measure against the chart datum; G-REALM is the
    # fallback and stays for «к норме месяца».
    lv["depth_correction"] = dc_v or dc_g
    lv["depth_correction_grealm"] = dc_g
    live["meta"] = {"generated": iso(now), "blocks": meta_blocks, "errors": errors,
                    "requests": getattr(http, "count", None), "run_s": round(time.monotonic() - t_run, 1),
                    "collector": "scripts/live/fetch_live.py"}
    data = dumps(live)
    if os.path.exists(live_path):
        try:
            with open(live_path, "rb") as f:
                write_atomic(os.path.join(out_dir, "live.prev.json"), f.read())
        except OSError as e:
            log(f"warning: live.prev.json not written: {e}")
    write_atomic(live_path, data)
    try:
        write_atomic(state_path, dumps(state))
    except OSError as e:
        log(f"warning: state.json not written: {e}")
    log(f"wrote {live_path}: {len(data) / 1024:.1f} KB, {getattr(http, 'count', '?')} requests, "
        f"{time.monotonic() - t_run:.1f} s, errors: {', '.join(errors) or 'none'}")
    if len(data) > 20 * 1024:
        log(f"warning: live.json is {len(data) / 1024:.1f} KB (> 20 KB target)")
    return live


def main(argv=None):
    ap = argparse.ArgumentParser(description="Collect live data for «Ладога · рыболовная карта» into live.json")
    ap.add_argument("--out", required=True, help="output directory (live.json, live.prev.json, state.json)")
    ap.add_argument("--force", action="store_true", help="ignore refresh intervals and the IMS summer pause")
    ap.add_argument("--only", default="", help="comma-separated blocks: mchs, level (or level.grealm, "
                                               "level.meteonw), water_temp, ice_season")
    ap.add_argument("--budget", type=float, default=110.0, help="total time budget in seconds (default 110)")
    ap.add_argument("--relay", default="", help="URL of a live.json made elsewhere: the blocks from NASA / NOAA / "
                                                "NSIDC (" + ", ".join(RELAY_BLOCKS) + ") are taken from it")
    args = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, ValueError):
        pass
    only = {x.strip() for x in args.only.split(",") if x.strip()} or None
    try:
        os.makedirs(args.out, exist_ok=True)
        lock = _lock(args.out)
    except LockBusy as e:
        print(f"skipped: {e}", file=sys.stderr)
        return 0  # the other run writes live.json
    except OSError as e:
        print(f"error: cannot use {args.out}: {e}", file=sys.stderr)
        return 2
    try:
        run(args.out, force=args.force, only=only, budget=args.budget, relay=args.relay or None)
    except OSError as e:
        print(f"error: live.json not written: {e}", file=sys.stderr)
        return 1
    finally:
        lock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
