// SoundXs Service Worker — App-grade PWA
// v22: push notification, background sync, shortcut handler, offline full
const CACHE     = "soundxs-v22";
const AUDIO_CACHE = "soundxs-audio-v1";
const LOCAL     = ["/", "/index.html", "/soundxs-api-client.js", "/audio.js",
                   "/manifest.json", "/favicon.ico", "/favicon-32x32.png",
                   "/android-chrome-192x192.png", "/android-chrome-512x512.png",
                   "/apple-touch-icon.png", "/offline.html"];
const CDN_HOSTS = ["cdn.tailwindcss.com","unpkg.com","cdn.jsdelivr.net",
                   "cdnjs.cloudflare.com","fonts.googleapis.com","fonts.gstatic.com"];

/* ── INSTALL ────────────────────────────────────────────── */
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(LOCAL.map(u => c.add(u).catch(() => {})));
  })());
  self.skipWaiting();
});

/* ── ACTIVATE ───────────────────────────────────────────── */
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE && k !== AUDIO_CACHE).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ── FETCH ──────────────────────────────────────────────── */
function putCopy(req, res) {
  if (res && (res.ok || res.type === "opaque")) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);

  // Audio offline cache — kalau sudah di-cache, serve langsung
  if (url.pathname.startsWith("/api/audio") || req.destination === "audio") {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).catch(() => Response.error()))
    );
    return;
  }

  // CDN & cover art
  if (url.origin !== location.origin) {
    const isCdn = CDN_HOSTS.includes(url.hostname);
    const isArt = req.destination === "image" && /sndcdn\.com$/.test(url.hostname);
    if (!isCdn && !isArt) return;
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(r => putCopy(req, r)).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  if (url.pathname.startsWith("/api/")) return;

  // App shell & halaman: network-first, fallback cache
  e.respondWith(
    fetch(req).then(r => putCopy(req, r)).catch(async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") {
        return (await caches.match("/index.html")) ||
               (await caches.match("/")) ||
               (await caches.match("/offline.html")) ||
               new Response("<h1>Offline</h1>", { headers: { "Content-Type": "text/html" } });
      }
      return Response.error();
    })
  );
});

/* ── PUSH NOTIFICATION ──────────────────────────────────── */
self.addEventListener("push", (e) => {
  let data = { title: "SoundXs", body: "Ada notifikasi baru", icon: "/android-chrome-192x192.png" };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon || "/android-chrome-192x192.png",
      badge:   "/favicon-32x32.png",
      image:   data.image,
      tag:     data.tag || "soundxs-push",
      data:    data,
      actions: data.actions || [],
      silent:  false,
      vibrate: [100, 50, 100],
    })
  );
});

/* ── NOTIFICATION CLICK ─────────────────────────────────── */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const action  = e.action;
  const payload = e.notification.data || {};

  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
      // Coba fokus window yang sudah ada
      const existing = cs.find(c => c.url.includes(self.registration.scope));
      const target   = existing || cs[0];

      const msg = { type: "notif-action", action, payload };

      if (target) {
        target.focus();
        target.postMessage(msg);
      } else {
        // Buka window baru kalau tidak ada yang terbuka
        let openUrl = "/";
        if (action === "search")  openUrl = "/?shortcut=search";
        if (action === "library") openUrl = "/?shortcut=library";
        clients.openWindow(openUrl).then(c => { if (c) c.postMessage(msg); });
      }
    })
  );
});

/* ── BACKGROUND SYNC ────────────────────────────────────── */
self.addEventListener("sync", (e) => {
  if (e.tag === "soundxs-sync-likes") {
    e.waitUntil(syncPendingLikes());
  }
});

async function syncPendingLikes() {
  // placeholder — sync likes yang gagal saat offline
  const cs = await clients.matchAll();
  cs.forEach(c => c.postMessage({ type: "bg-sync", tag: "soundxs-sync-likes" }));
}

/* ── PERIODIC BACKGROUND SYNC ───────────────────────────── */
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "soundxs-refresh-picks") {
    e.waitUntil(refreshPicksInBackground());
  }
});

async function refreshPicksInBackground() {
  const cs = await clients.matchAll();
  cs.forEach(c => c.postMessage({ type: "periodic-sync", tag: "soundxs-refresh-picks" }));
}

/* ── MESSAGE (dari halaman) ─────────────────────────────── */
self.addEventListener("message", (e) => {
  if (!e.data) return;

  // Cache audio track untuk offline
  if (e.data.type === "CACHE_AUDIO") {
    const { url, trackId } = e.data;
    if (!url || !trackId) return;
    caches.open(AUDIO_CACHE).then(async c => {
      try {
        const existing = await c.match(url);
        if (existing) { e.source && e.source.postMessage({ type: "AUDIO_CACHED", trackId, cached: true }); return; }
        const res = await fetch(url);
        if (res.ok) {
          await c.put(url, res);
          e.source && e.source.postMessage({ type: "AUDIO_CACHED", trackId, cached: true });
        }
      } catch(err) {
        e.source && e.source.postMessage({ type: "AUDIO_CACHE_FAIL", trackId, error: err.message });
      }
    });
    return;
  }

  // Cek apakah audio sudah di-cache
  if (e.data.type === "CHECK_AUDIO_CACHE") {
    const { url, trackId } = e.data;
    caches.open(AUDIO_CACHE).then(async c => {
      const hit = await c.match(url);
      e.source && e.source.postMessage({ type: "AUDIO_CACHE_STATUS", trackId, cached: !!hit });
    });
    return;
  }

  // Hapus audio dari cache
  if (e.data.type === "DELETE_AUDIO_CACHE") {
    const { url, trackId } = e.data;
    caches.open(AUDIO_CACHE).then(async c => {
      await c.delete(url);
      e.source && e.source.postMessage({ type: "AUDIO_CACHE_DELETED", trackId });
    });
    return;
  }

  if (e.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ── SHARE TARGET ───────────────────────────────────────── */
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.searchParams.has("shortcut")) {
    const shortcut = url.searchParams.get("shortcut");
    e.waitUntil(
      clients.matchAll({ type: "window" }).then(cs => {
        if (cs.length) cs[0].postMessage({ type: "shortcut", value: shortcut });
      })
    );
  }
});
