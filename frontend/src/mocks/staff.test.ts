import { beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryDetails, OrderState, PaymentMethodId, PlaceOrderRequest } from '../api/types';
import { placeOrder, priceCart } from './shop';
import { catalogue, liveProducts, loadDb, resetDb, type MockOrder } from './shopDb';
import { cancelAsDemoStaff, DEMO_STAFF, detail, findStaff, list, NEXT, transition, type ListQuery } from './staff';

const GOOD: DeliveryDetails = {
  fullName: 'Juana Dela Cruz', email: 'juana@example.com', phone: '0917 123 4567', street: '12 Rizal Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: '',
};
const variants = catalogue.products.flatMap((p) => p.variants).filter((v) => v.stock >= 5 && v.status === 'in_stock');
let next = 0;
/** each order takes a variant of its own, so no test depends on another's stock */
function order(method: PaymentMethodId = 'cod', owner = 0): MockOrder {
  const lines = [{ sku: variants[next++].sku, quantity: 1 }];
  const request: PlaceOrderRequest = { lines, delivery: GOOD, paymentMethod: method, quotedTotal: priceCart(lines).total };
  const result = placeOrder(request, null, loadDb(), owner);
  if (result.status !== 201) throw new Error('could not place the test order');
  return loadDb().orders.find((o) => o.id === result.order.id)!;
}
const inv = (id: string, to: unknown, expected: unknown, note = '') => transition(id, 'inventory', 'Inv Person', { to, expectedState: expected, note });
const adm = (id: string, to: unknown, expected: unknown, note = '') => transition(id, 'admin', 'Admin Person', { to, expectedState: expected, note });
const stateOf = (id: string) => loadDb().orders.find((o) => o.id === id)!.state;
const query = (over: Partial<ListQuery> = {}): ListQuery => ({ states: [], method: null, from: null, to: null, q: '', page: 1, pageSize: 25, ...over });

beforeEach(() => {
  resetDb();
  next = 0;
});

describe('the demo staff accounts', () => {
  it('are two, an Inventory Staff and an Administrator, found by email in any case', () => {
    expect(DEMO_STAFF.map((s) => s.role).sort()).toEqual(['admin', 'inventory']);
    expect(findStaff(' INVENTORY.DEMO@clothcraft.test ')?.role).toBe('inventory');
    expect(findStaff('nobody@example.test')).toBeUndefined();
  });
});

describe('the moves, the same as the Odoo addon', () => {
  it('a cash-on-delivery order goes confirmed, packed, shipped, delivered, and cash is collected at the end', () => {
    const o = order('cod');
    expect(o.state).toBe('confirmed');
    expect(o.paid).toBe(false);
    for (const [from, to] of [['confirmed', 'packed'], ['packed', 'shipped'], ['shipped', 'delivered']] as const) {
      const r = inv(o.id, to, from);
      expect(r.status).toBe('done');
    }
    const done = loadDb().orders.find((x) => x.id === o.id)!;
    expect(done.state).toBe('delivered');
    expect(done.paid).toBe(true);
    expect(done.history.map((h) => `${h.from}>${h.to}`)).toEqual(['confirmed>packed', 'packed>shipped', 'shipped>delivered']);
    expect(done.history.every((h) => h.staff === 'Inv Person' && h.via === 'dashboard' && h.note === '')).toBe(true);
  });

  it('a bank-transfer order is paid when it is confirmed, and cannot skip a step', () => {
    const o = order('bank_transfer');
    expect(o.state).toBe('awaiting_payment');
    expect(inv(o.id, 'packed', 'awaiting_payment')).toMatchObject({ status: 'invalid_transition', current: 'awaiting_payment' });
    expect(loadDb().orders.find((x) => x.id === o.id)!.history).toHaveLength(0);
    expect(inv(o.id, 'confirmed', 'awaiting_payment').status).toBe('done');
    expect(loadDb().orders.find((x) => x.id === o.id)!.paid).toBe(true);
  });

  it('offers exactly the moves the table allows, with the labels the screen shows', () => {
    const o = order('cod');
    const d = detail(loadDb(), o, 'inventory');
    expect(d.allowed.map((a) => a.to)).toEqual(NEXT.confirmed);
    expect(d.allowed.map((a) => a.label)).toEqual(['Mark as packed', 'Cancel order']);
    expect(d.allowed.find((a) => a.to === 'cancelled')).toMatchObject({ confirm: true, needsNote: false });
    expect(d.blocked).toEqual([]);
    inv(o.id, 'packed', 'confirmed');
    inv(o.id, 'shipped', 'packed');
    const shipped = detail(loadDb(), loadDb().orders.find((x) => x.id === o.id)!, 'inventory');
    expect(shipped.allowed).toEqual([{ to: 'delivered', label: 'Mark as delivered (cash collected)', needsNote: false, confirm: false }]);
  });

  it('refuses a move out of delivered or cancelled, and a cancel once the goods have left, with the addon sentences', () => {
    const o = order('cod');
    inv(o.id, 'packed', 'confirmed');
    inv(o.id, 'shipped', 'packed');
    expect(inv(o.id, 'cancelled', 'shipped')).toMatchObject({ status: 'invalid_transition', message: "An order that is shipped can't be cancelled." });
    inv(o.id, 'delivered', 'shipped');
    expect(inv(o.id, 'cancelled', 'delivered')).toMatchObject({ status: 'invalid_transition', current: 'delivered', message: "This order is delivered. A delivered order can't be changed." });
    const c = order('cod');
    inv(c.id, 'cancelled', 'confirmed');
    expect(inv(c.id, 'confirmed', 'cancelled')).toMatchObject({ status: 'invalid_transition', message: "This order is cancelled. A cancelled order can't be changed." });
  });

  it('says what a move it cannot make could be instead', () => {
    const o = order('cod');
    expect(inv(o.id, 'delivered', 'confirmed')).toMatchObject({ status: 'invalid_transition', message: "An order that is confirmed can't be moved to delivered. From confirmed it can go to packed or cancelled." });
  });

  it('cancelling gives the stock back', () => {
    const sku = variants[next].sku;
    const before = liveProducts().flatMap((p) => p.variants).find((v) => v.sku === sku)!.stock;
    const o = order('cod');
    expect(liveProducts().flatMap((p) => p.variants).find((v) => v.sku === sku)!.stock).toBe(before - 1);
    inv(o.id, 'cancelled', 'confirmed');
    expect(liveProducts().flatMap((p) => p.variants).find((v) => v.sku === sku)!.stock).toBe(before);
  });
});

