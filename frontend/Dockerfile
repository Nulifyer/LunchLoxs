FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY <<'EOF' serve.ts
const backendHost = Bun.env.BACKEND_HOST ?? "";
const backendHttps = Bun.env.BACKEND_HTTPS === "true";
const backendUrl = backendHost ? `${backendHttps ? "https" : "http"}://${backendHost}` : "";
const logLevel = Bun.env.LOG_LEVEL ?? "";
const base: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};
const noCache = { ...base, "Cache-Control": "no-cache" };
const immutable = { ...base, "Cache-Control": "public, max-age=31536000, immutable" };
const revalidate = new Set(["/index.html", "/index.js", "/app.css", "/service-worker.js", "/version.json", "/asset-manifest.json", "/manifest.json", "/theme-loader.js"]);

// Inject meta tags into index.html at runtime
let indexHtml: string | null = null;
if (backendUrl || logLevel) {
  indexHtml = await Bun.file("dist/index.html").text();
  if (backendUrl) {
    indexHtml = indexHtml.replace("</head>", `  <meta name="backend-url" content="${backendUrl}" />\n</head>`);
  }
  if (logLevel) {
    indexHtml = indexHtml.replace("</head>", `  <meta name="log-level" content="${logLevel}" />\n</head>`);
  }
}

Bun.serve({
  port: 5000,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`dist${path}`);
    if (await file.exists()) {
      // Serve patched index.html if cross-origin backend is configured
      if (path === "/index.html" && indexHtml) {
        return new Response(indexHtml, { headers: { ...noCache, "Content-Type": "text/html; charset=utf-8" } });
      }
      const headers = revalidate.has(path) ? noCache : immutable;
      return new Response(file, { headers });
    }
    // SPA fallback
    if (indexHtml) {
      return new Response(indexHtml, { headers: { ...noCache, "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response(Bun.file("dist/index.html"), { headers: noCache });
  },
});
EOF
EXPOSE 5000
CMD ["bun", "run", "serve.ts"]
