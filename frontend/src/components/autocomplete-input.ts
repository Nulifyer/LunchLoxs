/**
 * <autocomplete-input> — reusable web component for a text input with suggestions dropdown.
 *
 * Attributes:
 *   placeholder  – placeholder text for the inner input
 *   value        – initial value
 *
 * Properties:
 *   value: string          – get/set the current value
 *   suggestions: string[]  – set the pool of suggestions to offer
 *
 * Events:
 *   input  – fired on every keystroke / selection (mirrors native input)
 *   change – fired when a suggestion is selected or input is committed on blur
 */

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
<style>
  :host {
    display: inline-block;
    position: relative;
    flex: 1;
  }

  input {
    all: unset;
    box-sizing: border-box;
    width: 100%;
    font: inherit;
    font-size: inherit;
    color: inherit;
    line-height: inherit;
    padding: inherit;
  }

  input::placeholder {
    color: var(--muted);
  }

  .dropdown {
    display: none;
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    margin-top: 2px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 10rem;
    overflow-y: auto;
    z-index: 200;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .dropdown.open {
    display: block;
  }

  .dropdown .opt {
    padding: 0.35rem 0.6rem;
    font-size: 0.85rem;
    color: var(--text);
    cursor: pointer;
    text-transform: capitalize;
  }

  .dropdown .opt.active {
    background: var(--bg-hover);
  }

  .dropdown .opt:hover {
    background: var(--bg-hover);
  }
</style>
<input type="text" autocomplete="off" />
<div class="dropdown"></div>
`;

export class AutocompleteInput extends HTMLElement {
  private _suggestions: string[] = [];
  private _activeIdx = -1;

  private root: ShadowRoot;
  private input!: HTMLInputElement;
  private dropdown!: HTMLDivElement;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.appendChild(TEMPLATE.content.cloneNode(true));
  }

  connectedCallback() {
    this.input = this.root.querySelector("input")!;
    this.dropdown = this.root.querySelector(".dropdown")!;

    if (this.hasAttribute("placeholder")) {
      this.input.placeholder = this.getAttribute("placeholder")!;
    }
    if (this.hasAttribute("value")) {
      this.input.value = this.getAttribute("value")!;
    }

    this.input.addEventListener("focus", () => this._showDropdown());

    this.input.addEventListener("blur", () => {
      // Delay hiding so click on dropdown registers
      setTimeout(() => this._hideDropdown(), 150);
    });

    this.input.addEventListener("input", () => {
      this._showDropdown();
      this.dispatchEvent(new Event("input", { bubbles: true }));
    });

    this.input.addEventListener("keydown", (e) => this._onKeydown(e));
  }

  // -- Public API --

  get value(): string {
    return this.input?.value ?? this.getAttribute("value") ?? "";
  }

  set value(v: string) {
    if (this.input) this.input.value = v;
  }

  get suggestions(): string[] {
    return this._suggestions;
  }

  set suggestions(s: string[]) {
    this._suggestions = [...new Set(s.map((t) => t.toLowerCase().trim()).filter(Boolean))].sort();
  }

  /** Proxy focus to the inner input. */
  override focus() {
    this.input?.focus();
  }

  /** Expose selectionStart for focus-restoration. */
  get selectionStart(): number | null {
    return this.input?.selectionStart ?? null;
  }

  setSelectionRange(start: number, end: number) {
    this.input?.setSelectionRange(start, end);
  }

  // -- Internals --

  private _filteredOptions(): string[] {
    const q = this.input.value.toLowerCase().trim();
    return this._suggestions.filter((t) => {
      if (t === q) return false; // don't suggest exact current value
      return !q || t.includes(q);
    });
  }

  private _showDropdown() {
    const opts = this._filteredOptions();
    this._activeIdx = -1;
    this.dropdown.innerHTML = "";

    if (opts.length === 0) {
      this.dropdown.classList.remove("open");
      return;
    }

    const limit = Math.min(opts.length, 8);
    for (let i = 0; i < limit; i++) {
      const text = opts[i]!;
      const div = document.createElement("div");
      div.className = "opt";
      div.dataset.idx = String(i);
      div.textContent = text;
      div.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur
        this._selectOption(text);
      });
      this.dropdown.appendChild(div);
    }
    this.dropdown.classList.add("open");
  }

  private _hideDropdown() {
    this.dropdown.classList.remove("open");
    this._activeIdx = -1;
  }

  private _selectOption(text: string) {
    this.input.value = text;
    this._hideDropdown();
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
    this.input.focus();
  }

  private _onKeydown(e: KeyboardEvent) {
    const opts = this.dropdown.querySelectorAll(".opt");
    const count = opts.length;
    const dropdownOpen = this.dropdown.classList.contains("open");

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!dropdownOpen) { this._showDropdown(); return; }
      this._activeIdx = this._activeIdx < count - 1 ? this._activeIdx + 1 : 0;
      this._highlightActive(opts);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!dropdownOpen) return;
      this._activeIdx = this._activeIdx > 0 ? this._activeIdx - 1 : count - 1;
      this._highlightActive(opts);
    } else if (e.key === "Enter") {
      if (dropdownOpen && this._activeIdx >= 0 && this._activeIdx < count) {
        e.preventDefault();
        const filtered = this._filteredOptions();
        this._selectOption(filtered[this._activeIdx]!);
      }
      // If no active option, let Enter propagate (e.g. for ghost row commit)
    } else if (e.key === "Tab") {
      if (dropdownOpen && count > 0) {
        e.preventDefault();
        const filtered = this._filteredOptions();
        // Accept the highlighted option, or the first one if none highlighted
        const idx = this._activeIdx >= 0 ? this._activeIdx : 0;
        this._selectOption(filtered[idx]!);
      }
    } else if (e.key === "Escape") {
      if (dropdownOpen) {
        e.preventDefault();
        this._hideDropdown();
      }
    }
  }

  private _highlightActive(opts: NodeListOf<Element>) {
    opts.forEach((el, i) => el.classList.toggle("active", i === this._activeIdx));
    if (this._activeIdx >= 0) {
      opts[this._activeIdx]?.scrollIntoView({ block: "nearest" });
    }
  }
}

customElements.define("autocomplete-input", AutocompleteInput);
