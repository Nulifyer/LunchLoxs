/**
 * Generate a tiny inline theme loader script from the theme definitions.
 * This runs at build time and outputs dist/theme-loader.js.
 * The script is loaded in <head> before paint to prevent theme flash.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { themes } from "../src/lib/themes";

// Build a compact map: { themeId: { bg, bgSurface, ... } }
const compact: Record<string, Record<string, string>> = {};
for (const [id, theme] of Object.entries(themes)) {
  compact[id] = {
    bg: theme.bg, bs: theme.bgSurface, bh: theme.bgHover, bi: theme.bgInput,
    bo: theme.border, mu: theme.muted, tx: theme.text, su: theme.subtle,
    ac: theme.accent, gr: theme.green, ye: theme.yellow, re: theme.red,
    pu: theme.purple, cy: theme.cyan,
  };
}

const varMap = [
  ["bg", "--bg"], ["bs", "--bg-surface"], ["bh", "--bg-hover"], ["bi", "--bg-input"],
  ["bo", "--border"], ["mu", "--muted"], ["tx", "--text"], ["su", "--subtle"],
  ["ac", "--accent"], ["gr", "--green"], ["ye", "--yellow"], ["re", "--red"],
  ["pu", "--purple"], ["cy", "--cyan"],
];

const script = `(function(){var T=${JSON.stringify(compact)};var id=localStorage.getItem("recipe_theme");if(!id||!T[id])return;var t=T[id],r=document.documentElement.style;${varMap.map(([k, v]) => `r.setProperty("${v}",t.${k})`).join(";")};})();`;

const dest = join(import.meta.dir, "..", "dist");
writeFileSync(join(dest, "theme-loader.js"), script);
console.log(`Generated theme-loader.js (${script.length} bytes)`);
