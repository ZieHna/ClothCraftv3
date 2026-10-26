"""Suppliers (Supplier and Restock, phase 1): who we buy garments from, what each one sells us and for how much, and when each is out.

A supplier owns its data here and is tied to one res.partner (the key purchase orders, receipts, the stock listing and the DSS already
use, so the simulation's suppliers, which exist only as partners with product.supplierinfo, can be read next to these later). The model
creates and keeps that partner in step itself, with sudo limited to the name, address and phone, because Inventory Staff have no right
to write partners.

Entered prices (a supply line's unit cost, the shipping fee) include the 12% VAT; money.vat_split extracts it. A supplier is never
deleted: the Administrator deactivates it, so the history stays. Odoo rights work per model and per record, not per field, so who may
change `active` and `permanently_off` is enforced in write() as well as by the ACLs and record rules (security/).
"""
import datetime

from odoo import api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tools.float_utils import float_compare, float_round

from ..money import vat_split

# The Philippines has no daylight saving: a fixed UTC+8 is Manila time, so "today" does not depend on the server's clock zone.
MANILA = datetime.timezone(datetime.timedelta(hours=8))
ADMIN_ONLY_FIELDS = {'active': True, 'permanently_off': False}  # field -> the value a new supplier starts with
PARTNER_FIELDS = ('street', 'street2', 'city', 'zip', 'country_id', 'phone')


def today_manila():
    return datetime.datetime.now(MANILA).date()


