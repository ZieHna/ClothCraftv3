"""The order routes with a pretend Odoo: sessions, validation, status mapping, how each facade answer becomes an HTTP answer."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import session as sess
from app.config import Settings
from app.delivery import validate_delivery
from app.main import create_app
from app.odoo import OdooClient
from app.shop import provinces

from .contract_runner import ROOT
from .test_service import MONEY, SECRET, FakeOdoo

_FILE = ROOT / 'delivery-validation.json'
FIXTURE = json.loads(_FILE.read_text(encoding='utf-8')) if _FILE.exists() else None
DELIVERY = {'fullName': ' Ana Cruz ', 'email': 'ana@example.com', 'phone': '0917 123 4567', 'street': '12 Rizal Street', 'city': 'Quezon City',
            'province': 'PH-00', 'postalCode': '1100', 'note': ''}
SID = 'sid-alice'
HASH = sess.sid_hash(SID)
COOKIE = {'Cookie': f'{sess.COOKIE}={sess.cookie_value(SID, SECRET)}'}


def odoo_order(oid=7, method='cod', paid=False, cancelled=False, total=349.0):
    return {
        'id': oid, 'name': f'S{oid:05d}', 'created': '2026-10-22T10:00:00.123', 'cancelled': cancelled, 'payment_method': method, 'paid': paid,
        'lines': [{'sku': 'M-TEE-BLK-M', 'slug': 'm-tee', 'name': 'Men Crew Tee', 'color': 'Black', 'size': 'M', 'quantity': 1, 'unit_price': 349.0, 'line_total': 349.0}],
        'amount_total': total, 'amount_tax': round(total * 12 / 112, 2),
        'delivery': {'name': 'Ana Cruz', 'email': 'ana@example.com', 'phone': '0917 123 4567', 'street': '12 Rizal Street', 'city': 'Quezon City',
                     'province': 'PH-00', 'postal_code': '1100', 'note': ''},
    }


TRACKING = {'steps': [{'step': 'received', 'reached_at': '2026-10-22T10:00:00.123'}, {'step': 'shipped', 'reached_at': '2026-10-23T09:00:00.000'},
                      {'step': 'on_delivery', 'reached_at': '2026-10-24T08:00:00.000'}, {'step': 'delivered', 'reached_at': '2026-10-24T15:30:00.000'}],
            'current': 'delivered', 'awaiting_payment': False, 'closed_at': '2026-10-25T09:00:00.000', 'closed_by': 'customer', 'can_confirm': False}


class OrdersOdoo(FakeOdoo):
    """The session-bound facade methods: they answer `unauthorised` for a session hash that is not in `valid`."""

    def __init__(self):
        super().__init__()
        self.valid = {HASH}
        self.place = lambda payload: {**MONEY, 'simulation': False, 'status': 'created', 'replayed': False, 'order': odoo_order()}
        self.keyed = None
        self.orders_list = []
        self.order_found = None
        self.confirm = lambda payload: {**MONEY, 'simulation': False, 'status': 'ok', 'replayed': False, 'order': {**odoo_order(), 'stage': 'closed', 'tracking': TRACKING}}

    def __call__(self, request):
        path, body = request.url.path, json.loads(request.content)
        name = path.rsplit('/', 1)[-1]
        if name in ('place_order', 'order_by_key', 'orders', 'order', 'order_confirm_received'):
            self.calls.append((path, body, dict(request.headers)))
            hashed = body['payload']['sid_hash'] if name in ('place_order', 'order_confirm_received') else body['sid_hash']
            base = {**MONEY, 'simulation': False}
            if hashed not in self.valid:
                return httpx.Response(200, json={**base, 'status': 'unauthorised'} if name in ('place_order', 'order_confirm_received') else {**base, 'unauthorised': True})
            base['session_remaining'] = 28000
            if name == 'place_order':
                return httpx.Response(200, json={**self.place(body['payload']), 'session_remaining': 28000})
            if name == 'order_confirm_received':
                return httpx.Response(200, json={**self.confirm(body['payload']), 'session_remaining': 28000})
            if name == 'order_by_key':
                return httpx.Response(200, json={**base, 'found': self.keyed is not None, 'order': self.keyed})
            if name == 'orders':
                return httpx.Response(200, json={**base, 'orders': self.orders_list})
            return httpx.Response(200, json={**base, 'found': self.order_found is not None, 'order': self.order_found})
        return super().__call__(request)


@pytest.fixture
def odoo():
    return OrdersOdoo()


def make_client(odoo, **overrides):
    settings = Settings(**{'odoo_api_key': 'k', 'session_secret': SECRET, **overrides}, _env_file=None)
    return TestClient(create_app(settings, OdooClient(settings, transport=httpx.MockTransport(odoo))))


@pytest.fixture
def client(odoo):
    with make_client(odoo) as c:
        yield c


def body(method='cod', total=349.0, lines=None, delivery=None):
    return {'lines': lines or [{'sku': 'M-TEE-BLK-M', 'quantity': 1}], 'delivery': delivery or DELIVERY, 'paymentMethod': method, 'quotedTotal': total}


def post(client, payload, key='key-1', headers=COOKIE):
    return client.post('/api/orders', json=payload, headers={**headers, **({'Idempotency-Key': key} if key else {})})


def odoo_calls(odoo, name):
    return [c for c in odoo.calls if c[0].endswith('/' + name)]


# ------------------------------------------------------------------ the session decides who the customer is
@pytest.mark.parametrize('route', [('POST', '/api/orders'), ('GET', '/api/orders'), ('GET', '/api/orders/7')])
def test_no_session_is_401_and_odoo_is_not_asked(client, odoo, route):
    response = client.request(route[0], route[1], json=body() if route[0] == 'POST' else None)
    assert response.status_code == 401
    assert response.json() == {'error': {'code': 'unauthorised', 'message': 'Sign in to place or see orders.'}}
    assert odoo.calls == []


@pytest.mark.parametrize('headers', [
    {'X-Demo-Session': '1'},                                                           # the old stub: it means nothing now
    {'Cookie': f'{sess.COOKIE}=forged'},
    {'Cookie': f'{sess.COOKIE}={SID}.{"0" * 64}'},                                     # right id, wrong MAC
    {'Cookie': f'{sess.COOKIE}={sess.cookie_value(SID, "another-secret-another-secret-another")}'},
    {'Cookie': f'{sess.COOKIE}='},
])
def test_a_forged_or_missing_cookie_is_401_without_asking_odoo(client, odoo, headers):
    for method, path in (('GET', '/api/orders'), ('GET', '/api/orders/7')):
        assert client.request(method, path, headers=headers).status_code == 401
    assert post(client, body(), headers=headers).status_code == 401
    assert odoo.calls == []


def test_a_session_odoo_no_longer_knows_is_401_and_the_cookie_is_cleared(client, odoo):
    odoo.valid = set()
    response = client.get('/api/orders', headers=COOKIE)
    assert response.status_code == 401
    assert 'Max-Age=0' in response.headers['set-cookie'] and response.headers['set-cookie'].startswith(f'{sess.COOKIE}=')
    for placed in (post(client, body()), client.get('/api/orders/7', headers=COOKIE)):
        assert placed.status_code == 401


def test_every_order_call_names_the_session_hash_and_never_a_customer(client, odoo):
    odoo.order_found = odoo_order(7)
    post(client, body())
    client.get('/api/orders', headers=COOKIE)
    client.get('/api/orders/7', headers=COOKIE)
    for _path, sent, _headers in odoo.calls:
        flat = json.dumps(sent)
        assert HASH in flat and SID not in flat and 'partner' not in flat
    assert [c[1] for c in odoo_calls(odoo, 'order')] == [{'sid_hash': HASH, 'order_id': 7}]


def test_an_authenticated_answer_renews_the_cookie_for_what_the_session_can_still_last(client):
    response = client.get('/api/orders', headers=COOKIE)
    cookie = response.headers['set-cookie']
    assert cookie.startswith(f'{sess.COOKIE}={SID}.') and 'Max-Age=28000' in cookie and 'HttpOnly' in cookie


# ------------------------------------------------------------------ placing
def test_cash_on_delivery_is_201_confirmed_and_trimmed_values_reach_odoo(client, odoo):
    response = post(client, body())
    assert response.status_code == 201
    order = response.json()['data']
    assert (order['id'], order['reference'], order['state'], order['paymentMethod']) == ('7', 'S00007', 'confirmed', 'cod')
    assert order['bankTransfer'] is None and order['createdAt'] == '2026-10-22T10:00:00.123Z'
    assert order['delivery']['provinceName'] == 'Metro Manila (NCR)' and order['deliveryFee'] == 0
    assert order['lines'][0]['productId'] == 'm-tee' and order['lines'][0]['colorName'] == 'Black'
    sent = odoo_calls(odoo, 'place_order')[0][1]['payload']
    assert sent['sid_hash'] == HASH and sent['idempotency_key'] == 'key-1' and sent['quoted_total'] == 349.0
    assert sent['delivery']['name'] == 'Ana Cruz' and sent['delivery']['postal_code'] == '1100'
    assert sent['lines'] == [{'sku': 'M-TEE-BLK-M', 'quantity': 1}]


def test_bank_transfer_awaits_payment_with_the_order_number_as_the_reference(client, odoo):
    odoo.place = lambda p: {**MONEY, 'simulation': False, 'status': 'created', 'replayed': False, 'order': odoo_order(9, 'bank_transfer')}
    order = post(client, body('bank_transfer')).json()['data']
    assert order['state'] == 'awaiting_payment'
    assert order['bankTransfer'] == {'placeholder': True, 'bankName': 'Sample Bank (placeholder)', 'accountName': 'ClothCraft (placeholder)',
                                     'accountNumber': '0000 0000 0000 (placeholder)', 'paymentReference': 'S00009'}


def test_state_follows_payment_and_cancellation(client, odoo):
    odoo.orders_list = [odoo_order(3, 'bank_transfer', paid=True), odoo_order(2, 'bank_transfer', cancelled=True), odoo_order(1, 'bank_transfer')]
    states = [o['state'] for o in client.get('/api/orders', headers=COOKIE).json()['data']]
    assert states == ['confirmed', 'cancelled', 'awaiting_payment']


def test_a_known_key_returns_the_earlier_order_before_anything_is_checked(client, odoo):
    odoo.keyed = odoo_order(5)
    response = post(client, body(delivery={**DELIVERY, 'email': 'nope'}))
    assert response.status_code == 201 and response.json()['data']['id'] == '5'
    assert not odoo_calls(odoo, 'place_order')


def test_a_replay_found_inside_odoo_is_201_too(client, odoo):
    odoo.place = lambda p: {**MONEY, 'simulation': False, 'status': 'created', 'replayed': True, 'order': odoo_order(6)}
    assert post(client, body()).json()['data']['id'] == '6'


def test_no_key_is_allowed(client, odoo):
    assert post(client, body(), key=None).status_code == 201
    assert odoo_calls(odoo, 'place_order')[0][1]['payload']['idempotency_key'] is None
    assert not odoo_calls(odoo, 'order_by_key')


def test_invalid_delivery_is_422_with_field_messages_and_nothing_is_sent_to_odoo(client, odoo):
    response = post(client, body(delivery={**DELIVERY, 'email': 'nope', 'postalCode': '11'}))
    assert response.status_code == 422
    error = response.json()['error']
    assert error['code'] == 'validation' and error['message'] == 'Some delivery details need fixing.'
    assert error['fields'] == {'email': 'Enter an email address like name@example.com.', 'postalCode': 'Enter a 4-digit postal code, like 1000.'}
    assert not odoo_calls(odoo, 'place_order')


@pytest.mark.parametrize('payload,message', [
    ({**body(), 'paymentMethod': 'card'}, 'Choose Cash on delivery or Bank transfer.'),
    ({**body(), 'quotedTotal': 'x'}, 'The total you were shown is missing.'),
    ({**body(), 'quotedTotal': True}, 'The total you were shown is missing.'),
    ({**body(), 'lines': []}, 'The cart is empty.'),
    ({'lines': [{'sku': 'A', 'quantity': 0}], 'delivery': DELIVERY, 'paymentMethod': 'cod', 'quotedTotal': 1}, 'The order request is not complete.'),
    ({'lines': [{'sku': 'A', 'quantity': 1}], 'paymentMethod': 'cod', 'quotedTotal': 1}, 'The order request is not complete.'),
    ({**body(), 'delivery': {'fullName': 'Ana'}}, 'The order request is not complete.'),
])
def test_bad_requests_are_400(client, payload, message):
    response = post(client, payload)
    assert response.status_code == 400 and response.json()['error'] == {'code': 'bad_request', 'message': message}


def test_unreadable_json_is_400(client):
    response = client.post('/api/orders', content=b'nope', headers=COOKIE)
    assert response.status_code == 400 and response.json()['error']['code'] == 'bad_request'


def test_short_lines_are_409_stock_conflict_with_every_short_line(client, odoo):
    short = odoo.quote([{'sku': 'M-TEE-BLK-S', 'quantity': 1}, {'sku': 'M-TEE-BLK-M', 'quantity': 9}, {'sku': 'M-TEE-WHT-XXL', 'quantity': 1}])
    odoo.place = lambda p: {**MONEY, 'simulation': False, 'status': 'quote_not_ready', 'quote': short}
    response = post(client, body())
    assert response.status_code == 409
    error = response.json()['error']
    assert error['code'] == 'stock_conflict'
    assert [(l['sku'], l['available']) for l in error['lines']] == [('M-TEE-BLK-S', 0), ('M-TEE-BLK-M', 5)]
    assert error['lines'][0]['message'] == 'Sorry, Men Crew Tee (Black, S) just sold out.'
    assert error['message'] == 'Sorry, Men Crew Tee (Black, S) just sold out. Your cart has been kept.'


def test_a_lost_race_reports_the_guards_own_sentence(client, odoo):
    fresh = odoo.quote([{'sku': 'M-TEE-BLK-S', 'quantity': 1}])
    odoo.place = lambda p: {**MONEY, 'simulation': False, 'status': 'guard_refused', 'message': 'Sorry, Men Crew Tee (Black, S) just sold out.', 'quote': fresh}
    error = post(client, body()).json()['error']
    assert error['code'] == 'stock_conflict'
    assert error['message'] == 'Sorry, Men Crew Tee (Black, S) just sold out. Your cart has been kept.'
    assert error['lines'][0]['sku'] == 'M-TEE-BLK-S'


def test_a_refusal_with_nothing_short_now_still_names_the_guards_sentence(client, odoo):
    fresh = odoo.quote([{'sku': 'M-TEE-BLK-M', 'quantity': 1}])
    odoo.place = lambda p: {**MONEY, 'simulation': False, 'status': 'guard_refused', 'message': 'Sorry, only 1.0 of Men Crew Tee (Black, M) left.', 'quote': fresh}
    error = post(client, body()).json()['error']
    assert error['lines'] == [{'sku': 'M-TEE-BLK-M', 'available': 5, 'message': 'Sorry, only 1.0 of Men Crew Tee (Black, M) left.'}]


def test_a_changed_price_is_409_price_changed_with_the_new_quote(client, odoo):
    odoo.place = lambda p: {**MONEY, 'simulation': False, 'status': 'price_changed', 'quote': odoo.quote([{'sku': 'M-TEE-BLK-M', 'quantity': 1}])}
    response = post(client, body(total=300))
    assert response.status_code == 409
    error = response.json()['error']
    assert error['code'] == 'price_changed' and error['quote']['total'] == 349.0 and error['quote']['ready'] is True
    assert error['message'] == 'The price changed since you last looked. Nothing was ordered. Please check the new total.'


# ------------------------------------------------------------------ reading
def test_orders_are_listed_as_odoo_gives_them(client, odoo):
    odoo.orders_list = [odoo_order(2), odoo_order(1)]
    data = client.get('/api/orders', headers=COOKIE).json()['data']
    assert [o['id'] for o in data] == ['2', '1']


def test_one_order_and_the_404s(client, odoo):
    odoo.order_found = odoo_order(7)
    assert client.get('/api/orders/7', headers=COOKIE).json()['data']['reference'] == 'S00007'
    odoo.order_found = None
    for path in ('/api/orders/8', '/api/orders/abc', '/api/orders/-1'):
        response = client.get(path, headers=COOKIE)
        assert response.status_code == 404 and response.json()['error']['code'] == 'not_found'


# ------------------------------------------------------------------ step 11: tracking and "I received my order"
def test_an_order_carries_its_steps_with_utc_times_and_no_names(client, odoo):
    odoo.order_found = {**odoo_order(7), 'stage': 'delivered', 'tracking': {**TRACKING, 'closed_at': None, 'closed_by': None, 'can_confirm': True}}
    data = client.get('/api/orders/7', headers=COOKIE).json()['data']
    assert data['state'] == 'delivered'
    assert data['tracking'] == {
        'steps': [{'step': 'received', 'reachedAt': '2026-10-22T10:00:00.123Z'}, {'step': 'shipped', 'reachedAt': '2026-10-23T09:00:00.000Z'},
                  {'step': 'on_delivery', 'reachedAt': '2026-10-24T08:00:00.000Z'}, {'step': 'delivered', 'reachedAt': '2026-10-24T15:30:00.000Z'}],
        'current': 'delivered', 'awaitingPayment': False, 'closedAt': None, 'closedBy': None, 'canConfirm': True}


def test_a_step_not_reached_has_no_time_and_an_order_without_tracking_has_no_tracking_key(client, odoo):
    steps = [{'step': 'received', 'reached_at': None}, {'step': 'shipped', 'reached_at': None}, {'step': 'on_delivery', 'reached_at': None}, {'step': 'delivered', 'reached_at': None}]
    odoo.order_found = {**odoo_order(7, method='bank_transfer'), 'stage': 'awaiting_payment', 'tracking': {**TRACKING, 'steps': steps, 'current': None, 'awaiting_payment': True, 'closed_at': None, 'closed_by': None}}
    data = client.get('/api/orders/7', headers=COOKIE).json()['data']
    assert [s['reachedAt'] for s in data['tracking']['steps']] == [None] * 4 and data['tracking']['awaitingPayment'] is True
    odoo.order_found = odoo_order(7)
    assert 'tracking' not in client.get('/api/orders/7', headers=COOKIE).json()['data']


def test_confirming_receipt_closes_the_order_and_names_only_the_session(client, odoo):
    response = client.post('/api/orders/7/received', headers=COOKIE)
    assert response.status_code == 200
    data = response.json()['data']
    assert (data['state'], data['tracking']['closedBy'], data['tracking']['closedAt']) == ('closed', 'customer', '2026-10-25T09:00:00.000Z')
    assert odoo_calls(odoo, 'order_confirm_received')[0][1] == {'payload': {'sid_hash': HASH, 'order_id': 7}}
    assert 'set-cookie' in response.headers                                   # an active customer's cookie is renewed


def test_confirming_receipt_answers(client, odoo):
    odoo.confirm = lambda p: {**MONEY, 'simulation': False, 'status': 'not_found'}
    for path in ('/api/orders/8/received', '/api/orders/abc/received'):
        response = client.post(path, headers=COOKIE)
        assert response.status_code == 404 and response.json()['error']['code'] == 'not_found'
    odoo.confirm = lambda p: {**MONEY, 'simulation': False, 'status': 'invalid_transition', 'current': 'shipped',
                              'message': 'This order is shipped. You can confirm you received it once it has been delivered.'}
    response = client.post('/api/orders/7/received', headers=COOKIE)
    assert response.status_code == 409
    assert response.json()['error'] == {'code': 'invalid_transition', 'currentState': 'shipped', 'message': 'This order is shipped. You can confirm you received it once it has been delivered.'}


def test_confirming_receipt_needs_a_customer_session_and_the_shop_origin(odoo):
    with make_client(odoo, allowed_origins='http://localhost:5173') as c:
        assert c.post('/api/orders/7/received').status_code == 401
        assert odoo_calls(odoo, 'order_confirm_received') == []
        odoo.valid = set()
        response = c.post('/api/orders/7/received', headers=COOKIE)
        assert response.status_code == 401 and 'Max-Age=0' in response.headers['set-cookie']
        odoo.valid = {HASH}
        for headers in ({'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}):
            response = c.post('/api/orders/7/received', headers={**headers, **COOKIE})
            assert response.status_code == 403 and response.json()['error']['code'] == 'forbidden_origin'


# ------------------------------------------------------------------ the delivery rules, shared with the browser
def expand(value):
    return {k: ('x' * int(v[3:-2]) if isinstance(v, str) and v.startswith('{{x') else v) for k, v in value.items()}


@pytest.mark.skipif(FIXTURE is None, reason='contract/ is not mounted')
@pytest.mark.parametrize('case', FIXTURE['cases'] if FIXTURE else [], ids=lambda c: c['name'])
def test_delivery_rules_match_the_shared_fixture(case):
    delivery = {**FIXTURE['valid'], **expand(case['change'])}
    assert validate_delivery(delivery, [p['code'] for p in provinces()]) == case['errors']
