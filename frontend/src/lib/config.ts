/**
 * Runtime configuration for backend connectivity.
 *
 * Supports two deployment modes:
 *   1. Same-origin (default): frontend and backend share a domain (reverse proxy)
 *   2. Cross-origin: frontend and backend on different domains
 *
 * For cross-origin, the frontend Dockerfile injects a meta tag at runtime:
 *   <meta name="backend-url" content="https://api.example.com" />
 * This is driven by BACKEND_HOST + BACKEND_HTTPS env vars on the frontend container.
 */

let cached: { httpBase: string; wsBase: string } | null = null;

function resolve(): { httpBase: string; wsBase: string } {
  if (cached) return cached;

  const meta = document.querySelector<HTMLMetaElement>('meta[name="backend-url"]');
  const backendUrl = meta?.content?.replace(/\/+$/, "") ?? "";

  if (backendUrl) {
    // Cross-origin or dev: backend URL injected by server (dev-server.ts or Dockerfile)
    const parsed = new URL(backendUrl);
    const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    cached = {
      httpBase: parsed.origin,
      wsBase: `${wsProtocol}//${parsed.host}`,
    };
  } else {
    // Same-origin: frontend and backend on the same host (reverse proxy)
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    cached = {
      httpBase: location.origin,
      wsBase: `${wsProtocol}//${location.host}`,
    };
  }

  return cached;
}

export function getApiBase(): string {
  return resolve().httpBase;
}

export function getWsUrl(): string {
  return `${resolve().wsBase}/ws`;
}
