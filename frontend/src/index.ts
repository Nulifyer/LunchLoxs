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
    opt.textContent = "No books -- create one first";
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
    const catalog = await docMgr.open<RecipeCatalog>(catalogDocId, (doc) => {
      doc.name = book.name;
      doc.recipes = [];
    });
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

  const encryptedVaultKey = await encryptBookKeyForUser(privKey, pubKey, bookKeyRaw);
  syncClient.createVault(vaultId, toBase64(encryptedVaultKey), toBase64(pubKey));

  const book: Book = { vaultId, name, role: "owner", encKey: bookKey };
  books.push(book);
  renderBookSelect();

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
  appSection.classList.add("detail-open");
  renderCatalog();

  const contentDocId = `${activeBook.vaultId}/${id}`;
  const contentStore = await docMgr.open<RecipeContent>(contentDocId, (doc) => {
    doc.description = "";
    doc.ingredients = [];
    doc.instructions = "";
    doc.imageUrls = [];
    doc.notes = "";
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
    const contentDocId = `${activeBook.vaultId}/${selectedRecipeId}`;
    syncClient.unsubscribe(contentDocId);
    docMgr?.close(contentDocId);
  }
  selectedRecipeId = null;
  closeRecipe();
  appSection.classList.remove("detail-open");
  renderCatalog();
}

// -- Login flow --
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
    const wsUrl = `${wsProtocol}//${location.hostname}:8000/ws`;

    syncClient = new SyncClient({
      url: wsUrl,
      userId,
      deviceId: getDeviceId(),
      authHash: derived.authHash,
      encKey: masterKey as any,
      wrappedKey: wrappedMasterKey ? toBase64(wrappedMasterKey) : undefined,

      onConnected: async ({ wrappedKey: serverWrappedKey, publicKey: serverPubKey, wrappedPrivateKey: serverWrappedPrivKey }) => {
        if (!masterKey) {
          if (serverWrappedKey) {
            try {
              const serverBytes = fromBase64(serverWrappedKey);
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
          syncClient!.setKey(toBase64(wrappedMasterKey));
        }

        if (serverPubKey && serverWrappedPrivKey) {
          const wrappedPriv = fromBase64(serverWrappedPrivKey);
          const privKeyBytes = await unwrapPrivateKey(wrappedPriv, masterKey!);
          setIdentityKeys(fromBase64(serverPubKey), privKeyBytes);
        } else {
          const { publicKey: pubBytes, privateKey: privBytes } = await generateIdentityKeypair();
          const wrappedPriv = await wrapPrivateKey(privBytes, masterKey!);
          setIdentityKeys(pubBytes, privBytes);
          syncClient!.setIdentity(toBase64(pubBytes), toBase64(wrappedPriv));
        }

        if (!docMgr) {
          docMgr = await DocumentManager.init(userId, masterKey!);
        }

        syncClient!.listVaults();
      },

      onVaultList: async (vaultInfos: VaultInfo[]) => {
        const privKey = getIdentityPrivateKey();
        if (!privKey) return;

        books = [];
        for (const vi of vaultInfos) {
          try {
            const encKey = fromBase64(vi.encryptedVaultKey);
            const senderPub = fromBase64(vi.senderPublicKey);
            const rawBookKey = await decryptBookKeyFromUser(privKey, senderPub, encKey);
            const bookKey = await importBookKey(rawBookKey);
            books.push({ vaultId: vi.vaultId, name: vi.vaultId.slice(0, 8), role: vi.role, encKey: bookKey });
          } catch (e) {
            console.warn(`Failed to decrypt book key for vault ${vi.vaultId}:`, e);
          }
        }

        renderBookSelect();
        if (books.length > 0 && !activeBook) {
          await switchBook(books[0].vaultId);
        }
      },

      onVaultCreated: () => {},

      onVaultInvited: async () => {
        syncClient?.listVaults();
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
        renderMemberList(members);
      },

      onVaultDeleted: (vaultId) => {
        books = books.filter((b) => b.vaultId !== vaultId);
        if (activeBook?.vaultId === vaultId) {
          activeBook = null;
          if (books.length > 0) switchBook(books[0].vaultId);
        }
        renderBookSelect();
      },

      onOwnershipTransferred: (vaultId, newOwnerUserId) => {
        const book = books.find((b) => b.vaultId === vaultId);
        if (book) {
          // Refresh vault list to get updated roles
          syncClient?.listVaults();
        }
      },

      onRoleChanged: (vaultId, _targetUserId, _newRole) => {
        syncClient?.listVaults();
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

// -- Event handlers --
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await login(usernameInput.value.trim(), passphraseInput.value);
});

logoutBtn.addEventListener("click", logout);

// -- Account page --
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
    const session = getSessionKeys();
    if (!session) return;
    const newWrapped = await rewrapMasterKey(session.masterKey, newDerived.wrappingKey);
    updateWrappedKey(userId, newWrapped);
    syncClient.changePassword(newDerived.authHash, toBase64(newWrapped));
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

// -- Recipe list callbacks --
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

// -- Recipe detail callbacks --
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

// -- Add recipe dialog --
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

  titleInput.value = "";
  tagsInput.value = "";
  servingsInput.value = "4";
  prepInput.value = "0";
  cookInput.value = "0";

  selectRecipe(id);
});

// -- Edit recipe dialog --
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

  const meta = [
    servings ? `${servings} servings` : "",
    prepMinutes ? `${prepMinutes}m prep` : "",
    cookMinutes ? `${cookMinutes}m cook` : "",
    ...tags,
  ].filter(Boolean).join(" · ");
  (document.getElementById("recipe-title") as HTMLElement).textContent = title;
  (document.getElementById("recipe-meta") as HTMLElement).textContent = meta;
});

