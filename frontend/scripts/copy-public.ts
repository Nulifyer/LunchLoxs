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

// Generate version.json with a hash of all dist files
const hash = createHash("sha256");
for (const file of readdirSync(dest).sort()) {
  if (file === "version.json") continue;
  hash.update(file);
  hash.update(readFileSync(join(dest, file)));
}
const version = hash.digest("hex").slice(0, 12);
writeFileSync(join(dest, "version.json"), JSON.stringify({ version, built: new Date().toISOString() }));
console.log(`Generated version.json: ${version}`);
