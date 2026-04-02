/**
 * Recipe CRUD, selection, detail callbacks, add/edit form handlers.
 */

import { log, warn, error } from "../lib/logger";
import { initRecipeList } from "../views/recipe-list";
import { initRecipeDetail, openRecipe, closeRecipe, setIngredientSuggestions } from "../views/recipe-detail";
import { recipeToMarkdown } from "../lib/export";
import { showConfirm, showSelect } from "../lib/dialogs";
import { openModal, closeModal } from "../lib/modal";
import { toastSuccess, toastWarning, toastError } from "../lib/toast";
import {
  getDocMgr, getSyncClient, getActiveBook, getBooks,
  getSelectedRecipeId, setSelectedRecipeId, getCurrentUsername,
} from "../state";
import { pushSnapshot, renderCatalog, catalogDocId } from "../sync/push";
import { canEditActiveBook } from "../sync/vault-helpers";
import { switchBook } from "../ui/books";
import type { BookCatalog, CatalogEntry, Recipe } from "../types";
import type { TagInput } from "../components/tag-input";

export async function selectRecipe(id: string) {
  const docMgr = getDocMgr();
  const activeBook = getActiveBook();
  if (!docMgr || !activeBook) return;
  log("[selectRecipe]", id);

  // Clean up previous recipe subscription/store if switching directly
  const prevId = getSelectedRecipeId();
  if (prevId && prevId !== id) {
    const prevDocId = `${activeBook.vaultId}/${prevId}`;
    getSyncClient()?.unsubscribe(prevDocId);
    docMgr.close(prevDocId);
  }

  const accountPage = document.getElementById("account-page") as HTMLElement;
  const appShell = document.getElementById("app-shell") as HTMLElement;
  accountPage.hidden = true;
  setSelectedRecipeId(id);
  appShell.classList.add("detail-open");

  // Show skeleton immediately while recipe loads
  const detailView = document.getElementById("recipe-detail") as HTMLElement;
  const skeleton = document.getElementById("recipe-detail-skeleton") as HTMLElement;
  const emptyState = document.getElementById("empty-state") as HTMLElement;
  emptyState.hidden = true;
  detailView.hidden = false;
  skeleton.hidden = false;

  renderCatalog();
  const recipeDocId = `${activeBook.vaultId}/${id}`;
  const recipeStore = await docMgr.open<Recipe>(recipeDocId, (doc) => {
    doc.title = ""; doc.tags = []; doc.servings = 4; doc.prepMinutes = 0; doc.cookMinutes = 0;
    doc.createdAt = Date.now(); doc.updatedAt = Date.now();
    doc.description = ""; doc.ingredients = []; doc.instructions = ""; doc.imageUrls = []; doc.notes = "";
  });
  getSyncClient()?.subscribe(recipeDocId);

  // Reconcile catalog ↔ recipe doc title/tags.
  // Recipe doc is source of truth; catalog is a derived cache.
  const recipe = recipeStore.getDoc();
  const catalog = docMgr.get<BookCatalog>(catalogDocId());
  const catalogEntry = catalog?.getDoc()?.recipes?.find((r: any) => r.id === id);
  if (!recipe.title && catalogEntry?.title) {
    // Migration: recipe doc empty but catalog has old-format meta — seed the doc
    recipeStore.change((doc) => {
      doc.title = catalogEntry.title;
      doc.tags = (catalogEntry.tags ?? []) as any;
      const old = catalogEntry as any;
      if (old.servings) doc.servings = old.servings;
      if (old.prepMinutes) doc.prepMinutes = old.prepMinutes;
      if (old.cookMinutes) doc.cookMinutes = old.cookMinutes;
      if (old.createdAt) doc.createdAt = old.createdAt;
      if (old.updatedAt) doc.updatedAt = old.updatedAt;
    });
    pushSnapshot(recipeDocId);
  } else if (recipe.title && catalog && catalogEntry) {
    // Recipe doc has data — ensure catalog matches (fixes historical divergence)
    if (catalogEntry.title !== recipe.title || JSON.stringify(catalogEntry.tags ?? []) !== JSON.stringify(recipe.tags ?? [])) {
      catalog.change((doc) => {
        const entry = doc.recipes?.find((r: any) => r.id === id);
        if (entry) { entry.title = recipe.title; entry.tags = (recipe.tags ?? []) as any; }
      });
      pushSnapshot(catalogDocId());
      renderCatalog();
    }
  }

  openRecipe(recipeStore, id, canEditActiveBook(), activeBook?.name, getAllTags());
  // Load ingredient suggestions in background (don't block rendering or onChange registration)
  getAllIngredientNames().then((names) => setIngredientSuggestions(names)).catch(() => {});
  // Prioritize this recipe for vector indexing (if stale)
  import("../lib/vector-search").then(({ enqueueRecipe }) => enqueueRecipe(activeBook.vaultId, id, "high")).catch(() => {});
}

