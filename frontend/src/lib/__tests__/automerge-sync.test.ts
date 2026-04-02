/**
 * Automerge sync integration tests.
 *
 * Simulates multi-device sync scenarios using real Automerge CRDT operations
 * with AutomergeStore's merge, change, and onChange listener APIs.
 *
 * These tests use fake-indexeddb and real Automerge (no mocks for CRDT logic).
 */

import { describe, test, expect, mock } from "bun:test";
import "fake-indexeddb/auto";
import { AutomergeStore, getAllDirtyDocIds } from "../automerge-store";

// -- Helpers --

/** Simple recipe-like doc type for testing. */
interface TestRecipe {
  title: string;
  tags: string[];
  servings: number;
  ingredients: Array<{ item: string; quantity: string; unit: string }>;
  instructions: string;
  notes: string;
}

const INIT_RECIPE = (doc: TestRecipe) => {
  doc.title = "";
  doc.tags = [];
  doc.servings = 4;
  doc.ingredients = [];
  doc.instructions = "";
  doc.notes = "";
};

async function genKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

function openTestDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("test-" + Math.random(), 1);
    req.onupgradeneeded = () => req.result.createObjectStore("docs");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Open a store, initialize it, and wait for the write to complete. */
async function openStore(db: IDBDatabase, key: CryptoKey, docId = "vault/r1") {
  const store = await AutomergeStore.open<TestRecipe>(db, docId, key, INIT_RECIPE);
  store.ensureInitialized();
  await store.waitForWrite();
  return store;
}

/**
 * Simulate two devices by opening separate AutomergeStore instances backed
 * by separate IDBs. Device B starts with A's initial state merged in.
 */
async function createTwoDevices() {
  const key = await genKey();
  const dbA = await openTestDB();
  const dbB = await openTestDB();
  const storeA = await openStore(dbA, key);
  const storeB = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);
  storeB.merge(storeA.save());
  await storeB.waitForWrite();

  return {
    storeA, storeB, dbA, dbB,
    cleanup: async () => {
      await storeA.waitForWrite();
      await storeB.waitForWrite();
      dbA.close();
      dbB.close();
    },
  };
}

// -- Tests --

describe("AutomergeStore CRDT sync", () => {
  test("change() updates doc and notifies listener", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    const listener = mock(() => {});
    store.onChange(listener);
    store.change((doc) => { doc.title = "Pasta"; });

    expect(store.getDoc().title).toBe("Pasta");
    expect(listener).toHaveBeenCalledTimes(1);
    await store.waitForWrite();
    db.close();
  });

  test("merge() applies remote changes and notifies listener", async () => {
    const key = await genKey();
    const dbA = await openTestDB();
    const dbB = await openTestDB();
    const storeA = await openStore(dbA, key);
    const storeB = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);
    storeB.merge(storeA.save());

    storeA.change((doc) => { doc.title = "Tacos"; });

    const listener = mock(() => {});
    storeB.onChange(listener);
    storeB.merge(storeA.save());

    expect(storeB.getDoc().title).toBe("Tacos");
    expect(listener).toHaveBeenCalledTimes(1);
    await storeA.waitForWrite();
    await storeB.waitForWrite();
    dbA.close();
    dbB.close();
  });

  test("merge() with no actual changes still calls listener", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    const listener = mock(() => {});
    store.onChange(listener);
    store.merge(store.save());

    expect(listener).toHaveBeenCalled();
    await store.waitForWrite();
    db.close();
  });

  test("onChange unsubscribe prevents future notifications", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    const listener = mock(() => {});
    const unsub = store.onChange(listener);

    store.change((doc) => { doc.title = "A"; });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    store.change((doc) => { doc.title = "B"; });
    expect(listener).toHaveBeenCalledTimes(1); // still 1

    await store.waitForWrite();
    db.close();
  });

  test("multiple listeners all receive notifications", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    const listener1 = mock(() => {});
    const listener2 = mock(() => {});
    store.onChange(listener1);
    store.onChange(listener2);

    store.change((doc) => { doc.title = "Pizza"; });

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    await store.waitForWrite();
    db.close();
  });
});

