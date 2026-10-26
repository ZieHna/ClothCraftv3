// The "simple" engine: Fabric.js 7. Fabric is loaded ONLY by the dynamic import() in createSimpleEditor(); the imports
// below are type-only and vanish at build time. Fabric types stop at this file: callers only see SimpleEditorTools.
import type { Canvas, FabricObject, Group, IText, TMat2D } from 'fabric';
import { DEFAULT_FONT, fontChoice } from '../fonts';
import {
  DESIGN_SIZE,
  EditorBusyError,
  HISTORY_LIMIT,
  LAYER_LIMITS,
  LayerLockedError,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotError,
  assertSnapshot,
  exportSize,
  type DesignLayer,
  type EditOptions,
  type EditorSnapshot,
  type ExportPngOptions,
  type GarmentBase,
  type GestureSupport,
  type HistoryStats,
  type LayerPatch,
  type LayerStyle,
  type LayerType,
  type ShapeKind,
  type SimpleEditorTools,
  type StylePatch,
  type ViewState,
} from '../types';
import { MIME_OF, UploadError, downscaledSize, inspectImage, type ImageKind } from '../upload';
import { fitted, panned, resized, toViewState, viewToDesign, zoomAbout, type ViewParams } from '../view';
import { fontReady, loadFont } from './fontLoader';
import { drawGarment, isDarkGarment, loadImage } from './garment';
import { createGestures, type Gestures } from './gestures';

type FabricModule = typeof import('fabric');
type Tagged = FabricObject & {
  layerId?: string;
  layerName?: string;
  layerType?: LayerType;
  shapeKind?: ShapeKind;
  locked?: boolean;
  assetId?: string;
};
type SceneObject = Record<string, unknown>;
interface SimpleState {
  fabric: string;
  objects: SceneObject[];
  counter: number;
}
/**
 * One history step: the whole scene as JSON text (pictures appear only as "asset:<id>", never as bytes), the garment's
 * colour and size, and what was selected. Held as a string, so a step cannot be changed by later edits and costs only
 * its text. `assetIds` lets the history count which pictures each step needs.
 */
interface Step {
  scene: string;
  color: string;
  size: string;
  selection: string | null;
  assetIds: string[];
}

/** Custom properties Fabric must write into its JSON so layer identity and kind survive export and load. */
const KEEP = ['layerId', 'layerName', 'layerType', 'shapeKind', 'locked', 'assetId'];

/**
 * Selection handle sizes, in screen (CSS) px: the design canvas is NOT scaled by CSS any more (it is as big as its view
 * and sharp at devicePixelRatio), so these are what a finger or a mouse really meets, whatever the zoom.
 * A finger needs 44 CSS px or more to hit (touchCornerSize); a mouse keeps small handles.
 */
export const HANDLES = {
  fine: { cornerSize: 16, touchCornerSize: 28, padding: 4, linePadding: 20 },
  coarse: { cornerSize: 26, touchCornerSize: 48, padding: 12, linePadding: 36 },
} as const;

export interface SimpleEditorOptions {
  /** how the touch-gesture workaround is detected: tests override it to prove the fallback */
  detectGestures?: (canvas: Canvas) => GestureSupport;
}

export async function createSimpleEditor(host: HTMLElement, options: SimpleEditorOptions = {}): Promise<SimpleEditor> {
  const fabric = await import('fabric');
  return new SimpleEditor(fabric, host, options);
}

export class SimpleEditor implements SimpleEditorTools {
  readonly engine = 'simple' as const;
  private readonly stage: HTMLDivElement;
  private readonly garmentEl: HTMLCanvasElement;
  private readonly canvas: Canvas;
  private readonly resizeObserver: ResizeObserver;
  private readonly gestures: Gestures;
  private images = new Map<string, HTMLImageElement>();
  private dark = new Map<string, boolean>();
  private color = '';
  private size = '';
  /** every picture the design or any history step still needs: ONE Blob and ONE blob: URL per picture, whatever the steps */
  private assets = new Map<string, { blob: Blob; url: string }>();
  private listeners = new Set<() => void>();
  private selectionListeners = new Set<() => void>();
  private viewListeners = new Set<() => void>();
  private counter = 0;
  /** true while the editor itself changes the canvas, so Fabric's own events are not mistaken for the person's actions */
  private busy = false;
  private disposed = false;

  private history: Step[] = [];
  private cursor = -1;
  /** how many retained steps use each picture; at 0 the picture is released */
  private assetRefs = new Map<string, number>();
  /** edits applied `live` that no step records yet */
  private dirty = false;

