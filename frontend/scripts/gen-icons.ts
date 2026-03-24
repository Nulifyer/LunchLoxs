/**
 * Generate minimal valid PNG icons for PWA manifest.
 * Uses raw PNG encoding — no external dependencies.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { deflateSync } from "zlib";

function createPNG(size: number, bgColor: [number, number, number], fgColor: [number, number, number]): Buffer {
  // Create raw RGBA pixel data
  const pixels = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.15);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rounded rectangle check
      const inRect = isInRoundedRect(x, y, size, size, radius);

      // Simple "T" shape in center
      const cx = size / 2, cy = size / 2;
      const barH = size * 0.08;
      const stemW = size * 0.12;
      const letterTop = cy - size * 0.22;
      const letterBottom = cy + size * 0.25;
      const letterLeft = cx - size * 0.22;
      const letterRight = cx + size * 0.22;
      const isTopBar = y >= letterTop && y <= letterTop + barH && x >= letterLeft && x <= letterRight;
      const isStem = x >= cx - stemW / 2 && x <= cx + stemW / 2 && y >= letterTop && y <= letterBottom;
      const isLetter = isTopBar || isStem;

      if (!inRect) {
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
        pixels[i + 3] = 0; // transparent
      } else if (isLetter) {
        pixels[i] = fgColor[0]; pixels[i + 1] = fgColor[1]; pixels[i + 2] = fgColor[2];
        pixels[i + 3] = 255;
      } else {
        pixels[i] = bgColor[0]; pixels[i + 1] = bgColor[1]; pixels[i + 2] = bgColor[2];
        pixels[i + 3] = 255;
      }
    }
  }

  return encodePNG(size, size, pixels);
}

function isInRoundedRect(x: number, y: number, w: number, h: number, r: number): boolean {
  if (x >= r && x < w - r) return true;
  if (y >= r && y < h - r) return true;
  // Check corners
  const corners = [[r, r], [w - r - 1, r], [r, h - r - 1], [w - r - 1, h - r - 1]];
  for (const [cx, cy] of corners) {
    if (Math.hypot(x - cx, y - cy) <= r) return true;
  }
  return false;
}

function encodePNG(width: number, height: number, rgba: Buffer): Buffer {
  // Build filtered scanlines (filter type 0 = None)
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter byte
    rgba.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = deflateSync(rawData);

  const chunks: Buffer[] = [];

  // Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(pngChunk("IHDR", ihdr));

  // IDAT
  chunks.push(pngChunk("IDAT", compressed));

  // IEND
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeB, data, crc]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const publicDir = join(import.meta.dir, "..", "public");
const bg: [number, number, number] = [0x1a, 0x1a, 0x2e];
const fg: [number, number, number] = [0xe9, 0x45, 0x60];

writeFileSync(join(publicDir, "icon-192.png"), createPNG(192, bg, fg));
writeFileSync(join(publicDir, "icon-512.png"), createPNG(512, bg, fg));
console.log("Generated icon-192.png and icon-512.png");
