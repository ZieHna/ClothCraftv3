import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { designPreviewUrl } from '../api/designs';
import { confirmReceived, getOrder } from '../api/orders';
import { isDesigned, printFeeText } from '../cart/designed';
import { ApiError } from '../api/client';
import type { ApiResponse, Order } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { OrderTracker } from '../components/OrderTracker';
import { QuoteTotals } from '../components/QuoteTotals';
import { RequireAccount } from '../components/RequireAccount';
import { RouteFallback } from '../components/skeleton/pageSkeletons';
import { OrderSkeleton } from '../components/skeleton/routeSkeletons';
import { SimulatedBadge } from '../components/SimulatedBadge';
import { formatMoney } from '../lib/format';
import { formatWhen, METHOD_LABEL, STATE_LABEL, STEP_LABEL } from '../lib/orderText';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { useVisiblePolling } from '../lib/useVisiblePolling';

type Load = { phase: 'loading' } | { phase: 'ready'; response: ApiResponse<Order> } | { phase: 'error'; status: number; message: string };

/** The order confirmation, and the page a link in the orders list opens. */
export function OrderPage() {
  return (
    <RequireAccount what="see your order" checking={<RouteFallback kind="order" />}>
      <OrderView />
    </RequireAccount>
  );
}

function OrderView() {
  const { id = '' } = useParams();
  const justPlaced = (useLocation().state as { justPlaced?: boolean } | null)?.justPlaced === true;
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error' });
  const heading = useRef<HTMLHeadingElement>(null);
  const statusHeading = useRef<HTMLParagraphElement>(null);
  // step 11: "Confirm I received my order"
  const [confirming, setConfirming] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [said, setSaid] = useState('');

  /** Take a newer copy of the order only when something in it changed, so a refresh that finds nothing new redraws nothing. */
  const take = (response: ApiResponse<Order>) =>
    setLoad((previous) => {
      if (previous.phase === 'ready' && JSON.stringify(previous.response) === JSON.stringify(response)) return previous;
      if (previous.phase === 'ready' && previous.response.data.tracking?.current !== response.data.tracking?.current && response.data.tracking?.current) {
        setSaid(`Your order is now at: ${STEP_LABEL[response.data.tracking.current]}.`);
      }
      return { phase: 'ready', response };
    });
  // step 11: the page asks again when the tab comes back or the window regains focus, and every 60 s while it is on screen; it stops
  // once the order cannot change any more, and while the confirmation dialog is open. The mock (no tracking) is not polled.
  const live = load.phase === 'ready' && !!load.response.data.tracking && !['closed', 'cancelled'].includes(load.response.data.state);
  useVisiblePolling(
    async () => {
      try {
        take(await getOrder(id));
        return true;
      } catch {
        return false;                       // keep what is on screen; the wait before the next try grows
      }
    },
    { every: 60_000, enabled: live, paused: () => confirming },
  );

  const confirm = async () => {
    setConfirmBusy(true);
    setConfirmError('');
    try {
      const response = await confirmReceived(id);
      setConfirming(false);
      take(response);
      setSaid('Thank you. You confirmed you received your order, and it is now complete.');
      requestAnimationFrame(() => statusHeading.current?.focus());
    } catch (error) {
      setConfirming(false);
      setConfirmError(error instanceof ApiError ? error.message : 'Could not reach the shop. Nothing was changed. Please try again.');
      void getOrder(id).then(take).catch(() => undefined);
    } finally {
      setConfirmBusy(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getOrder(id, controller.signal)
      .then((response) => setLoad({ phase: 'ready', response }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(error instanceof ApiError ? { phase: 'error', status: error.status, message: error.message } : { phase: 'error', status: 0, message: 'Could not load this order.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  // after placing an order the page opens on its heading, so it is the first thing read out
  useEffect(() => {
    // (not while the skeleton is still held: the heading is not there yet)
    if (load.phase === 'ready' && gate === 'content' && justPlaced) heading.current?.focus();
  }, [load.phase, gate, justPlaced]);

  if (load.phase === 'error') {
    return (
      <section className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
        <h1 className="text-5xl">{load.status === 404 ? 'Order not found' : 'Could not load this order'}</h1>
        <p role="alert" className="mt-3 text-lg text-brown-dark">
          {load.message}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {load.status !== 404 && (
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <Link to="/account" className="btn btn-secondary">
            Your orders
          </Link>
        </div>
      </section>
    );
  }

  if (load.phase === 'loading' || gate !== 'content') return <OrderSkeleton gate={gate === 'content' ? 'skeleton' : gate} />;

  const order = load.response.data;
  const money = (n: number) => formatMoney(n, order.currency);
  return (
    <section className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-center gap-3">
        <p className="eyebrow">{justPlaced ? 'Order placed' : 'Order'}</p>
        <SimulatedBadge simulation={load.response.simulation} />
      </div>
      <h1 ref={heading} tabIndex={-1} className="mt-1 text-5xl outline-none" data-testid="order-heading">
        {justPlaced ? `Thank you. Your order is ${order.reference}` : `Order ${order.reference}`}
      </h1>
      <p className="mt-2 text-sm text-muted">
        Placed {formatWhen(order.createdAt)} · {METHOD_LABEL[order.paymentMethod]}
      </p>

      {/* one polite region: a step reached while the page is open, and the confirmation */}
      <p role="status" className="sr-only" data-testid="order-said">
        {said}
      </p>
      <StatusBox order={order} headingRef={statusHeading} onConfirm={() => setConfirming(true)} confirmError={confirmError} />
      {confirming && (
        <ConfirmDialog
          title="Did you receive your order?"
          yes="Yes, I received it"
          no="Not yet"
          busy={confirmBusy}
          onYes={() => void confirm()}
          onNo={() => setConfirming(false)}
          testId="confirm-received-dialog"
        >
          <p>Confirm only once you have your items. This completes order {order.reference}.</p>
        </ConfirmDialog>
      )}

      <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,1fr)_20rem] md:items-start">
        <div>
          <h2 className="text-3xl">Items</h2>
          <ul className="mt-3 divide-y divide-tan border-y border-tan" data-testid="order-lines">
            {order.lines.map((l) =>
              isDesigned(l) ? (
                // a customized garment: the customer's own design, the garment's price, and the print fee as its own line (as ordered)
                <li key={`${l.sku}#${l.designId}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3" data-testid="order-designed-line">
                  <img src={designPreviewUrl(l.designId)} alt={`Your design on ${l.name}`} width={72} height={72} className="row-span-2 aspect-square w-full border border-tan bg-paper object-contain" />
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{l.name}, customized</p>
                    <p className="text-sm text-muted">
                      {l.colorName}, size {l.size} · {l.quantity} × {money(l.unitPrice)}
                    </p>
                  </div>
                  <p className="font-semibold text-ink">{money(l.lineTotal)}</p>
                  {l.printFee && (
                    <>
                      <p className="col-start-2 text-sm text-muted" data-testid="order-print-fee">
                        {printFeeText(l.printFee, l.quantity, order.currency)}
                      </p>
                      <p className="font-semibold text-ink">{money(l.printFee.total)}</p>
                    </>
                  )}
                </li>
              ) : (
                <li key={l.sku} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-4 py-3">
                  <img src={l.image} alt="" width={72} height={72} className="aspect-square w-full border border-tan bg-paper object-contain" />
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{l.name}</p>
                    <p className="text-sm text-muted">
                      {l.colorName}, size {l.size} · {l.quantity} × {money(l.unitPrice)}
                    </p>
                  </div>
                  <p className="font-semibold text-ink">{money(l.lineTotal)}</p>
                </li>
              ),
            )}
          </ul>
          <div className="mt-4 max-w-sm">
            <QuoteTotals quote={order} />
          </div>
        </div>

        <div className="border border-tan bg-cream p-5">
          <h2 className="text-3xl">Delivery to</h2>
          <address className="mt-2 not-italic" data-testid="order-delivery">
            <p className="font-medium text-ink">{order.delivery.fullName}</p>
            <p>{order.delivery.street}</p>
            <p>
              {order.delivery.city}, {order.delivery.provinceName} {order.delivery.postalCode}
            </p>
            <p className="mt-2 text-sm">{order.delivery.phone}</p>
            <p className="text-sm">{order.delivery.email}</p>
            {order.delivery.note && <p className="mt-2 text-sm">Note: {order.delivery.note}</p>}
          </address>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link to="/account" className="btn btn-secondary">
          Your orders
        </Link>
        <Link to="/category" className="btn btn-primary">
          Keep shopping
        </Link>
      </div>
    </section>
  );
}

/**
 * What the order's state means for the shopper, in words, and (bank transfer) where to pay. Never a payment deadline, nor any date
 * promised. Step 11 (real service): the four-step tracker, and at delivered "Confirm I received my order".
 */
function StatusBox({ order, headingRef, onConfirm, confirmError }: { order: Order; headingRef: RefObject<HTMLParagraphElement | null>; onConfirm: () => void; confirmError: string }) {
  const t = order.tracking;
  return (
    <div className="mt-6 border border-brown-dark bg-cream p-5" data-testid="order-status" data-state={order.state}>
      <p ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">
        {STATE_LABEL[order.state]}
      </p>
      {t && order.state !== 'cancelled' && <OrderTracker tracking={t} />}
      {order.state === 'out_for_delivery' && (
        <p className="mt-3">Your order is on its way to you.{order.paymentMethod === 'cod' && ' Please pay in cash when it arrives.'}</p>
      )}
      {order.state === 'delivered' && t?.canConfirm && (
        <div className="mt-4 border-t border-tan pt-4" data-testid="confirm-received-box">
          <p>Your order was delivered. Please tell us once you have it.</p>
          <button type="button" className="btn btn-primary mt-3" onClick={onConfirm} data-testid="confirm-received">
            Confirm I received my order
          </button>
          <p className="mt-2 text-sm text-muted" data-testid="auto-close-note">
            If you don't confirm, we'll close the order automatically.
          </p>
        </div>
      )}
      {confirmError && (
        <p role="alert" className="mt-3 font-medium text-brown-dark" data-testid="confirm-error">
          {confirmError}
        </p>
      )}
      {order.state === 'closed' && (
        <p className="mt-3" data-testid="closed-note">
          {t?.closedBy === 'customer' ? 'You confirmed you received your order. ' : 'This order is complete. '}Thank you for shopping with ClothCraft.
        </p>
      )}
      {order.state === 'confirmed' && order.paymentMethod === 'cod' && <p className="mt-1">Your order is confirmed and your items are set aside. Please pay in cash when your order arrives.</p>}
      {order.state === 'confirmed' && order.paymentMethod === 'bank_transfer' && <p className="mt-1">We have received your payment and your order is confirmed. Your items are set aside.</p>}
      {/* what each step means, in words. No step carries a date or a deadline: none is promised anywhere. */}
      {order.state === 'packed' && <p className="mt-1">Your items are packed and ready to be handed over for delivery.</p>}
      {order.state === 'shipped' && (
        <p className="mt-1">Your order has been handed over for delivery.{order.paymentMethod === 'cod' && ' Please pay in cash when it arrives.'}</p>
      )}
      {order.state === 'delivered' && !t?.canConfirm && <p className="mt-1">Your order was delivered. Thank you for shopping with ClothCraft.</p>}
      {order.state === 'awaiting_payment' && (
        <>
          <p className="mt-1" data-testid="wait-note">
            Your items are reserved, and the order waits for your payment. If payment is not received, our staff may cancel the order, and the items then go back into stock.
          </p>
          {order.bankTransfer && (
            <div className="mt-4" data-testid="bank-details">
              <h2 className="text-2xl">Where to send your payment</h2>
              {order.bankTransfer.placeholder && <p className="mt-1 text-sm font-medium text-brown-dark">These bank details are placeholders: the shop has no bank account yet. Do not send money.</p>}
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted">Bank</dt>
                <dd>{order.bankTransfer.bankName}</dd>
                <dt className="text-muted">Account name</dt>
                <dd>{order.bankTransfer.accountName}</dd>
                <dt className="text-muted">Account number</dt>
                <dd>{order.bankTransfer.accountNumber}</dd>
                <dt className="text-muted">Amount</dt>
                <dd className="font-semibold text-ink">{formatMoney(order.total, order.currency)}</dd>
                <dt className="text-muted">Write on the transfer</dt>
                <dd className="font-semibold text-ink">{order.bankTransfer.paymentReference}</dd>
              </dl>
            </div>
          )}
        </>
      )}
      {order.state === 'cancelled' && <p className="mt-1">This order was cancelled. Its items went back into stock.</p>}

    </div>
  );
}
