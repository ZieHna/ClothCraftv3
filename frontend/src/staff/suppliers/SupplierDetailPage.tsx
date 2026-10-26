import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ApiError } from '../../api/client';
import { getSupplier, removeRange, removeSupplyLine, type SupplierDetail } from '../../api/suppliers';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { StaffDetailSkeleton } from '../../components/skeleton/routeSkeletons';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { formatWhen } from '../../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { useWorkspace } from '../workspace';
import { AdminActions } from './AdminActions';
import { OpeningBalanceAction } from './OpeningBalanceAction';
import { RangeForm } from './RangeForm';
import { SupplyLineForm } from './SupplyLineForm';
import { SupplyLinesTable } from './SupplyLinesTable';
import { formatDay, pesos } from './supplierText';
import { EDITING_ROW, lineName, problemOf, StatusBadge, useSubmit } from './supplierUi';

type Load = { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; status: number; message: string };
/** which form is open: 'new', or the id of the row being changed */
type Editing = { kind: 'line' | 'range'; id: string | 'new' } | null;
type Removing = { kind: 'line' | 'range'; id: string; text: string } | null;

/** One supplier: its details, shipping, unavailable dates, supply lines and what has been spent with it. */
export function SupplierDetailPage() {
  const { id = '' } = useParams();
  const w = useWorkspace();
  const { user } = w;
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const [supplier, setSupplier] = useState<SupplierDetail | null>(null);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [done, setDone] = useState<string | null>((location.state as { notice?: string } | null)?.notice ?? null);
  const [alert, setAlert] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<Removing>(null);
  const { busy: removingBusy, run: runRemove } = useSubmit();
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });
  // the form sits in a panel above the long list: opening one scrolls to it; closing one puts focus back on the button that opened it
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    setSupplier(null);
    getSupplier(id, controller.signal)
      .then((response) => {
        setSupplier(response.data.supplier);
        setLoad({ phase: 'ready' });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', status: error instanceof ApiError ? error.status : 0, message: error instanceof ApiError ? error.message : 'Could not load the supplier.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  const open = editing !== null;
  const openKey = editing ? `${editing.kind}:${editing.id}` : '';
  useEffect(() => {
    if (!openKey) return;
    // scroll-mt on the panel keeps a gap above it; the staff header is not sticky, so no more offset is needed
    panel.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }, [openKey, reduceMotion]);
  useEffect(() => {
    if (open) return;
    const back = opener.current;
    opener.current = null;
    // no preventScroll: if the button is off screen, focus brings it into view, which is where the user was working
    if (back?.isConnected) back.focus();
  }, [open]);

  const openForm = (next: NonNullable<Editing>) => (event: MouseEvent<HTMLElement>) => {
    opener.current = event.currentTarget;
    setEditing(next);
  };

  if (load.phase === 'loading' || gate !== 'content') return <StaffDetailSkeleton gate={gate === 'content' ? 'skeleton' : gate} label="Loading the supplier…" />;
  if (load.phase === 'error' || !supplier) {
    const status = load.phase === 'error' ? load.status : 0;
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-4xl sm:text-5xl">{status === 404 ? 'No such supplier' : 'Could not load the supplier'}</h1>
        <p role="alert" className="mt-3 font-medium text-brown-dark">
          {load.phase === 'error' ? load.message : 'Could not load the supplier.'}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {status !== 404 && (
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <Link to={w.suppliers} className="btn btn-secondary">
            All suppliers
          </Link>
        </div>
      </section>
    );
  }

  // every change answers with the whole supplier as it is now: the page just takes it
  const saved = (next: SupplierDetail, message: string) => {
    setSupplier(next);
    setDone(message);
    setAlert(null);
    setEditing(null);
  };
  const confirmRemove = () => {
    if (!removing) return;
    const target = removing;
    void runRemove(async () => {
      try {
        const response = target.kind === 'line' ? await removeSupplyLine(target.id) : await removeRange(target.id);
        setRemoving(null);
        saved(response.data.supplier, target.kind === 'line' ? 'Supply line removed.' : 'Unavailable dates removed.');
      } catch (error) {
        setRemoving(null);
        setDone(null);
        setAlert(problemOf(error, []).message ?? 'The change was not made.');
      }
    });
  };
  const s = supplier;
  const restricted = s.status === 'inactive' || s.status === 'off';
  const rangeName = (r: { dateFrom: string; dateTo: string }) => `${formatDay(r.dateFrom)} to ${formatDay(r.dateTo)}`;
  const editingLine = editing?.kind === 'line' ? s.lines.find((l) => l.id === editing.id) : undefined;
  const editingRange = editing?.kind === 'range' ? s.ranges.find((r) => r.id === editing.id) : undefined;
  const panelTitle = !editing
    ? ''
    : editing.kind === 'line'
      ? editingLine
        ? `Change supply line: ${lineName(editingLine)}`
        : 'Add supply line'
      : editingRange
        ? `Change unavailable dates: ${rangeName(editingRange)}`
        : 'Add unavailable dates';
  const close = () => setEditing(null);

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <p>
        <Link to={w.suppliers} className="text-sm underline underline-offset-4">
          ← All suppliers
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 break-words text-4xl sm:text-5xl" data-testid="supplier-name">
          {s.name}
        </h1>
        <StatusBadge status={s.status} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link to={w.supplierEdit(s.id)} className="btn btn-primary" data-testid="supplier-edit">
          Edit details
        </Link>
        {user?.role === 'admin' && (
          <AdminActions
            supplier={s}
            onDone={saved}
            onFail={(message) => {
              setDone(null);
              setAlert(message);
            }}
          />
        )}
      </div>
      {restricted && user?.role !== 'admin' && <p className="mt-3 text-muted">Only an Administrator can change an inactive or switched-off supplier.</p>}
      {done && (
        <p role="status" className="mt-3 font-medium text-sage-dark" data-testid="supplier-done">
          {done}
        </p>
      )}
      {alert && (
        <p role="alert" className="mt-3 border-2 border-brown-dark bg-cream px-3 py-2 font-medium text-brown-dark" data-testid="supplier-alert">
          {alert}
        </p>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <Card title="Details">
          <dl className="space-y-2">
            <Row label="Contact">{s.contactName}</Row>
            <Row label="Phone">{s.phone ?? 'Not given'}</Row>
            <Row label="Address">
              <span className="block">{s.street}</span>
              {s.street2 && <span className="block">{s.street2}</span>}
              <span className="block">{[s.city, s.zip].filter(Boolean).join(' ')}</span>
              {s.country && <span className="block">{s.country}</span>}
            </Row>
            <Row label="Last edited">{s.lastEditedBy ? `${s.lastEditedBy}${s.lastEditedAt ? `, ${formatWhen(s.lastEditedAt)}` : ''}` : 'Not recorded'}</Row>
          </dl>
        </Card>

        <div className="space-y-8">
          <Card title="Shipping">
            {s.ships ? (
              <dl className="space-y-2" data-testid="supplier-shipping">
                <Row label="Fee (VAT included)">{pesos(s.shippingFee)}</Row>
                <Row label="VAT">{pesos(s.shippingFeeVat)}</Row>
                <Row label="Net">{pesos(s.shippingFeeNet)}</Row>
              </dl>
            ) : (
              <p data-testid="supplier-shipping">This supplier does not charge for shipping.</p>
            )}
          </Card>
          <Card title="Total spent" action={user?.role === 'admin' ? <OpeningBalanceAction supplier={s} onDone={saved} /> : undefined}>
            <dl className="space-y-3" data-testid="supplier-spent">
              <Row label="Opening balance (existing stock)">
                <span className="block" data-testid="spent-opening">{pesos(s.openingBalance)}</span>
                <span className="block text-sm text-muted">net {pesos(s.openingBalanceNet)}</span>
              </Row>
              <Row label={`Received restocks (${s.receivedCount})`}>
                <span className="block" data-testid="spent-received">{pesos(s.totalSpent)}</span>
                <span className="block text-sm text-muted">net {pesos(s.totalSpentNet)}</span>
              </Row>
              <Row label="Combined total (VAT included)">
                <span className="block font-semibold text-ink" data-testid="spent-combined">{pesos(s.combinedTotal)}</span>
                <span className="block text-sm text-muted">net {pesos(s.combinedTotalNet)}</span>
              </Row>
            </dl>
            <p className="mt-3 text-xs text-muted">The opening balance is the existing stock treated as bought from this supplier: a starting investment, not spending in any month.</p>
          </Card>
        </div>
      </div>

      <div className="mt-8 grid gap-8">
        <Card
          title="Unavailable dates"
          action={
            <button type="button" className="btn btn-secondary btn-small" onClick={openForm({ kind: 'range', id: 'new' })} data-testid="range-add">
              Add dates
            </button>
          }
        >
          {s.ranges.length === 0 ? (
            <p data-testid="ranges-empty">No unavailable dates.</p>
          ) : (
            <ul className="divide-y divide-tan border-y border-tan" data-testid="ranges-list">
              {s.ranges.map((r) => {
                const current = editing?.kind === 'range' && editing.id === r.id;
                return (
                  <li key={r.id} data-testid="range-row" aria-current={current ? 'true' : undefined} className={`flex flex-wrap items-center justify-between gap-3 px-2 py-3 ${current ? EDITING_ROW : ''}`}>
                    <p className="min-w-0 break-words">
                      <span className="font-semibold text-ink">{rangeName(r)}</span>
                      {current && <span className="ml-2 text-sm font-semibold text-ink">(being changed)</span>}
                      {r.reason && <span className="block text-sm text-muted">{r.reason}</span>}
                    </p>
                    <span className="flex flex-wrap gap-2">
                      <button type="button" className="btn btn-secondary btn-small" onClick={openForm({ kind: 'range', id: r.id })} aria-label={`Change dates ${rangeName(r)}`}>
                        Change
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => setRemoving({ kind: 'range', id: r.id, text: `Remove the unavailable dates ${rangeName(r)}?` })}
                        aria-label={`Remove dates ${rangeName(r)}`}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {editing && (
          <div ref={panel} className="scroll-mt-4" data-testid="edit-panel">
            <section aria-labelledby="edit-panel-title" className="border-2 border-ink bg-cream p-4 sm:p-5">
              <h2 id="edit-panel-title" className="break-words text-2xl" data-testid="edit-panel-title">
                {panelTitle}
              </h2>
              {editing.kind === 'line' ? (
                <SupplyLineForm key={editing.id} supplierId={s.id} line={editingLine} onSaved={saved} onCancel={close} />
              ) : (
                <RangeForm key={editing.id} supplierId={s.id} range={editingRange} onSaved={saved} onCancel={close} />
              )}
            </section>
          </div>
        )}

        <Card
          title="Supply lines"
          action={
            <button type="button" className="btn btn-secondary btn-small" onClick={openForm({ kind: 'line', id: 'new' })} data-testid="line-add">
              Add supply line
            </button>
          }
        >
          <SupplyLinesTable
            lines={s.lines}
            currentId={editing?.kind === 'line' && editing.id !== 'new' ? editing.id : null}
            onChange={(l) => openForm({ kind: 'line', id: l.id })}
            onRemove={(l) => setRemoving({ kind: 'line', id: l.id, text: `Remove the supply line ${lineName(l)}?` })}
          />
        </Card>
      </div>

      {removing && (
        <ConfirmDialog title="Remove" yes="Remove" no="Keep it" busy={removingBusy} onYes={confirmRemove} onNo={() => setRemoving(null)} testId="remove-confirm">
          <p>{removing.text}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border border-tan bg-cream p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl">{title}</h2>
        {action}
      </div>
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
