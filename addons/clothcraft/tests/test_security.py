from odoo import Command
from odoo.exceptions import AccessError, UserError
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestSecurity(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()

        def make_user(login, *group_xmlids):
            return cls.env['res.users'].create({
                'name': login, 'login': login,
                'group_ids': [Command.set([cls.env.ref(x).id for x in group_xmlids])],
            })

        cls.inventory = make_user('cc_inventory', 'clothcraft.group_inventory')
        cls.admin = make_user('cc_admin', 'clothcraft.group_admin')
        cls.portal = make_user('cc_portal', 'base.group_portal')
        cls.sales_only = make_user('cc_sales', 'sales_team.group_sale_salesman')
        cls.garment = cls.env['clothcraft.garment.type'].create({'name': 'Hoodie', 'code': 'HOO'})
        cls.template = cls.env['product.template'].create(
            {'name': 'Sec Hoodie', 'list_price': 800, 'garment_type_id': cls.garment.id,
             'is_published': True})  # portal users only see published products

    def _assert_refused(self, func):
        """Odoo's assertRaises takes one exception class; accept either refusal here."""
        try:
            with self.cr.savepoint():
                func()
        except (AccessError, UserError):
            return
        self.fail("Operation was not refused")

    # --- garment types
    def test_inventory_staff_can_create_edit_but_not_delete_garment_types(self):
        garment = self.env['clothcraft.garment.type'].with_user(self.inventory).create(
            {'name': 'Cap', 'code': 'CAP'})
        garment.write({'name': 'Cap v2'})
        with self.assertRaises(AccessError):
            garment.unlink()

    def test_admin_can_delete_garment_types(self):
        garment = self.env['clothcraft.garment.type'].with_user(self.admin).create(
            {'name': 'Cap', 'code': 'CAP'})
        garment.unlink()
        self.assertFalse(garment.exists())

    def test_portal_user_cannot_read_garment_types_or_history(self):
        with self.assertRaises(AccessError):
            self.env['clothcraft.garment.type'].with_user(self.portal).search([])
        with self.assertRaises(AccessError):
            self.env['clothcraft.price.history'].with_user(self.portal).search([])

    def test_plain_internal_user_cannot_read_garment_types(self):
        with self.assertRaises(AccessError):
            self.env['clothcraft.garment.type'].with_user(self.sales_only).search([])

    def test_users_without_the_group_can_still_read_products(self):
        for user in (self.portal, self.sales_only):
            data = self.template.with_user(user).read(['name', 'list_price'])
            self.assertEqual(data[0]['name'], 'Sec Hoodie')

    # --- price history
    def test_nobody_can_write_price_history_through_the_app(self):
        history = self.env['clothcraft.price.history'].search([('product_tmpl_id', '=', self.template.id)])
        self.assertTrue(history)
        for user in (self.inventory, self.admin):
            rows = history.with_user(user)
            rows.read(['new_price'])  # reading is allowed
            # ACL has no write/unlink; the model also refuses with its own UserError
            self._assert_refused(lambda: rows.write({'new_price': 1}))
            self._assert_refused(rows.unlink)
            with self.assertRaises(AccessError):
                self.env['clothcraft.price.history'].with_user(user).create({
                    'product_tmpl_id': self.template.id, 'kind': 'sale', 'new_price': 1})

    def test_price_change_by_admin_is_logged_even_though_users_cannot_create_history(self):
        self.template.with_user(self.admin).write({'list_price': 900})
        row = self.env['clothcraft.price.history'].search(
            [('product_tmpl_id', '=', self.template.id), ('kind', '=', 'sale')], order='id desc', limit=1)
        self.assertEqual((row.old_price, row.new_price), (800.0, 900.0))
        self.assertEqual(row.create_uid, self.admin)

    def test_roles_imply_native_groups(self):
        self.assertTrue(self.inventory.has_group('stock.group_stock_user'))
        self.assertTrue(self.inventory.has_group('purchase.group_purchase_user'))
        self.assertFalse(self.inventory.has_group('stock.group_stock_manager'))
        self.assertTrue(self.admin.has_group('clothcraft.group_inventory'))
        self.assertTrue(self.admin.has_group('stock.group_stock_manager'))
        self.assertTrue(self.admin.has_group('purchase.group_purchase_manager'))
