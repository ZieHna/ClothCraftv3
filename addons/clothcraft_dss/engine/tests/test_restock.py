"""Unit tests for engine/restock.py (B8 S1). Hand-built inputs; expected values worked out by hand.

    cd addons/clothcraft_dss && python3 -m unittest discover -s engine/tests -t .
"""
import json
import math
import unittest

import numpy as np
import pandas as pd

from engine import restock as R

TS = pd.Timestamp
THU = TS('2026-10-15')            # a Thursday
P = {'review_days': 7, 'service_level': 0.90, 'cap_weeks': 12}


def flat(per_day, days=60):
    a = np.full(days, float(per_day))
    return a, a.copy()


class CurrentWeek(unittest.TestCase):
    def test_remaining_days_of_the_current_week(self):
        self.assertEqual(R.remaining_days_in_week(THU), 3)                      # Fri, Sat, Sun
        self.assertEqual(R.remaining_days_in_week(TS('2026-10-18')), 0)         # Sunday: the week is over
        self.assertEqual(R.remaining_days_in_week(TS('2026-10-12')), 6)         # Monday

    def test_only_the_remaining_days_of_the_current_week_count(self):
        weeks = {TS('2026-10-12'): 7.0, TS('2026-10-19'): 14.0}
        daily, ext = R.daily_series(weeks, THU, 5)
        np.testing.assert_allclose(daily, [1, 1, 1, 2, 2])                       # 3 days of this week at 1/day, then 2/day
        self.assertAlmostEqual(daily[:R.remaining_days_in_week(THU)].sum(), 3.0)  # not the whole week's 7
        self.assertFalse(ext)

    def test_past_the_last_week_the_last_rate_is_used_and_flagged(self):
        daily, ext = R.daily_series({TS('2026-10-12'): 7.0}, THU, 6)
        np.testing.assert_allclose(daily, [1] * 6)
        self.assertTrue(ext)


class Recommend(unittest.TestCase):
    def test_order_by_date_in_the_future(self):
        # position 30, 2 a day, no safety stock, lead 5: covered 15 days, out on day 16; reaches SS (0) on day 15 -> order by day 10
        d, dh = flat(2)
        r = R.recommend(30, 0, d, dh, 0.0, 5, THU, P)
        self.assertEqual(r['days_left'], 15)
        self.assertEqual(r['runout_date'], THU + pd.Timedelta(days=16))
        self.assertEqual(r['order_by'], THU + pd.Timedelta(days=10))
        self.assertFalse(r['order_now'])
        self.assertFalse(r['stockout_before_arrival'])
        self.assertEqual(r['suggested_qty'], 0)                       # S = demand over 5 + 7 days = 24 < 30
        self.assertEqual(r['status'], 'plan')

    def test_order_now_when_the_order_by_day_has_passed(self):
        # position 8, 2 a day, lead 5: reaches 0 on day 4 -> order by day -1 -> order now (shown as the as-of day)
        d, dh = flat(2)
        r = R.recommend(8, 0, d, dh, 0.0, 5, THU, P)
        self.assertTrue(r['order_now'])
        self.assertEqual(r['order_by'], THU)
        self.assertEqual(r['suggested_qty'], 16)                      # 24 - 8
        self.assertEqual(r['status'], 'order_now')
        self.assertFalse(r['stockout_before_arrival'])                # arrives day 5 = the run-out day 5, not after it

    def test_stockout_likely_before_arrival(self):
        d, dh = flat(2)
        r = R.recommend(4, 0, d, dh, 0.0, 5, THU, P)                  # out on day 3, an order today arrives on day 5
        self.assertEqual(r['days_left'], 2)
        self.assertTrue(r['stockout_before_arrival'])
        self.assertTrue(r['order_now'])

    def test_incoming_counts_in_the_position(self):
        d, dh = flat(2)
        self.assertFalse(R.recommend(4, 26, d, dh, 0.0, 5, THU, P)['order_now'])

    def test_safety_stock_formula(self):
        d, dh = flat(1)
        r = R.recommend(100, 0, d, dh, 7.0, 7, THU, P)
        self.assertAlmostEqual(r['safety_stock'], 1.2815515655 * 7 * math.sqrt(14 / 7), places=6)
        self.assertAlmostEqual(r['reorder_point'], 7 + r['safety_stock'], places=6)
        self.assertAlmostEqual(r['order_up_to'], 14 + r['safety_stock'], places=6)

    def test_lead_time_rounds_up_to_whole_days(self):
        d, dh = flat(1)
        self.assertEqual(R.recommend(100, 0, d, dh, 0.0, 4.2, THU, P)['lead_days'], 5)

    def test_cap_and_supplier_minimum(self):
        d, dh = flat(1)
        r = R.recommend(0, 0, d, dh, 0.0, 30, THU, {**P, 'cap_weeks': 2})
        self.assertEqual(r['suggested_qty'], 14)                      # 37 wanted, capped at 2 weeks x 7
        self.assertTrue(r['capped'])
        self.assertEqual(R.recommend(9, 0, d, dh, 0.0, 5, THU, P, min_qty=10)['suggested_qty'], 10)    # 3 wanted, raised to 10

    def test_pessimistic_runout_uses_the_upper_bound(self):
        d, _ = flat(2)
        r = R.recommend(30, 0, d, np.full(60, 3.0), 0.0, 5, THU, P)
        self.assertEqual(r['runout_date_hi80'], THU + pd.Timedelta(days=11))     # 3 a day: 33 > 30 on day 11

    def test_no_demand(self):
        d, dh = flat(0)
        r = R.recommend(5, 0, d, dh, 0.0, 5, THU, P)
        self.assertEqual(r['status'], 'no_demand')
        self.assertIsNone(r['days_left'])


