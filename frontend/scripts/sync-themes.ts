/**
 * Sync theme colors from the shared colors.json palette into themes.ts.
 *
 * Usage: bun run scripts/sync-themes.ts [path-to-colors.json]
 *
 * Mapping from colors.json terminal palette → Theme interface:
 *   bg        ← terminal.bg
 *   bgSurface ← terminal.selection (or slightly lighter bg)
 *   bgHover   ← brighten bgSurface by ~8%
 *   bgInput   ← terminal.bg
 *   border    ← terminal.normal.black (bright variant)
 *   muted     ← terminal.bright.black
 *   text      ← terminal.fg
 *   subtle    ← midpoint between muted and text
 *   accent    ← terminal.normal[vscode.accent]
 *   green     ← terminal.normal.green
 *   yellow    ← terminal.normal.yellow
 *   red       ← terminal.normal.red
 *   purple    ← terminal.normal.magenta
 *   cyan      ← terminal.normal.cyan
 */

const colorsPath = Bun.argv[2] ?? "C:\\Users\\Kyle\\Documents\\PowerShell\\Scripts\\_lib\\themes\\colors.json";
const colors: Record<string, any> = await Bun.file(colorsPath).json();

interface Theme {
  label: string;
  bg: string;
  bgSurface: string;
  bgHover: string;
  bgInput: string;
  border: string;
  muted: string;
  text: string;
  subtle: string;
  accent: string;
  green: string;
  yellow: string;
  red: string;
  purple: string;
  cyan: string;
}

function hex(c: string): string {
  return c.startsWith("#") ? c.toLowerCase() : `#${c.toLowerCase()}`;
}

