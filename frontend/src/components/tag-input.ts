/**
 * <tag-input> — reusable web component for selecting/creating tags.
 *
 * Attributes:
 *   placeholder  – placeholder text for the inner input
 *
 * Properties:
 *   value: string[]       – get/set the selected tags
 *   suggestions: string[] – set the pool of existing tags to suggest
 *
 * Events:
 *   change – fired when tags are added or removed
 */

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
<style>
  :host {
    display: block;
    position: relative;
  }

  .wrap {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem 0.45rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: text;
    transition: border-color 0.15s;
    min-height: 1.85rem;
  }

  .wrap.focused {
    border-color: var(--accent);
  }

  .pill {
    display: inline-block;
    background: var(--border);
    color: var(--text);
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    font-size: 0.65rem;
    text-transform: capitalize;
    line-height: 1.4;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .pill:hover {
    background: var(--red, #f85149);
    color: #fff;
  }

  input {
    all: unset;
    flex: 1 1 4rem;
    min-width: 4rem;
    font: inherit;
    font-size: 0.85rem;
    color: var(--text);
    line-height: 1.5;
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

  .dropdown .opt .new-label {
    color: var(--subtle);
    font-size: 0.75rem;
    margin-left: 0.35rem;
  }
</style>
<div class="wrap">
  <input type="text" autocomplete="off" />
</div>
<div class="dropdown"></div>
`;

export class TagInput extends HTMLElement {
  private _tags: string[] = [];
  private _suggestions: string[] = [];
  private _activeIdx = -1;

  private root: ShadowRoot;
  private wrap!: HTMLDivElement;
  private input!: HTMLInputElement;
  private dropdown!: HTMLDivElement;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.appendChild(TEMPLATE.content.cloneNode(true));
  }

  connectedCallback() {
    this.wrap = this.root.querySelector(".wrap")!;
    this.input = this.root.querySelector("input")!;
    this.dropdown = this.root.querySelector(".dropdown")!;

    if (this.hasAttribute("placeholder")) {
      this.input.placeholder = this.getAttribute("placeholder")!;
    }

    this.wrap.addEventListener("click", () => this.input.focus());

    this.input.addEventListener("focus", () => {
      this.wrap.classList.add("focused");
      this._showDropdown();
    });

    this.input.addEventListener("blur", () => {
      this.wrap.classList.remove("focused");
      // Commit whatever is typed
      this._commitInput();
      // Delay hiding so click on dropdown registers
      setTimeout(() => this._hideDropdown(), 150);
    });

    this.input.addEventListener("input", () => this._showDropdown());

    this.input.addEventListener("keydown", (e) => this._onKeydown(e));
  }

  // -- Public API --

  get value(): string[] {
    return [...this._tags];
  }

  set value(tags: string[]) {
    this._tags = tags.map((t) => t.toLowerCase().trim()).filter(Boolean);
    this._tags = [...new Set(this._tags)].sort();
    this._renderPills();
  }

  get suggestions(): string[] {
    return this._suggestions;
  }

  set suggestions(s: string[]) {
    this._suggestions = [...new Set(s.map((t) => t.toLowerCase().trim()).filter(Boolean))].sort();
  }

  // -- Internals --

  private _commitInput() {
    const raw = this.input.value;
    if (!raw.trim()) return;
    // Support comma-separated paste
    const parts = raw.split(",").map((t) => t.toLowerCase().trim()).filter(Boolean);
    let changed = false;
    for (const tag of parts) {
      if (!this._tags.includes(tag)) {
        this._tags.push(tag);
        changed = true;
      }
    }
    if (changed) {
      this._tags.sort();
      this._renderPills();
      this._emit();
    }
    this.input.value = "";
  }

  private _addTag(tag: string) {
    const t = tag.toLowerCase().trim();
    if (!t || this._tags.includes(t)) return;
    this._tags.push(t);
    this._tags.sort();
    this.input.value = "";
    this._renderPills();
    this._hideDropdown();
    this._emit();
    this.input.focus();
  }

  private _removeTag(tag: string) {
    const idx = this._tags.indexOf(tag);
    if (idx === -1) return;
    this._tags.splice(idx, 1);
    this._renderPills();
    this._emit();
  }

  private _emit() {
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }

  private _renderPills() {
    // Remove existing pills
    for (const pill of [...this.wrap.querySelectorAll(".pill")]) pill.remove();
    // Insert before input
    for (const tag of this._tags) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = tag;
      pill.title = "Click to remove";
      pill.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur
        this._removeTag(tag);
      });
      this.wrap.insertBefore(pill, this.input);
    }
  }

  private _filteredOptions(): { tag: string; isNew: boolean }[] {
    const q = this.input.value.toLowerCase().trim();
    const selected = new Set(this._tags);

    // Filter suggestions
    let matches = this._suggestions
      .filter((t) => !selected.has(t))
      .filter((t) => !q || t.includes(q));

    const result: { tag: string; isNew: boolean }[] = matches.map((t) => ({ tag: t, isNew: false }));

    // If query doesn't match any suggestion exactly, offer "create new"
    if (q && !this._suggestions.includes(q) && !selected.has(q)) {
      result.unshift({ tag: q, isNew: true });
    }

    return result;
  }

  private _showDropdown() {
    const opts = this._filteredOptions();
    this._activeIdx = -1;
    this.dropdown.innerHTML = "";

    if (opts.length === 0) {
      this.dropdown.classList.remove("open");
      return;
    }

    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i]!;
      const div = document.createElement("div");
      div.className = "opt";
      div.dataset.idx = String(i);
      div.textContent = opt.tag;
      if (opt.isNew) {
        const span = document.createElement("span");
        span.className = "new-label";
        span.textContent = "(new)";
        div.appendChild(span);
      }
      div.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur
        this._addTag(opt.tag);
      });
      this.dropdown.appendChild(div);
    }
    this.dropdown.classList.add("open");
  }

  private _hideDropdown() {
    this.dropdown.classList.remove("open");
    this._activeIdx = -1;
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
      e.preventDefault();
      if (dropdownOpen && this._activeIdx >= 0 && this._activeIdx < count) {
        const filtered = this._filteredOptions();
        this._addTag(filtered[this._activeIdx]!.tag);
      } else {
        this._commitInput();
        this._showDropdown();
      }
    } else if (e.key === "," || e.key === "Tab") {
      if (this.input.value.trim()) {
        e.preventDefault();
        this._commitInput();
        this._showDropdown();
      }
    } else if (e.key === "Backspace" && !this.input.value && this._tags.length) {
      this._removeTag(this._tags[this._tags.length - 1]!);
    } else if (e.key === "Escape") {
      this._hideDropdown();
    }
  }

  private _highlightActive(opts: NodeListOf<Element>) {
    opts.forEach((el, i) => el.classList.toggle("active", i === this._activeIdx));
    if (this._activeIdx >= 0) {
      opts[this._activeIdx]?.scrollIntoView({ block: "nearest" });
    }
  }
}

customElements.define("tag-input", TagInput);
