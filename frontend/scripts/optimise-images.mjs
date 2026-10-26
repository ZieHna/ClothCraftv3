// One-off: shrink the v1 images (assets-v1/) for the storefront.
//   product photos           -> public/products/<id>.webp        (list from scripts/image-sources.json)
//   logo + hero photos       -> public/site/*.webp               (list in `jobs` below)
//   node scripts/optimise-images.mjs        (run from frontend/; needs video-src/node_modules installed)
// splashback4.png is left out on purpose: it is only 360x240, too small for a hero.
// sharp is borrowed READ-ONLY from video-src/node_modules. It is deliberately not a dependency of the app, so the video
// tooling stays out of the app's package.json. Products: at most 640 px, WebP quality 80, alpha kept. Hero photos: 800
// and 1600 px wide (srcset), WebP quality 70; a source narrower than a width is not enlarged.
import { createRequire } from 'node:module';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const v1 = path.join(root, '..', 'assets-v1');
const sharp = createRequire(path.join(root, 'video-src', 'package.json'))('sharp');
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

// ---- product photos
const sources = JSON.parse(await readFile(path.join(here, 'image-sources.json'), 'utf8'));
const products = path.join(root, 'public', 'products');
await mkdir(products, { recursive: true });
let productTotal = 0;
for (const [id, rel] of Object.entries(sources)) {
  const file = path.join(products, `${id}.webp`);
  await sharp(path.join(v1, rel)).resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80, effort: 6 }).toFile(file);
  productTotal += (await stat(file)).size;
}
console.log(`products: ${Object.keys(sources).length} images, ${kb(productTotal)}`);

// ---- site images: the logo and the four hero photos (cross-fading slider, in this order)
const site = path.join(root, 'public', 'site');
await mkdir(site, { recursive: true });
const jobs = [
  { src: 'logo.png', name: 'logo', widths: [96], square: true, quality: 85 },
  { src: 'splashback5.png', name: 'hero-1', widths: [800, 1600] },
  { src: 'splashback.png', name: 'hero-2', widths: [800, 1600] },
  { src: 'splashback3.jpg', name: 'hero-3', widths: [800, 1600] },
  { src: 'splashback2.jpg', name: 'hero-4', widths: [720] },
];
let siteTotal = 0;
for (const { src, name, widths, square, quality = 70 } of jobs) {
  for (const w of widths) {
    const file = path.join(site, `${name}-${w}.webp`);
    const image = sharp(path.join(v1, src)).resize(w, square ? w : undefined, { fit: square ? 'cover' : 'inside', withoutEnlargement: true });
    await image.webp({ quality, effort: 6 }).toFile(file);
    const size = (await stat(file)).size;
    siteTotal += size;
    console.log(`  site/${name}-${w}.webp`.padEnd(28), kb(size));
  }
}
console.log(`site: ${kb(siteTotal)} (logo + hero photos)`);
