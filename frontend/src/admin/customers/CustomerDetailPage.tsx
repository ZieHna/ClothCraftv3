import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import {
  deactivateCustomer, getCustomer, reactivateCustomer, type CustomerAuditEntry, type CustomerAuditValues, type CustomerDetail, type CustomerOrder,
} from '../../api/adminCustomers';
import { ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { StaffDetailSkeleton } from '../../components/skeleton/routeSkeletons';
import { formatWhen } from '../../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { pesos } from '../../staff/suppliers/supplierText';
import { problemOf, useSubmit } from '../../staff/suppliers/supplierUi';
import { ActiveBadge } from '../employees/employeeUi';

type Load = { phase: 'loading' } | { phase: 'ready'; customer: CustomerDetail; orders: CustomerOrder[]; audit: CustomerAuditEntry[] } | { phase: 'error'; status: number; message: string };

/** The order states as the admin pages name them (the server sends the state; this only puts it in words). */
const ORDER_STATE: Record<string, string> = {
  awaiting_payment: 'Awaiting payment', confirmed: 'Received or paid', packed: 'Packed', shipped: 'Shipped', out_for_delivery: 'On delivery',
  delivered: 'Delivered', closed: 'Closed', cancelled: 'Cancelled',
};
const ACTION_LABEL: Record<CustomerAuditEntry['action'], string> = { edited: 'Edited', deactivated: 'Deactivated', reactivated: 'Reactivated' };
const FIELD_LABEL: Record<keyof CustomerAuditValues, string> = { name: 'Name', email: 'Email', phone: 'Phone', active: 'Status' };
const shown = (key: keyof CustomerAuditValues, v: CustomerAuditValues[keyof CustomerAuditValues]) =>
  v === null || v === undefined || v === '' ? 'none' : key === 'active' ? (v ? 'Active' : 'Inactive') : String(v);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One customer: the figures Odoo worked out, recent orders, the account actions and the recorded changes (read-only). No address here. */
export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const arrived = (useLocation().state as { notice?: string } | null)?.notice ?? null;
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const { busy, run } = useSubmit();
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });

  useEffect(() => {
    const controller = new AbortController();
    setLoad((current) => (current.phase === 'ready' && attempt > 0 ? current : { phase: 'loading' }));
    getCustomer(id, controller.signal)
      .then((response) => setLoad({ phase: 'ready', customer: response.data.customer, orders: response.data.recentOrders, audit: response.data.audit }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', status: error instanceof ApiError ? error.status : 0, message: error instanceof ApiError ? error.message : 'Could not load the customer.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  if (load.phase === 'loading' || gate !== 'content') return <StaffDetailSkeleton gate={gate === 'content' ? 'skeleton' : gate} label="Loading the customer…" />;
  if (load.phase === 'error') {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-4xl sm:text-5xl">{load.status === 404 ? 'No such customer' : 'Could not load the customer'}</h1>
        <p role="alert" className="mt-3 font-medium text-brown-dark">
          {load.message}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {load.status !== 404 && (
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <Link to="/admin/customers" className="btn btn-secondary">
            All customers
          </Link>
        </div>
      </section>
    );
  }
  const c = load.customer;
  const notice = said ?? arrived;
  const toggle = () =>
    void run(async () => {
      try {
        const response = await (c.active ? deactivateCustomer(c.id) : reactivateCustomer(c.id));
        setAsking(false);
        setFailed(null);
        setSaid(c.active ? `${c.name} was deactivated and signed out.` : `${c.name} was reactivated.`);
        setLoad({ ...load, customer: response.data.customer });
        setAttempt((n) => n + 1);
      } catch (error) {
        setAsking(false);
        setSaid(null);
        setFailed(problemOf(error, []).message ?? 'The change was not made.');
      }
    });

  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:py-10" data-testid="customer-detail">
      <p>
        <Link to="/admin/customers" className="text-sm underline underline-offset-4">
          ← All customers
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-4xl sm:text-5xl" data-testid="customer-name">
          {c.name}
        </h1>
        <ActiveBadge active={c.active} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link to={`/admin/customers/${c.id}/edit`} className="btn btn-primary" data-testid="customer-edit">
          Edit details
        </Link>
        <button type="button" className="btn btn-secondary" onClick={() => setAsking(true)} data-testid={c.active ? 'customer-deactivate' : 'customer-reactivate'}>
          {c.active ? 'Deactivate' : 'Reactivate'}
        </button>
      </div>
      {failed && (
        <p role="alert" className="mt-3 font-medium text-brown-dark" data-testid="customer-failed">
          {failed}
        </p>
      )}
      {notice && !failed && (
        <p role="status" className="mt-3 font-medium text-sage-dark" data-testid="customer-done">
          {notice}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title={c.active ? 'Deactivate this account' : 'Reactivate this account'}
          yes={c.active ? 'Deactivate' : 'Reactivate'}
          no="Cancel"
          busy={busy}
          onYes={toggle}
          onNo={() => setAsking(false)}
          testId="customer-confirm"
        >
          <p>
            {c.active
              ? `Deactivate ${c.name}? They are signed out at once and cannot sign in until you reactivate the account. Their orders, cart and designs stay as they are.`
              : `Reactivate ${c.name}? They can sign in again with their current password.`}
          </p>
        </ConfirmDialog>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <Card title="Account">
          <dl className="space-y-2">
            <Row label="Email (the sign-in name)">
              <span className="break-all">{c.email}</span>
            </Row>
            <Row label="Phone">{c.phone ?? 'None'}</Row>
            <Row label="Registered">{formatWhen(c.registeredAt)}</Row>
            <Row label="Last sign-in">{c.lastSignInAt ? formatWhen(c.lastSignInAt) : 'Never'}</Row>
          </dl>
        </Card>
        <Card title="Orders">
          <dl className="space-y-2" data-testid="customer-figures">
            <Row label="Orders placed">{c.orderCount}</Row>
            <Row label="Total spent (closed orders, VAT included)">
              {pesos(c.totalSpent)} <span className="text-sm text-muted">({plural(c.closedCount, 'order', 'orders')})</span>
            </Row>
            <Row label="Delivered, awaiting confirmation (not part of total spent)">
              {pesos(c.deliveredAwaiting.total)} <span className="text-sm text-muted">({plural(c.deliveredAwaiting.orderCount, 'order', 'orders')})</span>
            </Row>
            <Row label="Awaiting payment">{plural(c.awaitingPayment, 'order', 'orders')}</Row>
            <Row label="In the cart now">{plural(c.cartLines, 'line', 'lines')}</Row>
            <Row label="Draft designs">{c.draftDesigns}</Row>
          </dl>
        </Card>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <Card title="Recent orders">
          {load.orders.length === 0 ? (
            <p className="text-muted" data-testid="customer-orders-empty">
              No orders yet.
            </p>
          ) : (
            <ul className="divide-y divide-tan border-y border-tan" data-testid="customer-orders">
              {load.orders.map((o) => (
                <li key={o.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                  <span>
                    <Link to={`/admin/orders/${o.id}`} className="font-semibold text-ink underline underline-offset-4">
                      {o.name}
                    </Link>
                    <span className="block text-sm text-muted">
                      {ORDER_STATE[o.state] ?? o.state}, {formatWhen(o.placedAt)}
                    </span>
                  </span>
                  <span className="font-medium">{pesos(o.amountTotal)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent changes">
          {load.audit.length === 0 ? (
            <p className="text-muted" data-testid="customer-audit-empty">
              Nothing has been recorded for this account yet.
            </p>
          ) : (
            <ol className="divide-y divide-tan border-y border-tan" data-testid="customer-audit">
              {load.audit.map((a) => (
                <li key={a.id} className="py-3">
                  <p className="font-semibold text-ink">{ACTION_LABEL[a.action]}</p>
                  <p className="text-sm text-muted">
                    {a.actorName}, {formatWhen(a.at)}
                  </p>
                  {(Object.keys(a.new ?? {}) as (keyof CustomerAuditValues)[])
                    .filter((k) => k in FIELD_LABEL)
                    .map((k) => (
                      <p key={k} className="break-words text-sm">
                        {FIELD_LABEL[k]}: {shown(k, a.old?.[k])} → {shown(k, a.new?.[k])}
                      </p>
                    ))}
                </li>
              ))}
            </ol>
          )}
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
