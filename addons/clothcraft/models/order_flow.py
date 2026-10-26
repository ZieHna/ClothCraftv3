"""The order's fulfilment status (step 11):

    awaiting_payment -> confirmed -> shipped -> out_for_delivery -> delivered -> closed, or cancelled (before shipped only).

The customer sees four steps: 1 received and preparing (confirmed), 2 shipped out, 3 on delivery, 4 delivered; awaiting_payment is a
note before step 1, and closed is step 4 confirmed. "packed" (step 7) is no longer reached: it folds into step 1 (the migration to
19.0.1.3.0 moved every packed order to confirmed); it stays a known value so an old history line still reads.

One stored field, clothcraft_state, on sale.order. It FOLLOWS what Odoo already knows (the order, its payments, its deliveries) and
keeps the states Odoo has no word for once they are set, so an order moved in the Odoo screens does not drift away from what the shop
says:

    sale.order.state = cancel                         -> cancelled
    a staff-set state already set (see STICKY)        -> kept (set by the staff dashboard, the customer, the daily job, or derived)
    a delivery of the order is done                   -> shipped   (the goods left the building; step 11: it used to read "delivered")
    bank transfer and no payment is done yet          -> awaiting_payment
    anything else                                     -> confirmed (a bank payment received, or cash on delivery accepted)

Who moves it: staff forward one step at a time (`_clothcraft_move`, which does the native work at each step: payment, pickings, stock,
the order lock); an Administrator back one step with a note, where nothing native has to be undone (BACK); the customer from delivered
to closed (models/order_tracking.py), or the daily job N days after delivery. Each move writes its audit line in the same transaction.
Stock leaves at shipped; out_for_delivery and closed have no stock effect; cash on delivery becomes paid at delivered, which also
locks the order; closing changes neither.
Out of scope, and said so: returns, failed deliveries, partial shipments.
"""
from odoo import api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare

from .order_audit import STATES

LABELS = {
    'awaiting_payment': 'awaiting payment', 'confirmed': 'confirmed', 'packed': 'packed', 'shipped': 'shipped',
    'out_for_delivery': 'out for delivery', 'delivered': 'delivered', 'closed': 'closed', 'cancelled': 'cancelled',
}
# forward moves staff make (cancel included); closed is reached only by the customer or the daily job
NEXT = {
    'awaiting_payment': ('confirmed', 'cancelled'),
    'confirmed': ('shipped', 'cancelled'),
    'packed': ('shipped', 'cancelled'),           # an order packed before step 11, if one was ever left (the migration moves them)
    'shipped': ('out_for_delivery',),
    'out_for_delivery': ('delivered',),
    'delivered': (),
    'closed': (),
    'cancelled': (),
}
# an Administrator's step back, with a note: only where nothing native has to be undone (no payment, no stock)
BACK = {'out_for_delivery': 'shipped', 'delivered': 'out_for_delivery', 'closed': 'delivered'}
ACTIONS = {'confirmed': 'Mark payment received', 'shipped': 'Mark as shipped', 'out_for_delivery': 'Mark as out for delivery',
           'delivered': 'Mark as delivered', 'cancelled': 'Cancel order'}
