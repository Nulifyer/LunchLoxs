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
    iterations: 3,
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

/**
 * Legacy key derivation (iterations=2) for migrating existing users.
 * Try current deriveKeys first; if login fails, fall back to this,
 * then rewrap + update server credentials to migrate transparently.
 */
export async function deriveKeysLegacy(username: string, passphrase: string): Promise<DerivedKeys> {
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

  const wrappingKey = await crypto.subtle.importKey(
    "raw", wrappingKeyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"],
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
    rawMasterKey as BufferSource,
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

/**
 * Rotate the master key: generate a fresh master key and wrap it with the new wrapping key.
 * Used during password change for true key rotation — all data must be re-encrypted.
 */
export async function rotateMasterKey(
  oldMasterKey: CryptoKey,
  newWrappingKey: CryptoKey,
): Promise<{ masterKey: CryptoKey; wrappedMasterKey: Uint8Array }> {
  const { masterKey, wrappedMasterKey } = await generateMasterKey(newWrappingKey);
  return { masterKey, wrappedMasterKey };
}

async function wrapKey(masterKey: CryptoKey, wrappingKey: CryptoKey): Promise<Uint8Array> {
  const rawBytes = await crypto.subtle.exportKey("raw", masterKey);
  return encrypt(new Uint8Array(rawBytes), wrappingKey);
}

// ── Identity keypair (ECDH P-256) ──

/**
 * Generate an ECDH P-256 identity keypair for key exchange.
 * Returns the raw public key (for sharing) and the private key (to encrypt locally).
 */
export async function generateIdentityKeypair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  return { publicKey: pubRaw, privateKey: privPkcs8 };
}

/**
 * Wrap (encrypt) a private key with the master key for safe storage.
 */
export async function wrapPrivateKey(privateKey: Uint8Array, masterKey: CryptoKey): Promise<Uint8Array> {
  return encrypt(privateKey, masterKey);
}

/**
 * Unwrap (decrypt) a private key using the master key.
 */
export async function unwrapPrivateKey(wrapped: Uint8Array, masterKey: CryptoKey): Promise<Uint8Array> {
  return decrypt(wrapped, masterKey);
}

// ── Signing keypair (ECDSA P-256) ──

/**
 * Generate an ECDSA P-256 signing keypair for payload authentication.
 * Separate from the ECDH identity keys (Web Crypto enforces distinct usages).
 */
export async function generateSigningKeypair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  return { publicKey: pubRaw, privateKey: privPkcs8 };
}

/** Wrap a signing private key with the master key. */
export async function wrapSigningKey(privateKey: Uint8Array, masterKey: CryptoKey): Promise<Uint8Array> {
  return encrypt(privateKey, masterKey);
}

/** Unwrap a signing private key with the master key. */
export async function unwrapSigningKey(wrapped: Uint8Array, masterKey: CryptoKey): Promise<Uint8Array> {
  return decrypt(wrapped, masterKey);
}

const SIGNED_VERSION = 0x01;

/**
 * Sign a plaintext payload with ECDSA and prepend the signature.
 * Format: [0x01 version][64 bytes signature][plaintext]
 */
export async function signPayload(plaintext: Uint8Array, signingPrivateKeyPkcs8: Uint8Array): Promise<Uint8Array> {
  const privKey = await crypto.subtle.importKey(
    "pkcs8", signingPrivateKeyPkcs8 as unknown as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privKey, plaintext as unknown as BufferSource,
  ));
  // ECDSA P-256 signature is 64 bytes (r||s, each 32 bytes)
  const result = new Uint8Array(1 + signature.length + plaintext.length);
  result[0] = SIGNED_VERSION;
  result.set(signature, 1);
  result.set(plaintext, 1 + signature.length);
  return result;
}

/**
 * Verify and unwrap a signed payload.
 * Returns { plaintext, verified }. If the payload is unsigned (legacy), verified is false.
 */
export async function verifyPayload(
  data: Uint8Array,
  signingPublicKeyRaw: Uint8Array | null,
): Promise<{ plaintext: Uint8Array; verified: boolean }> {
  if (data[0] !== SIGNED_VERSION || data.length < 65) {
    // Legacy unsigned payload
    return { plaintext: data, verified: false };
  }
  const signature = data.slice(1, 65);
  const plaintext = data.slice(65);
  if (!signingPublicKeyRaw) {
    // No signing key available -- accept but mark unverified
    return { plaintext, verified: false };
  }
  try {
    const pubKey = await crypto.subtle.importKey(
      "raw", signingPublicKeyRaw as unknown as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false, ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, pubKey, signature as unknown as BufferSource, plaintext as unknown as BufferSource,
    );
    return { plaintext, verified: valid };
  } catch {
    return { plaintext, verified: false };
  }
}

// ── Book (vault) key management ──

/**
 * Generate a random AES-256 book key for encrypting a vault's data.
 */
export async function generateBookKey(): Promise<{ bookKey: CryptoKey; bookKeyRaw: Uint8Array }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const bookKey = await crypto.subtle.importKey(
    "raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"],
  );
  return { bookKey, bookKeyRaw: raw };
}

/**
 * Import a raw book key from bytes.
 */
export async function importBookKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", raw as BufferSource, { name: "AES-GCM" }, true, ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a book key for a recipient using ECDH key agreement.
 * senderPrivateKey: PKCS8 bytes of our private key
 * recipientPublicKey: raw bytes of recipient's public key
 * bookKeyRaw: 32-byte raw book key
 * Returns encrypted book key.
 */
export async function encryptBookKeyForUser(
  senderPrivateKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  bookKeyRaw: Uint8Array,
): Promise<Uint8Array> {
  const sharedKey = await deriveSharedKey(senderPrivateKey, recipientPublicKey);
  return encrypt(bookKeyRaw, sharedKey);
}

/**
 * Decrypt a book key that was encrypted for us via ECDH.
 * recipientPrivateKey: our PKCS8 private key
 * senderPublicKey: raw bytes of the sender's public key
 * encryptedBookKey: the encrypted book key
 */
export async function decryptBookKeyFromUser(
  recipientPrivateKey: Uint8Array,
  senderPublicKey: Uint8Array,
  encryptedBookKey: Uint8Array,
): Promise<Uint8Array> {
  const sharedKey = await deriveSharedKey(recipientPrivateKey, senderPublicKey);
  return decrypt(encryptedBookKey, sharedKey);
}

/**
 * Derive a shared AES-256-GCM key from ECDH key agreement.
 * Uses HKDF to properly derive the encryption key from the shared secret,
 * preventing related-key attacks (matches Proton Pass model).
 */
async function deriveSharedKey(privateKeyPkcs8: Uint8Array, publicKeyRaw: Uint8Array): Promise<CryptoKey> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", privateKeyPkcs8 as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false, ["deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw", publicKeyRaw as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false, [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey, 256,
  );
  const hkdfKey = await crypto.subtle.importKey(
    "raw", sharedBits, "HKDF", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode("RecipePWA-vault-key"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
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
    data as BufferSource,
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

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute a short fingerprint for a public key (for out-of-band verification).
 * Returns first 16 hex chars of SHA-256 digest, grouped in 4-char blocks.
 */
export async function keyFingerprint(publicKeyRaw: Uint8Array): Promise<string> {
  const buf = new Uint8Array(publicKeyRaw).buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = bytesToHex(new Uint8Array(digest)).slice(0, 16);
  return hex.match(/.{4}/g)!.join(" ");
}
