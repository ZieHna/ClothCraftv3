"""The storefront API: the shapes of frontend/src/api/types.ts, answered from Odoo (JSON-2) instead of the browser mock.

Catalogue, quote and checkout options (6a, 6b), orders (6c), and customer register / sign-in / sign-out with a server-side
session (6d). Orders belong to the customer the session names; there is no other way to say whose order it is.
"""
import base64
import json
import math
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from .cart import merge_lines, quote_from_odoo
from .config import Settings, settings as default_settings
from .delivery import is_complete, validate_delivery
from . import session as sess
from .odoo import OdooClient, OdooError
from .orders import order_from_odoo
from .shop import build_products, facets, money, palette, provinces, simulation, summary


SLUG = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')   # a storefront id, as Odoo accepts it (addons/clothcraft/models/product_template.py)


class ApiFailure(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None, **extra):
        self.status, self.code, self.message, self.headers, self.extra = status, code, message, headers or {}, extra


def create_app(settings: Settings = default_settings, odoo: OdooClient | None = None) -> FastAPI:
    client = odoo or OdooClient(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if len(settings.session_secret) < 32:
            raise RuntimeError('SESSION_SECRET must be set to at least 32 characters (backend/.env); the service will not start without it')
        yield
        await client.aclose()

    app = FastAPI(title='ClothCraft storefront API', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def respond(data, marker, status: int = 200):
        return JSONResponse({'data': data, 'simulation': simulation(marker)}, status_code=status)

    @app.exception_handler(ApiFailure)
    async def api_failure(_request: Request, exc: ApiFailure):
        return JSONResponse({'error': {'code': exc.code, 'message': exc.message, **exc.extra}}, status_code=exc.status, headers=exc.headers)

    @app.exception_handler(OdooError)
    async def odoo_failure(_request: Request, exc: OdooError):
        # the detail stays in the log; the shopper gets a sentence
        print(f'odoo error: {exc}', flush=True)
        return JSONResponse({'error': {'code': 'upstream_unavailable', 'message': 'The shop is not available right now. Please try again.'}}, status_code=502)

    async def load_products():
        data = await client.call('clothcraft.api', 'catalogue')
        return data, build_products(data, settings)

    # ------------------------------------------------------------------ catalogue
    def parse_amount(value: str | None):
        if value is None or value.strip() == '':
            return None
        try:
            number = float(value)
        except ValueError:
            return 'bad'
        return number if number == number and abs(number) != float('inf') and number >= 0 else 'bad'

    @app.get('/api/catalogue/products')
    async def list_products(request: Request):
        q = request.query_params
        group, kind = q.get('group') or None, q.get('type') or None
        text = (q.get('q') or '').strip().lower()
        low, high = parse_amount(q.get('min')), parse_amount(q.get('max'))
        data, products = await load_products()
        pal = palette()
        if group and group not in pal['groups']:
            raise ApiFailure(400, 'bad_group', f'Unknown group "{group}"')
        if kind and kind not in {p['garmentType']['code'] for p in products}:
            raise ApiFailure(400, 'bad_type', f'Unknown garment type "{kind}"')
        if low == 'bad' or high == 'bad':
            raise ApiFailure(400, 'bad_price', 'Prices must be numbers of 0 or more')
        if low is not None and high is not None and low > high:
            raise ApiFailure(400, 'bad_price', 'The minimum price is above the maximum price')
        in_group = [p for p in products if not group or p['group'] == group]
        matches = [
            p for p in in_group
            if (not kind or p['garmentType']['code'] == kind) and (not text or text in p['name'].lower())
            and (low is None or p['price'] >= low) and (high is None or p['price'] <= high)
            and (q.get('stock') != '1' or p['status'] != 'out_of_stock')]
        return respond({
            'currency': data['currency'], 'vatIncluded': data['vat_included'], 'groups': pal['groups'],
            'colors': pal['colors'], 'sizes': pal['sizes'], 'count': len(matches), **facets(in_group),
            'products': [summary(p) for p in matches],
        }, data['simulation'])

    @app.get('/api/catalogue/featured')
    async def featured():
        data, products = await load_products()
        chosen = [p for p in products if p['featured'] and p['status'] != 'out_of_stock']   # Odoo's "Featured on the shop" flag
        return respond({'currency': data['currency'], 'vatIncluded': data['vat_included'], 'products': [summary(p) for p in chosen]}, data['simulation'])

    @app.get('/api/catalogue/products/{product_id}')
    async def product_detail(product_id: str):
        data, products = await load_products()
        product = next((p for p in products if p['id'] == product_id), None)
        if product is None:
            raise ApiFailure(404, 'not_found', f'No product "{product_id}"')
        colours = {c['id']: c for c in palette()['colors']}
        return respond({
            **{k: v for k, v in product.items() if k != 'featured'}, 'currency': data['currency'], 'vatIncluded': data['vat_included'],
            'colorOptions': [{**colours[c], 'image': f'/garments/{product["id"]}/{c}.webp'} for c in product['colors']],
        }, data['simulation'])

    @app.get('/api/catalogue/products/{product_id}/image')
    async def product_image(product_id: str, request: Request):
        """The garment's own picture, as Odoo keeps it (at most 1024 px). The address carries a version (?v=) that changes with the
        picture, so browsers may keep it for a day; If-None-Match is answered with 304."""
        if not SLUG.fullmatch(product_id):
            raise ApiFailure(404, 'not_found', f'No picture for "{product_id}"')
        result = await client.call('clothcraft.api', 'product_image', slug=product_id)
        if result['status'] != 'ok' or not str(result.get('mimetype', '')).startswith('image/'):
            raise ApiFailure(404, 'not_found', f'No picture for "{product_id}"')
        headers = {'ETag': f'"{result["version"]}"', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff'}
        if request.headers.get('if-none-match') == headers['ETag']:
            return Response(status_code=304, headers=headers)
        return Response(content=base64.b64decode(result['data']), media_type=result['mimetype'], headers=headers)

    # ------------------------------------------------------------------ cart and checkout
    def parse_lines(body) -> list[dict] | None:
        lines = body.get('lines') if isinstance(body, dict) else None
        if not isinstance(lines, list) or len(lines) > settings.max_cart_lines:
            return None
        parsed = []
        for item in lines:
            if not isinstance(item, dict) or not isinstance(item.get('sku'), str):
                return None
            quantity = item.get('quantity')
            if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= settings.max_line_quantity:
                return None
            design = item.get('designId')   # step 9: a customized garment names its design ("12"); absent or null for a plain one
            if design is not None and not (isinstance(design, str) and design.isdigit() and len(design) <= 12):
                return None
            parsed.append({'sku': item['sku'], 'quantity': quantity, 'design_id': int(design) if design else None})
        return parsed

    def design_problem(odoo_quote: dict):
        """A design made for another garment than the line's (Odoo's quote status invalid): 422."""
        if odoo_quote.get('status') == 'invalid':
            raise ApiFailure(422, odoo_quote['code'], odoo_quote['message'])

    @app.post('/api/cart/quote')
    async def quote(request: Request):
        try:
            body = await request.json()
        except ValueError:
            body = None
        lines = parse_lines(body)
        if lines is None:
            raise ApiFailure(400, 'bad_request', 'Send {"lines": [{"sku": "...", "quantity": 1}]} with whole-number quantities from 1 to ' + str(settings.max_line_quantity) + '.')
        merged = merge_lines(lines)
        sid = sess.sid_from_request(request, settings) if any('design_id' in line for line in merged) else None
        # a design is priced only for its owner: the session goes with the lines that name one (without it, they are not available)
        odoo_quote = await client.call('clothcraft.api', 'quote', lines=merged, **({'sid_hash': sess.sid_hash(sid)} if sid else {}))
        design_problem(odoo_quote)
        return respond(quote_from_odoo(odoo_quote, settings), odoo_quote['simulation'])

    @app.get('/api/checkout/options')
    async def checkout_options():
        data = await client.call('clothcraft.api', 'shop_info')
        return respond({
            'currency': data['currency'], 'vatIncluded': data['vat_included'], 'vatRate': round(data['vat_rate']),
            'provinces': provinces(),
            'paymentMethods': [
                {'id': 'cod', 'label': 'Cash on delivery', 'description': 'Pay in cash when your order arrives.'},
                {'id': 'bank_transfer', 'label': 'Bank transfer', 'description': 'Your order is reserved and waits for your payment.'},
            ],
        }, data['simulation'])

    # ------------------------------------------------------------------ sessions (6d)
    UNAUTHORISED = 'Sign in to place or see orders.'

    @app.middleware('http')
    async def origin_and_cookie(request: Request, call_next):
        """Refuse a state-changing request that a browser says came from another site, and write the cookie a route asked for."""
        if request.method in sess.STATE_CHANGING and not sess.origin_allowed(request, settings):
            return JSONResponse({'error': {'code': 'forbidden_origin', 'message': 'This request did not come from the shop.'}}, status_code=403)
        response = await call_next(request)
        action = getattr(request.state, 'cookie', None)
        if action:
            secure = sess.is_https(request, settings)
            kind = action[3] if len(action) > 3 else 'customer'
            plain, host_prefixed = sess.cookie_names(kind)
            name = host_prefixed if secure else plain
            if action[0] == 'set':
                response.set_cookie(name, sess.cookie_value(action[1], settings.session_secret, kind), max_age=action[2], httponly=True, samesite='lax', secure=secure, path='/')
            else:
                response.delete_cookie(name, path='/', httponly=True, samesite='lax', secure=secure)
        return response

    def user_json(user: dict) -> dict:
        return {'id': str(user['id']), 'displayName': user['name'], 'email': user['email']}

    def keep(request: Request, sid: str, remaining: int | None, kind: str = 'customer'):
        """Renew the cookie for what the session can still last, so an active customer (or staff member) is not cut off by the idle limit."""
        if remaining:
            request.state.cookie = ('set', sid, remaining, kind)

    def require_session(request: Request) -> tuple[str, str]:
        """(the session id from the cookie, its hash). A missing, forged or tampered cookie is 401 without asking Odoo."""
        sid = sess.sid_from_request(request, settings)
        if not sid:
            raise ApiFailure(401, 'unauthorised', UNAUTHORISED)
        return sid, sess.sid_hash(sid)

    def not_signed_in(request: Request) -> ApiFailure:
        """Odoo says this session is over (ended, expired, or never existed): 401, and the browser is told to drop the cookie."""
        request.state.cookie = ('clear', None, 0)
        return ApiFailure(401, 'unauthorised', UNAUTHORISED)

    async def json_body(request: Request) -> dict | None:
        raw = await request.body()
        if len(raw) > settings.max_auth_body_bytes:
            raise ApiFailure(413, 'payload_too_large', 'That request is too large.')
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def too_many(seconds: int, what: str) -> ApiFailure:
        wait = 'a minute' if seconds <= 60 else f'{math.ceil(seconds / 60)} minutes'
        return ApiFailure(429, 'too_many_attempts', f'Too many {what}. Please wait {wait} and try again.', headers={'Retry-After': str(seconds)}, retryAfter=seconds)

    @app.post('/api/auth/register')
    async def register(request: Request):
        body = await json_body(request)
        if body is None or not all(isinstance(body.get(k), str) for k in ('name', 'email', 'password')):
            raise ApiFailure(400, 'bad_request', 'The request is not complete.')
        old = sess.sid_from_request(request, settings)
        sid = sess.new_sid()
        result = await client.call('clothcraft.api', 'auth_register', payload={
            'name': body['name'], 'email': body['email'], 'password': body['password'], 'sid_hash': sess.sid_hash(sid),
            'client_ip': sess.client_ip(request, settings), 'replace_sid_hash': sess.sid_hash(old) if old else None})
        status = result['status']
        if status == 'throttled':
            raise too_many(result['retry_after'], 'attempts')
        if status == 'invalid':
            raise ApiFailure(422, 'validation', 'Some details need fixing.', fields=result['fields'])
        if status == 'exists':
            raise ApiFailure(409, 'email_unavailable', "We couldn't create an account with that email. If it is yours, sign in instead.")
        if status == 'deactivated':
            raise ApiFailure(409, 'email_unavailable', 'The account with this email has been deactivated. Please contact the shop to have it restored.')
        keep(request, sid, result['remaining'])
        return respond({'user': user_json(result['user'])}, result['simulation'], 201)

    @app.post('/api/auth/login')
    async def login(request: Request):
        body = await json_body(request)
        if body is None or not all(isinstance(body.get(k), str) for k in ('email', 'password')):
            raise ApiFailure(400, 'bad_request', 'The request is not complete.')
        old = sess.sid_from_request(request, settings)
        sid = sess.new_sid()
        result = await client.call('clothcraft.api', 'auth_login', payload={
            'email': body['email'], 'password': body['password'], 'sid_hash': sess.sid_hash(sid),
            'client_ip': sess.client_ip(request, settings), 'replace_sid_hash': sess.sid_hash(old) if old else None})
        status = result['status']
        if status == 'throttled':
            raise too_many(result['retry_after'], 'sign-in attempts')
        if status == 'mfa_unsupported':
            raise ApiFailure(403, 'mfa_unsupported', 'This account uses two-step verification, which this shop does not support yet.')
        if status != 'ok':
            raise ApiFailure(401, 'invalid_credentials', 'The email or password is not right.')
        keep(request, sid, result['remaining'])
        return respond({'user': user_json(result['user'])}, result['simulation'])

    @app.post('/api/auth/logout')
    async def logout(request: Request):
        sid = sess.sid_from_request(request, settings)
        marker = False
        if sid:
            marker = (await client.call('clothcraft.api', 'auth_logout', payload={'sid_hash': sess.sid_hash(sid)}))['simulation']
        request.state.cookie = ('clear', None, 0)
        return respond({'signedOut': True}, marker)

    @app.get('/api/auth/me')
    async def me(request: Request):
        sid, hashed = require_session(request)
        result = await client.call('clothcraft.api', 'auth_session', payload={'sid_hash': hashed})
        if not result['valid']:
            raise not_signed_in(request)
        keep(request, sid, result['remaining'])
        return respond({'user': user_json(result['user'])}, result['simulation'])

    # ------------------------------------------------------------------ orders (6c), of the signed-in customer only
    def stock_problems(quote: dict, guard_message: str | None = None) -> list[dict]:
        short = [{'sku': r['sku'], 'available': r['available'], 'message': r['message'] or 'Sorry, this item cannot be supplied.'}
                 for r in quote['lines'] if r['issue'] != 'ok']
        if short:
            return short
        # the guard refused although nothing looks short now: report its own sentence against the first line
        first = quote['lines'][0]
        return [{'sku': first['sku'], 'available': first['available'], 'message': guard_message or 'Sorry, this item cannot be supplied.'}]

    @app.post('/api/orders')
    async def place_order(request: Request):
        sid, hashed = require_session(request)
        try:
            body = await request.json()
        except ValueError:
            body = None
        lines = parse_lines(body)
        if lines is None or not isinstance(body.get('delivery'), dict):
            raise ApiFailure(400, 'bad_request', 'The order request is not complete.')
        key = request.headers.get('Idempotency-Key') or None

        if key:
            earlier = await client.call('clothcraft.api', 'order_by_key', sid_hash=hashed, idempotency_key=key)
            if earlier.get('unauthorised'):
                raise not_signed_in(request)
            if earlier['found']:
                keep(request, sid, earlier['session_remaining'])
                return respond(order_from_odoo(earlier['order'], earlier, settings), earlier['simulation'], 201)

        method, quoted = body.get('paymentMethod'), body.get('quotedTotal')
        if method not in ('cod', 'bank_transfer'):
            raise ApiFailure(400, 'bad_request', 'Choose Cash on delivery or Bank transfer.')
        if isinstance(quoted, bool) or not isinstance(quoted, (int, float)) or quoted != quoted or abs(quoted) == float('inf'):
            raise ApiFailure(400, 'bad_request', 'The total you were shown is missing.')
        if not is_complete(body['delivery']):
            raise ApiFailure(400, 'bad_request', 'The order request is not complete.')
        fields = validate_delivery(body['delivery'], [p['code'] for p in provinces()])
        if fields:
            raise ApiFailure(422, 'validation', 'Some delivery details need fixing.', fields=fields)
        if not lines:
            raise ApiFailure(400, 'bad_request', 'The cart is empty.')

        d = body['delivery']
        result = await client.call('clothcraft.api', 'place_order', payload={
            'sid_hash': hashed, 'lines': merge_lines(lines), 'payment_method': method, 'quoted_total': money(quoted),
            'idempotency_key': key,
            'delivery': {
                'name': d['fullName'].strip(), 'email': d['email'].strip(), 'phone': d['phone'].strip(), 'street': d['street'].strip(),
                'city': d['city'].strip(), 'province': d['province'], 'postal_code': d['postalCode'].strip(), 'note': d['note'].strip()},
        })
        status = result['status']
        if status == 'unauthorised':
            raise not_signed_in(request)
        keep(request, sid, result.get('session_remaining'))
        if status == 'created':
            return respond(order_from_odoo(result['order'], result, settings), result['simulation'], 201)
        if status == 'invalid':
            raise ApiFailure(422, result['code'], result['message'])
        quote = quote_from_odoo(result['quote'], settings)
        if status == 'quote_not_ready' and any(r['issue'] == 'design_unavailable' for r in quote['lines']):
            problems = [p for p in stock_problems(quote) if p['message'] == 'This design is no longer available.']
            raise ApiFailure(409, 'design_unavailable', 'This design is no longer available. Remove it from your cart; nothing was ordered.', lines=problems)
        if status == 'quote_not_ready':
            problems = stock_problems(quote)
            raise ApiFailure(409, 'stock_conflict', f"{problems[0]['message']} Your cart has been kept.", lines=problems)
        if status == 'guard_refused':
            problems = stock_problems(quote, result['message'])
            raise ApiFailure(409, 'stock_conflict', f"{result['message']} Your cart has been kept.", lines=problems)
        raise ApiFailure(409, 'price_changed', 'The price changed since you last looked. Nothing was ordered. Please check the new total.', quote=quote)

    @app.get('/api/orders')
    async def list_orders(request: Request):
        sid, hashed = require_session(request)
        data = await client.call('clothcraft.api', 'orders', sid_hash=hashed)
        if data.get('unauthorised'):
            raise not_signed_in(request)
        keep(request, sid, data['session_remaining'])
        return respond([order_from_odoo(o, data, settings) for o in data['orders']], data['simulation'])

    @app.get('/api/orders/{order_id}')
    async def get_order(order_id: str, request: Request):
        sid, hashed = require_session(request)
        if not order_id.isdigit():
            raise ApiFailure(404, 'not_found', f'No order "{order_id}"')
        data = await client.call('clothcraft.api', 'order', sid_hash=hashed, order_id=int(order_id))
        if data.get('unauthorised'):
            raise not_signed_in(request)
        keep(request, sid, data['session_remaining'])
        if not data['found']:
            raise ApiFailure(404, 'not_found', f'No order "{order_id}"')
        return respond(order_from_odoo(data['order'], data, settings), data['simulation'])

    @app.post('/api/orders/{order_id}/received')
    async def confirm_received(order_id: str, request: Request):
        """Step 11: the signed-in customer confirms they received their delivered order, which closes it. Owner only (another
        customer's order is 404), only from delivered (409 invalid_transition with currentState), and the same answer when pressed
        again (it is already closed). Odoo locks the order and writes the history line as the customer's."""
        sid, hashed = require_session(request)
        if not order_id.isdigit():
            raise ApiFailure(404, 'not_found', f'No order "{order_id}"')
        result = await client.call('clothcraft.api', 'order_confirm_received', payload={'sid_hash': hashed, 'order_id': int(order_id)})
        if result['status'] == 'unauthorised':
            raise not_signed_in(request)
        keep(request, sid, result.get('session_remaining'))
        if result['status'] == 'not_found':
            raise ApiFailure(404, 'not_found', f'No order "{order_id}"')
        if result['status'] == 'invalid_transition':
            raise ApiFailure(409, 'invalid_transition', result['message'], currentState=result['current'])
        return respond(order_from_odoo(result['order'], result, settings), result['simulation'])

    from types import SimpleNamespace

    from .designs import install_designs
    from .staff import install_staff
    staff = install_staff(app, client, settings, SimpleNamespace(ApiFailure=ApiFailure, respond=respond, json_body=json_body, too_many=too_many, keep=keep))
    from .inventory import install_inventory
    install_inventory(app, client, settings, SimpleNamespace(ApiFailure=ApiFailure, respond=respond, json_body=json_body, keep=keep), staff)
    # the admin sign-in and read routes first: /api/admin/orders/summary has to be known before the mirrored /api/admin/orders/{order_id}
    from .admin import install_admin
    install_admin(app, client, settings, SimpleNamespace(ApiFailure=ApiFailure, respond=respond, json_body=json_body, too_many=too_many, keep=keep))
    # step 7e-1: the same order, supplier, stock and restock routes under /api/admin, reading ONLY the cc_admin cookie and telling Odoo the 'admin' scope
    from .odoo import ScopedOdoo
    admin_client = ScopedOdoo(client, 'admin')
    admin_staff = install_staff(app, admin_client, settings, SimpleNamespace(ApiFailure=ApiFailure, respond=respond, json_body=json_body, too_many=too_many, keep=keep),
                                prefix='/api/admin', kind='admin')
    install_inventory(app, admin_client, settings, SimpleNamespace(ApiFailure=ApiFailure, respond=respond, json_body=json_body, keep=keep), admin_staff,
                      prefix='/api/admin', kind='admin')
    install_designs(app, client, settings, SimpleNamespace(ApiFailure=ApiFailure, respond=respond, keep=keep, require_session=require_session, not_signed_in=not_signed_in))
    from .cart_routes import install_cart
    install_cart(app, client, settings, SimpleNamespace(ApiFailure=ApiFailure, respond=respond, keep=keep, require_session=require_session,
                                                        not_signed_in=not_signed_in, too_many=too_many))
    return app


app = create_app()
