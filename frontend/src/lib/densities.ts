/**
 * Ingredient density table for volume-to-weight conversion.
 *
 * Values are grams per US cup (236.588 mL) unless noted otherwise.
 * Powders/spices measured per tsp (4.929 mL) are stored as g/cup
 * by multiplying by 48 (48 tsp per cup) for consistency.
 *
 * Sources:
 *   King Arthur Baking -- Ingredient Weight Chart
 *   https://www.kingarthurbaking.com/learn/ingredient-weight-chart
 *
 *   Bob's Red Mill -- Flour Weight Chart
 *   https://www.bobsredmill.com/articles/bobs-red-mill-flour-weight-chart
 *
 *   Cafe Fernando -- Conversion Tables
 *   https://cafefernando.com/conversion-tables/
 *
 *   Cotswold Flour -- Grams to Teaspoons
 *   https://cotswoldflour.com/blogs/news/grams-to-teaspoons
 */

/** Grams per US cup (236.588 mL). */
const DENSITIES: [string[], number][] = [
  // -- Flours --
  // King Arthur: 120 g/cup
  [["all-purpose flour", "all purpose flour", "ap flour", "plain flour", "flour"], 120],
  // King Arthur: 130 g/cup
  [["bread flour", "strong flour"], 130],
  // King Arthur: 114 g/cup
  [["cake flour"], 114],
  // King Arthur: 113 g/cup
  [["pastry flour"], 113],
  // King Arthur: 128 g/cup
  [["whole wheat flour", "wholemeal flour", "whole-wheat flour", "ww flour"], 128],
  // Bob's Red Mill: 92 g/cup
  [["oat flour"], 92],
  // King Arthur: 96 g/cup
  [["almond flour", "almond meal"], 96],
  // King Arthur: 112 g/cup
  [["coconut flour"], 112],
  // King Arthur: 102 g/cup
  [["rye flour"], 102],
  // King Arthur: 142 g/cup
  [["rice flour"], 142],
  // King Arthur: 163 g/cup
  [["semolina flour", "semolina"], 163],
  // Bob's Red Mill: 120 g/cup
  [["buckwheat flour"], 120],
  // King Arthur: 113 g/cup
  [["tapioca flour", "tapioca starch"], 113],
  // Bob's Red Mill: 90 g/cup
  [["chickpea flour", "gram flour", "besan"], 90],

  // -- Sugars & syrups --
  // King Arthur: 198 g/cup
  [["granulated sugar", "white sugar", "caster sugar", "sugar", "castor sugar"], 198],
  // King Arthur: 213 g/cup
  [["brown sugar", "light brown sugar", "dark brown sugar", "packed brown sugar", "demerara sugar", "muscovado sugar"], 213],
  // King Arthur: 113 g/cup
  [["powdered sugar", "confectioners sugar", "icing sugar", "confectioners' sugar", "10x sugar"], 113],
  // Cafe Fernando: 340 g/cup
  [["honey"], 340],
  // Cafe Fernando: 312 g/cup
  [["maple syrup"], 312],
  // Cafe Fernando: 328 g/cup
  [["molasses"], 328],
  // Cafe Fernando: 328 g/cup
  [["corn syrup"], 328],

  // -- Fats --
  // King Arthur: 227 g/cup
  [["butter", "unsalted butter", "salted butter", "melted butter", "cold butter", "softened butter"], 227],
  // Cafe Fernando: 216 g/cup
  [["olive oil", "extra virgin olive oil", "evoo"], 216],
  // Cafe Fernando: 218 g/cup
  [["vegetable oil", "canola oil", "sunflower oil", "oil", "cooking oil", "neutral oil", "avocado oil", "grapeseed oil"], 218],
  // Cafe Fernando: 218 g/cup
  [["coconut oil"], 218],
  // King Arthur: 191 g/cup
  [["shortening"], 191],
  // Cafe Fernando: 205 g/cup
  [["lard"], 205],

  // -- Powders & leaveners --
  // Cotswold Flour: 4.8 g/tsp = 230 g/cup
  [["baking powder"], 230],
  // Cotswold Flour: 7 g/tsp = 336 g/cup
  [["baking soda", "bicarbonate of soda", "bicarb", "bi-carb"], 336],
  // King Arthur: 82 g/cup
  [["cocoa powder", "cocoa", "cacao powder", "cacao", "dutch process cocoa", "unsweetened cocoa"], 82],
  // Cotswold Flour: 3 g/tsp = 144 g/cup
  [["cinnamon", "ground cinnamon"], 144],
  // Cotswold Flour: 6 g/tsp = 288 g/cup
  [["salt", "table salt", "fine salt", "sea salt", "fine sea salt"], 288],
  // Morton's kosher salt ~140 g/cup (coarser grain, less dense)
  [["kosher salt", "coarse salt"], 140],

  // -- Dairy --
  // King Arthur: 245 g/cup (close to water)
  [["milk", "whole milk", "skim milk", "2% milk", "buttermilk", "1% milk", "nonfat milk", "skimmed milk"], 245],
  // King Arthur: 238 g/cup
  [["heavy cream", "whipping cream", "heavy whipping cream", "double cream", "cream", "single cream", "light cream"], 238],
  // King Arthur: 230 g/cup
  [["sour cream"], 230],
  // King Arthur: 245 g/cup
  [["yogurt", "yoghurt", "greek yogurt", "plain yogurt", "greek yoghurt", "natural yogurt"], 245],
  // King Arthur: 232 g/cup
  [["cream cheese"], 232],

  // -- Starches & grains --
  // King Arthur: 128 g/cup
  [["cornstarch", "corn starch", "cornflour", "corn flour"], 128],
  // King Arthur: 138 g/cup
  [["cornmeal", "corn meal", "polenta"], 138],
  // King Arthur: 185 g/cup
  [["rice", "white rice", "long grain rice", "basmati rice", "jasmine rice", "sushi rice", "arborio rice"], 185],
  // King Arthur: 80 g/cup
  [["oats", "rolled oats", "old-fashioned oats", "old fashioned oats", "oatmeal"], 80],
  // Cafe Fernando: 108 g/cup
  [["breadcrumbs", "bread crumbs"], 108],
  // Cafe Fernando: 50 g/cup
  [["panko", "panko breadcrumbs"], 50],

  // -- Nuts --
  // King Arthur: 143 g/cup
  [["almonds", "sliced almonds", "slivered almonds", "chopped almonds"], 143],
  // King Arthur: 120 g/cup
  [["walnuts", "chopped walnuts"], 120],
  // King Arthur: 109 g/cup
  [["pecans", "chopped pecans"], 109],
  // Cafe Fernando: 137 g/cup
  [["cashews", "cashew nuts"], 137],
  // Cafe Fernando: 135 g/cup
  [["hazelnuts", "filberts"], 135],
  // Cafe Fernando: 146 g/cup
  [["peanuts"], 146],
  // King Arthur: 258 g/cup
  [["peanut butter", "almond butter", "nut butter", "cashew butter", "sunflower butter", "tahini"], 258],

  // -- Chocolate --
  // King Arthur: 170 g/cup
  [["chocolate chips", "chocolate morsels", "choc chips"], 170],
];

