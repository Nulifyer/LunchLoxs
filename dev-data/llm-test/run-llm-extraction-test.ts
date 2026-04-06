#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * LLM Recipe Extraction Pipeline Test
 *
 * Tests the full recipe URL import pipeline and saves each stage to disk for inspection.
 *
 * Usage:
 *   bun run dev-data/llm-test/run-llm-extraction-test.ts [url] [--stop-after=STAGE]
 *
 * Stages: fetch, input, pass0, pass1, pass2, pass3
 *   fetch  — stop after fetching HTML + checking JSON-LD (saves 00-raw.html)
 *   input  — stop after building LLM input (saves 01-input.txt)
 *   pass0  — stop after raw extraction (no-JSON-LD path only)
 *   pass1  — stop after Pass 1 (extract)
 *   pass2  — stop after Pass 2 (process)
 *   pass3  — run full pipeline (default)
 *
 * Defaults to: https://www.madewithlau.com/recipes/wonton-noodle-soup
 *
 * Requirements:
 *   - Browserless running on localhost:3000 (podman compose up -d browserless)
 *   - An OpenAI-style chat completions service running on localhost:8081 (podman compose up -d llama)
 *
 * Output files saved to dev-data/llm-test/:
 *   01-input.txt                Simple format (JSON-LD path) or cleaned HTML (raw path)
 *   02-extract.txt              Pass 1 output (JSON-LD path)
 *   02-raw-extract.txt          Pass 0 output: raw text → simple format (raw path)
 *   03-extract.txt              Pass 1 output (raw path)
 *   04-process.txt              Pass 2: clean ingredient names, place images
 *   05-tag.txt                  Pass 3: add @[] ingredient tags
 *   06-final.json               Final ScrapedRecipe object after parsing
 */

// Parse args: positional URL and optional --stop-after=STAGE
const args = Bun.argv.slice(2);
const stopArg = args.find((a) => a.startsWith("--stop-after="));
const STOP_AFTER = stopArg ? stopArg.split("=")[1]! : "pass3";
const TARGET_URL = args.find((a) => !a.startsWith("--")) ?? "https://www.madewithlau.com/recipes/wonton-noodle-soup";
const OUT_DIR = import.meta.dir;
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const LLM_ENDPOINT = process.env.LLM_ENDPOINT ?? "http://localhost:8081";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_TIMEOUT_MS = parseDurationMs(process.env.LLM_TIMEOUT, 20 * 60 * 1000);
const BROWSERLESS_URL = process.env.BROWSERLESS_ENDPOINT ?? "http://localhost:3000";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN ?? "dev-token";
const PROMPT_DIR = resolvePromptDir(process.env.LLM_PROMPT_DIR);
const VALID_STAGES = ["fetch", "input", "pass0", "pass1", "pass2", "pass3"];
if (!VALID_STAGES.includes(STOP_AFTER)) {
  console.error(`Invalid --stop-after stage: ${STOP_AFTER}. Valid: ${VALID_STAGES.join(", ")}`);
  process.exit(1);
}

function save(name: string, content: string): void {
  Bun.write(`${OUT_DIR}/${name}`, content);
  console.log(`  -> Saved ${name} (${content.length.toLocaleString()} chars)`);
}

function elapsed(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

function parseDurationMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  if (/^\d+$/.test(value)) return parseInt(value, 10) * 1000;

  const match = value.match(/^(\d+)(ms|s|m|h)$/i);
  if (!match) return fallbackMs;

  const amount = parseInt(match[1]!, 10);
  switch (match[2]!.toLowerCase()) {
    case "ms": return amount;
    case "s": return amount * 1000;
    case "m": return amount * 60 * 1000;
    case "h": return amount * 60 * 60 * 1000;
    default: return fallbackMs;
  }
}

