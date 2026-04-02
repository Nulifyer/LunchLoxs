/**
 * Asset processing — type validation, image resize, format conversion.
 *
 * Allowlist: jpg, png, webp, heic, heif, svg, gif, pdf.
 * Raster images are downscaled to 1280px (longest side) and converted to WebP.
 * SVG, GIF (≤1280px), and PDF are kept as-is.
 */

const MAX_DIMENSION = 1280;
const WEBP_QUALITY = 0.85;
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const RASTER_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const ALLOWED_TYPES = new Set([
  ...RASTER_TYPES,
  "image/svg+xml",
  "image/gif",
  "application/pdf",
]);

// Some browsers don't set MIME for HEIC; detect by extension
function resolveType(file: File): string {
  if (file.type && ALLOWED_TYPES.has(file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const extMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    svg: "image/svg+xml",
    gif: "image/gif",
    pdf: "application/pdf",
  };
  return extMap[ext] ?? file.type;
}

export interface ProcessedAsset {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetError";
  }
}

export async function processAsset(file: File): Promise<ProcessedAsset> {
  const mimeType = resolveType(file);

  if (!ALLOWED_TYPES.has(mimeType)) {
    throw new AssetError(
      "Only images (JPG, PNG, WebP, HEIC, SVG, GIF) and PDF files are supported."
    );
  }

  if (RASTER_TYPES.has(mimeType)) {
    return processRaster(file);
  }

  if (mimeType === "image/svg+xml") {
    return processSvg(file);
  }

  if (mimeType === "image/gif") {
    return processGif(file);
  }

  if (mimeType === "application/pdf") {
    return processPassthrough(file, mimeType);
  }

  throw new AssetError("Unsupported file type.");
}

async function processRaster(file: File): Promise<ProcessedAsset> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  let targetW = width;
  let targetH = height;
  const longest = Math.max(width, height);

  if (longest > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / longest;
    targetW = Math.round(width * scale);
    targetH = Math.round(height * scale);
  }

  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  if (bytes.byteLength > MAX_SIZE_BYTES) {
    throw new AssetError(`Image is too large after processing (${formatSize(bytes.byteLength)}). Maximum is 10 MB.`);
  }

  const name = replaceExtension(file.name, "webp");
  return { bytes, mimeType: "image/webp", filename: name };
}

async function processSvg(file: File): Promise<ProcessedAsset> {
  const text = await file.text();
  if (!text.includes("<svg") && !text.includes("http://www.w3.org/2000/svg")) {
    throw new AssetError("File does not appear to be a valid SVG.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_SIZE_BYTES) {
    throw new AssetError(`SVG is too large (${formatSize(bytes.byteLength)}). Maximum is 10 MB.`);
  }
  return { bytes, mimeType: "image/svg+xml", filename: file.name };
}

async function processGif(file: File): Promise<ProcessedAsset> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close();

  if (Math.max(width, height) > MAX_DIMENSION) {
    throw new AssetError(
      `GIF exceeds ${MAX_DIMENSION}px (${width}×${height}). Please resize before uploading.`
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_SIZE_BYTES) {
    throw new AssetError(`GIF is too large (${formatSize(bytes.byteLength)}). Maximum is 10 MB.`);
  }
  return { bytes, mimeType: "image/gif", filename: file.name };
}

async function processPassthrough(file: File, mimeType: string): Promise<ProcessedAsset> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_SIZE_BYTES) {
    throw new AssetError(`File is too large (${formatSize(bytes.byteLength)}). Maximum is 10 MB.`);
  }
  return { bytes, mimeType, filename: file.name };
}

function replaceExtension(filename: string, ext: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}.${ext}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
