/**
 * Fuzzy search across all books and recipes.
 * Scoring modeled after fzf's algorithm (V1 greedy with proper bonus/penalty system).
 */

// -- fzf scoring constants --
const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 8;
const BONUS_BOUNDARY_WHITE = 10;
const BONUS_BOUNDARY_DELIMITER = 9;
const BONUS_CAMEL_123 = 7;
const BONUS_CONSECUTIVE = 4;
const BONUS_NON_WORD = 8;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;

// -- Character classes --
const CH_WHITE = 0;
const CH_NON_WORD = 1;
const CH_DELIM = 2;
const CH_LOWER = 3;
const CH_UPPER = 4;
const CH_NUMBER = 5;

function charClass(c: string): number {
  if (c === " " || c === "\t" || c === "\n" || c === "\r") return CH_WHITE;
  if (c >= "a" && c <= "z") return CH_LOWER;
  if (c >= "A" && c <= "Z") return CH_UPPER;
  if (c >= "0" && c <= "9") return CH_NUMBER;
  if (",;:|/".includes(c)) return CH_DELIM;
  return CH_NON_WORD;
}

function bonusFor(prevClass: number, curClass: number): number {
  if (curClass === CH_WHITE) return BONUS_BOUNDARY_WHITE;
  if (curClass === CH_NON_WORD || curClass === CH_DELIM) return BONUS_NON_WORD;
  if (curClass >= CH_LOWER) {
    // Current is a word character
    if (prevClass === CH_WHITE) return BONUS_BOUNDARY_WHITE;
    if (prevClass === CH_DELIM) return BONUS_BOUNDARY_DELIMITER;
    if (prevClass === CH_NON_WORD) return BONUS_BOUNDARY;
    if (prevClass === CH_LOWER && curClass === CH_UPPER) return BONUS_CAMEL_123;
    if (prevClass !== CH_NUMBER && curClass === CH_NUMBER) return BONUS_CAMEL_123;
  }
  return 0;
}

/**
 * fzf V1: greedy forward match, backward contraction, then score.
 * Returns score (0 = no match) and the matched positions.
 */
function fzfScore(pattern: string, text: string): number {
  const pLen = pattern.length;
  const tLen = text.length;
  if (pLen === 0) return 0;
  if (pLen > tLen) return 0;

  // Forward pass: find first occurrence of each pattern char
  let pi = 0;
  let startIdx = -1;
  let endIdx = -1;
  for (let ti = 0; ti < tLen && pi < pLen; ti++) {
    if (text[ti].toLowerCase() === pattern[pi]) {
      if (pi === 0) startIdx = ti;
      pi++;
      if (pi === pLen) endIdx = ti + 1;
    }
  }
  if (pi < pLen) return 0; // Not all pattern chars matched

  // Backward contraction: find the shortest substring ending at endIdx
  pi = pLen - 1;
  for (let ti = endIdx - 1; ti >= startIdx && pi >= 0; ti--) {
    if (text[ti].toLowerCase() === pattern[pi]) {
      pi--;
      if (pi < 0) startIdx = ti;
    }
  }

  // Score the match region
  let score = 0;
  let consecutive = 0;
  let firstBonus = 0;
  let prevClass = startIdx > 0 ? charClass(text[startIdx - 1]) : CH_WHITE;
  pi = 0;

  for (let ti = startIdx; ti < endIdx && pi < pLen; ti++) {
    const curClass = charClass(text[ti]);
    if (text[ti].toLowerCase() === pattern[pi]) {
      const bonus = bonusFor(prevClass, curClass);
      score += SCORE_MATCH;

      if (pi === 0) {
        // First pattern char gets multiplied bonus
        score += bonus * BONUS_FIRST_CHAR_MULTIPLIER;
        firstBonus = bonus;
      } else if (consecutive > 0) {
        // Consecutive: propagate the first bonus of this chunk
        const consBonus = Math.max(bonus, BONUS_CONSECUTIVE, firstBonus);
        score += consBonus;
      } else {
        // Non-consecutive
        score += bonus;
        firstBonus = bonus;
      }

      if (consecutive === 0 || bonus > firstBonus) {
        firstBonus = bonus;
      }
      consecutive++;
      pi++;
    } else {
      // Gap
      if (consecutive > 0) {
        score += SCORE_GAP_START;
        consecutive = 0;
      } else {
        score += SCORE_GAP_EXTENSION;
      }
    }
    prevClass = curClass;
  }

  return Math.max(score, 0);
}

// -- Search index --

export interface SearchEntry {
  recipeId: string;
  vaultId: string;
  bookName: string;
  title: string;
  tags: string[];
  ingredients?: string;
  instructions?: string;
}

const index = new Map<string, SearchEntry>();

export function indexRecipe(entry: SearchEntry): void {
  index.set(`${entry.vaultId}/${entry.recipeId}`, entry);
}

export function removeBookFromIndex(vaultId: string): void {
  for (const [key] of index) {
    if (key.startsWith(vaultId + "/")) index.delete(key);
  }
}

export function clearIndex(): void {
  index.clear();
}

export function getIndexSize(): number {
  return index.size;
}

export function indexRecipeContent(vaultId: string, recipeId: string, ingredients: string, instructions: string): void {
  const key = `${vaultId}/${recipeId}`;
  const entry = index.get(key);
  if (entry) {
    entry.ingredients = ingredients;
    entry.instructions = instructions;
  }
}

export interface SearchResult {
  entry: SearchEntry;
  score: number;
  /** Which field produced the best match */
  matchField: "title" | "tag" | "book" | "ingredients" | "instructions";
  /** The matching tag text if matchField is "tag" */
  matchTag?: string;
}

/**
 * Search across all indexed recipes using fzf-style fuzzy matching.
 * Searches: title, tags, book name, ingredients, instructions (not notes).
 */
export function search(query: string, limit = 15): SearchResult[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const entry of index.values()) {
    let bestScore = 0;
    let matchField: SearchResult["matchField"] = "title";
    let matchTag: string | undefined;

    // Title (highest priority via weight)
    const titleScore = fzfScore(q, entry.title);
    if (titleScore > 0 && titleScore * 4 > bestScore) {
      bestScore = titleScore * 4;
      matchField = "title";
    }

    // Tags
    for (const tag of entry.tags) {
      const tagScore = fzfScore(q, tag);
      if (tagScore > 0 && tagScore * 3 > bestScore) {
        bestScore = tagScore * 3;
        matchField = "tag";
        matchTag = tag;
      }
    }

    // Book name
    const bookScore = fzfScore(q, entry.bookName);
    if (bookScore > 0 && bookScore > bestScore) {
      bestScore = bookScore;
      matchField = "book";
    }

    // Ingredients
    if (entry.ingredients) {
      const ingScore = fzfScore(q, entry.ingredients);
      if (ingScore > 0 && ingScore * 2 > bestScore) {
        bestScore = ingScore * 2;
        matchField = "ingredients";
      }
    }

    // Instructions
    if (entry.instructions) {
      const instrScore = fzfScore(q, entry.instructions);
      if (instrScore > 0 && instrScore > bestScore) {
        bestScore = instrScore;
        matchField = "instructions";
      }
    }

    if (bestScore > 0) results.push({ entry, score: bestScore, matchField, matchTag });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
