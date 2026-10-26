"""Supplier and Restock, phase 2: the restock, restock line and restock history tables, the reference sequence, the rights, the rules and the
history's database trigger arrive with the module update. No row is moved or created: existing stock, partners, suppliers and orders stay as
they are (existing stock is the zero point, with no cost).

One field changes: the costing method of the category the garments live in goes from Average to Standard Price. Under average costing every
receipt at a price would rewrite the products' standard_price (Odoo blends the receipt into it); under standard costing receipts never touch
it. The restock's recorded actual cost is what profit uses, never Odoo's product cost. Only a category whose products are ALL garments is
switched, and only from average (so a second run finds nothing to do). Odoo's own category write recomputes the standard price of its
products only for average and FIFO, and skips standard, so no product cost, stock or stock value moves; the log line says so with numbers.
Run only on clothcraft_dev and clothcraft_shop, after a verified dump (19.0.1.5.0 runs first on a database still at 19.0.1.4.0).
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def _snapshot(cr):
    cr.execute("""SELECT count(*) FILTER (WHERE coalesce((p.standard_price->>'1')::numeric, 0) > 0)
                    FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE t.garment_type_id IS NOT NULL""")
    priced = cr.fetchone()[0]
    cr.execute("SELECT coalesce(sum(q.quantity), 0) FROM stock_quant q JOIN stock_location l ON l.id = q.location_id WHERE l.usage = 'internal'")
    return priced, cr.fetchone()[0]


def _standard_costing(env):
    """(switched, already standard, skipped for mixed products) category counts."""
    switched = already = skipped = 0
    Template = env['product.template'].with_context(active_test=False)
    for category in Template.search([('garment_type_id', '!=', False)]).categ_id:
        if Template.search_count([('categ_id', '=', category.id), ('garment_type_id', '=', False)]):
            skipped += 1
            _logger.warning('clothcraft restock phase 2 in %s: category %s also holds products that are not garments: its costing method is left as it is',
                            env.cr.dbname, category.complete_name)
            continue
        for company in env['res.company'].search([]):
            scoped = category.with_company(company)
            if scoped.property_cost_method == 'average':
                scoped.write({'property_cost_method': 'standard'})
                switched += 1
            else:
                already += 1
    return switched, already, skipped


def migrate(cr, version):
    counts = {}
    for table in ('res_partner', 'clothcraft_supplier', 'sale_order', 'stock_picking', 'stock_move', 'stock_quant', 'clothcraft_restock',
                  'clothcraft_restock_line', 'clothcraft_restock_history'):
        cr.execute(f'SELECT count(*) FROM {table}')  # fixed names above, never input
        counts[table] = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM ir_model_access a JOIN ir_model m ON m.id = a.model_id WHERE m.model LIKE 'clothcraft.restock%'")
    acls = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM ir_rule r JOIN ir_model m ON m.id = r.model_id WHERE m.model LIKE 'clothcraft.restock%'")
    rules = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM pg_trigger WHERE tgname = 'clothcraft_restock_history_guard' AND NOT tgisinternal")
    trigger = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM ir_sequence WHERE code = 'clothcraft.restock'")
    sequence = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM stock_picking_type WHERE code = 'incoming' AND active")
    receipt_types = cr.fetchone()[0]
    _logger.info('clothcraft restock phase 2 in %s: %s | ACL rows %s, record rules %s, history trigger %s, sequence %s, receipt types %s',
                 cr.dbname, ', '.join(f'{table} {count}' for table, count in counts.items()), acls, rules, trigger, sequence, receipt_types)

    priced_before, on_hand_before = _snapshot(cr)
    switched, already, skipped = _standard_costing(api.Environment(cr, SUPERUSER_ID, {}))
    priced_after, on_hand_after = _snapshot(cr)
    _logger.info('clothcraft restock phase 2 in %s: garment costing to Standard Price: categories switched %s, already standard %s, skipped %s | '
                 'garment variants with a cost above 0: %s -> %s, units on hand: %s -> %s', cr.dbname, switched, already, skipped,
                 priced_before, priced_after, on_hand_before, on_hand_after)
