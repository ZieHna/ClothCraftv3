"""Read-only extraction of NATIVE Odoo facts into raw pandas tables (B8 step 1).

Every function takes a DB-API cursor (psycopg2's, or Odoo's env.cr) and runs SELECTs only. Nothing here uses clothcraft_state: the
simulated data does not have it. Timestamps come back as stored (naive UTC); transform.py turns them into Asia/Manila days.
Columns are plain names, so the same code reads a simulated copy (module 19.0.1.0.0) and the shop (19.0.1.12.0).
"""
import pandas as pd


def frame(cur, sql, params=None):
    cur.execute(sql, params or ())
    cols = [d[0] for d in cur.description]
    return pd.DataFrame(cur.fetchall(), columns=cols)


def table_exists(cur, name):
    cur.execute("SELECT to_regclass(%s) IS NOT NULL", (name,))
    return bool(cur.fetchone()[0])


def catalogue(cur):
    """Every product variant, with its template and whether it is a garment (garment_type_id set). A customization fee or any other
    non-garment product has garment = False and is never counted as demand."""
    return frame(cur, """
        SELECT pp.id AS product_id, pp.product_tmpl_id AS template_id, pp.default_code AS sku,
               pt.name->>'en_US' AS template_name, (pt.garment_type_id IS NOT NULL) AS garment, pp.active,
               pt.garment_type_id, gt.code AS garment_type_code
        FROM product_product pp JOIN product_template pt ON pt.id = pp.product_tmpl_id
        LEFT JOIN clothcraft_garment_type gt ON gt.id = pt.garment_type_id
        ORDER BY pp.id""")


def order_lines(cur):
    """Every sale order line with its order's state and date (filtering is transform.demand_lines)."""
    return frame(cur, """
        SELECT l.id AS line_id, o.id AS order_id, o.partner_id, o.date_order, o.state, l.product_id, l.product_uom_qty::float AS qty,
               l.display_type
        FROM sale_order_line l JOIN sale_order o ON o.id = l.order_id
        ORDER BY l.id""")


def orders(cur):
    return frame(cur, """
        SELECT id AS order_id, partner_id, date_order, state, amount_total::float AS amount_total FROM sale_order ORDER BY id""")


def stock_moves(cur):
    """Every stock move with its source and destination location usage. quantity is what was moved (Odoo 17+); product_uom_qty is what
    was asked for. A move counts toward on-hand only when it is done and crosses the internal boundary (transform.daily_balance)."""
    return frame(cur, """
        SELECT m.id AS move_id, m.product_id, m.date, m.create_date, m.write_date, m.state, m.quantity::float AS quantity,
               m.product_uom_qty::float AS demand_qty, ls.usage AS src_usage, ld.usage AS dest_usage,
               m.purchase_line_id, m.sale_line_id
        FROM stock_move m JOIN stock_location ls ON ls.id = m.location_id JOIN stock_location ld ON ld.id = m.location_dest_id
        ORDER BY m.id""")


def quants(cur):
    """On hand and reserved now, in internal locations, per variant."""
    return frame(cur, """
        SELECT q.product_id, sum(q.quantity)::float AS on_hand, sum(q.reserved_quantity)::float AS reserved
        FROM stock_quant q JOIN stock_location l ON l.id = q.location_id WHERE l.usage = 'internal'
        GROUP BY q.product_id ORDER BY q.product_id""")


def po_receipts(cur):
    """Purchase orders with their approval time and the time of their first done receipt move (the simulated data's restocks).
    Empty when the purchase tables are absent."""
    if not table_exists(cur, 'purchase_order'):
        return pd.DataFrame(columns=['po_id', 'supplier_id', 'supplier', 'date_order', 'date_approve', 'first_receipt'])
    return frame(cur, """
        SELECT po.id AS po_id, po.partner_id AS supplier_id, p.name AS supplier, po.date_order, po.date_approve, min(m.date) AS first_receipt
        FROM purchase_order po JOIN res_partner p ON p.id = po.partner_id
        JOIN purchase_order_line pol ON pol.order_id = po.id
        JOIN stock_move m ON m.purchase_line_id = pol.id AND m.state = 'done'
        GROUP BY po.id, po.partner_id, p.name, po.date_order, po.date_approve ORDER BY po.id""")


def restock_receipts(cur):
    """ClothCraft restock tickets (the shop's restocks: native receipts without a purchase order): approval time and the day received.
    Empty when the table is absent (the simulated data predates it)."""
    if not table_exists(cur, 'clothcraft_restock'):
        return pd.DataFrame(columns=['restock_id', 'supplier_id', 'supplier', 'state', 'decided_at', 'received_on', 'received_at'])
    return frame(cur, """
        SELECT r.id AS restock_id, r.supplier_id, s.name AS supplier, r.state, r.decided_at, r.received_on, r.received_at
        FROM clothcraft_restock r JOIN clothcraft_supplier s ON s.id = r.supplier_id ORDER BY r.id""")


def supplier_info(cur):
    return frame(cur, """
        SELECT s.id AS supplierinfo_id, s.partner_id AS supplier_id, p.name AS supplier, s.product_tmpl_id AS template_id, s.product_id,
               s.delay, s.min_qty::float AS min_qty, s.price::float AS price
        FROM product_supplierinfo s JOIN res_partner p ON p.id = s.partner_id ORDER BY s.id""")


def outgoing_pickings(cur):
    """Outgoing (delivery) pickings with the sale order they belong to (sale_id, from sale_stock)."""
    return frame(cur, """
        SELECT p.id AS picking_id, p.sale_id AS order_id, p.state, p.date_done
        FROM stock_picking p JOIN stock_picking_type t ON t.id = p.picking_type_id WHERE t.code = 'outgoing' ORDER BY p.id""")


def transactions(cur):
    """Payment transactions linked to sale orders, with the provider's mode (cash_on_delivery, wire_transfer)."""
    return frame(cur, """
        SELECT r.sale_order_id AS order_id, tx.id AS tx_id, tx.state, tx.create_date, pr.custom_mode
        FROM sale_order_transaction_rel r JOIN payment_transaction tx ON tx.id = r.transaction_id
        JOIN payment_provider pr ON pr.id = tx.provider_id ORDER BY tx.id""")


def extract_all(cur):
    """Every raw table the DSS reads, in one place (one transaction is the caller's choice)."""
    return {
        'catalogue': catalogue(cur), 'order_lines': order_lines(cur), 'orders': orders(cur), 'stock_moves': stock_moves(cur),
        'quants': quants(cur), 'po_receipts': po_receipts(cur), 'restock_receipts': restock_receipts(cur), 'supplier_info': supplier_info(cur),
        'outgoing_pickings': outgoing_pickings(cur), 'transactions': transactions(cur),
    }
