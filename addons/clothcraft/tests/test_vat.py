from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestPhilippineVat(TransactionCase):
    """The shop runs on PHP with VAT 12% included in the price."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.tax = cls.env['account.chart.template'].ref('l10n_ph_tax_sale_12')

    def test_company_is_php_with_ph_chart(self):
        self.assertEqual(self.company.chart_template, 'ph')
        self.assertEqual(self.company.currency_id.name, 'PHP')

    def test_sale_tax_is_12_percent_and_price_included(self):
        self.assertEqual(self.tax.amount, 12.0)
        self.assertTrue(self.tax.price_include)
        self.assertEqual(self.company.account_sale_tax_id, self.tax)

    def test_inclusive_350_splits_into_untaxed_and_vat(self):
        product = self.env['product.product'].create({
            'name': 'VAT Probe', 'list_price': 350.0, 'taxes_id': [(6, 0, self.tax.ids)],
        })
        order = self.env['sale.order'].create({
            'partner_id': self.env['res.partner'].create({'name': 'VAT Buyer'}).id,
            'order_line': [(0, 0, {'product_id': product.id, 'product_uom_qty': 1})],
        })
        line = order.order_line
        self.assertEqual(line.price_unit, 350.0)
        self.assertAlmostEqual(line.price_subtotal, 312.50, places=2)
        self.assertAlmostEqual(line.price_tax, 37.50, places=2)
        self.assertAlmostEqual(line.price_total, 350.0, places=2)
        self.assertAlmostEqual(order.amount_total, 350.0, places=2)

    def test_fix_is_idempotent_and_repairs_excluded_tax(self):
        self.tax.price_include_override = 'tax_excluded'
        self.assertFalse(self.tax.price_include)
        self.env['account.tax']._clothcraft_set_ph_vat_included()
        self.env['account.tax']._clothcraft_set_ph_vat_included()
        self.assertTrue(self.tax.price_include)
