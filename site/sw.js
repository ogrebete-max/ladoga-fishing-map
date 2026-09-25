// Offline support: the app shell and data come from the cache when the lake has no signal; map tiles that
// were viewed once are kept for later (up to TILE_MAX). On a weak signal — a request that hangs rather than
// fails — the saved copy answers after NET_WAIT and the network one still refreshes the cache behind it.
const VERSION = 'ladoga-v31';
const SHELL = ['./', 'index.html', 'log.js', 'app.js', 'wave.js', 'content.js', 'tracks.js', 'geo.js', 'ui.js', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/leaflet-rotate.js', 'vendor/leaflet.markercluster.js', 'vendor/MarkerCluster.css', 'vendor/leaflet-heat.js',
  'data/points.json', 'data/context.json', 'tiles/depth_cover.json', 'tiles/charts_cover.json'];
const TILE_CACHE = 'ladoga-tiles-v1';
const TILE_MAX = 9000;
const NET_WAIT = 3500;
const TILE_HOSTS = /arcgisonline\.com|tile\.openstreetmap\.org|tile\.opentopomap\.org|tiles\.openseamap\.org|nakarte|marshruty|tiles?\./i;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  // The region packs (ladoga-pack-*) and the saved satellite picture (ladoga-sat-*) are the user's downloads:
  // never delete them on an update.
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE && !k.startsWith('ladoga-pack-') && !k.startsWith('ladoga-sat')).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The network first, so a new release shows at once — but no longer than NET_WAIT when a copy is saved.
function networkFirst(event) {
  const { request } = event;
  let stored = Promise.resolve();
  const net = fetch(request).then((response) => {
    if (response.ok) { const copy = response.clone(); stored = caches.open(VERSION).then((c) => c.put(request, copy)); }
    return response;
  });
  event.waitUntil(net.then(() => stored, () => {}).catch(() => {}));
  const saved = () => caches.match(request).then((hit) => hit || caches.match(request, { ignoreSearch: true }));
  const late = new Promise((resolve) => { setTimeout(() => resolve(null), NET_WAIT); });
  return Promise.race([net, late]).then(
    (first) => first || saved().then((hit) => hit || net),
    () => saved().then((hit) => hit || Response.error()),
  );
}
let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - TILE_MAX; i += 1) await cache.delete(keys[i]);
  } finally { trimming = false; }
}
async function tile(request) {
  // A tile from a downloaded region pack or from earlier browsing — whichever cache has it.
  const hit = await caches.match(request);
  if (hit) return hit;
  const cache = await caches.open(TILE_CACHE);
  const response = await fetch(request);
  // Opaque responses are padded to megabytes in the quota; keep only CORS ones.
  if (response.ok && response.type !== 'opaque') {
    cache.put(request, response.clone());
    if (Math.random() < 0.02) trimTiles(cache);
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    // Tile lists (only read when a region is downloaded) go straight to the network, uncached.
    if (/\.txt$/.test(url.pathname)) return;
    // Chart tiles and map sheets: the saved copy first — unless the page asks for a fresh one (a region pack
    // being updated after the charts were rebuilt).
    if (/\/(tiles|overlays)\//.test(url.pathname) && !/\.json$/.test(url.pathname)) {
      if (request.cache === 'no-cache' || request.cache === 'reload') event.respondWith(fetch(request));
      else event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
    } else event.respondWith(networkFirst(event));
  } else if (TILE_HOSTS.test(url.hostname) || /\/\d+\/\d+\/\d+(\.png|\.jpg|\.jpeg)?$/i.test(url.pathname)) {
    event.respondWith(tile(request).catch(() => Response.error()));
  }
});
