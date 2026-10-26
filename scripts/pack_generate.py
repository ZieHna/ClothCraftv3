#!/usr/bin/env python3
"""DSS scenario pack, slice P1: the generator. Writes testdata/dss-scenarios/*.csv, ground_truth.csv, manifest.csv and README.md.

    python3 scripts/pack_generate.py            (from the repository root; standard library only)

No database, no network, no wall clock: every value comes from the seed below and the committed reference CSVs (testdata/dss-scenarios/reference/,
copied from a dump by scripts/pack_extract_baseline.py). Running it twice gives byte-identical files (manifest.csv holds the SHA-256 of each).

The pack is a year of a small shop (2025-10-01 to 2026-10-26, Manila time, +08:00) built to test the DSS on its REAL path. How it is made:
  1. customers by type, each with the days they order (weighted by season, weekday and payday);
  2. every order gets its lifecycle (payment, shipping, delivery, close or cancel) acted by employees inside their working hours;
  3. one chronological sweep with its own STOCK LEDGER: lines are chosen only from variants with free stock, so no order is ever one the
     shop's stock guard would refuse (a product with no stock simply gets no orders); the sweep also plans restocks, receipts and stock counts;
  4. ground_truth.csv: expected DSS results worked out from the CSV rows by separate arithmetic (never by calling the engine).
Dates are written as ISO 8601 with +08:00. Text ids (C001, O0001, E01, R001 ...) so Excel does not turn them into numbers.
"""
import collections
import csv
import datetime as dt
import hashlib
import heapq
import importlib.util
import itertools
import math
import os
import random
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', 'testdata', 'dss-scenarios'))
REF = os.path.join(OUT, 'reference')
FEE_MODULE = os.path.normpath(os.path.join(HERE, '..', 'addons', 'clothcraft', 'design_fee.py'))

GENERATOR_VERSION = 'P1-1'
SEED = 'clothcraft-dss-scenarios-v1'
TZ = dt.timezone(dt.timedelta(hours=8))
FIRST_DAY, LAST_DAY = dt.date(2025, 10, 1), dt.date(2026, 10, 26)


def at(y, m, d, h=0, mi=0, s=0):
    return dt.datetime(y, m, d, h, mi, s, tzinfo=TZ)


CUTOFF = at(2026, 10, 26, 9, 0)           # the data ends here; the DSS run is for the day 2026-10-26
AS_OF = dt.date(2026, 10, 26)
AS_OF_END = at(2026, 10, 27, 0, 0)        # the end of the as-of day: what the DSS measures ages and recency against
OPENING_AT = at(2025, 9, 30, 8, 0)        # the shop's opening stock is counted here (the rebased seed, see README)
CRON_AT = dt.time(10, 38, 0)              # the daily job "close delivered orders automatically" (its time of day in the shop's database)
AUTO_CLOSE = dt.timedelta(days=7)
DAY = dt.timedelta(days=1)
HOUR = dt.timedelta(hours=1)
MIN = dt.timedelta(minutes=1)


def rng(purpose):
    return random.Random(f'{SEED}:{purpose}')


def iso(when):
    return when.astimezone(TZ).isoformat(timespec='seconds')


def money(x):
    return f'{x:.2f}'


def manila_date(when):
    return when.astimezone(TZ).date()


# ------------------------------------------------------------------------------------------------------------------------ reference data
def read_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def load_reference():
    products = {p['slug']: p for p in read_csv(os.path.join(REF, 'products.csv'))}
    variants = {v['sku']: {**v, 'unit_price': float(v['unit_price']), 'opening': int(v['opening_units']), 'sold0': int(v['baseline_sold_units']),
                           'type': products[v['slug']]['garment_type']} for v in read_csv(os.path.join(REF, 'variants.csv'))}
    suppliers = {s['supplier_id']: s for s in read_csv(os.path.join(REF, 'suppliers.csv'))}
    lines = {}
    for l in read_csv(os.path.join(REF, 'supply_lines.csv')):
        lines[(l['supplier_id'], l['garment_type'], l['size'], l['colour'])] = float(l['unit_cost'])
    provinces = {p['code'] for p in read_csv(os.path.join(REF, 'provinces.csv'))}
    settings = read_csv(os.path.join(REF, 'design_settings.csv'))[0]
    baseline = read_csv(os.path.join(REF, 'baseline_orders.csv'))
    spec = importlib.util.spec_from_file_location('design_fee', FEE_MODULE)
    fee = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fee)
    return products, variants, suppliers, lines, provinces, settings, baseline, fee


PRODUCTS, VARIANTS, SUPPLIERS, SUPPLY, PROVINCES, DESIGN_SET, BASELINE, FEE = load_reference()
SKUS = sorted(VARIANTS)
RATE, STEP = float(DESIGN_SET['rate_per_sq_in']), float(DESIGN_SET['size_step'])


def supply_cost(supplier, sku):
    v = VARIANTS[sku]
    return SUPPLY.get((supplier, v['type'], v['size'], v['colour']))


def cheapest_cost(sku):
    costs = [c for s in SUPPLIERS if (c := supply_cost(s, sku)) is not None]
    return min(costs) if costs else None


# ------------------------------------------------------------------------------------------------------------------------ employees
class Emp:
    def __init__(self, eid, name, role, title, hired, left, days, start, end):
        self.id, self.name, self.role, self.title = eid, name, role, title
        self.hired, self.left, self.days, self.start, self.end = hired, left, days, start, end
        first, last = name.lower().split(' ', 1)
        self.email = f'{first}.{last.replace(" ", "")}@example.test'

    def active_at(self, when):
        return self.hired <= when and (self.left is None or when < self.left)


MON_FRI, MON_SAT, TUE_SAT = {0, 1, 2, 3, 4}, {0, 1, 2, 3, 4, 5}, {1, 2, 3, 4, 5}
T = dt.time
EMPLOYEES = [
    Emp('E01', 'Marco Dela Rosa', 'inventory', 'Inventory clerk', at(2025, 9, 15, 8, 30), None, MON_FRI, T(8, 0), T(17, 0)),
    Emp('E02', 'Liza Navarro', 'inventory', 'Inventory clerk', at(2025, 9, 15, 8, 30), None, MON_SAT, T(9, 0), T(18, 0)),
    Emp('E03', 'Joaquin Ramos', 'inventory', 'Packing lead', at(2025, 9, 22, 8, 30), None, MON_FRI, T(10, 0), T(19, 0)),
    Emp('E04', 'Patricia Villanueva', 'inventory', 'Inventory clerk', at(2025, 12, 1, 8, 30), None, TUE_SAT, T(8, 0), T(17, 0)),
    Emp('E05', 'Jerome Bautista', 'inventory', 'Inventory clerk', at(2026, 4, 6, 8, 30), None, MON_FRI, T(8, 0), T(17, 0)),
    Emp('E06', 'Teresa Aquino', 'admin', 'Operations manager', at(2025, 9, 10, 8, 30), None, MON_FRI, T(9, 0), T(18, 0)),
    Emp('E07', 'Rafael Mendoza', 'admin', 'Shop owner', at(2025, 9, 10, 8, 30), None, MON_SAT, T(9, 0), T(17, 0)),
    Emp('E08', 'Cecilia Domingo', 'inventory', 'Inventory clerk (left 2026-02-27)', at(2025, 9, 15, 8, 30), at(2026, 2, 27, 17, 45), MON_FRI, T(8, 0), T(17, 0)),
]
EMP = {e.id: e for e in EMPLOYEES}


def window_on(emp, day, r, late):
    start, end = (T(19, 0), T(22, 30)) if late else (emp.start, emp.end)
    return dt.datetime.combine(day, start, TZ), dt.datetime.combine(day, end, TZ)


def next_time_in_shift(r, emp, after, allow_late=True, spread=0.55):
    """The first moment at or after `after` (plus a few minutes) inside this employee's shift (rarely a late-evening one)."""
    day = after.astimezone(TZ).date()
    for k in range(25):
        d = day + k * DAY
        if d.weekday() not in emp.days:
            continue
        late = allow_late and r.random() < 0.05
        lo, hi = window_on(emp, d, r, late)
        lo = max(lo, after + dt.timedelta(minutes=r.randint(3, 40)))
        if emp.left is not None:
            hi = min(hi, emp.left - MIN)
        if hi - lo < 15 * MIN or not emp.active_at(lo):
            continue
        return (lo + dt.timedelta(seconds=r.randint(0, int((hi - lo).total_seconds() * spread)))).replace(microsecond=0)
    return None


def slot(r, role, after, exclude=(), allow_late=True):
    """(time, employee): a random eligible employee of this role, at a moment inside their working hours."""
    for _ in range(60):
        pool = [e for e in EMPLOYEES if e.role in role and e.id not in exclude and (e.left is None or e.left > after + 2 * HOUR) and e.hired <= after + 7 * DAY]
        e = r.choice(pool)
        t = next_time_in_shift(r, e, max(after, e.hired), allow_late)
        if t is not None:
            return t, e
    raise RuntimeError('no working slot found')


def exact(r, role, when):
    """(time, employee) at exactly `when`: an employee of this role who is on duty then."""
    pool = sorted([e for e in EMPLOYEES if e.role in role and e.active_at(when) and when.weekday() in e.days and e.start <= when.time() <= e.end], key=lambda e: e.id)
    return when, r.choice(pool)


# ------------------------------------------------------------------------------------------------------------------------ customers
FIRST = ['Ana', 'Bea', 'Carlo', 'Dino', 'Elena', 'Fidel', 'Gina', 'Hector', 'Irene', 'Jun', 'Karla', 'Luis', 'Maya', 'Nico', 'Olive', 'Paolo', 'Quinn', 'Rina',
         'Sam', 'Tessa', 'Uriel', 'Vera', 'Wilma', 'Xavi', 'Yna', 'Zandro', 'Angeli', 'Benji', 'Cheska', 'Dante', 'Erika', 'Franco', 'Grace', 'Harold',
         'Ivy', 'Jomar', 'Kristine', 'Lorenzo', 'Marites', 'Nestor', 'Oscar', 'Pia', 'Ramon', 'Sheila', 'Tomas', 'Vivian', 'Wendell', 'Yvonne', 'Nino', 'Ines']
LAST = ['Abad', 'Bautista', 'Castillo', 'Dizon', 'Enriquez', 'Fernandez', 'Galang', 'Hernandez', 'Ilagan', 'Jacinto', 'Lacson', 'Magsaysay', 'Natividad',
        'Ocampo', 'Pascual', 'Quiambao', 'Robles', 'Salazar', 'Tolentino', 'Urbano', 'Valdez', 'Yap', 'Zamora', 'Aguilar', 'Borromeo', 'Concepcion',
        'Dela Cruz', 'Estrada', 'Florentino', 'Guevarra', 'Muñoz', 'Peña', 'Cabrera', 'Lim', 'Tan', 'Uy', 'Soriano', 'Manalo', 'Rivera', 'Lopez']
STREETS = ['Sampaguita', 'Mabini', 'Rizal', 'Bonifacio', 'Luna', 'Narra', 'Acacia', 'Molave', 'Ilang-Ilang', 'Kamagong']
CITIES = [('Quezon City', 'PH-00', '1100'), ('Manila', 'PH-00', '1000'), ('Makati', 'PH-00', '1200'), ('Pasig', 'PH-00', '1600'), ('Taguig', 'PH-00', '1630'),
          ('Cebu City', 'PH-CEB', '6000'), ('Davao City', 'PH-DAS', '8000'), ('Baguio', 'PH-BEN', '2600'), ('Iloilo City', 'PH-ILI', '5000'),
          ('San Fernando', 'PH-PAM', '2000'), ('Santa Rosa', 'PH-LAG', '4026'), ('Bacoor', 'PH-CAV', '4102'), ('Malolos', 'PH-BUL', '3000'),
          ('Cagayan de Oro', 'PH-MSR', '9000'), ('Bacolod', 'PH-NEC', '6100'), ('Antipolo', 'PH-RIZ', '1870')]
