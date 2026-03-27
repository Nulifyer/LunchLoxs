/**
 * Quantity parsing, formatting, and scaling for ingredient amounts.
 *
 * Handles integers, decimals, fractions, mixed numbers, ranges,
 * comma decimals, approximate prefixes, word ranges, and locked amounts.
 *
 * Prefix a quantity with * to lock it from scaling (e.g. "*2").
 */

/** Normalize unicode dashes/spaces/fractions and comma decimals to ASCII. */
function normalize(s: string): string {
  return s
    .replace(/[\u2013\u2014\u2012\u2015]/g, "-")  // en-dash, em-dash, figure-dash, horizontal bar
    .replace(/[\u00a0\u2009\u202f]/g, " ")          // non-breaking space, thin space
    .replace(/(\d)?([\u00bc\u00bd\u00be\u2153\u2154\u215b-\u215e])/g, (_, pre, ch) => {
      const map: Record<string, string> = {
        "\u00bc": "1/4", "\u00bd": "1/2", "\u00be": "3/4",
        "\u2153": "1/3", "\u2154": "2/3",
        "\u215b": "1/8", "\u215c": "3/8", "\u215d": "5/8", "\u215e": "7/8",
      };
      return (pre ? pre + " " : "") + map[ch]!;
    })
    .replace(/(\d),(\d)/g, "$1.$2");                 // comma decimal -> dot decimal
}

export function parseQty(s: string): number | null {
  s = normalize(s).trim();
  if (!s) return null;
  // Strip approximate prefix
  s = s.replace(/^~\s*/, "");
  // Mixed fraction: "1 1/2"
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return parseInt(mixed[1]!) + parseInt(mixed[2]!) / parseInt(mixed[3]!);
  // Simple fraction: "1/2"
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseInt(frac[1]!) / parseInt(frac[2]!);
  // Decimal or integer
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

const FRACTIONS: [number, string][] = [
  [0.125, "1/8"], [0.25, "1/4"], [0.333, "1/3"], [0.375, "3/8"],
  [0.5, "1/2"], [0.625, "5/8"], [0.667, "2/3"], [0.75, "3/4"], [0.875, "7/8"],
];

export function formatQty(value: number, decimal?: boolean): string {
  if (value <= 0) return "";
  if (decimal) {
    if (value % 1 === 0) return String(value);
    return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  const whole = Math.floor(value);
  const rem = value - whole;
  if (rem < 0.05) return String(whole || "");
  // Try to match a nice fraction
  for (const [dec, str] of FRACTIONS) {
    if (Math.abs(rem - dec) < 0.04) {
      return whole > 0 ? `${whole} ${str}` : str;
    }
  }
  // Fall back to 2 decimal places
  return value % 1 === 0 ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function scaleQty(raw: string, scaleFactor: number): string {
  if (scaleFactor === 1) return raw;

  const trimmed = raw.trim();

  // Locked: "*2" -- strip the prefix for display but don't scale
  if (trimmed.startsWith("*")) {
    return trimmed.slice(1);
  }

  const normalized = normalize(trimmed);

  // Approximate prefix: "~2" -- scale the number, keep the prefix
  const approxMatch = normalized.match(/^(~\s*)([\s\S]+)$/);
  if (approxMatch) {
    const inner = scaleQty(approxMatch[2]!, scaleFactor);
    return "~" + inner;
  }

  // Word range: "2 to 3", "2 or 3" -- scale floor, preserve diff
  const wordRange = normalized.match(/^(.+?)\s+(to|or)\s+(.+)$/i);
  if (wordRange) {
    const a = parseQty(wordRange[1]!);
    const b = parseQty(wordRange[3]!);
    if (a !== null && b !== null) {
      const diff = b - a;
      const scaledBase = a * scaleFactor;
      return `${formatQty(scaledBase)} ${wordRange[2]} ${formatQty(scaledBase + diff)}`;
    }
  }

  // Hyphen range: "1-3"
  const rangeParts = normalized.split(/\s*-\s*/);
  if (rangeParts.length === 2) {
    const a = parseQty(rangeParts[0]!);
    const b = parseQty(rangeParts[1]!);
    if (a !== null && b !== null) {
      const diff = b - a;
      const scaledBase = a * scaleFactor;
      return `${formatQty(scaledBase)}-${formatQty(scaledBase + diff)}`;
    }
  }

  // Single value
  const n = parseQty(raw);
  if (n === null) return raw;
  return formatQty(n * scaleFactor);
}
