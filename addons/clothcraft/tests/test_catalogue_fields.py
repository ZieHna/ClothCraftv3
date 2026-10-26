import base64
import importlib.util
import io
import os
import uuid

from PIL import Image

from odoo import Command
from odoo.exceptions import UserError, ValidationError
from odoo.tests.common import TransactionCase, tagged
from odoo.tools import mute_logger


def _png(colour):
    out = io.BytesIO()
    Image.new('RGB', (40, 30), colour).save(out, 'PNG')
    return base64.b64encode(out.getvalue())


def _migration():
    path = os.path.join(os.path.dirname(__file__), '..', 'migrations', '19.0.1.1.0', 'post-migrate.py')
    spec = importlib.util.spec_from_file_location('clothcraft_migrate_8b', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@tagged('post_install', '-at_install', 'clothcraft')
class TestCatalogueFields(TransactionCase):
    """Step 8b: the shop group, the storefront id and the featured flag are Odoo fields; the storefront id is locked once ordered."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.tag = uuid.uuid4().hex[:6]
        cls.garment = env['clothcraft.garment.type'].create({'name': f'Cat {cls.tag}', 'code': f'C{cls.tag}'})
        cls.template = env['product.template'].create({
            'name': f'Field Tee {cls.tag}', 'garment_type_id': cls.garment.id, 'list_price': 300.0, 'is_published': True, 'sale_ok': True,
            'clothcraft_group': 'Women', 'clothcraft_slug': f'w-field-{cls.tag}', 'clothcraft_featured': True, 'image_1920': _png('navy')})
        cls.template.product_variant_id.default_code = f'FLD-{cls.tag}'
        cls.api_user = env['res.users'].create({
            'name': f'api {cls.tag}', 'login': f'apicat_{cls.tag}',
            'group_ids': [Command.set([env.ref('base.group_user').id, env.ref('clothcraft.group_api').id])]})
        cls.api = env(user=cls.api_user)['clothcraft.api']

    def _row(self, template):
        return next((p for p in self.api.catalogue()['products'] if p['id'] == template.id), None)

    # ------------------------------------------------------------------ the fields, as the service reads them
    def test_the_catalogue_carries_group_storefront_id_featured_and_an_image_version(self):
        row = self._row(self.template)
        self.assertEqual((row['group'], row['slug'], row['featured']), ('Women', f'w-field-{self.tag}', True))
        self.assertRegex(row['image_version'], r'^[0-9a-f]{12}$')

    def test_a_published_garment_without_a_group_or_a_storefront_id_stays_off_the_shop(self):
        no_group = self.template.copy({'name': f'No group {self.tag}', 'clothcraft_slug': f'nogroup-{self.tag}', 'clothcraft_group': False, 'is_published': True})
        no_slug = self.template.copy({'name': f'No id {self.tag}', 'is_published': True})   # the storefront id is not copied
        self.assertFalse(no_slug.clothcraft_slug)
        self.assertIsNone(self._row(no_group))
        self.assertIsNone(self._row(no_slug))
        self.assertIsNotNone(self._row(self.template))

    # ------------------------------------------------------------------ the storefront id
    def test_the_storefront_id_is_lower_case_letters_digits_and_single_dashes(self):
        for bad in ('M-TEE', 'm tee', 'm--tee', '-m', 'm-', 'tée'):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                self.template.clothcraft_slug = bad
        self.template.clothcraft_slug = f'w-field-{self.tag}-2'
        self.assertEqual(self.template.clothcraft_slug, f'w-field-{self.tag}-2')

    @mute_logger('odoo.sql_db')
    def test_two_products_cannot_share_a_storefront_id(self):
        other = self.template.copy({'name': f'Other {self.tag}'})
        with self.assertRaises(Exception), self.cr.savepoint():
            other.clothcraft_slug = self.template.clothcraft_slug
            other.flush_recordset()

    def test_the_storefront_id_is_locked_once_the_product_has_been_ordered(self):
        self.template.clothcraft_slug = f'w-before-{self.tag}'   # not ordered yet: free to change
        partner = self.env['res.partner'].create({'name': f'Buyer {self.tag}'})
        self.env['sale.order'].create({'partner_id': partner.id, 'order_line': [Command.create({'product_id': self.template.product_variant_id.id})]})
        with self.assertRaisesRegex(UserError, 'cannot change once the product has been ordered'):
            self.template.clothcraft_slug = f'w-after-{self.tag}'
        with self.assertRaises(UserError):
            self.template.clothcraft_slug = False
        self.template.write({'clothcraft_slug': f'w-before-{self.tag}', 'clothcraft_featured': False})   # the same id, and other fields: fine
        self.assertEqual(self.template.clothcraft_slug, f'w-before-{self.tag}')
        self.template.list_price = 320.0
        self.assertEqual(self.template.list_price, 320.0)

    def test_an_ordered_product_without_a_storefront_id_may_get_its_first_one(self):
        first = self.template.copy({'name': f'First id {self.tag}'})
        partner = self.env['res.partner'].create({'name': f'Early buyer {self.tag}'})
        self.env['sale.order'].create({'partner_id': partner.id, 'order_line': [Command.create({'product_id': first.product_variant_id.id})]})
        first.clothcraft_slug = f'first-{self.tag}'
        self.assertEqual(first.clothcraft_slug, f'first-{self.tag}')
        with self.assertRaises(UserError):
            first.clothcraft_slug = f'second-{self.tag}'

    def test_staff_see_the_storefront_fields_on_the_product_form(self):
        arch = self.env['product.template'].with_user(self.env.ref('base.user_admin')).get_view(view_type='form')['arch']
        for field in ('clothcraft_group', 'clothcraft_slug', 'clothcraft_featured'):
            self.assertIn(f'name="{field}"', arch)

    # ------------------------------------------------------------------ the picture
    def test_the_image_is_odoo_s_own_and_its_version_follows_the_picture(self):
        first = self.api.product_image(self.template.clothcraft_slug)
        self.assertEqual(first['status'], 'ok')
        self.assertEqual(first['mimetype'], 'image/png')
        self.assertTrue(base64.b64decode(first['data']).startswith(b'\x89PNG'))
        self.assertEqual(first['version'], self._row(self.template)['image_version'])
        self.template.image_1920 = _png('red')
        second = self.api.product_image(self.template.clothcraft_slug)
        self.assertNotEqual(first['version'], second['version'])
        self.assertEqual(second['version'], self._row(self.template)['image_version'])

    def test_an_unknown_storefront_id_or_a_product_without_a_picture_has_no_image(self):
        self.assertEqual(self.api.product_image('no-such-product'), {'status': 'not_found'})
        bare = self.template.copy({'name': f'Bare {self.tag}', 'clothcraft_slug': f'bare-{self.tag}', 'is_published': True, 'image_1920': False})
        self.assertEqual(self.api.product_image(bare.clothcraft_slug), {'status': 'not_found'})
        hidden = self.template.copy({'name': f'Unpublished {self.tag}', 'clothcraft_slug': f'hid-{self.tag}', 'is_published': False})
        self.assertEqual(self.api.product_image(hidden.clothcraft_slug), {'status': 'not_found'})

    # ------------------------------------------------------------------ the migration of the garments that exist
    def test_the_migration_fills_the_fields_from_the_sku_and_the_former_featured_list(self):
        migration = _migration()
        migration.FEATURED = {f'm-q{self.tag}'}

        def garment(code):
            template = self.env['product.template'].create({'name': f'Old {code}', 'garment_type_id': self.garment.id, 'is_published': True})
            template.product_variant_id.default_code = code
            return template

        sim = garment(f'SIM-M-Q{self.tag.upper()}-BLK-S')
        plain = garment(f'W-R{self.tag.upper()}-WHT-M')
        odd = garment(f'ODD{self.tag}')
        # another product already has the id this one would get
        self.template.copy({'name': f'Holder {self.tag}', 'clothcraft_slug': f'k-x{self.tag}'})
        taken = garment(f'K-X{self.tag.upper()}-RED-S')
        migration.fill(self.env)
        self.assertEqual((sim.clothcraft_group, sim.clothcraft_slug, sim.clothcraft_featured), ('Men', f'm-q{self.tag}', True))
        self.assertEqual((plain.clothcraft_group, plain.clothcraft_slug, plain.clothcraft_featured), ('Women', f'w-r{self.tag}', False))
        self.assertFalse(odd.clothcraft_slug)       # a code that does not follow the pattern: left for the product form
        self.assertFalse(taken.clothcraft_slug)     # the id it would get is taken: left alone, never a duplicate
        self.assertEqual(migration.storefront_facts('SIM-B-ONES-GRY-XS'), ('Babies', 'b-ones'))
        self.assertEqual(migration.storefront_facts('K-JKT-RED-XS'), ('Kids', 'k-jkt'))
        self.assertIsNone(migration.storefront_facts('X-JKT-RED'))
