import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useWorkspace } from './workspace';
import { ApiError } from '../api/client';
import { listStaffOrders } from '../api/staff';
import type { ApiResponse, PaymentMethodId, StaffOrderList, TrackedState } from '../api/types';
import { SimulatedBadge } from '../components/SimulatedBadge';
import { StaffListSkeleton } from '../components/skeleton/routeSkeletons';
import { formatMoney } from '../lib/format';
import { formatWhen, METHOD_LABEL, STATE_LABEL } from '../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../lib/skeletonTiming';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { PAGE_SIZE, STATE_TABS, stateClass, staffStateLabel } from './staffText';


/** Every status a link may name. The admin order summary links here with several at once ("delivered,closed", "confirmed,packed"). */
const LIST_STATES = ['awaiting_payment', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'closed', 'cancelled'];

type Load = { phase: 'loading' } | { phase: 'ready'; response: ApiResponse<StaffOrderList> } | { phase: 'error'; message: string };
const control = 'mt-1 block w-full border border-brown-dark bg-paper px-3 py-2 text-base';

/** Every order, newest first, with the filters staff need. The filters live in the address, so a view can be shared and Back works. */
export function OrdersPage() {
  const w = useWorkspace();
  const [params, setParams] = useSearchParams();
  const ids = useId();
  const search = useLocation().search;
  // one status, or several joined by commas; anything that is not a status is dropped
  const state = (params.get('state') ?? '').split(',').filter((id) => LIST_STATES.includes(id)).join(',');
  const rawMethod = params.get('method');
  const method: PaymentMethodId | '' = rawMethod === 'cod' || rawMethod === 'bank_transfer' ? rawMethod : '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);

  // what is typed in the filter fields is applied with the Show orders button; the tabs apply at once
  const [draft, setDraft] = useState({ q, from, to, method });
  useEffect(() => {
    setDraft({ q, from, to, method });
  }, [q, from, to, method]);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  // the last answer: a new filter or page keeps it on screen (dimmed) while the next one comes, so only the FIRST load has a skeleton
  const [last, setLast] = useState<StaffOrderList | null>(null);
  const [attempt, setAttempt] = useState(0);

  const change = (next: Partial<{ state: string; method: string; from: string; to: string; q: string; page: number }>) => {
    const merged = { state, method, from, to, q, ...next, page: next.page ?? 1 };
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v && !(k === 'page' && v === 1)) out.set(k, String(v));
    setParams(out);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    listStaffOrders({ state: (state || undefined) as TrackedState | undefined, method: method || undefined, from: from || undefined, to: to || undefined, q: q || undefined, page, pageSize: PAGE_SIZE }, controller.signal)
      .then((response) => {
        setLoad({ phase: 'ready', response });
        setLast(response.data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the orders.' });
      });
    return () => controller.abort();
  }, [state, method, from, to, q, page, attempt]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    change({ q: draft.q.trim(), from: draft.from, to: draft.to, method: draft.method });
  };
  const filtered = Boolean(state || method || from || to || q);
  const data = load.phase === 'ready' ? load.response.data : load.phase === 'loading' ? last : null;
  const gate = useSkeletonGate(load.phase === 'loading' && !last, { immediate: load.phase === 'error' || (!!data && data.orders.length === 0), minMs: STAFF_MIN_SKELETON_MS });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-4xl sm:text-5xl">Orders</h1>
        {load.phase === 'ready' && <SimulatedBadge simulation={load.response.simulation} />}
      </div>

      <nav aria-label="Filter by status" className="mt-4 flex flex-wrap gap-2" data-testid="staff-tabs">
        {STATE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={state === tab.id}
            onClick={() => change({ state: tab.id })}
            className={`min-h-11 border px-3 py-1.5 text-sm font-medium ${state === tab.id ? 'border-ink bg-ink text-cream' : 'border-brown-dark bg-cream text-ink hover:bg-paper-warm'}`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {state.includes(',') && (
        <p className="mt-3 text-sm" data-testid="staff-multi-state">
          Showing: {state.split(',').map((id) => STATE_LABEL[id as TrackedState]).join(', ')}.{' '}
          <button type="button" className="underline underline-offset-4" onClick={() => change({ state: '' })}>
            Show all statuses
          </button>
        </p>
      )}

      <form onSubmit={apply} role="search" aria-label="Find orders" className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] lg:items-end" data-testid="staff-filters">
        <div className="col-span-2 lg:col-span-1">
          <label htmlFor={`${ids}-q`} className="block text-sm font-medium">Search</label>
          <input id={`${ids}-q`} type="search" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="Order number, name or email" maxLength={100} className={control} />
        </div>
        <div className="col-span-2 lg:col-span-1">
          <label htmlFor={`${ids}-method`} className="block text-sm font-medium">Payment</label>
          <select id={`${ids}-method`} value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value as PaymentMethodId | '' })} className={control}>
            <option value="">Any</option>
            <option value="cod">{METHOD_LABEL.cod}</option>
            <option value="bank_transfer">{METHOD_LABEL.bank_transfer}</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-from`} className="block text-sm font-medium">Placed from</label>
          <input id={`${ids}-from`} type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className={control} />
        </div>
        <div>
          <label htmlFor={`${ids}-to`} className="block text-sm font-medium">Placed to</label>
          <input id={`${ids}-to`} type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className={control} />
        </div>
        <div className="col-span-2 flex flex-wrap gap-2 lg:col-span-1">
          <button type="submit" className="btn btn-primary">
            Show orders
          </button>
          {filtered && (
            <button type="button" className="btn btn-secondary" onClick={() => setParams(new URLSearchParams())}>
              Clear
            </button>
          )}
        </div>
      </form>

      <div className={`mt-6 ${load.phase === 'loading' && last ? 'opacity-60' : ''}`} aria-live="polite" aria-busy={load.phase === 'loading'}>
        {gate !== 'content' && <StaffListSkeleton gate={gate} />}
        {gate === 'content' && load.phase === 'error' && (
          <div role="alert">
            <p className="font-medium text-brown-dark">{load.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && data && data.orders.length === 0 && (
          <p data-testid="staff-empty">
            {filtered ? 'No orders match these filters.' : 'There are no orders yet.'}
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
        {gate === 'content' && data && data.orders.length > 0 && (
          <>
            <p className="text-sm text-muted" data-testid="staff-count">
              Showing {(data.page - 1) * data.pageSize + 1} to {(data.page - 1) * data.pageSize + data.orders.length} of {data.total} {data.total === 1 ? 'order' : 'orders'}
            </p>
            <table className="mt-3 block w-full text-left md:table" data-testid="staff-orders">
              <caption className="sr-only">Orders, newest first</caption>
              <thead className="sr-only md:not-sr-only md:table-header-group">
                <tr className="border-b border-brown-dark text-sm text-muted">
                  {['Order', 'Placed', 'Customer', 'Payment', 'Items', 'Total', 'Status'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="block space-y-3 md:table-row-group md:space-y-0">
                {data.orders.map((o) => (
                  <tr key={o.id} data-testid="staff-row" data-state={o.state} className="block border border-tan bg-cream p-3 md:table-row md:border-0 md:border-b md:bg-transparent md:p-0">
                    <Cell label="Order">
                      <Link to={w.order(o.id)} state={{ from: `${w.orders}${search}` }} className="font-semibold text-ink underline underline-offset-4">
                        {o.reference}
                      </Link>
                    </Cell>
                    <Cell label="Placed">{formatWhen(o.createdAt)}</Cell>
                    <Cell label="Customer">
                      <span className="min-w-0 text-right md:text-left">
                        <span className="block text-ink">{o.customer.name}</span>
                        <span className="block break-all text-sm text-muted">{o.customer.email}</span>
                      </span>
                    </Cell>
                    <Cell label="Payment">
                      <span className="text-right md:text-left">
                        <span className="block">{METHOD_LABEL[o.paymentMethod]}</span>
                        <span className="block text-sm text-muted">{o.paid ? 'Payment received' : 'Not paid yet'}</span>
                      </span>
                    </Cell>
                    <Cell label="Items">{o.itemCount}</Cell>
                    <Cell label="Total">
                      <span className="font-semibold text-ink">{formatMoney(o.total, 'PHP')}</span>
                    </Cell>
                    <Cell label="Status">
                      <span className="text-right md:text-left">
                        <span className={`inline-block rounded-sm border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${stateClass(o.state)}`}>{staffStateLabel(o.state, o.paymentMethod)}</span>
                        <span className="mt-1 block text-xs text-muted">since {formatWhen(o.statusChangedAt)}</span>
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
              <p className="text-sm" data-testid="staff-page">
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
