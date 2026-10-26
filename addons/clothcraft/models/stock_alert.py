"""Stock edits, low-stock levels and notifications (Supplier and Restock, phase 3).

Stock edits use Odoo's own inventory adjustment (stock.quant: set the counted quantity, apply it), so real `is_inventory` stock moves exist
and are valued at the product's standard price (the garments are on Standard Price with no cost: an edit never touches cost or profit, and
a guard rolls the edit back if standard_price would change). The garments are lot-tracked, so an edit picks its lots: a decrease takes units
from the oldest lots first; an increase goes into one adjustment lot per variant per day (ADJ-<SKU>-<YYYYMMDD>, created if missing), never
into a supplier's lot. Every edit is a row in clothcraft.stock.edit, append only on three layers like the order audit (the ORM refuses write
and unlink, a database trigger refuses UPDATE and DELETE, and no group has an access line for more than reading). An adjustment made in the
Odoo screens is written there too, with a generic reason.

A variant is LOW when its on-hand quantity is strictly below its effective level (its own override, else the global level, else the built-in
default); a level of 0 never makes it low. clothcraft.stock.alert remembers whether each variant is low, so that the Administrators hear about a
drop ONCE and the variant is re-armed when it goes back up. The check runs from stock.move._action_done after any move that crosses the
internal boundary for a garment, in the same transaction as the move, and it can never raise into a checkout, shipment or receipt.

Lock order, everywhere: the product's advisory lock first (in ascending product id), then the alert row.

Notifications are in-app only: one row per recipient (clothcraft.notification) with a read time; the person doing the action is never told
about their own action. A daily job removes old ones (Settings, default 60 days, 0 keeps them).
"""
import datetime
import logging

from odoo import api, fields, models
from odoo.exceptions import UserError

from .supplier import today_manila

_logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 5
THRESHOLD_MAX = 100000
QTY_MAX = 1_000_000
REASON_MIN, REASON_MAX = 5, 500
NO_ALERTS = 'clothcraft_no_alerts'     # context flag: the simulation seeder (and similar bulk loads) skip the history and the alerts
OWN_EDIT = 'clothcraft_stock_edit'     # context flag: this inventory adjustment is made by _set_on_hand, which writes its own history row
LOCK_SPACE = 7341                      # first key of pg_advisory_xact_lock(key1, product id)
RETENTION_PARAM = 'clothcraft.notification_days'
RETENTION_DEFAULT = 60
NATIVE_REASON = "Adjusted in the Odoo screens (no reason given)"
KINDS = [
    ('restock_requested', 'New restock request'), ('supplier_unavailable', 'Supplier unavailable'), ('low_stock', 'Low stock'),
    ('restock_approved', 'Restock approved'), ('restock_rejected', 'Restock rejected'), ('restock_received', 'Restock received'),
    ('restock_not_received', 'Restock did not arrive'),
    ('employee_added', 'Employee added'), ('employee_role_changed', 'Employee role changed'),
    ('employee_deactivated', 'Employee deactivated'), ('employee_reactivated', 'Employee reactivated'),
]


def _lock_products(env, product_ids):
    """The product advisory locks, in ascending id, held to the end of the transaction. Always the FIRST lock taken."""
    for product_id in sorted(set(product_ids)):
        env.cr.execute("SELECT pg_advisory_xact_lock(%s, %s)", [LOCK_SPACE, product_id])


