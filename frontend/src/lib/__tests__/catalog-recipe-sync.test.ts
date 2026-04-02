/**
 * Catalog ↔ Recipe doc sync integration tests.
 *
 * Verifies that title/tags stay consistent between the lightweight catalog
 * (used for sidebar display) and the full recipe documents (source of truth).
 *
 * Tests simulate the application-level sync logic that sits on top of
 * AutomergeStore: the reconciliation in selectRecipe(), the onSyncCatalogMeta
 * callback, and the flushMeta → onMetaChanged flow.
 */

import { describe, test, expect, mock } from "bun:test";
import "fake-indexeddb/auto";
import { AutomergeStore } from "../automerge-store";

// -- Types --

interface TestRecipe {
  title: string;
  tags: string[];
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  createdAt: number;
  updatedAt: number;
  description: string;
  ingredients: Array<{ item: string; quantity: string; unit: string }>;
  instructions: string;
  imageUrls: string[];
  notes: string;
}

interface TestCatalogEntry {
  id: string;
  title: string;
  tags: string[];
}

interface TestCatalog {
  name: string;
  recipes: TestCatalogEntry[];
}

// -- Init functions --

const INIT_RECIPE = (doc: TestRecipe) => {
  doc.title = ""; doc.tags = []; doc.servings = 4;
  doc.prepMinutes = 0; doc.cookMinutes = 0;
  doc.createdAt = Date.now(); doc.updatedAt = Date.now();
  doc.description = ""; doc.ingredients = []; doc.instructions = "";
  doc.imageUrls = []; doc.notes = "";
};

const INIT_CATALOG = (doc: TestCatalog) => {
  doc.name = "Test Book";
  doc.recipes = [];
};

// -- Helpers --

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

async function openStore<T>(db: IDBDatabase, key: CryptoKey, docId: string, init: (doc: T) => void) {
  const store = await AutomergeStore.open<T>(db, docId, key, init);
  store.ensureInitialized();
  await store.waitForWrite();
  return store;
}

const VAULT = "vault1";
const RECIPE_ID = "recipe-abc";
const CATALOG_DOC_ID = `${VAULT}/catalog`;
const RECIPE_DOC_ID = `${VAULT}/${RECIPE_ID}`;

/**
 * Set up a device with a catalog containing one recipe entry,
 * and a recipe doc with matching title/tags.
 */
async function setupDevice(opts?: { title?: string; tags?: string[] }) {
  const title = opts?.title ?? "Original Title";
  const tags = opts?.tags ?? ["dinner"];
  const key = await genKey();
  const db = await openTestDB();

  const catalog = await openStore<TestCatalog>(db, key, CATALOG_DOC_ID, INIT_CATALOG);
  catalog.change((doc) => {
    doc.recipes.push({ id: RECIPE_ID, title, tags: [...tags] });
  });
  await catalog.waitForWrite();

  const recipe = await openStore<TestRecipe>(db, key, RECIPE_DOC_ID, INIT_RECIPE);
  recipe.change((doc) => {
    doc.title = title;
    doc.tags = [...tags] as any;
  });
  await recipe.waitForWrite();

  return { db, key, catalog, recipe };
}

/**
 * Create a second device pre-synced with the first device's state.
 */
async function addDevice(source: { key: CryptoKey; catalog: AutomergeStore<TestCatalog>; recipe: AutomergeStore<TestRecipe> }) {
  const db = await openTestDB();

  const catalog = await AutomergeStore.open<TestCatalog>(db, CATALOG_DOC_ID, source.key, INIT_CATALOG);
  catalog.merge(source.catalog.save());
  await catalog.waitForWrite();

  const recipe = await AutomergeStore.open<TestRecipe>(db, RECIPE_DOC_ID, source.key, INIT_RECIPE);
  recipe.merge(source.recipe.save());
  await recipe.waitForWrite();

  return { db, catalog, recipe };
}

/**
 * Simulate the reconciliation logic from selectRecipe():
 * recipe doc is source of truth — if catalog entry differs, update it.
 * If recipe doc is empty and catalog has data, seed from catalog (migration).
 */
