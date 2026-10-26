from collections import defaultdict

from odoo import models
from odoo.exceptions import UserError
from odoo.tools import SQL


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    def init(self):
        """One order per idempotency key: client_order_ref 'api:<partner id>:<key>' is set by clothcraft.api.place_order."""
        super().init()
        self.env.cr.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS sale_order_clothcraft_api_key_uniq "
            "ON sale_order (client_order_ref) WHERE client_order_ref LIKE 'api:%'")

    def action_confirm(self):
        self._clothcraft_check_stock()
        return super().action_confirm()

    def _clothcraft_check_stock(self):
        """Refuse to confirm more than is free, and serialise confirmations per product.

        Odoo reserves stock without waiting for concurrent buyers (row locks are SKIP LOCKED), so two
        orders for the last unit can both be confirmed. Locking the product's internal quants
        (FOR UPDATE, in a fixed order, so concurrent orders cannot deadlock) makes the second buyer
        wait; its transaction is then aborted with a serialization failure, Odoo retries the
        request, and the retry sees the reservation and fails here with a clear message.

        Products that are not storable, or are allowed to sell out of stock, are not checked.
        """
        needed = defaultdict(float)  # (warehouse, product) -> quantity in the product's UoM
        for order in self.filtered(lambda o: o.state in ('draft', 'sent')):
            for line in order.order_line:
                product = line.product_id
                if line.display_type or not product.is_storable or product.allow_out_of_stock_order:
                    continue
                needed[order.warehouse_id, product] += line.product_uom_id._compute_quantity(
                    line.product_uom_qty, product.uom_id)
        if not needed:
            return

        product_ids = sorted({product.id for _warehouse, product in needed})
        self.env.cr.execute(SQL(
            """SELECT q.id FROM stock_quant q JOIN stock_location l ON l.id = q.location_id
                WHERE q.product_id IN %s AND l.usage = 'internal'
                ORDER BY q.product_id, q.id FOR UPDATE OF q""", tuple(product_ids)))
        self.env['product.product'].browse(product_ids).invalidate_recordset(
            ['qty_available', 'free_qty', 'virtual_available'])

        for (warehouse, product), quantity in sorted(needed.items(), key=lambda item: item[0][1].id):
            free = product.with_context(warehouse_id=warehouse.id).free_qty
            if product.uom_id.compare(free, quantity) >= 0:
                continue
            if product.uom_id.compare(free, 0) > 0:
                message = self.env._("Sorry, only %(free)s of %(product)s left.",
                                     free=free, product=product.display_name)
            else:
                message = self.env._("Sorry, %(product)s just sold out.", product=product.display_name)
            if self.website_id:
                message += " " + self.env._("Your cart has been kept.")
            raise UserError(message)
