#!/usr/bin/env python3
"""Automated QA harness for the Ladoga fishing map PWA (site/). Reads the app, never changes it.

Run (Windows, from the repo root):
  python -m http.server 8792 --directory site          # in another terminal
  python scripts/qa/run_qa.py                           # every profile, every scenario
  python scripts/qa/run_qa.py --profiles iphone15,pixel7 --scenarios s1,s2,s5
  python scripts/qa/run_qa.py --summary                 # merge results into research/raw/qa/summary.md

Profiles: iphone15, iphonese, pixel7, phone_land, ipad, ipad_land, win1280, win1920.
Scenarios: s1 start · s2 point card · s3 sections · s4 sheets · s5 navigation (mocked GPS) · s6 demo + dark screen ·
s7 track · s8 offline (LIVE https site, read-only) · s9 layouts (landscape, tablet) · s10 desktop keys and mouse ·
perf (load, panning, heap).

Every scenario runs in a fresh browser context (empty storage). Screenshots: research/raw/qa/<profile>/, results:
research/raw/qa/<profile>/results.json. Third-party tiles and the weather API are cached on disk
(research/raw/qa/_netcache) so repeated runs are light on those servers; the perf scenario loads without the cache.
"""
from __future__ import annotations

import argparse
import subprocess
import hashlib
import json
import math
import os
import re
import statistics
import sys
import time
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path

from playwright.sync_api import sync_playwright, Error as PWError, TimeoutError as PWTimeout

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'research' / 'raw' / 'qa'
NETCACHE = OUT / '_netcache'
BASE = 'http://localhost:8792/'
LIVE = 'https://ogrebete-max.github.io/ladoga-fishing-map/'
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:  # noqa: BLE001
    pass

WIN_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
          'Chrome/149.0.0.0 Safari/537.36')
# engine, viewport, device pixel ratio, phone/tablet, touch, UA device (Playwright descriptor), iOS
PROFILES = {
    'iphone15':   dict(label='iPhone 15 · WebKit · 393×852', engine='webkit', vp=(393, 852), dsf=3, mobile=True, touch=True, ua_dev='iPhone 15', ios=True, layout='compact'),
    'iphonese':   dict(label='iPhone SE · WebKit · 375×667', engine='webkit', vp=(375, 667), dsf=2, mobile=True, touch=True, ua_dev='iPhone SE (3rd gen)', ios=True, layout='compact'),
    'pixel7':     dict(label='Android Pixel 7 · Chromium · 412×915', engine='chromium', vp=(412, 915), dsf=2.625, mobile=True, touch=True, ua_dev='Pixel 7', ios=False, layout='compact'),
    'phone_land': dict(label='Телефон в альбоме · WebKit · 844×390', engine='webkit', vp=(844, 390), dsf=3, mobile=True, touch=True, ua_dev='iPhone 14 landscape', ios=True, layout='land'),
    'ipad':       dict(label='iPad · WebKit · 820×1180', engine='webkit', vp=(820, 1180), dsf=2, mobile=True, touch=True, ua_dev='iPad (gen 7)', ios=True, layout='medium'),
    'ipad_land':  dict(label='iPad альбом · WebKit · 1180×820', engine='webkit', vp=(1180, 820), dsf=2, mobile=True, touch=True, ua_dev='iPad (gen 7) landscape', ios=True, layout='expanded'),
    'win1280':    dict(label='Windows ноутбук · Chromium · 1280×720', engine='chromium', vp=(1280, 720), dsf=1, mobile=False, touch=False, ua_dev=None, ios=False, layout='expanded'),
    'win1920':    dict(label='Windows ПК · Chromium · 1920×1080', engine='chromium', vp=(1920, 1080), dsf=1, mobile=False, touch=False, ua_dev=None, ios=False, layout='expanded'),
}
ALL_SCENARIOS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's9', 's10', 's11', 's12', 'perf', 's8']
FULL_DEMO = {'iphone15', 'pixel7', 'win1280', 'phone_land'}   # the whole 4-minute demo; others a short run
LONG_NAV = {'pixel7', 'win1280', 'iphone15'}                   # 2 minutes of navigation with heap / DOM numbers
PTINOV = (60.254, 32.08)

# ---------------------------------------------------------------------------------------------------------------
# In-page probes (added before the app's scripts). Only read the page; the app itself is untouched.
QA_JS = r"""
(() => {
  if (window.__qa) return;
  const QA = window.__qa = { longtasks: [], loaf: [], gaps: [], marks: {}, shares: [], lt: false };
  const now = () => performance.now();
  QA.lt = (PerformanceObserver.supportedEntryTypes || []).includes('longtask');
  try { if (QA.lt) new PerformanceObserver((l) => { for (const e of l.getEntries()) QA.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch (e) { QA.lt = false; }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 200) QA.loaf.push([Math.round(e.startTime), Math.round(e.duration), Math.round(e.blockingDuration || 0)]); }).observe({ type: 'long-animation-frame', buffered: true }); } catch (e) {}
  let last = 0;
  const loop = (t) => { if (last && t - last > 200 && document.visibilityState === 'visible') QA.gaps.push([Math.round(last), Math.round(t - last)]); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const poll = setInterval(() => {
    try { if (!QA.marks.data && typeof state !== 'undefined' && state.M && state.M.length) QA.marks.data = now(); } catch (e) {}
    if (!QA.marks.marker && document.querySelector('.leaflet-marker-icon')) QA.marks.marker = now();
    if (!QA.marks.tile && document.querySelector('img.leaflet-tile-loaded')) QA.marks.tile = now();
    if (QA.marks.data && QA.marks.marker && QA.marks.tile) clearInterval(poll);
  }, 20);
  setTimeout(() => clearInterval(poll), 60000);
  const r1 = (v) => Math.round(v * 10) / 10;
  // The part of an element actually on screen: cut by the viewport and by every scrolling / clipping ancestor.
  QA.clip = (el) => {
    const r = el.getBoundingClientRect();
    let L = r.left, T = r.top, R = r.right, B = r.bottom;
    for (let e = el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.position === 'fixed') { if (cs.overflowX === 'visible' && cs.overflowY === 'visible') break; }
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const pr = e.getBoundingClientRect();
        if (cs.overflowX !== 'visible') { L = Math.max(L, pr.left); R = Math.min(R, pr.right); }
        if (cs.overflowY !== 'visible') { T = Math.max(T, pr.top); B = Math.min(B, pr.bottom); }
      }
      if (cs.position === 'fixed') break;
    }
    L = Math.max(L, 0); T = Math.max(T, 0); R = Math.min(R, innerWidth); B = Math.min(B, innerHeight);
    return R - L >= 1 && B - T >= 1 ? { L, T, R, B, full: (R - L) * (B - T) / Math.max(1, r.width * r.height) } : null;
  };
  QA.vis = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
    const d = el.closest('details:not([open])');
    if (d && el !== d && !(d.querySelector(':scope > summary') || d).contains(el)) return false;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || +cs.opacity === 0) return false;
    }
    return !!QA.clip(el);
  };
  QA.name = (el) => {
    if (!el || !el.tagName) return String(el);
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    let data = '';
    for (const k of ['page', 'act', 'sub', 'chip', 'preset', 'sheetTab', 'search', 'anchor', 'set', 'val', 'overlay', 'tag']) if (el.dataset && el.dataset[k] != null) { data = `[${k}=${String(el.dataset[k]).slice(0, 18)}]`; break; }
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 42);
    return `${el.tagName.toLowerCase()}${id}${cls}${data}${label ? ' «' + label + '»' : ''}`;
  };
  QA.box = (el) => { const r = el.getBoundingClientRect(); return { x: r1(r.left), y: r1(r.top), w: r1(r.width), h: r1(r.height), r: r1(r.right), b: r1(r.bottom) }; };
  QA.coveredBy = (el) => {
    const c = QA.clip(el);
    if (!c || c.full < 0.9) return null; // partly scrolled away: not «covered»
    const x = (c.L + c.R) / 2, y = (c.T + c.B) / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return 'за краем экрана';
    const top = document.elementFromPoint(x, y);
    if (!top) return null;
    if (top === el || el.contains(top) || top.contains(el)) return null;
    return QA.name(top);
  };
  const TSEL = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], summary, label.check';
  QA.targets = (roots) => {
    const out = [], seen = new Set();
    for (const s of roots) {
      for (const root of document.querySelectorAll(s)) {
        const list = root.matches(TSEL) ? [root, ...root.querySelectorAll(TSEL)] : [...root.querySelectorAll(TSEL)];
        for (const el of list) {
          if (seen.has(el) || !QA.vis(el)) continue;
          seen.add(el);
          if (el.tagName === 'INPUT' && el.closest('label.check')) continue; // the label is the target
          const cs = getComputedStyle(el);
          out.push({ n: QA.name(el), ...QA.box(el), inline: cs.display === 'inline', cov: QA.coveredBy(el) });
        }
      }
    }
    return out;
  };
  QA.overlaps = (sels) => {
    const els = [...new Set(sels.flatMap((s) => [...document.querySelectorAll(s)]))].filter(QA.vis);
    const pairs = [];
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const iw = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const ih = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (iw > 0.5 && ih > 0.5) pairs.push({ a: QA.name(a), b: QA.name(b), iw: r1(iw), ih: r1(ih), ra: QA.box(a), rb: QA.box(b) });
    }
    return { n: els.length, pairs, items: els.map((e) => ({ n: QA.name(e), ...QA.box(e) })) };
  };
  // Horizontal overflow inside a container: scrollers (intended strips), clipped text, things sticking out.
  QA.hOverflow = (sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    const res = { root: { sw: root.scrollWidth, cw: root.clientWidth }, doc: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bsw: document.body.scrollWidth, bcw: document.body.clientWidth }, out: [], scrollers: [], clipped: [] };
    const flagged = new Set();
    const scrollerOf = (el) => { for (let e = el.parentElement; e && e !== root; e = e.parentElement) { const o = getComputedStyle(e).overflowX; if (o !== 'visible') return e; } return null; };
    for (const el of root.querySelectorAll('*')) {
      if (!QA.vis(el)) continue;
      const cs = getComputedStyle(el);
      if (el.tagName === 'svg' || el.closest('svg') && el.tagName !== 'svg') continue;
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) res.scrollers.push({ n: QA.name(el).slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth });
      else if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1) res.clipped.push({ n: QA.name(el).slice(0, 90), sw: el.scrollWidth, cw: el.clientWidth, ellipsis: cs.textOverflow === 'ellipsis', text: (el.innerText || '').trim().slice(0, 80) });
      const r = el.getBoundingClientRect();
      if (r.right > rr.right + 1 || r.left < rr.left - 1) {
        if (scrollerOf(el)) continue;
        let p = el.parentElement, dup = false;
        while (p && p !== root) { if (flagged.has(p)) { dup = true; break; } p = p.parentElement; }
        flagged.add(el);
        if (!dup) res.out.push({ n: QA.name(el).slice(0, 90), left: Math.round(r.left), right: Math.round(r.right), rootRight: Math.round(rr.right), text: (el.innerText || '').trim().slice(0, 60) });
      }
    }
    res.scrollers = res.scrollers.slice(0, 12); res.clipped = res.clipped.slice(0, 20); res.out = res.out.slice(0, 20);
    return res;
  };
  QA.pickMarker = (margin) => {
    margin = margin || 36;
    const fr = mapFreeRect(), c = map.getContainer().getBoundingClientRect();
    const cx = c.left + (fr.left + fr.right) / 2, cy = c.top + (fr.top + fr.bottom) / 2;
    let best = null;
    for (const el of document.querySelectorAll('.leaflet-marker-icon.hit')) {
      const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < c.left + fr.left + margin || x > c.left + fr.right - margin || y < c.top + fr.top + margin || y > c.top + fr.bottom - margin) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || !(el === top || el.contains(top))) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (!best || d < best.d) best = { d, x, y, el };
    }
    if (!best) return null;
    return { x: best.x, y: best.y, cls: best.el.className, html: best.el.innerHTML.slice(0, 120) };
  };
  QA.emptyMapPoint = () => {
    const fr = mapFreeRect(), c = map.getContainer().getBoundingClientRect();
    for (let fy = 0.3; fy <= 0.8; fy += 0.1) for (let fx = 0.2; fx <= 0.8; fx += 0.1) {
      const x = c.left + fr.left + fx * (fr.right - fr.left), y = c.top + fr.top + fy * (fr.bottom - fr.top);
      const els = document.elementsFromPoint(x, y);
      const t = els[0];
      if (!t || t.closest('.leaflet-marker-icon, .leaflet-interactive, .marker-cluster, .map-ui > *, button, .fcard, .panel, .modal, .nav-bar, .leaflet-control')) continue;
      let near = false;
      for (const m of document.querySelectorAll('.leaflet-marker-icon')) { const r = m.getBoundingClientRect(); if (Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y) < 40) { near = true; break; } }
      if (!near) return { x, y };
    }
    return null;
  };
  QA.screenOf = (lat, lon) => { const p = map.latLngToContainerPoint([lat, lon]); const c = map.getContainer().getBoundingClientRect(); return { x: r1(c.left + p.x), y: r1(c.top + p.y) }; };
  QA.freeRect = () => { const fr = mapFreeRect(), c = map.getContainer().getBoundingClientRect(); return { left: r1(c.left + fr.left), top: r1(c.top + fr.top), right: r1(c.left + fr.right), bottom: r1(c.top + fr.bottom) }; };
  QA.stack = () => ui.stack.map((l) => l.kind + (l.key ? ':' + l.key : '') + (l.page ? ':' + l.page + '/' + (l.sub || '') : '') + (l.attached ? '' : '(detached)'));
  QA.outline = (sels, color) => {
    let st = document.getElementById('__qaOutline');
    if (!st) { st = document.createElement('style'); st.id = '__qaOutline'; document.head.appendChild(st); }
    st.textContent = sels.length ? `${sels.join(',')} { outline: 3px solid ${color || '#ff00ff'} !important; outline-offset: -1px !important; }` : '';
  };
})();
"""
# Playwright's WebKit on Windows has no navigator.standalone (a real iPhone Safari has it, false) — without it the app
# takes the page for a Telegram-style in-app browser. Web Share is missing too; a real iPhone shares files, so record it.
IOS_JS = r"""
(() => {
  try { if (navigator.standalone === undefined) Object.defineProperty(Navigator.prototype, 'standalone', { get: () => false, configurable: true }); } catch (e) {}
  if (!navigator.share) {
    navigator.canShare = (d) => !!(d && (d.files || d.url || d.text));
    navigator.share = async (d) => {
      const files = [];
      for (const f of (d && d.files) || []) files.push({ name: f.name, type: f.type, size: f.size, text: await f.text() });
      (window.__qa || (window.__qa = { shares: [] })).shares.push({ title: d && d.title, files });
    };
  }
})();
"""


# ---------------------------------------------------------------------------------------------------------------
def net_cache_handler(route, request):
    """Third-party tiles and the weather API from a disk cache; fetched once per URL."""
    url = request.url
    if request.method != 'GET':
        route.continue_()
        return
    key = hashlib.sha1(url.encode('utf-8')).hexdigest()
    f = NETCACHE / key[:2] / key
    meta = f.with_suffix('.json')
    try:
        if f.exists() and meta.exists():
            m = json.loads(meta.read_text(encoding='utf-8'))
            route.fulfill(status=m['status'], headers=m['headers'], body=f.read_bytes())
            return
        if 'open-meteo.com' in url:
            # Playwright's own fetch hangs on api.open-meteo.com here; plain urllib is quick.
            import urllib.request
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'ladoga-qa'}), timeout=20) as u:
                body, status = u.read(), u.status
                headers = {'content-type': u.headers.get('content-type', 'application/json'), 'access-control-allow-origin': '*'}
        else:
            resp = route.fetch(timeout=25000)
            body, status = resp.body(), resp.status
            headers = {k: v for k, v in resp.headers.items() if k.lower() not in ('content-encoding', 'transfer-encoding', 'content-length', 'connection', 'set-cookie')}
        if status == 200 and body:
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp = f.with_name(f'{f.name}.{time.time_ns()}.tmp')
            tmp.write_bytes(body)
            os.replace(tmp, f)  # atomic: parallel runs share the cache
            tmpm = meta.with_name(f'{meta.name}.{time.time_ns()}.tmp')
            tmpm.write_text(json.dumps({'url': url, 'status': status, 'headers': headers}), encoding='utf-8')
            os.replace(tmpm, meta)
        route.fulfill(status=status, headers=headers, body=body)
    except Exception:  # noqa: BLE001
        try:
            route.abort()
        except Exception:  # noqa: BLE001
            pass


def git_head():
    try:
        return subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:  # noqa: BLE001
        return ''


def dest(lat, lon, brg, d):
    la = lat + d * math.cos(math.radians(brg)) / 111320
    return la, lon + d * math.sin(math.radians(brg)) / (111320 * math.cos(math.radians(la)))


def dist_m(a, b):
    R = 6371008.8
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def bearing_deg(a, b):
    p1, p2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def parse_dist(txt):
    """'1,25 км' → 1250, '850 м' → 850, 'Снос 12 м' → 12."""
    if not txt:
        return None
    m = re.search(r'([\d\s]+(?:,\d+)?)\s*(км|м)\b', txt.replace('\u00a0', ' '))
    if not m:
        return None
    v = float(m.group(1).replace(' ', '').replace(',', '.'))
    return v * 1000 if m.group(2) == 'км' else v


def parse_num(txt):
    if not txt:
        return None
    m = re.search(r'-?\d+(?:,\d+)?', txt)
    return float(m.group(0).replace(',', '.')) if m else None


class Gps:
    """Moves a mocked GPS along waypoints at a steady speed; context.set_geolocation once a second."""

    def __init__(self, ctx, waypoints, speed_kmh=20.0, acc=5.0):
        self.ctx, self.wp, self.v, self.acc = ctx, waypoints, speed_kmh / 3.6, acc
        self.t0 = None
        self.last = 0.0
        self.pos = waypoints[0]
        self.frozen = False
        self.log = []
        self.legs = [dist_m(waypoints[i], waypoints[i + 1]) for i in range(len(waypoints) - 1)]

    def at(self, d):
        for i, L in enumerate(self.legs):
            if d <= L:
                a, b = self.wp[i], self.wp[i + 1]
                k = d / L if L else 0
                return a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k
            d -= L
        return self.wp[-1]

    def start(self):
        self.t0 = time.time()
        self.push()

    def push(self):
        if self.t0 is None:
            return
        d = self.v * (time.time() - self.t0)
        self.pos = self.at(d)
        self.ctx.set_geolocation({'latitude': self.pos[0], 'longitude': self.pos[1], 'accuracy': self.acc})
        self.last = time.time()
        self.log.append((round(time.time() - self.t0, 2), round(self.pos[0], 6), round(self.pos[1], 6)))

    def tick(self):
        if self.t0 is not None and not self.frozen and time.time() - self.last >= 1.0:
            self.push()


