import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../../api/client';
import { DASHBOARD_RANGES, DEFAULT_RANGE, type DashboardRange } from '../../api/adminDashboard';
import { getOrdersSummary, type OrdersSummary } from '../../api/adminOrders';
import { LoadingRegion, SkeletonBlock } from '../../components/skeleton/Skeleton';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate, type Gate } from '../../lib/useSkeletonGate';
import { formatDay } from '../../staff/suppliers/supplierText';
import { BarRows, type Bar, DataTable } from '../dashboard/charts';

type Load = { phase: 'loading' } | { phase: 'ready'; data: OrdersSummary } | { phase: 'error'; message: string };
const LIST = '/admin/orders/list';

/**
 * The admin Orders page: COUNTS only, no amounts. In-progress orders (delivered ones waiting for the customer's confirmation included) are "right
 * now"; Success (closed) and Failed (cancelled) are the orders placed in the time range (Manila days). Every number links to the order list filtered
 * to that status (Success and Failed also to the same range). Everything shown is a figure the server counted; the only arithmetic here is
 * value / largest value to size a bar.
 */
export function OrdersSummaryPage() {
  const [params, setParams] = useSearchParams();
  const ids = useId();
  const range = (DASHBOARD_RANGES.find((r) => r.id === params.get('range'))?.id ?? DEFAULT_RANGE) as DashboardRange;
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [last, setLast] = useState<OrdersSummary | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getOrdersSummary(range, controller.signal)
      .then((response) => {
        setLoad({ phase: 'ready', data: response.data });
        setLast(response.data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the orders.' });
      });
    return () => controller.abort();
  }, [range, attempt]);

  const data = load.phase === 'ready' ? load.data : load.phase === 'loading' ? last : null;
  const gate = useSkeletonGate(load.phase === 'loading' && !last, { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });
  const choose = (next: string) => {
    const out = new URLSearchParams();
    if (next !== DEFAULT_RANGE) out.set('range', next);
    setParams(out);
  };

  return (
    <section className="mx-auto max-w-7xl px-4 py-6 sm:py-8" data-testid="orders-summary">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl sm:text-5xl">Orders</h1>
          <p className="mt-1 text-sm text-muted">How many orders there are, not what they are worth. Every number opens the list for that status.</p>
        </div>
        <div>
          <label htmlFor={`${ids}-range`} className="block text-sm font-medium">
            Time range
          </label>
          <select id={`${ids}-range`} value={range} onChange={(e) => choose(e.target.value)} className="mt-1 block min-h-11 border border-brown-dark bg-paper px-3 py-2 text-base" data-testid="range-select">
            {DASHBOARD_RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={`mt-6 ${load.phase === 'loading' && last ? 'opacity-60' : ''}`} aria-busy={load.phase === 'loading'}>
        {gate !== 'content' && <SummarySkeleton gate={gate} />}
        {gate === 'content' && load.phase === 'error' && (
          <div role="alert">
            <p className="font-medium text-brown-dark">{load.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && data && <Summary d={data} />}
      </div>
    </section>
  );
}

/** The link to the order list for these statuses; `ranged` adds the same placed-from / placed-to dates as the range (none for all time). */
function listLink(d: OrdersSummary, states: string[], ranged: boolean): string {
  const query = [`state=${states.join(',')}`];
  if (ranged && d.range.from) query.push(`from=${d.range.from}`, `to=${d.range.to}`);
  return `${LIST}?${query.join('&')}`;
}

const oldestText = (days: number): string => (days === 0 ? 'oldest: placed today' : `oldest: ${days} ${days === 1 ? 'day' : 'days'}`);
/** The delivered card counts from the delivery, which is what the automatic close runs on. */
const oldestDeliveredText = (days: number): string => (days === 0 ? 'oldest: delivered today' : `oldest: ${days} ${days === 1 ? 'day' : 'days'} since delivery`);

function Count({ n, to, label }: { n: number; to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex min-h-11 items-center text-4xl font-semibold text-ink underline underline-offset-4" aria-label={`${n} ${label}, open the list`}>
      {n}
    </Link>
  );
}

function Card({ title, notes, children, testId }: { title: string; notes?: string[]; children: ReactNode; testId: string }) {
  return (
    <div className="min-w-0 border border-tan bg-cream p-4" data-testid={testId}>
      <h3 className="text-base font-medium text-muted">{title}</h3>
      {children}
      {(notes ?? []).map((note) => (
        <p key={note} className="text-xs text-muted">
          {note}
        </p>
      ))}
    </div>
  );
}

function Summary({ d }: { d: OrdersSummary }) {
  const p = d.inProgress;
  const placed = d.range.from ? `placed from ${formatDay(d.range.from)} to ${formatDay(d.range.to)}` : `placed at any time up to ${formatDay(d.range.to)}`;
  const outcomes = d.success.closed + d.failed.cancelled;
  const bars: Bar[] = [
    { key: 'success', label: 'Success (closed)', value: d.success.closed, shown: `${d.success.closed}`, detail: '' },
    { key: 'failed', label: 'Failed (cancelled)', value: d.failed.cancelled, shown: `${d.failed.cancelled}`, detail: '' },
  ];
  return (
    <div className="space-y-8">
      <section aria-labelledby="in-progress-h">
        <h2 id="in-progress-h" className="text-2xl">
          In progress
        </h2>
        <p className="text-sm text-muted">Right now, whenever the orders were placed. The time range does not change these.</p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Card title="Awaiting payment" testId="card-awaiting" notes={p.awaitingPayment.oldestDays !== null ? [oldestText(p.awaitingPayment.oldestDays)] : undefined}>
            <Count n={p.awaitingPayment.count} to={listLink(d, ['awaiting_payment'], false)} label="orders awaiting payment" />
          </Card>
          <Card title="Received and preparing" testId="card-received">
            <Count n={p.receivedPreparing.count} to={listLink(d, ['confirmed', 'packed'], false)} label="orders received and preparing" />
          </Card>
          <Card title="Shipped" testId="card-shipped">
            <Count n={p.shipped.count} to={listLink(d, ['shipped'], false)} label="shipped orders" />
          </Card>
          <Card title="On delivery" testId="card-delivery">
            <Count n={p.onDelivery.count} to={listLink(d, ['out_for_delivery'], false)} label="orders on delivery" />
          </Card>
          <Card
            title="Delivered, waiting for customer confirmation"
            testId="card-delivered"
            notes={['Right now, not limited by the time range.', ...(p.deliveredWaiting.oldestDays !== null ? [oldestDeliveredText(p.deliveredWaiting.oldestDays)] : [])]}
          >
            <Count n={p.deliveredWaiting.count} to={listLink(d, ['delivered'], false)} label="delivered orders waiting for the customer to confirm" />
          </Card>
        </div>
      </section>

      <section aria-labelledby="outcomes-h">
        <h2 id="outcomes-h" className="text-2xl">
          Success and failed
        </h2>
        <p className="text-sm text-muted" data-testid="orders-range-note">
          Orders {placed} (Manila time).
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Card title="Success" testId="card-success" notes={['Closed: the customer confirmed they received it, or it closed by itself some days after delivery.']}>
            <Count n={d.success.closed} to={listLink(d, ['closed'], true)} label="successful (closed) orders" />
          </Card>
          <Card title="Failed" testId="card-failed" notes={['Cancelled orders.']}>
            <Count n={d.failed.cancelled} to={listLink(d, ['cancelled'], true)} label="cancelled orders" />
          </Card>
        </div>

        <div className="mt-4 border border-tan bg-cream p-4" data-testid="outcome-share">
          <h3 className="text-xl">How the orders ended</h3>
          {outcomes === 0 ? (
            <p className="mt-2" data-testid="orders-empty">
              No orders in this period.
            </p>
          ) : (
            <>
              <div role="img" aria-label={`Success (closed) ${d.success.closed} orders, failed (cancelled) ${d.failed.cancelled} orders, placed in this period.`} className="mt-3">
                <BarRows bars={bars} testId="outcome-rows" />
              </div>
              <DataTable caption="How the orders ended" columns={['Outcome', 'Orders']} rows={[['Success (closed)', d.success.closed], ['Failed (cancelled)', d.failed.cancelled]]} />
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function SummarySkeleton({ gate }: { gate: Exclude<Gate, 'content'> }) {
  return (
    <LoadingRegion gate={gate} label="Loading the orders…" className="space-y-8" data-testid="orders-loading">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonBlock key={i} className="h-28 w-full" />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SkeletonBlock className="h-32 w-full" />
        <SkeletonBlock className="h-32 w-full" />
      </div>
      <SkeletonBlock className="h-40 w-full" />
    </LoadingRegion>
  );
}
