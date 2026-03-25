/**
 * Toast notification system.
 * Stackable, auto-dismiss, positioned bottom-right.
 */

type ToastType = "success" | "error" | "warning" | "info";

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  document.body.appendChild(container);
  return container;
}

export function toast(message: string, type: ToastType = "info", durationMs = 3000): void {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.setAttribute("role", "status");

  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);

  const close = document.createElement("button");
  close.className = "toast-close";
  close.textContent = "\u00d7";
  close.addEventListener("click", () => dismiss(el));
  el.appendChild(close);

  ensureContainer().appendChild(el);

  // Trigger enter animation
  requestAnimationFrame(() => el.classList.add("toast-visible"));

  if (durationMs > 0) {
    setTimeout(() => dismiss(el), durationMs);
  }
}

function dismiss(el: HTMLElement): void {
  el.classList.remove("toast-visible");
  el.classList.add("toast-exit");
  el.addEventListener("transitionend", () => el.remove(), { once: true });
  // Fallback removal if transition doesn't fire
  setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
}

export function toastSuccess(message: string): void { toast(message, "success"); }
export function toastError(message: string, duration = 5000): void { toast(message, "error", duration); }
export function toastWarning(message: string): void { toast(message, "warning", 4000); }
export function toastInfo(message: string): void { toast(message, "info"); }
