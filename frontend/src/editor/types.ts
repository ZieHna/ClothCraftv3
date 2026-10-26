/** Engine-neutral editor contract. Nothing here may mention Fabric, Photopea or any other engine's types. */

export type EditorMode = 'simple' | 'pro';

export const DEFAULT_MODE: EditorMode = 'simple';
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Reads the ?mode= value. Anything that is not exactly "pro" (missing, empty, unknown) is "simple". */
export function parseMode(raw: string | null | undefined): EditorMode {
  return raw === 'pro' ? 'pro' : DEFAULT_MODE;
}

export type LayerType = 'text' | 'image' | 'shape';

/**
 * One leaf layer, in design units (the design area is DESIGN_SIZE square, origin at its top-left).
 * NOTE: x and y are the CENTRE of the layer, not its top-left corner. Rotating a layer does not move its centre.
 * width and height are the size before rotation.
 */
export interface DesignLayer {
  id: string;
  type: LayerType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** degrees, clockwise */
  rotation: number;
  visible: boolean;
  locked: boolean;
}

export type LayerPatch = Partial<Omit<DesignLayer, 'id' | 'type'>>;

/** The design area, in design units, for every engine. */
export const DESIGN_SIZE = 800;

/**
 * The garment the design is printed on. A locked background: never a layer.
 * `color` is a colour id such as "navy". `image` is the picture for that colour. `colorImages` gives the picture for
 * every colour the product comes in (colour id -> URL), so setColor() can swap pictures without asking anyone.
 */
export interface GarmentBase {
  image: string;
  color: string;
  size: string;
  colorImages?: Record<string, string>;
}

/**
 * Everything needed to restore a design in the SAME engine. `state` is opaque to everyone but the engine that wrote it,
 * and refers to images only by asset id. The image bytes live in `assets` as Blobs (never base64 in `state`), so a later
 * draft store can put them in IndexedDB as they are. A snapshot is never converted between engines.
 */
export interface EditorSnapshot {
  schemaVersion: number;
  engine: EditorMode;
  state: unknown;
  assets: Record<string, Blob>;
}

export class EngineMismatchError extends Error {
  constructor(
    readonly expected: EditorMode,
    readonly received: unknown,
  ) {
    super(
      `This design was made in the ${String(received)} editor and cannot be opened in the ${expected} editor. Designs cannot be moved between Simple and Pro.`,
    );
    this.name = 'EngineMismatchError';
  }
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** Throws unless `value` is a snapshot written by `engine` at a schema version this build understands. */
export function assertSnapshot(value: unknown, engine: EditorMode): asserts value is EditorSnapshot {
  if (typeof value !== 'object' || value === null) throw new SnapshotError('That is not a saved design.');
  const s = value as Partial<EditorSnapshot>;
  if (s.engine !== engine) throw new EngineMismatchError(engine, s.engine);
  if (s.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotError(`This design uses format version ${String(s.schemaVersion)}, which this editor cannot open.`);
  }
  if (typeof s.state !== 'object' || s.state === null || typeof s.assets !== 'object' || s.assets === null) {
    throw new SnapshotError('That saved design is damaged.');
  }
  for (const blob of Object.values(s.assets)) if (!(blob instanceof Blob)) throw new SnapshotError('That saved design is damaged.');
}

export interface ExportPngOptions {
  /** draw the garment under the design (default false: the design alone, transparent background) */
  withGarment?: boolean;
  /** output scale: 1 gives DESIGN_SIZE pixels square */
  multiplier?: number;
}

/**
 * The CORE contract: what every editor engine must do, so that the rest of the app (garment, export, save and load)
 * never depends on which engine is running. A future Photopea engine satisfies this and nothing more.
 */
export interface DesignEditor {
  readonly engine: EditorMode;

  /** Show the garment as a locked background. Not a layer: not selectable, not deletable, not in any layer list. */
  loadBase(garment: GarmentBase): Promise<void>;
  /** Swap to the pre-coloured picture of this colour (colour id). Throws when the garment has no picture for it. */
  setColor(color: string): void;
  setSize(size: string): void;

