/**
 * Login / signup / logout UI and logic.
 */

import { log, warn, error } from "../lib/logger";
import { getWsUrl } from "../lib/config";
import {
  deriveKeys, deriveKeysLegacy, deriveUserId, unwrapMasterKey, rewrapMasterKey,
  unwrapPrivateKey, unwrapSigningKey, importBookKey, decrypt,
  signPayload,
} from "../lib/crypto";
import {
  getStoredUsername, getStoredWrappedKey, getDeviceId, clearSession,
  clearIdentityKeys, setIdentityKeys, setSigningKeys, getSigningPrivateKey,
  saveSession,
} from "../lib/auth";
import { DocumentManager } from "../lib/document-manager";
import { clearLocalCache, loadLocalCache, type LocalCache } from "../lib/automerge-store";
import { toBase64, fromBase64 } from "../lib/encoding";
import { clearIndex, indexRecipe } from "../lib/search";
import { isOpen as isDetailOpen, onCatalogChanged } from "../views/recipe-detail";
import {
  getDocMgr, setDocMgr, getSyncClient, setSyncClient,
  setBooks, setActiveBook, getActiveBook, setCurrentUsername, setCurrentUserId,
  getSigningKeyCache, getIsSignup, setIsSignup,
  getPushQueue, setPushQueue, setSyncStatus,
} from "../state";
import { createSyncConnection } from "../connect";
import { deselectRecipe } from "../ui/recipes";
import { renderBookSelect, showBookList, switchBook } from "../ui/books";
import { renderCatalog } from "../sync/push";
import { on as onSyncEvent, emit as syncEmit } from "../sync/sync-events";
import { updateSyncBadge } from "../ui/sync-status";
import { refreshBookNameFromCatalog, rebuildBookIndex } from "../sync/vault-helpers";
import { PushQueue, type SignFn } from "../sync/push-queue";
import type { Book, BookCatalog } from "../types";

function requireSecureContext() {
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    throw new Error("LunchLoxs requires HTTPS for secure E2E encryption.");
  }
}

// DOM refs (grabbed at init time)
let loginSection: HTMLElement;
let appSection: HTMLElement;
let loginForm: HTMLFormElement;
let signupForm: HTMLFormElement;
let loginUsernameInput: HTMLInputElement;
let loginPasswordInput: HTMLInputElement;
let signupUsernameInput: HTMLInputElement;
let signupPasswordInput: HTMLInputElement;
let signupConfirmInput: HTMLInputElement;
let loginError: HTMLElement;
let signupError: HTMLElement;
let loginBtn: HTMLButtonElement;
let tabLogin: HTMLButtonElement;
let tabSignup: HTMLButtonElement;

export function resetLoginForm() {
  loginBtn.disabled = false;
  loginBtn.textContent = "Login";
  (document.getElementById("signup-btn") as HTMLButtonElement).disabled = false;
  (document.getElementById("signup-btn") as HTMLButtonElement).textContent = "Sign Up";
  loginUsernameInput.disabled = false;
  loginPasswordInput.disabled = false;
  signupUsernameInput.disabled = false;
  signupPasswordInput.disabled = false;
  signupConfirmInput.disabled = false;
  tabLogin.disabled = false;
  tabSignup.disabled = false;
}

