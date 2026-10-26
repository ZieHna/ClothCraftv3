"""Weekly demand forecast with a rolling-origin backtest (B8 step 2). Pure pandas; every function takes an explicit as-of date.

Level: product (garment template). Garment type and total POINT forecasts are bottom-up sums of the product forecasts; their INTERVALS come
from their own backtest residuals, never from adding bounds. Weeks run Monday to Sunday (Manila); only complete weeks (Sunday on or before
the as-of date) are used. Weeks before the training start are ramp-up: never trained on, never scored, shown flagged.

Policies compared (one method per product): naive, ma4, snaive (comparator only, never chosen), ets (Holt, damped additive trend, no
seasonality) and ets_croston (Croston/SBA for intermittent products, ETS for the rest). A product with fewer than `thin_weeks` weeks with a
sale is forecast by its garment type's recent average times its own share (method group_share, flag not_enough_history); a product with no
sale at all gets no forecast.

Intervals: empirical quantiles of SCALED residuals r = (actual - forecast) / s, where s = the series' mean weekly units over the last
`level_weeks` training weeks (at least 1 unit), pooled across series of the same level per horizon; with fewer than `min_resid` residuals the
horizon bucket (1-2, 3-4, 5-8) is used, then all horizons, else no interval. Interval = forecast + q * s, clipped at 0. In the backtest the
pool for an origin holds only residuals from EARLIER origins (out of sample).
Errors: e = forecast - actual. MAE = mean|e|, WAPE = sum|e| / sum(actual) (in %), bias = sum(e) / sum(actual) (in %, positive = over-forecast).
"""
import numpy as np
import pandas as pd

from . import methods as M

DEFAULTS = {
    'horizon': 8, 'train_start': '2025-07-07', 'n_origins': 12, 'window_weeks': 26, 'origin_step': 2, 'calib_origins': 8,
    'intermittent_zero_share': 0.30, 'thin_weeks': 8, 'censor_share': 0.25, 'share_weeks': 26, 'level_weeks': 8, 'min_resid': 30,
    'override_margin': 5.0, 'group_weeks': 26,
}
POLICIES = ('naive', 'ma4', 'snaive', 'ets', 'ets_croston')
CANDIDATES = ('ets', 'ets_croston')      # the models; naive and ma4 are the baselines; snaive is only a comparator
BASELINES = ('naive', 'ma4')
BUCKETS = {1: '1-2', 2: '1-2', 3: '3-4', 4: '3-4', 5: '5-8', 6: '5-8', 7: '5-8', 8: '5-8'}
WEEK = pd.Timedelta(days=7)
# What the forecast cannot see, for the model card (B8 step 2 decisions). NOTES are true of every run and are always written. SIMULATION_NOTES quote
# the simulation's own numbers and are written only when the run is simulated (notes_for): a real run must never carry them.
NOTES = (
    'Censoring uses end-of-day on-hand <= 0 only. Shortages where stock was on hand but held by other orders (reserved-only) are not '
    'detected, and neither is a stock-out earlier in a day that ends positive after a same-day receipt. '
    'Demand lost while out of stock is not in the database, so demand is still understated for items that sell out.',
    'Weeks before the training start are ramp-up: not trained on and not scored.',
    'No annual seasonality is modelled (about 1.5 yearly cycles); seasonal naive is a comparator only.',
    'There are no promotion data in Odoo, so no promotion effects are modelled.',
)
SIMULATION_NOTES = (
    'Simulated data: this demonstrates the method, not real-world accuracy.',
    'In the simulation check, 6 of the 315 zero-stock rows were a stock-out earlier in a day that ends positive after a same-day receipt.',
    'In the simulation, weeks before the training start (2025-07-07, customer base under 60) are ramp-up.',
)


def notes_for(simulated):
    """The model-card notes for a run: the generic ones, plus the simulation ones only on a simulated run."""
    return list(NOTES) + (list(SIMULATION_NOTES) if simulated else [])


