from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestPriceHistoryCost(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.history = cls.env['clothcraft.price.history']
        cls.template = cls.env['product.template'].create({'name': 'Cost Tee', 'list_price': 500})
        cls.product = cls.template.product_variant_id

    def _rows(self, kind, **extra):
        # sale-price rows belong to the template; cost rows belong to the variant
        scope = ('product_tmpl_id', '=', self.template.id) if kind == 'sale' else ('product_id', '=', self.product.id)
        return self.history.search([scope, ('kind', '=', kind)] +
                                   [(k, '=', v) for k, v in extra.items()], order='id')

    def test_cost_change_logged_with_user(self):
        user = self.env.ref('base.user_admin')
        self.product.with_user(user).sudo().write({'standard_price': 120})
        row = self._rows('cost')[-1]
        self.assertEqual((row.old_price, row.new_price), (0.0, 120.0))
        self.assertEqual(row.create_uid, user)

    def test_unchanged_cost_not_logged(self):
        self.product.standard_price = 120
        count = len(self._rows('cost'))
        self.product.standard_price = 120
        self.assertEqual(len(self._rows('cost')), count)

    def test_cost_is_per_company(self):
        company_b = self.env['res.company'].create({'name': 'Company B'})
        company_a = self.env.company
        self.product.with_company(company_a).standard_price = 10
        self.product.with_company(company_b).standard_price = 20
        self.product.with_company(company_b).standard_price = 25
        a_rows = self._rows('cost', company_id=company_a.id)
        b_rows = self._rows('cost', company_id=company_b.id)
        self.assertEqual([(r.old_price, r.new_price) for r in a_rows], [(0.0, 10.0)])
        self.assertEqual([(r.old_price, r.new_price) for r in b_rows], [(0.0, 20.0), (20.0, 25.0)])
        # the values themselves stay separate per company
        self.assertEqual(self.product.with_company(company_a).standard_price, 10)
        self.assertEqual(self.product.with_company(company_b).standard_price, 25)

    def test_template_cost_write_goes_through_variant_hook(self):
        self.template.standard_price = 77
        self.assertEqual(self._rows('cost')[-1].new_price, 77.0)

    def test_sale_price_initial_and_change(self):
        rows = self._rows('sale')
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows.is_initial)
        self.assertEqual(rows.new_price, 500.0)
        self.template.list_price = 650
        row = self._rows('sale')[-1]
        self.assertEqual((row.old_price, row.new_price, row.is_initial), (500.0, 650.0, False))

    def test_unchanged_sale_price_not_logged(self):
        self.template.list_price = 500
        self.assertEqual(len(self._rows('sale')), 1)

    def test_price_extra_change_logged_with_label(self):
        attribute = self.env['product.attribute'].create({
            'name': 'Test Size', 'create_variant': 'always',
            'value_ids': [(0, 0, {'name': 'S'}), (0, 0, {'name': 'XL'})],
        })
        template = self.env['product.template'].create({
            'name': 'Extra Tee',
            'attribute_line_ids': [(0, 0, {
                'attribute_id': attribute.id,
                'value_ids': [(6, 0, attribute.value_ids.ids)],
            })],
        })
        ptav = template.attribute_line_ids.product_template_value_ids.filtered(lambda v: v.name == 'XL')
        ptav.price_extra = 50
        row = self.history.search([('product_tmpl_id', '=', template.id), ('kind', '=', 'extra')])
        self.assertEqual((row.old_price, row.new_price), (0.0, 50.0))
        self.assertEqual(row.description, 'Test Size: XL')

    def test_vendor_price_logged_on_create_and_change(self):
        vendor = self.env['res.partner'].create({'name': 'Vendor One'})
        info = self.env['product.supplierinfo'].create({
            'partner_id': vendor.id, 'product_tmpl_id': self.template.id, 'price': 200,
        })
        rows = self.history.search([('product_tmpl_id', '=', self.template.id), ('kind', '=', 'vendor_cost')])
        self.assertEqual((rows.partner_id, rows.new_price, rows.is_initial), (vendor, 200.0, True))
        info.price = 230
        row = self.history.search([('product_tmpl_id', '=', self.template.id),
                                   ('kind', '=', 'vendor_cost')], order='id desc', limit=1)
        self.assertEqual((row.old_price, row.new_price, row.partner_id), (200.0, 230.0, vendor))

    def test_history_cannot_be_edited_or_deleted(self):
        self.product.standard_price = 5
        row = self._rows('cost')[-1]
        with self.assertRaises(UserError):
            row.write({'new_price': 1})
        with self.assertRaises(UserError):
            row.unlink()
