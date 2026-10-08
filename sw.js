const CACHE = 'motion-lab-v11-balance-knee-bend';
const ASSETS = [
  './',
  './index.html',
  './movement-sensor-diagnostics.html',
  './side-camera.html',
  './qrcode.js',
  './assessment.js',
  './biomechanics.js',
  './interpretation.js',
  './raw-store.js',
  './results-ui.js',
  './side-view.js',
  './validation.js',
  './clinic-report.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith('http')) return;

  // HTML pages: always try the network first (so a fresh pairing/session link never
  // shows stale content), fall back to cache only when offline.
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('./movement-sensor-diagnostics.html')))
    );
    return;
  }

  // Static assets (icons, manifest): cache-first, refresh in the background.
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