function resolvePromptDir(override?: string): string {
  const candidates = [
    override,
    join(REPO_ROOT, "prompts", "url-import"),
    join(REPO_ROOT, "backend", "prompts", "url-import"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const testFile = readFileSync(join(candidate, "pass0-raw-extract.txt"), "utf8");
      if (testFile) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Prompt directory not found. Set LLM_PROMPT_DIR to a valid prompt asset directory.");
}

function readPrompt(name: string): string {
  return readFileSync(join(PROMPT_DIR, name), "utf8").trim();
}

interface Tuning {
  temperature: number;
  topP: number;
  maxTokens: number;
  enableThinking?: boolean;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function passTuning(prefix: string, fallback: Tuning): Tuning {
  const globalDefaults = {
    temperature: envFloat("LLM_DEFAULT_TEMPERATURE", fallback.temperature),
    topP: envFloat("LLM_DEFAULT_TOP_P", fallback.topP),
    maxTokens: envInt("LLM_DEFAULT_MAX_TOKENS", fallback.maxTokens),
  };

  return {
    temperature: envFloat(`LLM_${prefix}_TEMPERATURE`, globalDefaults.temperature),
    topP: envFloat(`LLM_${prefix}_TOP_P`, globalDefaults.topP),
    maxTokens: envInt(`LLM_${prefix}_MAX_TOKENS`, globalDefaults.maxTokens),
    enableThinking: envBool(`LLM_${prefix}_ENABLE_THINKING`, fallback.enableThinking ?? false),
  };
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const TUNING = {
  pass0: passTuning("PASS0", { temperature: 0.6, topP: 0.95, maxTokens: 16384, enableThinking: true }),
  pass1: passTuning("PASS1", { temperature: 0.6, topP: 0.95, maxTokens: 16384, enableThinking: false }),
  pass2: passTuning("PASS2", { temperature: 0.7, topP: 0.8, maxTokens: 8192, enableThinking: false }),
  pass3: passTuning("PASS3", { temperature: 0.6, topP: 0.95, maxTokens: 16384, enableThinking: false }),
} as const;

// ─── Helpers (mirror recipe-scraper.ts logic) ────────────────────────────────

function findRecipeInJsonLd(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (obj["@type"] === "Recipe") return obj;
  if (Array.isArray(obj["@type"]) && (obj["@type"] as string[]).includes("Recipe")) return obj;
  if (Array.isArray(obj["@graph"])) {
    for (const item of obj["@graph"] as unknown[]) {
      const found = findRecipeInJsonLd(item);
      if (found) return found;
    }
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipeInJsonLd(item);
      if (found) return found;
    }
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&uuml;/g, "ü")
    .replace(/&frac14;/g, "1/4").replace(/&frac12;/g, "1/2").replace(/&frac34;/g, "3/4")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, "\u201D").replace(/&ldquo;/g, "\u201C")
    .replace(/&hellip;/g, "…").replace(/&deg;/g, "°");
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function parseISO8601(s: string): number {
  const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
  return m ? (parseInt(m[1] ?? "0") * 60 + parseInt(m[2] ?? "0")) : 0;
}

function parseYield(val: unknown): number {
  const m = String(val ?? "").match(/(\d+)/);
  return m ? parseInt(m[1]!) : 4;
}

function extractStepImageUrl(image: unknown): string | undefined {
  if (!image) return undefined;
  if (typeof image === "string") return image;
  if (typeof image === "object" && image !== null && "url" in image) return String((image as { url: unknown }).url);
  if (Array.isArray(image)) {
    for (const item of image) {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null && "url" in item) return String((item as { url: unknown }).url);
    }
  }
  return undefined;
}

const UNIT_ALIASES: Record<string, string> = {
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  cup: "cup", cups: "cup",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  g: "g", gram: "g", grams: "g",
  ml: "ml", piece: "piece", pieces: "piece",
  stalk: "stalk", stalks: "stalk", bunch: "bunch",
};

function parseIngredient(raw: string): { quantity: string; unit: string; item: string } {
  let s = raw.trim();
  const qtyMatch = s.match(/^([\d./\s]+)/);
  let quantity = "";
  if (qtyMatch) {
    quantity = qtyMatch[1]!.trim();
    s = s.slice(qtyMatch[0]!.length).trim();
  }
  const words = s.split(/\s+/);
  let unit = "";
  if (words.length >= 1 && UNIT_ALIASES[words[0]!.toLowerCase().replace(/\.$/, "")]) {
    unit = UNIT_ALIASES[words[0]!.toLowerCase().replace(/\.$/, "")]!;
    s = words.slice(1).join(" ").trim();
  }
  return { quantity, unit, item: s.replace(/^of\s+/i, "").trim() || raw.trim() };
}

function parseTags(...sources: unknown[]): string[] {
  const tags = new Set<string>();
  for (const val of sources) {
    if (typeof val === "string") {
      for (const t of val.split(",")) {
        const trimmed = t.trim().toLowerCase();
        if (trimmed) tags.add(trimmed);
      }
    } else if (Array.isArray(val)) {
      for (const v of val) {
        const trimmed = String(v).trim().toLowerCase();
        if (trimmed) tags.add(trimmed);
      }
    }
  }
  return [...tags];
}

// ─── Build simple format ─────────────────────────────────────────────────────

function buildSimpleFormat(recipe: Record<string, unknown>, pageImages: string[]): string {
  const lines: string[] = [];
  lines.push(`TITLE: ${recipe.name ?? ""}`);
  lines.push(`DESC: ${stripHtml(String(recipe.description ?? ""))}`);
  lines.push(`SERVINGS: ${parseYield(recipe.recipeYield)}`);
  lines.push(`PREP: ${parseISO8601(String(recipe.prepTime ?? ""))}`);
  lines.push(`COOK: ${parseISO8601(String(recipe.cookTime ?? ""))}`);
  lines.push(`TAGS: ${parseTags(recipe.recipeCategory, recipe.keywords, recipe.recipeCuisine).join(", ")}`);

  lines.push("", "INGREDIENTS:");
  for (const ing of (recipe.recipeIngredient as string[] ?? [])) {
    const p = parseIngredient(ing);
    lines.push(`${p.quantity} | ${p.unit} | ${p.item}`);
  }

  lines.push("", "INSTRUCTIONS:");
  const usedUrls = new Set<string>();
  const instructions = recipe.recipeInstructions;

  // String instructions (single block of text/HTML)
  if (typeof instructions === "string") {
    const cleaned = stripHtml(instructions).trim();
    if (cleaned) {
      // Try to split into paragraphs → numbered steps
      const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      if (paragraphs.length > 1) {
        paragraphs.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
      } else {
        lines.push(`1. ${cleaned}`);
      }
    }
  } else if (Array.isArray(instructions)) {
    let stepNum = 1;
    for (const item of instructions as Record<string, unknown>[]) {
      if (typeof item === "string") {
        lines.push(`${stepNum}. ${stripHtml(item)}`);
        stepNum++;
        continue;
      }
      const text = item.text ? stripHtml(String(item.text)) : (item.name ? stripHtml(String(item.name)) : "");
      if (text) { lines.push(`${stepNum}. ${text}`); stepNum++; }

      const imgUrl = extractStepImageUrl(item.image);
      if (imgUrl) {
        const alt = item.name ? stripHtml(String(item.name)) : "";
        lines.push(`![${alt}](${imgUrl})`);
        usedUrls.add(imgUrl);
      }

      if (Array.isArray(item.itemListElement)) {
        for (const sub of item.itemListElement as Record<string, unknown>[]) {
          const subText = sub?.text ? stripHtml(String(sub.text)) : "";
          if (subText) { lines.push(`${stepNum}. ${subText}`); stepNum++; }
          const subImg = extractStepImageUrl(sub?.image);
          if (subImg) {
            lines.push(`![${sub?.name ? stripHtml(String(sub.name)) : ""}](${subImg})`);
            usedUrls.add(subImg);
          }
        }
      }
    }
  }

  const unused = pageImages.filter((img) => {
    const m = img.match(/\]\((.+)\)$/);
    return m ? !usedUrls.has(m[1]!) : true;
  });
  if (unused.length > 0) {
    lines.push("", "ADDITIONAL IMAGES:");
    for (const img of unused) lines.push(img);
  }

  return lines.join("\n");
}

// ─── Clean HTML for LLM (no-JSON-LD fallback) ───────────────────────────────

import { parse as parseHtml, type HTMLElement as ParsedHTMLElement } from "node-html-parser";

function detectErrorPage(html: string, title: string): string | null {
  const loweredTitle = title.toLowerCase();
  const loweredHtml = html.toLowerCase();

  const errorSignals = [
    loweredTitle.includes("page not found"),
    loweredTitle === "404",
    /<meta[^>]+content="error 404: page not found"/i.test(html),
    /pageType': 'error_page'/.test(html),
    /"pageType":\s*"error_page"/.test(html),
    /the page you['’]re looking for can['’]t be found/i.test(html),
    /<h1[^>]*>\s*uh-oh!\s*<\/h1>/i.test(html),
  ];

  if (!errorSignals.some(Boolean)) return null;

  if (loweredHtml.includes("recipe")) {
    return `# ${title || "Page Not Found"}\n\nThis page appears to be an error page or missing page, not a recipe.`;
  }

  return `# ${title || "Page Not Found"}\n\nThis page appears to be an error page, not a recipe.`;
}

function cleanHtmlForLlm(html: string): string {
  const doc = parseHtml(html);

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  const errorPage = detectErrorPage(html, title);
  if (errorPage) return errorPage;

  // Try to isolate the main recipe/content area using known selectors.
  // Priority: recipe plugin containers > microdata > generic article > fallback
  // Keep it simple — use broad structural elements, not plugin-specific classes.
  // Sites without JSON-LD are typically old blogs where these work reliably.
  const containerSelectors = [
    '[itemprop="articleBody"]',
    '[itemprop="recipeInstructions"]',
    ".recipe",
    ".recipe-content",
    ".recipe-card",
    ".recipe-body",
    "article",
    "main",
    ".post-body",
    ".post",
    ".post-outer",
    ".blog-posts",
    ".entry-content", ".post-content", ".article-body", ".post-body",
    ".entry", ".hentry",
    "#content",
  ];

  let contentEl: ParsedHTMLElement | null = null;
  let bestLength = 0;
  for (const sel of containerSelectors) {
    const el = doc.querySelector(sel);
    if (el && el.innerHTML.length > 200 && el.innerHTML.length > bestLength) {
      contentEl = el;
      bestLength = el.innerHTML.length;
    }
  }
  if (!contentEl) contentEl = doc.querySelector("body") ?? doc;

  // Remove non-content elements
  for (const tag of ["script", "style", "nav", "footer", "header", "aside", "iframe", "svg", "noscript", "form"]) {
    contentEl.querySelectorAll(tag).forEach((el) => el.remove());
  }
  // Remove comment sections, sharing/social, related posts, ads, sidebar widgets
  const junkSelectors = [
    '[class*="comment"]', '[class*="share"]', '[class*="social"]',
    '[class*="related"]', '[class*="sidebar"]', '[class*="widget"]',
    '[class*="advertisement"]', '[class*="popular-post"]', '[class*="post-navigation"]',
    '[id="comments"]', '[id="sidebar"]',
  ];
  for (const sel of junkSelectors) {
    contentEl.querySelectorAll(sel).forEach((el) => el.remove());
  }

  // Headings that signal non-recipe content — stop processing when we hit these
  const junkHeadingPatterns = [
    /^related\b/i, /^more\s+recipes/i, /^you\s+(may\s+)?also\s+like/i,
    /^recommended/i, /^popular\b/i, /^recent\s+posts/i,
    /^leave\s+a\s+(comment|reply|review)/i, /^write\s+a\s+review/i,
    /^\d+\s+(comment|response|review)/i, /^comments?\s*$/i,
    /^about\s+the\s+author/i, /^meet\s+/i, /^author\b/i,
    /^categories\b/i, /^archives\b/i, /^tags\s*:/i,
    /^share\s+this/i, /^follow\b/i, /^subscribe\b/i,
    /^newsletter/i, /^blogroll/i,
  ];

  function isJunkHeading(text: string): boolean {
    return junkHeadingPatterns.some((p) => p.test(text.trim()));
  }

  // Convert the DOM tree to structured text with images inline.
  // Walk the tree and convert elements to readable text.
  const lines: string[] = [];
  const seenImgs = new Set<string>();
  let stopped = false;

  function walk(node: ParsedHTMLElement): void {
    for (const child of node.childNodes) {
      if (stopped) return;

      // Text node
      if (child.nodeType === 3) {
        const t = child.textContent.replace(/[ \t]+/g, " ");
        if (t.trim()) lines.push(t);
        continue;
      }
      // Element node
      if (child.nodeType !== 1) continue;
      const el = child as ParsedHTMLElement;
      const tag = el.tagName?.toLowerCase() ?? "";

      // Headings → markdown (but stop if it's a junk heading)
      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1]!);
        const prefix = "#".repeat(Math.min(level, 3));
        const text = el.textContent.trim();
        if (text && isJunkHeading(text)) {
          stopped = true;
          return;
        }
        if (text) lines.push(`\n${prefix} ${text}`);
        continue;
      }

      // Images → keep full <img> tag so LLM sees all attributes
      if (tag === "img") {
        const src = (el.getAttribute("src") ?? "").replace(/&amp;/g, "&");
        if (!src || src.startsWith("data:") || seenImgs.has(src)) continue;
        if (/(logo|icon|avatar|badge|award|pixel|gravatar|wp-smiley|emoji|banner|tracking)/i.test(src)) continue;
        if (/\.gif(\?|$)/i.test(src)) continue;
        seenImgs.add(src);
        lines.push(`\n${el.toString()}`);
        continue;
      }

      // List items → bullet
      if (tag === "li") {
        const text = el.textContent.trim();
        if (text) lines.push(`- ${text}`);
        continue;
      }

      // Block elements → recurse with spacing
      if (["p", "div", "section", "blockquote", "ul", "ol", "figure", "figcaption"].includes(tag)) {
        walk(el);
        lines.push(""); // blank line after block
        continue;
      }

      // Everything else → recurse
      walk(el);
    }
  }

  walk(contentEl);

  let text = lines.join("\n");
  // Decode entities
  text = decodeEntities(text);
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Collapse whitespace while preserving structure
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  if (text.length < 80) {
    const metaDescription = doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim()
      ?? doc.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim()
      ?? "";
    if (metaDescription) {
      text = [text, metaDescription].filter(Boolean).join("\n\n");
    }
  }

  if (text.length > 15000) {
    text = text.slice(0, 15000) + "\n[... truncated]";
  }

  let result = "";
  if (title) result += `# ${title}\n\n`;
  result += text;

  return result;
}

