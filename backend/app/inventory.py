"""The staff side of suppliers, restocks, stock, low-stock levels and the bell (Supplier and Restock, phase 4).

One route per facade method of clothcraft.api (models/api_supplier.py, api_restock.py, api_stock.py, api_notification.py, api_options.py).
This file decides nothing: it checks the SHAPE of a request (known fields only, types, lengths, known filter values, ids), forwards it with the
staff session, and turns Odoo's answer into HTTP. Who may do what, every rule, every sentence a person reads, is Odoo's: the role is re-read
there on every call, and an Inventory member asking for an Administrator's action gets Odoo's `forbidden`, which is 403 here.

Session: the cc_staff cookie, exactly as the order routes use it (staff.py: staff_sid, ended; keep renews the cookie).

Answers: {"data": ..., "simulation": ...}; an Odoo reply becomes `data` with its envelope removed. Keys are camelCase, ids are strings,
datetimes are ISO with a Z, money is a plain JSON number rounded to 2 decimals (as the order routes do). Failures are
{"error": {"code", "message", ...}}; field problems are 422 `validation` with `fields`, whether FastAPI or Odoo found them:

    Odoo status          HTTP  code                  extra
    done / ok            200 (201 on create)
    unauthorised         401   unauthorised          (the staff cookie is cleared)
    forbidden            403   forbidden             Odoo's sentence
    not_found            404   not_found
    invalid              422   validation            fields {camelCaseName: sentence}
    invalid_transition   409   invalid_transition    currentState, the restock when Odoo sends it
    refused              409   refused               Odoo's sentence, currentState when Odoo sends it
    anything else        502   upstream_unavailable  a generic sentence (the detail is logged, never a request body)
"""
import functools
import math
import re

from fastapi import Request

DIGITS = re.compile(r'\d{1,12}')
DAY = re.compile(r'\d{4}-\d{2}-\d{2}')
SUPPLIER_STATUSES = {'available', 'unavailable_range', 'off', 'inactive'}
RESTOCK_STATES = {'requested', 'approved', 'rejected', 'received', 'not_received'}
BOOLEANS = {'true': True, 'false': False}
PAGE_MAX = 100
PAGE_DEFAULT = 25
# B8 S4c: the DSS routes' known values (the facade in clothcraft_dss/models/api_dss.py checks them again)
DSS_DIGITS = 4          # decimals of every number on the DSS routes (units, percentages, money and the few fractions); other routes keep 2
DSS_KINDS = {'real', 'simulated'}
DSS_LEVELS = {'product', 'garment_type', 'total'}
DSS_POLICIES = {'naive', 'ma4', 'snaive', 'ets', 'ets_croston', 'chosen'}
DSS_HORIZONS = {'all'} | {str(h) for h in range(1, 9)}
DSS_URGENCY = {'stockout_before_arrival', 'order_now', 'plan', 'ok', 'no_forecast'}
DSS_SEGMENTS = {'champions', 'loyal', 'potential_loyalists', 'new', 'at_risk', 'one_time_lapsed', 'hibernating', 'needs_attention'}
DSS_ALERT_KINDS = {'unpaid_bank_transfer', 'forecast_stockout', 'low_stock_risk', 'restock_supplier', 'restock_overdue'}
ENVELOPE = {'status', 'message', 'currency', 'vat_rate', 'vat_included', 'vat_rounding', 'simulation', 'session_remaining'}
ID_LISTS = {'combos'}   # [[size id, colour id]]: pairs of ids, sent as strings like every other id


# ---------------------------------------------------------------------- shape checks: each returns the value or raises ValueError(sentence)
def text(high, low=0, nullable=True):
    def check(value):
        if value is None and nullable:
            return None
        if not isinstance(value, str):
            raise ValueError('Send text.')
        if low and len(value.strip()) < low:
            raise ValueError('This is needed.' if low == 1 else f'Write at least {low} characters.')
        if len(value) > high:
            raise ValueError(f'Keep this to {high} characters or fewer.')
        return value
    return check


