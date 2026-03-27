/**
 * SyncClient creation and all WebSocket callbacks.
 */

import { log, warn, error } from "./lib/logger";
import {
  deriveKeys, deriveUserId, generateMasterKey, unwrapMasterKey,
  generateIdentityKeypair, wrapPrivateKey, unwrapPrivateKey,
  generateBookKey, importBookKey, encryptBookKeyForUser, decryptBookKeyFromUser,
  generateSigningKeypair, wrapSigningKey, unwrapSigningKey,
  signPayload, verifyPayload, encrypt,
} from "./lib/crypto";
import { saveLocalCache, type VaultCacheEntry, type LocalCache } from "./lib/automerge-store";
import {
  getDeviceId, saveSession, clearWrappedKey,
  setIdentityKeys, getIdentityPrivateKey,
  setSigningKeys, getSigningPrivateKey,
  getSessionKeys,
} from "./lib/auth";
import { DocumentManager } from "./lib/document-manager";
import { SyncClient, type VaultInfo } from "./lib/sync-client";
import { toBase64, fromBase64 } from "./lib/encoding";
import { indexRecipe, removeBookFromIndex, clearIndex } from "./lib/search";
import { handlePresence, updateEditPermission, isOpen as isDetailOpen, closeRecipe } from "./views/recipe-detail";
import { showAlert } from "./lib/dialogs";
import type { RecipeCatalog } from "./types";

import {
  getDocMgr, setDocMgr, getSyncClient, setSyncClient,
  getBooks, setBooks, getActiveBook, setActiveBook,
  getCurrentUserId, getCurrentUsername,
  getSigningKeyCache, setSyncStatus, getIsSignup,
  getSelectedRecipeId, setSelectedRecipeId, getPushQueue, setPushQueue,
} from "./state";
import { pushSnapshot, renderCatalog } from "./sync/push";
import { PushQueue, type SignFn } from "./sync/push-queue";
import { writeSelfToCatalog, refreshBookNameFromCatalog, rebuildBookIndex } from "./sync/vault-helpers";
import { renderMemberList, getSharingVaultId } from "./ui/share";
import { switchBook, showBookList } from "./ui/books";
import { logout, purgeLocalData } from "./ui/auth";
import { emit as syncEmit } from "./sync/sync-events";