describe("Two-device sync scenarios", () => {
  test("title change on A is visible on B after merge", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => { doc.title = "Spaghetti"; });
    storeB.merge(storeA.save());
    expect(storeB.getDoc().title).toBe("Spaghetti");
    await cleanup();
  });

  test("concurrent title edits converge deterministically", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => { doc.title = "From A"; });
    storeB.change((doc) => { doc.title = "From B"; });

    storeA.merge(storeB.save());
    storeB.merge(storeA.save());

    expect(storeA.getDoc().title).toBe(storeB.getDoc().title);
    await cleanup();
  });

  test("ingredient list additions from both devices merge", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => {
      doc.ingredients.push({ item: "flour", quantity: "2", unit: "cups" });
    });
    storeB.change((doc) => {
      doc.ingredients.push({ item: "sugar", quantity: "1", unit: "cup" });
    });

    storeA.merge(storeB.save());
    storeB.merge(storeA.save());

    const itemsA = storeA.getDoc().ingredients.map((i: any) => i.item);
    const itemsB = storeB.getDoc().ingredients.map((i: any) => i.item);
    expect(itemsA).toContain("flour");
    expect(itemsA).toContain("sugar");
    expect(itemsA.length).toBe(2);
    expect(itemsA).toEqual(itemsB);
    await cleanup();
  });

  test("tag additions from both devices merge without duplicates", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => { doc.tags.push("dinner"); });
    storeB.change((doc) => { doc.tags.push("quick"); });

    storeA.merge(storeB.save());
    storeB.merge(storeA.save());

    const tagsA = storeA.getDoc().tags;
    const tagsB = storeB.getDoc().tags;
    expect(tagsA).toContain("dinner");
    expect(tagsA).toContain("quick");
    expect(tagsA.length).toBe(2);
    expect(tagsA).toEqual(tagsB);
    await cleanup();
  });

  test("servings edit on A reflected on B after merge", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => { doc.servings = 8; });
    storeB.merge(storeA.save());
    expect(storeB.getDoc().servings).toBe(8);
    await cleanup();
  });

  test("instructions text set on A is received on B", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => { doc.instructions = "Boil water. Add pasta."; });
    storeB.merge(storeA.save());
    expect(storeB.getDoc().instructions).toBe("Boil water. Add pasta.");
    await cleanup();
  });

  test("deleting an ingredient on A is reflected on B", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => {
      doc.ingredients.push({ item: "salt", quantity: "1", unit: "tsp" });
      doc.ingredients.push({ item: "pepper", quantity: "1/2", unit: "tsp" });
    });
    storeB.merge(storeA.save());
    expect(storeB.getDoc().ingredients.length).toBe(2);

    storeA.change((doc) => { doc.ingredients.splice(0, 1); });
    storeB.merge(storeA.save());

    expect(storeB.getDoc().ingredients.length).toBe(1);
    expect(storeB.getDoc().ingredients[0]!.item).toBe("pepper");
    await cleanup();
  });

  test("editing ingredient quantity on A is reflected on B", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => {
      doc.ingredients.push({ item: "butter", quantity: "2", unit: "tbsp" });
    });
    storeB.merge(storeA.save());

    storeA.change((doc) => { doc.ingredients[0]!.quantity = "3"; });
    storeB.merge(storeA.save());

    expect(storeB.getDoc().ingredients[0]!.quantity).toBe("3");
    await cleanup();
  });
});

describe("onChange listener in sync scenarios", () => {
  test("listener fires for each merge with new data", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    const listener = mock(() => {});
    storeB.onChange(listener);

    storeA.change((doc) => { doc.title = "V1"; });
    storeB.merge(storeA.save());

    storeA.change((doc) => { doc.title = "V2"; });
    storeB.merge(storeA.save());

    storeA.change((doc) => { doc.title = "V3"; });
    storeB.merge(storeA.save());

    expect(listener).toHaveBeenCalledTimes(3);
    expect(storeB.getDoc().title).toBe("V3");
    await cleanup();
  });

  test("listener receives full updated doc on each change", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    const titles: string[] = [];
    storeB.onChange((doc) => { titles.push(doc.title); });

    storeA.change((doc) => { doc.title = "First"; });
    storeB.merge(storeA.save());

    storeA.change((doc) => { doc.title = "Second"; });
    storeB.merge(storeA.save());

    expect(titles).toEqual(["First", "Second"]);
    await cleanup();
  });

  test("listener fires for both local changes and remote merges", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    const calls: string[] = [];
    storeB.onChange((doc) => { calls.push(doc.title); });

    storeB.change((doc) => { doc.title = "Local"; });

    storeA.change((doc) => { doc.title = "Remote"; });
    storeB.merge(storeA.save());

    expect(calls.length).toBe(2);
    expect(calls[0]).toBe("Local");
    expect(typeof calls[1]).toBe("string");
    await cleanup();
  });

  test("multiple listeners on different fields all see updates", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    const titleUpdates: string[] = [];
    const servingsUpdates: number[] = [];
    storeB.onChange((doc) => { titleUpdates.push(doc.title); });
    storeB.onChange((doc) => { servingsUpdates.push(doc.servings); });

    storeA.change((doc) => { doc.title = "Cake"; doc.servings = 12; });
    storeB.merge(storeA.save());

    expect(titleUpdates).toEqual(["Cake"]);
    expect(servingsUpdates).toEqual([12]);
    await cleanup();
  });
});

