from odoo import api, fields, models


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    garment_type_id = fields.Many2one(
        'clothcraft.garment.type', string="Garment Type", index=True, ondelete='restrict')

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            # Garments are tracked stock and must not oversell (Odoo defaults to selling out of stock).
            if vals.get('garment_type_id') and vals.get('type', 'consu') == 'consu':
                vals.setdefault('is_storable', True)
                vals.setdefault('allow_out_of_stock_order', False)
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
