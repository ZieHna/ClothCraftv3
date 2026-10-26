import re

from odoo import Command, api, fields, models
from odoo.exceptions import UserError, ValidationError

# The storefront facts of a garment, kept in Odoo so staff edit them in the product form (step 8b). They used to be read off the SKU
# (SIM-M-TEE-...) and a list in the service's settings.
SHOP_GROUPS = [('Men', 'Men'), ('Women', 'Women'), ('Kids', 'Kids'), ('Babies', 'Babies')]
SLUG = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    garment_type_id = fields.Many2one(
        'clothcraft.garment.type', string="Garment Type", index=True, ondelete='restrict')
    clothcraft_group = fields.Selection(SHOP_GROUPS, string="Shop group", help="Where the shop lists it: Men, Women, Kids or Babies.")
    clothcraft_slug = fields.Char(
        string="Storefront id", copy=False, index=True,
        help="The product's address on the shop (/products/<id>): lower-case letters, digits and dashes, e.g. m-tee. "
             "It cannot change once the product has been ordered.")
    clothcraft_featured = fields.Boolean(string="Featured on the shop", help="Shown in the shop's Featured section while it is in stock.")
    # The print box (step 9a): the garment's bounding rectangle in the editor's 800 x 800 design square, measured from its pictures by
    # frontend/scripts/measure-garment-bounds.mjs (data/garment_bounds.json). A design is clipped to it and priced by it. There is NO
    # fallback: a garment without a box cannot be customized (the API says so and this form warns).
    clothcraft_print_x = fields.Float(string="Print box left", digits=(8, 2))
    clothcraft_print_y = fields.Float(string="Print box top", digits=(8, 2))
    clothcraft_print_w = fields.Float(string="Print box width", digits=(8, 2))
    clothcraft_print_h = fields.Float(string="Print box height", digits=(8, 2))
    clothcraft_designable = fields.Boolean(
        string="Can be customized", compute='_compute_clothcraft_designable',
        help="Customers can design on this garment: it has a print box and its garment type gives the print area at size Small.")

    _clothcraft_slug_uniq = models.Constraint('UNIQUE(clothcraft_slug)', 'Another product already has this storefront id.')

    @api.depends('clothcraft_print_w', 'clothcraft_print_h', 'garment_type_id.reference_area_sq_in')
    def _compute_clothcraft_designable(self):
        for template in self:
            template.clothcraft_designable = bool(
                template.clothcraft_print_w > 0 and template.clothcraft_print_h > 0 and template.garment_type_id.reference_area_sq_in > 0)

    def _clothcraft_print_box(self):
        """{x, y, width, height} in design units, or None when the garment cannot be customized."""
        self.ensure_one()
        if not self.clothcraft_designable:
            return None
        return {'x': self.clothcraft_print_x, 'y': self.clothcraft_print_y, 'width': self.clothcraft_print_w, 'height': self.clothcraft_print_h}

    @api.constrains('clothcraft_print_x', 'clothcraft_print_y', 'clothcraft_print_w', 'clothcraft_print_h')
    def _check_clothcraft_print_box(self):
        for t in self:
            box = (t.clothcraft_print_x, t.clothcraft_print_y, t.clothcraft_print_w, t.clothcraft_print_h)
            if not any(box):
                continue
            if t.clothcraft_print_w <= 0 or t.clothcraft_print_h <= 0 or t.clothcraft_print_x < 0 or t.clothcraft_print_y < 0 \
                    or t.clothcraft_print_x + t.clothcraft_print_w > 800 or t.clothcraft_print_y + t.clothcraft_print_h > 800:
                raise ValidationError(self.env._(
                    "The print box of %(product)s must lie inside the 800 x 800 design square, with a width and a height.", product=t.display_name))

    @api.constrains('clothcraft_slug')
    def _check_clothcraft_slug(self):
        for template in self:
            if template.clothcraft_slug and not SLUG.match(template.clothcraft_slug):
                raise ValidationError(self.env._(
                    "The storefront id %(slug)s can only use lower-case letters, digits and single dashes (for example m-tee).",
                    slug=template.clothcraft_slug))

    @api.model
    def _clothcraft_fee_product_taxes(self):
        """The customization fee carries the company's sale tax (12% VAT, included), on install and every -u."""
        fee = self.env.ref('clothcraft.product_customization_fee', raise_if_not_found=False)
        tax = self.env.company.account_sale_tax_id
        if fee and tax:
            fee.write({'taxes_id': [Command.set(tax.ids)], 'supplier_taxes_id': [Command.clear()]})

    def _clothcraft_ordered(self):
        """The templates of self that appear on at least one sale order line (any state)."""
        if not self:
            return self
        lines = self.env['sale.order.line'].sudo().search_read([('product_id.product_tmpl_id', 'in', self.ids)], ['product_id'])
        ordered = self.env['product.product'].sudo().browse({line['product_id'][0] for line in lines}).product_tmpl_id
        return self & ordered

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
        if 'clothcraft_slug' in vals:
            # an ordered product's address is in order pages, links and receipts: once ordered it cannot change or be cleared. Giving a
            # product its FIRST storefront id is always allowed (that is what the step 8b migration does to products already ordered).
            changing = self.filtered(lambda t: t.clothcraft_slug and t.clothcraft_slug != (vals['clothcraft_slug'] or False))
            if changing._clothcraft_ordered():
                raise UserError(self.env._("The storefront id cannot change once the product has been ordered."))
        if 'list_price' not in vals:
            return super().write(vals)
        old = {template.id: template.list_price for template in self}
        result = super().write(vals)
        history = self.env['clothcraft.price.history']
        for template in self:
            history._log('sale', old[template.id], template.list_price, template)
        return result
