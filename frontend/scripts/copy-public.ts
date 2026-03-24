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

// Collect all assets in dist/ for the service worker manifest
const allFiles = readdirSync(dest).sort();
const staticAssets = allFiles
  .filter((f) => f !== "version.json" && f !== "asset-manifest.json")
  .map((f) => `/${f}`);
// Always include root
if (!staticAssets.includes("/")) staticAssets.unshift("/");

writeFileSync(join(dest, "asset-manifest.json"), JSON.stringify({ assets: staticAssets }));
console.log(`Generated asset-manifest.json: ${staticAssets.length} assets`);

// Generate version.json with a content hash of all dist files
const hash = createHash("sha256");
for (const file of allFiles) {
  if (file === "version.json") continue;
  hash.update(readFileSync(join(dest, file)));
}
const version = hash.digest("hex").slice(0, 12);
writeFileSync(join(dest, "version.json"), JSON.stringify({ version, built: new Date().toISOString() }));
console.log(`Generated version.json: ${version}`);
