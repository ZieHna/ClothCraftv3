from odoo import models
from odoo.exceptions import UserError


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    def _clothcraft_is_return(self):
        """True when any move comes from a return wizard (customer returns, returned returns)."""
        self.ensure_one()
        return any(move.origin_returned_move_id for move in self.move_ids)

    def button_validate(self):
        for picking in self:
            if (picking.picking_type_code == 'incoming'
                    and not picking.partner_id
                    and not picking._clothcraft_is_return()):
                raise UserError(self.env._("Receipts need a supplier before they can be validated."))
        return super().button_validate()
