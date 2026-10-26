import { Link } from 'react-router';
import type { AdminDashboard } from '../../api/adminDashboard';
import { formatWhen } from '../../lib/orderText';
import { pesos } from '../../staff/suppliers/supplierText';
import { BarRows, type Bar, ChartCard, ColumnChart, DataTable, monthLong, monthShort } from './charts';

/** Every figure below is read from the server's answer and shown as it came; nothing here adds, averages or splits money. */
const MONTHS_IN_CHART = 36;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function Kpi({ label, value, lines, testId, link }: { label: string; value: string; lines: string[]; testId: string; link: { to: string; label: string } }) {
  return (
    <div className="min-w-0 border border-tan bg-cream p-4" data-testid={testId}>
      <p className="text-sm font-medium text-muted">{label}</p>
      <p className="mt-1 break-words text-3xl font-semibold text-ink">{value}</p>
      {lines.map((l) => (
        <p key={l} className="text-xs text-muted">
          {l}
        </p>
      ))}
      <Link to={link.to} className="mt-1 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" data-testid="kpi-link">
        {link.label} →
      </Link>
    </div>
  );
}

export function Kpis({ d }: { d: AdminDashboard }) {
  const k = d.kpis;
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-5" data-testid="kpis">
      <Kpi
        testId="kpi-revenue"
        link={{ to: '/admin/orders/list?state=closed', label: 'View closed orders' }}
        label="Earned (Closed, customer confirmed), VAT included"
        value={pesos(k.revenue.total)}
        lines={[`VAT ${pesos(k.revenue.vat)} · net ${pesos(k.revenue.net)}`, plural(k.revenue.orderCount, 'closed order', 'closed orders')]}
      />
      <Kpi
        testId="kpi-awaiting"
        link={{ to: '/admin/orders/list?state=delivered', label: 'View delivered orders' }}
        label="Delivered, awaiting confirmation, VAT included"
        value={pesos(k.deliveredAwaiting.total)}
        lines={[
          `VAT ${pesos(k.deliveredAwaiting.vat)} · net ${pesos(k.deliveredAwaiting.net)}`,
          plural(k.deliveredAwaiting.orderCount, 'delivered order', 'delivered orders'),
          'Not earnings until the customer confirms or the order closes by itself.',
        ]}
      />
      <Kpi
        testId="kpi-orders"
        link={{ to: '/admin/orders', label: 'View the orders summary' }}
        label="Orders placed"
        value={String(k.orders.placed)}
        lines={[k.orders.cancelled > 0 ? `${k.orders.cancelled} cancelled, not counted` : 'none cancelled']}
      />
      <Kpi testId="kpi-low" link={{ to: '/admin/stock?low=true', label: 'View low stock' }} label="Low-stock variants (now)" value={String(k.lowStock.count)} lines={[`of ${k.lowStock.variants} variants`]} />
      <Kpi
        testId="kpi-restocks"
        link={{ to: '/admin/restocks?state=requested', label: 'View waiting restocks' }}
        label="Restocks waiting for approval (now)"
        value={String(k.restocksWaiting.count)}
        lines={[k.restocksWaiting.count > 0 ? `estimate ${pesos(k.restocksWaiting.estimateTotal)}` : 'nothing waiting']}
      />
    </div>
  );
}

export function RevenuePanel({ d }: { d: AdminDashboard }) {
  const months = d.revenueByMonth;
  const shown = months.slice(-MONTHS_IN_CHART);
  const bars: Bar[] = shown.map((m) => ({
    key: m.month, label: monthShort(m.month), value: m.total, shown: pesos(m.total),
    pending: { value: m.pending.total, shown: pesos(m.pending.total) },
    detail: `${monthLong(m.month)}: earned ${pesos(m.total)} VAT included (VAT ${pesos(m.vat)}, net ${pesos(m.net)}) from ${plural(m.orders, 'closed order', 'closed orders')}; delivered and awaiting confirmation ${pesos(m.pending.total)} from ${plural(m.pending.orders, 'order', 'orders')}, not earnings.`,
  }));
  const empty = d.kpis.revenue.orderCount === 0 && d.kpis.deliveredAwaiting.orderCount === 0;
  return (
    <ChartCard
      title="Earned per month"
      note="Closed orders (the customer confirmed), VAT included, by the month they closed (Manila time). The outlined bars are delivered orders still waiting for confirmation, by the month they were delivered: they are not earnings."
      testId="panel-revenue"
      link={{ to: '/admin/orders/list?state=closed', label: 'View closed orders' }}
    >
      {empty ? (
        <p data-testid="revenue-empty">No closed or delivered orders in this period.</p>
      ) : (
        <>
          <ColumnChart
            title="Earned per month"
            summary={`${pesos(d.kpis.revenue.total)} earned from ${plural(d.kpis.revenue.orderCount, 'closed order', 'closed orders')}; ${pesos(d.kpis.deliveredAwaiting.total)} delivered and awaiting confirmation, not earnings.`}
            bars={bars}
          />
          {months.length > MONTHS_IN_CHART && <p className="text-xs text-muted">The chart shows the last {MONTHS_IN_CHART} months. The table has all of them.</p>}
          <DataTable
            caption="Earned per month, and delivered orders awaiting confirmation"
            columns={['Month', 'Earned (VAT included)', 'VAT', 'Net', 'Closed orders', 'Delivered, awaiting confirmation (not earnings)', 'Delivered orders']}
            rows={months.map((m) => [monthLong(m.month), pesos(m.total), pesos(m.vat), pesos(m.net), m.orders, pesos(m.pending.total), m.pending.orders])}
          />
        </>
      )}
    </ChartCard>
  );
}

