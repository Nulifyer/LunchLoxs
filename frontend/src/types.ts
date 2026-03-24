/** Recipe catalog entry — stored in the shared catalog Automerge doc */
export interface RecipeMeta {
  id: string;
  title: string;
  tags: string[];
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  createdAt: number;
  updatedAt: number;
}

/** Recipe catalog Automerge document */
export interface RecipeCatalog {
  recipes: RecipeMeta[];
}

/** Recipe content — stored in its own Automerge doc (doc_id = recipe.id) */
export interface RecipeContent {
  description: string;
  ingredients: Array<{
    item: string;
    quantity: string;
    unit: string;
  }>;
  instructions: string;
  imageUrls: string[];
  notes: string;
}
