// Offline support: the app shell and data come from the cache when the lake has
// no signal; map tiles that were viewed once are kept for later (up to TILE_MAX).
const VERSION = 'ladoga-v25';
const SHELL = ['./', 'index.html', 'app.js', 'content.js', 'tracks.js', 'geo.js', 'ui.js', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/leaflet-rotate.js', 'vendor/leaflet.markercluster.js', 'vendor/MarkerCluster.css', 'vendor/leaflet-heat.js',
  'data/points.json', 'data/context.json'];
const TILE_CACHE = 'ladoga-tiles-v1';
const TILE_MAX = 9000;
const TILE_HOSTS = /arcgisonline\.com|tile\.openstreetmap\.org|tile\.opentopomap\.org|tiles\.openseamap\.org|nakarte|marshruty|tiles?\./i;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  // The region packs (ladoga-pack-*) are the user's downloads: never delete them on an update.
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE && !k.startsWith('ladoga-pack-')).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match(request, { ignoreSearch: true })) || Response.error();
  }
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
  if (url.origin === self.location.origin && /\/(tiles|overlays)\//.test(url.pathname)) {
    // Chart tiles and map sheets never change under the same name: the saved copy first.
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
  } else if (url.origin === self.location.origin) {
    // Always try the network first so a new release shows at once; fall back offline.
    event.respondWith(networkFirst(request));
  } else if (TILE_HOSTS.test(url.hostname) || /\/\d+\/\d+\/\d+(\.png|\.jpg|\.jpeg)?$/i.test(url.pathname)) {
    event.respondWith(tile(request).catch(() => Response.error()));
  }
});
