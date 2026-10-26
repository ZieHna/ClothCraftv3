import { describe, expect, it } from 'vitest';
import { gifBlob, jpegHeader, pngHeader, realJpeg, realPng, realWebp, svgBlob, webpHeader } from '../test/images';
import { describeEditorContract } from './contract';
import { createEditor } from './createEditor';
import { resolveEntry } from './entry';
import { FakeEditor } from './fake/FakeEditor';
import { FONT_LIST } from './fonts';
import { describeSimpleToolsContract, populateSimple } from './toolsContract';
import { exportFileName, slug } from './exportName';
import { EngineMismatchError, MAX_EXPORT_PX, SNAPSHOT_SCHEMA_VERSION, SnapshotError, assertSnapshot, exportSize, parseMode } from './types';
import { clampPan, fitted, panned, resized, viewToDesign, zoomAbout, zoomLimits } from './view';
import { MAX_LONG_EDGE, MAX_UPLOAD_BYTES, MAX_UPLOAD_PIXELS, UploadError, downscaledSize, inspectImage } from './upload';

// the same two suites the Fabric adapter runs in a real browser (SimpleEditor.browser.test.ts)
describeEditorContract('FakeEditor (jsdom)', async () => ({ editor: new FakeEditor(), populate: populateSimple }));
describeSimpleToolsContract('FakeEditor (jsdom)', async () => ({ editor: new FakeEditor() }));

describe('mode param', () => {
  it('defaults to simple when missing, empty or invalid', () => {
    for (const raw of [null, undefined, '', 'banana', 'PRO', 'Pro', ' pro', 'simple']) expect(parseMode(raw)).toBe('simple');
  });
  it('accepts exactly pro', () => {
    expect(parseMode('pro')).toBe('pro');
  });
  it('an invalid mode goes straight to simple, with no chooser, even when the flag is on', () => {
    expect(resolveEntry('banana', true, false)).toEqual({ mode: 'simple', showChooser: false });
  });
  it('flag off: always simple and never the chooser, so ?mode=pro falls back to simple', () => {
    for (const raw of [null, 'pro', 'simple', 'x']) expect(resolveEntry(raw, false, false)).toEqual({ mode: 'simple', showChooser: false });
  });
  it('flag on: no mode shows the chooser; pro on a phone shows the chooser again', () => {
    expect(resolveEntry(null, true, false).showChooser).toBe(true);
    expect(resolveEntry('pro', true, true).showChooser).toBe(true);
    expect(resolveEntry('pro', true, false)).toEqual({ mode: 'pro', showChooser: false });
  });
});

describe('engines', () => {
  it('createEditor("pro") loads nothing, adds nothing to the page and rejects', async () => {
    const host = document.createElement('div');
    await expect(createEditor('pro', host)).rejects.toThrow(/not available/i);
    expect(host.childElementCount).toBe(0);
  });
});

describe('assertSnapshot', () => {
  const good = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, engine: 'simple', state: {}, assets: {} };
  it('accepts a matching snapshot', () => {
    expect(() => assertSnapshot(good, 'simple')).not.toThrow();
  });
  it('rejects the other engine, or no engine, with EngineMismatchError', () => {
    expect(() => assertSnapshot(good, 'pro')).toThrow(EngineMismatchError);
    expect(() => assertSnapshot({ ...good, engine: undefined }, 'simple')).toThrow(EngineMismatchError);
  });
  it('rejects other schema versions, garbage, and non-Blob assets', () => {
    expect(() => assertSnapshot({ ...good, schemaVersion: 2 }, 'simple')).toThrow(/format version 2/);
    expect(() => assertSnapshot('x', 'simple')).toThrow(SnapshotError);
    expect(() => assertSnapshot({ ...good, assets: { a: 'data:image/png;base64,AAAA' } }, 'simple')).toThrow(SnapshotError);
  });
});

