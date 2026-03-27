import { readdirSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const src = join(import.meta.dir, "..", "public");
const dest = join(import.meta.dir, "..", "dist");

mkdirSync(dest, { recursive: true });
for (const file of readdirSync(src)) {
  copyFileSync(join(src, file), join(dest, file));
}
console.log("Copied public/ -> dist/");

// Generate version.json first (hash of all dist files excluding itself and asset-manifest)
const preFiles = readdirSync(dest).sort();
const hash = createHash("sha256");
for (const file of preFiles) {
  if (file === "version.json" || file === "asset-manifest.json") continue;
  hash.update(readFileSync(join(dest, file)));
}
const version = hash.digest("hex").slice(0, 12);
writeFileSync(join(dest, "version.json"), JSON.stringify({ version, built: new Date().toISOString() }));
console.log(`Generated version.json: ${version}`);

// Collect all assets in dist/ for the service worker manifest (including version.json)
const allFiles = readdirSync(dest).sort();
const staticAssets = allFiles
  .filter((f) => f !== "asset-manifest.json")
  .map((f) => `/${f}`);
// Always include root
if (!staticAssets.includes("/")) staticAssets.unshift("/");

writeFileSync(join(dest, "asset-manifest.json"), JSON.stringify({ assets: staticAssets }));
console.log(`Generated asset-manifest.json: ${staticAssets.length} assets`);