function reconcileOnOpen(catalog: AutomergeStore<TestCatalog>, recipe: AutomergeStore<TestRecipe>) {
  const recipeDoc = recipe.getDoc();
  const catalogDoc = catalog.getDoc();
  const entry = catalogDoc.recipes?.find((r) => r.id === RECIPE_ID);

  if (!recipeDoc.title && entry?.title) {
    // Migration: seed recipe doc from catalog
    recipe.change((doc) => {
      doc.title = entry.title;
      doc.tags = [...(entry.tags ?? [])] as any;
    });
    return "migrated";
  } else if (recipeDoc.title && entry) {
    // Reconcile: recipe doc is source of truth
    if (entry.title !== recipeDoc.title || JSON.stringify(entry.tags ?? []) !== JSON.stringify(recipeDoc.tags ?? [])) {
      catalog.change((doc) => {
        const e = doc.recipes?.find((r) => r.id === RECIPE_ID);
        if (e) {
          e.title = recipeDoc.title;
          e.tags = [...(recipeDoc.tags ?? [])] as any;
        }
      });
      return "reconciled";
    }
  }
  return "no-op";
}

/**
 * Simulate the onSyncCatalogMeta callback:
 * when recipe doc title/tags change (local or remote), update catalog.
 */
function syncCatalogFromRecipe(catalog: AutomergeStore<TestCatalog>, recipe: AutomergeStore<TestRecipe>) {
  const recipeDoc = recipe.getDoc();
  const catalogDoc = catalog.getDoc();
  const entry = catalogDoc.recipes?.find((r) => r.id === RECIPE_ID);
  if (!entry) return false;
  if (entry.title === recipeDoc.title && JSON.stringify(entry.tags) === JSON.stringify(recipeDoc.tags)) return false;

  catalog.change((doc) => {
    const e = doc.recipes?.find((r) => r.id === RECIPE_ID);
    if (e) {
      e.title = recipeDoc.title;
      e.tags = [...(recipeDoc.tags ?? [])] as any;
    }
  });
  return true;
}

/**
 * Simulate the flushMeta → onMetaChanged flow:
 * user edits title/tags → writes recipe doc → mirrors to catalog.
 */
function userEditMeta(
  catalog: AutomergeStore<TestCatalog>,
  recipe: AutomergeStore<TestRecipe>,
  title: string,
  tags: string[],
) {
  // flushMeta writes to recipe doc
  recipe.change((doc) => {
    doc.title = title;
    doc.tags = [...tags] as any;
    doc.updatedAt = Date.now();
  });
  // onMetaChanged mirrors to catalog
  catalog.change((doc) => {
    const entry = doc.recipes?.find((r) => r.id === RECIPE_ID);
    if (entry) {
      entry.title = title;
      entry.tags = [...tags] as any;
    }
  });
}

// -- Tests --

describe("Catalog ↔ Recipe doc: initial consistency", () => {
  test("new recipe has matching title/tags in catalog and doc", async () => {
    const { db, catalog, recipe } = await setupDevice({ title: "Pasta", tags: ["italian", "quick"] });
    const entry = catalog.getDoc().recipes.find((r) => r.id === RECIPE_ID)!;

    expect(entry.title).toBe("Pasta");
    expect(entry.tags).toEqual(["italian", "quick"]);
    expect(recipe.getDoc().title).toBe("Pasta");
    expect(recipe.getDoc().tags).toEqual(["italian", "quick"]);

    await catalog.waitForWrite();
    await recipe.waitForWrite();
    db.close();
  });

  test("reconcileOnOpen is no-op when already in sync", async () => {
    const { db, catalog, recipe } = await setupDevice({ title: "Bread" });
    const result = reconcileOnOpen(catalog, recipe);

    expect(result).toBe("no-op");

    await catalog.waitForWrite();
    await recipe.waitForWrite();
    db.close();
  });
});

