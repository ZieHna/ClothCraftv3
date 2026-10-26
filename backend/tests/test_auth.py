"""Register, sign in, sign out and the session cookie, with a pretend Odoo: cookie flags, forging, origin checks, status mapping, and
that a password never comes back out. What Odoo itself decides (hashing, throttling, expiry) is tested in addons/clothcraft/tests/."""
import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from app import session as sess
from app.config import Settings
from app.main import create_app
from app.odoo import OdooClient

from .test_service import MONEY, SECRET, FakeOdoo

PASSWORD = 'a-very-distinctive-password-9f3c'
USER = {'id': 5, 'name': 'Ana Cruz', 'email': 'ana@example.com'}
BASE = {**MONEY, 'simulation': False}


class AuthOdoo(FakeOdoo):
    def __init__(self):
        super().__init__()
        self.register = lambda p: {**BASE, 'status': 'created', 'user': USER, 'remaining': 28800}
        self.login = lambda p: {**BASE, 'status': 'ok', 'user': USER, 'remaining': 28800}
        self.session = lambda p: {**BASE, 'valid': True, 'user': USER, 'remaining': 20000}
        self.logout_called = []

    def __call__(self, request):
        body = json.loads(request.content)
        name = request.url.path.rsplit('/', 1)[-1]
        handlers = {'auth_register': lambda: self.register(body['payload']), 'auth_login': lambda: self.login(body['payload']),
                    'auth_session': lambda: self.session(body['payload']),
                    'auth_logout': lambda: (self.logout_called.append(body['payload']['sid_hash']), {**BASE, 'revoked': True})[1]}
        if name in handlers:
            self.calls.append((request.url.path, body, dict(request.headers)))
            return httpx.Response(200, json=handlers[name]())
        return super().__call__(request)


@pytest.fixture
def odoo():
    return AuthOdoo()


def make_client(odoo, **overrides):
    settings = Settings(**{'odoo_api_key': 'k', 'session_secret': SECRET, **overrides}, _env_file=None)
    return TestClient(create_app(settings, OdooClient(settings, transport=httpx.MockTransport(odoo))))


@pytest.fixture
def client(odoo):
    with make_client(odoo) as c:
        yield c


def register(client, **extra):
    body = {'name': 'Ana Cruz', 'email': 'ana@example.com', 'password': PASSWORD}
    headers = extra.pop('headers', {})
    return client.post('/api/auth/register', json={**body, **extra}, headers=headers)


def login(client, headers=None, **extra):
    return client.post('/api/auth/login', json={'email': 'ana@example.com', 'password': PASSWORD, **extra}, headers=headers or {})


def sent(odoo, name):
    return [c[1]['payload'] for c in odoo.calls if c[0].endswith('/' + name)]


def cookie_of(response):
    header = response.headers['set-cookie']
    name, rest = header.split('=', 1)
    return name, rest.split(';', 1)[0], header


# ------------------------------------------------------------------ the cookie
def test_register_sets_a_session_cookie_with_the_right_flags_and_a_verifiable_value(client, odoo):
    response = register(client)
    assert response.status_code == 201
    assert response.json() == {'data': {'user': {'id': '5', 'displayName': 'Ana Cruz', 'email': 'ana@example.com'}}, 'simulation': None}
    name, value, header = cookie_of(response)
    assert name == sess.COOKIE
    assert 'HttpOnly' in header and 'SameSite=lax' in header and 'Path=/' in header and 'Max-Age=28800' in header
    assert 'Secure' not in header and 'Domain' not in header
    sid = sess.parse_cookie(value, SECRET)
    assert sid and len(sid) >= 40
    assert sent(odoo, 'auth_register')[0]['sid_hash'] == sess.sid_hash(sid)   # Odoo is given the hash, never the id itself
    assert sid not in json.dumps(odoo.calls)


def test_over_https_the_cookie_is_secure_and_host_prefixed_only_from_a_trusted_proxy(odoo):
    with make_client(odoo, trusted_proxies='*') as c:
        header = cookie_of(register(c, headers={'X-Forwarded-Proto': 'https'}))
        assert header[0] == sess.SECURE_COOKIE and 'Secure' in header[2] and 'Path=/' in header[2] and 'Domain' not in header[2]
    with make_client(odoo) as c:   # nobody trusted: the header is only a claim
        assert cookie_of(register(c, headers={'X-Forwarded-Proto': 'https'}))[0] == sess.COOKIE
    with make_client(odoo, cookie_secure=True) as c:
        assert cookie_of(register(c))[0] == sess.SECURE_COOKIE


