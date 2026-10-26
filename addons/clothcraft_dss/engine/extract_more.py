"""Read-only extraction of the facts the B8 S1 additions need beyond extract.py (restock, segments, alerts, health).

Same rules as extract.py: SELECTs only, through a cursor it is given. Tables and columns that exist only in the shop (clothcraft.supplier,
restocks, stock alerts, the order audit, sale.order.clothcraft_state) are optional: when absent the function returns an empty frame with
the same columns, so one code path reads a simulated copy (module 19.0.1.0.0) and the shop (19.0.1.12.0). The simulation marker is
detected by its key only; its value is never read.
"""
import pandas as pd

from .extract import frame, table_exists

SIM_MARKER = 'clothcraft.sim.marker'


def column_exists(cur, table, column):
    cur.execute("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = %s AND column_name = %s)",
                (table, column))
    return bool(cur.fetchone()[0])


def _optional(cur, table, cols, sql):
    return frame(cur, sql) if table_exists(cur, table) else pd.DataFrame(columns=cols)


def database_info(cur):
    """The database name, the clothcraft module version, whether the simulation marker key exists, and whether clothcraft_state exists."""
    cur.execute("SELECT current_database()")
    db = cur.fetchone()[0]
    cur.execute("SELECT latest_version FROM ir_module_module WHERE name = 'clothcraft'")
    row = cur.fetchone()
    cur.execute("SELECT EXISTS (SELECT 1 FROM ir_config_parameter WHERE key = %s)", (SIM_MARKER,))
    simulated = bool(cur.fetchone()[0])
    return {'db': db, 'module_version': row[0] if row else None, 'simulated': simulated,
            'has_clothcraft_state': column_exists(cur, 'sale_order', 'clothcraft_state')}


def order_states(cur):
    """sale.order.clothcraft_state per order, only where the column exists (the shop). Used for the Closed money rule only, never for demand."""
    if not column_exists(cur, 'sale_order', 'clothcraft_state'):
        return pd.DataFrame(columns=['order_id', 'clothcraft_state'])
    return frame(cur, "SELECT id AS order_id, clothcraft_state FROM sale_order ORDER BY id")


def order_audit(cur):
    """Order history lines (to_state and when), for the moment an order was closed or delivered."""
    return _optional(cur, 'clothcraft_order_audit', ['order_id', 'to_state', 'create_date'], """
        SELECT order_id, to_state, create_date FROM clothcraft_order_audit ORDER BY id""")


def variant_attributes(cur):
    """One row per variant: its Size and Color attribute value ids and names (product.attribute.value), for matching supply lines."""
    raw = frame(cur, """
        SELECT pvc.product_product_id AS product_id, pa.name->>'en_US' AS attribute, ptav.product_attribute_value_id AS value_id,
               pav.name->>'en_US' AS value
        FROM product_variant_combination pvc
        JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
        JOIN product_attribute pa ON pa.id = ptav.attribute_id
        JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
        ORDER BY 1, 2""")
    out = pd.DataFrame({'product_id': pd.Series(sorted(raw['product_id'].unique()) if len(raw) else [], dtype='int64')})
    for attr, key in (('Size', 'size'), ('Color', 'color')):
        part = raw[raw['attribute'] == attr][['product_id', 'value_id', 'value']].rename(columns={'value_id': f'{key}_value_id', 'value': key})
        out = out.merge(part, on='product_id', how='left')
    return out


def po_lines(cur):
    """Purchase order lines with their VAT-included unit cost (price_total / product_qty), supplier and approval time. Empty without purchase."""
    return _optional(cur, 'purchase_order_line', ['po_line_id', 'po_id', 'supplier_id', 'product_id', 'qty', 'unit_cost', 'date_approve'], """
        SELECT pol.id AS po_line_id, pol.order_id AS po_id, po.partner_id AS supplier_id, pol.product_id, pol.product_qty::float AS qty,
               (pol.price_total / NULLIF(pol.product_qty, 0))::float AS unit_cost, po.date_approve
        FROM purchase_order_line pol JOIN purchase_order po ON po.id = pol.order_id ORDER BY pol.id""")


def suppliers(cur):
    """ClothCraft suppliers (the shop). No personal columns are read."""
    return _optional(cur, 'clothcraft_supplier',
                     ['supplier_id', 'partner_id', 'name', 'active', 'permanently_off', 'ships', 'shipping_fee', 'opening_balance'], """
        SELECT id AS supplier_id, partner_id, name, active, permanently_off, ships, shipping_fee::float AS shipping_fee,
               opening_balance::float AS opening_balance
        FROM clothcraft_supplier ORDER BY id""")


def supplier_lines(cur):
    return _optional(cur, 'clothcraft_supplier_line', ['supplier_id', 'garment_type_id', 'size_value_id', 'color_value_id', 'unit_cost'], """
        SELECT supplier_id, garment_type_id, size_value_id, color_value_id, unit_cost::float AS unit_cost
        FROM clothcraft_supplier_line ORDER BY id""")


def supplier_unavailability(cur):
    return _optional(cur, 'clothcraft_supplier_unavailability', ['supplier_id', 'date_from', 'date_to'], """
        SELECT supplier_id, date_from, date_to FROM clothcraft_supplier_unavailability ORDER BY id""")


def restocks(cur):
    """Every restock ticket with its expected range, receipt and actual cost (VAT included)."""
    return _optional(cur, 'clothcraft_restock',
                     ['restock_id', 'name', 'supplier_id', 'state', 'expected_from', 'expected_to', 'decided_at', 'received_on', 'received_at',
                      'actual_cost'], """
        SELECT id AS restock_id, name, supplier_id, state, expected_from, expected_to, decided_at, received_on, received_at,
               actual_cost::float AS actual_cost
        FROM clothcraft_restock ORDER BY id""")


def restock_lines(cur):
    return _optional(cur, 'clothcraft_restock_line', ['restock_id', 'product_id', 'quantity', 'quantity_received', 'unit_cost'], """
        SELECT restock_id, product_id, quantity::float AS quantity, quantity_received::float AS quantity_received, unit_cost::float AS unit_cost
        FROM clothcraft_restock_line ORDER BY id""")


def stock_alerts(cur):
    """Which variants the shop's own low-stock levels mark as low now."""
    return _optional(cur, 'clothcraft_stock_alert', ['product_id', 'low', 'since'], """
        SELECT product_id, low, since FROM clothcraft_stock_alert ORDER BY product_id""")


def extract_more_all(cur):
    return {
        'order_states': order_states(cur), 'order_audit': order_audit(cur), 'variant_attributes': variant_attributes(cur),
        'po_lines': po_lines(cur), 'suppliers': suppliers(cur), 'supplier_lines': supplier_lines(cur),
        'supplier_unavailability': supplier_unavailability(cur), 'restocks': restocks(cur), 'restock_lines': restock_lines(cur),
        'stock_alerts': stock_alerts(cur),
    }
