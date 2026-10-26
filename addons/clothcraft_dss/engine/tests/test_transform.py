"""Unit tests for engine/transform.py (B8 step 1): small hand-built tables, every expected value worked out by hand. No database.

    cd addons/clothcraft_dss && python3 -m unittest discover -s engine/tests -t .
"""
import unittest

import pandas as pd

from engine import transform as T

TS = pd.Timestamp


def catalogue():
    return pd.DataFrame([
        {'product_id': 1, 'template_id': 10, 'sku': 'TEE-RED-S', 'template_name': 'Tee', 'garment': True, 'active': True},
        {'product_id': 2, 'template_id': 10, 'sku': 'TEE-RED-M', 'template_name': 'Tee', 'garment': True, 'active': True},
        {'product_id': 3, 'template_id': 20, 'sku': 'HOOD-BLK-S', 'template_name': 'Hoodie', 'garment': True, 'active': True},
        {'product_id': 9, 'template_id': 90, 'sku': 'FEE', 'template_name': 'Customization fee', 'garment': False, 'active': True},
    ])


def line(line_id, order_id, date, product_id, qty, state='sale', display_type=None):
    return {'line_id': line_id, 'order_id': order_id, 'partner_id': 100, 'date_order': TS(date), 'state': state, 'product_id': product_id,
            'qty': float(qty), 'display_type': display_type}


def move(mid, product_id, date, qty, src, dest, state='done', create=None, write=None):
    return {'move_id': mid, 'product_id': product_id, 'date': TS(date), 'create_date': TS(create or date), 'write_date': TS(write or date),
            'state': state, 'quantity': float(qty), 'demand_qty': float(qty), 'src_usage': src, 'dest_usage': dest,
            'purchase_line_id': None, 'sale_line_id': None}


class WeeklyBucketing(unittest.TestCase):
    def test_manila_day_boundary_and_month_end(self):
        # 15:59:59 UTC on 31 Jan is 23:59:59 on 31 Jan in Manila; 16:00:00 UTC is 00:00 on 1 Feb
        days = T.manila_day(pd.Series([TS('2026-01-31 15:59:59'), TS('2026-01-31 16:00:00')]))
        self.assertEqual(list(days), [TS('2026-01-31'), TS('2026-02-01')])

    def test_week_is_monday_to_sunday_in_manila(self):
        # Sunday 1 Feb 2026 23:59:59 Manila (15:59:59 UTC) is still the week of Monday 26 Jan; 00:00 Monday 2 Feb starts the next one
        d = T.demand_lines(pd.DataFrame([line(1, 1, '2026-02-01 15:59:59', 1, 2), line(2, 2, '2026-02-01 16:00:00', 1, 3)]), catalogue())
        self.assertEqual(list(d['week']), [TS('2026-01-26'), TS('2026-02-02')])

    def test_month_end_lands_in_the_right_manila_month(self):
        d = T.demand_lines(pd.DataFrame([line(1, 1, '2026-03-31 15:30:00', 1, 1), line(2, 2, '2026-03-31 16:30:00', 1, 1)]), catalogue())
        self.assertEqual(list(d['day'].dt.strftime('%Y-%m')), ['2026-03', '2026-04'])


class DemandExclusions(unittest.TestCase):
    def test_cancelled_section_and_non_garment_lines_are_not_demand(self):
        lines = pd.DataFrame([
            line(1, 1, '2026-01-05 02:00', 1, 2),                          # counts
            line(2, 2, '2026-01-05 02:00', 2, 5, state='cancel'),          # cancelled order
            line(3, 3, '2026-01-05 02:00', 9, 1),                          # customization fee: not a garment
            line(4, 4, '2026-01-05 02:00', 1, 0, display_type='line_note'),  # a note line
            line(5, 5, '2026-01-05 02:00', 3, 4, state='draft'),           # a quotation
            line(6, 6, '2026-01-05 02:00', 3, 1, state='done'),            # a locked order counts
        ])
        d = T.demand_lines(lines, catalogue())
        self.assertEqual(sorted(d['line_id']), [1, 6])
        self.assertEqual(d['qty'].sum(), 3.0)

    def test_weekly_grid_fills_weeks_without_sales_with_zero(self):
        d = T.demand_lines(pd.DataFrame([line(1, 1, '2026-01-05 02:00', 1, 2), line(2, 2, '2026-01-20 02:00', 3, 1)]), catalogue())
        wp = T.weekly_units(d, catalogue(), 'product')
        self.assertEqual(len(wp), 2 * 3)                                   # 2 garment templates x 3 weeks (5, 12, 19 Jan); the fee is not one
        self.assertEqual(wp.set_index(['template_id', 'week']).loc[(10, TS('2026-01-12')), 'units'], 0.0)
        wv = T.weekly_units(d, catalogue(), 'variant')
        self.assertEqual(sorted(wv['product_id'].unique()), [1, 2, 3])
        self.assertEqual(wv['units'].sum(), 3.0)


