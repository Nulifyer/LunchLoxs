/**
 * Recipe detail view with unified edit/preview mode.
 */

import type { Recipe } from "../types";
import type { TagInput } from "../components/tag-input";
import { AutomergeStore } from "../lib/automerge-store";
import { createAutomergeMirror } from "../lib/codemirror-automerge";
import { remoteCursorsExtension, updateRemoteCursors } from "../lib/remote-cursors";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { appTheme, appSyntaxHighlighting } from "../lib/cm-theme";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { createDropdown, type DropdownItem } from "../lib/dropdown";
import { parseQty, formatQty, scaleQty } from "../lib/quantity";
import { convertToUnit, resolveUnit, getConversionTargets, isDecimalUnit, canonicalUnitName } from "../lib/units";
import { findDensity, convertViaDensity, WEIGHT_UNITS, VOLUME_UNITS } from "../lib/densities";
import { autocompletion, completionKeymap, acceptCompletion } from "@codemirror/autocomplete";
import { ingredientCompletionSource } from "../lib/cm-ingredient-completions";
import { recipeCompletionSource } from "../lib/cm-recipe-completions";
import { imagePreviewExtension } from "../lib/cm-image-preview";
import { revokeObjectUrls, loadBlobUrl } from "../lib/blob-client";
import { getActiveBook, getDocMgr } from "../state";
import {
  getStore, setStore, getInstrEditorView, setInstrEditorView, getInstrBridge, setInstrBridge,
  getNotesEditorView, setNotesEditorView, getNotesBridge, setNotesBridge,
  isPageEditing, setPageEditing as setPageEditingState, getCanEdit, setCanEdit,
  getScaleFactor, setScaleFactor, getBaseServings, setBaseServings,
  getCurrentServings, setCurrentServings, getUnitSystem, setUnitSystem,
  getUnitOverrides, getCheckedIngredients,
  getPushSnapshotFn, setPushSnapshotFn, getSendPresenceFn, setSendPresenceFn,
  getCurrentRecipeId, setCurrentRecipeId,
} from "./detail/state";
import {
  handlePresence as _handlePresence, queuePresence, sendPresenceNow,
  getInstrCursors, getNotesCursors, clearCursorState,
  getPresenceFallbackTimer, clearPresenceFallbackTimer,
} from "./detail/presence";
import {
  renderIngredients, updateScaleDisplay, commitGhostRow,
  cycleUnitSystem, UNIT_LABELS,
  setIngredientSuggestions as _setIngredientSuggestions,
} from "./detail/ingredients";
import { assetDomHandlers } from "./detail/asset-handling";
import {
  resolveIngredientRefs, resolveRecipeRefs, reconcileRecipeLinkNames,
  renderLinkedRecipes, updateLinkedPreviewState, cleanupLinkedRecipes,
  getCatalogRecipes, getActiveLinkedPreviews, setLastLinkedRecipeIds,
  bumpLinkedRecipesGeneration,
} from "./detail/recipe-links";
import { extractImageWidths, applyImageWidths, resolveBlobAssets } from "./detail/asset-handling";
import { renderMetaDisplay } from "./detail/meta";

export { _setIngredientSuggestions as setIngredientSuggestions };

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Allow blob: URIs so markdown images like ![alt](blob:checksum) survive sanitization.
// The blob: prefix is later resolved to a decrypted object URL by resolveBlobAssets().
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "src" || data.attrName === "href") {
    if (data.attrValue.startsWith("blob:")) {
      data.forceKeepAttr = true;
    }
  }
});

// -- DOM refs --
const detailView = document.getElementById("recipe-detail") as HTMLElement;
const skeleton = document.getElementById("recipe-detail-skeleton") as HTMLElement;
const emptyState = document.getElementById("empty-state") as HTMLElement;
const backBtn = document.getElementById("back-btn") as HTMLButtonElement;
const titleEl = document.getElementById("recipe-title") as HTMLHeadingElement;
const titleInput = document.getElementById("recipe-title-input") as HTMLInputElement;
const metaEl = document.getElementById("recipe-meta") as HTMLElement;
const metaEditEl = document.getElementById("recipe-meta-edit") as HTMLElement;
const metaServingsInput = document.getElementById("meta-servings") as HTMLInputElement;
const metaPrepInput = document.getElementById("meta-prep") as HTMLInputElement;
const metaCookInput = document.getElementById("meta-cook") as HTMLInputElement;
const metaTagInput = document.getElementById("meta-tags") as TagInput;
const pageEditBtn = document.getElementById("page-edit-btn") as HTMLButtonElement;
const actionsSlot = document.getElementById("recipe-actions-slot") as HTMLElement;

const ingredientsList = document.getElementById("ingredients-list") as HTMLElement;
const scaleBar = document.getElementById("ingredient-scale-bar") as HTMLElement;

const instrEditorContainer = document.getElementById("editor-container") as HTMLElement;
const instrPreviewContainer = document.getElementById("preview-container") as HTMLElement;
const notesEditorContainer = document.getElementById("notes-editor-container") as HTMLElement;
const notesPreviewContainer = document.getElementById("notes-preview-container") as HTMLElement;
const linkedRecipesSection = document.getElementById("linked-recipes-section") as HTMLElement;
const linkedRecipesList = document.getElementById("linked-recipes-list") as HTMLElement;

