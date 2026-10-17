import re
import threading
import time
import uuid
from unittest.mock import patch

import requests

from odoo import Command, SUPERUSER_ID, api, http
from odoo.exceptions import AccessError, UserError
from odoo.tests import HttpCase, TransactionCase, tagged
from odoo.modules.registry import DummyRLock, Registry


def _make_shop(env, tag, tee_stock=1, cap_stock=1):
    """Two garment products, a courier that allows cash on delivery, and two portal buyers."""
    ph = env.ref('base.ph')
    state = env['res.country.state'].search([('country_id', '=', ph.id)], limit=1)
    warehouse = env['stock.warehouse'].search([('company_id', '=', env.company.id)], limit=1)
    shipping = env['product.product'].create({'name': f'Shipping {tag}', 'type': 'service', 'list_price': 0})
    carrier = env['delivery.carrier'].create({
        'name': f'Courier {tag}', 'delivery_type': 'fixed', 'fixed_price': 0, 'product_id': shipping.id,
        'website_published': True, 'allow_cash_on_delivery': True})
    garment = env['clothcraft.garment.type'].create({'name': f'Shirt {tag}', 'code': tag[:10]})
    products = {}
    for name, stock in (('Tee', tee_stock), ('Cap', cap_stock)):
        template = env['product.template'].create({
            'name': f'{name} {tag}', 'garment_type_id': garment.id, 'list_price': 350.0,
            'website_published': True, 'sale_ok': True})
        product = template.product_variant_id
        if stock:
            env['stock.quant']._update_available_quantity(product, warehouse.lot_stock_id, stock)
        products[name.lower()] = product
    buyers = []
    for i in (1, 2):
        login = f'buyer{i}_{tag}'
        partner = env['res.partner'].create({
            'name': login, 'email': f'{login}@example.com', 'phone': '0917 000 0000', 'street': '1 Test St',
            'city': 'Manila', 'zip': '1000', 'country_id': ph.id, 'state_id': state.id})
        env['res.users'].create({
            'name': login, 'login': login, 'password': login, 'partner_id': partner.id,
            'group_ids': [Command.set([env.ref('base.group_portal').id])]})
        buyers.append(login)
    wire = env.ref('payment.payment_provider_transfer')
    wire.write({'state': 'enabled', 'is_published': True})
    return {
        'warehouse': warehouse, 'carrier': carrier, 'tee': products['tee'], 'cap': products['cap'],
        'buyers': buyers, 'state': state,
        'providers': {
            'cod': (env.ref('delivery.payment_provider_cod'), env.ref('delivery.payment_method_cash_on_delivery')),
            'wire': (wire, env.ref('payment_custom.payment_method_wire_transfer')),
        },
    }


def _free(product, warehouse):
    product.invalidate_recordset(['qty_available', 'free_qty', 'virtual_available'])
    return product.with_context(warehouse_id=warehouse.id).free_qty


