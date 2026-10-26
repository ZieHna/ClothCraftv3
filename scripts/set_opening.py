"""Sets the opening balance of the three dev suppliers (step 7): the existing stock treated as if bought from them, as a STARTING INVESTMENT. No
restock, stock move, lot or receipt is made, and stock, quants and standard_price are never touched. Idempotent: a supplier whose opening
balance is already non-zero is left alone and reported, so running it again changes nothing.

It goes through the staff API as the Administrator (PUT /api/staff/suppliers/:id/opening-balance), so last_edited_* are set and the role is
checked by Odoo. Run it INSIDE the API container, which holds the staff credentials in its environment (never printed):

    docker cp scripts/set_opening.py <api container>:/tmp/set_opening.py
    docker exec <api container> python /tmp/set_opening.py

The amounts are unit cost x units on hand for each covered variant, a tee variant counted once at its cheaper supplier (Marikina), worked out
from the shop's data at the time of the step 7 plan: 317,068 + 488,862 + 63,934 = 869,864.

Which database it writes to: the API's own ODOO_DB setting (what it sends as X-Odoo-Database) must be clothcraft_shop or clothcraft_shop_<name>,
and the catalogue must be the shop's (19 products, 10 garment types, no simulation marker); the suppliers must be the three of
scripts/seed_suppliers.py and nothing else. The API cannot name its database in an answer, so this is a check of the setting plus a fingerprint.
"""
import os
import re
import sys

import httpx

BASE = os.environ.get('SEED_BASE', 'http://127.0.0.1:8000')
ORIGIN = {'Origin': 'http://localhost:5173'}
OPENING = {
    'Marikina Knitworks Inc.': 317068,
    'Cebu Heritage Garments Corp.': 488862,
    'Laguna Stitch & Thread Manufacturing': 63934,
}


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

    login = http.post('/api/staff/auth/login', json={'email': os.environ['STAFF_ADMIN_EMAIL'], 'password': os.environ['STAFF_ADMIN_PASSWORD']})
    if login.status_code != 200 or login.json()['data']['user']['role'] != 'admin':
        stop(f'the Administrator could not sign in ({login.status_code})')

    suppliers = call(http, 'GET', '/api/staff/suppliers', params={'pageSize': 100})['data']['suppliers']
    if sorted(s['name'] for s in suppliers) != sorted(OPENING):
        stop('the suppliers are not exactly the three dev suppliers: not the database this is meant for')

    set_now = left = 0
    for supplier in suppliers:
        wanted = OPENING[supplier['name']]
        if supplier['openingBalance'] != 0:
            left += 1
            note = 'the same as the plan' if supplier['openingBalance'] == wanted else f'the plan says {wanted}'
            print(f'{supplier["name"]}: opening balance is already {supplier["openingBalance"]} ({note}); left as it is')
            continue
        call(http, 'PUT', f'/api/staff/suppliers/{supplier["id"]}/opening-balance', json={'openingBalance': wanted})
        set_now += 1
        print(f'{supplier["name"]}: opening balance set to {wanted}')
    print(f'set: {set_now}, already set (left alone): {left}')
    totals = call(http, 'GET', '/api/staff/suppliers', params={'pageSize': 1})['data']['totals']
    print(f'totals now: opening {totals["openingBalance"]}, received {totals["receivedTotal"]}, combined {totals["combinedTotal"]}')


main()
