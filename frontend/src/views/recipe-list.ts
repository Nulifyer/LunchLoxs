/**
 * Recipe list sidebar view.
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
const addBtn = document.getElementById("add-recipe-btn") as HTMLButtonElement;

let callbacks: RecipeListCallbacks;
let currentSearch = "";

export function initRecipeList(cb: RecipeListCallbacks) {
  callbacks = cb;
  addBtn.addEventListener("click", () => callbacks.onAdd());
  searchInput.addEventListener("input", () => {
    currentSearch = searchInput.value.trim().toLowerCase();
    callbacks.onSearch(currentSearch);
  });
  container.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest("[data-recipe-id]") as HTMLElement;
    if (el) callbacks.onSelect(el.dataset.recipeId!);
  });
}

export function renderRecipeList(recipes: RecipeMeta[], selectedId: string | null) {
  const filtered = currentSearch
    ? recipes.filter((r) =>
        r.title.toLowerCase().includes(currentSearch) ||
        r.tags.some((t) => t.toLowerCase().includes(currentSearch))
      )
    : recipes;

  container.innerHTML = "";
  for (const recipe of filtered) {
    const li = document.createElement("li");
    li.dataset.recipeId = recipe.id;
    li.className = recipe.id === selectedId ? "selected" : "";

    const strong = document.createElement("strong");
    strong.textContent = recipe.title;
    li.appendChild(strong);

    const small = document.createElement("small");
    const tagHtml = recipe.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
    const timeStr = recipe.prepMinutes + recipe.cookMinutes > 0
      ? ` · ${recipe.prepMinutes + recipe.cookMinutes}m`
      : "";
    small.innerHTML = tagHtml + timeStr;
    li.appendChild(small);

    container.appendChild(li);
  }
}
