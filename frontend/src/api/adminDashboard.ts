import { apiGet } from './client';

/**
 * The admin dashboard's summary (step 7b), read-only: GET /api/admin/dashboard?range=this_month|last_3_months|last_12_months|all. Every figure is
 * worked out in Odoo (VAT with the one vat_split helper, in Asia/Manila time); the page only displays them and sizes bars by value / largest value.
 * EARNED revenue is CLOSED orders only (the customer confirmed, or the shop closed it by itself), in the Manila month the order CLOSED (an order
 * with no "closed" history line falls back to its delivered line, then to the day it was placed). Delivered orders still waiting for that are a
 * separate figure, `deliveredAwaiting` (and `pending` per month, by the month they were delivered): never earnings, never added to them. The suppliers' opening balance is a starting investment: it is never part of any month or period.
 * 401 unauthorised (no live admin session), 403 forbidden (an employee cookie is not an admin session), 422 validation (a range that does not exist).
 */
export type DashboardRange = 'this_month' | 'last_3_months' | 'last_12_months' | 'all';
/** The time ranges the admin pages offer, in the order they are listed. */
export const DASHBOARD_RANGES: { id: DashboardRange; label: string }[] = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_3_months', label: 'Last 3 months' },
  { id: 'last_12_months', label: 'Last 12 months' },
  { id: 'all', label: 'All time' },
];
export const DEFAULT_RANGE: DashboardRange = 'last_12_months';

export interface Money {
  total: number;
  vat: number;
  net: number;
}
export interface MonthRevenue extends Money {
  /** YYYY-MM, Manila */
  month: string;
  /** closed orders in this month (earned) */
  orders: number;
  /** delivered orders awaiting the customer's confirmation, by the month they were delivered: not earnings */
  pending: Money & { orders: number };
}
export interface StatusCount {
  state: string;
  label: string;
  count: number;
}
export interface AlertVariant {
  id: string;
  sku: string | null;
  name: string;
  onHand: number;
  reserved: number;
  free: number;
  alertAt: number;
}
export interface QueuedRestock {
  id: string;
  name: string;
  supplier: { id: string; name: string };
  lineCount: number;
  estimateTotal: number;
  requestedBy: string;
  requestedAt: string;
}
export interface SupplierSpendRow {
  id: string;
  name: string;
  active: boolean;
  openingBalance: number;
  receivedTotal: number;
  receivedCount: number;
}
export interface TopGarmentType {
  code: string;
  name: string;
  units: number;
  revenue: number;
}

export interface AdminDashboard {
  range: { key: DashboardRange; from: string; to: string; timezone: string };
  generatedAt: string;
  kpis: {
    /** earned: closed orders only */
    revenue: Money & { orderCount: number };
    /** delivered, awaiting confirmation: not earnings */
    deliveredAwaiting: Money & { orderCount: number };
    orders: { placed: number; cancelled: number };
    lowStock: { count: number; variants: number };
    restocksWaiting: { count: number; estimateTotal: number };
  };
  revenueByMonth: MonthRevenue[];
  ordersByStatus: StatusCount[];
  stockAlerts: { count: number; variants: AlertVariant[] };
  restockQueue: { requested: number; approved: number; notReceived: number; oldestWaiting: QueuedRestock[] };
  supplierSpend: {
    openingBalance: Money;
    received: Money & { count: number };
    suppliers: SupplierSpendRow[];
  };
  topGarmentTypes: TopGarmentType[];
}

export const getAdminDashboard = (range: DashboardRange, signal?: AbortSignal) => apiGet<AdminDashboard>('/admin/dashboard', { range }, signal);
