/**
 * Minimal Bun dev server with live reload.
 * Serves built assets and proxies API calls to the Go backend.
 */
const coopCoep = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
const server = Bun.serve({
  port: 5173,
  async fetch(req) {
    const url = new URL(req.url);

    // Proxy ConnectRPC requests to Go backend
    if (url.pathname.startsWith("/todo.v1.")) {
      const backendUrl = `http://localhost:8080${url.pathname}${url.search}`;
      return fetch(backendUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    }

    // Serve static files from public/, dist/, or node_modules (for wasm)
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;

    // Try public/ first, then dist/, then node_modules sqlite wasm
    let file = Bun.file(`public${filePath}`);
    if (!(await file.exists())) {
      file = Bun.file(`dist${filePath}`);
    }
    if (!(await file.exists()) && filePath.endsWith(".wasm")) {
      file = Bun.file(`node_modules/@sqlite.org/sqlite-wasm/dist${filePath}`);
    }
    if (!(await file.exists())) {
      file = Bun.file("public/index.html");
    }

    return new Response(file, { headers: coopCoep });
  },
});

console.log(`Dev server running at http://localhost:${server.port}`);
