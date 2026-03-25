import { log, warn, error, exportLogs, copyLogs } from "./lib/logger";
log("[boot] index.ts loading");
import {
  deriveKeys, deriveUserId, generateMasterKey, unwrapMasterKey, rewrapMasterKey,
  generateIdentityKeypair, wrapPrivateKey, unwrapPrivateKey,
  generateBookKey, importBookKey, encryptBookKeyForUser, decryptBookKeyFromUser,
  keyFingerprint, generateSigningKeypair, wrapSigningKey, unwrapSigningKey,
  signPayload, verifyPayload,
} from "./lib/crypto";
import {
  getStoredUsername, getStoredWrappedKey, getDeviceId, saveSession, clearSession,
  updateWrappedKey, clearWrappedKey, setIdentityKeys, getIdentityPrivateKey,
  getIdentityPublicKey, clearIdentityKeys, getSessionKeys,
  setSigningKeys, getSigningPrivateKey, getSigningPublicKey,
} from "./lib/auth";
import { DocumentManager } from "./lib/document-manager";
import { SyncClient, type SyncStatus, type VaultInfo } from "./lib/sync-client";
import { initRecipeList, renderRecipeList } from "./views/recipe-list";
import { initRecipeDetail, openRecipe, closeRecipe, handlePresence, isOpen as isDetailOpen } from "./views/recipe-detail";
import { toBase64, fromBase64 } from "./lib/encoding";
import { exportBook, importFromZip, recipeToMarkdown, parseRecipeMarkdown } from "./lib/export";
import { themes, initTheme, applyTheme, getStoredTheme } from "./lib/themes";
import { indexRecipe, indexRecipeContent, removeBookFromIndex, clearIndex, getIndexSize } from "./lib/search";
import { toastSuccess, toastError, toastWarning, toastInfo } from "./lib/toast";
import { showAlert, showConfirm, showPrompt } from "./lib/dialogs";
import { createDropdown } from "./lib/dropdown";
import { openModal, closeModal } from "./lib/modal";
import { showLoading } from "./lib/spinner";
import type { RecipeCatalog, RecipeContent, RecipeMeta, Book } from "./types";

// -- State --
let docMgr: DocumentManager | null = null;
let syncClient: SyncClient | null = null;
let syncStatus: SyncStatus = "disconnected";
let selectedRecipeId: string | null = null;
let books: Book[] = [];
let activeBook: Book | null = null;
let currentUsername: string = "";
let currentUserId: string = "";
/** Cache of userId -> signing public key (raw bytes) for signature verification */
const signingKeyCache = new Map<string, Uint8Array>();

// -- DOM refs --
const loginSection = document.getElementById("login-section") as HTMLElement;
const appSection = document.getElementById("app-section") as HTMLElement;
const appShell = document.getElementById("app-shell") as HTMLElement;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const signupForm = document.getElementById("signup-form") as HTMLFormElement;
const loginUsernameInput = document.getElementById("login-username") as HTMLInputElement;
const loginPasswordInput = document.getElementById("login-password") as HTMLInputElement;
const signupUsernameInput = document.getElementById("signup-username") as HTMLInputElement;
const signupPasswordInput = document.getElementById("signup-password") as HTMLInputElement;
const signupConfirmInput = document.getElementById("signup-confirm") as HTMLInputElement;
const loginError = document.getElementById("login-error") as HTMLElement;
const signupError = document.getElementById("signup-error") as HTMLElement;
const loginBtn = document.getElementById("login-btn") as HTMLButtonElement;
const logoutBtn = document.getElementById("logout-btn") as HTMLButtonElement;
const accountPage = document.getElementById("account-page") as HTMLElement;
const accountBackBtn = document.getElementById("account-back-btn") as HTMLButtonElement;
const accountUsername = document.getElementById("account-username") as HTMLElement;
const accountDeviceId = document.getElementById("account-device-id") as HTMLElement;
const changePwForm = document.getElementById("change-pw-form") as HTMLFormElement;
const pwError = document.getElementById("pw-change-error") as HTMLElement;
const pwSuccess = document.getElementById("pw-change-success") as HTMLElement;
const purgeForm = document.getElementById("purge-form") as HTMLFormElement;
const purgeError = document.getElementById("purge-error") as HTMLElement;
const emptyState = document.getElementById("empty-state") as HTMLElement;
const syncBadge = document.getElementById("sync-badge") as HTMLSpanElement;
const recipeCount = document.getElementById("recipe-count") as HTMLElement;
const addDialog = document.getElementById("add-recipe-dialog") as HTMLDialogElement;
const addForm = document.getElementById("add-recipe-form") as HTMLFormElement;
const editDialog = document.getElementById("edit-recipe-dialog") as HTMLDialogElement;
const editForm = document.getElementById("edit-recipe-form") as HTMLFormElement;
const bookSelect = document.getElementById("book-select") as HTMLSelectElement;
const manageBooksBtn = document.getElementById("manage-books-btn") as HTMLButtonElement;
const manageBooksDialog = document.getElementById("manage-books-dialog") as HTMLDialogElement;
const bookListManage = document.getElementById("book-list-manage") as HTMLUListElement;
const createBookForm = document.getElementById("create-book-form") as HTMLFormElement;
const shareBookDialog = document.getElementById("share-book-dialog") as HTMLDialogElement;
const shareMemberList = document.getElementById("share-member-list") as HTMLUListElement;
const inviteForm = document.getElementById("invite-form") as HTMLFormElement;
const inviteError = document.getElementById("invite-error") as HTMLElement;
const inviteSuccess = document.getElementById("invite-success") as HTMLElement;
const profileBtn = document.getElementById("profile-btn") as HTMLButtonElement;
const profileMenu = document.getElementById("profile-menu") as HTMLElement;
const profileUsername = document.getElementById("profile-username") as HTMLElement;
const menuAccount = document.getElementById("menu-account") as HTMLButtonElement;
const menuTheme = document.getElementById("menu-theme") as HTMLButtonElement;
const menuLogout = document.getElementById("menu-logout") as HTMLButtonElement;
const themeGrid = document.getElementById("theme-grid") as HTMLElement;

// -- Init theme --
initTheme();

// -- Profile menu --
profileBtn.addEventListener("click", (e) => { e.stopPropagation(); profileMenu.classList.toggle("open"); });
menuLogout.addEventListener("click", () => { profileMenu.classList.remove("open"); logout(); });
menuAccount.addEventListener("click", () => { profileMenu.classList.remove("open"); showAccountPage(); });
menuTheme.addEventListener("click", () => { profileMenu.classList.remove("open"); showAccountPage(); });

// -- Theme selector --
function renderThemeGrid() {
  themeGrid.innerHTML = "";
  const current = getStoredTheme();
  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement("button");
    btn.className = `theme-swatch${id === current ? " active" : ""}`;
    btn.textContent = theme.label;
    btn.style.color = theme.text;
    btn.style.background = theme.bg;
    btn.style.borderColor = id === current ? theme.accent : theme.border;
    btn.addEventListener("click", () => { applyTheme(id); renderThemeGrid(); });
    themeGrid.appendChild(btn);
  }
}

// -- Helpers --

/** Get display name for a userId from a specific vault's catalog member map */
function memberName(userId: string, vaultId?: string): string {
  if (!docMgr) return userId.slice(0, 12) + "...";
  const vid = vaultId || activeBook?.vaultId;
  if (!vid) return userId.slice(0, 12) + "...";
  const catalog = docMgr.get<RecipeCatalog>(`${vid}/catalog`);
  const doc = catalog?.getDoc();
  const name = doc?.members ? (doc.members as any)[userId] : undefined;
  return name || userId.slice(0, 12) + "...";
}

