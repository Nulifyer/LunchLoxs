/**
 * Recipe list sidebar view + floating cross-book search.
 */

import type { CatalogEntry } from "../types";

import { search, hybridSearch, getIndexSize, type SearchResult } from "../lib/search";
import { getPushQueue, getActiveBook } from "../state";
import { createDropdown } from "../lib/dropdown";

export interface RecipeListCallbacks {
  onSelect: (id: string, vaultId?: string) => void;
  onAdd: () => void;
  onImportUrl?: () => void;
  onImportFile?: () => void;
}

let container: HTMLUListElement;
let searchInput: HTMLInputElement;
let searchResults: HTMLUListElement;

let recipeDropdownBtn: HTMLButtonElement;
let callbacks: RecipeListCallbacks;
let currentSearch = "";
let activeIdx = -1;

export function initRecipeList(cb: RecipeListCallbacks) {
  callbacks = cb;
  container = document.getElementById("recipe-list") as HTMLUListElement;
  searchInput = document.getElementById("search-input") as HTMLInputElement;
  searchResults = document.getElementById("search-results") as HTMLUListElement;

  recipeDropdownBtn = createDropdown([
    { label: "New Recipe", action: () => callbacks.onAdd() },
    { separator: true },
    { label: "Import from URL", action: () => callbacks.onImportUrl?.() },
    { label: "Import File", action: () => callbacks.onImportFile?.() },
  ], { label: "New +", className: "sm" });
  document.getElementById("recipe-actions")?.appendChild(recipeDropdownBtn);

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener("input", () => {
    currentSearch = searchInput.value.trim();
    activeIdx = -1;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(renderSearchDropdown, 80);
  });

  searchInput.addEventListener("focus", () => {
    if (currentSearch) renderSearchDropdown();
  });

  // Arrow key navigation + enter to select
  searchInput.addEventListener("keydown", (e) => {
    if (!searchResults.classList.contains("open")) return;
    const items = searchResults.querySelectorAll("[data-recipe-id]");
    if (items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      updateActiveItem(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      updateActiveItem(items);
    } else if (e.key === "Enter" && items.length > 0) {
      if (activeIdx < 0) activeIdx = 0;
      e.preventDefault();
      const el = items[activeIdx] as HTMLElement;
      callbacks.onSelect(el.dataset.recipeId!, el.dataset.vaultId);
      searchResults.classList.remove("open");
      searchInput.value = "";
      currentSearch = "";
      activeIdx = -1;
    } else if (e.key === "Escape") {
      searchResults.classList.remove("open");
      activeIdx = -1;
    }
  });

  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".topbar-search")) {
      searchResults.classList.remove("open");
      activeIdx = -1;
    }
  });

  container.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest("[data-recipe-id]") as HTMLElement;
    if (el) callbacks.onSelect(el.dataset.recipeId!);
  });

  searchResults.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest("[data-recipe-id]") as HTMLElement;
    if (el) {
      callbacks.onSelect(el.dataset.recipeId!, el.dataset.vaultId);
      searchResults.classList.remove("open");
      searchInput.value = "";
      currentSearch = "";
      activeIdx = -1;
    }
  });
}

function updateActiveItem(items: NodeListOf<Element>) {
  items.forEach((el, i) => {
    (el as HTMLElement).classList.toggle("search-active", i === activeIdx);
  });
  if (activeIdx >= 0) (items[activeIdx] as HTMLElement).scrollIntoView({ block: "nearest" });
}

async function renderSearchDropdown() {
  const query = currentSearch;
  if (!query) {
    searchResults.classList.remove("open");
    return;
  }

  const results = await hybridSearch(query);
  // Guard against stale results (user kept typing)
  if (query !== currentSearch) return;

  if (results.length === 0) {
    searchResults.innerHTML = `<li class="search-empty">No results</li>`;
    searchResults.classList.add("open");
    return;
  }

  searchResults.innerHTML = "";
  for (const result of results) {
    const { entry } = result;
    const li = document.createElement("li");
    li.dataset.recipeId = entry.recipeId;
    li.dataset.vaultId = entry.vaultId;
    li.className = "search-result-item";

    const titleRow = document.createElement("div");
    titleRow.className = "search-result-title";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = entry.title;
    titleRow.appendChild(nameSpan);
    const bookSpan = document.createElement("span");
    bookSpan.className = "search-result-book";
    bookSpan.textContent = entry.bookName;
    titleRow.appendChild(bookSpan);
    li.appendChild(titleRow);

    const matchText = getMatchSnippet(currentSearch.toLowerCase(), result);
    if (matchText) {
      const snippet = document.createElement("div");
      snippet.className = "search-result-snippet";
      snippet.textContent = matchText;
      li.appendChild(snippet);
    }

    searchResults.appendChild(li);
  }

  searchResults.classList.add("open");
  activeIdx = 0;
  const items = searchResults.querySelectorAll("[data-recipe-id]");
  updateActiveItem(items);
}

/** Build a snippet showing why this result matched */
function getMatchSnippet(_query: string, result: SearchResult): string {
  const { entry, matchField, matchTag } = result;

  switch (matchField) {
    case "tag":
      return matchTag ? `Tag: ${matchTag}` : entry.tags.join(", ");
    case "book":
      return `Book: ${entry.bookName}`;
    case "title":
      if (entry.tags.length > 0) return entry.tags.join(", ");
      break;
  }
  return "";
}

export function setRecipeActionsEnabled(enabled: boolean) {
  if (recipeDropdownBtn) recipeDropdownBtn.disabled = !enabled;
}

export function renderRecipeList(recipes: CatalogEntry[], selectedId: string | null) {
  container.innerHTML = "";
  const sorted = [...recipes].sort((a, b) => a.title.localeCompare(b.title));
  const pq = getPushQueue();
  const activeBook = getActiveBook();
  const vaultId = activeBook?.vaultId;

  for (const recipe of sorted) {
    const li = document.createElement("li");
    li.dataset.recipeId = recipe.id;
    li.className = recipe.id === selectedId ? "selected" : "";

    const titleRow = document.createElement("div");
    titleRow.className = "recipe-title-row";

    const strong = document.createElement("strong");
    strong.textContent = recipe.title;
    titleRow.appendChild(strong);

    // Sync status dot (per-recipe content only)
    const recipeDirty = vaultId ? pq?.isDirty(`${vaultId}/${recipe.id}`) ?? false : false;
    const dot = document.createElement("span");
    dot.className = "sync-dot pending";
    dot.hidden = !recipeDirty;
    dot.title = recipeDirty ? "Unsynced changes" : "";
    titleRow.appendChild(dot);

    li.appendChild(titleRow);
    container.appendChild(li);
  }
}
