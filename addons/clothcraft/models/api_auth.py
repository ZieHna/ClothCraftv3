"""Customer register, sign-in, sessions and attempt throttling for the storefront API service.

The service holds no accounts and no passwords: it hands a password to these methods for the length of one request. Everything is
decided here, with sudo, so the service user needs no create or write right on users, partners or sessions.

Why not Odoo's own login cooldown: it counts failures per SOURCE ADDRESS in memory, and through the service every customer has the
same source address, so five wrong passwords from anyone would lock everybody out. _check_credentials is therefore called directly
(not _login) and the counters below are per email and per client address instead. Consequence, stated in backend/README.md: anyone
who knows an email can lock that email out for a while by failing on purpose.
"""
import datetime
import hashlib
import math
import re

from odoo import SUPERUSER_ID, api, fields, models
from odoo.exceptions import AccessDenied
from odoo.tools import escape_psql, file_open

from odoo.addons.auth_signup.models.res_partner import SignupError

IDLE = datetime.timedelta(hours=8)             # a session unused for this long ends
ABSOLUTE = datetime.timedelta(days=7)          # and no session lasts longer than this, however busy
STAFF_IDLE = datetime.timedelta(hours=2)           # staff can do more than a customer: shorter
STAFF_ABSOLUTE = datetime.timedelta(hours=12)
ADMIN_IDLE = datetime.timedelta(hours=1)           # the Administrator's own session (/admin) can do the most: the shortest
ADMIN_ABSOLUTE = datetime.timedelta(hours=8)
TOUCH_EVERY = datetime.timedelta(seconds=60)   # last_seen is written at most this often
FAILURE_WINDOW = datetime.timedelta(minutes=15)  # failures older than this are forgotten
LOCK_BASE, LOCK_CAP = 60, 900                  # seconds: the first lock, doubled for each further failure, up to the cap
EMAIL_LIMIT, LOGIN_IP_LIMIT, REGISTER_IP_LIMIT = 5, 20, 10
EMAIL = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')
PASSWORD_MIN, PASSWORD_MAX = 10, 128
INVALID_LOGIN = 'invalid_credentials'
_common_passwords = None