const unitToggleBtn = document.getElementById("unit-toggle-btn") as HTMLButtonElement;

let allTagSuggestions: string[] = [];
let lastSyncedTitle = "";
let lastSyncedTags: string[] = [];

let metaDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const META_DEBOUNCE_MS = 400;

export interface DetailCallbacks {
  onBack: () => void;
  /** Called after content edits (instructions, ingredients, notes). Sets updatedAt + pushes recipe doc. */
  onContentChanged: () => void;
  onSendPresence: (data: any) => void;
  /** Mirror title + tags to the catalog for sidebar display, and push both docs. */
  onMetaChanged: (title: string, tags: string[]) => void;
  onDeleteRecipe: () => void;
  /** Sync title + tags from recipe doc to catalog (e.g. after remote change). Does NOT push the recipe doc. */
  onSyncCatalogMeta?: (title: string, tags: string[]) => void;
  onExportRecipe?: () => void;
  onCopyToBook?: () => void;
  onNavigateToRecipe?: (recipeId: string) => void;
}

let callbacks: DetailCallbacks;

function debounceMeta() {
  if (!isPageEditing() || !getStore()) return;
  if (metaDebounceTimer) clearTimeout(metaDebounceTimer);
  metaDebounceTimer = setTimeout(flushMeta, META_DEBOUNCE_MS);
}

function flushMeta() {
  if (metaDebounceTimer) { clearTimeout(metaDebounceTimer); metaDebounceTimer = null; }
  const store = getStore();
  if (!store) return;
  const doc = store.getDoc();
  const title = titleInput.value.trim() || doc.title;
  const tags = metaTagInput.value;
  const servings = parseInt(metaServingsInput.value) || 4;
  const prepMinutes = parseInt(metaPrepInput.value) || 0;
  const cookMinutes = parseInt(metaCookInput.value) || 0;
  store.change((d) => {
    d.title = title; d.tags = tags as any; d.servings = servings;
    d.prepMinutes = prepMinutes; d.cookMinutes = cookMinutes;
    d.updatedAt = Date.now();
  });
  callbacks.onMetaChanged(title, tags);
}

