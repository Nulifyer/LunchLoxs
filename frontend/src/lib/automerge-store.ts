/**
 * Automerge document store with IndexedDB persistence — reusable across projects.
 *
 * Generic over the document shape. Provides:
 * - CRDT document management (create, change, merge)
 * - Persistent storage in IndexedDB
 * - Change listeners for reactive UI updates
 * - Incremental change extraction for sync
 */

// @ts-ignore — Force base64 entrypoint (Bun's bundler doesn't support WASM imports)
import * as Automerge from "../../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js";

const DB_NAME = "e2ee-automerge";
const DB_VERSION = 1;
const STORE_NAME = "docs";
const DOC_KEY = "primary";
const META_KEY = "last_seq";

type ChangeListener<T> = (doc: Automerge.Doc<T>) => void;

export class AutomergeStore<T> {
  private doc: Automerge.Doc<T>;
  private db: IDBDatabase | null = null;
  private listeners: Set<ChangeListener<T>> = new Set();
  private lastSavedHeads: Automerge.Heads | null = null;

  private constructor(doc: Automerge.Doc<T>) {
    this.doc = doc;
  }

  /**
   * Initialize the store. Loads from IndexedDB if available,
   * otherwise creates a new document with the provided init function.
   */
  static async init<T>(initFn: (doc: T) => void): Promise<AutomergeStore<T>> {
    const db = await openDB();

    // Try to load existing doc from IndexedDB
    const saved = await getFromDB<Uint8Array>(db, DOC_KEY);
    let doc: Automerge.Doc<T>;

    if (saved) {
      doc = Automerge.load<T>(saved);
    } else {
      doc = Automerge.change(Automerge.init<T>(), initFn);
    }

    const store = new AutomergeStore(doc);
    store.db = db;
    store.lastSavedHeads = Automerge.getHeads(doc);
    await store.persist();
    return store;
  }

  /** Get the current read-only document. */
  getDoc(): Automerge.Doc<T> {
    return this.doc;
  }

  /** Apply a local change to the document. */
  change(fn: (doc: T) => void, message?: string): void {
    this.doc = Automerge.change(this.doc, { message }, fn);
    this.persist();
    this.notify();
  }

  /** Apply a remote Automerge change (from another device). */
  applyChange(change: Uint8Array): void {
    const [newDoc] = Automerge.applyChanges(this.doc, [change]);
    this.doc = newDoc;
    this.persist();
    this.notify();
  }

  /** Apply multiple remote changes (e.g., on catchup). */
  applyChanges(changes: Uint8Array[]): void {
    if (changes.length === 0) return;
    const [newDoc] = Automerge.applyChanges(this.doc, changes);
    this.doc = newDoc;
    this.persist();
    this.notify();
  }

  /** Get the last local change (for sending to sync server). */
  getLastLocalChange(): Uint8Array | undefined {
    return Automerge.getLastLocalChange(this.doc);
  }

  /**
   * Get all changes since the document was empty.
   * Useful for initial sync of a new device to the relay.
   */
  getAllChanges(): Uint8Array[] {
    return Automerge.getAllChanges(this.doc);
  }

  /** Save the serialized full document (for snapshot-based sync). */
  save(): Uint8Array {
    return Automerge.save(this.doc);
  }

  /** Load and merge a full document snapshot from another device. */
  merge(otherDoc: Uint8Array): void {
    const other = Automerge.load<T>(otherDoc);
    this.doc = Automerge.merge(this.doc, other);
    this.persist();
    this.notify();
  }

  /** Subscribe to document changes. Returns unsubscribe function. */
  onChange(listener: ChangeListener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Get last seen sync sequence number. */
  async getLastSeq(): Promise<number> {
    if (!this.db) return 0;
    const val = await getFromDB<number>(this.db, META_KEY);
    return val ?? 0;
  }

  /** Store last seen sync sequence number. */
  async setLastSeq(seq: number): Promise<void> {
    if (!this.db) return;
    await putToDB(this.db, META_KEY, seq);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.doc);
    }
  }

  private async persist(): Promise<void> {
    if (!this.db) return;
    const binary = Automerge.save(this.doc);
    await putToDB(this.db, DOC_KEY, binary);
  }
}

// ── IndexedDB helpers ──

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getFromDB<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function putToDB(db: IDBDatabase, key: string, value: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
