/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = "recipes-v1";
const VERSION_CHECK_INTERVAL = 60 * 1000;

let knownVersion: string | null = null;

// Install -- pre-cache shell using the generated asset manifest
self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch("/asset-manifest.json")
      .then((res) => res.json())
      .then((manifest: { assets: string[] }) =>
        caches.open(CACHE_NAME).then((cache) => cache.addAll(manifest.assets))
      )
      .catch(() =>
        // Fallback to known static assets if manifest fails
        caches.open(CACHE_NAME).then((cache) => cache.addAll(["/", "/index.html", "/index.js", "/app.css"]))
      )
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

  // Never cache version.json or asset-manifest.json
  if (url.pathname === "/version.json" || url.pathname === "/asset-manifest.json") return;

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
  if (event.data === "check-update") {
    checkForUpdate();
  }
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

      // Re-cache from manifest
      try {
        const manifestRes = await fetch("/asset-manifest.json", { cache: "no-store" });
        const manifest = await manifestRes.json();
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(manifest.assets);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(["/", "/index.html", "/index.js", "/app.css"]);
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
