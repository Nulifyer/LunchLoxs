/**
 * Import/export UI handlers.
 */

import { log, error } from "./lib/logger";
import { exportBook, importFromZip, recipeToMarkdown, parseRecipeMarkdown } from "./lib/export";
import { showConfirm } from "./lib/dialogs";
import { showLoading } from "./lib/spinner";
import { toastSuccess, toastWarning, toastError } from "./lib/toast";
import { getDocMgr, getSyncClient } from "./state";
import { pushSnapshot, renderCatalog } from "./sync/push";
import { createBook, renderBookManageList } from "./ui/books";
import { getBooks } from "./state";
import type { Book, RecipeCatalog, RecipeContent, RecipeMeta } from "./types";

export async function handleExportBook(book: Book) {
  const docMgr = getDocMgr();
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
export async function importRecipesIntoBook(book: Book, recipes: Array<{ meta: Partial<RecipeMeta>; content: Partial<RecipeContent> }>): Promise<number> {
  const docMgr = getDocMgr();
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
export async function handleZipImport(file: File, targetBook?: Book): Promise<void> {
  const dismiss = showLoading("Importing recipes...");
  try {
    const importedBooks = await importFromZip(file);
    if (importedBooks.length === 0) { toastWarning("No recipes found in file."); return; }

    let totalImported = 0;
    const books = getBooks();

    const allRootLevel = importedBooks.length === 1 && importedBooks[0].name === "";
    if (allRootLevel && targetBook) {
      totalImported = await importRecipesIntoBook(targetBook, importedBooks[0].recipes);
      toastSuccess(`Imported ${totalImported} recipe${totalImported !== 1 ? "s" : ""} into "${targetBook.name}"`);
    } else {
      for (const ib of importedBooks) {
        const bookName = ib.name || file.name.replace(/\.zip$/i, "");
        await createBook(bookName);
        const newBook = getBooks().find((b) => b.name === bookName);
        if (newBook) {
          totalImported += await importRecipesIntoBook(newBook, ib.recipes);
        }
      }
      const { renderBookSelect } = await import("./ui/books");
      renderBookSelect();
      toastSuccess(`Imported ${totalImported} recipes into ${importedBooks.length} book${importedBooks.length !== 1 ? "s" : ""}`);
    }
  } finally { dismiss(); }
  renderCatalog();
  renderBookManageList();
}

export async function handleImportToBook(book: Book) {
  const docMgr = getDocMgr();
  const syncClient = getSyncClient();
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
