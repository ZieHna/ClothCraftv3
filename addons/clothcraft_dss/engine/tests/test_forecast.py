"""Unit tests for engine/methods.py and engine/forecast.py (B8 step 2). Small hand-built series; expected values worked out by hand.

    cd addons/clothcraft_dss && python3 -m unittest discover -s engine/tests -t .
"""
import unittest

import numpy as np
import pandas as pd

from engine import forecast as F
from engine import methods as M

TS = pd.Timestamp
W = pd.Timedelta(days=7)


def toy(weeks, units_by_variant, gtypes=None, start='2026-01-05', onhand=5.0):
    """A catalogue, weekly variant units and a daily on-hand table. units_by_variant: {product_id: (template_id, [units per week])}."""
    gtypes = gtypes or {}
    cat = pd.DataFrame([{'product_id': p, 'template_id': t, 'template_name': f'T{t}', 'sku': f'S{p}', 'garment_type_id': 1,
                         'garment_type_code': gtypes.get(t, 'G')} for p, (t, _) in units_by_variant.items()])
    ws = [TS(start) + i * W for i in range(weeks)]
    wv = pd.DataFrame([{'product_id': p, 'week': w, 'units': float(u[i])} for p, (t, u) in units_by_variant.items() for i, w in enumerate(ws)])
    days = pd.date_range(ws[0], ws[-1] + pd.Timedelta(days=6))
    dh = pd.DataFrame([{'product_id': p, 'day': d, 'on_hand': onhand} for p in units_by_variant for d in days])
    as_of = ws[-1] + pd.Timedelta(days=6)                     # the Sunday of the last week: every week complete
    return cat, wv, dh, as_of


SMALL = {'horizon': 2, 'n_origins': 3, 'window_weeks': 6, 'origin_step': 1, 'calib_origins': 2, 'min_resid': 3, 'level_weeks': 4,
         'thin_weeks': 3, 'group_weeks': 4, 'share_weeks': 4}


class Methods(unittest.TestCase):
    def test_naive_and_moving_average(self):
        self.assertEqual(list(M.naive(np.array([1, 2, 3.0]), 2)), [3.0, 3.0])
        self.assertEqual(list(M.moving_average(np.array([1, 2, 3, 4, 5.0]), 2)), [3.5, 3.5])     # mean of 2, 3, 4, 5
        self.assertEqual(list(M.moving_average(np.array([2, 4.0]), 1)), [3.0])                   # fewer than 4 weeks: all of them

    def test_seasonal_naive_takes_the_same_week_a_year_earlier(self):
        y = np.arange(60, dtype=float)                       # week i sold i
        self.assertEqual(list(M.seasonal_naive(y, 3)), [8.0, 9.0, 10.0])   # week 60 <- 8, 61 <- 9, 62 <- 10
        self.assertTrue(np.isnan(M.seasonal_naive(np.arange(10.0), 2)).all())

    def test_croston_sba_by_hand(self):
        # sizes 4 then 2, intervals 2 then 3: z = 0.1*2 + 0.9*4 = 3.8, p = 0.1*3 + 0.9*2 = 2.1, forecast = 0.95 * 3.8 / 2.1
        f = M.croston_sba(np.array([0, 4, 0, 0, 2.0]), 2)
        self.assertAlmostEqual(f[0], 0.95 * 3.8 / 2.1, places=12)
        self.assertEqual(list(M.croston_sba(np.zeros(6), 2)), [0.0, 0.0])

    def test_ets_damped_trend_follows_a_trend_and_needs_8_weeks(self):
        y = np.array([10, 12, 14, 16, 18, 20, 22, 24, 26, 28.0])
        f = M.holt_damped(y, 3)
        self.assertTrue(np.all(np.isfinite(f)) and f[0] > 26 and f[2] >= f[0] - 1e-6)     # still going up, a little damped
        self.assertTrue(np.isnan(M.holt_damped(y[:7], 2)).all())

    def test_one_week_series(self):
        y = np.array([5.0])
        self.assertEqual((M.naive(y, 1)[0], M.moving_average(y, 1)[0]), (5.0, 5.0))
        self.assertTrue(np.isnan(M.holt_damped(y, 1)[0]))


