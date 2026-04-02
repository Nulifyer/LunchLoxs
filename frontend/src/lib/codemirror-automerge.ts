/**
 * CodeMirror ↔ Automerge text bridge — reusable across projects.
 *
 * Syncs a CodeMirror editor with an Automerge text field.
 * Local edits → Automerge splice. Remote Automerge changes → CodeMirror dispatch.
 * Returns the last applied ChangeSet so cursor positions can be mapped through it.
 */

import { EditorView } from "@codemirror/view";
import { Transaction, type ChangeSpec, ChangeSet } from "@codemirror/state";

export interface AutomergeMirrorOptions<T> {
  getDoc: () => T;
  getText: (doc: T) => string;
  spliceText: (from: number, deleteCount: number, insert: string) => void;
  onLocalChange?: () => void;
}

export function createAutomergeMirror<T>(opts: AutomergeMirrorOptions<T>) {
  let view: EditorView | null = null;
  let suppressNext = false;
  let lastRemoteChangeSet: ChangeSet | null = null;

  const extension = EditorView.updateListener.of((update) => {
    view = update.view;
    if (suppressNext || !update.docChanged) return;

    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const deleteCount = toA - fromA;
      const insertText = inserted.toString();
      opts.spliceText(fromA, deleteCount, insertText);
    });

    opts.onLocalChange?.();
  });

  function applyRemoteText() {
    if (!view) return;
    const remoteText = opts.getText(opts.getDoc());
    const currentText = view.state.doc.toString();

    if (remoteText === currentText) {
      lastRemoteChangeSet = null;
      return;
    }

    const changes = diffToChanges(currentText, remoteText);
    if (changes.length === 0) {
      lastRemoteChangeSet = null;
      return;
    }

    suppressNext = true;
    const changeSet = ChangeSet.of(changes, currentText.length);
    lastRemoteChangeSet = changeSet;
    view.dispatch({
      changes: changeSet,
      annotations: [Transaction.remote.of(true)],
    });
    suppressNext = false;
  }

  /**
   * Map a cursor position through the last remote text change.
   * Use this to adjust remote cursor positions after applying remote edits.
   * Returns the original position if no mapping is needed.
   */
  function mapPosition(pos: number): number {
    if (!lastRemoteChangeSet) return pos;
    try {
      return lastRemoteChangeSet.mapPos(pos, 1); // bias forward
    } catch {
      // Position out of range for the changeset — return clamped to doc length
      return view ? Math.min(pos, view.state.doc.length) : pos;
    }
  }

  /** Set the EditorView reference (call after creating the EditorView). */
  function setView(v: EditorView) { view = v; }

  return { extension, applyRemoteText, mapPosition, setView };
}

function diffToChanges(
  oldText: string,
  newText: string,
): Array<ChangeSpec> {
  let prefixLen = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }

  let oldSuffix = oldText.length;
  let newSuffix = newText.length;
  while (
    oldSuffix > prefixLen &&
    newSuffix > prefixLen &&
    oldText[oldSuffix - 1] === newText[newSuffix - 1]
  ) {
    oldSuffix--;
    newSuffix--;
  }

  if (prefixLen === oldSuffix && prefixLen === newSuffix) return [];

  return [{
    from: prefixLen,
    to: oldSuffix,
    insert: newText.slice(prefixLen, newSuffix),
  }];
}
