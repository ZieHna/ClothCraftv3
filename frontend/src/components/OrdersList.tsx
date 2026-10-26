import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client';
import { listOrders } from '../api/orders';
import type { ApiResponse, Order } from '../api/types';
import { OrdersListSkeleton } from './skeleton/pageSkeletons';
import { formatMoney } from '../lib/format';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { formatWhen, METHOD_LABEL, STATE_LABEL } from '../lib/orderText';

type Load = { phase: 'loading' } | { phase: 'ready'; response: ApiResponse<Order[]> } | { phase: 'error'; message: string };

/** The orders of the signed-in customer. Stacked rows, so there is no sideways scroll. */
export function OrdersList() {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error' || (load.phase === 'ready' && load.response.data.length === 0) });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    listOrders(controller.signal)
      .then((response) => setLoad({ phase: 'ready', response }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load your orders.' });
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <div id="orders" className="mt-8 scroll-mt-4" data-testid="orders">
      <h2 className="text-3xl">Your orders</h2>
      {gate !== 'content' && <OrdersListSkeleton gate={gate} />}
      {gate === 'content' && load.phase === 'error' && (
        <div role="alert" className="mt-3">
          <p className="font-medium text-brown-dark">{load.message}</p>
          <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {gate === 'content' && load.phase === 'ready' && load.response.data.length === 0 && (
        <p className="mt-3" data-testid="orders-empty">
          You have not placed an order yet. <Link to="/category" className="underline underline-offset-4">Choose a category</Link>
        </p>
      )}
      {gate === 'content' && load.phase === 'ready' && load.response.data.length > 0 && (
        <ul className="mt-3 divide-y divide-tan border-y border-tan" data-testid="orders-list">
          {load.response.data.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3" data-testid="order-row">
              <div className="min-w-0">
                <Link to={`/orders/${o.id}`} className="text-lg font-semibold text-ink underline underline-offset-4">
                  Order {o.reference}
                </Link>
                <p className="text-sm text-muted">
                  {formatWhen(o.createdAt)} · {METHOD_LABEL[o.paymentMethod]}
                </p>
              </div>
              <p className="flex items-center gap-4">
                <span className="rounded-sm border border-brown-dark px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-brown-dark">{STATE_LABEL[o.state]}</span>
                <span className="font-semibold text-ink">{formatMoney(o.total, o.currency)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