class Metrics(unittest.TestCase):
    def test_mae_wape_bias_coverage_by_hand(self):
        g = pd.DataFrame({'y': [10.0, 20.0, 0.0], 'yhat': [12.0, 15.0, 1.0], 'lo80': [9.0, 16.0, 0.0], 'hi80': [11.0, 25.0, 0.5],
                          'lo95': [8.0, 10.0, 0.0], 'hi95': [13.0, 30.0, 2.0]})
        m = F.metrics(g)
        # errors (forecast - actual) 2, -5, 1: MAE 8/3; WAPE 8/30; bias -2/30; 80%: 10 in [9,11] yes, 20 in [16,25] yes, 0 in [0,0.5] yes
        self.assertAlmostEqual(m['mae'], 8 / 3)
        self.assertAlmostEqual(m['wape'], 100 * 8 / 30)
        self.assertAlmostEqual(m['bias'], 100 * -2 / 30)
        self.assertEqual((m['cov80'], m['cov95'], m['n']), (100.0, 100.0, 3))
        g.loc[1, 'hi80'] = 19.0
        self.assertAlmostEqual(F.metrics(g)['cov80'], 100 * 2 / 3)

    def test_a_missing_forecast_is_not_scored(self):
        # four weeks, the third has no forecast (seasonal naive with under a year of history): n, MAE, WAPE and bias are on the other three
        g = pd.DataFrame({'y': [10.0, 20.0, 50.0, 0.0], 'yhat': [12.0, 15.0, np.nan, 1.0]})
        m = F.metrics(g)
        self.assertEqual(m['n'], 3)
        self.assertAlmostEqual(m['mae'], 8 / 3)                  # errors 2, -5, 1 on the three scored weeks
        self.assertAlmostEqual(m['wape'], 100 * 8 / 30)          # over the actuals of the same three weeks (10 + 20 + 0), not all four (80)
        self.assertAlmostEqual(m['bias'], 100 * -2 / 30)

    def test_all_forecasts_missing_is_nan_not_a_crash(self):
        g = pd.DataFrame({'y': [10.0, 20.0], 'yhat': [np.nan, np.nan]})
        m = F.metrics(g)
        self.assertEqual((m['n'], m['n_int']), (0, 0))
        for k in ('mae', 'wape', 'bias', 'cov80', 'cov95'):
            self.assertTrue(np.isnan(m[k]), k)

    def test_a_missing_forecast_does_not_count_toward_the_interval_numbers(self):
        g = pd.DataFrame({'y': [10.0, 20.0], 'yhat': [12.0, np.nan], 'lo80': [9.0, np.nan], 'hi80': [11.0, np.nan], 'lo95': [8.0, np.nan], 'hi95': [13.0, np.nan]})
        m = F.metrics(g)
        self.assertEqual((m['n'], m['n_int']), (1, 1))
        self.assertEqual((m['cov80'], m['cov95']), (100.0, 100.0))


class Leakage(unittest.TestCase):
    def test_a_spike_after_the_origin_does_not_change_that_origins_forecast(self):
        base = [4, 5, 6, 5, 4, 6, 5, 7, 6, 5, 6, 7, 6, 5]
        cat, wv, dh, as_of = toy(14, {1: (10, base), 2: (20, [1, 0, 2, 0, 1, 0, 0, 2, 0, 1, 0, 0, 1, 0])})
        spiked = list(base)
        spiked[10] = 500                                     # week 10 is after the origin below
        _, wv2, _, _ = toy(14, {1: (10, spiked), 2: (20, [1, 0, 2, 0, 1, 0, 0, 2, 0, 1, 0, 0, 1, 0])})
        p = {**F.DEFAULTS, **SMALL, 'train_start': '2026-01-05'}
        origin = TS('2026-01-05') + 10 * W
        a = F.forecasts_at(F.prepare(cat, wv, dh, as_of), origin, TS('2026-01-05'), p)
        b = F.forecasts_at(F.prepare(cat, wv2, dh, as_of), origin, TS('2026-01-05'), p)
        for tid in a:
            for m in ('naive', 'ma4', 'ets', 'croston', 'snaive'):
                np.testing.assert_array_equal(a[tid][m], b[tid][m])
        later = F.forecasts_at(F.prepare(cat, wv2, dh, as_of), origin + W, TS('2026-01-05'), p)
        self.assertEqual(later[10]['naive'][0], 500.0)        # and the spike IS seen once it is in the past