@tagged('post_install', '-at_install', 'clothcraft')
class TestStockGuard(TransactionCase):
    """The guard and the garment defaults, without HTTP."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.shop = _make_shop(cls.env, 'g' + uuid.uuid4().hex[:6])
        cls.partner = cls.env['res.partner'].create({'name': 'Backend buyer'})
        cls.wh = cls.shop['warehouse']

    def _order(self, *lines, partner=None):
        return self.env['sale.order'].create({
            'partner_id': (partner or self.partner).id,
            'order_line': [Command.create({'product_id': p.id, 'product_uom_qty': q}) for p, q in lines]})

    def test_garment_defaults_only_for_garments(self):
        garment = self.env['clothcraft.garment.type'].create({'name': 'Hoodie', 'code': 'HD' + uuid.uuid4().hex[:4]})
        product = self.env['product.template'].create({'name': 'Garment', 'garment_type_id': garment.id})
        plain = self.env['product.template'].create({'name': 'Plain'})
        service = self.env['product.template'].create({'name': 'Svc', 'type': 'service', 'garment_type_id': garment.id})
        explicit = self.env['product.template'].create({
            'name': 'Explicit', 'garment_type_id': garment.id, 'allow_out_of_stock_order': True})
        self.assertTrue(product.is_storable)
        self.assertFalse(product.allow_out_of_stock_order)
        self.assertFalse(plain.is_storable)
        self.assertTrue(plain.allow_out_of_stock_order, "non-garments keep Odoo's defaults")
        self.assertFalse(service.is_storable)
        self.assertTrue(explicit.allow_out_of_stock_order, "an explicit value wins over the default")

    def test_staff_confirm_with_enough_stock(self):
        order = self._order((self.shop['tee'], 1))
        order.action_confirm()
        self.assertEqual(order.state, 'sale')
        self.assertEqual(order.picking_ids.state, 'assigned')
        self.assertEqual(_free(self.shop['tee'], self.wh), 0)

    def test_staff_confirm_short_stock_is_blocked_with_message(self):
        order = self._order((self.shop['tee'], 2))
        with self.assertRaisesRegex(UserError, r"only 1.0 of Tee .* left") as caught:
            order.action_confirm()
        self.assertEqual(order.state, "draft")
        self.assertFalse(order.picking_ids)
        self.assertNotIn("cart", str(caught.exception), "backend orders do not get the website wording")

    def test_website_wording_only_for_website_orders(self):
        order = self._order((self.shop['tee'], 2))
        order.website_id = self.env['website'].search([], limit=1)
        with self.assertRaisesRegex(UserError, "Your cart has been kept"):
            order.action_confirm()

    def test_never_received_garment_is_rejected_cleanly(self):
        garment = self.env['clothcraft.garment.type'].search([], limit=1)
        template = self.env['product.template'].create({'name': 'Never received', 'garment_type_id': garment.id})
        self.assertFalse(self.env['stock.quant'].search([('product_id', '=', template.product_variant_id.id)]))
        order = self._order((template.product_variant_id, 1))
        with self.assertRaisesRegex(UserError, "just sold out"):
            order.action_confirm()
        self.assertEqual(order.state, 'draft')

    def test_second_order_for_the_last_unit_is_rejected(self):
        first, second = self._order((self.shop['cap'], 1)), self._order((self.shop['cap'], 1))
        first.action_confirm()
        with self.assertRaisesRegex(UserError, "just sold out"):
            second.action_confirm()

    def test_batch_confirm_counts_all_orders_together(self):
        first, second = self._order((self.shop['cap'], 1)), self._order((self.shop['cap'], 1))
        with self.assertRaisesRegex(UserError, "just sold out|left"):
            (first + second).action_confirm()
        self.assertEqual((first + second).mapped('state'), ['draft', 'draft'])

    def test_products_allowed_to_oversell_are_not_checked(self):
        self.shop['cap'].product_tmpl_id.allow_out_of_stock_order = True
        order = self._order((self.shop['cap'], 5))
        order.action_confirm()
        self.assertEqual(order.state, 'sale')

    def test_multi_line_order_with_one_short_product_confirms_nothing(self):
        tee, cap = self.shop['tee'], self.shop['cap']
        order = self._order((tee, 1), (cap, 3))
        with self.assertRaisesRegex(UserError, r"only 1\.0 of Cap .* left"):
            order.action_confirm()
        self.assertEqual(order.state, 'draft')
        self.assertFalse(order.picking_ids)
        self.assertEqual(_free(tee, self.wh), 1, "the available line was not reserved either")

    def test_cancelling_a_confirmed_order_releases_the_stock(self):
        order = self._order((self.shop['tee'], 1))
        order.action_confirm()
        self.assertEqual(_free(self.shop['tee'], self.wh), 0)
        order.with_context(disable_cancel_warning=True).action_cancel()
        self.assertEqual(order.state, 'cancel')
        self.assertEqual(_free(self.shop['tee'], self.wh), 1)

    def test_order_numbers_are_unique(self):
        names = [self._order().name for _ in range(20)]
        self.assertEqual(len(set(names)), 20)
        self.assertTrue(all(re.fullmatch(r'S\d{5,}', name) for name in names), names)


class _CheckoutHelpers:
    """Drives the real website routes with the test's HTTP opener."""

    def _jsonrpc(self, route, params):
        response = self.opener.post(self.base_url() + route, json={
            'id': 0, 'jsonrpc': '2.0', 'method': 'call', 'params': params})
        body = response.json()
        if 'error' in body:
            error = body['error']
            return None, (error.get('data') or {}).get('message') or error.get('message')
        return body['result'], None

    def _cart_add(self, product, qty=1, **extra):
        result, error = self._jsonrpc('/shop/cart/add', {
            'product_template_id': product.product_tmpl_id.id, 'product_id': product.id,
            'quantity': qty, **extra})
        self.assertIsNone(error)
        return result

    def _newest_cart(self):
        self.env.invalidate_all()
        return self.env['sale.order'].search([('state', '=', 'draft'), ('website_id', '!=', False)],
                                             order='id desc', limit=1)

    def _set_delivery(self, order):
        self._jsonrpc('/shop/set_delivery_method', {'dm_id': self.shop['carrier'].id})
        self.env.invalidate_all()
        if not order.carrier_id:
            order.sudo().carrier_id = self.shop['carrier']

    def _pay(self, order, kind, **extra):
        self.url_open("/shop/checkout")  # as the browser does; it records the order in the session
        self.url_open("/shop/payment")
        provider, method = self.shop['providers'][kind]
        return self._jsonrpc(f'/shop/payment/transaction/{order.id}', {
            'provider_id': provider.id, 'payment_method_id': method.id, 'token_id': None, 'flow': 'direct',
            'tokenization_requested': False, 'landing_route': '/shop/payment/validate',
            'is_validation': False, 'access_token': order.sudo()._portal_ensure_token(), **extra})

    def _finish(self, processing_values):
        """The steps the browser takes after the transaction route."""
        self.url_open('/payment/custom/process', data={'reference': processing_values['reference']})
        self._jsonrpc('/payment/status/poll', {})
        self.assertEqual(self.url_open("/shop/payment/validate").status_code, 200)
        return self.url_open("/shop/confirmation")

    def _state(self, order):
        self.env.invalidate_all()
        return self.env['sale.order'].browse(order.id)


