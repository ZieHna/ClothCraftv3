import type { ColorInfo, Group, Order, Product, SizeId, Simulation, StaffHistoryLine, StaffRole, StockStatus } from '../api/types';
import raw from './catalogue.json';

/** Shape of catalogue.json, which scripts/export-catalogue.py writes. The JSON is the source of truth. */
interface CatalogueFile {
  meta: { label: string; note: string; currency: 'PHP'; vatIncluded: boolean; lowStockAt: number };
  groups: Group[];
  colors: ColorInfo[];
  sizes: SizeId[];
  products: Product[];
}
// JSON string values are typed as plain strings, so go through unknown once, here.
export const catalogue = raw as unknown as CatalogueFile;
export const simulation: Simulation = { label: catalogue.meta.label, note: catalogue.meta.note };
export const money = (n: number) => Math.round(n * 100) / 100;

/**
 * The MOCK SERVER's database: the orders placed in this tab and what they reserve. It lives in sessionStorage, the same
 * lifetime as the demo session, so closing the tab resets orders AND stock (the pages say so). It is the server's data, not the
 * shopper's cart: signing out does not touch it. If storage is blocked it falls back to memory (lost on reload).
 */
export interface MockDb {
  /** the next order number; the first order is S00001 */
  nextNumber: number;
  /** every order carries who placed it; the API never shows it, it only decides whose order it is */
  orders: MockOrder[];
  /** the customer accounts of this tab (the mock stores a password as typed: it is a mock) */
  users: MockUser[];
  nextUserId: number;
  /** session token -> user id */
  sessions: Record<string, number>;
  /** staff session token -> staff id (a staff session never opens a customer route, nor the other way round) */
  staffSessions: Record<string, number>;
  /** attempt counters, by key; times are Date.now() */
  throttle: Record<string, { failures: number; last: number; until: number }>;
  /** Idempotency-Key -> order id, so a repeated submit returns the same order */
  idempotency: Record<string, string>;
  /** SKU -> amount added to its price. Nothing in the app sets this; tests and checks do, to make a price change happen. */
  priceDelta: Record<string, number>;
}

/** What only the staff screens see (the payment received, the history of moves) is kept beside the order and never sent to the customer. */
export type MockOrder = Omit<Order, 'state'> & { state: import('../api/types').OrderState; ownerId: number; paid: boolean; history: StaffHistoryLine[] }; // step 11: the frozen mock keeps the step 7 states
export interface MockStaff {
  id: number;
  name: string;
  email: string;
  role: StaffRole;
}
export interface MockUser {
  id: number;
  name: string;
  email: string;
  password: string;
}

export const DB_KEY = 'cc.mock.db.v1';
let memory: MockDb | null = null;

const fresh = (): MockDb => ({ nextNumber: 1, orders: [], users: [], nextUserId: 1, sessions: {}, staffSessions: {}, throttle: {}, idempotency: {}, priceDelta: {} });

export function loadDb(): MockDb {
  try {
    const stored = sessionStorage.getItem(DB_KEY);
    if (!stored) return fresh();
    const parsed = JSON.parse(stored) as Partial<MockDb>;
    return { ...fresh(), ...parsed };
  } catch {
    return memory ?? fresh();
  }
}

export function saveDb(db: MockDb): void {
  memory = db;
  try {
    sessionStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    /* storage blocked: memory only */
  }
}

/** Test helper: start from an empty database. */
export function resetDb(): void {
  memory = null;
  try {
    sessionStorage.removeItem(DB_KEY);
  } catch {
    /* nothing to remove */
  }
}

const statusFor = (stock: number): StockStatus => (stock <= 0 ? 'out_of_stock' : stock <= catalogue.meta.lowStockAt ? 'low_stock' : 'in_stock');

/** Units held by orders that are not cancelled, per SKU. A confirmed order and one waiting for payment both hold stock. */
function reservedBySku(db: MockDb): Map<string, number> {
  const held = new Map<string, number>();
  for (const order of db.orders) {
    if (order.state === 'cancelled') continue;
    for (const line of order.lines) held.set(line.sku, (held.get(line.sku) ?? 0) + line.quantity);
  }
  return held;
}

/**
 * The catalogue as it is right now: catalogue.json minus what orders hold, with each status worked out the same way the JSON's
 * were (0 is sold out, lowStockAt or fewer is low). A product no order touches is returned as it is, untouched.
 */
export function liveProducts(db: MockDb = loadDb()): Product[] {
  const held = reservedBySku(db);
  const priced = Object.keys(db.priceDelta).length > 0;
  if (held.size === 0 && !priced) return catalogue.products;
  return catalogue.products.map((product) => {
    if (!product.variants.some((v) => held.has(v.sku) || db.priceDelta[v.sku])) return product;
    const variants = product.variants.map((v) => {
      const stock = Math.max(0, v.stock - (held.get(v.sku) ?? 0));
      return { ...v, stock, status: statusFor(stock), price: money(v.price + (db.priceDelta[v.sku] ?? 0)) };
    });
    const stock = variants.reduce((sum, v) => sum + v.stock, 0);
    return { ...product, variants, stock, status: statusFor(stock) };
  });
}
