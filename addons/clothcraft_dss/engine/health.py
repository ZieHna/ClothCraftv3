"""Business health (B8 S1) and the Closed money rule. Pure pandas. A demonstration: on simulated data the figures show the method only.

Money is VAT included everywhere (order totals, restock actual cost, supply-line unit cost, purchase order line price_total).

The Closed rule (open point 1, approved): money (RFM monetary, earned revenue) counts only "Closed" orders.
  - closed_state, where sale_order.clothcraft_state exists (the shop): confirmed orders whose clothcraft_state is 'closed', dated by their
    latest 'closed' history line, else their latest 'delivered' line, else the day they were placed (the admin dashboard's rule).
  - delivered_and_paid, where it does not (the simulation): confirmed orders with every outgoing picking done (at least one) and a done payment,
    dated by their last done delivery. This is the only place the DSS reads clothcraft_state, and only for money; demand never does.
Every run states which rule it used.

Monthly series (whole Manila months; the as-of month is partial and flagged): earned revenue, spending (received restocks by the month
received; purchase order receipts at their line's VAT-included cost by the month received), cost of goods sold (the garment units of the
orders that count as revenue under the run's Closed rule x the variant's last purchase cost, in the same month as their revenue: B8 S1c),
cash view (revenue - spending) and margin view (revenue - cost of goods sold). The supplier opening balance is a starting investment on its
own line, never spending and not a loss. Months before the first order are kept and flagged before_first_sale.
Stock value = on hand x last purchase cost (never standard_price). There is no cash balance or balance sheet in Odoo, so there is no
bankruptcy or runway figure.
"""
import numpy as np
import pandas as pd

from . import transform as T

RULE_CLOSED_STATE = 'closed_state'
RULE_DELIVERED_PAID = 'delivered_and_paid'
RULE_TEXT = {
    RULE_CLOSED_STATE: 'Closed = orders in the Closed state (customer confirmed, or closed automatically), dated when they closed.',
    RULE_DELIVERED_PAID: 'Closed = delivered and paid orders (no Closed state in this database), dated by their last delivery.',
}
TREND = {'months': 6, 'threshold': 0.02, 'negative_months': 3}
WARNING_LABEL = 'warning'


def manila_month(ts):
    return (pd.to_datetime(ts) + T.MANILA).dt.strftime('%Y-%m')


def month_range(first, last):
    return [p.strftime('%Y-%m') for p in pd.period_range(pd.Period(first, 'M'), pd.Period(last, 'M'), freq='M')]


def month_complete(month, as_of):
    """A month is complete when the as-of day is its last day or later."""
    return pd.Period(month, 'M').end_time.normalize() <= pd.Timestamp(as_of).normalize()


# ---------------------------------------------------------------------------------------------------------------- the Closed rule
def _lookup(keys, moments):
    """keys (order ids) mapped through moments (a datetime series by order id), NaT where absent. pandas cannot map through an EMPTY
    datetime series (TypeError), which happens when a kind of history line is entirely absent (B8 S2b)."""
    if moments.empty:
        dtype = moments.dtype if pd.api.types.is_datetime64_any_dtype(moments.dtype) else 'datetime64[ns]'
        return pd.Series(pd.NaT, index=keys.index, dtype=dtype)
    return keys.map(moments)


