"""Employee management for the Administrator (admin dashboard, step 7c): list, read, add, edit, change the role, reset the password, deactivate
and reactivate the people who sign in to the staff and admin dashboards.

An EMPLOYEE is an Odoo user who is not a portal/public user, holds the Inventory Staff or the Administrator group (an Administrator implies
Inventory), and is not one of the accounts that are never managed here: Odoo's own superuser and base admin, anyone who holds the Settings
(system) group, and the storefront API service. Those are never listed and never touched: they answer `not_found` like any id that is not
an employee. Customers are portal users and never match.

Rules kept in Odoo, whatever the screen shows:
- Every method needs a LIVE admin-scope session (_api_admin_start). Nothing here is mirrored for the employee dashboard.
- Every write is done with sudo, limited to exact fields: name, login/email, function (job title), phone, password, active, and the two role
  groups (linked and unlinked by name, never set as a list, so other groups are untouched). No group id ever comes from the browser.
- An Administrator cannot deactivate, demote, reset the password of or change the email of their OWN account.
- The last active managed Administrator can never be deactivated or demoted (re-counted inside an advisory lock, so two Administrators
  acting at once cannot both succeed).
- The email is unique across ALL users (employees, customers, archived), compared in lower case.
- A role change, a deactivation and a password reset end that person's sessions at once, in every scope.
- A password is hashed by Odoo, never stored or logged as typed, and appears in no reply, audit line or notification. Nothing here counts toward
  sign-in throttling (no _api_hit): these are an Administrator's actions, not sign-in attempts.
- Every change writes one append-only line (clothcraft.employee.audit) with non-secret old/new values only.
Every reply is {status, ...}: ok / done, unauthorised, not_found, invalid (`fields`), refused (a rule said no: `message`).
"""
import json
import re

from odoo import Command, api, fields, models
from odoo.tools import escape_psql

from .api_auth import EMAIL

ROLES = {'inventory': 'clothcraft.group_inventory', 'admin': 'clothcraft.group_admin'}
ROLE_LABEL = {'inventory': 'Inventory Staff', 'admin': 'Administrator'}
PASSWORD_MIN, PASSWORD_MAX = 12, 128
NAME_MIN, NAME_MAX, TITLE_MAX, PHONE_MAX, EMAIL_MAX = 2, 80, 80, 40, 254
PHONE = re.compile(r'^[0-9+()\-. ]{3,40}$')
LIST_MAX = 100
AUDIT_ROWS = 20
STATUSES = ('active', 'inactive', 'all')
LOCK_SPACE = 7300   # advisory lock: one at a time for every change to who the employees and Administrators are
# one context for every write: no invitation or "your account changed" mail, no chatter
QUIET = {'no_reset_password': True, 'tracking_disable': True, 'mail_create_nosubscribe': True, 'mail_notrack': True, 'clothcraft_no_security_mail': True}