describe("Catalog ↔ Recipe doc: local edits", () => {
  test("userEditMeta updates both stores atomically", async () => {
    const { db, catalog, recipe } = await setupDevice({ title: "Old Name" });
    userEditMeta(catalog, recipe, "New Name", ["updated"]);

    const entry = catalog.getDoc().recipes.find((r) => r.id === RECIPE_ID)!;
    expect(entry.title).toBe("New Name");
    expect(entry.tags).toEqual(["updated"]);
    expect(recipe.getDoc().title).toBe("New Name");
    expect(recipe.getDoc().tags).toEqual(["updated"]);

    await catalog.waitForWrite();
    await recipe.waitForWrite();
    db.close();
  });

  test("multiple renames keep both stores in sync", async () => {
    const { db, catalog, recipe } = await setupDevice({ title: "v1" });

    userEditMeta(catalog, recipe, "v2", ["a"]);
    userEditMeta(catalog, recipe, "v3", ["a", "b"]);
    userEditMeta(catalog, recipe, "v4 Final", ["a", "b", "c"]);

    const entry = catalog.getDoc().recipes.find((r) => r.id === RECIPE_ID)!;
    expect(entry.title).toBe("v4 Final");
    expect(entry.tags).toEqual(["a", "b", "c"]);
    expect(recipe.getDoc().title).toBe("v4 Final");

    await catalog.waitForWrite();
    await recipe.waitForWrite();
    db.close();
  });
});

describe("Catalog ↔ Recipe doc: remote recipe doc sync", () => {
  test("remote recipe title change syncs to local catalog via onChange", async () => {
    const devA = await setupDevice({ title: "Soup" });
    const devB = await addDevice(devA);

    // Device A renames (both stores updated locally)
    userEditMeta(devA.catalog, devA.recipe, "Soup v2", ["hot"]);

    // Device B receives the recipe doc change (remote sync)
    devB.recipe.merge(devA.recipe.save());
    expect(devB.recipe.getDoc().title).toBe("Soup v2");

    // Simulate the onSyncCatalogMeta callback
    const didSync = syncCatalogFromRecipe(devB.catalog, devB.recipe);
    expect(didSync).toBe(true);

    // Catalog on device B is now in sync
    const entry = devB.catalog.getDoc().recipes.find((r) => r.id === RECIPE_ID)!;
    expect(entry.title).toBe("Soup v2");
    expect(entry.tags).toEqual(["hot"]);

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    devA.db.close(); devB.db.close();
  });

  test("remote recipe doc change WITHOUT syncCatalogFromRecipe leaves catalog stale", async () => {
    const devA = await setupDevice({ title: "Bread" });
    const devB = await addDevice(devA);

    // Device A renames
    userEditMeta(devA.catalog, devA.recipe, "Sourdough", ["baking"]);

    // Device B only receives the recipe doc (catalog sync hasn't arrived yet)
    devB.recipe.merge(devA.recipe.save());
    expect(devB.recipe.getDoc().title).toBe("Sourdough");

    // WITHOUT calling syncCatalogFromRecipe, catalog is stale
    const entry = devB.catalog.getDoc().recipes.find((r) => r.id === RECIPE_ID)!;
    expect(entry.title).toBe("Bread"); // still old!
    expect(entry.tags).toEqual(["dinner"]); // still old!

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    devA.db.close(); devB.db.close();
  });

  test("reconcileOnOpen fixes stale catalog after missed sync", async () => {
    const devA = await setupDevice({ title: "Cake" });
    const devB = await addDevice(devA);

    // Device A renames
    userEditMeta(devA.catalog, devA.recipe, "Chocolate Cake", ["dessert"]);

    // Device B gets recipe doc change but not catalog change
    devB.recipe.merge(devA.recipe.save());

    // Catalog is stale
    expect(devB.catalog.getDoc().recipes[0]!.title).toBe("Cake");

    // Opening the recipe triggers reconciliation
    const result = reconcileOnOpen(devB.catalog, devB.recipe);
    expect(result).toBe("reconciled");

    // Now catalog matches
    const entry = devB.catalog.getDoc().recipes.find((r) => r.id === RECIPE_ID)!;
    expect(entry.title).toBe("Chocolate Cake");
    expect(entry.tags).toEqual(["dessert"]);

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    devA.db.close(); devB.db.close();
  });
});

