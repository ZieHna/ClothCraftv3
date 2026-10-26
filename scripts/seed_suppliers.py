"""Three dev suppliers with supply lines that cover every garment variant of the shop. Idempotent: run it twice and the second run creates nothing.

It goes through the staff API (the same endpoints the dashboard uses), signed in as the Administrator staff user, so VAT, validation and
last_edited_* behave as in the app. Run it INSIDE the API container, which holds the staff credentials in its environment (never printed):

    docker cp scripts/seed_suppliers.py <api container>:/tmp/seed_suppliers.py
    docker exec <api container> python /tmp/seed_suppliers.py

Which database it writes to: the API sends its ODOO_DB setting on every call as X-Odoo-Database, and this script reads that very setting
(the API container's own environment) and refuses unless it is clothcraft_shop or clothcraft_shop_<name>. It also refuses when the API
reports a simulation marker, or when the catalogue is not the shop's (19 products, 246 variants, 10 garment types, no suppliers other than
this script's three). The API cannot name its database in an answer, so this is a check of the setting plus a fingerprint, not a readback.

A line's cost is the average selling price of the variants that share the line (garment type x size x colour, price as the shop shows it
for the variant, VAT included) times the supplier's rate, rounded half up to a whole peso, never below 1. Costs of lines that already
exist are never changed (a different cost is reported).
"""
import os
import re
import sys
from decimal import ROUND_HALF_UP, Decimal

import httpx

BASE = os.environ.get('SEED_BASE', 'http://127.0.0.1:8000')
ORIGIN = {'Origin': 'http://localhost:5173'}

# (company, contact, street, city, zip, phone, ships, shipping fee, rate, garment types)
SUPPLIERS = [
    ('Marikina Knitworks Inc.', 'Liza Santos', '128 Sumulong Highway', 'Marikina City', '1800', '0917 555 0142', True, 150, '0.52', ['TEE', 'VNECK', 'CROP', 'TANK']),
    ('Cebu Heritage Garments Corp.', 'Ramon dela Cruz', '55 A.C. Cortes Avenue', 'Mandaue City', '6014', '0932 555 0188', True, 250, '0.55', ['POLO', 'LSLV', 'HOOD', 'JKT']),
    ('Laguna Stitch & Thread Manufacturing', 'Grace Villanueva', 'Block 3 Lot 7, Laguna Technopark Road', 'Biñan', '4024', '0918 555 0173', False, 0, '0.58', ['DRESS', 'ONESIE', 'TEE']),
]


def stop(message: str):
    print(f'STOP: {message}')
    sys.exit(1)


def call(http: httpx.Client, method: str, path: str, **kwargs) -> dict:
    response = http.request(method, path, **kwargs)
    if response.status_code >= 400:
        stop(f'{method} {path} answered {response.status_code}: {response.text[:300]}')
    return response.json()


