/**
 * Auth session management — reusable across projects.
 *
 * Username + wrapped master key stored in localStorage (encrypted, safe to persist).
 * Passphrase is NEVER stored. Wrapping key + master key held in memory only.
 * Closing the tab = keys gone = must re-enter passphrase.
 */

const STORAGE_KEY_USERNAME = "e2ee_username";
const STORAGE_KEY_DEVICE_ID = "e2ee_device_id";
const STORAGE_KEY_WRAPPED_KEY = "e2ee_wrapped_master_key"; // per-user, suffixed with userId

/** In-memory session — destroyed on tab close */
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

/** Get the stored wrapped master key for a user (encrypted, safe in localStorage). */
export function getStoredWrappedKey(userId: string): Uint8Array | null {
  const b64 = localStorage.getItem(`${STORAGE_KEY_WRAPPED_KEY}_${userId.slice(0, 16)}`);
  if (!b64) return null;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Store the wrapped master key (encrypted blob, safe to persist). */
export function storeWrappedKey(userId: string, wrapped: Uint8Array): void {
  let binary = "";
  for (let i = 0; i < wrapped.length; i++) binary += String.fromCharCode(wrapped[i]);
  localStorage.setItem(`${STORAGE_KEY_WRAPPED_KEY}_${userId.slice(0, 16)}`, btoa(binary));
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

/** Clear the stored wrapped key for a user (e.g., after password change on another device). */
export function clearWrappedKey(userId: string): void {
  localStorage.removeItem(`${STORAGE_KEY_WRAPPED_KEY}_${userId.slice(0, 16)}`);
}

export function hasSession(): boolean {
  return sessionKeys !== null;
}

/** Update the wrapped key after a password change. */
export function updateWrappedKey(userId: string, wrapped: Uint8Array): void {
  storeWrappedKey(userId, wrapped);
  if (sessionKeys) {
    sessionKeys.wrappedMasterKey = wrapped;
  }
}