describe("Catalog ↔ Recipe doc: remote catalog sync", () => {
  test("remote catalog change alone does NOT update recipe doc (by design)", async () => {
    const devA = await setupDevice({ title: "Pizza" });
    const devB = await addDevice(devA);

    // Device A renames (both stores)
    userEditMeta(devA.catalog, devA.recipe, "Pizza Margherita", ["italian"]);

    // Device B only receives catalog change (recipe doc sync delayed)
    devB.catalog.merge(devA.catalog.save());
    expect(devB.catalog.getDoc().recipes[0]!.title).toBe("Pizza Margherita");

    // Recipe doc still has old title — this is expected
    // (recipe doc change will arrive separately via sync)
    expect(devB.recipe.getDoc().title).toBe("Pizza");

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    devA.db.close(); devB.db.close();
  });

  test("both catalog and recipe doc arriving converges fully", async () => {
    const devA = await setupDevice({ title: "Tacos" });
    const devB = await addDevice(devA);

    // Device A renames
    userEditMeta(devA.catalog, devA.recipe, "Fish Tacos", ["mexican", "seafood"]);

    // Device B receives both (order shouldn't matter)
    devB.catalog.merge(devA.catalog.save());
    devB.recipe.merge(devA.recipe.save());
    syncCatalogFromRecipe(devB.catalog, devB.recipe);

    const entry = devB.catalog.getDoc().recipes.find((r) => r.id === RECIPE_ID)!;
    expect(entry.title).toBe("Fish Tacos");
    expect(entry.tags).toEqual(["mexican", "seafood"]);
    expect(devB.recipe.getDoc().title).toBe("Fish Tacos");
    expect(devB.recipe.getDoc().tags).toEqual(["mexican", "seafood"]);

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    devA.db.close(); devB.db.close();
  });
});

describe("Catalog ↔ Recipe doc: migration (empty doc)", () => {
  test("empty recipe doc is seeded from catalog entry", async () => {
    const key = await genKey();
    const db = await openTestDB();

    // Catalog has a recipe entry but recipe doc is fresh/empty
    const catalog = await openStore<TestCatalog>(db, key, CATALOG_DOC_ID, INIT_CATALOG);
    catalog.change((doc) => {
      doc.recipes.push({ id: RECIPE_ID, title: "From Catalog", tags: ["migrated"] });
    });
    await catalog.waitForWrite();

    const recipe = await openStore<TestRecipe>(db, key, RECIPE_DOC_ID, INIT_RECIPE);
    // Recipe doc is empty (just initialized)
    expect(recipe.getDoc().title).toBe("");

    const result = reconcileOnOpen(catalog, recipe);
    expect(result).toBe("migrated");
    expect(recipe.getDoc().title).toBe("From Catalog");
    expect(recipe.getDoc().tags).toEqual(["migrated"]);

    await catalog.waitForWrite();
    await recipe.waitForWrite();
    db.close();
  });

  test("migration does NOT overwrite existing recipe doc data", async () => {
    const { db, catalog, recipe } = await setupDevice({ title: "Existing" });

    // Even if catalog says something different, recipe doc wins
    catalog.change((doc) => {
      const entry = doc.recipes.find((r) => r.id === RECIPE_ID);
      if (entry) entry.title = "Catalog Override Attempt";
    });

    const result = reconcileOnOpen(catalog, recipe);
    expect(result).toBe("reconciled");
    // Recipe doc is source of truth — catalog was overwritten back
    expect(catalog.getDoc().recipes[0]!.title).toBe("Existing");
    expect(recipe.getDoc().title).toBe("Existing");

    await catalog.waitForWrite();
    await recipe.waitForWrite();
    db.close();
  });
});