export async function login(username: string, passphrase: string) {
  const isSignup = getIsSignup();
  log("[login] starting for", username);
  // Disable all login/signup inputs during auth
  loginBtn.disabled = true;
  (document.getElementById("signup-btn") as HTMLButtonElement).disabled = true;
  loginUsernameInput.disabled = true;
  loginPasswordInput.disabled = true;
  signupUsernameInput.disabled = true;
  signupPasswordInput.disabled = true;
  signupConfirmInput.disabled = true;
  tabLogin.disabled = true;
  tabSignup.disabled = true;
  const activeBtn = isSignup ? document.getElementById("signup-btn") as HTMLButtonElement : loginBtn;
  activeBtn.innerHTML = '<span class="btn-spinner"></span> Authenticating...';
  loginError.hidden = true;
  try {
    log("[login] deriving keys...");
    const [derived, userId] = await Promise.all([deriveKeys(username, passphrase), deriveUserId(username)]);
    log("[login] keys derived, userId:", userId.slice(0, 12));
    setCurrentUsername(username);
    setCurrentUserId(userId);
    const localWrapped = getStoredWrappedKey(userId);
    log("[login] localWrapped:", localWrapped ? `${localWrapped.length} bytes` : "null");
    let masterKey: CryptoKey | null = null;
    let wrappedMasterKey: Uint8Array | null = null;
    let legacyDerived: { authHash: string; wrappingKey: CryptoKey } | null = null;
    if (localWrapped) {
      try { masterKey = await unwrapMasterKey(localWrapped, derived.wrappingKey); wrappedMasterKey = localWrapped; log("[login] unwrapped local master key"); }
      catch {
        // Current KDF failed — try legacy (iterations=2) for migration
        log("[login] current KDF unwrap failed, trying legacy...");
        try {
          legacyDerived = await deriveKeysLegacy(username, passphrase);
          masterKey = await unwrapMasterKey(localWrapped, legacyDerived.wrappingKey);
          // Rewrap with current KDF wrapping key and persist locally
          wrappedMasterKey = await rewrapMasterKey(masterKey, derived.wrappingKey);
          log("[login] legacy KDF succeeded, will migrate on connect");
        } catch (e) { error("[login] unwrap failed:", e); throw new Error("Wrong passphrase -- could not decrypt local data."); }
      }
    }

    // Use legacy auth hash for server if migrating, so server accepts our credentials
    const serverDerived = legacyDerived ?? derived;

    // Try offline-first boot for returning users
    if (masterKey) {
      log("[login] initializing DocumentManager...");
      const docMgr = await DocumentManager.init(userId, masterKey);
      setDocMgr(docMgr);
      log("[login] DocumentManager ready");

      const cache = await loadLocalCache(docMgr.getDb(), masterKey);
      if (cache) {
        log("[login] local cache found, booting offline-first");
        saveSession(username, { authHash: derived.authHash, masterKey, wrappedMasterKey: wrappedMasterKey!, userId });
        await localBoot(cache, masterKey, docMgr, username, userId);
        // Connect WebSocket in background for sync
        connectInBackground(username, userId, serverDerived, masterKey, wrappedMasterKey, legacyDerived ? derived : null);
        return;
      }
      log("[login] no local cache, falling through to server boot");
    }

    // No cache (first login or new device) -- must wait for server
    log("[login] creating SyncClient...");
    requireSecureContext();
    const wsUrl = getWsUrl();
    const syncClient = createSyncConnection(wsUrl, userId, serverDerived, masterKey, wrappedMasterKey, username);
    setSyncClient(syncClient);
    syncClient.setLastSeqGetter(async (docId) => { const s = getDocMgr()?.get(docId); return s ? s.getLastSeq() : 0; });
    log("[login] connecting WebSocket to", wsUrl);
    loginBtn.textContent = "Connecting...";
    syncClient.connect();
    // If migrating KDF, change password on server after connection establishes
    if (legacyDerived) {
      const migrateOnConnect = () => {
        const sc = getSyncClient();
        if (sc) {
          log("[login] migrating KDF: updating server auth hash");
          sc.changePassword(legacyDerived!.authHash, derived.authHash, toBase64(wrappedMasterKey!));
        }
      };
      onSyncEvent("auth-success", migrateOnConnect);
    }
  } catch (e: any) {
    error("[login] ERROR:", e);
    const errEl = isSignup ? signupError : loginError;
    errEl.textContent = e.message ?? "Login failed"; errEl.hidden = false;
    resetLoginForm();
  }
}

