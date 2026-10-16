from odoo import api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare


class ClothcraftPriceHistory(models.Model):
    """Append-only log of sale price, attribute extras, cost and vendor price changes.

    Rows are created by the hooks on the product models (with sudo), never by users.
    """
    _name = 'clothcraft.price.history'
    _description = 'Price History'
    _order = 'id desc'

    product_tmpl_id = fields.Many2one(
        'product.template', required=True, index=True, ondelete='cascade')
    product_id = fields.Many2one('product.product', index=True, ondelete='cascade')
    kind = fields.Selection([
        ('sale', 'Sale price'),
        ('extra', 'Attribute price extra'),
        ('cost', 'Cost'),
        ('vendor_cost', 'Vendor price'),
    ], required=True, index=True)
    old_price = fields.Float(digits='Product Price')
    new_price = fields.Float(digits='Product Price')
    is_initial = fields.Boolean(help="True when there was no previous value.")
    partner_id = fields.Many2one('res.partner', string="Vendor")
    description = fields.Char()
    company_id = fields.Many2one(
        'res.company', required=True, default=lambda self: self.env.company, index=True)
    currency_id = fields.Many2one(related='company_id.currency_id', store=True)

    @api.model
    def _log(self, kind, old, new, product_tmpl, product=None, partner=None,
             description=None, initial=False):
        """Create a history row if the price really changed. Call from write/create hooks."""
        if not initial and float_compare(old, new, precision_digits=self.env['decimal.precision'].precision_get('Product Price')) == 0:
            return self.browse()
        return self.sudo().create({
            'product_tmpl_id': product_tmpl.id,
            'product_id': product.id if product else False,
            'kind': kind,
            'old_price': 0.0 if initial else old,
            'new_price': new,
            'is_initial': initial,
            'partner_id': partner.id if partner else False,
            'description': description or False,
            'company_id': self.env.company.id,
        })

    def write(self, vals):
        raise UserError(self.env._("Price history is read-only."))

    def unlink(self):
        raise UserError(self.env._("Price history cannot be deleted."))
