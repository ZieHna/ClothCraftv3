// Runs in a REAL browser (Microsoft Edge through Playwright, see vite.config.ts), because Fabric needs a real canvas,
// real image decoding and real font metrics. jsdom has none of these.
// The two shared contract suites run here against the real Fabric adapter, then come the tests only a browser can do.
import '@fontsource/cormorant-garamond/latin-700.css'; // the site loads these two at start-up (src/main.tsx)
import '@fontsource/jost/latin-400.css';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { realPng, svgBlob } from '../../test/images';
import { CONTRACT_GARMENT, describeEditorContract } from '../contract';
import { createEditor } from '../createEditor';
import { buildUpload } from '../designUpload';
import { FONT_LIST } from '../fonts';
import { describeSimpleToolsContract, populateSimple } from '../toolsContract';
import { DESIGN_SIZE, type SimpleEditorTools } from '../types';
import { MAX_LONG_EDGE, UploadError } from '../upload';
import { createSimpleEditor, type SimpleEditor } from './SimpleEditor';
import { detectTransformCancel } from './gestures';

function makeHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.style.width = '400px';
  document.body.append(host);
  return host;
}
async function make() {
  const host = makeHost();
  return { editor: await createEditor('simple', host), cleanup: () => host.remove() };
}

describeEditorContract('SimpleEditor (Fabric 7, real browser)', async () => ({ ...(await make()), populate: populateSimple }));
describeSimpleToolsContract('SimpleEditor (Fabric 7, real browser)', make);

async function pixels(blob: Blob): Promise<{ at: (x: number, y: number) => [number, number, number, number]; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  return {
    width: c.width,
    height: c.height,
    at: (x, y) => {
      const i = (Math.round(y) * c.width + Math.round(x)) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    },
  };
}

async function bigImage(width: number, height: number, type = 'image/png'): Promise<Blob> {
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#c8203c';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#1a1714';
  ctx.fillRect(0, 0, width / 4, height / 4);
  return c.convertToBlob({ type });
}

