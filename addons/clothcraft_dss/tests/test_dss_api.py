"""clothcraft_dss (B8 S4b): the DSS facade on clothcraft.api, called as the storefront API service user with real session rows. The runs
are built by hand through the runner's own guard (created running, rows added, finished), so every expected figure can be checked by eye.
"""
from datetime import timedelta
from unittest.mock import patch

from odoo import Command, fields
from odoo.exceptions import AccessError, UserError
from odoo.tests import TransactionCase, tagged

from odoo.addons.clothcraft_dss.models.api_dss import IN_PROGRESS, NO_RUN, NOTICE
from odoo.addons.clothcraft_dss.models.dss_outputs import RUNNER

METHODS = ('admin_dss_overview', 'admin_dss_runs', 'admin_dss_run', 'admin_dss_forecast_keys', 'admin_dss_forecast', 'admin_dss_backtest',
           'admin_dss_restock', 'admin_dss_segments', 'admin_dss_alerts', 'admin_dss_health', 'admin_dss_run_now', 'admin_dss_run_request')
DSS_MODELS = ('clothcraft.dss.run', 'clothcraft.dss.forecast', 'clothcraft.dss.backtest', 'clothcraft.dss.restock', 'clothcraft.dss.segment',
              'clothcraft.dss.alert', 'clothcraft.dss.health', 'clothcraft.dss.actual')
REF_KEYS = {'id', 'kind', 'simulated', 'notice', 'as_of', 'engine_version', 'closed_rule', 'closed_rule_text', 'trigger', 'finished_at', 'age_days', 'stale'}
SUMMARY_KEYS = REF_KEYS | {'state', 'started_at', 'duration_s', 'requested_by_name', 'headline'}
INFO = {'status', 'currency', 'vat_rate', 'vat_included', 'vat_rounding', 'simulation', 'session_remaining'}


def body(reply):
    """The reply without the envelope the service strips."""
    return {k: v for k, v in reply.items() if k not in INFO}


