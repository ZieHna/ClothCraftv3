import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coveredSqIn, coveredUnits, elementOutline, estimate, feePerPiece, round2, SIZE_STEPS, type Box, type FeeElement } from './designFee';

// ONE file of designs and expected results, shared with the server (addons/clothcraft/tests/test_design_fee.py); "units" was computed by
// the Python implementation, so agreeing with it within 1e-6 means the two implementations agree.
interface Shared {
  tolerance: { implementationsUnits: number; analyticSqIn: number };
  box: Box;
  referenceSqIn: number;
  rate: number;
  sizeStep: number;
  cases: { name: string; elements: FeeElement[]; analyticUnits: number; units: number; coveredSqIn: number; fees: Record<string, number>; quantity2LineTotal: number }[];
}
const shared: Shared = JSON.parse(readFileSync(resolve(__dirname, '../../../addons/clothcraft/data/design_area_cases.json'), 'utf8'));

describe('design fee: shared cases', () => {
  it.each(shared.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const units = coveredUnits(c.elements, shared.box);
    expect(Math.abs(units - c.units)).toBeLessThanOrEqual(shared.tolerance.implementationsUnits);
    const area = coveredSqIn(c.elements, shared.box, shared.referenceSqIn);
    expect(area).toBe(c.coveredSqIn);
    const exact = (c.analyticUnits * shared.referenceSqIn) / (shared.box.width * shared.box.height);
    expect(Math.abs(area - exact)).toBeLessThanOrEqual(shared.tolerance.analyticSqIn);
    for (const size of Object.keys(SIZE_STEPS)) expect(feePerPiece(area, shared.rate, shared.sizeStep, size)).toBe(c.fees[size]);
    expect(round2(c.fees.M! * 2)).toBe(c.quantity2LineTotal);
  });
});

describe('design fee: rules', () => {
  it('prices every element by its rotated bounding box (one function)', () => {
    const corners = elementOutline({ x: 0, y: 0, width: 2, height: 2, rotation: 90 }).map(([x, y]) => [Math.round(x), Math.round(y)]);
    expect(corners).toEqual([[1, -1], [1, 1], [-1, 1], [-1, -1]]);
  });

  it('charges nothing when nothing lands on the garment, even for XXL', () => {
    expect(estimate([], shared.box, 200, 2, 20, 'XXL').fee).toBe(0);
  });

  it('rounds half away from zero like the server', () => {
    expect(round2(0.125)).toBe(0.13);
    expect(round2(2.675)).toBe(2.68);
  });
});
