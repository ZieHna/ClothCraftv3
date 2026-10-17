"""The day-by-day simulation: one time-ordered queue of everything that happens.

Receipts, orders, payments, deliveries and cancellations are events with a timestamp, processed strictly in
time order, so stock a receipt brings never exists before its date and an order can only use stock that is
physically there. The decisions live here (pure Python); the effects go through a `world`: DbWorld does them in
Odoo (every sale through the normal `action_confirm()`, so the B6 stock guard runs and is never bypassed),
MemWorld does the stock arithmetic in memory for planning and tests. Demand the shop cannot serve is logged,
not recorded as an order.
"""
import csv
import datetime as dt
import heapq
import math
import os
import time
from collections import defaultdict, deque

from . import demand
from .data import (BANK_UNPAID, COVER_DAYS, CUSTOMER_CANCEL, DELAYED_SHIPMENT, PAYMENT_COD, PRODUCTS, PROMOS,
                   REVIEW_EVERY_DAYS, SAFETY_DAYS, STAFF_CANCEL_DAYS, STUCK_WINDOW_DAYS, SUPPLIERS)
from .util import rng
from .variants import variant_table
from .world import OrderRefused


def floor9(value):
    """A promotional price that ends in 9."""
    return float(math.floor(value / 10) * 10 + 9)


def _stamp(day, hour, minute=0, second=0):
    return dt.datetime.combine(day, dt.time(hour, minute, second))


