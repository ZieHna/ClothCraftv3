"""Step 11: order tracking for the customer, their "I received my order", and the automatic close.

The customer sees four steps with the time each was reached, from the order's history (never who moved it, never a note): 1 received
and preparing, 2 shipped out, 3 on delivery, 4 delivered. After delivery the customer confirms they received it, which closes the order
(owner only, only from delivered, idempotent, audited as done by the customer). If they never do, a daily job closes delivered orders
N days after delivery (Sales settings, "Close delivered orders after", default 7; 0 turns it off), audited as automatic.
"""
import datetime
import logging

from psycopg2 import errors as pg_errors

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools import mute_logger

from .order_flow import LABELS

_logger = logging.getLogger(__name__)

AUTO_CLOSE_PARAM = 'clothcraft.auto_close_days'
AUTO_CLOSE_DEFAULT = 7
# the customer's steps and the states that mean each one was reached
STEPS = (('received', ('confirmed', 'packed')), ('shipped', ('shipped',)), ('on_delivery', ('out_for_delivery',)), ('delivered', ('delivered',)))
STEP_OF = {'confirmed': 0, 'packed': 0, 'shipped': 1, 'out_for_delivery': 2, 'delivered': 3, 'closed': 3}


def _iso(value):
    return value.isoformat(timespec='milliseconds') if value else None


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    @api.model
    def _clothcraft_auto_close_days(self):
        raw = self.env['ir.config_parameter'].sudo().get_param(AUTO_CLOSE_PARAM, str(AUTO_CLOSE_DEFAULT))
        try:
            return max(int(raw), 0)
        except (TypeError, ValueError):
            return AUTO_CLOSE_DEFAULT

    @api.model
    def _cron_clothcraft_auto_close(self, now=None):
        """Close every delivered order whose delivery is N days old or more. An order a customer is confirming at this moment (its
        row is locked) is left for the next run. Returns how many were closed."""
        days = self._clothcraft_auto_close_days()
        if days <= 0:
            return 0
        cutoff = (now or fields.Datetime.now()) - datetime.timedelta(days=days)
        Audit = self.env['clothcraft.order.audit'].sudo()
        closed = 0
        for order in self.sudo().search([('clothcraft_state', '=', 'delivered')], order='id'):
            delivered = Audit.search([('order_id', '=', order.id), ('to_state', '=', 'delivered')], order='id desc', limit=1)
            if not delivered or delivered.create_date > cutoff:
                continue                          # not delivered long enough ago (or no record of when: never guessed)
            try:
                with self.env.cr.savepoint(), mute_logger('odoo.sql_db'):
                    self.env.cr.execute("SELECT id FROM sale_order WHERE id = %s FOR UPDATE NOWAIT", [order.id])
                    order.invalidate_recordset()
                    if order.clothcraft_state != 'delivered':
                        continue
                    order._clothcraft_move('closed', None, actor_type='automatic')
                    closed += 1
            except pg_errors.LockNotAvailable:
                continue                          # someone is changing it right now: tomorrow's run sees it again
        if closed:
            _logger.info('clothcraft: closed %s delivered order(s) automatically (%s days after delivery)', closed, days)
        return closed


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    clothcraft_auto_close_days = fields.Integer(
        string="Close delivered orders after (days)", config_parameter=AUTO_CLOSE_PARAM, default=AUTO_CLOSE_DEFAULT,
        help="A delivered order the customer has not confirmed closes by itself this many days after delivery. 0 turns it off.")

    @api.constrains('clothcraft_auto_close_days')
    def _check_clothcraft_auto_close_days(self):
        for settings in self:
            if settings.clothcraft_auto_close_days < 0:
                raise ValidationError(self.env._("The number of days is 0 (off) or more."))


class ClothcraftApiTracking(models.AbstractModel):
    _inherit = 'clothcraft.api'

    @api.model
    def _api_tracking(self, order):
        """What the customer sees of the order's progress: the four steps with the time each was reached (the latest time it was
        reached, should an Administrator have stepped it back and on again), and how it was closed. Times only: no names, no notes."""
        state = order.clothcraft_state
        history = self.env['clothcraft.order.audit'].sudo().search([('order_id', '=', order.id)], order='id')
        entered = {}
        for line in history:
            entered[line.to_state] = line.create_date
        current = STEP_OF.get(state)
        sudo_order = order.sudo()
        steps = []
        for index, (key, states) in enumerate(STEPS):
            at = None
            if current is not None and index <= current:
                times = [entered[s] for s in states if s in entered]
                at = max(times) if times else None
                if at is None and index == 0:
                    # never moved by staff to step 1: cash on delivery is accepted when placed; a bank transfer when its payment was done
                    done = sudo_order.transaction_ids.filtered(lambda t: t.state == 'done')
                    at = (max(done.mapped('last_state_change')) if done and not sudo_order._clothcraft_is_cod() else None) or order.create_date
                if at is None and index == 1:
                    left = sudo_order.picking_ids.filtered(lambda p: p.state == 'done' and p.date_done)
                    at = max(left.mapped('date_done')) if left else None
            steps.append({'step': key, 'reached_at': _iso(at)})
        closing = history.filtered(lambda l: l.to_state == 'closed')[-1:] if state == 'closed' else history.browse()
        return {
            'steps': steps, 'current': STEPS[current][0] if current is not None else None, 'awaiting_payment': state == 'awaiting_payment',
            'closed_at': _iso(closing.create_date) if closing else None,
            'closed_by': ('customer' if closing.actor_type == 'customer' else 'automatic') if closing else None,
            'can_confirm': state == 'delivered',
        }

    @api.model
    def order_confirm_received(self, payload):
        """payload: sid_hash, order_id. The signed-in customer says they received their delivered order, which closes it.

        status ok (with the order, and replayed: True when it was already closed), unauthorised, not_found (no such order, or another
        customer's: it gives nothing away), invalid_transition (not delivered yet: current, message). The order row is locked first, as
        a staff move does, so the daily job and a second press cannot close it twice."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(payload.get('sid_hash'))
        if not partner:
            return {**info, 'status': 'unauthorised'}
        info['session_remaining'] = remaining
        try:
            order_id = int(payload.get('order_id'))
        except (TypeError, ValueError):
            return {**info, 'status': 'not_found'}
        self.env.cr.execute("SELECT id FROM sale_order WHERE id = %s AND partner_id = %s AND state IN ('sale', 'cancel') FOR UPDATE", [order_id, partner.id])
        if not self.env.cr.fetchone():
            return {**info, 'status': 'not_found'}
        order = self.env['sale.order'].sudo().browse(order_id)
        order.invalidate_recordset()
        current = order.clothcraft_state
        mine = self.env['sale.order'].browse(order_id)         # read back with the service user's own rights, as every customer method does
        if current == 'closed':
            return {**info, 'status': 'ok', 'replayed': True, 'order': self._api_order_data(mine)}
        if current != 'delivered':
            return {**info, 'status': 'invalid_transition', 'current': current,
                    'message': f"This order is {LABELS.get(current, current)}. You can confirm you received it once it has been delivered."}
        try:
            with self.env.cr.savepoint():
                order._clothcraft_move('closed', None, actor_type='customer', partner=partner)
        except UserError as error:
            order.invalidate_recordset()
            return {**info, 'status': 'invalid_transition', 'current': order.clothcraft_state, 'message': str(error)}
        mine.invalidate_recordset()
        return {**info, 'status': 'ok', 'replayed': False, 'order': self._api_order_data(mine)}
