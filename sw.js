const CACHE_NAME = 'petstore-scadenze-v155';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=1.55',
  './app.js?v=1.55',
  './styles.css',
  './app.js',
  './manifest.json',
  './logo-petstore.png',
  './products.json',
  './suppliers.json',
  './supplier-conditions.json',
  './accessory-eans.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const clone = res.clone();
        if (event.request.method === 'GET' && res.status === 200) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
