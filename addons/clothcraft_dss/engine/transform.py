"""Canonical DSS tables from the raw extracts (B8 step 1). Pure pandas: no database, no Odoo, so each rule is tested on hand-built tables.

Time: the database stores naive UTC. A day is an Asia/Manila calendar day (UTC+8, no daylight saving); a week runs Monday to Sunday and is
named by its Monday. Demand is garment units of CONFIRMED orders (state sale or done) by order date; cancelled orders, section and note
lines (display_type) and non-garment products (no garment_type_id, such as a customization fee) are excluded.
"""
import hashlib

import numpy as np
import pandas as pd

MANILA = pd.Timedelta(hours=8)
CONFIRMED = ('sale', 'done')


def manila_day(ts):
    """Naive UTC timestamps -> the Manila calendar day (a Timestamp at midnight)."""
    return (pd.to_datetime(ts) + MANILA).dt.normalize()


def week_of(days):
    """A Manila day -> the Monday that starts its week."""
    days = pd.to_datetime(days)
    return days - pd.to_timedelta(days.dt.day_of_week, unit='D')


# ---------------------------------------------------------------------------------------------------------------- demand
def demand_lines(lines, catalogue):
    """The order lines that count as demand, with their Manila day and week."""
    garments = catalogue.loc[catalogue['garment'].astype(bool), ['product_id', 'template_id', 'sku']]
    keep = lines[lines['state'].isin(CONFIRMED) & lines['display_type'].isna()]
    out = keep.merge(garments, on='product_id', how='inner')
    out = out.assign(day=manila_day(out['date_order']))
    return out.assign(week=week_of(out['day'])).sort_values('line_id').reset_index(drop=True)


def weekly_units(demand, catalogue, level='product', start=None, end=None):
    """Units per week per product (template) or per variant, on a full grid: every garment key x every week from `start` to `end`
    (Manila days; default the first and last demand day), weeks with no sale are 0."""
    key = 'template_id' if level == 'product' else 'product_id'
    garments = catalogue[catalogue['garment'].astype(bool)]
    keys = np.sort(garments[key].unique())
    first = pd.Timestamp(start) if start is not None else demand['day'].min()
    last = pd.Timestamp(end) if end is not None else demand['day'].max()
    weeks = pd.date_range(week_of(pd.Series([first]))[0], week_of(pd.Series([last]))[0], freq='7D')
    grid = pd.MultiIndex.from_product([keys, weeks], names=[key, 'week'])
    sums = demand.groupby([key, 'week'])['qty'].sum()
    return sums.reindex(grid, fill_value=0.0).rename('units').reset_index()


# ---------------------------------------------------------------------------------------------------------------- stock
def internal_deltas(moves):
    """Done moves that cross the internal boundary: + into an internal location, - out of one (internal to internal moves are 0)."""
    done = moves[moves['state'] == 'done']
    into = (done['dest_usage'] == 'internal') & (done['src_usage'] != 'internal')
    out_of = (done['src_usage'] == 'internal') & (done['dest_usage'] != 'internal')
    sign = np.where(into, 1.0, np.where(out_of, -1.0, 0.0))
    res = done.assign(delta=sign * done['quantity'], day=manila_day(done['date']))
    return res.loc[res['delta'] != 0, ['product_id', 'day', 'delta']]


def opening_moves(moves):
    """The opening-balance move of each variant, as {product_id: row label in `moves`}: the FIRST-ENTERED (lowest move id) done move that brings
    the variant's stock in, when that move is an inventory adjustment (source usage 'inventory') of a positive quantity. A variant whose first-entered
    inbound move is a receipt, or a zero-quantity adjustment, has no opening move. Ids are taken as the order the moves were entered in."""
    done = moves[moves['state'] == 'done']
    inbound = done[(done['dest_usage'] == 'internal') & (done['src_usage'] != 'internal')]
    if inbound.empty:
        return {}
    first = inbound.loc[inbound.groupby('product_id')['move_id'].idxmin()]
    first = first[(first['src_usage'] == 'inventory') & (first['quantity'] > 0)]
    return dict(zip(first['product_id'], first.index))


