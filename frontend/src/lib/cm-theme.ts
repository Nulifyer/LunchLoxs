/**
 * CodeMirror theme that reads from our CSS custom properties.
 * Covers all selectors and highlight tags from @codemirror/theme-one-dark.
 */

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const appTheme = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--bg-input)",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--bg-hover)",
  },
  ".cm-panels": {
    backgroundColor: "var(--bg-surface)",
    color: "var(--text)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "2px solid var(--border)",
  },
  ".cm-panels.cm-panels-bottom": {
    borderTop: "2px solid var(--border)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)",
    outline: "1px solid var(--accent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 15%, transparent)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 4%, transparent)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--green) 10%, transparent)",
  },
  "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-surface)",
    color: "var(--muted)",
    border: "none",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--bg-hover)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--muted)",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-surface)",
    color: "var(--text)",
  },
  ".cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
  },
  ".cm-tooltip .cm-tooltip-arrow:after": {
    borderTopColor: "var(--bg-surface)",
    borderBottomColor: "var(--bg-surface)",
  },
  ".cm-tooltip-autocomplete": {
    "& > ul > li[aria-selected]": {
      backgroundColor: "var(--bg-hover)",
      color: "var(--text)",
    },
  },
}, { dark: true });

const appHighlight = HighlightStyle.define([
  // Keywords, control flow
  { tag: t.keyword, color: "var(--purple)" },

  // Names, properties, characters
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "var(--red)" },

  // Functions, labels
  { tag: [t.function(t.variableName), t.labelName], color: "var(--accent)" },

  // Constants, standard names
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--yellow)" },

  // Definitions, separators
  { tag: [t.definition(t.name), t.separator], color: "var(--text)" },

  // Types, classes, numbers, annotations
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "var(--yellow)" },

  // Operators, URLs, regex, escape, links
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "var(--cyan)" },

  // Comments, meta
  { tag: [t.meta, t.comment], color: "var(--muted)", fontStyle: "italic" },

  // Formatting
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },

  // Links (override the cyan above with underline)
  { tag: t.link, color: "var(--cyan)", textDecoration: "underline" },

  // Headings
  { tag: t.heading, fontWeight: "bold", color: "var(--accent)" },
  { tag: t.heading1, fontWeight: "bold", color: "var(--accent)", fontSize: "1.3em" },
  { tag: t.heading2, fontWeight: "bold", color: "var(--accent)", fontSize: "1.15em" },

  // Atoms, booleans, special variables
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--yellow)" },

  // Strings, inserted text
  { tag: [t.processingInstruction, t.string, t.inserted], color: "var(--green)" },

  // Invalid
  { tag: t.invalid, color: "var(--red)" },

  // Quotes (markdown blockquotes)
  { tag: t.quote, color: "var(--subtle)", fontStyle: "italic" },

  // Monospace/code (markdown inline code)
  { tag: t.monospace, color: "var(--green)", fontFamily: "var(--font-mono)" },

  // List markers
  { tag: t.list, color: "var(--accent)" },
]);

export const appSyntaxHighlighting = syntaxHighlighting(appHighlight);
