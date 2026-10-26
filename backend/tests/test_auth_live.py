"""Customer accounts against the REAL service and Odoo. Skipped unless CONTRACT_BASE_URL is set. It REGISTERS CUSTOMERS AND PLACES
ORDERS, so point it at a throwaway database (a copy of clothcraft_dev), never at clothcraft_sim or clothcraft. The service under
test must run with TRUSTED_PROXIES='*' (so each test can present its own client address) and no ALLOWED_ORIGINS.

    docker compose ... run --rm --no-deps -T -e CONTRACT_BASE_URL=http://<api container>:8000 api python -m pytest tests/test_auth_live.py
"""
import os
import random
import threading
import uuid

import httpx
import pytest

BASE = os.environ.get('CONTRACT_BASE_URL')
pytestmark = pytest.mark.skipif(not BASE, reason='CONTRACT_BASE_URL is not set')
PASSWORD = 'live test password 7Qx!'
DELIVERY = {'fullName': 'Juana Dela Cruz', 'email': 'juana@example.com', 'phone': '09171234567', 'street': '12 Rizal Street', 'city': 'Quezon City',
            'province': 'PH-00', 'postalCode': '1100', 'note': ''}
EVERYTHING: list[str] = []   # every response body and header seen, to look for the passwords in


def ip():
    return f'10.{random.randint(1, 250)}.{random.randint(1, 250)}.{random.randint(1, 250)}'


def email(name='live'):
    return f'{name}-{uuid.uuid4().hex[:10]}@example.test'


class Shopper:
    """A browser: its own cookie jar and its own client address."""

    def __init__(self, address=None):
        self.address = address or ip()
        self.http = httpx.Client(base_url=BASE, timeout=60, headers={'X-Forwarded-For': self.address})

    def call(self, method, path, json=None, headers=None):
        response = self.http.request(method, path, json=json, headers=headers)
        EVERYTHING.append(response.text + str(response.headers))
        return response

    def register(self, mail=None, password=PASSWORD, name='Ana Cruz', **kw):
        self.mail = mail or email()
        return self.call('POST', '/api/auth/register', {'name': name, 'email': self.mail, 'password': password}, **kw)

    def login(self, mail, password=PASSWORD, **kw):
        return self.call('POST', '/api/auth/login', {'email': mail, 'password': password}, **kw)

    @property
    def cookie(self):
        return next(iter(self.http.cookies.jar), None)


@pytest.fixture(autouse=True, scope='module')
def no_password_anywhere():
    yield
    assert not any(PASSWORD in text for text in EVERYTHING), 'a password came back in a response'


def stocked(count):
    """`count` different variants with enough stock to order one of."""
    with httpx.Client(base_url=BASE, timeout=60) as http:
        found = []
        for product in http.get('/api/catalogue/products').json()['data']['products']:
            for v in http.get(f'/api/catalogue/products/{product["id"]}').json()['data']['variants']:
                if 6 <= v['stock'] <= 60:
                    found.append(v)
        assert len(found) >= count
        return found[-count:]


def place(shopper, variant, key=None):
    return shopper.call('POST', '/api/orders', {'lines': [{'sku': variant['sku'], 'quantity': 1}], 'delivery': DELIVERY, 'paymentMethod': 'cod', 'quotedTotal': variant['price']},
                        headers={'Idempotency-Key': key or str(uuid.uuid4())})


# ------------------------------------------------------------------ register, me, cookie
def test_register_signs_in_with_a_hardened_cookie_and_me_knows_the_customer():
    s = Shopper()
    response = s.register(name='Ana Cruz')
    assert response.status_code == 201
    user = response.json()['data']['user']
    assert user['displayName'] == 'Ana Cruz' and user['email'] == s.mail and user['id'].isdigit()
    header = response.headers['set-cookie']
    assert header.startswith('cc_session=') and 'HttpOnly' in header and 'SameSite=lax' in header and 'Path=/' in header and 'Max-Age=28800' in header
    assert 'Secure' not in header
    assert s.call('GET', '/api/auth/me').json()['data']['user'] == user
    assert Shopper().call('GET', '/api/auth/me').status_code == 401