class StockBalance(unittest.TestCase):
    def moves(self):
        return pd.DataFrame([
            move(1, 1, '2026-01-01 02:00', 10, 'supplier', 'internal'),    # day 1: +10 -> 10
            move(2, 1, '2026-01-02 02:00', 4, 'internal', 'customer'),     # day 2: -4  -> 6
            move(3, 1, '2026-01-02 05:00', 2, 'internal', 'internal'),     # an internal transfer: no change
            move(4, 1, '2026-01-03 02:00', 6, 'internal', 'customer'),     # day 3: -6  -> 0 (stock-out)
            move(5, 1, '2026-01-04 02:00', 3, 'internal', 'customer', state='assigned'),  # not done: no change
            move(6, 1, '2026-01-05 02:00', 5, 'supplier', 'internal'),     # day 5: +5  -> 5
        ])

    def test_balance_from_a_move_list(self):
        b = T.daily_balance(self.moves(), '2026-01-01', '2026-01-06')
        self.assertEqual(list(b['on_hand']), [10.0, 6.0, 0.0, 0.0, 5.0, 5.0])
        self.assertEqual(list(b['out']), [False, False, True, True, False, False])

    def test_stockout_detection(self):
        b = T.daily_balance(self.moves(), '2026-01-01', '2026-01-06')
        s = T.stockout_summary(b, n_variants=1)
        # 3 and 4 Jan are at zero; both are in the week of Monday 29 Dec 2025 (1 to 4 Jan); 6 days rebuilt
        self.assertEqual(s, {'variant_weeks_with_zero_day': 1, 'variants_ever_zero': 1, 'weeks_with_any_zero': 1, 'variant_days_zero': 2,
                             'pct_variant_days_zero': round(100 * 2 / 6, 2)})

    def test_days_before_the_first_move_are_not_counted(self):
        b = T.daily_balance(self.moves(), '2025-12-28', '2026-01-02')
        self.assertEqual(b['day'].min(), TS('2026-01-01'))

    def test_reserved_free_stock(self):
        # an order line created on 2 Jan holds 3 until it is done on 4 Jan (held 2 and 3 Jan)
        mv = pd.DataFrame([move(1, 1, '2026-01-01 02:00', 3, 'supplier', 'internal'),
                           move(2, 1, '2026-01-04 02:00', 3, 'internal', 'customer', create='2026-01-02 02:00')])
        b = T.daily_balance(mv, '2026-01-01', '2026-01-05')
        f = T.free_balance(b, T.daily_reserved(mv, '2026-01-01', '2026-01-05'))
        self.assertEqual(list(f['on_hand']), [3.0, 3.0, 3.0, 0.0, 0.0])
        self.assertEqual(list(f['free']), [3.0, 0.0, 0.0, 0.0, 0.0])
        self.assertEqual(list(f['free_out'] & ~f['out']), [False, True, True, False, False])   # two reserved-only zero days


