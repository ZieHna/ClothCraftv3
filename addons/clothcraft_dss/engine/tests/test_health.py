"""Unit tests for engine/health.py (B8 S1): the Closed rule, the monthly series, trend labels, KPIs and the projection.

    cd addons/clothcraft_dss && python3 -m unittest discover -s engine/tests -t .
"""
import unittest

import numpy as np
import pandas as pd

from engine import health as H

TS = pd.Timestamp


def series(revenue, spending, as_of='2026-10-15'):
    """A monthly frame for the months ending with the as-of month (the last value is that partial month)."""
    end = pd.Period(TS(as_of), 'M')
    months = [(end - (len(revenue) - 1 - i)).strftime('%Y-%m') for i in range(len(revenue))]
    earned = pd.DataFrame([{'order_id': i, 'partner_id': 1, 'amount': float(r), 'moment': TS(m + '-10 04:00')}
                           for i, (m, r) in enumerate(zip(months, revenue)) if r])
    sp = pd.DataFrame([{'month': m, 'amount': float(s), 'source': 'restock'} for m, s in zip(months, spending) if s],
                      columns=['month', 'amount', 'source'])
    empty_d = pd.DataFrame(columns=['month', 'product_id', 'quantity'])
    empty_c = pd.DataFrame(columns=['product_id', 'last_cost', 'cost_source'])
    return H.monthly(earned if len(earned) else pd.DataFrame(columns=['order_id', 'partner_id', 'amount', 'moment']), sp, empty_d, empty_c,
                     TS(as_of), months[0])


class Trend(unittest.TestCase):
    def test_growing(self):
        t = H.trend(series([100 * 1.1 ** i for i in range(10)], [10] * 10))
        self.assertEqual(t['label'], 'growing')
        self.assertFalse(t['warning'])

    def test_declining(self):
        self.assertEqual(H.trend(series([1000 * 0.9 ** i for i in range(10)], [10] * 10))['label'], 'declining')

    def test_stable_within_the_threshold(self):
        t = H.trend(series([1000 + (5 if i % 2 else -5) for i in range(10)], [10] * 10))
        self.assertEqual(t['label'], 'stable')
        self.assertLess(abs(t['revenue_rel_slope']), 0.02)

    def test_warning_after_three_negative_months_in_a_row(self):
        t = H.trend(series([1000] * 10, [10] * 6 + [2000, 2000, 2000, 0]))     # months 7-9 complete and negative; month 10 is partial
        self.assertTrue(t['warning'])
        self.assertEqual(t['label'], 'stable')
        self.assertFalse(H.trend(series([1000] * 10, [10] * 6 + [2000, 0, 2000, 2000]))['warning'])   # the partial month does not count

    def test_not_enough_history(self):
        t = H.trend(series([100] * 8, [0] * 8))                                   # 7 complete months: 5 three-month averages
        self.assertEqual(t['label'], 'not_enough_history')
        self.assertEqual(t['needed_complete_months'], 8)
        self.assertEqual(H.trend(series([100] * 9, [0] * 9))['label'], 'stable')   # 8 complete months is enough

    def test_partial_and_before_first_sale_flags(self):
        m = series([0, 0, 50, 60], [100, 0, 0, 0])
        m2 = H.monthly(pd.DataFrame(columns=['order_id', 'partner_id', 'amount', 'moment']),
                       pd.DataFrame([{'month': '2026-07', 'amount': 5.0, 'source': 'purchase_order'}]),
                       pd.DataFrame(columns=['month', 'product_id', 'quantity']), pd.DataFrame(columns=['product_id', 'last_cost', 'cost_source']),
                       TS('2026-10-15'), '2026-08')
        self.assertEqual(m['flags'].iloc[-1], 'partial')
        self.assertIn('before_first_sale', m2.loc[m2['month'] == '2026-07', 'flags'].iloc[0])
        self.assertFalse(bool(m['complete'].iloc[-1]))
        self.assertTrue(H.month_complete('2026-09', TS('2026-09-30')))


