"""The staff dashboard's side of clothcraft.api: sign in, who am I, and the orders with their moves.

Everything here is SEPARATE from the customer side: its own session scope (a customer cookie never opens these methods and a staff
cookie never opens the customer ones), its own throttle counters, shorter sessions (2 h idle, 12 h absolute), and a role check made
LIVE on every call (_api_staff): a person removed from the staff groups is cut off at once, whatever session they hold. The writes
are done with sudo, limited to exactly what a move needs (see order_flow.py); the service user keeps no right to create or write.
"""
import datetime

from odoo import api, fields, models
from odoo.exceptions import AccessDenied, UserError
from odoo.tools import escape_psql

from .api_auth import EMAIL_LIMIT, LOGIN_IP_LIMIT
from .order_flow import LABELS, NOTE_LIMIT, NOTE_MIN

PAGE_MAX = 100
EMPLOYEE_ONLY_PARAM = 'clothcraft.employee_dashboard_only'
STAFF_GROUPS = (('admin', 'clothcraft.group_admin'), ('inventory', 'clothcraft.group_inventory'))


class ResConfigSettings(models.TransientModel):
    """Step 7g: the switch in Odoo's Settings (Sales > ClothCraft orders), open only to Settings users. Not a config_parameter field on purpose:
    a Boolean stored that way is the text 'True', which _api_employee_only reads as off. This writes exactly '1', or removes the row (off)."""
    _inherit = 'res.config.settings'

    clothcraft_employee_dashboard_only = fields.Boolean(
        string="Employee dashboard is employee-only",
        help="On: an Administrator signed in at the employee dashboard (/staff) works as an employee there; every admin action is only at the "
             "admin dashboard (/admin). Off (the default): an Administrator has every action at both.")

    @api.model
    def get_values(self):
        res = super().get_values()
        value = self.env['ir.config_parameter'].sudo().get_param(EMPLOYEE_ONLY_PARAM, '') or ''
        res['clothcraft_employee_dashboard_only'] = value.strip() == '1'
        return res

    def set_values(self):
        super().set_values()
        # set_param with False removes the row: off is "no row", the state the shop starts in
        self.env['ir.config_parameter'].sudo().set_param(EMPLOYEE_ONLY_PARAM, '1' if self.clothcraft_employee_dashboard_only else False)