class OpeningBalance(unittest.TestCase):
    """The opening-balance rule (F5): an opening-stock adjustment that was ENTERED first but dated after the first sales is counted from the start of
    the variant's history, but only when the ledger needs it (the balance would go below zero without it). Small explicit ledgers; days are Manila days
    (every time below is 02:00 UTC = 10:00 Manila, the same calendar day). Move ids rise in the order the moves were entered."""

    START, END = '2026-01-01', '2026-01-12'

    def adj(self, mid, pid, day, qty):
        return move(mid, pid, f'2026-01-{day:02d} 02:00', qty, 'inventory', 'internal')

    def receipt(self, mid, pid, day, qty):
        return move(mid, pid, f'2026-01-{day:02d} 02:00', qty, 'supplier', 'internal')

    def sale(self, mid, pid, day, qty):
        return move(mid, pid, f'2026-01-{day:02d} 02:00', qty, 'internal', 'customer')

    def on_hand(self, rows, pid=1, start=None, end=None):
        b = T.daily_balance(pd.DataFrame(rows), start or self.START, end or self.END)
        b = b[b['product_id'] == pid]
        return list(b['on_hand']), b['day'].min().day

    def test_1_backdated_sales_and_a_later_dated_opening_entry(self):
        rows = [self.adj(1, 1, 10, 10), self.sale(2, 1, 2, 3), self.sale(3, 1, 5, 2)]
        on_hand, first_day = self.on_hand(rows)
        self.assertEqual((first_day, on_hand), (1, [10.0, 7.0, 7.0, 7.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0]))     # counted from the 1st, never below zero
        b = T.daily_balance(pd.DataFrame(rows), self.START, self.END)
        self.assertFalse(b['out'].any())

    def test_2_opening_stock_dated_before_its_first_sale_is_left_alone(self):
        rows = [self.adj(1, 1, 1, 10), self.sale(2, 1, 2, 3)]
        on_hand, first_day = self.on_hand(rows)
        self.assertEqual((first_day, on_hand), (1, [10.0] + [7.0] * 11))

    def test_3_a_variant_that_never_sold_is_counted_only_from_its_own_date(self):
        on_hand, first_day = self.on_hand([self.adj(1, 1, 10, 10)])
        self.assertEqual((first_day, on_hand), (10, [10.0, 10.0, 10.0]))

    def test_4_a_count_dated_before_the_opening_entry(self):
        # entered later but dated earlier: +1 on the 3rd, then a sale of 2 on the 4th: without the opening the balance is -1, so the opening moves to the 1st
        rows = [self.adj(1, 1, 10, 10), self.adj(2, 1, 3, 1), self.sale(3, 1, 4, 2)]
        self.assertEqual(self.on_hand(rows), ([10.0, 10.0, 11.0] + [9.0] * 9, 1))
        # a count that found one unit, then a sale of that one unit: a count is not cover (it usually corrects stock that was already there), so the sale still
        # points at an opening entered late and the opening moves to the 1st
        rows = [self.adj(1, 1, 10, 10), self.adj(2, 1, 3, 1), self.sale(3, 1, 4, 1)]
        self.assertEqual(self.on_hand(rows), ([10.0, 10.0, 11.0] + [10.0] * 9, 1))

    def test_4b_a_real_receipt_before_the_sale_is_cover_so_nothing_moves(self):
        # a RECEIPT of one unit on the 3rd covers a sale of one unit on the 4th: the balance is 1 then 0, never below zero, so there is no evidence and every move
        # keeps its own date (the opening arrives on the 10th)
        rows = [self.adj(1, 1, 10, 10), self.receipt(2, 1, 3, 1), self.sale(3, 1, 4, 1)]
        self.assertEqual(self.on_hand(rows), ([1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 10.0, 10.0, 10.0], 3))

    def test_5_several_inbound_adjustments_only_the_first_entered_is_the_opening(self):
        rows = [self.adj(1, 1, 10, 10), self.adj(2, 1, 6, 5), self.sale(3, 1, 2, 4)]
        self.assertEqual(self.on_hand(rows), ([10.0, 6.0, 6.0, 6.0, 6.0, 11.0, 11.0, 11.0, 11.0, 11.0, 11.0, 11.0], 1))      # the +5 keeps the 6th

    def test_6_sales_receipts_and_an_opening_on_different_dates(self):
        rows = [self.adj(1, 1, 8, 20), self.receipt(2, 1, 3, 5), self.sale(3, 1, 2, 4), self.sale(4, 1, 5, 3)]
        self.assertEqual(self.on_hand(rows), ([20.0, 16.0, 21.0, 21.0, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0], 1))

    def test_7_no_qualifying_opening_entry_means_the_ledger_is_rebuilt_as_dated(self):
        # the first-entered inbound move is a receipt, not an inventory adjustment: nothing is moved, the negative days stay visible
        rows = [self.receipt(1, 1, 10, 10), self.adj(2, 1, 12, 5), self.sale(3, 1, 2, 2)]
        on_hand, first_day = self.on_hand(rows)
        self.assertEqual((first_day, on_hand), (2, [-2.0] * 8 + [8.0, 8.0, 13.0]))

    def test_8_a_zero_quantity_opening_entry_is_not_an_opening(self):
        rows = [self.adj(1, 1, 10, 0), self.adj(2, 1, 12, 6), self.sale(3, 1, 2, 2)]
        on_hand, first_day = self.on_hand(rows)
        self.assertEqual((first_day, on_hand), (2, [-2.0] * 10 + [4.0]))          # the later +6 is not promoted to an opening

    def test_9_repeated_runs_agree_and_no_quantity_is_duplicated(self):
        frame = pd.DataFrame([self.adj(1, 1, 10, 10), self.sale(2, 1, 2, 3), self.sale(3, 1, 5, 2), self.adj(4, 1, 11, 4)])
        before = frame.copy()
        first = T.daily_balance(frame, self.START, self.END)
        second = T.daily_balance(frame, self.START, self.END)
        pd.testing.assert_frame_equal(first, second)
        pd.testing.assert_frame_equal(frame, before)                                  # the moves are never changed, dates included
        self.assertEqual(first['on_hand'].iloc[-1], 10 - 3 - 2 + 4)                   # the last day equals the sum of the moves: the opening counted once
        self.assertEqual(float(T.internal_deltas(frame)['delta'].sum()), 9.0)

    def test_10_normal_operating_data_is_rebuilt_exactly_as_before(self):
        rows = [self.adj(1, 1, 1, 10), self.receipt(2, 1, 4, 6), self.sale(3, 1, 2, 4), self.sale(4, 1, 6, 5)]
        self.assertEqual(self.on_hand(rows), ([10.0, 6.0, 6.0, 12.0, 12.0, 7.0] + [7.0] * 6, 1))

    def test_variants_are_judged_one_by_one(self):
        rows = [self.adj(1, 1, 10, 10), self.sale(2, 1, 2, 3),          # variant 1: opening entered late
                self.adj(3, 2, 1, 8), self.sale(4, 2, 3, 2),            # variant 2: normal
                self.adj(5, 3, 9, 5)]                                   # variant 3: never sold
        b = T.daily_balance(pd.DataFrame(rows), self.START, self.END)
        by = {pid: g.set_index('day')['on_hand'] for pid, g in b.groupby('product_id')}
        self.assertEqual(by[1][TS('2026-01-01')], 10.0)
        self.assertEqual(by[2][TS('2026-01-02')], 8.0)
        self.assertEqual(by[2][TS('2026-01-03')], 6.0)
        self.assertEqual(by[3].index.min(), TS('2026-01-09'))
        self.assertFalse(b['out'].any())

    def test_opening_moves_picks_the_first_entered_inventory_adjustment_only(self):
        mv = pd.DataFrame([self.adj(1, 1, 10, 10), self.receipt(2, 1, 3, 5),         # variant 1: first-entered inbound is the adjustment
                           self.receipt(3, 2, 3, 5), self.adj(4, 2, 4, 9),            # variant 2: first-entered inbound is a receipt
                           self.adj(5, 3, 4, 0), self.adj(6, 3, 5, 7)])               # variant 3: first-entered adjustment has zero quantity
        self.assertEqual(T.opening_moves(mv), {1: 0})


