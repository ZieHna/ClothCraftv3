"""The staff dashboard's routes: sign in, and see and move every order.

Everything here is separate from the customer routes: its own cookie (cc_staff), its own server-side session scope in Odoo, its own throttle
counters. The service decides nothing about who may do what: it passes the session to Odoo (clothcraft.api), which re-reads the person's
groups on EVERY call, enforces the transition rules, locks the order, writes the audit line, and answers with what happened.
"""
from types import SimpleNamespace

from fastapi import Request

from . import session as sess
from .orders import order_from_odoo

# step 11 adds out_for_delivery and closed; packed is still accepted (an order from before step 11 may be found by it)
STATES = {'awaiting_payment', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'closed', 'cancelled'}
UNAUTHORISED = 'Sign in to the staff dashboard to continue.'
ADMIN_UNAUTHORISED = 'Sign in to the admin dashboard to continue.'
ADMIN_SEPARATE = 'The admin dashboard has its own sign-in. Use Admin login.'


def install_staff(app, client, settings, ctx, prefix='/api/staff', kind='staff'):
    """Adds the order routes under `prefix` and returns the session helpers (staff_sid, ended) for other routes to reuse (inventory.py).

    Called twice (main.py): under /api/staff for the employee dashboard (cookie kind 'staff') and under /api/admin for the admin dashboard (kind 'admin').
    Each mount reads exactly ONE cookie kind and sends that scope to Odoo with every call (the client given in is already scoped), so there is no cookie
    precedence: an admin cookie is never looked at under /api/staff and an employee cookie never opens /api/admin. The sign-in routes exist only for 'staff'."""
    Failure, respond, json_body, too_many, keep = ctx.ApiFailure, ctx.respond, ctx.json_body, ctx.too_many, ctx.keep

    said = ADMIN_UNAUTHORISED if kind == 'admin' else UNAUTHORISED

    def staff_sid(request: Request) -> tuple[str, str]:
        """(the session id from this mount's cookie kind, its hash). A missing, forged or customer cookie is 401 without asking Odoo; under the admin
        prefix a valid EMPLOYEE cookie alone is 403 (it is not an admin session, and the person is told so)."""
        sid = sess.sid_from_request(request, settings, kind)
        if not sid:
            if kind == 'admin' and sess.sid_from_request(request, settings, 'staff'):
                raise Failure(403, 'forbidden', ADMIN_SEPARATE)
            raise Failure(401, 'unauthorised', said)
        return sid, sess.sid_hash(sid)

    def ended(request: Request) -> Failure:
        request.state.cookie = ('clear', None, 0, kind)
        return Failure(401, 'unauthorised', said)

    def staff_only(decorator):
        """The sign-in routes belong to the employee door (admin.py has the admin ones): under the admin prefix they are built but not registered."""
        return decorator if kind == 'staff' else (lambda fn: fn)

    def staff_json(user: dict) -> dict:
        out = {'id': str(user['id']), 'displayName': user['name'], 'email': user['email'], 'role': user['role']}
        if user.get('working_as_employee'):     # an Administrator on the employee dashboard while it is employee-only (set in Odoo)
            out['workingAsEmployee'] = True
        return out

    def when(value: str) -> str:
        return value + 'Z'

    def summary(o: dict) -> dict:
        return {
            'id': str(o['id']), 'reference': o['name'], 'state': o['stage'], 'paymentMethod': o['payment_method'], 'paid': o['paid'],
            'customer': {'name': o['customer_name'], 'email': o['customer_email']}, 'total': round(o['amount_total'], 2), 'itemCount': o['items'],
            'createdAt': when(o['created']), 'statusChangedAt': when(o['status_changed']),
            **({'hasDesign': o['has_design']} if 'has_design' in o else {}),
        }

    def history_line(h: dict) -> dict:
        line = {'at': when(h['at']), 'from': h['from'], 'to': h['to'], 'staff': h['staff'], 'note': h['note'], 'via': h['via']}
        if 'actor' in h:          # step 11: who, by kind (staff, customer, automatic, odoo), and whether it was a step back
            line.update(actor=h['actor'], stepBack=h['step_back'])
        return line

    def move(a: dict) -> dict:
        entry = {'to': a['to'], 'label': a['label'], 'needsNote': a['needs_note'], 'confirm': a['confirm']}
        if 'direction' in a:
            entry['direction'] = a['direction']
        return entry

    def detail(data: dict, info: dict) -> dict:
        base = order_from_odoo(data, info, settings)
        return {
            **base, 'customer': data['customer'],
            'history': [history_line(h) for h in data['history']],
            'allowed': [move(a) for a in data['allowed']],
            'blocked': [{'to': b['to'], 'label': b['label'], 'reason': b['reason']} for b in data['blocked']],
        }

    # ------------------------------------------------------------------ sign in, out, who am I
    @staff_only(app.post('/api/staff/auth/login'))
    async def staff_login(request: Request):
        body = await json_body(request)
        if body is None or not all(isinstance(body.get(k), str) for k in ('email', 'password')):
            raise Failure(400, 'bad_request', 'The request is not complete.')
        old = sess.sid_from_request(request, settings, 'staff')
        sid = sess.new_sid()
        result = await client.call('clothcraft.api', 'staff_login', payload={
            'email': body['email'], 'password': body['password'], 'sid_hash': sess.sid_hash(sid), 'client_ip': sess.client_ip(request, settings),
            'replace_sid_hash': sess.sid_hash(old) if old else None})
        status = result['status']
        if status == 'throttled':
            raise too_many(result['retry_after'], 'sign-in attempts')
        if status == 'mfa_unsupported':
            raise Failure(403, 'mfa_unsupported', 'This account uses two-step verification, which the staff dashboard does not support yet.')
        if status != 'ok':
            raise Failure(401, 'invalid_credentials', 'The email or password is not right.')
        keep(request, sid, result['remaining'], 'staff')
        return respond({'user': staff_json(result['user'])}, result['simulation'])

    @staff_only(app.post('/api/staff/auth/logout'))
    async def staff_logout(request: Request):
        sid = sess.sid_from_request(request, settings, 'staff')
        marker = False
        if sid:
            marker = (await client.call('clothcraft.api', 'staff_logout', payload={'sid_hash': sess.sid_hash(sid)}))['simulation']
        request.state.cookie = ('clear', None, 0, 'staff')
        return respond({'signedOut': True}, marker)

    @staff_only(app.get('/api/staff/auth/me'))
    async def staff_me(request: Request):
        sid, hashed = staff_sid(request)
        result = await client.call('clothcraft.api', 'staff_session', payload={'sid_hash': hashed})
        if not result['valid']:
            raise ended(request)
        keep(request, sid, result['remaining'], 'staff')
        return respond({'user': staff_json(result['user'])}, result['simulation'])

    # ------------------------------------------------------------------ the orders
    def number(request: Request, name: str, default: int) -> int:
        raw = request.query_params.get(name)
        if raw is None or raw == '':
            return default
        try:
            return int(raw)
        except ValueError:
            raise Failure(400, 'bad_request', f'"{name}" must be a whole number.') from None

    @app.get(f'{prefix}/orders')
    async def staff_orders(request: Request):
        sid, hashed = staff_sid(request)
        q = request.query_params
        states = [s for raw in q.getlist('state') for s in raw.split(',') if s]
        for state in states:
            if state not in STATES:
                raise Failure(400, 'bad_state', f'Unknown status "{state}"')
        method = q.get('method') or None
        if method not in (None, 'cod', 'bank_transfer'):
            raise Failure(400, 'bad_method', f'Unknown payment method "{method}"')
        page, size = number(request, 'page', 1), number(request, 'pageSize', 25)
        if page < 1 or size < 1 or size > 100:
            raise Failure(400, 'bad_page', 'The page is 1 or more and the page size is from 1 to 100.')
        text = (q.get('q') or '').strip()
        result = await client.call('clothcraft.api', 'staff_orders', payload={
            'sid_hash': hashed, 'states': states, 'method': method, 'date_from': q.get('from') or None, 'date_to': q.get('to') or None,
            'q': text[:100], 'page': page, 'page_size': size})
        if result['status'] == 'unauthorised':
            raise ended(request)
        if result['status'] == 'invalid':
            raise Failure(400, 'bad_date', result['message'])
        keep(request, sid, result['session_remaining'], kind)
        return respond({'orders': [summary(o) for o in result['orders']], 'total': result['total'], 'page': result['page'], 'pageSize': result['page_size']}, result['simulation'])

    @app.get(f'{prefix}/orders/{{order_id}}')
    async def staff_order(order_id: str, request: Request):
        sid, hashed = staff_sid(request)
        if not order_id.isdigit():
            raise Failure(404, 'not_found', f'No order "{order_id}"')
        result = await client.call('clothcraft.api', 'staff_order', payload={'sid_hash': hashed, 'order_id': int(order_id)})
        if result['status'] == 'unauthorised':
            raise ended(request)
        keep(request, sid, result['session_remaining'], kind)
        if result['status'] == 'not_found':
            raise Failure(404, 'not_found', f'No order "{order_id}"')
        return respond(detail(result['order'], result), result['simulation'])

    @app.post(f'{prefix}/orders/{{order_id}}/transition')
    async def staff_transition(order_id: str, request: Request):
        sid, hashed = staff_sid(request)
        body = await json_body(request)
        if body is None or not isinstance(body.get('to'), str) or not isinstance(body.get('expectedState'), str) or not isinstance(body.get('note', ''), str):
            raise Failure(400, 'bad_request', 'The request is not complete.')
        if not order_id.isdigit():
            raise Failure(404, 'not_found', f'No order "{order_id}"')
        result = await client.call('clothcraft.api', 'staff_transition', payload={
            'sid_hash': hashed, 'order_id': int(order_id), 'to': body['to'], 'expected_state': body['expectedState'], 'note': body.get('note', '')})
        status = result['status']
        if status == 'unauthorised':
            raise ended(request)
        keep(request, sid, result.get('session_remaining'), kind)
        if status == 'done':
            return respond(detail(result['order'], result), result['simulation'])
        if status == 'not_found':
            raise Failure(404, 'not_found', f'No order "{order_id}"')
        if status == 'invalid':
            raise Failure(422, 'validation', 'Some details need fixing.', fields=result['fields'])
        if status == 'state_changed':
            raise Failure(409, 'state_changed', result['message'], currentState=result['current'], order=detail(result['order'], result))
        if status == 'forbidden':
            raise Failure(403, 'forbidden', result['message'], currentState=result['current'])
        code = 'invalid_transition' if status == 'invalid_transition' else 'transition_refused'
        raise Failure(409, code, result['message'], currentState=result['current'])
    return SimpleNamespace(staff_sid=staff_sid, ended=ended)
