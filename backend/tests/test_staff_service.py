"""The staff routes with a pretend Odoo: the separate cookie, what each answer of the facade becomes, and that a customer's cookie and a
staff member's cookie open nothing of each other's. The rules themselves (who may do what, the locks, the audit line) are Odoo's and are
tested in addons/clothcraft/tests/test_staff.py."""
import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from app import session as sess
from app.config import Settings
from app.main import create_app
from app.odoo import OdooClient
from app.orders import order_from_odoo

from .test_orders import COOKIE as CUSTOMER_COOKIE, odoo_order
from .test_service import MONEY, SECRET, FakeOdoo

BASE = {**MONEY, 'simulation': False}
STAFF = {'id': 9, 'name': 'Sam Staff', 'email': 'sam@example.test', 'role': 'inventory'}
SID = 'staff-sid-1'
HASH = sess.sid_hash(SID)
STAFF_COOKIE = {'Cookie': f'{sess.STAFF_COOKIE}={sess.cookie_value(SID, SECRET, "staff")}'}
PASSWORD = 'a-distinctive-staff-password-77'


def detail_data(stage='confirmed', **over):
    order = {**odoo_order(7), 'stage': stage, 'status_changed': '2026-10-22T10:05:00.000', 'staff': True,
             'customer': {'name': 'Ana Cruz', 'email': 'ana@example.com', 'phone': '0917 123 4567'},
             'history': [{'at': '2026-10-22T10:05:00.000', 'from': 'confirmed', 'to': 'packed', 'staff': 'Sam Staff', 'note': 'two boxes', 'via': 'dashboard'}],
             'allowed': [{'to': 'shipped', 'label': 'Mark as shipped', 'needs_note': False, 'confirm': False}, {'to': 'cancelled', 'label': 'Cancel order', 'needs_note': False, 'confirm': True}],
             'blocked': []}
    return {**order, **over}


class StaffOdoo(FakeOdoo):
    def __init__(self):
        super().__init__()
        self.valid = {HASH}
        self.login = lambda p: {**BASE, 'status': 'ok', 'user': STAFF, 'remaining': 7200}
        self.listing = {**BASE, 'status': 'ok', 'session_remaining': 7000, 'total': 1, 'page': 1, 'page_size': 25, 'orders': [{
            'id': 7, 'name': 'S00007', 'stage': 'confirmed', 'payment_method': 'cod', 'paid': False, 'created': '2026-10-22T10:00:00.123',
            'status_changed': '2026-10-22T10:00:00.123', 'customer_name': 'Ana Cruz', 'customer_email': 'ana@example.com', 'amount_total': 349.0, 'items': 1}]}
        self.order_result = lambda p: {**BASE, 'status': 'ok', 'session_remaining': 7000, 'order': detail_data()}
        self.transition = lambda p: {**BASE, 'status': 'done', 'session_remaining': 7000, 'order': detail_data('packed')}

    def __call__(self, request):
        name = request.url.path.rsplit('/', 1)[-1]
        body = json.loads(request.content)
        if name in ('staff_login', 'staff_logout', 'staff_session', 'staff_orders', 'staff_order', 'staff_transition'):
            self.calls.append((request.url.path, body, dict(request.headers)))
            payload = body['payload']
            if name == 'staff_login':
                return httpx.Response(200, json=self.login(payload))
            if name == 'staff_logout':
                return httpx.Response(200, json={**BASE, 'revoked': True})
            if payload['sid_hash'] not in self.valid:
                return httpx.Response(200, json={**BASE, 'valid': False} if name == 'staff_session' else {**BASE, 'status': 'unauthorised'})
            if name == 'staff_session':
                return httpx.Response(200, json={**BASE, 'valid': True, 'user': STAFF, 'remaining': 6000})
            if name == 'staff_orders':
                return httpx.Response(200, json=self.listing)
            if name == 'staff_order':
                return httpx.Response(200, json=self.order_result(payload))
            return httpx.Response(200, json=self.transition(payload))
        return super().__call__(request)


@pytest.fixture
def odoo():
    return StaffOdoo()


def make_client(odoo, **overrides):
    settings = Settings(**{'odoo_api_key': 'k', 'session_secret': SECRET, **overrides}, _env_file=None)
    return TestClient(create_app(settings, OdooClient(settings, transport=httpx.MockTransport(odoo))))


@pytest.fixture
def client(odoo):
    with make_client(odoo) as c:
        yield c


def staff_calls(odoo, name):
    return [c[1]['payload'] for c in odoo.calls if c[0].endswith('/' + name)]


def login(client, headers=None):
    return client.post('/api/staff/auth/login', json={'email': 'sam@example.test', 'password': PASSWORD}, headers=headers or {})


