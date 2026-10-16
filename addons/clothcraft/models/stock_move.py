from odoo import models


class StockMove(models.Model):
    _inherit = 'stock.move'

    def _set_value(self, correction_quantity=None):
        """Tell the price-history cost hook which receipt is moving the average cost.

        stock_account rewrites standard_price (as the system user) while valuing incoming moves.
        The sources travel in the context as hashable (product_id, description, partner_id) tuples.
        """
        sources = self._clothcraft_cost_sources()
        records = self.with_context(clothcraft_cost_sources=sources) if sources else self
        return super(StockMove, records)._set_value(correction_quantity=correction_quantity)

    def _clothcraft_cost_sources(self):
        refs = {}     # product id -> receipt references, in order
        vendors = {}  # product id -> vendor ids of real supplier receipts
        for move in self.filtered(lambda m: m.is_in and m.picking_id):
            refs.setdefault(move.product_id.id, [])
            if move.picking_id.name not in refs[move.product_id.id]:
                refs[move.product_id.id].append(move.picking_id.name)
            vendors.setdefault(move.product_id.id, set())
            if not move.origin_returned_move_id:  # a return is never a supplier
                partner = move.purchase_line_id.order_id.partner_id or move.picking_id.partner_id
                if partner:
                    vendors[move.product_id.id].add(partner.id)
        return tuple(
            (product_id, ', '.join(names),
             next(iter(vendors[product_id])) if len(vendors[product_id]) == 1 else 0)
            for product_id, names in refs.items())