export function TopTypesPanel({ d }: { d: AdminDashboard }) {
  const rows = d.topGarmentTypes;
  const bars: Bar[] = rows.map((t) => ({ key: t.code, label: `${t.name} · ${pesos(t.revenue)}`, value: t.units, shown: plural(t.units, 'unit', 'units'), detail: '' }));
  return (
    <ChartCard title="Top selling garment types" note="By units in closed orders. Customization fees are not counted." testId="panel-top" link={{ to: '/admin/orders/list?state=closed', label: 'View closed orders' }}>
      {rows.length === 0 ? (
        <p data-testid="top-empty">No closed orders in this period.</p>
      ) : (
        <>
          <BarRows bars={bars} testId="top-rows" />
          <DataTable caption="Top selling garment types" columns={['Garment type', 'Units', 'Earned (VAT included)']} rows={rows.map((t) => [t.name, t.units, pesos(t.revenue)])} />
        </>
      )}
    </ChartCard>
  );
}

export function OrdersPanel({ d }: { d: AdminDashboard }) {
  const rows = d.ordersByStatus;
  const any = rows.some((r) => r.count > 0);
  const bars: Bar[] = rows.map((r) => ({ key: r.state, label: r.label, value: r.count, shown: String(r.count), detail: '' }));
  return (
    <ChartCard title="Orders by status" note="Orders placed in this period, by where they are now." testId="panel-orders" link={{ to: '/admin/orders', label: 'View the orders summary' }}>
      {!any ? (
        <p data-testid="orders-empty">No orders in this period.</p>
      ) : (
        <>
          <BarRows bars={bars} testId="orders-rows" />
          <DataTable caption="Orders by status" columns={['Status', 'Orders']} rows={rows.map((r) => [r.label, r.count])} />
        </>
      )}
    </ChartCard>
  );
}

