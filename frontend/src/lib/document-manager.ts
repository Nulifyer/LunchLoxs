/**
 * Multi-document manager — reusable across projects.
 *
 * Manages opening/closing multiple AutomergeStore instances
 * sharing a single IndexedDB connection and encryption key.
 */

import { AutomergeStore, openStoreDB } from "./automerge-store";

export class DocumentManager {
  private db: IDBDatabase;
  private encKey: CryptoKey;
  private stores = new Map<string, AutomergeStore<any>>();

  private constructor(db: IDBDatabase, encKey: CryptoKey) {
    this.db = db;
    this.encKey = encKey;
  }

  static async init(userId: string, encKey: CryptoKey): Promise<DocumentManager> {
    const db = await openStoreDB(userId);
    return new DocumentManager(db, encKey);
  }

  /** Open or get a document by ID. */
  async open<T>(docId: string, initFn: (doc: T) => void): Promise<AutomergeStore<T>> {
    const existing = this.stores.get(docId);
    if (existing) return existing as AutomergeStore<T>;

    const store = await AutomergeStore.open<T>(this.db, docId, this.encKey, initFn);
    this.stores.set(docId, store);
    return store;
  }

  /** Get an already-open store (null if not open). */
  get<T>(docId: string): AutomergeStore<T> | null {
    return (this.stores.get(docId) as AutomergeStore<T>) ?? null;
  }

  /** Check if a document is currently open. */
  isOpen(docId: string): boolean {
    return this.stores.has(docId);
  }

  /** Close a specific document (frees memory, keeps IndexedDB data). */
  close(docId: string): void {
    this.stores.delete(docId);
  }

  /** Close all documents and the database. */
  closeAll(): void {
    this.stores.clear();
    this.db.close();
  }
}
