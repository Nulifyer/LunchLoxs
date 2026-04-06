#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Tuning {
  temperature: number;
  topP: number;
  maxTokens: number;
}

interface TimingPayload {
  cache_n?: number;
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_token_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_token_ms?: number;
  predicted_per_second?: number;
}

interface UsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface LLMResult {
  content: string;
  reasoning: string;
  timings: TimingPayload;
  usage: UsagePayload;
  elapsedMs: number;
}

interface RecipeBenchmarkCase {
  name: string;
  inputFile: string;
}

interface StageResult {
  stage: string;
  elapsedMs: number;
  outputChars: number;
  leakedThinking: boolean;
  timings: TimingPayload;
  usage: UsagePayload;
}

interface RecipeCaseSummary {
  name: string;
  mode: "jsonld" | "raw";
  success: boolean;
  ingredientCount: number;
  tagCount: number;
  imageCount: number;
  totalElapsedMs: number;
  stages: StageResult[];
}

interface ExactnessSummary {
  name: string;
  success: boolean;
  response: string;
  elapsedMs: number;
  leakedThinking: boolean;
  timings: TimingPayload;
  usage: UsagePayload;
}

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

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PROMPT_DIR = resolvePromptDir(process.env.LLM_PROMPT_DIR);
const RESULTS_ROOT = join(import.meta.dir, "results", "benchmark-runs");
const LLM_ENDPOINT = process.env.LLM_ENDPOINT ?? "http://127.0.0.1:8081";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_TIMEOUT_MS = parseDurationMs(process.env.LLM_TIMEOUT, 20 * 60 * 1000);
const MODEL_LABEL = argValue("--label") ?? process.env.BENCH_MODEL_LABEL ?? "unknown-model";
const CASE_FILTER = (argValue("--cases") ?? process.env.BENCH_CASES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const RUN_DIR = join(RESULTS_ROOT, MODEL_LABEL);

const ALL_CASES: RecipeBenchmarkCase[] = [
  recipeCase("paella"),
  recipeCase("quesadilla"),
  recipeCase("shortcake"),
];
const CASES: RecipeBenchmarkCase[] = CASE_FILTER.length > 0
  ? ALL_CASES.filter((testCase) => CASE_FILTER.includes(testCase.name))
  : ALL_CASES;

const RAW_EXTRACT_PROMPT = readPrompt("pass0-raw-extract.txt");
const EXTRACT_PROMPT = readPrompt("pass1-extract.txt");
const PROCESS_PROMPT = readPrompt("pass2-process.txt");
const TAG_PROMPT = readPrompt("pass3-tag.txt");

const TUNING = {
  pass0: passTuning("PASS0", { temperature: 0.0, topP: 1.0, maxTokens: 8192 }),
  pass1: passTuning("PASS1", { temperature: 0.0, topP: 1.0, maxTokens: 8192 }),
  pass2: passTuning("PASS2", { temperature: 0.0, topP: 1.0, maxTokens: 6144 }),
  pass3: passTuning("PASS3", { temperature: 0.0, topP: 1.0, maxTokens: 8192 }),
  exact: passTuning("EXACT", { temperature: 0.0, topP: 1.0, maxTokens: 128 }),
} as const;

const EXACTNESS_TESTS = [
  {
    name: "exact_ok",
    system: "Return exactly OK and nothing else.",
    user: "Reply with OK.",
    expected: "OK",
  },
  {
    name: "exact_json",
    system: 'Return exactly this JSON object and nothing else: {"mode":"extract","ok":true}',
    user: "Emit the exact JSON object.",
    expected: '{"mode":"extract","ok":true}',
  },
  {
    name: "exact_tag_line",
    system: "Return exactly the provided instruction line and nothing else.",
    user: "1. Add @[salt] and stir.",
    expected: "1. Add @[salt] and stir.",
  },
];

function argValue(flag: string): string | undefined {
  const match = Bun.argv.find((arg) => arg.startsWith(`${flag}=`));
  return match ? match.slice(flag.length + 1) : undefined;
}

function recipeCase(name: string): RecipeBenchmarkCase {
  return {
    name,
    inputFile: join(import.meta.dir, "results", "qwen3-30b-a3b-nothink", `${name}-01-input.txt`),
  };
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
      if (readFileSync(join(candidate, "pass1-extract.txt"), "utf8")) {
        return candidate;
      }
    } catch {
      // continue
    }
  }

  throw new Error("Prompt directory not found. Set LLM_PROMPT_DIR to a valid prompt asset directory.");
}

function readPrompt(name: string): string {
  return readFileSync(join(PROMPT_DIR, name), "utf8").trim();
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
  };
}

function normalizeCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/chat/completions") ? trimmed : `${trimmed}/v1/chat/completions`;
}

function stripReasoningSpillover(content: string): string {
  if (!content.includes("<think>")) return content.trim();
  const withoutThink = content.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  return withoutThink.trim();
}

async function callLLM(userText: string, systemPrompt: string, tuning: Tuning): Promise<LLMResult> {
  const started = Date.now();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (LLM_API_KEY) {
    headers.Authorization = `Bearer ${LLM_API_KEY}`;
  }

  const response = await fetch(normalizeCompletionsUrl(LLM_ENDPOINT), {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      temperature: tuning.temperature,
      top_p: tuning.topP,
      max_tokens: tuning.maxTokens,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM returned ${response.status}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    timings?: TimingPayload;
    usage?: UsagePayload;
  };

  const rawContent = payload.choices?.[0]?.message?.content;
  let content = "";
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    content = rawContent.map((part) => part?.text ?? "").join("");
  }

  let reasoning = "";
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    reasoning = thinkMatch[1]!.trim();
  }

  return {
    content: stripReasoningSpillover(content),
    reasoning,
    timings: payload.timings ?? {},
    usage: payload.usage ?? {},
    elapsedMs: Date.now() - started,
  };
}

function saveResult(name: string, content: string): void {
  writeFileSync(join(RUN_DIR, name), content, "utf8");
}

function parseSimpleFormat(text: string): ParsedRecipe | null {
  const header = (key: string): string => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
    return match ? match[1]!.trim() : "";
  };

  const title = header("TITLE");
  if (!title) return null;

  const ingredients: ParsedRecipe["ingredients"] = [];
  const ingSection = text.match(/^INGREDIENTS:\s*\n([\s\S]*?)(?=\n(?:INSTRUCTIONS:|ADDITIONAL IMAGES:))/mi);
  if (ingSection) {
    for (const line of ingSection[1]!.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("|").map((part) => part.trim());
      if (parts.length >= 3) {
        ingredients.push({ quantity: parts[0]!, unit: parts[1]!, item: parts[2]! });
      }
    }
  }

  let instructions = "";
  const instructionsIndex = text.search(/^INSTRUCTIONS:\s*$/mi);
  if (instructionsIndex >= 0) {
    let instructionText = text.slice(instructionsIndex).replace(/^INSTRUCTIONS:\s*\n?/i, "");
    const imagesIndex = instructionText.search(/^ADDITIONAL IMAGES:/mi);
    if (imagesIndex >= 0) instructionText = instructionText.slice(0, imagesIndex);
    instructions = instructionText.trim();
  }

  const imageUrls = [...instructions.matchAll(/!\[[^\]]*\]\((.+?)\)/g)].map((match) => match[1]!);

  return {
    title,
    description: header("DESC"),
    servings: parseInt(header("SERVINGS")) || 4,
    prepMinutes: parseInt(header("PREP")) || 0,
    cookMinutes: parseInt(header("COOK")) || 0,
    tags: header("TAGS").split(",").map((tag) => tag.trim()).filter(Boolean),
    ingredients,
    instructions,
    imageUrls,
  };
}

