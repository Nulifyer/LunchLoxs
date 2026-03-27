/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = "recipes-v1";
const VERSION_CHECK_INTERVAL = 60 * 1000;
const STATIC_FALLBACK = ["/", "/index.html", "/index.js", "/app.css"];

let knownVersion: string | null = null;
const isDev = self.location.hostname === "localhost" || self.location.hostname === "127.0.0.1";

// Install -- pre-cache shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        const res = await fetch("/asset-manifest.json");
        const manifest = await res.json();
        await cache.addAll(manifest.assets);
      } catch {
        await cache.addAll(STATIC_FALLBACK);
      }
    })
  );
  self.skipWaiting();
});

// Activate -- clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
  // Only poll for version changes in production
  if (!isDev) startVersionCheck();
});

// Fetch -- stale-while-revalidate for static assets
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/version.json" || url.pathname === "/asset-manifest.json") return;

  // In dev, always go to network first so changes are picked up immediately
  if (isDev) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || new Response("Offline", { status: 503 })))
    );
    return;
  }

  // Production: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
      return cached || fetched;
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "check-update") checkForUpdate();
  if (event.data === "visibility-visible") checkForUpdate();
});

function startVersionCheck() {
  checkForUpdate();
  setInterval(checkForUpdate, VERSION_CHECK_INTERVAL);
}

async function checkForUpdate() {
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return;
    const { version } = await res.json();

    if (knownVersion === null) {
      knownVersion = version;
      return;
    }

    if (version !== knownVersion) {
      knownVersion = version;
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));

      try {
        const manifestRes = await fetch("/asset-manifest.json", { cache: "no-store" });
        const manifest = await manifestRes.json();
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(manifest.assets);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(STATIC_FALLBACK);
      }

      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        client.postMessage({ type: "update-available", version });
      }
    }
  } catch {
    // Offline or fetch failed
  }
}

export {};
