/**
 * Renders the app icons. Run with `pnpm icons`.
 *
 * The icon is drawn as SVG (the header's audio-lines mark on the app's dark
 * tile) and rasterised with the Chromium that Playwright already installs for
 * the e2e tests, so no image library is added for a handful of PNGs. The
 * outputs are committed; rerun only when the mark changes.
 * Node 24 runs this file directly, so keep to erasable TypeScript syntax.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TILE = "#0a0a0a";
const MARK = "#ffffff";

// lucide's audio-lines, on a 24 unit grid.
const BARS = [
  [2, 10, 13],
  [6, 6, 17],
  [10, 3, 21],
  [14, 8, 15],
  [18, 5, 18],
  [22, 10, 13],
] as const;

/**
 * `mark` is the share of the tile the glyph spans. A maskable icon may be
 * cropped to a circle of 80% of its width, so its glyph is smaller and its
 * tile has square corners.
 */
function svg(size: number, options: { radius: number; mark: number }): string {
  const scale = (size * options.mark) / 24;
  const offset = (size - 24 * scale) / 2;
  const lines = BARS.map(
    ([x, y1, y2]) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>`,
  ).join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" rx="${size * options.radius}" fill="${TILE}"/>`,
    `<g transform="translate(${offset} ${offset}) scale(${scale})" stroke="${MARK}" stroke-width="2" stroke-linecap="round" fill="none">${lines}</g>`,
    `</svg>`,
  ].join("");
}

const ROUNDED = { radius: 0.22, mark: 0.56 };
const MASKABLE = { radius: 0, mark: 0.46 };
// iOS rounds the corners itself and shows any transparency as black.
const APPLE = { radius: 0, mark: 0.56 };

/** A .ico that holds one PNG: valid since Windows Vista, read by every browser. */
function ico(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(size, 6);
  header.writeUInt8(size, 7);
  header.writeUInt8(0, 8); // no palette
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10); // colour planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // offset of the image
  return Buffer.concat([header, png]);
}

const browser = await chromium.launch();
const page = await browser.newPage();

async function png(
  size: number,
  options: { radius: number; mark: number },
): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent">${svg(size, options)}</body>`,
  );
  return page.screenshot({ omitBackground: true, type: "png" });
}

function write(path: string, data: Buffer | string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`wrote ${path}`);
}

write("public/icons/icon-192.png", await png(192, ROUNDED));
write("public/icons/icon-512.png", await png(512, ROUNDED));
write("public/icons/icon-maskable-512.png", await png(512, MASKABLE));
// Next picks these three up by name and adds the <link> tags itself.
write("src/app/apple-icon.png", await png(180, APPLE));
write("src/app/icon.svg", `${svg(512, ROUNDED)}\n`);
write("src/app/favicon.ico", ico(await png(48, ROUNDED), 48));

await browser.close();
