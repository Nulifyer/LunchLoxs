import type { Recipe } from "../../types";
import type { AutocompleteInput } from "../../components/autocomplete-input";
import { escapeHtml, escapeAttr } from "../../lib/html";
import { parseQty, formatQty, scaleQty } from "../../lib/quantity";
import { convertIngredient, convertToUnit, resolveUnit, isDecimalUnit, canonicalUnitName, type UnitSystem } from "../../lib/units";
import { findDensity, convertViaDensity } from "../../lib/densities";
import {
  getStore, isPageEditing, getScaleFactor, getUnitSystem,
  getUnitOverrides, getCheckedIngredients, getBaseServings, getCurrentServings,
  getPushSnapshotFn,
} from "./state";

const ingredientsList = document.getElementById("ingredients-list") as HTMLElement;
const scaleBar = document.getElementById("ingredient-scale-bar") as HTMLElement;
const scaleDisplay = document.getElementById("scale-display") as HTMLElement;

export function cycleUnitSystem(current: UnitSystem): UnitSystem {
  if (current === "original") return "metric";
  if (current === "metric") return "imperial";
  return "original";
}

export const UNIT_LABELS: Record<UnitSystem, string> = {
  original: "Original",
  metric: "Metric",
  imperial: "Imperial",
};

let allIngredientSuggestions: string[] = [];

/** Update ingredient suggestions after async loading. */
export function setIngredientSuggestions(suggestions: string[]) {
  allIngredientSuggestions = suggestions;
}

/** Merge passed-in suggestions with current recipe's ingredient names. */
export function getIngredientSuggestions(): string[] {
  const store = getStore();
  const set = new Set<string>(allIngredientSuggestions);
  const doc = store?.getDoc();
  if (doc?.ingredients) {
    for (const ing of doc.ingredients) {
      const name = ing.item?.trim().toLowerCase();
      if (name) set.add(name);
    }
  }
  return [...set].sort();
}

export function commitGhostRow() {
  const store = getStore();
  if (!store) return;
  const ghostLi = ingredientsList.querySelector(".ing-ghost");
  if (!ghostLi) return;
  const qtyIn = ghostLi.querySelector("[data-ing-field='quantity']") as HTMLInputElement;
  const unitIn = ghostLi.querySelector("[data-ing-field='unit']") as HTMLInputElement;
  const optIn = ghostLi.querySelector("[data-ing-field='optional']") as HTMLInputElement;
  const itemIn = ghostLi.querySelector("[data-ing-field='item']") as AutocompleteInput;
  const item = itemIn?.value?.trim();
  if (!item) return;
  store.change((doc) => {
    if (!doc.ingredients) doc.ingredients = [];
    const unit = canonicalUnitName(unitIn?.value ?? "") ?? unitIn?.value.trim() ?? "";
    const optional = optIn?.checked || false;
    doc.ingredients.push({ item, quantity: qtyIn?.value.trim() ?? "", unit, ...(optional ? { optional } : {}) });
  });
  getPushSnapshotFn()?.();
  // Re-render will create a fresh ghost row; focus its item field
  renderIngredients(store.getDoc());
  const newGhost = ingredientsList.querySelector(".ing-ghost [data-ing-field='quantity']") as HTMLInputElement;
  newGhost?.focus();
}

export function updateScaleDisplay() {
  scaleDisplay.textContent = `${getCurrentServings()} servings`;
  scaleBar.classList.toggle("scaled", getCurrentServings() !== getBaseServings());
}