def boolean(value):
    if not isinstance(value, bool):
        raise ValueError('Send true or false.')
    return value


def whole(low, high):
    def check(value):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError('Send a whole number.')
        if not low <= value <= high:
            raise ValueError(f'Send a number from {low} to {high}.')
        return value
    return check


def money(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or (isinstance(value, float) and not math.isfinite(value)):
        raise ValueError('Send an amount as a number.')
    if not 0 <= value <= 1_000_000_000:
        raise ValueError('Send an amount of 0 or more.')
    return value


def ident(value):
    """An id in the body: a whole number (sent by the browser as a number or as the string it was given)."""
    if isinstance(value, str) and DIGITS.fullmatch(value):
        return int(value)
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value < 10 ** 12:
        raise ValueError('Choose one from the list.')
    return value


def day(value):
    if not isinstance(value, str) or not DAY.fullmatch(value):
        raise ValueError('Send a date as YYYY-MM-DD.')
    return value


def id_map(item):
    """{"<line id>": value}: keys are line ids as digits, values are checked by `item`."""
    def check(value):
        if not isinstance(value, dict) or len(value) > 50:
            raise ValueError('Send one entry per line, keyed by the line id.')
        out = {}
        for key, entry in value.items():
            if not isinstance(key, str) or not DIGITS.fullmatch(key):
                raise ValueError('Each entry is keyed by a line id.')
            out[key] = item(entry)
        return out
    return check


def restock_lines(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 50:
        raise ValueError('Send from 1 to 50 lines.')
    out = []
    for row in value:
        if not isinstance(row, dict) or set(row) - {'productId', 'quantity', 'unitCost'} or 'productId' not in row or 'quantity' not in row:
            raise ValueError('Each line is {productId, quantity, unitCost?}.')
        line = {'product_id': ident(row['productId']), 'quantity': whole(1, 10000)(row['quantity'])}
        if row.get('unitCost') is not None:
            line['unit_cost'] = money(row['unitCost'])
        out.append(line)
    return out


# spec: camelCase request name -> (name sent to Odoo, check)
NOTE = ('note', text(500))
SUPPLIER = {
    'name': ('name', text(120, 1, False)), 'contactName': ('contact_name', text(120, 1, False)), 'street': ('street', text(200, 1, False)),
    'street2': ('street2', text(200)), 'city': ('city', text(100, 1, False)), 'zip': ('zip', text(20)), 'phone': ('phone', text(40)),
    'countryCode': ('country_code', text(2, 2, False)), 'ships': ('ships', boolean), 'shippingFee': ('shipping_fee', money),
}
LINE = {'garmentTypeId': ('garment_type_id', ident), 'sizeValueId': ('size_value_id', ident), 'colorValueId': ('color_value_id', ident),
        'unitCost': ('unit_cost', money)}
RANGE = {'dateFrom': ('date_from', day), 'dateTo': ('date_to', day), 'reason': ('reason', text(200))}
RESTOCK_FIELDS = {
    'lines': ('lines', restock_lines), 'shippingOn': ('shipping_on', boolean), 'shippingFee': ('shipping_fee', money),
    'expectedFrom': ('expected_from', day), 'expectedTo': ('expected_to', day), 'requestNote': ('request_note', text(500)),
}
RESTOCK_CREATE = {'supplierId': ('supplier_id', ident), **RESTOCK_FIELDS}      # no `note`: a new ticket's history line carries no note of its own
RESTOCK_UPDATE = {**RESTOCK_FIELDS, 'note': NOTE}                               # `note` is the history note of this edit
RECEIVE = {'quantities': ('quantities', id_map(whole(0, 10000))), 'lots': ('lots', id_map(text(64, 1, False))), 'receivedOn': ('received_on', day), 'note': NOTE}
ROLE_WORDS = {'inventory', 'admin'}


def role_word(value):
    if not isinstance(value, str) or value not in ROLE_WORDS:
        raise ValueError('Choose Inventory Staff or Administrator.')
    return value


# the Administrator's employee management (admin prefix only): names, email, role and a temporary password; Odoo applies every rule
EMPLOYEE_FIELDS = {'name': ('name', text(80, 1, False)), 'email': ('email', text(254, 1, False)), 'jobTitle': ('job_title', text(80)), 'phone': ('phone', text(40))}
EMPLOYEE_CREATE = {**EMPLOYEE_FIELDS, 'role': ('role', role_word), 'password': ('password', text(128, 1, False))}
EMPLOYEE_ROLE = {'role': ('role', role_word)}
CUSTOMER_FIELDS = {'name': ('name', text(80, 1, False)), 'email': ('email', text(254, 1, False)), 'phone': ('phone', text(40))}
EMPLOYEE_PASSWORD = {'password': ('password', text(128, 1, False))}
STOCK_EDIT = {'quantity': ('quantity', whole(0, 1_000_000)), 'reason': ('reason', text(500, 5, False))}


# ---------------------------------------------------------------------- Odoo -> JSON
def camel(key: str) -> str:
    head, *rest = key.split('_')
    return head + ''.join(part[:1].upper() + part[1:] for part in rest)


def when(value: str) -> str:
    return value.replace(' ', 'T') + 'Z' if isinstance(value, str) and len(value) == 19 and value[10] == ' ' else value


def to_api(value, key: str | None = None, digits: int = 2):
    """Odoo's JSON to the API's: camelCase keys, ids as strings, times as ISO, numbers rounded to `digits` (2 for money and every route that
    existed before B8; the DSS routes pass DSS_DIGITS, because a daily demand of 0.03 or a trend of 0.0112 must not become 0.03 or 0.01 by accident)."""
    if isinstance(value, dict):
        return {camel(k): to_api(v, k, digits) for k, v in value.items()}
    if isinstance(value, list):
        return [[str(i) for i in item] if key in ID_LISTS else to_api(item, key, digits) for item in value]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int) and key and (key == 'id' or key.endswith('_id')):
        return str(value)
    if isinstance(value, float):
        return round(value, digits)
    if isinstance(value, str) and key and (key == 'at' or key.endswith('_at')):
        return when(value)
    return value


def install_inventory(app, client, settings, ctx, staff, prefix='/api/staff', kind='staff'):
    """Under /api/staff (kind 'staff') or /api/admin (kind 'admin'): see staff.install_staff."""
    Failure, respond, json_body, keep = ctx.ApiFailure, ctx.respond, ctx.json_body, ctx.keep

    def check_body(body: dict, spec: dict, required=()) -> dict:
        fields = {name: 'Not allowed.' for name in body if name not in spec}
        out = {}
        for name, (sent, check) in spec.items():
            if name in body:
                try:
                    out[sent] = check(body[name])
                except ValueError as error:
                    fields[name] = str(error)
            elif name in required:
                fields[name] = 'This is needed.'
        if fields:
            raise Failure(422, 'validation', 'Some details need fixing.', fields=fields)
        return out

    def check_query(request: Request, spec: dict, paged: bool) -> tuple[dict, int, int]:
        """(payload for Odoo, page, pageSize). Only the names in `spec` (and page / pageSize when paged) are allowed; each has known values."""
        q = request.query_params
        allowed = set(spec) | ({'page', 'pageSize'} if paged else set())
        fields = {name: 'Not allowed.' for name in q if name not in allowed}
        out, page, size = {}, 1, PAGE_DEFAULT
        for name, (sent, check) in spec.items():
            raw = q.get(name)
            if raw is None or raw == '':
                continue
            try:
                value = check(raw)
            except ValueError as error:
                fields[name] = str(error)
                continue
            if value is not False:
                out[sent] = value
        if paged:
            for name, default, low, high in (('page', 1, 1, 10 ** 6), ('pageSize', PAGE_DEFAULT, 1, PAGE_MAX)):
                raw = q.get(name)
                if raw is None or raw == '':
                    continue
                if not DIGITS.fullmatch(raw) or not low <= int(raw) <= high:
                    fields[name] = f'Send a whole number from {low} to {high}.'
                elif name == 'page':
                    page = int(raw)
                else:
                    size = int(raw)
        if fields:
            raise Failure(422, 'validation', 'Some details need fixing.', fields=fields)
        return out, page, size

    def one_of(values):
        def check(raw):
            if raw not in values:
                raise ValueError('Choose one of: ' + ', '.join(sorted(values)) + '.')
            return raw
        return check

    def flag(raw):
        if raw not in BOOLEANS:
            raise ValueError('Send true or false.')
        return BOOLEANS[raw]

    def search(raw):
        if len(raw) > 100:
            raise ValueError('Keep the search to 100 characters or fewer.')
        return raw

    def id_param(raw):
        if not DIGITS.fullmatch(raw):
            raise ValueError('Send an id.')
        return int(raw)

    def failure(request: Request, status: str, result: dict, noun: str, ref: str | None) -> Failure:
        if status == 'forbidden':
            return Failure(403, 'forbidden', result['message'])
        if status == 'not_found':
            return Failure(404, 'not_found', f'No {noun} "{ref}"' if ref else f'No {noun}.')
        if status == 'invalid':
            return Failure(422, 'validation', 'Some details need fixing.', fields={camel(k): v for k, v in result['fields'].items()})
        # B8 S4c (DSS): Odoo words these itself; a run is asked for by query, so there is no path id to name
        if status == 'no_run':
            return Failure(404, 'not_found', result['message'])
        if status in ('run_in_progress', 'run_failed'):
            return Failure(409, status, result['message'])
        if status in ('invalid_transition', 'refused'):
            extra = {'currentState': result['current']} if result.get('current') else {}
            if result.get('restock'):
                extra['restock'] = to_api(result['restock'])
            return Failure(409, status, result['message'], **extra)
        print(f'odoo gave an unexpected status: {status}', flush=True)    # the status only: never a request body
        return Failure(502, 'upstream_unavailable', 'The shop is not available right now. Please try again.')

    def add(verb: str, path: str, method: str, *, noun: str, ids=(), body=None, required=(), body_optional=False, query=None, paged=False,
            created=False, list_key=None, status_code=None, digits=2):
        """One route: check the cookie, the path ids, the body and the query; call the facade method; shape the answer."""
        async def handler(request: Request):
            sid, hashed = staff.staff_sid(request)
            payload, ref = {}, None
            for name, sent in ids:
                ref = request.path_params[name]
                if not DIGITS.fullmatch(ref):
                    raise Failure(404, 'not_found', f'No {noun} "{ref}"')
                payload[sent] = int(ref)
            if body is not None:
                if not (await request.body()).strip():    # no body at all behaves like {}: the missing fields are named by check_body
                    parsed = {}
                else:
                    parsed = await json_body(request)
                    if parsed is None:
                        raise Failure(400, 'bad_request', 'The request is not complete.')
                payload.update(check_body(parsed, body, required))
            elif verb != 'GET' and (await request.body()).strip() not in (b'', b'{}'):
                raise Failure(422, 'validation', 'Some details need fixing.', fields={'body': 'This request takes no body.'})
            found, page, size = check_query(request, query or {}, paged)
            payload.update(found)
            if paged:
                payload.update(limit=size, offset=(page - 1) * size)
            result = await client.call('clothcraft.api', method, payload={'sid_hash': hashed, **payload})
            status = result['status']
            if status == 'unauthorised':
                raise staff.ended(request)
            keep(request, sid, result.get('session_remaining'), kind)
            if status not in ('done', 'ok'):
                raise failure(request, status, result, noun, ref)
            data = {k: v for k, v in result.items() if k not in ENVELOPE}
            if paged:
                data.pop('limit', None)
                data.pop('offset', None)
                data.update(page=page, page_size=size)
            return respond(to_api(data, digits=digits), result['simulation'], status_code or (201 if created else 200))

        app.add_api_route(path, handler, methods=[verb])

    P = prefix
    # ------------------------------------------------------------------ suppliers
    add('GET', f'{P}/suppliers', 'staff_suppliers', noun='supplier', paged=True,
        query={'q': ('q', search), 'status': ('status', one_of(SUPPLIER_STATUSES))})
    add('GET', f'{P}/suppliers/{{supplier_id}}', 'staff_supplier', noun='supplier', ids=[('supplier_id', 'supplier_id')])
    add('POST', f'{P}/suppliers', 'supplier_create', noun='supplier', body=SUPPLIER, required=('name', 'contactName', 'street', 'city'), created=True)
    add('PATCH', f'{P}/suppliers/{{supplier_id}}', 'supplier_update', noun='supplier', ids=[('supplier_id', 'supplier_id')], body=SUPPLIER)
    add('POST', f'{P}/suppliers/{{supplier_id}}/lines', 'supplier_line_add', noun='supplier', ids=[('supplier_id', 'supplier_id')], body=LINE,
        required=tuple(LINE), created=True)
    add('PATCH', f'{P}/supplier-lines/{{line_id}}', 'supplier_line_update', noun='supply line', ids=[('line_id', 'line_id')], body=LINE)
    add('DELETE', f'{P}/supplier-lines/{{line_id}}', 'supplier_line_remove', noun='supply line', ids=[('line_id', 'line_id')])
    add('POST', f'{P}/suppliers/{{supplier_id}}/ranges', 'supplier_range_add', noun='supplier', ids=[('supplier_id', 'supplier_id')], body=RANGE,
        required=('dateFrom', 'dateTo'), created=True)
    add('PATCH', f'{P}/supplier-ranges/{{range_id}}', 'supplier_range_update', noun='unavailable range', ids=[('range_id', 'range_id')], body=RANGE)
    add('DELETE', f'{P}/supplier-ranges/{{range_id}}', 'supplier_range_remove', noun='unavailable range', ids=[('range_id', 'range_id')])
    for action, method in (('deactivate', 'supplier_deactivate'), ('reactivate', 'supplier_reactivate'), ('switch-off', 'supplier_switch_off'),
                           ('switch-on', 'supplier_switch_on')):
        add('POST', f'{P}/suppliers/{{supplier_id}}/{action}', method, noun='supplier', ids=[('supplier_id', 'supplier_id')])
    # Administrator only (Odoo checks the role): the supplier's opening balance, a starting investment for stock already held (never a monthly cost)
    add('PUT', f'{P}/suppliers/{{supplier_id}}/opening-balance', 'supplier_set_opening_balance', noun='supplier', ids=[('supplier_id', 'supplier_id')],
        body={'openingBalance': ('opening_balance', money)}, required=('openingBalance',))
    add('GET', f'{P}/garment-options', 'staff_garment_options', noun='garment option')

    # ------------------------------------------------------------------ restocks
    add('GET', f'{P}/restock-options', 'staff_restock_options', noun='supplier', query={'supplierId': ('supplier_id', id_param)})
    add('GET', f'{P}/restocks', 'staff_restocks', noun='restock', paged=True, query={
        'q': ('q', search), 'state': ('state', one_of(RESTOCK_STATES)), 'supplierId': ('supplier_id', id_param),
        'late': ('late', flag), 'overdue': ('overdue', flag)})
    add('GET', f'{P}/restocks/{{restock_id}}', 'staff_restock', noun='restock', ids=[('restock_id', 'restock_id')])
    add('POST', f'{P}/restocks', 'restock_create', noun='restock', body=RESTOCK_CREATE, required=('supplierId', 'lines', 'expectedFrom', 'expectedTo'),
        created=True)
    add('PATCH', f'{P}/restocks/{{restock_id}}', 'restock_update', noun='restock', ids=[('restock_id', 'restock_id')], body=RESTOCK_UPDATE)
    add('POST', f'{P}/restocks/{{restock_id}}/approve', 'restock_approve', noun='restock', ids=[('restock_id', 'restock_id')], body={'note': NOTE},
        body_optional=True)
    add('POST', f'{P}/restocks/{{restock_id}}/reject', 'restock_reject', noun='restock', ids=[('restock_id', 'restock_id')],
        body={'note': ('note', text(500, 1, False))}, required=('note',))
    add('POST', f'{P}/restocks/{{restock_id}}/receive', 'restock_receive', noun='restock', ids=[('restock_id', 'restock_id')], body=RECEIVE,
        body_optional=True)
    add('POST', f'{P}/restocks/{{restock_id}}/not-received', 'restock_not_received', noun='restock', ids=[('restock_id', 'restock_id')],
        body={'note': NOTE}, body_optional=True)

    # ------------------------------------------------------------------ stock and low-stock levels
    add('GET', f'{P}/stock', 'staff_stock', noun='variant', paged=True, query={'q': ('q', search), 'low': ('low', flag)})
    add('GET', f'{P}/stock/history', 'staff_stock_history', noun='variant', paged=True, query={'productId': ('product_id', id_param)})
    add('POST', f'{P}/stock/{{product_id}}/edit', 'stock_set', noun='variant', ids=[('product_id', 'product_id')], body=STOCK_EDIT, required=tuple(STOCK_EDIT))
    add('PUT', f'{P}/stock/threshold', 'stock_threshold_set_global', noun='level', body={'threshold': ('threshold', whole(0, 100000))}, required=('threshold',))
    add('PUT', f'{P}/stock/{{product_id}}/threshold', 'stock_threshold_set_variant', noun='variant', ids=[('product_id', 'product_id')],
        body={'threshold': ('threshold', lambda v: None if v is None else whole(0, 100000)(v))}, required=('threshold',))

    # ------------------------------------------------------------------ employees: the Administrator only, so these routes exist ONLY under /api/admin
    if kind == 'admin':
        add('GET', f'{P}/employees', 'admin_employees', noun='employee', paged=True, query={'q': ('q', search), 'status': ('status', one_of({'active', 'inactive', 'all'}))})
        add('GET', f'{P}/employees/{{employee_id}}', 'admin_employee', noun='employee', ids=[('employee_id', 'employee_id')])
        add('POST', f'{P}/employees', 'admin_employee_create', noun='employee', body=EMPLOYEE_CREATE, required=('name', 'email', 'role', 'password'), created=True)
        add('PATCH', f'{P}/employees/{{employee_id}}', 'admin_employee_update', noun='employee', ids=[('employee_id', 'employee_id')], body=EMPLOYEE_FIELDS)
        add('PUT', f'{P}/employees/{{employee_id}}/role', 'admin_employee_set_role', noun='employee', ids=[('employee_id', 'employee_id')], body=EMPLOYEE_ROLE,
            required=('role',))
        add('POST', f'{P}/employees/{{employee_id}}/reset-password', 'admin_employee_reset_password', noun='employee', ids=[('employee_id', 'employee_id')],
            body=EMPLOYEE_PASSWORD, required=('password',))
        add('POST', f'{P}/employees/{{employee_id}}/deactivate', 'admin_employee_deactivate', noun='employee', ids=[('employee_id', 'employee_id')])
        add('POST', f'{P}/employees/{{employee_id}}/reactivate', 'admin_employee_reactivate', noun='employee', ids=[('employee_id', 'employee_id')])
        # customers (step 7d): read, edit name / email / phone, deactivate, reactivate. No password field exists on any of them.
        add('GET', f'{P}/customers', 'admin_customers', noun='customer', paged=True, query={'q': ('q', search), 'status': ('status', one_of({'active', 'inactive', 'all'}))})
        add('GET', f'{P}/customers/{{customer_id}}', 'admin_customer', noun='customer', ids=[('customer_id', 'customer_id')])
        add('PATCH', f'{P}/customers/{{customer_id}}', 'admin_customer_update', noun='customer', ids=[('customer_id', 'customer_id')], body=CUSTOMER_FIELDS)
        add('POST', f'{P}/customers/{{customer_id}}/deactivate', 'admin_customer_deactivate', noun='customer', ids=[('customer_id', 'customer_id')])
        add('POST', f'{P}/customers/{{customer_id}}/reactivate', 'admin_customer_reactivate', noun='customer', ids=[('customer_id', 'customer_id')])
        # DSS (B8 S4c): read-only views of one run (the given `run`, or the latest of `kind`: real by default), plus Run now. Import is not here.
        add_dss = functools.partial(add, digits=DSS_DIGITS)
        run_pick = {'run': ('run_id', id_param), 'kind': ('kind', one_of(DSS_KINDS))}
        add_dss('GET', f'{P}/dss/overview', 'admin_dss_overview', noun='DSS run')
        add_dss('GET', f'{P}/dss/runs', 'admin_dss_runs', noun='DSS run', paged=True,
            query={'kind': ('kind', one_of(DSS_KINDS | {'all'})), 'state': ('state', one_of({'done', 'failed', 'all'}))})
        add_dss('GET', f'{P}/dss/runs/{{run_id}}', 'admin_dss_run', noun='DSS run', ids=[('run_id', 'run_id')])
        add_dss('GET', f'{P}/dss/forecast/keys', 'admin_dss_forecast_keys', noun='DSS run', query={**run_pick, 'level': ('level', one_of(DSS_LEVELS))})
        add_dss('GET', f'{P}/dss/forecast', 'admin_dss_forecast', noun='DSS run', query={**run_pick, 'level': ('level', one_of(DSS_LEVELS)), 'key': ('key', search)})
        add_dss('GET', f'{P}/dss/backtest', 'admin_dss_backtest', noun='DSS run', paged=True, query={
            **run_pick, 'level': ('level', one_of(DSS_LEVELS)), 'key': ('key', search), 'policy': ('policy', one_of(DSS_POLICIES)),
            'horizon': ('horizon', one_of(DSS_HORIZONS)), 'weeks': ('weeks', one_of({'all', 'uncensored'})), 'chosen': ('chosen', flag)})
        add_dss('GET', f'{P}/dss/restock', 'admin_dss_restock', noun='DSS run', paged=True, query={
            **run_pick, 'urgency': ('urgency', one_of(DSS_URGENCY | {'all'})), 'garmentType': ('garment_type', search),
            'supplierId': ('supplier_id', id_param), 'q': ('q', search)})
        add_dss('GET', f'{P}/dss/segments', 'admin_dss_segments', noun='DSS run', paged=True, query={
            **run_pick, 'segment': ('segment', one_of(DSS_SEGMENTS)), 'sort': ('sort', one_of({'monetary', 'recency', 'frequency'}))})
        # here `kind` is the ALERT's kind (alerts have no state); the run is the given one or the latest real run
        add_dss('GET', f'{P}/dss/alerts', 'admin_dss_alerts', noun='DSS run', paged=True, query={
            'run': ('run_id', id_param), 'kind': ('kind', one_of(DSS_ALERT_KINDS)), 'severity': ('severity', one_of({'critical', 'warning', 'info'}))})
        add_dss('GET', f'{P}/dss/health', 'admin_dss_health', noun='DSS run', query=run_pick)
        add_dss('POST', f'{P}/dss/run-now', 'admin_dss_run_now', noun='DSS run', status_code=202)
        add_dss('GET', f'{P}/dss/run-now/{{request_id}}', 'admin_dss_run_request', noun='run request', ids=[('request_id', 'request_id')])

    # ------------------------------------------------------------------ the bell
    # the same three routes under both prefixes: the person's OWN rows, whichever door they came through (one account, one set of rows)
    add('GET', f'{P}/notifications', 'staff_notifications', noun='notification', paged=True, query={'unreadOnly': ('unread_only', flag)})
    add('POST', f'{P}/notifications/read-all', 'staff_notifications_read_all', noun='notification')
    add('POST', f'{P}/notifications/{{notification_id}}/read', 'staff_notification_read', noun='notification', ids=[('notification_id', 'notification_id')])
