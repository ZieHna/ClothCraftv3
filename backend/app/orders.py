from .cart import print_fee_json
from .config import Settings
from .shop import colour_info, money, provinces, whole


def utc(value: str | None) -> str | None:
    return value + 'Z' if value else None


def tracking_from_odoo(tracking: dict) -> dict:
    """Step 11: the customer's four steps with the time each was reached (times only: Odoo sends no names and no notes)."""
    return {
        'steps': [{'step': s['step'], 'reachedAt': utc(s['reached_at'])} for s in tracking['steps']],
        'current': tracking['current'], 'awaitingPayment': tracking['awaiting_payment'],
        'closedAt': utc(tracking['closed_at']), 'closedBy': tracking['closed_by'], 'canConfirm': tracking['can_confirm'],
    }


def order_from_odoo(order: dict, info: dict, settings: Settings) -> dict:
    """Odoo's order data (clothcraft.api._api_order_data) -> the API's Order."""
    d = order['delivery']
    cod = order['payment_method'] == 'cod'
    # the fulfilment state is Odoo's (clothcraft_state): awaiting_payment, confirmed, shipped, out_for_delivery, delivered, closed or
    # cancelled (step 11; packed only on an order from before it)
    state = order.get('stage') or ('cancelled' if order['cancelled'] else 'confirmed' if cod or order['paid'] else 'awaiting_payment')
    lines = []
    for line in order['lines']:
        slug = line['slug']
        colour = line['color'].lower()
        row = {
            'sku': line['sku'], 'productId': slug, 'name': line['name'], 'colorName': colour_info(colour)['name'], 'size': line['size'],
            'image': f'/garments/{slug}/{colour}.webp', 'quantity': line['quantity'],
            'unitPrice': money(line['unit_price']), 'lineTotal': money(line['line_total'])}
        if line.get('design_id'):
            # a DesignedOrderLine (step 9): the fee as it was ordered, kept on the order's own fee line
            row.update(designId=str(line['design_id']), printFee=print_fee_json(line.get('print_fee')))
        lines.append(row)
    province_name = next((p['name'] for p in provinces() if p['code'] == d['province']), d['province'])
    reference = order['name']
    tracked = {'tracking': tracking_from_odoo(order['tracking'])} if order.get('tracking') else {}
    return {
        **tracked,
        'id': str(order['id']), 'reference': reference, 'state': state, 'createdAt': order['created'] + 'Z',
        'paymentMethod': order['payment_method'], 'currency': info['currency'], 'vatIncluded': info['vat_included'],
        'vatRate': whole(info['vat_rate']), 'lines': lines,
        'delivery': {
            'fullName': d['name'], 'email': d['email'], 'phone': d['phone'], 'street': d['street'], 'city': d['city'],
            'province': d['province'], 'provinceName': province_name, 'postalCode': d['postal_code'], 'note': d['note'],
        },
        'deliveryFee': 0, 'deliveryLabel': settings.delivery_label,
        'total': money(order['amount_total']), 'vatAmount': money(order['amount_tax']),
        'bankTransfer': None if cod else {
            'placeholder': True, 'bankName': settings.bank_name, 'accountName': settings.bank_account_name,
            'accountNumber': settings.bank_account_number, 'paymentReference': reference},
    }