/** Boot the app from local cache without waiting for the server. */
async function localBoot(
  cache: LocalCache,
  masterKey: CryptoKey,
  docMgr: DocumentManager,
  username: string,
  userId: string,
) {
  // Restore identity keys
  const identityPub = fromBase64(cache.identity.publicKey);
  const identityPriv = await unwrapPrivateKey(fromBase64(cache.identity.wrappedPrivateKey), masterKey);
  setIdentityKeys(identityPub, identityPriv);
  log("[localBoot] identity keys restored");

  // Restore signing keys
  const signingPub = fromBase64(cache.signing.publicKey);
  const signingPriv = await unwrapSigningKey(fromBase64(cache.signing.wrappedPrivateKey), masterKey);
  setSigningKeys(signingPub, signingPriv);
  getSigningKeyCache().set(userId, signingPub);
  log("[localBoot] signing keys restored");

  // Restore books from cached vault keys
  const books: Book[] = [];
  for (const entry of cache.vaults) {
    try {
      const rawKey = await decrypt(fromBase64(entry.wrappedVaultKey), masterKey);
      const encKey = await importBookKey(rawKey);
      books.push({ vaultId: entry.vaultId, name: entry.name, role: entry.role, encKey });
    } catch (e) {
      warn("[localBoot] failed to restore vault key for", entry.vaultId.slice(0, 8), e);
    }
  }
  setBooks(books);
  log("[localBoot] restored", books.length, "books");

  // Switch to app UI
  loginPasswordInput.value = "";
  signupPasswordInput.value = "";
  signupConfirmInput.value = "";
  loginSection.hidden = true;
  appSection.hidden = false;
  resetLoginForm();
  const profileBtn = document.getElementById("profile-btn") as HTMLButtonElement;
  const profileUsername = document.getElementById("profile-username") as HTMLElement;
  profileBtn.textContent = username.charAt(0).toUpperCase();
  profileUsername.textContent = username;
  setSyncStatus("disconnected");
  renderBookSelect();
  log("[localBoot] UI switched to app view");

  // Open catalogs from local IDB and build search index
  clearIndex();
  for (const book of books) {
    const catDocId = `${book.vaultId}/catalog`;
    const catalog = await docMgr.open<BookCatalog>(catDocId, (doc) => { doc.name = book.name; doc.recipes = []; });
    const catDoc = catalog.getDoc();
    if (catDoc.name && catDoc.name !== book.name && catDoc.name !== book.vaultId.slice(0, 8)) {
      book.name = catDoc.name;
    }
    for (const r of catDoc.recipes ?? []) {
      indexRecipe({ recipeId: r.id, vaultId: book.vaultId, bookName: book.name, title: r.title, tags: r.tags });
    }
    catalog.onChange(() => {
      refreshBookNameFromCatalog(catDocId);
      rebuildBookIndex(book.vaultId);
      if (getActiveBook()?.vaultId === book.vaultId) {
        renderCatalog();
        onCatalogChanged();
      }
    });
  }

  // Always start on the book list -- let the user pick
  showBookList();

  // Start PushQueue
  const makeSignFn = (): SignFn => (raw: Uint8Array) => {
    const sk = getSigningPrivateKey();
    return sk ? signPayload(raw, sk) : raw;
  };
  const pq = new PushQueue(docMgr, null as any, docMgr.getDb(), makeSignFn());
  await pq.start();
  pq.setDirtyChangeListener(() => syncEmit("dirty-change", { dirtyCount: pq.dirtyCount(), pushableCount: pq.pushableCount() }));
  setPushQueue(pq);
  updateSyncBadge();
  // Start vector search indexing (background, non-blocking)
  import("../lib/vector-search").then(({ initVectorSearch }) => initVectorSearch(userId)).catch(() => {});
  log("[localBoot] complete");
}

/** Connect WebSocket in background after local boot. */
function connectInBackground(
  username: string,
  userId: string,
  serverDerived: { authHash: string; wrappingKey: CryptoKey },
  masterKey: CryptoKey,
  wrappedMasterKey: Uint8Array | null,
  migrateTo: { authHash: string; wrappingKey: CryptoKey } | null,
) {
  const wsUrl = getWsUrl();
  requireSecureContext();
  log("[login] connecting WebSocket in background to", wsUrl);
  setIsSignup(false); // Background connect is always for existing users
  const syncClient = createSyncConnection(wsUrl, userId, serverDerived, masterKey, wrappedMasterKey, username);
  setSyncClient(syncClient);
  syncClient.setLastSeqGetter(async (docId) => { const s = getDocMgr()?.get(docId); return s ? s.getLastSeq() : 0; });
  // Update PushQueue with the new SyncClient reference
  const pq = getPushQueue();
  if (pq) {
    const sk = getSigningPrivateKey();
    const signFn: SignFn = (raw: Uint8Array) => sk ? signPayload(raw, sk) : raw;
    pq.updateRefs(getDocMgr()!, syncClient, signFn);
  }
  syncClient.connect();
  // If migrating KDF, change password on server after connection establishes
  if (migrateTo) {
    onSyncEvent("auth-success", () => {
      log("[login] migrating KDF: updating server auth hash (background)");
      syncClient.changePassword(serverDerived.authHash, migrateTo.authHash, toBase64(wrappedMasterKey!));
    });
  }
}

export async function logout() {
  log("[logout]");
  if (isDetailOpen()) await deselectRecipe();
  getPushQueue()?.stop(); setPushQueue(null);
  getSyncClient()?.disconnect(); setSyncClient(null);
  // Clear offline cache before closing DocMgr (closeAll closes the IDB connection)
  const dm = getDocMgr();
  if (dm) clearLocalCache(dm.getDb()).catch(() => {});
  await dm?.closeAll(); setDocMgr(null);
  clearSession(); clearIdentityKeys(); clearIndex();
  import("../lib/vector-search").then(({ clearAll }) => clearAll()).catch(() => {});
  setBooks([]); setActiveBook(null);
  setCurrentUsername(""); setCurrentUserId("");
  getSigningKeyCache().clear();
  // Clear stale UI so it doesn't flash for the next user
  clearAppUI();
  setLoginMode(false); // Reset to login tab
  loginSection.hidden = false; appSection.hidden = true;
}

