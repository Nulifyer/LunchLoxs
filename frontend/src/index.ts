import {
  deriveKeys, deriveUserId, generateMasterKey, unwrapMasterKey, rewrapMasterKey,
  generateIdentityKeypair, wrapPrivateKey, unwrapPrivateKey,
  generateBookKey, importBookKey, encryptBookKeyForUser, decryptBookKeyFromUser,
} from "./lib/crypto";
import {
  getStoredUsername, getStoredWrappedKey, getDeviceId, saveSession, clearSession,
  updateWrappedKey, clearWrappedKey, setIdentityKeys, getIdentityPrivateKey,
  getIdentityPublicKey, clearIdentityKeys,
} from "./lib/auth";
import { DocumentManager } from "./lib/document-manager";
import { SyncClient, type SyncStatus, type VaultInfo } from "./lib/sync-client";
import { initRecipeList, renderRecipeList } from "./views/recipe-list";
import { initRecipeDetail, openRecipe, closeRecipe, handlePresence, isOpen as isDetailOpen } from "./views/recipe-detail";
import type { RecipeCatalog, RecipeContent, Book } from "./types";

// ── State ──
let docMgr: DocumentManager | null = null;
let syncClient: SyncClient | null = null;
let syncStatus: SyncStatus = "disconnected";
let selectedRecipeId: string | null = null;
let books: Book[] = [];
let activeBook: Book | null = null;

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

// ── Base64 helpers ──
const toB64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const fromB64 = (s: string) => { const b = atob(s); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };

// ── Book management ──
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
    opt.textContent = "No books -- create one first";
    opt.disabled = true;
    bookSelect.appendChild(opt);
  }
}

async function switchBook(vaultId: string) {
  // Close current book
  if (selectedRecipeId) deselectRecipe();
  if (activeBook && syncClient) {
    syncClient.unsubscribe(`${activeBook.vaultId}/catalog`);
    docMgr?.close(`${activeBook.vaultId}/catalog`);
  }

  const book = books.find((b) => b.vaultId === vaultId);
  if (!book || !book.encKey) return;
  activeBook = book;

  // Open catalog for this book (doc_id = "vaultId/catalog")
  if (docMgr) {
    const catalogDocId = `${vaultId}/catalog`;
    const catalog = await docMgr.open<RecipeCatalog>(catalogDocId, (doc) => {
      doc.name = book.name;
      doc.recipes = [];
    });
    // Update book name from catalog if available
    const catDoc = catalog.getDoc();
    if (catDoc.name) book.name = catDoc.name;
    catalog.onChange(() => renderCatalog());
    if (syncClient) await syncClient.subscribe(catalogDocId);
  }
  renderCatalog();
}

async function createBook(name: string) {
  if (!syncClient || !docMgr) return;

  const privKey = getIdentityPrivateKey();
  const pubKey = getIdentityPublicKey();
  if (!privKey || !pubKey) return;

  const vaultId = crypto.randomUUID();
  const { bookKey, bookKeyRaw } = await generateBookKey();

  // Encrypt book key for ourselves using ECDH (sender = recipient = us)
  const encryptedVaultKey = await encryptBookKeyForUser(privKey, pubKey, bookKeyRaw);

  syncClient.createVault(vaultId, toB64(encryptedVaultKey), toB64(pubKey));

  const book: Book = { vaultId, name, role: "owner", encKey: bookKey };
  books.push(book);
  renderBookSelect();

  // Store the book name in the catalog doc
  const catalogDocId = `${vaultId}/catalog`;
  const catalog = await docMgr.open<RecipeCatalog>(catalogDocId, (doc) => {
    doc.name = name;
    doc.recipes = [];
  });
  catalog.onChange(() => renderCatalog());
  pushSnapshot(catalogDocId);

  if (syncClient) await syncClient.subscribe(catalogDocId);
  activeBook = book;
  bookSelect.value = vaultId;
  renderCatalog();
}

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
  updateSyncBadge();
}

function updateSyncBadge() {
  syncBadge.textContent = syncStatus;
  syncBadge.className = `sync-badge ${syncStatus}`;
  syncBadge.hidden = syncStatus === "connected";
}

