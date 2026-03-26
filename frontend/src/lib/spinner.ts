/**
 * Loading overlay spinner. Shows after a delay so short operations don't flash.
 */

export interface LoadingHandle {
  dismiss: () => void;
  update: (msg: string) => void;
  updateLine2: (msg: string) => void;
}

let overlay: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function ensureOverlay(): HTMLElement {
  if (overlay && document.body.contains(overlay)) return overlay;
  overlay = document.createElement("div");
  overlay.className = "loading-overlay";
  overlay.innerHTML = '<div class="loading-spinner"></div><div class="loading-text">Importing...</div><div class="loading-detail"></div><div class="loading-detail2"></div>';
  return overlay;
}

/**
 * Show a loading spinner after `delayMs`. Returns an object with dismiss() and update() methods.
 * If dismissed before the delay, the spinner never appears.
 */
export function showLoading(text = "Importing...", delayMs = 1500): LoadingHandle {
  const el = ensureOverlay();
  const textEl = el.querySelector(".loading-text") as HTMLElement;
  const detailEl = el.querySelector(".loading-detail") as HTMLElement;
  const detail2El = el.querySelector(".loading-detail2") as HTMLElement;
  if (textEl) textEl.textContent = text;
  if (detailEl) detailEl.textContent = "";
  if (detail2El) detail2El.textContent = "";

  let shown = false;
  timer = setTimeout(() => {
    document.body.appendChild(el);
    shown = true;
  }, delayMs);

  return {
    dismiss: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (shown && el.parentNode) el.remove();
    },
    update: (msg: string) => {
      if (detailEl) detailEl.textContent = msg;
    },
    updateLine2: (msg: string) => {
      if (detail2El) detail2El.textContent = msg;
    },
  };
}
