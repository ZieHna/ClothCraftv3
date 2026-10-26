import { act, renderHook } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerCartLine } from '../api/types';
import { CART_SEEN_KEY, cartKeyFor, cartStore, cartV2KeyFor, FORGET_AFTER_MS, forgetIdleCarts, setServerCartForTests, useCart } from './cartStore';

/**
 * Step 12, the real shop's cart store (VITE_API=odoo), against a small fake of GET/PUT /api/cart that follows the service's rules: a
 * whole-cart PUT with the version last seen, an identical cart answers ok, another version is 409 cart_conflict with the cart now.
 */
class FakeShop {
  version = 0;
  lines: ServerCartLine[] = [];
  offline = false;
  gets = 0;
  puts = 0;
  conflicts = 0;
  set(lines: ServerCartLine[]) {
    this.lines = lines;
    this.version += 1;
  }
  /** what an order does on the server (_api_cart_take_ordered) */
  takeOrdered(sku: string, quantity: number) {
    const at = this.lines.find((l) => l.sku === sku && !l.designId);
    if (!at) return;
    this.lines = at.quantity <= quantity ? this.lines.filter((l) => l !== at) : this.lines.map((l) => (l === at ? { ...l, quantity: l.quantity - quantity, selected: false } : l));
    this.version += 1;
  }
  cart() {
    return { version: this.version, updatedAt: null, lines: this.lines.map((l) => ({ ...l })) };
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError('Failed to fetch');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(input) !== '/api/cart') return json(404, { error: { code: 'not_found', message: 'no' } });
    if ((init?.method ?? 'GET') === 'GET') {
      this.gets += 1;
      return json(200, { data: this.cart(), simulation: null });
    }
    this.puts += 1;
    const body = JSON.parse(String(init?.body)) as { baseVersion: number; lines: { sku: string; quantity: number; selected: boolean; designId?: string }[] };
    const wanted: ServerCartLine[] = body.lines.map((l) => ({ sku: l.sku, productId: `p-${l.sku}`, quantity: l.quantity, selected: l.selected, ...(l.designId ? { designId: l.designId } : {}) }));
    const same = JSON.stringify(wanted) === JSON.stringify(this.lines);
    if (!same && body.baseVersion !== this.version) {
      this.conflicts += 1;
      return json(409, { error: { code: 'cart_conflict', message: 'Your cart was changed in another tab or on another device.', cart: this.cart() } });
    }
    if (!same) this.set(wanted);
    return json(200, { data: this.cart(), simulation: null });
  };
}

const sv = (sku: string, quantity: number, selected = false): ServerCartLine => ({ sku, productId: `p-${sku}`, quantity, selected });
const shown = () => cartStore.get().lines.map((l) => `${l.sku}x${l.quantity}${l.selected ? '+' : ''}`);
const onServer = (shop: FakeShop) => shop.lines.map((l) => `${l.sku}x${l.quantity}${l.selected ? '+' : ''}`);
const settled = () => vi.waitFor(() => {
  const s = cartStore.getSync();
  expect(s.phase).toBe('ready');
  expect(s.pending).toBe(false);
}, { timeout: 5000 });

let shop: FakeShop;
beforeAll(() => setServerCartForTests(true));
afterAll(() => setServerCartForTests(false));
beforeEach(() => {
  localStorage.clear();
  shop = new FakeShop();
  vi.stubGlobal('fetch', vi.fn(shop.fetch));
});
afterEach(() => {
  cartStore.setOwner(null);
  vi.unstubAllGlobals();
});

describe('loading the saved cart', () => {
  it('shows nothing as the cart while loading (the badge has no number), then the account\'s cart', async () => {
    shop.set([sv('A', 2, true)]);
    localStorage.setItem(cartV2KeyFor('5'), JSON.stringify({ version: 0, base: [], lines: [], pending: false })); // an old copy: empty
    const { result } = renderHook(() => useCart());
    act(() => cartStore.setOwner('5'));
    expect(cartStore.getSync().phase).toBe('loading');
    expect(result.current.loading).toBe(true); // the page shows "Loading your cart…" and the badge no number
    await settled();
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.count).toBe(2);
    expect(shown()).toEqual(['Ax2+']);
    expect(JSON.parse(localStorage.getItem(cartV2KeyFor('5'))!).version).toBe(1); // this device's copy follows
  });

  it('an edit made while loading is merged with the saved cart, not lost and not overwriting it', async () => {
    shop.set([sv('A', 1)]);
    cartStore.setOwner('5');
    cartStore.add('B', 'p-B', 2);
    await settled();
    expect(shown()).toEqual(['Ax1', 'Bx2']);
    expect(onServer(shop)).toEqual(['Ax1', 'Bx2']);
  });
});

