const CACHE_NAME = 'randofly-cache-v7';
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './geo.js',
  './parse.js',
  './elevation.js',
  './flight.js',
  './manifest.json',
  './icon.svg',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './vendor/jszip.min.js',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      ),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  let pathname = null;
  try { pathname = new URL(request.url).pathname; } catch (e) { /* requêtes cross-origin (tuiles IGN, altimétrie) */ }

  const isAppFile =
    request.mode === 'navigate' ||
    (pathname && PRECACHE_ASSETS.some((asset) => pathname.endsWith(asset.replace('./', '/'))));

  if (isAppFile) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Tuiles orthophoto IGN, service d'altimétrie : cache-first (ne dépend pas
  // de la version de l'app), avec repli réseau si absent du cache.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
