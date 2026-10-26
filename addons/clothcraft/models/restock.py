"""Restock requests (Supplier and Restock, phase 2): one supplier, lines of (variant, quantity, unit cost), an expected arrival range, and the
Administrator's decision and receipt.

    requested --approve--> approved --receive--> received (final)
        |                     `--not received--> not_received --receive--> received
        `--reject (note)--> rejected (final)

The Inventory staff create a request and can change it while it is `requested`; only the Administrator moves it. All the logic lives in the
action_* methods below, so the staff API and the Odoo screens share one code path. Odoo rights work per model and per record, not per field,
so write() also refuses a direct change of `state` (and of everything the methods own); only the methods set the context flag to pass.

Receiving adds the stock through a native receipt (stock.picking from the supplier location into the warehouse, no purchase order): real
stock moves exist, the DSS recognises them as supplier receipts (stock_move_line._clothcraft_supplier_receipt_domain), and the stock
listing finds the supplier from the picking's partner. The whole receipt is one savepoint: the ticket row is locked (SELECT ... FOR UPDATE),
and if anything fails nothing is left behind. The ACTUAL COST recorded on the ticket (entered cost x received quantity + the applied flat
shipping, VAT-inclusive, then split once by money.vat_split) is the figure profit must use, never Odoo's product cost.

Entered prices include the 12% VAT. A restock is never deleted; every change is written to clothcraft.restock.history, which is append only.
"""
from odoo import Command, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tools.float_utils import float_round

from ..money import vat_split
from .supplier import today_manila

STATES = [('requested', 'Requested'), ('approved', 'Approved'), ('rejected', 'Rejected'), ('received', 'Received'), ('not_received', 'Not received')]
EVENTS = [('created', 'Requested'), ('edited', 'Edited'), ('approved', 'Approved'), ('rejected', 'Rejected'),
          ('received', 'Received'), ('not_received', 'Did not arrive')]
# the moves the Administrator makes
NEXT = {'requested': ('approved', 'rejected'), 'approved': ('received', 'not_received'), 'not_received': ('received',)}
LABELS = {'requested': 'requested', 'approved': 'approved', 'rejected': 'rejected', 'received': 'received', 'not_received': 'not received'}
NOTE_MIN, NOTE_LIMIT = 5, 500
LOT_LIMIT = 64


def a_restock(state):
    """'A requested restock' / 'An approved restock': the article that fits the state's name."""
    label = LABELS[state]
    return f"{'An' if label[0] in 'aeiou' else 'A'} {label} restock"
QTY_MAX, LINES_MAX, SPAN_MAX_DAYS, MONEY_MAX = 10000, 50, 90, 1_000_000
MOVING = 'clothcraft_restock_move'  # context flag: the action_* methods may change what the guard protects
# written only by the action_* methods and create()
SYSTEM_FIELDS = {
    'name', 'state', 'shipping_applied', 'requested_by', 'requested_by_id', 'requested_at', 'decided_by', 'decided_at', 'decision_note', 'received_at',
    'received_on', 'received_by', 'received_late', 'picking_id', 'goods_cost', 'shipping_cost', 'actual_cost', 'actual_vat', 'actual_net',
}
# the request itself: changeable only while it is `requested`
REQUEST_FIELDS = {'shipping_on', 'shipping_fee', 'expected_from', 'expected_to', 'request_note', 'line_ids'}


