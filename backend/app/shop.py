"""The shop's rules: how Odoo's catalogue data becomes the API shapes in frontend/src/api/types.ts.

Odoo holds names, prices, tax, free stock, and (step 8b) each garment's shop group, storefront id, featured flag and picture. It does
not hold the swatch colours or the low-stock threshold, so those are decided here (see contract/README.md for where each comes from).
"""
import json
from functools import cache
from pathlib import Path

from .config import Settings

DATA = Path(__file__).parent / 'data'


@cache
def palette() -> dict:
    return json.loads((DATA / 'palette.json').read_text(encoding='utf-8'))


@cache
def provinces() -> list[dict]:
    return json.loads((DATA / 'provinces.json').read_text(encoding='utf-8'))


def money(value: float) -> float:
    return round(value + 0.0, 2)


def whole(value: float) -> int:
    return int(round(value))


def simulation(marker) -> dict | None:
    """Odoo's simulation marker (a JSON text, or false for a real database) -> the response's `simulation`."""
    if not marker:
        return None
    return {'label': palette()['label'], 'note': palette()['note']}


def stock_status(stock: int, low_stock_at: int) -> str:
    return 'out_of_stock' if stock <= 0 else 'low_stock' if stock <= low_stock_at else 'in_stock'


def product_status(statuses: list[str], total: int) -> str:
    return 'out_of_stock' if total == 0 else 'in_stock' if 'in_stock' in statuses else 'low_stock'


def image_url(slug: str, version: str) -> str:
    """The garment's own picture, served by this service from Odoo; the version changes when the picture does, so a cache can keep it."""
    return f'/api/catalogue/products/{slug}/image' + (f'?v={version}' if version else '')


def colour_id(name: str) -> str:
    return name.lower()


def build_products(data: dict, settings: Settings) -> list[dict]:
    """Odoo's `clothcraft.api.catalogue` result -> ProductSummary + variants, in storefront order (group, then name)."""
    pal = palette()
    colour_order = [c['id'] for c in pal['colors']]
    size_order = pal['sizes']
    products = []
    for row in data['products']:
        variants = []
        for v in row['variants']:
            stock = max(0, whole(v['free_qty']))
            variants.append({
                'sku': v['sku'], 'color': colour_id(v['color']), 'size': v['size'],
                'price': money(v['price']), 'priceExtra': money(v['price_extra']),
                'stock': stock, 'status': stock_status(stock, settings.low_stock_at),
            })
        variants.sort(key=lambda v: (colour_order.index(v['color']), size_order.index(v['size'])))
        slug = row['slug']
        total = sum(v['stock'] for v in variants)
        products.append({
            'id': slug, 'name': row['name'], 'group': row['group'], 'featured': bool(row['featured']),
            'garmentType': {'code': row['garment_type']['code'], 'name': row['garment_type']['name']},
            'price': money(row['list_price']), 'image': image_url(slug, row.get('image_version') or ''),
            'colors': [c for c in colour_order if any(v['color'] == c for v in variants)],
            'sizes': [s for s in size_order if any(v['size'] == s for v in variants)],
            'stock': total, 'status': product_status([v['status'] for v in variants], total),
            'variants': variants,
        })
    products.sort(key=lambda p: (pal['groups'].index(p['group']), p['name']))
    return products


def summary(product: dict) -> dict:
    return {k: v for k, v in product.items() if k not in ('variants', 'featured')}


def facets(products: list[dict]) -> dict:
    by_code: dict[str, dict] = {}
    for p in products:
        facet = by_code.setdefault(p['garmentType']['code'], {**p['garmentType'], 'count': 0})
        facet['count'] += 1
    prices = [p['price'] for p in products]
    return {
        'garmentTypes': sorted(by_code.values(), key=lambda f: f['name'].casefold()),
        'priceBounds': {'min': min(prices, default=0), 'max': max(prices, default=0)},
    }


def colour_info(colour: str) -> dict:
    return next(c for c in palette()['colors'] if c['id'] == colour)
