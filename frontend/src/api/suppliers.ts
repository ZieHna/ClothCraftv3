import { apiGet, apiSend } from './client';

/**
 * The staff dashboard's supplier calls (phase 5). The shapes below are the ones the real service answered on a throwaway copy of the shop:
 *   GET    /api/staff/suppliers?q&status&page&pageSize  -> {total, page, pageSize, suppliers: SupplierSummary[], totals: SupplierTotals, attention: SupplierAttention}
 *   GET    /api/staff/suppliers/:id                      -> {supplier: SupplierDetail}            | 404 not_found
 *   POST   /api/staff/suppliers (201) / PATCH /api/staff/suppliers/:id -> {supplier}
 *   POST   /api/staff/suppliers/:id/lines (201), PATCH /api/staff/supplier-lines/:id   -> {line, supplier}
 *   DELETE /api/staff/supplier-lines/:id                  -> {supplier}
 *   POST   /api/staff/suppliers/:id/ranges (201), PATCH /api/staff/supplier-ranges/:id -> {range, supplier}
 *   DELETE /api/staff/supplier-ranges/:id                 -> {supplier}
 *   POST   /api/staff/suppliers/:id/{deactivate,reactivate,switch-off,switch-on}  (Administrator) -> {supplier} | 403 forbidden
 *   PUT    /api/staff/suppliers/:id/opening-balance {openingBalance} (Administrator) -> {supplier} | 403 forbidden | 422 validation
 *   GET    /api/staff/garment-options                     -> {garmentTypes}
 * Every change answers with the whole supplier as it is now, so a screen never works out a total or a count itself. Money is a plain number
 * (2 decimals); the VAT and net parts are the server's, never worked out here. Errors: {error: {code, message, fields?}}; 422 `fields` is
 * {camelCaseName: sentence}; a 403 `forbidden` carries a sentence for people (an inactive or switched-off supplier is changed by an
 * Administrator only).
 */
export type SupplierStatus = 'available' | 'unavailable_range' | 'off' | 'inactive';

export interface SupplierSummary {
  id: string;
  name: string;
  contactName: string;
  city: string;
  phone: string | null;
  active: boolean;
  permanentlyOff: boolean;
  status: SupplierStatus;
  availableNow: boolean;
  ships: boolean;
  shippingFee: number;
  /** received restocks only (VAT included, VAT, net): what profit and DSS read as spending; never mix them with the opening balance */
  totalSpent: number;
  totalSpentVat: number;
  totalSpentNet: number;
  /** the existing stock treated as bought from this supplier: a STARTING INVESTMENT (VAT included), never a monthly cost; set by an Administrator */
  openingBalance: number;
  openingBalanceVat: number;
  openingBalanceNet: number;
  /** opening balance plus received restocks, the VAT and net parts added part by part */
  combinedTotal: number;
  combinedTotalVat: number;
  combinedTotalNet: number;
  receivedCount: number;
  lineCount: number;
  rangeCount: number;
  lastEditedBy: string | null;
  /** ISO time with a Z */
  lastEditedAt: string | null;
}

export interface SupplyLine {
  id: string;
  supplierId: string;
  garmentType: { id: string; code: string; name: string };
  size: { id: string; name: string };
  color: { id: string; name: string };
  /** entered with VAT included */
  unitCost: number;
  unitCostVat: number;
  unitCostNet: number;
}

export interface UnavailableRange {
  id: string;
  supplierId: string;
  /** YYYY-MM-DD */
  dateFrom: string;
  dateTo: string;
  reason: string | null;
}

export interface SupplierDetail extends SupplierSummary {
  street: string;
  street2: string | null;
  zip: string | null;
  countryCode: string | null;
  country: string | null;
  shippingFeeVat: number;
  shippingFeeNet: number;
  partnerId: string;
  lines: SupplyLine[];
  ranges: UnavailableRange[];
}

/** Over ALL the company's suppliers, inactive ones included, whatever the page, search or status filter. Added up by the server. */
export interface SupplierTotals {
  supplierCount: number;
  openingBalance: number;
  openingBalanceVat: number;
  openingBalanceNet: number;
  receivedTotal: number;
  receivedVat: number;
  receivedNet: number;
  combinedTotal: number;
  combinedVat: number;
  combinedNet: number;
}

