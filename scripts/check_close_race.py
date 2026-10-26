# Step 11: the customer's "I received my order" and the daily auto-close job at the SAME moment, with two real database connections and
# committed data, so Postgres row locks really meet. Run it on a THROWAWAY copy only (it creates a customer, a staff member and orders,
# and commits them):
#   docker compose run --rm --no-deps -T odoo odoo shell -d clothcraft_e2e --no-http < scripts/check_close_race.py
# Race A: the customer's transaction holds the order row (it has closed it, not yet committed) while the job runs: the job's
#         FOR UPDATE NOWAIT fails, the job skips the order. Expected: one close, one history line, by the customer.
# Race B: the job's transaction holds the row (it has closed it, not yet committed) while the customer presses: the customer's FOR UPDATE
#         waits; once the job commits, the customer finds the order closed and gets the same "ok" (replayed). Expected: one close, one line,
#         automatic.
# The customer's call goes through odoo.service.model.retrying, as every HTTP request to Odoo does (the service reaches the facade through
# /json/2): REPEATABLE READ turns "the row I waited for changed" into a SerializationFailure, and Odoo retries the whole request.
# Prints CHECK lines and a summary; no secret is printed (the passwords made here are random and thrown away).
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


# ---- set up, committed: a product with stock, a customer with a session, an inventory staff member with a session
tag = secrets.token_hex(3)
product = env['product.product'].search([('default_code', '!=', False), ('product_tmpl_id.garment_type_id', '!=', False), ('sale_ok', '=', True),
                                         ('product_tmpl_id.is_published', '=', True)], limit=1)
warehouse = env['stock.warehouse'].search([('company_id', '=', env.company.id)], limit=1)
env['stock.quant']._update_available_quantity(product, warehouse.lot_stock_id, 10)
customer = env['res.users'].create({'name': f'Race customer {tag}', 'login': f'race-{tag}@example.test', 'email': f'race-{tag}@example.test',
                                    'password': secrets.token_urlsafe(24), 'group_ids': [Command.set([env.ref('base.group_portal').id])]})
staff = env['res.users'].create({'name': f'Race staff {tag}', 'login': f'race-staff-{tag}@example.test', 'password': secrets.token_urlsafe(24),
                                 'group_ids': [Command.set([env.ref('base.group_user').id, env.ref('clothcraft.group_inventory').id])]})
now = fields.Datetime.now()
Session = env['clothcraft.api.session'].sudo()
Session.create({'sid_hash': f'race-c-{tag}', 'user_id': customer.id, 'scope': 'customer', 'last_seen': now, 'expires': now + datetime.timedelta(hours=12)})
Session.create({'sid_hash': f'race-s-{tag}', 'user_id': staff.id, 'scope': 'staff', 'last_seen': now, 'expires': now + datetime.timedelta(hours=12)})
api_user = env['res.users'].search([('login', '=', 'api_shop')], limit=1)
facade = env(user=api_user)['clothcraft.api']
delivery = {'name': 'Race Test', 'email': 'race@example.test', 'phone': '0917 123 4567', 'street': '1 Race Street', 'city': 'Quezon City',
            'province': 'PH-00', 'postal_code': '1100', 'note': ''}


def delivered_order():
    quote = facade.quote([{'sku': product.default_code, 'quantity': 1}])
    placed = facade.place_order({'sid_hash': f'race-c-{tag}', 'lines': [{'sku': product.default_code, 'quantity': 1}], 'delivery': dict(delivery),
                                 'payment_method': 'cod', 'quoted_total': quote['amount_total'], 'idempotency_key': None})
    assert placed['status'] == 'created', placed
    order_id = placed['order']['id']
    for to, was in (('shipped', 'confirmed'), ('out_for_delivery', 'shipped'), ('delivered', 'out_for_delivery')):
        moved = facade.staff_transition({'sid_hash': f'race-s-{tag}', 'order_id': order_id, 'to': to, 'expected_state': was, 'note': ''})
        assert moved['status'] == 'done', moved
    return order_id