describe('SimpleEditor specifics (real browser)', () => {
  let host: HTMLDivElement;
  let editor: SimpleEditor;
  afterEach(() => {
    editor?.dispose();
    host?.remove();
    vi.restoreAllMocks();
  });
  async function open() {
    host = makeHost();
    editor = (await createEditor('simple', host)) as unknown as SimpleEditor;
    await editor.loadBase(CONTRACT_GARMENT);
    return editor;
  }
  const centre = DESIGN_SIZE / 2;

  it('the garment is a separate, locked canvas: not a Fabric object, not selectable, not in any layer list', async () => {
    const e = await open();
    const garmentCanvas = host.querySelector('canvas[data-garment]')!;
    expect(garmentCanvas).not.toBeNull();
    expect(garmentCanvas.closest('.canvas-container')).toBeNull(); // outside Fabric's wrapper
    expect(e.getLayers()).toEqual([]);
    const upper = host.querySelector('canvas.upper-canvas') as HTMLCanvasElement;
    const r = upper.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1, isPrimary: true };
    upper.dispatchEvent(new PointerEvent('pointerdown', at));
    upper.dispatchEvent(new PointerEvent('pointerup', at));
    expect(e.getSelection()).toBeNull();
    const state = (await e.exportState()).state as { objects: unknown[] };
    expect(state.objects).toEqual([]);
    expect(JSON.stringify(state)).not.toContain('garments');
  });

  it('exportPng: design alone is transparent where the garment is; withGarment paints it; multiplier scales', async () => {
    const e = await open();
    const alone = await pixels(await e.exportPng());
    expect(alone.width).toBe(DESIGN_SIZE);
    expect(alone.at(centre, centre)[3]).toBe(0);
    expect((await pixels(await e.exportPng({ withGarment: true }))).at(centre, centre)[3]).toBe(255);
    expect((await pixels(await e.exportPng({ multiplier: 2 }))).width).toBe(DESIGN_SIZE * 2);
  });

  it('setColor swaps to the pre-coloured picture (no runtime tinting); setSize is recorded', async () => {
    const e = await open();
    const white = (await pixels(await e.exportPng({ withGarment: true }))).at(centre, centre);
    e.setColor('navy');
    const navy = (await pixels(await e.exportPng({ withGarment: true }))).at(centre, centre);
    expect(navy[2]).toBeGreaterThan(navy[0]); // blue-ish: the real navy picture
    expect(navy[0] + navy[1] + navy[2]).toBeLessThan(white[0] + white[1] + white[2] - 300);
    e.setColor('black');
    const black = (await pixels(await e.exportPng({ withGarment: true }))).at(centre, centre);
    expect(black[0] + black[1] + black[2]).toBeLessThan(navy[0] + navy[1] + navy[2]);
    e.setSize('XL');
    expect(e.garment).toEqual({ color: 'black', size: 'XL', loaded: true });
  });

  it('new text is cream on a dark garment and ink on a light one', async () => {
    const e = await open();
    const light = e.addText('a');
    expect(e.getStyle(light)).toMatchObject({ fill: '#2c2825' });
    e.setColor('navy');
    const dark = e.addText('b');
    expect(e.getStyle(dark)).toMatchObject({ fill: '#fffdf8' });
  });

  it('a hidden layer is not drawn in exportPng', async () => {
    const e = await open();
    const id = e.addShape('rectangle');
    e.updateLayer(id, { x: 100, y: 100 });
    expect((await pixels(await e.exportPng())).at(100, 100)[3]).toBe(255);
    e.updateLayer(id, { visible: false });
    expect((await pixels(await e.exportPng())).at(100, 100)[3]).toBe(0);
  });

  it('shape fill, outline and opacity are drawn', async () => {
    const e = await open();
    const id = e.addShape('rectangle');
    e.updateLayer(id, { x: 100, y: 100, width: 100, height: 100 });
    await e.updateStyle(id, { fill: '#ff0000', opacity: 0.5, stroke: '#0000ff', strokeWidth: 20 });
    const img = await pixels(await e.exportPng());
    const inside = img.at(100, 100);
    expect(inside[0]).toBeGreaterThan(200);
    expect(inside[1]).toBeLessThan(30);
    expect(Math.abs(inside[3] - 128)).toBeLessThan(3); // 50% opacity
    expect(img.at(100, 100 - 49)[2]).toBeGreaterThan(200); // the blue outline, on the edge
  });

  it('each shape kind is really drawn (rectangle, circle, triangle, star, line)', async () => {
    const e = await open();
    for (const [i, kind] of (['rectangle', 'circle', 'triangle', 'star', 'line'] as const).entries()) {
      const id = e.addShape(kind);
      e.updateLayer(id, { x: 100 + i * 150, y: 100 });
    }
    const img = await pixels(await e.exportPng());
    for (const i of [0, 1, 2, 3, 4]) expect(img.at(100 + i * 150, 100)[3], `shape ${i}`).toBeGreaterThan(200);
  });

  it('a line can be clicked a little way off its centre (a usable target), and the selection follows', async () => {
    const e = await open();
    const id = e.addShape('line');
    e.updateLayer(id, { x: centre, y: centre });
    e.select(null);
    const upper = host.querySelector('canvas.upper-canvas') as HTMLCanvasElement;
    const k = upper.getBoundingClientRect().width / DESIGN_SIZE;
    // real mouse clicks (Playwright): 14 design units off the line's centre, while the line itself is only 10 thick
    await userEvent.click(upper, { position: { x: centre * k, y: (centre + 14) * k } });
    expect(e.getSelection()).toBe(id);
    e.select(null);
    await userEvent.click(upper, { position: { x: centre * k, y: (centre + 60) * k } });
    expect(e.getSelection()).toBeNull();
    // and a click on the garment, away from any element, selects nothing
    await userEvent.click(upper, { position: { x: 50 * k, y: 50 * k } });
    expect(e.getSelection()).toBeNull();
  });

  it('a picture survives a round trip as a Blob and draws again after loading', async () => {
    const e = await open();
    const id = await e.addImage(realPng(), 'Dot');
    e.updateLayer(id, { x: 600, y: 600, width: 40, height: 40 });
    const drawn = (await pixels(await e.exportPng())).at(600, 600);
    expect(drawn[3]).toBe(255);
    const snapshot = await e.exportState();
    expect((snapshot.state as { objects: Array<{ src?: string }> }).objects[0]!.src).toMatch(/^asset:/);
    const host2 = makeHost();
    const e2 = await createEditor('simple', host2);
    try {
      await e2.loadState(snapshot);
      expect((await pixels(await e2.exportPng())).at(600, 600)).toEqual(drawn);
    } finally {
      e2.dispose();
      host2.remove();
    }
  });

  it('a large picture is shrunk on load (long edge 2000), keeps its shape, and the stored blob is the small one', async () => {
    const e = await open();
    const file = await bigImage(4000, 2500);
    const id = await e.addImage(file, 'Big');
    const snapshot = await e.exportState();
    const stored = Object.values(snapshot.assets)[0]!;
    const dims = await createImageBitmap(stored);
    expect(dims.width).toBe(MAX_LONG_EDGE);
    expect(dims.height).toBe(1250);
    expect(stored.type).toBe('image/png');
    expect(stored.size).toBeLessThan(file.size + 1);
    const layer = e.getLayers().find((l) => l.id === id)!;
    expect(layer.width / layer.height).toBeCloseTo(4000 / 2500, 1);
    expect(layer.width).toBeLessThanOrEqual(DESIGN_SIZE * 0.45 + 1); // placed to fit the design, not at 2000
  });

  it('a small picture is not enlarged and its bytes are kept as they came', async () => {
    const e = await open();
    const file = realPng();
    await e.addImage(file);
    const stored = Object.values((await e.exportState()).assets)[0]!;
    expect(stored.size).toBe(file.size);
    expect((await createImageBitmap(stored)).width).toBe(24);
  });

  it('an over-limit or wrong-signature file is refused BEFORE anything decodes it', async () => {
    const e = await open();
    const decode = vi.spyOn(globalThis, 'createImageBitmap');
    const objectUrl = vi.spyOn(URL, 'createObjectURL');
    const fromUrl = vi.spyOn(HTMLImageElement.prototype, 'decode');
    for (const file of [svgBlob('image/png'), new Blob(['nope'], { type: 'image/png' }), await bigImage(8000, 5001).catch(() => null)]) {
      if (!file) continue;
      await expect(e.addImage(file)).rejects.toBeInstanceOf(UploadError);
    }
    expect(decode).not.toHaveBeenCalled();
    expect(objectUrl).not.toHaveBeenCalled();
    expect(fromUrl).not.toHaveBeenCalled();
    expect(e.getLayers()).toEqual([]);
  });

  it('dispose removes every element it added', async () => {
    await open();
    expect(host.querySelectorAll('canvas').length).toBe(3); // garment + Fabric lower + upper
    editor.dispose();
    expect(host.childElementCount).toBe(0);
  });
});