def backdate_opening(grp, label, start, adjusted):
    """One variant's deltas with its opening move counted from the start of its history, when the ledger shows it was entered late.

    Why: stock that was on the shelf before the first sale can be entered into the books afterwards, dated the day it was entered (an opening stock
    loaded after trading began, or a history replayed with back-dated sales). Rebuilt in date order, such a variant starts below zero and looks
    out of stock until the entry date, which is not what happened.

    The rule applies only when ALL of these hold (otherwise `grp` is returned unchanged):
      1. the variant has an opening move (opening_moves) and it is one of `grp`'s rows (`label`);
      2. WITHOUT that move the running balance goes below zero on some day BEFORE the move's own day: the ledger cannot be right without it. Only real
         arrivals (receipts) and the outgoing moves count here: stock added by another inventory adjustment (`adjusted`: a count that found a unit) is not cover,
         because such an adjustment usually corrects an earlier omission, that is, stock that was already there;
      3. that makes the opening move earlier than the variant's first other move or `start`, whichever is earlier.
    Then that one move is counted on that earlier day. Only its day moves: its quantity is counted once, no other move changes, and nothing is
    written anywhere. It does NOT apply when the opening stock is dated before it is needed, when there is no opening move, or when the balance
    never goes below zero (a variant that never sold, or whose early sales were covered by earlier stock): those variants are rebuilt exactly as the moves say.
    Assumption: a lower move id means entered earlier. The result is only as good as that assumption; the stored moves are never changed."""
    if label is None or label not in grp.index:
        return grp
    opening_day = grp.at[label, 'day']
    rest = grp.drop(index=label)
    if rest.empty:
        return grp
    cover = rest[~(adjusted.loc[rest.index] & (rest['delta'] > 0))]
    running = cover.groupby('day')['delta'].sum().cumsum()
    if not (running[running.index < opening_day] < -1e-9).any():
        return grp
    new_day = min(rest['day'].min(), start)
    if new_day >= opening_day:
        return grp
    grp = grp.copy()
    grp.at[label, 'day'] = new_day
    return grp


def daily_balance(moves, start, end, product_ids=None):
    """End-of-day on-hand per variant, rebuilt from done moves, for every Manila day from `start` to `end` from the variant's first move
    on (before its first move a variant is not counted). out = on_hand <= 0. A variant whose opening stock was entered after its first sales
    has that opening move counted from the start of its history (backdate_opening); every stored move keeps its own date."""
    moves = moves.reset_index(drop=True)
    deltas = internal_deltas(moves)
    openings = opening_moves(moves)
    adjusted = moves['src_usage'] == 'inventory'          # moves that come from an inventory adjustment (by row label, like the deltas)
    if product_ids is not None:
        deltas = deltas[deltas['product_id'].isin(product_ids)]
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    rows = []
    for pid, grp in deltas.groupby('product_id'):
        grp = backdate_opening(grp, openings.get(pid), start, adjusted)
        daily = grp.groupby('day')['delta'].sum()
        days = pd.date_range(daily.index.min(), end, freq='D')
        bal = daily.reindex(days, fill_value=0.0).cumsum()
        bal = bal[bal.index >= start]
        rows.append(pd.DataFrame({'product_id': pid, 'day': bal.index, 'on_hand': bal.values}))
    if not rows:
        return pd.DataFrame(columns=['product_id', 'day', 'on_hand', 'out'])
    out = pd.concat(rows, ignore_index=True)
    return out.assign(out=out['on_hand'] <= 1e-9)