function parseHex(c: string): [number, number, number] {
  const h = c.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

function lighten(color: string, amount: number): string {
  const [r, g, b] = parseHex(color);
  return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

function midpoint(a: string, b: string): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex((ar + br) / 2, (ag + bg) / 2, (ab + bb) / 2);
}

function adjustBrightness(color: string, amount: number): string {
  const [r, g, b] = parseHex(color);
  return toHex(r + amount, g + amount, b + amount);
}

function mapTheme(key: string, src: any): Theme | null {
  const t = src.terminal;
  if (!t?.bg || !t?.fg || !t?.normal) return null;

  const isLight = src.variant === "light";

  // Match the PowerShell profile's VSCode theme derivation:
  //   bgSurface = bg adjusted +8 (dark) / -5 (light)
  //   bgBorder  = bg adjusted +12 (dark) / -8 (light)
  //   bgHover   = midpoint(bgSurface, bgBorder)
  //   fgDim     = normal.white (readable UI text, sidebar, etc.)
  //   fgMuted   = bright.black (comments, line numbers)
  //   accent    = normal[vscode.accent]
  const bg        = hex(t.bg);
  const text      = hex(t.fg);
  const bgSurface = adjustBrightness(bg, isLight ? -5 : 8);
  const border    = mix(hex(t.normal.black), hex(t.bright?.black ?? t.normal.black), 0.4);
  const bgHover   = adjustBrightness(bg, isLight ? -12 : 18);
  const muted     = hex(t.bright?.black ?? t.normal.black);
  const subtle    = hex(t.normal.white);

  const accentKey = src.vscode?.accent ?? "blue";
  const accent = hex(t.normal[accentKey] ?? t.normal.blue);

  return {
    label: src.name,
    bg,
    bgSurface,
    bgHover,
    bgInput: bg,
    border,
    muted,
    text,
    subtle,
    accent,
    green: hex(t.normal.green),
    yellow: hex(t.normal.yellow),
    red: hex(t.normal.red),
    purple: hex(t.normal.magenta),
    cyan: hex(t.normal.cyan),
  };
}

// Map colors.json keys to theme IDs used in the app
const keyMap: Record<string, string> = {
  dracula: "dracula",
  catppuccin_mocha: "catppuccin-mocha",
  catppuccin_macchiato: "catppuccin-macchiato",
  catppuccin_frappe: "catppuccin-frappe",
  catppuccin_latte: "catppuccin-latte",
  nord: "nord",
  tokyonight: "tokyo-night",
  everforest: "everforest",
  gruvbox: "gruvbox",
  // New themes from colors.json
  ayu_dark: "ayu-dark",
  ayu_mirage: "ayu-mirage",
  carbonfox: "carbonfox",
  rose_pine: "rose-pine",
  rose_pine_dawn: "rose-pine-dawn",
  kanagawa: "kanagawa",
  onedark: "onedark",
  github_dark: "github-dark",
  gruvbox_light: "gruvbox-light",
  everforest_light: "everforest-light",
  tokyonight_light: "tokyo-night-light",
  palenight: "palenight",
  moonfly: "moonfly",
  nightfox: "nightfox",
  solarized: "solarized",
  flexoki: "flexoki",
  flexoki_light: "flexoki-light",
  oxocarbon: "oxocarbon",
  horizon: "horizon",
  vesper: "vesper",
  poimandres: "poimandres",
};

const output: Record<string, Theme> = {};

// Keep auto-dark and auto-light as-is (not from colors.json)
const existingThemes = await import("../src/lib/themes");
output["auto-dark"] = existingThemes.themes["auto-dark"]!;
output["auto-light"] = existingThemes.themes["auto-light"]!;

for (const [jsonKey, themeId] of Object.entries(keyMap)) {
  const src = colors[jsonKey];
  if (!src) { console.warn(`  skip: ${jsonKey} not found in colors.json`); continue; }
  const theme = mapTheme(jsonKey, src);
  if (!theme) { console.warn(`  skip: ${jsonKey} missing terminal colors`); continue; }
  output[themeId] = theme;
}

// Generate themes.ts
const lines: string[] = [];
lines.push(`/**`);
lines.push(` * Theme definitions and management.`);
lines.push(` * Each theme maps semantic names to CSS custom property values.`);
lines.push(` * Persisted to localStorage, applied to :root.`);
lines.push(` *`);
lines.push(` * Auto-generated by scripts/sync-themes.ts — edit that script, not this file.`);
lines.push(` */`);
lines.push(``);
lines.push(`export interface Theme {`);
lines.push(`  label: string;`);
lines.push(`  bg: string;`);
lines.push(`  bgSurface: string;`);
lines.push(`  bgHover: string;`);
lines.push(`  bgInput: string;`);
lines.push(`  border: string;`);
lines.push(`  muted: string;`);
lines.push(`  text: string;`);
lines.push(`  subtle: string;`);
lines.push(`  accent: string;`);
lines.push(`  green: string;`);
lines.push(`  yellow: string;`);
lines.push(`  red: string;`);
lines.push(`  purple: string;`);
lines.push(`  cyan: string;`);
lines.push(`}`);
lines.push(``);
lines.push(`export const themes: Record<string, Theme> = {`);

for (const [id, theme] of Object.entries(output)) {
  const vals = [
    `label: "${theme.label}"`,
    `bg: "${theme.bg}"`, `bgSurface: "${theme.bgSurface}"`, `bgHover: "${theme.bgHover}"`, `bgInput: "${theme.bgInput}"`,
    `border: "${theme.border}"`, `muted: "${theme.muted}"`, `text: "${theme.text}"`, `subtle: "${theme.subtle}"`,
    `accent: "${theme.accent}"`, `green: "${theme.green}"`, `yellow: "${theme.yellow}"`, `red: "${theme.red}"`, `purple: "${theme.purple}"`, `cyan: "${theme.cyan}"`,
  ].join(", ");
  lines.push(`  "${id}": {`);
  lines.push(`    ${vals},`);
  lines.push(`  },`);
}

lines.push(`};`);
lines.push(``);

// Append the runtime functions unchanged
lines.push(`const STORAGE_KEY = "recipe_theme";`);
lines.push(``);
lines.push(`export function getStoredTheme(): string {`);
lines.push(`  return localStorage.getItem(STORAGE_KEY) ?? "auto-dark";`);
lines.push(`}`);
lines.push(``);
lines.push(`export function setStoredTheme(id: string): void {`);
lines.push(`  localStorage.setItem(STORAGE_KEY, id);`);
lines.push(`}`);
lines.push(``);
lines.push(`export function applyTheme(id: string): void {`);
lines.push(`  const theme = themes[id];`);
lines.push(`  if (!theme) return;`);
lines.push(`  const root = document.documentElement;`);
lines.push(`  root.style.setProperty("--bg", theme.bg);`);
lines.push(`  root.style.setProperty("--bg-surface", theme.bgSurface);`);
lines.push(`  root.style.setProperty("--bg-hover", theme.bgHover);`);
lines.push(`  root.style.setProperty("--bg-input", theme.bgInput);`);
lines.push(`  root.style.setProperty("--border", theme.border);`);
lines.push(`  root.style.setProperty("--muted", theme.muted);`);
lines.push(`  root.style.setProperty("--text", theme.text);`);
lines.push(`  root.style.setProperty("--subtle", theme.subtle);`);
lines.push(`  root.style.setProperty("--accent", theme.accent);`);
lines.push(`  root.style.setProperty("--green", theme.green);`);
lines.push(`  root.style.setProperty("--yellow", theme.yellow);`);
lines.push(`  root.style.setProperty("--red", theme.red);`);
lines.push(`  root.style.setProperty("--purple", theme.purple);`);
lines.push(`  root.style.setProperty("--cyan", theme.cyan);`);
lines.push(`  setStoredTheme(id);`);
lines.push(`}`);
lines.push(``);
lines.push(`export function initTheme(): void {`);
lines.push(`  applyTheme(getStoredTheme());`);
lines.push(`}`);
lines.push(``);

const outPath = import.meta.dir + "/../src/lib/themes.ts";
await Bun.write(outPath, lines.join("\n"));
console.log(`Wrote ${Object.keys(output).length} themes to src/lib/themes.ts`);
