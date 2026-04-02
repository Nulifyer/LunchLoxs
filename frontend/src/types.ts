/** Book (vault) -- a collection of recipes with its own encryption key */
export interface Book {
  vaultId: string;
  name: string;
  role: string;
  encKey?: CryptoKey;
}

/** Lightweight catalog entry for sidebar display and search */
export interface CatalogEntry {
  id: string;
  title: string;
  tags: string[];
}

/** Book catalog Automerge document -- minimal, just IDs + display data */
export interface BookCatalog {
  name: string;
  recipes: CatalogEntry[];
  /** userId -> display name (username), shared among vault members */
  members?: Record<string, string>;
}

/** Unified recipe Automerge document -- meta + content in one doc */
export interface Recipe {
  // Meta
  title: string;
  tags: string[];
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  createdAt: number;
  updatedAt: number;
  // Content
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

// -- Backward-compatible aliases for migration --
/** @deprecated Use CatalogEntry */
export type RecipeMeta = CatalogEntry & {
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  createdAt: number;
  updatedAt: number;
};
/** @deprecated Use BookCatalog */
export type RecipeCatalog = {
  name: string;
  recipes: RecipeMeta[];
  members?: Record<string, string>;
};
/** @deprecated Use Recipe */
export type RecipeContent = {
  description: string;
  ingredients: Array<{ item: string; quantity: string; unit: string }>;
  instructions: string;
  imageUrls: string[];
  notes: string;
};
