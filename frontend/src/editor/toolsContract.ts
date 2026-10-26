// The SIMPLE TOOLS contract: what the Simple editor adds on top of the core (text, shapes, pictures, properties, order,
// selection). Run against FakeEditor in jsdom and against the Fabric adapter in a real browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gifBlob, jpegHeader, pngHeader, realJpeg, realPng, realWebp, svgBlob, webpHeader } from '../test/images';
import { CONTRACT_GARMENT, type ContractTarget } from './contract';
import { EditorBusyError, LAYER_LIMITS, LayerLockedError, SHAPE_KINDS, type DesignLayer, type SimpleEditorTools } from './types';
import { MAX_UPLOAD_BYTES, UploadError } from './upload';

export type ToolsTarget = Omit<ContractTarget<SimpleEditorTools>, 'populate'>;

/** three layers of three types: text, a shape and a picture */
export async function populateSimple(e: SimpleEditorTools): Promise<void> {
  e.addText('Hello');
  e.addShape('star');
  await e.addImage(realPng(), 'Dot');
}

const ids = (layers: DesignLayer[]) => layers.map((l) => l.id);

export function describeSimpleToolsContract(name: string, make: () => Promise<ToolsTarget>): void {
  describe(`SimpleEditorTools contract: ${name}`, () => {
    let target: ToolsTarget;
    let e: SimpleEditorTools;
    beforeEach(async () => {
      target = await make();
      e = target.editor;
      await e.loadBase(CONTRACT_GARMENT);
    });
    afterEach(() => {
      e.dispose();
      target.cleanup?.();
    });

    it('adds text as a text layer that shows in exportLayers, and selects it', () => {
      const listener = vi.fn();
      e.onSelectionChange(listener);
      const id = e.addText('Hello world');
      expect(e.getLayers()).toEqual([expect.objectContaining({ id, type: 'text', name: 'Hello world', visible: true })]);
      expect(ids(e.exportLayers())).toEqual([id]);
      expect(e.getSelection()).toBe(id);
      expect(listener).toHaveBeenCalled();
    });

    it.each(SHAPE_KINDS)('adds a %s as a shape layer with a usable size', (kind) => {
      const id = e.addShape(kind);
      const layer = e.getLayers()[0]!;
      expect(layer).toMatchObject({ id, type: 'shape' });
      expect(layer.width).toBeGreaterThan(0);
      expect(layer.height).toBeGreaterThan(0);
      expect(e.getStyle(id)).toMatchObject({ type: 'shape', shape: kind });
      expect(ids(e.exportLayers())).toEqual([id]);
    });

    it.each([
      ['PNG', realPng],
      ['JPEG', realJpeg],
      ['WebP', realWebp],
    ])('adds a %s picture as an image layer', async (_label, make) => {
      const id = await e.addImage(make(), 'My picture');
      expect(e.getLayers()).toEqual([expect.objectContaining({ id, type: 'image', name: 'My picture' })]);
      expect(ids(e.exportLayers())).toEqual([id]);
      expect(e.getStyle(id)).toEqual({ type: 'image', opacity: 1 });
    });

    it('keeps layer order bottom to top, and moveLayer moves one step', () => {
      const a = e.addText('Alpha');
      const b = e.addShape('rectangle');
      const c = e.addShape('circle');
      expect(ids(e.getLayers())).toEqual([a, b, c]);
      e.moveLayer(c, 'down');
      expect(ids(e.getLayers())).toEqual([a, c, b]);
      e.moveLayer(a, 'down'); // already at the bottom: no change
      expect(ids(e.getLayers())).toEqual([a, c, b]);
      e.moveLayer(a, 'up');
      expect(ids(e.getLayers())).toEqual([c, a, b]);
      e.moveLayer(b, 'up'); // already at the top: no change
      expect(ids(e.getLayers())).toEqual([c, a, b]);
    });

    it('updateLayer applies position (the centre), size, rotation, name and lock', () => {
      const id = e.addShape('rectangle');
      e.updateLayer(id, { x: 300, y: 320, width: 100, height: 50, rotation: 45, name: 'Badge', locked: true });
      expect(e.getLayers()[0]).toMatchObject({ x: 300, y: 320, width: 100, height: 50, rotation: 45, name: 'Badge', locked: true });
    });

    it('a hidden layer stays in getLayers but leaves exportLayers', () => {
      const a = e.addShape('rectangle');
      const b = e.addShape('triangle');
      e.updateLayer(b, { visible: false });
      expect(e.getLayers().find((l) => l.id === b)?.visible).toBe(false);
      expect(ids(e.exportLayers())).toEqual([a]);
      e.updateLayer(b, { visible: true });
      expect(ids(e.exportLayers())).toEqual([a, b]);
    });

    it('removeLayer removes only that layer and clears the selection', () => {
      const a = e.addShape('rectangle');
      const b = e.addShape('circle');
      e.select(b);
      e.removeLayer(b);
      expect(ids(e.getLayers())).toEqual([a]);
      expect(e.getSelection()).not.toBe(b);
    });

    it('select and clear the selection', () => {
      const a = e.addShape('rectangle');
      e.addShape('circle');
      e.select(a);
      expect(e.getSelection()).toBe(a);
      e.select(null);
      expect(e.getSelection()).toBeNull();
    });

    it('text properties: the text, font, size, colour, alignment and opacity', async () => {
      const id = e.addText('Before');
      await e.updateStyle(id, { text: 'After the change', fontFamily: 'Bebas Neue', fontSize: 90, fill: '#a8353a', textAlign: 'right', opacity: 0.5 });
      expect(e.getStyle(id)).toEqual({ type: 'text', text: 'After the change', fontFamily: 'Bebas Neue', fontSize: 90, fill: '#a8353a', textAlign: 'right', opacity: 0.5 });
      expect(e.getLayers()[0]!.name).toBe('After the change');
    });

    it('shape properties: fill, outline and opacity', async () => {
      const id = e.addShape('star');
      await e.updateStyle(id, { fill: '#243049', stroke: '#fffdf8', strokeWidth: 6, opacity: 0.75 });
      expect(e.getStyle(id)).toMatchObject({ type: 'shape', shape: 'star', fill: '#243049', stroke: '#fffdf8', strokeWidth: 6, opacity: 0.75 });
    });

    it("a line's colour is its stroke, and it always keeps a visible thickness", async () => {
      const id = e.addShape('line');
      await e.updateStyle(id, { fill: '#a8353a' });
      expect(e.getStyle(id)).toMatchObject({ shape: 'line', fill: '#a8353a', stroke: '#a8353a' });
      expect(e.getLayers()[0]!.height).toBeGreaterThan(0);
    });

    it('opacity is kept between 0 and 1, and a picture only has opacity', async () => {
      const id = await e.addImage(realPng());
      await e.updateStyle(id, { opacity: 3, fill: '#000000', text: 'no' });
      expect(e.getStyle(id)).toEqual({ type: 'image', opacity: 1 });
      await e.updateStyle(id, { opacity: -1 });
      expect(e.getStyle(id)).toEqual({ type: 'image', opacity: 0 });
    });

    it('styles survive a save and load', async () => {
      const t = e.addText('Keep me');
      await e.updateStyle(t, { fill: '#a8353a', fontSize: 80, textAlign: 'left' });
      const s = e.addShape('triangle');
      await e.updateStyle(s, { stroke: '#243049', strokeWidth: 4, opacity: 0.6 });
      const snapshot = await e.exportState();
      const second = await make();
      try {
        await second.editor.loadBase(CONTRACT_GARMENT);
        await second.editor.loadState(snapshot);
        expect(second.editor.getStyle(t)).toEqual(e.getStyle(t));
        expect(second.editor.getStyle(s)).toEqual(e.getStyle(s));
        expect(second.editor.getLayers()).toEqual(e.getLayers());
      } finally {
        second.editor.dispose();
        second.cleanup?.();
      }
    });

    it('a design with text, a shape and a picture round trips with the picture as a Blob', async () => {
      await populateSimple(e);
      const before = e.getLayers();
      const snapshot = await e.exportState();
      expect(Object.keys(snapshot.assets)).toHaveLength(1);
      expect(Object.values(snapshot.assets)[0]).toBeInstanceOf(Blob);
      expect(JSON.stringify(snapshot.state)).not.toMatch(/data:|base64|blob:/);
      const second = await make();
      try {
        await second.editor.loadBase(CONTRACT_GARMENT);
        await second.editor.loadState(snapshot);
        expect(second.editor.getLayers()).toEqual(before);
        expect(before.map((l) => l.id)).not.toContain(second.editor.addShape('rectangle')); // ids keep counting
      } finally {
        second.editor.dispose();
        second.cleanup?.();
      }
    });

    describe('upload validation: each rejection says why and leaves the design unchanged', () => {
      async function rejects(file: Blob, problem: string, message: RegExp) {
        e.addShape('rectangle');
        const before = e.getLayers();
        const stateBefore = JSON.stringify((await e.exportState()).state);
        const error = await e.addImage(file).then(
          () => null,
          (x: unknown) => x,
        );
        expect(error).toBeInstanceOf(UploadError);
        expect((error as UploadError).problem).toBe(problem);
        expect((error as UploadError).message).toMatch(message);
        expect(e.getLayers()).toEqual(before);
        expect(JSON.stringify((await e.exportState()).state)).toBe(stateBefore);
      }

      it('a renamed SVG (it says it is a PNG) is refused', () => rejects(svgBlob('image/png'), 'svg', /SVG/));
      it('an SVG with its real type is refused', () => rejects(svgBlob(), 'svg', /SVG/));
      it('a GIF is refused', () => rejects(gifBlob(), 'gif', /GIF/));
      it('a file with the wrong signature (text called .png) is refused', () =>
        rejects(new Blob(['this is not a picture at all'], { type: 'image/png' }), 'not-an-image', /not a picture/));
      it('an empty file is refused', () => rejects(new Blob([], { type: 'image/png' }), 'not-an-image', /empty/));
      it('a PNG with its header cut off is refused as damaged', () => rejects(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'damaged', /damaged/));
      it('a file over the size limit is refused', () =>
        rejects(new Blob([pngHeader(100, 100), new Uint8Array(MAX_UPLOAD_BYTES)], { type: 'image/png' }), 'too-big', /10 MB/));
      it('a PNG over 40 megapixels is refused from its header alone', () => rejects(pngHeader(8000, 5001), 'too-many-pixels', /megapixels/));
      it('a JPEG over 40 megapixels is refused from its header alone', () => rejects(jpegHeader(6001, 6667), 'too-many-pixels', /megapixels/));
      it('a WebP over 40 megapixels is refused from its header alone', () => rejects(webpHeader(10000, 4001), 'too-many-pixels', /megapixels/));
    });

    // ------------------------------------------------------------------------------------------------ history
    describe('history (undo and redo)', () => {
      /** the scene as exportState gives it, minus every id (layer ids, picture ids, the id counter) */
      async function scene(): Promise<unknown> {
        const strip = (v: unknown): unknown => {
          if (Array.isArray(v)) return v.map(strip);
          if (v && typeof v === 'object') {
            return Object.fromEntries(
              Object.entries(v)
                .filter(([k]) => !['id', 'layerId', 'assetId', 'counter', 'src'].includes(k))
                .map(([k, x]) => [k, strip(x)]),
            );
          }
          return v;
        };
        return strip((await e.exportState()).state);
      }
      const steps = () => e.historyStats().undoSteps;
      /** the scene plus the garment's colour and size: everything a step records */
      const everything = async () => ({ scene: await scene(), garment: e.getGarment() });

      /** a design with something of every kind, so every action has something to act on */
      async function base() {
        const text = e.addText('Base text');
        const shape = e.addShape('rectangle');
        const star = e.addShape('star');
        const picture = await e.addImage(realPng(), 'Base picture');
        e.select(null);
        return { text, shape, star, picture };
      }

      it('starts with nothing to undo or redo', () => {
        expect(e.canUndo()).toBe(false);
        expect(e.canRedo()).toBe(false);
        expect(steps()).toBe(0);
      });

      const actions: Array<[string, (ids: Awaited<ReturnType<typeof base>>) => unknown | Promise<unknown>]> = [
        ['add text', () => e.addText('More')],
        ['add a shape', () => e.addShape('triangle')],
        ['add a picture', () => e.addImage(realJpeg(), 'Another')],
        ['move', (i) => e.updateLayer(i.shape, { x: 123, y: 456 })],
        ['resize', (i) => e.updateLayer(i.shape, { width: 77, height: 33 })],
        ['rotate', (i) => e.updateLayer(i.shape, { rotation: 40 })],
        ['rename', (i) => e.updateLayer(i.shape, { name: 'Renamed' })],
        ['hide', (i) => e.updateLayer(i.shape, { visible: false })],
        ['lock', (i) => e.updateLayer(i.shape, { locked: true })],
        ['delete', (i) => e.removeLayer(i.star)],
        ['delete a picture', (i) => e.removeLayer(i.picture)],
        ['move one step up', (i) => e.moveLayer(i.shape, 'up')],
        ['move one step down', (i) => e.moveLayer(i.shape, 'down')],
        ['text content', (i) => e.updateStyle(i.text, { text: 'Changed' })],
        ['text font', (i) => e.updateStyle(i.text, { fontFamily: 'Bebas Neue' })],
        ['text size', (i) => e.updateStyle(i.text, { fontSize: 99 })],
        ['text colour', (i) => e.updateStyle(i.text, { fill: '#a8353a' })],
        ['text alignment', (i) => e.updateStyle(i.text, { textAlign: 'right' })],
        ['shape fill', (i) => e.updateStyle(i.shape, { fill: '#243049' })],
        ['shape outline', (i) => e.updateStyle(i.shape, { stroke: '#fffdf8', strokeWidth: 8 })],
        ['opacity', (i) => e.updateStyle(i.shape, { opacity: 0.4 })],
        ['garment colour', () => e.setColor('navy')],
        ['garment size', () => e.setSize('XL')],
      ];
      it.each(actions)('%s is exactly one undo step, and undo and redo restore the exact scene', async (_name, act) => {
        const ids = await base();
        const before = await everything();
        const stepsBefore = steps();

        await act(ids);
        expect(steps()).toBe(stepsBefore + 1);
        expect(e.canUndo()).toBe(true);
        const after = await everything();
        expect(after).not.toEqual(before); // the action really changed something (the scene or the garment)

        await e.undo();
        expect(await everything()).toEqual(before);
        expect(steps()).toBe(stepsBefore);
        expect(e.canRedo()).toBe(true);

        await e.redo();
        expect(await everything()).toEqual(after);
        expect(steps()).toBe(stepsBefore + 1);
        expect(e.canRedo()).toBe(false);
      });

      it('undo and redo fire onChange', async () => {
        e.addShape('circle');
        const listener = vi.fn();
        e.onChange(listener);
        await e.undo();
        expect(listener).toHaveBeenCalled();
        listener.mockClear();
        await e.redo();
        expect(listener).toHaveBeenCalled();
      });

      it('a whole session of undo then redo walks the exact scenes in order', async () => {
        const ids = await base();
        const scenes: unknown[] = [await scene()];
        e.updateLayer(ids.shape, { x: 100 });
        scenes.push(await scene());
        await e.updateStyle(ids.text, { text: 'Two' });
        scenes.push(await scene());
        e.removeLayer(ids.star);
        scenes.push(await scene());
        e.moveLayer(ids.picture, 'down');
        scenes.push(await scene());
        for (let i = scenes.length - 2; i >= 0; i--) {
          await e.undo();
          expect(await scene()).toEqual(scenes[i]);
        }
        for (let i = 1; i < scenes.length; i++) {
          await e.redo();
          expect(await scene()).toEqual(scenes[i]);
        }
      });

      it('live edits are one step once committed: a slider drag is one step', async () => {
        const { shape } = await base();
        const n = steps();
        for (let o = 90; o >= 20; o -= 10) await e.updateStyle(shape, { opacity: o / 100 }, { live: true });
        expect(steps()).toBe(n); // nothing recorded while the drag goes on
        expect(e.getStyle(shape)).toMatchObject({ opacity: 0.2 });
        e.commitEdit();
        expect(steps()).toBe(n + 1);
        e.commitEdit(); // nothing changed since: no step
        expect(steps()).toBe(n + 1);
        await e.undo();
        expect(e.getStyle(shape)).toMatchObject({ opacity: 1 });
      });

      it('text typed in the panel is one step per editing session, not one per character', async () => {
        const { text } = await base();
        const n = steps();
        let typed = '';
        for (const ch of 'Hello there') {
          typed += ch;
          await e.updateStyle(text, { text: typed }, { live: true });
        }
        e.commitEdit();
        expect(steps()).toBe(n + 1);
        expect(e.getStyle(text)).toMatchObject({ text: 'Hello there' });
        await e.undo();
        expect(e.getStyle(text)).toMatchObject({ text: 'Base text' });
      });

      it('a burst of nudges is one step', async () => {
        const { shape } = await base();
        const n = steps();
        const start = e.getLayers().find((l) => l.id === shape)!;
        for (let i = 1; i <= 8; i++) e.updateLayer(shape, { x: start.x + i, y: start.y }, { live: true });
        e.commitEdit();
        expect(steps()).toBe(n + 1);
        await e.undo();
        expect(e.getLayers().find((l) => l.id === shape)).toMatchObject({ x: start.x, y: start.y });
      });

      it('undo with edits still in flight records them first, so undo reverts them', async () => {
        const { shape } = await base();
        const original = e.getLayers().find((l) => l.id === shape)!;
        e.updateLayer(shape, { x: original.x + 50 }, { live: true });
        expect(e.canUndo()).toBe(true);
        await e.undo();
        expect(e.getLayers().find((l) => l.id === shape)!.x).toBe(original.x);
        expect(e.canRedo()).toBe(true);
      });

      it('a new action after an undo discards the redo branch', async () => {
        const { shape } = await base();
        e.updateLayer(shape, { x: 10 });
        e.updateLayer(shape, { x: 20 });
        await e.undo();
        expect(e.canRedo()).toBe(true);
        e.updateLayer(shape, { x: 30 });
        expect(e.canRedo()).toBe(false);
        expect(e.historyStats().redoSteps).toBe(0);
        await e.redo(); // nothing to redo: no change
        expect(e.getLayers().find((l) => l.id === shape)!.x).toBe(30);
      });

      it('keeps at most 100 steps: the 101st action makes the oldest one unreachable', async () => {
        const id = e.addShape('rectangle');
        const first = (await scene()) as unknown;
        const sceneAt = new Map<number, unknown>();
        for (let i = 1; i <= 130; i++) {
          e.updateLayer(id, { x: 100 + i });
          if (i === 30) sceneAt.set(30, await scene());
        }
        expect(e.historyStats().undoSteps).toBe(100);
        let undone = 0;
        while (e.canUndo()) {
          await e.undo();
          undone++;
        }
        expect(undone).toBe(100);
        // the oldest reachable scene is the one after action 30: the steps before it fell off
        expect(await scene()).toEqual(sceneAt.get(30));
        expect(await scene()).not.toEqual(first);
      });

      it('undoing a picture delete restores the very same Blob (history holds ids, not bytes)', async () => {
        const original = realPng();
        const id = await e.addImage(original, 'Keep');
        const blobBefore = Object.values((await e.exportState()).assets)[0]!;
        e.removeLayer(id);
        expect(Object.keys((await e.exportState()).assets)).toHaveLength(0);
        expect(e.historyStats().retainedAssets).toBe(1); // still held for the undo
        await e.undo();
        const blobAfter = Object.values((await e.exportState()).assets)[0]!;
        expect(blobAfter).toBe(blobBefore);
        expect(e.getLayers()).toEqual([expect.objectContaining({ type: 'image', name: 'Keep' })]);
        // many steps and undos later it is still the one blob, never a copy
        for (let i = 0; i < 20; i++) e.addShape('circle');
        for (let i = 0; i < 10; i++) await e.undo();
        expect(e.historyStats().retainedAssets).toBe(1);
        expect(Object.values((await e.exportState()).assets)[0]).toBe(blobBefore);
      });

      it('a picture is released once every step that used it has fallen off the history', async () => {
        const id = await e.addImage(realPng(), 'Brief');
        e.removeLayer(id);
        expect(e.historyStats().retainedAssets).toBe(1);
        const shape = e.addShape('rectangle');
        for (let i = 0; i < 98; i++) e.updateLayer(shape, { x: 100 + i }); // still within reach of the picture's steps
        expect(e.historyStats().retainedAssets).toBe(1);
        for (let i = 0; i < 10; i++) e.updateLayer(shape, { y: 100 + i }); // now they have fallen off
        expect(e.historyStats().undoSteps).toBe(100);
        expect(e.historyStats().retainedAssets).toBe(0);
      });

      it('a picture only an abandoned redo branch used is released', async () => {
        e.addShape('rectangle');
        await e.undo();
        await e.addImage(realPng());
        await e.undo(); // the picture add is now a redo step
        expect(e.historyStats().retainedAssets).toBe(1);
        e.addShape('circle'); // a new action: the redo branch (with the picture) is gone
        expect(e.historyStats().retainedAssets).toBe(0);
      });

      it('loadState clears the history', async () => {
        await base();
        const snapshot = await e.exportState();
        e.addShape('circle');
        await e.undo();
        expect(e.canUndo()).toBe(true);
        expect(e.canRedo()).toBe(true);
        await e.loadState(snapshot);
        expect(e.canUndo()).toBe(false);
        expect(e.canRedo()).toBe(false);
        expect(e.historyStats()).toMatchObject({ undoSteps: 0, redoSteps: 0 });
        const before = e.getLayers();
        await e.undo();
        await e.redo();
        expect(e.getLayers()).toEqual(before);
      });

      it('a rejected loadState leaves the history as it was', async () => {
        await base();
        e.addShape('circle');
        const n = steps();
        await expect(e.loadState({ schemaVersion: 99, engine: 'simple', state: {}, assets: {} })).rejects.toThrow();
        expect(steps()).toBe(n);
      });

      it('garment colour and size are steps: undo brings the old colour and size back', async () => {
        expect(e.getGarment()).toEqual({ color: 'white', size: 'M' });
        e.setColor('navy');
        e.setSize('XL');
        expect(e.getGarment()).toEqual({ color: 'navy', size: 'XL' });
        await e.undo();
        expect(e.getGarment()).toEqual({ color: 'navy', size: 'M' });
        await e.undo();
        expect(e.getGarment()).toEqual({ color: 'white', size: 'M' });
        await e.redo();
        await e.redo();
        expect(e.getGarment()).toEqual({ color: 'navy', size: 'XL' });
      });

      it('setting the colour or size it already has is not a step', () => {
        e.setColor('white');
        e.setSize('M');
        expect(steps()).toBe(0);
      });

      it('undo restores the selection the step had, when that layer still exists', async () => {
        const a = e.addShape('rectangle');
        const b = e.addShape('circle');
        e.select(a);
        e.updateLayer(a, { x: 10 });
        e.select(b);
        e.updateLayer(b, { x: 10 });
        await e.undo();
        expect(e.getSelection()).toBe(a);
      });
    });

    // ------------------------------------------------------------------------------------------------ locks, hiding, selection
    describe('lock, hide and select', () => {
      it('a locked layer cannot be moved, resized, restyled, renamed or deleted, with a clear message', async () => {
        const id = e.addShape('rectangle');
        e.updateLayer(id, { locked: true });
        const before = e.getLayers();
        const steps = e.historyStats().undoSteps;
        expect(() => e.removeLayer(id)).toThrow(LayerLockedError);
        expect(() => e.removeLayer(id)).toThrow(/is locked\. Unlock it/);
        expect(() => e.updateLayer(id, { x: 5 })).toThrow(LayerLockedError);
        expect(() => e.updateLayer(id, { name: 'Nope' })).toThrow(LayerLockedError);
        expect(() => e.updateLayer(id, { width: 10 })).toThrow(LayerLockedError);
        await expect(e.updateStyle(id, { fill: '#000000' })).rejects.toBeInstanceOf(LayerLockedError);
        expect(e.getLayers()).toEqual(before);
        expect(e.historyStats().undoSteps).toBe(steps);
      });

      it('a locked layer can be unlocked, shown, hidden and reordered, and edited again after unlocking', () => {
        const a = e.addShape('rectangle');
        const b = e.addShape('circle');
        e.updateLayer(a, { locked: true });
        expect(() => e.updateLayer(a, { visible: false })).not.toThrow();
        expect(() => e.updateLayer(a, { visible: true })).not.toThrow();
        expect(() => e.moveLayer(a, 'up')).not.toThrow();
        expect(e.getLayers().map((l) => l.id)).toEqual([b, a]);
        e.updateLayer(a, { locked: false });
        expect(() => e.updateLayer(a, { x: 5 })).not.toThrow();
        expect(() => e.removeLayer(a)).not.toThrow();
      });

      it('a patch that unlocks and moves in one go is allowed', () => {
        const id = e.addShape('rectangle');
        e.updateLayer(id, { locked: true });
        expect(() => e.updateLayer(id, { locked: false, x: 50 })).not.toThrow();
        expect(e.getLayers()[0]).toMatchObject({ locked: false, x: 50 });
      });

      it('a locked or hidden layer can still be selected from a list', () => {
        const a = e.addShape('rectangle');
        const b = e.addShape('circle');
        e.updateLayer(a, { locked: true });
        e.updateLayer(b, { visible: false });
        e.select(a);
        expect(e.getSelection()).toBe(a);
        e.select(b);
        expect(e.getSelection()).toBe(b);
      });

      it('hiding keeps the layer in getLayers (dimmed in a list) but out of exportLayers', () => {
        const a = e.addShape('rectangle');
        const b = e.addText('Hi');
        e.updateLayer(a, { visible: false });
        expect(e.getLayers().map((l) => [l.id, l.visible])).toEqual([[a, false], [b, true]]);
        expect(e.exportLayers().map((l) => l.id)).toEqual([b]);
      });
    });

    // ------------------------------------------------------------------------------------------------ numeric fields
    describe('numeric position, size and rotation', () => {
      it('sets the centre, the size and the rotation exactly, each call one step', () => {
        const id = e.addShape('rectangle');
        const n = e.historyStats().undoSteps;
        e.updateLayer(id, { x: 250, y: 300 });
        e.updateLayer(id, { width: 120, height: 80 });
        e.updateLayer(id, { rotation: 30 });
        expect(e.getLayers()[0]).toMatchObject({ x: 250, y: 300, width: 120, height: 80, rotation: 30 });
        expect(e.historyStats().undoSteps).toBe(n + 3);
      });

      it('clamps to the limits instead of going wild', () => {
        const id = e.addShape('rectangle');
        e.updateLayer(id, { x: 99999, y: -99999, width: 999999, height: 0 });
        const l = e.getLayers()[0]!;
        expect(l.x).toBe(LAYER_LIMITS.position.max);
        expect(l.y).toBe(LAYER_LIMITS.position.min);
        expect(l.width).toBe(LAYER_LIMITS.size.max);
        expect(l.height).toBe(LAYER_LIMITS.size.min);
      });

      it('rotation is kept as 0 to 360 whichever way it was given', () => {
        const id = e.addShape('rectangle');
        e.updateLayer(id, { rotation: -90 });
        expect(e.getLayers()[0]!.rotation).toBe(270);
        e.updateLayer(id, { rotation: 360 });
        expect(e.getLayers()[0]!.rotation).toBe(0);
      });

      it('changing the centre does not change the size, and rotating does not move the centre', () => {
        const id = e.addShape('rectangle');
        e.updateLayer(id, { x: 300, y: 310, width: 100, height: 40 });
        e.updateLayer(id, { rotation: 77 });
        expect(e.getLayers()[0]).toMatchObject({ x: 300, y: 310, width: 100, height: 40, rotation: 77 });
        e.updateLayer(id, { x: 400 });
        expect(e.getLayers()[0]).toMatchObject({ x: 400, y: 310, width: 100, height: 40 });
      });
    });

    // ------------------------------------------------------------------------------------------------ async safety
    describe('undo, redo and loads take turns (one queue)', () => {
      const scene = async () => {
        const strip = (v: unknown): unknown => {
          if (Array.isArray(v)) return v.map(strip);
          if (v && typeof v === 'object') {
            return Object.fromEntries(
              Object.entries(v)
                .filter(([k]) => !['id', 'layerId', 'assetId', 'counter', 'src'].includes(k))
                .map(([k, x]) => [k, strip(x)]),
            );
          }
          return v;
        };
        return strip((await e.exportState()).state);
      };
      /** twelve steps, each changing the picture: [scene after 0 steps, after 1, ... after 12] */
      async function twelveSteps() {
        const id = e.addShape('rectangle');
        const scenes: unknown[] = [await scene()];
        for (let i = 1; i <= 12; i++) {
          e.updateLayer(id, { x: 100 + i * 10 });
          scenes.push(await scene());
        }
        return { id, scenes };
      }

      it('ten undo presses in a row, none awaited, land exactly ten steps back', async () => {
        const { scenes } = await twelveSteps();
        const calls = Array.from({ length: 10 }, () => e.undo());
        expect(e.isBusy()).toBe(true);
        await Promise.all(calls);
        expect(e.isBusy()).toBe(false);
        expect(await scene()).toEqual(scenes[2]);
        expect(e.historyStats()).toMatchObject({ undoSteps: 3, redoSteps: 10 }); // the add + two moves are still undoable
        const redos = Array.from({ length: 10 }, () => e.redo());
        await Promise.all(redos);
        expect(await scene()).toEqual(scenes[12]);
        expect(e.historyStats()).toMatchObject({ undoSteps: 13, redoSteps: 0 });
      });

      it('a storm of undo and redo calls never corrupts the history', async () => {
        const { scenes } = await twelveSteps();
        // a fixed pattern of 60 calls, all fired at once; track where the cursor must end up
        let at = 13; // 1 add + 12 moves = 13 undo steps available; cursor counts steps from the start
        const calls: Promise<void>[] = [];
        for (let i = 0; i < 60; i++) {
          const undo = (i * 7 + 3) % 5 < 3;
          calls.push(undo ? e.undo() : e.redo());
          at = undo ? Math.max(0, at - 1) : Math.min(13, at + 1);
        }
        await Promise.all(calls);
        expect(e.isBusy()).toBe(false);
        expect(e.historyStats().undoSteps).toBe(at);
        expect(e.historyStats().undoSteps + e.historyStats().redoSteps).toBe(13);
        if (at >= 1) expect(await scene()).toEqual(scenes[at - 1]); // step 1 is the add: the moves are scenes[1..12]
      });

      it('an editing call made while an undo is in flight is refused, and nothing is half-applied', async () => {
        const { id, scenes } = await twelveSteps();
        const undoing = e.undo();
        expect(e.isBusy()).toBe(true);
        expect(() => e.addShape('circle')).toThrow(EditorBusyError);
        expect(() => e.addText('x')).toThrow(EditorBusyError);
        expect(() => e.updateLayer(id, { x: 5 })).toThrow(EditorBusyError);
        expect(() => e.moveLayer(id, 'up')).toThrow(EditorBusyError);
        expect(() => e.removeLayer(id)).toThrow(EditorBusyError);
        expect(() => e.setSize('XL')).toThrow(EditorBusyError);
        expect(() => e.setColor('navy')).toThrow(EditorBusyError);
        expect(() => e.select(null)).toThrow(EditorBusyError);
        await expect(e.updateStyle(id, { opacity: 0.3 })).rejects.toBeInstanceOf(EditorBusyError);
        await undoing;
        expect(await scene()).toEqual(scenes[11]); // exactly the one undo, nothing from the refused calls
        expect(e.historyStats()).toMatchObject({ undoSteps: 12, redoSteps: 1 });
        e.updateLayer(id, { x: 5 }); // idle again: works
        expect(e.historyStats().redoSteps).toBe(0);
      });

      it('whenIdle resolves after every queued undo, and then actions are allowed', async () => {
        await twelveSteps();
        void e.undo();
        void e.undo();
        await e.whenIdle();
        expect(e.isBusy()).toBe(false);
        expect(() => e.addShape('circle')).not.toThrow();
      });

      it('whenIdle is already resolved when nothing is working', async () => {
        await expect(e.whenIdle()).resolves.toBeUndefined();
        expect(e.isBusy()).toBe(false);
      });

      it('a picture added while an undo is in flight is placed AFTER it, as its own step', async () => {
        const { scenes } = await twelveSteps();
        const undoing = e.undo();
        const adding = e.addImage(realPng(), 'Late');
        await Promise.all([undoing, adding]);
        const layers = e.getLayers();
        expect(layers.map((l) => l.type)).toEqual(['shape', 'image']);
        expect(e.historyStats().redoSteps).toBe(0); // the picture is a new action after the undo
        await e.undo(); // undo the picture: back to the scene the first undo left
        expect(await scene()).toEqual(scenes[11]);
      });

      it('a load queued behind an undo applies after it and leaves a clean history', async () => {
        const { scenes } = await twelveSteps();
        const snapshot = await e.exportState();
        const undoing = e.undo();
        const loading = e.loadState(snapshot);
        await Promise.all([undoing, loading]);
        expect(await scene()).toEqual(scenes[12]);
        expect(e.historyStats()).toMatchObject({ undoSteps: 0, redoSteps: 0 });
      });

      it('a failed job does not block the ones behind it', async () => {
        await twelveSteps();
        const bad = e.loadState({ schemaVersion: 99, engine: 'simple', state: {}, assets: {} });
        const good = e.undo();
        await expect(bad).rejects.toThrow();
        await expect(good).resolves.toBeUndefined();
        expect(e.isBusy()).toBe(false);
        expect(e.historyStats().undoSteps).toBe(12);
      });
    });

    // ------------------------------------------------------------------------------------------------ zoom and pan
    describe('zoom and pan (view state)', () => {
      it('starts fitted: the whole design area in view', () => {
        const v = e.getView();
        expect(v.atFit).toBe(true);
        expect(v.zoom).toBeCloseTo(v.fitZoom, 6);
        expect(v.width).toBeGreaterThan(0);
      });

      it('limits are 50% (or the fit, if that is lower) and 400%', () => {
        const { fitZoom, minZoom, maxZoom } = e.getView();
        expect(minZoom).toBeCloseTo(Math.min(0.5, fitZoom), 6);
        expect(maxZoom).toBeCloseTo(Math.max(4, fitZoom), 6);
        e.zoomTo(1000);
        expect(e.getView().zoom).toBeCloseTo(maxZoom, 6);
        e.zoomTo(0.0001);
        expect(e.getView().zoom).toBeCloseTo(minZoom, 6);
        e.zoomTo(Number.NaN);
        expect(Number.isFinite(e.getView().zoom)).toBe(true);
      });

      it('zoomBy multiplies, zoomFit goes back to fitted and centred, zoomActual is 100%', () => {
        const { fitZoom } = e.getView();
        e.zoomBy(1.25);
        expect(e.getView().zoom).toBeCloseTo(Math.max(fitZoom * 1.25, e.getView().minZoom), 6);
        e.zoomActual();
        expect(e.getView().zoom).toBeCloseTo(Math.min(Math.max(1, e.getView().minZoom), e.getView().maxZoom), 6);
        e.zoomFit();
        const v = e.getView();
        expect(v.atFit).toBe(true);
        expect(v.zoom).toBeCloseTo(fitZoom, 6);
        expect(v.panX).toBeCloseTo((v.width - 800 * v.zoom) / 2, 6);
      });

      it('zooming about a point keeps the design point under it where it was', () => {
        const before = e.getView();
        const anchor = { x: before.width * 0.3, y: before.height * 0.7 };
        const at = { x: (anchor.x - before.panX) / before.zoom, y: (anchor.y - before.panY) / before.zoom };
        e.zoomTo(before.zoom * 2.4, anchor);
        const after = e.getView();
        expect(after.zoom).toBeGreaterThan(before.zoom);
        expect((anchor.x - after.panX) / after.zoom).toBeCloseTo(at.x, 4);
        expect((anchor.y - after.panY) / after.zoom).toBeCloseTo(at.y, 4);
      });

      it('at the fit there is nothing to pan; zoomed in, panning moves the design and never past its edges', () => {
        const fit = e.getView();
        e.panBy(80, 80);
        expect(e.getView()).toMatchObject({ panX: fit.panX, panY: fit.panY });
        e.zoomTo(fit.fitZoom * 3);
        const z = e.getView();
        e.panBy(-40, -25);
        const moved = e.getView();
        expect(moved.panX).toBeCloseTo(z.panX - 40, 6);
        expect(moved.panY).toBeCloseTo(z.panY - 25, 6);
        e.panBy(99999, 99999);
        expect(e.getView()).toMatchObject({ panX: 0, panY: 0 }); // the design's top-left cannot be pulled inside the view
        e.panBy(-99999, -99999);
        const far = e.getView();
        expect(far.panX).toBeCloseTo(far.width - 800 * far.zoom, 6);
        expect(far.panY).toBeCloseTo(far.height - 800 * far.zoom, 6);
      });

      it('zoom and pan are NOT design changes: no history step, no onChange, same snapshot, same layers', async () => {
        const id = e.addShape('rectangle');
        e.updateLayer(id, { x: 250 });
        const stats = e.historyStats();
        const layers = e.getLayers();
        const state = JSON.stringify((await e.exportState()).state);
        const changed = vi.fn();
        const viewChanged = vi.fn();
        e.onChange(changed);
        e.onViewChange(viewChanged);
        e.zoomTo(2);
        e.panBy(-30, -30);
        e.zoomBy(0.8);
        e.zoomFit();
        e.zoomActual();
        e.setPanMode(true);
        expect(changed).not.toHaveBeenCalled();
        expect(viewChanged).toHaveBeenCalled();
        expect(e.historyStats()).toEqual(stats);
        expect(e.getLayers()).toEqual(layers);
        expect(JSON.stringify((await e.exportState()).state)).toBe(state);
        await e.undo(); // undo undoes the DESIGN edit, not the zoom
        expect(e.getLayers()[0]!.x).not.toBe(250);
      });

      it('the hand tool is a switch', () => {
        expect(e.getPanMode()).toBe(false);
        e.setPanMode(true);
        expect(e.getPanMode()).toBe(true);
        e.setPanMode(false);
        expect(e.getPanMode()).toBe(false);
      });

      it('view listeners stop after unsubscribe', () => {
        const l = vi.fn();
        const off = e.onViewChange(l);
        e.zoomTo(2);
        expect(l).toHaveBeenCalledTimes(1);
        off();
        e.zoomTo(1);
        expect(l).toHaveBeenCalledTimes(1);
      });
    });
  });
}
