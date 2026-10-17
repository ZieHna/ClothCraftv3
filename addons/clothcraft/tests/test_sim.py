"""Tests for the demand simulation (clothcraft/sim), on the 'tiny' preset: two products, ten customers, five weeks.

THROWAWAY DATABASE ONLY. Each test class seeds, purges and re-seeds inside one transaction that is rolled back at
the end (nothing is committed), but a seed runs heavy SQL, freezes the clock, enables the Wire Transfer provider
and takes tens of seconds, so never run these on the live "clothcraft" database or on one that holds a real seed:
they skip themselves if the database is a protected one or already carries a simulation marker. They need the
Philippine setup (PHP, see the README) like the other tests, and make their own tiny image files, so the usual
test command works without mounting assets-v1.
"""
import csv
import os
import shutil
import tempfile
import unittest
from collections import defaultdict
from unittest.mock import patch

from PIL import Image

from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged

from odoo.addons.clothcraft.sim import backfill, demand, purge, seeder
from odoo.addons.clothcraft.sim.data import MARKER_PARAM, PRESETS, PRODUCTS, PROTECTED_DBS, SIM_LABEL
from odoo.addons.clothcraft.sim.loop import Simulation
from odoo.addons.clothcraft.sim.variants import opening_plan, variant_table
from odoo.addons.clothcraft.sim.world import MemWorld

PRESET, SEED = 'tiny', 7


def make_assets(preset):
    """A folder with a tiny PNG at every image path the preset's products use."""
    folder = tempfile.mkdtemp(prefix='sim-assets-')
    for key in PRESETS[preset]['products']:
        path = os.path.join(folder, PRODUCTS[key]['image'])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Image.new('RGB', (32, 32), 'white').save(path, 'PNG')
    return folder


def table_counts(env):
    env.cr.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
    counts = {}
    for (table,) in env.cr.fetchall():
        env.cr.execute(f'SELECT COUNT(*) FROM "{table}"')
        counts[table] = env.cr.fetchone()[0]
    return counts