export function StockPanel({ d }: { d: AdminDashboard }) {
  const a = d.stockAlerts;
  return (
    <ChartCard title="Stock alerts" note="Variants below their low-stock level, now." testId="panel-stock" link={{ to: '/admin/stock?low=true', label: 'View low stock' }}>
      {a.count === 0 ? (
        <p data-testid="stock-empty">No variant is low on stock.</p>
      ) : (
        <>
          <p className="text-sm">
            <span className="text-2xl font-semibold text-ink">{a.count}</span> {a.count === 1 ? 'variant is' : 'variants are'} low
            {a.variants.length < a.count ? `; the ${a.variants.length} with the least free stock:` : ':'}
          </p>
          <ul className="mt-2 divide-y divide-tan border-y border-tan text-sm" data-testid="stock-rows">
            {a.variants.map((v) => (
              <li key={v.id} className="py-2">
                <span className="block break-words font-medium text-ink">{v.sku ?? v.name}</span>
                <span className="block text-xs text-muted">
                  {v.free} free ({v.onHand} on hand, {v.reserved} reserved) · alert at {v.alertAt}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </ChartCard>
  );
}

export function RestockPanel({ d }: { d: AdminDashboard }) {
  const q = d.restockQueue;
  const none = q.requested + q.approved + q.notReceived === 0;
  return (
    <ChartCard title="Restock queue" note="Where the restock tickets are now." testId="panel-restocks" link={{ to: '/admin/restocks', label: 'View restocks' }}>
      {none ? (
        <p data-testid="restocks-empty">No restocks are open.</p>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 text-center text-sm">
            {[['Waiting', q.requested], ['Approved', q.approved], ['Not received', q.notReceived]].map(([label, n]) => (
              <div key={label} className="border border-tan p-2">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-2xl font-semibold text-ink">{n}</dd>
              </div>
            ))}
          </dl>
          {q.oldestWaiting.length > 0 && (
            <>
              <p className="mt-3 text-sm font-medium">Waiting longest</p>
              <ul className="mt-1 divide-y divide-tan border-y border-tan text-sm" data-testid="restocks-rows">
                {q.oldestWaiting.map((r) => (
                  <li key={r.id} className="py-2">
                    <span className="block font-medium text-ink">
                      {r.name} · {r.supplier.name}
                    </span>
                    <span className="block text-xs text-muted">
                      {pesos(r.estimateTotal)} estimate · {r.requestedBy}, {formatWhen(r.requestedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </ChartCard>
  );
}

export function SpendPanel({ d }: { d: AdminDashboard }) {
  const s = d.supplierSpend;
  const bars: Bar[] = s.suppliers.map((x) => ({ key: x.id, label: x.name, value: x.receivedTotal, shown: pesos(x.receivedTotal), detail: '' }));
  return (
    <ChartCard title="Supplier spend" note="What received restocks cost in this period, VAT included." testId="panel-spend" link={{ to: '/admin/suppliers', label: 'View suppliers' }}>
      <div className="border border-dashed border-brown-dark p-3" data-testid="spend-opening">
        <p className="text-xs font-medium text-muted">Starting investment (opening balance), not part of any period</p>
        <p className="text-xl font-semibold text-ink">{pesos(s.openingBalance.total)}</p>
        <p className="text-xs text-muted">
          VAT {pesos(s.openingBalance.vat)} · net {pesos(s.openingBalance.net)}
        </p>
      </div>
      <div className="mt-3" data-testid="spend-received">
        <p className="text-xs font-medium text-muted">Received restocks in this period</p>
        <p className="text-xl font-semibold text-ink">{pesos(s.received.total)}</p>
        <p className="text-xs text-muted">
          {plural(s.received.count, 'restock', 'restocks')} · VAT {pesos(s.received.vat)} · net {pesos(s.received.net)}
        </p>
      </div>
      {s.received.count === 0 ? (
        <p className="mt-3 text-sm" data-testid="spend-empty">
          No restock was received in this period.
        </p>
      ) : (
        <div className="mt-3">
          <BarRows bars={bars} testId="spend-rows" />
        </div>
      )}
      <DataTable
        caption="Supplier spend"
        columns={['Supplier', 'Opening balance', 'Received in this period', 'Restocks received']}
        rows={s.suppliers.map((x) => [x.active ? x.name : `${x.name} (inactive)`, pesos(x.openingBalance), pesos(x.receivedTotal), x.receivedCount])}
      />
    </ChartCard>
  );
}

/** The Employees section: no figure, a way in. */
export function EmployeesCard() {
  return (
    <section className="min-w-0 border border-tan bg-cream p-4 sm:p-5" aria-labelledby="card-employees-t" data-testid="card-employees">
      <h2 id="card-employees-t" className="text-2xl">
        Employees
      </h2>
      <p className="mt-1 text-sm text-muted">Add the people who sign in to the dashboards, edit them, change their role, reset a password, or deactivate an account.</p>
      <Link to="/admin/employees" className="mt-1 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" data-testid="card-link">
        Manage employees →
      </Link>
    </section>
  );
}

/** The Customers section: no figure, a way in. */
export function CustomersCard() {
  return (
    <section className="min-w-0 border border-tan bg-cream p-4 sm:p-5" aria-labelledby="card-customers-t" data-testid="card-customers">
      <h2 id="card-customers-t" className="text-2xl">
        Customers
      </h2>
      <p className="mt-1 text-sm text-muted">See the registered shop accounts with what they have ordered, correct a name, email or phone, or deactivate an account.</p>
      <Link to="/admin/customers" className="mt-1 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" data-testid="card-link">
        Manage customers →
      </Link>
    </section>
  );
}

/** The Forecast and DSS section: no figure here (real and simulated figures are never mixed on a summary), a way in. */
export function ForecastCard() {
  return (
    <section className="min-w-0 border border-tan bg-cream p-4 sm:p-5" aria-labelledby="card-forecast-t" data-testid="card-forecast">
      <h2 id="card-forecast-t" className="text-2xl">
        Forecasts and DSS
      </h2>
      <p className="mt-1 text-sm text-muted">See what the decision-support module worked out: the latest real and simulated runs, and ask for a new real run.</p>
      <Link to="/admin/dss" className="mt-1 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" data-testid="card-link">
        Open Forecast and DSS →
      </Link>
    </section>
  );
}
