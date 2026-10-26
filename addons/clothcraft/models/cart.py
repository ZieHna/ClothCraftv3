"""Step 12: the customer's cart, kept on the server under their account (real shop only; the frozen mock keeps its browser cart).

One cart per customer: lines of (variant, design or none) with a quantity and a "ticked" flag. No prices: the quote prices a cart from
its SKUs and designs every time it is shown, as before. A whole cart is written at once (cart_put) with the version the browser last saw;
a different version is a conflict answered with the cart as it is now, and the browser merges its own edits into it. The cart row is
locked (FOR UPDATE) for the write, so two writes cannot both pass the version check.

Placing an order takes the ordered quantities off the cart in the same transaction (place_order). A daily job removes carts untouched
for N days (Sales settings, default 60, 0 = off) and voids the draft designs only they referred to. The design clean-up never deletes a
design a cart line refers to (models/design.py).
"""
import datetime
import logging

from psycopg2 import errors as pg_errors

from odoo import api, fields, models
from odoo.exceptions import ValidationError
from odoo.tools import mute_logger

_logger = logging.getLogger(__name__)

MAX_LINES = 50
MAX_QUANTITY = 99            # the shop's own limit per line (frontend MAX_QUANTITY)
SKU_MAX = 64
EXPIRY_PARAM = 'clothcraft.cart_expiry_days'
EXPIRY_DEFAULT = 60
# writes per session: a busy shopper saves about twice a second at most (the browser waits 500 ms after the last edit)
PUT_RATE, PUT_WINDOW = 120, 60


class ClothcraftCart(models.Model):
    _name = 'clothcraft.cart'
    _description = 'Customer cart'

    partner_id = fields.Many2one('res.partner', string="Customer", required=True, index=True, ondelete='cascade', readonly=True)
    version = fields.Integer(default=0, required=True, readonly=True, help="Goes up by one on every change; a write must name the version it was based on.")
    line_ids = fields.One2many('clothcraft.cart.line', 'cart_id', readonly=True)

    _partner_uniq = models.Constraint('UNIQUE(partner_id)', 'A customer has one cart.')

    # ------------------------------------------------------------------ the daily job
    @api.model
    def _clothcraft_expiry_days(self):
        raw = self.env['ir.config_parameter'].sudo().get_param(EXPIRY_PARAM, str(EXPIRY_DEFAULT))
        try:
            return max(int(raw), 0)
        except (TypeError, ValueError):
            return EXPIRY_DEFAULT

    @api.model
    def _cron_clothcraft_cart_expiry(self, now=None):
        """Remove carts not changed for N days, and void the draft designs only they referred to. A cart someone is saving right now
        (its row is locked) is left for the next run. Returns how many carts were removed."""
        days = self._clothcraft_expiry_days()
        if days <= 0:
            return 0
        cutoff = (now or fields.Datetime.now()) - datetime.timedelta(days=days)
        removed = 0
        for cart in self.sudo().search([('write_date', '<', cutoff)], order='id'):
            try:
                with self.env.cr.savepoint(), mute_logger('odoo.sql_db'):
                    self.env.cr.execute('SELECT id FROM clothcraft_cart WHERE id = %s FOR UPDATE NOWAIT', [cart.id])
                    cart.invalidate_recordset()
                    if cart.write_date >= cutoff:
                        continue
                    designs = cart.line_ids.design_id.filtered(lambda d: d.state == 'draft')
                    cart.unlink()
                    still = self.env['clothcraft.cart.line'].sudo().search([('design_id', 'in', designs.ids)]).design_id
                    designs.filtered(lambda d: d not in still and not d.order_line_ids).write({'state': 'void'})
                    removed += 1
            except pg_errors.LockNotAvailable:
                continue
        if removed:
            _logger.info('clothcraft: removed %s cart(s) untouched for %s days', removed, days)
        return removed


class ClothcraftCartLine(models.Model):
    _name = 'clothcraft.cart.line'
    _description = 'Customer cart line'
    _order = 'sequence, id'

    cart_id = fields.Many2one('clothcraft.cart', required=True, index=True, ondelete='cascade', readonly=True)
    sequence = fields.Integer(default=10, readonly=True)
    product_id = fields.Many2one('product.product', string="Variant", required=True, ondelete='cascade', readonly=True)
    # a design that is deleted takes its line with it: a designed line must never turn into the plain garment
    design_id = fields.Many2one('clothcraft.design', index=True, ondelete='cascade', readonly=True)
    quantity = fields.Integer(required=True, readonly=True)
    selected = fields.Boolean(string="Ticked", readonly=True)

    _quantity_range = models.Constraint(f'CHECK(quantity BETWEEN 1 AND {MAX_QUANTITY})', f'A cart line holds 1 to {MAX_QUANTITY} pieces.')

    def init(self):
        super().init()
        # one line per (variant, design or none) in a cart: NULL designs are equal here
        self.env.cr.execute("""CREATE UNIQUE INDEX IF NOT EXISTS clothcraft_cart_line_key
                               ON clothcraft_cart_line (cart_id, product_id, COALESCE(design_id, 0))""")


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    clothcraft_cart_expiry_days = fields.Integer(
        string="Remove carts untouched for (days)", config_parameter=EXPIRY_PARAM, default=EXPIRY_DEFAULT,
        help="A customer's saved cart that has not changed for this many days is removed. 0 keeps carts for ever.")

    @api.constrains('clothcraft_cart_expiry_days')
    def _check_clothcraft_cart_expiry_days(self):
        for settings in self:
            if settings.clothcraft_cart_expiry_days < 0:
                raise ValidationError(self.env._("The number of days is 0 (off) or more."))


