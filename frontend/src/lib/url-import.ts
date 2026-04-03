/**
 * Import a recipe from a URL.
 *
 * Flow:
 *   1. Fetch HTML via proxy
 *   2. Try JSON-LD / microdata extraction
 *   3. If no JSON-LD, re-fetch with Browserless (JS rendering)
 *   4. CODE: Transform JSON-LD → simple text format (preserves full verbatim text)
 *   5. LLM Pass 1: Enhance simple format (infer quantities, clean units, place images)
 *   6. LLM Pass 2: Add @[ingredient] tags to instructions
 *   7. CODE: Parse simple format → ScrapedRecipe → download images → import
 *
 * Without LLM: steps 4-6 are skipped, basic JSON-LD extraction used instead.
 */

import { extractRecipeFromHtml, buildSimpleFormat, hasJsonLdRecipe, extractHtmlImages, cleanHtmlForLlm, type ScrapedRecipe } from "./recipe-scraper";
import { canonicalUnitName } from "./units";
import { parseQty, formatQty } from "./quantity";
import { processAsset } from "./asset-processing";
import { storeBlob } from "./blob-client";
import { getSessionKeys } from "./auth";
import { getApiBase } from "./config";
import { showPrompt, showSelect } from "./dialogs";
import { showLoading } from "./spinner";
import { toastSuccess, toastError } from "./toast";
import { importRecipesIntoBook } from "../import-export";
import { getDocMgr } from "../state";
import { selectRecipe } from "../ui/recipes";
import { renderCatalog } from "../sync/push";
import type { Book, BookCatalog, Recipe, RecipeMeta } from "../types";

const MAX_IMAGES = 5;

/** Normalize a quantity string: unicode fractions → ASCII, round-trip through parseQty if possible. */
function normalizeQty(raw: string): string {
  if (!raw) return raw;
  const n = parseQty(raw);
  if (n !== null) return formatQty(n);
  return raw;
}

// Flavor text for long-running LLM steps — shuffled, no repeats until all used
const FLAVOR_TEXTS = [
  // Reading / parsing
  "Reading through the recipe...",
  "Scanning for ingredients...",
  "Looking for the good parts...",
  "Separating recipe from life story...",
  "Skipping the three-paragraph preamble...",
  "Finding where the recipe actually starts...",
  "Decoding the ingredient list...",
  "Parsing quantities and units...",

  // Cooking metaphors
  "Preheating the extraction engine...",
  "Measuring out the data...",
  "Sifting through the content...",
  "Whisking the ingredients together...",
  "Folding in the metadata...",
  "Letting the flavors develop...",
  "Reducing the content to its essence...",
  "Bringing everything to a simmer...",
  "Deglazing the page...",
  "Caramelizing the details...",
  "Kneading the data into shape...",
  "Proofing the results...",
  "Rolling out the instructions...",
  "Tempering the output...",

  // Progress / steps
  "Matching images to steps...",
  "Organizing the cooking steps...",
  "Sorting ingredients by type...",
  "Tagging ingredient references...",
  "Cross-referencing the steps...",
  "Structuring the instructions...",
  "Connecting the dots...",

  // Finishing
  "Almost there, just plating up...",
  "Taste-testing the data...",
  "Adding the finishing touches...",
  "Garnishing with tags...",
  "Final quality check...",
  "Cleaning up the kitchen...",
  "Wiping down the counters...",

  // Fun
  "This recipe better be worth it...",
  "Wondering if we should double the batch...",
  "Resisting the urge to snack...",
  "Making a grocery list in our head...",
  "Hoping nobody salted it twice...",
  "Checking if the oven is off...",
  "Googling what 'fold gently' means...",
  "Pretending we knew what blanch means...",
  "Converting cups to vibes...",
  "Debating metric vs imperial...",
];

/** Start cycling flavor text on the loading spinner's second line. Returns a stop function.
 *  Shuffles the list and shows each message once before recycling. */
function startFlavorText(loading: { updateLine2: (msg: string) => void }): () => void {
  const pool = [...FLAVOR_TEXTS];
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  let idx = 0;
  loading.updateLine2(pool[0]!);
  const interval = setInterval(() => {
    idx++;
    if (idx >= pool.length) {
      // Reshuffle when exhausted
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      idx = 0;
    }
    loading.updateLine2(pool[idx]!);
  }, 4000);
  return () => { clearInterval(interval); loading.updateLine2(""); };
}

function getAuthHeaders(): Record<string, string> {
  const session = getSessionKeys();
  if (!session) return {};
  return { "X-User-ID": session.userId, "X-Auth-Hash": session.authHash };
}

async function proxyFetch(url: string, render = false): Promise<Response> {
  return fetch(`${getApiBase()}/api/proxy/fetch`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ url, render }),
  });
}

