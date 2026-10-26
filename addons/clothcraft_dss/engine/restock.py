"""Restock recommendations per garment variant (B8 S1). Pure pandas and numpy. Recommendations only: nothing is ordered.

Demand: the product's weekly forecast x the variant's share (forecast.variant_shares), spread evenly over the week's days. Only the days
AFTER the as-of day count, so the current week contributes its remaining days only (remaining_days_in_week). Past the last forecast week the
last week's rate is used (flag extended_beyond_horizon).
Position: free (on hand - reserved, internal locations) + incoming (open incoming moves, and approved / not received restock lines).
Run-out day: the first day whose cumulative demand exceeds the position; days_left = the days before it. The pessimistic run-out uses each
week's upper 80% bound instead of the point forecast.
Lead time per supplier: median and 90th percentile of its receipts when it has at least `min_receipts`, else the simulation's supplierinfo
delay, else `default_lead_days`. L = the 90th percentile, rounded up to whole days.
  safety stock SS   = z x sigma x sqrt((L + R) / 7)     z for the service level; sigma = the product's backtest RMSE at 1-2 weeks x share
  reorder point     = demand over L + SS
  order-up-to S     = demand over L + R + SS            R = the review period (days)
  suggested qty     = ceil(max(0, S - free - incoming)), raised to the supplier's minimum, capped at `cap_weeks` of average forecast demand
  order by          = the day the position falls to SS, minus L; on or before the as-of day -> order_now
  stock-out likely before arrival = an order placed on the as-of day arrives (as-of + L) after the run-out day
  arrives before run-out           = no run-out day within the forecast, or as-of + L is strictly before the run-out day
Supplier choice: eligible suppliers only (shop: active, not permanently off, no unavailable range on the as-of day, a supply line for the
variant's garment type x size x colour, and no unavailable range overlapping the expected arrival [as-of + median, as-of + L]; simulation:
supplierinfo for the template). Ranked (B8 S1b): suppliers that arrive before the run-out day first, then landed unit cost (unit cost + flat
shipping / qty), then L, then name. Every money figure VAT included.
"""
import json
import math
from statistics import NormalDist

import numpy as np
import pandas as pd

from . import transform as T

PARAMS = {'service_level': 0.90, 'review_days': 7, 'cap_weeks': 12, 'default_lead_days': 10, 'min_receipts': 3}
DAY = pd.Timedelta(days=1)


def remaining_days_in_week(as_of):
    """Days after the as-of day up to and including its Sunday (Monday-to-Sunday weeks): Thursday -> 3, Sunday -> 0."""
    return 6 - pd.Timestamp(as_of).day_of_week


def daily_series(weeks, as_of, n_days):
    """weeks: {week Monday: weekly units}. Units per day for the n_days after the as-of day, and whether any day lies past the last week."""
    as_of = pd.Timestamp(as_of).normalize()
    if not weeks:
        return np.zeros(n_days), False
    last = max(weeks)
    out, extended = np.zeros(n_days), False
    for i in range(n_days):
        day = as_of + (i + 1) * DAY
        monday = day - pd.Timedelta(days=day.day_of_week)
        if monday > last:
            monday, extended = last, True
        out[i] = weeks.get(monday, 0.0) / 7.0
    return out, extended


def first_day_over(cum, level):
    """1-based index of the first day whose cumulative demand exceeds `level`, or None."""
    idx = np.flatnonzero(cum > level + 1e-9)
    return int(idx[0]) + 1 if len(idx) else None