describe('cancelling a paid bank-transfer order', () => {
  const paid = () => {
    const o = order('bank_transfer');
    inv(o.id, 'confirmed', 'awaiting_payment');
    return o;
  };

  it('is for an Administrator only, and Inventory Staff are told why on the order', () => {
    const o = paid();
    expect(inv(o.id, 'cancelled', 'confirmed', 'please')).toMatchObject({ status: 'forbidden', current: 'confirmed', message: 'Only an Administrator can cancel an order that has been paid.' });
    const d = detail(loadDb(), loadDb().orders.find((x) => x.id === o.id)!, 'inventory');
    expect(d.blocked).toEqual([{ to: 'cancelled', label: 'Cancel order', reason: 'Only an Administrator can cancel an order that has been paid.' }]);
    const a = detail(loadDb(), loadDb().orders.find((x) => x.id === o.id)!, 'admin');
    expect(a.blocked).toEqual([]);
    expect(a.allowed.find((m) => m.to === 'cancelled')).toMatchObject({ needsNote: true, confirm: true });
  });

  it('needs a note of at least three characters, which the history keeps after REFUND DUE', () => {
    const o = paid();
    expect(adm(o.id, 'cancelled', 'confirmed')).toMatchObject({ status: 'invalid', fields: { note: expect.stringMatching(/refund has to be arranged/) } });
    expect(adm(o.id, 'cancelled', 'confirmed', 'ab').status).toBe('invalid');
    expect(stateOf(o.id)).toBe('confirmed');
    expect(adm(o.id, 'cancelled', 'confirmed', '  Finance refunds by transfer  ').status).toBe('done');
    const last = loadDb().orders.find((x) => x.id === o.id)!.history.at(-1)!;
    expect(last).toMatchObject({ from: 'confirmed', to: 'cancelled', staff: 'Admin Person', note: 'REFUND DUE. Finance refunds by transfer' });
  });

  it('an unpaid bank-transfer order is cancelled by Inventory Staff with no note, and the history has none', () => {
    const o = order('bank_transfer');
    expect(inv(o.id, 'cancelled', 'awaiting_payment').status).toBe('done');
    expect(loadDb().orders.find((x) => x.id === o.id)!.history[0].note).toBe('');
  });
});

describe('a screen that is out of date', () => {
  it('changes nothing, and answers with the order as it is and who changed it', () => {
    const o = order('cod');
    adm(o.id, 'packed', 'confirmed');
    const r = inv(o.id, 'packed', 'confirmed');
    expect(r).toMatchObject({ status: 'state_changed', current: 'packed' });
    if (r.status !== 'state_changed') throw new Error('not state_changed');
    expect(r.message).toBe('This order is now packed; it was changed by Admin Person. Nothing was done. Check it and try again.');
    expect(r.order.state).toBe('packed');
    expect(r.order.history).toHaveLength(1);
    expect(loadDb().orders.find((x) => x.id === o.id)!.history).toHaveLength(1);
  });

  it('the second of two identical requests sent one after the other is the loser', () => {
    const o = order('cod');
    const results = [inv(o.id, 'packed', 'confirmed'), inv(o.id, 'packed', 'confirmed')].map((r) => r.status);
    expect(results).toEqual(['done', 'state_changed']);
  });
});

