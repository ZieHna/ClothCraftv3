// View maths: zoom and pan of the design area inside a view, with no engine in it. Shared by the Fabric adapter and the
// fake, so the rules (limits, "stay under the pointer", keeping the design in view) are tested in one place.
import { DESIGN_SIZE, type ViewState } from './types';

export const MAX_ZOOM = 4; // 400%
const MIN_ZOOM_CEILING = 0.5; // 50%
/** how much one zoom button press or key press multiplies the zoom by */
export const ZOOM_STEP = 1.25;
/** a little air round the design when it is fitted */
const FIT_MARGIN = 0;

export interface ViewParams {
  width: number;
  height: number;
  zoom: number;
  panX: number;
  panY: number;
  /** while true the design stays fitted, whatever the view's size */
  atFit: boolean;
}

export const fitZoom = (width: number, height: number) => Math.max(0.01, (Math.min(width, height) - FIT_MARGIN * 2) / DESIGN_SIZE);

/** The zoom limits for a view: down to 50% (or the fit, when the view is small and the fit is below 50%), up to 400%. */
export const zoomLimits = (width: number, height: number) => {
  const fit = fitZoom(width, height);
  return { fit, min: Math.min(MIN_ZOOM_CEILING, fit), max: Math.max(MAX_ZOOM, fit) };
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Keeps the design in view: smaller than the view on an axis, it is centred on that axis; larger, its edges cannot
 * be pulled past the view's edges (no blank space opens up beside a zoomed design).
 */
export function clampPan(width: number, height: number, zoom: number, panX: number, panY: number): { panX: number; panY: number } {
  const size = DESIGN_SIZE * zoom;
  const axis = (view: number, pan: number) => (size <= view ? (view - size) / 2 : clamp(pan, view - size, 0));
  return { panX: axis(width, panX), panY: axis(height, panY) };
}

export const fitted = (width: number, height: number): ViewParams => {
  const zoom = fitZoom(width, height);
  return { width, height, zoom, ...clampPan(width, height, zoom, 0, 0), atFit: true };
};

/** Zoom to `zoom` (kept within the limits) so that the design point under `anchor` (view px) stays under it. */
export function zoomAbout(v: ViewParams, zoom: number, anchor = { x: v.width / 2, y: v.height / 2 }): ViewParams {
  if (!Number.isFinite(zoom) || zoom <= 0) return v; // nonsense in, no change out
  const { min, max, fit } = zoomLimits(v.width, v.height);
  const next = clamp(zoom, min, max);
  const designX = (anchor.x - v.panX) / v.zoom;
  const designY = (anchor.y - v.panY) / v.zoom;
  const pan = clampPan(v.width, v.height, next, anchor.x - designX * next, anchor.y - designY * next);
  return { ...v, zoom: next, ...pan, atFit: Math.abs(next - fit) < 1e-6 };
}

export function panned(v: ViewParams, dx: number, dy: number): ViewParams {
  const pan = clampPan(v.width, v.height, v.zoom, v.panX + dx, v.panY + dy);
  return { ...v, ...pan, atFit: v.atFit && v.zoom <= fitZoom(v.width, v.height) + 1e-6 };
}

/** The view after its size changed: still fitted if it was, otherwise the same zoom, kept in view. */
export function resized(v: ViewParams, width: number, height: number): ViewParams {
  if (v.atFit) return fitted(width, height);
  const { min, max } = zoomLimits(width, height);
  const zoom = clamp(v.zoom, min, max);
  return { width, height, zoom, ...clampPan(width, height, zoom, v.panX, v.panY), atFit: false };
}

export function toViewState(v: ViewParams): ViewState {
  const { fit, min, max } = zoomLimits(v.width, v.height);
  return { zoom: v.zoom, panX: v.panX, panY: v.panY, fitZoom: fit, minZoom: min, maxZoom: max, width: v.width, height: v.height, atFit: v.atFit };
}

/** the design point (design units) under a view point (px) */
export const viewToDesign = (v: ViewParams, x: number, y: number) => ({ x: (x - v.panX) / v.zoom, y: (y - v.panY) / v.zoom });
