// ALL touch and pointer gesture code for the Simple editor lives in this one file (Pointer Events, no Touch Events).
// It is the fragile part, so it is kept in one place:
//
//   One finger          : not handled here. Fabric selects and drags a layer, exactly as with a mouse.
//   Two fingers, a layer is selected (and unlocked)
//                       : pinch scales it and twisting rotates it. ONE history step per gesture.
//   Two fingers, nothing selected
//                       : pinch zooms the canvas about the fingers and moving them pans it.
//   Hand tool / Space   : one pointer drags the canvas (pan), mouse or finger.
//   Ctrl + wheel        : zoom about the pointer (this is also what a trackpad pinch sends).
//
// THE WORKAROUND: when the second finger lands, Fabric has often already started dragging the layer under the first.
// The only way to stop that is to clear Fabric's active transform, a PRIVATE field (`canvas._currentTransform`). The spike
// did this; here it is isolated in cancelFabricTransform(), feature-detected at start-up by detectTransformCancel(), and
// if the field is missing (a different Fabric) the layer pinch is switched OFF instead of throwing: the numeric fields and
// the rotate buttons stay, and zooming the canvas (which needs no private field) keeps working.
import type { Canvas, FabricObject } from 'fabric';
import type { GestureSupport, ViewState } from '../types';

type Point = { x: number; y: number };

/**
 * Can this Fabric's active transform be cancelled? 7.4.0 declares `_currentTransform: Transform | null = null`, so it is an
 * own property of every canvas. If a later Fabric renames or removes it, the answer is no and the pinch stays off.
 */
export function detectTransformCancel(canvas: unknown): GestureSupport {
  if (typeof canvas === 'object' && canvas !== null && '_currentTransform' in canvas) return { pinch: true };
  return { pinch: false, reason: 'This Fabric version does not expose the active transform, so pinch and twist of a layer are off. Use the size and rotation fields.' };
}

/** the one place that touches the private field */
function cancelFabricTransform(canvas: Canvas): void {
  (canvas as unknown as { _currentTransform: unknown })._currentTransform = null;
}

export interface GestureHost {
  canvas: Canvas;
  /** the element the view lives in: the wheel listener goes here */
  stage: HTMLElement;
  getView(): ViewState;
  zoomTo(zoom: number, anchor: Point): void;
  zoomBy(factor: number, anchor: Point): void;
  panBy(dx: number, dy: number): void;
  isPanMode(): boolean;
  /** the selected layer a two-finger gesture may transform: one that is unlocked and visible, or null */
  transformable(): FabricObject | null;
  /** a gesture changed the selected layer; redraw whoever shows it */
  onTransforming(): void;
  /** a layer gesture finished: record ONE history step */
  onTransformEnd(): void;
  /** which kind of pointer was last used: coarse (a finger) or fine (a mouse), so handles can be sized to match */
  onPointerKind(coarse: boolean): void;
  isBusy(): boolean;
  /** how the cancel workaround is detected (overridable so the fallback can be tested) */
  detect?: (canvas: Canvas) => GestureSupport;
}

export interface Gestures {
  support: GestureSupport;
  dispose(): void;
}

type Mode = 'idle' | 'pan' | 'pinch-layer' | 'pinch-view' | 'ignore';

