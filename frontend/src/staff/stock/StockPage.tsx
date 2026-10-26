import { lazy, Suspense, useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useWorkspace } from '../workspace';
import { ApiError } from '../../api/client';
import { listStock, type StockList, type StockVariant } from '../../api/inventory';
import { StaffListSkeleton } from '../../components/skeleton/routeSkeletons';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { Cell, control } from '../suppliers/supplierUi';
import { EditStockDialog } from './EditStockDialog';
import type { ThresholdTarget } from './ThresholdDialog';

// the level editors are the Administrator's: a chunk of their own, asked for only inside the admin workspace
const ThresholdDialog = lazy(async () => ({ default: (await import('./ThresholdDialog')).ThresholdDialog }));

type Load = { phase: 'loading' } | { phase: 'ready'; data: StockList } | { phase: 'error'; message: string };
const PAGE_SIZE = 25;
const COLUMNS = ['Variant', 'On hand', 'Reserved', 'Low-stock level', 'Alert at', 'Actions'];

/**
 * Every variant with what is on hand and what orders hold, a Low badge, search and a "Low only" filter; stock can be corrected from here.
 * Under /admin the Administrator can also set the shop-wide low-stock level and a level of a variant's own; the level that applies and the Low
 * badge are always the server's. Under /staff those buttons do not exist (and the server refuses the calls).
 */