  /**
   * Undo, redo, loading, and the placing of a new picture take turns on this queue. `pending` counts the jobs waiting or
   * running; while it is above 0 every editing call is refused (EditorBusyError) rather than changing a scene that is
   * about to be replaced.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  private view: ViewParams;
  private panMode = false;
  private coarse = false;

  constructor(
    private readonly fabric: FabricModule,
    host: HTMLElement,
    options: SimpleEditorOptions = {},
  ) {
    // The garment is NOT part of Fabric: it is drawn on its own canvas underneath, so it can never be selected,
    // deleted, exported as a layer or saved in the state. The transparent design canvas sits on top. Both canvases are
    // as big as the VIEW (CSS px) and their pixels are devicePixelRatio times that, so they stay sharp at any zoom.
    // The view (zoom and pan) is Fabric's viewport transform and the same transform when the garment is drawn.
    // Fabric owns these elements; React never renders them.
    this.stage = document.createElement('div');
    this.stage.dataset.editorStage = 'simple';
    Object.assign(this.stage.style, { position: 'relative', width: '100%', aspectRatio: '1 / 1', touchAction: 'none', overflow: 'hidden' });
    this.garmentEl = document.createElement('canvas');
    this.garmentEl.setAttribute('aria-hidden', 'true');
    this.garmentEl.dataset.garment = '';
    Object.assign(this.garmentEl.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    const designEl = document.createElement('canvas');
    this.stage.append(this.garmentEl, designEl);
    host.append(this.stage);

    const w = Math.max(1, Math.round(this.stage.clientWidth || host.clientWidth || 600));
    this.view = fitted(w, w);
    this.coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.canvas = new fabric.Canvas(designEl, {
      width: w,
      height: w,
      preserveObjectStacking: true,
      targetFindTolerance: 8, // a thin line or a small star is still easy to hit
      selection: false, // no rubber-band or shift-click multi-select: one layer at a time (history and the panels assume it)
    });
    Object.assign(this.canvas.wrapperEl.style, { position: 'absolute', inset: '0' });
    this.canvas.upperCanvasEl.setAttribute('aria-label', 'Design area. Double-click text to edit it on the garment, or use the panel.');
    this.applyView(false);

    // the person finished a drag, a resize, a rotation, or a text-editing session that changed the text: ONE step
    this.canvas.on('object:modified', () => {
      if (this.busy) return;
      this.commit();
      this.emit();
    });
    // typing on the canvas itself (double-click a text): keep the layer name in step; the step is recorded when editing ends
    this.canvas.on('text:changed', ({ target }) => {
      const t = target as Tagged & IText;
      t.layerName = nameFor(t.text);
      this.dirty = true;
      this.emit();
    });
    for (const e of ['selection:created', 'selection:updated', 'selection:cleared'] as const) {
      this.canvas.on(e, () => {
        if (this.disposed) return;
        this.syncDiagnostics();
        for (const l of this.selectionListeners) l();
      });
    }

    this.gestures = createGestures({
      canvas: this.canvas,
      stage: this.stage,
      detect: options.detectGestures,
      getView: () => this.getView(),
      zoomTo: (z, a) => this.zoomTo(z, a),
      zoomBy: (f, a) => this.zoomBy(f, a),
      panBy: (dx, dy) => this.panBy(dx, dy),
      isPanMode: () => this.panMode,
      transformable: () => {
        const o = this.canvas.getActiveObject() as Tagged | undefined;
        return o && o.layerId && o.locked !== true && o.visible !== false ? o : null;
      },
      onTransforming: () => this.emit(),
      onTransformEnd: () => {
        this.commit(); // a two-finger pinch or twist is ONE step
        this.emit();
      },
      onPointerKind: (coarse) => this.setCoarse(coarse),
      isBusy: () => this.pending > 0,
    });

    // the view is as big as its stage: follow it (layout changes, rotation of a phone, a resized window)
    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(this.stage);
  }

  // ---------------------------------------------------------------- the view (zoom and pan): not history, not state
  private measure(): void {
    if (this.disposed) return;
    const w = Math.round(this.stage.clientWidth);
    const h = Math.round(this.stage.clientHeight);
    if (w < 1 || h < 1 || (w === this.view.width && h === this.view.height)) return;
    this.view = resized(this.view, w, h);
    this.canvas.setDimensions({ width: w, height: h });
    this.applyView(true);
  }

  /**
   * Read-only facts about the stage, as data attributes: the view (zoom and pan, in CSS px), which kind of pointer the
   * handles are sized for, and how big a finger's target on the selected layer's smallest handle is. Nothing reads them
   * back: they exist so the touch and layout tests can measure the real thing from outside.
   */
  private syncDiagnostics(): void {
    if (this.disposed) return;
    const d = this.stage.dataset;
    d.pointer = this.coarse ? 'coarse' : 'fine';
    const t = this.getHandleTargets();
    d.handleTouchPx = t ? String(Math.round(t.touchMin * 10) / 10) : '';
    d.handleMousePx = t ? String(Math.round(t.mouseMin * 10) / 10) : '';
    d.zoom = this.view.zoom.toFixed(4);
    d.panX = this.view.panX.toFixed(2);
    d.panY = this.view.panY.toFixed(2);
    d.viewWidth = String(this.view.width);
  }

  /** Puts `this.view` on the canvas and the garment. */
  private applyView(notify: boolean): void {
    const v = this.view;
    this.canvas.setViewportTransform([v.zoom, 0, 0, v.zoom, v.panX, v.panY]);
    this.canvas.requestRenderAll();
    this.paintGarment();
    this.syncDiagnostics();
    if (notify) for (const l of this.viewListeners) l();
  }

