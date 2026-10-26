"""Step 9a: customized garments. The new columns arrive with their defaults (every garment type's print area at size Small is 200 sq in),
the fee product, the pricing record and the cleanup job come from data/design_data.xml. What is left is the print box of each garment,
measured from its pictures (data/garment_bounds.json, by storefront id). A garment the file does not know keeps no box and so cannot be
customized; it is logged. Run only on clothcraft_dev and clothcraft_shop.
"""
import logging

from odoo import SUPERUSER_ID, api

from odoo.addons.clothcraft.models.design import fill_print_boxes

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    done, missing = fill_print_boxes(env)
    _logger.info('clothcraft 9a: print box set on %s garment(s) in %s', done, cr.dbname)
    if missing:
        _logger.warning('clothcraft 9a: no print box for %s (not in garment_bounds.json): they cannot be customized', sorted(missing))