describe("Persistence across reload", () => {
  test("changes survive store re-open (simulated reload)", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store1 = await openStore(db, key);
    store1.change((doc) => { doc.title = "Saved Recipe"; doc.servings = 6; });
    await store1.waitForWrite();

    const store2 = await AutomergeStore.open<TestRecipe>(db, "vault/r1", key, INIT_RECIPE);
    expect(store2.getDoc().title).toBe("Saved Recipe");
    expect(store2.getDoc().servings).toBe(6);
    await store2.waitForWrite();
    db.close();
  });

  test("merged remote data persists across reload", async () => {
    const key = await genKey();
    const dbA = await openTestDB();
    const dbB = await openTestDB();
    const storeA = await openStore(dbA, key);
    storeA.change((doc) => { doc.title = "Remote Title"; });
    await storeA.waitForWrite();

    const storeB = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);
    storeB.merge(storeA.save());
    await storeB.waitForWrite();

    // Re-open B (simulates reload)
    const storeB2 = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);
    expect(storeB2.getDoc().title).toBe("Remote Title");
    await storeB2.waitForWrite();
    dbA.close();
    dbB.close();
  });

  test("ingredients persist after reload", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store1 = await openStore(db, key);
    store1.change((doc) => {
      doc.ingredients.push({ item: "chicken", quantity: "500", unit: "g" });
      doc.ingredients.push({ item: "rice", quantity: "2", unit: "cups" });
    });
    await store1.waitForWrite();

    const store2 = await AutomergeStore.open<TestRecipe>(db, "vault/r1", key, INIT_RECIPE);
    expect(store2.getDoc().ingredients.length).toBe(2);
    expect(store2.getDoc().ingredients[0]!.item).toBe("chicken");
    expect(store2.getDoc().ingredients[1]!.item).toBe("rice");
    await store2.waitForWrite();
    db.close();
  });
});

describe("Dirty flag tracking", () => {
  test("local change marks dirty, merge does not", async () => {
    const key = await genKey();
    const dbA = await openTestDB();
    const dbB = await openTestDB();
    const storeA = await openStore(dbA, key);

    storeA.change((doc) => { doc.title = "Local Edit"; });
    await storeA.waitForWrite();
    expect(await storeA.isDirty()).toBe(true);

    await storeA.clearDirty();
    expect(await storeA.isDirty()).toBe(false);

    // Merge (remote change) should NOT mark dirty
    const storeB = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);
    storeB.merge(storeA.save());
    storeB.change((doc) => { doc.title = "From Remote"; });
    await storeB.waitForWrite();
    storeA.merge(storeB.save());
    await storeA.waitForWrite();
    expect(await storeA.isDirty()).toBe(false);

    dbA.close();
    dbB.close();
  });
});

describe("Three-device convergence", () => {
  test("three devices with concurrent edits all converge", async () => {
    const key = await genKey();
    const dbA = await openTestDB();
    const dbB = await openTestDB();
    const dbC = await openTestDB();
    const storeA = await openStore(dbA, key);

    const storeB = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);
    storeB.merge(storeA.save());
    await storeB.waitForWrite();

    const storeC = await AutomergeStore.open<TestRecipe>(dbC, "vault/r1", key, INIT_RECIPE);
    storeC.merge(storeA.save());
    await storeC.waitForWrite();

    storeA.change((doc) => { doc.ingredients.push({ item: "salt", quantity: "1", unit: "tsp" }); });
    storeB.change((doc) => { doc.ingredients.push({ item: "pepper", quantity: "1/2", unit: "tsp" }); });
    storeC.change((doc) => { doc.ingredients.push({ item: "garlic", quantity: "3", unit: "cloves" }); });

    // Full mesh merge
    storeA.merge(storeB.save());
    storeA.merge(storeC.save());
    storeB.merge(storeA.save());
    storeC.merge(storeA.save());

    const items = (s: AutomergeStore<TestRecipe>) =>
      s.getDoc().ingredients.map((i: any) => i.item).sort();

    expect(items(storeA)).toEqual(["garlic", "pepper", "salt"]);
    expect(items(storeB)).toEqual(["garlic", "pepper", "salt"]);
    expect(items(storeC)).toEqual(["garlic", "pepper", "salt"]);

    await storeA.waitForWrite();
    await storeB.waitForWrite();
    await storeC.waitForWrite();
    dbA.close();
    dbB.close();
    dbC.close();
  });
});

