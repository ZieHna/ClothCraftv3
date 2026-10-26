import { apiGet, apiSend } from './client';

/**
 * The staff dashboard's stock, restock and bell calls (phase 6). The shapes are the ones the real service answered (dev stack for the lists,
 * a throwaway copy of the shop for create / edit / receive / notifications):
 *   GET  /api/staff/stock?q&low&page&pageSize         -> {total, page, pageSize, globalThreshold, defaultThreshold, variants: StockVariant[]}
 *   POST /api/staff/stock/:productId/edit {quantity, reason} -> {variant, edit}   | 409 refused (a sentence) | 422 validation (fields)
 *   GET  /api/staff/stock/history?productId&page&pageSize -> {total, page, pageSize, edits: StockEdit[]}
 *   GET  /api/staff/restock-options[?supplierId]      -> {suppliers: RestockSupplier[]}  (available suppliers only)
 *   GET  /api/staff/restocks?q&state&supplierId&late&overdue&page&pageSize -> {total, page, pageSize, restocks: RestockSummary[]}
 *   GET  /api/staff/restocks/:id                      -> {restock: RestockDetail}
 *   POST /api/staff/restocks (201), PATCH /api/staff/restocks/:id -> {restock}   (PATCH replaces the lines; only while `requested`)
 *   GET  /api/staff/notifications?unreadOnly&page&pageSize -> {total, unreadCount, notifications, page, pageSize}
 *   POST /api/staff/notifications/:id/read            -> {notification, unreadCount}      POST .../read-all -> {marked, unreadCount}
 * Money is a plain number (2 decimals) and is only displayed: the estimate and every cost are the server's. Errors: {error: {code, message,
 * fields?}}; a 409 `refused` / `invalid_transition` carries a sentence for people.
 */
export interface StockVariant {
  id: string;
  sku: string | null;
  name: string;
  garmentType: { id: string; code: string };
  onHand: number;
  reserved: number;
  free: number;
  /** this variant's own level, or null when it follows the shop's */
  threshold: number | null;
  effectiveThreshold: number;
  thresholdSource: string;
  low: boolean;
}
export interface StockList {
  total: number;
  page: number;
  pageSize: number;
  globalThreshold: number;
  defaultThreshold: number;
  variants: StockVariant[];
}
export interface StockEdit {
  id: string;
  productId: string;
  sku: string | null;
  name: string;
  oldQty: number;
  newQty: number;
  delta: number;
  reason: string;
  /** the lot the change went into, as the server describes it */
  detail: string | null;
  staffName: string;
  via: string;
  at: string;
}
export interface StockHistory {
  total: number;
  page: number;
  pageSize: number;
  edits: StockEdit[];
}

export interface RestockLineOption {
  id: string;
  supplierId: string;
  garmentType: { id: string; code: string; name: string };
  size: { id: string; name: string };
  color: { id: string; name: string };
  unitCost: number;
  unitCostVat: number;
  unitCostNet: number;
  /** the variants (products) that can fill this line */
  variants: { id: string; sku: string | null; name: string }[];
}
export interface RestockSupplier {
  id: string;
  name: string;
  ships: boolean;
  shippingFee: number;
  lines: RestockLineOption[];
}

export type RestockState = 'requested' | 'approved' | 'rejected' | 'received' | 'not_received';
export interface RestockSummary {
  id: string;
  /** the ticket number, RS00001 */
  name: string;
  state: RestockState;
  supplier: { id: string; name: string };
  lineCount: number;
  estimateTotal: number;
  expectedFrom: string;
  expectedTo: string;
  shippingOn: boolean;
  shippingApplied: boolean;
  requestedBy: string;
  requestedAt: string;
  receivedOn: string | null;
  receivedLate: boolean;
  overdue: boolean;
  /** null until the goods are received */
  actualCost: number | null;
}
export interface RestockLine {
  id: string;
  productId: string;
  sku: string | null;
  name: string;
  garmentType: { id: string; code: string; name: string };
  size: { id: string; name: string };
  color: { id: string; name: string };
  quantity: number;
  unitCost: number;
  quantityReceived: number | null;
  lot: string | null;
  receivedCost: number | null;
}
export interface RestockHistoryEntry {
  id: string;
  event: string;
  fromState: RestockState | null;
  toState: RestockState;
  staffName: string;
  note: string | null;
  at: string;
  via: string;
}
export interface RestockDetail extends RestockSummary {
  shippingFee: number;
  requestNote: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  receivedBy: string | null;
  receivedAt: string | null;
  goodsCost: number;
  shippingCost: number;
  actualVat: number;
  actualNet: number;
  stockReceipt: string | null;
  lines: RestockLine[];
  history: RestockHistoryEntry[];
}

export interface RestockBody {
  supplierId?: string;
  lines?: { productId: string; quantity: number; unitCost?: number }[];
  shippingOn?: boolean;
  expectedFrom?: string;
  expectedTo?: string;
  requestNote?: string;
  /** PATCH only: the note of this edit in the history */
  note?: string;
}

