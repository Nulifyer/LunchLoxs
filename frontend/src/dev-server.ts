/**
 * Minimal Bun dev server.
 * Injects backend-url meta tag from BACKEND_HOST/BACKEND_HTTPS env vars
 * (defaults to localhost:8000 for local development).
 */
const backendHost = Bun.env.BACKEND_HOST ?? "localhost:8000";
const backendHttps = Bun.env.BACKEND_HTTPS === "true";
const backendUrl = `${backendHttps ? "https" : "http"}://${backendHost}`;

const baseHeaders: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cache-Control": "no-cache",
};

let indexHtml = await Bun.file("public/index.html").text();
const metaTag = `<meta name="backend-url" content="${backendUrl}" />`;
indexHtml = indexHtml.replace("</head>", `  ${metaTag}\n</head>`);

const server = Bun.serve({
  port: 5000,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;

    if (filePath === "/index.html") {
      return new Response(indexHtml, { headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" } });
    }

    let file = Bun.file(`public${filePath}`);
    if (!(await file.exists())) {
      file = Bun.file(`dist${filePath}`);
    }
    if (!(await file.exists())) {
      return new Response(indexHtml, { headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response(file, { headers: baseHeaders });
  },
});

console.log(`Dev server running at http://localhost:${server.port} → backend at ${backendUrl}`);