async function runRecipeCase(testCase: RecipeBenchmarkCase): Promise<RecipeCaseSummary> {
  const input = readFileSync(testCase.inputFile, "utf8");
  const stages: StageResult[] = [];
  const mode = input.includes("TITLE:") && input.includes("INGREDIENTS:")
    ? "jsonld"
    : "raw";

  let pass0 = input;
  let pass1 = input;
  let pass2 = "";
  let pass3 = "";
  const caseStarted = Date.now();

  if (mode === "raw") {
    const rawExtract = await callLLM(input, RAW_EXTRACT_PROMPT, TUNING.pass0);
    pass0 = rawExtract.content;
    stages.push(stageSummary("pass0", rawExtract));
    saveResult(`${testCase.name}-02-raw-extract.txt`, pass0);

    const extracted = await callLLM(pass0, EXTRACT_PROMPT, TUNING.pass1);
    pass1 = extracted.content;
    stages.push(stageSummary("pass1", extracted));
    saveResult(`${testCase.name}-03-extract.txt`, pass1);
  } else {
    const extracted = await callLLM(input, EXTRACT_PROMPT, TUNING.pass1);
    pass1 = extracted.content;
    stages.push(stageSummary("pass1", extracted));
    saveResult(`${testCase.name}-02-extract.txt`, pass1);
  }

  const processed = await callLLM(pass1, PROCESS_PROMPT, TUNING.pass2);
  pass2 = processed.content;
  stages.push(stageSummary("pass2", processed));
  saveResult(`${testCase.name}-04-process.txt`, pass2);

  const tagged = await callLLM(pass2, TAG_PROMPT, TUNING.pass3);
  pass3 = tagged.content;
  stages.push(stageSummary("pass3", tagged));
  saveResult(`${testCase.name}-05-tag.txt`, pass3);

  const parsed = parseSimpleFormat(pass3);
  saveResult(`${testCase.name}-06-final.json`, JSON.stringify(parsed, null, 2));

  return {
    name: testCase.name,
    mode,
    success: Boolean(parsed),
    ingredientCount: parsed?.ingredients.length ?? 0,
    tagCount: (parsed?.instructions.match(/@\[/g) ?? []).length,
    imageCount: parsed?.imageUrls.length ?? 0,
    totalElapsedMs: Date.now() - caseStarted,
    stages,
  };
}

function stageSummary(stage: string, result: LLMResult): StageResult {
  return {
    stage,
    elapsedMs: result.elapsedMs,
    outputChars: result.content.length,
    leakedThinking: Boolean(result.reasoning) || /<think>|<\/think>/.test(result.content),
    timings: result.timings,
    usage: result.usage,
  };
}

async function runExactnessSuite(): Promise<ExactnessSummary[]> {
  const results: ExactnessSummary[] = [];

  for (const test of EXACTNESS_TESTS) {
    const output = await callLLM(test.user, test.system, TUNING.exact);
    results.push({
      name: test.name,
      success: output.content.trim() === test.expected,
      response: output.content.trim(),
      elapsedMs: output.elapsedMs,
      leakedThinking: Boolean(output.reasoning) || /<think>|<\/think>/.test(output.content),
      timings: output.timings,
      usage: output.usage,
    });
  }

  return results;
}

async function currentModelName(): Promise<string> {
  const response = await fetch(`${LLM_ENDPOINT.replace(/\/+$/, "")}/v1/models`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    return MODEL_LABEL;
  }

  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return payload.data?.[0]?.id ?? MODEL_LABEL;
}

function msToSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderMarkdownSummary(modelName: string, recipes: RecipeCaseSummary[], exactness: ExactnessSummary[]): string {
  const exactPassRate = `${exactness.filter((item) => item.success).length}/${exactness.length}`;
  const generationTps = recipes
    .flatMap((recipe) => recipe.stages.map((stage) => stage.timings.predicted_per_second ?? 0))
    .filter((value) => value > 0);

  const lines = [
    `# ${modelName}`,
    "",
    `- Recipe cases: ${recipes.filter((item) => item.success).length}/${recipes.length} parsed successfully`,
    `- Exact-match suite: ${exactPassRate}`,
    `- Mean generation speed: ${avg(generationTps).toFixed(2)} tok/s`,
    "",
    "## Recipe cases",
    "",
  ];

  for (const recipe of recipes) {
    lines.push(`- ${recipe.name}: ${recipe.success ? "ok" : "failed"} | mode=${recipe.mode} | ingredients=${recipe.ingredientCount} | tags=${recipe.tagCount} | images=${recipe.imageCount} | total=${msToSeconds(recipe.totalElapsedMs)}s`);
    for (const stage of recipe.stages) {
      const tps = stage.timings.predicted_per_second?.toFixed(2) ?? "n/a";
      lines.push(`  - ${stage.stage}: ${msToSeconds(stage.elapsedMs)}s | out=${stage.outputChars} chars | gen=${tps} tok/s | think_leak=${stage.leakedThinking}`);
    }
  }

  lines.push("", "## Exactness", "");
  for (const exact of exactness) {
    const tps = exact.timings.predicted_per_second?.toFixed(2) ?? "n/a";
    lines.push(`- ${exact.name}: ${exact.success ? "exact" : "mismatch"} | ${msToSeconds(exact.elapsedMs)}s | gen=${tps} tok/s | think_leak=${exact.leakedThinking} | response=${JSON.stringify(exact.response)}`);
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true });

  const modelName = await currentModelName();
  console.log(`Benchmarking ${modelName}`);

  const recipes: RecipeCaseSummary[] = [];
  for (const recipe of CASES) {
    console.log(`  recipe: ${recipe.name}`);
    recipes.push(await runRecipeCase(recipe));
  }

  console.log("  exactness suite");
  const exactness = await runExactnessSuite();

  const summary = {
    benchmarkedAt: new Date().toISOString(),
    label: MODEL_LABEL,
    modelName,
    endpoint: LLM_ENDPOINT,
    recipeCases: recipes,
    exactness,
  };

  saveResult("summary.json", JSON.stringify(summary, null, 2));
  saveResult("summary.md", renderMarkdownSummary(modelName, recipes, exactness));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
