/**
 * HTML escaping utilities -- shared across the app.
 */

const escapeEl = document.createElement("div");

export function escapeHtml(s: string): string {
  escapeEl.textContent = s;
  return escapeEl.innerHTML;
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
