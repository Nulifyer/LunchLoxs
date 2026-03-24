console.log("[boot] index.ts loading");
import {
  deriveKeys, deriveUserId, generateMasterKey, unwrapMasterKey, rewrapMasterKey,
  generateIdentityKeypair, wrapPrivateKey, unwrapPrivateKey,
  generateBookKey, importBookKey, encryptBookKeyForUser, decryptBookKeyFromUser,
  keyFingerprint,
} from "./lib/crypto";
import {
  getStoredUsername, getStoredWrappedKey, getDeviceId, saveSession, clearSession,
  updateWrappedKey, clearWrappedKey, setIdentityKeys, getIdentityPrivateKey,
  getIdentityPublicKey, clearIdentityKeys, getSessionKeys,
} from "./lib/auth";
import { DocumentManager } from "./lib/document-manager";
import { SyncClient, type SyncStatus, type VaultInfo } from "./lib/sync-client";
import { initRecipeList, renderRecipeList } from "./views/recipe-list";
import { initRecipeDetail, openRecipe, closeRecipe, handlePresence, isOpen as isDetailOpen } from "./views/recipe-detail";
import { toBase64, fromBase64 } from "./lib/encoding";
import { exportBook, importFromZip } from "./lib/export";
import { themes, initTheme, applyTheme, getStoredTheme } from "./lib/themes";
import type { RecipeCatalog, RecipeContent, RecipeMeta, Book } from "./types";

// -- State --
let docMgr: DocumentManager | null = null;
let syncClient: SyncClient | null = null;
let syncStatus: SyncStatus = "disconnected";
let selectedRecipeId: string | null = null;
let books: Book[] = [];
let activeBook: Book | null = null;

// -- DOM refs --
const loginSection = document.getElementById("login-section") as HTMLElement;
const appSection = document.getElementById("app-section") as HTMLElement;
const appShell = document.getElementById("app-shell") as HTMLElement;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const usernameInput = document.getElementById("username-input") as HTMLInputElement;
const passphraseInput = document.getElementById("passphrase-input") as HTMLInputElement;
const loginError = document.getElementById("login-error") as HTMLElement;
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

// Topbar
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
profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  profileMenu.classList.toggle("open");
});

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
    btn.addEventListener("click", () => {
      applyTheme(id);
      renderThemeGrid();
    });
    themeGrid.appendChild(btn);
  }
}