// ─── Extract page images ─────────────────────────────────────────────────────

function extractPageImages(html: string): string[] {
  const images: string[] = [];
  const seen = new Set<string>();

  const ogMatch = html.match(/property="og:image"[^>]*content="([^"]+)"/);
  const ogTitle = html.match(/property="og:title"[^>]*content="([^"]+)"/);
  if (ogMatch) {
    const url = ogMatch[1]!.replace(/&amp;/g, "&");
    const alt = ogTitle ? ogTitle[1]!.replace(/&amp;/g, "&").replace(/&#39;/g, "'") : "";
    images.push(`![${alt}](${url})`);
    seen.add(url);
  }

  const imgRe = /<img[^>]+src="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null && images.length < 15) {
    const src = m[1]!.replace(/&amp;/g, "&");
    if (seen.has(src) || src.startsWith("data:")) continue;
    if (["logo", "icon", "avatar", "badge"].some((x) => src.toLowerCase().includes(x))) continue;
    const altMatch = m[0]!.match(/alt="([^"]*)"/);
    images.push(`![${decodeEntities(altMatch?.[1] ?? "")}](${src})`);
    seen.add(src);
  }

  return images;
}

// ─── LLM call ────────────────────────────────────────────────────────────────

interface LLMResult {
  content: string;
  reasoning: string;
}

function normalizeCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/chat/completions") ? trimmed : `${trimmed}/v1/chat/completions`;
}

function stripReasoningSpillover(content: string): string {
  const lines = content.split("\n");
  let last = lines.length - 1;

  for (let i = last; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const isRecipeLine = /^\d+\./.test(line)
      || line.startsWith("![")
      || line.includes("|")
      || line.startsWith("TITLE:")
      || line.startsWith("DESC:")
      || line.startsWith("SERVINGS:")
      || line.startsWith("PREP:")
      || line.startsWith("COOK:")
      || line.startsWith("TAGS:")
      || line.startsWith("INGREDIENTS:")
      || line.startsWith("INSTRUCTIONS:")
      || line.startsWith("ADDITIONAL IMAGES:")
      || line.startsWith("@[");

    if (isRecipeLine) {
      return i < last ? lines.slice(0, i + 1).join("\n") : content;
    }

    if (/^(Wait|Actually|Let me|I |Refining|Final|Re-read|Hmm|Notice|However|One |So )/.test(line)) {
      continue;
    }

    return i < last ? lines.slice(0, i + 1).join("\n") : content;
  }

  return content;
}

async function callLLM(text: string, systemPrompt: string, tuning: Tuning): Promise<LLMResult> {
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (LLM_API_KEY) {
    headers.Authorization = `Bearer ${LLM_API_KEY}`;
  }

  const resp = await fetch(normalizeCompletionsUrl(LLM_ENDPOINT), {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: tuning.temperature,
      top_p: tuning.topP,
      max_tokens: tuning.maxTokens,
      chat_template_kwargs: {
        enable_thinking: tuning.enableThinking ?? false,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`LLM returned ${resp.status}`);
  }

  const payload = await resp.json() as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
        reasoning_content?: string;
      };
    }>;
  };

  const rawContent = payload.choices?.[0]?.message?.content;
  let content = "";
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    content = rawContent.map((part) => part?.text ?? "").join("");
  }

  let reasoning = payload.choices?.[0]?.message?.reasoning_content?.trim() ?? "";
  if (!reasoning && content.includes("<think>")) {
    const thinkMatch = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
    if (thinkMatch) {
      reasoning = thinkMatch[1]!;
      content = content.slice(thinkMatch[0]!.length);
    }
  }

  content = content.trim();
  if (content.startsWith("```")) {
    const codeLines = content.split("\n");
    content = codeLines.slice(1, -1).join("\n");
  }
  content = stripReasoningSpillover(content);

  if (reasoning) console.log(`    Thinking: ${reasoning.length.toLocaleString()} chars`);
  console.log(`    Output: ${content.length.toLocaleString()} chars`);

  return { content, reasoning };
}

