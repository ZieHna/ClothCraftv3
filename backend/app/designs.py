"""Customized garments (step 9b): the print-fee settings of a garment, uploading a design, reading it back, its pictures, removing it, and
the staff download of a design on an order.

The service decides nothing about a design: Odoo (clothcraft.api, models/api_design.py) checks every picture, the element list against the
editor state, the limits and whose design it is, prices it, and answers with what happened. What the service does itself is refuse a body
that is too large BEFORE reading it whole: the upload is read as a stream and cut off at max_design_body_bytes (the 20 MB decoded budget
as base64, plus room for the JSON around it).
"""
import base64
import json

from fastapi import Request
from fastapi.responses import Response

from . import session as sess

TOO_LARGE = 'This design is too large to upload (at most 20 MB in all). Use smaller pictures or fewer of them.'
FORMAT = 'This design could not be read (format version 1 expected).'
NOT_FOUND = 'This design is no longer available.'
STAFF_UNAUTHORISED = 'Sign in to the staff dashboard to continue.'


def design_json(d: dict) -> dict:
    base = f'/api/designs/{d["id"]}'
    version = f'?v={d["version"]}' if d.get('version') else ''
    return {
        'id': str(d['id']), 'productId': d['slug'], 'sku': d['sku'], 'state': d['state'], 'coveredSqIn': d['covered_sq_in'],
        'layerCount': d['layer_count'], 'printPx': d['print_px'], 'createdAt': d['created'] + 'Z',
        'previewUrl': f'{base}/preview.png{version}', 'printUrl': f'{base}/print.png{version}',
    }


def pricing_json(p: dict) -> dict:
    return {
        'designable': p['designable'], 'message': p['message'] or None, 'box': p['box'], 'referenceSqIn': p['reference_sq_in'],
        'rate': p['rate'], 'sizeStep': p['size_step'], 'steps': p['steps'], 'band': p['band'],
        'currency': p['currency'], 'vatIncluded': p['vat_included'],
        'limits': {'totalBytes': p['limits']['total'], 'pictureBytes': p['limits']['picture'], 'pictures': p['limits']['pictures'],
                   'elements': p['limits']['layers'], 'previewBytes': p['limits']['preview'], 'printBytes': p['limits']['print'],
                   'stateBytes': p['limits']['state'], 'printMaxPx': p['limits']['print_px'], 'previewPx': p['limits']['preview_px']},
    }


