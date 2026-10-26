import uuid
from unittest.mock import patch

from psycopg2 import errors as pg_errors

from odoo import Command, fields
from odoo.exceptions import AccessError, UserError
from odoo.tests import tagged
from odoo.tools import mute_logger

from ..models.order_flow import BACK, NEXT
from .staff_common import DELIVERY, PASSWORD, StaffOrderCase


@tagged('post_install', '-at_install', 'clothcraft')
class TestStaffDashboard(StaffOrderCase):
    """The order state machine, the staff session and role, and the audit trail, called as the service user."""

    # ------------------------------------------------------------------ the state follows what Odoo knows
    def test_a_placed_order_starts_where_its_payment_says(self):
        self.assertEqual(self._place('cod').clothcraft_state, 'confirmed')
        self.assertEqual(self._place('bank_transfer').clothcraft_state, 'awaiting_payment')
        quotation = self.env['sale.order'].create({'partner_id': self.customer_user.partner_id.id})
        self.assertFalse(quotation.clothcraft_state)

    def test_a_delivery_validated_in_odoo_means_shipped_and_a_native_cancel_means_cancelled(self):
        # step 11 changed this rule: a validated delivery means the goods LEFT (shipped); delivered is now a step of its own
        order = self._place('cod')
        order.picking_ids.move_ids.picked = True
        order.picking_ids.with_context(skip_immediate=True, skip_backorder=True).button_validate()
        self.assertEqual(order.clothcraft_state, 'shipped')
        other = self._place('cod')
        other.with_context(disable_cancel_warning=True).action_cancel()
        self.assertEqual(other.clothcraft_state, 'cancelled')

    # ------------------------------------------------------------------ the whole way
    def test_a_bank_transfer_order_goes_all_the_way_and_every_step_does_its_native_work(self):
        order = self._place('bank_transfer')
        transaction = order.transaction_ids
        self.assertEqual((order.clothcraft_state, transaction.state, self._free(), self._on_hand()), ('awaiting_payment', 'pending', 199, 200))
        self.assertEqual(self._go(order, 'confirmed')['order']['stage'], 'confirmed')
        self.assertEqual((transaction.state, transaction.is_post_processed), ('done', True))
        self.assertEqual((self._free(), self._on_hand()), (199, 200))        # received and preparing: still in the building, still reserved
        shipped = self._go(order, 'shipped')
        self.assertEqual(shipped['order']['stage'], 'shipped')
        self.assertEqual({p.state for p in order.picking_ids}, {'done'})
        self.assertEqual((self._free(), self._on_hand()), (199, 199))        # shipped: the unit has left
        self.assertFalse(order.locked)
        on_the_way = self._go(order, 'out_for_delivery')
        self.assertEqual(on_the_way['order']['stage'], 'out_for_delivery')
        self.assertEqual((self._free(), self._on_hand(), order.locked), (199, 199, False))   # out for delivery: no stock effect
        delivered = self._go(order, 'delivered')
        self.assertEqual(delivered['order']['stage'], 'delivered')
        self.assertTrue(order.locked)
        self.assertEqual([(a.from_state, a.to_state, a.staff_name, a.via) for a in self._audit(order)],
                         [('awaiting_payment', 'confirmed', self.inventory.name, 'dashboard'), ('confirmed', 'shipped', self.inventory.name, 'dashboard'),
                          ('shipped', 'out_for_delivery', self.inventory.name, 'dashboard'), ('out_for_delivery', 'delivered', self.inventory.name, 'dashboard')])
        self.assertEqual(delivered['order']['allowed'], [])

    def test_a_cash_on_delivery_order_is_paid_only_when_it_is_delivered(self):
        order = self._place('cod')
        transaction = order.transaction_ids
        self._walk(order, 'shipped', 'out_for_delivery')
        self.assertEqual(transaction.state, 'pending')
        self.assertFalse(self.api.staff_order({'sid_hash': self.inventory_sid, 'order_id': order.id})['order']['paid'])
        self._walk(order, 'delivered')
        self.assertEqual((transaction.state, transaction.is_post_processed), ('done', True))
        self.assertTrue(self.api.staff_order({'sid_hash': self.inventory_sid, 'order_id': order.id})['order']['paid'])

    def test_the_customer_sees_each_status_and_when_but_never_who_or_the_note(self):
        order = self._place('bank_transfer')
        seen = []
        for to in ('confirmed', 'shipped', 'out_for_delivery', 'delivered'):
            self._t(60 * len(seen) + 60)
            self._go(order, to, note='a private note about this move')
            data = self.api.order(self.customer_sid, order.id)['order']
            seen.append((data['stage'], data['status_changed']))
            text = str(data)
            self.assertNotIn(self.inventory.name, text)
            self.assertNotIn('private note', text)
            self.assertNotIn('history', data)
        self.assertEqual([s for s, _ in seen], ['confirmed', 'shipped', 'out_for_delivery', 'delivered'])
        self.assertTrue(all(isinstance(at, str) and len(at) >= 23 for _s, at in seen))
        self.assertEqual([o['stage'] for o in self.api.orders(self.customer_sid)['orders']][:1], ['delivered'])

    # ------------------------------------------------------------------ the rules
    def test_every_move_that_is_not_in_the_table_is_refused_with_a_sentence_and_changes_nothing(self):
        states = ['awaiting_payment', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'closed', 'cancelled']
        for current in states:
            method = 'bank_transfer' if current == 'awaiting_payment' else 'cod'
            order = self._path_to(method, current)
            self.assertEqual(order.clothcraft_state, current)
            lines_before = len(self._audit(order))
            for to in states:
                if to in NEXT[current] or to == BACK.get(current):     # a step back is its own rule (tests/test_tracking.py)
                    continue
                result = self._go(order, to)
                self.assertEqual(result['status'], 'invalid_transition', (current, to))
                self.assertTrue(result['message'].endswith('.'), result['message'])
                self.assertEqual(order.clothcraft_state, current)
            self.assertEqual(len(self._audit(order)), lines_before)

    def test_the_sentences_say_what_is_wrong_and_what_is_possible(self):
        order = self._place('cod')
        self.assertEqual(self._go(order, 'out_for_delivery')['message'], "An order that is confirmed can't be moved to out for delivery. From confirmed it can go to shipped or cancelled.")
        self._walk(order, 'shipped')
        self.assertEqual(self._go(order, 'cancelled')['message'], "An order that is shipped can't be cancelled.")
        self._walk(order, 'out_for_delivery', 'delivered')
        self.assertEqual(self._go(order, 'cancelled')['message'], "This order is delivered. A delivered order can't be moved on or cancelled.")
        self.assertEqual(self._go(order, 'closed')['message'], "Only the customer closes an order, by confirming they received it; otherwise it closes by itself after delivery.")

    def test_a_move_the_staff_member_did_not_see_coming_is_a_conflict_that_names_who_got_there_first(self):
        order = self._place('cod')
        self.assertEqual(self._go(order, 'shipped', self.inventory_sid, expected='confirmed')['status'], 'done')
        late = self.api.staff_transition({'sid_hash': self.other_sid, 'order_id': order.id, 'to': 'shipped', 'expected_state': 'confirmed', 'note': ''})
        self.assertEqual((late['status'], late['current']), ('state_changed', 'shipped'))
        self.assertIn(self.inventory.name, late['message'])
        self.assertIn('Nothing was done', late['message'])
        self.assertEqual(late['order']['stage'], 'shipped')
        self.assertEqual(len(self._audit(order)), 1)          # one change, one line

    def test_bad_fields_are_refused_before_anything_is_touched(self):
        order = self._place('cod')
        for payload in ({'to': 'flying', 'expected_state': 'confirmed'}, {'to': 'shipped', 'expected_state': 'nope'}):
            result = self.api.staff_transition({'sid_hash': self.inventory_sid, 'order_id': order.id, 'note': '', **payload})
            self.assertEqual((result['status'], list(result['fields'])), ('invalid', ['to']))
        long = self._go(order, 'shipped', note='x' * 501)
        self.assertEqual((long['status'], list(long['fields'])), ('invalid', ['note']))
        self.assertEqual(order.clothcraft_state, 'confirmed')
        self.assertEqual(self.api.staff_transition({'sid_hash': self.inventory_sid, 'order_id': 999999999, 'to': 'shipped', 'expected_state': 'confirmed'})['status'], 'not_found')
        self.assertEqual(self.api.staff_transition({'sid_hash': self.inventory_sid, 'order_id': 'abc', 'to': 'shipped', 'expected_state': 'confirmed'})['status'], 'not_found')
        quotation = self.env['sale.order'].create({'partner_id': self.customer_user.partner_id.id})
        self.assertEqual(self.api.staff_order({'sid_hash': self.inventory_sid, 'order_id': quotation.id})['status'], 'not_found')

    def test_the_note_is_trimmed_and_kept(self):
        order = self._place('cod')
        self._go(order, 'shipped', note='  two boxes, fragile  ')
        self.assertEqual(self._audit(order).note, 'two boxes, fragile')

    # ------------------------------------------------------------------ cancel and stock
    def test_cancelling_before_packing_gives_the_unit_back_and_cancels_an_unpaid_payment(self):
        order = self._place('bank_transfer')
        self.assertEqual(self._free(), 199)
        result = self._go(order, 'cancelled', note='customer asked')
        self.assertEqual(result['status'], 'done')
        self.assertEqual((order.state, order.clothcraft_state, order.transaction_ids.state), ('cancel', 'cancelled', 'cancel'))
        self.assertEqual((self._free(), self._on_hand()), (200, 200))
        self.assertEqual(self._audit(order).note, 'customer asked')

    def test_an_order_packed_before_step_11_reads_as_step_1_and_cancelling_it_gives_the_unit_back_too(self):
        order = self._place('cod')
        order.picking_ids.move_ids.picked = True
        order.sudo().clothcraft_state = 'packed'          # as step 7 left it (the migration moves these to confirmed)
        self.assertEqual(self.api.order(self.customer_sid, order.id)['order']['tracking']['current'], 'received')
        self.assertEqual([a['to'] for a in self.api.staff_order({'sid_hash': self.inventory_sid, 'order_id': order.id})['order']['allowed']], ['shipped', 'cancelled'])
        self._walk(order, 'cancelled')
        self.assertEqual((self._free(), self._on_hand(), {p.state for p in order.picking_ids}), (200, 200, {'cancel'}))

    def test_a_shipped_order_cannot_be_cancelled_and_neither_can_one_whose_delivery_left_in_odoo(self):
        order = self._place('cod')
        self._walk(order, 'shipped')
        self.assertEqual(self._go(order, 'cancelled')['status'], 'invalid_transition')
        self.assertEqual(self._on_hand(), 199)
        native = self._place('cod')
        native.picking_ids.move_ids.picked = True
        native.picking_ids.with_context(skip_immediate=True, skip_backorder=True).button_validate()
        self.assertEqual(self._go(native, 'cancelled')['status'], 'invalid_transition')
        with self.assertRaises(UserError):     # the model itself refuses too, whoever calls it
            native.sudo().with_context(clothcraft_dashboard=True)._clothcraft_move('cancelled', self.inventory)

    def test_only_an_administrator_cancels_a_paid_bank_order_and_must_say_why(self):
        order = self._place('bank_transfer')
        self._walk(order, 'confirmed')
        actions = self.api.staff_order({'sid_hash': self.inventory_sid, 'order_id': order.id})['order']
        self.assertNotIn('cancelled', [a['to'] for a in actions['allowed']])
        self.assertEqual([(b['to'], b['reason']) for b in actions['blocked']], [('cancelled', 'Only an Administrator can cancel an order that has been paid.')])
        refused = self._go(order, 'cancelled', self.inventory_sid, note='please')
        self.assertEqual((refused['status'], refused['message']), ('forbidden', 'Only an Administrator can cancel an order that has been paid.'))
        self.assertEqual(order.clothcraft_state, 'confirmed')
        allowed = self.api.staff_order({'sid_hash': self.admin_sid, 'order_id': order.id})['order']
        self.assertEqual([(a['to'], a['needs_note']) for a in allowed['allowed'] if a['to'] == 'cancelled'], [('cancelled', True)])
        no_note = self._go(order, 'cancelled', self.admin_sid)
        self.assertEqual((no_note['status'], list(no_note['fields'])), ('invalid', ['note']))
        done = self._go(order, 'cancelled', self.admin_sid, note='customer changed their mind; Maria will refund')
        self.assertEqual(done['status'], 'done')
        audit = self._audit(order)[-1]
        self.assertTrue(audit.note.startswith('REFUND DUE. customer changed'), audit.note)
        self.assertEqual((audit.staff_name, order.transaction_ids.state, self._free()), (self.admin.name, 'done', 200))   # the money was received: it stays on record

    def test_inventory_staff_cancel_unpaid_and_cash_on_delivery_orders(self):
        for method in ('bank_transfer', 'cod'):
            order = self._place(method)
            self.assertEqual(self._go(order, 'cancelled', self.inventory_sid)['status'], 'done')
            self.assertFalse(self._audit(order).note)     # no refund due: nothing was paid

    def test_a_delivery_odoo_cannot_validate_is_refused_with_nothing_changed(self):
        order = self._place('cod')
        order.picking_ids.move_ids.picked = False
        order.picking_ids.do_unreserve()
        refused = self._go(order, 'shipped')
        self.assertEqual(refused['status'], 'refused')
        self.assertIn('not all reserved', refused['message'])
        self.assertEqual((order.clothcraft_state, len(self._audit(order))), ('confirmed', 0))
        self.assertNotIn('done', {p.state for p in order.picking_ids})

    # ------------------------------------------------------------------ who may
    def test_every_staff_method_refuses_a_customer_session_and_a_forged_one(self):
        order = self._place('cod')
        calls = [
            lambda sid: self.api.staff_session({'sid_hash': sid})['valid'] is False,
            lambda sid: self.api.staff_orders({'sid_hash': sid})['status'] == 'unauthorised',
            lambda sid: self.api.staff_order({'sid_hash': sid, 'order_id': order.id})['status'] == 'unauthorised',
            lambda sid: self.api.staff_transition({'sid_hash': sid, 'order_id': order.id, 'to': 'packed', 'expected_state': 'confirmed'})['status'] == 'unauthorised',
        ]
        for sid in (self.customer_sid, 'sid-forged', '', None):
            for call in calls:
                self.assertTrue(call(sid), sid)
        self.assertEqual(order.clothcraft_state, 'confirmed')
        self.assertFalse(self.api.staff_logout({'sid_hash': self.customer_sid})['revoked'])     # signing out as staff cannot end a customer session
        self.assertTrue(self.api.auth_session({'sid_hash': self.customer_sid})['valid'])

    def test_a_staff_session_opens_no_customer_method(self):
        self.assertFalse(self.api.auth_session({'sid_hash': self.inventory_sid})['valid'])
        self.assertTrue(self.api.orders(self.inventory_sid)['unauthorised'])
        self.assertTrue(self.api.order(self.inventory_sid, 1)['unauthorised'])
        placed = self.api.place_order({'sid_hash': self.admin_sid, 'lines': [{'sku': self.variant.default_code, 'quantity': 1}], 'delivery': dict(DELIVERY), 'payment_method': 'cod', 'quoted_total': 350.0})
        self.assertEqual(placed['status'], 'unauthorised')
        self.assertFalse(self.api.auth_logout({'sid_hash': self.inventory_sid})['revoked'])

    def test_staff_who_lose_the_role_are_cut_off_at_once_whatever_session_they_hold(self):
        order = self._place('cod')
        self.assertTrue(self.api.staff_session({'sid_hash': self.other_sid})['valid'])
        self.other.write({'group_ids': [Command.unlink(self.env.ref('clothcraft.group_inventory').id)]})
        self.assertFalse(self.api.staff_session({'sid_hash': self.other_sid})['valid'])
        self.assertEqual(self._go(order, 'packed', self.other_sid)['status'], 'unauthorised')
        self.other.write({'group_ids': [Command.link(self.env.ref('clothcraft.group_inventory').id)]})
        self.assertTrue(self.api.staff_session({'sid_hash': self.other_sid})['valid'])
        self.other.active = False
        self.assertFalse(self.api.staff_session({'sid_hash': self.other_sid})['valid'])

    def test_staff_sign_in_needs_an_internal_user_in_a_staff_group_and_every_other_failure_looks_the_same(self):
        def login(email, password=PASSWORD, ip='10.2.0.1'):
            return self.api.staff_login({'email': email, 'password': password, 'sid_hash': f'sid-{uuid.uuid4().hex}', 'client_ip': ip, 'replace_sid_hash': None})

        ok = login(self.inventory.login)
        self.assertEqual((ok['status'], ok['user']['role'], ok['remaining']), ('ok', 'inventory', 2 * 3600))
        self.assertEqual(login(self.admin.login)['user']['role'], 'admin')
        plain = self.env['res.users'].create({'name': 'Plain', 'login': 'plain-staff@example.com', 'password': PASSWORD, 'group_ids': [Command.set([self.env.ref('base.group_user').id])]})
        for n, (who, password) in enumerate([(self.customer_user.login, PASSWORD), (plain.login, PASSWORD), (self.inventory.login, 'wrong password!!'),
                                             ('nobody@example.com', PASSWORD), ('', PASSWORD), (self.inventory.login, '')]):
            result = login(who, password, ip=f'10.2.1.{n}')
            self.assertEqual(result['status'], 'invalid_credentials', (who, password))
            self.assertNotIn('user', result)
        # and the other way round: a staff account is not a customer
        customer_try = self.api.auth_login({'email': self.inventory.login, 'password': PASSWORD, 'sid_hash': 'sid-x', 'client_ip': '10.2.2.2'})
        self.assertEqual(customer_try['status'], 'invalid_credentials')

    def test_staff_sign_in_has_its_own_throttle_and_two_step_accounts_get_their_own_answer(self):
        for _ in range(5):
            self.api.staff_login({'email': self.inventory.login, 'password': 'wrong password!!', 'sid_hash': 'sid-t', 'client_ip': '10.3.0.1'})
        locked = self.api.staff_login({'email': self.inventory.login, 'password': PASSWORD, 'sid_hash': 'sid-t2', 'client_ip': '10.3.0.2'})
        self.assertEqual(locked['status'], 'throttled')
        self.assertTrue(0 < locked['retry_after'] <= 60)
        # the customer-side counters are a different set: the same person is not locked out of the shop by this
        other_customer = self.api.auth_login({'email': self.customer_user.login, 'password': PASSWORD, 'sid_hash': 'sid-c', 'client_ip': '10.3.0.3'})
        self.assertEqual(other_customer['status'], 'ok')
        self._t(61)
        self.assertEqual(self.api.staff_login({'email': self.admin.login, 'password': PASSWORD, 'sid_hash': 'sid-a', 'client_ip': '10.3.0.4'})['status'], 'ok')
        with patch.object(type(self.env['res.users']), '_mfa_type', lambda _self: 'totp'):
            for n in range(8):
                self.assertEqual(self.api.staff_login({'email': self.admin.login, 'password': PASSWORD, 'sid_hash': f'sid-m{n}', 'client_ip': '10.3.0.5'})['status'], 'mfa_unsupported')

    def test_a_staff_session_lasts_two_hours_idle_and_twelve_absolute_and_logout_ends_it(self):
        sid = 'sid-life'
        self.api.staff_login({'email': self.inventory.login, 'password': PASSWORD, 'sid_hash': sid, 'client_ip': '10.4.0.1', 'replace_sid_hash': None})
        self._t(2 * 3600 - 5)
        self.assertTrue(self.api.staff_session({'sid_hash': sid})['valid'])
        self._t(2 * 3600 - 5 + 2 * 3600 + 5)
        self.assertFalse(self.api.staff_session({'sid_hash': sid})['valid'])
        sid2 = 'sid-life2'
        self._t(0)
        self.api.staff_login({'email': self.inventory.login, 'password': PASSWORD, 'sid_hash': sid2, 'client_ip': '10.4.0.2', 'replace_sid_hash': None})
        for n in range(1, 12 * 2):
            self._t(n * 1800)
            self.assertTrue(self.api.staff_session({'sid_hash': sid2})['valid'], n)
        self._t(12 * 3600 + 1)
        self.assertFalse(self.api.staff_session({'sid_hash': sid2})['valid'])
        sid3 = 'sid-life3'
        self._t(0)
        self.api.staff_login({'email': self.inventory.login, 'password': PASSWORD, 'sid_hash': sid3, 'client_ip': '10.4.0.3', 'replace_sid_hash': sid})
        self.assertTrue(self.api.staff_logout({'sid_hash': sid3})['revoked'])
        self.assertFalse(self.api.staff_session({'sid_hash': sid3})['valid'])

    # ------------------------------------------------------------------ the audit trail
    def test_the_audit_trail_cannot_be_changed_or_deleted_by_anyone_in_any_way(self):
        order = self._place('cod')
        self._walk(order, 'shipped')
        line = self._audit(order)
        with self.assertRaises(UserError):
            line.write({'note': 'edited'})
        with self.assertRaises(UserError):
            line.unlink()
        for who in (self.inventory, self.admin, self.api_user):          # no access line allows more than reading
            with self.assertRaises(UserError):      # (AccessError is one) the model refuses first; without that, the access list would
                line.with_user(who).write({'note': 'edited'})
            with self.assertRaises(AccessError):
                self.env['clothcraft.order.audit'].with_user(who).create({'order_id': order.id, 'staff_name': 'x', 'from_state': 'confirmed', 'to_state': 'packed'})
        self.assertTrue(self._audit(order).with_user(self.inventory).read(['note']))     # staff can read it
        with self.assertRaises(AccessError):
            self._audit(order).with_user(self.api_user).read(['note'])                   # the service user cannot, it goes through the facade
        for sql in ("UPDATE clothcraft_order_audit SET note = 'edited' WHERE order_id = %s", "DELETE FROM clothcraft_order_audit WHERE order_id = %s"):
            with self.assertRaises(pg_errors.RaiseException), mute_logger('odoo.sql_db'), self.env.cr.savepoint():
                self.env.cr.execute(sql, [order.id])
        self.assertEqual(len(self._audit(order)), 1)

    def test_a_line_goes_with_its_order_which_is_what_a_purge_does(self):
        order = self.env['sale.order'].create({'partner_id': self.customer_user.partner_id.id})
        order.write({'state': 'cancel'})
        order._clothcraft_audit('confirmed', 'cancelled', self.inventory, None)
        self.assertEqual(len(self._audit(order)), 1)
        order_id = order.id
        order.unlink()                                                     # a cancelled order may be deleted: its lines follow
        self.env.cr.execute('SELECT count(*) FROM clothcraft_order_audit WHERE order_id = %s', [order_id])
        self.assertEqual(self.env.cr.fetchone()[0], 0)

    # ------------------------------------------------------------------ drift: what the Odoo screens do
    def test_a_delivery_validated_in_odoo_is_written_in_the_history_as_odoo_and_the_dashboard_adds_no_second_line(self):
        order = self._place('cod')
        order.picking_ids.move_ids.picked = True
        order.picking_ids.with_context(skip_immediate=True, skip_backorder=True).button_validate()
        line = self._audit(order)
        self.assertEqual([(a.from_state, a.to_state, a.via, a.staff_id, a.actor_type) for a in line], [('confirmed', 'shipped', 'odoo', self.env.user, 'odoo')])
        done = self._place('cod')
        self._walk(done, 'shipped', 'out_for_delivery')
        self.assertEqual([a.via for a in self._audit(done)], ['dashboard', 'dashboard'])

    def test_a_cancel_in_odoo_is_written_as_odoo_and_the_simulation_leaves_no_lines_at_all(self):
        order = self._place('cod')
        order.with_context(disable_cancel_warning=True).action_cancel()
        self.assertEqual([(a.from_state, a.to_state, a.via) for a in self._audit(order)], [('confirmed', 'cancelled', 'odoo')])
        quiet = self._place('cod')
        quiet = quiet.with_context(tracking_disable=True)
        quiet.picking_ids.move_ids.picked = True
        quiet.picking_ids.with_context(skip_immediate=True, skip_backorder=True).button_validate()
        self.assertEqual(quiet.clothcraft_state, 'shipped')              # the state still follows (step 11: a validated delivery is shipped)
        self.assertFalse(self._audit(quiet))                              # but no line stamped with the real clock
        silent = self._place('bank_transfer').with_context(tracking_disable=True)
        silent.with_context(disable_cancel_warning=True).action_cancel()
        self.assertEqual(silent.clothcraft_state, 'cancelled')
        self.assertFalse(self._audit(silent))

    # ------------------------------------------------------------------ the list and the detail
    def test_the_list_filters_searches_and_pages(self):
        cod = self._place('cod')
        bank = self._place('bank_transfer')
        moved = self._place('cod')
        self._walk(moved, 'shipped')

        def listing(**kw):
            return self.api.staff_orders({'sid_hash': self.inventory_sid, **kw})

        ids = lambda result: [o['id'] for o in result['orders']]  # noqa: E731
        everything = listing(page_size=100)
        self.assertEqual(ids(everything)[:3], [moved.id, bank.id, cod.id])              # newest first
        self.assertEqual(everything['total'], self.env['sale.order'].search_count([('state', 'in', ('sale', 'cancel'))]))
        self.assertEqual(ids(listing(states=['awaiting_payment']))[:1], [bank.id])
        self.assertEqual({o['stage'] for o in listing(states=['shipped'], page_size=100)['orders']}, {'shipped'})
        self.assertIn(moved.id, ids(listing(states=['shipped'], page_size=100)))
        self.assertIn(bank.id, ids(listing(method='bank_transfer', page_size=100)))
        self.assertNotIn(bank.id, ids(listing(method='cod', page_size=100)))
        self.assertEqual(ids(listing(q=cod.name))[:1], [cod.id])
        self.assertIn(cod.id, ids(listing(q=cod.name[1:].lower(), page_size=100)))     # part of the reference, any case
        self.assertIn(cod.id, ids(listing(q=self.customer_user.partner_id.email.upper(), page_size=100)))
        self.assertEqual(listing(q='%')['orders'], [])                                    # a wildcard is just text
        today = fields.Date.today().isoformat()
        self.assertIn(cod.id, ids(listing(date_from=today, date_to=today, page_size=100)))
        self.assertEqual(listing(date_from='2999-01-01')['orders'], [])
        self.assertEqual(listing(date_from='01/02/2026')['status'], 'invalid')
        first, second = listing(page=1, page_size=2), listing(page=2, page_size=2)
        self.assertEqual((len(first['orders']), first['page'], first['page_size']), (2, 1, 2))
        self.assertTrue(set(ids(first)).isdisjoint(ids(second)))
        self.assertEqual(listing(page_size=100000)['page_size'], 100)
        self.assertEqual((listing(page_size=0)['page_size'], listing(page_size=-5)['page_size']), (25, 1))
        summary = listing(q=bank.name)['orders'][0]
        self.assertEqual((summary['name'], summary['stage'], summary['payment_method'], summary['paid'], summary['customer_email'], summary['items'], summary['amount_total']),
                         (bank.name, 'awaiting_payment', 'bank_transfer', False, self.customer_user.partner_id.email, 1, 350.0))

    def test_the_detail_has_the_customer_the_history_and_only_what_this_role_may_do(self):
        order = self._place('cod')
        fresh = self.api.staff_order({'sid_hash': self.admin_sid, 'order_id': order.id})['order']
        self.assertEqual([a['to'] for a in fresh['allowed']], ['shipped', 'cancelled'])
        self.assertEqual(fresh['allowed'][1]['confirm'], True)
        self.assertEqual(fresh['allowed'][0]['label'], 'Mark as shipped')
        self.assertEqual(fresh['blocked'], [])
        self._walk(order, 'shipped', note='two boxes')
        detail = self.api.staff_order({'sid_hash': self.admin_sid, 'order_id': order.id})['order']
        self.assertEqual(detail['customer']['email'], self.customer_user.partner_id.email)
        # the account has no phone of its own; staff are shown the one given for the delivery, so the card is never empty when a number exists
        self.assertFalse(self.customer_user.partner_id.phone)
        self.assertEqual(detail['customer']['phone'], DELIVERY['phone'])
        self.assertEqual([(h['from'], h['to'], h['staff'], h['note'], h['via']) for h in detail['history']], [('confirmed', 'shipped', self.inventory.name, 'two boxes', 'dashboard')])
        self.assertEqual([a['to'] for a in detail['allowed']], ['out_for_delivery'])
        self.assertIn('lines', detail)
        self.assertEqual(detail['allowed'][0]['label'], 'Mark as out for delivery')
        self._walk(order, 'out_for_delivery')
        self.assertEqual(self.api.staff_order({'sid_hash': self.admin_sid, 'order_id': order.id})['order']['allowed'][0]['label'], 'Mark as delivered (cash collected)')

    def test_the_service_user_itself_still_cannot_write_orders_or_pickings(self):
        order = self._place('cod')
        env = self.env(user=self.api_user)
        with self.assertRaises(AccessError):
            order.with_user(self.api_user).write({'clothcraft_state': 'delivered'})
        with self.assertRaises(AccessError):
            env['stock.picking'].search([])
        with self.assertRaises(AccessError):
            env['payment.transaction'].search([])
