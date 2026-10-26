"""One read-only list for the staff forms (Supplier and Restock, phase 4): the garment types with the sizes and colours they really come in.

A supply line (models/supplier.py) must name a size and a colour that an active variant of that garment type carries BOTH of, and the
combination is checked strictly. This lists exactly what passes that check, so a form never offers a combination Odoo would refuse. It reads
products only: no schema, no data. Same session and role checks as the other staff methods (api_supplier.py): Inventory and Administrator.
"""
from odoo import api, models


class ClothcraftApiOptions(models.AbstractModel):
    _inherit = 'clothcraft.api'

    @api.model
    def staff_garment_options(self, payload):
        """payload: sid_hash. status ok: garment_types, each {id, code, name, sizes [{id, name}], colors [{id, name, html}], combos [[size id,
        colour id]]} for the active garment types that have active variants. Sizes and colours come in the order Odoo keeps them."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        size_attr, color_attr = self.env.ref('clothcraft.attribute_size'), self.env.ref('clothcraft.attribute_color')
        variants = self.env['product.product'].sudo().search([
            ('product_tmpl_id.garment_type_id', '!=', False), ('product_tmpl_id.garment_type_id.active', '=', True), ('active', '=', True)])
        found = {}  # garment type -> {'sizes': values, 'colors': values, 'combos': set of (size id, colour id)}
        for variant in variants:
            values = variant.product_template_attribute_value_ids.product_attribute_value_id
            sizes, colors = values.filtered(lambda v: v.attribute_id == size_attr), values.filtered(lambda v: v.attribute_id == color_attr)
            entry = found.setdefault(variant.product_tmpl_id.garment_type_id, {'sizes': self.env['product.attribute.value'], 'colors': self.env['product.attribute.value'], 'combos': set()})
            entry['sizes'] |= sizes
            entry['colors'] |= colors
            entry['combos'] |= {(size.id, color.id) for size in sizes for color in colors}
        order = lambda values: values.sorted(lambda v: (v.sequence, v.id))  # noqa: E731
        return {**info, 'status': 'ok', 'garment_types': [{
            'id': garment.id, 'code': garment.code, 'name': garment.name,
            'sizes': [{'id': v.id, 'name': v.name} for v in order(entry['sizes'])],
            'colors': [{'id': v.id, 'name': v.name, 'html': v.html_color or None} for v in order(entry['colors'])],
            'combos': [list(pair) for pair in sorted(entry['combos'])],
        } for garment, entry in sorted(found.items(), key=lambda item: item[0].name)]}
