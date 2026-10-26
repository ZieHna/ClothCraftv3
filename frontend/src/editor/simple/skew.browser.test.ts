// Slanting is off (step 9): every element is priced by its rotated bounding box, which a slanted element would not fit. Real Fabric, real
// pointer events on the side handle with Shift (Fabric's slant gesture), and an old snapshot with slanted elements.
import { afterEach, describe, expect, it } from 'vitest';
import { realPng } from '../../test/images';
import { CONTRACT_GARMENT } from '../contract';
import { createEditor } from '../createEditor';
import { SHAPE_KINDS, type EditorSnapshot, type SimpleEditorTools } from '../types';

interface FabricLike {
  lockSkewingX?: boolean;
  lockSkewingY?: boolean;
  skewX: number;
  skewY: number;
  oCoords: Record<string, { x: number; y: number }>;
}

describe('no slanting (real browser)', () => {
  let host: HTMLDivElement;
  let e: SimpleEditorTools;
  afterEach(() => {
    e?.dispose();
    host?.remove();
  });
  async function open() {
    host = document.createElement('div');
    host.style.width = '400px';
    document.body.append(host);
    e = await createEditor('simple', host);
    await e.loadBase(CONTRACT_GARMENT);
  }
  const objects = () => (e as unknown as { canvas: { getObjects: () => FabricLike[] } }).canvas.getObjects();

  /** Shift + drag the right-middle handle downwards: in Fabric that slants the element vertically (Fabric listens to mouse events here). */
  function shiftDragSideHandle(o: FabricLike) {
    const upper = host.querySelector('canvas.upper-canvas') as HTMLCanvasElement;
    const r = upper.getBoundingClientRect();
    const mr = o.oCoords.mr!;
    const fire = (type: string, dy: number) =>
      upper.dispatchEvent(new MouseEvent(type, { clientX: r.left + mr.x, clientY: r.top + mr.y + dy, shiftKey: true, bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1 }));
    fire('mousedown', 0);
    for (let dy = 5; dy <= 60; dy += 5) fire('mousemove', dy);
    fire('mouseup', 60);
  }

  it('every kind of element is locked against slanting', async () => {
    await open();
    e.addText('Slant me');
    for (const kind of SHAPE_KINDS) e.addShape(kind);
    await e.addImage(realPng(), 'Picture');
    expect(objects().length).toBe(2 + SHAPE_KINDS.length);
    for (const o of objects()) expect([o.lockSkewingX, o.lockSkewingY]).toEqual([true, true]);
  });

  it('Shift + dragging a side handle does not slant (and the same gesture does slant once the lock is lifted: the test is real)', async () => {
    await open();
    const id = e.addShape('rectangle');
    e.select(id);
    const o = objects()[0]!;
    shiftDragSideHandle(o);
    expect([o.skewX, o.skewY]).toEqual([0, 0]);
    // the control: without the lock the very same gesture slants it
    o.lockSkewingY = false;
    o.lockSkewingX = false;
    shiftDragSideHandle(o);
    expect(Math.abs(o.skewX) + Math.abs(o.skewY)).toBeGreaterThan(1);
  });

  it('an old snapshot with slanted elements opens straightened', async () => {
    await open();
    e.addShape('rectangle');
    e.addText('Old');
    const saved = await e.exportState();
    const state = saved.state as { objects: Record<string, unknown>[] };
    const slanted: EditorSnapshot = { ...saved, state: { ...state, objects: state.objects.map((o, i) => ({ ...o, skewX: i === 0 ? 25 : 0, skewY: i === 1 ? -12 : 0 })) } };
    await e.loadState(slanted);
    for (const o of objects()) expect([o.skewX, o.skewY]).toEqual([0, 0]);
    const again = (await e.exportState()).state as { objects: { skewX: number; skewY: number }[] };
    expect(again.objects.map((o) => [o.skewX, o.skewY])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});
