/**
 * Recipe scraper — extracts structured recipe data from HTML.
 *
 * Extraction pipeline:
 *   1. JSON-LD (Schema.org Recipe) — covers ~90% of recipe sites
 *   2. Microdata (itemprop attributes) — older format, same data
 *   3. Falls through to caller for LLM fallback or error
 */

import { canonicalUnitName } from "./units";

export interface ScrapedRecipe {
  title: string;
  description: string;
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  ingredients: Array<{ item: string; quantity: string; unit: string }>;
  instructions: string;
  tags: string[];
  imageUrls: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Try to extract a recipe from raw HTML. Returns null if no structured data found. */
export function extractRecipeFromHtml(html: string, sourceUrl: string): ScrapedRecipe | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return extractFromJsonLd(doc) ?? extractFromMicrodata(doc) ?? null;
}

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

function extractFromJsonLd(doc: Document): ScrapedRecipe | null {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      const recipe = findRecipeInJsonLd(data);
      if (recipe) return mapSchemaOrgToRecipe(recipe);
    } catch {
      // Skip invalid JSON
    }
  }
  return null;
}

function findRecipeInJsonLd(data: any): any | null {
  if (!data) return null;

  // Direct Recipe type
  if (data["@type"] === "Recipe") return data;
  // Array of types (some sites use ["Recipe", "SomethingElse"])
  if (Array.isArray(data["@type"]) && data["@type"].includes("Recipe")) return data;

  // @graph array (common in WordPress/Yoast)
  if (Array.isArray(data["@graph"])) {
    for (const item of data["@graph"]) {
      const found = findRecipeInJsonLd(item);
      if (found) return found;
    }
  }

  // Top-level array
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipeInJsonLd(item);
      if (found) return found;
    }
  }

  return null;
}

function mapSchemaOrgToRecipe(data: any): ScrapedRecipe {
  const { text: instructions, stepImageUrls } = normalizeInstructions(data.recipeInstructions);
  return {
    title: str(data.name),
    description: stripHtml(str(data.description)),
    servings: parseRecipeYield(data.recipeYield),
    prepMinutes: parseISO8601Duration(str(data.prepTime)),
    cookMinutes: parseISO8601Duration(str(data.cookTime)),
    ingredients: parseIngredientList(data.recipeIngredient),
    instructions,
    tags: parseTags(data.recipeCategory, data.keywords),
    // Step images are inline as [IMAGE:] markers in instructions — downloaded during import
    imageUrls: stepImageUrls,
  };
}

// ---------------------------------------------------------------------------
// Microdata extraction
// ---------------------------------------------------------------------------

function extractFromMicrodata(doc: Document): ScrapedRecipe | null {
  // Look for an element with itemtype containing schema.org/Recipe
  const recipeEl =
    doc.querySelector('[itemtype*="schema.org/Recipe"]') ??
    doc.querySelector('[itemtype*="schema.org/recipe"]');
  if (!recipeEl) return null;

  const prop = (name: string): string =>
    recipeEl.querySelector(`[itemprop="${name}"]`)?.textContent?.trim() ?? "";

  const propContent = (name: string): string => {
    const el = recipeEl.querySelector(`[itemprop="${name}"]`);
    return (el as HTMLMetaElement)?.content ?? el?.textContent?.trim() ?? "";
  };

  // Ingredients
  const ingredientEls = recipeEl.querySelectorAll('[itemprop="recipeIngredient"], [itemprop="ingredients"]');
  const ingredientStrings = Array.from(ingredientEls).map((el) => el.textContent?.trim() ?? "").filter(Boolean);

  // Instructions
  const instructionEls = recipeEl.querySelectorAll('[itemprop="recipeInstructions"]');
  let instructions = "";
  if (instructionEls.length === 1 && instructionEls[0]!.querySelectorAll("li, p").length > 1) {
    // Single container with multiple steps
    const steps = Array.from(instructionEls[0]!.querySelectorAll("li, p")).map((el) => el.textContent?.trim() ?? "").filter(Boolean);
    instructions = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  } else if (instructionEls.length > 1) {
    instructions = Array.from(instructionEls).map((el, i) => `${i + 1}. ${el.textContent?.trim()}`).join("\n");
  } else if (instructionEls.length === 1) {
    instructions = instructionEls[0]!.textContent?.trim() ?? "";
  }

  // Image
  const imgEl = recipeEl.querySelector('[itemprop="image"]');
  const imageUrl = (imgEl as HTMLImageElement)?.src ?? (imgEl as HTMLMetaElement)?.content ?? "";
  const imageUrls = imageUrl ? [imageUrl] : [];

  return {
    title: prop("name"),
    description: stripHtml(propContent("description")),
    servings: parseRecipeYield(propContent("recipeYield")),
    prepMinutes: parseISO8601Duration(propContent("prepTime")),
    cookMinutes: parseISO8601Duration(propContent("cookTime")),
    ingredients: ingredientStrings.map(parseIngredientString),
    instructions,
    tags: parseTags(propContent("recipeCategory"), propContent("keywords")),
    imageUrls,
  };
}

// ---------------------------------------------------------------------------
// Ingredient string parsing
// ---------------------------------------------------------------------------

// Unicode fraction map
const UNICODE_FRACTIONS: Record<string, string> = {
  "\u00bc": "1/4", "\u00bd": "1/2", "\u00be": "3/4",
  "\u2153": "1/3", "\u2154": "2/3",
  "\u215b": "1/8", "\u215c": "3/8", "\u215d": "5/8", "\u215e": "7/8",
};

function normalizeUnicodeFractions(s: string): string {
  return s.replace(/([\u00bc\u00bd\u00be\u2153\u2154\u215b-\u215e])/g, (_, ch) => {
    return UNICODE_FRACTIONS[ch] ?? ch;
  });
}