describe("Edge cases", () => {
  test("merge with empty snapshot on fresh doc", async () => {
    const key = await genKey();
    const dbA = await openTestDB();
    const dbB = await openTestDB();
    const storeA = await openStore(dbA, key);
    const storeB = await openStore(dbB, key);

    storeA.merge(storeB.save());
    expect(storeA.getDoc().title).toBe("");
    expect(storeA.getDoc().servings).toBe(4);

    await storeA.waitForWrite();
    await storeB.waitForWrite();
    dbA.close();
    dbB.close();
  });

  test("rapid sequential merges all apply", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    const listener = mock(() => {});
    storeB.onChange(listener);

    for (let i = 0; i < 10; i++) {
      storeA.change((doc) => { doc.title = `v${i}`; });
      storeB.merge(storeA.save());
    }

    expect(storeB.getDoc().title).toBe("v9");
    expect(listener).toHaveBeenCalledTimes(10);
    await cleanup();
  });

  test("merge is idempotent", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => { doc.title = "Once"; });
    const snapshot = storeA.save();

    storeB.merge(snapshot);
    storeB.merge(snapshot);
    storeB.merge(snapshot);

    expect(storeB.getDoc().title).toBe("Once");
    expect(storeB.getDoc().ingredients.length).toBe(0);
    await cleanup();
  });

  test("ensureInitialized only fires once", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await AutomergeStore.open<TestRecipe>(db, "vault/r1", key, INIT_RECIPE);
    const listener = mock(() => {});
    store.onChange(listener);

    const init1 = store.ensureInitialized();
    const init2 = store.ensureInitialized();

    expect(init1).toBe(true);
    expect(init2).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    await store.waitForWrite();
    db.close();
  });

  test("clear resets doc to fresh state", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);
    store.change((doc) => {
      doc.title = "Old";
      doc.ingredients.push({ item: "old stuff", quantity: "1", unit: "cup" });
    });
    await store.waitForWrite();

    await store.clear(INIT_RECIPE);

    expect(store.getDoc().title).toBe("");
    expect(store.getDoc().ingredients.length).toBe(0);
    expect(store.getDoc().servings).toBe(4);
    await store.waitForWrite();
    db.close();
  });

  test("concurrent edits to different fields both preserved", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    storeA.change((doc) => { doc.title = "New Title"; });
    storeB.change((doc) => { doc.servings = 12; });

    storeA.merge(storeB.save());
    storeB.merge(storeA.save());

    expect(storeA.getDoc().title).toBe("New Title");
    expect(storeA.getDoc().servings).toBe(12);
    expect(storeB.getDoc().title).toBe("New Title");
    expect(storeB.getDoc().servings).toBe(12);
    await cleanup();
  });

  test("concurrent ingredient edits on different indices both preserved", async () => {
    const { storeA, storeB, cleanup } = await createTwoDevices();
    // Setup: both devices have two ingredients
    storeA.change((doc) => {
      doc.ingredients.push({ item: "flour", quantity: "2", unit: "cups" });
      doc.ingredients.push({ item: "sugar", quantity: "1", unit: "cup" });
    });
    storeB.merge(storeA.save());

    // A edits flour quantity, B edits sugar quantity
    storeA.change((doc) => { doc.ingredients[0]!.quantity = "3"; });
    storeB.change((doc) => { doc.ingredients[1]!.quantity = "2"; });

    storeA.merge(storeB.save());
    storeB.merge(storeA.save());

    expect(storeA.getDoc().ingredients[0]!.quantity).toBe("3");
    expect(storeA.getDoc().ingredients[1]!.quantity).toBe("2");
    expect(storeB.getDoc().ingredients[0]!.quantity).toBe("3");
    expect(storeB.getDoc().ingredients[1]!.quantity).toBe("2");
    await cleanup();
  });
});