def recommend(free, incoming, daily, daily_hi, sigma_week, lead_p90, as_of, params=None, min_qty=0.0):
    """The figures for one variant and one lead time. daily / daily_hi: units per day after the as-of day (long enough for L + R)."""
    p = {**PARAMS, **(params or {})}
    as_of = pd.Timestamp(as_of).normalize()
    pos = float(free) + float(incoming)
    L = int(math.ceil(lead_p90))
    LR = L + int(p['review_days'])
    cum, cum_hi = np.cumsum(daily), np.cumsum(daily_hi)
    z = NormalDist().inv_cdf(p['service_level'])
    ss = z * float(sigma_week) * math.sqrt(LR / 7.0)

    def demand(days):
        return float(cum[min(days, len(cum)) - 1]) if days > 0 else 0.0
    out = {'position': pos, 'lead_days': L, 'safety_stock': ss, 'reorder_point': demand(L) + ss, 'order_up_to': demand(LR) + ss}
    if cum[-1] <= 1e-9:
        return {**out, 'days_left': None, 'runout_date': None, 'runout_date_hi80': None, 'suggested_qty': 0, 'order_by': None, 'order_now': False,
                'stockout_before_arrival': False, 'arrives_before_runout': True, 'capped': False, 'status': 'no_demand'}
    run = first_day_over(cum, pos)
    run_hi = first_day_over(cum_hi, pos)
    weekly_mean = float(np.mean(daily)) * 7.0
    raw = max(0.0, out['order_up_to'] - pos)
    qty = int(math.ceil(raw - 1e-9)) if raw > 0 else 0
    if qty > 0 and min_qty and qty < min_qty:
        qty = int(math.ceil(min_qty))
    cap = int(math.ceil(p['cap_weeks'] * weekly_mean))
    capped = qty > cap
    qty = min(qty, cap)
    # the day the position falls to the safety stock (position - cumulative demand <= SS); day 0 when it already is
    if pos <= ss:
        t_ss = 0
    else:
        idx = np.flatnonzero(cum >= pos - ss - 1e-9)
        t_ss = int(idx[0]) + 1 if len(idx) else None
    order_by = None if t_ss is None else as_of + (t_ss - L) * DAY
    order_now = order_by is not None and order_by <= as_of
    stockout = run is not None and L > run
    status = 'order_now' if (order_now and qty > 0) else ('plan' if order_by is not None else 'ok')
    return {**out, 'days_left': (run - 1) if run is not None else None, 'runout_date': as_of + run * DAY if run is not None else None,
            'runout_date_hi80': as_of + run_hi * DAY if run_hi is not None else None, 'suggested_qty': qty,
            'order_by': max(order_by, as_of) if order_by is not None else None, 'order_now': bool(order_now),
            'stockout_before_arrival': bool(stockout), 'arrives_before_runout': run is None or L < run, 'capped': bool(capped), 'status': status}


def rank_key(option):
    """Suppliers that arrive before the run-out day first, then landed unit cost, then L90, then name."""
    return (not option['rec']['arrives_before_runout'], round(option['landed_unit_cost'], 6), option['lead_p90'], str(option['supplier']))


# ---------------------------------------------------------------------------------------------------------------- inputs
def lead_times(lead_table, delays=None, params=None):
    """{supplier key: (median, p90, source)} from transform.lead_time_table rows (keyed by supplier_id) and fallback delays {key: days}."""
    p = {**PARAMS, **(params or {})}
    out = {}
    for _, r in lead_table.iterrows():
        if r['n'] >= p['min_receipts']:
            out[r['supplier_id']] = (float(r['median']), float(r['p90']), 'history')
    for k, d in (delays or {}).items():
        if k not in out and d and d > 0:
            out[k] = (float(d), float(d), 'supplierinfo_delay')
    return out


def lead_table_by_id(lt):
    """transform.lead_time_table, but keyed by supplier id."""
    if lt.empty:
        return pd.DataFrame(columns=['supplier_id', 'n', 'median', 'p90'])
    g = lt.groupby('supplier_id')['days']
    return pd.DataFrame({'n': g.size(), 'median': g.median(), 'p90': g.quantile(0.9)}).reset_index()


def incoming_units(moves, restocks, restock_lines):
    """Per variant: units still expected (open incoming moves + lines of approved or not-received restocks)."""
    parts = [T.open_receipts(moves)[['product_id', 'qty']]] if len(moves) else []
    if len(restocks) and len(restock_lines):
        open_ids = restocks.loc[restocks['state'].isin(['approved', 'not_received']), 'restock_id']
        rl = restock_lines[restock_lines['restock_id'].isin(open_ids)]
        parts.append(rl.rename(columns={'quantity': 'qty'})[['product_id', 'qty']])
    if not parts:
        return pd.Series(dtype=float)
    return pd.concat(parts, ignore_index=True).groupby('product_id')['qty'].sum()


def sigma_by_product(final_rows):
    """Backtest RMSE at horizons 1-2 per product, from forecast.backtest()['final'] (evaluation origins, chosen configuration)."""
    f = final_rows[(final_rows['level'] == 'product') & final_rows['eval'].astype(bool) & final_rows['h'].isin([1, 2])]
    return f.assign(se=(f['y'] - f['yhat']) ** 2).groupby('key')['se'].mean().pow(0.5)


