"""Customer management for the Administrator (admin dashboard, step 7d): list, read, edit (name, email, phone), deactivate and reactivate the
registered shop accounts.

A CUSTOMER is a portal user: `share`, holding base.group_portal, and none of the accounts that are never customers here: Odoo's public user,
the portal template, any website's public user, and anyone holding Inventory Staff, Administrator or the API service group. All by external id
or group, never by name; deactivated customers are inactive too, so `active` is never used to exclude. Anyone else answers `not_found`.

Rules kept in Odoo:
- Every method needs a LIVE admin-scope session (_api_admin_start). Nothing here is mirrored for the employee dashboard.
- NO PASSWORD HANDLING: nothing here reads, writes or checks a password. Writes are sudo, limited to name, login and email (always together),
  phone and active; a payload key outside the allow-list is refused.
- The email is the sign-in login. It is unique across ALL users (customers, employees, archived), compared in lower case, checked on a fresh
  connection under the same advisory key as registration (so a sign-up of that address cannot race the change). An email change and a
  deactivation end that customer's sessions at once. Orders, the cart and designs belong to the customer's contact, which never changes.
- Every change writes one append-only line (clothcraft.customer.audit). No notification is sent, and no mail.
- Money is Odoo's: total spent is the VAT-inclusive sum of CLOSED orders; delivered orders still awaiting confirmation are their own figure,
  never added to it.
Every reply is {status, ...}: ok / done, unauthorised, not_found, invalid (`fields`), refused (`message`).
"""
import json

from odoo import api, fields, models
from odoo.tools import escape_psql
from odoo.tools.float_utils import float_round

from .api_auth import EMAIL
from .api_employee import PHONE, QUIET

NAME_MIN, NAME_MAX, EMAIL_MAX = 2, 80, 254
LIST_MAX = 100
RECENT_ORDERS = 10
AUDIT_ROWS = 20
STATUSES = ('active', 'inactive', 'all')
EDITABLE = ('name', 'email', 'phone')
LOCK_SPACE = 7301   # one change at a time per customer (the email itself is locked with the registration key)
PLACED = ('sale', 'done', 'cancel')


