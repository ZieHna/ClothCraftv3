import type { StockStatus } from '../api/types';

const LABEL: Record<StockStatus, string> = { in_stock: 'In stock', low_stock: 'Low stock', out_of_stock: 'Sold out' };
// the status is always spelled out in words; colour and the dot only help. Contrast is 5:1 or better on cream and paper.
const STYLE: Record<StockStatus, { box: string; dot: string }> = {
  in_stock: { box: 'border-sage-dark text-sage-dark', dot: 'bg-sage-dark' },
  low_stock: { box: 'border-brown-dark bg-paper-warm text-brown-dark', dot: 'bg-brown-dark' },
  out_of_stock: { box: 'border-muted bg-paper-warm text-muted', dot: 'border border-muted bg-transparent' },
};

/** The stock status exactly as the API sent it. */
export function StockBadge({ status, className = '' }: { status: StockStatus; className?: string }) {
  const style = STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${style.box} ${className}`}>
      <span aria-hidden="true" className={`size-2 rounded-full ${style.dot}`} />
      {LABEL[status]}
    </span>
  );
}