export interface StaffNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  restockId: string | null;
  supplierId: string | null;
  productId: string | null;
  /** an employee-management notice (added, role changed, deactivated, reactivated): the person it is about */
  employeeId?: string | null;
  createdAt: string;
  read: boolean;
  readAt: string | null;
}
export interface NotificationList {
  total: number;
  unreadCount: number;
  notifications: StaffNotification[];
  page: number;
  pageSize: number;
}

const enc = encodeURIComponent;
const n = (value: number | undefined) => (value ? String(value) : undefined);

export const listStock = (query: { q?: string; low?: boolean; page?: number; pageSize?: number }, signal?: AbortSignal) =>
  apiGet<StockList>('/staff/stock', { q: query.q, low: query.low ? 'true' : undefined, page: n(query.page), pageSize: n(query.pageSize) }, signal);
export const editStock = (productId: string, body: { quantity: number; reason: string }) =>
  apiSend<{ variant: StockVariant; edit: { id: string; oldQty: number; newQty: number; delta: number; reason: string; detail: string | null } }>('POST', `/staff/stock/${enc(productId)}/edit`, body);
export const stockHistory = (query: { productId?: string; page?: number; pageSize?: number }, signal?: AbortSignal) =>
  apiGet<StockHistory>('/staff/stock/history', { productId: query.productId, page: n(query.page), pageSize: n(query.pageSize) }, signal);

export const restockOptions = (signal?: AbortSignal) => apiGet<{ suppliers: RestockSupplier[] }>('/staff/restock-options', {}, signal);
export const listRestocks = (query: { q?: string; state?: string; supplierId?: string; late?: boolean; overdue?: boolean; page?: number; pageSize?: number }, signal?: AbortSignal) =>
  apiGet<{ total: number; page: number; pageSize: number; restocks: RestockSummary[] }>(
    '/staff/restocks',
    { q: query.q, state: query.state, supplierId: query.supplierId, late: query.late ? 'true' : undefined, overdue: query.overdue ? 'true' : undefined, page: n(query.page), pageSize: n(query.pageSize) },
    signal,
  );
export const getRestock = (id: string, signal?: AbortSignal) => apiGet<{ restock: RestockDetail }>(`/staff/restocks/${enc(id)}`, {}, signal);
export const createRestock = (body: RestockBody) => apiSend<{ restock: RestockDetail }>('POST', '/staff/restocks', body);
export const updateRestock = (id: string, body: RestockBody) => apiSend<{ restock: RestockDetail }>('PATCH', `/staff/restocks/${enc(id)}`, body);

export const listNotifications = (query: { unreadOnly?: boolean; page?: number; pageSize?: number }, signal?: AbortSignal) =>
  apiGet<NotificationList>('/staff/notifications', { unreadOnly: query.unreadOnly ? 'true' : undefined, page: n(query.page), pageSize: n(query.pageSize) }, signal);
export const markNotificationRead = (id: string) => apiSend<{ notification: StaffNotification; unreadCount: number }>('POST', `/staff/notifications/${enc(id)}/read`);
export const markAllNotificationsRead = () => apiSend<{ marked: number; unreadCount: number }>('POST', '/staff/notifications/read-all');

/**
 * The Administrator's restock moves and low-stock levels (phase 8). Under /admin these go to /api/admin/... with the admin cookie (the client moves
 * /staff/... to /admin/...); an employee session gets 403 from the server whatever the page shows. Every answer is {restock} (the ticket as it is now),
 * a 409 `invalid_transition` / `refused` carries a sentence (the lot-collision one included) and, for a ticket that has moved on, the current `restock`.
 *   POST /restocks/:id/approve {note?}  ·  /reject {note: 5 to 500}  ·  /not-received {note?}
 *   POST /restocks/:id/receive {quantities?: {lineId: n}, lots?: {lineId: name}, receivedOn?: YYYY-MM-DD, note?}
 *   PUT  /stock/threshold {threshold}  ->  {globalThreshold}        PUT /stock/:productId/threshold {threshold | null}  ->  {variant}
 */
export interface ReceiveBody {
  /** received quantity per restock line id; a line left out arrived in full */
  quantities?: Record<string, number>;
  /** a typed lot name per restock line id; a line left out gets the ticket reference + SKU */
  lots?: Record<string, string>;
  receivedOn?: string;
  note?: string;
}
export const approveRestock = (id: string, body: { note?: string }) => apiSend<{ restock: RestockDetail }>('POST', `/staff/restocks/${enc(id)}/approve`, body);
export const rejectRestock = (id: string, body: { note: string }) => apiSend<{ restock: RestockDetail }>('POST', `/staff/restocks/${enc(id)}/reject`, body);
export const notReceivedRestock = (id: string, body: { note?: string }) => apiSend<{ restock: RestockDetail }>('POST', `/staff/restocks/${enc(id)}/not-received`, body);
export const receiveRestock = (id: string, body: ReceiveBody) => apiSend<{ restock: RestockDetail }>('POST', `/staff/restocks/${enc(id)}/receive`, body);
export const setGlobalThreshold = (threshold: number) => apiSend<{ globalThreshold: number }>('PUT', '/staff/stock/threshold', { threshold });
export const setVariantThreshold = (productId: string, threshold: number | null) =>
  apiSend<{ variant: StockVariant }>('PUT', `/staff/stock/${enc(productId)}/threshold`, { threshold });