def test_the_secure_cookie_is_read_back_and_cleared_under_its_own_name(odoo):
    with make_client(odoo, trusted_proxies='*') as c:
        name, value, _ = cookie_of(register(c, headers={'X-Forwarded-Proto': 'https'}))
        response = c.get('/api/auth/me', headers={'Cookie': f'{name}={value}', 'X-Forwarded-Proto': 'https'})
        assert response.status_code == 200
        odoo.session = lambda p: {**BASE, 'valid': False}
        gone = c.get('/api/auth/me', headers={'Cookie': f'{name}={value}', 'X-Forwarded-Proto': 'https'})
        assert gone.status_code == 401 and gone.headers['set-cookie'].startswith(sess.SECURE_COOKIE + '=') and 'Max-Age=0' in gone.headers['set-cookie']


@pytest.mark.parametrize('value', [None, '', 'x', 'a.b', 'a.b.c', '.', 'abc.', '.abc', 'x' * 300, 'sid.' + '0' * 64])
def test_cookie_values_that_are_not_ours_are_refused(value):
    assert sess.parse_cookie(value, SECRET) is None


def test_a_cookie_made_with_another_secret_or_tampered_with_is_refused():
    good = sess.cookie_value('some-session-id', SECRET)
    assert sess.parse_cookie(good, SECRET) == 'some-session-id'
    assert sess.parse_cookie(good, 'another-secret-another-secret-another') is None
    sid, mac = good.split('.')
    assert sess.parse_cookie(f'{sid}x.{mac}', SECRET) is None
    assert sess.parse_cookie(f'{sid}.{mac[:-1]}{"0" if mac[-1] != "0" else "1"}', SECRET) is None


def test_the_service_will_not_start_without_a_real_secret(odoo):
    for secret in ('', 'short'):
        settings = Settings(odoo_api_key='k', session_secret=secret, _env_file=None)
        with pytest.raises(RuntimeError, match='SESSION_SECRET'), TestClient(create_app(settings, OdooClient(settings, transport=httpx.MockTransport(odoo)))):
            pass


# ------------------------------------------------------------------ register
def test_register_answers_for_each_thing_odoo_can_say(client, odoo):
    odoo.register = lambda p: {**BASE, 'status': 'invalid', 'fields': {'password': 'Use at least 10 characters.'}}
    response = register(client, password='short')
    assert response.status_code == 422
    assert response.json()['error'] == {'code': 'validation', 'message': 'Some details need fixing.', 'fields': {'password': 'Use at least 10 characters.'}}
    assert 'set-cookie' not in response.headers

    odoo.register = lambda p: {**BASE, 'status': 'exists'}
    response = register(client)
    assert response.status_code == 409
    assert response.json()['error'] == {'code': 'email_unavailable', 'message': "We couldn't create an account with that email. If it is yours, sign in instead."}
    assert 'set-cookie' not in response.headers

    odoo.register = lambda p: {**BASE, 'status': 'throttled', 'retry_after': 59}
    response = register(client)
    assert response.status_code == 429 and response.headers['retry-after'] == '59'
    assert response.json()['error'] == {'code': 'too_many_attempts', 'message': 'Too many attempts. Please wait a minute and try again.', 'retryAfter': 59}
    odoo.register = lambda p: {**BASE, 'status': 'throttled', 'retry_after': 400}
    assert 'wait 7 minutes' in register(client).json()['error']['message']


@pytest.mark.parametrize('payload', [{}, {'name': 'a'}, {'name': 'A', 'email': 'a@b.cc', 'password': 5}, {'name': None, 'email': 'a@b.cc', 'password': 'x'}])
def test_incomplete_registration_is_400_and_odoo_is_not_asked(client, odoo, payload):
    response = client.post('/api/auth/register', json=payload)
    assert response.status_code == 400 and response.json()['error'] == {'code': 'bad_request', 'message': 'The request is not complete.'}
    assert not odoo.calls


