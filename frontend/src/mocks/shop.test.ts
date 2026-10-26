import { beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryDetails, PlaceOrderRequest, Product, Variant } from '../api/types';
import { EMPTY_DELIVERY, validateDelivery } from '../lib/deliveryRules';
import { MOCK_PROVINCES } from './provinces';
import { cancelOrder, checkoutOptions, mergeLines, placeOrder, priceCart, vatPortion, VAT_ROUNDING, type PlaceResult } from './shop';
import { catalogue, DB_KEY, liveProducts, loadDb, resetDb } from './shopDb';

const GOOD: DeliveryDetails = {
  fullName: 'Juana Dela Cruz', email: 'juana@example.com', phone: '0917 123 4567', street: '12 Rizal Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: '',
};

const all: { product: Product; variant: Variant }[] = catalogue.products.flatMap((product) => product.variants.map((variant) => ({ product, variant })));
/** a variant with plenty in stock, one that is sold out, and one that is low (1 or 2 left) */
const plenty = all.find((x) => x.variant.stock >= 5 && x.variant.status === 'in_stock')!;
const other = all.find((x) => x.variant.stock >= 5 && x.variant.sku !== plenty.variant.sku)!;
const soldOut = all.find((x) => x.variant.stock === 0)!;
const low = all.find((x) => x.variant.stock >= 1 && x.variant.status === 'low_stock')!;

