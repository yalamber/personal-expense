/*
 * The service worker: the app opens and reads without a connection.
 *
 *  - the built app (this version's files) is cached on install, so the shell always loads
 *  - GET answers from the API are kept after each successful fetch; with no connection the last
 *    one is served, marked with the time it was saved, so Today and the Plan still show figures
 *  - fonts are kept once seen
 *  - writes are never touched here; the app queues them itself and replays when back online
 *
 * __VERSION__ and __ASSETS__ are filled in by the build (vite.config.ts), so every build is a
 * new worker with a fresh shell cache.
 */
const VERSION = "__VERSION__";
const ASSETS = __ASSETS__;
const SHELL = `shell-${VERSION}`;
const API = "api-v1";
const FONTS = "fonts-v1";
const NETWORK_WAIT_MS = 8000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(["/", "/index.html", "/manifest.webmanifest", ...ASSETS]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith("shell-") && n !== SHELL).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "clear-api") event.waitUntil(caches.delete(API));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/auth/")) return;
    if (url.pathname.startsWith("/api/")) return event.respondWith(apiFirst(req));
    if (req.mode === "navigate") return event.respondWith(shellFirst(req));
    if (url.pathname.startsWith("/assets/") || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/")) return event.respondWith(cacheFirst(req, SHELL));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") return event.respondWith(cacheFirst(req, FONTS));
});

/** Hashed files never change: the cache wins, the network fills it. */
async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

/** The app itself: fresh when the network answers, the cached shell when it does not. */
async function shellFirst(req) {
  try {
    const res = await withTimeout(fetch(req), NETWORK_WAIT_MS);
    if (res.ok) {
      const cache = await caches.open(SHELL);
      await cache.put("/index.html", res.clone());
    }
    return res;
  } catch {
    const cache = await caches.open(SHELL);
    return (await cache.match("/index.html")) ?? Response.error();
  }
}

/**
 * API reads: the network first, with the answer kept for later; the kept answer, stamped with
 * when it was saved, if the network is down or too slow. A sign-out (401) empties the store.
 */
async function apiFirst(req) {
  const cache = await caches.open(API);
  const offline = self.navigator && self.navigator.onLine === false;
  if (!offline) {
    try {
      const res = await withTimeout(fetch(req), NETWORK_WAIT_MS);
      if (res.ok) {
        const headers = new Headers(res.headers);
        headers.set("x-cached-at", new Date().toISOString());
        const body = await res.clone().arrayBuffer();
        await cache.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers }));
      } else if (res.status === 401) {
        await caches.delete(API);
      }
      return res;
    } catch {
      // fall through to the cache
    }
  }
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("x-from-cache", hit.headers.get("x-cached-at") ?? "");
    return new Response(await hit.arrayBuffer(), { status: hit.status, headers });
  }
  return new Response(JSON.stringify({ error: "offline", message: "You're offline, and this page hasn't been saved on this phone yet." }), {
    status: 503,
    headers: { "content-type": "application/json", "x-offline": "1" },
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