@tagged('post_install', '-at_install', 'clothcraft')
class TestCheckoutRoutes(_CheckoutHelpers, HttpCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.shop = _make_shop(cls.env, 'r' + uuid.uuid4().hex[:6], tee_stock=1, cap_stock=1)
        cls.wh = cls.shop['warehouse']

    def _checkout(self, kind, login=None):
        self.authenticate(login or self.shop['buyers'][0], login or self.shop['buyers'][0])
        self._cart_add(self.shop['tee'])
        order = self._newest_cart()
        self._set_delivery(order)
        return order

    def test_cod_and_bank_transfer_are_confirmed_inside_the_transaction_route(self):
        for kind in ('cod', 'wire'):
            with self.subTest(kind=kind):
                order = self._checkout(kind)
                values, error = self._pay(order, kind)
                self.assertIsNone(error)
                order = self._state(order)
                self.assertEqual(order.state, 'sale', "confirmed by the route, before the browser polls")
                self.assertEqual(order.picking_ids.state, 'assigned')
                self.assertEqual(_free(self.shop['tee'], self.wh), 0)
                page = self._finish(values)
                self.assertEqual(page.status_code, 200)
                self.assertIn('Thank you', page.text)
                self.assertEqual(self._state(order).state, 'sale')
                # put the unit back for the next provider
                self._state(order).with_context(disable_cancel_warning=True).action_cancel()
                self.assertEqual(_free(self.shop['tee'], self.wh), 1)

    def test_guest_checkout(self):
        for kind in ('cod', 'wire'):
            with self.subTest(kind=kind):
                self.authenticate(None, None)  # public visitor
                self._cart_add(self.shop['tee'])
                order = self._newest_cart()
                self.assertEqual(order.partner_id, self.env["website"].browse(order.website_id.id).user_id.partner_id)
                response = self.opener.post(self.base_url() + '/shop/address/submit', data={
                    "csrf_token": http.Request.csrf_token(self),
                    'name': 'Guest Buyer', 'email': f'guest_{kind}@example.com', 'phone': '0917 111 1111',
                    'street': '2 Guest St', 'city': 'Cebu', 'zip': '6000',
                    'country_id': self.env.ref('base.ph').id, 'state_id': self.shop['state'].id,
                    'address_type': 'billing', 'use_delivery_as_billing': 'true'})
                self.assertEqual(response.status_code, 200, response.text[:300])
                order = self._state(order)
                self.assertEqual(order.partner_id.name, 'Guest Buyer')
                self._set_delivery(order)
                values, error = self._pay(order, kind)
                self.assertIsNone(error)
                order = self._state(order)
                self.assertEqual(order.state, 'sale')
                self.assertEqual(order.picking_ids.state, 'assigned')
                self.assertIn('Thank you', self._finish(values).text)
                order.with_context(disable_cancel_warning=True).action_cancel()

    def test_guest_cannot_buy_the_last_unit_twice(self):
        first = self._checkout('cod', self.shop['buyers'][0])
        self.assertIsNone(self._pay(first, 'cod')[1])
        self.authenticate(None, None)
        result = self._cart_add(self.shop['tee'])
        self.assertEqual(result['quantity'], 0, "nothing left to add to a guest cart")

    def test_multi_line_cart_with_one_short_product(self):
        self.authenticate(self.shop['buyers'][0], self.shop['buyers'][0])
        self._cart_add(self.shop['tee'])
        self._cart_add(self.shop['cap'])
        order = self._newest_cart()
        self._set_delivery(order)
        # the cap sells out after it was added to the cart
        self.env['stock.quant'].search([('product_id', '=', self.shop['cap'].id)]).sudo().unlink()
        for bypass in (False, True):  # False: Odoo's own cart check; True: our guard is what fails
            with self.subTest(bypass=bypass):
                if bypass:
                    with patch.object(type(self.env["sale.order"]), "_check_cart_is_ready_to_be_paid",
                                      lambda self_: True):
                        values, error = self._pay(order, 'cod')
                else:
                    values, error = self._pay(order, 'cod')
                self.assertIsNone(values)
                self.assertRegex(error, r"Cap .*(sold out|only 0)")
                order = self._state(order)
                self.assertEqual(order.state, 'draft', "the cart is kept")
                self.assertEqual(len(order.order_line.filtered(lambda l: l.product_id.is_storable)), 2)
                self.assertFalse(order.transaction_ids)
                self.assertFalse(order.picking_ids)
                self.assertEqual(_free(self.shop['tee'], self.wh), 1, "the tee was not reserved")
                self.assertIn(self.shop['tee'].product_tmpl_id.name, self.url_open('/shop/cart').text)

    def test_never_received_garment_through_the_route(self):
        garment = self.env['clothcraft.garment.type'].search([], limit=1)
        template = self.env['product.template'].create({
            'name': 'Never received web', 'garment_type_id': garment.id,
            'website_published': True, 'sale_ok': True})
        self.authenticate(self.shop['buyers'][0], self.shop['buyers'][0])
        self._cart_add(self.shop['tee'])
        order = self._newest_cart()
        self._set_delivery(order)
        self.env['sale.order.line'].create({
            'order_id': order.id, 'product_id': template.product_variant_id.id, 'product_uom_qty': 1})
        with patch.object(type(self.env['sale.order']), '_check_cart_is_ready_to_be_paid', lambda self_: True):
            values, error = self._pay(order, 'wire')
        self.assertIsNone(values)
        self.assertIn('just sold out', error)
        self.assertEqual(self._state(order).state, 'draft')

    def test_cancelling_a_confirmed_bank_transfer_order_releases_free_qty(self):
        order = self._checkout('wire')
        values, error = self._pay(order, 'wire')
        self.assertIsNone(error)
        self.assertEqual(_free(self.shop['tee'], self.wh), 0, "reserved while waiting for the transfer")
        order = self._state(order)
        order.with_context(disable_cancel_warning=True).action_cancel()
        self.assertEqual(order.state, 'cancel')
        self.assertEqual(_free(self.shop['tee'], self.wh), 1, "released when staff cancel the unpaid order")

    def test_tampered_price_and_extra_kwargs_are_ignored(self):
        self.authenticate(self.shop['buyers'][0], self.shop['buyers'][0])
        self._cart_add(self.shop['tee'], price_unit=1.0, price=1.0, list_price=1.0, discount=99.0,
                       product_uom_qty=99, amount_total=1.0)
        order = self._newest_cart()
        line = order.order_line.filtered(lambda l: l.product_id == self.shop['tee'])
        self.assertEqual((line.price_unit, line.discount, line.product_uom_qty), (350.0, 0.0, 1.0))
        self.assertEqual(order.amount_total, 350.0)
        self._jsonrpc('/shop/cart/update', {'line_id': line.id, 'quantity': 1, 'price_unit': 1.0, 'discount': 50})
        self.assertEqual(self._state(order).order_line.filtered(lambda l: l.product_id == self.shop['tee']).price_unit, 350.0)
        self._set_delivery(order)
        values, error = self._pay(order, 'cod', amount=1.0)
        self.assertIsNone(values)
        self.assertIn('cart has been updated', error)
        values, error = self._pay(order, 'cod', partner_id=self.env.ref('base.partner_admin').id)
        self.assertIsNone(values, "unknown kwargs are rejected, not forwarded")
        self.assertEqual(self._state(order).state, 'draft')
        buyer = self.env['res.users'].search([('login', '=', self.shop['buyers'][0])])
        with self.assertRaises(AccessError):
            line.with_user(buyer).write({'price_unit': 1.0})

    def test_bank_transfer_confirmation_email_is_reported(self):
        order = self._checkout('wire')
        values, error = self._pay(order, 'wire')
        self.assertIsNone(error)
        self.env.invalidate_all()
        messages = self.env['mail.message'].search([('model', '=', 'sale.order'), ('res_id', '=', order.id)])
        mails = self.env['mail.mail'].search([('mail_message_id', 'in', messages.ids)])
        report = [(m.subject, re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', m.body or '')).strip()[:300]) for m in messages]
        self._logger.info("REPORT bank-transfer email: mails=%s messages=%s", [(m.subject, m.state) for m in mails], report)
        print("REPORT bank-transfer email:", [(m.subject, m.state) for m in mails], report, flush=True)
        self.assertTrue(messages)


@tagged('post_install', '-at_install', 'clothcraft')
class TestConcurrentLastUnit(_CheckoutHelpers, HttpCase):
    """Two real, parallel requests to /shop/payment/transaction for the last unit.

    Needs separate database transactions, so the registry is not put in test mode: the data is
    committed and cleaned up afterwards (run on a throwaway database, as for all tests).

    WARNING: this class COMMITS data (users, products, stock, orders, and it leaves the Wire Transfer
    provider enabled). Run it on a throwaway database only, never against the live "clothcraft" database.
    """
    registry_test_mode = False

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # While tests run, the loader holds Registry._lock, which would block every server thread.
        # Odoo's own test mode swaps in a dummy lock; we need the same without sharing one cursor.
        cls.startClassPatcher(patch.object(Registry, '_lock', DummyRLock()))
        cls.startClassPatcher(patch.object(cls.registry, 'check_signaling', return_value=cls.registry))
        tag = 'c' + uuid.uuid4().hex[:6]
        with cls.registry.cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            shop = _make_shop(env, tag, tee_stock=1, cap_stock=0)
            cls.fx = {
                'warehouse': shop['warehouse'].id, 'carrier': shop['carrier'].id, 'tee': shop['tee'].id,
                'cap': shop['cap'].id, 'tmpl': shop['tee'].product_tmpl_id.id, 'buyers': shop['buyers'],
                'cod': [r.id for r in shop['providers']['cod']], 'wire': [r.id for r in shop['providers']['wire']],
            }
        cls.addClassCleanup(cls._cleanup, tag)

    @classmethod
    def _cleanup(cls, tag):
        try:
            with cls.registry.cursor() as cr:
                env = api.Environment(cr, SUPERUSER_ID, {})
                orders = env['sale.order'].search([('partner_id.name', 'like', f'%_{tag}')])
                orders.with_context(disable_cancel_warning=True).filtered(lambda o: o.state != 'cancel').action_cancel()
                orders.picking_ids.filtered(lambda p: p.state not in ('done', 'cancel')).action_cancel()
                env['stock.quant'].search([('product_id', 'in', [cls.fx['tee'], cls.fx['cap']])]).sudo().unlink()
                env['product.template'].browse(cls.fx['tmpl']).active = False
        except Exception:  # best effort only: this is a throwaway database
            cls._logger.warning("could not fully clean up the committed concurrency fixtures", exc_info=True)

    def _login(self, login):
        session = requests.Session()
        page = session.get(self.base_url() + "/web/login")
        token = re.search(r'name="csrf_token"[^>]*value="([^"]+)"', page.text).group(1)
        session.post(self.base_url() + "/web/login", data={
            "login": login, "password": login, "csrf_token": token, "redirect": "/shop"})
        return session

    @staticmethod
    def _rpc(session, url, route, params):
        body = session.post(url + route, json={'id': 0, 'jsonrpc': '2.0', 'method': 'call', 'params': params}).json()
        if 'error' in body:
            error = body['error']
            return None, (error.get('data') or {}).get('message') or error.get('message')
        return body['result'], None

    def _reset_last_unit(self):
        """One unit of the tee, no leftover carts or reservations from an earlier race."""
        with self.registry.cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            tee = env["product.product"].browse(self.fx["tee"])
            buyers = env["sale.order"].search([("partner_id.user_ids.login", "in", self.fx["buyers"])])
            buyers.filtered(lambda o: o.state == "sale").with_context(disable_cancel_warning=True).action_cancel()
            buyers.filtered(lambda o: o.state == "draft").unlink()
            env["stock.quant"].search([("product_id", "=", tee.id)]).sudo().unlink()
            env["stock.quant"]._update_available_quantity(
                tee, env["stock.warehouse"].browse(self.fx["warehouse"]).lot_stock_id, 1.0)

    def _race(self, kind):
        self._reset_last_unit()
        url = self.base_url()
        provider_id, method_id = self.fx[kind]
        sessions, orders = [], []
        for login in self.fx['buyers']:
            session = self._login(login)
            _result, error = self._rpc(session, url, "/shop/cart/add", {
                "product_template_id": self.fx["tmpl"], "product_id": self.fx["tee"], "quantity": 1})
            self._rpc(session, url, "/shop/set_delivery_method", {"dm_id": self.fx["carrier"]})
            self.assertIsNone(error)
            with self.registry.cursor() as cr:
                env = api.Environment(cr, SUPERUSER_ID, {})
                order = env['sale.order'].search([('partner_id.user_ids.login', '=', login), ('state', '=', 'draft')],
                                                 order='id desc', limit=1)
                if not order.carrier_id:
                    order.carrier_id = self.fx['carrier']
                orders.append((order.id, order._portal_ensure_token()))
            sessions.append(session)

        original = self.registry['sale.order'].action_confirm

        def slow_confirm(records, *args, **kwargs):  # hold the locks so the other request really collides
            result = original(records, *args, **kwargs)
            time.sleep(1.0)
            return result

        barrier, results = threading.Barrier(2), {}

        def buy(i):
            order_id, token = orders[i]
            barrier.wait()
            results[i] = self._rpc(sessions[i], url, f'/shop/payment/transaction/{order_id}', {
                'provider_id': provider_id, 'payment_method_id': method_id, 'token_id': None, 'flow': 'direct',
                'tokenization_requested': False, 'landing_route': '/shop/payment/validate',
                'is_validation': False, 'access_token': token})

        with patch.object(self.registry["sale.order"], "action_confirm", slow_confirm):
            threads = [threading.Thread(target=buy, args=(i,)) for i in (0, 1)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(60)

        winners = [i for i in (0, 1) if results[i][1] is None]
        losers = [i for i in (0, 1) if results[i][1] is not None]
        self.assertEqual(len(winners), 1, results)
        self.assertEqual(len(losers), 1, results)
        self.assertRegex(results[losers[0]][1], r"sold out|only 0", "the loser is told the unit is gone")
        with self.registry.cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            won, lost = env['sale.order'].browse(orders[winners[0]][0]), env['sale.order'].browse(orders[losers[0]][0])
            self.assertEqual(won.state, 'sale')
            self.assertEqual(won.picking_ids.state, 'assigned')
            self.assertEqual(lost.state, 'draft', "the loser keeps the cart")
            self.assertEqual(lost.order_line.filtered(lambda l: l.product_id.id == self.fx['tee']).product_uom_qty, 1)
            self.assertFalse(lost.transaction_ids)
            quants = env['stock.quant'].search([('product_id', '=', self.fx['tee']), ('location_id.usage', '=', 'internal')])
            self.assertEqual(sum(quants.mapped('reserved_quantity')), 1.0, "exactly one unit reserved, no oversell")
        cart = sessions[losers[0]].get(url + "/shop/cart")
        self.assertIn('Tee', cart.text, "the loser's cart page still shows the product")

    def test_two_parallel_cash_on_delivery_requests_for_the_last_unit(self):
        self._race('cod')

    def test_two_parallel_bank_transfer_requests_for_the_last_unit(self):
        self._race('wire')