def move(client, to='packed', expected='confirmed', note='', headers=STAFF_COOKIE):
    return client.post('/api/staff/orders/7/transition', json={'to': to, 'expectedState': expected, 'note': note}, headers=headers)


# ------------------------------------------------------------------ sign in
def test_staff_sign_in_sets_its_own_cookie_not_the_customers(client, odoo):
    response = login(client)
    assert response.status_code == 200
    assert response.json() == {'data': {'user': {'id': '9', 'displayName': 'Sam Staff', 'email': 'sam@example.test', 'role': 'inventory'}}, 'simulation': None}
    header = response.headers['set-cookie']
    assert header.startswith(f'{sess.STAFF_COOKIE}=') and sess.COOKIE + '=' not in header
    assert 'HttpOnly' in header and 'SameSite=lax' in header and 'Path=/' in header and 'Max-Age=7200' in header and 'Secure' not in header
    value = header.split('=', 1)[1].split(';')[0]
    sid = sess.parse_cookie(value, SECRET, 'staff')
    assert sid and staff_calls(odoo, 'staff_login')[0]['sid_hash'] == sess.sid_hash(sid)
    assert sess.parse_cookie(value, SECRET) is None            # as a customer cookie it is worth nothing


def test_over_https_the_staff_cookie_is_secure_and_host_prefixed(odoo):
    with make_client(odoo, cookie_secure=True) as c:
        header = login(c).headers['set-cookie']
    assert header.startswith(f'{sess.STAFF_SECURE_COOKIE}=') and 'Secure' in header and 'Path=/' in header and 'Domain' not in header


def test_each_answer_of_a_failed_staff_sign_in(client, odoo):
    odoo.login = lambda p: {**BASE, 'status': 'invalid_credentials'}
    wrong = login(client)
    assert (wrong.status_code, wrong.json()['error']) == (401, {'code': 'invalid_credentials', 'message': 'The email or password is not right.'})
    assert 'set-cookie' not in wrong.headers
    odoo.login = lambda p: {**BASE, 'status': 'throttled', 'retry_after': 59}
    locked = login(client)
    assert locked.status_code == 429 and locked.headers['retry-after'] == '59' and locked.json()['error']['retryAfter'] == 59
    odoo.login = lambda p: {**BASE, 'status': 'mfa_unsupported'}
    mfa = login(client)
    assert mfa.status_code == 403 and mfa.json()['error'] == {'code': 'mfa_unsupported', 'message': 'This account uses two-step verification, which the staff dashboard does not support yet.'}


def test_signing_in_as_staff_ends_only_a_staff_session_the_browser_held(client, odoo):
    login(client, headers={**CUSTOMER_COOKIE, **STAFF_COOKIE, 'Cookie': f'{CUSTOMER_COOKIE["Cookie"]}; {STAFF_COOKIE["Cookie"]}'})
    assert staff_calls(odoo, 'staff_login')[0]['replace_sid_hash'] == HASH
    odoo.calls.clear()
    login(client, headers=CUSTOMER_COOKIE)
    assert staff_calls(odoo, 'staff_login')[0]['replace_sid_hash'] is None


def test_me_and_sign_out(client, odoo):
    me = client.get('/api/staff/auth/me', headers=STAFF_COOKIE)
    assert me.status_code == 200 and me.json()['data']['user']['role'] == 'inventory' and 'Max-Age=6000' in me.headers['set-cookie']
    out = client.post('/api/staff/auth/logout', headers=STAFF_COOKIE)
    assert out.status_code == 200 and out.json()['data'] == {'signedOut': True}
    assert f'{sess.STAFF_COOKIE}=' in out.headers['set-cookie'] and 'Max-Age=0' in out.headers['set-cookie']
    assert staff_calls(odoo, 'staff_logout') == [{'sid_hash': HASH}]
    odoo.valid = set()
    gone = client.get('/api/staff/auth/me', headers=STAFF_COOKIE)
    assert gone.status_code == 401 and 'Max-Age=0' in gone.headers['set-cookie'] and gone.headers['set-cookie'].startswith(sess.STAFF_COOKIE)


# ------------------------------------------------------------------ a customer's cookie and a staff member's open nothing of each other's
STAFF_ROUTES = [('GET', '/api/staff/auth/me'), ('GET', '/api/staff/orders'), ('GET', '/api/staff/orders/7'), ('POST', '/api/staff/orders/7/transition')]
CUSTOMER_ROUTES = [('GET', '/api/auth/me'), ('GET', '/api/orders'), ('GET', '/api/orders/7'), ('POST', '/api/orders')]


