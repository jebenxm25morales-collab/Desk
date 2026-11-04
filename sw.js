/* Service worker: caches the app shell only (never data: d/, api/, fixtures/ always go to the network,
   so a stale number is never shown as current). Web push: one line, tap opens the coin's FOMO link that
   the server put in the payload (built by links.py). */
const CACHE = "desk-shell-v2";
const SHELL = ["./", "index.html", "app.css", "app.js", "chart.js", "manifest.json", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== self.location.origin) return;
  if (/\/(api|d|fixtures)\//.test(u.pathname)) return;               // data: network only
  e.respondWith(fetch(e.request).then((r) => {                        // shell: network first, cache fallback
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Grok Bot", {
    body: d.body || "", icon: d.icon || "icons/icon-192.png", badge: "icons/icon-192.png",
    tag: d.mint || undefined, data: { url: d.url || null },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url;
  if (url) e.waitUntil(self.clients.openWindow(url));
});
