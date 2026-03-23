/**
 * E2EE crypto module — reusable across projects.
 *
 * Key derivation: Argon2id(passphrase, salt=SHA-256(username))
 *   → 64 bytes split into auth_key (server auth) + enc_key (AES-256-GCM)
 *
 * Encryption: AES-256-GCM with random 12-byte IV per message.
 * Wire format: [12 bytes IV][ciphertext + GCM tag]
 */

// Argon2id via WASM (hash-wasm) — memory-hard, GPU/ASIC resistant
import { argon2id } from "hash-wasm";

export interface DerivedKeys {
  /** SHA-256 hex digest of auth_key — safe to send to server */
  authHash: string;
  /** AES-256-GCM CryptoKey — never leaves the client */
  encKey: CryptoKey;
}

/**
 * Derive auth + encryption keys from username + passphrase.
 * Uses Argon2id (memory=19MiB, iterations=2, parallelism=1) per OWASP recommendations.
 */
export async function deriveKeys(username: string, passphrase: string): Promise<DerivedKeys> {
  // Salt = SHA-256(username) — deterministic per user
  const usernameBytes = new TextEncoder().encode(username);
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", usernameBytes));

  // Argon2id → 64 bytes (returned as hex string)
  const hexHash = await argon2id({
    password: passphrase,
    salt,
    iterations: 2,
    memorySize: 19456,  // 19 MiB
    parallelism: 1,
    hashLength: 64,
    outputType: "hex",
  });

  // Convert hex to Uint8Array
  const kdfOutput = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    kdfOutput[i] = parseInt(hexHash.slice(i * 2, i * 2 + 2), 16);
  }

  // Split: first 32 bytes = auth key, last 32 bytes = encryption key
  const authKeyBytes = kdfOutput.slice(0, 32);
  const encKeyBytes = kdfOutput.slice(32, 64);

  // Auth hash = SHA-256(auth_key) — this is what we send to the server
  const authDigest = await crypto.subtle.digest("SHA-256", authKeyBytes);
  const authHash = Array.from(new Uint8Array(authDigest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Import enc_key as non-extractable AES-GCM CryptoKey
  const encKey = await crypto.subtle.importKey(
    "raw",
    encKeyBytes,
    { name: "AES-GCM" },
    false, // non-extractable — cannot be read back from JS
    ["encrypt", "decrypt"],
  );

  return { authHash, encKey };
}

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
  // Concatenate IV + ciphertext
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);
  return result;
}

/**
 * Decrypt data produced by encrypt().
 * Input: [12-byte IV][ciphertext + GCM tag]
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

/**
 * Derive a stable user_id from username (SHA-256 hex).
 * Server uses this for routing — never sees the actual username.
 */
export async function deriveUserId(username: string): Promise<string> {
  const data = new TextEncoder().encode("user_id:" + username);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
