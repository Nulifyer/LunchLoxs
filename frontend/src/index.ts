import { deriveKeys, deriveUserId, generateMasterKey, unwrapMasterKey, rewrapMasterKey } from "./lib/crypto";
import { getStoredUsername, getStoredWrappedKey, getDeviceId, saveSession, clearSession, updateWrappedKey, clearWrappedKey } from "./lib/auth";
import { DocumentManager } from "./lib/document-manager";
import { SyncClient, type SyncStatus } from "./lib/sync-client";
import { initRecipeList, renderRecipeList } from "./views/recipe-list";
import { initRecipeDetail, openRecipe, closeRecipe, handlePresence, isOpen as isDetailOpen } from "./views/recipe-detail";
import type { RecipeCatalog, RecipeContent } from "./types";

// ── State ──
let docMgr: DocumentManager | null = null;
let syncClient: SyncClient | null = null;
let syncStatus: SyncStatus = "disconnected";
let selectedRecipeId: string | null = null;

// ── DOM refs ──
const loginSection = document.getElementById("login-section") as HTMLElement;
const appSection = document.getElementById("app-section") as HTMLElement;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const usernameInput = document.getElementById("username-input") as HTMLInputElement;
const passphraseInput = document.getElementById("passphrase-input") as HTMLInputElement;
const loginError = document.getElementById("login-error") as HTMLElement;
const loginBtn = document.getElementById("login-btn") as HTMLButtonElement;
const logoutBtn = document.getElementById("logout-btn") as HTMLButtonElement;
const accountBtn = document.getElementById("account-btn") as HTMLButtonElement;
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

// ── Debounced push ──
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

// ── Render catalog ──
function renderCatalog() {
  if (!docMgr) return;
  const catalog = docMgr.get<RecipeCatalog>("catalog");
  if (!catalog) return;
  const doc = catalog.getDoc();
  const recipes = doc.recipes ?? [];
  renderRecipeList(recipes, selectedRecipeId);
  recipeCount.textContent = `${recipes.length} recipe${recipes.length !== 1 ? "s" : ""}`;
  updateSyncBadge();
}

function updateSyncBadge() {
  syncBadge.textContent = syncStatus;
  syncBadge.className = `sync-badge ${syncStatus}`;
  syncBadge.hidden = syncStatus === "connected";
}

// ── Recipe selection ──
async function selectRecipe(id: string) {
  if (!docMgr || !syncClient) return;
  selectedRecipeId = id;
  appSection.classList.add("detail-open");
  renderCatalog();

  // Open the recipe content document
  const contentStore = await docMgr.open<RecipeContent>(id, (doc) => {
    doc.description = "";
    doc.ingredients = [];
    doc.instructions = "";
    doc.imageUrls = [];
    doc.notes = "";
  });

  // Subscribe to sync for this recipe
  await syncClient.subscribe(id);

  // Get metadata from catalog
  const catalog = docMgr.get<RecipeCatalog>("catalog");
  const meta = catalog?.getDoc().recipes.find((r: any) => r.id === id);
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
  if (selectedRecipeId && syncClient) {
    syncClient.unsubscribe(selectedRecipeId);
    docMgr?.close(selectedRecipeId);
  }
  selectedRecipeId = null;
  closeRecipe();
  appSection.classList.remove("detail-open");
  renderCatalog();
}

