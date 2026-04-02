import type { AutomergeStore } from "../../lib/automerge-store";
import type { Recipe } from "../../types";
import type { EditorView } from "@codemirror/view";
import type { createAutomergeMirror } from "../../lib/codemirror-automerge";
import type { RemoteCursor } from "../../lib/remote-cursors";
import type { UnitSystem } from "../../lib/units";

let store: AutomergeStore<Recipe> | null = null;
let instrEditorView: EditorView | null = null;
let instrBridge: ReturnType<typeof createAutomergeMirror> | null = null;
let notesEditorView: EditorView | null = null;
let notesBridge: ReturnType<typeof createAutomergeMirror> | null = null;
let pageEditing = false;
let canEdit = true;
let scaleFactor = 1;
let baseServings = 4;
let currentServings = 4;
let unitSystem: UnitSystem = (localStorage.getItem("unit-system") as UnitSystem) || "original";
let unitOverrides = new Map<number, string>();
let checkedIngredients = new Set<number>();
let onPushSnapshot: (() => void) | null = null;
let onSendPresence: ((data: any) => void) | null = null;
let currentRecipeId: string | null = null;

// Getters
export function getStore() { return store; }
export function getInstrEditorView() { return instrEditorView; }
export function getInstrBridge() { return instrBridge; }
export function getNotesEditorView() { return notesEditorView; }
export function getNotesBridge() { return notesBridge; }
export function isPageEditing() { return pageEditing; }
export function getCanEdit() { return canEdit; }
export function getScaleFactor() { return scaleFactor; }
export function getBaseServings() { return baseServings; }
export function getCurrentServings() { return currentServings; }
export function getUnitSystem() { return unitSystem; }
export function getUnitOverrides() { return unitOverrides; }
export function getCheckedIngredients() { return checkedIngredients; }
export function getPushSnapshotFn() { return onPushSnapshot; }
export function getSendPresenceFn() { return onSendPresence; }
export function getCurrentRecipeId() { return currentRecipeId; }

// Setters
export function setStore(s: AutomergeStore<Recipe> | null) { store = s; }
export function setInstrEditorView(v: EditorView | null) { instrEditorView = v; }
export function setInstrBridge(b: ReturnType<typeof createAutomergeMirror> | null) { instrBridge = b; }
export function setNotesEditorView(v: EditorView | null) { notesEditorView = v; }
export function setNotesBridge(b: ReturnType<typeof createAutomergeMirror> | null) { notesBridge = b; }
export function setPageEditing(v: boolean) { pageEditing = v; }
export function setCanEdit(v: boolean) { canEdit = v; }
export function setScaleFactor(v: number) { scaleFactor = v; }
export function setBaseServings(v: number) { baseServings = v; }
export function setCurrentServings(v: number) { currentServings = v; }
export function setUnitSystem(v: UnitSystem) { unitSystem = v; localStorage.setItem("unit-system", v); }
export function setUnitOverrides(m: Map<number, string>) { unitOverrides = m; }
export function setCheckedIngredients(s: Set<number>) { checkedIngredients = s; }
export function setPushSnapshotFn(fn: (() => void) | null) { onPushSnapshot = fn; }
export function setSendPresenceFn(fn: ((data: any) => void) | null) { onSendPresence = fn; }
export function setCurrentRecipeId(id: string | null) { currentRecipeId = id; }
