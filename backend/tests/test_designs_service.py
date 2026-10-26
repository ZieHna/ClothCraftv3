"""The design routes (step 9b) with a pretend Odoo: the body cap that refuses a too-large upload while it streams in, what each answer of
the facade becomes, the picture headers, the staff download, and quotes and orders with a design. The checks themselves (pictures, the
element list, limits, whose design it is, the fee) are Odoo's and are tested in addons/clothcraft/tests/test_designs.py."""
import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import session as sess
from app.config import Settings
from app.main import create_app
from app.odoo import OdooClient

from .test_orders import COOKIE, HASH, odoo_order
from .test_service import MONEY, SECRET, FakeOdoo

BASE = {**MONEY, 'simulation': False}
STAFF_SID = 'staff-sid-9'
STAFF_COOKIE = {'Cookie': f'{sess.STAFF_COOKIE}={sess.cookie_value(STAFF_SID, SECRET, "staff")}'}
PNG = base64.b64encode(b'\x89PNG\r\n\x1a\n-pretend-').decode()
DESIGN = {'id': 12, 'slug': 'm-tee', 'sku': 'M-TEE-BLK-M', 'state': 'draft', 'covered_sq_in': 12.0, 'layer_count': 1, 'print_px': 3200,
          'created': '2026-10-23T10:00:00.000', 'version': 'abc123def456'}
FEE = {'covered_sq_in': 12.0, 'rate': 2.0, 'size_step': 20.0, 'steps': 1, 'unit': 44.0, 'total': 44.0}
UPLOAD = {'schemaVersion': 1, 'productId': 'm-tee', 'sku': 'M-TEE-BLK-M', 'state': '{}', 'layers': [], 'pictures': [], 'preview': PNG, 'print': PNG}


class DesignOdoo(FakeOdoo):
    def __init__(self):
        super().__init__()
        self.upload = lambda p: {**BASE, 'status': 'created', 'replayed': False, 'session_remaining': 600, 'design': DESIGN}
        self.void = lambda p: {**BASE, 'status': 'voided', 'session_remaining': 600}
        self.place = lambda p: {**BASE, 'status': 'created', 'session_remaining': 600, 'order': self.order_data()}
        self.mine = {12}

    @staticmethod
    def order_data():
        order = odoo_order(7, total=393.0)
        order['lines'][0].update(design_id=12, print_fee=FEE)
        return order

    def quote(self, lines, sid_hash=None):
        result = super().quote([{k: v for k, v in line.items() if k != 'design_id'} for line in lines])
        for line, row in zip(lines, result['lines']):
            if not line.get('design_id'):
                continue
            row['design_id'] = line['design_id']
            if line['design_id'] == 99:
                return {**BASE, 'status': 'invalid', 'code': 'product_mismatch', 'message': 'This design was made for another garment.'}
            if sid_hash != HASH or line['design_id'] not in self.mine:
                result['amount_total'] -= row.pop('line_total')
                row.pop('unit_price')
                row.update(design_unavailable=True, message='This design is no longer available.')
            else:
                row['print_fee'] = {**FEE, 'total': FEE['unit'] * line['quantity']}
                result['amount_total'] += row['print_fee']['total']
        return {**result, 'status': 'ok'}

    def __call__(self, request):
        name = request.url.path.rsplit('/', 1)[-1]
        body = json.loads(request.content)
        if name == 'quote':
            self.calls.append((request.url.path, body, dict(request.headers)))
            return httpx.Response(200, json=self.quote(body['lines'], body.get('sid_hash')))
        if name == 'place_order':
            self.calls.append((request.url.path, body, dict(request.headers)))
            return httpx.Response(200, json=self.place(body['payload']))
        if name.startswith('design_') or name == 'staff_design_image':
            self.calls.append((request.url.path, body, dict(request.headers)))
            if name == 'design_pricing':
                if body['slug'] != 'm-tee':
                    return httpx.Response(200, json={**BASE, 'status': 'not_found'})
                return httpx.Response(200, json={**BASE, 'status': 'ok', 'product_id': 3, 'designable': True, 'message': '',
                                                 'box': {'x': 87.49, 'y': 57.56, 'width': 620.63, 'height': 683.43}, 'reference_sq_in': 200.0,
                                                 'rate': 2.0, 'size_step': 20.0, 'steps': {'XS': 0, 'S': 0, 'M': 1, 'L': 2, 'XL': 3, 'XXL': 4}, 'band': 0.25,
                                                 'limits': {'total': 20971520, 'picture': 5242880, 'pictures': 8, 'layers': 50, 'preview': 2097152,
                                                            'print': 12582912, 'state': 524288, 'print_px': 4096, 'preview_px': 800}})
            payload = body['payload']
            if name == 'staff_design_image':
                if payload['sid_hash'] != sess.sid_hash(STAFF_SID):
                    return httpx.Response(200, json={'status': 'unauthorised'})
                return httpx.Response(200, json={'status': 'ok', 'mimetype': 'image/png', 'data': PNG, 'version': 'v1', 'filename': 'S00007-1-M-TEE-BLK-M.png'})
            if payload['sid_hash'] != HASH:
                return httpx.Response(200, json={**BASE, 'status': 'unauthorised'})
            if name == 'design_upload':
                return httpx.Response(200, json=self.upload(payload))
            if payload['design_id'] not in self.mine:
                return httpx.Response(200, json={**BASE, 'status': 'not_found'})
            if name == 'design_get':
                return httpx.Response(200, json={**BASE, 'status': 'ok', 'session_remaining': 600, 'design': DESIGN})
            if name == 'design_state':
                return httpx.Response(200, json={**BASE, 'status': 'ok', 'session_remaining': 600, 'design': DESIGN, 'state': '{"schemaVersion": 1}',
                                                 'pictures': [{'id': 'img-1', 'mimetype': 'image/png', 'data': PNG}]})
            if name == 'design_image':
                return httpx.Response(200, json={'status': 'ok', 'mimetype': 'image/png', 'data': PNG, 'version': 'v1', 'filename': f'design-12-{payload["kind"]}.png'})
            return httpx.Response(200, json=self.void(payload))
        return super().__call__(request)

    def names(self):
        return [path.rsplit('/', 1)[-1] for path, _b, _h in self.calls]