class ClothcraftRestock(models.Model):
    _name = 'clothcraft.restock'
    _description = 'Restock request'
    _order = 'id desc'

    name = fields.Char(string="Reference", readonly=True, copy=False, index=True)
    supplier_id = fields.Many2one('clothcraft.supplier', required=True, ondelete='restrict', index=True)
    state = fields.Selection(STATES, required=True, default='requested', index=True, copy=False)
    line_ids = fields.One2many('clothcraft.restock.line', 'restock_id', string="Lines", copy=True)
    shipping_on = fields.Boolean(string="Shipping charged", help="The employee's switch. The amount counts only if the supplier ships too.")
    shipping_fee = fields.Monetary(
        currency_field='currency_id', help="A flat amount for this restock, VAT included. Copied from the supplier, editable. Ignored unless "
                                           "shipping is on and the supplier ships.")
    shipping_applied = fields.Boolean(
        readonly=True, copy=False, help="Shipping on and the supplier ships: set when the request is made or edited, and again at approval, "
                                        "then frozen.")
    expected_from = fields.Date(required=True)
    expected_to = fields.Date(required=True)
    request_note = fields.Text()
    requested_by = fields.Char(readonly=True, copy=False)
    requested_by_id = fields.Many2one('res.users', string="Requested by (user)", readonly=True, copy=False, ondelete='set null')
    requested_at = fields.Datetime(readonly=True, copy=False, default=fields.Datetime.now)
    decided_by = fields.Char(readonly=True, copy=False)
    decided_at = fields.Datetime(readonly=True, copy=False)
    decision_note = fields.Text(readonly=True, copy=False)
    received_at = fields.Datetime(readonly=True, copy=False, help="When the receipt was entered.")
    received_on = fields.Date(readonly=True, copy=False, help="The day the goods arrived (Manila). Today unless the Administrator said otherwise; never in the future.")
    received_by = fields.Char(readonly=True, copy=False)
    received_late = fields.Boolean(
        compute='_compute_received_late', store=True, help="Received after the last day of the expected range.")
    overdue = fields.Boolean(compute='_compute_overdue', help="Approved or not received, and today (Manila) is past the expected range. Display only.")
    picking_id = fields.Many2one('stock.picking', string="Stock receipt", readonly=True, copy=False, ondelete='restrict')
    goods_cost = fields.Monetary(currency_field='currency_id', readonly=True, copy=False, help="Unit cost x received quantity, summed. VAT included.")
    shipping_cost = fields.Monetary(currency_field='currency_id', readonly=True, copy=False, help="The flat shipping that applied at receipt (0 if none). VAT included.")
    actual_cost = fields.Monetary(currency_field='currency_id', readonly=True, copy=False, help="Goods + shipping, VAT included: what this restock cost.")
    actual_vat = fields.Monetary(currency_field='currency_id', readonly=True, copy=False)
    actual_net = fields.Monetary(currency_field='currency_id', readonly=True, copy=False)
    estimate_total = fields.Monetary(currency_field='currency_id', compute='_compute_estimate', help="Requested quantities x unit costs (+ shipping if it applies), VAT included.")
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company, required=True)
    currency_id = fields.Many2one('res.currency', related='company_id.currency_id')
    history_ids = fields.One2many('clothcraft.restock.history', 'restock_id', string="History")

    _picking_uniq = models.Constraint('UNIQUE(picking_id)', 'A stock receipt belongs to one restock.')
    _shipping_positive = models.Constraint('CHECK(shipping_fee >= 0)', 'The shipping amount cannot be negative.')
    _dates_ordered = models.Constraint('CHECK(expected_from <= expected_to)', 'The expected range must end on or after the day it starts.')

    # ------------------------------------------------------------------ computed
    @api.depends('received_on', 'expected_to')
    def _compute_received_late(self):
        for restock in self:
            restock.received_late = bool(restock.received_on and restock.expected_to and restock.received_on > restock.expected_to)

    @api.depends('state', 'expected_to')
    def _compute_overdue(self):
        today = today_manila()
        for restock in self:
            restock.overdue = restock.state in ('approved', 'not_received') and bool(restock.expected_to) and today > restock.expected_to

    @api.depends('line_ids.quantity', 'line_ids.unit_cost', 'shipping_on', 'shipping_fee', 'shipping_applied')
    def _compute_estimate(self):
        for restock in self:
            goods = sum(float_round(line.quantity * line.unit_cost, precision_digits=2) for line in restock.line_ids)
            restock.estimate_total = float_round(goods + (restock.shipping_fee if restock.shipping_applied else 0.0), precision_digits=2)

    @api.constrains('line_ids')
    def _check_lines(self):
        for restock in self:
            if not 1 <= len(restock.line_ids) <= LINES_MAX:
                raise ValidationError(f"A restock needs between 1 and {LINES_MAX} lines.")

    @api.constrains('expected_from', 'expected_to')
    def _check_span(self):
        for restock in self:
            if restock.expected_from and restock.expected_to and (restock.expected_to - restock.expected_from).days > SPAN_MAX_DAYS:
                raise ValidationError(f"The expected range can span {SPAN_MAX_DAYS} days at most.")

    @api.constrains('shipping_fee')
    def _check_shipping_max(self):
        for restock in self:
            if restock.shipping_fee > MONEY_MAX:
                raise ValidationError("The shipping amount is too large.")

    # ------------------------------------------------------------------ who, history
    def _staff_name(self):
        return self.env.user.partner_id.name or self.env.user.login

    def _log(self, event, from_state, to_state, note=False):
        via = self.env.context.get('clothcraft_via', 'odoo')
        self.env['clothcraft.restock.history'].sudo().create([{
            'restock_id': restock.id, 'event': event, 'from_state': from_state, 'to_state': to_state, 'note': note or False,
            'staff_id': self.env.user.id, 'staff_name': self._staff_name(), 'via': via,
        } for restock in self])

    def _require_admin(self):
        """The Administrator's moves. sudo (the staff API, which checks the role itself) passes."""
        if not (self.env.su or self.env.user.has_group('clothcraft.group_admin')):
            raise AccessError("Only an Administrator can do this.")

    def _notify(self, kind):
        """The bell (clothcraft.notification): who hears about this is decided there. Never changes or stops the move."""
        self.env['clothcraft.notification']._restock_event(self, kind)

    def _sync_shipping(self):
        for restock in self:
            applied = bool(restock.shipping_on and restock.supplier_id.ships)
            if restock.shipping_applied != applied:
                restock.with_context(**{MOVING: True}).write({'shipping_applied': applied})

    # ------------------------------------------------------------------ create, write, unlink
    @api.model_create_multi
    def create(self, vals_list):
        today = today_manila()
        for vals in vals_list:
            supplier = self.env['clothcraft.supplier'].sudo().browse(vals.get('supplier_id')).exists()
            if not supplier:
                raise ValidationError("Choose a supplier.")
            if not supplier.available_now:
                raise ValidationError(f"{supplier.name} is not available now, so a restock cannot be requested from it.")
            if not vals.get('line_ids'):
                raise ValidationError("A restock needs at least one line.")
            if vals.get('expected_from') and fields.Date.to_date(vals['expected_from']) < today:
                raise ValidationError("The expected range cannot start in the past.")
            if 'shipping_fee' not in vals:
                vals['shipping_fee'] = supplier.shipping_fee
            vals['name'] = self.env['ir.sequence'].sudo().next_by_code('clothcraft.restock')
            vals['requested_by'] = self._staff_name()
            vals['requested_by_id'] = self.env.user.id
            vals['requested_at'] = fields.Datetime.now()
            vals['state'] = 'requested'
            for key in SYSTEM_FIELDS - {'name', 'state', 'requested_by', 'requested_by_id', 'requested_at'}:
                vals.pop(key, None)
            vals.setdefault('company_id', supplier.company_id.id)
        restocks = super().create(vals_list)
        restocks._sync_shipping()
        restocks._log('created', False, 'requested', self.env.context.get('clothcraft_note'))
        restocks._notify('restock_requested')
        return restocks

    def write(self, vals):
        if not self.env.context.get(MOVING):
            blocked = SYSTEM_FIELDS & vals.keys()
            if blocked:
                raise UserError("Only the approve, reject, receive and not-received actions change " + ', '.join(sorted(blocked)) + ".")
            if 'supplier_id' in vals and any(restock.supplier_id.id != vals['supplier_id'] for restock in self):
                raise UserError("A restock keeps its supplier. Make a new request for another one.")
            if REQUEST_FIELDS & vals.keys():
                if any(restock.state != 'requested' for restock in self):
                    raise UserError("Only a request that is still 'requested' can be changed.")
                if vals.get('expected_from') and fields.Date.to_date(vals['expected_from']) < today_manila() \
                        and any(restock.expected_from != fields.Date.to_date(vals['expected_from']) for restock in self):
                    raise ValidationError("The expected range cannot start in the past.")
        result = super().write(vals)
        if not self.env.context.get(MOVING) and REQUEST_FIELDS & vals.keys():
            self._sync_shipping()
            self._log('edited', 'requested', 'requested', self.env.context.get('clothcraft_note'))
        return result

    @api.ondelete(at_uninstall=False)
    def _unlink_never(self):
        raise UserError("A restock is never deleted, so its history is kept.")

    # ------------------------------------------------------------------ the moves (Administrator)
    def _check_move(self, to):
        self.ensure_one()
        if to not in NEXT.get(self.state, ()):
            raise UserError(f"{a_restock(self.state)} cannot be {LABELS[to]}.")

    def _clean_note(self, note, required):
        note = (note or '').strip()
        if required and len(note) < NOTE_MIN:
            raise UserError(f"Write a short note (at least {NOTE_MIN} characters).")
        if len(note) > NOTE_LIMIT:
            raise UserError(f"Keep the note to {NOTE_LIMIT} characters or fewer.")
        return note or False

    def _lock(self):
        """Lock this ticket's row and read it fresh: two Administrators at once cannot both pass the state check."""
        self.ensure_one()
        self.env.cr.execute("SELECT id FROM clothcraft_restock WHERE id = %s FOR UPDATE", [self.id])
        self.invalidate_recordset()
        self.line_ids.invalidate_recordset()

    def _decide(self, to, event, note):
        self.ensure_one()
        before = self.state
        self.with_context(**{MOVING: True}).write({
            'state': to, 'decided_by': self._staff_name(), 'decided_at': fields.Datetime.now(), 'decision_note': note})
        self._log(event, before, to, note)
        self._notify('restock_' + to)

    def action_approve(self, note=None):
        self._require_admin()
        self._lock()
        self._check_move('approved')
        note = self._clean_note(note, required=False)
        self.with_context(**{MOVING: True}).write({'shipping_applied': bool(self.shipping_on and self.supplier_id.ships)})
        self._decide('approved', 'approved', note)
        return True

    def action_reject(self, note=None):
        self._require_admin()
        self._lock()
        self._check_move('rejected')
        self._decide('rejected', 'rejected', self._clean_note(note, required=True))
        return True

    def action_not_received(self, note=None):
        self._require_admin()
        self._lock()
        self._check_move('not_received')
        note = self._clean_note(note, required=False)
        before = self.state
        self.with_context(**{MOVING: True}).write({'state': 'not_received'})
        self._log('not_received', before, 'not_received', note)
        self._notify('restock_not_received')
        return True

    def action_receive(self, quantities=None, received_on=None, note=None, lots=None):
        """Receive the goods: quantities is {line id: received quantity} (a line left out arrives in full); received_on is the day they
        arrived (Manila; default today, never in the future). One receipt per ticket, all or nothing."""
        self._require_admin()
        self._lock()
        if self.picking_id or self.received_at or self.state == 'received':
            raise UserError("This restock was already received. Nothing was done.")
        self._check_move('received')
        note = self._clean_note(note, required=False)
        today = today_manila()
        day = fields.Date.to_date(received_on) if received_on else today
        if day > today:
            raise UserError("The day the goods arrived cannot be in the future.")
        quantities = {int(key): value for key, value in (quantities or {}).items()}
        unknown = set(quantities) - set(self.line_ids.ids)
        if unknown:
            raise UserError("That quantity belongs to a line this restock does not have.")
        got = {}
        for line in self.line_ids:
            qty = quantities.get(line.id, line.quantity)
            if isinstance(qty, bool) or not isinstance(qty, (int, float)) or qty != int(qty) or not 0 <= qty <= line.quantity:
                raise UserError(f"{line.product_id.display_name}: the received quantity must be a whole number from 0 to {line.quantity}.")
            got[line] = int(qty)
        if not any(got.values()):
            raise UserError("Nothing was received. If nothing arrived, mark the restock as not received instead.")
        lots = {int(key): (name or '').strip() for key, name in (lots or {}).items()}
        for line_id, name in lots.items():
            line = self.line_ids.filtered(lambda l: l.id == line_id)
            if not line:
                raise UserError("A lot name belongs to a line this restock does not have.")
            if got[line] == 0:
                raise UserError(f"{line.product_id.display_name}: nothing arrived on this line, so it has no lot.")
            if not 1 <= len(name) <= LOT_LIMIT or not name.isprintable():
                raise UserError(f"{line.product_id.display_name}: the lot name must be 1 to {LOT_LIMIT} printable characters.")
        picking = self._receive_stock(got, lots)
        goods = float_round(sum(float_round(line.unit_cost * qty, precision_digits=2) for line, qty in got.items()), precision_digits=2)
        shipping = self.shipping_fee if self.shipping_applied else 0.0
        total = float_round(goods + shipping, precision_digits=2)
        vat, net = vat_split(total)
        before = self.state
        for line, qty in got.items():
            line.with_context(**{MOVING: True}).write({'quantity_received': qty, 'received_cost': float_round(line.unit_cost * qty, precision_digits=2)})
        self.with_context(**{MOVING: True}).write({
            'state': 'received', 'received_at': fields.Datetime.now(), 'received_on': day, 'received_by': self._staff_name(),
            'picking_id': picking.id, 'goods_cost': goods, 'shipping_cost': shipping, 'actual_cost': total, 'actual_vat': vat, 'actual_net': net})
        self._log('received', before, 'received', note)
        self._notify('restock_received')
        return True

    def _lot_names(self, got, lots):
        """{line: lot name} for the lines that arrived: the name typed for the line, else ticket reference + SKU. A name that already exists
        for that product is refused (stock is never silently added to an older lot)."""
        names = {}
        for line, qty in got.items():
            if qty <= 0:
                continue
            product = line.product_id
            name = lots.get(line.id) or f"{self.name}-{product.default_code or product.id}"
            if self.env['stock.lot'].search_count([('name', '=', name), ('product_id', '=', product.id), ('company_id', 'in', [self.company_id.id, False])], limit=1):
                raise UserError(f"A lot named {name} already exists for {product.display_name}. Type a different lot name for that line.")
            names[line] = name
        return names

    def _receive_stock(self, got, lots=None):
        """The native receipt: supplier location -> the warehouse's stock, one move per line that arrived, one lot per line (the garments are
        lot-tracked), validated. Raises (so the caller's savepoint undoes everything) if Odoo would not finish it by itself, for instance by
        asking about a backorder, or if it changed a product's cost (receipts must not: the ticket's actual cost is the figure that counts)."""
        self.ensure_one()
        warehouse = self.env['stock.warehouse'].search([('company_id', '=', self.company_id.id)], limit=1)
        picking_type = warehouse.in_type_id
        if not picking_type:
            raise UserError("The warehouse has no receipt operation type, so stock cannot be received.")
        names = self._lot_names(got, lots or {})
        products = self.env['product.product'].browse([line.product_id.id for line in names]).with_company(self.company_id)
        cost_before = {product.id: product.standard_price for product in products}
        source = picking_type.default_location_src_id or self.env.ref('stock.stock_location_suppliers')
        target = picking_type.default_location_dest_id
        moves = [Command.create({
            'product_id': line.product_id.id, 'product_uom_qty': qty, 'product_uom': line.product_id.uom_id.id,
            'location_id': source.id, 'location_dest_id': target.id, 'company_id': self.company_id.id,
            'price_unit': vat_split(line.unit_cost)[1],  # the cost without VAT: the part of the entered price that is the goods
        }) for line, qty in got.items() if qty > 0]
        picking = self.env['stock.picking'].create({
            'picking_type_id': picking_type.id, 'partner_id': self.supplier_id.partner_id.id, 'origin': self.name,
            'location_id': source.id, 'location_dest_id': target.id, 'move_ids': moves})
        picking.action_confirm()
        by_product = {line.product_id.id: line for line in names}
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            line = by_product[move.product_id.id]
            lot = self.env['stock.lot'].create({'name': names[line], 'product_id': line.product_id.id, 'company_id': self.company_id.id})
            move.move_line_ids.write({'lot_id': lot.id})
            line.with_context(**{MOVING: True}).write({'lot_id': lot.id})
        outcome = picking.with_context(skip_backorder=True, skip_sms=True, skip_immediate=True).button_validate()
        if outcome is not True or picking.state != 'done':
            raise UserError("Odoo could not finish the stock receipt by itself, so nothing was received.")
        products.invalidate_recordset(['standard_price'])
        changed = [product.display_name for product in products if product.standard_price != cost_before[product.id]]
        if changed:
            raise UserError("This receipt would have changed the cost Odoo holds for " + ', '.join(changed) + ", which receipts must not do. "
                            "Nothing was received. Ask an Administrator to set the product category's costing method to Standard Price.")
        return picking


