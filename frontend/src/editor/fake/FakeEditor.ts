import { DEFAULT_FONT } from '../fonts';
import {
  DESIGN_SIZE,
  EditorBusyError,
  HISTORY_LIMIT,
  LAYER_LIMITS,
  LayerLockedError,
  SNAPSHOT_SCHEMA_VERSION,
  assertSnapshot,
  type DesignLayer,
  type EditOptions,
  type EditorMode,
  type EditorSnapshot,
  type ExportPngOptions,
  type GarmentBase,
  type GestureSupport,
  type HistoryStats,
  type LayerPatch,
  type LayerStyle,
  type ShapeKind,
  type SimpleEditorTools,
  type StylePatch,
  type ViewState,
  exportSize,
} from '../types';
import { fitted, panned, resized, toViewState, zoomAbout, type ViewParams } from '../view';
import { inspectImage } from '../upload';

type Row = DesignLayer & { assetId?: string; style: LayerStyle };
interface FakeState {
  layers: Row[];
  counter: number;
}
interface Step {
  scene: string;
  color: string;
  size: string;
  selection: string | null;
  assetIds: string[];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * In-memory editor with no canvas. It exists so the shared contract suites (contract.ts, toolsContract.ts) can pin the
 * interfaces' behaviour in jsdom; the real Fabric adapter must pass the same suites in a real browser.
 * It does no drawing and no downscaling, but it applies the same upload checks (they only read bytes), the same lock
 * rules, and the same history rules: snapshot steps that refer to pictures by id and share one Blob per picture.
 */
export class FakeEditor implements SimpleEditorTools {
  disposed = false;
  private color = '';
  private size = '';
  private colorImages: Record<string, string> = {};
  private layers: Row[] = [];
  private assets = new Map<string, Blob>();
  private counter = 0;
  private selected: string | null = null;
  private listeners = new Set<() => void>();
  private selectionListeners = new Set<() => void>();
  private history: Step[] = [];
  private cursor = -1;
  private refs = new Map<string, number>();
  private dirty = false;
  /** undo, redo, loading and picture placement take turns, as in the real editor */
  private pending = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private view: ViewParams = fitted(600, 600);
  private viewListeners = new Set<() => void>();
  private panMode = false;
  /** for tests: what the last exportPng was asked for and what it got */
  lastExport: { px: number; withGarment: boolean } | null = null;

  constructor(readonly engine: EditorMode = 'simple') {}