export function renderIngredients(doc: Recipe) {
  const ingredients = doc.ingredients ?? [];
  const pageEditing = isPageEditing();
  const scaleFactor = getScaleFactor();
  const unitSystem = getUnitSystem();
  const unitOverrides = getUnitOverrides();
  const checkedIngredients = getCheckedIngredients();

  if (pageEditing) {
    // Save focus state before re-render
    const focused = document.activeElement as HTMLInputElement | null;
    const focusGhost = focused?.dataset.ghost === "true";
    const focusKey = !focusGhost && focused?.dataset.ingIdx && focused?.dataset.ingField
      ? `${focused.dataset.ingIdx}:${focused.dataset.ingField}` : null;
    const ghostFocusField = focusGhost ? focused?.dataset.ingField ?? null : null;
    const focusPos = focused?.selectionStart ?? 0;

    let html = "";
    if (ingredients.length === 0) {
      html += '<li class="ing-empty"><em>No ingredients yet. Type below to add.</em></li>';
    } else {
      html += ingredients
        .map((ing, i) => `<li data-ing-idx="${i}">
          <span class="ing-drag-handle">&#x283F;</span>
          <input class="ing-edit ing-qty" data-ing-idx="${i}" data-ing-field="quantity" value="${escapeAttr(ing.quantity)}" placeholder="qty" />
          <input class="ing-edit ing-unit" data-ing-idx="${i}" data-ing-field="unit" value="${escapeAttr(ing.unit)}" placeholder="unit" />
          <input type="checkbox" class="ing-optional-check" data-ing-idx="${i}" data-ing-field="optional" ${ing.optional ? "checked" : ""} title="Optional" />
          <autocomplete-input class="ing-edit ing-text" data-ing-idx="${i}" data-ing-field="item" value="${escapeAttr(ing.item)}" placeholder="ingredient"></autocomplete-input>
          <button data-delete-ing="${i}" title="Remove">&times;</button>
        </li>`)
        .join("");
    }
    // Ghost row for adding
    html += `<li class="ing-ghost">
      <span class="ing-drag-handle" style="visibility:hidden">&#x283F;</span>
      <input class="ing-edit ing-qty" data-ghost="true" data-ing-field="quantity" value="" placeholder="qty" />
      <input class="ing-edit ing-unit" data-ghost="true" data-ing-field="unit" value="" placeholder="unit" />
      <input type="checkbox" class="ing-optional-check" data-ghost="true" data-ing-field="optional" title="Optional" />
      <autocomplete-input class="ing-edit ing-text" data-ghost="true" data-ing-field="item" placeholder="add ingredient..."></autocomplete-input>
    </li>`;
    ingredientsList.innerHTML = html;

    // Set suggestions on all autocomplete-input elements
    const suggestions = getIngredientSuggestions();
    ingredientsList.querySelectorAll("autocomplete-input").forEach((el) => {
      (el as AutocompleteInput).suggestions = suggestions;
    });

    // Restore focus
    if (focusKey) {
      const [idx, field] = focusKey.split(":");
      const el = ingredientsList.querySelector(`[data-ing-idx="${idx}"][data-ing-field="${field}"]:not([data-ghost])`) as HTMLElement;
      if (el) { el.focus(); if ((el as HTMLInputElement).type !== "checkbox") (el as any).setSelectionRange?.(focusPos, focusPos); }
    } else if (ghostFocusField) {
      const el = ingredientsList.querySelector(`.ing-ghost [data-ing-field="${ghostFocusField}"]`) as HTMLElement;
      if (el) { el.focus(); if ((el as HTMLInputElement).type !== "checkbox") (el as any).setSelectionRange?.(focusPos, focusPos); }
    }
  } else {
    // View mode with check-off, scaling, and unit conversion
    if (ingredients.length === 0) {
      ingredientsList.innerHTML = '<li class="ing-empty"><em>No ingredients.</em></li>';
    } else {
      ingredientsList.innerHTML = ingredients
        .map((ing, i) => {
          const checked = checkedIngredients.has(i);
          const scaledRaw = scaleQty(ing.quantity, scaleFactor);
          const scaledNum = parseQty(scaledRaw);
          const overrideUnit = unitOverrides.get(i);
          let displayQty = escapeHtml(scaledRaw);
          let displayUnit = escapeHtml(ing.unit);
          let converted = false;
          if (scaledNum !== null) {
            // Per-ingredient override takes priority, then global system
            let result: { qty: number; unit: string } | null = null;
            if (overrideUnit?.startsWith("~")) {
              // Density-based cross-dimension conversion
              const targetUnit = overrideUnit.slice(1);
              const ud = resolveUnit(ing.unit);
              const den = findDensity(ing.item);
              if (ud && den) {
                result = convertViaDensity(scaledNum, ud.toBase, ud.dimension, targetUnit, den);
              }
            } else if (overrideUnit) {
              result = convertToUnit(scaledNum, ing.unit, overrideUnit);
            } else if (unitSystem !== "original") {
              const sys = convertIngredient(scaledNum, ing.unit, unitSystem);
              if (sys.unit !== ing.unit) result = sys;
            }
            if (result) {
              displayQty = escapeHtml(formatQty(result.qty, isDecimalUnit(result.unit)));
              displayUnit = escapeHtml(result.unit);
              converted = true;
            }
          }
          const convertible = resolveUnit(ing.unit) !== null;
          const unitClass = "ing-unit" + (converted ? " ing-converted" : "") + (convertible ? " ing-convertible" : "");
          const optionalLabel = ing.optional ? ' <span class="ing-optional">(optional)</span>' : "";
          return `<li data-ing-idx="${i}" data-orig-unit="${escapeAttr(ing.unit)}" class="${checked ? "ing-checked" : ""}">
            <span class="ing-check"></span>
            <span class="ing-qty">${displayQty}</span>
            <span class="${unitClass}">${displayUnit}</span>
            <span class="ing-text">${escapeHtml(ing.item)}</span>${optionalLabel}
          </li>`;
        })
        .join("");
    }
    updateScaleDisplay();
  }
}