def candidates(variants, suppliers, supplier_lines, unavailability, supplier_info, as_of):
    """Per variant, the suppliers that could supply it, with unit cost (VAT included), shipping, minimum, availability and unavailable
    ranges. Shop suppliers when clothcraft_supplier has rows, else the simulation's supplierinfo (per template, price x 1.12)."""
    as_of = pd.Timestamp(as_of).normalize()
    if len(suppliers):
        un = unavailability.assign(date_from=pd.to_datetime(unavailability['date_from']), date_to=pd.to_datetime(unavailability['date_to']))
        ranges = {k: list(zip(g['date_from'], g['date_to'])) for k, g in un.groupby('supplier_id')}
        c = variants.merge(supplier_lines, on=['garment_type_id', 'size_value_id', 'color_value_id']).merge(suppliers, on='supplier_id')
        c = c.assign(source='clothcraft_supplier', supplier=c['name'], min_qty=0.0,
                     shipping=np.where(c['ships'].astype(bool), c['shipping_fee'].fillna(0.0), 0.0))
        c['ranges'] = c['supplier_id'].map(lambda k: ranges.get(k, []))
        c['available_now'] = [bool(a) and not bool(off) and not any(f <= as_of <= t for f, t in r)
                              for a, off, r in zip(c['active'], c['permanently_off'], c['ranges'])]
        return c[['product_id', 'supplier_id', 'supplier', 'unit_cost', 'shipping', 'min_qty', 'available_now', 'ranges', 'source']]
    from .health import SIM_PRICE_VAT
    c = variants.merge(supplier_info[['template_id', 'supplier_id', 'supplier', 'price', 'min_qty']], on='template_id')
    c = c.assign(unit_cost=c['price'] * SIM_PRICE_VAT, shipping=0.0, available_now=True, source='supplierinfo')
    c['ranges'] = [[] for _ in range(len(c))]
    return c[['product_id', 'supplier_id', 'supplier', 'unit_cost', 'shipping', 'min_qty', 'available_now', 'ranges', 'source']]


