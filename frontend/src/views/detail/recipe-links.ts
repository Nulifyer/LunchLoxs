import type { Recipe } from "../../types";
import type { RecipePreview } from "../../components/recipe-preview";
import type { RecipeEntry } from "../../lib/cm-recipe-completions";
import type { BookCatalog, CatalogEntry } from "../../types";
import { escapeHtml, escapeAttr } from "../../lib/html";
import { parseQty, formatQty, scaleQty } from "../../lib/quantity";
import { convertIngredient, convertToUnit, resolveUnit, isDecimalUnit } from "../../lib/units";
import { findDensity, convertViaDensity } from "../../lib/densities";
import { getActiveBook, getDocMgr } from "../../state";
import { catalogDocId } from "../../sync/push";
import {
  getStore, getScaleFactor, getUnitSystem, getUnitOverrides,
  getPushSnapshotFn,
} from "./state";

const linkedRecipesSection = document.getElementById("linked-recipes-section") as HTMLElement;
const linkedRecipesList = document.getElementById("linked-recipes-list") as HTMLElement;

/** Get catalog recipe entries for recipe link autocomplete. */
export function getCatalogRecipes(): RecipeEntry[] {
  const docMgr = getDocMgr();
  if (!docMgr) return [];
  const catalog = docMgr.get<BookCatalog>(catalogDocId());
  if (!catalog) return [];
  const entries = catalog.getDoc()?.recipes ?? [];
  return entries.map((e: CatalogEntry) => ({ id: e.id, title: e.title }));
}

/** Collected linked recipe IDs from the last render pass. */
export let lastLinkedRecipeIds: string[] = [];

export function setLastLinkedRecipeIds(ids: string[]) {
  lastLinkedRecipeIds = ids;
}

/** Active linked recipe preview elements (for broadcasting state changes). */
let activeLinkedPreviews: RecipePreview[] = [];

export function getActiveLinkedPreviews() { return activeLinkedPreviews; }

/** Broadcast current scale/unit state to all linked recipe previews. */
export function updateLinkedPreviewState() {
  for (const p of activeLinkedPreviews) {
    p.scaleFactor = getScaleFactor();
    p.unitSystem = getUnitSystem();
  }
}

/** Generation counter to prevent stale async renders from appending. */
let linkedRecipesGeneration = 0;

export function bumpLinkedRecipesGeneration() {
  return ++linkedRecipesGeneration;
}

export function getLinkedRecipesGeneration() { return linkedRecipesGeneration; }

/** Cleanup functions for linked recipe onChange subscriptions. */
let linkedRecipeCleanups: Array<() => void> = [];

export function cleanupLinkedRecipes() {
  for (const fn of linkedRecipeCleanups) fn();
  linkedRecipeCleanups = [];
  activeLinkedPreviews = [];
}

const INIT_LINKED_RECIPE = (doc: Recipe) => {
  doc.title = ""; doc.tags = []; doc.servings = 4; doc.prepMinutes = 0; doc.cookMinutes = 0;
  doc.createdAt = Date.now(); doc.updatedAt = Date.now();
  doc.description = ""; doc.ingredients = []; doc.instructions = ""; doc.imageUrls = []; doc.notes = "";
};

