import { EditorView } from "@codemirror/view";
import { escapeHtml } from "../../lib/html";
import { processAsset, AssetError } from "../../lib/asset-processing";
import { storeBlob, loadBlobUrl, loadBlobMeta, revokeObjectUrls } from "../../lib/blob-client";
import { getActiveBook, getDocMgr } from "../../state";
import { getStore, getPushSnapshotFn } from "./state";

const instrPreviewContainer = document.getElementById("preview-container") as HTMLElement;

/** Handle image/asset paste or drop into a CodeMirror editor. */
export function handleAssetFiles(files: File[], view: EditorView, pos: number): boolean {
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
        getPushSnapshotFn()?.();
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
export function assetDomHandlers(getView: () => EditorView | null) {
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

/** Extract width from ![alt|NNN](src) syntax, strip it for marked, return a map of alt->width. */
export function extractImageWidths(md: string): { cleaned: string; widths: Map<string, number> } {
  const widths = new Map<string, number>();
  const cleaned = md.replace(/!\[([^\]|]*)\|(\d+)\]\(/g, (_match, alt: string, w: string) => {
    widths.set(alt, parseInt(w));
    return `![${alt}](`;
  });
  return { cleaned, widths };
}

/** Apply stored widths to <img> elements by matching alt text. */
export function applyImageWidths(container: HTMLElement, widths: Map<string, number>) {
  if (widths.size === 0) return;
  container.querySelectorAll("img").forEach((img) => {
    const alt = img.getAttribute("alt") ?? "";
    const w = widths.get(alt);
    if (w) img.style.width = `${w}px`;
  });
}

/** Write image width back into markdown as ![alt|NNN](blob:checksum). */
export function persistImageWidth(field: "instructions" | "notes", alt: string, checksum: string, width: number) {
  const store = getStore();
  if (!store) return;
  const doc = store.getDoc();
  const text = field === "instructions" ? doc.instructions : doc.notes;
  if (!text) return;

  // Match ![alt](blob:checksum) or ![alt|OLDpx](blob:checksum)
  const escaped = alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`!\\[${escaped}(?:\\|\\d+)?\\]\\(blob:${checksum}\\)`);
  const replacement = `![${alt}|${width}](blob:${checksum})`;

  const updated = text.replace(pattern, replacement);
  if (updated === text) return;

  store.change((d) => {
    if (field === "instructions") d.instructions = updated;
    else d.notes = updated;
  });
  getPushSnapshotFn()?.();
}

/** Find blob: references in rendered HTML and load/decrypt them. */
export function resolveBlobAssets(container: HTMLElement) {
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

        // Persist width on resize
        const alt = img.getAttribute("alt") ?? "";
        if (alt && checksum) {
          const field = container === instrPreviewContainer ? "instructions" : "notes";
          let resizeTimer: ReturnType<typeof setTimeout> | null = null;
          new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              const w = Math.round(img.getBoundingClientRect().width);
              if (w > 0 && getStore()) {
                persistImageWidth(field, alt, checksum, w);
              }
            }, 300);
          }).observe(img);
        }
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

export function formatBlobSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Simple overlay for viewing images and PDFs full-screen. */
export function showAssetOverlay(url: string, type: "image" | "pdf") {
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