// ── Recipe selection ──
async function selectRecipe(id: string) {
  if (!docMgr || !syncClient || !activeBook) return;
  // Hide account page if open
  accountPage.hidden = true;
  selectedRecipeId = id;
  appSection.classList.add("detail-open");
  renderCatalog();

  // Open the recipe content document scoped to vault
  const contentDocId = `${activeBook.vaultId}/${id}`;
  const contentStore = await docMgr.open<RecipeContent>(contentDocId, (doc) => {
    doc.description = "";
    doc.ingredients = [];
    doc.instructions = "";
    doc.imageUrls = [];
    doc.notes = "";
  });

  // Subscribe to sync for this recipe
  await syncClient.subscribe(contentDocId);

  // Get metadata from catalog
  const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
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
  if (selectedRecipeId && syncClient && activeBook) {
    const contentDocId = `${activeBook.vaultId}/${selectedRecipeId}`;
    syncClient.unsubscribe(contentDocId);
    docMgr?.close(contentDocId);
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

    const localWrapped = getStoredWrappedKey(userId);
    let masterKey: CryptoKey | null = null;
    let wrappedMasterKey: Uint8Array | null = null;

    if (localWrapped) {
      try {
        masterKey = await unwrapMasterKey(localWrapped, derived.wrappingKey);
        wrappedMasterKey = localWrapped;
      } catch {
        throw new Error("Wrong passphrase -- could not decrypt local data.");
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
      onConnected: async ({ wrappedKey: serverWrappedKey, publicKey: serverPubKey, wrappedPrivateKey: serverWrappedPrivKey }) => {
        // 1. Resolve master key
        if (!masterKey) {
          if (serverWrappedKey) {
            try {
              const serverBytes = fromB64(serverWrappedKey);
              masterKey = await unwrapMasterKey(serverBytes, derived.wrappingKey);
              wrappedMasterKey = serverBytes;
            } catch {
              throw new Error("Wrong passphrase -- could not decrypt server key.");
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
          syncClient!.sendMsg?.({ type: "set_key", wrapped_key: toB64(wrappedMasterKey) });
          // fallback direct send
          if (syncClient!.ws?.readyState === WebSocket.OPEN) {
            syncClient!.ws.send(JSON.stringify({ type: "set_key", wrapped_key: toB64(wrappedMasterKey) }));
          }
        }

        // 2. Resolve identity keypair
        if (serverPubKey && serverWrappedPrivKey) {
          // Have identity keys on server — decrypt private key with master key
          const wrappedPriv = fromB64(serverWrappedPrivKey);
          const privKeyBytes = await unwrapPrivateKey(wrappedPriv, masterKey!);
          setIdentityKeys(fromB64(serverPubKey), privKeyBytes);
        } else {
          // Generate new identity keypair
          const { publicKey: pubBytes, privateKey: privBytes } = await generateIdentityKeypair();
          const wrappedPriv = await wrapPrivateKey(privBytes, masterKey!);
          setIdentityKeys(pubBytes, privBytes);
          // Store on server
          syncClient!.setIdentity(toB64(pubBytes), toB64(wrappedPriv));
        }

        // 3. Init document manager
        if (!docMgr) {
          docMgr = await DocumentManager.init(userId, masterKey!);
        }

        // 4. Request vault list
        syncClient!.listVaults();
      },

      onVaultList: async (vaultInfos: VaultInfo[]) => {
        const privKey = getIdentityPrivateKey();
        if (!privKey) return;

        books = [];
        for (const vi of vaultInfos) {
          try {
            const encKey = fromB64(vi.encryptedVaultKey);
            const senderPub = fromB64(vi.senderPublicKey);
            const rawBookKey = await decryptBookKeyFromUser(privKey, senderPub, encKey);
            const bookKey = await importBookKey(rawBookKey);
            books.push({ vaultId: vi.vaultId, name: vi.vaultId.slice(0, 8), role: vi.role, encKey: bookKey });
          } catch (e) {
            console.warn(`Failed to decrypt book key for vault ${vi.vaultId}:`, e);
          }
        }

        renderBookSelect();

        // Auto-select first book
        if (books.length > 0 && !activeBook) {
          await switchBook(books[0].vaultId);
        }
      },

      onVaultCreated: (vaultId: string) => {
        // Already added optimistically in createBook()
      },

      onVaultInvited: async (vaultId, encryptedVaultKey, role) => {
        // We've been invited to a new vault
        const privKey = getIdentityPrivateKey();
        const pubKey = getIdentityPublicKey();
        if (!privKey || !pubKey) return;
        try {
          // The inviter encrypted the book key using ECDH(inviter_priv, our_pub)
          // To decrypt we need ECDH(our_priv, inviter_pub)
          // But we don't have the inviter's public key here...
          // For now, we'll re-request the vault list to get the proper key
          syncClient?.listVaults();
        } catch (e) {
          console.warn("Failed to process vault invite:", e);
        }
      },

      onVaultRemoved: (vaultId) => {
        books = books.filter((b) => b.vaultId !== vaultId);
        if (activeBook?.vaultId === vaultId) {
          activeBook = null;
          if (books.length > 0) switchBook(books[0].vaultId);
        }
        renderBookSelect();
      },

      onVaultMembers: (_vaultId, members) => {
        shareMemberList.innerHTML = "";
        for (const m of members) {
          const li = document.createElement("li");
          li.textContent = `${m.userId.slice(0, 12)}... (${m.role})`;
          shareMemberList.appendChild(li);
        }
        if (members.length === 0) {
          shareMemberList.innerHTML = "<li>No members</li>";
        }
      },

      onUserLookup: async (targetUserId, targetPublicKey) => {
        if (!pendingInvite || pendingInvite.targetUserId !== targetUserId) return;
        const privKey = getIdentityPrivateKey();
        const pubKey = getIdentityPublicKey();
        if (!privKey || !pubKey || !sharingBook?.encKey) {
          pendingInvite = null;
          return;
        }
        try {
          const rawBookKey = new Uint8Array(await crypto.subtle.exportKey("raw", sharingBook.encKey));
          const targetPubBytes = fromB64(targetPublicKey);
          const encryptedForTarget = await encryptBookKeyForUser(privKey, targetPubBytes, rawBookKey);
          syncClient!.inviteToVault(pendingInvite.vaultId, targetUserId, toB64(encryptedForTarget), toB64(pubKey));
          inviteSuccess.textContent = "User invited!";
          inviteSuccess.hidden = false;
          syncClient!.listVaultMembers(pendingInvite.vaultId);
        } catch (e: any) {
          inviteError.textContent = "Failed to encrypt key for user: " + (e.message ?? e);
          inviteError.hidden = false;
        }
        pendingInvite = null;
      },

      onVaultDeleted: (vaultId) => {
        books = books.filter((b) => b.vaultId !== vaultId);
        if (activeBook?.vaultId === vaultId) {
          activeBook = null;
          if (books.length > 0) switchBook(books[0].vaultId);
        }
        renderBookSelect();
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
        if (docId.endsWith("/catalog")) renderCatalog();
        pushSnapshot(docId);
      },
      onPresence: (docId, deviceId, data) => {
        if (activeBook && selectedRecipeId && docId === `${activeBook.vaultId}/${selectedRecipeId}`) {
          handlePresence(deviceId, data);
        }
      },
      onPurged: async () => {
        if (activeBook) {
          const catalog = docMgr?.get<RecipeCatalog>(catalogDocId());
          if (catalog) await catalog.clear((doc) => { doc.recipes = []; });
        }
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
    renderBookSelect();
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
  clearIdentityKeys();
  books = [];
  activeBook = null;
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
  const detailEl = document.getElementById("recipe-detail") as HTMLElement;
  detailEl.hidden = true;
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
  onAdd: () => {
    if (!activeBook) {
      alert("Create a book first before adding recipes.");
      return;
    }
    addDialog.showModal();
  },
  onSearch: () => renderCatalog(),
});

// ── Recipe detail callbacks ──
initRecipeDetail({
  onBack: deselectRecipe,
  onPushSnapshot: () => {
    if (selectedRecipeId && activeBook) pushSnapshot(`${activeBook.vaultId}/${selectedRecipeId}`);
  },
  onSendPresence: (data) => {
    if (selectedRecipeId && syncClient && activeBook) {
      syncClient.sendPresence(`${activeBook.vaultId}/${selectedRecipeId}`, data);
    }
  },
  onEditRecipe: () => {
    if (!selectedRecipeId || !docMgr || !activeBook) return;
    const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
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
    if (!selectedRecipeId || !docMgr || !activeBook) return;
    if (!confirm("Delete this recipe? This cannot be undone.")) return;

    const id = selectedRecipeId;
    deselectRecipe();

    const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
    if (!catalog) return;
    catalog.change((doc) => {
      const idx = doc.recipes.findIndex((r: any) => r.id === id);
      if (idx !== -1) doc.recipes.splice(idx, 1);
    });
    pushSnapshot(catalogDocId());
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
  if (!title || !docMgr || !activeBook) return;

  const id = crypto.randomUUID();
  const tags = tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);
  const now = Date.now();

  const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
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

  pushSnapshot(catalogDocId());

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
  if (!selectedRecipeId || !docMgr || !activeBook) return;
  const catalog = docMgr.get<RecipeCatalog>(catalogDocId());
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

  pushSnapshot(catalogDocId());

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

// ── Book management ──
bookSelect.addEventListener("change", () => {
  const vaultId = bookSelect.value;
  if (vaultId) switchBook(vaultId);
});

manageBooksBtn.addEventListener("click", () => {
  renderBookManageList();
  manageBooksDialog.showModal();
});

function renderBookManageList() {
  bookListManage.innerHTML = "";
  for (const book of books) {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = `${book.name} (${book.role})`;
    li.appendChild(nameSpan);

    const btnGroup = document.createElement("span");
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "0.25rem";

    // Rename (anyone with edit access)
    if (book.role === "owner" || book.role === "editor") {
      const renameBtn = document.createElement("button");
      renameBtn.className = "outline btn-sm";
      renameBtn.textContent = "Rename";
      renameBtn.addEventListener("click", () => {
        const newName = prompt("New name for this book:", book.name);
        if (!newName || newName.trim() === "" || !docMgr) return;
        book.name = newName.trim();
        const catalog = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`);
        if (catalog) {
          catalog.change((doc) => { doc.name = newName.trim(); });
          pushSnapshot(`${book.vaultId}/catalog`);
        }
        renderBookSelect();
        renderBookManageList();
      });
      btnGroup.appendChild(renameBtn);
    }

    // Share (owner and editors)
    if (book.role === "owner" || book.role === "editor") {
      const shareBtn = document.createElement("button");
      shareBtn.className = "outline btn-sm";
      shareBtn.textContent = "Share";
      shareBtn.addEventListener("click", () => openShareDialog(book));
      btnGroup.appendChild(shareBtn);
    }

    // Delete (owner only)
    if (book.role === "owner") {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "outline btn-sm btn-danger";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => {
        if (confirm(`Delete book "${book.name}"? All recipes in it will be lost.`)) {
          syncClient?.deleteVault(book.vaultId);
          books = books.filter((b) => b.vaultId !== book.vaultId);
          if (activeBook?.vaultId === book.vaultId) {
            activeBook = null;
            if (books.length > 0) switchBook(books[0].vaultId);
          }
          renderBookSelect();
          renderBookManageList();
        }
      });
      btnGroup.appendChild(deleteBtn);
    }

    li.appendChild(btnGroup);
    bookListManage.appendChild(li);
  }
}

createBookForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("new-book-name") as HTMLInputElement;
  const name = nameInput.value.trim();
  if (!name) return;
  createBook(name);
  nameInput.value = "";
  renderBookManageList();
});

let sharingBook: Book | null = null;

function openShareDialog(book: Book) {
  sharingBook = book;
  (document.getElementById("share-book-name") as HTMLElement).textContent = book.name;
  inviteError.hidden = true;
  inviteSuccess.hidden = true;
  shareMemberList.innerHTML = "<li>Loading...</li>";
  shareBookDialog.showModal();
  syncClient?.listVaultMembers(book.vaultId);
}

// Handle vault members response
const origOnVaultMembers = syncClient?.opts?.onVaultMembers;
// We set onVaultMembers in the SyncClient options, but also need to handle it for the share dialog
// This is done via the onVaultMembers callback in the sync client opts

inviteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  inviteError.hidden = true;
  inviteSuccess.hidden = true;

  if (!sharingBook || !syncClient) return;
  const usernameInput = document.getElementById("invite-username") as HTMLInputElement;
  const targetUsername = usernameInput.value.trim();
  if (!targetUsername) return;

  try {
    const targetUserId = await deriveUserId(targetUsername);
    // Look up the target user's public key, then encrypt the book key for them
    // For now, use a promise-based flow with the lookup callback
    pendingInvite = { vaultId: sharingBook.vaultId, targetUserId };
    syncClient.lookupUser(targetUserId);
    usernameInput.value = "";
  } catch (e: any) {
    inviteError.textContent = e.message ?? "Invite failed";
    inviteError.hidden = false;
  }
});

let pendingInvite: { vaultId: string; targetUserId: string } | null = null;

// Service worker + update detection
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(console.error);
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "update-available") {
      const banner = document.createElement("div");
      banner.className = "update-banner";
      banner.innerHTML = `A new version is available. <button onclick="location.reload()">Refresh</button>`;
      document.body.prepend(banner);
    }
  });
}

// ── Boot ──
const savedUsername = getStoredUsername();
if (savedUsername) usernameInput.value = savedUsername;
loginSection.hidden = false;
appSection.hidden = true;