class ClosedRule(unittest.TestCase):
    def setUp(self):
        self.orders = pd.DataFrame([
            {'order_id': 1, 'partner_id': 10, 'date_order': TS('2026-09-01'), 'state': 'sale', 'amount_total': 100.0},
            {'order_id': 2, 'partner_id': 11, 'date_order': TS('2026-09-02'), 'state': 'sale', 'amount_total': 200.0},
            {'order_id': 3, 'partner_id': 12, 'date_order': TS('2026-09-03'), 'state': 'sale', 'amount_total': 300.0},
            {'order_id': 4, 'partner_id': 13, 'date_order': TS('2026-09-04'), 'state': 'cancel', 'amount_total': 400.0},
        ])
        self.pickings = pd.DataFrame([
            {'picking_id': 1, 'order_id': 1, 'state': 'done', 'date_done': TS('2026-09-05')},
            {'picking_id': 2, 'order_id': 2, 'state': 'done', 'date_done': TS('2026-09-06')},
            {'picking_id': 3, 'order_id': 3, 'state': 'assigned', 'date_done': None},
        ])
        self.txs = pd.DataFrame([{'order_id': i, 'tx_id': i, 'state': s, 'create_date': TS('2026-09-01'), 'custom_mode': 'cash_on_delivery'}
                                 for i, s in ((1, 'done'), (2, 'pending'), (3, 'done'))])
        self.states = pd.DataFrame([{'order_id': 1, 'clothcraft_state': 'delivered'}, {'order_id': 2, 'clothcraft_state': 'closed'},
                                    {'order_id': 3, 'clothcraft_state': 'closed'}])
        self.audit = pd.DataFrame([{'order_id': 2, 'to_state': 'delivered', 'create_date': TS('2026-09-06')},
                                   {'order_id': 2, 'to_state': 'closed', 'create_date': TS('2026-09-12')},
                                   {'order_id': 3, 'to_state': 'delivered', 'create_date': TS('2026-09-08')}])

    def test_delivered_and_paid_without_the_state_column(self):
        e, rule = H.earned_orders(self.orders, self.pickings, self.txs, pd.DataFrame(), pd.DataFrame(), False, TS('2026-10-15 16:00'))
        self.assertEqual(rule, 'delivered_and_paid')
        self.assertEqual(list(e['order_id']), [1])                     # 2 is unpaid, 3 is not delivered, 4 is cancelled
        self.assertEqual(e['moment'].iloc[0], TS('2026-09-05'))        # dated by its delivery

    def test_closed_state_with_the_column(self):
        e, rule = H.earned_orders(self.orders, self.pickings, self.txs, self.states, self.audit, True, TS('2026-10-15 16:00'))
        self.assertEqual(rule, 'closed_state')
        self.assertEqual(dict(zip(e['order_id'], e['moment'])), {2: TS('2026-09-12'), 3: TS('2026-09-08')})   # closed line, else delivered line
        self.assertIn('Closed state', H.RULE_TEXT[rule])

    def test_nothing_after_the_as_of_moment(self):
        e, _ = H.earned_orders(self.orders, self.pickings, self.txs, pd.DataFrame(), pd.DataFrame(), False, TS('2026-09-05'))
        self.assertEqual(len(e), 0)