describe('inspectImage (reads bytes, never the name or the claimed type)', () => {
  it('accepts a real PNG, JPEG and WebP and reads their size from the header', async () => {
    expect(await inspectImage(realPng())).toEqual({ kind: 'png', width: 24, height: 16 });
    expect(await inspectImage(realJpeg())).toEqual({ kind: 'jpeg', width: 24, height: 16 });
    expect(await inspectImage(realWebp())).toEqual({ kind: 'webp', width: 24, height: 16 });
  });
  it('ignores a wrong or missing MIME type when the bytes are right', async () => {
    expect((await inspectImage(realPng(''))).kind).toBe('png');
    expect((await inspectImage(realJpeg('image/png'))).kind).toBe('jpeg');
    expect((await inspectImage(realWebp('application/octet-stream'))).kind).toBe('webp');
  });
  it('reads the size of each format from a header-only file', async () => {
    expect(await inspectImage(pngHeader(1234, 567))).toMatchObject({ kind: 'png', width: 1234, height: 567 });
    expect(await inspectImage(jpegHeader(1234, 567))).toMatchObject({ kind: 'jpeg', width: 1234, height: 567 });
    expect(await inspectImage(webpHeader(1234, 567))).toMatchObject({ kind: 'webp', width: 1234, height: 567 });
  });
  it('allows exactly 40 megapixels and refuses one pixel more', async () => {
    expect(await inspectImage(pngHeader(8000, 5000))).toMatchObject({ width: 8000, height: 5000 });
    await expect(inspectImage(pngHeader(8000, 5001))).rejects.toMatchObject({ problem: 'too-many-pixels' });
    expect(MAX_UPLOAD_PIXELS).toBe(40_000_000);
  });
  it('allows exactly 10 MB and refuses one byte more, before it reads any size', async () => {
    const at = new Blob([pngHeader(10, 10), new Uint8Array(MAX_UPLOAD_BYTES - pngHeader(10, 10).size)]);
    expect(at.size).toBe(MAX_UPLOAD_BYTES);
    await expect(inspectImage(at)).resolves.toMatchObject({ kind: 'png' });
    await expect(inspectImage(new Blob([at, new Uint8Array(1)]))).rejects.toMatchObject({ problem: 'too-big' });
  });
  it('reads a JPEG size that sits after a long metadata segment', async () => {
    const pad = new Uint8Array(60000);
    const app1 = new Uint8Array([0xff, 0xe1, (pad.length + 2) >> 8, (pad.length + 2) & 255]);
    const header = new Uint8Array(await jpegHeader(300, 200).arrayBuffer());
    const file = new Blob([new Uint8Array([0xff, 0xd8]), app1, pad, header.subarray(2 + 18)]); // SOI, long APP1, then jpegHeader's SOF0
    expect(await inspectImage(file)).toMatchObject({ kind: 'jpeg', width: 300, height: 200 });
  });
  it('says what is wrong with SVG, GIF, text, empty and damaged files', async () => {
    await expect(inspectImage(svgBlob('image/png'))).rejects.toThrow(/SVG/);
    await expect(inspectImage(new Blob(['﻿  <?xml version="1.0"?><svg xmlns="x"/>']))).rejects.toMatchObject({ problem: 'svg' });
    await expect(inspectImage(gifBlob())).rejects.toThrow(/GIF/);
    await expect(inspectImage(new Blob(['hello']))).rejects.toMatchObject({ problem: 'not-an-image' });
    await expect(inspectImage(new Blob([]))).rejects.toThrow(/empty/);
    await expect(inspectImage(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])]))).rejects.toMatchObject({ problem: 'damaged' });
    await expect(inspectImage(pngHeader(0, 5))).rejects.toBeInstanceOf(UploadError);
  });
  it('every refusal is a sentence a customer can read', async () => {
    for (const file of [svgBlob(), gifBlob(), new Blob(['x']), pngHeader(9000, 9000)]) {
      const error = (await inspectImage(file).catch((e: unknown) => e)) as UploadError;
      expect(error.message).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe('downscaledSize', () => {
  it('leaves small pictures alone and never enlarges', () => {
    expect(downscaledSize(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
    expect(downscaledSize(MAX_LONG_EDGE, 10)).toMatchObject({ scaled: false });
  });
  it('brings the long edge to 2000 and keeps the shape', () => {
    expect(downscaledSize(4000, 3000)).toEqual({ width: 2000, height: 1500, scaled: true });
    expect(downscaledSize(3000, 6000)).toEqual({ width: 1000, height: 2000, scaled: true });
    expect(downscaledSize(20000, 1)).toEqual({ width: 2000, height: 1, scaled: true });
  });
});

describe('font list', () => {
  it('has the five fonts: the two site fonts and three more, each with one weight', () => {
    expect(FONT_LIST.map((f) => f.family)).toEqual(['Jost', 'Cormorant Garamond', 'Bebas Neue', 'Caveat', 'Pacifico']);
  });
});

describe('exportSize (the 4096 cap)', () => {
  it('1x is 800 px and 2x is 1600 px', () => {
    expect(exportSize(1)).toEqual({ multiplier: 1, px: 800 });
    expect(exportSize(2)).toEqual({ multiplier: 2, px: 1600 });
  });
  it('never gives more than 4096 px on a side, however much is asked for', () => {
    expect(exportSize(5).px).toBe(4000);
    expect(exportSize(5.12).px).toBe(4096);
    expect(exportSize(5.2).px).toBe(4096);
    expect(exportSize(100).px).toBe(MAX_EXPORT_PX);
    expect(exportSize(Number.POSITIVE_INFINITY).px).toBe(800); // nonsense falls back to 1x
  });
  it('treats nonsense as 1x and never gives less than a pixel', () => {
    for (const bad of [0, -3, Number.NaN]) expect(exportSize(bad).px).toBe(800);
    expect(exportSize(0.0001).px).toBe(1);
  });
  it('the multiplier it returns reproduces the pixel size exactly', () => {
    for (const m of [0.5, 1, 1.5, 2, 3.3, 5.12, 9]) expect(Math.round(800 * exportSize(m).multiplier)).toBe(exportSize(m).px);
  });
});

describe('view maths', () => {
  const v = (w = 600, h = 600) => fitted(w, h);
  it('fits the design in the smaller side of the view and centres it', () => {
    const f = v(600, 400);
    expect(f.zoom).toBeCloseTo(0.5, 6);
    expect(f.panX).toBeCloseTo((600 - 400) / 2, 6);
    expect(f.panY).toBeCloseTo(0, 6);
    expect(f.atFit).toBe(true);
  });
  it('limits: 50% to 400%, or the fit when the view is so small the fit is below 50%', () => {
    expect(zoomLimits(600, 600)).toMatchObject({ min: 0.5, max: 4 });
    const phone = zoomLimits(360, 360);
    expect(phone.fit).toBeCloseTo(0.45, 6);
    expect(phone.min).toBeCloseTo(0.45, 6);
    expect(zoomLimits(2000, 2000).min).toBe(0.5);
  });
  it('zoomAbout keeps the point under the anchor, for any anchor and any zoom', () => {
    let s = v(500, 500);
    for (const [z, ax, ay] of [[1.2, 100, 400], [2, 480, 20], [3.1, 250, 250], [0.9, 10, 10]] as const) {
      const anchor = { x: ax, y: ay };
      const at = viewToDesign(s, ax, ay);
      s = zoomAbout(s, z, anchor);
      const after = viewToDesign(s, ax, ay);
      // unless the pan had to be held inside the design, the point has not moved
      if (s.zoom * 800 > s.width && s.panX < 0 && s.panX > s.width - 800 * s.zoom) expect(after.x).toBeCloseTo(at.x, 4);
      expect(s.zoom).toBeGreaterThanOrEqual(zoomLimits(500, 500).min);
      expect(s.zoom).toBeLessThanOrEqual(4);
    }
  });
  it('zoomAbout ignores nonsense', () => {
    const s = v();
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) expect(zoomAbout(s, bad)).toBe(s);
  });
  it('clampPan keeps a zoomed design covering the view and a small one centred', () => {
    expect(clampPan(600, 600, 2, 50, 50)).toEqual({ panX: 0, panY: 0 });
    expect(clampPan(600, 600, 2, -9999, -9999)).toEqual({ panX: 600 - 1600, panY: 600 - 1600 });
    expect(clampPan(600, 600, 0.5, 123, 456)).toEqual({ panX: 100, panY: 100 });
  });
  it('a resized view stays fitted if it was fitted, and otherwise keeps its zoom inside the new limits', () => {
    const f = v(600, 600);
    expect(resized(f, 300, 300)).toMatchObject({ atFit: true, zoom: 300 / 800 });
    const z = zoomAbout(f, 2);
    const r = resized(z, 300, 300);
    expect(r.atFit).toBe(false);
    expect(r.zoom).toBe(2);
    expect(r.panX).toBeLessThanOrEqual(0);
  });
  it('panning at the fit does nothing, and zoomed it moves the design', () => {
    const f = v();
    expect(panned(f, 50, 50)).toMatchObject({ panX: f.panX, panY: f.panY });
    const z = zoomAbout(f, 2);
    expect(panned(z, -30, -10)).toMatchObject({ panX: z.panX - 30, panY: z.panY - 10 });
  });
});

describe('export file names', () => {
  const day = new Date(2026, 9, 21, 23, 59); // 21 October 2026, late in the evening: the person's own calendar day
  it('says what, which colour and size, when, which file, and the scale', () => {
    expect(exportFileName({ product: 'Men Crew Tee', color: 'Navy', size: 'M', kind: 'preview', scale: 2, date: day })).toBe('men-crew-tee-navy-M-2026-10-21-preview-2x.png');
    expect(exportFileName({ product: 'Men Crew Tee', color: 'Navy', size: 'M', kind: 'design', scale: 1, date: day })).toBe('men-crew-tee-navy-M-2026-10-21-design-only-1x.png');
  });
  it('is safe as a file name whatever the product is called', () => {
    const name = exportFileName({ product: 'Café "Déjà vu" / Tee: 100%!', color: 'Off White', size: 'xxl', kind: 'design', scale: 2, date: day });
    expect(name).toBe('cafe-deja-vu-tee-100-off-white-XXL-2026-10-21-design-only-2x.png');
    expect(name).toMatch(/^[a-zA-Z0-9.-]+$/);
    expect(slug('///')).toBe('design');
  });
});