/** Resolve `@[name]` ingredient references in markdown source before rendering. */
export function resolveIngredientRefs(md: string, doc: Recipe): string {
  const ingredients = doc.ingredients ?? [];
  const scaleFactor = getScaleFactor();
  const unitSystem = getUnitSystem();
  const unitOverrides = getUnitOverrides();
  return md.replace(/@\[([^\]]+)\]/g, (_match, name: string) => {
    const ing = ingredients.find((i) => i.item.toLowerCase() === name.toLowerCase());
    if (!ing) {
      return `<span class="ing-ref ing-ref-broken">${escapeHtml(name)}</span>`;
    }
    const scaledRaw = scaleQty(ing.quantity, scaleFactor);
    const scaledNum = parseQty(scaledRaw);
    let displayQty = escapeHtml(scaledRaw);
    let displayUnit = escapeHtml(ing.unit);
    if (scaledNum !== null) {
      const idx = ingredients.indexOf(ing);
      const overrideUnit = unitOverrides.get(idx);
      let result: { qty: number; unit: string } | null = null;
      if (overrideUnit?.startsWith("~")) {
        const targetUnit = overrideUnit.slice(1);
        const ud = resolveUnit(ing.unit);
        const den = findDensity(ing.item);
        if (ud && den) result = convertViaDensity(scaledNum, ud.toBase, ud.dimension, targetUnit, den);
      } else if (overrideUnit) {
        result = convertToUnit(scaledNum, ing.unit, overrideUnit);
      } else if (unitSystem !== "original") {
        const sys = convertIngredient(scaledNum, ing.unit, unitSystem);
        if (sys.unit !== ing.unit) result = sys;
      }
      if (result) {
        displayQty = escapeHtml(formatQty(result.qty, isDecimalUnit(result.unit)));
        displayUnit = escapeHtml(result.unit);
      }
    }
    const parts = [displayQty, displayUnit, escapeHtml(ing.item)].filter(Boolean);
    return `<span class="ing-ref">${parts.join(" ")}</span>`;
  });
}

/**
 * Update stale recipe link display names in instructions/notes.
 * Matches `#[Old Name](vaultId/recipeId)` and replaces with the current
 * catalog title for that recipe, preserving the stable ID.
 */
export function reconcileRecipeLinkNames() {
  const store = getStore();
  if (!store) return;
  const recipes = getCatalogRecipes();
  if (recipes.length === 0) return;

  const pattern = /#\[([^\]]+)\]\(([^)]+)\)/g;

  function updateField(text: string): string | null {
    let changed = false;
    const updated = text.replace(pattern, (match, name: string, docId: string) => {
      const parts = docId.split("/");
      const recipeId = parts.length > 1 ? parts[1]! : parts[0]!;
      const entry = recipes.find((r) => r.id === recipeId);
      if (entry && entry.title !== name) {
        changed = true;
        return `#[${entry.title}](${docId})`;
      }
      return match;
    });
    return changed ? updated : null;
  }

  const doc = store.getDoc();
  const newInstructions = updateField(doc.instructions ?? "");
  const newNotes = updateField(doc.notes ?? "");

  if (newInstructions !== null || newNotes !== null) {
    store.change((d) => {
      if (newInstructions !== null) d.instructions = newInstructions;
      if (newNotes !== null) d.notes = newNotes;
    });
    getPushSnapshotFn()?.();
  }
}

/** Resolve `#[name](vaultId/recipeId)` recipe references in markdown source before rendering. */
export function resolveRecipeRefs(md: string, linkedIds: Set<string>): string {
  return md.replace(/#\[([^\]]+)\]\(([^)]+)\)/g, (_match, name: string, docId: string) => {
    linkedIds.add(docId);
    // Check if the recipe exists in the catalog
    const recipes = getCatalogRecipes();
    const parts = docId.split("/");
    const recipeId = (parts.length > 1 ? parts[1]! : parts[0]!);
    const entry = recipes.find((r) => r.id === recipeId);
    if (!entry) {
      return `<span class="recipe-ref recipe-ref-broken">${escapeHtml(name)}</span>`;
    }
    return `<span class="recipe-ref" data-recipe-id="${escapeAttr(recipeId)}" data-doc-id="${escapeAttr(docId)}">${escapeHtml(entry.title)}</span>`;
  });
}