@pytest.mark.parametrize('method,path', STAFF_ROUTES)
def test_a_customer_cookie_never_opens_a_staff_route(client, odoo, method, path):
    forged_as_staff = {'Cookie': f'{sess.STAFF_COOKIE}={sess.cookie_value("sid-alice", SECRET)}'}     # a customer cookie value under the staff name
    for headers in (CUSTOMER_COOKIE, forged_as_staff, {'Cookie': f'{sess.STAFF_COOKIE}=forged'}, {}):
        response = client.request(method, path, json={'to': 'packed', 'expectedState': 'confirmed'}, headers=headers)
        assert response.status_code == 401, (headers, response.text)
        assert response.json()['error'] == {'code': 'unauthorised', 'message': 'Sign in to the staff dashboard to continue.'}
    assert odoo.calls == []


@pytest.mark.parametrize('method,path', CUSTOMER_ROUTES)
def test_a_staff_cookie_never_opens_a_customer_route(client, odoo, method, path):
    as_customer = {'Cookie': f'{sess.COOKIE}={sess.cookie_value(SID, SECRET, "staff")}'}              # a staff cookie value under the customer name
    for headers in (STAFF_COOKIE, as_customer):
        response = client.request(method, path, json={}, headers=headers)
        assert response.status_code == 401, (headers, response.text)
    assert odoo.calls == []


# ------------------------------------------------------------------ the orders
def test_the_list_passes_its_filters_and_maps_the_answer(client, odoo):
    response = client.get('/api/staff/orders', params=[('state', 'packed,shipped'), ('state', 'confirmed'), ('method', 'cod'), ('from', '2026-10-01'), ('to', '2026-10-31'), ('q', ' S000 '), ('page', '2'), ('pageSize', '10')], headers=STAFF_COOKIE)
    assert response.status_code == 200
    assert staff_calls(odoo, 'staff_orders')[0] == {'sid_hash': HASH, 'states': ['packed', 'shipped', 'confirmed'], 'method': 'cod', 'date_from': '2026-10-01',
                                                    'date_to': '2026-10-31', 'q': 'S000', 'page': 2, 'page_size': 10}
    assert response.json()['data'] == {'orders': [{
        'id': '7', 'reference': 'S00007', 'state': 'confirmed', 'paymentMethod': 'cod', 'paid': False, 'customer': {'name': 'Ana Cruz', 'email': 'ana@example.com'},
        'total': 349.0, 'itemCount': 1, 'createdAt': '2026-10-22T10:00:00.123Z', 'statusChangedAt': '2026-10-22T10:00:00.123Z'}], 'total': 1, 'page': 1, 'pageSize': 25}
    assert 'Max-Age=7000' in response.headers['set-cookie']


@pytest.mark.parametrize('params,code', [
    ({'state': 'flying'}, 'bad_state'), ({'method': 'card'}, 'bad_method'), ({'page': '0'}, 'bad_page'), ({'pageSize': '101'}, 'bad_page'),
    ({'pageSize': '0'}, 'bad_page'), ({'page': 'x'}, 'bad_request'),
])
def test_bad_list_parameters_are_400_and_odoo_is_not_asked(client, odoo, params, code):
    response = client.get('/api/staff/orders', params=params, headers=STAFF_COOKIE)
    assert response.status_code == 400 and response.json()['error']['code'] == code
    assert odoo.calls == []


def test_a_bad_date_is_400_with_odoos_sentence(client, odoo):
    odoo.listing = {**BASE, 'status': 'invalid', 'message': 'Dates look like 2026-10-31.'}
    response = client.get('/api/staff/orders', params={'from': '01/02/2026'}, headers=STAFF_COOKIE)
    assert response.status_code == 400 and response.json()['error'] == {'code': 'bad_date', 'message': 'Dates look like 2026-10-31.'}


def test_the_detail_has_the_order_the_customer_the_history_and_the_allowed_moves(client, odoo):
    response = client.get('/api/staff/orders/7', headers=STAFF_COOKIE)
    assert response.status_code == 200
    data = response.json()['data']
    assert data['reference'] == 'S00007' and data['state'] == 'confirmed' and data['lines'][0]['sku'] == 'M-TEE-BLK-M'
    assert data['customer'] == {'name': 'Ana Cruz', 'email': 'ana@example.com', 'phone': '0917 123 4567'}
    assert data['history'] == [{'at': '2026-10-22T10:05:00.000Z', 'from': 'confirmed', 'to': 'packed', 'staff': 'Sam Staff', 'note': 'two boxes', 'via': 'dashboard'}]
    assert data['allowed'] == [{'to': 'shipped', 'label': 'Mark as shipped', 'needsNote': False, 'confirm': False}, {'to': 'cancelled', 'label': 'Cancel order', 'needsNote': False, 'confirm': True}]
    assert data['blocked'] == []


