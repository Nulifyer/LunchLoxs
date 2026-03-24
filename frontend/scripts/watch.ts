/**
 * Watch script: rebuilds frontend on source file changes.
 * Run with: bun run scripts/watch.ts
 */
import { watch } from "fs";
import { join } from "path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const watchDirs = ["src", "public"];

async function build() {
  const start = Date.now();
  try {
    await $`bun run build`.cwd(root).quiet();
    console.log(`[${new Date().toLocaleTimeString()}] rebuilt in ${Date.now() - start}ms`);
  } catch (e: any) {
    console.error(`[${new Date().toLocaleTimeString()}] build failed:`, e.message ?? e);
  }
}

// Initial build
await build();

// Debounce
let timer: ReturnType<typeof setTimeout> | null = null;
function rebuild() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; build(); }, 100);
}

// Watch source directories
for (const dir of watchDirs) {
  const fullPath = join(root, dir);
  watch(fullPath, { recursive: true }, (_event, filename) => {
    if (filename && !filename.includes("node_modules")) {
      rebuild();
    }
  });
  console.log(`watching ${dir}/`);
}

console.log("waiting for changes...");

// Keep process alive
await new Promise(() => {});
