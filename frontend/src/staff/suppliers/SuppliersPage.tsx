import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useWorkspace } from '../workspace';
import { ApiError } from '../../api/client';
import { listSuppliers, type SupplierList, type SupplierTotals } from '../../api/suppliers';
import { StaffListSkeleton } from '../../components/skeleton/routeSkeletons';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { PAGE_SIZE, pesos, STATUS_FILTER } from './supplierText';
import { AttentionPanel } from './AttentionPanel';
import { control, StatusBadge } from './supplierUi';

type Load = { phase: 'loading' } | { phase: 'ready'; data: SupplierList } | { phase: 'error'; message: string };

const COLUMNS = ['Company', 'Contact', 'City', 'Status', 'Shipping', 'Total spent (VAT included)'];

/** Every supplier (inactive ones too), with a search and a status filter. The filters live in the address, so a view can be shared and Back works. */
export function SuppliersPage() {
  const w = useWorkspace();
  const [params, setParams] = useSearchParams();
  const ids = useId();
  const status = STATUS_FILTER.some((s) => s.id && s.id === params.get('status')) ? (params.get('status') as string) : '';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  // the last answer: a new filter or page keeps it on screen (dimmed), so only the FIRST load has a skeleton
  const [last, setLast] = useState<SupplierList | null>(null);
  const [attempt, setAttempt] = useState(0);

  const change = (next: Partial<{ status: string; q: string; page: number }>) => {
    const merged = { status, q, ...next, page: next.page ?? 1 };
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v && !(k === 'page' && v === 1)) out.set(k, String(v));
    setParams(out);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    listSuppliers({ q: q || undefined, status: status || undefined, page, pageSize: PAGE_SIZE }, controller.signal)
      .then((response) => {
        setLoad({ phase: 'ready', data: response.data });
        setLast(response.data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the suppliers.' });
      });
    return () => controller.abort();
  }, [q, status, page, attempt]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    change({ q: draft.trim() });
  };
  const filtered = Boolean(q || status);
  const data = load.phase === 'ready' ? load.data : load.phase === 'loading' ? last : null;
  const gate = useSkeletonGate(load.phase === 'loading' && !last, { immediate: load.phase === 'error' || (!!data && data.suppliers.length === 0), minMs: STAFF_MIN_SKELETON_MS });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-4xl sm:text-5xl">Suppliers</h1>
        <Link to={w.supplierNew} className="btn btn-primary" data-testid="supplier-add">
          Add supplier
        </Link>
      </div>

      <form onSubmit={apply} role="search" aria-label="Find suppliers" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end" data-testid="supplier-filters">
        <div>
          <label htmlFor={`${ids}-q`} className="block text-sm font-medium">
            Search
          </label>
          <input id={`${ids}-q`} type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Company or contact name" maxLength={100} className={control} />
        </div>
        <div>
          <label htmlFor={`${ids}-status`} className="block text-sm font-medium">
            Status
          </label>
          <select id={`${ids}-status`} value={status} onChange={(e) => change({ status: e.target.value })} className={control}>
            {STATUS_FILTER.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary">
            Search
          </button>
          {filtered && (
            <button type="button" className="btn btn-secondary" onClick={() => setParams(new URLSearchParams())}>
              Clear
            </button>
          )}
        </div>
      </form>

      <div className={`mt-6 ${load.phase === 'loading' && last ? 'opacity-60' : ''}`} aria-live="polite" aria-busy={load.phase === 'loading'}>
        {gate !== 'content' && <StaffListSkeleton gate={gate} label="Loading suppliers…" />}
        {gate === 'content' && load.phase === 'error' && (
          <div role="alert">
            <p className="font-medium text-brown-dark">{load.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && data && (
          <div className="mb-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
            <AttentionPanel attention={data.attention} />
            <TotalsBlock totals={data.totals} />
          </div>
        )}
        {gate === 'content' && data && data.suppliers.length === 0 && (
          <p data-testid="supplier-empty">
            {filtered ? 'No suppliers match these filters.' : 'There are no suppliers yet. Add the first one.'}
            {filtered && (
              <>
                {' '}
                <button type="button" className="underline underline-offset-4" onClick={() => setParams(new URLSearchParams())}>
                  Clear the filters
                </button>
              </>
            )}
          </p>
        )}
        {gate === 'content' && data && data.suppliers.length > 0 && (
          <>
            <p className="text-sm text-muted" data-testid="supplier-count">
              Showing {(data.page - 1) * data.pageSize + 1} to {(data.page - 1) * data.pageSize + data.suppliers.length} of {data.total} {data.total === 1 ? 'supplier' : 'suppliers'}
            </p>
            <table className="mt-3 block w-full text-left md:table" data-testid="supplier-table">
              <caption className="sr-only">Suppliers</caption>
              <thead className="sr-only md:not-sr-only md:table-header-group">
                <tr className="border-b border-brown-dark text-sm text-muted">
                  {COLUMNS.map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="block space-y-3 md:table-row-group md:space-y-0">
                {data.suppliers.map((s) => (
                  <tr key={s.id} data-testid="supplier-row" data-status={s.status} className="block border border-tan bg-cream p-3 md:table-row md:border-0 md:border-b md:bg-transparent md:p-0">
                    <Cell label="Company">
                      <Link to={w.supplier(s.id)} className="min-w-0 break-words text-right font-semibold text-ink underline underline-offset-4 md:text-left">
                        {s.name}
                      </Link>
                    </Cell>
                    <Cell label="Contact">
                      <span className="min-w-0 break-words text-right md:text-left">{s.contactName}</span>
                    </Cell>
                    <Cell label="City">{s.city}</Cell>
                    <Cell label="Status">
                      <span className="text-right md:text-left">
                        <StatusBadge status={s.status} />
                        {s.status === 'unavailable_range' && s.rangeCount > 0 && (
                          <span className="mt-1 block text-xs text-muted">
                            {s.rangeCount} date {s.rangeCount === 1 ? 'range' : 'ranges'}, see the supplier
                          </span>
                        )}
                      </span>
                    </Cell>
                    <Cell label="Shipping">{s.ships ? pesos(s.shippingFee) : 'None'}</Cell>
                    <Cell label="Total spent">
                      <span className="font-semibold text-ink">{pesos(s.combinedTotal)}</span>
                    </Cell>
                  </tr>
                ))}
              </tbody>
            </table>

            <nav aria-label="Pages" className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <button type="button" className="btn btn-secondary" disabled={data.page <= 1} onClick={() => change({ page: data.page - 1 })}>
                Previous
              </button>
              <p className="text-sm" data-testid="supplier-page">
                Page {data.page} of {pages}
              </p>
              <button type="button" className="btn btn-secondary" disabled={data.page >= pages} onClick={() => change({ page: data.page + 1 })}>
                Next
              </button>
            </nav>
          </>
        )}
      </div>
    </section>
  );
}

/** A table cell that, on a narrow screen, becomes a "label, value" line of a card (the label is drawn from data-label). */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <td
      data-label={label}
      className="flex items-start justify-between gap-4 py-1 before:shrink-0 before:text-sm before:font-medium before:text-muted before:content-[attr(data-label)] md:table-cell md:px-3 md:py-3 md:align-top md:before:hidden"
    >
      {children}
    </td>
  );
}