class EmptyOrders(unittest.TestCase):
    """No candidate order gives an empty frame under both Closed rules (B8 S2: pandas could not map an empty series)."""
    END = TS('2026-10-26 16:00')

    def empty_inputs(self):
        orders = pd.DataFrame({'order_id': pd.Series(dtype='int64'), 'partner_id': pd.Series(dtype='int64'),
                               'date_order': pd.Series(dtype='datetime64[ns]'), 'state': pd.Series(dtype=object),
                               'amount_total': pd.Series(dtype=float)})
        pickings = pd.DataFrame({'picking_id': pd.Series(dtype='int64'), 'order_id': pd.Series(dtype='int64'), 'state': pd.Series(dtype=object),
                                 'date_done': pd.Series(dtype='datetime64[ns]')})
        txs = pd.DataFrame({'order_id': pd.Series(dtype='int64'), 'tx_id': pd.Series(dtype='int64'), 'state': pd.Series(dtype=object),
                            'create_date': pd.Series(dtype='datetime64[ns]'), 'custom_mode': pd.Series(dtype=object)})
        states = pd.DataFrame({'order_id': pd.Series(dtype='int64'), 'clothcraft_state': pd.Series(dtype=object)})
        audit = pd.DataFrame({'order_id': pd.Series(dtype='int64'), 'to_state': pd.Series(dtype=object),
                              'create_date': pd.Series(dtype='datetime64[ns]')})
        return orders, pickings, txs, states, audit

    def test_no_orders_under_both_rules(self):
        o, pk, tx, st, au = self.empty_inputs()
        for has, rule in ((True, 'closed_state'), (False, 'delivered_and_paid')):
            e, got = H.earned_orders(o, pk, tx, st, au, has, self.END)
            self.assertEqual(got, rule)
            self.assertEqual(len(e), 0)
            self.assertEqual(list(e.columns), ['order_id', 'partner_id', 'amount', 'moment'])

    def test_orders_but_none_qualify_under_both_rules(self):
        c = ClosedRule()
        c.setUp()
        states = c.states.assign(clothcraft_state='delivered')                     # nothing closed
        e, _ = H.earned_orders(c.orders, c.pickings, c.txs, states, c.audit, True, self.END)
        self.assertEqual(len(e), 0)
        e, _ = H.earned_orders(c.orders, c.pickings, c.txs.assign(state='pending'), pd.DataFrame(), pd.DataFrame(), False, self.END)  # nothing paid
        self.assertEqual(len(e), 0)

    def test_an_empty_earned_frame_flows_through_the_monthly_series(self):
        o, pk, tx, st, au = self.empty_inputs()
        e, _ = H.earned_orders(o, pk, tx, st, au, True, self.END)
        m = H.monthly(e, pd.DataFrame(columns=['month', 'amount', 'source']), H.closed_units(e, pd.DataFrame(columns=['order_id', 'product_id', 'qty'])),
                      pd.DataFrame(columns=['product_id', 'last_cost', 'cost_source']), TS('2026-10-26'), None)
        self.assertEqual(list(m['month']), ['2026-10'])
        self.assertEqual(float(m['revenue'].sum()), 0.0)


class AbsentHistory(unittest.TestCase):
    """A kind of history line entirely absent (B8 S2b: 1,972 simulated orders closed by migration have no line at all)."""
    setUp = ClosedRule.setUp
    END = TS('2026-10-15 16:00')

    def audit_only(self, *states):
        a = self.audit[self.audit['to_state'].isin(states)]
        return a.astype({'order_id': 'int64', 'to_state': object, 'create_date': 'datetime64[ns]'}).reset_index(drop=True)

    def moments(self, audit):
        e, rule = H.earned_orders(self.orders, self.pickings, self.txs, self.states, audit, True, self.END)
        self.assertEqual(rule, 'closed_state')
        return dict(zip(e['order_id'], e['moment']))

    def test_no_history_lines_at_all_falls_back_to_the_order_date(self):
        self.assertEqual(self.moments(self.audit_only()), {2: TS('2026-09-02'), 3: TS('2026-09-03')})

    def test_no_closed_lines_uses_the_delivered_lines(self):
        self.assertEqual(self.moments(self.audit_only('delivered')), {2: TS('2026-09-06'), 3: TS('2026-09-08')})

    def test_no_delivered_lines_uses_the_closed_lines_then_the_order_date(self):
        self.assertEqual(self.moments(self.audit_only('closed')), {2: TS('2026-09-12'), 3: TS('2026-09-03')})

    def test_delivered_and_paid_is_unaffected(self):
        e, rule = H.earned_orders(self.orders, self.pickings, self.txs, pd.DataFrame(), self.audit_only(), False, self.END)
        self.assertEqual((rule, list(e['order_id']), e['moment'].iloc[0]), ('delivered_and_paid', [1], TS('2026-09-05')))

    def test_the_lookup_of_an_empty_series(self):
        keys = pd.Series([5, 6])
        got = H._lookup(keys, pd.Series(dtype='datetime64[ns]'))
        self.assertTrue(got.isna().all())
        self.assertTrue(pd.api.types.is_datetime64_any_dtype(got.dtype))
        self.assertEqual(H._lookup(keys, pd.Series({5: TS('2026-01-01')}))[0], TS('2026-01-01'))

    def test_many_closed_orders_without_any_line(self):
        n = 50
        orders = pd.DataFrame({'order_id': range(1, n + 1), 'partner_id': range(1, n + 1), 'date_order': [TS('2026-09-01')] * n,
                               'state': ['sale'] * n, 'amount_total': [10.0] * n})
        states = pd.DataFrame({'order_id': range(1, n + 1), 'clothcraft_state': ['closed'] * n})
        e, _ = H.earned_orders(orders, self.pickings, self.txs, states, self.audit_only(), True, self.END)
        self.assertEqual((len(e), float(e['amount'].sum())), (n, 10.0 * n))