/** Write our own username into the catalog member map (only if missing/changed) */
function writeSelfToCatalog(vaultId: string) {
  if (!docMgr || !currentUserId || !currentUsername) return;
  const catalog = docMgr.get<RecipeCatalog>(`${vaultId}/catalog`);
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

/** Background-index all recipe content for deep search. Yields between each recipe. */
let indexAbort: AbortController | null = null;

const searchIndexingEl = document.getElementById("search-indexing") as HTMLElement;

async function backgroundIndexAllContent() {
  if (indexAbort) indexAbort.abort();
  indexAbort = new AbortController();
  const signal = indexAbort.signal;
  searchIndexingEl.hidden = false;

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
    if (signal.aborted || !docMgr) { searchIndexingEl.hidden = true; return; }

    const contentDocId = `${vaultId}/${recipeId}`;
    let needsClose = false;
    let store = docMgr.get<RecipeContent>(contentDocId);
    if (!store) {
      try {
        store = await docMgr.open<RecipeContent>(contentDocId, (d) => {
          d.description = ""; d.ingredients = []; d.instructions = ""; d.imageUrls = []; d.notes = "";
        });
        needsClose = true;
      } catch { continue; }
    }

    if (syncClient) await syncClient.subscribe(contentDocId);

    // Wait for sync to deliver content (one tick)
    await new Promise((r) => setTimeout(r, 100));
    if (signal.aborted) {
      if (needsClose) { if (syncClient) syncClient.unsubscribe(contentDocId); docMgr.close(contentDocId); }
      searchIndexingEl.hidden = true; return;
    }

    const doc = store.getDoc();
    const ingText = (doc.ingredients ?? []).map((i: any) => `${i.quantity} ${i.unit} ${i.item}`).join(" ");
    indexRecipeContent(vaultId, recipeId, ingText, doc.instructions ?? "");
    indexed++;
    searchIndexingEl.style.setProperty("--progress", String(Math.round((indexed / queue.length) * 100)));

    if (needsClose) {
      if (syncClient) syncClient.unsubscribe(contentDocId);
      docMgr.close(contentDocId);
    }

    // Yield to the main thread between recipes
    await new Promise((r) => typeof requestIdleCallback !== "undefined" ? requestIdleCallback(() => r(undefined)) : setTimeout(r, 10));
  }

  searchIndexingEl.hidden = true;
  log("[search] background indexing complete, index size:", getIndexSize());
}

/** Check if current user can edit in the active book */
function canEditActiveBook(): boolean {
  return activeBook?.role === "owner" || activeBook?.role === "editor";
}

/**
 * Rotate the vault key after member removal.
 * Generates a new key, encrypts it for each remaining member, sends to server.
 */
