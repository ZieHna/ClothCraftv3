"""One DSS run from a cursor, and the checksummed bundle it is written to (B8 S1). Read-only: SELECTs only, nothing is written to a database.

    DSS_DSN="host=... dbname=clothcraft_sim2 user=clothcraft_mcp" python3 -m engine.bundle OUT_DIR [--as-of YYYY-MM-DD]

run_all(cur) extracts the native facts once, then runs the forecast (only with at least `min_sale_weeks` complete weeks with a garment sale),
restock, segments, alerts and health. The as-of day is the last order's Manila day on a simulated database (so results do not drift as real
time passes) and today (Manila) otherwise. The meta block records the source database, whether it is simulated, the Closed rule used, the
parameters, the input fingerprint, the engine and library versions and the time; every run states its Closed rule.
On a simulated database customers are written under a pseudonymous key only (no partner id, no name).

write_bundle() writes each table as deterministic gzip CSV (no timestamp in the gzip header), summary.json, and manifest.json with the
SHA-256 of every file and of the whole bundle; verify_bundle() checks them.
"""
import datetime
import hashlib
import json
import math
import os
import platform
import sys

import numpy as np
import pandas as pd

from . import alerts as AL
from . import extract
from . import extract_more as X
from . import forecast as F
from . import health as H
from . import restock as RS
from . import segments as SG
from . import transform as T

ENGINE_VERSION = 'B8-S4'    # B8-S4: adds the weekly actuals table (actuals.csv.gz)
PARAMS = {'min_sale_weeks': 16, 'forecast': {}, 'restock': dict(RS.PARAMS), 'segments': {'min_customers': SG.MIN_CUSTOMERS},
          'trend': dict(H.TREND), 'projection_months': 3}
SIMULATED_LABEL = 'Simulated data: demonstrates the method, not real-world accuracy.'
TABLES = ('forecast', 'backtest', 'restock', 'segments', 'segment_summary', 'alerts', 'health_monthly', 'actuals')
ACTUALS_COLUMNS = ['level', 'key', 'week_start', 'units', 'censored']


def actuals_table(data, train_start):
    """The weekly units the forecast was trained and scored on (B8-S4), for the forecast chart: one row per (level, key, week_start) for
    level 'product' (key = template id) and 'total', from the training start through the last complete week, with the censored flag
    forecast.prepare computed. Garment-type sums are not stored (sum the product rows)."""
    P = data['product']
    start, last = pd.Timestamp(train_start), data['last_week']
    weeks = P.index[(P.index >= start) & (P.index <= last)]
    rows = []
    for tid in P.columns:
        for w in weeks:
            rows.append({'level': 'product', 'key': str(int(tid)), 'week_start': w, 'units': float(P.at[w, tid]),
                         'censored': F.is_censored(data, 'product', int(tid), w)})
    total = P.loc[weeks].sum(axis=1)
    for w in weeks:
        rows.append({'level': 'total', 'key': 'total', 'week_start': w, 'units': float(total[w]), 'censored': F.is_censored(data, 'total', 'total', w)})
    return pd.DataFrame(rows, columns=ACTUALS_COLUMNS)


def lib_versions():
    import numpy
    out = {'python': platform.python_version(), 'pandas': pd.__version__, 'numpy': numpy.__version__}
    try:
        import statsmodels
        out['statsmodels'] = statsmodels.__version__
    except ImportError:
        out['statsmodels'] = None
    return out


def manila_today():
    return (pd.Timestamp(datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)) + T.MANILA).normalize()


def end_of_day_utc(as_of):
    """The end of the Manila as-of day as naive UTC (the moment everything is measured at)."""
    return pd.Timestamp(as_of).normalize() + pd.Timedelta(days=1) - T.MANILA


def pseudonym(db, partner_id):
    return 'c_' + hashlib.sha256(f'{db}:{int(partner_id)}'.encode()).hexdigest()[:16]


def _merge(base, extra):
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in base.items()}
    for k, v in (extra or {}).items():
        out[k] = {**out[k], **v} if isinstance(out.get(k), dict) and isinstance(v, dict) else v
    return out


# ---------------------------------------------------------------------------------------------------------------- the run
def extract_inputs(cur):
    """Everything the run reads, in one go (the caller's transaction); the cursor is not needed after this."""
    return {'info': X.database_info(cur), 'raw': extract.extract_all(cur), 'more': X.extract_more_all(cur),
            'has_restock_tables': extract.table_exists(cur, 'clothcraft_restock')}


def run_all(cur, as_of=None, params=None):
    return compute(extract_inputs(cur), as_of, params)