// ── Mid-edit crash and recovery ──

describe("Mid-edit crash: dirty flag recovery", () => {
  test("edit + flush leaves dirty flag in IDB — discoverable on restart", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    store.change((doc) => { doc.title = "Unsent Edit"; });
    await store.waitForWrite();

    expect(await store.isDirty()).toBe(true);

    const dirtyIds = await getAllDirtyDocIds(db);
    expect(dirtyIds).toContain("vault/r1");

    db.close();
  });

  test("re-opened store after crash still has the local change", async () => {
    const db = await openTestDB();
    const key = await genKey();

    const store1 = await openStore(db, key);
    store1.change((doc) => {
      doc.title = "Crash Edit";
      doc.ingredients.push({ item: "olive oil", quantity: "2", unit: "tbsp" });
    });
    await store1.waitForWrite();
    expect(await store1.isDirty()).toBe(true);

    // "Restart" — re-open the same doc from IDB
    const store2 = await AutomergeStore.open<TestRecipe>(db, "vault/r1", key, INIT_RECIPE);
    expect(store2.getDoc().title).toBe("Crash Edit");
    expect(store2.getDoc().ingredients.length).toBe(1);
    expect(store2.getDoc().ingredients[0]!.item).toBe("olive oil");
    expect(await store2.isDirty()).toBe(true);

    await store2.waitForWrite();
    db.close();
  });

  test("dirty flag persists even if change() is called many times before crash", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    for (let i = 0; i < 20; i++) {
      store.change((doc) => { doc.title = `Edit ${i}`; });
    }
    await store.waitForWrite();

    expect(await store.isDirty()).toBe(true);
    const dirtyIds = await getAllDirtyDocIds(db);
    expect(dirtyIds).toContain("vault/r1");

    const store2 = await AutomergeStore.open<TestRecipe>(db, "vault/r1", key, INIT_RECIPE);
    expect(store2.getDoc().title).toBe("Edit 19");

    await store2.waitForWrite();
    db.close();
  });

  test("clearDirty after successful push removes the flag", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    store.change((doc) => { doc.title = "Pushed"; });
    await store.waitForWrite();
    expect(await store.isDirty()).toBe(true);

    await store.clearDirty();
    expect(await store.isDirty()).toBe(false);

    const dirtyIds = await getAllDirtyDocIds(db);
    expect(dirtyIds).not.toContain("vault/r1");

    await store.waitForWrite();
    db.close();
  });
});

describe("Mid-edit crash: merge recovery on reconnect", () => {
  test("device with unpushed local changes merges cleanly with remote state", async () => {
    const key = await genKey();
    const dbA = await openTestDB();
    const dbB = await openTestDB();

    const storeA = await openStore(dbA, key);
    const storeB = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);
    storeB.merge(storeA.save());
    await storeB.waitForWrite();

    // Device A edits offline
    storeA.change((doc) => { doc.title = "A's offline edit"; });
    storeA.change((doc) => { doc.ingredients.push({ item: "basil", quantity: "5", unit: "leaves" }); });
    await storeA.waitForWrite();

    // Device B edits while A was offline
    storeB.change((doc) => { doc.servings = 6; });
    storeB.change((doc) => { doc.instructions = "New instructions from B"; });
    await storeB.waitForWrite();

    // A "reconnects" — receives B's state
    storeA.merge(storeB.save());

    expect(storeA.getDoc().title).toBe("A's offline edit");
    expect(storeA.getDoc().ingredients.length).toBe(1);
    expect(storeA.getDoc().servings).toBe(6);
    expect(storeA.getDoc().instructions).toBe("New instructions from B");

    // B receives A's state — should converge
    storeB.merge(storeA.save());
    expect(storeB.getDoc().title).toBe("A's offline edit");
    expect(storeB.getDoc().ingredients.length).toBe(1);
    expect(storeB.getDoc().servings).toBe(6);

    await storeA.waitForWrite();
    await storeB.waitForWrite();
    dbA.close();
    dbB.close();
  });

  test("crashed device re-opens and merges remote state correctly", async () => {
    const key = await genKey();
    const dbA = await openTestDB();
    const dbB = await openTestDB();

    // Session 1: device A edits, then "crashes"
    const storeA1 = await openStore(dbA, key);
    storeA1.change((doc) => {
      doc.title = "Pre-crash title";
      doc.ingredients.push({ item: "salt", quantity: "1", unit: "tsp" });
    });
    await storeA1.waitForWrite();
    const snapshotBeforeCrash = storeA1.save();

    // Device B diverges while A is down
    const storeB = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);
    storeB.merge(snapshotBeforeCrash);
    storeB.change((doc) => {
      doc.ingredients.push({ item: "pepper", quantity: "1/2", unit: "tsp" });
      doc.notes = "Added by device B while A was down";
    });
    await storeB.waitForWrite();

    // Session 2: device A "restarts" from IDB
    const storeA2 = await AutomergeStore.open<TestRecipe>(dbA, "vault/r1", key, INIT_RECIPE);
    expect(storeA2.getDoc().title).toBe("Pre-crash title");
    expect(storeA2.getDoc().ingredients.length).toBe(1);

    // A catches up
    storeA2.merge(storeB.save());

    expect(storeA2.getDoc().title).toBe("Pre-crash title");
    expect(storeA2.getDoc().ingredients.length).toBe(2);
    expect(storeA2.getDoc().notes).toBe("Added by device B while A was down");

    await storeA2.waitForWrite();
    await storeB.waitForWrite();
    dbA.close();
    dbB.close();
  });
});

