/**
 * Import/export UI handlers.
 */

import { exportBook, importFromZip, parseRecipeMarkdown } from "./lib/export";
import { showConfirm } from "./lib/dialogs";
import { showLoading } from "./lib/spinner";
import { toastSuccess, toastWarning, toastError } from "./lib/toast";
import { getDocMgr, getBooks, getPushQueue } from "./state";
import { renderCatalog } from "./sync/push";
import { createBook, renderBookManageList } from "./ui/books";
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
export async function importRecipesIntoBook(
  book: Book,
  recipes: Array<{ meta: Partial<RecipeMeta>; content: Partial<RecipeContent> }>,
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const docMgr = getDocMgr();
  if (!docMgr) return 0;
  const catalog = docMgr.get<RecipeCatalog>(`${book.vaultId}/catalog`);
  if (!catalog) return 0;

  // Prepare recipe entries with IDs
  const entries = recipes.map(({ meta, content }) => ({
    id: crypto.randomUUID(), now: Date.now(), meta, content,
  }));

  // Batch all catalog additions into a single change (avoids N onChange fires)
  catalog.change((doc) => {
    // Ensure book name is persisted (guards against initFn race during import)
    if (!doc.name) doc.name = book.name;
    if (!doc.recipes) doc.recipes = [];
    for (const { id, now, meta } of entries) {
      doc.recipes.push({ id, title: meta.title ?? "Imported", tags: meta.tags ?? [], servings: meta.servings ?? 4, prepMinutes: meta.prepMinutes ?? 0, cookMinutes: meta.cookMinutes ?? 0, createdAt: meta.createdAt ?? now, updatedAt: meta.updatedAt ?? now });
    }
  });

  // Build content docs
  const contentDocIds: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const { id, content } = entries[i];
    const contentDocId = `${book.vaultId}/${id}`;
    const cs = await docMgr.open<RecipeContent>(contentDocId, (d) => { d.description = content.description ?? ""; d.ingredients = (content.ingredients ?? []) as any; d.instructions = content.instructions ?? ""; d.imageUrls = []; d.notes = content.notes ?? ""; });
    cs.ensureInitialized();
    contentDocIds.push(contentDocId);
    onProgress?.(i + 1, entries.length);
  }

  // Close content stores - dirty flags persist in IndexedDB.
  // The push queue will pick them up and sync in the background.
  for (const docId of contentDocIds) docMgr.close(docId);

  // Kick off background sync (don't await - let the overlay dismiss)
  const pq = getPushQueue();
  if (pq) pq.flushAllDirty();

  return contentDocIds.length;
}

/**
 * Handle a zip import.
 * - If zip has named books (folders with _book.yaml), create a book per folder.
 * - If zip has folders without _book.yaml, create a book per folder using folder name.
 * - If zip has flat .md files (no folders), import into targetBook if provided, or create one.
 */
export async function handleZipImport(file: File, targetBook?: Book): Promise<void> {
  const loading = showLoading("Importing recipes...", 0);
  try {
    loading.update("Reading file...");
    const importedBooks = await importFromZip(file);
    if (importedBooks.length === 0) { toastWarning("No recipes found in file."); return; }

    const totalRecipes = importedBooks.reduce((sum, ib) => sum + ib.recipes.length, 0);
    let totalImported = 0;

    const allRootLevel = importedBooks.length === 1 && importedBooks[0].name === "";
    if (allRootLevel && targetBook) {
      loading.update(`Book: ${targetBook.name}`);
      const progress = (current: number) => {
        loading.updateLine2(`Recipe ${current} / ${totalRecipes}`);
      };
      totalImported = await importRecipesIntoBook(targetBook, importedBooks[0].recipes, progress);
      toastSuccess(`Imported ${totalImported} recipe${totalImported !== 1 ? "s" : ""} into "${targetBook.name}"`);
    } else {
      for (let i = 0; i < importedBooks.length; i++) {
        const ib = importedBooks[i];
        const bookName = ib.name || file.name.replace(/\.zip$/i, "");
        loading.update(`Book ${i + 1} / ${importedBooks.length}: ${bookName}`);
        loading.updateLine2("");
        await createBook(bookName);
        const newBook = getBooks().find((b) => b.name === bookName);
        if (newBook) {
          const progress = (current: number) => {
            loading.updateLine2(`Recipe ${totalImported + current} / ${totalRecipes}`);
          };
          totalImported += await importRecipesIntoBook(newBook, ib.recipes, progress);
        }
      }
      const { renderBookSelect } = await import("./ui/books");
      renderBookSelect();
      toastSuccess(`Imported ${totalImported} recipes into ${importedBooks.length} book${importedBooks.length !== 1 ? "s" : ""}`);
    }
  } finally { loading.dismiss(); }
  renderCatalog();
  renderBookManageList();
}

export async function handleImportToBook(book: Book) {
  const docMgr = getDocMgr();
  if (!docMgr) return;
  const input = document.createElement("input"); input.type = "file"; input.accept = ".zip,.md";
  input.addEventListener("change", async () => {
    const file = input.files?.[0]; if (!file) return;
    const loading = showLoading("Importing recipes...");
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
    } catch (e: any) { toastError("Import failed: " + (e.message ?? e)); } finally { loading.dismiss(); }
  });
  input.click();
}
