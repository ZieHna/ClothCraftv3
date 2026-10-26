"""Step 12: the customer's saved cart. The two tables (clothcraft_cart, clothcraft_cart_line), the expiry job and the setting arrive with
the module update; no data is moved: a customer's browser cart reaches the server only when that customer next signs in (the shop
merges it then). This only logs what is there. Run only on clothcraft_dev and clothcraft_shop, after a verified dump.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    cr.execute("SELECT count(*) FROM clothcraft_cart")
    carts = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM clothcraft_cart_line")
    lines = cr.fetchone()[0]
    cr.execute("SELECT count(*) FROM sale_order")
    orders = cr.fetchone()[0]
    _logger.info('clothcraft 12a in %s: saved carts %s, cart lines %s (orders untouched: %s)', cr.dbname, carts, lines, orders)
