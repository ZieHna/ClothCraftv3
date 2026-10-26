"""Unit tests for engine/alerts.py (B8 S1).

    cd addons/clothcraft_dss && python3 -m unittest discover -s engine/tests -t .
"""
import unittest

import pandas as pd

from engine import alerts as A

AS_OF = pd.Timestamp('2026-10-15')
END = pd.Timestamp('2026-10-15 16:00:00')
P = {'review_days': 7}


def transfers(ages, shipped=()):
    """Confirmed orders placed `age` days before END, each with a pending wire transfer; `shipped` orders have a done picking."""
    orders = pd.DataFrame([{'order_id': i, 'partner_id': i, 'date_order': END - pd.Timedelta(days=a), 'state': 'sale', 'amount_total': 100.0}
                           for i, a in enumerate(ages, start=1)])
    txs = pd.DataFrame([{'order_id': i, 'tx_id': i, 'state': 'pending', 'create_date': END - pd.Timedelta(days=a), 'custom_mode': 'wire_transfer'}
                        for i, a in enumerate(ages, start=1)])
    pickings = pd.DataFrame([{'picking_id': i, 'order_id': i, 'state': 'done' if i in shipped else 'assigned', 'date_done': None}
                             for i in range(1, len(ages) + 1)])
    return orders, txs, pickings


class AgeBands(unittest.TestCase):
    def test_band_edges(self):
        self.assertEqual(A.band_of(2.99), (None, None))
        self.assertEqual(A.band_of(3.0)[0], 'follow_up')
        self.assertEqual(A.band_of(6.99)[0], 'follow_up')
        self.assertEqual(A.band_of(7.0)[0], 'stuck')
        self.assertEqual(A.band_of(13.99)[0], 'stuck')
        self.assertEqual(A.band_of(14.0)[0], 'admin_decide')
        self.assertEqual(A.band_of(40)[1], 'critical')

    def test_unpaid_transfers_by_age_and_shipped_ones_left_out(self):
        o, t, pk = transfers([1, 3, 5, 7, 10, 14, 20, 30], shipped={8})
        rows = A.unpaid_bank_transfers(o, t, pk, END)
        bands = {r['subject_id']: r['band'] for r in rows}
        self.assertEqual(bands, {2: 'follow_up', 3: 'follow_up', 4: 'stuck', 5: 'stuck', 6: 'admin_decide', 7: 'admin_decide'})
        self.assertNotIn(1, bands)                     # 1 day old: no alert yet
        self.assertNotIn(8, bands)                     # shipped: not an unpaid-transfer alert
        self.assertEqual(rows[0]['subject_id'], 7)     # oldest first

    def test_cash_on_delivery_and_paid_transfers_are_not_alerts(self):
        o, t, pk = transfers([10, 10])
        t.loc[0, 'custom_mode'] = 'cash_on_delivery'
        t.loc[1, 'state'] = 'done'
        self.assertEqual(A.unpaid_bank_transfers(o, t, pk, END), [])


class StockAndRestock(unittest.TestCase):
    def restock(self):
        return pd.DataFrame([
            {'product_id': 1, 'sku': 'A', 'days_left': 3, 'runout_date': AS_OF + pd.Timedelta(days=4), 'lead_days': 5, 'stockout_before_arrival': True},
            {'product_id': 2, 'sku': 'B', 'days_left': 10, 'runout_date': AS_OF + pd.Timedelta(days=11), 'lead_days': 5, 'stockout_before_arrival': False},
            {'product_id': 3, 'sku': 'C', 'days_left': 40, 'runout_date': AS_OF + pd.Timedelta(days=41), 'lead_days': 5, 'stockout_before_arrival': False},
        ])

    def test_forecast_stockout_within_lead_and_review(self):
        rows = {r['subject_id']: r['severity'] for r in A.stockouts(self.restock(), P)}
        self.assertEqual(rows, {1: 'critical', 2: 'warning'})          # 3: out on day 41, outside 5 + 7

    def test_low_stock_risk_needs_both(self):
        sa = pd.DataFrame([{'product_id': 2, 'low': True, 'since': None}, {'product_id': 9, 'low': True, 'since': None}])
        self.assertEqual([r['subject_id'] for r in A.low_stock_risk(sa, self.restock())], [2])

    def test_restock_supplier_issue_and_overdue(self):
        rs = pd.DataFrame([
            {'restock_id': 1, 'name': 'RS1', 'supplier_id': 1, 'state': 'approved', 'expected_from': pd.Timestamp('2026-10-01'), 'expected_to': pd.Timestamp('2026-10-10')},
            {'restock_id': 2, 'name': 'RS2', 'supplier_id': 2, 'state': 'approved', 'expected_from': pd.Timestamp('2026-10-20'), 'expected_to': pd.Timestamp('2026-10-25')},
            {'restock_id': 3, 'name': 'RS3', 'supplier_id': 1, 'state': 'received', 'expected_from': pd.Timestamp('2026-09-01'), 'expected_to': pd.Timestamp('2026-09-05')},
        ])
        sup = pd.DataFrame([{'supplier_id': 1, 'active': True, 'permanently_off': False}, {'supplier_id': 2, 'active': True, 'permanently_off': False}])
        un = pd.DataFrame([{'supplier_id': 2, 'date_from': '2026-10-22', 'date_to': '2026-10-31'}])
        rows = A.restock_issues(rs, sup, un, AS_OF)
        kinds = sorted((r['kind'], r['subject_id']) for r in rows)
        self.assertEqual(kinds, [('restock_overdue', 1), ('restock_supplier', 2)])
        self.assertEqual([r['age_days'] for r in rows if r['kind'] == 'restock_overdue'], [5.0])

    def test_kinds_not_available_without_the_shop_tables(self):
        o, t, pk = transfers([10])
        df, available = A.build(o, t, pk, AS_OF, END, None, pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), False, P)
        self.assertEqual(available['restock_supplier'], 'not_available_on_this_data')
        self.assertEqual(available['low_stock_risk'], 'not_available_on_this_data')
        self.assertEqual(list(df['kind']), ['unpaid_bank_transfer'])


if __name__ == '__main__':
    unittest.main()
