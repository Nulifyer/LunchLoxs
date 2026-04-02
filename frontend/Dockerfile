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
const base: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};
const noCache = { ...base, "Cache-Control": "no-cache" };
const immutable = { ...base, "Cache-Control": "public, max-age=31536000, immutable" };
const revalidate = new Set(["/index.html", "/index.js", "/app.css", "/service-worker.js", "/version.json", "/asset-manifest.json", "/manifest.json", "/theme-loader.js"]);

// If BACKEND_URL is set (cross-origin mode), inject meta tag into index.html
let indexHtml: string | null = null;
if (backendUrl) {
  indexHtml = await Bun.file("dist/index.html").text();
  const metaTag = `<meta name="backend-url" content="${backendUrl}" />`;
  indexHtml = indexHtml.replace("</head>", `  ${metaTag}\n</head>`);
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
