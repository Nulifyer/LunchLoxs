/**
 * SyncClient creation and all WebSocket callbacks.
 */

import { log, warn, error } from "./lib/logger";
import {
  deriveKeys, deriveUserId, generateMasterKey, unwrapMasterKey,
  generateIdentityKeypair, wrapPrivateKey, unwrapPrivateKey,
  generateBookKey, importBookKey, encryptBookKeyForUser, decryptBookKeyFromUser,
  generateSigningKeypair, wrapSigningKey, unwrapSigningKey,
  signPayload, verifyPayload,
} from "./lib/crypto";
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
import { pushSnapshot, renderCatalog, updateSyncBadge } from "./sync/push";
import { PushQueue, type SignFn } from "./sync/push-queue";
import { renderBookSelect } from "./ui/books";
import { writeSelfToCatalog, refreshBookNameFromCatalog, rebuildBookIndex } from "./sync/vault-helpers";
import { renderMemberList, getSharingVaultId } from "./ui/share";
import { switchBook } from "./ui/books";
import { resetLoginForm, logout, purgeLocalData } from "./ui/auth";

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
        log("[ws] loaded identity keys from server");
      } else {
        const { publicKey: pub, privateKey: priv } = await generateIdentityKeypair();
        const wp = await wrapPrivateKey(priv, masterKey!); setIdentityKeys(pub, priv);
        client.setIdentity(toBase64(pub), toBase64(wp));
        log("[ws] generated new identity keys");
      }
      // ECDSA signing keys
      if (serverSignPub && serverWrappedSignPriv) {
        const ws = fromBase64(serverWrappedSignPriv); const sk = await unwrapSigningKey(ws, masterKey!);
        setSigningKeys(fromBase64(serverSignPub), sk);
        signingKeyCache.set(userId, fromBase64(serverSignPub));
        log("[ws] loaded signing keys from server");
      } else {
        const { publicKey: spub, privateKey: spriv } = await generateSigningKeypair();
        const ws = await wrapSigningKey(spriv, masterKey!); setSigningKeys(spub, spriv);
        client.setSigningIdentity(toBase64(spub), toBase64(ws));
        signingKeyCache.set(userId, spub);
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
        pq.setDirtyChangeListener(updateSyncBadge);
        setPushQueue(pq);
        log("[ws] push queue started");
      } else {
        getPushQueue()!.updateRefs(dm, client, makeSignFn());
      }

      // Auth succeeded -- switch to app UI
      log("[login] auth success, switching to app view");
      const loginPasswordInput = document.getElementById("login-password") as HTMLInputElement;
      const signupPasswordInput = document.getElementById("signup-password") as HTMLInputElement;
      const signupConfirmInput = document.getElementById("signup-confirm") as HTMLInputElement;
      const loginSection = document.getElementById("login-section") as HTMLElement;
      const appSection = document.getElementById("app-section") as HTMLElement;
      const profileBtn = document.getElementById("profile-btn") as HTMLButtonElement;
      const profileUsername = document.getElementById("profile-username") as HTMLElement;
      loginPasswordInput.value = "";
      signupPasswordInput.value = "";
      signupConfirmInput.value = "";
      loginSection.hidden = true;
      appSection.hidden = false;
      resetLoginForm();
      profileBtn.textContent = username.charAt(0).toUpperCase();
      profileUsername.textContent = username;
      renderBookSelect();

      client.listVaults();
    },
    onVaultList: async (vaultInfos: VaultInfo[]) => {
      log("[ws] vault_list received:", vaultInfos.length, "vaults");
      const privKey = getIdentityPrivateKey(); if (!privKey) { warn("[ws] no identity private key"); return; }
      const previousActiveVaultId = getActiveBook()?.vaultId;
      const newBooks = [];
      clearIndex();
      for (const vi of vaultInfos) {
        try {
          const ek = fromBase64(vi.encryptedVaultKey); const sp = fromBase64(vi.senderPublicKey);
          const raw = await decryptBookKeyFromUser(privKey, sp, ek); const bk = await importBookKey(raw);
          // Preserve local book name if we already have one (avoids flicker during import)
          const existingBook = getBooks().find((b) => b.vaultId === vi.vaultId);
          const name = existingBook?.name ?? vi.vaultId.slice(0, 8);
          newBooks.push({ vaultId: vi.vaultId, name, role: vi.role, encKey: bk });
          log("[ws] decrypted vault key for", vi.vaultId.slice(0, 8), "role:", vi.role);
        } catch (e) { warn("[ws] failed to decrypt vault key for", vi.vaultId.slice(0, 8), e); }
      }
      const failed = vaultInfos.length - newBooks.length;
      if (failed > 0) warn("[ws] vault key summary:", newBooks.length, "ok,", failed, "failed");
      setBooks(newBooks);
      const books = getBooks();
      log("[ws] books updated:", books.length, "books loaded");
      // Load all book catalogs to get names + build search index
      const docMgr = getDocMgr();
      if (docMgr) {
        for (const book of books) {
          const catDocId = `${book.vaultId}/catalog`;
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
          // Listen for catalog changes to update index + name
          catalog.onChange(() => {
            refreshBookNameFromCatalog(catDocId);
            rebuildBookIndex(book.vaultId);
            if (getActiveBook()?.vaultId === book.vaultId) renderCatalog();
          });
        }
      }
      renderBookSelect();
      if (books.length > 0) {
        const target = previousActiveVaultId && books.find((b) => b.vaultId === previousActiveVaultId)
          ? previousActiveVaultId : books[0].vaultId;
        setActiveBook(books.find((b) => b.vaultId === target) ?? books[0]);
        renderBookSelect();
      }
      renderCatalog(); // always render (clears list when 0 books)
      // Request vault members for each vault to populate signing key cache
      const sc = getSyncClient();
      if (sc) {
        for (const book of books) sc.listVaultMembers(book.vaultId);
      }
      // Create any vaults that were created offline, purge orphans, then flush
      const pq = getPushQueue();
      if (pq) {
        // Server-confirmed vaults only (for createPendingVaults -- don't skip vaults the server hasn't seen)
        const serverVaultIds = new Set(vaultInfos.map((vi) => vi.vaultId));
        await pq.createPendingVaults(serverVaultIds);
        // For purge, include locally-created books too (they have pending vaults, not orphans)
        const allVaultIds = new Set(getBooks().map((b) => b.vaultId));
        await pq.purgeOrphanedDirty(allVaultIds);
        pq.flushAllDirty();
      }
    },
    onVaultCreated: (vid) => {
      log("[ws] vault_created:", vid);
      // Only reload vault list if this is a vault we don't already have locally
      // (i.e. created by another device). Local createBook() already added it.
      if (!getBooks().find((b) => b.vaultId === vid)) {
        getSyncClient()?.listVaults();
      }
    },
    onVaultInvited: async (vid) => { log("[ws] vault_invited:", vid); getSyncClient()?.listVaults(); },
    onVaultRemoved: (vid) => {
      log("[ws] vault_removed:", vid);
      removeBookFromIndex(vid);
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
        if (getBooks().length > 0) switchBook(getBooks()[0].vaultId);
      }
      renderBookSelect();
      renderCatalog();
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
    onVaultDeleted: (vid) => { log("[ws] vault_deleted:", vid); removeBookFromIndex(vid); setBooks(getBooks().filter((b) => b.vaultId !== vid)); if (getActiveBook()?.vaultId === vid) { setActiveBook(null); if (getBooks().length > 0) switchBook(getBooks()[0].vaultId); } renderBookSelect(); },
    onOwnershipTransferred: (vid) => { log("[ws] ownership_transferred:", vid); getSyncClient()?.listVaults(); },
    onOwnershipReceived: (vid, fromUserId) => {
      log("[ws] ownership_received:", vid, "from:", fromUserId);
      const book = getBooks().find((b) => b.vaultId === vid);
      if (book) {
        book.role = "owner";
        renderBookSelect();
        renderCatalog();
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
        renderBookSelect();
        renderCatalog();
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
    onPresence: (docId, deviceId, data) => {
      const activeBook = getActiveBook();
      const selectedRecipeId = getSelectedRecipeId();
      if (activeBook && selectedRecipeId && docId === `${activeBook.vaultId}/${selectedRecipeId}`) handlePresence(deviceId, data);
    },
    onPurged: async () => { log("[ws] purged"); await purgeLocalData(); location.reload(); },
    onPasswordChanged: () => { clearWrappedKey(userId); showAlert("Password was changed on another device. Please log in with the new password.", "Password Changed").then(() => logout()); },
    onAck: (docId, seq) => { getPushQueue()?.onAck(docId, seq); },
    onPushError: (docId, message) => { getPushQueue()?.onPushError(docId, message); },
    onRateLimited: (retryAfterMs) => { getPushQueue()?.onRateLimited(retryAfterMs); },
    onStatusChange: (s) => { log("[ws] status:", s); setSyncStatus(s); updateSyncBadge(); },
    onAuthError: (msg) => {
      log("[ws] auth error:", msg);
      let text: string;
      if (msg === "user_already_exists") {
        text = "Username already taken.";
      } else {
        text = "Invalid username or password.";
      }
      const errEl = isSignup ? (document.getElementById("signup-error") as HTMLElement) : (document.getElementById("login-error") as HTMLElement);
      errEl.textContent = text;
      errEl.hidden = false;
      resetLoginForm();
      logout();
    },
  });

  client.setLastSeqGetter(async (docId) => { const s = getDocMgr()?.get(docId); return s ? s.getLastSeq() : 0; });

  return client;
}
