/**
 * Vault crypto helpers -- member name resolution, catalog writes, key rotation, index rebuilding.
 */

import { log, warn } from "../lib/logger";
import { getIdentityPrivateKey, getIdentityPublicKey } from "../lib/auth";
import {
  generateBookKey, importBookKey, encryptBookKeyForUser, decryptBookKeyFromUser,
} from "../lib/crypto";
import { toBase64, fromBase64 } from "../lib/encoding";
import { indexRecipe, removeBookFromIndex, getIndexSize } from "../lib/search";
import {
  getDocMgr, getActiveBook, getBooks, getCurrentUsername, getCurrentUserId,
  getSyncClient,
} from "../state";
import type { BookCatalog } from "../types";

// Forward-declared to avoid circular imports -- these are set by ui/books.ts at init time
let _renderBookSelect: () => void = () => {};
export function setRenderBookSelect(fn: () => void) { _renderBookSelect = fn; }

/** Get display name for a userId from a specific vault's catalog member map */
export function memberName(userId: string, vaultId?: string): string {
  const docMgr = getDocMgr();
  const activeBook = getActiveBook();
  if (!docMgr) return userId.slice(0, 12) + "...";
  const vid = vaultId || activeBook?.vaultId;
  if (!vid) return userId.slice(0, 12) + "...";
  const catalog = docMgr.get<BookCatalog>(`${vid}/catalog`);
  const doc = catalog?.getDoc();
  const name = doc?.members ? (doc.members as any)[userId] : undefined;
  return name || userId.slice(0, 12) + "...";
}

/** Write our own username into the catalog member map (only if missing/changed) */
export function writeSelfToCatalog(vaultId: string) {
  const docMgr = getDocMgr();
  const currentUserId = getCurrentUserId();
  const currentUsername = getCurrentUsername();
  if (!docMgr || !currentUserId || !currentUsername) return;
  const catalog = docMgr.get<BookCatalog>(`${vaultId}/catalog`);
  if (!catalog) return;
  const doc = catalog.getDoc();
  const existing = doc.members ? (doc.members as any)[currentUserId] : undefined;
  if (existing === currentUsername) return;
  log("[catalog] writing self to member map:", currentUsername);
  catalog.change((d) => {
    if (!d.members) d.members = {} as any;
    (d.members as any)[currentUserId] = currentUsername;
  });
  // Don't push here -- let the next regular pushSnapshot handle it to avoid loops
}

/** Check if current user can edit in the active book */
export function canEditActiveBook(): boolean {
  const activeBook = getActiveBook();
  return activeBook?.role === "owner" || activeBook?.role === "editor";
}

/**
 * Rotate the vault key after member removal.
 * Generates a new key, encrypts it for each remaining member, sends to server.
 */
export async function rotateVaultKey(vaultId: string): Promise<void> {
  const syncClient = getSyncClient();
  const books = getBooks();
  if (!syncClient) return;
  const privKey = getIdentityPrivateKey();
  const pubKey = getIdentityPublicKey();
  if (!privKey || !pubKey) { warn("[rotate] no identity keys"); return; }

  log("[rotate] generating new vault key for", vaultId.slice(0, 8));
  const { bookKey, bookKeyRaw } = await generateBookKey();

  // Request member list with public keys, wait for response
  const members = await new Promise<Array<{ userId: string; publicKey?: string }>>((resolve) => {
    const origHandler = syncClient!.opts.onVaultMembers;
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; syncClient!.opts.onVaultMembers = origHandler; resolve([]); }
    }, 5000);
    syncClient!.opts.onVaultMembers = (vid, mems) => {
      // Pass through non-matching responses to original handler
      if (vid !== vaultId) { origHandler?.(vid, mems); return; }
      if (!resolved) { resolved = true; clearTimeout(timer); syncClient!.opts.onVaultMembers = origHandler; resolve(mems); }
    };
    syncClient!.listVaultMembers(vaultId);
  });

  const updates: Array<{ userId: string; encryptedVaultKey: string; senderPublicKey: string }> = [];
  for (const m of members) {
    if (!m.publicKey) { warn("[rotate] member", m.userId.slice(0, 8), "has no public key, skipping"); continue; }
    const memberPub = fromBase64(m.publicKey);
    const encKey = await encryptBookKeyForUser(privKey, memberPub, bookKeyRaw);
    updates.push({ userId: m.userId, encryptedVaultKey: toBase64(encKey), senderPublicKey: toBase64(pubKey) });
  }

  if (updates.length === 0) { warn("[rotate] no members to rotate for"); return; }

  syncClient.rotateVaultKey(vaultId, updates);
  log("[rotate] sent rotation for", updates.length, "members");

  // Update local book key immediately
  const book = books.find((b) => b.vaultId === vaultId);
  if (book) book.encKey = bookKey;
}

/** Rebuild search index for a single book from its catalog */
export function rebuildBookIndex(vaultId: string) {
  const docMgr = getDocMgr();
  const books = getBooks();
  if (!docMgr) return;
  const book = books.find((b) => b.vaultId === vaultId);
  if (!book) return;
  const catalog = docMgr.get<BookCatalog>(`${book.vaultId}/catalog`);
  if (!catalog) return;
  removeBookFromIndex(vaultId);
  const doc = catalog.getDoc();
  const recipes = doc.recipes ?? [];
  for (const r of recipes) {
    indexRecipe({ recipeId: r.id, vaultId, bookName: book.name, title: r.title, tags: r.tags });
  }
  log("[search] indexed", recipes.length, "recipes for", book.name, "total index:", getIndexSize());
  // Re-enqueue for vector embedding (hash check skips unchanged ones)
  import("../lib/vector-search").then(({ enqueueRecipe }) => {
    for (const r of recipes) enqueueRecipe(vaultId, r.id, "normal");
  }).catch(() => {});
}

/** Update book name from catalog after sync */
export function refreshBookNameFromCatalog(docId: string) {
  const books = getBooks();
  const docMgr = getDocMgr();
  const vaultId = docId.replace(/\/catalog$/, "");
  const book = books.find((b) => b.vaultId === vaultId);
  if (!book || !docMgr) return;
  const catalog = docMgr.get<BookCatalog>(docId);
  if (!catalog) return;
  const catDoc = catalog.getDoc();
  log("[catalog] refresh name for", vaultId.slice(0, 8), "catDoc.name:", catDoc.name, "book.name:", book.name, "recipes:", (catDoc.recipes ?? []).length);
  if (catDoc.name && catDoc.name !== book.name) {
    log("[catalog] updated book name:", catDoc.name);
    book.name = catDoc.name;
    _renderBookSelect();
  } else if (!catDoc.name && book.name !== vaultId.slice(0, 8)) {
    // Name missing from doc but we have a real name in memory -- write it back
    log("[catalog] writing missing name:", book.name);
    catalog.change((doc) => { doc.name = book.name; });
  }
}
