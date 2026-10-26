"""One-time export of the canonical series the forecast step needs (B8 step 2), from a SIMULATED database, read-only.

    DSS_DSN=... python3 -m engine.export_dataset OUT_DIR [--csv-dir DIR]

Writes three gzip CSV files and a small meta file to OUT_DIR: the garment catalogue (product ids, product and garment type names, SKUs:
no person), weekly units per variant, and the rebuilt daily on-hand per variant. Nothing about customers is read or written. With
--csv-dir it also prints the detail of the lost_demand.csv rows that fell on neither a zero on-hand day nor a reserved-only zero
(validation only; that CSV is never a DSS input).
"""
import json
import os
import sys

import pandas as pd
import psycopg2

from . import extract, transform as T


def main(argv):
    out = argv[0]
    csv_dir = argv[argv.index('--csv-dir') + 1] if '--csv-dir' in argv else None
    conn = psycopg2.connect(os.environ['DSS_DSN'])
    conn.set_session(readonly=True)
    cur = conn.cursor()
    cat, lines, orders, moves = extract.catalogue(cur), extract.order_lines(cur), extract.orders(cur), extract.stock_moves(cur)
    conn.rollback()
    conn.close()

    as_of_ts = pd.to_datetime(orders['date_order']).max()
    as_of_day = (as_of_ts + T.MANILA).normalize()
    first_day = (pd.to_datetime(orders['date_order']).min() + T.MANILA).normalize()
    garments = cat[cat['garment'].astype(bool)].copy()
    demand = T.demand_lines(lines, cat)
    weekly = T.weekly_units(demand, cat, 'variant', first_day, as_of_day)
    balance = T.daily_balance(moves, first_day, as_of_day, garments['product_id'])

    os.makedirs(out, exist_ok=True)
    garments[['product_id', 'template_id', 'template_name', 'sku', 'garment_type_id', 'garment_type_code']].to_csv(
        os.path.join(out, 'catalogue.csv.gz'), index=False)
    weekly.to_csv(os.path.join(out, 'weekly_variant.csv.gz'), index=False, date_format='%Y-%m-%d')
    balance[['product_id', 'day', 'on_hand']].to_csv(os.path.join(out, 'daily_onhand.csv.gz'), index=False, date_format='%Y-%m-%d')
    meta = {'source': 'clothcraft_sim2 (simulated), read-only role', 'as_of': str(as_of_day.date()), 'as_of_utc': str(as_of_ts),
            'first_day': str(first_day.date()), 'rows': {'catalogue': len(garments), 'weekly_variant': len(weekly), 'daily_onhand': len(balance)},
            'fingerprint': T.fingerprint({'weekly_variant': weekly, 'daily_onhand': balance[['product_id', 'day', 'on_hand']]})['all']}
    with open(os.path.join(out, 'meta.json'), 'w') as fh:
        json.dump(meta, fh, indent=1)
    print('wrote', meta)

    if csv_dir:
        lost = pd.read_csv(os.path.join(csv_dir, 'lost_demand.csv'), parse_dates=['date']).rename(columns={'free': 'csv_free'})
        fb = T.free_balance(balance, T.daily_reserved(moves, first_day, as_of_day))
        L = lost.merge(cat[['sku', 'product_id']], left_on='variant', right_on='sku').merge(fb, left_on=['product_id', 'date'], right_on=['product_id', 'day'], how='left')
        odd = L[(L['csv_free'] == 0) & ~L['out'].astype(bool) & ~L['free_out'].astype(bool)]
        print(f'\n=== the {len(odd)} free=0 rows on neither a zero on-hand day nor a reserved-only zero')
        mv = moves.assign(day=T.manila_day(moves['date']), at_manila=pd.to_datetime(moves['date']) + T.MANILA)
        for _, r in odd.iterrows():
            prev = fb[(fb['product_id'] == r['product_id']) & (fb['day'] == r['date'] - pd.Timedelta(days=1))]
            print(f"\n{r['date'].date()} {r['variant']}: wanted {r['wanted']}, csv free 0 | rebuilt end-of-day on hand {r['on_hand']:.0f}, "
                  f"reconstructed reserved {r['reserved']:.0f} | previous day on hand {prev['on_hand'].iloc[0] if len(prev) else 'n/a'}")
            day = mv[(mv['product_id'] == r['product_id']) & (mv['day'] == r['date']) & (mv['state'] == 'done')]
            for _, m in day.sort_values('at_manila').iterrows():
                print(f"   done move {m['at_manila'].strftime('%H:%M')} {m['src_usage']} -> {m['dest_usage']} qty {m['quantity']:.0f}")


if __name__ == '__main__':
    main(sys.argv[1:])
