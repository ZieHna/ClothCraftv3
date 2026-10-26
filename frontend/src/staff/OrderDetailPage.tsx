import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useWorkspace } from './workspace';
import { ApiError } from '../api/client';
import { staffDesignUrl } from '../api/designs';
import { getStaffOrder, moveStaffOrder } from '../api/staff';
import { isDesigned, printFeeText } from '../cart/designed';
import type { ApiResponse, StaffAllowedMove, StaffOrder } from '../api/types';
import { QuoteTotals } from '../components/QuoteTotals';
import { SimulatedBadge } from '../components/SimulatedBadge';
import { StaffDetailSkeleton } from '../components/skeleton/routeSkeletons';
import { formatMoney } from '../lib/format';
import { formatWhen, METHOD_LABEL } from '../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../lib/skeletonTiming';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { stateClass, staffStateLabel } from './staffText';

type Load = { phase: 'loading' } | { phase: 'ready'; response: ApiResponse<StaffOrder> } | { phase: 'error'; status: number; message: string };

/** One order: who ordered it, what, where it goes, what happened to it, and what staff can do next. */
export function OrderDetailPage() {
  const { id = '' } = useParams();
  const w = useWorkspace();
  const back = (useLocation().state as { from?: string } | null)?.from ?? w.board; // a full path, given by the page that linked here
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getStaffOrder(id, controller.signal)
      .then((response) => setLoad({ phase: 'ready', response }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(error instanceof ApiError ? { phase: 'error', status: error.status, message: error.message } : { phase: 'error', status: 0, message: 'Could not load this order.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  if (load.phase === 'error') {
    return (
      <section className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
        <h1 className="text-4xl sm:text-5xl">{load.status === 404 ? 'Order not found' : 'Could not load this order'}</h1>
        <p role="alert" className="mt-3 text-lg text-brown-dark">
          {load.message}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {load.status !== 404 && (
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <Link to={back} className="btn btn-secondary">
            All orders
          </Link>
        </div>
      </section>
    );
  }
  if (load.phase === 'loading' || gate !== 'content') return <StaffDetailSkeleton gate={gate === 'content' ? 'skeleton' : gate} />;

  return <OrderView response={load.response} back={back} onOrder={(order) => setLoad({ phase: 'ready', response: { ...load.response, data: order } })} reload={() => setAttempt((n) => n + 1)} />;
}

function OrderView({ response, back, onOrder, reload }: { response: ApiResponse<StaffOrder>; back: string; onOrder: (order: StaffOrder) => void; reload: () => void }) {
  const order = response.data;
  const money = (n: number) => formatMoney(n, order.currency);
  const label = (state: StaffOrder['state']) => staffStateLabel(state, order.paymentMethod);
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<StaffAllowedMove | null>(null);
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  // when the "are you sure" panel opens, focus goes into it: to the note if one is needed, else to the button
  useEffect(() => {
    if (confirming) (confirming.needsNote ? noteField : confirmButton).current?.focus();
  }, [confirming]);

  const move = async (m: StaffAllowedMove, text: string) => {
    setBusy(true);
    setProblem(null);
    setFieldError(null);
    setDone(null);
    try {
      const next = await moveStaffOrder(order.id, { to: m.to, expectedState: order.state, ...(text.trim() ? { note: text.trim() } : {}) });
      onOrder(next.data);
      setDone(`Marked as ${staffStateLabel(next.data.state, next.data.paymentMethod).toLowerCase()}.`);
      setConfirming(null);
      setNote('');
    } catch (error) {
      if (!(error instanceof ApiError)) {
        setProblem('Could not reach the shop. Nothing was changed; please try again.');
      } else if (error.status === 422) {
        setFieldError(error.details.fields?.note ?? error.details.fields?.to ?? error.message);
      } else if (error.code === 'state_changed' && error.details.order) {
        // somebody got there first: the screen catches up and says so, and nothing was done
        onOrder(error.details.order);
        setConfirming(null);
        setProblem(error.message);
      } else {
        setProblem(error.message);
        setConfirming(null);
        reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const choose = (m: StaffAllowedMove) => {
    setProblem(null);
    setDone(null);
    setFieldError(null);
    if (m.confirm || m.needsNote) {
      setNote('');
      setConfirming(m);
    } else {
      void move(m, '');
    }
  };

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <Link to={back} className="text-sm underline underline-offset-4">
        All orders
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-4xl sm:text-5xl" data-testid="staff-order-heading">
          Order <span className="font-sans font-semibold tracking-wide">{order.reference}</span>
        </h1>
        <span className={`inline-block rounded-sm border px-2.5 py-1 text-sm font-semibold uppercase tracking-wider ${stateClass(order.state)}`} data-testid="staff-order-status" data-state={order.state}>
          {label(order.state)}
        </span>
        <SimulatedBadge simulation={response.simulation} />
      </div>
      <p className="mt-2 text-sm text-muted">
        Placed {formatWhen(order.createdAt)} · {METHOD_LABEL[order.paymentMethod]}
      </p>

      <div className="mt-6 border border-brown-dark bg-cream p-5" data-testid="staff-actions">
        <h2 className="text-3xl">What to do next</h2>
        {problem && (
          <p role="alert" className="mt-3 border-2 border-brown-dark bg-paper-warm p-3 font-medium text-brown-dark" data-testid="staff-problem">
            {problem}
          </p>
        )}
        {done && (
          <p role="status" className="mt-3 font-medium text-sage-dark" data-testid="staff-done">
            {done}
          </p>
        )}
        {order.allowed.length === 0 && order.blocked.length === 0 && (
          <p className="mt-2" data-testid="staff-final">
            This order is {label(order.state).toLowerCase()}. There is nothing more to do with it.
          </p>
        )}
        {order.allowed.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-3">
            {order.allowed.map((m) => (
              <button
                key={m.to}
                type="button"
                data-testid={`staff-move-${m.to}`}
                disabled={busy}
                aria-expanded={m.confirm || m.needsNote ? confirming?.to === m.to : undefined}
                onClick={() => choose(m)}
                className={`btn disabled:cursor-not-allowed disabled:opacity-60 ${m.to === 'cancelled' ? 'btn-secondary' : 'btn-primary'}`}
              >
                {busy && confirming === null ? 'Working…' : m.label}
              </button>
            ))}
          </div>
        )}
        {order.blocked.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm" data-testid="staff-blocked">
            {order.blocked.map((b) => (
              <li key={b.to}>
                <span className="font-medium text-ink">{b.label}:</span> <span className="text-muted">{b.reason}</span>
              </li>
            ))}
          </ul>
        )}
        {confirming && (
          <form
            className="mt-4 border-2 border-dashed border-brown-dark p-4"
            data-testid="staff-confirm"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void move(confirming, note);
            }}
          >
            <p className="font-medium text-ink" id={`${ids}-why`}>
              {confirming.direction === 'back'
                ? `This steps the order back to ${label(confirming.to)}. Nothing is undone in stock or payment; the note says why, in the history.`
                : confirming.to === 'cancelled' && confirming.needsNote
                ? "The customer's payment has been received. Cancelling this order leaves a refund to arrange outside this system, and it cannot be undone."
                : confirming.to === 'cancelled'
                  ? 'Cancelling gives the items back to stock, and it cannot be undone.'
                  : `${confirming.label}? This cannot be undone.`}
            </p>
            <label htmlFor={`${ids}-note`} className="mt-3 block text-sm font-medium">
              Note {confirming.direction === 'back' ? '(required: say why it is stepped back)' : confirming.needsNote ? '(required: write who will arrange the refund)' : '(optional)'}
            </label>
            <textarea
              id={`${ids}-note`}
              ref={noteField}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={500}
              aria-describedby={[`${ids}-why`, fieldError ? `${ids}-note-error` : null].filter(Boolean).join(' ')}
              aria-invalid={fieldError ? true : undefined}
              className="mt-1 block w-full border border-brown-dark bg-paper px-3 py-2 text-base"
            />
            {fieldError && (
              <p id={`${ids}-note-error`} role="alert" className="mt-1 text-sm font-medium text-brown-dark" data-testid="staff-note-error">
                {fieldError}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-3">
              <button ref={confirmButton} type="submit" disabled={busy} className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-60" data-testid="staff-confirm-yes">
                {busy ? 'Working…' : `Yes: ${confirming.label.toLowerCase()}`}
              </button>
              <button type="button" disabled={busy} className="btn btn-secondary" onClick={() => setConfirming(null)}>
                Go back
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div>
          <h2 className="text-3xl">Items</h2>
          <ul className="mt-3 divide-y divide-tan border-y border-tan" data-testid="staff-lines">
            {order.lines.map((l) =>
              isDesigned(l) ? (
                <li key={`${l.sku}#${l.designId}`} className="py-4" data-testid="staff-designed-line">
                  <div className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-start gap-x-4">
                    <img src={staffDesignUrl(l.designId, 'preview')} alt={`The customer's design on ${l.name}`} width={112} height={112} className="aspect-square w-full border border-tan bg-paper object-contain" data-testid="staff-design-preview" />
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{l.name}, customized</p>
                      <p className="text-sm text-muted">
                        {l.colorName}, size {l.size} · {l.quantity} × {money(l.unitPrice)}
                      </p>
                      <p className="text-xs text-muted">
                        {l.sku} · design {l.designId}
                      </p>
                      {l.printFee && (
                        <p className="mt-1 text-sm" data-testid="staff-print-fee">
                          {printFeeText(l.printFee, l.quantity, order.currency)} (rate {money(l.printFee.rate)} a sq in, {l.printFee.steps} size step{l.printFee.steps === 1 ? '' : 's'} at {money(l.printFee.sizeStep)})
                        </p>
                      )}
                      <a href={staffDesignUrl(l.designId, 'print')} download className="btn btn-secondary btn-small mt-2" data-testid="staff-download-print">
                        Download print file (PNG)
                      </a>
                      <p className="mt-2 text-sm font-medium text-brown-dark">Check the print file before packing: the shop prices the design from its elements and cannot check the picture itself.</p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-ink">{money(l.lineTotal)}</p>
                      {l.printFee && <p className="text-sm text-ink">+ print {money(l.printFee.total)}</p>}
                    </div>
                  </div>
                </li>
              ) : (
                <li key={l.sku} className="grid grid-cols-[4rem_minmax(0,1fr)_auto] items-center gap-x-4 py-3">
                  <img src={l.image} alt="" width={64} height={64} className="aspect-square w-full border border-tan bg-paper object-contain" />
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{l.name}</p>
                    <p className="text-sm text-muted">
                      {l.colorName}, size {l.size} · {l.quantity} × {money(l.unitPrice)}
                    </p>
                    <p className="text-xs text-muted">{l.sku}</p>
                  </div>
                  <p className="font-semibold text-ink">{money(l.lineTotal)}</p>
                </li>
              ),
            )}
          </ul>
          <div className="mt-4 max-w-sm">
            <QuoteTotals quote={order} />
          </div>

          <h2 className="mt-10 text-3xl">History</h2>
          <ol className="mt-3 space-y-3 border-l-2 border-tan pl-5" data-testid="staff-history">
            <li className="text-sm">
              <p className="font-medium text-ink">Order placed</p>
              <p className="text-muted">{formatWhen(order.createdAt)}</p>
            </li>
            {order.history.map((h, i) => (
              <li key={`${h.at}-${i}`} className="text-sm" data-testid="staff-history-row">
                <p className="font-medium text-ink">
                  {label(h.from)} <span aria-hidden="true">→</span>
                  <span className="sr-only"> to </span> {label(h.to)}
                </p>
                <p className="text-muted">
                  {formatWhen(h.at)} · {h.actor === 'automatic' ? 'Closed automatically after delivery' : h.staff}
                  {h.actor === 'customer' && ' (the customer, confirming they received it)'}
                  {h.via === 'odoo' && ' (changed in the Odoo screens)'}
                  {h.stepBack && ' · stepped back by an Administrator'}
                </p>
                {h.note && <p className="mt-0.5 text-ink">Note: {h.note}</p>}
              </li>
            ))}
          </ol>
        </div>

        <div className="space-y-5">
          <div className="border border-tan bg-cream p-5">
            <h2 className="text-3xl">Customer</h2>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="staff-customer">
              <dt className="text-muted">Name</dt>
              <dd>{order.customer.name}</dd>
              <dt className="text-muted">Email</dt>
              <dd className="break-all">{order.customer.email}</dd>
              <dt className="text-muted">Phone</dt>
              <dd>{order.customer.phone || 'Not given'}</dd>
            </dl>
          </div>
          <div className="border border-tan bg-cream p-5">
            <h2 className="text-3xl">Deliver to</h2>
            <address className="mt-2 not-italic" data-testid="staff-delivery">
              <p className="font-medium text-ink">{order.delivery.fullName}</p>
              <p>{order.delivery.street}</p>
              <p>
                {order.delivery.city}, {order.delivery.provinceName} {order.delivery.postalCode}
              </p>
              <p className="mt-2 text-sm">{order.delivery.phone}</p>
              <p className="break-all text-sm">{order.delivery.email}</p>
              {order.delivery.note && <p className="mt-2 text-sm">Note from the customer: {order.delivery.note}</p>}
            </address>
          </div>
          <div className="border border-tan bg-cream p-5">
            <h2 className="text-3xl">Payment</h2>
            <p className="mt-2">{METHOD_LABEL[order.paymentMethod]}</p>
            <p className="text-sm text-muted" data-testid="staff-payment">
              {order.paymentMethod === 'cod'
                ? order.state === 'delivered'
                  ? 'Cash collected on delivery.'
                  : 'Cash is collected when the order is delivered.'
                : order.state === 'awaiting_payment'
                  ? 'Waiting for the transfer. Mark the payment received when it arrives.'
                  : order.state === 'cancelled' && order.history.every((h) => h.from !== 'confirmed' && h.from !== 'packed')
                    ? 'No payment was received.'
                    : 'Transfer received.'}
            </p>
            {order.paymentMethod === 'bank_transfer' && order.bankTransfer && <p className="mt-1 text-sm text-muted">Reference {order.bankTransfer.paymentReference}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
