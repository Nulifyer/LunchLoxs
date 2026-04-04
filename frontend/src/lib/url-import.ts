/**
 * Import a recipe from a URL.
 *
 * Flow:
 *   1. User enters URL + picks mode (AI Enhanced / Quick Import)
 *   2. POST /api/proxy/extract {url, mode}
 *      - AI mode: backend streams SSE with status updates, returns JSON recipe
 *      - Basic mode: backend returns HTML, frontend extracts JSON-LD locally
 *   3. Download images via proxy, import into book
 */

import { extractRecipeFromHtml, type ScrapedRecipe } from "./recipe-scraper";
import { canonicalUnitName } from "./units";
import { parseQty, formatQty } from "./quantity";
import { processAsset } from "./asset-processing";
import { storeBlob } from "./blob-client";
import { getSessionKeys } from "./auth";
import { getApiBase } from "./config";
import { showLoading } from "./spinner";
import { toastSuccess, toastWarning, toastError } from "./toast";
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

// Flavor text shown as sub-line during LLM processing
const FLAVOR_TEXTS = [
  "Separating recipe from life story...",
  "Skipping the three-paragraph preamble...",
  "Preheating the extraction engine...",
  "Sifting through the content...",
  "Folding in the metadata...",
  "Reducing the content to its essence...",
  "Kneading the data into shape...",
  "This recipe better be worth it...",
  "Converting cups to vibes...",
  "Debating metric vs imperial...",
];

function getAuthHeaders(): Record<string, string> {
  const session = getSessionKeys();
  if (!session) return {};
  return { "X-User-ID": session.userId, "X-Auth-Hash": session.authHash };
}

async function proxyFetch(url: string): Promise<Response> {
  return fetch(`${getApiBase()}/api/proxy/fetch`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

/** Check if the LLM extract endpoint is configured. */
async function isLlmAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${getApiBase()}/api/proxy/extract`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "probe" }),
    });
    return resp.status === 204;
  } catch {
    return false;
  }
}

/** Read SSE stream from the AI extract endpoint. Updates loading spinner and returns ScrapedRecipe. */
async function extractRecipeAI(
  url: string,
  loading: { update: (msg: string) => void; updateLine2: (msg: string) => void },
): Promise<ScrapedRecipe & { warnings?: string[] }> {
  const warnings: string[] = [];
  const resp = await fetch(`${getApiBase()}/api/proxy/extract`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode: "ai" }),
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 501) throw new Error("AI extraction is not configured on this server.");
    if (resp.status === 400) throw new Error(text || "Invalid URL.");
    if (resp.status === 429) throw new Error("Rate limit exceeded. Try again later.");
    throw new Error(text || "Could not extract recipe.");
  }

  // Cycle flavor text as sub-line
  const pool = [...FLAVOR_TEXTS].sort(() => Math.random() - 0.5);
  let flavorIdx = 0;
  loading.updateLine2(pool[0]!);
  const flavorInterval = setInterval(() => {
    flavorIdx = (flavorIdx + 1) % pool.length;
    loading.updateLine2(pool[flavorIdx]!);
  }, 4000);

  try {
    // Read SSE stream
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events (separated by double newline)
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!; // keep incomplete event

      for (const part of parts) {
        if (!part.trim()) continue;
        const eventMatch = part.match(/^event: (.+)$/m);
        const dataMatch = part.match(/^data: (.+)$/m);
        if (!eventMatch || !dataMatch) continue;

        const eventType = eventMatch[1]!;
        const data = JSON.parse(dataMatch[1]!);

        if (eventType === "status") {
          loading.update(data.message);
        } else if (eventType === "warning") {
          warnings.push(data.message);
        } else if (eventType === "result") {
          // Normalize the recipe data
          const recipe: ScrapedRecipe = {
            title: data.title ?? "",
            description: data.description ?? "",
            servings: data.servings ?? 4,
            prepMinutes: data.prepMinutes ?? 0,
            cookMinutes: data.cookMinutes ?? 0,
            tags: data.tags ?? [],
            ingredients: (data.ingredients ?? []).map((ing: any) => ({
              quantity: normalizeQty(ing.quantity ?? ""),
              unit: canonicalUnitName(ing.unit ?? "") ?? ing.unit ?? "",
              item: ing.item ?? "",
            })),
            instructions: data.instructions ?? "",
            imageUrls: data.imageUrls ?? [],
          };
          if (warnings.length > 0) recipe.warnings = warnings;
          return recipe;
        } else if (eventType === "error") {
          throw new Error(data.message || "AI extraction failed.");
        }
      }
    }

    throw new Error("AI extraction ended without returning a recipe.");
  } finally {
    clearInterval(flavorInterval);
    loading.updateLine2("");
  }
}

/** Extract recipe via basic mode (JSON-LD / microdata, no LLM). */
async function extractRecipeBasic(url: string): Promise<ScrapedRecipe | null> {
  const resp = await fetch(`${getApiBase()}/api/proxy/extract`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode: "basic" }),
  });
  if (!resp.ok) return null;
  const html = await resp.text();
  return extractRecipeFromHtml(html, url);
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

  const loading = showLoading(useLlm ? "Starting AI extraction..." : "Fetching recipe...", 0);
  try {
    // 1. Extract recipe
    let recipe: ScrapedRecipe | null = null;

    if (useLlm) {
      const result = await extractRecipeAI(url, loading);
      if (result.warnings?.length) {
        for (const msg of result.warnings) toastWarning(msg);
      }
      recipe = result;
    } else {
      loading.update("Fetching recipe...");
      recipe = await extractRecipeBasic(url);
    }

    if (!recipe || !recipe.title) {
      toastError("Could not extract recipe data from this page. Try a different URL.");
      return;
    }

    // 2. Download and process images
    const urlToChecksum = new Map<string, string>();
    if (recipe.imageUrls.length > 0 && book.encKey) {
      const total = Math.min(recipe.imageUrls.length, MAX_IMAGES);
      loading.update(`Downloading images (0/${total})...`);
      loading.updateLine2("");
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

    // 3. Replace image URLs with blob checksums in instructions
    let instructions = recipe.instructions;
    for (const [imgUrl, checksum] of urlToChecksum) {
      const escaped = imgUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      instructions = instructions.replace(
        new RegExp(`!\\[([^\\]]*)\\]\\(${escaped}\\)`, "g"),
        `![$1](blob:${checksum})`,
      );
    }
    // Remove any remaining external image refs that weren't downloaded
    instructions = instructions.replace(/!\[[^\]]*\]\(https?:\/\/[^)]+\)\n?/g, "");

    // 4. Import into book
    loading.update("Saving to your book...");
    loading.updateLine2("");
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
    toastError(e.message ?? "Import failed.");
  } finally {
    loading.dismiss();
  }
}