export function createGestures(host: GestureHost): Gestures {
  const { canvas, stage } = host;
  const el = canvas.upperCanvasEl;
  const support = (host.detect ?? detectTransformCancel)(canvas);
  const touches = new Map<number, Point>(); // client px of every finger down
  let mode: Mode = 'idle';
  let panId: number | null = null;
  let lastPan: Point = { x: 0, y: 0 };
  // layer pinch
  let layer: FabricObject | null = null;
  let startDist = 1;
  let startAngle = 0;
  let startScale = { x: 1, y: 1 };
  let startRotation = 0;
  let startCentre: ReturnType<FabricObject['getCenterPoint']> | null = null;
  let selectedAtFirstTouch: FabricObject | null = null;
  // view pinch
  let prevDist = 1;
  let prevMid: Point = { x: 0, y: 0 };
  let raf = 0;

  const rect = () => el.getBoundingClientRect();
  const toView = (p: Point): Point => ({ x: p.x - rect().left, y: p.y - rect().top });
  const swallow = (e: Event) => {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };
  const pair = (): [Point, Point] => {
    const [a, b] = [...touches.values()];
    return [a!, b!];
  };
  const measure = () => {
    const [a, b] = pair();
    return { dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const startTwoFingers = () => {
    const m = measure();
    // a second finger ends any one-finger pan, and whatever Fabric had begun with the first finger
    panId = null;
    // the layer that was selected when the first finger came down counts even if that finger landed on empty canvas
    // (Fabric deselects on such a touch): the pinch is "of the selected layer", wherever the fingers are
    const chosen = host.transformable() ?? (selectedAtFirstTouch && isUsable(selectedAtFirstTouch) ? selectedAtFirstTouch : null);
    if (chosen) {
      if (!support.pinch) {
        mode = 'ignore'; // the layer pinch is off in this Fabric: do nothing, throw nothing
        return;
      }
      cancelFabricTransform(canvas);
      layer = chosen;
      if (canvas.getActiveObject() !== chosen) canvas.setActiveObject(chosen); // a first finger on empty canvas had deselected it
      startDist = m.dist;
      startAngle = m.angle;
      startScale = { x: chosen.scaleX, y: chosen.scaleY };
      startRotation = chosen.angle;
      startCentre = chosen.getCenterPoint();
      mode = 'pinch-layer';
    } else {
      cancelFabricTransform(canvas);
      prevDist = m.dist;
      prevMid = toView(m.mid);
      mode = 'pinch-view';
    }
  };

  const isUsable = (o: FabricObject) => o.visible !== false && (o as FabricObject & { locked?: boolean }).locked !== true;

  const progress = () => {
    if (mode === 'pinch-layer' && layer) {
      const m = measure();
      const k = m.dist / startDist;
      layer.set({ scaleX: startScale.x * k, scaleY: startScale.y * k, angle: startRotation + (m.angle - startAngle) });
      if (startCentre) layer.setPositionByOrigin(startCentre, 'center', 'center');
      layer.setCoords();
      canvas.requestRenderAll();
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          host.onTransforming();
        });
      }
    } else if (mode === 'pinch-view') {
      const m = measure();
      const mid = toView(m.mid);
      host.zoomBy(m.dist / prevDist, prevMid); // grows or shrinks the design about where the fingers WERE...
      host.panBy(mid.x - prevMid.x, mid.y - prevMid.y); // ...then follows the fingers' movement
      prevDist = m.dist;
      prevMid = mid;
    }
  };

  const finish = () => {
    if (mode === 'pinch-layer' && layer) {
      const done = layer;
      layer = null;
      mode = 'ignore'; // the finger still down must not start a drag of its own
      if (canvas.getActiveObject() !== done) canvas.setActiveObject(done);
      host.onTransformEnd();
    } else {
      mode = touches.size === 0 ? 'idle' : 'ignore';
    }
  };

  const onDown = (e: PointerEvent) => {
    const touch = e.pointerType === 'touch';
    host.onPointerKind(touch || e.pointerType === 'pen');
    if (host.isBusy()) return swallow(e);
    if (touch) {
      if (touches.size === 0) selectedAtFirstTouch = host.transformable();
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        startTwoFingers();
        return swallow(e);
      }
      if (touches.size > 2 || mode === 'ignore') return swallow(e);
    }
    // the hand tool (or Space): one pointer, mouse or finger, drags the canvas
    if (host.isPanMode() && mode === 'idle') {
      mode = 'pan';
      panId = e.pointerId;
      lastPan = { x: e.clientX, y: e.clientY };
      return swallow(e);
    }
  };

  const onMove = (e: PointerEvent) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pan' && e.pointerId === panId) {
      host.panBy(e.clientX - lastPan.x, e.clientY - lastPan.y);
      lastPan = { x: e.clientX, y: e.clientY };
      return swallow(e);
    }
    if ((mode === 'pinch-layer' || mode === 'pinch-view') && touches.size >= 2) {
      progress();
      return swallow(e);
    }
    if (mode === 'ignore') return swallow(e);
  };

  const onUp = (e: PointerEvent) => {
    const wasTouch = touches.delete(e.pointerId);
    if (mode === 'pan' && e.pointerId === panId) {
      mode = 'idle';
      panId = null;
      return swallow(e);
    }
    if (mode === 'pinch-layer' || mode === 'pinch-view') {
      if (touches.size < 2) finish();
      return swallow(e);
    }
    if (mode === 'ignore') {
      if (touches.size === 0) mode = 'idle';
      return swallow(e);
    }
    if (wasTouch && touches.size === 0) selectedAtFirstTouch = null;
  };

  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return; // a plain wheel scrolls the page, as people expect
    e.preventDefault();
    const r = el.getBoundingClientRect();
    host.zoomBy(Math.exp(-e.deltaY * 0.0025), { x: e.clientX - r.left, y: e.clientY - r.top });
  };

  // capture phase on the target itself, so these run BEFORE Fabric's own listeners and can stop them
  const opts = { capture: true } as const;
  el.addEventListener('pointerdown', onDown, opts);
  el.addEventListener('pointermove', onMove, opts);
  el.addEventListener('pointerup', onUp, opts);
  el.addEventListener('pointercancel', onUp, opts);
  stage.addEventListener('wheel', onWheel, { passive: false });
  // the canvas never scrolls the page; everything outside it still does
  el.style.touchAction = 'none';
  stage.style.touchAction = 'none';

  return {
    support,
    dispose() {
      el.removeEventListener('pointerdown', onDown, opts);
      el.removeEventListener('pointermove', onMove, opts);
      el.removeEventListener('pointerup', onUp, opts);
      el.removeEventListener('pointercancel', onUp, opts);
      stage.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