class MarginView(unittest.TestCase):
    """Cost of goods sold counts only the units of the orders that count as revenue, in the month of their revenue (B8 S1c)."""
    setUp = ClosedRule.setUp
    COSTS = pd.DataFrame({'product_id': [7, 8], 'last_cost': [10.0, 100.0], 'cost_source': ['last_receipt'] * 2})

    def demand(self):
        return pd.DataFrame([{'order_id': 1, 'product_id': 7, 'qty': 5.0}, {'order_id': 2, 'product_id': 7, 'qty': 2.0},
                             {'order_id': 3, 'product_id': 8, 'qty': 1.0}, {'order_id': 4, 'product_id': 7, 'qty': 9.0}])

    def month_row(self, has_state, as_of_end=TS('2026-10-15 16:00')):
        states = self.states if has_state else pd.DataFrame()
        audit = self.audit if has_state else pd.DataFrame()
        e, _ = H.earned_orders(self.orders, self.pickings, self.txs, states, audit, has_state, as_of_end)
        m = H.monthly(e, pd.DataFrame(columns=['month', 'amount', 'source']), H.closed_units(e, self.demand()), self.COSTS, TS('2026-10-15'), '2026-09')
        return m.set_index('month')

    def test_closed_state_counts_only_closed_orders_units(self):
        sep = self.month_row(True).loc['2026-09']
        self.assertEqual(sep['closed_units'], 3.0)                    # orders 2 (2 units) and 3 (1 unit); not order 1 (delivered, not closed)
        self.assertEqual(sep['cogs'], 2 * 10.0 + 1 * 100.0)
        self.assertEqual(sep['revenue'], 500.0)
        self.assertEqual(sep['net_margin'], 500.0 - 120.0)

    def test_delivered_and_paid_counts_that_rules_units(self):
        sep = self.month_row(False).loc['2026-09']
        self.assertEqual((sep['closed_units'], sep['cogs'], sep['revenue']), (5.0, 50.0, 100.0))   # order 1 only

    def test_units_are_dated_with_their_revenue(self):
        self.audit.loc[1, 'create_date'] = TS('2026-10-02')          # order 2 delivered in September, closed in October
        m = self.month_row(True)
        self.assertEqual((m.loc['2026-09', 'closed_units'], m.loc['2026-10', 'closed_units']), (1.0, 2.0))
        self.assertEqual((m.loc['2026-09', 'cogs'], m.loc['2026-10', 'cogs']), (100.0, 20.0))
        self.assertEqual(m.loc['2026-10', 'revenue'], 200.0)


