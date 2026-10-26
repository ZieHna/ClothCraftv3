"""Unit tests for engine/segments.py (B8 S1).

    cd addons/clothcraft_dss && python3 -m unittest discover -s engine/tests -t .
"""
import unittest

import pandas as pd

from engine import segments as S

END = pd.Timestamp('2026-10-15 16:00:00')      # the end of the Manila day 2026-10-15, as naive UTC


def earned(spec):
    """spec: {partner: [(days before END, amount), ...]} -> earned order rows."""
    rows, oid = [], 0
    for pid, orders in spec.items():
        for days, amount in orders:
            oid += 1
            rows.append({'order_id': oid, 'partner_id': pid, 'amount': float(amount), 'moment': END - pd.Timedelta(days=days)})
    return pd.DataFrame(rows)


class Bands(unittest.TestCase):
    def test_frequency_bands(self):
        self.assertEqual([S.f_score(n) for n in (1, 2, 3, 4, 5, 8, 9, 25)], [1, 2, 3, 3, 4, 4, 5, 5])


class Minimum(unittest.TestCase):
    def test_fewer_than_20_customers_gives_no_segments(self):
        e = earned({p: [(p, 100)] for p in range(1, 20)})
        st, table = S.score(e, list(range(1, 20)), END)
        self.assertEqual(st['status'], 'not_enough_customers')
        self.assertEqual(st['scored'], 19)
        self.assertEqual(st['min_customers'], 20)
        self.assertEqual(len(table), 0)
        self.assertEqual(len(S.summary(table)), 0)

    def test_twenty_customers_are_scored(self):
        e = earned({p: [(p, 100 * p)] for p in range(1, 21)})
        st, table = S.score(e, list(range(1, 21)), END)
        self.assertEqual(st['status'], 'ok')
        self.assertEqual(len(table), 20)
        self.assertEqual(sorted(table['r_score'].value_counts().tolist()), [4] * 5)   # quintiles: 4 customers per score


class OneOrderCustomers(unittest.TestCase):
    def test_one_order_customers_are_only_new_or_one_time_lapsed(self):
        spec = {p: [(p, 50)] for p in range(1, 16)}                               # 15 one-order customers, last order 1..15 days ago
        spec.update({p: [(d, 200) for d in range(100, 109)] for p in range(16, 26)})   # 10 nine-order customers, last order 100 days ago
        st, t = S.score(earned(spec), list(spec), END)
        one = t[t['frequency'] == 1]
        self.assertEqual(len(one), 15)
        self.assertTrue(set(one['segment']) <= {'new', 'one_time_lapsed'})
        self.assertIn('new', set(one['segment']))
        self.assertIn('one_time_lapsed', set(one['segment']))
        self.assertTrue((one.loc[one['segment'] == 'new', 'r_score'] >= 4).all())
        self.assertTrue((t.loc[t['frequency'] >= 9, 'f_score'] == 5).all())

    def test_customers_without_a_closed_order_are_counted_not_scored(self):
        e = earned({p: [(p, 100)] for p in range(1, 21)})
        st, t = S.score(e, list(range(1, 24)), END)                              # 3 confirmed customers with nothing Closed
        self.assertEqual(st['no_completed_order'], 3)
        self.assertEqual(len(t), 20)


class Rules(unittest.TestCase):
    def test_rules_in_order(self):
        self.assertEqual(S.segment_of(5, 5), 'champions')
        self.assertEqual(S.segment_of(3, 4), 'loyal')
        self.assertEqual(S.segment_of(4, 2), 'potential_loyalists')
        self.assertEqual(S.segment_of(5, 1), 'new')
        self.assertEqual(S.segment_of(1, 3), 'at_risk')
        self.assertEqual(S.segment_of(3, 1), 'one_time_lapsed')
        self.assertEqual(S.segment_of(2, 2), 'hibernating')
        self.assertEqual(S.segment_of(3, 3), 'needs_attention')

    def test_recency_and_monetary_direction_and_determinism(self):
        e = earned({p: [(p, 1000 - p)] for p in range(1, 26)})
        _, a = S.score(e, list(range(1, 26)), END)
        _, b = S.score(e.sample(frac=1, random_state=3), list(range(1, 26)), END)
        pd.testing.assert_frame_equal(a.reset_index(drop=True), b.reset_index(drop=True))
        self.assertEqual(int(a.loc[a['partner_id'] == 1, 'r_score'].iloc[0]), 5)     # most recent
        self.assertEqual(int(a.loc[a['partner_id'] == 1, 'm_score'].iloc[0]), 5)     # largest total
        self.assertEqual(int(a.loc[a['partner_id'] == 25, 'r_score'].iloc[0]), 1)
        self.assertEqual(int(a.loc[a['partner_id'] == 1, 'recency_days'].iloc[0]), 1)


if __name__ == '__main__':
    unittest.main()
