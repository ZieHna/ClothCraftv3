"""clothcraft_dss (B8 S2): append only on three layers, who may read and start a run, the run's life (done, failed), the latest finished
run. The two-connection advisory lock race is proven outside the suite (it needs two committing connections).
"""
from unittest.mock import patch

import psycopg2

from odoo.exceptions import AccessError, UserError
from odoo.tests import TransactionCase, new_test_user, tagged
from odoo.tools import mute_logger

from odoo.addons.clothcraft_dss.models.dss_outputs import RUNNER
from odoo.addons.clothcraft_dss.models.dss_run import ClothcraftDssRun

OUTPUT_MODELS = ('clothcraft.dss.forecast', 'clothcraft.dss.backtest', 'clothcraft.dss.restock', 'clothcraft.dss.segment',
                 'clothcraft.dss.alert', 'clothcraft.dss.health', 'clothcraft.dss.actual')


@tagged('post_install', '-at_install', 'clothcraft_dss')
class TestDssRun(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Run = cls.env['clothcraft.dss.run']
        cls.admin = new_test_user(cls.env, login='dss_admin', groups='base.group_user,clothcraft.group_admin')
        cls.staff = new_test_user(cls.env, login='dss_staff', groups='base.group_user,clothcraft.group_inventory')
        cls.portal = new_test_user(cls.env, login='dss_portal', groups='base.group_portal')
        cls.first_run = cls.Run._run('manual')    # a real run on this database (not `cls.run`: that would hide TestCase.run)

    def sql_refused(self, sql, params=()):
        with self.assertRaises(psycopg2.errors.RaiseException), mute_logger('odoo.sql_db'), self.env.cr.savepoint():
            self.env.cr.execute(sql, params)

    # ---- the run itself
    def test_a_real_run_is_done_and_states_its_rules(self):
        r = self.first_run
        self.assertEqual(r.state, 'done', r.error)
        self.assertEqual(r.trigger, 'manual')
        self.assertIn(r.closed_rule, ('closed_state', 'delivered_and_paid'))
        self.assertTrue(r.closed_rule_text)
        self.assertEqual(len(r.input_fingerprint), 64)
        self.assertEqual(len(r.output_hash), 64)
        self.assertIn('pandas', r.libraries)
        self.assertEqual(r.status['forecast']['status'], 'not_enough_history')   # a test database has no sales history
        self.assertEqual(set(r.row_counts), {'forecast', 'backtest', 'restock', 'segments', 'alerts', 'health_monthly', 'actuals'})
        self.assertEqual(r.row_counts['actuals'], 0)                                 # no forecast without history: no actuals either

    def test_a_failed_run_keeps_no_output(self):
        real = ClothcraftDssRun._dss_write_table
        calls = []

        def write_then_fail(run, model, rows):
            calls.append(model)
            if model == 'clothcraft.dss.health':
                raise RuntimeError('forced failure while writing outputs')
            return real(run, model, rows)
        with patch.object(ClothcraftDssRun, '_dss_write_table', write_then_fail), mute_logger('odoo.addons.clothcraft_dss.models.dss_run'):
            r = self.Run._run('manual')
        self.assertIn('clothcraft.dss.health', calls)
        self.assertEqual(r.state, 'failed')
        self.assertIn('forced failure', r.error)
        for model in OUTPUT_MODELS:
            self.assertEqual(self.env[model].search_count([('run_id', '=', r.id)]), 0, model)
        self.assertEqual(self.Run._latest_done(), self.first_run)                  # a failed run is never the latest

    def test_latest_done_is_the_newest_finished_run(self):
        newer = self.Run._run('manual')         # no due trigger: no attempt slot, so no marker is committed outside the test
        self.assertEqual(newer.state, 'done', newer.error)
        self.assertEqual(self.Run._latest_done(), newer)

    def test_an_interrupted_attempt_is_recorded_and_not_run_again(self):
        """B8 S2b. The marker is written on a second cursor; registry test mode makes that cursor the test's own (nothing commits)."""
        cron = self.env.ref('clothcraft_dss.ir_cron_dss_run_now')
        Trigger = self.env['ir.cron.trigger'].sudo()
        Trigger.search([('cron_id', '=', cron.id)]).unlink()
        trig = Trigger.create({'cron_id': cron.id, 'call_at': '2026-01-01 00:00:00'})
        with self.enter_registry_test_mode():
            first = self.Run._run('manual')                                    # serves the trigger: marks the attempt, then runs
            self.assertEqual(first.state, 'done', first.error)
            self.assertTrue(self.Run._attempt_marker().startswith(f'manual:{trig.id}|'))
            again = self.Run._run('manual')                                    # the same trigger again, as after a kill or a restart
        self.assertEqual(again.state, 'failed')
        self.assertIn('Interrupted', again.error)
        for model in OUTPUT_MODELS:
            self.assertEqual(self.env[model].search_count([('run_id', '=', again.id)]), 0, model)
        self.assertEqual(self.Run._latest_done(), first)
        trig.unlink()
        self.assertIsNone(self.Run._attempt_slot('manual'))                    # no due trigger: a run from code has no slot

    # ---- layer 1: access lines
    def test_only_the_administrator_reads(self):
        self.assertEqual(self.Run.with_user(self.admin).search([('id', '=', self.first_run.id)]), self.first_run)
        for user in (self.staff, self.portal):
            for model in ('clothcraft.dss.run',) + OUTPUT_MODELS:
                with self.assertRaises(AccessError, msg=f'{user.login} {model}'):
                    self.env[model].with_user(user).search([])

    def test_nobody_creates_writes_or_deletes_through_the_access_lines(self):
        with self.assertRaises(AccessError):
            self.Run.with_user(self.admin).create({'trigger': 'manual', 'started_at': '2026-01-01 00:00:00'})
        with self.assertRaises(AccessError):
            self.first_run.with_user(self.admin).write({'label': 'x'})
        with self.assertRaises(AccessError):
            self.first_run.with_user(self.admin).unlink()

    # ---- layer 2: the ORM
    def test_the_orm_refuses_even_with_sudo(self):
        with self.assertRaises(UserError):
            self.Run.sudo().create({'trigger': 'manual', 'started_at': '2026-01-01 00:00:00'})
        with self.assertRaises(UserError):
            self.first_run.sudo().write({'label': 'x'})
        with self.assertRaises(UserError):
            self.first_run.sudo().with_context(**{RUNNER: True}).write({'label': 'x'})     # finished: not even the runner
        with self.assertRaises(UserError):
            self.first_run.sudo().unlink()
        with self.assertRaises(UserError):
            self.env['clothcraft.dss.health'].sudo().create({'run_id': self.first_run.id, 'month': '2026-01'})
        row = self.env['clothcraft.dss.health'].sudo().search([('run_id', '=', self.first_run.id)], limit=1)
        self.assertTrue(row)
        with self.assertRaises(UserError):
            row.write({'revenue': 1.0})
        with self.assertRaises(UserError):
            row.unlink()

    # ---- layer 3: the database
    def test_the_database_refuses_changes_to_a_finished_run(self):
        self.sql_refused("UPDATE clothcraft_dss_run SET label = 'x' WHERE id = %s", [self.first_run.id])
        self.sql_refused("UPDATE clothcraft_dss_run SET state = 'running' WHERE id = %s", [self.first_run.id])
        self.sql_refused("DELETE FROM clothcraft_dss_run WHERE id = %s", [self.first_run.id])
        self.sql_refused("INSERT INTO clothcraft_dss_run (state, trigger, company_id, started_at) VALUES ('done', 'manual', %s, now())",
                         [self.env.company.id])

    def test_the_database_refuses_changes_to_outputs(self):
        self.sql_refused("UPDATE clothcraft_dss_health SET revenue = 1 WHERE run_id = %s", [self.first_run.id])
        self.sql_refused("DELETE FROM clothcraft_dss_health WHERE run_id = %s", [self.first_run.id])
        self.sql_refused("INSERT INTO clothcraft_dss_alert (run_id, kind) VALUES (%s, 'x')", [self.first_run.id])   # the run is finished

    # ---- starting a run
    def test_run_now_only_queues_and_only_for_the_administrator(self):
        cron = self.env.ref('clothcraft_dss.ir_cron_dss_run_now')
        Trigger = self.env['ir.cron.trigger'].sudo()
        before = self.Run.search_count([])
        Trigger.search([('cron_id', '=', cron.id)]).unlink()
        with self.assertRaises(AccessError):
            self.Run.with_user(self.staff).action_run_now()
        res = self.Run.with_user(self.admin).action_run_now()
        self.assertEqual(res['tag'], 'display_notification')
        self.assertEqual(Trigger.search_count([('cron_id', '=', cron.id)]), 1)
        self.assertEqual(self.Run.search_count([]), before)                   # nothing computed in the request
        with self.assertRaises(UserError):
            self.Run.with_user(self.admin).action_run_now()                      # already queued

    def test_the_crons_as_installed(self):
        weekly = self.env.ref('clothcraft_dss.ir_cron_dss_weekly')
        now = self.env.ref('clothcraft_dss.ir_cron_dss_run_now')
        self.assertFalse(weekly.active)
        self.assertEqual((weekly.interval_number, weekly.interval_type), (1, 'weeks'))
        self.assertEqual((weekly.nextcall.weekday(), weekly.nextcall.hour), (6, 19))     # Sunday 19:00 UTC = Monday 03:00 Manila
        self.assertTrue(now.active)
        self.assertEqual(now.nextcall.year, 2999)
