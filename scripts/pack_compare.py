# DSS scenario pack, slice P3: compare the STORED real DSS run with ground_truth.csv. READ ONLY. Run inside `odoo shell` for clothcraft_pack_20261026:
#   docker compose run --rm --no-deps -T -e PYTHONDONTWRITEBYTECODE=1 -v "<repo>\testdata\dss-scenarios:/mnt/pack" odoo odoo shell -d clothcraft_pack_20261026 --no-http < scripts/pack_compare.py
# The transaction is set READ ONLY first, so nothing can be written. Nothing is tuned: a row that does not match is printed as it is. The full table goes to
# _local/p3_comparison.csv (git-ignored). Plain ASCII.
import collections
import csv
import datetime
import json
import math
import os
import statistics

PACK = os.environ.get('PACK_DIR', '/mnt/pack')
cr = env.cr
import re
if not (cr.dbname in ('clothcraft_pack_20261026', 'clothcraft_shop') or re.fullmatch(r'clothcraft_shop_[a-z0-9]+', cr.dbname)):
    raise SystemExit('only the pack database, clothcraft_shop or a rehearsal copy (this comparison is read only)')
cr.execute('SET TRANSACTION READ ONLY')


def q(sql, params=None):
    cr.execute(sql, params or [])
    return cr.fetchall()


def say(*parts):
    print('CMP', *parts, flush=True)


