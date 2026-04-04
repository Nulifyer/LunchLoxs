/**
 * Web Worker for generating and searching sentence embeddings.
 * Uses Transformers.js with all-MiniLM-L6-v2 (quantized) for local inference.
 */

import { pipeline } from "@huggingface/transformers";

let extractor: any = null;
const embeddings = new Map<string, Float32Array>();

// -- Message handlers --

self.onmessage = async (e: MessageEvent) => {
  const { type, id } = e.data;
  try {
    switch (type) {
      case "load-model":
        await loadModel(e.data.progress);
        self.postMessage({ type: "model-loaded", id });
        break;

      case "load-embeddings":
        loadEmbeddings(e.data.entries);
        self.postMessage({ type: "embeddings-loaded", id, count: embeddings.size });
        break;

      case "embed-batch":
        const results = await embedBatch(e.data.items);
        self.postMessage({ type: "embed-result", id, results });
        break;

      case "search":
        const hits = await searchEmbeddings(e.data.query, e.data.limit ?? 15);
        self.postMessage({ type: "search-result", id, hits });
        break;

      case "remove-book":
        removeBook(e.data.vaultId);
        self.postMessage({ type: "removed", id });
        break;

      case "clear":
        embeddings.clear();
        self.postMessage({ type: "cleared", id });
        break;

      default:
        self.postMessage({ type: "error", id, error: `Unknown message type: ${type}` });
    }
  } catch (err: any) {
    self.postMessage({ type: "error", id, error: err.message || String(err) });
  }
};

// -- Model --

async function loadModel(reportProgress: boolean) {
  if (extractor) return;
  const progressCallback = reportProgress
    ? (p: any) => self.postMessage({ type: "model-progress", progress: p })
    : undefined;

  // Try WebGPU first for ~4x speedup, fall back to WASM
  try {
    extractor = await (pipeline as any)("feature-extraction", "Xenova/bge-small-en-v1.5", {
      device: "webgpu",
      dtype: "fp32",
      progress_callback: progressCallback,
    });
    self.postMessage({ type: "model-device", device: "webgpu" });
  } catch {
    extractor = await (pipeline as any)("feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "q8",
      progress_callback: progressCallback,
    });
    self.postMessage({ type: "model-device", device: "wasm" });
  }
}

// -- Embedding generation --

async function embedBatch(items: Array<{ key: string; text: string }>): Promise<Array<{ key: string; vector: Float32Array }>> {
  if (!extractor) throw new Error("Model not loaded");
  const texts = items.map((i) => i.text);
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const results: Array<{ key: string; vector: Float32Array }> = [];
  for (let i = 0; i < items.length; i++) {
    const vec = new Float32Array(output[i]!.data as ArrayBuffer);
    embeddings.set(items[i]!.key, vec);
    results.push({ key: items[i]!.key, vector: vec });
  }
  return results;
}

// -- Load pre-computed embeddings from IDB --

function loadEmbeddings(entries: Array<{ key: string; vector: ArrayBuffer }>) {
  for (const e of entries) {
    embeddings.set(e.key, new Float32Array(e.vector));
  }
}

// -- Search --

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

async function searchEmbeddings(query: string, limit: number): Promise<Array<{ key: string; score: number }>> {
  if (!extractor || embeddings.size === 0) return [];
  const output = await extractor([QUERY_PREFIX + query], { pooling: "mean", normalize: true });
  const queryVec = new Float32Array(output[0]!.data as ArrayBuffer);

  const scored: Array<{ key: string; score: number }> = [];
  for (const [key, vec] of embeddings) {
    scored.push({ key, score: cosine(queryVec, vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are already normalized, so dot = cosine similarity
}

// -- Cleanup --

function removeBook(vaultId: string) {
  const prefix = vaultId + "/";
  for (const key of [...embeddings.keys()]) {
    if (key.startsWith(prefix)) embeddings.delete(key);
  }
}

export {};