# ---------------------------------------------------------------------------------------------------------------
class Run:
    """One profile: its browser, results, screenshots."""

    def __init__(self, pw, key, base=None):
        self.pw, self.key, self.p, self.base = pw, key, PROFILES[key], base or BASE
        self.dir = OUT / key
        self.dir.mkdir(parents=True, exist_ok=True)
        self.results, self.perf, self.console, self.shots = [], {}, [], []
        self.browser = None
        self.ctx = None
        self.gps = None
        self.log = []
        self.flaky = []
        self.scn = ''
        self.n = 0
        self.t_start = time.time()
        dev = self.p['ua_dev']
        self.ua = pw.devices[dev]['user_agent'] if dev else WIN_UA

    # --- browser and pages ---
    def launch(self):
        if not self.browser:
            self.browser = getattr(self.pw, self.p['engine']).launch()
        return self.browser

    def close(self):
        if self.browser:
            try:
                self.browser.close()
            except Exception:  # noqa: BLE001
                pass
            self.browser = None

    def new_page(self, geo=None, route=True, sw='block', url=None, ready=True):
        self.launch()
        w, h = self.p['vp']
        opts = dict(viewport={'width': w, 'height': h}, screen={'width': w, 'height': h}, device_scale_factor=self.p['dsf'],
                    is_mobile=self.p['mobile'], has_touch=self.p['touch'], user_agent=self.ua, locale='ru-RU',
                    timezone_id='Europe/Moscow', color_scheme='light', accept_downloads=True, service_workers=sw)
        if geo:
            opts.update(permissions=['geolocation'], geolocation={'latitude': geo[0], 'longitude': geo[1], 'accuracy': 5})
        if self.ctx:
            self.end_page()
        self.ctx = self.browser.new_context(**opts)
        self.ctx.add_init_script(QA_JS)
        if self.p['ios']:
            self.ctx.add_init_script(IOS_JS)
        if route:
            self.ctx.route(re.compile(r'^https?://(?!localhost|127\.0\.0\.1)'), net_cache_handler)
        page = self.ctx.new_page()
        page.set_default_timeout(15000)
        log = self.log = []

        def on_console(m):
            if m.type in ('error', 'warning'):
                loc = m.location or {}
                log.append({'t': round(time.time() - self.t_start, 1), 'scn': self.scn, 'type': m.type, 'text': m.text[:400], 'url': (loc.get('url') or '')[:160]})

        page.on('console', on_console)
        page.on('pageerror', lambda e: log.append({'t': round(time.time() - self.t_start, 1), 'scn': self.scn, 'type': 'pageerror', 'text': str(e)[:600]}))
        page.on('requestfailed', lambda r: log.append({'t': round(time.time() - self.t_start, 1), 'scn': self.scn, 'type': 'requestfailed', 'text': f'{r.failure} {r.url[:160]}'})
                if ('localhost' in r.url or 'github.io' in r.url) else None)
        page.on('response', lambda r: log.append({'t': round(time.time() - self.t_start, 1), 'scn': self.scn, 'type': 'http', 'text': f'{r.status} {r.url[:160]}'})
                if r.status >= 400 and ('localhost' in r.url or 'github.io' in r.url) else None)
        self.page = page
        if url is not False:
            live = bool(url) and url.startswith('https://')
            page.goto(url or self.base, wait_until='domcontentloaded' if live else 'load', timeout=60000 if live else 15000)
            if ready:
                self.ready(page)
        return page

    def ready(self, page, timeout=30000):
        page.wait_for_function('() => typeof state !== "undefined" && state.M && state.M.length > 0 && typeof ui !== "undefined" && document.querySelector(".leaflet-marker-icon")', timeout=timeout)
        page.wait_for_timeout(400)

    def end_page(self):
        if self.ctx:
            try:
                self.console.extend(self.log)
            except Exception:  # noqa: BLE001
                pass
            try:
                self.ctx.close()
            except Exception:  # noqa: BLE001
                pass
        self.ctx = None
        self.gps = None

    def errors(self, page, since=0):
        # a tile Leaflet cancels when it leaves the view is not an error (net::ERR_ABORTED / WebKit «cancelled»)
        return [x for x in self.log[since:] if x['type'] in ('error', 'pageerror', 'requestfailed', 'http')
                and not (x['type'] == 'requestfailed' and re.search(r'ERR_ABORTED|cancell', x['text']))]

    # --- actions ---
    def wait(self, ms):
        end = time.time() + ms / 1000
        while True:
            left = end - time.time()
            if left <= 0:
                break
            self.page.wait_for_timeout(min(150, max(1, left * 1000)))
            if self.gps:
                self.gps.tick()

    def tap(self, page, sel, timeout=6000, force=False):
        loc = page.locator(sel).first
        loc.wait_for(state='visible', timeout=timeout)
        try:
            if self.p['touch']:
                loc.tap(timeout=timeout, force=force)
            else:
                loc.click(timeout=timeout, force=force)
        except PWTimeout:
            if force:
                raise
            # WebKit on Windows sometimes never reports the element «stable» (rAF throttling): tap anyway, note it.
            self.flaky.append(f'{self.scn}: {sel}')
            if self.p['touch']:
                loc.tap(timeout=timeout, force=True)
            else:
                loc.click(timeout=timeout, force=True)

    def tap_xy(self, page, x, y):
        if self.p['touch']:
            page.touchscreen.tap(x, y)
        else:
            page.mouse.click(x, y)

    def back(self, page):
        try:
            page.go_back(timeout=6000, wait_until='commit')
        except PWError:
            pass
        self.wait(700)

    def js(self, page, expr, arg=None):
        return page.evaluate(expr, arg) if arg is not None else page.evaluate(expr)

    def view(self, page, lat, lon, z):
        page.evaluate('([a, b, z]) => { map.setView([a, b], z, { animate: false }); }', [lat, lon, z])
        self.wait(900)
        try:
            page.wait_for_function('() => document.querySelectorAll("img.leaflet-tile-loaded").length > 6', timeout=8000)
        except PWTimeout:
            pass
        self.wait(300)

    def nav_to(self, page, pg, sub=None):
        self.tap(page, f'#navBar [data-page="{pg}"]')
        page.wait_for_selector('#page:not([hidden])', timeout=6000)
        if sub:
            self.tap(page, f'#pageTabs [data-sub="{sub}"]')
        self.wait(500)

    def stack(self, page):
        return page.evaluate('() => __qa.stack()')

    # --- results ---
    def shot(self, page, name, full=False):
        self.n += 1
        fn = f'{self.scn}-{self.n:02d}-{name}.png'
        path = self.dir / fn
        try:
            page.screenshot(path=str(path), scale='css', full_page=full, animations='allow', timeout=15000)
        except Exception as e:  # noqa: BLE001
            print(f'  [{self.key}] screenshot failed {fn}: {e}')
            return None
        rel = path.relative_to(ROOT).as_posix()
        self.shots.append(rel)
        return rel

    def check(self, name, ok, detail='', sev='серьёзно', shot=None, data=None, level=None):
        status = level or ('pass' if ok else 'fail')
        r = {'profile': self.key, 'scn': self.scn, 'check': name, 'status': status, 'sev': None if status == 'pass' else sev,
             'detail': detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False), 'shot': shot}
        if data is not None:
            r['data'] = data
        self.results.append(r)
        mark = {'pass': 'OK ', 'fail': 'FAIL', 'warn': 'WARN', 'info': 'info', 'error': 'ERR '}[status]
        print(f'  [{self.key}/{self.scn}] {mark} {name}: {r["detail"][:220]}')
        return ok

    def info(self, name, detail, data=None, shot=None):
        return self.check(name, True, detail, data=data, shot=shot, level='info')

    def warn(self, name, detail, sev='мелочь', data=None, shot=None):
        return self.check(name, False, detail, sev=sev, data=data, shot=shot, level='warn')

    def save(self):
        doc = {'profile': self.key, 'label': self.p['label'], 'ua': self.ua, 'commit': git_head(), 'forced_taps': self.flaky, 'results': self.results, 'perf': self.perf,
               'console': self.console, 'shots': self.shots, 'finished': time.strftime('%Y-%m-%d %H:%M:%S')}
        prev = self.dir / 'results.json'
        if prev.exists():  # keep scenarios of an earlier partial run that were not re-run now
            try:
                old = json.loads(prev.read_text(encoding='utf-8'))
                ran = {r['scn'] for r in self.results} | {c.get('scn') for c in self.console}
                doc['results'] = [r for r in old.get('results', []) if r['scn'] not in ran] + self.results
                doc['console'] = [c for c in old.get('console', []) if c.get('scn') not in ran] + self.console
                perf = old.get('perf', {})
                perf.update(self.perf)
                doc['perf'] = perf
                doc['shots'] = sorted({s for s in old.get('shots', []) if not any(f'/{x}-' in s for x in ran)} | set(self.shots))
            except Exception:  # noqa: BLE001
                pass
        prev.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')


# ---------------------------------------------------------------------------------------------------------------
MAPUI_SELS = ['#mapUi button', '#mapUi .schip', '#navBar > button', '#navBar .rail-extra button', '#hint', '.leaflet-control-scale', '#attrLine', '#cursorInfo', '#toast.show']
NAV_SELS = ['#navTop', '#navBottom button', '#navBottom .nb-field', '#mapUi button', '#navBanner', '#recenter', '#demoTag', '.leaflet-control-scale', '#zoomAuto', '#toast.show']

JS_MAPFILL = r"""() => {
  const m = document.getElementById('map').getBoundingClientRect();
  const nb = document.getElementById('navBar');
  const nr = __qa.vis(nb) ? nb.getBoundingClientRect() : null;
  const lay = document.body.dataset.layout;
  const exp = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  if (nr) { if (lay === 'compact') exp.bottom = nr.top; else exp.left = nr.right; }
  const pg = document.getElementById('page');
  if (__qa.vis(pg) && lay === 'expanded') exp.left = pg.getBoundingClientRect().right;
  const size = map.getSize();
  const samples = [];
  const tiles = [...document.querySelectorAll('img.leaflet-tile-loaded')].map((t) => t.getBoundingClientRect());
  for (const fx of [0.08, 0.5, 0.92]) for (const fy of [0.08, 0.5, 0.92]) {
    const x = m.left + fx * m.width, y = m.top + fy * m.height;
    samples.push({ fx, fy, tile: tiles.some((t) => x >= t.left && x <= t.right && y >= t.top && y <= t.bottom) });
  }
  return { map: __qa.box(document.getElementById('map')), nav: nr ? __qa.box(nb) : null, exp, leaflet: { x: size.x, y: size.y }, samples,
    tiles: document.querySelectorAll('img.leaflet-tile-loaded').length, docSW: document.documentElement.scrollWidth, docSH: document.documentElement.scrollHeight,
    vw: innerWidth, vh: innerHeight, scrollY: scrollY, layout: lay };
}"""

JS_NAVSNAP = r"""() => {
  const t = (s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim();
  const me = geo.me;
  const boat = me ? __qa.screenOf(me.lat, me.lon) : null;
  const fr = __qa.freeRect();
  const banner = document.getElementById('navBanner');
  return {
    mode: document.body.dataset.mode, dist: t('#ntDist'), line2: t('#ntLine2'), target: t('#ntTarget'), gps: t('#ntGpsText'),
    speed: t('#nfSpeed'), speedUnit: t('#nfSpeed + .nb-unit'), course: t('#nfCourse'), courseSrc: t('#nfCourseSrc'), depth: t('#nfDepth'), depthUnit: t('#nfDepth + .nb-unit'),
    shallow: document.getElementById('nfDepthBox').classList.contains('shallow'),
    banner: banner.hidden ? '' : banner.textContent.replace(/\s+/g, ' ').trim(), bannerCls: banner.hidden ? '' : banner.className,
    recenter: !document.getElementById('recenter').hidden, recenterText: t('#recenterText'),
    zoomAuto: !document.getElementById('zoomAuto').hidden && document.getElementById('zoomAuto').classList.contains('on'), zoom: map.getZoom(), bearing: Math.round(map.getBearing()),
    follow: geo.follow, courseRot: !!geo.courseRot, sog: geo.sog, cog: geo.cog, navD: nav.d, arrived: nav.arrived, hold: nav.hold, autoZoomPaused: nav.autoZoomPaused,
    boat, fr, boatShareY: boat ? (boat.y - fr.top) / (fr.bottom - fr.top) : null, boatShareX: boat ? (boat.x - fr.left) / (fr.right - fr.left) : null,
    hits: [...document.querySelectorAll('.leaflet-marker-icon.hit')].filter(__qa.vis).length,
    clusterOn: map.hasLayer(layers.cluster), poisOn: map.hasLayer(layers.pois),
    navBar: __qa.vis(document.getElementById('navBar')), search: __qa.vis(document.getElementById('searchBtn')), chips: __qa.vis(document.getElementById('statusChips')),
    sos: __qa.vis(document.getElementById('btnSos')), zoomIn: __qa.vis(document.getElementById('zoomIn')), compass: __qa.vis(document.getElementById('btnCompass')),
    demoTag: __qa.vis(document.getElementById('demoTag')), stack: __qa.stack(), modal: !document.getElementById('modal').hidden,
    modalTitle: t('#modalTitle'), saver: !!document.getElementById('saver'),
  };
}"""


def expected_layout(w, h):
    return 'land' if h < 480 and w < 1100 else 'compact' if w < 600 else 'medium' if w < 1024 else 'expanded'


def fmt_box(b):
    return f"{b['w']:.0f}×{b['h']:.0f} @({b['x']:.0f},{b['y']:.0f})"


def check_overlaps(r, page, where, shot_name, sels=None, ignore=()):
    ov = page.evaluate('(s) => __qa.overlaps(s)', sels or MAPUI_SELS)
    pairs = [p for p in ov['pairs'] if not any(re.search(i, p['a']) or re.search(i, p['b']) for i in ignore)]
    shot = None
    if pairs:
        # outline the pairs in magenta for the screenshot
        ids = set()
        for p in pairs:
            for k in ('a', 'b'):
                m = re.match(r'^[a-z0-9]+(#[\w-]+)', p[k])
                if m:
                    ids.add(m.group(1))
        cls_sel = []
        for p in pairs:
            for k in ('a', 'b'):
                if not re.match(r'^[a-z0-9]+#', p[k]):
                    m = re.match(r'^([a-z0-9]+)((?:\.[\w-]+)+)', p[k])
                    if m:
                        cls_sel.append(m.group(1) + m.group(2))
        page.evaluate('(s) => __qa.outline(s)', sorted(ids) + sorted(set(cls_sel)))
        shot = r.shot(page, shot_name + '-overlap')
        page.evaluate('() => __qa.outline([])')
    minor_re = re.compile(r'toast|leaflet-control-scale|#attrLine|#zoomAuto|#cursorInfo|#demoTag')
    serious = [p for p in pairs if not (minor_re.search(p['a']) or minor_re.search(p['b']))]
    minor = [p for p in pairs if p not in serious]
    fmt = lambda ps: '; '.join(f"{p['a']} ⨯ {p['b']}: перекрытие {p['iw']:.0f}×{p['ih']:.0f} px" for p in ps[:8])  # noqa: E731
    r.check(f'{where}: кнопки и панели не перекрываются', not serious, fmt(serious) or f'{ov["n"]} элементов, перекрытий нет', sev='серьёзно', shot=shot if serious else None, data=serious[:12])
    if minor:
        r.warn(f'{where}: перекрыты линейка / подписи / тост', fmt(minor), sev='мелочь', shot=shot, data=minor[:12])
    return ov, pairs


def check_chips(r, page, where, shot=None):
    """Status chips over the map: every chip fully visible (the row scrolls sideways, but a cut chip hides its words)."""
    st = page.evaluate('''() => { const row = document.getElementById('statusChips'); if (!__qa.vis(row)) return null; const rr = row.getBoundingClientRect();
        return { sw: row.scrollWidth, cw: row.clientWidth, row: __qa.box(row), chips: [...row.querySelectorAll('.schip')].map((c) => { const b = c.getBoundingClientRect();
          return { t: c.innerText.replace(/\\s+/g, ' ').trim(), w: Math.round(b.width), cut: b.right > rr.right + 0.5 || b.left < rr.left - 0.5, hiddenPx: Math.round(Math.max(0, b.right - rr.right)) }; }) } }''')
    if not st or not st['chips']:
        return None
    cut = [c for c in st['chips'] if c['cut']]
    r.check(f'{where}: чипы статуса видны целиком', not cut, '; '.join(f"«{c['t']}» обрезан на {c['hiddenPx']} px" for c in cut) or ' | '.join(c['t'] for c in st['chips']),
            sev='мелочь', shot=shot, data=st)
    return st


def check_targets(r, page, where, roots, min_px=44, sev='мелочь', data_all=False):
    tt = page.evaluate('(r) => __qa.targets(r)', roots)
    small = [t for t in tt if (t['w'] < min_px - 0.5 or t['h'] < min_px - 0.5) and not t['inline']]
    covered = [t for t in tt if t['cov'] and t['cov'] != 'за краем экрана' and not t['inline']]  # a wrapped inline link spans two lines
    # group identical controls: «.chip 40 px» once with a count
    groups = {}
    for t in small:
        key = re.sub(r' «.*$', '', t['n'])
        g = groups.setdefault(key, {'n': t['n'], 'w': t['w'], 'h': t['h'], 'count': 0})
        g['count'] += 1
        g['w'], g['h'] = min(g['w'], t['w']), min(g['h'], t['h'])
    detail = '; '.join(f"{g['n']} — {g['w']:.0f}×{g['h']:.0f}" + (f" (×{g['count']})" if g['count'] > 1 else '') for g in list(groups.values())[:14])
    r.check(f'{where}: цели касания ≥ {min_px}×{min_px}', not small, detail or f'{len(tt)} целей, все ≥ {min_px}', sev=sev,
            data=list(groups.values())[:30])
    if covered:
        r.check(f'{where}: кнопки ничем не закрыты', False, '; '.join(f"{t['n']} закрыта: {t['cov']}" for t in covered[:8]), sev='серьёзно', data=covered[:10])
    return tt, small


