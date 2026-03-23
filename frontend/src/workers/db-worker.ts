/**
 * Web Worker that runs SQLite WASM with OPFS persistence.
 * Atomics.wait() is allowed here (unlike the main thread).
 */

/// <reference lib="webworker" />

type DB = any;
let db: DB | null = null;

interface TodoRow {
  id: string;
  title: string;
  completed: boolean;
  created_at: string;
  updated_at: string;
  synced: boolean;
}

async function init(): Promise<void> {
  const sqlite3InitModule = (await import("@sqlite.org/sqlite-wasm")).default;
  const sqlite3 = await sqlite3InitModule();

  if (sqlite3.oo1.OpfsDb) {
    db = new sqlite3.oo1.OpfsDb("/todos.sqlite3");
    postMessage({ type: "log", msg: "SQLite: using OPFS storage" });
  } else {
    db = new sqlite3.oo1.DB(":memory:");
    postMessage({ type: "log", msg: "SQLite: OPFS unavailable, using in-memory database" });
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      completed  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      synced     INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function getAllTodos(): TodoRow[] {
  const rows: TodoRow[] = [];
  db!.exec({
    sql: "SELECT id, title, completed, created_at, updated_at, synced FROM todos ORDER BY created_at DESC",
    callback: (row: any) => {
      rows.push({
        id: row[0],
        title: row[1],
        completed: !!row[2],
        created_at: row[3],
        updated_at: row[4],
        synced: !!row[5],
      });
    },
  });
  return rows;
}

function insertTodo(todo: TodoRow): void {
  db!.exec({
    sql: `INSERT OR REPLACE INTO todos (id, title, completed, created_at, updated_at, synced)
          VALUES (?, ?, ?, ?, ?, ?)`,
    bind: [todo.id, todo.title, todo.completed ? 1 : 0, todo.created_at, todo.updated_at, todo.synced ? 1 : 0],
  });
}

function updateTodo(id: string, updates: Partial<Pick<TodoRow, "title" | "completed" | "synced">>): void {
  const sets: string[] = [];
  const binds: any[] = [];
  if (updates.title !== undefined) { sets.push("title = ?"); binds.push(updates.title); }
  if (updates.completed !== undefined) { sets.push("completed = ?"); binds.push(updates.completed ? 1 : 0); }
  if (updates.synced !== undefined) { sets.push("synced = ?"); binds.push(updates.synced ? 1 : 0); }
  sets.push("updated_at = datetime('now')");
  binds.push(id);
  db!.exec({
    sql: `UPDATE todos SET ${sets.join(", ")} WHERE id = ?`,
    bind: binds,
  });
}

function deleteTodo(id: string): void {
  db!.exec({ sql: "DELETE FROM todos WHERE id = ?", bind: [id] });
}

function getUnsyncedTodos(): TodoRow[] {
  const rows: TodoRow[] = [];
  db!.exec({
    sql: "SELECT id, title, completed, created_at, updated_at, synced FROM todos WHERE synced = 0",
    callback: (row: any) => {
      rows.push({
        id: row[0],
        title: row[1],
        completed: !!row[2],
        created_at: row[3],
        updated_at: row[4],
        synced: false,
      });
    },
  });
  return rows;
}

// ── Message handler ──
self.onmessage = async (e: MessageEvent) => {
  const { id, method, args } = e.data;
  try {
    let result: any;
    switch (method) {
      case "init":
        await init();
        result = true;
        break;
      case "getAllTodos":
        result = getAllTodos();
        break;
      case "insertTodo":
        insertTodo(args[0]);
        result = true;
        break;
      case "updateTodo":
        updateTodo(args[0], args[1]);
        result = true;
        break;
      case "deleteTodo":
        deleteTodo(args[0]);
        result = true;
        break;
      case "getUnsyncedTodos":
        result = getUnsyncedTodos();
        break;
      default:
        throw new Error(`Unknown method: ${method}`);
    }
    postMessage({ id, result });
  } catch (err: any) {
    postMessage({ id, error: err.message });
  }
};
