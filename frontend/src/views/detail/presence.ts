import { updateRemoteCursors, shortDeviceName, type RemoteCursor } from "../../lib/remote-cursors";
import {
  getInstrEditorView, getNotesEditorView,
  getInstrBridge, getNotesBridge,
  getSendPresenceFn,
} from "./state";

let instrCursors = new Map<string, RemoteCursor>();
let notesCursors = new Map<string, RemoteCursor>();
let cursorFadeTimer: ReturnType<typeof setInterval> | null = null;
let presenceFallbackTimer: ReturnType<typeof setTimeout> | null = null;

export function getInstrCursors() { return instrCursors; }
export function getNotesCursors() { return notesCursors; }

/** Periodically refresh cursor decorations so stale cursors fade and disappear. */
export function scheduleCursorFade() {
  if (cursorFadeTimer) return; // already running
  cursorFadeTimer = setInterval(() => {
    const now = Date.now();
    const instrEditorView = getInstrEditorView();
    const notesEditorView = getNotesEditorView();
    // Remove fully faded cursors (>10s stale)
    for (const [key, c] of instrCursors) {
      if (now - c.lastSeen > 10_000) instrCursors.delete(key);
    }
    for (const [key, c] of notesCursors) {
      if (now - c.lastSeen > 10_000) notesCursors.delete(key);
    }
    // Refresh decorations to update opacity
    if (instrEditorView && instrCursors.size > 0) {
      updateRemoteCursors(instrEditorView, Array.from(instrCursors.values()));
    }
    if (notesEditorView && notesCursors.size > 0) {
      updateRemoteCursors(notesEditorView, Array.from(notesCursors.values()));
    }
    // Stop timer when no cursors remain
    if (instrCursors.size === 0 && notesCursors.size === 0) {
      clearInterval(cursorFadeTimer!);
      cursorFadeTimer = null;
      // Clear decorations one last time
      if (instrEditorView) updateRemoteCursors(instrEditorView, []);
      if (notesEditorView) updateRemoteCursors(notesEditorView, []);
    }
  }, 1000);
}

/**
 * Stage cursor data to ride with the next text push.
 * Starts a fallback timer so selection-only moves (no text change)
 * still send a standalone presence after 500ms.
 */
export function queuePresence(data: any) {
  const onSendPresence = getSendPresenceFn();
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
export function sendPresenceNow(data: any) {
  const onSendPresence = getSendPresenceFn();
  if (presenceFallbackTimer) { clearTimeout(presenceFallbackTimer); presenceFallbackTimer = null; }
  onSendPresence?.(data);
}

export function getPresenceFallbackTimer() { return presenceFallbackTimer; }
export function clearPresenceFallbackTimer() {
  if (presenceFallbackTimer) { clearTimeout(presenceFallbackTimer); presenceFallbackTimer = null; }
}

export function handlePresence(deviceId: string, data: any, senderUserId?: string) {
  if (!data.field) return;
  const cursorKey = senderUserId ? `${senderUserId}:${deviceId}` : deviceId;
  const instrEditorView = getInstrEditorView();
  const notesEditorView = getNotesEditorView();
  const instrBridge = getInstrBridge();
  const notesBridge = getNotesBridge();

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
    const docLen = instrEditorView.state.doc.length;
    const clampedHead = Math.min(head, docLen);
    const clampedAnchor = Math.min(anchor, docLen);
    const mappedHead = instrBridge ? instrBridge.mapPosition(clampedHead) : clampedHead;
    const mappedAnchor = instrBridge ? instrBridge.mapPosition(clampedAnchor) : clampedAnchor;
    // Remove from notes if they moved to instructions
    notesCursors.delete(cursorKey);
    if (notesEditorView) updateRemoteCursors(notesEditorView, Array.from(notesCursors.values()));
    instrCursors.set(cursorKey, {
      deviceId: cursorKey, name,
      head: mappedHead, anchor: mappedAnchor, todoId: "instructions",
      lastSeen: Date.now(),
    });
    updateRemoteCursors(instrEditorView, Array.from(instrCursors.values()));
    scheduleCursorFade();
  } else if (data.field === "notes" && notesEditorView) {
    const docLen = notesEditorView.state.doc.length;
    const clampedHead = Math.min(head, docLen);
    const clampedAnchor = Math.min(anchor, docLen);
    const mappedHead = notesBridge ? notesBridge.mapPosition(clampedHead) : clampedHead;
    const mappedAnchor = notesBridge ? notesBridge.mapPosition(clampedAnchor) : clampedAnchor;
    // Remove from instructions if they moved to notes
    instrCursors.delete(cursorKey);
    if (instrEditorView) updateRemoteCursors(instrEditorView, Array.from(instrCursors.values()));
    notesCursors.set(cursorKey, {
      deviceId: cursorKey, name,
      head: mappedHead, anchor: mappedAnchor, todoId: "notes",
      lastSeen: Date.now(),
    });
    updateRemoteCursors(notesEditorView, Array.from(notesCursors.values()));
    scheduleCursorFade();
  }
}

export function clearCursorState() {
  instrCursors.clear();
  notesCursors.clear();
  if (cursorFadeTimer) { clearInterval(cursorFadeTimer); cursorFadeTimer = null; }
}
