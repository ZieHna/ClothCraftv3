from odoo import api, models


class AccountTax(models.Model):
    _inherit = 'account.tax'

    @api.model
    def _clothcraft_set_ph_vat_included(self, companies=None):
        """Retail prices are VAT-inclusive: make the Philippine 12% sale VAT price-included.

        l10n_ph ships the tax as price-excluded. Companies on another chart are left alone.
        Idempotent, so it is safe to run on every install and update.
        """
        if companies is None:
            companies = self.env['res.company'].search([('chart_template', '=', 'ph')])
        chart = self.env['account.chart.template']
        for company in companies:
            tax = chart.with_company(company).ref('l10n_ph_tax_sale_12', raise_if_not_found=False)
            if tax and tax.price_include_override != 'tax_included':
                tax.price_include_override = 'tax_included'
