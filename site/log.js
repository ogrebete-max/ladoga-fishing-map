'use strict';

/* Ладога · рыболовная карта — the work log (журнал работы).
   The owner's wish (24.09.2026): whatever goes wrong on anyone's phone must be seen and fixed later — what was
   pressed, how GPS behaved, what the navigator did, every error. The log lives in the phone (the last LOG_MAX
   events) and goes to our server in small batches when there is a network; «Сообщить о проблеме» sends it at once
   with the person's own words. No names, no phone numbers, no text typed into the app; places are rounded to about
   a kilometre. Settings → «Отправлять журнал» turns the sending off (the phone keeps its own copy).
   Loaded before every other script: logEvent() may be called from anywhere, even before the map exists. */

const LOG_MAX = 1500;
const LOG_KEY = 'ladoga-log';
const LOG_URL = 'api/log';
const REPORT_URL = 'api/report';
const logState = {
  buf: [], unsent: 0, saveT: 0, sendT: 0, sending: false, off: false, failN: 0,
  iid: '', sid: Math.random().toString(36).slice(2, 10), t0: Date.now(), lastFix: null, fixN: 0, fixLogT: 0,
};
(() => {
  try {
    logState.iid = localStorage.getItem('ladoga-iid') || '';
    if (!logState.iid) { logState.iid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; localStorage.setItem('ladoga-iid', logState.iid); }
    const saved = JSON.parse(localStorage.getItem(LOG_KEY) || 'null');
    if (saved && Array.isArray(saved.buf)) { logState.buf = saved.buf.slice(-LOG_MAX); logState.unsent = Math.min(saved.unsent || 0, logState.buf.length); }
  } catch { /* private mode: the log lives only in memory */ }
})();
// Whether our server takes the log yet (site/api.json; the route on the shared web server is a separate step):
// until it does, nothing is sent — no failed requests on every launch.
let logApi = null;
async function logApiOn() {
  if (logApi != null) return logApi;
  try { logApi = !!(await fetch('api.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {}))).log; } catch { logApi = false; }
  return logApi;
}
// The name a person chose to give in Settings (empty unless they typed it): «кто что нажимает» for the owner.
const logWho = () => { try { return String(JSON.parse(localStorage.getItem('ladoga-settings') || '{}').whoName || '').slice(0, 40); } catch { return ''; } };
const logSendingOn = () => { try { return JSON.parse(localStorage.getItem('ladoga-settings') || '{}').sendLog !== false; } catch { return true; } };
const round2 = (x) => Math.round(x * 100) / 100;

function logEvent(e, fields) {
  const ev = { t: Date.now(), e };
  if (fields) for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') ev[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  logState.buf.push(ev);
  logState.unsent += 1;
  if (logState.buf.length > LOG_MAX) {
    const cut = logState.buf.length - LOG_MAX;
    logState.buf.splice(0, cut);
    logState.unsent = Math.min(logState.unsent, logState.buf.length);
  }
  logSaveSoon();
  logSendSoon();
}
// A GPS fix: every 5 s while the navigator or a recording runs, every 30 s otherwise — and at once whatever looks
// wrong: a gap, a jump the speed does not explain, a poor fix, the phone's speed far from the way made.
function logFix(p, c) {
  const prev = logState.lastFix;
  logState.lastFix = { lat: p.lat, lon: p.lon, t: p.t };
  logState.fixN += 1;
  const busy = (typeof nav !== 'undefined' && nav.on) || (typeof trk !== 'undefined' && trk.cur?.state === 'rec');
  const dt = prev ? p.t - prev.t : null;
  const d = prev ? distM(prev, p) : null;
  const made = dt && dt > 0 ? d / (dt / 1000) : null;
  const gps = Number.isFinite(c.speed) ? c.speed : null;
  const odd = (dt != null && dt > 5000) || p.acc > 50 || (gps != null && gps >= 0 && made != null && dt >= 900 && Math.abs(made - gps) > Math.max(3, 0.3 * gps));
  const every = busy ? 5000 : 30000;
  if (!odd && p.t - logState.fixLogT < every) return;
  logState.fixLogT = p.t;
  logEvent('fix', {
    acc: Math.round(p.acc), v: gps == null ? null : Math.round(gps * 36) / 10, made: made == null ? null : Math.round(made * 36) / 10,
    sog: typeof geo !== 'undefined' && geo.sog != null ? Math.round(geo.sog * 36) / 10 : null,
    hdg: Number.isFinite(c.heading) ? Math.round(c.heading) : null, dt, d: d == null ? null : Math.round(d),
    n: logState.fixN, odd: odd || null, at: `${round2(p.lat)},${round2(p.lon)}`,
  });
}
function logSaveSoon() {
  if (logState.saveT) return;
  logState.saveT = setTimeout(logSave, 4000);
}
function logSave() {
  clearTimeout(logState.saveT); logState.saveT = 0;
  try { localStorage.setItem(LOG_KEY, JSON.stringify({ buf: logState.buf, unsent: logState.unsent })); } catch { /* full: the in-memory log goes on */ }
}
function logSendSoon(ms = 20000) {
  if (logState.sendT || logState.off) return;
  logState.sendT = setTimeout(() => { logState.sendT = 0; logSend(); }, ms);
}
function logPayload(events) {
  return {
    v: 1, iid: logState.iid, sid: logState.sid, app: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '', who: logWho(),
    ua: navigator.userAgent.slice(0, 200), sent: Date.now(), events,
  };
}
// Unsent events go in batches of up to 300; a server without the log address yet (404) stops the sending for
// this launch, errors and no network try again later. Beacon when the page is being hidden.
async function logSend({ beacon = false } = {}) {
  if (logState.off || logState.sending || !logState.unsent || !logSendingOn() || !navigator.onLine) return;
  if (beacon ? logApi !== true : !(await logApiOn())) { if (logApi === false) logState.off = true; return; }
  const events = logState.buf.slice(-logState.unsent).slice(0, 300);
  const body = JSON.stringify(logPayload(events));
  if (beacon && navigator.sendBeacon) {
    if (navigator.sendBeacon(LOG_URL, new Blob([body], { type: 'text/plain' }))) logState.unsent -= events.length;
    logSave();
    return;
  }
  logState.sending = true;
  try {
    const r = await fetch(LOG_URL, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: body.length < 60000 });
    if (r.ok) { logState.unsent = Math.max(0, logState.unsent - events.length); logState.failN = 0; logSave(); if (logState.unsent) logSendSoon(2000); }
    else if (r.status === 404 || r.status === 405) logState.off = true;
    else { logState.failN += 1; logSendSoon(Math.min(600000, 30000 * 2 ** logState.failN)); }
  } catch { logState.failN += 1; logSendSoon(Math.min(600000, 30000 * 2 ** logState.failN)); }
  logState.sending = false;
}
// «Сообщить о проблеме»: the person's words, the last 40 minutes of the log and what the screen is. Sent to the
// server; without it (or without a network) the phone's share sheet takes it (Telegram, mail).
async function sendProblemReport(text) {
  const since = Date.now() - 40 * 60000;
  const report = { ...logPayload(logState.buf.filter((ev) => ev.t >= since)), kind: 'report', text: String(text || '').slice(0, 2000),
    screen: `${innerWidth}×${innerHeight}@${devicePixelRatio}`, standalone: !!(matchMedia('(display-mode: standalone)').matches || navigator.standalone) };
  logEvent('report_sent', { len: report.text.length });
  try {
    if (await logApiOn()) {
      const r = await fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(report), headers: { 'Content-Type': 'text/plain' } });
      if (r.ok) return 'server';
    }
  } catch { /* offline */ }
  const file = new File([JSON.stringify(report, null, 1)], `ladoga-report-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Ладога: сообщение о проблеме', text: report.text }); return 'share'; }
  } catch { /* cancelled */ }
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return 'file';
  } catch { return ''; }
}

/* ---------- what is recorded by itself ---------- */
window.addEventListener('error', (e) => {
  logEvent('error', { msg: String(e.message || '').slice(0, 200), src: String(e.filename || '').split('/').pop(), line: e.lineno, col: e.colno, stack: String(e.error?.stack || '').slice(0, 400) });
});
window.addEventListener('unhandledrejection', (e) => {
  logEvent('error', { msg: `promise: ${String(e.reason?.message || e.reason || '').slice(0, 200)}`, stack: String(e.reason?.stack || '').slice(0, 400) });
});
// What was pressed: the button's action or id, never the text in fields. A button without either says what it
// chooses — a weather place, a chip, a preset (26.09.2026: 70 of 182 taps came as a bare «button»); only these keys,
// never names, coordinates or search text.
const TAP_KEYS = ['wxplace', 'chip', 'preset', 'set', 'cond', 'tseason', 'tfish', 'sheetTab', 'pointsFilter', 'pageLink', 'notice',
  'month', 'smonth', 'season', 'tag', 'pack', 'theme', 'size', 'iceKind', 'openMarker', 'zone'];
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('button, a, [data-act], [data-page], label, .leaflet-marker-icon');
  if (!el) return;
  const d = el.dataset || {};
  const k = TAP_KEYS.find((x) => d[x] != null && d[x] !== '');
  const what = d.act || d.page || d.overlay || d.base || d.kind || d.setting || el.id || (k ? `${k}:${String(d[k]).slice(0, 40)}` : '')
    || (el.classList.contains('leaflet-marker-icon') ? 'marker' : '') || el.getAttribute('aria-label') || el.tagName.toLowerCase();
  logEvent('tap', { what: String(what).slice(0, 60), v: d.val || d.base || undefined });
}, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => {
  logEvent(document.hidden ? 'hidden' : 'visible');
  if (document.hidden) { logSave(); logSend({ beacon: true }); }
});
window.addEventListener('pagehide', () => { logSave(); logSend({ beacon: true }); });
window.addEventListener('online', () => { logEvent('online'); logSendSoon(3000); });
window.addEventListener('offline', () => logEvent('offline'));
// Long freezes of the page (Chrome, Android): how many and how long, once a minute.
try {
  let long = { n: 0, ms: 0 };
  new PerformanceObserver((list) => { for (const x of list.getEntries()) { long.n += 1; long.ms += x.duration; } }).observe({ type: 'longtask', buffered: true });
  setInterval(() => { if (long.n) { logEvent('slow', { n: long.n, ms: Math.round(long.ms) }); long = { n: 0, ms: 0 }; } }, 60000);
} catch { /* not supported (iPhone) */ }
logEvent('start', {
  standalone: !!(matchMedia('(display-mode: standalone)').matches || navigator.standalone), screen: `${screen.width}×${screen.height}@${devicePixelRatio}`,
  lang: navigator.language, online: navigator.onLine, sw: !!navigator.serviceWorker?.controller, mem: navigator.deviceMemory,
});
