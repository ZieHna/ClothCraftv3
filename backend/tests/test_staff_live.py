"""The staff dashboard's API against the REAL service and Odoo. Skipped unless CONTRACT_BASE_URL is set. It PLACES AND MOVES ORDERS, so
point it at a throwaway database (a copy of clothcraft_dev), never at clothcraft_sim or clothcraft. The two staff test users come from
STAFF_INVENTORY_* and STAFF_ADMIN_* (backend/.env, written by scripts/create_staff_users.py; never printed). The service under test
must run with TRUSTED_PROXIES='*' and no ALLOWED_ORIGINS.
"""
import os
import uuid

import httpx
import pytest

from .test_auth_live import DELIVERY, EVERYTHING, Shopper, ip, stocked

BASE = os.environ.get('CONTRACT_BASE_URL')
ENV = {k: os.environ.get(k) for k in ('STAFF_INVENTORY_EMAIL', 'STAFF_INVENTORY_PASSWORD', 'STAFF_ADMIN_EMAIL', 'STAFF_ADMIN_PASSWORD')}
pytestmark = pytest.mark.skipif(not BASE or not all(ENV.values()), reason='CONTRACT_BASE_URL or the staff test users are not set')
ORDER = ['awaiting_payment', 'confirmed', 'packed', 'shipped', 'delivered']


class Staff:
    def __init__(self, role='INVENTORY'):
        self.role = role
        self.http = httpx.Client(base_url=BASE, timeout=60, headers={'X-Forwarded-For': ip()})

    def call(self, method, path, json=None, params=None):
        response = self.http.request(method, path, json=json, params=params)
        EVERYTHING.append(response.text + str(response.headers))
        return response

    def login(self, password=None):
        return self.call('POST', '/api/staff/auth/login', {'email': ENV[f'STAFF_{self.role}_EMAIL'], 'password': password or ENV[f'STAFF_{self.role}_PASSWORD']})

    def signed_in(self):
        assert self.login().status_code == 200
        return self

    def order(self, oid):
        return self.call('GET', f'/api/staff/orders/{oid}').json()['data']

    def move(self, oid, to, expected, note=''):
        return self.call('POST', f'/api/staff/orders/{oid}/transition', {'to': to, 'expectedState': expected, 'note': note})


@pytest.fixture(autouse=True, scope='module')
def no_staff_password_anywhere():
    yield
    secrets = [ENV['STAFF_INVENTORY_PASSWORD'], ENV['STAFF_ADMIN_PASSWORD']]
    assert not any(s in text for s in secrets for text in EVERYTHING), 'a staff password came back in a response'


def place(shopper, variant, method):
    quoted = variant['price']
    response = shopper.call('POST', '/api/orders', {'lines': [{'sku': variant['sku'], 'quantity': 1}], 'delivery': DELIVERY, 'paymentMethod': method, 'quotedTotal': quoted},
                            headers={'Idempotency-Key': str(uuid.uuid4())})
    assert response.status_code == 201, response.text
    return response.json()['data']


def customer_with_order(method):
    shopper = Shopper()
    assert shopper.register().status_code == 201
    return shopper, place(shopper, stocked(1)[0], method)


# ------------------------------------------------------------------ sign in
def test_each_role_signs_in_with_its_own_cookie_and_me_knows_it():
    for role, expected in (('INVENTORY', 'inventory'), ('ADMIN', 'admin')):
        s = Staff(role)
        response = s.login()
        assert response.status_code == 200 and response.json()['data']['user']['role'] == expected
        header = response.headers['set-cookie']
        assert header.startswith('cc_staff=') and 'HttpOnly' in header and 'Max-Age=7200' in header and 'cc_session' not in header
        assert s.call('GET', '/api/staff/auth/me').json()['data']['user']['role'] == expected


def test_a_wrong_password_and_a_customer_account_cannot_sign_in_as_staff():
    wrong = Staff().login(password='not the password')
    assert wrong.status_code == 401 and wrong.json()['error']['code'] == 'invalid_credentials' and 'set-cookie' not in wrong.headers
    shopper = Shopper()
    shopper.register()
    refused = Staff().call('POST', '/api/staff/auth/login', {'email': shopper.mail, 'password': 'live test password 7Qx!'})
    assert refused.status_code == 401 and refused.json()['error']['code'] == 'invalid_credentials'


def test_a_customer_and_a_staff_session_open_nothing_of_each_others():
    shopper, _ = customer_with_order('cod')
    staff = Staff().signed_in()
    with httpx.Client(base_url=BASE, timeout=60, cookies={'cc_staff': shopper.cookie.value}) as http:      # the customer's cookie under the staff name
        assert http.get('/api/staff/orders').status_code == 401
    with httpx.Client(base_url=BASE, timeout=60, cookies={'cc_session': staff.http.cookies['cc_staff']}) as http:   # and the other way
        assert http.get('/api/orders').status_code == 401
        assert http.get('/api/auth/me').status_code == 401
    assert Shopper().call('GET', '/api/staff/orders').status_code == 401


