"""Step 8b: the storefront facts become fields (shop group, storefront id, featured). Fill them for the garments that exist, from what the
service used to derive: the SKU (SIM-M-TEE-BLK-S or M-TEE-BLK-S -> group Men, id m-tee) and its featured list. Run only on clothcraft_dev
and clothcraft_shop (a fresh clothcraft_shop is seeded with the fields set, so there it finds nothing to do).
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)

GROUP_BY_LETTER = {'M': 'Men', 'W': 'Women', 'K': 'Kids', 'B': 'Babies'}
FEATURED = {'m-tee', 'w-crop', 'w-hood', 'w-tee', 'b-ones'}   # the service's former featured_ids setting


def storefront_facts(code):
    """'SIM-M-TEE-BLK-S' or 'M-TEE-BLK-S' -> ('Men', 'm-tee'); None when the code does not follow the pattern."""
    parts = (code or '').split('-')
    if parts and parts[0] == 'SIM':
        parts = parts[1:]
    if len(parts) < 2 or parts[0] not in GROUP_BY_LETTER:
        return None
    return GROUP_BY_LETTER[parts[0]], f'{parts[0]}-{parts[1]}'.lower()


def fill(env):
    """Set group, storefront id and featured on every garment that has no storefront id yet. Returns how many were set."""
    templates = env['product.template'].with_context(active_test=False).search(
        [('garment_type_id', '!=', False), ('clothcraft_slug', '=', False)])
    done = 0
    for template in templates:
        codes = template.with_context(active_test=False).product_variant_ids.mapped('default_code')
        facts = next((f for f in map(storefront_facts, codes) if f), None)
        if not facts or env['product.template'].with_context(active_test=False).search_count([('clothcraft_slug', '=', facts[1])]):
            _logger.warning('clothcraft 8b: no storefront id for %s (codes %s); set it in the product form', template.display_name, codes[:2])
            continue
        template.write({'clothcraft_group': facts[0], 'clothcraft_slug': facts[1], 'clothcraft_featured': facts[1] in FEATURED})
        done += 1
    return done


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    _logger.info('clothcraft 8b: storefront facts set on %s garment(s) in %s', fill(env), cr.dbname)
