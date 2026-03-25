/**
 * Loading overlay spinner. Shows after a delay so short operations don't flash.
 */

let overlay: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function ensureOverlay(): HTMLElement {
  if (overlay && document.body.contains(overlay)) return overlay;
  overlay = document.createElement("div");
  overlay.className = "loading-overlay";
  overlay.innerHTML = '<div class="loading-spinner"></div><div class="loading-text">Importing...</div>';
  return overlay;
}

/**
 * Show a loading spinner after `delayMs`. Returns a dismiss function.
 * If dismissed before the delay, the spinner never appears.
 */
export function showLoading(text = "Importing...", delayMs = 1500): () => void {
  const el = ensureOverlay();
  const textEl = el.querySelector(".loading-text") as HTMLElement;
  if (textEl) textEl.textContent = text;

  let shown = false;
  timer = setTimeout(() => {
    document.body.appendChild(el);
    shown = true;
  }, delayMs);

  return () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (shown && el.parentNode) el.remove();
  };
}
