// What the history costs, measured in a REAL browser (Edge): how long undo and redo take with a busy design, how much JS
// heap 100 steps hold, and that pictures are never copied by history. The numbers are printed (lines starting "PERF");
// the assertions are generous ceilings that catch a real regression (a copy per step would be hundreds of MB).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_GARMENT } from '../contract';
import { createEditor } from '../createEditor';
import { HISTORY_LIMIT, type SimpleEditorTools } from '../types';

declare global {
  interface Window {
    gc?: () => void;
  }
  interface Performance {
    memory?: { usedJSHeapSize: number };
  }
}

const log = (label: string, data: Record<string, number | string>) => console.info(`PERF ${label} ${JSON.stringify(data)}`);
const heap = async () => {
  for (let i = 0; i < 3; i++) {
    window.gc?.();
    await new Promise((r) => setTimeout(r, 30));
  }
  return performance.memory?.usedJSHeapSize ?? 0;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** a picture of random noise: it does not compress, so it is as heavy as a real photo (about 3.8 MB as a PNG) */
async function noisyPicture(w = 1200, h = 800): Promise<Blob> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  ctx.putImageData(new ImageData(data, w, h), 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

describe('history cost (real browser)', () => {
  let host: HTMLDivElement;
  let e: SimpleEditorTools;
  afterEach(() => {
    e?.dispose();
    host?.remove();
    vi.restoreAllMocks();
  });
  async function open() {
    host = document.createElement('div');
    host.style.width = '400px';
    document.body.append(host);
    e = await createEditor('simple', host);
    await e.loadBase(CONTRACT_GARMENT);
  }
  async function timeUndoRedo(rounds: number) {
    const undo: number[] = [];
    const redo: number[] = [];
    for (let i = 0; i < rounds; i++) {
      let t = performance.now();
      await e.undo();
      undo.push(performance.now() - t);
      t = performance.now();
      await e.redo();
      redo.push(performance.now() - t);
    }
    return { undoMedianMs: +median(undo).toFixed(1), undoMaxMs: +Math.max(...undo).toFixed(1), redoMedianMs: +median(redo).toFixed(1), redoMaxMs: +Math.max(...redo).toFixed(1) };
  }

  it('undo and redo with 20 mixed layers (text and shapes)', async () => {
    await open();
    for (let i = 0; i < 8; i++) e.addText(`Text number ${i}`);
    for (const kind of ['rectangle', 'circle', 'triangle', 'star'] as const) for (let i = 0; i < 3; i++) e.addShape(kind);
    expect(e.getLayers()).toHaveLength(20);
    const first = e.getLayers()[0]!.id;
    for (let i = 0; i < 10; i++) e.updateLayer(first, { x: 100 + i * 10 });
    const t = await timeUndoRedo(10);
    log('20 mixed layers', { layers: 20, ...t, sceneKBPerStep: +(e.historyStats().sceneChars / (e.historyStats().undoSteps + 1) / 1024).toFixed(1) });
    expect(t.undoMedianMs).toBeLessThan(500);
  });

  it('undo and redo with 8 pictures (each about 3.8 MB), the pictures are not decoded from copies', async () => {
    await open();
    const objectUrls = vi.spyOn(URL, 'createObjectURL');
    const originals: Blob[] = [];
    for (let i = 0; i < 8; i++) {
      const p = await noisyPicture();
      originals.push(p);
      await e.addImage(p, `Picture ${i}`);
    }
    for (let i = 0; i < 12; i++) e.addShape('rectangle');
    const first = e.getLayers()[0]!.id;
    for (let i = 0; i < 6; i++) e.updateLayer(first, { x: 200 + i * 10 });
    const urlsBefore = objectUrls.mock.calls.length;
    const t = await timeUndoRedo(8);
    log('8 pictures + 12 shapes', { pictures: 8, pictureMBEach: +(originals[0]!.size / 1048576).toFixed(2), ...t, blobUrlsCreatedByUndoRedo: objectUrls.mock.calls.length - urlsBefore });
    expect(objectUrls.mock.calls.length - urlsBefore).toBe(0); // undo and redo re-use the one URL each picture already has
    expect(t.undoMedianMs).toBeLessThan(1000);
  });

  it('100 steps on a busy design cost little heap, hold each picture once, and never copy bytes', async () => {
    await open();
    const originals: Blob[] = [];
    for (let i = 0; i < 8; i++) {
      const p = await noisyPicture(1000, 700);
      originals.push(p);
      await e.addImage(p, `Picture ${i}`);
    }
    for (let i = 0; i < 12; i++) e.addShape('circle');
    const id = e.getLayers().find((l) => l.type === 'shape')!.id;
    // start from a clean slate so the 100 steps below are the only history
    const snapshot = await e.exportState();
    await e.loadState(snapshot);
    expect(e.historyStats().undoSteps).toBe(0);

    const before = await heap();
    for (let i = 1; i <= HISTORY_LIMIT; i++) e.updateLayer(id, { x: 100 + i, y: 100 + (i % 7) });
    const after = await heap();
    const stats = e.historyStats();
    expect(stats.undoSteps).toBe(HISTORY_LIMIT);

    const held = Object.values((await e.exportState()).assets);
    const sameBlobs = originals.every((o) => held.includes(o));
    log('100 steps, 8 pictures + 12 shapes', {
      heapBeforeKB: Math.round(before / 1024),
      heapAfterKB: Math.round(after / 1024),
      heapDeltaKB: Math.round((after - before) / 1024),
      heapPerStepKB: +((after - before) / HISTORY_LIMIT / 1024).toFixed(1),
      sceneKBPerStep: +(stats.sceneChars / (stats.undoSteps + 1) / 1024).toFixed(1),
      sceneKBTotal: +(stats.sceneChars / 1024).toFixed(0),
      retainedPictures: stats.retainedAssets,
      pictureBytesHeldMB: +(held.reduce((n, b) => n + b.size, 0) / 1048576).toFixed(1),
      ifEveryStepCopiedPicturesMB: +((originals.reduce((n, b) => n + b.size, 0) * HISTORY_LIMIT) / 1048576).toFixed(0),
      samePictureBlobs: String(sameBlobs),
    });
    expect(stats.retainedAssets).toBe(8);
    expect(held).toHaveLength(8);
    expect(sameBlobs).toBe(true); // the very objects that were added, not copies
    if (performance.memory) expect(after - before).toBeLessThan(25 * 1024 * 1024); // 100 steps of 20 layers: a few MB at most
  });

  it('the oldest steps release their pictures when they fall off the cap', async () => {
    await open();
    const p = await noisyPicture(600, 400);
    const pic = await e.addImage(p, 'Early');
    e.removeLayer(pic);
    const shape = e.addShape('rectangle');
    expect(e.historyStats().retainedAssets).toBe(1);
    for (let i = 0; i < HISTORY_LIMIT + 2; i++) e.updateLayer(shape, { x: 100 + i });
    expect(e.historyStats().retainedAssets).toBe(0);
  });

  /** a photo-like picture: smooth gradients, speckle and detail, so its JPEG is a real few hundred KB to a few MB and decoding it is real work */
  async function photo(w: number, h: number): Promise<Blob> {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#2b4a7a');
    g.addColorStop(0.5, '#d9a35b');
    g.addColorStop(1, '#6a2f3c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const tile = new Uint8ClampedArray(256 * 256 * 4);
    crypto.getRandomValues(tile.subarray(0, 65536));
    crypto.getRandomValues(tile.subarray(65536, 131072));
    crypto.getRandomValues(tile.subarray(131072, 196608));
    crypto.getRandomValues(tile.subarray(196608));
    for (let i = 3; i < tile.length; i += 4) tile[i] = 255;
    const bmp = await createImageBitmap(new ImageData(tile, 256, 256));
    ctx.globalAlpha = 0.18;
    for (let y = 0; y < h; y += 256) for (let x = 0; x < w; x += 256) ctx.drawImage(bmp, x, y);
    ctx.globalAlpha = 1;
    for (let i = 0; i < 2500; i++) {
      ctx.fillStyle = `hsl(${(i * 47) % 360} 60% ${30 + ((i * 13) % 40)}% / 0.5)`;
      ctx.beginPath();
      ctx.arc((i * 7919) % w, (i * 104729) % h, 4 + (i % 40), 0, Math.PI * 2);
      ctx.fill();
    }
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  }

  it('COLD decode of a real large picture: a fresh blob URL that has never been decoded, versus the same picture again', async () => {
    await open();
    const file = await photo(2000, 1500);
    const id = await e.addImage(file, 'Photo');
    const snapshot = await e.exportState();
    const timeLoad = async () => {
      const host2 = document.createElement('div');
      host2.style.width = '400px';
      document.body.append(host2);
      const e2 = await createEditor('simple', host2);
      await e2.loadBase(CONTRACT_GARMENT);
      const t = performance.now();
      await e2.loadState(snapshot); // new blob URL each time: the browser has not decoded THIS url
      await e2.exportPng(); // a browser decodes a picture when it is first DRAWN, not when it loads: draw it, so the decode is in the time
      const ms = performance.now() - t;
      e2.dispose();
      host2.remove();
      return ms;
    };
    const first = await timeLoad();
    const second = await timeLoad();
    const third = await timeLoad();
    // undo of a delete uses the picture's existing URL (already decoded once)
    e.removeLayer(id);
    const t = performance.now();
    await e.undo();
    await e.exportPng();
    const warmUndo = performance.now() - t;
    log('cold decode of a real 2000x1500 photo', {
      fileMB: +(file.size / 1048576).toFixed(2),
      firstLoadAndDrawMs: Math.round(first),
      secondLoadAndDrawMs: Math.round(second),
      thirdLoadAndDrawMs: Math.round(third),
      undoOfDeleteAndDrawMsSameUrl: Math.round(warmUndo),
    });
    expect(first).toBeLessThan(3000);
    expect(e.getLayers().map((l) => l.type)).toEqual(['image']);
  });
});