  exportPng(opts?: ExportPngOptions): Promise<Blob>;
  /** visible leaf layers only, bottom to top; never the garment */
  exportLayers(): DesignLayer[];
  exportState(): Promise<EditorSnapshot>;
  /** Rejects a wrong engine or schema version, and leaves the current design untouched when it rejects. */
  loadState(snapshot: EditorSnapshot): Promise<void>;

  /** Fires after any change to the design or the garment. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
  /** Releases the engine and removes its elements. Safe to call more than once. */
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Simple engine's tools. These are NOT part of the core contract: a Pro engine has its own tools inside its own UI.

export type ShapeKind = 'rectangle' | 'circle' | 'triangle' | 'star' | 'line';
export const SHAPE_KINDS: readonly ShapeKind[] = ['rectangle', 'circle', 'triangle', 'star', 'line'];

export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  type: 'text';
  text: string;
  /** a family from FONT_LIST (src/editor/fonts.ts) */
  fontFamily: string;
  /** design units */
  fontSize: number;
  /** #rrggbb */
  fill: string;
  textAlign: TextAlign;
  /** 0 to 1 */
  opacity: number;
}
export interface ShapeStyle {
  type: 'shape';
  shape: ShapeKind;
  /** #rrggbb; ignored by a line, whose colour is its stroke */
  fill: string;
  /** #rrggbb */
  stroke: string;
  /** design units; 0 means no outline (a line always has some) */
  strokeWidth: number;
  opacity: number;
}
export interface ImageStyle {
  type: 'image';
  opacity: number;
}
export type LayerStyle = TextStyle | ShapeStyle | ImageStyle;
/** A patch to a layer's style. Properties that do not apply to the layer's type are ignored. */
export type StylePatch = Partial<Omit<TextStyle, 'type'> & Omit<ShapeStyle, 'type' | 'opacity' | 'shape'>>;

/**
 * Thrown by an editing call made while undo, redo or a load is still working (pictures are decoded again, which takes
 * a moment). Nothing is changed. The editor screen never shows this to a person: it holds the action until the editor
 * is idle (see whenIdle) and then runs it, in order.
 */
export class EditorBusyError extends Error {
  constructor() {
    super('The editor is still finishing your last undo or redo. One moment.');
    this.name = 'EditorBusyError';
  }
}

/** The longest side of an exported picture, in pixels. A larger multiplier is lowered to fit. */
export const MAX_EXPORT_PX = 4096;

/** The multiplier and pixel size an export really gets for the one asked for (never above MAX_EXPORT_PX, never below 1 px). */
export function exportSize(multiplier: number): { multiplier: number; px: number } {
  const wanted = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  const px = Math.max(1, Math.min(MAX_EXPORT_PX, Math.round(DESIGN_SIZE * wanted)));
  return { multiplier: px / DESIGN_SIZE, px };
}

/**
 * What is shown of the design: zoom (screen px per design unit, so 1 is "100%") and where the design sits in the view.
 * View state is NOT design state: it is not in the history, not in a snapshot, and never changes an exported pixel.
 */
export interface ViewState {
  zoom: number;
  /** where the design area's top-left corner is, in view px */
  panX: number;
  panY: number;
  /** the zoom at which the whole design area just fits the view */
  fitZoom: number;
  minZoom: number;
  maxZoom: number;
  /** the view's size in CSS px */
  width: number;
  height: number;
  /** true while the whole design is fitted (it then stays fitted when the view is resized) */
  atFit: boolean;
}

export interface GestureSupport {
  /** two-finger pinch/rotate of a selected layer works; if false the numeric fields and buttons remain */
  pinch: boolean;
  reason?: string;
}

/** A locked layer cannot be moved, resized, restyled, renamed or deleted. It can be unlocked, shown or hidden, and reordered. */
export class LayerLockedError extends Error {
  constructor(readonly layerName: string) {
    super(`"${layerName}" is locked. Unlock it to change it.`);
    this.name = 'LayerLockedError';
  }
}

/** The most undo steps kept. The oldest step is forgotten (and pictures only it used are released) beyond this. */
export const HISTORY_LIMIT = 100;

/** Ranges for the numeric fields; the editor also clamps to them. Design units (px of the design area). */
export const LAYER_LIMITS = {
  position: { min: -400, max: 1200 },
  size: { min: 1, max: 4000 },
  rotation: { min: -360, max: 360 },
} as const;

/**
 * `live: true` applies a change to the design without recording a history step, for edits that arrive as a stream
 * (typing in a field, dragging a slider). Call commitEdit() when the stream ends: all the live changes since the
 * last step become ONE step. Without `live`, the change is its own step.
 */
export interface EditOptions {
  live?: boolean;
}

export interface HistoryStats {
  /** how many times undo() can be called */
  undoSteps: number;
  /** how many times redo() can be called */
  redoSteps: number;
  /** pictures still held because some step refers to them (the rest were released) */
  retainedAssets: number;
  /** characters of scene JSON held across all steps: the memory the history itself costs (pictures excluded) */
  sceneChars: number;
}

export interface SimpleEditorTools extends DesignEditor {
  /** every layer, hidden ones included, bottom to top; never the garment */
  getLayers(): DesignLayer[];
  addText(text: string): string;
  addShape(kind: ShapeKind): string;
  /**
   * Adds a picture. Only PNG, JPEG and WebP are accepted, judged by the file's own bytes (see upload.ts), within the
   * size limits; anything else rejects with an UploadError and changes nothing. Large pictures are shrunk first.
   */
  addImage(image: Blob, name?: string): Promise<string>;
  /** Throws LayerLockedError when the layer is locked and the patch changes more than `locked` or `visible` (a patch that sets locked: false may change anything). */
  updateLayer(id: string, patch: LayerPatch, opts?: EditOptions): void;
  /** move one step towards the top ("up") or the bottom ("down"); allowed on a locked layer */
  moveLayer(id: string, direction: 'up' | 'down'): void;
  /** Throws LayerLockedError when the layer is locked. */
  removeLayer(id: string): void;

