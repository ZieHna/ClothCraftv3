"""The staff side of suppliers (Supplier and Restock, phase 1): list and read them, add and change them, their supply lines and their
unavailable dates, and (Administrator only) deactivate, reactivate, switch off and switch on.

Same rules as api_staff.py: the staff session and role are checked LIVE on every call, the service user keeps no right to create or write,
and every write is done with sudo limited to exactly the fields below. Because the technical writer is the service user, each write also
records who did it (last_edited_by, last_edited_at on the supplier). Nothing here deletes a supplier. Every reply is
{status, ...}: done, unauthorised, forbidden, not_found, invalid (`fields`: field -> sentence) or refused (a rule said no: `message`).
"""
import datetime
import math
import re

from odoo import api, fields, models
from odoo.exceptions import UserError
from odoo.tools.float_utils import float_round

from .supplier import today_manila

TEXT_LIMITS = {'name': 120, 'contact_name': 120, 'street': 200, 'street2': 200, 'city': 100, 'zip': 20, 'phone': 40}
REQUIRED = ('name', 'contact_name', 'street', 'city')
LABELS = {'name': 'The company name', 'contact_name': 'The contact name', 'street': 'The address', 'street2': 'The address line 2',
          'city': 'The city', 'zip': 'The postal code', 'phone': 'The phone number'}
PHONE = re.compile(r'^[0-9+()\-. ]{3,40}$')
COST_MAX = 1_000_000
OPENING_MAX = 100_000_000  # an opening balance is a whole stock's worth, so it has a higher ceiling than one unit cost
REASON_LIMIT = 200
LIST_MAX = 100
ATTENTION_DAYS = 30  # "coming up": unavailable ranges that start within this many days (Manila)
STATUSES = ('available', 'unavailable_range', 'off', 'inactive')
NEED_ADMIN = 'Only an Administrator can do this.'
LOCKED = 'This supplier is inactive or switched off, so only an Administrator can change it.'