class ClothcraftStockThreshold(models.Model):
    """The low-stock level: one global row per company, and an optional override per variant. The Administrator's only (rights and rules)."""
    _name = 'clothcraft.stock.threshold'
    _description = 'Low-stock level'
    _order = 'scope, product_id'

    scope = fields.Selection([('global', "All variants"), ('variant', "One variant")], required=True, default='variant')
    product_id = fields.Many2one('product.product', string="Variant", ondelete='cascade', index=True)
    company_id = fields.Many2one('res.company', required=True, default=lambda self: self.env.company)
    threshold = fields.Integer(string="Low below (units)", required=True, default=DEFAULT_THRESHOLD)
    set_by = fields.Char(readonly=True, copy=False)
    set_at = fields.Datetime(readonly=True, copy=False)

    _range = models.Constraint(f'CHECK(threshold >= 0 AND threshold <= {THRESHOLD_MAX})', f'The level is a whole number from 0 to {THRESHOLD_MAX}.')
    _shape = models.Constraint(
        "CHECK((scope = 'global' AND product_id IS NULL) OR (scope = 'variant' AND product_id IS NOT NULL))",
        'The global level has no variant; a variant level names one.')
    _variant_uniq = models.Constraint('UNIQUE(product_id, company_id)', 'A variant has one level of its own.')

    def init(self):
        super().init()
        self.env.cr.execute("""CREATE UNIQUE INDEX IF NOT EXISTS clothcraft_stock_threshold_one_global
                               ON clothcraft_stock_threshold (company_id) WHERE scope = 'global'""")

    def _stamp(self):
        actor = self.env['clothcraft.notification']._actor()
        return {'set_by': actor.partner_id.name or actor.login, 'set_at': fields.Datetime.now()}

    @api.model_create_multi
    def create(self, vals_list):
        stamp = self._stamp()
        rows = super().create([{**vals, **stamp} for vals in vals_list])
        self.env['clothcraft.stock.alert']._resync()
        return rows

    def write(self, vals):
        result = super().write({**vals, **self._stamp()} if 'threshold' in vals else vals)
        if 'threshold' in vals:
            self.env['clothcraft.stock.alert']._resync()
        return result

    def unlink(self):
        result = super().unlink()
        self.env['clothcraft.stock.alert']._resync()
        return result