def test_over_https_the_cookie_is_secure_and_host_prefixed():
    s = Shopper()
    response = s.call('POST', '/api/auth/register', {'name': 'Ana Cruz', 'email': email(), 'password': PASSWORD}, headers={'X-Forwarded-Proto': 'https'})
    header = response.headers['set-cookie']
    assert header.startswith('__Host-cc_session=') and 'Secure' in header and 'HttpOnly' in header and 'Domain' not in header and 'Path=/' in header


@pytest.mark.parametrize('tamper', ['empty', 'garbage', 'dropped mac', 'flipped mac', 'swapped id', 'other secret'])
def test_a_forged_or_tampered_cookie_is_refused(tamper):
    s = Shopper()
    s.register()
    name, value = s.cookie.name, s.cookie.value
    sid, mac = value.split('.')
    other = Shopper()
    other.register()
    forged = {'empty': '', 'garbage': 'not-a-cookie', 'dropped mac': sid, 'flipped mac': f'{sid}.{mac[:-1]}{"0" if mac[-1] != "0" else "1"}',
              'swapped id': f'{other.cookie.value.split(".")[0]}.{mac}', 'other secret': f'{sid}.{"ab" * 32}'}[tamper]
    with httpx.Client(base_url=BASE, timeout=60, cookies={name: forged}) as http:
        for path in ('/api/auth/me', '/api/orders'):
            assert http.get(path).status_code == 401, path


def test_the_old_demo_header_signs_nobody_in():
    with httpx.Client(base_url=BASE, timeout=60, headers={'X-Demo-Session': '1'}) as http:
        assert http.get('/api/orders').status_code == 401
        assert http.get('/api/auth/me').status_code == 401


# ------------------------------------------------------------------ register refusals
def test_a_taken_email_weak_passwords_and_bad_fields_are_refused_with_sentences():
    s = Shopper()
    assert s.register().status_code == 201
    again = Shopper().register(mail=s.mail.upper())
    assert again.status_code == 409 and again.json()['error']['code'] == 'email_unavailable' and 'set-cookie' not in again.headers
    for password, fields in (('short', {'password': 'Use at least 10 characters.'}), ('password123', {'password': 'That password is too common. Choose another one.'}),
                             ('x' * 129, {'password': 'Use 128 characters or fewer.'})):
        refused = Shopper().register(password=password)
        assert refused.status_code == 422 and refused.json()['error']['fields'] == fields
    bad = Shopper().register(mail='nope', name='A')
    assert bad.status_code == 422 and set(bad.json()['error']['fields']) == {'name', 'email'}


def test_two_registrations_of_one_email_at_the_same_moment_make_one_account():
    mail = email('race')
    results = []

    def go():
        results.append(Shopper().register(mail=mail).status_code)

    threads = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == [201, 409]


# ------------------------------------------------------------------ sign in, sign out
def test_a_wrong_password_and_an_unknown_email_get_the_same_answer():
    s = Shopper()
    s.register()
    wrong = Shopper().login(s.mail, 'not the password!')
    unknown = Shopper().login(email('nobody'), 'not the password!')
    assert (wrong.status_code, wrong.json()) == (unknown.status_code, unknown.json()) == (401, {'error': {'code': 'invalid_credentials', 'message': 'The email or password is not right.'}})
    assert 'set-cookie' not in wrong.headers


def test_signing_in_starts_a_new_session_and_the_one_it_replaces_stops_working():
    s = Shopper()
    s.register()
    first = s.cookie.value
    assert s.login(s.mail).status_code == 200
    second = s.cookie.value
    assert first != second
    with httpx.Client(base_url=BASE, timeout=60, cookies={'cc_session': first}) as old:
        assert old.get('/api/auth/me').status_code == 401
    assert s.call('GET', '/api/auth/me').status_code == 200


