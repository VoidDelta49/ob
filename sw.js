// Cache blocker for the game. Every same-origin request goes to the network with `cache: 'no-cache'`, which makes the
// browser revalidate with the server (a cheap 304 when nothing changed) instead of serving a stale copy. The last good
// response is kept so the game still opens offline. Cross-origin files (the pinned three.js CDN build) are left alone.
const STORE = 'ob-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== STORE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }); // by URL: a navigate Request can't take an init
      if (res.ok) { const copy = res.clone(); caches.open(STORE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
