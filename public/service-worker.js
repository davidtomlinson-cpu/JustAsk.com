// JustAsk.com service worker
// Caches the app shell so the app installs cleanly and reopens instantly /
// shows something useful offline. All /api/ calls always go to the network —
// order data must never be served stale.

const CACHE_VERSION = 'justask-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache API calls — orders, statuses and pricing must always be fresh.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for the app shell so updates are picked up quickly,
  // falling back to cache when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')))
  );
});

// Real push notifications — sent per-order, e.g. when staff message a
// customer about their request. Falls back to plain defaults if the push
// payload can't be parsed as JSON for any reason, so a malformed payload
// never means a silently-dropped notification.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* fall through to defaults below */ }
  const title = data.title || 'JustAsk.com';
  const options = {
    body: data.body || 'You have an update on your order.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { requestId: data.requestId || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
