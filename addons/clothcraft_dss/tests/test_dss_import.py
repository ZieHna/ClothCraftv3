"""clothcraft_dss (B8 S3): import of an engine bundle. Bundles are written with the engine's own write_bundle() into a temporary folder
that stands in for BUNDLE_ROOT.
"""
import json
import os
import shutil
import tempfile
from unittest.mock import patch

import pandas as pd

from odoo.exceptions import AccessError, UserError
from odoo.tests import TransactionCase, new_test_user, tagged

from odoo.addons.clothcraft_dss.engine import bundle as B
from odoo.addons.clothcraft_dss.models.dss_run import ClothcraftDssRun

OUTPUT_MODELS = {'forecast': 'clothcraft.dss.forecast', 'backtest': 'clothcraft.dss.backtest', 'restock': 'clothcraft.dss.restock',
                 'segments': 'clothcraft.dss.segment', 'alerts': 'clothcraft.dss.alert', 'health_monthly': 'clothcraft.dss.health',
                 'actuals': 'clothcraft.dss.actual'}
SWITCH = 'clothcraft_dss.bundle_import_enabled'


def make_result(revenue=1000.0, simulated=True, version='B8-S4'):
    """A small but complete engine result (every column the importer reads)."""
    t = {
        'forecast': pd.DataFrame([
            {'level': 'product', 'key': 7, 'week_start': '2026-10-12', 'h': 1, 'yhat': 3.5, 'method': 'ets', 'censored': False, 'lo80': 1.0,
             'hi80': 6.0, 'lo95': 0.0, 'hi95': 8.0, 'flags': ''},
            {'level': 'total', 'key': 'total', 'week_start': '2026-10-12', 'h': 1, 'yhat': 3.5, 'method': 'bottom_up', 'censored': False,
             'lo80': float('nan'), 'hi80': float('nan'), 'lo95': float('nan'), 'hi95': float('nan'), 'flags': 'no_interval'}]),
        'backtest': pd.DataFrame([{'level': 'product', 'key': 7, 'policy': 'ets', 'horizon': 'all', 'weeks': 'all', 'n': 10, 'mae': 1.0,
                                   'wape': 40.0, 'bias': -5.0, 'cov80': 80.0, 'cov95': 95.0, 'n_int': 10, 'chosen': True}]),
        'restock': pd.DataFrame([{
            'product_id': 70, 'template_id': 7, 'sku': 'SIM-X-M', 'product': 'Sim Tee', 'garment_type': 'TEE', 'size': 'M', 'color': 'Red',
            'on_hand': 2.0, 'reserved': 0.0, 'free': 2.0, 'incoming': 0.0, 'share': 0.5, 'daily_demand': 0.25, 'days_left': 7,
            'runout_date': '2026-10-23 00:00:00', 'runout_date_hi80': '2026-10-20 00:00:00', 'supplier_id': 11, 'supplier': 'Sample Mills',
            'lead_p50': 8.0, 'lead_p90': 10.0, 'lead_source': 'history', 'lead_days': 10, 'safety_stock': 1.2, 'reorder_point': 3.7,
            'order_up_to': 5.4, 'suggested_qty': 4, 'order_by': '2026-10-15 00:00:00', 'order_now': True, 'stockout_before_arrival': True,
            'arrives_before_runout': False, 'coverage_risk': True, 'unit_cost': 150.0, 'landed_unit_cost': 150.0, 'est_cost': 600.0,
            'alternatives': '[]', 'status': 'order_now', 'flags': ''}]),
        'segments': pd.DataFrame([
            {'customer_key': B.pseudonym('clothcraft_sim2', 5), 'partner_id': None, 'recency_days': 3, 'frequency': 9, 'monetary': 9000.0,
             'r_score': 5, 'f_score': 5, 'm_score': 5, 'segment': 'champions', 'segment_name': 'Champions'},
            {'customer_key': '42', 'partner_id': 42, 'recency_days': 300, 'frequency': 1, 'monetary': 500.0, 'r_score': 1, 'f_score': 1,
             'm_score': 1, 'segment': 'one_time_lapsed', 'segment_name': 'One-time, lapsed'}]),
        'segment_summary': pd.DataFrame([{'segment': 'champions', 'segment_name': 'Champions', 'customers': 1, 'share_pct': 50.0}]),
        'alerts': pd.DataFrame([{'kind': 'unpaid_bank_transfer', 'band': 'stuck', 'severity': 'warning', 'subject_type': 'order', 'subject_id': 9,
                                 'subject_label': 'Order 9', 'age_days': 8.5, 'message': 'Bank transfer still unpaid 8 full days after the order.'}]),
        'actuals': pd.DataFrame([{'level': 'product', 'key': '7', 'week_start': pd.Timestamp('2026-10-05'), 'units': 4.0, 'censored': False},
                                 {'level': 'product', 'key': '7', 'week_start': pd.Timestamp('2026-10-12'), 'units': 2.0, 'censored': True},
                                 {'level': 'total', 'key': 'total', 'week_start': pd.Timestamp('2026-10-05'), 'units': 4.0, 'censored': False}]),
        'health_monthly': pd.DataFrame([{'month': '2026-09', 'revenue': revenue, 'closed_orders': 3, 'spending': 400.0, 'cogs': 500.0,
                                         'closed_units': 4.0, 'units_without_cost': 0, 'complete': True, 'net_cash': revenue - 400, 'net_margin': revenue - 500,
                                         'revenue_ma3': float('nan'), 'net_cash_ma3': float('nan'), 'net_margin_ma3': float('nan'), 'flags': ''}]),
    }
    meta = {'engine_version': version, 'source_db': 'clothcraft_sim2', 'module_version': '19.0.1.0.0', 'simulated': simulated,
            'label': B.SIMULATED_LABEL if simulated else None, 'closed_rule': 'delivered_and_paid',
            'closed_rule_text': 'Closed = delivered and paid orders (no Closed state in this database), dated by their last delivery.',
            'as_of': '2026-10-15', 'as_of_end_utc': '2026-10-15 16:00:00', 'params': {'min_sale_weeks': 16},
            'libraries': {'pandas': pd.__version__}, 'input_fingerprint': 'a' * 64, 'created_at_utc': '2026-10-26T00:00:00+00:00',
            'status': {'forecast': {'status': 'ok'}}}
    summary = {'selection': {'chosen': 'ets'}, 'forecast_notes': ['Simulated data'], 'health': {'trend': {'label': 'growing'}}}
    return {'meta': meta, 'tables': t, 'summary': summary}