async function rotateVaultKey(vaultId: string): Promise<void> {
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
function rebuildBookIndex(vaultId: string) {
  if (!docMgr) return;
  const book = books.find((b) => b.vaultId === vaultId);
  if (!book) return;
  const catalog = docMgr.get<RecipeCatalog>(`${vaultId}/catalog`);
  if (!catalog) return;
  removeBookFromIndex(vaultId);
  const doc = catalog.getDoc();
  const recipes = doc.recipes ?? [];
  for (const r of recipes) {
    indexRecipe({ recipeId: r.id, vaultId, bookName: book.name, title: r.title, tags: r.tags });
  }
  log("[search] indexed", recipes.length, "recipes for", book.name, "total index:", getIndexSize());
}

/** Update book name from catalog after sync */
function refreshBookNameFromCatalog(docId: string) {
  const vaultId = docId.replace(/\/catalog$/, "");
  const book = books.find((b) => b.vaultId === vaultId);
  if (!book || !docMgr) return;
  const catalog = docMgr.get<RecipeCatalog>(docId);
  if (!catalog) return;
  const catDoc = catalog.getDoc();
  log("[catalog] refresh name for", vaultId.slice(0, 8), "catDoc.name:", catDoc.name, "book.name:", book.name, "recipes:", (catDoc.recipes ?? []).length);
  if (catDoc.name && catDoc.name !== book.name) {
    log("[catalog] updated book name:", catDoc.name);
    book.name = catDoc.name;
    renderBookSelect();
  }
}

// -- Book management --
function renderBookSelect() {
  const addRecipeBtn = document.getElementById("add-recipe-btn") as HTMLButtonElement;
  addRecipeBtn.disabled = !activeBook;
  bookSelect.innerHTML = "";
  const sortedBooks = [...books].sort((a, b) => a.name.localeCompare(b.name));
  for (const book of sortedBooks) {
    const opt = document.createElement("option");
    opt.value = book.vaultId;
    opt.textContent = book.name + (book.role === "owner" ? "" : ` (${book.role})`);
    if (activeBook?.vaultId === book.vaultId) opt.selected = true;
    bookSelect.appendChild(opt);
  }
  if (books.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No books";
    opt.disabled = true;
    bookSelect.appendChild(opt);
  }
}

function switchBook(vaultId: string): Promise<void> {
  log("[switchBook]", vaultId);
  if (selectedRecipeId) deselectRecipe();
  const book = books.find((b) => b.vaultId === vaultId);
  if (!book || !book.encKey) { warn("[switchBook] no book or no key for", vaultId); return Promise.resolve(); }
  activeBook = book;
  renderBookSelect();
  renderCatalog();
  return Promise.resolve();
}

async function createBook(name: string) {
  if (!syncClient || !docMgr) return;
  const privKey = getIdentityPrivateKey();
  const pubKey = getIdentityPublicKey();
  if (!privKey || !pubKey) return;
  const vaultId = crypto.randomUUID();
  log("[createBook]", name, vaultId);
  const { bookKey, bookKeyRaw } = await generateBookKey();
  const encryptedVaultKey = await encryptBookKeyForUser(privKey, pubKey, bookKeyRaw);
  syncClient.createVault(vaultId, toBase64(encryptedVaultKey), toBase64(pubKey));
  const book: Book = { vaultId, name, role: "owner", encKey: bookKey };
  books.push(book);
  renderBookSelect();
  const catDocId = `${vaultId}/catalog`;
  const catalog = await docMgr.open<RecipeCatalog>(catDocId, (doc) => {
    doc.name = name;
    doc.recipes = [];
    doc.members = {} as any;
    (doc.members as any)[currentUserId] = currentUsername;
  });
  // Apply init immediately so the name is set before any imports add recipes
  catalog.ensureInitialized();
  catalog.onChange(() => { refreshBookNameFromCatalog(catDocId); rebuildBookIndex(vaultId); if (activeBook?.vaultId === vaultId) renderCatalog(); });
  pushSnapshot(catDocId);
  if (syncClient) await syncClient.subscribe(catDocId);
  activeBook = book;
  bookSelect.value = vaultId;
  renderCatalog();
}

// -- Debounced push --
const PUSH_DEBOUNCE = 200;
const PUSH_MAX_WAIT = 1500;
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pushFirstChange = new Map<string, number>();

async function flushPush(docId: string) {
  pushTimers.delete(docId);
  pushFirstChange.delete(docId);
  const store = docMgr?.get(docId);
  if (store && syncClient) {
    log("[push]", docId);
    const raw = store.save();
    const sigKey = getSigningPrivateKey();
    const payload = sigKey ? await signPayload(raw, sigKey) : raw;
    syncClient.push(docId, payload);
  }
}

function pushSnapshot(docId: string) {
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
function catalogDocId(): string {
  return activeBook ? `${activeBook.vaultId}/catalog` : "catalog";
}

function renderCatalog() {
  if (!docMgr || !activeBook) return;
  const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
  if (!catalog) return;
  const doc = catalog.getDoc();
  const recipes = doc.recipes ?? [];
  renderRecipeList(recipes, selectedRecipeId);
  recipeCount.textContent = `${recipes.length} recipe${recipes.length !== 1 ? "s" : ""}`;
  (document.getElementById("add-recipe-btn") as HTMLButtonElement).disabled = !canEditActiveBook();
  updateSyncBadge();
}

function updateSyncBadge() {
  syncBadge.className = `sync-badge ${syncStatus}`;
  syncBadge.hidden = false;
  switch (syncStatus) {
    case "connected": syncBadge.textContent = "online"; break;
    case "connecting": syncBadge.textContent = "connecting"; break;
    case "disconnected": syncBadge.textContent = "offline"; break;
  }
}

// -- Recipe selection --
async function selectRecipe(id: string) {
  if (!docMgr || !syncClient || !activeBook) return;
  log("[selectRecipe]", id);
  accountPage.hidden = true;
  selectedRecipeId = id;
  appShell.classList.add("detail-open");
  renderCatalog();
  const contentDocId = `${activeBook.vaultId}/${id}`;
  const contentStore = await docMgr.open<RecipeContent>(contentDocId, (doc) => {
    doc.description = ""; doc.ingredients = []; doc.instructions = ""; doc.imageUrls = []; doc.notes = "";
  });
  await syncClient.subscribe(contentDocId);
  const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
  const meta = catalog?.getDoc()?.recipes?.find((r: any) => r.id === id);
  const title = meta?.title ?? "Untitled";
  const metaText = [
    meta?.servings ? `${meta.servings} servings` : "",
    meta?.prepMinutes ? `${meta.prepMinutes}m prep` : "",
    meta?.cookMinutes ? `${meta.cookMinutes}m cook` : "",
    ...(meta?.tags ?? []),
  ].filter(Boolean).join(" · ");
  openRecipe(contentStore, title, metaText, canEditActiveBook(), meta?.updatedAt);
  // Index content for search
  const content = contentStore.getDoc();
  const ingText = (content.ingredients ?? []).map((i: any) => `${i.quantity} ${i.unit} ${i.item}`).join(" ");
  indexRecipeContent(activeBook.vaultId, id, ingText, content.instructions ?? "");
}

function deselectRecipe() {
  if (selectedRecipeId && syncClient && activeBook) {
    syncClient.unsubscribe(`${activeBook.vaultId}/${selectedRecipeId}`);
    docMgr?.close(`${activeBook.vaultId}/${selectedRecipeId}`);
  }
  selectedRecipeId = null;
  closeRecipe();
  appShell.classList.remove("detail-open");
  renderCatalog();
}

// -- Login --
function resetLoginForm() {
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

async function login(username: string, passphrase: string) {
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
    currentUsername = username;
    currentUserId = userId;
    const localWrapped = getStoredWrappedKey(userId);
    log("[login] localWrapped:", localWrapped ? `${localWrapped.length} bytes` : "null");
    let masterKey: CryptoKey | null = null;
    let wrappedMasterKey: Uint8Array | null = null;
    if (localWrapped) {
      try { masterKey = await unwrapMasterKey(localWrapped, derived.wrappingKey); wrappedMasterKey = localWrapped; log("[login] unwrapped local master key"); }
      catch (e) { error("[login] unwrap failed:", e); throw new Error("Wrong passphrase -- could not decrypt local data."); }
    }
    log("[login] creating SyncClient...");
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${location.hostname}:8000/ws`;
    syncClient = new SyncClient({
      url: wsUrl, userId, deviceId: getDeviceId(), authHash: derived.authHash, isSignup,
      encKey: masterKey as any, wrappedKey: wrappedMasterKey ? toBase64(wrappedMasterKey) : undefined,
      getDocKey: (docId: string) => {
        // Vault-scoped docs (format: vaultId/subDoc) use the vault's book key
        const slashIdx = docId.indexOf("/");
        if (slashIdx > 0) {
          const vaultId = docId.slice(0, slashIdx);
          const book = books.find((b) => b.vaultId === vaultId);
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
        syncClient!.opts.encKey = masterKey!;
        if (wrappedMasterKey && !serverWrappedKey) syncClient!.setKey(toBase64(wrappedMasterKey));
        // ECDH identity keys
        if (serverPubKey && serverWrappedPrivKey) {
          const wp = fromBase64(serverWrappedPrivKey); const pk = await unwrapPrivateKey(wp, masterKey!);
          setIdentityKeys(fromBase64(serverPubKey), pk);
          log("[ws] loaded identity keys from server");
        } else {
          const { publicKey: pub, privateKey: priv } = await generateIdentityKeypair();
          const wp = await wrapPrivateKey(priv, masterKey!); setIdentityKeys(pub, priv);
          syncClient!.setIdentity(toBase64(pub), toBase64(wp));
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
          syncClient!.setSigningIdentity(toBase64(spub), toBase64(ws));
          signingKeyCache.set(userId, spub);
          log("[ws] generated new signing keys");
        }
        if (!docMgr) { docMgr = await DocumentManager.init(userId, masterKey!); log("[ws] docMgr initialized"); }

        // Auth succeeded -- switch to app UI
        log("[login] auth success, switching to app view");
        loginPasswordInput.value = "";
        signupPasswordInput.value = "";
        signupConfirmInput.value = "";
        loginSection.hidden = true;
        appSection.hidden = false;
        resetLoginForm();
        profileBtn.textContent = username.charAt(0).toUpperCase();
        profileUsername.textContent = username;
        renderBookSelect();

        syncClient!.listVaults();
      },
      onVaultList: async (vaultInfos: VaultInfo[]) => {
        log("[ws] vault_list received:", vaultInfos.length, "vaults");
        const privKey = getIdentityPrivateKey(); if (!privKey) { warn("[ws] no identity private key"); return; }
        const previousActiveVaultId = activeBook?.vaultId;
        books = [];
        clearIndex();
        for (const vi of vaultInfos) {
          try {
            const ek = fromBase64(vi.encryptedVaultKey); const sp = fromBase64(vi.senderPublicKey);
            const raw = await decryptBookKeyFromUser(privKey, sp, ek); const bk = await importBookKey(raw);
            books.push({ vaultId: vi.vaultId, name: vi.vaultId.slice(0, 8), role: vi.role, encKey: bk });
            log("[ws] decrypted vault key for", vi.vaultId.slice(0, 8), "role:", vi.role);
          } catch (e) { warn("[ws] failed to decrypt vault key for", vi.vaultId.slice(0, 8), e); }
        }
        // Load all book catalogs to get names + build search index
        if (docMgr) {
          for (const book of books) {
            const catDocId = `${book.vaultId}/catalog`;
            const catalog = await docMgr.open<RecipeCatalog>(catDocId, (doc) => { doc.name = book.name; doc.recipes = []; });
            if (syncClient) await syncClient.subscribe(catDocId);
            const catDoc = catalog.getDoc();
            if (catDoc.name && catDoc.name !== book.name && catDoc.name !== book.vaultId.slice(0, 8)) {
              book.name = catDoc.name;
            }
            // Index recipes for search
            for (const r of catDoc.recipes ?? []) {
              indexRecipe({ recipeId: r.id, vaultId: book.vaultId, bookName: book.name, title: r.title, tags: r.tags });
            }
            // Listen for catalog changes to update index + name
            catalog.onChange(() => {
              refreshBookNameFromCatalog(catDocId);
              rebuildBookIndex(book.vaultId);
              if (activeBook?.vaultId === book.vaultId) renderCatalog();
            });
          }
        }
        renderBookSelect();
        if (books.length > 0) {
          const target = previousActiveVaultId && books.find((b) => b.vaultId === previousActiveVaultId)
            ? previousActiveVaultId : books[0].vaultId;
          activeBook = books.find((b) => b.vaultId === target) ?? books[0];
          renderBookSelect();
          renderCatalog();
        }
        // Request vault members for each vault to populate signing key cache
        if (syncClient) {
          for (const book of books) syncClient.listVaultMembers(book.vaultId);
        }
        // Kick off background content indexing after a short delay
        setTimeout(() => backgroundIndexAllContent(), 2000);
      },
      onVaultCreated: (vid) => { log("[ws] vault_created:", vid); },
      onVaultInvited: async (vid) => { log("[ws] vault_invited:", vid); syncClient?.listVaults(); },
      onVaultRemoved: (vid) => { log("[ws] vault_removed:", vid); removeBookFromIndex(vid); books = books.filter((b) => b.vaultId !== vid); if (activeBook?.vaultId === vid) { activeBook = null; if (books.length > 0) switchBook(books[0].vaultId); } renderBookSelect(); },
      onVaultMembers: (_v, members) => {
        log("[ws] vault_members:", members.length);
        // Cache signing public keys for signature verification
        for (const m of members) {
          if (m.signingPublicKey) signingKeyCache.set(m.userId, fromBase64(m.signingPublicKey));
        }
        renderMemberList(members);
      },
      onVaultDeleted: (vid) => { log("[ws] vault_deleted:", vid); removeBookFromIndex(vid); books = books.filter((b) => b.vaultId !== vid); if (activeBook?.vaultId === vid) { activeBook = null; if (books.length > 0) switchBook(books[0].vaultId); } renderBookSelect(); },
      onOwnershipTransferred: (vid) => { log("[ws] ownership_transferred:", vid); syncClient?.listVaults(); },
      onVaultKeyRotated: (vid) => { log("[ws] vault_key_rotated:", vid); syncClient?.listVaults(); },
      onRoleChanged: (vid) => { log("[ws] role_changed:", vid); syncClient?.listVaults(); },
      onRemoteChange: async (docId, snapshot, seq, senderUserId) => {
        log("[ws] remote_change:", docId, "seq:", seq, "from:", senderUserId?.slice(0, 8));
        const s = docMgr?.get(docId); if (!s) return;
        // Verify signature. During initial sync replay, signing keys may not be cached yet
        // (populated when vault_members response arrives). This is acceptable -- payloads are
        // still encrypted with the vault key, so only members can produce valid ciphertext.
        const senderSignKey = senderUserId ? signingKeyCache.get(senderUserId) ?? null : null;
        const { plaintext, verified } = await verifyPayload(snapshot, senderSignKey);
        if (!verified && senderUserId && signingKeyCache.size > 0) {
          // Only warn if we have some keys cached (initial sync won't have any yet)
          warn("[ws] unverified payload for", docId, "from", senderUserId.slice(0, 8));
        }
        s.merge(plaintext); await s.setLastSeq(seq);
      },
      onCaughtUp: (docId, latestSeq) => {
        log("[ws] caught_up:", docId, "seq:", latestSeq);
        const s = docMgr?.get(docId); if (!s) return;
        s.setLastSeq(latestSeq);
        const didInit = s.ensureInitialized();
        if (docId.endsWith("/catalog")) {
          const vaultId = docId.replace(/\/catalog$/, "");
          refreshBookNameFromCatalog(docId);
          writeSelfToCatalog(vaultId);
          rebuildBookIndex(vaultId);
          if (activeBook?.vaultId === vaultId) renderCatalog();
        }
        // Only push if we actually initialized (new doc) to avoid push loops
        if (didInit) pushSnapshot(docId);
      },
      onPresence: (docId, deviceId, data) => { if (activeBook && selectedRecipeId && docId === `${activeBook.vaultId}/${selectedRecipeId}`) handlePresence(deviceId, data); },
      onPurged: async () => { log("[ws] purged"); await purgeLocalData(); location.reload(); },
      onPasswordChanged: () => { clearWrappedKey(userId); showAlert("Password was changed on another device. Please log in with the new password.", "Password Changed").then(() => logout()); },
      onStatusChange: (s) => { log("[ws] status:", s); syncStatus = s; updateSyncBadge(); },
      onAuthError: (msg) => {
        log("[ws] auth error:", msg);
        let text: string;
        if (msg === "user_already_exists") {
          // Signup-specific: safe to reveal since the user is trying to create
          text = "Username already taken.";
        } else {
          // Login: don't distinguish between wrong password and missing user
          text = "Invalid username or password.";
        }
        const errEl = isSignup ? signupError : loginError;
        errEl.textContent = text;
        errEl.hidden = false;
        resetLoginForm();
        logout();
      },
    });
    syncClient.setLastSeqGetter(async (docId) => { const s = docMgr?.get(docId); return s ? s.getLastSeq() : 0; });
    if (masterKey) {
      log("[login] initializing DocumentManager...");
      docMgr = await DocumentManager.init(userId, masterKey);
      log("[login] DocumentManager ready");
    }
    log("[login] connecting WebSocket to", wsUrl);
    loginBtn.textContent = "Connecting...";
    syncClient.connect();
  } catch (e: any) {
    error("[login] ERROR:", e);
    const errEl = isSignup ? signupError : loginError;
    errEl.textContent = e.message ?? "Login failed"; errEl.hidden = false;
    resetLoginForm();
  }
}

function logout() {
  log("[logout]");
  if (indexAbort) { indexAbort.abort(); indexAbort = null; }
  if (isDetailOpen()) deselectRecipe();
  syncClient?.disconnect(); syncClient = null;
  docMgr?.closeAll(); docMgr = null;
  clearSession(); clearIdentityKeys(); clearIndex();
  books = []; activeBook = null;
  currentUsername = ""; currentUserId = "";
  signingKeyCache.clear();
  loginSection.hidden = false; appSection.hidden = true;
}

async function purgeLocalData() {
  docMgr?.closeAll(); docMgr = null;
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

// -- Event handlers --
// -- Login / Signup tabs --
let isSignup = false;
const tabLogin = document.getElementById("tab-login") as HTMLButtonElement;
const tabSignup = document.getElementById("tab-signup") as HTMLButtonElement;

function setLoginMode(signup: boolean) {
  isSignup = signup;
  tabLogin.classList.toggle("active", !signup);
  tabSignup.classList.toggle("active", signup);
  loginForm.hidden = signup;
  signupForm.hidden = !signup;
  loginError.hidden = true;
  signupError.hidden = true;
}

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

// -- Account page --
function showAccountPage() {
  if (isDetailOpen()) deselectRecipe();
  accountUsername.textContent = getStoredUsername() ?? "";
  accountDeviceId.textContent = getDeviceId();
  emptyState.hidden = true;
  (document.getElementById("recipe-detail") as HTMLElement).hidden = true;
  accountPage.hidden = false;
  appShell.classList.add("detail-open");
  pwError.hidden = true; pwSuccess.hidden = true; purgeError.hidden = true;
  renderThemeGrid();
}

accountBackBtn.addEventListener("click", () => { accountPage.hidden = true; emptyState.hidden = false; appShell.classList.remove("detail-open"); });

changePwForm.addEventListener("submit", async (e) => {
  e.preventDefault(); pwError.hidden = true; pwSuccess.hidden = true;
  const newPw = (document.getElementById("new-pw") as HTMLInputElement).value;
  const confirmPw = (document.getElementById("confirm-pw") as HTMLInputElement).value;
  if (newPw !== confirmPw) { pwError.textContent = "Passwords don't match."; pwError.hidden = false; return; }
  const username = getStoredUsername(); if (!username || !syncClient) return;
  try {
    const [nd, uid] = await Promise.all([deriveKeys(username, newPw), deriveUserId(username)]);
    const session = getSessionKeys(); if (!session) return;
    const nw = await rewrapMasterKey(session.masterKey, nd.wrappingKey);
    updateWrappedKey(uid, nw); syncClient.changePassword(nd.authHash, toBase64(nw));
    pwSuccess.textContent = "Password changed."; pwSuccess.hidden = false; changePwForm.reset();
  } catch (e: any) { pwError.textContent = "Failed: " + (e.message ?? e); pwError.hidden = false; }
});

purgeForm.addEventListener("submit", async (e) => {
  e.preventDefault(); purgeError.hidden = true;
  const ci = (document.getElementById("purge-confirm") as HTMLInputElement).value.trim().toLowerCase();
  const un = (getStoredUsername() ?? "").trim().toLowerCase();
  if (ci !== un) { purgeError.textContent = "Username doesn't match."; purgeError.hidden = false; return; }
  syncClient?.purge();
});

(document.getElementById("purge-local-btn") as HTMLButtonElement).addEventListener("click", async () => {
  const ok = await showConfirm("Clear all local data on this device? You will need to log in again.", { title: "Clear Local Data", confirmText: "Clear", danger: true });
  if (!ok) return;
  await purgeLocalData();
  location.reload();
});

// Debug log export
(document.getElementById("export-logs-btn") as HTMLButtonElement).addEventListener("click", () => exportLogs());
(document.getElementById("copy-logs-btn") as HTMLButtonElement).addEventListener("click", async () => {
  const ok = await copyLogs();
  if (ok) toastSuccess("Logs copied to clipboard."); else toastError("Failed to copy. Try the download button.");
});

// -- Recipe list callbacks --
initRecipeList({
  onSelect: (recipeId: string, vaultId?: string) => {
    // If from cross-book search, switch book first
    if (vaultId && vaultId !== activeBook?.vaultId) {
      switchBook(vaultId).then(() => selectRecipe(recipeId));
    } else {
      selectRecipe(recipeId);
    }
  },
  onAdd: () => {
    if (!activeBook) { toastWarning("Create a book first."); return; }
    if (!canEditActiveBook()) { toastWarning("You don't have edit access to this book."); return; }
    openModal(addDialog);
  },
});

// -- Recipe detail callbacks --
initRecipeDetail({
  onBack: deselectRecipe,
  onPushSnapshot: () => { if (selectedRecipeId && activeBook) pushSnapshot(`${activeBook.vaultId}/${selectedRecipeId}`); },
  onSendPresence: (data) => { if (selectedRecipeId && syncClient && activeBook) syncClient.sendPresence(`${activeBook.vaultId}/${selectedRecipeId}`, data); },
  onEditRecipe: () => {
    if (!selectedRecipeId || !docMgr || !activeBook) return;
    const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
    const recipe = catalog?.getDoc()?.recipes?.find((r: any) => r.id === selectedRecipeId);
    if (!recipe) return;
    (document.getElementById("edit-title") as HTMLInputElement).value = recipe.title;
    (document.getElementById("edit-tags") as HTMLInputElement).value = recipe.tags.join(", ");
    (document.getElementById("edit-servings") as HTMLInputElement).value = String(recipe.servings);
    (document.getElementById("edit-prep") as HTMLInputElement).value = String(recipe.prepMinutes);
    (document.getElementById("edit-cook") as HTMLInputElement).value = String(recipe.cookMinutes);
    openModal(editDialog);
  },
  onDeleteRecipe: async () => {
    if (!selectedRecipeId || !docMgr || !activeBook) return;
    const del = await showConfirm("Delete this recipe? This cannot be undone.", { title: "Delete Recipe", confirmText: "Delete", danger: true });
    if (!del) return;
    const id = selectedRecipeId; deselectRecipe();
    const catalog = docMgr.get<RecipeCatalog>(catalogDocId()); if (!catalog) return;
    catalog.change((doc) => { const idx = doc.recipes.findIndex((r: any) => r.id === id); if (idx !== -1) doc.recipes.splice(idx, 1); });
    pushSnapshot(catalogDocId());
  },
  onExportRecipe: async () => {
    if (!selectedRecipeId || !docMgr || !activeBook) return;
    const ok = await showConfirm("Exported files are not encrypted. Anyone with the file can read this recipe.", { title: "Export Warning", confirmText: "Export" });
    if (!ok) return;
    const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
    const meta = catalog?.getDoc()?.recipes?.find((r: any) => r.id === selectedRecipeId);
    if (!meta) return;
    const contentStore = docMgr.get<RecipeContent>(`${activeBook.vaultId}/${selectedRecipeId}`);
    const content = contentStore?.getDoc() ?? { description: "", ingredients: [], instructions: "", imageUrls: [], notes: "" };
    const md = recipeToMarkdown(meta, content);
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${meta.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toastSuccess("Recipe exported as markdown");
  },
  onCopyToBook: async () => {
    if (!selectedRecipeId || !docMgr || !activeBook || books.length < 2) {
      toastWarning("No other books to copy to.");
      return;
    }
    const otherBooks = books.filter((b) => b.vaultId !== activeBook!.vaultId && (b.role === "owner" || b.role === "editor"));
    if (otherBooks.length === 0) { toastWarning("No books you can edit."); return; }
    // Build a simple picker using showPrompt with book names
    const choices = otherBooks.map((b, i) => `${i + 1}. ${b.name}`).join("\n");
    const pick = await showPrompt(`Copy to which book?\n\n${choices}`, { title: "Copy to Book", placeholder: "Enter number" });
    if (!pick) return;
    const idx = parseInt(pick) - 1;
    if (idx < 0 || idx >= otherBooks.length) { toastError("Invalid selection."); return; }
    const targetBook = otherBooks[idx];
    // Get source recipe
    const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
    const meta = catalog?.getDoc()?.recipes?.find((r: any) => r.id === selectedRecipeId);
    if (!meta) return;
    const srcContent = docMgr.get<RecipeContent>(`${activeBook.vaultId}/${selectedRecipeId}`);
    const content = srcContent?.getDoc() ?? { description: "", ingredients: [], instructions: "", imageUrls: [], notes: "" };
    // Create in target book
    const newId = crypto.randomUUID();
    const targetCatalog = docMgr.get<RecipeCatalog>(`${targetBook.vaultId}/catalog`);
    if (!targetCatalog) { toastWarning("Open the target book first."); return; }
    const now = Date.now();
    targetCatalog.change((doc) => {
      if (!doc.recipes) doc.recipes = [];
      doc.recipes.push({ ...meta, id: newId, createdAt: now, updatedAt: now });
    });
    const contentStore = await docMgr.open<RecipeContent>(`${targetBook.vaultId}/${newId}`, (doc) => {
      doc.description = content.description ?? "";
      doc.ingredients = (content.ingredients ?? []) as any;
      doc.instructions = content.instructions ?? "";
      doc.imageUrls = [];
      doc.notes = content.notes ?? "";
    });
    contentStore.ensureInitialized();
    pushSnapshot(`${targetBook.vaultId}/${newId}`);
    pushSnapshot(`${targetBook.vaultId}/catalog`);
    docMgr.close(`${targetBook.vaultId}/${newId}`);
    toastSuccess(`Copied to "${targetBook.name}"`);
  },
});

// -- Add recipe --
addForm.addEventListener("submit", () => {
  const ti = document.getElementById("new-title") as HTMLInputElement;
  const title = ti.value.trim(); if (!title || !docMgr || !activeBook) return;
  const id = crypto.randomUUID();
  const tags = (document.getElementById("new-tags") as HTMLInputElement).value.split(",").map((t) => t.trim()).filter(Boolean);
  const now = Date.now();
  const catalog = docMgr.get<RecipeCatalog>(catalogDocId()); if (!catalog) return;
  catalog.change((doc) => {
    if (!doc.recipes) doc.recipes = [];
    doc.recipes.push({ id, title, tags, servings: parseInt((document.getElementById("new-servings") as HTMLInputElement).value) || 4, prepMinutes: parseInt((document.getElementById("new-prep") as HTMLInputElement).value) || 0, cookMinutes: parseInt((document.getElementById("new-cook") as HTMLInputElement).value) || 0, createdAt: now, updatedAt: now });
  });
  pushSnapshot(catalogDocId()); selectRecipe(id);
});

// -- Edit recipe --
editForm.addEventListener("submit", () => {
  if (!selectedRecipeId || !docMgr || !activeBook) return;
  const catalog = docMgr.get<RecipeCatalog>(catalogDocId()); if (!catalog) return;
  const title = (document.getElementById("edit-title") as HTMLInputElement).value.trim();
  const tags = (document.getElementById("edit-tags") as HTMLInputElement).value.split(",").map((t) => t.trim()).filter(Boolean);
  const servings = parseInt((document.getElementById("edit-servings") as HTMLInputElement).value) || 4;
  const prepMinutes = parseInt((document.getElementById("edit-prep") as HTMLInputElement).value) || 0;
  const cookMinutes = parseInt((document.getElementById("edit-cook") as HTMLInputElement).value) || 0;
  const rid = selectedRecipeId;
  catalog.change((doc) => { const r = doc.recipes.find((r: any) => r.id === rid); if (!r) return; r.title = title; r.tags = tags; r.servings = servings; r.prepMinutes = prepMinutes; r.cookMinutes = cookMinutes; r.updatedAt = Date.now(); });
  pushSnapshot(catalogDocId());
  (document.getElementById("recipe-title") as HTMLElement).textContent = title;
  (document.getElementById("recipe-meta") as HTMLElement).textContent = [servings ? `${servings} servings` : "", prepMinutes ? `${prepMinutes}m prep` : "", cookMinutes ? `${cookMinutes}m cook` : "", ...tags].filter(Boolean).join(" · ");
});

// Reset all dialog forms on close
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", () => { for (const form of dialog.querySelectorAll("form")) form.reset(); });
}

// -- Book management --
bookSelect.addEventListener("change", () => { const v = bookSelect.value; if (v) switchBook(v); });
manageBooksBtn.addEventListener("click", () => { renderBookManageList(); openModal(manageBooksDialog); });

const selectedBookIds = new Set<string>();
const bulkToolbar = document.getElementById("book-bulk-toolbar") as HTMLElement;
const bulkCount = document.getElementById("book-bulk-count") as HTMLElement;
const dropZone = document.getElementById("book-drop-zone") as HTMLElement;

function updateBulkToolbar() {
  const n = selectedBookIds.size;
  bulkToolbar.hidden = n === 0;
  bulkCount.textContent = `${n} selected`;
}

function renderBookManageList() {
  bookListManage.innerHTML = "";
  selectedBookIds.clear();
  updateBulkToolbar();

  const sorted = [...books].sort((a, b) => a.name.localeCompare(b.name));
  for (const book of sorted) {
    const li = document.createElement("li");

    // Checkbox
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => {
      if (cb.checked) selectedBookIds.add(book.vaultId); else selectedBookIds.delete(book.vaultId);
      updateBulkToolbar();
    });
    li.appendChild(cb);

    // Name
    const nameEl = document.createElement("span");
    nameEl.className = "book-row-name";
    nameEl.textContent = book.name;
    li.appendChild(nameEl);

    // Role badge
    const roleEl = document.createElement("span");
    roleEl.className = "book-row-role";
    roleEl.textContent = book.role;
    li.appendChild(roleEl);

    // Quick action: Share (most used)
    if (book.role === "owner" || book.role === "editor") {
      const shareBtn = document.createElement("button");
      shareBtn.className = "sm";
      shareBtn.textContent = "Share";
      shareBtn.addEventListener("click", () => openShareDialog(book));
      li.appendChild(shareBtn);
    }

    // ... menu for other actions
    const menuItems: Array<{ label: string; action: () => void; danger?: boolean; separator?: boolean }> = [];

    if (book.role === "owner" || book.role === "editor") {
      menuItems.push({
        label: "Rename",
        action: async () => {
          const n = await showPrompt("New name for this book:", { title: "Rename Book", defaultValue: book.name });
          if (!n?.trim() || !docMgr) return;
          book.name = n.trim();
          const c = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`);
          if (c) { c.change((d) => { d.name = n.trim(); }); pushSnapshot(`${book.vaultId}/catalog`); }
          renderBookSelect(); renderBookManageList();
          toastSuccess(`Renamed to "${n.trim()}"`);
        },
      });
    }

    menuItems.push({
      label: "Export",
      action: () => handleExportBook(book),
    });

    if (book.role === "owner" || book.role === "editor") {
      menuItems.push({
        label: "Import",
        action: () => handleImportToBook(book),
      });
    }

    if (book.role === "owner") {
      menuItems.push({
        label: "Delete",
        danger: true,
        separator: true,
        action: async () => {
          const ok = await showConfirm(`Delete "${book.name}"? All recipes will be lost.`, { title: "Delete Book", confirmText: "Delete", danger: true });
          if (!ok) return;
          syncClient?.deleteVault(book.vaultId);
          removeBookFromIndex(book.vaultId);
          books = books.filter((b) => b.vaultId !== book.vaultId);
          if (activeBook?.vaultId === book.vaultId) { activeBook = null; if (books.length > 0) switchBook(books[0].vaultId); }
          renderBookSelect(); renderBookManageList();
          toastSuccess(`Deleted "${book.name}"`);
        },
      });
    }

    li.appendChild(createDropdown(menuItems));
    bookListManage.appendChild(li);
  }
}

