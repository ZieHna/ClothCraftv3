# DSS scenario pack, slice P2: the loader. Runs INSIDE `odoo shell` (see testdata/dss-scenarios/RUNBOOK.md and scripts/pack_run.ps1):
#
#   PACK_MODE=dryrun|selftest|load|check|undo_d1   (default dryrun)      PACK_DIR=/mnt/pack (the folder testdata/dss-scenarios, mounted)
#
# It replays the pack's CSV events, in time order, through the shop's REAL facade methods (clothcraft.api: register, quote, place order, staff moves, customer
# confirmation, restocks, receipts, stock counts, employees), as the API service user, each event inside its own frozen clock (T1: freezegun for Odoo's clock AND
# cr._now, the transaction time the ORM stamps create_date / write_date with), with a fresh session started a minute before it. The stock guard is never bypassed:
# a refusal is logged, never forced. Accepted databases: clothcraft_pack_20261026, clothcraft_shop (writes only with PACK_ALLOW_SHOP, see below) and rehearsal
# copies clothcraft_shop_<name>; a database with the simulation marker is refused.
# This file is plain ASCII on purpose (it is piped through Windows shells).
import base64
import collections
import csv
import datetime
import hashlib
import heapq
import io
import itertools
import json
import os
import re
import secrets
import time
import traceback

from freezegun import freeze_time
from PIL import Image

TARGET_DB = 'clothcraft_pack_20261026'
PACK = os.environ.get('PACK_DIR', '/mnt/pack')
MODE = os.environ.get('PACK_MODE', 'dryrun')
MARKER = 'clothcraft.scenario_pack'
SIM_MARKER = 'clothcraft.sim.marker'
UTC = datetime.timezone.utc
MINUTE = datetime.timedelta(minutes=1)
LOG = []                    # one row per event: (n, kind, ref, at, status, expected, ok, seconds, note)
FAILS = []                  # unexpected results, in the order they happened
T_START = time.time()


def say(*parts):
    print('PACK', *parts, flush=True)


def die(message):
    say('STOP:', message)
    env.cr.rollback()
    raise SystemExit(1)