class ClothcraftStockAlert(models.Model):
    """Whether a variant is low right now (as last checked). System state: no group has an access line, only the code reads and writes it."""
    _name = 'clothcraft.stock.alert'
    _description = 'Low-stock state'

    product_id = fields.Many2one('product.product', required=True, ondelete='cascade', index=True)
    low = fields.Boolean(default=False)
    since = fields.Datetime(default=fields.Datetime.now)

    _product_uniq = models.Constraint('UNIQUE(product_id)', 'A variant has one low-stock state.')

    # ------------------------------------------------------------------ numbers
    @api.model
    def _stock_location(self):
        return self.env['stock.warehouse'].sudo().search([('company_id', '=', self.env.company.id)], limit=1).lot_stock_id

    @api.model
    def _on_hand(self, products):
        """{product id: (on hand, reserved)} under the warehouse's stock location. A variant with no stock is (0, 0)."""
        out = {product.id: (0.0, 0.0) for product in products}
        location = self._stock_location()
        if not location or not products:
            return out
        for product, quantity, reserved in self.env['stock.quant'].sudo()._read_group(
                [('product_id', 'in', products.ids), ('location_id', 'child_of', location.id)], ['product_id'],
                ['quantity:sum', 'reserved_quantity:sum']):
            out[product.id] = (quantity, reserved)
        return out

    @api.model
    def _levels(self, products):
        """{product id: (effective level, 'variant' or 'global' or 'default', the variant's own level or None)}."""
        rows = self.env['clothcraft.stock.threshold'].sudo().search([('company_id', '=', self.env.company.id)])
        overall = next((r.threshold for r in rows if r.scope == 'global'), None)
        own = {r.product_id.id: r.threshold for r in rows if r.scope == 'variant'}
        out = {}
        for product in products:
            if product.id in own:
                out[product.id] = (own[product.id], 'variant', own[product.id])
            elif overall is not None:
                out[product.id] = (overall, 'global', None)
            else:
                out[product.id] = (DEFAULT_THRESHOLD, 'default', None)
        return out

    # ------------------------------------------------------------------ the check
    @api.model
    def _check(self, products, notify=True):
        """Bring the low/not-low state of these garment variants up to date. Sends ONE notification for a variant that has just dropped
        below its level (it was not low before); a variant going back up is only re-armed. Nothing is sent when notify is False."""
        products = products.sudo().filtered(lambda p: p.product_tmpl_id.garment_type_id)
        if not products:
            return
        _lock_products(self.env, products.ids)                       # 1st: the product locks
        self.env.cr.execute("SELECT id FROM clothcraft_stock_alert WHERE product_id = ANY(%s) ORDER BY product_id FOR UPDATE", [products.ids])  # 2nd: the alert rows
        rows = {row.product_id.id: row for row in self.sudo().search([('product_id', 'in', products.ids)])}
        stock, levels = self._on_hand(products), self._levels(products)
        for product in products.sorted('id'):
            on_hand = stock[product.id][0]
            level = levels[product.id][0]
            low = on_hand < level
            row = rows.get(product.id)
            was_low = bool(row and row.low)
            if row is None:
                self.sudo().create({'product_id': product.id, 'low': low})
            elif row.low != low:
                row.write({'low': low, 'since': fields.Datetime.now()})
            if notify and low and not was_low:
                self.env['clothcraft.notification']._low_stock(product, on_hand, level)

    @api.model
    def _resync(self):
        """After a level changes: update every garment variant's state, silently (no flood of notifications)."""
        self._check(self.env['product.product'].sudo().search([('product_tmpl_id.garment_type_id', '!=', False)]), notify=False)

    @api.model
    def _after_moves(self, moves):
        """Called when stock moves are done. Cheap exits first: nothing happens for a move that stays inside (or outside) the internal
        locations, or for a product that is not a garment. Never raises: stock must always move."""
        if self.env.context.get(NO_ALERTS):
            return
        try:
            crossing = moves.sudo().filtered(lambda m: (m.location_id.usage == 'internal') != (m.location_dest_id.usage == 'internal'))
            if not crossing:
                return
            products = crossing.product_id.filtered(lambda p: p.product_tmpl_id.garment_type_id)
            if not products:
                return
            with self.env.cr.savepoint():
                if not self.env.context.get(OWN_EDIT):
                    self.env['clothcraft.stock.edit']._record_native(crossing.filtered(lambda m: m.is_inventory and m.product_id in products))
                self._check(products)
        except Exception:  # noqa: BLE001 - an alert fault must never stop a checkout, a shipment or a receipt
            _logger.exception("clothcraft: the low-stock check failed (the stock move itself was kept)")