// Bulk actions
(document.getElementById("book-bulk-export") as HTMLButtonElement).addEventListener("click", async () => {
  if (selectedBookIds.size === 0) return;
  const ok = await showConfirm(`Export ${selectedBookIds.size} book${selectedBookIds.size !== 1 ? "s" : ""}? Exported files are not encrypted.`, { title: "Export Warning", confirmText: "Export" });
  if (!ok) return;
  try {
    const JSZip = (await import("jszip")).default;
    const { recipeToMarkdown } = await import("./lib/export");
    const zip = new JSZip();
    let totalRecipes = 0;
    for (const vid of selectedBookIds) {
      const book = books.find((b) => b.vaultId === vid);
      if (!book || !docMgr) continue;
      const catalog = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`);
      if (!catalog) continue;
      const recipes = catalog.getDoc().recipes ?? [];
      const folder = zip.folder(book.name)!;

      // Write _book.yaml (matches single-book export format)
      folder.file("_book.yaml", [
        `name: "${book.name.replace(/"/g, '\\"')}"`,
        `exportedAt: "${new Date().toISOString()}"`,
        `format: "recipepwa-v1"`,
        `recipeCount: ${recipes.length}`,
      ].join("\n"));

      // Write recipes with deduped slugs
      const usedNames = new Set<string>();
      for (const meta of recipes) {
        const base = meta.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
        let slug = base; let counter = 1;
        while (usedNames.has(slug)) slug = `${base}-${counter++}`;
        usedNames.add(slug);

        const contentDocId = `${book.vaultId}/${meta.id}`;
        let cs = docMgr.get<RecipeContent>(contentDocId);
        let needsClose = false;
        if (!cs) { try { cs = await docMgr.open<RecipeContent>(contentDocId, (d) => { d.description = ""; d.ingredients = []; d.instructions = ""; d.imageUrls = []; d.notes = ""; }); needsClose = true; } catch { cs = null; } }
        const content = cs?.getDoc() ?? { description: "", ingredients: [], instructions: "", imageUrls: [], notes: "" };
        folder.file(`${slug}.md`, recipeToMarkdown(meta, content));
        if (needsClose) docMgr.close(contentDocId);
        totalRecipes++;
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `recipes-export.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    toastSuccess(`Exported ${totalRecipes} recipes from ${selectedBookIds.size} books`);
  } catch (e: any) { toastError("Export failed: " + (e.message ?? e)); }
});

(document.getElementById("book-bulk-delete") as HTMLButtonElement).addEventListener("click", async () => {
  const owned = [...selectedBookIds].filter((vid) => books.find((b) => b.vaultId === vid)?.role === "owner");
  if (owned.length === 0) { toastWarning("You can only delete books you own."); return; }
  const ok = await showConfirm(`Delete ${owned.length} book${owned.length !== 1 ? "s" : ""}? All recipes will be lost.`, { title: "Delete Books", confirmText: "Delete", danger: true });
  if (!ok) return;
  for (const vid of owned) {
    syncClient?.deleteVault(vid);
    removeBookFromIndex(vid);
    books = books.filter((b) => b.vaultId !== vid);
    if (activeBook?.vaultId === vid) activeBook = null;
  }
  if (!activeBook && books.length > 0) switchBook(books[0].vaultId);
  renderBookSelect(); renderBookManageList();
  toastSuccess(`Deleted ${owned.length} book${owned.length !== 1 ? "s" : ""}`);
});

// Drag-drop import
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => { dropZone.classList.remove("drag-over"); });
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (!docMgr) { toastWarning("Not logged in."); return; }

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  for (const file of Array.from(files)) {
    try {
      if (file.name.endsWith(".zip")) {
        // Zips with folders: create a book per folder
        // Zips with flat .md files only: import into active book
        await handleZipImport(file, activeBook ?? undefined);
      } else if (file.name.endsWith(".md")) {
        // Bare .md files go into the active book
        if (!activeBook || !canEditActiveBook()) { toastWarning("Select an editable book first for .md import."); continue; }
        const text = await file.text();
        const parsed = parseRecipeMarkdown(text);
        if (!parsed) { toastWarning(`Could not parse ${file.name}`); continue; }
        const count = await importRecipesIntoBook(activeBook, [parsed]);
        if (count > 0) toastSuccess(`Imported "${parsed.meta.title ?? "recipe"}" into "${activeBook.name}"`);
      } else {
        toastWarning(`Unsupported file: ${file.name}`);
      }
    } catch (err: any) { toastError(`Failed: ${err.message}`); }
  }
  renderCatalog();
  renderBookManageList();
});

createBookForm.addEventListener("submit", (e) => { e.preventDefault(); const ni = document.getElementById("new-book-name") as HTMLInputElement; const n = ni.value.trim(); if (!n) return; createBook(n); ni.value = ""; closeModal(manageBooksDialog); });

// -- Share dialog --
let sharingBook: Book | null = null;

function openShareDialog(book: Book) {
  sharingBook = book;
  (document.getElementById("share-book-name") as HTMLElement).textContent = book.name;
  inviteError.hidden = true; inviteSuccess.hidden = true;
  shareMemberList.innerHTML = "<li style='font-size:0.8rem;color:var(--subtle)'>Loading...</li>";
  openModal(shareBookDialog); syncClient?.listVaultMembers(book.vaultId);
}

function renderMemberList(members: Array<{ userId: string; role: string; publicKey?: string }>) {
  shareMemberList.innerHTML = "";
  if (members.length === 0) { shareMemberList.innerHTML = "<li style='font-size:0.8rem;color:var(--subtle)'>No members</li>"; return; }
  const myUserId = getSessionKeys()?.userId;
  const isOwner = sharingBook?.role === "owner";
  for (const m of members) {
    const li = document.createElement("li");
    const displayName = memberName(m.userId, sharingBook?.vaultId);
    const isSelf = m.userId === myUserId;
    const info = document.createElement("span");
    info.textContent = `${displayName}${isSelf ? " (you)" : ""} - ${m.role}`;
    li.appendChild(info);
    const actions = document.createElement("span"); actions.style.display = "flex"; actions.style.gap = "0.25rem";
    if (isOwner && !isSelf) {
      if (m.role !== "owner") { const tb = document.createElement("button"); tb.className = "sm"; tb.textContent = "Make Owner"; tb.addEventListener("click", async () => { if (!sharingBook || !syncClient) return; const ok = await showConfirm(`Transfer ownership of "${sharingBook.name}" to ${displayName}? You will become an editor.`, { title: "Transfer Ownership", confirmText: "Transfer", danger: true }); if (!ok) return; try { await syncClient.transferOwnership(sharingBook.vaultId, m.userId); syncClient.listVaultMembers(sharingBook.vaultId); toastSuccess("Ownership transferred"); } catch (e: any) { error("[share] transfer failed:", e); toastError("Transfer failed"); } }); actions.appendChild(tb); }
      if (m.role === "editor") { const db = document.createElement("button"); db.className = "sm"; db.textContent = "Viewer"; db.addEventListener("click", async () => { if (!sharingBook || !syncClient) return; try { await syncClient.changeRole(sharingBook.vaultId, m.userId, "viewer"); syncClient.listVaultMembers(sharingBook.vaultId); } catch (e: any) { error("[share] role change failed:", e); } }); actions.appendChild(db); }
      else if (m.role === "viewer") { const pb = document.createElement("button"); pb.className = "sm"; pb.textContent = "Editor"; pb.addEventListener("click", async () => { if (!sharingBook || !syncClient) return; try { await syncClient.changeRole(sharingBook.vaultId, m.userId, "editor"); syncClient.listVaultMembers(sharingBook.vaultId); } catch (e: any) { error("[share] role change failed:", e); } }); actions.appendChild(pb); }
      const rmb = document.createElement("button"); rmb.className = "sm danger"; rmb.textContent = "Remove";
      rmb.addEventListener("click", async () => {
        if (!sharingBook || !syncClient) return;
        const ok = await showConfirm(`Remove ${displayName} from this book? The vault key will be rotated.`, { title: "Remove Member", confirmText: "Remove", danger: true }); if (!ok) return;
        rmb.disabled = true; rmb.textContent = "Removing...";
        try {
          await syncClient.removeFromVault(sharingBook.vaultId, m.userId);
          log("[share] removal confirmed, rotating vault key");
          await rotateVaultKey(sharingBook.vaultId);
        } catch (e: any) {
          error("[share] removal failed:", e);
        }
        syncClient?.listVaultMembers(sharingBook!.vaultId);
      });
      actions.appendChild(rmb);
    }
    li.appendChild(actions); shareMemberList.appendChild(li);
  }
}

inviteForm.addEventListener("submit", async (e) => {
  e.preventDefault(); inviteError.hidden = true; inviteSuccess.hidden = true;
  if (!sharingBook || !syncClient || !docMgr) return;
  const ti = document.getElementById("invite-username") as HTMLInputElement;
  const tu = ti.value.trim(); if (!tu) return;
  try {
    log("[invite] looking up user:", tu);
    const tuid = await deriveUserId(tu);
    const { publicKey: tpk } = await syncClient.lookupUser(tuid);
    const pk = getIdentityPrivateKey(); const pub = getIdentityPublicKey();
    if (!pk || !pub || !sharingBook.encKey) { inviteError.textContent = "Missing keys."; inviteError.hidden = false; return; }
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", sharingBook.encKey));
    const tpb = fromBase64(tpk); const fp = await keyFingerprint(tpb);
    const enc = await encryptBookKeyForUser(pk, tpb, raw);
    // Default role is viewer
    syncClient.inviteToVault(sharingBook.vaultId, tuid, toBase64(enc), toBase64(pub), "viewer");
    // Write their username into the catalog member map
    const catDocId = `${sharingBook.vaultId}/catalog`;
    const catalog = docMgr.get<RecipeCatalog>(catDocId);
    if (catalog) {
      catalog.change((d) => {
        if (!d.members) d.members = {} as any;
        (d.members as any)[tuid] = tu;
      });
      pushSnapshot(catDocId);
    }
    log("[invite] invited", tu, "as viewer, fingerprint:", fp);
    inviteSuccess.textContent = `Invited ${tu}! Key: ${fp}`; inviteSuccess.hidden = false;
    syncClient.listVaultMembers(sharingBook.vaultId); ti.value = "";
  } catch (e: any) { error("[invite] failed:", e); inviteError.textContent = e.message ?? "Failed"; inviteError.hidden = false; }
});

// -- Export/Import --
async function handleExportBook(book: Book) {
  if (!docMgr) return;
  const catalog = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`);
  if (!catalog) { toastWarning("Open this book first."); return; }
  const recipes = catalog.getDoc().recipes ?? [];
  if (recipes.length === 0) { toastWarning("No recipes to export."); return; }
  const ok = await showConfirm("Exported files are not encrypted. Anyone with the file can read your recipes.", { title: "Export Warning", confirmText: "Export" });
  if (!ok) return;
  try {
    const blob = await exportBook(book.name, book.vaultId, recipes, docMgr);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${book.name}.zip`; a.click(); URL.revokeObjectURL(a.href);
    toastSuccess(`Exported ${recipes.length} recipes`);
  } catch (e: any) { toastError("Export failed: " + (e.message ?? e)); }
}

/** Import parsed recipes into a specific book. Returns count imported. */
async function importRecipesIntoBook(book: Book, recipes: Array<{ meta: Partial<RecipeMeta>; content: Partial<RecipeContent> }>): Promise<number> {
  if (!docMgr) return 0;
  const catalog = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`);
  if (!catalog) return 0;
  let count = 0;
  for (const { meta, content } of recipes) {
    const id = crypto.randomUUID(); const now = Date.now();
    catalog.change((doc) => { if (!doc.recipes) doc.recipes = []; doc.recipes.push({ id, title: meta.title ?? "Imported", tags: meta.tags ?? [], servings: meta.servings ?? 4, prepMinutes: meta.prepMinutes ?? 0, cookMinutes: meta.cookMinutes ?? 0, createdAt: meta.createdAt ?? now, updatedAt: meta.updatedAt ?? now }); });
    const cs = await docMgr.open<RecipeContent>(`${book.vaultId}/${id}`, (d) => { d.description = content.description ?? ""; d.ingredients = (content.ingredients ?? []) as any; d.instructions = content.instructions ?? ""; d.imageUrls = []; d.notes = content.notes ?? ""; });
    cs.ensureInitialized(); pushSnapshot(`${book.vaultId}/${id}`); docMgr.close(`${book.vaultId}/${id}`);
    count++;
  }
  pushSnapshot(`${book.vaultId}/catalog`);
  return count;
}

