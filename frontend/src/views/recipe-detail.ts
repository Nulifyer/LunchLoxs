/**
 * Recipe detail view with unified edit/preview mode.
 */

import type { Recipe } from "../types";
import type { TagInput } from "../components/tag-input";
import type { AutocompleteInput } from "../components/autocomplete-input";
import { AutomergeStore } from "../lib/automerge-store";
import { createAutomergeMirror } from "../lib/codemirror-automerge";
import { remoteCursorsExtension, updateRemoteCursors, shortDeviceName, type RemoteCursor } from "../lib/remote-cursors";
import { escapeHtml, escapeAttr } from "../lib/html";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { appTheme, appSyntaxHighlighting } from "../lib/cm-theme";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { createDropdown } from "../lib/dropdown";
import { parseQty, formatQty, scaleQty } from "../lib/quantity";
import { convertIngredient, convertToUnit, resolveUnit, getConversionTargets, isDecimalUnit, canonicalUnitName, type UnitSystem } from "../lib/units";
import { findDensity, convertViaDensity, WEIGHT_UNITS, VOLUME_UNITS } from "../lib/densities";
import { ingredientCompletions } from "../lib/cm-ingredient-completions";
import { processAsset, AssetError } from "../lib/asset-processing";
import { storeBlob, loadBlobUrl, loadBlobMeta, revokeObjectUrls } from "../lib/blob-client";
import { getActiveBook, getDocMgr } from "../state";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// -- DOM refs --
const detailView = document.getElementById("recipe-detail") as HTMLElement;
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
const scaleDisplay = document.getElementById("scale-display") as HTMLElement;

const instrEditorContainer = document.getElementById("editor-container") as HTMLElement;
const instrPreviewContainer = document.getElementById("preview-container") as HTMLElement;
const notesEditorContainer = document.getElementById("notes-editor-container") as HTMLElement;
const notesPreviewContainer = document.getElementById("notes-preview-container") as HTMLElement;

// -- State --
let store: AutomergeStore<Recipe> | null = null;
let instrEditorView: EditorView | null = null;
let instrBridge: ReturnType<typeof createAutomergeMirror> | null = null;
let notesEditorView: EditorView | null = null;
let notesBridge: ReturnType<typeof createAutomergeMirror> | null = null;
let pageEditing = false;
let instrCursors = new Map<string, RemoteCursor>();
let notesCursors = new Map<string, RemoteCursor>();
let onPushSnapshot: (() => void) | null = null;
let onSendPresence: ((data: any) => void) | null = null;
let canEdit = true;
let checkedIngredients = new Set<number>();
let scaleFactor = 1;
let baseServings = 4;
let currentServings = 4;
let unitSystem: UnitSystem = (localStorage.getItem("unit-system") as UnitSystem) || "original";
let unitOverrides = new Map<number, string>(); // per-ingredient overrides: idx -> target unit canonical name
const unitToggleBtn = document.getElementById("unit-toggle-btn") as HTMLButtonElement;

function cycleUnitSystem(current: UnitSystem): UnitSystem {
  if (current === "original") return "metric";
  if (current === "metric") return "imperial";
  return "original";
}

const UNIT_LABELS: Record<UnitSystem, string> = {
  original: "Original",
  metric: "Metric",
  imperial: "Imperial",
};
let currentRecipeId: string | null = null;
let allTagSuggestions: string[] = [];
let allIngredientSuggestions: string[] = [];
/** Update ingredient suggestions after async loading. */
export function setIngredientSuggestions(suggestions: string[]) {
  allIngredientSuggestions = suggestions;
}
/** Merge passed-in suggestions with current recipe's ingredient names. */
function getIngredientSuggestions(): string[] {
  const set = new Set<string>(allIngredientSuggestions);
  const doc = store?.getDoc();
  if (doc?.ingredients) {
    for (const ing of doc.ingredients) {
      const name = ing.item?.trim().toLowerCase();
      if (name) set.add(name);
    }
  }
  return [...set].sort();
}
let metaDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const META_DEBOUNCE_MS = 400;
let presenceFallbackTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Stage cursor data to ride with the next text push.
 * Starts a fallback timer so selection-only moves (no text change)
 * still send a standalone presence after 500ms.
 */
function queuePresence(data: any) {
  // _stage tells the callback to stage on the SyncClient (bundled with push)
  onSendPresence?.({ ...data, _stage: true });
  // Fallback: if no push happens within 500ms (selection-only move),
  // send a standalone presence so the cursor still updates for others.
  if (presenceFallbackTimer) clearTimeout(presenceFallbackTimer);
  presenceFallbackTimer = setTimeout(() => {
    presenceFallbackTimer = null;
    onSendPresence?.(data);
  }, 500);
}

