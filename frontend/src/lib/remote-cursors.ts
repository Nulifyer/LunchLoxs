/**
 * Remote cursor decorations for CodeMirror.
 *
 * Shows colored cursors and selection highlights for other users
 * editing the same document. Colors come from the active theme.
 */

import { EditorView, Decoration, type DecorationSet, WidgetType } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";

// -- Types --

export interface RemoteCursor {
  deviceId: string;
  /** Display name or short label */
  name: string;
  /** Cursor position (character offset) */
  head: number;
  /** Selection anchor (same as head if no selection) */
  anchor: number;
  /** Which field this cursor is in */
  todoId: string;
  /** Timestamp of last activity (ms since epoch) */
  lastSeen: number;
}

// -- Color slots mapped to theme CSS vars --

const COLOR_VARS = ["--red", "--green", "--purple", "--cyan", "--yellow", "--accent"];

let nextColorIdx = 0;
const deviceColorIdx = new Map<string, number>();

function getColorIndex(deviceId: string): number {
  if (!deviceColorIdx.has(deviceId)) {
    deviceColorIdx.set(deviceId, nextColorIdx % COLOR_VARS.length);
    nextColorIdx++;
  }
  return deviceColorIdx.get(deviceId)!;
}

// -- Cursor widget --

class CursorWidget extends WidgetType {
  constructor(readonly name: string, readonly colorIdx: number, readonly stale: boolean) { super(); }

  toDOM(): HTMLElement {
    const cursor = document.createElement("span");
    cursor.className = `cm-remote-cursor cm-remote-c${this.colorIdx}`;

    const label = document.createElement("span");
    label.className = "cm-remote-cursor-label";
    label.textContent = this.name;
    cursor.appendChild(label);

    // Defer stale class so the initial opacity:1 is painted first and the transition can run
    if (this.stale) requestAnimationFrame(() => label.classList.add("cm-remote-cursor-label-stale"));

    return cursor;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const label = dom.querySelector(".cm-remote-cursor-label");
    if (label) label.classList.toggle("cm-remote-cursor-label-stale", this.stale);
    return true;
  }

  override eq(other: CursorWidget): boolean {
    return this.name === other.name && this.colorIdx === other.colorIdx && this.stale === other.stale;
  }
}

// -- State effect to update remote cursors --

const setCursors = StateEffect.define<RemoteCursor[]>();

// -- State field holding cursor decorations --

const remoteCursorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(cursors, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCursors)) {
        return buildDecorations(effect.value, tr.state.doc.length);
      }
    }
    return cursors.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildDecorations(cursors: RemoteCursor[], docLength: number): DecorationSet {
  const decorations: Array<{ from: number; to?: number; decoration: Decoration }> = [];

  for (const cursor of cursors) {
    const head = Math.min(cursor.head, docLength);
    const anchor = Math.min(cursor.anchor, docLength);
    const ci = getColorIndex(cursor.deviceId);
    const stale = cursor.lastSeen > 0 && (Date.now() - cursor.lastSeen > 5_000);

    // Cursor line
    decorations.push({
      from: head,
      decoration: Decoration.widget({
        widget: new CursorWidget(cursor.name, ci, stale),
        side: 1,
      }),
    });

    // Selection highlight
    if (head !== anchor) {
      const from = Math.min(head, anchor);
      const to = Math.max(head, anchor);
      if (from < to) {
        decorations.push({
          from,
          to,
          decoration: Decoration.mark({ class: `cm-remote-selection cm-remote-c${ci}` }),
        });
      }
    }
  }

  // Sort by position (required by CodeMirror)
  decorations.sort((a, b) => a.from - (b.from ?? 0));

  const builder = decorations.map((d) =>
    d.to !== undefined
      ? d.decoration.range(d.from, d.to)
      : d.decoration.range(d.from)
  );

  return Decoration.set(builder, true);
}

// -- CSS for remote cursors (per-slot colors from theme vars) --

function colorSlotStyles(): Record<string, any> {
  const styles: Record<string, any> = {
    ".cm-remote-cursor": {
      position: "relative",
      borderLeft: "2px solid",
      marginLeft: "-1px",
      marginRight: "-1px",
    },
    ".cm-remote-cursor-label": {
      position: "absolute",
      top: "-1.4em",
      left: "-1px",
      fontSize: "0.7em",
      padding: "0 4px",
      borderRadius: "3px",
      color: "white",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      lineHeight: "1.6",
      opacity: "1",
      transition: "opacity 2s ease",
    },
    ".cm-remote-cursor-label-stale": {
      opacity: "0",
    },
  };
  for (let i = 0; i < COLOR_VARS.length; i++) {
    const v = `var(${COLOR_VARS[i]})`;
    styles[`.cm-remote-cursor.cm-remote-c${i}`] = { borderLeftColor: v };
    styles[`.cm-remote-cursor.cm-remote-c${i} .cm-remote-cursor-label`] = { backgroundColor: v };
    styles[`.cm-remote-selection.cm-remote-c${i}`] = {
      backgroundColor: `color-mix(in srgb, ${v} 20%, transparent)`,
    };
  }
  return styles;
}

const cursorStyles = EditorView.baseTheme(colorSlotStyles());

// -- Public API --

/** CodeMirror extension -- include this in your editor extensions. */
export const remoteCursorsExtension = [remoteCursorField, cursorStyles];

/**
 * Update remote cursor positions in the editor.
 * Call this when presence data arrives from other devices.
 */
export function updateRemoteCursors(view: EditorView, cursors: RemoteCursor[]): void {
  view.dispatch({ effects: setCursors.of(cursors) });
}

/**
 * Get a short display name from a device ID (first 4 chars).
 */
export function shortDeviceName(deviceId: string): string {
  return deviceId.slice(0, 4);
}
