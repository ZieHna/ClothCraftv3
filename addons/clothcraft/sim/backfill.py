"""Stamp create_date / write_date with the simulated dates.

Odoo takes create_date and write_date from the database clock (the transaction timestamp), which cannot be
frozen, so every simulated row carries the day the seed ran. This module rewrites them, with SQL, from the dates
the simulation already holds: order and receipt dates, delivery dates, payment changes, customer join dates,
cancellation times, and (for the price history) a map recorded while the simulation ran.
"""
from .data import CATEGORY_NAME, GARMENT_TYPES, SIM_LABEL


class PriceStamps:
    """Remembers the simulated time of every clothcraft_price_history row, as id ranges."""

    def __init__(self, cr):
        self.cr = cr
        self.ranges = []
        self.last = self._max()

    def _max(self):
        self.cr.execute("SELECT COALESCE(MAX(id), 0) FROM clothcraft_price_history")
        return self.cr.fetchone()[0]

    def after(self, when):
        newest = self._max()
        if newest > self.last:
            self.ranges.append((self.last, newest, when))
            self.last = newest


def backfill(env, labels, before, launch, joins, cancels, price_ranges, baseline_message_id):
    """Returns {table: rows updated}. `before` is labels.preexisting() taken before the seed."""
    cr = env.cr
    counts = {}

    def run(table, sql, params=()):
        cr.execute(sql, params)
        counts[table] = counts.get(table, 0) + cr.rowcount

    cr.execute("DROP TABLE IF EXISTS sim_so, sim_po, sim_tmpl, sim_prod, sim_partner, sim_picking, sim_cancel, sim_join, sim_stamp")
    cr.execute("CREATE TEMP TABLE sim_so AS SELECT order_id AS id FROM sale_order_tag_rel WHERE tag_id = ANY(%s)", (labels['order'].ids,))
    cr.execute("CREATE TEMP TABLE sim_partner AS SELECT partner_id AS id FROM res_partner_res_partner_category_rel WHERE category_id = ANY(%s)", (labels['partner'].ids,))
    cr.execute("CREATE TEMP TABLE sim_po AS SELECT id FROM purchase_order WHERE origin = 'SIM' AND partner_id IN (SELECT id FROM sim_partner)")
    cr.execute("CREATE TEMP TABLE sim_tmpl AS SELECT product_template_id AS id FROM product_tag_product_template_rel WHERE product_tag_id = ANY(%s)", (labels['product'].ids,))
    cr.execute("CREATE TEMP TABLE sim_prod AS SELECT id FROM product_product WHERE product_tmpl_id IN (SELECT id FROM sim_tmpl)")
    cr.execute("""CREATE TEMP TABLE sim_picking AS
                  SELECT id FROM stock_picking WHERE sale_id IN (SELECT id FROM sim_so)
                  UNION SELECT stock_picking_id FROM purchase_order_stock_picking_rel WHERE purchase_order_id IN (SELECT id FROM sim_po)""")
    cr.execute("CREATE TEMP TABLE sim_cancel (order_id int, ts timestamp)")
    for order_id, when in cancels.items():
        cr.execute("INSERT INTO sim_cancel VALUES (%s, %s)", (order_id, when))
    cr.execute("CREATE TEMP TABLE sim_join (partner_id int, ts timestamp)")
    for partner_id, when in joins.items():
        cr.execute("INSERT INTO sim_join VALUES (%s, %s)", (partner_id, when))
    cr.execute("CREATE TEMP TABLE sim_stamp (lo int, hi int, ts timestamp)")
    for low, high, when in price_ranges:
        cr.execute("INSERT INTO sim_stamp VALUES (%s, %s, %s)", (low, high, when))

    # ---- sales side
    run('sale_order', """
        UPDATE sale_order so SET create_date = so.date_order,
               write_date = GREATEST(so.date_order, COALESCE(c.ts, so.date_order), COALESCE(p.done, so.date_order),
                                     COALESCE(t.changed, so.date_order))
          FROM sim_so s
          LEFT JOIN sim_cancel c ON c.order_id = s.id
          LEFT JOIN (SELECT sale_id, MAX(date_done) AS done FROM stock_picking WHERE sale_id IS NOT NULL GROUP BY sale_id) p ON p.sale_id = s.id
          LEFT JOIN (SELECT r.sale_order_id AS order_id, MAX(tx.last_state_change) AS changed
                       FROM sale_order_transaction_rel r JOIN payment_transaction tx ON tx.id = r.transaction_id
                      GROUP BY r.sale_order_id) t ON t.order_id = s.id
         WHERE so.id = s.id""")
    run('sale_order_line', """
        UPDATE sale_order_line l SET create_date = so.create_date, write_date = so.write_date
          FROM sale_order so WHERE l.order_id = so.id AND so.id IN (SELECT id FROM sim_so)""")
    run('payment_transaction', """
        UPDATE payment_transaction tx SET create_date = so.date_order, write_date = GREATEST(so.date_order, tx.last_state_change)
          FROM sale_order_transaction_rel r JOIN sale_order so ON so.id = r.sale_order_id
         WHERE r.transaction_id = tx.id AND so.id IN (SELECT id FROM sim_so)""")

    # ---- purchasing side
    run('purchase_order', """
        UPDATE purchase_order po SET create_date = COALESCE(po.date_approve, po.date_order),
               write_date = GREATEST(COALESCE(po.date_approve, po.date_order), COALESCE(p.done, po.date_order))
          FROM sim_po s
          LEFT JOIN (SELECT r.purchase_order_id AS order_id, MAX(sp.date_done) AS done
                       FROM purchase_order_stock_picking_rel r JOIN stock_picking sp ON sp.id = r.stock_picking_id
                      GROUP BY r.purchase_order_id) p ON p.order_id = s.id
         WHERE po.id = s.id""")
    run('purchase_order_line', """
        UPDATE purchase_order_line l SET create_date = po.create_date, write_date = po.write_date
          FROM purchase_order po WHERE l.order_id = po.id AND po.id IN (SELECT id FROM sim_po)""")

    # ---- stock documents
    run('stock_picking', """
        UPDATE stock_picking sp SET create_date = so.date_order, write_date = COALESCE(sp.date_done, so.write_date)
          FROM sale_order so WHERE sp.sale_id = so.id AND so.id IN (SELECT id FROM sim_so)""")
    run('stock_picking', """
        UPDATE stock_picking sp SET create_date = COALESCE(po.date_approve, po.date_order),
               write_date = COALESCE(sp.date_done, COALESCE(po.date_approve, po.date_order))
          FROM purchase_order_stock_picking_rel r JOIN purchase_order po ON po.id = r.purchase_order_id
         WHERE r.stock_picking_id = sp.id AND po.id IN (SELECT id FROM sim_po)""")
    run('stock_move', """
        UPDATE stock_move sm SET create_date = sp.create_date, write_date = sp.write_date
          FROM stock_picking sp WHERE sm.picking_id = sp.id AND sp.id IN (SELECT id FROM sim_picking)""")
    run('stock_move_line', """
        UPDATE stock_move_line ml
           SET create_date = CASE WHEN sp.sale_id IS NOT NULL THEN sp.create_date ELSE ml.date END,
               write_date = CASE WHEN sp.sale_id IS NOT NULL THEN sp.write_date ELSE ml.date END
          FROM stock_picking sp WHERE ml.picking_id = sp.id AND sp.id IN (SELECT id FROM sim_picking)""")
    run('stock_reference', """
        UPDATE stock_reference r SET create_date = x.created, write_date = x.written
          FROM (SELECT rel.reference_id, MIN(sm.create_date) AS created, MAX(sm.write_date) AS written
                  FROM stock_reference_move_rel rel JOIN stock_move sm ON sm.id = rel.move_id
                 WHERE sm.picking_id IN (SELECT id FROM sim_picking) GROUP BY rel.reference_id) x
         WHERE r.id = x.reference_id""")
    run('stock_lot', """
        UPDATE stock_lot l SET create_date = x.ts, write_date = x.ts
          FROM (SELECT lot_id, MIN(date) AS ts FROM stock_move_line WHERE lot_id IS NOT NULL AND state = 'done' GROUP BY lot_id) x
         WHERE l.id = x.lot_id AND l.product_id IN (SELECT id FROM sim_prod)""")
    run('stock_quant', "UPDATE stock_quant SET create_date = in_date, write_date = in_date WHERE product_id IN (SELECT id FROM sim_prod)")
    run('stock_quant', """
        UPDATE stock_quant q SET write_date = GREATEST(q.in_date, m.last)
          FROM (SELECT product_id, lot_id, loc, MAX(d) AS last FROM (
                    SELECT product_id, lot_id, location_id AS loc, date AS d FROM stock_move_line WHERE state = 'done'
                    UNION ALL SELECT product_id, lot_id, location_dest_id, date FROM stock_move_line WHERE state = 'done') z
                 GROUP BY product_id, lot_id, loc) m
         WHERE q.product_id IN (SELECT id FROM sim_prod) AND m.product_id = q.product_id AND m.loc = q.location_id
           AND m.lot_id IS NOT DISTINCT FROM q.lot_id""")

    # ---- people: customers from the plan, suppliers at launch
    run('res_partner', "UPDATE res_partner p SET create_date = j.ts, write_date = j.ts FROM sim_join j WHERE p.id = j.partner_id")
    run('res_users', "UPDATE res_users u SET create_date = j.ts, write_date = j.ts FROM sim_join j WHERE u.partner_id = j.partner_id")
    run('res_partner', "UPDATE res_partner SET create_date = %s, write_date = %s WHERE id IN (SELECT id FROM sim_partner) AND id NOT IN (SELECT partner_id FROM sim_join)", (launch, launch))

    # ---- price history, from the recorded ranges
    run('clothcraft_price_history', """
        UPDATE clothcraft_price_history h SET create_date = s.ts, write_date = s.ts FROM sim_stamp s WHERE h.id > s.lo AND h.id <= s.hi""")

    # ---- catalogue, created at launch (a product's write_date is its latest price change)
    run('product_template', """
        UPDATE product_template t SET create_date = %s,
               write_date = GREATEST(%s, COALESCE((SELECT MAX(h.create_date) FROM clothcraft_price_history h WHERE h.product_tmpl_id = t.id), %s))
         WHERE t.id IN (SELECT id FROM sim_tmpl)""", (launch, launch, launch))
    run('product_product', "UPDATE product_product SET create_date = %s, write_date = %s WHERE id IN (SELECT id FROM sim_prod)", (launch, launch))
    run('product_template_attribute_line', "UPDATE product_template_attribute_line SET create_date = %s, write_date = %s WHERE product_tmpl_id IN (SELECT id FROM sim_tmpl)", (launch, launch))
    run('product_template_attribute_value', "UPDATE product_template_attribute_value SET create_date = %s, write_date = %s WHERE product_tmpl_id IN (SELECT id FROM sim_tmpl)", (launch, launch))
    run('product_supplierinfo', """
        UPDATE product_supplierinfo si SET create_date = %s,
               write_date = GREATEST(%s, COALESCE((SELECT MAX(h.create_date) FROM clothcraft_price_history h
                                                    WHERE h.kind = 'vendor_cost' AND h.product_tmpl_id = si.product_tmpl_id
                                                      AND h.partner_id = si.partner_id), %s))
         WHERE si.product_tmpl_id IN (SELECT id FROM sim_tmpl)""", (launch, launch, launch))
    run('product_value', "UPDATE product_value SET create_date = %s, write_date = %s WHERE product_id IN (SELECT id FROM sim_prod) AND move_id IS NULL", (launch, launch))
    run('ir_attachment', "UPDATE ir_attachment SET create_date = %s, write_date = %s WHERE res_model = 'product.template' AND res_id IN (SELECT id FROM sim_tmpl)", (launch, launch))
    run('product_category', "UPDATE product_category SET create_date = %s, write_date = %s WHERE %s AND name = %s", (launch, launch, not before['category'], CATEGORY_NAME))
    created_codes = [code for code in GARMENT_TYPES if code not in before['garment_types']]
    run('clothcraft_garment_type', "UPDATE clothcraft_garment_type SET create_date = %s, write_date = %s WHERE code = ANY(%s)", (launch, launch, created_codes))
    for name, table in (('product', 'product_tag'), ('order', 'crm_tag'), ('partner', 'res_partner_category')):
        run(table, f"UPDATE {table} SET create_date = %s, write_date = %s WHERE id = ANY(%s) AND %s", (launch, launch, labels[name].ids, name not in before['labels']))

    # ---- chatter: messages carry their own simulated date, except a few Odoo posts with the real clock
    # ("The received quantity has been updated."): those take the date of their record
    started = cr.now()
    run('mail_message', "UPDATE mail_message SET create_date = date, write_date = date WHERE id > %s AND date IS NOT NULL AND date < %s", (baseline_message_id, started))
    for model, record_table, sim_ids in (('purchase.order', 'purchase_order', 'sim_po'), ('stock.picking', 'stock_picking', 'sim_picking'), ('sale.order', 'sale_order', 'sim_so')):
        run('mail_message', f"""
            UPDATE mail_message m SET date = r.write_date, create_date = r.write_date, write_date = r.write_date
              FROM {record_table} r WHERE m.model = %s AND m.res_id = r.id AND r.id IN (SELECT id FROM {sim_ids})
               AND m.id > %s AND m.date >= %s""", (model, baseline_message_id, started))
    run('mail_tracking_value', """
        UPDATE mail_tracking_value tv SET create_date = m.create_date, write_date = m.create_date
          FROM mail_message m WHERE tv.mail_message_id = m.id AND m.id > %s""", (baseline_message_id,))
    return counts


def unstamped(env):
    """Rows that still carry the real clock: create_date at or after this transaction's start, per table (anything
    simulated is dated in the past). After `backfill` this must be empty except for the marker parameter."""
    cr = env.cr
    now = cr.now()
    cr.execute("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'create_date' ORDER BY 1")
    left = {}
    for (table,) in cr.fetchall():
        cr.execute(f'SELECT COUNT(*) FROM "{table}" WHERE create_date >= %s', (now,))
        count = cr.fetchone()[0]
        if count:
            left[table] = count
    left.pop('ir_config_parameter', None)    # the marker records when the seed really ran
    return left
