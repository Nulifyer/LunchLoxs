import { deriveKeys, deriveUserId } from "./lib/crypto";
import { hasSession, getStoredUsername, getStoredPassphrase, getDeviceId, saveSession, clearSession } from "./lib/auth";
import { AutomergeStore } from "./lib/automerge-store";
import { SyncClient, type SyncStatus } from "./lib/sync-client";

// ── App document schema ──
interface TodoDoc {
  todos: Array<{
    id: string;
    title: string;
    completed: boolean;
    createdAt: number;
  }>;
}

// ── State ──
let store: AutomergeStore<TodoDoc> | null = null;
let syncClient: SyncClient | null = null;
let syncStatus: SyncStatus = "disconnected";

// ── DOM refs ──
const loginSection = document.getElementById("login-section") as HTMLElement;
const appSection = document.getElementById("app-section") as HTMLElement;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const usernameInput = document.getElementById("username-input") as HTMLInputElement;
const passphraseInput = document.getElementById("passphrase-input") as HTMLInputElement;
const loginError = document.getElementById("login-error") as HTMLElement;
const loginBtn = document.getElementById("login-btn") as HTMLButtonElement;
const logoutBtn = document.getElementById("logout-btn") as HTMLButtonElement;
const form = document.getElementById("add-form") as HTMLFormElement;
const input = document.getElementById("todo-input") as HTMLInputElement;
const list = document.getElementById("todo-list") as HTMLUListElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const syncBadge = document.getElementById("sync-badge") as HTMLSpanElement;

// ── Render ──
function render() {
  if (!store) return;
  const doc = store.getDoc();
  const todos = doc.todos ?? [];

  list.innerHTML = "";
  for (const todo of todos) {
    const li = document.createElement("li");
    li.className = `todo-item${todo.completed ? " completed" : ""}`;
    li.innerHTML = `
      <input type="checkbox" ${todo.completed ? "checked" : ""} data-id="${todo.id}" />
      <span>${escapeHtml(todo.title)}</span>
      <button data-delete="${todo.id}" title="Delete">&times;</button>
    `;
    list.appendChild(li);
  }
  status.textContent = `${todos.length} item${todos.length !== 1 ? "s" : ""}`;
  updateSyncBadge();
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function updateSyncBadge() {
  syncBadge.textContent = syncStatus;
  syncBadge.className = `sync-badge ${syncStatus}`;
  syncBadge.hidden = syncStatus === "connected";
}

// ── Login flow ──
async function login(username: string, passphrase: string) {
  loginBtn.disabled = true;
  loginBtn.textContent = "Deriving keys...";
  loginError.hidden = true;

  try {
    const [keys, userId] = await Promise.all([
      deriveKeys(username, passphrase),
      deriveUserId(username),
    ]);

    saveSession(username, passphrase);

    // Init Automerge store
    store = await AutomergeStore.init<TodoDoc>((doc) => {
      doc.todos = [];
    });
    store.onChange(() => render());

    // Determine WebSocket URL
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${location.hostname}:8080/ws`;

    // Init sync client
    syncClient = new SyncClient({
      url: wsUrl,
      userId,
      deviceId: getDeviceId(),
      authHash: keys.authHash,
      encKey: keys.encKey,
      getLastSeq: () => store!.getLastSeq(),
      onRemoteChange: async (change, seq) => {
        store!.applyChange(change);
        await store!.setLastSeq(seq);
      },
      onCaughtUp: async (latestSeq) => {
        await store!.setLastSeq(latestSeq);
        // Always push all local changes — the relay needs every device's
        // full Automerge history so other devices can apply changes.
        // Automerge handles duplicate changes idempotently.
        const changes = store!.getAllChanges();
        if (changes.length > 0) {
          await syncClient!.pushAll(changes);
        }
      },
      onStatusChange: (s) => {
        syncStatus = s;
        updateSyncBadge();
      },
    });

    syncClient.connect();

    // Show app
    loginSection.hidden = true;
    appSection.hidden = false;
    render();
  } catch (e: any) {
    loginError.textContent = e.message ?? "Login failed";
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Login / Sign Up";
  }
}

function logout() {
  syncClient?.disconnect();
  syncClient = null;
  store = null;
  clearSession();
  loginSection.hidden = false;
  appSection.hidden = true;
}

// ── Event handlers ──
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await login(usernameInput.value.trim(), passphraseInput.value);
});

logoutBtn.addEventListener("click", logout);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = input.value.trim();
  if (!title || !store) return;

  store.change((doc) => {
    doc.todos.push({
      id: crypto.randomUUID(),
      title,
      completed: false,
      createdAt: Date.now(),
    });
  });

  // Send the change to the relay
  const lastChange = store.getLastLocalChange();
  if (lastChange) syncClient?.push(lastChange);

  input.value = "";
});

list.addEventListener("change", (e) => {
  const target = e.target as HTMLInputElement;
  const id = target.dataset.id;
  if (!id || !store) return;

  store.change((doc) => {
    const todo = doc.todos.find((t) => t.id === id);
    if (todo) todo.completed = target.checked;
  });

  const lastChange = store.getLastLocalChange();
  if (lastChange) syncClient?.push(lastChange);
});

list.addEventListener("click", (e) => {
  const target = e.target as HTMLButtonElement;
  const id = target.dataset.delete;
  if (!id || !store) return;

  store.change((doc) => {
    const idx = doc.todos.findIndex((t) => t.id === id);
    if (idx !== -1) doc.todos.splice(idx, 1);
  });

  const lastChange = store.getLastLocalChange();
  if (lastChange) syncClient?.push(lastChange);
});

// ── Register service worker ──
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(console.error);
}

// ── Boot ──
(async () => {
  if (hasSession()) {
    await login(getStoredUsername()!, getStoredPassphrase()!);
  } else {
    loginSection.hidden = false;
    appSection.hidden = true;
  }
})();