/** Render the expandable linked recipes section at the bottom of the detail view. */
export function renderLinkedRecipes(docIds: string[], callbacks: { onNavigateToRecipe?: (recipeId: string) => void }) {
  const gen = bumpLinkedRecipesGeneration();
  cleanupLinkedRecipes();

  if (docIds.length === 0) {
    linkedRecipesSection.hidden = true;
    linkedRecipesList.innerHTML = "";
    return;
  }

  linkedRecipesSection.hidden = false;
  linkedRecipesList.innerHTML = "";
  const docMgr = getDocMgr();
  const activeBook = getActiveBook();
  if (!docMgr || !activeBook) return;

  const catalogEntries = getCatalogRecipes();

  for (const docId of docIds) {
    const parts = docId.split("/");
    const recipeId = (parts.length > 1 ? parts[1]! : parts[0]!);
    const fullDocId = parts.length > 1 ? docId : `${activeBook.vaultId}/${recipeId}`;
    const catalogEntry = catalogEntries.find((e) => e.id === recipeId);
    if (!catalogEntry) continue; // deleted recipe — skip card, inline ref shows as broken
    const displayTitle = catalogEntry.title;

    const card = document.createElement("details");
    card.className = "linked-recipe-card";

    const summary = document.createElement("summary");
    summary.innerHTML = `${escapeHtml(displayTitle)}<span class="linked-recipe-open">Open</span>`;
    card.appendChild(summary);

    const previewWrap = document.createElement("div");
    previewWrap.className = "linked-recipe-preview";
    previewWrap.innerHTML = `<div class="detail-skeleton linked-recipe-skeleton">
      <div class="skel-meta"><span class="skel-bar" style="width:140px"></span></div>
      <div class="skel-section-header"><span class="skel-bar" style="width:90px"></span></div>
      <div class="skel-ingredients">
        <span class="skel-bar skel-line"></span>
        <span class="skel-bar skel-line" style="width:75%"></span>
        <span class="skel-bar skel-line" style="width:60%"></span>
      </div>
      <div class="skel-section-header"><span class="skel-bar" style="width:100px"></span></div>
      <div class="skel-instructions">
        <span class="skel-bar skel-line"></span>
        <span class="skel-bar skel-line" style="width:85%"></span>
        <span class="skel-bar skel-line" style="width:70%"></span>
      </div>
    </div>`;
    card.appendChild(previewWrap);

    // Click "Open" to navigate
    const navId = recipeId;
    summary.querySelector(".linked-recipe-open")!.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      callbacks.onNavigateToRecipe?.(navId);
    });

    // Lazy load: open doc and subscribe only when expanded
    let loaded = false;
    let unsub: (() => void) | null = null;
    card.addEventListener("toggle", async () => {
      if (!card.open || loaded) return;
      loaded = true;
      if (gen !== linkedRecipesGeneration) return;

      try {
        const recipeStore = await docMgr.open<Recipe>(fullDocId, INIT_LINKED_RECIPE);
        if (gen !== linkedRecipesGeneration) return;

        previewWrap.innerHTML = ""; // remove skeleton
        const preview = document.createElement("recipe-preview") as RecipePreview;
        previewWrap.appendChild(preview);

        // Set initial state from parent, then render
        preview.scaleFactor = getScaleFactor();
        preview.unitSystem = getUnitSystem();
        preview.setRecipe(recipeStore.getDoc());
        activeLinkedPreviews.push(preview);

        // Live updates: re-render when linked recipe changes
        unsub = recipeStore.onChange(() => {
          if (gen !== linkedRecipesGeneration) { unsub?.(); return; }
          preview.setRecipe(recipeStore.getDoc());
        });
      } catch {
        previewWrap.innerHTML = `<em style="color:var(--muted)">Failed to load recipe.</em>`;
      }
    });

    // Track cleanup
    linkedRecipeCleanups.push(() => { unsub?.(); });

    linkedRecipesList.appendChild(card);
  }

  // Hide section if no cards were added (all linked recipes deleted)
  if (linkedRecipesList.children.length === 0) {
    linkedRecipesSection.hidden = true;
  }
}
