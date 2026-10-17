"""The demand model. Pure Python: no Odoo, no database, so it can be unit-tested and used to size a run.

Everything is driven by a seed through separate random streams (see util.rng); the numbers are invented.
"""
import datetime as dt
from bisect import bisect_left
from itertools import accumulate

from .data import (ARRIVAL_HOUR_WEIGHT, CATEGORY_SEASON, COLOR_WEIGHT, CUSTOMER_BIG, CUSTOMER_GROWTH, CUSTOMER_MIX, CUSTOMER_ORDERS,
                   FIRST_NAMES, FULL_RUN_DAYS, LAPSED_AFTER_DAYS, LAST_NAMES, PAYDAY_BOOST, PAYDAY_DAYS, PRODUCTS, PROMOS, SEASON, SIZE_WEIGHT, TIER_WEIGHT,
                   TREND_PER_MONTH, UNITS_PER_ORDER, WEEKDAY)
from .util import rng


def days_between(start, end):
    return [start + dt.timedelta(days=n) for n in range((end - start).days + 1)]


def promos_on(day):
    return [p for p in PROMOS if p['start'] <= day <= p['end']]


def multiplier(day, start):
    """How much busier than an average day this day is, for the whole shop."""
    value = SEASON[day.month] * WEEKDAY[day.weekday()]
    if day.day in PAYDAY_DAYS:
        value *= PAYDAY_BOOST
    value *= (1 + TREND_PER_MONTH) ** ((day - start).days / 30.44)
    for promo in promos_on(day):
        # a promotion on everything lifts the whole shop; one on a category lifts that category (see product_weights)
        value *= promo['demand'] if promo['match'] is None else 1.0
    return value


def pick(stream, items, weights):
    cumulative = list(accumulate(weights))
    return items[min(bisect_left(cumulative, stream.random() * cumulative[-1]), len(items) - 1)]


def plan_customers(cfg, seed):
    """Who the customers are and when each is active. Returns a list of dicts, index = customer number."""
    stream = rng(seed, 'customers')
    start, end, n = cfg['start'], cfg['end'], cfg['customers']
    days = days_between(start, end)
    day_weights = [multiplier(d, start) for d in days]
    horizon = len(days)
    # shorter presets shrink the lifetime order counts in proportion to their length (times rate_scale)
    scale = horizon / FULL_RUN_DAYS * cfg.get('rate_scale', 1.0)
    kinds = ['big'] * min(CUSTOMER_BIG, n // 10)
    for kind, share in CUSTOMER_MIX:
        kinds += [kind] * round(n * share)
    while len(kinds) < n:
        kinds.append('light')
    kinds = kinds[:n]
    stream.shuffle(kinds)
    # a lapsed customer's last order is older than LAPSED_AFTER_DAYS, if the run is long enough to say so
    lapse_by = end - dt.timedelta(days=LAPSED_AFTER_DAYS + 1) if horizon > 2 * LAPSED_AFTER_DAYS else end
    customers = []
    for index, kind in enumerate(kinds):
        customer = dict(index=index, kind=kind, first=stream.choice(FIRST_NAMES), last=stream.choice(LAST_NAMES),
                        email=f"sim.customer{index:03d}@example.com")
        if kind == 'one_time':
            join = active_to = pick(stream, days, [w * (1 + CUSTOMER_GROWTH * i / horizon) for i, w in enumerate(day_weights)])
            wanted = 1
        elif kind == 'new':    # joined in the last two months
            join, active_to = max(start, end - dt.timedelta(days=stream.randint(5, 60))), end
        elif kind == 'lapsed':
            join = days[stream.randint(0, int(horizon * 0.35))]
            active_to = max(join, min(lapse_by, join + dt.timedelta(days=stream.randint(60, 300))))
        else:
            share = {'light': 0.75, 'steady': 0.55, 'regular': 0.45, 'big': 0.3}[kind]
            join, active_to = days[stream.randint(0, int(horizon * share))], end
        if kind != 'one_time':
            counts, weights = CUSTOMER_ORDERS[kind]
            wanted = max(1, round(pick(stream, counts, weights) * (scale if kind != 'new' else min(1.0, scale))))
        window = [i for i, d in enumerate(days) if join <= d <= active_to]
        wanted = min(wanted, len(window))
        chosen = set()
        while len(chosen) < wanted:   # distinct days, weighted by how busy the shop is
            chosen.add(pick(stream, window, [day_weights[i] for i in window]))
        customer.update(join=join, active_to=active_to, order_days=sorted(days[i] for i in chosen))
        customers.append(customer)
    return customers


def plan_arrivals(cfg, customers, seed):
    """{day: [(time, customer index, order number)]} sorted by time. Order numbers are 1, 2, 3 ... in time order."""
    stream = rng(seed, 'arrivals')
    start = cfg['start']
    hours = list(range(len(ARRIVAL_HOUR_WEIGHT)))
    arrivals, number = {}, 0
    ordering = {}   # day -> customers who order that day
    for customer in customers:
        for day in customer['order_days']:
            ordering.setdefault(day, []).append(customer['index'])
    for day in days_between(start, cfg['end']):
        today = ordering.get(day, [])
        timed = []
        for index in today:
            hour = pick(stream, hours, ARRIVAL_HOUR_WEIGHT)
            timed.append((dt.time(hour, stream.randint(0, 59), stream.randint(0, 59)), index))
        timed.sort()
        arrivals[day] = []
        for moment, index in timed:
            number += 1
            arrivals[day].append((moment, index, number))
    return arrivals


def count_orders(arrivals):
    return sum(len(v) for v in arrivals.values())


def monthly_orders(arrivals):
    out = {}
    for day, items in arrivals.items():
        out[f"{day:%Y-%m}"] = out.get(f"{day:%Y-%m}", 0) + len(items)
    return out


def product_weights(day, keys):
    """Relative chance a basket line is each product on this day: tier x season x category promotions."""
    active = promos_on(day)
    weights = []
    for key in keys:
        spec = PRODUCTS[key]
        weight = TIER_WEIGHT[spec['tier']]
        for field, value, months, factor in CATEGORY_SEASON:
            if spec[field] == value and day.month in months:
                weight *= factor
        for promo in active:
            if promo['match'] and spec[promo['match'][0]] == promo['match'][1]:
                weight *= promo['demand']
        weights.append(weight)
    return weights


def variant_weight(spec, color, size):
    return COLOR_WEIGHT[spec['colors'].index(color)] * SIZE_WEIGHT[size]


def priors(cfg, n_orders, variants_by_product):
    """Planning estimate of units a day per variant: {variant default_code: units/day}. Used to size the
    opening stock and as the replenishment planner's prior before it has sales history."""
    days = (cfg['end'] - cfg['start']).days + 1
    daily_units = n_orders / days * UNITS_PER_ORDER
    keys = cfg['products']
    tier_total = sum(TIER_WEIGHT[PRODUCTS[k]['tier']] for k in keys)
    out = {}
    for key in keys:
        share = TIER_WEIGHT[PRODUCTS[key]["tier"]] / tier_total
        rows = variants_by_product[key]
        total = sum(variant_weight(PRODUCTS[key], color, size) for _code, color, size in rows)
        for code, color, size in rows:
            out[code] = daily_units * share * variant_weight(PRODUCTS[key], color, size) / total
    return out