class LeadTimes(unittest.TestCase):
    def test_purchase_order_approval_to_first_receipt(self):
        po = pd.DataFrame([
            {'po_id': 1, 'supplier_id': 7, 'supplier': 'S', 'date_order': TS('2025-12-30'), 'date_approve': TS('2026-01-01 00:00'), 'first_receipt': TS('2026-01-08 12:00')},
            {'po_id': 2, 'supplier_id': 7, 'supplier': 'S', 'date_order': TS('2026-01-10 00:00'), 'date_approve': pd.NaT, 'first_receipt': TS('2026-01-13 00:00')},
        ])
        lt = T.lead_times_po(po)
        self.assertEqual(list(lt['days']), [7.5, 3.0])          # no approval time: the order date is used
        t = T.lead_time_table(lt)
        self.assertEqual((t.loc[0, 'n'], t.loc[0, 'mean'], t.loc[0, 'min'], t.loc[0, 'max']), (2, 5.2, 3.0, 7.5))

    def test_restock_approval_day_in_manila_to_received_day(self):
        rs = pd.DataFrame([
            {'restock_id': 1, 'supplier_id': 3, 'supplier': 'M', 'state': 'received', 'decided_at': TS('2026-01-01 17:00'), 'received_on': TS('2026-01-09'), 'received_at': TS('2026-01-09 03:00')},
            {'restock_id': 2, 'supplier_id': 3, 'supplier': 'M', 'state': 'approved', 'decided_at': TS('2026-01-01 01:00'), 'received_on': pd.NaT, 'received_at': pd.NaT},
        ])
        lt = T.lead_times_restock(rs)
        self.assertEqual(list(lt['days']), [7.0])               # approved 2 Jan Manila (17:00 UTC on 1 Jan), received 9 Jan; the open ticket is left out


