/**
 * Recipe detail view with unified edit/preview mode.
 */

import type { RecipeContent } from "../types";
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
import { convertIngredient, convertToUnit, resolveUnit, getConversionTargets, type UnitSystem } from "../lib/units";
import { findDensity, volumeToWeight, weightToVolume } from "../lib/densities";

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
const metaEl = document.getElementById("recipe-meta") as HTMLElement;
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
let store: AutomergeStore<RecipeContent> | null = null;
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
  onPushSnapshot: () => void;
  onSendPresence: (data: any) => void;
  onEditRecipe: () => void;
  onDeleteRecipe: () => void;
  onExportRecipe?: () => void;
  onCopyToBook?: () => void;
}

let callbacks: DetailCallbacks;

export function initRecipeDetail(cb: DetailCallbacks) {
  callbacks = cb;
  backBtn.addEventListener("click", cb.onBack);
  onPushSnapshot = cb.onPushSnapshot;
  onSendPresence = cb.onSendPresence;

  pageEditBtn.addEventListener("click", () => setPageEditing(!pageEditing));

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

  });

  // -- Per-ingredient unit picker (right-click / long-press) --
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressTarget: HTMLElement | null = null;

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
      entries.push({ qty: converted.qty, label: `${formatQty(converted.qty)} ${t.label}`, overrideKey: t.unit, group: t.system });
    }

    // Density-based cross-dimension conversions (volume <-> weight)
    const unitDef = resolveUnit(rawUnit);
    const density = findDensity(itemName);
    if (density && unitDef && scaledNum !== null) {
      const isVolume = unitDef.dimension === "volume";
      if (isVolume) {
        const volumeMl = scaledNum * unitDef.toBase;
        const grams = volumeToWeight(volumeMl, density);
        for (const [unit, divisor] of [["g", 1], ["kg", 1000], ["oz", 28.3495], ["lb", 453.592]] as const) {
          const val = Math.round(grams / divisor * 10) / 10;
          if (val < 0.1 || val > 999) continue;
          entries.push({ qty: val, label: `~${formatQty(val)} ${unit}`, overrideKey: `~${unit}`, group: "density" });
        }
      } else {
        const grams = scaledNum * unitDef.toBase;
        const volumeMl = weightToVolume(grams, density);
        for (const [unit, divisor] of [["tsp", 4.929], ["tbsp", 14.787], ["cup", 236.588], ["ml", 1], ["l", 1000]] as const) {
          const val = Math.round(volumeMl / divisor * 10) / 10;
          if (val < 0.1 || val > 999) continue;
          entries.push({ qty: val, label: `~${formatQty(val)} ${unit}`, overrideKey: `~${unit}`, group: "density" });
        }
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
      groupLabel.textContent = GROUP_LABELS[group];
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

  // Right-click on unit span
  ingredientsList.addEventListener("contextmenu", (e) => {
    if (pageEditing) return;
    const target = e.target as HTMLElement;
    const unitSpan = target.closest(".ing-unit") as HTMLElement;
    if (!unitSpan) return;
    const li = unitSpan.closest("li") as HTMLElement;
    const rawUnit = li?.dataset.origUnit;
    if (!rawUnit || !resolveUnit(rawUnit)) return;
    e.preventDefault();
    showUnitPicker(unitSpan, e.clientX, e.clientY);
  });

  // Long-press on unit span (mobile)
  ingredientsList.addEventListener("pointerdown", (e) => {
    if (pageEditing) return;
    const target = e.target as HTMLElement;
    const unitSpan = target.closest(".ing-unit") as HTMLElement;
    if (!unitSpan) return;
    const li = unitSpan.closest("li") as HTMLElement;
    const rawUnit = li?.dataset.origUnit;
    if (!rawUnit || !resolveUnit(rawUnit)) return;

    longPressTarget = unitSpan;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      showUnitPicker(unitSpan, e.clientX, e.clientY);
    }, 500);
  });

  ingredientsList.addEventListener("pointerup", () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    longPressTarget = null;
  });

  ingredientsList.addEventListener("pointermove", (e) => {
    if (longPressTimer && longPressTarget) {
      // Cancel if finger moves too far
      const t = longPressTarget.getBoundingClientRect();
      const dx = e.clientX - (t.left + t.width / 2);
      const dy = e.clientY - (t.top + t.height / 2);
      if (Math.sqrt(dx * dx + dy * dy) > 20) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        longPressTarget = null;
      }
    }
  });

  ingredientsList.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.ingField || !store) return;

    // Ghost row input
    if (input.dataset.ghost) return;

    const idx = parseInt(input.dataset.ingIdx ?? "-1");
    if (idx < 0) return;
    const field = input.dataset.ingField as "quantity" | "unit" | "item";
    store.change((doc) => {
      if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
        doc.ingredients[idx]![field] = input.value;
      }
    });
    onPushSnapshot?.();
  });

  // Ghost row: commit on Enter
  ingredientsList.addEventListener("keydown", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.ghost || e.key !== "Enter") return;
    e.preventDefault();
    commitGhostRow();
  });

  // Ghost row: commit on blur of item field if it has a value
  ingredientsList.addEventListener("focusout", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.ghost || input.dataset.ingField !== "item") return;
    // Delay slightly so clicking another ghost field doesn't trigger
    setTimeout(() => {
      const ghostLi = ingredientsList.querySelector(".ing-ghost");
      if (ghostLi && !ghostLi.contains(document.activeElement)) {
        commitGhostRow();
      }
    }, 50);
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
    else if (action === "reset") { currentServings = baseServings; checkedIngredients.clear(); }
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