# ---------------------------------------------------------------------------------------------------------------
def s1_start(r: Run):
    page = r.new_page()
    try:
        page.wait_for_selector('#statusChips .schip', timeout=8000)
    except PWTimeout:
        pass
    r.wait(1500)
    shot = r.shot(page, 'start')
    errs = r.errors(page)
    r.check('Старт без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет', sev='серьёзно', shot=shot)
    lay = page.evaluate('document.body.dataset.layout')
    w, h = r.p['vp']
    r.check('Класс раскладки по размеру окна', lay == expected_layout(w, h), f'body[data-layout]={lay}, ожидалось {expected_layout(w, h)}')
    vis = page.evaluate('''() => Object.fromEntries(['#map', '#searchBtn', '#filterBtn', '#statusChips', '#btnLayers', '#btnFull', '#btnSos', '#zoomIn', '#zoomOut',
        '#btnHome', '#btnLocate', '#btnTrack', '#navBar', '#hint', '.leaflet-control-scale', '#attrLine'].map((s) => [s, __qa.vis(document.querySelector(s))]))''')
    need = [k for k in vis if k not in ('#hint', '#attrLine', '.leaflet-control-scale')]
    missing = [k for k in need if not vis[k]]
    r.check('Видны карта, поиск, чипы, кнопки справа, +/−, ⌂, ◎, «Трек», нижняя панель/рейка', not missing, 'не видно: ' + ', '.join(missing) if missing else 'всё на месте', shot=shot)
    r.info('Подсказка первого входа', 'видна' if vis['#hint'] else 'не видна', data=page.evaluate('() => __qa.box(document.getElementById("hint"))') if vis['#hint'] else None)
    items = page.evaluate('''() => [...document.querySelectorAll('#navBar [data-page]')].filter(__qa.vis).map((b) => b.innerText.trim())''')
    r.check('Пять разделов в панели', items == ['Карта', 'Сегодня', 'Клёв', 'Правила', 'Моё'], ' · '.join(items))
    chips = page.evaluate('''() => [...document.querySelectorAll('#statusChips .schip')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim())''')
    r.info('Чипы статуса', ' | '.join(chips) or 'нет чипов')
    check_chips(r, page, 'Старт', shot=shot)
    check_overlaps(r, page, 'Старт', 'start')
    check_targets(r, page, 'Старт (карта и панель)', ['#mapUi', '#navBar'])
    fill = page.evaluate(JS_MAPFILL)
    m, e = fill['map'], fill['exp']
    gaps = {k: round(v, 1) for k, v in {'left': m['x'] - e['left'], 'top': m['y'] - e['top'], 'right': e['right'] - m['r'], 'bottom': e['bottom'] - m['b']}.items() if abs(v) > 1}
    r.check('Карта занимает всю свободную область', not gaps and abs(fill['leaflet']['x'] - m['w']) <= 1 and abs(fill['leaflet']['y'] - m['h']) <= 1,
            f"#map {fmt_box(m)}; зазоры {gaps or 'нет'}; размер Leaflet {fill['leaflet']['x']}×{fill['leaflet']['y']}", data=fill)
    bad = [s for s in fill['samples'] if not s['tile']]
    r.check('Плитки покрывают карту (9 проб)', len(bad) <= 1, f"{9 - len(bad)} из 9 точек на плитке; загружено плиток {fill['tiles']}", sev='мелочь')
    r.check('Страница не прокручивается вбок/вниз', fill['docSW'] <= fill['vw'] + 1 and fill['docSH'] <= fill['vh'] + 1,
            f"scrollWidth {fill['docSW']} / {fill['vw']}, scrollHeight {fill['docSH']} / {fill['vh']}")
    # the hint card vs the scale bar and the buttons
    marks = page.evaluate('() => ({ ...__qa.marks, nav: performance.getEntriesByType("navigation")[0]?.toJSON?.() })')
    r.perf['s1_marks'] = {k: (round(v) if isinstance(v, (int, float)) else None) for k, v in marks.items() if k != 'nav'}
    # «Понятно» hides the hint for good
    if vis['#hint']:
        r.tap(page, '#hint [data-notice="hint"]')
        r.wait(300)
        gone = page.evaluate('() => document.getElementById("hint").hidden && JSON.parse(localStorage.getItem("ladoga-hint-v2") || "false")')
        r.check('«Понятно» убирает подсказку навсегда', gone, 'скрыта, ladoga-hint-v2=true' if gone else 'осталась')


def s2_card(r: Run):
    page = r.new_page()
    compact = r.p['layout'] == 'compact'
    r.view(page, *PTINOV, 13)
    r.shot(page, 'ptinov-z13')

    def open_point():
        pick = page.evaluate('() => __qa.pickMarker(40)')
        if not pick:
            return None
        r.tap_xy(page, pick['x'], pick['y'])
        try:
            page.wait_for_selector('#card:not([hidden])', timeout=5000)
        except PWTimeout:
            return None
        r.wait(1100)
        return pick

    h0 = page.evaluate('history.length')
    pick = open_point()
    if not r.check('Тап по точке открывает карточку', bool(pick), f"точка {pick['cls'] if pick else '—'}", sev='блокер'):
        r.shot(page, 'no-card')
        return
    info = page.evaluate('''() => { const m = state.M[state.selected]; const c = document.getElementById('card');
        return { title: document.getElementById('cardTitle').textContent, sub: document.getElementById('cardSub').textContent, size: c.dataset.size, card: __qa.box(c),
          pos: m ? __qa.screenOf(m.lat, m.lon) : null, kind: m?.kind, lat: m?.lat, lon: m?.lon, hist: history.length, hash: location.hash, stack: __qa.stack(),
          vw: innerWidth, vh: innerHeight, mapui: __qa.freeRect() } }''')
    shot = r.shot(page, 'card')
    r.info('Карточка', f"«{info['title']}» · {info['sub']} · вид {info['kind']} · {info['lat']:.5f}, {info['lon']:.5f}")
    r.check('Открытие карточки = одна запись в истории, #pt= в адресе', info['hist'] == h0 + 1 and '#pt=' in info['hash'], f"history {h0}→{info['hist']}, hash {info['hash']}")
    c, p = info['card'], info['pos']
    if compact:
        ok = p and 0 < p['x'] < info['vw'] and 60 < p['y'] < c['y'] - 12
        r.check('Точка видна над карточкой', ok, f"точка ({p['x']:.0f},{p['y']:.0f}), верх карточки {c['y']:.0f}, высота карточки {c['h']:.0f} ({c['h'] / info['vh'] * 100:.0f} % экрана)", shot=shot)
        r.check('Карточка «Кратко» ≤ 45 % высоты', c['h'] <= info['vh'] * 0.45 + 2, f"{c['h']:.0f} px = {c['h'] / info['vh'] * 100:.0f} %", sev='мелочь')
    else:
        ok = p and c['r'] + 12 < p['x'] < info['vw'] - 12 and 0 < p['y'] < info['vh']
        r.check('Точка видна рядом с панелью карточки', ok, f"точка ({p['x']:.0f},{p['y']:.0f}), панель {fmt_box(c)}", shot=shot)
        r.check('Карточка — боковая панель во всю высоту', c['y'] <= 1 and c['b'] >= info['vh'] - 1 and 300 <= c['w'] <= 420, fmt_box(c))
    check_overlaps(r, page, 'Карточка открыта', 'card', sels=MAPUI_SELS + ['#card'])
    check_targets(r, page, 'Карточка', ['#card'])
    # «Подробнее»
    if compact:
        h1 = page.evaluate('history.length')
        r.tap(page, '#cardBody .more-toggle')
        r.wait(500)
        st = page.evaluate('() => ({ size: document.getElementById("card").dataset.size, h: document.getElementById("card").getBoundingClientRect().height, hist: history.length, open: !document.getElementById("card").hidden, vh: innerHeight })')
        sh = r.shot(page, 'card-full')
        r.check('«Подробнее» разворачивает карточку без новой записи в истории', st['size'] == 'full' and st['open'] and st['hist'] == h1,
                f"size={st['size']}, высота {st['h']:.0f} px ({st['h'] / st['vh'] * 100:.0f} %), history {h1}→{st['hist']}", shot=sh)
        r.tap(page, '#cardBody .more-toggle')
        r.wait(400)
        r.check('«Свернуть» возвращает кратко', page.evaluate('document.getElementById("card").dataset.size') == 'short', '')
        # Back from the expanded card closes the card (one layer), not just the details
        r.tap(page, '#cardBody .more-toggle')
        r.wait(300)
        r.back(page)
        st = page.evaluate('() => ({ open: !document.getElementById("card").hidden, stack: __qa.stack(), url: location.href })')
        r.check('«Назад» из развёрнутой карточки закрывает её целиком', not st['open'] and not st['stack'] and st['url'].startswith(r.base), json.dumps(st, ensure_ascii=False))
        pick = open_point()
    # ✕
    r.tap(page, '#cardClose')
    r.wait(700)
    st = page.evaluate('() => ({ open: !document.getElementById("card").hidden, stack: __qa.stack(), hash: location.hash, sel: state.selected, ring: layers.select.getLayers().length })')
    r.check('✕ закрывает карточку, #pt= стирается', not st['open'] and not st['stack'] and '#pt=' not in st['hash'] and st['ring'] == 0, json.dumps(st, ensure_ascii=False))
    # Back
    pick = open_point()
    if pick:
        r.back(page)
        st = page.evaluate('() => ({ open: !document.getElementById("card").hidden, stack: __qa.stack(), url: location.href, mode: document.body.dataset.mode })')
        r.check('«Назад» закрывает ровно карточку и остаётся в приложении', not st['open'] and not st['stack'] and st['url'].startswith(r.base) and st['mode'] == 'browse', json.dumps(st, ensure_ascii=False))
    # tap on the empty map
    pick = open_point()
    if pick:
        pt = page.evaluate('() => __qa.emptyMapPoint()')
        if pt:
            r.tap_xy(page, pt['x'], pt['y'])
            r.wait(800)
            st = page.evaluate('() => ({ open: !document.getElementById("card").hidden, stack: __qa.stack() })')
            r.check('Тап по пустой карте закрывает карточку', not st['open'] and not st['stack'], f"тап ({pt['x']:.0f},{pt['y']:.0f}) → {st}")
        else:
            r.warn('Тап по пустой карте', 'не нашёл пустого места для тапа')
            r.tap(page, '#cardClose')
            r.wait(600)
    # a sheet over the card: Back closes the sheet only, then the card
    pick = open_point()
    if pick:
        r.tap(page, '#cardBody [data-act="point-more"]')
        page.wait_for_selector('#modal:not([hidden])', timeout=5000)
        r.wait(300)
        sh = r.shot(page, 'card-more-sheet')
        r.back(page)
        st1 = page.evaluate('() => ({ modal: !document.getElementById("modal").hidden, card: !document.getElementById("card").hidden, stack: __qa.stack() })')
        r.back(page)
        st2 = page.evaluate('() => ({ modal: !document.getElementById("modal").hidden, card: !document.getElementById("card").hidden, stack: __qa.stack() })')
        r.check('Лист «Ещё» над карточкой: «Назад» закрывает сначала лист, потом карточку', (not st1['modal'] and st1['card']) and (not st2['modal'] and not st2['card']),
                f'1-й «Назад»: {st1}; 2-й: {st2}', shot=sh)
    # a card opened from a page (Клёв › Места «На карте»)
    try:
        r.nav_to(page, 'guide', 'places')
        r.tap(page, '#pageBody [data-act="place-show"]')
        page.wait_for_selector('#card:not([hidden])', timeout=5000)
        r.wait(900)
        sh = r.shot(page, 'place-card-from-page')
        st0 = page.evaluate('() => ({ page: !document.getElementById("page").hidden, back: !document.getElementById("cardBack").hidden, stack: __qa.stack(), title: document.getElementById("cardTitle").textContent })')
        if compact:
            r.back(page)
            st1 = page.evaluate('() => ({ page: !document.getElementById("page").hidden, card: !document.getElementById("card").hidden, title: document.getElementById("pageTitle").textContent, stack: __qa.stack() })')
            r.check('Карточка из раздела: «Назад» возвращает в раздел', st1['page'] and not st1['card'] and st1['title'] == 'Клёв', f'до: {st0}; после: {st1}', shot=sh)
        else:
            r.check('Карточка из раздела открывается в панели со стрелкой «←»', st0['back'], json.dumps(st0, ensure_ascii=False), shot=sh)
            r.tap(page, '#cardBack')
            r.wait(700)
            st1 = page.evaluate('() => ({ page: !document.getElementById("page").hidden, card: !document.getElementById("card").hidden, title: document.getElementById("pageTitle").textContent, stack: __qa.stack() })')
            r.check('«←» в карточке возвращает к разделу', st1['page'] and not st1['card'], json.dumps(st1, ensure_ascii=False))
            r.tap(page, '#pageBody [data-act="place-show"]')
            page.wait_for_selector('#card:not([hidden])', timeout=5000)
            r.wait(600)
            r.tap(page, '#cardClose')
            r.wait(900)
            st2 = page.evaluate('() => ({ page: !document.getElementById("page").hidden, card: !document.getElementById("card").hidden, stack: __qa.stack() })')
            r.check('✕ в карточке из раздела закрывает всю панель', not st2['page'] and not st2['card'] and not st2['stack'], json.dumps(st2, ensure_ascii=False))
        r.back(page) if page.evaluate('() => ui.stack.length') else None
    except (PWError, PWTimeout) as e:
        r.check('Карточка из раздела Клёв › Места', False, f'сбой: {str(e)[:200]}')
    errs = r.errors(page)
    r.check('Сценарий карточки без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет')


SECTIONS = [('today', None, 'Сегодня'), ('guide', 'places', 'Клёв › Места'), ('guide', 'season', 'Клёв › Сезон'), ('guide', 'fish', 'Клёв › Рыба'),
            ('guide', 'tackle', 'Клёв › Снасти'), ('rules', None, 'Правила'), ('me', 'tracks', 'Моё › Треки'), ('me', 'points', 'Моё › Точки'),
            ('me', 'offline', 'Моё › Без сети'), ('me', 'more', 'Моё › Ещё')]


def s3_sections(r: Run):
    page = r.new_page()
    compact = r.p['layout'] == 'compact'
    for pg, sub, title in SECTIONS:
        slug = f'{pg}-{sub or "main"}'
        try:
            if page.evaluate('() => ui.stack.length'):
                r.back(page)
            h0 = page.evaluate('history.length')
            r.tap(page, f'#navBar [data-page="{pg}"]')
            page.wait_for_selector('#page:not([hidden])', timeout=6000)
            if sub:
                r.tap(page, f'#pageTabs [data-sub="{sub}"]')
            r.wait(700)
            st = page.evaluate('''() => { const b = document.getElementById('pageBody'); const tabs = [...document.querySelectorAll('#pageTabs [aria-selected="true"]')].map((x) => x.textContent);
                return { title: document.getElementById('pageTitle').textContent, tabs, len: b.innerText.length, sh: b.scrollHeight, ch: b.clientHeight, page: __qa.box(document.getElementById('page')),
                         body: __qa.box(b), hist: history.length, stack: __qa.stack(), mapui: __qa.vis(document.querySelector('.mu-top')) } }''')
            shot = r.shot(page, slug)
            ok = st['title'] == title.split(' › ')[0] and st['len'] > 150 and (not sub or st['tabs'] == [title.split(' › ')[1]])
            r.check(f'{title}: открывается и заполнен', ok, f"заголовок «{st['title']}», вкладка {st['tabs']}, текста {st['len']} симв., панель {fmt_box(st['page'])}", shot=shot)
            if compact:
                r.check(f'{title}: страница на весь экран над нижней панелью', st['page']['y'] <= 1 and st['page']['w'] >= r.p['vp'][0] - 1, fmt_box(st['page']), sev='мелочь')
            ov = page.evaluate('(s) => __qa.hOverflow(s)', '#pageBody')
            docbad = ov['doc']['sw'] > ov['doc']['cw'] + 1
            rootbad = ov['root']['sw'] > ov['root']['cw'] + 1
            r.check(f'{title}: нет прокрутки вбок', not docbad and not rootbad,
                    f"документ {ov['doc']['sw']}/{ov['doc']['cw']}, #pageBody {ov['root']['sw']}/{ov['root']['cw']}", data=ov)
            if ov['out']:
                r.check(f'{title}: ничего не вылезает за край', False, '; '.join(f"{o['n']} ({o['left']}…{o['right']} при крае {o['rootRight']})" for o in ov['out'][:5]), sev='серьёзно', data=ov['out'])
            cut = [c for c in ov['clipped'] if c['text']]
            if cut:
                r.warn(f'{title}: текст обрезан по ширине', '; '.join(f"{c['n'][:60]} {c['sw']}→{c['cw']} px" + (' (…)' if c['ellipsis'] else '') for c in cut[:6]), data=cut)
            if ov['scrollers']:
                r.info(f'{title}: полосы с прокруткой вбок', '; '.join(f"{s['n'][:50]} {s['sw']}/{s['cw']}" for s in ov['scrollers'][:6]))
            check_targets(r, page, title, ['#page'], sev='мелочь')
            # scrolling
            if st['sh'] > st['ch'] + 20:
                b = st['body']
                how = 'колесом'
                try:
                    page.mouse.move(b['x'] + b['w'] / 2, b['y'] + min(b['h'] / 2, 300))
                    page.mouse.wheel(0, 900)
                    r.wait(600)
                    top = page.evaluate('document.getElementById("pageBody").scrollTop')
                except PWError:
                    top, how = 0, 'колесо недоступно в мобильном WebKit'
                if top <= 0:
                    page.evaluate('document.getElementById("pageBody").scrollTop = 900')
                    r.wait(300)
                    top = page.evaluate('document.getElementById("pageBody").scrollTop')
                    how = 'программно (scrollTop)' + ('; колесо недоступно в мобильном WebKit' if 'недоступно' in how else '; колесо не прокрутило')
                r.check(f'{title}: прокручивается', top > 0, f"scrollHeight {st['sh']} при высоте {st['ch']}; прокрутка {how}: {top:.0f}px", sev='серьёзно')
                page.evaluate('() => { const b = document.getElementById("pageBody"); b.scrollTop = b.scrollHeight; }')
                r.wait(400)
                end = page.evaluate('''() => { const b = document.getElementById('pageBody'); const kids = [...b.children].filter(__qa.vis); const last = kids[kids.length - 1];
                    const nb = document.getElementById('navBar'); const lim = __qa.vis(nb) && document.body.dataset.layout === 'compact' ? nb.getBoundingClientRect().top : innerHeight;
                    return { last: last ? __qa.box(last) : null, lim, name: last ? __qa.name(last) : '' } }''')
                shb = r.shot(page, slug + '-bottom')
                if end['last']:
                    r.check(f'{title}: низ страницы доступен (не под панелью)', end['last']['b'] <= end['lim'] + 1, f"последний блок {end['name'][:60]} низ {end['last']['b']:.0f}, граница {end['lim']:.0f}", shot=shb, sev='серьёзно')
            r.back(page)
            bk = page.evaluate('() => ({ page: !document.getElementById("page").hidden, stack: __qa.stack(), cur: document.querySelector("#navBar [aria-current=page]")?.dataset.page, url: location.href })')
            r.check(f'{title}: «Назад» возвращает на карту', not bk['page'] and not bk['stack'] and bk['cur'] == 'map' and bk['url'].startswith(r.base), json.dumps(bk, ensure_ascii=False))
        except (PWError, PWTimeout) as e:
            r.check(f'{title}: сценарий', False, f'сбой: {str(e)[:300]}', sev='серьёзно', shot=r.shot(page, slug + '-error'))
    # Back from a section goes to the map, even after switching sections (replaceState between them)
    try:
        if page.evaluate('() => ui.stack.length'):
            r.back(page)
        r.tap(page, '#navBar [data-page="today"]')
        r.wait(400)
        r.tap(page, '#navBar [data-page="guide"]')
        r.wait(400)
        r.tap(page, '#navBar [data-page="rules"]')
        r.wait(400)
        r.back(page)
        st = page.evaluate('() => ({ page: !document.getElementById("page").hidden, stack: __qa.stack(), cur: document.querySelector("#navBar [aria-current=page]")?.dataset.page, url: location.href })')
        r.check('Сегодня → Клёв → Правила → «Назад» = карта', not st['page'] and st['cur'] == 'map' and not st['stack'] and st['url'].startswith(r.base), json.dumps(st, ensure_ascii=False))
        fill = page.evaluate(JS_MAPFILL)
        m, e = fill['map'], fill['exp']
        ok = abs(m['x'] - e['left']) <= 1 and abs(m['r'] - e['right']) <= 1 and abs(fill['leaflet']['x'] - m['w']) <= 1
        r.check('После закрытия раздела карта снова во всю ширину', ok, f"#map {fmt_box(m)}, Leaflet {fill['leaflet']['x']}×{fill['leaflet']['y']}")
        # «Карта» in the bar closes a page
        r.tap(page, '#navBar [data-page="me"]')
        r.wait(400)
        r.tap(page, '#navBar [data-page="map"]')
        r.wait(800)
        st = page.evaluate('() => ({ page: !document.getElementById("page").hidden, stack: __qa.stack() })')
        r.check('«Карта» в панели закрывает раздел', not st['page'] and not st['stack'], json.dumps(st, ensure_ascii=False))
        if not compact:
            r.tap(page, '#navBar [data-page="today"]')
            r.wait(400)
            r.tap(page, '#navBar [data-page="today"]')
            r.wait(800)
            st = page.evaluate('() => ({ page: !document.getElementById("page").hidden, stack: __qa.stack() })')
            r.check('Повторный тап по активному пункту рейки сворачивает панель', not st['page'], json.dumps(st, ensure_ascii=False), sev='мелочь')
    except (PWError, PWTimeout) as e:
        r.check('Разделы: «Назад» и «Карта»', False, f'сбой: {str(e)[:300]}')
    errs = r.errors(page)
    r.check('Разделы без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет')


