importScripts('idb-queue.js');

const CACHE_NAME = 'photo-upload-shell-v5';
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

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  // Don't skipWaiting here — we let the page decide when it's safe to activate
  // (e.g. after the upload queue drains) via a SKIP_WAITING message.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim().then(async () => {
    // Tell every open tab to reload now that the new SW is in control.
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.postMessage({ type: 'SW_UPDATED' }));
  });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET requests for our own app shell. Everything else
  // (uploads, health checks, cross-origin API calls) goes straight to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Fired by the browser/OS when connectivity returns, even if no tab is open
// (supported on Android Chrome/Edge and desktop Chromium; iOS Safari does not
// support Background Sync, so there the queue flushes when the app is reopened).
self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-photo-queue') {
    event.waitUntil(pqFlush().then(notifyClients));
  }
});

async function notifyClients() {
  const clients = await self.clients.matchAll();
  clients.forEach((c) => c.postMessage({ type: 'queue-updated' }));
}

// Page sends SKIP_WAITING when the user confirms the update and the queue is safe.
// SW immediately takes over all clients, then each client reloads itself.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
