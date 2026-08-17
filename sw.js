// NAZE AI — Service Worker
// Cache the app shell so the UI still opens offline.
// Live AI requests (api.anthropic.com) are always network-only — never cached,
// so answers are never served stale or fake.

const CACHE_NAME = 'naze-ai-shell-v1';
const APP_SHELL = [
  './naze-ai.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls or cross-origin CDN calls needed live (fonts/scripts can go network-first).
  if (url.hostname.includes('anthropic.com')) {
    return; // let it hit the network untouched
  }

  if (event.request.method !== 'GET') return;

  // App shell: cache-first, so it opens instantly and works offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // Third-party assets (fonts, CDN libs): network-first, fall back to cache.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