class ClothcraftSupplier(models.Model):
    _name = 'clothcraft.supplier'
    _description = 'Supplier'
    _order = 'name'

    name = fields.Char(string="Company name", required=True)
    contact_name = fields.Char(required=True)
    street = fields.Char(required=True)
    street2 = fields.Char()
    city = fields.Char(required=True)
    zip = fields.Char()
    country_id = fields.Many2one('res.country', default=lambda self: self.env.ref('base.ph', raise_if_not_found=False))
    phone = fields.Char()
    partner_id = fields.Many2one(
        'res.partner', string="Partner", required=True, ondelete='restrict', copy=False, readonly=True,
        help="The partner purchase orders and receipts use. Created and kept in step by the supplier.")
    active = fields.Boolean(default=True, help="Only the Administrator can deactivate a supplier (it is never deleted).")
    permanently_off = fields.Boolean(
        string="Permanently off", default=False, help="Switched off for good: unavailable whatever the dates say. Administrator only.")
    ships = fields.Boolean(string="Ships to us", default=False)
    shipping_fee = fields.Monetary(
        string="Shipping per restock", currency_field='currency_id',
        help="A flat amount per restock (one resupply, bulk buying), VAT included.")
    shipping_fee_vat = fields.Monetary(string="Shipping VAT (12%)", currency_field='currency_id', compute='_compute_shipping_split')
    shipping_fee_net = fields.Monetary(string="Shipping without VAT", currency_field='currency_id', compute='_compute_shipping_split')
    line_ids = fields.One2many('clothcraft.supplier.line', 'supplier_id', string="Supply lines")
    unavailability_ids = fields.One2many('clothcraft.supplier.unavailability', 'supplier_id', string="Unavailable dates")
    restock_ids = fields.One2many('clothcraft.restock', 'supplier_id', string="Restocks")
    available_now = fields.Boolean(
        compute='_compute_status', search='_search_available_now',
        help="Not stored, worked out from today's date (Manila) on every read: active, not permanently off, and today in no unavailable range.")
    status = fields.Selection(
        [('available', "Available"), ('unavailable_range', "Unavailable (dates)"), ('off', "Permanently off"), ('inactive', "Inactive")],
        compute='_compute_status')
    total_spent = fields.Monetary(
        currency_field='currency_id', compute='_compute_spent',
        help="What received restocks cost, VAT included: the sum of each ticket's recorded actual cost. Requested, approved, rejected and not-received tickets do not count.")
    total_spent_vat = fields.Monetary(currency_field='currency_id', compute='_compute_spent')
    total_spent_net = fields.Monetary(currency_field='currency_id', compute='_compute_spent')
    received_count = fields.Integer(compute='_compute_spent', help="Received restocks.")
    opening_balance = fields.Monetary(
        currency_field='currency_id', default=0.0,
        help="A STARTING INVESTMENT: what the stock the shop already had when it began is treated as having cost this supplier, VAT included. "
             "It is not spending in any month and no restock or stock move stands behind it. Administrator only. Profit and DSS must read it as a "
             "separate opening line and never as a monthly cost; received-only spending stays in total_spent*.")
    opening_balance_vat = fields.Monetary(currency_field='currency_id', compute='_compute_opening')
    opening_balance_net = fields.Monetary(currency_field='currency_id', compute='_compute_opening')
    combined_total = fields.Monetary(
        currency_field='currency_id', compute='_compute_opening',
        help="Opening balance plus what received restocks cost, VAT included. For showing the whole investment in a supplier only: never a monthly cost.")
    combined_total_vat = fields.Monetary(currency_field='currency_id', compute='_compute_opening')
    combined_total_net = fields.Monetary(currency_field='currency_id', compute='_compute_opening')
    last_edited_by = fields.Char(readonly=True, copy=False, help="Set by the staff API on every change (the service user is the technical writer).")
    last_edited_at = fields.Datetime(readonly=True, copy=False)
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company, required=True)
    currency_id = fields.Many2one('res.currency', related='company_id.currency_id')

    _partner_uniq = models.Constraint('UNIQUE(partner_id)', 'Every supplier has its own partner.')
    _shipping_fee_positive = models.Constraint('CHECK(shipping_fee >= 0)', 'The shipping amount cannot be negative.')
    _opening_balance_positive = models.Constraint('CHECK(opening_balance >= 0)', 'The opening balance cannot be negative.')

    @api.depends('shipping_fee')
    def _compute_shipping_split(self):
        for supplier in self:
            supplier.shipping_fee_vat, supplier.shipping_fee_net = vat_split(supplier.shipping_fee)

    @api.depends('restock_ids.state', 'restock_ids.actual_cost', 'restock_ids.actual_vat', 'restock_ids.actual_net')
    def _compute_spent(self):
        totals = {
            supplier.id: (cost, vat, net, count) for supplier, cost, vat, net, count in self.env['clothcraft.restock'].sudo()._read_group(
                [('supplier_id', 'in', self.ids), ('state', '=', 'received')], ['supplier_id'],
                ['actual_cost:sum', 'actual_vat:sum', 'actual_net:sum', '__count'])}
        for supplier in self:
            supplier.total_spent, supplier.total_spent_vat, supplier.total_spent_net, supplier.received_count = totals.get(supplier.id, (0.0, 0.0, 0.0, 0))

    @api.depends('opening_balance', 'restock_ids.state', 'restock_ids.actual_cost', 'restock_ids.actual_vat', 'restock_ids.actual_net')
    def _compute_opening(self):
        """The opening balance split with vat_split; the combined parts are the opening parts PLUS the received parts (so VAT + net = total).
        total_spent* are untouched: they stay the received-only figures."""
        for supplier in self:
            vat, net = vat_split(supplier.opening_balance)
            supplier.opening_balance_vat, supplier.opening_balance_net = vat, net
            supplier.combined_total = float_round(supplier.opening_balance + supplier.total_spent, precision_digits=2)
            supplier.combined_total_vat = float_round(vat + supplier.total_spent_vat, precision_digits=2)
            supplier.combined_total_net = float_round(net + supplier.total_spent_net, precision_digits=2)

    @api.depends('active', 'permanently_off', 'unavailability_ids.date_from', 'unavailability_ids.date_to')
    def _compute_status(self):
        today = today_manila()
        for supplier in self:
            if not supplier.active:
                status = 'inactive'
            elif supplier.permanently_off:
                status = 'off'
            elif any(r.date_from <= today <= r.date_to for r in supplier.sudo().unavailability_ids):
                status = 'unavailable_range'
            else:
                status = 'available'
            supplier.status = status
            supplier.available_now = status == 'available'

    @api.model
    def _search_available_now(self, operator, value):
        if operator not in ('=', '!='):
            raise UserError("Search 'available now' with = or !=.")
        wanted = bool(value) == (operator == '=')
        today = today_manila()
        busy = self.env['clothcraft.supplier.unavailability'].sudo().search(
            [('date_from', '<=', today), ('date_to', '>=', today)]).supplier_id.ids
        if wanted:
            return [('active', '=', True), ('permanently_off', '=', False), ('id', 'not in', busy)]
        return ['|', '|', ('active', '=', False), ('permanently_off', '=', True), ('id', 'in', busy)]

    # ------------------------------------------------------------------ who may change what
    def _check_admin_fields(self, vals, creating=False):
        """`active`, `permanently_off` and `opening_balance` belong to the Administrator. sudo (the staff API, which checks the role itself) passes."""
        if self.env.su or self.env.user.has_group('clothcraft.group_admin'):
            return
        if 'opening_balance' in vals:
            # an AMOUNT, so compared as an amount (the flags below are compared as true / false): 100 -> 200 is a change
            new = vals['opening_balance'] or 0.0
            now = [0.0] if creating else [supplier.opening_balance for supplier in self]
            if any(float_compare(new, old, precision_digits=2) for old in now):
                raise AccessError("Only an Administrator can set a supplier's opening balance.")
        for field, start in ADMIN_ONLY_FIELDS.items():
            if field not in vals:
                continue
            if creating and bool(vals[field]) == start:
                continue
            if not creating and all(bool(vals[field]) == bool(supplier[field]) for supplier in self):
                continue
            raise AccessError("Only an Administrator can deactivate a supplier or switch it permanently off (or back on).")

    @api.model
    def _make_partner(self, vals):
        if not (vals.get('name') or '').strip():
            raise ValidationError("A supplier needs a company name.")
        data = {name: vals[name] for name in PARTNER_FIELDS if name in vals}
        return self.env['res.partner'].sudo().create({'name': vals['name'], 'is_company': True, 'supplier_rank': 1, **data})

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            self._check_admin_fields(vals, creating=True)
            if not vals.get('partner_id'):
                vals['partner_id'] = self._make_partner(vals).id
        return super().create(vals_list)

    def write(self, vals):
        self._check_admin_fields(vals)
        if 'partner_id' in vals and any(supplier.partner_id.id != vals['partner_id'] for supplier in self):
            raise UserError("A supplier keeps its partner.")
        result = super().write(vals)
        shared = {name: vals[name] for name in ('name', *PARTNER_FIELDS) if name in vals}
        if shared:
            self.partner_id.sudo().write(shared)
        return result

    @api.ondelete(at_uninstall=False)
    def _unlink_never(self):
        raise UserError("A supplier is never deleted, so its history is kept. Ask an Administrator to deactivate it.")

    # ------------------------------------------------------------------ buttons of the form (the Administrator's; write() enforces it)
    def action_deactivate(self):
        self.write({'active': False})

    def action_reactivate(self):
        self.write({'active': True})

    def action_switch_off(self):
        self.write({'permanently_off': True})

    def action_switch_on(self):
        self.write({'permanently_off': False})