/** Send text to LLM extract endpoint. Returns raw text response or null. */
async function llmCall(text: string, pass: "extract" | "enhance" = "extract"): Promise<string | null> {
  try {
    const resp = await fetch(`${getApiBase()}/api/proxy/extract`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ text, pass }),
    });
    if (resp.status === 501) return null; // LLM not configured
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/** Parse the simple text format into a ScrapedRecipe. */
function parseSimpleFormat(text: string): ScrapedRecipe | null {
  const recipe: ScrapedRecipe = {
    title: "", description: "", servings: 4, prepMinutes: 0, cookMinutes: 0,
    ingredients: [], instructions: "", tags: [], imageUrls: [],
  };

  // Parse header fields
  const headerMatch = (key: string): string => {
    const re = new RegExp(`^${key}:\\s*(.+)$`, "mi");
    const m = text.match(re);
    return m ? m[1]!.trim() : "";
  };

  recipe.title = headerMatch("TITLE");
  if (!recipe.title) return null;
  recipe.description = headerMatch("DESC");
  recipe.servings = parseInt(headerMatch("SERVINGS")) || 4;
  recipe.prepMinutes = parseInt(headerMatch("PREP")) || 0;
  recipe.cookMinutes = parseInt(headerMatch("COOK")) || 0;
  recipe.tags = headerMatch("TAGS").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);

  // Parse ingredients (lines between INGREDIENTS: and next section)
  const ingSection = text.match(/^INGREDIENTS:\s*\n([\s\S]*?)(?=\n(?:INSTRUCTIONS:|ADDITIONAL IMAGES:))/mi);
  if (ingSection) {
    for (const line of ingSection[1]!.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        recipe.ingredients.push({
          quantity: normalizeQty(parts[0]!),
          unit: canonicalUnitName(parts[1]!) ?? parts[1]!,
          item: parts[2]!,
        });
      } else if (parts.length === 1) {
        recipe.ingredients.push({ quantity: "", unit: "", item: trimmed });
      }
    }
  }

  // Parse instructions (everything after INSTRUCTIONS: to end, excluding ADDITIONAL IMAGES if present)
  const instrIdx = text.search(/^INSTRUCTIONS:\s*$/mi);
  if (instrIdx >= 0) {
    let instrText = text.slice(instrIdx).replace(/^INSTRUCTIONS:\s*\n?/i, "");
    // Remove ADDITIONAL IMAGES section if present
    const addlIdx = instrText.search(/^ADDITIONAL IMAGES:/mi);
    if (addlIdx >= 0) instrText = instrText.slice(0, addlIdx);
    recipe.instructions = instrText.trim();
  }

  // Collect image URLs from ![alt](url) in instructions
  for (const match of recipe.instructions.matchAll(/!\[[^\]]*\]\((.+?)\)/g)) {
    const url = match[1]!;
    if (!recipe.imageUrls.includes(url)) recipe.imageUrls.push(url);
  }

  return recipe;
}

