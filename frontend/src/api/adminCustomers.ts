import { apiGet, apiSend } from './client';

/**
 * The Administrator's customer management (step 7d), under /api/admin only (these routes do not exist under /api/staff). A customer is a
 * registered shop account; employees, the API service, Odoo's base admin and the templates are never listed. There is no password handling at
 * all: no reply carries one and no route takes one. Every figure is Odoo's: `totalSpent` is the VAT-inclusive sum of CLOSED orders, and
 * `deliveredAwaiting` (detail only) is a separate figure that is never added to it. A list row carries no phone and no address.
 *   GET   /admin/customers?q&status&page&pageSize   -> {total, page, pageSize, customers}
 *   GET   /admin/customers/:id                      -> {customer, recentOrders, audit}     (404 for anyone who is not a customer)
 *   PATCH /admin/customers/:id                      {name?, email?, phone?} -> {customer}  (an email change signs them out)
 *   POST  /admin/customers/:id/deactivate | /reactivate -> {customer}
 */
export interface CustomerRow {
  id: string;
  name: string;
  /** the sign-in email */
  email: string;
  registeredAt: string;
  active: boolean;
  /** orders placed, cancelled ones included */
  orderCount: number;
  /** Closed orders only, VAT included */
  totalSpent: number;
}
export interface CustomerDetail extends CustomerRow {
  phone: string | null;
  lastSignInAt: string | null;
  closedCount: number;
  /** delivered orders still waiting for the customer's confirmation: not part of totalSpent */
  deliveredAwaiting: { total: number; orderCount: number };
  /** unpaid orders (awaiting payment), left as they are when an account is deactivated */
  awaitingPayment: number;
  cartLines: number;
  draftDesigns: number;
}
export interface CustomerOrder {
  id: string;
  name: string;
  state: string;
  placedAt: string;
  amountTotal: number;
}
export type CustomerAuditValues = Partial<{ name: string; email: string; phone: string | null; active: boolean }>;
export interface CustomerAuditEntry {
  id: string;
  at: string;
  action: 'edited' | 'deactivated' | 'reactivated';
  actorName: string;
  old: CustomerAuditValues | null;
  new: CustomerAuditValues | null;
}
export interface CustomerList {
  total: number;
  page: number;
  pageSize: number;
  customers: CustomerRow[];
}

const enc = encodeURIComponent;
const n = (value: number | undefined) => (value ? String(value) : undefined);

export const listCustomers = (query: { q?: string; status?: string; page?: number; pageSize?: number }, signal?: AbortSignal) =>
  apiGet<CustomerList>('/admin/customers', { q: query.q, status: query.status, page: n(query.page), pageSize: n(query.pageSize) }, signal);
export const getCustomer = (id: string, signal?: AbortSignal) =>
  apiGet<{ customer: CustomerDetail; recentOrders: CustomerOrder[]; audit: CustomerAuditEntry[] }>(`/admin/customers/${enc(id)}`, {}, signal);
export const updateCustomer = (id: string, body: { name?: string; email?: string; phone?: string }) =>
  apiSend<{ customer: CustomerDetail }>('PATCH', `/admin/customers/${enc(id)}`, body);
export const deactivateCustomer = (id: string) => apiSend<{ customer: CustomerDetail }>('POST', `/admin/customers/${enc(id)}/deactivate`);
export const reactivateCustomer = (id: string) => apiSend<{ customer: CustomerDetail }>('POST', `/admin/customers/${enc(id)}/reactivate`);