class ClothcraftApiEmployee(models.AbstractModel):
    _inherit = 'clothcraft.api'

    # ------------------------------------------------------------------ who is an employee
    @api.model
    def _api_emp_users(self):
        return self.env['res.users'].sudo().with_context(active_test=False)

    @api.model
    def _api_emp_excluded(self):
        """User ids that are never managed here: the superuser, the base admin, anyone holding Settings (system) and the API service."""
        special = [self.env.ref('base.group_system').id, self.env.ref('clothcraft.group_api').id]
        ids = {self.env.ref('base.user_root').id, self.env.ref('base.user_admin').id}
        return list(ids | set(self._api_emp_users().search([('all_group_ids', 'in', special)]).ids))

    @api.model
    def _api_emp_domain(self):
        return [('share', '=', False), ('all_group_ids', 'in', self.env.ref('clothcraft.group_inventory').id), ('id', 'not in', self._api_emp_excluded())]

    @api.model
    def _api_emp_role(self, user):
        return 'admin' if user.has_group('clothcraft.group_admin') else 'inventory'

    @api.model
    def _api_emp_find(self, payload, info):
        try:
            uid = int(payload.get('employee_id'))
        except (TypeError, ValueError):
            return None, {**info, 'status': 'not_found'}
        user = self._api_emp_users().search(self._api_emp_domain() + [('id', '=', uid)], limit=1)
        return (user, None) if user else (None, {**info, 'status': 'not_found'})

    @api.model
    def _api_emp_lock(self):
        self.env.cr.execute("SELECT pg_advisory_xact_lock(%s, 1)", [LOCK_SPACE])

    @api.model
    def _api_emp_fresh(self, sql, params):
        """Run a READ on a NEW connection, so it sees everything committed so far. Odoo's transaction works on a snapshot taken at its first
        query; after waiting for the advisory lock that snapshot can be older than the change another Administrator has just committed, and a
        last-Administrator check made on it would be wrong. The lock is held until the other request has committed, so this read is exact."""
        with self.env.registry.cursor() as cr:
            cr.execute(sql, params)
            return cr.fetchall()

    @api.model
    def _api_emp_admin_count(self):
        """Active managed Administrators, now (read fresh, see _api_emp_fresh). The same people the list shows as Administrators: not shared users,
        not the superuser or the base admin, not a holder of the system or API groups."""
        admin, system, api_group = (self.env.ref(x).id for x in ('clothcraft.group_admin', 'base.group_system', 'clothcraft.group_api'))
        skip = (self.env.ref('base.user_root').id, self.env.ref('base.user_admin').id)
        return self._api_emp_fresh(
            """SELECT count(*) FROM res_users u
               WHERE u.active AND NOT u.share AND u.id NOT IN %s
                 AND EXISTS (SELECT 1 FROM res_groups_users_rel r WHERE r.uid = u.id AND r.gid = %s)
                 AND NOT EXISTS (SELECT 1 FROM res_groups_users_rel r WHERE r.uid = u.id AND r.gid IN %s)""", [skip, admin, (system, api_group)])[0][0]

    @api.model
    def _api_emp_state(self, user):
        """(active, role) of this employee read fresh, for the checks made after the lock."""
        admin = self.env.ref('clothcraft.group_admin').id
        (active, is_admin), = self._api_emp_fresh(
            "SELECT u.active, EXISTS (SELECT 1 FROM res_groups_users_rel r WHERE r.uid = u.id AND r.gid = %s) FROM res_users u WHERE u.id = %s", [admin, user.id])
        return active, 'admin' if is_admin else 'inventory'

    @api.model
    def _api_emp_end_sessions(self, user):
        """End every session this person holds, in every scope, at once."""
        self.env['clothcraft.api.session'].sudo().search([('user_id', '=', user.id), ('revoked', '=', False)]).write({'revoked': True})

    # ------------------------------------------------------------------ what is sent back
    @api.model
    def _api_emp_data(self, user, actor):
        return {
            'id': user.id, 'name': user.partner_id.name, 'email': user.email or user.login, 'role': self._api_emp_role(user), 'active': user.active,
            'last_sign_in_at': fields.Datetime.to_string(user.login_date) if user.login_date else None,
            'job_title': user.function or None, 'phone': user.phone or None, 'two_step': bool(user._mfa_type()), 'is_self': user.id == actor.id,
        }

    @api.model
    def _api_emp_audit_data(self, user):
        rows = self.env['clothcraft.employee.audit'].sudo().search([('target_id', '=', user.id)], limit=AUDIT_ROWS)
        return [{
            'id': row.id, 'at': fields.Datetime.to_string(row.create_date), 'action': row.action, 'actor_name': row.actor_name,
            'old': json.loads(row.old_values) if row.old_values else None, 'new': json.loads(row.new_values) if row.new_values else None,
        } for row in rows]

    @api.model
    def _api_emp_snapshot(self, user):
        return {'name': user.partner_id.name, 'email': user.email or user.login, 'job_title': user.function or None, 'phone': user.phone or None}

    # ------------------------------------------------------------------ checks
    @api.model
    def _api_emp_taken(self, email, ignore_id=None):
        """True when any user (any kind, archived too) already signs in with, or has, this email (compared in lower case)."""
        self.env.cr.execute(
            """SELECT 1 FROM res_users u JOIN res_partner p ON p.id = u.partner_id
               WHERE (lower(u.login) = %s OR lower(p.email) = %s) AND (%s IS NULL OR u.id <> %s) LIMIT 1""", [email, email, ignore_id, ignore_id])
        return bool(self.env.cr.fetchone())

    @api.model
    def _api_emp_values(self, payload, creating, user=None):
        """(values, errors): the plain-text fields present in the payload, cleaned. Missing keys are left out on update."""
        values, errors = {}, {}
        if 'name' in payload or creating:
            name = payload.get('name')
            name = name.strip() if isinstance(name, str) else ''
            if len(name) < NAME_MIN:
                errors['name'] = 'Enter the name.'
            elif len(name) > NAME_MAX:
                errors['name'] = f'Use {NAME_MAX} characters or fewer for the name.'
            else:
                values['name'] = name
        if 'email' in payload or creating:
            email = payload.get('email')
            email = email.strip().lower() if isinstance(email, str) else ''
            if len(email) > EMAIL_MAX or not EMAIL.match(email):
                errors['email'] = 'Enter an email address like name@example.com.'
            else:
                values['email'] = email
        if 'job_title' in payload:
            title = payload.get('job_title')
            title = title.strip() if isinstance(title, str) else ''
            if len(title) > TITLE_MAX or (title and not title.isprintable()):
                errors['job_title'] = f'Use {TITLE_MAX} printable characters or fewer for the job title.'
            else:
                values['job_title'] = title or None
        if 'phone' in payload:
            phone = payload.get('phone')
            phone = phone.strip() if isinstance(phone, str) else ''
            if phone and not PHONE.match(phone):
                errors['phone'] = 'Use digits, spaces and + ( ) - . only.'
            else:
                values['phone'] = phone or None
        return values, errors

    @api.model
    def _api_emp_check_password(self, password, name, email):
        """The sentence for a password that is refused, or None. The rule: 12 to 128 characters, not a common one, not one repeated
        character, and it must not contain the person's email, the part before the @, or a word (4+ letters) of their name."""
        if not isinstance(password, str) or not password:
            return 'Enter a temporary password.'
        if len(password) < PASSWORD_MIN:
            return f'Use at least {PASSWORD_MIN} characters.'
        if len(password) > PASSWORD_MAX:
            return f'Use {PASSWORD_MAX} characters or fewer.'
        lower = password.lower()
        if lower in self._api_common_passwords() or len(set(password)) == 1:
            return 'That password is too common. Choose another one.'
        local = (email or '').split('@')[0]
        words = [w for w in re.split(r'[^a-z0-9]+', (name or '').lower()) if len(w) >= 4]
        if (email and email in lower) or (len(local) >= 4 and local in lower) or any(w in lower for w in words):
            return "The password cannot contain the person's name or email address."
        return None

    @api.model
    def _api_emp_role_value(self, payload):
        role = payload.get('role')
        return role if isinstance(role, str) and role in ROLES else None

    @api.model
    def _api_emp_note(self, kind, actor, user, text):
        self.env['clothcraft.notification'].sudo()._employee_event(kind, user, actor, text)

    # ------------------------------------------------------------------ read
    @api.model
    def admin_employees(self, payload):
        """payload: sid_hash, q (name or email), status (active, inactive, all), limit, offset. status ok: employees (by name), total, limit, offset."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        domain = self._api_emp_domain()
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
        Users = self._api_emp_users()
        return {**info, 'status': 'ok', 'total': Users.search_count(domain), 'limit': limit, 'offset': offset,
                'employees': [self._api_emp_data(u, staff['user']) for u in Users.search(domain, limit=limit, offset=offset)]}

    @api.model
    def admin_employee(self, payload):
        """payload: sid_hash, employee_id. status ok with the employee and the latest history lines about them, or not_found."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        user, early = self._api_emp_find(payload, info)
        if early:
            return early
        return {**info, 'status': 'ok', 'employee': self._api_emp_data(user, staff['user']), 'audit': self._api_emp_audit_data(user)}

    # ------------------------------------------------------------------ add
    @api.model
    def admin_employee_create(self, payload):
        """payload: sid_hash, name, email, role (inventory, admin), password (temporary), job_title, phone. status done (with the employee), invalid."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        values, errors = self._api_emp_values(payload, creating=True)
        role = self._api_emp_role_value(payload)
        if not role:
            errors['role'] = 'Choose Inventory Staff or Administrator.'
        problem = self._api_emp_check_password(payload.get('password'), values.get('name'), values.get('email'))
        if problem:
            errors['password'] = problem
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        self._api_emp_lock()
        if self._api_emp_taken(values['email']):
            return {**info, 'status': 'invalid', 'fields': {'email': 'That email is already used by another account.'}}
        outcome = {}

        def make():
            groups = [self.env.ref('base.group_user').id, self.env.ref(ROLES[role]).id]
            vals = {'name': values['name'], 'login': values['email'], 'email': values['email'], 'password': payload['password'],
                    'group_ids': [Command.set(groups)]}
            if values.get('job_title'):
                vals['function'] = values['job_title']
            if values.get('phone'):
                vals['phone'] = values['phone']
            user = self._api_emp_users().with_context(**QUIET).create(vals)
            outcome['user'] = user
            self.env['clothcraft.employee.audit']._log(staff['user'], user, 'created', None, {**self._api_emp_snapshot(user), 'role': role, 'active': True})

        failed = self._api_supplier_run(info, make)
        if failed:
            return failed
        user = outcome['user']
        self._api_emp_note('employee_added', staff['user'], user, f"{staff['user'].partner_id.name} added {user.partner_id.name} as {ROLE_LABEL[role]}.")
        return {**info, 'status': 'done', 'employee': self._api_emp_data(user, staff['user'])}

    # ------------------------------------------------------------------ edit
    @api.model
    def admin_employee_update(self, payload):
        """payload: sid_hash, employee_id and any of name, email, job_title, phone. status done, invalid, not_found, refused (your own email)."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        user, early = self._api_emp_find(payload, info)
        if early:
            return early
        values, errors = self._api_emp_values(payload, creating=False)
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        self._api_emp_lock()
        user.invalidate_recordset()
        before = self._api_emp_snapshot(user)
        changed = {k: v for k, v in values.items() if v != before.get(k)}
        if not changed:
            return {**info, 'status': 'done', 'employee': self._api_emp_data(user, staff['user'])}
        if 'email' in changed:
            if user.id == staff['user'].id:
                return {**info, 'status': 'refused', 'message': 'You cannot change your own email here.'}
            if self._api_emp_taken(changed['email'], ignore_id=user.id):
                return {**info, 'status': 'invalid', 'fields': {'email': 'That email is already used by another account.'}}

        def edit():
            vals = {}
            if 'name' in changed:
                vals['name'] = changed['name']
            if 'email' in changed:
                vals.update({'login': changed['email'], 'email': changed['email']})
            if 'job_title' in changed:
                vals['function'] = changed['job_title'] or False
            if 'phone' in changed:
                vals['phone'] = changed['phone'] or False
            user.with_context(**QUIET).write(vals)
            self.env['clothcraft.employee.audit']._log(staff['user'], user, 'edited', {k: before[k] for k in changed}, changed)

        failed = self._api_supplier_run(info, edit)
        return failed or {**info, 'status': 'done', 'employee': self._api_emp_data(user, staff['user'])}

    # ------------------------------------------------------------------ role
    @api.model
    def admin_employee_set_role(self, payload):
        """payload: sid_hash, employee_id, role (inventory, admin). status done, invalid, not_found, refused (yourself; the last Administrator)."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        user, early = self._api_emp_find(payload, info)
        if early:
            return early
        role = self._api_emp_role_value(payload)
        if not role:
            return {**info, 'status': 'invalid', 'fields': {'role': 'Choose Inventory Staff or Administrator.'}}
        if user.id == staff['user'].id:
            return {**info, 'status': 'refused', 'message': 'You cannot change your own role.'}
        self._api_emp_lock()
        user.invalidate_recordset()
        active, current = self._api_emp_state(user)
        if role == current:
            return {**info, 'status': 'invalid', 'fields': {'role': f'They are already {ROLE_LABEL[role]}.'}}
        if current == 'admin' and active and self._api_emp_admin_count() <= 1:
            return {**info, 'status': 'refused', 'message': 'This is the last active Administrator, so it cannot be demoted.'}

        def change():
            user.with_context(**QUIET).write({'group_ids': [Command.unlink(self.env.ref(ROLES[current]).id), Command.link(self.env.ref(ROLES[role]).id)]})
            self._api_emp_end_sessions(user)
            self.env['clothcraft.employee.audit']._log(staff['user'], user, 'role_changed', {'role': current}, {'role': role})

        failed = self._api_supplier_run(info, change)
        if failed:
            return failed
        self._api_emp_note('employee_role_changed', staff['user'], user,
                           f"{staff['user'].partner_id.name} changed {user.partner_id.name} from {ROLE_LABEL[current]} to {ROLE_LABEL[role]}.")
        return {**info, 'status': 'done', 'employee': self._api_emp_data(user, staff['user'])}

    # ------------------------------------------------------------------ password
    @api.model
    def admin_employee_reset_password(self, payload):
        """payload: sid_hash, employee_id, password (the new temporary one). status done, invalid, not_found, refused (yourself). The password is
        hashed by Odoo, the person's sessions end, and it is in no reply, audit line or notification."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        user, early = self._api_emp_find(payload, info)
        if early:
            return early
        problem = self._api_emp_check_password(payload.get('password'), user.partner_id.name, user.email or user.login)
        if problem:
            return {**info, 'status': 'invalid', 'fields': {'password': problem}}
        if user.id == staff['user'].id:
            return {**info, 'status': 'refused', 'message': 'You cannot reset your own password here.'}
        self._api_emp_lock()

        def reset():
            user.with_context(**QUIET).write({'password': payload['password']})
            self._api_emp_end_sessions(user)
            self.env['clothcraft.employee.audit']._log(staff['user'], user, 'password_reset')

        failed = self._api_supplier_run(info, reset)
        return failed or {**info, 'status': 'done', 'employee': self._api_emp_data(user, staff['user'])}

    # ------------------------------------------------------------------ deactivate, reactivate
    @api.model
    def admin_employee_deactivate(self, payload):
        """payload: sid_hash, employee_id. status done, not_found, refused (yourself; the last Administrator; already inactive)."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        user, early = self._api_emp_find(payload, info)
        if early:
            return early
        if user.id == staff['user'].id:
            return {**info, 'status': 'refused', 'message': 'You cannot deactivate your own account.'}
        self._api_emp_lock()
        user.invalidate_recordset()
        active, role = self._api_emp_state(user)
        if not active:
            return {**info, 'status': 'refused', 'message': 'This account is already inactive.'}
        if role == 'admin' and self._api_emp_admin_count() <= 1:
            return {**info, 'status': 'refused', 'message': 'This is the last active Administrator, so it cannot be deactivated.'}

        def off():
            user.with_context(**QUIET).write({'active': False})
            self._api_emp_end_sessions(user)
            self.env['clothcraft.employee.audit']._log(staff['user'], user, 'deactivated', {'active': True}, {'active': False})

        failed = self._api_supplier_run(info, off)
        if failed:
            return failed
        self._api_emp_note('employee_deactivated', staff['user'], user, f"{staff['user'].partner_id.name} deactivated {user.partner_id.name}.")
        return {**info, 'status': 'done', 'employee': self._api_emp_data(user, staff['user'])}

    @api.model
    def admin_employee_reactivate(self, payload):
        """payload: sid_hash, employee_id. status done, not_found, refused (already active)."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        user, early = self._api_emp_find(payload, info)
        if early:
            return early
        self._api_emp_lock()
        user.invalidate_recordset()
        if self._api_emp_state(user)[0]:
            return {**info, 'status': 'refused', 'message': 'This account is already active.'}

        def on():
            user.with_context(**QUIET).write({'active': True})
            self.env['clothcraft.employee.audit']._log(staff['user'], user, 'reactivated', {'active': False}, {'active': True})

        failed = self._api_supplier_run(info, on)
        if failed:
            return failed
        self._api_emp_note('employee_reactivated', staff['user'], user, f"{staff['user'].partner_id.name} reactivated {user.partner_id.name}.")
        return {**info, 'status': 'done', 'employee': self._api_emp_data(user, staff['user'])}