@tagged('post_install', '-at_install', 'clothcraft_dss')
class TestDssImport(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Run = cls.env['clothcraft.dss.run']
        cls.admin = new_test_user(cls.env, login='imp_admin', groups='base.group_user,clothcraft.group_admin')
        cls.staff = new_test_user(cls.env, login='imp_staff', groups='base.group_user,clothcraft.group_inventory')

    def setUp(self):
        super().setUp()
        self.root = tempfile.mkdtemp(prefix='dss-bundles-')
        self.addCleanup(shutil.rmtree, self.root, True)
        patcher = patch('odoo.addons.clothcraft_dss.models.dss_import.BUNDLE_ROOT', self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.env['ir.config_parameter'].sudo().set_param(SWITCH, '1')    # the import tests run with the switch on (B8 S4a)

    def bundle(self, name='b1', **kw):
        path = os.path.join(self.root, name)
        manifest = B.write_bundle(path, make_result(**kw))
        return path, manifest

    def import_as_admin(self, path):
        return self.Run.with_user(self.admin)._import_bundle(path)

    def refused(self, path, words, user=None):
        before = self.Run.search_count([])
        with self.assertRaises(UserError) as ctx:
            (self.Run.with_user(user) if user else self.Run.with_user(self.admin))._import_bundle(path)
        self.assertIn(words, str(ctx.exception))
        self.assertEqual(self.Run.search_count([]), before, 'a refused import writes no run')

    # ---- the good path
    def test_a_good_import(self):
        path, manifest = self.bundle()
        run = self.import_as_admin(path)
        self.assertEqual(run.state, 'done', run.error)
        self.assertEqual((run.trigger, run.simulated, run.label), ('import', True, B.SIMULATED_LABEL))
        self.assertEqual((run.closed_rule, run.source_db, run.as_of.isoformat()), ('delivered_and_paid', 'clothcraft_sim2', '2026-10-15'))
        self.assertEqual(run.bundle_sha256, manifest['bundle_sha256'])
        self.assertEqual(run.requested_by_name, self.admin.name)
        self.assertEqual(len(run.output_hash), 64)
        for name, model in OUTPUT_MODELS.items():
            self.assertEqual(self.env[model].search_count([('run_id', '=', run.id)]), manifest['files'][f'{name}.csv.gz']['rows'], name)
        self.assertEqual(run.row_counts['segments'], 2)
        self.assertEqual(run.summary['segment_summary'][0]['segment'], 'champions')
        restock = run.restock_ids
        self.assertEqual((restock.product_key, restock.supplier_key, restock.supplier, restock.runout_date.isoformat()),
                         (70, 11, 'Sample Mills', '2026-10-23'))
        total = run.forecast_ids.filtered(lambda f: f.level == 'total')
        self.assertFalse(total.has_interval)
        self.assertFalse(run.health_ids.has_ma3)

    def test_the_weekly_actuals_are_written(self):
        path, manifest = self.bundle()
        run = self.import_as_admin(path)
        self.assertEqual(manifest['files']['actuals.csv.gz']['rows'], 3)
        rows = [(a.level, a.key, a.week_start.isoformat(), a.units, a.censored) for a in run.actual_ids.sorted(lambda a: (a.level, a.week_start))]
        self.assertEqual(rows, [('product', '7', '2026-10-05', 4.0, False), ('product', '7', '2026-10-12', 2.0, True),
                                ('total', 'total', '2026-10-05', 4.0, False)])
        self.assertEqual(run.row_counts['actuals'], 3)

    def test_the_output_hash_is_deterministic_and_covers_the_actuals(self):
        Run = self.Run.with_user(self.admin)

        def output_hash(path):
            return Run._dss_output_hash(Run._import_load(path, Run._import_read_manifest(path)))
        first, again = output_hash(self.bundle('h1')[0]), output_hash(self.bundle('h2')[0])
        self.assertEqual(first, again)                                                 # the same content: the same hash
        res = make_result()
        res['tables']['actuals'].loc[0, 'units'] = 5.0                                 # only the actuals differ
        path = os.path.join(self.root, 'h3')
        B.write_bundle(path, res)
        self.assertNotEqual(output_hash(path), first)

    def test_an_old_bundle_without_actuals_is_refused(self):
        path, _ = self.bundle('b_s1', version='B8-S1')
        self.refused(path, 'regenerate it with the current engine (B8-S4)')

    # ---- the switch (B8 S4a)
    def test_import_is_refused_while_switched_off(self):
        path, _ = self.bundle()
        for value in (False, '0', 'true', ' 1'):                                    # only exactly '1' switches it on
            self.env['ir.config_parameter'].sudo().set_param(SWITCH, value)
            self.refused(path, 'Bundle import is switched off on this database.')
        with self.assertRaises(UserError):
            self.Run.with_user(self.admin).action_import_bundle()

    def test_the_button_is_in_the_view_only_while_switched_on(self):
        def has_button():
            arch = self.Run.with_user(self.admin).get_views([(False, 'list')])['views']['list']['arch']
            return 'action_import_bundle' in arch
        self.assertTrue(has_button())
        self.env['ir.config_parameter'].sudo().set_param(SWITCH, False)
        self.assertFalse(has_button())
        self.assertIn('action_run_now', self.Run.with_user(self.admin).get_views([(False, 'list')])['views']['list']['arch'])
        self.env['ir.config_parameter'].sudo().set_param(SWITCH, '1')
        self.assertTrue(has_button())

    def test_customers_are_stored_only_as_pseudonymous_keys(self):
        run = self.import_as_admin(self.bundle()[0])
        segs = run.segment_ids
        self.assertEqual(set(segs.mapped('partner_key')), {0})
        self.assertTrue(all(k.startswith('c_') and len(k) == 18 for k in segs.mapped('customer_key')))
        self.assertIn(B.pseudonym('clothcraft_sim2', 42), segs.mapped('customer_key'))      # a plain id in the bundle is pseudonymised
        self.assertNotIn('42', segs.mapped('customer_key'))

    # ---- refusals
    def test_a_tampered_file_is_refused(self):
        path, _ = self.bundle()
        with open(os.path.join(path, 'summary.json'), 'a', encoding='utf-8') as fh:
            fh.write(' ')
        self.refused(path, 'failed its checksums')

    def test_a_tampered_table_is_refused(self):
        path, _ = self.bundle()
        f = os.path.join(path, 'alerts.csv.gz')
        data = bytearray(open(f, 'rb').read())
        data[-5] ^= 0xFF
        open(f, 'wb').write(bytes(data))
        self.refused(path, 'failed its checksums')

    def test_a_missing_or_malformed_checksum_is_refused(self):
        path, manifest = self.bundle()
        manifest['files']['health_monthly.csv.gz'].pop('sha256')
        json.dump(manifest, open(os.path.join(path, 'manifest.json'), 'w'))
        self.refused(path, 'missing or malformed checksum')

    def test_a_missing_manifest_or_unknown_version_is_refused(self):
        path, _ = self.bundle('b_old', version='B7')
        self.refused(path, 'Unknown bundle version')
        os.remove(os.path.join(path, 'manifest.json'))
        self.refused(path, 'no manifest.json')

    def test_extra_or_missing_files_are_refused(self):
        path, _ = self.bundle()
        open(os.path.join(path, 'extra.txt'), 'w').write('x')
        self.refused(path, 'unexpected: extra.txt')
        os.remove(os.path.join(path, 'extra.txt'))
        os.remove(os.path.join(path, 'alerts.csv.gz'))
        self.refused(path, 'missing: alerts.csv.gz')

    def test_a_path_outside_the_allowed_folder_is_refused(self):
        path, _ = self.bundle()
        self.refused('/etc', 'directly under')
        self.refused(os.path.join(self.root, 'b1', '..', '..', 'tmp'), 'directly under')
        self.refused(os.path.join(self.root, 'nothing-here'), 'No bundle folder')

    def test_a_bundle_not_marked_simulated_is_refused_outside_the_demo_database(self):
        path, _ = self.bundle('b_real', simulated=False)
        self.refused(path, 'not marked simulated')
        with patch('odoo.addons.clothcraft_dss.models.dss_import.DEMO_DB', self.env.cr.dbname):
            run = self.import_as_admin(path)
        self.assertEqual((run.state, run.simulated, run.label), ('done', True, B.SIMULATED_LABEL))     # still labelled simulated

    def test_a_duplicate_is_refused(self):
        first = self.import_as_admin(self.bundle('b1')[0])
        self.assertEqual(first.state, 'done', first.error)
        self.refused(self.bundle('b1_copy')[0], f'already imported as {first.display_name}')
        other = self.import_as_admin(self.bundle('b2', revenue=2000.0)[0])          # different content: a new run
        self.assertEqual(other.state, 'done', other.error)

    def test_a_non_administrator_is_refused(self):
        path, _ = self.bundle()
        with self.assertRaises(AccessError):
            self.Run.with_user(self.staff)._import_bundle(path)
        with self.assertRaises(AccessError):
            self.Run.with_user(self.staff).action_import_bundle()
        with self.assertRaises(AccessError):
            self.env['clothcraft.dss.import.wizard'].with_user(self.staff).create({'path': path})

    def test_a_failed_import_leaves_no_output(self):
        real = ClothcraftDssRun._dss_write_table

        def write_then_fail(run, model, rows):
            if model == 'clothcraft.dss.health':
                raise RuntimeError('forced failure while importing')
            return real(run, model, rows)
        with patch.object(ClothcraftDssRun, '_dss_write_table', write_then_fail):
            run = self.import_as_admin(self.bundle()[0])
        self.assertEqual(run.state, 'failed')
        self.assertIn('forced failure', run.error)
        for model in OUTPUT_MODELS.values():
            self.assertEqual(self.env[model].search_count([('run_id', '=', run.id)]), 0, model)

    # ---- reading
    def test_an_imported_run_is_read_by_the_administrator_only(self):
        run = self.import_as_admin(self.bundle()[0])
        self.assertEqual(self.Run.with_user(self.admin).search([('id', '=', run.id)]), run)
        with self.assertRaises(AccessError):
            self.Run.with_user(self.staff).search([('id', '=', run.id)])
        with self.assertRaises(AccessError):
            self.env['clothcraft.dss.segment'].with_user(self.staff).search([('run_id', '=', run.id)])

    def test_latest_keeps_real_and_simulated_apart(self):
        real = self.Run._run('manual')                   # this database's own (real) run
        self.assertEqual(real.state, 'done', real.error)
        imported = self.import_as_admin(self.bundle()[0])  # newer, but simulated
        self.assertEqual(self.Run._latest_done(), real)
        self.assertEqual(self.Run._latest_done(simulated=True), imported)

    def test_the_wizard_imports_for_the_administrator(self):
        path, _ = self.bundle()
        wiz = self.env['clothcraft.dss.import.wizard'].with_user(self.admin).create({'path': path})
        action = wiz.action_import()
        run = self.Run.browse(action['res_id'])
        self.assertEqual((run.state, run.trigger), ('done', 'import'))