  async loadBase(garment: GarmentBase): Promise<void> {
    this.colorImages = { ...garment.colorImages, [garment.color]: garment.image };
    this.color = garment.color;
    this.size = garment.size;
    this.resetHistory();
    this.emit();
  }
  setColor(color: string): void {
    this.assertIdle();
    if (!(color in this.colorImages)) throw new Error(`This garment has no picture in the colour "${color}".`);
    this.color = color;
    this.commit();
    this.emit();
  }
  setSize(size: string): void {
    this.assertIdle();
    this.size = size;
    this.commit();
    this.emit();
  }
  isBusy(): boolean {
    return this.pending > 0;
  }
  whenIdle(): Promise<void> {
    return this.queue.then(() => undefined);
  }
  private assertIdle(): void {
    if (this.pending > 0) throw new EditorBusyError();
  }
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.pending++;
    this.emit();
    const run = this.queue.then(async () => {
      await Promise.resolve(); // a real editor decodes pictures here: give other callers the chance to collide
      return job();
    });
    const settled = run
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
        this.emit();
      });
    this.queue = settled;
    return settled.then(() => run); // settles after the editor is idle again
  }

  getGarment() {
    return { color: this.color, size: this.size };
  }

  async exportPng(opts: ExportPngOptions = {}): Promise<Blob> {
    const { px } = exportSize(opts.multiplier ?? 1);
    this.lastExport = { px, withGarment: opts.withGarment === true };
    return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
  }
  exportLayers(): DesignLayer[] {
    return this.getLayers().filter((l) => l.visible);
  }
  async exportState(): Promise<EditorSnapshot> {
    const used = new Set(this.layers.map((l) => l.assetId).filter(Boolean));
    const assets = Object.fromEntries([...this.assets].filter(([id]) => used.has(id)));
    const state: FakeState = { layers: structuredClone(this.layers), counter: this.counter };
    return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, engine: this.engine, state, assets };
  }
  loadState(snapshot: EditorSnapshot): Promise<void> {
    return this.enqueue(async () => this.applyState(snapshot));
  }
  private applyState(snapshot: EditorSnapshot): void {
    assertSnapshot(snapshot, this.engine);
    const state = snapshot.state as FakeState;
    for (const l of state.layers) if (l.assetId && !snapshot.assets[l.assetId]) throw new Error(`A picture in this saved design is missing.`);
    this.layers = structuredClone(state.layers);
    this.assets = new Map(Object.entries(snapshot.assets));
    this.counter = state.counter;
    this.selected = null;
    this.resetHistory();
    this.emit();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onSelectionChange(listener: () => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.selectionListeners.clear();
  }

  // ---------------------------------------------------------------- layers
  getLayers(): DesignLayer[] {
    return this.layers.map(({ assetId: _a, style: _s, ...l }) => ({ ...l }));
  }
  private add(type: DesignLayer['type'], name: string, width: number, height: number, style: LayerStyle, assetId?: string): string {
    const id = `layer-${++this.counter}`;
    const c = DESIGN_SIZE / 2;
    this.layers.push({ id, type, name, x: c, y: c, width, height, rotation: 0, visible: true, locked: false, assetId, style });
    this.setSelected(id);
    this.commit();
    this.emit();
    return id;
  }
  addText(text: string): string {
    this.assertIdle();
    return this.add('text', text.slice(0, 24) || 'Text', 200, 60, {
      type: 'text', text, fontFamily: DEFAULT_FONT, fontSize: 64, fill: '#2c2825', textAlign: 'center', opacity: 1,
    });
  }
  addShape(kind: ShapeKind): string {
    this.assertIdle();
    return this.add('shape', kind[0]!.toUpperCase() + kind.slice(1), 200, kind === 'line' ? 10 : 200, {
      type: 'shape', shape: kind, fill: '#6b8f71', stroke: '#1a1714', strokeWidth: kind === 'line' ? 10 : 0, opacity: 1,
    });
  }
  async addImage(image: Blob, name = 'Picture'): Promise<string> {
    const info = await inspectImage(image);
    // placing the picture takes its turn after any undo, redo or load that is already working
    return this.enqueue(async () => {
      const assetId = `asset-${this.counter + 1}`;
      this.assets.set(assetId, image);
      return this.add('image', name, info.width, info.height, { type: 'image', opacity: 1 }, assetId);
    });
  }
  private find(id: string): Row {
    const row = this.layers.find((l) => l.id === id);
    if (!row) throw new Error(`No layer ${id}.`);
    return row;
  }
  updateLayer(id: string, patch: LayerPatch, opts: EditOptions = {}): void {
    this.assertIdle();
    const row = this.find(id);
    const touchesMore = Object.keys(patch).some((k) => k !== 'locked' && k !== 'visible');
    if (row.locked && patch.locked !== false && touchesMore) throw new LayerLockedError(row.name); // unlocking first is allowed
    const { position, size, rotation } = LAYER_LIMITS;
    if (patch.x !== undefined) patch = { ...patch, x: clamp(patch.x, position.min, position.max) };
    if (patch.y !== undefined) patch = { ...patch, y: clamp(patch.y, position.min, position.max) };
    if (patch.width !== undefined) patch = { ...patch, width: clamp(patch.width, size.min, size.max) };
    if (patch.height !== undefined) patch = { ...patch, height: clamp(patch.height, size.min, size.max) };
    if (patch.rotation !== undefined) patch = { ...patch, rotation: ((clamp(patch.rotation, rotation.min, rotation.max) % 360) + 360) % 360 };
    Object.assign(row, patch);
    this.afterEdit(opts);
  }
  moveLayer(id: string, direction: 'up' | 'down'): void {
    this.assertIdle();
    const i = this.layers.indexOf(this.find(id));
    const j = direction === 'up' ? i + 1 : i - 1;
    if (j < 0 || j >= this.layers.length) return;
    [this.layers[i], this.layers[j]] = [this.layers[j]!, this.layers[i]!];
    this.afterEdit({});
  }
  removeLayer(id: string): void {
    this.assertIdle();
    const row = this.find(id);
    if (row.locked) throw new LayerLockedError(row.name);
    this.layers.splice(this.layers.indexOf(row), 1);
    if (this.selected === id) this.setSelected(null);
    this.afterEdit({});
  }

  getStyle(id: string): LayerStyle {
    return structuredClone(this.find(id).style);
  }
  async updateStyle(id: string, patch: StylePatch, opts: EditOptions = {}): Promise<void> {
    this.assertIdle();
    const row = this.find(id);
    if (row.locked) throw new LayerLockedError(row.name);
    const s = row.style;
    if (s.type === 'text') {
      Object.assign(s, pick(patch, ['text', 'fontFamily', 'fontSize', 'fill', 'textAlign']));
      if (patch.text !== undefined) row.name = patch.text.slice(0, 24) || 'Text';
    } else if (s.type === 'shape') {
      const line = s.shape === 'line';
      Object.assign(s, pick(patch, line ? ['stroke', 'strokeWidth'] : ['fill', 'stroke', 'strokeWidth']));
      if (line && patch.fill !== undefined) s.stroke = s.fill = patch.fill; // a line's colour is its stroke
    }
    if (patch.opacity !== undefined) s.opacity = clamp(patch.opacity, 0, 1);
    this.afterEdit(opts);
  }

  select(id: string | null): void {
    this.assertIdle();
    if (id !== null) this.find(id);
    this.setSelected(id);
  }
  getSelection(): string | null {
    return this.selected;
  }
  private setSelected(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    for (const l of this.selectionListeners) l();
  }

  // ---------------------------------------------------------------- history
  private afterEdit(opts: EditOptions): void {
    if (opts.live) this.dirty = true;
    else this.commit();
    this.emit();
  }

  private capture(): Step {
    return {
      scene: JSON.stringify(this.layers),
      color: this.color,
      size: this.size,
      selection: this.selected,
      assetIds: [...new Set(this.layers.map((l) => l.assetId).filter((x): x is string => !!x))],
    };
  }
  private ref(step: Step) {
    for (const id of step.assetIds) this.refs.set(id, (this.refs.get(id) ?? 0) + 1);
  }
  private unref(step: Step) {
    for (const id of step.assetIds) {
      const left = (this.refs.get(id) ?? 1) - 1;
      if (left > 0) this.refs.set(id, left);
      else {
        this.refs.delete(id);
        if (!this.layers.some((l) => l.assetId === id)) this.assets.delete(id); // nothing refers to this picture any more
      }
    }
  }
  private resetHistory() {
    for (const s of this.history) this.unref(s);
    this.history = [];
    this.refs.clear();
    const base = this.capture();
    this.history.push(base);
    this.ref(base);
    this.cursor = 0;
    this.dirty = false;
    for (const id of [...this.assets.keys()]) if (!this.refs.has(id)) this.assets.delete(id);
  }
  private commit(): void {
    this.dirty = false;
    const step = this.capture();
    const cur = this.history[this.cursor];
    if (cur && cur.scene === step.scene && cur.color === step.color && cur.size === step.size) return;
    for (const dropped of this.history.splice(this.cursor + 1)) this.unref(dropped); // a new action discards the redo branch
    this.history.push(step);
    this.ref(step);
    this.cursor = this.history.length - 1;
    while (this.history.length > HISTORY_LIMIT + 1) {
      this.unref(this.history.shift()!);
      this.cursor--;
    }
  }
  commitEdit(): void {
    if (this.pending > 0) return; // a restore in flight has already settled any live edits
    if (this.dirty) {
      this.commit();
      this.emit();
    }
  }
  canUndo(): boolean {
    return this.cursor > 0 || this.dirty;
  }
  canRedo(): boolean {
    return this.cursor < this.history.length - 1;
  }
  private restore(step: Step) {
    this.layers = JSON.parse(step.scene) as Row[];
    this.color = step.color;
    this.size = step.size;
    this.dirty = false;
    this.setSelected(step.selection && this.layers.some((l) => l.id === step.selection) ? step.selection : null);
  }
  undo(): Promise<void> {
    return this.enqueue(async () => {
      this.commit(); // edits still in flight become a step first, so undo reverts them
      if (this.cursor <= 0) return;
      this.restore(this.history[--this.cursor]!);
      this.emit();
    });
  }
  redo(): Promise<void> {
    return this.enqueue(async () => {
      if (this.cursor >= this.history.length - 1) return;
      this.restore(this.history[++this.cursor]!);
      this.emit();
    });
  }
  historyStats(): HistoryStats {
    return {
      undoSteps: this.cursor,
      redoSteps: this.history.length - 1 - this.cursor,
      retainedAssets: this.assets.size,
      sceneChars: this.history.reduce((n, s) => n + s.scene.length, 0),
    };
  }

  // ---------------------------------------------------------------- view (zoom and pan): no history, no snapshot
  /** for tests: the view's size, as the real editor measures it from the page */
  setViewSize(width: number, height: number): void {
    this.view = resized(this.view, width, height);
    this.emitView();
  }
  getView(): ViewState {
    return toViewState(this.view);
  }
  zoomTo(zoom: number, anchor?: { x: number; y: number }): void {
    this.view = zoomAbout(this.view, zoom, anchor);
    this.emitView();
  }
  zoomBy(factor: number, anchor?: { x: number; y: number }): void {
    this.zoomTo(this.view.zoom * factor, anchor);
  }
  zoomFit(): void {
    this.view = fitted(this.view.width, this.view.height);
    this.emitView();
  }
  zoomActual(): void {
    this.zoomTo(1);
  }
  panBy(dx: number, dy: number): void {
    this.view = panned(this.view, dx, dy);
    this.emitView();
  }
  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }
  setPanMode(on: boolean): void {
    this.panMode = on;
    this.emitView();
  }
  getPanMode(): boolean {
    return this.panMode;
  }
  gestureSupport(): GestureSupport {
    return { pinch: true };
  }
  private emitView(): void {
    for (const l of this.viewListeners) l();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function pick<T extends object>(source: T, keys: Array<keyof T>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (source[k] !== undefined) out[k] = source[k];
  return out;
}