class ClothcraftRestockLine(models.Model):
    """One variant on a restock, with its unit cost as it was on the supplier's supply line when the request was made (editable)."""
    _name = 'clothcraft.restock.line'
    _description = 'Restock line'
    _order = 'restock_id, id'

    restock_id = fields.Many2one('clothcraft.restock', required=True, ondelete='cascade', index=True)
    product_id = fields.Many2one('product.product', string="Variant", required=True, ondelete='restrict')
    supply_line_id = fields.Many2one('clothcraft.supplier.line', string="Supply line", ondelete='set null', readonly=True)
    garment_type_id = fields.Many2one('clothcraft.garment.type', readonly=True, ondelete='restrict')
    size_value_id = fields.Many2one('product.attribute.value', string="Size", readonly=True, ondelete='restrict')
    color_value_id = fields.Many2one('product.attribute.value', string="Colour", readonly=True, ondelete='restrict')
    quantity = fields.Integer(required=True, default=1)
    currency_id = fields.Many2one('res.currency', related='restock_id.currency_id')
    unit_cost = fields.Monetary(string="Unit cost (VAT included)", currency_field='currency_id')
    quantity_received = fields.Integer(readonly=True, copy=False)
    lot_id = fields.Many2one('stock.lot', string="Lot", readonly=True, copy=False, ondelete='set null', help="The lot the received units went into: the name typed for the line, else the ticket reference and the SKU.")
    received_cost = fields.Monetary(currency_field='currency_id', readonly=True, copy=False, help="Unit cost x received quantity, VAT included.")

    _variant_once = models.Constraint('UNIQUE(restock_id, product_id)', 'A variant can be on a restock only once.')
    _quantity_range = models.Constraint(f'CHECK(quantity >= 1 AND quantity <= {QTY_MAX})', f'The quantity is a whole number from 1 to {QTY_MAX}.')
    _cost_range = models.Constraint(f'CHECK(unit_cost >= 0 AND unit_cost <= {MONEY_MAX})', f'The unit cost is from 0 to {MONEY_MAX}.')
    _received_range = models.Constraint('CHECK(quantity_received >= 0 AND quantity_received <= quantity)', 'The received quantity is from 0 up to the requested one.')

    @api.model
    def _supply_line_for(self, supplier, product):
        """The supplier's supply line that sells this variant (same garment type, size and colour), or none."""
        values = product.product_template_attribute_value_ids.product_attribute_value_id
        garment = product.product_tmpl_id.garment_type_id
        return supplier.sudo().line_ids.filtered(
            lambda l: l.garment_type_id == garment and l.size_value_id in values and l.color_value_id in values)[:1]

    def _guard_open(self, restocks):
        if not self.env.context.get(MOVING) and any(restock.state != 'requested' for restock in restocks):
            raise UserError("Only a request that is still 'requested' can be changed.")

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            restock = self.env['clothcraft.restock'].sudo().browse(vals['restock_id'])
            self._guard_open(restock)
            product = self.env['product.product'].sudo().browse(vals['product_id'])
            supply = self._supply_line_for(restock.supplier_id, product)
            if not supply:
                raise ValidationError(f"{restock.supplier_id.name} has no supply line for {product.display_name}, so it cannot be requested from them.")
            vals.update(supply_line_id=supply.id, garment_type_id=supply.garment_type_id.id, size_value_id=supply.size_value_id.id,
                        color_value_id=supply.color_value_id.id)
            vals.setdefault('unit_cost', supply.unit_cost)
            for key in ('quantity_received', 'received_cost'):
                vals.pop(key, None)
        return super().create(vals_list)

    def write(self, vals):
        if not self.env.context.get(MOVING):
            if {'quantity_received', 'received_cost', 'lot_id', 'supply_line_id', 'garment_type_id', 'size_value_id', 'color_value_id', 'restock_id'} & vals.keys():
                raise UserError("Those fields are set by the restock itself.")
            self._guard_open(self.restock_id)
            if 'product_id' in vals:
                for line in self:
                    product = self.env['product.product'].sudo().browse(vals['product_id'])
                    supply = self._supply_line_for(line.restock_id.supplier_id, product)
                    if not supply:
                        raise ValidationError(f"{line.restock_id.supplier_id.name} has no supply line for {product.display_name}.")
        return super().write(vals)

    def unlink(self):
        self._guard_open(self.restock_id)
        return super().unlink()


