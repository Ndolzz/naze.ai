// NAZE AI — Service Worker
// Cache the app shell so the UI still opens offline.
// Live AI requests (/api/) are always network-only — never cached, and
// never carrying anything sensitive (API keys, tokens) since those never
// leave the server in the first place — so answers are never served stale
// or fake.

// v3: fixed a broken asset reference (APP_SHELL pointed at './icon-512.png',
// a file that was never actually part of this project — install silently
// failed as a result, since caches.addAll() rejects the whole batch if any
// single URL 404s). Also split the single cache into a STATIC_CACHE (this
// app's own shell: HTML/manifest/icons) and a RUNTIME_CACHE (third-party
// CDN assets: fonts, marked/dompurify/highlight.js), and made install
// resilient to any one asset failing instead of all-or-nothing.
// v4: index.html was split from one monolithic file into separate
// css/js/src modules for maintainability (styles, ~14 js/ modules, and a
// new src/voice/ layer for Voice Mode). All of them are now load-bearing
// for the app shell to even render, so they're added to APP_SHELL for
// install-time precaching instead of relying only on opportunistic
// runtime caching after first successful load.
const SW_VERSION = 'v4';
const STATIC_CACHE = `naze-static-${SW_VERSION}`;
const RUNTIME_CACHE = `naze-runtime-${SW_VERSION}`;
const CURRENT_CACHES = new Set([STATIC_CACHE, RUNTIME_CACHE]);

// Only reference assets that actually exist in this project.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './memory-service.js',
  './css/styles.css',
  './js/storage.js',
  './js/state.js',
  './js/pwa.js',
  './js/preferences.js',
  './js/chats.js',
  './js/utils.js',
  './js/markdown.js',
  './js/attachments.js',
  './js/message-render.js',
  './js/chat-engine.js',
  './js/events.js',
  './js/settings.js',
  './js/auth.js',
  './js/main.js',
  './src/voice/speech-cleaner.js',
  './src/voice/speech-recognition.js',
  './src/voice/speech-synthesis.js',
  './src/voice/voice-controller.js',
  './src/voice/voice-ui.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Cache each asset independently — one missing/failed asset must
      // never take down the whole install (and therefore the whole
      // offline experience) the way a single caches.addAll() call would.
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !CURRENT_CACHES.has(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Never intercept our own API routes — chat/image-generation requests
  // must always hit the network live. Never cached, no fallback to a
  // stale/fake response, and nothing sensitive is ever stored here.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return;
  }

  // App shell (this app's own HTML/manifest/icons): network-first, so a
  // fresh Vercel deploy shows up the moment the user is online, with the
  // cached copy only used as an offline fallback. A pure cache-first
  // strategy here was the bug that made updates never appear until the
  // cache was manually cleared.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Third-party assets (fonts, CDN libs): network-first, fall back to
  // cache — kept in a separate runtime cache from the app shell so the two
  // can be reasoned about (and cleared) independently.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