// -- Book management --
function renderBookSelect() {
  const addRecipeBtn = document.getElementById("add-recipe-btn") as HTMLButtonElement;
  addRecipeBtn.disabled = !activeBook;

  bookSelect.innerHTML = "";
  for (const book of books) {
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

async function switchBook(vaultId: string) {
  if (selectedRecipeId) deselectRecipe();
  if (activeBook && syncClient) {
    syncClient.unsubscribe(`${activeBook.vaultId}/catalog`);
    docMgr?.close(`${activeBook.vaultId}/catalog`);
  }
  const book = books.find((b) => b.vaultId === vaultId);
  if (!book || !book.encKey) return;
  activeBook = book;
  if (docMgr) {
    const catalogDocId = `${vaultId}/catalog`;
    const catalog = await docMgr.open<RecipeCatalog>(catalogDocId, (doc) => { doc.name = book.name; doc.recipes = []; });
    const catDoc = catalog.getDoc();
    if (catDoc.name) book.name = catDoc.name;
    catalog.onChange(() => renderCatalog());
    if (syncClient) await syncClient.subscribe(catalogDocId);
  }
  renderBookSelect();
  renderCatalog();
}

async function createBook(name: string) {
  if (!syncClient || !docMgr) return;
  const privKey = getIdentityPrivateKey();
  const pubKey = getIdentityPublicKey();
  if (!privKey || !pubKey) return;
  const vaultId = crypto.randomUUID();
  const { bookKey, bookKeyRaw } = await generateBookKey();
  const encryptedVaultKey = await encryptBookKeyForUser(privKey, pubKey, bookKeyRaw);
  syncClient.createVault(vaultId, toBase64(encryptedVaultKey), toBase64(pubKey));
  const book: Book = { vaultId, name, role: "owner", encKey: bookKey };
  books.push(book);
  renderBookSelect();
  const catalogDocId = `${vaultId}/catalog`;
  const catalog = await docMgr.open<RecipeCatalog>(catalogDocId, (doc) => { doc.name = name; doc.recipes = []; });
  catalog.onChange(() => renderCatalog());
  pushSnapshot(catalogDocId);
  if (syncClient) await syncClient.subscribe(catalogDocId);
  activeBook = book;
  bookSelect.value = vaultId;
  renderCatalog();
}

// -- Debounced push --
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
function pushSnapshot(docId: string) {
  if (!docMgr || !syncClient) return;
  const existing = pushTimers.get(docId);
  if (existing) clearTimeout(existing);
  pushTimers.set(docId, setTimeout(() => {
    pushTimers.delete(docId);
    const store = docMgr?.get(docId);
    if (store && syncClient) syncClient.push(docId, store.save());
  }, 200));
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
  (document.getElementById("add-recipe-btn") as HTMLButtonElement).disabled = false;
  updateSyncBadge();
}

function updateSyncBadge() {
  syncBadge.textContent = syncStatus;
  syncBadge.className = `sync-badge ${syncStatus}`;
  syncBadge.hidden = syncStatus === "connected";
}

// -- Recipe selection --
async function selectRecipe(id: string) {
  if (!docMgr || !syncClient || !activeBook) return;
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
  openRecipe(contentStore, title, metaText);
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
async function login(username: string, passphrase: string) {
  console.log("[login] starting login for", username);
  loginBtn.disabled = true;
  loginBtn.textContent = "Deriving keys...";
  loginError.hidden = true;
  try {
    console.log("[login] deriving keys...");
    const [derived, userId] = await Promise.all([deriveKeys(username, passphrase), deriveUserId(username)]);
    console.log("[login] keys derived, userId:", userId.slice(0, 12));
    const localWrapped = getStoredWrappedKey(userId);
    console.log("[login] localWrapped:", localWrapped ? `${localWrapped.length} bytes` : "null");
    let masterKey: CryptoKey | null = null;
    let wrappedMasterKey: Uint8Array | null = null;
    if (localWrapped) {
      try { masterKey = await unwrapMasterKey(localWrapped, derived.wrappingKey); wrappedMasterKey = localWrapped; console.log("[login] unwrapped local master key"); }
      catch (e) { console.error("[login] unwrap failed:", e); throw new Error("Wrong passphrase -- could not decrypt local data."); }
    }
    console.log("[login] creating SyncClient...");
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${location.hostname}:8000/ws`;
    syncClient = new SyncClient({
      url: wsUrl, userId, deviceId: getDeviceId(), authHash: derived.authHash,
      encKey: masterKey as any, wrappedKey: wrappedMasterKey ? toBase64(wrappedMasterKey) : undefined,
      onConnected: async ({ wrappedKey: serverWrappedKey, publicKey: serverPubKey, wrappedPrivateKey: serverWrappedPrivKey }) => {
        if (!masterKey) {
          if (serverWrappedKey) {
            try { const sb = fromBase64(serverWrappedKey); masterKey = await unwrapMasterKey(sb, derived.wrappingKey); wrappedMasterKey = sb; }
            catch { throw new Error("Wrong passphrase -- could not decrypt server key."); }
          } else { const g = await generateMasterKey(derived.wrappingKey); masterKey = g.masterKey; wrappedMasterKey = g.wrappedMasterKey; }
        }
        saveSession(username, { authHash: derived.authHash, masterKey: masterKey!, wrappedMasterKey: wrappedMasterKey!, userId });
        syncClient!.opts.encKey = masterKey!;
        if (wrappedMasterKey && !serverWrappedKey) syncClient!.setKey(toBase64(wrappedMasterKey));
        if (serverPubKey && serverWrappedPrivKey) {
          const wp = fromBase64(serverWrappedPrivKey); const pk = await unwrapPrivateKey(wp, masterKey!);
          setIdentityKeys(fromBase64(serverPubKey), pk);
        } else {
          const { publicKey: pub, privateKey: priv } = await generateIdentityKeypair();
          const wp = await wrapPrivateKey(priv, masterKey!); setIdentityKeys(pub, priv);
          syncClient!.setIdentity(toBase64(pub), toBase64(wp));
        }
        if (!docMgr) docMgr = await DocumentManager.init(userId, masterKey!);
        syncClient!.listVaults();
      },
      onVaultList: async (vaultInfos: VaultInfo[]) => {
        const privKey = getIdentityPrivateKey(); if (!privKey) return;
        books = [];
        for (const vi of vaultInfos) {
          try {
            const ek = fromBase64(vi.encryptedVaultKey); const sp = fromBase64(vi.senderPublicKey);
            const raw = await decryptBookKeyFromUser(privKey, sp, ek); const bk = await importBookKey(raw);
            books.push({ vaultId: vi.vaultId, name: vi.vaultId.slice(0, 8), role: vi.role, encKey: bk });
          } catch (e) { console.warn(`Failed to decrypt book key for vault ${vi.vaultId}:`, e); }
        }
        renderBookSelect();
        if (books.length > 0 && !activeBook) await switchBook(books[0].vaultId);
      },
      onVaultCreated: () => {},
      onVaultInvited: async () => { syncClient?.listVaults(); },
      onVaultRemoved: (vid) => { books = books.filter((b) => b.vaultId !== vid); if (activeBook?.vaultId === vid) { activeBook = null; if (books.length > 0) switchBook(books[0].vaultId); } renderBookSelect(); },
      onVaultMembers: (_v, members) => { renderMemberList(members); },
      onVaultDeleted: (vid) => { books = books.filter((b) => b.vaultId !== vid); if (activeBook?.vaultId === vid) { activeBook = null; if (books.length > 0) switchBook(books[0].vaultId); } renderBookSelect(); },
      onOwnershipTransferred: () => { syncClient?.listVaults(); },
      onRoleChanged: () => { syncClient?.listVaults(); },
      onRemoteChange: async (docId, snapshot, seq) => { const s = docMgr?.get(docId); if (!s) return; s.merge(snapshot); await s.setLastSeq(seq); },
      onCaughtUp: (docId, latestSeq) => { const s = docMgr?.get(docId); if (!s) return; s.setLastSeq(latestSeq); s.ensureInitialized(); if (docId.endsWith("/catalog")) renderCatalog(); pushSnapshot(docId); },
      onPresence: (docId, deviceId, data) => { if (activeBook && selectedRecipeId && docId === `${activeBook.vaultId}/${selectedRecipeId}`) handlePresence(deviceId, data); },
      onPurged: async () => { await purgeLocalData(); location.reload(); },
      onPasswordChanged: () => { clearWrappedKey(userId); alert("Password changed on another device. Please log in again."); logout(); },
      onStatusChange: (s) => { syncStatus = s; updateSyncBadge(); },
    });
    syncClient.setLastSeqGetter(async (docId) => { const s = docMgr?.get(docId); return s ? s.getLastSeq() : 0; });
    if (masterKey) {
      console.log("[login] initializing DocumentManager...");
      docMgr = await DocumentManager.init(userId, masterKey);
      console.log("[login] DocumentManager ready");
    }
    console.log("[login] connecting WebSocket to", wsUrl);
    syncClient.connect();
    console.log("[login] switching to app view");
    passphraseInput.value = "";
    loginSection.hidden = true;
    appSection.hidden = false;
    profileBtn.textContent = username.charAt(0).toUpperCase();
    profileUsername.textContent = username;
    renderBookSelect();
  } catch (e: any) {
    console.error("[login] ERROR:", e);
    loginError.textContent = e.message ?? "Login failed"; loginError.hidden = false;
  } finally {
    loginBtn.disabled = false; loginBtn.textContent = "Login / Sign Up";
  }
}

function logout() {
  if (isDetailOpen()) deselectRecipe();
  syncClient?.disconnect(); syncClient = null;
  docMgr?.closeAll(); docMgr = null;
  clearSession(); clearIdentityKeys();
  books = []; activeBook = null;
  loginSection.hidden = false; appSection.hidden = true;
}

/** Wipe all local data: localStorage, IndexedDB, caches. */
async function purgeLocalData() {
  // Close open connections
  docMgr?.closeAll(); docMgr = null;
  // Delete all IndexedDB databases
  if (indexedDB.databases) {
    const dbs = await indexedDB.databases();
    for (const db of dbs) { if (db.name) indexedDB.deleteDatabase(db.name); }
  }
  // Clear all localStorage
  localStorage.clear();
  // Clear all caches
  if ("caches" in window) {
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
  }
}

// -- Event handlers --
loginForm.addEventListener("submit", async (e) => { e.preventDefault(); await login(usernameInput.value.trim(), passphraseInput.value); });
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
  if (newPw !== confirmPw) { pwError.textContent = "Passphrases don't match."; pwError.hidden = false; return; }
  const username = getStoredUsername(); if (!username || !syncClient) return;
  try {
    const [nd, uid] = await Promise.all([deriveKeys(username, newPw), deriveUserId(username)]);
    const session = getSessionKeys(); if (!session) return;
    const nw = await rewrapMasterKey(session.masterKey, nd.wrappingKey);
    updateWrappedKey(uid, nw); syncClient.changePassword(nd.authHash, toBase64(nw));
    pwSuccess.textContent = "Passphrase changed."; pwSuccess.hidden = false; changePwForm.reset();
  } catch (e: any) { pwError.textContent = "Failed: " + (e.message ?? e); pwError.hidden = false; }
});

purgeForm.addEventListener("submit", async (e) => {
  e.preventDefault(); purgeError.hidden = true;
  const ci = (document.getElementById("purge-confirm") as HTMLInputElement).value.trim().toLowerCase();
  const un = (getStoredUsername() ?? "").trim().toLowerCase();
  if (ci !== un) { purgeError.textContent = "Username doesn't match."; purgeError.hidden = false; return; }
  syncClient?.purge();
});

// Clear local data only (this device)
(document.getElementById("purge-local-btn") as HTMLButtonElement).addEventListener("click", async () => {
  if (!confirm("Clear all local data on this device? You will need to log in again.")) return;
  await purgeLocalData();
  location.reload();
});

// -- Recipe list callbacks --
initRecipeList({
  onSelect: selectRecipe,
  onAdd: () => { if (!activeBook) { alert("Create a book first."); return; } addDialog.showModal(); },
  onSearch: () => renderCatalog(),
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
    editDialog.showModal();
  },
  onDeleteRecipe: () => {
    if (!selectedRecipeId || !docMgr || !activeBook) return;
    if (!confirm("Delete this recipe?")) return;
    const id = selectedRecipeId; deselectRecipe();
    const catalog = docMgr.get<RecipeCatalog>(catalogDocId()); if (!catalog) return;
    catalog.change((doc) => { const idx = doc.recipes.findIndex((r: any) => r.id === id); if (idx !== -1) doc.recipes.splice(idx, 1); });
    pushSnapshot(catalogDocId());
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
  pushSnapshot(catalogDocId()); ti.value = ""; selectRecipe(id);
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

// -- Book management --
bookSelect.addEventListener("change", () => { const v = bookSelect.value; if (v) switchBook(v); });
manageBooksBtn.addEventListener("click", () => { renderBookManageList(); manageBooksDialog.showModal(); });

function renderBookManageList() {
  bookListManage.innerHTML = "";
  for (const book of books) {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span"); nameSpan.textContent = `${book.name} (${book.role})`; li.appendChild(nameSpan);
    const btnGroup = document.createElement("span"); btnGroup.style.display = "flex"; btnGroup.style.gap = "0.25rem";
    if (book.role === "owner" || book.role === "editor") {
      const rb = document.createElement("button"); rb.className = "sm"; rb.textContent = "Rename";
      rb.addEventListener("click", () => { const n = prompt("New name:", book.name); if (!n?.trim() || !docMgr) return; book.name = n.trim(); const c = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`); if (c) { c.change((d) => { d.name = n.trim(); }); pushSnapshot(`${book.vaultId}/catalog`); } renderBookSelect(); renderBookManageList(); });
      btnGroup.appendChild(rb);
      const sb = document.createElement("button"); sb.className = "sm"; sb.textContent = "Share"; sb.addEventListener("click", () => openShareDialog(book)); btnGroup.appendChild(sb);
    }
    const eb = document.createElement("button"); eb.className = "sm"; eb.textContent = "Export"; eb.addEventListener("click", () => handleExportBook(book)); btnGroup.appendChild(eb);
    if (book.role === "owner" || book.role === "editor") {
      const ib = document.createElement("button"); ib.className = "sm"; ib.textContent = "Import"; ib.addEventListener("click", () => handleImportToBook(book)); btnGroup.appendChild(ib);
    }
    if (book.role === "owner") {
      const db = document.createElement("button"); db.className = "sm danger"; db.textContent = "Delete";
      db.addEventListener("click", () => { if (confirm(`Delete "${book.name}"?`)) { syncClient?.deleteVault(book.vaultId); books = books.filter((b) => b.vaultId !== book.vaultId); if (activeBook?.vaultId === book.vaultId) { activeBook = null; if (books.length > 0) switchBook(books[0].vaultId); } renderBookSelect(); renderBookManageList(); } });
      btnGroup.appendChild(db);
    }
    li.appendChild(btnGroup); bookListManage.appendChild(li);
  }
}

