"""The B8 step 2 report: backtest tables, coverage, sensitivity, the Dec-2025 block, examples, run time and memory.

    python3 -m engine.report_step2 DATA_DIR      (the folder written by engine.export_dataset; no database is used)
"""
import json
import os
import resource
import sys
import time

import numpy as np
import pandas as pd

from . import forecast as F

pd.set_option('display.width', 220)
pd.set_option('display.max_columns', 30)
pd.set_option('display.max_rows', 200)
W = F.WEEK


def load(d):
    return (pd.read_csv(os.path.join(d, 'catalogue.csv.gz')), pd.read_csv(os.path.join(d, 'weekly_variant.csv.gz')),
            pd.read_csv(os.path.join(d, 'daily_onhand.csv.gz')), json.load(open(os.path.join(d, 'meta.json'))))


def section(t):
    print(f'\n=== {t}')


def policy_table(rows, level='product'):
    """Per policy: WAPE, MAE, bias on all and on uncensored weeks. Product level uses the common rows (every policy has a forecast); snaive
    is reported on its own rows (it has none for weeks without a year of history)."""
    if level == 'product':
        base = F.common_rows(rows, F.BASELINES + F.CANDIDATES)
        sn = rows[(rows['level'] == 'product') & (rows['policy'] == 'snaive')].dropna(subset=['yhat'])
    else:
        base = rows[rows['level'] == level].dropna(subset=['yhat'])
        sn = base[base['policy'] == 'snaive']
        base = base[base['policy'] != 'snaive']
    out = []
    for p, g in pd.concat([base, sn]).groupby('policy'):
        a, u = F.metrics(g), F.metrics(g[~g['censored'].astype(bool)])
        out.append({'policy': p, 'n': a['n'], 'WAPE%': a['wape'], 'MAE': a['mae'], 'bias%': a['bias'], 'WAPE% uncensored': u['wape'],
                    'n uncensored': u['n'], 'cov80': a['cov80'], 'cov95': a['cov95']})
    return pd.DataFrame(out).set_index('policy').round(2)


