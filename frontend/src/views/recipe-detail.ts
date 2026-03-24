/**
 * Recipe detail view with CodeMirror markdown editor.
 */

import type { RecipeContent } from "../types";
import { AutomergeStore } from "../lib/automerge-store";
import { createAutomergeMirror } from "../lib/codemirror-automerge";
import { remoteCursorsExtension, updateRemoteCursors, shortDeviceName, type RemoteCursor } from "../lib/remote-cursors";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { marked } from "marked";

const detailView = document.getElementById("recipe-detail") as HTMLElement;
const emptyState = document.getElementById("empty-state") as HTMLElement;
const backBtn = document.getElementById("back-btn") as HTMLButtonElement;
const titleEl = document.getElementById("recipe-title") as HTMLHeadingElement;
const metaEl = document.getElementById("recipe-meta") as HTMLElement;
const ingredientsList = document.getElementById("ingredients-list") as HTMLElement;
const addIngredientBtn = document.getElementById("add-ingredient-btn") as HTMLButtonElement;
const ingredientForm = document.getElementById("ingredient-form") as HTMLFormElement;
const ingQtyInput = document.getElementById("ing-qty") as HTMLInputElement;
const ingUnitInput = document.getElementById("ing-unit") as HTMLInputElement;
const ingItemInput = document.getElementById("ing-item") as HTMLInputElement;
const editorContainer = document.getElementById("editor-container") as HTMLElement;
const previewContainer = document.getElementById("preview-container") as HTMLElement;
const modeToggle = document.getElementById("mode-toggle") as HTMLButtonElement;
const notesEditorContainer = document.getElementById("notes-editor-container") as HTMLElement;
const notesPreviewContainer = document.getElementById("notes-preview-container") as HTMLElement;
const notesModeToggle = document.getElementById("notes-mode-toggle") as HTMLButtonElement;

let store: AutomergeStore<RecipeContent> | null = null;
let editorView: EditorView | null = null;
let editorBridge: ReturnType<typeof createAutomergeMirror> | null = null;
let notesEditorView: EditorView | null = null;
let notesBridge: ReturnType<typeof createAutomergeMirror> | null = null;
let editMode: "edit" | "preview" = "preview";
let notesEditMode: "edit" | "preview" = "preview";
let remoteCursors = new Map<string, RemoteCursor>();
let onPushSnapshot: (() => void) | null = null;
let onSendPresence: ((data: any) => void) | null = null;

export interface DetailCallbacks {
  onBack: () => void;
  onPushSnapshot: () => void;
  onSendPresence: (data: any) => void;
  onEditRecipe: () => void;
  onDeleteRecipe: () => void;
}

const editRecipeBtn = document.getElementById("edit-recipe-btn") as HTMLButtonElement;
const deleteRecipeBtn = document.getElementById("delete-recipe-btn") as HTMLButtonElement;

export function initRecipeDetail(cb: DetailCallbacks) {
  backBtn.addEventListener("click", cb.onBack);
  editRecipeBtn.addEventListener("click", cb.onEditRecipe);
  deleteRecipeBtn.addEventListener("click", cb.onDeleteRecipe);
  onPushSnapshot = cb.onPushSnapshot;
  onSendPresence = cb.onSendPresence;
  modeToggle.addEventListener("click", () => setInstructionsMode(editMode === "edit" ? "preview" : "edit"));
  notesModeToggle.addEventListener("click", () => setNotesMode(notesEditMode === "edit" ? "preview" : "edit"));

  // Ingredient add form toggle
  addIngredientBtn.addEventListener("click", () => {
    const showing = ingredientForm.classList.contains("open");
    ingredientForm.classList.toggle("open", !showing);
    if (!showing) ingItemInput.focus();
  });

  // Add ingredient
  ingredientForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!store) return;
    const item = ingItemInput.value.trim();
    if (!item) return;
    store.change((doc) => {
      if (!doc.ingredients) doc.ingredients = [];
      doc.ingredients.push({
        item,
        quantity: ingQtyInput.value.trim(),
        unit: ingUnitInput.value.trim(),
      });
    });
    ingQtyInput.value = "";
    ingUnitInput.value = "";
    ingItemInput.value = "";
    ingItemInput.focus();
    onPushSnapshot?.();
  });

  // Delete ingredient (event delegation)
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
}

