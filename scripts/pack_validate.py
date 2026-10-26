#!/usr/bin/env python3
"""DSS scenario pack: validate the CSVs in testdata/dss-scenarios/ on their own (reads only the files; standard library only).

    python3 scripts/pack_validate.py

Checks file format (byte-order mark, CRLF, consistent columns, header), keys and foreign keys, duplicate ids, every order state reachable, time formats and
ranges, emails and phone numbers, no password-like column, working hours and roles of whoever acted, order and design arithmetic, and it REPLAYS THE STOCK
LEDGER from the CSVs alone: every order must fit the free stock when it is placed (what the shop's stock guard needs), no shipment may exceed what is on
hand, and every stock count must start from the quantity the ledger says. Exit status 1 if any check fails.
"""
import collections
import csv
import datetime as dt
import heapq
import importlib.util
import itertools
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.environ.get('PACK_DIR') or os.path.join(HERE, '..', 'testdata', 'dss-scenarios'))     # PACK_DIR: validate a copy (used to prove the checks can fail)
FEE_MODULE = os.path.normpath(os.path.join(HERE, '..', 'addons', 'clothcraft', 'design_fee.py'))
TZ = dt.timezone(dt.timedelta(hours=8))
TS = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$')
EMAIL = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')
PH_MOBILE = re.compile(r'^(09\d{9}|\+639\d{9})$')            # the service's own rule (backend/app/delivery.py)
FAKE_PHONE = re.compile(r'^0900 000 \d{4}$')
checks = []


def check(name, ok, detail=''):
    checks.append((name, bool(ok), detail))