def test_signing_out_ends_the_session_for_good_a_copy_of_the_cookie_is_dead():
    s = Shopper()
    s.register()
    copy = s.cookie.value
    out = s.call('POST', '/api/auth/logout')
    assert out.status_code == 200 and 'Max-Age=0' in out.headers['set-cookie']
    assert s.call('GET', '/api/auth/me').status_code == 401
    with httpx.Client(base_url=BASE, timeout=60, cookies={'cc_session': copy}) as replay:
        assert replay.get('/api/auth/me').status_code == 401
        assert replay.get('/api/orders').status_code == 401
        full = {'lines': [{'sku': 'X', 'quantity': 1}], 'delivery': DELIVERY, 'paymentMethod': 'cod', 'quotedTotal': 1}
        assert replay.post('/api/orders', json=full, headers={'Idempotency-Key': str(uuid.uuid4())}).status_code == 401
    assert Shopper().call('POST', '/api/auth/logout').status_code == 200   # signing out when not signed in is fine


def test_five_wrong_passwords_lock_that_email_even_for_the_right_password_and_from_another_address():
    s = Shopper()
    s.register()
    attacker = Shopper()
    for _ in range(5):
        assert attacker.login(s.mail, 'wrong password!!').status_code == 401
    for who in (attacker, Shopper(), s):   # the owner too, from their own address: the price of per-email counters
        locked = who.login(s.mail)
        assert locked.status_code == 429 and 0 < int(locked.headers['retry-after']) <= 60
        assert locked.json()['error']['code'] == 'too_many_attempts' and locked.json()['error']['retryAfter'] == int(locked.headers['retry-after'])
    assert Shopper().login(email('other'), PASSWORD).status_code == 401   # another email is not affected
    ghost = email('ghost')
    for _ in range(5):
        Shopper().login(ghost, 'wrong password!!')
    assert Shopper().login(ghost, 'wrong password!!').status_code == 429   # an email with no account locks the same way


# ------------------------------------------------------------------ cross-site, orders
def test_a_cross_site_post_is_refused_and_a_plain_one_is_not():
    s = Shopper()
    s.register()
    assert s.call('POST', '/api/auth/logout', headers={'Origin': 'https://evil.example'}).status_code == 403
    assert s.call('POST', '/api/auth/logout', headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403
    assert s.call('GET', '/api/auth/me').status_code == 200   # the refused sign-outs did nothing


def test_two_customers_see_only_their_own_orders_in_both_directions():
    va, vb, vc = stocked(3)
    alice, bob = Shopper(), Shopper()
    alice.register(name='Alice A')
    bob.register(name='Bob B')
    key = str(uuid.uuid4())
    a = place(alice, va, key)
    b = place(bob, vb, key)          # the same Idempotency-Key from another customer is another order, not alice's
    assert a.status_code == 201 and b.status_code == 201
    a_id, b_id = a.json()['data']['id'], b.json()['data']['id']
    assert a_id != b_id
    assert [o['id'] for o in alice.call('GET', '/api/orders').json()['data']] == [a_id]
    assert [o['id'] for o in bob.call('GET', '/api/orders').json()['data']] == [b_id]
    assert alice.call('GET', f'/api/orders/{a_id}').status_code == 200
    for who, other_id in ((alice, b_id), (bob, a_id)):
        response = who.call('GET', f'/api/orders/{other_id}')
        assert response.status_code == 404 and response.json()['error']['code'] == 'not_found'
    # alice cannot replay bob's key either: it is hers or nothing
    again = place(alice, vc, key)
    assert again.status_code == 201 and again.json()['data']['id'] == a_id
    assert Shopper().call('GET', '/api/orders').status_code == 401
    # an order placed after sign-out and sign-in again is still alice's
    alice.call('POST', '/api/auth/logout')
    assert alice.login(alice.mail).status_code == 200
    assert [o['id'] for o in alice.call('GET', '/api/orders').json()['data']] == [a_id]
