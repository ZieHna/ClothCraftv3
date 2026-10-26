from odoo import fields, models


class ClothcraftApiSession(models.Model):
    """A storefront customer session. The browser holds a random id; only its SHA-256 is stored here, so a copy of this table
    is not a set of working cookies. Written by clothcraft.api only (nobody has an access line that allows more than reading)."""
    _name = 'clothcraft.api.session'
    _description = 'Storefront API session'

    sid_hash = fields.Char(required=True, index=True)
    scope = fields.Selection([('customer', 'Customer'), ('staff', 'Staff'), ('admin', 'Administrator')], required=True, default='customer', index=True,
                             help="A customer session never opens a staff route and a staff session never opens a customer one. An 'admin' session is the "
                                  "Administrator's own sign-in (/admin): a different cookie, shorter lifetimes, and only an Administrator can hold one.")
    user_id = fields.Many2one('res.users', required=True, ondelete='cascade', index=True)
    last_seen = fields.Datetime(required=True)
    expires = fields.Datetime(required=True, help="Absolute end of the session; the idle limit is checked on top of it.")
    revoked = fields.Boolean(default=False)

    _sid_hash_uniq = models.Constraint('UNIQUE(sid_hash)', 'A session id hash is unique.')


class ClothcraftApiThrottle(models.Model):
    """Failed-attempt counters for sign-in and registration, keyed by a hash of (kind, email or client address).
    The key is hashed whether or not the account exists, so the counters say nothing about which emails are registered."""
    _name = 'clothcraft.api.throttle'
    _description = 'Storefront API attempt counter'

    key = fields.Char(required=True, index=True)
    failures = fields.Integer(default=0)
    last_failure = fields.Datetime()
    locked_until = fields.Datetime()

    _key_uniq = models.Constraint('UNIQUE(key)', 'An attempt counter key is unique.')