def rows(name):
    with open(os.path.join(PACK, name), encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def utc(text):
    """An ISO time with +08:00 -> the naive UTC datetime Odoo stores."""
    return datetime.datetime.fromisoformat(text).astimezone(UTC).replace(tzinfo=None)


def sha(path):
    with open(path, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


cr = env.cr
# Which databases may be loaded (F4, integration into the shop): the pack database, the shop itself, and a rehearsal copy of the shop named clothcraft_shop_<name>.
# The shop is the real development database, so writing to it (selftest, load, undo_d1) needs PACK_ALLOW_SHOP set to the word below: the wrapper that sets it
# is run only after a verified backup. Dry run and check only read.
SHOP_DB = 'clothcraft_shop'
REHEARSAL = re.compile(r'clothcraft_shop_[a-z0-9]+')
ALLOW_WORD = 'I_HAVE_A_VERIFIED_BACKUP'
IS_SHOP = cr.dbname == SHOP_DB
if not (cr.dbname == TARGET_DB or IS_SHOP or REHEARSAL.fullmatch(cr.dbname)):
    die('this loader only works on %s, %s or a rehearsal copy clothcraft_shop_<name> (this is %s)' % (TARGET_DB, SHOP_DB, cr.dbname))
if MODE not in ('dryrun', 'selftest', 'load', 'check', 'undo_d1'):
    die('PACK_MODE must be dryrun, selftest, load, check or undo_d1')
if IS_SHOP and MODE in ('selftest', 'load', 'undo_d1') and os.environ.get('PACK_ALLOW_SHOP') != ALLOW_WORD:
    die('%s writes to the real shop database %s: set PACK_ALLOW_SHOP=%s only after the backups are verified' % (MODE, SHOP_DB, ALLOW_WORD))
params = env['ir.config_parameter'].sudo()
ORIGINAL_AUTO_CLOSE = params.get_param('clothcraft.auto_close_days', '7')
if params.get_param(SIM_MARKER, False):
    die('this database carries the simulation marker (%s): the pack must be loaded into a REAL database' % SIM_MARKER)

cr.execute("SELECT u.id FROM res_users u JOIN res_groups_users_rel r ON r.uid = u.id JOIN ir_model_data d ON d.res_id = r.gid AND d.model = 'res.groups' "
           "AND d.module = 'clothcraft' AND d.name = 'group_api' WHERE u.active ORDER BY u.id LIMIT 1")
API_UID = cr.fetchone()[0]
API = env(user=API_UID)['clothcraft.api']            # the service user, as the real API calls it
ROOT_ENV = env


# ------------------------------------------------------------------------------------------------------------------------ the pack files
def integrity():
    """The files must be the ones the generator wrote: every SHA-256 in manifest.csv, and the recorded ground_truth hash."""
    bad = []
    for r in rows('manifest.csv'):
        if sha(os.path.join(PACK, r['file'])) != r['sha256']:
            bad.append(r['file'])
    recorded = open(os.path.join(PACK, 'ground_truth.sha256'), encoding='utf-8').read().split()[0]
    if sha(os.path.join(PACK, 'ground_truth.csv')) != recorded:
        bad.append('ground_truth.csv (recorded hash)')
    return bad, sha(os.path.join(PACK, 'manifest.csv'))[:16]


EMPS, CUSTS, ORDERS = rows('employees.csv'), rows('customers.csv'), rows('orders.csv')
LINES, EVENTS, DESIGNS, LAYERS = rows('order_lines.csv'), rows('order_events.csv'), rows('designs.csv'), rows('design_layers.csv')
SUPS, RESTOCKS, RLINES = rows('suppliers.csv'), rows('restock_requests.csv'), rows('restock_lines.csv')
RECEIPTS, COUNTS = rows('receipts.csv'), rows('stock_adjustments.csv')
VARIANTS = {v['sku']: v for v in rows('reference/variants.csv')}
BASELINE = rows('reference/baseline_orders.csv')
OPENING = {s: int(v['opening_units']) for s, v in VARIANTS.items()}


def ledger_from_csv():
    """The stock ledger replayed from the CSVs alone (what the stock guard will see): (problems, end on hand per sku, placements)."""
    onhand = dict(OPENING)
    reserved = collections.Counter()
    order_lines = collections.defaultdict(list)
    for l in LINES:
        order_lines[l['order_id']].append((l['sku'], int(l['quantity'])))
    heap, seq = [], itertools.count()
    for o in ORDERS:
        heapq.heappush(heap, (utc(o['placed_at']), 3, next(seq), 'place', o['order_id']))
    for e in EVENTS:
        if e['expected_outcome'] == 'done' and e['to_state'] == 'shipped' and e['from_state'] != 'out_for_delivery':
            heapq.heappush(heap, (utc(e['at']), 2, next(seq), 'ship', e['order_id']))
        if e['expected_outcome'] == 'done' and e['to_state'] == 'cancelled':
            heapq.heappush(heap, (utc(e['at']), 2, next(seq), 'cancel', e['order_id']))
    for r in RECEIPTS:
        heapq.heappush(heap, (utc(r['received_at']), 1, next(seq), 'receipt', (r['sku'], int(r['quantity_received']))))
    for a in COUNTS:
        heapq.heappush(heap, (utc(a['at']), 0, next(seq), 'count', a))
    for b in BASELINE:
        for part in b['garment_lines'].split():
            sku, n = part.rsplit('x', 1)
            heapq.heappush(heap, (utc('2026-10-24T%s:30:00+08:00' % ('12' if b['order'] == 'S00001' else '19')), 2, next(seq), 'base', (sku, int(n))))
    problems, placements = [], 0
    while heap:
        _t, _p, _n, kind, ref = heapq.heappop(heap)
        if kind == 'place':
            placements += 1
            for sku, q in order_lines[ref]:
                if onhand[sku] - reserved[sku] < q:
                    problems.append('%s %s wants %s, free %s' % (ref, sku, q, onhand[sku] - reserved[sku]))
                reserved[sku] += q
        elif kind == 'ship':
            for sku, q in order_lines[ref]:
                onhand[sku] -= q
                reserved[sku] -= q
        elif kind == 'cancel':
            for sku, q in order_lines[ref]:
                reserved[sku] -= q
        elif kind == 'receipt':
            onhand[ref[0]] += ref[1]
        elif kind == 'base':
            onhand[ref[0]] -= ref[1]
        elif kind == 'count':
            if int(ref['old_quantity']) != onhand[ref['sku']]:
                problems.append('%s says old %s, ledger %s' % (ref['adjustment_id'], ref['old_quantity'], onhand[ref['sku']]))
            onhand[ref['sku']] = int(ref['new_quantity'])
    return problems, onhand, placements


# ------------------------------------------------------------------------------------------------------------------------ the database
def db_facts():
    cr.execute("SELECT name, state, latest_version FROM ir_module_module WHERE name IN ('clothcraft', 'clothcraft_dss') ORDER BY name")
    mods = {n: (s, v) for n, s, v in cr.fetchall()}
    cr.execute("SELECT o.name, o.amount_total FROM sale_order o ORDER BY o.id")
    orders = cr.fetchall()
    cr.execute("""SELECT pp.default_code, round(coalesce(sum(q.quantity) FILTER (WHERE l.id IS NOT NULL), 0)) FROM product_product pp LEFT JOIN stock_quant q ON q.product_id = pp.id
                  LEFT JOIN stock_location l ON l.id = q.location_id AND l.usage = 'internal' WHERE pp.active AND pp.default_code IS NOT NULL GROUP BY 1""")
    stock = {sku: int(q) for sku, q in cr.fetchall()}
    cr.execute("""SELECT count(*), min(m.date), max(m.date) FROM stock_move m JOIN stock_location ls ON ls.id = m.location_id JOIN stock_location ld ON ld.id = m.location_dest_id
                  WHERE m.state = 'done' AND ls.usage = 'inventory' AND ld.usage = 'internal' AND m.date >= '2026-10-23' AND m.date < '2026-10-25'""")
    seed = cr.fetchone()
    cr.execute("SELECT value FROM ir_config_parameter WHERE key = %s", [MARKER])
    marker = cr.fetchone()
    return mods, orders, stock, seed, marker[0] if marker else None


def check(name, ok, detail=''):
    say(('PASS ' if ok else 'FAIL ') + name + (('  [' + str(detail)[:230] + ']') if detail != '' else ''))
    return ok


def pre_checks(for_load):
    """Everything that can be known without writing. Returns True when all pass."""
    good = True
    bad, pack_hash = integrity()
    good &= check('the pack files match manifest.csv and the recorded ground_truth hash (pack %s)' % pack_hash, not bad, bad)
    mods, orders, stock, seed, marker = db_facts()
    good &= check('modules: clothcraft and clothcraft_dss installed', all(mods.get(m, ('', ''))[0] == 'installed' for m in ('clothcraft', 'clothcraft_dss')), mods)
    good &= check('the database is the shop baseline: the two shop test orders and nothing else', [o[0] for o in orders] == ['S00001', 'S00002'], orders)
    want = {s: OPENING[s] - int(VARIANTS[s]['baseline_sold_units']) for s in OPENING}
    diff = {s: (stock.get(s), want[s]) for s in want if stock.get(s) != want[s]}
    good &= check('opening stock in the database equals the CSV (246 variants)', not diff, list(diff.items())[:3])
    if for_load:
        good &= check('no pack marker yet (a second load is refused)', marker is None, marker)
    else:
        say('INFO pack marker in the database:', marker or 'none (not loaded)')
    good &= check('the 243 seed moves are still dated 23 October 2026 (re-dated by the load)' if marker is None else 'the seed moves (already handled by the load)',
                  (seed[0] == 243) if marker is None else True, seed)
    cr.execute("SELECT count(*) FROM sale_order WHERE client_order_ref LIKE '%:pack:O%'")
    good &= check('no pack order is in the database yet (client_order_ref ...:pack:O...)', cr.fetchone()[0] == 0 if marker is None else True)
    cr.execute('SELECT count(*) FROM clothcraft_restock')
    n_restocks = cr.fetchone()[0]
    good &= check('no restock exists yet (the pack starts the restock history)', n_restocks == 0 if marker is None else True, n_restocks)
    cr.execute("SELECT count(*) FROM clothcraft_supplier WHERE name = ANY(%s)", [[s['name'] for s in SUPS]])
    good &= check('the 3 suppliers exist by exact name', cr.fetchone()[0] == 3)
    cr.execute("SELECT code FROM res_country_state WHERE country_id = (SELECT id FROM res_country WHERE code = 'PH')")
    codes = {c for (c,) in cr.fetchall()}
    good &= check('every delivery province code exists', {c['delivery_province'] for c in CUSTS} <= codes)
    emails = [e['email'] for e in EMPS] + [c['email'] for c in CUSTS]
    cr.execute("SELECT count(*) FROM res_users WHERE lower(login) = ANY(%s)", [[e.lower() for e in emails]])
    n_used = cr.fetchone()[0]
    good &= check('no employee or customer email is used yet', n_used == 0 if marker is None else True, n_used)
    cr.execute("SELECT c.nextcall AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila' FROM ir_cron c WHERE c.cron_name ILIKE %s", ['%close delivered orders%'])
    row = cr.fetchone()
    say('INFO daily close job runs at', row[0].time().isoformat(timespec='minutes') if row else 'not found', 'Manila (the pack assumes 10:38)')
    days = params.get_param('clothcraft.auto_close_days', '7')
    good &= check('auto-close is 7 days during the replay (it is set to 0 afterwards)', days in ('7', '0') if marker else days == '7', days)
    problems, end, placements = ledger_from_csv()
    good &= check('ledger replay from the CSVs: all %d orders fit the free stock; every count starts from the ledger' % placements, not problems, problems[:2])
    say('INFO ledger end on hand from the CSVs:', sum(end.values()), 'units')
    ids = [o['order_id'] for o in ORDERS]
    cust_ids = {c['customer_id'] for c in CUSTS}
    emp_ids = {e['employee_id'] for e in EMPS}
    keys_ok = len(ids) == len(set(ids)) and all(o['customer_id'] in cust_ids for o in ORDERS) and all(l['order_id'] in set(ids) and l['sku'] in VARIANTS for l in LINES) \
        and all(e['order_id'] in set(ids) and (not e['employee_id'] or e['employee_id'] in emp_ids) for e in EVENTS) and all(c['employee_id'] in emp_ids and c['sku'] in VARIANTS for c in COUNTS)
    good &= check('keys: orders, lines, events, counts, employees, customers all resolve', keys_ok)
    say('INFO events to replay:', len(EVENTS), 'moves,', len(ORDERS), 'orders,', len(CUSTS), 'customers,', len(EMPS), 'employees,', len(RESTOCKS), 'restocks,', len(COUNTS), 'counts,',
        len(DESIGNS), 'designs; the load takes about %d minutes (measured: 0.4 s an event)' % round((len(EVENTS) + len(ORDERS) + len(CUSTS) + len(EMPS) + 3 * len(RESTOCKS) + len(COUNTS) + len(DESIGNS)) * 0.42 / 60))
    accounts_dir = os.path.join(PACK, '_local')
    ignore = os.path.join(PACK, '.gitignore')
    good &= check('_local/ is covered by testdata/dss-scenarios/.gitignore (the sign-in passwords go there)', os.path.exists(ignore) and '_local/' in open(ignore).read())
    return good, pack_hash


# ------------------------------------------------------------------------------------------------------------------------ T1 helpers
SID = itertools.count(1)


def in_event(when, fn, commit=False):
    """Run fn inside ONE frozen event. when = naive UTC datetime: Odoo's clock (freezegun) and the transaction time cr._now are both `when`. None = real time."""
    if when is None:
        cr._now = None
        result = fn()
    else:
        cr._now = when
        with freeze_time(when):
            result = fn()
    env.flush_all()
    if commit:
        cr.commit()
    return result


def start_session(uid, scope, when):
    """A fresh session, created one minute before the event (so none ever idles out in the replay). Returns its id hash."""
    sid = 'pk-%07d' % next(SID)
    in_event(None if when is None else when - MINUTE, lambda: API._api_start_session(env['res.users'].browse(uid), sid, scope=scope))
    return sid


def call(method, payload, sid, scope=None):
    a = API.with_context(clothcraft_scope=scope) if scope else API
    return getattr(a, method)({**payload, 'sid_hash': sid})


def user_id(login):
    cr.execute("SELECT id FROM res_users WHERE lower(login) = %s", [login.lower()])
    row = cr.fetchone()
    return row[0] if row else None


def sequences():
    cr.execute("SELECT schemaname || '.' || sequencename, last_value, start_value FROM pg_sequences WHERE schemaname = 'public'")
    return {n: (last, start) for n, last, start in cr.fetchall()}


def restore_sequences(before):
    cr.execute("SELECT schemaname || '.' || sequencename, last_value FROM pg_sequences WHERE schemaname = 'public'")
    for name, last in cr.fetchall():
        old_last, start = before.get(name, (None, 1))
        if old_last != last:
            cr.execute("SELECT setval(%s, %s, %s)", [name, start if old_last is None else old_last, old_last is not None])


# ------------------------------------------------------------------------------------------------------------------------ the self-test
def table_rows(table, where, params_, skip):
    cr.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = %s ORDER BY ordinal_position", [table])
    cols = [c for (c,) in cr.fetchall() if c not in skip]
    cr.execute('SELECT %s FROM %s WHERE %s ORDER BY id' % (', '.join(cols), table, where), params_)
    return cols, cr.fetchall()


def selftest():
    """History rows written under T1 must match real ones column for column (the three append-only histories the pack writes through). Everything runs in ONE
    transaction that is rolled back, and the sequences are put back, so the database is exactly as it was. Returns True when every comparison holds."""
    seq_before = sequences()
    cr.execute("SELECT (SELECT count(*) FROM sale_order), (SELECT count(*) FROM clothcraft_order_audit), (SELECT count(*) FROM res_users), (SELECT count(*) FROM clothcraft_restock)")
    counts_before = cr.fetchone()
    ok = True
    try:
        cr.execute("""SELECT u.id, string_agg(d.name, ',') FROM res_users u JOIN res_groups_users_rel r ON r.uid = u.id JOIN ir_model_data d ON d.res_id = r.gid AND d.model = 'res.groups'
                      AND d.module = 'clothcraft' AND d.name IN ('group_inventory', 'group_admin') WHERE u.active AND NOT u.share AND u.id > 2 GROUP BY u.id ORDER BY u.id""")
        staff = {uid: names for uid, names in cr.fetchall()}
        inv = next((u for u, n in staff.items() if 'group_admin' not in n), None)
        adm = next((u for u, n in staff.items() if 'group_admin' in n), None)
        if not inv or not adm:
            say('FAIL self-test needs the shop test staff accounts (one Inventory Staff, one Administrator): found', staff)
            return False
        skus = []
        cr.execute("""SELECT pp.default_code FROM product_product pp JOIN stock_quant q ON q.product_id = pp.id JOIN stock_location l ON l.id = q.location_id AND l.usage = 'internal'
                      WHERE pp.active AND pp.default_code LIKE %s GROUP BY 1 HAVING sum(q.quantity) >= 8 ORDER BY 1 LIMIT 6""", ['%TEE%'])
        skus = [r[0] for r in cr.fetchall()]
        delivery = {'name': 'Self Test', 'phone': '0900 000 9999', 'street': '1 Test Street', 'city': 'Quezon City', 'province': 'PH-00', 'postal_code': '1100', 'note': ''}

        def lifecycle(tag, frozen, sku, bank=False, cancel=False):
            t = lambda d, h, m: datetime.datetime(2025, 10, 3 + d, h, m) if frozen else None
            email = 'selftest.%s@example.test' % tag
            reg = in_event(t(0, 1, 0), lambda: API.auth_register({'name': 'Self Test ' + tag, 'email': email, 'password': secrets.token_urlsafe(18) + 'aA1!', 'sid_hash': 'pk-reg-' + tag,
                                                                  'client_ip': '10.1.1.%d' % (1 if frozen else 2)}))
            assert reg['status'] == 'created', reg
            cust = reg['user']['id']
            sid = start_session(cust, 'customer', t(0, 2, 15))
            lines = [{'sku': sku, 'quantity': 1}]
            quote = in_event(t(0, 2, 15), lambda: API.quote(lines, sid))
            placed = in_event(t(0, 2, 15), lambda: API.place_order({'sid_hash': sid, 'lines': lines, 'delivery': {**delivery, 'email': email}, 'payment_method': 'bank_transfer' if bank else 'cod',
                                                                    'quoted_total': quote['amount_total'], 'idempotency_key': 'selftest-' + tag}))
            assert placed['status'] == 'created', placed
            oid = placed['order']['id']

            def mv(to, expected, d, h, m, who, scope, note=''):
                s = start_session(who, scope, t(d, h, m))
                r = in_event(t(d, h, m), lambda: call('staff_transition', {'order_id': oid, 'to': to, 'expected_state': expected, 'note': note}, s, scope))
                assert r['status'] == 'done', (to, r)
            if bank:
                mv('confirmed', 'awaiting_payment', 0, 4, 0, inv, 'staff')
            if cancel:
                mv('cancelled', 'confirmed', 1, 3, 0, adm, 'admin', note='Self-test cancel; refund to be arranged')
                return oid
            mv('shipped', 'confirmed', 1, 2, 30, inv, 'staff')
            mv('out_for_delivery', 'shipped', 1, 5, 0, inv, 'staff')
            mv('delivered', 'out_for_delivery', 2, 3, 0, inv, 'staff')
            s = start_session(cust, 'customer', t(3, 12, 15))
            r = in_event(t(3, 12, 15), lambda: API.order_confirm_received({'sid_hash': s, 'order_id': oid}))
            assert r['status'] == 'ok', r
            return oid
        skip = {'id', 'order_id', 'create_date', 'write_date', 'partner_id', 'staff_id', 'partner_name'}
        pairs = [('cash order, shipped to closed by the customer', dict(bank=False, cancel=False)), ('paid bank order cancelled by an Administrator (REFUND DUE)', dict(bank=True, cancel=True))]
        for n, (label, kw) in enumerate(pairs):
            o1 = lifecycle('t%d' % n, True, skus[2 * n], **kw)
            o2 = lifecycle('c%d' % n, False, skus[2 * n + 1], **kw)
            c1, r1 = table_rows('clothcraft_order_audit', 'order_id = %s', [o1], skip)
            c2, r2 = table_rows('clothcraft_order_audit', 'order_id = %s', [o2], skip)
            same = r1 == r2 and len(r1) > 0
            ok &= check('order history rows under T1 equal real ones, every column but id/time/customer (%s): %d rows x %d columns' % (label, len(r1), len(c1)), same,
                        '' if same else [(c, x, y) for a, b in zip(r1, r2) for c, x, y in zip(c1, a, b) if x != y][:2])
            cr.execute("SELECT count(*) FROM clothcraft_order_audit WHERE order_id = %s AND (create_date <> write_date OR create_date < '2025-10-03' OR create_date > '2025-10-07')", [o1])
            ok &= check('...and their create_date and write_date are the frozen event times (%s)' % label, cr.fetchone()[0] == 0)
        # restock: request, approve, receive
        r0 = RESTOCKS[0]
        sup_id = None
        cr.execute("SELECT id FROM clothcraft_supplier WHERE name = %s", [next(s['name'] for s in SUPS if s['supplier_id'] == r0['supplier_id'])])
        sup_id = cr.fetchone()[0]
        cr.execute("SELECT default_code, id FROM product_product WHERE default_code = ANY(%s)", [[l['sku'] for l in RLINES if l['restock_id'] == r0['restock_id']]])
        ids = dict(cr.fetchall())
        rs_lines = [{'product_id': ids[l['sku']], 'quantity': 2} for l in RLINES if l['restock_id'] == r0['restock_id']]

        def restock_flow(tag, frozen):
            t = lambda d, h, m: datetime.datetime(2025, 11, 4 + d, h, m) if frozen else None
            s1 = start_session(inv, 'staff', t(0, 2, 0))
            cr.execute("SELECT (now() AT TIME ZONE 'Asia/Manila')::date")
            today = cr.fetchone()[0]
            exp_from, exp_to = ('2025-11-10', '2025-11-12') if frozen else ((today + datetime.timedelta(days=6)).isoformat(), (today + datetime.timedelta(days=8)).isoformat())
            made = in_event(t(0, 2, 0), lambda: call('restock_create', {'supplier_id': sup_id, 'lines': rs_lines, 'shipping_on': False, 'expected_from': exp_from, 'expected_to': exp_to,
                                                                       'request_note': 'Self test ' + tag}, s1, 'staff'))
            assert made['status'] == 'done', made
            rid = made['restock']['id']
            s2 = start_session(adm, 'admin', t(1, 3, 0))
            assert in_event(t(1, 3, 0), lambda: call('restock_approve', {'restock_id': rid, 'note': 'ok'}, s2, 'admin'))['status'] == 'done'
            s3 = start_session(adm, 'admin', t(7, 6, 30))
            got = in_event(t(7, 6, 30), lambda: call('restock_receive', {'restock_id': rid, **({'received_on': '2025-11-11'} if frozen else {}), 'lots': {str(l['id']): 'ST-%s-%s' % (tag, l['sku']) for l in made['restock']['lines']}}, s3, 'admin'))
            assert got['status'] == 'done', got
            return rid
        a, b = restock_flow('t', True), restock_flow('c', False)
        c1, r1 = table_rows('clothcraft_restock_history', 'restock_id = %s', [a], {'id', 'create_date', 'write_date', 'restock_id'})
        c2, r2 = table_rows('clothcraft_restock_history', 'restock_id = %s', [b], {'id', 'create_date', 'write_date', 'restock_id'})
        ok &= check('restock history rows under T1 equal real ones: %d rows x %d columns' % (len(r1), len(c1)), r1 == r2 and len(r1) == 3)
        cr.execute("SELECT count(*) FROM clothcraft_restock_history WHERE restock_id = %s AND create_date <> write_date", [a])
        cr.execute("SELECT min(create_date), max(create_date) FROM clothcraft_restock_history WHERE restock_id = %s", [a])
        lo, hi = cr.fetchone()
        ok &= check('...with the frozen event times (request, approval, receipt)', lo == datetime.datetime(2025, 11, 4, 2, 0) and hi == datetime.datetime(2025, 11, 11, 6, 30), (lo, hi))
        # stock edit
        edits = []
        for tag, frozen, sku in (('t', True, skus[4]), ('c', False, skus[5])):
            s = start_session(inv, 'staff', datetime.datetime(2025, 11, 20, 2, 0) if frozen else None)
            cr.execute("SELECT id FROM product_product WHERE default_code = %s", [sku])
            pid = cr.fetchone()[0]
            cr.execute("SELECT round(sum(q.quantity)) FROM stock_quant q JOIN stock_location l ON l.id = q.location_id AND l.usage = 'internal' WHERE q.product_id = %s", [pid])
            have = int(cr.fetchone()[0])
            r = in_event(datetime.datetime(2025, 11, 20, 2, 0) if frozen else None, lambda: call('stock_set', {'product_id': pid, 'quantity': have - 1, 'reason': 'Self test count ' + tag}, s, 'staff'))
            assert r['status'] == 'done', r
            edits.append(r['edit']['id'])
        c1, r1 = table_rows('clothcraft_stock_edit', 'id = %s', [edits[0]], {'id', 'create_date', 'write_date', 'product_id', 'reason', 'detail', 'old_qty', 'new_qty'})
        c2, r2 = table_rows('clothcraft_stock_edit', 'id = %s', [edits[1]], {'id', 'create_date', 'write_date', 'product_id', 'reason', 'detail', 'old_qty', 'new_qty'})
        ok &= check('stock edit rows under T1 equal real ones: %d columns' % len(c1), r1 == r2 and len(r1) == 1)
        cr.execute("SELECT create_date, write_date FROM clothcraft_stock_edit WHERE id = %s", [edits[0]])
        ok &= check('...with the frozen event time', cr.fetchone() == (datetime.datetime(2025, 11, 20, 2, 0),) * 2)
        # employee audit
        audits = []
        for tag, frozen in (('t', True), ('c', False)):
            s = start_session(adm, 'admin', datetime.datetime(2025, 11, 25, 1, 0) if frozen else None)
            r = in_event(datetime.datetime(2025, 11, 25, 1, 0) if frozen else None, lambda: call('admin_employee_create', {'name': 'Self Test Employee ' + tag, 'email': 'selftest.emp.%s@example.test' % tag,
                                                                                                                         'role': 'inventory', 'password': secrets.token_urlsafe(18) + 'aA1!', 'job_title': 'Test'}, s, 'admin'))
            assert r['status'] == 'done', r
            audits.append(user_id('selftest.emp.%s@example.test' % tag))
        cr.execute("SELECT action, actor_name, create_uid, write_uid FROM clothcraft_employee_audit WHERE target_name LIKE %s ORDER BY id", ['Self Test Employee %'])
        got = cr.fetchall()
        ok &= check('employee history rows under T1 equal real ones (action, actor, creator)', len(got) == 2 and got[0] == got[1], got)
        cr.execute("SELECT create_date, write_date FROM clothcraft_employee_audit WHERE target_name = 'Self Test Employee t'")
        ok &= check('...with the frozen event time', cr.fetchone() == (datetime.datetime(2025, 11, 25, 1, 0),) * 2)
    except Exception as error:
        ok = False
        say('FAIL the self-test could not finish:', type(error).__name__, str(error)[:200])
        for line in traceback.format_exc().splitlines()[-4:]:
            say('    ', line[:180])
    finally:
        cr.rollback()
        env.invalidate_all()
        restore_sequences(seq_before)
        cr.commit()
    cr.execute("SELECT (SELECT count(*) FROM sale_order), (SELECT count(*) FROM clothcraft_order_audit), (SELECT count(*) FROM res_users), (SELECT count(*) FROM clothcraft_restock)")
    ok &= check('the self-test left the database as it was (rolled back, sequences restored)', cr.fetchone() == counts_before)
    return ok


# ------------------------------------------------------------------------------------------------------------------------ D1 and the replay
LOCAL_DIR = os.environ.get('PACK_LOCAL') or os.path.join(PACK, '_local')      # where accounts.csv, load_log.csv and the D1 originals are written (never printed)
D1_FILE = os.path.join(LOCAL_DIR, 'd1_original_dates.csv')


def save_originals(target):
    """Before D1 changes anything: write the ORIGINAL date of every row it will touch (table, id, original value) to _local/d1_original_dates.csv, so PACK_MODE=undo_d1
    can put them back. Nothing is changed if the file cannot be written."""
    cr.execute("""SELECT m.id, m.date, m.product_id FROM stock_move m JOIN stock_location ls ON ls.id = m.location_id JOIN stock_location ld ON ld.id = m.location_dest_id
                  WHERE m.state = 'done' AND ls.usage = 'inventory' AND ld.usage = 'internal' AND m.date >= '2026-10-23' AND m.date < '2026-10-25' ORDER BY m.id""")
    moves = cr.fetchall()
    cr.execute('SELECT id, date FROM stock_move_line WHERE move_id = ANY(%s) ORDER BY id', [[m for m, _d, _p in moves]])
    lines = cr.fetchall()
    cr.execute("SELECT id, in_date FROM stock_quant WHERE in_date >= '2026-10-23' AND in_date < '2026-10-25' AND product_id = ANY(%s) ORDER BY id", [[p for _m, _d, p in moves]])
    quants = cr.fetchall()
    os.makedirs(os.path.dirname(D1_FILE), exist_ok=True)
    with open(D1_FILE, 'w', encoding='utf-8', newline='') as handle:
        w = csv.writer(handle, lineterminator='\r\n')
        w.writerow(['table', 'id', 'original_value', 'rebased_to'])
        for table, data in (('stock_move', [(m, d) for m, d, _p in moves]), ('stock_move_line', lines), ('stock_quant', quants)):
            for i, d in data:
                w.writerow([table, i, d.isoformat(sep=' '), target.isoformat(sep=' ')])
    say('D1 original dates saved to', D1_FILE, '(%d moves, %d move lines, %d quants)' % (len(moves), len(lines), len(quants)))


def undo_d1():
    """Put the dates D1 changed back, from _local/d1_original_dates.csv. Only rows still at the rebased value are touched. Use it together with removing the pack
    orders (restore the backup): with the pack's orders still in place the DSS would see sales before the opening stock again."""
    if not os.path.exists(D1_FILE):
        die('no ' + D1_FILE + ': nothing to undo')
    done = collections.Counter()
    with open(D1_FILE, encoding='utf-8', newline='') as handle:
        for r in csv.DictReader(handle):
            col = 'in_date' if r['table'] == 'stock_quant' else 'date'
            cr.execute('UPDATE %s SET %s = %%s WHERE id = %%s AND %s = %%s' % (r['table'], col, col), [r['original_value'], int(r['id']), r['rebased_to']])
            done[r['table']] += cr.rowcount
    cr.commit()
    say('D1 undone:', dict(done))


def rebase_seed():
    """D1: the shop's 243 opening-stock moves (done, inventory -> internal, dated 2026-10-23 in the dump) are re-dated to 2025-09-30 08:00 Manila. The tables
    UPDATEd: stock_move.date, stock_move_line.date (of those moves) and stock_quant.in_date (of those products' quants dated 23-24 October). Nothing else.
    The original dates are saved first (save_originals) so the step can be undone."""
    if IS_SHOP:
        die('D1 must never run on the real shop (it would change the dates of its stock history)')
    target = datetime.datetime(2025, 9, 30, 0, 0)          # 08:00 Manila
    save_originals(target)
    cr.execute("""UPDATE stock_move m SET date = %s FROM stock_location ls, stock_location ld WHERE ls.id = m.location_id AND ld.id = m.location_dest_id AND m.state = 'done'
                  AND ls.usage = 'inventory' AND ld.usage = 'internal' AND m.date >= '2026-10-23' AND m.date < '2026-10-25' RETURNING m.id, m.product_id""", [target])
    moved = cr.fetchall()
    if len(moved) != 243:
        die('expected 243 seed moves, found %d: nothing was changed' % len(moved))
    cr.execute("UPDATE stock_move_line SET date = %s WHERE move_id = ANY(%s)", [target, [m for m, _p in moved]])
    lines = cr.rowcount
    cr.execute("UPDATE stock_quant SET in_date = %s WHERE in_date >= '2026-10-23' AND in_date < '2026-10-25' AND product_id = ANY(%s)", [target, [p for _m, p in moved]])
    quants = cr.rowcount
    cr.commit()
    say('D1 seed re-dated to 2025-09-30 08:00 Manila: stock_move.date %d rows, stock_move_line.date %d rows, stock_quant.in_date %d rows (no other table touched)' % (len(moved), lines, quants))


def png(width, height, colour):
    buf = io.BytesIO()
    Image.new('RGBA', (width, height), colour).save(buf, 'PNG', optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def hex_rgba(text):
    return tuple(int(text[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def design_payload(d, layers):
    objects = [{'layerId': 'layer-%s' % l['layer_no'], 'type': 'Image', 'assetId': 'pic-1', 'left': float(l['x']), 'top': float(l['y']), 'width': float(l['width']), 'height': float(l['height']),
                'scaleX': 1, 'scaleY': 1, 'angle': float(l['rotation']), 'originX': 'center', 'originY': 'center', 'opacity': 1, 'visible': True} for l in layers]
    return {'state': json.dumps({'schemaVersion': 1, 'engine': 'fabric', 'state': {'objects': objects}}),
            'layers': [{'id': 'layer-%s' % l['layer_no'], 'x': float(l['x']), 'y': float(l['y']), 'width': float(l['width']), 'height': float(l['height']), 'rotation': float(l['rotation']),
                        'visible': True, 'opacity': 1} for l in layers],
            'pictures': [{'id': 'pic-1', 'data': png(200, 200, hex_rgba(d['picture_colour']))}], 'preview': png(800, 800, (240, 240, 240, 255)), 'print': png(1024, 1024, (0, 0, 0, 0))}


def build_events():
    ev, seq = [], itertools.count()

    def add(when, prio, kind, data):
        ev.append((utc(when) if isinstance(when, str) else when, prio, next(seq), kind, data))
    for e in sorted(EMPS, key=lambda e: (e['hired_at'], e['employee_id'])):
        add(e['hired_at'], -3, 'employee', e)
        if e['left_at']:
            add(e['left_at'], 2, 'archive', e)
    for c in CUSTS:
        add(c['registered_at'], -2, 'register', c)
    for s in SUPS:
        if s['unavailable_from']:
            add(s['unavailable_entered_at'], -1, 'range', s)
    for d in DESIGNS:
        add(d['created_at'], -1, 'design', d)
    for o in ORDERS:
        add(o['placed_at'], 3, 'place', o)
    for e in EVENTS:
        add(e['at'], 2, 'move' if e['actor_type'] == 'staff' else ('confirm' if e['actor_type'] == 'customer' else 'auto'), e)
    first_receipt = {}
    for r in RECEIPTS:
        first_receipt.setdefault(r['restock_id'], r['received_at'])
    for r in RESTOCKS:
        add(r['requested_at'], 1, 'rs_request', r)
        if r['decided_at']:
            add(r['decided_at'], 1, 'rs_decide', r)
        if r['not_received_at']:
            add(r['not_received_at'], 1, 'rs_notreceived', r)
        if r['restock_id'] in first_receipt:
            add(first_receipt[r['restock_id']], 1, 'rs_receive', r)
    for a in COUNTS:
        add(a['at'], 0, 'count', a)
    ev.sort(key=lambda x: (x[0], x[1], x[2]))
    return ev


class Replay:
    def __init__(self):
        cr.execute("SELECT default_code, id FROM product_product WHERE active AND default_code IS NOT NULL")
        self.pid = dict(cr.fetchall())
        cr.execute("SELECT name, id FROM clothcraft_supplier")
        by_name = dict(cr.fetchall())
        self.sup = {s['supplier_id']: by_name[s['name']] for s in SUPS}
        self.emp, self.cust, self.order, self.design, self.restock = {}, {}, {}, {}, {}
        self.skip = set()              # csv orders that could not be placed: their later events are skipped
        self.passwords = {}
        self.cust_by_id = {c['customer_id']: c for c in CUSTS}
        self.emp_by_id = {e['employee_id']: e for e in EMPS}
        self.counters = collections.Counter()
        self.seconds = collections.Counter()
        self.auto_done = {}
        self.odoo_admin = 2

    def scope(self, emp_id):
        return 'admin' if self.emp_by_id[emp_id]['role'] == 'admin' else 'staff'

    def run(self, n, when, kind, ref, expected, body):
        """One event: sessions are made one minute earlier, then the body runs inside the frozen event, then commit. Anything unexpected is logged."""
        t0 = time.time()
        status, note = '', ''
        try:
            status, note = body()
            ok = (status == expected)
            cr.commit()
        except Exception as error:
            cr.rollback()
            env.invalidate_all()
            status, ok, note = 'EXCEPTION', False, '%s: %s' % (type(error).__name__, str(error)[:160])
        sec = time.time() - t0
        self.seconds[kind] += sec
        self.counters[kind] += 1
        LOG.append((n, kind, ref, when.isoformat(sep='T') if when else '', status, expected, 'yes' if ok else 'NO', '%.2f' % sec, note[:200]))
        if not ok:
            FAILS.append((n, kind, ref, status, expected, note[:160]))
            say('UNEXPECTED #%d %s %s: got %s, expected %s %s' % (n, kind, ref, status, expected, note[:120]))
        return ok

    # --- the event bodies. Each returns (status, note).
    def b_employee(self, e, when):
        actor_id = self.odoo_admin if e['employee_id'] in ('E06', 'E07') else self.emp['E06']['uid']
        sid = start_session(actor_id, 'admin', when)
        pw = secrets.token_urlsafe(18) + 'aA1!'
        if e['employee_id'] in ('E06', 'E01'):
            self.passwords[e['employee_id']] = pw             # the two optional sign-in accounts
        r = in_event(when, lambda: call('admin_employee_create', {'name': e['name'], 'email': e['email'], 'role': e['role'], 'password': pw, 'job_title': e['job_title']}, sid, 'admin'))
        if r['status'] == 'done':
            self.emp[e['employee_id']] = {'uid': user_id(e['email']), 'role': e['role']}
        return r['status'], str(r.get('fields') or '')

    def b_archive(self, e, when):
        sid = start_session(self.emp['E06']['uid'], 'admin', when)
        r = in_event(when, lambda: call('admin_employee_deactivate', {'employee_id': self.emp[e['employee_id']]['uid']}, sid, 'admin'))
        return r['status'], str(r.get('message') or r.get('fields') or '')

    def b_register(self, c, when):
        n = int(c['customer_id'][1:])
        r = in_event(when, lambda: API.auth_register({'name': c['name'], 'email': c['email'], 'password': secrets.token_urlsafe(18) + 'aA1!', 'sid_hash': 'pk-reg-' + c['customer_id'],
                                                      'client_ip': '10.%d.%d.1' % (20 + n // 250, n % 250)}))
        if r['status'] == 'created':
            self.cust[c['customer_id']] = {'uid': r['user']['id']}
        return r['status'], str(r.get('fields') or '')

    def b_range(self, s, when):
        sid = start_session(self.emp['E07']['uid'], 'admin', when)
        r = in_event(when, lambda: call('supplier_range_add', {'supplier_id': self.sup[s['supplier_id']], 'date_from': s['unavailable_from'], 'date_to': s['unavailable_to'],
                                                                'reason': 'Planned shutdown'}, sid, 'admin'))
        return r['status'], str(r.get('fields') or r.get('message') or '')

    def b_design(self, d, when):
        cust = self.cust[d['customer_id']]
        sid = start_session(cust['uid'], 'customer', when)
        layers = [l for l in LAYERS if l['design_id'] == d['design_id']]
        payload = design_payload(d, layers)
        r = in_event(when, lambda: API.design_upload({'sid_hash': sid, 'product': d['slug'], 'sku': d['sku'], 'idempotency_key': 'pack:' + d['design_id'], **payload}))
        if r['status'] != 'created':
            return r['status'], str(r.get('code') or r.get('message') or '')
        self.design[d['design_id']] = r['design']['id']
        fee_ok = abs(float(r['design']['covered_sq_in']) - float(d['covered_sq_in'])) < 0.005
        return 'created', '' if fee_ok else 'covered area %s differs from the CSV %s' % (r['design']['covered_sq_in'], d['covered_sq_in'])

    def b_place(self, o, when):
        c = self.cust_by_id[o['customer_id']]
        sid = start_session(self.cust[o['customer_id']]['uid'], 'customer', when)
        lines = []
        for l in [x for x in LINES if x['order_id'] == o['order_id']]:
            line = {'sku': l['sku'], 'quantity': int(l['quantity'])}
            if l['design_id']:
                line['design_id'] = self.design[l['design_id']]
            lines.append(line)
        delivery = {'name': c['name'], 'email': c['email'], 'phone': c['phone'], 'street': c['delivery_street'], 'city': c['delivery_city'], 'province': c['delivery_province'],
                    'postal_code': c['delivery_postal_code'], 'note': ''}

        def body():
            quote = API.quote(lines, sid)                                    # inside the frozen event, like the order itself
            return quote, API.place_order({'sid_hash': sid, 'lines': lines, 'delivery': delivery, 'payment_method': o['payment_method'], 'quoted_total': quote.get('amount_total') or 0,
                                           'idempotency_key': o['client_order_ref']})
        quote, r = in_event(when, body)
        if r['status'] != 'created':
            self.skip.add(o['order_id'])
            return r['status'], 'REFUSED: %s' % (r.get('message') or (r.get('quote') or {}).get('status') or '')
        self.order[o['order_id']] = r['order']['id']
        total = float(r['order']['amount_total']) if 'amount_total' in r['order'] else float(quote['amount_total'])
        return 'created', '' if abs(total - float(o['expected_amount_total'])) < 0.005 else 'total %.2f differs from the CSV %s' % (total, o['expected_amount_total'])

    def b_move(self, e, when):
        if e['order_id'] in self.skip:
            return 'skipped', 'its order was not placed'
        who = e['employee_id']
        sid = start_session(self.emp[who]['uid'], self.scope(who), when)
        r = in_event(when, lambda: call('staff_transition', {'order_id': self.order[e['order_id']], 'to': e['to_state'], 'expected_state': e['from_state'], 'note': e['note']}, sid, self.scope(who)))
        return r['status'], str(r.get('message') or r.get('fields') or '')

    def b_confirm(self, e, when):
        if e['order_id'] in self.skip:
            return 'skipped', 'its order was not placed'
        sid = start_session(self.cust[e['customer_id']]['uid'], 'customer', when)
        r = in_event(when, lambda: API.order_confirm_received({'sid_hash': sid, 'order_id': self.order[e['order_id']]}))
        return 'done' if r['status'] == 'ok' else r['status'], str(r.get('message') or '')

    def b_auto(self, when, count):
        n = in_event(when, lambda: env['sale.order']._cron_clothcraft_auto_close(now=when))
        return ('done' if n == count else 'closed %s, expected %s' % (n, count)), ''

    def b_rs_request(self, r, when):
        sid = start_session(self.emp[r['requested_by']]['uid'], 'staff', when)
        lines = [{'product_id': self.pid[l['sku']], 'quantity': int(l['quantity'])} for l in RLINES if l['restock_id'] == r['restock_id']]
        payload = {'supplier_id': self.sup[r['supplier_id']], 'lines': lines, 'shipping_on': r['shipping_on'] == 'yes', 'expected_from': r['expected_from'], 'expected_to': r['expected_to'],
                   'request_note': r['request_note']}
        res = in_event(when, lambda: call('restock_create', payload, sid, 'staff'))
        if res['status'] != 'done':
            return res['status'], str(res.get('fields') or res.get('message') or '')
        lines_by_sku = {l['sku']: l for l in res['restock']['lines']}
        self.restock[r['restock_id']] = {'id': res['restock']['id'], 'lines': lines_by_sku}
        bad = [l['sku'] for l in RLINES if l['restock_id'] == r['restock_id'] and abs(lines_by_sku[l['sku']]['unit_cost'] - float(l['unit_cost'])) > 0.005]
        return 'done', '' if not bad else 'unit cost differs from the CSV for %s' % bad[:2]

    def b_rs_decide(self, r, when):
        if r['restock_id'] not in self.restock:
            return 'skipped', 'not requested'
        sid = start_session(self.emp[r['decided_by']]['uid'], 'admin', when)
        method = 'restock_approve' if r['decision'] == 'approved' else 'restock_reject'
        res = in_event(when, lambda: call(method, {'restock_id': self.restock[r['restock_id']]['id'], 'note': r['decision_note']}, sid, 'admin'))
        return res['status'], str(res.get('fields') or res.get('message') or '')

    def b_rs_notreceived(self, r, when):
        sid = start_session(self.emp[r['not_received_by']]['uid'], 'admin', when)
        res = in_event(when, lambda: call('restock_not_received', {'restock_id': self.restock[r['restock_id']]['id']}, sid, 'admin'))
        return res['status'], str(res.get('fields') or res.get('message') or '')

    def b_rs_receive(self, r, when):
        got = [x for x in RECEIPTS if x['restock_id'] == r['restock_id']]
        info = self.restock[r['restock_id']]
        sid = start_session(self.emp[got[0]['received_by']]['uid'], 'admin', when)
        quantities = {str(info['lines'][x['sku']]['id']): int(x['quantity_received']) for x in got}
        lots = {str(info['lines'][x['sku']]['id']): x['lot_name'] for x in got}
        res = in_event(when, lambda: call('restock_receive', {'restock_id': info['id'], 'received_on': got[0]['received_on'], 'quantities': quantities, 'lots': lots}, sid, 'admin'))
        if res['status'] != 'done':
            return res['status'], str(res.get('fields') or res.get('message') or '')
        cost_ok = abs(float(res['restock']['actual_cost']) - float(r['actual_cost'])) < 0.005
        return 'done', '' if cost_ok else 'actual cost %s differs from the CSV %s' % (res['restock']['actual_cost'], r['actual_cost'])

    def b_count(self, a, when):
        sid = start_session(self.emp[a['employee_id']]['uid'], 'staff', when)
        res = in_event(when, lambda: call('stock_set', {'product_id': self.pid[a['sku']], 'quantity': int(a['new_quantity']), 'reason': a['reason']}, sid, 'staff'))
        if res['status'] != 'done':
            return res['status'], str(res.get('fields') or res.get('message') or '')
        return 'done', '' if res['edit']['old_qty'] == int(a['old_quantity']) else 'old quantity %s, the CSV says %s' % (res['edit']['old_qty'], a['old_quantity'])


def replay(events):
    rp = Replay()
    auto_expected = collections.Counter(utc(e['at']) for e in EVENTS if e['actor_type'] == 'automatic')
    auto_seen = set()
    total = len(events)
    n = 0
    for when, _prio, _seq, kind, data in events:
        n += 1
        if kind == 'auto':
            if when in auto_seen:
                continue                       # one call of the daily job closes everything due at that moment
            auto_seen.add(when)
            rp.run(n, when, 'auto-close job', when.isoformat(), 'done', lambda w=when: rp.b_auto(w, auto_expected[w]))
        else:
            ref = data.get('order_id') or data.get('restock_id') or data.get('customer_id') or data.get('employee_id') or data.get('design_id') or data.get('adjustment_id') or data.get('supplier_id')
            expect = {'move': data.get('expected_outcome', 'done'), 'place': 'created', 'design': 'created', 'register': 'created', 'employee': 'done', 'archive': 'done', 'range': 'done',
                      'confirm': 'done', 'rs_request': 'done', 'rs_decide': 'done', 'rs_notreceived': 'done', 'rs_receive': 'done', 'count': 'done'}[kind]
            label = {'move': 'staff move', 'place': 'place order', 'design': 'design upload', 'register': 'customer registration', 'employee': 'employee created', 'archive': 'employee archived',
                     'range': 'supplier unavailable range', 'confirm': 'customer confirms', 'rs_request': 'restock request', 'rs_decide': 'restock decision', 'rs_notreceived': 'restock not received',
                     'rs_receive': 'restock receipt', 'count': 'stock count'}[kind]
            handler = {'move': rp.b_move, 'place': rp.b_place, 'design': rp.b_design, 'register': rp.b_register, 'employee': rp.b_employee, 'archive': rp.b_archive, 'range': rp.b_range,
                       'confirm': rp.b_confirm, 'rs_request': rp.b_rs_request, 'rs_decide': rp.b_rs_decide, 'rs_notreceived': rp.b_rs_notreceived, 'rs_receive': rp.b_rs_receive, 'count': rp.b_count}[kind]
            rp.run(n, when, label, ref, expect, lambda h=handler, d=data, w=when: h(d, w))
        if n % 100 == 0:
            say('progress %d of %d events, %.0f s, unexpected so far: %d' % (n, total, time.time() - T_START, len(FAILS)))
            env.invalidate_all()
        if len(FAILS) > 25:
            say('STOP: more than 25 unexpected results; the database is left as it is (restore it to try again)')
            break
    return rp


def finish(rp, pack_hash, first_ids):
    cr.execute("DELETE FROM clothcraft_api_session WHERE id > %s", [first_ids['session']])
    sessions = cr.rowcount
    cr.execute("DELETE FROM clothcraft_api_throttle WHERE id > %s", [first_ids['throttle']])
    throttle = cr.rowcount
    if not IS_SHOP:
        params.set_param('clothcraft.auto_close_days', '0')          # the pack databases never close orders by themselves; the real shop keeps its own rule
    params.set_param(MARKER, 'loaded:' + pack_hash)
    cr.commit()
    say('purged', sessions, 'sessions and', throttle, 'throttle counters made by the load; clothcraft.auto_close_days',
        ('left at ' + ORIGINAL_AUTO_CLOSE) if IS_SHOP else 'set to 0', '; marker set to loaded:' + pack_hash)
    local = LOCAL_DIR
    os.makedirs(local, exist_ok=True)
    with open(os.path.join(local, 'accounts.csv'), 'w', encoding='utf-8-sig', newline='') as handle:
        w = csv.writer(handle, lineterminator='\r\n')
        w.writerow(['employee_id', 'name', 'role', 'email', 'password'])
        for eid in ('E06', 'E01'):
            e = rp.emp_by_id[eid]
            w.writerow([eid, e['name'], e['role'], e['email'], rp.passwords[eid]])
    with open(os.path.join(local, 'load_log.csv'), 'w', encoding='utf-8-sig', newline='') as handle:
        w = csv.writer(handle, lineterminator='\r\n')
        w.writerow(['n', 'kind', 'ref', 'at_utc', 'status', 'expected', 'as_expected', 'seconds', 'note'])
        w.writerows(LOG)
    say('wrote _local/accounts.csv (two sign-in accounts; passwords are in that file only) and _local/load_log.csv (%d rows)' % len(LOG))


def report(rp):
    say('--- loader report')
    say('events replayed:', sum(rp.counters.values()), '| unexpected results:', len(FAILS), '| total time %.0f s' % (time.time() - T_START))
    for kind in sorted(rp.counters):
        say('  %-28s %5d   %6.1f s   (%.2f s each)' % (kind, rp.counters[kind], rp.seconds[kind], rp.seconds[kind] / max(1, rp.counters[kind])))
    refused = [f for f in FAILS if f[1] == 'place order' or (f[3] not in ('done', 'state_changed') and 'REFUSED' in f[5])]
    seen_changed = sum(1 for row in LOG if row[4] == 'state_changed')
    expected_changed = sum(1 for e in EVENTS if e['expected_outcome'] == 'state_changed')
    say('stock guard refusals (placements not created):', len([r for r in LOG if r[1] == 'place order' and r[4] != 'created']), '(expected 0)')
    say('state_changed answers (two staff, one order):', seen_changed, '| the CSV expects', expected_changed, '=>', 'MATCH' if seen_changed == expected_changed else 'DIFFERENT')
    if FAILS:
        say('unexpected results, in the order they happened:')
        for f in FAILS[:30]:
            say('   #%d %s %s: got %s, expected %s %s' % f)


# ------------------------------------------------------------------------------------------------------------------------ check (read only)
def shape_check():
    """Step 3: the loaded database against the CSV. Read only."""
    ok = True
    cr.execute("SELECT value FROM ir_config_parameter WHERE key = %s", [MARKER])
    m = cr.fetchone()
    ok &= check('the pack marker says loaded', bool(m) and m[0].startswith('loaded:'), m)
    cr.execute("SELECT o.client_order_ref, o.clothcraft_state, o.amount_total FROM sale_order o WHERE o.client_order_ref LIKE %s", ['%:pack:O%'])
    db = {r[0].split(':pack:')[1] if ':pack:' in r[0] else r[0]: (r[1], float(r[2])) for r in cr.fetchall()}
    want = {o['order_id']: (o['final_state'], float(o['expected_amount_total'])) for o in ORDERS}
    missing = [k for k in want if k not in db]
    wrong = [(k, db[k], want[k]) for k in want if k in db and (db[k][0] != want[k][0] or abs(db[k][1] - want[k][1]) > 0.005)]
    ok &= check('orders: %d in the database for %d in the CSV; state and total equal for each' % (len(db), len(want)), not missing and not wrong, (missing[:3], wrong[:3]))
    csv_states = collections.Counter(o['final_state'] for o in ORDERS)
    db_states = collections.Counter(v[0] for v in db.values())
    say('INFO orders by state, database / CSV:', {s: (db_states.get(s, 0), csv_states[s]) for s in sorted(set(csv_states) | set(db_states))})
    cr.execute("SELECT clothcraft_state, count(*) FROM sale_order GROUP BY 1 ORDER BY 1")
    say('INFO all orders including the two shop test orders:', dict(cr.fetchall()))
    cr.execute("SELECT count(*) FROM res_users WHERE lower(login) = ANY(%s)", [[c['email'].lower() for c in CUSTS]])
    ok &= check('customers: %d registered' % len(CUSTS), cr.fetchone()[0] == len(CUSTS))
    cr.execute("SELECT count(*) FROM res_users WHERE share")
    say('INFO customer accounts in all (pack + the shop\'s own):', cr.fetchone()[0])
    cr.execute("SELECT u.id, u.login, u.active FROM res_users u WHERE NOT u.share AND u.id NOT IN (1, 2) AND EXISTS (SELECT 1 FROM res_groups_users_rel r JOIN ir_model_data d ON d.res_id = r.gid AND d.model = 'res.groups' "
               "AND d.module = 'clothcraft' AND d.name IN ('group_inventory', 'group_admin') WHERE r.uid = u.id) AND NOT EXISTS (SELECT 1 FROM res_groups_users_rel r JOIN ir_model_data d ON d.res_id = r.gid AND d.model = 'res.groups' "
               "AND d.name IN ('group_system', 'group_api') WHERE r.uid = u.id)")
    listed = cr.fetchall()
    pack_emails = {e['email'].lower() for e in EMPS}
    ok &= check('employees listed by the admin page: %d (8 pack + 2 shop test staff; the Odoo administrator is never listed)' % len(listed), len(listed) == 10 and sum(1 for u in listed if u[1].lower() in pack_emails) == 8,
                [(u[1] in pack_emails) for u in listed])
    say('INFO archived among them:', [u[1] for u in listed if not u[2]], '| shop test staff:', [u[1] for u in listed if u[1].lower() not in pack_emails], '| Odoo administrator (separate): user 2, not listed')
    cr.execute("SELECT count(*) FROM clothcraft_design")
    ok &= check('designs: %d' % len(DESIGNS), cr.fetchone()[0] >= len(DESIGNS), cr.rowcount)
    cr.execute("SELECT state, count(*) FROM clothcraft_restock GROUP BY 1")
    got = dict(cr.fetchall())
    csv_rs = collections.Counter(r['outcome'] for r in RESTOCKS)
    ok &= check('restocks: %s equal the CSV %s' % (got, dict(csv_rs)), got == dict(csv_rs))
    cr.execute("SELECT count(*), coalesce(sum(quantity_received), 0) FROM clothcraft_restock_line WHERE quantity_received > 0")
    n, units = cr.fetchone()
    ok &= check('receipts: %d lines and %d units received (CSV %d lines, %d units)' % (n, units, len(RECEIPTS), sum(int(r['quantity_received']) for r in RECEIPTS)),
                n == len(RECEIPTS) and int(units) == sum(int(r['quantity_received']) for r in RECEIPTS))
    cr.execute("SELECT round(sum(q.quantity)) FROM stock_quant q JOIN stock_location l ON l.id = q.location_id AND l.usage = 'internal'")
    on_hand = int(cr.fetchone()[0])
    problems, end, _p = ledger_from_csv()
    cr.execute("""SELECT pp.default_code, round(coalesce(sum(q.quantity) FILTER (WHERE l.id IS NOT NULL), 0)) FROM product_product pp LEFT JOIN stock_quant q ON q.product_id = pp.id
                  LEFT JOIN stock_location l ON l.id = q.location_id AND l.usage = 'internal' WHERE pp.active AND pp.default_code IS NOT NULL GROUP BY 1""")
    now = {s: int(q) for s, q in cr.fetchall()}
    diff = {s: (now.get(s), end[s]) for s in end if now.get(s) != end[s]}
    ok &= check('stock on hand: %d units in the database; the CSV ledger ends at %d; per variant differences: %d' % (on_hand, sum(end.values()), len(diff)), not diff, list(diff.items())[:3])
    cr.execute("SELECT count(*) FROM clothcraft_order_audit")
    audit = cr.fetchone()[0]
    done = sum(1 for e in EVENTS if e['expected_outcome'] == 'done')
    ok &= check('order history lines: %d (7 shop + %d moves in the CSV)' % (audit, done), audit == 7 + done)
    cr.execute("SELECT count(*) FROM clothcraft_order_audit WHERE to_state = 'closed' AND actor_type = 'customer'")
    cust_closes = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM clothcraft_order_audit WHERE to_state = 'closed' AND actor_type = 'automatic'")
    auto_closes = cr.fetchone()[0]
    csv_c = sum(1 for e in EVENTS if e['to_state'] == 'closed' and e['actor_type'] == 'customer')
    csv_a = sum(1 for e in EVENTS if e['to_state'] == 'closed' and e['actor_type'] == 'automatic')
    ok &= check('closed by the customer %d / the daily job %d (CSV %d / %d; the shop adds its own closes)' % (cust_closes, auto_closes, csv_c, csv_a), cust_closes >= csv_c and auto_closes >= csv_a)
    cr.execute("""SELECT u.login, u.partner_id FROM res_users u WHERE u.share AND lower(u.login) = ANY(%s)""", [[c['email'].lower() for c in CUSTS]])
    pid = {l: p for l, p in cr.fetchall()}
    by_reg = sorted(CUSTS, key=lambda c: (c['registered_at'], c['customer_id']))
    ids = [pid[c['email'].lower()] for c in by_reg]
    inversions = sum(1 for a, b in zip(ids, ids[1:]) if a > b)
    ok &= check('partner ids ascend with registration time (the RFM tie-break assumes it): %d inversions in %d customers' % (inversions, len(ids)), inversions == 0)
    cr.execute("SELECT count(*) FROM clothcraft_api_session WHERE sid_hash LIKE %s", ['pk-%'])
    ok &= check('no loader sessions left', cr.fetchone()[0] == 0)
    say('INFO clothcraft.auto_close_days =', params.get_param('clothcraft.auto_close_days', '7'))
    return ok


def plan_report():
    """The dry-run plan (F4): what a load would insert, match, update or skip in THIS database, from the CSVs and read-only queries. Nothing is written."""
    say('--- plan: what a load would do in', cr.dbname)
    cr.execute('SELECT lower(login) FROM res_users')
    logins = {l for (l,) in cr.fetchall()}
    for label, items in (('employees', EMPS), ('customers', CUSTS)):
        used = sum(1 for x in items if x['email'].lower() in logins)
        say('  %-34s insert %4d | match (email already a user) %d | update 0 | skip 0' % (label, len(items) - used, used))
    cr.execute('SELECT name FROM clothcraft_supplier')
    have = {n for (n,) in cr.fetchall()}
    matched = sum(1 for s in SUPS if s['name'] in have)
    ranges = sum(1 for s in SUPS if s['unavailable_from'])
    say('  %-34s insert %4d | match (by exact name) %d | update 0 (not changed) | unavailability ranges to add %d' % ('suppliers', len(SUPS) - matched, matched, ranges))
    cr.execute("SELECT count(*) FROM sale_order WHERE client_order_ref LIKE '%:pack:O%'")
    already = cr.fetchone()[0]
    say("  %-34s insert %4d | match %d (already loaded) | the shop's own 2 orders are kept untouched (baseline in reference/baseline_orders.csv)" % ('orders', len(ORDERS) - already, already))
    say('  %-34s insert %4d (created through place_order; the stock guard checks every line)' % ('order lines', len(LINES)))
    kinds = collections.Counter(e['to_state'] for e in EVENTS)
    say('  %-34s %d moves to replay (%s); every one is dated in the past (T1 clock): %s .. %s' % ('order history (events)', len(EVENTS), ', '.join('%s %d' % kv for kv in sorted(kinds.items())),
                                                                                              min(o['placed_at'] for o in ORDERS)[:10], max(e['at'] for e in EVENTS)[:10]))
    final = collections.Counter(o['final_state'] for o in ORDERS)
    say('  %-34s end states: %s' % ('status transformations', ', '.join('%s %d' % kv for kv in sorted(final.items()))))
    say('  %-34s %d rows are not imported as rows: the payment of each order is made by the shop flow (bank transfer confirmed, COD collected); they are expectations' % ('payments.csv', len(rows('payments.csv'))))
    say('  %-34s insert %4d designs, %d layers (a synthetic print picture is made for each)' % ('designs', len(DESIGNS), len(LAYERS)))
    say('  %-34s %d restock requests, %d lines, %d receipt lines (through restock_create / approve / receive)' % ('restocks and receipts', len(RESTOCKS), len(RLINES), len(RECEIPTS)))
    say("  %-34s %d stock counts (stock_set); the shop's own stock moves are not replayed" % ('stock adjustments', len(COUNTS)))
    cr.execute("""SELECT count(*) FROM stock_move m JOIN stock_location ls ON ls.id = m.location_id JOIN stock_location ld ON ld.id = m.location_dest_id
                  WHERE m.state = 'done' AND ls.usage = 'inventory' AND ld.usage = 'internal' AND m.date >= '2026-10-23' AND m.date < '2026-10-25'""")
    seeds = cr.fetchone()[0]
    if IS_SHOP:
        say('  %-34s %d existing opening-stock moves keep their original dates (D1 never runs on the shop; the DSS opening-balance rule reads the ledger as dated)' % ('existing stock history', seeds))
    else:
        say('  %-34s UPDATE the DATE of %d existing opening-stock moves to 2025-09-30 08:00 Manila (D1; originals saved first, undo_d1 puts them back). No quantity changes.' % ('existing stock history', seeds))
    ledger_end = ledger_from_csv()[1]
    say('  %-34s stock on hand after the load, from the CSV ledger: %d units' % ('inventory', sum(ledger_end.values())))
    skus = {r['sku'] for r in LINES} | {c['sku'] for c in COUNTS}
    cr.execute('SELECT default_code FROM product_product WHERE active AND default_code IS NOT NULL')
    known = {c for (c,) in cr.fetchall()}
    say('  %-34s SKUs used by the pack that the database does not have: %d' % ('conflicts: products', len(skus - known)))
    cr.execute('SELECT count(*) FROM res_users WHERE lower(login) = ANY(%s)', [[x['email'].lower() for x in EMPS + CUSTS]])
    say('  %-34s emails already used: %d | pack orders already present: %d' % ('conflicts: duplicates', cr.fetchone()[0], already))
    missing = []
    for t in env['product.template'].with_context(active_test=False).search([('clothcraft_slug', '!=', False)]):
        try:
            if not t.image_1920:
                missing.append(t.clothcraft_slug)
        except Exception:
            missing.append(t.clothcraft_slug)
    say("  %-34s product pictures that cannot be read from this database's filestore: %d %s" % ('images', len(missing), missing[:5]))


# ------------------------------------------------------------------------------------------------------------------------ main
say('mode %s on %s' % (MODE, cr.dbname))
if MODE == 'undo_d1':
    undo_d1()
elif MODE == 'check':
    good = shape_check()
    say('CHECK', 'PASSED' if good else 'FAILED')
elif MODE == 'selftest':
    good = selftest()
    say('SELFTEST', 'PASSED' if good else 'FAILED')
elif MODE == 'dryrun':
    good, pack_hash = pre_checks(False)
    plan_report()
    say('DRY RUN', 'PASSED: nothing was written' if good else 'FAILED: nothing was written')
else:
    good, pack_hash = pre_checks(True)
    if not good:
        die('the pre-load checks failed: nothing was written')
    say('--- self-test: history rows under T1 against real ones')
    if not selftest():
        die('the self-test failed: nothing was loaded')
    cr.execute("SELECT coalesce(max(id), 0) FROM clothcraft_api_session")
    first_session = cr.fetchone()[0]
    cr.execute("SELECT coalesce(max(id), 0) FROM clothcraft_api_throttle")
    first_throttle = cr.fetchone()[0]
    params.set_param(MARKER, 'loading:' + pack_hash)
    cr.commit()
    say('marker set: clothcraft.scenario_pack = loading:' + pack_hash)
    if IS_SHOP:
        say('D1 NOT RUN on the real shop: its stock moves, move lines and quants keep their original dates (the DSS opening-balance rule reads the ledger as dated)')
    elif os.environ.get('PACK_SKIP_D1') == '1' and REHEARSAL.fullmatch(cr.dbname):
        say('D1 SKIPPED (PACK_SKIP_D1=1, rehearsal copy only): the shop opening-stock moves keep their original dates')
    else:
        rebase_seed()
    events = build_events()
    say('--- replaying %d events' % len(events))
    rp = replay(events)
    report(rp)
    finish(rp, pack_hash, {'session': first_session, 'throttle': first_throttle})
    say('LOAD', 'COMPLETE' if not FAILS else 'FINISHED WITH %d UNEXPECTED RESULTS' % len(FAILS))
