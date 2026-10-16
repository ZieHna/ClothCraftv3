from psycopg2 import IntegrityError

from odoo.exceptions import AccessError
from odoo.tests import TransactionCase, tagged
from odoo.tools import mute_logger


@tagged('post_install', '-at_install', 'clothcraft')
class TestGarmentType(TransactionCase):

    def test_create_and_default_company(self):
        garment = self.env['clothcraft.garment.type'].create({'name': 'T-Shirt', 'code': 'TSH'})
        self.assertEqual(garment.company_id, self.env.company)
        self.assertTrue(garment.active)

    @mute_logger('odoo.sql_db')
    def test_code_unique_per_company(self):
        self.env['clothcraft.garment.type'].create({'name': 'T-Shirt', 'code': 'TSH'})
        with self.assertRaises(IntegrityError), self.cr.savepoint():
            self.env['clothcraft.garment.type'].create({'name': 'Tee 2', 'code': 'TSH'})

    def test_internal_user_is_read_only(self):
        user = self.env['res.users'].create({
            'name': 'Plain User', 'login': 'plain_user_cc',
            'group_ids': [(6, 0, [self.env.ref('base.group_user').id])],
        })
        garment_model = self.env['clothcraft.garment.type'].with_user(user)
        garment_model.search([])  # reading is allowed
        with self.assertRaises(AccessError):
            garment_model.create({'name': 'Hoodie', 'code': 'HOO'})
