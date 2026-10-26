import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CART_KEY, cartKeyFor, cartStore, lineKey, MAX_QUANTITY } from './cartStore';

// every test but the last group is one signed-in customer's cart
const OWNER = 'c-17';
const KEY = cartKeyFor(OWNER);
beforeEach(() => {
  localStorage.clear();
  cartStore.setOwner(null);
  cartStore.setOwner(OWNER);
});
afterEach(() => vi.restoreAllMocks());

describe('cart store', () => {
  it('adds a line, and adds quantities together for the same SKU', () => {
    cartStore.add('SKU-1', 'p1', 2);
    cartStore.add('SKU-2', 'p2');
    cartStore.add('SKU-1', 'p1', 3);
    expect(cartStore.get().lines).toEqual([
      { sku: 'SKU-1', productId: 'p1', quantity: 5 },
      { sku: 'SKU-2', productId: 'p2', quantity: 1 },
    ]);
  });

  it('keeps quantities whole and between 1 and the sanity limit', () => {
    cartStore.add('A', 'p', 1);
    cartStore.setQuantity('A', 0);
    expect(cartStore.get().lines[0].quantity).toBe(1);
    cartStore.setQuantity('A', 2.9);
    expect(cartStore.get().lines[0].quantity).toBe(2);
    cartStore.setQuantity('A', 5000);
    expect(cartStore.get().lines[0].quantity).toBe(MAX_QUANTITY);
    cartStore.setQuantity('A', Number.NaN);
    expect(cartStore.get().lines[0].quantity).toBe(1);
  });

  it('removes a line and puts it back where it was', () => {
    cartStore.add('A', 'p', 1);
    cartStore.add('B', 'p', 2);
    cartStore.add('C', 'p', 3);
    const removed = cartStore.get().lines[1];
    cartStore.remove('B');
    expect(cartStore.get().lines.map((l) => l.sku)).toEqual(['A', 'C']);
    cartStore.restore(removed, 1);
    expect(cartStore.get().lines.map((l) => l.sku)).toEqual(['A', 'B', 'C']);
    cartStore.restore(removed, 0); // already there: no duplicate
    expect(cartStore.get().lines).toHaveLength(3);
  });

  it('survives a reload: what is stored is read back, and it holds only sku, product and quantity (no price, no stock)', () => {
    cartStore.add('A', 'p1', 2);
    const stored = localStorage.getItem(KEY)!;
    expect(JSON.parse(stored)).toEqual([{ sku: 'A', productId: 'p1', quantity: 2 }]);
    expect(stored).not.toMatch(/price|stock|total|name/i);
    cartStore.reload();
    expect(cartStore.get().lines).toEqual([{ sku: 'A', productId: 'p1', quantity: 2 }]);
  });

  it('ignores a damaged cart in storage instead of crashing', () => {
    localStorage.setItem(KEY, '{not json');
    cartStore.reload();
    expect(cartStore.get().lines).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([{ sku: 'A', productId: 'p', quantity: 'many' }, { sku: 7 }, null, { sku: 'B', productId: 'p', quantity: 4 }, { sku: 'B', productId: 'p', quantity: 9 }]));
    cartStore.reload();
    expect(cartStore.get().lines).toEqual([{ sku: 'B', productId: 'p', quantity: 4 }]);
  });

  it('clear empties the cart and the stored copy', () => {
    cartStore.add('A', 'p', 2);
    cartStore.clear();
    expect(cartStore.get().lines).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
  });

  it('still works in memory when storage is blocked, and says so', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    cartStore.add('A', 'p', 2);
    expect(cartStore.get().lines).toEqual([{ sku: 'A', productId: 'p', quantity: 2 }]);
    expect(cartStore.get().storageBlocked).toBe(true);
    vi.restoreAllMocks();
    cartStore.add('B', 'p');
    expect(cartStore.get().storageBlocked).toBe(false);
  });

  it('reads a blocked store as an empty cart that reports the block', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    cartStore.reload();
    expect(cartStore.get()).toEqual({ lines: [], storageBlocked: true });
  });

  it('follows a change made in another tab (the storage event)', () => {
    const seen = vi.fn();
    const stop = cartStore.subscribe(seen);
    localStorage.setItem(KEY, JSON.stringify([{ sku: 'FROM-OTHER-TAB', productId: 'p', quantity: 3 }]));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(cartStore.get().lines).toEqual([{ sku: 'FROM-OTHER-TAB', productId: 'p', quantity: 3 }]);
    expect(seen).toHaveBeenCalled();
    stop();
  });

  it('tells its subscribers once per change and stops after unsubscribe', () => {
    const seen = vi.fn();
    const stop = cartStore.subscribe(seen);
    cartStore.add('A', 'p');
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    cartStore.add('B', 'p');
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('a cart belongs to one signed-in customer', () => {
  it('signed out there is no cart: it is empty, adding does nothing and nothing is stored', () => {
    cartStore.setOwner(null);
    cartStore.add('A', 'p', 2);
    expect(cartStore.get().lines).toEqual([]);
    expect(Object.keys(localStorage).filter((k) => k.startsWith(CART_KEY))).toEqual([]);
  });

  it('each customer has their own cart under their own key, and gets it back after signing in again', () => {
    cartStore.add('A', 'p', 2);
    cartStore.setOwner('c-99');
    expect(cartStore.get().lines).toEqual([]);
    cartStore.add('B', 'p', 1);
    expect(JSON.parse(localStorage.getItem(cartKeyFor('c-99'))!)).toEqual([{ sku: 'B', productId: 'p', quantity: 1 }]);
    cartStore.setOwner(OWNER);
    expect(cartStore.get().lines).toEqual([{ sku: 'A', productId: 'p', quantity: 2 }]);
  });

  it("another customer's cart changing in another tab is not this cart", () => {
    const seen = vi.fn();
    const stop = cartStore.subscribe(seen);
    localStorage.setItem(cartKeyFor('c-99'), JSON.stringify([{ sku: 'X', productId: 'p', quantity: 1 }]));
    window.dispatchEvent(new StorageEvent('storage', { key: cartKeyFor('c-99') }));
    expect(seen).not.toHaveBeenCalled();
    expect(cartStore.get().lines).toEqual([]);
    stop();
  });
});

describe('ticked lines (step 10)', () => {
  const ticked = () => cartStore.get().lines.filter((l) => l.selected).map((l) => lineKey(l));

  it('a new line starts unticked, and adding it again adds the quantity and keeps its tick', () => {
    cartStore.add('A', 'p', 1);
    cartStore.add('B', 'p', 1, { id: '7' });
    expect(ticked()).toEqual([]);
    cartStore.setSelected('A', true);
    cartStore.add('A', 'p', 2);
    cartStore.add('C', 'p', 1);
    expect(cartStore.get().lines).toEqual([
      { sku: 'A', productId: 'p', quantity: 3, selected: true },
      { sku: 'B', productId: 'p', quantity: 1, designId: '7' },
      { sku: 'C', productId: 'p', quantity: 1 },
    ]);
  });

  it('ticks and unticks one line, every line, or only one line', () => {
    for (const sku of ['A', 'B', 'C']) cartStore.add(sku, 'p');
    cartStore.setSelected('B', true);
    expect(ticked()).toEqual(['B']);
    cartStore.setAllSelected(true);
    expect(ticked()).toEqual(['A', 'B', 'C']);
    cartStore.selectOnly('C');
    expect(ticked()).toEqual(['C']);
    cartStore.setAllSelected(false);
    expect(ticked()).toEqual([]);
    // an unticked line is stored without the field
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([
      { sku: 'A', productId: 'p', quantity: 1 },
      { sku: 'B', productId: 'p', quantity: 1 },
      { sku: 'C', productId: 'p', quantity: 1 },
    ]);
  });

  it('a cart stored before step 10 reads as all unticked; only a real true ticks a line', () => {
    localStorage.setItem(KEY, JSON.stringify([
      { sku: 'OLD', productId: 'p', quantity: 2 },
      { sku: 'YES', productId: 'p', quantity: 1, selected: true },
      { sku: 'STR', productId: 'p', quantity: 1, selected: 'true' },
      { sku: 'ONE', productId: 'p', quantity: 1, selected: 1 },
    ]));
    cartStore.reload();
    expect(ticked()).toEqual(['YES']);
    expect(cartStore.get().lines[2]).toEqual({ sku: 'STR', productId: 'p', quantity: 1 });
  });

  it('ticks are kept per customer, across a reload and from another tab, and go with the cart on sign-out', () => {
    cartStore.add('A', 'p');
    cartStore.add('B', 'p');
    cartStore.setSelected('B', true);
    cartStore.reload();
    expect(ticked()).toEqual(['B']);
    cartStore.setOwner('c-99');
    expect(ticked()).toEqual([]);
    cartStore.setOwner(OWNER);
    expect(ticked()).toEqual(['B']);
    localStorage.setItem(KEY, JSON.stringify([{ sku: 'A', productId: 'p', quantity: 1, selected: true }, { sku: 'B', productId: 'p', quantity: 1 }]));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(ticked()).toEqual(['A']);
    cartStore.clear(); // what signing out does (AuthContext)
    cartStore.reload();
    expect(cartStore.get().lines).toEqual([]);
  });

  it('Edit design and Undo keep the tick', () => {
    cartStore.add('A', 'p', 1, { id: '7' });
    cartStore.setSelected('A#7', true);
    cartStore.replaceDesign('A#7', { id: '8' });
    expect(ticked()).toEqual(['A#8']);
    const line = cartStore.get().lines[0]!;
    cartStore.remove('A#8');
    cartStore.restore(line, 0);
    expect(ticked()).toEqual(['A#8']);
  });

  it('after an order only what was ordered goes; the rest stays as it was', () => {
    cartStore.add('A', 'p', 2);
    cartStore.add('B', 'p', 1, { id: '7' });
    cartStore.add('C', 'p', 1);
    cartStore.setSelected('A', true);
    cartStore.setSelected('B#7', true);
    const sent = cartStore.get().lines.filter((l) => l.selected);
    cartStore.removeOrdered(sent);
    expect(cartStore.get().lines).toEqual([{ sku: 'C', productId: 'p', quantity: 1 }]);
  });

  it('a quantity raised in another tab while the order was placed keeps the extra, unticked', () => {
    cartStore.add('A', 'p', 2);
    cartStore.add('B', 'p', 1);
    cartStore.setSelected('A', true);
    const sent = cartStore.get().lines.filter((l) => l.selected); // A × 2 is what the order holds
    localStorage.setItem(KEY, JSON.stringify([{ sku: 'A', productId: 'p', quantity: 5, selected: true }, { sku: 'B', productId: 'p', quantity: 1 }]));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    cartStore.removeOrdered(sent);
    expect(cartStore.get().lines).toEqual([{ sku: 'A', productId: 'p', quantity: 3 }, { sku: 'B', productId: 'p', quantity: 1 }]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(cartStore.get().lines);
  });

  it('remembers the line Proceed to checkout ticked on its own until a tick changes, it is dismissed, or the page reloads', () => {
    cartStore.add('A', 'p');
    cartStore.add('B', 'p', 1, { id: '7' });
    cartStore.selectOnly('B#7');
    expect(cartStore.justMade()).toBe('B#7');
    cartStore.dismissJustMade();
    expect(cartStore.justMade()).toBeNull();
    cartStore.selectOnly('B#7');
    cartStore.setSelected('A', true);
    expect(cartStore.justMade()).toBeNull();
    cartStore.selectOnly('B#7');
    cartStore.setOwner('c-99');
    expect(cartStore.justMade()).toBeNull();
  });
});