def compute(inputs, as_of=None, params=None):
    p = _merge(PARAMS, params)
    info, raw, more, has_restock_tables = inputs['info'], inputs['raw'], inputs['more'], inputs['has_restock_tables']
    orders, cat, moves = raw['orders'], raw['catalogue'], raw['stock_moves']
    if as_of is None:
        as_of = (pd.to_datetime(orders['date_order']).max() + T.MANILA).normalize() if info['simulated'] and len(orders) else manila_today()
    as_of = pd.Timestamp(as_of).normalize()
    end = end_of_day_utc(as_of)
    first_day = (pd.to_datetime(orders['date_order']).min() + T.MANILA).normalize() if len(orders) else as_of
    first_order_month = first_day.strftime('%Y-%m') if len(orders) else None
    garments = cat[cat['garment'].astype(bool)].copy()
    demand = T.demand_lines(raw['order_lines'], cat)
    status = {}

    # ---- forecast (needs history)
    sale_weeks = int(demand.loc[demand['week'] <= F.last_complete_week(as_of), 'week'].nunique()) if len(demand) else 0
    fc_out = None
    if sale_weeks >= p['min_sale_weeks']:
        weekly = T.weekly_units(demand, cat, 'variant', first_day, as_of)
        balance = T.daily_balance(moves, first_day, as_of, garments['product_id'])
        fc_out = F.run(garments[['product_id', 'template_id', 'template_name', 'sku', 'garment_type_id', 'garment_type_code']], weekly,
                       balance[['product_id', 'day', 'on_hand']], as_of, p['forecast'] or None)
        status['forecast'] = {'status': 'ok', 'sale_weeks': sale_weeks, 'chosen': fc_out['selection']['chosen'],
                              'model_beats_baseline': bool(fc_out['selection']['model_beats_baseline'])}
    else:
        status['forecast'] = {'status': 'not_enough_history', 'sale_weeks': sale_weeks, 'needed': p['min_sale_weeks'],
                              'message': f"Not enough history yet (needs {p['min_sale_weeks']} weeks with sales; has {sale_weeks})."}
    forecast = fc_out['forecast'] if fc_out else pd.DataFrame(columns=['level', 'key', 'week_start', 'h', 'yhat', 'method', 'censored', 'lo80',
                                                                         'hi80', 'lo95', 'hi95', 'flags'])

    # ---- restock
    restock = None
    if fc_out:
        if len(more['suppliers']):
            lt = RS.lead_table_by_id(T.lead_times_restock(raw['restock_receipts']))
            delays = {}
        else:
            lt = RS.lead_table_by_id(T.lead_times_po(raw['po_receipts']))
            delays = raw['supplier_info'].groupby('supplier_id')['delay'].max().to_dict() if len(raw['supplier_info']) else {}
        leads = RS.lead_times(lt, delays, p['restock'])
        variants = garments[['product_id', 'template_id', 'garment_type_id']].merge(more['variant_attributes'], on='product_id', how='left')
        cands = RS.candidates(variants, more['suppliers'], more['supplier_lines'], more['supplier_unavailability'], raw['supplier_info'], as_of)
        incoming = RS.incoming_units(moves, more['restocks'], more['restock_lines'])
        restock = RS.build(cat, more['variant_attributes'], raw['quants'], incoming, fc_out['shares'], forecast,
                           RS.sigma_by_product(fc_out['bt']['final']), cands, leads, as_of, p['restock'])
        status['restock'] = {'status': 'ok', 'variants': int(len(restock)), 'order_now': int(restock['order_now'].fillna(False).astype(bool).sum())}
    else:
        status['restock'] = {'status': 'no_forecast'}

    # ---- the Closed rule, segments
    earned, rule = H.earned_orders(orders, raw['outgoing_pickings'], raw['transactions'], more['order_states'], more['order_audit'],
                                   info['has_clothcraft_state'], end)
    confirmed = orders.loc[orders['state'].isin(T.CONFIRMED), 'partner_id'].unique()
    seg_status, customers = SG.score(earned, confirmed, end, p['segments']['min_customers'])
    status['segments'] = seg_status
    customers = customers.copy()
    if len(customers):
        customers.insert(0, 'customer_key', [pseudonym(info['db'], x) if info['simulated'] else str(int(x)) for x in customers['partner_id']])
        customers['partner_id'] = None if info['simulated'] else customers['partner_id']
    else:
        customers.insert(0, 'customer_key', pd.Series(dtype=object))

    # ---- alerts
    alerts, available = AL.build(orders, raw['transactions'], raw['outgoing_pickings'], as_of, end, restock, more['stock_alerts'],
                                 more['restocks'], more['suppliers'], more['supplier_unavailability'], has_restock_tables, p['restock'])
    status['alerts'] = {'status': 'ok', 'count': int(len(alerts)), 'kinds': available}

    # ---- health
    costs = H.last_costs(cat, moves, more['po_lines'], more['restocks'], more['restock_lines'], more['supplier_lines'], raw['supplier_info'],
                         more['variant_attributes'])
    monthly = H.monthly(earned, H.spending_rows(moves, more['po_lines'], more['restocks']), H.closed_units(earned, demand), costs, as_of,
                        first_order_month)
    opening = float(more['suppliers']['opening_balance'].fillna(0).sum()) if len(more['suppliers']) else 0.0
    restock_value = float(restock.loc[restock['suggested_qty'].fillna(0) > 0, 'est_cost'].fillna(0).sum()) if restock is not None else 0.0
    health = {'trend': H.trend(monthly, p['trend']), 'kpis': H.kpis(monthly, costs, raw['quants'], opening, as_of),
              'projection': H.projection(forecast, as_of, H.revenue_per_unit(earned, demand, monthly), restock_value, p['projection_months'],
                                         simulated=info['simulated'])}
    status['health'] = {'status': 'ok', 'label': health['trend']['label'], 'warning': health['trend']['warning']}

    meta = {'engine_version': ENGINE_VERSION, 'source_db': info['db'], 'module_version': info['module_version'], 'simulated': info['simulated'],
            'label': SIMULATED_LABEL if info['simulated'] else None, 'closed_rule': rule, 'closed_rule_text': H.RULE_TEXT[rule],
            'as_of': str(as_of.date()), 'as_of_end_utc': str(end), 'params': p, 'libraries': lib_versions(),
            'input_fingerprint': T.fingerprint({**raw, **more})['all'],
            'created_at_utc': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(), 'status': status}
    tables = {'forecast': forecast, 'backtest': fc_out['backtest'] if fc_out else pd.DataFrame(),
              'restock': restock if restock is not None else pd.DataFrame(), 'segments': customers, 'segment_summary': SG.summary(customers),
              'alerts': alerts, 'health_monthly': monthly,
              'actuals': actuals_table(fc_out['data'], fc_out['bt']['train_start']) if fc_out else pd.DataFrame(columns=ACTUALS_COLUMNS)}
    summary = {'selection': _selection(fc_out['selection']) if fc_out else None, 'forecast_notes': F.notes_for(info['simulated']) if fc_out else [],
               'health': health, 'costs': {'variants_with_cost': int(costs['last_cost'].notna().sum()), 'by_source': costs['cost_source'].value_counts().to_dict()}}
    return {'meta': meta, 'tables': tables, 'summary': summary}