/** Grams per mL, derived from g/cup. */
const ML_PER_CUP = 236.588;

export interface DensityMatch {
  /** Grams per mL for this ingredient. */
  gramsPerMl: number;
  /** The matched keyword (for display, e.g. "flour"). */
  matchedAs: string;
}

// Pre-computed candidates sorted by keyword length descending (most specific first),
// with pre-compiled regex patterns. Built once at module load.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CANDIDATES: { pattern: RegExp; gramsPerCup: number; keyword: string }[] = (() => {
  const list: { keyword: string; gramsPerCup: number }[] = [];
  for (const [keywords, gramsPerCup] of DENSITIES) {
    for (const kw of keywords) {
      list.push({ keyword: kw, gramsPerCup });
    }
  }
  list.sort((a, b) => b.keyword.length - a.keyword.length);
  return list.map(({ keyword, gramsPerCup }) => ({
    pattern: new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i"),
    gramsPerCup,
    keyword,
  }));
})();

/**
 * Look up density for an ingredient name.
 * Matches if any keyword is found as a whole word in the item text.
 * More specific (longer) keywords are checked first so "almond flour"
 * beats "flour" when the item says "almond flour".
 */
export function findDensity(item: string): DensityMatch | null {
  if (!item) return null;
  const lower = item.toLowerCase();
  for (const { pattern, gramsPerCup, keyword } of CANDIDATES) {
    if (pattern.test(lower)) {
      return { gramsPerMl: gramsPerCup / ML_PER_CUP, matchedAs: keyword };
    }
  }
  return null;
}

/**
 * Convert a volume quantity to weight using ingredient density.
 * @param volumeMl - the amount in milliliters
 * @param density - from findDensity()
 * @returns grams
 */
export function volumeToWeight(volumeMl: number, density: DensityMatch): number {
  return Math.round(volumeMl * density.gramsPerMl * 100) / 100;
}

/**
 * Convert a weight quantity to volume using ingredient density.
 * @param grams - the amount in grams
 * @param density - from findDensity()
 * @returns milliliters
 */
export function weightToVolume(grams: number, density: DensityMatch): number {
  return Math.round((grams / density.gramsPerMl) * 100) / 100;
}

/** Unit divisors for density-based conversions. Shared between picker and renderer. */
export const WEIGHT_UNITS: [string, number][] = [["g", 1], ["kg", 1000], ["oz", 28.3495], ["lb", 453.592]];
export const VOLUME_UNITS: [string, number][] = [["tsp", 4.929], ["tbsp", 14.787], ["cup", 236.588], ["ml", 1], ["l", 1000]];

export interface DensityConversion {
  qty: number;
  unit: string; // prefixed with ~ for display
}

/**
 * Convert a quantity+unit via ingredient density (volume<->weight).
 * @param qty - the numeric quantity (already scaled)
 * @param fromUnitToBase - the source unit's toBase factor (mL or g)
 * @param fromDimension - "volume" or "weight"
 * @param targetUnit - the target unit canonical name (without ~ prefix)
 * @param density - from findDensity()
 * @returns the converted result, or null if target unit is invalid
 */
export function convertViaDensity(
  qty: number,
  fromUnitToBase: number,
  fromDimension: "volume" | "weight",
  targetUnit: string,
  density: DensityMatch,
): DensityConversion | null {
  if (fromDimension === "volume") {
    const volumeMl = qty * fromUnitToBase;
    const grams = volumeToWeight(volumeMl, density);
    const divisor = WEIGHT_UNITS.find(([u]) => u === targetUnit)?.[1];
    if (!divisor) return null;
    return { qty: Math.round(grams / divisor * 10) / 10, unit: `~${targetUnit}` };
  } else {
    const grams = qty * fromUnitToBase;
    const volumeMl = weightToVolume(grams, density);
    const divisor = VOLUME_UNITS.find(([u]) => u === targetUnit)?.[1];
    if (!divisor) return null;
    return { qty: Math.round(volumeMl / divisor * 10) / 10, unit: `~${targetUnit}` };
  }
}
