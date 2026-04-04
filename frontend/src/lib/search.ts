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
    if (text[ti]!.toLowerCase() === pattern[pi]) {
      if (pi === 0) startIdx = ti;
      pi++;
      if (pi === pLen) endIdx = ti + 1;
    }
  }
  if (pi < pLen) return 0; // Not all pattern chars matched

  // Backward contraction: find the shortest substring ending at endIdx
  pi = pLen - 1;
  for (let ti = endIdx - 1; ti >= startIdx && pi >= 0; ti--) {
    if (text[ti]!.toLowerCase() === pattern[pi]) {
      pi--;
      if (pi < 0) startIdx = ti;
    }
  }

  // Reject if the match span is too spread out
  const matchSpan = endIdx - startIdx;
  const maxSpan = pLen * 8;  // Allow up to 8x the pattern length
  if (matchSpan > maxSpan) return 0;

  // Score the match region
  let score = 0;
  let consecutive = 0;
  let firstBonus = 0;
  let gapLen = 0;
  const maxGap = 16;  // Max characters between two consecutive matched chars
  let prevClass = startIdx > 0 ? charClass(text[startIdx - 1]!) : CH_WHITE;
  pi = 0;

  for (let ti = startIdx; ti < endIdx && pi < pLen; ti++) {
    const curClass = charClass(text[ti]!);
    if (text[ti]!.toLowerCase() === pattern[pi]) {
      if (pi > 0 && gapLen > maxGap) return 0;  // Single gap too large
      gapLen = 0;
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
      gapLen++;
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

export interface SearchResult {
  entry: SearchEntry;
  score: number;
  /** Which field produced the best match */
  matchField: "title" | "tag" | "book";
  /** The matching tag text if matchField is "tag" */
  matchTag?: string;
}

/**
 * Score a single token against all fields of an entry.
 * Returns the best weighted score, matched field, and optional tag.
 */
function scoreToken(token: string, entry: SearchEntry): { score: number; field: SearchResult["matchField"]; tag?: string } {
  let best = 0;
  let field: SearchResult["matchField"] = "title";
  let tag: string | undefined;

  const titleScore = fzfScore(token, entry.title) * 4;
  if (titleScore > best) { best = titleScore; field = "title"; }

  for (const t of entry.tags) {
    const s = fzfScore(token, t) * 3;
    if (s > best) { best = s; field = "tag"; tag = t; }
  }

  const bookScore = fzfScore(token, entry.bookName);
  if (bookScore > best) { best = bookScore; field = "book"; }

  return { score: best, field, tag };
}

/**
 * Search across all indexed recipes using fzf-style fuzzy matching.
 * Multi-word queries score each word independently and sum results,
 * so "plant-based fry" matches tag "plant-based" + title "stir-fry".
 */
export function search(query: string, limit = 15): SearchResult[] {
  if (!query) return [];
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const results: SearchResult[] = [];

  // Score the full query as a single phrase for multi-word bonus
  const fullQuery = tokens.join(" ");
  const isMultiWord = tokens.length > 1;

  for (const entry of index.values()) {
    let totalScore = 0;
    let bestField: SearchResult["matchField"] = "title";
    let bestFieldScore = 0;
    let matchTag: string | undefined;

    // Per-token scoring (cross-field)
    for (const token of tokens) {
      const { score, field, tag } = scoreToken(token, entry);
      totalScore += score;
      if (score > bestFieldScore) {
        bestFieldScore = score;
        bestField = field;
        matchTag = tag;
      }
    }

    // Full phrase bonus: if the entire query matches a single field, boost it
    if (isMultiWord && totalScore > 0) {
      const { score: phraseScore, field, tag } = scoreToken(fullQuery, entry);
      if (phraseScore > 0) {
        totalScore += phraseScore;
        bestField = field;
        matchTag = tag;
      }
    }

    if (totalScore > 0) results.push({ entry, score: totalScore, matchField: bestField, matchTag });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// -- Hybrid search: vector when ready, fzf fallback --

import { isVectorSearchReady, vectorSearch } from "./vector-search";

export async function hybridSearch(query: string, limit = 15): Promise<SearchResult[]> {
  if (!isVectorSearchReady()) {
    console.log("[search] vector not ready, using fzf");
    return search(query, limit);
  }

  try {
    const vectorHits = await vectorSearch(query, limit);
    console.log("[search] vector returned", vectorHits.length, "hits", vectorHits.slice(0, 3).map(h => `${h.key.slice(-8)}:${h.score.toFixed(3)}`));
    if (vectorHits.length === 0) return search(query, limit);

    // Keep vector ordering — use fzf only to determine snippet field
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: SearchResult[] = [];
    for (const { key } of vectorHits) {
      const entry = index.get(key);
      if (!entry) continue;

      let bestField: SearchResult["matchField"] = "title";
      let bestScore = 0;
      let matchTag: string | undefined;
      for (const token of tokens) {
        const { score, field, tag } = scoreToken(token, entry);
        if (score > bestScore) { bestScore = score; bestField = field; matchTag = tag; }
      }

      results.push({ entry, score: 0, matchField: bestField, matchTag });
    }
    console.log("[search] mapped", results.length, "results from", vectorHits.length, "vector hits");
    return results;
  } catch (e) {
    console.error("[search] vector search failed, falling back to fzf:", e);
    return search(query, limit);
  }
}
