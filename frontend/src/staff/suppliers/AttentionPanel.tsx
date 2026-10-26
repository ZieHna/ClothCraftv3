import { Link } from 'react-router';
import type { SupplierAttention } from '../../api/suppliers';
import { useWorkspace } from '../workspace';
import { formatDay } from './supplierText';

const SHOWN_UNTIL = 'unavailable until';

/**
 * "Needs attention" on the Suppliers page: who cannot supply now, which unavailable dates are coming up, and which garment types depend on one
 * supplier (or on none). Everything is worked out in Odoo over ALL suppliers; this only writes it down. The status is always in words, never in
 * colour alone, and every supplier name links to its page in the current workspace (/staff or /admin).
 */
export function AttentionPanel({ attention }: { attention: SupplierAttention }) {
  const w = useWorkspace();
  const { unavailableNow, comingUp, coverageRisk } = attention;
  const quiet = unavailableNow.length === 0 && comingUp.length === 0 && coverageRisk.length === 0;
  const name = (id: string, text: string) => (
    <Link to={w.supplier(id)} className="font-semibold text-ink underline underline-offset-4">
      {text}
    </Link>
  );
  return (
    <section aria-labelledby="attention-h" className="min-w-0 border border-tan bg-cream p-4" data-testid="supplier-attention">
      <h2 id="attention-h" className="text-xl">
        Needs attention
      </h2>
      <p className="text-xs text-muted">Not affected by the search, the filter or the page.</p>

      {quiet ? (
        <p className="mt-3 flex items-center gap-2 font-medium text-ink" data-testid="attention-clear">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-sage-dark">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
          All suppliers are available.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {unavailableNow.length > 0 && (
            <div data-testid="attention-unavailable">
              <h3 className="text-sm font-semibold">Unavailable now</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {unavailableNow.map((s) => (
                  <li key={s.id}>
                    {name(s.id, s.name)}:{' '}
                    {s.status === 'inactive' ? (
                      'inactive'
                    ) : s.status === 'off' ? (
                      'switched off, no return date'
                    ) : (
                      <>
                        {SHOWN_UNTIL} {s.until ? formatDay(s.until) : '—'}
                        {s.reason ? ` (${s.reason})` : ''}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {comingUp.length > 0 && (
            <div data-testid="attention-coming">
              <h3 className="text-sm font-semibold">Coming up, in the next 30 days</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {comingUp.map((r) => (
                  <li key={`${r.supplierId}-${r.dateFrom}`}>
                    {name(r.supplierId, r.name)}: unavailable from {formatDay(r.dateFrom)} to {formatDay(r.dateTo)}
                    {r.reason ? ` (${r.reason})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {coverageRisk.length > 0 && (
            <div data-testid="attention-coverage">
              <h3 className="text-sm font-semibold">Coverage risk</h3>
              <p className="text-xs text-muted">Garment types that one available supplier, or none, can supply.</p>
              <ul className="mt-1 space-y-1 text-sm">
                {coverageRisk.map((c) => (
                  <li key={c.garmentType.id} data-testid="coverage-row" data-level={c.supplier ? 'single' : 'none'}>
                    <span className="font-medium text-ink">{c.garmentType.name}:</span>{' '}
                    {c.supplier ? (
                      <>only {name(c.supplier.id, c.supplier.name)}</>
                    ) : (
                      <span className="inline-block border-2 border-ink bg-ink px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-cream">no available supplier</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