class DeliveredAndPaid(unittest.TestCase):
    def test_rule(self):
        orders = pd.DataFrame([{'order_id': i, 'partner_id': 100, 'date_order': TS('2026-01-01'), 'state': s, 'amount_total': 100.0}
                               for i, s in ((1, 'sale'), (2, 'sale'), (3, 'sale'), (4, 'cancel'), (5, 'done'), (6, 'sale'))])
        pickings = pd.DataFrame([
            {'picking_id': 11, 'order_id': 1, 'state': 'done', 'date_done': TS('2026-01-02')},       # delivered
            {'picking_id': 21, 'order_id': 2, 'state': 'done', 'date_done': TS('2026-01-02')},       # one done ...
            {'picking_id': 22, 'order_id': 2, 'state': 'assigned', 'date_done': pd.NaT},             # ... one still open: not delivered
            {'picking_id': 31, 'order_id': 3, 'state': 'done', 'date_done': TS('2026-01-02')},       # delivered, but not paid
            {'picking_id': 51, 'order_id': 5, 'state': 'cancel', 'date_done': pd.NaT},              # a cancelled backorder ...
            {'picking_id': 52, 'order_id': 5, 'state': 'done', 'date_done': TS('2026-01-02')},       # ... and a done one: delivered
        ])                                                                                           # order 6 has no picking at all
        txs = pd.DataFrame([{'order_id': o, 'tx_id': o, 'state': s, 'create_date': TS('2026-01-01'), 'custom_mode': 'cash_on_delivery'}
                            for o, s in ((1, 'done'), (2, 'done'), (3, 'pending'), (5, 'done'), (6, 'done'))])
        r = T.delivered_and_paid(orders, pickings, txs).set_index('order_id')
        self.assertNotIn(4, r.index)                            # a cancelled order is not considered at all
        self.assertEqual(r['qualifies'].to_dict(), {1: True, 2: False, 3: False, 5: True, 6: False})
        self.assertEqual(r['delivered'].to_dict(), {1: True, 2: False, 3: True, 5: True, 6: False})

    def test_pending_bank_transfers_with_age(self):
        orders = pd.DataFrame([{'order_id': 1, 'partner_id': 1, 'date_order': TS('2026-01-01 00:00'), 'state': 'sale', 'amount_total': 1.0},
                               {'order_id': 2, 'partner_id': 1, 'date_order': TS('2026-01-01 00:00'), 'state': 'cancel', 'amount_total': 1.0}])
        txs = pd.DataFrame([{'order_id': 1, 'tx_id': 1, 'state': 'pending', 'create_date': TS('2026-01-01 12:00'), 'custom_mode': 'wire_transfer'},
                            {'order_id': 2, 'tx_id': 2, 'state': 'pending', 'create_date': TS('2026-01-01 12:00'), 'custom_mode': 'wire_transfer'},
                            {'order_id': 1, 'tx_id': 3, 'state': 'pending', 'create_date': TS('2026-01-01 12:00'), 'custom_mode': 'cash_on_delivery'}])
        p = T.pending_bank_transfers(orders, txs, TS('2026-01-11 00:00'))
        self.assertEqual(list(p['tx_id']), [1])                 # the cancelled order and the cash-on-delivery one are not bank-transfer waits
        self.assertEqual((p['age_order_days'].iloc[0], p['age_tx_days'].iloc[0]), (10.0, 9.5))


class Fingerprint(unittest.TestCase):
    def test_same_data_same_fingerprint_whatever_the_order(self):
        a = pd.DataFrame({'x': [1, 2, 3], 'd': pd.to_datetime(['2026-01-01', '2026-01-02', '2026-01-03']), 'v': [0.1, 0.2, 0.30000000001]})
        b = a.iloc[[2, 0, 1]][['v', 'd', 'x']]                   # rows and columns shuffled; a float that rounds to the same 6 decimals
        b = b.assign(v=[0.3, 0.1, 0.2])
        self.assertEqual(T.fingerprint({'t': a})['all'], T.fingerprint({'t': b})['all'])
        self.assertEqual(T.fingerprint({'t': a, 'u': a})['all'], T.fingerprint({'u': a, 't': a})['all'])

    def test_a_changed_value_changes_the_fingerprint(self):
        a = pd.DataFrame({'x': [1, 2, 3]})
        self.assertNotEqual(T.fingerprint({'t': a})['all'], T.fingerprint({'t': a.assign(x=[1, 2, 4])})['all'])
        self.assertNotEqual(T.fingerprint({'t': a})['all'], T.fingerprint({'t2': a})['all'])


if __name__ == '__main__':
    unittest.main()