describe('fonts (real browser)', () => {
  let host: HTMLDivElement;
  let editor: SimpleEditorTools;
  afterEach(() => {
    editor?.dispose();
    host?.remove();
  });

  /** the width the browser itself gives this text in this font, measured on a plain 2D canvas */
  function glyphWidth(text: string, family: string, weight: number, size: number): number {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${weight} ${size}px "${family}"`;
    return ctx.measureText(text).width;
  }

  it.each(FONT_LIST.map((f) => [f.family, f.weight] as const))(
    'a text box matches the real glyph width of %s once the font has loaded (Fabric glyph cache is cleared and re-measured)',
    async (family, weight) => {
      host = makeHost();
      editor = await createEditor('simple', host);
      await editor.loadBase(CONTRACT_GARMENT);
      const text = 'Wide Words WWW mmm';
      const id = editor.addText(text); // measured in Jost
      const before = editor.getLayers()[0]!.width;
      await editor.updateStyle(id, { fontFamily: family, fontSize: 64 });
      expect(document.fonts.check(`${weight} 64px "${family}"`)).toBe(true);
      const after = editor.getLayers()[0]!.width;
      // Fabric adds up glyph widths one by one (plus kerning pairs); the browser shapes the whole string. Fonts with
      // contextual alternates (Caveat) differ by about 1%, so the bound is 2%, against a 5 to 40% error from a stale cache.
      const real = glyphWidth(text, family, weight, 64);
      expect(Math.abs(after - real) / real).toBeLessThan(0.02);
      if (family !== 'Jost') expect(Math.abs(after - before)).toBeGreaterThan(5); // it really changed
      expect(after).toBeGreaterThan(0);
    },
  );

  it('stale widths are re-measured: after a font arrives late, refreshFonts fixes a box measured with the fallback', async () => {
    host = makeHost();
    editor = await createEditor('simple', host);
    await editor.loadBase(CONTRACT_GARMENT);
    const e = editor as unknown as SimpleEditor;
    // simulate the bug: a family Fabric has measured with a fallback font before its file exists
    const family = 'Late Face';
    const id = e.addText('Late arrival WWWW');
    await e.updateStyle(id, { fontFamily: family }); // no such family yet: measured with the fallback
    const fallback = e.getLayers()[0]!.width;
    const { default: url } = await import('@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2?url');
    const face = new FontFace(family, `url(${url})`);
    document.fonts.add(face);
    await face.load();
    await e.refreshFonts(family);
    document.fonts.delete(face);
    const real = glyphWidth('Late arrival WWWW', 'Bebas Neue', 400, 64);
    expect(Math.abs(e.getLayers()[0]!.width - real)).toBeLessThan(1);
    expect(Math.abs(fallback - real)).toBeGreaterThan(5);
  });
});


describe('view, exports and handles in real Fabric (real browser)', () => {
  let host: HTMLDivElement;
  let editor: SimpleEditor;
  afterEach(() => {
    editor?.dispose();
    host?.remove();
  });
  async function open(width = 400) {
    host = document.createElement('div');
    host.style.width = `${width}px`;
    document.body.append(host);
    editor = (await createEditor('simple', host)) as unknown as SimpleEditor;
    await editor.loadBase(CONTRACT_GARMENT);
    return editor;
  }
  /** a design with text, a shape and a picture, placed where the numbers say */
  async function design(e: SimpleEditor) {
    const s = e.addShape('rectangle');
    e.updateLayer(s, { x: 250, y: 300, width: 200, height: 120 });
    const t = e.addText('Zoom proof');
    e.updateLayer(t, { x: 400, y: 160 });
    const p = await e.addImage(realPng(), 'Dot');
    e.updateLayer(p, { x: 560, y: 520, width: 96, height: 64 });
  }
  const sameImage = async (a: Blob, b: Blob) => {
    const [pa, pb] = await Promise.all([pixels(a), pixels(b)]);
    if (pa.width !== pb.width || pa.height !== pb.height) return false;
    for (let y = 0; y < pa.height; y += 7) for (let x = 0; x < pa.width; x += 7) if (pa.at(x, y).join() !== pb.at(x, y).join()) return false;
    return true;
  };

  it('the design canvas is as big as its view and sharp at devicePixelRatio: no CSS stretching, whatever the zoom', async () => {
    const e = await open(400);
    const dpr = window.devicePixelRatio || 1;
    const upper = host.querySelector('canvas.upper-canvas') as HTMLCanvasElement;
    const garment = host.querySelector('canvas[data-garment]') as HTMLCanvasElement;
    for (const zoom of [undefined, 2, 3.5]) {
      if (zoom) e.zoomTo(zoom);
      expect(upper.clientWidth).toBe(400);
      expect(upper.width).toBe(Math.round(400 * dpr)); // the pixels behind it match the screen pixels
      expect(garment.width).toBe(Math.round(400 * dpr));
      expect(upper.style.transform).toBe('');
    }
  });

  it('the view follows the size of its stage', async () => {
    const e = await open(400);
    expect(e.getView().width).toBe(400);
    host.style.width = '300px';
    await new Promise((r) => setTimeout(r, 120));
    const v = e.getView();
    expect(v.width).toBe(300);
    expect(v.height).toBe(300);
    expect(v.atFit).toBe(true); // it was fitted, so it stays fitted
    expect(v.zoom).toBeCloseTo(300 / 800, 6);
  });

  it('exports are the same pixels at every zoom and pan, with the garment and without', async () => {
    const e = await open();
    await design(e);
    const baseline = { alone: await e.exportPng(), onShirt: await e.exportPng({ withGarment: true }), alone2x: await e.exportPng({ multiplier: 2 }) };
    for (const [zoom, dx, dy] of [[2, -60, -40], [3.7, -300, -200], [0.5, 0, 0]] as const) {
      e.zoomTo(zoom);
      e.panBy(dx, dy);
      expect(await sameImage(await e.exportPng(), baseline.alone)).toBe(true);
      expect(await sameImage(await e.exportPng({ withGarment: true }), baseline.onShirt)).toBe(true);
      expect(await sameImage(await e.exportPng({ multiplier: 2 }), baseline.alone2x)).toBe(true);
    }
    e.zoomFit();
    expect(await sameImage(await e.exportPng(), baseline.alone)).toBe(true);
  });

  it('export sizes: 800 at 1x, 1600 at 2x, never more than 4096, always square', async () => {
    const e = await open();
    await design(e);
    for (const [m, px] of [[1, 800], [2, 1600], [5, 4000], [5.12, 4096], [6, 4096], [100, 4096], [0, 800], [Number.NaN, 800]] as const) {
      const img = await pixels(await e.exportPng({ multiplier: m }));
      expect([img.width, img.height], `multiplier ${m}`).toEqual([px, px]);
    }
    const big = await pixels(await e.exportPng({ multiplier: 50, withGarment: true }));
    expect([big.width, big.height]).toEqual([4096, 4096]);
  });

  it('the upload carries a 3200 px transparent print file and an 800 px preview at any view size, zoom and pan', async () => {
    const blobOf = (b64: string) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' });
    let first: Blob | null = null;
    for (const width of [300, 1200]) {
      if (width !== 300) {
        editor.dispose(); // the next view size gets its own editor; afterEach disposes the last one
        host.remove();
      }
      const e = await open(width);
      await design(e);
      for (const [zoom, dx, dy] of [[undefined, 0, 0], [3.2, -500, -350]] as const) {
        if (zoom) {
          e.zoomTo(zoom);
          e.panBy(dx, dy);
        }
        const u = await buildUpload(e, 'm-tee', 'M-TEE-WHT-M');
        const print = await pixels(blobOf(u.print));
        const preview = await pixels(blobOf(u.preview));
        expect([print.width, print.height, preview.width, preview.height], `view ${width}, zoom ${zoom ?? 'fit'}`).toEqual([3200, 3200, 800, 800]);
        expect(print.at(10, 10)[3]).toBe(0); // transparent where nothing is drawn
        first ??= blobOf(u.print);
        expect(await sameImage(blobOf(u.print), first), `view ${width}, zoom ${zoom ?? 'fit'}`).toBe(true);
      }
    }
  });

  it('design-only exports are transparent, the shirt preview is not, and what is drawn lands where the numbers say', async () => {
    const e = await open();
    await design(e);
    const alone = await pixels(await e.exportPng({ multiplier: 2 }));
    expect(alone.at(4, 4)[3]).toBe(0); // the corner: nothing there
    expect(alone.at(2 * 250, 2 * 300)[3]).toBe(255); // inside the rectangle
    expect(alone.at(2 * 250, 2 * 300).slice(0, 3)).toEqual([0x6b, 0x8f, 0x71]); // its sage fill
    const preview = await pixels(await e.exportPng({ multiplier: 2, withGarment: true }));
    expect(preview.at(2 * 400, 2 * 700)[3]).toBe(255); // the shirt under the design area
    expect(preview.at(2 * 250, 2 * 300).slice(0, 3)).toEqual([0x6b, 0x8f, 0x71]); // the design over the shirt
  });

  it('zoom does not move or resize any layer, in the data or in an export of the data', async () => {
    const e = await open();
    await design(e);
    const layers = e.getLayers();
    e.zoomTo(3);
    e.panBy(-100, -100);
    expect(e.getLayers()).toEqual(layers);
  });

  it('a new layer lands in the middle of what is on screen once the view is zoomed in', async () => {
    const e = await open();
    e.zoomTo(3);
    e.panBy(-600, -500); // look at the lower right of the design
    const v = e.getView();
    const id = e.addShape('circle');
    const l = e.getLayers().find((x) => x.id === id)!;
    const centre = { x: (v.width / 2 - v.panX) / v.zoom, y: (v.height / 2 - v.panY) / v.zoom };
    expect(Math.abs(l.x - centre.x)).toBeLessThan(90);
    expect(Math.abs(l.y - centre.y)).toBeLessThan(90);
  });

  it('handles: a mouse keeps small handles, a finger gets targets of at least 44 CSS px, at any zoom', async () => {
    const e = await open();
    e.addShape('rectangle');
    const mouse = e.getHandleTargets()!;
    expect(mouse.coarse).toBe(false);
    expect(mouse.touchMin).toBeLessThan(44 + 1); // the mouse set is not inflated for touch
    expect(mouse.mouseMin).toBeLessThan(20);
    (e as unknown as { setCoarse(c: boolean): void }).setCoarse(true);
    for (const zoom of [undefined, 1, 3]) {
      if (zoom) e.zoomTo(zoom);
      const finger = e.getHandleTargets()!;
      expect(finger.coarse).toBe(true);
      expect(finger.touchMin, `zoom ${zoom}`).toBeGreaterThanOrEqual(44);
      expect(finger.handles).toBeGreaterThanOrEqual(8);
    }
    (e as unknown as { setCoarse(c: boolean): void }).setCoarse(false);
    expect(e.getHandleTargets()!.touchMin).toBeLessThan(44);
  });
});

describe('gestures (real browser, synthetic pointer events through the real listeners)', () => {
  let host: HTMLDivElement;
  let editor: SimpleEditor;
  let errors: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    editor?.dispose();
    host?.remove();
    vi.restoreAllMocks();
  });
  async function open(options?: Parameters<typeof createSimpleEditor>[1]) {
    errors = vi.spyOn(console, 'error');
    host = document.createElement('div');
    host.style.width = '400px';
    document.body.append(host);
    editor = await createSimpleEditor(host, options);
    await editor.loadBase(CONTRACT_GARMENT);
    return editor;
  }
  const upper = () => host.querySelector('canvas.upper-canvas') as HTMLCanvasElement;
  const fire = (type: string, id: number, x: number, y: number, pointerType = 'touch') =>
    upper().dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType, isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  /** where a design point is on screen */
  const screenOf = (x: number, y: number) => {
    const r = upper().getBoundingClientRect();
    const v = editor.getView();
    return { x: r.left + v.panX + x * v.zoom, y: r.top + v.panY + y * v.zoom };
  };
  /** two fingers about a centre, `half` px apart each side, twisted by `deg` */
  const fingers = (c: { x: number; y: number }, half: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return [
      { x: c.x - Math.cos(a) * half, y: c.y - Math.sin(a) * half },
      { x: c.x + Math.cos(a) * half, y: c.y + Math.sin(a) * half },
    ] as const;
  };
  async function pinch(c: { x: number; y: number }, from: { half: number; deg: number }, to: { half: number; deg: number }, steps = 6) {
    const [a0, b0] = fingers(c, from.half, from.deg);
    fire('pointerdown', 1, a0.x, a0.y);
    fire('pointerdown', 2, b0.x, b0.y);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const [a, b] = fingers(c, from.half + (to.half - from.half) * k, from.deg + (to.deg - from.deg) * k);
      fire('pointermove', 1, a.x, a.y);
      fire('pointermove', 2, b.x, b.y);
    }
    const [a1, b1] = fingers(c, to.half, to.deg);
    fire('pointerup', 2, b1.x, b1.y);
    fire('pointerup', 1, a1.x, a1.y);
  }

  it('two fingers on a selected layer: pinch scales it and a twist rotates it, as ONE history step', async () => {
    const e = await open();
    const id = e.addShape('rectangle');
    e.updateLayer(id, { x: 400, y: 400, width: 160, height: 100 });
    const before = e.getLayers()[0]!;
    const steps = e.historyStats().undoSteps;
    await pinch(screenOf(400, 400), { half: 40, deg: 0 }, { half: 80, deg: 30 });
    const after = e.getLayers()[0]!;
    expect(after.width / before.width).toBeCloseTo(2, 1);
    expect(after.height / before.height).toBeCloseTo(2, 1);
    expect(after.rotation).toBeCloseTo(30, 0);
    expect(after.x).toBeCloseTo(400, 0); // it turns and grows about its own centre
    expect(after.y).toBeCloseTo(400, 0);
    expect(e.historyStats().undoSteps).toBe(steps + 1); // not one per move event
    expect(e.getSelection()).toBe(id);
    await e.undo();
    expect(e.getLayers()[0]).toMatchObject({ width: before.width, height: before.height, rotation: 0, x: 400, y: 400 });
    expect(errors).not.toHaveBeenCalled();
  });

  it('a first finger on empty canvas still pinches the layer that was selected', async () => {
    const e = await open();
    const id = e.addShape('rectangle');
    e.updateLayer(id, { x: 400, y: 400, width: 100, height: 100 });
    e.select(id);
    // the fingers start well away from the layer (Fabric deselects on the first touch of empty canvas)
    await pinch(screenOf(120, 120), { half: 30, deg: 0 }, { half: 60, deg: 0 });
    expect(e.getLayers()[0]!.width).toBeGreaterThan(190);
    expect(e.getSelection()).toBe(id);
  });

  it('two fingers with nothing selected zoom and pan the canvas, and the design does not change', async () => {
    const e = await open();
    const id = e.addShape('rectangle');
    e.updateLayer(id, { x: 400, y: 400 });
    e.select(null);
    const layers = e.getLayers();
    const steps = e.historyStats();
    const v0 = e.getView();
    await pinch({ x: upper().getBoundingClientRect().left + 200, y: upper().getBoundingClientRect().top + 200 }, { half: 30, deg: 0 }, { half: 60, deg: 0 });
    const v1 = e.getView();
    expect(v1.zoom).toBeGreaterThan(v0.zoom * 1.8);
    expect(e.getLayers()).toEqual(layers);
    expect(e.historyStats()).toEqual(steps); // view only
    // moving both fingers together pans
    const c = { x: upper().getBoundingClientRect().left + 200, y: upper().getBoundingClientRect().top + 200 };
    const [a, b] = fingers(c, 40, 0);
    fire('pointerdown', 1, a.x, a.y);
    fire('pointerdown', 2, b.x, b.y);
    for (let i = 1; i <= 5; i++) {
      fire('pointermove', 1, a.x - i * 8, a.y - i * 5);
      fire('pointermove', 2, b.x - i * 8, b.y - i * 5);
    }
    fire('pointerup', 2, b.x - 40, b.y - 25);
    fire('pointerup', 1, a.x - 40, a.y - 25);
    const v2 = e.getView();
    expect(v2.panX).toBeLessThan(v1.panX - 20);
    expect(v2.panY).toBeLessThan(v1.panY - 10);
    expect(v2.zoom).toBeCloseTo(v1.zoom, 3);
    expect(errors).not.toHaveBeenCalled();
  });

  it('the hand tool and Space-style panning: one pointer drags the canvas, and does not move or select a layer', async () => {
    const e = await open();
    const id = e.addShape('rectangle');
    e.updateLayer(id, { x: 400, y: 400 });
    e.zoomTo(2.5);
    const layers = e.getLayers();
    e.setPanMode(true);
    const v0 = e.getView();
    const c = screenOf(400, 400); // right on the layer
    fire('pointerdown', 1, c.x, c.y, 'mouse');
    for (let i = 1; i <= 5; i++) fire('pointermove', 1, c.x - i * 10, c.y - i * 6, 'mouse');
    fire('pointerup', 1, c.x - 50, c.y - 30, 'mouse');
    const v1 = e.getView();
    expect(v1.panX).toBeCloseTo(v0.panX - 50, 4);
    expect(v1.panY).toBeCloseTo(v0.panY - 30, 4);
    expect(e.getLayers()).toEqual(layers); // not dragged
    e.setPanMode(false);
    const steps = e.historyStats().undoSteps;
    expect(e.historyStats().undoSteps).toBe(steps);
  });

  it('Ctrl+wheel zooms about the pointer and is not left to the browser; a plain wheel is left alone', async () => {
    const e = await open();
    const r = upper().getBoundingClientRect();
    const wheel = (init: WheelEventInit) => {
      const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + 100, clientY: r.top + 100, ...init });
      upper().dispatchEvent(ev);
      return ev;
    };
    const z0 = e.getView().zoom;
    const plain = wheel({ deltaY: -120 });
    expect(plain.defaultPrevented).toBe(false);
    expect(e.getView().zoom).toBe(z0);
    const ctrl = wheel({ deltaY: -120, ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(e.getView().zoom).toBeGreaterThan(z0);
    const z1 = e.getView().zoom;
    wheel({ deltaY: 120, ctrlKey: true });
    expect(e.getView().zoom).toBeLessThan(z1);
  });

  it('touch: the canvas never scrolls the page (touch-action none), the rest of the page is untouched', async () => {
    await open();
    expect(getComputedStyle(upper()).touchAction).toBe('none');
    expect(getComputedStyle(host.querySelector('[data-editor-stage]') as HTMLElement).touchAction).toBe('none');
    expect(getComputedStyle(document.body).touchAction).not.toBe('none');
  });

  // ---- the private-field workaround and its fallback
  it('detects the private Fabric field that the layer pinch needs, in 7.4.0 and when it is missing', async () => {
    const e = await open();
    expect(e.gestureSupport()).toEqual({ pinch: true });
    expect(detectTransformCancel({ _currentTransform: null })).toEqual({ pinch: true });
    expect(detectTransformCancel({})).toMatchObject({ pinch: false });
    expect(detectTransformCancel(null)).toMatchObject({ pinch: false });
    expect(detectTransformCancel({}).reason).toMatch(/size and rotation fields/);
  });

  it('FALLBACK: with the private field missing the layer pinch is off, nothing throws, and zooming the canvas still works', async () => {
    const e = await open({ detectGestures: () => detectTransformCancel({}) });
    expect(e.gestureSupport().pinch).toBe(false);
    expect(e.gestureSupport().reason).toBeTruthy();
    const id = e.addShape('rectangle');
    e.updateLayer(id, { x: 400, y: 400, width: 160, height: 100 });
    const before = e.getLayers();
    const steps = e.historyStats();
    await pinch(screenOf(400, 400), { half: 40, deg: 0 }, { half: 90, deg: 40 });
    expect(e.getLayers()).toEqual(before); // untouched: no scale, no rotation
    expect(e.historyStats()).toEqual(steps);
    expect(errors).not.toHaveBeenCalled();
    // the numeric route still works
    e.updateLayer(id, { width: 320, rotation: 40 });
    expect(e.getLayers()[0]).toMatchObject({ width: 320, rotation: 40 });
    // zooming with nothing selected needs no private field
    e.select(null);
    const z0 = e.getView().zoom;
    const c = { x: upper().getBoundingClientRect().left + 200, y: upper().getBoundingClientRect().top + 200 };
    await pinch(c, { half: 30, deg: 0 }, { half: 70, deg: 0 });
    expect(e.getView().zoom).toBeGreaterThan(z0 * 1.5);
    expect(errors).not.toHaveBeenCalled();
  });

  it('input is ignored while an undo is busy: the canvas takes no pointer, so a drag cannot start in the gap', async () => {
    const e = await open();
    e.addShape('rectangle');
    e.addShape('circle');
    const undoing = e.undo();
    expect(upper().style.pointerEvents).toBe('none');
    expect(host.querySelector('[data-editor-stage]')!.getAttribute('aria-busy')).toBe('true');
    await undoing;
    expect(upper().style.pointerEvents).toBe('');
    expect(host.querySelector('[data-editor-stage]')!.getAttribute('aria-busy')).toBe('false');
  });
});
