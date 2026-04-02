/**
 * CodeMirror extension that renders inline image previews above blob image lines.
 *
 * Scans for ![alt](blob:checksum) or ![alt|width](blob:checksum) patterns and
 * shows a block widget with the decrypted image above each matching line.
 *
 * Uses a StateField (not ViewPlugin) because block decorations require it.
 */

import { EditorView, Decoration, type DecorationSet, WidgetType } from "@codemirror/view";
import { StateField, StateEffect, type EditorState } from "@codemirror/state";

const IMAGE_RE = /!\[([^\]]*)\]\(blob:([a-f0-9]+)\)/g;

type BlobResolver = (checksum: string) => Promise<string | null>;

class ImagePreviewWidget extends WidgetType {
  constructor(
    readonly checksum: string,
    readonly alt: string,
    readonly width: number | null,
    readonly resolver: BlobResolver,
  ) {
    super();
  }

  override eq(other: ImagePreviewWidget): boolean {
    return this.checksum === other.checksum && this.width === other.width;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-image-preview";

    const img = document.createElement("img");
    img.alt = this.alt;
    if (this.width) img.style.width = `${this.width}px`;
    img.className = "cm-image-preview-img";
    wrap.appendChild(img);

    this.resolver(this.checksum).then((url) => {
      if (url) {
        img.src = url;
      } else {
        wrap.textContent = `[image not found]`;
      }
    });

    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState, resolver: BlobResolver): DecorationSet {
  const widgets: Array<{ pos: number; widget: ImagePreviewWidget }> = [];

  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    IMAGE_RE.lastIndex = 0;
    let match;
    while ((match = IMAGE_RE.exec(line.text)) !== null) {
      const altFull = match[1] ?? "";
      const checksum = match[2] ?? "";
      if (!checksum) continue;

      let alt = altFull;
      let width: number | null = null;
      const pipeIdx = altFull.lastIndexOf("|");
      if (pipeIdx > 0) {
        const w = parseInt(altFull.slice(pipeIdx + 1));
        if (!isNaN(w) && w > 0) {
          alt = altFull.slice(0, pipeIdx);
          width = w;
        }
      }

      widgets.push({
        pos: line.from,
        widget: new ImagePreviewWidget(checksum, alt, width, resolver),
      });
    }
  }

  return Decoration.set(
    widgets.map((w) =>
      Decoration.widget({ widget: w.widget, block: true, side: -1 }).range(w.pos),
    ),
  );
}

/**
 * Create a CM extension that shows image previews above blob image lines.
 * @param resolver — async function that takes a checksum and returns an object URL or null
 */
export function imagePreviewExtension(resolver: BlobResolver) {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, resolver);
    },
    update(decorations, tr) {
      if (!tr.docChanged) return decorations;
      return buildDecorations(tr.state, resolver);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
