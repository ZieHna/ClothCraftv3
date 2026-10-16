# Run with: odoo shell -d <db> --no-http < config/set_ph_company.py
# Sets the main company to the Philippines / PHP. Must run BEFORE the `account` module is installed,
# otherwise the generic chart (USD, 15%) is loaded instead of l10n_ph (PHP, VAT 12%).
php = env.ref('base.PHP')
php.active = True
company = env.ref('base.main_company')
company.write({'country_id': env.ref('base.ph').id, 'currency_id': php.id})
env.cr.commit()
print("Company set to", company.country_id.code, company.currency_id.name)
