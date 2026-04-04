/**
 * <recipe-preview> — reusable web component for rendering a recipe preview.
 *
 * Supports scaling, unit conversion, ingredient check-off — all matching the
 * main recipe detail view. Parent controls scaleFactor and unitSystem via
 * property setters; check-off and per-ingredient unit overrides are internal.
 *
 * Usage:
 *   const el = document.createElement("recipe-preview") as RecipePreview;
 *   el.setRecipe(doc);
 *   el.scaleFactor = 2;
 *   el.unitSystem = "metric";
 *   container.appendChild(el);
 */

import { marked } from "marked";
import DOMPurify from "dompurify";
import { escapeHtml, escapeAttr } from "../lib/html";
import { parseQty, formatQty, scaleQty } from "../lib/quantity";
import { convertIngredient, convertToUnit, resolveUnit, getConversionTargets, isDecimalUnit, type UnitSystem } from "../lib/units";
import { findDensity, convertViaDensity, WEIGHT_UNITS, VOLUME_UNITS } from "../lib/densities";

interface Ingredient {
  item: string;
  quantity: string;
  unit: string;
  optional?: boolean;
}

interface RecipeData {
  title?: string;
  servings?: number;
  prepMinutes?: number;
  cookMinutes?: number;
  description?: string;
  ingredients?: Ingredient[];
  instructions?: string;
  notes?: string;
}

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
<style>
  :host {
    display: block;
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--text);
  }

  .meta {
    color: var(--muted);
    font-size: 0.8rem;
    margin-bottom: 0.5rem;
  }

  .meta .meta-servings-scaled {
    color: var(--accent);
    font-weight: 600;
  }

  h4 {
    margin: 0.6rem 0 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--subtle);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* Ingredient list */
  ul {
    padding: 0;
    list-style: none;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 0.8rem;
    transition: opacity 0.2s, background 0.15s;
  }

  li:hover { background: var(--bg-hover); }

  .ing-check {
    width: 1.1rem;
    height: 1.1rem;
    border: 1.5px solid var(--muted);
    border-radius: 50%;
    cursor: pointer;
    flex-shrink: 0;
    transition: border-color 0.15s, background 0.15s;
  }
  .ing-check:hover { border-color: var(--accent); }

  li.ing-checked { opacity: 0.45; }
  li.ing-checked .ing-qty,
  li.ing-checked .ing-unit,
  li.ing-checked .ing-text {
    text-decoration: line-through;
    text-decoration-color: var(--muted);
  }
  li.ing-checked .ing-check {
    background: var(--accent);
    border-color: var(--accent);
  }

  .ing-qty {
    font-weight: 600;
    min-width: 2rem;
  }

  .ing-unit {
    color: var(--subtle);
    min-width: 2rem;
  }

  .ing-unit.ing-convertible {
    cursor: pointer;
    border-bottom: 1px dashed var(--muted);
  }
  .ing-unit.ing-convertible:hover {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .ing-unit.ing-converted {
    color: var(--accent);
    font-style: italic;
  }

  .ing-text { flex: 1; }

  /* Instructions / notes markdown */
  .markdown {
    font-size: 0.85rem;
    line-height: 1.6;
  }
  .markdown p { margin: 0.3em 0; }
  .markdown ul, .markdown ol { margin: 0.3em 0; padding-left: 1.5em; }
  .markdown li { margin: 0.15em 0; }
  .markdown img { display: none; }
  .markdown blockquote {
    margin: 0.2em 0 0.5em 0;
    padding: 0.2em 0 0.2em 0.75em;
    border-left: 2px solid var(--text-muted);
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.92em;
  }
  .markdown blockquote p { margin: 0; }

  /* Ingredient refs in markdown */
  .ing-ref {
    display: inline;
    background: var(--bg-hover);
    border-radius: var(--radius);
    padding: 0.1em 0.4em;
    font-size: 0.9em;
    font-weight: 600;
    white-space: nowrap;
  }
  .ing-ref-broken {
    opacity: 0.5;
    text-decoration: line-through;
    font-weight: 400;
  }

  .empty {
    color: var(--muted);
    font-style: italic;
  }
</style>
<div id="root"></div>
`;

export class RecipePreview extends HTMLElement {
  private root: HTMLElement | null = null;
  private _doc: RecipeData | null = null;
  private _scaleFactor = 1;
  private _unitSystem: UnitSystem = "original";
  private _checkedIngredients = new Set<number>();
  private _unitOverrides = new Map<number, string>();
  private _activePicker: HTMLElement | null = null;
  private _docClickHandler: ((e: MouseEvent) => void) | null = null;
  private _docKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  // Cached DOM containers for partial re-renders
  private _metaEl: HTMLElement | null = null;
  private _ingListEl: HTMLElement | null = null;
  private _instrEl: HTMLElement | null = null;
  private _notesEl: HTMLElement | null = null;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.appendChild(TEMPLATE.content.cloneNode(true));
    this.root = shadow.getElementById("root");
  }

  get scaleFactor() { return this._scaleFactor; }
  set scaleFactor(v: number) {
    if (this._scaleFactor === v) return;
    this._scaleFactor = v;
    this._renderMeta();
    this._renderIngredients();
    this._renderMarkdown();
  }

  get unitSystem() { return this._unitSystem; }
  set unitSystem(v: UnitSystem) {
    if (this._unitSystem === v) return;
    this._unitSystem = v;
    this._unitOverrides.clear();
    this._renderIngredients();
    this._renderMarkdown();
  }

  resetState() {
    this._checkedIngredients.clear();
    this._unitOverrides.clear();
    this._scaleFactor = 1;
    this._unitSystem = "original";
    this._renderIngredients();
    this._renderMarkdown();
  }

  setRecipe(doc: RecipeData) {
    this._doc = doc;
    if (!this.root) return;

    // Prune stale indices
    const ingLen = (doc.ingredients ?? []).length;
    for (const idx of this._checkedIngredients) { if (idx >= ingLen) this._checkedIngredients.delete(idx); }
    for (const idx of this._unitOverrides.keys()) { if (idx >= ingLen) this._unitOverrides.delete(idx); }

    // Build static structure
    this.root.innerHTML = `
      <div id="meta"></div>
      <h4>Ingredients</h4>
      <div id="ing-list"></div>
      <h4>Instructions</h4>
      <div id="instr"></div>
      <div id="notes-section"></div>
    `;

    this._metaEl = this.shadowRoot!.getElementById("meta");
    this._ingListEl = this.shadowRoot!.getElementById("ing-list");
    this._instrEl = this.shadowRoot!.getElementById("instr");
    this._notesEl = this.shadowRoot!.getElementById("notes-section");

    this._renderMeta();
    this._renderIngredients();
    this._renderMarkdown();
  }

  disconnectedCallback() {
    this._closePicker();
  }

  private _renderMeta() {
    if (!this._metaEl || !this._doc) return;
    const doc = this._doc;
    const parts: string[] = [];
    if (doc.servings) {
      const scaledCount = Math.max(1, Math.round(doc.servings * this._scaleFactor));
      const cls = this._scaleFactor !== 1 ? ' class="meta-servings-scaled"' : "";
      parts.push(`<span${cls}>${scaledCount} servings</span>`);
    }
    if (doc.prepMinutes) parts.push(`${doc.prepMinutes}m prep`);
    if (doc.cookMinutes) parts.push(`${doc.cookMinutes}m cook`);
    this._metaEl.className = parts.length > 0 ? "meta" : "";
    this._metaEl.innerHTML = parts.length > 0 ? parts.join(" \u00b7 ") : "";
  }

  private _renderIngredients() {
    if (!this._ingListEl || !this._doc) return;
    const ings = this._doc.ingredients ?? [];

    if (ings.length === 0) {
      this._ingListEl.innerHTML = `<div class="empty">No ingredients.</div>`;
      return;
    }

    this._ingListEl.innerHTML = `<ul>${ings.map((ing, i) => {
      const checked = this._checkedIngredients.has(i);
      const scaledRaw = scaleQty(ing.quantity, this._scaleFactor);
      const scaledNum = parseQty(scaledRaw);
      const overrideUnit = this._unitOverrides.get(i);
      let displayQty = escapeHtml(scaledRaw);
      let displayUnit = escapeHtml(ing.unit);
      let converted = false;

      if (scaledNum !== null) {
        let result: { qty: number; unit: string } | null = null;
        if (overrideUnit?.startsWith("~")) {
          const targetUnit = overrideUnit.slice(1);
          const ud = resolveUnit(ing.unit);
          const den = findDensity(ing.item);
          if (ud && den) result = convertViaDensity(scaledNum, ud.toBase, ud.dimension, targetUnit, den);
        } else if (overrideUnit) {
          result = convertToUnit(scaledNum, ing.unit, overrideUnit);
        } else if (this._unitSystem !== "original") {
          const sys = convertIngredient(scaledNum, ing.unit, this._unitSystem);
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
    }).join("")}</ul>`;

    // Event delegation for clicks
    const ul = this._ingListEl.querySelector("ul")!;
    ul.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;

      // Check-off
      const check = target.closest(".ing-check");
      if (check) {
        const li = check.closest("li") as HTMLElement;
        const idx = parseInt(li.dataset.ingIdx ?? "-1");
        if (idx < 0) return;
        if (this._checkedIngredients.has(idx)) this._checkedIngredients.delete(idx);
        else this._checkedIngredients.add(idx);
        li.classList.toggle("ing-checked", this._checkedIngredients.has(idx));
        return;
      }

      // Unit conversion picker
      const unitSpan = target.closest(".ing-unit.ing-convertible") as HTMLElement;
      if (unitSpan) {
        e.stopPropagation();
        const rect = unitSpan.getBoundingClientRect();
        this._showUnitPicker(unitSpan, rect.left, rect.bottom + 4);
      }
    });
  }

  private _renderMarkdown() {
    if (!this._doc) return;
    const ings = this._doc.ingredients ?? [];

    if (this._instrEl) {
      if (this._doc.instructions) {
        const html = DOMPurify.sanitize(marked.parse(this._doc.instructions) as string);
        this._instrEl.innerHTML = `<div class="markdown">${this._resolveIngredientRefs(html, ings)}</div>`;
      } else {
        this._instrEl.innerHTML = `<div class="empty">No instructions yet.</div>`;
      }
    }

    if (this._notesEl) {
      if (this._doc.notes) {
        const notesHtml = DOMPurify.sanitize(marked.parse(this._doc.notes) as string);
        this._notesEl.innerHTML = `<h4>Notes</h4><div class="markdown">${this._resolveIngredientRefs(notesHtml, ings)}</div>`;
      } else {
        this._notesEl.innerHTML = "";
      }
    }
  }

  private _resolveIngredientRefs(md: string, ingredients: Ingredient[]): string {
    // Strip <code> wrapping around @[] refs (LLM sometimes outputs `@[...]` with backticks)
    md = md.replace(/<code>(@\[[^\]]+\])<\/code>/g, "$1");
    return md.replace(/@\[([^\]]+)\]/g, (_match, name: string) => {
      const ing = ingredients.find((i) => i.item.toLowerCase() === name.toLowerCase());
      if (!ing) {
        return `<span class="ing-ref ing-ref-broken">${escapeHtml(name)}</span>`;
      }
      const scaledRaw = scaleQty(ing.quantity, this._scaleFactor);
      const scaledNum = parseQty(scaledRaw);
      let displayQty = escapeHtml(scaledRaw);
      let displayUnit = escapeHtml(ing.unit);

      if (scaledNum !== null) {
        const idx = ingredients.indexOf(ing);
        const overrideUnit = this._unitOverrides.get(idx);
        let result: { qty: number; unit: string } | null = null;
        if (overrideUnit?.startsWith("~")) {
          const targetUnit = overrideUnit.slice(1);
          const ud = resolveUnit(ing.unit);
          const den = findDensity(ing.item);
          if (ud && den) result = convertViaDensity(scaledNum, ud.toBase, ud.dimension, targetUnit, den);
        } else if (overrideUnit) {
          result = convertToUnit(scaledNum, ing.unit, overrideUnit);
        } else if (this._unitSystem !== "original") {
          const sys = convertIngredient(scaledNum, ing.unit, this._unitSystem);
          if (sys.unit !== ing.unit) result = sys;
        }
        if (result) {
          displayQty = escapeHtml(formatQty(result.qty, isDecimalUnit(result.unit)));
          displayUnit = escapeHtml(result.unit);
        }
      }

      const parts = [displayQty, displayUnit, escapeHtml(ing.item)].filter(Boolean);
      const suffix = ing.optional ? " (if adding)" : "";
      return `<span class="ing-ref">${parts.join(" ")}${suffix}</span>`;
    });
  }

  private _showUnitPicker(unitSpan: HTMLElement, x: number, y: number) {
    const li = unitSpan.closest("li") as HTMLElement;
    const idx = parseInt(li.dataset.ingIdx ?? "-1");
    if (idx < 0) return;
    const rawUnit = li.dataset.origUnit;
    if (!rawUnit || !resolveUnit(rawUnit)) return;

    const targets = getConversionTargets(rawUnit);
    if (targets.length === 0) return;

    this._closePicker();

    const menu = document.createElement("div");
    menu.className = "dropdown-menu unit-picker";
    menu.setAttribute("role", "menu");

    // "Original" reset option
    const origBtn = document.createElement("button");
    origBtn.className = "dropdown-item" + (!this._unitOverrides.has(idx) && this._unitSystem === "original" ? " unit-active" : "");
    origBtn.textContent = rawUnit + " (original)";
    origBtn.setAttribute("role", "menuitem");
    origBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._unitOverrides.delete(idx);
      this._closePicker();
      this._renderIngredients();
      this._renderMarkdown();
    });
    menu.appendChild(origBtn);

    const ing = this._doc?.ingredients?.[idx];
    const rawQty = ing?.quantity ?? "";
    const itemName = ing?.item ?? "";
    const scaledNum = parseQty(scaleQty(rawQty, this._scaleFactor));

    type PickerEntry = { qty: number; label: string; overrideKey: string; group: "metric" | "imperial" | "density" };
    const entries: PickerEntry[] = [];

    for (const t of targets) {
      const converted = scaledNum !== null ? convertToUnit(scaledNum, rawUnit, t.unit) : null;
      if (!converted || converted.qty < 0.1 || converted.qty > 999) continue;
      entries.push({ qty: converted.qty, label: `${formatQty(converted.qty, isDecimalUnit(t.unit))} ${t.label}`, overrideKey: t.unit, group: t.system });
    }

    const unitDef = resolveUnit(rawUnit);
    const density = findDensity(itemName);
    if (density && unitDef && scaledNum !== null) {
      const targetUnits = unitDef.dimension === "volume" ? WEIGHT_UNITS : VOLUME_UNITS;
      for (const [unit] of targetUnits) {
        const result = convertViaDensity(scaledNum, unitDef.toBase, unitDef.dimension, unit, density);
        if (!result || result.qty < 0.1 || result.qty > 999) continue;
        entries.push({ qty: result.qty, label: `~${formatQty(result.qty, true)} ${unit}`, overrideKey: `~${unit}`, group: "density" });
      }
    }

    const refQty = scaledNum ?? 1;
    const byCloseness = (a: PickerEntry, b: PickerEntry) =>
      Math.abs(Math.log(a.qty / refQty)) - Math.abs(Math.log(b.qty / refQty));

    const sourceSystem = unitDef?.system;
    const groupOrder: ("metric" | "imperial" | "density")[] =
      sourceSystem === "metric" ? ["imperial", "metric", "density"] : ["metric", "imperial", "density"];
    const GROUP_LABELS: Record<string, string> = { metric: "Metric", imperial: "Imperial", density: "By weight" };
    if (unitDef?.dimension === "weight") GROUP_LABELS.density = "By volume";

    for (const group of groupOrder) {
      const groupEntries = entries.filter(e => e.group === group).sort(byCloseness);
      if (groupEntries.length === 0) continue;

      const groupSep = document.createElement("div");
      groupSep.className = "dropdown-sep";
      menu.appendChild(groupSep);
      const groupLabel = document.createElement("div");
      groupLabel.className = "dropdown-group-label";
      groupLabel.textContent = GROUP_LABELS[group] ?? group;
      menu.appendChild(groupLabel);

      for (const entry of groupEntries) {
        const btn = document.createElement("button");
        btn.className = "dropdown-item" + (this._unitOverrides.get(idx) === entry.overrideKey ? " unit-active" : "");
        btn.textContent = entry.label;
        btn.setAttribute("role", "menuitem");
        const key = entry.overrideKey;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._unitOverrides.set(idx, key);
          this._closePicker();
          this._renderIngredients();
          this._renderMarkdown();
        });
        menu.appendChild(btn);
      }
    }

    document.body.appendChild(menu);
    menu.style.position = "fixed";
    menu.style.zIndex = "300";
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;

    this._activePicker = menu;

    requestAnimationFrame(() => {
      const first = menu.querySelector(".dropdown-item") as HTMLButtonElement;
      first?.focus();
    });

    // Close on outside click / Escape
    this._docClickHandler = (e: MouseEvent) => {
      if (this._activePicker && !this._activePicker.contains(e.target as Node)) this._closePicker();
    };
    this._docKeyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this._activePicker) this._closePicker();
    };
    document.addEventListener("click", this._docClickHandler);
    document.addEventListener("keydown", this._docKeyHandler);
  }

  private _closePicker() {
    if (this._activePicker) {
      this._activePicker.remove();
      this._activePicker = null;
    }
    if (this._docClickHandler) {
      document.removeEventListener("click", this._docClickHandler);
      this._docClickHandler = null;
    }
    if (this._docKeyHandler) {
      document.removeEventListener("keydown", this._docKeyHandler);
      this._docKeyHandler = null;
    }
  }
}

customElements.define("recipe-preview", RecipePreview);
