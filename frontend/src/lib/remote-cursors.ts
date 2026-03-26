/**
 * Remote cursor decorations for CodeMirror — reusable across projects.
 *
 * Shows colored cursors and selection highlights for other users
 * editing the same document.
 */

import { EditorView, Decoration, type DecorationSet, WidgetType } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";

// ── Types ──

export interface RemoteCursor {
  deviceId: string;
  /** Display name or short label */
  name: string;
  /** CSS color for this cursor */
  color: string;
  /** Cursor position (character offset) */
  head: number;
  /** Selection anchor (same as head if no selection) */
  anchor: number;
  /** Which todo's notes this cursor is in */
  todoId: string;
}

// ── Colors for up to 8 remote users ──
const CURSOR_COLORS = [
  "#e94560", "#f0a500", "#4ecca3", "#7b68ee",
  "#ff6b6b", "#48dbfb", "#ff9ff3", "#feca57",
];

let colorIndex = 0;
const deviceColors = new Map<string, string>();

function getColor(deviceId: string): string {
  if (!deviceColors.has(deviceId)) {
    deviceColors.set(deviceId, CURSOR_COLORS[colorIndex % CURSOR_COLORS.length]!);
    colorIndex++;
  }
  return deviceColors.get(deviceId)!;
}

// ── Cursor widget ──

class CursorWidget extends WidgetType {
  constructor(readonly color: string, readonly name: string) { super(); }

  toDOM(): HTMLElement {
    const cursor = document.createElement("span");
    cursor.className = "cm-remote-cursor";
    cursor.style.borderLeftColor = this.color;

    const label = document.createElement("span");
    label.className = "cm-remote-cursor-label";
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    cursor.appendChild(label);

    return cursor;
  }

  override eq(other: CursorWidget): boolean {
    return this.color === other.color && this.name === other.name;
  }
}

// ── State effect to update remote cursors ──

const setCursors = StateEffect.define<RemoteCursor[]>();

// ── State field holding cursor decorations ──

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

    // Cursor line
    decorations.push({
      from: head,
      decoration: Decoration.widget({
        widget: new CursorWidget(cursor.color, cursor.name),
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
          decoration: Decoration.mark({
            class: "cm-remote-selection",
            attributes: {
              style: `background-color: ${cursor.color}33`,
            },
          }),
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

// ── CSS for remote cursors (injected once) ──

const cursorStyles = EditorView.baseTheme({
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
  },
});

// ── Public API ──

/** CodeMirror extension — include this in your editor extensions. */
export const remoteCursorsExtension = [remoteCursorField, cursorStyles];

/**
 * Update remote cursor positions in the editor.
 * Call this when presence data arrives from other devices.
 */
export function updateRemoteCursors(view: EditorView, cursors: RemoteCursor[]): void {
  // Assign colors
  for (const c of cursors) {
    c.color = getColor(c.deviceId);
  }
  view.dispatch({ effects: setCursors.of(cursors) });
}

/**
 * Get a short display name from a device ID (first 4 chars).
 */
export function shortDeviceName(deviceId: string): string {
  return deviceId.slice(0, 4);
}
