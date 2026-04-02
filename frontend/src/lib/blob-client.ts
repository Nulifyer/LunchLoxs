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
import { getApiBase } from "./config";

const IDB_STORE = "docs";
const BLOB_META_VERSION = 0x02; // v2: encrypted metadata prepended to blob body

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
  const combined = await packEncryptedBlob(plaintextBytes, mimeType, filename, encKey);
  const key = `${vaultId}/${checksum}`;

  await Promise.all([
    idbPut(db, `blob:${key}`, combined),
    idbPut(db, `blobMeta:${key}`, { mimeType, filename, size: plaintextBytes.byteLength } as BlobMeta),
    idbPut(db, `blobDirty:${key}`, true),
  ]);

  // Attempt immediate upload (best-effort, dirty flag ensures retry on reconnect)
  uploadBlobToServer(vaultId, checksum, combined).then((ok) => {
    if (ok) idbDelete(db, `blobDirty:${key}`);
  });

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
    return unpackAndCache(key, local, encKey, db);
  }

  // 3. Server fetch
  const remote = await fetchBlobFromServer(vaultId, checksum);
  if (!remote) return null;

  // Cache in IndexedDB for offline
  await idbPut(db, `blob:${key}`, remote);

  return unpackAndCache(key, remote, encKey, db);
}

/**
 * Load a blob as decrypted plaintext bytes + metadata (from IDB or server).
 * Used by export to get raw bytes without creating an object URL.
 */
export async function loadBlobDecrypted(
  db: IDBDatabase,
  vaultId: string,
  checksum: string,
  encKey: CryptoKey,
): Promise<{ plaintext: Uint8Array; meta: BlobMeta } | null> {
  const key = `${vaultId}/${checksum}`;

  let raw = await idbGet<Uint8Array>(db, `blob:${key}`);
  if (!raw) {
    const remote = await fetchBlobFromServer(vaultId, checksum);
    if (!remote) return null;
    await idbPut(db, `blob:${key}`, remote);
    raw = remote;
  }

  let plaintext: Uint8Array;
  let meta: BlobMeta = { mimeType: "application/octet-stream", filename: "", size: 0 };

  if (raw[0] === BLOB_META_VERSION && raw.length > 5) {
    const metaLen = new DataView(raw.buffer, raw.byteOffset).getUint32(1);
    plaintext = await decrypt(raw.slice(5 + metaLen), encKey);
    try {
      const metaJson = await decrypt(raw.slice(5, 5 + metaLen), encKey);
      const parsed = JSON.parse(new TextDecoder().decode(metaJson));
      meta = { mimeType: parsed.mimeType ?? meta.mimeType, filename: parsed.filename ?? "", size: plaintext.byteLength };
    } catch { meta.size = plaintext.byteLength; }
  } else {
    plaintext = await decrypt(raw, encKey);
    meta.size = plaintext.byteLength;
    const cached = await idbGet<BlobMeta>(db, `blobMeta:${key}`);
    if (cached) meta = cached;
  }

  return { plaintext, meta };
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

    const blobData = await idbGet<Uint8Array>(db, `blob:${blobKey}`);
    if (!blobData) {
      // Blob data missing, clear the dirty flag
      await idbDelete(db, dirtyKey);
      continue;
    }

    const ok = await uploadBlobToServer(vaultId, checksum, blobData);
    if (ok) {
      await idbDelete(db, dirtyKey);
    }
    // On failure, leave dirty — will retry next flush
  }
}

// -- Server communication --

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
  blobData: Uint8Array,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      ...getAuthHeaders(),
      "Content-Type": "application/octet-stream",
    };

    const body = new Blob([toArrayBuffer(blobData)]);
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
): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(
      `${getApiBase()}/api/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(checksum)}`,
      { headers: getAuthHeaders() },
    );
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

// -- Encrypted blob format helpers --

/**
 * Pack plaintext + metadata into the encrypted wire format:
 *   [1 byte: version 0x02][4 bytes: encrypted meta length (BE)][encrypted meta][encrypted blob]
 */
async function packEncryptedBlob(
  plaintext: Uint8Array,
  mimeType: string,
  filename: string,
  encKey: CryptoKey,
): Promise<Uint8Array> {
  const metaJson = new TextEncoder().encode(JSON.stringify({ mimeType, filename }));
  const encMeta = await encrypt(metaJson, encKey);
  const encBlob = await encrypt(plaintext, encKey);

  const result = new Uint8Array(1 + 4 + encMeta.byteLength + encBlob.byteLength);
  result[0] = BLOB_META_VERSION;
  new DataView(result.buffer).setUint32(1, encMeta.byteLength);
  result.set(encMeta, 5);
  result.set(encBlob, 5 + encMeta.byteLength);
  return result;
}

/**
 * Unpack and decrypt a blob (supports both v2 packed format and legacy raw-encrypted format).
 * Also updates IDB blobMeta cache if meta was found inside the packed format.
 */
async function unpackAndCache(
  key: string,
  data: Uint8Array,
  encKey: CryptoKey,
  db: IDBDatabase,
): Promise<string> {
  let plaintext: Uint8Array;

  if (data[0] === BLOB_META_VERSION && data.length > 5) {
    // v2 format: extract encrypted meta + encrypted blob
    const metaLen = new DataView(data.buffer, data.byteOffset).getUint32(1);
    const encMeta = data.slice(5, 5 + metaLen);
    const encBlob = data.slice(5 + metaLen);

    plaintext = await decrypt(encBlob, encKey);

    // Decrypt and cache metadata
    try {
      const metaJson = await decrypt(encMeta, encKey);
      const meta = JSON.parse(new TextDecoder().decode(metaJson)) as { mimeType: string; filename: string };
      const existing = await idbGet<BlobMeta>(db, `blobMeta:${key}`);
      if (!existing) {
        await idbPut(db, `blobMeta:${key}`, { mimeType: meta.mimeType, filename: meta.filename, size: plaintext.byteLength } as BlobMeta);
      }
    } catch { /* metadata extraction is best-effort */ }
  } else {
    // Legacy format: raw encrypted blob (no embedded metadata)
    plaintext = await decrypt(data, encKey);
  }

  const blob = new Blob([toArrayBuffer(plaintext)]);
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

// -- Helpers --

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