def daily_reserved(moves, start, end):
    """An APPROXIMATION of what orders held, per variant per Manila day: an outgoing move (internal -> outside) holds its asked quantity
    from the day it was created to the day it was done (done moves), to `end` (still open), or to its last write (cancelled). Odoo does
    not keep a history of reservations, so this is a reconstruction; it can exceed what was actually reservable."""
    out = moves[(moves['src_usage'] == 'internal') & (moves['dest_usage'] != 'internal')]
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    begin = manila_day(out['create_date'])
    stop = np.where(out['state'] == 'done', manila_day(out['date']),
                    np.where(out['state'] == 'cancel', manila_day(out['write_date']), end + pd.Timedelta(days=1)))
    res = []
    for pid, b, s, q in zip(out['product_id'], begin, pd.to_datetime(stop), out['demand_qty']):
        days = pd.date_range(max(b, start), min(s - pd.Timedelta(days=1), end), freq='D')
        if len(days):
            res.append(pd.DataFrame({'product_id': pid, 'day': days, 'reserved': q}))
    if not res:
        return pd.DataFrame(columns=['product_id', 'day', 'reserved'])
    return pd.concat(res, ignore_index=True).groupby(['product_id', 'day'], as_index=False)['reserved'].sum()


def free_balance(balance, reserved):
    """on_hand - reserved per variant day (reserved 0 where nothing was held); free_out = free <= 0."""
    out = balance.merge(reserved, on=['product_id', 'day'], how='left').fillna({'reserved': 0.0})
    out = out.assign(free=out['on_hand'] - out['reserved'])
    return out.assign(free_out=out['free'] <= 1e-9)


def stockout_summary(balance, n_variants=None, flag='out'):
    """How much of the rebuilt history is at zero: variant-weeks with at least one zero day, variants ever at zero, weeks with any variant
    at zero, and the share of variant-days at zero (over the rebuilt days, or over n_variants x days when given)."""
    zero = balance[balance[flag]]
    weeks = zero.assign(week=week_of(zero['day']))[['product_id', 'week']].drop_duplicates()
    all_days = balance['day'].nunique()
    denom = (n_variants * all_days) if n_variants else len(balance)
    return {
        'variant_weeks_with_zero_day': len(weeks), 'variants_ever_zero': int(zero['product_id'].nunique()),
        'weeks_with_any_zero': int(weeks['week'].nunique()), 'variant_days_zero': len(zero),
        'pct_variant_days_zero': round(100.0 * len(zero) / denom, 2) if denom else 0.0,
    }


# ---------------------------------------------------------------------------------------------------------------- lead times
def lead_times_po(po):
    """Days from purchase order approval (else its order date) to its first done receipt move."""
    if po.empty:
        return pd.DataFrame(columns=['source', 'supplier_id', 'supplier', 'start', 'received', 'days'])
    start = pd.to_datetime(po['date_approve']).fillna(pd.to_datetime(po['date_order']))
    days = (pd.to_datetime(po['first_receipt']) - start).dt.total_seconds() / 86400.0
    return pd.DataFrame({'source': 'purchase_order', 'supplier_id': po['supplier_id'], 'supplier': po['supplier'], 'start': start,
                         'received': pd.to_datetime(po['first_receipt']), 'days': days})


def lead_times_restock(rs):
    """Days from a ClothCraft restock's approval (decided_at, Manila day) to the day its goods arrived (received_on), received tickets only."""
    got = rs[(rs['state'] == 'received') & rs['decided_at'].notna() & rs['received_on'].notna()] if not rs.empty else rs
    if got.empty:
        return pd.DataFrame(columns=['source', 'supplier_id', 'supplier', 'start', 'received', 'days'])
    start = manila_day(got['decided_at'])
    received = pd.to_datetime(got['received_on'])
    return pd.DataFrame({'source': 'clothcraft_restock', 'supplier_id': got['supplier_id'], 'supplier': got['supplier'], 'start': start,
                         'received': received, 'days': (received - start).dt.days.astype(float)})


def lead_time_table(lt):
    if lt.empty:
        return pd.DataFrame(columns=['supplier', 'n', 'mean', 'median', 'p90', 'sd', 'min', 'max'])
    g = lt.groupby('supplier')['days']
    out = pd.DataFrame({'n': g.size(), 'mean': g.mean(), 'median': g.median(), 'p90': g.quantile(0.9), 'sd': g.std(), 'min': g.min(), 'max': g.max()})
    return out.round(1).reset_index()