class RunLevel(unittest.TestCase):
    def setUp(self):
        self.series = {1: (10, [5, 6, 7, 6, 8, 7, 9, 8, 9, 10, 9, 11, 10, 12]),
                       2: (10, [2, 3, 2, 3, 3, 2, 4, 3, 3, 4, 3, 4, 4, 5]),
                       3: (20, [1, 0, 2, 0, 1, 0, 0, 2, 0, 1, 0, 0, 1, 0]),
                       4: (30, [0] * 11 + [3, 0, 2]),            # thin: 2 weeks with a sale
                       5: (40, [0] * 14)}                        # never sold
        self.p = {**SMALL, 'train_start': '2026-01-05'}

    def run_toy(self):
        cat, wv, dh, as_of = toy(14, self.series, gtypes={10: 'TEE', 20: 'HOOD', 30: 'HOOD', 40: 'JKT'})
        return F.run(cat, wv, dh, as_of, self.p)

    def test_determinism(self):
        a, b = self.run_toy(), self.run_toy()
        pd.testing.assert_frame_equal(a['forecast'], b['forecast'])
        pd.testing.assert_frame_equal(a['backtest'], b['backtest'])
        self.assertEqual(a['selection'], b['selection'])

    def test_bottom_up_sums_and_clipping(self):
        fc = self.run_toy()['forecast']
        for week, g in fc.groupby('week_start'):
            prod = g[g['level'] == 'product']['yhat'].sum()
            self.assertAlmostEqual(g[g['level'] == 'total']['yhat'].iloc[0], prod)
            self.assertAlmostEqual(g[g['level'] == 'garment_type']['yhat'].sum(), prod)
        b = fc.dropna(subset=['lo80'])
        self.assertTrue((fc['yhat'] >= 0).all() and (b[['lo80', 'hi80', 'lo95', 'hi95']] >= 0).all().all())
        self.assertTrue((b['lo95'] <= b['lo80']).all() and (b['hi80'] <= b['hi95']).all())

    def test_thin_and_never_sold_products(self):
        fc = self.run_toy()['forecast']
        thin = fc[(fc['level'] == 'product') & (fc['key'] == 30)]
        self.assertTrue((thin['method'] == 'group_share').all() and thin['flags'].str.contains('not_enough_history').all())
        # HOOD group over the last 4 training weeks: template 20 sold 0,0,1,0 and 30 sold 0,3,0,2 -> group mean (0+3+1+2)/4 = 1.5;
        # 30's share since its first sale (week 11): 5 of 5 + 1 (template 20 sold 0, 0, 1, 0 in weeks 10-13 -> 1 after week 11) = 5/6
        self.assertAlmostEqual(thin['yhat'].iloc[0], 1.5 * 5 / 6)
        self.assertFalse(((fc['level'] == 'product') & (fc['key'] == 40)).any())       # no sales: no forecast at all

    def test_an_all_zero_series_alone_gives_no_forecast(self):
        cat, wv, dh, as_of = toy(10, {1: (10, [0] * 10)})
        out = F.forecasts_at(F.prepare(cat, wv, dh, as_of), TS('2026-01-05') + 9 * W, TS('2026-01-05'), {**F.DEFAULTS, **SMALL})
        self.assertEqual(out, {})

    def test_negative_trend_is_clipped_at_zero(self):
        cat, wv, dh, as_of = toy(12, {1: (10, [40, 36, 32, 28, 24, 20, 16, 12, 8, 4, 2, 1])})
        out = F.forecasts_at(F.prepare(cat, wv, dh, as_of), TS('2026-01-05') + 12 * W, TS('2026-01-05'), {**F.DEFAULTS, **SMALL, 'horizon': 8})
        self.assertTrue((out[10]['ets'] >= 0).all() and out[10]['ets'][-1] == 0.0)


