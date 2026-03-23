/**
 * Auth session management — reusable across projects.
 *
 * Stores username in localStorage (not secret — just an identifier).
 * Stores passphrase in sessionStorage (cleared on tab close, survives refresh).
 * The encryption key is re-derived from these on page load.
 */

const STORAGE_KEY_USERNAME = "e2ee_username";
const STORAGE_KEY_PASSPHRASE = "e2ee_passphrase";
const STORAGE_KEY_DEVICE_ID = "e2ee_device_id";

export function getStoredUsername(): string | null {
  return localStorage.getItem(STORAGE_KEY_USERNAME);
}

export function getStoredPassphrase(): string | null {
  return sessionStorage.getItem(STORAGE_KEY_PASSPHRASE);
}

export function getDeviceId(): string {
  let id = localStorage.getItem(STORAGE_KEY_DEVICE_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY_DEVICE_ID, id);
  }
  return id;
}

export function saveSession(username: string, passphrase: string): void {
  localStorage.setItem(STORAGE_KEY_USERNAME, username);
  sessionStorage.setItem(STORAGE_KEY_PASSPHRASE, passphrase);
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY_USERNAME);
  sessionStorage.removeItem(STORAGE_KEY_PASSPHRASE);
  // Keep device_id — it's tied to this browser, not the session
}

export function hasSession(): boolean {
  return getStoredUsername() !== null && getStoredPassphrase() !== null;
}