# ---------------------------------------------------------------------------------------------------------------- the table
def build(catalogue, variant_attrs, quants, incoming, shares, forecast, sigma, cands, leads, as_of, params=None):
    """One row per garment variant whose product has a forecast."""
    p = {**PARAMS, **(params or {})}
    as_of = pd.Timestamp(as_of).normalize()
    v = catalogue[catalogue['garment'].astype(bool)].merge(variant_attrs, on='product_id', how='left')
    v = v.merge(quants, on='product_id', how='left').fillna({'on_hand': 0.0, 'reserved': 0.0})
    v = v.merge(shares[['product_id', 'share']], on='product_id', how='left')
    fc = forecast[forecast['level'] == 'product']
    weeks = {int(t): dict(zip(pd.to_datetime(g['week_start']), g['yhat'])) for t, g in fc.groupby('key')}
    weeks_hi = {int(t): dict(zip(pd.to_datetime(g['week_start']), g['hi80'].fillna(g['yhat']))) for t, g in fc.groupby('key')}
    horizon_days = (max(pd.to_datetime(fc['week_start'])) + pd.Timedelta(days=6) - as_of).days if len(fc) else 0
    max_lead = max([l90 for _, l90, _ in leads.values()] + [p['default_lead_days']])
    n_days = max(horizon_days, int(math.ceil(max_lead)) + int(p['review_days']), 1)
    rows = []
    for _, r in v.iterrows():
        tid = int(r['template_id'])
        base = {'product_id': int(r['product_id']), 'template_id': tid, 'sku': r['sku'], 'product': r['template_name'],
                'garment_type': r['garment_type_code'], 'size': r.get('size'), 'color': r.get('color'), 'on_hand': float(r['on_hand']),
                'reserved': float(r['reserved']), 'free': float(r['on_hand'] - r['reserved']), 'incoming': float(incoming.get(r['product_id'], 0.0)),
                'share': float(r['share']) if pd.notna(r['share']) else None}
        if tid not in weeks or pd.isna(r['share']):
            rows.append({**base, 'status': 'no_forecast', 'flags': 'no_forecast'})
            continue
        share = float(r['share'])
        daily, ext = daily_series({k: x * share for k, x in weeks[tid].items()}, as_of, n_days)
        daily_hi, _ = daily_series({k: x * share for k, x in weeks_hi[tid].items()}, as_of, n_days)
        s = sigma.get(tid)
        sig = float(s) * share if s is not None and pd.notna(s) else 0.0
        opts = []
        for _, c in cands[cands['product_id'] == r['product_id']].iterrows():
            l50, l90, src = leads.get(c['supplier_id'], (float(p['default_lead_days']), float(p['default_lead_days']), 'default'))
            rec = recommend(base['free'], base['incoming'], daily, daily_hi, sig, l90, as_of, p, c['min_qty'])
            arrive_from, arrive_to = as_of + int(math.ceil(l50)) * DAY, as_of + rec['lead_days'] * DAY
            reasons = []
            if not c['available_now']:
                reasons.append('unavailable_now')
            if any(f <= arrive_to and t >= arrive_from for f, t in c['ranges']):
                reasons.append('unavailable_during_arrival')
            q = max(rec['suggested_qty'], 1)
            opts.append({'supplier_id': c['supplier_id'], 'supplier': c['supplier'], 'unit_cost': float(c['unit_cost']),
                         'landed_unit_cost': float(c['unit_cost']) + float(c['shipping']) / q, 'lead_p50': float(l50), 'lead_p90': float(l90),
                         'lead_source': src, 'coverage_risk': rec['stockout_before_arrival'], 'ineligible': reasons, 'rec': rec})
        ok = sorted([o for o in opts if not o['ineligible']], key=rank_key)
        flags = ['extended_beyond_horizon'] if ext else []
        if s is None or pd.isna(s):
            flags.append('no_backtest_sigma')
        if ok:
            best = ok[0]
            rec, sup = best['rec'], best
        else:
            flags.append('no_eligible_supplier')
            rec = recommend(base['free'], base['incoming'], daily, daily_hi, sig, p['default_lead_days'], as_of, p)
            sup = {'supplier_id': None, 'supplier': None, 'unit_cost': None, 'landed_unit_cost': None, 'lead_p50': float(p['default_lead_days']),
                   'lead_p90': float(p['default_lead_days']), 'lead_source': 'default', 'coverage_risk': rec['stockout_before_arrival']}
        if rec['capped']:
            flags.append('capped')
        alts = [{'supplier_id': o['supplier_id'], 'supplier': o['supplier'], 'landed_unit_cost': round(o['landed_unit_cost'], 2),
                 'lead_p90': o['lead_p90'], 'coverage_risk': o['coverage_risk'], 'arrives_before_runout': o['rec']['arrives_before_runout'],
                 'ineligible': o['ineligible']}
                for o in sorted(opts, key=lambda o: (bool(o['ineligible']), *rank_key(o))) if o is not (ok[0] if ok else None)]
        rows.append({**base, 'daily_demand': round(float(np.mean(daily)), 4), 'days_left': rec['days_left'], 'runout_date': rec['runout_date'],
                     'runout_date_hi80': rec['runout_date_hi80'], 'supplier_id': sup['supplier_id'], 'supplier': sup['supplier'],
                     'lead_p50': sup['lead_p50'], 'lead_p90': sup['lead_p90'], 'lead_source': sup['lead_source'], 'lead_days': rec['lead_days'],
                     'safety_stock': round(rec['safety_stock'], 2), 'reorder_point': round(rec['reorder_point'], 2),
                     'order_up_to': round(rec['order_up_to'], 2), 'suggested_qty': rec['suggested_qty'], 'order_by': rec['order_by'],
                     'order_now': rec['order_now'], 'stockout_before_arrival': rec['stockout_before_arrival'],
                     'arrives_before_runout': rec['arrives_before_runout'], 'coverage_risk': sup['coverage_risk'], 'unit_cost': sup['unit_cost'],
                     'landed_unit_cost': round(sup['landed_unit_cost'], 2) if sup['landed_unit_cost'] is not None else None,
                     'est_cost': round(rec['suggested_qty'] * sup['landed_unit_cost'], 2) if sup['landed_unit_cost'] is not None else None,
                     'alternatives': json.dumps(alts, default=str), 'status': rec['status'], 'flags': ','.join(flags)})
    return pd.DataFrame(rows)
