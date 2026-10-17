import hashlib
import json

from .data import SIM_LABEL


def _products(env):
    return env['product.product'].search([('product_tmpl_id.product_tag_ids.name', '=', SIM_LABEL)])


def _orders(env):
    return env['sale.order'].search([('tag_ids.name', '=', SIM_LABEL)])


def content_digest(env, lost=()):
    """SHA-256 over the business content of everything simulated so far, independent of database ids and of
    document numbers, so two runs of the same seed on any database give the same value."""
    rows = []
    for product in _products(env):
        rows.append(['product', product.default_code, round(product.lst_price, 2), round(product.standard_price, 4),
                     product.tracking, product.categ_id.property_cost_method])
    purchases = env['purchase.order'].search([('origin', '=', 'SIM')])
    for line in purchases.order_line:
        rows.append(['po_line', line.partner_id.name, str(line.order_id.date_approve), line.product_id.default_code,
                     line.product_qty, line.price_unit, line.qty_received])
    for move_line in env['stock.move.line'].search(
            [('picking_id', 'in', purchases.picking_ids.ids), ('state', '=', 'done')]):
        rows.append(['receipt', str(move_line.date), move_line.product_id.default_code, move_line.lot_id.name,
                     move_line.quantity])
    for order in _orders(env):
        rows.append(['order', str(order.date_order), order.partner_id.email, order.state, round(order.amount_total, 2),
                     sorted((l.product_id.default_code, l.product_uom_qty, l.price_unit) for l in order.order_line),
                     sorted((t.provider_id.custom_mode or '', t.state, str(t.last_state_change))
                            for t in order.transaction_ids),
                     sorted((p.state, str(p.date_done)) for p in order.picking_ids)])
    for day, code, wanted, free in lost:
        rows.append(['lost', str(day), code, wanted, free])
    payload = json.dumps(sorted(json.dumps(row, default=str) for row in rows))
    return hashlib.sha256(payload.encode()).hexdigest()


def summary(env):
    products = _products(env)
    purchases = env['purchase.order'].search([('origin', '=', 'SIM')])
    orders = _orders(env)
    return {
        'products': len(products.product_tmpl_id), 'variants': len(products),
        'suppliers': env['res.partner'].search_count([('category_id.name', '=', SIM_LABEL), ('is_company', '=', True)]),
        'customers': env['res.partner'].search_count([('category_id.name', '=', SIM_LABEL), ('is_company', '=', False)]),
        'purchase_orders_total': len(purchases),
        'receipts_done': len(purchases.picking_ids.filtered(lambda p: p.state == 'done')),
        'lots': env['stock.lot'].search_count([('name', '=like', 'SIM-%')]),
        'units_received': sum(purchases.order_line.mapped('qty_received')),
        'sale_orders': {state: len(orders.filtered(lambda o: o.state == state)) for state in ('sale', 'cancel', 'draft')},
    }