// Quantity pattern: integers, decimals, fractions, mixed numbers
// Matches: "2", "2.5", "1/2", "2 1/2", "2½"
const QTY_RE = /^(\d+(?:\s+\d+\/\d+|\.\d+|\/\d+)?)\s*/;

export function parseIngredientString(raw: string): { quantity: string; unit: string; item: string } {
  let s = normalizeUnicodeFractions(raw).trim();

  // Handle parenthetical amounts at the start: "1 (14 oz) can..." → qty="1", strip parens, continue
  // We'll parse quantity first, then check for unit

  // Extract quantity
  const qtyMatch = s.match(QTY_RE);
  let quantity = "";
  if (qtyMatch) {
    quantity = qtyMatch[1]!.trim();
    s = s.slice(qtyMatch[0]!.length).trim();
  }

  // Try to match a unit from the remaining text
  let unit = "";
  const words = s.split(/\s+/);

  // Try matching 2-word units first (e.g. "fl oz", "fluid ounces")
  if (words.length >= 2) {
    const twoWord = words[0] + " " + words[1];
    const canonical = canonicalUnitName(twoWord);
    if (canonical) {
      unit = canonical;
      s = words.slice(2).join(" ").trim();
    }
  }

  // Try single-word unit
  if (!unit && words.length >= 1) {
    // Strip trailing period for matching (e.g. "cups." → "cups")
    const candidate = words[0]!.replace(/\.$/, "");
    const canonical = canonicalUnitName(candidate);
    if (canonical) {
      unit = canonical;
      s = words.slice(1).join(" ").trim();
    }
  }

  // Clean up item: strip leading "of " (e.g. "of flour" → "flour")
  s = s.replace(/^of\s+/i, "").trim();

  return { quantity, unit, item: s || raw.trim() };
}

function parseIngredientList(data: any): Array<{ item: string; quantity: string; unit: string }> {
  if (!Array.isArray(data)) return [];
  return data.filter((s) => typeof s === "string" && s.trim()).map(parseIngredientString);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse ISO 8601 duration (PT30M, PT1H30M, PT2H) to minutes. */
export function parseISO8601Duration(s: string): number {
  if (!s) return 0;
  const match = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) return 0;
  const hours = parseInt(match[1] ?? "0", 10);
  const mins = parseInt(match[2] ?? "0", 10);
  return hours * 60 + mins;
}

/** Parse recipe yield to integer servings. Handles "4", "4 servings", "4-6", etc. */
export function parseRecipeYield(val: any): number {
  if (typeof val === "number") return val;
  const s = String(val ?? "");
  const match = s.match(/(\d+)/);
  return match ? parseInt(match[1]!, 10) : 4; // default to 4 servings
}

/** Normalize various instruction formats to numbered markdown text.
 *  Embeds [IMAGE: url] markers inline when HowToStep has an image field. */
function normalizeInstructions(data: any): { text: string; stepImageUrls: string[] } {
  if (!data) return { text: "", stepImageUrls: [] };

  // Plain string
  if (typeof data === "string") {
    return { text: stripHtml(data), stepImageUrls: [] };
  }

  // Array
  if (Array.isArray(data)) {
    const lines: string[] = [];
    const stepImageUrls: string[] = [];
    let stepNum = 1;

    const addStep = (text: string, imageUrl?: string) => {
      lines.push(`${stepNum}. ${text}`);
      stepNum++;
      if (imageUrl) {
        lines.push(`[IMAGE: ${imageUrl}]`);
        stepImageUrls.push(imageUrl);
      }
    };

    for (const item of data) {
      if (typeof item === "string") {
        addStep(stripHtml(item));
      } else if (item && typeof item === "object") {
        // HowToStep
        if (item.text) {
          const imgUrl = typeof item.image === "string" ? item.image : item.image?.url;
          addStep(stripHtml(String(item.text)), imgUrl);
        } else if (item.name && !item.itemListElement) {
          const imgUrl = typeof item.image === "string" ? item.image : item.image?.url;
          addStep(stripHtml(String(item.name)), imgUrl);
        }
        // HowToSection
        if (Array.isArray(item.itemListElement)) {
          for (const subItem of item.itemListElement) {
            if (typeof subItem === "string") {
              addStep(stripHtml(subItem));
            } else if (subItem?.text) {
              const imgUrl = typeof subItem.image === "string" ? subItem.image : subItem.image?.url;
              addStep(stripHtml(String(subItem.text)), imgUrl);
            }
          }
        }
      }
    }
    return { text: lines.join("\n"), stepImageUrls };
  }

  return { text: "", stepImageUrls: [] };
}

/** Parse tags from recipeCategory and keywords. */
function parseTags(category: any, keywords: any): string[] {
  const tags = new Set<string>();
  const add = (val: any) => {
    if (typeof val === "string") {
      for (const t of val.split(/,\s*/)) {
        const trimmed = t.trim().toLowerCase();
        if (trimmed) tags.add(trimmed);
      }
    } else if (Array.isArray(val)) {
      for (const v of val) add(v);
    }
  };
  add(category);
  add(keywords);
  return [...tags];
}

/** Parse image URLs from Schema.org image field (string, array, or ImageObject). */
function parseImageUrls(data: any): string[] {
  if (!data) return [];
  if (typeof data === "string") return [data];
  if (Array.isArray(data)) {
    return data.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item?.url) return [String(item.url)];
      return [];
    });
  }
  if (data.url) return [String(data.url)];
  return [];
}

/** Strip HTML tags to plain text. */
function stripHtml(html: string): string {
  // Convert <br> and block elements to newlines first
  let s = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n");
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode common entities
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function str(val: any): string {
  return typeof val === "string" ? val : String(val ?? "");
}
