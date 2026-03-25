/**
 * Generate PNG icons and ICO favicon from SVG sources.
 * Usage: npx --package=@resvg/resvg-js --package=tsx tsx scripts/gen-icons.ts
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { deflateSync } from "zlib";

const publicDir = join(import.meta.dir, "..", "public");

// -- Generate PNGs --
const icons = [
  { svg: "icon-192.svg", out: "icon-192.png", size: 192 },
  { svg: "icon-512.svg", out: "icon-512.png", size: 512 },
];

for (const { svg, out, size } of icons) {
  const svgData = readFileSync(join(publicDir, svg), "utf-8");
  const resvg = new Resvg(svgData, { fitTo: { mode: "width", value: size } });
  writeFileSync(join(publicDir, out), resvg.render().asPng());
  console.log(`Generated ${out} (${size}x${size})`);
}

// -- Generate ICO (multi-size: 16, 32, 48) --
const icoSizes = [16, 32, 48];
const faviconSvg = readFileSync(join(publicDir, "favicon.svg"), "utf-8");
const pngBuffers: Buffer[] = [];

for (const size of icoSizes) {
  const resvg = new Resvg(faviconSvg, { fitTo: { mode: "width", value: size } });
  pngBuffers.push(Buffer.from(resvg.render().asPng()));
}

// ICO format: header + directory entries + PNG data
const headerSize = 6;
const dirEntrySize = 16;
const dirSize = dirEntrySize * icoSizes.length;
let dataOffset = headerSize + dirSize;

// Header: reserved(2) + type(2, 1=ICO) + count(2)
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);

const dirEntries: Buffer[] = [];
const dataChunks: Buffer[] = [];

for (let i = 0; i < icoSizes.length; i++) {
  const size = icoSizes[i];
  const png = pngBuffers[i];
  const entry = Buffer.alloc(dirEntrySize);
  entry.writeUInt8(size < 256 ? size : 0, 0);  // width
  entry.writeUInt8(size < 256 ? size : 0, 1);  // height
  entry.writeUInt8(0, 2);   // color palette
  entry.writeUInt8(0, 3);   // reserved
  entry.writeUInt16LE(1, 4);  // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);  // data size
  entry.writeUInt32LE(dataOffset, 12); // data offset
  dirEntries.push(entry);
  dataChunks.push(png);
  dataOffset += png.length;
}

writeFileSync(
  join(publicDir, "favicon.ico"),
  Buffer.concat([header, ...dirEntries, ...dataChunks])
);
console.log(`Generated favicon.ico (${icoSizes.join("+")}px)`);
