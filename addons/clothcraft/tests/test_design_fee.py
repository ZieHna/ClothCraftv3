import json
import os
import time

from odoo.tests.common import BaseCase, tagged

from .. import design_fee


def shared_cases():
    with open(os.path.join(os.path.dirname(__file__), '..', 'data', 'design_area_cases.json'), encoding='utf-8') as handle:
        return json.load(handle)


@tagged('post_install', '-at_install', 'clothcraft')
class TestDesignFee(BaseCase):
    """Step 9a: the print fee, against the SAME file of designs the browser's estimate is tested with (frontend/src/pricing/designFee.test.ts)."""

    def test_the_shared_cases(self):
        shared = shared_cases()
        box, reference = shared['box'], shared['referenceSqIn']
        for case in shared['cases']:
            with self.subTest(case=case['name']):
                units = design_fee.covered_units(case['elements'], box)
                self.assertLessEqual(abs(units - case['units']), shared['tolerance']['implementationsUnits'])
                area = design_fee.covered_sq_in(case['elements'], box, reference)
                self.assertEqual(area, case['coveredSqIn'])
                exact = case['analyticUnits'] * reference / (box['width'] * box['height'])
                self.assertLessEqual(abs(area - exact), shared['tolerance']['analyticSqIn'])
                for size, fee in case['fees'].items():
                    self.assertEqual(design_fee.fee_per_piece(area, shared['rate'], shared['sizeStep'], size), fee)
                self.assertEqual(design_fee.round2(case['fees']['M'] * 2), case['quantity2LineTotal'])

    def test_every_element_is_priced_by_its_rotated_bounding_box(self):
        corners = [(round(x), round(y)) for x, y in design_fee.element_outline({'x': 0, 'y': 0, 'width': 2, 'height': 2, 'rotation': 90})]
        self.assertEqual(corners, [(1, -1), (1, 1), (-1, 1), (-1, -1)])

    def test_nothing_on_the_garment_costs_nothing_even_at_xxl(self):
        self.assertEqual(design_fee.price([], {'x': 0, 'y': 0, 'width': 10, 'height': 10}, 200, 2, 20, 'XXL')['fee'], 0.0)

    def test_half_cents_round_away_from_zero(self):
        self.assertEqual((design_fee.round2(0.125), design_fee.round2(2.675)), (0.13, 2.68))

    def test_fifty_elements_are_priced_quickly_enough_for_an_upload(self):
        case = next(c for c in shared_cases()['cases'] if c['name'] == '50 separate elements')
        started = time.perf_counter()
        design_fee.covered_units(case['elements'], {'x': 87.49, 'y': 57.56, 'width': 620.63, 'height': 683.43})
        self.assertLess(time.perf_counter() - started, 2.0)