// -- Book management --
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

    if (book.role === "owner" || book.role === "editor") {
      const shareBtn = document.createElement("button");
      shareBtn.className = "outline btn-sm";
      shareBtn.textContent = "Share";
      shareBtn.addEventListener("click", () => openShareDialog(book));
      btnGroup.appendChild(shareBtn);
    }

    // Export (anyone)
    const exportBtn = document.createElement("button");
    exportBtn.className = "outline btn-sm";
    exportBtn.textContent = "Export";
    exportBtn.addEventListener("click", () => handleExportBook(book));
    btnGroup.appendChild(exportBtn);

    // Import (owner/editor)
    if (book.role === "owner" || book.role === "editor") {
      const importBtn = document.createElement("button");
      importBtn.className = "outline btn-sm";
      importBtn.textContent = "Import";
      importBtn.addEventListener("click", () => handleImportToBook(book));
      btnGroup.appendChild(importBtn);
    }

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

// -- Share dialog --
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

function renderMemberList(members: Array<{ userId: string; role: string; publicKey?: string }>) {
  shareMemberList.innerHTML = "";
  if (members.length === 0) {
    shareMemberList.innerHTML = "<li>No members</li>";
    return;
  }

  const currentUserId = getSessionKeys()?.userId;
  const isOwner = sharingBook?.role === "owner";

  for (const m of members) {
    const li = document.createElement("li");

    const infoSpan = document.createElement("span");
    infoSpan.textContent = `${m.userId.slice(0, 12)}... (${m.role})`;
    li.appendChild(infoSpan);

    const actions = document.createElement("span");
    actions.style.display = "flex";
    actions.style.gap = "0.25rem";

    if (isOwner && m.userId !== currentUserId) {
      // Transfer ownership
      if (m.role !== "owner") {
        const transferBtn = document.createElement("button");
        transferBtn.className = "outline btn-sm";
        transferBtn.textContent = "Make Owner";
        transferBtn.addEventListener("click", () => {
          if (!sharingBook || !syncClient) return;
          if (confirm(`Transfer ownership of "${sharingBook.name}" to this user? You will become an editor.`)) {
            syncClient.transferOwnership(sharingBook.vaultId, m.userId);
            setTimeout(() => syncClient?.listVaultMembers(sharingBook!.vaultId), 500);
          }
        });
        actions.appendChild(transferBtn);
      }

      // Change role
      if (m.role === "editor") {
        const demoteBtn = document.createElement("button");
        demoteBtn.className = "outline btn-sm";
        demoteBtn.textContent = "Viewer";
        demoteBtn.addEventListener("click", () => {
          if (!sharingBook || !syncClient) return;
          syncClient.changeRole(sharingBook.vaultId, m.userId, "viewer");
          setTimeout(() => syncClient?.listVaultMembers(sharingBook!.vaultId), 500);
        });
        actions.appendChild(demoteBtn);
      } else if (m.role === "viewer") {
        const promoteBtn = document.createElement("button");
        promoteBtn.className = "outline btn-sm";
        promoteBtn.textContent = "Editor";
        promoteBtn.addEventListener("click", () => {
          if (!sharingBook || !syncClient) return;
          syncClient.changeRole(sharingBook.vaultId, m.userId, "editor");
          setTimeout(() => syncClient?.listVaultMembers(sharingBook!.vaultId), 500);
        });
        actions.appendChild(promoteBtn);
      }

      // Remove
      const removeBtn = document.createElement("button");
      removeBtn.className = "outline btn-sm btn-danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        if (!sharingBook || !syncClient) return;
        syncClient.removeFromVault(sharingBook.vaultId, m.userId);
        setTimeout(() => syncClient?.listVaultMembers(sharingBook!.vaultId), 500);
      });
      actions.appendChild(removeBtn);
    }

    li.appendChild(actions);
    shareMemberList.appendChild(li);
  }
}

inviteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  inviteError.hidden = true;
  inviteSuccess.hidden = true;

  if (!sharingBook || !syncClient) return;
  const targetInput = document.getElementById("invite-username") as HTMLInputElement;
  const targetUsername = targetInput.value.trim();
  if (!targetUsername) return;

  try {
    const targetUserId = await deriveUserId(targetUsername);
    const { publicKey: targetPublicKey } = await syncClient.lookupUser(targetUserId);

    const privKey = getIdentityPrivateKey();
    const pubKey = getIdentityPublicKey();
    if (!privKey || !pubKey || !sharingBook.encKey) {
      inviteError.textContent = "Missing encryption keys.";
      inviteError.hidden = false;
      return;
    }

    const rawBookKey = new Uint8Array(await crypto.subtle.exportKey("raw", sharingBook.encKey));
    const targetPubBytes = fromBase64(targetPublicKey);

    // Show fingerprint for verification
    const fp = await keyFingerprint(targetPubBytes);
    inviteSuccess.textContent = `Key fingerprint: ${fp}`;
    inviteSuccess.hidden = false;

    const encryptedForTarget = await encryptBookKeyForUser(privKey, targetPubBytes, rawBookKey);
    syncClient.inviteToVault(sharingBook.vaultId, targetUserId, toBase64(encryptedForTarget), toBase64(pubKey));
    inviteSuccess.textContent = `User invited! Key fingerprint: ${fp}`;
    syncClient.listVaultMembers(sharingBook.vaultId);
    targetInput.value = "";
  } catch (e: any) {
    inviteError.textContent = e.message ?? "Invite failed";
    inviteError.hidden = false;
  }
});

// -- Export --
async function handleExportBook(book: Book) {
  if (!docMgr) return;
  const catalog = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`);
  if (!catalog) {
    alert("Open this book first before exporting.");
    return;
  }

  const recipes = catalog.getDoc().recipes ?? [];
  if (recipes.length === 0) {
    alert("No recipes to export.");
    return;
  }

  try {
    const blob = await exportBook(book.name, book.vaultId, recipes, docMgr);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${book.name}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    alert("Export failed: " + (e.message ?? e));
  }
}

// -- Import --
async function handleImportToBook(book: Book) {
  if (!docMgr || !syncClient) return;

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      const parsed = await importFromZip(file);
      if (parsed.length === 0) {
        alert("No recipes found in the ZIP file.");
        return;
      }

      const catalog = docMgr!.get<RecipeCatalog>(`${book.vaultId}/catalog`);
      if (!catalog) {
        alert("Open this book first before importing.");
        return;
      }

      for (const { meta, content } of parsed) {
        const id = crypto.randomUUID();
        const now = Date.now();

        catalog.change((doc) => {
          if (!doc.recipes) doc.recipes = [];
          doc.recipes.push({
            id,
            title: meta.title ?? "Imported Recipe",
            tags: meta.tags ?? [],
            servings: meta.servings ?? 4,
            prepMinutes: meta.prepMinutes ?? 0,
            cookMinutes: meta.cookMinutes ?? 0,
            createdAt: meta.createdAt ?? now,
            updatedAt: meta.updatedAt ?? now,
          });
        });

        // Create content document
        const contentDocId = `${book.vaultId}/${id}`;
        const contentStore = await docMgr!.open<RecipeContent>(contentDocId, (doc) => {
          doc.description = content.description ?? "";
          doc.ingredients = (content.ingredients ?? []) as any;
          doc.instructions = content.instructions ?? "";
          doc.imageUrls = [];
          doc.notes = content.notes ?? "";
        });
        contentStore.ensureInitialized();
        pushSnapshot(contentDocId);
        docMgr!.close(contentDocId);
      }

      pushSnapshot(`${book.vaultId}/catalog`);
      renderCatalog();
      alert(`Imported ${parsed.length} recipe${parsed.length !== 1 ? "s" : ""}.`);
    } catch (e: any) {
      alert("Import failed: " + (e.message ?? e));
    }
  });
  input.click();
}

// -- Service worker + update detection --
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(console.error);
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "update-available") {
      const banner = document.createElement("div");
      banner.className = "update-banner";
      banner.textContent = "A new version is available. ";
      const refreshBtn = document.createElement("button");
      refreshBtn.textContent = "Refresh";
      refreshBtn.addEventListener("click", () => location.reload());
      banner.appendChild(refreshBtn);
      document.body.prepend(banner);
    }
  });
}

// -- Boot --
const savedUsername = getStoredUsername();
if (savedUsername) usernameInput.value = savedUsername;
loginSection.hidden = false;
appSection.hidden = true;
