from odoo import models


class AccountChartTemplate(models.AbstractModel):
    _inherit = 'account.chart.template'

    def _post_load_data(self, template_code, company, template_data):
        super()._post_load_data(template_code, company, template_data)
        # On a fresh install Odoo loads the chart after all module data, so the <function> in
        # settings_data.xml runs too early; apply the VAT-included setting as the chart loads.
        if template_code == 'ph':
            self.env['account.tax']._clothcraft_set_ph_vat_included(company or self.env.company)
