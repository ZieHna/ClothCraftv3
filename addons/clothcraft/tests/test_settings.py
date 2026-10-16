from odoo import Command
from odoo.tools import convert_file
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

    def test_settings_survive_update_mode_reload(self):
        """-u must (re)apply the implied groups even though base.group_user is noupdate."""
        user_group = self.env.ref('base.group_user')
        variant = self.env.ref('product.group_product_variant')
        lot = self.env.ref('stock.group_production_lot')
        # Reproduce the live DB state: the links were never written.
        user_group.write({'implied_ids': [Command.unlink(variant.id), Command.unlink(lot.id)]})
        user = self.env['res.users'].create({
            'name': 'Upgrade User', 'login': 'upgrade_user_cc',
            'group_ids': [Command.set([user_group.id])],
        })
        self.assertFalse(user.has_group('product.group_product_variant'))
        self.assertFalse(user.has_group('stock.group_production_lot'))

        convert_file(self.env, 'clothcraft', 'data/settings_data.xml', None, mode='update')
        self.env.invalidate_all()

        self.assertTrue(user.has_group('product.group_product_variant'))
        self.assertTrue(user.has_group('stock.group_production_lot'))
        admin = self.env.ref('base.user_admin')
        self.assertTrue(admin.has_group('product.group_product_variant'))
        self.assertTrue(admin.has_group('stock.group_production_lot'))
