import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useWorkspace } from '../workspace';
import { ApiError } from '../../api/client';
import { listRestocks, type RestockSummary } from '../../api/inventory';
import { listSuppliers, type SupplierSummary } from '../../api/suppliers';
import { StaffListSkeleton } from '../../components/skeleton/routeSkeletons';
import { formatWhen } from '../../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { formatDay, pesos } from '../suppliers/supplierText';
import { Cell, control } from '../suppliers/supplierUi';
import { PAGE_SIZE, RESTOCK_STATE_FILTER } from './restockText';
import { RestockBadges } from './RestockBadges';

type List = { total: number; page: number; pageSize: number; restocks: RestockSummary[] };
type Load = { phase: 'loading' } | { phase: 'ready'; data: List } | { phase: 'error'; message: string };
const COLUMNS = ['Ticket', 'Supplier', 'Requested', 'Expected', 'Lines', 'Total', 'Status'];

/** Every restock request, newest first, with its status and the late / overdue flags the server sets. Filters live in the address. */
export function RestocksPage() {
  const w = useWorkspace();
  const [params, setParams] = useSearchParams();
  const ids = useId();
  const state = RESTOCK_STATE_FILTER.some((s) => s.id && s.id === params.get('state')) ? (params.get('state') as string) : '';
  const supplierId = /^\d+$/.test(params.get('supplierId') ?? '') ? (params.get('supplierId') as string) : '';
  const late = params.get('late') === 'true';
  const overdue = params.get('overdue') === 'true';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [last, setLast] = useState<List | null>(null);
  const [attempt, setAttempt] = useState(0);
  // for the supplier filter: the first 100 suppliers (a limit of the dropdown; a longer list would need a search box)
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    listSuppliers({ pageSize: 100 }, controller.signal)
      .then((response) => setSuppliers(response.data.suppliers))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const change = (next: Partial<{ state: string; supplierId: string; late: boolean; overdue: boolean; q: string; page: number }>) => {
    const merged = { state, supplierId, late, overdue, q, ...next, page: next.page ?? 1 };
    const out = new URLSearchParams();
    if (merged.state) out.set('state', merged.state);
    if (merged.supplierId) out.set('supplierId', merged.supplierId);
    if (merged.late) out.set('late', 'true');
    if (merged.overdue) out.set('overdue', 'true');
    if (merged.q) out.set('q', merged.q);
    if (merged.page > 1) out.set('page', String(merged.page));
    setParams(out);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    listRestocks({ q: q || undefined, state: state || undefined, supplierId: supplierId || undefined, late, overdue, page, pageSize: PAGE_SIZE }, controller.signal)
      .then((response) => {
        setLoad({ phase: 'ready', data: response.data });
        setLast(response.data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the restocks.' });
      });
    return () => controller.abort();
  }, [q, state, supplierId, late, overdue, page, attempt]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    change({ q: draft.trim() });
  };
  const filtered = Boolean(q || state || supplierId || late || overdue);
  const data = load.phase === 'ready' ? load.data : load.phase === 'loading' ? last : null;
  const gate = useSkeletonGate(load.phase === 'loading' && !last, { immediate: load.phase === 'error' || (!!data && data.restocks.length === 0), minMs: STAFF_MIN_SKELETON_MS });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-4xl sm:text-5xl">Restocks</h1>
        <Link to={w.restockNew} className="btn btn-primary" data-testid="restock-add">
          Request a restock
        </Link>
      </div>

      <form onSubmit={apply} role="search" aria-label="Find restocks" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto]" data-testid="restock-filters">
        <div>
          <label htmlFor={`${ids}-q`} className="block text-sm font-medium">
            Search
          </label>
          <input id={`${ids}-q`} type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ticket or supplier" maxLength={100} className={control} />
        </div>
        <div>
          <label htmlFor={`${ids}-state`} className="block text-sm font-medium">
            Status
          </label>
          <select id={`${ids}-state`} value={state} onChange={(e) => change({ state: e.target.value })} className={control}>
            {RESTOCK_STATE_FILTER.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-sup`} className="block text-sm font-medium">
            Supplier
          </label>
          <select id={`${ids}-sup`} value={supplierId} onChange={(e) => change({ supplierId: e.target.value })} className={control}>
            <option value="">Any</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1 sm:col-span-2 lg:col-span-1">
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={late} onChange={(e) => change({ late: e.target.checked })} className="size-5 accent-sage-dark" />
            Received late
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={overdue} onChange={(e) => change({ overdue: e.target.checked })} className="size-5 accent-sage-dark" />
            Overdue
          </label>
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
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
        {gate !== 'content' && <StaffListSkeleton gate={gate} label="Loading restocks…" />}
        {gate === 'content' && load.phase === 'error' && (
          <div role="alert">
            <p className="font-medium text-brown-dark">{load.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && data && data.restocks.length === 0 && (
          <p data-testid="restock-empty">
            {filtered ? 'No restocks match these filters.' : 'There are no restocks yet.'}
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
        {gate === 'content' && data && data.restocks.length > 0 && (
          <>
            <p className="text-sm text-muted" data-testid="restock-count">
              Showing {(data.page - 1) * data.pageSize + 1} to {(data.page - 1) * data.pageSize + data.restocks.length} of {data.total} {data.total === 1 ? 'restock' : 'restocks'}
            </p>
            <table className="mt-3 block w-full text-left md:table" data-testid="restock-table">
              <caption className="sr-only">Restock requests, newest first</caption>
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
                {data.restocks.map((r) => (
                  <tr key={r.id} data-testid="restock-row" data-state={r.state} className="block border border-tan bg-cream p-3 md:table-row md:border-0 md:border-b md:bg-transparent md:p-0">
                    <Cell label="Ticket">
                      <Link to={w.restock(r.id)} className="font-semibold text-ink underline underline-offset-4">
                        {r.name}
                      </Link>
                    </Cell>
                    <Cell label="Supplier">
                      <span className="min-w-0 break-words text-right md:text-left">{r.supplier.name}</span>
                    </Cell>
                    <Cell label="Requested">
                      <span className="text-right md:text-left">
                        <span className="block">{formatWhen(r.requestedAt)}</span>
                        <span className="block text-sm text-muted">{r.requestedBy}</span>
                      </span>
                    </Cell>
                    <Cell label="Expected">
                      <span className="text-right md:text-left">
                        {formatDay(r.expectedFrom)} to {formatDay(r.expectedTo)}
                        {r.receivedOn && <span className="block text-sm text-muted">received {formatDay(r.receivedOn)}</span>}
                      </span>
                    </Cell>
                    <Cell label="Lines">{r.lineCount}</Cell>
                    <Cell label="Total">
                      <span className="text-right md:text-left">
                        <span className="block font-semibold text-ink">{pesos(r.actualCost ?? r.estimateTotal)}</span>
                        <span className="block text-xs text-muted">{r.actualCost === null ? 'estimate' : 'actual'}</span>
                      </span>
                    </Cell>
                    <Cell label="Status">
                      <RestockBadges restock={r} />
                    </Cell>
                  </tr>
                ))}
              </tbody>
            </table>
            <nav aria-label="Pages" className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <button type="button" className="btn btn-secondary" disabled={data.page <= 1} onClick={() => change({ page: data.page - 1 })}>
                Previous
              </button>
              <p className="text-sm" data-testid="restock-page">
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