/**
 * Handle a zip import.
 * - If zip has named books (folders with _book.yaml), create a book per folder.
 * - If zip has folders without _book.yaml, create a book per folder using folder name.
 * - If zip has flat .md files (no folders), import into targetBook if provided, or create one.
 */
async function handleZipImport(file: File, targetBook?: Book): Promise<void> {
  const dismiss = showLoading("Importing recipes...");
  try {
    const importedBooks = await importFromZip(file);
    if (importedBooks.length === 0) { toastWarning("No recipes found in file."); return; }

    let totalImported = 0;

    const allRootLevel = importedBooks.length === 1 && importedBooks[0].name === "";
    if (allRootLevel && targetBook) {
      totalImported = await importRecipesIntoBook(targetBook, importedBooks[0].recipes);
      toastSuccess(`Imported ${totalImported} recipe${totalImported !== 1 ? "s" : ""} into "${targetBook.name}"`);
    } else {
      for (const ib of importedBooks) {
        const bookName = ib.name || file.name.replace(/\.zip$/i, "");
        await createBook(bookName);
        const newBook = books.find((b) => b.name === bookName);
        if (newBook) {
          totalImported += await importRecipesIntoBook(newBook, ib.recipes);
        }
      }
      renderBookSelect();
      toastSuccess(`Imported ${totalImported} recipes into ${importedBooks.length} book${importedBooks.length !== 1 ? "s" : ""}`);
    }
  } finally { dismiss(); }
  renderCatalog();
  renderBookManageList();
}

