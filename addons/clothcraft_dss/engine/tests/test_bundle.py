"""Unit tests for engine/bundle.py (B8 S1): pseudonyms, deterministic files, checksums. No database.

    cd addons/clothcraft_dss && python3 -m unittest discover -s engine/tests -t .
"""
import json
import os
import tempfile
import unittest

import numpy as np
import pandas as pd

from engine import bundle as B


def result():
    t = {name: pd.DataFrame({'a': [1, 2], 'b': [0.5, np.nan]}) for name in B.TABLES}
    t['restock'] = pd.DataFrame({'runout_date': [pd.Timestamp('2026-10-20'), pd.NaT], 'qty': [3, 0]})
    meta = {'source_db': 'clothcraft_sim2', 'simulated': True, 'closed_rule': 'delivered_and_paid', 'as_of': '2026-10-15',
            'params': {'x': np.int64(3)}, 'created_at_utc': 'whenever'}
    return {'meta': meta, 'tables': t, 'summary': {'n': np.float64(1.5), 'nan': float('nan'), 'when': pd.Timestamp('2026-10-15')}}


class Actuals(unittest.TestCase):
    """B8-S4: the weekly actuals table, on a fixture small enough to check by hand.
    Variants 10 and 11 belong to product 1, variant 20 to product 2. Weeks start Mondays 2026-01-05, 12, 19, 26; the as-of day is Wednesday
    2026-01-28, so the week of 01-26 is incomplete and left out. Variant 20 has no stock all week of 01-12: product 2 is censored that week,
    and so is the total (7 of its 21 variant-days at zero, above the 25% share)."""

    def data(self):
        from engine import forecast as F
        weeks = [pd.Timestamp('2026-01-05') + pd.Timedelta(weeks=i) for i in range(4)]
        cat = pd.DataFrame([{'product_id': p, 'template_id': t, 'template_name': f'P{t}', 'garment_type_code': 'TEE'}
                            for p, t in ((10, 1), (11, 1), (20, 2))])
        units = {10: [1, 2, 3, 4], 11: [0, 1, 0, 1], 20: [5, 0, 0, 2]}
        wv = pd.DataFrame([{'product_id': p, 'week': w, 'units': float(u[i])} for p, u in units.items() for i, w in enumerate(weeks)])
        days = pd.date_range('2026-01-05', '2026-01-28')
        dh = pd.DataFrame([{'product_id': p, 'day': d, 'on_hand': 0.0 if (p == 20 and pd.Timestamp('2026-01-12') <= d <= pd.Timestamp('2026-01-18')) else 5.0}
                           for p in units for d in days])
        return F.prepare(cat, wv, dh, pd.Timestamp('2026-01-28'))

    def test_rows_by_hand(self):
        a = B.actuals_table(self.data(), pd.Timestamp('2026-01-12'))
        got = [(r.level, r.key, r.week_start.date().isoformat(), r.units, bool(r.censored)) for r in a.itertuples()]
        self.assertEqual(got, [
            ('product', '1', '2026-01-12', 3.0, False), ('product', '1', '2026-01-19', 3.0, False),
            ('product', '2', '2026-01-12', 0.0, True), ('product', '2', '2026-01-19', 0.0, False),
            ('total', 'total', '2026-01-12', 3.0, True), ('total', 'total', '2026-01-19', 3.0, False)])
        self.assertEqual(list(a.columns), B.ACTUALS_COLUMNS)

    def test_from_the_training_start_through_the_last_complete_week(self):
        a = B.actuals_table(self.data(), pd.Timestamp('2026-01-05'))
        weeks = sorted(set(a['week_start'].dt.date.astype(str)))
        self.assertEqual(weeks, ['2026-01-05', '2026-01-12', '2026-01-19'])       # 01-26 is incomplete on the as-of day
        self.assertEqual(float(a[(a.level == 'total') & (a.week_start == '2026-01-05')]['units'].iloc[0]), 6.0)
        self.assertNotIn('garment_type', set(a['level']))                         # type sums are left to the reader

    def test_written_in_the_bundle_with_its_checksum(self):
        res = result()
        res['tables']['actuals'] = B.actuals_table(self.data(), pd.Timestamp('2026-01-12'))
        with tempfile.TemporaryDirectory() as d:
            m = B.write_bundle(d, res)
            self.assertEqual(m['files']['actuals.csv.gz']['rows'], 6)
            self.assertTrue(B.verify_bundle(d)[0])
        self.assertEqual(B.ENGINE_VERSION, 'B8-S4')


