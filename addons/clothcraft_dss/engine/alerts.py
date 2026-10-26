"""Alerts (B8 S1), computed per run and shown in the DSS section only (no notifications). Pure pandas.

1. unpaid_bank_transfer: a confirmed order with a pending bank-transfer (wire_transfer) payment and nothing shipped (no done outgoing picking).
   Age from the order date to the end of the as-of day: 3 days or more follow_up, 7 or more stuck, 14 or more admin_decide; younger is no alert.
2. forecast_stockout: a variant whose run-out day falls within L + R days (restock.build); critical when even an order placed on the as-of
   day would arrive after it (stockout_before_arrival), else warning.
3. low_stock_risk: a variant the shop's own low-stock levels mark low (clothcraft.stock.alert) that also has a forecast run-out day.
4. restock_supplier (shop only): an open restock (approved or not received) whose supplier is inactive, permanently off, or unavailable on
   the as-of day, or has an unavailable range overlapping the expected arrival; restock_overdue: an open restock past its expected range
   (the shop's own overdue rule). On data without these tables the kind says not_available_on_this_data.
"""
import pandas as pd

from . import transform as T

BANDS = ((14, 'admin_decide', 'critical'), (7, 'stuck', 'warning'), (3, 'follow_up', 'info'))
COLUMNS = ['kind', 'band', 'severity', 'subject_type', 'subject_id', 'subject_label', 'age_days', 'message']


def band_of(age_days):
    """(band, severity) for an unpaid transfer of this age in days, or (None, None) under 3 days."""
    for low, band, severity in BANDS:
        if age_days >= low:
            return band, severity
    return None, None


def unpaid_bank_transfers(orders, txs, pickings, as_of_end):
    t = T.pending_bank_transfers(orders, txs, as_of_end)
    shipped = set(pickings.loc[pickings['state'] == 'done', 'order_id'].dropna().astype(int))
    t = t[~t['order_id'].astype(int).isin(shipped)].drop_duplicates('order_id')
    rows = []
    for _, r in t.sort_values('age_order_days', ascending=False).iterrows():
        band, sev = band_of(r['age_order_days'])
        if band:
            rows.append({'kind': 'unpaid_bank_transfer', 'band': band, 'severity': sev, 'subject_type': 'order', 'subject_id': int(r['order_id']),
                         'subject_label': f"Order {int(r['order_id'])}", 'age_days': round(float(r['age_order_days']), 1),
                         'message': f"Bank transfer still unpaid {int(r['age_order_days'])} full days after the order; nothing shipped."})
    return rows


def stockouts(restock, params):
    rows = []
    if restock is None or not len(restock) or 'runout_date' not in restock:
        return rows
    r = restock[restock['days_left'].notna()]
    for _, x in r.iterrows():
        window = int(x['lead_days']) + int(params['review_days'])
        if x['days_left'] + 1 <= window:
            crit = bool(x['stockout_before_arrival'])
            rows.append({'kind': 'forecast_stockout', 'band': 'before_arrival' if crit else 'within_lead_and_review', 'severity': 'critical' if crit else 'warning',
                         'subject_type': 'variant', 'subject_id': int(x['product_id']), 'subject_label': x['sku'], 'age_days': None,
                         'message': f"Forecast to run out on {pd.Timestamp(x['runout_date']).date()} ({int(x['days_left'])} days left); "
                                    f"lead time {int(x['lead_days'])} days" + (", an order today arrives too late." if crit else ".")})
    return rows


def low_stock_risk(stock_alerts, restock):
    rows = []
    if not len(stock_alerts) or restock is None or not len(restock) or 'days_left' not in restock:
        return rows
    low = set(stock_alerts.loc[stock_alerts['low'].astype(bool), 'product_id'].astype(int))
    for _, x in restock[restock['product_id'].isin(low) & restock['days_left'].notna()].iterrows():
        rows.append({'kind': 'low_stock_risk', 'band': 'low_and_running_out', 'severity': 'warning', 'subject_type': 'variant',
                     'subject_id': int(x['product_id']), 'subject_label': x['sku'], 'age_days': None,
                     'message': f"Below its low-stock level and forecast to run out on {pd.Timestamp(x['runout_date']).date()}."})
    return rows


def restock_issues(restocks, suppliers, unavailability, as_of):
    rows = []
    as_of = pd.Timestamp(as_of).normalize()
    open_ = restocks[restocks['state'].isin(['approved', 'not_received'])]
    sup = suppliers.set_index('supplier_id') if len(suppliers) else None
    un = unavailability.assign(date_from=pd.to_datetime(unavailability['date_from']), date_to=pd.to_datetime(unavailability['date_to']))
    for _, r in open_.iterrows():
        label = r['name'] or f"Restock {int(r['restock_id'])}"
        exp_from, exp_to = pd.Timestamp(r['expected_from']), pd.Timestamp(r['expected_to'])
        reasons = []
        if sup is not None and r['supplier_id'] in sup.index:
            s = sup.loc[r['supplier_id']]
            if not bool(s['active']):
                reasons.append('supplier inactive')
            if bool(s['permanently_off']):
                reasons.append('supplier permanently off')
        mine = un[un['supplier_id'] == r['supplier_id']]
        if ((mine['date_from'] <= as_of) & (mine['date_to'] >= as_of)).any():
            reasons.append('supplier unavailable today')
        if ((mine['date_from'] <= exp_to) & (mine['date_to'] >= exp_from)).any():
            reasons.append('supplier unavailable during the expected arrival')
        if reasons:
            rows.append({'kind': 'restock_supplier', 'band': 'supplier_issue', 'severity': 'warning', 'subject_type': 'restock',
                         'subject_id': int(r['restock_id']), 'subject_label': label, 'age_days': None, 'message': '; '.join(reasons).capitalize() + '.'})
        if as_of > exp_to:
            rows.append({'kind': 'restock_overdue', 'band': 'overdue', 'severity': 'warning', 'subject_type': 'restock', 'subject_id': int(r['restock_id']),
                         'subject_label': label, 'age_days': float((as_of - exp_to).days),
                         'message': f"Expected by {exp_to.date()}, not received {(as_of - exp_to).days} days later."})
    return rows


def build(orders, txs, pickings, as_of, as_of_end, restock, stock_alerts, restocks, suppliers, unavailability, has_restock_tables, params):
    """(alerts frame, availability per kind)."""
    rows = unpaid_bank_transfers(orders, txs, pickings, as_of_end) + stockouts(restock, params)
    available = {'unpaid_bank_transfer': 'available', 'forecast_stockout': 'available' if restock is not None and len(restock) else 'no_forecast'}
    if has_restock_tables:
        rows += low_stock_risk(stock_alerts, restock) + restock_issues(restocks, suppliers, unavailability, as_of)
        available.update(low_stock_risk='available', restock_supplier='available', restock_overdue='available')
    else:
        available.update(low_stock_risk='not_available_on_this_data', restock_supplier='not_available_on_this_data',
                         restock_overdue='not_available_on_this_data')
    return pd.DataFrame(rows, columns=COLUMNS), available