@pytest.fixture
def odoo():
    return DesignOdoo()


def make_client(odoo, **overrides):
    settings = Settings(**{'odoo_api_key': 'k', 'session_secret': SECRET, **overrides}, _env_file=None)
    return TestClient(create_app(settings, OdooClient(settings, transport=httpx.MockTransport(odoo))))


@pytest.fixture
def client(odoo):
    return make_client(odoo)


# ------------------------------------------------------------------ pricing
def test_pricing_of_a_garment_and_of_an_unknown_one(client):
    data = client.get('/api/designs/pricing', params={'product': 'm-tee'}).json()['data']
    assert (data['productId'], data['designable'], data['message'], data['rate'], data['sizeStep'], data['referenceSqIn']) == ('m-tee', True, None, 2.0, 20.0, 200.0)
    assert data['limits'] == {'totalBytes': 20971520, 'pictureBytes': 5242880, 'pictures': 8, 'elements': 50, 'previewBytes': 2097152,
                              'printBytes': 12582912, 'stateBytes': 524288, 'printMaxPx': 4096, 'previewPx': 800}
    assert client.get('/api/designs/pricing', params={'product': 'nope'}).status_code == 404


# ------------------------------------------------------------------ uploading
def test_an_upload_needs_a_session_and_a_version_1_body(client, odoo):
    assert client.post('/api/designs', json=UPLOAD).status_code == 401
    response = client.post('/api/designs', json={**UPLOAD, 'schemaVersion': 2}, headers=COOKIE)
    assert (response.status_code, response.json()['error']) == (422, {'code': 'format', 'message': 'This design could not be read (format version 1 expected).'})
    assert client.post('/api/designs', content=b'not json', headers={**COOKIE, 'Content-Type': 'application/json'}).status_code == 422
    assert 'design_upload' not in odoo.names()