class SimCase(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        if env.cr.dbname in PROTECTED_DBS:
            raise unittest.SkipTest("never run the simulation tests on the live database")
        if env.company.currency_id.name != 'PHP':
            raise unittest.SkipTest("the simulation needs the Philippine (PHP) database")
        if env['ir.config_parameter'].sudo().get_param(MARKER_PARAM):
            raise unittest.SkipTest("this database already holds a simulation seed")
        cls.assets = make_assets(PRESET)
        cls.addClassCleanup(shutil.rmtree, cls.assets, True)
        cls.cfg = PRESETS[PRESET]

    def seed(self, seed=SEED, out_dir=None):
        result = seeder.run(self.env, PRESET, seed, self.assets, out_dir=out_dir)
        result.pop('simulation')
        result.pop('world')
        return result


@tagged('post_install', '-at_install', 'clothcraft')
class TestSimSeed(SimCase):
    """One seed, many properties."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.out_dir = tempfile.mkdtemp(prefix='sim-out-')
        cls.addClassCleanup(shutil.rmtree, cls.out_dir, True)
        cls.stale_before = backfill.unstamped(env)
        env.cr.execute("SELECT COALESCE(MAX(id), 0) FROM res_partner")
        cls.max_partner = env.cr.fetchone()[0]
        env.cr.execute("SELECT COALESCE(MAX(id), 0) FROM product_template")
        cls.max_template = env.cr.fetchone()[0]
        env.cr.execute("SELECT COALESCE(MAX(id), 0) FROM stock_lot")
        cls.max_lot = env.cr.fetchone()[0]
        env.cr.execute("SELECT COALESCE(MAX(id), 0) FROM sale_order")
        cls.max_order = env.cr.fetchone()[0]
        env.cr.execute("SELECT COALESCE(MAX(id), 0) FROM purchase_order")
        cls.max_purchase = env.cr.fetchone()[0]

        # watch every confirmation: the guard must run for each, and none may go through with too little stock
        SaleOrder = env.registry['sale.order']
        original_confirm, original_check = SaleOrder.action_confirm, SaleOrder._clothcraft_check_stock
        spy = cls.spy = {'confirm': 0, 'check': 0, 'short': [], 'negative': []}

        def free(order, product):
            product.invalidate_recordset(['free_qty'])
            return product.with_context(warehouse_id=order.warehouse_id.id).free_qty

        def confirm(orders, *args, **kwargs):
            spy['confirm'] += len(orders)
            short = []
            for order in orders:
                needed = defaultdict(float)
                for line in order.order_line:
                    if line.product_id.is_storable and not line.product_id.allow_out_of_stock_order:
                        needed[line.product_id] += line.product_uom_qty
                for product, quantity in needed.items():
                    if free(order, product) < quantity:
                        short.append((order.id, product.default_code, quantity))
            result = original_confirm(orders, *args, **kwargs)     # raises when stock is short: then nothing below runs
            spy['short'] += short
            for order in orders:
                for product in order.order_line.product_id:
                    if free(order, product) < 0:
                        spy['negative'].append((order.id, product.default_code))
            return result

        def check(orders, *args, **kwargs):
            spy['check'] += 1
            return original_check(orders, *args, **kwargs)

        with patch.object(SaleOrder, 'action_confirm', confirm), patch.object(SaleOrder, '_clothcraft_check_stock', check):
            cls.result = seeder.run(env, PRESET, SEED, cls.assets, out_dir=cls.out_dir)
        cls.simulation = cls.result.pop('simulation')
        cls.world = cls.result.pop('world')
        cls.label_tag = env['crm.tag'].search([('name', '=', SIM_LABEL)])

    def _scalar(self, sql, params=()):
        self.env.cr.execute(sql, params)
        return self.env.cr.fetchone()[0]

    def test_the_run_is_rich_enough_for_the_other_tests_to_mean_something(self):
        result = self.result
        self.assertGreaterEqual(result['orders'], 20)
        self.assertGreaterEqual(result['deliveries'], 10)
        self.assertGreaterEqual(result['receipts'], 1, "at least one replenishment receipt after the opening stock")
        self.assertGreaterEqual(result['lost_rows'], 5, "a stock-out with lost demand")
        self.assertGreaterEqual(result['cancelled'], 1)
        self.assertGreaterEqual(result['stuck'], 1, "an unpaid bank transfer left stuck")

    def test_the_stock_guard_runs_for_every_confirmed_order(self):
        confirmed = self.result['sale_orders']['sale'] + self.result['sale_orders']['cancel']
        self.assertEqual(self.spy['confirm'], confirmed + self.result['guard_refusals'])
        self.assertEqual(self.spy['check'], self.spy['confirm'], "every action_confirm went through the guard")
        self.assertEqual(self.result['guard_refusals'], 0, "the seeder checks free stock itself, the guard never has to refuse")

    def test_nothing_is_confirmed_past_free_stock_and_free_stock_never_goes_negative(self):
        self.assertEqual(self.spy['short'], [])
        self.assertEqual(self.spy['negative'], [])
        self.assertEqual(self._scalar("""
            SELECT COUNT(*) FROM stock_quant q JOIN stock_location l ON l.id = q.location_id
             WHERE l.usage = 'internal' AND (q.quantity < 0 OR q.reserved_quantity > q.quantity)"""), 0)

    def test_quantities_add_up(self):
        ordered = self._scalar("""
            SELECT COALESCE(SUM(l.product_uom_qty), 0) FROM sale_order_line l JOIN sale_order so ON so.id = l.order_id
             WHERE so.state = 'sale' AND so.id > %s""", (self.max_order,))
        moves = """FROM stock_move sm JOIN sale_order_line l ON l.id = sm.sale_line_id JOIN sale_order so ON so.id = l.order_id
                    WHERE so.state = 'sale' AND so.id > %s"""
        delivered = self._scalar("SELECT COALESCE(SUM(sm.quantity), 0) " + moves + " AND sm.state = 'done'", (self.max_order,))
        waiting = self._scalar("SELECT COALESCE(SUM(sm.product_uom_qty), 0) " + moves
                               + " AND sm.state IN ('assigned', 'confirmed', 'partially_available')", (self.max_order,))
        self.assertGreater(ordered, 0)
        self.assertEqual(ordered, delivered + waiting, "ordered = delivered + reserved")
        received = self._scalar("""
            SELECT COALESCE(SUM(l.qty_received), 0) FROM purchase_order_line l JOIN purchase_order po ON po.id = l.order_id
             WHERE po.origin = 'SIM' AND po.id > %s""", (self.max_purchase,))
        shipped = self._scalar("""
            SELECT COALESCE(SUM(sm.quantity), 0) FROM stock_move sm JOIN stock_location d ON d.id = sm.location_dest_id
             WHERE sm.state = 'done' AND d.usage = 'customer' AND sm.sale_line_id IN (
                   SELECT l.id FROM sale_order_line l WHERE l.order_id > %s)""", (self.max_order,))
        on_hand = self._scalar("""
            SELECT COALESCE(SUM(q.quantity), 0) FROM stock_quant q JOIN stock_location l ON l.id = q.location_id
              JOIN product_product pp ON pp.id = q.product_id WHERE l.usage = 'internal' AND pp.default_code LIKE 'SIM-%%'""")
        self.assertEqual(received - shipped, on_hand, "received - delivered = on hand")

    def test_everything_simulated_is_labelled(self):
        env = self.env
        partners = env['res.partner'].search([('id', '>', self.max_partner), ('is_company', '=', True)])
        customers = env['res.partner'].search([('id', '>', self.max_partner), ('email', '=like', 'sim.customer%@example.com')])
        self.assertTrue(partners and customers)
        for record in partners | customers:
            self.assertIn(SIM_LABEL, record.category_id.mapped('name'), record.name)
        templates = env['product.template'].search([('id', '>', self.max_template)])
        self.assertTrue(templates)
        for template in templates:
            self.assertIn(SIM_LABEL, template.product_tag_ids.mapped('name'), template.name)
        orders = env['sale.order'].search([('id', '>', self.max_order)])
        self.assertTrue(orders)
        for order in orders:
            self.assertIn(self.label_tag, order.tag_ids, order.name)
        purchases = env['purchase.order'].search([('id', '>', self.max_purchase)])
        self.assertTrue(purchases)
        self.assertEqual(set(purchases.mapped('origin')), {'SIM'})
        lots = env['stock.lot'].search([('id', '>', self.max_lot)])
        self.assertTrue(lots)
        for lot in lots:
            self.assertTrue(lot.name.startswith('SIM-'), lot.name)
        for address in customers:
            self.assertTrue(address.email.endswith('@example.com'), "only reserved-domain emails")

    def test_no_simulated_payment_transaction_is_left_unprocessed(self):
        transactions = self.env['payment.transaction'].search([('sale_order_ids.tag_ids', 'in', self.label_tag.ids)])
        self.assertEqual(len(transactions), self.result['sale_orders']['sale'] + self.result['sale_orders']['cancel'])
        self.assertEqual(transactions.filtered(lambda t: not t.is_post_processed).ids, [])
        self.assertGreater(self.world.transaction_changes, 0)

    def test_no_simulated_row_is_dated_at_or_after_the_seed_start(self):
        now = {table: count for table, count in backfill.unstamped(self.env).items()}
        newly_stale = {t: n - self.stale_before.get(t, 0) for t, n in now.items() if n > self.stale_before.get(t, 0)}
        self.assertEqual(newly_stale, {}, "the backfill left rows with the real clock")
        self.assertGreater(sum(self.result['backfill'].values()), 0)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM clothcraft_price_history WHERE product_tmpl_id > %s AND create_date >= %s",
                                      (self.max_template, self.env.cr.now())), 0)

    def test_dates_are_sane(self):
        start, end = self.cfg['start'], self.cfg['end']
        first, last = self._scalar("SELECT MIN(date_order) FROM sale_order WHERE id > %s", (self.max_order,)), \
            self._scalar("SELECT MAX(date_order) FROM sale_order WHERE id > %s", (self.max_order,))
        self.assertGreaterEqual(first.date(), start)
        self.assertLessEqual(last.date(), end)
        self.assertEqual(self._scalar("""
            SELECT COUNT(*) FROM (
              SELECT sm.product_id, MIN(sp.date_done) AS first_out FROM stock_move sm JOIN stock_picking sp ON sp.id = sm.picking_id
                JOIN stock_location d ON d.id = sm.location_dest_id WHERE sm.state = 'done' AND d.usage = 'customer' GROUP BY 1) o
              JOIN (SELECT sm.product_id, MIN(sp.date_done) AS first_in FROM stock_move sm JOIN stock_picking sp ON sp.id = sm.picking_id
                JOIN stock_location s ON s.id = sm.location_id WHERE sm.state = 'done' AND s.usage = 'supplier' GROUP BY 1) i
                ON i.product_id = o.product_id WHERE o.first_out < i.first_in"""), 0, "a variant was delivered before it was received")
        self.assertEqual(self._scalar("""
            SELECT COUNT(*) FROM stock_picking sp JOIN purchase_order_stock_picking_rel r ON r.stock_picking_id = sp.id
              JOIN purchase_order po ON po.id = r.purchase_order_id
             WHERE sp.state = 'done' AND po.origin = 'SIM' AND po.id > %s AND sp.date_done <= po.date_approve""", (self.max_purchase,)), 0,
            "lead times must be positive")
        self.assertGreaterEqual(self._scalar("""
            SELECT COUNT(*) FROM stock_picking sp JOIN purchase_order_stock_picking_rel r ON r.stock_picking_id = sp.id
              JOIN purchase_order po ON po.id = r.purchase_order_id
             WHERE sp.state = 'done' AND po.origin = 'SIM' AND po.id > %s AND sp.date_done < %s""",
            (self.max_purchase, start.isoformat())), len(self.cfg['products']), "the opening stock arrives before the first day")

    def test_lost_demand_csv_matches_the_loops_counters(self):
        path = self.result['lost_demand_csv']
        self.assertEqual(path, os.path.join(self.out_dir, 'lost_demand.csv'))
        with open(path, newline='', encoding='utf-8') as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(list(rows[0]), ['date', 'variant', 'wanted', 'free'])
        self.assertEqual(len(rows), len(self.simulation.lost))
        self.assertEqual(len(rows), self.result['lost_rows'])
        unserved = sum(int(r['wanted']) - min(int(r['wanted']), int(r['free'])) for r in rows)
        share = self.simulation.lost_share()
        self.assertEqual(unserved, share['lost_units_gross'])
        self.assertLessEqual(share['lost_units_net'], unserved, "substitutions only reduce the net loss")
        self.assertEqual(sum(1 for r in rows if int(r['free']) > 0), self.result['partial_fills'],
                         "rows with some stock left are the partial fills, the rest are stock-outs")
        self.assertEqual(sum(1 for r in rows if int(r['free']) == 0), self.result['lost_rows'] - self.result['partial_fills'])

    def test_a_second_seed_run_is_refused(self):
        with self.assertRaisesRegex(UserError, "already seeded"):
            seeder.run(self.env, PRESET, SEED, self.assets)

    def test_the_database_run_agrees_with_the_in_memory_planning_pass(self):
        cfg, seed = self.cfg, SEED
        customers = demand.plan_customers(cfg, seed)
        arrivals = demand.plan_arrivals(cfg, customers, seed)
        priors = demand.priors(cfg, demand.count_orders(arrivals), variant_table(cfg['products']))
        world = MemWorld()
        for entry in opening_plan(cfg, seed, priors):
            for code, quantity in entry['lines']:
                world.add_stock(code, quantity)
        planned = Simulation(world, cfg, seed, customers, arrivals, priors)
        planned.run()
        actual = self.simulation
        keys = ('orders', 'lines', 'units', 'deliveries', 'cancelled', 'cancelled_customer', 'cancelled_staff', 'stuck',
                'purchase_orders', 'receipts', 'lost_rows', 'partial_fills', 'substitutions', 'orders_lost_entirely')
        self.assertEqual({k: planned.result()[k] for k in keys}, {k: actual.result()[k] for k in keys})
        self.assertEqual(sorted(planned.lost), sorted(actual.lost))


@tagged('post_install', '-at_install', 'clothcraft')
class TestSimLifecycle(SimCase):
    """Seed, purge and seed again."""

    def test_same_seed_same_digest_and_another_seed_another_digest(self):
        first = self.seed(SEED)['digest']
        purge.purge(self.env)
        again = self.seed(SEED)['digest']
        purge.purge(self.env)
        other = self.seed(11)['digest']
        self.assertEqual(first, again)
        self.assertNotEqual(first, other)

    def test_purge_restores_every_table_a_second_purge_does_nothing_and_a_reseed_matches(self):
        label = self.env['res.partner.category'].create({'name': SIM_LABEL})     # existed before: purge must keep it
        baseline = table_counts(self.env)
        digest = self.seed(SEED)['digest']
        self.assertNotEqual(table_counts(self.env), baseline)
        deleted = purge.purge(self.env)
        self.assertTrue(deleted)
        after = table_counts(self.env)
        self.assertEqual({t: (baseline[t], after.get(t)) for t in baseline if baseline[t] != after.get(t)}, {},
                         "every table is back to its pre-seed row count")
        self.assertTrue(label.exists(), "a label that existed before the seed is not removed")
        self.assertFalse(self.env['ir.config_parameter'].sudo().get_param(MARKER_PARAM), "the marker is gone")
        self.assertEqual(purge.purge(self.env), {}, "a second purge is a no-op, not an error")
        self.assertEqual(self.seed(SEED)['digest'], digest, "re-seeding gives the same digest")
        purge.purge(self.env)
        self.assertEqual(table_counts(self.env), baseline)


@tagged('post_install', '-at_install', 'clothcraft')
class TestSimTargets(TransactionCase):
    """Which databases may be seeded. No database work at all."""

    class _Cr:
        dbname = ''

    class _Env:
        cr = None

    def _check(self, name, backup):
        env = self._Env()
        env.cr = self._Cr()
        env.cr.dbname = name
        seeder.check_target(env, backup)

    def test_clothcraft_usd_old_is_always_refused(self):
        with tempfile.NamedTemporaryFile() as backup:
            backup.write(b'dump')
            backup.flush()
            with self.assertRaisesRegex(UserError, "never seeded"):
                self._check('clothcraft_usd_old', backup.name)

    def test_clothcraft_needs_an_existing_non_empty_backup_file(self):
        for backup in (None, '/does/not/exist'):
            with self.assertRaisesRegex(UserError, "without a backup"):
                self._check('clothcraft', backup)
        with tempfile.NamedTemporaryFile() as empty, self.assertRaisesRegex(UserError, "without a backup"):
            self._check('clothcraft', empty.name)
        with tempfile.NamedTemporaryFile() as backup:
            backup.write(b'dump')
            backup.flush()
            self._check('clothcraft', backup.name)     # allowed

    def test_other_databases_need_no_backup(self):
        self._check('clothcraft_sim', None)