def test_unreadable_or_oversized_bodies_are_refused_before_odoo(client, odoo):
    assert client.post('/api/auth/register', content=b'not json').status_code == 400
    assert client.post('/api/auth/login', content=b'[1,2]').status_code == 400
    big = client.post('/api/auth/login', json={'email': 'a@b.cc', 'password': 'x' * 20000})
    assert big.status_code == 413 and big.json()['error']['code'] == 'payload_too_large'
    assert not odoo.calls


def test_a_new_session_replaces_the_one_the_browser_held(client, odoo):
    first = register(client)
    _, value, _ = cookie_of(first)
    old_sid = sess.parse_cookie(value, SECRET)
    for request in (lambda: register(client, headers={'Cookie': f'{sess.COOKIE}={value}'}), lambda: login(client, headers={'Cookie': f'{sess.COOKIE}={value}'})):
        odoo.calls.clear()
        response = request()
        payload = (sent(odoo, 'auth_register') + sent(odoo, 'auth_login'))[0]
        assert payload['replace_sid_hash'] == sess.sid_hash(old_sid)
        new_sid = sess.parse_cookie(cookie_of(response)[1], SECRET)
        assert new_sid != old_sid and payload['sid_hash'] == sess.sid_hash(new_sid)


# ------------------------------------------------------------------ sign in
def test_sign_in_answers_for_each_thing_odoo_can_say(client, odoo):
    ok = login(client)
    assert ok.status_code == 200 and ok.json()['data'] == {'user': {'id': '5', 'displayName': 'Ana Cruz', 'email': 'ana@example.com'}}
    assert sess.parse_cookie(cookie_of(ok)[1], SECRET)

    odoo.login = lambda p: {**BASE, 'status': 'invalid_credentials'}
    wrong = login(client)
    assert wrong.status_code == 401 and wrong.json()['error'] == {'code': 'invalid_credentials', 'message': 'The email or password is not right.'}
    assert 'set-cookie' not in wrong.headers

    odoo.login = lambda p: {**BASE, 'status': 'throttled', 'retry_after': 60}
    locked = login(client)
    assert locked.status_code == 429 and locked.headers['retry-after'] == '60'
    assert locked.json()['error']['message'] == 'Too many sign-in attempts. Please wait a minute and try again.' and 'set-cookie' not in locked.headers

    odoo.login = lambda p: {**BASE, 'status': 'mfa_unsupported'}
    mfa = login(client)
    assert mfa.status_code == 403
    assert mfa.json()['error'] == {'code': 'mfa_unsupported', 'message': 'This account uses two-step verification, which this shop does not support yet.'}
    assert 'set-cookie' not in mfa.headers


def test_odoo_being_down_is_a_plain_502_and_no_session(odoo):
    def down(_request):
        raise httpx.ConnectError('refused')
    settings = Settings(odoo_api_key='k', session_secret=SECRET, _env_file=None)
    with TestClient(create_app(settings, OdooClient(settings, transport=httpx.MockTransport(down)))) as c:
        response = login(c)
    assert response.status_code == 502 and 'set-cookie' not in response.headers
    assert response.json()['error']['code'] == 'upstream_unavailable'


# ------------------------------------------------------------------ me, sign out
def test_me_returns_the_customer_and_renews_the_cookie(client, odoo):
    _, value, _ = cookie_of(register(client))
    response = client.get('/api/auth/me', headers={'Cookie': f'{sess.COOKIE}={value}'})
    assert response.status_code == 200 and response.json()['data']['user']['id'] == '5'
    assert 'Max-Age=20000' in response.headers['set-cookie']
    assert sent(odoo, 'auth_session')[0] == {'sid_hash': sess.sid_hash(sess.parse_cookie(value, SECRET))}


def test_me_without_a_valid_session_is_401(client, odoo):
    assert client.get('/api/auth/me').status_code == 401
    assert client.get('/api/auth/me', headers={'Cookie': f'{sess.COOKIE}=forged'}).status_code == 401
    assert not odoo.calls
    _, value, _ = cookie_of(register(client))
    odoo.session = lambda p: {**BASE, 'valid': False}
    gone = client.get('/api/auth/me', headers={'Cookie': f'{sess.COOKIE}={value}'})
    assert gone.status_code == 401 and 'Max-Age=0' in gone.headers['set-cookie']


