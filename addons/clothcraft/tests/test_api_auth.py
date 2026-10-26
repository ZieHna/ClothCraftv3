import uuid
from contextlib import contextmanager
from datetime import timedelta
from unittest.mock import patch

from psycopg2 import IntegrityError

from odoo import Command, fields
from odoo.addons.auth_signup.models.res_partner import SignupError
from odoo.exceptions import AccessError
from odoo.tests import TransactionCase, tagged
from odoo.tools import mute_logger

PASSWORD = 'correct horse battery staple'


@tagged('post_install', '-at_install', 'clothcraft')
class TestStorefrontAuth(TransactionCase):
    """Register, sign in, sessions and attempt throttling, called as the service user (no create right on anything)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.tag = uuid.uuid4().hex[:6]
        cls.api_user = env['res.users'].create({
            'name': f'api {cls.tag}', 'login': f'apia_{cls.tag}',
            'group_ids': [Command.set([env.ref('base.group_user').id, env.ref('clothcraft.group_api').id])]})
        cls.api = env(user=cls.api_user)['clothcraft.api']

    def setUp(self):
        super().setUp()
        # a frozen clock: time passes only when a test says so, so locks and expiries are exact
        self.base = fields.Datetime.now()
        self.now = self.base
        self.enterContext(patch.object(type(self.api), '_api_now', lambda _self: self.now))

        @contextmanager
        def same_transaction(*_args, **_kwargs):
            yield self.env.cr

        # auth_register looks an email up in a fresh transaction so that it sees a registration another request just committed. A test
        # cannot commit, so here the 'fresh' cursor is the test's own; the real overlap is tested against the running service
        # (backend/tests/test_auth_live.py).
        self.enterContext(patch.object(self.env.registry, 'cursor', same_transaction))

    # ---- helpers
    def _email(self, name='ana'):
        return f'{name}.{uuid.uuid4().hex[:6]}@example.com'

    def _register(self, email=None, password=PASSWORD, name='Ana Cruz', ip='10.0.0.1', replace=None):
        email = email or self._email()
        sid = f'sid-{uuid.uuid4().hex}'
        result = self.api.auth_register({'name': name, 'email': email, 'password': password, 'sid_hash': sid, 'client_ip': ip, 'replace_sid_hash': replace})
        return {**result, 'sid': sid, 'email': email}

    def _login(self, email, password=PASSWORD, ip='10.0.0.1', replace=None):
        sid = f'sid-{uuid.uuid4().hex}'
        result = self.api.auth_login({'email': email, 'password': password, 'sid_hash': sid, 'client_ip': ip, 'replace_sid_hash': replace})
        return {**result, 'sid': sid}

    def _customer(self, password=PASSWORD):
        """An existing portal customer (as a sim customer would be, except that this one has a password)."""
        email = self._email('cust')
        return self.env['res.users'].create({
            'name': 'Existing Customer', 'login': email, 'email': email, 'password': password,
            'group_ids': [Command.set([self.env.ref('base.group_portal').id])]}), email

    def _t(self, seconds):
        """Set the clock this many seconds after the start of the test."""
        self.now = self.base + timedelta(seconds=seconds)

    def _sessions(self):
        return self.env['clothcraft.api.session'].sudo().search([])

    def _counts(self):
        return (self.env['res.users'].with_context(active_test=False).search_count([]), self.env['res.partner'].with_context(active_test=False).search_count([]),
                self.env['clothcraft.api.session'].sudo().search_count([]))

    # ---- register
    def test_register_makes_a_portal_customer_with_a_hashed_password_and_a_session(self):
        result = self._register(email='  Ana.Cruz@Example.COM ', name='  Ana Cruz ')
        self.assertEqual(result['status'], 'created')
        user = self.env['res.users'].browse(result['user']['id'])
        self.assertEqual((user.login, user.email, user.partner_id.name), ('ana.cruz@example.com', 'ana.cruz@example.com', 'Ana Cruz'))
        self.assertTrue(user.share and user.active)
        self.assertFalse(user.has_group('base.group_user'))
        self.assertTrue(user.has_group('base.group_portal'))
        self.env.cr.execute('SELECT password FROM res_users WHERE id = %s', [user.id])
        stored = self.env.cr.fetchone()[0]
        self.assertTrue(stored.startswith('$pbkdf2-sha512$') and PASSWORD not in stored, stored[:20])
        session = self._sessions().filtered(lambda s: s.sid_hash == result['sid'])
        self.assertEqual((session.user_id, session.revoked), (user, False))
        self.assertEqual(result['remaining'], 8 * 3600)
        self.assertEqual(self._login('ana.cruz@example.com')['status'], 'ok')  # the password works for a real sign-in

    def test_register_refuses_each_bad_field_with_a_sentence_and_creates_nothing(self):
        email = self._email()
        cases = [
            ({'name': ' A '}, {'name': 'Enter your name.'}),
            ({'name': 'x' * 81}, {'name': 'Use 80 characters or fewer for the name.'}),
            ({'email': 'nope'}, {'email': 'Enter an email address like name@example.com.'}),
            ({'email': 'a b@example.com'}, {'email': 'Enter an email address like name@example.com.'}),
            ({'password': 'short'}, {'password': 'Use at least 10 characters.'}),
            ({'password': 'x' * 129}, {'password': 'Use 128 characters or fewer.'}),
            ({'password': 'Password123'}, {'password': 'That password is too common. Choose another one.'}),
            ({'password': 'aaaaaaaaaaaa'}, {'password': 'That password is too common. Choose another one.'}),
            ({'password': f'xx{email}xx'}, {'password': 'Your password cannot contain your email address.'}),
            ({'password': email.split('@')[0]}, {'password': 'Your password cannot contain your email address.'}),
        ]
        before = self._counts()
        for n, (change, expected) in enumerate(cases):
            args = {'name': 'Ana Cruz', 'email': email, 'password': PASSWORD, **change}
            result = self.api.auth_register({**args, 'sid_hash': f'sid-{uuid.uuid4().hex}', 'client_ip': f'10.0.1.{n}'})
            self.assertEqual((result['status'], result['fields']), ('invalid', expected), change)
        self.assertEqual(self._counts(), before)

    def test_no_composition_rules_beyond_length_and_the_common_list(self):
        self.assertEqual(self._register(password='all lowercase and spaces')['status'], 'created')

    def test_a_taken_email_is_refused_however_it_is_written(self):
        first = self._register(email='taken@example.com')
        before = self._counts()
        for variant in ('taken@example.com', ' TAKEN@Example.com ', 'Taken@EXAMPLE.COM'):
            self.assertEqual(self._register(email=variant, ip=f'10.0.2.{len(variant)}')['status'], 'exists', variant)
        self.assertEqual(first['status'], 'created')
        self.assertEqual(self._counts(), before)

    def test_an_email_that_is_only_the_email_field_of_another_user_is_taken_too(self):
        self.env['res.users'].create({'name': 'Odd', 'login': 'odd-login', 'email': 'odd.mail@example.com',
                                      'group_ids': [Command.set([self.env.ref('base.group_portal').id])]})
        self.assertEqual(self._register(email='odd.mail@example.com')['status'], 'exists')

    def test_the_database_itself_refuses_two_customers_with_one_login(self):
        self.assertEqual(self._register(email='dbcheck@example.com')['status'], 'created')
        with self.assertRaises(IntegrityError), mute_logger('odoo.sql_db'), self.env.cr.savepoint():
            self.env['res.users'].create({'name': 'Twin', 'login': 'DBCheck@Example.com', 'group_ids': [Command.set([self.env.ref('base.group_portal').id])]})

    def test_an_email_taken_at_the_same_moment_is_exists_and_leaves_nothing_behind(self):
        before = self._counts()
        with patch.object(type(self.env['res.users']), '_create_user_from_template', side_effect=SignupError('duplicate key')):
            self.assertEqual(self._register()['status'], 'exists')
        self.assertEqual(self._counts(), before)

    def test_registration_attempts_from_one_address_are_limited_and_others_are_not(self):
        for _ in range(10):
            self.assertEqual(self._register(ip='203.0.113.9')['status'], 'created')
        before = self._counts()
        blocked = self._register(ip='203.0.113.9')
        self.assertEqual(blocked['status'], 'throttled')
        self.assertTrue(0 < blocked['retry_after'] <= 60, blocked['retry_after'])
        self.assertEqual(self._counts(), before)
        self.assertEqual(self._register(ip='203.0.113.10')['status'], 'created')

    def test_the_service_user_has_no_right_to_create_users_or_read_sessions(self):
        env = self.env(user=self.api_user)
        with self.assertRaises(AccessError):
            env['res.users'].create({'name': 'x', 'login': 'x@example.com'})
        with self.assertRaises(AccessError):
            env['clothcraft.api.session'].search([])
        with self.assertRaises(AccessError):
            env['clothcraft.api.throttle'].search([])
        self.assertEqual(self._register()['status'], 'created')  # and the facade still works

    # ---- sign in
    def test_sign_in_with_the_right_password_starts_a_new_session_and_ends_the_one_it_replaces(self):
        user, email = self._customer()
        first = self._login(email)
        self.assertEqual((first['status'], first['user']['id'], first['user']['email']), ('ok', user.id, email))
        self.assertEqual(self._login(' ' + email.upper() + ' ')['status'], 'ok')  # the email is not case sensitive
        second = self._login(email, replace=first['sid'])
        self.assertNotEqual(first['sid'], second['sid'])
        self.assertFalse(self.api.auth_session({'sid_hash': first['sid']})['valid'])
        self.assertTrue(self.api.auth_session({'sid_hash': second['sid']})['valid'])

    def test_every_way_of_failing_looks_the_same(self):
        user, email = self._customer()
        staff = self.env['res.users'].create({'name': 'Staff', 'login': 'staff-shop@example.com', 'password': PASSWORD,
                                              'group_ids': [Command.set([self.env.ref('base.group_user').id])]})
        nopass = self.env['res.users'].create({'name': 'Nopass', 'login': 'nopass@example.com',
                                               'group_ids': [Command.set([self.env.ref('base.group_portal').id])]})
        gone = self.env['res.users'].create({'name': 'Gone', 'login': 'gone@example.com', 'password': PASSWORD,
                                             'group_ids': [Command.set([self.env.ref('base.group_portal').id])]})
        gone.active = False
        attempts = [(email, 'wrong password here'), ('nobody@example.com', PASSWORD), (email, ''), ('', PASSWORD),
                    (staff.login, PASSWORD), (nopass.login, PASSWORD), (nopass.login, ''), (gone.login, PASSWORD)]
        for n, (login, password) in enumerate(attempts):
            result = self._login(login, password, ip=f'10.0.3.{n}')
            self.assertEqual(result['status'], 'invalid_credentials', (login, password))
            self.assertNotIn('user', result)
        self.assertFalse(self._sessions().filtered(lambda s: s.user_id in (staff, nopass, gone)))

    def test_five_wrong_passwords_lock_that_email_and_the_lock_is_the_same_for_an_email_with_no_account(self):
        user, email = self._customer()
        for login in (email, 'nobody@example.com'):
            for _ in range(5):
                self.assertEqual(self._login(login, 'wrong password!', ip=f'10.0.4.{hash(login) % 200}')['status'], 'invalid_credentials')
            locked = self._login(login, PASSWORD, ip='10.0.4.250')
            self.assertEqual(locked['status'], 'throttled', login)
            self.assertTrue(0 < locked['retry_after'] <= 60)
        # a victim's email can be locked on purpose by anyone: that is the price of per-email counters (see backend/README.md)
        self.assertEqual(self._login(email, PASSWORD, ip='198.51.100.7')['status'], 'throttled')

    def test_a_lock_ends_after_its_time_and_the_next_one_is_twice_as_long(self):
        user, email = self._customer()
        for _ in range(5):
            self._login(email, 'wrong password!')
        self._t(59)
        self.assertEqual(self._login(email, PASSWORD)['status'], 'throttled')
        self._t(61)
        self.assertEqual(self._login(email, 'wrong password!')['status'], 'invalid_credentials')  # the 6th failure: locks for 120 s
        self._t(61 + 119)
        self.assertEqual(self._login(email, PASSWORD)['status'], 'throttled')
        self._t(61 + 121)
        self.assertEqual(self._login(email, PASSWORD)['status'], 'ok')
        self.assertEqual(self._login(email, PASSWORD)['status'], 'ok')  # the counter was reset by the success

    def test_old_failures_are_forgotten(self):
        user, email = self._customer()
        for _ in range(4):
            self._login(email, 'wrong password!')
        self._t(16 * 60)
        self.assertEqual(self._login(email, 'wrong password!')['status'], 'invalid_credentials')  # counts as the 1st again
        self.assertEqual(self._login(email, PASSWORD)['status'], 'ok')

    def test_twenty_failures_from_one_address_lock_that_address_for_every_email(self):
        users = [self._customer() for _ in range(5)]
        for n in range(20):
            self._login(users[n % 5][1], 'wrong password!', ip='192.0.2.55')
            # no single email reaches 5 here, only the address does
        result = self._login(users[0][1], PASSWORD, ip='192.0.2.55')
        self.assertEqual(result['status'], 'throttled')
        self.assertEqual(self._login(users[0][1], PASSWORD, ip='192.0.2.56')['status'], 'ok')

    def test_a_success_does_not_wipe_the_failures_counted_against_an_address(self):
        user, email = self._customer()
        for n in range(19):
            self._login(f'nobody{n}@example.com', 'wrong password!', ip='192.0.2.77')
            if n % 4 == 3:
                self._login(email, PASSWORD, ip='192.0.2.77')
        self._login('nobody2@example.com', 'wrong password!', ip='192.0.2.77')
        self.assertEqual(self._login(email, PASSWORD, ip='192.0.2.77')['status'], 'throttled')

    def test_two_step_verification_has_its_own_answer_and_is_not_counted_as_a_failure(self):
        user, email = self._customer()
        users = type(self.env['res.users'])
        with patch.object(users, '_mfa_type', lambda _self: 'totp'):
            for _ in range(8):
                self.assertEqual(self._login(email, PASSWORD)['status'], 'mfa_unsupported')
            self.assertFalse(self._sessions().filtered(lambda s: s.user_id == user))
            # a wrong password is still just a wrong password: nothing says the account has it
            self.assertEqual(self._login(email, 'wrong password!')['status'], 'invalid_credentials')
        self.assertEqual(self._login(email, PASSWORD)['status'], 'ok')  # 8 attempts did not lock anything

    # ---- sessions
    def test_a_session_ends_when_idle_for_8_hours_and_never_lasts_past_7_days(self):
        user, email = self._customer()
        sid = self._login(email)['sid']
        self._t(8 * 3600 - 5)
        self.assertTrue(self.api.auth_session({'sid_hash': sid})['valid'])      # touched: the idle clock restarts
        self._t(2 * 8 * 3600 - 10)
        self.assertTrue(self.api.auth_session({'sid_hash': sid})['valid'])
        self._t(2 * 8 * 3600 - 10 + 8 * 3600 + 5)
        self.assertFalse(self.api.auth_session({'sid_hash': sid})['valid'])     # idle too long

    def test_a_busy_session_still_ends_after_7_days(self):
        user, email = self._customer()
        sid = self._login(email)['sid']
        step = 6 * 3600
        for n in range(1, 7 * 4):
            self._t(n * step)
            self.assertTrue(self.api.auth_session({'sid_hash': sid})['valid'], n)
        self._t(7 * 24 * 3600 + 1)
        self.assertFalse(self.api.auth_session({'sid_hash': sid})['valid'])

    def test_remaining_is_the_sooner_of_the_idle_and_the_absolute_end(self):
        user, email = self._customer()
        sid = self._login(email)['sid']
        self.assertEqual(self.api.auth_session({'sid_hash': sid})['remaining'], 8 * 3600)
        for n in range(1, 28):   # a busy session: used every 6 hours
            self._t(n * 6 * 3600)
            self.api.auth_session({'sid_hash': sid})
        self._t(7 * 24 * 3600 - 3600)
        self.assertEqual(self.api.auth_session({'sid_hash': sid})['remaining'], 3600)

    def test_a_session_needs_a_customer_who_is_still_active(self):
        user, email = self._customer()
        sid = self._login(email)['sid']
        user.active = False
        self.assertFalse(self.api.auth_session({'sid_hash': sid})['valid'])
        user.active = True
        staff = self.env['res.users'].create({'name': 'Staff', 'login': 'staff-s@example.com', 'group_ids': [Command.set([self.env.ref('base.group_user').id])]})
        now = fields.Datetime.now()
        self.env['clothcraft.api.session'].sudo().create({'sid_hash': 'sid-staff', 'user_id': staff.id, 'last_seen': now, 'expires': now + timedelta(days=1)})
        self.assertFalse(self.api.auth_session({'sid_hash': 'sid-staff'})['valid'])

    def test_logout_ends_the_session_and_a_copy_of_the_cookie_is_dead(self):
        user, email = self._customer()
        sid = self._login(email)['sid']
        self.assertTrue(self.api.auth_logout({'sid_hash': sid})['revoked'])
        self.assertFalse(self.api.auth_logout({'sid_hash': sid})['revoked'])        # nothing left to end
        self.assertFalse(self.api.auth_session({'sid_hash': sid})['valid'])
        self.assertEqual(self.api.orders(sid), {**self.api.orders(sid), 'unauthorised': True})
        self.assertNotIn('valid', self.api.auth_logout({'sid_hash': 'sid-never-existed'}))

    def test_forged_or_unknown_session_ids_are_refused_by_every_order_method_and_write_nothing(self):
        before = (self.env['sale.order'].search_count([]), self.env['res.partner'].search_count([]))
        for sid in ('sid-forged', '', None):
            self.assertTrue(self.api.orders(sid)['unauthorised'])
            self.assertTrue(self.api.order(sid, 1)['unauthorised'])
            self.assertTrue(self.api.order_by_key(sid, 'k')['unauthorised'])
            placed = self.api.place_order({'sid_hash': sid, 'lines': [{'sku': 'X', 'quantity': 1}], 'delivery': {}, 'payment_method': 'cod', 'quoted_total': 1})
            self.assertEqual(placed['status'], 'unauthorised')
        self.assertEqual((self.env['sale.order'].search_count([]), self.env['res.partner'].search_count([])), before)

    def test_one_customer_cannot_read_anothers_order_with_their_own_session(self):
        a, email_a = self._customer()
        b, email_b = self._customer()
        sid_a, sid_b = self._login(email_a)['sid'], self._login(email_b)['sid']
        order = self.env['sale.order'].create({'partner_id': a.partner_id.id})
        order.state = 'sale'
        self.assertEqual([o['id'] for o in self.api.orders(sid_a)['orders']], [order.id])
        self.assertEqual(self.api.orders(sid_b)['orders'], [])
        self.assertTrue(self.api.order(sid_a, order.id)['found'])
        self.assertEqual(self.api.order(sid_b, order.id)['found'], False)

    def test_old_sessions_and_counters_are_cleaned_up_at_the_next_sign_in(self):
        user, email = self._customer()
        old = self._login(email)['sid']
        for _ in range(2):
            self._login('nobody@example.com', 'wrong password!', ip='192.0.2.99')
        self.assertEqual(self.env['clothcraft.api.throttle'].sudo().search_count([]), 2)  # the email counter and the address counter
        self._t(9 * 24 * 3600)
        self._login(email, PASSWORD, ip='192.0.2.100')
        self.assertFalse(self._sessions().filtered(lambda s: s.sid_hash == old))
        self.assertEqual(self.env['clothcraft.api.throttle'].sudo().search_count([]), 0)