createBookForm.addEventListener("submit", (e) => { e.preventDefault(); const ni = document.getElementById("new-book-name") as HTMLInputElement; const n = ni.value.trim(); if (!n) return; createBook(n); ni.value = ""; manageBooksDialog.close(); });

// -- Share dialog --
let sharingBook: Book | null = null;

function openShareDialog(book: Book) {
  sharingBook = book;
  (document.getElementById("share-book-name") as HTMLElement).textContent = book.name;
  inviteError.hidden = true; inviteSuccess.hidden = true;
  shareMemberList.innerHTML = "<li style='font-size:0.8rem;color:var(--subtle)'>Loading...</li>";
  shareBookDialog.showModal(); syncClient?.listVaultMembers(book.vaultId);
}

function renderMemberList(members: Array<{ userId: string; role: string; publicKey?: string }>) {
  shareMemberList.innerHTML = "";
  if (members.length === 0) { shareMemberList.innerHTML = "<li style='font-size:0.8rem;color:var(--subtle)'>No members</li>"; return; }
  const currentUserId = getSessionKeys()?.userId;
  const isOwner = sharingBook?.role === "owner";
  for (const m of members) {
    const li = document.createElement("li");
    const info = document.createElement("span"); info.textContent = `${m.userId.slice(0, 12)}... (${m.role})`; li.appendChild(info);
    const actions = document.createElement("span"); actions.style.display = "flex"; actions.style.gap = "0.25rem";
    if (isOwner && m.userId !== currentUserId) {
      if (m.role !== "owner") { const tb = document.createElement("button"); tb.className = "sm"; tb.textContent = "Make Owner"; tb.addEventListener("click", () => { if (!sharingBook || !syncClient) return; if (confirm("Transfer ownership?")) { syncClient.transferOwnership(sharingBook.vaultId, m.userId); setTimeout(() => syncClient?.listVaultMembers(sharingBook!.vaultId), 500); } }); actions.appendChild(tb); }
      if (m.role === "editor") { const db = document.createElement("button"); db.className = "sm"; db.textContent = "Viewer"; db.addEventListener("click", () => { if (!sharingBook || !syncClient) return; syncClient.changeRole(sharingBook.vaultId, m.userId, "viewer"); setTimeout(() => syncClient?.listVaultMembers(sharingBook!.vaultId), 500); }); actions.appendChild(db); }
      else if (m.role === "viewer") { const pb = document.createElement("button"); pb.className = "sm"; pb.textContent = "Editor"; pb.addEventListener("click", () => { if (!sharingBook || !syncClient) return; syncClient.changeRole(sharingBook.vaultId, m.userId, "editor"); setTimeout(() => syncClient?.listVaultMembers(sharingBook!.vaultId), 500); }); actions.appendChild(pb); }
      const rmb = document.createElement("button"); rmb.className = "sm danger"; rmb.textContent = "Remove"; rmb.addEventListener("click", () => { if (!sharingBook || !syncClient) return; syncClient.removeFromVault(sharingBook.vaultId, m.userId); setTimeout(() => syncClient?.listVaultMembers(sharingBook!.vaultId), 500); }); actions.appendChild(rmb);
    }
    li.appendChild(actions); shareMemberList.appendChild(li);
  }
}

