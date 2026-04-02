/**
 * Vector search orchestrator.
 * Manages the embedding worker, priority queue, and background indexing.
 * Main thread side -- opens/decrypts content docs, sends text to worker.
 */

import { log, warn } from "./logger";
import type { DocumentManager } from "./document-manager";
import type { BookCatalog, Recipe } from "../types";
import {
  openEmbeddingDb, loadAll, getHash, putEmbedding,
  removeBook as removeBookFromDb, clearAll as clearAllFromDb, closeEmbeddingDb,
} from "./embedding-store";
import { getBooks, getDocMgr } from "../state";
import { toastSuccess } from "./toast";

// -- State --

let worker: Worker | null = null;
let embeddingDb: IDBDatabase | null = null;
let modelReady = false;
let indexingComplete = false;
let msgId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

// Priority queue: high priority items at the front
const queue: Array<{ vaultId: string; recipeId: string; priority: "high" | "normal" }> = [];
const queueSet = new Set<string>(); // dedup
let processing = false;
let paused = false;

// Debounce timers for invalidation
const invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Progress tracking
let totalQueued = 0;
let totalProcessed = 0;
let indexingStartTime = 0;

// -- Public API --

export function isVectorSearchReady(): boolean {
  return modelReady;
}

export function isIndexingComplete(): boolean {
  return indexingComplete;
}

export async function initVectorSearch(userId: string): Promise<void> {
  if (worker) return; // already initialized

  log("[vector] initializing");
  embeddingDb = await openEmbeddingDb(userId);

  // Start worker
  worker = new Worker("/embedding-worker.js", { type: "module" });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (e) => warn("[vector] worker error:", e.message);

  // Load existing embeddings into worker
  const stored = await loadAll(embeddingDb);
  if (stored.length > 0) {
    log("[vector] loading", stored.length, "cached embeddings into worker");
    await postWorker("load-embeddings", {
      entries: stored.map((s) => ({ key: s.key, vector: s.vector })),
    });
  }

  updateUI();

  // Start model loading (async, non-blocking)
  postWorker("load-model", { progress: true }).then(() => {
    modelReady = true;
    log("[vector] model loaded");
    updateUI();
    processQueue();
  }).catch((e) => { warn("[vector] model load failed:", e); updateUI(); });

  // Build the initial queue from all catalogs
  buildInitialQueue();

  // Pause when tab is hidden
  document.addEventListener("visibilitychange", () => {
    paused = document.visibilityState === "hidden";
    if (!paused && modelReady) processQueue();
  });
}

export async function vectorSearch(query: string, limit = 15): Promise<Array<{ key: string; score: number }>> {
  if (!worker || !modelReady) return [];
  const result = await postWorker("search", { query, limit });
  return result.hits;
}

export function enqueueRecipe(vaultId: string, recipeId: string, priority: "high" | "normal" = "normal"): void {
  const key = `${vaultId}/${recipeId}`;
  if (queueSet.has(key)) return;
  queueSet.add(key);
  if (!indexingComplete) totalQueued++;
  if (priority === "high") {
    queue.unshift({ vaultId, recipeId, priority });
  } else {
    queue.push({ vaultId, recipeId, priority });
  }
  updateUI();
  if (modelReady && !processing && !paused) processQueue();
}

export function invalidateRecipe(vaultId: string, recipeId: string): void {
  const key = `${vaultId}/${recipeId}`;
  const existing = invalidateTimers.get(key);
  if (existing) clearTimeout(existing);
  invalidateTimers.set(key, setTimeout(() => {
    invalidateTimers.delete(key);
    enqueueRecipe(vaultId, recipeId, "normal");
  }, 5000));
}

export async function removeBook(vaultId: string): Promise<void> {
  if (embeddingDb) await removeBookFromDb(embeddingDb, vaultId);
  if (worker) await postWorker("remove-book", { vaultId });
}

export async function clearAll(): Promise<void> {
  if (embeddingDb) await clearAllFromDb(embeddingDb);
  if (worker) await postWorker("clear", {});
  closeEmbeddingDb();
  embeddingDb = null;
  worker?.terminate();
  worker = null;
  modelReady = false;
  indexingComplete = false;
  queue.length = 0;
  queueSet.clear();
  for (const t of invalidateTimers.values()) clearTimeout(t);
  invalidateTimers.clear();
}

// -- Worker communication --

function postWorker(type: string, data: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error("Worker not initialized"));
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...data });
  });
}

function handleWorkerMessage(e: MessageEvent) {
  const { id, type } = e.data;

  // Progress callback (no id)
  if (type === "model-progress") {
    return;
  }

  if (type === "error") {
    const p = pending.get(id);
    if (p) { pending.delete(id); p.reject(new Error(e.data.error)); }
    return;
  }

  const p = pending.get(id);
  if (p) { pending.delete(id); p.resolve(e.data); }
}

// -- Queue processing --