class Simulation:
    def __init__(self, world, cfg, seed, customers, arrivals, priors, out_dir=None):
        self.world, self.cfg, self.seed = world, cfg, seed
        self.customers, self.arrivals, self.priors, self.out_dir = customers, arrivals, priors, out_dir
        self.keys = list(cfg['products'])
        self.table = variant_table(self.keys)
        self.variants, self.by_product = {}, {}
        for key in self.keys:
            self.by_product[key] = [code for code, _c, _s in self.table[key]]
            for code, color, size in self.table[key]:
                self.variants[code] = dict(key=key, color=color, size=size)
        self.heap, self.seq = [], 0
        self.sold = defaultdict(deque)       # variant code -> (day, qty) for the replenishment planner
        self.on_order = defaultdict(float)   # variant code -> units on open purchase orders
        self.po_lines = {}                   # purchase order id -> [(variant code, qty)]
        self.lost, self.partial, self.cancelled, self.stuck = [], [], [], []
        self.cancel_times = {}               # order id -> when it was cancelled (for the create/write_date backfill)
        self.sales_rows = []                 # (day, code, qty) of every confirmed line
        self.lost_net_units = 0              # demand never served, after counting substitutions as served
        self.count, self.spent = defaultdict(int), defaultdict(float)

    # ------------------------------------------------------------------ queue
    def schedule(self, when, kind, **payload):
        heapq.heappush(self.heap, (when, self.seq, kind, payload))
        self.seq += 1

    def run(self):
        start, end = self.cfg['start'], self.cfg['end']
        for index, promo in enumerate(PROMOS):
            if start <= promo['start'] <= end:
                self.schedule(_stamp(promo['start'], 0, 5), 'promo', index=index, begin=True)
            if start <= promo['end'] <= end:
                self.schedule(_stamp(promo['end'] + dt.timedelta(days=1), 0, 5), 'promo', index=index, begin=False)
        for day in demand.days_between(start, end):
            for position, key in enumerate(self.keys):
                if (day.toordinal() + position) % REVIEW_EVERY_DAYS == 0:
                    self.schedule(_stamp(day, 1), 'review', key=key)
            for moment, customer_index, number in self.arrivals[day]:
                self.schedule(dt.datetime.combine(day, moment), 'arrival', customer=customer_index, number=number)
            limit = _stamp(day + dt.timedelta(days=1), 0)
            while self.heap and self.heap[0][0] < limit:
                when, _seq, kind, payload = heapq.heappop(self.heap)
                began = time.monotonic()
                getattr(self, f"_on_{kind}")(when, **payload)
                self.spent[kind] += time.monotonic() - began
                self.count[kind] += 1

    # ------------------------------------------------------------------ helpers
    def _trailing(self, code, day):
        history = self.sold[code]
        while history and history[0][0] <= day - dt.timedelta(days=28):
            history.popleft()
        return sum(qty for _day, qty in history)

    # ------------------------------------------------------------------ promotions
    def _on_promo(self, when, index, begin):
        promo = PROMOS[index]
        for key in self.keys:
            spec = PRODUCTS[key]
            if promo['match'] is None or spec[promo['match'][0]] == promo['match'][1]:
                self.world.set_price(key, floor9(spec['price'] * (1 - promo['discount'])) if begin else float(spec['price']), when)

    # ------------------------------------------------------------------ replenishment
    def _on_review(self, when, key):
        day = when.date()
        if any(g['product'] == key and g['start'] <= day <= g['end'] for g in self.cfg.get('supply_gaps', [])):
            self.count['review_skipped_supply_gap'] += 1
            return
        spec, pack = PRODUCTS[key], self.cfg['pack']
        codes = self.by_product[key]
        free = self.world.free(codes)
        stream = rng(self.seed, f"review:{key}:{day}")
        lead_mean = SUPPLIERS[spec['suppliers'][0]]['lead'][0]
        needs = []
        for code in codes:
            rate = max(self._trailing(code, day) / 28.0, 0.5 * self.priors[code])
            position = free[code] + self.on_order[code]
            if position <= rate * (lead_mean + REVIEW_EVERY_DAYS + SAFETY_DAYS):
                target = rate * (lead_mean + REVIEW_EVERY_DAYS + COVER_DAYS)
                needs.append((code, max(pack, math.ceil((target - position) / pack) * pack)))
        if not needs:
            return
        supplier_key = spec['suppliers'][0]
        if len(spec['suppliers']) > 1 and sum(q for _c, q in needs) >= 4 * pack and stream.random() < 0.4:
            supplier_key = spec['suppliers'][1]
        supplier = SUPPLIERS[supplier_key]
        months = (day - self.cfg['start']).days / 30.44
        cost = round(spec['cost'] * supplier['cost_factor'] * 1.005 ** months * stream.uniform(0.97, 1.03), 2)
        lead = max(2, round(stream.gauss(*supplier['lead'])))
        if stream.random() < supplier['late'][0]:
            lead += supplier['late'][1] + stream.randint(0, 3)
        received_at = _stamp(day + dt.timedelta(days=lead), stream.randint(2, 9), stream.randint(0, 59))
        po_id = self.world.place_po(key, supplier_key, [(c, q, cost) for c, q in needs], when, received_at)
        self.world.update_vendor_price(key, supplier_key, cost, when)
        for code, qty in needs:
            self.on_order[code] += qty
        self.po_lines[po_id] = list(needs)
        self.schedule(received_at, 'receive', po_id=po_id)
        self.count['purchase_orders'] += 1

    def _on_receive(self, when, po_id):
        self.world.receive_po(po_id, when)
        for code, qty in self.po_lines.pop(po_id):
            self.on_order[code] -= qty

    # ------------------------------------------------------------------ customers
    def _on_arrival(self, when, customer, number):
        day = when.date()
        stream = rng(self.seed, f"order:{number}")
        n_lines = demand.pick(stream, [1, 2, 3, 4], [50, 30, 15, 5])
        weights = demand.product_weights(day, self.keys)
        wanted = defaultdict(int)
        for _ in range(n_lines):
            key = demand.pick(stream, self.keys, weights)
            codes = self.by_product[key]
            code = demand.pick(stream, codes, [demand.variant_weight(PRODUCTS[key], self.variants[c]['color'], self.variants[c]['size']) for c in codes])
            wanted[code] += demand.pick(stream, [1, 2, 3], [70, 22, 8])
        # what the shop can actually serve right now (the same free quantity the stock guard checks)
        lines = defaultdict(int)
        available = {}   # free units per variant, reduced as this basket claims them

        def free_of(code):
            if code not in available:
                available[code] = self.world.free([code])[code]
            return available[code]

        for code, qty in sorted(wanted.items()):
            free = free_of(code)
            take = min(qty, free)
            if take == 0 and stream.random() < 0.35:   # try another variant of the same product
                key = self.variants[code]['key']
                others = [c for c in self.by_product[key] if c != code]
                frees = self.world.free(others)
                for other in others:
                    available.setdefault(other, frees[other])
                options = [c for c in others if available[c] > 0]
                if options:
                    substitute = demand.pick(stream, options, [
                        demand.variant_weight(PRODUCTS[key], self.variants[c]['color'], self.variants[c]['size'])
                        for c in options])
                    self.lost.append((day, code, qty, free))
                    take2 = min(qty, available[substitute])
                    lines[substitute] += take2
                    available[substitute] -= take2
                    self.lost_net_units += qty - take2
                    self.count['substitutions'] += 1
                    continue
            if take < qty:
                self.lost.append((day, code, qty, free))
                self.lost_net_units += qty - take
                if take > 0:
                    self.partial.append((day, code, qty, free))
            if take > 0:
                lines[code] += take
                available[code] -= take
        if not lines:
            self.count['orders_lost_entirely'] += 1
            return
        cod = stream.random() < PAYMENT_COD
        try:
            order_id = self.world.create_order(customer, sorted(lines.items()), when, cod)
        except OrderRefused:
            self.count['guard_refusals'] += 1
            for code, qty in lines.items():
                self.lost.append((day, code, qty, 0))
                self.lost_net_units += qty
            return
        self.count['orders'] += 1
        self.count['lines'] += len(lines)
        self.count['units'] += sum(lines.values())
        for code, qty in lines.items():
            self.sold[code].append((day, qty))
            self.sales_rows.append((day, code, qty))
        self._plan_after_order(when, order_id, number, cod, stream)

    def _plan_after_order(self, when, order_id, number, cod, stream):
        end = self.cfg['end']
        if stream.random() < CUSTOMER_CANCEL:      # the customer changes their mind before anything ships
            self.schedule(when + dt.timedelta(hours=stream.uniform(2, 36)), 'cancel', order_id=order_id, who='customer')
            return
        if cod:
            self.schedule(self._delivery_time(when, stream, delayed_possible=True), 'deliver', order_id=order_id)
        elif stream.random() < BANK_UNPAID:
            if when.date() <= end - dt.timedelta(days=STUCK_WINDOW_DAYS):
                lag = stream.randint(*STAFF_CANCEL_DAYS)
                self.schedule(_stamp(when.date() + dt.timedelta(days=lag), 3), 'cancel', order_id=order_id, who='staff')
            else:
                self.stuck.append((when.date(), order_id))
        else:
            self.schedule(when + dt.timedelta(hours=stream.uniform(1, 70)), 'pay', order_id=order_id, number=number)

    def _delivery_time(self, base, stream, delayed_possible=False):
        if delayed_possible and stream.random() < DELAYED_SHIPMENT:
            days = stream.randint(8, 20)
        else:
            days = demand.pick(stream, [1, 2, 3, 4, 5, 6], [30, 25, 15, 12, 10, 8])
        return _stamp(base.date() + dt.timedelta(days=days), stream.randint(2, 9), stream.randint(0, 59))

    def _on_pay(self, when, order_id, number):
        if self.world.pay(order_id, when):
            stream = rng(self.seed, f"order:{number}:shipping")
            self.schedule(self._delivery_time(when, stream), 'deliver', order_id=order_id)

    def _on_deliver(self, when, order_id):
        if self.world.deliver(order_id, when):
            self.count['deliveries'] += 1

    def _on_cancel(self, when, order_id, who):
        if self.world.cancel(order_id, when):
            self.cancelled.append((when.date(), order_id, who))
            self.cancel_times[order_id] = when

    # ------------------------------------------------------------------ results
    def write_lost_demand(self):
        """date, variant, wanted, free: demand the shop could not (fully) serve. Not stored in the database."""
        if not self.out_dir or not os.path.isdir(self.out_dir):
            return None
        path = os.path.join(self.out_dir, 'lost_demand.csv')
        with open(path, 'w', newline='', encoding='utf-8') as handle:
            writer = csv.writer(handle)
            writer.writerow(['date', 'variant', 'wanted', 'free'])
            for day, code, wanted, free in sorted(self.lost, key=lambda r: (r[0], r[1])):
                writer.writerow([day.isoformat(), code, wanted, free])
        return path

    def lost_share(self):
        """Share of wanted units never served (substitutions count as served), overall, by month and by product."""
        sold = defaultdict(float)
        for day, code, qty in self.sales_rows:
            sold[(f"{day:%Y-%m}", self.variants[code]['key'])] += qty
        lost = defaultdict(float)
        for day, code, wanted, free in self.lost:
            lost[(f"{day:%Y-%m}", self.variants[code]['key'])] += wanted - min(wanted, free)
        total_sold = sum(qty for _d, _c, qty in self.sales_rows)
        return {'sold_units': total_sold, 'lost_units_gross': sum(lost.values()), 'lost_units_net': self.lost_net_units,
                'net_share': self.lost_net_units / max(1, total_sold + self.lost_net_units), 'sold': dict(sold), 'lost': dict(lost)}

    def result(self):
        orders = self.count['orders'] or 1
        handled = sum(self.spent[k] for k in ('arrival', 'pay', 'deliver', 'cancel'))
        return {
            'orders': self.count['orders'], 'lines': self.count['lines'], 'units': self.count['units'],
            'deliveries': self.count['deliveries'], 'cancelled': len(self.cancelled),
            'cancelled_customer': sum(1 for _d, _o, who in self.cancelled if who == 'customer'),
            'cancelled_staff': sum(1 for _d, _o, who in self.cancelled if who == 'staff'), 'stuck': len(self.stuck),
            'purchase_orders': self.count['purchase_orders'], 'receipts': self.count['receive'],
            'lost_rows': len(self.lost), 'partial_fills': len(self.partial), 'substitutions': self.count['substitutions'],
            'orders_lost_entirely': self.count['orders_lost_entirely'], 'guard_refusals': self.count['guard_refusals'],
            'seconds': {k: round(v, 1) for k, v in self.spent.items()},
            'seconds_per_order': round(handled / orders, 3),
        }