describe('saving', () => {
  it('edits close together are saved as one whole-cart PUT', async () => {
    cartStore.setOwner('5');
    await settled();
    cartStore.add('A', 'p-A', 1);
    cartStore.add('A', 'p-A', 1);
    cartStore.setSelected('A', true);
    expect(cartStore.getSync().pending).toBe(true);
    await settled();
    expect(shop.puts).toBe(1);
    expect(onServer(shop)).toEqual(['Ax2+']);
  });

  it('another tab or device saved first (409): the edits are merged into the newer cart and saved; a note says so', async () => {
    shop.set([sv('A', 1), sv('B', 1)]);
    cartStore.setOwner('5');
    await settled();
    shop.set([sv('A', 1, true), sv('B', 1), sv('C', 4)]); // elsewhere: A ticked, C added
    cartStore.setQuantity('A', 3); // here: A raised, B removed
    cartStore.remove('B');
    await settled();
    expect(shop.conflicts).toBe(1);
    expect(onServer(shop)).toEqual(['Ax3+', 'Cx4']);
    expect(shown()).toEqual(['Ax3+', 'Cx4']);
    expect(cartStore.getSync().conflict).toBe(true);
    cartStore.dismissNotes();
    expect(cartStore.getSync().conflict).toBe(false);
  });

  it('offline: the edit is kept on this device, the page is told, and it is saved when the connection is back', async () => {
    cartStore.setOwner('5');
    await settled();
    shop.offline = true;
    cartStore.add('A', 'p-A', 2);
    await vi.waitFor(() => expect(cartStore.getSync().offline).toBe(true), { timeout: 5000 });
    expect(cartStore.getSync().pending).toBe(true);
    expect(JSON.parse(localStorage.getItem(cartV2KeyFor('5'))!)).toMatchObject({ pending: true, lines: [{ sku: 'A', quantity: 2 }] });
    expect(await cartStore.flush(300)).toBe(false);
    shop.offline = false;
    window.dispatchEvent(new Event('online'));
    await settled();
    expect(cartStore.getSync().offline).toBe(false);
    expect(onServer(shop)).toEqual(['Ax2']);
  });

  it('an unsaved edit survives a reload (this device\'s copy) and is saved then', async () => {
    shop.set([sv('A', 1)]);
    localStorage.setItem(cartV2KeyFor('5'), JSON.stringify({ version: 1, base: [{ sku: 'A', productId: 'p-A', quantity: 1 }], lines: [{ sku: 'A', productId: 'p-A', quantity: 6 }], pending: true }));
    cartStore.setOwner('5');
    await settled();
    expect(onServer(shop)).toEqual(['Ax6']);
  });

  it('flush saves what is waiting at once and says whether it worked', async () => {
    cartStore.setOwner('5');
    await settled();
    cartStore.add('A', 'p-A', 1);
    expect(await cartStore.flush(2000)).toBe(true);
    expect(onServer(shop)).toEqual(['Ax1']);
  });
});

describe('after an order', () => {
  it('a pending local edit to a line the order just removed does not bring it back after the post-order merge', async () => {
    shop.set([sv('A', 2, true), sv('B', 1)]);
    cartStore.setOwner('5');
    await settled();
    // the customer raises A to 3, and the order is placed for 3 before that edit is saved (the saved cart still says 2)
    shop.offline = true;
    cartStore.setQuantity('A', 3);
    await vi.waitFor(() => expect(cartStore.getSync().offline).toBe(true), { timeout: 5000 });
    shop.offline = false;
    shop.takeOrdered('A', 3); // the order took A off the saved cart (2 <= 3: the whole line)
    cartStore.removeOrdered([{ sku: 'A', quantity: 3 }]);
    await settled();
    expect(shown()).toEqual(['Bx1']);
    expect(onServer(shop)).toEqual(['Bx1']);
  });

  it('the same with the edit still inside the save delay; and an order of less leaves the rest, unticked', async () => {
    shop.set([sv('A', 2, true), sv('B', 5, true)]);
    cartStore.setOwner('5');
    await settled();
    cartStore.setSelected('A', false); // a tick change waiting to be saved, on a line the order (from another tab) then takes
    cartStore.setQuantity('B', 6);
    shop.takeOrdered('A', 2);
    shop.takeOrdered('B', 5);
    cartStore.removeOrdered([{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 5 }]);
    await settled();
    expect(shown()).toEqual(['Bx1']);
    expect(onServer(shop)).toEqual(['Bx1']);
  });
});