/** Remove all user-specific content from the app section DOM. */
function clearAppUI() {
  const recipeList = document.getElementById("recipe-list");
  if (recipeList) recipeList.innerHTML = "";
  const recipeCount = document.getElementById("recipe-count");
  if (recipeCount) recipeCount.textContent = "";
  const detailView = document.getElementById("detail-view") as HTMLElement;
  if (detailView) detailView.hidden = true;
  const emptyState = document.getElementById("empty-state") as HTMLElement;
  if (emptyState) emptyState.hidden = false;
}

export async function purgeLocalData() {
  await getDocMgr()?.closeAll(); setDocMgr(null);
  if (indexedDB.databases) {
    const dbs = await indexedDB.databases();
    for (const db of dbs) { if (db.name) indexedDB.deleteDatabase(db.name); }
  }
  localStorage.clear();
  if ("caches" in window) {
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
  }
}

function setLoginMode(signup: boolean) {
  setIsSignup(signup);
  tabLogin.classList.toggle("active", !signup);
  tabSignup.classList.toggle("active", signup);
  loginForm.hidden = signup;
  signupForm.hidden = !signup;
  loginError.hidden = true;
  signupError.hidden = true;
}

export function initAuth() {
  loginSection = document.getElementById("login-section") as HTMLElement;
  appSection = document.getElementById("app-section") as HTMLElement;
  loginForm = document.getElementById("login-form") as HTMLFormElement;
  signupForm = document.getElementById("signup-form") as HTMLFormElement;
  loginUsernameInput = document.getElementById("login-username") as HTMLInputElement;
  loginPasswordInput = document.getElementById("login-password") as HTMLInputElement;
  signupUsernameInput = document.getElementById("signup-username") as HTMLInputElement;
  signupPasswordInput = document.getElementById("signup-password") as HTMLInputElement;
  signupConfirmInput = document.getElementById("signup-confirm") as HTMLInputElement;
  loginError = document.getElementById("login-error") as HTMLElement;
  signupError = document.getElementById("signup-error") as HTMLElement;
  loginBtn = document.getElementById("login-btn") as HTMLButtonElement;
  tabLogin = document.getElementById("tab-login") as HTMLButtonElement;
  tabSignup = document.getElementById("tab-signup") as HTMLButtonElement;
  const logoutBtn = document.getElementById("logout-btn") as HTMLButtonElement;

  tabLogin.addEventListener("click", () => setLoginMode(false));
  tabSignup.addEventListener("click", () => setLoginMode(true));

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await login(loginUsernameInput.value.trim(), loginPasswordInput.value);
  });

  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (signupPasswordInput.value !== signupConfirmInput.value) {
      signupError.textContent = "Passwords don't match.";
      signupError.hidden = false;
      return;
    }
    if (signupPasswordInput.value.length < 8) {
      signupError.textContent = "Password must be at least 8 characters.";
      signupError.hidden = false;
      return;
    }
    await login(signupUsernameInput.value.trim(), signupPasswordInput.value);
  });

  logoutBtn.addEventListener("click", logout);

  // Sync event subscribers
  onSyncEvent("auth-success", ({ username }) => {
    if (appSection.hidden) {
      log("[auth] switching to app view");
      loginPasswordInput.value = "";
      signupPasswordInput.value = "";
      signupConfirmInput.value = "";
      loginSection.hidden = true;
      appSection.hidden = false;
      resetLoginForm();
      const profileBtn = document.getElementById("profile-btn") as HTMLButtonElement;
      const profileUsername = document.getElementById("profile-username") as HTMLElement;
      profileBtn.textContent = username.charAt(0).toUpperCase();
      profileUsername.textContent = username;
      renderBookSelect();
    }
  });

  onSyncEvent("auth-error", ({ type }) => {
    let text: string;
    if (type === "user_already_exists") {
      text = "Username already taken.";
    } else if (type === "user_not_found") {
      text = "User not found. Check your username or sign up.";
    } else {
      text = "Invalid username or password.";
    }
    const errEl = getIsSignup() ? signupError : loginError;
    errEl.textContent = text;
    errEl.hidden = false;
    resetLoginForm();
  });

  // Boot
  const savedUsername = getStoredUsername();
  if (savedUsername) loginUsernameInput.value = savedUsername;
  loginSection.hidden = false;
  appSection.hidden = true;
}
