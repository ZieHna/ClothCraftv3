import type { Quote } from '../api/types';
import { formatMoney } from '../lib/format';

type Totals = Pick<Quote, 'currency' | 'deliveryFee' | 'deliveryLabel' | 'total' | 'vatAmount' | 'vatRate' | 'vatIncluded'>;

/**
 * Delivery, total and the VAT inside it, exactly as the server sent them. `stale` greys them while a new price is on its way.
 * `vat` false leaves the VAT line out: the cart shows the total only, the VAT is stated at checkout and on the order (step 9).
 */
export function QuoteTotals({ quote, stale = false, vat = true }: { quote: Totals; stale?: boolean; vat?: boolean }) {
  const money = (n: number) => formatMoney(n, quote.currency);
  return (
    <dl className={`grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      <dt>Delivery</dt>
      <dd className="text-right" data-testid="delivery-fee">
        {quote.deliveryFee > 0 ? money(quote.deliveryFee) : quote.deliveryLabel}
      </dd>
      <dt className="mt-1 text-lg font-semibold text-ink">Total</dt>
      <dd className="mt-1 text-right text-2xl font-semibold text-ink" data-testid="quote-total">
        {stale ? '…' : money(quote.total)}
      </dd>
      {vat && quote.vatIncluded && (
        <dt className="col-span-2 text-sm text-muted" data-testid="quote-vat">
          All prices are in PHP and include {quote.vatRate}% VAT{stale ? '' : `: ${money(quote.vatAmount)} of the total`}.
        </dt>
      )}
    </dl>
  );
}