describe('what is not a move at all', () => {
  it('an unknown target or state is a 422 on "to", a long note a 422 on "note", an unknown order a not-found', () => {
    const o = order('cod');
    expect(inv(o.id, 'banana', 'confirmed')).toMatchObject({ status: 'invalid', fields: { to: 'Choose what to do with the order.' } });
    expect(inv(o.id, 'packed', 'banana').status).toBe('invalid');
    expect(inv(o.id, 'packed', 'confirmed', 'x'.repeat(501))).toMatchObject({ status: 'invalid', fields: { note: 'Keep the note to 500 characters or fewer.' } });
    expect(inv('99999', 'packed', 'confirmed').status).toBe('not_found');
    expect(stateOf(o.id)).toBe('confirmed');
  });
});

describe('the list', () => {
  const states = (r: ReturnType<typeof list>) => (r.status === 'ok' ? r.orders.map((o) => o.state) : []);

  it('shows the newest first, and the summary the table needs', () => {
    const a = order('cod', 7);
    const b = order('bank_transfer', 7);
    const r = list(loadDb(), query());
    if (r.status !== 'ok') throw new Error('list failed');
    expect(r.orders.map((o) => o.id)).toEqual([b.id, a.id]);
    expect(r.orders[0]).toEqual({
      id: b.id, reference: b.reference, state: 'awaiting_payment', paymentMethod: 'bank_transfer', paid: false, customer: { name: 'Juana Dela Cruz', email: 'juana@example.com' },
      total: b.total, itemCount: 1, createdAt: b.createdAt, statusChangedAt: b.createdAt,
    });
  });

  it('filters by one or several states and by payment method', () => {
    const a = order('cod');
    order('bank_transfer');
    inv(a.id, 'packed', 'confirmed');
    expect(states(list(loadDb(), query({ states: ['packed'] })))).toEqual(['packed']);
    expect(states(list(loadDb(), query({ states: ['packed', 'awaiting_payment'] }))).sort()).toEqual(['awaiting_payment', 'packed']);
    expect(states(list(loadDb(), query({ method: 'bank_transfer' })))).toEqual(['awaiting_payment']);
    expect(states(list(loadDb(), query({ states: ['delivered'] })))).toEqual([]);
  });

  it('searches the reference, the customer name and email, and the delivery name, in any case', () => {
    const o = order('cod');
    order('cod');
    const total = (q: string) => {
      const r = list(loadDb(), query({ q }));
      return r.status === 'ok' ? r.total : -1;
    };
    expect(total(o.reference.toLowerCase())).toBe(1);
    expect(total('JUANA')).toBe(2);
    expect(total('juana@example')).toBe(2);
    expect(total('no such person')).toBe(0);
  });

  it('filters by the day the order was placed, inclusive, and refuses a date that is not one', () => {
    order('cod');
    const day = new Date().toISOString().slice(0, 10);
    const total = (from: string | null, to: string | null) => {
      const r = list(loadDb(), query({ from, to }));
      return r.status === 'ok' ? r.total : r.code;
    };
    expect(total(day, day)).toBe(1);
    expect(total('2999-01-01', null)).toBe(0);
    expect(total(null, '2000-01-01')).toBe(0);
    expect(total('31-10-2026', null)).toBe('bad_date');
    expect(total('2026-02-31', null)).toBe('bad_date');
  });

  it('pages: a page of one, the next page the next order, and a page past the end empty', () => {
    const ids = [order('cod').id, order('cod').id, order('cod').id].reverse();
    const page = (n: number) => {
      const r = list(loadDb(), query({ page: n, pageSize: 1 }));
      return r.status === 'ok' ? r.orders.map((o) => o.id) : [];
    };
    expect([page(1), page(2), page(3), page(4)]).toEqual([[ids[0]], [ids[1]], [ids[2]], []]);
    const r = list(loadDb(), query({ pageSize: 1000 }));
    expect(r.status === 'ok' && r.pageSize).toBe(100);
  });
});

describe('the customer never sees what only staff see', () => {
  it('the demo "pretend staff cancelled" button is a move by a pretend staff member, with a history line', () => {
    const o = order('bank_transfer');
    expect(cancelAsDemoStaff(o.id)?.state).toBe('cancelled');
    expect(loadDb().orders.find((x) => x.id === o.id)!.history[0]).toMatchObject({ from: 'awaiting_payment', to: 'cancelled', staff: 'Demo staff', via: 'dashboard' });
    expect(cancelAsDemoStaff('999')).toBeUndefined();
  });

  it('every state is reachable and has a word', () => {
    const states: OrderState[] = ['awaiting_payment', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];
    expect(Object.keys(NEXT).sort()).toEqual([...states].sort());
  });
});
