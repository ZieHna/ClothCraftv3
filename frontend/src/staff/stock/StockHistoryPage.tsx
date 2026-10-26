import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useWorkspace } from '../workspace';
import { ApiError } from '../../api/client';
import { stockHistory, type StockHistory } from '../../api/inventory';
import { StaffListSkeleton } from '../../components/skeleton/routeSkeletons';
import { formatWhen } from '../../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { Cell } from '../suppliers/supplierUi';

type Load = { phase: 'loading' } | { phase: 'ready'; data: StockHistory } | { phase: 'error'; message: string };
const PAGE_SIZE = 25;
const COLUMNS = ['When', 'Variant', 'Change', 'Reason', 'By'];

/** Every stock correction, newest first, exactly as the server recorded it. With ?productId= it is the history of one variant. */
export function StockHistoryPage() {
  const w = useWorkspace();
  const [params, setParams] = useSearchParams();
  const productId = /^\d+$/.test(params.get('productId') ?? '') ? (params.get('productId') as string) : '';
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [last, setLast] = useState<StockHistory | null>(null);
  const [attempt, setAttempt] = useState(0);

  const go = (next: number) => {
    const out = new URLSearchParams();
    if (productId) out.set('productId', productId);
    if (next > 1) out.set('page', String(next));
    setParams(out);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    stockHistory({ productId: productId || undefined, page, pageSize: PAGE_SIZE }, controller.signal)
      .then((response) => {
        setLoad({ phase: 'ready', data: response.data });
        setLast(response.data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the history.' });
      });
    return () => controller.abort();
  }, [productId, page, attempt]);

  const data = load.phase === 'ready' ? load.data : load.phase === 'loading' ? last : null;
  const gate = useSkeletonGate(load.phase === 'loading' && !last, { immediate: load.phase === 'error' || (!!data && data.edits.length === 0), minMs: STAFF_MIN_SKELETON_MS });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const who = data?.edits[0] ? (data.edits[0].sku ?? data.edits[0].name) : null;

  return (
    <section className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <p>
        <Link to={w.stock} className="text-sm underline underline-offset-4">
          ← Stock
        </Link>
      </p>
      <h1 className="mt-2 text-4xl sm:text-5xl">Stock edit history</h1>
      {productId && (
        <p className="mt-2" data-testid="history-scope">
          Only the edits of {who ? <span className="font-semibold text-ink">{who}</span> : 'one variant'}.{' '}
          <Link to={w.stockHistory} className="underline underline-offset-4">
            Show all edits
          </Link>
        </p>
      )}

      <div className={`mt-6 ${load.phase === 'loading' && last ? 'opacity-60' : ''}`} aria-live="polite" aria-busy={load.phase === 'loading'}>
        {gate !== 'content' && <StaffListSkeleton gate={gate} label="Loading the history…" />}
        {gate === 'content' && load.phase === 'error' && (
          <div role="alert">
            <p className="font-medium text-brown-dark">{load.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && data && data.edits.length === 0 && <p data-testid="history-empty">{productId ? 'This variant has no stock edits.' : 'No stock has been edited yet.'}</p>}
        {gate === 'content' && data && data.edits.length > 0 && (
          <>
            <p className="text-sm text-muted">
              Showing {(data.page - 1) * data.pageSize + 1} to {(data.page - 1) * data.pageSize + data.edits.length} of {data.total} {data.total === 1 ? 'edit' : 'edits'}
            </p>
            <table className="mt-3 block w-full text-left md:table" data-testid="history-table">
              <caption className="sr-only">Stock edits, newest first</caption>
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
                {data.edits.map((e) => (
                  <tr key={e.id} data-testid="history-row" className="block border border-tan bg-cream p-3 md:table-row md:border-0 md:border-b md:bg-transparent md:p-0">
                    <Cell label="When">{formatWhen(e.at)}</Cell>
                    <Cell label="Variant">
                      <span className="min-w-0 break-words text-right md:text-left">
                        <span className="block font-semibold text-ink">{e.sku ?? e.name}</span>
                        <span className="block text-sm text-muted">{e.name}</span>
                      </span>
                    </Cell>
                    <Cell label="Change">
                      <span className="text-right md:text-left">
                        <span className="block font-semibold text-ink">
                          {e.oldQty} → {e.newQty}
                        </span>
                        <span className="block text-sm text-muted">{e.delta > 0 ? `+${e.delta}` : e.delta}</span>
                      </span>
                    </Cell>
                    <Cell label="Reason">
                      <span className="min-w-0 break-words text-right md:text-left">
                        {e.reason}
                        {e.detail && <span className="block text-sm text-muted">{e.detail}</span>}
                      </span>
                    </Cell>
                    <Cell label="By">{e.staffName}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
            <nav aria-label="Pages" className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <button type="button" className="btn btn-secondary" disabled={data.page <= 1} onClick={() => go(data.page - 1)}>
                Previous
              </button>
              <p className="text-sm">
                Page {data.page} of {pages}
              </p>
              <button type="button" className="btn btn-secondary" disabled={data.page >= pages} onClick={() => go(data.page + 1)}>
                Next
              </button>
            </nav>
          </>
        )}
      </div>
    </section>
  );
}
