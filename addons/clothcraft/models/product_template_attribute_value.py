from odoo import api, models


class ProductTemplateAttributeValue(models.Model):
    _inherit = 'product.template.attribute.value'

    def _clothcraft_label(self):
        self.ensure_one()
        return f"{self.attribute_id.name}: {self.name}"

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        history = self.env['clothcraft.price.history']
        for record in records.filtered('price_extra'):
            history._log('extra', 0.0, record.price_extra, record.product_tmpl_id,
                         description=record._clothcraft_label(), initial=True)
        return records

    def write(self, vals):
        if 'price_extra' not in vals:
            return super().write(vals)
        old = {record.id: record.price_extra for record in self}
        result = super().write(vals)
        history = self.env['clothcraft.price.history']
        for record in self:
            history._log('extra', old[record.id], record.price_extra, record.product_tmpl_id,
                         description=record._clothcraft_label())
        return result