describe('the cart this browser kept before step 12 (cc.cart.v1)', () => {
  it('an empty saved cart receives it; the old copy is removed once saved; a note counts the items', async () => {
    localStorage.setItem(cartKeyFor('5'), JSON.stringify([{ sku: 'A', productId: 'p-A', quantity: 2, selected: true }, { sku: 'B', productId: 'p-B', quantity: 1 }]));
    cartStore.setOwner('5');
    await settled();
    expect(onServer(shop)).toEqual(['Ax2+', 'Bx1']);
    expect(cartStore.getSync().added).toBe(2);
    expect(localStorage.getItem(cartKeyFor('5'))).toBeNull();
  });

  it('a non-empty saved cart is never overwritten: union, larger quantity, saved tick, a line only here added unticked', async () => {
    shop.set([sv('A', 1, true), sv('S', 2)]);
    localStorage.setItem(cartKeyFor('5'), JSON.stringify([{ sku: 'A', productId: 'p-A', quantity: 3 }, { sku: 'L', productId: 'p-L', quantity: 1, selected: true }]));
    cartStore.setOwner('5');
    await settled();
    expect(onServer(shop)).toEqual(['Ax3+', 'Sx2', 'Lx1']);
    expect(cartStore.getSync().added).toBe(2);
    expect(localStorage.getItem(cartKeyFor('5'))).toBeNull();
  });

  it('kept while it cannot be saved (offline), so nothing is lost', async () => {
    localStorage.setItem(cartKeyFor('5'), JSON.stringify([{ sku: 'A', productId: 'p-A', quantity: 2 }]));
    shop.offline = true;
    cartStore.setOwner('5');
    await vi.waitFor(() => expect(cartStore.getSync().offline).toBe(true), { timeout: 5000 });
    expect(localStorage.getItem(cartKeyFor('5'))).not.toBeNull();
  });
});

describe('sign-out and this device\'s copies', () => {
  it('sign-out keeps the account\'s cart, removes this device\'s copy when saved, and keeps it when edits could not be saved', async () => {
    cartStore.setOwner('5');
    await settled();
    cartStore.add('A', 'p-A', 1);
    await settled();
    cartStore.signOut();
    expect(localStorage.getItem(cartV2KeyFor('5'))).toBeNull();
    expect(onServer(shop)).toEqual(['Ax1']);
    expect(cartStore.get().lines).toEqual([]);

    cartStore.setOwner('5');
    await settled();
    expect(shown()).toEqual(['Ax1']); // signed in again: the cart is back
    shop.offline = true;
    cartStore.add('B', 'p-B', 1);
    await vi.waitFor(() => expect(cartStore.getSync().offline).toBe(true), { timeout: 5000 });
    cartStore.signOut();
    expect(JSON.parse(localStorage.getItem(cartV2KeyFor('5'))!)).toMatchObject({ pending: true });
  });

  it('copies of customers who have not signed in here for 30 days are removed (v1 and v2); others are kept', () => {
    const now = Date.UTC(2026, 9, 24);
    localStorage.setItem(cartKeyFor('old'), '[]');
    localStorage.setItem(cartV2KeyFor('old'), '{}');
    localStorage.setItem(cartV2KeyFor('recent'), '{}');
    localStorage.setItem(cartKeyFor('unknown'), '[]');
    localStorage.setItem(CART_SEEN_KEY, JSON.stringify({ old: now - FORGET_AFTER_MS - 1000, recent: now - 1000 }));
    forgetIdleCarts(now);
    expect(localStorage.getItem(cartKeyFor('old'))).toBeNull();
    expect(localStorage.getItem(cartV2KeyFor('old'))).toBeNull();
    expect(localStorage.getItem(cartV2KeyFor('recent'))).not.toBeNull();
    expect(localStorage.getItem(cartKeyFor('unknown'))).not.toBeNull(); // from before the rule: its 30 days start now
    expect(JSON.parse(localStorage.getItem(CART_SEEN_KEY)!)).toEqual({ recent: now - 1000, unknown: now });
    forgetIdleCarts(now + FORGET_AFTER_MS + 1);
    expect(localStorage.getItem(cartKeyFor('unknown'))).toBeNull();
  });
});