order_a = delivered_order()           # order B is delivered only after race A: the job closes EVERY delivered order old enough
env.cr.commit()
later = fields.Datetime.now() + datetime.timedelta(days=30)


def closing_lines(order_id):
    with registry.cursor() as cr:
        cr.execute("SELECT actor_type FROM clothcraft_order_audit WHERE order_id = %s AND to_state = 'closed' ORDER BY id", [order_id])
        lines = [r[0] for r in cr.fetchall()]
        cr.execute("SELECT clothcraft_state FROM sale_order WHERE id = %s", [order_id])
        return cr.fetchone()[0], lines


# ---- race A: the customer holds the row while the job runs
holding, job_done = threading.Event(), threading.Event()
out = {}


def customer_a():
    with registry.cursor() as cr:
        e = api.Environment(cr, api_user.id, {})
        # called directly, NOT through retrying: retrying commits when it ends, and this side must hold the row uncommitted
        out['customer'] = e['clothcraft.api'].order_confirm_received({'sid_hash': f'race-c-{tag}', 'order_id': order_a})['status']
        holding.set()                         # closed in this transaction, row still locked
        job_done.wait(30)
        cr.commit()


def job_a():
    holding.wait(30)
    with registry.cursor() as cr:
        e = api.Environment(cr, api.SUPERUSER_ID, {})
        out['job_closed'] = e['sale.order']._cron_clothcraft_auto_close(now=later)
        cr.commit()
    job_done.set()


threads = [threading.Thread(target=customer_a), threading.Thread(target=job_a)]
[t.start() for t in threads]
[t.join(60) for t in threads]
state, lines = closing_lines(order_a)
check('race A: the customer closed it while holding the row', out.get('customer') == 'ok', str(out))
check('race A: the job, meeting the locked row (the only delivered order), closed nothing: it skipped it, it did not fail', out.get('job_closed') == 0, str(out))
check('race A: the order is closed once, by the customer', state == 'closed' and lines == ['customer'], f'{state} {lines}')

# ---- race B: the job holds the row while the customer presses
order_b = delivered_order()
env.cr.commit()
holding_b, released_b = threading.Event(), threading.Event()
out_b = {}


def job_b():
    with registry.cursor() as cr:
        e = api.Environment(cr, api.SUPERUSER_ID, {})
        out_b['job_closed'] = e['sale.order']._cron_clothcraft_auto_close(now=later)
        holding_b.set()                       # closed in this transaction, row still locked
        released_b.wait(30)
        cr.commit()


def customer_b():
    holding_b.wait(30)
    with registry.cursor() as cr:
        e = api.Environment(cr, api_user.id, {})
        started = time.monotonic()
        tries = []

        def press():
            tries.append(1)
            return e['clothcraft.api'].order_confirm_received({'sid_hash': f'race-c-{tag}', 'order_id': order_b})

        answer = retrying(press, e)
        out_b['attempts'] = len(tries)
        out_b['waited'] = round(time.monotonic() - started, 2)
        out_b['customer'] = (answer['status'], answer.get('replayed'))
        cr.commit()


tb = [threading.Thread(target=job_b), threading.Thread(target=customer_b)]
[t.start() for t in tb]
holding_b.wait(30)
time.sleep(1.5)
check('race B: while the job holds the row, the customer waits (has no answer yet)', 'customer' not in out_b, str(out_b))
released_b.set()
[t.join(60) for t in tb]
state_b, lines_b = closing_lines(order_b)
check('race B: the job closed exactly one order (this one)', out_b.get('job_closed') == 1, str(out_b))
check('race B: the customer then got the same "ok", as already closed', out_b.get('customer') == ('ok', True), str(out_b))
check('race B: the customer really waited for the lock (at least 1 s)', out_b.get('waited', 0) >= 1.0, str(out_b))
check("race B: the first attempt met the job's commit (serialization failure) and Odoo's request retry answered it", out_b.get('attempts', 0) >= 2, str(out_b))
check('race B: the order is closed once, automatically', state_b == 'closed' and lines_b == ['automatic'], f'{state_b} {lines_b}')

print(f'SUMMARY {sum(results)} of {len(results)} checks passed')
