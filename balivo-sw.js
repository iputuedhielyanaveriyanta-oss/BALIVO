const CACHE_NAME = 'balivo-pwa-v2';
const APP_SHELL = [
  './',
  './index.html',
  './balivo-manifest.webmanifest',
  './icons/icon-192-v2.png',
  './icons/icon-512-v2.png',
  './icons/icon-512-maskable-v2.png',
  './icons/icon-180-v2.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Keep live Supabase/product/payment data online-first.
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
      return response;
    }).catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
  );
});
