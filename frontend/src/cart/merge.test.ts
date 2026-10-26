import { describe, expect, it } from 'vitest';
import type { CartLine } from './line';
import { adoptDeviceCart, mergeCarts, sameLines, takeOrdered } from './merge';

const line = (sku: string, quantity: number, extra: Partial<CartLine> = {}): CartLine => ({ sku, productId: `p-${sku}`, quantity, ...extra });
const T = { selected: true } as const;

describe('mergeCarts (this device, the saved cart, and what both started from)', () => {
  it('a line added on either side is kept; on both, the larger quantity, ticked if either ticked it', () => {
    const merged = mergeCarts([line('A', 1)], [line('A', 1), line('L', 2)], [line('A', 1), line('S', 3, T)]);
    expect(merged).toEqual([line('A', 1), line('S', 3, T), line('L', 2)]);
    expect(mergeCarts([], [line('X', 2)], [line('X', 4, T)])).toEqual([line('X', 4, T)]);
  });

  it('each field takes the side that changed it: quantity here, tick there, both kept', () => {
    expect(mergeCarts([line('A', 1)], [line('A', 5)], [line('A', 1, T)])).toEqual([line('A', 5, T)]);
    expect(mergeCarts([line('A', 1, T)], [line('A', 1)], [line('A', 3, T)])).toEqual([line('A', 3)]);
  });

  it('removed on one side and unchanged on the other: gone', () => {
    expect(mergeCarts([line('A', 1), line('B', 1)], [line('A', 1)], [line('A', 1), line('B', 1)])).toEqual([line('A', 1)]);
    expect(mergeCarts([line('A', 1), line('B', 1)], [line('A', 1), line('B', 1)], [line('B', 1)])).toEqual([line('B', 1)]);
  });

  it('removed on one side but its quantity changed on the other: the edit is kept (nothing is lost)', () => {
    expect(mergeCarts([line('A', 1)], [line('A', 4)], [])).toEqual([line('A', 4)]);
    expect(mergeCarts([line('A', 1)], [], [line('A', 2)])).toEqual([line('A', 2)]);
  });

  it('a tick alone never brings back a line the other side removed', () => {
    expect(mergeCarts([line('A', 2, T)], [line('A', 2)], [])).toEqual([]);
    expect(mergeCarts([line('A', 2)], [], [line('A', 2, T)])).toEqual([]);
  });

  it('a designed line is its own line, and keeps this device\'s estimate', () => {
    const designed = line('A', 1, { designId: '7', estimate: 120 });
    const merged = mergeCarts([], [designed], [line('A', 2), { ...line('A', 1), designId: '7' }]);
    expect(merged).toEqual([line('A', 2), designed]);
  });
});

describe('adoptDeviceCart (the cart this browser kept before step 12)', () => {
  it('an empty saved cart receives this device\'s cart as it is, ticks included', () => {
    expect(adoptDeviceCart([], [line('A', 2, T), line('B', 1)])).toEqual({ lines: [line('A', 2, T), line('B', 1)], added: 2 });
  });

  it('both non-empty: the union; the same line takes the larger quantity and the saved tick; a line only here is added unticked', () => {
    const { lines, added } = adoptDeviceCart([line('A', 1, T), line('S', 2)], [line('A', 3), line('L', 1, T)]);
    expect(lines).toEqual([line('A', 3, T), line('S', 2), line('L', 1)]);
    expect(added).toBe(2);
  });

  it('a saved line with more than this device had is never lowered', () => {
    expect(adoptDeviceCart([line('A', 5)], [line('A', 2)])).toEqual({ lines: [line('A', 5)], added: 0 });
  });
});

describe('takeOrdered and sameLines', () => {
  it('a line ordered in full goes; one with more keeps the rest, unticked', () => {
    expect(takeOrdered([line('A', 2, T), line('B', 5, T), line('C', 1)], [{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 3 }])).toEqual([line('B', 2), line('C', 1)]);
  });

  it('compares keys, quantities, ticks and order, never estimates', () => {
    expect(sameLines([line('A', 1, { designId: '2', estimate: 5 })], [{ ...line('A', 1), designId: '2' }])).toBe(true);
    expect(sameLines([line('A', 1)], [line('A', 1, T)])).toBe(false);
    expect(sameLines([line('A', 1), line('B', 1)], [line('B', 1), line('A', 1)])).toBe(false);
  });
});
