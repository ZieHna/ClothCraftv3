"""The service with a pretend Odoo (httpx MockTransport): mapping, filters, errors. No network, no database."""
import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.odoo import OdooClient


SECRET = 'test-secret-test-secret-test-secret-123'


def variant(sku, color, size, price, extra, free):
    return {'sku': sku, 'color': color, 'size': size, 'price': price, 'price_extra': extra, 'free_qty': free}


def row(pid, name, price, code, gname, variants, slug, group, featured=False):
    # step 8b: the shop group, the storefront id, the featured flag and the picture's version are Odoo fields
    return {'id': pid, 'name': name, 'slug': slug, 'group': group, 'featured': featured, 'image_version': f'v{pid:011d}',
            'list_price': price, 'garment_type': {'code': code, 'name': gname}, 'variants': variants}


MONEY = {'currency': 'PHP', 'vat_rate': 12.0, 'vat_included': True, 'vat_rounding': 'round_globally'}
CATALOGUE = {
    **MONEY, 'simulation': json.dumps({'version': 1}),
    'products': [
        # deliberately out of storefront order: Women before Men
        row(2, 'Women Tee', 339.0, 'TEE', 'T-Shirt', [variant('W-TEE-BLK-S', 'Black', 'S', 339.0, 0.0, 4.0)], 'w-tee', 'Women', featured=True),
        row(1, 'Men Crew Tee', 349.0, 'TEE', 'T-Shirt', [
            variant('M-TEE-WHT-XXL', 'White', 'XXL', 399.0, 50.0, 1.0),
            variant('M-TEE-BLK-M', 'Black', 'M', 349.0, 0.0, 5.0),
            variant('M-TEE-BLK-S', 'Black', 'S', 349.0, 0.0, 0.0),
        ], 'm-tee', 'Men', featured=True),
        # featured too, but sold out: not in the featured list
        row(3, 'Men Tank Top', 299.0, 'TANK', 'Tank Top', [variant('M-TANK-BLK-M', 'Black', 'M', 299.0, 0.0, 0.0)], 'm-tank', 'Men', featured=True),
    ],
}


PNG = bytes([0x89]) + b'PNG' + bytes([13, 10, 26, 10]) + b'0' * 32   # enough of a picture for the service, which only passes the bytes on
IMAGES = {
    'm-tee': {'status': 'ok', 'mimetype': 'image/png', 'data': base64.b64encode(PNG).decode(), 'version': 'v00000000001'},
    'w-tee': {'status': 'ok', 'mimetype': 'text/html', 'data': base64.b64encode(b'<script>').decode(), 'version': 'x'},
}


class FakeOdoo:
    def __init__(self, catalogue=CATALOGUE):
        self.catalogue, self.calls = catalogue, []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.url.path, json.loads(request.content), dict(request.headers)))
        path = request.url.path
        if path == '/json/2/clothcraft.api/catalogue':
            return httpx.Response(200, json=self.catalogue)
        if path == '/json/2/clothcraft.api/shop_info':
            return httpx.Response(200, json={**MONEY, 'simulation': self.catalogue['simulation']})
        if path == '/json/2/clothcraft.api/product_image':
            return httpx.Response(200, json=IMAGES.get(json.loads(request.content)['slug'], {'status': 'not_found'}))
        if path == '/json/2/clothcraft.api/quote':
            return httpx.Response(200, json=self.quote(json.loads(request.content)['lines']))
        return httpx.Response(404, json={'message': 'no such method'})

    def quote(self, lines):
        by_sku = {v['sku']: (p, v) for p in self.catalogue['products'] for v in p['variants']}
        rows, total = [], 0.0
        for line in lines:
            if line['sku'] not in by_sku:
                rows.append({'sku': line['sku'], 'known': False, 'quantity': line['quantity']})
                continue
            product, v = by_sku[line['sku']]
            line_total = v['price'] * line['quantity']
            total += line_total
            rows.append({'sku': line['sku'], 'known': True, 'quantity': line['quantity'], 'template_id': product['id'], 'name': product['name'], 'slug': product['slug'],
                         'color': v['color'], 'size': v['size'], 'unit_price': v['price'], 'line_total': line_total, 'free_qty': v['free_qty']})
        return {**MONEY, 'simulation': self.catalogue['simulation'], 'lines': rows, 'amount_total': total, 'amount_tax': round(total * 12 / 112, 2)}


@pytest.fixture
def fake():
    return FakeOdoo()


@pytest.fixture
def client(fake):
    settings = Settings(odoo_api_key='test-key', odoo_db='the_db', session_secret=SECRET, _env_file=None)
    odoo = OdooClient(settings, transport=httpx.MockTransport(fake))
    with TestClient(create_app(settings, odoo)) as c:
        yield c


def test_the_service_talks_to_odoo_json2_with_bearer_and_database(client, fake):
    client.get('/api/catalogue/products')
    path, body, headers = fake.calls[0]
    assert path == '/json/2/clothcraft.api/catalogue'
    assert headers['authorization'] == 'Bearer test-key'
    assert headers['x-odoo-database'] == 'the_db'


