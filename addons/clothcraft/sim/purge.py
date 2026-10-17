"""Remove everything the simulation created, with SQL (done stock moves and the append-only price history cannot
be deleted through the ORM). Foreign keys stay enforced, so a missed dependent raises instead of leaving orphans.

Records are found through the labels (see labels.py): tagged orders, labelled partners, tagged products, purchase
orders with origin 'SIM'. Labels, garment types and the category are removed only if the seed itself created
them (the marker remembers what existed before). Running it again, or on a database never seeded, does nothing.
"""
import json

from .data import CATEGORY_NAME, GARMENT_TYPES, MARKER_PARAM, SIM_LABEL
from .labels import LABEL_MODELS


def purge(env):
    """Returns {table: rows deleted}; empty when there is nothing to remove."""
    cr = env.cr
    parameter = env['ir.config_parameter'].sudo()
    marker = parameter.get_param(MARKER_PARAM)
    info = json.loads(marker) if marker else {}
    labels = {name: env[model].search([('name', '=', SIM_LABEL)]) for name, model in LABEL_MODELS.items()}
    counts = {}

    def delete(table, where, params=()):
        cr.execute(f'DELETE FROM "{table}" WHERE {where}', params)
        if cr.rowcount:
            counts[table] = counts.get(table, 0) + cr.rowcount

    cr.execute("DROP TABLE IF EXISTS sim_so, sim_sol, sim_po, sim_pol, sim_tx, sim_tmpl, sim_prod, sim_partner, sim_user, sim_picking, sim_move, sim_ref")
    cr.execute("CREATE TEMP TABLE sim_so AS SELECT order_id AS id FROM sale_order_tag_rel WHERE tag_id = ANY(%s)", (labels['order'].ids,))
    cr.execute("CREATE TEMP TABLE sim_partner AS SELECT partner_id AS id FROM res_partner_res_partner_category_rel WHERE category_id = ANY(%s)", (labels['partner'].ids,))
    cr.execute("CREATE TEMP TABLE sim_po AS SELECT id FROM purchase_order WHERE origin = 'SIM' AND partner_id IN (SELECT id FROM sim_partner)")
    cr.execute("CREATE TEMP TABLE sim_tmpl AS SELECT product_template_id AS id FROM product_tag_product_template_rel WHERE product_tag_id = ANY(%s)", (labels['product'].ids,))
    cr.execute("CREATE TEMP TABLE sim_prod AS SELECT id FROM product_product WHERE product_tmpl_id IN (SELECT id FROM sim_tmpl)")
    cr.execute("CREATE TEMP TABLE sim_sol AS SELECT id FROM sale_order_line WHERE order_id IN (SELECT id FROM sim_so)")
    cr.execute("CREATE TEMP TABLE sim_pol AS SELECT id FROM purchase_order_line WHERE order_id IN (SELECT id FROM sim_po)")
    cr.execute("CREATE TEMP TABLE sim_tx AS SELECT transaction_id AS id FROM sale_order_transaction_rel WHERE sale_order_id IN (SELECT id FROM sim_so)")
    cr.execute("CREATE TEMP TABLE sim_user AS SELECT id FROM res_users WHERE partner_id IN (SELECT id FROM sim_partner)")
    cr.execute("""CREATE TEMP TABLE sim_picking AS
                  SELECT id FROM stock_picking WHERE sale_id IN (SELECT id FROM sim_so)
                  UNION SELECT stock_picking_id FROM purchase_order_stock_picking_rel WHERE purchase_order_id IN (SELECT id FROM sim_po)""")
    cr.execute("""CREATE TEMP TABLE sim_move AS
                  SELECT id FROM stock_move WHERE product_id IN (SELECT id FROM sim_prod) OR picking_id IN (SELECT id FROM sim_picking)""")
    cr.execute("CREATE TEMP TABLE sim_ref AS SELECT DISTINCT reference_id AS id FROM stock_reference_move_rel WHERE move_id IN (SELECT id FROM sim_move)")

    # ---- chatter first: messages and followers of everything below
    for model, table in (('sale.order', 'sim_so'), ('purchase.order', 'sim_po'), ('stock.picking', 'sim_picking'),
                         ('payment.transaction', 'sim_tx'), ('product.template', 'sim_tmpl'), ('product.product', 'sim_prod'),
                         ('res.partner', 'sim_partner'), ('res.users', 'sim_user')):
        delete('mail_tracking_value', f"mail_message_id IN (SELECT id FROM mail_message WHERE model = %s AND res_id IN (SELECT id FROM {table}))", (model,))
        delete('mail_message', f"model = %s AND res_id IN (SELECT id FROM {table})", (model,))
        delete('mail_followers', f"res_model = %s AND res_id IN (SELECT id FROM {table})", (model,))

    # ---- payments
    delete('sale_order_transaction_rel', "sale_order_id IN (SELECT id FROM sim_so)")
    delete('payment_transaction', "id IN (SELECT id FROM sim_tx)")

    # ---- stock documents and balances
    delete('stock_reference_move_rel', "move_id IN (SELECT id FROM sim_move)")
    delete('stock_reference_sale_rel', "sale_id IN (SELECT id FROM sim_so)")
    delete('stock_reference_purchase_rel', "purchase_id IN (SELECT id FROM sim_po)")
    delete('stock_reference', "id IN (SELECT id FROM sim_ref)")
    delete('stock_move_line', "move_id IN (SELECT id FROM sim_move) OR product_id IN (SELECT id FROM sim_prod)")
    delete('stock_move', "id IN (SELECT id FROM sim_move)")
    delete('purchase_order_stock_picking_rel', "purchase_order_id IN (SELECT id FROM sim_po)")
    delete('stock_picking', "id IN (SELECT id FROM sim_picking)")
    delete('stock_quant', "product_id IN (SELECT id FROM sim_prod)")
    delete('stock_lot', "product_id IN (SELECT id FROM sim_prod)")
    delete('product_value', "product_id IN (SELECT id FROM sim_prod)")

    # ---- orders
    delete('account_tax_sale_order_line_rel', "sale_order_line_id IN (SELECT id FROM sim_sol)")
    delete('sale_order_line', "id IN (SELECT id FROM sim_sol)")
    delete('sale_order_tag_rel', "order_id IN (SELECT id FROM sim_so)")
    delete('sale_order', "id IN (SELECT id FROM sim_so)")
    delete('account_tax_purchase_order_line_rel', "purchase_order_line_id IN (SELECT id FROM sim_pol)")
    delete('purchase_order_line', "id IN (SELECT id FROM sim_pol)")
    delete('purchase_order', "id IN (SELECT id FROM sim_po)")

    # ---- catalogue
    delete('clothcraft_price_history', "product_tmpl_id IN (SELECT id FROM sim_tmpl)")
    delete('product_supplierinfo', "product_tmpl_id IN (SELECT id FROM sim_tmpl)")
    delete('product_variant_combination', "product_product_id IN (SELECT id FROM sim_prod)")
    delete('product_template_attribute_value', "product_tmpl_id IN (SELECT id FROM sim_tmpl)")
    delete('product_attribute_value_product_template_attribute_line_rel', "product_template_attribute_line_id IN (SELECT id FROM product_template_attribute_line WHERE product_tmpl_id IN (SELECT id FROM sim_tmpl))")
    delete('product_template_attribute_line', "product_tmpl_id IN (SELECT id FROM sim_tmpl)")
    delete('product_attribute_product_template_rel', "product_template_id IN (SELECT id FROM sim_tmpl)")
    delete('product_taxes_rel', "prod_id IN (SELECT id FROM sim_tmpl)")
    delete('product_supplier_taxes_rel', "prod_id IN (SELECT id FROM sim_tmpl)")
    delete('product_tag_product_template_rel', "product_template_id IN (SELECT id FROM sim_tmpl)")
    delete('ir_attachment', "res_model IN ('product.template', 'product.product') AND res_id IN (SELECT id FROM sim_tmpl UNION SELECT id FROM sim_prod)")
    delete('product_product', "id IN (SELECT id FROM sim_prod)")
    delete('product_template', "id IN (SELECT id FROM sim_tmpl)")

    # ---- people
    delete('res_groups_users_rel', "uid IN (SELECT id FROM sim_user)")
    delete('res_company_users_rel', "user_id IN (SELECT id FROM sim_user)")
    delete('res_users', "id IN (SELECT id FROM sim_user)")
    delete('res_partner_res_partner_category_rel', "partner_id IN (SELECT id FROM sim_partner)")
    delete('res_partner', "id IN (SELECT id FROM sim_partner)")

    # ---- what the seed itself created (labels, category, garment types), only if it is no longer used
    before = info.get('preexisting')
    if before is not None:
        if not before['category']:
            delete('product_category', "name = %s", (CATEGORY_NAME,))
        created = [code for code in GARMENT_TYPES if code not in before['garment_types']]
        delete('clothcraft_garment_type', "code = ANY(%s)", (created,))
        for name, table in (('product', 'product_tag'), ('order', 'crm_tag'), ('partner', 'res_partner_category')):
            if name not in before['labels']:
                delete(table, "id = ANY(%s)", (labels[name].ids,))
    if marker:
        delete('ir_config_parameter', "key = %s", (MARKER_PARAM,))
    cr.execute("DROP TABLE IF EXISTS sim_so, sim_sol, sim_po, sim_pol, sim_tx, sim_tmpl, sim_prod, sim_partner, sim_user, sim_picking, sim_move, sim_ref")
    env.invalidate_all()
    env.registry.clear_cache('stable')   # ir.config_parameter lives in the stable cache (the marker)
    env.registry.clear_cache()
    return counts
