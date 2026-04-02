/**
 * <recipe-list-view> — reusable web component for rendering a sorted recipe list.
 *
 * Properties:
 *   recipes: CatalogEntry[]     — the recipes to display
 *   selectedId: string | null   — highlight the selected recipe
 *   dirtyIds: Set<string>       — recipe IDs with unsynced changes (shows sync dot)
 *
 * Events:
 *   recipe-select – fired with { detail: { recipeId } } when a recipe is clicked
 */

import { escapeHtml } from "../lib/html";

export interface RecipeListEntry {
  id: string;
  title: string;
  tags?: string[];
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
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    border-radius: var(--radius, 6px);
    transition: background 0.1s;
  }

  li:hover {
    background: var(--bg-hover, rgba(255,255,255,0.05));
  }

  li.selected {
    background: var(--bg-selected, rgba(255,255,255,0.08));
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .title-row strong {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text, #ccc);
  }

  .sync-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warning, #e5a100);
    flex-shrink: 0;
  }

  small {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
    margin-top: 0.15rem;
  }

  .tag {
    display: inline-block;
    background: var(--border, #333);
    color: var(--text, #ccc);
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    font-size: 0.6rem;
    text-transform: capitalize;
  }
</style>
<ul></ul>
`;

export class RecipeListView extends HTMLElement {
  private root: ShadowRoot;
  private list: HTMLUListElement;
  private _recipes: RecipeListEntry[] = [];
  private _selectedId: string | null = null;
  private _dirtyIds = new Set<string>();

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.appendChild(TEMPLATE.content.cloneNode(true));
    this.list = this.root.querySelector("ul")!;

    this.list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest("[data-recipe-id]") as HTMLElement | null;
      if (li) {
        this.dispatchEvent(new CustomEvent("recipe-select", {
          detail: { recipeId: li.dataset.recipeId },
          bubbles: true,
        }));
      }
    });
  }

  get recipes(): RecipeListEntry[] { return this._recipes; }
  set recipes(entries: RecipeListEntry[]) {
    this._recipes = entries;
    this.render();
  }

  get selectedId(): string | null { return this._selectedId; }
  set selectedId(id: string | null) {
    this._selectedId = id;
    this.render();
  }

  get dirtyIds(): Set<string> { return this._dirtyIds; }
  set dirtyIds(ids: Set<string>) {
    this._dirtyIds = ids;
    this.render();
  }

  private render() {
    this.list.innerHTML = "";
    const sorted = [...this._recipes].sort((a, b) => a.title.localeCompare(b.title));

    for (const recipe of sorted) {
      const li = document.createElement("li");
      li.dataset.recipeId = recipe.id;
      if (recipe.id === this._selectedId) li.className = "selected";

      const titleRow = document.createElement("div");
      titleRow.className = "title-row";

      const strong = document.createElement("strong");
      strong.textContent = recipe.title;
      titleRow.appendChild(strong);

      if (this._dirtyIds.has(recipe.id)) {
        const dot = document.createElement("span");
        dot.className = "sync-dot";
        dot.title = "Unsynced changes";
        titleRow.appendChild(dot);
      }

      li.appendChild(titleRow);

      if (recipe.tags && recipe.tags.length > 0) {
        const small = document.createElement("small");
        for (const tag of recipe.tags) {
          const span = document.createElement("span");
          span.className = "tag";
          span.textContent = tag;
          small.appendChild(span);
        }
        li.appendChild(small);
      }

      this.list.appendChild(li);
    }
  }
}

customElements.define("recipe-list-view", RecipeListView);
