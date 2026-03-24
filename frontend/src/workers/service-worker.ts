/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = "recipes-v1";
const STATIC_ASSETS = ["/", "/index.html", "/index.js", "/app.css"];
const VERSION_CHECK_INTERVAL = 60 * 1000; // check every 60s

let knownVersion: string | null = null;

// Install -- pre-cache shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
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
  startVersionCheck();
});

// Fetch -- stale-while-revalidate for static assets
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache version.json
  if (url.pathname === "/version.json") return;

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

// Listen for manual update check from the page
self.addEventListener("message", (event) => {
  if (event.data === "check-update") {
    checkForUpdate();
  }
});

// Periodically check for new version
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
      // First check -- just record the version
      knownVersion = version;
      return;
    }

    if (version !== knownVersion) {
      knownVersion = version;
      // Clear cache and notify all clients
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // Re-cache new assets
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(STATIC_ASSETS);

      // Notify all open tabs
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        client.postMessage({ type: "update-available", version });
      }
    }
  } catch {
    // Offline or fetch failed -- ignore
  }
}

export {};
