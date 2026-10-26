import type { DesignGeometry, DesignPricing, DesignState, DesignUpload } from '../api/types';
import { estimate, type FeeElement } from '../pricing/designFee';
import type { EditorSnapshot, SimpleEditorTools } from './types';

/** The print file's size: 3200 px square (4 × the 800-unit design square), as the plan says; Odoo accepts up to 4096. */
export const PRINT_MULTIPLIER = 4;

/** Every element as the server prices it: the layer list (centre, size, rotation, visibility) plus its opacity. */
export function geometryOf(editor: SimpleEditorTools): DesignGeometry[] {
  return editor.getLayers().map((l) => ({ id: l.id, x: l.x, y: l.y, width: l.width, height: l.height, rotation: l.rotation, visible: l.visible, opacity: editor.getStyle(l.id).opacity }));
}

/** The editor's estimate of the print fee per piece at the current size, the same rule as the shop's (src/pricing/designFee.ts). */
export function estimateFor(elements: FeeElement[], pricing: DesignPricing, size: string) {
  if (!pricing.box) return null;
  return estimate(elements, pricing.box, pricing.referenceSqIn, pricing.rate, pricing.sizeStep, size);
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('The picture could not be read.'));
    reader.readAsDataURL(blob);
  });
}

function blobOf(base64: string, type: string): Blob {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type });
}

/**
 * Everything one upload carries, taken from ONE scene: the caller has waited for the editor to be idle and holds input off while
 * this runs (the "Preparing your design…" cover), so the state, the element list and both pictures describe the same design.
 */
export async function buildUpload(editor: SimpleEditorTools, productId: string, sku: string): Promise<DesignUpload> {
  await editor.whenIdle();
  const snapshot = await editor.exportState();
  const layers = geometryOf(editor);
  const preview = await editor.exportPng({ withGarment: true, multiplier: 1 });
  const print = await editor.exportPng({ multiplier: PRINT_MULTIPLIER });
  const pictures = await Promise.all(Object.entries(snapshot.assets).map(async ([id, blob]) => ({ id, data: await base64Of(blob) })));
  return {
    schemaVersion: 1,
    productId,
    sku,
    state: JSON.stringify({ schemaVersion: snapshot.schemaVersion, engine: snapshot.engine, state: snapshot.state }),
    layers,
    pictures,
    preview: await base64Of(preview),
    print: await base64Of(print),
  };
}

/** About how many bytes the upload decodes to (what the shop's 20 MB budget counts). */
export const decodedBytes = (u: DesignUpload) => Math.floor(([u.preview, u.print, ...u.pictures.map((p) => p.data)].reduce((n, t) => n + t.length, 0) * 3) / 4) + u.state.length;

/** A cart design opened again ("Edit design"): the server's copy as an editor snapshot. */
export function snapshotFromServer(saved: DesignState): EditorSnapshot {
  const parsed = JSON.parse(saved.state) as { schemaVersion: number; engine: EditorSnapshot['engine']; state: unknown };
  return { schemaVersion: parsed.schemaVersion, engine: parsed.engine, state: parsed.state, assets: Object.fromEntries(saved.pictures.map((p) => [p.id, blobOf(p.data, p.type)])) };
}
