"""The DSS routes (/api/admin/dss/*, B8 S4c) with a pretend Odoo: who gets in, what the query may hold, the page limits, what each facade
answer becomes, the keys' spelling, and that Run now takes no body. The rules and figures themselves are Odoo's
(addons/clothcraft_dss/tests/test_dss_api.py)."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import session as sess
from app.config import Settings
from app.main import create_app
from app.odoo import OdooClient

from .test_orders import COOKIE as CUSTOMER_COOKIE
from .test_service import MONEY, SECRET, FakeOdoo
from .test_staff_service import STAFF_COOKIE

BASE = {**MONEY, 'simulation': False}
ADMIN_SID = 'admin-sid-dss'
ADMIN_COOKIE = {'Cookie': f'{sess.ADMIN_COOKIE}={sess.cookie_value(ADMIN_SID, SECRET, "admin")}'}
REF = {'id': 5, 'kind': 'simulated', 'simulated': True, 'notice': 'Simulated data: demonstrates the method, not real-world accuracy.',
       'as_of': '2026-10-15', 'engine_version': 'B8-S4', 'closed_rule': 'delivered_and_paid', 'closed_rule_text': 'x', 'trigger': 'import',
       'finished_at': '2026-10-26 04:15:00', 'age_days': 0, 'stale': False}
GETS = ['/api/admin/dss/overview', '/api/admin/dss/runs', '/api/admin/dss/runs/5', '/api/admin/dss/forecast/keys', '/api/admin/dss/forecast',
        '/api/admin/dss/backtest', '/api/admin/dss/restock', '/api/admin/dss/segments', '/api/admin/dss/alerts', '/api/admin/dss/health',
        '/api/admin/dss/run-now/12']


class DssOdoo(FakeOdoo):
    def __init__(self):
        super().__init__()
        self.reply = lambda method, payload: {**BASE, 'status': 'ok', 'session_remaining': 3000, 'run': REF}

    def __call__(self, request):
        method = request.url.path.rsplit('/', 1)[-1]
        if method.startswith('admin_dss_'):
            body = json.loads(request.content)
            self.calls.append((method, body['payload'], body.get('context')))
            if body['payload']['sid_hash'] != sess.sid_hash(ADMIN_SID):
                return httpx.Response(200, json={**BASE, 'status': 'unauthorised'})
            return httpx.Response(200, json=self.reply(method, body['payload']))
        return super().__call__(request)


@pytest.fixture
def odoo():
    return DssOdoo()


@pytest.fixture
def client(odoo):
    settings = Settings(odoo_api_key='k', session_secret=SECRET, _env_file=None)
    with TestClient(create_app(settings, OdooClient(settings, transport=httpx.MockTransport(odoo)))) as c:
        yield c


# ---- access
@pytest.mark.parametrize('path', GETS)
def test_access_no_cookie_401_employee_cookie_403_customer_cookie_401(client, odoo, path):
    for headers, status, code in (({}, 401, 'unauthorised'), (STAFF_COOKIE, 403, 'forbidden'), (CUSTOMER_COOKIE, 401, 'unauthorised')):
        r = client.get(path, headers=headers)
        assert (r.status_code, r.json()['error']['code']) == (status, code), (path, headers)
    assert client.get(path).json()['error']['message'] == 'Sign in to the admin dashboard to continue.'
    assert client.get(path, headers=STAFF_COOKIE).json()['error']['message'] == 'The admin dashboard has its own sign-in. Use Admin login.'
    assert odoo.calls == []                                     # none of them reached Odoo
    assert client.get(path, headers=ADMIN_COOKIE).status_code == 200


def test_access_run_now_needs_the_admin_cookie(client, odoo):
    assert client.post('/api/admin/dss/run-now').status_code == 401
    assert client.post('/api/admin/dss/run-now', headers=STAFF_COOKIE).status_code == 403
    assert client.post('/api/admin/dss/run-now', headers=CUSTOMER_COOKIE).status_code == 401
    assert odoo.calls == []


def test_an_ended_admin_session_is_401_and_clears_the_cookie(client, odoo):
    odoo.reply = lambda m, p: {**BASE, 'status': 'unauthorised'}
    r = client.get('/api/admin/dss/overview', headers=ADMIN_COOKIE)
    assert r.status_code == 401
    assert sess.ADMIN_COOKIE in r.headers.get('set-cookie', '')


# ---- the query
@pytest.mark.parametrize('path, query, field', [
    ('/api/admin/dss/overview', 'x=1', 'x'), ('/api/admin/dss/restock', 'foo=1', 'foo'), ('/api/admin/dss/runs', 'kind=mixed', 'kind'),
    ('/api/admin/dss/runs', 'state=open', 'state'), ('/api/admin/dss/forecast', 'level=type', 'level'), ('/api/admin/dss/health', 'run=abc', 'run'),
    ('/api/admin/dss/backtest', 'horizon=9', 'horizon'), ('/api/admin/dss/backtest', 'chosen=maybe', 'chosen'),
    ('/api/admin/dss/restock', 'urgency=late', 'urgency'), ('/api/admin/dss/segments', 'segment=vip', 'segment'),
    ('/api/admin/dss/alerts', 'severity=open', 'severity'), ('/api/admin/dss/alerts', 'state=open', 'state')])
def test_unknown_or_bad_query_values_are_422(client, odoo, path, query, field):
    r = client.get(f'{path}?{query}', headers=ADMIN_COOKIE)
    assert r.status_code == 422
    assert field in r.json()['error']['fields']
    assert odoo.calls == []


def test_the_query_is_passed_on_under_odoo_names(client, odoo):
    client.get('/api/admin/dss/restock?run=7&urgency=order_now&garmentType=TEE&supplierId=11&q=sim', headers=ADMIN_COOKIE)
    payload = odoo.calls[-1][1]
    assert {k: payload[k] for k in ('run_id', 'urgency', 'garment_type', 'supplier_id', 'q')} == {
        'run_id': 7, 'urgency': 'order_now', 'garment_type': 'TEE', 'supplier_id': 11, 'q': 'sim'}
    assert odoo.calls[-1][2] == {'clothcraft_scope': 'admin'}


# ---- the page limits
@pytest.mark.parametrize('path', ['/api/admin/dss/runs', '/api/admin/dss/backtest', '/api/admin/dss/restock', '/api/admin/dss/segments',
                                  '/api/admin/dss/alerts'])
def test_page_limits(client, odoo, path):
    for bad in ('pageSize=101', 'pageSize=0', 'page=0', 'page=x'):
        assert client.get(f'{path}?{bad}', headers=ADMIN_COOKIE).status_code == 422, (path, bad)
    odoo.reply = lambda m, p: {**BASE, 'status': 'ok', 'run': REF, 'total': 250, 'limit': p['limit'], 'offset': p['offset'], 'rows': []}
    r = client.get(f'{path}?page=3&pageSize=100', headers=ADMIN_COOKIE)
    assert r.status_code == 200
    assert {k: odoo.calls[-1][1][k] for k in ('limit', 'offset')} == {'limit': 100, 'offset': 200}
    assert (r.json()['data']['page'], r.json()['data']['pageSize']) == (3, 100)
    assert 'limit' not in r.json()['data'] and 'offset' not in r.json()['data']


# ---- what the facade's answers become
@pytest.mark.parametrize('reply, status, code, message', [
    ({'status': 'no_run', 'message': 'No DSS run yet. Press Run now to start one.'}, 404, 'not_found', 'No DSS run yet. Press Run now to start one.'),
    ({'status': 'no_run', 'message': 'No DSS run "9"'}, 404, 'not_found', 'No DSS run "9"'),
    ({'status': 'run_failed', 'message': 'This run failed: RuntimeError: boom'}, 409, 'run_failed', 'This run failed: RuntimeError: boom'),
    ({'status': 'run_in_progress', 'message': 'A DSS run is already queued or running. It appears here when it has finished.'}, 409,
     'run_in_progress', 'A DSS run is already queued or running. It appears here when it has finished.'),
    ({'status': 'invalid', 'fields': {'garment_type': 'Choose a key.'}}, 422, 'validation', 'Some details need fixing.')])
def test_status_mapping(client, odoo, reply, status, code, message):
    odoo.reply = lambda m, p: {**BASE, **reply}
    r = client.get('/api/admin/dss/restock', headers=ADMIN_COOKIE)
    assert (r.status_code, r.json()['error']['code'], r.json()['error']['message']) == (status, code, message)
    if status == 422:
        assert r.json()['error']['fields'] == {'garmentType': 'Choose a key.'}


def test_a_run_or_request_id_not_found_names_it(client, odoo):
    odoo.reply = lambda m, p: {**BASE, 'status': 'not_found'}
    assert client.get('/api/admin/dss/runs/5', headers=ADMIN_COOKIE).json()['error']['message'] == 'No DSS run "5"'
    assert client.get('/api/admin/dss/run-now/12', headers=ADMIN_COOKIE).json()['error']['message'] == 'No run request "12"'
    assert client.get('/api/admin/dss/runs/x5', headers=ADMIN_COOKIE).status_code == 404


def test_camel_case_and_string_ids(client, odoo):
    odoo.reply = lambda m, p: {**BASE, 'status': 'ok', 'run': REF, 'total': 1, 'limit': 25, 'offset': 0, 'counts': {'order_now': 1},
                               'rows': [{'product_id': 71, 'product_template_id': 7, 'supplier_id': 11, 'days_left': 4, 'runout_date': '2026-10-20',
                                         'alternatives': [{'supplier_id': 12, 'landed_unit_cost': 170.123}]}]}
    data = client.get('/api/admin/dss/restock', headers=ADMIN_COOKIE).json()['data']
    assert data['run']['id'] == '5' and data['run']['asOf'] == '2026-10-15' and data['run']['closedRuleText'] == 'x'
    assert data['run']['finishedAt'] == '2026-10-26T04:15:00Z'
    row = data['rows'][0]
    assert (row['productId'], row['productTemplateId'], row['supplierId'], row['daysLeft'], row['runoutDate']) == ('71', '7', '11', 4, '2026-10-20')
    assert row['alternatives'][0] == {'supplierId': '12', 'landedUnitCost': 170.123}     # 4 decimals on the DSS routes (B8 S4d)
    assert data['counts'] == {'orderNow': 1}
    assert 'status' not in data and 'simulation' not in data and 'sessionRemaining' not in data


# ---- precision (B8 S4d)
def test_small_numbers_survive_on_the_dss_routes(client, odoo):
    odoo.reply = lambda m, p: {**BASE, 'status': 'ok', 'run': REF, 'total': 1, 'limit': 25, 'offset': 0, 'counts': {},
                               'rows': [{'daily_demand': 0.0348, 'weekly_demand': 0.2436, 'safety_stock': 0.8214, 'unit_cost': 148.2544}]}
    row = client.get('/api/admin/dss/restock', headers=ADMIN_COOKIE).json()['data']['rows'][0]
    assert (row['dailyDemand'], row['weeklyDemand'], row['safetyStock'], row['unitCost']) == (0.0348, 0.2436, 0.8214, 148.2544)
    odoo.reply = lambda m, p: {**BASE, 'status': 'ok', 'run': REF, 'total': 1, 'limit': 25, 'offset': 0,
                               'rows': [{'wape': 0.4965, 'bias': -0.0312, 'mae': 0.0312, 'cov80': 76.6}]}
    row = client.get('/api/admin/dss/backtest', headers=ADMIN_COOKIE).json()['data']['rows'][0]
    assert (row['wape'], row['bias'], row['mae'], row['cov80']) == (0.4965, -0.0312, 0.0312, 76.6)
    odoo.reply = lambda m, p: {**BASE, 'status': 'ok', 'run': REF, 'trend': {'revenue_rel_slope': 0.0112, 'revenue_rel_slope_pct': 1.12}}
    assert client.get('/api/admin/dss/health', headers=ADMIN_COOKIE).json()['data']['trend'] == {'revenueRelSlope': 0.0112, 'revenueRelSlopePct': 1.12}


def test_other_routes_still_round_to_two_decimals_and_the_dss_default_page_is_25(client, odoo):
    from app.inventory import DSS_DIGITS, PAGE_DEFAULT, PAGE_MAX, to_api
    assert (DSS_DIGITS, PAGE_DEFAULT, PAGE_MAX) == (4, 25, 100)
    assert to_api({'amount_total': 349.12345, 'ratio': 0.0348}) == {'amountTotal': 349.12, 'ratio': 0.03}      # every route that existed before B8
    assert to_api({'ratio': 0.0348}, digits=DSS_DIGITS) == {'ratio': 0.0348}
    odoo.reply = lambda m, p: {**BASE, 'status': 'ok', 'run': REF, 'total': 0, 'limit': p['limit'], 'offset': p['offset'], 'rows': []}
    data = client.get('/api/admin/dss/alerts', headers=ADMIN_COOKIE).json()['data']
    assert (odoo.calls[-1][1]['limit'], odoo.calls[-1][1]['offset'], data['page'], data['pageSize']) == (25, 0, 1, 25)


# ---- Run now
def test_run_now_is_202_with_a_request_id_and_takes_no_body(client, odoo):
    odoo.reply = lambda m, p: {**BASE, 'status': 'ok', 'request_id': 12, 'state': 'queued'}
    r = client.post('/api/admin/dss/run-now', headers=ADMIN_COOKIE)
    assert (r.status_code, r.json()['data']) == (202, {'requestId': '12', 'state': 'queued'})
    calls = len(odoo.calls)
    r = client.post('/api/admin/dss/run-now', headers={**ADMIN_COOKIE, 'Content-Type': 'application/json'}, content=b'{"force": true}')
    assert (r.status_code, r.json()['error']['fields']) == (422, {'body': 'This request takes no body.'})
    assert len(odoo.calls) == calls                            # refused before Odoo
