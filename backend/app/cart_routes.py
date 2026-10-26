"""Step 12: the customer's saved cart (real shop only).

GET /api/cart and PUT /api/cart, for a signed-in customer only (a staff cookie opens nothing here). A PUT writes the whole cart with the
version the browser last saw: Odoo locks the cart row, and a different version is 409 cart_conflict with the cart as it is now, so the
browser can merge its own edits into it. The body is capped (settings.max_cart_body_bytes) and Odoo limits the writes per session.
The service decides nothing else: Odoo checks every line (the item, the quantity, that a design is the customer's own) and owns the cart.
"""
import json

from fastapi import Request

CONFLICT = 'Your cart was changed in another tab or on another device.'
TOO_LARGE = 'That cart is too large.'


def cart_json(data: dict) -> dict:
    """Odoo's cart (clothcraft.api._api_cart_data) -> the API's ServerCart. No prices: the quote prices it."""
    lines = []
    for line in data['lines']:
        row = {'sku': line['sku'], 'productId': line['product_slug'], 'quantity': line['quantity'], 'selected': line['selected']}
        if line.get('design_id'):
            row['designId'] = line['design_id']
        lines.append(row)
    return {'version': data['version'], 'updatedAt': data['updated'] + 'Z' if data['updated'] else None, 'lines': lines}


def install_cart(app, client, settings, ctx):
    Failure, respond, keep, require_session, not_signed_in, too_many = (
        ctx.ApiFailure, ctx.respond, ctx.keep, ctx.require_session, ctx.not_signed_in, ctx.too_many)

    async def capped_json(request: Request):
        """The JSON body, refused with 413 as soon as it is known to be over the cap."""
        cap = settings.max_cart_body_bytes
        declared = request.headers.get('content-length')
        if declared and declared.isdigit() and int(declared) > cap:
            raise Failure(413, 'payload_too_large', TOO_LARGE)
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > cap:
                raise Failure(413, 'payload_too_large', TOO_LARGE)
            chunks.append(chunk)
        try:
            data = json.loads(b''.join(chunks))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    @app.get('/api/cart')
    async def get_cart(request: Request):
        sid, hashed = require_session(request)
        result = await client.call('clothcraft.api', 'cart_get', payload={'sid_hash': hashed})
        if result['status'] == 'unauthorised':
            raise not_signed_in(request)
        keep(request, sid, result.get('session_remaining'))
        return respond(cart_json(result['cart']), result['simulation'])

    @app.put('/api/cart')
    async def put_cart(request: Request):
        sid, hashed = require_session(request)
        body = await capped_json(request)
        base, lines = (body or {}).get('baseVersion'), (body or {}).get('lines')
        if body is None or isinstance(base, bool) or not isinstance(base, int) or not isinstance(lines, list):
            raise Failure(400, 'bad_request', 'The cart request is not complete.')
        sent = []
        for line in lines:
            if not isinstance(line, dict):
                sent.append(line)        # Odoo names the line that is not readable
                continue
            row = {'sku': line.get('sku'), 'quantity': line.get('quantity'), 'selected': line.get('selected', False)}
            if line.get('designId') is not None:
                row['design_id'] = line.get('designId')
            sent.append(row)
        result = await client.call('clothcraft.api', 'cart_put', payload={'sid_hash': hashed, 'base_version': base, 'lines': sent})
        status = result['status']
        if status == 'unauthorised':
            raise not_signed_in(request)
        keep(request, sid, result.get('session_remaining'))
        if status == 'throttled':
            raise too_many(result['retry_after'], 'cart changes')
        if status == 'invalid':
            raise Failure(422, 'validation', 'Some cart lines need fixing.', fields=result['fields'])
        if status == 'conflict':
            raise Failure(409, 'cart_conflict', CONFLICT, cart=cart_json(result['cart']))
        return respond(cart_json(result['cart']), result['simulation'])