class Shares(unittest.TestCase):
    def test_shares_sum_to_one_and_use_in_stock_days(self):
        cat, wv, dh, as_of = toy(4, {1: (10, [2, 2, 2, 2]), 2: (10, [1, 1, 1, 1]), 3: (20, [0, 0, 0, 0])})
        dh.loc[(dh['product_id'] == 2) & (dh['day'] >= TS('2026-01-19')), 'on_hand'] = 0.0      # variant 2 in stock 14 of 28 days
        s = F.variant_shares(cat, wv, dh, as_of, weeks=4)
        self.assertTrue(np.allclose(s.groupby('template_id')['share'].sum(), 1.0))
        a1, a2 = 8 * 28 / 28, 4 * 28 / 14                       # adjusted units: 8 and 8
        self.assertAlmostEqual(s.set_index('product_id').loc[1, 'share'], (a1 + 1) / (a1 + a2 + 2))   # 9/18 = 0.5
        self.assertAlmostEqual(s.set_index('product_id').loc[3, 'share'], 1.0)                        # alone in its product


class Selection(unittest.TestCase):
    def rows(self, wapes):
        """Backtest rows for one product, one origin: actual 10 each horizon; each policy's forecast gives it the wanted WAPE."""
        out = []
        for policy, w in wapes.items():
            for h in (1, 2):
                out.append({'origin': TS('2026-01-05'), 'level': 'product', 'key': 1, 'policy': policy, 'method': policy if policy != 'ets_croston' else 'croston',
                            'h': h, 'week': TS('2026-01-05'), 'yhat': 10 + w / 10, 'y': 10.0, 's': 10.0, 'thin': False, 'censored': False})
        return pd.DataFrame(out)

    def test_model_wins(self):
        s = F.select(self.rows({'naive': 30, 'ma4': 20, 'snaive': 1, 'ets': 15, 'ets_croston': 18}), F.DEFAULTS)
        self.assertEqual((s['best_baseline'], s['chosen'], s['model_beats_baseline'], s['message']), ('ma4', 'ets', True, None))

    def test_baseline_wins(self):
        s = F.select(self.rows({'naive': 30, 'ma4': 12, 'snaive': 1, 'ets': 15, 'ets_croston': 18}), F.DEFAULTS)
        self.assertEqual((s['chosen'], s['message']), ('ma4', 'the model did not beat the baseline'))   # snaive is never chosen

    def test_a_tie_goes_to_the_simpler_method(self):
        s = F.select(self.rows({'naive': 20, 'ma4': 20, 'snaive': 1, 'ets': 20, 'ets_croston': 20}), F.DEFAULTS)
        self.assertEqual((s['best_baseline'], s['chosen']), ('naive', 'naive'))

    def test_override_needs_more_than_5_points(self):
        # pooled: ets (10 + 16 + 14) / 3 = 13.3 beats the best baseline (naive 23.2): ets is chosen overall
        rows = pd.concat([self.rows({'naive': 30, 'ma4': 30, 'snaive': 1, 'ets': 10, 'ets_croston': 18}),
                          self.rows({'naive': 30, 'ma4': 9.9, 'snaive': 1, 'ets': 16, 'ets_croston': 18}).assign(key=2),
                          self.rows({'naive': 9.6, 'ma4': 30, 'snaive': 1, 'ets': 14, 'ets_croston': 18}).assign(key=3)])
        s = F.select(rows, F.DEFAULTS)
        self.assertEqual(s['chosen'], 'ets')
        self.assertEqual(set(s['overrides']), {2})               # 16 - 9.9 = 6.1 points: override; 14 - 9.6 = 4.4: none
        self.assertEqual(s['overrides'][2]['method'], 'ma4')


if __name__ == '__main__':
    unittest.main()