class Notes(unittest.TestCase):
    """F3: the forecast notes of a run. Generic notes are written for every run; the ones that quote the simulation's own numbers only for a simulated run."""

    SIMULATION_WORDS = ('Simulated data', 'simulation check', '(2025-07-07', 'In the simulation')

    def test_a_simulated_run_carries_the_simulation_notes(self):
        from engine import forecast as F
        notes = F.notes_for(True)
        for n in F.SIMULATION_NOTES + F.NOTES:
            self.assertIn(n, notes)
        self.assertTrue(any('Simulated data' in n for n in notes))
        self.assertTrue(any('simulation check' in n for n in notes))
        self.assertTrue(any('(2025-07-07' in n for n in notes))

    def test_a_real_run_carries_the_generic_notes_and_no_simulation_wording(self):
        from engine import forecast as F
        notes = F.notes_for(False)
        self.assertEqual(notes, list(F.NOTES))
        self.assertGreaterEqual(len(notes), 4)
        for n in notes:
            for word in self.SIMULATION_WORDS:
                self.assertNotIn(word, n)

    def test_the_generic_notes_never_contain_simulation_wording_by_construction(self):
        from engine import forecast as F
        for n in F.NOTES:
            for word in self.SIMULATION_WORDS:
                self.assertNotIn(word, n)

    def test_compute_writes_the_notes_through_notes_for(self):
        import inspect
        self.assertIn("F.notes_for(info['simulated'])", inspect.getsource(B.compute))      # compute() needs a database's worth of inputs; this keeps the wiring honest
        self.assertNotIn('list(F.NOTES)', inspect.getsource(B.compute))


class Pseudonym(unittest.TestCase):
    def test_stable_and_without_the_id(self):
        a = B.pseudonym('clothcraft_sim2', 42)
        self.assertEqual(a, B.pseudonym('clothcraft_sim2', 42))
        self.assertNotEqual(a, B.pseudonym('clothcraft_sim2', 43))
        self.assertNotEqual(a, B.pseudonym('other_db', 42))
        self.assertTrue(a.startswith('c_') and len(a) == 18)


class Files(unittest.TestCase):
    def test_round_trip_verifies_and_is_deterministic(self):
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
            m1, m2 = B.write_bundle(d1, result()), B.write_bundle(d2, result())
            self.assertEqual(m1['bundle_sha256'], m2['bundle_sha256'])        # same content, same files (gzip without a timestamp)
            ok, problems = B.verify_bundle(d1)
            self.assertTrue(ok, problems)
            with open(os.path.join(d1, 'manifest.json'), encoding='utf-8') as fh:
                m = json.load(fh)
            self.assertEqual(m['closed_rule'], 'delivered_and_paid')
            self.assertEqual(m['files']['restock.csv.gz']['rows'], 2)
            self.assertEqual(m['params']['x'], 3)

    def test_a_changed_file_is_detected(self):
        with tempfile.TemporaryDirectory() as d:
            B.write_bundle(d, result())
            with open(os.path.join(d, 'summary.json'), 'a', encoding='utf-8') as fh:
                fh.write(' ')
            ok, problems = B.verify_bundle(d)
            self.assertFalse(ok)
            self.assertEqual(problems, ['summary.json: checksum differs'])

    def test_json_cleaning(self):
        self.assertEqual(B._clean({'a': np.int64(2), 'b': float('nan'), 'c': [np.float64(1.5)], 'd': np.bool_(True)}),
                         {'a': 2, 'b': None, 'c': [1.5], 'd': True})

    def test_end_of_the_manila_day_in_utc(self):
        self.assertEqual(B.end_of_day_utc(pd.Timestamp('2026-10-15')), pd.Timestamp('2026-10-15 16:00:00'))


if __name__ == '__main__':
    unittest.main()