const request = (lines: { sku: string; quantity: number }[], over: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({
  lines, delivery: GOOD, paymentMethod: 'cod', quotedTotal: priceCart(lines).total, ...over,
});
const created = (result: PlaceResult) => {
  expect(result.status).toBe(201);
  return (result as Extract<PlaceResult, { status: 201 }>).order;
};
const stockOf = (sku: string) => liveProducts().flatMap((p) => p.variants).find((v) => v.sku === sku)!.stock;

beforeEach(() => resetDb());

describe('quote: the server prices the cart', () => {
  it('states the unit price, line total, total and VAT, and says the cart is ready', () => {
    const quote = priceCart([{ sku: plenty.variant.sku, quantity: 3 }]);
    const line = quote.lines[0];
    expect(line.unitPrice).toBe(plenty.variant.price);
    expect(line.lineTotal).toBe(Math.round(plenty.variant.price * 3 * 100) / 100);
    expect(quote.total).toBe(line.lineTotal);
    expect(quote.vatRate).toBe(12);
    expect(quote.vatIncluded).toBe(true);
    expect(quote.deliveryFee).toBe(0);
    expect(quote.deliveryLabel).toBe('Free delivery');
    expect(quote.ready).toBe(true);
  });

  it('works out the VAT inside the price (12% included), once on the total, as the company rounds', () => {
    expect(VAT_ROUNDING).toBe('round_globally');
    // 349 * 12 / 112 = 37.3928...
    expect(vatPortion([349], 0)).toBe(37.39);
    // two lines of 0.50 and 0.50 each carry 0.0535...: globally 0.11 on 1.00 (0.1071), per line 0.05 + 0.05 = 0.10
    expect(vatPortion([0.5, 0.5], 0, 'round_globally')).toBe(0.11);
    expect(vatPortion([0.5, 0.5], 0, 'round_per_line')).toBe(0.1);
  });

  it('counts lines for one SKU together and keeps the first-seen order', () => {
    expect(mergeLines([{ sku: 'B', quantity: 1 }, { sku: 'A', quantity: 2 }, { sku: 'B', quantity: 3 }])).toEqual([{ sku: 'B', quantity: 4 }, { sku: 'A', quantity: 2 }]);
  });

  it('flags an item that is sold out, short, or no longer sold, with the addon sentences', () => {
    const soldOutLine = priceCart([{ sku: soldOut.variant.sku, quantity: 1 }]).lines[0];
    expect(soldOutLine.issue).toBe('sold_out');
    expect(soldOutLine.message).toMatch(/^Sorry, .* just sold out\.$/);
    const over = priceCart([{ sku: low.variant.sku, quantity: low.variant.stock + 1 }]);
    expect(over.lines[0].issue).toBe('over_stock');
    expect(over.lines[0].available).toBe(low.variant.stock);
    expect(over.lines[0].message).toBe(`Sorry, only ${low.variant.stock} of ${low.product.name} (${over.lines[0].colorName}, ${low.variant.size}) left.`);
    expect(over.ready).toBe(false);
    const gone = priceCart([{ sku: 'NO-SUCH-SKU', quantity: 1 }]);
    expect(gone.lines[0].issue).toBe('unavailable');
    expect(gone.ready).toBe(false);
  });

  it('is not ready for an empty cart', () => {
    expect(priceCart([]).ready).toBe(false);
  });
});

describe('placing an order', () => {
  it('Cash on delivery: confirmed at once, numbered S00001, and the stock is held', () => {
    const before = stockOf(plenty.variant.sku);
    const order = created(placeOrder(request([{ sku: plenty.variant.sku, quantity: 2 }]), null));
    expect(order.reference).toBe('S00001');
    expect(order.state).toBe('confirmed');
    expect(order.bankTransfer).toBeNull();
    expect(order.total).toBe(priceCart([{ sku: plenty.variant.sku, quantity: 2 }]).total);
    expect(order.delivery.provinceName).toBe('Metro Manila (NCR)');
    expect(stockOf(plenty.variant.sku)).toBe(before - 2);
  });

  it('Bank transfer: also confirmed and held at once, but waiting for payment, with placeholder bank details and no deadline', () => {
    const before = stockOf(plenty.variant.sku);
    const order = created(placeOrder(request([{ sku: plenty.variant.sku, quantity: 1 }], { paymentMethod: 'bank_transfer' }), null));
    expect(order.state).toBe('awaiting_payment');
    expect(order.bankTransfer?.placeholder).toBe(true);
    expect(order.bankTransfer?.paymentReference).toBe(order.reference);
    expect(stockOf(plenty.variant.sku)).toBe(before - 1);
    expect(JSON.stringify(order)).not.toMatch(/deadline|within \d|\d+ (hours?|days?)/i);
  });

  it('numbers orders one after another', () => {
    const one = created(placeOrder(request([{ sku: plenty.variant.sku, quantity: 1 }]), null));
    const two = created(placeOrder(request([{ sku: plenty.variant.sku, quantity: 1 }]), null));
    expect([one.reference, two.reference]).toEqual(['S00001', 'S00002']);
    expect(loadDb().orders).toHaveLength(2);
  });

  it('when staff cancel an unpaid bank-transfer order, the stock goes back', () => {
    const before = stockOf(plenty.variant.sku);
    const order = created(placeOrder(request([{ sku: plenty.variant.sku, quantity: 2 }], { paymentMethod: 'bank_transfer' }), null));
    expect(stockOf(plenty.variant.sku)).toBe(before - 2);
    expect(cancelOrder(order.id)?.state).toBe('cancelled');
    expect(stockOf(plenty.variant.sku)).toBe(before);
    expect(cancelOrder('999')).toBeUndefined();
  });

  it('refuses the whole order when one line is short: no order, nothing held, and the sentence says the cart is kept', () => {
    const lines = [{ sku: plenty.variant.sku, quantity: 1 }, { sku: low.variant.sku, quantity: low.variant.stock + 1 }];
    const before = stockOf(plenty.variant.sku);
    const result = placeOrder(request(lines, { quotedTotal: 1 }), null);
    expect(result.status).toBe(409);
    if (result.status !== 409 || result.code !== 'stock_conflict') throw new Error('expected stock_conflict');
    expect(result.lines.map((l) => l.sku)).toEqual([low.variant.sku]);
    expect(result.message).toMatch(/^Sorry, only \d+ of .* left\. Your cart has been kept\.$/);
    expect(loadDb().orders).toHaveLength(0);
    expect(stockOf(plenty.variant.sku)).toBe(before);
  });

  it('counts duplicate lines together: two lines that fit alone but not together are refused', () => {
    const half = Math.ceil((low.variant.stock + 1) / 2);
    const result = placeOrder(request([{ sku: low.variant.sku, quantity: half }, { sku: low.variant.sku, quantity: half }], { quotedTotal: 1 }), null);
    expect(result.status).toBe(409);
  });

  it('a second order for the last unit is refused: "just sold out"', () => {
    const lines = [{ sku: low.variant.sku, quantity: low.variant.stock }];
    created(placeOrder(request(lines), null));
    const second = placeOrder(request(lines, { quotedTotal: 1 }), null);
    expect(second.status).toBe(409);
    if (second.status !== 409 || second.code !== 'stock_conflict') throw new Error('expected stock_conflict');
    expect(second.message).toMatch(/just sold out\. Your cart has been kept\.$/);
  });

  it('a sold-out variant cannot be ordered', () => {
    const result = placeOrder(request([{ sku: soldOut.variant.sku, quantity: 1 }], { quotedTotal: 1 }), null);
    expect(result.status).toBe(409);
  });

  it('refuses with 409 price_changed when the total differs from the one quoted, gives the new quote, and creates nothing', () => {
    const lines = [{ sku: plenty.variant.sku, quantity: 2 }];
    const shown = priceCart(lines).total;
    const db = loadDb();
    db.priceDelta[plenty.variant.sku] = 10; // the price moves after the shopper saw the total
    sessionStorage.setItem(DB_KEY, JSON.stringify(db));
    const result = placeOrder(request(lines, { quotedTotal: shown }), null);
    expect(result.status).toBe(409);
    if (result.status !== 409 || result.code !== 'price_changed') throw new Error('expected price_changed');
    expect(result.quote.total).toBe(shown + 20);
    expect(result.quote.lines[0].unitPrice).toBe(plenty.variant.price + 10);
    expect(loadDb().orders).toHaveLength(0);
    expect(stockOf(plenty.variant.sku)).toBe(plenty.variant.stock);
    // with the new total the order goes through
    const again = created(placeOrder(request(lines, { quotedTotal: result.quote.total }), null));
    expect(again.total).toBe(shown + 20);
  });

  it('accepts the quoted total even when it has float noise (rounded to the cent)', () => {
    const lines = [{ sku: plenty.variant.sku, quantity: 3 }];
    created(placeOrder(request(lines, { quotedTotal: priceCart(lines).total + 0.0000001 }), null));
  });

  it('a repeated submit with the same Idempotency-Key returns the same order and holds the stock once', () => {
    const lines = [{ sku: plenty.variant.sku, quantity: 2 }];
    const before = stockOf(plenty.variant.sku);
    const first = created(placeOrder(request(lines), 'key-1'));
    const again = created(placeOrder(request(lines, { quotedTotal: 0 }), 'key-1'));
    expect(again.id).toBe(first.id);
    expect(loadDb().orders).toHaveLength(1);
    expect(stockOf(plenty.variant.sku)).toBe(before - 2);
  });

  it('rejects bad details with field messages (422) and creates nothing', () => {
    const result = placeOrder(request([{ sku: plenty.variant.sku, quantity: 1 }], { delivery: { ...EMPTY_DELIVERY, email: 'nope', phone: '123' } }), null);
    expect(result.status).toBe(422);
    if (result.status !== 422) throw new Error('expected 422');
    expect(Object.keys(result.fields)).toEqual(expect.arrayContaining(['fullName', 'email', 'phone', 'street', 'city', 'province', 'postalCode']));
    expect(loadDb().orders).toHaveLength(0);
  });

  it('rejects an unknown payment method and an empty cart (400)', () => {
    const lines = [{ sku: plenty.variant.sku, quantity: 1 }];
    expect(placeOrder(request(lines, { paymentMethod: 'card' as never }), null).status).toBe(400);
    expect(placeOrder(request([], { quotedTotal: 0 }), null).status).toBe(400);
  });

  it('does not touch the catalogue of a product that no order holds', () => {
    created(placeOrder(request([{ sku: plenty.variant.sku, quantity: 1 }]), null));
    const untouched = liveProducts().find((p) => p.id === other.product.id && p.id !== plenty.product.id);
    if (untouched) expect(untouched).toBe(catalogue.products.find((p) => p.id === untouched.id));
  });

  it('lowers a product\'s stock and recomputes its status as orders hold units', () => {
    const lines = [{ sku: low.variant.sku, quantity: low.variant.stock }];
    created(placeOrder(request(lines), null));
    const variant = liveProducts().flatMap((p) => p.variants).find((v) => v.sku === low.variant.sku)!;
    expect(variant.stock).toBe(0);
    expect(variant.status).toBe('out_of_stock');
  });
});

describe('delivery rules and options', () => {
  it('accepts a good address and Philippine mobile formats', () => {
    const codes = MOCK_PROVINCES.map((p) => p.code);
    expect(validateDelivery(GOOD, codes)).toEqual({});
    for (const phone of ['09171234567', '0917-123-4567', '+63 917 123 4567']) expect(validateDelivery({ ...GOOD, phone }, codes).phone).toBeUndefined();
    for (const phone of ['9171234567', '08171234567', '+6391712345']) expect(validateDelivery({ ...GOOD, phone }, codes).phone).toBeDefined();
  });

  it('checks the postal code and email', () => {
    const codes = MOCK_PROVINCES.map((p) => p.code);
    expect(validateDelivery({ ...GOOD, postalCode: '110' }, codes).postalCode).toBeDefined();
    expect(validateDelivery({ ...GOOD, postalCode: '11000' }, codes).postalCode).toBeDefined();
    expect(validateDelivery({ ...GOOD, email: 'a@b' }, codes).email).toBeDefined();
  });

  it('offers exactly Cash on delivery and Bank transfer, and a province list that has Metro Manila (NCR) first', () => {
    expect(checkoutOptions.paymentMethods.map((m) => m.id)).toEqual(['cod', 'bank_transfer']);
    expect(checkoutOptions.paymentMethods.map((m) => m.label)).toEqual(['Cash on delivery', 'Bank transfer']);
    expect(checkoutOptions.provinces).toHaveLength(83);
    expect(checkoutOptions.provinces[0]).toEqual({ code: 'PH-00', name: 'Metro Manila (NCR)' });
    expect(new Set(checkoutOptions.provinces.map((p) => p.code)).size).toBe(83);
  });
});
