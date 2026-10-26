import json

from odoo import api, fields, models
from odoo.exceptions import UserError

ACTIONS = [
    ('created', 'Created'), ('edited', 'Edited'), ('role_changed', 'Role changed'), ('password_reset', 'Password reset'),
    ('deactivated', 'Deactivated'), ('reactivated', 'Reactivated'),
]
# The only things an audit line may record: never a password, a hash, a token or anything else secret.
VALUE_KEYS = frozenset({'name', 'email', 'job_title', 'phone', 'role', 'active'})


class ClothcraftEmployeeAudit(models.Model):
    """Who changed which employee account, when, and how (admin dashboard, step 7c). Append only, on three layers, like the order history: the
    ORM refuses write and unlink, a database trigger refuses UPDATE and DELETE, and only the Administrator group has an access line, for
    reading. The names are copied at the time, so a later rename or removal never changes a line.

    A line carries old and new values for NON-SECRET fields only (VALUE_KEYS): create() refuses any other key, and a password reset
    carries no values at all (a CHECK says so too)."""
    _name = 'clothcraft.employee.audit'
    _description = 'Employee account history'
    _order = 'id desc'

    actor_id = fields.Many2one('res.users', ondelete='set null', index=True)
    actor_name = fields.Char(required=True, help="The Administrator's name at the time.")
    target_id = fields.Many2one('res.users', ondelete='set null', index=True)
    target_name = fields.Char(required=True, help="The employee's name at the time.")
    target_login = fields.Char(help="The employee's sign-in email at the time.")
    action = fields.Selection(ACTIONS, required=True, index=True)
    old_values = fields.Text(help="JSON of the non-secret fields before the change.")
    new_values = fields.Text(help="JSON of the non-secret fields after the change.")
    via = fields.Selection([('dashboard', 'Admin dashboard'), ('odoo', 'Odoo')], required=True, default='dashboard')
    company_id = fields.Many2one('res.company', required=True, default=lambda self: self.env.company)

    _no_secret_on_reset = models.Constraint(
        "CHECK(action <> 'password_reset' OR (old_values IS NULL AND new_values IS NULL))", 'A password reset records no values.')

    @api.model
    def _clean(self, values):
        """JSON text of `values` (only the allowed keys), or None for nothing to record."""
        if not values:
            return None
        extra = set(values) - VALUE_KEYS
        if extra:
            raise UserError(self.env._("An employee history line cannot record: %s", ', '.join(sorted(extra))))
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
            if vals.get('action') == 'password_reset' and (vals.get('old_values') or vals.get('new_values')):
                raise UserError(self.env._("A password reset records no values."))
            for key in ('old_values', 'new_values'):
                if vals.get(key):
                    try:
                        parsed = json.loads(vals[key])
                    except ValueError:
                        raise UserError(self.env._("Employee history values must be JSON."))
                    if not isinstance(parsed, dict) or set(parsed) - VALUE_KEYS:
                        raise UserError(self.env._("An employee history line records only name, email, job title, phone, role and active."))
        return super().create(vals_list)

    def write(self, vals):
        raise UserError(self.env._("The employee history cannot be changed."))

    def unlink(self):
        raise UserError(self.env._("The employee history cannot be deleted."))

    def init(self):
        super().init()
        cr = self.env.cr
        cr.execute("""
            CREATE OR REPLACE FUNCTION clothcraft_employee_audit_guard() RETURNS trigger AS $$
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    RAISE EXCEPTION 'The employee history cannot be changed';
                END IF;
                RAISE EXCEPTION 'The employee history cannot be deleted';
            END;
            $$ LANGUAGE plpgsql""")
        cr.execute("DROP TRIGGER IF EXISTS clothcraft_employee_audit_guard ON clothcraft_employee_audit")
        cr.execute("""CREATE TRIGGER clothcraft_employee_audit_guard BEFORE UPDATE OR DELETE ON clothcraft_employee_audit
                      FOR EACH ROW EXECUTE FUNCTION clothcraft_employee_audit_guard()""")