def earned_orders(orders, pickings, txs, order_states, audit, has_state, as_of_end):
    """(frame, rule). One row per Closed order: order_id, partner_id, amount (VAT included), moment (naive UTC, before as_of_end).
    With no candidate order the empty frame is returned at once (pandas cannot map an empty series through an empty datetime one)."""
    empty = pd.DataFrame(columns=['order_id', 'partner_id', 'amount', 'moment'])
    conf = orders[orders['state'].isin(T.CONFIRMED)]
    if has_state:
        st = conf.merge(order_states, on='order_id', how='inner')
        st = st[st['clothcraft_state'] == 'closed']
        if st.empty:
            return empty, RULE_CLOSED_STATE
        a = audit.assign(create_date=pd.to_datetime(audit['create_date']))
        closed = a[a['to_state'] == 'closed'].groupby('order_id')['create_date'].max()
        delivered = a[a['to_state'] == 'delivered'].groupby('order_id')['create_date'].max()
        moment = _lookup(st['order_id'], closed).fillna(_lookup(st['order_id'], delivered)).fillna(pd.to_datetime(st['date_order']))
        out, rule = st.assign(moment=pd.to_datetime(moment)), RULE_CLOSED_STATE
    else:
        dp = T.delivered_and_paid(orders, pickings, txs)
        q = dp[dp['qualifies']]
        if q.empty:
            return empty, RULE_DELIVERED_PAID
        done = pickings[pickings['state'] == 'done'].assign(date_done=lambda x: pd.to_datetime(x['date_done']))
        last_done = done.groupby('order_id')['date_done'].max()
        out, rule = q.assign(moment=pd.to_datetime(_lookup(q['order_id'], last_done))), RULE_DELIVERED_PAID
    out = out[out['moment'] < pd.Timestamp(as_of_end)]
    return out[['order_id', 'partner_id', 'amount_total', 'moment']].rename(columns={'amount_total': 'amount'}).reset_index(drop=True), rule


# ---------------------------------------------------------------------------------------------------------------- costs
SIM_PRICE_VAT = 1.12    # the simulation's supplierinfo prices exclude VAT; its purchase order lines carry 12% (checked on clothcraft_sim2)


def last_costs(catalogue, moves, po_lines, restocks, restock_lines, supplier_lines, supplier_info, variant_attrs):
    """Per garment variant: its last purchase cost (VAT included) and where it came from.
    1. the latest received unit cost: a done purchase-order receipt (line price_total / qty) or a received restock line (unit_cost);
    2. else the cheapest matching shop supply line (garment type x size x colour);
    3. else the cheapest simulation supplierinfo price for its template, x 1.12 VAT;
    4. else none (the variant is left out of stock value and cost of goods sold, and counted)."""
    garments = catalogue[catalogue['garment'].astype(bool)][['product_id', 'template_id', 'garment_type_id']]
    got = []
    if len(po_lines) and len(moves):
        rec = moves[(moves['state'] == 'done') & moves['purchase_line_id'].notna() & (moves['dest_usage'] == 'internal')]
        rec = rec.merge(po_lines[['po_line_id', 'unit_cost']], left_on='purchase_line_id', right_on='po_line_id')
        got.append(rec.assign(at=pd.to_datetime(rec['date']))[['product_id', 'at', 'unit_cost']])
    if len(restock_lines) and len(restocks):
        rl = restock_lines[restock_lines['quantity_received'].fillna(0) > 0].merge(
            restocks[restocks['state'] == 'received'][['restock_id', 'received_at']], on='restock_id')
        got.append(rl.assign(at=pd.to_datetime(rl['received_at']))[['product_id', 'at', 'unit_cost']])
    out = garments.copy()
    out['last_cost'], out['cost_source'] = np.nan, None
    if got:
        allg = pd.concat(got, ignore_index=True).dropna(subset=['unit_cost']).sort_values(['product_id', 'at'], kind='mergesort')
        latest = allg.groupby('product_id')['unit_cost'].last()
        hit = out['product_id'].isin(latest.index)
        out.loc[hit, 'last_cost'] = out.loc[hit, 'product_id'].map(latest).astype(float)
        out.loc[hit, 'cost_source'] = 'last_receipt'
    if len(supplier_lines):
        va = out.merge(variant_attrs[['product_id', 'size_value_id', 'color_value_id']], on='product_id', how='left')
        m = va.merge(supplier_lines, on=['garment_type_id', 'size_value_id', 'color_value_id']).groupby('product_id')['unit_cost'].min()
        need = out['last_cost'].isna() & out['product_id'].isin(m.index)
        out.loc[need, 'last_cost'] = out.loc[need, 'product_id'].map(m).astype(float)
        out.loc[need, 'cost_source'] = 'supply_line'
    if len(supplier_info):
        m = supplier_info.groupby('template_id')['price'].min() * SIM_PRICE_VAT
        need = out['last_cost'].isna() & out['template_id'].isin(m.index)
        out.loc[need, 'last_cost'] = out.loc[need, 'template_id'].map(m).astype(float)
        out.loc[need, 'cost_source'] = 'supplierinfo_price_plus_vat'
    return out[['product_id', 'last_cost', 'cost_source']]


