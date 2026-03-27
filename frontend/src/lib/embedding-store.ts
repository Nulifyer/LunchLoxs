/**
 * IDB persistence for recipe embeddings.
 * Separate database from the main encrypted doc store -- embeddings are
 * derived data and do not need E2E encryption or sync.
 */

const DB_VERSION = 1;
const STORE_NAME = "embeddings";

export interface StoredEmbedding {
  key: string;
  vector: ArrayBuffer;
  textHash: string;
}

let db: IDBDatabase | null = null;

export function openEmbeddingDb(userId: string): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const name = `embeddings-${userId.slice(0, 16)}`;
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      store.createIndex("key", "key", { unique: true });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

export async function loadAll(database: IDBDatabase): Promise<StoredEmbedding[]> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as StoredEmbedding[]);
    req.onerror = () => reject(req.error);
  });
}

export async function getHash(database: IDBDatabase, key: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as StoredEmbedding | undefined)?.textHash ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function putEmbedding(database: IDBDatabase, key: string, vector: ArrayBuffer, textHash: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ key, vector, textHash });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeBook(database: IDBDatabase, vaultId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if ((cursor.key as string).startsWith(vaultId + "/")) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAll(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function closeEmbeddingDb(): void {
  db?.close();
  db = null;
}
