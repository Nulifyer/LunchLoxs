/**
 * Import a recipe from a URL.
 *
 * Flow:
 *   1. User enters URL + picks mode (AI Enhanced / Quick Import)
 *   2. POST /api/proxy/extract {url, mode}
 *      - Backend fetches HTML (static → Browserless fallback)
 *      - If JSON-LD found: returns HTML (frontend extracts locally)
 *      - If no JSON-LD + AI mode: backend runs cleanHtml → LLM pipeline → returns simple format
 *   3. Frontend parses response → ScrapedRecipe
 *   4. Download images via proxy, import into book
 */

import { extractRecipeFromHtml, buildSimpleFormat, hasJsonLdRecipe, extractHtmlImages, type ScrapedRecipe } from "./recipe-scraper";
import { canonicalUnitName } from "./units";
import { parseQty, formatQty } from "./quantity";
import { processAsset } from "./asset-processing";
import { storeBlob } from "./blob-client";
import { getSessionKeys } from "./auth";
import { getApiBase } from "./config";
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

/** Call the unified extract endpoint. Backend handles fetch + Browserless + LLM pipeline. */
async function extractRecipe(url: string, mode: "ai" | "basic"): Promise<Response> {
  return fetch(`${getApiBase()}/api/proxy/extract`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode }),
  });
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
      body: JSON.stringify({ url: "https://probe.test", mode: "ai" }),
    });
    // 501 = LLM not configured, 400 = configured (bad URL but endpoint exists)
    return resp.status !== 501;
  } catch {
    return false;
  }
}

/** Show a combined URL + import mode dialog. Returns null if cancelled. */
function showImportDialog(llmAvailable: boolean): Promise<{ url: string; useLlm: boolean } | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "custom-dialog";
    const article = document.createElement("article");
    const body = document.createElement("div");
    body.className = "custom-dialog-body";
    const footer = document.createElement("div");
    footer.className = "dialog-footer";
    article.appendChild(body);
    article.appendChild(footer);
    dialog.appendChild(article);

    const h = document.createElement("strong");
    h.textContent = "Import from URL";
    h.style.display = "block";
    h.style.marginBottom = "0.5rem";
    body.appendChild(h);

    const label = document.createElement("label");
    label.textContent = "Paste a recipe URL:";
    label.style.fontSize = "0.8rem";
    body.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "https://www.example.com/recipe/...";
    input.style.marginTop = "0.3rem";
    body.appendChild(input);

    let modeSelect: HTMLSelectElement | null = null;
    if (llmAvailable) {
      const modeLabel = document.createElement("label");
      modeLabel.textContent = "Import mode:";
      modeLabel.style.fontSize = "0.8rem";
      modeLabel.style.marginTop = "0.75rem";
      modeLabel.style.display = "block";
      body.appendChild(modeLabel);

      modeSelect = document.createElement("select");
      modeSelect.style.marginTop = "0.3rem";
      for (const opt of [
        { value: "llm", label: "AI Enhanced (slower, better quality)" },
        { value: "basic", label: "Quick Import (fast, basic extraction)" },
      ]) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        modeSelect.appendChild(o);
      }
      body.appendChild(modeSelect);
    }

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { dialog.close(); resolve(null); });
    footer.appendChild(cancel);

    const confirm = document.createElement("button");
    confirm.textContent = "Import";
    confirm.className = "primary";
    const doConfirm = () => {
      dialog.close();
      resolve({ url: input.value, useLlm: modeSelect?.value === "llm" });
    };
    confirm.addEventListener("click", doConfirm);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doConfirm(); });
    footer.appendChild(confirm);

    dialog.addEventListener("cancel", () => resolve(null));

    // Mount and show (same pattern as dialogs.ts showAndCleanup)
    document.body.appendChild(dialog);
    dialog.style.position = "fixed";
    dialog.style.top = "50%";
    dialog.style.left = "50%";
    dialog.style.transform = "translate(-50%, -50%)";
    dialog.style.zIndex = "210";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.style.display = "block";
    backdrop.style.zIndex = "200";
    document.body.insertBefore(backdrop, dialog);
    dialog.show();
    dialog.addEventListener("close", () => { backdrop.remove(); dialog.remove(); document.body.style.overflow = ""; }, { once: true });
    document.body.style.overflow = "hidden";
    input.focus();
  });
}

export async function handleImportFromUrl(book: Book): Promise<void> {
  const llmAvailable = await isLlmAvailable();
  const result = await showImportDialog(llmAvailable);
  if (!result) return;

  const { url, useLlm } = result;
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

  const loading = showLoading("Fetching recipe...", 0);
  try {
    // 1. Send URL + mode to backend — it handles fetch, Browserless, JSON-LD check, LLM pipeline
    const mode = useLlm ? "ai" : "basic";
    loading.update(useLlm ? "Extracting recipe with AI..." : "Fetching recipe...");
    let stopFlavor: (() => void) | null = null;
    if (useLlm) stopFlavor = startFlavorText(loading);

    const resp = await extractRecipe(url, mode);

    if (stopFlavor) stopFlavor();

    if (!resp.ok) {
      const status = resp.status;
      if (status === 400) {
        toastError((await resp.text()) || "Invalid URL.");
      } else if (status === 501) {
        toastError("AI extraction is not configured on this server.");
      } else if (status === 429) {
        toastError("Rate limit exceeded. Try again later.");
      } else {
        toastError("Could not extract recipe. Try a different URL.");
      }
      return;
    }

    // 2. Parse the response based on content type
    let recipe: ScrapedRecipe | null = null;
    const contentType = resp.headers.get("Content-Type") ?? "";

    if (contentType.includes("text/plain")) {
      // LLM pipeline output — simple text format
      loading.update("Parsing recipe data...");
      const text = await resp.text();
      recipe = parseSimpleFormat(text);
    } else {
      // HTML response — extract JSON-LD / microdata locally
      loading.update("Extracting recipe data...");
      const html = await resp.text();

      // Try LLM-enhanced path if we have JSON-LD and user wants AI
      if (useLlm && hasJsonLdRecipe(html)) {
        const pageImages = extractHtmlImages(html);
        const simpleFormat = buildSimpleFormat(html, pageImages);
        if (simpleFormat) {
          // Send simple format to backend for LLM processing
          loading.update("Enhancing recipe with AI...");
          const stopFlavor2 = startFlavorText(loading);
          const llmResp = await fetch(`${getApiBase()}/api/proxy/extract`, {
            method: "POST",
            headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ text: simpleFormat }),
          });
          stopFlavor2();
          if (llmResp.ok) {
            recipe = parseSimpleFormat(await llmResp.text());
          }
        }
      }

      // Fall back to basic extraction
      if (!recipe) {
        recipe = extractRecipeFromHtml(html, url);
      }
    }

    // 3. Check if we got anything
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
