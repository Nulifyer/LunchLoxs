/**
 * <book-list> — reusable web component for rendering a list of books.
 *
 * Properties:
 *   books: Array<{ vaultId: string; name: string; role: string; dirty?: boolean }>
 *
 * Events:
 *   book-select – fired with { detail: { vaultId } } when a book is clicked
 */

import type { Book } from "../types";

export interface BookListEntry {
  vaultId: string;
  name: string;
  role: string;
  dirty?: boolean;
}

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
<style>
  :host {
    display: block;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.75rem;
    cursor: pointer;
    border-radius: var(--radius, 6px);
    transition: background 0.1s;
  }

  li:hover {
    background: var(--bg-hover, rgba(255,255,255,0.05));
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text, #ccc);
    font-size: 0.85rem;
  }

  .role {
    font-size: 0.65rem;
    color: var(--muted, #666);
    text-transform: capitalize;
  }

  .sync-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warning, #e5a100);
    flex-shrink: 0;
  }

  .empty {
    padding: 1rem;
    text-align: center;
    color: var(--muted, #666);
    font-size: 0.85rem;
  }
</style>
<ul></ul>
`;

export class BookList extends HTMLElement {
  private root: ShadowRoot;
  private list: HTMLUListElement;
  private _books: BookListEntry[] = [];

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.appendChild(TEMPLATE.content.cloneNode(true));
    this.list = this.root.querySelector("ul")!;

    this.list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest("[data-vault-id]") as HTMLElement | null;
      if (li) {
        this.dispatchEvent(new CustomEvent("book-select", {
          detail: { vaultId: li.dataset.vaultId },
          bubbles: true,
        }));
      }
    });
  }

  get books(): BookListEntry[] { return this._books; }
  set books(entries: BookListEntry[]) {
    this._books = entries;
    this.render();
  }

  private render() {
    this.list.innerHTML = "";
    const sorted = [...this._books].sort((a, b) => a.name.localeCompare(b.name));

    if (sorted.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No books yet";
      this.list.appendChild(li);
      return;
    }

    for (const book of sorted) {
      const li = document.createElement("li");
      li.dataset.vaultId = book.vaultId;
      li.setAttribute("role", "option");

      if (book.dirty) {
        const dot = document.createElement("span");
        dot.className = "sync-dot";
        li.appendChild(dot);
      }

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = book.name;
      li.appendChild(name);

      if (book.role !== "owner") {
        const role = document.createElement("span");
        role.className = "role";
        role.textContent = book.role;
        li.appendChild(role);
      }

      this.list.appendChild(li);
    }
  }
}

customElements.define("book-list", BookList);