export function createSyncConnection(
  wsUrl: string,
  userId: string,
  derived: { authHash: string; wrappingKey: CryptoKey },
  masterKeyIn: CryptoKey | null,
  wrappedMasterKeyIn: Uint8Array | null,
  username: string,
): SyncClient {
  let masterKey = masterKeyIn;
  let wrappedMasterKey = wrappedMasterKeyIn;
  const isSignup = getIsSignup();
  const signingKeyCache = getSigningKeyCache();

  // Captured during onConnected for cache persistence in onVaultList
  let cachedIdentity: { publicKey: string; wrappedPrivateKey: string } | null = null;
  let cachedSigning: { publicKey: string; wrappedPrivateKey: string } | null = null;

  const client = new SyncClient({
    url: wsUrl, userId, deviceId: getDeviceId(), authHash: derived.authHash, isSignup,
    encKey: masterKey as any, wrappedKey: wrappedMasterKey ? toBase64(wrappedMasterKey) : undefined,
    getDocKey: (docId: string) => {
      // Vault-scoped docs (format: vaultId/subDoc) use the vault's book key
      const slashIdx = docId.indexOf("/");
      if (slashIdx > 0) {
        const vaultId = docId.slice(0, slashIdx);
        const book = getBooks().find((b) => b.vaultId === vaultId);
        if (book?.encKey) return book.encKey;
      }
      // Personal docs use the master key (set on opts.encKey)
      return null;
    },
    onConnected: async ({ wrappedKey: serverWrappedKey, publicKey: serverPubKey, wrappedPrivateKey: serverWrappedPrivKey, signingPublicKey: serverSignPub, wrappedSigningPrivateKey: serverWrappedSignPriv }) => {
      log("[ws] connected");
      if (!masterKey) {
        if (serverWrappedKey) {
          try { const sb = fromBase64(serverWrappedKey); masterKey = await unwrapMasterKey(sb, derived.wrappingKey); wrappedMasterKey = sb; log("[ws] unwrapped server master key"); }
          catch { throw new Error("Wrong passphrase -- could not decrypt server key."); }
        } else { const g = await generateMasterKey(derived.wrappingKey); masterKey = g.masterKey; wrappedMasterKey = g.wrappedMasterKey; log("[ws] generated new master key"); }
      }
      saveSession(username, { authHash: derived.authHash, masterKey: masterKey!, wrappedMasterKey: wrappedMasterKey!, userId });
      client.opts.encKey = masterKey!;
      if (wrappedMasterKey && !serverWrappedKey) client.setKey(toBase64(wrappedMasterKey));
      // ECDH identity keys
      if (serverPubKey && serverWrappedPrivKey) {
        const wp = fromBase64(serverWrappedPrivKey); const pk = await unwrapPrivateKey(wp, masterKey!);
        setIdentityKeys(fromBase64(serverPubKey), pk);
        cachedIdentity = { publicKey: serverPubKey, wrappedPrivateKey: serverWrappedPrivKey };
        log("[ws] loaded identity keys from server");
      } else {
        const { publicKey: pub, privateKey: priv } = await generateIdentityKeypair();
        const wp = await wrapPrivateKey(priv, masterKey!); setIdentityKeys(pub, priv);
        client.setIdentity(toBase64(pub), toBase64(wp));
        cachedIdentity = { publicKey: toBase64(pub), wrappedPrivateKey: toBase64(wp) };
        log("[ws] generated new identity keys");
      }
      // ECDSA signing keys
      if (serverSignPub && serverWrappedSignPriv) {
        const ws = fromBase64(serverWrappedSignPriv); const sk = await unwrapSigningKey(ws, masterKey!);
        setSigningKeys(fromBase64(serverSignPub), sk);
        signingKeyCache.set(userId, fromBase64(serverSignPub));
        cachedSigning = { publicKey: serverSignPub, wrappedPrivateKey: serverWrappedSignPriv };
        log("[ws] loaded signing keys from server");
      } else {
        const { publicKey: spub, privateKey: spriv } = await generateSigningKeypair();
        const ws = await wrapSigningKey(spriv, masterKey!); setSigningKeys(spub, spriv);
        client.setSigningIdentity(toBase64(spub), toBase64(ws));
        signingKeyCache.set(userId, spub);
        cachedSigning = { publicKey: toBase64(spub), wrappedPrivateKey: toBase64(ws) };
        log("[ws] generated new signing keys");
      }
      if (!getDocMgr()) { setDocMgr(await DocumentManager.init(userId, masterKey!)); log("[ws] docMgr initialized"); }
      // Initialize or update push queue
      const dm = getDocMgr()!;
      const makeSignFn = (): SignFn => (raw: Uint8Array) => {
        const sk = getSigningPrivateKey();
        return sk ? signPayload(raw, sk) : raw;
      };
      if (!getPushQueue()) {
        const pq = new PushQueue(dm, client, dm.getDb(), makeSignFn());
        await pq.start();
        pq.setDirtyChangeListener(() => syncEmit("dirty-change", { dirtyCount: pq.dirtyCount(), pushableCount: pq.pushableCount() }));
        setPushQueue(pq);
        log("[ws] push queue started");
      } else {
        getPushQueue()!.updateRefs(dm, client, makeSignFn());
      }

      // Notify UI of auth success (UI handles login->app transition)
      syncEmit("auth-success", { username });

      client.listVaults();
    },
    onVaultList: async (vaultInfos: VaultInfo[]) => {
      log("[ws] vault_list received:", vaultInfos.length, "vaults");
      const privKey = getIdentityPrivateKey(); if (!privKey) { warn("[ws] no identity private key"); return; }
      const newBooks = [];
      const vaultCacheEntries: VaultCacheEntry[] = [];
      clearIndex();
      for (const vi of vaultInfos) {
        try {
          const ek = fromBase64(vi.encryptedVaultKey); const sp = fromBase64(vi.senderPublicKey);
          const raw = await decryptBookKeyFromUser(privKey, sp, ek); const bk = await importBookKey(raw);
          // Preserve local book name if we already have one (avoids flicker during import)
          const existingBook = getBooks().find((b) => b.vaultId === vi.vaultId);
          const name = existingBook?.name ?? vi.vaultId.slice(0, 8);
          newBooks.push({ vaultId: vi.vaultId, name, role: vi.role, encKey: bk });
          // Wrap raw vault key with master key for offline cache
          const wrappedVaultKey = toBase64(await encrypt(raw, masterKey!));
          vaultCacheEntries.push({ vaultId: vi.vaultId, name, role: vi.role, wrappedVaultKey });
          log("[ws] decrypted vault key for", vi.vaultId.slice(0, 8), "role:", vi.role);
        } catch (e) { warn("[ws] failed to decrypt vault key for", vi.vaultId.slice(0, 8), e); }
      }
      const failed = vaultInfos.length - newBooks.length;
      if (failed > 0) {
        warn("[ws] vault key summary:", newBooks.length, "ok,", failed, "failed");
        import("./lib/toast").then(({ toastWarning }) => {
          toastWarning(`${failed} vault(s) could not be decrypted. You may need to be re-invited.`);
        }).catch(() => {});
      }
      // Reconcile: keep locally-created pending vaults that the server doesn't know about yet
      const serverVaultSet = new Set(newBooks.map((b) => b.vaultId));
      const docMgrCleanup = getDocMgr();
      const { getAllPendingVaults: getPending } = await import("./lib/automerge-store");
      const pendingVaultIds = new Set(
        (docMgrCleanup ? await getPending(docMgrCleanup.getDb()) : []).map((pv) => pv.vaultId)
      );
      for (const oldBook of getBooks()) {
        if (!serverVaultSet.has(oldBook.vaultId)) {
          if (pendingVaultIds.has(oldBook.vaultId)) {
            // This vault was created locally but not yet confirmed by server -- keep it
            log("[ws] keeping pending local vault:", oldBook.vaultId.slice(0, 8));
            newBooks.push(oldBook);
          } else {
            log("[ws] vault removed while offline:", oldBook.vaultId.slice(0, 8));
            const catDocId = `${oldBook.vaultId}/catalog`;
            getSyncClient()?.unsubscribe(catDocId);
            docMgrCleanup?.close(catDocId);
            removeBookFromIndex(oldBook.vaultId);
          }
        }
      }
      setBooks(newBooks);
      const books = getBooks();
      log("[ws] books updated:", books.length, "books loaded");
      // Load all book catalogs to get names + build search index
      const docMgr = getDocMgr();
      if (docMgr) {
        for (const book of books) {
          const catDocId = `${book.vaultId}/catalog`;
          const alreadyOpen = docMgr.isOpen(catDocId);
          const catalog = await docMgr.open<RecipeCatalog>(catDocId, (doc) => { doc.name = book.name; doc.recipes = []; });
          const sc = getSyncClient();
          if (sc) await sc.subscribe(catDocId);
          const catDoc = catalog.getDoc();
          if (catDoc.name && catDoc.name !== book.name && catDoc.name !== book.vaultId.slice(0, 8)) {
            book.name = catDoc.name;
          }
          // Recovery: if catalog has data but name was lost, write whatever name we have
          if (!catDoc.name && (catDoc.recipes?.length ?? 0) > 0 && book.name !== book.vaultId.slice(0, 8)) {
            log("[catalog] recovering missing name for", book.vaultId.slice(0, 8), "->", book.name);
            catalog.change((doc) => { doc.name = book.name; });
          }
          // Index recipes for search
          for (const r of catDoc.recipes ?? []) {
            indexRecipe({ recipeId: r.id, vaultId: book.vaultId, bookName: book.name, title: r.title, tags: r.tags });
          }
          // Register change listener only if this is a new catalog (avoid duplicates from localBoot)
          if (!alreadyOpen) {
            catalog.onChange(() => {
              refreshBookNameFromCatalog(catDocId);
              rebuildBookIndex(book.vaultId);
              if (getActiveBook()?.vaultId === book.vaultId) renderCatalog();
            });
          }
        }
      }
      syncEmit("books-change", books);
      // Request vault members for each vault to populate signing key cache
      const sc = getSyncClient();
      if (sc) {
        for (const book of books) sc.listVaultMembers(book.vaultId);
      }
      // Create any vaults that were created offline, purge orphans, then flush
      const pq = getPushQueue();
      if (pq) {
        // Vault keys changed -- clear deferred no-key state so docs are retried
        pq.onVaultsChanged();
        // Server-confirmed vaults only (for createPendingVaults -- don't skip vaults the server hasn't seen)
        const serverVaultIds = new Set(vaultInfos.map((vi) => vi.vaultId));
        // Tell push queue which vaults are still pending so it skips their docs
        pq.setPendingVaultIds(pendingVaultIds);
        await pq.createPendingVaults(serverVaultIds);
        // Schedule a vault list refresh to catch any vault_created confirmations
        // that were dropped due to send buffer overflow
        if (pendingVaultIds.size > 0) {
          setTimeout(() => { log("[ws] refreshing vault list after pending creations"); getSyncClient()?.listVaults(); }, 3000);
        }
        // For purge, include locally-created books too (they have pending vaults, not orphans)
        const allVaultIds = new Set(getBooks().map((b) => b.vaultId));
        await pq.purgeOrphanedDirty(allVaultIds);
        pq.flushAllDirty();
      }
      // Save offline cache with authoritative server data
      const docMgrForCache = getDocMgr();
      if (docMgrForCache && masterKey && cachedIdentity && cachedSigning) {
        // Update cache entry names from catalog docs (which may have better names)
        for (const entry of vaultCacheEntries) {
          const book = books.find((b) => b.vaultId === entry.vaultId);
          if (book) entry.name = book.name;
        }
        const cache: LocalCache = {
          vaults: vaultCacheEntries,
          identity: cachedIdentity,
          signing: cachedSigning,
        };
        saveLocalCache(docMgrForCache.getDb(), masterKey, cache).catch((e) =>
          warn("[ws] failed to save local cache:", e)
        );
        log("[ws] local cache saved:", vaultCacheEntries.length, "vaults");
      }
      // Start vector search indexing (background, non-blocking)
      import("./lib/vector-search").then(({ initVectorSearch }) => initVectorSearch(userId)).catch(() => {});
    },
    onVaultCreated: async (vid) => {
      log("[ws] vault_created:", vid);
      // Clear pending state so push queue can start pushing docs for this vault
      const dm = getDocMgr();
      if (dm) {
        const { clearPendingVault } = await import("./lib/automerge-store");
        await clearPendingVault(dm.getDb(), vid);
      }
      getPushQueue()?.clearPendingVault(vid);
      // Reload vault list to get server-confirmed keys
      getSyncClient()?.listVaults();
    },
    onVaultInvited: async (vid) => { log("[ws] vault_invited:", vid); getSyncClient()?.listVaults(); },
    onVaultRemoved: (vid) => {
      log("[ws] vault_removed:", vid);
      removeBookFromIndex(vid);
      import("./lib/vector-search").then(({ removeBook }) => removeBook(vid)).catch(() => {});
      const wasActive = getActiveBook()?.vaultId === vid;
      // Close open recipe if it belongs to this vault
      if (wasActive && getSelectedRecipeId()) {
        const recipeDocId = `${vid}/${getSelectedRecipeId()}`;
        getSyncClient()?.unsubscribe(recipeDocId);
        getDocMgr()?.close(recipeDocId);
        setSelectedRecipeId(null);
        closeRecipe();
        const appShell = document.getElementById("app-shell") as HTMLElement;
        appShell.classList.remove("detail-open");
      }
      // Unsubscribe and close the vault's catalog
      const catDocId = `${vid}/catalog`;
      getSyncClient()?.unsubscribe(catDocId);
      getDocMgr()?.close(catDocId);
      // Remove book from state
      setBooks(getBooks().filter((b) => b.vaultId !== vid));
      if (wasActive) {
        setActiveBook(null);
        if (getBooks().length > 0) switchBook(getBooks()[0]!.vaultId); else showBookList();
      }
      syncEmit("books-change", getBooks());
    },
    onVaultMembers: (vaultId, members) => {
      log("[ws] vault_members:", vaultId.slice(0, 8), members.length);
      // Cache signing public keys for signature verification
      for (const m of members) {
        if (m.signingPublicKey) signingKeyCache.set(m.userId, fromBase64(m.signingPublicKey));
      }
      // Only update share dialog if this response is for the vault currently being shared
      if (vaultId === getSharingVaultId()) {
        renderMemberList(members);
      }
    },
    onVaultDeleted: (vid) => { log("[ws] vault_deleted:", vid); removeBookFromIndex(vid); setBooks(getBooks().filter((b) => b.vaultId !== vid)); if (getActiveBook()?.vaultId === vid) { setActiveBook(null); if (getBooks().length > 0) switchBook(getBooks()[0]!.vaultId); else showBookList(); } syncEmit("books-change", getBooks()); },
    onOwnershipTransferred: (vid) => { log("[ws] ownership_transferred:", vid); getSyncClient()?.listVaults(); },
    onOwnershipReceived: (vid, fromUserId) => {
      log("[ws] ownership_received:", vid, "from:", fromUserId);
      const book = getBooks().find((b) => b.vaultId === vid);
      if (book) {
        book.role = "owner";
        syncEmit("books-change", getBooks());
        if (isDetailOpen() && getActiveBook()?.vaultId === vid) {
          updateEditPermission(true);
        }
      }
      // Refresh vault list for authoritative state
      getSyncClient()?.listVaults();
    },
    onVaultKeyRotated: (vid) => { log("[ws] vault_key_rotated:", vid); getSyncClient()?.listVaults(); },
    onRoleChanged: (vid, targetUserId, newRole) => {
      log("[ws] role_changed:", vid, "target:", targetUserId, "newRole:", newRole);
      // Update local book role immediately (don't wait for full listVaults round-trip)
      const book = getBooks().find((b) => b.vaultId === vid);
      const myUserId = getCurrentUserId();
      if (book && (targetUserId === myUserId || !targetUserId) && newRole) {
        book.role = newRole as any;
        syncEmit("books-change", getBooks());
        // Update edit permission on open recipe if it belongs to this vault
        if (isDetailOpen() && getActiveBook()?.vaultId === vid) {
          const editable = newRole === "owner" || newRole === "editor";
          updateEditPermission(editable);
        }
      }
      // Refresh vault list to get authoritative role from server
      getSyncClient()?.listVaults();
    },
    onRemoteChange: async (docId, snapshot, seq, senderUserId) => {
      log("[ws] remote_change:", docId, "seq:", seq, "from:", senderUserId?.slice(0, 8));
      const s = getDocMgr()?.get(docId); if (!s) return;
      const senderSignKey = senderUserId ? signingKeyCache.get(senderUserId) ?? null : null;
      const { plaintext, verified } = await verifyPayload(snapshot, senderSignKey);
      if (!verified && senderUserId && signingKeyCache.size > 0) {
        warn("[ws] unverified payload for", docId, "from", senderUserId.slice(0, 8));
      }
      s.merge(plaintext); await s.setLastSeq(seq);
      // Invalidate vector embedding for changed recipe content docs
      const slashIdx = docId.indexOf("/");
      if (slashIdx > 0 && !docId.endsWith("/catalog")) {
        const vaultId = docId.slice(0, slashIdx);
        const recipeId = docId.slice(slashIdx + 1);
        import("./lib/vector-search").then(({ invalidateRecipe }) => invalidateRecipe(vaultId, recipeId)).catch(() => {});
      }
    },
    onCaughtUp: (docId, latestSeq) => {
      log("[ws] caught_up:", docId, "seq:", latestSeq);
      const s = getDocMgr()?.get(docId); if (!s) return;
      s.setLastSeq(latestSeq);
      // Check if dirty flag is stale (push already reached server before disconnect)
      getPushQueue()?.tryClearDirtyOnCaughtUp(docId);
      const didInit = s.ensureInitialized();
      if (docId.endsWith("/catalog")) {
        const vaultId = docId.replace(/\/catalog$/, "");
        refreshBookNameFromCatalog(docId);
        writeSelfToCatalog(vaultId);
        rebuildBookIndex(vaultId);
        if (getActiveBook()?.vaultId === vaultId) renderCatalog();
      }
      // Only push if we actually initialized (new doc) to avoid push loops
      if (didInit) pushSnapshot(docId);
    },
    onPresence: (docId, deviceId, data, senderUserId) => {
      const activeBook = getActiveBook();
      const selectedRecipeId = getSelectedRecipeId();
      log("[ws] presence received:", docId?.slice(0, 20), "from:", deviceId?.slice(0, 8), "user:", senderUserId?.slice(0, 8), "match:", activeBook && selectedRecipeId && docId === `${activeBook.vaultId}/${selectedRecipeId}`);
      if (activeBook && selectedRecipeId && docId === `${activeBook.vaultId}/${selectedRecipeId}`) handlePresence(deviceId, data, senderUserId);
    },
    onPurged: async () => { log("[ws] purged"); await purgeLocalData(); location.reload(); },
    onPasswordChanged: () => { clearWrappedKey(userId); showAlert("Password was changed on another device. Please log in with the new password.", "Password Changed").then(() => logout()); },
    onAck: (docId, seq) => { getPushQueue()?.onAck(docId, seq); },
    onPushError: (docId, message) => { getPushQueue()?.onPushError(docId, message); },
    onRateLimited: (retryAfterMs) => { getPushQueue()?.onRateLimited(retryAfterMs); },
    onStatusChange: (s) => { log("[ws] status:", s); setSyncStatus(s); syncEmit("status-change", s); },
    onAuthError: (msg) => {
      log("[ws] auth error:", msg);
      const appVisible = !document.getElementById("app-section")!.hidden;
      if (appVisible) {
        warn("[ws] auth error during background reconnect:", msg, "-- staying offline");
        setSyncStatus("disconnected");
        syncEmit("status-change", "disconnected");
        return;
      }
      syncEmit("auth-error", { type: msg, message: msg, isReconnect: false });
    },
  });

  client.setLastSeqGetter(async (docId) => { const s = getDocMgr()?.get(docId); return s ? s.getLastSeq() : 0; });

  return client;
}