def test_sign_out_ends_the_session_in_odoo_and_clears_the_cookie(client, odoo):
    _, value, _ = cookie_of(register(client))
    response = client.post('/api/auth/logout', headers={'Cookie': f'{sess.COOKIE}={value}'})
    assert response.status_code == 200 and response.json()['data'] == {'signedOut': True}
    assert 'Max-Age=0' in response.headers['set-cookie'] and 'HttpOnly' in response.headers['set-cookie']
    assert odoo.logout_called == [sess.sid_hash(sess.parse_cookie(value, SECRET))]


def test_sign_out_without_a_session_is_fine_and_asks_odoo_nothing(client, odoo):
    response = client.post('/api/auth/logout')
    assert response.status_code == 200 and not odoo.calls
    assert client.post('/api/auth/logout', headers={'Cookie': f'{sess.COOKIE}=forged'}).status_code == 200
    assert not odoo.calls


# ------------------------------------------------------------------ cross-site requests, client addresses
def test_a_browser_post_from_another_site_is_refused_before_anything_happens(odoo):
    with make_client(odoo, allowed_origins='http://localhost:5173, http://localhost:4175') as c:
        for headers in ({'Origin': 'https://evil.example'}, {'Origin': 'null'}, {'Sec-Fetch-Site': 'cross-site'},
                        {'Origin': 'http://localhost:5173', 'Sec-Fetch-Site': 'cross-site'}):
            for path in ('/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/orders', '/api/cart/quote'):
                response = c.post(path, json={'email': 'a@b.cc', 'password': 'x'}, headers=headers)
                assert response.status_code == 403 and response.json()['error']['code'] == 'forbidden_origin', (path, headers)
        assert not odoo.calls
        assert login(c, headers={'Origin': 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin'}).status_code == 200
        assert login(c, headers={'Origin': 'http://localhost:4175'}).status_code == 200
        assert login(c).status_code == 200                       # no Origin: not a browser acting for someone
        # reading is not state changing
        assert c.get('/api/catalogue/featured', headers={'Origin': 'https://evil.example'}).status_code == 200


def test_with_no_origins_allowed_any_origin_header_is_refused(client):
    assert login(client, headers={'Origin': 'http://localhost:5173'}).status_code == 403


def test_the_client_address_is_the_forwarded_one_only_from_a_trusted_proxy(odoo):
    with make_client(odoo) as c:
        login(c, headers={'X-Forwarded-For': '203.0.113.5, 10.0.0.1'})
        assert sent(odoo, 'auth_login')[-1]['client_ip'] == 'testclient'
    with make_client(odoo, trusted_proxies='testclient') as c:
        login(c, headers={'X-Forwarded-For': '203.0.113.5, 10.0.0.1'})
        assert sent(odoo, 'auth_login')[-1]['client_ip'] == '203.0.113.5'
    with make_client(odoo, trusted_proxies='10.9.9.9') as c:
        login(c, headers={'X-Forwarded-For': '203.0.113.5'})
        assert sent(odoo, 'auth_login')[-1]['client_ip'] == 'testclient'


# ------------------------------------------------------------------ the password
def test_a_password_never_comes_back_out_and_is_never_logged(odoo, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    texts = []
    with make_client(odoo) as c:
        for make in (lambda: register(c), lambda: login(c)):
            texts.append(make().text)
        odoo.login = lambda p: {**BASE, 'status': 'invalid_credentials'}
        texts.append(login(c).text)
        odoo.register = lambda p: {**BASE, 'status': 'invalid', 'fields': {'password': 'Use at least 10 characters.'}}
        response = register(c)
        texts += [response.text, str(response.headers)]
    # and when Odoo itself fails, what is printed is Odoo's status and message, not the request
    down = AuthOdoo()
    down.login = lambda p: (_ for _ in ()).throw(httpx.ConnectError('refused'))
    refused = httpx.MockTransport(lambda r: httpx.Response(500, json={'message': 'boom'}))
    settings = Settings(odoo_api_key='k', session_secret=SECRET, _env_file=None)
    with TestClient(create_app(settings, OdooClient(settings, transport=refused))) as c:
        texts.append(login(c).text)
    captured = capsys.readouterr()
    everything = '\n'.join(texts + [captured.out, captured.err, caplog.text])
    assert PASSWORD not in everything


def test_the_old_demo_header_signs_nobody_in(client, odoo):
    for path in ('/api/auth/me', '/api/orders'):
        assert client.get(path, headers={'X-Demo-Session': '1'}).status_code == 401
    assert not odoo.calls