class ClothcraftApiSupplier(models.AbstractModel):
    _inherit = 'clothcraft.api'

    # ------------------------------------------------------------------ shared pieces
    @api.model
    def _api_supplier_start(self, payload, admin_only=False):
        """(info, staff, early reply). The early reply is set when the session is not staff or the role is not enough."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        staff = self._api_staff(payload.get('sid_hash'))
        if not staff:
            return info, None, {**info, 'status': 'unauthorised'}
        info['session_remaining'] = staff['remaining']
        if admin_only and staff['role'] != 'admin':
            return info, staff, {**info, 'status': 'forbidden', 'message': NEED_ADMIN}
        return info, staff, None

    @api.model
    def _api_supplier_model(self):
        return self.env['clothcraft.supplier'].sudo().with_context(active_test=False)

    @api.model
    def _api_supplier_find(self, payload, info, staff, key='supplier_id', model='clothcraft.supplier', edit=True):
        """(record, early reply). `edit` also refuses an Inventory person on an inactive or switched-off supplier (the record rule's twin:
        this path writes with sudo, so the rule does not run)."""
        try:
            record = self.env[model].sudo().with_context(active_test=False).browse(int(payload.get(key))).exists()
        except (TypeError, ValueError):
            record = None
        if not record:
            return None, {**info, 'status': 'not_found'}
        supplier = record if model == 'clothcraft.supplier' else record.supplier_id
        if edit and staff['role'] != 'admin' and (not supplier.active or supplier.permanently_off):
            return None, {**info, 'status': 'forbidden', 'message': LOCKED}
        return record, None

    @api.model
    def _api_supplier_stamp(self, staff):
        return {'last_edited_by': staff['user'].partner_id.name, 'last_edited_at': fields.Datetime.now()}

    @api.model
    def _api_cost(self, value, label, high=COST_MAX):
        """(amount, sentence): a money amount with at most 2 decimals, 0 up to `high` (COST_MAX unless a caller says otherwise)."""
        if isinstance(value, bool) or value is None or value == '':
            return None, f'{label} is needed.'
        try:
            amount = float(value)
        except (TypeError, ValueError):
            return None, f'{label} must be a number.'
        if not math.isfinite(amount):
            return None, f'{label} must be a number.'
        if amount < 0:
            return None, f'{label} cannot be negative.'
        if amount > high:
            return None, f'{label} is too large.'
        if abs(round(amount, 2) - amount) > 1e-9:
            return None, f'{label} can have at most 2 decimal places.'
        return round(amount, 2), None

    @api.model
    def _api_date(self, value, label):
        if not isinstance(value, str) or len(value) != 10:
            return None, f'{label} must be a date (YYYY-MM-DD).'
        try:
            return datetime.date.fromisoformat(value), None
        except ValueError:
            return None, f'{label} must be a real date (YYYY-MM-DD).'

    @api.model
    def _api_supplier_clean(self, payload, creating):
        """(vals, errors) from a create or update payload. On update only the keys present are looked at."""
        vals, errors = {}, {}
        for key, limit in TEXT_LIMITS.items():
            if key not in payload and not (creating and key in REQUIRED):
                continue
            raw = payload.get(key)
            if raw is not None and not isinstance(raw, str):
                errors[key] = f'{LABELS[key]} must be text.'
                continue
            text = (raw or '').strip()
            if not text and key in REQUIRED:
                errors[key] = f'{LABELS[key]} is needed.'
            elif len(text) > limit:
                errors[key] = f'{LABELS[key]} can have {limit} characters at most.'
            elif key == 'phone' and text and not PHONE.match(text):
                errors[key] = 'The phone number can only have digits, spaces and + ( ) - .'
            else:
                vals[key] = text or False
        if 'country_code' in payload or creating:
            code = payload.get('country_code') or 'PH'
            country = self.env['res.country'].search([('code', '=', code.upper())], limit=1) if isinstance(code, str) else None
            if country:
                vals['country_id'] = country.id
            else:
                errors['country_code'] = 'Choose a country.'
        if 'ships' in payload or creating:
            ships = payload.get('ships', False)
            if isinstance(ships, bool):
                vals['ships'] = ships
            else:
                errors['ships'] = 'Shipping must be on or off.'
        if 'shipping_fee' in payload or creating:
            fee, problem = self._api_cost(payload.get('shipping_fee', 0), 'The shipping amount')
            if problem:
                errors['shipping_fee'] = problem
            else:
                vals['shipping_fee'] = fee
        return vals, errors

    @api.model
    def _api_supplier_run(self, info, action):
        """Run `action` (which writes) in a savepoint. None when it worked; a rule that says no, or a duplicate that raced past the check,
        becomes the reply to send instead of an error, and nothing is half done."""
        try:
            with self.env.cr.savepoint():
                action()
            return None
        except UserError as error:
            return {**info, 'status': 'refused', 'message': str(error)}
        except Exception as error:  # noqa: BLE001 - only the unique-key violation is handled; the rest is raised again
            if (getattr(error, 'pgcode', None) or getattr(error, 'sqlstate', None)) == '23505':
                return {**info, 'status': 'refused', 'message': 'That already exists.'}
            raise

    # ------------------------------------------------------------------ what is sent back
    @api.model
    def _api_supplier_summary(self, supplier):
        return {
            'id': supplier.id, 'name': supplier.name, 'contact_name': supplier.contact_name, 'city': supplier.city,
            'phone': supplier.phone or None, 'active': supplier.active, 'permanently_off': supplier.permanently_off,
            'status': supplier.status, 'available_now': supplier.available_now,
            'ships': supplier.ships, 'shipping_fee': supplier.shipping_fee,
            'total_spent': supplier.total_spent, 'total_spent_vat': supplier.total_spent_vat, 'total_spent_net': supplier.total_spent_net,
            'received_count': supplier.received_count,
            'opening_balance': supplier.opening_balance, 'opening_balance_vat': supplier.opening_balance_vat, 'opening_balance_net': supplier.opening_balance_net,
            'combined_total': supplier.combined_total, 'combined_total_vat': supplier.combined_total_vat, 'combined_total_net': supplier.combined_total_net,
            'line_count': len(supplier.line_ids), 'range_count': len(supplier.unavailability_ids),
            'last_edited_by': supplier.last_edited_by or None,
            'last_edited_at': fields.Datetime.to_string(supplier.last_edited_at) if supplier.last_edited_at else None,
        }

    @api.model
    def _api_supplier_totals(self):
        """Over ALL the company's suppliers (inactive ones included): never the page, the search or the status filter. Every figure is a sum of
        the suppliers' own figures, so the screen's rows add up to it; the frontend adds nothing. Opening balance is a starting investment
        and received is what received restocks cost; combined is both. Only 'received' may be read as spending."""
        suppliers = self._api_supplier_model().search([('company_id', '=', self.env.company.id)])

        def add(name):
            return float_round(sum(suppliers.mapped(name)), precision_digits=2)

        return {
            'supplier_count': len(suppliers),
            'opening_balance': add('opening_balance'), 'opening_balance_vat': add('opening_balance_vat'), 'opening_balance_net': add('opening_balance_net'),
            'received_total': add('total_spent'), 'received_vat': add('total_spent_vat'), 'received_net': add('total_spent_net'),
            'combined_total': add('combined_total'), 'combined_vat': add('combined_total_vat'), 'combined_net': add('combined_total_net'),
        }

    @api.model
    def _api_supplier_attention(self):
        """What needs a look, over ALL the company's suppliers (never the page, the search or the status filter), read only, no money. Dates are
        ISO, Manila days. Nothing here re-works availability: a supplier is available exactly when its `status` (the existing available-now logic,
        models/supplier.py) says 'available'.
        - unavailable_now: every supplier whose status is not 'available' (inactive, switched off, or inside an unavailable range today). For a range
          it carries the end of the current range (the latest end among the ranges that cover today) and that range's reason; a switched-off or
          inactive supplier has no return date.
        - coming_up: every unavailable range that starts after today and within ATTENTION_DAYS days.
        - coverage_risk: each garment type that at most ONE currently available supplier can supply, read from the suppliers' supply lines by garment
          type (one line is enough). With none, `supplier` is null (no available supplier at all)."""
        today = today_manila()
        soon = today + datetime.timedelta(days=ATTENTION_DAYS)
        suppliers = self._api_supplier_model().search([('company_id', '=', self.env.company.id)])
        unavailable, coming = [], []
        for supplier in suppliers:
            if supplier.status != 'available':
                entry = {'id': supplier.id, 'name': supplier.name, 'status': supplier.status, 'until': None, 'reason': None}
                if supplier.status == 'unavailable_range':
                    current = supplier.unavailability_ids.filtered(lambda r: r.date_from <= today <= r.date_to)
                    last = max(current, key=lambda r: (r.date_to, r.id))
                    entry.update(until=fields.Date.to_string(last.date_to), reason=last.reason or None)
                unavailable.append(entry)
            for row in supplier.unavailability_ids:
                if today < row.date_from <= soon:
                    coming.append({'supplier_id': supplier.id, 'name': supplier.name, 'date_from': fields.Date.to_string(row.date_from),
                                   'date_to': fields.Date.to_string(row.date_to), 'reason': row.reason or None})
        unavailable.sort(key=lambda e: (e['name'].lower(), e['id']))
        coming.sort(key=lambda e: (e['date_from'], e['name'].lower()))
        available = suppliers.filtered(lambda s: s.status == 'available')
        covers = {}
        for garment, supplier in self.env['clothcraft.supplier.line'].sudo()._read_group([('supplier_id', 'in', available.ids)], ['garment_type_id', 'supplier_id']):
            covers.setdefault(garment.id, set()).add(supplier.id)
        risk = []
        for garment in self.env['clothcraft.garment.type'].sudo().search([]):
            who = covers.get(garment.id, set())
            if len(who) <= 1:
                only = available.browse(next(iter(who))) if who else None
                risk.append({'garment_type': {'id': garment.id, 'code': garment.code, 'name': garment.name},
                             'supplier': {'id': only.id, 'name': only.name} if only else None})
        risk.sort(key=lambda e: (e['supplier'] is not None, e['garment_type']['name'].lower()))  # "no available supplier" first
        return {'unavailable_now': unavailable, 'coming_up': coming, 'coverage_risk': risk}

    @api.model
    def _api_supplier_line_data(self, line):
        return {
            'id': line.id, 'supplier_id': line.supplier_id.id,
            'garment_type': {'id': line.garment_type_id.id, 'code': line.garment_type_id.code, 'name': line.garment_type_id.name},
            'size': {'id': line.size_value_id.id, 'name': line.size_value_id.name},
            'color': {'id': line.color_value_id.id, 'name': line.color_value_id.name},
            'unit_cost': line.unit_cost, 'unit_cost_vat': line.unit_cost_vat, 'unit_cost_net': line.unit_cost_net,
        }

    @api.model
    def _api_supplier_range_data(self, row):
        return {'id': row.id, 'supplier_id': row.supplier_id.id, 'date_from': fields.Date.to_string(row.date_from),
                'date_to': fields.Date.to_string(row.date_to), 'reason': row.reason or None}

    @api.model
    def _api_supplier_detail(self, supplier):
        supplier = supplier.sudo()
        country = supplier.country_id
        return {
            **self._api_supplier_summary(supplier),
            'street': supplier.street, 'street2': supplier.street2 or None, 'zip': supplier.zip or None,
            'country_code': country.code if country else None, 'country': country.name if country else None,
            'shipping_fee_vat': supplier.shipping_fee_vat, 'shipping_fee_net': supplier.shipping_fee_net,
            'partner_id': supplier.partner_id.id,
            'lines': [self._api_supplier_line_data(line) for line in supplier.line_ids],
            'ranges': [self._api_supplier_range_data(row) for row in supplier.unavailability_ids],
        }

    # ------------------------------------------------------------------ read
    @api.model
    def staff_suppliers(self, payload):
        """payload: sid_hash, q (part of the company or contact name), status (available, unavailable_range, off or inactive), limit, offset.
        status ok: suppliers (a summary each, inactive ones included), total, limit, offset, totals (over ALL suppliers, see _api_supplier_totals) and
        attention (over ALL suppliers too, see _api_supplier_attention)."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        Supplier = self._api_supplier_model()
        domain = []
        query = payload.get('q')
        if query is not None and not isinstance(query, str):
            return {**info, 'status': 'invalid', 'fields': {'q': 'Search with text.'}}
        if (query or '').strip():
            term = query.strip()[:100]
            domain += ['|', ('name', 'ilike', term), ('contact_name', 'ilike', term)]
        status = payload.get('status')
        if status:
            if status not in STATUSES:
                return {**info, 'status': 'invalid', 'fields': {'status': 'Choose a status from the list.'}}
            domain += {
                'inactive': [('active', '=', False)],
                'off': [('active', '=', True), ('permanently_off', '=', True)],
                'available': [('available_now', '=', True)],
                'unavailable_range': [('active', '=', True), ('permanently_off', '=', False), ('available_now', '=', False)],
            }[status]
        try:
            limit = min(max(int(payload.get('limit', 50)), 1), LIST_MAX)
            offset = max(int(payload.get('offset', 0)), 0)
        except (TypeError, ValueError):
            return {**info, 'status': 'invalid', 'fields': {'limit': 'The page size and start must be whole numbers.'}}
        return {**info, 'status': 'ok', 'total': Supplier.search_count(domain), 'limit': limit, 'offset': offset,
                'suppliers': [self._api_supplier_summary(s) for s in Supplier.search(domain, limit=limit, offset=offset)],
                'totals': self._api_supplier_totals(), 'attention': self._api_supplier_attention()}

    @api.model
    def staff_supplier(self, payload):
        """payload: sid_hash, supplier_id. status ok with the supplier, its supply lines and its unavailable ranges, or not_found."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        supplier, early = self._api_supplier_find(payload, info, staff, edit=False)
        if early:
            return early
        return {**info, 'status': 'ok', 'supplier': self._api_supplier_detail(supplier)}

    # ------------------------------------------------------------------ the supplier
    @api.model
    def supplier_create(self, payload):
        """payload: sid_hash, name, contact_name, street, city (all needed), street2, zip, phone, country_code (default PH), ships (bool),
        shipping_fee (VAT included). status done (with the supplier), invalid, refused."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        vals, errors = self._api_supplier_clean(payload, creating=True)
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        vals.update(self._api_supplier_stamp(staff), company_id=self.env.company.id)
        outcome = {}

        def make():
            outcome['supplier'] = self._api_supplier_model().create(vals)

        failed = self._api_supplier_run(info, make)
        return failed or {**info, 'status': 'done', 'supplier': self._api_supplier_detail(outcome['supplier'])}

    @api.model
    def supplier_update(self, payload):
        """payload: sid_hash, supplier_id and any of the create fields. Only the keys sent change. Inventory staff may not change an
        inactive or switched-off supplier. status done, invalid, forbidden, not_found, refused."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        supplier, early = self._api_supplier_find(payload, info, staff)
        if early:
            return early
        vals, errors = self._api_supplier_clean(payload, creating=False)
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        vals.update(self._api_supplier_stamp(staff))
        failed = self._api_supplier_run(info, lambda: supplier.write(vals))
        return failed or {**info, 'status': 'done', 'supplier': self._api_supplier_detail(supplier)}

    @api.model
    def _api_supplier_flag(self, payload, field, value):
        """Administrator only: set `active` or `permanently_off`. Already there is done, with nothing written."""
        info, staff, early = self._api_supplier_start(payload, admin_only=True)
        if early:
            return early
        supplier, early = self._api_supplier_find(payload, info, staff, edit=False)
        if early:
            return early
        if supplier[field] != value:
            supplier.write({field: value, **self._api_supplier_stamp(staff)})
        return {**info, 'status': 'done', 'supplier': self._api_supplier_detail(supplier)}

    @api.model
    def supplier_deactivate(self, payload):
        """Administrator only. payload: sid_hash, supplier_id. The supplier stays (its history is kept) but is out of every list that hides inactive ones."""
        return self._api_supplier_flag(payload, 'active', False)

    @api.model
    def supplier_reactivate(self, payload):
        """Administrator only. payload: sid_hash, supplier_id."""
        return self._api_supplier_flag(payload, 'active', True)

    @api.model
    def supplier_switch_off(self, payload):
        """Administrator only. payload: sid_hash, supplier_id. Unavailable for good, whatever the dates say."""
        return self._api_supplier_flag(payload, 'permanently_off', True)

    @api.model
    def supplier_switch_on(self, payload):
        """Administrator only. payload: sid_hash, supplier_id."""
        return self._api_supplier_flag(payload, 'permanently_off', False)

    @api.model
    def supplier_set_opening_balance(self, payload):
        """Administrator only. payload: sid_hash, supplier_id, opening_balance (VAT included, 0 up to OPENING_MAX, at most 2 decimals). Replaces the
        supplier's opening balance (no history is kept besides last_edited_by / last_edited_at). It is a starting investment for stock already
        held: no restock, stock move, lot or receipt is made. status done (with the supplier), invalid, forbidden, not_found, refused."""
        info, staff, early = self._api_supplier_start(payload, admin_only=True)
        if early:
            return early
        supplier, early = self._api_supplier_find(payload, info, staff, edit=False)
        if early:
            return early
        amount, problem = self._api_cost(payload.get('opening_balance'), 'The opening balance', high=OPENING_MAX)
        if problem:
            return {**info, 'status': 'invalid', 'fields': {'opening_balance': problem}}
        failed = self._api_supplier_run(info, lambda: supplier.write({'opening_balance': amount, **self._api_supplier_stamp(staff)}))
        return failed or {**info, 'status': 'done', 'supplier': self._api_supplier_detail(supplier)}

    # ------------------------------------------------------------------ supply lines
    @api.model
    def _api_line_resolve(self, payload, current=None):
        """(vals, errors) for a supply line: garment_type_id, size_value_id, color_value_id and unit_cost. On update (`current` is the
        line) a key that is missing keeps the line's value. The combination is checked once all three are known."""
        vals, errors = {}, {}
        models_by_key = {'garment_type_id': 'clothcraft.garment.type', 'size_value_id': 'product.attribute.value',
                         'color_value_id': 'product.attribute.value'}
        labels = {'garment_type_id': 'Choose a garment type.', 'size_value_id': 'Choose a size.', 'color_value_id': 'Choose a colour.'}
        found = {}
        for key, model in models_by_key.items():
            if key not in payload and current:
                found[key] = current[key]
                continue
            try:
                record = self.env[model].sudo().browse(int(payload.get(key))).exists()
            except (TypeError, ValueError):
                record = None
            if record:
                found[key] = record
                vals[key] = record.id
            else:
                errors[key] = labels[key]
        if 'unit_cost' in payload or not current:
            cost, problem = self._api_cost(payload.get('unit_cost'), 'The unit cost')
            if problem:
                errors['unit_cost'] = problem
            else:
                vals['unit_cost'] = cost
        if not errors:
            problem = self.env['clothcraft.supplier.line']._combo_problem(found['garment_type_id'], found['size_value_id'], found['color_value_id'])
            if problem:
                errors[problem[0]] = problem[1]
            else:
                vals.update({key: found[key].id for key in models_by_key})
        return vals, errors

    @api.model
    def _api_line_duplicate(self, supplier, vals, ignore=None):
        domain = [('supplier_id', '=', supplier.id)] + [(key, '=', vals[key]) for key in ('garment_type_id', 'size_value_id', 'color_value_id')]
        if ignore:
            domain.append(('id', '!=', ignore.id))
        return self.env['clothcraft.supplier.line'].sudo().search_count(domain, limit=1) > 0

    @api.model
    def supplier_line_add(self, payload):
        """payload: sid_hash, supplier_id, garment_type_id, size_value_id, color_value_id, unit_cost (VAT included). status done (with the
        line and the supplier), invalid (also a size or colour the garment type is not made in, or a line that exists), forbidden, not_found."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        supplier, early = self._api_supplier_find(payload, info, staff)
        if early:
            return early
        vals, errors = self._api_line_resolve(payload)
        if not errors and self._api_line_duplicate(supplier, vals):
            errors['garment_type_id'] = 'This supplier already has a supply line for that garment type, size and colour.'
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        outcome = {}

        def make():
            outcome['line'] = self.env['clothcraft.supplier.line'].sudo().create({**vals, 'supplier_id': supplier.id})
            supplier.write(self._api_supplier_stamp(staff))

        failed = self._api_supplier_run(info, make)
        return failed or {**info, 'status': 'done', 'line': self._api_supplier_line_data(outcome['line']),
                          'supplier': self._api_supplier_detail(supplier)}

    @api.model
    def supplier_line_update(self, payload):
        """payload: sid_hash, line_id and any of garment_type_id, size_value_id, color_value_id, unit_cost. status as supplier_line_add."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        line, early = self._api_supplier_find(payload, info, staff, key='line_id', model='clothcraft.supplier.line')
        if early:
            return early
        vals, errors = self._api_line_resolve(payload, current=line)
        if not errors and self._api_line_duplicate(line.supplier_id, vals, ignore=line):
            errors['garment_type_id'] = 'This supplier already has a supply line for that garment type, size and colour.'
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}

        def change():
            line.write(vals)
            line.supplier_id.write(self._api_supplier_stamp(staff))

        failed = self._api_supplier_run(info, change)
        return failed or {**info, 'status': 'done', 'line': self._api_supplier_line_data(line),
                          'supplier': self._api_supplier_detail(line.supplier_id)}

    @api.model
    def supplier_line_remove(self, payload):
        """payload: sid_hash, line_id. Deletes the line (no history is kept for a line). status done (with the supplier), forbidden, not_found."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        line, early = self._api_supplier_find(payload, info, staff, key='line_id', model='clothcraft.supplier.line')
        if early:
            return early
        supplier = line.supplier_id
        line.unlink()
        supplier.write(self._api_supplier_stamp(staff))
        return {**info, 'status': 'done', 'supplier': self._api_supplier_detail(supplier)}

    # ------------------------------------------------------------------ unavailable date ranges
    @api.model
    def _api_range_clean(self, payload, current=None):
        """(vals, errors): date_from, date_to (YYYY-MM-DD) and an optional reason. On update a missing key keeps the range's value."""
        vals, errors = {}, {}
        dates = {}
        for key, label in (('date_from', 'The first day'), ('date_to', 'The last day')):
            if key not in payload and current:
                dates[key] = current[key]
                continue
            day, problem = self._api_date(payload.get(key), label)
            if problem:
                errors[key] = problem
            else:
                dates[key] = vals[key] = day
        if len(dates) == 2 and dates['date_from'] > dates['date_to']:
            errors['date_to'] = 'The last day cannot be before the first day.'
        if 'reason' in payload:
            reason = payload.get('reason')
            if reason is not None and not isinstance(reason, str):
                errors['reason'] = 'The reason must be text.'
            elif len((reason or '').strip()) > REASON_LIMIT:
                errors['reason'] = f'The reason can have {REASON_LIMIT} characters at most.'
            else:
                vals['reason'] = (reason or '').strip() or False
        return vals, errors

    @api.model
    def supplier_range_add(self, payload):
        """payload: sid_hash, supplier_id, date_from, date_to (YYYY-MM-DD, both days count), reason (optional). Ranges may overlap.
        status done (with the range and the supplier), invalid, forbidden, not_found."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        supplier, early = self._api_supplier_find(payload, info, staff)
        if early:
            return early
        vals, errors = self._api_range_clean(payload)
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        outcome = {}

        def make():
            outcome['range'] = self.env['clothcraft.supplier.unavailability'].sudo().with_context(clothcraft_actor=staff['user'].id).create({**vals, 'supplier_id': supplier.id})
            supplier.write(self._api_supplier_stamp(staff))

        failed = self._api_supplier_run(info, make)
        return failed or {**info, 'status': 'done', 'range': self._api_supplier_range_data(outcome['range']),
                          'supplier': self._api_supplier_detail(supplier)}

    @api.model
    def supplier_range_update(self, payload):
        """payload: sid_hash, range_id and any of date_from, date_to, reason. status as supplier_range_add."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        row, early = self._api_supplier_find(payload, info, staff, key='range_id', model='clothcraft.supplier.unavailability')
        if early:
            return early
        vals, errors = self._api_range_clean(payload, current=row)
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}

        def change():
            row.with_context(clothcraft_actor=staff['user'].id).write(vals)
            row.supplier_id.write(self._api_supplier_stamp(staff))

        failed = self._api_supplier_run(info, change)
        return failed or {**info, 'status': 'done', 'range': self._api_supplier_range_data(row),
                          'supplier': self._api_supplier_detail(row.supplier_id)}

    @api.model
    def supplier_range_remove(self, payload):
        """payload: sid_hash, range_id. Deletes the range. status done (with the supplier), forbidden, not_found."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        row, early = self._api_supplier_find(payload, info, staff, key='range_id', model='clothcraft.supplier.unavailability')
        if early:
            return early
        supplier = row.supplier_id
        row.unlink()
        supplier.write(self._api_supplier_stamp(staff))
        return {**info, 'status': 'done', 'supplier': self._api_supplier_detail(supplier)}
