importScripts('idb-queue.js');

const CACHE_NAME = 'secure-upload-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './idb-queue.js',
  './pdf-lib.min.js',
  './cropper.min.js',
  './cropper.min.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Install: cache the app shell and activate immediately.
// No user confirmation needed — the page reloads automatically via controllerchange.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// Activate: purge old caches and claim all open tabs at once.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      ),
      self.clients.claim(),
    ])
  );
});

// Fetch: serve shell from cache, refresh cache in the background.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Background Sync: flush offline photo queue when connectivity returns.
self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-photo-queue') {
    event.waitUntil(
      pqFlush().then(() => notifyClients({ type: 'queue-updated' }))
    );
  }
});

self.addEventListener('message', (event) => {
  // No SKIP_WAITING message needed anymore — we skip immediately on install.
});

async function notifyClients(msg) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((c) => c.postMessage(msg));
}
