"""The in-memory world: the same stock arithmetic as Odoo (free = on hand - reserved), no database.

Used to plan and tune a run in seconds, and by tests. It must agree with DbWorld; tests compare the two."""
from collections import defaultdict


class OrderRefused(Exception):
    """The stock guard refused to confirm the order."""


class MemWorld:
    def __init__(self):
        self.on_hand = defaultdict(int)
        self.reserved = defaultdict(int)
        self.orders, self.pos = {}, {}
        self._next = 0
        self.prices = {}

    def _id(self):
        self._next += 1
        return self._next

    def add_stock(self, code, qty):
        self.on_hand[code] += qty

    def free(self, codes):
        return {code: self.on_hand[code] - self.reserved[code] for code in codes}

    def set_price(self, key, price, when):
        self.prices[key] = price

    def place_po(self, key, supplier_key, lines, ordered_at, received_at):
        po_id = self._id()
        self.pos[po_id] = [(code, qty) for code, qty, _cost in lines]
        return po_id

    def update_vendor_price(self, key, supplier_key, cost, when):
        pass

    def receive_po(self, po_id, when):
        for code, qty in self.pos[po_id]:
            self.on_hand[code] += qty

    def create_order(self, customer, lines, when, cod):
        for code, qty in lines:
            if self.on_hand[code] - self.reserved[code] < qty:
                raise OrderRefused(code)
        for code, qty in lines:
            self.reserved[code] += qty
        order_id = self._id()
        self.orders[order_id] = {'lines': list(lines), 'state': 'sale'}
        return order_id

    def pay(self, order_id, when):
        return self.orders[order_id]['state'] == 'sale'

    def deliver(self, order_id, when):
        order = self.orders[order_id]
        if order['state'] != 'sale':
            return False
        for code, qty in order['lines']:
            self.on_hand[code] -= qty
            self.reserved[code] -= qty
        order['state'] = 'done'
        return True

    def cancel(self, order_id, when):
        order = self.orders[order_id]
        if order['state'] != 'sale':
            return False
        for code, qty in order['lines']:
            self.reserved[code] -= qty
        order['state'] = 'cancel'
        return True
