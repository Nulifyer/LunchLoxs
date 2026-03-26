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
const addIngredientBtn = document.getElementById("add-ingredient-btn") as HTMLButtonElement;
const ingredientForm = document.getElementById("ingredient-form") as HTMLFormElement;
const ingQtyInput = document.getElementById("ing-qty") as HTMLInputElement;
const ingUnitInput = document.getElementById("ing-unit") as HTMLInputElement;
const ingItemInput = document.getElementById("ing-item") as HTMLInputElement;

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
let remoteCursors = new Map<string, RemoteCursor>();
let onPushSnapshot: (() => void) | null = null;
let onSendPresence: ((data: any) => void) | null = null;
let canEdit = true;

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

  addIngredientBtn.addEventListener("click", () => {
    if (!pageEditing) setPageEditing(true);
    const showing = ingredientForm.classList.contains("open");
    ingredientForm.classList.toggle("open", !showing);
    if (!showing) ingItemInput.focus();
  });

  ingredientForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!store) return;
    const item = ingItemInput.value.trim();
    if (!item) return;
    store.change((doc) => {
      if (!doc.ingredients) doc.ingredients = [];
      doc.ingredients.push({ item, quantity: ingQtyInput.value.trim(), unit: ingUnitInput.value.trim() });
    });
    ingQtyInput.value = "";
    ingUnitInput.value = "";
    ingItemInput.value = "";
    ingItemInput.focus();
    onPushSnapshot?.();
  });

  ingredientsList.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-delete-ing]") as HTMLElement;
    if (!btn || !store) return;
    const idx = parseInt(btn.dataset.deleteIng!);
    store.change((doc) => {
      if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
        doc.ingredients.splice(idx, 1);
      }
    });
    onPushSnapshot?.();
  });

  ingredientsList.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.ingIdx || !input.dataset.ingField || !store) return;
    const idx = parseInt(input.dataset.ingIdx);
    const field = input.dataset.ingField as "quantity" | "unit" | "item";
    store.change((doc) => {
      if (doc.ingredients && idx >= 0 && idx < doc.ingredients.length) {
        doc.ingredients[idx]![field] = input.value;
      }
    });
    onPushSnapshot?.();
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

export function openRecipe(recipeStore: AutomergeStore<RecipeContent>, title: string, meta: string, editable = true, updatedAt?: number, bookName?: string) {
  closeRecipe();
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
  ingredientForm.classList.remove("open");
  ingredientForm.reset();

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
          onSendPresence?.({ field: "instructions", head: sel.head, anchor: sel.anchor });
        }
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
      EditorView.lineWrapping, nBridge.extension,
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
      if (instrEditorView) {
        const sel = instrEditorView.state.selection.main;
        onSendPresence?.({ field: "instructions", head: sel.head, anchor: sel.anchor });
      }
      for (const [, cursor] of remoteCursors) {
        cursor.head = instrBridge!.mapPosition(cursor.head);
        cursor.anchor = instrBridge!.mapPosition(cursor.anchor);
      }
      if (remoteCursors.size > 0 && instrEditorView) {
        updateRemoteCursors(instrEditorView, Array.from(remoteCursors.values()));
      }
    } else {
      renderPreviews();
    }
  });
}

export function closeRecipe() {
  instrEditorView?.destroy();
  instrEditorView = null;
  instrBridge = null;
  notesEditorView?.destroy();
  notesEditorView = null;
  notesBridge = null;
  store = null;
  pageEditing = false;
  remoteCursors.clear();
  detailView.hidden = true;
  emptyState.hidden = false;
}

export function handlePresence(deviceId: string, data: any) {
  if (!instrEditorView || !data.field) return;
  if (data.field === "instructions") {
    const head = instrBridge ? instrBridge.mapPosition(data.head ?? 0) : (data.head ?? 0);
    const anchor = instrBridge ? instrBridge.mapPosition(data.anchor ?? 0) : (data.anchor ?? 0);
    remoteCursors.set(deviceId, {
      deviceId, name: shortDeviceName(deviceId), color: "",
      head, anchor, todoId: "",
    });
    updateRemoteCursors(instrEditorView, Array.from(remoteCursors.values()));
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

  addIngredientBtn.hidden = !editing;
  if (!editing) {
    ingredientForm.classList.remove("open");
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

function renderIngredients(doc: RecipeContent) {
  const ingredients = doc.ingredients ?? [];
  if (ingredients.length === 0) {
    ingredientsList.innerHTML = pageEditing
      ? "<li><em>No ingredients yet. Click + Add.</em></li>"
      : "<li><em>No ingredients.</em></li>";
    return;
  }

  if (pageEditing) {
    const focused = document.activeElement as HTMLInputElement | null;
    const focusKey = focused?.dataset.ingIdx && focused?.dataset.ingField
      ? `${focused.dataset.ingIdx}:${focused.dataset.ingField}` : null;
    const focusPos = focused?.selectionStart ?? 0;

    ingredientsList.innerHTML = ingredients
      .map((ing, i) => `<li>
        <input class="ing-edit ing-qty" data-ing-idx="${i}" data-ing-field="quantity" value="${escapeAttr(ing.quantity)}" placeholder="qty" />
        <input class="ing-edit ing-unit" data-ing-idx="${i}" data-ing-field="unit" value="${escapeAttr(ing.unit)}" placeholder="unit" />
        <input class="ing-edit ing-text" data-ing-idx="${i}" data-ing-field="item" value="${escapeAttr(ing.item)}" placeholder="ingredient" />
        <button data-delete-ing="${i}" title="Remove">&times;</button>
      </li>`)
      .join("");

    if (focusKey) {
      const [idx, field] = focusKey.split(":");
      const el = ingredientsList.querySelector(`[data-ing-idx="${idx}"][data-ing-field="${field}"]`) as HTMLInputElement;
      if (el) { el.focus(); el.setSelectionRange(focusPos, focusPos); }
    }
  } else {
    ingredientsList.innerHTML = ingredients
      .map((ing) => `<li>
        <span class="ing-qty">${escapeHtml(ing.quantity)}</span>
        <span class="ing-unit">${escapeHtml(ing.unit)}</span>
        <span class="ing-text">${escapeHtml(ing.item)}</span>
      </li>`)
      .join("");
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
