"""The shared API contract (/contract) against the REAL service and Odoo. Skipped unless CONTRACT_BASE_URL is set:

    docker compose ... run --rm --no-deps -T -v ./contract:/contract -e CONTRACT_DIR=/contract \
        -e CONTRACT_BASE_URL=http://api:8000 api python -m pytest tests/test_contract.py

The cases REGISTER CUSTOMERS AND PLACE ORDERS, so point it at a throwaway database (a copy of clothcraft_dev), never at clothcraft_sim or
clothcraft. The service under test must run with TRUSTED_PROXIES='*' (each client presents its own address, as the mock allows with
X-Forwarded-For) and no ALLOWED_ORIGINS. frontend/src/api/contract.test.ts runs the same cases against the mock.
"""
import base64
import json
import os
import struct
import zlib

import httpx
import pytest

from .contract_runner import CASE_FILES, REAL_ONLY_FILES, discover, round2, run_case

BASE = os.environ.get('CONTRACT_BASE_URL')
pytestmark = pytest.mark.skipif(not BASE, reason='CONTRACT_BASE_URL is not set')

CASES = [(file, case) for file, cases in CASE_FILES + REAL_ONLY_FILES for case in cases]
STEPS = {'XS': 0, 'S': 0, 'M': 1, 'L': 2, 'XL': 3, 'XXL': 4}


def png(width, height):
    """A real (transparent) PNG, written by hand: the service image has no picture library."""
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\x00' + b'\x00\x00\x00\x00' * width for _ in range(height))
    return base64.b64encode(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
                            + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')).decode()


def design_variables(get, found):
    """The real-only design cases (contract/real-only/08-designs.json): an upload whose one element covers the garment's whole print box,
    so its area is the garment type's print area at size Small, and the fee and totals that follow from the shop's settings."""
    listing = get('/api/catalogue/products')['data']['products']
    used = {v for k, v in found.items() if k.endswith('Sku') or k[:-1].endswith('Sku')}
    chosen, other = None, None
    for product in reversed(listing):
        for v in get(f'/api/catalogue/products/{product["id"]}')['data']['variants']:
            if chosen is None and 2 <= v['stock'] <= 90 and v['sku'] not in used:
                chosen = (product, v)
            elif chosen and other is None and product['id'] != chosen[0]['id']:
                other = v
        if chosen and other:
            break
    product, variant = chosen
    pricing = get(f'/api/designs/pricing?product={product["id"]}')['data']
    box = pricing['box']
    obj = {'type': 'Rect', 'layerId': 'contract-1', 'left': box['x'] + box['width'] / 2, 'top': box['y'] + box['height'] / 2, 'width': box['width'],
           'height': box['height'], 'scaleX': 1, 'scaleY': 1, 'angle': 0, 'skewX': 0, 'skewY': 0, 'originX': 'center', 'originY': 'center',
           'visible': True, 'opacity': 1}
    layer = {'id': 'contract-1', 'x': obj['left'], 'y': obj['top'], 'width': box['width'], 'height': box['height'], 'rotation': 0, 'visible': True, 'opacity': 1}
    state = json.dumps({'schemaVersion': 1, 'engine': 'simple', 'state': {'fabric': '7.4.0', 'objects': [obj], 'counter': 1}, 'assets': {}})
    upload = {'schemaVersion': 1, 'productId': product['id'], 'sku': variant['sku'], 'state': state, 'layers': [layer], 'pictures': [],
              'preview': png(800, 800), 'print': png(64, 64)}
    area = round2(pricing['referenceSqIn'])
    steps = STEPS[variant['size']]
    fee = round2(area * pricing['rate'] + pricing['sizeStep'] * steps)
    return {
        'designProductId': product['id'], 'designSku': variant['sku'], 'designPrice': variant['price'], 'otherDesignSku': other['sku'],
        'designArea': area, 'designSteps': steps, 'designFeeUnit': fee, 'designQuoteTotal': round2(variant['price'] + fee),
        'designQuoteAndPlain': round2(variant['price'] * 2 + fee),
        'designUpload': upload,
        'designUploadMismatch': {**upload, 'layers': [{**layer, 'x': layer['x'] + 5}]},
        'designUploadV2': {**upload, 'schemaVersion': 2},
        'designUploadJpegPreview': {**upload, 'preview': base64.b64encode(b'\xff\xd8\xff\xe0' + b'\x00' * 64).decode()},
        'designUploadHuge': {**upload, 'preview': 'A' * (29 * 1024 * 1024)},
    }


def send(method, path, query, body, headers, jar=None):
    """One request as one browser: the jar holds that browser's cookies and address. A fresh connection each time, so parallel steps
    really overlap."""
    jar = jar if jar is not None else {'__ip': '10.9.9.9'}
    headers = {**headers, 'X-Forwarded-For': jar['__ip']}
    cookie = '; '.join(f'{name}={value}' for name, value in jar.items() if name != '__ip')
    if cookie:
        headers['Cookie'] = cookie
    with httpx.Client(base_url=BASE, timeout=60) as client:
        response = client.request(method, path, params=query, json=body, headers=headers)
    for header in response.headers.get_list('set-cookie'):   # what a browser does with Set-Cookie
        name, _, rest = header.partition('=')
        value, *attributes = rest.split(';')
        if value == '' or any(attribute.strip().lower() == 'max-age=0' for attribute in attributes):
            jar.pop(name, None)
        else:
            jar[name] = value
    # a picture (a design's preview or print file) has no JSON body: the cases look at its status and headers only
    body = response.json() if response.headers.get('content-type', '').startswith('application/json') else {'bytes': len(response.content)}
    return response.status_code, body, {k.lower(): v for k, v in response.headers.items()}


@pytest.fixture(scope='module')
def variables():
    found = discover(lambda path: send('GET', path, None, None, {})[1])
    # the staff test users (backend/.env, written by scripts/create_staff_users.py); a case that needs one fails with "unknown variable" if unset
    for role in ('Inventory', 'Admin'):
        for what in ('Email', 'Password'):
            value = os.environ.get(f'STAFF_{role.upper()}_{what.upper()}')
            if value:
                found[f'staff{role}{what}'] = value
    found.update(design_variables(lambda path: send('GET', path, None, None, {})[1], found))
    return found


@pytest.mark.parametrize('file,case', CASES, ids=[f'{f}::{c["name"]}' for f, c in CASES])
def test_case(variables, file, case):
    run_case(case, variables, send)