export function initRecipeDetail(cb: DetailCallbacks) {
  callbacks = cb;
  backBtn.addEventListener("click", cb.onBack);
  setPushSnapshotFn(cb.onContentChanged);
  setSendPresenceFn(cb.onSendPresence);

  pageEditBtn.addEventListener("click", () => setPageEditing(!isPageEditing()));

  titleInput.addEventListener("input", debounceMeta);
  metaServingsInput.addEventListener("input", debounceMeta);
  metaPrepInput.addEventListener("input", debounceMeta);
  metaCookInput.addEventListener("input", debounceMeta);
  metaTagInput.addEventListener("change", debounceMeta);

  instrPreviewContainer.addEventListener("click", () => {
    if (isPageEditing()) getInstrEditorView()?.focus();
  });
  notesPreviewContainer.addEventListener("click", () => {
    if (isPageEditing()) getNotesEditorView()?.focus();
  });

  // -- Ingredient event delegation --

  ingredientsList.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const store = getStore();

    // Delete button
    const deleteBtn = target.closest("[data-delete-ing]") as HTMLElement;
    if (deleteBtn && store) {
      const idx = parseInt(deleteBtn.dataset.deleteIng!);
      store.change((doc) => {
        if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
          doc.ingredients.splice(idx, 1);
        }
      });
      getPushSnapshotFn()?.();
      return;
    }

    // Check-off toggle (view mode)
    const check = target.closest(".ing-check") as HTMLElement;
    if (check) {
      const li = check.closest("li") as HTMLElement;
      const idx = parseInt(li.dataset.ingIdx ?? "-1");
      if (idx < 0) return;
      const checkedIngredients = getCheckedIngredients();
      if (checkedIngredients.has(idx)) checkedIngredients.delete(idx);
      else checkedIngredients.add(idx);
      li.classList.toggle("ing-checked", checkedIngredients.has(idx));
      return;
    }

    // Unit conversion picker (click on unit span in view mode)
    const unitSpan = target.closest(".ing-unit") as HTMLElement;
    if (unitSpan && !isPageEditing()) {
      e.stopPropagation(); // prevent document click listener from immediately closing the picker
      const rect = unitSpan.getBoundingClientRect();
      showUnitPicker(unitSpan, rect.left, rect.bottom + 4);
      return;
    }
  });

  // -- Per-ingredient unit picker --

  function showUnitPicker(unitSpan: HTMLElement, x: number, y: number) {
    const li = unitSpan.closest("li") as HTMLElement;
    const idx = parseInt(li.dataset.ingIdx ?? "-1");
    if (idx < 0) return;
    const rawUnit = li.dataset.origUnit;
    if (!rawUnit || !resolveUnit(rawUnit)) return;

    const targets = getConversionTargets(rawUnit);
    if (targets.length === 0) return;

    // Close any existing picker
    closeUnitPicker();

    const store = getStore();
    const unitOverrides = getUnitOverrides();
    const scaleFactor = getScaleFactor();
    const unitSystem = getUnitSystem();

    const menu = document.createElement("div");
    menu.className = "dropdown-menu unit-picker";
    menu.setAttribute("role", "menu");

    // "Original" reset option
    const origBtn = document.createElement("button");
    origBtn.className = "dropdown-item" + (!unitOverrides.has(idx) && unitSystem === "original" ? " unit-active" : "");
    origBtn.textContent = rawUnit + " (original)";
    origBtn.setAttribute("role", "menuitem");
    origBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      unitOverrides.delete(idx);
      closeUnitPicker();
      if (store) renderIngredients(store.getDoc());
    });
    menu.appendChild(origBtn);

    const sep = document.createElement("div");
    sep.className = "dropdown-sep";
    menu.appendChild(sep);

    // Scaled quantity for preview
    const doc = store?.getDoc();
    const ing = doc?.ingredients?.[idx];
    const rawQty = ing?.quantity ?? "";
    const itemName = ing?.item ?? "";
    const scaledNum = parseQty(scaleQty(rawQty, scaleFactor));

    // Build conversion entries grouped by: metric, imperial, density-based
    type PickerEntry = { qty: number; label: string; overrideKey: string; group: "metric" | "imperial" | "density" };
    const entries: PickerEntry[] = [];

    // Same-dimension conversions
    for (const t of targets) {
      const converted = scaledNum !== null ? convertToUnit(scaledNum, rawUnit, t.unit) : null;
      if (!converted || converted.qty < 0.1 || converted.qty > 999) continue;
      entries.push({ qty: converted.qty, label: `${formatQty(converted.qty, isDecimalUnit(t.unit))} ${t.label}`, overrideKey: t.unit, group: t.system });
    }

    // Density-based cross-dimension conversions (volume <-> weight)
    const unitDef = resolveUnit(rawUnit);
    const density = findDensity(itemName);
    if (density && unitDef && scaledNum !== null) {
      const targetUnits = unitDef.dimension === "volume" ? WEIGHT_UNITS : VOLUME_UNITS;
      for (const [unit] of targetUnits) {
        const result = convertViaDensity(scaledNum, unitDef.toBase, unitDef.dimension, unit, density);
        if (!result || result.qty < 0.1 || result.qty > 999) continue;
        entries.push({ qty: result.qty, label: `~${formatQty(result.qty, true)} ${unit}`, overrideKey: `~${unit}`, group: "density" });
      }
    }

    // Sort within each group by closeness to original quantity
    const refQty = scaledNum ?? 1;
    const byCloseness = (a: PickerEntry, b: PickerEntry) =>
      Math.abs(Math.log(a.qty / refQty)) - Math.abs(Math.log(b.qty / refQty));

    // Determine which system to show first (opposite of source unit's system)
    const sourceSystem = unitDef?.system;
    const groupOrder: ("metric" | "imperial" | "density")[] =
      sourceSystem === "metric" ? ["imperial", "metric", "density"] : ["metric", "imperial", "density"];
    const GROUP_LABELS: Record<string, string> = { metric: "Metric", imperial: "Imperial", density: "By weight" };
    // If source is a weight unit, density section is volume
    if (unitDef?.dimension === "weight") GROUP_LABELS.density = "By volume";

    for (const group of groupOrder) {
      const groupEntries = entries.filter(e => e.group === group).sort(byCloseness);
      if (groupEntries.length === 0) continue;

      const groupSep = document.createElement("div");
      groupSep.className = "dropdown-sep";
      menu.appendChild(groupSep);
      const groupLabel = document.createElement("div");
      groupLabel.className = "dropdown-group-label";
      groupLabel.textContent = GROUP_LABELS[group] ?? group;
      menu.appendChild(groupLabel);

      for (const entry of groupEntries) {
        const btn = document.createElement("button");
        btn.className = "dropdown-item" + (unitOverrides.get(idx) === entry.overrideKey ? " unit-active" : "");
        btn.textContent = entry.label;
        btn.setAttribute("role", "menuitem");
        const key = entry.overrideKey;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          unitOverrides.set(idx, key);
          closeUnitPicker();
          if (store) renderIngredients(store.getDoc());
        });
        menu.appendChild(btn);
      }
    }

    document.body.appendChild(menu);
    menu.style.position = "fixed";
    menu.style.zIndex = "300";

    // Position: try to keep on screen
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;

    activeUnitPicker = menu;

    requestAnimationFrame(() => {
      const first = menu.querySelector(".dropdown-item") as HTMLButtonElement;
      first?.focus();
    });
  }

  let activeUnitPicker: HTMLElement | null = null;

  function closeUnitPicker() {
    if (activeUnitPicker) { activeUnitPicker.remove(); activeUnitPicker = null; }
  }

  document.addEventListener("click", (e) => {
    if (activeUnitPicker && !activeUnitPicker.contains(e.target as Node)) closeUnitPicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeUnitPicker) closeUnitPicker();
  });

  ingredientsList.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    const rawField = target.dataset.ingField;
    const store = getStore();
    if (!rawField || rawField === "optional" || !store) return;
    const field = rawField as "quantity" | "unit" | "item";

    // Read value from either a plain input or an autocomplete-input
    const value = (target as any).value as string;

    // Clamp quantity: strip negative sign so amount can't go below 0
    if (field === "quantity") {
      const input = target as HTMLInputElement;
      const stripped = input.value.replace(/-/g, "");
      if (stripped !== input.value) {
        const pos = input.selectionStart ?? 0;
        input.value = stripped;
        input.setSelectionRange(Math.max(0, pos - 1), Math.max(0, pos - 1));
      }
    }

    // Ghost row input -- don't persist to store
    if (target.dataset.ghost) return;

    const idx = parseInt(target.dataset.ingIdx ?? "-1");
    if (idx < 0) return;

    // Auto-rename ingredient references in instructions/notes
    if (field === "item") {
      const oldName = store.getDoc().ingredients?.[idx]?.item ?? "";
      if (oldName && value && oldName.toLowerCase() !== value.toLowerCase()) {
        const pattern = new RegExp(`@\\[${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "gi");
        store.change((doc) => {
          if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
            doc.ingredients[idx]![field] = value;
          }
          if (doc.instructions) doc.instructions = doc.instructions.replace(pattern, `@[${value}]`);
          if (doc.notes) doc.notes = doc.notes.replace(pattern, `@[${value}]`);
        });
        getInstrBridge()?.applyRemoteText();
        getNotesBridge()?.applyRemoteText();
        getPushSnapshotFn()?.();
        return;
      }
    }

    store.change((doc) => {
      if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
        doc.ingredients[idx]![field] = value;
      }
    });
    getPushSnapshotFn()?.();
  });

  // Optional checkbox toggle
  ingredientsList.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.ingField !== "optional") return;
    if (target.dataset.ghost) return;
    const store = getStore();
    if (!store) return;
    const idx = parseInt(target.dataset.ingIdx ?? "-1");
    if (idx < 0) return;
    store.change((doc) => {
      if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
        doc.ingredients[idx]!.optional = target.checked;
      }
    });
    getPushSnapshotFn()?.();
  });

  // Ghost row: commit on Enter (only listen on non-autocomplete inputs;
  // autocomplete-input handles Enter internally and only lets it through
  // when no dropdown option is active)
  ingredientsList.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (!target.dataset.ghost || e.key !== "Enter") return;
    e.preventDefault();
    commitGhostRow();
  });

  // Blur: normalize unit abbreviations + commit ghost row
  ingredientsList.addEventListener("focusout", (e) => {
    const target = e.target as HTMLElement;
    if (!target.dataset.ingField) return;

    // Auto-abbreviate unit names on blur (teaspoon -> tsp, etc.)
    if (target.dataset.ingField === "unit") {
      const input = target as HTMLInputElement;
      if (input.value.trim()) {
        const canonical = canonicalUnitName(input.value);
        if (canonical && canonical !== input.value.trim()) {
          input.value = canonical;
          // Persist normalized value
          const store = getStore();
          if (!input.dataset.ghost && store) {
            const idx = parseInt(input.dataset.ingIdx ?? "-1");
            if (idx >= 0) {
              store.change((doc) => {
                if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
                  doc.ingredients[idx]!.unit = canonical;
                }
              });
              getPushSnapshotFn()?.();
            }
          }
        }
      }
    }

    // Ghost row: commit on blur of item field
    if (target.dataset.ghost && target.dataset.ingField === "item") {
      setTimeout(() => {
        const ghostLi = ingredientsList.querySelector(".ing-ghost");
        if (ghostLi && !ghostLi.contains(document.activeElement)) {
          commitGhostRow();
        }
      }, 50);
    }
  });

  // -- Pointer-based drag-to-reorder (works for mouse + touch) --

  let dragIdx: number | null = null;
  let dragClone: HTMLElement | null = null;
  let dropIdx: number | null = null;
  let dragPointerId: number | null = null;

  // Drop indicator line
  const dropLine = document.createElement("div");
  dropLine.className = "ing-drop-line";

  function clearDragState() {
    if (dragClone) { dragClone.remove(); dragClone = null; }
    dropLine.remove();
    ingredientsList.querySelectorAll(".ing-dragging").forEach((el) => el.classList.remove("ing-dragging"));
    dragIdx = null;
    dropIdx = null;
    dragPointerId = null;
  }

  ingredientsList.addEventListener("pointerdown", (e) => {
    const handle = (e.target as HTMLElement).closest(".ing-drag-handle") as HTMLElement;
    if (!handle) return;
    const li = handle.closest("li[data-ing-idx]") as HTMLElement;
    if (!li) return;
    e.preventDefault();
    dragIdx = parseInt(li.dataset.ingIdx!);
    dragPointerId = e.pointerId;
    li.classList.add("ing-dragging");
    li.setPointerCapture(e.pointerId);
    // Floating clone
    dragClone = li.cloneNode(true) as HTMLElement;
    dragClone.classList.remove("ing-dragging");
    dragClone.style.cssText = `position:fixed;pointer-events:none;opacity:0.75;z-index:999;width:${li.offsetWidth}px;margin:0;`;
    document.body.appendChild(dragClone);
    dragClone.style.left = e.clientX - 20 + "px";
    dragClone.style.top = e.clientY - 15 + "px";
  });

  ingredientsList.addEventListener("pointermove", (e) => {
    if (dragIdx === null || !dragClone || e.pointerId !== dragPointerId) return;
    dragClone.style.left = e.clientX - 20 + "px";
    dragClone.style.top = e.clientY - 15 + "px";
    // Find insertion point between rows
    const items = Array.from(ingredientsList.querySelectorAll("li[data-ing-idx]")) as HTMLElement[];
    dropLine.remove();
    dropIdx = null;
    for (const item of items) {
      const idx = parseInt(item.dataset.ingIdx!);
      if (idx === dragIdx) continue;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        // Insert before this item
        dropIdx = idx;
        item.before(dropLine);
        return;
      }
    }
    // Past the last item -- insert at end
    const lastItem = items[items.length - 1];
    if (lastItem) {
      dropIdx = parseInt(lastItem.dataset.ingIdx!) + 1;
      lastItem.after(dropLine);
    }
  });

  ingredientsList.addEventListener("pointerup", (e) => {
    if (dragIdx === null || e.pointerId !== dragPointerId) return;
    const from = dragIdx;
    let to = dropIdx;
    clearDragState();
    const store = getStore();
    if (to === null || !store) return;
    // Adjust target index since removing the source shifts indices
    if (to > from) to--;
    if (to === from) return;
    store.change((doc) => {
      if (!doc.ingredients) return;
      const src = doc.ingredients[from];
      if (!src) return;
      // Copy values -- Automerge can't reinsert a spliced-out reference
      const copy = { item: src.item, quantity: src.quantity, unit: src.unit };
      doc.ingredients.splice(from, 1);
      doc.ingredients.splice(to!, 0, copy);
    });
    getPushSnapshotFn()?.();
  });

  ingredientsList.addEventListener("pointercancel", () => clearDragState());

  // -- Scale bar --

  scaleBar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-scale]") as HTMLElement;
    if (!btn) return;
    const action = btn.dataset.scale;
    let cs = getCurrentServings();
    const bs = getBaseServings();
    if (action === "increase") cs++;
    else if (action === "decrease" && cs > 1) cs--;
    else if (action === "double") cs *= 2;
    else if (action === "triple") cs *= 3;
    else if (action === "quadruple") cs *= 4;
    else if (action === "half" && cs > 1) cs = Math.max(1, Math.round(cs / 2));
    else if (action === "reset") {
      cs = bs;
      getCheckedIngredients().clear();
      getUnitOverrides().clear();
      setUnitSystem("original");
      unitToggleBtn.textContent = UNIT_LABELS["original"];
      unitToggleBtn.dataset.unitSystem = "original";
    }
    setCurrentServings(cs);
    setScaleFactor(cs / bs);
    updateScaleDisplay();
    const store = getStore();
    if (store) renderIngredients(store.getDoc());
    updateLinkedPreviewState();
    if (action === "reset") {
      for (const p of getActiveLinkedPreviews()) p.resetState();
    }
  });

  // -- Unit system toggle --
  unitToggleBtn.textContent = UNIT_LABELS[getUnitSystem()];
  unitToggleBtn.dataset.unitSystem = getUnitSystem();
  unitToggleBtn.addEventListener("click", () => {
    const newSystem = cycleUnitSystem(getUnitSystem());
    setUnitSystem(newSystem);
    unitToggleBtn.textContent = UNIT_LABELS[newSystem];
    unitToggleBtn.dataset.unitSystem = newSystem;
    getUnitOverrides().clear();
    const store = getStore();
    if (store) renderIngredients(store.getDoc());
    updateLinkedPreviewState();
  });
}

export function openRecipe(recipeStore: AutomergeStore<Recipe>, recipeId: string, editable = true, bookName?: string, tagSuggestions: string[] = []) {
  closeRecipe();
  setStore(recipeStore);
  setCurrentRecipeId(recipeId);
  allTagSuggestions = tagSuggestions;
  _setIngredientSuggestions([]);
  const store = getStore()!;
  const meta = store.getDoc();
  lastSyncedTitle = meta.title ?? "";
  lastSyncedTags = [...(meta.tags ?? [])];
  // Reset ingredient UI state
  getCheckedIngredients().clear();
  getUnitOverrides().clear();
  setBaseServings(meta.servings || 4);
  setCurrentServings(getBaseServings());
  setScaleFactor(1);
  titleEl.textContent = meta.title;
  // Update breadcrumb
  const breadcrumbBookName = document.getElementById("breadcrumb-book-name") as HTMLElement;
  if (breadcrumbBookName) breadcrumbBookName.textContent = bookName ?? "";
  renderMetaDisplay();
  setCanEdit(editable);
  emptyState.hidden = true;
  detailView.hidden = false;
  skeleton.hidden = true;
  // Edit button for viewers is hidden
  pageEditBtn.hidden = !getCanEdit();

  // Build actions dropdown
  actionsSlot.innerHTML = "";
  const menuItems: DropdownItem[] = [];
  if (callbacks.onExportRecipe) {
    menuItems.push({ label: "Export as .md", action: () => callbacks.onExportRecipe!() });
  }
  if (callbacks.onCopyToBook && getCanEdit()) {
    menuItems.push({ label: "Copy to Book...", action: () => callbacks.onCopyToBook!() });
  }
  if (getCanEdit()) {
    if (menuItems.length > 0) menuItems.push({ separator: true });
    menuItems.push({ label: "Delete", action: () => callbacks.onDeleteRecipe(), danger: true });
  }
  if (menuItems.length > 0) {
    actionsSlot.appendChild(createDropdown(menuItems));
  }

  const doc = store.getDoc();

  // Reconcile stale recipe link names: update #[Old Name](docId) to use current catalog titles
  reconcileRecipeLinkNames();

  // Shared blob resolver for CM image preview widgets
  const blobResolver = async (checksum: string): Promise<string | null> => {
    const book = getActiveBook();
    const db = getDocMgr()?.getDb();
    if (!book?.encKey || !db) return null;
    return loadBlobUrl(db, book.vaultId, checksum, book.encKey);
  };

  const iBridge = createAutomergeMirror<Recipe>({
    getDoc: () => getStore()!.getDoc(),
    getText: (d) => d.instructions ?? "",
    spliceText: (from, del, ins) => {
      getStore()!.change((d) => {
        const c = d.instructions ?? "";
        d.instructions = c.slice(0, from) + ins + c.slice(from + del);
      });
    },
    onLocalChange: () => getPushSnapshotFn()?.(),
  });
  setInstrBridge(iBridge);
  const instrView = new EditorView({
    doc: doc.instructions ?? "",
    extensions: [
      keymap.of([{ key: "Tab", run: acceptCompletion }, ...completionKeymap, ...defaultKeymap, ...historyKeymap]), history(),
      markdown(), appTheme, appSyntaxHighlighting, drawSelection(), highlightActiveLine(),
      EditorView.lineWrapping, EditorView.contentAttributes.of({ spellcheck: "true" }),
      iBridge.extension, remoteCursorsExtension,
      autocompletion({
        override: [
          ingredientCompletionSource(() => {
            const d = getStore()?.getDoc();
            return d?.ingredients?.map((ing: { item: string }) => ing.item).filter(Boolean) ?? [];
          }),
          recipeCompletionSource(getCatalogRecipes, () => getActiveBook()?.vaultId ?? "", () => getCurrentRecipeId() ?? ""),
        ],
        activateOnTyping: true,
        closeOnBlur: false,
      }),
      imagePreviewExtension(blobResolver),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          queuePresence({ field: "instructions", head: sel.head, anchor: sel.anchor });
          if (update.docChanged && getPresenceFallbackTimer()) {
            clearPresenceFallbackTimer();
          }
        }
      }),
      assetDomHandlers(() => getInstrEditorView()),
      EditorView.domEventHandlers({
        focus: () => {
          const sel = getInstrEditorView()!.state.selection.main;
          sendPresenceNow({ field: "instructions", head: sel.head, anchor: sel.anchor });
        },
        blur: () => {
          sendPresenceNow({ field: "instructions", active: false });
        },
      }),
    ],
    parent: instrEditorContainer,
  });
  setInstrEditorView(instrView);
  iBridge.setView(instrView);

  const nBridge = createAutomergeMirror<Recipe>({
    getDoc: () => getStore()!.getDoc(),
    getText: (d) => d.notes ?? "",
    spliceText: (from, del, ins) => {
      getStore()!.change((d) => {
        const c = d.notes ?? "";
        d.notes = c.slice(0, from) + ins + c.slice(from + del);
      });
    },
    onLocalChange: () => getPushSnapshotFn()?.(),
  });
  setNotesBridge(nBridge);
  const notesView = new EditorView({
    doc: doc.notes ?? "",
    extensions: [
      keymap.of([{ key: "Tab", run: acceptCompletion }, ...completionKeymap, ...defaultKeymap, ...historyKeymap]), history(),
      markdown(), appTheme, appSyntaxHighlighting, drawSelection(), highlightActiveLine(),
      EditorView.lineWrapping, EditorView.contentAttributes.of({ spellcheck: "true" }),
      nBridge.extension, remoteCursorsExtension,
      autocompletion({
        override: [
          ingredientCompletionSource(() => {
            const d = getStore()?.getDoc();
            return d?.ingredients?.map((ing: { item: string }) => ing.item).filter(Boolean) ?? [];
          }),
          recipeCompletionSource(getCatalogRecipes, () => getActiveBook()?.vaultId ?? "", () => getCurrentRecipeId() ?? ""),
        ],
        activateOnTyping: true,
        closeOnBlur: false,
      }),
      imagePreviewExtension(blobResolver),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          queuePresence({ field: "notes", head: sel.head, anchor: sel.anchor });
          if (update.docChanged && getPresenceFallbackTimer()) {
            clearPresenceFallbackTimer();
          }
        }
      }),
      assetDomHandlers(() => getNotesEditorView()),
      EditorView.domEventHandlers({
        focus: () => {
          const sel = getNotesEditorView()!.state.selection.main;
          sendPresenceNow({ field: "notes", head: sel.head, anchor: sel.anchor });
        },
        blur: () => {
          sendPresenceNow({ field: "notes", active: false });
        },
      }),
    ],
    parent: notesEditorContainer,
  });
  setNotesEditorView(notesView);
  nBridge.setView(notesView);

  setPageEditing(false);

  store.onChange((doc) => {
    // Sync title/tags to catalog if they changed (covers remote edits)
    const docTitle = doc.title ?? "";
    const docTags = [...(doc.tags ?? [])];
    if (docTitle !== lastSyncedTitle || JSON.stringify(docTags) !== JSON.stringify(lastSyncedTags)) {
      lastSyncedTitle = docTitle;
      lastSyncedTags = docTags;
      callbacks.onSyncCatalogMeta?.(docTitle, docTags);
    }

    // Update meta display from recipe doc
    titleEl.textContent = doc.title;
    if (isPageEditing() && document.activeElement !== titleInput) {
      titleInput.value = doc.title;
    }
    const newBase = doc.servings || 4;
    if (newBase !== getBaseServings()) {
      if (getScaleFactor() === 1) {
        // User hasn't scaled -- follow the new base
        setCurrentServings(newBase);
      } else {
        // User has a custom multiplier -- preserve it
        setCurrentServings(Math.max(1, Math.round(newBase * getScaleFactor())));
      }
      setBaseServings(newBase);
      setScaleFactor(getCurrentServings() / getBaseServings());
      updateScaleDisplay();
    }
    if (!isPageEditing()) renderMetaDisplay();
    renderIngredients(doc);
    if (isPageEditing()) {
      getInstrBridge()?.applyRemoteText();
      getNotesBridge()?.applyRemoteText();
      // Re-stage local cursor position after remote text change (will ride with next push if any)
      const instrEV = getInstrEditorView();
      if (instrEV && instrEV.hasFocus) {
        const sel = instrEV.state.selection.main;
        getSendPresenceFn()?.({ field: "instructions", head: sel.head, anchor: sel.anchor, _stage: true });
      }
      const notesEV = getNotesEditorView();
      if (notesEV && notesEV.hasFocus) {
        const sel = notesEV.state.selection.main;
        getSendPresenceFn()?.({ field: "notes", head: sel.head, anchor: sel.anchor, _stage: true });
      }
      const instrCursors = getInstrCursors();
      const notesCursors = getNotesCursors();
      for (const [, cursor] of instrCursors) {
        const len = getInstrEditorView()?.state.doc.length ?? 0;
        cursor.head = getInstrBridge()!.mapPosition(Math.min(cursor.head, len));
        cursor.anchor = getInstrBridge()!.mapPosition(Math.min(cursor.anchor, len));
      }
      for (const [, cursor] of notesCursors) {
        const len = getNotesEditorView()?.state.doc.length ?? 0;
        cursor.head = getNotesBridge()!.mapPosition(Math.min(cursor.head, len));
        cursor.anchor = getNotesBridge()!.mapPosition(Math.min(cursor.anchor, len));
      }
      if (instrCursors.size > 0 && getInstrEditorView()) {
        updateRemoteCursors(getInstrEditorView()!, Array.from(instrCursors.values()));
      }
      if (notesCursors.size > 0 && getNotesEditorView()) {
        updateRemoteCursors(getNotesEditorView()!, Array.from(notesCursors.values()));
      }
    } else {
      renderPreviews();
    }
  });
}

export function closeRecipe() {
  // Notify remote users our cursors are gone
  sendPresenceNow({ field: "instructions", active: false });
  sendPresenceNow({ field: "notes", active: false });
  getInstrEditorView()?.destroy();
  setInstrEditorView(null);
  setInstrBridge(null);
  getNotesEditorView()?.destroy();
  setNotesEditorView(null);
  setNotesBridge(null);
  if (metaDebounceTimer) flushMeta();
  revokeObjectUrls();
  setStore(null);
  setCurrentRecipeId(null);
  setPageEditingState(false);
  clearCursorState();
  getCheckedIngredients().clear();
  getUnitOverrides().clear();
  setScaleFactor(1);
  setLastLinkedRecipeIds([]);
  bumpLinkedRecipesGeneration();
  cleanupLinkedRecipes();
  linkedRecipesSection.hidden = true;
  linkedRecipesList.innerHTML = "";
  scaleBar.hidden = true;
  skeleton.hidden = true;
  detailView.hidden = true;
  emptyState.hidden = false;
  titleEl.hidden = false;
  titleInput.hidden = true;
  metaEl.hidden = false;
  metaEditEl.hidden = true;
}

export function handlePresence(deviceId: string, data: any, senderUserId?: string) {
  _handlePresence(deviceId, data, senderUserId);
}

export function isOpen(): boolean {
  return getStore() !== null;
}

/** Update edit permissions without re-opening the recipe (e.g. role changed). */
export function updateEditPermission(editable: boolean) {
  if (!getStore()) return;
  setCanEdit(editable);
  pageEditBtn.hidden = !getCanEdit();
  if (!getCanEdit() && isPageEditing()) {
    setPageEditing(false);
  }
}

/** Get the recipe ID currently displayed in the detail view. */
export function getOpenRecipeId(): string | null {
  return getCurrentRecipeId();
}

/** Called when the catalog changes (e.g. a linked recipe was renamed). Updates link names in markdown. */
export function onCatalogChanged() {
  if (!getStore()) return;
  reconcileRecipeLinkNames();
  // In view mode, re-render previews; in edit mode, the store.onChange handler
  // will call applyRemoteText() on the editor bridges automatically.
  if (!isPageEditing()) renderPreviews();
}

// -- Page-level edit/preview toggle --

function setPageEditing(editing: boolean) {
  if (!getCanEdit() && editing) return;
  const wasEditing = isPageEditing();
  setPageEditingState(editing);
  detailView.classList.toggle("editing", editing);
  pageEditBtn.textContent = editing ? "Done" : "Edit";

  // Toggle inline title editing
  titleEl.hidden = editing;
  titleInput.hidden = !editing;
  const store = getStore();
  if (editing && store) {
    const doc = store.getDoc();
    titleInput.value = doc.title;
    metaServingsInput.value = String(doc.servings || 4);
    metaPrepInput.value = String(doc.prepMinutes || 0);
    metaCookInput.value = String(doc.cookMinutes || 0);
    metaTagInput.suggestions = allTagSuggestions;
    metaTagInput.value = doc.tags ?? [];
  }
  metaEl.hidden = editing;
  metaEditEl.hidden = !editing;

  // On "Done" -- flush any pending debounce
  if (wasEditing && !editing) flushMeta();

  // Scale bar: show in view mode, hide in edit mode
  scaleBar.hidden = editing;
  if (editing) {
    // Reset scaling and checks when entering edit mode
    getCheckedIngredients().clear();
    setCurrentServings(getBaseServings());
    setScaleFactor(1);
    updateScaleDisplay();
  } else {
    // Tell remote users our cursors are gone
    sendPresenceNow({ field: "instructions", active: false });
    sendPresenceNow({ field: "notes", active: false });
  }

  instrEditorContainer.hidden = !editing;
  instrPreviewContainer.hidden = editing;
  if (editing) {
    getInstrBridge()?.applyRemoteText();
  } else {
    renderPreviews();
  }

  notesEditorContainer.hidden = !editing;
  notesPreviewContainer.hidden = editing;
  if (editing) {
    getNotesBridge()?.applyRemoteText();
  }

  renderIngredients(store?.getDoc() ?? { title: "", tags: [], servings: 4, prepMinutes: 0, cookMinutes: 0, createdAt: 0, updatedAt: 0, description: "", ingredients: [], instructions: "", imageUrls: [], notes: "" });
}

// -- Render --

function renderPreviews() {
  const store = getStore();
  if (!store) return;
  const doc = store.getDoc();
  const linkedIds = new Set<string>();

  const instrIngResolved = resolveIngredientRefs(doc.instructions ?? "", doc);
  const instrResolved = resolveRecipeRefs(instrIngResolved, linkedIds);
  const instrExtracted = extractImageWidths(instrResolved);
  const instrHtml = DOMPurify.sanitize(marked.parse(instrExtracted.cleaned) as string, { ADD_ATTR: ["data-recipe-id", "data-doc-id"] });
  instrPreviewContainer.innerHTML = instrHtml || "<em>No instructions yet.</em>";
  applyImageWidths(instrPreviewContainer, instrExtracted.widths);

  const notesIngResolved = resolveIngredientRefs(doc.notes ?? "", doc);
  const notesResolved = resolveRecipeRefs(notesIngResolved, linkedIds);
  const notesExtracted = extractImageWidths(notesResolved);
  const notesHtml = DOMPurify.sanitize(marked.parse(notesExtracted.cleaned) as string, { ADD_ATTR: ["data-recipe-id", "data-doc-id"] });
  notesPreviewContainer.innerHTML = notesHtml || "<em>No notes yet.</em>";
  applyImageWidths(notesPreviewContainer, notesExtracted.widths);

  // Resolve blob: image/asset URLs
  resolveBlobAssets(instrPreviewContainer);
  resolveBlobAssets(notesPreviewContainer);

  // Wire up recipe ref click handlers
  for (const container of [instrPreviewContainer, notesPreviewContainer]) {
    container.querySelectorAll<HTMLElement>(".recipe-ref[data-recipe-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const recipeId = el.dataset.recipeId;
        if (recipeId) callbacks.onNavigateToRecipe?.(recipeId);
      });
    });
  }

  // Render linked recipes section
  const ids = [...linkedIds];
  setLastLinkedRecipeIds(ids);
  renderLinkedRecipes(ids, callbacks);
}