def test_signing_out_ends_the_staff_session_for_real():
    s = Staff().signed_in()
    kept = s.http.cookies['cc_staff']
    assert s.call('POST', '/api/staff/auth/logout').status_code == 200
    with httpx.Client(base_url=BASE, timeout=60, cookies={'cc_staff': kept}) as http:
        assert http.get('/api/staff/orders').status_code == 401


# ------------------------------------------------------------------ the orders
def test_the_list_filters_and_the_detail_shows_the_customer_and_the_moves():
    _shopper, order = customer_with_order('cod')
    s = Staff().signed_in()
    found = s.call('GET', '/api/staff/orders', params={'q': order['reference'], 'state': 'confirmed', 'method': 'cod'}).json()['data']
    assert [o['reference'] for o in found['orders']] == [order['reference']] and found['total'] == 1
    assert s.call('GET', '/api/staff/orders', params={'q': order['reference'], 'state': 'packed'}).json()['data']['orders'] == []
    assert s.call('GET', '/api/staff/orders', params={'state': 'flying'}).status_code == 400
    detail = s.order(order['id'])
    assert detail['customer']['email'] and detail['state'] == 'confirmed' and detail['history'] == []
    assert [a['to'] for a in detail['allowed']] == ['packed', 'cancelled']
    assert s.call('GET', '/api/staff/orders/99999999').status_code == 404


def test_a_cod_order_walks_to_delivered_and_the_customer_sees_each_status():
    shopper, order = customer_with_order('cod')
    s = Staff().signed_in()
    seen = [shopper.call('GET', f'/api/orders/{order["id"]}').json()['data']['state']]
    for to, expected in (('packed', 'confirmed'), ('shipped', 'packed'), ('delivered', 'shipped')):
        response = s.move(order['id'], to, expected, note='live walk')
        assert response.status_code == 200 and response.json()['data']['state'] == to, response.text
        seen.append(shopper.call('GET', f'/api/orders/{order["id"]}').json()['data']['state'])
    assert seen == ['confirmed', 'packed', 'shipped', 'delivered']
    history = s.order(order['id'])['history']
    assert [(h['from'], h['to'], h['via']) for h in history] == [('confirmed', 'packed', 'dashboard'), ('packed', 'shipped', 'dashboard'), ('shipped', 'delivered', 'dashboard')]
    assert s.order(order['id'])['allowed'] == []
    assert s.move(order['id'], 'cancelled', 'delivered').json()['error']['code'] == 'invalid_transition'


def test_a_stale_screen_is_a_conflict_that_changes_nothing():
    _shopper, order = customer_with_order('cod')
    one, two = Staff().signed_in(), Staff('ADMIN').signed_in()
    assert one.move(order['id'], 'packed', 'confirmed').status_code == 200
    late = two.move(order['id'], 'packed', 'confirmed')
    error = late.json()['error']
    assert late.status_code == 409 and error['code'] == 'state_changed' and error['currentState'] == 'packed' and error['order']['state'] == 'packed'
    assert len(two.order(order['id'])['history']) == 1


def test_a_bank_order_is_paid_by_staff_then_only_an_administrator_cancels_it_and_with_a_note():
    shopper, order = customer_with_order('bank_transfer')
    inventory, admin = Staff().signed_in(), Staff('ADMIN').signed_in()
    assert order['state'] == 'awaiting_payment'
    assert inventory.move(order['id'], 'confirmed', 'awaiting_payment').status_code == 200
    forbidden = inventory.move(order['id'], 'cancelled', 'confirmed', note='customer asked')
    assert forbidden.status_code == 403 and forbidden.json()['error']['code'] == 'forbidden'
    no_note = admin.move(order['id'], 'cancelled', 'confirmed')
    assert no_note.status_code == 422 and 'note' in no_note.json()['error']['fields']
    done = admin.move(order['id'], 'cancelled', 'confirmed', note='customer asked')
    assert done.status_code == 200 and done.json()['data']['state'] == 'cancelled'
    assert 'refund' in done.json()['data']['history'][-1]['note'].lower()
    customer_view = shopper.call('GET', f'/api/orders/{order["id"]}').json()['data']
    assert customer_view['state'] == 'cancelled' and 'refund' not in str(customer_view).lower()


def test_an_unpaid_bank_order_can_be_cancelled_by_inventory_staff_and_the_stock_goes_back():
    _shopper, order = customer_with_order('bank_transfer')
    s = Staff().signed_in()
    response = s.move(order['id'], 'cancelled', 'awaiting_payment', note='never paid')
    assert response.status_code == 200 and response.json()['data']['state'] == 'cancelled'
    assert s.move(order['id'], 'confirmed', 'cancelled').json()['error']['code'] == 'invalid_transition'


def test_a_note_over_500_characters_is_a_field_problem():
    _shopper, order = customer_with_order('cod')
    response = Staff().signed_in().move(order['id'], 'packed', 'confirmed', note='x' * 501)
    assert response.status_code == 422 and 'note' in response.json()['error']['fields']