def monday(d):
    t = pd.Timestamp(d).normalize()
    return t - pd.Timedelta(days=t.day_of_week)


def first_monday_on_or_after(d):
    t = pd.Timestamp(d).normalize()
    return t + pd.Timedelta(days=(7 - t.day_of_week) % 7)


def last_complete_week(as_of):
    """The Monday of the last week whose Sunday is on or before as_of."""
    return monday(pd.Timestamp(as_of) + pd.Timedelta(days=1)) - WEEK


# ------------------------------------------------------------------------------------------------------------------ data
def prepare(catalogue, weekly_variant, daily_onhand, as_of, censor_share=DEFAULTS['censor_share']):
    """Product series (weeks x template ids, complete weeks only), the maps, and the censoring flags."""
    last = last_complete_week(as_of)
    wv = weekly_variant.assign(week=pd.to_datetime(weekly_variant['week']))
    wv = wv[wv['week'] <= last].drop(columns=['template_id'], errors='ignore').merge(catalogue[['product_id', 'template_id']], on='product_id')
    product = wv.pivot_table(index='week', columns='template_id', values='units', aggfunc='sum', fill_value=0.0).sort_index()
    product.columns = [int(c) for c in product.columns]
    tmpl = catalogue.drop_duplicates('template_id').set_index('template_id')
    gtype = {int(t): str(tmpl.loc[t, 'garment_type_code']) for t in product.columns}
    names = {int(t): str(tmpl.loc[t, 'template_name']) for t in product.columns}
    # censoring: a series-week is censored when at least censor_share of its variant-days had on-hand <= 0 (end of day)
    d = daily_onhand.assign(day=pd.to_datetime(daily_onhand['day']))
    d = d[d['day'] < last + WEEK].merge(catalogue[['product_id', 'template_id']], on='product_id')
    d = d.assign(week=d['day'] - pd.to_timedelta(d['day'].dt.day_of_week, unit='D'), out=d['on_hand'] <= 1e-9)
    d['gtype'] = d['template_id'].map(gtype)
    cens = {('product', int(t)): g.groupby('week')['out'].mean() >= censor_share for t, g in d.groupby('template_id')}
    for code, g in d.groupby('gtype'):
        cens[('garment_type', code)] = g.groupby('week')['out'].mean() >= censor_share
    cens[('total', 'total')] = d.groupby('week')['out'].mean() >= censor_share
    return {'product': product, 'gtype': gtype, 'names': names, 'censored': cens, 'last_week': last, 'as_of': pd.Timestamp(as_of)}


def is_censored(data, level, key, week):
    s = data['censored'].get((level, key))
    return bool(s.get(week, False)) if s is not None else False


# ------------------------------------------------------------------------------------------------------------------ forecasts at one origin
def _thin_forecast(data, tid, train_idx, H, group_weeks):
    """Garment type's mean weekly units over the last group_weeks training weeks x the product's share of its type since its first sale."""
    P = data['product'].loc[train_idx]
    code = data['gtype'][tid]
    group = P[[t for t in P.columns if data['gtype'][t] == code]].sum(axis=1)
    y = P[tid]
    since = y.index[y.to_numpy() > 0]
    if not len(since):
        return np.full(H, np.nan)
    share = y[y.index >= since[0]].sum() / max(group[group.index >= since[0]].sum(), 1e-9)
    return np.full(H, float(group.iloc[-group_weeks:].mean() * share))


