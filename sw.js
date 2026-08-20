// NAZE AI — Service Worker
// Cache the app shell so the UI still opens offline.
// Live AI requests (/api/chat) are always network-only — never cached,
// so answers are never served stale or fake.

// v2: bumped to invalidate the old broken cache (v1 pointed at a
// filename that never existed, so it never actually cached anything).
const CACHE_NAME = 'naze-ai-shell-v2';
const APP_SHELL = [
  './',
  './index.html',
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
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Never intercept our own API route — chat requests must always hit
  // the network live, never cache and never fall back to a stale copy.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return;
  }

  // App shell (this app's own HTML/CSS/JS/icons): network-first, so a
  // fresh Vercel deploy shows up the moment the user is online, with
  // the cached copy only used as an offline fallback. A pure cache-first
  // strategy here was the bug that made updates never appear until the
  // cache was manually cleared.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Third-party assets (fonts, CDN libs): network-first, fall back to cache.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