CITY_WEIGHTS = [10, 6, 5, 4, 3, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 2]
MIX = [('vip', 4), ('loyal', 14), ('occasional', 36), ('new', 14), ('lapsed_one', 24), ('lapsed_reg', 8), ('cancelled_only', 4), ('unpaid_only', 4), ('never', 4)]


def ascii_fold(text):
    return re.sub(r'[^a-z0-9]+', '', unicodedata.normalize('NFKD', text.lower()).encode('ascii', 'ignore').decode())


def make_customers():
    r = rng('customers')
    combos = [(f, l) for f in FIRST for l in LAST]
    r.shuffle(combos)
    out, n = [], 0
    for category, count in MIX:
        for _ in range(count):
            first, last = combos[n]
            n += 1
            city, province, postal = r.choices(CITIES, CITY_WEIGHTS)[0]
            assert province in PROVINCES
            cid = f'C{n:03d}'
            out.append({'customer_id': cid, 'name': f'{first} {last}', 'email': f'{ascii_fold(first)}.{ascii_fold(last)}.{n:03d}@example.test', 'category': category,
                        'street': f'{r.randint(1, 240)} {r.choice(STREETS)} Street', 'city': city, 'province': province, 'postal_code': postal,
                        'phone': f'0900 000 {n:04d}', 'registered_at': None, 'n': n})
    return out


# ------------------------------------------------------------------------------------------------------------------------ calendar
SEASON = {(2025, 10): 1.0, (2025, 11): 1.5, (2025, 12): 2.0, (2026, 1): 0.55, (2026, 2): 0.55, (2026, 3): 0.85, (2026, 4): 0.9, (2026, 5): 0.9, (2026, 6): 0.95,
          (2026, 7): 1.0, (2026, 8): 1.05, (2026, 9): 1.1, (2026, 10): 1.1}
WEEKDAY = [0.85, 0.85, 0.9, 1.0, 1.15, 1.5, 1.4]        # Monday first: weekends busy
HOURS = list(range(7, 24))
HOUR_W = [1, 1, 2, 3, 3, 3, 3, 3, 3, 4, 5, 6, 7, 7, 6, 3, 1]       # evenings are busiest


def day_weight(d):
    w = SEASON[(d.year, d.month)] * WEEKDAY[d.weekday()]
    if d.day in (15, 16, 30, 31):
        w *= 1.4           # payday bump
    elif d.day in (14, 29):
        w *= 1.2
    return w


ALL_DAYS = [FIRST_DAY + dt.timedelta(days=i) for i in range((LAST_DAY - FIRST_DAY).days + 1)]