/** Send presence immediately (focus/blur events). */
function sendPresenceNow(data: any) {
  if (presenceFallbackTimer) { clearTimeout(presenceFallbackTimer); presenceFallbackTimer = null; }
  onSendPresence?.(data);
}

export interface DetailCallbacks {
  onBack: () => void;
  /** Called after content edits (instructions, ingredients, notes). Sets updatedAt + pushes recipe doc. */
  onContentChanged: () => void;
  onSendPresence: (data: any) => void;
  /** Mirror title + tags to the catalog for sidebar display, and push both docs. */
  onMetaChanged: (title: string, tags: string[]) => void;
  onDeleteRecipe: () => void;
  onExportRecipe?: () => void;
  onCopyToBook?: () => void;
}

let callbacks: DetailCallbacks;

function debounceMeta() {
  if (!pageEditing || !store) return;
  if (metaDebounceTimer) clearTimeout(metaDebounceTimer);
  metaDebounceTimer = setTimeout(flushMeta, META_DEBOUNCE_MS);
}

function flushMeta() {
  if (metaDebounceTimer) { clearTimeout(metaDebounceTimer); metaDebounceTimer = null; }
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
  onPushSnapshot = cb.onContentChanged;
  onSendPresence = cb.onSendPresence;

  pageEditBtn.addEventListener("click", () => setPageEditing(!pageEditing));

  titleInput.addEventListener("input", debounceMeta);
  metaServingsInput.addEventListener("input", debounceMeta);
  metaPrepInput.addEventListener("input", debounceMeta);
  metaCookInput.addEventListener("input", debounceMeta);
  metaTagInput.addEventListener("change", debounceMeta);

  instrPreviewContainer.addEventListener("click", () => {
    if (pageEditing) instrEditorView?.focus();
  });
  notesPreviewContainer.addEventListener("click", () => {
    if (pageEditing) notesEditorView?.focus();
  });

  // -- Ingredient event delegation --

  ingredientsList.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    // Delete button
    const deleteBtn = target.closest("[data-delete-ing]") as HTMLElement;
    if (deleteBtn && store) {
      const idx = parseInt(deleteBtn.dataset.deleteIng!);
      store.change((doc) => {
        if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
          doc.ingredients.splice(idx, 1);
        }
      });
      onPushSnapshot?.();
      return;
    }

    // Check-off toggle (view mode)
    const check = target.closest(".ing-check") as HTMLElement;
    if (check) {
      const li = check.closest("li") as HTMLElement;
      const idx = parseInt(li.dataset.ingIdx ?? "-1");
      if (idx < 0) return;
      if (checkedIngredients.has(idx)) checkedIngredients.delete(idx);
      else checkedIngredients.add(idx);
      li.classList.toggle("ing-checked", checkedIngredients.has(idx));
      return;
    }

    // Unit conversion picker (click on unit span in view mode)
    const unitSpan = target.closest(".ing-unit") as HTMLElement;
    if (unitSpan && !pageEditing) {
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
    const field = target.dataset.ingField as "quantity" | "unit" | "item" | undefined;
    if (!field || !store) return;

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
        instrBridge?.applyRemoteText();
        notesBridge?.applyRemoteText();
        onPushSnapshot?.();
        return;
      }
    }

    store.change((doc) => {
      if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
        doc.ingredients[idx]![field] = value;
      }
    });
    onPushSnapshot?.();
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
          if (!input.dataset.ghost && store) {
            const idx = parseInt(input.dataset.ingIdx ?? "-1");
            if (idx >= 0) {
              store.change((doc) => {
                if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
                  doc.ingredients[idx]!.unit = canonical;
                }
              });
              onPushSnapshot?.();
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
    onPushSnapshot?.();
  });

  ingredientsList.addEventListener("pointercancel", () => clearDragState());

  // -- Scale bar --

  scaleBar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-scale]") as HTMLElement;
    if (!btn) return;
    const action = btn.dataset.scale;
    if (action === "increase") currentServings++;
    else if (action === "decrease" && currentServings > 1) currentServings--;
    else if (action === "double") currentServings *= 2;
    else if (action === "half" && currentServings > 1) currentServings = Math.max(1, Math.round(currentServings / 2));
    else if (action === "reset") {
      currentServings = baseServings;
      checkedIngredients.clear();
      unitOverrides.clear();
      unitSystem = "original";
      localStorage.setItem("unit-system", unitSystem);
      unitToggleBtn.textContent = UNIT_LABELS[unitSystem];
      unitToggleBtn.dataset.unitSystem = unitSystem;
    }
    scaleFactor = currentServings / baseServings;
    updateScaleDisplay();
    if (store) renderIngredients(store.getDoc());
  });

  // -- Unit system toggle --
  unitToggleBtn.textContent = UNIT_LABELS[unitSystem];
  unitToggleBtn.dataset.unitSystem = unitSystem;
  unitToggleBtn.addEventListener("click", () => {
    unitSystem = cycleUnitSystem(unitSystem);
    localStorage.setItem("unit-system", unitSystem);
    unitToggleBtn.textContent = UNIT_LABELS[unitSystem];
    unitToggleBtn.dataset.unitSystem = unitSystem;
    unitOverrides.clear();
    if (store) renderIngredients(store.getDoc());
  });
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function renderMetaDisplay() {
  if (!store) return;
  const doc = store.getDoc();
  metaEl.innerHTML = "";

  // Tags line
  const tags = doc.tags ?? [];
  if (tags.length > 0) {
    const tagLine = document.createElement("div");
    tagLine.className = "meta-tags-line";
    tagLine.innerHTML = tags.map((t: string) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
    metaEl.appendChild(tagLine);
  }

  // Stats line: servings · prep · cook · updated
  const stats = [
    doc.servings ? `${doc.servings} servings` : "",
    doc.prepMinutes ? `${doc.prepMinutes}m prep` : "",
    doc.cookMinutes ? `${doc.cookMinutes}m cook` : "",
  ].filter(Boolean);
  if (doc.updatedAt && doc.updatedAt > 0) {
    stats.push("updated " + timeAgo(doc.updatedAt));
  }
  if (stats.length > 0) {
    const statsLine = document.createElement("div");
    statsLine.className = "meta-stats-line";
    statsLine.textContent = stats.join(" · ");
    if (doc.updatedAt && doc.updatedAt > 0) {
      statsLine.title = new Date(doc.updatedAt).toLocaleString();
    }
    metaEl.appendChild(statsLine);
  }
}

/** Handle image/asset paste or drop into a CodeMirror editor. */
function handleAssetFiles(files: File[], view: EditorView, pos: number): boolean {
  const imageFiles = files.filter((f) => f.type.startsWith("image/") || f.name.endsWith(".pdf") || f.name.endsWith(".svg"));
  if (imageFiles.length === 0) return false;

  const book = getActiveBook();
  const db = getDocMgr()?.getDb();
  if (!book?.encKey || !db) return false;

  for (const file of imageFiles) {
    // Insert placeholder
    const placeholder = `![Uploading ${file.name}…]()\n`;
    view.dispatch({ changes: { from: pos, insert: placeholder } });
    const placeholderEnd = pos + placeholder.length;

    processAsset(file)
      .then(async (asset) => {
        const checksum = await storeBlob(db, book.vaultId, asset.bytes, asset.mimeType, asset.filename, book.encKey!);
        const isImage = asset.mimeType.startsWith("image/");
        const md = isImage
          ? `![${asset.filename}](blob:${checksum})\n`
          : `[${asset.filename}](blob:${checksum})\n`;

        // Replace the placeholder
        const docText = view.state.doc.toString();
        const phIdx = docText.indexOf(placeholder);
        if (phIdx >= 0) {
          view.dispatch({ changes: { from: phIdx, to: phIdx + placeholder.length, insert: md } });
        } else {
          // Placeholder was edited away — append at end
          const end = view.state.doc.length;
          view.dispatch({ changes: { from: end, insert: "\n" + md } });
        }
        onPushSnapshot?.();
      })
      .catch((err) => {
        // Remove placeholder on error
        const docText = view.state.doc.toString();
        const phIdx = docText.indexOf(placeholder);
        if (phIdx >= 0) {
          view.dispatch({ changes: { from: phIdx, to: phIdx + placeholder.length, insert: "" } });
        }
        const msg = err instanceof AssetError ? err.message : "Failed to process file.";
        console.error("Asset upload error:", err);
        alert(msg);
      });

    pos = placeholderEnd;
  }
  return true;
}

/** Create CM domEventHandlers for asset paste/drop. */
function assetDomHandlers(getView: () => EditorView | null) {
  return EditorView.domEventHandlers({
    paste: (event) => {
      const items = event.clipboardData?.items;
      if (!items) return false;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      const view = getView();
      if (!view || files.length === 0) return false;
      event.preventDefault();
      return handleAssetFiles(files, view, view.state.selection.main.head);
    },
    drop: (event) => {
      const files = event.dataTransfer?.files;
      const view = getView();
      if (!files || files.length === 0 || !view) return false;
      const imageFiles = Array.from(files).filter(
        (f) => f.type.startsWith("image/") || f.name.endsWith(".pdf") || f.name.endsWith(".svg"),
      );
      if (imageFiles.length === 0) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.doc.length;
      return handleAssetFiles(imageFiles, view, pos);
    },
  });
}

export function openRecipe(recipeStore: AutomergeStore<Recipe>, recipeId: string, editable = true, bookName?: string, tagSuggestions: string[] = []) {
  closeRecipe();
  store = recipeStore;
  currentRecipeId = recipeId;
  allTagSuggestions = tagSuggestions;
  allIngredientSuggestions = [];
  const meta = store.getDoc();
  // Reset ingredient UI state
  checkedIngredients.clear();
  unitOverrides.clear();
  baseServings = meta.servings || 4;
  currentServings = baseServings;
  scaleFactor = 1;
  titleEl.textContent = meta.title;
  // Update breadcrumb
  const breadcrumbBookName = document.getElementById("breadcrumb-book-name") as HTMLElement;
  if (breadcrumbBookName) breadcrumbBookName.textContent = bookName ?? "";
  renderMetaDisplay();
  canEdit = editable;
  emptyState.hidden = true;
  detailView.hidden = false;
  // Edit button for viewers is hidden
  pageEditBtn.hidden = !canEdit;

  // Build actions dropdown
  actionsSlot.innerHTML = "";
  const menuItems = [];
  if (callbacks.onExportRecipe) {
    menuItems.push({ label: "Export as .md", action: () => callbacks.onExportRecipe!() });
  }
  if (callbacks.onCopyToBook && canEdit) {
    menuItems.push({ label: "Copy to Book...", action: () => callbacks.onCopyToBook!() });
  }
  if (canEdit) {
    menuItems.push({ label: "Delete", action: () => callbacks.onDeleteRecipe(), danger: true, separator: true });
  }
  if (menuItems.length > 0) {
    actionsSlot.appendChild(createDropdown(menuItems));
  }

  const doc = store.getDoc();

  const iBridge = createAutomergeMirror<Recipe>({
    getDoc: () => store!.getDoc(),
    getText: (d) => d.instructions ?? "",
    spliceText: (from, del, ins) => {
      store!.change((d) => {
        const c = d.instructions ?? "";
        d.instructions = c.slice(0, from) + ins + c.slice(from + del);
      });
    },
    onLocalChange: () => onPushSnapshot?.(),
  });
  instrBridge = iBridge;
  instrEditorView = new EditorView({
    doc: doc.instructions ?? "",
    extensions: [
      keymap.of([...defaultKeymap, ...historyKeymap]), history(),
      markdown(), appTheme, appSyntaxHighlighting, drawSelection(), highlightActiveLine(),
      EditorView.lineWrapping, iBridge.extension, remoteCursorsExtension,
      ingredientCompletions(() => {
        const d = store?.getDoc();
        return d?.ingredients?.map((ing: { item: string }) => ing.item).filter(Boolean) ?? [];
      }),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          queuePresence({ field: "instructions", head: sel.head, anchor: sel.anchor });
          // Doc change means a push is coming -- it will carry the cursor, so kill the fallback
          if (update.docChanged && presenceFallbackTimer) {
            clearTimeout(presenceFallbackTimer);
            presenceFallbackTimer = null;
          }
        }
      }),
      assetDomHandlers(() => instrEditorView),
      EditorView.domEventHandlers({
        focus: () => {
          const sel = instrEditorView!.state.selection.main;
          sendPresenceNow({ field: "instructions", head: sel.head, anchor: sel.anchor });
        },
        blur: () => {
          sendPresenceNow({ field: "instructions", active: false });
        },
      }),
    ],
    parent: instrEditorContainer,
  });
  iBridge.setView(instrEditorView);

  const nBridge = createAutomergeMirror<Recipe>({
    getDoc: () => store!.getDoc(),
    getText: (d) => d.notes ?? "",
    spliceText: (from, del, ins) => {
      store!.change((d) => {
        const c = d.notes ?? "";
        d.notes = c.slice(0, from) + ins + c.slice(from + del);
      });
    },
    onLocalChange: () => onPushSnapshot?.(),
  });
  notesBridge = nBridge;
  notesEditorView = new EditorView({
    doc: doc.notes ?? "",
    extensions: [
      keymap.of([...defaultKeymap, ...historyKeymap]), history(),
      markdown(), appTheme, appSyntaxHighlighting, drawSelection(), highlightActiveLine(),
      EditorView.lineWrapping, nBridge.extension, remoteCursorsExtension,
      ingredientCompletions(() => {
        const d = store?.getDoc();
        return d?.ingredients?.map((ing: { item: string }) => ing.item).filter(Boolean) ?? [];
      }),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          queuePresence({ field: "notes", head: sel.head, anchor: sel.anchor });
          if (update.docChanged && presenceFallbackTimer) {
            clearTimeout(presenceFallbackTimer);
            presenceFallbackTimer = null;
          }
        }
      }),
      assetDomHandlers(() => notesEditorView),
      EditorView.domEventHandlers({
        focus: () => {
          const sel = notesEditorView!.state.selection.main;
          sendPresenceNow({ field: "notes", head: sel.head, anchor: sel.anchor });
        },
        blur: () => {
          sendPresenceNow({ field: "notes", active: false });
        },
      }),
    ],
    parent: notesEditorContainer,
  });
  nBridge.setView(notesEditorView);

  setPageEditing(false);

  store.onChange((doc) => {
    // Update meta display from recipe doc
    titleEl.textContent = doc.title;
    if (pageEditing && document.activeElement !== titleInput) {
      titleInput.value = doc.title;
    }
    const newBase = doc.servings || 4;
    if (newBase !== baseServings) {
      if (scaleFactor === 1) {
        // User hasn't scaled — follow the new base
        currentServings = newBase;
      } else {
        // User has a custom multiplier — preserve it
        currentServings = Math.max(1, Math.round(newBase * scaleFactor));
      }
      baseServings = newBase;
      scaleFactor = currentServings / baseServings;
      updateScaleDisplay();
    }
    if (!pageEditing) renderMetaDisplay();
    renderIngredients(doc);
    if (pageEditing) {
      instrBridge?.applyRemoteText();
      notesBridge?.applyRemoteText();
      // Re-stage local cursor position after remote text change (will ride with next push if any)
      if (instrEditorView && instrEditorView.hasFocus) {
        const sel = instrEditorView.state.selection.main;
        onSendPresence?.({ field: "instructions", head: sel.head, anchor: sel.anchor, _stage: true });
      }
      if (notesEditorView && notesEditorView.hasFocus) {
        const sel = notesEditorView.state.selection.main;
        onSendPresence?.({ field: "notes", head: sel.head, anchor: sel.anchor, _stage: true });
      }
      for (const [, cursor] of instrCursors) {
        cursor.head = instrBridge!.mapPosition(cursor.head);
        cursor.anchor = instrBridge!.mapPosition(cursor.anchor);
      }
      for (const [, cursor] of notesCursors) {
        cursor.head = notesBridge!.mapPosition(cursor.head);
        cursor.anchor = notesBridge!.mapPosition(cursor.anchor);
      }
      if (instrCursors.size > 0 && instrEditorView) {
        updateRemoteCursors(instrEditorView, Array.from(instrCursors.values()));
      }
      if (notesCursors.size > 0 && notesEditorView) {
        updateRemoteCursors(notesEditorView, Array.from(notesCursors.values()));
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
  instrEditorView?.destroy();
  instrEditorView = null;
  instrBridge = null;
  notesEditorView?.destroy();
  notesEditorView = null;
  notesBridge = null;
  if (metaDebounceTimer) flushMeta();
  revokeObjectUrls();
  store = null;
  currentRecipeId = null;
  pageEditing = false;
  instrCursors.clear();
  notesCursors.clear();
  checkedIngredients.clear();
  unitOverrides.clear();
  scaleFactor = 1;
  scaleBar.hidden = true;
  detailView.hidden = true;
  emptyState.hidden = false;
  titleEl.hidden = false;
  titleInput.hidden = true;
  metaEl.hidden = false;
  metaEditEl.hidden = true;
}

export function handlePresence(deviceId: string, data: any, senderUserId?: string) {
  if (!data.field) return;
  const cursorKey = senderUserId ? `${senderUserId}:${deviceId}` : deviceId;

  // User blurred this editor -- remove their cursor
  if (data.active === false) {
    if (data.field === "instructions") {
      instrCursors.delete(cursorKey);
      if (instrEditorView) updateRemoteCursors(instrEditorView, Array.from(instrCursors.values()));
    } else if (data.field === "notes") {
      notesCursors.delete(cursorKey);
      if (notesEditorView) updateRemoteCursors(notesEditorView, Array.from(notesCursors.values()));
    }
    return;
  }

  const name = data.username || shortDeviceName(deviceId);
  const head = data.head ?? 0;
  const anchor = data.anchor ?? 0;

  if (data.field === "instructions" && instrEditorView) {
    const mappedHead = instrBridge ? instrBridge.mapPosition(head) : head;
    const mappedAnchor = instrBridge ? instrBridge.mapPosition(anchor) : anchor;
    // Remove from notes if they moved to instructions
    notesCursors.delete(cursorKey);
    if (notesEditorView) updateRemoteCursors(notesEditorView, Array.from(notesCursors.values()));
    instrCursors.set(cursorKey, {
      deviceId: cursorKey, name,
      head: mappedHead, anchor: mappedAnchor, todoId: "instructions",
    });
    updateRemoteCursors(instrEditorView, Array.from(instrCursors.values()));
  } else if (data.field === "notes" && notesEditorView) {
    const mappedHead = notesBridge ? notesBridge.mapPosition(head) : head;
    const mappedAnchor = notesBridge ? notesBridge.mapPosition(anchor) : anchor;
    // Remove from instructions if they moved to notes
    instrCursors.delete(cursorKey);
    if (instrEditorView) updateRemoteCursors(instrEditorView, Array.from(instrCursors.values()));
    notesCursors.set(cursorKey, {
      deviceId: cursorKey, name,
      head: mappedHead, anchor: mappedAnchor, todoId: "notes",
    });
    updateRemoteCursors(notesEditorView, Array.from(notesCursors.values()));
  }
}

export function isOpen(): boolean {
  return store !== null;
}

/** Update edit permissions without re-opening the recipe (e.g. role changed). */
export function updateEditPermission(editable: boolean) {
  if (!store) return;
  canEdit = editable;
  pageEditBtn.hidden = !canEdit;
  if (!canEdit && pageEditing) {
    setPageEditing(false);
  }
}

/** Get the recipe ID currently displayed in the detail view. */
export function getOpenRecipeId(): string | null {
  return currentRecipeId;
}

// -- Page-level edit/preview toggle --

function setPageEditing(editing: boolean) {
  if (!canEdit && editing) return;
  const wasEditing = pageEditing;
  pageEditing = editing;
  detailView.classList.toggle("editing", editing);
  pageEditBtn.textContent = editing ? "Done" : "Edit";

  // Toggle inline title editing
  titleEl.hidden = editing;
  titleInput.hidden = !editing;
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

  // On "Done" — flush any pending debounce
  if (wasEditing && !editing) flushMeta();

  // Scale bar: show in view mode, hide in edit mode
  scaleBar.hidden = editing;
  if (editing) {
    // Reset scaling and checks when entering edit mode
    checkedIngredients.clear();
    currentServings = baseServings;
    scaleFactor = 1;
    updateScaleDisplay();
  } else {
    // Tell remote users our cursors are gone
    sendPresenceNow({ field: "instructions", active: false });
    sendPresenceNow({ field: "notes", active: false });
  }

  instrEditorContainer.hidden = !editing;
  instrPreviewContainer.hidden = editing;
  if (editing) {
    instrBridge?.applyRemoteText();
  } else {
    renderPreviews();
  }

  notesEditorContainer.hidden = !editing;
  notesPreviewContainer.hidden = editing;
  if (editing) {
    notesBridge?.applyRemoteText();
  }

  renderIngredients(store?.getDoc() ?? { title: "", tags: [], servings: 4, prepMinutes: 0, cookMinutes: 0, createdAt: 0, updatedAt: 0, description: "", ingredients: [], instructions: "", imageUrls: [], notes: "" });
}

// -- Render --

function commitGhostRow() {
  if (!store) return;
  const ghostLi = ingredientsList.querySelector(".ing-ghost");
  if (!ghostLi) return;
  const qtyIn = ghostLi.querySelector("[data-ing-field='quantity']") as HTMLInputElement;
  const unitIn = ghostLi.querySelector("[data-ing-field='unit']") as HTMLInputElement;
  const itemIn = ghostLi.querySelector("[data-ing-field='item']") as AutocompleteInput;
  const item = itemIn?.value?.trim();
  if (!item) return;
  store.change((doc) => {
    if (!doc.ingredients) doc.ingredients = [];
    const unit = canonicalUnitName(unitIn?.value ?? "") ?? unitIn?.value.trim() ?? "";
    doc.ingredients.push({ item, quantity: qtyIn?.value.trim() ?? "", unit });
  });
  onPushSnapshot?.();
  // Re-render will create a fresh ghost row; focus its item field
  renderIngredients(store.getDoc());
  const newGhost = ingredientsList.querySelector(".ing-ghost [data-ing-field='quantity']") as HTMLInputElement;
  newGhost?.focus();
}

function updateScaleDisplay() {
  scaleDisplay.textContent = `${currentServings} servings`;
  scaleBar.classList.toggle("scaled", currentServings !== baseServings);
}


function renderIngredients(doc: Recipe) {
  const ingredients = doc.ingredients ?? [];

  if (pageEditing) {
    // Save focus state before re-render
    const focused = document.activeElement as HTMLInputElement | null;
    const focusGhost = focused?.dataset.ghost === "true";
    const focusKey = !focusGhost && focused?.dataset.ingIdx && focused?.dataset.ingField
      ? `${focused.dataset.ingIdx}:${focused.dataset.ingField}` : null;
    const ghostFocusField = focusGhost ? focused?.dataset.ingField ?? null : null;
    const focusPos = focused?.selectionStart ?? 0;

    let html = "";
    if (ingredients.length === 0) {
      html += '<li class="ing-empty"><em>No ingredients yet. Type below to add.</em></li>';
    } else {
      html += ingredients
        .map((ing, i) => `<li data-ing-idx="${i}">
          <span class="ing-drag-handle">&#x283F;</span>
          <input class="ing-edit ing-qty" data-ing-idx="${i}" data-ing-field="quantity" value="${escapeAttr(ing.quantity)}" placeholder="qty" />
          <input class="ing-edit ing-unit" data-ing-idx="${i}" data-ing-field="unit" value="${escapeAttr(ing.unit)}" placeholder="unit" />
          <autocomplete-input class="ing-edit ing-text" data-ing-idx="${i}" data-ing-field="item" value="${escapeAttr(ing.item)}" placeholder="ingredient"></autocomplete-input>
          <button data-delete-ing="${i}" title="Remove">&times;</button>
        </li>`)
        .join("");
    }
    // Ghost row for adding
    html += `<li class="ing-ghost">
      <span class="ing-drag-handle" style="visibility:hidden">&#x283F;</span>
      <input class="ing-edit ing-qty" data-ghost="true" data-ing-field="quantity" value="" placeholder="qty" />
      <input class="ing-edit ing-unit" data-ghost="true" data-ing-field="unit" value="" placeholder="unit" />
      <autocomplete-input class="ing-edit ing-text" data-ghost="true" data-ing-field="item" placeholder="add ingredient..."></autocomplete-input>
    </li>`;
    ingredientsList.innerHTML = html;

    // Set suggestions on all autocomplete-input elements
    const suggestions = getIngredientSuggestions();
    ingredientsList.querySelectorAll("autocomplete-input").forEach((el) => {
      (el as AutocompleteInput).suggestions = suggestions;
    });

    // Restore focus
    if (focusKey) {
      const [idx, field] = focusKey.split(":");
      const el = ingredientsList.querySelector(`[data-ing-idx="${idx}"][data-ing-field="${field}"]:not([data-ghost])`) as HTMLElement;
      if (el) { el.focus(); (el as any).setSelectionRange?.(focusPos, focusPos); }
    } else if (ghostFocusField) {
      const el = ingredientsList.querySelector(`.ing-ghost [data-ing-field="${ghostFocusField}"]`) as HTMLElement;
      if (el) { el.focus(); (el as any).setSelectionRange?.(focusPos, focusPos); }
    }
  } else {
    // View mode with check-off, scaling, and unit conversion
    if (ingredients.length === 0) {
      ingredientsList.innerHTML = '<li class="ing-empty"><em>No ingredients.</em></li>';
    } else {
      ingredientsList.innerHTML = ingredients
        .map((ing, i) => {
          const checked = checkedIngredients.has(i);
          const scaledRaw = scaleQty(ing.quantity, scaleFactor);
          const scaledNum = parseQty(scaledRaw);
          const overrideUnit = unitOverrides.get(i);
          let displayQty = escapeHtml(scaledRaw);
          let displayUnit = escapeHtml(ing.unit);
          let converted = false;
          if (scaledNum !== null) {
            // Per-ingredient override takes priority, then global system
            let result: { qty: number; unit: string } | null = null;
            if (overrideUnit?.startsWith("~")) {
              // Density-based cross-dimension conversion
              const targetUnit = overrideUnit.slice(1);
              const ud = resolveUnit(ing.unit);
              const den = findDensity(ing.item);
              if (ud && den) {
                result = convertViaDensity(scaledNum, ud.toBase, ud.dimension, targetUnit, den);
              }
            } else if (overrideUnit) {
              result = convertToUnit(scaledNum, ing.unit, overrideUnit);
            } else if (unitSystem !== "original") {
              const sys = convertIngredient(scaledNum, ing.unit, unitSystem);
              if (sys.unit !== ing.unit) result = sys;
            }
            if (result) {
              displayQty = escapeHtml(formatQty(result.qty, isDecimalUnit(result.unit)));
              displayUnit = escapeHtml(result.unit);
              converted = true;
            }
          }
          const convertible = resolveUnit(ing.unit) !== null;
          const unitClass = "ing-unit" + (converted ? " ing-converted" : "") + (convertible ? " ing-convertible" : "");
          return `<li data-ing-idx="${i}" data-orig-unit="${escapeAttr(ing.unit)}" class="${checked ? "ing-checked" : ""}">
            <span class="ing-check"></span>
            <span class="ing-qty">${displayQty}</span>
            <span class="${unitClass}">${displayUnit}</span>
            <span class="ing-text">${escapeHtml(ing.item)}</span>
          </li>`;
        })
        .join("");
    }
    updateScaleDisplay();
  }
}

/** Resolve `@[name]` ingredient references in markdown source before rendering. */
function resolveIngredientRefs(md: string, doc: Recipe): string {
  const ingredients = doc.ingredients ?? [];
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

function renderPreviews() {
  if (!store) return;
  const doc = store.getDoc();
  const instrMd = resolveIngredientRefs(doc.instructions ?? "", doc);
  const instrHtml = DOMPurify.sanitize(marked.parse(instrMd) as string);
  instrPreviewContainer.innerHTML = instrHtml || "<em>No instructions yet.</em>";
  const notesMd = resolveIngredientRefs(doc.notes ?? "", doc);
  const notesHtml = DOMPurify.sanitize(marked.parse(notesMd) as string);
  notesPreviewContainer.innerHTML = notesHtml || "<em>No notes yet.</em>";

  // Resolve blob: image/asset URLs
  resolveBlobAssets(instrPreviewContainer);
  resolveBlobAssets(notesPreviewContainer);
}

/** Find blob: references in rendered HTML and load/decrypt them. */
function resolveBlobAssets(container: HTMLElement) {
  const book = getActiveBook();
  const db = getDocMgr()?.getDb();
  if (!book?.encKey || !db) return;

  // Images: <img src="blob:checksum">
  container.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith("blob:")) return;
    const checksum = src.slice(5);
    if (!checksum) return;

    img.removeAttribute("src");
    img.classList.add("blob-loading");
    img.dataset.blob = checksum;

    loadBlobUrl(db, book.vaultId, checksum, book.encKey!).then((url) => {
      if (url) {
        img.src = url;
        img.classList.remove("blob-loading");
        img.style.cursor = "pointer";
        img.addEventListener("click", () => showAssetOverlay(url, "image"));
      } else {
        img.alt = `[Image not found: ${checksum.slice(0, 8)}…]`;
        img.classList.remove("blob-loading");
      }
    });
  });

  // Links: <a href="blob:checksum">
  container.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (!href.startsWith("blob:")) return;
    const checksum = href.slice(5);
    if (!checksum) return;

    a.removeAttribute("href");
    a.classList.add("blob-file-link");

    loadBlobMeta(db, book.vaultId, checksum).then((meta) => {
      const name = meta?.filename || `file-${checksum.slice(0, 8)}`;
      const sizeStr = meta ? formatBlobSize(meta.size) : "";
      a.innerHTML = `📄 ${escapeHtml(name)}${sizeStr ? ` <span class="file-size">(${sizeStr})</span>` : ""}`;
      a.style.cursor = "pointer";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        loadBlobUrl(db, book.vaultId, checksum, book.encKey!).then((url) => {
          if (url) showAssetOverlay(url, meta?.mimeType === "application/pdf" ? "pdf" : "image");
        });
      });
    });
  });
}

function formatBlobSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Simple overlay for viewing images and PDFs full-screen. */
function showAssetOverlay(url: string, type: "image" | "pdf") {
  const overlay = document.createElement("div");
  overlay.className = "asset-overlay";
  overlay.innerHTML = `<button class="asset-overlay-close" title="Close">&times;</button>`;

  if (type === "pdf") {
    const iframe = document.createElement("iframe");
    iframe.src = url;
    overlay.appendChild(iframe);
  } else {
    const img = document.createElement("img");
    img.src = url;
    overlay.appendChild(img);
  }

  const close = () => overlay.remove();
  overlay.querySelector(".asset-overlay-close")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", function handler(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", handler); }
  });

  document.body.appendChild(overlay);
}
