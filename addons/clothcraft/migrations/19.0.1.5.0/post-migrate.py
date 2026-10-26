"""Supplier and Restock, phase 1: the supplier, supply line and unavailable-dates tables, their rights and rules arrive with the module
update. Nothing is moved or created: existing partners and product.supplierinfo rows (the simulation's suppliers) stay as they are, and no
supplier row is made for them. This only checks and logs, so it can run twice with the same result. Run only on clothcraft_dev and
clothcraft_shop, after a verified dump.
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    counts = {}
    for table in ('res_partner', 'product_supplierinfo', 'sale_order', 'clothcraft_supplier', 'clothcraft_supplier_line',
                  'clothcraft_supplier_unavailability'):
        cr.execute(f'SELECT count(*) FROM {table}')  # fixed names above, never input
        counts[table] = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM ir_model_access a JOIN ir_model m ON m.id = a.model_id WHERE m.model LIKE 'clothcraft.supplier%'")
    acls = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM ir_rule r JOIN ir_model m ON m.id = r.model_id WHERE m.model LIKE 'clothcraft.supplier%'")
    rules = cr.fetchone()[0]
    _logger.info('clothcraft supplier phase 1 in %s: %s | ACL rows %s, record rules %s', cr.dbname,
                 ', '.join(f'{table} {count}' for table, count in counts.items()), acls, rules)
    # The search method behind available_now, run once for real: it must build and run its query on this database.
    try:
        suppliers = api.Environment(cr, SUPERUSER_ID, {})['clothcraft.supplier']
        _logger.info('clothcraft supplier phase 1 in %s: available_now search ok (available %s, unavailable %s)', cr.dbname,
                     suppliers.search_count([('available_now', '=', True)]), suppliers.search_count([('available_now', '=', False)]))
    except Exception:  # noqa: BLE001 - a check must not stop the migration; the log line tells
        _logger.warning('clothcraft supplier phase 1 in %s: available_now search FAILED', cr.dbname, exc_info=True)
