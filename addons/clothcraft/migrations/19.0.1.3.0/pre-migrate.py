"""Step 11, before the models load: the order history gets an actor type and a step-back flag.

The history is append only: a trigger refuses every UPDATE. Odoo, adding a column with a default, would fill the existing rows with an
UPDATE and fail on that trigger, so the columns are added here by SQL with their default (ADD COLUMN ... DEFAULT fills them without an
UPDATE, so no row trigger runs). The only rows that need another value are the ones written by the Odoo screens (via = 'odoo'): for them,
and only if there are any, the trigger is set aside for that one statement inside this transaction. Run only on clothcraft_dev and
clothcraft_shop.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    cr.execute("SELECT to_regclass('clothcraft_order_audit')")
    if not cr.fetchone()[0]:
        return
    cr.execute("ALTER TABLE clothcraft_order_audit ADD COLUMN IF NOT EXISTS actor_type varchar NOT NULL DEFAULT 'staff'")
    cr.execute("ALTER TABLE clothcraft_order_audit ADD COLUMN IF NOT EXISTS step_back boolean DEFAULT false")
    cr.execute("SELECT count(*) FROM clothcraft_order_audit WHERE via = 'odoo' AND actor_type <> 'odoo'")
    odoo_lines = cr.fetchone()[0]
    if odoo_lines:
        cr.execute("ALTER TABLE clothcraft_order_audit DISABLE TRIGGER clothcraft_order_audit_guard")
        cr.execute("UPDATE clothcraft_order_audit SET actor_type = 'odoo' WHERE via = 'odoo'")
        cr.execute("ALTER TABLE clothcraft_order_audit ENABLE TRIGGER clothcraft_order_audit_guard")
    cr.execute("SELECT count(*) FROM clothcraft_order_audit")
    _logger.info('clothcraft 11a: history actor type added in %s (%s line(s), %s from the Odoo screens)', cr.dbname, cr.fetchone()[0], odoo_lines)
