/**
 * Recipe list sidebar view + floating search results.
 */

import type { RecipeMeta } from "../types";
import { escapeHtml } from "../lib/html";

export interface RecipeListCallbacks {
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSearch: (query: string) => void;
}

const container = document.getElementById("recipe-list") as HTMLUListElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchResults = document.getElementById("search-results") as HTMLUListElement;
const addBtn = document.getElementById("add-recipe-btn") as HTMLButtonElement;

let callbacks: RecipeListCallbacks;
let currentSearch = "";
let allRecipes: RecipeMeta[] = [];

export function initRecipeList(cb: RecipeListCallbacks) {
  callbacks = cb;
  addBtn.addEventListener("click", () => callbacks.onAdd());

  searchInput.addEventListener("input", () => {
    currentSearch = searchInput.value.trim().toLowerCase();
    callbacks.onSearch(currentSearch);
    renderSearchDropdown();
  });

  searchInput.addEventListener("focus", () => {
    if (currentSearch) renderSearchDropdown();
  });

  // Close search on outside click
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".topbar-search")) {
      searchResults.classList.remove("open");
    }
  });

  // Handle clicks in both sidebar list and search dropdown
  container.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest("[data-recipe-id]") as HTMLElement;
    if (el) callbacks.onSelect(el.dataset.recipeId!);
  });

  searchResults.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest("[data-recipe-id]") as HTMLElement;
    if (el) {
      callbacks.onSelect(el.dataset.recipeId!);
      searchResults.classList.remove("open");
      searchInput.value = "";
      currentSearch = "";
    }
  });
}

function renderSearchDropdown() {
  if (!currentSearch) {
    searchResults.classList.remove("open");
    return;
  }

  const filtered = allRecipes.filter((r) =>
    r.title.toLowerCase().includes(currentSearch) ||
    r.tags.some((t) => t.toLowerCase().includes(currentSearch))
  );

  if (filtered.length === 0) {
    searchResults.innerHTML = "<li><small>No results</small></li>";
    searchResults.classList.add("open");
    return;
  }

  searchResults.innerHTML = "";
  for (const recipe of filtered.slice(0, 10)) {
    const li = document.createElement("li");
    li.dataset.recipeId = recipe.id;

    const strong = document.createElement("strong");
    strong.textContent = recipe.title;
    li.appendChild(strong);

    if (recipe.tags.length > 0) {
      const small = document.createElement("small");
      small.textContent = recipe.tags.join(", ");
      li.appendChild(small);
    }

    searchResults.appendChild(li);
  }
  searchResults.classList.add("open");
}

export function renderRecipeList(recipes: RecipeMeta[], selectedId: string | null) {
  allRecipes = recipes;

  // Sidebar always shows all recipes (search is in the topbar dropdown)
  container.innerHTML = "";
  for (const recipe of recipes) {
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

  // Also update search dropdown if open
  if (currentSearch) renderSearchDropdown();
}
