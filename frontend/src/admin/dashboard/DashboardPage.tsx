import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '../../api/client';
import { DASHBOARD_RANGES as RANGES, DEFAULT_RANGE, getAdminDashboard, type AdminDashboard, type DashboardRange } from '../../api/adminDashboard';
import { LoadingRegion, SkeletonBlock } from '../../components/skeleton/Skeleton';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate, type Gate } from '../../lib/useSkeletonGate';
import { formatDay } from '../../staff/suppliers/supplierText';
import { CustomersCard, EmployeesCard, ForecastCard, Kpis, OrdersPanel, RestockPanel, RevenuePanel, SpendPanel, StockPanel, TopTypesPanel } from './panels';

type Load = { phase: 'loading' } | { phase: 'ready'; data: AdminDashboard } | { phase: 'error'; message: string };

/**
 * The admin dashboard (step 7b), read-only. A "Z": the header and four KPI cards across the top, the large revenue chart on the diagonal, four
 * panels across the bottom, then the places held for the forecasts and the employee and customer panels. The range lives in the address
 * (?range=), so Back and sharing work. Everything shown comes from the server; this page only draws it.
 */
export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const ids = useId();
  const range = (RANGES.find((r) => r.id === params.get('range'))?.id ?? DEFAULT_RANGE) as DashboardRange;
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [last, setLast] = useState<AdminDashboard | null>(null); // a new range keeps the old picture (dimmed) instead of a skeleton
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getAdminDashboard(range, controller.signal)
      .then((response) => {
        setLoad({ phase: 'ready', data: response.data });
        setLast(response.data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the dashboard.' });
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
    <section className="mx-auto max-w-7xl px-4 py-6 sm:py-8" data-testid="admin-dashboard">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl sm:text-5xl">Dashboard</h1>
          {data && (
            <p className="mt-1 text-sm text-muted" data-testid="dashboard-range">
              {formatDay(data.range.from)} to {formatDay(data.range.to)}, Asia/Manila time. Stock and restock figures marked &quot;now&quot; are as they are today.
            </p>
          )}
        </div>
        <div>
          <label htmlFor={`${ids}-range`} className="block text-sm font-medium">
            Time range
          </label>
          <select
            id={`${ids}-range`}
            value={range}
            onChange={(e) => choose(e.target.value)}
            className="mt-1 block min-h-11 border border-brown-dark bg-paper px-3 py-2 text-base"
            data-testid="range-select"
          >
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={`mt-6 ${load.phase === 'loading' && last ? 'opacity-60' : ''}`} aria-live="polite" aria-busy={load.phase === 'loading'}>
        {gate !== 'content' && <DashboardSkeleton gate={gate} />}
        {gate === 'content' && load.phase === 'error' && (
          <div role="alert">
            <p className="font-medium text-brown-dark">{load.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && data && (
          <div className="space-y-4">
            <Kpis d={data} />
            <div className="grid gap-4 xl:grid-cols-3">
              <div className="min-w-0 xl:col-span-2">
                <RevenuePanel d={data} />
              </div>
              <TopTypesPanel d={data} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <OrdersPanel d={data} />
              <StockPanel d={data} />
              <RestockPanel d={data} />
              <SpendPanel d={data} />
            </div>
            <ForecastCard />
            <div className="grid gap-4 sm:grid-cols-2">
              <EmployeesCard />
              <CustomersCard />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** The dashboard's shape in grey blocks: the KPI row, the revenue chart with its side panel, and the four panels. */
function DashboardSkeleton({ gate }: { gate: Exclude<Gate, 'content'> }) {
  return (
    <LoadingRegion gate={gate} label="Loading the dashboard…" className="space-y-4" data-testid="dashboard-loading">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBlock key={i} className="h-28 w-full" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <SkeletonBlock className="h-72 w-full xl:col-span-2" />
        <SkeletonBlock className="h-72 w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBlock key={i} className="h-64 w-full" />
        ))}
      </div>
    </LoadingRegion>
  );
}
