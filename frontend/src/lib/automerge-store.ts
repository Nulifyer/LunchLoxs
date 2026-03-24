/**
 * Automerge document store with encrypted IndexedDB persistence — reusable across projects.
 *
 * - Data at rest is AES-256-GCM encrypted
 * - Each document has its own IndexedDB key (supports multi-document per user)
 * - CRDT document management (create, change, merge)
 * - Change listeners for reactive UI updates
 */

// @ts-ignore — Force base64 entrypoint (Bun's bundler doesn't support WASM imports)
import * as Automerge from "../../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js";
import { encrypt, decrypt } from "./crypto";

const STORE_NAME = "docs";

type ChangeListener<T> = (doc: Automerge.Doc<T>) => void;

export class AutomergeStore<T> {
  private doc: Automerge.Doc<T>;
  private db: IDBDatabase;
  private docId: string;
  private encKey: CryptoKey;
  private listeners: Set<ChangeListener<T>> = new Set();
  private initFn: ((doc: T) => void) | null = null;

  private constructor(doc: Automerge.Doc<T>, db: IDBDatabase, docId: string, encKey: CryptoKey) {
    this.doc = doc;
    this.db = db;
    this.docId = docId;
    this.encKey = encKey;
  }

  /**
   * Open or create a document.
   * @param db — shared IndexedDB connection
   * @param docId — unique document identifier
   * @param encKey — AES-256-GCM key for encrypting data at rest
   * @param initFn — deferred until ensureInitialized() (after sync catchup)
   */
  static async open<T>(
    db: IDBDatabase,
    docId: string,
    encKey: CryptoKey,
    initFn: (doc: T) => void,
  ): Promise<AutomergeStore<T>> {
    const saved = await getFromDB<Uint8Array>(db, `doc:${docId}`);
    let doc: Automerge.Doc<T>;
    let needsInit = true;

    if (saved) {
      try {
        const plaintext = await decrypt(saved, encKey);
        doc = Automerge.load<T>(plaintext);
        needsInit = false;
      } catch {
        throw new Error("Wrong passphrase — could not decrypt local data.");
      }
    } else {
      doc = Automerge.init<T>();
    }

    const store = new AutomergeStore(doc, db, docId, encKey);
    store.initFn = needsInit ? initFn : null;
    await store.persist();
    return store;
  }

  ensureInitialized(): boolean {
    if (!this.initFn) return false;
    if (Automerge.getAllChanges(this.doc).length > 0) {
      this.initFn = null;
      return false;
    }
    this.doc = Automerge.change(this.doc, this.initFn);
    this.initFn = null;
    this.persist();
    this.notify();
    return true;
  }

  getDoc(): Automerge.Doc<T> {
    return this.doc;
  }

  change(fn: (doc: T) => void, message?: string): void {
    this.doc = Automerge.change(this.doc, { message }, fn);
    this.persist();
    this.notify();
  }

  applyChange(change: Uint8Array): void {
    const [newDoc] = Automerge.applyChanges(this.doc, [change]);
    this.doc = newDoc;
    this.persist();
    this.notify();
  }

  applyChanges(changes: Uint8Array[]): void {
    if (changes.length === 0) return;
    const [newDoc] = Automerge.applyChanges(this.doc, changes);
    this.doc = newDoc;
    this.persist();
    this.notify();
  }

  getLastLocalChange(): Uint8Array | undefined {
    return Automerge.getLastLocalChange(this.doc);
  }

  getAllChanges(): Uint8Array[] {
    return Automerge.getAllChanges(this.doc);
  }

  save(): Uint8Array {
    return Automerge.save(this.doc);
  }

  merge(otherDoc: Uint8Array): void {
    const other = Automerge.load<T>(otherDoc);
    this.doc = Automerge.merge(this.doc, other);
    this.persist();
    this.notify();
  }

  async clear(initFn: (doc: T) => void): Promise<void> {
    this.doc = Automerge.change(Automerge.init<T>(), initFn);
    await this.setLastSeq(0);
    await this.persist();
    this.notify();
  }

  onChange(listener: ChangeListener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getLastSeq(): Promise<number> {
    const val = await getFromDB<number>(this.db, `seq:${this.docId}`);
    return val ?? 0;
  }

  async setLastSeq(seq: number): Promise<void> {
    await putToDB(this.db, `seq:${this.docId}`, seq);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.doc);
    }
  }

  private async persist(): Promise<void> {
    const binary = Automerge.save(this.doc);
    const encrypted = await encrypt(binary, this.encKey);
    await putToDB(this.db, `doc:${this.docId}`, encrypted);
  }
}

// ── Shared IndexedDB opener ──

export function openStoreDB(userId: string): Promise<IDBDatabase> {
  const dbName = `e2ee-${userId.slice(0, 16)}`;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── IndexedDB helpers ──

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