describe("Mid-edit crash: incomplete write scenarios", () => {
  test("change() without waitForWrite: in-memory doc is updated immediately", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    store.change((doc) => { doc.title = "In Memory Only?"; });

    // In-memory doc is immediately updated
    expect(store.getDoc().title).toBe("In Memory Only?");

    // Wait for the write, then verify persistence
    await store.waitForWrite();
    const store2 = await AutomergeStore.open<TestRecipe>(db, "vault/r1", key, INIT_RECIPE);
    expect(store2.getDoc().title).toBe("In Memory Only?");
    expect(await store2.isDirty()).toBe(true);

    await store2.waitForWrite();
    db.close();
  });

  test("merge() does NOT set dirty flag (remote data shouldn't trigger push)", async () => {
    const key = await genKey();
    const dbA = await openTestDB();
    const dbB = await openTestDB();
    const storeA = await openStore(dbA, key);
    const storeB = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);
    storeB.merge(storeA.save());
    await storeB.waitForWrite();
    await storeB.clearDirty(); // clear init dirty

    storeA.change((doc) => { doc.title = "Remote Change"; });
    await storeA.waitForWrite();

    storeB.merge(storeA.save());
    await storeB.waitForWrite();

    expect(storeB.getDoc().title).toBe("Remote Change");
    expect(await storeB.isDirty()).toBe(false);

    dbA.close();
    dbB.close();
  });

  test("multiple rapid changes: all survive if writes complete", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    store.change((doc) => { doc.title = "v1"; });
    store.change((doc) => { doc.title = "v2"; });
    store.change((doc) => { doc.title = "v3"; });
    await store.waitForWrite();

    const store2 = await AutomergeStore.open<TestRecipe>(db, "vault/r1", key, INIT_RECIPE);
    expect(store2.getDoc().title).toBe("v3");
    expect(await store2.isDirty()).toBe(true);

    await store2.waitForWrite();
    db.close();
  });
});

