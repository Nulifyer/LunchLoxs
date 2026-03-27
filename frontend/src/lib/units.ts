/**
 * Unit conversion for recipe ingredients.
 *
 * Converts between metric and imperial units within the same dimension
 * (volume or weight). Does not attempt volume-to-weight conversion
 * (which would require per-ingredient density data).
 */

export type UnitSystem = "metric" | "imperial" | "original";
export type Dimension = "volume" | "weight";

interface UnitDef {
  canonical: string;
  dimension: Dimension;
  system: "metric" | "imperial";
  toBase: number; // mL for volume, g for weight
  sourceOnly?: boolean; // if true, can convert FROM but won't appear as a target
}

// Canonical units and their base-unit multipliers.
// Volume base = mL, weight base = g.
const UNIT_DEFS: UnitDef[] = [
  // Imperial volume
  { canonical: "pinch", dimension: "volume", system: "imperial", toBase: 0.308, sourceOnly: true }, // 1/16 tsp
  { canonical: "dash",  dimension: "volume", system: "imperial", toBase: 0.616, sourceOnly: true }, // 1/8 tsp
  { canonical: "tsp",   dimension: "volume", system: "imperial", toBase: 4.929 },
  { canonical: "tbsp",  dimension: "volume", system: "imperial", toBase: 14.787 },
  { canonical: "fl oz", dimension: "volume", system: "imperial", toBase: 29.574 },
  { canonical: "cup",   dimension: "volume", system: "imperial", toBase: 236.588 },
  { canonical: "pint",  dimension: "volume", system: "imperial", toBase: 473.176 },
  { canonical: "quart", dimension: "volume", system: "imperial", toBase: 946.353 },
  { canonical: "gallon",dimension: "volume", system: "imperial", toBase: 3785.41 },

  // Metric volume
  { canonical: "ml",    dimension: "volume", system: "metric",   toBase: 1 },
  { canonical: "dl",    dimension: "volume", system: "metric",   toBase: 100 },
  { canonical: "l",     dimension: "volume", system: "metric",   toBase: 1000 },

  { canonical: "stick", dimension: "volume", system: "imperial", toBase: 118.294, sourceOnly: true }, // 1 stick butter = 1/2 cup = 8 tbsp

  // Imperial weight
  { canonical: "oz",    dimension: "weight", system: "imperial", toBase: 28.3495 },
  { canonical: "lb",    dimension: "weight", system: "imperial", toBase: 453.592 },

  // Metric weight
  { canonical: "g",     dimension: "weight", system: "metric",   toBase: 1 },
  { canonical: "kg",    dimension: "weight", system: "metric",   toBase: 1000 },
];

// Map aliases (lowercase) to canonical name.
const ALIASES: Record<string, string> = {
  // pinch
  pinch: "pinch",
  // dash
  dash: "dash", dashes: "dash",
  // tsp
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp", tsps: "tsp",
  // tbsp
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", tbsps: "tbsp", tbs: "tbsp",
  // fl oz
  "fl oz": "fl oz", "fluid ounce": "fl oz", "fluid ounces": "fl oz",
  // cup
  cup: "cup", cups: "cup", c: "cup",
  // pint
  pint: "pint", pints: "pint", pt: "pint",
  // quart
  quart: "quart", quarts: "quart", qt: "quart", qts: "quart",
  // gallon
  gallon: "gallon", gallons: "gallon", gal: "gallon",
  // ml
  ml: "ml", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  // dl
  dl: "dl", deciliter: "dl", deciliters: "dl", decilitre: "dl", decilitres: "dl",
  // l
  l: "l", liter: "l", liters: "l", litre: "l", litres: "l",
  // oz
  oz: "oz", ounce: "oz", ounces: "oz",
  // lb
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  // stick (butter)
  stick: "stick", sticks: "stick",
  // g
  g: "g", gram: "g", grams: "g",
  // kg
  kg: "kg", kilogram: "kg", kilograms: "kg",
};

const defByCanonical = new Map<string, UnitDef>();
for (const d of UNIT_DEFS) defByCanonical.set(d.canonical, d);

/** Units that should display as decimals rather than fractions. */
const DECIMAL_UNITS = new Set(["ml", "dl", "l", "g", "kg"]);

/** Whether a unit should be formatted as decimal (e.g. 0.5 not 1/2). */
export function isDecimalUnit(unit: string): boolean {
  // Density-based units are prefixed with ~
  const canonical = unit.startsWith("~") ? unit.slice(1) : unit;
  return DECIMAL_UNITS.has(canonical);
}

