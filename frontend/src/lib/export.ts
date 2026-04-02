/**
 * Export a recipe book as a ZIP of markdown files.
 * Import from a ZIP back into a book.
 *
 * Ingredients use a pipe-delimited markdown table for lossless round-trip:
 *   | Qty   | Unit  | Ingredient       |
 *   |-------|-------|------------------|
 *   | 2 1/4 | cups  | all-purpose flour|
 */

import JSZip from "jszip";
import type { CatalogEntry, Recipe, RecipeMeta, RecipeContent } from "../types";
import type { AutomergeStore } from "./automerge-store";
import type { DocumentManager } from "./document-manager";

/** Parse a simple YAML key: "value" or key: value from a string. Handles escaped quotes. */
function parseYamlString(yaml: string, key: string): string | null {
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key + ":")) continue;
    let val = trimmed.slice(key.length + 1).trim();
    // Remove surrounding quotes and unescape
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    return val;
  }
  return null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    || "untitled";
}

type Ingredient = { quantity: string; unit: string; item: string };

function buildIngredientTable(ingredients: Ingredient[]): string {
  if (ingredients.length === 0) return "";

  // Calculate column widths for alignment
  const qw = Math.max(3, ...ingredients.map((i) => i.quantity.length));
  const uw = Math.max(4, ...ingredients.map((i) => i.unit.length));
  const iw = Math.max(10, ...ingredients.map((i) => i.item.length));

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

  const header = `| ${pad("Qty", qw)} | ${pad("Unit", uw)} | ${pad("Ingredient", iw)} |`;
  const sep = `| ${"-".repeat(qw)} | ${"-".repeat(uw)} | ${"-".repeat(iw)} |`;
  const rows = ingredients.map((i) =>
    `| ${pad(i.quantity, qw)} | ${pad(i.unit, uw)} | ${pad(i.item, iw)} |`
  );

  return [header, sep, ...rows].join("\n");
}

function parseIngredientTable(text: string): Ingredient[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const ingredients: Ingredient[] = [];

  for (const line of lines) {
    // Skip header and separator rows
    if (!line.startsWith("|")) continue;
    if (/^\|[\s-|]+\|$/.test(line)) continue;
    if (/\|\s*Qty\s*\|/i.test(line)) continue;

    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 3) {
      ingredients.push({ quantity: cells[0]!, unit: cells[1]!, item: cells[2]! });
    } else if (cells.length === 2) {
      ingredients.push({ quantity: cells[0]!, unit: "", item: cells[1]! });
    } else if (cells.length === 1) {
      ingredients.push({ quantity: "", unit: "", item: cells[0]! });
    }
  }

  return ingredients;
}

export function recipeToMarkdown(recipe: Recipe): string {
  const frontmatter = [
    "---",
    `title: "${recipe.title.replace(/"/g, '\\"')}"`,
    `tags: [${(recipe.tags ?? []).map((t) => `"${t.replace(/"/g, '\\"')}"`).join(", ")}]`,
    `servings: ${recipe.servings ?? 4}`,
    `prepMinutes: ${recipe.prepMinutes ?? 0}`,
    `cookMinutes: ${recipe.cookMinutes ?? 0}`,
    `createdAt: ${new Date(recipe.createdAt || 0).toISOString()}`,
    `updatedAt: ${new Date(recipe.updatedAt || 0).toISOString()}`,
    "---",
  ].join("\n");

  const sections: string[] = [frontmatter, ""];

  if (recipe.description) {
    sections.push(recipe.description, "");
  }

  const ingredients = recipe.ingredients ?? [];
  if (ingredients.length > 0) {
    sections.push("## Ingredients", "");
    sections.push(buildIngredientTable(ingredients), "");
  }

  const instructions = (recipe.instructions ?? "").trim();
  if (instructions) {
    sections.push("## Instructions", "", instructions, "");
  }

  const notes = (recipe.notes ?? "").trim();
  if (notes) {
    sections.push("## Notes", "", notes, "");
  }

  return sections.join("\n");
}

