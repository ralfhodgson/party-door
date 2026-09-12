// Service worker: keeps the app shell available if the network drops at load
// time. Same-origin GETs are network-first with cache fallback; everything
// else (Firestore, Google auth) goes straight to the network.
const CACHE = 'party-door-v5';
const SHELL = ['./', './index.html', './styles.css', './app.js', './store-demo.js', './store-firebase.js',
  './partiful.js', './firebase-config.js', './vendor/firebase.js', './icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first so a reload always shows the latest version when online;
// the cached copy is the fallback when the signal is gone.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      return cached || new Response('Offline and not cached', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  }));
});