BACK_ACTIONS = {'shipped': 'Step back to shipped', 'out_for_delivery': 'Step back to out for delivery', 'delivered': 'Step back to delivered'}
STICKY = ('packed', 'shipped', 'out_for_delivery', 'delivered', 'closed')
NOTE_LIMIT = 500
NOTE_MIN = 3


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    clothcraft_state = fields.Selection(
        STATES, string="Fulfilment status", compute='_compute_clothcraft_state', store=True, readonly=False, index=True, copy=False,
        help="Follows the order, its payments and its deliveries; the states staff, the customer or the daily job set are kept. See models/order_flow.py.")

    @api.depends('state', 'picking_ids.state', 'transaction_ids.state')
    def _compute_clothcraft_state(self):
        for order in self:
            current = order.clothcraft_state
            order_sudo = order.sudo()
            if order.state == 'cancel':
                new = 'cancelled'
            elif order.state not in ('sale', 'done'):
                new = False                       # a quotation has no fulfilment yet
            elif current in STICKY:
                new = current
            elif any(p.state == 'done' for p in order_sudo.picking_ids):
                new = 'shipped'                   # the goods have left; delivery is still to come
            elif order_sudo._clothcraft_is_bank() and not any(t.state == 'done' for t in order_sudo.transaction_ids):
                new = 'awaiting_payment'
            else:
                new = 'confirmed'
            order.clothcraft_state = new

    # ------------------------------------------------------------------ what kind of order
    def _clothcraft_is_cod(self):
        return self.transaction_ids[:1].provider_id.custom_mode == 'cash_on_delivery'

    def _clothcraft_is_bank(self):
        """A bank-transfer order: it has a payment that is not cash on delivery."""
        return bool(self.transaction_ids) and not self._clothcraft_is_cod()

    def _clothcraft_bank_paid(self):
        return self._clothcraft_is_bank() and any(t.state == 'done' for t in self.transaction_ids)

    # ------------------------------------------------------------------ the rules
    def _clothcraft_is_back(self, to):
        return BACK.get(self.clothcraft_state) == to

    def _clothcraft_note_required(self, to):
        """A step back always says why. Cancelling an order whose bank payment was received leaves a refund to arrange outside the
        system: say why and who."""
        return self._clothcraft_is_back(to) or (to == 'cancelled' and self._clothcraft_bank_paid())

    def _clothcraft_check(self, to, role):
        """None when this staff move is allowed for this role, else (code, sentence). code: invalid_transition or forbidden."""
        self.ensure_one()
        current = self.clothcraft_state
        if self._clothcraft_is_back(to):
            if role != 'admin':
                return ('forbidden', "Only an Administrator can step an order back.")
            if current == 'delivered' and self._clothcraft_is_cod():
                return ('invalid_transition', "This cash-on-delivery order is delivered and its cash is recorded as collected. It can't be stepped back.")
            return None
        if current == 'cancelled':
            return ('invalid_transition', "This order is cancelled. A cancelled order can't be changed.")
        if to == 'closed':
            return ('invalid_transition', "Only the customer closes an order, by confirming they received it; otherwise it closes by itself after delivery.")
        if current in ('delivered', 'closed'):
            return ('invalid_transition', f"This order is {LABELS[current]}. A {LABELS[current]} order can't be moved on or cancelled.")
        if to not in NEXT.get(current, ()):
            if to == 'cancelled':
                return ('invalid_transition', f"An order that is {LABELS[current]} can't be cancelled.")
            options = ' or '.join(LABELS[t] for t in NEXT[current])
            return ('invalid_transition', f"An order that is {LABELS[current]} can't be moved to {LABELS[to]}. From {LABELS[current]} it can go to {options}.")
        if to == 'cancelled' and self._clothcraft_bank_paid() and role != 'admin':
            return ('forbidden', "Only an Administrator can cancel an order that has been paid.")
        return None

    def _clothcraft_actions(self, role):
        """(allowed, blocked) moves for this role: what the dashboard offers, and what it explains instead. Forward moves first, then
        the step back (an Administrator's, offered only to one; Inventory Staff are not shown a step back at all)."""
        self.ensure_one()
        allowed, blocked = [], []
        moves = [(to, 'forward') for to in NEXT.get(self.clothcraft_state, ())]
        back = BACK.get(self.clothcraft_state)
        if back and role == 'admin':
            moves.append((back, 'back'))
        for to, direction in moves:
            if direction == 'back':
                label = BACK_ACTIONS[to]
            else:
                label = ACTIONS[to] + (' (cash collected)' if to == 'delivered' and self._clothcraft_is_cod() else '')
            entry = {'to': to, 'label': label, 'needs_note': self._clothcraft_note_required(to), 'confirm': to == 'cancelled', 'direction': direction}
            problem = self._clothcraft_check(to, role)
            if problem:
                blocked.append({**entry, 'reason': problem[1]})
            else:
                allowed.append(entry)
        return allowed, blocked

    # ------------------------------------------------------------------ the move
    def _clothcraft_audit(self, before, after, staff, note, via='dashboard', actor_type=None, partner=None, step_back=False):
        """One history line. `staff` is a res.users (staff or, via odoo, whoever used the Odoo screens); `partner` the customer."""
        actor_type = actor_type or ('odoo' if via == 'odoo' else 'staff')
        vals = {'order_id': self.id, 'actor_type': actor_type, 'from_state': before, 'to_state': after, 'note': note or False, 'via': via,
                'step_back': step_back}
        if actor_type in ('staff', 'odoo'):
            vals.update(staff_id=staff.id, staff_name=staff.name)
        elif actor_type == 'customer':
            vals.update(partner_id=partner.id, partner_name=partner.name)
        self.env['clothcraft.order.audit'].sudo().create(vals)

    def _clothcraft_move(self, to, staff, note=None, actor_type='staff', partner=None):
        """Do the native work of this move and write the audit line. The caller has locked the order, checked the rules and holds
        a savepoint: if Odoo refuses anything here (a UserError), the caller rolls back and nothing has happened."""
        self.ensure_one()
        order = self.sudo().with_context(clothcraft_dashboard=True)
        before = order.clothcraft_state
        back = order._clothcraft_is_back(to)
        refund = to == 'cancelled' and order._clothcraft_bank_paid()
        transactions = order.transaction_ids
        open_pickings = order.picking_ids.filtered(lambda p: p.state not in ('done', 'cancel'))
        if back:
            if before == 'delivered' and order._clothcraft_is_cod():
                raise UserError(self.env._("The cash of this order is recorded as collected: it can't be stepped back. Nothing was changed."))
            order.clothcraft_state = to                   # nothing native to undo: no payment, no stock (see BACK)
        elif to == 'confirmed':
            for transaction in transactions.filtered(lambda t: t.state in ('pending', 'authorized')):
                transaction._set_done()
                transaction.is_post_processed = True      # the payment cron must not post-process (email, invoice) it
        elif to == 'shipped':
            moves = open_pickings.move_ids.filtered(lambda m: m.state not in ('done', 'cancel'))
            precision = self.env['decimal.precision'].precision_get('Product Unit')
            if not moves or any(float_compare(m.quantity, m.product_uom_qty, precision_digits=precision) < 0 for m in moves):
                # Odoo would validate a delivery with nothing reserved as an empty one: the goods have not left, so say no
                raise UserError(self.env._("Odoo could not validate this delivery: the goods are not all reserved. Nothing was changed."))
            moves.picked = True
            order.clothcraft_state = 'shipped'
            result = open_pickings.with_context(skip_immediate=True, skip_backorder=True, skip_sms=True).button_validate()
            if result is not True or any(p.state != 'done' for p in open_pickings):
                raise UserError(self.env._("Odoo could not validate this delivery (the goods are not all reserved). Nothing was changed."))
        elif to == 'out_for_delivery':
            order.clothcraft_state = 'out_for_delivery'   # no stock effect: the goods left at shipped
        elif to == 'delivered':
            for transaction in transactions.filtered(lambda t: t.state in ('pending', 'authorized')):
                transaction._set_done()                   # cash on delivery: the cash is collected now
                transaction.is_post_processed = True
            order.clothcraft_state = 'delivered'
            order.action_lock()
        elif to == 'closed':
            order.clothcraft_state = 'closed'             # the customer has it: payment and the lock were settled at delivered
        elif to == 'cancelled':
            if order.picking_ids.filtered(lambda p: p.state == 'done'):
                raise UserError(self.env._("A delivery of this order has already left. It can't be cancelled."))
            for transaction in transactions.filtered(lambda t: t.state in ('pending', 'authorized')):
                transaction._set_canceled()
            order.with_context(disable_cancel_warning=True).action_cancel()   # cancels the open deliveries: the reservation is released
        order.flush_recordset()
        order.invalidate_recordset(['clothcraft_state'])
        after = order.clothcraft_state
        if after != to:
            raise UserError(self.env._("The order did not reach %(state)s. Nothing was changed.", state=LABELS[to]))
        text = (f"REFUND DUE. {note}" if note else "REFUND DUE.") if refund else note
        via = {'customer': 'shop', 'automatic': 'cron'}.get(actor_type, 'dashboard')
        order._clothcraft_audit(before, after, staff, text, via=via, actor_type=actor_type, partner=partner, step_back=back)
        return after

    # ------------------------------------------------------------------ drift: things done in the Odoo screens
    def _clothcraft_note_drift(self, before):
        if self.env.context.get('clothcraft_dashboard') or self.env.context.get('tracking_disable'):
            return
        for order in self.sudo():
            after = order.clothcraft_state
            if before.get(order.id) and after and after != before[order.id]:
                order._clothcraft_audit(before[order.id], after, self.env.user, None, via='odoo')

    def _action_cancel(self):
        before = {order.id: order.clothcraft_state for order in self.sudo()}
        result = super()._action_cancel()
        self._clothcraft_note_drift(before)
        return result


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    def _action_done(self):
        """A delivery validated in the Odoo screens moves the order on to shipped (the field follows); say so in the history, as
        'Odoo'. Not when the dashboard did it (it writes its own line) and not under tracking_disable (the simulation, whose own
        checks look for anything stamped with the real clock)."""
        orders = self.sudo().sale_id
        before = {order.id: order.clothcraft_state for order in orders}
        result = super()._action_done()
        orders._clothcraft_note_drift(before)
        return result
