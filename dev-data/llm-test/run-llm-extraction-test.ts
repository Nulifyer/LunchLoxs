#!/usr/bin/env bun
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
 *   - LLM (llama.cpp) running on localhost:8081 (podman compose up -d llama)
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
const LLM_URL = "http://localhost:8081";
const BROWSERLESS_URL = "http://localhost:3000";
const BROWSERLESS_TOKEN = "dev-token";
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

function cleanHtmlForLlm(html: string): string {
  const doc = parseHtml(html);

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  // Try to isolate the main recipe/content area using known selectors.
  // Priority: recipe plugin containers > microdata > generic article > fallback
  // Keep it simple — use broad structural elements, not plugin-specific classes.
  // Sites without JSON-LD are typically old blogs where these work reliably.
  const containerSelectors = [
    "article",
    "main",
    ".entry-content", ".post-content", ".article-body", ".post-body",
    ".entry", ".hentry",
    "#content",
  ];

  let contentEl: ParsedHTMLElement | null = null;
  for (const sel of containerSelectors) {
    const el = doc.querySelector(sel);
    if (el && el.innerHTML.length > 200) {
      contentEl = el;
      break;
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

async function callLLM(text: string, systemPrompt: string, enableThinking = false): Promise<LLMResult> {
  const resp = await fetch(`${LLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      // Qwen3.5 recommended sampling: 0.6/0.95/20 for thinking, 0.7/0.8/20 for non-thinking
      temperature: enableThinking ? 0.6 : 0.7,
      top_p: enableThinking ? 0.95 : 0.8,
      top_k: 20,
      min_p: 0.05,
      repetition_penalty: 1.05,
      max_tokens: enableThinking ? 16384 : 8192,
      stream: true,
      chat_template_kwargs: { enable_thinking: enableThinking },
    }),
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`LLM returned ${resp.status}`);
  }

  // Stream SSE chunks and collect content + reasoning
  let content = "";
  let reasoning = "";
  let tokenCount = 0;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          if (reasoning.length <= 200 || reasoning.length % 500 < 10) {
            process.stdout.write("\r    Thinking: " + reasoning.length.toLocaleString() + " chars...");
          }
        }
        if (delta.content) {
          content += delta.content;
          tokenCount++;
          if (tokenCount <= 5 || tokenCount % 50 === 0) {
            process.stdout.write("\r    Output: " + tokenCount + " tokens...");
          }
        }
      } catch { /* skip malformed chunks */ }
    }
  }

  if (reasoning || tokenCount > 0) process.stdout.write("\n");

  // In streaming mode, llama.cpp may not separate <think> tags into reasoning_content.
  // Parse them out of content manually as a fallback.
  if (!reasoning && content.includes("<think>")) {
    const thinkMatch = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
    if (thinkMatch) {
      reasoning = thinkMatch[1]!;
      content = content.slice(thinkMatch[0]!.length);
    }
  }

  if (reasoning) console.log(`    Thinking: ${reasoning.length.toLocaleString()} chars`);
  console.log(`    Output: ${tokenCount} tokens, ${content.length.toLocaleString()} chars`);

  // Strip markdown fences
  content = content.trim();
  if (content.startsWith("```")) {
    const codeLines = content.split("\n");
    content = codeLines.slice(1, -1).join("\n");
  }

  return { content, reasoning };
}


// ─── Prompts ─────────────────────────────────────────────────────────────────

// Pass 0: Raw extraction — convert unstructured page text into simple format
const RAW_EXTRACT_PROMPT = `You are a recipe extractor. You receive the raw text content of a web page that contains a recipe but has NO structured data. The text may contain <img> HTML tags — these are images from the page in their original position.

Your job is to find the recipe and output it in a specific simple text format.

Extract the recipe and output it in EXACTLY this format:

TITLE: Recipe Name
DESC: A short description of the dish
SERVINGS: 4
PREP: 30
COOK: 45
TAGS: tag1, tag2, tag3

INGREDIENTS:
2 | cup | flour
1 | tsp | salt
3 | | eggs

INSTRUCTIONS:
1. First step text here.
![alt text](image-url)
2. Second step text here.
3. Third step text here.

Rules:
- Every ingredient line must be: quantity | unit | item name
- Units must be standard: cup, tsp, tbsp, oz, lb, g, ml, clove, can, bunch, piece. Keep units lowercase singular.
- If an ingredient has no unit (countable items like eggs), leave unit empty: "3 | | eggs"
- Infer reasonable quantities for ingredients that don't specify one (e.g. salt -> "1 | tsp | salt").
- PREP and COOK are in minutes. Set to 0 if not mentioned.
- SERVINGS defaults to 4 if not mentioned.
- Instructions must be numbered steps. Keep the FULL original text of each step — do NOT summarize or shorten.
- IMAGES: Convert any <img> tags to ![alt](src) format. Place each image on its own line after the instruction step it relates to. Use the alt attribute for the alt text, and the src attribute for the URL. Skip images that are clearly not recipe photos (logos, badges, avatars).
- TAGS: include cuisine type, dish type, dietary info, or other relevant tags from the page.
- NON-ENGLISH: If the recipe is not in English, keep the original text AND add English translations:
  - For TITLE: "Original Title (English Translation)"
  - For ingredient items: "original name (english name)" e.g. "鶏レバー (chicken liver)"
  - For each instruction step, add the English translation on the next line prefixed with "> " e.g.:
    1. レバーを一口大に切る。
    > Cut the liver into bite-sized pieces.
  - DESC and TAGS should be in English.
- IGNORE irrelevant or duplicate content: skip reviews, comments, related recipes, author bios, ads, navigation, repeated text, and other non-recipe content.
- Output ONLY the plain text format above. No JSON, no markdown fencing, no explanation.
- If the page contains multiple recipes, extract only the primary/main one.`;

// Pass 1: Extract — fix missing data, infer quantities
const EXTRACT_PROMPT = `You are a recipe data fixer. You receive recipe data in a simple text format. Fix any issues and output the SAME format back.

Your job:
- Every ingredient MUST have an accurate quantity and unit that makes sense. Parse the original text carefully to extract the measurement. Examples:
  "5 to 6 ounces baby spinach" -> "5 | oz | baby spinach"
  "1 large can (28 ounces) diced tomatoes" -> "28 | oz | diced tomatoes"
  "2 cups (16 ounces) cottage cheese" -> "2 | cup | cottage cheese"
  If the ingredient truly has no unit (countable items like eggs), leave unit empty: "3 | | eggs"
  Do NOT leave unit empty when the source text specifies a measurement.
- Fix any ingredients missing quantities by inferring reasonable defaults (e.g. " | | salt" -> "1 | tsp | salt").
- Units must be a standard measurement: cup, tsp, tbsp, oz, lb, g, ml, clove, can, bunch, piece. Do NOT use the ingredient name as the unit. Keep units lowercase singular.
- Merge duplicate ingredients ONLY if they are truly the same item used for the same purpose (combine quantities). Do NOT merge ingredients that share a name but are used in different parts of the recipe (e.g. "3/4 cup sugar" for a topping and "2 tbsp sugar" for a batter are separate ingredients — keep both).
- CRITICAL: Keep ALL instruction text EXACTLY as-is. Do NOT shorten, summarize, or paraphrase any step.
- Keep ALL images exactly where they are. Do NOT remove or move any ![alt](url) lines.
- Decode any HTML entities in the text (e.g. &#8217; -> ', &frac14; -> 1/4, &frac12; -> 1/2, &frac34; -> 3/4).
- NON-ENGLISH: If the recipe text is not in English:
  - Keep ALL original non-English text in the original form. Do NOT replace it with English. Instead do the following:
  - For ingredient items: append "(english name)" e.g. "Arroz bomba" -> "Arroz bomba (bomba rice)"
  - For each instruction step, keep the original non-english text, then add an English translation on the NEXT line starting with "> ". Example:
    1. Freír el pollo en aceite.
    > Fry the chicken in oil.
    2. Añadir el agua.
    > Add the water.
  - DESC and TAGS should be in English.
  - If translations already exist, preserve them. Do NOT duplicate steps.
- Output ONLY the same plain text format. No JSON, no markdown fencing, no explanation.`;

// Pass 2: Process — clean names, place images
const PROCESS_PROMPT = `You are a recipe data processor. You receive recipe data in a simple text format. You have TWO jobs:

JOB 1 — Clean up ingredient names:
Strip parenthetical sizes, verbose qualifiers, and prep notes from ingredient item names. Keep the name short and recognizable. Do NOT strip English translation parentheses from non-English ingredients (e.g. keep "Arroz bomba (bomba rice)" as-is).

Examples:
- "large can (28 ounces) diced tomatoes" -> "diced tomatoes"
- "(2 cups) freshly grated low-moisture, part-skim mozzarella cheese" -> "mozzarella cheese"
- "large carrots, chopped (about 1 cup)" -> "carrots, chopped"
- "roughly chopped fresh basil + additional for garnish" -> "fresh basil"
- "cloves garlic, pressed or minced" -> "garlic, minced"
- "medium zucchini, chopped" -> "zucchini, chopped"
- "to 6 ounces baby spinach" -> "baby spinach"
- "no-boil lasagna noodles*" -> "lasagna noodles"
Move stripped size info (like "28 ounces", "2 cups") into the quantity/unit fields if not already there.

JOB 2 — Place images into instructions:
If there is an ADDITIONAL IMAGES section at the bottom, move EACH image to INSIDE the instructions. Place each image on its own line directly AFTER the step it relates to. Match the image alt text to the step content. Remove images that are clearly unrelated (logos, author photos, other recipe thumbnails, banners). Delete the ADDITIONAL IMAGES section completely when done.

For EVERY image in the ADDITIONAL IMAGES section, ask: "which step does this image show?" and place it after that step.

Example input:
INSTRUCTIONS:
1. Sauté the vegetables until golden.
2. Mix the cottage cheese filling.
3. Layer the noodles and sauce.

ADDITIONAL IMAGES:
![sautéed vegetables](https://example.com/sauteed.jpg)
![cottage cheese filling mixture](https://example.com/filling.jpg)
![layering the lasagna](https://example.com/layers.jpg)
![Author Kate](https://example.com/kate.jpg)

Example output:
INSTRUCTIONS:
1. Sauté the vegetables until golden.
![sautéed vegetables](https://example.com/sauteed.jpg)
2. Mix the cottage cheese filling.
![cottage cheese filling mixture](https://example.com/filling.jpg)
3. Layer the noodles and sauce.
![layering the lasagna](https://example.com/layers.jpg)

Notice: "Author Kate" was removed (unrelated). Each cooking image was placed after its matching step.

Rules:
- CRITICAL: Keep ALL instruction text EXACTLY as-is. Do NOT shorten or paraphrase.
- CRITICAL: Ingredients MUST stay in pipe-delimited format: quantity | unit | item. Do NOT drop the pipes.
- NON-ENGLISH: Preserve any existing translations (parenthetical English names on ingredients, "> " translation lines after instructions). If translations are missing, add them.
- Output the COMPLETE recipe in the same format (TITLE, DESC, SERVINGS, PREP, COOK, TAGS, INGREDIENTS, INSTRUCTIONS).
- No JSON, no markdown fencing, no explanation.`;

// Pass 3: Tag — add @[] ingredient references
const TAG_PROMPT = `You are a recipe text tagger. You receive a recipe in simple text format. Your ONLY job is to tag ingredient mentions in the INSTRUCTIONS section using the format @[item name] (at-sign, open square bracket, the EXACT and COMPLETE item name from the INGREDIENTS list including any parenthetical translations, close square bracket).

Example input:
TITLE: Simple Pasta
DESC: A quick pasta dish.
SERVINGS: 2
PREP: 5
COOK: 10
TAGS: italian, quick

INGREDIENTS:
1/2 | tsp | olive oil
2 | | flour tortillas
1 | cup | grated cheese
8 | oz | egg noodles

INSTRUCTIONS:
1. Heat oil in a pan. Place a tortilla in the pan.
2. Sprinkle cheese on top.
3. Cook the noodles separately.

Example output:
TITLE: Simple Pasta
DESC: A quick pasta dish.
SERVINGS: 2
PREP: 5
COOK: 10
TAGS: italian, quick

INGREDIENTS:
1/2 | tsp | olive oil
2 | | flour tortillas
1 | cup | grated cheese
8 | oz | egg noodles

INSTRUCTIONS:
1. Heat @[olive oil] in a pan. Place a @[flour tortillas] in the pan.
2. Sprinkle @[grated cheese] on top.
3. Cook the @[egg noodles] separately.

Notice: "oil" -> @[olive oil], "tortilla" -> @[flour tortillas], "cheese" -> @[grated cheese], "noodles" -> @[egg noodles].

Rules:
- The tag format is @[item name] — @ then [ then ingredient item name then ]. Example: @[bok choy]
- Match aggressively: any word that refers to an ingredient should be tagged. Examples:
  "noodles" -> @[wonton noodles], "broth" -> @[chicken broth], "oil" -> @[olive oil],
  "spinach" -> @[baby spinach], "cheese" -> @[mozzarella cheese] or @[cottage cheese] depending on context,
  "pepper" -> @[black pepper] or @[red pepper flakes] or @[bell pepper] depending on context.
- Match to the MOST SPECIFIC ingredient. If the list has both "wontons" and "wonton noodles", then "wontons" matches @[wontons] and "noodles" matches @[wonton noodles].
- Tag EVERY mention of an ingredient throughout the instructions, not just the first occurrence.
- Do NOT tag inside image alt text (inside ![...] brackets). Only tag in instruction step text.
- ONLY add @[] tags. Do NOT wrap them in backticks or code formatting. Do NOT change, shorten, or remove ANY other text, images, or step numbers.
- NON-ENGLISH: Preserve any existing translations (parenthetical English names on ingredients, "> " translation lines after instructions). Tag ingredient mentions in BOTH the original language lines AND the "> " translation lines.
- IMPORTANT: Output the COMPLETE recipe starting from TITLE through the end. Include ALL sections: TITLE, DESC, SERVINGS, PREP, COOK, TAGS, INGREDIENTS, INSTRUCTIONS. Do not skip the header.`;

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
  const staticResp = await fetch(TARGET_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  let html = await staticResp.text();
  let recipe = extractJsonLdRecipe(html);
  console.log(`  ${elapsed(start)} | ${html.length.toLocaleString()} bytes | JSON-LD: ${recipe ? "YES" : "NO"}`);

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
    const pass1result = await callLLM(simpleFormat, EXTRACT_PROMPT, true);
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
    const pass0result = await callLLM(cleanedText, RAW_EXTRACT_PROMPT, true);
    const pass0 = decodeEntities(pass0result.content);
    console.log(`  ${elapsed(start)}`);
    save("02-raw-extract.txt", pass0);

    if (STOP_AFTER === "pass0") {
      console.log(`\nStopped after pass0. Done in ${elapsed(totalStart)}`);
      return;
    }

    console.log("\nPass 1: Extract (fix quantities, merge dupes)...");
    start = Date.now();
    const pass1result = await callLLM(pass0, EXTRACT_PROMPT, true);
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
  const pass2result = await callLLM(pass1, PROCESS_PROMPT, false);
  const pass2 = decodeEntities(pass2result.content);
  console.log(`  ${elapsed(start)}`);
  save("04-process.txt", pass2);

  if (STOP_AFTER === "pass2") {
    console.log(`\nStopped after pass2. Done in ${elapsed(totalStart)}`);
    return;
  }

  // ── Pass 3: Tag ────────────────────────────────────────────────────────
  console.log("\nPass 3: Tag (add @[] ingredient references)...");
  console.log("  (thinking enabled)");
  start = Date.now();
  const pass3result = await callLLM(pass2, TAG_PROMPT, true);
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
