"""The print fee of a customized garment (step 9a): the SERVER's authority. Pure Python, no Odoo import.

frontend/src/pricing/designFee.ts is the browser's ESTIMATE and is the same algorithm line by line; both are run against ONE shared file
of designs and expected results (data/design_area_cases.json). Keep them in step.

The rules:
- Every element is priced by its BOUNDING BOX: the rectangle of its width and height, rotated about its centre (x, y is the CENTRE),
  whatever is drawn inside (text, circle, star, picture). One function says so: element_outline().
- Covered area = the union of the visible elements' outlines (overlaps count once), clipped to the garment's bounding rectangle, in design
  units. Hidden elements and elements with opacity 0 are ignored.
- The union is computed with a SCANLINE: the garment rectangle is cut into horizontal bands BAND design units high; in the middle of each
  band every outline is a convex polygon, so it covers exactly one stretch of the line, found from its edges; the stretches are clipped,
  merged (overlaps once) and their length times the band height is added up. Exact across each line, sampled downwards: an edge that is
  not horizontal is off by at most half a band along its height.
- Square inches: the garment rectangle at size Small is the garment type's reference area, so one design unit squared is
  reference_sq_in / (box width x box height). Rounded to 2 decimals before anything is multiplied.
- fee per piece = round2(covered_sq_in x rate + size_step x steps(size)), and 0 when nothing visible lands on the garment
  (covered area 0). No minimum. Sizes in order XS S M L XL XXL; XS and S are step 0.
"""
import math

BAND = 0.25
SIZE_STEPS = {'XS': 0, 'S': 0, 'M': 1, 'L': 2, 'XL': 3, 'XXL': 4}


def round2(value):
    """Half away from zero, on the decimal value (as Odoo's float_round does for money), not banker's rounding."""
    return math.copysign(math.floor(abs(value) * 100 + 0.5 + 1e-9) / 100, value) if value else 0.0


def element_outline(element):
    """THE bounding-box rule: the four corners of the element's box, rotated about its centre. Every element type uses this."""
    cx, cy = float(element['x']), float(element['y'])
    hw, hh = float(element['width']) / 2, float(element['height']) / 2
    angle = math.radians(float(element['rotation']))
    cos, sin = math.cos(angle), math.sin(angle)
    return [(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos) for dx, dy in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))]


def counts(element):
    return bool(element.get('visible', True)) and float(element.get('opacity', 1)) > 0 and float(element['width']) > 0 and float(element['height']) > 0


def _stretch(polygon, y):
    """Where a convex polygon crosses the horizontal line at y: (left, right), or None."""
    lo, hi = math.inf, -math.inf
    n = len(polygon)
    for i in range(n):
        (px, py), (qx, qy) = polygon[i], polygon[(i + 1) % n]
        if py == qy:
            continue
        if min(py, qy) <= y <= max(py, qy):
            x = px + (y - py) * (qx - px) / (qy - py)
            if x < lo:
                lo = x
            if x > hi:
                hi = x
    return (lo, hi) if lo <= hi else None


def covered_units(elements, box):
    """The covered area in design units squared (not rounded)."""
    # each outline with its top and bottom: a line outside them cannot cross it, so it is skipped (the same result, much faster)
    outlines = []
    for e in elements:
        if counts(e):
            polygon = element_outline(e)
            ys = [y for _x, y in polygon]
            outlines.append((polygon, min(ys), max(ys)))
    if not outlines:
        return 0.0
    left, top = float(box['x']), float(box['y'])
    right, bottom = left + float(box['width']), top + float(box['height'])
    total = 0.0
    i = 0
    while True:
        y0 = top + i * BAND
        if y0 >= bottom:
            break
        y1 = min(y0 + BAND, bottom)
        y = (y0 + y1) / 2
        stretches = []
        for polygon, outline_top, outline_bottom in outlines:
            if y < outline_top or y > outline_bottom:
                continue
            s = _stretch(polygon, y)
            if s is None:
                continue
            a, b = max(s[0], left), min(s[1], right)
            if b > a:
                stretches.append((a, b))
        if stretches:
            stretches.sort()
            run_a, run_b = stretches[0]
            length = 0.0
            for a, b in stretches[1:]:
                if a > run_b:
                    length += run_b - run_a
                    run_a, run_b = a, b
                elif b > run_b:
                    run_b = b
            length += run_b - run_a
            total += length * (y1 - y0)
        i += 1
    return total


def covered_sq_in(elements, box, reference_sq_in):
    units = covered_units(elements, box)
    return round2(units * float(reference_sq_in) / (float(box['width']) * float(box['height'])))


def fee_per_piece(area_sq_in, rate, size_step, size):
    """0 when nothing visible lands on the garment; otherwise area x rate + size step x steps, rounded to 2 decimals."""
    if area_sq_in <= 0:
        return 0.0
    return round2(area_sq_in * float(rate) + float(size_step) * SIZE_STEPS[size])


def price(elements, box, reference_sq_in, rate, size_step, size):
    """Everything a quote and an order line keep: {covered_sq_in, rate, size_step, steps, fee}."""
    area = covered_sq_in(elements, box, reference_sq_in)
    return {'covered_sq_in': area, 'rate': float(rate), 'size_step': float(size_step), 'steps': SIZE_STEPS[size],
            'fee': fee_per_piece(area, rate, size_step, size)}