@tagged('post_install', '-at_install', 'clothcraft_dss')
class TestDssApi(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.now = fields.Datetime.now().replace(microsecond=0)
        cls.api_user = env['res.users'].create({'name': 'dss api', 'login': 'dss_api_svc',
                                                'group_ids': [Command.set([env.ref('base.group_user').id, env.ref('clothcraft.group_api').id])]})
        cls.api = env(user=cls.api_user)['clothcraft.api']
        cls.admin = cls._user('dss-adm', ['base.group_user', 'clothcraft.group_admin'])
        cls.inventory = cls._user('dss-inv', ['base.group_user', 'clothcraft.group_inventory'])
        cls.admin_sid = cls._session(cls.admin, 'admin')
        cls.staff_sid = cls._session(cls.admin, 'staff')           # the Administrator's EMPLOYEE session: not an admin session
        cls.inv_admin_sid = cls._session(cls.inventory, 'admin')    # an admin-scope row for someone who is not an Administrator
        # customers for the real run's segments
        cls.p1 = env['res.partner'].create({'name': 'Maria Santos', 'email': 'maria@example.com', 'phone': '0917 000 0001'})
        cls.u1 = env['res.users'].create({'name': 'Maria Santos', 'login': 'maria-dss@example.com', 'partner_id': cls.p1.id,
                                          'group_ids': [Command.set([env.ref('base.group_portal').id])]})
        cls.p2 = env['res.partner'].create({'name': 'Jose Cruz'})  # no shop account
        week = lambda d: f'2026-10-{d:02d}'
        cls.r1 = cls._run(finished=cls.now - timedelta(days=3))
        cls.r2 = cls._run(finished=cls.now - timedelta(days=1), outputs={
            'clothcraft.dss.forecast': [
                {'level': 'product', 'key': '7', 'key_label': 'Tee A', 'week_start': week(19), 'h': 1, 'yhat': 2.0, 'has_interval': True, 'lo80': 1.0, 'hi80': 3.0, 'lo95': 0.5, 'hi95': 4.0, 'method': 'ets'},
                {'level': 'product', 'key': '7', 'key_label': 'Tee A', 'week_start': week(26), 'h': 2, 'yhat': 3.0, 'has_interval': True, 'lo80': 1.5, 'hi80': 4.0, 'lo95': 1.0, 'hi95': 5.0, 'method': 'ets'},
                {'level': 'product', 'key': '8', 'key_label': 'Tee B', 'week_start': week(19), 'h': 1, 'yhat': 1.0, 'method': 'croston', 'flags': 'intermittent'},
                {'level': 'product', 'key': '8', 'key_label': 'Tee B', 'week_start': week(26), 'h': 2, 'yhat': 1.0, 'method': 'croston', 'flags': 'intermittent'},
                {'level': 'garment_type', 'key': 'TEE', 'key_label': 'TEE', 'week_start': week(19), 'h': 1, 'yhat': 3.0, 'method': 'bottom_up'},
                {'level': 'garment_type', 'key': 'TEE', 'key_label': 'TEE', 'week_start': week(26), 'h': 2, 'yhat': 4.0, 'method': 'bottom_up'},
                {'level': 'total', 'key': 'total', 'key_label': 'total', 'week_start': week(19), 'h': 1, 'yhat': 3.0, 'method': 'bottom_up'},
                {'level': 'total', 'key': 'total', 'key_label': 'total', 'week_start': week(26), 'h': 2, 'yhat': 4.0, 'method': 'bottom_up'}],
            'clothcraft.dss.actual': [
                {'level': 'product', 'key': '7', 'week_start': week(5), 'units': 2.0}, {'level': 'product', 'key': '7', 'week_start': week(12), 'units': 1.0, 'censored': True},
                {'level': 'product', 'key': '8', 'week_start': week(5), 'units': 1.0}, {'level': 'product', 'key': '8', 'week_start': week(12), 'units': 0.0},
                {'level': 'total', 'key': 'total', 'week_start': week(5), 'units': 3.0}, {'level': 'total', 'key': 'total', 'week_start': week(12), 'units': 1.0, 'censored': True}],
            'clothcraft.dss.restock': [
                {'sku': 'E', 'template_key': 8, 'product_key': 85, 'garment_type': 'TEE', 'status': 'no_forecast'},
                {'sku': 'D', 'template_key': 8, 'product_key': 84, 'garment_type': 'TEE', 'status': 'ok', 'supplier_key': 11, 'supplier': 'Mills', 'unit_cost': 100.0, 'landed_unit_cost': 100.0},
                {'sku': 'C', 'template_key': 8, 'product_key': 83, 'garment_type': 'TEE', 'status': 'plan', 'runout_date': week(30), 'days_left': 14},
                {'sku': 'B', 'template_key': 7, 'product_key': 72, 'garment_type': 'TEE', 'status': 'order_now', 'order_now': True, 'runout_date': week(25), 'days_left': 9},
                {'sku': 'A', 'template_key': 7, 'product_key': 71, 'garment_type': 'TEE', 'status': 'order_now', 'order_now': True, 'stockout_before_arrival': True,
                 'runout_date': week(20), 'days_left': 4, 'supplier_key': 11, 'supplier': 'Mills', 'unit_cost': 150.0, 'landed_unit_cost': 160.0, 'est_cost': 640.0,
                 'suggested_qty': 4, 'alternatives': [{'supplier_id': 12, 'supplier': 'Knit', 'landed_unit_cost': 170.0, 'lead_p90': 9.0, 'coverage_risk': False,
                                                       'arrives_before_runout': True, 'ineligible': []}]}],
            'clothcraft.dss.segment': [
                {'customer_key': str(cls.p2.id), 'partner_key': cls.p2.id, 'recency_days': 40, 'frequency': 2, 'monetary': 200.0, 'segment': 'hibernating', 'segment_name': 'Hibernating'},
                {'customer_key': str(cls.p1.id), 'partner_key': cls.p1.id, 'recency_days': 3, 'frequency': 9, 'monetary': 300.0, 'segment': 'champions', 'segment_name': 'Champions'},
                {'customer_key': '99999999', 'partner_key': 99999999, 'recency_days': 90, 'frequency': 1, 'monetary': 100.0, 'segment': 'one_time_lapsed', 'segment_name': 'One-time, lapsed'}],
            'clothcraft.dss.alert': [
                {'kind': 'unpaid_bank_transfer', 'band': 'admin_decide', 'severity': 'critical', 'subject_type': 'order', 'subject_key': 1, 'subject_label': 'Order 1', 'has_age': True, 'age_days': 20.0},
                {'kind': 'unpaid_bank_transfer', 'band': 'stuck', 'severity': 'warning', 'subject_type': 'order', 'subject_key': 2, 'subject_label': 'Order 2', 'has_age': True, 'age_days': 8.0},
                {'kind': 'forecast_stockout', 'band': 'before_arrival', 'severity': 'info', 'subject_type': 'variant', 'subject_key': 71, 'subject_label': 'A'},
                {'kind': 'unpaid_bank_transfer', 'band': 'admin_decide', 'severity': 'critical', 'subject_type': 'order', 'subject_key': 3, 'subject_label': 'Order 3', 'has_age': True, 'age_days': 30.0}],
            'clothcraft.dss.backtest': [
                {'level': 'total', 'key': 'total', 'policy': 'chosen', 'horizon': 'all', 'weeks': 'all', 'n': 10, 'has_metrics': True, 'wape': 22.0, 'bias': -5.0, 'mae': 4.0},
                {'level': 'product', 'key': '7', 'policy': 'ets', 'horizon': '1', 'weeks': 'all', 'n': 5, 'has_metrics': True, 'wape': 40.0, 'mae': 1.0},
                {'level': 'product', 'key': '7', 'policy': 'ets', 'horizon': 'all', 'weeks': 'all', 'n': 0}],
            'clothcraft.dss.health': [
                {'month': '2026-10', 'month_start': '2026-10-01', 'complete': False, 'revenue': 50.0},
                {'month': '2026-09', 'month_start': '2026-09-01', 'complete': True, 'revenue': 100.0, 'has_ma3': True, 'revenue_ma3': 90.0, 'flags': 'x,y'}]},
            summary={'health': {'trend': {'label': 'growing'}, 'kpis': {'net_position': 1.0}, 'projection': {'months': []}},
                     'segment_summary': [{'segment': 'champions', 'customers': 1}], 'forecast_notes': ['Simulated data: …']},
            selection={'chosen': 'ets_croston', 'best_baseline': 'ma4', 'model_beats_baseline': True, 'wape': {'ma4': 51.7}})
        cls.s1 = cls._run(simulated=True, trigger='import', finished=cls.now - timedelta(days=2),
                          status={'forecast': {'status': 'not_enough_history', 'message': 'Not enough history yet (needs 16 weeks with sales; has 1).'},
                                  'segments': {'status': 'ok'}},
                          outputs={'clothcraft.dss.segment': [{'customer_key': 'c_0123456789abcdef', 'partner_key': 0, 'recency_days': 5, 'frequency': 1,
                                                               'monetary': 50.0, 'segment': 'new', 'segment_name': 'New'}]})
        cls.f1 = cls._run(state='failed', finished=cls.now, error='RuntimeError: boom')

    @classmethod
    def _user(cls, name, groups):
        return cls.env['res.users'].create({'name': name, 'login': f'{name}@example.com', 'email': f'{name}@example.com',
                                            'group_ids': [Command.set([cls.env.ref(g).id for g in groups])]})

    @classmethod
    def _session(cls, user, scope):
        sid = f'sid-{user.login}-{scope}'
        cls.env['clothcraft.api.session'].sudo().create({'sid_hash': sid, 'user_id': user.id, 'scope': scope, 'last_seen': cls.now,
                                                         'expires': cls.now + timedelta(hours=8)})
        return sid

    @classmethod
    def _run(cls, simulated=False, trigger='manual', finished=None, state='done', outputs=None, status=None, summary=None, selection=None,
             error=False, trigger_ref=False):
        Run = cls.env['clothcraft.dss.run'].sudo().with_context(**{RUNNER: True})
        run = Run.create({'trigger': trigger, 'started_at': (finished or cls.now) - timedelta(seconds=5), 'trigger_ref': trigger_ref})
        for model, rows in (outputs or {}).items():
            cls.env[model].sudo().with_context(**{RUNNER: True}).create([{**r, 'run_id': run.id} for r in rows])
        run.write({'state': state, 'finished_at': finished or cls.now, 'duration_s': 5.0, 'as_of': '2026-10-15', 'simulated': simulated,
                   'label': NOTICE if simulated else False, 'closed_rule': 'closed_state', 'closed_rule_text': 'Closed = closed orders.',
                   'engine_version': 'B8-S4', 'status': status or {'forecast': {'status': 'ok'}, 'segments': {'status': 'ok'}},
                   'summary': summary or {}, 'selection': selection or {}, 'error': error, 'requested_by_name': 'Tester'})
        return run

    def call(self, method, **payload):
        return getattr(self.api, method)({'sid_hash': self.admin_sid, **payload})

    # ---- access
    def test_every_method_needs_a_live_admin_session(self):
        for method in METHODS:
            for sid in (None, 'no-such-session', self.staff_sid, self.inv_admin_sid):
                self.assertEqual(getattr(self.api, method)({'sid_hash': sid})['status'], 'unauthorised', (method, sid))

    def test_the_api_user_has_no_direct_rights_on_dss_models(self):
        for model in DSS_MODELS:
            with self.assertRaises(AccessError, msg=model):
                self.env(user=self.api_user)[model].search([])
        self.assertFalse([m for m in dir(self.api) if m.startswith('admin_dss') and 'import' in m])   # import is not offered

    # ---- overview, runs, selection
    def test_overview_labels_real_and_simulated_apart(self):
        r = body(self.call('admin_dss_overview'))
        self.assertEqual(set(r), {'real', 'simulated', 'queue'})
        self.assertEqual(set(r['real']), SUMMARY_KEYS)
        self.assertEqual((r['real']['id'], r['real']['kind'], r['real']['simulated'], r['real']['notice']), (self.r2.id, 'real', False, None))
        self.assertEqual((r['simulated']['id'], r['simulated']['kind'], r['simulated']['notice']), (self.s1.id, 'simulated', NOTICE))
        self.assertEqual(r['real']['headline'], {'order_now': 2, 'alerts_critical': 2, 'alerts_warning': 1, 'forecast_status': 'ok',
                                                 'segments_status': 'ok', 'trend': 'growing'})
        self.assertIsNone(r['queue'])

    def test_runs_list_kind_state_paging(self):
        ids = lambda **p: [x['id'] for x in self.call('admin_dss_runs', **p)['runs']]
        self.assertEqual(ids(), [self.f1.id, self.r2.id, self.r1.id])                 # real by default, newest first, failed included
        self.assertEqual(ids(kind='simulated'), [self.s1.id])
        self.assertEqual(ids(kind='all'), [self.f1.id, self.r2.id, self.s1.id, self.r1.id])
        self.assertEqual(ids(state='failed'), [self.f1.id])
        page = self.call('admin_dss_runs', limit=1, offset=1)
        self.assertEqual(([x['id'] for x in page['runs']], page['total'], page['limit'], page['offset']), ([self.r2.id], 3, 1, 1))
        self.assertEqual(self.call('admin_dss_runs', limit=500)['limit'], 100)
        self.assertEqual(self.call('admin_dss_runs', kind='mixed')['status'], 'invalid')

    def test_run_detail_and_a_failed_run(self):
        d = self.call('admin_dss_run', run_id=self.r2.id)['run']
        self.assertEqual(set(d), SUMMARY_KEYS | {'part_status', 'selection', 'row_counts', 'libraries', 'input_fingerprint', 'output_hash',
                                                 'forecast_notes', 'error'})
        self.assertEqual(d['selection'], {'chosen': 'ets_croston', 'best_baseline': 'ma4', 'model_beats_baseline': True, 'wape': {'ma4': 51.7}})
        self.assertEqual(d['part_status']['forecast'], {'code': 'ok', 'message': None})
        self.assertIsNone(d['error'])
        self.assertEqual(self.call('admin_dss_run', run_id=self.f1.id)['run']['error'], 'RuntimeError: boom')
        self.assertEqual(self.call('admin_dss_run', run_id=99999999)['status'], 'not_found')

    def test_run_selection_and_its_refusals(self):
        self.assertEqual(self.call('admin_dss_health')['run']['id'], self.r2.id)                # latest REAL done run (the failed one is skipped)
        self.assertEqual(self.call('admin_dss_health', kind='simulated')['run']['id'], self.s1.id)
        self.assertEqual(self.call('admin_dss_health', run_id=self.r1.id)['run']['id'], self.r1.id)
        self.assertEqual(self.call('admin_dss_health', run_id=self.r1.id, kind='real')['status'], 'invalid')
        unknown = self.call('admin_dss_health', run_id=99999999)
        self.assertEqual((unknown['status'], unknown['message']), ('no_run', 'No DSS run "99999999"'))
        failed = self.call('admin_dss_restock', run_id=self.f1.id)
        self.assertEqual((failed['status'], failed['message']), ('run_failed', 'This run failed: RuntimeError: boom'))
        with patch.object(type(self.env['clothcraft.dss.run']), '_latest_done', lambda *a, **k: self.env['clothcraft.dss.run']):
            none = self.call('admin_dss_alerts')
        self.assertEqual((none['status'], none['message']), ('no_run', NO_RUN))

    def test_stale_after_eight_days(self):
        with patch.object(type(self.api), '_dss_now', lambda _s: self.r2.finished_at + timedelta(days=8, hours=1)):
            self.assertEqual((self.call('admin_dss_health')['run']['age_days'], self.call('admin_dss_health')['run']['stale']), (8, False))
        with patch.object(type(self.api), '_dss_now', lambda _s: self.r2.finished_at + timedelta(days=9, hours=1)):
            ref = self.call('admin_dss_health')['run']
            sim = self.call('admin_dss_health', kind='simulated')['run']
        self.assertEqual((ref['stale'], ref['notice']), (True, 'This run is 9 days old; the figures may be out of date.'))
        self.assertTrue(sim['notice'].startswith(NOTICE) and sim['notice'].endswith('the figures may be out of date.'))

    # ---- forecast and history
    def test_forecast_keys_and_rows(self):
        keys = self.call('admin_dss_forecast_keys', level='product')
        self.assertEqual(keys['keys'], [{'level': 'product', 'key': '7', 'label': 'Tee A'}, {'level': 'product', 'key': '8', 'label': 'Tee B'}])
        f = body(self.call('admin_dss_forecast', level='product', key='7'))
        self.assertEqual(set(f), {'run', 'level', 'key', 'data_status', 'rows', 'history', 'history_status'})
        self.assertEqual(f['rows'][0], {'week_start': '2026-10-19', 'h': 1, 'yhat': 2.0, 'lo80': 1.0, 'hi80': 3.0, 'lo95': 0.5, 'hi95': 4.0,
                                        'method': 'ets', 'flags': [], 'censored': False})
        b = self.call('admin_dss_forecast', level='product', key='8')['rows'][0]
        self.assertEqual((b['lo80'], b['hi95'], b['flags']), (None, None, ['intermittent']))      # no interval: null, never 0
        self.assertEqual(self.call('admin_dss_forecast', level='product', key='nope')['status'], 'invalid')

    def test_history_for_product_total_and_garment_type(self):
        h = lambda level, key: [(x['week_start'], x['units'], x['censored']) for x in self.call('admin_dss_forecast', level=level, key=key)['history']]
        self.assertEqual(h('product', '7'), [('2026-10-05', 2.0, False), ('2026-10-12', 1.0, True)])
        self.assertEqual(h('total', 'total'), [('2026-10-05', 3.0, False), ('2026-10-12', 1.0, True)])
        self.assertEqual(h('garment_type', 'TEE'), [('2026-10-05', 3.0, False), ('2026-10-12', 1.0, True)])   # 7 + 8, censored if any is
        self.assertIsNone(self.call('admin_dss_forecast', level='garment_type', key='TEE')['history_status'])

    def test_garment_type_history_is_null_when_the_mapping_is_not_reliable(self):
        bad = self._run(outputs={
            'clothcraft.dss.forecast': [{'level': 'product', 'key': '7', 'week_start': '2026-10-19', 'yhat': 2.0},
                                        {'level': 'garment_type', 'key': 'TEE', 'week_start': '2026-10-19', 'yhat': 5.0}],   # not 2.0: inconsistent
            'clothcraft.dss.actual': [{'level': 'product', 'key': '7', 'week_start': '2026-10-05', 'units': 2.0}],
            'clothcraft.dss.restock': [{'sku': 'A', 'template_key': 7, 'garment_type': 'TEE', 'status': 'ok'}]})
        f = self.call('admin_dss_forecast', run_id=bad.id, level='garment_type', key='TEE')
        self.assertIsNone(f['history'])
        self.assertEqual(f['history_status']['code'], 'history_unavailable')
        self.assertIn('does not equal the sum of its products', f['history_status']['message'])
        self.assertEqual(len(self.call('admin_dss_forecast', run_id=bad.id, level='product', key='7')['history']), 1)     # products still have it

    def test_no_actuals_gives_an_empty_history_and_says_why(self):
        f = self.call('admin_dss_forecast', kind='simulated', level='total')
        self.assertEqual((f['rows'], f['history']), ([], []))
        self.assertEqual(f['data_status'], {'code': 'not_enough_history', 'message': 'Not enough history yet (needs 16 weeks with sales; has 1).'})
        self.assertEqual(f['history_status']['code'], 'not_enough_history')

    # ---- the tables
    def test_backtest_filters_paging_and_order(self):
        rows = self.call('admin_dss_backtest')['rows']
        self.assertEqual([(r['level'], r['policy'], r['horizon']) for r in rows], [('product', 'ets', '1'), ('product', 'ets', 'all'), ('total', 'chosen', 'all')])
        self.assertEqual(set(rows[0]), {'level', 'key', 'policy', 'horizon', 'weeks', 'n', 'n_with_interval', 'mae', 'wape', 'bias', 'cov80', 'cov95', 'chosen'})
        self.assertEqual((rows[1]['mae'], rows[1]['wape'], rows[0]['cov80']), (None, None, None))     # n = 0, no metrics, no coverage
        page = self.call('admin_dss_backtest', policy='ets', limit=1, offset=1)
        self.assertEqual((page['total'], [r['horizon'] for r in page['rows']]), (2, ['all']))
        self.assertEqual(self.call('admin_dss_backtest', horizon='9')['status'], 'invalid')

    def test_restock_urgency_order_counts_and_filters(self):
        r = self.call('admin_dss_restock')
        self.assertEqual([x['sku'] for x in r['rows']], ['A', 'B', 'C', 'D', 'E'])
        self.assertEqual([x['urgency'] for x in r['rows']], ['stockout_before_arrival', 'order_now', 'plan', 'ok', 'no_forecast'])
        self.assertEqual(r['counts'], {u: 1 for u in ('stockout_before_arrival', 'order_now', 'plan', 'ok', 'no_forecast')})
        a, e = r['rows'][0], r['rows'][4]
        self.assertEqual((a['supplier_id'], a['landed_unit_cost'], a['days_left'], a['alternatives'][0]['supplier']), (11, 160.0, 4, 'Knit'))
        self.assertEqual((e['supplier_id'], e['daily_demand'], e['suggested_qty'], e['days_left']), (None, None, None, None))
        self.assertEqual([x['sku'] for x in self.call('admin_dss_restock', urgency='order_now')['rows']], ['B'])
        self.assertEqual([x['sku'] for x in self.call('admin_dss_restock', supplier_id=11)['rows']], ['A', 'D'])
        self.assertEqual(self.call('admin_dss_restock', q='c')['total'], 1)

    def test_segments_on_a_real_run_show_the_customer_but_no_contact_details(self):
        rows = self.call('admin_dss_segments')['rows']
        self.assertEqual([r['monetary'] for r in rows], [300.0, 200.0, 100.0])
        self.assertEqual(rows[0]['customer'], {'customer_id': self.u1.id, 'partner_id': self.p1.id, 'display_name': 'Maria Santos'})
        self.assertEqual(rows[1]['customer'], {'customer_id': None, 'partner_id': self.p2.id, 'display_name': 'Jose Cruz'})
        self.assertEqual(rows[2]['customer'], {'customer_id': None, 'partner_id': 99999999, 'display_name': None})       # no longer exists
        self.p1.name = 'Maria S. Reyes'                                                                                  # read live
        self.assertEqual(self.call('admin_dss_segments')['rows'][0]['customer']['display_name'], 'Maria S. Reyes')
        text = repr(self.call('admin_dss_segments'))
        self.assertNotIn('maria@example.com', text)
        self.assertNotIn('0917', text)
        self.assertEqual([r['segment'] for r in self.call('admin_dss_segments', sort='recency')['rows']], ['champions', 'hibernating', 'one_time_lapsed'])

    def test_segments_on_a_simulated_run_have_only_the_pseudonymous_key(self):
        s = self.call('admin_dss_segments', kind='simulated')
        self.assertEqual([(r['customer_key'], r['customer']) for r in s['rows']], [('c_0123456789abcdef', None)])
        self.assertEqual(s['run']['notice'], NOTICE)

    def test_alerts_order_filters_and_counts(self):
        a = self.call('admin_dss_alerts')
        self.assertEqual([x['subject_label'] for x in a['rows']], ['Order 3', 'Order 1', 'Order 2', 'A'])   # critical oldest first, then warning, info
        self.assertEqual(a['counts'], {'critical': 2, 'warning': 1, 'info': 1})
        self.assertIsNone(a['rows'][3]['age_days'])
        self.assertEqual([x['subject_label'] for x in self.call('admin_dss_alerts', severity='warning')['rows']], ['Order 2'])
        self.assertEqual(self.call('admin_dss_alerts', kind='forecast_stockout')['counts'], {'critical': 0, 'warning': 0, 'info': 1})
        self.assertEqual(self.call('admin_dss_alerts', kind='open')['status'], 'invalid')

    def test_small_numbers_leave_odoo_unrounded_and_weekly_demand_is_added(self):
        """B8 S4d. The service keeps 4 decimals on the DSS routes; Odoo must hand over the exact values and the derived figures."""
        run = self._run(outputs={
            'clothcraft.dss.restock': [{'sku': 'SLOW', 'template_key': 7, 'garment_type': 'TEE', 'status': 'plan', 'daily_demand': 0.0348,
                                        'safety_stock': 0.8214, 'runout_date': '2026-12-01', 'days_left': 47},
                                       {'sku': 'NONE', 'template_key': 8, 'garment_type': 'TEE', 'status': 'no_forecast'}],
            'clothcraft.dss.backtest': [{'level': 'product', 'key': '7', 'policy': 'ets', 'horizon': 'all', 'weeks': 'all', 'n': 12,
                                         'has_metrics': True, 'wape': 0.4965, 'bias': -0.0312, 'mae': 0.0312, 'has_coverage': True, 'cov80': 76.6}]},
            summary={'health': {'trend': {'label': 'stable', 'revenue_rel_slope': 0.0112, 'threshold': 0.02}, 'kpis': {}, 'projection': {}}})
        slow, none = self.call('admin_dss_restock', run_id=run.id)['rows']
        self.assertEqual((slow['daily_demand'], slow['weekly_demand'], slow['safety_stock']), (0.0348, 0.2436, 0.8214))
        self.assertEqual((none['daily_demand'], none['weekly_demand']), (None, None))          # no forecast: nothing to say, never 0
        b = self.call('admin_dss_backtest', run_id=run.id)['rows'][0]
        self.assertEqual((b['wape'], b['bias'], b['mae'], b['cov80']), (0.4965, -0.0312, 0.0312, 76.6))      # percentages as the engine measures them
        t = self.call('admin_dss_health', run_id=run.id)['trend']
        self.assertEqual((t['revenue_rel_slope'], t['revenue_rel_slope_pct'], t['threshold_pct']), (0.0112, 1.12, 2.0))

    def test_health(self):
        h = body(self.call('admin_dss_health'))
        self.assertEqual(set(h), {'run', 'months', 'trend', 'kpis', 'projection'})
        self.assertEqual([m['month'] for m in h['months']], ['2026-09', '2026-10'])
        self.assertEqual((h['months'][0]['revenue_ma3'], h['months'][1]['revenue_ma3'], h['months'][0]['flags']), (90.0, None, ['x', 'y']))
        self.assertEqual(h['trend'], {'label': 'growing', 'revenue_rel_slope_pct': None, 'threshold_pct': None})

    # ---- Run now
    def set_marker(self, value):
        self.env.cr.execute("""INSERT INTO ir_config_parameter (key, value) VALUES ('clothcraft_dss.attempt', %s)
                               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""", [value])

    def test_run_now_queues_a_request_and_its_states(self):
        cron = self.env.ref('clothcraft_dss.ir_cron_dss_run_now')
        Trigger = self.env['ir.cron.trigger'].sudo()
        Trigger.search([('cron_id', '=', cron.id)]).unlink()
        before = self.env['clothcraft.dss.run'].sudo().search_count([])
        r = body(self.call('admin_dss_run_now'))
        self.assertEqual(set(r), {'request_id', 'state'})
        trig = Trigger.browse(r['request_id'])
        self.assertEqual((r['state'], trig.cron_id, trig.create_uid), ('queued', cron, self.admin))      # queued as the Administrator
        self.assertEqual(self.env['clothcraft.dss.run'].sudo().search_count([]), before)                 # nothing computed in the request
        busy = self.call('admin_dss_run_now')
        self.assertEqual((busy['status'], busy.get('message')), ('run_in_progress', IN_PROGRESS), busy)
        state = lambda rid: body(self.call('admin_dss_run_request', request_id=rid))
        self.assertEqual(state(trig.id), {'request_id': trig.id, 'state': 'queued', 'run_id': None, 'detail': None})
        self.set_marker(f'manual:{trig.id}|{fields.Datetime.to_string(fields.Datetime.now())}')
        self.assertEqual(state(trig.id)['state'], 'running')
        self.assertEqual(body(self.call('admin_dss_overview'))['queue']['state'], 'running')
        done = self._run(trigger_ref=f'manual:{trig.id}')
        self.assertEqual(state(trig.id), {'request_id': trig.id, 'state': 'done', 'run_id': done.id, 'detail': None})
        failed = self._run(state='failed', error='RuntimeError: x', trigger_ref='manual:424242')
        self.assertEqual((state(424242)['state'], state(424242)['run_id'], state(424242)['detail']), ('failed', failed.id, 'This run failed: RuntimeError: x'))
        self.assertEqual(state(99999999)['state'], 'unknown')

    def test_a_fresh_weekly_attempt_blocks_run_now_and_an_old_one_does_not(self):
        cron = self.env.ref('clothcraft_dss.ir_cron_dss_run_now')
        self.env['ir.cron.trigger'].sudo().search([('cron_id', '=', cron.id)]).unlink()
        self.set_marker(f'cron:2026-11-01 19:00:00|{fields.Datetime.to_string(fields.Datetime.now())}')
        self.assertEqual(self.call('admin_dss_run_now')['status'], 'run_in_progress')
        self.assertEqual(body(self.call('admin_dss_overview'))['queue']['state'], 'running')
        self.set_marker(f'cron:2026-11-01 19:00:00|{fields.Datetime.to_string(fields.Datetime.now() - timedelta(minutes=16))}')
        self.assertEqual(self.call('admin_dss_run_now')['status'], 'ok')

    def test_the_import_gate_is_unchanged(self):
        self.env['ir.config_parameter'].sudo().set_param('clothcraft_dss.bundle_import_enabled', False)
        with self.assertRaises(UserError):
            self.env['clothcraft.dss.run'].with_user(self.admin)._import_bundle('/mnt/dss-bundles/x')