def forecasts_at(data, origin, train_start, params):
    """{template id: {method: H forecasts, 'meta': {...}}} using only weeks before `origin` (training from train_start)."""
    P, H = data['product'], params['horizon']
    train_idx = P.index[(P.index >= train_start) & (P.index < origin)]
    full_idx = P.index[P.index < origin]
    out = {}
    for tid in P.columns:
        y, yfull = P.loc[train_idx, tid].to_numpy(dtype=float), P.loc[full_idx, tid].to_numpy(dtype=float)
        sold_weeks = int((y > 0).sum())
        if sold_weeks == 0:
            continue                                   # never sold in the training window: no forecast, never an invented number
        level = max(float(np.mean(y[-params['level_weeks']:])), 1.0)
        inter = M.zero_share(y) > params['intermittent_zero_share']
        if sold_weeks < params['thin_weeks']:
            f = _thin_forecast(data, tid, train_idx, H, params['group_weeks'])
            preds = {m: f for m in ('naive', 'ma4', 'ets', 'croston', 'snaive')}
            meta = {'thin': True, 'intermittent': inter, 'level': level}
        else:
            preds = {'naive': M.naive(y, H), 'ma4': M.moving_average(y, H), 'snaive': M.seasonal_naive(yfull, H), 'ets': M.holt_damped(y, H),
                     'croston': M.croston_sba(y, H) if inter else np.full(H, np.nan)}
            meta = {'thin': False, 'intermittent': inter, 'level': level}
        out[tid] = {**{m: np.clip(v, 0, None) for m, v in preds.items()}, 'meta': meta}
    return out


def policy_method(policy, meta):
    if meta['thin']:
        return 'group_share'
    if policy == 'ets_croston':
        return 'croston' if meta['intermittent'] else 'ets'
    return policy


# ------------------------------------------------------------------------------------------------------------------ backtest rows
def backtest_rows(data, origins, train_start, params):
    """One row per (origin, product, policy, horizon) whose target week has an actual: yhat, actual, scale, flags. Plus the bottom-up
    garment type and total rows per policy (point = sum of the product forecasts; scale = that series' own recent level)."""
    P, H, last = data['product'], params['horizon'], data['last_week']
    rows = []
    for o in sorted(origins):
        fc = forecasts_at(data, o, train_start, params)
        for policy in POLICIES:
            for h in range(1, H + 1):
                week = o + (h - 1) * WEEK
                if week > last or week not in P.index:
                    continue
                for tid, f in fc.items():
                    m = 'snaive' if policy == 'snaive' else policy_method(policy, f['meta'])
                    pred = f['naive'][h - 1] if m == 'group_share' else f[m][h - 1]     # a thin product's every entry is its group_share forecast
                    rows.append({'origin': o, 'level': 'product', 'key': tid, 'policy': policy, 'method': m, 'h': h, 'week': week,
                                 'yhat': pred, 'y': float(P.at[week, tid]), 's': f['meta']['level'], 'thin': f['meta']['thin'],
                                 'censored': is_censored(data, 'product', tid, week)})
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    # bottom-up series: a policy's garment type / total forecast is the sum of its product forecasts, where every product has one
    agg = []
    for (o, policy, h), g in df.groupby(['origin', 'policy', 'h']):
        train_idx = P.index[(P.index >= train_start) & (P.index < o)]
        groups = [('total', 'total', g)] + [('garment_type', code, gg) for code, gg in g.groupby(g['key'].map(data['gtype']))]
        for level, key, gg in groups:
            cols = [t for t in P.columns if level == 'total' or data['gtype'][t] == key]
            hist = P.loc[train_idx, cols].sum(axis=1).to_numpy()
            agg.append({'origin': o, 'level': level, 'key': key, 'policy': policy, 'method': policy, 'h': h, 'week': gg['week'].iloc[0],
                        'yhat': gg['yhat'].sum(min_count=len(gg)), 'y': float(P.loc[gg['week'].iloc[0], cols].sum()),
                        's': max(float(np.mean(hist[-params['level_weeks']:])), 1.0) if len(hist) else 1.0, 'thin': False,
                        'censored': is_censored(data, level, key, gg['week'].iloc[0])})
    return pd.concat([df, pd.DataFrame(agg)], ignore_index=True)