export function openRecipe(recipeStore: AutomergeStore<RecipeContent>, title: string, meta: string) {
  closeRecipe();
  store = recipeStore;
  titleEl.textContent = title;
  metaEl.textContent = meta;
  emptyState.hidden = true;
  detailView.hidden = false;
  ingredientForm.classList.remove("open");
  ingredientForm.reset();

  const doc = store.getDoc();

  // Ingredients
  renderIngredients(doc);

  // Instructions editor
  const instrBridge = createAutomergeMirror<RecipeContent>({
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
  editorBridge = instrBridge;

  editorView = new EditorView({
    doc: doc.instructions ?? "",
    extensions: [
      keymap.of([...defaultKeymap, ...historyKeymap]),
      history(),
      markdown(),
      oneDark,
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      instrBridge.extension,
      remoteCursorsExtension,
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          onSendPresence?.({ field: "instructions", head: sel.head, anchor: sel.anchor });
        }
      }),
    ],
    parent: editorContainer,
  });

  // Notes editor
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
      keymap.of([...defaultKeymap, ...historyKeymap]),
      history(),
      markdown(),
      oneDark,
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      nBridge.extension,
    ],
    parent: notesEditorContainer,
  });

  setInstructionsMode("preview");
  setNotesMode("preview");

  // Listen for remote changes
  store.onChange((doc) => {
    renderIngredients(doc);
    if (editMode === "preview") renderInstructionsPreview();
    else {
      editorBridge?.applyRemoteText();
      // Re-broadcast our cursor position so the other side has accurate positions
      // after the text changed underneath
      if (editorView) {
        const sel = editorView.state.selection.main;
        onSendPresence?.({ field: "instructions", head: sel.head, anchor: sel.anchor });
      }
      // Also remap any existing remote cursors through the text change
      for (const [id, cursor] of remoteCursors) {
        cursor.head = editorBridge!.mapPosition(cursor.head);
        cursor.anchor = editorBridge!.mapPosition(cursor.anchor);
      }
      if (remoteCursors.size > 0 && editorView) {
        updateRemoteCursors(editorView, Array.from(remoteCursors.values()));
      }
    }
    if (notesEditMode === "preview") renderNotesPreview();
    else notesBridge?.applyRemoteText();
  });
}

export function closeRecipe() {
  editorView?.destroy();
  editorView = null;
  editorBridge = null;
  notesEditorView?.destroy();
  notesEditorView = null;
  notesBridge = null;
  store = null;
  remoteCursors.clear();
  detailView.hidden = true;
  emptyState.hidden = false;
}

export function handlePresence(deviceId: string, data: any) {
  if (!editorView || !data.field) return;
  if (data.field === "instructions") {
    // Map incoming cursor positions through any pending remote text changes
    const head = editorBridge ? editorBridge.mapPosition(data.head ?? 0) : (data.head ?? 0);
    const anchor = editorBridge ? editorBridge.mapPosition(data.anchor ?? 0) : (data.anchor ?? 0);
    remoteCursors.set(deviceId, {
      deviceId,
      name: shortDeviceName(deviceId),
      color: "",
      head,
      anchor,
      todoId: "",
    });
    updateRemoteCursors(editorView, Array.from(remoteCursors.values()));
  }
}

export function isOpen(): boolean {
  return store !== null;
}

function renderIngredients(doc: RecipeContent) {
  const ingredients = doc.ingredients ?? [];
  if (ingredients.length === 0) {
    ingredientsList.innerHTML = "<li><em>No ingredients yet. Click + Add above.</em></li>";
    return;
  }
  ingredientsList.innerHTML = ingredients
    .map((ing, i) => `<li>
      <span class="ing-qty">${escapeHtml(ing.quantity)}</span>
      <span class="ing-unit">${escapeHtml(ing.unit)}</span>
      <span class="ing-text">${escapeHtml(ing.item)}</span>
      <button data-delete-ing="${i}" title="Remove">&times;</button>
    </li>`)
    .join("");
}

function setInstructionsMode(mode: "edit" | "preview") {
  editMode = mode;
  if (mode === "edit") {
    editorBridge?.applyRemoteText();
    editorContainer.hidden = false;
    previewContainer.hidden = true;
    modeToggle.textContent = "Preview";
  } else {
    renderInstructionsPreview();
    editorContainer.hidden = true;
    previewContainer.hidden = false;
    modeToggle.textContent = "Edit";
  }
}

function setNotesMode(mode: "edit" | "preview") {
  notesEditMode = mode;
  if (mode === "edit") {
    notesBridge?.applyRemoteText();
    notesEditorContainer.hidden = false;
    notesPreviewContainer.hidden = true;
    notesModeToggle.textContent = "Preview";
  } else {
    renderNotesPreview();
    notesEditorContainer.hidden = true;
    notesPreviewContainer.hidden = false;
    notesModeToggle.textContent = "Edit";
  }
}

function renderInstructionsPreview() {
  if (!store) return;
  const md = store.getDoc().instructions ?? "";
  previewContainer.innerHTML = (marked.parse(md) as string) || "<em>No instructions yet. Click Edit to add some.</em>";
}

function renderNotesPreview() {
  if (!store) return;
  const md = store.getDoc().notes ?? "";
  notesPreviewContainer.innerHTML = (marked.parse(md) as string) || "<em>No notes yet.</em>";
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
