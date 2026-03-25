/**
 * Recipe list sidebar view + floating cross-book search.
 */

import type { RecipeMeta } from "../types";
import { escapeHtml } from "../lib/html";
import { search, getIndexSize, type SearchResult } from "../lib/search";

export interface RecipeListCallbacks {
  onSelect: (id: string, vaultId?: string) => void;
  onAdd: () => void;
}

const container = document.getElementById("recipe-list") as HTMLUListElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchResults = document.getElementById("search-results") as HTMLUListElement;
const addBtn = document.getElementById("add-recipe-btn") as HTMLButtonElement;

let callbacks: RecipeListCallbacks;
let currentSearch = "";
let activeIdx = -1;

export function initRecipeList(cb: RecipeListCallbacks) {
  callbacks = cb;
  addBtn.addEventListener("click", () => callbacks.onAdd());

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
    } else if (e.key === "Enter" && activeIdx >= 0) {
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

function renderSearchDropdown() {
  const indexSize = getIndexSize();
  console.log("[search] query:", JSON.stringify(currentSearch), "index size:", indexSize);

  if (!currentSearch) {
    searchResults.classList.remove("open");
    return;
  }

  const results = search(currentSearch);
  console.log("[search] results:", results.length);

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
}

/** Build a snippet showing why this result matched */
function getMatchSnippet(query: string, result: SearchResult): string {
  const { entry, matchField, matchTag } = result;

  switch (matchField) {
    case "tag":
      return matchTag ? `Tag: ${matchTag}` : entry.tags.join(", ");

    case "ingredients":
      if (entry.ingredients) return extractSnippet(query, entry.ingredients);
      break;

    case "instructions":
      if (entry.instructions) return extractSnippet(query, entry.instructions);
      break;

    case "book":
      return `Book: ${entry.bookName}`;

    case "title":
      if (entry.tags.length > 0) return entry.tags.join(", ");
      break;
  }
  return "";
}

function extractSnippet(query: string, text: string): string {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();

  // Try exact substring first
  const exactIdx = lower.indexOf(q);
  if (exactIdx >= 0) {
    return snippetAround(text, exactIdx, q.length);
  }

  // Find the fuzzy match region: first and last matched character positions
  let firstMatch = -1;
  let lastMatch = -1;
  let qi = 0;
  for (let ti = 0; ti < lower.length && qi < q.length; ti++) {
    if (lower[ti] === q[qi]) {
      if (firstMatch < 0) firstMatch = ti;
      lastMatch = ti;
      qi++;
    }
  }

  if (qi === q.length && firstMatch >= 0) {
    return snippetAround(text, firstMatch, lastMatch - firstMatch + 1);
  }

  // Fallback
  return text.slice(0, 50).trim() + (text.length > 50 ? "..." : "");
}

function snippetAround(text: string, matchStart: number, matchLen: number): string {
  const start = Math.max(0, matchStart - 15);
  const end = Math.min(text.length, matchStart + matchLen + 35);
  return (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "");
}

export function renderRecipeList(recipes: RecipeMeta[], selectedId: string | null) {
  container.innerHTML = "";
  const sorted = [...recipes].sort((a, b) => a.title.localeCompare(b.title));
  for (const recipe of sorted) {
    const li = document.createElement("li");
    li.dataset.recipeId = recipe.id;
    li.className = recipe.id === selectedId ? "selected" : "";

    const strong = document.createElement("strong");
    strong.textContent = recipe.title;
    li.appendChild(strong);

    const small = document.createElement("small");
    const tagHtml = recipe.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
    const timeStr = recipe.prepMinutes + recipe.cookMinutes > 0
      ? ` ${recipe.prepMinutes + recipe.cookMinutes}m`
      : "";
    small.innerHTML = tagHtml + timeStr;
    li.appendChild(small);

    container.appendChild(li);
  }
}
