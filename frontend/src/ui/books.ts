/**
 * Manage books dialog -- book select, create, rename, delete, bulk actions, drag-drop import.
 */

import { log, warn, error } from "../lib/logger";
import { showConfirm, showPrompt } from "../lib/dialogs";
import { openModal, closeModal } from "../lib/modal";
import { createDropdown } from "../lib/dropdown";
import { removeBookFromIndex } from "../lib/search";
import { onCatalogChanged } from "../views/recipe-detail";
import { toastSuccess, toastWarning, toastError } from "../lib/toast";
import { parseRecipeMarkdown, recipeToMarkdown } from "../lib/export";
import {
  getDocMgr, getSyncClient, getBooks, setBooks, getActiveBook, setActiveBook,
  getSelectedRecipeId, getCurrentUsername, getCurrentUserId, getPushQueue,
} from "../state";
import { getIdentityPrivateKey, getIdentityPublicKey, getSessionKeys } from "../lib/auth";
import { generateBookKey, encryptBookKeyForUser, encrypt } from "../lib/crypto";
import { toBase64 } from "../lib/encoding";
import { pushSnapshot, renderCatalog, catalogDocId } from "../sync/push";
import { refreshBookNameFromCatalog, rebuildBookIndex, canEditActiveBook, setRenderBookSelect } from "../sync/vault-helpers";
import { openShareDialog } from "../ui/share";
import { handleExportBook, handleImportToBook, handleZipImport, importRecipesIntoBook } from "../import-export";
import { deselectRecipe } from "../ui/recipes";
import { on as onSyncEvent } from "../sync/sync-events";
import type { Book, BookCatalog, Recipe } from "../types";

let bookListView: HTMLElement;
let recipeListView: HTMLElement;
let bookListEl: HTMLUListElement;
let activeBookName: HTMLElement;
let bookSyncDot: HTMLElement;
let manageBooksBtn: HTMLButtonElement;
let manageBooksDialog: HTMLDialogElement;
let bookListManage: HTMLUListElement;
let createBookForm: HTMLFormElement;
let bulkToolbar: HTMLElement;
let bulkCount: HTMLElement;
let dropZone: HTMLElement;
const selectedBookIds = new Set<string>();

function renderBookList() {
  const books = getBooks();
  const pq = getPushQueue();
  bookListEl.innerHTML = "";
  const sorted = [...books].sort((a, b) => a.name.localeCompare(b.name));
  for (const book of sorted) {
    const li = document.createElement("li");
    li.className = "book-list-item";
    li.dataset.vaultId = book.vaultId;
    li.setAttribute("role", "option");

    const hasDirty = pq?.isDirty(`${book.vaultId}/catalog`) ?? false;
    const dot = document.createElement("span");
    dot.className = "sync-dot pending";
    dot.hidden = !hasDirty;
    li.appendChild(dot);

    const name = document.createElement("span");
    name.className = "book-list-item-name";
    name.textContent = book.name;
    li.appendChild(name);

    if (book.role !== "owner") {
      const role = document.createElement("span");
      role.className = "book-list-role";
      role.textContent = book.role;
      li.appendChild(role);
    }

    li.addEventListener("click", () => switchBook(book.vaultId));
    bookListEl.appendChild(li);
  }
  if (books.length === 0) {
    const li = document.createElement("li");
    li.className = "book-list-empty";
    li.textContent = "No books yet";
    bookListEl.appendChild(li);
  }
}

export function showBookList() {
  log("[books] showBookList");
  recipeListView.hidden = true;
  bookListView.hidden = false;
  renderBookList();
}

function showRecipeView() {
  log("[books] showRecipeView, activeBook:", getActiveBook()?.name ?? "none");
  bookListView.hidden = true;
  recipeListView.hidden = false;
}

