/**
 * CodeMirror extension for ingredient reference autocomplete.
 *
 * Triggers when the user types `@[` and offers ingredient names.
 * On accept, inserts `@[ingredient name]`.
 */

import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";

/**
 * Create a CM extension that autocompletes ingredient references.
 * @param getNames - returns the current list of ingredient item names
 */
export function ingredientCompletions(getNames: () => string[]) {
  function complete(ctx: CompletionContext): CompletionResult | null {
    // Look for `@[` before the cursor, possibly with partial text after it
    const line = ctx.state.doc.lineAt(ctx.pos);
    const textBefore = line.text.slice(0, ctx.pos - line.from);

    // Find the last unclosed `@[` in the line
    const trigger = textBefore.lastIndexOf("@[");
    if (trigger < 0) return null;

    // Make sure there's no closing `]` between the trigger and cursor
    const afterTrigger = textBefore.slice(trigger + 2);
    if (afterTrigger.includes("]")) return null;

    const from = line.from + trigger;
    const query = afterTrigger.toLowerCase();

    const names = getNames();
    const options = names
      .filter((n) => !query || n.toLowerCase().includes(query))
      .map((n) => ({
        label: n,
        apply: `@[${n}]`,
        type: "text" as const,
      }));

    if (options.length === 0) return null;

    return {
      from,
      to: ctx.pos,
      options,
      filter: false, // we already filtered
    };
  }

  return autocompletion({
    override: [complete],
    activateOnTyping: true,
  });
}
