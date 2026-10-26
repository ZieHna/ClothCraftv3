from odoo import fields, models


class ClothcraftGarmentType(models.Model):
    """A kind of garment we sell (T-shirt, Hoodie...). Example model for the skeleton."""
    _name = 'clothcraft.garment.type'
    _description = 'Garment Type'
    _order = 'name'

    name = fields.Char(required=True)
    code = fields.Char(required=True, help="Short unique code, e.g. TSH")
    active = fields.Boolean(default=True)
    company_id = fields.Many2one(
        'res.company', default=lambda self: self.env.company, required=True)
    reference_area_sq_in = fields.Float(
        string="Print area at size Small (sq in)", default=200.0, digits=(8, 2),
        help="How many square inches the garment's print box (on its product) is at size Small. The print fee converts a design's "
             "covered area to square inches with it (step 9a).")

    _code_uniq = models.Constraint('UNIQUE(code, company_id)', 'The garment code must be unique per company.')
    _reference_area_positive = models.Constraint('CHECK(reference_area_sq_in > 0)', 'The print area at size Small must be more than 0.')