/**
 * The money across ALL suppliers, added up by the server: it does not change with the search, the filter or the page. The opening balance is
 * the existing stock treated as bought from the suppliers (a starting investment); received restocks are what has been bought since.
 */
function TotalsBlock({ totals }: { totals: SupplierTotals }) {
  return (
    <aside aria-label="Totals for all suppliers" className="min-w-0 border border-tan bg-cream p-4 md:min-w-80" data-testid="supplier-totals">
      <p className="text-sm font-medium text-muted">Total spent, all suppliers (VAT included)</p>
      <p className="text-3xl font-semibold text-ink" data-testid="totals-combined">
        {pesos(totals.combinedTotal)}
      </p>
      <dl className="mt-2 space-y-0.5 text-sm text-muted">
        <div className="flex justify-between gap-6">
          <dt>Opening balance (existing stock)</dt>
          <dd data-testid="totals-opening">{pesos(totals.openingBalance)}</dd>
        </div>
        <div className="flex justify-between gap-6">
          <dt>Received restocks</dt>
          <dd data-testid="totals-received">{pesos(totals.receivedTotal)}</dd>
        </div>
        <div className="flex justify-between gap-6">
          <dt>Net, without VAT</dt>
          <dd data-testid="totals-net">{pesos(totals.combinedNet)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted">Includes inactive suppliers. Not affected by the search, the filter or the page.</p>
    </aside>
  );
}