class ClothcraftStockEdit(models.Model):
    """Who set a variant's on-hand quantity to what, from what, why, and when. Append only (see the module docstring)."""
    _name = 'clothcraft.stock.edit'
    _description = 'Stock edit'
    _order = 'id desc'

    product_id = fields.Many2one('product.product', string="Variant", required=True, ondelete='restrict', index=True)
    old_qty = fields.Integer(required=True)
    new_qty = fields.Integer(required=True)
    delta = fields.Integer(required=True)
    reason = fields.Text(required=True)
    detail = fields.Text(help="Per lot: how many units went out of or into it.")
    staff_id = fields.Many2one('res.users', ondelete='set null')
    staff_name = fields.Char(required=True, help="The staff member's name at the time: it stays when the account is renamed or removed.")
    via = fields.Selection([('dashboard', 'Staff dashboard'), ('odoo', 'Odoo')], required=True, default='odoo')
    company_id = fields.Many2one('res.company', required=True, default=lambda self: self.env.company)

    def write(self, vals):
        raise UserError("The stock edit history cannot be changed.")

    def unlink(self):
        raise UserError("The stock edit history cannot be deleted.")

    def init(self):
        super().init()
        cr = self.env.cr
        cr.execute("""
            CREATE OR REPLACE FUNCTION clothcraft_stock_edit_guard() RETURNS trigger AS $$
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    RAISE EXCEPTION 'The stock edit history cannot be changed';
                END IF;
                RAISE EXCEPTION 'The stock edit history cannot be deleted';
            END;
            $$ LANGUAGE plpgsql""")
        cr.execute("DROP TRIGGER IF EXISTS clothcraft_stock_edit_guard ON clothcraft_stock_edit")
        cr.execute("""CREATE TRIGGER clothcraft_stock_edit_guard BEFORE UPDATE OR DELETE ON clothcraft_stock_edit
                      FOR EACH ROW EXECUTE FUNCTION clothcraft_stock_edit_guard()""")

    @api.model
    def _who(self):
        actor = self.env['clothcraft.notification']._actor()
        return actor, actor.partner_id.name or actor.login

    @api.model
    def _record_native(self, moves):
        """History rows for inventory adjustments made in the Odoo screens (not by _set_on_hand): one per variant, old worked out from now."""
        if not moves:
            return
        actor, name = self._who()
        Alert = self.env['clothcraft.stock.alert']
        deltas = {}
        for move in moves:
            sign = 1 if move.location_dest_id.usage == 'internal' else -1
            deltas.setdefault(move.product_id, []).append((sign * move.quantity, move.move_line_ids.lot_id.mapped('name')))
        now = Alert._on_hand(self.env['product.product'].browse([p.id for p in deltas]))
        for product, parts in deltas.items():
            delta = int(sum(q for q, _ in parts))
            new = int(now[product.id][0])
            self.sudo().create({
                'product_id': product.id, 'old_qty': new - delta, 'new_qty': new, 'delta': delta, 'reason': NATIVE_REASON,
                'detail': '; '.join(f"{', '.join(lots) or 'no lot'} {q:+g}" for q, lots in parts),
                'staff_id': actor.id, 'staff_name': name, 'via': 'odoo', 'company_id': self.env.company.id})

    @api.model
    def _set_on_hand(self, product, quantity, reason):
        """Set a variant's on-hand quantity (under the warehouse's stock location) through Odoo's inventory adjustment. All or nothing: the
        caller runs it in a savepoint. Returns the history row."""
        Alert, Quant = self.env['clothcraft.stock.alert'], self.env['stock.quant'].sudo()
        reason = (reason or '').strip()
        if not REASON_MIN <= len(reason) <= REASON_MAX:
            raise UserError(f"Write a reason of {REASON_MIN} to {REASON_MAX} characters.")
        if isinstance(quantity, bool) or quantity != int(quantity) or not 0 <= quantity <= QTY_MAX:
            raise UserError(f"The quantity is a whole number from 0 to {QTY_MAX}.")
        quantity = int(quantity)
        _lock_products(self.env, [product.id])                      # the product lock first, before any alert row
        location = Alert._stock_location()
        if not location:
            raise UserError("The warehouse has no stock location.")
        quants = Quant.search([('product_id', '=', product.id), ('location_id', 'child_of', location.id)])
        quants.invalidate_recordset()
        on_hand = int(sum(quants.mapped('quantity')))
        reserved = int(sum(quants.mapped('reserved_quantity')))
        if quantity == on_hand:
            raise UserError(f"The quantity is already {on_hand}. Nothing was changed.")
        if quantity < reserved:
            raise UserError(f"{reserved} unit(s) are promised to orders, so the quantity cannot go below {reserved}.")
        company_product = product.with_company(self.env.company)
        cost_before = company_product.standard_price
        plan, detail = [], []   # plan: (quant or None, lot, target quantity)
        delta = quantity - on_hand
        if delta < 0:
            remaining = -delta
            for quant in quants.filtered(lambda q: q.quantity > q.reserved_quantity).sorted(lambda q: (q.in_date or datetime.datetime.min, q.id)):
                take = min(remaining, int(quant.quantity - quant.reserved_quantity))
                if take:
                    plan.append((quant, quant.lot_id, quant.quantity - take))
                    detail.append(f"{quant.lot_id.name or 'no lot'} -{take}")
                    remaining -= take
                if not remaining:
                    break
            if remaining:
                raise UserError("Too much of the stock is reserved by orders to take that many units out.")
        else:
            lot_name = f"ADJ-{product.default_code or product.id}-{today_manila():%Y%m%d}"
            lot = self.env['stock.lot'].sudo().search([('name', '=', lot_name), ('product_id', '=', product.id), ('company_id', 'in', [self.env.company.id, False])], limit=1) \
                or self.env['stock.lot'].sudo().create({'name': lot_name, 'product_id': product.id, 'company_id': self.env.company.id})
            quant = quants.filtered(lambda q: q.lot_id == lot)[:1]
            plan.append((quant, lot, (quant.quantity if quant else 0) + delta))
            detail.append(f"{lot.name} +{delta}")
        context = {'inventory_mode': True, OWN_EDIT: True, 'inventory_name': f"Stock edit: {reason}"[:120]}
        applied = Quant.browse()
        for quant, lot, target in plan:
            if quant:
                quant = quant.with_context(**context)
                quant.inventory_quantity = target
            else:
                quant = Quant.with_context(**context).create({
                    'product_id': product.id, 'location_id': location.id, 'lot_id': lot.id, 'inventory_quantity': target})
            applied |= quant
        applied.with_context(**context).action_apply_inventory()
        after = Alert._on_hand(product)[product.id][0]
        if int(after) != quantity:
            raise UserError(f"Odoo ended with {int(after)} on hand instead of {quantity}, so nothing was changed.")
        company_product.invalidate_recordset(['standard_price'])
        if company_product.standard_price != cost_before:
            raise UserError("This edit would have changed the cost Odoo holds for the product, which a stock edit must not do. Nothing was changed.")
        actor, name = self._who()
        return self.sudo().create({
            'product_id': product.id, 'old_qty': on_hand, 'new_qty': quantity, 'delta': delta, 'reason': reason, 'detail': '; '.join(detail),
            'staff_id': actor.id, 'staff_name': name, 'via': self.env.context.get('clothcraft_via', 'odoo'), 'company_id': self.env.company.id})


