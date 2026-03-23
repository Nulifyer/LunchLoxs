import { readdirSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";

const src = join(import.meta.dir, "..", "public");
const dest = join(import.meta.dir, "..", "dist");

mkdirSync(dest, { recursive: true });
for (const file of readdirSync(src)) {
  copyFileSync(join(src, file), join(dest, file));
}
console.log("Copied public/ → dist/");
