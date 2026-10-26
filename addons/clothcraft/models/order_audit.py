from odoo import api, fields, models
from odoo.exceptions import UserError

# step 11: out_for_delivery and closed are new; packed is no longer reached (it folds into "received and preparing") but stays so the
# history of an order packed before step 11 still reads
STATES = [
    ('awaiting_payment', 'Awaiting payment'), ('confirmed', 'Confirmed'), ('packed', 'Packed'),
    ('shipped', 'Shipped'), ('out_for_delivery', 'Out for delivery'), ('delivered', 'Delivered'), ('closed', 'Closed'),
    ('cancelled', 'Cancelled'),
]
ACTORS = [('staff', 'Staff'), ('customer', 'Customer'), ('automatic', 'Automatic'), ('odoo', 'Odoo')]


class ClothcraftOrderAudit(models.Model):
    """Who moved which order from which state to which, and when. Append only, on three layers: the ORM refuses write and unlink,
    a database trigger refuses UPDATE and DELETE (a row can go only with its order, which the simulation purge needs), and no group
    has an access line for anything but reading.

    Step 11: a line names WHO by kind (`actor_type`): a staff member (staff_id, staff_name), the customer who owns the order (partner_id,
    partner_name), the automatic close, or a change made in the Odoo screens. The database keeps the kinds apart, so a customer is never
    written down as a staff member nor the other way round."""
    _name = 'clothcraft.order.audit'
    _description = 'Order status history'
    _order = 'id'

    order_id = fields.Many2one('sale.order', required=True, index=True, ondelete='cascade')
    actor_type = fields.Selection(ACTORS, string="Done by", required=True, default='staff')
    staff_id = fields.Many2one('res.users', ondelete='set null')
    staff_name = fields.Char(help="The staff member's name at the time: it stays when the account is renamed or removed.")
    partner_id = fields.Many2one('res.partner', string="Customer", ondelete='restrict')
    partner_name = fields.Char(string="Customer name", help="The customer's name at the time.")
    from_state = fields.Selection(STATES, required=True)
    to_state = fields.Selection(STATES, required=True)
    step_back = fields.Boolean(help="An Administrator stepped the order back one step (with a note).")
    note = fields.Text()
    via = fields.Selection([('dashboard', 'Staff dashboard'), ('odoo', 'Odoo'), ('shop', 'Shop'), ('cron', 'Daily job')], required=True, default='dashboard')

    _actor_staff = models.Constraint(
        "CHECK(actor_type <> 'staff' OR (partner_id IS NULL AND staff_name IS NOT NULL))", 'A staff line names a staff member and no customer.')
    _actor_customer = models.Constraint(
        "CHECK(actor_type <> 'customer' OR (partner_id IS NOT NULL AND staff_id IS NULL AND staff_name IS NULL))", 'A customer line names the customer and no staff member.')
    _actor_automatic = models.Constraint(
        "CHECK(actor_type <> 'automatic' OR (partner_id IS NULL AND staff_id IS NULL AND staff_name IS NULL))", 'An automatic line names nobody.')

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('actor_type', 'staff') in ('staff', 'odoo') and not vals.get('staff_name'):
                raise UserError(self.env._("A history line made by staff or in Odoo must name who made it."))
        return super().create(vals_list)

    def write(self, vals):
        raise UserError(self.env._("The order status history cannot be changed."))

    def unlink(self):
        raise UserError(self.env._("The order status history cannot be deleted."))

    def init(self):
        super().init()
        cr = self.env.cr
        cr.execute("""
            CREATE OR REPLACE FUNCTION clothcraft_order_audit_guard() RETURNS trigger AS $$
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    RAISE EXCEPTION 'The order status history cannot be changed';
                END IF;
                -- a row may go only when its order is already gone (a purge or a cascade), never while the order exists
                IF EXISTS (SELECT 1 FROM sale_order WHERE id = OLD.order_id) THEN
                    RAISE EXCEPTION 'The order status history cannot be deleted';
                END IF;
                RETURN OLD;
            END;
            $$ LANGUAGE plpgsql""")
        cr.execute("DROP TRIGGER IF EXISTS clothcraft_order_audit_guard ON clothcraft_order_audit")
        cr.execute("""CREATE TRIGGER clothcraft_order_audit_guard BEFORE UPDATE OR DELETE ON clothcraft_order_audit
                      FOR EACH ROW EXECUTE FUNCTION clothcraft_order_audit_guard()""")