export async function exportBook(
  bookName: string,
  vaultId: string,
  entries: CatalogEntry[],
  docMgr: DocumentManager,
): Promise<Blob> {
  const zip = new JSZip();
  const folder = zip.folder(bookName)!;

  const bookMeta = [
    `name: "${bookName.replace(/"/g, '\\"')}"`,
    `exportedAt: "${new Date().toISOString()}"`,
    `format: "recipepwa-v1"`,
    `recipeCount: ${entries.length}`,
  ].join("\n");
  folder.file("_book.yaml", bookMeta);

  const usedNames = new Set<string>();

  for (const entry of entries) {
    let baseName = slugify(entry.title);
    let fileName = baseName;
    let counter = 1;
    while (usedNames.has(fileName)) {
      fileName = `${baseName}-${counter++}`;
    }
    usedNames.add(fileName);

    const recipeDocId = `${vaultId}/${entry.id}`;
    let recipeStore = docMgr.get<Recipe>(recipeDocId);
    let needsClose = false;
    if (!recipeStore) {
      try {
        recipeStore = await docMgr.open<Recipe>(recipeDocId, (doc) => {
          doc.title = entry.title; doc.tags = [] as any; doc.servings = 4;
          doc.prepMinutes = 0; doc.cookMinutes = 0; doc.createdAt = 0; doc.updatedAt = 0;
          doc.description = ""; doc.ingredients = []; doc.instructions = "";
          doc.imageUrls = []; doc.notes = "";
        });
        needsClose = true;
      } catch {
        recipeStore = null;
      }
    }

    if (recipeStore) {
      const recipe = recipeStore.getDoc();
      folder.file(`${fileName}.md`, recipeToMarkdown(recipe));
      if (needsClose) docMgr.close(recipeDocId);
    }
  }

  return zip.generateAsync({ type: "blob" });
}

/**
 * Parse a recipe markdown file back into metadata + content.
 */
export function parseRecipeMarkdown(md: string): { meta: Partial<RecipeMeta>; content: Partial<RecipeContent> } | null {
  // Normalize line endings
  const normalized = md.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1]!;
  const body = fmMatch[2]!;

  const meta: Partial<RecipeMeta> = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal!.replace(/^"(.*)"$/, "$1");
    switch (key) {
      case "title": meta.title = val; break;
      case "servings": meta.servings = parseInt(val) || 4; break;
      case "prepMinutes": meta.prepMinutes = parseInt(val) || 0; break;
      case "cookMinutes": meta.cookMinutes = parseInt(val) || 0; break;
      case "tags": {
        const tagMatch = rawVal!.match(/\[([^\]]*)\]/);
        if (tagMatch) {
          meta.tags = tagMatch[1]!.split(",").map((t) => t.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
        }
        break;
      }
      case "createdAt": meta.createdAt = new Date(val).getTime() || Date.now(); break;
      case "updatedAt": meta.updatedAt = new Date(val).getTime() || Date.now(); break;
    }
  }

  const content: Partial<RecipeContent> = {};

  // Split body into sections by ## headings
  const rawSections = body.split(/^## /m);
  // First element is text before any heading (description)
  const preHeading = rawSections[0]?.trim();
  if (preHeading) content.description = preHeading;

  for (let i = 1; i < rawSections.length; i++) {
    const section = rawSections[i]!;
    const newlineIdx = section.indexOf("\n");
    if (newlineIdx === -1) continue;
    const heading = section.slice(0, newlineIdx).trim().toLowerCase();
    const sectionBody = section.slice(newlineIdx + 1).trim();

    switch (heading) {
      case "ingredients":
        // Try table format first (pipe-delimited)
        if (sectionBody.includes("|")) {
          content.ingredients = parseIngredientTable(sectionBody);
        } else {
          // Fallback: list format (- qty unit item)
          content.ingredients = sectionBody.split("\n")
            .filter((l) => l.startsWith("- "))
            .map((l) => {
              const text = l.slice(2).trim();
              return { quantity: "", unit: "", item: text };
            });
        }
        break;
      case "instructions":
        content.instructions = sectionBody;
        break;
      case "notes":
        content.notes = sectionBody;
        break;
    }
  }

  return { meta, content };
}

export interface ImportedBook {
  name: string;
  recipes: Array<{ meta: Partial<RecipeMeta>; content: Partial<RecipeContent> }>;
}

/**
 * Import recipes from a ZIP file.
 * If the zip has subfolders, each folder becomes a separate book.
 * If no subfolders, all recipes go into a single unnamed book.
 */
export async function importFromZip(file: File): Promise<ImportedBook[]> {
  const zip = await JSZip.loadAsync(file);
  const bookMap = new Map<string, ImportedBook>();

  // First pass: read _book.yaml files for book names
  const folderNames = new Map<string, string>();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const parts = path.split("/");
    if (parts[parts.length - 1] === "_book.yaml" && parts.length >= 2) {
      const folder = parts.slice(0, -1).join("/");
      const yaml = await entry.async("string");
      const name = parseYamlString(yaml, "name");
      if (name) folderNames.set(folder, name);
    }
  }

  // Second pass: read recipes
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !path.endsWith(".md")) continue;
    const text = await entry.async("string");
    const parsed = parseRecipeMarkdown(text);
    if (!parsed) continue;

    const parts = path.split("/");
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const bookName = folderNames.get(folder) || (parts.length > 1 ? parts[0]! : "");

    if (!bookMap.has(folder)) {
      bookMap.set(folder, { name: bookName, recipes: [] });
    }
    bookMap.get(folder)!.recipes.push(parsed);
  }

  return [...bookMap.values()];
}