export function renderBookSelect() {
  const activeBook = getActiveBook();
  const addRecipeBtn = document.getElementById("add-recipe-btn") as HTMLButtonElement;
  addRecipeBtn.disabled = !activeBook;
  const pq = getPushQueue();

  if (activeBook) {
    activeBookName.textContent = activeBook.name;
    const hasDirty = pq?.isDirty(`${activeBook.vaultId}/catalog`) ?? false;
    bookSyncDot.className = "sync-dot pending";
    bookSyncDot.hidden = !hasDirty;
  }

  // Keep book list updated if it's visible
  if (!bookListView.hidden) {
    renderBookList();
  }
}

export function switchBook(vaultId: string): Promise<void> {
  log("[switchBook]", vaultId.slice(0, 8));
  if (getSelectedRecipeId()) deselectRecipe();
  const books = getBooks();
  const book = books.find((b) => b.vaultId === vaultId);
  if (!book || !book.encKey) { warn("[switchBook] no book or no key for", vaultId.slice(0, 8), "hasBook:", !!book, "hasKey:", !!book?.encKey); return Promise.resolve(); }
  setActiveBook(book);
  renderBookSelect();
  showRecipeView();
  renderCatalog();
  return Promise.resolve();
}

export async function createBook(name: string): Promise<Book | null> {
  const syncClient = getSyncClient();
  const docMgr = getDocMgr();
  if (!docMgr) return null;
  const privKey = getIdentityPrivateKey();
  const pubKey = getIdentityPublicKey();
  if (!privKey || !pubKey) return null;
  const vaultId = crypto.randomUUID();
  log("[createBook]", name, vaultId);
  const { bookKey, bookKeyRaw } = await generateBookKey();
  const encryptedVaultKey = await encryptBookKeyForUser(privKey, pubKey, bookKeyRaw);
  const evk = toBase64(encryptedVaultKey);
  const spk = toBase64(pubKey);
  // Persist pending vault to IDB so it survives offline/refresh
  const { setPendingVault, clearPendingVault, loadLocalCache, saveLocalCache } = await import("../lib/automerge-store");
  await setPendingVault(docMgr.getDb(), { vaultId, encryptedVaultKey: evk, senderPublicKey: spk });
  // Fire-and-forget vault creation -- pending vault in IDB handles retries on reconnect
  if (syncClient?.isOpen()) {
    syncClient.createVault(vaultId, evk, spk)
      .then(() => clearPendingVault(docMgr.getDb(), vaultId))
      .catch((e) => warn("[createBook] vault creation deferred (will retry on reconnect):", e));
  } else {
    log("[createBook] offline, vault creation deferred for", vaultId.slice(0, 8));
  }
  const currentUserId = getCurrentUserId();
  const currentUsername = getCurrentUsername();
  const book: Book = { vaultId, name, role: "owner", encKey: bookKey };
  const books = getBooks();
  books.push(book);
  setBooks(books);
  renderBookSelect();
  // Append to offline cache
  const session = getSessionKeys();
  if (session?.masterKey) {
    loadLocalCache(docMgr.getDb(), session.masterKey).then(async (cache) => {
      if (!cache) return;
      const wrappedVaultKey = toBase64(await encrypt(bookKeyRaw, session.masterKey));
      cache.vaults.push({ vaultId, name, role: "owner", wrappedVaultKey });
      await saveLocalCache(docMgr.getDb(), session.masterKey, cache);
    }).catch((e) => warn("[createBook] cache update failed:", e));
  }
  const catDocId = `${vaultId}/catalog`;
  const catalog = await docMgr.open<BookCatalog>(catDocId, (doc) => {
    doc.name = name;
    doc.recipes = [];
    doc.members = {} as any;
    (doc.members as any)[currentUserId] = currentUsername;
  });
  // Apply init immediately so the name is set before any imports add recipes
  catalog.ensureInitialized();
  catalog.onChange(() => {
    refreshBookNameFromCatalog(catDocId);
    rebuildBookIndex(vaultId);
    if (getActiveBook()?.vaultId === vaultId) {
      renderCatalog();
      onCatalogChanged();
    }
  });
  pushSnapshot(catDocId);
  if (syncClient) await syncClient.subscribe(catDocId);
  renderBookSelect();
  return book;
}

