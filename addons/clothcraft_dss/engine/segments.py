"""Customer segments by RFM (B8 S1). Pure pandas, deterministic.

Only Closed orders count (health.earned_orders: the run's Closed rule). Per customer with at least one Closed order:
  R = whole days from the last Closed order to the end of the as-of day; F = lifetime number of Closed orders; M = their total, VAT included.
Scores 1-5: R and M by quintile of rank (ties broken by customer id, so the same data always scores the same; a more recent order and a
larger total score higher); F by fixed bands 1 / 2 / 3-4 / 5-8 / 9+ (quintiles would break on the many one-order customers).
Segments are the first rule that matches, in SEGMENTS order. A customer with one order (F = 1) can only be New or One-time, lapsed.
Customers with confirmed orders but no Closed order are not scored; they are counted as no_completed_order. With fewer than
`min_customers` scored customers there is no segment table at all (status not_enough_customers).
"""
import numpy as np
import pandas as pd

MIN_CUSTOMERS = 20
F_BANDS = ((1, 1, 1), (2, 2, 2), (3, 4, 3), (5, 8, 4), (9, None, 5))
SEGMENTS = (
    ('champions', 'Champions', lambda r, f: r >= 4 and f >= 4),
    ('loyal', 'Loyal', lambda r, f: f >= 4 and r >= 3),
    ('potential_loyalists', 'Potential loyalists', lambda r, f: r >= 4 and 2 <= f <= 3),
    ('new', 'New', lambda r, f: r >= 4 and f == 1),
    ('at_risk', 'At risk', lambda r, f: r <= 2 and f >= 3),
    ('one_time_lapsed', 'One-time, lapsed', lambda r, f: f == 1 and r <= 3),
    ('hibernating', 'Hibernating', lambda r, f: r <= 2 and f <= 2),
    ('needs_attention', 'Needs attention', lambda r, f: True),
)
NAMES = {code: name for code, name, _ in SEGMENTS}


def f_score(n):
    for lo, hi, s in F_BANDS:
        if n >= lo and (hi is None or n <= hi):
            return s
    return 1


def quintile(values, ascending):
    """Scores 1-5 by quintile of rank; `ascending` True means larger values score higher."""
    rank = values.rank(method='first', ascending=ascending)
    return pd.qcut(rank, 5, labels=[1, 2, 3, 4, 5]).astype(int)


def segment_of(r, f):
    for code, _, rule in SEGMENTS:
        if rule(r, f):
            return code
    return 'needs_attention'


def score(earned, confirmed_partners, as_of_end, min_customers=MIN_CUSTOMERS):
    """(status dict, customers frame). earned: health.earned_orders rows; confirmed_partners: partner ids with any confirmed order."""
    end = pd.Timestamp(as_of_end)
    g = (earned.groupby('partner_id').agg(last=('moment', 'max'), frequency=('order_id', 'nunique'), monetary=('amount', 'sum'))
         .reset_index().sort_values('partner_id', kind='mergesort').reset_index(drop=True))
    no_completed = int(len(set(pd.Series(confirmed_partners).dropna().astype(int)) - set(g['partner_id'].astype(int))))
    status = {'scored': int(len(g)), 'min_customers': min_customers, 'no_completed_order': no_completed}
    cols = ['partner_id', 'recency_days', 'frequency', 'monetary', 'r_score', 'f_score', 'm_score', 'segment', 'segment_name']
    if len(g) < min_customers:
        return {**status, 'status': 'not_enough_customers'}, pd.DataFrame(columns=cols)
    g['recency_days'] = np.floor((end - pd.to_datetime(g['last'])).dt.total_seconds() / 86400.0).astype(int)
    g['r_score'] = quintile(-g['recency_days'].astype(float), ascending=True)
    g['m_score'] = quintile(g['monetary'].astype(float), ascending=True)
    g['f_score'] = g['frequency'].map(f_score).astype(int)
    g['segment'] = [segment_of(r, f) for r, f in zip(g['r_score'], g['f_score'])]
    g['segment_name'] = g['segment'].map(NAMES)
    g['monetary'] = g['monetary'].round(2)
    return {**status, 'status': 'ok'}, g[cols]


def summary(customers):
    """Per segment, in SEGMENTS order: customers, share, mean recency, mean orders, mean and total monetary."""
    if not len(customers):
        return pd.DataFrame(columns=['segment', 'segment_name', 'customers', 'share_pct', 'avg_recency_days', 'avg_orders', 'avg_monetary',
                                     'total_monetary'])
    n = len(customers)
    rows = []
    for code, name, _ in SEGMENTS:
        c = customers[customers['segment'] == code]
        rows.append({'segment': code, 'segment_name': name, 'customers': int(len(c)), 'share_pct': round(100.0 * len(c) / n, 1),
                     'avg_recency_days': round(float(c['recency_days'].mean()), 1) if len(c) else None,
                     'avg_orders': round(float(c['frequency'].mean()), 2) if len(c) else None,
                     'avg_monetary': round(float(c['monetary'].mean()), 2) if len(c) else None,
                     'total_monetary': round(float(c['monetary'].sum()), 2)})
    return pd.DataFrame(rows)
