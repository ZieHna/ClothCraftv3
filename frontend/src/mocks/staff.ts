import type { OrderState, StaffAllowedMove, StaffBlockedMove, StaffHistoryLine, StaffOrder, StaffOrderSummary, StaffRole } from '../api/types';
import { loadDb, saveDb, type MockDb, type MockOrder, type MockStaff } from './shopDb';

/**
 * The MOCK SERVER's staff rules. They are the real service's (addons/clothcraft/models/order_flow.py and api_staff.py): the same moves,
 * the same sentences, the same refusals. contract/cases/07-staff.json runs against both, so they cannot drift.
 *
 * The two demo staff accounts below exist ONLY in the mock (the Odoo build never contains this file's accounts: see
 * src/staff/DemoStaffHint.tsx). They are not real people and these passwords open nothing real.
 */
export const DEMO_STAFF: (MockStaff & { password: string })[] = [
  { id: 1, name: 'Demo Inventory Staff', email: 'inventory.demo@clothcraft.test', password: 'demo inventory staff', role: 'inventory' },
  { id: 2, name: 'Demo Administrator', email: 'admin.demo@clothcraft.test', password: 'demo administrator', role: 'admin' },
];
export const findStaff = (email: string) => DEMO_STAFF.find((s) => s.email === email.trim().toLowerCase());

export const LABELS: Record<OrderState, string> = {
  awaiting_payment: 'awaiting payment', confirmed: 'confirmed', packed: 'packed', shipped: 'shipped', delivered: 'delivered', cancelled: 'cancelled',
};
export const NEXT: Record<OrderState, OrderState[]> = {
  awaiting_payment: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};
const ACTIONS: Record<string, string> = { confirmed: 'Mark payment received', packed: 'Mark as packed', shipped: 'Mark as shipped', delivered: 'Mark as delivered', cancelled: 'Cancel order' };
export const NOTE_LIMIT = 500;
export const PAGE_MAX = 100;
const isState = (v: unknown): v is OrderState => typeof v === 'string' && v in LABELS;

// ---------------------------------------------------------------- the rules
const isBank = (o: MockOrder) => o.paymentMethod === 'bank_transfer';
const bankPaid = (o: MockOrder) => isBank(o) && o.paid;
const noteRequired = (o: MockOrder, to: OrderState) => to === 'cancelled' && bankPaid(o);

/** null when this move is allowed for this role, else [code, sentence]. */
function check(o: MockOrder, to: OrderState, role: StaffRole): ['invalid_transition' | 'forbidden', string] | null {
  const current = o.state;
  if (current === 'delivered' || current === 'cancelled') return ['invalid_transition', `This order is ${LABELS[current]}. A ${LABELS[current]} order can't be changed.`];
  if (!NEXT[current].includes(to)) {
    if (to === 'cancelled') return ['invalid_transition', `An order that is ${LABELS[current]} can't be cancelled.`];
    const options = NEXT[current].map((t) => LABELS[t]).join(' or ');
    return ['invalid_transition', `An order that is ${LABELS[current]} can't be moved to ${LABELS[to]}. From ${LABELS[current]} it can go to ${options}.`];
  }
  if (to === 'cancelled' && bankPaid(o) && role !== 'admin') return ['forbidden', 'Only an Administrator can cancel an order that has been paid.'];
  return null;
}

function actions(o: MockOrder, role: StaffRole): { allowed: StaffAllowedMove[]; blocked: StaffBlockedMove[] } {
  const allowed: StaffAllowedMove[] = [];
  const blocked: StaffBlockedMove[] = [];
  for (const to of NEXT[o.state]) {
    const label = ACTIONS[to] + (to === 'delivered' && o.paymentMethod === 'cod' ? ' (cash collected)' : '');
    const problem = check(o, to, role);
    if (problem) blocked.push({ to, label, reason: problem[1] });
    else allowed.push({ to, label, needsNote: noteRequired(o, to), confirm: to === 'cancelled' });
  }
  return { allowed, blocked };
}

// ---------------------------------------------------------------- reading
const customerOf = (db: MockDb, o: MockOrder) => {
  const user = db.users.find((u) => u.id === o.ownerId);
  return { name: user?.name ?? o.delivery.fullName, email: user?.email ?? o.delivery.email };
};
const statusChangedAt = (o: MockOrder) => o.history[o.history.length - 1]?.at ?? o.createdAt;

export function summary(db: MockDb, o: MockOrder): StaffOrderSummary {
  return {
    id: o.id, reference: o.reference, state: o.state, paymentMethod: o.paymentMethod, paid: o.paid, customer: customerOf(db, o), total: o.total,
    itemCount: o.lines.reduce((n, l) => n + l.quantity, 0), createdAt: o.createdAt, statusChangedAt: statusChangedAt(o),
  };
}

export function detail(db: MockDb, o: MockOrder, role: StaffRole): StaffOrder {
  const { ownerId, paid, history, ...order } = o;
  void ownerId;
  void paid;
  return { ...order, customer: { ...customerOf(db, o), phone: o.delivery.phone }, history: history.map((h) => ({ ...h })), ...actions(o, role) };
}

