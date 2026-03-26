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
const base: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};
const noCache = { ...base, "Cache-Control": "no-cache" };
const immutable = { ...base, "Cache-Control": "public, max-age=31536000, immutable" };
const revalidate = new Set(["/index.html", "/index.js", "/app.css", "/service-worker.js", "/version.json", "/asset-manifest.json", "/manifest.json", "/theme-loader.js"]);
Bun.serve({
  port: 5000,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`dist${path}`);
    if (await file.exists()) {
      const headers = revalidate.has(path) ? noCache : immutable;
      return new Response(file, { headers });
    }
    return new Response(Bun.file("dist/index.html"), { headers: noCache });
  },
});
EOF
EXPOSE 5000
CMD ["bun", "run", "serve.ts"]