export function deselectRecipe() {
  const selectedRecipeId = getSelectedRecipeId();
  const syncClient = getSyncClient();
  const activeBook = getActiveBook();
  const docMgr = getDocMgr();
  if (selectedRecipeId && syncClient && activeBook) {
    syncClient.unsubscribe(`${activeBook.vaultId}/${selectedRecipeId}`);
    docMgr?.close(`${activeBook.vaultId}/${selectedRecipeId}`);
  }
  setSelectedRecipeId(null);
  closeRecipe();
  const appShell = document.getElementById("app-shell") as HTMLElement;
  appShell.classList.remove("detail-open");
  renderCatalog();
}

/** Collect all unique tags from the active book's catalog. */
function getAllTags(): string[] {
  const docMgr = getDocMgr();
  const activeBook = getActiveBook();
  if (!docMgr || !activeBook) return [];
  const catalog = docMgr.get<BookCatalog>(catalogDocId());
  if (!catalog) return [];
  const recipes = catalog.getDoc()?.recipes ?? [];
  const set = new Set<string>();
  for (const r of recipes) for (const t of r.tags ?? []) set.add(t.toLowerCase());
  return [...set].sort();
}

/** Collect all unique ingredient names from every recipe in the active book. */
async function getAllIngredientNames(): Promise<string[]> {
  const docMgr = getDocMgr();
  const activeBook = getActiveBook();
  if (!docMgr || !activeBook) return [];
  const catalog = docMgr.get<BookCatalog>(catalogDocId());
  if (!catalog) return [];
  const entries = catalog.getDoc()?.recipes ?? [];
  const set = new Set<string>();
  const initRecipe = (doc: Recipe) => {
    doc.title = ""; doc.tags = []; doc.servings = 4; doc.prepMinutes = 0; doc.cookMinutes = 0;
    doc.createdAt = Date.now(); doc.updatedAt = Date.now();
    doc.description = ""; doc.ingredients = []; doc.instructions = ""; doc.imageUrls = []; doc.notes = "";
  };
  await Promise.all(entries.map(async (entry: CatalogEntry) => {
    try {
      const store = await docMgr.open<Recipe>(`${activeBook.vaultId}/${entry.id}`, initRecipe);
      const doc = store.getDoc();
      for (const ing of doc.ingredients ?? []) {
        const name = ing.item?.trim().toLowerCase();
        if (name) set.add(name);
      }
    } catch { /* skip recipes that fail to load */ }
  }));
  return [...set].sort();
}

