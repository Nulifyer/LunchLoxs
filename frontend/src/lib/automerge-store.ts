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

let lastPersistErrorToast = 0;
function notifyPersistError(e: unknown) {
  console.error("persist failed:", e);
  const now = Date.now();
  if (now - lastPersistErrorToast < 10_000) return;
  lastPersistErrorToast = now;
  import("./toast").then(({ toastError }) => {
    toastError("Failed to save changes locally. Your edits may be lost if you close this tab.");
  }).catch(() => {});
}

type ChangeListener<T> = (doc: Automerge.Doc<T>) => void;

export class AutomergeStore<T> {
  private doc: Automerge.Doc<T>;
  private db: IDBDatabase;
  private docId: string;
  private encKey: CryptoKey;
  private listeners: Set<ChangeListener<T>> = new Set();
  private initFn: ((doc: T) => void) | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

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

    const store = new AutomergeStore<T>(doc, db, docId, encKey);
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
    this.enqueuePersistAndMarkDirty();
    this.notify();
    return true;
  }

  getDoc(): Automerge.Doc<T> {
    return this.doc;
  }

  change(fn: (doc: T) => void, message?: string): void {
    this.doc = Automerge.change(this.doc, { message }, fn);
    this.enqueuePersistAndMarkDirty();
    this.notify();
  }

  /** Wait for any pending writes to IndexedDB to complete. */
  async waitForWrite(): Promise<void> {
    await this.pendingWrite;
  }

  applyChange(change: Uint8Array): void {
    const [newDoc] = Automerge.applyChanges(this.doc, [change]);
    this.doc = newDoc;
    this.enqueuePersist();
    this.notify();
  }

  applyChanges(changes: Uint8Array[]): void {
    if (changes.length === 0) return;
    const [newDoc] = Automerge.applyChanges(this.doc, changes);
    this.doc = newDoc;
    this.enqueuePersist();
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
    this.enqueuePersist();
    this.notify();
  }

  async clear(initFn: (doc: T) => void): Promise<void> {
    this.doc = Automerge.change(Automerge.init<T>(), initFn);
    await this.setLastSeq(0);
    await this.clearDirty();
    await this.persist();
    this.notify();
  }

  async markDirty(): Promise<void> {
    await putToDB(this.db, `dirty:${this.docId}`, true);
  }

  async clearDirty(): Promise<void> {
    await deleteToDB(this.db, `dirty:${this.docId}`);
    await deleteToDB(this.db, `pushHeads:${this.docId}`);
  }

  async isDirty(): Promise<boolean> {
    const val = await getFromDB<boolean>(this.db, `dirty:${this.docId}`);
    return val === true;
  }

  /** Get the current Automerge heads (change hashes) as hex strings. */
  getHeads(): string[] {
    return Automerge.getHeads(this.doc);
  }

  /** Store the heads at the time of a push for later comparison. */
  async setPushHeads(heads: string[]): Promise<void> {
    await putToDB(this.db, `pushHeads:${this.docId}`, heads);
  }

  /** Retrieve the heads stored at the last push. */
  async getPushHeads(): Promise<string[] | null> {
    const val = await getFromDB<string[]>(this.db, `pushHeads:${this.docId}`);
    return val ?? null;
  }

  /** Clear stored push heads (e.g. when dirty is cleared). */
  async clearPushHeads(): Promise<void> {
    await deleteToDB(this.db, `pushHeads:${this.docId}`);
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

  /** Enqueue a persist for remote changes (no dirty flag -- remote data shouldn't trigger a push). */
  private enqueuePersist(): void {
    this.pendingWrite = this.pendingWrite
      .then(() => this.persist())
      .catch(notifyPersistError);
  }

  /** Enqueue a write so change() stays synchronous but writes are serialized and tracked. */
  private enqueuePersistAndMarkDirty(): void {
    this.pendingWrite = this.pendingWrite
      .then(() => this.persistAndMarkDirty())
      .catch(notifyPersistError);
  }

  private async persistAndMarkDirty(): Promise<void> {
    const binary = Automerge.save(this.doc);
    const encrypted = await encrypt(binary, this.encKey);
    // Single transaction for both doc + dirty flag
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(encrypted, `doc:${this.docId}`);
      store.put(true, `dirty:${this.docId}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

/** Clear dirty flag and push heads for a doc directly in IndexedDB (works without an open store). */
export function clearDirtyFlag(db: IDBDatabase, docId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(`dirty:${docId}`);
    store.delete(`pushHeads:${docId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Set lastSeq for a doc directly in IndexedDB (works without an open store). */
export function setSeqFlag(db: IDBDatabase, docId: string, seq: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(seq, `seq:${docId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Scan IndexedDB for all doc IDs that have unsent local changes. */
export function getAllDirtyDocIds(db: IDBDatabase): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      const keys = req.result as string[];
      const dirtyIds = keys
        .filter((k) => typeof k === "string" && k.startsWith("dirty:"))
        .map((k) => (k as string).slice(6));
      resolve(dirtyIds);
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Pending vault helpers ──

export interface PendingVault {
  vaultId: string;
  encryptedVaultKey: string;
  senderPublicKey: string;
}

export function setPendingVault(db: IDBDatabase, pv: PendingVault): Promise<void> {
  return putToDB(db, `pendingVault:${pv.vaultId}`, pv);
}

export function clearPendingVault(db: IDBDatabase, vaultId: string): Promise<void> {
  return deleteToDB(db, `pendingVault:${vaultId}`);
}

export function getAllPendingVaults(db: IDBDatabase): Promise<PendingVault[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      const keys = (req.result as string[]).filter((k) => typeof k === "string" && k.startsWith("pendingVault:"));
      if (keys.length === 0) { resolve([]); return; }
      const results: PendingVault[] = [];
      const tx2 = db.transaction(STORE_NAME, "readonly");
      const store2 = tx2.objectStore(STORE_NAME);
      for (const key of keys) {
        const r = store2.get(key);
        r.onsuccess = () => { if (r.result) results.push(r.result); };
      }
      tx2.oncomplete = () => resolve(results);
      tx2.onerror = () => reject(tx2.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Local cache (offline boot) ──

export interface VaultCacheEntry {
  vaultId: string;
  name: string;
  role: string;
  /** Vault key raw bytes, base64-encoded, encrypted with master key */
  wrappedVaultKey: string;
}

export interface LocalCache {
  vaults: VaultCacheEntry[];
  identity: { publicKey: string; wrappedPrivateKey: string };
  signing: { publicKey: string; wrappedPrivateKey: string };
}

const LOCAL_CACHE_KEY = "localCache";

/** Persist vault keys + identity keys encrypted with master key for offline boot. */
export async function saveLocalCache(db: IDBDatabase, masterKey: CryptoKey, cache: LocalCache): Promise<void> {
  const json = JSON.stringify(cache);
  const encoded = new TextEncoder().encode(json);
  const encrypted = await encrypt(encoded, masterKey);
  await putToDB(db, LOCAL_CACHE_KEY, encrypted);
}

/** Load cached vault keys + identity keys. Returns null if missing or decrypt fails. */
export async function loadLocalCache(db: IDBDatabase, masterKey: CryptoKey): Promise<LocalCache | null> {
  const encrypted = await getFromDB<Uint8Array>(db, LOCAL_CACHE_KEY);
  if (!encrypted) return null;
  try {
    const decrypted = await decrypt(encrypted, masterKey);
    const json = new TextDecoder().decode(decrypted);
    return JSON.parse(json) as LocalCache;
  } catch {
    return null;
  }
}

/** Clear the local cache (used on logout). */
export async function clearLocalCache(db: IDBDatabase): Promise<void> {
  await deleteToDB(db, LOCAL_CACHE_KEY);
}

/** Re-encrypt all docs and local cache with a new key (used during master key rotation). */
export async function reEncryptAllDocs(
  db: IDBDatabase,
  oldKey: CryptoKey,
  newKey: CryptoKey,
): Promise<void> {
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const allKeys = await new Promise<string[]>((resolve, reject) => {
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });

  const docKeys = allKeys.filter((k) => typeof k === "string" && k.startsWith("doc:"));

  for (const key of docKeys) {
    const encrypted = await getFromDB<Uint8Array>(db, key);
    if (!encrypted) continue;
    const plaintext = await decrypt(encrypted, oldKey);
    const reEncrypted = await encrypt(plaintext, newKey);
    await putToDB(db, key, reEncrypted);
  }

  // Re-encrypt local cache if present
  const cacheEncrypted = await getFromDB<Uint8Array>(db, LOCAL_CACHE_KEY);
  if (cacheEncrypted) {
    try {
      const plaintext = await decrypt(cacheEncrypted, oldKey);
      const reEncrypted = await encrypt(plaintext, newKey);
      await putToDB(db, LOCAL_CACHE_KEY, reEncrypted);
    } catch { /* cache will be rebuilt on next login */ }
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

function deleteToDB(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
