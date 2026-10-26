"""Read-only profile of a database for the DSS plan (B8 step 1). Not part of the DSS itself.

    DSS_DSN="host=127.0.0.1 dbname=clothcraft_sim2 user=clothcraft_mcp" python3 -m engine.profile [--csv-dir DIR]

It opens ONE read-only transaction (SET TRANSACTION READ ONLY), extracts the native facts, and prints the tables. Simulated data only:
it prints supplier names (sample companies) and no customer data. With --csv-dir it also checks the simulation's lost_demand.csv and
sold.csv against this database (for validation only; the DSS never reads them).
"""
import os
import sys

import pandas as pd
import psycopg2

from . import extract, transform as T

pd.set_option('display.width', 200)
pd.set_option('display.max_columns', 30)


def section(title):
    print(f'\n=== {title}')


def main(argv):
    csv_dir = argv[argv.index('--csv-dir') + 1] if '--csv-dir' in argv else None
    conn = psycopg2.connect(os.environ['DSS_DSN'])
    conn.set_session(readonly=True)
    cur = conn.cursor()
    raw = extract.extract_all(cur)
    conn.rollback()
    conn.close()

    orders, lines, cat, moves = raw['orders'], raw['order_lines'], raw['catalogue'], raw['stock_moves']
    as_of_ts = pd.to_datetime(orders['date_order']).max()
    as_of_day = (as_of_ts + T.MANILA).normalize()
    first_day = (pd.to_datetime(orders['date_order']).min() + T.MANILA).normalize()
    print(f'data window (Manila): {first_day.date()} to {as_of_day.date()}  ({(as_of_day - first_day).days + 1} days)')

    section('A. orders per month (Manila), by state')
    o = orders.assign(month=T.manila_day(orders['date_order']).dt.strftime('%Y-%m'))
    print(o.pivot_table(index='month', columns='state', values='order_id', aggfunc='count', fill_value=0).to_string())
    print('states:', o['state'].value_counts().to_dict())

    section('B. demand (confirmed orders, garments only)')
    d = T.demand_lines(lines, cat)
    excluded_cancel = lines[lines['state'] == 'cancel']
    nongarment = lines[lines['state'].isin(T.CONFIRMED) & lines['display_type'].isna()].merge(cat[~cat['garment'].astype(bool)], on='product_id')
    print(f"lines {len(d)} | orders {d['order_id'].nunique()} | units {d['qty'].sum():.0f} | excluded: cancelled-order lines {len(excluded_cancel)}, "
          f"non-garment lines on confirmed orders {len(nongarment)}, section/note lines {lines['display_type'].notna().sum()}")
    print('garment variants:', int(cat['garment'].astype(bool).sum()), '| garment products (templates):', cat.loc[cat['garment'].astype(bool), 'template_id'].nunique(),
          '| non-garment variants:', int((~cat['garment'].astype(bool)).sum()))

    section('C. sparse history')
    wv = T.weekly_units(d, cat, 'variant', first_day, as_of_day)
    weeks_total = wv['week'].nunique()
    per_v = wv.groupby('product_id').agg(weeks_sold=('units', lambda s: int((s > 0).sum())), units=('units', 'sum'))
    print(f"weeks in the window: {weeks_total} | weeks with any sale: {d['week'].nunique()}")
    bands = pd.cut(per_v['weeks_sold'], [-1, 0, 9, 19, 10_000], labels=['never sold', '1-9 weeks', '10-19 weeks', '20+ weeks'])
    print('variants by weeks with a sale:', bands.value_counts().reindex(['never sold', '1-9 weeks', '10-19 weeks', '20+ weeks']).to_dict(),
          f"| median units per variant {per_v['units'].median():.0f} | max {per_v['units'].max():.0f}")
    wp = T.weekly_units(d, cat, 'product', first_day, as_of_day).merge(cat[['template_id', 'template_name']].drop_duplicates(), on='template_id')
    print(wp.groupby('template_name').agg(weeks_sold=('units', lambda s: int((s > 0).sum())), units=('units', 'sum')).sort_values('units', ascending=False).to_string())

    section('D. stock-outs rebuilt from done moves')
    garment_ids = cat.loc[cat['garment'].astype(bool), 'product_id']
    bal = T.daily_balance(moves, first_day, as_of_day, garment_ids)
    s_on = T.stockout_summary(bal, n_variants=len(garment_ids))
    total_vw = len(garment_ids) * weeks_total
    print(f"on-hand <= 0: {s_on} | variant-weeks in window {total_vw} -> {100 * s_on['variant_weeks_with_zero_day'] / total_vw:.1f}%")
    print('lowest rebuilt balance:', bal['on_hand'].min(), '| variants with moves:', bal['product_id'].nunique())
    res = T.daily_reserved(moves, first_day, as_of_day)
    fb = T.free_balance(bal, res)
    s_free = T.stockout_summary(fb, n_variants=len(garment_ids), flag='free_out')
    print(f"free (on-hand - reserved, reconstructed) <= 0: {s_free}")
    only_res = fb[fb['free_out'] & ~fb['out']]
    print(f"variant-days with free <= 0 but on-hand > 0 (reserved-only zeros): {len(only_res)}")
    q = raw['quants'].merge(pd.DataFrame({'product_id': garment_ids}), on='product_id', how='right').fillna(0)
    now_bal = bal[bal['day'] == as_of_day][['product_id', 'on_hand']].rename(columns={'on_hand': 'rebuilt'})
    chk = q.merge(now_bal, on='product_id', how='left').fillna({'rebuilt': 0})
    print(f"now: zero on hand {int((q['on_hand'] <= 0).sum())}, zero free {int((q['on_hand'] - q['reserved'] <= 0).sum())}, median on hand {q['on_hand'].median():.0f} "
          f"| rebuilt balance at the last day equals the quants for {int((abs(chk['rebuilt'] - chk['on_hand']) < 1e-6).sum())} of {len(chk)} variants")

    section('E. supplier lead times (two sources)')
    lt_po, lt_rs = T.lead_times_po(raw['po_receipts']), T.lead_times_restock(raw['restock_receipts'])
    print(f"purchase order -> first done receipt: {len(lt_po)} | clothcraft.restock approved -> received: {len(lt_rs)} "
          f"(restock table present: {not raw['restock_receipts'].empty or 'see extract'})")
    print(T.lead_time_table(lt_po).to_string(index=False))
    if len(lt_rs):
        print(T.lead_time_table(lt_rs).to_string(index=False))
    si = raw['supplier_info']
    print(f"supplier info rows {len(si)} (template level {int(si['product_id'].isna().sum())}, variant level {int(si['product_id'].notna().sum())}), "
          f"templates covered {si['template_id'].nunique()}, templates with 2+ suppliers {int((si.groupby('template_id')['supplier_id'].nunique() > 1).sum())}")
    print(si.groupby('supplier').agg(rows=('supplierinfo_id', 'count'), declared_delay=('delay', 'mean'), avg_price=('price', 'mean')).round(2).to_string())

    section('F. open incoming receipts')
    orc = T.open_receipts(moves)
    print(f"open incoming moves {len(orc)} | units {orc['qty'].sum():.0f} | by source {orc['source'].value_counts().to_dict()} | "
          f"purchase orders still open {raw['po_receipts'].shape[0] and int(moves[moves['purchase_line_id'].notna() & ~moves['state'].isin(['done','cancel'])]['purchase_line_id'].nunique())} lines")

    section('G. pending bank transfers')
    pb = T.pending_bank_transfers(orders, raw['transactions'], as_of_ts)
    for col in ('age_tx_days', 'age_order_days'):
        a = pb[col]
        print(f"{col}: pending {len(pb)} | > 3 days {int((a > 3).sum())} | > 7 days {int((a > 7).sum())} | > 14 days {int((a > 14).sum())} | oldest {a.max():.1f}")
    print('payments by mode and state:', raw['transactions'].groupby(['custom_mode', 'state']).size().to_dict())

    section('H. RFM spread (delivered and paid)')
    dp = T.delivered_and_paid(orders, raw['outgoing_pickings'], raw['transactions'])
    qual = dp[dp['qualifies']]
    c = qual.groupby('partner_id').agg(f=('order_id', 'count'), m=('amount_total', 'sum'), last=('date_order', 'max'))
    c['r'] = (as_of_day - T.manila_day(c['last'])).dt.days
    print(f"confirmed {len(dp)} | delivered {int(dp['delivered'].sum())} | paid {int(dp['paid'].sum())} | delivered and paid {len(qual)} | customers {len(c)} | "
          f"one-time {int((c['f'] == 1).sum())} ({100 * (c['f'] == 1).mean():.1f}%) | max F {c['f'].max()} | max M {c['m'].max():.0f}")
    print('F quintile cuts', c['f'].quantile([.2, .4, .5, .6, .8]).round(1).tolist(), '| R cuts (days)', c['r'].quantile([.2, .4, .6, .8]).round(1).tolist(),
          '| M cuts', c['m'].quantile([.2, .4, .6, .8]).round(0).tolist())
    print('orders per customer:', c['f'].value_counts().sort_index().to_dict())

    section('I. ramp-up: customer base versus demand per customer')
    conf = orders[orders['state'].isin(T.CONFIRMED)].assign(day=lambda x: T.manila_day(x['date_order']))
    conf = conf.assign(week=T.week_of(conf['day']))
    first = conf.groupby('partner_id')['week'].min()
    weeks = pd.date_range(conf['week'].min(), conf['week'].max(), freq='7D')
    base = pd.Series([int((first <= w).sum()) for w in weeks], index=weeks)
    wk = pd.DataFrame({'base_customers': base, 'ordering_customers': conf.groupby('week')['partner_id'].nunique().reindex(weeks, fill_value=0),
                       'orders': conf.groupby('week')['order_id'].count().reindex(weeks, fill_value=0),
                       'units': d.groupby('week')['qty'].sum().reindex(weeks, fill_value=0)})
    wk['orders_per_base_customer'] = wk['orders'] / wk['base_customers']
    wk['units_per_base_customer'] = wk['units'] / wk['base_customers']
    wk['new_customers'] = wk['base_customers'].diff().fillna(wk['base_customers'])
    m = wk.groupby(wk.index.strftime('%Y-%m')).agg(weeks=('orders', 'size'), base_end=('base_customers', 'last'), new=('new_customers', 'sum'),
                                                    orders_per_week=('orders', 'mean'), units_per_week=('units', 'mean'),
                                                    orders_per_base_customer_week=('orders_per_base_customer', 'mean'))
    print(m.round(3).to_string())
    print('first 12 weeks:'); print(wk.head(12)[['base_customers', 'new_customers', 'orders', 'units', 'orders_per_base_customer']].round(3).to_string())

    section('J. fingerprint of the canonical extract')
    fp = T.fingerprint({'demand_lines': d[['line_id', 'order_id', 'product_id', 'template_id', 'qty', 'day']], 'weekly_variant': wv,
                        'balance': bal[['product_id', 'day', 'on_hand']], 'lead_times': lt_po[['supplier_id', 'days']], 'rfm_orders': qual[['order_id', 'partner_id', 'amount_total']]})
    print({k: (v['rows'], v['sha256'][:12]) if isinstance(v, dict) else v[:16] for k, v in fp.items()})

    if csv_dir:
        section('K. the simulation CSVs (validation only)')
        sold = pd.read_csv(os.path.join(csv_dir, 'sold.csv'), header=None, names=['month', 'code', 'units'])
        code = d['sku'].str.replace(r'^SIM-', '', regex=True).str.rsplit('-', n=2).str[0]
        mine = d.assign(month=d['day'].dt.strftime('%Y-%m'), code=code).groupby(['month', 'code'])['qty'].sum().rename('db_units').reset_index()
        cmp_ = sold.merge(mine, on=['month', 'code'], how='outer').fillna(0)
        print(f"sold.csv rows {len(sold)} | database month x product rows {len(mine)} | equal {int((cmp_['units'] == cmp_['db_units']).sum())} of {len(cmp_)} "
              f"| totals csv {sold['units'].sum():.0f} vs database {mine['db_units'].sum():.0f}")
        lost = pd.read_csv(os.path.join(csv_dir, 'lost_demand.csv'), parse_dates=['date']).rename(columns={'free': 'csv_free'})
        known = lost['variant'].isin(cat['sku'])
        print(f"lost_demand.csv rows {len(lost)} | variants known in this database {int(known.sum())} | dates {lost['date'].min().date()} to {lost['date'].max().date()} "
              f"| free=0 rows {int((lost['csv_free'] == 0).sum())} | free>0 rows (partly short) {int((lost['csv_free'] > 0).sum())}")
        L = lost.merge(cat[['sku', 'product_id']], left_on='variant', right_on='sku', how='left').merge(fb, left_on=['product_id', 'date'], right_on=['product_id', 'day'], how='left')
        out_, fout = L['out'].fillna(False).astype(bool), L['free_out'].fillna(False).astype(bool)
        z = L['csv_free'] == 0
        print(f"of the {int(z.sum())} free=0 rows: rebuilt on-hand <= 0 that day {int((z & out_).sum())} | on-hand > 0 but reconstructed free <= 0 (reserved-only) "
              f"{int((z & ~out_ & fout).sum())} | neither {int((z & ~out_ & ~fout).sum())} | no rebuilt row {int((z & L['on_hand'].isna()).sum())}")
        p = L['csv_free'] > 0
        print(f"of the {int(p.sum())} free>0 rows: rebuilt end-of-day on-hand equals the CSV's free {int((p & (abs(L['on_hand'] - L['csv_free']) < 1e-6)).sum())} | "
              f"reconstructed free equals it {int((p & (abs(L['free'] - L['csv_free']) < 1e-6)).sum())}")


if __name__ == '__main__':
    main(sys.argv[1:])