def modal_state(page):
    return page.evaluate('''() => { const m = document.getElementById('modal'); const s = m.querySelector('.modal-sheet');
        return { open: !m.hidden, cls: m.className, title: document.getElementById('modalTitle').textContent, sheet: __qa.box(s), vw: innerWidth, vh: innerHeight,
          body: __qa.box(document.getElementById('modalBody')), foot: __qa.vis(document.getElementById('modalFoot')) ? __qa.box(document.getElementById('modalFoot')) : null,
          sh: document.getElementById('modalBody').scrollHeight, ch: document.getElementById('modalBody').clientHeight, stack: __qa.stack() } }''')


def s4_sheets(r: Run):
    page = r.new_page()
    desktop = not r.p['touch']
    # --- layers and filter ---
    try:
        r.tap(page, '#btnLayers')
        page.wait_for_selector('#modal:not([hidden])', timeout=5000)
        r.wait(500)
        ms = modal_state(page)
        shot = r.shot(page, 'layers')
        s = ms['sheet']
        inside = s['x'] >= -1 and s['y'] >= -1 and s['r'] <= ms['vw'] + 1 and s['b'] <= ms['vh'] + 1
        r.check('Лист «Слои и фильтр» открыт и целиком на экране', ms['open'] and ms['title'] == 'Слои и фильтр' and inside, f"лист {fmt_box(s)}; подвал {fmt_box(ms['foot']) if ms['foot'] else 'нет'}", shot=shot)
        check_targets(r, page, 'Слои', ['#modal'], sev='мелочь')
        bt = page.evaluate('''() => [...document.querySelectorAll('#modalBody .base-tile')].map((b) => ({ t: b.textContent.trim(), sh: b.scrollHeight, ch: b.clientHeight,
            thumb: getComputedStyle(b).backgroundImage !== 'none' }))''')
        over = [b for b in bt if b['sh'] > b['ch'] + 1]
        if over:
            r.warn('Слои: подписи подложек не влезают в плитку', '; '.join(f"«{b['t']}» {b['sh']} px текста в плитке {b['ch']} px" for b in over), shot=shot)
        nothumb = [b['t'] for b in bt if not b['thumb']]
        if nothumb:
            r.warn('Слои: подложки без превью', ', '.join(f'«{t}»' for t in nothumb), shot=shot)
        ov = page.evaluate('(s) => __qa.hOverflow(s)', '#modalBody')
        if ov and (ov['out'] or ov['root']['sw'] > ov['root']['cw'] + 1):
            r.check('Слои: ничего не вылезает вбок', False, '; '.join(f"{o['n']}" for o in ov['out'][:4]) + f" · тело {ov['root']['sw']}/{ov['root']['cw']}", data=ov)
        r.tap(page, '#modalBody [data-sheet-tab="filter"]')
        r.wait(500)
        txt = page.evaluate('document.getElementById("modalBody").innerText')
        shf = r.shot(page, 'filter')
        r.check('Вкладка «Фильтр»', 'Рыба' in txt and 'Месяц отчёта' in txt and 'Что показывать' in txt, 'есть Рыба, Месяц отчёта, Что показывать' if 'Рыба' in txt else txt[:120], shot=shf)
        check_targets(r, page, 'Фильтр', ['#modal'], sev='мелочь')
        ov = page.evaluate('(s) => __qa.hOverflow(s)', '#modalBody')
        if ov and (ov['out'] or ov['root']['sw'] > ov['root']['cw'] + 1):
            r.check('Фильтр: ничего не вылезает вбок', False, '; '.join(f"{o['n']} ({o['left']}…{o['right']})" for o in ov['out'][:4]) + f" · тело {ov['root']['sw']}/{ov['root']['cw']}", data=ov)
        r.tap(page, '#modalBody [data-sheet-tab="layers"]')
        r.wait(400)
        for key, label in [('depth', 'Глубины'), ('chart', 'Карта ГУНиО'), ('now', 'Рыбалка сейчас'), ('clean', 'Чистая карта')]:
            n0 = len(r.log)
            if page.evaluate('document.getElementById("modal").hidden'):
                r.tap(page, '#btnLayers')
                page.wait_for_selector('#modal:not([hidden])', timeout=5000)
                r.wait(300)
            r.tap(page, f'#modalBody [data-preset="{key}"]')
            r.wait(700)
            st = page.evaluate('''() => ({ o: Object.fromEntries(Object.entries(state.overlays).filter(([k, v]) => v === true)), z: map.getZoom(), toast: document.getElementById('toast').classList.contains('show') ? document.getElementById('toastText').textContent : '',
                filters: activeFilters().map((x) => x[1]), stillOpen: !document.getElementById('modal').hidden })''')
            r.tap(page, '#modalFoot [data-act="close-top"]')
            r.wait(2200)
            chips = page.evaluate('''() => [...document.querySelectorAll('#statusChips .schip')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim())''')
            shp = r.shot(page, f'preset-{key}')
            check_chips(r, page, f'Пресет «{label}»', shot=shp)
            errs = r.errors(page, n0)
            exp = {'depth': ('shade', 'gridIso'), 'chart': ('charts',), 'now': ('seasonZones',), 'clean': ('cluster',)}[key]
            ok = all(st['o'].get(x) for x in exp) and not errs
            r.check(f'Пресет «{label}»', ok, f"слои {sorted(st['o'])}, масштаб {st['z']}, фильтр {st['filters']}, тост «{st['toast'][:80]}», чипы {chips}" + (f"; ошибки: {errs[:2]}" if errs else ''), shot=shp)
    except (PWError, PWTimeout) as e:
        r.check('Лист «Слои и фильтр»', False, f'сбой: {str(e)[:300]}', shot=r.shot(page, 'layers-error'))
    # --- search ---
    try:
        if page.evaluate('() => ui.stack.length'):
            r.back(page)
        r.tap(page, '#searchBtn')
        page.wait_for_selector('#searchInput', timeout=5000)
        r.wait(400)
        ms = modal_state(page)
        dflt = page.evaluate('document.getElementById("searchResults").innerText.slice(0, 300)')
        focus = page.evaluate('document.activeElement && document.activeElement.id')
        r.check('Поиск: полноэкранный лист, список по умолчанию', ms['open'] and 'Вся южная Ладога' in dflt and 'Районы' in dflt, f"лист {fmt_box(ms['sheet'])}, фокус в поле: {focus == 'searchInput'}")
        page.locator('#searchInput').press_sequentially('варец', delay=60)
        r.wait(600)
        res = page.evaluate('''() => [...document.querySelectorAll('#searchResults [data-search]')].map((b) => ({ s: b.dataset.search, t: b.innerText.replace(/\\s+/g, ' ').trim() }))''')
        shs = r.shot(page, 'search-varec')
        r.check('Поиск «варец» находит Варецкие банки', any('Варец' in x['t'] for x in res), ' | '.join(x['t'][:50] for x in res[:6]) or 'пусто', shot=shs)
        if res:
            first = res[0]
            r.tap(page, f'#searchResults [data-search="{first["s"]}"]')
            r.wait(1500)
            st = page.evaluate('() => ({ modal: !document.getElementById("modal").hidden, card: !document.getElementById("card").hidden, title: document.getElementById("cardTitle").textContent, c: map.getCenter(), z: map.getZoom(), stack: __qa.stack() })')
            shp = r.shot(page, 'search-picked')
            near = dist_m((st['c']['lat'], st['c']['lng']), (60.298, 32.107)) < 4000
            r.check('Выбор результата: лист закрыт, карта у Варецких банок', not st['modal'] and (st['card'] or near),
                    f"«{first['t'][:40]}» → карточка: {st['card']} «{st['title']}», центр {st['c']['lat']:.3f},{st['c']['lng']:.3f} z{st['z']}, стек {st['stack']}", shot=shp)
            if st['card']:
                r.back(page)
                st2 = page.evaluate('() => ({ modal: !document.getElementById("modal").hidden, card: !document.getElementById("card").hidden, stack: __qa.stack() })')
                r.check('«Назад» после выбора из поиска закрывает карточку, не возвращает поиск', not st2['card'] and not st2['modal'], json.dumps(st2, ensure_ascii=False), sev='мелочь')
    except (PWError, PWTimeout) as e:
        r.check('Поиск', False, f'сбой: {str(e)[:300]}', shot=r.shot(page, 'search-error'))
    # --- SOS ---
    try:
        if page.evaluate('() => ui.stack.length'):
            r.back(page)
        r.tap(page, '#btnSos')
        page.wait_for_selector('#modal.sos:not([hidden])', timeout=5000)
        r.wait(500)
        ms = modal_state(page)
        shot = r.shot(page, 'sos')
        s = ms['sheet']
        inside = s['x'] >= -1 and s['y'] >= -1 and s['r'] <= ms['vw'] + 1 and s['b'] <= ms['vh'] + 1
        call = page.evaluate('''() => { const a = document.querySelector('#modalBody a.sos-call'); const b = document.getElementById('modalBody').getBoundingClientRect();
            return a ? { box: __qa.box(a), href: a.getAttribute('href'), inBody: a.getBoundingClientRect().bottom <= b.bottom + 1 && a.getBoundingClientRect().top >= b.top - 1, cov: __qa.coveredBy(a) } : null }''')
        r.check('SOS: лист целиком на экране', ms['open'] and inside, f"лист {fmt_box(s)} при экране {ms['vw']}×{ms['vh']}", shot=shot)
        r.check('SOS: «Позвонить 112» видна сразу, без прокрутки, ≥ 56 px', bool(call) and call['inBody'] and not call['cov'] and call['box']['h'] >= 56 and call['href'] == 'tel:112',
                json.dumps(call, ensure_ascii=False))
        close = page.evaluate('() => ({ box: __qa.box(document.getElementById("modalClose")), vis: __qa.vis(document.getElementById("modalClose")), cov: __qa.coveredBy(document.getElementById("modalClose")) })')
        r.check('SOS: ✕ видна и доступна', close['vis'] and not close['cov'], json.dumps(close, ensure_ascii=False))
        phones = page.evaluate('''() => [...document.querySelectorAll('#modalBody .phone-row')].map((a, i) => { a.scrollIntoView({ block: 'center' }); const body = document.getElementById('modalBody').getBoundingClientRect(); const r = a.getBoundingClientRect();
            return { i, href: a.getAttribute('href'), text: a.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60), h: Math.round(r.height), inView: r.top >= body.top - 1 && r.bottom <= body.bottom + 1, cov: __qa.coveredBy(a) }; })''')
        r.wait(300)
        shp = r.shot(page, 'sos-phones')
        badp = [p for p in phones if not p['inView'] or p['cov'] or p['h'] < 44]
        r.check('SOS: все телефоны досягаемы прокруткой, строки ≥ 44 px', phones and not badp, f"{len(phones)} телефонов; " + ('; '.join(f"{p['text']} h{p['h']} cov={p['cov']}" for p in badp[:4]) or ', '.join(p['text'][:24] for p in phones[:6])), shot=shp)
        page.evaluate('() => { const b = document.getElementById("modalBody"); b.scrollTop = b.scrollHeight; }')
        r.wait(300)
        r.shot(page, 'sos-bottom')
        r.back(page)
        r.check('SOS закрывается «Назад»', page.evaluate('document.getElementById("modal").hidden'), '')
    except (PWError, PWTimeout) as e:
        r.check('SOS', False, f'сбой: {str(e)[:300]}', shot=r.shot(page, 'sos-error'))
    # --- install help ---
    try:
        r.nav_to(page, 'me', 'more')
        btn = page.locator('#pageBody [data-act="install"]')
        if btn.count():
            label = btn.first.inner_text()
            r.tap(page, '#pageBody [data-act="install"]')
            page.wait_for_selector('#modal:not([hidden])', timeout=5000)
            r.wait(400)
            ms = modal_state(page)
            txt = page.evaluate('document.getElementById("modalBody").innerText')
            shot = r.shot(page, 'install-help')
            plat = 'iOS' if r.p['ios'] else 'Android' if 'Android' in r.ua else 'ПК'
            expect = {'iOS': 'На экран', 'Android': 'Установить приложение', 'ПК': 'Установить Ладога'}[plat]
            r.check('Помощь по установке', ms['open'] and ms['title'] == 'Установить приложение' and expect in txt,
                    f"кнопка «{label.strip()}», платформа {plat}, шаги: {txt[:160]!r}", shot=shot)
            if plat == 'ПК' and 'телефон' in label:
                r.warn('Кнопка установки на ПК', f"на Windows кнопка называется «{label.strip()}» — «на телефон»")
            r.back(page)
        else:
            r.warn('Помощь по установке', 'нет кнопки install в Моё › Ещё')
    except (PWError, PWTimeout) as e:
        r.check('Помощь по установке', False, f'сбой: {str(e)[:300]}')
    # --- keys (desktop) ---
    if desktop:
        try:
            while page.evaluate('() => ui.stack.length'):
                r.back(page)
            page.mouse.click(5, 5) if False else None
            page.keyboard.press('Shift+Slash')
            page.wait_for_selector('#modal:not([hidden])', timeout=4000)
            r.wait(300)
            ms = modal_state(page)
            shot = r.shot(page, 'keys')
            r.check('«?» открывает список клавиш', ms['title'] == 'Клавиши', ms['title'], shot=shot)
            page.keyboard.press('Escape')
            r.wait(500)
            r.check('Esc закрывает список клавиш', page.evaluate('document.getElementById("modal").hidden'), '')
            if page.locator('#railKeys').is_visible():
                r.tap(page, '#railKeys')
                r.wait(400)
                r.check('Кнопка «Клавиши» в рейке', modal_state(page)['title'] == 'Клавиши', '')
                page.keyboard.press('Escape')
                r.wait(400)
        except (PWError, PWTimeout) as e:
            r.check('Список клавиш', False, f'сбой: {str(e)[:300]}')
    errs = r.errors(page)
    r.check('Листы без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет')


def choose_start(page, tgt, d):
    """A start over charted water: the depth model answers both at the start and half way."""
    best = None
    for brg in (200, 160, 240, 120, 280, 20, 60, 320, 0, 90, 180, 270):
        s = dest(tgt[0], tgt[1], brg, d)
        mid = dest(tgt[0], tgt[1], brg, d / 2)
        page.evaluate('([a, b, c, e]) => { depthAt({ lat: a, lon: b }); depthAt({ lat: c, lon: e }); }', [s[0], s[1], mid[0], mid[1]])
    page.wait_for_timeout(1500)
    for brg in (200, 160, 240, 120, 280, 20, 60, 320, 0, 90, 180, 270):
        s = dest(tgt[0], tgt[1], brg, d)
        mid = dest(tgt[0], tgt[1], brg, d / 2)
        ok = page.evaluate('([a, b, c, e]) => !!(depthAt({ lat: a, lon: b })?.model && depthAt({ lat: c, lon: e })?.model)', [s[0], s[1], mid[0], mid[1]])
        if ok:
            return s, (brg + 180) % 360
        if best is None:
            best = (s, (brg + 180) % 360)
    return best


def start_nav_to_point(r: Run, page, dist_m_start):
    r.view(page, *PTINOV, 13)
    pick = page.evaluate('() => __qa.pickMarker(40)')
    if not pick:
        return None
    r.tap_xy(page, pick['x'], pick['y'])
    page.wait_for_selector('#card:not([hidden])', timeout=6000)
    r.wait(700)
    tgt = page.evaluate('() => { const m = state.M[state.selected]; return { lat: m.lat, lon: m.lon, title: pointTitle(m), kind: m.kind } }')
    start, course = choose_start(page, (tgt['lat'], tgt['lon']), dist_m_start)
    r.gps = Gps(r.ctx, [start, (tgt['lat'], tgt['lon'])], speed_kmh=20)
    r.gps.start()
    near = page.evaluate('([a, b]) => hazards().filter((h) => distM(h, { lat: a, lon: b }) < 400).map((h) => h.name + " " + Math.round(distM(h, { lat: a, lon: b })) + " м")', [tgt['lat'], tgt['lon']])
    r.info('Цель навигации', f"«{tgt['title']}» ({tgt['kind']}) {tgt['lat']:.5f},{tgt['lon']:.5f}; старт {dist_m_start} м, курс {course:.0f}°; мели ≤ 400 м от цели: {near or 'нет'}")
    r.tap(page, '#cardBody [data-act="nav"]')
    page.wait_for_selector('#navTop:not([hidden])', timeout=6000)
    tgt['course'] = course
    tgt['start'] = start
    return tgt