class ClothcraftNotification(models.Model):
    """An in-app notification for one person. Written only by the code below (sudo); the person reads their own."""
    _name = 'clothcraft.notification'
    _description = 'Notification'
    _order = 'id desc'

    user_id = fields.Many2one('res.users', string="For", required=True, ondelete='cascade', index=True)
    kind = fields.Selection(KINDS, required=True)
    title = fields.Char(required=True)
    body = fields.Char()
    restock_id = fields.Many2one('clothcraft.restock', ondelete='set null')
    supplier_id = fields.Many2one('clothcraft.supplier', ondelete='set null')
    product_id = fields.Many2one('product.product', ondelete='set null')
    employee_id = fields.Many2one('res.users', ondelete='set null', help="The employee an employee-management notice is about.")
    read_at = fields.Datetime(help="Empty until the person has read it.")
    company_id = fields.Many2one('res.company', required=True, default=lambda self: self.env.company)

    def write(self, vals):
        if set(vals) - {'read_at'} and not self.env.su:
            raise UserError("A notification can only be marked read.")
        return super().write(vals)

    # ------------------------------------------------------------------ who
    @api.model
    def _actor(self):
        """The person doing this: the staff member the API passes along, else the current user."""
        return self.env['res.users'].sudo().browse(self.env.context.get('clothcraft_actor') or self.env.uid)

    @api.model
    def _admins(self):
        return self.env.ref('clothcraft.group_admin').sudo().user_ids.filtered(lambda u: u.active and not u.share)

    @api.model
    def _push(self, users, kind, title, body, **links):
        """One row per recipient, never the actor. Quiet on failure: a notification must not stop what caused it."""
        actor = self._actor()
        users = users.filtered(lambda u: u.active and u.id != actor.id)
        if not users:
            return self.browse()
        try:
            with self.env.cr.savepoint():
                return self.sudo().create([{'user_id': user.id, 'kind': kind, 'title': title, 'body': body, **links} for user in users])
        except Exception:  # noqa: BLE001
            _logger.exception("clothcraft: a notification could not be saved")
            return self.browse()

    # ------------------------------------------------------------------ the events
    @api.model
    def _low_stock(self, product, on_hand, level):
        self._push(self._admins(), 'low_stock', "Low stock", f"{product.display_name}: {int(on_hand)} left (alert level {level}).", product_id=product.id)

    @api.model
    def _supplier_range(self, rows):
        """An employee (not an Administrator) set unavailable dates for a supplier: the Administrators are told."""
        actor = self._actor()
        if actor.has_group('clothcraft.group_admin'):
            return
        for row in rows.sudo():
            self._push(self._admins(), 'supplier_unavailable', "Supplier unavailable",
                       f"{actor.partner_id.name or actor.login} set {row.supplier_id.name} unavailable from {row.date_from} to {row.date_to}"
                       + (f" ({row.reason})." if row.reason else "."), supplier_id=row.supplier_id.id)

    @api.model
    def _restock_event(self, restocks, kind):
        """restock_requested goes to the Administrators; the other kinds go to the employee who made the request."""
        actor = self._actor()
        who = actor.partner_id.name or actor.login
        for restock in restocks.sudo():
            links = {'restock_id': restock.id, 'supplier_id': restock.supplier_id.id}
            if kind == 'restock_requested':
                self._push(self._admins(), kind, "New restock request",
                           f"{restock.name} from {restock.supplier_id.name} by {restock.requested_by}: {len(restock.line_ids)} line(s), about {restock.estimate_total:.2f}.", **links)
                continue
            text = {
                'restock_approved': ("Restock approved", f"{restock.name} ({restock.supplier_id.name}) was approved by {who}."),
                'restock_rejected': ("Restock rejected", f"{restock.name} ({restock.supplier_id.name}) was rejected by {who}: {restock.decision_note}"),
                'restock_received': ("Restock received", f"{restock.name} ({restock.supplier_id.name}) was received by {who}" + (", late." if restock.received_late else ".")),
                'restock_not_received': ("Restock did not arrive", f"{restock.name} ({restock.supplier_id.name}) was marked as not received by {who}."),
            }[kind]
            self._push(restock.requested_by_id, kind, text[0], text[1], **links)

    @api.model
    def _employee_event(self, kind, target, actor, text):
        """An Administrator added, re-roled, deactivated or reactivated an employee: the OTHER Administrators are told (never the actor). The text
        names people only; it never carries a password or any other secret."""
        title = dict(KINDS)[kind]
        self.with_context(clothcraft_actor=actor.id)._push(self._admins(), kind, title, text, employee_id=target.id)

    # ------------------------------------------------------------------ the daily job
    @api.model
    def _cron_clothcraft_notification_cleanup(self):
        raw = self.env['ir.config_parameter'].sudo().get_param(RETENTION_PARAM, str(RETENTION_DEFAULT))
        try:
            days = max(int(raw), 0)
        except (TypeError, ValueError):
            days = RETENTION_DEFAULT
        if days <= 0:
            return 0
        old = self.sudo().search([('create_date', '<', fields.Datetime.now() - datetime.timedelta(days=days))])
        count = len(old)
        old.unlink()
        return count


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    clothcraft_notification_days = fields.Integer(
        string="Remove notifications after (days)", config_parameter=RETENTION_PARAM, default=RETENTION_DEFAULT,
        help="A notification, read or not, is removed this many days after it was made. 0 keeps them for ever.")

    @api.constrains('clothcraft_notification_days')
    def _check_clothcraft_notification_days(self):
        for settings in self:
            if settings.clothcraft_notification_days < 0:
                raise UserError(self.env._("The number of days is 0 (off) or more."))
