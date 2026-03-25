/**
 * Push / sync helpers -- debounced snapshot pushing, catalog rendering, sync badge.
 */

import { log } from "../lib/logger";
import { getSigningPrivateKey } from "../lib/auth";
import { signPayload } from "../lib/crypto";
import { renderRecipeList } from "../views/recipe-list";
import {
  getDocMgr, getSyncClient, getActiveBook, getSyncStatus,
  getSelectedRecipeId, getBooks,
} from "../state";
import type { RecipeCatalog } from "../types";
import { canEditActiveBook } from "../sync/vault-helpers";

// -- Debounced push --
const PUSH_DEBOUNCE = 200;
const PUSH_MAX_WAIT = 1500;
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pushFirstChange = new Map<string, number>();

export async function flushPush(docId: string) {
  pushTimers.delete(docId);
  pushFirstChange.delete(docId);
  const docMgr = getDocMgr();
  const syncClient = getSyncClient();
  const store = docMgr?.get(docId);
  if (store && syncClient) {
    log("[push]", docId);
    const raw = store.save();
    const sigKey = getSigningPrivateKey();
    const payload = sigKey ? await signPayload(raw, sigKey) : raw;
    syncClient.push(docId, payload);
  }
}

export function pushSnapshot(docId: string) {
  const docMgr = getDocMgr();
  const syncClient = getSyncClient();
  if (!docMgr || !syncClient) return;
  const existing = pushTimers.get(docId);
  if (existing) clearTimeout(existing);

  const now = Date.now();
  if (!pushFirstChange.has(docId)) pushFirstChange.set(docId, now);

  const elapsed = now - pushFirstChange.get(docId)!;
  if (elapsed >= PUSH_MAX_WAIT) {
    // Max wait exceeded -- flush immediately
    flushPush(docId);
  } else {
    // Debounce, but cap the remaining time so we don't exceed max wait
    const delay = Math.min(PUSH_DEBOUNCE, PUSH_MAX_WAIT - elapsed);
    pushTimers.set(docId, setTimeout(() => flushPush(docId), delay));
  }
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
  if (!docMgr || !activeBook) return;
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
  const syncBadge = document.getElementById("sync-badge") as HTMLSpanElement;
  syncBadge.className = `sync-badge ${syncStatus}`;
  syncBadge.hidden = false;
  switch (syncStatus) {
    case "connected": syncBadge.textContent = "online"; break;
    case "connecting": syncBadge.textContent = "connecting"; break;
    case "disconnected": syncBadge.textContent = "offline"; break;
  }
}
