const CACHE = 'bodyfy-pwa-v5';
const CORE = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './assets/icon.svg', './BodyfyStudio%20Logo.jpg'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(payload.title || 'BodyfyStudio', {
    body: payload.body || 'Your coach sent you an update.',
    icon: '/assets/icon.svg',
    badge: '/assets/icon.svg',
    tag: payload.tag || 'bodyfy-broadcast',
    data: { url: payload.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || '/', self.location.origin);
    const isZoom = target.protocol === 'https:' && (target.hostname === 'zoom.us' || target.hostname.endsWith('.zoom.us'));
    const destination = isZoom
      ? `${self.location.origin}/?join=${encodeURIComponent(target.href)}`
      : target.origin === self.location.origin ? target.href : self.location.origin + '/';
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing && target.origin === self.location.origin) {
      await existing.navigate(destination);
      await existing.focus();
    } else {
      await self.clients.openWindow(destination);
    }
  })());
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put('./index.html', response.clone()));
      return response;
    }).catch(async () => (await caches.match(event.request)) || (await caches.match('./index.html'))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match('./index.html'))));
});
