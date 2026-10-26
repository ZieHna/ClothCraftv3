"""The bell (Supplier and Restock, phase 3): a staff member's own notifications, with the unread count; mark one read; mark all read.

Same session and role checks as the other staff methods (api_supplier.py). Only the person's own rows are ever read or marked: another
person's notification is not_found. Marking is idempotent. Reply status: ok / done, unauthorised, not_found, invalid.
"""
from odoo import api, fields, models

LIST_MAX = 100


class ClothcraftApiNotification(models.AbstractModel):
    _inherit = 'clothcraft.api'

    @api.model
    def _api_notification_model(self, staff):
        return self.env['clothcraft.notification'].sudo()

    @api.model
    def _api_notification_data(self, note):
        return {
            'id': note.id, 'kind': note.kind, 'title': note.title, 'body': note.body or None,
            'restock_id': note.restock_id.id or None, 'supplier_id': note.supplier_id.id or None, 'product_id': note.product_id.id or None, 'employee_id': note.employee_id.id or None,
            'created_at': fields.Datetime.to_string(note.create_date), 'read': bool(note.read_at),
            'read_at': fields.Datetime.to_string(note.read_at) if note.read_at else None,
        }

    @api.model
    def staff_notifications(self, payload):
        """payload: sid_hash, unread_only (true), limit, offset. status ok: notifications (newest first), total, unread_count."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        Note = self._api_notification_model(staff)
        mine = [('user_id', '=', staff['user'].id)]
        domain = mine + ([('read_at', '=', False)] if payload.get('unread_only') is True else [])
        try:
            limit = min(max(int(payload.get('limit', 50)), 1), LIST_MAX)
            offset = max(int(payload.get('offset', 0)), 0)
        except (TypeError, ValueError):
            return {**info, 'status': 'invalid', 'fields': {'limit': 'The page size and start must be whole numbers.'}}
        return {**info, 'status': 'ok', 'total': Note.search_count(domain), 'limit': limit, 'offset': offset,
                'unread_count': Note.search_count(mine + [('read_at', '=', False)]),
                'notifications': [self._api_notification_data(n) for n in Note.search(domain, limit=limit, offset=offset)]}

    @api.model
    def staff_notification_read(self, payload):
        """payload: sid_hash, notification_id. Marks one of the person's own notifications read (again is fine). status done with the
        notification and the new unread_count, or not_found."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        Note = self._api_notification_model(staff)
        try:
            note = Note.search([('id', '=', int(payload.get('notification_id'))), ('user_id', '=', staff['user'].id)])
        except (TypeError, ValueError):
            note = None
        if not note:
            return {**info, 'status': 'not_found'}
        if not note.read_at:
            note.write({'read_at': fields.Datetime.now()})
        return {**info, 'status': 'done', 'notification': self._api_notification_data(note),
                'unread_count': Note.search_count([('user_id', '=', staff['user'].id), ('read_at', '=', False)])}

    @api.model
    def staff_notifications_read_all(self, payload):
        """payload: sid_hash. Marks all of the person's own unread notifications read. status done with how many were marked and unread_count 0."""
        info, staff, early = self._api_supplier_start(payload)
        if early:
            return early
        unread = self._api_notification_model(staff).search([('user_id', '=', staff['user'].id), ('read_at', '=', False)])
        unread.write({'read_at': fields.Datetime.now()})
        return {**info, 'status': 'done', 'marked': len(unread), 'unread_count': 0}
