import { apiGet } from './client';
import type { DashboardRange } from './adminDashboard';

/**
 * The admin Orders page (step 7f), counts only: GET /api/admin/orders/summary?range=this_month|last_3_months|last_12_months|all. Every number is counted
 * in Odoo; no amounts. In progress is "right now" (not limited by the range). Success (closed) and failed (cancelled) are the orders PLACED
 * in the range (Asia/Manila days), by their state now. `received_preparing` also holds any legacy "packed" order, as the board counts them.
 * Success is CLOSED orders only (confirmed by the customer, or closed by the shop after the auto-close days); a delivered order is still waiting for that
 * and is counted right now in `deliveredWaiting`, with the age of the oldest since its delivery. Failed is cancelled orders.
 * 401 unauthorised, 403 forbidden (an employee cookie is not an admin session), 422 validation (a range that does not exist).
 */
export interface OrdersSummary {
  /** `from` is null for all time */
  range: { key: DashboardRange; from: string | null; to: string; timezone: string };
  generatedAt: string;
  inProgress: {
    /** `oldestDays`: whole days since the oldest unpaid order was placed, or null when none is waiting */
    awaitingPayment: { count: number; oldestDays: number | null };
    receivedPreparing: { count: number };
    shipped: { count: number };
    onDelivery: { count: number };
    /** delivered, not yet confirmed by the customer; `oldestDays` is since its delivery, or null when none is waiting */
    deliveredWaiting: { count: number; oldestDays: number | null };
  };
  success: { closed: number };
  failed: { cancelled: number };
}

export const getOrdersSummary = (range: DashboardRange, signal?: AbortSignal) => apiGet<OrdersSummary>('/admin/orders/summary', { range }, signal);
