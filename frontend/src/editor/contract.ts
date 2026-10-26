// The CORE contract: one suite that EVERY engine must pass (DesignEditor only: the garment, export, save and load).
// Not a test file itself; each engine's test file calls describeEditorContract() with a factory.
// FakeEditor runs it in jsdom, the Fabric adapter in a real browser. A future Photopea engine runs it too: since the
// core interface cannot add layers, each target says how to put some content in with `populate`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineMismatchError, SnapshotError, type DesignEditor, type GarmentBase } from './types';

export interface ContractTarget<E extends DesignEditor = DesignEditor> {
  editor: E;
  /** engine-specific: put exactly three layers on the design, and resolve once they are there */
  populate: (editor: E) => Promise<void>;
  cleanup?: () => void;
}

export const CONTRACT_GARMENT: GarmentBase = {
  image: '/garments/m-tee/white.webp',
  color: 'white',
  size: 'M',
  colorImages: { white: '/garments/m-tee/white.webp', navy: '/garments/m-tee/navy.webp', black: '/garments/m-tee/black.webp' },
};

const ids = (editor: DesignEditor) => editor.exportLayers().map((l) => l.id);

export function describeEditorContract<E extends DesignEditor>(name: string, make: () => Promise<ContractTarget<E>>): void {
  describe(`DesignEditor contract: ${name}`, () => {
    let target: ContractTarget<E>;
    let editor: E;
    const extra: ContractTarget<E>[] = [];
    beforeEach(async () => {
      target = await make();
      editor = target.editor;
      await editor.loadBase(CONTRACT_GARMENT);
    });
    afterEach(() => {
      for (const t of [target, ...extra.splice(0)]) {
        t.editor.dispose();
        t.cleanup?.();
      }
    });

    it('loadBase shows the garment without making it a layer', () => {
      expect(editor.exportLayers()).toEqual([]);
    });

    it('exportLayers lists the visible leaf layers, and never the garment', async () => {
      await target.populate(editor);
      const layers = editor.exportLayers();
      expect(layers).toHaveLength(3);
      for (const l of layers) {
        expect(Object.keys(l).sort()).toEqual(['height', 'id', 'locked', 'name', 'rotation', 'type', 'visible', 'width', 'x', 'y']);
        expect(l.visible).toBe(true);
        expect(l.width).toBeGreaterThan(0);
        expect(l.height).toBeGreaterThan(0);
        expect(['text', 'image', 'shape']).toContain(l.type);
      }
      expect(new Set(ids(editor)).size).toBe(3);
    });

    it('setColor swaps to the colour picture and rejects a colour the garment does not come in', () => {
      const listener = vi.fn();
      editor.onChange(listener);
      editor.setColor('navy');
      editor.setColor('black');
      expect(listener).toHaveBeenCalledTimes(2);
      expect(() => editor.setColor('purple')).toThrow(/no picture/i);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('setSize fires onChange', () => {
      const listener = vi.fn();
      editor.onChange(listener);
      editor.setSize('XL');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('onChange fires when the design changes, and stops after unsubscribe', async () => {
      const listener = vi.fn();
      const off = editor.onChange(listener);
      await target.populate(editor);
      expect(listener).toHaveBeenCalled();
      off();
      listener.mockClear();
      editor.setSize('L');
      expect(listener).not.toHaveBeenCalled();
    });

    it('colour and size do not touch the design', async () => {
      await target.populate(editor);
      const before = editor.exportLayers();
      editor.setColor('navy');
      editor.setSize('XL');
      expect(editor.exportLayers()).toEqual(before);
    });

    it('state round trip: the same layers come back; pictures are Blobs in assets; no base64 in state', async () => {
      await target.populate(editor);
      const before = editor.exportLayers();
      const snapshot = await editor.exportState();

      expect(snapshot.engine).toBe(editor.engine);
      expect(Object.keys(snapshot).sort()).toEqual(['assets', 'engine', 'schemaVersion', 'state']);
      for (const blob of Object.values(snapshot.assets)) expect(blob).toBeInstanceOf(Blob);
      expect(JSON.stringify(snapshot.state)).not.toMatch(/data:|base64|blob:/);

      const second = await make();
      extra.push(second);
      await second.editor.loadBase(CONTRACT_GARMENT);
      await second.editor.loadState(snapshot);
      expect(second.editor.exportLayers()).toEqual(before);
    });

    it('exportPng gives a PNG blob, with or without the garment', async () => {
      await target.populate(editor);
      for (const withGarment of [false, true]) {
        const png = await editor.exportPng({ withGarment });
        expect(png.type).toBe('image/png');
        expect(png.size).toBeGreaterThan(0);
      }
    });

    it('dispose is safe to call twice', () => {
      expect(() => {
        editor.dispose();
        editor.dispose();
      }).not.toThrow();
    });

    it('loadState rejects the other engine and leaves the design untouched', async () => {
      await target.populate(editor);
      const snapshot = await editor.exportState();
      const before = editor.exportLayers();
      const other = editor.engine === 'simple' ? 'pro' : 'simple';
      await expect(editor.loadState({ ...snapshot, engine: other })).rejects.toBeInstanceOf(EngineMismatchError);
      await expect(editor.loadState({ ...snapshot, engine: other })).rejects.toThrow(/cannot be opened in the/);
      expect(editor.exportLayers()).toEqual(before);
    });

    it('loadState rejects a wrong schema version, a damaged snapshot or garbage, and leaves the design untouched', async () => {
      await target.populate(editor);
      const snapshot = await editor.exportState();
      const before = editor.exportLayers();
      await expect(editor.loadState({ ...snapshot, schemaVersion: 99 })).rejects.toBeInstanceOf(SnapshotError);
      await expect(editor.loadState({ ...snapshot, state: null })).rejects.toBeInstanceOf(SnapshotError);
      await expect(editor.loadState(null as never)).rejects.toThrow(/not a saved design/);
      expect(editor.exportLayers()).toEqual(before);
    });
  });
}