const RAW_EXTRACT_PROMPT = readPrompt("pass0-raw-extract.txt");
const EXTRACT_PROMPT = readPrompt("pass1-extract.txt");
const PROCESS_PROMPT = readPrompt("pass2-process.txt");
const TAG_PROMPT = readPrompt("pass3-tag.txt");

// ─── Parse simple format ─────────────────────────────────────────────────────

interface ParsedRecipe {
  title: string;
  description: string;
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  tags: string[];
  ingredients: Array<{ quantity: string; unit: string; item: string }>;
  instructions: string;
  imageUrls: string[];
}

function parseSimpleFormat(text: string): ParsedRecipe | null {
  const header = (key: string): string => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
    return m ? m[1]!.trim() : "";
  };

  const title = header("TITLE");
  if (!title) return null;

  const ingredients: ParsedRecipe["ingredients"] = [];
  const ingSection = text.match(/^INGREDIENTS:\s*\n([\s\S]*?)(?=\n(?:INSTRUCTIONS:|ADDITIONAL IMAGES:))/mi);
  if (ingSection) {
    for (const line of ingSection[1]!.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        ingredients.push({ quantity: parts[0]!, unit: parts[1]!, item: parts[2]! });
      }
    }
  }

  let instructions = "";
  const instrIdx = text.search(/^INSTRUCTIONS:\s*$/mi);
  if (instrIdx >= 0) {
    let instrText = text.slice(instrIdx).replace(/^INSTRUCTIONS:\s*\n?/i, "");
    const addlIdx = instrText.search(/^ADDITIONAL IMAGES:/mi);
    if (addlIdx >= 0) instrText = instrText.slice(0, addlIdx);
    instructions = instrText.trim();
  }

  const imageUrls: string[] = [];
  for (const m of instructions.matchAll(/!\[[^\]]*\]\((.+?)\)/g)) {
    if (!imageUrls.includes(m[1]!)) imageUrls.push(m[1]!);
  }

  return {
    title,
    description: header("DESC"),
    servings: parseInt(header("SERVINGS")) || 4,
    prepMinutes: parseInt(header("PREP")) || 0,
    cookMinutes: parseInt(header("COOK")) || 0,
    tags: header("TAGS").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
    ingredients,
    instructions,
    imageUrls,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`\nTesting pipeline for: ${TARGET_URL}\n`);

  // Clean old output files
  for (const name of ["00-raw.html", "00-jsonld.json", "01-input.txt", "02-raw-extract.txt", "02-extract.txt", "03-extract.txt",
    "03-process.txt", "04-process.txt", "04-tag.txt", "05-tag.txt", "05-final.json", "06-final.json"]) {
    try { const fs = await import("fs"); fs.unlinkSync(`${OUT_DIR}/${name}`); } catch { /* ignore */ }
  }

  const totalStart = Date.now();

  // ── Fetch & extract JSON-LD ─────────────────────────────────────────────
  console.log("Fetching page...");
  let start = Date.now();
  let html = "";
  let recipe: Record<string, unknown> | null = null;
  try {
    const staticResp = await fetch(TARGET_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    html = await staticResp.text();
    recipe = extractJsonLdRecipe(html);
    console.log(`  ${elapsed(start)} | ${html.length.toLocaleString()} bytes | JSON-LD: ${recipe ? "YES" : "NO"}`);
  } catch (error) {
    console.log(`  ${elapsed(start)} | direct fetch failed, trying Browserless render...`);
    if (error instanceof Error) {
      console.log(`  Direct fetch error: ${error.message}`);
    }
  }

  if (!recipe) {
    console.log("  Trying Browserless render...");
    start = Date.now();
    const renderResp = await fetch(`${BROWSERLESS_URL}/content?token=${BROWSERLESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: TARGET_URL, gotoOptions: { waitUntil: "networkidle2" } }),
    });
    html = await renderResp.text();
    recipe = extractJsonLdRecipe(html);
    console.log(`  ${elapsed(start)} | ${html.length.toLocaleString()} bytes | JSON-LD: ${recipe ? "YES" : "NO"}`);
  }

  if (STOP_AFTER === "fetch") {
    save("00-raw.html", html);
    if (recipe) save("00-jsonld.json", JSON.stringify(recipe, null, 2));
    console.log(`\nStopped after fetch. Done in ${elapsed(totalStart)}`);
    return;
  }

  const pageImages = extractPageImages(html);
  let pass1: string;

  // Check JSON-LD quality — must have both ingredients and instructions
  if (recipe) {
    const ings = recipe.recipeIngredient as unknown[] ?? [];
    const instrs = recipe.recipeInstructions;
    if (ings.length === 0 || (!Array.isArray(instrs) && typeof instrs !== "string") || (Array.isArray(instrs) && instrs.length === 0)) {
      console.log("  JSON-LD incomplete (missing ingredients or instructions), falling back to HTML");
      recipe = null;
    }
  }

  if (recipe) {
    // ── JSON-LD path: build simple format, then Pass 1 ────────────────
    const trimmed = { ...recipe };
    for (const key of ["@context", "video", "publisher", "review", "aggregateRating",
      "mainEntityOfPage", "datePublished", "dateModified", "author", "nutrition"]) {
      delete trimmed[key];
    }
    const simpleFormat = buildSimpleFormat(trimmed, pageImages);
    save("01-input.txt", simpleFormat);
    const lines = simpleFormat.split("\n");
    console.log(`\nInput: ${lines.filter((l) => l.includes("|")).length} ingredients | ${lines.filter((l) => /^\d+\./.test(l)).length} steps | ${lines.filter((l) => l.startsWith("![")).length} images`);

    if (STOP_AFTER === "input") {
      console.log(`\nStopped after input. Done in ${elapsed(totalStart)}`);
      return;
    }

    console.log("\nPass 1: Extract (fix quantities, merge dupes)...");
    start = Date.now();
    const pass1result = await callLLM(simpleFormat, EXTRACT_PROMPT, TUNING.pass1);
    pass1 = decodeEntities(pass1result.content);
    console.log(`  ${elapsed(start)}`);
    save("02-extract.txt", pass1);
  } else {
    // ── No JSON-LD: clean HTML → Pass 0 (raw extraction) → Pass 1 ────
    console.log("\nNo JSON-LD found. Using raw text extraction...");
    save("00-raw.html", html);
    const cleanedText = cleanHtmlForLlm(html);
    save("01-input.txt", cleanedText);
    console.log(`  Cleaned text: ${cleanedText.length.toLocaleString()} chars`);

    if (STOP_AFTER === "input") {
      console.log(`\nStopped after input. Done in ${elapsed(totalStart)}`);
      return;
    }

    console.log("\nPass 0: Raw extract (page text → simple format)...");
    start = Date.now();
    const pass0result = await callLLM(cleanedText, RAW_EXTRACT_PROMPT, TUNING.pass0);
    const pass0 = decodeEntities(pass0result.content);
    console.log(`  ${elapsed(start)}`);
    save("02-raw-extract.txt", pass0);

    if (STOP_AFTER === "pass0") {
      console.log(`\nStopped after pass0. Done in ${elapsed(totalStart)}`);
      return;
    }

    console.log("\nPass 1: Extract (fix quantities, merge dupes)...");
    start = Date.now();
    const pass1result = await callLLM(pass0, EXTRACT_PROMPT, TUNING.pass1);
    pass1 = decodeEntities(pass1result.content);
    console.log(`  ${elapsed(start)}`);
    save("03-extract.txt", pass1);
  }

  if (STOP_AFTER === "pass1") {
    console.log(`\nStopped after pass1. Done in ${elapsed(totalStart)}`);
    return;
  }

  // ── Pass 2: Process ────────────────────────────────────────────────────
  console.log("\nPass 2: Process (clean names, place images)...");
  start = Date.now();
  const pass2result = await callLLM(pass1, PROCESS_PROMPT, TUNING.pass2);
  const pass2 = decodeEntities(pass2result.content);
  console.log(`  ${elapsed(start)}`);
  save("04-process.txt", pass2);

  if (STOP_AFTER === "pass2") {
    console.log(`\nStopped after pass2. Done in ${elapsed(totalStart)}`);
    return;
  }

  // ── Pass 3: Tag ────────────────────────────────────────────────────────
  console.log("\nPass 3: Tag (add @[] ingredient references)...");
  start = Date.now();
  const pass3result = await callLLM(pass2, TAG_PROMPT, TUNING.pass3);
  const pass3 = decodeEntities(pass3result.content);
  console.log(`  ${elapsed(start)}`);
  save("05-tag.txt", pass3);
  const tagCount = (pass3.match(/@\[/g) ?? []).length;
  console.log(`  @[] tags: ${tagCount}`);

  // ── Parse final ────────────────────────────────────────────────────────
  console.log("\nFinal parse...");
  const final = parseSimpleFormat(pass3);
  save("06-final.json", JSON.stringify(final, null, 2));
  if (final) {
    console.log(`  Title: ${final.title}`);
    console.log(`  Ingredients: ${final.ingredients.length}`);
    console.log(`  Tags: ${final.tags.length}`);
    console.log(`  Image URLs: ${final.imageUrls.length}`);
    console.log(`  @[] tags in instructions: ${(final.instructions.match(/@\[/g) ?? []).length}`);
  }

  console.log(`\nDone in ${elapsed(totalStart)} total`);
  console.log(`Files saved to: ${OUT_DIR}`);
}

function extractJsonLdRecipe(html: string): Record<string, unknown> | null {
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const found = findRecipeInJsonLd(JSON.parse(m[1]!));
      if (found) return found;
    } catch { /* skip */ }
  }
  return null;
}

main().catch(console.error);
