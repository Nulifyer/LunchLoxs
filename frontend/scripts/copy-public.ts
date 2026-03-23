import { readdirSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";

const src = join(import.meta.dir, "..", "public");
const dest = join(import.meta.dir, "..", "dist");

mkdirSync(dest, { recursive: true });
for (const file of readdirSync(src)) {
  copyFileSync(join(src, file), join(dest, file));
}
console.log("Copied public/ → dist/");

// Copy SQLite WASM binary — needed at runtime by @sqlite.org/sqlite-wasm
const wasmSrc = join(import.meta.dir, "..", "node_modules", "@sqlite.org", "sqlite-wasm", "dist", "sqlite3.wasm");
copyFileSync(wasmSrc, join(dest, "sqlite3.wasm"));
console.log("Copied sqlite3.wasm → dist/");
