/**
 * Push queue unit tests.
 *
 * Tests the reactive + proactive push queue with mocked WebSocket,
 * DocumentManager, and real IndexedDB (via fake-indexeddb).
 *
 * The PushQueue class is tested directly with injectable signFn
 * and mocked dependencies.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import "fake-indexeddb/auto";
import { PushQueue, type SignFn } from "../push-queue";
import {
  getAllDirtyDocIds,
  clearDirtyFlag,
} from "../../lib/automerge-store";
import type { PushResult } from "../../lib/sync-client";

// -- Helpers --

class MockStore {
  private dirty = false;
  private pushHeadsVal: string[] | null = null;
  private headsVal: string[];
  private lastSeqVal = 0;
  private db: IDBDatabase;
  private docId: string;

  constructor(db: IDBDatabase, docId: string, heads: string[] = ["abc123"]) {
    this.db = db;
    this.docId = docId;
    this.headsVal = heads;
  }

  save(): Uint8Array { return new Uint8Array([1, 2, 3]); }
  getAllChanges(): Uint8Array[] { return [new Uint8Array([1])]; }
  getHeads(): string[] { return this.headsVal; }
  setHeads(h: string[]) { this.headsVal = h; }
  async waitForWrite(): Promise<void> {}

  async setPushHeads(heads: string[]): Promise<void> {
    this.pushHeadsVal = heads;
    await this.idbPut(`pushHeads:${this.docId}`, heads);
  }
  async getPushHeads(): Promise<string[] | null> {
    return this.pushHeadsVal;
  }
  async clearPushHeads(): Promise<void> {
    this.pushHeadsVal = null;
  }

  async markDirty(): Promise<void> {
    this.dirty = true;
    await this.idbPut(`dirty:${this.docId}`, true);
  }
  async clearDirty(): Promise<void> {
    this.dirty = false;
    await this.idbDelete(`dirty:${this.docId}`);
    await this.clearPushHeads();
  }
  async isDirty(): Promise<boolean> { return this.dirty; }

  async getLastSeq(): Promise<number> { return this.lastSeqVal; }
  async setLastSeq(seq: number): Promise<void> { this.lastSeqVal = seq; }

  private idbPut(key: string, val: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("docs", "readwrite");
      tx.objectStore("docs").put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  private idbDelete(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("docs", "readwrite");
      tx.objectStore("docs").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

function createMockSyncClient(open = true, pushResult: PushResult = "sent") {
  return {
    isOpen: () => open,
    push: mock(async (_docId: string, _payload: Uint8Array): Promise<PushResult> => pushResult),
    createVault: mock(async () => {}),
  };
}

function createMockDocMgr(stores: Map<string, MockStore>) {
  return {
    get: (docId: string) => stores.get(docId) ?? null,
    open: async (docId: string, _init: any) => {
      const store = stores.get(docId);
      if (!store) throw new Error("not found");
      return store;
    },
    close: (_docId: string) => {},
    getDb: () => null as any,
  };
}

function openTestDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("test-" + Math.random(), 1);
    req.onupgradeneeded = () => req.result.createObjectStore("docs");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<any> {
  return new Promise((resolve) => {
    const tx = db.transaction("docs", "readonly");
    const req = tx.objectStore("docs").get(key);
    req.onsuccess = () => resolve(req.result);
  });
}

const noopSign: SignFn = (raw) => raw;

// -- Tests --

describe("Push Queue Logic (primitives)", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDB();
  });
  afterEach(() => { db.close(); });

  test("dirty flag persists in IndexedDB", async () => {
    const store = new MockStore(db, "vault1/catalog");
    await store.markDirty();
    expect(await store.isDirty()).toBe(true);
    expect(await idbGet(db, "dirty:vault1/catalog")).toBe(true);
  });

  test("clearDirty removes flag and push heads from IndexedDB", async () => {
    const store = new MockStore(db, "vault1/catalog");
    await store.markDirty();
    await store.setPushHeads(["abc123"]);
    await store.clearDirty();
    expect(await store.isDirty()).toBe(false);
    expect(await store.getPushHeads()).toBeNull();
    expect(await idbGet(db, "dirty:vault1/catalog")).toBeUndefined();
  });

  test("push heads comparison - matching heads allows clearing dirty", async () => {
    const store = new MockStore(db, "vault1/doc1", ["head1", "head2"]);
    await store.markDirty();
    await store.setPushHeads(store.getHeads());
    const pushHeads = await store.getPushHeads();
    const currentHeads = store.getHeads();
    const match = pushHeads!.length === currentHeads.length &&
      pushHeads!.every((h, i) => h === currentHeads[i]);
    expect(match).toBe(true);
  });

  test("push heads comparison - different heads should NOT clear dirty", async () => {
    const store = new MockStore(db, "vault1/doc1", ["head1"]);
    await store.markDirty();
    await store.setPushHeads(store.getHeads());
    store.setHeads(["head1", "head2_new"]);
    const pushHeads = await store.getPushHeads();
    const currentHeads = store.getHeads();
    const match = pushHeads!.length === currentHeads.length &&
      pushHeads!.every((h, i) => h === currentHeads[i]);
    expect(match).toBe(false);
    expect(await store.isDirty()).toBe(true);
  });

  test("getAllDirtyDocIds scans IndexedDB correctly", async () => {
    const put = (key: string, val: any) => new Promise<void>((resolve) => {
      const tx = db.transaction("docs", "readwrite");
      tx.objectStore("docs").put(val, key);
      tx.oncomplete = () => resolve();
    });
    await put("dirty:vault1/catalog", true);
    await put("dirty:vault1/recipe1", true);
    await put("dirty:vault2/catalog", true);
    await put("doc:vault1/catalog", new Uint8Array([1]));
    await put("seq:vault1/catalog", 5);

    const ids = await getAllDirtyDocIds(db);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("vault1/catalog");
    expect(ids).toContain("vault1/recipe1");
    expect(ids).toContain("vault2/catalog");
  });

  test("dirty flags survive simulated page reload", async () => {
    const store = new MockStore(db, "vault1/catalog");
    await store.markDirty();
    expect(await idbGet(db, "dirty:vault1/catalog")).toBe(true);
  });
});

describe("PushQueue integration", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDB();
  });
  afterEach(() => { db.close(); });

  test("onAck clears dirty from dirtySet and IndexedDB", async () => {
    const store = new MockStore(db, "vault1/catalog");
    await store.markDirty();
    const stores = new Map([["vault1/catalog", store]]);
    const docMgr = createMockDocMgr(stores);
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    expect(pq.hasDirty()).toBe(true);
    expect(pq.dirtyCount()).toBe(1);

    await pq.onAck("vault1/catalog", 5);

    expect(pq.hasDirty()).toBe(false);
    expect(await idbGet(db, "dirty:vault1/catalog")).toBeUndefined();
    pq.stop();
  });

  test("onAck for closed store clears dirty directly in IndexedDB", async () => {
    const store = new MockStore(db, "vault1/recipe1");
    await store.markDirty();
    // DocMgr does NOT have this store (simulates closed store)
    const docMgr = createMockDocMgr(new Map());
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    expect(pq.hasDirty()).toBe(true);
    await pq.onAck("vault1/recipe1", 3);

    expect(pq.hasDirty()).toBe(false);
    expect(await idbGet(db, "dirty:vault1/recipe1")).toBeUndefined();
    pq.stop();
  });

  test("onPushError gives up after MAX_PUSH_ERRORS (5) consecutive errors for transient errors", async () => {
    const store = new MockStore(db, "vault1/doc1");
    await store.markDirty();
    const docMgr = createMockDocMgr(new Map([["vault1/doc1", store]]));
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    // First 4 errors: IDB dirty flag should persist
    for (let i = 0; i < 4; i++) {
      pq.markDirty("vault1/doc1");
      await pq.onPushError("vault1/doc1", "transient error");
      expect(await idbGet(db, "dirty:vault1/doc1")).toBe(true);
    }

    // 5th error: IDB dirty flag should be cleared
    pq.markDirty("vault1/doc1");
    await pq.onPushError("vault1/doc1", "transient error");
    expect(await idbGet(db, "dirty:vault1/doc1")).toBeUndefined();

    pq.stop();
  });

  test("onPushError immediately fails vault on permission error", async () => {
    const store1 = new MockStore(db, "vault1/doc1");
    const store2 = new MockStore(db, "vault1/doc2");
    await store1.markDirty();
    await store2.markDirty();
    const docMgr = createMockDocMgr(new Map([["vault1/doc1", store1], ["vault1/doc2", store2]]));
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    // Single permission error should clear all docs for that vault
    await pq.onPushError("vault1/doc1", "insufficient permissions to write");
    expect(await idbGet(db, "dirty:vault1/doc1")).toBeUndefined();
    expect(await idbGet(db, "dirty:vault1/doc2")).toBeUndefined();
    expect(pq.hasDirty()).toBe(false);

    pq.stop();
  });

  test("onAck resets error count for a doc", async () => {
    const store = new MockStore(db, "vault1/doc1");
    await store.markDirty();
    const docMgr = createMockDocMgr(new Map([["vault1/doc1", store]]));
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    // 3 errors
    for (let i = 0; i < 3; i++) {
      pq.markDirty("vault1/doc1");
      await pq.onPushError("vault1/doc1", "transient error");
    }

    // Ack resets counter
    pq.markDirty("vault1/doc1");
    await pq.onAck("vault1/doc1", 1);

    // 3 more errors should NOT clear dirty flag (counter was reset)
    await store.markDirty();
    for (let i = 0; i < 3; i++) {
      pq.markDirty("vault1/doc1");
      await pq.onPushError("vault1/doc1", "transient error");
      expect(await idbGet(db, "dirty:vault1/doc1")).toBe(true);
    }

    pq.stop();
  });

  test("flushAllDirty pushes all dirty docs", async () => {
    const store1 = new MockStore(db, "vault1/catalog");
    const store2 = new MockStore(db, "vault1/recipe1");
    await store1.markDirty();
    await store2.markDirty();
    const stores = new Map([["vault1/catalog", store1], ["vault1/recipe1", store2]]);
    const docMgr = createMockDocMgr(stores);
    const syncClient = createMockSyncClient(true, "sent");
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    expect(pq.dirtyCount()).toBe(2);
    await pq.flushAllDirty();

    expect(syncClient.push).toHaveBeenCalledTimes(2);
    pq.stop();
  });

  test("flushAllDirty stops iteration when disconnected", async () => {
    const store1 = new MockStore(db, "doc1");
    const store2 = new MockStore(db, "doc2");
    await store1.markDirty();
    await store2.markDirty();
    const stores = new Map([["doc1", store1], ["doc2", store2]]);
    const docMgr = createMockDocMgr(stores);

    let callCount = 0;
    const syncClient = {
      isOpen: () => callCount < 1, // disconnect after first push
      push: mock(async (): Promise<PushResult> => { callCount++; return "not_connected"; }),
      createVault: mock(async () => {}),
    };
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();
    await pq.flushAllDirty();

    // Should have attempted first doc then stopped
    expect(syncClient.push).toHaveBeenCalledTimes(1);
    pq.stop();
  });

  test("pushDoc with no_key removes from dirtySet but NOT from IDB", async () => {
    const store = new MockStore(db, "vault1/catalog");
    await store.markDirty();
    const stores = new Map([["vault1/catalog", store]]);
    const docMgr = createMockDocMgr(stores);
    const syncClient = createMockSyncClient(true, "no_key");
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    expect(pq.hasDirty()).toBe(true);
    await pq.flushAllDirty();

    // Doc stays in dirty set but is deferred (skipped during future flushes)
    expect(pq.hasDirty()).toBe(true);
    expect(pq.pushableCount()).toBe(0);
    // IDB dirty flag persists (poll will re-discover when key arrives)
    expect(await idbGet(db, "dirty:vault1/catalog")).toBe(true);
    pq.stop();
  });

  test("tryClearDirtyOnCaughtUp clears dirty when heads match", async () => {
    const store = new MockStore(db, "vault1/doc1", ["h1", "h2"]);
    await store.markDirty();
    await store.setPushHeads(["h1", "h2"]); // same heads as current
    const stores = new Map([["vault1/doc1", store]]);
    const docMgr = createMockDocMgr(stores);
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    await pq.tryClearDirtyOnCaughtUp("vault1/doc1");

    expect(pq.hasDirty()).toBe(false);
    expect(await store.isDirty()).toBe(false);
    pq.stop();
  });

  test("tryClearDirtyOnCaughtUp keeps dirty when heads differ", async () => {
    const store = new MockStore(db, "vault1/doc1", ["h1", "h2_new"]);
    await store.markDirty();
    await store.setPushHeads(["h1", "h2"]); // different from current
    const stores = new Map([["vault1/doc1", store]]);
    const docMgr = createMockDocMgr(stores);
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    await pq.tryClearDirtyOnCaughtUp("vault1/doc1");

    expect(pq.hasDirty()).toBe(true);
    expect(await store.isDirty()).toBe(true);
    pq.stop();
  });

  test("purgeOrphanedDirty removes dirty flags for unknown vaults", async () => {
    const store1 = new MockStore(db, "vault1/doc1");
    const store2 = new MockStore(db, "vault-gone/doc1");
    await store1.markDirty();
    await store2.markDirty();
    const docMgr = createMockDocMgr(new Map());
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    expect(pq.dirtyCount()).toBe(2);

    // vault1 is known, vault-gone is not
    await pq.purgeOrphanedDirty(new Set(["vault1"]));

    expect(pq.dirtyCount()).toBe(1);
    expect(pq.hasDirty()).toBe(true);
    expect(await idbGet(db, "dirty:vault1/doc1")).toBe(true);
    expect(await idbGet(db, "dirty:vault-gone/doc1")).toBeUndefined();
    pq.stop();
  });

  test("purgeOrphanedDirty preserves personal docs (no slash)", async () => {
    const store = new MockStore(db, "settings");
    await store.markDirty();
    const docMgr = createMockDocMgr(new Map());
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    await pq.purgeOrphanedDirty(new Set()); // no known vaults

    expect(pq.hasDirty()).toBe(true); // personal doc kept
    pq.stop();
  });

  test("signFn is called during push", async () => {
    const store = new MockStore(db, "vault1/catalog");
    await store.markDirty();
    const stores = new Map([["vault1/catalog", store]]);
    const docMgr = createMockDocMgr(stores);
    const syncClient = createMockSyncClient(true, "sent");
    const signFn = mock((raw: Uint8Array) => new Uint8Array([...raw, 0xff]));
    const pq = new PushQueue(docMgr as any, syncClient as any, db, signFn);
    await pq.start();

    await pq.flushNow("vault1/catalog");

    expect(signFn).toHaveBeenCalledTimes(1);
    // Verify the signed payload was passed to push
    const pushCall = syncClient.push.mock.calls[0]!;
    expect(pushCall[1]).toEqual(new Uint8Array([1, 2, 3, 0xff]));
    pq.stop();
  });

  test("dirty change listener fires on state changes", async () => {
    const store = new MockStore(db, "vault1/catalog");
    await store.markDirty();
    const stores = new Map([["vault1/catalog", store]]);
    const docMgr = createMockDocMgr(stores);
    const syncClient = createMockSyncClient(true);
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    const listener = mock(() => {});
    pq.setDirtyChangeListener(listener);
    await pq.start();

    pq.markDirty("vault1/catalog");
    expect(listener).toHaveBeenCalled();

    const countBefore = listener.mock.calls.length;
    await pq.onAck("vault1/catalog", 1);
    expect(listener.mock.calls.length).toBeGreaterThan(countBefore);
    pq.stop();
  });

  test("flushAllDirty skips docs cleared by concurrent onAck", async () => {
    const store1 = new MockStore(db, "doc1");
    const store2 = new MockStore(db, "doc2");
    await store1.markDirty();
    await store2.markDirty();
    const stores = new Map([["doc1", store1], ["doc2", store2]]);
    const docMgr = createMockDocMgr(stores);

    // Simulate: on first push, onAck fires for doc2 (cleared concurrently)
    let firstPush = true;
    const pq_ref: { pq: PushQueue | null } = { pq: null };
    const syncClient = {
      isOpen: () => true,
      push: mock(async (docId: string): Promise<PushResult> => {
        if (firstPush) {
          firstPush = false;
          // Simulate concurrent ack for doc2 while pushing doc1
          await pq_ref.pq!.onAck("doc2", 10);
        }
        return "sent";
      }),
      createVault: mock(async () => {}),
    };
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    pq_ref.pq = pq;
    await pq.start();

    await pq.flushAllDirty();

    // doc1 pushed, doc2 was acked concurrently so skipped
    expect(syncClient.push).toHaveBeenCalledTimes(1);
    pq.stop();
  });

  test("re-opens closed stores via docMgr.open for push", async () => {
    const store = new MockStore(db, "vault1/recipe1");
    await store.markDirty();
    // Store exists in docMgr map (simulates open-able) but NOT returned by get()
    const openMock = mock(async () => store);
    const closeMock = mock(async () => {});
    const docMgr = {
      get: () => null, // not open
      open: openMock,
      close: closeMock,
      getDb: () => null as any,
    };
    const syncClient = createMockSyncClient(true, "sent");
    const pq = new PushQueue(docMgr as any, syncClient as any, db, noopSign);
    await pq.start();

    await pq.flushNow("vault1/recipe1");

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1); // closed after push
    expect(syncClient.push).toHaveBeenCalledTimes(1);
    pq.stop();
  });
});