def test_an_upload_is_passed_on_with_its_key_and_answered_with_the_design(client, odoo):
    response = client.post('/api/designs', json=UPLOAD, headers={**COOKIE, 'Idempotency-Key': 'key-1'})
    assert response.status_code == 201
    assert response.json()['data'] == {'id': '12', 'productId': 'm-tee', 'sku': 'M-TEE-BLK-M', 'state': 'draft', 'coveredSqIn': 12.0, 'layerCount': 1,
                                       'printPx': 3200, 'createdAt': '2026-10-23T10:00:00.000Z',
                                       'previewUrl': '/api/designs/12/preview.png?v=abc123def456', 'printUrl': '/api/designs/12/print.png?v=abc123def456'}
    payload = next(b for p, b, _h in odoo.calls if p.endswith('design_upload'))['payload']
    assert (payload['product'], payload['sku'], payload['idempotency_key'], payload['sid_hash']) == ('m-tee', 'M-TEE-BLK-M', 'key-1', HASH)


def test_a_body_over_the_cap_is_refused_before_it_is_read_whole(odoo):
    client = make_client(odoo, max_design_body_bytes=1000)
    big = json.dumps({**UPLOAD, 'preview': 'A' * 2000}).encode()
    response = client.post('/api/designs', content=big, headers={**COOKIE, 'Content-Type': 'application/json'})
    assert (response.status_code, response.json()['error']['code']) == (413, 'too_large')
    assert response.json()['error']['message'] == 'This design is too large to upload (at most 20 MB in all). Use smaller pictures or fewer of them.'

    def chunks():   # no Content-Length: the cap is applied while the body streams in
        for start in range(0, len(big), 256):
            yield big[start:start + 256]

    response = client.post('/api/designs', content=chunks(), headers={**COOKIE, 'Content-Type': 'application/json'})
    assert response.status_code == 413
    assert 'design_upload' not in odoo.names()


def test_a_refusal_keeps_odoos_status_code_and_sentence(client, odoo):
    odoo.upload = lambda p: {**BASE, 'status': 'refused', 'code': 'picture_type', 'http_status': 415, 'message': 'Only PNG, JPEG or WebP pictures can be used.'}
    response = client.post('/api/designs', json=UPLOAD, headers=COOKIE)
    assert (response.status_code, response.json()['error']) == (415, {'code': 'picture_type', 'message': 'Only PNG, JPEG or WebP pictures can be used.'})


# ------------------------------------------------------------------ the customer's own design
def test_the_pictures_are_private_and_versioned(client):
    response = client.get('/api/designs/12/preview.png', headers=COOKIE)
    assert (response.status_code, response.headers['content-type'], response.content) == (200, 'image/png', base64.b64decode(PNG))
    assert (response.headers['cache-control'], response.headers['x-content-type-options'], response.headers['etag']) == ('private, max-age=3600', 'nosniff', '"v1"')
    assert response.headers['content-disposition'] == 'inline; filename="design-12-preview.png"'
    assert client.get('/api/designs/12/print.png', headers=COOKIE).headers['content-disposition'] == 'attachment; filename="design-12-print.png"'
    assert client.get('/api/designs/12/preview.png', headers={**COOKIE, 'If-None-Match': '"v1"'}).status_code == 304
    assert client.get('/api/designs/13/preview.png', headers=COOKIE).status_code == 404
    assert client.get('/api/designs/12/preview.png').status_code == 401
    assert client.get('/api/designs/abc', headers=COOKIE).status_code == 404


def test_the_owner_reopens_a_design_with_its_state_and_pictures(client):
    # first without a customer session (the test client keeps cookies a response sets, so these go before any signed-in call)
    assert client.get('/api/designs/12/state').status_code == 401
    assert client.get('/api/designs/12/state', headers=STAFF_COOKIE).status_code == 401
    data = client.get('/api/designs/12/state', headers=COOKIE).json()['data']
    assert (data['design']['id'], data['state'], data['pictures']) == ('12', '{"schemaVersion": 1}', [{'id': 'img-1', 'type': 'image/png', 'data': PNG}])
    assert client.get('/api/designs/13/state', headers=COOKIE).status_code == 404


def test_removing_a_design(client, odoo):
    assert client.delete('/api/designs/12', headers=COOKIE).json()['data'] == {'removed': True}
    assert client.delete('/api/designs/13', headers=COOKIE).status_code == 404
    odoo.void = lambda p: {**BASE, 'status': 'refused', 'code': 'ordered', 'http_status': 409, 'message': 'This design is on an order and cannot be removed.'}
    response = client.delete('/api/designs/12', headers=COOKIE)
    assert (response.status_code, response.json()['error']['code']) == (409, 'ordered')


