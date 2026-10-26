"""Step 11: the new order states. A delivered order (step 7 ended there) is closed now; a packed one is back at "received and preparing"
(confirmed), since packed is no longer a step. The states are set by SQL so no date moves (the simulated orders keep their simulated
write_date). A real order (one without the simulation's "Simulated" tag) gets an automatic history line saying why it closed; a simulated
one gets none (the simulation's own checks look for anything stamped with today's clock). The counts before and after are
logged. Run only on clothcraft_dev and clothcraft_shop, after a verified dump; never on clothcraft_sim or the live database.
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)
NOTE = 'Closed when order tracking was introduced (step 11): the order was delivered.'


def counts(cr):
    cr.execute("SELECT coalesce(clothcraft_state, '-'), count(*) FROM sale_order GROUP BY 1 ORDER BY 1")
    return dict(cr.fetchall())


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    before = counts(cr)
    cr.execute("UPDATE sale_order SET clothcraft_state = 'confirmed' WHERE clothcraft_state = 'packed'")
    packed = cr.rowcount
    # a real order is one without the simulation's "Simulated" sale-order tag (an API order placed without an Idempotency-Key has no
    # 'api:' reference, so the reference is not the test)
    cr.execute("""SELECT so.id FROM sale_order so WHERE so.clothcraft_state = 'delivered'
                   AND NOT EXISTS (SELECT 1 FROM sale_order_tag_rel r JOIN crm_tag t ON t.id = r.tag_id
                                    WHERE r.order_id = so.id AND t.name->>'en_US' = 'Simulated')
                   ORDER BY so.id""")
    real = [row[0] for row in cr.fetchall()]
    if real:
        env['clothcraft.order.audit'].create([{'order_id': order_id, 'actor_type': 'automatic', 'from_state': 'delivered', 'to_state': 'closed',
                                                'note': NOTE, 'via': 'cron'} for order_id in real])
    cr.execute("UPDATE sale_order SET clothcraft_state = 'closed' WHERE clothcraft_state = 'delivered'")
    closed = cr.rowcount
    after = counts(cr)
    _logger.info('clothcraft 11a in %s: packed -> confirmed %s, delivered -> closed %s (%s real order(s) with a history line); before %s; after %s',
                 cr.dbname, packed, closed, len(real), before, after)
