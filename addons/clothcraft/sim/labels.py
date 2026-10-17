from .data import CATEGORY_NAME, GARMENT_TYPES, SIM_LABEL

LABEL_MODELS = {'partner': 'res.partner.category', 'product': 'product.tag', 'order': 'crm.tag'}


def preexisting(env):
    """What already exists before the seed creates anything, so purge removes only what the seed made."""
    return {
        'labels': [name for name, model in LABEL_MODELS.items() if env[model].search_count([('name', '=', SIM_LABEL)])],
        'garment_types': env['clothcraft.garment.type'].search([('code', 'in', list(GARMENT_TYPES))]).mapped('code'),
        'category': bool(env['product.category'].search_count([('name', '=', CATEGORY_NAME)])),
    }


def ensure_labels(env):
    """The three labels every simulated record carries (or is reachable from): partner category, product tag,
    sale-order tag. Reused if they already exist."""
    labels = {}
    for name, model in LABEL_MODELS.items():
        labels[name] = env[model].search([('name', '=', SIM_LABEL)], limit=1) or env[model].create({'name': SIM_LABEL})
    return labels
