import type {
  CartLineInput, CheckoutOptions, LineIssue, Order, OrderLine, PaymentMethodId, PlaceOrderRequest, Product, Quote, QuoteLine, StockProblem, Variant,
} from '../api/types';
import { validateDelivery, type DeliveryErrors } from '../lib/deliveryRules';
import { MOCK_PROVINCES } from './provinces';
import { cancelAsDemoStaff } from './staff';
import { catalogue, liveProducts, loadDb, money, saveDb, type MockDb, type MockOrder } from './shopDb';

/**
 * The MOCK SERVER's cart and order rules. Everything that is a number or a decision is made here, the way the real service
 * must (see the notes at the top of src/api/types.ts); the UI only shows what comes back. The stock rules are the ones of the
 * Odoo addon (addons/clothcraft/models/sale_order.py and controllers/payment.py), including its sentences.
 */
export const VAT_RATE = 12;
/** What res.company.tax_calculation_rounding_method holds in clothcraft_sim (read-only check, STEP 5a): the VAT is rounded once, on the total. */
export const VAT_ROUNDING: 'round_globally' | 'round_per_line' = 'round_globally';
export const DELIVERY_LABEL = 'Free delivery'; // the real service's default (DELIVERY_LABEL in backend/.env)
export const MAX_LINE_QUANTITY = 99;

const BANK = { placeholder: true, bankName: 'Sample Bank (placeholder)', accountName: 'ClothCraft (placeholder)', accountNumber: '0000 0000 0000 (placeholder)' } as const;

export const checkoutOptions: CheckoutOptions = {
  currency: 'PHP',
  vatIncluded: catalogue.meta.vatIncluded,
  vatRate: VAT_RATE,
  provinces: MOCK_PROVINCES,
  paymentMethods: [
    { id: 'cod', label: 'Cash on delivery', description: 'Pay in cash when your order arrives.' },
    { id: 'bank_transfer', label: 'Bank transfer', description: 'Your order is reserved and waits for your payment.' },
  ],
};

/** The VAT inside VAT-inclusive money, rounded the way the company rounds. */
export function vatPortion(lineTotals: number[], deliveryFee: number, rounding = VAT_ROUNDING): number {
  const part = (amount: number) => (amount * VAT_RATE) / (100 + VAT_RATE);
  if (rounding === 'round_per_line') return money([...lineTotals, deliveryFee].reduce((sum, amount) => sum + money(part(amount)), 0));
  return money(part(lineTotals.reduce((sum, amount) => sum + amount, 0) + deliveryFee));
}

function find(sku: string, products: Product[]): { product: Product; variant: Variant } | undefined {
  for (const product of products) {
    const variant = product.variants.find((v) => v.sku === sku);
    if (variant) return { product, variant };
  }
  return undefined;
}

/** Lines for one SKU are counted together, as the Odoo guard does. First-seen order is kept. */
export function mergeLines(lines: CartLineInput[]): CartLineInput[] {
  const merged = new Map<string, number>();
  for (const line of lines) merged.set(line.sku, (merged.get(line.sku) ?? 0) + line.quantity);
  return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
}

const label = (product: Product, variant: Variant) => {
  const colorName = catalogue.colors.find((c) => c.id === variant.color)?.name ?? variant.color;
  return `${product.name} (${colorName}, ${variant.size})`;
};

export function priceCart(input: CartLineInput[], db: MockDb = loadDb()): Quote {
  const products = liveProducts(db);
  const lines = mergeLines(input).map((line): QuoteLine => {
    const hit = find(line.sku, products);
    if (!hit) {
      return { sku: line.sku, productId: '', name: line.sku, colorName: '', size: null, image: '', quantity: line.quantity, unitPrice: 0, lineTotal: 0, available: 0, issue: 'unavailable', message: 'Sorry, this item is no longer sold.' };
    }
    const { product, variant } = hit;
    const available = variant.stock;
    const issue: LineIssue = available <= 0 ? 'sold_out' : line.quantity > available ? 'over_stock' : 'ok';
    const message = issue === 'sold_out' ? `Sorry, ${label(product, variant)} just sold out.` : issue === 'over_stock' ? `Sorry, only ${available} of ${label(product, variant)} left.` : null;
    const colorName = catalogue.colors.find((c) => c.id === variant.color)?.name ?? variant.color;
    return {
      sku: variant.sku, productId: product.id, name: product.name, colorName, size: variant.size, image: `/garments/${product.id}/${variant.color}.webp`,
      quantity: line.quantity, unitPrice: variant.price, lineTotal: money(variant.price * line.quantity), available, issue, message,
    };
  });
  const deliveryFee = 0;
  const lineTotals = lines.map((l) => l.lineTotal);
  return {
    currency: 'PHP',
    vatIncluded: catalogue.meta.vatIncluded,
    vatRate: VAT_RATE,
    lines,
    deliveryFee,
    deliveryLabel: DELIVERY_LABEL,
    total: money(lineTotals.reduce((sum, amount) => sum + amount, 0) + deliveryFee),
    vatAmount: vatPortion(lineTotals, deliveryFee),
    ready: lines.length > 0 && lines.every((l) => l.issue === 'ok'),
  };
}

