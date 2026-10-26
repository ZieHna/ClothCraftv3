"""The Administrator's own sign-in (/admin): sign in, sign out, who am I. Step 7a; the admin dashboard's data routes come after it.

It is separate from the employee dashboard (/staff): its own cookie (cc_admin), its own HMAC kind, its own server-side session scope in Odoo
('admin', shorter lifetimes) and its own throttle counters. One person may hold both an employee session and an admin session; each sign-out
ends only its own. The service decides nothing about who may do what: Odoo accepts an admin session only for a person who holds the
Administrator group NOW (re-read on every call), and says `not_admin` for an employee's account, but only after a correct password.
"""
from fastapi import Request

from . import session as sess
from .inventory import ENVELOPE, to_api

RANGES = ('this_month', 'last_3_months', 'last_12_months', 'all')
UNAUTHORISED = 'Sign in to the admin dashboard to continue.'
SEPARATE = 'The admin dashboard has its own sign-in. Use Admin login.'


def install_admin(app, client, settings, ctx):
    Failure, respond, json_body, too_many, keep = ctx.ApiFailure, ctx.respond, ctx.json_body, ctx.too_many, ctx.keep

    def admin_sid(request: Request) -> tuple[str, str]:
        """(the admin session id from the cookie, its hash). Without an admin cookie: 403 when the browser holds a valid employee cookie (an
        employee session never opens an admin route, and is told so), else 401. A forged cookie is 401 without asking Odoo."""
        sid = sess.sid_from_request(request, settings, 'admin')
        if sid:
            return sid, sess.sid_hash(sid)
        if sess.sid_from_request(request, settings, 'staff'):
            raise Failure(403, 'forbidden', SEPARATE)
        raise Failure(401, 'unauthorised', UNAUTHORISED)

    def ended(request: Request) -> Failure:
        request.state.cookie = ('clear', None, 0, 'admin')
        return Failure(401, 'unauthorised', UNAUTHORISED)

    def admin_json(user: dict) -> dict:
        return {'id': str(user['id']), 'displayName': user['name'], 'email': user['email'], 'role': user['role']}

    @app.post('/api/admin/auth/login')
    async def admin_login(request: Request):
        body = await json_body(request)
        if body is None or not all(isinstance(body.get(k), str) for k in ('email', 'password')):
            raise Failure(400, 'bad_request', 'The request is not complete.')
        old = sess.sid_from_request(request, settings, 'admin')
        sid = sess.new_sid()
        result = await client.call('clothcraft.api', 'admin_login', payload={
            'email': body['email'], 'password': body['password'], 'sid_hash': sess.sid_hash(sid), 'client_ip': sess.client_ip(request, settings),
            'replace_sid_hash': sess.sid_hash(old) if old else None})
        status = result['status']
        if status == 'throttled':
            raise too_many(result['retry_after'], 'sign-in attempts')
        if status == 'mfa_unsupported':
            raise Failure(403, 'mfa_unsupported', 'This account uses two-step verification, which the admin dashboard does not support yet.')
        if status == 'not_admin':
            raise Failure(403, 'not_admin', 'This is an employee account. Use Employee login.')
        if status != 'ok':
            raise Failure(401, 'invalid_credentials', 'The email or password is not right.')
        keep(request, sid, result['remaining'], 'admin')
        return respond({'user': admin_json(result['user'])}, result['simulation'])

    @app.get('/api/admin/dashboard')
    async def admin_dashboard(request: Request):
        """The admin dashboard's summary (step 7b), read-only. The cookie only names a session; Odoo decides, on this very call, whether it is a
        live admin session of someone who holds the Administrator group (anything else is 401). An employee cookie alone is 403."""
        sid, hashed = admin_sid(request)
        fields = {name: 'Not allowed.' for name in request.query_params if name != 'range'}
        key = request.query_params.get('range') or 'last_12_months'
        if key not in RANGES:
            fields['range'] = 'Choose one of: ' + ', '.join(RANGES) + '.'
        if fields:
            raise Failure(422, 'validation', 'Some details need fixing.', fields=fields)
        result = await client.call('clothcraft.api', 'admin_dashboard', payload={'sid_hash': hashed, 'range': key})
        if result['status'] == 'unauthorised':
            raise ended(request)
        if result['status'] != 'ok':
            raise Failure(502, 'upstream_unavailable', 'The shop is not available right now. Please try again.')
        keep(request, sid, result.get('session_remaining'), 'admin')
        return respond(to_api({k: v for k, v in result.items() if k not in ENVELOPE}), result['simulation'])

    @app.get('/api/admin/orders/summary')
    async def admin_orders_summary(request: Request):
        """The admin Orders page (step 7f): COUNTS only, no amounts. Same access rules as the dashboard (the cookie names a session, Odoo decides on
        this call whether it is a live admin session). Registered before the mirrored /api/admin/orders/{order_id}, which it must not be taken for."""
        sid, hashed = admin_sid(request)
        fields = {name: 'Not allowed.' for name in request.query_params if name != 'range'}
        key = request.query_params.get('range') or 'last_12_months'
        if key not in RANGES:
            fields['range'] = 'Choose one of: ' + ', '.join(RANGES) + '.'
        if fields:
            raise Failure(422, 'validation', 'Some details need fixing.', fields=fields)
        result = await client.call('clothcraft.api', 'admin_orders_summary', payload={'sid_hash': hashed, 'range': key})
        if result['status'] == 'unauthorised':
            raise ended(request)
        if result['status'] != 'ok':
            raise Failure(502, 'upstream_unavailable', 'The shop is not available right now. Please try again.')
        keep(request, sid, result.get('session_remaining'), 'admin')
        return respond(to_api({k: v for k, v in result.items() if k not in ENVELOPE}), result['simulation'])

    @app.post('/api/admin/auth/logout')
    async def admin_logout(request: Request):
        sid = sess.sid_from_request(request, settings, 'admin')
        marker = False
        if sid:
            marker = (await client.call('clothcraft.api', 'admin_logout', payload={'sid_hash': sess.sid_hash(sid)}))['simulation']
        request.state.cookie = ('clear', None, 0, 'admin')
        return respond({'signedOut': True}, marker)

    @app.get('/api/admin/auth/me')
    async def admin_me(request: Request):
        sid, hashed = admin_sid(request)
        result = await client.call('clothcraft.api', 'admin_session', payload={'sid_hash': hashed})
        if not result['valid']:
            raise ended(request)
        keep(request, sid, result['remaining'], 'admin')
        return respond({'user': admin_json(result['user'])}, result['simulation'])
