"""What the staff-dashboard and order-tracking tests share: a garment with stock, the service user, a customer, two Inventory Staff and an
Administrator with live sessions, the clock the facade reads, and helpers to place and move orders (as the service user)."""
import uuid
from contextlib import contextmanager
from datetime import timedelta
from unittest.mock import patch

from odoo import Command, fields
from odoo.tests import TransactionCase

PASSWORD = 'a staff password for the tests'
DELIVERY = {'name': 'Ana Cruz', 'email': 'ana@example.com', 'phone': '0917 123 4567', 'street': '12 Rizal Street', 'city': 'Quezon City',
            'province': 'PH-00', 'postal_code': '1100', 'note': ''}




class StaffOrderCase(TransactionCase):
    """The set-up both use (see the module docstring). It has no tests of its own."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.tag = uuid.uuid4().hex[:6]
        cls.warehouse = env['stock.warehouse'].search([('company_id', '=', env.company.id)], limit=1)
        garment = env['clothcraft.garment.type'].create({'name': f'Shirt {cls.tag}', 'code': f'S{cls.tag}'})
        cls.template = env['product.template'].create({'name': f'Staff Tee {cls.tag}', 'garment_type_id': garment.id, 'list_price': 350.0, 'is_published': True, 'sale_ok': True,
                                                      'clothcraft_group': 'Men', 'clothcraft_slug': f'staff-{cls.tag}'})
        cls.variant = cls.template.product_variant_id
        cls.variant.default_code = f'STF-{cls.tag}'
        env['stock.quant']._update_available_quantity(cls.variant, cls.warehouse.lot_stock_id, 200)
        cls.api_user = env['res.users'].create({
            'name': f'api {cls.tag}', 'login': f'apis_{cls.tag}', 'group_ids': [Command.set([env.ref('base.group_user').id, env.ref('clothcraft.group_api').id])]})
        cls.api = env(user=cls.api_user)['clothcraft.api']
        cls.customer_user, cls.customer_sid = cls._person(f'cust-{cls.tag}', [env.ref('base.group_portal')], 'customer')
        cls.inventory, cls.inventory_sid = cls._person(f'inv-{cls.tag}', [env.ref('base.group_user'), env.ref('clothcraft.group_inventory')], 'staff')
        cls.admin, cls.admin_sid = cls._person(f'adm-{cls.tag}', [env.ref('base.group_user'), env.ref('clothcraft.group_admin')], 'staff')
        cls.other, cls.other_sid = cls._person(f'oth-{cls.tag}', [env.ref('base.group_user'), env.ref('clothcraft.group_inventory')], 'staff')

    @classmethod
    def _person(cls, name, groups, scope):
        env = cls.env
        user = env['res.users'].create({'name': name, 'login': f'{name}@example.com', 'email': f'{name}@example.com', 'password': PASSWORD,
                                        'group_ids': [Command.set([g.id for g in groups])]})
        sid = f'sid-{name}'
        now = fields.Datetime.now()
        env['clothcraft.api.session'].sudo().create({'sid_hash': sid, 'user_id': user.id, 'scope': scope, 'last_seen': now, 'expires': now + timedelta(hours=12)})
        return user, sid

    def setUp(self):
        super().setUp()
        self.base = fields.Datetime.now()
        self.now = self.base
        self.enterContext(patch.object(type(self.api), '_api_now', lambda _self: self.now))

        @contextmanager
        def same_transaction(*_args, **_kwargs):
            yield self.env.cr

        self.enterContext(patch.object(self.env.registry, 'cursor', same_transaction))

    # ---- helpers
    def _t(self, seconds):
        self.now = self.base + timedelta(seconds=seconds)

    def _place(self, method='cod', quantity=1):
        result = self.api.place_order({
            'sid_hash': self.customer_sid, 'lines': [{'sku': self.variant.default_code, 'quantity': quantity}], 'delivery': dict(DELIVERY),
            'payment_method': method, 'quoted_total': 350.0 * quantity, 'idempotency_key': None})
        self.assertEqual(result['status'], 'created', result)
        return self.env['sale.order'].browse(result['order']['id'])

    def _go(self, order, to, who=None, note='', expected=None):
        sid = who or self.inventory_sid
        order.invalidate_recordset()
        return self.api.staff_transition({'sid_hash': sid, 'order_id': order.id, 'to': to, 'expected_state': expected or order.clothcraft_state, 'note': note})

    def _walk(self, order, *steps, who=None, note=''):
        for to in steps:
            result = self._go(order, to, who, note=note)
            self.assertEqual(result['status'], 'done', (to, result))
        return order

    def _free(self):
        self.variant.invalidate_recordset(['qty_available', 'free_qty', 'virtual_available'])
        return self.variant.with_context(warehouse_id=self.warehouse.id).free_qty

    def _on_hand(self):
        self.variant.invalidate_recordset(['qty_available'])
        return self.variant.with_context(warehouse_id=self.warehouse.id).qty_available

    def _audit(self, order):
        return self.env['clothcraft.order.audit'].sudo().search([('order_id', '=', order.id)], order='id')

    def _path_to(self, method, target):
        """A fresh order moved along the chain to `target` (not past it)."""
        order = self._place(method)
        chain = ['confirmed', 'shipped', 'out_for_delivery', 'delivered']     # step 11 (packed is no longer a step)
        if target == 'cancelled':
            steps = ['cancelled']
        elif target == 'awaiting_payment':
            steps = []
        else:
            steps = chain[:chain.index('delivered' if target == 'closed' else target) + 1]
            if method == 'cod':
                steps = steps[1:]     # cash on delivery is accepted at once: it starts at confirmed
        self._walk(order, *steps)
        if target == 'closed':         # only the customer (or the daily job) closes an order
            self.assertEqual(self.api.order_confirm_received({'sid_hash': self.customer_sid, 'order_id': order.id})['status'], 'ok')
        return order

