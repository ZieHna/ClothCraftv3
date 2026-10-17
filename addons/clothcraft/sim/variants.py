"""Variant codes and the opening-stock plan. Pure Python: shared by the database run and the in-memory planning pass."""
import datetime as dt
import math

from .data import COLOR_CODE, COLORS, PRODUCTS, SIZES, SUPPLIERS
from .util import rng


def variant_code(key, color, size):
    return f"SIM-{key}-{COLOR_CODE[color]}-{size}"


def variant_table(keys):
    """{product key: [(code, color, size)]}, colour then size in the seeded attribute order (the order Odoo
    creates variants in)."""
    table = {}
    for key in keys:
        spec = PRODUCTS[key]
        colors = [c for c in COLORS if c in spec['colors']]
        sizes = [s for s in SIZES if s in spec['sizes']]
        table[key] = [(variant_code(key, c, s), c, s) for c in colors for s in sizes]
    return table


def opening_plan(cfg, seed, priors):
    """One receipt per product from its first supplier, dated 3 weeks (+-3 days) before the first simulated day
    and sized to cover `cover_days` of expected demand per variant (never less than one pack).
    Returns [{key, supplier, ordered, received, cost, lines: [(code, qty)]}]."""
    stream = rng(seed, 'opening')
    first_day = dt.datetime.combine(cfg['start'], dt.time(9))
    pack, cover = cfg['pack'], cfg['cover_days']
    table = variant_table(cfg['products'])
    plan = []
    for key in cfg['products']:
        spec = PRODUCTS[key]
        supplier_key = spec['suppliers'][0]
        supplier = SUPPLIERS[supplier_key]
        received = first_day - dt.timedelta(days=21) + dt.timedelta(days=stream.randint(-3, 3), hours=stream.randint(0, 6))
        ordered = received - dt.timedelta(days=round(supplier['lead'][0]) + stream.randint(0, 3))
        plan.append({
            'key': key, 'supplier': supplier_key, 'ordered': ordered, 'received': received,
            'cost': round(spec['cost'] * supplier['cost_factor'], 2),
            'lines': [(code, max(pack, math.ceil(priors[code] * cover / pack) * pack)) for code, _c, _s in table[key]]})
    assert max(p['received'] for p in plan) < dt.datetime.combine(cfg['start'], dt.time.min), \
        "opening receipts must precede the first day"
    return plan