def chromium_metrics(r: Run, page, gc=False):
    if r.p['engine'] != 'chromium':
        return {'dom': page.evaluate('document.getElementsByTagName("*").length')}
    cdp = r.ctx.new_cdp_session(page)
    try:
        if gc:
            cdp.send('HeapProfiler.collectGarbage')
        cdp.send('Performance.enable')
        m = {x['name']: x['value'] for x in cdp.send('Performance.getMetrics')['metrics']}
        return {'dom': page.evaluate('document.getElementsByTagName("*").length'), 'heapUsedMB': round(m.get('JSHeapUsedSize', 0) / 1048576, 1),
                'heapTotalMB': round(m.get('JSHeapTotalSize', 0) / 1048576, 1), 'nodes': int(m.get('Nodes', 0)), 'listeners': int(m.get('JSEventListeners', 0)),
                'layouts': int(m.get('LayoutCount', 0)), 'styleRecalcs': int(m.get('RecalcStyleCount', 0)), 'taskSec': round(m.get('TaskDuration', 0), 1)}
    finally:
        try:
            cdp.detach()
        except Exception:  # noqa: BLE001
            pass


def s5_nav(r: Run):
    long_run = r.key in LONG_NAV
    page = r.new_page(geo=(60.2, 32.2))
    tgt = start_nav_to_point(r, page, 760 if long_run else 480)
    if not r.check('«Вести» из карточки точки открывает навигацию', bool(tgt), '' if tgt else 'не нашёл точку', sev='блокер'):
        return
    t_nav = time.time()
    lt0 = page.evaluate('() => ({ lt: __qa.longtasks.length, gaps: __qa.gaps.length })')
    r.wait(4000)
    m0 = chromium_metrics(r, page, gc=True)
    r.wait(5000)
    a = page.evaluate(JS_NAVSNAP)
    r.wait(2500)
    b = page.evaluate(JS_NAVSNAP)
    shot = r.shot(page, 'nav-hud')
    da, db = parse_dist(a['dist']), parse_dist(b['dist'])
    r.check('HUD: расстояние уменьшается', da and db and db < da, f"{a['dist']} → {b['dist']} за 2,5 с", shot=shot)
    sp = parse_num(b['speed'])
    r.check('HUD: скорость ≈ 20 км/ч', sp is not None and 16 <= sp <= 24 and b['speedUnit'] == 'км/ч', f"«{b['speed']} {b['speedUnit']}»")
    cv = parse_num(b['course'])
    dev = abs(((cv or 0) - tgt['course'] + 540) % 360 - 180) if cv is not None else None
    r.check('HUD: курс по GPS', cv is not None and dev <= 12 and 'по GPS' in b['courseSrc'], f"«{b['course']}» «{b['courseSrc']}», истинный {tgt['course']:.0f}°")
    r.check('HUD: пеленг и время прибытия', bool(re.search(r'на \d+° .+ · в \d\d:\d\d \(', b['line2'])), f"«{b['line2']}»")
    r.check('HUD: глубина под лодкой', b['depth'] not in ('', '—'), f"«{b['depth']} {b['depthUnit']}»{' (оранжевое: мелко)' if b['shallow'] else ''}")
    r.check('HUD: точность GPS', '±5' in b['gps'], f"«{b['gps']}»", sev='мелочь')
    # 25.09.2026 (owner): the points stay on the map in navigation — «невозможно ни посмотреть, ни точку».
    r.check('В навигации точки рыбаков на карте', b['clusterOn'] or b['hits'] > 0, f"видимых точек {b['hits']}, кластеры на карте: {b['clusterOn']}, POI: {b['poisOn']}")
    r.check('В навигации нет поиска, чипов и нижней панели; SOS, +/−, компас есть', not b['navBar'] and not b['search'] and not b['chips'] and b['sos'] and b['zoomIn'] and b['compass'],
            f"панель {b['navBar']}, поиск {b['search']}, чипы {b['chips']}, SOS {b['sos']}, +/− {b['zoomIn']}, компас {b['compass']}")
    rotated = b['follow'] == 'course' and b['courseRot']
    ys = b['boatShareY']
    r.check('Лодка в нижней трети (карта по курсу)', rotated and ys is not None and ys >= 0.62 and 0.35 <= b['boatShareX'] <= 0.65,
            f"слежение {b['follow']}, поворот {b['bearing']}°, лодка на {ys * 100 if ys is not None else 0:.0f} % высоты свободной области ({b['boat']}, область {b['fr']}), масштаб {b['zoom']}", shot=shot)
    check_overlaps(r, page, 'Навигация', 'nav', sels=NAV_SELS)
    # The panels were slimmed at the owner's request (24–25.09.2026): 52 px buttons, still well above 48.
    check_targets(r, page, 'Навигация (≥ 52 после облегчения панелей)', ['#navBottom'], min_px=52, sev='мелочь')
    check_targets(r, page, 'Навигация', ['#navTop', '#navBottom', '#mapUi', '#navBanner'], sev='серьёзно')
    # drag → «Вернуться ко мне», auto-return after 15 s
    fr = b['fr']
    cx, cy = (fr['left'] + fr['right']) / 2, (fr['top'] + fr['bottom']) / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    for i in range(1, 11):
        page.mouse.move(cx + 14 * i, cy - 10 * i)
        page.wait_for_timeout(16)
    page.mouse.up()
    t_drag = time.time()
    r.wait(500)
    c = page.evaluate(JS_NAVSNAP)
    shd = r.shot(page, 'nav-dragged')
    r.check('Сдвиг карты → «Вернуться ко мне»', c['recenter'] and c['follow'] == 'free', f"пилюля {c['recenter']} «{c['recenterText']}», слежение {c['follow']}", shot=shd)
    seen_count, t_back = False, None
    while time.time() - t_drag < 26:
        r.wait(400)
        s = page.evaluate('() => ({ v: !document.getElementById("recenter").hidden, t: document.getElementById("recenterText").textContent, f: geo.follow })')
        if s['v'] and '·' in s['t']:
            seen_count = True
        if not s['v'] and s['f'] != 'free':
            t_back = time.time() - t_drag
            break
    # 25.09.2026: the default is 20 s counted from the moment the finger is lifted (it was 15 s from the touch).
    r.check('Автовозврат к лодке ≈ через 20 с после отпускания', t_back is not None and 18.5 <= t_back <= 23.5, f"вернулась через {t_back:.1f} с" if t_back else 'не вернулась за 26 с')
    r.check('Отсчёт «Вернуться ко мне · 3…» перед возвратом', seen_count, 'был' if seen_count else 'не видел', sev='мелочь')
    # +/− pauses auto-zoom
    z0 = page.evaluate('map.getZoom()')
    r.tap(page, '#zoomIn')
    r.wait(900)
    c = page.evaluate(JS_NAVSNAP)
    r.check('«+» в навигации: масштаб +1, автомасштаб на паузе, «Авто» не залито', c['zoom'] == z0 + 1 and c['autoZoomPaused'] and not c['zoomAuto'],
            f"z {z0}→{c['zoom']}, пауза {c['autoZoomPaused']}, «авто» {c['zoomAuto']}, пилюля {c['recenter']}", shot=r.shot(page, 'nav-zoomed'))
    r.wait(6000)
    z2 = page.evaluate('map.getZoom()')
    r.check('Автомасштаб не перебивает ручной масштаб', z2 == z0 + 1, f"через 6 с масштаб {z2}")
    t_zoom = time.time()
    while time.time() - t_zoom < 16:
        r.wait(500)
        if not page.evaluate('nav.autoZoomPaused'):
            break
    c = page.evaluate(JS_NAVSNAP)
    # 25.09.2026: the zoom chosen by hand stays theirs until «Авто» is pressed (it came back by itself before).
    r.check('После возврата масштаб остаётся ручным', c['autoZoomPaused'] and not c['zoomAuto'], f"пауза {c['autoZoomPaused']}, «авто» {c['zoomAuto']} через {time.time() - t_zoom + 6.9:.0f} с после «+»", sev='мелочь')
    # Back asks
    r.back(page)
    c = page.evaluate(JS_NAVSNAP)
    shb = r.shot(page, 'nav-back-asks')
    r.check('«Назад» в навигации спрашивает, а не завершает', c['modal'] and 'Завершить навигацию' in c['modalTitle'] and c['mode'] == 'nav', f"лист «{c['modalTitle']}», режим {c['mode']}", shot=shb)
    if c['modal']:
        r.tap(page, '#modalFoot [data-act="nav-continue"]')
        r.wait(600)
        c = page.evaluate(JS_NAVSNAP)
        r.check('«Продолжить» оставляет навигацию', not c['modal'] and c['mode'] == 'nav', f"режим {c['mode']}")
        r.back(page)
        c = page.evaluate(JS_NAVSNAP)
        r.check('Повторный «Назад» снова спрашивает', c['modal'] and c['mode'] == 'nav', f"лист {c['modal']} «{c['modalTitle']}»")
        if c['modal']:
            r.tap(page, '#modalFoot [data-act="nav-continue"]')
            r.wait(500)
    # 2 minutes of navigation: numbers
    if long_run:
        left = 120 - (time.time() - t_nav)
        if left > 0:
            r.wait(left * 1000)
        m1 = chromium_metrics(r, page)
        m1gc = chromium_metrics(r, page, gc=True)
        lt = page.evaluate('([a, b]) => ({ lt: __qa.longtasks.slice(a), gaps: __qa.gaps.slice(b), ltOn: __qa.lt })', [lt0['lt'], lt0['gaps']])
        r.perf['nav2min'] = {'t0': m0, 't120': m1, 't120_after_gc': m1gc, 'longtasks>50ms': len(lt['lt']), 'longtasks>200ms': [x for x in lt['lt'] if x[1] > 200],
                             'raf_gaps>200ms': lt['gaps'], 'longtask_api': lt['ltOn'], 'seconds': round(time.time() - t_nav)}
        r.info('2 минуты навигации', json.dumps(r.perf['nav2min'], ensure_ascii=False)[:400])
    # arrival within 30 m
    t_a = time.time()
    arrived = None
    while time.time() - t_a < 150:
        r.wait(700)
        c = page.evaluate(JS_NAVSNAP)
        if 'ok' in c['bannerCls'].split():
            arrived = c
            break
    if arrived:
        dleft = dist_m(r.gps.pos, (tgt['lat'], tgt['lon']))
        sha = r.shot(page, 'nav-arrived')
        btns = page.evaluate('''() => [...document.querySelectorAll('#navBanner button')].map((b) => ({ t: b.textContent, h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width) }))''')
        r.check('Прибытие ≤ 30 м: зелёная плашка', arrived['navD'] is not None and arrived['navD'] <= 31, f"«{arrived['banner']}» при {arrived['navD']:.0f} м (лодка {dleft:.0f} м от цели); кнопки {btns}", shot=sha)
        check_overlaps(r, page, 'Навигация: плашка прибытия', 'nav-arrived', sels=NAV_SELS)
        small = [x for x in btns if x['h'] < 48]
        if small:
            r.warn('Кнопки плашки прибытия', f'ниже 48 px: {small}', sev='мелочь')
        if page.locator('#navBanner [data-act="nav-hold"]').count():
            r.tap(page, '#navBanner [data-act="nav-hold"]')
            r.wait(1500)
            c = page.evaluate(JS_NAVSNAP)
            # since 24.09.2026 the big figure stays a distance («4 м») and the line under it says «Снос: ЗЮЗ от точки»
            r.check('«Держать точку»: снос вместо расстояния', 'Держу точку' in c['banner'] and (c['dist'].startswith('Снос') or c['line2'].startswith('Снос')), f"«{c['banner']}», «{c['dist']}», «{c['line2']}», z{c['zoom']}", shot=r.shot(page, 'nav-hold'))
            check_overlaps(r, page, 'Навигация: «Держу точку»', 'nav-hold', sels=NAV_SELS)
    else:
        c = page.evaluate(JS_NAVSNAP)
        r.check('Прибытие ≤ 30 м: зелёная плашка', False, f"плашки нет за 150 с; расстояние {c['dist']}, nav.d={c['navD']}, плашка «{c['banner']}» ({c['bannerCls']})", sev='серьёзно', shot=r.shot(page, 'nav-no-arrival'))
    # «Завершить» asks, then ends
    r.tap(page, '#navEnd')
    r.wait(500)
    c = page.evaluate(JS_NAVSNAP)
    she = r.shot(page, 'nav-end-ask')
    r.check('«Завершить» спрашивает подтверждение', c['modal'] and 'Завершить навигацию' in c['modalTitle'], f"«{c['modalTitle']}»", shot=she)
    if c['modal']:
        r.tap(page, '#modalFoot [data-act="nav-end"]')
        r.wait(1200)
        st = page.evaluate('''() => ({ mode: document.body.dataset.mode, nav: nav.on, stack: __qa.stack(), bar: __qa.vis(document.getElementById('navBar')), cluster: map.hasLayer(layers.cluster),
            bearing: Math.round(map.getBearing()), follow: geo.follow, hits: [...document.querySelectorAll('.leaflet-marker-icon.hit')].filter(__qa.vis).length, saved: localStorage.getItem('ladoga-nav') })''')
        r.check('После «Завершить»: обзор, точки снова на карте, север вверх', st['mode'] == 'browse' and not st['nav'] and not st['stack'] and st['bar'] and st['cluster'] and st['bearing'] == 0,
                json.dumps(st, ensure_ascii=False), shot=r.shot(page, 'nav-ended'))
        r.back(page)
        if not page.url.startswith(r.base):
            r.check('«Назад» после завершения: навигация не возвращается, из корня — выход', True, f'следующий «Назад» ушёл со страницы ({page.url}) — как выход из приложения на Android')
        else:
            st2 = page.evaluate('() => ({ mode: document.body.dataset.mode, url: location.href, nav: nav.on })')
            r.check('«Назад» после завершения не возвращает навигацию', st2['mode'] == 'browse' and not st2['nav'], json.dumps(st2, ensure_ascii=False), sev='мелочь')
    errs = [e for e in r.errors(page) if not (e['type'] == 'error' and 'Geolocation' in e['text'])]
    r.check('Навигация без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет')


def saver_check(r: Run, page, sel, where):
    """«Погасить экран»: record when #saver appears and disappears (it may flash and vanish)."""
    page.evaluate('''() => { window.__qaSaver = []; const t0 = performance.now(); let was = !!document.getElementById('saver');
        const mo = new MutationObserver(() => { const s = !!document.getElementById('saver'); if (s !== was) { was = s; __qaSaver.push([Math.round(performance.now() - t0), s]); } });
        mo.observe(document.body, { childList: true }); window.__qaSaverMo = mo; }''')
    r.tap(page, sel)
    r.wait(1800)
    tl = page.evaluate('() => { __qaSaverMo.disconnect(); return { tl: __qaSaver, now: !!document.getElementById("saver"), hist: history.length, stack: __qa.stack(), modal: !document.getElementById("modal").hidden } }')
    appeared = any(x[1] for x in tl['tl'])
    if tl['now']:
        r.check(f'«Погасить экран» {where}: чёрный экран держится', True, f"таймлайн {tl['tl']}")
    else:
        r.check(f'«Погасить экран» {where}: чёрный экран держится', False,
                (f"экран появился и через {tl['tl'][1][0] - tl['tl'][0][0] if len(tl['tl']) > 1 else '?'} мс исчез сам" if appeared else 'чёрный экран не появился')
                + f"; таймлайн (мс, есть ли #saver): {tl['tl']}; стек {tl['stack']}", sev='серьёзно', shot=r.shot(page, 'saver-gone'))
    return tl['now']


