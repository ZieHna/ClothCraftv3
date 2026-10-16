from odoo import models


class ProductProduct(models.Model):
    _inherit = 'product.product'

    def write(self, vals):
        if 'standard_price' not in vals:
            return super().write(vals)
        # standard_price is company-dependent: read the old value in the current company.
        old = {product.id: product.standard_price for product in self}
        result = super().write(vals)
        # set by stock.move._set_value when an average-cost recompute comes from a receipt;
        # manual cost edits carry no source and are logged as before
        sources = {pid: (description, partner_id)
                   for pid, description, partner_id in self.env.context.get('clothcraft_cost_sources', ())}
        history = self.env['clothcraft.price.history']
        for product in self:
            description, partner_id = sources.get(product.id, (None, 0))
            history._log('cost', old[product.id], product.standard_price,
                         product.product_tmpl_id, product=product,
                         partner=self.env['res.partner'].browse(partner_id) if partner_id else None,
                         description=description)
        return result
