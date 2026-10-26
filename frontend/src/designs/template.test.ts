import { describe, expect, it, vi } from 'vitest';
import { buildSnapshot, DEFAULT_BOX, fetchTemplate, fitState, placement, TemplateError, type TemplateFile } from './template';

const file = (over: Partial<TemplateFile> = {}): TemplateFile => ({
  schemaVersion: 1,
  engine: 'simple',
  frame: 600,
  state: {
    fabric: '7.4.0',
    counter: 2,
    objects: [
      { type: 'Circle', layerId: 'layer-1', left: 400, top: 400, scaleX: 1, scaleY: 1, strokeUniform: true, strokeWidth: 8, width: 100, height: 100 },
      { type: 'IText', layerId: 'layer-2', left: 300, top: 250, scaleX: 2, scaleY: 2, strokeUniform: false, strokeWidth: 1, width: 80, height: 30 },
    ],
  },
  assets: {},
  ...over,
});
const BOX = { x: 100, y: 50, width: 600, height: 700 };

describe('placement', () => {
  it('puts the frame in a chest print: 62% of the width or 52% of the height (the smaller), centred across, 44% of the way down', () => {
    expect(placement(BOX, 600)).toEqual({ cx: 400, cy: 50 + 700 * 0.44, scale: Math.min(600 * 0.62, 700 * 0.52) / 600 });
    const wide = placement({ x: 0, y: 0, width: 800, height: 300 }, 600); // a short box: the height decides
    expect(wide.scale).toBeCloseTo((300 * 0.52) / 600, 10);
  });

  it('uses a typical T-shirt box when the garment has none (the mock shop, a garment that cannot be printed) or the box is empty', () => {
    expect(placement(null, 600)).toEqual(placement(DEFAULT_BOX, 600));
    expect(placement({ x: 1, y: 1, width: 0, height: 10 }, 600)).toEqual(placement(DEFAULT_BOX, 600));
  });
});

describe('fitState', () => {
  it('moves every layer from the frame into the box and scales it, without touching the template', () => {
    const t = file();
    const frozen = JSON.stringify(t.state);
    const { cx, cy, scale } = placement(BOX, 600);
    const fitted = fitState(t.state, 600, BOX);
    expect(JSON.stringify(t.state)).toBe(frozen); // the shared template is not changed
    const [circle, text] = fitted.objects as Record<string, number>[];
    expect(circle.left).toBeCloseTo(cx, 10); // the frame's centre goes to the box's chest point
    expect(circle.top).toBeCloseTo(cy, 10);
    expect(text.left).toBeCloseTo(cx + (300 - 400) * scale, 10);
    expect(text.top).toBeCloseTo(cy + (250 - 400) * scale, 10);
    expect(circle.scaleX).toBeCloseTo(scale, 10);
    expect(text.scaleY).toBeCloseTo(2 * scale, 10);
  });

  it('scales an outline that does not scale by itself (strokeUniform) and leaves the others alone', () => {
    const { scale } = placement(BOX, 600);
    const [circle, text] = fitState(file().state, 600, BOX).objects as Record<string, number>[];
    expect(circle.strokeWidth).toBeCloseTo(8 * scale, 10);
    expect(text.strokeWidth).toBe(1);
  });

  it('keeps everything else of the scene (counter, version, every other property)', () => {
    const fitted = fitState(file().state, 600, BOX);
    expect(fitted.counter).toBe(2);
    expect(fitted.fabric).toBe('7.4.0');
    expect(fitted.objects[0]).toMatchObject({ type: 'Circle', layerId: 'layer-1', width: 100, height: 100 });
  });

  it('is deterministic: the same box gives the same scene every time', () => {
    expect(fitState(file().state, 600, BOX)).toEqual(fitState(file().state, 600, BOX));
  });
});

const respond = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body, blob: async () => new Blob(['x'], { type: 'image/png' }) });

describe('fetchTemplate and buildSnapshot', () => {
  it('reads a template, rejects a missing or damaged one with a plain sentence', async () => {
    expect((await fetchTemplate('/t.json', async () => respond(file()))).frame).toBe(600);
    await expect(fetchTemplate('/t.json', async () => respond({}, false, 404))).rejects.toThrow(TemplateError);
    await expect(fetchTemplate('/t.json', async () => respond({ engine: 'pro' }))).rejects.toThrow('damaged');
    await expect(fetchTemplate('/t.json', async () => respond({ ...file(), schemaVersion: 9 }))).rejects.toThrow('damaged');
  });

  it('builds a fresh snapshot: the fitted scene and every picture fetched as a Blob of its own type', async () => {
    const withPicture = file({ assets: { 'asset-1': { file: '/designs/assets/x.png', type: 'image/png' } } });
    const fetcher = vi.fn(async (_url: string, _init?: unknown) => respond(null));
    const snapshot = await buildSnapshot(withPicture, BOX, fetcher as never);
    expect(snapshot.engine).toBe('simple');
    expect(snapshot.schemaVersion).toBe(1);
    expect(Object.keys(snapshot.assets)).toEqual(['asset-1']);
    expect(snapshot.assets['asset-1']).toBeInstanceOf(Blob);
    expect(snapshot.assets['asset-1'].type).toBe('image/png');
    expect(fetcher).toHaveBeenCalledWith('/designs/assets/x.png', expect.anything());
    // a second call is a different object: nothing is shared between two customers' copies
    const again = await buildSnapshot(withPicture, BOX, fetcher as never);
    expect(again).not.toBe(snapshot);
    expect(again.state).not.toBe(snapshot.state);
  });

  it('says so when a picture of the design cannot be loaded', async () => {
    const withPicture = file({ assets: { 'asset-1': { file: '/designs/assets/x.png', type: 'image/png' } } });
    await expect(buildSnapshot(withPicture, BOX, (async () => respond(null, false, 404)) as never)).rejects.toThrow('picture');
  });
});