export function openRecipe(recipeStore: AutomergeStore<RecipeContent>, title: string, meta: string, editable = true, updatedAt?: number, bookName?: string, servings?: number) {
  closeRecipe();
  // Reset ingredient UI state
  checkedIngredients.clear();
  unitOverrides.clear();
  baseServings = servings ?? 4;
  currentServings = baseServings;
  scaleFactor = 1;
  store = recipeStore;
  titleEl.textContent = title;
  // Update breadcrumb
  const breadcrumbBookName = document.getElementById("breadcrumb-book-name") as HTMLElement;
  if (breadcrumbBookName) breadcrumbBookName.textContent = bookName ?? "";
  metaEl.innerHTML = "";
  const metaText = document.createElement("span");
  metaText.textContent = meta;
  metaEl.appendChild(metaText);
  if (updatedAt && updatedAt > 0) {
    if (meta) metaEl.appendChild(document.createTextNode(" · "));
    const ago = document.createElement("span");
    ago.textContent = "updated " + timeAgo(updatedAt);
    ago.title = new Date(updatedAt).toLocaleString();
    ago.style.cursor = "default";
    metaEl.appendChild(ago);
  }
  canEdit = editable;
  emptyState.hidden = true;
  detailView.hidden = false;
  // Edit button for viewers is hidden
  pageEditBtn.hidden = !canEdit;

  // Build actions dropdown
  actionsSlot.innerHTML = "";
  const menuItems = [];
  if (canEdit) {
    menuItems.push({ label: "Settings", action: () => callbacks.onEditRecipe() });
  }
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

  const iBridge = createAutomergeMirror<RecipeContent>({
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

  const nBridge = createAutomergeMirror<RecipeContent>({
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
  store = null;
  pageEditing = false;
  instrCursors.clear();
  notesCursors.clear();
  checkedIngredients.clear();
  unitOverrides.clear();
  scaleFactor = 1;
  scaleBar.hidden = true;
  detailView.hidden = true;
  emptyState.hidden = false;
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

// -- Page-level edit/preview toggle --

function setPageEditing(editing: boolean) {
  if (!canEdit && editing) return;
  pageEditing = editing;
  detailView.classList.toggle("editing", editing);
  pageEditBtn.textContent = editing ? "Done" : "Edit";

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

  renderIngredients(store?.getDoc() ?? { description: "", ingredients: [], instructions: "", imageUrls: [], notes: "" });
}

// -- Render --

function commitGhostRow() {
  if (!store) return;
  const ghostLi = ingredientsList.querySelector(".ing-ghost");
  if (!ghostLi) return;
  const qtyIn = ghostLi.querySelector("[data-ing-field='quantity']") as HTMLInputElement;
  const unitIn = ghostLi.querySelector("[data-ing-field='unit']") as HTMLInputElement;
  const itemIn = ghostLi.querySelector("[data-ing-field='item']") as HTMLInputElement;
  const item = itemIn?.value.trim();
  if (!item) return;
  store.change((doc) => {
    if (!doc.ingredients) doc.ingredients = [];
    doc.ingredients.push({ item, quantity: qtyIn?.value.trim() ?? "", unit: unitIn?.value.trim() ?? "" });
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

function scaleQtyHtml(raw: string): string {
  return escapeHtml(scaleQty(raw, scaleFactor));
}

function renderIngredients(doc: RecipeContent) {
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
          <input class="ing-edit ing-text" data-ing-idx="${i}" data-ing-field="item" value="${escapeAttr(ing.item)}" placeholder="ingredient" />
          <button data-delete-ing="${i}" title="Remove">&times;</button>
        </li>`)
        .join("");
    }
    // Ghost row for adding
    html += `<li class="ing-ghost">
      <span class="ing-drag-handle" style="visibility:hidden">&#x283F;</span>
      <input class="ing-edit ing-qty" data-ghost="true" data-ing-field="quantity" value="" placeholder="qty" />
      <input class="ing-edit ing-unit" data-ghost="true" data-ing-field="unit" value="" placeholder="unit" />
      <input class="ing-edit ing-text" data-ghost="true" data-ing-field="item" value="" placeholder="add ingredient..." />
    </li>`;
    ingredientsList.innerHTML = html;

    // Restore focus
    if (focusKey) {
      const [idx, field] = focusKey.split(":");
      const el = ingredientsList.querySelector(`[data-ing-idx="${idx}"][data-ing-field="${field}"]:not([data-ghost])`) as HTMLInputElement;
      if (el) { el.focus(); el.setSelectionRange(focusPos, focusPos); }
    } else if (ghostFocusField) {
      const el = ingredientsList.querySelector(`.ing-ghost [data-ing-field="${ghostFocusField}"]`) as HTMLInputElement;
      if (el) { el.focus(); el.setSelectionRange(focusPos, focusPos); }
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
              const unitDef = resolveUnit(ing.unit);
              const density = findDensity(ing.item);
              if (unitDef && density) {
                if (unitDef.dimension === "volume") {
                  const volumeMl = scaledNum * unitDef.toBase;
                  const grams = volumeToWeight(volumeMl, density);
                  const targetDef: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
                  const divisor = targetDef[targetUnit];
                  if (divisor) result = { qty: Math.round(grams / divisor * 10) / 10, unit: `~${targetUnit}` };
                } else {
                  const grams = scaledNum * unitDef.toBase;
                  const volumeMl = weightToVolume(grams, density);
                  const targetDef: Record<string, number> = { tsp: 4.929, tbsp: 14.787, cup: 236.588, ml: 1, l: 1000 };
                  const divisor = targetDef[targetUnit];
                  if (divisor) result = { qty: Math.round(volumeMl / divisor * 10) / 10, unit: `~${targetUnit}` };
                }
              }
            } else if (overrideUnit) {
              result = convertToUnit(scaledNum, ing.unit, overrideUnit);
            } else if (unitSystem !== "original") {
              const sys = convertIngredient(scaledNum, ing.unit, unitSystem);
              if (sys.unit !== ing.unit) result = sys;
            }
            if (result) {
              displayQty = escapeHtml(formatQty(result.qty));
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

function renderPreviews() {
  if (!store) return;
  const doc = store.getDoc();
  const instrMd = doc.instructions ?? "";
  const instrHtml = DOMPurify.sanitize(marked.parse(instrMd) as string);
  instrPreviewContainer.innerHTML = instrHtml || "<em>No instructions yet.</em>";
  const notesMd = doc.notes ?? "";
  const notesHtml = DOMPurify.sanitize(marked.parse(notesMd) as string);
  notesPreviewContainer.innerHTML = notesHtml || "<em>No notes yet.</em>";
}
