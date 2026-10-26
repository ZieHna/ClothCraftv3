import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { listCustomers, type CustomerList } from '../../api/adminCustomers';
import { ApiError } from '../../api/client';
import { StaffListSkeleton } from '../../components/skeleton/routeSkeletons';
import { formatWhen } from '../../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { pesos } from '../../staff/suppliers/supplierText';
import { Cell, control } from '../../staff/suppliers/supplierUi';
import { ActiveBadge } from '../employees/employeeUi';

type Load = { phase: 'loading' } | { phase: 'ready'; data: CustomerList } | { phase: 'error'; message: string };
const PAGE_SIZE = 25;
const COLUMNS = ['Name', 'Email', 'Registered', 'Orders placed', 'Total spent (closed orders)', 'Status'];
const STATUSES = [
  { id: '', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
];

/** The registered shop accounts, newest first. No phone or address here; money is the server's figure as sent. */
export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const ids = useId();
  const q = params.get('q') ?? '';
  const status = STATUSES.some((s) => s.id === params.get('status')) ? (params.get('status') ?? '') : '';
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [last, setLast] = useState<CustomerList | null>(null);
  const [attempt, setAttempt] = useState(0);

  const change = (next: Partial<{ q: string; status: string; page: number }>) => {
    const merged = { q, status, ...next, page: next.page ?? 1 };
    const out = new URLSearchParams();
    if (merged.q) out.set('q', merged.q);
    if (merged.status) out.set('status', merged.status);
    if (merged.page > 1) out.set('page', String(merged.page));
    setParams(out);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    listCustomers({ q: q || undefined, status: status || undefined, page, pageSize: PAGE_SIZE }, controller.signal)
      .then((response) => {
        setLoad({ phase: 'ready', data: response.data });
        setLast(response.data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the customers.' });
      });
    return () => controller.abort();
  }, [q, status, page, attempt]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    change({ q: draft.trim() });
  };
  const filtered = Boolean(q || status);
  const data = load.phase === 'ready' ? load.data : load.phase === 'loading' ? last : null;
  const gate = useSkeletonGate(load.phase === 'loading' && !last, { immediate: load.phase === 'error' || (!!data && data.customers.length === 0), minMs: STAFF_MIN_SKELETON_MS });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="mx-auto max-w-7xl px-4 py-8 sm:py-10" data-testid="customers-page">
      <h1 className="text-4xl sm:text-5xl">Customers</h1>
      <p className="mt-2 text-sm text-muted">Registered shop accounts. Total spent counts closed orders only (the customer confirmed), VAT included. Nobody is ever deleted: an account is deactivated instead.</p>

      <form onSubmit={apply} role="search" aria-label="Find customers" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end" data-testid="customer-filters">
        <div>
          <label htmlFor={`${ids}-q`} className="block text-sm font-medium">
            Search
          </label>
          <input id={`${ids}-q`} type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Name or email" maxLength={100} className={control} />
        </div>
        <div>
          <label htmlFor={`${ids}-status`} className="block text-sm font-medium">
            Status
          </label>
          <select id={`${ids}-status`} value={status} onChange={(e) => change({ status: e.target.value })} className={control}>
            {STATUSES.map((s) => (
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
        {gate !== 'content' && <StaffListSkeleton gate={gate} label="Loading the customers…" />}
        {gate === 'content' && load.phase === 'error' && (
          <div role="alert">
            <p className="font-medium text-brown-dark">{load.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && data && data.customers.length === 0 && (
          <p data-testid="customers-empty">
            {filtered ? 'No customers match these filters.' : 'There are no customers yet.'}
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
        {gate === 'content' && data && data.customers.length > 0 && (
          <>
            <p className="text-sm text-muted" data-testid="customers-count">
              Showing {(data.page - 1) * data.pageSize + 1} to {(data.page - 1) * data.pageSize + data.customers.length} of {data.total} {data.total === 1 ? 'customer' : 'customers'}
            </p>
            <table className="mt-3 block w-full text-left md:table" data-testid="customers-table">
              <caption className="sr-only">Customers</caption>
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
                {data.customers.map((c) => (
                  <tr key={c.id} data-testid="customer-row" className="block border border-tan bg-cream p-3 md:table-row md:border-0 md:border-b md:bg-transparent md:p-0">
                    <Cell label="Name">
                      <Link to={`/admin/customers/${c.id}`} className="min-w-0 break-words text-right font-semibold text-ink underline underline-offset-4 md:text-left">
                        {c.name}
                      </Link>
                    </Cell>
                    <Cell label="Email">
                      <span className="min-w-0 break-all text-right md:text-left">{c.email}</span>
                    </Cell>
                    <Cell label="Registered">{formatWhen(c.registeredAt)}</Cell>
                    <Cell label="Orders placed">{c.orderCount}</Cell>
                    <Cell label="Total spent (closed orders)">{pesos(c.totalSpent)}</Cell>
                    <Cell label="Status">
                      <ActiveBadge active={c.active} />
                    </Cell>
                  </tr>
                ))}
              </tbody>
            </table>

            <nav aria-label="Pages" className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <button type="button" className="btn btn-secondary" disabled={data.page <= 1} onClick={() => change({ page: data.page - 1 })}>
                Previous
              </button>
              <p className="text-sm" data-testid="customers-page-number">
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
