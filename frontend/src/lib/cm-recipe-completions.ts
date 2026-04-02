/**
 * CodeMirror completion source for recipe reference autocomplete.
 *
 * Triggers when the user types `#[` and offers recipe names.
 * On accept, inserts `#[Recipe Name](vaultId/recipeId)`.
 */

import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";

export interface RecipeEntry {
  id: string;
  title: string;
}

/**
 * Create a completion source that autocompletes recipe references.
 * @param getRecipes - returns the current list of recipe catalog entries
 * @param getVaultId - returns the current vault ID
 * @param getCurrentRecipeId - returns the current recipe ID (to exclude self)
 */
export function recipeCompletionSource(
  getRecipes: () => RecipeEntry[],
  getVaultId: () => string,
  getCurrentRecipeId: () => string,
): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const textBefore = line.text.slice(0, ctx.pos - line.from);

    // Find the last unclosed `#[` in the line
    const trigger = textBefore.lastIndexOf("#[");
    if (trigger < 0) return null;

    // Make sure there's no closing `]` between the trigger and cursor
    const afterTrigger = textBefore.slice(trigger + 2);
    if (afterTrigger.includes("]")) return null;

    // Don't trigger if preceded by `@` (ingredient ref)
    if (trigger > 0 && textBefore[trigger - 1] === "@") return null;

    const from = line.from + trigger;
    const query = afterTrigger.toLowerCase();
    const vaultId = getVaultId();
    const currentId = getCurrentRecipeId();

    const recipes = getRecipes();
    const options = recipes
      .filter((r) => r.id !== currentId) // exclude self
      .filter((r) => !query || r.title.toLowerCase().includes(query))
      .map((r) => ({
        label: r.title,
        apply: `#[${r.title}](${vaultId}/${r.id})`,
        type: "text" as const,
      }));

    if (options.length === 0) return null;

    return {
      from,
      to: ctx.pos,
      options,
      filter: false,
    };
  };
}
