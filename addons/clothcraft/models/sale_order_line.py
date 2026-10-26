"""A customized garment on an order (step 9a) is TWO lines: the garment, which carries the design, and right after it one line of the
"Customization fee" service product with the same quantity and the print fee per piece as its price. The fee line keeps what it was priced
with (covered area, rate, size step, steps), so a later change of the settings never changes an order.

The shop makes both lines. In the Odoo screens, changing the garment line's quantity changes its fee line's quantity too (the one hook
below); everything else on these lines is ordinary Odoo.
"""
from odoo import api, fields, models


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    clothcraft_design_id = fields.Many2one('clothcraft.design', string="Design", index='btree_not_null', ondelete='restrict', copy=False, readonly=True)
    clothcraft_fee_for_id = fields.Many2one('sale.order.line', string="Print fee for", index='btree_not_null', ondelete='cascade', copy=False, readonly=True)
    clothcraft_fee_line_ids = fields.One2many('sale.order.line', 'clothcraft_fee_for_id', string="Print fee lines", readonly=True)
    clothcraft_print_sq_in = fields.Float(string="Covered area (sq in)", digits=(8, 2), readonly=True, copy=False)
    clothcraft_print_rate = fields.Float(string="Rate per sq in", digits=(8, 2), readonly=True, copy=False)
    clothcraft_print_size_step = fields.Float(string="Per size step", digits=(8, 2), readonly=True, copy=False)
    clothcraft_print_steps = fields.Integer(string="Size steps", readonly=True, copy=False)

    def write(self, vals):
        result = super().write(vals)
        if 'product_uom_qty' in vals:
            for fee in self.clothcraft_fee_line_ids:
                if fee.product_uom_qty != fee.clothcraft_fee_for_id.product_uom_qty:
                    fee.product_uom_qty = fee.clothcraft_fee_for_id.product_uom_qty
        return result

    @api.model
    def _clothcraft_fee_product(self):
        return self.env.ref('clothcraft.product_customization_fee').product_variant_id