class Kpis(unittest.TestCase):
    def test_net_position_is_labelled_starting_investment_not_a_loss(self):
        m = series([0] * 9 + [500], [0] * 9 + [200])
        k = H.kpis(m, pd.DataFrame(columns=['product_id', 'last_cost', 'cost_source']), pd.DataFrame(columns=['product_id', 'on_hand', 'reserved']),
                   1000.0, TS('2026-10-15'))
        self.assertIn('starting investment, not a loss', k['net_position_label'])
        self.assertIn('starting investment, not a loss', k['net_position_note'])

    def test_opening_balance_is_never_spending(self):
        m = series([0] * 9 + [500], [0] * 9 + [200])
        k = H.kpis(m, pd.DataFrame({'product_id': [1], 'last_cost': [10.0], 'cost_source': ['last_receipt']}),
                   pd.DataFrame({'product_id': [1], 'on_hand': [7.0], 'reserved': [0.0]}), 1000.0, TS('2026-10-15'))
        self.assertEqual(k['cumulative_spending'], 200.0)              # the opening balance is not in it
        self.assertEqual(k['net_position'], 500 - 200 - 1000)
        self.assertEqual(k['opening_balance'], 1000.0)
        self.assertEqual(k['stock_value'], 70.0)

    def test_last_cost_prefers_the_latest_receipt(self):
        cat = pd.DataFrame([{'product_id': 1, 'template_id': 1, 'garment': True, 'garment_type_id': 5},
                            {'product_id': 2, 'template_id': 2, 'garment': True, 'garment_type_id': 5}])
        moves = pd.DataFrame([{'product_id': 1, 'state': 'done', 'purchase_line_id': pl, 'dest_usage': 'internal', 'date': TS(d)}
                              for pl, d in ((1, '2026-01-01'), (2, '2026-03-01'))])
        pol = pd.DataFrame([{'po_line_id': 1, 'unit_cost': 100.0}, {'po_line_id': 2, 'unit_cost': 120.0}])
        si = pd.DataFrame([{'template_id': 2, 'price': 50.0}])
        c = H.last_costs(cat, moves, pol, pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), si, pd.DataFrame())
        got = dict(zip(c['product_id'], zip(c['last_cost'].round(2), c['cost_source'])))
        self.assertEqual(got, {1: (120.0, 'last_receipt'), 2: (56.0, 'supplierinfo_price_plus_vat')})


class Projection(unittest.TestCase):
    def test_remaining_days_only_and_coverage(self):
        fc = pd.DataFrame([{'level': 'total', 'key': 'total', 'week_start': TS('2026-10-12') + pd.Timedelta(weeks=i), 'yhat': 70.0,
                            'lo80': 35.0, 'hi80': 140.0} for i in range(8)])
        p = H.projection(fc, TS('2026-10-15'), 2.0, 999.0, months=3)
        oct_, nov, dec = p['months']
        self.assertEqual((oct_['days'], oct_['days_covered'], oct_['status']), (16, 16, 'projected'))   # Oct 16-31: the as-of day is not projected
        self.assertAlmostEqual(oct_['units'], 160.0)
        self.assertEqual((nov['days_covered'], nov['status']), (30, 'projected'))
        self.assertAlmostEqual(nov['revenue'], 600.0)
        self.assertAlmostEqual(nov['revenue_lo80'], 300.0)
        self.assertEqual(p['spending_restock_now'], 999.0)

    def test_a_partly_covered_month_is_not_covered_and_has_no_figures(self):
        fc = pd.DataFrame([{'level': 'total', 'key': 'total', 'week_start': TS('2026-10-12') + pd.Timedelta(weeks=i), 'yhat': 70.0,
                            'lo80': 35.0, 'hi80': 140.0} for i in range(8)])
        dec, jan = H.projection(fc, TS('2026-10-15'), 2.0, 0.0, months=4)['months'][2:]
        self.assertEqual((dec['days'], dec['days_covered'], dec['status']), (31, 6, 'not_covered'))   # the forecast ends on Dec 6
        self.assertEqual((jan['days_covered'], jan['status']), (0, 'not_covered'))
        for m in (dec, jan):
            self.assertEqual([m['units'], m['revenue'], m['revenue_lo80'], m['revenue_hi80']], [None] * 4)

    def test_the_simulated_note_only_on_a_simulated_run(self):
        fc = pd.DataFrame(columns=['level', 'key', 'week_start', 'yhat', 'lo80', 'hi80'])
        real = H.projection(fc, TS('2026-10-15'), 2.0, 0.0)['note']
        sim = H.projection(fc, TS('2026-10-15'), 2.0, 0.0, simulated=True)['note']
        self.assertNotIn('Simulated', real)
        self.assertEqual(real, H.PROJECTION_NOTE)
        self.assertTrue(sim.startswith(H.PROJECTION_NOTE) and sim.endswith('Simulated data demonstrates the method only.'))

    def test_no_forecast_means_nothing_is_projected(self):
        empty = pd.DataFrame(columns=['level', 'key', 'week_start', 'yhat', 'lo80', 'hi80'])
        self.assertEqual({m['status'] for m in H.projection(empty, TS('2026-10-15'), 2.0, 0.0)['months']}, {'not_covered'})


if __name__ == '__main__':
    unittest.main()