def rows(name):
    with open(os.path.join(PACK, name), encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def js(value):
    return json.loads(value) if isinstance(value, str) else value


def utc(text):
    return datetime.datetime.fromisoformat(text).astimezone(datetime.timezone.utc).replace(tzinfo=None)


GT = rows('ground_truth.csv')
EMPS, CUSTS, RESTOCKS = rows('employees.csv'), rows('customers.csv'), rows('restock_requests.csv')
SUPS = {s['supplier_id']: s for s in rows('suppliers.csv')}

# ---- the stored run
_ONLY = os.environ.get('PACK_RUN_ID')      # compare one named run instead of the latest
run = q("SELECT id, summary, status, selection, simulated, duration_s, started_at, finished_at, as_of, engine_version FROM clothcraft_dss_run WHERE state = 'done' AND NOT simulated" + (' AND id = %s' if _ONLY else '') + ' ORDER BY id DESC LIMIT 1', [int(_ONLY)] if _ONLY else None)
if not run:
    raise SystemExit('there is no finished real run: nothing to compare (the DSS was not run)')
RUN, SUMMARY, STATUS, SELECTION, _sim, DURATION, STARTED, FINISHED, ASOF, ENGINE = run[0]
SUMMARY, STATUS, SELECTION = js(SUMMARY) or {}, js(STATUS) or {}, js(SELECTION) or {}
say('run', RUN, '| as of', ASOF, '| engine', ENGINE, '| started', STARTED, 'UTC | finished', FINISHED, 'UTC | duration', DURATION, 's')

# ---- mappings from the pack's ids to the database's
orders = {}
for oid, ref, st, amt in q("SELECT id, client_order_ref, clothcraft_state, amount_total FROM sale_order WHERE client_order_ref LIKE %s", ['%:pack:O%']):
    orders[ref.split(':pack:')[1]] = {'id': oid, 'state': st, 'amount': float(amt)}
odoo_order = {v['id']: k for k, v in orders.items()}
rs_by_time = {requested: (rid, name) for rid, name, requested in q("SELECT id, name, requested_at FROM clothcraft_restock")}
restock = {}
for r in RESTOCKS:
    hit = rs_by_time.get(utc(r['requested_at']))
    if hit:
        restock[r['restock_id']] = {'id': hit[0], 'name': hit[1], 'supplier': r['supplier_id']}
partner = {login: pid for login, pid in q("SELECT lower(login), partner_id FROM res_users WHERE share")}
cust_key = {c['customer_id']: str(partner[c['email'].lower()]) for c in CUSTS}
cust_key['BASE-B1'] = str(q("SELECT partner_id FROM sale_order WHERE name = 'S00002'")[0][0])
tmpl = {slug: str(i) for slug, i in q("SELECT clothcraft_slug, id FROM product_template WHERE clothcraft_slug IS NOT NULL")}
emp_user = {e['employee_id']: q("SELECT active FROM res_users WHERE lower(login) = %s", [e['email'].lower()])[0][0] for e in EMPS}

# ---- the run's outputs
health = {m: dict(zip(('revenue', 'closed_orders', 'closed_units', 'spending', 'cogs'), (float(r), int(c), float(u), float(s), float(g))))
          for m, r, c, u, s, g in q("SELECT month, revenue, closed_orders, closed_units, spending, cogs FROM clothcraft_dss_health WHERE run_id = %s", [RUN])}
alerts = [dict(zip(('kind', 'band', 'severity', 'type', 'key', 'label', 'age', 'message'), r))
          for r in q("SELECT kind, band, severity, subject_type, subject_key, subject_label, age_days, message FROM clothcraft_dss_alert WHERE run_id = %s ORDER BY id", [RUN])]
seg = {k: dict(segment=s, monetary=float(m), recency=rd, freq=f) for k, s, m, rd, f in
       q("SELECT customer_key, segment, monetary, recency_days, frequency FROM clothcraft_dss_segment WHERE run_id = %s", [RUN])}
rest = {r[0]: dict(zip(('sku', 'status', 'on_hand', 'reserved', 'free', 'incoming', 'daily', 'supplier', 'lead_days', 'p50', 'p90', 'alternatives', 'share', 'days_left', 'order_now', 'sbf'), r))
        for r in q("SELECT sku, status, on_hand, reserved, free, incoming, daily_demand, supplier, lead_days, lead_p50, lead_p90, alternatives, share, days_left, order_now, stockout_before_arrival "
                   "FROM clothcraft_dss_restock WHERE run_id = %s", [RUN])}
actual = collections.defaultdict(dict)
for level, key, week, units, cens in q("SELECT level, key, week_start, units, censored FROM clothcraft_dss_actual WHERE run_id = %s ORDER BY week_start", [RUN]):
    actual[(level, key)][week] = (float(units), bool(cens))
fc = collections.defaultdict(dict)
for level, key, h, yhat in q("SELECT level, key, h, yhat FROM clothcraft_dss_forecast WHERE run_id = %s", [RUN]):
    fc[(level, key)][h] = float(yhat)

OUT = []


def put(g, expected, got, ok, detail=''):
    OUT.append({'case_id': g['case_id'], 'scenario': g['scenario'], 'screen': g['screen'], 'subject': f"{g['subject_type']} {g['subject_key']}", 'metric': g['metric'],
                'expected': expected, 'actual': got, 'match': 'MATCH' if ok is True else ('NOT COMPARABLE' if ok is None else 'MISMATCH'), 'detail': detail})


def money_close(a, b, tol=0.05):
    return a is not None and abs(a - b) <= tol


def alert_for_order(csv_order):
    oid = orders[csv_order]['id']
    return next((a for a in alerts if a['kind'] == 'unpaid_bank_transfer' and str(a['key']) == str(oid)), None)


for g in GT:
    sc, view, st, key, metric, expected = g['scenario'], g['view'], g['subject_type'], g['subject_key'], g['metric'], g['expected']
    try:
        if st == 'month':
            h = health.get(key)
            got = None if h is None else h[metric]
            put(g, expected, got, h is not None and (got == int(float(expected)) if metric in ('closed_orders', 'closed_units') else money_close(got, float(expected))))
        elif st == 'trend':
            t = (SUMMARY.get('health') or {}).get('trend') or {}
            if metric == 'label':
                put(g, expected, t.get('label'), t.get('label') == expected)
            else:
                got = None if t.get('revenue_rel_slope') is None else round(t['revenue_rel_slope'] * 100, 2)
                put(g, expected, got, got is not None and abs(got - float(expected)) <= 0.05)
        elif st == 'run' and metric == 'scored_customers':
            put(g, expected, (STATUS.get('segments') or {}).get('scored'), (STATUS.get('segments') or {}).get('scored') == int(expected))
        elif st == 'run' and metric == 'no_completed_order':
            got = (STATUS.get('segments') or {}).get('no_completed_order')
            put(g, expected, got, got == int(expected))
        elif st == 'segment':
            got = sum(1 for v in seg.values() if v['segment'] == key)
            put(g, expected, got, got == int(expected))
        elif st == 'customer':
            s = seg.get(cust_key.get(key))
            if metric == 'segment':
                put(g, expected, None if s is None else s['segment'], s is not None and s['segment'] == expected, g['rule_or_tolerance'] if s is None or s['segment'] != expected else '')
            else:
                put(g, expected, None if s is None else s['monetary'], s is not None and money_close(s['monetary'], float(expected), 0.01))
        elif metric == 'unpaid_bank_transfer':
            a = alert_for_order(key)
            if expected == 'no alert':
                put(g, expected, 'no alert' if a is None else f"{a['band']};{a['severity']};{a['age']}", a is None, g['rule_or_tolerance'])
            else:
                band, sev, age = expected.split(';')
                got = None if a is None else f"{a['band']};{a['severity']};{round(a['age'], 1)}"
                put(g, expected, got or 'no alert', a is not None and a['band'] == band and a['severity'] == sev and abs(a['age'] - float(age)) <= 0.1)
        elif metric in ('restock_overdue', 'restock_supplier'):
            name = restock[key]['name']
            a = next((x for x in alerts if x['kind'] == metric and x['label'] == name), None)
            if metric == 'restock_overdue':
                days = expected.split(';')[1]
                put(g, expected, 'absent' if a is None else f"present;{int(a['age'])}", a is not None and int(a['age']) == int(days))
            else:
                put(g, expected, 'present' if a else 'absent', a is not None, '' if a is None else a['message'])
        elif metric in ('forecast_stockout', 'low_stock_risk'):
            a = next((x for x in alerts if x['kind'] == metric and x['label'] == key), None)
            r = rest[key]
            put(g, expected, 'present' if a else 'absent', a is not None,
                f"restock row: on hand {r['on_hand']}, reserved {r['reserved']}, free {r['free']}, INCOMING {r['incoming']} (open approved restocks), forecast {r['daily']} a day, status {r['status']}")
        elif metric == 'urgency':
            r = rest[key]
            put(g, expected, r['status'], r['status'] in ('order_now', 'stockout_before_arrival') or r['order_now'] or r['sbf'],
                f"free {r['free']} + incoming {r['incoming']} against {r['daily']} a day (safety stock, reorder point from the DSS row)")
        elif st == 'variant' and metric == 'on_hand':
            got = int(q("SELECT round(coalesce(sum(q.quantity), 0)) FROM stock_quant q JOIN stock_location l ON l.id = q.location_id AND l.usage = 'internal' JOIN product_product p ON p.id = q.product_id "
                        "WHERE p.default_code = %s", [key])[0][0])
            put(g, expected, got, got == int(expected))
        elif metric == 'low_variants':
            got = q("SELECT count(*) FROM clothcraft_stock_alert WHERE low")[0][0]
            put(g, expected, got, got == int(expected), 'the shop\'s own low-stock state (level 5)')
        elif st == 'supplier':
            name = SUPS[key]['name']
            chosen = [r for r in rest.values() if r['supplier'] == name]
            alts = [a for r in rest.values() for a in (js(r['alternatives']) or []) if a.get('supplier') == name]
            if metric == 'receipts':
                got = q("SELECT count(*) FROM clothcraft_restock r JOIN clothcraft_supplier s ON s.id = r.supplier_id WHERE r.state = 'received' AND s.name = %s", [name])[0][0]
                put(g, expected, got, got == int(expected))
            else:
                if chosen:
                    p50, p90, used = chosen[0]['p50'], chosen[0]['p90'], chosen[0]['lead_days']
                    how = f'from {len(chosen)} restock rows that recommend this supplier'
                elif alts:
                    p50, p90, used = None, alts[0].get('lead_p90'), None if alts[0].get('lead_p90') is None else math.ceil(alts[0]['lead_p90'])
                    how = 'this supplier is recommended for no variant (see the alternatives column); only its p90 is stored'
                else:
                    p50 = p90 = used = None
                    how = 'no restock row mentions this supplier'
                got = {'lead_p50_days': p50, 'lead_p90_days': p90, 'lead_days_used': used}[metric]
                if got is None:
                    put(g, expected, 'not stored', None, how)
                else:
                    put(g, expected, round(float(got), 2), abs(float(got) - float(expected)) <= (0.01 if metric == 'lead_days_used' else 0.1), how)
        elif metric.startswith('units_through'):
            if st == 'total':
                got = sum(u for w, (u, c) in actual[('total', 'total')].items())
            else:
                got = sum(u for w, (u, c) in actual[('product', tmpl[key])].items())
            put(g, expected, got, abs(got - float(expected)) < 0.01)
        elif metric == 'direction':
            weeks = sorted(actual[('product', tmpl[key])])
            units = [actual[('product', tmpl[key])][w][0] for w in weeks]
            f26, allm = sum(units[:26]) / 26.0, sum(units) / len(units)
            hs = fc[('product', tmpl[key])]
            fmean = sum(hs[h] for h in range(1, 9)) / 8.0
            ok = fmean >= 1.5 * f26 if expected == 'up' else (fmean <= 0.6 * f26 if expected == 'down' else 0.65 * allm <= fmean <= 1.35 * allm)
            put(g, expected, f'{expected if ok else "NOT " + expected}', ok, f'forecast mean of the next 8 weeks {fmean:.2f} a week; first-26-week mean {f26:.2f}; all-weeks mean {allm:.2f}; last-8-week mean {sum(units[-8:]) / 8:.2f}')
        elif st == 'product-week':
            slug, week = key.split(':')
            cell = actual[('product', tmpl[slug])].get(datetime.date.fromisoformat(week))
            got = None if cell is None else f"{str(cell[1]).lower()};{int(cell[0])}"
            put(g, expected, got, got == expected)
        elif st == 'state':
            got = q("SELECT count(*) FROM sale_order WHERE clothcraft_state = %s", [key])[0][0]
            put(g, expected, got, got == int(expected))
        elif st == 'kpi':
            if key == 'deliveredAwaiting':
                n, tot = q("SELECT count(*), coalesce(sum(amount_total), 0) FROM sale_order WHERE clothcraft_state = 'delivered'")[0]
                put(g, expected, n if metric == 'orders' else float(tot), (n == int(expected)) if metric == 'orders' else money_close(float(tot), float(expected), 0.01))
            else:
                tot = float(q("SELECT coalesce(sum(amount_total), 0) FROM sale_order WHERE clothcraft_state = 'closed'")[0][0])
                put(g, expected, tot, money_close(tot, float(expected), 0.01))
        elif metric == 'step_back_lines':
            got = q("SELECT count(*) FROM clothcraft_order_audit WHERE order_id = %s AND step_back", [orders[key]['id']])[0][0]
            put(g, expected, got, got == int(expected))
        elif metric == 'refund_due_note':
            got = (q("SELECT note FROM clothcraft_order_audit WHERE order_id = %s AND to_state = 'cancelled' ORDER BY id DESC LIMIT 1", [orders[key]['id']]) or [(None,)])[0][0]
            put(g, expected, got, got == expected)
        elif metric == 'shipped_lines':
            got = q("SELECT count(*) FROM clothcraft_order_audit WHERE order_id = %s AND to_state = 'shipped' AND from_state <> 'out_for_delivery'", [orders[key]['id']])[0][0]
            put(g, expected, got, got == int(expected))
        elif st == 'employee':
            got = 'active' if emp_user[key] else 'inactive'
            put(g, expected, got, got == expected)
        elif metric == 'employees_in_list':
            got = q("SELECT count(*) FROM res_users u WHERE NOT u.share AND u.id NOT IN (1, 2) AND EXISTS (SELECT 1 FROM res_groups_users_rel r JOIN ir_model_data d ON d.res_id = r.gid AND d.model = 'res.groups' "
                    "AND d.module = 'clothcraft' AND d.name IN ('group_inventory', 'group_admin') WHERE r.uid = u.id) AND NOT EXISTS (SELECT 1 FROM res_groups_users_rel r JOIN ir_model_data d ON d.res_id = r.gid "
                    "AND d.model = 'res.groups' AND d.name IN ('group_system', 'group_api') WHERE r.uid = u.id)")[0][0]
            put(g, expected, got, got == int(expected))
        elif metric == 'kind':
            put(g, expected, 'simulated' if _sim else 'real', not _sim)
        else:
            put(g, expected, '', None, 'no comparison written for this row')
    except Exception as error:
        put(g, expected, '', None, 'could not compare: %s: %s' % (type(error).__name__, str(error)[:120]))

# ---- report
local = os.environ.get('PACK_LOCAL') or os.path.join(PACK, '_local')
os.makedirs(local, exist_ok=True)
with open(os.path.join(local, 'p3_comparison.csv'), 'w', encoding='utf-8-sig', newline='') as handle:
    w = csv.DictWriter(handle, fieldnames=list(OUT[0]), lineterminator='\r\n')
    w.writeheader()
    w.writerows(OUT)
say('--- per scenario (match / mismatch / not comparable)')
by = collections.defaultdict(collections.Counter)
for r in OUT:
    by[r['scenario']][r['match']] += 1
total = collections.Counter()
for s in sorted(by):
    c = by[s]
    total.update(c)
    say(f"  {s}  {c['MATCH']:3} / {c['MISMATCH']:3} / {c['NOT COMPARABLE']:3}")
say(f"  all {total['MATCH']:3} / {total['MISMATCH']:3} / {total['NOT COMPARABLE']:3}   ({len(OUT)} ground-truth rows)")
say('--- every row that is not a MATCH')
for r in OUT:
    if r['match'] != 'MATCH':
        say(f"  {r['case_id']} {r['scenario']} {r['subject']} {r['metric']}: expected {r['expected']} | actual {r['actual']} | {r['match']} | {r['detail']}")

# ---- the run's alerts, the headline and the bias
say('--- the run\'s alerts')
for a in alerts:
    pack_id = odoo_order.get(int(a['key'])) if a['type'] == 'order' else a['label']
    say(f"  {a['severity']:8} {a['kind']:22} {a['band']:14} {pack_id}  age {a['age']}")
hl = q("SELECT (SELECT count(*) FROM clothcraft_dss_restock WHERE run_id = %s AND order_now), (SELECT count(*) FROM clothcraft_dss_alert WHERE run_id = %s AND severity = 'critical'), "
       "(SELECT count(*) FROM clothcraft_dss_alert WHERE run_id = %s AND severity = 'warning'), (SELECT count(*) FROM clothcraft_dss_alert WHERE run_id = %s AND severity = 'info')", [RUN] * 4)[0]
say('headline: order now %d, critical %d, warning %d, info %d' % hl)
say('--- forecast accuracy measured by the run (chosen method %s; backtest of the total)' % SELECTION.get('chosen'))
say('  selection: ' + json.dumps(SELECTION))
say('  %-10s %-9s %5s %8s %8s %8s %6s %6s' % ('horizon', 'weeks', 'n', 'mae', 'wape%', 'bias%', 'cov80', 'cov95'))
for hz, wk, n, mae, wape, bias, c80, c95 in q("SELECT horizon, weeks, n, mae, wape, bias, cov80, cov95 FROM clothcraft_dss_backtest WHERE run_id = %s AND level = 'total' AND chosen ORDER BY weeks, horizon", [RUN]):
    say('  %-10s %-9s %5s %8s %8s %8s %6s %6s' % (hz, wk, n, None if mae is None else round(float(mae), 2), None if wape is None else round(float(wape), 1), None if bias is None else round(float(bias), 1),
                                                   None if c80 is None else round(float(c80), 1), None if c95 is None else round(float(c95), 1)))
pb = [float(b) for (b,) in q("SELECT bias FROM clothcraft_dss_backtest WHERE run_id = %s AND level = 'product' AND chosen AND horizon = 'all' AND weeks = 'all' AND bias IS NOT NULL", [RUN])]
if pb:
    say('  per product (horizon all, all weeks): %d products, median bias %.1f %%, %d under-forecast (negative), %d over-forecast' % (len(pb), statistics.median(pb), sum(1 for b in pb if b < 0), sum(1 for b in pb if b > 0)))
cr.rollback()
say('done: nothing was written (read-only transaction)')