def s6_demo(r: Run):
    page = r.new_page()
    full = r.key in FULL_DEMO
    r.nav_to(page, 'me', 'more')
    lt0 = page.evaluate('() => ({ lt: __qa.longtasks.length, gaps: __qa.gaps.length })')
    r.tap(page, '#pageBody [data-act="demo"]')
    try:
        page.wait_for_selector('#navTop:not([hidden])', timeout=6000)
    except PWTimeout:
        r.check('«Запустить демо» открывает навигацию', False, 'навигация не открылась', sev='блокер', shot=r.shot(page, 'demo-fail'))
        return
    t0 = time.time()
    r.wait(3000)
    c = page.evaluate(JS_NAVSNAP)
    r.check('Демо: навигация с «лодкой»', c['mode'] == 'nav' and c['gps'] == 'ДЕМО' and c['dist'] not in ('', '—'), f"{c['dist']} · {c['line2']} · GPS «{c['gps']}» · {c['speed']} км/ч", shot=r.shot(page, 'demo-start'))
    r.check('Демо: ярлык «ДЕМО · лодка идёт сама» на экране', c['demoTag'], 'виден' if c['demoTag'] else '#demoTag есть в разметке, но скрыт всё демо (его никто не показывает)', sev='мелочь')
    timeline, seen = [], {}
    limit = 300 if full else 45
    last_banner = None
    while time.time() - t0 < limit:
        r.wait(1000)
        c = page.evaluate(JS_NAVSNAP)
        t = round(time.time() - t0)
        if c['banner'] != last_banner:
            timeline.append({'t': t, 'banner': c['banner'][:90], 'cls': c['bannerCls'], 'dist': c['dist'], 'speed': c['speed'], 'course': c['course'], 'depth': c['depth']})
            last_banner = c['banner']
        kinds = {'hazard': 'впереди' in c['banner'] or 'рядом' in c['banner'], 'off': 'Поверните' in c['banner'], 'arrive': 'Вы на месте' in c['banner'], 'hold': 'Держу точку' in c['banner']}
        for k, v in kinds.items():
            if v and k not in seen:
                seen[k] = {'t': t, 'text': c['banner'], 'shot': r.shot(page, f'demo-{k}'), 'dist': c['dist'], 'depth': c['depth']}
                check_overlaps(r, page, f'Демо, плашка «{k}»', f'demo-{k}', sels=NAV_SELS)
        if 'hold' in seen and t - seen['hold']['t'] > 3:
            break
        if not full and ('hazard' in seen or 'off' in seen) and t > 25:
            break
    r.perf.setdefault('demo', {})['timeline'] = timeline
    r.info('Демо: ход событий', ' → '.join(f"{x['t']}с «{x['banner'][:48]}»" for x in timeline if x['banner'])[:600], data=timeline)
    if full:
        h = seen.get('hazard')
        r.check('Демо: плашка о мели впереди', bool(h), f"{h['t']} с: «{h['text']}»" if h else 'не было', shot=h and h['shot'])
        if h and not re.search(r'\b1(,\d)? м\b', h['text']):
            r.warn('Демо: мель «1 м»', f"плашка про мель не называет глубину 1 м: «{h['text']}»")
        o = seen.get('off')
        r.check('Демо: плашка «Поверните…» при уходе с курса', bool(o), f"{o['t']} с: «{o['text']}»" if o else 'не было', shot=o and o['shot'])
        a = seen.get('arrive')
        r.check('Демо: прибытие «Вы на месте»', bool(a), f"{a['t']} с: «{a['text']}»" if a else 'не было', sev='серьёзно', shot=a and a['shot'])
        hd = seen.get('hold')
        r.check('Демо: «Держу точку» и снос', bool(hd), f"{hd['t']} с: «{hd['text']}», «{hd['dist']}»" if hd else 'не было', shot=hd and hd['shot'])
        lt = page.evaluate('([a, b]) => ({ lt: __qa.longtasks.slice(a), gaps: __qa.gaps.slice(b), ltOn: __qa.lt, loaf: __qa.loaf.length })', [lt0['lt'], lt0['gaps']])
        r.perf['demo'].update({'seconds': round(time.time() - t0), 'longtasks>200ms': [x for x in lt['lt'] if x[1] > 200], 'longtasks>50ms': len(lt['lt']),
                               'raf_gaps>200ms': lt['gaps'], 'longtask_api': lt['ltOn']})
    # «Ещё › Погасить экран» → black; double tap → back
    try:
        r.tap(page, '#navMore')
        page.wait_for_selector('#modal:not([hidden])', timeout=4000)
        r.wait(300)
        shm = r.shot(page, 'nav-more')
        check_targets(r, page, 'Лист «Навигация» (⋯ Ещё)', ['#modal'], sev='мелочь')
        saver_seen = saver_check(r, page, '#modalBody [data-act="saver"]', 'из листа «Навигация» (⋯ Ещё)')
        if not saver_seen:
            # the same screen straight away, not from a sheet: does the black screen itself work?
            page.evaluate('() => showSaver()')
            r.wait(1000)
            ok = page.evaluate('!!document.getElementById("saver")')
            r.info('Чёрный экран, вызванный не из листа', 'держится' if ok else 'тоже исчезает', shot=r.shot(page, 'saver-direct'))
        sv = page.evaluate('''() => { const s = document.getElementById('saver'); return s ? { box: __qa.box(s), bg: getComputedStyle(s).backgroundColor, main: document.getElementById('saverMain').textContent,
            sub: document.getElementById('saverSub').textContent, mapHidden: map.getContainer().style.visibility === 'hidden', modal: !document.getElementById('modal').hidden } : null }''')
        shs = r.shot(page, 'saver')
        if sv:
            r.check('«Погасить экран»: чёрный экран с расстоянием', sv['bg'] in ('rgb(0, 0, 0)', 'rgba(0, 0, 0, 1)') and sv['mapHidden'] and bool(sv['main']) and not sv['modal'],
                    f"фон {sv['bg']}, «{sv['main']}» / «{sv['sub']}», карта скрыта {sv['mapHidden']}", shot=shs)
        else:
            raise PWError('чёрного экрана нет — дальше нечего проверять')
        W, H = r.p['vp']
        # 25.09.2026: a double tap turned the screen on in a pocket — the map comes back on a press held ~1 s.
        page.touchscreen.tap(W / 2, H / 2) if r.p['touch'] else page.mouse.click(W / 2, H / 2)
        page.wait_for_timeout(120)
        page.touchscreen.tap(W / 2, H / 2) if r.p['touch'] else page.mouse.click(W / 2, H / 2)
        r.wait(600)
        stays = page.evaluate('!!document.getElementById("saver")')
        r.check('Двойное касание не будит тёмный экран (в кармане)', stays, 'экран остался тёмным' if stays else 'экран вернулся от двойного касания')
        page.evaluate('''() => { const s = document.getElementById('saver'); if (!s) return; const o = { bubbles: true, pointerId: 1, pointerType: 'touch' };
            s.dispatchEvent(new PointerEvent('pointerdown', o)); setTimeout(() => s.dispatchEvent(new PointerEvent('pointerup', o)), 1100); }''')
        r.wait(1500)
        gone = page.evaluate('!document.getElementById("saver")')
        r.check('Долгое нажатие возвращает карту', gone and page.evaluate('document.body.dataset.mode') == 'nav', f"экран {'вернулся' if gone else 'остался чёрным'}")
    except (PWError, PWTimeout) as e:
        r.check('«Погасить экран»', False, f'сбой: {str(e)[:300]}', shot=r.shot(page, 'saver-error'))
    # end the demo
    try:
        while page.evaluate('() => !document.getElementById("modal").hidden'):
            r.back(page)
        r.tap(page, '#navEnd')
        page.wait_for_selector('#modal:not([hidden])', timeout=4000)
        r.tap(page, '#modalFoot [data-act="nav-end"]')
        r.wait(1200)
        st = page.evaluate('''() => ({ mode: document.body.dataset.mode, demo: DEMO.on, toast: document.getElementById('toastText').textContent, page: !document.getElementById('page').hidden,
            pageTitle: document.getElementById('pageTitle').textContent, stack: __qa.stack(), me: !!geo.me })''')
        r.check('«Завершить» заканчивает демо', st['mode'] == 'browse' and not st['demo'], json.dumps(st, ensure_ascii=False), shot=r.shot(page, 'demo-ended'))
    except (PWError, PWTimeout) as e:
        r.check('Завершение демо', False, f'сбой: {str(e)[:300]}')
    errs = r.errors(page)
    r.check('Демо без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет')


def s7_track(r: Run):
    start = dest(60.262, 32.035, 0, 0)
    page = r.new_page(geo=start)
    r.view(page, 60.265, 32.04, 14)
    route = [start, dest(*start, 45, 900)]
    r.gps = Gps(r.ctx, route, speed_kmh=20)
    r.gps.start()
    r.tap(page, '#btnTrack')
    r.wait(1500)
    toast = page.evaluate('document.getElementById("toastText").textContent')
    r.check('«Трек» начинает запись сразу', page.evaluate('() => trk.cur && trk.cur.state === "rec"'), f"тост «{toast[:90]}»")
    r.wait(14000)
    st = page.evaluate('''() => ({ pill: document.getElementById('trackPillText').textContent, cls: document.getElementById('btnTrack').className, pts: trk.cur.segs.reduce((a, s) => a + s.length, 0),
        dist: Math.round(trk.cur.dist), line: !!trk.line, follow: geo.follow })''')
    shot = r.shot(page, 'track-rec')
    r.check('Запись: пилюля «Запись m:ss · N м», точки пишутся', 'Запись' in st['pill'] and st['pts'] >= 2 and 'rec' in st['cls'], json.dumps(st, ensure_ascii=False), shot=shot)
    check_overlaps(r, page, 'Карта во время записи', 'track-rec')
    # pause
    r.tap(page, '#btnTrack')
    page.wait_for_selector('#modal:not([hidden])', timeout=4000)
    r.wait(300)
    shs = r.shot(page, 'track-sheet')
    check_targets(r, page, 'Лист записи', ['#modal'], min_px=48, sev='мелочь')
    r.tap(page, '#modalBody [data-act="rec-pause"]')
    r.wait(700)
    p0 = page.evaluate('() => ({ state: trk.cur.state, pts: trk.cur.segs.reduce((a, s) => a + s.length, 0), title: document.getElementById("modalTitle").textContent, pill: document.getElementById("trackPillText").textContent })')
    r.wait(7000)
    p1 = page.evaluate('() => ({ pts: trk.cur.segs.reduce((a, s) => a + s.length, 0), pill: document.getElementById("trackPillText").textContent })')
    r.check('Пауза: точки не пишутся, заголовок «Запись на паузе»', p0['state'] == 'paused' and p1['pts'] == p0['pts'] and 'пауз' in p0['title'].lower(),
            f"{p0['title']}, точек {p0['pts']}→{p1['pts']} за 7 с движения, пилюля «{p1['pill']}»", shot=shs)
    r.tap(page, '#modalBody [data-act="rec-resume"]')
    r.wait(12000)
    p2 = page.evaluate('() => ({ state: trk.cur.state, pts: trk.cur.segs.reduce((a, s) => a + s.length, 0), segs: trk.cur.segs.filter((s) => s.length).length })')
    r.check('Продолжить: запись идёт, новый отрезок', p2['state'] == 'rec' and p2['pts'] > p1['pts'] and p2['segs'] == 2, json.dumps(p2, ensure_ascii=False))
    # «Погасить экран — запись продолжится» from the recording sheet
    try:
        if saver_check(r, page, '#modalBody [data-act="saver"]', 'из листа записи трека'):
            page.evaluate('() => hideSaver()')
            r.wait(400)
    except (PWError, PWTimeout) as e:
        r.check('«Погасить экран» из листа записи', False, f'сбой: {str(e)[:200]}')
    if page.evaluate('document.getElementById("modal").hidden'):
        r.tap(page, '#btnTrack')
        page.wait_for_selector('#modal:not([hidden])', timeout=4000)
        r.wait(300)
    # stop → save sheet
    r.tap(page, '#modalBody [data-act="rec-stop"]')
    try:
        page.wait_for_selector('#tsName', timeout=4000)
    except PWTimeout:
        r.check('«Стоп» открывает «Сохранить трек»', False, 'нет листа', sev='серьёзно', shot=r.shot(page, 'track-nostop'))
        return
    r.gps.frozen = True
    r.wait(400)
    name = page.evaluate('document.getElementById("tsName").value')
    shv = r.shot(page, 'track-save')
    r.check('«Стоп» → лист «Сохранить трек» с именем по умолчанию', bool(re.search(r'.+ · \d+ \w{3}, \d\d:\d\d', name)), f"«{name}»", shot=shv)
    tid = page.evaluate('trk.cur.id')
    r.tap(page, '#modalFoot [data-act="track-save"]')
    r.wait(1500)
    st = page.evaluate('''([id]) => { const t = trk.list.find((x) => x.id === id); const b = trackBounds(t); const fr = __qa.freeRect();
        const sw = b ? __qa.screenOf(b.getSouth(), b.getWest()) : null, ne = b ? __qa.screenOf(b.getNorth(), b.getEast()) : null;
        return { card: !document.getElementById('card').hidden, title: document.getElementById('cardTitle').textContent, sub: document.getElementById('cardSub').textContent,
          sel: layers.select.getLayers().length, state: t && t.state, dist: t && Math.round(t.dist), pts: t && t.segs.flat().length, segs: t && t.segs.filter((s) => s.length).length,
          vmax: t && Math.round(t.vmax * 3.6), inView: sw && ne && sw.x >= fr.left - 2 && ne.x <= fr.right + 2 && ne.y >= fr.top - 2 && sw.y <= fr.bottom + 2, sw, ne, fr, cur: !!trk.cur } }''', [tid])
    shc = r.shot(page, 'track-card')
    r.check('Сохранённый трек открывается на карте карточкой', st['card'] and st['sel'] >= 1 and st['state'] == 'done' and st['inView'] and not st['cur'],
            f"«{st['title']}» · {st['sub']} · {st['pts']} точек, {st['segs']} отрезка, {st['dist']} м, макс {st['vmax']} км/ч; трек в кадре: {st['inView']}", shot=shc)
    # GPX
    gpx_text, how = None, ''
    try:
        if r.p['ios']:
            r.tap(page, '#cardBody [data-act="track-share"]')
            r.wait(800)
            sh = page.evaluate('() => __qa.shares.slice(-1)[0] || null')
            if sh and sh['files']:
                gpx_text, how = sh['files'][0]['text'], f"navigator.share: {sh['files'][0]['name']} ({sh['files'][0]['type']})"
        if gpx_text is None:
            with page.expect_download(timeout=6000) as dl:
                r.tap(page, '#cardBody [data-act="track-share"]')
            d = dl.value
            path = r.dir / f's7-{d.suggested_filename}'
            d.save_as(str(path))
            gpx_text, how = path.read_text(encoding='utf-8'), f'скачивание {d.suggested_filename}'
    except (PWError, PWTimeout) as e:
        how = f'сбой: {str(e)[:160]}'
    if gpx_text:
        (r.dir / 's7-track.gpx').write_text(gpx_text, encoding='utf-8')
        try:
            root = ET.fromstring(gpx_text.encode('utf-8'))
            ns = {'g': 'http://www.topografix.com/GPX/1/1'}
            trkpts = root.findall('.//g:trkpt', ns)
            segs = root.findall('.//g:trkseg', ns)
            fname_ok = bool(re.search(r'ladoga_\d{4}-\d\d-\d\d_\d\d-\d\d\.gpx', how))
            r.check('GPX: файл трека корректный', len(trkpts) == st['pts'] and len(segs) == st['segs'] and fname_ok, f"{how}; trkpt {len(trkpts)} (в треке {st['pts']}), trkseg {len(segs)}")
        except ET.ParseError as e:
            r.check('GPX: файл трека корректный', False, f'{how}; XML не читается: {e}')
    else:
        r.check('GPX: файл трека корректный', False, how or 'нет ни share, ни скачивания')
    # «Моё › Треки»
    r.back(page)
    r.nav_to(page, 'me', 'tracks')
    rows = page.evaluate('''() => [...document.querySelectorAll('#pageBody .track-row')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim())''')
    shl = r.shot(page, 'tracks-list')
    r.check('Трек в «Моё › Треки»', any(st['title'][:12] in x for x in rows), ' | '.join(rows) or 'пусто', shot=shl)
    if rows:
        r.tap(page, '#pageBody .track-row .list-row')
        r.wait(1200)
        s2 = page.evaluate('() => ({ card: !document.getElementById("card").hidden, title: document.getElementById("cardTitle").textContent, page: !document.getElementById("page").hidden })')
        r.check('Тап по треку в списке открывает его на карте', s2['card'] and s2['title'] == st['title'], json.dumps(s2, ensure_ascii=False), shot=r.shot(page, 'track-from-list'))
    errs = [e for e in r.errors(page) if not (e['type'] == 'error' and 'Geolocation' in e['text'])]
    r.check('Трек без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет')


def s8_offline(r: Run):
    """LIVE site (https: the service worker only registers there). Two page loads, nothing downloaded on purpose."""
    page = r.new_page(route=False, sw='allow', url=LIVE, ready=False)
    try:
        r.ready(page, timeout=60000)
    except PWTimeout:
        r.check('Живой сайт открывается', False, 'не загрузился за 60 с', sev='блокер', shot=r.shot(page, 'live-fail'))
        return
    ver = page.evaluate('''() => [...document.scripts].map((s) => s.src).filter((s) => /app\\.js/.test(s))[0] || ''  ''')
    local_v = re.search(r'app\.js\?v=(\d+)', (ROOT / 'site' / 'index.html').read_text(encoding='utf-8'))
    r.info('Версия живого сайта', f"{ver.split('/')[-1]} (локально app.js?v={local_v.group(1) if local_v else '?'})")
    sw = None
    t0 = time.time()
    while time.time() - t0 < 45:
        sw = page.evaluate('''async () => { const reg = await navigator.serviceWorker.getRegistration(); const keys = await caches.keys(); const out = {};
            for (const k of keys) out[k] = (await (await caches.open(k)).keys()).length;
            return { reg: !!reg, active: !!(reg && reg.active), state: reg && reg.active && reg.active.state, ctrl: !!navigator.serviceWorker.controller, caches: out } }''')
        shell = [v for k, v in sw['caches'].items() if k.startswith('ladoga-v')]
        if sw['active'] and sw['state'] == 'activated' and shell and shell[0] >= 15:
            break
        page.wait_for_timeout(1000)
    r.check('Service worker установлен и закэшировал оболочку', bool(sw and sw['active'] and any(k.startswith('ladoga-v') for k in sw['caches'])), json.dumps(sw, ensure_ascii=False), shot=r.shot(page, 'live-online'))
    r.wait(2500)
    r.ctx.set_offline(True)
    try:
        page.reload(wait_until='domcontentloaded', timeout=30000)
        r.ready(page, timeout=30000)
        ok = True
    except (PWError, PWTimeout) as e:
        ok = False
        r.check('Без сети: перезагрузка поднимает приложение и данные', False, f'не загрузилось: {str(e)[:200]}', sev='блокер', shot=r.shot(page, 'offline-fail'))
    if ok:
        r.wait(2500)
        st = page.evaluate('''() => ({ points: state.M.length, reports: state.R.length, ctx: Object.keys(state.ctx || {}).length, online: navigator.onLine,
            chips: [...document.querySelectorAll('#statusChips .schip')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim()), tiles: document.querySelectorAll('img.leaflet-tile-loaded').length,
            toast: document.getElementById('toast').classList.contains('show') ? document.getElementById('toastText').textContent : '', ctrl: !!navigator.serviceWorker.controller,
            bar: __qa.vis(document.getElementById('navBar')), markers: document.querySelectorAll('.leaflet-marker-icon').length })''')
        sho = r.shot(page, 'offline-map')
        r.check('Без сети: оболочка и данные загружаются', st['points'] > 0 and st['ctx'] > 0 and st['bar'] and st['markers'] > 0 and not st['online'],
                f"точек {st['points']}, контекст {st['ctx']} ключей, маркеров {st['markers']}, плиток {st['tiles']}, контроллер SW {st['ctrl']}, тост «{st['toast']}»", shot=sho)
        r.check('Без сети: чип «Без сети» на карте', any('Без сети' in c for c in st['chips']), ' | '.join(st['chips']))
        check_chips(r, page, 'Без сети', shot=sho)
        try:
            r.nav_to(page, 'today')
            txt = page.evaluate('document.getElementById("pageBody").innerText.slice(0, 400)')
            r.check('Без сети: «Сегодня» говорит о нет сети', 'Нет сети' in txt, txt[:160].replace('\n', ' '), shot=r.shot(page, 'offline-today'))
            r.nav_to(page, 'me', 'offline')
            txt = page.evaluate('document.getElementById("pageBody").innerText')
            r.check('Без сети: «Моё › Без сети» открывается', 'Район южной Ладоги' in txt, txt[:160].replace('\n', ' '), shot=r.shot(page, 'offline-me'))
            r.nav_to(page, 'guide', 'fish')
            n = page.evaluate('document.getElementById("pageBody").innerText.length')
            r.check('Без сети: справочник «Рыба» доступен', n > 500, f'{n} символов')
        except (PWError, PWTimeout) as e:
            r.check('Без сети: разделы', False, f'сбой: {str(e)[:200]}')
    r.ctx.set_offline(False)


