from odoo import api, models


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    @api.model_create_multi
    def create(self, vals_list):
        templates = super().create(vals_list)
        history = self.env['clothcraft.price.history']
        for template in templates:
            history._log('sale', 0.0, template.list_price, template, initial=True)
        return templates

    def write(self, vals):
        if 'list_price' not in vals:
            return super().write(vals)
        old = {template.id: template.list_price for template in self}
        result = super().write(vals)
        history = self.env['clothcraft.price.history']
        for template in self:
            history._log('sale', old[template.id], template.list_price, template)
        return result
