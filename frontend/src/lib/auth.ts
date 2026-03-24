/**
 * Auth session management.
 *
 * Username + wrapped master key stored in localStorage (encrypted, safe to persist).
 * Passphrase is NEVER stored. Wrapping key + master key held in memory only.
 * Closing the tab = keys gone = must re-enter passphrase.
 */

import { toBase64, fromBase64 } from "./encoding";

const STORAGE_KEY_USERNAME = "e2ee_username";
const STORAGE_KEY_DEVICE_ID = "e2ee_device_id";
const STORAGE_KEY_WRAPPED_KEY = "e2ee_wrapped_master_key";

/** In-memory session -- destroyed on tab close */
let sessionKeys: {
  authHash: string;
  masterKey: CryptoKey;
  wrappedMasterKey: Uint8Array;
  userId: string;
} | null = null;

export function getStoredUsername(): string | null {
  return localStorage.getItem(STORAGE_KEY_USERNAME);
}

export function getDeviceId(): string {
  let id = localStorage.getItem(STORAGE_KEY_DEVICE_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY_DEVICE_ID, id);
  }
  return id;
}

export function getStoredWrappedKey(userId: string): Uint8Array | null {
  const b64 = localStorage.getItem(`${STORAGE_KEY_WRAPPED_KEY}_${userId.slice(0, 16)}`);
  if (!b64) return null;
  return fromBase64(b64);
}

export function storeWrappedKey(userId: string, wrapped: Uint8Array): void {
  localStorage.setItem(`${STORAGE_KEY_WRAPPED_KEY}_${userId.slice(0, 16)}`, toBase64(wrapped));
}

export function clearWrappedKey(userId: string): void {
  localStorage.removeItem(`${STORAGE_KEY_WRAPPED_KEY}_${userId.slice(0, 16)}`);
}

export function saveSession(username: string, keys: {
  authHash: string;
  masterKey: CryptoKey;
  wrappedMasterKey: Uint8Array;
  userId: string;
}): void {
  localStorage.setItem(STORAGE_KEY_USERNAME, username);
  storeWrappedKey(keys.userId, keys.wrappedMasterKey);
  sessionKeys = keys;
}

export function getSessionKeys() {
  return sessionKeys;
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY_USERNAME);
  sessionKeys = null;
}

export function hasSession(): boolean {
  return sessionKeys !== null;
}

// -- Identity key storage (in-memory only for private key) --

let identityPrivateKey: Uint8Array | null = null;
let identityPublicKey: Uint8Array | null = null;

export function setIdentityKeys(publicKey: Uint8Array, privateKey: Uint8Array): void {
  identityPublicKey = publicKey;
  identityPrivateKey = privateKey;
}

export function getIdentityPublicKey(): Uint8Array | null {
  return identityPublicKey;
}

export function getIdentityPrivateKey(): Uint8Array | null {
  return identityPrivateKey;
}

export function clearIdentityKeys(): void {
  identityPublicKey = null;
  identityPrivateKey = null;
}

export function updateWrappedKey(userId: string, wrapped: Uint8Array): void {
  storeWrappedKey(userId, wrapped);
  if (sessionKeys) {
    sessionKeys.wrappedMasterKey = wrapped;
  }
}
