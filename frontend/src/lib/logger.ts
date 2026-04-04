/**
 * Debug logger with ring buffer and export capability.
 * Wraps console.log/warn/error and stores entries for export.
 */

interface LogEntry {
  ts: number;
  level: "log" | "warn" | "error";
  msg: string;
}

const MAX_ENTRIES = 2000;
const entries: LogEntry[] = [];

function push(level: LogEntry["level"], args: any[]) {
  const msg = args.map((a) => {
    if (a instanceof Error) return a.message || String(a);
    if (typeof a === "object") return JSON.stringify(a, null, 0);
    return String(a);
  }).join(" ");
  entries.push({ ts: Date.now(), level, msg });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

const isDev = typeof location !== "undefined" &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1");

// LOG_LEVEL: "debug" shows all, "info" (default) shows log+warn+error, "warn" shows warn+error, "error" shows only errors
// Set via <meta name="log-level" content="debug"> or defaults based on isDev
const metaLevel = typeof document !== "undefined"
  ? document.querySelector<HTMLMetaElement>('meta[name="log-level"]')?.content
  : undefined;
const logLevel = metaLevel || (isDev ? "debug" : "info");
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const level = LEVELS[logLevel as keyof typeof LEVELS] ?? LEVELS.info;

export const debug = (...args: any[]) => { push("log", args); if (level <= LEVELS.debug) origLog(...args); };
export const log = (...args: any[]) => { push("log", args); if (level <= LEVELS.info) origLog(...args); };
export const warn = (...args: any[]) => { push("warn", args); if (level <= LEVELS.warn) origWarn(...args); };
export const error = (...args: any[]) => { push("error", args); origError(...args); };

/**
 * Export all log entries as a downloadable text file.
 */
export function exportLogs(): void {
  const lines = entries.map((e) => {
    const d = new Date(e.ts);
    const time = d.toISOString();
    return `[${time}] [${e.level.toUpperCase()}] ${e.msg}`;
  });
  const text = lines.join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `recipe-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Copy all log entries to clipboard.
 */
export async function copyLogs(): Promise<boolean> {
  const lines = entries.map((e) => {
    const d = new Date(e.ts);
    const time = d.toISOString();
    return `[${time}] [${e.level.toUpperCase()}] ${e.msg}`;
  });
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    return true;
  } catch {
    return false;
  }
}

export function getEntryCount(): number {
  return entries.length;
}