# ---------------------------------------------------------------------------------------------------------------- monthly series
def spending_rows(moves, po_lines, restocks):
    """(month, amount, source): received restocks by the Manila month received (received_on is already a Manila day), and purchase order
    receipts (done incoming moves of a PO line x that line's VAT-included unit cost) by the Manila month of the move."""
    parts = []
    if len(restocks):
        r = restocks[(restocks['state'] == 'received') & restocks['received_on'].notna()]
        parts.append(pd.DataFrame({'month': pd.to_datetime(r['received_on']).dt.strftime('%Y-%m'), 'amount': r['actual_cost'].fillna(0.0).astype(float),
                                   'source': 'restock'}))
    if len(po_lines) and len(moves):
        rec = moves[(moves['state'] == 'done') & moves['purchase_line_id'].notna() & (moves['dest_usage'] == 'internal')
                    & (moves['src_usage'] != 'internal')]
        rec = rec.merge(po_lines[['po_line_id', 'unit_cost']], left_on='purchase_line_id', right_on='po_line_id')
        parts.append(pd.DataFrame({'month': manila_month(rec['date']), 'amount': rec['quantity'] * rec['unit_cost'], 'source': 'purchase_order'}))
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=['month', 'amount', 'source'])


def closed_units(earned, demand):
    """The garment units of the orders that count as revenue (health.earned_orders), in the Manila month of their revenue. demand is
    transform.demand_lines (confirmed orders, garments only: the Customization fee and delivery are not units)."""
    month = earned.assign(month=manila_month(earned['moment'])).set_index('order_id')['month']
    d = demand[demand['order_id'].isin(month.index)]
    return pd.DataFrame({'month': d['order_id'].map(month).to_numpy(), 'product_id': d['product_id'].to_numpy(), 'quantity': d['qty'].to_numpy()},
                        columns=['month', 'product_id', 'quantity'])


def monthly(earned, spending, units, costs, as_of, first_order_month):
    """One row per Manila month from the first month with any money or Closed units to the as-of month. units: closed_units()."""
    rev = earned.assign(month=manila_month(earned['moment'])).groupby('month').agg(revenue=('amount', 'sum'), closed_orders=('order_id', 'count'))
    spend = spending.groupby('month')['amount'].sum().rename('spending')
    d = units.merge(costs, on='product_id', how='left')
    cogs = d.assign(c=d['quantity'] * d['last_cost']).groupby('month').agg(cogs=('c', 'sum'), closed_units=('quantity', 'sum'),
                                                                            units_without_cost=('last_cost', lambda s: int(s.isna().sum())))
    months = sorted(set(rev.index) | set(spend.index) | set(cogs.index) | {pd.Timestamp(as_of).strftime('%Y-%m')})
    months = month_range(months[0], pd.Timestamp(as_of).strftime('%Y-%m'))
    m = pd.DataFrame({'month': months}).set_index('month').join(rev).join(spend).join(cogs).infer_objects().fillna(0.0).reset_index()
    m['closed_orders'] = m['closed_orders'].astype(int)
    m['units_without_cost'] = m['units_without_cost'].astype(int)
    m['complete'] = [month_complete(x, as_of) for x in m['month']]
    m['net_cash'] = m['revenue'] - m['spending']
    m['net_margin'] = m['revenue'] - m['cogs']
    c = m['complete']
    for col, src in (('revenue_ma3', 'revenue'), ('net_cash_ma3', 'net_cash'), ('net_margin_ma3', 'net_margin')):
        m[col] = np.nan
        m.loc[c, col] = m.loc[c, src].rolling(3, min_periods=3).mean()
    m['flags'] = [','.join(f for f, on in (('before_first_sale', first_order_month is not None and x < first_order_month), ('partial', not ok)) if on)
                  for x, ok in zip(m['month'], m['complete'])]
    return m


