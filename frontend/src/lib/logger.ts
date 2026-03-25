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
  const msg = args.map((a) => typeof a === "object" ? JSON.stringify(a, null, 0) : String(a)).join(" ");
  entries.push({ ts: Date.now(), level, msg });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

const isDev = location.hostname === "localhost" || location.hostname === "127.0.0.1";

export const log = (...args: any[]) => { push("log", args); if (isDev) origLog(...args); };
export const warn = (...args: any[]) => { push("warn", args); if (isDev) origWarn(...args); };
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
