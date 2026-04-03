/**
 * Import a recipe from a URL.
 *
 * Flow: prompt URL → fetch via proxy → extract JSON-LD
 * → (optional) re-fetch with Browserless for JS-rendered pages
 * → download images → import into book.
 */

import { extractRecipeFromHtml } from "./recipe-scraper";
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
  const resp = await fetch(`${getApiBase()}/api/proxy/fetch`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ url, render }),
  });
  return resp;
}

export async function handleImportFromUrl(book: Book): Promise<void> {
  // 1. Prompt for URL
  const url = await showPrompt("Paste a recipe URL:", {
    title: "Import from URL",
    placeholder: "https://www.example.com/recipe/...",
    confirmText: "Import",
  });
  if (!url) return;

  // Validate URL
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
    // 2. Fetch HTML through proxy
    const resp = await proxyFetch(url);
    if (!resp.ok) {
      const status = resp.status;
      if (status === 403 || status === 429) {
        toastError("This site blocked the request. Try a different URL.");
      } else if (status === 400) {
        const text = await resp.text();
        toastError(text || "Invalid URL.");
      } else {
        toastError("Could not reach the URL. Please check it and try again.");
      }
      return;
    }

    const html = await resp.text();

    // 3. Try JSON-LD / microdata extraction on static HTML
    loading.update("Extracting recipe...");
    let recipe = extractRecipeFromHtml(html, url);

    // 4. If no structured data, re-fetch with JS rendering (Browserless)
    if (!recipe || !recipe.title) {
      loading.update("Rendering page...");
      const renderResp = await proxyFetch(url, true);
      if (renderResp.ok) {
        const renderedHtml = await renderResp.text();
        recipe = extractRecipeFromHtml(renderedHtml, url);
      }
    }

    // 5. Check if we got anything
    if (!recipe || !recipe.title) {
      toastError("Could not extract recipe data from this page. Try a different URL.");
      return;
    }

    // 6. Download and process images, build url→blob checksum map
    const imageUrls = recipe.imageUrls;
    const urlToChecksum = new Map<string, string>();

    if (imageUrls.length > 0 && book.encKey) {
      loading.update("Downloading images...");
      const docMgrForBlobs = getDocMgr();
      if (docMgrForBlobs) {
        const db = docMgrForBlobs.getDb();
        for (const imgUrl of imageUrls.slice(0, MAX_IMAGES)) {
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

    // 7. Replace [IMAGE: url] markers in instructions with blob references
    let instructions = recipe.instructions;
    for (const [imgUrl, checksum] of urlToChecksum) {
      instructions = instructions.replaceAll(`[IMAGE: ${imgUrl}]`, `![](blob:${checksum})`);
    }
    // Remove any [IMAGE:] markers that weren't downloaded
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

      // Select the newly imported recipe
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