def s9_layouts(r: Run):
    """Phone on its side and tablets: rail, card in a side panel, navigation data panel on the left."""
    page = r.new_page(geo=(60.2, 32.2))
    lay = page.evaluate('document.body.dataset.layout')
    st = page.evaluate('''() => ({ bar: __qa.box(document.getElementById('navBar')), map: __qa.box(document.getElementById('map')), vw: innerWidth, vh: innerHeight })''')
    railw = {'land': 72, 'medium': 80, 'expanded': 80}.get(lay)
    if lay != 'compact':
        r.check('Рейка слева нужной ширины, карта справа от неё', abs(st['bar']['w'] - railw) <= 1 and st['bar']['x'] <= 0.5 and abs(st['map']['x'] - st['bar']['r']) <= 1,
                f"рейка {fmt_box(st['bar'])} (ожидалось {railw}), карта {fmt_box(st['map'])}")
        items = page.evaluate('''() => [...document.querySelectorAll('#navBar > button, #navBar .rail-extra button')].filter(__qa.vis).map((b) => ({ t: b.innerText.trim(), ...__qa.box(b) }))''')
        cut = [i for i in items if i['b'] > st['vh'] + 0.5]
        r.check('Все пункты рейки помещаются по высоте', not cut, f"{len(items)} пунктов; за краем: {[i['t'] for i in cut]}" + (f"; низ последнего {items[-1]['b']:.0f} из {st['vh']}" if items else ''))
    # a section in a panel
    r.nav_to(page, 'guide', 'places')
    ps = page.evaluate('''() => ({ page: __qa.box(document.getElementById('page')), map: __qa.box(document.getElementById('map')), leaf: map.getSize(), mu: __qa.box(document.querySelector('.map-ui')) })''')
    shp = r.shot(page, 'panel')
    if lay in ('land', 'medium'):
        r.check('Раздел — панель поверх карты, карта не сдвигается', ps['page']['x'] >= railw - 1 and ps['page']['w'] <= 362 and ps['map']['x'] <= railw + 1,
                f"панель {fmt_box(ps['page'])}, карта {fmt_box(ps['map'])}", shot=shp)
    elif lay == 'expanded':
        r.check('Раздел — закреплённая панель, карта сужается', abs(ps['map']['x'] - ps['page']['r']) <= 1.5 and abs(ps['leaf']['x'] - ps['map']['w']) <= 1,
                f"панель {fmt_box(ps['page'])}, карта {fmt_box(ps['map'])}, Leaflet {ps['leaf']['x']}", shot=shp)
    check_overlaps(r, page, 'Раздел в панели', 'panel', sels=MAPUI_SELS + ['#page'])
    r.back(page)
    # navigation: data panel on the left
    tgt = start_nav_to_point(r, page, 400)
    if not tgt:
        r.check('Навигация', False, 'не нашёл точку', sev='серьёзно')
        return
    r.wait(9000)
    c = page.evaluate(JS_NAVSNAP)
    boxes = page.evaluate('''() => ({ top: __qa.box(document.getElementById('navTop')), bottom: __qa.box(document.getElementById('navBottom')), map: __qa.box(document.getElementById('map')),
        btns: [...document.querySelectorAll('#navBottom button')].map((b) => ({ t: b.innerText.trim(), ...__qa.box(b) })), fields: [...document.querySelectorAll('#navBottom .nb-field')].map((b) => __qa.box(b)),
        dist: getComputedStyle(document.getElementById('ntDist')).fontSize, val: getComputedStyle(document.getElementById('nfSpeed')).fontSize, vh: innerHeight })''')
    shn = r.shot(page, 'nav')
    if lay != 'compact':
        navw = boxes['top']['w']
        cut = [b for b in boxes['btns'] if b['b'] > boxes['vh'] + 0.5]
        r.check('Навигация: панель данных слева, карта справа', boxes['top']['x'] <= 0.5 and boxes['bottom']['x'] <= 0.5 and abs(boxes['map']['x'] - navw) <= 1.5 and c['boat'] and c['boat']['x'] > navw,
                f"панель {navw:.0f} px, карта с x={boxes['map']['x']:.0f}, лодка {c['boat']}, расстояние {boxes['dist']}, значения {boxes['val']}", shot=shn)
        r.check('Навигация: кнопки панели данных помещаются по высоте', not cut, f"кнопки {[(b['t'], round(b['b'])) for b in boxes['btns']]}, экран {boxes['vh']}")
    check_overlaps(r, page, 'Навигация (раскладка)', 'nav', sels=NAV_SELS)
    check_targets(r, page, 'Навигация (раскладка)', ['#navTop', '#navBottom', '#mapUi'], sev='серьёзно')
    za = page.evaluate('() => { const z = document.getElementById("zoomAuto"); return z.hidden ? null : { ...__qa.box(z), vh: innerHeight, vw: innerWidth } }')
    if za:
        r.check('Навигация: подпись «авто» под +/− на экране', za['b'] <= za['vh'] + 0.5 and za['r'] <= za['vw'] + 0.5, f"«авто» {fmt_box(za)}, низ {za['b']:.0f} при высоте экрана {za['vh']}", sev='мелочь', shot=shn)
    nw = boxes['top']['w']
    if lay == 'expanded' or (lay == 'medium'):
        r.check('Навигация: ширина панели данных как в спеке (400 при ширине ≥ 1024)', (nw >= 399) if r.p['vp'][0] >= 1024 else (nw >= 339), f"панель {nw:.0f} px при окне {r.p['vp'][0]}×{r.p['vp'][1]}", sev='мелочь')
    r.gps.frozen = True
    # the card as a side panel
    r.tap(page, '#navEnd')
    page.wait_for_selector('#modal:not([hidden])', timeout=4000)
    r.tap(page, '#modalFoot [data-act="nav-end"]')
    r.wait(1000)
    errs = [e for e in r.errors(page) if not (e['type'] == 'error' and 'Geolocation' in e['text'])]
    r.check('Раскладки без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет')


def s10_desktop(r: Run):
    page = r.new_page(geo=(60.25, 32.05))
    r.view(page, *PTINOV, 13)
    page.mouse.move(5, r.p['vp'][1] - 5)
    # F: full screen mode
    page.keyboard.press('KeyF')
    r.wait(900)
    st = page.evaluate('() => ({ mode: document.body.dataset.mode, fs: !!document.fullscreenElement, bar: __qa.vis(document.getElementById("navBar")), exit: __qa.vis(document.getElementById("btnFullExit")), search: __qa.vis(document.getElementById("searchBtn")), map: __qa.box(document.getElementById("map")), vw: innerWidth })')
    shf = r.shot(page, 'full')
    r.check('F: карта на весь экран (свой режим)', st['mode'] == 'full' and not st['bar'] and st['exit'] and not st['search'] and st['map']['x'] <= 0.5 and st['map']['w'] >= st['vw'] - 1,
            f"режим {st['mode']}, Fullscreen API {st['fs']}, рейка {st['bar']}, «Выйти» {st['exit']}, карта {fmt_box(st['map'])}", shot=shf)
    check_overlaps(r, page, 'Весь экран', 'full')
    page.keyboard.press('KeyF')
    r.wait(900)
    st = page.evaluate('() => ({ mode: document.body.dataset.mode, fs: !!document.fullscreenElement, bar: __qa.vis(document.getElementById("navBar")), stack: __qa.stack() })')
    r.check('F ещё раз: обычный вид', st['mode'] == 'browse' and st['bar'] and not st['fs'], json.dumps(st, ensure_ascii=False))
    page.keyboard.press('KeyF')
    r.wait(700)
    page.keyboard.press('Escape')
    r.wait(900)
    st = page.evaluate('() => ({ mode: document.body.dataset.mode, fs: !!document.fullscreenElement, stack: __qa.stack() })')
    r.check('Esc выходит из «Весь экран»', st['mode'] == 'browse' and not st['fs'], json.dumps(st, ensure_ascii=False))
    # M / Esc
    page.keyboard.press('KeyM')
    r.wait(600)
    op = page.evaluate('() => document.getElementById("modalTitle").textContent + "|" + !document.getElementById("modal").hidden')
    page.keyboard.press('Escape')
    r.wait(700)
    cl = page.evaluate('document.getElementById("modal").hidden')
    r.check('M открывает слои, Esc закрывает', op.endswith('true') and op.startswith('Слои') and cl, f"{op}, закрыт {cl}")
    # + − (and they must not steal from the search field)
    z0 = page.evaluate('map.getZoom()')
    page.keyboard.press('Equal')
    r.wait(700)
    z1 = page.evaluate('map.getZoom()')
    page.keyboard.press('Minus')
    r.wait(700)
    z2 = page.evaluate('map.getZoom()')
    page.keyboard.press('NumpadAdd')
    r.wait(700)
    z3 = page.evaluate('map.getZoom()')
    r.check('Клавиши + и − меняют масштаб', z1 == z0 + 1 and z2 == z0 and z3 == z0 + 1, f"{z0} → + {z1} → − {z2} → Num+ {z3}")
    # L
    page.keyboard.press('KeyL')
    r.wait(2500)
    st = page.evaluate('''() => { const fr = __qa.freeRect(); const me = geo.me ? __qa.screenOf(geo.me.lat, geo.me.lon) : null;
        return { state: document.getElementById("btnLocate").dataset.state, me, follow: geo.follow, fr, dx: me ? Math.round(me.x - (fr.left + fr.right) / 2) : null, dy: me ? Math.round(me.y - (fr.top + fr.bottom) / 2) : null, modal: !document.getElementById("modal").hidden } }''')
    r.check('L: «Где я» — я в центре свободной части карты, слежение «север»', st['me'] is not None and st['follow'] == 'north' and abs(st['dx']) <= 6 and abs(st['dy']) <= 6,
            f"кнопка {st['state']}, слежение {st['follow']}, точка «я» {st['me']}, смещение от центра свободной области {st['dx']},{st['dy']} px", shot=r.shot(page, 'locate'))
    # H
    page.keyboard.press('KeyH')
    r.wait(1200)
    st = page.evaluate('() => ({ z: map.getZoom(), follow: geo.follow, b: map.getBounds().toBBoxString() })')
    r.check('H: «Мой район» и слежение снято', st['follow'] == 'free' and st['z'] <= 10, json.dumps(st, ensure_ascii=False), shot=r.shot(page, 'home'))
    # digits and [
    page.keyboard.press('Digit3')
    r.wait(600)
    t3 = page.evaluate('() => !document.getElementById("page").hidden && document.getElementById("pageTitle").textContent')
    page.keyboard.press('BracketLeft')
    r.wait(700)
    t4 = page.evaluate('() => !document.getElementById("page").hidden')
    page.keyboard.press('BracketLeft')
    r.wait(700)
    t5 = page.evaluate('() => !document.getElementById("page").hidden && document.getElementById("pageTitle").textContent')
    r.check('3 — «Клёв», [ сворачивает и разворачивает панель', t3 == 'Клёв' and t4 is False and t5 == 'Клёв', f"3 → {t3}; [ → {t4}; [ → {t5}")
    page.keyboard.press('Escape')
    r.wait(700)
    # / and Esc in the field
    page.keyboard.press('Slash')
    r.wait(600)
    f1 = page.evaluate('() => document.activeElement && document.activeElement.id')
    page.keyboard.type('птин')
    r.wait(300)
    page.keyboard.press('Escape')
    r.wait(300)
    v1 = page.evaluate('() => document.getElementById("searchInput") && document.getElementById("searchInput").value')
    page.keyboard.press('Escape')
    r.wait(300)
    page.keyboard.press('Escape')
    r.wait(700)
    cl = page.evaluate('document.getElementById("modal").hidden')
    r.check('/ — поиск с фокусом; Esc чистит поле, потом закрывает', f1 == 'searchInput' and v1 == '' and cl, f"фокус {f1}, после Esc поле «{v1}», закрыт после 3 Esc: {cl}")
    # right click → «Новая точка»
    r.view(page, *PTINOV, 13)
    pt = page.evaluate('() => __qa.emptyMapPoint()')
    if pt:
        page.mouse.click(pt['x'], pt['y'], button='right')
        r.wait(700)
        st = page.evaluate('() => ({ open: !document.getElementById("modal").hidden, title: document.getElementById("modalTitle").textContent, body: document.getElementById("modalBody").innerText.slice(0, 200) })')
        r.check('Правый клик по карте → «Новая точка»', st['open'] and st['title'] == 'Новая точка' and 'N 60°' in st['body'], f"«{st['title']}»: {st['body'][:120]!r}", shot=r.shot(page, 'new-point'))
        if st['open']:
            r.tap(page, '#modalFoot [data-act="np-save"]')
            r.wait(800)
            n = page.evaluate('state.mine.length')
            r.check('«Сохранить» новую точку', n == 1, f"моих точек {n}, тост «{page.evaluate('document.getElementById(\"toastText\").textContent')}»", sev='мелочь')
    # mouse over the map: coordinates and depth
    w0 = page.evaluate('() => __qa.screenOf(60.245, 32.06)')
    page.evaluate('() => depthAt({ lat: 60.245, lon: 32.06 })')
    r.wait(1200)
    page.mouse.move(w0['x'] + 3, w0['y'] + 3)
    r.wait(250)
    page.mouse.move(w0['x'], w0['y'])
    r.wait(500)
    ci = page.evaluate('() => ({ vis: __qa.vis(document.getElementById("cursorInfo")), text: document.getElementById("cursorInfo").textContent, box: __qa.box(document.getElementById("cursorInfo")) })')
    r.check('Мышь над картой: координаты и глубина', ci['vis'] and 'N 60°' in ci['text'] and re.search(r'\d м', ci['text']) is not None, f"«{ci['text']}» {fmt_box(ci['box'])}", shot=r.shot(page, 'cursor-info'))
    # the mouse wheel and double click
    z0 = page.evaluate('map.getZoom()')
    page.mouse.wheel(0, -360)
    r.wait(900)
    z1 = page.evaluate('map.getZoom()')
    r.check('Колесо мыши приближает', z1 > z0, f"{z0} → {z1}", sev='мелочь')
    # tooltips with keys, focus ring
    titles = page.evaluate('''() => ['#btnLayers', '#btnFull', '#btnHome', '#btnLocate', '#zoomIn', '#searchBtn'].map((s) => document.querySelector(s).title)''')
    r.check('Подсказки кнопок с клавишами', all(re.search(r'\(.+\)', t) for t in titles), ' | '.join(titles), sev='мелочь')
    while page.evaluate('() => ui.stack.length'):
        r.back(page)
    page.evaluate('() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0); }')
    # a toast still on screen is rightly in the Tab order (its action); the check is about the controls under it
    page.evaluate('() => document.getElementById("toast").classList.remove("show")')
    r.wait(400)
    stops = []
    for i in range(7):
        page.keyboard.press('Tab')
        r.wait(120)
        stops.append(page.evaluate('() => { const a = document.activeElement; const cs = getComputedStyle(a); return { n: __qa.name(a).slice(0, 60), ow: cs.outlineWidth, os: cs.outlineStyle, sh: cs.boxShadow !== "none" } }'))
        if i == 2:
            shf = r.shot(page, 'focus')
    bad = [x for x in stops if x['n'].startswith('body') or ((x['os'] == 'none' or (parse_num(x['ow']) or 0) < 2) and not x['sh'])]
    r.check('Tab: по кнопкам с видимой рамкой фокуса', not bad, ' → '.join(f"{x['n'][:34]} [{x['os']} {x['ow']}]" for x in stops), sev='мелочь', shot=shf)
    errs = [e for e in r.errors(page) if not (e['type'] == 'error' and 'Geolocation' in e['text'])]
    r.check('ПК-сценарий без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет')


def s11_safe_area(r: Run):
    """iPhone from the Home Screen: the status bar with the Dynamic Island and the home indicator, simulated through the
    app's own --safe-* variables (Playwright cannot emulate env(safe-area-inset-*)). Grey bands mark the unsafe zones."""
    land = r.p['layout'] == 'land'
    ins = {'t': 0, 'b': 21, 'l': 59, 'r': 59} if land else {'t': 59, 'b': 34, 'l': 0, 'r': 0}
    css = (f":root:root {{ --safe-t: {ins['t']}px; --safe-b: {ins['b']}px; --safe-l: {ins['l']}px; --safe-r: {ins['r']}px; "
           f"--nav-pad: {max(0, ins['b'] - 14)}px; }}")
    page = r.new_page()
    page.add_style_tag(content=css)
    page.evaluate('''(ins) => { const mk = (st) => { const d = document.createElement('div'); d.className = '__qaBand'; d.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;background:rgba(255,0,200,.28);' + st; document.body.appendChild(d); };
        if (ins.t) mk(`top:0;left:0;right:0;height:${ins.t}px`); if (ins.b) mk(`bottom:0;left:0;right:0;height:${ins.b}px`); if (ins.l) mk(`top:0;bottom:0;left:0;width:${ins.l}px`); if (ins.r) mk(`top:0;bottom:0;right:0;width:${ins.r}px`);
        window.dispatchEvent(new Event('resize')); }''', ins)
    r.wait(800)
    r.info('Имитация safe area', f"вырез/строка состояния {ins['t']} px, полоска «Домой» {ins['b']} px, слева/справа {ins['l']}/{ins['r']} px (через --safe-*)")

    def unsafe(where):
        res = page.evaluate('''(ins) => { const out = []; const W = innerWidth, H = innerHeight;
            const sel = 'button, a[href], input, select, summary, label.check, h1, h2, .nt-dist, .nt-line2, .nb-field, .schip, .searchbox, .nav-banner, .modal-head, .card-head, .panel-head';
            for (const el of document.querySelectorAll(sel)) {
              if (!__qa.vis(el) || el.closest('.leaflet-marker-icon, .leaflet-pane')) continue;
              const c = __qa.clip(el); if (!c || c.full < 0.95) continue;
              if (__qa.coveredBy(el)) continue; // under a full-screen sheet: not on screen
              let scroller = false; for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 1) { scroller = true; break; } }
              if (scroller) continue; // scrolls away from the edge
              const r = el.getBoundingClientRect(); const bad = [];
              if (ins.t && r.top < ins.t - 0.5) bad.push('сверху ' + Math.round(ins.t - r.top));
              if (ins.b && r.bottom > H - ins.b + 0.5) bad.push('снизу ' + Math.round(r.bottom - (H - ins.b)));
              if (ins.l && r.left < ins.l - 0.5) bad.push('слева ' + Math.round(ins.l - r.left));
              if (ins.r && r.right > W - ins.r + 0.5) bad.push('справа ' + Math.round(r.right - (W - ins.r)));
              if (bad.length) out.push({ n: __qa.name(el).slice(0, 80), bad: bad.join(', '), ...__qa.box(el) });
            }
            return out; }''', ins)
        shot = r.shot(page, f'safe-{where}')
        side = [x for x in res if re.search('сверху|слева|справа', x['bad'])]
        bottom = [x for x in res if x not in side]
        r.check(f'Safe area, {where}: ничего не под вырезом / строкой состояния', not side, '; '.join(f"{x['n']} — {x['bad']} px" for x in side[:8]) or 'чисто', sev='серьёзно', shot=shot, data=side[:20])
        if bottom:
            r.warn(f'Safe area, {where}: элементы заходят на полоску «Домой»', '; '.join(f"{x['n']} — {x['bad']} px" for x in bottom[:8]), sev='мелочь', shot=shot, data=bottom[:20])
    try:
        unsafe('старт')
        r.view(page, *PTINOV, 13)
        pick = page.evaluate('() => __qa.pickMarker(40)')
        if pick:
            r.tap_xy(page, pick['x'], pick['y'])
            page.wait_for_selector('#card:not([hidden])', timeout=5000)
            r.wait(900)
            unsafe('карточка')
            r.back(page)
        r.nav_to(page, 'today')
        unsafe('раздел')
        r.back(page)
        r.tap(page, '#btnSos')
        page.wait_for_selector('#modal:not([hidden])', timeout=4000)
        r.wait(400)
        unsafe('SOS')
        r.back(page)
        r.tap(page, '#btnLayers')
        page.wait_for_selector('#modal:not([hidden])', timeout=4000)
        r.wait(400)
        unsafe('слои')
        r.back(page)
        r.nav_to(page, 'me', 'more')
        r.tap(page, '#pageBody [data-act="demo"]')
        page.wait_for_selector('#navTop:not([hidden])', timeout=6000)
        r.wait(4000)
        unsafe('навигация')
        r.tap(page, '#navEnd')
        page.wait_for_selector('#modal:not([hidden])', timeout=4000)
        r.tap(page, '#modalFoot [data-act="nav-end"]')
        r.wait(800)
    except (PWError, PWTimeout) as e:
        r.check('Safe area: сценарий', False, f'сбой: {str(e)[:300]}', shot=r.shot(page, 'safe-error'))


