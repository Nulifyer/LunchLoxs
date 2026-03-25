/** Book (vault) -- a collection of recipes with its own encryption key */
export interface Book {
  vaultId: string;
  name: string;
  role: string;
  encKey?: CryptoKey;
}

/** Recipe catalog entry -- stored in the shared catalog Automerge doc */
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
  name: string;
  recipes: RecipeMeta[];
  /** userId -> display name (username), shared among vault members */
  members?: Record<string, string>;
}

/** Recipe content -- stored in its own Automerge doc (doc_id = recipe.id) */
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