async function processQueue(): Promise<void> {
  if (processing || !modelReady || paused) return;
  processing = true;
  if (!indexingStartTime) indexingStartTime = Date.now();

  const docMgr = getDocMgr();
  if (!docMgr || !embeddingDb) { processing = false; return; }

  const BATCH_SIZE = 5;

  while (queue.length > 0 && !paused) {
    const batch = queue.splice(0, BATCH_SIZE);
    for (const item of batch) {
      queueSet.delete(`${item.vaultId}/${item.recipeId}`);
      if (!indexingComplete) totalProcessed++;
    }

    const textsToEmbed: Array<{ key: string; text: string }> = [];

    for (const { vaultId, recipeId } of batch) {
      const key = `${vaultId}/${recipeId}`;
      const text = await extractRecipeText(docMgr, vaultId, recipeId);
      if (!text) continue;

      const textHash = simpleHash(text);
      const existingHash = await getHash(embeddingDb!, key);
      if (existingHash === textHash) continue; // already up to date

      textsToEmbed.push({ key, text });
    }

    if (textsToEmbed.length > 0) {
      try {
        const result = await postWorker("embed-batch", { items: textsToEmbed });
        for (const { key, vector } of result.results) {
          const text = textsToEmbed.find((t) => t.key === key)?.text ?? "";
          await putEmbedding(embeddingDb!, key, vector.buffer, simpleHash(text));
        }
      } catch (e) {
        warn("[vector] embed batch failed:", e);
      }
    }

    updateUI();
    // Yield to main thread between batches
    await new Promise((r) => setTimeout(r, 0));
  }

  processing = false;

  if (queue.length === 0 && !indexingComplete) {
    indexingComplete = true;
    log("[vector] initial indexing complete");
    toastSuccess("Smart search ready");
    totalQueued = 0;
    totalProcessed = 0;
    indexingStartTime = 0;
  }
  updateUI();
}

// -- Text extraction --

async function extractRecipeText(docMgr: DocumentManager, vaultId: string, recipeId: string): Promise<string | null> {
  const key = `${vaultId}/${recipeId}`;

  // Get title + tags from catalog
  const catalog = docMgr.get<BookCatalog>(`${vaultId}/catalog`);
  if (!catalog) return null;
  const meta = catalog.getDoc().recipes?.find((r: any) => r.id === recipeId);
  if (!meta) return null;

  let titlePart = meta.title;
  if (meta.tags?.length > 0) titlePart += ". " + meta.tags.join(", ");

  // Open content doc, extract text, close
  let contentText = "";
  let tempOpened = false;
  try {
    let store = docMgr.get<Recipe>(key);
    if (!store) {
      store = await docMgr.open<Recipe>(key, (doc) => {
        doc.description = ""; doc.ingredients = []; doc.instructions = ""; doc.imageUrls = []; doc.notes = "";
      });
      tempOpened = true;
    }
    const doc = store.getDoc();
    const parts: string[] = [];
    if (doc.description) parts.push(doc.description);
    if (doc.ingredients?.length > 0) {
      parts.push("Ingredients: " + doc.ingredients.map((i: any) => i.item).join(", "));
    }
    if (doc.instructions) parts.push(doc.instructions);
    if (doc.notes) parts.push(doc.notes);
    contentText = parts.join(". ");
    if (tempOpened) docMgr.close(key);
  } catch {
    // Content doc not available (not yet synced)
    if (tempOpened) docMgr.close(key);
  }

  const fullText = titlePart + (contentText ? ". " + contentText : "");
  // Truncate to ~512 tokens worth (~2000 chars) for embedding quality
  return fullText.slice(0, 2000);
}

// -- Initial queue building --

function buildInitialQueue(): void {
  const books = getBooks();
  const docMgr = getDocMgr();
  if (!docMgr) return;

  let count = 0;
  for (const book of books) {
    const catalog = docMgr.get<BookCatalog>(`${book.vaultId}/catalog`);
    if (!catalog) continue;
    const recipes = catalog.getDoc().recipes ?? [];
    for (const r of recipes) {
      enqueueRecipe(book.vaultId, r.id, "normal");
      count++;
    }
  }
  if (count > 0) log("[vector] queued", count, "recipes for indexing");
}

// -- Utility --

function formatEta(processed: number, total: number, startTime: number): string | null {
  if (processed < 10 || !startTime) return null; // need enough samples
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = processed / elapsed;
  const remaining = Math.ceil((total - processed) / rate);
  if (remaining < 5) return null;
  if (remaining < 60) return `${remaining}s`;
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return text.length + ":" + h.toString(36);
}

function updateUI(): void {
  const hasWork = queue.length > 0 || (processing && !indexingComplete);
  const isLoading = !modelReady;

  // Search bar spinner
  const spinner = document.getElementById("vector-spinner");
  if (spinner) spinner.hidden = !hasWork && !isLoading;

  // Footer status
  const footer = document.getElementById("vector-status");
  if (!footer) return;
  if (isLoading) {
    footer.hidden = false;
    footer.textContent = "loading model";
  } else if (hasWork && totalQueued > 0) {
    footer.hidden = false;
    const eta = formatEta(totalProcessed, totalQueued, indexingStartTime);
    footer.textContent = eta ? `${totalProcessed}/${totalQueued} ~${eta}` : `${totalProcessed}/${totalQueued}`;
  } else {
    footer.hidden = true;
  }
}