def s12_rotate_night(r: Run):
    """A phone turned on its side and back (a card open, then navigation), and the night palette."""
    W, H = r.p['vp']
    page = r.new_page()

    def state(where):
        st = page.evaluate('''() => ({ lay: document.body.dataset.layout, map: __qa.box(document.getElementById('map')), leaf: map.getSize(), card: __qa.vis(document.getElementById('card')) ? __qa.box(document.getElementById('card')) : null,
            nav: document.body.dataset.mode, top: __qa.vis(document.getElementById('navTop')) ? __qa.box(document.getElementById('navTop')) : null, vw: innerWidth, vh: innerHeight,
            sel: state.selected != null ? __qa.screenOf(state.M[state.selected].lat, state.M[state.selected].lon) : null, boat: geo.me ? __qa.screenOf(geo.me.lat, geo.me.lon) : null, fr: __qa.freeRect() })''')
        ok = abs(st['leaf']['x'] - st['map']['w']) <= 1 and abs(st['leaf']['y'] - st['map']['h']) <= 1
        r.check(f'Поворот, {where}: карта перестроилась под новый размер', ok, f"раскладка {st['lay']}, #map {fmt_box(st['map'])}, Leaflet {st['leaf']['x']}×{st['leaf']['y']}", sev='серьёзно')
        return st

    try:
        r.view(page, *PTINOV, 13)
        pick = page.evaluate('() => __qa.pickMarker(40)')
        r.tap_xy(page, pick['x'], pick['y'])
        page.wait_for_selector('#card:not([hidden])', timeout=5000)
        r.wait(900)
        page.set_viewport_size({'width': H, 'height': W})
        r.wait(1500)
        st = state('карточка → альбом')
        shot = r.shot(page, 'rotated-card')
        fr = st['fr']
        vis = st['sel'] and fr['left'] - 2 <= st['sel']['x'] <= fr['right'] + 2 and fr['top'] - 2 <= st['sel']['y'] <= fr['bottom'] + 2
        r.check('Поворот с открытой карточкой: карточка стала боковой панелью, точка видна', st['lay'] == 'land' and st['card'] and st['card']['y'] <= 1 and bool(vis),
                f"карточка {fmt_box(st['card']) if st['card'] else 'нет'}, точка {st['sel']}, свободная область {fr}", shot=shot)
        check_overlaps(r, page, 'Поворот с карточкой', 'rotated-card', sels=MAPUI_SELS + ['#card'])
        page.set_viewport_size({'width': W, 'height': H})
        r.wait(1500)
        st = state('карточка → портрет')
        shot = r.shot(page, 'rotated-back-card')
        vis = st['sel'] and st['card'] and st['sel']['y'] < st['card']['y'] - 8
        r.check('Обратно в портрет: карточка снизу, точка над ней', st['lay'] == 'compact' and st['card'] and st['card']['b'] >= H - 1 and bool(vis),
                f"карточка {fmt_box(st['card']) if st['card'] else 'нет'}, точка {st['sel']}", shot=shot, sev='мелочь')
        r.back(page)
        # navigation (demo) turned on its side
        r.nav_to(page, 'me', 'more')
        r.tap(page, '#pageBody [data-act="demo"]')
        page.wait_for_selector('#navTop:not([hidden])', timeout=6000)
        r.wait(5000)
        page.set_viewport_size({'width': H, 'height': W})
        r.wait(2500)
        st = state('навигация → альбом')
        shot = r.shot(page, 'rotated-nav')
        ok = st['lay'] == 'land' and st['top'] and st['top']['x'] <= 0.5 and st['top']['w'] < st['vw'] * 0.6 and st['boat'] and st['boat']['x'] > st['top']['r']
        r.check('Поворот в навигации: панель данных слева, лодка на карте справа', ok, f"панель {fmt_box(st['top']) if st['top'] else 'нет'}, лодка {st['boat']}", shot=shot)
        check_overlaps(r, page, 'Навигация в альбоме после поворота', 'rotated-nav', sels=NAV_SELS)
        page.set_viewport_size({'width': W, 'height': H})
        r.wait(2500)
        st = state('навигация → портрет')
        shot = r.shot(page, 'rotated-back-nav')
        ok = st['lay'] == 'compact' and st['top'] and st['top']['w'] >= W - 1 and st['boat'] and st['fr']['top'] <= st['boat']['y'] <= st['fr']['bottom']
        r.check('Обратно в портрет в навигации: панели сверху/снизу, лодка в кадре', ok, f"верх {fmt_box(st['top']) if st['top'] else 'нет'}, лодка {st['boat']}, область {st['fr']}", shot=shot)
        # night palette
        page.emulate_media(color_scheme='dark')
        r.wait(1200)
        th = page.evaluate('() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.getElementById("navBottom")).backgroundColor, meta: document.querySelector("meta[name=theme-color]").content })')
        shot = r.shot(page, 'night-nav')
        r.check('Ночная палитра по системной теме', th['theme'] == 'night' and th['bg'] in ('rgb(0, 0, 0)', 'rgba(0, 0, 0, 1)'), json.dumps(th, ensure_ascii=False), sev='мелочь', shot=shot)
        r.tap(page, '#navEnd')
        page.wait_for_selector('#modal:not([hidden])', timeout=4000)
        r.wait(300)
        r.shot(page, 'night-end-ask')
        r.tap(page, '#modalFoot [data-act="nav-end"]')
        r.wait(1200)
        while page.evaluate('() => ui.stack.length'):
            r.back(page)
        r.shot(page, 'night-map')
        r.nav_to(page, 'today')
        r.shot(page, 'night-today')
    except (PWError, PWTimeout, TypeError) as e:
        r.check('Поворот и ночь: сценарий', False, f'сбой: {str(e)[:300]}', shot=r.shot(page, 'rotate-error'))
    errs = r.errors(page)
    r.check('Поворот и ночь без ошибок в консоли', not errs, '; '.join(f"{e['type']}: {e['text']}" for e in errs[:5]) or 'ошибок нет')


def perf(r: Run):
    """Cold loads without the tile cache (real network), then panning with the mouse."""
    loads = []
    for i in range(3):
        page = r.new_page(route=False, url=False)
        t0 = time.time()
        page.goto(r.base, wait_until='load')
        r.ready(page)
        try:
            page.wait_for_function('() => __qa.marks.tile', timeout=15000)
        except PWTimeout:
            pass
        m = page.evaluate('''() => { const n = performance.getEntriesByType('navigation')[0]; const res = performance.getEntriesByType('resource');
            const local = res.filter((x) => x.name.startsWith(location.origin));
            return { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), data: Math.round(__qa.marks.data || 0),
              marker: Math.round(__qa.marks.marker || 0), tile: Math.round(__qa.marks.tile || 0), localKB: Math.round(local.reduce((a, x) => a + (x.decodedBodySize || x.encodedBodySize || 0), 0) / 1024),
              requests: res.length, dom: document.getElementsByTagName('*').length, lt: __qa.longtasks.filter((x) => x[1] > 50).map((x) => x[1]), gaps: __qa.gaps.map((x) => x[1]) } }''')
        m['wall'] = round((time.time() - t0) * 1000)
        loads.append(m)
    r.end_page()
    med = {k: statistics.median([x[k] for x in loads]) for k in ('ttfb', 'dcl', 'load', 'data', 'marker', 'tile', 'wall', 'dom', 'localKB', 'requests')}
    r.perf['load'] = {'median': med, 'runs': loads}
    r.info('Загрузка (медиана из 3)', f"DCL {med['dcl']} мс, load {med['load']} мс, данные {med['data']} мс, первые точки {med['marker']} мс, первая плитка {med['tile']} мс, DOM {med['dom']}, локально {med['localKB']} КБ")
    # panning
    page = r.new_page()
    r.view(page, 60.22, 32.1, 12)
    a = page.evaluate('() => ({ lt: __qa.longtasks.length, gaps: __qa.gaps.length, loaf: __qa.loaf.length })')
    fr = page.evaluate('() => __qa.freeRect()')
    cx, cy = (fr['left'] + fr['right']) / 2, (fr['top'] + fr['bottom']) / 2
    t0 = time.time()
    moves = [(220, 0), (-220, 90), (0, -180), (160, 160), (-300, -60), (240, 40)]
    for rep in range(2):
        for dx, dy in moves:
            page.mouse.move(cx - dx / 2, cy - dy / 2)
            page.mouse.down()
            for k in range(1, 13):
                page.mouse.move(cx - dx / 2 + dx * k / 12, cy - dy / 2 + dy * k / 12)
                page.wait_for_timeout(16)
            page.mouse.up()
            page.wait_for_timeout(350)
        page.evaluate('() => userZoom(1)')
        page.wait_for_timeout(700)
        page.evaluate('() => userZoom(1)')
        page.wait_for_timeout(700)
        page.evaluate('() => userZoom(-2)')
        page.wait_for_timeout(900)
    dur = time.time() - t0
    b = page.evaluate('([a, b, c]) => ({ lt: __qa.longtasks.slice(a), gaps: __qa.gaps.slice(b), loaf: __qa.loaf.slice(c), ltOn: __qa.lt, dom: document.getElementsByTagName("*").length })', [a['lt'], a['gaps'], a['loaf']])
    r.perf['pan'] = {'seconds': round(dur, 1), 'longtasks>50ms': len(b['lt']), 'longtasks>200ms': [x for x in b['lt'] if x[1] > 200], 'max_longtask': max([x[1] for x in b['lt']] or [0]),
                     'raf_gaps>200ms': b['gaps'], 'loaf>200ms': b['loaf'], 'longtask_api': b['ltOn'], 'dom_after': b['dom']}
    r.info('Панорамирование', json.dumps(r.perf['pan'], ensure_ascii=False)[:300])
    r.shot(page, 'after-pan')
    if r.p['engine'] == 'chromium':
        r.perf['pan']['metrics'] = chromium_metrics(r, page)
    # A quiet navigation, nobody touching the screen: does anything grow by itself (DOM, listeners, heap)?
    if r.key in ('pixel7', 'win1280', 'iphone15'):
        page = r.new_page(geo=(60.2, 32.2), route=True)
        tgt = (60.2980, 32.1070)  # Varetsky banks, as in the demo
        start = dest(tgt[0], tgt[1], 200, 1600)
        r.gps = Gps(r.ctx, [start, tgt], speed_kmh=20)
        r.gps.start()
        page.evaluate('([a, b]) => startNav({ lat: a, lon: b, title: "QA" })', [tgt[0], tgt[1]])
        r.wait(10000)
        a = page.evaluate('() => ({ lt: __qa.longtasks.length, gaps: __qa.gaps.length })')
        marks = {'10s': chromium_metrics(r, page, gc=True)}
        r.wait(90000)
        marks['100s'] = chromium_metrics(r, page, gc=True)
        r.wait(90000)
        marks['190s'] = chromium_metrics(r, page, gc=True)
        b = page.evaluate('([a, b]) => ({ lt: __qa.longtasks.slice(a), gaps: __qa.gaps.slice(b), ltOn: __qa.lt })', [a['lt'], a['gaps']])
        r.perf['quiet_nav'] = {'metrics_after_gc': marks, 'longtasks>50ms': len(b['lt']), 'longtasks>200ms': [x for x in b['lt'] if x[1] > 200],
                               'raf_gaps>200ms': len(b['gaps']), 'max_raf_gap': max([x[1] for x in b['gaps']] or [0]), 'longtask_api': b['ltOn'],
                               'dist_left': page.evaluate('document.getElementById("ntDist").textContent')}
        r.info('Тихая навигация 3 мин', json.dumps(r.perf['quiet_nav'], ensure_ascii=False)[:500])
        r.gps = None


SCENARIOS = {'s1': s1_start, 's2': s2_card, 's3': s3_sections, 's4': s4_sheets, 's5': s5_nav, 's6': s6_demo, 's7': s7_track,
             's8': s8_offline, 's9': s9_layouts, 's10': s10_desktop, 's11': s11_safe_area, 's12': s12_rotate_night, 'perf': perf}


def applicable(key, scn):
    p = PROFILES[key]
    if scn == 's10':
        return not p['touch']
    if scn == 's9':
        return p['layout'] != 'compact'
    if scn == 's8':
        return key in ('pixel7', 'iphone15')
    if scn == 's11':
        return key in ('iphone15', 'phone_land')
    if scn == 's12':
        return key in ('iphone15', 'pixel7', 'iphonese')
    return True


def run_profile(pw, key, scenarios):
    r = Run(pw, key)
    print(f'=== {key}: {r.p["label"]} ===')
    for s in scenarios:
        if not applicable(key, s):
            continue
        r.scn = s
        r.n = 0
        # fresh numbering per scenario, stale shots of this scenario removed
        for old in r.dir.glob(f'{s}-*.png'):
            try:
                old.unlink()
            except OSError:
                pass
        t0 = time.time()
        try:
            SCENARIOS[s](r)
        except Exception as e:  # noqa: BLE001
            tb = traceback.format_exc(limit=3)
            shot = None
            try:
                shot = r.shot(r.page, 'crash')
            except Exception:  # noqa: BLE001
                pass
            r.check(f'Сценарий {s} выполнился', False, f'{type(e).__name__}: {str(e)[:300]}', sev='серьёзно', shot=shot, level='error', data={'tb': tb})
        finally:
            r.end_page()
            r.gps = None
        print(f'  [{key}/{s}] {time.time() - t0:.0f} s')
        r.save()
    r.close()
    r.save()


# ---------------------------------------------------------------------------------------------------------------
def summary():
    rows, perf = [], {}
    for key in PROFILES:
        f = OUT / key / 'results.json'
        if not f.exists():
            continue
        doc = json.loads(f.read_text(encoding='utf-8'))
        rows.extend(doc['results'])
        perf[key] = doc.get('perf', {})
    lines = ['# QA: сводка автоматического прогона', '', f'Собрано {time.strftime("%Y-%m-%d %H:%M")}. Статусы: pass / fail / warn / info / error.', '']
    by = {}
    for x in rows:
        by.setdefault(x['status'], 0)
        by[x['status']] += 1
    lines.append('Итого: ' + ', '.join(f'{k} {v}' for k, v in sorted(by.items())))
    lines.append('')
    lines.append('## Сводно по проверкам (не pass)')
    lines.append('')
    groups = {}
    for x in rows:
        if x['status'] in ('fail', 'warn', 'error'):
            k = (x['scn'], re.sub(r'^(Клёв|Моё) › \S+|^Сегодня|^Правила', '<раздел>', x['check']))
            groups.setdefault(k, []).append(x)
    for (scn, chk), xs in sorted(groups.items()):
        profs = sorted({x['profile'] for x in xs})
        lines.append(f"- `{scn}` **{chk}** ({xs[0]['sev']}) — {len(xs)} раз, профили: {', '.join(profs)}. Пример: {xs[0]['detail'][:260]}")
    lines.append('')
    lines.append('## Проблемы (fail / warn / error)')
    lines.append('')
    lines.append('| Профиль | Сц. | Проверка | Статус | Серьёзность | Подробности | Скриншот |')
    lines.append('|---|---|---|---|---|---|---|')
    for x in rows:
        if x['status'] in ('fail', 'warn', 'error'):
            d = x['detail'].replace('|', '\\|').replace('\n', ' ')[:400]
            lines.append(f"| {x['profile']} | {x['scn']} | {x['check']} | {x['status']} | {x['sev'] or ''} | {d} | {x['shot'] or ''} |")
    lines.append('')
    lines.append('## Всё по профилям')
    for key in PROFILES:
        rs = [x for x in rows if x['profile'] == key]
        if not rs:
            continue
        lines.append('')
        lines.append(f'### {key} — {PROFILES[key]["label"]}')
        lines.append('')
        for x in rs:
            lines.append(f"- `{x['scn']}` **{x['status']}** {x['check']}: {x['detail'][:300]}")
    lines.append('')
    lines.append('## Производительность')
    lines.append('')
    lines.append('```json')
    lines.append(json.dumps(perf, ensure_ascii=False, indent=1)[:60000])
    lines.append('```')
    (OUT / 'summary.md').write_text('\n'.join(lines), encoding='utf-8')
    (OUT / 'results.json').write_text(json.dumps({'results': rows, 'perf': perf}, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'summary → {OUT / "summary.md"}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--profiles', default=','.join(PROFILES))
    ap.add_argument('--scenarios', default=','.join(ALL_SCENARIOS))
    ap.add_argument('--summary', action='store_true', help='only merge results into research/raw/qa/summary.md')
    ap.add_argument('--base', default=BASE)
    a = ap.parse_args()
    if a.summary:
        summary()
        return
    globals()['BASE'] = a.base
    OUT.mkdir(parents=True, exist_ok=True)
    keys = [k.strip() for k in a.profiles.split(',') if k.strip()]
    scns = [s.strip() for s in a.scenarios.split(',') if s.strip()]
    for k in keys:
        if k not in PROFILES:
            sys.exit(f'unknown profile {k}; known: {", ".join(PROFILES)}')
    for s in scns:
        if s not in SCENARIOS:
            sys.exit(f'unknown scenario {s}; known: {", ".join(SCENARIOS)}')
    with sync_playwright() as pw:
        for k in keys:
            run_profile(pw, k, scns)
    summary()


if __name__ == '__main__':
    main()
