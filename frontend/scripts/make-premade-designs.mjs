// Makes the premade designs (step F7): draws each design from scripts/premade/designs.mjs in the REAL Simple editor, saves its snapshot as
// public/designs/templates/<id>.json (and its pictures in public/designs/assets/), then opens every template again through the same code the
// shop uses (src/designs/template.ts), fits it onto the garments named in src/designs/catalog.ts and saves the mockups as
// public/designs/previews/*.webp. Needs the Vite dev server (npm run dev) and Microsoft Edge. Writes only inside public/designs/.
//   node scripts/make-premade-designs.mjs [http://localhost:5173] [id ...]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { DESIGN_CATALOG } from '../src/designs/catalog.ts';
import { DESIGNS, FRAME } from './premade/designs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'public', 'designs');
const [base = 'http://localhost:5173', ...only] = process.argv.slice(2);
const bounds = JSON.parse(readFileSync(path.join(here, '..', '..', 'addons', 'clothcraft', 'data', 'garment_bounds.json'), 'utf8')).products;
for (const dir of ['templates', 'assets', 'previews']) mkdirSync(path.join(out, dir), { recursive: true });

const wanted = DESIGN_CATALOG.filter((d) => only.length === 0 || only.includes(d.id));
for (const d of DESIGN_CATALOG) if (!DESIGNS[d.id]) throw new Error(`no artwork for ${d.id}`);

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
page.on('pageerror', (e) => console.log('page error:', e.message));
await page.goto(base + '/');

// ---------------------------------------------------------------------------------------------------------------- 1. draw the templates
for (const design of wanted) {
  const composed = await page.evaluate(async ({ items }) => {
    const { createEditor } = await import('/src/editor/createEditor.ts');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:800px';
    document.body.appendChild(host);
    const ed = await createEditor('simple', host);
    await ed.loadBase({ image: '/garments/m-tee/white.webp', color: 'white', size: 'M', colorImages: { white: '/garments/m-tee/white.webp' } });
    const toPng = async (svg, [w, h]) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = w * 2;
      canvas.height = h * 2;
      canvas.getContext('2d').drawImage(img, 0, 0, w * 2, h * 2);
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    };
    for (const it of items) {
      let id;
      if (it.kind === 'text') {
        id = ed.addText(it.text);
        await ed.updateStyle(id, { text: it.text, fontFamily: it.fontFamily, fontSize: it.fontSize, fill: it.fill, textAlign: it.textAlign });
        ed.updateLayer(id, { x: it.x, y: it.y, rotation: it.rotation, name: it.name });
      } else if (it.kind === 'shape') {
        id = ed.addShape(it.shape);
        ed.updateLayer(id, { x: it.x, y: it.y, width: it.width, height: it.height, rotation: it.rotation, name: it.name });
        await ed.updateStyle(id, { fill: it.fill, stroke: it.stroke, strokeWidth: it.strokeWidth, opacity: it.opacity });
      } else {
        id = await ed.addImage(await toPng(it.svg, it.size), it.name);
        ed.updateLayer(id, { x: it.x, y: it.y, width: it.width, height: it.height, rotation: it.rotation });
      }
    }
    await ed.whenIdle();
    const snapshot = await ed.exportState();
    const b64 = (blob) =>
      new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
    const assets = {};
    for (const [id, blob] of Object.entries(snapshot.assets)) assets[id] = { type: blob.type, data: await b64(blob) };
    const layers = ed.getLayers().length;
    ed.dispose();
    host.remove();
    return { schemaVersion: snapshot.schemaVersion, state: snapshot.state, assets, layers };
  }, { items: DESIGNS[design.id] });

  const assetFiles = {};
  for (const [id, asset] of Object.entries(composed.assets)) {
    const file = `${design.id}-${id}.png`;
    writeFileSync(path.join(out, 'assets', file), Buffer.from(asset.data, 'base64'));
    assetFiles[id] = { file: `/designs/assets/${file}`, type: asset.type };
  }
  const template = { schemaVersion: composed.schemaVersion, engine: 'simple', frame: FRAME, state: composed.state, assets: assetFiles };
  writeFileSync(path.join(out, 'templates', `${design.id}.json`), JSON.stringify(template));
  console.log(`template ${design.id}: ${composed.layers} layers, ${Object.keys(assetFiles).length} pictures`);
}

// ---------------------------------------------------------------------------------------------------------------- 2. render the mockups
const targets = [];
for (const d of wanted) {
  targets.push({ id: d.id, product: d.previewGarment.product, color: d.previewGarment.color, file: `${d.id}.webp` });
  for (const [product, on] of Object.entries(d.featuredOn ?? {})) targets.push({ id: d.id, product, color: on.color, file: `${d.id}--${product}.webp` });
}
for (const t of targets) {
  const box = bounds[t.product];
  if (!box) throw new Error(`no print box for ${t.product}`);
  const colours = box.colours;
  const data = await page.evaluate(async ({ id, product, color, box, colours }) => {
    const { createEditor } = await import('/src/editor/createEditor.ts');
    const { fetchTemplate, buildSnapshot } = await import('/src/designs/template.ts');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:800px';
    document.body.appendChild(host);
    const ed = await createEditor('simple', host);
    const colorImages = Object.fromEntries(colours.map((c) => [c, `/garments/${product}/${c}.webp`]));
    await ed.loadBase({ image: colorImages[color], color, size: 'M', colorImages });
    const file = await fetchTemplate(`/designs/templates/${id}.json`);
    await ed.loadState(await buildSnapshot(file, { x: box.x, y: box.y, width: box.width, height: box.height }));
    await ed.whenIdle();
    const png = await ed.exportPng({ withGarment: true, multiplier: 1 });
    const bitmap = await createImageBitmap(png);
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 800;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, 800, 800);
    const webp = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    const text = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = reject;
      r.readAsDataURL(webp);
    });
    ed.dispose();
    host.remove();
    return text;
  }, { id: t.id, product: t.product, color: t.color, box: { x: box.x, y: box.y, width: box.width, height: box.height }, colours });
  writeFileSync(path.join(out, 'previews', t.file), Buffer.from(data, 'base64'));
  console.log(`preview ${t.file} (${t.product}, ${t.color}): ${Math.round(Buffer.from(data, 'base64').length / 1024)} KB`);
}
await browser.close();
