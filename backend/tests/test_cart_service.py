"""Step 12: the saved-cart routes with a pretend Odoo: the customer session only, what is passed on, how each answer of the facade becomes an
HTTP answer, the body cap and the origin check. The rules themselves (lines, versions, the row lock) are Odoo's: tests/test_cart.py there."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import session as sess
from app.config import Settings
from app.main import create_app
from app.odoo import OdooClient

from .test_orders import COOKIE, HASH
from .test_service import MONEY, SECRET, FakeOdoo
from .test_staff_service import STAFF_COOKIE

BASE = {**MONEY, 'simulation': False}
CART = {'version': 3, 'updated': '2026-10-24T05:00:00.000', 'lines': [
    {'sku': 'M-TEE-BLK-M', 'product_slug': 'm-tee', 'quantity': 2, 'selected': True},
    {'sku': 'M-TEE-BLK-M', 'product_slug': 'm-tee', 'quantity': 1, 'selected': False, 'design_id': '12'},
]}


class CartOdoo(FakeOdoo):
    def __init__(self):
        super().__init__()
        self.valid = {HASH}
        self.put = lambda p: {**BASE, 'status': 'ok', 'replayed': False, 'session_remaining': 28000, 'cart': CART}

    def __call__(self, request):
        name = request.url.path.rsplit('/', 1)[-1]
        if name not in ('cart_get', 'cart_put'):
            return super().__call__(request)
        body = json.loads(request.content)
        self.calls.append((request.url.path, body, dict(request.headers)))
        payload = body['payload']
        if payload['sid_hash'] not in self.valid:
            return httpx.Response(200, json={**BASE, 'status': 'unauthorised'})
        if name == 'cart_get':
            return httpx.Response(200, json={**BASE, 'status': 'ok', 'session_remaining': 28000, 'cart': CART})
        return httpx.Response(200, json=self.put(payload))


@pytest.fixture
def odoo():
    return CartOdoo()


def make_client(odoo, **overrides):
    settings = Settings(**{'odoo_api_key': 'k', 'session_secret': SECRET, **overrides}, _env_file=None)
    return TestClient(create_app(settings, OdooClient(settings, transport=httpx.MockTransport(odoo))))


@pytest.fixture
def client(odoo):
    with make_client(odoo) as c:
        yield c


def calls(odoo, name):
    return [c[1]['payload'] for c in odoo.calls if c[0].endswith('/' + name)]


def put(client, body, headers=COOKIE):
    return client.put('/api/cart', json=body, headers=headers)


def test_the_cart_is_read_for_the_session_with_no_prices(client, odoo):
    response = client.get('/api/cart', headers=COOKIE)
    assert response.status_code == 200
    assert response.json()['data'] == {'version': 3, 'updatedAt': '2026-10-24T05:00:00.000Z', 'lines': [
        {'sku': 'M-TEE-BLK-M', 'productId': 'm-tee', 'quantity': 2, 'selected': True},
        {'sku': 'M-TEE-BLK-M', 'productId': 'm-tee', 'quantity': 1, 'selected': False, 'designId': '12'}]}
    assert calls(odoo, 'cart_get') == [{'sid_hash': HASH}]
    assert 'set-cookie' in response.headers                                  # an active customer's cookie is renewed


def test_a_customer_with_no_cart_yet_gets_version_0(client, odoo):
    odoo.put = lambda p: {**BASE, 'status': 'ok', 'replayed': False, 'session_remaining': 28000, 'cart': {'version': 0, 'updated': None, 'lines': []}}
    assert put(client, {'baseVersion': 0, 'lines': []}).json()['data'] == {'version': 0, 'updatedAt': None, 'lines': []}


def test_a_write_passes_the_version_and_the_lines_as_they_were_sent(client, odoo):
    body = {'baseVersion': 2, 'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 2, 'selected': True}, {'sku': 'M-TEE-BLK-M', 'quantity': 1, 'designId': '12'}]}
    response = put(client, body)
    assert response.status_code == 200 and response.json()['data']['version'] == 3
    assert calls(odoo, 'cart_put') == [{'sid_hash': HASH, 'base_version': 2, 'lines': [
        {'sku': 'M-TEE-BLK-M', 'quantity': 2, 'selected': True}, {'sku': 'M-TEE-BLK-M', 'quantity': 1, 'selected': False, 'design_id': '12'}]}]


@pytest.mark.parametrize('route', [('GET', None), ('PUT', {'baseVersion': 0, 'lines': []})])
def test_no_customer_session_is_401_and_odoo_is_not_asked(client, odoo, route):
    method, body = route
    for headers in ({}, STAFF_COOKIE, {'Cookie': f'{sess.COOKIE}=forged.value'}):
        response = client.request(method, '/api/cart', json=body, headers=headers)
        assert response.status_code == 401 and response.json()['error']['code'] == 'unauthorised', headers
    assert odoo.calls == []


def test_a_session_odoo_no_longer_knows_is_401_and_the_cookie_is_cleared(client, odoo):
    odoo.valid = set()
    for response in (client.get('/api/cart', headers=COOKIE), put(client, {'baseVersion': 0, 'lines': []})):
        assert response.status_code == 401 and 'Max-Age=0' in response.headers['set-cookie']


@pytest.mark.parametrize('body', [{'lines': []}, {'baseVersion': True, 'lines': []}, {'baseVersion': '1', 'lines': []}, {'baseVersion': 0},
                                  {'baseVersion': 0, 'lines': {}}])
def test_an_incomplete_request_is_400_before_odoo_is_asked(client, odoo, body):
    response = put(client, body)
    assert response.status_code == 400 and response.json()['error']['code'] == 'bad_request'
    assert calls(odoo, 'cart_put') == []


def test_unreadable_json_is_400(client, odoo):
    response = client.put('/api/cart', content=b'{not json', headers={**COOKIE, 'Content-Type': 'application/json'})
    assert response.status_code == 400


def test_a_body_over_the_cap_is_413_and_never_reaches_odoo(odoo):
    with make_client(odoo, max_cart_body_bytes=200) as c:
        big = {'baseVersion': 0, 'lines': [{'sku': 'X' * 40, 'quantity': 1}] * 10}
        response = c.put('/api/cart', json=big, headers=COOKIE)
        assert response.status_code == 413 and response.json()['error']['code'] == 'payload_too_large'
        streamed = c.put('/api/cart', content=iter([json.dumps(big).encode()]), headers={**COOKIE, 'Content-Type': 'application/json'})
        assert streamed.status_code == 413
    assert calls(odoo, 'cart_put') == []


def test_a_conflict_is_409_with_the_cart_as_it_is_now(client, odoo):
    odoo.put = lambda p: {**BASE, 'status': 'conflict', 'session_remaining': 28000, 'cart': CART}
    response = put(client, {'baseVersion': 1, 'lines': []})
    assert response.status_code == 409
    error = response.json()['error']
    assert (error['code'], error['message'], error['cart']['version'], len(error['cart']['lines'])) == ('cart_conflict', 'Your cart was changed in another tab or on another device.', 3, 2)


def test_lines_odoo_refuses_are_422_with_its_messages(client, odoo):
    odoo.put = lambda p: {**BASE, 'status': 'invalid', 'session_remaining': 28000, 'fields': {'lines[0].quantity': 'The quantity is a whole number from 1 to 99.'}}
    response = put(client, {'baseVersion': 0, 'lines': [{'sku': 'M-TEE-BLK-M', 'quantity': 0}]})
    assert response.status_code == 422
    assert response.json()['error']['fields'] == {'lines[0].quantity': 'The quantity is a whole number from 1 to 99.'}


def test_too_many_writes_is_429_with_retry_after(client, odoo):
    odoo.put = lambda p: {**BASE, 'status': 'throttled', 'retry_after': 37, 'session_remaining': 28000}
    response = put(client, {'baseVersion': 0, 'lines': []})
    assert response.status_code == 429 and response.headers['retry-after'] == '37'
    assert response.json()['error']['code'] == 'too_many_attempts'


def test_a_write_from_another_site_is_refused(odoo):
    with make_client(odoo, allowed_origins='http://localhost:5173') as c:
        for headers in ({'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}):
            response = c.put('/api/cart', json={'baseVersion': 0, 'lines': []}, headers={**headers, **COOKIE})
            assert response.status_code == 403 and response.json()['error']['code'] == 'forbidden_origin'
        assert c.put('/api/cart', json={'baseVersion': 0, 'lines': []}, headers={'Origin': 'http://localhost:5173', **COOKIE}).status_code == 200
    assert len(calls(odoo, 'cart_put')) == 1