inviteForm.addEventListener("submit", async (e) => {
  e.preventDefault(); inviteError.hidden = true; inviteSuccess.hidden = true;
  if (!sharingBook || !syncClient) return;
  const ti = document.getElementById("invite-username") as HTMLInputElement; const tu = ti.value.trim(); if (!tu) return;
  try {
    const tuid = await deriveUserId(tu); const { publicKey: tpk } = await syncClient.lookupUser(tuid);
    const pk = getIdentityPrivateKey(); const pub = getIdentityPublicKey();
    if (!pk || !pub || !sharingBook.encKey) { inviteError.textContent = "Missing keys."; inviteError.hidden = false; return; }
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", sharingBook.encKey));
    const tpb = fromBase64(tpk); const fp = await keyFingerprint(tpb);
    const enc = await encryptBookKeyForUser(pk, tpb, raw);
    syncClient.inviteToVault(sharingBook.vaultId, tuid, toBase64(enc), toBase64(pub));
    inviteSuccess.textContent = `Invited! Key: ${fp}`; inviteSuccess.hidden = false;
    syncClient.listVaultMembers(sharingBook.vaultId); ti.value = "";
  } catch (e: any) { inviteError.textContent = e.message ?? "Failed"; inviteError.hidden = false; }
});

// -- Export/Import --
async function handleExportBook(book: Book) {
  if (!docMgr) return;
  const catalog = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`);
  if (!catalog) { alert("Open this book first."); return; }
  const recipes = catalog.getDoc().recipes ?? [];
  if (recipes.length === 0) { alert("No recipes to export."); return; }
  try {
    const blob = await exportBook(book.name, book.vaultId, recipes, docMgr);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${book.name}.zip`; a.click(); URL.revokeObjectURL(a.href);
  } catch (e: any) { alert("Export failed: " + (e.message ?? e)); }
}