export function StockPage() {
  const w = useWorkspace();
  const [params, setParams] = useSearchParams();
  const ids = useId();
  const q = params.get('q') ?? '';
  const low = params.get('low') === 'true';
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [last, setLast] = useState<StockList | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<StockVariant | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [level, setLevel] = useState<ThresholdTarget | null>(null);
  const admin = w.kind === 'admin';

  const change = (next: Partial<{ q: string; low: boolean; page: number }>) => {
    const merged = { q, low, ...next, page: next.page ?? 1 };
    const out = new URLSearchParams();
    if (merged.q) out.set('q', merged.q);
    if (merged.low) out.set('low', 'true');
    if (merged.page > 1) out.set('page', String(merged.page));
    setParams(out);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    listStock({ q: q || undefined, low, page, pageSize: PAGE_SIZE }, controller.signal)
      .then((response) => {
        setLoad({ phase: 'ready', data: response.data });
        setLast(response.data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the stock.' });
      });
    return () => controller.abort();
  }, [q, low, page, attempt]);

  // after an edit the row is replaced by the server's answer, so the page shows the new number without a reload
  const saved = (variant: StockVariant, message: string) => {
    const swap = (d: StockList): StockList => ({ ...d, variants: d.variants.map((v) => (v.id === variant.id ? variant : v)) });
    setLoad((current) => (current.phase === 'ready' ? { phase: 'ready', data: swap(current.data) } : current));
    setLast((current) => (current ? swap(current) : current));
    setDone(message);
    setEditing(null);
  };

  // a level was saved: a variant's own row is replaced by the server's; a shop-wide level can change any row, so the list is read again
  const levelSaved = (message: string, variant?: StockVariant) => {
    setLevel(null);
    if (variant) saved(variant, message);
    else {
      setDone(message);
      setAttempt((a) => a + 1);
    }
  };

  const apply = (event: FormEvent) => {
    event.preventDefault();
    change({ q: draft.trim() });
  };
  const filtered = Boolean(q || low);
  const data = load.phase === 'ready' ? load.data : load.phase === 'loading' ? last : null;
  const gate = useSkeletonGate(load.phase === 'loading' && !last, { immediate: load.phase === 'error' || (!!data && data.variants.length === 0), minMs: STAFF_MIN_SKELETON_MS });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-4xl sm:text-5xl">Stock</h1>
        <div className="flex flex-wrap gap-2">
          <Link to={w.stockHistory} className="btn btn-secondary" data-testid="stock-history-link">
            Stock edit history
          </Link>
        </div>
      </div>
      {data && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted" data-testid="stock-global">
            The shop-wide low-stock level is {data.globalThreshold}. A variant can have its own.
          </p>
          {admin && (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setLevel({ kind: 'global', value: data.globalThreshold })} data-testid="stock-global-change">
              Change the shop-wide level
            </button>
          )}
        </div>
      )}

      <form onSubmit={apply} role="search" aria-label="Find stock" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_auto_auto] sm:items-end" data-testid="stock-filters">
        <div>
          <label htmlFor={`${ids}-q`} className="block text-sm font-medium">
            Search
          </label>
          <input id={`${ids}-q`} type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Name or SKU" maxLength={100} className={control} />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={low} onChange={(e) => change({ low: e.target.checked })} className="size-5 accent-sage-dark" />
          Low only
        </label>
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

      {done && (
        <p role="status" className="mt-4 font-medium text-sage-dark" data-testid="stock-done">
          {done}
        </p>
      )}

      <div className={`mt-6 ${load.phase === 'loading' && last ? 'opacity-60' : ''}`} aria-live="polite" aria-busy={load.phase === 'loading'}>
        {gate !== 'content' && <StaffListSkeleton gate={gate} label="Loading stock…" />}
        {gate === 'content' && load.phase === 'error' && (
          <div role="alert">
            <p className="font-medium text-brown-dark">{load.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && data && data.variants.length === 0 && (
          <p data-testid="stock-empty">
            {filtered ? 'No variants match these filters.' : 'There are no variants yet.'}
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
        {gate === 'content' && data && data.variants.length > 0 && (
          <>
            <p className="text-sm text-muted" data-testid="stock-count">
              Showing {(data.page - 1) * data.pageSize + 1} to {(data.page - 1) * data.pageSize + data.variants.length} of {data.total} {data.total === 1 ? 'variant' : 'variants'}
            </p>
            <table className="mt-3 block w-full text-left md:table" data-testid="stock-table">
              <caption className="sr-only">Stock by variant</caption>
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
                {data.variants.map((v) => (
                  <tr key={v.id} data-testid="stock-row" data-low={v.low || undefined} className="block border border-tan bg-cream p-3 md:table-row md:border-0 md:border-b md:bg-transparent md:p-0">
                    <Cell label="Variant">
                      <span className="min-w-0 break-words text-right md:text-left">
                        <span className="block font-semibold text-ink">{v.sku ?? v.name}</span>
                        <span className="block text-sm text-muted">{v.name}</span>
                      </span>
                    </Cell>
                    <Cell label="On hand">
                      <span className="text-right md:text-left">
                        <span className="font-semibold text-ink">{v.onHand}</span>
                        {v.low && (
                          <span className="ml-2 inline-block rounded-sm border border-brown-dark bg-cream px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-brown-dark" data-testid="stock-low">
                            Low
                          </span>
                        )}
                      </span>
                    </Cell>
                    <Cell label="Reserved">{v.reserved}</Cell>
                    <Cell label="Low-stock level">{v.threshold === null ? 'Shop level' : v.threshold}</Cell>
                    <Cell label="Alert at">{v.effectiveThreshold}</Cell>
                    <Cell label="Actions">
                      <span className="flex flex-wrap justify-end gap-2 md:justify-start">
                        <button type="button" className="btn btn-secondary btn-small" onClick={() => setEditing(v)} aria-label={`Edit stock of ${v.sku ?? v.name}`}>
                          Edit stock
                        </button>
                        {admin && (
                          <button type="button" className="btn btn-secondary btn-small" onClick={() => setLevel({ kind: 'variant', variant: v })} aria-label={`Set the low-stock level of ${v.sku ?? v.name}`} data-testid="stock-level">
                            Set level
                          </button>
                        )}
                        <Link to={`${w.stockHistory}?productId=${v.id}`} className="btn btn-secondary btn-small" aria-label={`Stock history of ${v.sku ?? v.name}`}>
                          History
                        </Link>
                      </span>
                    </Cell>
                  </tr>
                ))}
              </tbody>
            </table>

            <nav aria-label="Pages" className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <button type="button" className="btn btn-secondary" disabled={data.page <= 1} onClick={() => change({ page: data.page - 1 })}>
                Previous
              </button>
              <p className="text-sm" data-testid="stock-page">
                Page {data.page} of {pages}
              </p>
              <button type="button" className="btn btn-secondary" disabled={data.page >= pages} onClick={() => change({ page: data.page + 1 })}>
                Next
              </button>
            </nav>
          </>
        )}
      </div>
      {admin && level && (
        <Suspense fallback={null}>
          <ThresholdDialog target={level} onSaved={levelSaved} onClose={() => setLevel(null)} />
        </Suspense>
      )}
      {editing && <EditStockDialog variant={editing} onSaved={saved} onClose={() => setEditing(null)} />}
    </section>
  );
}
