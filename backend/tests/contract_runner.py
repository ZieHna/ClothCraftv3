"""Reads the shared API contract cases in /contract (see contract/README.md) and checks responses against them.

frontend/src/test/contractRunner.ts reads the same cases for the mock. Keep the two interpreters in step: every `op`,
every step kind and every {{expression}} below exists there too.
"""
import json
import os
import random
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(os.environ.get('CONTRACT_DIR', Path(__file__).resolve().parents[2] / 'contract'))
SHAPES = json.loads((ROOT / 'shapes.json').read_text(encoding='utf-8'))
DELIVERY_FIXTURE = json.loads((ROOT / 'delivery-validation.json').read_text(encoding='utf-8'))
CASE_FILES = [(p.name, json.loads(p.read_text(encoding='utf-8'))) for p in sorted((ROOT / 'cases').glob('*.json'))]
# Cases for the REAL service only (step 9: customized garments, which the frozen mock does not have). Only this runner reads them; they use
# only the ops and steps above, so they could move to cases/ unchanged if the mock ever learns designs.
REAL_ONLY_FILES = [(f'real-only/{p.name}', json.loads(p.read_text(encoding='utf-8'))) for p in sorted((ROOT / 'real-only').glob('*.json'))]


def round2(x):
    return round(x * 100) / 100


# ---------------------------------------------------------------- {{variables}}
def _evaluate(expr, variables):
    x = re.fullmatch(r'x(\d+)', expr.strip())
    if x:
        return 'x' * int(x.group(1))
    m = re.fullmatch(r'(\w+)(?:([+*-])(\d+))?', expr.strip())
    if not m or m.group(1) not in variables:
        raise KeyError(f'contract: unknown variable in {{{{{expr}}}}}')
    value = variables[m.group(1)]
    if not m.group(2):
        return value
    n = int(m.group(3))
    return value + n if m.group(2) == '+' else value - n if m.group(2) == '-' else round2(value * n)


def fill(value, variables):
    if isinstance(value, str):
        whole = re.fullmatch(r'\{\{(.+)\}\}', value)
        if whole:
            return _evaluate(whole.group(1), variables)
        return re.sub(r'\{\{(.+?)\}\}', lambda m: str(_evaluate(m.group(1), variables)), value)
    if isinstance(value, list):
        return [fill(v, variables) for v in value]
    if isinstance(value, dict):
        return {k: fill(v, variables) for k, v in value.items()}
    return value


# ---------------------------------------------------------------- paths
def _walk(value, steps):
    if not steps:
        return value
    head, rest = steps[0], steps[1:]
    if head == '*':
        return [_walk(item, rest) for item in value]
    if value is None:
        return None
    if head.isdigit():
        return _walk(value[int(head)], rest)
    return _walk(value.get(head), rest)


def read(root, path):
    fn = re.fullmatch(r'(len|sum|min|max):(.*)', path)
    if fn:
        inner = read(root, fn.group(2))
        if fn.group(1) == 'len':
            return len(inner)
        return {'sum': lambda v: round2(sum(v)), 'min': min, 'max': max}[fn.group(1)](inner)
    steps = [s for s in re.sub(r'\[(\*|\d+)\]', r'.\1', path).split('.') if s]
    return _walk(root, steps)


