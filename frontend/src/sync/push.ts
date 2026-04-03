/**
 * Push / sync helpers -- delegates to PushQueue, plus catalog rendering.
 */

import { renderRecipeList, setRecipeActionsEnabled } from "../views/recipe-list";
import {
  getDocMgr, getActiveBook,
  getSelectedRecipeId, getPushQueue,
} from "../state";
import type { BookCatalog } from "../types";
import { canEditActiveBook } from "../sync/vault-helpers";

// Re-export for backward compatibility during migration
export { updateSyncBadge } from "../ui/sync-status";

/** Mark a doc dirty and schedule a debounced push via the queue. */
export function pushSnapshot(docId: string) {
  getPushQueue()?.markDirty(docId);
}

/** Push a doc immediately, bypassing debounce. */
export async function flushPush(docId: string) {
  await getPushQueue()?.flushNow(docId);
}

// -- Render catalog --
export function catalogDocId(): string {
  const activeBook = getActiveBook();
  return activeBook ? `${activeBook.vaultId}/catalog` : "catalog";
}

let lastRenderedVaultId = "";
let lastRenderedHeads = "";
let lastRenderedSelectedId: string | null = null;

export function renderCatalog(force = false) {
  const docMgr = getDocMgr();
  const activeBook = getActiveBook();
  const selectedRecipeId = getSelectedRecipeId();
  if (!docMgr || !activeBook) {
    if (lastRenderedHeads !== "") {
      lastRenderedHeads = "";
      lastRenderedVaultId = "";
      renderRecipeList([], null);
      const recipeCount = document.getElementById("recipe-count") as HTMLElement;
      if (recipeCount) recipeCount.textContent = "";
    }
    return;
  }
  const catalog = docMgr.get<BookCatalog>(catalogDocId());
  if (!catalog) return;
  const vaultId = activeBook.vaultId;
  const heads = catalog.getHeads().join(",");

  if (!force && heads === lastRenderedHeads && vaultId === lastRenderedVaultId && selectedRecipeId === lastRenderedSelectedId) {
    return;
  }

  lastRenderedHeads = heads;
  lastRenderedVaultId = vaultId;
  lastRenderedSelectedId = selectedRecipeId;
  const doc = catalog.getDoc();
  const recipes = doc.recipes ?? [];
  renderRecipeList(recipes, selectedRecipeId);
  const recipeCount = document.getElementById("recipe-count") as HTMLElement;
  if (recipeCount) recipeCount.textContent = `${recipes.length} recipe${recipes.length !== 1 ? "s" : ""}`;
  setRecipeActionsEnabled(canEditActiveBook());
}