class ClothcraftApiAuth(models.AbstractModel):
    _inherit = 'clothcraft.api'

    # ------------------------------------------------------------------ helpers
    @api.model
    def _api_now(self):
        return fields.Datetime.now()

    @api.model
    def _api_user_data(self, user):
        return {'id': user.id, 'name': user.partner_id.name, 'email': user.email or user.login}

    @api.model
    def _api_common_passwords(self):
        global _common_passwords
        if _common_passwords is None:
            with file_open('clothcraft/data/common_passwords.txt') as handle:
                _common_passwords = frozenset(line.strip().lower() for line in handle if line.strip())
        return _common_passwords

    @api.model
    def _api_check_registration(self, name, email, password):
        """The reasons a registration is refused, per field. These sentences are the ones the shop shows."""
        fields_ = {}
        if len(name) < 2:
            fields_['name'] = 'Enter your name.'
        elif len(name) > 80:
            fields_['name'] = 'Use 80 characters or fewer for the name.'
        if len(email) > 254 or not EMAIL.match(email):
            fields_['email'] = 'Enter an email address like name@example.com.'
        if len(password) < PASSWORD_MIN:
            fields_['password'] = f'Use at least {PASSWORD_MIN} characters.'
        elif len(password) > PASSWORD_MAX:
            fields_['password'] = f'Use {PASSWORD_MAX} characters or fewer.'
        elif password.lower() in self._api_common_passwords() or len(set(password)) == 1:
            fields_['password'] = 'That password is too common. Choose another one.'
        elif email and (email in password.lower() or password.lower() == email.split('@')[0]):
            fields_['password'] = 'Your password cannot contain your email address.'
        return fields_

    # ------------------------------------------------------------------ attempt counters
    @api.model
    def _api_key(self, kind, value):
        return hashlib.sha256(f'{kind}:{value}'.encode()).hexdigest()

    @api.model
    def _api_locked_for(self, keys):
        """Seconds until the longest lock among these counters ends (0: none is locked)."""
        now = self._api_now()
        self.env.cr.execute(
            'SELECT MAX(locked_until) FROM clothcraft_api_throttle WHERE key IN %s AND locked_until > %s', [tuple(keys), now])
        (until,) = self.env.cr.fetchone()
        return math.ceil((until - now).total_seconds()) if until else 0

    @api.model
    def _api_hit(self, key, limit):
        """Count one attempt on this counter; from `limit` attempts on, lock it for 60 s, doubling each time, at most 15 minutes."""
        now = self._api_now()
        self.env.cr.execute(
            """INSERT INTO clothcraft_api_throttle (key, failures, last_failure) VALUES (%s, 1, %s)
               ON CONFLICT (key) DO UPDATE SET
                 failures = CASE WHEN clothcraft_api_throttle.last_failure < %s THEN 1 ELSE clothcraft_api_throttle.failures + 1 END,
                 last_failure = %s
               RETURNING failures""", [key, now, now - FAILURE_WINDOW, now])
        (failures,) = self.env.cr.fetchone()
        if failures >= limit:
            seconds = min(LOCK_BASE * 2 ** (failures - limit), LOCK_CAP)
            self.env.cr.execute('UPDATE clothcraft_api_throttle SET locked_until = %s WHERE key = %s', [now + datetime.timedelta(seconds=seconds), key])

    @api.model
    def _api_forget(self, key):
        self.env.cr.execute('DELETE FROM clothcraft_api_throttle WHERE key = %s', [key])

    @api.model
    def _api_gc(self):
        """Drop what can no longer matter, a little at each sign-in, so the tables stay small."""
        cutoff = self._api_now() - datetime.timedelta(days=1)
        self.env.cr.execute('DELETE FROM clothcraft_api_session WHERE expires < %s OR (revoked AND write_date < %s)', [cutoff, cutoff])
        self.env.cr.execute('DELETE FROM clothcraft_api_throttle WHERE last_failure < %s AND (locked_until IS NULL OR locked_until < %s)', [cutoff, self._api_now()])

    # ------------------------------------------------------------------ sessions
    @api.model
    def _api_lifetimes(self, scope):
        if scope == 'admin':
            return ADMIN_IDLE, ADMIN_ABSOLUTE
        return (STAFF_IDLE, STAFF_ABSOLUTE) if scope == 'staff' else (IDLE, ABSOLUTE)

    @api.model
    def _api_start_session(self, user, sid_hash, replace_sid_hash=None, scope='customer'):
        """A new session for this user. One that this browser was already holding is ended: a new id at every sign-in."""
        Session = self.env['clothcraft.api.session'].sudo()
        now = self._api_now()
        idle, absolute = self._api_lifetimes(scope)
        if replace_sid_hash:
            Session.search([('sid_hash', '=', replace_sid_hash), ('scope', '=', scope)]).write({'revoked': True})
        Session.create({'sid_hash': sid_hash, 'user_id': user.id, 'scope': scope, 'last_seen': now, 'expires': now + absolute})
        return int(idle.total_seconds())

    @api.model
    def _api_session(self, sid_hash, touch=True, scope='customer'):
        """The live session of this scope for this id hash, or None. Not revoked, inside the absolute limit, inside the idle limit. A
        customer session needs a customer (a portal user), so a staff account can never hold a shop session; a staff session needs an
        internal user (the staff role itself is checked by clothcraft.api._api_staff, live, on every staff call)."""
        if not sid_hash:
            return None
        now = self._api_now()
        idle = self._api_lifetimes(scope)[0]
        row = self.env['clothcraft.api.session'].sudo().search([
            ('sid_hash', '=', sid_hash), ('scope', '=', scope), ('revoked', '=', False), ('expires', '>', now), ('last_seen', '>', now - idle)], limit=1)
        if not row or not row.user_id.active or bool(row.user_id.share) != (scope == 'customer'):
            return None
        if touch and row.last_seen < now - TOUCH_EVERY:
            row.last_seen = now
        return row

    @api.model
    def _api_remaining(self, row):
        """Seconds this session can still last: the sooner of the idle and the absolute end."""
        now = self._api_now()
        idle = self._api_lifetimes(row.scope)[0]
        return max(0, int(min((row.expires - now).total_seconds(), (max(row.last_seen, now) + idle - now).total_seconds())))

    @api.model
    def auth_session(self, payload):
        row = self._api_session(payload.get('sid_hash'))
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        if not row:
            return {**info, 'valid': False}
        return {**info, 'valid': True, 'user': self._api_user_data(row.user_id), 'remaining': self._api_remaining(row)}

    @api.model
    def auth_logout(self, payload):
        rows = self.env['clothcraft.api.session'].sudo().search([('sid_hash', '=', payload.get('sid_hash') or ''), ('scope', '=', 'customer'), ('revoked', '=', False)])
        rows.write({'revoked': True})
        return {**self._api_money(), 'simulation': self._api_simulation(), 'revoked': bool(rows)}

    # ------------------------------------------------------------------ register
    @api.model
    def auth_register(self, payload):
        """payload: name, email, password, sid_hash (of the new browser session), client_ip, replace_sid_hash.

        Returns status created (with the user), invalid (with fields), exists, deactivated (the email is a customer account an Administrator
        deactivated: the person is told to contact the shop), or throttled (with retry_after). Every attempt from
        one address counts against that address, successful or not, so the form cannot be used to make accounts in bulk."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        ip_key = self._api_key('register-ip', payload.get('client_ip') or '-')
        locked = self._api_locked_for([ip_key])
        if locked:
            return {**info, 'status': 'throttled', 'retry_after': locked}
        self._api_hit(ip_key, REGISTER_IP_LIMIT)
        self._api_gc()

        name, email, password = (payload.get('name') or '').strip(), (payload.get('email') or '').strip().lower(), payload.get('password') or ''
        problems = self._api_check_registration(name, email, password)
        if problems:
            return {**info, 'status': 'invalid', 'fields': problems}
        # Odoo's own uniqueness is UNIQUE (login, website_id), and a customer made here has no website, so the database would let two
        # registrations of one email both through. An advisory lock per email makes the second wait for the first to commit, and the
        # lookup is made in a fresh transaction (this one's snapshot predates that commit).
        self.env.cr.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', ['register:' + email])
        with self.env.registry.cursor() as cr:
            fresh = api.Environment(cr, SUPERUSER_ID, {'active_test': False})
            taken = fresh['res.users'].search_count(['|', ('login', '=', email), ('email', '=ilike', escape_psql(email))], limit=1)
            deactivated = taken and fresh['res.users'].search_count([('login', '=', email), ('active', '=', False), ('share', '=', True)], limit=1)
        if deactivated:
            return {**info, 'status': 'deactivated'}
        if taken:
            return {**info, 'status': 'exists'}
        Users = self.env['res.users'].sudo().with_context(active_test=False)
        try:
            with self.env.cr.savepoint():
                user = Users.with_context(no_reset_password=True, mail_create_nosubscribe=True, mail_notrack=True)._create_user_from_template(
                    {'login': email, 'email': email, 'name': name, 'password': password})
        except SignupError:
            # the partial unique index on res_users (models/res_users.py) refused it
            return {**info, 'status': 'exists'}
        self._api_start_session(user, payload['sid_hash'], payload.get('replace_sid_hash'))
        return {**info, 'status': 'created', 'user': self._api_user_data(user), 'remaining': int(IDLE.total_seconds())}

    # ------------------------------------------------------------------ sign in
    @api.model
    def _api_dummy_hash(self):
        """A password check that fails, as slow as a real one, for an email that has no account (so the answer takes as long)."""
        crypt = self.env['res.users']._crypt_context()
        registry = self.env.registry
        if not hasattr(registry, '_clothcraft_dummy_hash'):
            registry._clothcraft_dummy_hash = crypt.hash('some-other-password')
        crypt.verify('not-the-password', registry._clothcraft_dummy_hash)

    @api.model
    def auth_login(self, payload):
        """payload: email, password, sid_hash, client_ip, replace_sid_hash.

        Returns status ok (with the user), invalid_credentials (the same for no such account, wrong password, a staff account and an
        account without a password), throttled (with retry_after), or mfa_unsupported. mfa_unsupported is answered only after a CORRECT
        password and does not count as a failed attempt."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        email, password, ip = (payload.get('email') or '').strip().lower(), payload.get('password') or '', payload.get('client_ip')
        email_key = self._api_key('login-email', email)
        ip_key = self._api_key('login-ip', ip or '-')
        locked = self._api_locked_for([email_key, ip_key])
        if locked:
            return {**info, 'status': 'throttled', 'retry_after': locked}
        self._api_gc()

        user = self.env['res.users'].sudo().with_context(active_test=False).search([('login', '=', email)], limit=1) if email else None
        verified = False
        customer = None
        if user and user.active and user.share and password:
            customer = user.with_user(user).sudo()
            try:
                customer._check_credentials({'type': 'password', 'login': email, 'password': password}, {'interactive': True})
                verified = True
            except AccessDenied:
                verified = False
        else:
            self._api_dummy_hash()
        if not verified:
            self._api_hit(email_key, EMAIL_LIMIT)
            self._api_hit(ip_key, LOGIN_IP_LIMIT)
            return {**info, 'status': INVALID_LOGIN}
        if customer._mfa_type():
            return {**info, 'status': 'mfa_unsupported'}
        self._api_forget(email_key)
        customer._update_last_login()
        remaining = self._api_start_session(user, payload['sid_hash'], payload.get('replace_sid_hash'))
        return {**info, 'status': 'ok', 'user': self._api_user_data(user), 'remaining': remaining}
