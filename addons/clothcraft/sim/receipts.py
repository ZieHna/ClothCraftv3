from odoo import Command

from .util import at, quiet


def _lot_name(env, variant, received_at):
    base = f"SIM-{received_at:%y%m%d}-{variant.default_code.removeprefix('SIM-')}"
    name, n = base, 1
    while env['stock.lot'].search_count([('name', '=', name), ('product_id', '=', variant.id)]):
        n += 1
        name = f"{base}-{n}"
    return name


def place(env, supplier, lines, ordered_at, received_at):
    """Create and confirm a purchase order at `ordered_at`. lines: [(variant, qty, unit_cost)].

    Stock does not exist until `validate` runs at the receipt date, so nothing can be sold early."""
    env = quiet(env)
    with at(ordered_at):
        order = env['purchase.order'].create({
            'partner_id': supplier.id, 'origin': 'SIM', 'date_planned': received_at,
            'order_line': [Command.create({
                'product_id': variant.id, 'product_qty': qty, 'price_unit': cost, 'date_planned': received_at})
                for variant, qty, cost in lines]})
        order.button_confirm()
    return order


def validate(env, order, received_at):
    """Receive the whole order at `received_at`, one lot per variant, through the normal receipt flow so that
    average costing and the price-history cost hook run exactly as in real life."""
    env = quiet(env)
    with at(received_at):
        picking = order.picking_ids
        for move in picking.move_ids:
            line = move.move_line_ids[:1] or env['stock.move.line'].create({
                'move_id': move.id, 'picking_id': picking.id, 'product_id': move.product_id.id,
                'location_id': move.location_id.id, 'location_dest_id': move.location_dest_id.id})
            line.write({'lot_name': _lot_name(env, move.product_id, received_at), 'quantity': move.product_uom_qty})
            move.picked = True
        picking.with_context(skip_backorder=True, skip_sms=True).button_validate()
    return picking


def receive(env, supplier, lines, ordered_at, received_at):
    """Place and receive in one go (used for the opening stock, which predates the first simulated day)."""
    order = place(env, supplier, lines, ordered_at, received_at)
    return order, validate(env, order, received_at)
