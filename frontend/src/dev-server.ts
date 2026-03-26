/**
 * Minimal Bun dev server.
 * Serves static files. WebSocket connects directly to backend on :8000.
 */
const headers: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cache-Control": "no-cache",
};
const server = Bun.serve({
  port: 5000,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;

    let file = Bun.file(`public${filePath}`);
    if (!(await file.exists())) {
      file = Bun.file(`dist${filePath}`);
    }
    if (!(await file.exists())) {
      file = Bun.file("public/index.html");
    }

    return new Response(file, { headers });
  },
});

console.log(`Dev server running at http://localhost:${server.port}`);