/** Check if the LLM extract endpoint is configured (quick probe). */
async function isLlmAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${getApiBase()}/api/proxy/extract`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    // 501 = not configured, 400 = configured but bad input (means it's there)
    return resp.status !== 501;
  } catch {
    return false;
  }
}

export async function handleImportFromUrl(book: Book): Promise<void> {
  const url = await showPrompt("Paste a recipe URL:", {
    title: "Import from URL",
    placeholder: "https://www.example.com/recipe/...",
    confirmText: "Import",
  });
  if (!url) return;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      toastError("Please enter a valid URL starting with https://");
      return;
    }
  } catch {
    toastError("Please enter a valid URL.");
    return;
  }

  // Check if LLM is available and let user choose mode
  let useLlm = false;
  const llmAvailable = await isLlmAvailable();
  if (llmAvailable) {
    const mode = await showSelect([
      { value: "llm", label: "AI Enhanced (slower, better quality)" },
      { value: "basic", label: "Quick Import (fast, basic extraction)" },
    ], {
      title: "Import Mode",
      message: "AI enhancement adds ingredient tagging, infers missing quantities, and places step images. Takes a few minutes.",
    });
    if (!mode) return; // cancelled
    useLlm = mode === "llm";
  }

  const loading = showLoading("Fetching recipe...", 0);
  try {
    // 1. Fetch static HTML
    const resp = await proxyFetch(url);
    if (!resp.ok) {
      const status = resp.status;
      if (status === 403 || status === 429) {
        toastError("This site blocked the request. Try a different URL.");
      } else if (status === 400) {
        toastError((await resp.text()) || "Invalid URL.");
      } else {
        toastError("Could not reach the URL. Please check it and try again.");
      }
      return;
    }

    let html = await resp.text();
    loading.update("Looking for recipe data...");
    let hasJsonLd = hasJsonLdRecipe(html);

    // 2. If no JSON-LD in static HTML, try Browserless rendering
    if (!hasJsonLd) {
      loading.update("Page needs rendering...");
      loading.updateLine2("Loading JavaScript content");
      const renderResp = await proxyFetch(url, true);
      if (renderResp.ok) {
        html = await renderResp.text();
        hasJsonLd = hasJsonLdRecipe(html);
      }
      loading.updateLine2("");
    }

    // 3. Extract recipe
    let recipe: ScrapedRecipe | null = null;

    if (useLlm && hasJsonLd) {
      // JSON-LD + LLM path:
      // a) Transform JSON-LD → simple format (preserves full verbatim text + images)
      loading.update("Preparing recipe data...");
      const pageImages = extractHtmlImages(html);
      const simpleFormat = buildSimpleFormat(html, pageImages);

      if (simpleFormat) {
        // b) LLM Pass 1: Enhance (infer quantities, clean up, place additional images)
        loading.update("Enhancing recipe...");
        let stopFlavor = startFlavorText(loading);
        const enhanced = await llmCall(simpleFormat, "extract");
        stopFlavor();

        if (enhanced) {
          // c) LLM Pass 2: Tag ingredients in instructions
          loading.update("Tagging ingredients...");
          stopFlavor = startFlavorText(loading);
          const tagged = await llmCall(enhanced, "enhance");
          stopFlavor();

          // d) Parse the final simple format
          recipe = parseSimpleFormat(tagged ?? enhanced);
        }
      }
    } else if (useLlm && !hasJsonLd) {
      // No JSON-LD — send cleaned HTML to LLM, get simple format back
      loading.update("No structured data, trying AI extraction...");
      const stopFlavor = startFlavorText(loading);
      const cleaned = cleanHtmlForLlm(html);
      const result = await llmCall(cleaned, "extract");
      stopFlavor();

      if (result) {
        // Pass 2: Tag ingredients
        loading.update("Tagging ingredients...");
        const stopFlavor2 = startFlavorText(loading);
        const tagged = await llmCall(result, "enhance");
        stopFlavor2();
        recipe = parseSimpleFormat(tagged ?? result);
      }
    }

    // 4. Fall back to basic JSON-LD extraction (no LLM, user chose basic, or LLM failed)
    if (!recipe) {
      loading.update("Extracting recipe...");
      recipe = extractRecipeFromHtml(html, url);
    }

    // 5. Check if we got anything
    if (!recipe || !recipe.title) {
      toastError("Could not extract recipe data from this page. Try a different URL.");
      return;
    }

    // 6. Download and process images
    const urlToChecksum = new Map<string, string>();
    if (recipe.imageUrls.length > 0 && book.encKey) {
      const total = Math.min(recipe.imageUrls.length, MAX_IMAGES);
      loading.update(`Downloading images (0/${total})...`);
      let downloaded = 0;
      const docMgrForBlobs = getDocMgr();
      if (docMgrForBlobs) {
        const db = docMgrForBlobs.getDb();
        for (const imgUrl of recipe.imageUrls.slice(0, MAX_IMAGES)) {
          try {
            const imgResp = await proxyFetch(imgUrl);
            if (!imgResp.ok) continue;
            const contentType = imgResp.headers.get("Content-Type") ?? "image/jpeg";
            if (!contentType.startsWith("image/")) continue;
            const bytes = new Uint8Array(await imgResp.arrayBuffer());
            const urlPath = new URL(imgUrl).pathname;
            const filename = urlPath.split("/").pop() ?? "image.jpg";
            const file = new File([bytes], filename, { type: contentType });
            const processed = await processAsset(file);
            const checksum = await storeBlob(db, book.vaultId, processed.bytes, processed.mimeType, processed.filename, book.encKey!);
            urlToChecksum.set(imgUrl, checksum);
            downloaded++;
            loading.update(`Downloading images (${downloaded}/${total})...`);
          } catch {
            // Skip failed images
          }
        }
      }
    }

    // 7. Replace ![alt](url) image references with ![alt](blob:checksum)
    let instructions = recipe.instructions;
    for (const [imgUrl, checksum] of urlToChecksum) {
      // Replace ![any alt text](imgUrl) with ![alt](blob:checksum)
      const escaped = imgUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      instructions = instructions.replace(
        new RegExp(`!\\[([^\\]]*)\\]\\(${escaped}\\)`, "g"),
        `![$1](blob:${checksum})`,
      );
    }
    // Remove any remaining image refs that weren't downloaded
    instructions = instructions.replace(/!\[[^\]]*\]\(https?:\/\/[^)]+\)\n?/g, "");

    // 8. Import into book
    loading.update("Saving to your book...");
    const recipeData: { meta: Partial<RecipeMeta>; content: Partial<Recipe> } = {
      meta: {
        title: recipe.title,
        tags: recipe.tags,
        servings: recipe.servings,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
      },
      content: {
        description: recipe.description,
        ingredients: recipe.ingredients,
        instructions,
        imageUrls: [],
        notes: `Source: ${url}`,
      },
    };

    const count = await importRecipesIntoBook(book, [recipeData]);
    if (count > 0) {
      toastSuccess(`Imported "${recipe.title}"`);
      renderCatalog();

      const docMgr = getDocMgr();
      if (docMgr) {
        const catalog = docMgr.get<BookCatalog>(`${book.vaultId}/catalog`);
        if (catalog) {
          const catDoc = catalog.getDoc();
          const last = catDoc.recipes?.[catDoc.recipes.length - 1];
          if (last) selectRecipe(last.id);
        }
      }
    }
  } catch (e: any) {
    toastError("Import failed: " + (e.message ?? e));
  } finally {
    loading.dismiss();
  }
}