describe("Mid-edit crash: multi-doc dirty tracking", () => {
  test("multiple docs dirty at crash time are all discovered on restart", async () => {
    const db = await openTestDB();
    const key = await genKey();

    const store1 = await openStore(db, key, "vault/recipe1");
    const store2 = await openStore(db, key, "vault/recipe2");
    const store3 = await openStore(db, key, "vault/catalog");

    store1.change((doc) => { doc.title = "Recipe 1"; });
    store2.change((doc) => { doc.title = "Recipe 2"; });
    store3.change((doc) => { doc.title = "Catalog"; });

    await store1.waitForWrite();
    await store2.waitForWrite();
    await store3.waitForWrite();

    const dirtyIds = await getAllDirtyDocIds(db);
    expect(dirtyIds.length).toBe(3);
    expect(dirtyIds).toContain("vault/recipe1");
    expect(dirtyIds).toContain("vault/recipe2");
    expect(dirtyIds).toContain("vault/catalog");

    db.close();
  });

  test("only unpushed docs remain dirty after partial ack", async () => {
    const db = await openTestDB();
    const key = await genKey();

    const store1 = await openStore(db, key, "vault/recipe1");
    const store2 = await openStore(db, key, "vault/recipe2");

    store1.change((doc) => { doc.title = "Recipe 1"; });
    store2.change((doc) => { doc.title = "Recipe 2"; });

    await store1.waitForWrite();
    await store2.waitForWrite();

    // recipe1 was pushed and acked before crash
    await store1.clearDirty();

    const dirtyIds = await getAllDirtyDocIds(db);
    expect(dirtyIds.length).toBe(1);
    expect(dirtyIds).toContain("vault/recipe2");
    expect(dirtyIds).not.toContain("vault/recipe1");

    db.close();
  });

  test("push heads allow detecting stale dirty flags after reconnect", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    store.change((doc) => { doc.title = "Pushed Before Crash"; });
    await store.waitForWrite();

    // Push was sent and heads recorded, but ack never arrived (crash)
    const headsAtPush = store.getHeads();
    await store.setPushHeads(headsAtPush);

    // "Restart" — heads match means the push likely arrived
    const pushHeads = await store.getPushHeads();
    const currentHeads = store.getHeads();
    expect(pushHeads).not.toBeNull();
    expect(pushHeads!.length).toBe(currentHeads.length);
    expect(pushHeads!.every((h, i) => h === currentHeads[i])).toBe(true);

    await store.clearDirty();
    expect(await store.isDirty()).toBe(false);

    await store.waitForWrite();
    db.close();
  });

  test("push heads differ after more local edits: must re-push", async () => {
    const db = await openTestDB();
    const key = await genKey();
    const store = await openStore(db, key);

    store.change((doc) => { doc.title = "V1"; });
    await store.waitForWrite();

    const headsAtPush = store.getHeads();
    await store.setPushHeads(headsAtPush);

    // More edits happen after the push (before crash)
    store.change((doc) => { doc.title = "V2"; });
    await store.waitForWrite();

    const pushHeads = await store.getPushHeads();
    const currentHeads = store.getHeads();
    const headsMatch = pushHeads!.length === currentHeads.length &&
      pushHeads!.every((h, i) => h === currentHeads[i]);
    expect(headsMatch).toBe(false);
    expect(await store.isDirty()).toBe(true);

    await store.waitForWrite();
    db.close();
  });
});

describe("Mid-edit crash: ensureInitialized edge cases", () => {
  test("new doc: ensureInitialized sets defaults on empty doc", async () => {
    const db = await openTestDB();
    const key = await genKey();

    const store = await AutomergeStore.open<TestRecipe>(db, "vault/r1", key, INIT_RECIPE);
    const didInit = store.ensureInitialized();
    expect(didInit).toBe(true);
    expect(store.getDoc().title).toBe("");
    expect(store.getDoc().servings).toBe(4);

    await store.waitForWrite();
    db.close();
  });

  test("existing doc: ensureInitialized does NOT overwrite data", async () => {
    const db = await openTestDB();
    const key = await genKey();

    const store1 = await openStore(db, key);
    store1.change((doc) => { doc.title = "Existing Recipe"; doc.servings = 8; });
    await store1.waitForWrite();

    const store2 = await AutomergeStore.open<TestRecipe>(db, "vault/r1", key, INIT_RECIPE);
    const didInit = store2.ensureInitialized();
    expect(didInit).toBe(false);
    expect(store2.getDoc().title).toBe("Existing Recipe");
    expect(store2.getDoc().servings).toBe(8);

    await store2.waitForWrite();
    db.close();
  });

  test("new doc receives remote state before init: remote state wins", async () => {
    const key = await genKey();
    const dbA = await openTestDB();
    const dbB = await openTestDB();

    const storeA = await openStore(dbA, key);
    storeA.change((doc) => { doc.title = "Real Recipe"; doc.servings = 12; });
    await storeA.waitForWrite();

    // Device B opens a fresh doc (not yet initialized)
    const storeB = await AutomergeStore.open<TestRecipe>(dbB, "vault/r1", key, INIT_RECIPE);

    // Receive remote state before ensureInitialized
    storeB.merge(storeA.save());

    // ensureInitialized should see the doc has changes and skip init
    const didInit = storeB.ensureInitialized();
    expect(didInit).toBe(false);
    expect(storeB.getDoc().title).toBe("Real Recipe");
    expect(storeB.getDoc().servings).toBe(12);

    await storeA.waitForWrite();
    await storeB.waitForWrite();
    dbA.close();
    dbB.close();
  });
});
