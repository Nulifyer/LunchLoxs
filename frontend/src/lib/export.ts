/**
 * Export a recipe book as a ZIP of markdown files.
 *
 * Each recipe becomes a single .md file with YAML frontmatter
 * containing metadata for round-trip import.
 */

import JSZip from "jszip";
import type { RecipeMeta, RecipeContent } from "../types";
import type { AutomergeStore } from "./automerge-store";
import type { DocumentManager } from "./document-manager";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    || "untitled";
}

function formatIngredient(ing: { quantity: string; unit: string; item: string }): string {
  const parts = [ing.quantity, ing.unit, ing.item].filter(Boolean);
  return `- ${parts.join(" ")}`;
}

function recipeToMarkdown(meta: RecipeMeta, content: RecipeContent): string {
  const frontmatter = [
    "---",
    `id: "${meta.id}"`,
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    `tags: [${meta.tags.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(", ")}]`,
    `servings: ${meta.servings}`,
    `prepMinutes: ${meta.prepMinutes}`,
    `cookMinutes: ${meta.cookMinutes}`,
    `createdAt: ${new Date(meta.createdAt).toISOString()}`,
    `updatedAt: ${new Date(meta.updatedAt).toISOString()}`,
    "---",
  ].join("\n");

  const sections: string[] = [frontmatter, ""];

  if (content.description) {
    sections.push(content.description, "");
  }

  const ingredients = content.ingredients ?? [];
  if (ingredients.length > 0) {
    sections.push("## Ingredients", "");
    sections.push(...ingredients.map(formatIngredient), "");
  }

  const instructions = (content.instructions ?? "").trim();
  if (instructions) {
    sections.push("## Instructions", "", instructions, "");
  }

  const notes = (content.notes ?? "").trim();
  if (notes) {
    sections.push("## Notes", "", notes, "");
  }

  return sections.join("\n");
}

export async function exportBook(
  bookName: string,
  vaultId: string,
  recipes: RecipeMeta[],
  docMgr: DocumentManager,
): Promise<Blob> {
  const zip = new JSZip();
  const folder = zip.folder(bookName)!;

  // Book metadata
  const bookMeta = [
    `name: "${bookName.replace(/"/g, '\\"')}"`,
    `exportedAt: "${new Date().toISOString()}"`,
    `format: "recipepwa-v1"`,
    `recipeCount: ${recipes.length}`,
  ].join("\n");
  folder.file("_book.yaml", bookMeta);

  // Track filenames to avoid collisions
  const usedNames = new Set<string>();

  for (const meta of recipes) {
    let baseName = slugify(meta.title);
    let fileName = baseName;
    let counter = 1;
    while (usedNames.has(fileName)) {
      fileName = `${baseName}-${counter++}`;
    }
    usedNames.add(fileName);

    // Try to get recipe content from open doc, or use empty defaults
    const contentDocId = `${vaultId}/${meta.id}`;
    let contentStore = docMgr.get<RecipeContent>(contentDocId);
    let needsClose = false;
    if (!contentStore) {
      try {
        contentStore = await docMgr.open<RecipeContent>(contentDocId, (doc) => {
          doc.description = "";
          doc.ingredients = [];
          doc.instructions = "";
          doc.imageUrls = [];
          doc.notes = "";
        });
        needsClose = true;
      } catch {
        contentStore = null;
      }
    }

    const content: RecipeContent = contentStore?.getDoc() ?? {
      description: "",
      ingredients: [],
      instructions: "",
      imageUrls: [],
      notes: "",
    };

    folder.file(`${fileName}.md`, recipeToMarkdown(meta, content));

    if (needsClose) {
      docMgr.close(contentDocId);
    }
  }

  return zip.generateAsync({ type: "blob" });
}

/**
 * Parse a recipe markdown file back into metadata + content.
 */
export function parseRecipeMarkdown(md: string): { meta: Partial<RecipeMeta>; content: Partial<RecipeContent> } | null {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  // Parse YAML frontmatter (simple key: value parsing)
  const meta: Partial<RecipeMeta> = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.replace(/^"(.*)"$/, "$1");
    switch (key) {
      case "id": meta.id = val; break;
      case "title": meta.title = val; break;
      case "servings": meta.servings = parseInt(val) || 4; break;
      case "prepMinutes": meta.prepMinutes = parseInt(val) || 0; break;
      case "cookMinutes": meta.cookMinutes = parseInt(val) || 0; break;
      case "tags": {
        const tagMatch = rawVal.match(/\[([^\]]*)\]/);
        if (tagMatch) {
          meta.tags = tagMatch[1].split(",").map((t) => t.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
        }
        break;
      }
      case "createdAt": meta.createdAt = new Date(val).getTime() || Date.now(); break;
      case "updatedAt": meta.updatedAt = new Date(val).getTime() || Date.now(); break;
    }
  }

  // Parse body sections
  const content: Partial<RecipeContent> = {};
  const sections = body.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const newlineIdx = section.indexOf("\n");
    if (newlineIdx === -1) continue;
    const heading = section.slice(0, newlineIdx).trim().toLowerCase();
    const sectionBody = section.slice(newlineIdx + 1).trim();

    switch (heading) {
      case "ingredients":
        content.ingredients = sectionBody.split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => {
            const text = l.slice(2).trim();
            const parts = text.split(/\s+/);
            if (parts.length >= 3) {
              return { quantity: parts[0], unit: parts[1], item: parts.slice(2).join(" ") };
            } else if (parts.length === 2) {
              return { quantity: parts[0], unit: "", item: parts[1] };
            }
            return { quantity: "", unit: "", item: text };
          });
        break;
      case "instructions":
        content.instructions = sectionBody;
        break;
      case "notes":
        content.notes = sectionBody;
        break;
    }
  }

  // Text before first ## heading is the description
  const preHeading = body.split(/^## /m)[0]?.trim();
  if (preHeading) {
    content.description = preHeading;
  }

  return { meta, content };
}

/**
 * Import recipes from a ZIP file.
 * Returns an array of parsed recipes ready to be inserted into a book.
 */
export async function importFromZip(file: File): Promise<Array<{ meta: Partial<RecipeMeta>; content: Partial<RecipeContent> }>> {
  const zip = await JSZip.loadAsync(file);
  const recipes: Array<{ meta: Partial<RecipeMeta>; content: Partial<RecipeContent> }> = [];

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !path.endsWith(".md")) continue;
    const text = await entry.async("string");
    const parsed = parseRecipeMarkdown(text);
    if (parsed) recipes.push(parsed);
  }

  return recipes;
}
