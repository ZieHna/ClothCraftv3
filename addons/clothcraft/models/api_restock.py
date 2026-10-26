"""The staff side of restocks (Supplier and Restock, phase 2): the request form's data, a list, one request with its lines and history,
create and change a request, and (Administrator only) approve, reject, receive and mark not received.

Session, role, error style and the savepoint wrapper are phase 1's (api_supplier.py); the rules and the stock receipt live in
models/restock.py, so this file only checks the payload and calls them. Every write is done with sudo as the signed-in staff member, so the
stock moves and the history name them. Every reply is {status, ...}: done, ok (a read), unauthorised, forbidden, not_found, invalid
(`fields`: field -> sentence), invalid_transition (`current`, `message`) or refused (a rule said no: `message`).
"""
from odoo import api, fields, models

from .restock import LABELS, LINES_MAX, LOT_LIMIT, NEXT, NOTE_LIMIT, NOTE_MIN, QTY_MAX, a_restock
from .supplier import today_manila

STATES = tuple(LABELS)
LIST_MAX = 100


class ClothcraftApiRestock(models.AbstractModel):
    _inherit = 'clothcraft.api'

    # ------------------------------------------------------------------ shared pieces
    @api.model
    def _api_restock_model(self, staff=None, via='dashboard', note=None):
        """The restock model, with sudo, as this staff member (so the history and the stock moves name them)."""
        model = self.env['clothcraft.restock'].with_context(active_test=False, clothcraft_via=via, clothcraft_note=note)
        return model.with_user(staff['user']).sudo() if staff else model.sudo()

    @api.model
    def _api_restock_find(self, payload, info, staff, key='restock_id'):
        try:
            restock = self._api_restock_model(staff).browse(int(payload.get(key))).exists()
        except (TypeError, ValueError):
            restock = None
        return (restock, None) if restock else (None, {**info, 'status': 'not_found'})

    @api.model
    def _api_quantity(self, value, label, low=1):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
            return None, f'{label} must be a whole number.'
        if not low <= value <= QTY_MAX:
            return None, f'{label} must be from {low} to {QTY_MAX}.'
        return int(value), None

    @api.model
    def _api_note(self, payload, required):
        """(note, sentence)."""
        note = payload.get('note')
        if note is not None and not isinstance(note, str):
            return None, 'The note must be text.'
        note = (note or '').strip()
        if required and len(note) < NOTE_MIN:
            return None, f'Write a short note (at least {NOTE_MIN} characters).'
        if len(note) > NOTE_LIMIT:
            return None, f'Keep the note to {NOTE_LIMIT} characters or fewer.'
        return note or None, None

    @api.model
    def _api_restock_lines(self, rows, supplier, existing=None):
        """(Command list, errors) from the `lines` of a request: [{product_id, quantity, unit_cost?}]. A variant must match one of the
        supplier's supply lines. On update (`existing` is the restock's current lines) the list REPLACES them: a variant already there is
        changed, a new one added, one left out removed."""
        errors, commands, seen = {}, [], set()
        if not isinstance(rows, list) or not 1 <= len(rows) <= LINES_MAX:
            return None, {'lines': f'Add from 1 to {LINES_MAX} lines.'}
        current = {line.product_id.id: line for line in existing} if existing else {}
        Line = self.env['clothcraft.restock.line']
        for index, row in enumerate(rows, start=1):
            where = f'Line {index}: '
            if not isinstance(row, dict):
                errors['lines'] = where + 'is not a line.'
                break
            try:
                product = self.env['product.product'].sudo().browse(int(row.get('product_id'))).exists()
            except (TypeError, ValueError):
                product = None
            if not product or not product.active:
                errors['lines'] = where + 'choose a variant.'
                break
            if product.id in seen:
                errors['lines'] = where + f'{product.display_name} is on the request twice.'
                break
            seen.add(product.id)
            if not Line._supply_line_for(supplier, product):
                errors['lines'] = where + f'{supplier.name} has no supply line for {product.display_name}.'
                break
            qty, problem = self._api_quantity(row.get('quantity'), where + 'the quantity')
            if problem:
                errors['lines'] = problem
                break
            vals = {'quantity': qty}
            if row.get('unit_cost') is not None:
                cost, problem = self._api_cost(row['unit_cost'], where + 'the unit cost')
                if problem:
                    errors['lines'] = problem
                    break
                vals['unit_cost'] = cost
            if product.id in current:
                commands.append((1, current[product.id].id, vals))
            else:
                commands.append((0, 0, {**vals, 'product_id': product.id}))
        if errors:
            return None, errors
        commands += [(2, line.id) for pid, line in current.items() if pid not in seen]
        return commands, {}

    @api.model
    def _api_restock_fields(self, payload, creating, restock=None):
        """(vals, errors) for the request's own fields. On update only the keys sent are looked at."""
        vals, errors = {}, {}
        if 'shipping_on' in payload or creating:
            on = payload.get('shipping_on', False)
            if isinstance(on, bool):
                vals['shipping_on'] = on
            else:
                errors['shipping_on'] = 'Shipping must be on or off.'
        if 'shipping_fee' in payload:
            fee, problem = self._api_cost(payload['shipping_fee'], 'The shipping amount')
            if problem:
                errors['shipping_fee'] = problem
            else:
                vals['shipping_fee'] = fee
        days = {}
        for key, label in (('expected_from', 'The first expected day'), ('expected_to', 'The last expected day')):
            if key not in payload and not creating:
                days[key] = restock[key]
                continue
            day, problem = self._api_date(payload.get(key), label)
            if problem:
                errors[key] = problem
            else:
                days[key] = vals[key] = day
        if len(days) == 2 and days['expected_from'] > days['expected_to']:
            errors['expected_to'] = 'The last expected day cannot be before the first.'
        if 'request_note' in payload:
            text = payload['request_note']
            if text is not None and not isinstance(text, str):
                errors['request_note'] = 'The note must be text.'
            elif len((text or '').strip()) > NOTE_LIMIT:
                errors['request_note'] = f'Keep the note to {NOTE_LIMIT} characters or fewer.'
            else:
                vals['request_note'] = (text or '').strip() or False
        return vals, errors

    # ------------------------------------------------------------------ what is sent back
    @api.model
    def _api_restock_summary(self, restock):
        return {
            'id': restock.id, 'name': restock.name, 'state': restock.state,
            'supplier': {'id': restock.supplier_id.id, 'name': restock.supplier_id.name},
            'line_count': len(restock.line_ids), 'estimate_total': restock.estimate_total,
            'expected_from': fields.Date.to_string(restock.expected_from), 'expected_to': fields.Date.to_string(restock.expected_to),
            'shipping_on': restock.shipping_on, 'shipping_applied': restock.shipping_applied,
            'requested_by': restock.requested_by, 'requested_at': fields.Datetime.to_string(restock.requested_at),
            'received_on': fields.Date.to_string(restock.received_on) if restock.received_on else None,
            'received_late': restock.received_late, 'overdue': restock.overdue,
            'actual_cost': restock.actual_cost if restock.state == 'received' else None,
        }

    @api.model
    def _api_restock_detail(self, restock):
        restock = restock.sudo()
        picking = restock.picking_id
        return {
            **self._api_restock_summary(restock),
            'shipping_fee': restock.shipping_fee, 'request_note': restock.request_note or None,
            'decided_by': restock.decided_by or None, 'decision_note': restock.decision_note or None,
            'decided_at': fields.Datetime.to_string(restock.decided_at) if restock.decided_at else None,
            'received_by': restock.received_by or None,
            'received_at': fields.Datetime.to_string(restock.received_at) if restock.received_at else None,
            'goods_cost': restock.goods_cost, 'shipping_cost': restock.shipping_cost, 'actual_cost': restock.actual_cost,
            'actual_vat': restock.actual_vat, 'actual_net': restock.actual_net,
            'stock_receipt': picking.name if picking else None,
            'lines': [{
                'id': line.id, 'product_id': line.product_id.id, 'sku': line.product_id.default_code or None,
                'name': line.product_id.display_name,
                'garment_type': {'id': line.garment_type_id.id, 'code': line.garment_type_id.code, 'name': line.garment_type_id.name},
                'size': {'id': line.size_value_id.id, 'name': line.size_value_id.name},
                'color': {'id': line.color_value_id.id, 'name': line.color_value_id.name},
                'quantity': line.quantity, 'unit_cost': line.unit_cost,
                'quantity_received': line.quantity_received if restock.state == 'received' else None,
                'lot': line.lot_id.name if line.lot_id else None,
                'received_cost': line.received_cost if restock.state == 'received' else None,
            } for line in restock.line_ids],
            'history': [{
                'id': row.id, 'event': row.event, 'from_state': row.from_state or None, 'to_state': row.to_state,
                'staff_name': row.staff_name, 'note': row.note or None, 'at': fields.Datetime.to_string(row.create_date), 'via': row.via,
            } for row in restock.history_ids],
        }

    # ------------------------------------------------------------------ read
    @api.model
    def staff_restock_options(self, payload):
        """payload: sid_hash, supplier_id (optional: one supplier only). status ok with the suppliers available now, each with its shipping
        and its supply lines (garment type, size, colour, unit cost) and, per supply line, the variants that match it (a garment type has
        several products, so several variants can match one supply line)."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        domain = [('available_now', '=', True)]
        if payload.get('supplier_id') is not None:
            try:
                domain.append(('id', '=', int(payload['supplier_id'])))
            except (TypeError, ValueError):
                return {**info, 'status': 'invalid', 'fields': {'supplier_id': 'Choose a supplier.'}}
        suppliers = self._api_supplier_model().search(domain)
        variants = {}  # garment type id -> [(variant, its attribute value ids)]
        for garment in suppliers.line_ids.garment_type_id:
            found = self.env['product.product'].sudo().search([('product_tmpl_id.garment_type_id', '=', garment.id), ('active', '=', True)])
            variants[garment.id] = [(v, set(v.product_template_attribute_value_ids.product_attribute_value_id.ids)) for v in found]
        out = []
        for supplier in suppliers:
            rows = []
            for line in supplier.line_ids:
                match = [v for v, values in variants.get(line.garment_type_id.id, []) if line.size_value_id.id in values and line.color_value_id.id in values]
                rows.append({
                    **self._api_supplier_line_data(line),
                    'variants': [{'id': v.id, 'sku': v.default_code or None, 'name': v.display_name} for v in match],
                })
            out.append({'id': supplier.id, 'name': supplier.name, 'ships': supplier.ships, 'shipping_fee': supplier.shipping_fee, 'lines': rows})
        return {**info, 'status': 'ok', 'suppliers': out}

    @api.model
    def staff_restocks(self, payload):
        """payload: sid_hash, q (reference or supplier), state, supplier_id, late (true: received late), overdue (true), limit, offset.
        status ok: restocks (a summary each, newest first), total, limit, offset."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        domain = []
        query = payload.get('q')
        if query is not None and not isinstance(query, str):
            return {**info, 'status': 'invalid', 'fields': {'q': 'Search with text.'}}
        if (query or '').strip():
            term = query.strip()[:100]
            domain += ['|', ('name', 'ilike', term), ('supplier_id.name', 'ilike', term)]
        if payload.get('state'):
            if payload['state'] not in STATES:
                return {**info, 'status': 'invalid', 'fields': {'state': 'Choose a state from the list.'}}
            domain.append(('state', '=', payload['state']))
        if payload.get('supplier_id') is not None:
            try:
                domain.append(('supplier_id', '=', int(payload['supplier_id'])))
            except (TypeError, ValueError):
                return {**info, 'status': 'invalid', 'fields': {'supplier_id': 'Choose a supplier.'}}
        if payload.get('late') is True:
            domain.append(('received_late', '=', True))
        if payload.get('overdue') is True:
            today = fields.Date.to_string(today_manila())
            domain += [('state', 'in', ('approved', 'not_received')), ('expected_to', '<', today)]
        try:
            limit = min(max(int(payload.get('limit', 50)), 1), LIST_MAX)
            offset = max(int(payload.get('offset', 0)), 0)
        except (TypeError, ValueError):
            return {**info, 'status': 'invalid', 'fields': {'limit': 'The page size and start must be whole numbers.'}}
        Restock = self._api_restock_model()
        return {**info, 'status': 'ok', 'total': Restock.search_count(domain), 'limit': limit, 'offset': offset,
                'restocks': [self._api_restock_summary(r) for r in Restock.search(domain, limit=limit, offset=offset)]}

    @api.model
    def staff_restock(self, payload):
        """payload: sid_hash, restock_id. status ok with the restock, its lines and its history, or not_found."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        restock, early = self._api_restock_find(payload, info, staff)
        if early:
            return early
        return {**info, 'status': 'ok', 'restock': self._api_restock_detail(restock)}

    # ------------------------------------------------------------------ the request (Inventory staff and the Administrator)
    @api.model
    def restock_create(self, payload):
        """payload: sid_hash, supplier_id (available now), lines [{product_id, quantity, unit_cost?}], shipping_on (bool), shipping_fee
        (optional: the supplier's is copied), expected_from, expected_to (YYYY-MM-DD), request_note. status done (with the restock),
        invalid, refused."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        supplier, early = self._api_supplier_find(payload, info, staff, edit=False)
        if early:
            return early
        vals, errors = self._api_restock_fields(payload, creating=True)
        commands, line_errors = self._api_restock_lines(payload.get('lines'), supplier)
        errors.update(line_errors)
        if not supplier.available_now:
            errors['supplier_id'] = f'{supplier.name} is not available now.'
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        outcome = {}

        def make():
            outcome['restock'] = self._api_restock_model(staff).create({**vals, 'supplier_id': supplier.id, 'line_ids': commands})

        failed = self._api_supplier_run(info, make)
        return failed or {**info, 'status': 'done', 'restock': self._api_restock_detail(outcome['restock'])}

    @api.model
    def restock_update(self, payload):
        """payload: sid_hash, restock_id and any of lines (REPLACES the lines), shipping_on, shipping_fee, expected_from, expected_to,
        request_note, note (for the history). Only while `requested`. status done, invalid, invalid_transition, not_found, refused."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        restock, early = self._api_restock_find(payload, info, staff)
        if early:
            return early
        if restock.state != 'requested':
            return {**info, 'status': 'invalid_transition', 'current': restock.state,
                    'message': f'{a_restock(restock.state)} can no longer be changed.'}
        vals, errors = self._api_restock_fields(payload, creating=False, restock=restock)
        if 'lines' in payload:
            commands, line_errors = self._api_restock_lines(payload['lines'], restock.supplier_id, existing=restock.line_ids)
            errors.update(line_errors)
            if commands is not None:
                vals['line_ids'] = commands
        note, problem = self._api_note(payload, required=False)
        if problem:
            errors['note'] = problem
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        if not vals:
            return {**info, 'status': 'done', 'restock': self._api_restock_detail(restock)}
        target = self._api_restock_model(staff, note=note).browse(restock.id)
        failed = self._api_supplier_run(info, lambda: target.write(vals))
        return failed or {**info, 'status': 'done', 'restock': self._api_restock_detail(target)}

    # ------------------------------------------------------------------ the moves (Administrator only)
    @api.model
    def _api_restock_move(self, payload, to, note_required=False, receive=False):
        info, staff, early = self._api_supplier_start(payload, admin_only=True)
        if early:
            return early
        restock, early = self._api_restock_find(payload, info, staff)
        if early:
            return early
        if to not in NEXT.get(restock.state, ()):
            message = 'This restock was already received. Nothing was done.' if restock.state == 'received' else f'{a_restock(restock.state)} cannot be {LABELS[to]}.'
            return {**info, 'status': 'invalid_transition', 'current': restock.state, 'message': message, 'restock': self._api_restock_detail(restock)}
        note, problem = self._api_note(payload, required=note_required)
        if problem:
            return {**info, 'status': 'invalid', 'fields': {'note': problem}}
        args = {}
        if receive:
            quantities = payload.get('quantities')
            if quantities is not None and not isinstance(quantities, dict):
                return {**info, 'status': 'invalid', 'fields': {'quantities': 'Send the received quantity per line.'}}
            errors = {}
            for key, value in (quantities or {}).items():
                _, problem = self._api_quantity(value, f'The quantity for line {key}', low=0)
                if problem or not str(key).isdigit():
                    errors['quantities'] = problem or 'A quantity belongs to a line id.'
                    break
            received_on = None
            if payload.get('received_on') is not None:
                received_on, problem = self._api_date(payload['received_on'], 'The day the goods arrived')
                if problem:
                    errors['received_on'] = problem
            if errors:
                return {**info, 'status': 'invalid', 'fields': errors}
            lots = payload.get('lots')
            if lots is not None and not isinstance(lots, dict):
                errors['lots'] = 'Send the lot name per line.'
            for key, value in (lots or {}).items() if isinstance(lots, dict) else ():
                if not str(key).isdigit() or not isinstance(value, str) or not 1 <= len(value.strip()) <= LOT_LIMIT or not value.strip().isprintable():
                    errors['lots'] = f'A lot name is 1 to {LOT_LIMIT} printable characters, given per line id.'
                    break
            if errors:
                return {**info, 'status': 'invalid', 'fields': errors}
            args = {'quantities': quantities, 'received_on': received_on, 'lots': lots}
        target = self._api_restock_model(staff).browse(restock.id)
        method = {'approved': 'action_approve', 'rejected': 'action_reject', 'not_received': 'action_not_received', 'received': 'action_receive'}[to]
        failed = self._api_supplier_run(info, lambda: getattr(target, method)(note=note, **args))
        if failed:
            target.invalidate_recordset()
            return {**failed, 'current': target.state}
        return {**info, 'status': 'done', 'restock': self._api_restock_detail(target)}

    @api.model
    def restock_approve(self, payload):
        """Administrator only. payload: sid_hash, restock_id, note (optional). requested -> approved."""
        return self._api_restock_move(payload, 'approved')

    @api.model
    def restock_reject(self, payload):
        """Administrator only. payload: sid_hash, restock_id, note (needed). requested -> rejected, which is final."""
        return self._api_restock_move(payload, 'rejected', note_required=True)

    @api.model
    def restock_not_received(self, payload):
        """Administrator only. payload: sid_hash, restock_id, note (optional). approved -> not_received (it stays visible and can still be received)."""
        return self._api_restock_move(payload, 'not_received')

    @api.model
    def restock_receive(self, payload):
        """Administrator only. payload: sid_hash, restock_id, quantities ({line id: received quantity}; a line left out arrived in full),
        received_on (YYYY-MM-DD, default today in Manila, never in the future), lots ({line id: lot name}, optional: a line left out gets ticket reference + SKU; a name that already exists for the product is refused), note (optional). approved or not_received -> received, once:
        the stock is added through a native receipt and the actual cost is recorded, all or nothing."""
        return self._api_restock_move(payload, 'received', receive=True)
