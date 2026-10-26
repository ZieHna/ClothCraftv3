import json
import uuid
from contextlib import contextmanager
from datetime import timedelta
from unittest.mock import patch

from psycopg2 import IntegrityError

from odoo import Command, fields
from odoo.exceptions import AccessError
from odoo.tests import TransactionCase, tagged
from odoo.tools import mute_logger

from .test_checkout_stock import _free


@tagged('post_install', '-at_install', 'clothcraft')
class TestStorefrontApi(TransactionCase):
    """clothcraft.api, called the way the API service calls it: as a user in the 'Storefront API service' group only."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.tag = uuid.uuid4().hex[:6]
        cls.warehouse = env['stock.warehouse'].search([('company_id', '=', env.company.id)], limit=1)
        garment = env['clothcraft.garment.type'].create({'name': f'Shirt {cls.tag}', 'code': f'T{cls.tag}'})
        color, size = env.ref('clothcraft.attribute_color'), env.ref('clothcraft.attribute_size')
        cls.template = env['product.template'].create({
            'name': f'Api Tee {cls.tag}', 'garment_type_id': garment.id, 'list_price': 350.0,
            'is_published': True, 'sale_ok': True, 'clothcraft_group': 'Men', 'clothcraft_slug': f'api-{cls.tag}',
            'attribute_line_ids': [
                Command.create({'attribute_id': color.id, 'value_ids': [Command.set([env.ref('clothcraft.color_black').id, env.ref('clothcraft.color_white').id])]}),
                Command.create({'attribute_id': size.id, 'value_ids': [Command.set([env.ref('clothcraft.size_m').id, env.ref('clothcraft.size_xl').id])]}),
            ],
        })
        # the XL surcharge, and a SKU per variant
        for ptav in cls.template.attribute_line_ids.product_template_value_ids:
            if ptav.name == 'XL':
                ptav.price_extra = 50.0
        cls.skus = {}
        for variant in cls.template.product_variant_ids:
            c, s = (cls._value(variant, 'Color'), cls._value(variant, 'Size'))
            variant.default_code = f'API-{cls.tag}-{c[:3].upper()}-{s}'
            cls.skus[(c, s)] = variant
        cls.black_m = cls.skus[('Black', 'M')]
        cls.black_xl = cls.skus[('Black', 'XL')]
        env['stock.quant']._update_available_quantity(cls.black_m, cls.warehouse.lot_stock_id, 5)
        # not for sale through the API: a plain product, and an unpublished garment
        env['product.template'].create({'name': f'Plain {cls.tag}', 'list_price': 10.0, 'is_published': True, 'default_code': f'PLAIN-{cls.tag}'})
        cls.hidden = env['product.template'].create({
            'name': f'Hidden {cls.tag}', 'garment_type_id': garment.id, 'list_price': 99.0, 'is_published': False, 'default_code': f'HID-{cls.tag}'})
        cls.api_user = env['res.users'].create({
            'name': f'api {cls.tag}', 'login': f'api_{cls.tag}',
            'group_ids': [Command.set([env.ref('base.group_user').id, env.ref('clothcraft.group_api').id])],
        })
        cls.api = env(user=cls.api_user)['clothcraft.api']

    @staticmethod
    def _value(variant, attribute):
        return next(v.name for v in variant.product_template_variant_value_ids if v.attribute_id.name == attribute)

    def _template_row(self):
        rows = [p for p in self.api.catalogue()['products'] if p['id'] == self.template.id]
        self.assertEqual(len(rows), 1)
        return rows[0]

    # ---- the service identity
    def test_service_user_is_not_an_admin_and_cannot_edit_products(self):
        user = self.api_user
        self.assertFalse(user.has_group('base.group_system'))
        self.assertFalse(user.has_group('clothcraft.group_admin'))
        with self.assertRaises(AccessError):
            self.template.with_user(user).write({'list_price': 1.0})
        with self.assertRaises(AccessError):
            self.env(user=user)['stock.move'].search([])
        with self.assertRaises(AccessError):
            self.env(user=user)['sale.order'].create({'partner_id': self.env.user.partner_id.id})
        with self.assertRaises(AccessError):
            self.env(user=user)['res.partner'].create({'name': 'Nobody'})
        with self.assertRaises(AccessError):
            self.env(user=user)['payment.transaction'].search([])

    # ---- catalogue
    def test_catalogue_lists_garments_with_prices_and_free_stock(self):
        row = self._template_row()
        self.assertEqual(row['name'], self.template.name)
        self.assertEqual(row['list_price'], 350.0)
        self.assertEqual(row['garment_type']['code'], f'T{self.tag}')
        by_key = {(v['color'], v['size']): v for v in row['variants']}
        self.assertEqual(set(by_key), set(self.skus))
        self.assertEqual(by_key[('Black', 'M')]['price'], 350.0)
        self.assertEqual(by_key[('Black', 'M')]['price_extra'], 0.0)
        self.assertEqual(by_key[('Black', 'XL')]['price'], 400.0)
        self.assertEqual(by_key[('Black', 'XL')]['price_extra'], 50.0)
        self.assertEqual(by_key[('Black', 'M')]['free_qty'], 5.0)
        self.assertEqual(by_key[('White', 'M')]['free_qty'], 0.0)
        self.assertEqual(by_key[('Black', 'M')]['sku'], self.black_m.default_code)

    def test_catalogue_leaves_out_plain_products_and_unpublished_garments(self):
        ids = {p['id'] for p in self.api.catalogue()['products']}
        self.assertIn(self.template.id, ids)
        self.assertNotIn(self.hidden.id, ids)
        names = {p['name'] for p in self.api.catalogue()['products']}
        self.assertNotIn(f'Plain {self.tag}', names)

    def test_catalogue_states_currency_vat_and_rounding(self):
        data = self.api.catalogue()
        self.assertEqual(data['currency'], 'PHP')
        self.assertEqual(data['vat_rate'], 12.0)
        self.assertTrue(data['vat_included'])
        self.assertEqual(data['vat_rounding'], self.env.company.tax_calculation_rounding_method)

    def test_catalogue_free_stock_drops_when_stock_is_reserved(self):
        partner = self.env['res.partner'].create({'name': 'Buyer'})
        order = self.env['sale.order'].create({
            'partner_id': partner.id,
            'order_line': [Command.create({'product_id': self.black_m.id, 'product_uom_qty': 2})]})
        order.action_confirm()
        by_key = {(v['color'], v['size']): v for v in self._template_row()['variants']}
        self.assertEqual(by_key[('Black', 'M')]['free_qty'], 3.0)
        self.assertEqual(by_key[('Black', 'M')]['free_qty'], _free(self.black_m, self.warehouse))

    def test_simulation_marker_is_reported_only_when_present(self):
        icp = self.env['ir.config_parameter'].sudo()
        icp.set_param('clothcraft.sim.marker', json.dumps({'version': 1}))
        self.assertEqual(json.loads(self.api.catalogue()['simulation']), {'version': 1})
        icp.set_param('clothcraft.sim.marker', False)
        self.assertFalse(self.api.catalogue()['simulation'])

    def test_shop_info_matches_the_catalogue_header(self):
        info, data = self.api.shop_info(), self.api.catalogue()
        self.assertEqual(info, {k: data[k] for k in info})

    # ---- quote
    def test_quote_prices_lines_and_merges_the_same_sku(self):
        sku_m, sku_xl = self.black_m.default_code, self.black_xl.default_code
        quote = self.api.quote([
            {'sku': sku_m, 'quantity': 1}, {'sku': sku_xl, 'quantity': 1}, {'sku': sku_m, 'quantity': 2}])
        self.assertEqual([r['sku'] for r in quote['lines']], [sku_m, sku_xl])
        self.assertEqual(quote['lines'][0]['quantity'], 3)
        self.assertEqual(quote['lines'][0]['unit_price'], 350.0)
        self.assertEqual(quote['lines'][0]['line_total'], 1050.0)
        self.assertEqual(quote['lines'][1]['unit_price'], 400.0)
        self.assertEqual(quote['lines'][0]['free_qty'], 5.0)
        self.assertEqual(quote['lines'][1]['free_qty'], 0.0)
        self.assertEqual(quote['amount_total'], 1450.0)

    def test_quote_vat_is_the_part_of_the_total_rounded_the_companys_way(self):
        lines = [{'sku': self.black_m.default_code, 'quantity': 3}, {'sku': self.black_xl.default_code, 'quantity': 1}]
        quote = self.api.quote(lines)
        self.assertEqual(quote['vat_rounding'], 'round_globally')
        self.assertEqual(quote['amount_tax'], round(quote['amount_total'] * 12 / 112, 2))

    def test_quote_marks_unknown_and_unpublished_skus_and_prices_nothing_for_them(self):
        quote = self.api.quote([
            {'sku': 'NO-SUCH-SKU', 'quantity': 2}, {'sku': self.black_m.default_code, 'quantity': 1},
            {'sku': self.hidden.default_code, 'quantity': 1}, {'sku': f'PLAIN-{self.tag}', 'quantity': 1}])
        known = {r['sku']: r['known'] for r in quote['lines']}
        self.assertEqual(known, {'NO-SUCH-SKU': False, self.black_m.default_code: True, self.hidden.default_code: False, f'PLAIN-{self.tag}': False})
        self.assertEqual(quote['amount_total'], 350.0)

    def test_quote_writes_nothing(self):
        orders, lines = self.env['sale.order'].search_count([]), self.env['sale.order.line'].search_count([])
        self.api.quote([{'sku': self.black_m.default_code, 'quantity': 4}])
        self.assertEqual(self.env['sale.order'].search_count([]), orders)
        self.assertEqual(self.env['sale.order.line'].search_count([]), lines)

    def test_quote_of_an_empty_cart_is_zero(self):
        quote = self.api.quote([])
        self.assertEqual((quote['lines'], quote['amount_total'], quote['amount_tax']), ([], 0.0, 0.0))


@tagged('post_install', '-at_install', 'clothcraft')
class TestStorefrontOrders(TransactionCase):
    """clothcraft.api.place_order and the order reads, called as the service user."""

    DELIVERY = {'name': 'Ana Cruz', 'email': 'ana@example.com', 'phone': '0917 123 4567', 'street': '12 Rizal Street',
                'city': 'Quezon City', 'province': 'PH-00', 'postal_code': '1100', 'note': 'Leave with the guard'}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.tag = uuid.uuid4().hex[:6]
        cls.warehouse = env['stock.warehouse'].search([('company_id', '=', env.company.id)], limit=1)
        garment = env['clothcraft.garment.type'].create({'name': f'Shirt {cls.tag}', 'code': f'O{cls.tag}'})
        color, size = env.ref('clothcraft.attribute_color'), env.ref('clothcraft.attribute_size')
        cls.template = env['product.template'].create({
            'name': f'Order Tee {cls.tag}', 'garment_type_id': garment.id, 'list_price': 350.0, 'is_published': True, 'sale_ok': True,
            'clothcraft_group': 'Men', 'clothcraft_slug': f'order-{cls.tag}',
            'attribute_line_ids': [
                Command.create({'attribute_id': color.id, 'value_ids': [Command.set([env.ref('clothcraft.color_black').id])]}),
                Command.create({'attribute_id': size.id, 'value_ids': [Command.set([env.ref('clothcraft.size_m').id, env.ref('clothcraft.size_s').id])]}),
            ]})
        cls.skus = {}
        for variant in cls.template.product_variant_ids:
            variant.default_code = f'ORD-{cls.tag}-{TestStorefrontApi._value(variant, "Size")}'
            cls.skus[TestStorefrontApi._value(variant, 'Size')] = variant
        cls.m, cls.s = cls.skus['M'], cls.skus['S']
        env['stock.quant']._update_available_quantity(cls.m, cls.warehouse.lot_stock_id, 5)
        env['stock.quant']._update_available_quantity(cls.s, cls.warehouse.lot_stock_id, 1)
        cls.demo_user, cls.sid_demo = cls._customer(f'demo-{cls.tag}')
        cls.other_user, cls.sid_other = cls._customer(f'other-{cls.tag}')
        cls.demo, cls.other = cls.demo_user.partner_id, cls.other_user.partner_id
        cls.api_user = env['res.users'].create({
            'name': f'api {cls.tag}', 'login': f'apio_{cls.tag}',
            'group_ids': [Command.set([env.ref('base.group_user').id, env.ref('clothcraft.group_api').id])]})
        cls.api = env(user=cls.api_user)['clothcraft.api']

    def setUp(self):
        super().setUp()

        @contextmanager
        def same_transaction(*_args, **_kwargs):
            yield self.env.cr

        # place_order looks a repeated key up in a fresh transaction (so it sees an order another request just committed).
        # A test cannot commit, so here the 'fresh' cursor is the test's own. Real concurrency is proven by the contract cases
        # run against the service, where two requests really do overlap.
        self.enterContext(patch.object(self.env.registry, 'cursor', same_transaction))

    @classmethod
    def _customer(cls, name):
        """A portal customer with a live session; returns (user, session id hash)."""
        env = cls.env
        user = env['res.users'].create({
            'name': name, 'login': f'{name}@example.com', 'email': f'{name}@example.com',
            'group_ids': [Command.set([env.ref('base.group_portal').id])]})
        sid_hash = f'sid-{name}'
        now = fields.Datetime.now()
        env['clothcraft.api.session'].sudo().create({'sid_hash': sid_hash, 'user_id': user.id, 'last_seen': now, 'expires': now + timedelta(days=7)})
        return user, sid_hash

    def _payload(self, sku=None, quantity=1, total=None, method='cod', key=None, sid=None, delivery=None):
        sku = sku or self.m.default_code
        price = 350.0
        return {'sid_hash': sid or self.sid_demo, 'lines': [{'sku': sku, 'quantity': quantity}], 'delivery': delivery or dict(self.DELIVERY),
                'payment_method': method, 'quoted_total': price * quantity if total is None else total, 'idempotency_key': key}

    def _counts(self):
        env = self.env
        return tuple(env[m].search_count([]) for m in ('sale.order', 'sale.order.line', 'res.partner', 'payment.transaction', 'stock.picking', 'stock.move'))

    def _free(self, variant):
        return _free(variant, self.warehouse)

    def test_cash_on_delivery_is_created_and_confirmed_with_stock_reserved(self):
        result = self.api.place_order(self._payload(quantity=2))
        self.assertEqual(result['status'], 'created')
        order = result['order']
        self.assertRegex(order['name'], r'^S\d{5,}$')
        self.assertEqual((order['payment_method'], order['cancelled'], order['paid']), ('cod', False, False))
        self.assertEqual(order['amount_total'], 700.0)
        self.assertEqual(order['lines'][0]['sku'], self.m.default_code)
        self.assertEqual(order['lines'][0]['quantity'], 2)
        sale = self.env['sale.order'].browse(order['id'])
        self.assertEqual(sale.state, 'sale')
        self.assertEqual(sale.partner_id, self.demo)
        self.assertEqual(self._free(self.m), 3.0)  # 5 - 2 reserved
        transaction = sale.transaction_ids
        self.assertEqual((len(transaction), transaction.state, transaction.is_post_processed), (1, 'pending', True))
        self.assertEqual(transaction.reference, sale.name)

    def test_delivery_details_become_a_child_address_of_the_customer(self):
        order = self.env['sale.order'].browse(self.api.place_order(self._payload())['order']['id'])
        address = order.partner_shipping_id
        self.assertEqual((address.parent_id, address.type), (self.demo, 'delivery'))
        self.assertEqual((address.name, address.email, address.phone, address.street, address.city, address.zip),
                         ('Ana Cruz', 'ana@example.com', '0917 123 4567', '12 Rizal Street', 'Quezon City', '1100'))
        self.assertEqual(address.state_id.code, 'PH-00')
        data = self.api.order(self.sid_demo, order.id)['order']['delivery']
        self.assertEqual(data, {'name': 'Ana Cruz', 'email': 'ana@example.com', 'phone': '0917 123 4567', 'street': '12 Rizal Street',
                                'city': 'Quezon City', 'province': 'PH-00', 'postal_code': '1100', 'note': 'Leave with the guard'})

    def test_bank_transfer_is_confirmed_too_and_waits_for_payment(self):
        order = self.api.place_order(self._payload(method='bank_transfer'))['order']
        self.assertEqual((order['payment_method'], order['paid'], order['cancelled']), ('bank_transfer', False, False))
        self.assertEqual(self.env['sale.order'].browse(order['id']).state, 'sale')
        self.assertEqual(self._free(self.m), 4.0)

    def test_a_line_that_cannot_be_supplied_writes_nothing(self):
        before = self._counts()
        for sku, qty in ((self.m.default_code, 6), ('NO-SUCH-SKU', 1)):
            result = self.api.place_order(self._payload(sku=sku, quantity=qty, total=1.0))
            self.assertEqual(result['status'], 'quote_not_ready')
            self.assertIn(False, [r['known'] and r['free_qty'] >= r['quantity'] for r in result['quote']['lines']])
        self.assertEqual(self._counts(), before)
        self.assertEqual(self._free(self.m), 5.0)

    def test_every_short_line_is_reported_together(self):
        payload = self._payload()
        payload['lines'] = [{'sku': self.m.default_code, 'quantity': 6}, {'sku': self.s.default_code, 'quantity': 2}]
        result = self.api.place_order(payload)
        self.assertEqual(result['status'], 'quote_not_ready')
        self.assertEqual([(r['sku'], r['free_qty']) for r in result['quote']['lines']], [(self.m.default_code, 5.0), (self.s.default_code, 1.0)])

    def test_a_changed_price_writes_nothing_and_returns_the_new_quote(self):
        before = self._counts()
        result = self.api.place_order(self._payload(total=349.0))
        self.assertEqual((result['status'], result['quote']['amount_total']), ('price_changed', 350.0))
        self.assertEqual(self._counts(), before)

    def test_a_guard_refusal_leaves_no_order_address_transaction_or_reservation(self):
        """The pre-check is made to believe there is stock, so the B6 guard itself has to refuse."""
        api_model = type(self.api)
        before = self._counts()
        with patch.object(api_model, '_api_free_qty', lambda _self, _variant, _warehouse: 99.0):
            result = self.api.place_order(self._payload(sku=self.s.default_code, quantity=2, total=700.0))
        self.assertEqual(result['status'], 'guard_refused')
        self.assertTrue(result['message'].startswith('Sorry, only 1.0 of '), result['message'])
        self.assertEqual(self._counts(), before)
        self.assertEqual(self._free(self.s), 1.0)

    def test_the_same_key_returns_the_same_order(self):
        first = self.api.place_order(self._payload(key='k-replay'))
        before = self._counts()
        again = self.api.place_order(self._payload(key='k-replay', quantity=3, total=1050.0))
        self.assertEqual((first['replayed'], again['replayed']), (False, True))
        self.assertEqual(again['order']['id'], first['order']['id'])
        self.assertEqual(self._counts(), before)
        self.assertEqual(self.env['sale.order'].search([('client_order_ref', '=', f'api:{self.demo.id}:k-replay')]).ids, [first['order']['id']])
        self.assertEqual(self.api.order_by_key(self.sid_demo, 'k-replay')['order']['id'], first['order']['id'])
        self.assertFalse(self.api.order_by_key(self.sid_demo, 'k-never-used')['found'])

    def test_the_same_key_of_another_customer_is_another_order(self):
        a = self.api.place_order(self._payload(key='k-shared'))['order']['id']
        b = self.api.place_order(self._payload(key='k-shared', sid=self.sid_other))['order']['id']
        self.assertNotEqual(a, b)

    def test_the_database_refuses_two_orders_with_one_key(self):
        values = {'partner_id': self.demo.id, 'client_order_ref': f'api:{self.demo.id}:k-index'}
        self.env['sale.order'].create(values)
        with self.assertRaises(IntegrityError), mute_logger('odoo.sql_db'), self.env.cr.savepoint():
            self.env['sale.order'].create(values)
        # an ordinary customer reference is not constrained
        self.env['sale.order'].create({'partner_id': self.demo.id, 'client_order_ref': 'PO-1'})
        self.env['sale.order'].create({'partner_id': self.demo.id, 'client_order_ref': 'PO-1'})

    def test_a_customer_sees_only_their_own_orders(self):
        mine = self.api.place_order(self._payload())['order']['id']
        theirs = self.api.place_order(self._payload(sid=self.sid_other))['order']['id']
        self.assertEqual([o['id'] for o in self.api.orders(self.sid_demo)['orders']], [mine])
        self.assertEqual([o['id'] for o in self.api.orders(self.sid_other)['orders']], [theirs])
        self.assertTrue(self.api.order(self.sid_demo, mine)['found'])
        refused = self.api.order(self.sid_demo, theirs)
        self.assertEqual((refused['found'], refused['order']), (False, None))
        self.assertFalse(self.api.order(self.sid_demo, 99999999)['found'])

    def test_orders_are_listed_newest_first_and_a_cancelled_one_says_so(self):
        first = self.api.place_order(self._payload())['order']['id']
        second = self.api.place_order(self._payload())['order']['id']
        self.assertEqual([o['id'] for o in self.api.orders(self.sid_demo)['orders']], [second, first])
        self.env['sale.order'].browse(first).with_context(disable_cancel_warning=True).action_cancel()
        listed = {o['id']: o for o in self.api.orders(self.sid_demo)['orders']}
        self.assertTrue(listed[first]['cancelled'])
        self.assertFalse(listed[second]['cancelled'])
        self.assertEqual(self._free(self.m), 4.0)  # the cancelled order gave its unit back

    def test_the_service_user_cannot_delete_orders_or_read_other_models(self):
        order = self.env['sale.order'].browse(self.api.place_order(self._payload())['order']['id'])
        with self.assertRaises(AccessError):
            order.with_user(self.api_user).unlink()
        with self.assertRaises(AccessError):
            self.env(user=self.api_user)['stock.picking'].search([])
