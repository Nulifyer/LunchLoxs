/**
 * Modal system -- replaces <dialog>.showModal().
 *
 * Uses a backdrop + centered container in normal DOM flow.
 * This avoids the top-layer isolation that breaks dropdown menus.
 * Body scroll is locked while any modal is open.
 */

let openCount = 0;

export function openModal(dialog: HTMLDialogElement): void {
  // Use the native show() (not showModal) to make it visible without top layer
  // Then we overlay our own backdrop
  dialog.setAttribute("data-modal-open", "");
  dialog.style.position = "fixed";
  dialog.style.top = "50%";
  dialog.style.left = "50%";
  dialog.style.transform = "translate(-50%, -50%)";
  dialog.style.zIndex = "200";
  dialog.style.margin = "0";

  // Create backdrop if not already there
  let backdrop = dialog.previousElementSibling;
  if (!backdrop?.classList.contains("modal-backdrop")) {
    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    dialog.parentElement?.insertBefore(backdrop, dialog);
  }
  (backdrop as HTMLElement).style.display = "block";

  // Close on backdrop click
  (backdrop as HTMLElement).onclick = () => closeModal(dialog);

  // Close on ESC
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); closeModal(dialog); }
  };
  dialog.setAttribute("data-esc-handler", "true");
  document.addEventListener("keydown", escHandler);
  (dialog as any)._escHandler = escHandler;

  // Show dialog (non-modal, so it stays in normal DOM flow)
  dialog.show();

  // Lock body scroll
  openCount++;
  document.body.style.overflow = "hidden";
}

export function closeModal(dialog: HTMLDialogElement): void {
  dialog.close();
  dialog.removeAttribute("data-modal-open");
  dialog.style.position = "";
  dialog.style.top = "";
  dialog.style.left = "";
  dialog.style.transform = "";
  dialog.style.zIndex = "";
  dialog.style.margin = "";

  // Hide backdrop
  const backdrop = dialog.previousElementSibling;
  if (backdrop?.classList.contains("modal-backdrop")) {
    (backdrop as HTMLElement).style.display = "none";
  }

  // Remove ESC handler
  if ((dialog as any)._escHandler) {
    document.removeEventListener("keydown", (dialog as any)._escHandler);
    delete (dialog as any)._escHandler;
  }

  // Unlock body scroll if no other modals
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) document.body.style.overflow = "";
}