def open_receipts(moves):
    """Incoming moves (outside -> internal) not done and not cancelled: what is still expected."""
    inc = moves[(moves['dest_usage'] == 'internal') & (moves['src_usage'] != 'internal') & ~moves['state'].isin(['done', 'cancel'])]
    return inc.assign(source=np.where(inc['purchase_line_id'].notna(), 'purchase_order', 'other'))[
        ['move_id', 'product_id', 'demand_qty', 'date', 'state', 'source']].rename(columns={'demand_qty': 'qty', 'date': 'expected'})


# ---------------------------------------------------------------------------------------------------------------- orders and payments
def delivered_and_paid(orders, pickings, txs):
    """Confirmed orders whose outgoing pickings are all done (at least one done, none open) and that have a done payment transaction.
    Returns every confirmed order with the flags delivered, paid and qualifies."""
    conf = orders[orders['state'].isin(CONFIRMED)].copy()
    pk = pickings.assign(done=pickings['state'] == 'done', open=~pickings['state'].isin(['done', 'cancel']))
    per = pk.groupby('order_id').agg(n_done=('done', 'sum'), n_open=('open', 'sum'))
    paid = txs.loc[txs['state'] == 'done', 'order_id'].unique()
    conf = conf.join(per, on='order_id').fillna({'n_done': 0, 'n_open': 0})
    conf['delivered'] = (conf['n_done'] >= 1) & (conf['n_open'] == 0)
    conf['paid'] = conf['order_id'].isin(paid)
    conf['qualifies'] = conf['delivered'] & conf['paid']
    return conf.drop(columns=['n_done', 'n_open'])


def pending_bank_transfers(orders, txs, as_of_end):
    """Bank-transfer (wire_transfer) transactions still pending on a confirmed order, with two ages in days at `as_of_end` (naive UTC):
    since the order was placed and since the transaction was created."""
    t = txs[(txs['custom_mode'] == 'wire_transfer') & (txs['state'] == 'pending')]
    t = t.merge(orders[['order_id', 'state', 'date_order']].rename(columns={'state': 'order_state'}), on='order_id', how='inner')
    t = t[t['order_state'].isin(CONFIRMED)]
    end = pd.Timestamp(as_of_end)
    return t.assign(age_order_days=(end - pd.to_datetime(t['date_order'])).dt.total_seconds() / 86400.0,
                    age_tx_days=(end - pd.to_datetime(t['create_date'])).dt.total_seconds() / 86400.0)


# ---------------------------------------------------------------------------------------------------------------- fingerprint
def _canonical_csv(df):
    cols = sorted(df.columns)
    d = df[cols].copy()
    for c in cols:
        if pd.api.types.is_datetime64_any_dtype(d[c]):
            d[c] = d[c].dt.strftime('%Y-%m-%dT%H:%M:%S.%f')
        elif pd.api.types.is_float_dtype(d[c]):
            d[c] = d[c].round(6)
    d = d.astype(str).sort_values(cols, kind='mergesort') if cols else d
    return d.to_csv(index=False, lineterminator='\n')


def fingerprint(tables):
    """{name: {rows, sha256}} per table plus `all`: a SHA-256 over the sorted names, row counts and table hashes. The tables are made
    canonical first (columns sorted by name, values as text, rows sorted), so the same data always gives the same fingerprint, whatever
    order the rows or columns came in."""
    parts = {name: {'rows': len(df), 'sha256': hashlib.sha256(_canonical_csv(df).encode()).hexdigest()} for name, df in tables.items()}
    summary = '\n'.join(f"{n}:{p['rows']}:{p['sha256']}" for n, p in sorted(parts.items()))
    return {**parts, 'all': hashlib.sha256(summary.encode()).hexdigest()}
