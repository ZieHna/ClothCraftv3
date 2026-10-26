import logging

from odoo import models

_logger = logging.getLogger(__name__)


class ResUsers(models.Model):
    _inherit = 'res.users'

    def _notify_security_setting_update(self, *args, **kwargs):
        """Odoo mails a person "your password / login / email was changed" whenever one of them is written. An Administrator's employee
        management (models/api_employee.py) sets clothcraft_no_security_mail so it sends no mail at all; every other change behaves as before."""
        if self.env.context.get('clothcraft_no_security_mail'):
            return None
        return super()._notify_security_setting_update(*args, **kwargs)

    def init(self):
        """Odoo's login uniqueness is UNIQUE (login, website_id), and NULLs never collide: users with no website (every customer made
        by clothcraft.api.auth_register, and every simulated customer) could share a login. This index closes that. It is a backstop
        behind the advisory lock in auth_register; if a database already holds duplicates it is skipped with a warning, not fatal."""
        super().init()
        try:
            with self.env.cr.savepoint():
                self.env.cr.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS res_users_clothcraft_login_no_website_uniq "
                    "ON res_users (lower(login)) WHERE website_id IS NULL")
        except Exception:  # noqa: BLE001 - duplicates already present; the advisory lock still protects new registrations
            _logger.warning("clothcraft: could not create the unique login index on res_users (duplicate logins exist?)")
