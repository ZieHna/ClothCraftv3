# Step 12: two writes of the same customer's saved cart at the SAME moment, both based on the same version, with two real database
# connections and committed data, so the cart row lock (cart_put's SELECT ... FOR UPDATE) really meets. Run it on a THROWAWAY copy only
# (it creates a customer and commits):
#   docker compose run --rm --no-deps -T odoo odoo shell -d clothcraft_e2e --no-http < scripts/check_cart_race.py
# Write A holds the cart row (its write is done, not committed) while write B, based on the same version, arrives: B waits for the lock;
# once A commits, B's first attempt fails as a serialization error (Odoo's REPEATABLE READ) and Odoo's own request retry
# (odoo.service.model.retrying, which every HTTP request to Odoo goes through) runs B again: it now sees A's version and answers
# "conflict" with A's cart. Expected: one write wins, the cart is A's, version 1, and nothing of B is half-written.
# A second race: two writes that end at the SAME cart: the second is not a conflict but "ok, replayed".
# Prints CHECK lines and a summary; no secret is printed (the password made here is random and thrown away).
import datetime
import secrets
import threading
import time

from odoo import Command, api, fields
from odoo.service.model import retrying

if not env.cr.dbname.startswith(('clothcraft_e2e', 'clothcraft_ctest', 'clothcraft_test', 'clothcraft_throwaway')):
    raise SystemExit(f'refusing to run against {env.cr.dbname}: throwaway copies only')

registry = env.registry
results = []


def check(name, ok, detail=''):
    results.append(ok)
    print(f"CHECK {'ok  ' if ok else 'FAIL'} {name}{(' | ' + detail) if detail and not ok else ''}")


tag = secrets.token_hex(3)
variants = env['product.product'].search([('default_code', '!=', False), ('product_tmpl_id.garment_type_id', '!=', False), ('sale_ok', '=', True)], limit=2)
customer = env['res.users'].create({'name': f'Cart race {tag}', 'login': f'cart-race-{tag}@example.test', 'email': f'cart-race-{tag}@example.test',
                                    'password': secrets.token_urlsafe(24), 'group_ids': [Command.set([env.ref('base.group_portal').id])]})
now = fields.Datetime.now()
sid = f'cart-race-{tag}'
env['clothcraft.api.session'].sudo().create({'sid_hash': sid, 'user_id': customer.id, 'scope': 'customer', 'last_seen': now, 'expires': now + datetime.timedelta(hours=12)})
api_user = env['res.users'].search([('login', '=', 'api_shop')], limit=1)
env.cr.commit()
A = [{'sku': variants[0].default_code, 'quantity': 2, 'selected': True}]
B = [{'sku': variants[1].default_code, 'quantity': 5, 'selected': False}]


def cart_now():
    with registry.cursor() as cr:
        e = api.Environment(cr, api_user.id, {})
        return e['clothcraft.api'].cart_get({'sid_hash': sid})['cart']


def race(first_lines, second_lines, base):
    holding, release = threading.Event(), threading.Event()
    out = {}

    def first():
        with registry.cursor() as cr:
            e = api.Environment(cr, api_user.id, {})
            # called directly, NOT through retrying: retrying commits when it ends, and this side must hold the row uncommitted
            out['first'] = e['clothcraft.api'].cart_put({'sid_hash': sid, 'base_version': base, 'lines': first_lines})['status']
            holding.set()                       # written in this transaction, the cart row still locked
            release.wait(30)
            cr.commit()

    def second():
        holding.wait(30)
        with registry.cursor() as cr:
            e = api.Environment(cr, api_user.id, {})
            tries = []

            def put():
                tries.append(1)
                return e['clothcraft.api'].cart_put({'sid_hash': sid, 'base_version': base, 'lines': second_lines})

            started = time.monotonic()
            answer = retrying(put, e)
            out['waited'] = round(time.monotonic() - started, 2)
            out['second'] = answer['status']
            out['second_replayed'] = answer.get('replayed')
            out['second_cart_version'] = answer['cart']['version']
            out['attempts'] = len(tries)
            cr.commit()

    threads = [threading.Thread(target=first), threading.Thread(target=second)]
    [t.start() for t in threads]
    holding.wait(30)
    time.sleep(1.5)
    out['second_answered_while_locked'] = 'second' in out
    release.set()
    [t.join(60) for t in threads]
    return out


# ---- race 1: two different carts, both based on version 0
one = race(A, B, 0)
after = cart_now()
check('race 1: the first write went through', one.get('first') == 'ok', str(one))
check('race 1: while the first holds the cart row, the second waits (no answer yet)', one.get('second_answered_while_locked') is False, str(one))
check('race 1: the second really waited for the lock (at least 1 s)', one.get('waited', 0) >= 1.0, str(one))
check('race 1: the second is a conflict, answered with the first\'s cart (version 1)', one.get('second') == 'conflict' and one.get('second_cart_version') == 1, str(one))
check('race 1: its first attempt met the first write\'s commit and Odoo\'s request retry answered it', one.get('attempts', 0) >= 2, str(one))
check('race 1: the cart is exactly the first write: version 1, nothing of the second', after['version'] == 1 and [(l['sku'], l['quantity']) for l in after['lines']] == [(A[0]['sku'], 2)], str(after))

# ---- race 2: two writes that end at the same cart, both based on the version they saw (1)
two = race(B, B, 1)
after = cart_now()
check('race 2: the same cart written twice at once: the second is "ok, replayed", not a conflict', two.get('first') == 'ok' and two.get('second') == 'ok' and two.get('second_replayed') is True, str(two))
check('race 2: one new version only (2), holding B', after['version'] == 2 and [(l['sku'], l['quantity']) for l in after['lines']] == [(B[0]['sku'], 5)], str(after))

print(f'SUMMARY {sum(results)} of {len(results)} checks passed')
