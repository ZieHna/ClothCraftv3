from .config import Settings
from .shop import colour_info, money, whole

# The sentences of the Odoo stock guard (addons/clothcraft/models/sale_order.py), which the shop shows as they are.
MESSAGES = {
    'sold_out': 'Sorry, {label} just sold out.',
    'over_stock': 'Sorry, only {available} of {label} left.',
}


DESIGN_UNAVAILABLE = 'This design is no longer available.'


def merge_lines(lines: list[dict]) -> list[dict]:
    """Lines for one SKU and one design (or none) are counted together, first-seen order kept (as the stock guard counts them).
    A line with a design is sent with its design_id; a line without one is sent exactly as before step 9."""
    merged: dict[tuple[str, int | None], int] = {}
    for line in lines:
        key = (line['sku'], line.get('design_id'))
        merged[key] = merged.get(key, 0) + line['quantity']
    return [{'sku': sku, 'quantity': quantity, **({'design_id': design} if design else {})} for (sku, design), quantity in merged.items()]


def print_fee_json(fee: dict | None) -> dict | None:
    if not fee:
        return None
    return {'coveredSqIn': fee['covered_sq_in'], 'rate': fee['rate'], 'sizeStep': fee['size_step'], 'steps': fee['steps'],
            'unit': money(fee['unit']), 'total': money(fee['total'])}


def quote_from_odoo(odoo: dict, settings: Settings) -> dict:
    """Odoo's `clothcraft.api.quote` result -> the API's Quote. Money and VAT are Odoo's; the wording is the shop's.
    A line with a design (step 9) is a DesignedQuoteLine: the garment's price, plus its print fee (printFee), or, when the design is no
    longer available, the issue design_unavailable with nothing priced (never the plain garment's price) and Remove as the way out."""
    rows = []
    for row in odoo['lines']:
        designed = {'designId': str(row['design_id']), 'printFee': None, 'remedy': None} if row.get('design_id') else {}
        if not row['known']:
            rows.append({
                'sku': row['sku'], 'productId': '', 'name': row['sku'], 'colorName': '', 'size': None, 'image': '',
                'quantity': row['quantity'], 'unitPrice': 0, 'lineTotal': 0, 'available': 0,
                'issue': 'unavailable', 'message': 'Sorry, this item is no longer sold.', **designed})
            continue
        slug = row['slug']
        colour = row['color'].lower()
        colour_name = colour_info(colour)['name']
        available = max(0, whole(row['free_qty']))
        common = {'sku': row['sku'], 'productId': slug, 'name': row['name'], 'colorName': colour_name, 'size': row['size'],
                  'image': f'/garments/{slug}/{colour}.webp', 'quantity': row['quantity'], 'available': available}
        if row.get('design_unavailable'):
            rows.append({**common, 'unitPrice': 0, 'lineTotal': 0, 'issue': 'design_unavailable', 'message': DESIGN_UNAVAILABLE,
                         **designed, 'remedy': 'remove'})
            continue
        issue = 'sold_out' if available <= 0 else 'over_stock' if row['quantity'] > available else 'ok'
        label = f"{row['name']} ({colour_name}, {row['size']})"
        if designed:
            designed['printFee'] = print_fee_json(row.get('print_fee'))
        rows.append({
            **common, 'unitPrice': money(row['unit_price']), 'lineTotal': money(row['line_total']),
            'issue': issue, 'message': None if issue == 'ok' else MESSAGES[issue].format(label=label, available=available), **designed})
    return {
        'currency': odoo['currency'], 'vatIncluded': odoo['vat_included'], 'vatRate': whole(odoo['vat_rate']),
        'lines': rows, 'deliveryFee': 0, 'deliveryLabel': settings.delivery_label,
        'total': money(odoo['amount_total']), 'vatAmount': money(odoo['amount_tax']),
        'ready': bool(rows) and all(r['issue'] == 'ok' for r in rows),
    }
