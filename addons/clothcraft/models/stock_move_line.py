from odoo import api, models


class StockMoveLine(models.Model):
    _inherit = 'stock.move.line'

    @api.model
    def _clothcraft_supplier_receipt_domain(self):
        """The one definition of "stock that arrived from a supplier", for the DSS to reuse.

        Returns are excluded: a customer return, or a vendor return that is itself returned,
        brings stock back but is not a purchase from a supplier.
        """
        return [
            ('state', '=', 'done'),
            ('location_id.usage', '=', 'supplier'),
            ('location_dest_id.usage', '=', 'internal'),
            ('move_id.origin_returned_move_id', '=', False),
        ]
