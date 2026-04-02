/**
 * Runtime configuration for backend connectivity.
 *
 * Supports two deployment modes:
 *   1. Same-origin (default): frontend and backend share a domain (reverse proxy)
 *   2. Cross-origin: frontend and backend on different domains
 *
 * For cross-origin, add a meta tag to index.html before the app script:
 *   <meta name="backend-url" content="https://api.example.com" />
 *
 * The backend must set FRONTEND_URL to the frontend's origin for CORS.
 */

let cached: { httpBase: string; wsBase: string } | null = null;

function resolve(): { httpBase: string; wsBase: string } {
  if (cached) return cached;

  const meta = document.querySelector<HTMLMetaElement>('meta[name="backend-url"]');
  const backendUrl = meta?.content?.replace(/\/+$/, "") ?? "";

  if (backendUrl) {
    const parsed = new URL(backendUrl);
    const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    cached = {
      httpBase: parsed.origin,
      wsBase: `${wsProtocol}//${parsed.host}`,
    };
  } else {
    // Same-origin mode (default)
    const isDev = location.hostname === "localhost" && location.port === "5000";
    if (isDev) {
      cached = {
        httpBase: `${location.protocol}//${location.hostname}:8000`,
        wsBase: `ws://${location.hostname}:8000`,
      };
    } else {
      const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
      cached = {
        httpBase: location.origin,
        wsBase: `${wsProtocol}//${location.host}`,
      };
    }
  }

  return cached;
}

export function getApiBase(): string {
  return resolve().httpBase;
}

export function getWsUrl(): string {
  return `${resolve().wsBase}/ws`;
}
