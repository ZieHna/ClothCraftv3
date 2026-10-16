from psycopg2 import IntegrityError

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
