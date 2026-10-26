"""Step 11: what the customer sees of their order's progress, their "I received my order", an Administrator's step back, who did what
in the history (staff, customer, automatic, Odoo), the automatic close, and the migration to 19.0.1.3.0."""
import datetime
import importlib.util
from pathlib import Path
from unittest.mock import patch

from psycopg2 import errors as pg_errors

from odoo.exceptions import UserError, ValidationError
from odoo.tests import tagged
from odoo.tools import mute_logger

from .staff_common import StaffOrderCase


@tagged('post_install', '-at_install', 'clothcraft')
class TestOrderTracking(StaffOrderCase):

    def _tracking(self, order, sid=None):
        return self.api.order(sid or self.customer_sid, order.id)['order']['tracking']

    def _confirm(self, order, sid=None):
        return self.api.order_confirm_received({'sid_hash': sid or self.customer_sid, 'order_id': order.id})

    def _delivered(self, method='cod'):
        return self._path_to(method, 'delivered')

    # ------------------------------------------------------------------ what the customer sees
    def test_the_customer_sees_the_four_steps_with_times_and_never_who_or_a_note(self):
        order = self._place('cod')
        seen = [self._tracking(order)]
        for to in ('shipped', 'out_for_delivery', 'delivered'):
            self._go(order, to, note='a private note about this move')
            seen.append(self._tracking(order))
        self.assertEqual([t['current'] for t in seen], ['received', 'shipped', 'on_delivery', 'delivered'])
        for index, tracking in enumerate(seen):
            self.assertEqual([s['step'] for s in tracking['steps']], ['received', 'shipped', 'on_delivery', 'delivered'])
            reached = [s['reached_at'] for s in tracking['steps']]
            self.assertTrue(all(isinstance(at, str) and len(at) >= 23 for at in reached[:index + 1]), reached)    # every step up to now has its time
            self.assertEqual(reached[index + 1:], [None] * (3 - index))                                             # the steps to come have none
        self.assertEqual((seen[-1]['can_confirm'], seen[2]['can_confirm'], seen[-1]['awaiting_payment']), (True, False, False))
        customer_view = str(self.api.order(self.customer_sid, order.id)['order'])
        self.assertNotIn(self.inventory.name, customer_view)
        self.assertNotIn('private note', customer_view)

    def test_a_bank_transfer_waits_for_payment_before_step_one(self):
        order = self._place('bank_transfer')
        waiting = self._tracking(order)
        self.assertEqual((waiting['current'], waiting['awaiting_payment'], [s['reached_at'] for s in waiting['steps']]), (None, True, [None] * 4))
        self._walk(order, 'confirmed')
        paid = self._tracking(order)
        self.assertEqual((paid['current'], paid['awaiting_payment']), ('received', False))
        self.assertTrue(paid['steps'][0]['reached_at'])

    def test_a_cancelled_order_has_no_current_step(self):
        order = self._place('cod')
        self._walk(order, 'cancelled')
        tracking = self._tracking(order)
        self.assertEqual((tracking['current'], tracking['can_confirm'], tracking['closed_at']), (None, False, None))

    # ------------------------------------------------------------------ the customer confirms
    def test_the_customer_confirms_receipt_which_closes_the_order_and_is_written_down_as_theirs(self):
        order = self._delivered()
        transaction, locked = order.transaction_ids, order.locked
        result = self._confirm(order)
        self.assertEqual((result['status'], result['replayed'], result['order']['stage']), ('ok', False, 'closed'))
        tracking = result['order']['tracking']
        self.assertEqual((tracking['current'], tracking['closed_by'], tracking['can_confirm']), ('delivered', 'customer', False))
        self.assertTrue(tracking['closed_at'])
        line = self._audit(order)[-1]
        self.assertEqual((line.from_state, line.to_state, line.actor_type, line.via, line.partner_id, line.partner_name, line.staff_id, line.staff_name),
                         ('delivered', 'closed', 'customer', 'shop', self.customer_user.partner_id, self.customer_user.partner_id.name, self.env['res.users'], False))
        self.assertEqual((transaction.state, order.locked), ('done', locked))        # the cash was recorded and the order locked at delivered
        staff_view = self.api.staff_order({'sid_hash': self.inventory_sid, 'order_id': order.id})['order']
        self.assertEqual((staff_view['history'][-1]['actor'], staff_view['history'][-1]['staff'], staff_view['allowed']), ('customer', self.customer_user.partner_id.name, []))

    def test_confirming_again_is_the_same_answer_and_writes_nothing_new(self):
        order = self._delivered()
        first = self._confirm(order)
        lines = len(self._audit(order))
        again = self._confirm(order)
        self.assertEqual((again['status'], again['replayed'], again['order']['tracking']['closed_at']), ('ok', True, first['order']['tracking']['closed_at']))
        self.assertEqual(len(self._audit(order)), lines)

    def test_only_the_owner_and_only_once_delivered(self):
        order = self._place('cod')
        early = self._confirm(order)
        self.assertEqual((early['status'], early['current']), ('invalid_transition', 'confirmed'))
        self.assertEqual(early['message'], "This order is confirmed. You can confirm you received it once it has been delivered.")
        self._walk(order, 'shipped', 'out_for_delivery')
        self.assertEqual(self._confirm(order)['status'], 'invalid_transition')
        self._walk(order, 'delivered')
        stranger, stranger_sid = self._person(f'stranger-{self.tag}', [self.env.ref('base.group_portal')], 'customer')
        self.assertEqual(self._confirm(order, stranger_sid)['status'], 'not_found')        # another customer's order gives nothing away
        for sid in (self.inventory_sid, self.admin_sid, 'sid-forged', '', None):       # a staff session is not a customer session
            self.assertEqual(self.api.order_confirm_received({'sid_hash': sid, 'order_id': order.id})['status'], 'unauthorised', sid)
        self.assertEqual(self.api.order_confirm_received({'sid_hash': self.customer_sid, 'order_id': 'abc'})['status'], 'not_found')
        self.assertEqual(self.api.order_confirm_received({'sid_hash': self.customer_sid, 'order_id': 999999999})['status'], 'not_found')
        self.assertEqual(order.clothcraft_state, 'delivered')
        cancelled = self._place('cod')
        self._walk(cancelled, 'cancelled')
        self.assertEqual(self._confirm(cancelled)['status'], 'invalid_transition')

    def test_staff_cannot_close_an_order(self):
        order = self._delivered()
        for sid in (self.inventory_sid, self.admin_sid):
            refused = self._go(order, 'closed', sid)
            self.assertEqual(refused['status'], 'invalid_transition')
        self.assertEqual(order.clothcraft_state, 'delivered')

    # ------------------------------------------------------------------ an Administrator steps back
    def test_an_administrator_steps_back_one_step_with_a_note_and_inventory_staff_cannot(self):
        order = self._place('bank_transfer')
        self._walk(order, 'confirmed', 'shipped', 'out_for_delivery')
        inventory_view = self.api.staff_order({'sid_hash': self.inventory_sid, 'order_id': order.id})['order']
        self.assertEqual([(a['to'], a['direction']) for a in inventory_view['allowed']], [('delivered', 'forward')])     # no step back offered
        self.assertEqual(self._go(order, 'shipped', self.inventory_sid, note='wrong button')['status'], 'forbidden')
        admin_view = self.api.staff_order({'sid_hash': self.admin_sid, 'order_id': order.id})['order']
        self.assertEqual([(a['to'], a['direction'], a['needs_note'], a['label']) for a in admin_view['allowed']],
                         [('delivered', 'forward', False, 'Mark as delivered'), ('shipped', 'back', True, 'Step back to shipped')])
        no_note = self._go(order, 'shipped', self.admin_sid)
        self.assertEqual((no_note['status'], no_note['fields']), ('invalid', {'note': 'Write a short note: say why the order is stepped back.'}))
        done = self._go(order, 'shipped', self.admin_sid, note='courier has not picked it up')
        self.assertEqual((done['status'], order.clothcraft_state), ('done', 'shipped'))
        line = self._audit(order)[-1]
        self.assertEqual((line.from_state, line.to_state, line.step_back, line.actor_type, line.staff_name, line.note),
                         ('out_for_delivery', 'shipped', True, 'staff', self.admin.name, 'courier has not picked it up'))
        self.assertEqual(self._tracking(order)['current'], 'shipped')
        self.assertEqual(self._tracking(order)['steps'][2]['reached_at'], None)     # stepped back from: no longer reached
        self.assertEqual(self._go(order, 'confirmed', self.admin_sid, note='try further back')['status'], 'invalid_transition')   # the goods left

    def test_a_delivered_bank_order_steps_back_but_a_cash_on_delivery_one_keeps_its_collected_cash(self):
        bank = self._delivered('bank_transfer')
        self.assertEqual(self._go(bank, 'out_for_delivery', self.admin_sid, note='marked too early')['status'], 'done')
        cod = self._delivered('cod')
        refused = self._go(cod, 'out_for_delivery', self.admin_sid, note='marked too early')
        self.assertEqual((refused['status'], cod.clothcraft_state, cod.transaction_ids.state), ('invalid_transition', 'delivered', 'done'))
        admin_view = self.api.staff_order({'sid_hash': self.admin_sid, 'order_id': cod.id})['order']
        self.assertEqual([b['to'] for b in admin_view['blocked']], ['out_for_delivery'])

    def test_a_closed_order_steps_back_to_delivered_and_the_customer_can_confirm_again(self):
        order = self._delivered()
        self._confirm(order)
        self.assertEqual(self._go(order, 'delivered', self.admin_sid, note='customer pressed it by mistake')['status'], 'done')
        self.assertEqual((order.clothcraft_state, self._tracking(order)['can_confirm']), ('delivered', True))
        self.assertEqual(self._confirm(order)['replayed'], False)

    # ------------------------------------------------------------------ who: the kinds are kept apart
    def test_the_history_never_mixes_a_customer_with_a_staff_member(self):
        order = self._delivered()
        Audit = self.env['clothcraft.order.audit'].sudo()
        bad = [
            {'actor_type': 'customer', 'partner_id': self.customer_user.partner_id.id, 'staff_name': self.inventory.name},
            {'actor_type': 'customer', 'partner_id': self.customer_user.partner_id.id, 'staff_id': self.inventory.id},
            {'actor_type': 'customer'},
            {'actor_type': 'staff', 'staff_name': self.inventory.name, 'partner_id': self.customer_user.partner_id.id},
            {'actor_type': 'automatic', 'partner_id': self.customer_user.partner_id.id},
            {'actor_type': 'automatic', 'staff_name': 'someone'},
        ]
        for vals in bad:
            with self.subTest(vals=vals), self.assertRaises(pg_errors.CheckViolation), mute_logger('odoo.sql_db'), self.env.cr.savepoint():
                Audit.create({'order_id': order.id, 'from_state': 'delivered', 'to_state': 'closed', **vals})
        with self.assertRaises(UserError):        # a staff line must name the staff member (the model says so before the database does)
            Audit.create({'order_id': order.id, 'from_state': 'delivered', 'to_state': 'closed', 'actor_type': 'staff'})

    # ------------------------------------------------------------------ the automatic close
    def _close_days(self, value):
        self.env['ir.config_parameter'].sudo().set_param('clothcraft.auto_close_days', value)

    def test_the_daily_job_closes_a_delivered_order_after_seven_days_by_default(self):
        self.env['ir.config_parameter'].sudo().search([('key', '=', 'clothcraft.auto_close_days')]).unlink()
        order = self._delivered()
        delivered_at = self._audit(order)[-1].create_date
        SaleOrder = self.env['sale.order']
        self.assertEqual(SaleOrder._cron_clothcraft_auto_close(now=delivered_at + datetime.timedelta(days=6, hours=23)), 0)
        self.assertEqual(order.clothcraft_state, 'delivered')
        self.assertEqual(SaleOrder._cron_clothcraft_auto_close(now=delivered_at + datetime.timedelta(days=7)), 1)
        self.assertEqual(order.clothcraft_state, 'closed')
        line = self._audit(order)[-1]
        self.assertEqual((line.actor_type, line.via, line.staff_id, line.partner_id, line.staff_name), ('automatic', 'cron', self.env['res.users'], self.env['res.partner'], False))
        self.assertEqual(self._tracking(order)['closed_by'], 'automatic')
        self.assertEqual(self._confirm(order)['replayed'], True)          # the customer pressing afterwards changes nothing
        self.assertEqual(SaleOrder._cron_clothcraft_auto_close(now=delivered_at + datetime.timedelta(days=30)), 0)

    def test_the_daily_job_follows_the_setting_and_zero_turns_it_off(self):
        order = self._delivered()
        later = self._audit(order)[-1].create_date + datetime.timedelta(days=3)
        self._close_days('0')
        self.assertEqual(self.env['sale.order']._cron_clothcraft_auto_close(now=later + datetime.timedelta(days=400)), 0)
        self._close_days('3')
        self.assertEqual(self.env['sale.order']._cron_clothcraft_auto_close(now=later), 1)
        self._close_days('not a number')
        self.assertEqual(self.env['sale.order']._clothcraft_auto_close_days(), 7)
        self._close_days('-4')
        self.assertEqual(self.env['sale.order']._clothcraft_auto_close_days(), 0)
        settings = self.env['res.config.settings'].create({'clothcraft_auto_close_days': 10})
        settings.execute()
        self.assertEqual(self.env['ir.config_parameter'].sudo().get_param('clothcraft.auto_close_days'), '10')
        with self.assertRaises(ValidationError):
            self.env['res.config.settings'].create({'clothcraft_auto_close_days': -1})

    def test_the_daily_job_leaves_orders_that_are_not_delivered_alone(self):
        orders = [self._path_to('cod', state) for state in ('confirmed', 'shipped', 'out_for_delivery')]
        self.assertEqual(self.env['sale.order']._cron_clothcraft_auto_close(now=datetime.datetime(2999, 1, 1)), 0)
        self.assertEqual([o.clothcraft_state for o in orders], ['confirmed', 'shipped', 'out_for_delivery'])

    def test_the_daily_job_and_the_customer_at_the_same_moment_close_the_order_once(self):
        """The order row another transaction holds (here: the customer confirming) makes the job's FOR UPDATE NOWAIT fail; the job
        skips it, the customer's close stands, and the next run finds nothing to do. The other way round, the customer pressing after
        the job closed it gets the same "ok" and writes nothing. (scripts/check_close_race.py runs the same race with two real database
        connections on a throwaway copy.)"""
        cursor_class = type(self.env.cr)
        real_execute = cursor_class.execute
        first = self._delivered()
        later = self._audit(first)[-1].create_date + datetime.timedelta(days=30)

        def someone_holds_it(cr, query, params=None, *args, **kwargs):
            if 'FOR UPDATE NOWAIT' in str(query) and params and params[0] == first.id:
                raise pg_errors.LockNotAvailable('could not obtain lock on row in relation "sale_order"')
            return real_execute(cr, query, params, *args, **kwargs)

        with patch.object(cursor_class, 'execute', someone_holds_it):
            self.assertEqual(self.env['sale.order']._cron_clothcraft_auto_close(now=later), 0)       # skipped, not failed
        self.assertEqual(first.clothcraft_state, 'delivered')
        self.assertEqual(self._confirm(first)['replayed'], False)                                  # the customer's close
        self.assertEqual(self.env['sale.order']._cron_clothcraft_auto_close(now=later), 0)          # nothing left for the job
        closing = self._audit(first).filtered(lambda l: l.to_state == 'closed')
        self.assertEqual((len(closing), closing.actor_type, closing.partner_id), (1, 'customer', self.customer_user.partner_id))

        second = self._delivered()
        self.assertEqual(self.env['sale.order']._cron_clothcraft_auto_close(now=later), 1)          # the job first
        self.assertEqual(self._confirm(second)['replayed'], True)                                   # then the customer: same answer
        closing = self._audit(second).filtered(lambda l: l.to_state == 'closed')
        self.assertEqual((len(closing), closing.actor_type), (1, 'automatic'))

    def test_the_cron_record_runs_daily_on_sale_orders(self):
        cron = self.env.ref('clothcraft.ir_cron_order_auto_close')
        self.assertEqual((cron.model_id.model, cron.interval_number, cron.interval_type, cron.code.strip()),
                         ('sale.order', 1, 'days', 'model._cron_clothcraft_auto_close()'))

    # ------------------------------------------------------------------ rights
    def test_the_service_user_still_has_no_write_and_the_history_stays_read_only(self):
        order = self._delivered()
        access = self.env['ir.model.access'].sudo().search([('group_id', '=', self.env.ref('clothcraft.group_api').id)])
        self.assertEqual(sorted((a.model_id.model, a.perm_read, a.perm_write, a.perm_create, a.perm_unlink) for a in access),
                         [('clothcraft.garment.type', True, False, False, False), ('sale.order', True, False, False, False), ('sale.order.line', True, False, False, False)])
        audit_access = self.env['ir.model.access'].sudo().search([('model_id.model', '=', 'clothcraft.order.audit')])
        self.assertTrue(audit_access and not any(a.perm_write or a.perm_create or a.perm_unlink for a in audit_access))
        self.assertEqual(self._confirm(order)['status'], 'ok')       # the customer's close goes through the facade, not a right

    # ------------------------------------------------------------------ the migration to 19.0.1.3.0
    def test_the_migration_closes_delivered_orders_moves_packed_ones_and_writes_a_line_only_for_real_orders(self):
        path = Path(__file__).resolve().parent.parent / 'migrations' / '19.0.1.3.0' / 'post-migrate.py'
        spec = importlib.util.spec_from_file_location('clothcraft_post_migrate_11a', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        real = self._delivered()           # placed without an Idempotency-Key: it has no 'api:' reference, and is still a real order
        self.assertFalse(real.client_order_ref)
        simulated = self._delivered()
        label = self.env['crm.tag'].search([('name', '=', 'Simulated')], limit=1) or self.env['crm.tag'].create({'name': 'Simulated'})
        simulated.sudo().tag_ids = [(4, label.id)]                     # what the simulation puts on every order it makes
        packed = self._place('cod')
        self.env.cr.execute("UPDATE sale_order SET clothcraft_state = 'packed' WHERE id = %s", [packed.id])
        self.env.invalidate_all()
        lines_before = {o.id: len(self._audit(o)) for o in (real, simulated, packed)}
        module.migrate(self.env.cr, '19.0.1.2.0')
        self.env.invalidate_all()
        self.assertEqual([o.clothcraft_state for o in (real, simulated, packed)], ['closed', 'closed', 'confirmed'])
        self.assertEqual(len(self._audit(real)), lines_before[real.id] + 1)
        self.assertEqual((self._audit(real)[-1].actor_type, self._audit(real)[-1].to_state), ('automatic', 'closed'))
        self.assertEqual((len(self._audit(simulated)), len(self._audit(packed))), (lines_before[simulated.id], lines_before[packed.id]))
        self.env.cr.execute("SELECT count(*) FROM sale_order WHERE clothcraft_state IN ('delivered', 'packed')")
        self.assertEqual(self.env.cr.fetchone()[0], 0)