export interface ListQuery {
  states: string[];
  method: string | null;
  from: string | null;
  to: string | null;
  q: string;
  page: number;
  pageSize: number;
}
export type ListResult =
  | { status: 'ok'; orders: StaffOrderSummary[]; total: number; page: number; pageSize: number }
  | { status: 'invalid'; code: 'bad_date'; message: string };

/** The date as a UTC day number, or null when it is not a real YYYY-MM-DD (Odoo's strptime says no to the same). */
function dayOf(text: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? Math.floor(date.getTime() / 86400000) : null;
}

export function list(db: MockDb, query: ListQuery): ListResult {
  const from = query.from ? dayOf(query.from) : null;
  const to = query.to ? dayOf(query.to) : null;
  if ((query.from && from === null) || (query.to && to === null)) return { status: 'invalid', code: 'bad_date', message: 'Dates look like 2026-10-31.' };
  const text = query.q.toLowerCase();
  const found = db.orders
    .filter((o) => (query.states.length === 0 || query.states.includes(o.state)) && (!query.method || o.paymentMethod === query.method))
    .filter((o) => {
      const day = Math.floor(new Date(o.createdAt).getTime() / 86400000);
      return (from === null || day >= from) && (to === null || day <= to);
    })
    .filter((o) => {
      if (!text) return true;
      const c = customerOf(db, o);
      return [o.reference, c.name, c.email, o.delivery.fullName].some((v) => v.toLowerCase().includes(text));
    })
    .sort((a, b) => Number(b.id) - Number(a.id));
  const pageSize = Math.min(Math.max(query.pageSize, 1), PAGE_MAX);
  const page = Math.max(query.page, 1);
  return { status: 'ok', orders: found.slice((page - 1) * pageSize, page * pageSize).map((o) => summary(db, o)), total: found.length, page, pageSize };
}

// ---------------------------------------------------------------- moving
export type MoveResult =
  | { status: 'done'; order: StaffOrder }
  | { status: 'not_found' }
  | { status: 'invalid'; fields: Record<string, string> }
  | { status: 'state_changed'; current: OrderState; message: string; order: StaffOrder }
  | { status: 'invalid_transition' | 'forbidden'; current: OrderState; message: string };

export interface MoveRequest {
  to: unknown;
  expectedState: unknown;
  note: string;
}

/** Everything between reading the order and saving it is synchronous, so two requests at once cannot both win. */
export function transition(id: string, role: StaffRole, staffName: string, request: MoveRequest, db: MockDb = loadDb()): MoveResult {
  const { to, expectedState } = request;
  const note = request.note.trim();
  if (!isState(to) || !isState(expectedState)) return { status: 'invalid', fields: { to: 'Choose what to do with the order.' } };
  if (note.length > NOTE_LIMIT) return { status: 'invalid', fields: { note: `Keep the note to ${NOTE_LIMIT} characters or fewer.` } };
  const order = db.orders.find((o) => o.id === id);
  if (!order) return { status: 'not_found' };
  const current = order.state;
  if (current !== expectedState) {
    const last = order.history[order.history.length - 1];
    const who = last ? ` by ${last.staff}` : '';
    return { status: 'state_changed', current, message: `This order is now ${LABELS[current]}; it was changed${who}. Nothing was done. Check it and try again.`, order: detail(db, order, role) };
  }
  const problem = check(order, to, role);
  if (problem) return { status: problem[0], current, message: problem[1] };
  if (noteRequired(order, to) && note.length < 3) {
    return { status: 'invalid', fields: { note: 'Write a short note: the payment was received, so a refund has to be arranged. Say who will do it.' } };
  }
  move(order, to, staffName, note);
  saveDb(db);
  return { status: 'done', order: detail(db, order, role) };
}

/** The move itself, with its history line. A payment is received when a bank order is confirmed and when cash is collected on delivery. */
function move(order: MockOrder, to: OrderState, staff: string, note: string): void {
  const refund = noteRequired(order, to);
  const from = order.state;
  if (to === 'confirmed' || to === 'delivered') order.paid = true;
  order.state = to;
  const text = refund ? (note ? `REFUND DUE. ${note}` : 'REFUND DUE.') : note;
  const line: StaffHistoryLine = { at: new Date().toISOString(), from, to, staff, note: text, via: 'dashboard' };
  order.history.push(line);
}

/** MOCK ONLY: the demo button on the customer's order page ("pretend staff cancelled"). The same move, made by a pretend staff member. */
export function cancelAsDemoStaff(id: string, db: MockDb = loadDb()): MockOrder | undefined {
  const order = db.orders.find((o) => o.id === id);
  if (!order) return undefined;
  if (order.state !== 'delivered' && order.state !== 'cancelled') {
    move(order, 'cancelled', 'Demo staff', '');
    saveDb(db);
  }
  return order;
}
