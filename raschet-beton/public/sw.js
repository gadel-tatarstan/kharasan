/* Offline shell for the concrete calculator.
   Network-first for the app page so a fresh build is picked up, cache-first for
   same-origin assets. The cache name is bumped with every shell change: the old
   cache is dropped on activate, so a stale page can never pair old HTML with a
   missing hashed asset. */
const CACHE = 'beton-v2';
const PRECACHE = [
  './',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

/** A real Response for a failed fetch: never return undefined to respondWith. */
const offline = () =>
  new Response('Нет сети', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put('./', copy))
            .catch(() => undefined);
          return response;
        })
        .catch(async () => {
          const hit = (await caches.match('./')) || (await caches.match('./index.html'));
          return hit || offline();
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches
              .open(CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => undefined);
          }
          return response;
        })
        .catch(() => offline());
    }),
  );
});