def main(argv):
    cat, wv, dh, meta = load(argv[0])
    as_of = meta['as_of']
    print('dataset:', meta)

    t0 = time.time()
    out = F.run(cat, wv, dh, as_of)
    secs = time.time() - t0
    data, bt, sel = out['data'], out['bt'], out['selection']
    rows, final = bt['rows'][bt['rows']['eval']], bt['final'][bt['final']['eval']]
    names = data['names']
    print(f"as of {as_of} | last complete week {data['last_week'].date()} (the week of {(data['last_week'] + W).date()} is incomplete and not used) "
          f"| training from {bt['train_start'].date()} | evaluation origins {bt['origins'][0].date()} .. {bt['origins'][-1].date()} ({len(bt['origins'])}, every 2 weeks) "
          f"| calibration origins {len(bt['calib'])} ({bt['calib'][0].date()} .. {bt['calib'][-1].date()})")

    section('1. overall, product level (all 19 products pooled, 12 origins, horizons 1-8), vs the best simple baseline')
    pt = policy_table(rows)
    best = sel['best_baseline']
    pt['vs best baseline (WAPE points)'] = (pt['WAPE%'] - pt.loc[best, 'WAPE%']).round(2)
    print(pt.to_string())
    print(f"best baseline: {best} | best model: {sel['best_model']} | model beats baseline: {sel['model_beats_baseline']} | CHOSEN: {sel['chosen']} | "
          f"overrides: {sel['overrides'] or 'none'} | {sel['message'] or 'the model beat the baseline'} | compared on {sel['n_common']} product-weeks per policy")

    section('1b. total level (bottom-up point forecasts), per policy')
    print(policy_table(bt['rows'][bt['rows']['eval']], 'total').to_string())

    section('2. per product: chosen method vs the baselines (WAPE %, 12 origins, all horizons)')
    per = []
    for tid, g in rows[rows['level'] == 'product'].groupby('key'):
        w = {p: F.metrics(g[g['policy'] == p].dropna(subset=['yhat']))['wape'] for p in F.POLICIES}
        ch = final[(final['level'] == 'product') & (final['key'] == tid)]
        y = data['product'].loc[(data['product'].index >= bt['train_start']), tid]
        by_origin = ch.drop_duplicates('origin')['method']
        per.append({'product': names[tid], 'zero weeks %': round(100 * (y == 0).mean(), 1), 'method (most origins)': by_origin.mode().iloc[0],
                    'croston at origins': f"{int((by_origin == 'croston').sum())}/{len(by_origin)}",
                    'chosen WAPE': F.metrics(ch)['wape'], 'naive': w['naive'], 'ma4': w['ma4'], 'ets': w['ets'], 'ets_croston': w['ets_croston'],
                    'snaive': w['snaive'], 'units in eval': g[g['policy'] == 'naive']['y'].sum()})
    per = pd.DataFrame(per).sort_values('units in eval', ascending=False)
    per['beats best baseline'] = per['chosen WAPE'] < per[best]
    print(per.round(1).to_string(index=False))
    print(f"products where the chosen method beats {best}: {int(per['beats best baseline'].sum())} of {len(per)}")

    section('3. by horizon: product-level WAPE % per policy (common rows) and the final configuration at total level')
    cr = F.common_rows(rows, F.BASELINES + F.CANDIDATES)
    byh = cr.groupby(['h', 'policy']).apply(lambda g: F.metrics(g)['wape'], include_groups=False).unstack().round(1)
    byh['chosen total'] = final[final['level'] == 'total'].groupby('h').apply(lambda g: F.metrics(g)['wape'], include_groups=False).round(1)
    print(byh.to_string())

    section('4. interval coverage of the final configuration, per horizon (out of sample: each origin calibrated on earlier origins only)')
    cov = []
    for level in ('product', 'garment_type', 'total'):
        for h, g in final[final['level'] == level].groupby('h'):
            m = F.metrics(g)
            cov.append({'level': level, 'h': h, 'n with interval': m['n_int'], 'cov80': m['cov80'], 'cov95': m['cov95'],
                        'pool': ','.join(sorted(set(g['pool'].dropna())))})
    cov = pd.DataFrame(cov)
    cov['80 short by >10'] = cov['cov80'] < 70
    cov['95 short by >10'] = cov['cov95'] < 85
    print(cov.round(1).to_string(index=False))

    section('5. censored vs uncensored weeks (final configuration, evaluation weeks)')
    for level in ('product', 'total'):
        g = final[final['level'] == level]
        c = g['censored'].astype(bool)
        print(f"{level}: censored {int(c.sum())} of {len(g)} rows ({100 * c.mean():.1f}%) | WAPE all {F.metrics(g)['wape']:.1f} | uncensored {F.metrics(g[~c])['wape']:.1f} "
              f"| censored only {F.metrics(g[c])['wape'] if c.any() else float('nan'):.1f} | bias all {F.metrics(g)['bias']:.1f} | bias censored {F.metrics(g[c])['bias'] if c.any() else float('nan'):.1f}")

    section('6. training window: with the ramp-up weeks (from 2025-04-07), the decision (2025-07-07), the sensitivity (2025-10-01 -> 2025-10-06)')
    sens = []
    for start in ('2025-04-07', '2025-07-07', '2025-10-01'):
        b = F.backtest(data, out['params'], train_start=start)
        r = b['rows'][b['rows']['eval']]
        t = policy_table(r)
        s = b['selection']
        tot = F.metrics(b['final'][b['final']['eval'] & (b['final']['level'] == 'total')])
        sens.append({'train from': b['train_start'].date(), **{f'{p} WAPE': t.loc[p, 'WAPE%'] for p in ('naive', 'ma4', 'ets', 'ets_croston', 'snaive')},
                     'chosen': s['chosen'], 'beats baseline': s['model_beats_baseline'], 'overrides': len(s['overrides']), 'total WAPE (chosen)': round(tot['wape'], 2),
                     'total cov80': round(tot['cov80'], 1)})
    print(pd.DataFrame(sens).to_string(index=False))

    section('7. the Nov-Dec 2025 block (origins every Monday from 2025-11-03 to 2025-12-29, training from 2025-07-07)')
    nov = [pd.Timestamp('2025-11-03') + i * W for i in range(9)]
    calib = [pd.Timestamp('2025-10-06') + i * W for i in range(4)]
    b = F.backtest(data, out['params'], origins=nov, calib=calib, train_start='2025-07-07')
    r = b['rows'][b['rows']['eval']]
    print(policy_table(r).to_string())
    print('total level:'); print(policy_table(r, 'total').to_string())
    s = b['selection']
    print(f"in this block: best baseline {s['best_baseline']} | best model {s['best_model']} | model beats baseline {s['model_beats_baseline']} | would choose {s['chosen']}")
    peak = b['final'][b['final']['eval'] & (b['final']['level'] == 'total') & (b['final']['h'] == 1)][['origin', 'y', 'yhat', 'lo80', 'hi80']].assign(origin=lambda x: x['origin'].dt.date)
    print('one week ahead, total, the chosen configuration of THIS block:'); print(peak.round(1).to_string(index=False))

    section('8. chosen method and the forecast from the as-of date (next 8 weeks)')
    fc = out['forecast']
    print(f"chosen: {sel['chosen']} ({'Croston/SBA for intermittent products, ETS for the rest' if sel['chosen'] == 'ets_croston' else sel['chosen']}) | overrides: {sel['overrides'] or 'none'}")
    inter = sorted(names[t] for t in fc[(fc['level'] == 'product') & fc['flags'].str.contains('intermittent')]['key'].unique())
    print('intermittent products (zero weeks above 30% in the training window):', inter or 'none')
    def show(level, key, title):
        g = fc[(fc['level'] == level) & (fc['key'] == key)][['week_start', 'yhat', 'lo80', 'hi80', 'lo95', 'hi95', 'method', 'flags']].copy()
        g['week_start'] = pd.to_datetime(g['week_start']).dt.date
        print(f'\n{title}'); print(g.round(1).to_string(index=False))
    popular = max(names, key=lambda t: data['product'][t].sum())
    show('product', popular, f'popular: {names[popular]}')
    inter_ids = [t for t in names if names[t] in inter]
    if inter_ids:
        show('product', inter_ids[0], f'intermittent: {names[inter_ids[0]]}')
    show('total', 'total', 'total (bottom-up point, own-residual intervals)')
    thin = [t for t in names if 'not_enough_history' in ','.join(fc[(fc['level'] == 'product') & (fc['key'] == t)]['flags'])]
    print('\nthin products in this dataset as of', as_of, ':', [names[t] for t in thin] or 'none (every product has 8+ weeks with a sale)')
    early = pd.Timestamp('2025-08-04')
    ex = F.forecasts_at(data, early, pd.Timestamp('2025-07-07'), out['params'])
    thin_early = [t for t, f in ex.items() if f['meta']['thin']]
    if thin_early:
        t = thin_early[0]
        y = data['product'].loc[(data['product'].index >= '2025-07-07') & (data['product'].index < early), t]
        print(f"a thin example, as of the origin {early.date()} (4 training weeks): {names[t]} sold {list(y.astype(int))} -> group_share forecast "
              f"{ex[t]['naive'][0]:.2f} per week for 8 weeks (flag not_enough_history); thin products at that origin: {len(thin_early)} of {len(ex)}")

    section('9. run time and memory')
    print(f"full run (12 + 8 origins x 19 products x 5 policies, selection, final forecast, shares): {secs:.1f} s | peak memory of this process: "
          f"{resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MB (includes the extra runs above)")
    sh = out['shares']
    print(f"variant shares: {len(sh)} variants, per-product sums min {sh.groupby('template_id')['share'].sum().min():.12f} max {sh.groupby('template_id')['share'].sum().max():.12f}")
    print(f"output rows: forecast {len(fc)} | backtest metric rows {len(out['backtest'])} | columns forecast {list(fc.columns)} | backtest {list(out['backtest'].columns)}")


if __name__ == '__main__':
    main(sys.argv[1:])