async function handleImportToBook(book: Book) {
  if (!docMgr || !syncClient) return;
  const input = document.createElement("input"); input.type = "file"; input.accept = ".zip,.md";
  input.addEventListener("change", async () => {
    const file = input.files?.[0]; if (!file) return;
    const dismiss = showLoading("Importing recipes...");
    try {
      if (file.name.endsWith(".md")) {
        const text = await file.text();
        const parsed = parseRecipeMarkdown(text);
        if (!parsed) { toastWarning("Could not parse markdown file."); return; }
        const count = await importRecipesIntoBook(book, [parsed]);
        toastSuccess(`Imported ${count} recipe into "${book.name}"`);
        renderCatalog();
        renderBookManageList();
      } else {
        await handleZipImport(file, book);
      }
    } catch (e: any) { toastError("Import failed: " + (e.message ?? e)); } finally { dismiss(); }
  });
  input.click();
}

// -- Service worker --
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(console.error);
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "update-available") {
      const banner = document.createElement("div"); banner.className = "update-banner";
      banner.textContent = "New version available. ";
      const btn = document.createElement("button"); btn.textContent = "Refresh"; btn.addEventListener("click", () => location.reload());
      banner.appendChild(btn); document.body.prepend(banner);
    }
  });
}

// Dialog close buttons + form method=dialog closes
document.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".dialog-close-btn");
  if (btn) {
    const dialog = btn.closest("dialog") as HTMLDialogElement;
    if (dialog) closeModal(dialog);
  }
});

// Forms with method=dialog close the modal on submit
for (const form of document.querySelectorAll("form[method=dialog]")) {
  form.addEventListener("submit", () => {
    const dialog = form.closest("dialog") as HTMLDialogElement;
    if (dialog) closeModal(dialog);
  });
}

// -- Boot --
const savedUsername = getStoredUsername();
if (savedUsername) loginUsernameInput.value = savedUsername;
loginSection.hidden = false;
appSection.hidden = true;
