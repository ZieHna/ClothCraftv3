# Which catalogue jobs the STAFF TEST USERS can do in Odoo's own screens (step 8b): every job is done as that user, through the same ORM calls
# the product and inventory screens make, each in a savepoint, and everything is rolled back at the end. Run it on a THROWAWAY copy of
# clothcraft_shop only (clothcraft_shop_<name>):
#   docker compose run --rm --no-deps -T odoo odoo shell -d clothcraft_shop_rights --no-http < scripts/check_catalogue_rights.py
# Prints one line per job: ok, or BLOCKED with Odoo's own reason.
import base64
import io
import re

from PIL import Image

from odoo import Command

if not re.fullmatch(r'clothcraft_shop_[a-z0-9]+', env.cr.dbname):
    raise SystemExit(f'refusing to run in {env.cr.dbname}: only a throwaway copy clothcraft_shop_<name>')

# the service user is there for contrast: it must be refused nearly everything (it only reads the catalogue)
PEOPLE = {'inventory': 'staff.inventory@clothcraft.test', 'admin': 'staff.admin@clothcraft.test', 'api_shop': 'api_shop'}
png = io.BytesIO()
Image.new('RGB', (60, 60), 'navy').save(png, 'PNG')
PICTURE = base64.b64encode(png.getvalue())


def jobs(e):
    """{name: callable(e)}: each does one thing a person would do in the screens, as the user `e` is bound to."""
    T = e['product.template']
    tee = T.search([('clothcraft_slug', '=', 'm-tee')])
    kids = T.search([('clothcraft_slug', '=', 'k-polo')])
    variant = tee.product_variant_ids.filtered(lambda v: v.default_code == 'M-TEE-BLK-M')
    stock = e['stock.warehouse'].search([], limit=1).lot_stock_id

    def menus():
        visible = e['ir.ui.menu']._visible_menu_ids()
        names = [m.complete_name for m in e['ir.ui.menu'].sudo().browse(visible) if m.action and getattr(m.action, 'res_model', '') == 'product.template']
        assert names, 'no menu opens the products'
        return '; '.join(sorted(names)[:3])

    def open_form():
        arch = T.get_view(view_type='form')['arch']
        missing = [f for f in ('clothcraft_group', 'clothcraft_slug', 'clothcraft_featured', 'garment_type_id') if f'name="{f}"' not in arch]
        assert not missing, f'not on the form: {missing}'
        tee.read(['name', 'list_price', 'clothcraft_group', 'clothcraft_slug', 'clothcraft_featured', 'image_1920', 'is_published'])

    def adjust_stock():
        quant = e['stock.quant'].search([('product_id', '=', variant.id), ('location_id', '=', stock.id)], limit=1)
        before = quant.quantity
        quant.with_context(inventory_mode=True).inventory_quantity = before + 1
        quant.action_apply_inventory()
        quant.invalidate_recordset()
        assert quant.quantity == before + 1, f'{before} -> {quant.quantity}'

    def add_variant():
        line = kids.attribute_line_ids.filtered(lambda l: l.attribute_id == e.ref('clothcraft.attribute_size'))
        line.value_ids = [Command.link(e.ref('clothcraft.size_l').id)]
        assert any(v.product_template_attribute_value_ids.filtered(lambda p: p.name == 'L') for v in kids.product_variant_ids)

    def new_product():
        T.create({
            'name': 'Unisex Raglan Tee', 'garment_type_id': tee.garment_type_id.id, 'list_price': 399.0, 'clothcraft_group': 'Men',
            'clothcraft_slug': 'm-raglan', 'image_1920': PICTURE, 'attribute_line_ids': [
                Command.create({'attribute_id': e.ref('clothcraft.attribute_color').id, 'value_ids': [Command.set([e.ref('clothcraft.color_black').id])]}),
                Command.create({'attribute_id': e.ref('clothcraft.attribute_size').id, 'value_ids': [Command.set([e.ref('clothcraft.size_m').id])]})]})

    return {
        'see the products menu': menus,
        'open a product form (with the storefront fields)': open_form,
        'change the price': lambda: tee.write({'list_price': 359.0}),
        'change a size surcharge (XXL extra)': lambda: tee.attribute_line_ids.product_template_value_ids.filtered(lambda v: v.name == 'XXL').write({'price_extra': 60.0}),
        'change the cost': lambda: tee.write({'standard_price': 145.0}),
        'adjust stock (count and apply)': adjust_stock,
        'replace the picture': lambda: tee.write({'image_1920': PICTURE}),
        'set the shop group': lambda: tee.write({'clothcraft_group': 'Women'}),
        'set featured on / off': lambda: tee.write({'clothcraft_featured': False}),
        'change the storefront id (not ordered yet)': lambda: kids.write({'clothcraft_slug': 'k-polo-shirt'}),
        'unpublish / publish': lambda: (tee.write({'is_published': False}), tee.write({'is_published': True})),
        'archive / restore': lambda: (tee.action_archive(), tee.with_context(active_test=False).action_unarchive()),
        'add a size (new variants)': add_variant,
        'add a new garment with variants': new_product,
        'add a garment type': lambda: e['clothcraft.garment.type'].create({'name': 'Raglan', 'code': 'RAGLAN'}),
    }


class Undo(Exception):
    """Raised after a job that worked, so its savepoint is rolled back too: every job starts from the same database."""


results = {}
for role, login in PEOPLE.items():
    user = env['res.users'].search([('login', '=', login)])
    e = env(user=user.id)
    for name, job in jobs(e).items():
        try:
            with env.cr.savepoint():
                note = job()
                e.flush_all()
                raise Undo(note if isinstance(note, str) else '')
        except Undo as done:
            results.setdefault(name, {})[role] = 'ok' + (f' ({done})' if str(done) else '')
        except Exception as error:   # report Odoo's own reason, whatever it is
            results.setdefault(name, {})[role] = f'BLOCKED: {type(error).__name__}: ' + ' '.join(str(error).split())[:160]
        e.invalidate_all()
env.cr.rollback()
for name, by_role in results.items():
    print(f'RIGHTS | {name} | inventory: {by_role.get("inventory")} | admin: {by_role.get("admin")} | api_shop: {by_role.get("api_shop")}')
