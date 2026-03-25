/**
 * Background content indexer -- indexes all recipe content for deep search.
 */

import { log } from "../lib/logger";
import { indexRecipeContent, getIndexSize } from "../lib/search";
import { getDocMgr, getSyncClient, getBooks } from "../state";
import type { RecipeContent, RecipeCatalog } from "../types";

let indexAbort: AbortController | null = null;

export function getIndexAbort(): AbortController | null { return indexAbort; }
export function setIndexAbort(a: AbortController | null) { indexAbort = a; }

export async function backgroundIndexAllContent() {
  if (indexAbort) indexAbort.abort();
  indexAbort = new AbortController();
  const signal = indexAbort.signal;
  const searchIndexingEl = document.getElementById("search-indexing") as HTMLElement;
  searchIndexingEl.hidden = false;

  const docMgr = getDocMgr();
  const syncClient = getSyncClient();
  const books = getBooks();

  const queue: Array<{ vaultId: string; recipeId: string }> = [];
  for (const book of books) {
    if (!docMgr) return;
    const catalog = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`);
    if (!catalog) continue;
    for (const r of (catalog.getDoc().recipes ?? [])) {
      queue.push({ vaultId: book.vaultId, recipeId: r.id });
    }
  }

  log("[search] background indexing", queue.length, "recipes");
  let indexed = 0;

  for (const { vaultId, recipeId } of queue) {
    if (signal.aborted || !getDocMgr()) { searchIndexingEl.hidden = true; return; }

    const contentDocId = `${vaultId}/${recipeId}`;
    let needsClose = false;
    const dm = getDocMgr()!;
    let store = dm.get<RecipeContent>(contentDocId);
    if (!store) {
      try {
        store = await dm.open<RecipeContent>(contentDocId, (d) => {
          d.description = ""; d.ingredients = []; d.instructions = ""; d.imageUrls = []; d.notes = "";
        });
        needsClose = true;
      } catch { continue; }
    }

    if (syncClient) await syncClient.subscribe(contentDocId);

    // Wait for sync to deliver content (one tick)
    await new Promise((r) => setTimeout(r, 100));
    if (signal.aborted) {
      if (needsClose) { if (syncClient) syncClient.unsubscribe(contentDocId); dm.close(contentDocId); }
      searchIndexingEl.hidden = true; return;
    }

    const doc = store.getDoc();
    const ingText = (doc.ingredients ?? []).map((i: any) => `${i.quantity} ${i.unit} ${i.item}`).join(" ");
    indexRecipeContent(vaultId, recipeId, ingText, doc.instructions ?? "");
    indexed++;
    searchIndexingEl.style.setProperty("--progress", String(Math.round((indexed / queue.length) * 100)));

    if (needsClose) {
      if (syncClient) syncClient.unsubscribe(contentDocId);
      dm.close(contentDocId);
    }

    // Yield to the main thread between recipes
    await new Promise((r) => typeof requestIdleCallback !== "undefined" ? requestIdleCallback(() => r(undefined)) : setTimeout(r, 10));
  }

  searchIndexingEl.hidden = true;
  log("[search] background indexing complete, index size:", getIndexSize());
}
