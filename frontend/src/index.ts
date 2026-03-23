import { initLocalDb, getAllTodos, insertTodo, updateTodoLocal, deleteTodoLocal, type LocalTodo } from "./lib/local-db";
import { todoClient } from "./lib/api-client";
import { timestampDate } from "@bufbuild/protobuf/wkt";

// ── State ──
let online = navigator.onLine;

// ── DOM refs ──
const form = document.getElementById("add-form") as HTMLFormElement;
const input = document.getElementById("todo-input") as HTMLInputElement;
const list = document.getElementById("todo-list") as HTMLUListElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const offlineBadge = document.getElementById("offline-badge") as HTMLSpanElement;

// ── Render ──
function render(todos: LocalTodo[]) {
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
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ── Sync from server → local ──
async function syncFromServer() {
  try {
    const res = await todoClient.listTodos({});
    for (const t of res.todos) {
      await insertTodo({
        id: t.id,
        title: t.title,
        completed: t.completed,
        created_at: (t.createdAt ? timestampDate(t.createdAt).toISOString() : undefined) ?? new Date().toISOString(),
        updated_at: (t.updatedAt ? timestampDate(t.updatedAt).toISOString() : undefined) ?? new Date().toISOString(),
        synced: true,
      });
    }
    online = true;
    offlineBadge.hidden = true;
  } catch (e) {
    online = false;
    offlineBadge.hidden = false;
    console.warn("sync failed, working offline:", e);
  }
}

// ── Refresh UI ──
async function refresh() {
  render(await getAllTodos());
}

// ── Event handlers ──
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = input.value.trim();
  if (!title) return;

  const tempId = crypto.randomUUID();
  const now = new Date().toISOString();
  await insertTodo({ id: tempId, title, completed: false, created_at: now, updated_at: now, synced: false });
  input.value = "";
  await refresh();

  if (online) {
    try {
      const res = await todoClient.createTodo({ title });
      // Replace temp record with server-assigned one
      await deleteTodoLocal(tempId);
      await insertTodo({
        id: res.todo!.id,
        title: res.todo!.title,
        completed: res.todo!.completed,
        created_at: res.todo!.createdAt ? timestampDate(res.todo!.createdAt).toISOString() : now,
        updated_at: res.todo!.updatedAt ? timestampDate(res.todo!.updatedAt).toISOString() : now,
        synced: true,
      });
      await refresh();
    } catch (e) {
      console.warn("create failed, saved locally:", e);
    }
  }
});

list.addEventListener("change", async (e) => {
  const target = e.target as HTMLInputElement;
  const id = target.dataset.id;
  if (!id) return;
  const completed = target.checked;
  await updateTodoLocal(id, { completed, synced: false });
  await refresh();

  if (online) {
    try {
      await todoClient.updateTodo({ id, completed });
      await updateTodoLocal(id, { synced: true });
    } catch (e) {
      console.warn("update failed:", e);
    }
  }
});

list.addEventListener("click", async (e) => {
  const target = e.target as HTMLButtonElement;
  const id = target.dataset.delete;
  if (!id) return;
  await deleteTodoLocal(id);
  await refresh();

  if (online) {
    try {
      await todoClient.deleteTodo({ id });
    } catch (e) {
      console.warn("delete failed:", e);
    }
  }
});

// ── Online/offline tracking ──
window.addEventListener("online", () => { online = true; offlineBadge.hidden = true; syncFromServer().then(() => refresh()); });
window.addEventListener("offline", () => { online = false; offlineBadge.hidden = false; });
offlineBadge.hidden = online;

// ── Register service worker ──
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(console.error);
}

// ── Boot ──
(async () => {
  await initLocalDb();
  if (online) await syncFromServer();
  await refresh();
})();