export type PlaceResult =
  | { status: 201; order: MockOrder }
  | { status: 409; code: 'stock_conflict'; message: string; lines: StockProblem[] }
  | { status: 409; code: 'price_changed'; message: string; quote: Quote }
  | { status: 422; code: 'validation'; message: string; fields: DeliveryErrors }
  | { status: 400; code: 'bad_request'; message: string };

const isMethod = (m: unknown): m is PaymentMethodId => m === 'cod' || m === 'bank_transfer';

/** Check the request and either create the order (and reserve its stock) or change nothing at all. */
export function placeOrder(request: PlaceOrderRequest, idempotencyKey: string | null, db: MockDb = loadDb(), ownerId = 0): PlaceResult {
  const idemKey = idempotencyKey ? `${ownerId}:${idempotencyKey}` : null;   // a key is one customer's: another customer's order is never replayed
  const replay = idemKey ? db.idempotency[idemKey] : undefined;
  const earlier = replay ? db.orders.find((o) => o.id === replay && o.ownerId === ownerId) : undefined;
  if (earlier) return { status: 201, order: earlier };

  if (!isMethod(request.paymentMethod)) return { status: 400, code: 'bad_request', message: 'Choose Cash on delivery or Bank transfer.' };
  if (typeof request.quotedTotal !== 'number' || !Number.isFinite(request.quotedTotal)) return { status: 400, code: 'bad_request', message: 'The total you were shown is missing.' };
  const fields = validateDelivery(request.delivery, MOCK_PROVINCES.map((p) => p.code));
  if (Object.keys(fields).length > 0) return { status: 422, code: 'validation', message: 'Some delivery details need fixing.', fields };

  const quote = priceCart(request.lines, db);
  if (quote.lines.length === 0) return { status: 400, code: 'bad_request', message: 'The cart is empty.' };

  // all or nothing: one short line means no order at all, and the cart stays as it is (the sentences are the addon's)
  const short = quote.lines.filter((l) => l.issue !== 'ok');
  if (short.length > 0) {
    const lines = short.map((l): StockProblem => ({ sku: l.sku, available: l.available, message: l.message ?? 'Sorry, this item cannot be supplied.' }));
    return { status: 409, code: 'stock_conflict', message: `${lines[0].message} Your cart has been kept.`, lines };
  }
  if (money(request.quotedTotal) !== quote.total) {
    return { status: 409, code: 'price_changed', message: 'The price changed since you last looked. Nothing was ordered. Please check the new total.', quote };
  }

  const number = db.nextNumber;
  const reference = `S${String(number).padStart(5, '0')}`;
  const orderLines = quote.lines.map(({ sku, productId, name, colorName, size, image, quantity, unitPrice, lineTotal }): OrderLine => ({
    sku, productId, name, colorName, size: size!, image, quantity, unitPrice, lineTotal,
  }));
  const d = request.delivery;
  const order: MockOrder = {
    ownerId,
    id: String(number),
    reference,
    // both methods are confirmed (and hold their stock) at once, as /shop/payment/transaction does; bank transfer then waits for payment
    state: request.paymentMethod === 'cod' ? 'confirmed' : 'awaiting_payment',
    createdAt: new Date().toISOString(),
    paymentMethod: request.paymentMethod,
    currency: 'PHP',
    vatIncluded: quote.vatIncluded,
    vatRate: quote.vatRate,
    lines: orderLines,
    delivery: {
      fullName: d.fullName.trim(), email: d.email.trim(), phone: d.phone.trim(), street: d.street.trim(), city: d.city.trim(), province: d.province,
      provinceName: MOCK_PROVINCES.find((p) => p.code === d.province)?.name ?? d.province, postalCode: d.postalCode.trim(), note: d.note.trim(),
    },
    deliveryFee: quote.deliveryFee,
    deliveryLabel: quote.deliveryLabel,
    total: quote.total,
    vatAmount: quote.vatAmount,
    bankTransfer: request.paymentMethod === 'bank_transfer' ? { ...BANK, paymentReference: reference } : null,
    paid: false,
    history: [],
  };
  db.orders.push(order);
  db.nextNumber = number + 1;
  if (idemKey) db.idempotency[idemKey] = order.id;
  saveDb(db);
  return { status: 201, order };
}

/** Stands in for staff cancelling an unpaid order: it gives the stock back and leaves a history line. Only the mock has this (src/mocks/staff.ts). */
export function cancelOrder(id: string, db: MockDb = loadDb()): Order | undefined {
  return cancelAsDemoStaff(id, db);
}