def test_staff_download_a_design_and_customers_cannot(client, odoo):
    response = client.get('/api/staff/designs/12/print.png', headers=STAFF_COOKIE)
    assert response.status_code == 200
    assert (response.headers['content-disposition'], response.headers['cache-control']) == ('attachment; filename="S00007-1-M-TEE-BLK-M.png"', 'private, no-store')
    calls = len(odoo.calls)
    assert client.get('/api/staff/designs/12/print.png', headers=COOKIE).status_code == 401
    assert len(odoo.calls) == calls   # a customer cookie never reaches Odoo's staff method
    assert client.get('/api/designs/12/print.png', headers=STAFF_COOKIE).status_code == 401


# ------------------------------------------------------------------ quotes and orders
def test_a_designed_line_carries_its_print_fee(client, odoo):
    response = client.post('/api/cart/quote', json={'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 2, 'designId': '12'}, {'sku': 'M-TEE-BLK-M', 'quantity': 1}]}, headers=COOKIE)
    data = response.json()['data']
    designed, plain = data['lines']
    assert (designed['designId'], designed['printFee'], designed['remedy'], designed['issue']) == ('12', {**{'coveredSqIn': 12.0, 'rate': 2.0, 'sizeStep': 20.0, 'steps': 1}, 'unit': 44.0, 'total': 88.0}, None, 'ok')
    assert 'designId' not in plain and 'printFee' not in plain
    sent = next(b for p, b, _h in odoo.calls if p.endswith('/quote'))
    assert (sent['lines'], sent['sid_hash']) == ([{'sku': 'M-TEE-BLK-M', 'quantity': 2, 'design_id': 12}, {'sku': 'M-TEE-BLK-M', 'quantity': 1}], HASH)


def test_a_cart_without_designs_is_quoted_exactly_as_before(client, odoo):
    client.post('/api/cart/quote', json={'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 1}]}, headers=COOKIE)
    sent = next(b for p, b, _h in odoo.calls if p.endswith('/quote'))
    assert sent == {'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 1}]}


def test_a_design_that_is_gone_is_an_issue_with_remove_and_is_never_priced(client):
    for headers in (COOKIE, {}):
        data = client.post('/api/cart/quote', json={'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 1, 'designId': '13'}]}, headers=headers).json()['data']
        line = data['lines'][0]
        assert (line['issue'], line['message'], line['remedy'], line['unitPrice'], line['lineTotal'], line['printFee']) == (
            'design_unavailable', 'This design is no longer available.', 'remove', 0, 0, None)
        assert (data['ready'], data['total']) == (False, 0)


def test_a_design_for_another_garment_and_a_bad_design_id(client):
    response = client.post('/api/cart/quote', json={'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 1, 'designId': '99'}]}, headers=COOKIE)
    assert (response.status_code, response.json()['error']['code']) == (422, 'product_mismatch')
    for bad in (12, 'abc', '1' * 13, ''):
        assert client.post('/api/cart/quote', json={'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 1, 'designId': bad}]}).status_code == 400


ORDER = {'paymentMethod': 'cod', 'quotedTotal': 393.0,
         'delivery': {'fullName': 'Ana Cruz', 'email': 'ana@example.com', 'phone': '0917 123 4567', 'street': '12 Rizal Street', 'city': 'Quezon City',
                      'province': 'PH-00', 'postalCode': '1100', 'note': ''}}


def test_an_order_line_with_a_design_keeps_its_fee(client):
    response = client.post('/api/orders', json={**ORDER, 'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 1, 'designId': '12'}]}, headers=COOKIE)
    line = response.json()['data']['lines'][0]
    assert (response.status_code, line['designId'], line['printFee']['unit']) == (201, '12', 44.0)


def test_an_order_with_a_design_that_is_gone_is_409(client, odoo):
    quote = odoo.quote([{'sku': 'M-TEE-BLK-M', 'quantity': 1, 'design_id': 13}], HASH)
    odoo.place = lambda p: {**BASE, 'status': 'quote_not_ready', 'session_remaining': 600, 'quote': quote}
    response = client.post('/api/orders', json={**ORDER, 'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 1, 'designId': '13'}]}, headers=COOKIE)
    error = response.json()['error']
    assert (response.status_code, error['code'], error['lines'][0]['message']) == (409, 'design_unavailable', 'This design is no longer available.')
