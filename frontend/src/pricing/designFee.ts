/**
 * The print fee ESTIMATE of a customized garment, computed in the browser while editing (no server call). The shop's own figure comes
 * from the server (addons/clothcraft/design_fee.py), which is the same algorithm line by line; both are run against ONE shared file of
 * designs and expected results (addons/clothcraft/data/design_area_cases.json). Keep them in step. The rules are written out at the top
 * of design_fee.py: bounding box per element (element_outline), union by scanline, clipped to the garment, 2-decimal square inches.
 */
export const BAND = 0.25;
export const SIZE_STEPS: Record<string, number> = { XS: 0, S: 0, M: 1, L: 2, XL: 3, XXL: 4 };

export interface FeeElement {
  /** the CENTRE, design units */
  x: number;
  y: number;
  width: number;
  height: number;
  /** degrees, clockwise */
  rotation: number;
  visible?: boolean;
  opacity?: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Point = [number, number];

/** Half away from zero, as design_fee.round2 (Odoo's float_round), not banker's rounding. */
export function round2(value: number): number {
  return value ? Math.sign(value) * (Math.floor(Math.abs(value) * 100 + 0.5 + 1e-9) / 100) : 0;
}

/** THE bounding-box rule: the four corners of the element's box, rotated about its centre. Every element type uses this. */
export function elementOutline(e: FeeElement): Point[] {
  const hw = e.width / 2;
  const hh = e.height / 2;
  const angle = (e.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const).map(([dx, dy]): Point => [e.x + dx * cos - dy * sin, e.y + dx * sin + dy * cos]);
}

export const counts = (e: FeeElement) => (e.visible ?? true) && (e.opacity ?? 1) > 0 && e.width > 0 && e.height > 0;

/** Where a convex polygon crosses the horizontal line at y: [left, right], or null. */
function stretch(polygon: Point[], y: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [px, py] = polygon[i]!;
    const [qx, qy] = polygon[(i + 1) % polygon.length]!;
    if (py === qy) continue;
    if (Math.min(py, qy) <= y && y <= Math.max(py, qy)) {
      const x = px + ((y - py) * (qx - px)) / (qy - py);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** The covered area in design units squared (not rounded). */
export function coveredUnits(elements: FeeElement[], box: Box): number {
  // each outline with its top and bottom: a line outside them cannot cross it, so it is skipped (the same result, much faster)
  const outlines = elements.filter(counts).map((e) => {
    const polygon = elementOutline(e);
    const ys = polygon.map(([, y]) => y);
    return { polygon, top: Math.min(...ys), bottom: Math.max(...ys) };
  });
  if (outlines.length === 0) return 0;
  const left = box.x;
  const top = box.y;
  const right = left + box.width;
  const bottom = top + box.height;
  let total = 0;
  for (let i = 0; ; i++) {
    const y0 = top + i * BAND;
    if (y0 >= bottom) break;
    const y1 = Math.min(y0 + BAND, bottom);
    const y = (y0 + y1) / 2;
    const stretches: [number, number][] = [];
    for (const { polygon, top: ot, bottom: ob } of outlines) {
      if (y < ot || y > ob) continue;
      const s = stretch(polygon, y);
      if (!s) continue;
      const a = Math.max(s[0], left);
      const b = Math.min(s[1], right);
      if (b > a) stretches.push([a, b]);
    }
    if (stretches.length) {
      stretches.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      let [runA, runB] = stretches[0]!;
      let length = 0;
      for (const [a, b] of stretches.slice(1)) {
        if (a > runB) {
          length += runB - runA;
          [runA, runB] = [a, b];
        } else if (b > runB) runB = b;
      }
      length += runB - runA;
      total += length * (y1 - y0);
    }
  }
  return total;
}

export const coveredSqIn = (elements: FeeElement[], box: Box, referenceSqIn: number) => round2((coveredUnits(elements, box) * referenceSqIn) / (box.width * box.height));

/** 0 when nothing visible lands on the garment; otherwise area x rate + size step x steps, rounded to 2 decimals. */
export function feePerPiece(areaSqIn: number, rate: number, sizeStep: number, size: string): number {
  if (areaSqIn <= 0) return 0;
  return round2(areaSqIn * rate + sizeStep * (SIZE_STEPS[size] ?? 0));
}

export function estimate(elements: FeeElement[], box: Box, referenceSqIn: number, rate: number, sizeStep: number, size: string) {
  const area = coveredSqIn(elements, box, referenceSqIn);
  return { coveredSqIn: area, rate, sizeStep, steps: SIZE_STEPS[size] ?? 0, fee: feePerPiece(area, rate, sizeStep, size) };
}
