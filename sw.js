// Caches the app shell so it opens offline; videos and thumbnails are cached as they are viewed.
const CACHE = "trend-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "img/logo.png", "img/icon-192.png"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin || req.headers.has("range")) return;
  if (req.mode === "navigate") { e.respondWith(fetch(req).catch(() => caches.match("index.html"))); return; }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok && !req.url.endsWith(".mp4")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })));
});
