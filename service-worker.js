const APP_SHELL_CACHE = 'anistub-shell-v1';
const API_CACHE = 'anistub-api-v1';
const IMG_CACHE = 'anistub-img-v1';

// Everything the app needs to boot with zero network.
// Adjust this list to match your actual file names/paths.
const APP_SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/AniStub-192.png',
  './icons/AniStub-512.png'
];

// ============== INSTALL: cache the app shell ==============
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL_FILES))
  );
  self.skipWaiting();
});

// ============== ACTIVATE: clean up old cache versions ==============
self.addEventListener('activate', (event) => {
  const currentCaches = [APP_SHELL_CACHE, API_CACHE, IMG_CACHE];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !currentCaches.includes(key))
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ============== FETCH: route by request type ==============
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests — POST/etc pass straight through
  if (request.method !== 'GET') return;

  // AniList API calls: network-first, fall back to cache when offline
  if (url.hostname === 'graphql.anilist.co') {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // AniList cover images: cache-first, since covers never change once fetched
  if (url.hostname === 's4.anilist.co') {
    event.respondWith(cacheFirst(request, IMG_CACHE));
    return;
  }

  // Everything else (your own app files): cache-first, network fallback
  event.respondWith(cacheFirst(request, APP_SHELL_CACHE));
});

// ============== STRATEGIES ==============
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
    return response;
  } catch (err) {
    return new Response('Offline and not cached.', {
      status: 503,
      statusText: 'Offline'
    });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ data: { Page: { media: [] } }, offline: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}