def test_products_are_in_storefront_order_with_ids_groups_and_statuses(client):
    body = client.get('/api/catalogue/products').json()
    ids = [p['id'] for p in body['data']['products']]
    assert ids == ['m-tee', 'm-tank', 'w-tee']  # group Men then Women, names A-Z: "Men Crew Tee" < "Men Tank Top"
    tee = body['data']['products'][0]
    assert (tee['group'], tee['price'], tee['stock'], tee['status']) == ('Men', 349.0, 6, 'in_stock')
    assert tee['colors'] == ['black', 'white'] and tee['sizes'] == ['S', 'M', 'XXL']
    assert tee['image'] == '/api/catalogue/products/m-tee/image?v=v00000000001'   # Odoo's own picture, through this service
    assert body['data']['products'][1]['status'] == 'out_of_stock'


def test_simulation_is_stated_when_odoo_has_the_marker_and_null_when_not(client, fake):
    assert client.get('/api/catalogue/products').json()['simulation']['label'] == 'Simulated'
    fake.catalogue = {**CATALOGUE, 'simulation': False}
    assert client.get('/api/catalogue/products').json()['simulation'] is None


def test_product_detail_has_variants_in_colour_then_size_order_and_the_surcharge(client):
    data = client.get('/api/catalogue/products/m-tee').json()['data']
    assert [v['sku'] for v in data['variants']] == ['M-TEE-BLK-S', 'M-TEE-BLK-M', 'M-TEE-WHT-XXL']
    xxl = data['variants'][2]
    assert (xxl['price'], xxl['priceExtra'], xxl['stock'], xxl['status']) == (399.0, 50.0, 1, 'low_stock')
    assert data['variants'][0]['status'] == 'out_of_stock'
    assert [c['id'] for c in data['colorOptions']] == ['black', 'white']
    assert data['colorOptions'][0]['image'] == '/garments/m-tee/black.webp'
    assert data['currency'] == 'PHP' and data['vatIncluded'] is True


def test_unknown_product_is_404_in_the_error_shape(client):
    response = client.get('/api/catalogue/products/nope')
    assert response.status_code == 404
    assert response.json() == {'error': {'code': 'not_found', 'message': 'No product "nope"'}}


def test_filters_facets_and_count(client):
    body = client.get('/api/catalogue/products', params={'group': 'Men', 'type': 'TEE'}).json()['data']
    assert [p['id'] for p in body['products']] == ['m-tee'] and body['count'] == 1
    # facets are for the whole group, not narrowed by the other filters
    assert [(f['code'], f['count']) for f in body['garmentTypes']] == [('TEE', 1), ('TANK', 1)]  # "T-Shirt" sorts before "Tank Top", as localeCompare does
    assert body['priceBounds'] == {'min': 299.0, 'max': 349.0}
    assert [p['id'] for p in client.get('/api/catalogue/products', params={'q': 'tank'}).json()['data']['products']] == ['m-tank']
    assert [p['id'] for p in client.get('/api/catalogue/products', params={'min': '300', 'max': '340'}).json()['data']['products']] == ['w-tee']
    assert [p['id'] for p in client.get('/api/catalogue/products', params={'stock': '1'}).json()['data']['products']] == ['m-tee', 'w-tee']


@pytest.mark.parametrize('params,code', [
    ({'group': 'Pets'}, 'bad_group'), ({'type': 'HAT'}, 'bad_type'),
    ({'min': 'abc'}, 'bad_price'), ({'min': '-1'}, 'bad_price'), ({'min': '500', 'max': '100'}, 'bad_price'),
])
def test_bad_filters_are_400(client, params, code):
    response = client.get('/api/catalogue/products', params=params)
    assert response.status_code == 400 and response.json()['error']['code'] == code


def test_featured_is_what_odoo_flags_as_featured_and_is_not_sold_out(client):
    data = client.get('/api/catalogue/featured').json()['data']
    assert [p['id'] for p in data['products']] == ['m-tee', 'w-tee']


def test_quote_prices_merges_and_flags_each_issue(client, fake):
    lines = [{'sku': 'M-TEE-BLK-M', 'quantity': 2}, {'sku': 'M-TEE-BLK-S', 'quantity': 1}, {'sku': 'M-TEE-BLK-M', 'quantity': 4},
             {'sku': 'M-TEE-WHT-XXL', 'quantity': 1}, {'sku': 'GONE', 'quantity': 1}]
    data = client.post('/api/cart/quote', json={'lines': lines}).json()['data']
    assert fake.calls[-1][1]['lines'][0] == {'sku': 'M-TEE-BLK-M', 'quantity': 6}  # merged before Odoo is asked
    by_sku = {r['sku']: r for r in data['lines']}
    assert by_sku['M-TEE-BLK-M']['issue'] == 'over_stock'
    assert by_sku['M-TEE-BLK-M']['message'] == 'Sorry, only 5 of Men Crew Tee (Black, M) left.'
    assert by_sku['M-TEE-BLK-S']['issue'] == 'sold_out'
    assert by_sku['M-TEE-BLK-S']['message'] == 'Sorry, Men Crew Tee (Black, S) just sold out.'
    assert by_sku['M-TEE-WHT-XXL']['issue'] == 'ok' and by_sku['M-TEE-WHT-XXL']['unitPrice'] == 399.0
    assert by_sku['GONE'] == {'sku': 'GONE', 'productId': '', 'name': 'GONE', 'colorName': '', 'size': None, 'image': '', 'quantity': 1,
                              'unitPrice': 0, 'lineTotal': 0, 'available': 0, 'issue': 'unavailable', 'message': 'Sorry, this item is no longer sold.'}
    assert data['ready'] is False
    assert data['total'] == 349.0 * 6 + 349.0 + 399.0 and data['deliveryFee'] == 0
    assert data['deliveryLabel'] == 'Free delivery'   # the default; DELIVERY_LABEL in backend/.env changes it
    assert data['vatRate'] == 12


