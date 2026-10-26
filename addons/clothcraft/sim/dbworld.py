"""The Odoo world: the effects of the simulation, done through the normal Odoo flows."""
from odoo import Command
from odoo.exceptions import UserError

from . import receipts
from .data import PRODUCTS
from .util import at, quiet
from .world import OrderRefused


class DbWorld:
    def __init__(self, env, cat, suppliers, partners, labels):
        self.env = quiet(env)
        self.cat, self.suppliers, self.partners, self.labels = cat, suppliers, partners, labels
        self.warehouse = self.env['stock.warehouse'].search([], limit=1)
        self.records = {}
        for key, entry in cat.items():
            for record, _color, _size in entry['variants']:
                self.records[record.default_code] = record
        self.cod = self.env.ref('delivery.payment_provider_cod')
        self.cod_method = self.env.ref('delivery.payment_method_cash_on_delivery')
        self.wire = self.env.ref('payment.payment_provider_transfer')
        self.wire_method = self.env.ref('payment_custom.payment_method_wire_transfer')
        self.wire.write({'state': 'enabled', 'is_published': True})
        self.transaction_changes = 0

    # ------------------------------------------------------------------ stock
    def free(self, codes):
        records = self.env['product.product'].browse([self.records[c].id for c in codes]).with_context(
            warehouse_id=self.warehouse.id)
        records.invalidate_recordset(['free_qty'])
        by_id = {record.id: int(record.free_qty) for record in records}
        return {code: by_id[self.records[code].id] for code in codes}

    def add_opening_receipt(self, entry):
        lines = [(self.records[code], qty, entry['cost']) for code, qty in entry['lines']]
        return receipts.receive(self.env, self.suppliers[entry['supplier']], lines, entry['ordered'], entry['received'])

    # ------------------------------------------------------------------ catalogue and purchasing
    def set_price(self, key, price, when):
        with at(when):
            self.cat[key]['template'].list_price = price

    def place_po(self, key, supplier_key, lines, ordered_at, received_at):
        order = receipts.place(self.env, self.suppliers[supplier_key],
                               [(self.records[c], q, cost) for c, q, cost in lines], ordered_at, received_at)
        return order.id

    def update_vendor_price(self, key, supplier_key, cost, when):
        seller = self.env['product.supplierinfo'].search([
            ('partner_id', '=', self.suppliers[supplier_key].id),
            ('product_tmpl_id', '=', self.cat[key]['template'].id)], limit=1)
        if seller and abs(seller.price - cost) > 0.02 * seller.price:
            with at(when):
                seller.price = cost

    def receive_po(self, po_id, when):
        receipts.validate(self.env, self.env['purchase.order'].browse(po_id), when)

    # ------------------------------------------------------------------ orders and payments
    def _new_transaction(self, order, partner, cod):
        provider, method = (self.cod, self.cod_method) if cod else (self.wire, self.wire_method)
        transaction = self.env['payment.transaction'].create({
            'provider_id': provider.id, 'payment_method_id': method.id, 'amount': order.amount_total,
            'currency_id': order.currency_id.id, 'partner_id': partner.id, 'reference': order.name,
            'operation': 'online_direct', 'sale_order_ids': [Command.set([order.id])]})
        transaction._set_pending()
        transaction.is_post_processed = True
        return transaction

    def _change_transaction(self, transaction, method_name):
        """Every state change resets is_post_processed (Odoo does it); set it back at once, or the payment
        cron would post-process simulated transactions (emails, invoices) in real time."""
        getattr(transaction, method_name)()
        transaction.is_post_processed = True
        self.transaction_changes += 1

    def create_order(self, customer, lines, when, cod):
        partner = self.partners[customer]
        try:
            with self.env.cr.savepoint(), at(when):
                order = self.env['sale.order'].create({
                    'partner_id': partner.id, 'tag_ids': [Command.set(self.labels['order'].ids)],
                    'order_line': [Command.create({'product_id': self.records[c].id, 'product_uom_qty': q})
                                   for c, q in lines]})
                order.action_confirm()                      # the B6 guard runs here; there is no bypass
                self._new_transaction(order, partner, cod)
        except UserError as error:
            raise OrderRefused(str(error)) from error
        return order.id

    def pay(self, order_id, when):
        order = self.env['sale.order'].browse(order_id)
        if order.state != 'sale':
            return False
        with at(when):
            for transaction in order.transaction_ids.filtered(lambda t: t.state == 'pending'):
                self._change_transaction(transaction, '_set_done')
        return True

    def deliver(self, order_id, when):
        order = self.env['sale.order'].browse(order_id)
        if order.state != 'sale':
            return False
        picking = order.picking_ids.filtered(lambda p: p.state not in ('done', 'cancel'))
        if not picking:
            return False
        with at(when):
            for move in picking.move_ids:
                move.picked = True
            picking.with_context(skip_sms=True, skip_immediate=True, skip_backorder=True).button_validate()
            for transaction in order.transaction_ids.filtered(lambda t: t.state == 'pending'):
                self._change_transaction(transaction, '_set_done')     # cash collected at the door
            # step 11: a validated delivery alone reads as "shipped"; a simulated sale is a finished one, so it ends closed
            order.clothcraft_state = 'closed'
        return True

    def cancel(self, order_id, when):
        order = self.env['sale.order'].browse(order_id)
        if order.state != 'sale' or order.picking_ids.filtered(lambda p: p.state == 'done'):
            return False
        with at(when):
            order.with_context(disable_cancel_warning=True).action_cancel()
            for transaction in order.transaction_ids.filtered(lambda t: t.state == 'pending'):
                self._change_transaction(transaction, '_set_canceled')
        return True

    # ------------------------------------------------------------------ checks and reporting
    def order_name(self, order_id):
        return self.env['sale.order'].browse(order_id).name

    def unprocessed_transactions(self):
        """Simulated transactions the payment cron could still post-process (must be none)."""
        return self.env['payment.transaction'].search_count([
            ('sale_order_ids.tag_ids', 'in', self.labels['order'].ids), ('is_post_processed', '=', False)])
