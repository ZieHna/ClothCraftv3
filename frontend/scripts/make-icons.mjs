// Tab and home-screen icons from the project logo (../assets-v1/logo.png, 2000 x 2000, the file scripts/optimise-images.mjs also reads):
//   node scripts/make-icons.mjs
// writes public/favicon.ico (16, 32 and 48 px, PNG-compressed entries), public/favicon-32.png, public/icon-192.png,
// public/icon-512.png and public/apple-touch-icon.png (180 px).
// The logo is a gold "CC" with a needle and a soft shadow on a dark square. Straight shrunk to 16 or 32 px the strokes blur into the
// background (see the renders in the step A report), so the SMALL icons (16, 32, 48) use a tighter crop around the letters with a little
// extra contrast and sharpening; the larger ones (180, 192, 512) are the full logo, untouched. Both are derivatives of the same logo:
// see public/CREDITS.md for the (unconfirmed) source and licence.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, '../assets-v1/logo.png');
const pub = path.join(root, 'public');
mkdirSync(pub, { recursive: true });

/** the letters fill most of a square cut from the middle of the logo (x 191..1841, y 122..1772 of 2000) */
const CROP = { left: 191, top: 122, width: 1650, height: 1650 };
const small = (n) =>
  sharp(source)
    .extract(CROP)
    .resize(n, n, { kernel: 'lanczos3' })
    .modulate({ brightness: 1.08, saturation: 1.15 })
    .linear(1.12, -12)
    .sharpen({ sigma: 0.6, m1: 1.5, m2: 2 })
    .png({ compressionLevel: 9 })
    .toBuffer();
const full = (n) => sharp(source).resize(n, n, { kernel: 'lanczos3' }).flatten().png({ compressionLevel: 9 }).toBuffer();

/** an .ico file whose entries are PNG images (every browser since IE 9 reads these) */
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = entries.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.data)]);
}

const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(async (size) => ({ size, data: await small(size) })));
writeFileSync(path.join(pub, 'favicon.ico'), ico(images));
writeFileSync(path.join(pub, 'favicon-32.png'), images[1].data);
writeFileSync(path.join(pub, 'icon-192.png'), await full(192));
writeFileSync(path.join(pub, 'icon-512.png'), await full(512));
writeFileSync(path.join(pub, 'apple-touch-icon.png'), await full(180));
console.log('icons written to public/: favicon.ico (16, 32, 48), favicon-32.png, icon-192.png, icon-512.png, apple-touch-icon.png');

// node scripts/make-icons.mjs --preview <out.png>: what the small icons look like. Top row: the icons in the .ico at their real size on a
// light and a dark tab bar, then each enlarged 8 times (no smoothing) so the pixels can be judged. Bottom row: the same sizes made by plainly
// shrinking the full logo, the way the icons would look without the tighter crop and sharpening.
const previewAt = process.argv.indexOf('--preview');
if (previewAt > 0) {
  const target = process.argv[previewAt + 1];
  const plain = (n) => sharp(source).resize(n, n, { kernel: 'lanczos3' }).png().toBuffer();
  const up = (buf, n) => sharp(buf).resize(n * 8, n * 8, { kernel: 'nearest' }).png().toBuffer();
  const rows = [
    ['as made (tighter crop, sharpened)', [await small(16), await small(32)]],
    ['plain shrink of the full logo', [await plain(16), await plain(32)]],
  ];
  const layers = [];
  const W = 640;
  const H = 40 + rows.length * 300;
  for (const [i, [, [a, b]]] of rows.entries()) {
    const y = 20 + i * 300;
    layers.push({ input: a, left: 20, top: y + 6 }, { input: b, left: 52, top: y + 2 });
    layers.push({ input: a, left: 100, top: y + 6 }, { input: b, left: 132, top: y + 2 });
    layers.push({ input: await up(a, 16), left: 190, top: y }, { input: await up(b, 32), left: 330, top: y });
  }
  const label = (text, y) => Buffer.from(`<svg width="${W}" height="20"><text x="20" y="14" font-family="sans-serif" font-size="13" fill="#222">${text}</text></svg>`);
  rows.forEach(([text], i) => layers.push({ input: label(text, 0), left: 0, top: 20 + i * 300 + 262 }));
  const light = Buffer.from(`<svg width="90" height="40"><rect width="90" height="40" fill="#dee1e6"/></svg>`);
  const dark = Buffer.from(`<svg width="90" height="40"><rect width="90" height="40" fill="#202124"/></svg>`);
  rows.forEach((_, i) => layers.unshift({ input: light, left: 10, top: 20 + i * 300 - 2 }, { input: dark, left: 90, top: 20 + i * 300 - 2 }));
  await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).composite(layers).png().toFile(target);
  console.log(`preview written to ${target}`);
}
