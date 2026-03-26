/**
 * Push / sync helpers -- delegates to PushQueue, plus catalog rendering and sync badge.
 */

import { renderRecipeList } from "../views/recipe-list";
import {
  getDocMgr, getActiveBook, getSyncStatus,
  getSelectedRecipeId, getPushQueue,
} from "../state";
import type { RecipeCatalog } from "../types";
import { canEditActiveBook } from "../sync/vault-helpers";

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

export function renderCatalog() {
  const docMgr = getDocMgr();
  const activeBook = getActiveBook();
  const selectedRecipeId = getSelectedRecipeId();
  if (!docMgr || !activeBook) {
    // No active book -- clear the recipe list
    renderRecipeList([], null);
    const recipeCount = document.getElementById("recipe-count") as HTMLElement;
    recipeCount.textContent = "";
    return;
  }
  const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
  if (!catalog) return;
  const doc = catalog.getDoc();
  const recipes = doc.recipes ?? [];
  renderRecipeList(recipes, selectedRecipeId);
  const recipeCount = document.getElementById("recipe-count") as HTMLElement;
  recipeCount.textContent = `${recipes.length} recipe${recipes.length !== 1 ? "s" : ""}`;
  (document.getElementById("add-recipe-btn") as HTMLButtonElement).disabled = !canEditActiveBook();
  updateSyncBadge();
}

export function updateSyncBadge() {
  const syncStatus = getSyncStatus();
  const pushQueue = getPushQueue();
  const syncBadge = document.getElementById("sync-badge") as HTMLSpanElement;
  syncBadge.hidden = false;

  if (syncStatus === "connected") {
    if (pushQueue?.hasDirty()) {
      const count = pushQueue.dirtyCount();
      syncBadge.className = "sync-badge syncing";
      syncBadge.textContent = `syncing (${count})`;
    } else {
      syncBadge.className = "sync-badge connected";
      syncBadge.textContent = "synced";
    }
  } else if (syncStatus === "connecting") {
    syncBadge.className = "sync-badge connecting";
    syncBadge.textContent = "connecting";
  } else {
    syncBadge.className = "sync-badge disconnected";
    syncBadge.textContent = "offline";
  }
}
