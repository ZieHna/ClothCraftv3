import type { DesignedOrderLine, DesignedQuoteLine, OrderLine, PrintFee, Quote, QuoteLine } from '../api/types';
import { formatMoney } from '../lib/format';
import type { CartLine } from './cartStore';

/** A quote or order line with a design (step 9). A plain line has no designId. */
export function isDesigned(line: QuoteLine): line is DesignedQuoteLine;
export function isDesigned(line: OrderLine): line is DesignedOrderLine;
export function isDesigned(line: QuoteLine | OrderLine): boolean {
  return typeof (line as { designId?: unknown }).designId === 'string';
}

/** The server's line for a cart line: the same SKU and the same design (or none). */
export const pricedFor = (quote: Quote | null, line: Pick<CartLine, 'sku' | 'designId'>) =>
  quote?.lines.find((q) => q.sku === line.sku && (isDesigned(q) ? q.designId : undefined) === line.designId);

/** "Print fee 12.00 sq in · ₱44.00 × 2" */
export const printFeeText = (fee: PrintFee, quantity: number, currency: string) =>
  `Print fee ${fee.coveredSqIn.toFixed(2)} sq in · ${formatMoney(fee.unit, currency)} × ${quantity}`;

/** The note when the editor's estimate and the shop's figure differ; null when they agree (or there is no estimate). */
export function estimateNote(estimate: number | undefined, fee: PrintFee | null, currency: string): string | null {
  if (estimate === undefined || !fee || Math.abs(estimate - fee.unit) < 0.005) return null;
  return `Estimated ${formatMoney(estimate, currency)} in the editor; the shop's figure is ${formatMoney(fee.unit, currency)}.`;
}

/** The address that opens a cart design in the editor again. */
export const editDesignPath = (line: Pick<CartLine, 'sku' | 'productId' | 'designId'>) =>
  `/design?product=${encodeURIComponent(line.productId)}&variant=${encodeURIComponent(line.sku)}&design=${encodeURIComponent(line.designId ?? '')}`;