def _selection(sel):
    return {'chosen': sel['chosen'], 'best_baseline': sel['best_baseline'], 'best_model': sel['best_model'],
            'model_beats_baseline': bool(sel['model_beats_baseline']), 'wape': {k: round(float(v), 2) for k, v in sel['wape'].items()},
            'overrides': {str(k): v for k, v in sel['overrides'].items()}, 'message': sel['message']}


# ---------------------------------------------------------------------------------------------------------------- the bundle
def _clean(o):
    """JSON-safe values: numpy scalars to Python, NaN to None, timestamps to ISO text."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if math.isnan(float(o)) else float(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp, datetime.date)):
        return o.isoformat()
    return o


def _sha(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def write_bundle(out_dir, result):
    os.makedirs(out_dir, exist_ok=True)
    files = {}
    for name in TABLES:
        df = result['tables'][name]
        path = os.path.join(out_dir, f'{name}.csv.gz')
        df.to_csv(path, index=False, date_format='%Y-%m-%d %H:%M:%S', compression={'method': 'gzip', 'mtime': 0})
        files[f'{name}.csv.gz'] = {'rows': int(len(df)), 'sha256': _sha(path)}
    path = os.path.join(out_dir, 'summary.json')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(_clean(result['summary']), fh, indent=1, sort_keys=True)
    files['summary.json'] = {'rows': None, 'sha256': _sha(path)}
    manifest = {**_clean(result['meta']), 'files': files,
                'bundle_sha256': hashlib.sha256('\n'.join(f"{n}:{f['sha256']}" for n, f in sorted(files.items())).encode()).hexdigest()}
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=1, sort_keys=True)
    return manifest


def verify_bundle(out_dir):
    """(ok, problems): every listed file exists with its SHA-256, and the bundle hash matches."""
    with open(os.path.join(out_dir, 'manifest.json'), encoding='utf-8') as fh:
        m = json.load(fh)
    problems = []
    for name, f in m['files'].items():
        path = os.path.join(out_dir, name)
        if not os.path.exists(path):
            problems.append(f'{name}: missing')
        elif _sha(path) != f['sha256']:
            problems.append(f'{name}: checksum differs')
    whole = hashlib.sha256('\n'.join(f"{n}:{f['sha256']}" for n, f in sorted(m['files'].items())).encode()).hexdigest()
    if whole != m['bundle_sha256']:
        problems.append('bundle_sha256 differs')
    return not problems, problems


def main(argv):
    import psycopg2
    out = argv[0]
    as_of = argv[argv.index('--as-of') + 1] if '--as-of' in argv else None
    conn = psycopg2.connect(os.environ['DSS_DSN'])
    conn.set_session(readonly=True)
    try:
        inputs = extract_inputs(conn.cursor())       # the transaction ends before the computing starts (no idle open transaction)
    finally:
        conn.rollback()
        conn.close()
    m = write_bundle(out, compute(inputs, as_of))
    print(json.dumps({k: m[k] for k in ('source_db', 'simulated', 'label', 'closed_rule', 'as_of', 'input_fingerprint', 'bundle_sha256', 'status')},
                     indent=1, default=str))


if __name__ == '__main__':
    main(sys.argv[1:])