class ClothcraftRestockHistory(models.Model):
    """Who moved a restock, from which state to which, and when. Append only, on three layers like the order status history: the ORM
    refuses write and unlink, a database trigger refuses UPDATE and DELETE, and no group has an access line for more than reading."""
    _name = 'clothcraft.restock.history'
    _description = 'Restock history'
    _order = 'id'

    restock_id = fields.Many2one('clothcraft.restock', required=True, ondelete='restrict', index=True)
    event = fields.Selection(EVENTS, required=True)
    from_state = fields.Selection(STATES)
    to_state = fields.Selection(STATES, required=True)
    staff_id = fields.Many2one('res.users', ondelete='set null')
    staff_name = fields.Char(required=True, help="The staff member's name at the time: it stays when the account is renamed or removed.")
    note = fields.Text()
    via = fields.Selection([('dashboard', 'Staff dashboard'), ('odoo', 'Odoo')], required=True, default='odoo')

    def write(self, vals):
        raise UserError("The restock history cannot be changed.")

    def unlink(self):
        raise UserError("The restock history cannot be deleted.")

    def init(self):
        super().init()
        cr = self.env.cr
        cr.execute("""
            CREATE OR REPLACE FUNCTION clothcraft_restock_history_guard() RETURNS trigger AS $$
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    RAISE EXCEPTION 'The restock history cannot be changed';
                END IF;
                RAISE EXCEPTION 'The restock history cannot be deleted';
            END;
            $$ LANGUAGE plpgsql""")
        cr.execute("DROP TRIGGER IF EXISTS clothcraft_restock_history_guard ON clothcraft_restock_history")
        cr.execute("""CREATE TRIGGER clothcraft_restock_history_guard BEFORE UPDATE OR DELETE ON clothcraft_restock_history
                      FOR EACH ROW EXECUTE FUNCTION clothcraft_restock_history_guard()""")
