/**
 * Theme definitions and management.
 * Each theme maps semantic names to CSS custom property values.
 * Persisted to localStorage, applied to :root.
 */

export interface Theme {
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

export const themes: Record<string, Theme> = {
  "auto-dark": {
    label: "Dark",
    bg: "#0d1117", bgSurface: "#161b22", bgHover: "#1c2128", bgInput: "#0d1117",
    border: "#30363d", muted: "#484f58", text: "#e6edf3", subtle: "#8b949e",
    accent: "#58a6ff", green: "#3fb950", yellow: "#d29922", red: "#f85149", purple: "#bc8cff", cyan: "#56d7c2",
  },
  "auto-light": {
    label: "Light",
    bg: "#ffffff", bgSurface: "#f6f8fa", bgHover: "#eaeef2", bgInput: "#ffffff",
    border: "#d0d7de", muted: "#8c959f", text: "#1f2328", subtle: "#656d76",
    accent: "#0969da", green: "#1a7f37", yellow: "#9a6700", red: "#cf222e", purple: "#8250df", cyan: "#0d7680",
  },
  "dracula": {
    label: "Dracula",
    bg: "#282a36", bgSurface: "#343746", bgHover: "#3e4254", bgInput: "#282a36",
    border: "#44475a", muted: "#6272a4", text: "#f8f8f2", subtle: "#6272a4",
    accent: "#8be9fd", green: "#50fa7b", yellow: "#f1fa8c", red: "#ff5555", purple: "#bd93f9", cyan: "#8be9fd",
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    bg: "#1e1e2e", bgSurface: "#313244", bgHover: "#3b3c52", bgInput: "#1e1e2e",
    border: "#45475a", muted: "#585b70", text: "#cdd6f4", subtle: "#a6adc8",
    accent: "#89b4fa", green: "#a6e3a1", yellow: "#f9e2af", red: "#f38ba8", purple: "#cba6f7", cyan: "#94e2d5",
  },
  "catppuccin-macchiato": {
    label: "Catppuccin Macchiato",
    bg: "#24273a", bgSurface: "#363a4f", bgHover: "#414560", bgInput: "#24273a",
    border: "#5b6078", muted: "#6e738d", text: "#cad3f5", subtle: "#a5adcb",
    accent: "#8aadf4", green: "#a6da95", yellow: "#eed49f", red: "#ed8796", purple: "#c6a0f6", cyan: "#8bd5ca",
  },
  "catppuccin-frappe": {
    label: "Catppuccin Frappe",
    bg: "#303446", bgSurface: "#414559", bgHover: "#4b5068", bgInput: "#303446",
    border: "#626880", muted: "#737994", text: "#c6d0f5", subtle: "#a5adce",
    accent: "#8caaee", green: "#a6d189", yellow: "#e5c890", red: "#e78284", purple: "#ca9ee6", cyan: "#81c8be",
  },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    bg: "#eff1f5", bgSurface: "#e6e9ef", bgHover: "#dce0e8", bgInput: "#eff1f5",
    border: "#ccd0da", muted: "#9ca0b0", text: "#4c4f69", subtle: "#6c6f85",
    accent: "#1e66f5", green: "#40a02b", yellow: "#df8e1d", red: "#d20f39", purple: "#8839ef", cyan: "#179299",
  },
  "nord": {
    label: "Nord",
    bg: "#2e3440", bgSurface: "#3b4252", bgHover: "#434c5e", bgInput: "#2e3440",
    border: "#4c566a", muted: "#4c566a", text: "#eceff4", subtle: "#d8dee9",
    accent: "#88c0d0", green: "#a3be8c", yellow: "#ebcb8b", red: "#bf616a", purple: "#b48ead", cyan: "#8fbcbb",
  },
  "tokyo-night": {
    label: "Tokyo Night",
    bg: "#1a1b26", bgSurface: "#24283b", bgHover: "#292e42", bgInput: "#1a1b26",
    border: "#3b4261", muted: "#565f89", text: "#c0caf5", subtle: "#a9b1d6",
    accent: "#7aa2f7", green: "#9ece6a", yellow: "#e0af68", red: "#f7768e", purple: "#bb9af7", cyan: "#7dcfff",
  },
  "everforest": {
    label: "Everforest",
    bg: "#2d353b", bgSurface: "#343f44", bgHover: "#3d484d", bgInput: "#2d353b",
    border: "#475258", muted: "#7a8478", text: "#d3c6aa", subtle: "#9da9a0",
    accent: "#7fbbb3", green: "#a7c080", yellow: "#dbbc7f", red: "#e67e80", purple: "#d699b6", cyan: "#83c092",
  },
  "gruvbox": {
    label: "Gruvbox",
    bg: "#282828", bgSurface: "#3c3836", bgHover: "#504945", bgInput: "#282828",
    border: "#665c54", muted: "#a89984", text: "#ebdbb2", subtle: "#bdae93",
    accent: "#83a598", green: "#b8bb26", yellow: "#fabd2f", red: "#fb4934", purple: "#d3869b", cyan: "#8ec07c",
  },
};

const STORAGE_KEY = "recipe_theme";

export function getStoredTheme(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "auto-dark";
}

export function setStoredTheme(id: string): void {
  localStorage.setItem(STORAGE_KEY, id);
}

export function applyTheme(id: string): void {
  const theme = themes[id];
  if (!theme) return;
  const root = document.documentElement;
  root.style.setProperty("--bg", theme.bg);
  root.style.setProperty("--bg-surface", theme.bgSurface);
  root.style.setProperty("--bg-hover", theme.bgHover);
  root.style.setProperty("--bg-input", theme.bgInput);
  root.style.setProperty("--border", theme.border);
  root.style.setProperty("--muted", theme.muted);
  root.style.setProperty("--text", theme.text);
  root.style.setProperty("--subtle", theme.subtle);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--green", theme.green);
  root.style.setProperty("--yellow", theme.yellow);
  root.style.setProperty("--red", theme.red);
  root.style.setProperty("--purple", theme.purple);
  root.style.setProperty("--cyan", theme.cyan);
  setStoredTheme(id);
}

export function initTheme(): void {
  applyTheme(getStoredTheme());
}
