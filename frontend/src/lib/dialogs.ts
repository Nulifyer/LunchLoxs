/**
 * Custom HTML dialog replacements for alert(), confirm(), prompt().
 * All return Promises. Rendered as <dialog> elements with proper focus trapping.
 */

function createDialogShell(): { dialog: HTMLDialogElement; body: HTMLElement; footer: HTMLElement } {
  const dialog = document.createElement("dialog");
  dialog.className = "custom-dialog";
  const article = document.createElement("article");
  const body = document.createElement("div");
  body.className = "custom-dialog-body";
  const footer = document.createElement("div");
  footer.className = "dialog-footer";
  article.appendChild(body);
  article.appendChild(footer);
  dialog.appendChild(article);
  return { dialog, body, footer };
}

function showAndCleanup(dialog: HTMLDialogElement): void {
  document.body.appendChild(dialog);
  // Use non-modal show + our own backdrop so dropdowns work
  dialog.style.position = "fixed";
  dialog.style.top = "50%";
  dialog.style.left = "50%";
  dialog.style.transform = "translate(-50%, -50%)";
  dialog.style.zIndex = "210";
  // Create backdrop
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.style.display = "block";
  backdrop.style.zIndex = "200";
  document.body.insertBefore(backdrop, dialog);
  dialog.show();
  const cleanup = () => {
    backdrop.remove();
    dialog.remove();
    document.body.style.overflow = "";
  };
  dialog.addEventListener("close", cleanup, { once: true });
  document.body.style.overflow = "hidden";
}

/**
 * Show an alert dialog (replacement for window.alert).
 */
export function showAlert(message: string, title?: string): Promise<void> {
  return new Promise((resolve) => {
    const { dialog, body, footer } = createDialogShell();

    if (title) {
      const h = document.createElement("strong");
      h.textContent = title;
      h.style.display = "block";
      h.style.marginBottom = "0.5rem";
      body.appendChild(h);
    }

    const msg = document.createElement("p");
    msg.style.fontSize = "0.85rem";
    msg.textContent = message;
    body.appendChild(msg);

    const ok = document.createElement("button");
    ok.textContent = "OK";
    ok.addEventListener("click", () => { dialog.close(); resolve(); });
    footer.appendChild(ok);

    showAndCleanup(dialog);
    ok.focus();
  });
}

/**
 * Show a confirm dialog (replacement for window.confirm).
 * Returns true if confirmed, false if cancelled.
 */
export function showConfirm(
  message: string,
  opts?: { title?: string; confirmText?: string; cancelText?: string; danger?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    const { dialog, body, footer } = createDialogShell();

    if (opts?.title) {
      const h = document.createElement("strong");
      h.textContent = opts.title;
      h.style.display = "block";
      h.style.marginBottom = "0.5rem";
      if (opts.danger) h.style.color = "var(--red)";
      body.appendChild(h);
    }

    const msg = document.createElement("p");
    msg.style.fontSize = "0.85rem";
    msg.textContent = message;
    body.appendChild(msg);

    const cancel = document.createElement("button");
    cancel.textContent = opts?.cancelText ?? "Cancel";
    cancel.addEventListener("click", () => { dialog.close(); resolve(false); });
    footer.appendChild(cancel);

    const confirm = document.createElement("button");
    confirm.textContent = opts?.confirmText ?? "Confirm";
    if (opts?.danger) {
      confirm.className = "danger-fill";
    } else {
      confirm.className = "primary";
    }
    confirm.addEventListener("click", () => { dialog.close(); resolve(true); });
    footer.appendChild(confirm);

    // ESC = cancel
    dialog.addEventListener("cancel", () => resolve(false));

    showAndCleanup(dialog);
    confirm.focus();
  });
}

/**
 * Show a prompt dialog (replacement for window.prompt).
 * Returns the entered string, or null if cancelled.
 */
export function showPrompt(
  message: string,
  opts?: { title?: string; defaultValue?: string; placeholder?: string; confirmText?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    const { dialog, body, footer } = createDialogShell();

    if (opts?.title) {
      const h = document.createElement("strong");
      h.textContent = opts.title;
      h.style.display = "block";
      h.style.marginBottom = "0.5rem";
      body.appendChild(h);
    }

    const label = document.createElement("label");
    label.textContent = message;
    label.style.fontSize = "0.8rem";
    body.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.value = opts?.defaultValue ?? "";
    if (opts?.placeholder) input.placeholder = opts.placeholder;
    input.style.marginTop = "0.3rem";
    body.appendChild(input);

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { dialog.close(); resolve(null); });
    footer.appendChild(cancel);

    const confirm = document.createElement("button");
    confirm.textContent = opts?.confirmText ?? "OK";
    confirm.className = "primary";
    const doConfirm = () => { dialog.close(); resolve(input.value); };
    confirm.addEventListener("click", doConfirm);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doConfirm(); });
    footer.appendChild(confirm);

    dialog.addEventListener("cancel", () => resolve(null));

    showAndCleanup(dialog);
    input.focus();
    input.select();
  });
}

/**
 * Show a select dialog with a dropdown.
 * Returns the selected value string, or null if cancelled.
 */
export function showSelect(
  options: Array<{ value: string; label: string }>,
  opts?: { title?: string; message?: string; confirmText?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    const { dialog, body, footer } = createDialogShell();

    if (opts?.title) {
      const h = document.createElement("strong");
      h.textContent = opts.title;
      h.style.display = "block";
      h.style.marginBottom = "0.5rem";
      body.appendChild(h);
    }

    if (opts?.message) {
      const msg = document.createElement("p");
      msg.style.fontSize = "0.85rem";
      msg.textContent = opts.message;
      body.appendChild(msg);
    }

    const select = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }
    body.appendChild(select);

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { dialog.close(); resolve(null); });
    footer.appendChild(cancel);

    const confirm = document.createElement("button");
    confirm.textContent = opts?.confirmText ?? "OK";
    confirm.className = "primary";
    confirm.addEventListener("click", () => { dialog.close(); resolve(select.value); });
    footer.appendChild(confirm);

    dialog.addEventListener("cancel", () => resolve(null));

    showAndCleanup(dialog);
    select.focus();
  });
}