def test_a_missing_or_malformed_order_is_404(client, odoo):
    odoo.order_result = lambda p: {**BASE, 'status': 'not_found', 'session_remaining': 7000}
    assert client.get('/api/staff/orders/999', headers=STAFF_COOKIE).json()['error'] == {'code': 'not_found', 'message': 'No order "999"'}
    assert client.get('/api/staff/orders/abc', headers=STAFF_COOKIE).status_code == 404


def test_the_state_a_customer_sees_is_the_orders_own():
    settings = Settings(session_secret=SECRET, _env_file=None)
    assert order_from_odoo({**odoo_order(7), 'stage': 'packed'}, BASE, settings)['state'] == 'packed'


# ------------------------------------------------------------------ moving an order
def test_a_move_is_passed_with_the_state_the_staff_member_saw_and_the_answer_is_the_new_order(client, odoo):
    response = move(client, note='  two boxes  ')
    assert response.status_code == 200 and response.json()['data']['state'] == 'packed'
    assert staff_calls(odoo, 'staff_transition')[0] == {'sid_hash': HASH, 'order_id': 7, 'to': 'packed', 'expected_state': 'confirmed', 'note': '  two boxes  '}
    assert response.json()['data']['reference'] == 'S00007'


@pytest.mark.parametrize('result,status,code', [
    ({'status': 'invalid_transition', 'current': 'shipped', 'message': "An order that is shipped can't be cancelled."}, 409, 'invalid_transition'),
    ({'status': 'refused', 'current': 'packed', 'message': 'Odoo could not validate this delivery.'}, 409, 'transition_refused'),
    ({'status': 'forbidden', 'current': 'confirmed', 'message': 'Only an Administrator can cancel an order that has been paid.'}, 403, 'forbidden'),
])
def test_each_refusal_of_a_move(client, odoo, result, status, code):
    odoo.transition = lambda p: {**BASE, 'session_remaining': 7000, **result}
    response = move(client, to='cancelled', expected=result['current'])
    assert response.status_code == status
    assert response.json()['error'] == {'code': code, 'message': result['message'], 'currentState': result['current']}


def test_a_conflict_carries_the_fresh_order_so_the_screen_can_show_it(client, odoo):
    odoo.transition = lambda p: {**BASE, 'session_remaining': 7000, 'status': 'state_changed', 'current': 'packed', 'order': detail_data('packed'),
                                 'message': 'This order is now packed; it was changed by Sam Staff. Nothing was done. Check it and try again.'}
    response = move(client)
    error = response.json()['error']
    assert response.status_code == 409 and error['code'] == 'state_changed' and error['currentState'] == 'packed'
    assert error['message'].startswith('This order is now packed') and error['order']['reference'] == 'S00007'


def test_a_field_problem_is_422(client, odoo):
    odoo.transition = lambda p: {**BASE, 'session_remaining': 7000, 'status': 'invalid', 'fields': {'note': 'Keep the note to 500 characters or fewer.'}}
    response = move(client, note='x' * 501)
    assert response.status_code == 422
    assert response.json()['error'] == {'code': 'validation', 'message': 'Some details need fixing.', 'fields': {'note': 'Keep the note to 500 characters or fewer.'}}


@pytest.mark.parametrize('payload', [None, {}, {'to': 'packed'}, {'to': 1, 'expectedState': 'confirmed'}, {'to': 'packed', 'expectedState': 'confirmed', 'note': 5}])
def test_an_incomplete_move_is_400_and_odoo_is_not_asked(client, odoo, payload):
    response = client.post('/api/staff/orders/7/transition', json=payload, headers=STAFF_COOKIE) if payload is not None else client.post('/api/staff/orders/7/transition', content=b'nope', headers=STAFF_COOKIE)
    assert response.status_code == 400 and response.json()['error']['code'] == 'bad_request'
    assert odoo.calls == []


def test_a_session_odoo_no_longer_knows_is_401_everywhere_and_the_cookie_is_cleared(client, odoo):
    odoo.valid = set()
    for response in (client.get('/api/staff/orders', headers=STAFF_COOKIE), client.get('/api/staff/orders/7', headers=STAFF_COOKIE), move(client)):
        assert response.status_code == 401
        assert 'Max-Age=0' in response.headers['set-cookie'] and response.headers['set-cookie'].startswith(sess.STAFF_COOKIE)


