/**
 * Offline-first encrypted blob client.
 *
 * Stores encrypted blobs in IndexedDB (same DB as Automerge docs, "docs" store).
 * Syncs to server via HTTP when online. Deduplicates by (vaultId, SHA-256 checksum).
 *
 * Key prefixes in IndexedDB:
 *   blob:{vaultId}/{checksum}      → Uint8Array (encrypted)
 *   blobMeta:{vaultId}/{checksum}  → { mimeType, filename, size }
 *   blobDirty:{vaultId}/{checksum} → true (pending upload)
 */

import { encrypt, decrypt } from "./crypto";
import { getSessionKeys } from "./auth";

const IDB_STORE = "docs";

export interface BlobMeta {
  mimeType: string;
  filename: string;
  size: number;
}

// -- In-memory object URL cache (avoids re-decryption on re-render) --
const urlCache = new Map<string, string>();

/** Revoke all cached object URLs (call on recipe close). */
export function revokeObjectUrls() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

// -- Public API --

/**
 * Process, encrypt, and store a blob locally. Returns the checksum.
 * The blob is marked dirty for later server upload.
 */
export async function storeBlob(
  db: IDBDatabase,
  vaultId: string,
  plaintextBytes: Uint8Array,
  mimeType: string,
  filename: string,
  encKey: CryptoKey,
): Promise<string> {
  const checksum = await sha256Hex(plaintextBytes);
  const encrypted = await encrypt(plaintextBytes, encKey);
  const key = `${vaultId}/${checksum}`;

  await Promise.all([
    idbPut(db, `blob:${key}`, encrypted),
    idbPut(db, `blobMeta:${key}`, { mimeType, filename, size: plaintextBytes.byteLength } as BlobMeta),
    idbPut(db, `blobDirty:${key}`, true),
  ]);

  return checksum;
}

/**
 * Load a blob as an object URL (from cache, IndexedDB, or server).
 * Returns null if the blob can't be found anywhere.
 */
export async function loadBlobUrl(
  db: IDBDatabase,
  vaultId: string,
  checksum: string,
  encKey: CryptoKey,
): Promise<string | null> {
  const key = `${vaultId}/${checksum}`;

  // 1. Memory cache
  const cached = urlCache.get(key);
  if (cached) return cached;

  // 2. IndexedDB
  const local = await idbGet<Uint8Array>(db, `blob:${key}`);
  if (local) {
    return decryptAndCache(key, local, encKey);
  }

  // 3. Server fetch
  const remote = await fetchBlobFromServer(vaultId, checksum);
  if (!remote) return null;

  // Cache in IndexedDB for offline
  await idbPut(db, `blob:${key}`, remote.data);
  if (remote.mimeType) {
    // Only update meta if we don't already have it
    const existing = await idbGet<BlobMeta>(db, `blobMeta:${key}`);
    if (!existing) {
      await idbPut(db, `blobMeta:${key}`, { mimeType: remote.mimeType, filename: "", size: remote.data.byteLength } as BlobMeta);
    }
  }

  return decryptAndCache(key, remote.data, encKey);
}

/** Load blob metadata from IndexedDB. */
export async function loadBlobMeta(
  db: IDBDatabase,
  vaultId: string,
  checksum: string,
): Promise<BlobMeta | null> {
  return (await idbGet<BlobMeta>(db, `blobMeta:${vaultId}/${checksum}`)) ?? null;
}

/**
 * Flush all dirty blobs to the server.
 * Call on reconnect / online event.
 */
export async function flushDirtyBlobs(
  db: IDBDatabase,
  getEncKey: (vaultId: string) => CryptoKey | null,
): Promise<void> {
  const dirtyKeys = await idbGetAllKeysWithPrefix(db, "blobDirty:");

  for (const dirtyKey of dirtyKeys) {
    const blobKey = dirtyKey.slice("blobDirty:".length); // "vaultId/checksum"
    const slash = blobKey.indexOf("/");
    if (slash < 0) continue;

    const vaultId = blobKey.slice(0, slash);
    const checksum = blobKey.slice(slash + 1);

    const encrypted = await idbGet<Uint8Array>(db, `blob:${blobKey}`);
    if (!encrypted) {
      // Blob data missing, clear the dirty flag
      await idbDelete(db, dirtyKey);
      continue;
    }

    const meta = await idbGet<BlobMeta>(db, `blobMeta:${blobKey}`);

    const ok = await uploadBlobToServer(vaultId, checksum, encrypted, meta?.mimeType, meta?.filename);
    if (ok) {
      await idbDelete(db, dirtyKey);
    }
    // On failure, leave dirty — will retry next flush
  }
}

// -- Server communication --

function getApiBase(): string {
  return window.location.origin;
}

function getAuthHeaders(): Record<string, string> {
  const session = getSessionKeys();
  if (!session) return {};
  return {
    "X-User-ID": session.userId,
    "X-Auth-Hash": session.authHash,
  };
}

async function uploadBlobToServer(
  vaultId: string,
  checksum: string,
  encryptedData: Uint8Array,
  mimeType?: string,
  filename?: string,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      ...getAuthHeaders(),
      "Content-Type": "application/octet-stream",
    };
    if (mimeType) headers["X-Blob-Mime-Type"] = mimeType;
    if (filename) headers["X-Blob-Filename"] = filename;

    const body = new Blob([toArrayBuffer(encryptedData)]);
    const resp = await fetch(
      `${getApiBase()}/api/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(checksum)}`,
      { method: "PUT", headers, body },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

async function fetchBlobFromServer(
  vaultId: string,
  checksum: string,
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  try {
    const resp = await fetch(
      `${getApiBase()}/api/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(checksum)}`,
      { headers: getAuthHeaders() },
    );
    if (!resp.ok) return null;
    const data = new Uint8Array(await resp.arrayBuffer());
    const mimeType = resp.headers.get("X-Blob-Mime-Type") ?? "application/octet-stream";
    return { data, mimeType };
  } catch {
    return null;
  }
}

// -- Helpers --

async function decryptAndCache(key: string, encrypted: Uint8Array, encKey: CryptoKey): Promise<string> {
  const plaintext = await decrypt(encrypted, encKey);
  const blob = new Blob([toArrayBuffer(plaintext)]);
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", toArrayBuffer(data));
  const bytes = new Uint8Array(hash);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Copy a Uint8Array into a fresh ArrayBuffer.
 * Needed because bun-types defines Uint8Array.buffer as ArrayBufferLike
 * (which includes SharedArrayBuffer), but DOM APIs require ArrayBuffer.
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

// -- IndexedDB helpers (same "docs" store as automerge-store) --

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbGetAllKeysWithPrefix(db: IDBDatabase, prefix: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
    const req = tx.objectStore(IDB_STORE).getAllKeys(range);
    req.onsuccess = () => resolve((req.result as string[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}
