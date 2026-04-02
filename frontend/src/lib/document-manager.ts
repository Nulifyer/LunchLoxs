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
  /** Prevents concurrent opens for the same docId from creating duplicate stores. */
  private opening = new Map<string, Promise<AutomergeStore<any>>>();

  private constructor(db: IDBDatabase, encKey: CryptoKey) {
    this.db = db;
    this.encKey = encKey;
  }

  static async init(userId: string, encKey: CryptoKey): Promise<DocumentManager> {
    const db = await openStoreDB(userId);
    return new DocumentManager(db, encKey);
  }

  /** Open or get a document by ID (uses default master key for encryption). */
  async open<T>(docId: string, initFn: (doc: T) => void): Promise<AutomergeStore<T>> {
    const existing = this.stores.get(docId);
    if (existing) return existing as AutomergeStore<T>;

    const pending = this.opening.get(docId);
    if (pending) return pending as Promise<AutomergeStore<T>>;

    const promise = AutomergeStore.open<T>(this.db, docId, this.encKey, initFn).then((store) => {
      this.opening.delete(docId);
      this.stores.set(docId, store);
      return store;
    });
    this.opening.set(docId, promise);
    return promise;
  }

  /** Open a document with a specific encryption key (for vault-scoped docs). */
  async openWithKey<T>(docId: string, encKey: CryptoKey, initFn: (doc: T) => void): Promise<AutomergeStore<T>> {
    const existing = this.stores.get(docId);
    if (existing) return existing as AutomergeStore<T>;

    const pending = this.opening.get(docId);
    if (pending) return pending as Promise<AutomergeStore<T>>;

    const promise = AutomergeStore.open<T>(this.db, docId, encKey, initFn).then((store) => {
      this.opening.delete(docId);
      this.stores.set(docId, store);
      return store;
    });
    this.opening.set(docId, promise);
    return promise;
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
  async close(docId: string): Promise<void> {
    const store = this.stores.get(docId);
    if (store) {
      await store.waitForWrite();
      this.stores.delete(docId);
    }
  }

  /** Close all documents and the database. */
  async closeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.stores.values()).map((s) => s.waitForWrite())
    );
    this.stores.clear();
    this.db.close();
  }

  /** Get the underlying IndexedDB connection. */
  getDb(): IDBDatabase {
    return this.db;
  }

  /** Update the default encryption key (used after master key rotation). */
  updateEncKey(encKey: CryptoKey): void {
    this.encKey = encKey;
  }
}