function updateBulkToolbar() {
  const n = selectedBookIds.size;
  bulkToolbar.hidden = n === 0;
  bulkCount.textContent = `${n} selected`;
}

export function renderBookManageList() {
  const books = getBooks();
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

    // Sync dot
    const pq = getPushQueue();
    const hasDirty = pq?.isDirty(`${book.vaultId}/catalog`) ?? false;
    const dot = document.createElement("span");
    dot.className = "sync-dot pending";
    dot.hidden = !hasDirty;
    li.appendChild(dot);

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
          const docMgr = getDocMgr();
          const n = await showPrompt("New name for this book:", { title: "Rename Book", defaultValue: book.name });
          if (!n?.trim() || !docMgr) return;
          book.name = n.trim();
          const c = docMgr.get<BookCatalog>(`${book.vaultId}/catalog`);
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
          const syncClient = getSyncClient();
          const ok = await showConfirm(`Delete "${book.name}"? All recipes will be lost.`, { title: "Delete Book", confirmText: "Delete", danger: true });
          if (!ok) return;
          syncClient?.deleteVault(book.vaultId);
          removeBookFromIndex(book.vaultId);
          setBooks(getBooks().filter((b) => b.vaultId !== book.vaultId));
          if (getActiveBook()?.vaultId === book.vaultId) { setActiveBook(null); if (getBooks().length > 0) switchBook(getBooks()[0]!.vaultId); else showBookList(); }
          renderBookSelect(); renderBookManageList();
          toastSuccess(`Deleted "${book.name}"`);
        },
      });
    }

    li.appendChild(createDropdown(menuItems));
    bookListManage.appendChild(li);
  }
}