def same(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        return a == b
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


# ---------------------------------------------------------------- shapes
def check_shape(template, value, at='$'):
    if isinstance(template, str):
        return _check_leaf(template, value, at)
    if isinstance(template, list):
        if not isinstance(value, list):
            return [f'{at}: expected an array']
        return [e for i, item in enumerate(value) for e in check_shape(template[0], item, f'{at}[{i}]')]
    if '$ref' in template:
        return check_shape(SHAPES[template['$ref']], value, at)
    if '$oneOf' in template:
        return [] if any(not check_shape(o, value, at) for o in template['$oneOf']) else [f'{at}: matches none of the allowed shapes']
    if not isinstance(value, dict):
        return [f'{at}: expected an object']
    if '$map' in template:
        return [e for k, v in value.items() for e in check_shape(template['$map'], v, f'{at}.{k}')]
    errors = []
    for key, sub in template.items():
        errors += [f'{at}.{key}: missing'] if key not in value else check_shape(sub, value[key], f'{at}.{key}')
    errors += [f'{at}.{key}: not in the contract' for key in value if key not in template]
    return errors


def _kind(value):
    return 'null' if value is None else 'boolean' if isinstance(value, bool) else 'number' if isinstance(value, (int, float)) else 'string' if isinstance(value, str) else type(value).__name__


def _check_leaf(spec, value, at):
    if spec.startswith('enum:'):
        return [] if str(value) in spec[5:].split('|') else [f'{at}: {value!r} is not one of {spec[5:]}']
    types = spec.split('|')
    return [] if _kind(value) in types or 'any' in types else [f'{at}: expected {spec}, got {_kind(value)}']


# ---------------------------------------------------------------- asserts
def _each(values, is_, expected):
    tests = {
        'eq': lambda v: same(v, expected), 'ne': lambda v: not same(v, expected),
        'gte': lambda v: v >= expected, 'lte': lambda v: v <= expected,
        'containsI': lambda v: str(expected).lower() in str(v).lower(),
    }
    return all(tests[is_](v) for v in values)


def check_assert(a, body, headers=None):
    op, path = a['op'], a.get('path')
    headers = headers or {}
    where = f' ({path or op})'
    if op == 'eq':
        got = read(body, path)
        return None if same(got, a['value']) else f'expected {a["value"]!r}, got {got!r}{where}'
    if op == 'eqPath':
        got, other = read(body, path), read(body, a['other'])
        return None if same(got, other) else f'{got!r} differs from {a["other"]} = {other!r}{where}'
    if op == 'gt':
        return None if read(body, path) > a['value'] else f'expected more than {a["value"]}, got {read(body, path)!r}{where}'
    if op == 'lte':
        return None if read(body, path) <= a['value'] else f'expected at most {a["value"]}, got {read(body, path)!r}{where}'
    if op == 'each':
        return None if _each(read(body, path), a['is'], a['value']) else f'not every value is {a["is"]} {a["value"]!r}: {read(body, path)!r}{where}'
    if op == 'unique':
        v = read(body, path)
        return None if len(set(v)) == len(v) else f'values repeat{where}'
    if op == 'countEq':
        n = sum(1 for v in read(body, path) if same(v, a['value']))
        return None if n == a['count'] else f'{n} value(s) equal {a["value"]!r}, expected {a["count"]}{where}'
    if op == 'absent':
        return f'{a["value"]!r} appears in the response' if a['value'] in json.dumps(body) else None
    if op == 'header':
        got = headers.get(a['name'].lower())
        return None if got is not None and re.search(a['matches'], got) else f'header {a["name"]} is {got!r}, expected to match {a["matches"]}'
    if op == 'matches':
        return None if re.search(a['value'], str(read(body, path))) else f'{read(body, path)!r} does not match {a["value"]}{where}'
    if op == 'startsWith':
        return None if str(read(body, path)).startswith(a['value']) else f'{read(body, path)!r} does not start with {a["value"]!r}{where}'
    if op == 'endsWith':
        return None if str(read(body, path)).endswith(a['value']) else f'{read(body, path)!r} does not end with {a["value"]!r}{where}'
    if op == 'eachSum':
        items = read(body, a['items'])
        bad = [i for i in items if round2(sum(read(i, p[2:]) if p.startswith('$.') else read(body, p) for p in a['parts'])) != i[a['field']]]
        return None if not bad else f'{len(bad)} item(s) where {a["field"]} is not the sum of {a["parts"]}'
    if op == 'vatOf':
        total, rate, vat = read(body, a['total']), read(body, a['rate']), read(body, a['vat'])
        expected = round2(total * rate / (100 + rate))
        return None if abs(vat - expected) < 0.005 else f'vat {vat} is not {expected} ({rate}% of {total}, included, rounded once)'
    if op == 'statusFollowsStock':
        bad = [i for i in read(body, a['items']) if i['status'] != ('out_of_stock' if i['stock'] <= 0 else 'low_stock' if i['stock'] <= 2 else 'in_stock')]
        return None if not bad else f'{len(bad)} item(s) whose status does not follow the stock (low stock is 2 or fewer)'
    raise ValueError(f'contract: unknown op {op}')


# ---------------------------------------------------------------- running a case
CONTRACT_PASSWORD = 'a long contract password'


def _expect(step, status, body, headers, variables):
    text = json.dumps(body)[:400]
    if step.get('status') is not None and status != step['status']:
        raise AssertionError(f'status {status}, expected {step["status"]}: {text}')
    if 'shape' in step:
        errors = check_shape(step['shape'], body)
        if errors:
            raise AssertionError(f'shape: {"; ".join(errors[:5])} | {text}')
    for a in step.get('asserts', []):
        failure = check_assert(fill(a, variables), body, headers)
        if failure:
            raise AssertionError(f'{failure} | {json.dumps(a)} | {text}')


def _remember(save, body, variables):
    for name, path in (save or {}).items():
        variables[name] = read(body, path)


def _random_address():
    return f'10.{random.randint(1, 250)}.{random.randint(1, 250)}.{random.randint(1, 250)}'


def run_case(case, base_variables, send):
    """Run one case against any server. `send(method, path, query, body, headers, jar) -> (status, body, headers)`; the jar is one
    client's credentials, kept by the transport (a cookie against the service). Raises on the first failure."""
    variables = {**base_variables, 'contractPassword': CONTRACT_PASSWORD}
    for key in case.get('keys', []):
        variables[key] = f'{key}-{uuid.uuid4()}'
    jars, snapshots = {}, {}

    def jar_of(name):
        return jars.setdefault(name or '', {'__ip': _random_address()})

    def request(step):
        return send(step['method'], fill(step['path'], variables), fill(step['query'], variables) if 'query' in step else None,
                    fill(step['body'], variables) if 'body' in step else None, fill(step.get('headers', {}), variables), jar_of(step.get('as', case.get('as'))))

    for name in case.get('customers', []):
        email = f'{name}-{uuid.uuid4()}@example.test'.lower()
        status, body, _headers = send('POST', '/api/auth/register', None, {'name': f'Contract {name}', 'email': email, 'password': CONTRACT_PASSWORD}, {}, jar_of(name))
        if status != 201:
            raise AssertionError(f'could not register the customer "{name}": {status} {json.dumps(body)[:200]}')
        variables.update({f'{name}Email': email, f'{name}Password': CONTRACT_PASSWORD, f'{name}Id': read(body, 'data.user.id')})

    for step in case.get('steps', [case]):
        if 'parallel' in step:
            with ThreadPoolExecutor(max_workers=len(step['parallel'])) as pool:
                results = list(pool.map(lambda s: request({**s, 'as': s.get('as', case.get('as'))}), step['parallel']))
            statuses = sorted(status for status, _body, _headers in results)
            if statuses != sorted(step['statuses']):
                raise AssertionError(f'parallel statuses {statuses}, expected {step["statuses"]}: {json.dumps([b for _, b, _ in results])[:500]}')
            combined = {'results': [{'status': s, 'body': b} for s, b, _h in results]}
            for a in step.get('asserts', []):
                failure = check_assert(fill(a, variables), combined)
                if failure:
                    raise AssertionError(f'{failure} | {json.dumps(a)}')
            _remember(step.get('save'), combined, variables)
        elif 'snapshot' in step:
            snapshots[step['snapshot']] = dict(jar_of(step.get('as', case.get('as'))))
        elif 'restore' in step:
            jar = jar_of(step.get('as', case.get('as')))
            for k in [k for k in jar if k != '__ip']:
                del jar[k]
            jar.update(snapshots[step['restore']])
        else:
            for _ in range(step.get('repeat', 1)):
                status, body, headers = request(step)
                _expect(step, status, body, headers, variables)
                _remember(step.get('save'), body, variables)


def discover(get):
    """Everything the cases need from the live data, found the same way against any server (see contract/README.md)."""
    listing = get('/api/catalogue/products')
    valid = DELIVERY_FIXTURE['valid']
    variables = {'firstProductId': listing['data']['products'][0]['id'], 'validDelivery': valid, 'badDelivery': {**valid, 'email': 'nope', 'postalCode': '11'}}
    in_stock = []
    for product in listing['data']['products']:
        for v in get(f'/api/catalogue/products/{product["id"]}')['data']['variants']:
            if v['stock'] == 0 and 'soldOutSku' not in variables:
                variables['soldOutSku'] = v['sku']
            if 2 <= v['stock'] <= 90:
                in_stock.append({'sku': v['sku'], 'id': product['id'], 'price': v['price'], 'stock': v['stock']})
    if 'soldOutSku' not in variables or len(in_stock) < 12:
        raise RuntimeError('contract: the data needs a sold-out variant and at least 12 variants with 2 to 90 in stock')
    first = in_stock[0]
    variables.update(inStockSku=first['sku'], inStockProductId=first['id'], inStockPrice=first['price'], inStockAvailable=first['stock'], otherInStockSku=in_stock[1]['sku'])
    for n, v in enumerate(in_stock[2:9], start=1):
        variables.update({f'orderSku{n}': v['sku'], f'orderSku{n}Price': v['price'], f'orderSku{n}Avail': v['stock'],
                          f'orderSku{n}PriceMore': round2(v['price'] * (v['stock'] + 1))})
    race = in_stock[9]
    variables.update(raceSku=race['sku'], raceAvail=race['stock'], racePriceAll=round2(race['price'] * race['stock']))
    for n, v in enumerate(in_stock[10:12], start=1):
        variables.update({f'isoSku{n}': v['sku'], f'isoSku{n}Price': v['price']})
    for n, v in enumerate(in_stock[12:20], start=1):     # the staff cases: one variant each, so none depends on another's stock
        variables.update({f'staffSku{n}': v['sku'], f'staffSku{n}Price': v['price'], f'staffSku{n}Avail': v['stock']})
    return variables