// ── Login flow ──
async function login(username: string, passphrase: string) {
  loginBtn.disabled = true;
  loginBtn.textContent = "Deriving keys...";
  loginError.hidden = true;

  try {
    const [derived, userId] = await Promise.all([
      deriveKeys(username, passphrase),
      deriveUserId(username),
    ]);

    const toB64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
    const fromB64 = (s: string) => { const b = atob(s); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };

    const localWrapped = getStoredWrappedKey(userId);
    let masterKey: CryptoKey | null = null;
    let wrappedMasterKey: Uint8Array | null = null;

    if (localWrapped) {
      try {
        masterKey = await unwrapMasterKey(localWrapped, derived.wrappingKey);
        wrappedMasterKey = localWrapped;
      } catch {
        throw new Error("Wrong passphrase — could not decrypt local data.");
      }
    }

    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${location.hostname}:8080/ws`;

    syncClient = new SyncClient({
      url: wsUrl,
      userId,
      deviceId: getDeviceId(),
      authHash: derived.authHash,
      encKey: masterKey as any,
      wrappedKey: wrappedMasterKey ? toB64(wrappedMasterKey) : undefined,
      onConnected: async (serverWrappedKey) => {
        if (!masterKey) {
          if (serverWrappedKey) {
            try {
              const serverBytes = fromB64(serverWrappedKey);
              masterKey = await unwrapMasterKey(serverBytes, derived.wrappingKey);
              wrappedMasterKey = serverBytes;
            } catch {
              throw new Error("Wrong passphrase — could not decrypt server key.");
            }
          } else {
            const generated = await generateMasterKey(derived.wrappingKey);
            masterKey = generated.masterKey;
            wrappedMasterKey = generated.wrappedMasterKey;
          }
        }

        saveSession(username, { authHash: derived.authHash, masterKey: masterKey!, wrappedMasterKey: wrappedMasterKey!, userId });
        syncClient!.opts.encKey = masterKey!;

        if (wrappedMasterKey && !serverWrappedKey) {
          const keyB64 = toB64(wrappedMasterKey);
          if (syncClient!.ws?.readyState === WebSocket.OPEN) {
            syncClient!.ws.send(JSON.stringify({ type: "set_key", wrapped_key: keyB64 }));
          }
        }

        // Init document manager
        if (!docMgr) {
          docMgr = await DocumentManager.init(userId, masterKey!);
        }

        // Open catalog document
        const catalog = await docMgr!.open<RecipeCatalog>("catalog", (doc) => {
          doc.recipes = [];
        });
        catalog.onChange(() => renderCatalog());

        // Subscribe to catalog sync
        await syncClient!.subscribe("catalog");
      },
      onRemoteChange: async (docId, snapshot, seq) => {
        const store = docMgr?.get(docId);
        if (!store) return;
        store.merge(snapshot);
        await store.setLastSeq(seq);
      },
      onCaughtUp: (docId, latestSeq) => {
        const store = docMgr?.get(docId);
        if (!store) return;
        store.setLastSeq(latestSeq);
        store.ensureInitialized();
        if (docId === "catalog") renderCatalog();
        pushSnapshot(docId);
      },
      onPresence: (docId, deviceId, data) => {
        if (docId === selectedRecipeId) {
          handlePresence(deviceId, data);
        }
      },
      onPurged: async () => {
        const catalog = docMgr?.get<RecipeCatalog>("catalog");
        if (catalog) await catalog.clear((doc) => { doc.recipes = []; });
        logout();
      },
      onPasswordChanged: () => {
        clearWrappedKey(userId);
        alert("Password was changed on another device. Please log in with the new passphrase.");
        logout();
      },
      onStatusChange: (s) => {
        syncStatus = s;
        updateSyncBadge();
      },
    });

    syncClient.setLastSeqGetter(async (docId) => {
      const store = docMgr?.get(docId);
      return store ? store.getLastSeq() : 0;
    });

    // If we have the master key locally, init doc manager before connecting
    if (masterKey) {
      docMgr = await DocumentManager.init(userId, masterKey);
    }

    syncClient.connect();

    passphraseInput.value = "";
    loginSection.hidden = true;
    appSection.hidden = false;
    renderCatalog();
  } catch (e: any) {
    loginError.textContent = e.message ?? "Login failed";
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Login / Sign Up";
  }
}

function logout() {
  if (isDetailOpen()) deselectRecipe();
  syncClient?.disconnect();
  syncClient = null;
  docMgr?.closeAll();
  docMgr = null;
  clearSession();
  loginSection.hidden = false;
  appSection.hidden = true;
}

// ── Event handlers ──
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await login(usernameInput.value.trim(), passphraseInput.value);
});

logoutBtn.addEventListener("click", logout);

// ── Account page ──
function showAccountPage() {
  if (isDetailOpen()) deselectRecipe();
  accountUsername.textContent = getStoredUsername() ?? "";
  accountDeviceId.textContent = getDeviceId();
  emptyState.hidden = true;
  accountPage.hidden = false;
  appSection.classList.add("detail-open");
  pwError.hidden = true;
  pwSuccess.hidden = true;
  purgeError.hidden = true;
}

function hideAccountPage() {
  accountPage.hidden = true;
  emptyState.hidden = false;
  appSection.classList.remove("detail-open");
}

accountBtn.addEventListener("click", showAccountPage);
accountBackBtn.addEventListener("click", hideAccountPage);

changePwForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  pwError.hidden = true;
  pwSuccess.hidden = true;

  const newPw = (document.getElementById("new-pw") as HTMLInputElement).value;
  const confirmPw = (document.getElementById("confirm-pw") as HTMLInputElement).value;

  if (newPw !== confirmPw) {
    pwError.textContent = "Passphrases don't match.";
    pwError.hidden = false;
    return;
  }

  const username = getStoredUsername();
  if (!username || !syncClient) return;

  try {
    const [newDerived, userId] = await Promise.all([
      deriveKeys(username, newPw),
      deriveUserId(username),
    ]);
    const { getSessionKeys } = await import("./lib/auth");
    const session = getSessionKeys();
    if (!session) return;
    const newWrapped = await rewrapMasterKey(session.masterKey, newDerived.wrappingKey);
    const toB64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
    updateWrappedKey(userId, newWrapped);
    syncClient.changePassword(newDerived.authHash, toB64(newWrapped));
    pwSuccess.textContent = "Passphrase changed. Other devices will need the new passphrase.";
    pwSuccess.hidden = false;
    changePwForm.reset();
  } catch (e: any) {
    pwError.textContent = "Failed: " + (e.message ?? e);
    pwError.hidden = false;
  }
});

purgeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  purgeError.hidden = true;

  const confirmInput = (document.getElementById("purge-confirm") as HTMLInputElement).value.trim().toLowerCase();
  const username = (getStoredUsername() ?? "").trim().toLowerCase();

  if (confirmInput !== username) {
    purgeError.textContent = "Username doesn't match. Type your username exactly to confirm.";
    purgeError.hidden = false;
    return;
  }

  syncClient?.purge();
});

// ── Recipe list callbacks ──
initRecipeList({
  onSelect: selectRecipe,
  onAdd: () => addDialog.showModal(),
  onSearch: () => renderCatalog(),
});

// ── Recipe detail callbacks ──
initRecipeDetail({
  onBack: deselectRecipe,
  onPushSnapshot: () => {
    if (selectedRecipeId) pushSnapshot(selectedRecipeId);
  },
  onSendPresence: (data) => {
    if (selectedRecipeId && syncClient) {
      syncClient.sendPresence(selectedRecipeId, data);
    }
  },
  onEditRecipe: () => {
    if (!selectedRecipeId || !docMgr) return;
    const catalog = docMgr.get<RecipeCatalog>("catalog");
    if (!catalog) return;
    const recipe = catalog.getDoc().recipes.find((r: any) => r.id === selectedRecipeId);
    if (!recipe) return;

    // Pre-fill edit form
    (document.getElementById("edit-title") as HTMLInputElement).value = recipe.title;
    (document.getElementById("edit-tags") as HTMLInputElement).value = recipe.tags.join(", ");
    (document.getElementById("edit-servings") as HTMLInputElement).value = String(recipe.servings);
    (document.getElementById("edit-prep") as HTMLInputElement).value = String(recipe.prepMinutes);
    (document.getElementById("edit-cook") as HTMLInputElement).value = String(recipe.cookMinutes);
    editDialog.showModal();
  },
  onDeleteRecipe: () => {
    if (!selectedRecipeId || !docMgr) return;
    if (!confirm("Delete this recipe? This cannot be undone.")) return;

    const id = selectedRecipeId;
    deselectRecipe();

    const catalog = docMgr.get<RecipeCatalog>("catalog");
    if (!catalog) return;
    catalog.change((doc) => {
      const idx = doc.recipes.findIndex((r: any) => r.id === id);
      if (idx !== -1) doc.recipes.splice(idx, 1);
    });
    pushSnapshot("catalog");
  },
});

// ── Add recipe dialog ──
addForm.addEventListener("submit", () => {
  const titleInput = document.getElementById("new-title") as HTMLInputElement;
  const tagsInput = document.getElementById("new-tags") as HTMLInputElement;
  const servingsInput = document.getElementById("new-servings") as HTMLInputElement;
  const prepInput = document.getElementById("new-prep") as HTMLInputElement;
  const cookInput = document.getElementById("new-cook") as HTMLInputElement;

  const title = titleInput.value.trim();
  if (!title || !docMgr) return;

  const id = crypto.randomUUID();
  const tags = tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);
  const now = Date.now();

  const catalog = docMgr.get<RecipeCatalog>("catalog");
  if (!catalog) return;

  catalog.change((doc) => {
    if (!doc.recipes) doc.recipes = [];
    doc.recipes.push({
      id,
      title,
      tags,
      servings: parseInt(servingsInput.value) || 4,
      prepMinutes: parseInt(prepInput.value) || 0,
      cookMinutes: parseInt(cookInput.value) || 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  pushSnapshot("catalog");

  // Reset form
  titleInput.value = "";
  tagsInput.value = "";
  servingsInput.value = "4";
  prepInput.value = "0";
  cookInput.value = "0";

  // Open the new recipe
  selectRecipe(id);
});

// ── Edit recipe dialog ──
editForm.addEventListener("submit", () => {
  if (!selectedRecipeId || !docMgr) return;
  const catalog = docMgr.get<RecipeCatalog>("catalog");
  if (!catalog) return;

  const title = (document.getElementById("edit-title") as HTMLInputElement).value.trim();
  const tags = (document.getElementById("edit-tags") as HTMLInputElement).value.split(",").map((t) => t.trim()).filter(Boolean);
  const servings = parseInt((document.getElementById("edit-servings") as HTMLInputElement).value) || 4;
  const prepMinutes = parseInt((document.getElementById("edit-prep") as HTMLInputElement).value) || 0;
  const cookMinutes = parseInt((document.getElementById("edit-cook") as HTMLInputElement).value) || 0;

  const recipeId = selectedRecipeId;
  catalog.change((doc) => {
    const recipe = doc.recipes.find((r: any) => r.id === recipeId);
    if (!recipe) return;
    recipe.title = title;
    recipe.tags = tags;
    recipe.servings = servings;
    recipe.prepMinutes = prepMinutes;
    recipe.cookMinutes = cookMinutes;
    recipe.updatedAt = Date.now();
  });

  pushSnapshot("catalog");

  // Update detail view header
  const meta = [
    servings ? `${servings} servings` : "",
    prepMinutes ? `${prepMinutes}m prep` : "",
    cookMinutes ? `${cookMinutes}m cook` : "",
    ...tags,
  ].filter(Boolean).join(" · ");
  (document.getElementById("recipe-title") as HTMLElement).textContent = title;
  (document.getElementById("recipe-meta") as HTMLElement).textContent = meta;
});

// ── Service worker ──
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(console.error);
}

// ── Boot ──
const savedUsername = getStoredUsername();
if (savedUsername) usernameInput.value = savedUsername;
loginSection.hidden = false;
appSection.hidden = true;
