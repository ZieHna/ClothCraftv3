// Step 9: two numbers measured in a REAL browser (Edge), printed on lines starting "PERF".
//  1. How long the print-fee estimate takes with 50 elements while one is dragged (it is recomputed on every move), against the 16.7 ms
//     of a frame. The ceiling asserted is generous; the printed median and worst case are the report.
//  2. How a text element's bounding box (what the fee charges) compares with the glyphs actually drawn: the box from the layer list
//     against the ink in the exported PNG (its tightest rectangle, and the pixels really covered).
import { afterEach, describe, expect, it } from 'vitest';
import bounds from '../../../addons/clothcraft/data/garment_bounds.json';
import { CONTRACT_GARMENT } from '../editor/contract';
import { createEditor } from '../editor/createEditor';
import type { SimpleEditorTools } from '../editor/types';
import { coveredSqIn, estimate } from './designFee';

const log = (label: string, data: Record<string, number | string>) => console.info(`PERF ${label} ${JSON.stringify(data)}`);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const BOX = bounds.products['m-tee'];
const box = { x: BOX.x, y: BOX.y, width: BOX.width, height: BOX.height };

describe('print fee estimate (real browser)', () => {
  let host: HTMLDivElement;
  let e: SimpleEditorTools;
  afterEach(() => {
    e?.dispose();
    host?.remove();
  });
  async function open() {
    host = document.createElement('div');
    host.style.width = '600px';
    document.body.append(host);
    e = await createEditor('simple', host);
    await e.loadBase(CONTRACT_GARMENT);
  }

  it('recomputes in well under a frame with 50 elements during a drag', async () => {
    await open();
    const kinds = ['rectangle', 'circle', 'triangle', 'star'] as const;
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = i % 5 === 0 ? e.addText(`Text ${i}`) : e.addShape(kinds[i % 4]!);
      // spread over the garment, overlapping, most of them turned: the scanline's worst case is many slanted edges on every line
      e.updateLayer(id, { x: 150 + (i % 10) * 55, y: 150 + Math.floor(i / 10) * 110, width: 90, height: 70, rotation: (i * 17) % 360 });
      ids.push(id);
    }
    await e.whenIdle();
    expect(e.getLayers()).toHaveLength(50);
    const estimateOnly: number[] = [];
    const withLayers: number[] = [];
    const dragged = ids[25]!;
    for (let step = 0; step < 120; step++) {
      e.updateLayer(dragged, { x: 200 + step * 3, y: 300 + (step % 20) * 4 });   // a pointer move
      let t = performance.now();
      const layers = e.getLayers();
      const t2 = performance.now();
      estimate(layers, box, 200, 2, 20, 'M');
      const t3 = performance.now();
      estimateOnly.push(t3 - t2);
      withLayers.push(t3 - t);
      t = t3;
    }
    const area = coveredSqIn(e.getLayers(), box, 200);
    log('estimate-50-layers-drag', {
      moves: 120, estimateMedianMs: round(pct(estimateOnly, 0.5)), estimateP95Ms: round(pct(estimateOnly, 0.95)), estimateMaxMs: round(Math.max(...estimateOnly)),
      withGetLayersMedianMs: round(pct(withLayers, 0.5)), withGetLayersMaxMs: round(Math.max(...withLayers)), coveredSqIn: area, band: 0.25,
      lines: Math.ceil(box.height / 0.25),
    });
    // a generous ceiling (the printed numbers are the measurement): the typical move fits in a frame even on a busy machine
    expect(pct(estimateOnly, 0.5)).toBeLessThan(16.7);
  });

  it('measures a text element’s box against its glyphs', async () => {
    await open();
    const rows: Record<string, number | string>[] = [];
    for (const text of ['Hello', 'gypsy', 'CLOTHCRAFT', 'Aa Bb Cc', 'i']) {
      for (const id of e.getLayers().map((l) => l.id)) e.removeLayer(id);
      const id = e.addText(text);
      e.updateLayer(id, { x: 400, y: 400, rotation: 0 });
      await e.whenIdle();
      const layer = e.getLayers().find((l) => l.id === id)!;
      const png = await e.exportPng({ multiplier: 1 });
      const bitmap = await createImageBitmap(png);
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let minX = width, minY = height, maxX = -1, maxY = -1, ink = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const a = data[(y * width + x) * 4 + 3]!;
          if (a >= 16) {
            ink += a / 255;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const boxArea = layer.width * layer.height;
      const inkBox = (maxX + 1 - minX) * (maxY + 1 - minY);
      rows.push({
        text, box: `${round(layer.width, 1)}x${round(layer.height, 1)}`, glyphBox: `${maxX + 1 - minX}x${maxY + 1 - minY}`,
        boxOverGlyphBox: round(boxArea / inkBox, 2), boxOverInk: round(boxArea / ink, 2),
        glyphBoxInsideBox: String(minX >= layer.x - layer.width / 2 - 1 && maxX <= layer.x + layer.width / 2 + 1 && minY >= layer.y - layer.height / 2 - 1 && maxY <= layer.y + layer.height / 2 + 1),
      });
    }
    for (const row of rows) log('text-box-vs-glyphs', row);
    // the bounding box is never smaller than the glyphs' own rectangle: the fee never charges less than what is drawn
    for (const row of rows) expect(row.boxOverGlyphBox as number).toBeGreaterThanOrEqual(0.98);
  });
});