# ------------------------------------------------------------------ cross-site, passwords
def test_a_browser_post_from_another_site_is_refused_on_every_staff_route(odoo):
    with make_client(odoo, allowed_origins='http://localhost:5173') as c:
        for path in ('/api/staff/auth/login', '/api/staff/auth/logout', '/api/staff/orders/7/transition'):
            for headers in ({'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}):
                response = c.post(path, json={}, headers={**headers, **STAFF_COOKIE})
                assert response.status_code == 403 and response.json()['error']['code'] == 'forbidden_origin'
        assert odoo.calls == []
        assert login(c, headers={'Origin': 'http://localhost:5173'}).status_code == 200


def test_a_staff_password_never_comes_back_out_or_into_a_log(odoo, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    texts = []
    with make_client(odoo) as c:
        texts += [login(c).text, str(login(c).headers)]
        odoo.login = lambda p: {**BASE, 'status': 'invalid_credentials'}
        texts.append(login(c).text)
    captured = capsys.readouterr()
    assert PASSWORD not in '\n'.join(texts + [captured.out, captured.err, caplog.text])


# ------------------------------------------------------------------ step 11: the board's fields, who did what, steps back
def test_the_board_columns_are_filters_on_the_new_states_and_a_card_says_if_it_has_a_design(client, odoo):
    odoo.listing = {**odoo.listing, 'orders': [{**odoo.listing['orders'][0], 'stage': 'out_for_delivery', 'has_design': True}]}
    response = client.get('/api/staff/orders', params=[('state', 'out_for_delivery'), ('pageSize', '20')], headers=STAFF_COOKIE)
    assert response.status_code == 200
    card = response.json()['data']['orders'][0]
    assert (card['state'], card['hasDesign']) == ('out_for_delivery', True)
    assert staff_calls(odoo, 'staff_orders')[0]['states'] == ['out_for_delivery']
    for state in ('closed', 'delivered', 'shipped', 'confirmed', 'awaiting_payment', 'cancelled'):
        assert client.get('/api/staff/orders', params={'state': state}, headers=STAFF_COOKIE).status_code == 200, state


def test_the_history_says_who_by_kind_and_a_step_back_and_the_moves_their_direction(client, odoo):
    history = [
        {'at': '2026-10-24T10:00:00.000', 'from': 'out_for_delivery', 'to': 'shipped', 'staff': 'Ada Admin', 'note': 'courier late', 'via': 'dashboard', 'actor': 'staff', 'step_back': True},
        {'at': '2026-10-25T10:00:00.000', 'from': 'delivered', 'to': 'closed', 'staff': 'Ana Cruz', 'note': '', 'via': 'shop', 'actor': 'customer', 'step_back': False},
        {'at': '2026-10-26T10:00:00.000', 'from': 'delivered', 'to': 'closed', 'staff': '', 'note': '', 'via': 'cron', 'actor': 'automatic', 'step_back': False},
    ]
    allowed = [{'to': 'delivered', 'label': 'Step back to delivered', 'needs_note': True, 'confirm': False, 'direction': 'back'}]
    odoo.order_result = lambda p: {**BASE, 'status': 'ok', 'session_remaining': 7000, 'order': detail_data('closed', history=history, allowed=allowed)}
    data = client.get('/api/staff/orders/7', headers=STAFF_COOKIE).json()['data']
    assert [(h['actor'], h['stepBack'], h['via'], h['staff']) for h in data['history']] == [('staff', True, 'dashboard', 'Ada Admin'), ('customer', False, 'shop', 'Ana Cruz'), ('automatic', False, 'cron', '')]
    assert data['allowed'] == [{'to': 'delivered', 'label': 'Step back to delivered', 'needsNote': True, 'confirm': False, 'direction': 'back'}]


def test_a_step_back_without_its_note_and_by_the_wrong_role_are_refused_in_odoos_words(client, odoo):
    odoo.transition = lambda p: {**BASE, 'status': 'invalid', 'session_remaining': 7000, 'fields': {'note': 'Write a short note: say why the order is stepped back.'}}
    response = move(client, to='shipped', expected='out_for_delivery')
    assert response.status_code == 422 and response.json()['error']['fields'] == {'note': 'Write a short note: say why the order is stepped back.'}
    odoo.transition = lambda p: {**BASE, 'status': 'forbidden', 'session_remaining': 7000, 'current': 'out_for_delivery', 'message': 'Only an Administrator can step an order back.'}
    response = move(client, to='shipped', expected='out_for_delivery', note='courier late')
    assert response.status_code == 403
    assert response.json()['error'] == {'code': 'forbidden', 'message': 'Only an Administrator can step an order back.', 'currentState': 'out_for_delivery'}
