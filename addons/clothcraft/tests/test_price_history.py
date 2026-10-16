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
        return self.history.search([('product_id', '=', self.product.id), ('kind', '=', kind)] +
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

    def test_history_cannot_be_edited_or_deleted(self):
        self.product.standard_price = 5
        row = self._rows('cost')[-1]
        with self.assertRaises(UserError):
            row.write({'new_price': 1})
        with self.assertRaises(UserError):
            row.unlink()
