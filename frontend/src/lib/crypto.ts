/**
 * E2EE crypto module — reusable across projects.
 *
 * Key hierarchy:
 *   passphrase + username → Argon2id → wrapping_key (+ auth_key)
 *   wrapping_key wraps/unwraps → master_key (random, generated once)
 *   master_key encrypts → all data (local storage + sync messages)
 *
 * Password change: re-wrap master_key with new wrapping_key.
 * Data never needs re-encryption.
 *
 * Encryption: AES-256-GCM with random 12-byte IV per message.
 * Wire format: [12 bytes IV][ciphertext + GCM tag]
 */

import { argon2id } from "hash-wasm";

// ── Types ──

export interface DerivedKeys {
  /** SHA-256 hex digest of auth_key — safe to send to server */
  authHash: string;
  /** AES-256-GCM wrapping key — wraps/unwraps the master key */
  wrappingKey: CryptoKey;
}

export interface SessionKeys {
  authHash: string;
  /** The actual data encryption key — used for all encrypt/decrypt ops */
  masterKey: CryptoKey;
  /** Encrypted master key blob — stored locally and on server for other devices */
  wrappedMasterKey: Uint8Array;
}

// ── Key derivation ──

/**
 * Derive wrapping key + auth hash from username + passphrase.
 * The wrapping key is used to wrap/unwrap the master key.
 */
export async function deriveKeys(username: string, passphrase: string): Promise<DerivedKeys> {
  if (!crypto?.subtle) {
    throw new Error("This app requires HTTPS. Please access it over a secure connection.");
  }
  const usernameBytes = new TextEncoder().encode(username.trim().toLowerCase());
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", usernameBytes));

  const hexHash = await argon2id({
    password: passphrase,
    salt,
    iterations: 2,
    memorySize: 19456,
    parallelism: 1,
    hashLength: 64,
    outputType: "hex",
  });

  const kdfOutput = hexToBytes(hexHash);
  const authKeyBytes = kdfOutput.slice(0, 32);
  const wrappingKeyBytes = kdfOutput.slice(32, 64);

  const authDigest = await crypto.subtle.digest("SHA-256", authKeyBytes);
  const authHash = bytesToHex(new Uint8Array(authDigest));

  // Wrapping key needs wrapKey/unwrapKey permissions + encrypt/decrypt for AES-KW fallback
  const wrappingKey = await crypto.subtle.importKey(
    "raw",
    wrappingKeyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  return { authHash, wrappingKey };
}

// ── Master key management ──

/**
 * Generate a new random master key and wrap it with the wrapping key.
 * Called once on first signup.
 */
export async function generateMasterKey(wrappingKey: CryptoKey): Promise<{ masterKey: CryptoKey; wrappedMasterKey: Uint8Array }> {
  // Generate 256-bit random master key
  const rawMasterKey = crypto.getRandomValues(new Uint8Array(32));

  const masterKey = await crypto.subtle.importKey(
    "raw",
    rawMasterKey,
    { name: "AES-GCM" },
    true, // extractable — needed for re-wrapping on password change
    ["encrypt", "decrypt"],
  );

  const wrappedMasterKey = await wrapKey(masterKey, wrappingKey);
  return { masterKey, wrappedMasterKey };
}

/**
 * Unwrap an existing master key using the wrapping key.
 * Called on login when wrapped key exists locally or from server.
 */
export async function unwrapMasterKey(wrappedMasterKey: Uint8Array, wrappingKey: CryptoKey): Promise<CryptoKey> {
  const rawMasterKey = await decrypt(wrappedMasterKey, wrappingKey);
  return crypto.subtle.importKey(
    "raw",
    rawMasterKey,
    { name: "AES-GCM" },
    true, // extractable for re-wrapping
    ["encrypt", "decrypt"],
  );
}

/**
 * Re-wrap the master key with a new wrapping key (password change).
 * Returns the new wrapped blob — data encrypted with master key is unaffected.
 */
export async function rewrapMasterKey(masterKey: CryptoKey, newWrappingKey: CryptoKey): Promise<Uint8Array> {
  return wrapKey(masterKey, newWrappingKey);
}

async function wrapKey(masterKey: CryptoKey, wrappingKey: CryptoKey): Promise<Uint8Array> {
  const rawBytes = await crypto.subtle.exportKey("raw", masterKey);
  return encrypt(new Uint8Array(rawBytes), wrappingKey);
}

// ── Encrypt / Decrypt ──

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns: [12-byte IV][ciphertext + 16-byte GCM tag]
 */
export async function encrypt(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);
  return result;
}

/**
 * Decrypt data produced by encrypt().
 */
export async function decrypt(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

// ── User ID ──

/**
 * Derive a stable user_id from username (SHA-256 hex).
 * Server uses this for routing — never sees the actual username.
 */
export async function deriveUserId(username: string): Promise<string> {
  const data = new TextEncoder().encode("user_id:" + username.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

// ── Helpers ──

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
