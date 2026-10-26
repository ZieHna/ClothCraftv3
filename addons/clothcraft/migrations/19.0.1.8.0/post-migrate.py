"""Supplier and Restock, step 7: the opening balance of a supplier (clothcraft_supplier.opening_balance, VAT included, default 0, never negative).

The module update adds the column and its CHECK. This migration only makes sure no supplier has a NULL opening balance (so running it again,
or on a database whose column already existed, changes nothing), and it does NOT set any amount: the three dev suppliers' amounts are set by
scripts/set_opening.py through the staff API, after a verified dump. No stock is touched: quants, moves, lots, pickings, restocks,
notifications and costs must be exactly as they were, and this raises (so the update rolls back) if any of them is not.
"""
import logging

_logger = logging.getLogger(__name__)

TABLES = ('stock_quant', 'stock_move', 'stock_lot', 'stock_picking', 'clothcraft_restock', 'clothcraft_notification', 'clothcraft_supplier')


def _facts(cr):
    out = {}
    for table in TABLES:
        cr.execute(f'SELECT count(*) FROM {table}')  # fixed names above, never input
        out[table] = cr.fetchone()[0]
    cr.execute("SELECT coalesce(sum(q.quantity), 0) FROM stock_quant q JOIN stock_location l ON l.id = q.location_id WHERE l.usage = 'internal'")
    out['units on hand'] = cr.fetchone()[0]
    cr.execute("""SELECT count(*) FILTER (WHERE coalesce((p.standard_price->>'1')::numeric, 0) > 0)
                    FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE t.garment_type_id IS NOT NULL""")
    out['garment cost>0'] = cr.fetchone()[0]
    return out


def migrate(cr, version):
    before = _facts(cr)
    cr.execute("UPDATE clothcraft_supplier SET opening_balance = 0 WHERE opening_balance IS NULL")
    filled = cr.rowcount
    after = _facts(cr)
    if before != after:
        raise RuntimeError(f'the opening balance migration changed something it must not: {before} -> {after}')
    cr.execute("SELECT count(*), coalesce(sum(opening_balance), 0), count(*) FILTER (WHERE opening_balance < 0) FROM clothcraft_supplier")
    suppliers, total, negative = cr.fetchone()
    _logger.info('clothcraft 19.0.1.8.0: opening balance ready. suppliers=%s total opening=%s negative=%s set-to-zero=%s; unchanged: %s',
                 suppliers, total, negative, filled, after)