/**
 * What needs a look, over ALL suppliers (never the page, the search or the status filter), worked out in Odoo: who cannot supply now (switched off,
 * inactive, or inside an unavailable range, with the end of that range and its reason), unavailable ranges starting within 30 days, and the garment
 * types that at most one available supplier can supply (`supplier` is null when none can). Dates are ISO Manila days.
 */
export interface SupplierAttention {
  unavailableNow: { id: string; name: string; status: 'inactive' | 'off' | 'unavailable_range'; until: string | null; reason: string | null }[];
  comingUp: { supplierId: string; name: string; dateFrom: string; dateTo: string; reason: string | null }[];
  coverageRisk: { garmentType: { id: string; code: string; name: string }; supplier: { id: string; name: string } | null }[];
}

export interface SupplierList {
  totals: SupplierTotals;
  attention: SupplierAttention;
  total: number;
  page: number;
  pageSize: number;
  suppliers: SupplierSummary[];
}

export interface SupplierBody {
  name?: string;
  contactName?: string;
  street?: string;
  street2?: string;
  city?: string;
  zip?: string;
  phone?: string;
  countryCode?: string;
  ships?: boolean;
  shippingFee?: number;
}
export interface LineBody {
  garmentTypeId?: string;
  sizeValueId?: string;
  colorValueId?: string;
  unitCost?: number;
}
export interface RangeBody {
  dateFrom?: string;
  dateTo?: string;
  reason?: string;
}

export interface GarmentOption {
  id: string;
  code: string;
  name: string;
  sizes: { id: string; name: string }[];
  colors: { id: string; name: string; html: string }[];
  /** the valid [sizeId, colourId] pairs */
  combos: [string, string][];
}

export type SupplierAction = 'deactivate' | 'reactivate' | 'switch-off' | 'switch-on';

const enc = encodeURIComponent;

export const listSuppliers = (query: { q?: string; status?: string; page?: number; pageSize?: number }, signal?: AbortSignal) =>
  apiGet<SupplierList>('/staff/suppliers', { q: query.q, status: query.status, page: query.page ? String(query.page) : undefined, pageSize: query.pageSize ? String(query.pageSize) : undefined }, signal);
export const getSupplier = (id: string, signal?: AbortSignal) => apiGet<{ supplier: SupplierDetail }>(`/staff/suppliers/${enc(id)}`, {}, signal);
export const createSupplier = (body: SupplierBody) => apiSend<{ supplier: SupplierDetail }>('POST', '/staff/suppliers', body);
export const updateSupplier = (id: string, body: SupplierBody) => apiSend<{ supplier: SupplierDetail }>('PATCH', `/staff/suppliers/${enc(id)}`, body);
export const addSupplyLine = (supplierId: string, body: LineBody) => apiSend<{ line: SupplyLine; supplier: SupplierDetail }>('POST', `/staff/suppliers/${enc(supplierId)}/lines`, body);
export const updateSupplyLine = (id: string, body: LineBody) => apiSend<{ line: SupplyLine; supplier: SupplierDetail }>('PATCH', `/staff/supplier-lines/${enc(id)}`, body);
export const removeSupplyLine = (id: string) => apiSend<{ supplier: SupplierDetail }>('DELETE', `/staff/supplier-lines/${enc(id)}`);
export const addRange = (supplierId: string, body: RangeBody) => apiSend<{ range: UnavailableRange; supplier: SupplierDetail }>('POST', `/staff/suppliers/${enc(supplierId)}/ranges`, body);
export const updateRange = (id: string, body: RangeBody) => apiSend<{ range: UnavailableRange; supplier: SupplierDetail }>('PATCH', `/staff/supplier-ranges/${enc(id)}`, body);
export const removeRange = (id: string) => apiSend<{ supplier: SupplierDetail }>('DELETE', `/staff/supplier-ranges/${enc(id)}`);
export const setOpeningBalance = (id: string, openingBalance: number) =>
  apiSend<{ supplier: SupplierDetail }>('PUT', `/staff/suppliers/${enc(id)}/opening-balance`, { openingBalance });
export const supplierAction = (id: string, action: SupplierAction) => apiSend<{ supplier: SupplierDetail }>('POST', `/staff/suppliers/${enc(id)}/${action}`);
export const getGarmentOptions = (signal?: AbortSignal) => apiGet<{ garmentTypes: GarmentOption[] }>('/staff/garment-options', {}, signal);