class ClothcraftApiStaff(models.AbstractModel):
    _inherit = 'clothcraft.api'

    # ------------------------------------------------------------------ who is staff
    @api.model
    def _api_role(self, user):
        """'admin', 'inventory' or None, read from the groups now."""
        if user.share or not user.active:
            return None
        for role, group in STAFF_GROUPS:
            if user.has_group(group):
                return role
        return None

    @api.model
    def _api_employee_only(self):
        """True while the system parameter clothcraft.employee_dashboard_only is '1' (exactly). Read from the database on EVERY call with plain
        SQL, so no ORM cache can hold an old answer: switching it takes effect on the very next request, in every worker, with no new sign-in.
        It is set by SQL or by the Settings checkbox below (which writes exactly '1', or removes the row), and caps only 'staff' sessions."""
        self.env.cr.execute("SELECT value FROM ir_config_parameter WHERE key = %s", [EMPLOYEE_ONLY_PARAM])
        row = self.env.cr.fetchone()
        return bool(row) and (row[0] or '').strip() == '1'

    @api.model
    def _api_scope_role(self, role, scope):
        """(role, capped) for a session of this scope. An 'admin' session is for an Administrator only (None for anyone else). A 'staff'
        session of an Administrator is limited to the employee role while employee_dashboard_only is on (the employee dashboard is employee-only);
        every role check in the facade then refuses the Administrator's actions on that session, and the person is told they work as an employee."""
        if scope == 'admin':
            return (role if role == 'admin' else None), False
        if role == 'admin' and self._api_employee_only():
            return 'inventory', True
        return role, False

    @api.model
    def _api_staff(self, sid_hash, touch=True, scope=None):
        """The live session of this scope ('staff', or 'admin' for the Administrator's own sign-in) for this id hash with the role the person
        holds NOW, or None. Without an explicit scope it is the one the service sent with the call (context.clothcraft_scope: /api/staff sends
        'staff', /api/admin sends 'admin'), else 'staff'. Either way the session row must be of exactly that scope, so a staff session under an
        admin context (and the reverse) finds nothing."""
        scope = scope or self.env.context.get('clothcraft_scope')
        if scope not in ('staff', 'admin'):
            scope = 'staff'
        row = self._api_session(sid_hash, touch, scope=scope)
        if not row:
            return None
        user = row.user_id.sudo()
        role, capped = self._api_scope_role(self._api_role(user), scope)
        if not role:
            return None
        return {'user': user, 'role': role, 'capped': capped, 'remaining': self._api_remaining(row)}

    @api.model
    def _api_staff_user_data(self, staff):
        user = staff['user']
        data = {'id': user.id, 'name': user.partner_id.name, 'email': user.email or user.login, 'role': staff['role']}
        if staff.get('capped'):
            data['working_as_employee'] = True      # an Administrator on the employee dashboard while it is employee-only
        return data

    # ------------------------------------------------------------------ sign in, out, who am I
    @api.model
    def staff_login(self, payload):
        """payload: email, password, sid_hash, client_ip, replace_sid_hash.

        status ok (with the staff member), invalid_credentials (the same for no such account, a wrong password, a customer account, an
        account that is not staff), throttled (retry_after), or mfa_unsupported (only after a CORRECT password, never counted)."""
        return self._api_staff_signin(payload, 'staff')

    @api.model
    def admin_login(self, payload):
        """The Administrator's own sign-in (/admin). Same payload and replies as staff_login, plus not_admin: the password was RIGHT but the
        account is an employee's, not an Administrator's. not_admin is said only after a correct password and is never counted against the
        throttle (a wrong password, for an employee's email or for none at all, is the same invalid_credentials, counted on its own counters)."""
        return self._api_staff_signin(payload, 'admin')

    @api.model
    def _api_staff_signin(self, payload, scope):
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        email, password, ip = (payload.get('email') or '').strip().lower(), payload.get('password') or '', payload.get('client_ip')
        door = 'admin' if scope == 'admin' else 'staff'
        email_key = self._api_key(f'{door}-login-email', email)
        ip_key = self._api_key(f'{door}-login-ip', ip or '-')
        locked = self._api_locked_for([email_key, ip_key])
        if locked:
            return {**info, 'status': 'throttled', 'retry_after': locked}
        self._api_gc()

        user = self.env['res.users'].sudo().with_context(active_test=False).search([('login', '=', email)], limit=1) if email else None
        verified, staff_user = False, None
        if user and user.active and not user.share and password:
            staff_user = user.with_user(user).sudo()
            try:
                staff_user._check_credentials({'type': 'password', 'login': email, 'password': password}, {'interactive': True})
                verified = bool(self._api_role(staff_user))
            except AccessDenied:
                verified = False
        else:
            self._api_dummy_hash()
        if not verified:
            self._api_hit(email_key, EMAIL_LIMIT)
            self._api_hit(ip_key, LOGIN_IP_LIMIT)
            return {**info, 'status': 'invalid_credentials'}
        role, capped = self._api_scope_role(self._api_role(staff_user), scope)
        if not role:
            return {**info, 'status': 'not_admin'}      # only at the admin door: a correct password for an employee's account (not counted)
        if staff_user._mfa_type():
            return {**info, 'status': 'mfa_unsupported'}
        self._api_forget(email_key)
        staff_user._update_last_login()
        remaining = self._api_start_session(staff_user, payload['sid_hash'], payload.get('replace_sid_hash'), scope=scope)
        user = {**self._api_user_data(staff_user), 'role': role}
        if capped:
            user['working_as_employee'] = True
        return {**info, 'status': 'ok', 'user': user, 'remaining': remaining}

    @api.model
    def staff_session(self, payload):
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        staff = self._api_staff(payload.get('sid_hash'))
        if not staff:
            return {**info, 'valid': False}
        return {**info, 'valid': True, 'user': self._api_staff_user_data(staff), 'remaining': staff['remaining']}

    @api.model
    def admin_session(self, payload):
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        staff = self._api_staff(payload.get('sid_hash'), scope='admin')
        if not staff:
            return {**info, 'valid': False}
        return {**info, 'valid': True, 'user': self._api_staff_user_data(staff), 'remaining': staff['remaining']}

    @api.model
    def admin_logout(self, payload):
        rows = self.env['clothcraft.api.session'].sudo().search([('sid_hash', '=', payload.get('sid_hash') or ''), ('scope', '=', 'admin'), ('revoked', '=', False)])
        rows.write({'revoked': True})
        return {**self._api_money(), 'simulation': self._api_simulation(), 'revoked': bool(rows)}

    @api.model
    def staff_logout(self, payload):
        rows = self.env['clothcraft.api.session'].sudo().search([('sid_hash', '=', payload.get('sid_hash') or ''), ('scope', '=', 'staff'), ('revoked', '=', False)])
        rows.write({'revoked': True})
        return {**self._api_money(), 'simulation': self._api_simulation(), 'revoked': bool(rows)}

    # ------------------------------------------------------------------ reading orders
    @api.model
    def _api_status_time(self, order):
        """When the order last changed status: its latest history line, else when it was placed."""
        last = self.env['clothcraft.order.audit'].sudo().search([('order_id', '=', order.id)], order='id desc', limit=1)
        return (last.create_date or order.create_date).isoformat(timespec='milliseconds')

    @api.model
    def _api_staff_summary(self, order):
        transactions = order.transaction_ids
        return {
            'id': order.id, 'name': order.name, 'stage': order.clothcraft_state, 'payment_method': 'cod' if order._clothcraft_is_cod() else 'bank_transfer',
            'paid': any(t.state == 'done' for t in transactions), 'created': order.create_date.isoformat(timespec='milliseconds'),
            'status_changed': self._api_status_time(order), 'customer_name': order.partner_id.name, 'customer_email': order.partner_id.email or '',
            'amount_total': order.amount_total, 'items': int(sum(l.product_uom_qty for l in order.order_line if not l.display_type and l.product_id.default_code)),
            'has_design': any(l.clothcraft_design_id for l in order.order_line),
        }

    @api.model
    def _api_staff_detail(self, order, role):
        allowed, blocked = order._clothcraft_actions(role)
        history = self.env['clothcraft.order.audit'].sudo().search([('order_id', '=', order.id)], order='id')
        return {
            **self._api_order_data(order), 'staff': True,
            # a customer account is made with a name, an email and a password: the phone is the one given for the delivery
            'customer': {'name': order.partner_id.name, 'email': order.partner_id.email or '', 'phone': order.partner_id.phone or order.partner_shipping_id.phone or ''},
            # step 11: who, by kind; `staff` is the name shown (the staff member's, or the customer's for their own confirmation)
            'history': [{'at': h.create_date.isoformat(timespec='milliseconds'), 'from': h.from_state, 'to': h.to_state,
                         'staff': h.staff_name or h.partner_name or '', 'note': h.note or '', 'via': h.via, 'actor': h.actor_type,
                         'step_back': h.step_back} for h in history],
            'allowed': allowed, 'blocked': blocked,
        }

    @api.model
    def staff_orders(self, payload):
        """payload: sid_hash, states [..], method ('cod'|'bank_transfer'), date_from, date_to ('YYYY-MM-DD'), q, page, page_size."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        staff = self._api_staff(payload.get('sid_hash'))
        if not staff:
            return {**info, 'status': 'unauthorised'}
        domain = [('state', 'in', ('sale', 'cancel'))]
        states = [s for s in (payload.get('states') or []) if s in LABELS]
        if states:
            domain.append(('clothcraft_state', 'in', states))
        if payload.get('method') == 'cod':
            domain.append(('transaction_ids.provider_id.custom_mode', '=', 'cash_on_delivery'))
        elif payload.get('method') == 'bank_transfer':
            domain.append(('transaction_ids.provider_id.custom_mode', '=', 'wire_transfer'))
        try:
            if payload.get('date_from'):
                domain.append(('date_order', '>=', datetime.datetime.strptime(payload['date_from'], '%Y-%m-%d')))
            if payload.get('date_to'):
                domain.append(('date_order', '<', datetime.datetime.strptime(payload['date_to'], '%Y-%m-%d') + datetime.timedelta(days=1)))
        except ValueError:
            return {**info, 'status': 'invalid', 'message': 'Dates look like 2026-10-31.'}
        text = (payload.get('q') or '').strip()
        if text:
            like = '%' + escape_psql(text) + '%'
            domain += ['|', '|', '|', ('name', '=ilike', like), ('partner_id.name', '=ilike', like), ('partner_id.email', '=ilike', like), ('partner_shipping_id.name', '=ilike', like)]
        size = min(max(int(payload.get('page_size') or 25), 1), PAGE_MAX)
        page = max(int(payload.get('page') or 1), 1)
        orders = self.env['sale.order'].sudo()
        total = orders.search_count(domain)
        found = orders.search(domain, order='id desc', limit=size, offset=(page - 1) * size)
        return {**info, 'status': 'ok', 'session_remaining': staff['remaining'], 'total': total, 'page': page, 'page_size': size,
                'orders': [self._api_staff_summary(o) for o in found]}

    @api.model
    def staff_order(self, payload):
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        staff = self._api_staff(payload.get('sid_hash'))
        if not staff:
            return {**info, 'status': 'unauthorised'}
        try:
            order_id = int(payload.get('order_id'))
        except (TypeError, ValueError):
            return {**info, 'status': 'not_found', 'session_remaining': staff['remaining']}
        order = self.env['sale.order'].sudo().search([('id', '=', order_id), ('state', 'in', ('sale', 'cancel'))])
        if not order:
            return {**info, 'status': 'not_found', 'session_remaining': staff['remaining']}
        return {**info, 'status': 'ok', 'session_remaining': staff['remaining'], 'order': self._api_staff_detail(order, staff['role'])}

    # ------------------------------------------------------------------ moving an order
    @api.model
    def staff_transition(self, payload):
        """payload: sid_hash, order_id, to, expected_state (the state the staff member was looking at), note.

        status done (with the order), unauthorised, not_found, invalid (a field is wrong: `fields`), state_changed (somebody got there
        first; current + who + when), invalid_transition, forbidden (the role may not), or refused (Odoo refused the native step: the
        message is its own; nothing was changed). Anything but `done` changes nothing.

        Two staff at once: the order row is locked first, and the state the person SAW must still be the state it IS."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        staff = self._api_staff(payload.get('sid_hash'))
        if not staff:
            return {**info, 'status': 'unauthorised'}
        info['session_remaining'] = staff['remaining']
        to, expected = payload.get('to'), payload.get('expected_state')
        note = (payload.get('note') or '').strip()
        if to not in LABELS or expected not in LABELS:
            return {**info, 'status': 'invalid', 'fields': {'to': 'Choose what to do with the order.'}}
        if len(note) > NOTE_LIMIT:
            return {**info, 'status': 'invalid', 'fields': {'note': f'Keep the note to {NOTE_LIMIT} characters or fewer.'}}
        try:
            order_id = int(payload.get('order_id'))
        except (TypeError, ValueError):
            return {**info, 'status': 'not_found'}
        self.env.cr.execute("SELECT id FROM sale_order WHERE id = %s AND state IN ('sale', 'cancel') FOR UPDATE", [order_id])
        if not self.env.cr.fetchone():
            return {**info, 'status': 'not_found'}
        order = self.env['sale.order'].sudo().browse(order_id)
        order.invalidate_recordset()
        current = order.clothcraft_state
        if current != expected:
            last = self.env['clothcraft.order.audit'].sudo().search([('order_id', '=', order.id)], order='id desc', limit=1)
            who = f" by {last.staff_name}" if last else ''
            return {**info, 'status': 'state_changed', 'current': current, 'message': f"This order is now {LABELS[current]}; it was changed{who}. Nothing was done. Check it and try again.",
                    'order': self._api_staff_detail(order, staff['role'])}
        problem = order._clothcraft_check(to, staff['role'])
        if problem:
            return {**info, 'status': problem[0], 'current': current, 'message': problem[1]}
        if order._clothcraft_note_required(to) and len(note) < NOTE_MIN:
            if order._clothcraft_is_back(to):
                return {**info, 'status': 'invalid', 'fields': {'note': 'Write a short note: say why the order is stepped back.'}}
            return {**info, 'status': 'invalid', 'fields': {'note': 'Write a short note: the payment was received, so a refund has to be arranged. Say who will do it.'}}
        try:
            with self.env.cr.savepoint():
                order._clothcraft_move(to, staff['user'], note)
        except UserError as error:
            order.invalidate_recordset()
            return {**info, 'status': 'refused', 'current': order.clothcraft_state, 'message': str(error)}
        return {**info, 'status': 'done', 'order': self._api_staff_detail(order, staff['role'])}