/** Resolve a user-typed unit string to its canonical UnitDef, or null. */
export function resolveUnit(raw: string): UnitDef | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  const canonical = ALIASES[key];
  if (!canonical) return null;
  return defByCanonical.get(canonical) ?? null;
}

/** Preferred target units per dimension when converting to a system. */
const PREFERRED: Record<Dimension, Record<"metric" | "imperial", { unit: string; toBase: number }[]>> = {
  volume: {
    metric: [
      { unit: "ml", toBase: 1 },
      { unit: "l",  toBase: 1000 },
    ],
    imperial: [
      { unit: "tsp",  toBase: 4.929 },
      { unit: "tbsp", toBase: 14.787 },
      { unit: "cup",  toBase: 236.588 },
      { unit: "pint", toBase: 473.176 },
      { unit: "quart",toBase: 946.353 },
    ],
  },
  weight: {
    metric: [
      { unit: "g",  toBase: 1 },
      { unit: "kg", toBase: 1000 },
    ],
    imperial: [
      { unit: "oz", toBase: 28.3495 },
      { unit: "lb", toBase: 453.592 },
    ],
  },
};

export interface ConvertedUnit {
  qty: number;
  unit: string;
}

/**
 * Return all units a given source unit can convert to (same dimension, other system + own system).
 * Includes "original" as a reset option. Each entry has: canonical unit name and system label.
 */
export function getConversionTargets(fromUnit: string): { unit: string; label: string; system: "metric" | "imperial" }[] {
  const def = resolveUnit(fromUnit);
  if (!def) return [];
  const targets: { unit: string; label: string; system: "metric" | "imperial" }[] = [];
  for (const d of UNIT_DEFS) {
    if (d.dimension === def.dimension && d.canonical !== def.canonical && !d.sourceOnly) {
      targets.push({ unit: d.canonical, label: d.canonical, system: d.system });
    }
  }
  return targets;
}

/**
 * Convert a quantity from one unit to the best unit in the target system.
 * Returns null if the unit is unrecognized or already in the target system.
 */
export function convertUnit(qty: number, fromUnit: string, toSystem: "metric" | "imperial"): ConvertedUnit | null {
  const def = resolveUnit(fromUnit);
  if (!def) return null;
  if (def.system === toSystem) return null;
  if (def.sourceOnly) return null; // e.g. "stick" -- only convert via explicit picker

  const baseValue = qty * def.toBase;
  return pickBestUnit(baseValue, def.dimension, toSystem);
}

/**
 * Given a value in base units (mL or g), pick the target-system unit
 * that produces the most human-friendly number.
 */
function pickBestUnit(baseValue: number, dimension: Dimension, system: "metric" | "imperial"): ConvertedUnit {
  const candidates = PREFERRED[dimension][system];
  let best = candidates[0]!;
  let bestVal = baseValue / best.toBase;

  for (const c of candidates) {
    const val = baseValue / c.toBase;
    // Prefer a unit where the value is >= 1 but as small as possible,
    // to avoid both "0.02 l" and "4732 ml".
    if (val >= 0.75 && (bestVal < 0.75 || val < bestVal)) {
      best = c;
      bestVal = val;
    }
  }

  // If nothing produced >= 0.75, use the smallest unit
  if (bestVal < 0.75) {
    best = candidates[0]!;
    bestVal = baseValue / best.toBase;
  }

  return { qty: cleanNumber(bestVal), unit: best.unit };
}

/** Round to avoid floating-point noise, keep up to 2 decimals. */
function cleanNumber(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Convert a quantity from one unit to a specific target unit.
 * Both must be in the same dimension. Returns null if incompatible.
 */
export function convertToUnit(qty: number, fromUnit: string, toUnit: string): ConvertedUnit | null {
  const fromDef = resolveUnit(fromUnit);
  const toDef = resolveUnit(toUnit);
  if (!fromDef || !toDef) return null;
  if (fromDef.dimension !== toDef.dimension) return null;
  const baseValue = qty * fromDef.toBase;
  return { qty: cleanNumber(baseValue / toDef.toBase), unit: toDef.canonical };
}

/**
 * Convert an ingredient's quantity+unit to the target system.
 * Returns the original values unchanged if conversion isn't possible.
 */
export function convertIngredient(
  qty: number,
  unit: string,
  toSystem: UnitSystem,
): ConvertedUnit {
  if (toSystem === "original") return { qty, unit };
  const result = convertUnit(qty, unit, toSystem);
  if (!result) return { qty, unit };
  return result;
}
