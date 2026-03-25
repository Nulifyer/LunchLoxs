/**
 * Recipe CRUD, selection, detail callbacks, add/edit form handlers.
 */

import { log, warn, error } from "../lib/logger";
import { initRecipeList } from "../views/recipe-list";
import { initRecipeDetail, openRecipe, closeRecipe } from "../views/recipe-detail";
import { indexRecipeContent } from "../lib/search";
import { recipeToMarkdown } from "../lib/export";
import { showConfirm, showPrompt } from "../lib/dialogs";
import { openModal, closeModal } from "../lib/modal";
import { toastSuccess, toastWarning, toastError } from "../lib/toast";
import {
  getDocMgr, getSyncClient, getActiveBook, getBooks,
  getSelectedRecipeId, setSelectedRecipeId,
} from "../state";
import { pushSnapshot, renderCatalog, catalogDocId } from "../sync/push";
import { canEditActiveBook } from "../sync/vault-helpers";
import { switchBook } from "../ui/books";
import type { RecipeCatalog, RecipeContent, Book } from "../types";

export async function selectRecipe(id: string) {
  const docMgr = getDocMgr();
  const syncClient = getSyncClient();
  const activeBook = getActiveBook();
  if (!docMgr || !syncClient || !activeBook) return;
  log("[selectRecipe]", id);
  const accountPage = document.getElementById("account-page") as HTMLElement;
  const appShell = document.getElementById("app-shell") as HTMLElement;
  accountPage.hidden = true;
  setSelectedRecipeId(id);
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

export function initRecipes() {
  const addDialog = document.getElementById("add-recipe-dialog") as HTMLDialogElement;
  const addForm = document.getElementById("add-recipe-form") as HTMLFormElement;
  const editDialog = document.getElementById("edit-recipe-dialog") as HTMLDialogElement;
  const editForm = document.getElementById("edit-recipe-form") as HTMLFormElement;

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
      openModal(addDialog);
    },
  });

  // -- Recipe detail callbacks --
  initRecipeDetail({
    onBack: deselectRecipe,
    onPushSnapshot: () => {
      const selectedRecipeId = getSelectedRecipeId();
      const activeBook = getActiveBook();
      if (selectedRecipeId && activeBook) pushSnapshot(`${activeBook.vaultId}/${selectedRecipeId}`);
    },
    onSendPresence: (data) => {
      const selectedRecipeId = getSelectedRecipeId();
      const syncClient = getSyncClient();
      const activeBook = getActiveBook();
      if (selectedRecipeId && syncClient && activeBook) syncClient.sendPresence(`${activeBook.vaultId}/${selectedRecipeId}`, data);
    },
    onEditRecipe: () => {
      const selectedRecipeId = getSelectedRecipeId();
      const docMgr = getDocMgr();
      const activeBook = getActiveBook();
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
      const selectedRecipeId = getSelectedRecipeId();
      const docMgr = getDocMgr();
      const activeBook = getActiveBook();
      if (!selectedRecipeId || !docMgr || !activeBook) return;
      const del = await showConfirm("Delete this recipe? This cannot be undone.", { title: "Delete Recipe", confirmText: "Delete", danger: true });
      if (!del) return;
      const id = selectedRecipeId; deselectRecipe();
      const catalog = docMgr.get<RecipeCatalog>(catalogDocId()); if (!catalog) return;
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
    const docMgr = getDocMgr();
    const activeBook = getActiveBook();
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
    const selectedRecipeId = getSelectedRecipeId();
    const docMgr = getDocMgr();
    const activeBook = getActiveBook();
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
