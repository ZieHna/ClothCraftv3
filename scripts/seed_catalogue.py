# Seeds the SHOP'S OWN CATALOGUE (step 8b) into clothcraft_shop, or a throwaway copy named clothcraft_shop_<something>. Any other database
# is refused: this is not the simulation and never runs on clothcraft_sim, clothcraft_dev or the live clothcraft.
#   docker compose run --rm --no-deps -T -v "${PWD}/assets-v1:/mnt/assets-v1:ro" odoo odoo shell -d clothcraft_shop --no-http \
#       < scripts/seed_catalogue.py
# Prerequisites (README "A clean shop database"): the database has base, the Philippine company (config/set_ph_company.py) and the
# clothcraft module. What it makes: the 10 garment types, one category "Garments", the 19 garments of addons/clothcraft/sim/data.py with
# their Color x Size variants (SKUs like M-TEE-BLK-S: no SIM- prefix), images, prices, cost, the storefront facts (shop group, storefront
# id, featured = the best sellers) and a starting stock (one inventory adjustment per variant, one opening lot each). What it does NOT make:
# suppliers, purchase orders, customers, orders, the simulation tag or the simulation marker. It refuses a database that already has
# garments, orders or the marker. SHOP_ASSETS overrides where the product photos are mounted (default /mnt/assets-v1).
import os
import re

from odoo.addons.clothcraft.models.design import fill_print_boxes
from odoo.addons.clothcraft.sim import catalogue
from odoo.addons.clothcraft.sim.data import COLOR_CODE, MARKER_PARAM, PRODUCTS, SIZES
from odoo.addons.clothcraft.sim.seeder import check_prerequisites

db = env.cr.dbname
if not re.fullmatch(r'clothcraft_shop(_[a-z0-9]+)?', db):
    raise SystemExit(f'refusing to seed the shop catalogue into {db!r}: only clothcraft_shop or a throwaway copy clothcraft_shop_<name>')
check_prerequisites(env)
if env['ir.config_parameter'].sudo().get_param(MARKER_PARAM):
    raise SystemExit(f'refusing: {db} carries the simulation marker')
if env['product.template'].with_context(active_test=False).search_count([('garment_type_id', '!=', False)]):
    raise SystemExit(f'refusing: {db} already has garments (seed only an empty shop database)')
if env['sale.order'].search_count([]):
    raise SystemExit(f'refusing: {db} already has orders')

# Starting stock per variant: more of the best sellers (tier A) and of the middle sizes. A few sizes of slow sellers start low (2 or 3, the
# shop's "only N left"), and one starts sold out: so the shop shows both, and the contract tests have a sold-out variant.
BASE = {'A': 24, 'B': 14, 'C': 8}
WEIGHT = {'XS': 0.6, 'S': 0.9, 'M': 1.2, 'L': 1.1, 'XL': 0.8, 'XXL': 0.5}
SOLD_OUT = {('K-JKT', 'XS')}
LOW = {('M-TANK', 'XL'): 2, ('W-POLO', 'XS'): 3}


def shop_code(key, color, size):
    return f'{key}-{COLOR_CODE[color]}-{size}'


def opening_quantity(key, size):
    if (key, size) in SOLD_OUT:
        return 0
    if (key, size) in LOW:
        return LOW[(key, size)]
    return max(2, round(BASE[PRODUCTS[key]['tier']] * WEIGHT[size]))


cfg = {'products': list(PRODUCTS)}
built = catalogue.build_catalogue(env, cfg, None, None, os.environ.get('SHOP_ASSETS', '/mnt/assets-v1'), None, code_of=shop_code, category_name='Garments')

stock = env['stock.warehouse'].search([('company_id', '=', env.company.id)], limit=1).lot_stock_id
quants = env['stock.quant']
for key, entry in built.items():
    entry['template'].standard_price = float(PRODUCTS[key]['cost'])   # the opening stock is valued at the product's cost
    for variant, _color, size in entry['variants']:
        quantity = opening_quantity(key, size)
        if not quantity:
            continue
        lot = env['stock.lot'].create({'name': f'OPEN-{variant.default_code}', 'product_id': variant.id})
        quants |= env['stock.quant'].with_context(inventory_mode=True).create({
            'product_id': variant.id, 'location_id': stock.id, 'lot_id': lot.id, 'inventory_quantity': quantity})
quants.action_apply_inventory()
boxes, no_box = fill_print_boxes(env)   # step 9a: the print box of each garment, from data/garment_bounds.json
env.cr.commit()

variants = [v for entry in built.values() for v, _c, _s in entry['variants']]
on_hand = {v.default_code: int(v.with_context(location=stock.id).qty_available) for v in variants}
counts = sorted(on_hand.values())
print('SHOP CATALOGUE SEEDED', db, '| garments', len(built), '| variants', len(variants), '| units', sum(counts),
      '| sold out', sum(1 for q in counts if q == 0), '| 2 to 90', sum(1 for q in counts if 2 <= q <= 90),
      '| min', counts[0], 'max', counts[-1], '| featured', sorted(e['template'].clothcraft_slug for e in built.values() if e['template'].clothcraft_featured),
      '| print boxes', boxes, '| no box', sorted(no_box))
