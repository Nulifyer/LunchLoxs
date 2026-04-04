/**
 * Reusable dropdown action menu.
 * Opens a positioned menu from a trigger button, closes on outside click or ESC.
 * Supports keyboard navigation (arrow keys + enter).
 *
 * The menu is appended to document.body and positioned absolutely via JS
 * so it never disrupts the trigger's layout or parent flex containers.
 */

export type DropdownItem =
  | { label: string; action: () => void; danger?: boolean; separator?: false }
  | { separator: true };

let activeMenu: { menu: HTMLElement; trigger: HTMLElement; cleanup: () => void } | null = null;

function closeActive() {
  if (activeMenu) { activeMenu.cleanup(); activeMenu = null; }
}

document.addEventListener("click", (e) => {
  if (activeMenu && !activeMenu.menu.contains(e.target as Node) && !activeMenu.trigger.contains(e.target as Node)) {
    closeActive();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeMenu) closeActive();
});

/**
 * Create a trigger button that opens a dropdown menu.
 * Returns the button element -- just append it wherever you need it.
 * The menu is portaled to document.body so it never affects parent layout.
 */
export function createDropdown(items: DropdownItem[], opts?: { label?: string; className?: string }): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.className = opts?.className ?? "icon-btn";
  trigger.innerHTML = opts?.label ?? '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>';
  trigger.setAttribute("aria-label", "Actions");
  trigger.setAttribute("aria-haspopup", "true");

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();

    if (activeMenu && activeMenu.trigger === trigger) {
      closeActive();
      return;
    }
    closeActive();

    const menu = document.createElement("div");
    menu.className = "dropdown-menu";
    menu.setAttribute("role", "menu");

    let activeIdx = -1;
    const actionEls: HTMLButtonElement[] = [];

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "dropdown-sep";
        menu.appendChild(sep);
        continue;
      }

      const btn = document.createElement("button");
      btn.className = `dropdown-item${item.danger ? " danger-text" : ""}`;
      btn.textContent = item.label;
      btn.setAttribute("role", "menuitem");
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeActive();
        item.action();
      });
      menu.appendChild(btn);
      actionEls.push(btn);
    }

    menu.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        activeIdx = Math.min(activeIdx + 1, actionEls.length - 1);
        actionEls[activeIdx]?.focus();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        actionEls[activeIdx]?.focus();
      } else if (ev.key === "Enter" && activeIdx >= 0) {
        ev.preventDefault();
        actionEls[activeIdx]?.click();
      }
    });

    document.body.appendChild(menu);
    const rect = trigger.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.style.zIndex = "300";

    requestAnimationFrame(() => {
      if (actionEls.length > 0) {
        activeIdx = 0;
        actionEls[0]!.focus();
      }
    });

    activeMenu = {
      menu,
      trigger,
      cleanup: () => menu.remove(),
    };
  });

  return trigger;
}