def install_designs(app, client, settings, ctx):
    Failure, respond, keep, require_session, not_signed_in = ctx.ApiFailure, ctx.respond, ctx.keep, ctx.require_session, ctx.not_signed_in

    def refused(result: dict):
        return Failure(result['http_status'], result['code'], result['message'])

    def design_id(raw: str) -> int:
        if not raw.isdigit():
            raise Failure(404, 'not_found', NOT_FOUND)
        return int(raw)

    def picture(result: dict, request: Request, disposition: str, cache: str) -> Response:
        headers = {'ETag': f'"{result["version"]}"', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff',
                   'Content-Disposition': f'{disposition}; filename="{result["filename"]}"'}
        if request.headers.get('if-none-match') == headers['ETag']:
            return Response(status_code=304, headers=headers)
        return Response(content=base64.b64decode(result['data']), media_type='image/png', headers=headers)

    async def read_capped(request: Request) -> bytes:
        """The body, refused with 413 as soon as it is known to be over the cap (from Content-Length, else while it streams in)."""
        cap = settings.max_design_body_bytes
        declared = request.headers.get('content-length')
        if declared and declared.isdigit() and int(declared) > cap:
            raise Failure(413, 'too_large', TOO_LARGE)
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > cap:
                raise Failure(413, 'too_large', TOO_LARGE)
            chunks.append(chunk)
        return b''.join(chunks)

    # ------------------------------------------------------------------ the fee settings of one garment (public: the editor estimates with them)
    @app.get('/api/designs/pricing')
    async def design_pricing(request: Request):
        slug = request.query_params.get('product') or ''
        result = await client.call('clothcraft.api', 'design_pricing', slug=slug)
        if result['status'] != 'ok':
            raise Failure(404, 'not_found', f'No product "{slug}"')
        return respond({'productId': slug, **pricing_json(result)}, result['simulation'])

    # ------------------------------------------------------------------ uploading
    @app.post('/api/designs')
    async def upload(request: Request):
        sid, hashed = require_session(request)
        raw = await read_capped(request)
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        if not isinstance(body, dict) or body.get('schemaVersion') != 1:
            raise Failure(422, 'format', FORMAT)
        for key, kinds in (('productId', str), ('sku', str), ('state', str), ('layers', list), ('pictures', list), ('preview', str), ('print', str)):
            if not isinstance(body.get(key), kinds):
                raise Failure(422, 'format', FORMAT)
        result = await client.call('clothcraft.api', 'design_upload', payload={
            'sid_hash': hashed, 'product': body['productId'], 'sku': body['sku'], 'idempotency_key': request.headers.get('Idempotency-Key') or None,
            'state': body['state'], 'layers': body['layers'], 'pictures': body['pictures'], 'preview': body['preview'], 'print': body['print']})
        status = result['status']
        if status == 'unauthorised':
            raise not_signed_in(request)
        keep(request, sid, result.get('session_remaining'))
        if status == 'not_found':
            raise Failure(404, 'not_found', f'No product "{body["productId"]}"')
        if status == 'refused':
            raise refused(result)
        return respond(design_json(result['design']), result['simulation'], 201)

    # ------------------------------------------------------------------ the customer's own design
    @app.get('/api/designs/{raw_id}')
    async def get_design(raw_id: str, request: Request):
        sid, hashed = require_session(request)
        result = await client.call('clothcraft.api', 'design_get', payload={'sid_hash': hashed, 'design_id': design_id(raw_id)})
        if result['status'] == 'unauthorised':
            raise not_signed_in(request)
        keep(request, sid, result.get('session_remaining'))
        if result['status'] != 'ok':
            raise Failure(404, 'not_found', NOT_FOUND)
        return respond(design_json(result['design']), result['simulation'])

    @app.get('/api/designs/{raw_id}/state')
    async def design_state(raw_id: str, request: Request):
        """The editor state and pictures of the customer's own design, to open it again ("Edit design" in the cart)."""
        sid, hashed = require_session(request)
        result = await client.call('clothcraft.api', 'design_state', payload={'sid_hash': hashed, 'design_id': design_id(raw_id)})
        if result['status'] == 'unauthorised':
            raise not_signed_in(request)
        keep(request, sid, result.get('session_remaining'))
        if result['status'] != 'ok':
            raise Failure(404, 'not_found', NOT_FOUND)
        return respond({'design': design_json(result['design']), 'state': result['state'],
                        'pictures': [{'id': p['id'], 'type': p['mimetype'], 'data': p['data']} for p in result['pictures']]}, result['simulation'])

    async def own_picture(raw_id: str, kind: str, request: Request):
        _sid, hashed = require_session(request)
        result = await client.call('clothcraft.api', 'design_image', payload={'sid_hash': hashed, 'design_id': design_id(raw_id), 'kind': kind})
        if result['status'] == 'unauthorised':
            raise not_signed_in(request)
        if result['status'] != 'ok':
            raise Failure(404, 'not_found', NOT_FOUND)
        return picture(result, request, 'inline' if kind == 'preview' else 'attachment', 'private, max-age=3600')

    @app.get('/api/designs/{raw_id}/preview.png')
    async def own_preview(raw_id: str, request: Request):
        return await own_picture(raw_id, 'preview', request)

    @app.get('/api/designs/{raw_id}/print.png')
    async def own_print(raw_id: str, request: Request):
        return await own_picture(raw_id, 'print', request)

    @app.delete('/api/designs/{raw_id}')
    async def remove_design(raw_id: str, request: Request):
        sid, hashed = require_session(request)
        result = await client.call('clothcraft.api', 'design_void', payload={'sid_hash': hashed, 'design_id': design_id(raw_id)})
        if result['status'] == 'unauthorised':
            raise not_signed_in(request)
        keep(request, sid, result.get('session_remaining'))
        if result['status'] == 'not_found':
            raise Failure(404, 'not_found', NOT_FOUND)
        if result['status'] == 'refused':
            raise refused(result)
        return respond({'removed': True}, result['simulation'])

    # ------------------------------------------------------------------ staff: the pictures of a design on an order
    async def staff_picture(raw_id: str, kind: str, request: Request, door: str = 'staff'):
        """`door` is the cookie kind this route reads: 'staff' (/api/staff) or 'admin' (/api/admin); Odoo is told the same scope."""
        said = 'Sign in to the admin dashboard to continue.' if door == 'admin' else STAFF_UNAUTHORISED
        sid = sess.sid_from_request(request, settings, door)
        if not sid:
            if door == 'admin' and sess.sid_from_request(request, settings, 'staff'):
                raise Failure(403, 'forbidden', 'The admin dashboard has its own sign-in. Use Admin login.')
            raise Failure(401, 'unauthorised', said)
        result = await client.call('clothcraft.api', 'staff_design_image', payload={'sid_hash': sess.sid_hash(sid), 'design_id': design_id(raw_id), 'kind': kind},
                                   context={'clothcraft_scope': door})
        if result['status'] == 'unauthorised':
            request.state.cookie = ('clear', None, 0, door)
            raise Failure(401, 'unauthorised', said)
        if result['status'] != 'ok':
            raise Failure(404, 'not_found', NOT_FOUND)
        return picture(result, request, 'attachment', 'private, no-store')

    @app.get('/api/staff/designs/{raw_id}/preview.png')
    async def staff_preview(raw_id: str, request: Request):
        return await staff_picture(raw_id, 'preview', request)

    @app.get('/api/staff/designs/{raw_id}/print.png')
    async def staff_print(raw_id: str, request: Request):
        return await staff_picture(raw_id, 'print', request)

    @app.get('/api/admin/designs/{raw_id}/preview.png')
    async def admin_preview(raw_id: str, request: Request):
        return await staff_picture(raw_id, 'preview', request, 'admin')

    @app.get('/api/admin/designs/{raw_id}/print.png')
    async def admin_print(raw_id: str, request: Request):
        return await staff_picture(raw_id, 'print', request, 'admin')
