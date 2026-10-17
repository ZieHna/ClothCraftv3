from odoo import Command

from .data import CATEGORY_NAME, COLORS, GARMENT_TYPES, PRODUCTS, SIZES, SUPPLIERS, XXL_EXTRA
from .variants import variant_code
from .util import at, quiet, read_image



def build_suppliers(env, cfg, labels):
    """Fake supplier companies on example.com. Returns {key: res.partner}."""
    env = quiet(env)
    used = sorted({s for key in cfg['products'] for s in PRODUCTS[key]['suppliers']})
    suppliers = {}
    for key in used:
        spec = SUPPLIERS[key]
        suppliers[key] = env['res.partner'].create({
            'name': spec['name'], 'email': spec['email'], 'is_company': True,
            'category_id': [Command.set(labels['partner'].ids)]})
    return suppliers


def build_catalogue(env, cfg, labels, suppliers, assets_dir, when):
    """Garment types, one category with average costing, products with Color x Size variants.

    The garment type is set at creation, so B6 makes every product storable and not sellable out of stock.
    Returns {product key: {'template': template, 'variants': [(variant, color, size)]}}.
    """
    env = quiet(env)
    with at(when):
        category = env['product.category'].create({'name': CATEGORY_NAME, 'property_cost_method': 'average'})
        types = {}
        for code, name in GARMENT_TYPES.items():
            types[code] = env['clothcraft.garment.type'].search([('code', '=', code)], limit=1) \
                or env['clothcraft.garment.type'].create({'name': name, 'code': code})
        color_attr, size_attr = env.ref('clothcraft.attribute_color'), env.ref('clothcraft.attribute_size')
        out = {}
        for key in cfg['products']:
            spec = PRODUCTS[key]
            color_values = env['product.attribute.value'].browse([env.ref(COLORS[c]).id for c in spec['colors']])
            size_values = env['product.attribute.value'].browse([env.ref(SIZES[s]).id for s in spec['sizes']])
            template = env['product.template'].create({
                'name': spec['name'], 'garment_type_id': types[spec['gt']].id, 'categ_id': category.id,
                'list_price': float(spec['price']), 'tracking': 'lot', 'website_published': True,
                'sale_ok': True, 'purchase_ok': True,
                'product_tag_ids': [Command.set(labels['product'].ids)],
                'image_1920': read_image(assets_dir, spec['image']),
                'attribute_line_ids': [
                    Command.create({'attribute_id': color_attr.id, 'value_ids': [Command.set(color_values.ids)]}),
                    Command.create({'attribute_id': size_attr.id, 'value_ids': [Command.set(size_values.ids)]})],
            })
            rows = []
            for variant in template.product_variant_ids.sorted('id'):
                ptavs = variant.product_template_attribute_value_ids
                color = next(c for c in spec['colors'] if env.ref(COLORS[c]) in ptavs.product_attribute_value_id)
                size = next(s for s in spec['sizes'] if env.ref(SIZES[s]) in ptavs.product_attribute_value_id)
                variant.default_code = variant_code(key, color, size)
                rows.append((variant, color, size))
            if "XXL" in spec['sizes']:
                template.attribute_line_ids.product_template_value_ids.filtered(
                    lambda v: v.product_attribute_value_id == env.ref(SIZES["XXL"])).price_extra = XXL_EXTRA
            for supplier_key in spec['suppliers']:
                spec_s = SUPPLIERS[supplier_key]
                env['product.supplierinfo'].create({
                    'partner_id': suppliers[supplier_key].id, 'product_tmpl_id': template.id,
                    'price': round(spec['cost'] * spec_s['cost_factor'], 2), 'delay': spec_s['lead'][0]})
            out[key] = {'template': template, 'variants': rows}
    return out