class ClothcraftSupplierLine(models.Model):
    """One thing a supplier sells us: a garment type in one size and one colour, at a unit cost (VAT included)."""
    _name = 'clothcraft.supplier.line'
    _description = 'Supply line'
    _order = 'supplier_id, garment_type_id, size_value_id, color_value_id'

    supplier_id = fields.Many2one('clothcraft.supplier', required=True, ondelete='cascade', index=True)
    garment_type_id = fields.Many2one('clothcraft.garment.type', required=True, ondelete='restrict')
    size_value_id = fields.Many2one('product.attribute.value', string="Size", required=True, ondelete='restrict')
    color_value_id = fields.Many2one('product.attribute.value', string="Colour", required=True, ondelete='restrict')
    currency_id = fields.Many2one('res.currency', related='supplier_id.currency_id')
    unit_cost = fields.Monetary(string="Unit cost (VAT included)", currency_field='currency_id', required=True)
    unit_cost_vat = fields.Monetary(string="VAT (12%)", currency_field='currency_id', compute='_compute_split', store=True)
    unit_cost_net = fields.Monetary(string="Without VAT", currency_field='currency_id', compute='_compute_split', store=True)

    _line_uniq = models.Constraint(
        'UNIQUE(supplier_id, garment_type_id, size_value_id, color_value_id)',
        'This supplier already has a supply line for that garment type, size and colour.')
    _unit_cost_positive = models.Constraint('CHECK(unit_cost >= 0)', 'The unit cost cannot be negative.')

    @api.depends('unit_cost')
    def _compute_split(self):
        for line in self:
            line.unit_cost_vat, line.unit_cost_net = vat_split(line.unit_cost)

    @api.model
    def _combo_problem(self, garment, size, color):
        """(field, sentence) for why this garment type / size / colour cannot be a supply line (the sentence names the garment type and what
        is missing), or None. It must be a size, a colour, and an active product variant of that garment type must carry both."""
        if size.attribute_id != self.env.ref('clothcraft.attribute_size'):
            return 'size_value_id', f"{size.display_name} is not a size."
        if color.attribute_id != self.env.ref('clothcraft.attribute_color'):
            return 'color_value_id', f"{color.display_name} is not a colour."
        variants = self.env['product.product'].sudo()
        path = 'product_template_attribute_value_ids.product_attribute_value_id'

        def made(*values):
            return variants.search_count(
                [('product_tmpl_id.garment_type_id', '=', garment.id), ('active', '=', True)] + [(path, '=', v.id) for v in values], limit=1)

        label = f"{garment.name} ({garment.code})"
        if not made(size):
            return 'size_value_id', f"{label} is not made in size {size.name}."
        if not made(color):
            return 'color_value_id', f"{label} is not made in colour {color.name}."
        if not made(size, color):
            return 'color_value_id', f"{label} has no {color.name} / {size.name} variant."
        return None

    @api.constrains('garment_type_id', 'size_value_id', 'color_value_id')
    def _check_combo(self):
        for line in self:
            problem = self._combo_problem(line.garment_type_id, line.size_value_id, line.color_value_id)
            if problem:
                raise ValidationError(problem[1])


class ClothcraftSupplierUnavailability(models.Model):
    """A date range (both ends included) when the supplier cannot supply. Ranges may overlap."""
    _name = 'clothcraft.supplier.unavailability'
    _description = 'Supplier unavailable dates'
    _order = 'supplier_id, date_from desc'

    supplier_id = fields.Many2one('clothcraft.supplier', required=True, ondelete='cascade', index=True)
    date_from = fields.Date(string="From", required=True)
    date_to = fields.Date(string="To", required=True)
    reason = fields.Char(size=200)

    _dates_ordered = models.Constraint('CHECK(date_from <= date_to)', 'The range must end on or after the day it starts.')

    @api.model_create_multi
    def create(self, vals_list):
        rows = super().create(vals_list)
        self.env['clothcraft.notification']._supplier_range(rows)
        return rows

    def write(self, vals):
        result = super().write(vals)
        if {'date_from', 'date_to', 'reason'} & vals.keys():
            self.env['clothcraft.notification']._supplier_range(self)
        return result