# ------------------------------------------------------------------------------------------------------------------ intervals
def pick_pool(pool, h, min_resid):
    """The residuals for horizon h: that horizon, else its bucket, else all horizons; (values, which) or (None, None)."""
    for which, sel in (('h', pool['h'] == h), ('bucket', pool['h'].map(BUCKETS) == BUCKETS[h]), ('all', pool['h'] > 0)):
        r = pool.loc[sel, 'r'].dropna().to_numpy()
        if len(r) >= min_resid:
            return r, which
    return None, None


def quantiles(r):
    return {'q10': np.quantile(r, 0.10), 'q90': np.quantile(r, 0.90), 'q025': np.quantile(r, 0.025), 'q975': np.quantile(r, 0.975)}


def add_rolling_intervals(rows, min_resid):
    """For each backtest row, interval bounds from the scaled residuals of the same level and policy at EARLIER origins only."""
    rows = rows.assign(r=(rows['y'] - rows['yhat']) / rows['s'])
    out = []
    for (level, policy), g in rows.groupby(['level', 'policy'], sort=False):
        g = g.copy()
        for c in ('lo80', 'hi80', 'lo95', 'hi95'):
            g[c] = np.nan
        g['pool'] = None
        for o in sorted(g['origin'].unique()):
            prior = g[g['origin'] < o]
            here = g.index[g['origin'] == o]
            for h in g.loc[here, 'h'].unique():
                r, which = pick_pool(prior, int(h), min_resid)
                if r is None:
                    continue
                q = quantiles(r)
                idx = here[g.loc[here, 'h'] == h]
                yh, s = g.loc[idx, 'yhat'], g.loc[idx, 's']
                g.loc[idx, 'lo80'], g.loc[idx, 'hi80'] = (yh + q['q10'] * s).clip(lower=0), (yh + q['q90'] * s).clip(lower=0)
                g.loc[idx, 'lo95'], g.loc[idx, 'hi95'] = (yh + q['q025'] * s).clip(lower=0), (yh + q['q975'] * s).clip(lower=0)
                g.loc[idx, 'pool'] = which
        out.append(g)
    return pd.concat(out)


# ------------------------------------------------------------------------------------------------------------------ metrics and selection
def metrics(g):
    """WAPE, MAE, bias, coverage on the rows that HAVE a forecast: a NaN forecast (seasonal naive without a year of history) is not scored, so n, MAE, WAPE
    and bias are all on the same rows."""
    g = g[g['yhat'].notna()]
    e = g['yhat'] - g['y']
    sy = g['y'].sum()
    with_int = g['lo80'].notna() if 'lo80' in g else pd.Series(False, index=g.index)
    gi = g[with_int]
    return {'n': len(g), 'mae': float(e.abs().mean()) if len(g) else np.nan,
            'wape': float(100 * e.abs().sum() / sy) if sy > 0 else np.nan, 'bias': float(100 * e.sum() / sy) if sy > 0 else np.nan,
            'cov80': float(((gi['y'] >= gi['lo80']) & (gi['y'] <= gi['hi80'])).mean() * 100) if len(gi) else np.nan,
            'cov95': float(((gi['y'] >= gi['lo95']) & (gi['y'] <= gi['hi95'])).mean() * 100) if len(gi) else np.nan, 'n_int': len(gi)}


def common_rows(rows, policies):
    """Product rows where every given policy has a forecast (so policies are compared on the same weeks)."""
    p = rows[(rows['level'] == 'product') & rows['policy'].isin(policies)]
    ok = p.dropna(subset=['yhat']).groupby(['origin', 'key', 'h'])['policy'].nunique() == len(policies)
    keys = ok[ok].index
    return p.set_index(['origin', 'key', 'h']).loc[lambda x: x.index.isin(keys)].reset_index()


