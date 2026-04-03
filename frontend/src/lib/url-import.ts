/**
 * Import a recipe from a URL.
 *
 * Flow:
 *   1. Fetch HTML via proxy
 *   2. Try JSON-LD / microdata extraction
 *   3. If no JSON-LD, re-fetch with Browserless (JS rendering)
 *   4. If LLM configured: send JSON-LD or cleaned HTML to LLM for enhanced extraction
 *   5. If LLM not configured: use JSON-LD extraction as-is
 *   6. Download step images, import into book
 */

import { extractRecipeFromHtml, extractRawJsonLd, cleanHtmlForLlm, type ScrapedRecipe } from "./recipe-scraper";
import { processAsset } from "./asset-processing";
import { storeBlob } from "./blob-client";
import { getSessionKeys } from "./auth";
import { getApiBase } from "./config";
import { showPrompt } from "./dialogs";
import { showLoading } from "./spinner";
import { toastSuccess, toastError } from "./toast";
import { importRecipesIntoBook } from "../import-export";
import { getDocMgr } from "../state";
import { selectRecipe } from "../ui/recipes";
import { renderCatalog } from "../sync/push";
import type { Book, BookCatalog, Recipe, RecipeMeta } from "../types";

const MAX_IMAGES = 5;

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

/** Send text to LLM extract endpoint. Returns parsed recipe JSON or null. */
async function llmExtract(text: string): Promise<ScrapedRecipe | null> {
  try {
    const resp = await fetch(`${getApiBase()}/api/proxy/extract`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (resp.status === 501) return null; // LLM not configured
    if (!resp.ok) return null;
    const data = await resp.json();
    return llmResponseToRecipe(data);
  } catch {
    return null;
  }
}

/** Map LLM JSON response to ScrapedRecipe, extracting [IMAGE:] markers from instructions. */
function llmResponseToRecipe(data: any): ScrapedRecipe {
  const ingredients = Array.isArray(data.ingredients)
    ? data.ingredients.map((ing: any) => ({
        quantity: String(ing.quantity ?? ""),
        unit: String(ing.unit ?? ""),
        item: String(ing.item ?? ""),
      }))
    : [];

  const imageUrls: string[] = [];
  let instructions = String(data.instructions ?? "");

  // Collect image URLs from [IMAGE:] markers in instructions
  for (const match of instructions.matchAll(/\[IMAGE:\s*(.+?)\]/g)) {
    const url = match[1]!;
    if (!imageUrls.includes(url)) imageUrls.push(url);
  }

  const tags = Array.isArray(data.tags) ? data.tags.map((t: any) => String(t).toLowerCase()) : [];

  return {
    title: String(data.title ?? "Imported Recipe"),
    description: String(data.description ?? ""),
    servings: Number(data.servings) || 4,
    prepMinutes: Number(data.prepMinutes) || 0,
    cookMinutes: Number(data.cookMinutes) || 0,
    ingredients,
    instructions,
    tags,
    imageUrls,
  };
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
    let rawJsonLd = extractRawJsonLd(html);

    // 2. If no JSON-LD in static HTML, try Browserless rendering
    if (!rawJsonLd) {
      loading.update("Rendering page...");
      const renderResp = await proxyFetch(url, true);
      if (renderResp.ok) {
        html = await renderResp.text();
        rawJsonLd = extractRawJsonLd(html);
      }
    }

    // 3. Try LLM-enhanced extraction
    let recipe: ScrapedRecipe | null = null;

    if (rawJsonLd) {
      // We have JSON-LD — try LLM enhancement first (better ingredient parsing, image placement)
      loading.update("Enhancing recipe data...");
      recipe = await llmExtract(rawJsonLd);
    }

    if (!recipe && !rawJsonLd) {
      // No JSON-LD at all — try LLM on cleaned HTML as last resort
      loading.update("Extracting recipe...");
      const cleaned = cleanHtmlForLlm(html);
      recipe = await llmExtract(cleaned);
    }

    // 4. Fall back to basic JSON-LD extraction (no LLM configured, or LLM failed)
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
      loading.update("Downloading images...");
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
          } catch {
            // Skip failed images
          }
        }
      }
    }

    // 7. Replace [IMAGE: url] markers with blob references
    let instructions = recipe.instructions;
    for (const [imgUrl, checksum] of urlToChecksum) {
      instructions = instructions.replaceAll(`[IMAGE: ${imgUrl}]`, `![](blob:${checksum})`);
    }
    instructions = instructions.replace(/\[IMAGE: [^\]]+\]\n?/g, "");

    // 8. Import into book
    loading.update("Saving recipe...");
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