  getView(): ViewState {
    return toViewState(this.view);
  }
  zoomTo(zoom: number, anchor?: { x: number; y: number }): void {
    this.view = zoomAbout(this.view, zoom, anchor);
    this.applyView(true);
  }
  zoomBy(factor: number, anchor?: { x: number; y: number }): void {
    this.zoomTo(this.view.zoom * factor, anchor);
  }
  zoomFit(): void {
    this.view = fitted(this.view.width, this.view.height);
    this.applyView(true);
  }
  zoomActual(): void {
    this.zoomTo(1);
  }
  panBy(dx: number, dy: number): void {
    this.view = panned(this.view, dx, dy);
    this.applyView(true);
  }
  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }
  setPanMode(on: boolean): void {
    this.panMode = on;
    this.canvas.defaultCursor = on ? 'grab' : 'default';
    this.canvas.hoverCursor = on ? 'grab' : 'move';
    this.canvas.setCursor(on ? 'grab' : 'default');
    for (const l of this.viewListeners) l();
  }
  getPanMode(): boolean {
    return this.panMode;
  }
  gestureSupport(): GestureSupport {
    return this.gestures.support;
  }

  // ---------------------------------------------------------------- handles sized for the pointer in use
  private setCoarse(coarse: boolean): void {
    if (coarse === this.coarse) return;
    this.coarse = coarse;
    for (const o of this.objects()) this.styleControls(o);
    this.canvas.requestRenderAll();
    this.syncDiagnostics();
  }

  private styleControls(o: Tagged): void {
    const h = this.coarse ? HANDLES.coarse : HANDLES.fine;
    o.set({
      cornerSize: h.cornerSize,
      touchCornerSize: h.touchCornerSize,
      cornerStyle: 'circle',
      transparentCorners: false,
      cornerColor: '#fffdf8',
      cornerStrokeColor: '#1a1714',
      borderColor: '#1a1714',
      borderScaleFactor: 2,
      padding: o.shapeKind === 'line' ? h.linePadding : h.padding,
      // no slanting (step 9): a slanted element is not a rectangle, so it could not be priced by its bounding box. Fabric slants
      // with a side handle and Shift; these locks turn that off for the mouse, and touch never slants.
      lockSkewingX: true,
      lockSkewingY: true,
    });
    o.setCoords();
  }

  /** for tests: the size, in CSS px, of the smallest handle's target for a finger and for a mouse, on the selected layer */
  getHandleTargets(): { coarse: boolean; touchMin: number; mouseMin: number; handles: number } | null {
    const o = this.canvas.getActiveObject();
    if (!o) return null;
    const size = (c: { tl: { x: number; y: number }; tr: { x: number; y: number }; bl: { x: number; y: number } }) => Math.min(Math.hypot(c.tr.x - c.tl.x, c.tr.y - c.tl.y), Math.hypot(c.bl.x - c.tl.x, c.bl.y - c.tl.y));
    const coords = Object.entries(o.oCoords ?? {}).filter(([k]) => o.isControlVisible(k));
    const touch = coords.map(([, c]) => size(c.touchCorner));
    const mouse = coords.map(([, c]) => size(c.corner));
    return { coarse: this.coarse, touchMin: Math.min(...touch), mouseMin: Math.min(...mouse), handles: coords.length };
  }

  // ---------------------------------------------------------------- garment (locked background)
  async loadBase(garment: GarmentBase): Promise<void> {
    const wanted = { ...garment.colorImages, [garment.color]: garment.image };
    const loaded = await Promise.all(Object.entries(wanted).map(async ([color, src]) => [color, await loadImage(src)] as const));
    if (this.disposed) return;
    this.images = new Map(loaded);
    this.dark.clear();
    this.color = garment.color;
    this.size = garment.size;
    this.paintGarment();
    this.resetHistory();
    this.emit();
  }

  /** Swap to the pre-coloured picture. The pictures were loaded by loadBase, so this is immediate. One history step. */
  setColor(color: string): void {
    this.assertIdle();
    if (!this.images.has(color)) throw new Error(`This garment has no picture in the colour "${color}".`);
    this.color = color;
    this.paintGarment();
    this.commit();
    this.emit();
  }

  /** The size is recorded for the order; the design is the same physical print on every size, so nothing is redrawn. */
  setSize(size: string): void {
    this.assertIdle();
    this.size = size;
    this.commit();
    this.emit();
  }

  getGarment(): { color: string; size: string } {
    return { color: this.color, size: this.size };
  }

  /** for tests and diagnostics: the garment as the editor holds it */
  get garment(): { color: string; size: string; loaded: boolean } {
    return { color: this.color, size: this.size, loaded: this.images.has(this.color) };
  }

  /** Draws the garment with the same view transform as the design, at devicePixelRatio, so it is as sharp as the photo allows. */
  private paintGarment(): void {
    const dpr = window.devicePixelRatio || 1;
    const v = this.view;
    const pw = Math.max(1, Math.round(v.width * dpr));
    const ph = Math.max(1, Math.round(v.height * dpr));
    if (this.garmentEl.width !== pw || this.garmentEl.height !== ph) {
      this.garmentEl.width = pw;
      this.garmentEl.height = ph;
    }
    const ctx = this.garmentEl.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    const img = this.images.get(this.color);
    if (!img) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * v.panX, dpr * v.panY);
    drawGarment(ctx, img, DESIGN_SIZE);
  }

  private isDark(): boolean {
    const img = this.images.get(this.color);
    if (!img) return false;
    let dark = this.dark.get(this.color);
    if (dark === undefined) {
      dark = isDarkGarment(img);
      this.dark.set(this.color, dark);
    }
    return dark;
  }

  // ---------------------------------------------------------------- export
  /**
   * The design area as pixels. The VIEW is set aside while it renders (zoom and pan never reach an export), and the
   * result is DESIGN_SIZE x the multiplier, lowered so its long side is at most MAX_EXPORT_PX.
   */
  private renderDesign(multiplier: number): HTMLCanvasElement {
    const vpt = this.canvas.viewportTransform.slice() as TMat2D;
    this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    try {
      return this.canvas.toCanvasElement(multiplier, { left: 0, top: 0, width: DESIGN_SIZE, height: DESIGN_SIZE });
    } finally {
      this.canvas.viewportTransform = vpt;
      this.canvas.calcViewportBoundaries();
    }
  }

  async exportPng(opts: ExportPngOptions = {}): Promise<Blob> {
    await this.whenIdle(); // never export a scene that an undo is halfway through replacing
    const { multiplier, px } = exportSize(opts.multiplier ?? 1);
    const design = this.renderDesign(multiplier);
    if (!opts.withGarment) return toBlob(design);
    const out = document.createElement('canvas');
    out.width = out.height = px;
    const ctx = out.getContext('2d');
    const img = this.images.get(this.color);
    if (ctx && img) {
      ctx.imageSmoothingQuality = 'high';
      drawGarment(ctx, img, px);
    }
    ctx?.drawImage(design, 0, 0, px, px);
    return toBlob(out);
  }

  exportLayers(): DesignLayer[] {
    return this.getLayers().filter((l) => l.visible);
  }

  /** the canvas's objects as plain data; a picture's session-only blob: URL is replaced by "asset:<id>" */
  private sceneObjects(): SceneObject[] {
    const json = this.canvas.toObject(KEEP) as { objects: SceneObject[] };
    return json.objects.map((o) => (typeof o.assetId === 'string' ? { ...o, src: `asset:${o.assetId}` } : o));
  }

  private usedAssetIds(): string[] {
    return [...new Set(this.objects().map((o) => o.assetId).filter((id): id is string => typeof id === 'string'))];
  }

  async exportState(): Promise<EditorSnapshot> {
    await this.whenIdle();
    const objects = this.sceneObjects();
    const assets: Record<string, Blob> = {};
    for (const id of this.usedAssetIds()) {
      const a = this.assets.get(id);
      if (a) assets[id] = a.blob;
    }
    const state: SimpleState = { fabric: this.fabric.version, objects, counter: this.counter };
    return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, engine: this.engine, state, assets };
  }

  /** The objects for a scene, with every picture pointing at its (one) blob: URL. */
  private async enliven(objects: SceneObject[], urlOf: (assetId: string) => string | undefined): Promise<Tagged[]> {
    const revived = objects.map((o) => {
      if (typeof o.assetId !== 'string') return o;
      const url = urlOf(o.assetId);
      if (!url) throw new SnapshotError('A picture in this saved design is missing.');
      return { ...o, src: url };
    });
    const live = (await this.fabric.util.enlivenObjects<FabricObject>(revived)) as Tagged[];
    for (const o of live) {
      // a design saved before slanting was turned off is straightened (the screen says so: see straightenSnapshot in editor/skew.ts)
      if (o.skewX || o.skewY) o.set({ skewX: 0, skewY: 0 });
      applyLock(o);
      this.styleControls(o);
    }
    return live;
  }

  loadState(snapshot: EditorSnapshot): Promise<void> {
    return this.enqueue(() => this.applyState(snapshot));
  }

  private async applyState(snapshot: EditorSnapshot): Promise<void> {
    // Everything that can fail happens BEFORE the current objects are touched, so a rejected snapshot changes nothing:
    // not the design, not the history.
    assertSnapshot(snapshot, this.engine);
    const state = snapshot.state as Partial<SimpleState>;
    if (!Array.isArray(state.objects)) throw new SnapshotError('That saved design is damaged.');
    const urls = new Map<string, string>();
    let live: Tagged[];
    try {
      live = await this.enliven(state.objects, (id) => {
        const blob = snapshot.assets[id];
        if (!blob) return undefined;
        const url = urls.get(id) ?? URL.createObjectURL(blob);
        urls.set(id, url);
        return url;
      });
    } catch (error) {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      throw error;
    }
    if (this.disposed) {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      throw new Error('The editor was closed.');
    }

    this.busy = true;
    try {
      this.canvas.discardActiveObject();
      this.canvas.remove(...this.canvas.getObjects());
      for (const a of this.assets.values()) URL.revokeObjectURL(a.url);
      this.assets = new Map([...urls].map(([id, url]) => [id, { blob: snapshot.assets[id]!, url }]));
      if (live.length) this.canvas.add(...live);
      const ids = live.map((o) => Number(String(o.layerId).replace('layer-', '')) || 0);
      this.counter = Math.max(state.counter ?? 0, ...ids, 0);
    } finally {
      this.busy = false;
    }
    // The fonts the loaded text uses (a premade design, a draft or a cart design may use Bebas Neue, Caveat or Pacifico before anything in this
    // page has asked for them): wait for the ones not loaded yet and measure the text with them, so the layers have their real size before the first history step.
    for (const family of new Set(live.filter((o): o is Tagged & IText => o instanceof this.fabric.FabricText).map((t) => t.fontFamily))) {
      if (!fontReady(family)) await this.refreshFonts(family); // only a font that has not been loaded yet: nothing else is re-measured
    }
    if (this.disposed) return;
    this.resetHistory(); // a loaded design starts a new history: there is no "before" to go back to
    this.canvas.requestRenderAll();
    this.emit();
  }

  // ---------------------------------------------------------------- lifecycle
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onSelectionChange(listener: () => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.selectionListeners.clear();
    this.viewListeners.clear();
    this.resizeObserver.disconnect();
    this.gestures.dispose();
    for (const a of this.assets.values()) URL.revokeObjectURL(a.url);
    this.assets.clear();
    this.history = [];
    this.assetRefs.clear();
    void this.canvas.dispose();
    this.stage.remove();
  }

  // ---------------------------------------------------------------- the queue
  isBusy(): boolean {
    return this.pending > 0;
  }

  whenIdle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** Editing calls made while a restore is working are refused: the scene they would change is about to be replaced. */
  private assertIdle(): void {
    if (this.pending > 0) throw new EditorBusyError();
  }

  /**
   * Runs `job` after every job queued before it. While any job is waiting or running the editor is busy: the canvas
   * ignores the pointer (so a drag cannot start in the gap) and every editing call is refused. A job that fails does
   * not stop the ones behind it.
   */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.pending++;
    this.setBusyUi(true);
    this.emit();
    const run = this.queue.then(job);
    const settled = run
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.pending--;
        if (this.pending === 0) this.setBusyUi(false);
        this.emit();
      });
    this.queue = settled;
    // the caller's promise settles only AFTER the editor is idle again, so `await undo()` can be followed by an edit at once
    return settled.then(() => run);
  }

  private setBusyUi(busy: boolean): void {
    this.canvas.upperCanvasEl.style.pointerEvents = busy ? 'none' : '';
    this.stage.setAttribute('aria-busy', String(busy));
  }

  // ---------------------------------------------------------------- history
  private captureStep(): Step {
    return {
      scene: JSON.stringify(this.sceneObjects()),
      color: this.color,
      size: this.size,
      selection: this.getSelection(),
      assetIds: this.usedAssetIds(),
    };
  }

  private refStep(step: Step): void {
    for (const id of step.assetIds) this.assetRefs.set(id, (this.assetRefs.get(id) ?? 0) + 1);
  }

  /** A step is forgotten (cap reached, or its redo branch abandoned): pictures nothing else needs are released. */
  private unrefStep(step: Step): void {
    const inDesign = new Set(this.usedAssetIds());
    for (const id of step.assetIds) {
      const left = (this.assetRefs.get(id) ?? 1) - 1;
      if (left > 0) {
        this.assetRefs.set(id, left);
        continue;
      }
      this.assetRefs.delete(id);
      const asset = this.assets.get(id);
      if (asset && !inDesign.has(id)) {
        URL.revokeObjectURL(asset.url);
        this.assets.delete(id);
      }
    }
  }

  /** The history becomes one step, the design as it is now. Pictures no step needs are released. */
  private resetHistory(): void {
    this.history = [];
    this.assetRefs.clear();
    this.dirty = false;
    const base = this.captureStep();
    this.history.push(base);
    this.refStep(base);
    this.cursor = 0;
    for (const [id, a] of this.assets) {
      if (!this.assetRefs.has(id)) {
        URL.revokeObjectURL(a.url);
        this.assets.delete(id);
      }
    }
  }

  /**
   * Records the design as a new step, unless nothing has changed since the last one. Anything after the current step
   * (what could have been redone) is discarded, and the oldest step is dropped beyond HISTORY_LIMIT.
   */
  private commit(): void {
    if (this.busy || this.disposed) return;
    this.dirty = false;
    const step = this.captureStep();
    const cur = this.history[this.cursor];
    if (cur && cur.scene === step.scene && cur.color === step.color && cur.size === step.size) return;
    for (const dropped of this.history.splice(this.cursor + 1)) this.unrefStep(dropped);
    this.history.push(step);
    this.refStep(step);
    this.cursor = this.history.length - 1;
    while (this.history.length > HISTORY_LIMIT + 1) {
      this.unrefStep(this.history.shift()!);
      this.cursor--;
    }
  }

  commitEdit(): void {
    if (this.pending > 0 || !this.dirty) return; // a restore that is working has already settled any live edits
    this.commit();
    this.emit();
  }

  canUndo(): boolean {
    return this.cursor > 0 || this.dirty;
  }

  canRedo(): boolean {
    return this.cursor < this.history.length - 1;
  }

  undo(): Promise<void> {
    return this.enqueue(async () => {
      this.commit(); // edits still in flight become a step first, so undo reverts them
      if (this.cursor <= 0) return;
      await this.restore(this.history[this.cursor - 1]!);
      this.cursor--;
    });
  }

  redo(): Promise<void> {
    return this.enqueue(async () => {
      if (this.cursor >= this.history.length - 1) return;
      await this.restore(this.history[this.cursor + 1]!);
      this.cursor++;
    });
  }

  /** Puts the scene of a step on the canvas. Pictures come from the one retained blob each, not from any copy. */
  private async restore(step: Step): Promise<void> {
    const live = await this.enliven(JSON.parse(step.scene) as SceneObject[], (id) => this.assets.get(id)?.url);
    if (this.disposed) return;
    this.busy = true;
    try {
      this.canvas.discardActiveObject();
      this.canvas.remove(...this.canvas.getObjects());
      if (live.length) this.canvas.add(...live);
      this.color = step.color;
      this.size = step.size;
      this.paintGarment();
      const keep = step.selection ? live.find((o) => o.layerId === step.selection) : undefined;
      if (keep) this.canvas.setActiveObject(keep);
    } finally {
      this.busy = false;
    }
    this.dirty = false;
    this.canvas.requestRenderAll();
  }

  historyStats(): HistoryStats {
    return {
      undoSteps: Math.max(0, this.cursor),
      redoSteps: Math.max(0, this.history.length - 1 - this.cursor),
      retainedAssets: this.assets.size,
      sceneChars: this.history.reduce((n, s) => n + s.scene.length, 0),
    };
  }

  /** Runs a change to the design. A `live` change is recorded later by commitEdit(); any other is its own step. */
  private edit(change: () => void, opts: EditOptions = {}): void {
    this.busy = true;
    try {
      change();
    } finally {
      this.busy = false;
    }
    this.canvas.requestRenderAll();
    if (opts.live) this.dirty = true;
    else this.commit();
    this.emit();
  }

  // ---------------------------------------------------------------- layers
  private objects(): Tagged[] {
    return this.canvas.getObjects() as Tagged[];
  }

  /** Leaf layers, bottom to top. A group (none are created yet) is flattened into its children. */
  getLayers(): DesignLayer[] {
    const out: DesignLayer[] = [];
    const walk = (o: Tagged, parentVisible: boolean, parentLocked: boolean) => {
      const visible = parentVisible && o.visible !== false;
      const locked = parentLocked || o.locked === true;
      if (o instanceof this.fabric.Group) {
        for (const child of (o as Group).getObjects()) walk(child as Tagged, visible, locked);
        return;
      }
      const t = this.fabric.util.qrDecompose(o.calcTransformMatrix());
      // a line has no height of its own: report the thickness of its stroke instead of 0
      const height = Math.max(o.height * Math.abs(t.scaleY), o.shapeKind === 'line' ? o.strokeWidth : 0);
      out.push({
        id: o.layerId ?? '',
        type: o.layerType ?? 'shape',
        name: o.layerName ?? 'Layer',
        x: round(t.translateX),
        y: round(t.translateY),
        width: round(o.width * Math.abs(t.scaleX)),
        height: round(height),
        rotation: round(((t.angle % 360) + 360) % 360),
        visible,
        locked,
      });
    };
    for (const o of this.objects()) walk(o, true, false);
    return out;
  }

  /** where a new layer goes: on the chest at the fit; at the middle of what is on screen once the view is zoomed or panned */
  private startPoint(type: LayerType, step: number): { x: number; y: number } {
    if (this.view.atFit) return { x: DESIGN_SIZE / 2 + step, y: (type === 'text' ? DESIGN_SIZE * 0.3 : DESIGN_SIZE * 0.54) + Math.abs(step) / 2 };
    const c = viewToDesign(this.view, this.view.width / 2, this.view.height / 2);
    const clamp01 = (n: number) => Math.min(DESIGN_SIZE - 40, Math.max(40, n));
    return { x: clamp01(c.x + step), y: clamp01(c.y + Math.abs(step) / 2) };
  }

  private place(object: Tagged, type: LayerType, name: string, shape?: ShapeKind): string {
    const id = `layer-${++this.counter}`;
    Object.assign(object, { layerId: id, layerName: name, layerType: type, locked: false, shapeKind: shape });
    this.styleControls(object);
    // repeated adds step aside instead of stacking
    const at = this.startPoint(type, (((this.counter - 1) % 5) - 2) * 40);
    object.setPositionByOrigin(new this.fabric.Point(at.x, at.y), 'center', 'center');
    this.busy = true;
    try {
      this.canvas.add(object);
      this.canvas.setActiveObject(object);
    } finally {
      this.busy = false;
    }
    this.canvas.requestRenderAll();
    this.commit(); // one step: the layer, selected
    this.emit();
    return id;
  }

  addText(text: string): string {
    this.assertIdle();
    // dark ink on a light garment, cream on a dark one, so new text is always readable
    const box = new this.fabric.IText(text, { fontFamily: DEFAULT_FONT, fontWeight: fontChoice(DEFAULT_FONT).weight, fontSize: 64, fill: this.isDark() ? '#fffdf8' : '#2c2825', textAlign: 'center' });
    const id = this.place(box as Tagged, 'text', nameFor(text));
    // normally Jost is already loaded (the page waits for it at start-up); if not, re-measure the box when it arrives
    if (!document.fonts.check(`${fontChoice(DEFAULT_FONT).weight} 64px "${DEFAULT_FONT}"`)) void this.refreshFonts(DEFAULT_FONT);
    return id;
  }

  addShape(kind: ShapeKind): string {
    this.assertIdle();
    const { Rect, Circle, Triangle, Polygon, Line } = this.fabric;
    const fill = '#6b8f71';
    const common = { fill, stroke: '#1a1714', strokeWidth: 0, strokeUniform: true };
    let shape: FabricObject;
    switch (kind) {
      case 'rectangle':
        shape = new Rect({ ...common, width: 180, height: 120, rx: 6, ry: 6 });
        break;
      case 'circle':
        shape = new Circle({ ...common, radius: 80 });
        break;
      case 'triangle':
        shape = new Triangle({ ...common, width: 170, height: 150 });
        break;
      case 'star': {
        const points = Array.from({ length: 10 }, (_, i) => {
          const r = i % 2 ? 36 : 85;
          const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
          return { x: Math.cos(a) * r, y: Math.sin(a) * r };
        });
        shape = new Polygon(points, common);
        break;
      }
      case 'line':
        shape = new Line([0, 0, 220, 0], { stroke: fill, strokeWidth: 10, strokeLineCap: 'round', strokeUniform: true });
        break;
    }
    return this.place(shape as Tagged, 'shape', SHAPE_NAME[kind], kind);
  }

  async addImage(image: Blob, name = 'Picture'): Promise<string> {
    // 1. judge the file by its bytes and header, BEFORE any decoding; throws UploadError and changes nothing
    const info = await inspectImage(image);
    // 2. shrink a large picture before it reaches the canvas, and keep what we store small
    const blob = await shrink(image, info.kind, info.width, info.height);
    const url = URL.createObjectURL(blob);
    let img: Tagged;
    try {
      img = (await this.fabric.FabricImage.fromURL(url)) as Tagged;
    } catch {
      URL.revokeObjectURL(url);
      throw new UploadError('damaged', 'That picture looks damaged, so it cannot be used.');
    }
    // 3. place it: this takes its turn after any undo, redo or load that is already working
    try {
      return await this.enqueue(async () => {
        if (this.disposed) throw new Error('The editor was closed.');
        const assetId = `asset-${this.counter + 1}`;
        this.assets.set(assetId, { blob, url });
        img.assetId = assetId;
        const fit = Math.min(1, (DESIGN_SIZE * 0.45) / Math.max(img.width, img.height));
        img.set({ scaleX: fit, scaleY: fit });
        return this.place(img, 'image', name);
      });
    } catch (error) {
      if (![...this.assets.values()].some((a) => a.url === url)) URL.revokeObjectURL(url);
      throw error;
    }
  }

  private find(id: string): Tagged {
    const found = this.objects().find((o) => o.layerId === id);
    if (!found) throw new Error(`No layer ${id}.`);
    return found;
  }

  updateLayer(id: string, patch: LayerPatch, opts: EditOptions = {}): void {
    this.assertIdle();
    const o = this.find(id);
    const touchesMore = Object.keys(patch).some((k) => k !== 'locked' && k !== 'visible');
    if (o.locked === true && patch.locked !== false && touchesMore) throw new LayerLockedError(o.layerName ?? 'Layer'); // unlocking first is allowed
    const { position, size, rotation } = LAYER_LIMITS;
    this.edit(() => {
      const centre = o.getCenterPoint();
      if (patch.name !== undefined) o.layerName = patch.name.slice(0, 40);
      if (patch.rotation !== undefined) o.set('angle', clamp(patch.rotation, rotation.min, rotation.max));
      if (patch.width !== undefined && o.width > 0) o.set('scaleX', clamp(patch.width, size.min, size.max) / o.width);
      if (patch.height !== undefined && o.height > 0) o.set('scaleY', clamp(patch.height, size.min, size.max) / o.height);
      if (patch.visible !== undefined) o.set('visible', patch.visible);
      if (patch.locked !== undefined) {
        o.locked = patch.locked;
        applyLock(o);
      }
      const x = clamp(patch.x ?? centre.x, position.min, position.max);
      const y = clamp(patch.y ?? centre.y, position.min, position.max);
      o.setPositionByOrigin(new this.fabric.Point(x, y), 'center', 'center');
      o.setCoords();
    }, opts);
  }

  moveLayer(id: string, direction: 'up' | 'down'): void {
    this.assertIdle();
    const o = this.find(id);
    this.edit(() => {
      if (direction === 'up') this.canvas.bringObjectForward(o);
      else this.canvas.sendObjectBackwards(o);
    });
  }

  removeLayer(id: string): void {
    this.assertIdle();
    const o = this.find(id);
    if (o.locked) throw new LayerLockedError(o.layerName ?? 'Layer');
    this.edit(() => {
      if (this.canvas.getActiveObject() === o) this.canvas.discardActiveObject();
      this.canvas.remove(o);
    });
    // a picture's blob stays: the step before this one needs it for undo; it is released when no step does (unrefStep)
  }

  // ---------------------------------------------------------------- properties and selection
  getStyle(id: string): LayerStyle {
    const o = this.find(id);
    const opacity = o.opacity;
    if (o.layerType === 'text') {
      const t = o as Tagged & IText;
      return { type: 'text', text: t.text, fontFamily: t.fontFamily, fontSize: t.fontSize, fill: String(t.fill), textAlign: t.textAlign as 'left' | 'center' | 'right', opacity };
    }
    if (o.layerType === 'image') return { type: 'image', opacity };
    const line = o.shapeKind === 'line';
    return {
      type: 'shape',
      shape: o.shapeKind ?? 'rectangle',
      fill: line ? String(o.stroke) : String(o.fill),
      stroke: String(o.stroke),
      strokeWidth: o.strokeWidth,
      opacity,
    };
  }

  async updateStyle(id: string, patch: StylePatch, opts: EditOptions = {}): Promise<void> {
    this.assertIdle();
    const o = this.find(id);
    if (o.locked) throw new LayerLockedError(o.layerName ?? 'Layer');
    if (o.layerType === 'text') {
      const t = o as Tagged & IText;
      if (patch.fontFamily !== undefined && (patch.fontFamily !== t.fontFamily || !document.fonts.check(`${fontChoice(patch.fontFamily).weight} 64px "${patch.fontFamily}"`))) {
        // Fonts load on first use. Wait for the file, THEN switch and re-measure: Fabric caches glyph widths per family,
        // and a box measured before the file arrived would keep the fallback font's widths (the spike's lesson).
        await loadFont(patch.fontFamily);
        // the change then takes its turn on the queue: an undo that began while the font was loading goes first
        await this.enqueue(async () => {
          const target = this.objects().find((x) => x.layerId === id);
          if (!this.disposed && target && target.locked !== true) this.applyStyle(target, patch, opts);
        });
        return;
      }
    }
    this.applyStyle(o, patch, opts);
  }

  private applyStyle(o: Tagged, patch: StylePatch, opts: EditOptions): void {
    this.edit(() => {
      if (o.layerType === 'text') {
        const t = o as Tagged & IText;
        if (patch.fontFamily !== undefined) {
          t.set({ fontFamily: patch.fontFamily, fontWeight: fontChoice(patch.fontFamily).weight });
          this.fabric.cache.clearFontCache(patch.fontFamily);
          t.initDimensions();
        }
        if (patch.text !== undefined) {
          t.set('text', patch.text);
          t.layerName = nameFor(patch.text);
        }
        if (patch.fontSize !== undefined) t.set('fontSize', clamp(patch.fontSize, 8, 400));
        if (patch.fill !== undefined) t.set('fill', patch.fill);
        if (patch.textAlign !== undefined) t.set('textAlign', patch.textAlign);
      } else if (o.layerType === 'shape') {
        const line = o.shapeKind === 'line';
        if (patch.fill !== undefined && !line) o.set('fill', patch.fill);
        if (patch.stroke !== undefined) o.set('stroke', patch.stroke);
        if (patch.strokeWidth !== undefined) o.set('strokeWidth', line ? Math.max(1, patch.strokeWidth) : Math.max(0, patch.strokeWidth));
        if (patch.fill !== undefined && line) o.set('stroke', patch.fill); // a line's colour is its stroke
      }
      if (patch.opacity !== undefined) o.set('opacity', clamp(patch.opacity, 0, 1));
      o.setCoords();
    }, opts);
  }

  /** Any layer can be selected from here, locked or hidden ones too: a list needs to reach them to unlock or show them. */
  select(id: string | null): void {
    this.assertIdle();
    if (id === null) this.canvas.discardActiveObject();
    else this.canvas.setActiveObject(this.find(id));
    this.canvas.requestRenderAll();
  }

  getSelection(): string | null {
    const a = this.canvas.getActiveObject() as Tagged | undefined;
    return a?.layerId ?? null;
  }

  // ---------------------------------------------------------------- fonts (spike lesson)
  /**
   * Fabric caches glyph widths per font family. Text measured before its web font arrived keeps the fallback font's
   * widths (a box that is too wide or too narrow). After the font loads: wait for it, drop that family from Fabric's
   * cache, and re-measure every text layer. With no family given, every family in use is refreshed.
   * This corrects the measuring only: it is not a design change, so it is not a history step.
   */
  async refreshFonts(family?: string): Promise<void> {
    const texts = this.objects().filter((o): o is Tagged & IText => o instanceof this.fabric.FabricText);
    const families = family ? [family] : [...new Set(texts.map((t) => t.fontFamily))];
    await Promise.all(families.map((f) => loadFont(f)));
    if (this.disposed) return;
    for (const f of families) this.fabric.cache.clearFontCache(f);
    for (const t of texts) {
      if (!families.includes(t.fontFamily)) continue;
      t.initDimensions();
      t.setCoords();
    }
    this.canvas.requestRenderAll();
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const l of this.listeners) l();
  }
}