def select(rows, params):
    """The overall policy (lowest product-level WAPE over the evaluation origins, ties to the simpler), judged against the best of naive
    and ma4; then per-product overrides that beat the product's own choice by more than override_margin WAPE points."""
    pol = BASELINES + CANDIDATES
    cr = common_rows(rows, pol)
    w = {p: metrics(cr[cr['policy'] == p])['wape'] for p in pol}
    order = {p: i for i, p in enumerate(M.SIMPLICITY)}
    best_base = min(BASELINES, key=lambda p: (round(w[p], 9), order[p]))
    best_model = min(CANDIDATES, key=lambda p: (round(w[p], 9), order[p]))
    beats = w[best_model] < w[best_base] - 1e-9
    chosen = best_model if beats else best_base
    overrides = {}
    for tid, g in cr.groupby('key'):
        if g['thin'].any():
            continue
        own = g[g['policy'] == chosen]
        own_method = own['method'].iloc[0] if len(own) else chosen
        own_w = metrics(own)['wape']
        best = None
        for p in pol:
            gp = g[g['policy'] == p]
            m = gp['method'].iloc[0] if len(gp) else p
            if m == own_method or not len(gp):
                continue
            wp = metrics(gp)['wape']
            if wp < own_w - params['override_margin'] and (best is None or wp < best[1]):
                best = (m, wp)
        if best:
            overrides[int(tid)] = {'method': best[0], 'wape': round(best[1], 2), 'instead_of': own_method, 'wape_instead': round(own_w, 2)}
    return {'wape': w, 'best_baseline': best_base, 'best_model': best_model, 'model_beats_baseline': beats, 'chosen': chosen,
            'overrides': overrides, 'message': None if beats else 'the model did not beat the baseline', 'n_common': len(cr) // len(pol)}


def chosen_rows(rows, selection, data, params, train_start):
    """Backtest rows of the FINAL configuration: each product with its chosen method (overall policy or override), and the garment types
    and total as the sums of those, with their own scales."""
    p = rows[rows['level'] == 'product']
    pick = []
    for tid, g in p.groupby('key'):
        ov = selection['overrides'].get(int(tid))
        if ov:
            g = g[g['method'] == ov['method']].drop_duplicates(['origin', 'h'])
        else:
            g = g[g['policy'] == selection['chosen']]
        pick.append(g)
    prod = pd.concat(pick).assign(policy='chosen')
    P = data['product']
    agg = []
    for (o, h), g in prod.groupby(['origin', 'h']):
        train_idx = P.index[(P.index >= train_start) & (P.index < o)]
        week = g['week'].iloc[0]
        for level, key, gg in [('total', 'total', g)] + [('garment_type', c, x) for c, x in g.groupby(g['key'].map(data['gtype']))]:
            cols = [t for t in P.columns if level == 'total' or data['gtype'][t] == key]
            hist = P.loc[train_idx, cols].sum(axis=1).to_numpy()
            agg.append({'origin': o, 'level': level, 'key': key, 'policy': 'chosen', 'method': 'bottom_up', 'h': h, 'week': week,
                        'yhat': gg['yhat'].sum(), 'y': float(P.loc[week, cols].sum()),
                        's': max(float(np.mean(hist[-params['level_weeks']:])), 1.0), 'thin': False, 'censored': is_censored(data, level, key, week)})
    return pd.concat([prod.drop(columns=[c for c in ('r', 'lo80', 'hi80', 'lo95', 'hi95', 'pool') if c in prod]), pd.DataFrame(agg)], ignore_index=True)


# ------------------------------------------------------------------------------------------------------------------ the run
def origins_for(data, params):
    """Evaluation origins: n_origins Mondays, every origin_step weeks, inside the last window_weeks complete weeks; calibration origins:
    calib_origins more before them, same spacing (their residuals seed the out-of-sample intervals; they are not scored)."""
    last = data['last_week']
    first_eval = last - (params['window_weeks'] - 1) * WEEK
    ev = [first_eval + i * params['origin_step'] * WEEK for i in range(params['n_origins'])]
    cal = [first_eval - (i + 1) * params['origin_step'] * WEEK for i in range(params['calib_origins'])]
    return sorted(cal), ev


def backtest(data, params, origins=None, calib=None, train_start=None):
    train_start = first_monday_on_or_after(train_start or params['train_start'])
    cal, ev = (calib, origins) if origins is not None else origins_for(data, params)
    cal = [o for o in (cal or []) if o > train_start]
    rows = backtest_rows(data, list(cal) + list(ev), train_start, params)
    rows['eval'] = rows['origin'].isin(ev)
    rows = add_rolling_intervals(rows, params['min_resid'])
    sel = select(rows[rows['eval']], params)
    final = add_rolling_intervals(chosen_rows(rows, sel, data, params, train_start), params['min_resid'])
    final['eval'] = final['origin'].isin(ev)
    return {'rows': rows, 'final': final, 'selection': sel, 'train_start': train_start, 'calib': cal, 'origins': ev}


def summarise(rows, by=('level', 'key', 'policy'), horizon=True):
    """Backtest metric rows (the planned schema): per series and method, per horizon and for all horizons, on all and on uncensored weeks."""
    out = []
    for keys, g in rows.groupby(list(by), sort=True):
        for weeks, gw in (('all', g), ('uncensored', g[~g['censored'].astype(bool)])):
            hs = [('all', gw)] + ([(str(h), gh) for h, gh in gw.groupby('h')] if horizon else [])
            for hb, gh in hs:
                out.append({**dict(zip(by, keys)), 'horizon': hb, 'weeks': weeks, **metrics(gh)})
    return pd.DataFrame(out)


def final_forecast(data, bt, params):
    """The forecast from the as-of date: the next `horizon` weeks after the last complete week, per product with its chosen method, and the
    garment types and total as bottom-up sums. Intervals from ALL backtest residuals of the chosen configuration (same pooling rule)."""
    sel, train_start, H = bt['selection'], bt['train_start'], params['horizon']
    origin = data['last_week'] + WEEK
    fc = forecasts_at(data, origin, train_start, params)
    pool = bt['final'].assign(r=lambda x: (x['y'] - x['yhat']) / x['s'])
    rows = []
    P = data['product']
    train_idx = P.index[(P.index >= train_start) & (P.index < origin)]
    per_h = {}
    for tid, f in fc.items():
        ov = sel['overrides'].get(int(tid))
        m = ov['method'] if ov else policy_method(sel['chosen'], f['meta'])
        pred = f['naive'] if m == 'group_share' else f[m]
        flags = []
        if f['meta']['thin']:
            flags.append('not_enough_history')
        if f['meta']['intermittent']:
            flags.append('intermittent')
        if ov:
            flags.append('override')
        if not sel['model_beats_baseline']:
            flags.append('baseline_wins')
        for h in range(1, H + 1):
            per_h.setdefault(h, []).append((tid, pred[h - 1]))
            rows.append(_row(pool, 'product', int(tid), origin + (h - 1) * WEEK, h, pred[h - 1], f['meta']['level'], m, flags, params,
                             wide=f['meta']['thin']))
    for h, items in per_h.items():
        d = dict(items)
        series = [('total', 'total', list(d))] + [('garment_type', c, [t for t in d if data['gtype'][t] == c]) for c in sorted(set(data['gtype'][t] for t in d))]
        for level, key, tids in series:
            cols = [t for t in P.columns if level == 'total' or data['gtype'][t] == key]
            hist = P.loc[train_idx, cols].sum(axis=1).to_numpy()
            s = max(float(np.mean(hist[-params['level_weeks']:])), 1.0)
            rows.append(_row(pool, level, key, origin + (h - 1) * WEEK, h, float(sum(d[t] for t in tids)), s, 'bottom_up', [], params))
    return pd.DataFrame(rows).sort_values(['level', 'key', 'week_start'], key=lambda c: c.astype(str)).reset_index(drop=True)


def _row(pool, level, key, week, h, yhat, s, method, flags, params, wide=False):
    r, which = pick_pool(pool[pool['level'] == level], h, params['min_resid'])
    yhat = max(float(yhat), 0.0)
    out = {'level': level, 'key': key, 'week_start': week, 'h': h, 'yhat': yhat, 'method': method, 'censored': False}
    if r is None:
        out.update(lo80=np.nan, hi80=np.nan, lo95=np.nan, hi95=np.nan, flags=','.join(flags + ['no_interval']))
        return out
    q = quantiles(r)
    k = 2.0 if wide else 1.0             # a thin product's interval is twice as wide
    out.update(lo80=max(yhat + k * q['q10'] * s, 0.0), hi80=max(yhat + k * q['q90'] * s, 0.0), lo95=max(yhat + k * q['q025'] * s, 0.0),
               hi95=max(yhat + k * q['q975'] * s, 0.0), flags=','.join(flags + ([f'interval_pool_{which}'] if which != 'h' else [])))
    return out


# ------------------------------------------------------------------------------------------------------------------ variant shares
def variant_shares(catalogue, weekly_variant, daily_onhand, as_of, weeks=DEFAULTS['share_weeks']):
    """Each variant's share of its product over the last `weeks` complete weeks, counting in-stock days only, with Laplace smoothing:
    adjusted units a = units x window_days / in_stock_days (a = units when it was never in stock at the end of a day), share = (a + 1) /
    (sum a + number of variants). Shares sum to 1 per product."""
    last = last_complete_week(as_of)
    start = last - (weeks - 1) * WEEK
    days = weeks * 7
    wv = weekly_variant.assign(week=pd.to_datetime(weekly_variant['week']))
    units = wv[(wv['week'] >= start) & (wv['week'] <= last)].groupby('product_id')['units'].sum()
    d = daily_onhand.assign(day=pd.to_datetime(daily_onhand['day']))
    instock = d[(d['day'] >= start) & (d['day'] < last + WEEK) & (d['on_hand'] > 1e-9)].groupby('product_id').size()
    v = catalogue[['product_id', 'template_id']].copy()
    v['units'] = v['product_id'].map(units).fillna(0.0)
    v['in_stock_days'] = v['product_id'].map(instock).fillna(0).astype(int)
    v['adjusted'] = np.where(v['in_stock_days'] > 0, v['units'] * days / v['in_stock_days'].clip(lower=1), v['units'])
    tot = v.groupby('template_id')['adjusted'].transform('sum')
    n = v.groupby('template_id')['product_id'].transform('count')
    return v.assign(share=(v['adjusted'] + 1) / (tot + n))


def run(catalogue, weekly_variant, daily_onhand, as_of, params=None):
    """Everything step 6 will persist: forecast rows, backtest metric rows, the selection, variant shares. Deterministic."""
    p = {**DEFAULTS, **(params or {})}
    data = prepare(catalogue, weekly_variant, daily_onhand, as_of, p['censor_share'])
    bt = backtest(data, p)
    fc = final_forecast(data, bt, p)
    metrics_rows = pd.concat([summarise(bt['rows'][bt['rows']['eval']]), summarise(bt['final'][bt['final']['eval']])], ignore_index=True)
    sel = bt['selection']
    metrics_rows['chosen'] = (metrics_rows['policy'] == 'chosen') | ((metrics_rows['policy'] == sel['chosen']) & (metrics_rows['level'] == 'product'))
    return {'forecast': fc, 'backtest': metrics_rows, 'selection': sel, 'shares': variant_shares(catalogue, weekly_variant, daily_onhand, as_of, p['share_weeks']),
            'notes': NOTES, 'data': data, 'bt': bt, 'params': p}
