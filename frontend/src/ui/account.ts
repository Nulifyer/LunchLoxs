/**
 * Account page -- change password, purge, theme, debug logs.
 */

import { log, error, exportLogs, copyLogs } from "../lib/logger";
import {
  deriveKeys, deriveUserId, rewrapMasterKey,
} from "../lib/crypto";
import {
  getStoredUsername, getDeviceId, updateWrappedKey, getSessionKeys,
} from "../lib/auth";
import { toBase64 } from "../lib/encoding";
import { themes, applyTheme, getStoredTheme } from "../lib/themes";
import { showConfirm } from "../lib/dialogs";
import { toastSuccess, toastError } from "../lib/toast";
import { isOpen as isDetailOpen } from "../views/recipe-detail";
import { getSyncClient, getPushQueue } from "../state";
import { purgeLocalData, logout } from "../ui/auth";
import { deselectRecipe } from "../ui/recipes";

let accountPage: HTMLElement;
let accountBackBtn: HTMLButtonElement;
let accountUsername: HTMLElement;
let accountDeviceId: HTMLElement;
let changePwForm: HTMLFormElement;
let pwError: HTMLElement;
let pwSuccess: HTMLElement;
let purgeForm: HTMLFormElement;
let purgeError: HTMLElement;
let themeGrid: HTMLElement;

function renderThemeGrid() {
  themeGrid.innerHTML = "";
  const current = getStoredTheme();
  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement("button");
    btn.className = `theme-swatch${id === current ? " active" : ""}`;
    btn.textContent = theme.label;
    btn.style.color = theme.text;
    btn.style.background = theme.bg;
    btn.style.borderColor = id === current ? theme.accent : theme.border;
    btn.addEventListener("click", () => { applyTheme(id); renderThemeGrid(); });
    themeGrid.appendChild(btn);
  }
}

export function showAccountPage() {
  if (isDetailOpen()) deselectRecipe();
  accountUsername.textContent = getStoredUsername() ?? "";
  accountDeviceId.textContent = getDeviceId();
  const emptyState = document.getElementById("empty-state") as HTMLElement;
  emptyState.hidden = true;
  (document.getElementById("recipe-detail") as HTMLElement).hidden = true;
  accountPage.hidden = false;
  const appShell = document.getElementById("app-shell") as HTMLElement;
  appShell.classList.add("detail-open");
  pwError.hidden = true; pwSuccess.hidden = true; purgeError.hidden = true;
  renderThemeGrid();
}

export function initAccount() {
  accountPage = document.getElementById("account-page") as HTMLElement;
  accountBackBtn = document.getElementById("account-back-btn") as HTMLButtonElement;
  accountUsername = document.getElementById("account-username") as HTMLElement;
  accountDeviceId = document.getElementById("account-device-id") as HTMLElement;
  changePwForm = document.getElementById("change-pw-form") as HTMLFormElement;
  pwError = document.getElementById("pw-change-error") as HTMLElement;
  pwSuccess = document.getElementById("pw-change-success") as HTMLElement;
  purgeForm = document.getElementById("purge-form") as HTMLFormElement;
  purgeError = document.getElementById("purge-error") as HTMLElement;
  themeGrid = document.getElementById("theme-grid") as HTMLElement;

  accountBackBtn.addEventListener("click", () => {
    accountPage.hidden = true;
    const emptyState = document.getElementById("empty-state") as HTMLElement;
    emptyState.hidden = false;
    const appShell = document.getElementById("app-shell") as HTMLElement;
    appShell.classList.remove("detail-open");
  });

  changePwForm.addEventListener("submit", async (e) => {
    e.preventDefault(); pwError.hidden = true; pwSuccess.hidden = true;
    const newPw = (document.getElementById("new-pw") as HTMLInputElement).value;
    const confirmPw = (document.getElementById("confirm-pw") as HTMLInputElement).value;
    if (newPw !== confirmPw) { pwError.textContent = "Passwords don't match."; pwError.hidden = false; return; }
    const username = getStoredUsername(); const syncClient = getSyncClient();
    if (!username || !syncClient) return;
    try {
      const [nd, uid] = await Promise.all([deriveKeys(username, newPw), deriveUserId(username)]);
      const session = getSessionKeys(); if (!session) return;
      const nw = await rewrapMasterKey(session.masterKey, nd.wrappingKey);
      updateWrappedKey(uid, nw); syncClient.changePassword(nd.authHash, toBase64(nw));
      pwSuccess.textContent = "Password changed."; pwSuccess.hidden = false; changePwForm.reset();
    } catch (e: any) { pwError.textContent = "Failed: " + (e.message ?? e); pwError.hidden = false; }
  });

  purgeForm.addEventListener("submit", async (e) => {
    e.preventDefault(); purgeError.hidden = true;
    const ci = (document.getElementById("purge-confirm") as HTMLInputElement).value.trim().toLowerCase();
    const un = (getStoredUsername() ?? "").trim().toLowerCase();
    if (ci !== un) { purgeError.textContent = "Username doesn't match."; purgeError.hidden = false; return; }
    const syncClient = getSyncClient();
    if (!syncClient?.isOpen()) { purgeError.textContent = "Must be connected to the server to purge."; purgeError.hidden = false; return; }
    // Stop background work before purge
    getPushQueue()?.stop();
    import("../lib/vector-search").then(({ clearAll }) => clearAll()).catch(() => {});
    syncClient.purge();
  });

  (document.getElementById("purge-local-btn") as HTMLButtonElement).addEventListener("click", async () => {
    const ok = await showConfirm("Clear all local data on this device? You will need to log in again.", { title: "Clear Local Data", confirmText: "Clear", danger: true });
    if (!ok) return;
    // Stop background work before clearing
    getPushQueue()?.stop();
    import("../lib/vector-search").then(({ clearAll }) => clearAll()).catch(() => {});
    await purgeLocalData();
    location.reload();
  });

  // Debug log export
  (document.getElementById("export-logs-btn") as HTMLButtonElement).addEventListener("click", () => exportLogs());
  (document.getElementById("copy-logs-btn") as HTMLButtonElement).addEventListener("click", async () => {
    const ok = await copyLogs();
    if (ok) toastSuccess("Logs copied to clipboard."); else toastError("Failed to copy. Try the download button.");
  });

  // Check for update
  (document.getElementById("check-update-btn") as HTMLButtonElement).addEventListener("click", async () => {
    try {
      const res = await fetch("/version.json", { cache: "no-store" });
      if (!res.ok) { toastError("Failed to fetch version"); return; }
      const { version, built } = await res.json();
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
      // Force SW to re-check and clear stale caches
      navigator.serviceWorker?.controller?.postMessage("check-update");
      toastSuccess(`Server: ${version} (${new Date(built).toLocaleString()}). SW updated.`);
    } catch (e: any) { toastError("Update check failed: " + (e.message ?? e)); }
  });

  // Rebuild embeddings
  (document.getElementById("rebuild-embeddings-btn") as HTMLButtonElement).addEventListener("click", async () => {
    const ok = await showConfirm("Rebuild all recipe embeddings? This may take a few minutes.", { title: "Rebuild Embeddings", confirmText: "Rebuild" });
    if (!ok) return;
    try {
      const { clearAll, initVectorSearch } = await import("../lib/vector-search");
      const { getCurrentUserId } = await import("../state");
      await clearAll();
      await initVectorSearch(getCurrentUserId());
      toastSuccess("Embedding rebuild started");
    } catch (e: any) { toastError("Failed: " + (e.message ?? e)); }
  });
}