class ClothcraftApiCustomer(models.AbstractModel):
    _inherit = 'clothcraft.api'

    # ------------------------------------------------------------------ who is a customer
    @api.model
    def _api_cus_users(self):
        return self.env['res.users'].sudo().with_context(active_test=False)

    @api.model
    def _api_cus_excluded(self):
        """User ids that are never customers here: the public user, the portal template, each website's public user, and anyone holding a
        staff or API group (a share user should never hold one; this is the backstop)."""
        ids = {self.env.ref('base.public_user').id, self.env.ref('base.template_portal_user_id').id}
        ids |= set(self.env['website'].sudo().with_context(active_test=False).search([]).user_id.ids)
        staff = [self.env.ref(x).id for x in ('clothcraft.group_inventory', 'clothcraft.group_api', 'base.group_user')]
        ids |= set(self._api_cus_users().search([('all_group_ids', 'in', staff)]).ids)
        return list(ids)

    @api.model
    def _api_cus_domain(self):
        return [('share', '=', True), ('all_group_ids', 'in', self.env.ref('base.group_portal').id), ('id', 'not in', self._api_cus_excluded())]

    @api.model
    def _api_cus_find(self, payload, info):
        try:
            uid = int(payload.get('customer_id'))
        except (TypeError, ValueError):
            return None, {**info, 'status': 'not_found'}
        user = self._api_cus_users().search(self._api_cus_domain() + [('id', '=', uid)], limit=1)
        return (user, None) if user else (None, {**info, 'status': 'not_found'})

    # ------------------------------------------------------------------ figures (Odoo's money, rounded once)
    @api.model
    def _api_cus_figures(self, partner_ids):
        """{partner id: {orders, closed_total, closed_count, delivered_total, delivered_count, unpaid}} with grouped reads: the same number of
        queries whatever the number of customers on the page."""
        out = {pid: {'orders': 0, 'closed_total': 0.0, 'closed_count': 0, 'delivered_total': 0.0, 'delivered_count': 0, 'unpaid': 0} for pid in partner_ids}
        if not partner_ids:
            return out
        Order = self.env['sale.order'].sudo()
        base = [('partner_id', 'in', partner_ids), ('clothcraft_state', '!=', False)]
        for partner, count in Order._read_group(base + [('state', 'in', PLACED)], ['partner_id'], ['__count']):
            out[partner.id]['orders'] = count
        for partner, state, count, total in Order._read_group(base + [('state', 'in', ('sale', 'done')), ('clothcraft_state', 'in', ('closed', 'delivered', 'awaiting_payment'))],
                                                                ['partner_id', 'clothcraft_state'], ['__count', 'amount_total:sum']):
            row = out[partner.id]
            if state == 'closed':
                row['closed_total'], row['closed_count'] = float_round(total or 0.0, precision_digits=2), count
            elif state == 'delivered':
                row['delivered_total'], row['delivered_count'] = float_round(total or 0.0, precision_digits=2), count
            else:
                row['unpaid'] = count
        return out

    # ------------------------------------------------------------------ what is sent back (no password, no address)
    @api.model
    def _api_cus_row(self, user, fig):
        return {
            'id': user.id, 'name': user.partner_id.name, 'email': user.login, 'registered_at': fields.Datetime.to_string(user.create_date),
            'active': user.active, 'order_count': fig['orders'], 'total_spent': fig['closed_total'],
        }

    @api.model
    def _api_cus_detail(self, user):
        partner = user.partner_id
        fig = self._api_cus_figures([partner.id])[partner.id]
        cart = self.env['clothcraft.cart'].sudo().search([('partner_id', '=', partner.id)], limit=1)
        return {
            **self._api_cus_row(user, fig),
            'phone': partner.phone or None,
            'last_sign_in_at': fields.Datetime.to_string(user.login_date) if user.login_date else None,
            'closed_count': fig['closed_count'],
            'delivered_awaiting': {'total': fig['delivered_total'], 'order_count': fig['delivered_count']},
            'awaiting_payment': fig['unpaid'],
            'cart_lines': len(cart.line_ids) if cart else 0,
            'draft_designs': self.env['clothcraft.design'].sudo().search_count([('partner_id', '=', partner.id), ('state', '=', 'draft')]),
        }

    @api.model
    def _api_cus_orders(self, user):
        orders = self.env['sale.order'].sudo().search([('partner_id', '=', user.partner_id.id), ('state', 'in', PLACED), ('clothcraft_state', '!=', False)],
                                                      order='date_order desc, id desc', limit=RECENT_ORDERS)
        return [{'id': o.id, 'name': o.name, 'state': o.clothcraft_state, 'placed_at': fields.Datetime.to_string(o.date_order), 'amount_total': o.amount_total}
                for o in orders]

    @api.model
    def _api_cus_audit(self, user):
        rows = self.env['clothcraft.customer.audit'].sudo().search([('target_id', '=', user.id)], limit=AUDIT_ROWS)
        return [{'id': r.id, 'at': fields.Datetime.to_string(r.create_date), 'action': r.action, 'actor_name': r.actor_name,
                 'old': json.loads(r.old_values) if r.old_values else None, 'new': json.loads(r.new_values) if r.new_values else None} for r in rows]

    @api.model
    def _api_cus_snapshot(self, user):
        return {'name': user.partner_id.name, 'email': user.login, 'phone': user.partner_id.phone or None}

    # ------------------------------------------------------------------ checks
    @api.model
    def _api_cus_taken(self, email, ignore_id):
        """True when any OTHER user (any kind, archived too) signs in with, or has, this email. Read on a fresh connection (see _api_emp_fresh)."""
        return bool(self._api_emp_fresh(
            """SELECT 1 FROM res_users u JOIN res_partner p ON p.id = u.partner_id
               WHERE (lower(u.login) = %s OR lower(p.email) = %s) AND u.id <> %s LIMIT 1""", [email, email, ignore_id]))

    @api.model
    def _api_cus_values(self, payload):
        """(values, errors) for the keys present. A key outside the allow-list is refused (the service refuses it first)."""
        values, errors = {}, {}
        for key in set(payload) - {'sid_hash', 'customer_id', *EDITABLE}:
            errors[key] = 'Not allowed.'
        if 'name' in payload:
            name = payload['name'].strip() if isinstance(payload['name'], str) else ''
            if len(name) < NAME_MIN:
                errors['name'] = 'Enter the name.'
            elif len(name) > NAME_MAX:
                errors['name'] = f'Use {NAME_MAX} characters or fewer for the name.'
            else:
                values['name'] = name
        if 'email' in payload:
            email = payload['email'].strip().lower() if isinstance(payload['email'], str) else ''
            if len(email) > EMAIL_MAX or not EMAIL.match(email):
                errors['email'] = 'Enter an email address like name@example.com.'
            else:
                values['email'] = email
        if 'phone' in payload:
            phone = payload['phone'].strip() if isinstance(payload['phone'], str) else ''
            if phone and not PHONE.match(phone):
                errors['phone'] = 'Use digits, spaces and + ( ) - . only.'
            else:
                values['phone'] = phone or None
        return values, errors

    @api.model
    def _api_cus_lock(self, user):
        self.env.cr.execute("SELECT pg_advisory_xact_lock(%s, %s)", [LOCK_SPACE, user.id])

    # ------------------------------------------------------------------ read
    @api.model
    def admin_customers(self, payload):
        """payload: sid_hash, q (name or email), status (active, inactive, all), limit, offset. status ok: customers (newest registered first),
        total, limit, offset. A row carries no phone and no address."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        domain = self._api_cus_domain()
        query = payload.get('q')
        if query is not None and not isinstance(query, str):
            return {**info, 'status': 'invalid', 'fields': {'q': 'Search with text.'}}
        if (query or '').strip():
            like = '%' + escape_psql(query.strip()[:100]) + '%'
            domain += ['|', ('name', '=ilike', like), ('login', '=ilike', like)]
        state = payload.get('status') or 'all'
        if state not in STATUSES:
            return {**info, 'status': 'invalid', 'fields': {'status': 'Choose active, inactive or all.'}}
        if state != 'all':
            domain.append(('active', '=', state == 'active'))
        try:
            limit = min(max(int(payload.get('limit', 25)), 1), LIST_MAX)
            offset = max(int(payload.get('offset', 0)), 0)
        except (TypeError, ValueError):
            return {**info, 'status': 'invalid', 'fields': {'limit': 'The page size and start must be whole numbers.'}}
        Users = self._api_cus_users()
        users = Users.search(domain, order='create_date desc, id desc', limit=limit, offset=offset)
        figures = self._api_cus_figures(users.partner_id.ids)
        return {**info, 'status': 'ok', 'total': Users.search_count(domain), 'limit': limit, 'offset': offset,
                'customers': [self._api_cus_row(u, figures[u.partner_id.id]) for u in users]}

    @api.model
    def admin_customer(self, payload):
        """payload: sid_hash, customer_id. status ok with the customer, their latest orders and the latest history lines, or not_found."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        user, early = self._api_cus_find(payload, info)
        if early:
            return early
        return {**info, 'status': 'ok', 'customer': self._api_cus_detail(user), 'recent_orders': self._api_cus_orders(user), 'audit': self._api_cus_audit(user)}

    # ------------------------------------------------------------------ edit
    @api.model
    def admin_customer_update(self, payload):
        """payload: sid_hash, customer_id and any of name, email, phone. status done, invalid, not_found. An email change ends the customer's
        sessions (they sign in with the new email next time); no mail is sent."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        user, early = self._api_cus_find(payload, info)
        if early:
            return early
        values, errors = self._api_cus_values(payload)
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        self._api_cus_lock(user)
        user.invalidate_recordset()
        before = self._api_cus_snapshot(user)
        changed = {k: v for k, v in values.items() if v != before.get(k)}
        if not changed:
            return {**info, 'status': 'done', 'customer': self._api_cus_detail(user)}
        if 'email' in changed:
            # the registration key, so a sign-up of this address waits for us (and we for it); the lookup is fresh
            self.env.cr.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', ['register:' + changed['email']])
            if self._api_cus_taken(changed['email'], user.id):
                return {**info, 'status': 'invalid', 'fields': {'email': 'That email is already used by another account.'}}

        def edit():
            vals = {}
            if 'name' in changed:
                vals['name'] = changed['name']
            if 'email' in changed:
                vals.update({'login': changed['email'], 'email': changed['email']})
            if 'phone' in changed:
                vals['phone'] = changed['phone'] or False
            user.with_context(**QUIET).write(vals)
            if 'email' in changed:
                self._api_emp_end_sessions(user)
            self.env['clothcraft.customer.audit']._log(staff['user'], user, 'edited', {k: before[k] for k in changed}, changed)

        failed = self._api_supplier_run(info, edit)
        return failed or {**info, 'status': 'done', 'customer': self._api_cus_detail(user)}

    # ------------------------------------------------------------------ deactivate, reactivate
    @api.model
    def _api_cus_toggle(self, payload, active):
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        user, early = self._api_cus_find(payload, info)
        if early:
            return early
        self._api_cus_lock(user)
        user.invalidate_recordset()
        (now,), = self._api_emp_fresh("SELECT active FROM res_users WHERE id = %s", [user.id])
        if now == active:
            return {**info, 'status': 'refused', 'message': 'This account is already active.' if active else 'This account is already inactive.'}

        def flip():
            user.with_context(**QUIET).write({'active': active})
            if not active:
                self._api_emp_end_sessions(user)
            self.env['clothcraft.customer.audit']._log(staff['user'], user, 'reactivated' if active else 'deactivated', {'active': not active}, {'active': active})

        failed = self._api_supplier_run(info, flip)
        return failed or {**info, 'status': 'done', 'customer': self._api_cus_detail(user)}

    @api.model
    def admin_customer_deactivate(self, payload):
        """payload: sid_hash, customer_id. Ends their sessions and blocks sign-in; orders, cart, designs and history are kept as they are."""
        return self._api_cus_toggle(payload, False)

    @api.model
    def admin_customer_reactivate(self, payload):
        """payload: sid_hash, customer_id. They can sign in again with their current password."""
        return self._api_cus_toggle(payload, True)