export function initRecipes() {
  const addDialog = document.getElementById("add-recipe-dialog") as HTMLDialogElement;
  const addForm = document.getElementById("add-recipe-form") as HTMLFormElement;
  const newTagInput = document.getElementById("new-tags") as TagInput;

  // -- Recipe list callbacks --
  initRecipeList({
    onSelect: (recipeId: string, vaultId?: string) => {
      // If from cross-book search, switch book first
      if (vaultId && vaultId !== getActiveBook()?.vaultId) {
        switchBook(vaultId).then(() => selectRecipe(recipeId));
      } else {
        selectRecipe(recipeId);
      }
    },
    onAdd: () => {
      if (!getActiveBook()) { toastWarning("Create a book first."); return; }
      if (!canEditActiveBook()) { toastWarning("You don't have edit access to this book."); return; }
      newTagInput.suggestions = getAllTags();
      openModal(addDialog);
    },
  });

  // -- Recipe detail callbacks --
  initRecipeDetail({
    onBack: () => deselectRecipe(),
    onContentChanged: () => {
      const selectedRecipeId = getSelectedRecipeId();
      const activeBook = getActiveBook();
      const docMgr = getDocMgr();
      if (selectedRecipeId && activeBook && docMgr) {
        const recipeStore = docMgr.get<Recipe>(`${activeBook.vaultId}/${selectedRecipeId}`);
        if (recipeStore) recipeStore.change((doc) => { doc.updatedAt = Date.now(); });
        pushSnapshot(`${activeBook.vaultId}/${selectedRecipeId}`);
        import("../lib/vector-search").then(({ invalidateRecipe }) => invalidateRecipe(activeBook.vaultId, selectedRecipeId)).catch(() => {});
      }
    },
    onSendPresence: (data) => {
      const selectedRecipeId = getSelectedRecipeId();
      const syncClient = getSyncClient();
      const activeBook = getActiveBook();
      if (selectedRecipeId && syncClient && activeBook) {
        const docId = `${activeBook.vaultId}/${selectedRecipeId}`;
        data.username = getCurrentUsername();
        if (data._stage) {
          delete data._stage;
          syncClient.stagePresence(docId, data);
        } else {
          syncClient.sendPresence(docId, data);
        }
      }
    },
    onMetaChanged: (title, tags) => {
      const selectedRecipeId = getSelectedRecipeId();
      const docMgr = getDocMgr();
      const activeBook = getActiveBook();
      if (!selectedRecipeId || !docMgr || !activeBook) return;
      // Push the recipe doc (meta was already written by flushMeta)
      pushSnapshot(`${activeBook.vaultId}/${selectedRecipeId}`);
      // Mirror title + tags to catalog for sidebar
      const catalog = docMgr.get<BookCatalog>(catalogDocId());
      if (!catalog) return;
      catalog.change((doc) => {
        const entry = doc.recipes?.find((r: any) => r.id === selectedRecipeId);
        if (entry) { entry.title = title; entry.tags = tags as any; }
      });
      pushSnapshot(catalogDocId());
      renderCatalog();
    },
    onDeleteRecipe: async () => {
      const selectedRecipeId = getSelectedRecipeId();
      const docMgr = getDocMgr();
      const activeBook = getActiveBook();
      if (!selectedRecipeId || !docMgr || !activeBook) return;
      const del = await showConfirm("Delete this recipe? This cannot be undone.", { title: "Delete Recipe", confirmText: "Delete", danger: true });
      if (!del) return;
      const id = selectedRecipeId; deselectRecipe();
      const catalog = docMgr.get<BookCatalog>(catalogDocId()); if (!catalog) return;
      catalog.change((doc) => { const idx = doc.recipes.findIndex((r: any) => r.id === id); if (idx !== -1) doc.recipes.splice(idx, 1); });
      pushSnapshot(catalogDocId());
    },
    onExportRecipe: async () => {
      const selectedRecipeId = getSelectedRecipeId();
      const docMgr = getDocMgr();
      const activeBook = getActiveBook();
      if (!selectedRecipeId || !docMgr || !activeBook) return;
      const ok = await showConfirm("Exported files are not encrypted. Anyone with the file can read this recipe.", { title: "Export Warning", confirmText: "Export" });
      if (!ok) return;
      const recipeStore = docMgr.get<Recipe>(`${activeBook.vaultId}/${selectedRecipeId}`);
      if (!recipeStore) return;
      const recipe = recipeStore.getDoc();
      const md = recipeToMarkdown(recipe);
      const blob = new Blob([md], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${recipe.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
      toastSuccess("Recipe exported as markdown");
    },
    onCopyToBook: async () => {
      const selectedRecipeId = getSelectedRecipeId();
      const docMgr = getDocMgr();
      const activeBook = getActiveBook();
      const books = getBooks();
      if (!selectedRecipeId || !docMgr || !activeBook || books.length < 2) {
        toastWarning("No other books to copy to.");
        return;
      }
      const otherBooks = books.filter((b) => b.vaultId !== activeBook!.vaultId && (b.role === "owner" || b.role === "editor"));
      if (otherBooks.length === 0) { toastWarning("No books you can edit."); return; }
      const pick = await showSelect(
        otherBooks.map((b) => ({ value: b.vaultId, label: b.name })),
        { title: "Copy to Book" },
      );
      if (!pick) return;
      const targetBook = otherBooks.find((b) => b.vaultId === pick);
      if (!targetBook) return;
      // Get source recipe
      const srcStore = docMgr.get<Recipe>(`${activeBook.vaultId}/${selectedRecipeId}`);
      if (!srcStore) return;
      const src = srcStore.getDoc();
      // Create in target book
      const newId = crypto.randomUUID();
      const targetCatalog = docMgr.get<BookCatalog>(`${targetBook.vaultId}/catalog`);
      if (!targetCatalog) { toastWarning("Open the target book first."); return; }
      const now = Date.now();
      // Add catalog entry
      targetCatalog.change((doc) => {
        if (!doc.recipes) doc.recipes = [];
        doc.recipes.push({ id: newId, title: src.title, tags: [...(src.tags ?? [])] });
      });
      // Create full recipe doc
      const newStore = await docMgr.open<Recipe>(`${targetBook.vaultId}/${newId}`, (doc) => {
        doc.title = src.title; doc.tags = (src.tags ?? []) as any;
        doc.servings = src.servings; doc.prepMinutes = src.prepMinutes; doc.cookMinutes = src.cookMinutes;
        doc.createdAt = now; doc.updatedAt = now;
        doc.description = src.description ?? "";
        doc.ingredients = (src.ingredients ?? []) as any;
        doc.instructions = src.instructions ?? "";
        doc.imageUrls = [];
        doc.notes = src.notes ?? "";
      });
      newStore.ensureInitialized();
      pushSnapshot(`${targetBook.vaultId}/${newId}`);
      pushSnapshot(`${targetBook.vaultId}/catalog`);
      docMgr.close(`${targetBook.vaultId}/${newId}`);
      toastSuccess(`Copied to "${targetBook.name}"`);
    },
    onSyncCatalogMeta: (title, tags) => {
      const selectedRecipeId = getSelectedRecipeId();
      const docMgr = getDocMgr();
      const activeBook = getActiveBook();
      if (!selectedRecipeId || !docMgr || !activeBook) return;
      const catalog = docMgr.get<BookCatalog>(catalogDocId());
      if (!catalog) return;
      const entry = catalog.getDoc()?.recipes?.find((r: any) => r.id === selectedRecipeId);
      if (!entry) return;
      // Only write if actually different to avoid unnecessary pushes
      if (entry.title === title && JSON.stringify(entry.tags) === JSON.stringify(tags)) return;
      catalog.change((doc) => {
        const e = doc.recipes?.find((r: any) => r.id === selectedRecipeId);
        if (e) { e.title = title; e.tags = tags as any; }
      });
      pushSnapshot(catalogDocId());
      renderCatalog();
    },
    onNavigateToRecipe: (recipeId: string) => {
      selectRecipe(recipeId);
    },
  });

  // -- Add recipe --
  addForm.addEventListener("submit", async () => {
    const docMgr = getDocMgr();
    const activeBook = getActiveBook();
    const ti = document.getElementById("new-title") as HTMLInputElement;
    const title = ti.value.trim(); if (!title || !docMgr || !activeBook) return;
    const id = crypto.randomUUID();
    const tags = newTagInput.value;
    const now = Date.now();
    const servings = parseInt((document.getElementById("new-servings") as HTMLInputElement).value) || 4;
    const prepMinutes = parseInt((document.getElementById("new-prep") as HTMLInputElement).value) || 0;
    const cookMinutes = parseInt((document.getElementById("new-cook") as HTMLInputElement).value) || 0;
    // Add minimal entry to catalog
    const catalog = docMgr.get<BookCatalog>(catalogDocId()); if (!catalog) return;
    catalog.change((doc) => {
      if (!doc.recipes) doc.recipes = [];
      doc.recipes.push({ id, title, tags });
    });
    pushSnapshot(catalogDocId());
    // Init full recipe doc with meta + empty content
    const recipeDocId = `${activeBook.vaultId}/${id}`;
    const recipeStore = await docMgr.open<Recipe>(recipeDocId, (doc) => {
      doc.title = title; doc.tags = tags as any; doc.servings = servings;
      doc.prepMinutes = prepMinutes; doc.cookMinutes = cookMinutes;
      doc.createdAt = now; doc.updatedAt = now;
      doc.description = ""; doc.ingredients = []; doc.instructions = ""; doc.imageUrls = []; doc.notes = "";
    });
    recipeStore.ensureInitialized();
    pushSnapshot(recipeDocId);
    selectRecipe(id);
  });

  // Reset all dialog forms on close
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("close", () => {
      for (const form of dialog.querySelectorAll("form")) form.reset();
      for (const ti of dialog.querySelectorAll("tag-input")) (ti as TagInput).value = [];
    });
  }

  // Forms with method=dialog close the modal on submit
  for (const form of document.querySelectorAll("form[method=dialog]")) {
    form.addEventListener("submit", () => {
      const dialog = form.closest("dialog") as HTMLDialogElement;
      if (dialog) closeModal(dialog);
    });
  }

  // Dialog close buttons
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".dialog-close-btn");
    if (btn) {
      const dialog = btn.closest("dialog") as HTMLDialogElement;
      if (dialog) closeModal(dialog);
    }
  });
}
