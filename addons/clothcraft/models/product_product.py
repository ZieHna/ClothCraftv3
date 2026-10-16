from odoo import models


class ProductProduct(models.Model):
    _inherit = 'product.product'

    def write(self, vals):
        if 'standard_price' not in vals:
            return super().write(vals)
        # standard_price is company-dependent: read the old value in the current company.
        old = {product.id: product.standard_price for product in self}
        result = super().write(vals)
        history = self.env['clothcraft.price.history']
        for product in self:
            history._log('cost', old[product.id], product.standard_price,
                         product.product_tmpl_id, product=product)
        return result