describe("Catalog ↔ Recipe doc: concurrent edits", () => {
  test("two devices rename simultaneously — both converge after full sync", async () => {
    const devA = await setupDevice({ title: "Original" });
    const devB = await addDevice(devA);

    // Both devices rename concurrently
    userEditMeta(devA.catalog, devA.recipe, "Name from A", ["a"]);
    userEditMeta(devB.catalog, devB.recipe, "Name from B", ["b"]);

    // Full mesh merge — both catalog and recipe docs
    devA.catalog.merge(devB.catalog.save());
    devA.recipe.merge(devB.recipe.save());
    devB.catalog.merge(devA.catalog.save());
    devB.recipe.merge(devA.recipe.save());

    // CRDT converges — both devices agree (Automerge last-writer-wins on string)
    const titleA = devA.recipe.getDoc().title;
    const titleB = devB.recipe.getDoc().title;
    expect(titleA).toBe(titleB); // converged, regardless of which won

    // Now reconcile catalogs from recipe docs
    syncCatalogFromRecipe(devA.catalog, devA.recipe);
    syncCatalogFromRecipe(devB.catalog, devB.recipe);

    // Catalogs also converge to match recipe docs
    expect(devA.catalog.getDoc().recipes[0]!.title).toBe(titleA);
    expect(devB.catalog.getDoc().recipes[0]!.title).toBe(titleB);

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    devA.db.close(); devB.db.close();
  });

  test("tag edits on different devices merge correctly", async () => {
    const devA = await setupDevice({ title: "Salad", tags: ["healthy"] });
    const devB = await addDevice(devA);

    // Device A adds a tag via recipe doc
    devA.recipe.change((doc) => { doc.tags = ["healthy", "lunch"] as any; });
    // Device B adds a different tag via recipe doc
    devB.recipe.change((doc) => { doc.tags = ["healthy", "summer"] as any; });

    // Merge recipe docs
    devA.recipe.merge(devB.recipe.save());
    devB.recipe.merge(devA.recipe.save());

    // Tags converge (CRDT — exact order depends on Automerge)
    const tagsA = [...devA.recipe.getDoc().tags].sort();
    const tagsB = [...devB.recipe.getDoc().tags].sort();
    expect(tagsA).toEqual(tagsB);

    // Sync catalogs from recipe doc
    syncCatalogFromRecipe(devA.catalog, devA.recipe);
    syncCatalogFromRecipe(devB.catalog, devB.recipe);

    expect([...devA.catalog.getDoc().recipes[0]!.tags].sort()).toEqual(tagsA);
    expect([...devB.catalog.getDoc().recipes[0]!.tags].sort()).toEqual(tagsB);

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    devA.db.close(); devB.db.close();
  });
});

describe("Catalog ↔ Recipe doc: three-device convergence", () => {
  test("three devices with staggered sync all converge", async () => {
    const devA = await setupDevice({ title: "Stew" });
    const devB = await addDevice(devA);
    const dbC = await openTestDB();
    const devC = {
      db: dbC,
      catalog: await AutomergeStore.open<TestCatalog>(dbC, CATALOG_DOC_ID, devA.key, INIT_CATALOG),
      recipe: await AutomergeStore.open<TestRecipe>(dbC, RECIPE_DOC_ID, devA.key, INIT_RECIPE),
    };
    devC.catalog.merge(devA.catalog.save());
    devC.recipe.merge(devA.recipe.save());
    await devC.catalog.waitForWrite();
    await devC.recipe.waitForWrite();

    // Device A renames
    userEditMeta(devA.catalog, devA.recipe, "Beef Stew", ["comfort"]);

    // Only device B gets the update first
    devB.recipe.merge(devA.recipe.save());
    syncCatalogFromRecipe(devB.catalog, devB.recipe);
    expect(devB.catalog.getDoc().recipes[0]!.title).toBe("Beef Stew");

    // Device C is still on old state
    expect(devC.recipe.getDoc().title).toBe("Stew");
    expect(devC.catalog.getDoc().recipes[0]!.title).toBe("Stew");

    // Device C eventually gets the update
    devC.recipe.merge(devA.recipe.save());
    syncCatalogFromRecipe(devC.catalog, devC.recipe);

    // All three converge
    expect(devA.recipe.getDoc().title).toBe("Beef Stew");
    expect(devB.recipe.getDoc().title).toBe("Beef Stew");
    expect(devC.recipe.getDoc().title).toBe("Beef Stew");
    expect(devA.catalog.getDoc().recipes[0]!.title).toBe("Beef Stew");
    expect(devB.catalog.getDoc().recipes[0]!.title).toBe("Beef Stew");
    expect(devC.catalog.getDoc().recipes[0]!.title).toBe("Beef Stew");

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    await devC.catalog.waitForWrite(); await devC.recipe.waitForWrite();
    devA.db.close(); devB.db.close(); devC.db.close();
  });
});