class ClothcraftApiCart(models.AbstractModel):
    _inherit = 'clothcraft.api'

    # ------------------------------------------------------------------ reading
    @api.model
    def _api_cart_data(self, cart):
        """The cart as plain data: no prices (the quote prices it)."""
        if not cart:
            return {'version': 0, 'updated': None, 'lines': []}
        lines = []
        for line in cart.line_ids.sorted(lambda l: (l.sequence, l.id)):
            row = {'sku': line.product_id.default_code, 'product_slug': line.product_id.product_tmpl_id.clothcraft_slug or '',
                   'quantity': line.quantity, 'selected': line.selected}
            if line.design_id:
                row['design_id'] = str(line.design_id.id)
            lines.append(row)
        return {'version': cart.version, 'updated': cart.write_date.isoformat(timespec='milliseconds'), 'lines': lines}

    @api.model
    def cart_get(self, payload):
        """payload: sid_hash. status ok (with the cart: version 0 and no lines when the customer has none yet) or unauthorised."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(payload.get('sid_hash'))
        if not partner:
            return {**info, 'status': 'unauthorised'}
        cart = self.env['clothcraft.cart'].sudo().search([('partner_id', '=', partner.id)], limit=1)
        return {**info, 'status': 'ok', 'session_remaining': remaining, 'cart': self._api_cart_data(cart)}

    # ------------------------------------------------------------------ writing
    @api.model
    def _api_rate(self, key, limit, window):
        """Count one call on this key in a fixed window of `window` seconds; return the seconds to wait when over `limit`, else 0."""
        now = self._api_now()
        self.env.cr.execute(
            """INSERT INTO clothcraft_api_throttle (key, failures, last_failure) VALUES (%s, 1, %s)
               ON CONFLICT (key) DO UPDATE SET
                 failures = CASE WHEN clothcraft_api_throttle.last_failure < %s THEN 1 ELSE clothcraft_api_throttle.failures + 1 END,
                 last_failure = CASE WHEN clothcraft_api_throttle.last_failure < %s THEN %s ELSE clothcraft_api_throttle.last_failure END
               RETURNING failures, last_failure""", [key, now, now - datetime.timedelta(seconds=window), now - datetime.timedelta(seconds=window), now])
        count, started = self.env.cr.fetchone()
        if count <= limit:
            return 0
        return max(1, int(window - (now - started).total_seconds()))

    @api.model
    def _api_cart_lines(self, partner, raw):
        """Check and resolve the lines of a cart write. ([(variant, design, quantity, selected)], {}) or (None, {field: message})."""
        if not isinstance(raw, list):
            return None, {'lines': 'The cart lines are missing.'}
        if len(raw) > MAX_LINES:
            return None, {'lines': f'A cart holds at most {MAX_LINES} lines.'}
        problems, wanted = {}, []
        for i, line in enumerate(raw):
            if not isinstance(line, dict):
                problems[f'lines[{i}]'] = 'This line is not readable.'
                continue
            sku, quantity, design, selected = line.get('sku'), line.get('quantity'), line.get('design_id'), line.get('selected', False)
            if not isinstance(sku, str) or not sku or len(sku) > SKU_MAX:
                problems[f'lines[{i}].sku'] = 'Each line needs an item code.'
            if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= MAX_QUANTITY:
                problems[f'lines[{i}].quantity'] = f'The quantity is a whole number from 1 to {MAX_QUANTITY}.'
            if design is not None and not (isinstance(design, str) and design.isdigit() and len(design) <= 12):
                problems[f'lines[{i}].designId'] = 'This design is not one of yours.'
            if not isinstance(selected, bool):
                problems[f'lines[{i}].selected'] = 'Ticked is yes or no.'
            wanted.append((i, sku, int(design) if isinstance(design, str) and design.isdigit() else 0, quantity, selected))
        if problems:
            return None, problems
        variants = {v.default_code: v for v in self.env['product.product'].sudo().with_context(active_test=False).search(
            [('default_code', 'in', [w[1] for w in wanted]), ('product_tmpl_id.garment_type_id', '!=', False)])}
        designs = self._api_designs_of(partner, {w[2] for w in wanted if w[2]})
        seen, resolved = set(), []
        for i, sku, design_id, quantity, selected in wanted:
            variant = variants.get(sku)
            if not variant:
                problems[f'lines[{i}].sku'] = 'There is no item with this code.'
                continue
            design = designs.get(design_id) if design_id else None
            if design_id and (not design or design.product_tmpl_id != variant.product_tmpl_id):
                problems[f'lines[{i}].designId'] = 'This design is not one of yours.'
                continue
            if (variant.id, design_id) in seen:
                problems[f'lines[{i}]'] = 'This item is in the cart twice.'
                continue
            seen.add((variant.id, design_id))
            resolved.append((variant, design, quantity, selected))
        return (None, problems) if problems else (resolved, {})

    @api.model
    def _api_cart_locked(self, partner):
        """The customer's cart, created if they have none, with its row locked until the transaction ends."""
        Cart = self.env['clothcraft.cart'].sudo()
        cart = Cart.search([('partner_id', '=', partner.id)], limit=1)
        if not cart:
            try:
                with self.env.cr.savepoint(), mute_logger('odoo.sql_db'):
                    cart = Cart.create({'partner_id': partner.id})
            except pg_errors.UniqueViolation:
                cart = Cart.search([('partner_id', '=', partner.id)], limit=1)       # made at the same moment elsewhere
        self.env.cr.execute('SELECT version FROM clothcraft_cart WHERE id = %s FOR UPDATE', [cart.id])
        cart.invalidate_recordset()
        return cart

    @staticmethod
    def _api_cart_same(cart, resolved):
        have = sorted((l.product_id.id, l.design_id.id or 0, l.quantity, l.selected) for l in cart.line_ids)
        want = sorted((v.id, d.id if d else 0, q, s) for v, d, q, s in resolved)
        order_have = [(l.product_id.id, l.design_id.id or 0) for l in cart.line_ids.sorted(lambda l: (l.sequence, l.id))]
        order_want = [(v.id, d.id if d else 0) for v, d, _q, _s in resolved]
        return have == want and order_have == order_want

    @api.model
    def cart_put(self, payload):
        """payload: sid_hash, base_version (the version the browser last saw), lines [{sku, quantity, design_id?, selected}].

        status ok (with the cart; replayed True when it already was exactly this), conflict (another tab or device changed it: the cart
        as it is now), invalid (fields), throttled (retry_after) or unauthorised. The cart row is locked first, so two writes based on
        the same version cannot both pass: the second waits, then sees the new version and is a conflict."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        sid_hash = payload.get('sid_hash')
        partner, remaining = self._api_customer(sid_hash)
        if not partner:
            return {**info, 'status': 'unauthorised'}
        info['session_remaining'] = remaining
        wait = self._api_rate(self._api_key('cart-put', sid_hash), PUT_RATE, PUT_WINDOW)
        if wait:
            return {**info, 'status': 'throttled', 'retry_after': wait}
        base = payload.get('base_version')
        if isinstance(base, bool) or not isinstance(base, int) or base < 0:
            return {**info, 'status': 'invalid', 'fields': {'baseVersion': 'The cart version is missing.'}}
        resolved, problems = self._api_cart_lines(partner, payload.get('lines'))
        if problems:
            return {**info, 'status': 'invalid', 'fields': problems}
        cart = self._api_cart_locked(partner)
        if self._api_cart_same(cart, resolved):
            # nothing to change: the same write again (its answer was lost), or an edit that ends where the cart already is
            return {**info, 'status': 'ok', 'replayed': True, 'cart': self._api_cart_data(cart)}
        if cart.version != base:
            return {**info, 'status': 'conflict', 'cart': self._api_cart_data(cart)}
        cart.line_ids.unlink()
        cart.write({'version': cart.version + 1, 'line_ids': [
            (0, 0, {'sequence': n, 'product_id': v.id, 'design_id': d.id if d else False, 'quantity': q, 'selected': s})
            for n, (v, d, q, s) in enumerate(resolved, start=1)]})
        return {**info, 'status': 'ok', 'replayed': False, 'cart': self._api_cart_data(cart)}

    @api.model
    def _api_cart_take_ordered(self, partner, merged):
        """Take what an order holds off the customer's cart, in the order's own transaction: {(sku, design id or 0): quantity}. A line
        ordered in full goes; a line with more than was ordered (raised on another device meanwhile) keeps the rest, unticked."""
        cart = self.env['clothcraft.cart'].sudo().search([('partner_id', '=', partner.id)], limit=1)
        if not cart:
            return
        cart = self._api_cart_locked(partner)
        changed = False
        for line in cart.line_ids:
            ordered = merged.get((line.product_id.default_code, line.design_id.id or 0))
            if not ordered:
                continue
            changed = True
            if line.quantity <= ordered:
                line.unlink()
            else:
                line.write({'quantity': line.quantity - ordered, 'selected': False})
        if changed:
            cart.write({'version': cart.version + 1})