class LeadTimes(unittest.TestCase):
    def test_history_needs_three_receipts_else_delay_else_default(self):
        lt = pd.DataFrame({'supplier_id': [1, 2], 'n': [3, 2], 'median': [8.0, 5.0], 'p90': [11.0, 6.0]})
        leads = R.lead_times(lt, {2: 9, 3: 12})
        self.assertEqual(leads[1], (8.0, 11.0, 'history'))
        self.assertEqual(leads[2], (9.0, 9.0, 'supplierinfo_delay'))   # 2 receipts are too few
        self.assertEqual(leads[3], (12.0, 12.0, 'supplierinfo_delay'))
        self.assertNotIn(4, leads)                                     # build() then uses the default


class SupplierChoice(unittest.TestCase):
    def setUp(self):
        self.cat = pd.DataFrame([{'product_id': 10, 'template_id': 1, 'sku': 'S-RED-M', 'template_name': 'Tee', 'garment': True, 'active': True,
                                  'garment_type_id': 5, 'garment_type_code': 'TEE'}])
        self.va = pd.DataFrame([{'product_id': 10, 'size_value_id': 100, 'size': 'M', 'color_value_id': 200, 'color': 'Red'}])
        self.quants = pd.DataFrame([{'product_id': 10, 'on_hand': 3.0, 'reserved': 0.0}])
        self.shares = pd.DataFrame([{'product_id': 10, 'share': 1.0}])
        self.fc = pd.DataFrame([{'level': 'product', 'key': 1, 'week_start': TS('2026-10-12') + pd.Timedelta(weeks=i), 'yhat': 14.0, 'hi80': 21.0}
                                for i in range(8)])
        self.sup = pd.DataFrame([
            {'supplier_id': 1, 'partner_id': 11, 'name': 'Cheap', 'active': True, 'permanently_off': False, 'ships': False, 'shipping_fee': 0.0, 'opening_balance': 0.0},
            {'supplier_id': 2, 'partner_id': 12, 'name': 'Mid', 'active': True, 'permanently_off': False, 'ships': True, 'shipping_fee': 50.0, 'opening_balance': 0.0},
            {'supplier_id': 3, 'partner_id': 13, 'name': 'Off', 'active': True, 'permanently_off': True, 'ships': False, 'shipping_fee': 0.0, 'opening_balance': 0.0},
        ])
        self.lines = pd.DataFrame([{'supplier_id': s, 'garment_type_id': 5, 'size_value_id': 100, 'color_value_id': 200, 'unit_cost': c}
                                   for s, c in ((1, 100.0), (2, 101.0), (3, 50.0))])

    def run_build(self, unavailable, on_hand=3.0, leads=None):
        variants = self.cat[['product_id', 'template_id', 'garment_type_id']].merge(self.va, on='product_id')
        cands = R.candidates(variants, self.sup, self.lines, unavailable, pd.DataFrame(), THU)
        leads = leads or {1: (5.0, 6.0, 'history'), 2: (5.0, 6.0, 'history')}
        quants = self.quants.assign(on_hand=on_hand)
        return R.build(self.cat, self.va, quants, pd.Series(dtype=float), self.shares, self.fc, pd.Series({1: 2.0}), cands, leads, THU, P).iloc[0]

    NO_RANGES = pd.DataFrame(columns=['supplier_id', 'date_from', 'date_to'])

    def test_cheapest_landed_cost_among_eligible(self):
        row = self.run_build(self.NO_RANGES)                         # 3 on hand at 2 a day: neither arrives in time, so cost decides
        self.assertEqual(row['supplier'], 'Cheap')                     # 'Off' is cheaper but permanently off
        alts = json.loads(row['alternatives'])
        self.assertIn('unavailable_now', [a for x in alts if x['supplier'] == 'Off' for a in x['ineligible']])

    def test_an_unavailable_range_over_the_arrival_moves_the_choice(self):
        un = pd.DataFrame([{'supplier_id': 1, 'date_from': THU + pd.Timedelta(days=4), 'date_to': THU + pd.Timedelta(days=30)}])
        row = self.run_build(un)
        self.assertEqual(row['supplier'], 'Mid')
        self.assertAlmostEqual(row['landed_unit_cost'], round(101.0 + 50.0 / row['suggested_qty'], 2))
        self.assertTrue(row['order_now'])                              # 3 on hand at 2 a day

    def test_a_supplier_that_arrives_in_time_beats_a_cheaper_late_one(self):
        # 20 on hand at 2 a day: out on day 11. Cheap arrives on day 15 (late), Mid on day 6 (in time)
        row = self.run_build(self.NO_RANGES, on_hand=20.0, leads={1: (12.0, 15.0, 'history'), 2: (5.0, 6.0, 'history')})
        self.assertEqual(row['supplier'], 'Mid')
        self.assertTrue(row['arrives_before_runout'])
        self.assertFalse(row['coverage_risk'])
        cheap = [a for a in json.loads(row['alternatives']) if a['supplier'] == 'Cheap'][0]
        self.assertFalse(cheap['arrives_before_runout'])
        self.assertTrue(cheap['coverage_risk'])

    def test_when_both_arrive_in_time_the_cheaper_wins(self):
        row = self.run_build(self.NO_RANGES, on_hand=20.0, leads={1: (6.0, 8.0, 'history'), 2: (5.0, 6.0, 'history')})
        self.assertEqual(row['supplier'], 'Cheap')

    def test_arriving_on_the_run_out_day_is_not_before_it(self):
        d, dh = flat(2)
        r = R.recommend(10, 0, d, dh, 0.0, 6, THU, P)                 # out on day 6, arrives on day 6
        self.assertFalse(r['arrives_before_runout'])
        self.assertFalse(r['stockout_before_arrival'])
        self.assertTrue(R.recommend(10, 0, d, dh, 0.0, 5, THU, P)['arrives_before_runout'])


if __name__ == '__main__':
    unittest.main()