def test_quote_is_ready_when_every_line_can_be_supplied(client):
    data = client.post('/api/cart/quote', json={'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 5}]}).json()['data']
    assert data['ready'] is True and data['total'] == 1745.0 and data['vatAmount'] == round(1745 * 12 / 112, 2)


def test_quote_of_an_empty_cart_is_not_ready(client):
    data = client.post('/api/cart/quote', json={'lines': []}).json()['data']
    assert data['lines'] == [] and data['ready'] is False and data['total'] == 0


@pytest.mark.parametrize('body', [
    None, {}, {'lines': 'x'}, {'lines': [{'sku': 1, 'quantity': 1}]}, {'lines': [{'sku': 'A', 'quantity': 0}]},
    {'lines': [{'sku': 'A', 'quantity': 100}]}, {'lines': [{'sku': 'A', 'quantity': 1.5}]}, {'lines': [{'sku': 'A', 'quantity': True}]},
    {'lines': [{'sku': 'A', 'quantity': 1}] * 51},
])
def test_quote_rejects_a_bad_request(client, body):
    response = client.post('/api/cart/quote', json=body) if body is not None else client.post('/api/cart/quote', content=b'not json')
    assert response.status_code == 400 and response.json()['error']['code'] == 'bad_request'


def test_checkout_options_come_from_shop_info_and_the_province_file(client, fake):
    data = client.get('/api/checkout/options').json()['data']
    assert fake.calls[-1][0] == '/json/2/clothcraft.api/shop_info'
    assert data['vatRate'] == 12 and [m['id'] for m in data['paymentMethods']] == ['cod', 'bank_transfer']
    assert data['provinces'][0] == {'code': 'PH-00', 'name': 'Metro Manila (NCR)'} and len(data['provinces']) == 83


def test_odoo_down_is_a_502_with_a_plain_sentence_and_no_detail(fake):
    def down(_request):
        raise httpx.ConnectError('refused')
    settings = Settings(odoo_api_key='k', session_secret=SECRET, _env_file=None)
    with TestClient(create_app(settings, OdooClient(settings, transport=httpx.MockTransport(down)))) as c:
        response = c.get('/api/catalogue/products')
    assert response.status_code == 502
    assert response.json() == {'error': {'code': 'upstream_unavailable', 'message': 'The shop is not available right now. Please try again.'}}


def test_odoo_refusing_the_key_is_a_502_not_a_leak(fake):
    settings = Settings(odoo_api_key='bad', session_secret=SECRET, _env_file=None)
    refuse = httpx.MockTransport(lambda _r: httpx.Response(401, json={'message': 'Invalid apikey'}))
    with TestClient(create_app(settings, OdooClient(settings, transport=refuse))) as c:
        response = c.get('/api/catalogue/featured')
    assert response.status_code == 502 and 'apikey' not in response.text.lower()


# ---------------------------------------------------------------- the product picture (step 8b)
def test_the_picture_is_odoo_s_own_with_a_version_tag_and_a_day_of_caching(client, fake):
    response = client.get('/api/catalogue/products/m-tee/image', params={'v': 'v00000000001'})
    assert response.status_code == 200
    assert response.content == PNG
    assert response.headers['content-type'] == 'image/png'
    assert response.headers['etag'] == '"v00000000001"'
    assert response.headers['cache-control'] == 'public, max-age=86400'
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert fake.calls[-1][1] == {'slug': 'm-tee'}


def test_a_picture_the_browser_already_has_is_304(client):
    response = client.get('/api/catalogue/products/m-tee/image', headers={'If-None-Match': '"v00000000001"'})
    assert response.status_code == 304 and response.content == b''


def test_no_picture_is_404_and_a_bad_id_never_reaches_odoo(client, fake):
    assert client.get('/api/catalogue/products/nope/image').status_code == 404
    before = len(fake.calls)
    for bad in ('M-TEE', 'm_tee', 'm.tee'):
        response = client.get(f'/api/catalogue/products/{bad}/image')
        assert response.status_code == 404 and response.json()['error']['code'] == 'not_found'
    assert len(fake.calls) == before


def test_something_that_is_not_a_picture_is_never_served(client):
    assert client.get('/api/catalogue/products/w-tee/image').status_code == 404