def rows(name):
    with open(os.path.join(OUT, name), encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def when(text):
    return dt.datetime.fromisoformat(text)


def main():
    csv_files = sorted(os.path.relpath(os.path.join(d, f), OUT).replace(os.sep, '/') for d, _s, fs in os.walk(OUT) for f in fs if f.endswith('.csv'))
    # ---- format
    bad_bom, bad_eol, bad_cols, bad_head, quoted_nl = [], [], [], [], []
    for name in csv_files:
        raw = open(os.path.join(OUT, name), 'rb').read()
        if not raw.startswith(b'\xef\xbb\xbf'):
            bad_bom.append(name)
        text = raw.decode('utf-8-sig')
        if re.search(r'(?<!\r)\n', text):
            bad_eol.append(name)
        if not text.endswith('\r\n'):
            bad_eol.append(name + ' (no final CRLF)')
        with open(os.path.join(OUT, name), encoding='utf-8-sig', newline='') as handle:
            table = list(csv.reader(handle))
        width = len(table[0])
        if len(set(table[0])) != width or any(not h.strip() for h in table[0]):
            bad_head.append(name)
        if any(len(r) != width for r in table):
            bad_cols.append(name)
        if any('\n' in c or '\r' in c for r in table for c in r):
            quoted_nl.append(name)
        if re.search(r'pass|pwd|secret|token|api_?key', ','.join(table[0]), re.I):
            check(f'no password-like column: {name}', False)
    check(f'{len(csv_files)} CSV files start with a UTF-8 byte-order mark', not bad_bom, str(bad_bom))
    check('every line ends with CRLF (no bare LF)', not bad_eol, str(bad_eol))
    check('every row has as many columns as its header; headers unique', not bad_cols and not bad_head, str(bad_cols + bad_head))
    check('no cell contains a line break (Excel-safe)', not quoted_nl, str(quoted_nl))
    check('no password-like column in any file', all(c[1] for c in checks if c[0].startswith('no password-like column')) )

    employees, customers, orders, lines, events = rows('employees.csv'), rows('customers.csv'), rows('orders.csv'), rows('order_lines.csv'), rows('order_events.csv')
    payments, designs, layers = rows('payments.csv'), rows('designs.csv'), rows('design_layers.csv')
    restocks, rlines, receipts, adjustments = rows('restock_requests.csv'), rows('restock_lines.csv'), rows('receipts.csv'), rows('stock_adjustments.csv')
    variants = {v['sku']: v for v in rows('reference/variants.csv')}
    products = {p['slug']: p for p in rows('reference/products.csv')}
    supply = {(s['supplier_id'], s['garment_type'], s['size'], s['colour']) for s in rows('reference/supply_lines.csv')}
    baseline = rows('reference/baseline_orders.csv')
    gt = rows('ground_truth.csv')

    # ---- ids and keys
    def unique(name, items, key):
        keys = [key(i) for i in items]
        check(f'{name}: ids unique', len(keys) == len(set(keys)), f'{len(keys)} rows')
        return set(keys)
    emp_ids = unique('employees', employees, lambda r: r['employee_id'])
    cust_ids = unique('customers', customers, lambda r: r['customer_id'])
    order_ids = unique('orders', orders, lambda r: r['order_id'])
    unique('orders: client_order_ref', orders, lambda r: r['client_order_ref'])
    unique('order_lines: (order, line)', lines, lambda r: (r['order_id'], r['line_no']))
    unique('order_events', events, lambda r: r['event_id'])
    unique('payments: one per order', payments, lambda r: r['order_id'])
    design_ids = unique('designs', designs, lambda r: r['design_id'])
    restock_ids = unique('restock_requests', restocks, lambda r: r['restock_id'])
    unique('restock_lines: (restock, line)', rlines, lambda r: (r['restock_id'], r['line_no']))
    unique('stock_adjustments', adjustments, lambda r: r['adjustment_id'])
    unique('customers: email', customers, lambda r: r['email'].lower())
    unique('customers: phone', customers, lambda r: r['phone'])
    unique('ground_truth: case id', gt, lambda r: r['case_id'])
    check('foreign keys: orders -> customers', all(o['customer_id'] in cust_ids for o in orders))
    check('foreign keys: lines/events/payments -> orders', all(r['order_id'] in order_ids for r in lines + events + payments))
    check('foreign keys: every order has lines and a payment', {r['order_id'] for r in lines} == order_ids and {r['order_id'] for r in payments} == order_ids)
    check('foreign keys: skus exist in the catalogue', all(r['sku'] in variants for r in lines + rlines + receipts + adjustments))
    check('foreign keys: employees named in events, restocks, receipts, counts exist',
          all(r['employee_id'] in emp_ids for r in events if r['employee_id']) and all(a['employee_id'] in emp_ids for a in adjustments)
          and all(r[k] in emp_ids for r in restocks for k in ('requested_by', 'decided_by', 'not_received_by') if r[k]) and all(r['received_by'] in emp_ids for r in receipts))
    check('foreign keys: customers named in events exist', all(r['customer_id'] in cust_ids for r in events if r['customer_id']))
    check('foreign keys: designs -> orders/customers; order lines name existing designs', all(d['order_id'] in order_ids and d['customer_id'] in cust_ids for d in designs)
          and all(l['design_id'] in design_ids for l in lines if l['design_id']))
    check('foreign keys: restock lines/receipts -> restocks', all(r['restock_id'] in restock_ids for r in rlines + receipts))
    check('every restock line is a variant the supplier supplies', all((next(r['supplier_id'] for r in restocks if r['restock_id'] == l['restock_id']), variants[l['sku']]['slug'] and
                                                                         products[variants[l['sku']]['slug']]['garment_type'], variants[l['sku']]['size'], variants[l['sku']]['colour']) in supply
                                                                        for l in rlines))
    # ---- states
    reached = collections.Counter()
    for e in events:
        if e['expected_outcome'] == 'done':
            reached[e['to_state']] += 1
    initial = collections.Counter('awaiting_payment' if o['payment_method'] == 'bank_transfer' else 'confirmed' for o in orders)
    final = collections.Counter(o['final_state'] for o in orders)
    needed = ['awaiting_payment', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'closed', 'cancelled']
    check('every order state is reached (as a move or a start)', all(reached[s] or initial[s] for s in needed), f'moves into: {dict(reached)}; start: {dict(initial)}')
    check('every order state exists at the cutoff', all(final[s] for s in needed), str(dict(final)))
    check('closed by both the customer and the daily job', {o['closed_by'] for o in orders if o['final_state'] == 'closed'} == {'customer', 'automatic'})
    check('refused moves exist (two-staff conflict) and a back-step exists', any(e['expected_outcome'] == 'state_changed' for e in events) and any(e['step_back'] == 'yes' for e in events))
    check('a paid bank order cancelled by an Administrator exists (REFUND DUE)', any(p['recorded_by_or_note'].find('REFUND DUE') >= 0 for p in payments))
    check('designed orders exist', sum(1 for o in orders if o['designed'] == 'yes') >= 20, f"{sum(1 for o in orders if o['designed'] == 'yes')} designed orders")
    # ---- times
    ts_cols = [('customers.csv', ['registered_at']), ('orders.csv', ['placed_at']), ('order_events.csv', ['at']), ('payments.csv', ['paid_at']), ('designs.csv', ['created_at']),
               ('employees.csv', ['hired_at', 'left_at']), ('restock_requests.csv', ['requested_at', 'decided_at', 'not_received_at']), ('receipts.csv', ['received_at']),
               ('stock_adjustments.csv', ['at'])]
    bad_ts = []
    lo, hi = dt.datetime(2025, 9, 1, tzinfo=TZ), dt.datetime(2026, 10, 26, 9, 0, tzinfo=TZ)
    for name, cols in ts_cols:
        for r in rows(name):
            for c in cols:
                if r[c] and (not TS.match(r[c]) or not lo <= when(r[c]) <= hi):
                    bad_ts.append((name, c, r[c]))
    check('every timestamp is ISO 8601 with +08:00 and inside 2025-09 .. 2026-10-26 09:00', not bad_ts, str(bad_ts[:3]))
    by_order = collections.defaultdict(list)
    for e in events:
        by_order[e['order_id']].append(e)
    placed = {o['order_id']: when(o['placed_at']) for o in orders}
    bad_order = []
    for oid, evs in by_order.items():
        last = placed[oid]
        for e in sorted([x for x in evs if x['expected_outcome'] == 'done'], key=lambda x: when(x['at'])):
            if when(e['at']) <= last:
                bad_order.append(oid)
            last = when(e['at'])
    check('every order\'s moves come after its placement and in strictly increasing time', not bad_order, str(bad_order[:3]))
    first_order = {}
    for o in sorted(orders, key=lambda o: o['placed_at']):
        first_order.setdefault(o['customer_id'], o['placed_at'])
    check('every customer registered before their first order', all(c['registered_at'] < first_order[c['customer_id']] for c in customers if c['customer_id'] in first_order))
    registered_at = {c['customer_id']: c['registered_at'] for c in customers}
    placed_text = {o['order_id']: o['placed_at'] for o in orders}
    check('every design is uploaded after its customer registered and before its order is placed',
          all(registered_at[d['customer_id']] < d['created_at'] < placed_text[d['order_id']] for d in designs))
    # ---- people data
    check('emails: valid format, all @example.test', all(EMAIL.match(r['email']) and r['email'].endswith('@example.test') for r in customers + employees))
    check('phones: fake block 0900 000 xxxx and accepted by the service rule', all(FAKE_PHONE.match(c['phone']) and PH_MOBILE.match(c['phone'].replace(' ', '')) for c in customers))
    check('postal codes are 4 digits; provinces exist in the shop', all(re.fullmatch(r'\d{4}', c['delivery_postal_code']) for c in customers)
          and {c['delivery_province'] for c in customers} <= {p['code'] for p in rows('reference/provinces.csv')})
    check('employees: 5 active Inventory Staff + 1 archived, 2 Administrators',
          collections.Counter((e['role'], e['status_at_end']) for e in employees) == collections.Counter({('inventory', 'active'): 5, ('inventory', 'archived'): 1, ('admin', 'active'): 2}))
    check('customers: 112', len(customers) == 112)
    # ---- who acted, when
    emp = {e['employee_id']: e for e in employees}
    names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    def on_duty(e, t):
        a, b = e['work_days'].split('-')
        days = set(range(names.index(a), names.index(b) + 1))
        s, en = dt.time.fromisoformat(e['shift_start']), dt.time.fromisoformat(e['shift_end'])
        inside = s <= t.time() <= en
        late = dt.time(19, 0) <= t.time() <= dt.time(22, 30)
        left = when(e['left_at']) if e['left_at'] else None
        return t.weekday() in days and (inside or late) and when(e['hired_at']) <= t and (left is None or t < left), (not inside) and late

    acts = [(when(e['at']), e['employee_id'], 'order move') for e in events if e['employee_id']] + \
           [(when(r['requested_at']), r['requested_by'], 'restock request') for r in restocks] + \
           [(when(r['decided_at']), r['decided_by'], 'restock decision') for r in restocks if r['decided_at']] + \
           [(when(r['not_received_at']), r['not_received_by'], 'restock not received') for r in restocks if r['not_received_at']] + \
           [(when(r['received_at']), r['received_by'], 'receipt') for r in receipts] + [(when(a['at']), a['employee_id'], 'stock count') for a in adjustments]
    off = [(t.isoformat(), who, what) for t, who, what in acts if not on_duty(emp[who], t)[0]]
    # planted stock counts of S01 and S10 are fixed times; they are on duty too
    check(f'all {len(acts)} actions happen inside the actor\'s working days, hours (or a late evening) and employment', not off, str(off[:3]))
    late = sum(1 for t, who, _w in acts if on_duty(emp[who], t)[1])
    check('a few late-evening moves exist (under 10%)', 0 < late < 0.10 * len(acts), f'{late} of {len(acts)}')
    admin_only = [e for e in events if e['expected_outcome'] == 'done' and (e['step_back'] == 'yes' or (e['to_state'] == 'cancelled' and next(p for p in payments if p['order_id'] == e['order_id'])['paid_at']))]
    check('back-steps and cancels of paid orders are by Administrators', all(emp[e['employee_id']]['role'] == 'admin' for e in admin_only), f'{len(admin_only)} such moves')
    check('restock approvals, rejections and receipts are by Administrators; requests by Inventory Staff',
          all(emp[r['decided_by']]['role'] == 'admin' for r in restocks if r['decided_by']) and all(emp[r['received_by']]['role'] == 'admin' for r in receipts)
          and all(emp[r['requested_by']]['role'] == 'inventory' for r in restocks))
    check('the archived employee acts nothing after leaving', all(t < when(emp['E08']['left_at']) for t, who, _w in acts if who == 'E08'))
    # ---- arithmetic
    line_by_order = collections.defaultdict(float)
    for l in lines:
        line_by_order[l['order_id']] += float(l['line_total'])
        v = variants[l['sku']]
        okp = abs(float(l['unit_price']) - float(v['unit_price'])) < 0.005 and abs(float(l['line_total']) - (float(l['unit_price']) + (float(l['print_fee_each']) if l['design_id'] else 0)) * int(l['quantity'])) < 0.005
        if not okp:
            check('order line arithmetic', False, str(l))
            break
    check('every order total equals the sum of its lines', all(abs(line_by_order[o['order_id']] - float(o['expected_amount_total'])) < 0.005 for o in orders))
    spec = importlib.util.spec_from_file_location('design_fee', FEE_MODULE)
    fee = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fee)
    settings = rows('reference/design_settings.csv')[0]
    bad_fee = []
    for d in designs:
        prod = products[d['slug']]
        box = {'x': float(prod['print_x']), 'y': float(prod['print_y']), 'width': float(prod['print_w']), 'height': float(prod['print_h'])}
        els = [{'x': float(l['x']), 'y': float(l['y']), 'width': float(l['width']), 'height': float(l['height']), 'rotation': float(l['rotation']), 'opacity': float(l['opacity']), 'visible': True}
               for l in layers if l['design_id'] == d['design_id']]
        price = fee.price(els, box, float(prod['reference_sq_in']), float(settings['rate_per_sq_in']), float(settings['size_step']), variants[d['sku']]['size'])
        if abs(price['fee'] - float(d['print_fee_each'])) > 0.005 or len(els) != int(d['layer_count']):
            bad_fee.append(d['design_id'])
    check('every design fee recomputes from its layers with the shop\'s fee module', not bad_fee, str(bad_fee[:3]))
    check('a designed line is one garment and sits on a designable product', all(int(l['quantity']) == 1 and products[variants[l['sku']]['slug']]['designable'] == 'yes' for l in lines if l['design_id']))
    # ---- the stock ledger replay (what the shop's stock guard sees)
    onhand = {s: int(v['opening_units']) for s, v in variants.items()}
    reserved = collections.Counter()
    heap, seq = [], itertools.count()
    order_lines = collections.defaultdict(list)
    for l in lines:
        order_lines[l['order_id']].append((l['sku'], int(l['quantity'])))
    for o in orders:
        heapq.heappush(heap, (when(o['placed_at']), 3, next(seq), 'place', o['order_id']))
    for e in events:
        if e['expected_outcome'] == 'done' and e['to_state'] == 'shipped' and e['from_state'] != 'out_for_delivery':
            heapq.heappush(heap, (when(e['at']), 2, next(seq), 'ship', e['order_id']))
        if e['expected_outcome'] == 'done' and e['to_state'] == 'cancelled':
            heapq.heappush(heap, (when(e['at']), 2, next(seq), 'cancel', e['order_id']))
    for r in receipts:
        heapq.heappush(heap, (when(r['received_at']), 1, next(seq), 'receipt', (r['sku'], int(r['quantity_received']))))
    for a in adjustments:
        heapq.heappush(heap, (when(a['at']), 0, next(seq), 'count', a))
    for b in baseline:
        for part in b['garment_lines'].split():
            sku, n = part.rsplit('x', 1)
            heapq.heappush(heap, (dt.datetime(2026, 10, 24, 12 if b['order'] == 'S00001' else 19, 30, tzinfo=TZ), 2, next(seq), 'base', (sku, int(n))))
    problems = []
    placements = 0
    while heap:
        t, _p, _n, kind, ref = heapq.heappop(heap)
        if kind == 'place':
            placements += 1
            for sku, q in order_lines[ref]:
                if onhand[sku] - reserved[sku] < q:
                    problems.append(f'{ref} {sku} wants {q}, free {onhand[sku] - reserved[sku]}')
                reserved[sku] += q
        elif kind == 'ship':
            for sku, q in order_lines[ref]:
                onhand[sku] -= q
                reserved[sku] -= q
                if onhand[sku] < 0 or reserved[sku] < 0:
                    problems.append(f'{ref} shipping {sku} leaves {onhand[sku]} on hand')
        elif kind == 'cancel':
            for sku, q in order_lines[ref]:
                reserved[sku] -= q
        elif kind == 'receipt':
            onhand[ref[0]] += ref[1]
        elif kind == 'base':
            onhand[ref[0]] -= ref[1]
        elif kind == 'count':
            if int(ref['old_quantity']) != onhand[ref['sku']]:
                problems.append(f"{ref['adjustment_id']} says old {ref['old_quantity']}, ledger {onhand[ref['sku']]}")
            if int(ref['new_quantity']) < reserved[ref['sku']] or int(ref['new_quantity']) == onhand[ref['sku']]:
                problems.append(f"{ref['adjustment_id']} new {ref['new_quantity']} is below reserved or unchanged")
            onhand[ref['sku']] = int(ref['new_quantity'])
    check(f'ledger replay: all {placements} orders fit the free stock when placed; nothing ships beyond what is on hand; every count starts from the ledger', not problems, str(problems[:3]))
    check('ledger replay: nothing ends negative', min(onhand.values()) >= 0, f'end on hand {sum(onhand.values())} units, lowest {min(onhand.values())}')
    # ---- restocks
    check('restock expected ranges end on or after they start and span at most 90 days', all(0 <= (dt.date.fromisoformat(r['expected_to']) - dt.date.fromisoformat(r['expected_from'])).days <= 90 for r in restocks))
    check('received_on is never in the future of the receipt entry', all(r['received_on'] <= r['received_at'][:10] for r in receipts))
    check('a restock outcome of "received" has receipts; others have none', {r['restock_id'] for r in restocks if r['outcome'] == 'received'} == {r['restock_id'] for r in receipts})
    check('ground truth: every row has a scenario, a screen, a metric and an expected value', all(g['scenario'] and g['screen'] and g['metric'] and g['expected'] != '' for g in gt), f'{len(gt)} rows')
    report()


def report():
    failed = 0
    for name, ok, detail in checks:
        failed += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'   [{detail[:150]}]' if detail and (not ok or len(detail) < 150) else ''))
    print(f'\n{len(checks) - failed} of {len(checks)} checks passed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:        # bad data can trip a later check: still say what was found, and that the run did not finish
        check('the validation ran to the end', False, f'{type(error).__name__}: {error}')
        report()
