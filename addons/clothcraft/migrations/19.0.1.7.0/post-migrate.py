"""Supplier and Restock, phase 3: the stock edit history, the low-stock levels, the low-stock state and the notifications (tables, rights,
rules, the history's database trigger, the daily clean-up job, the global level of 5) arrive with the module update, and restocks gain a
link to the user who made them. No stock is touched: quants, moves, lots and costs stay as they are (existing stock is the zero point).

This writes one thing: the low-stock state of every garment variant is worked out from the stock as it is now, SILENTLY (no notification),
so a variant that is already low does not raise an alert about a drop that happened before this existed. Running it again changes nothing
(the state is the same). Run only on clothcraft_dev and clothcraft_shop, after a verified dump.
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def _facts(cr):
    out = {}
    for table in ('stock_quant', 'stock_move', 'stock_lot', 'stock_picking', 'clothcraft_restock', 'clothcraft_stock_edit',
                  'clothcraft_stock_threshold', 'clothcraft_stock_alert', 'clothcraft_notification'):
        cr.execute(f'SELECT count(*) FROM {table}')  # fixed names above, never input
        out[table] = cr.fetchone()[0]
    cr.execute("SELECT coalesce(sum(q.quantity), 0) FROM stock_quant q JOIN stock_location l ON l.id = q.location_id WHERE l.usage = 'internal'")
    out['on hand'] = cr.fetchone()[0]
    cr.execute("""SELECT count(*) FILTER (WHERE coalesce((p.standard_price->>'1')::numeric, 0) > 0)
                    FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE t.garment_type_id IS NOT NULL""")
    out['garment cost>0'] = cr.fetchone()[0]
    return out


def migrate(cr, version):
    before = _facts(cr)
    env = api.Environment(cr, SUPERUSER_ID, {})
    env['clothcraft.stock.alert']._resync()
    after = _facts(cr)
    cr.execute("SELECT count(*) FILTER (WHERE low), count(*) FROM clothcraft_stock_alert")
    low, total = cr.fetchone()
    cr.execute("SELECT count(*) FROM ir_model_access a JOIN ir_model m ON m.id = a.model_id "
               "WHERE m.model IN ('clothcraft.stock.edit', 'clothcraft.stock.threshold', 'clothcraft.stock.alert', 'clothcraft.notification')")
    acls = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM ir_rule r JOIN ir_model m ON m.id = r.model_id "
               "WHERE m.model IN ('clothcraft.stock.edit', 'clothcraft.stock.threshold', 'clothcraft.stock.alert', 'clothcraft.notification')")
    rules = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM pg_trigger WHERE tgname = 'clothcraft_stock_edit_guard' AND NOT tgisinternal")
    trigger = cr.fetchone()[0]
    cr.execute("SELECT threshold FROM clothcraft_stock_threshold WHERE scope = 'global' ORDER BY id LIMIT 1")
    level = cr.fetchone()
    cr.execute("SELECT count(*) FROM ir_cron c JOIN ir_model_data d ON d.res_id = c.id AND d.model = 'ir.cron' "
               "WHERE d.module = 'clothcraft' AND d.name = 'ir_cron_notification_cleanup'")
    cron = cr.fetchone()[0]
    untouched = all(before[key] == after[key] for key in ('stock_quant', 'stock_move', 'stock_lot', 'stock_picking', 'on hand', 'garment cost>0'))
    _logger.info('clothcraft stock phase 3 in %s: %s | alert states %s (low %s) | global level %s, ACL rows %s, rules %s, history trigger %s, cleanup job %s | '
                 'stock untouched by the migration: %s', cr.dbname, ', '.join(f'{key} {value}' for key, value in after.items()), total, low,
                 level[0] if level else None, acls, rules, trigger, cron, untouched)
    if not untouched:
        _logger.warning('clothcraft stock phase 3 in %s: STOCK COUNTS CHANGED during the migration: before %s, after %s', cr.dbname, before, after)