describe("Catalog ↔ Recipe doc: onChange listener integration", () => {
  test("recipe doc onChange fires and enables catalog sync", async () => {
    const devA = await setupDevice({ title: "Curry" });
    const devB = await addDevice(devA);

    // Set up onChange listener on device B's recipe doc (simulates recipe-detail.ts)
    let lastTitle = devB.recipe.getDoc().title;
    const onChangeSync = mock(() => {
      const doc = devB.recipe.getDoc();
      if (doc.title !== lastTitle) {
        lastTitle = doc.title;
        syncCatalogFromRecipe(devB.catalog, devB.recipe);
      }
    });
    devB.recipe.onChange(onChangeSync);

    // Device A renames
    userEditMeta(devA.catalog, devA.recipe, "Thai Green Curry", ["thai", "spicy"]);

    // Device B receives recipe doc change — listener fires automatically
    devB.recipe.merge(devA.recipe.save());

    expect(onChangeSync).toHaveBeenCalled();
    expect(devB.recipe.getDoc().title).toBe("Thai Green Curry");
    expect(devB.catalog.getDoc().recipes[0]!.title).toBe("Thai Green Curry");
    expect(devB.catalog.getDoc().recipes[0]!.tags).toEqual(["thai", "spicy"]);

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    devA.db.close(); devB.db.close();
  });

  test("syncCatalogFromRecipe is idempotent", async () => {
    const { db, catalog, recipe } = await setupDevice({ title: "Pasta" });

    // Already in sync — should be a no-op
    const result1 = syncCatalogFromRecipe(catalog, recipe);
    expect(result1).toBe(false);

    // Change recipe, sync, then sync again
    recipe.change((doc) => { doc.title = "Penne"; });
    const result2 = syncCatalogFromRecipe(catalog, recipe);
    expect(result2).toBe(true);
    const result3 = syncCatalogFromRecipe(catalog, recipe);
    expect(result3).toBe(false); // already synced

    await catalog.waitForWrite();
    await recipe.waitForWrite();
    db.close();
  });
});

describe("Catalog ↔ Recipe doc: edge cases", () => {
  test("recipe doc with title but no catalog entry does not crash", async () => {
    const key = await genKey();
    const db = await openTestDB();

    const catalog = await openStore<TestCatalog>(db, key, CATALOG_DOC_ID, INIT_CATALOG);
    // No recipe entries in catalog
    const recipe = await openStore<TestRecipe>(db, key, RECIPE_DOC_ID, INIT_RECIPE);
    recipe.change((doc) => { doc.title = "Orphan Recipe"; });

    const result = reconcileOnOpen(catalog, recipe);
    expect(result).toBe("no-op"); // no catalog entry to reconcile
    expect(recipe.getDoc().title).toBe("Orphan Recipe");

    const syncResult = syncCatalogFromRecipe(catalog, recipe);
    expect(syncResult).toBe(false); // no entry to update

    await catalog.waitForWrite();
    await recipe.waitForWrite();
    db.close();
  });

  test("empty tags array vs undefined tags are treated as equal", async () => {
    const { db, catalog, recipe } = await setupDevice({ title: "Test", tags: [] });

    // Both have empty tags — should be no-op
    const result = reconcileOnOpen(catalog, recipe);
    expect(result).toBe("no-op");

    await catalog.waitForWrite();
    await recipe.waitForWrite();
    db.close();
  });

  test("rapid renames only sync final state", async () => {
    const devA = await setupDevice({ title: "v1" });
    const devB = await addDevice(devA);

    // Device A does rapid renames
    userEditMeta(devA.catalog, devA.recipe, "v2", []);
    userEditMeta(devA.catalog, devA.recipe, "v3", []);
    userEditMeta(devA.catalog, devA.recipe, "v4", []);
    userEditMeta(devA.catalog, devA.recipe, "v5 Final", ["done"]);

    // Device B merges the final state
    devB.recipe.merge(devA.recipe.save());
    syncCatalogFromRecipe(devB.catalog, devB.recipe);

    expect(devB.recipe.getDoc().title).toBe("v5 Final");
    expect(devB.catalog.getDoc().recipes[0]!.title).toBe("v5 Final");

    await devA.catalog.waitForWrite(); await devA.recipe.waitForWrite();
    await devB.catalog.waitForWrite(); await devB.recipe.waitForWrite();
    devA.db.close(); devB.db.close();
  });
});
