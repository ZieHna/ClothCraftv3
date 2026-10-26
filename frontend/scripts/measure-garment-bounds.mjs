// Step 9a: the garment's bounding rectangle in DESIGN units, measured from the pictures the editor draws, so the print fee is clipped to
// the garment and converted to square inches (see contract/README.md "Customized garments"). Run from frontend/:
//   node scripts/measure-garment-bounds.mjs            (writes ../addons/clothcraft/data/garment_bounds.json: Odoo reads it, the
//                                                      frontend tests read the same file)
// For each product folder in public/garments/: the tightest rectangle around the pixels whose alpha is at least THRESHOLD, the union over
// every colour, then mapped exactly the way the editor draws a garment (src/editor/simple/garment.ts drawGarment: "contained" at 92% of the
// shorter side of the DESIGN_SIZE square, centred). Deterministic: the same pictures always give the same numbers.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const DESIGN_SIZE = 800; // src/editor/types.ts
const FIT = 0.92; // src/editor/simple/garment.ts
const THRESHOLD = 16; // alpha 0-255: below this a pixel is a soft shadow edge, not garment
const root = path.resolve('public/garments');
const out = path.resolve('../addons/clothcraft/data/garment_bounds.json');
const round2 = (n) => Math.round(n * 100) / 100;

async function alphaBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] >= THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`${file}: no garment pixels`);
  return { width: info.width, height: info.height, minX, minY, maxX, maxY };
}

const products = {};
for (const id of readdirSync(root).sort()) {
  const dir = path.join(root, id);
  if (!statSync(dir).isDirectory()) continue;
  const files = readdirSync(dir).filter((f) => f.endsWith('.webp')).sort();
  const boxes = await Promise.all(files.map((f) => alphaBox(path.join(dir, f))));
  const { width: nw, height: nh } = boxes[0];
  if (boxes.some((b) => b.width !== nw || b.height !== nh)) throw new Error(`${id}: the colour pictures differ in size`);
  const union = {
    minX: Math.min(...boxes.map((b) => b.minX)), minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)), maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
  const s = Math.min(DESIGN_SIZE / nw, DESIGN_SIZE / nh) * FIT;
  const ox = (DESIGN_SIZE - nw * s) / 2;
  const oy = (DESIGN_SIZE - nh * s) / 2;
  products[id] = {
    x: round2(ox + union.minX * s), y: round2(oy + union.minY * s),
    width: round2((union.maxX + 1 - union.minX) * s), height: round2((union.maxY + 1 - union.minY) * s),
    colours: files.map((f) => f.replace('.webp', '')), picture: [nw, nh],
  };
}
writeFileSync(out, JSON.stringify({ version: 1, designSize: DESIGN_SIZE, fit: FIT, alphaThreshold: THRESHOLD, products }, null, 2) + '\n');
console.log(`garment bounds for ${Object.keys(products).length} products -> ${out}`);
for (const [id, b] of Object.entries(products)) console.log(`  ${id.padEnd(7)} x ${b.x} y ${b.y} w ${b.width} h ${b.height}`);