  // Properties of one layer (font, size, colour, alignment, fill, stroke, opacity, the text itself).
  getStyle(id: string): LayerStyle;
  /** Throws (rejects with) LayerLockedError when the layer is locked. */
  updateStyle(id: string, patch: StylePatch, opts?: EditOptions): Promise<void>;

  // Selection (what the panels show). Any layer, locked or hidden, can be selected from a list; only unlocked, visible
  // ones can be picked or dragged on the canvas.
  select(id: string | null): void;
  getSelection(): string | null;
  onSelectionChange(listener: () => void): () => void;

  // The garment, as the design currently has it (changes to it are history steps too).
  getGarment(): { color: string; size: string };

  // History. One step per user action: add, move/resize/rotate (one per drag), delete, reorder, hide, lock, style edits,
  // and the garment's colour and size. A new action after an undo discards what could have been redone.
  undo(): Promise<void>;
  redo(): Promise<void>;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Ends a stream of `live` edits: they become one step. Does nothing when nothing changed. */
  commitEdit(): void;
  // Busy state. Undo, redo and loading take turns (one queue). While any of them is working, editing calls throw
  // EditorBusyError instead of changing a scene that is about to be replaced. Callers that must not lose input wait
  // for whenIdle() and then act: the editor screen does exactly that, so nothing a person does is dropped.
  isBusy(): boolean;
  whenIdle(): Promise<void>;

  // View (zoom and pan). Not history, not in snapshots, never in exports. Limits: min(50%, fit) to 400%.
  getView(): ViewState;
  /** anchor: a point in the view (px) that stays where it is; default the centre of the view */
  zoomTo(zoom: number, anchor?: { x: number; y: number }): void;
  zoomBy(factor: number, anchor?: { x: number; y: number }): void;
  zoomFit(): void;
  /** 100%: one design unit is one screen px (kept within the limits) */
  zoomActual(): void;
  panBy(dx: number, dy: number): void;
  onViewChange(listener: () => void): () => void;
  /** the hand tool: while on, dragging the canvas pans instead of selecting */
  setPanMode(on: boolean): void;
  getPanMode(): boolean;
  /** what the touch gestures can do in this browser (feature-detected at start-up) */
  gestureSupport(): GestureSupport;

  /** For tests and diagnostics. */
  historyStats(): HistoryStats;
}
