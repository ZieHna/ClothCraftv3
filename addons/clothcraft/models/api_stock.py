"""The staff side of stock (Supplier and Restock, phase 3): list stock with its low-stock level, the edit history, edit a variant's on-hand
quantity, and (Administrator only) set the global level or a variant's own level.

Session, role, error style and the savepoint wrapper are phase 1's (api_supplier.py). The rules live in models/stock_alert.py: an edit goes
through Odoo's inventory adjustment as the signed-in staff member (so the stock moves and the history name them), all or nothing. Every reply
is {status, ...}: done, ok (a read), unauthorised, forbidden, not_found, invalid (`fields`) or refused (a rule said no: `message`).
"""
from odoo import api, fields, models

from .stock_alert import QTY_MAX, REASON_MAX, REASON_MIN, THRESHOLD_MAX

LIST_MAX = 100


class ClothcraftApiStock(models.AbstractModel):
    _inherit = 'clothcraft.api'

    # ------------------------------------------------------------------ shared pieces
    @api.model
    def _api_stock_variant(self, payload, info, key='product_id'):
        """(garment variant, early reply)."""
        try:
            product = self.env['product.product'].sudo().browse(int(payload.get(key))).exists()
        except (TypeError, ValueError):
            product = None
        if not product or not product.active or not product.product_tmpl_id.garment_type_id:
            return None, {**info, 'status': 'not_found'}
        return product, None

    @api.model
    def _api_whole(self, value, label, low, high):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
            return None, f'{label} must be a whole number.'
        if not low <= value <= high:
            return None, f'{label} must be from {low} to {high}.'
        return int(value), None

    @api.model
    def _api_stock_rows(self, products):
        """One dict per variant: on hand, reserved, free, its own level, the level that applies and where it comes from, and the low flag."""
        Alert = self.env['clothcraft.stock.alert']
        stock, levels = Alert._on_hand(products), Alert._levels(products)
        rows = []
        for product in products:
            on_hand, reserved = stock[product.id]
            level, source, own = levels[product.id]
            rows.append({
                'id': product.id, 'sku': product.default_code or None, 'name': product.display_name,
                'garment_type': {'id': product.product_tmpl_id.garment_type_id.id, 'code': product.product_tmpl_id.garment_type_id.code},
                'on_hand': int(on_hand), 'reserved': int(reserved), 'free': int(on_hand - reserved),
                'threshold': own, 'effective_threshold': level, 'threshold_source': source, 'low': on_hand < level,
            })
        return rows

    @api.model
    def _api_global_threshold(self):
        row = self.env['clothcraft.stock.threshold'].sudo().search([('scope', '=', 'global'), ('company_id', '=', self.env.company.id)], limit=1)
        return row.threshold if row else None

    # ------------------------------------------------------------------ read
    @api.model
    def staff_stock(self, payload):
        """payload: sid_hash, q (name or SKU), low (true: only low variants), limit, offset. status ok: variants (low first, then by SKU),
        total, limit, offset and the global level."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        domain = [('product_tmpl_id.garment_type_id', '!=', False)]
        query = payload.get('q')
        if query is not None and not isinstance(query, str):
            return {**info, 'status': 'invalid', 'fields': {'q': 'Search with text.'}}
        if (query or '').strip():
            term = query.strip()[:100]
            domain += ['|', ('default_code', 'ilike', term), ('product_tmpl_id.name', 'ilike', term)]
        try:
            limit = min(max(int(payload.get('limit', 50)), 1), LIST_MAX)
            offset = max(int(payload.get('offset', 0)), 0)
        except (TypeError, ValueError):
            return {**info, 'status': 'invalid', 'fields': {'limit': 'The page size and start must be whole numbers.'}}
        rows = self._api_stock_rows(self.env['product.product'].sudo().search(domain, order='default_code, id'))
        if payload.get('low') is True:
            rows = [r for r in rows if r['low']]
        rows.sort(key=lambda r: (not r['low'], r['sku'] or ''))
        return {**info, 'status': 'ok', 'total': len(rows), 'limit': limit, 'offset': offset, 'variants': rows[offset:offset + limit],
                'global_threshold': self._api_global_threshold(), 'default_threshold': 5}

    @api.model
    def staff_stock_history(self, payload):
        """payload: sid_hash, product_id (optional: one variant), limit, offset. status ok: edits (newest first), total."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        domain = []
        if payload.get('product_id') is not None:
            product, early = self._api_stock_variant(payload, info)
            if early:
                return early
            domain.append(('product_id', '=', product.id))
        try:
            limit = min(max(int(payload.get('limit', 50)), 1), LIST_MAX)
            offset = max(int(payload.get('offset', 0)), 0)
        except (TypeError, ValueError):
            return {**info, 'status': 'invalid', 'fields': {'limit': 'The page size and start must be whole numbers.'}}
        Edit = self.env['clothcraft.stock.edit'].sudo()
        return {**info, 'status': 'ok', 'total': Edit.search_count(domain), 'limit': limit, 'offset': offset, 'edits': [{
            'id': e.id, 'product_id': e.product_id.id, 'sku': e.product_id.default_code or None, 'name': e.product_id.display_name,
            'old_qty': e.old_qty, 'new_qty': e.new_qty, 'delta': e.delta, 'reason': e.reason, 'detail': e.detail or None,
            'staff_name': e.staff_name, 'via': e.via, 'at': fields.Datetime.to_string(e.create_date),
        } for e in Edit.search(domain, limit=limit, offset=offset)]}

    # ------------------------------------------------------------------ the edit (Inventory staff and the Administrator)
    @api.model
    def stock_set(self, payload):
        """payload: sid_hash, product_id, quantity (the new on-hand quantity: a whole number from 0), reason (5 to 500 characters). Done
        through Odoo's inventory adjustment, all or nothing; it never changes the product's cost. status done (with the variant row and
        the history row), invalid, not_found, refused (the same number, below what orders have reserved, ...)."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        product, early = self._api_stock_variant(payload, info)
        if early:
            return early
        errors = {}
        quantity, problem = self._api_whole(payload.get('quantity'), 'The quantity', 0, QTY_MAX)
        if problem:
            errors['quantity'] = problem
        reason = payload.get('reason')
        if not isinstance(reason, str) or not REASON_MIN <= len(reason.strip()) <= REASON_MAX:
            errors['reason'] = f'Write a reason of {REASON_MIN} to {REASON_MAX} characters.'
        if errors:
            return {**info, 'status': 'invalid', 'fields': errors}
        edit = self.env['clothcraft.stock.edit'].with_user(staff['user']).sudo().with_context(clothcraft_via='dashboard', clothcraft_actor=staff['user'].id)
        outcome = {}

        def make():
            outcome['edit'] = edit._set_on_hand(product, quantity, reason)

        failed = self._api_supplier_run(info, make)
        if failed:
            return failed
        row = outcome['edit']
        return {**info, 'status': 'done', 'variant': self._api_stock_rows(product)[0],
                'edit': {'id': row.id, 'old_qty': row.old_qty, 'new_qty': row.new_qty, 'delta': row.delta, 'reason': row.reason, 'detail': row.detail}}

    # ------------------------------------------------------------------ the levels (Administrator only)
    @api.model
    def stock_threshold_set_global(self, payload):
        """Administrator only. payload: sid_hash, threshold (whole number from 0; 0 means no variant is ever low on this level). Changing a
        level updates every variant's low state silently (no notifications)."""
        info, staff, early = self._api_supplier_start(payload, admin_only=True)
        if early:
            return early
        value, problem = self._api_whole(payload.get('threshold'), 'The level', 0, THRESHOLD_MAX)
        if problem:
            return {**info, 'status': 'invalid', 'fields': {'threshold': problem}}
        Threshold = self.env['clothcraft.stock.threshold'].with_user(staff['user']).sudo().with_context(clothcraft_actor=staff['user'].id)
        row = Threshold.search([('scope', '=', 'global'), ('company_id', '=', self.env.company.id)], limit=1)
        if row:
            row.write({'threshold': value})
        else:
            Threshold.create({'scope': 'global', 'threshold': value})
        return {**info, 'status': 'done', 'global_threshold': value}

    @api.model
    def stock_threshold_set_variant(self, payload):
        """Administrator only. payload: sid_hash, product_id, threshold (whole number from 0, or null to remove the variant's own level)."""
        info, staff, early = self._api_supplier_start(payload, admin_only=True)
        if early:
            return early
        product, early = self._api_stock_variant(payload, info)
        if early:
            return early
        Threshold = self.env['clothcraft.stock.threshold'].with_user(staff['user']).sudo().with_context(clothcraft_actor=staff['user'].id)
        row = Threshold.search([('scope', '=', 'variant'), ('product_id', '=', product.id), ('company_id', '=', self.env.company.id)], limit=1)
        if payload.get('threshold') is None:
            row.unlink()
        else:
            value, problem = self._api_whole(payload['threshold'], 'The level', 0, THRESHOLD_MAX)
            if problem:
                return {**info, 'status': 'invalid', 'fields': {'threshold': problem}}
            if row:
                row.write({'threshold': value})
            else:
                Threshold.create({'scope': 'variant', 'product_id': product.id, 'threshold': value})
        return {**info, 'status': 'done', 'variant': self._api_stock_rows(product)[0]}