def sample_days(r, lo, hi, n, gap):
    days = [d for d in ALL_DAYS if lo <= d <= hi]
    weights = [day_weight(d) for d in days]
    chosen = []
    for g in (gap, gap // 2, 1):
        attempts = 0
        while len(chosen) < n and attempts < 800:
            attempts += 1
            d = r.choices(days, weights)[0]
            if all(abs((d - c).days) >= g for c in chosen):
                chosen.append(d)
        if len(chosen) >= n:
            break
    return sorted(chosen)


def time_on(r, d, not_after=None):
    h = r.choices(HOURS, HOUR_W)[0]
    t = dt.datetime.combine(d, dt.time(h, r.randint(0, 59), r.randint(0, 59)), TZ)
    if not_after is not None and t > not_after:
        t = not_after - dt.timedelta(minutes=r.randint(20, 90))
    return t


# ------------------------------------------------------------------------------------------------------------------------ products
BASE = {'m-tee': 22, 'm-polo': 7, 'm-tank': 7, 'm-lslv': 6, 'm-vnek': 4, 'w-crop': 5, 'w-hood': 6, 'w-lslv': 5, 'w-polo': 4, 'w-tee': 6, 'w-tank': 4, 'k-jkt': 3,
        'k-polo': 3, 'k-tank': 2, 'k-lslv': 3, 'b-ones': 4, 'b-lson': 2, 'b-dres': 3, 'b-hood': 3}
SIZE_W = {'XS': 0.04, 'S': 0.18, 'M': 0.30, 'L': 0.28, 'XL': 0.16, 'XXL': 0.04}
COLOUR_W = {'Black': 0.28, 'White': 0.26, 'Navy': 0.18, 'Gray': 0.16, 'Red': 0.12}
STAR_SKU = 'W-TEE-BLK-M'        # S10: the variant that ends the year nearly out of stock while selling well
assert STAR_SKU in VARIANTS


def product_weight(slug, when):
    frac = (manila_date(when) - FIRST_DAY).days / 390.0
    w = float(BASE[slug])
    month = when.astimezone(TZ).month
    if slug == 'w-tee':
        w *= 0.6 + 4.4 * frac               # S02: climbs about eightfold over the year
    if slug == 'm-tank':
        w *= 3.0 - 2.55 * frac              # S03: fades to a tenth
    if slug in ('w-hood', 'k-jkt', 'm-lslv', 'w-lslv', 'k-lslv', 'b-lson') and month in (11, 12, 1, 2):
        w *= 1.8
    if slug in ('m-tank', 'w-tank', 'k-tank', 'w-crop') and month in (3, 4, 5):
        w *= 1.5
    if slug == 'b-hood' and month == 12:
        w *= 3.0                            # S01: gift season drains the baby hoodies
    return w


def variant_weight(sku):
    v = VARIANTS[sku]
    w = SIZE_W[v['size']] * COLOUR_W[v['colour']]
    return w * (4.0 if sku == STAR_SKU else 1.0)


SKUS_BY_SLUG = collections.defaultdict(list)
for _sku in SKUS:
    SKUS_BY_SLUG[VARIANTS[_sku]['slug']].append(_sku)
SLUGS = sorted(BASE)


# ------------------------------------------------------------------------------------------------------------------------ order plans
def plan_orders(customers):
    """The orders each customer places (when, how they pay, what kind of ending). Lines come later, from the stock ledger."""
    r = rng('plans')
    plans = []

    def add(cust, day_or_time, kind='normal', method=None, tags=()):
        placed = day_or_time if isinstance(day_or_time, dt.datetime) else time_on(r, day_or_time, CUTOFF)
        m = method or ('bank_transfer' if r.random() < 0.35 else 'cod')
        plans.append({'customer': cust['customer_id'], 'placed': placed, 'method': m, 'kind': kind, 'tags': set(tags), 'forced_close': None, 'forced': None,
                      'category': cust['category']})

    by = collections.defaultdict(list)
    for c in customers:
        by[c['category']].append(c)
    D = dt.date
    for c in by['vip']:
        first = sample_days(r, D(2025, 10, 4), D(2025, 11, 15), 1, 1)[0]
        last = sample_days(r, D(2026, 10, 12), D(2026, 10, 24), 1, 1)[0]
        mid = sample_days(r, first + 12 * DAY, D(2026, 10, 4), r.randint(11, 14) - 1, 12)
        for d in sorted({first, *mid, last}):
            add(c, d)
    for c in by['loyal']:
        n = r.randint(6, 9)
        first = sample_days(r, D(2025, 10, 2), D(2026, 2, 28), 1, 1)[0]
        recent = r.random() < 0.7
        last = sample_days(r, D(2026, 8, 25), D(2026, 10, 22), 1, 1)[0] if recent else sample_days(r, D(2026, 5, 1), D(2026, 7, 31), 1, 1)[0]
        mid = sample_days(r, first + 10 * DAY, last - 10 * DAY, n - 2, 14)
        for d in sorted({first, *mid, last}):
            add(c, d)
    for c in by['occasional']:
        lo = sample_days(r, D(2025, 10, 2), D(2026, 7, 15), 1, 1)[0]
        hi = min(lo + 150 * DAY, D(2026, 10, 24))
        for d in sample_days(r, lo, hi, r.randint(2, 4), 20):
            add(c, d)
    for c in by['new']:
        add(c, sample_days(r, D(2026, 9, 27), D(2026, 10, 14), 1, 1)[0])
    for c in by['lapsed_one']:
        add(c, sample_days(r, D(2025, 10, 2), D(2026, 3, 31), 1, 1)[0])
    for c in by['lapsed_reg']:
        for d in sample_days(r, D(2025, 10, 2), D(2026, 1, 20), r.randint(3, 5), 14):
            add(c, d)
    # S08, S15: customers whose orders were all cancelled
    kinds = [[('bank_paid_cancel', 'bank_transfer')], [('cod_cancel', 'cod')], [('bank_unpaid_cancel', 'bank_transfer')], [('cod_cancel', 'cod'), ('bank_unpaid_cancel', 'bank_transfer')]]
    for c, plan in zip(by['cancelled_only'], kinds):
        days = sample_days(r, D(2025, 11, 1), D(2026, 9, 15), len(plan), 30)
        for d, (kind, method) in zip(days, plan):
            add(c, d, kind, method, ('S15',) if kind == 'bank_paid_cancel' else ('S08',))
    # S09: unpaid bank transfers, 2 / 5 / 10 / 20 days before the as-of day, 13:00 (ages at the end of the as-of day: 2.5, 5.5, 10.5, 20.5 days)
    for c, k in zip(by['unpaid_only'], (2, 5, 10, 20)):
        add(c, dt.datetime.combine(AS_OF - k * DAY, dt.time(13, 0, r.randint(0, 59)), TZ), 'unpaid_forever', 'bank_transfer', ('S09',))

    # S19: orders still on their way at the cutoff (placed in the last week, so every state exists at 2026-10-26 09:00)
    r4 = rng('plans-inflight')
    pool = sorted([c for c in customers if c['category'] in ('vip', 'loyal', 'occasional')], key=lambda c: c['customer_id'])
    for c in r4.sample(pool, 12):
        day = r4.choices([D(2026, 10, 20) + k * DAY for k in range(7)], [1, 1, 2, 2, 3, 3, 2])[0]
        add(c, day, 'normal', None, ('S19',))
    # two orders that are out for delivery at the cutoff: shipped on Friday 23 Oct, out for delivery on Saturday 24 Oct, delivery due after the cutoff
    for c, placed, ship, ofd in ((by['occasional'][2], at(2026, 10, 22, 19, 10, 5), at(2026, 10, 23, 11, 20, 0), at(2026, 10, 24, 10, 5, 0)),
                                 (by['loyal'][3], at(2026, 10, 22, 21, 30, 44), at(2026, 10, 23, 14, 5, 0), at(2026, 10, 24, 11, 40, 0))):
        add(c, placed, 'normal', 'cod', ('S19',))
        plans[-1]['forced'] = {'ship': ship, 'ofd': ofd}
    normal = lambda p: p['kind'] == 'normal' and not p['tags']
    # a few cancelled orders among customers who have other orders (not their first or last order)
    pool = sorted([p for p in plans if normal(p) and p['category'] in ('occasional', 'loyal') and dt.datetime(2025, 11, 5, tzinfo=TZ) < p['placed'] < at(2026, 9, 20)],
                  key=lambda p: (p['placed'], p['customer']))
    r2 = rng('plans-cancel')
    for p, (kind, method) in zip(r2.sample(pool, 8), [('cod_cancel', 'cod')] * 3 + [('bank_unpaid_cancel', 'bank_transfer')] * 3 + [('bank_paid_cancel', 'bank_transfer')] * 2):
        p['kind'], p['method'] = kind, method
        p['tags'].add('S15' if kind == 'bank_paid_cancel' else 'S08')
    # S13: two orders closed across a month end (Manila): confirmed at 23:50 on 31 March and 00:20 on 1 April
    occ = by['occasional']
    add(occ[0], at(2026, 3, 24, 14, 20, 11), 'normal', 'cod', ('S13',))
    add(occ[1], at(2026, 3, 25, 19, 40, 37), 'normal', 'cod', ('S13',))
    plans[-2]['forced_close'] = at(2026, 3, 31, 23, 50, 0)
    plans[-1]['forced_close'] = at(2026, 4, 1, 0, 20, 0)
    # S14: an Administrator steps an order back (out for delivery -> shipped), S16: two staff press the same move
    r3 = rng('plans-tags')
    pool = sorted([p for p in plans if normal(p) and p['method'] == 'cod' and p['category'] == 'loyal' and at(2026, 1, 5) < p['placed'] < at(2026, 3, 10)], key=lambda p: (p['placed'], p['customer']))
    for p in r3.sample(pool, 2):
        p['tags'].add('S14')
    pool = sorted([p for p in plans if normal(p) and p['category'] == 'occasional' and at(2026, 5, 1) < p['placed'] < at(2026, 7, 31)], key=lambda p: (p['placed'], p['customer']))
    for p in r3.sample(pool, 2):
        p['tags'].add('S16')
    # S12: designed garments (the customization fee is not demand)
    pool = sorted([p for p in plans if normal(p) and p['placed'] > at(2025, 11, 1)], key=lambda p: (p['placed'], p['customer']))
    for p in r3.sample(pool, 24):
        p['tags'].add('S12')
    plans.sort(key=lambda p: (p['placed'], p['customer']))
    for i, p in enumerate(plans, 1):
        p['order_id'] = f'O{i:04d}'
    return plans


# ------------------------------------------------------------------------------------------------------------------------ lifecycles
def cron_run_at_or_after(t):
    run = dt.datetime.combine(t.astimezone(TZ).date(), CRON_AT, TZ)
    return run if run >= t else run + DAY


def build_events(plan, r):
    """The moves of one order, each by a named employee inside their working hours. Events after the cutoff are dropped by the caller."""
    evs = []
    INV, ADM = {'inventory'}, {'admin'}

    def add(when, frm, to, actor, emp='', cust='', note='', back=False, outcome='done'):
        evs.append({'at': when, 'from': frm, 'to': to, 'actor': actor, 'employee': emp, 'customer': cust, 'note': note, 'back': back, 'outcome': outcome})

    t, kind, bank, tags = plan['placed'], plan['kind'], plan['method'] == 'bank_transfer', plan['tags']
    if kind == 'unpaid_forever':
        return evs
    if bank and kind == 'bank_unpaid_cancel':
        tc, e = slot(r, INV, t + dt.timedelta(days=r.randint(3, 10)))
        add(tc, 'awaiting_payment', 'cancelled', 'staff', e.id, note='Payment not received; order cancelled')
        return evs
    base = t
    if bank:
        hours = r.choices([(2, 20), (20, 72), (72, 170)], [60, 30, 10])[0]
        tp, e = slot(r, INV, t + dt.timedelta(hours=r.uniform(*hours)))
        add(tp, 'awaiting_payment', 'confirmed', 'staff', e.id)
        base = tp
    if kind == 'cod_cancel':
        tc, e = slot(r, INV, base + dt.timedelta(hours=r.uniform(1, 30)))
        add(tc, 'confirmed', 'cancelled', 'staff', e.id, note='Customer asked to cancel before shipping')
        return evs
    if kind == 'bank_paid_cancel':
        tc, e = slot(r, ADM, base + dt.timedelta(hours=r.uniform(2, 40)))
        add(tc, 'confirmed', 'cancelled', 'staff', e.id, note=r.choice(['Customer asked to cancel; the bank refund is to be sent by Rafael', 'Wrong size ordered; refund to be arranged by the owner']))
        return evs
    if plan.get('forced'):
        ts, e1 = exact(r, INV, plan['forced']['ship'])
        add(ts, 'confirmed', 'shipped', 'staff', e1.id)
        to, e = exact(r, INV, plan['forced']['ofd'])
        add(to, 'shipped', 'out_for_delivery', 'staff', e.id)
        return evs
    ts, e1 = slot(r, INV, base + dt.timedelta(hours=r.uniform(3, 28)))
    add(ts, 'confirmed', 'shipped', 'staff', e1.id)
    if 'S16' in tags:
        e2 = r.choice([e for e in EMPLOYEES if e.role == 'inventory' and e.id != e1.id and e.active_at(ts)])
        add(ts + dt.timedelta(seconds=r.randint(40, 95)), 'confirmed', 'shipped', 'staff', e2.id, outcome='state_changed')
    to, e = slot(r, INV, ts + dt.timedelta(hours=r.uniform(2, 30)))
    add(to, 'shipped', 'out_for_delivery', 'staff', e.id)
    if 'S14' in tags:
        ta, ea = slot(r, ADM, to + dt.timedelta(hours=r.uniform(1.5, 5)))
        add(ta, 'out_for_delivery', 'shipped', 'staff', ea.id, note='Courier returned the parcel; delivery to be rebooked', back=True)
        to, e = slot(r, INV, ta + dt.timedelta(hours=r.uniform(14, 30)))
        add(to, 'shipped', 'out_for_delivery', 'staff', e.id)
    td, e = slot(r, INV, to + dt.timedelta(hours=r.uniform(2, 40)))
    add(td, 'out_for_delivery', 'delivered', 'staff', e.id)
    auto = cron_run_at_or_after(td + AUTO_CLOSE)
    if plan['forced_close'] is not None:
        add(plan['forced_close'], 'delivered', 'closed', 'customer', cust=plan['customer'])
    elif r.random() < 0.6:
        tc = td + dt.timedelta(hours=2 + r.expovariate(1 / 30.0))
        tc = min(tc, td + dt.timedelta(days=6, hours=20)).replace(microsecond=0)
        add(tc, 'delivered', 'closed', 'customer', cust=plan['customer'])
    else:
        add(auto, 'delivered', 'closed', 'automatic')
    return evs


def finish_order(plan, evs):
    """Trim to the cutoff and work out the state the order is in then."""
    kept = []
    for ev in evs:
        if ev['at'] > CUTOFF:
            break
        kept.append(ev)
    state = 'awaiting_payment' if plan['method'] == 'bank_transfer' else 'confirmed'
    closed_at, closed_by = None, ''
    for ev in kept:
        if ev['outcome'] == 'done':
            state = ev['to']
            if ev['to'] == 'closed':
                closed_at, closed_by = ev['at'], 'customer' if ev['actor'] == 'customer' else 'automatic'
    return kept, state, closed_at, closed_by


# ------------------------------------------------------------------------------------------------------------------------ designs
def make_design(r, sku, number):
    """A design on this garment: 1 to 3 rectangles inside the print box, priced with the shop's own fee module (pure Python)."""
    v = VARIANTS[sku]
    prod = PRODUCTS[v['slug']]
    box = {'x': float(prod['print_x']), 'y': float(prod['print_y']), 'width': float(prod['print_w']), 'height': float(prod['print_h'])}
    layers = []
    for i in range(r.choice([1, 1, 2, 3])):
        w, h = round(box['width'] * r.uniform(0.2, 0.65), 2), round(box['height'] * r.uniform(0.15, 0.55), 2)
        layers.append({'layer_no': i + 1, 'x': round(box['x'] + box['width'] * r.uniform(0.3, 0.7), 2), 'y': round(box['y'] + box['height'] * r.uniform(0.25, 0.7), 2),
                       'width': w, 'height': h, 'rotation': r.choice([0, 0, 0, 90]), 'opacity': 1, 'visible': True})
    elements = [{'id': f'layer-{l["layer_no"]}', **{k: l[k] for k in ('x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible')}} for l in layers]
    price = FEE.price(elements, box, float(prod['reference_sq_in']), RATE, STEP, v['size'])
    return {'design_id': f'D{number:03d}', 'sku': sku, 'slug': v['slug'], 'layers': layers, 'covered_sq_in': price['covered_sq_in'], 'fee': price['fee'],
            'colour': r.choice(['#1e5aa0', '#b03030', '#2e7d4f', '#d4a017', '#5b3a8c'])}


# ------------------------------------------------------------------------------------------------------------------------ restock plan
PROMISED = {'SUP1': (5, 8), 'SUP2': (7, 10), 'SUP3': (4, 7)}
RESTOCK_PLAN = [
    ('SUP1', '2025-11-04', 'normal'), ('SUP1', '2025-11-24', 'normal'), ('SUP1', '2025-12-18', 'normal'), ('SUP1', '2026-01-20', 'normal'), ('SUP1', '2026-02-24', 'normal'),
    ('SUP1', '2026-03-24', 'normal'), ('SUP1', '2026-04-28', 'rejected'), ('SUP1', '2026-06-02', 'normal'), ('SUP1', '2026-07-07', 'normal'), ('SUP1', '2026-08-11', 'normal'),
    ('SUP1', '2026-09-15', 'normal'), ('SUP1', '2026-10-22', 'open_unavailable'), ('SUP1', '2026-10-24', 'pending'),
    ('SUP2', '2025-11-06', 'normal'), ('SUP2', '2025-11-27', 'normal'), ('SUP2', '2025-12-18', 'baby_hoodie'), ('SUP2', '2026-01-27', 'normal'), ('SUP2', '2026-03-03', 'not_received'),
    ('SUP2', '2026-04-07', 'normal'), ('SUP2', '2026-05-12', 'rejected'), ('SUP2', '2026-06-16', 'normal'), ('SUP2', '2026-07-21', 'normal'), ('SUP2', '2026-08-25', 'normal'),
    ('SUP2', '2026-09-24', 'open_overdue'),
    ('SUP3', '2025-11-12', 'normal'), ('SUP3', '2025-12-30', 'normal'), ('SUP3', '2026-02-17', 'normal'), ('SUP3', '2026-04-14', 'normal'), ('SUP3', '2026-06-23', 'normal'),
    ('SUP3', '2026-08-18', 'normal'), ('SUP3', '2026-10-23', 'open_ok'),
]
LEADS = {'SUP1': [5, 6, 6, 6, 7, 7, 7, 8, 8, 9], 'SUP2': list(range(14, 22)), 'SUP3': [4, 5, 5, 6, 7]}     # days from approval to the goods arriving
UNAVAILABLE = {'SUP1': (dt.date(2026, 11, 3), dt.date(2026, 11, 10), at(2026, 10, 20, 10, 5)), 'SUP3': (dt.date(2026, 1, 15), dt.date(2026, 1, 24), at(2026, 1, 12, 9, 40))}
RESTOCK_REASONS_REJECT = ['Stock is enough for this month', 'Quantities too high for the sales we have; request again smaller']
MIN_PARTIAL = (3, 9)       # which "normal" restocks arrive short on their first line


def plan_restock_requests():
    r = rng('restock-plan')
    items = []
    for i, (sup, day, mode) in enumerate(RESTOCK_PLAN):
        d = dt.date.fromisoformat(day)
        if mode == 'normal':
            d += dt.timedelta(days=r.randint(-2, 2))
        t0 = dt.datetime.combine(d, dt.time(8, 30), TZ)
        t, emp = slot(r, {'inventory'}, t0, allow_late=False)
        items.append({'supplier': sup, 'mode': mode, 't_req': t, 'emp': emp, 'index': i})
    return items


def plan_stock_edits():
    """Counts and write-downs by staff. Targets of the planted ones are fixed; the ordinary counts pick a variant and a small difference when they run."""
    r = rng('edit-plan')
    edits = []
    # S01: water damage in the storage room wrote the baby hoodies down on 3 December; on 17 December the last packs were written off
    bh = sorted(SKUS_BY_SLUG['b-hood'])
    for k, sku in enumerate(bh):
        edits.append({'at': at(2025, 12, 3, 14, 10 + 2 * k), 'emp': EMP['E01'], 'sku': sku, 'target': [1, 1, 0, 1, 0, 0, 0, 0, 0][k % 9], 'tag': 'S01',
                      'reason': 'Water damage in the storage room: damaged units written off'})
    for k, sku in enumerate(bh):
        edits.append({'at': at(2025, 12, 17, 16, 0 + 2 * k), 'emp': EMP['E01'], 'sku': sku, 'target': 0, 'tag': 'S01',
                      'reason': 'Cycle count: the last packs were water stained and written off'})
    # S10: the best-selling women's tee ends the year with one sellable unit
    edits.append({'at': at(2026, 10, 24, 16, 30), 'emp': EMP['E02'], 'sku': STAR_SKU, 'target': 1, 'tag': 'S10',
                  'reason': 'Cycle count: damaged and missing units written off; one sellable unit left'})
    days = [d for d in ALL_DAYS if dt.date(2025, 11, 3) <= d <= dt.date(2026, 10, 16) and d.weekday() < 5]
    for d in sorted(r.sample(days, 26)):
        t, emp = slot(r, {'inventory'}, dt.datetime.combine(d, dt.time(9, 0), TZ), allow_late=False)
        edits.append({'at': t, 'emp': emp, 'sku': None, 'target': None, 'tag': '', 'reason': None})
    edits.sort(key=lambda e: e['at'])
    return edits


COUNT_DOWN = ['Cycle count: one damaged unit written off', 'Cycle count: one unit found stained in packing', 'Cycle count: a unit lost in transit to a customer is written off']
COUNT_UP = ['Cycle count: one unit found on the wrong shelf', 'Cycle count: an unrecorded unit found while packing']


# ------------------------------------------------------------------------------------------------------------------------ the sweep
def sweep(plans, restock_items, edits):
    """One pass through the year in time order, with a stock ledger (on hand and reserved per variant). Returns the finished orders and the rest."""
    r_lines, r_design, r_stock = rng('lines'), rng('designs'), rng('stock')
    onhand = {s: VARIANTS[s]['opening'] for s in SKUS}
    reserved = collections.defaultdict(int)
    incoming = collections.defaultdict(int)
    sold = collections.defaultdict(list)
    day_end, cur = {}, [dt.date(2025, 9, 30)]
    heap, seq = [], itertools.count()
    stats = collections.Counter()
    designs, restocks, adjustments, orders = [], [], [], []
    ledger_log = []          # (when, kind, sku, delta) for the summary

    def roll(d):
        while cur[0] < d:
            day_end[cur[0]] = dict(onhand)
            cur[0] += DAY

    def push(when, prio, kind, ref):
        heapq.heappush(heap, (when, prio, next(seq), kind, ref))

    def free(s):
        return onhand[s] - reserved[s]

    for p in plans:
        push(p['placed'], 3, 'place', p)
    for it in restock_items:
        push(it['t_req'], 1, 'restock', it)
    for ed in edits:
        push(ed['at'], 0, 'edit', ed)
    for b in BASELINE:             # the shop's two own test orders: their units left the stock on 24 October
        for part in b['garment_lines'].split():
            sku, n = part.rsplit('x', 1)
            push(at(2026, 10, 24, 12 if b['order'] == 'S00001' else 19, 30), 2, 'base_ship', (sku, int(n)))

    def recent(sku, now, days=90):
        lo = manila_date(now) - dt.timedelta(days=days)
        return sum(q for d, q in sold[sku] if d >= lo)

    def choose_lines(when, designed):
        taken = collections.Counter()
        lines, used = [], set()
        for i in range(r_lines.choices([1, 2, 3], [55, 33, 12])[0]):
            weights = []
            for slug in SLUGS:
                ok = any(free(s) - taken[s] >= 1 and s not in used for s in SKUS_BY_SLUG[slug])
                weights.append(product_weight(slug, when) if ok else 0.0)
            if sum(weights) == 0:
                stats['no stock for a line'] += 1
                break
            slug = r_lines.choices(SLUGS, weights)[0]
            cands = [s for s in SKUS_BY_SLUG[slug] if free(s) - taken[s] >= 1 and s not in used]
            sku = r_lines.choices(cands, [variant_weight(s) for s in cands])[0]
            qty = min(r_lines.choices([1, 2, 3], [80, 17, 3])[0], free(sku) - taken[sku])
            if designed and i == 0:
                qty = 1
            lines.append({'sku': sku, 'qty': qty, 'designed': designed and i == 0})
            taken[sku] += qty
            used.add(sku)
        return lines

    def choose_restock_lines(it, sup):
        r = r_stock
        cands = sorted(s for s in SKUS if supply_cost(sup, s) is not None)
        if it['mode'] == 'baby_hoodie':
            return [(s, 12) for s in SKUS_BY_SLUG['b-hood'] if s in cands]
        now = it['t_req']
        ranked = sorted(cands, key=lambda s: (-(recent(s, now) / (onhand[s] + incoming[s] + 2.0)), s))
        k = r.randint(3, 6)
        picked = [s for s in ranked if recent(s, now) > 0][:k]
        for s in sorted(cands, key=lambda s: (onhand[s], s)):
            if len(picked) >= k:
                break
            if s not in picked and onhand[s] <= 8:
                picked.append(s)
        return [(s, max(6, min(14, int(round(recent(s, now) * 1.2)) + 6))) for s in sorted(picked)]

    def do_restock(it):
        r = r_stock
        sup, mode = it['supplier'], it['mode']
        pmin, pmax = PROMISED[sup]
        req_day = manila_date(it['t_req'])
        lines = choose_restock_lines(it, sup)
        if not lines:
            stats['restock without lines'] += 1
            return
        ships = SUPPLIERS[sup]['ships'] == 'yes'
        rec = {'supplier': sup, 'mode': mode, 't_req': it['t_req'], 'requested_by': it['emp'].id, 'expected_from': req_day + dt.timedelta(days=pmin),
               'expected_to': req_day + dt.timedelta(days=pmax), 'shipping_on': ships and r.random() < 0.5, 'shipping_fee': float(SUPPLIERS[sup]['shipping_fee']),
               'lines': [{'sku': s, 'qty': q, 'unit_cost': supply_cost(sup, s), 'received': 0} for s, q in lines], 'decision': '', 'decided_at': None, 'decided_by': '',
               'decision_note': '', 'outcome': 'requested', 'not_received_at': None, 'not_received_by': '', 'received_on': None, 'received_at': None, 'received_by': '',
               'request_note': {'baby_hoodie': 'Restock after the water damage: all baby hoodies', 'open_overdue': 'Regular restock', 'pending': 'Waiting for approval'}.get(mode, 'Regular restock')}
        if mode == 'pending':
            restocks.append(rec)
            return
        for _try in range(40):          # an approval must fall inside the data (before the cutoff); near the end the next shift may not
            ta, adm = slot(r, {'admin'}, it['t_req'] + dt.timedelta(hours=r.uniform(1, 30)))
            if ta <= CUTOFF:
                break
        else:
            stats['restock approval after the cutoff: stays requested'] += 1
            restocks.append(rec)
            return
        if mode == 'rejected':
            rec.update(decision='rejected', decided_at=ta, decided_by=adm.id, decision_note=RESTOCK_REASONS_REJECT[len(restocks) % 2], outcome='rejected')
            restocks.append(rec)
            return
        rec.update(decision='approved', decided_at=ta, decided_by=adm.id, decision_note='ok', outcome='approved')
        if mode == 'open_unavailable':
            rec['expected_from'], rec['expected_to'] = dt.date(2026, 11, 2), dt.date(2026, 11, 6)
        if mode in ('open_unavailable', 'open_overdue', 'open_ok'):
            for l in rec['lines']:
                incoming[l['sku']] += l['qty']
            restocks.append(rec)
            return
        decided_day = manila_date(ta)
        if mode == 'baby_hoodie':
            received_on = dt.date(2026, 1, 24)
        elif mode == 'not_received':
            tn, adm2 = slot(r, {'admin'}, dt.datetime.combine(rec['expected_to'] + 3 * DAY, dt.time(10, 0), TZ))
            rec.update(not_received_at=tn, not_received_by=adm2.id, outcome='not_received')
            received_on = decided_day + dt.timedelta(days=pmax + 9)
        else:
            received_on = decided_day + dt.timedelta(days=r.choice(LEADS[sup]))
        tr, adm3 = slot(r, {'admin'}, dt.datetime.combine(received_on, dt.time(13, 30), TZ), allow_late=False)
        if tr > CUTOFF:
            stats['restock received after the cutoff stays open'] += 1
            for l in rec['lines']:
                incoming[l['sku']] += l['qty']
            restocks.append(rec)
            return
        rec.update(received_on=received_on, received_at=tr, received_by=adm3.id, outcome='received')
        normal_index = sum(1 for x in restocks if x['mode'] == 'normal')
        if mode == 'normal' and normal_index in MIN_PARTIAL:
            rec['lines'][0]['received'] = max(1, rec['lines'][0]['qty'] - 3)
            rest = rec['lines'][1:]
        else:
            rest = rec['lines']
        for l in rest:
            l['received'] = l['qty']
        for l in rec['lines']:
            incoming[l['sku']] += l['qty']
        restocks.append(rec)
        push(tr, 1, 'receipt', rec)

    def do_edit(ed):
        sku, target = ed['sku'], ed['target']
        reason = ed['reason']
        if sku is None:
            cands = sorted(s for s in SKUS if onhand[s] >= 4 and free(s) >= 3)
            sku = r_stock.choice(cands)
            if r_stock.random() < 0.7:
                target, reason = onhand[sku] - r_stock.randint(1, 3), r_stock.choice(COUNT_DOWN)
            else:
                target, reason = onhand[sku] + r_stock.randint(1, 2), r_stock.choice(COUNT_UP)
        target = max(target, reserved[sku])
        if target == onhand[sku]:
            stats['count skipped (already that number)'] += 1
            return
        adjustments.append({'at': ed['at'], 'emp': ed['emp'].id, 'sku': sku, 'old': onhand[sku], 'new': target, 'reason': reason, 'tag': ed['tag']})
        ledger_log.append((ed['at'], 'count', sku, target - onhand[sku]))
        onhand[sku] = target

    while heap:
        when, _prio, _n, kind, ref = heapq.heappop(heap)
        roll(manila_date(when))
        if kind == 'place':
            p = ref
            designed = 'S12' in p['tags']
            lines = choose_lines(p['placed'], designed)
            if not lines:
                stats['order dropped (no stock)'] += 1
                p['dropped'] = True
                continue
            p['lines'] = []
            for l in lines:
                price = VARIANTS[l['sku']]['unit_price']
                line = {'sku': l['sku'], 'qty': l['qty'], 'unit_price': price, 'design': None, 'fee': 0.0}
                if l['designed']:
                    d = make_design(r_design, l['sku'], len(designs) + 1)
                    d.update(customer=p['customer'], order_id=p['order_id'], created_at=p['placed'] - dt.timedelta(minutes=r_design.randint(10, 45)))
                    designs.append(d)
                    line.update(design=d['design_id'], fee=d['fee'])
                p['lines'].append(line)
                reserved[l['sku']] += l['qty']
                if p['kind'] not in ('cod_cancel', 'bank_unpaid_cancel', 'bank_paid_cancel'):
                    sold[l['sku']].append((manila_date(p['placed']), l['qty']))
            p['amount'] = round(sum(l['unit_price'] * l['qty'] + l['fee'] * l['qty'] for l in p['lines']), 2)
            orders.append(p)
            for ev in p['events']:
                if ev['outcome'] == 'done' and ev['to'] in ('shipped', 'cancelled') and ev['from'] != 'out_for_delivery':
                    push(ev['at'], 2, 'ship' if ev['to'] == 'shipped' else 'cancel', p)
        elif kind == 'ship':
            for l in ref['lines']:
                onhand[l['sku']] -= l['qty']
                reserved[l['sku']] -= l['qty']
                ledger_log.append((when, 'ship', l['sku'], -l['qty']))
                assert onhand[l['sku']] >= 0 and reserved[l['sku']] >= 0, (l, when)
        elif kind == 'cancel':
            for l in ref['lines']:
                reserved[l['sku']] -= l['qty']
        elif kind == 'base_ship':
            onhand[ref[0]] -= ref[1]
            ledger_log.append((when, 'ship', ref[0], -ref[1]))
        elif kind == 'restock':
            do_restock(ref)
        elif kind == 'receipt':
            for l in ref['lines']:
                incoming[l['sku']] -= l['qty']
                onhand[l['sku']] += l['received']
                ledger_log.append((when, 'receipt', l['sku'], l['received']))
        elif kind == 'edit':
            do_edit(ref)
    roll(LAST_DAY + DAY)
    return orders, designs, restocks, adjustments, day_end, dict(onhand), dict(reserved), stats, ledger_log


# ------------------------------------------------------------------------------------------------------------------------ writing
FILES = collections.OrderedDict()          # name -> (header, rows)


def put(name, header, rows):
    FILES[name] = (header, rows)


def write_all():
    for name, (header, rows) in FILES.items():
        path = os.path.join(OUT, name)
        with open(path, 'w', encoding='utf-8-sig', newline='') as handle:
            writer = csv.writer(handle, lineterminator='\r\n')
            writer.writerow(header)
            writer.writerows(rows)


def yn(flag):
    return 'yes' if flag else 'no'


def assign_registrations(customers, orders):
    r = rng('registration')
    first = {}
    for o in sorted(orders, key=lambda o: o['placed']):
        first.setdefault(o['customer'], o['placed'])
    floor_t = at(2025, 10, 1, 0, 30)
    for c in customers:
        if c['customer_id'] in first:
            t = first[c['customer_id']]
            reg = t - dt.timedelta(days=r.randint(1, 20), hours=r.uniform(0, 6)) if r.random() < 0.3 else t - dt.timedelta(minutes=r.randint(6, 50))
            reg = max(reg, floor_t)
            if reg >= t - 3 * MIN:
                reg = t - 10 * MIN
        else:
            reg = time_on(r, r.choices(ALL_DAYS[:-3], [day_weight(d) for d in ALL_DAYS[:-3]])[0])
        c['registered_at'] = reg.replace(microsecond=0)


def build_files(customers, orders, designs, restocks, adjustments):
    # employees
    put('employees.csv', ['employee_id', 'name', 'email', 'role', 'job_title', 'hired_at', 'left_at', 'work_days', 'shift_start', 'shift_end', 'status_at_end'],
        [[e.id, e.name, e.email, e.role, e.title, iso(e.hired), iso(e.left) if e.left else '', days_text(e.days),
          e.start.strftime('%H:%M'), e.end.strftime('%H:%M'), 'archived' if e.left else 'active'] for e in EMPLOYEES])
    put('customers.csv', ['customer_id', 'name', 'email', 'plan', 'registered_at', 'delivery_street', 'delivery_city', 'delivery_province', 'delivery_postal_code', 'phone'],
        [[c['customer_id'], c['name'], c['email'], c['category'], iso(c['registered_at']), c['street'], c['city'], c['province'], c['postal_code'], c['phone']]
         for c in customers])
    tags = lambda o: ';'.join(sorted(o['tags']))
    put('orders.csv', ['order_id', 'client_order_ref', 'customer_id', 'placed_at', 'payment_method', 'final_state', 'closed_by', 'designed', 'units', 'expected_amount_total',
                       'scenarios'],
        [[o['order_id'], 'pack:' + o['order_id'], o['customer'], iso(o['placed']), o['method'], o['state'], o['closed_by'], yn(any(l['design'] for l in o['lines'])),
          sum(l['qty'] for l in o['lines']), money(o['amount']), tags(o)] for o in orders])
    rows = []
    for o in orders:
        for n, l in enumerate(o['lines'], 1):
            rows.append([o['order_id'], n, l['sku'], l['qty'], money(l['unit_price']), l['design'] or '', money(l['fee']) if l['design'] else '',
                         money((l['unit_price'] + l['fee']) * l['qty'])])
    put('order_lines.csv', ['order_id', 'line_no', 'sku', 'quantity', 'unit_price', 'design_id', 'print_fee_each', 'line_total'], rows)
    events = []
    for o in orders:
        for ev in o['events']:
            events.append((ev['at'], o['order_id'], ev, o))
    events.sort(key=lambda x: (x[0], x[1]))
    erows = []
    for i, (when, oid, ev, o) in enumerate(events, 1):
        sc = ';'.join(sorted(o['tags'] & {'S13', 'S14', 'S15', 'S16'})) if (ev['back'] or ev['outcome'] != 'done' or ev['note'] or 'S13' in o['tags']) else ''
        erows.append([f'V{i:04d}', oid, iso(when), ev['from'], ev['to'], ev['actor'], ev['employee'], ev['customer'], ev['note'], yn(ev['back']), ev['outcome'], sc])
    put('order_events.csv', ['event_id', 'order_id', 'at', 'from_state', 'to_state', 'actor_type', 'employee_id', 'customer_id', 'note', 'step_back', 'expected_outcome',
                             'scenarios'], erows)
    prow = []
    for o in orders:
        evs = [e for e in o['events'] if e['outcome'] == 'done']
        if o['method'] == 'cod':
            delivered = next((e['at'] for e in evs if e['to'] == 'delivered'), None)
            state = 'cancelled' if o['state'] == 'cancelled' else ('done' if delivered else 'pending')
            prow.append([o['order_id'], 'cod', money(o['amount']), state, iso(delivered) if delivered else '', 'cash collected at delivery' if delivered else ''])
        else:
            paid = next((e for e in evs if e['from'] == 'awaiting_payment' and e['to'] == 'confirmed'), None)
            state = 'done' if paid else ('cancelled' if o['state'] == 'cancelled' else 'pending')
            note = 'REFUND DUE: paid, then cancelled' if (paid and o['state'] == 'cancelled') else ''
            prow.append([o['order_id'], 'bank_transfer', money(o['amount']), state, iso(paid['at']) if paid else '', (paid['employee'] if paid else '') + ((' ' + note) if note else '')])
    put('payments.csv', ['order_id', 'method', 'amount', 'payment_state_at_end', 'paid_at', 'recorded_by_or_note'], prow)
    put('designs.csv', ['design_id', 'customer_id', 'order_id', 'sku', 'slug', 'created_at', 'layer_count', 'covered_sq_in', 'print_fee_each', 'picture_colour'],
        [[d['design_id'], d['customer'], d['order_id'], d['sku'], d['slug'], iso(d['created_at']), len(d['layers']), money(d['covered_sq_in']), money(d['fee']), d['colour']]
         for d in designs])
    put('design_layers.csv', ['design_id', 'layer_no', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible'],
        [[d['design_id'], l['layer_no'], l['x'], l['y'], l['width'], l['height'], l['rotation'], l['opacity'], 'yes'] for d in designs for l in d['layers']])
    behaviour = {'SUP1': 'Reliable: delivers about when promised.', 'SUP2': 'LATE: usually 14 to 21 days against a promised 7 to 10 (one 36-day delivery after the water damage).',
                 'SUP3': 'Reliable and quick; does not ship (no shipping fee).'}
    srows = []
    for sid in sorted(SUPPLIERS):
        s = SUPPLIERS[sid]
        un = UNAVAILABLE.get(sid)
        srows.append([sid, s['name'], s['ships'], s['shipping_fee'], PROMISED[sid][0], PROMISED[sid][1], behaviour[sid], '5-11' if sid == 'SUP1' else ('14-21' if sid == 'SUP2' else '4-7'),
                      un[0].isoformat() if un else '', un[1].isoformat() if un else '', iso(un[2]) if un else '', 'E07' if un else ''])
    put('suppliers.csv', ['supplier_id', 'name', 'ships', 'shipping_fee', 'promised_days_min', 'promised_days_max', 'planned_behaviour', 'typical_actual_days',
                          'unavailable_from', 'unavailable_to', 'unavailable_entered_at', 'entered_by'], srows)
    rr, rl, rc = [], [], []
    for i, rec in enumerate(sorted(restocks, key=lambda x: (x['t_req'], x['supplier'])), 1):
        rec['restock_id'] = f'R{i:03d}'
        goods = round(sum(l['unit_cost'] * l['received'] for l in rec['lines']), 2)
        ship = rec['shipping_fee'] if (rec['shipping_on'] and SUPPLIERS[rec['supplier']]['ships'] == 'yes' and rec['outcome'] == 'received') else 0.0
        rec['goods'], rec['shipping'], rec['actual'] = goods, ship, round(goods + ship, 2)
        rr.append([rec['restock_id'], rec['supplier'], rec['requested_by'], iso(rec['t_req']), rec['expected_from'].isoformat(), rec['expected_to'].isoformat(), yn(rec['shipping_on']),
                   money(rec['shipping_fee']) if rec['shipping_on'] else '', rec['request_note'], rec['decision'], iso(rec['decided_at']) if rec['decided_at'] else '', rec['decided_by'],
                   rec['decision_note'], iso(rec['not_received_at']) if rec['not_received_at'] else '', rec['not_received_by'], rec['outcome'], rec['mode'],
                   money(rec['actual']) if rec['outcome'] == 'received' else ''])
        for n, l in enumerate(rec['lines'], 1):
            rl.append([rec['restock_id'], n, l['sku'], l['qty'], money(l['unit_cost'])])
            if rec['outcome'] == 'received':
                late = max(0, (rec['received_on'] - rec['expected_to']).days)
                rc.append([rec['restock_id'], l['sku'], l['received'], f"PK-{rec['restock_id']}-{l['sku']}", rec['received_on'].isoformat(), iso(rec['received_at']), rec['received_by'], late])
    put('restock_requests.csv', ['restock_id', 'supplier_id', 'requested_by', 'requested_at', 'expected_from', 'expected_to', 'shipping_on', 'shipping_fee', 'request_note',
                                 'decision', 'decided_at', 'decided_by', 'decision_note', 'not_received_at', 'not_received_by', 'outcome', 'planned_as', 'actual_cost'], rr)
    put('restock_lines.csv', ['restock_id', 'line_no', 'sku', 'quantity', 'unit_cost'], rl)
    put('receipts.csv', ['restock_id', 'sku', 'quantity_received', 'lot_name', 'received_on', 'received_at', 'received_by', 'days_after_expected_end'], rc)
    put('stock_adjustments.csv', ['adjustment_id', 'at', 'employee_id', 'sku', 'old_quantity', 'new_quantity', 'reason', 'scenario'],
        [[f'A{i:03d}', iso(a['at']), a['emp'], a['sku'], a['old'], a['new'], a['reason'], a['tag']] for i, a in enumerate(adjustments, 1)])
    put('reference/baseline_note.csv', ['note'], [['The reference/ files are facts copied from the dump by scripts/pack_extract_baseline.py; see README.md']])


# ------------------------------------------------------------------------------------------------------------------------ expectations
SEGMENTS = (('champions', lambda r, f: r >= 4 and f >= 4), ('loyal', lambda r, f: f >= 4 and r >= 3), ('potential_loyalists', lambda r, f: r >= 4 and 2 <= f <= 3),
            ('new', lambda r, f: r >= 4 and f == 1), ('at_risk', lambda r, f: r <= 2 and f >= 3), ('one_time_lapsed', lambda r, f: f == 1 and r <= 3),
            ('hibernating', lambda r, f: r <= 2 and f <= 2), ('needs_attention', lambda r, f: True))


def f_band(n):
    return 1 if n == 1 else 2 if n == 2 else 3 if n <= 4 else 4 if n <= 8 else 5


def quintiles(values):
    """Scores 1 to 5 by rank (larger value, higher score); equal values are ranked in list order. Cut points are 1 + (n - 1) k / 5 on the ranks 1..n."""
    n = len(values)
    order = sorted(range(n), key=lambda i: (values[i], i))
    rank = [0] * n
    for pos, i in enumerate(order, 1):
        rank[i] = pos
    cuts = [1 + (n - 1) * k / 5 for k in range(1, 5)]
    return [1 + sum(1 for c in cuts if rk > c) for rk in rank]


def percentile(values, q):
    v = sorted(values)
    pos = (len(v) - 1) * q
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (pos - lo)


def monday(d):
    return d - dt.timedelta(days=d.weekday())


def month_key(when):
    d = when.astimezone(TZ)
    return f'{d.year}-{d.month:02d}'


def expectations(customers, orders, designs, restocks, adjustments, day_end, end_onhand):
    gt = []

    def row(scenario, screen, view, stype, skey, metric, expected, rule='', basis='computed', note=''):
        gt.append([scenario, screen, view, stype, skey, metric, expected, rule, basis, note])

    cust = {c['customer_id']: c for c in customers}
    base_closed = [b for b in BASELINE if b['closed_at']]
    closed = [{'order': o['order_id'], 'customer': o['customer'], 'at': o['closed_at'], 'amount': o['amount'], 'lines': o['lines']} for o in orders if o['state'] == 'closed']
    for b in base_closed:
        lines = [{'sku': p.rsplit('x', 1)[0], 'qty': int(p.rsplit('x', 1)[1])} for p in b['garment_lines'].split()]
        closed.append({'order': b['order'], 'customer': 'BASE-' + b['customer'], 'at': dt.datetime.fromisoformat(b['closed_at']), 'amount': float(b['amount_total']), 'lines': lines})
    # --- last purchase cost per variant (the Health cost-of-goods rule): the latest received restock line, else the cheapest supply line
    got = {}
    for rec in sorted([x for x in restocks if x['outcome'] == 'received'], key=lambda x: x['received_at']):
        for l in rec['lines']:
            if l['received'] > 0:
                got[l['sku']] = l['unit_cost']
    cost = {s: got.get(s, cheapest_cost(s)) for s in SKUS}
    # --- S13, S17, health: money by the Manila month of the closing history line
    months = [f'{y}-{m:02d}' for y, m in [(2025, i) for i in (10, 11, 12)] + [(2026, i) for i in range(1, 11)]]
    rev = collections.defaultdict(float)
    cnt = collections.Counter()
    units = collections.Counter()
    cogs = collections.defaultdict(float)
    nocost = collections.Counter()
    for c in closed:
        mk = month_key(c['at'])
        rev[mk] += c['amount']
        cnt[mk] += 1
        for l in c['lines']:
            units[mk] += l['qty']
            if cost.get(l['sku']) is None:
                nocost[mk] += 1
            else:
                cogs[mk] += l['qty'] * cost[l['sku']]
    spend = collections.defaultdict(float)
    for rec in restocks:
        if rec['outcome'] == 'received':
            spend[rec['received_on'].strftime('%Y-%m')] += rec['actual']
    for m in months:
        part = ' (partial month: the run is for 26 October)' if m == '2026-10' else ''
        sc = 'S13' if m in ('2026-03', '2026-04') else 'S17'
        row(sc, 'DSS Health', '/api/admin/dss/health', 'month', m, 'revenue', money(rev[m]), 'sum of Closed orders by the Manila month of their closing line; VAT included', note=part)
        row(sc, 'DSS Health', '/api/admin/dss/health', 'month', m, 'closed_orders', cnt[m], 'count of Closed orders in that month')
        row(sc, 'DSS Health', '/api/admin/dss/health', 'month', m, 'closed_units', units[m], 'garment units of those orders (the print fee is not a unit)')
        row(sc, 'DSS Health', '/api/admin/dss/health', 'month', m, 'spending', money(spend[m]), 'received restocks by received_on month: goods + shipping, VAT included')
        row(sc, 'DSS Health', '/api/admin/dss/health', 'month', m, 'cogs', money(cogs[m]), 'units x last purchase cost (latest received unit cost, else cheapest supply line); %d units without a cost' % nocost[m])
    complete = months[:-1]
    ma3 = [sum(rev[complete[i - k]] for k in range(3)) / 3 for i in range(2, len(complete))]
    last6 = ma3[-6:]
    xs = list(range(6))
    xm, ym = sum(xs) / 6, sum(last6) / 6
    slope = sum((x - xm) * (y - ym) for x, y in zip(xs, last6)) / sum((x - xm) ** 2 for x in xs)
    rel = slope / ym if ym > 0 else float('nan')
    label = 'growing' if rel >= 0.02 else 'declining' if rel <= -0.02 else 'stable'
    row('S17', 'DSS Health', '/api/admin/dss/health', 'trend', 'revenue', 'label', label, 'least-squares slope of the last 6 complete months of 3-month average revenue / their mean; +-0.02 is the band')
    row('S17', 'DSS Health', '/api/admin/dss/health', 'trend', 'revenue', 'revenue_rel_slope_pct', f'{rel * 100:.2f}', 'tolerance 0.05 percentage points')
    # --- segments (RFM) over customers with a Closed order
    byc = collections.defaultdict(list)
    for c in closed:
        byc[c['customer']].append(c)
    order_keys = ['BASE-B1'] + [c['customer_id'] for c in sorted(customers, key=lambda c: (c['registered_at'], c['customer_id']))]
    scored = [k for k in order_keys if k in byc]
    rec_days = [int((AS_OF_END - max(x['at'] for x in byc[k])).total_seconds() // 86400) for k in scored]
    freq = [len(byc[k]) for k in scored]
    mon = [round(sum(x['amount'] for x in byc[k]), 2) for k in scored]
    rs = quintiles([-d for d in rec_days])
    ms = quintiles(mon)
    fs = [f_band(n) for n in freq]
    seg = {}
    for k, r_, f_, d_, m_, n_ in zip(scored, rs, fs, rec_days, mon, freq):
        seg[k] = next(code for code, rule in SEGMENTS if rule(r_, f_))
    counts = collections.Counter(seg.values())
    confirmed = {o['customer'] for o in orders if o['state'] != 'cancelled'} | {'BASE-B1'}
    row('S05', 'DSS Segments', '/api/admin/dss/segments', 'run', 'all', 'scored_customers', len(scored), 'customers with at least one Closed order (the shop has 1 baseline customer)')
    row('S08', 'DSS Segments', '/api/admin/dss/segments', 'run', 'all', 'no_completed_order', len(confirmed - set(scored)),
        'customers with a confirmed order but no Closed order (unpaid transfers, orders still on the way)')
    for code, _ in SEGMENTS:
        row('S05', 'DSS Segments', '/api/admin/dss/segments', 'segment', code, 'customers', counts.get(code, 0), 'count of scored customers in this segment')
    for k, r_, f_, d_, m_, n_ in zip(scored, rs, fs, rec_days, mon, freq):
        name = cust[k]['name'] if k in cust else '(baseline customer B1)'
        plan = cust[k]['category'] if k in cust else 'baseline'
        sc = {'vip': 'S05', 'new': 'S06', 'lapsed_one': 'S06', 'lapsed_reg': 'S07'}.get(plan, 'S05')
        row(sc, 'DSS Segments', '/api/admin/dss/segments', 'customer', k, 'segment', seg[k], f'R={r_} F={f_} (recency {d_} days, {n_} Closed orders); plan={plan}',
            note=name)
        row(sc, 'DSS Segments', '/api/admin/dss/segments', 'customer', k, 'monetary', money(m_), 'sum of the customer\'s Closed order totals, VAT included')
    # --- alerts: unpaid bank transfers, aged to the end of the as-of day
    for o in orders:
        if o['state'] == 'awaiting_payment':
            age = (AS_OF_END - o['placed']).total_seconds() / 86400.0
            band = 'admin_decide' if age >= 14 else 'stuck' if age >= 7 else 'follow_up' if age >= 3 else None
            sev = {'admin_decide': 'critical', 'stuck': 'warning', 'follow_up': 'info'}.get(band)
            sc = 'S09' if 'S09' in o['tags'] else 'S09'
            if band:
                row(sc, 'DSS Overview (alerts)', '/api/admin/dss/alerts', 'order', o['order_id'], 'unpaid_bank_transfer', f'{band};{sev};{age:.1f}',
                    'band;severity;age in days at the end of 2026-10-26 (3 / 7 / 14 days = info / warning / critical); age tolerance 0.1', note='run on 2026-10-26')
            else:
                row(sc, 'DSS Overview (alerts)', '/api/admin/dss/alerts', 'order', o['order_id'], 'unpaid_bank_transfer', 'no alert', f'age {age:.1f} days is under 3', note='run on 2026-10-26')
    for rec in restocks:
        if rec['outcome'] in ('approved', 'not_received'):
            issue = []
            un = UNAVAILABLE.get(rec['supplier'])
            if un and (un[0] <= rec['expected_to'] and un[1] >= rec['expected_from']):
                issue.append('supplier unavailable during the expected arrival')
            if un and un[0] <= AS_OF <= un[1]:
                issue.append('supplier unavailable today')
            if issue:
                row('S11', 'DSS Overview (alerts)', '/api/admin/dss/alerts', 'restock', rec['restock_id'], 'restock_supplier', 'present', '; '.join(issue), note=rec['supplier'])
            if AS_OF > rec['expected_to']:
                row('S11', 'DSS Overview (alerts)', '/api/admin/dss/alerts', 'restock', rec['restock_id'], 'restock_overdue', f'present;{(AS_OF - rec["expected_to"]).days}',
                    'open and past its expected range; days overdue at 2026-10-26', note=rec['supplier'])
    # --- supplier lead times (the restock figures)
    for sup in sorted(SUPPLIERS):
        days = [(rec['received_on'] - manila_date(rec['decided_at'])).days for rec in restocks if rec['supplier'] == sup and rec['outcome'] == 'received']
        if len(days) >= 3:
            p50, p90 = percentile(days, 0.5), percentile(days, 0.9)
            for metric, val in (('receipts', len(days)), ('lead_p50_days', f'{p50:.1f}'), ('lead_p90_days', f'{p90:.1f}'), ('lead_days_used', math.ceil(p90))):
                row('S11', 'DSS Restock', '/api/admin/dss/restock', 'supplier', sup, metric, val,
                    'days from the approval day to received_on (Manila), needs 3 receipts; used lead = p90 rounded up' if metric != 'receipts' else 'received restocks', note=SUPPLIERS[sup]['name'])
    # --- demand: garment units of confirmed orders per product, through the last complete week (Sunday 25 October)
    last_day = dt.date(2026, 10, 25)
    per = collections.Counter()
    weekly = collections.defaultdict(lambda: collections.defaultdict(int))
    for o in orders:
        if o['state'] != 'cancelled' and manila_date(o['placed']) <= last_day:
            for l in o['lines']:
                per[VARIANTS[l['sku']]['slug']] += l['qty']
                weekly[VARIANTS[l['sku']]['slug']][monday(manila_date(o['placed']))] += l['qty']
    for b in BASELINE:
        for part in b['garment_lines'].split():
            sku, n = part.rsplit('x', 1)
            per[VARIANTS[sku]['slug']] += int(n)
            weekly[VARIANTS[sku]['slug']][monday(dt.date(2026, 10, 24))] += int(n)
    row('S12', 'DSS Forecast', '/api/admin/dss/forecast', 'total', 'all', 'units_through_2026-10-25', sum(per.values()),
        'garment units of non-cancelled orders; the print fee line is never a unit; includes the two shop test orders')
    for slug in sorted(PRODUCTS):
        row('S12', 'DSS Forecast', '/api/admin/dss/forecast', 'product', slug, 'units_through_2026-10-25', per[slug], 'garment units of non-cancelled orders')
    weeks = [monday(FIRST_DAY) + dt.timedelta(weeks=i) for i in range(((monday(last_day) - monday(FIRST_DAY)).days // 7) + 1)]
    series = {s: [weekly[s].get(w, 0) for w in weeks] for s in PRODUCTS}
    for slug, scen, rule, test in (('w-tee', 'S02', 'up', lambda f26, l8, allm: l8 >= 1.5 * f26),
                                   ('m-tank', 'S03', 'down', lambda f26, l8, allm: l8 <= 0.6 * f26),
                                   ('m-tee', 'S04', 'flat', lambda f26, l8, allm: 0.65 * allm <= l8 <= 1.35 * allm)):
        s = series[slug]
        f26, l8, allm = sum(s[:26]) / 26.0, sum(s[-8:]) / 8.0, sum(s) / float(len(s))
        text = {'up': 'the forecast mean of the next 8 weeks is at least 1.5x the mean of the first 26 weeks',
                'down': 'the forecast mean of the next 8 weeks is at most 0.6x the mean of the first 26 weeks',
                'flat': 'the forecast mean of the next 8 weeks is within 0.65x to 1.35x of the 52-week mean'}[rule]
        row(scen, 'DSS Forecast', '/api/admin/dss/forecast', 'product', slug, 'direction', rule, text, 'planted',
            f'first-26-week mean {f26:.2f}, last-8-week mean {l8:.2f}, all-weeks mean {allm:.2f} units a week; the CSV itself {"meets" if test(f26, l8, allm) else "does NOT meet"} the rule; small volumes make this noisy')
    # --- S01: weeks in which the baby hoodies were out of stock all week
    bh = SKUS_BY_SLUG['b-hood']
    out_weeks = []
    for w in weeks:
        days = [w + dt.timedelta(days=i) for i in range(7)]
        if all(day_end[d][s] <= 0 for d in days if d in day_end for s in bh):
            out_weeks.append(w)
    for w in out_weeks:
        row('S01', 'DSS Forecast', '/api/admin/dss/forecast', 'product-week', f'b-hood:{w.isoformat()}', 'censored_and_zero_units', f'true;{weekly["b-hood"].get(w, 0)}',
            'every variant at zero on hand all week: the week is censored (demand understated) and has no sales', 'computed', 'from the generator\'s own stock ledger')
    if not out_weeks:
        row('S01', 'DSS Forecast', '/api/admin/dss/forecast', 'product', 'b-hood', 'out_of_stock_weeks', 'NONE (the pack failed to stock the product out)', '', 'computed')
    # --- S10: the variant that ends the year nearly out of stock
    st = end_onhand[STAR_SKU]
    last8 = sum(q for o in orders if o['state'] != 'cancelled' and manila_date(o['placed']) > last_day - 56 * DAY for l in o['lines'] if l['sku'] == STAR_SKU for q in [l['qty']])
    row('S10', 'DSS Overview (alerts)', '/api/admin/dss/alerts', 'variant', STAR_SKU, 'forecast_stockout', 'present', f'{st} unit(s) on hand at the end, {last8} sold in the last 8 weeks; run-out inside the lead time + review window (L + 7 days)', 'planted')
    row('S10', 'DSS Overview (alerts)', '/api/admin/dss/alerts', 'variant', STAR_SKU, 'low_stock_risk', 'present', f'{st} unit(s) is below the low-stock level 5 and the variant is forecast to run out', 'planted')
    row('S10', 'DSS Restock', '/api/admin/dss/restock', 'variant', STAR_SKU, 'urgency', 'order_now or stockout_before_arrival', 'the position falls to the safety stock before an order placed today could arrive', 'planted')
    row('S10', 'Staff stock', '/api/staff/stock', 'variant', STAR_SKU, 'on_hand', st, 'end of the year, from the generator\'s ledger')
    low = sorted(s for s in SKUS if end_onhand[s] < 5)
    row('S10', 'Staff stock', '/api/staff/stock?low=true', 'run', 'all', 'low_variants', len(low), 'variants with fewer than 5 on hand at the end (global level 5): ' + ' '.join(low))
    # --- staff and admin screens (not DSS)
    states = collections.Counter(o['state'] for o in orders)
    states['delivered'] += 1       # the shop's test order S00001
    states['closed'] += 1          # S00002
    for state in ('awaiting_payment', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'closed', 'cancelled'):
        row('S19', 'Admin orders summary', '/api/admin/orders/summary', 'state', state, 'orders_at_cutoff', states.get(state, 0),
            'orders by fulfilment state at 2026-10-26 09:00 including the two shop test orders (one delivered, one closed)', note='counts of the dashboard may differ by orders moved after the cutoff')
    delivered = [o for o in orders if o['state'] == 'delivered']
    row('S19', 'Admin dashboard', '/api/admin/dashboard', 'kpi', 'deliveredAwaiting', 'orders', len(delivered) + 1, 'delivered, waiting for the customer to confirm (not earnings); includes S00001')
    row('S19', 'Admin dashboard', '/api/admin/dashboard', 'kpi', 'deliveredAwaiting', 'total', money(sum(o['amount'] for o in delivered) + 518.54), 'VAT included; includes S00001 (518.54)')
    row('S12', 'Admin dashboard', '/api/admin/dashboard?range=all', 'kpi', 'revenue', 'total', money(sum(rev.values())), 'earned revenue: Closed orders only, all time, including the shop test order S00002 (349.00)')
    for o in orders:
        if 'S14' in o['tags']:
            row('S14', 'Staff order history', '/api/staff/orders/{id}', 'order', o['order_id'], 'step_back_lines', sum(1 for e in o['events'] if e['back']), 'one history line "out for delivery -> shipped" flagged as a step back, with the Administrator\'s note')
        if 'S15' in o['tags'] and o['kind'] == 'bank_paid_cancel':
            row('S15', 'Staff order history', '/api/staff/orders/{id}', 'order', o['order_id'], 'refund_due_note', 'REFUND DUE. ' + o['events'][-1]['note'], 'a paid bank transfer cancelled by an Administrator: state cancelled, not demand, not revenue')
        if 'S16' in o['tags']:
            row('S16', 'Staff order history', '/api/staff/orders/{id}', 'order', o['order_id'], 'shipped_lines', 1, 'the second staff member\'s identical move is refused (state_changed): only one history line for shipped')
    for e in EMPLOYEES:
        n = sum(1 for o in orders for ev in o['events'] if ev['employee'] == e.id and ev['outcome'] == 'done') + sum(1 for r_ in restocks for k in ('requested_by', 'decided_by', 'received_by', 'not_received_by') if r_.get(k) == e.id) \
            + sum(1 for a in adjustments if a['emp'] == e.id)
        row('S20', 'Admin employees', '/api/admin/employees', 'employee', e.id, 'status', 'inactive' if e.left else 'active', f'{e.name}{" (archived, left " + e.left.date().isoformat() + ")" if e.left else ""}; {n} recorded actions in this pack', 'constant')
    row('S20', 'Admin employees', '/api/admin/employees?status=all', 'run', 'all', 'employees_in_list', 8 + 2,
        'the pack\'s 8 employees plus the shop\'s two test staff accounts; the Odoo administrator, the superuser and the API service user are never listed there', 'constant')
    row('S21', 'DSS Overview', '/api/admin/dss/overview', 'run', 'all', 'kind', 'real', 'the pack\'s run is REAL: no simulation marker, orders count as they are', 'constant')
    for i, r_ in enumerate(gt, 1):
        r_.insert(0, f'GT{i:04d}')
    return gt


# ------------------------------------------------------------------------------------------------------------------------ README and manifest
def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as handle:
        h.update(handle.read())
    return h.hexdigest()


def write_manifest():
    rows = []
    hand_written = ('manifest.csv', 'ground_truth.sha256', 'RUNBOOK.md', 'P0_DECISION_NOTE.md', '.gitignore')     # not generated: editing them must not break the integrity check
    for dirpath, dirs, files in os.walk(OUT):
        dirs[:] = [d for d in dirs if d != '_local']          # the loader's own output (passwords, log) is never part of the pack
        for f in sorted(files):
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, OUT).replace(os.sep, '/')
            if rel in hand_written:
                continue
            if f.endswith('.csv'):
                with open(full, encoding='utf-8-sig', newline='') as handle:
                    n = sum(1 for _ in csv.reader(handle)) - 1
            else:
                n = ''
            rows.append([rel, n, sha256_of(full)])
    rows.sort()
    with open(os.path.join(OUT, 'manifest.csv'), 'w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle, lineterminator='\r\n')
        writer.writerow(['file', 'rows', 'sha256'])
        writer.writerows(rows)
    return rows


README = """# DSS scenario pack (slice P1: generated, NOT loaded anywhere yet)

A year of a small shop, 2025-10-01 to 2026-10-26 (Manila time, +08:00), built to test the decision-support (DSS) module on its **real** path:
orders, lifecycles acted by named employees, restocks, receipts and stock counts, plus `ground_truth.csv`: what the DSS should show, written in advance.

**Read this first.** Every expected value in `ground_truth.csv` comes from *reading the DSS code and rules* and from arithmetic over these CSVs. It is not
a measurement. **If the DSS disagrees with a row, the pack may be wrong as easily as the DSS**: check the row's `rule` and `note` before blaming either.

Fake data only: invented names, `example.test` emails, no passwords anywhere, phone numbers in the fake block `0900 000 xxxx`, invented streets.

## How it is made

`python3 scripts/pack_generate.py` (standard library only) writes every file here. A fixed seed (`{seed}`), no wall clock, no database: running it twice
gives byte-identical files (`manifest.csv` holds the SHA-256 of each). The catalogue, prices, opening stock, supply lines and provinces in `reference/`
were copied once, from a database dump file, by `scripts/pack_extract_baseline.py`.
The generator keeps a **stock ledger**: it never schedules an order the shop's stock guard would refuse, so a product with no stock simply gets no orders.

## Conventions

UTF-8 with a byte-order mark and CRLF line endings (Excel opens them directly); a header row; text ids (`C001` customers, `O0001` orders, `V0001` order moves,
`E01` employees, `R001` restocks, `D001` designs, `A001` stock counts, `SUP1` suppliers) so Excel keeps them as text; timestamps `2026-03-31T23:50:00+08:00`;
money in pesos, VAT included, two decimals. `orders.client_order_ref` (`pack:O0001`) is the key the loader (slice P2) will store on each order.

## Files

{files}

## The scenarios (ids are used in `scenarios` columns and in `ground_truth.csv`)

| id | what is planted | where to look |
|---|---|---|
| S01 | Baby Hoodie (all variants) written down after water damage on 3 Dec 2025, last packs written off 17 Dec; restock requested 18 Dec arrives 24 Jan: weeks with no stock and no sales | DSS Forecast (censored weeks), staff stock |
| S02 | Women Tee climbs about eightfold over the year | DSS Forecast (direction up) |
| S03 | Men Tank Top fades to a tenth | DSS Forecast (direction down) |
| S04 | Men Crew Tee is the steady seller | DSS Forecast (flat) |
| S05 | four VIP customers (about 15 orders each, the last one recent) | DSS Segments (champions) |
| S06 | one-time customers: 14 recent, 24 lapsed | DSS Segments (new / one-time, lapsed) |
| S07 | eight regulars who stopped ordering after January | DSS Segments (at risk / hibernating) |
| S08 | customers whose orders were all cancelled, and customers with an order but none Closed | DSS Segments (not scored) |
| S09 | unpaid bank transfers placed 2, 5, 10 and 20 days before the run day | DSS alerts (none, info, warning, critical) |
| S10 | Women Tee, black, M ends with one sellable unit after a stock count | DSS alerts (forecast stock-out, low stock), DSS Restock, staff stock |
| S11 | Cebu Heritage delivers late (14 to 21 days against 7 to 10); one open restock is overdue; Marikina is unavailable 3 to 10 Nov over an open restock | DSS Restock (lead times), DSS alerts |
| S12 | 24 designed garments: the print fee is revenue, never demand | DSS Forecast (units), admin dashboard |
| S13 | two orders confirmed by the customer at 23:50 on 31 Mar and 00:20 on 1 Apr (Manila) | DSS Health (March / April revenue) |
| S14 | an Administrator steps an order back (out for delivery -> shipped) with a note | staff order history |
| S15 | paid bank transfers cancelled by an Administrator: "REFUND DUE" | staff order history, not demand, not revenue |
| S16 | two staff press the same move on one order; the second is refused | staff order history (one line) |
| S17 | Nov-Dec 2025 peak, slow Jan-Feb 2026, weekend and payday rhythm (the model cannot see seasons, paydays or promotions: documented limits) | DSS Health |
| S19 | delivered less than 7 days ago and still waiting for the customer: not earnings | admin dashboard |
| S20 | one employee left on 27 Feb 2026 (archived) | admin employees, order history |
| S21 | everything above is REAL data (no simulation marker) | DSS Overview |

## Facts that are not the pack's

* **Pre-existing accounts, separate from the pack's 8 employees (E01 to E08):** the Odoo administrator and the shop's two test staff accounts
  ("Staff Inventory (test)" and "Staff Administrator (test)"). They exist in the database the pack will be loaded into. The pack does not use them.
  The admin Employees page lists the two test staff accounts with the pack's 8 (10 in all); the Odoo administrator is never listed there.
* **The shop's two test orders** (S00001 delivered, S00002 closed, both 24 October 2026, one customer) already exist in the database. They count in the DSS
  (units, revenue in October 2026, one scored customer) and in `ground_truth.csv`. See `reference/baseline_orders.csv`.
* **The one change to existing data (D1):** on the throwaway database only, the shop's 243 opening-stock moves (dated 2026-10-23 in the dump) are re-dated
  to 2025-09-30 08:00 Manila, so that the shop's own stock is the opening stock of the test year. Their stock-edit history rows keep the original date.
  Nothing in `clothcraft_shop` is changed. The opening stock is large for this demand, so the planted shortages use stock counts (write-downs), not sales.
* **Order numbers** in Odoo (S00003 and up) follow the load order; the two shop test orders have the lowest numbers although they are dated last.
* **The daily "close delivered orders" job** runs at 10:38 Manila in the shop's database: an order delivered at D closes at the first run at or after D + 7 days
  unless the customer confirmed earlier (about 60% do). Orders that would close after 2026-10-26 09:00 are left delivered.
* **Data ends 2026-10-26 09:00; the DSS run is for the day 2026-10-26.** A run on another day shifts alert ages and recency; compare with a pinned as-of date then.

## Status

Slice P1: generated and validated only. Nothing is loaded. The loader (P2) will replay `orders.csv`, `order_events.csv`, `restock_*`, `receipts.csv` and
`stock_adjustments.csv` through the shop's real code, each step inside its own frozen clock, then stop if the history rows differ from real ones.
"""


def days_text(days):
    names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    return f'{names[min(days)]}-{names[max(days)]}'


def summarise(orders, restocks, adjustments, day_end, end_onhand, stats, ledger):
    opening = sum(VARIANTS[s]['opening'] for s in SKUS)
    shipped = -sum(d for _t, k, _s, d in ledger if k == 'ship')
    received = sum(d for _t, k, _s, d in ledger if k == 'receipt')
    counts = sum(d for _t, k, _s, d in ledger if k == 'count')
    print('--- stock ledger')
    print(f'opening units {opening} | shipped {shipped} (orders and the two shop test orders) | received {received} | stock counts net {counts:+d} | end on hand {sum(end_onhand.values())}'
          f' (check {opening - shipped + received + counts})')
    never_stocked = sorted(s for s in SKUS if VARIANTS[s]['opening'] == 0)          # the shop never stocked these (they have no stock moves at all)
    zero_variants = sorted({s for snap in day_end.values() for s, q in snap.items() if q <= 0 and s not in never_stocked})
    print(f'variants never stocked by the shop: {never_stocked}')
    print(f'stocked variants that reached zero on hand at least once: {len(zero_variants)} {zero_variants}')
    by_slug = collections.defaultdict(int)
    for snap in day_end.values():
        for s, q in snap.items():
            if q <= 0 and s not in never_stocked:
                by_slug[VARIANTS[s]['slug']] += 1
    print('variant-days at zero by product:', dict(sorted(by_slug.items(), key=lambda kv: -kv[1])[:6]))
    print('end stock below 5:', sorted(s for s in SKUS if end_onhand[s] < 5))
    print('sweep notes:', dict(stats))


def main():
    customers = make_customers()
    plans = plan_orders(customers)
    r_life = rng('lifecycle')
    for p in plans:
        evs = build_events(p, r_life)
        p['events'], p['state'], p['closed_at'], p['closed_by'] = finish_order(p, evs)
    restock_items = plan_restock_requests()
    edits = plan_stock_edits()
    orders, designs, restocks, adjustments, day_end, end_onhand, end_reserved, stats, ledger = sweep(plans, restock_items, edits)
    orders.sort(key=lambda o: (o['placed'], o['customer']))
    remap = {}
    for i, o in enumerate(orders, 1):
        remap[o['order_id']] = f'O{i:04d}'
        o['order_id'] = remap[o['order_id']]
    for d in designs:
        d['order_id'] = remap[d['order_id']]
    assign_registrations(customers, orders)
    registered = {c['customer_id']: c['registered_at'] for c in customers}
    placed_at = {o['order_id']: o['placed'] for o in orders}
    for d in designs:            # a design is uploaded by a registered customer, before the order that uses it (found by the loader, P2)
        d['created_at'] = max(d['created_at'], registered[d['customer']] + MIN)
        assert d['created_at'] < placed_at[d['order_id']], d['design_id']
    adjustments.sort(key=lambda a: a['at'])
    os.makedirs(OUT, exist_ok=True)
    build_files(customers, orders, designs, restocks, adjustments)
    del FILES['reference/baseline_note.csv']
    gt = expectations(customers, orders, designs, restocks, adjustments, day_end, end_onhand)
    put('ground_truth.csv', ['case_id', 'scenario', 'screen', 'view', 'subject_type', 'subject_key', 'metric', 'expected', 'rule_or_tolerance', 'basis', 'note'], gt)
    write_all()
    listing = ['| file | rows | what |', '|---|---|---|']
    what = {'employees.csv': 'the 8 employees (5 Inventory Staff, 2 Administrators, 1 archived), working days and hours', 'customers.csv': 'customers with their plan, registration time and delivery details',
            'orders.csv': 'one row per order with its expected end state and total', 'order_lines.csv': 'what each order contains (and the print fee of designed lines)',
            'order_events.csv': 'every move of every order: who, when, from, to, expected outcome', 'payments.csv': 'payment of each order at the end',
            'designs.csv': 'designed garments', 'design_layers.csv': 'the elements of each design (boxes inside the print area)', 'suppliers.csv': 'the three suppliers, promised and actual delivery behaviour, unavailable dates',
            'restock_requests.csv': 'restock requests and what became of them', 'restock_lines.csv': 'lines of each restock (quantity, unit cost)', 'receipts.csv': 'goods received',
            'stock_adjustments.csv': 'stock counts and write-downs by staff', 'ground_truth.csv': 'expected DSS and screen results, with the rule behind each'}
    for name, (_h, rows) in FILES.items():
        listing.append(f'| {name} | {len(rows)} | {what.get(name, "")} |')
    ref_what = {'products': '19 garments, prices, print boxes', 'variants': '246 variants: price, opening units', 'suppliers': 'the 3 shop suppliers', 'supply_lines': 'what each supplier supplies, at what unit cost',
                'provinces': 'province codes the shop accepts', 'design_settings': 'print-fee settings', 'baseline_orders': 'the shop\'s two test orders'}
    for name in sorted(os.listdir(REF)):
        n = sum(1 for _ in read_csv(os.path.join(REF, name)))
        listing.append(f'| reference/{name} | {n} | {ref_what.get(name[:-4], "")} (copied from the dump) |')
    listing.append('| manifest.csv | | file names, row counts, SHA-256 |')
    with open(os.path.join(OUT, 'README.md'), 'w', encoding='utf-8', newline='\r\n') as handle:
        handle.write(README.replace('{seed}', SEED).replace('{files}', '\n'.join(listing)))
    rows = write_manifest()
    gt_hash = sha256_of(os.path.join(OUT, 'ground_truth.csv'))
    with open(os.path.join(OUT, 'ground_truth.sha256'), 'w', encoding='utf-8', newline='\r\n') as handle:
        handle.write(f'{gt_hash}  ground_truth.csv\nrecorded by scripts/pack_generate.py {GENERATOR_VERSION} before any verification run\n')
    print('--- files')
    for rel, n, h in rows:
        print(f'{rel:28} {str(n):>5}  {h[:12]}')
    print(f'ground_truth.csv sha256 {gt_hash}')
    print('--- orders', len(orders), '| customers', len(customers), '| designs', len(designs), '| restocks', len(restocks), '| adjustments', len(adjustments))
    summarise(orders, restocks, adjustments, day_end, end_onhand, stats, ledger)


if __name__ == '__main__':
    main()
