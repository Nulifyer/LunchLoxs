/**
 * Login / signup / logout UI and logic.
 */

import { log, error } from "../lib/logger";
import {
  deriveKeys, deriveUserId, unwrapMasterKey,
} from "../lib/crypto";
import {
  getStoredUsername, getStoredWrappedKey, getDeviceId, clearSession,
  clearIdentityKeys,
} from "../lib/auth";
import { DocumentManager } from "../lib/document-manager";
import { toBase64 } from "../lib/encoding";
import { clearIndex } from "../lib/search";
import { isOpen as isDetailOpen } from "../views/recipe-detail";
import {
  getDocMgr, setDocMgr, getSyncClient, setSyncClient,
  setBooks, setActiveBook, setCurrentUsername, setCurrentUserId,
  getSigningKeyCache, getIsSignup, setIsSignup,
} from "../state";
import { createSyncConnection } from "../connect";
import { deselectRecipe } from "../ui/recipes";

// DOM refs (grabbed at init time)
let loginSection: HTMLElement;
let appSection: HTMLElement;
let loginForm: HTMLFormElement;
let signupForm: HTMLFormElement;
let loginUsernameInput: HTMLInputElement;
let loginPasswordInput: HTMLInputElement;
let signupUsernameInput: HTMLInputElement;
let signupPasswordInput: HTMLInputElement;
let signupConfirmInput: HTMLInputElement;
let loginError: HTMLElement;
let signupError: HTMLElement;
let loginBtn: HTMLButtonElement;
let tabLogin: HTMLButtonElement;
let tabSignup: HTMLButtonElement;

export function resetLoginForm() {
  loginBtn.disabled = false;
  loginBtn.textContent = "Login";
  (document.getElementById("signup-btn") as HTMLButtonElement).disabled = false;
  (document.getElementById("signup-btn") as HTMLButtonElement).textContent = "Sign Up";
  loginUsernameInput.disabled = false;
  loginPasswordInput.disabled = false;
  signupUsernameInput.disabled = false;
  signupPasswordInput.disabled = false;
  signupConfirmInput.disabled = false;
  tabLogin.disabled = false;
  tabSignup.disabled = false;
}

export async function login(username: string, passphrase: string) {
  const isSignup = getIsSignup();
  log("[login] starting for", username);
  // Disable all login/signup inputs during auth
  loginBtn.disabled = true;
  (document.getElementById("signup-btn") as HTMLButtonElement).disabled = true;
  loginUsernameInput.disabled = true;
  loginPasswordInput.disabled = true;
  signupUsernameInput.disabled = true;
  signupPasswordInput.disabled = true;
  signupConfirmInput.disabled = true;
  tabLogin.disabled = true;
  tabSignup.disabled = true;
  const activeBtn = isSignup ? document.getElementById("signup-btn") as HTMLButtonElement : loginBtn;
  activeBtn.innerHTML = '<span class="btn-spinner"></span> Authenticating...';
  loginError.hidden = true;
  try {
    log("[login] deriving keys...");
    const [derived, userId] = await Promise.all([deriveKeys(username, passphrase), deriveUserId(username)]);
    log("[login] keys derived, userId:", userId.slice(0, 12));
    setCurrentUsername(username);
    setCurrentUserId(userId);
    const localWrapped = getStoredWrappedKey(userId);
    log("[login] localWrapped:", localWrapped ? `${localWrapped.length} bytes` : "null");
    let masterKey: CryptoKey | null = null;
    let wrappedMasterKey: Uint8Array | null = null;
    if (localWrapped) {
      try { masterKey = await unwrapMasterKey(localWrapped, derived.wrappingKey); wrappedMasterKey = localWrapped; log("[login] unwrapped local master key"); }
      catch (e) { error("[login] unwrap failed:", e); throw new Error("Wrong passphrase -- could not decrypt local data."); }
    }
    log("[login] creating SyncClient...");
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const isDev = location.hostname === "localhost" && location.port === "5000";
    const wsHost = isDev ? `${location.hostname}:8000` : location.host;
    const wsUrl = `${wsProtocol}//${wsHost}/ws`;
    const syncClient = createSyncConnection(wsUrl, userId, derived, masterKey, wrappedMasterKey, username);
    setSyncClient(syncClient);
    syncClient.setLastSeqGetter(async (docId) => { const s = getDocMgr()?.get(docId); return s ? s.getLastSeq() : 0; });
    if (masterKey) {
      log("[login] initializing DocumentManager...");
      setDocMgr(await DocumentManager.init(userId, masterKey));
      log("[login] DocumentManager ready");
    }
    log("[login] connecting WebSocket to", wsUrl);
    loginBtn.textContent = "Connecting...";
    syncClient.connect();
  } catch (e: any) {
    error("[login] ERROR:", e);
    const errEl = isSignup ? signupError : loginError;
    errEl.textContent = e.message ?? "Login failed"; errEl.hidden = false;
    resetLoginForm();
  }
}