# ---------------------------------------------------------------------------------------------------------------- trend and KPIs
def trend(m, params=None):
    """The trend label from the last `months` complete months of the 3-month average revenue: the least-squares slope divided by those
    months' mean; >= +threshold growing, <= -threshold declining, else stable. warning = the last `negative_months` complete months all had a
    negative cash view. Needs `months` complete 3-month averages (so months + 2 complete months), else not_enough_history."""
    p = {**TREND, **(params or {})}
    c = m[m['complete']]
    warning = bool(len(c) >= p['negative_months'] and (c['net_cash'].iloc[-p['negative_months']:] < 0).all())
    ma = c['revenue_ma3'].dropna()
    base = {'warning': warning, 'months_used': p['months'], 'threshold': p['threshold'], 'complete_months': int(len(c))}
    if len(ma) < p['months']:
        return {**base, 'label': 'not_enough_history', 'needed_complete_months': p['months'] + 2, 'revenue_slope': None, 'revenue_rel_slope': None,
                'cash_slope': None}
    x = np.arange(p['months'], dtype=float)
    last = ma.iloc[-p['months']:].to_numpy(dtype=float)
    slope = float(np.polyfit(x, last, 1)[0])
    mean = float(last.mean())
    rel = slope / mean if mean > 0 else float('nan')
    label = 'growing' if rel >= p['threshold'] else 'declining' if rel <= -p['threshold'] else 'stable'
    cash = c['net_cash_ma3'].dropna()
    cash_slope = float(np.polyfit(np.arange(min(len(cash), p['months']), dtype=float), cash.iloc[-p['months']:].to_numpy(dtype=float), 1)[0]) \
        if len(cash) >= 2 else None
    return {**base, 'label': label, 'revenue_slope': round(slope, 2), 'revenue_rel_slope': round(rel, 4), 'revenue_ma3_mean': round(mean, 2),
            'cash_slope': round(cash_slope, 2) if cash_slope is not None else None, 'ma3_values': [round(v, 2) for v in last]}


def kpis(m, costs, quants, opening_balance, as_of):
    c = m[m['complete']]
    out = {'opening_balance': round(float(opening_balance), 2), 'opening_balance_note': 'starting investment: never spending, never a monthly cost'}
    last = c.iloc[-1] if len(c) else None

    def growth(now, before):
        return round(100.0 * (now - before) / before, 1) if before and before > 0 else None
    if last is not None:
        year_ago = (pd.Period(last['month'], 'M') - 12).strftime('%Y-%m')
        prev = m[m['month'] == year_ago]
        out['yoy_month'] = {'month': last['month'], 'vs': year_ago, 'growth_pct': growth(last['revenue'], float(prev['revenue'].iloc[0])) if len(prev) else None}
        last3 = c.iloc[-3:]
        before3 = m[m['month'].isin([(pd.Period(x, 'M') - 12).strftime('%Y-%m') for x in last3['month']])]
        out['yoy_3_months'] = {'months': list(last3['month']), 'growth_pct': growth(last3['revenue'].sum(), before3['revenue'].sum()) if len(before3) == 3 else None}
    q = quants.merge(costs, on='product_id', how='inner')
    with_cost = q[q['last_cost'].notna()]
    stock_value = float((with_cost['on_hand'] * with_cost['last_cost']).sum())
    out['stock_value'] = round(stock_value, 2)
    out['stock_units_without_cost'] = float(q.loc[q['last_cost'].isna(), 'on_hand'].sum())
    cogs3 = c['cogs'].iloc[-3:].mean() if len(c) else 0.0
    out['stock_cover_months'] = round(stock_value / cogs3, 2) if cogs3 and cogs3 > 0 else None
    out['cumulative_revenue'] = round(float(m['revenue'].sum()), 2)
    out['cumulative_spending'] = round(float(m['spending'].sum()), 2)
    out['net_position'] = round(float(m['revenue'].sum() - m['spending'].sum() - opening_balance), 2)
    out['net_position_note'] = ('cumulative Closed revenue - cumulative spending - opening balance (through the as-of day). The opening balance '
                                'is a starting investment, not a loss.')
    out['net_position_label'] = 'Net position after the starting investment (starting investment, not a loss)'
    return out


