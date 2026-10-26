import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useWorkspace } from '../workspace';
import { ApiError } from '../../api/client';
import { getRestock, type RestockDetail } from '../../api/inventory';
import { StaffDetailSkeleton } from '../../components/skeleton/routeSkeletons';
import { formatWhen } from '../../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { formatDay, pesos } from '../suppliers/supplierText';
import { Cell } from '../suppliers/supplierUi';
import { RestockBadges } from './RestockBadges';
import { EVENT_LABEL, RESTOCK_STATE_LABEL } from './restockText';

// the Administrator's buttons are a chunk of their own, asked for only inside the admin workspace: /staff never downloads or draws them
const AdminRestockActions = lazy(async () => ({ default: (await import('./AdminRestockActions')).AdminRestockActions }));

type Load = { phase: 'loading' } | { phase: 'ready'; restock: RestockDetail } | { phase: 'error'; status: number; message: string };

/**
 * One restock: the request, its lines, the costs exactly as the server sends them, and the whole history. Under /admin the Administrator's
 * moves (approve, reject, receive, did not receive) sit beside Edit; under /staff they do not exist, and the server refuses them anyway.
 */
export function RestockDetailPage() {
  const w = useWorkspace();
  const { id = '' } = useParams();
  const arrived = (useLocation().state as { notice?: string } | null)?.notice ?? null;
  const [said, setSaid] = useState<string | null>(null);
  const notice = said ?? arrived;
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    setSaid(null);
    getRestock(id, controller.signal)
      .then((response) => setLoad({ phase: 'ready', restock: response.data.restock }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', status: error instanceof ApiError ? error.status : 0, message: error instanceof ApiError ? error.message : 'Could not load the restock.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  if (load.phase === 'loading' || gate !== 'content') return <StaffDetailSkeleton gate={gate === 'content' ? 'skeleton' : gate} label="Loading the restock…" />;
  if (load.phase === 'error') {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-4xl sm:text-5xl">{load.status === 404 ? 'No such restock' : 'Could not load the restock'}</h1>
        <p role="alert" className="mt-3 font-medium text-brown-dark">
          {load.message}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {load.status !== 404 && (
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <Link to={w.restocks} className="btn btn-secondary">
            All restocks
          </Link>
        </div>
      </section>
    );
  }
  const r = load.restock;
  const received = r.state === 'received';
  const shipping = !r.shippingOn ? 'Not requested' : r.shippingApplied ? pesos(r.shippingFee) : 'Requested, but this supplier does not ship';

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <p>
        <Link to={w.restocks} className="text-sm underline underline-offset-4">
          ← All restocks
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-4xl sm:text-5xl" data-testid="restock-name">
          {r.name}
        </h1>
        <RestockBadges restock={r} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link to={w.restockEdit(r.id)} className="btn btn-primary" data-testid="restock-edit">
          Edit request
        </Link>
        {r.state !== 'requested' && (
          <p className="text-muted" data-testid="restock-edit-note">
            Only a request that has not been approved yet can be edited.
          </p>
        )}
        {w.kind === 'admin' && (
          <Suspense fallback={null}>
            <AdminRestockActions restock={r} onChanged={(next, message) => { setLoad({ phase: 'ready', restock: next }); setSaid(message); }} />
          </Suspense>
        )}
      </div>
      {notice && (
        <p role="status" className="mt-3 font-medium text-sage-dark" data-testid="restock-done">
          {notice}
        </p>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <Card title="Request">
          <dl className="space-y-2">
            <Row label="Supplier">
              <Link to={w.supplier(r.supplier.id)} className="underline underline-offset-4">
                {r.supplier.name}
              </Link>
            </Row>
            <Row label="Requested by">
              {r.requestedBy}, {formatWhen(r.requestedAt)}
            </Row>
            <Row label="Expected">
              {formatDay(r.expectedFrom)} to {formatDay(r.expectedTo)}
            </Row>
            <Row label="Shipping">{shipping}</Row>
            <Row label="Note">{r.requestNote ?? 'None'}</Row>
            {r.decidedBy && (
              <Row label={r.state === 'rejected' ? 'Rejected by' : 'Decided by'}>
                {r.decidedBy}
                {r.decidedAt ? `, ${formatWhen(r.decidedAt)}` : ''}
                {r.decisionNote && <span className="block text-sm text-muted">{r.decisionNote}</span>}
              </Row>
            )}
          </dl>
        </Card>

        <Card title="Costs">
          <dl className="space-y-2" data-testid="restock-costs">
            <Row label="Estimated total (goods and shipping, VAT included)">{pesos(r.estimateTotal)}</Row>
            {received && (
              <>
                <Row label="Goods received">{pesos(r.goodsCost)}</Row>
                <Row label="Shipping">{pesos(r.shippingCost)}</Row>
                <Row label="Actual total (VAT included)">{r.actualCost === null ? '—' : pesos(r.actualCost)}</Row>
                <Row label="VAT">{pesos(r.actualVat)}</Row>
                <Row label="Net">{pesos(r.actualNet)}</Row>
                <Row label="Received">
                  {r.receivedOn ? formatDay(r.receivedOn) : '—'}
                  {r.receivedBy ? `, by ${r.receivedBy}` : ''}
                </Row>
                {r.stockReceipt && <Row label="Stock receipt">{r.stockReceipt}</Row>}
              </>
            )}
          </dl>
        </Card>
      </div>

      <div className="mt-8 grid gap-8">
        <Card title="Lines">
          <table className="block w-full text-left md:table" data-testid="restock-lines">
            <caption className="sr-only">Restock lines</caption>
            <thead className="sr-only md:not-sr-only md:table-header-group">
              <tr className="border-b border-brown-dark text-sm text-muted">
                {['Variant', 'Quantity', 'Unit cost (VAT included)', ...(received ? ['Received', 'Lot', 'Cost received'] : [])].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="block space-y-3 md:table-row-group md:space-y-0">
              {r.lines.map((l) => (
                <tr key={l.id} data-testid="restock-line" className="block border border-tan bg-cream p-3 md:table-row md:border-0 md:border-b md:bg-transparent md:p-0">
                  <Cell label="Variant">
                    <span className="min-w-0 break-words text-right md:text-left">
                      <span className="block font-semibold text-ink">{l.sku ?? l.name}</span>
                      <span className="block text-sm text-muted">{l.name}</span>
                    </span>
                  </Cell>
                  <Cell label="Quantity">{l.quantity}</Cell>
                  <Cell label="Unit cost (VAT included)">{pesos(l.unitCost)}</Cell>
                  {received && (
                    <>
                      <Cell label="Received">{l.quantityReceived ?? '—'}</Cell>
                      <Cell label="Lot">{l.lot ?? '—'}</Cell>
                      <Cell label="Cost received">{l.receivedCost === null ? '—' : pesos(l.receivedCost)}</Cell>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="History">
          <ol className="divide-y divide-tan border-y border-tan" data-testid="restock-history">
            {r.history.map((h) => (
              <li key={h.id} className="py-3" data-testid="history-entry">
                <p>
                  <span className="font-semibold text-ink">{EVENT_LABEL[h.event] ?? h.event}</span>
                  {h.fromState && h.fromState !== h.toState && (
                    <span className="text-muted">
                      {' '}
                      ({RESTOCK_STATE_LABEL[h.fromState]} → {RESTOCK_STATE_LABEL[h.toState]})
                    </span>
                  )}
                </p>
                <p className="text-sm text-muted">
                  {h.staffName}, {formatWhen(h.at)}
                </p>
                {h.note && <p className="mt-1 break-words">{h.note}</p>}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-tan bg-cream p-4 sm:p-5">
      <h2 className="text-2xl">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
      <dt className="text-sm font-medium text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right">{children}</dd>
    </div>
  );
}