def main() -> None:
    db = os.environ.get('ODOO_DB', '')
    if not re.fullmatch(r'clothcraft_shop(_[a-z0-9]+)?', db):
        stop(f'this API serves "{db}", not clothcraft_shop (or a clothcraft_shop_<name> copy)')
    if not re.match(r'http://(127\.0\.0\.1|localhost)(:\d+)?$', BASE):
        stop('the target must be the API on this machine')
    print(f'target: the API in this container, serving {db}')

    http = httpx.Client(base_url=BASE, timeout=60, headers=ORIGIN)
    shop = http.get('/api/catalogue/products')
    shop.raise_for_status()
    shop = shop.json()
    if shop.get('simulation') is not None:
        stop('the API reports simulated data')
    if shop['data']['count'] != 19 or len(shop['data']['garmentTypes']) != 10:
        stop('the catalogue is not the shop\'s (expected 19 products and 10 garment types)')

    # every variant: (garment code, size name, colour name) -> its selling price
    colour_name = {c['id']: c['name'] for c in shop['data']['colors']}
    prices: dict[tuple[str, str, str], list[Decimal]] = {}
    variants = 0
    for product in shop['data']['products']:
        detail = http.get(f"/api/catalogue/products/{product['id']}")
        detail.raise_for_status()
        for v in detail.json()['data']['variants']:
            variants += 1
            key = (product['garmentType']['code'], v['size'], colour_name[v['color']])
            prices.setdefault(key, []).append(Decimal(str(v['price'])))
    if variants != 246:
        stop(f'expected 246 variants, the catalogue has {variants}')
    print(f'catalogue: {variants} variants in {len(prices)} garment x size x colour lines')

    login = http.post('/api/staff/auth/login', json={'email': os.environ['STAFF_ADMIN_EMAIL'], 'password': os.environ['STAFF_ADMIN_PASSWORD']})
    if login.status_code != 200 or login.json()['data']['user']['role'] != 'admin':
        stop(f'the Administrator could not sign in ({login.status_code})')

    others = [s['name'] for s in call(http, 'GET', '/api/staff/suppliers', params={'pageSize': 100})['data']['suppliers'] if s['name'] not in {row[0] for row in SUPPLIERS}]
    if others:
        stop(f'there are suppliers this script did not make ({len(others)}): not the database it is meant for')
    options = {g['code']: g for g in call(http, 'GET', '/api/staff/garment-options')['data']['garmentTypes']}
    covered: set[tuple[str, str, str]] = set()
    made_suppliers = made_lines = existing_lines = 0

    for company, contact, street, city, zip_code, phone, ships, fee, rate, codes in SUPPLIERS:
        found = [s for s in call(http, 'GET', '/api/staff/suppliers', params={'q': company, 'pageSize': 100})['data']['suppliers'] if s['name'] == company]
        if found:
            supplier = call(http, 'GET', f"/api/staff/suppliers/{found[0]['id']}")['data']['supplier']
            print(f'{company}: exists (id {supplier["id"]})')
        else:
            body = {'name': company, 'contactName': contact, 'street': street, 'city': city, 'zip': zip_code, 'phone': phone, 'countryCode': 'PH', 'ships': ships}
            if ships:
                body['shippingFee'] = fee
            supplier = call(http, 'POST', '/api/staff/suppliers', json=body)['data']['supplier']
            made_suppliers += 1
            print(f'{company}: created (id {supplier["id"]})')
        have = {(l['garmentType']['id'], l['size']['id'], l['color']['id']): l for l in supplier['lines']}
        added = 0
        for (code, size, colour), list_prices in sorted(prices.items()):
            if code not in codes:
                continue
            garment = options[code]
            size_id = next(s['id'] for s in garment['sizes'] if s['name'] == size)
            colour_id = next(c['id'] for c in garment['colors'] if c['name'] == colour)
            cost = max(Decimal(1), (sum(list_prices) / len(list_prices) * Decimal(rate)).quantize(Decimal(1), rounding=ROUND_HALF_UP))
            key = (garment['id'], size_id, colour_id)
            if key in have:
                existing_lines += 1
                if Decimal(str(have[key]['unitCost'])) != cost:
                    print(f'  note: {code} {size} {colour} already costs {have[key]["unitCost"]}, the rule gives {cost}; left as it is')
            else:
                call(http, 'POST', f"/api/staff/suppliers/{supplier['id']}/lines",
                     json={'garmentTypeId': garment['id'], 'sizeValueId': size_id, 'colorValueId': colour_id, 'unitCost': int(cost)})
                made_lines += 1
                added += 1
            covered.add((code, size, colour))
        print(f'  lines added: {added}')

    missing = set(prices) - covered
    print(f'created: {made_suppliers} suppliers, {made_lines} lines; already there: {existing_lines} lines')
    print(f'lines of the catalogue not covered by any supplier: {len(missing)}')
    if missing:
        sys.exit(1)


main()