async function handleImportToBook(book: Book) {
  if (!docMgr || !syncClient) return;
  const input = document.createElement("input"); input.type = "file"; input.accept = ".zip";
  input.addEventListener("change", async () => {
    const file = input.files?.[0]; if (!file) return;
    try {
      const parsed = await importFromZip(file);
      if (parsed.length === 0) { alert("No recipes found."); return; }
      const catalog = docMgr!.get<RecipeCatalog>(`${book.vaultId}/catalog`);
      if (!catalog) { alert("Open this book first."); return; }
      for (const { meta, content } of parsed) {
        const id = crypto.randomUUID(); const now = Date.now();
        catalog.change((doc) => { if (!doc.recipes) doc.recipes = []; doc.recipes.push({ id, title: meta.title ?? "Imported", tags: meta.tags ?? [], servings: meta.servings ?? 4, prepMinutes: meta.prepMinutes ?? 0, cookMinutes: meta.cookMinutes ?? 0, createdAt: meta.createdAt ?? now, updatedAt: meta.updatedAt ?? now }); });
        const cs = await docMgr!.open<RecipeContent>(`${book.vaultId}/${id}`, (d) => { d.description = content.description ?? ""; d.ingredients = (content.ingredients ?? []) as any; d.instructions = content.instructions ?? ""; d.imageUrls = []; d.notes = content.notes ?? ""; });
        cs.ensureInitialized(); pushSnapshot(`${book.vaultId}/${id}`); docMgr!.close(`${book.vaultId}/${id}`);
      }
      pushSnapshot(`${book.vaultId}/catalog`); renderCatalog();
      alert(`Imported ${parsed.length} recipe${parsed.length !== 1 ? "s" : ""}.`);
    } catch (e: any) { alert("Import failed: " + (e.message ?? e)); }
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

// -- Boot --
const savedUsername = getStoredUsername();
if (savedUsername) usernameInput.value = savedUsername;
loginSection.hidden = false;
appSection.hidden = true;
