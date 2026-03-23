/**
 * Async RPC layer over the SQLite Web Worker.
 * All DB operations run in a worker so OPFS (Atomics.wait) works.
 */

export interface LocalTodo {
  id: string;
  title: string;
  completed: boolean;
  created_at: string;
  updated_at: string;
  synced: boolean;
}

let worker: Worker;
let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function call(method: string, ...args: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

export async function initLocalDb(): Promise<void> {
  worker = new Worker("/db-worker.js", { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const { id, result, error, type, msg } = e.data;
    if (type === "log") {
      console.log(msg);
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  };
  await call("init");
}

export async function getAllTodos(): Promise<LocalTodo[]> {
  return call("getAllTodos");
}

export async function insertTodo(todo: LocalTodo): Promise<void> {
  return call("insertTodo", todo);
}

export async function updateTodoLocal(id: string, updates: Partial<Pick<LocalTodo, "title" | "completed" | "synced">>): Promise<void> {
  return call("updateTodo", id, updates);
}

export async function deleteTodoLocal(id: string): Promise<void> {
  return call("deleteTodo", id);
}

export async function getUnsyncedTodos(): Promise<LocalTodo[]> {
  return call("getUnsyncedTodos");
}