# ---------------------------------------------------------------------------------------------------------------- projection
PROJECTION_NOTE = 'Only months fully inside the forecast horizon are projected; the others are not covered.'
SIMULATED_NOTE = 'Simulated data demonstrates the method only.'


def projection(forecast, as_of, revenue_per_unit, restock_value, months=3, simulated=False):
    """Revenue for the as-of month's remaining days and the next months, from the total forecast (units per week spread evenly over its
    days, days after the as-of day only) x revenue per unit. Only a month whose days (after the as-of day) all lie inside the forecast horizon
    gets figures (status projected); a month only partly covered, or not at all, is status not_covered with no figures (B8 S1b). The 80% band
    adds the weekly bounds (conservative). Spending = the suggested restock value (the orders recommended now), not a monthly figure."""
    tot = forecast[forecast['level'] == 'total'] if len(forecast) else forecast
    as_of = pd.Timestamp(as_of).normalize()
    rows = []
    for _, r in tot.iterrows():
        start = pd.Timestamp(r['week_start'])
        for i in range(7):
            day = start + pd.Timedelta(days=i)
            if day > as_of:
                rows.append({'day': day, 'units': r['yhat'] / 7, 'lo': (r['lo80'] if pd.notna(r['lo80']) else r['yhat']) / 7,
                             'hi': (r['hi80'] if pd.notna(r['hi80']) else r['yhat']) / 7})
    days = pd.DataFrame(rows, columns=['day', 'units', 'lo', 'hi'])
    first = pd.Period(as_of, 'M')
    out = []
    for k in range(months):
        p = first + k
        start = max(p.start_time.normalize(), as_of + pd.Timedelta(days=1))
        span = (p.end_time.normalize() - start).days + 1
        d = days[(days['day'] >= start) & (days['day'] <= p.end_time.normalize())] if len(days) else days
        covered = int(len(d))
        row = {'month': p.strftime('%Y-%m'), 'days': span, 'days_covered': covered}
        if covered < span or not revenue_per_unit:
            out.append({**row, 'status': 'not_covered', 'units': None, 'revenue': None, 'revenue_lo80': None, 'revenue_hi80': None})
            continue
        rpu = revenue_per_unit
        out.append({**row, 'status': 'projected', 'units': round(float(d['units'].sum()), 1), 'revenue': round(float(d['units'].sum()) * rpu, 2),
                    'revenue_lo80': round(float(d['lo'].sum()) * rpu, 2), 'revenue_hi80': round(float(d['hi'].sum()) * rpu, 2)})
    return {'months': out, 'revenue_per_unit': round(revenue_per_unit, 2) if revenue_per_unit else None,
            'spending_restock_now': round(float(restock_value), 2),
            'note': f'{PROJECTION_NOTE} {SIMULATED_NOTE}' if simulated else PROJECTION_NOTE}


def revenue_per_unit(earned, demand, m):
    """Closed revenue of the last 3 complete months / garment units on those orders (Customization fee and delivery are not units)."""
    c = m[m['complete']]['month'].iloc[-3:]
    e = earned.assign(month=manila_month(earned['moment']))
    e = e[e['month'].isin(c)]
    units = demand[demand['order_id'].isin(e['order_id'])]['qty'].sum()
    return float(e['amount'].sum() / units) if units > 0 else None