const SHAPE_NAME: Record<ShapeKind, string> = { rectangle: 'Rectangle', circle: 'Circle', triangle: 'Triangle', star: 'Star', line: 'Line' };

function applyLock(o: Tagged): void {
  const l = o.locked === true;
  o.set({ selectable: !l, evented: !l, hasControls: !l, lockMovementX: l, lockMovementY: l, lockRotation: l, lockScalingX: l, lockScalingY: l });
}

const round = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const nameFor = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 24) || 'Text';

function toBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be made.'))), type, quality));
}

/** Brings a picture's long edge down to MAX_LONG_EDGE (never enlarges), in its own format. Small pictures pass through untouched. */
async function shrink(file: Blob, kind: ImageKind, width: number, height: number): Promise<Blob> {
  const target = downscaledSize(width, height);
  if (!target.scaled) return file.type === MIME_OF[kind] ? file : new Blob([file], { type: MIME_OF[kind] });
  let bitmap: ImageBitmap;
  try {
    // the decoder resizes while it decodes, so the full-size pixels are never held
    bitmap = await createImageBitmap(file, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high' });
  } catch {
    throw new UploadError('damaged', 'That picture looks damaged, so it cannot be used.');
  }
  const c = document.createElement('canvas');
  c.width = target.width;
  c.height = target.height;
  c.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return toBlob(c, MIME_OF[kind], kind === 'png' ? undefined : 0.9);
}
