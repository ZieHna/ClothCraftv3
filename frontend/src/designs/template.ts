import { SNAPSHOT_SCHEMA_VERSION, type EditorSnapshot } from '../editor/types';

/**
 * Loading a premade design into the editor. A template file is an editor snapshot written by the Simple editor itself (so every layer stays
 * an editable text, shape or picture layer), drawn inside a square FRAME of `frame` design units centred at (400, 400). Opening it on a
 * garment fits that frame into the garment's print box (the box the shop's print-fee settings report), so one file serves every garment it is
 * made for. Nothing here writes anywhere: the result is a fresh snapshot in memory that the editor loads as its own copy.
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TemplateFile {
  schemaVersion: number;
  engine: 'simple';
  /** the side of the square the art was drawn in, in design units, centred at (FRAME_CENTRE, FRAME_CENTRE) */
  frame: number;
  state: { objects: Record<string, unknown>[]; [key: string]: unknown };
  /** the pictures the layers use: asset id (as in `state`) -> file and type */
  assets: Record<string, { file: string; type: string }>;
}

export const FRAME_CENTRE = 400;
/** how much of the box the frame may fill (width, then height), and how high in the box its centre sits (a chest print, not the middle of the hem) */
const FILL_WIDTH = 0.62;
const FILL_HEIGHT = 0.52;
const CENTRE_HEIGHT = 0.44;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** A typical T-shirt's print box (the Men Crew Tee's), used when the garment's own box is not known (the mock shop has none, a garment that cannot be printed has none). */
export const DEFAULT_BOX: Box = { x: 87.49, y: 57.56, width: 620.63, height: 683.43 };

/** Where the frame goes: its centre and the scale, from the garment's print box (or DEFAULT_BOX). */
export function placement(box: Box | null, frame: number): { cx: number; cy: number; scale: number } {
  const b = box && box.width > 0 && box.height > 0 ? box : DEFAULT_BOX;
  const side = Math.min(b.width * FILL_WIDTH, b.height * FILL_HEIGHT);
  return { cx: b.x + b.width / 2, cy: b.y + b.height * CENTRE_HEIGHT, scale: side / frame };
}

/**
 * The template's scene with every layer moved and scaled into the box. Pure: the file's own state is not changed. Positions are centres
 * (the editor's state is centre-origin), a layer's scale is multiplied, and an outline that does not scale by itself (strokeUniform) is
 * multiplied too, so the design looks the same, only smaller or larger.
 */
export function fitState(state: TemplateFile['state'], frame: number, box: Box | null): TemplateFile['state'] {
  const { cx, cy, scale } = placement(box, frame);
  const objects = state.objects.map((o) => {
    const left = typeof o.left === 'number' ? cx + (o.left - FRAME_CENTRE) * scale : o.left;
    const top = typeof o.top === 'number' ? cy + (o.top - FRAME_CENTRE) * scale : o.top;
    const scaleX = typeof o.scaleX === 'number' ? o.scaleX * scale : o.scaleX;
    const scaleY = typeof o.scaleY === 'number' ? o.scaleY * scale : o.scaleY;
    const strokeWidth = o.strokeUniform === true && typeof o.strokeWidth === 'number' ? o.strokeWidth * scale : o.strokeWidth;
    return { ...o, left, top, scaleX, scaleY, strokeWidth };
  });
  return { ...state, objects };
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; blob(): Promise<Blob> }>;

function isTemplate(value: unknown): value is TemplateFile {
  const t = value as Partial<TemplateFile> | null;
  return (
    !!t &&
    t.engine === 'simple' &&
    t.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
    typeof t.frame === 'number' &&
    t.frame > 0 &&
    !!t.state &&
    Array.isArray(t.state.objects) &&
    !!t.assets &&
    typeof t.assets === 'object'
  );
}

export async function fetchTemplate(url: string, fetcher: Fetch = fetch as unknown as Fetch, signal?: AbortSignal): Promise<TemplateFile> {
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new TemplateError('That design could not be loaded.');
  const body = await response.json().catch(() => null);
  if (!isTemplate(body)) throw new TemplateError('That design file is damaged.');
  return body;
}

/** A snapshot the editor can load: the template fitted into the box, with its pictures fetched as blobs. A new object every time. */
export async function buildSnapshot(file: TemplateFile, box: Box | null, fetcher: Fetch = fetch as unknown as Fetch, signal?: AbortSignal): Promise<EditorSnapshot> {
  const assets: Record<string, Blob> = {};
  await Promise.all(
    Object.entries(file.assets).map(async ([id, asset]) => {
      const response = await fetcher(asset.file, { signal });
      if (!response.ok) throw new TemplateError('A picture of that design could not be loaded.');
      const blob = await response.blob();
      assets[id] = blob.type === asset.type ? blob : new Blob([blob], { type: asset.type });
    }),
  );
  return { schemaVersion: file.schemaVersion, engine: 'simple', state: fitState(file.state, file.frame, box), assets };
}