export function logout() {
  log("[logout]");
  if (isDetailOpen()) deselectRecipe();
  getSyncClient()?.disconnect(); setSyncClient(null);
  getDocMgr()?.closeAll(); setDocMgr(null);
  clearSession(); clearIdentityKeys(); clearIndex();
  setBooks([]); setActiveBook(null);
  setCurrentUsername(""); setCurrentUserId("");
  getSigningKeyCache().clear();
  loginSection.hidden = false; appSection.hidden = true;
}

export async function purgeLocalData() {
  getDocMgr()?.closeAll(); setDocMgr(null);
  if (indexedDB.databases) {
    const dbs = await indexedDB.databases();
    for (const db of dbs) { if (db.name) indexedDB.deleteDatabase(db.name); }
  }
  localStorage.clear();
  if ("caches" in window) {
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
  }
}

function setLoginMode(signup: boolean) {
  setIsSignup(signup);
  tabLogin.classList.toggle("active", !signup);
  tabSignup.classList.toggle("active", signup);
  loginForm.hidden = signup;
  signupForm.hidden = !signup;
  loginError.hidden = true;
  signupError.hidden = true;
}

export function initAuth() {
  loginSection = document.getElementById("login-section") as HTMLElement;
  appSection = document.getElementById("app-section") as HTMLElement;
  loginForm = document.getElementById("login-form") as HTMLFormElement;
  signupForm = document.getElementById("signup-form") as HTMLFormElement;
  loginUsernameInput = document.getElementById("login-username") as HTMLInputElement;
  loginPasswordInput = document.getElementById("login-password") as HTMLInputElement;
  signupUsernameInput = document.getElementById("signup-username") as HTMLInputElement;
  signupPasswordInput = document.getElementById("signup-password") as HTMLInputElement;
  signupConfirmInput = document.getElementById("signup-confirm") as HTMLInputElement;
  loginError = document.getElementById("login-error") as HTMLElement;
  signupError = document.getElementById("signup-error") as HTMLElement;
  loginBtn = document.getElementById("login-btn") as HTMLButtonElement;
  tabLogin = document.getElementById("tab-login") as HTMLButtonElement;
  tabSignup = document.getElementById("tab-signup") as HTMLButtonElement;
  const logoutBtn = document.getElementById("logout-btn") as HTMLButtonElement;

  tabLogin.addEventListener("click", () => setLoginMode(false));
  tabSignup.addEventListener("click", () => setLoginMode(true));

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await login(loginUsernameInput.value.trim(), loginPasswordInput.value);
  });

  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (signupPasswordInput.value !== signupConfirmInput.value) {
      signupError.textContent = "Passwords don't match.";
      signupError.hidden = false;
      return;
    }
    if (signupPasswordInput.value.length < 8) {
      signupError.textContent = "Password must be at least 8 characters.";
      signupError.hidden = false;
      return;
    }
    await login(signupUsernameInput.value.trim(), signupPasswordInput.value);
  });

  logoutBtn.addEventListener("click", logout);

  // Boot
  const savedUsername = getStoredUsername();
  if (savedUsername) loginUsernameInput.value = savedUsername;
  loginSection.hidden = false;
  appSection.hidden = true;
}
