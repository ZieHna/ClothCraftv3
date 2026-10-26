import json

from odoo import api, fields, models
from odoo.exceptions import UserError

ACTIONS = [('edited', 'Edited'), ('deactivated', 'Deactivated'), ('reactivated', 'Reactivated')]
# The only things a customer history line may record: never a password, a hash, an address or anything else.
VALUE_KEYS = frozenset({'name', 'email', 'phone', 'active'})


class ClothcraftCustomerAudit(models.Model):
    """Who changed which customer account, when, and how (admin dashboard, step 7d). Append only on three layers, like the employee history:
    the ORM refuses write and unlink, a database trigger refuses UPDATE and DELETE, and only the Administrator group has an access line, for
    reading. Names are copied at the time. Old and new values are kept for name, email, phone and active only (create refuses any other key)."""
    _name = 'clothcraft.customer.audit'
    _description = 'Customer account history'
    _order = 'id desc'

    actor_id = fields.Many2one('res.users', ondelete='set null', index=True)
    actor_name = fields.Char(required=True, help="The Administrator's name at the time.")
    target_id = fields.Many2one('res.users', ondelete='set null', index=True)
    target_name = fields.Char(required=True, help="The customer's name at the time.")
    target_login = fields.Char(help="The customer's sign-in email at the time.")
    action = fields.Selection(ACTIONS, required=True, index=True)
    old_values = fields.Text(help="JSON of the recorded fields before the change.")
    new_values = fields.Text(help="JSON of the recorded fields after the change.")
    via = fields.Selection([('dashboard', 'Admin dashboard'), ('odoo', 'Odoo')], required=True, default='dashboard')
    company_id = fields.Many2one('res.company', required=True, default=lambda self: self.env.company)

    @api.model
    def _clean(self, values):
        if not values:
            return None
        extra = set(values) - VALUE_KEYS
        if extra:
            raise UserError(self.env._("A customer history line cannot record: %s", ', '.join(sorted(extra))))
        return json.dumps(values, sort_keys=True, ensure_ascii=False)

    @api.model
    def _log(self, actor, target, action, old=None, new=None, via='dashboard'):
        """One line. `actor` and `target` are res.users records; the names are copied now."""
        actor, target = actor.sudo(), target.sudo()
        return self.sudo().create({
            'actor_id': actor.id, 'actor_name': actor.partner_id.name or actor.login,
            'target_id': target.id, 'target_name': target.partner_id.name or target.login, 'target_login': target.login,
            'action': action, 'old_values': self._clean(old), 'new_values': self._clean(new), 'via': via,
        })

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            for key in ('old_values', 'new_values'):
                if vals.get(key):
                    try:
                        parsed = json.loads(vals[key])
                    except ValueError:
                        raise UserError(self.env._("Customer history values must be JSON."))
                    if not isinstance(parsed, dict) or set(parsed) - VALUE_KEYS:
                        raise UserError(self.env._("A customer history line records only name, email, phone and active."))
        return super().create(vals_list)

    def write(self, vals):
        raise UserError(self.env._("The customer history cannot be changed."))

    def unlink(self):
        raise UserError(self.env._("The customer history cannot be deleted."))

    def init(self):
        super().init()
        cr = self.env.cr
        cr.execute("""
            CREATE OR REPLACE FUNCTION clothcraft_customer_audit_guard() RETURNS trigger AS $$
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    RAISE EXCEPTION 'The customer history cannot be changed';
                END IF;
                RAISE EXCEPTION 'The customer history cannot be deleted';
            END;
            $$ LANGUAGE plpgsql""")
        cr.execute("DROP TRIGGER IF EXISTS clothcraft_customer_audit_guard ON clothcraft_customer_audit")
        cr.execute("""CREATE TRIGGER clothcraft_customer_audit_guard BEFORE UPDATE OR DELETE ON clothcraft_customer_audit
                      FOR EACH ROW EXECUTE FUNCTION clothcraft_customer_audit_guard()""")