export function initBooks() {
  bookListView = document.getElementById("book-list-view") as HTMLElement;
  recipeListView = document.getElementById("recipe-list-view") as HTMLElement;
  bookListEl = document.getElementById("book-list") as HTMLUListElement;
  activeBookName = document.getElementById("active-book-name") as HTMLElement;
  bookSyncDot = document.getElementById("book-sync-dot") as HTMLElement;
  manageBooksBtn = document.getElementById("manage-books-btn") as HTMLButtonElement;
  manageBooksDialog = document.getElementById("manage-books-dialog") as HTMLDialogElement;
  bookListManage = document.getElementById("book-list-manage") as HTMLUListElement;
  createBookForm = document.getElementById("create-book-form") as HTMLFormElement;
  bulkToolbar = document.getElementById("book-bulk-toolbar") as HTMLElement;
  bulkCount = document.getElementById("book-bulk-count") as HTMLElement;
  dropZone = document.getElementById("book-drop-zone") as HTMLElement;

  // Wire up the renderBookSelect callback for vault-helpers
  setRenderBookSelect(renderBookSelect);

  // Update sync dots when dirty state changes
  onSyncEvent("dirty-change", () => {
    renderBookSelect();
    renderCatalog();
    if (manageBooksDialog.open) renderBookManageList();
  });

  // Re-render when books change from sync events
  onSyncEvent("books-change", () => {
    const prev = getActiveBook();
    const books = getBooks();
    log("[books] books-change event, prev:", prev?.name ?? "none", "prev.vaultId:", prev?.vaultId?.slice(0, 8) ?? "-", "new books:", books.length);
    if (prev) {
      const updated = books.find((b) => b.vaultId === prev.vaultId);
      if (updated) {
        log("[books] preserved active book:", updated.name);
        setActiveBook(updated);
      } else {
        log("[books] active book not found in new list, showing book list");
        setActiveBook(null);
        showBookList();
      }
    }
    renderBookSelect();
    if (manageBooksDialog.open) renderBookManageList();
    renderCatalog();
  });

  // Back button
  (document.getElementById("back-to-books") as HTMLButtonElement).addEventListener("click", showBookList);
  manageBooksBtn.addEventListener("click", () => {
    renderBookManageList();
    openModal(manageBooksDialog);
    (document.getElementById("new-book-name") as HTMLInputElement).focus();
  });

  // Bulk actions
  (document.getElementById("book-bulk-export") as HTMLButtonElement).addEventListener("click", async () => {
    if (selectedBookIds.size === 0) return;
    const ok = await showConfirm(`Export ${selectedBookIds.size} book${selectedBookIds.size !== 1 ? "s" : ""}? Exported files are not encrypted.`, { title: "Export Warning", confirmText: "Export" });
    if (!ok) return;
    try {
      const JSZip = (await import("jszip")).default;
      const { recipeToMarkdown } = await import("../lib/export");
      const zip = new JSZip();
      const books = getBooks();
      const docMgr = getDocMgr();
      let totalRecipes = 0;
      for (const vid of selectedBookIds) {
        const book = books.find((b) => b.vaultId === vid);
        if (!book || !docMgr) continue;
        const catalog = docMgr.get<BookCatalog>(`${book.vaultId}/catalog`);
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

          const recipeDocId = `${book.vaultId}/${meta.id}`;
          let rs = docMgr.get<Recipe>(recipeDocId);
          let needsClose = false;
          if (!rs) { try { rs = await docMgr.open<Recipe>(recipeDocId, (d) => { d.title = meta.title; d.tags = [] as any; d.servings = 4; d.prepMinutes = 0; d.cookMinutes = 0; d.createdAt = 0; d.updatedAt = 0; d.description = ""; d.ingredients = []; d.instructions = ""; d.imageUrls = []; d.notes = ""; }); needsClose = true; } catch { rs = null; } }
          if (rs) {
            const recipe = rs.getDoc();
            folder.file(`${slug}.md`, recipeToMarkdown(recipe));
          }
          if (needsClose) docMgr.close(recipeDocId);
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
    const books = getBooks();
    const owned = [...selectedBookIds].filter((vid) => books.find((b) => b.vaultId === vid)?.role === "owner");
    if (owned.length === 0) { toastWarning("You can only delete books you own."); return; }
    const ok = await showConfirm(`Delete ${owned.length} book${owned.length !== 1 ? "s" : ""}? All recipes will be lost.`, { title: "Delete Books", confirmText: "Delete", danger: true });
    if (!ok) return;
    const syncClient = getSyncClient();
    for (const vid of owned) {
      syncClient?.deleteVault(vid);
      removeBookFromIndex(vid);
      setBooks(getBooks().filter((b) => b.vaultId !== vid));
      if (getActiveBook()?.vaultId === vid) setActiveBook(null);
    }
    if (!getActiveBook()) { if (getBooks().length > 0) switchBook(getBooks()[0]!.vaultId); else showBookList(); }
    renderBookSelect(); renderBookManageList();
    toastSuccess(`Deleted ${owned.length} book${owned.length !== 1 ? "s" : ""}`);
  });

  // Drag-drop import
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => { dropZone.classList.remove("drag-over"); });
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const docMgr = getDocMgr();
    if (!docMgr) { toastWarning("Not logged in."); return; }

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const activeBook = getActiveBook();
    for (const file of Array.from(files)) {
      try {
        if (file.name.endsWith(".zip")) {
          await handleZipImport(file, activeBook ?? undefined);
        } else if (file.name.endsWith(".md")) {
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

  createBookForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ni = document.getElementById("new-book-name") as HTMLInputElement;
    const n = ni.value.trim();
    if (!n) return;
    const book = await createBook(n);
    ni.value = "";
    closeModal(manageBooksDialog);
    if (book) switchBook(book.vaultId);
  });
}
