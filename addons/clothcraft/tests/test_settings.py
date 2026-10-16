from odoo import Command
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestSettings(TransactionCase):

    def test_variants_and_lots_on_pricelists_and_multilocation_off(self):
        user = self.env['res.users'].create({
            'name': 'Toggle User', 'login': 'toggle_user_cc',
            'group_ids': [Command.set([self.env.ref('base.group_user').id])],
        })
        self.assertTrue(user.has_group('product.group_product_variant'))
        self.assertTrue(user.has_group('stock.group_production_lot'))
        self.assertFalse(user.has_group('product.group_product_pricelist'))
        self.assertFalse(user.has_group('stock.group_stock_multi_locations'))
