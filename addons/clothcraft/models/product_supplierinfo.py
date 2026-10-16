from odoo import api, models


class ProductSupplierinfo(models.Model):
    _inherit = 'product.supplierinfo'

    def _clothcraft_note(self):
        """Vendor prices can be in another currency than the company's; say so."""
        self.ensure_one()
        if self.currency_id and self.currency_id != self.env.company.currency_id:
            return f"Currency: {self.currency_id.name}"
        return False

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        history = self.env['clothcraft.price.history']
        for record in records:
            history._log('vendor_cost', 0.0, record.price, record.product_tmpl_id,
                         product=record.product_id, partner=record.partner_id,
                         description=record._clothcraft_note(), initial=True)
        return records

    def write(self, vals):
        if 'price' not in vals:
            return super().write(vals)
        old = {record.id: record.price for record in self}
        result = super().write(vals)
        history = self.env['clothcraft.price.history']
        for record in self:
            history._log('vendor_cost', old[record.id], record.price, record.product_tmpl_id,
                         product=record.product_id, partner=record.partner_id,
                         description=record._clothcraft_note())
        return result
