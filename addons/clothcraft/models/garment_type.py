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

    _code_uniq = models.Constraint('UNIQUE(code, company_id)', 'The garment code must be unique per company.')
