"""Step 12: the customer's cart on the server: whose it is, what it may hold, two writers at once, what an order takes off it, the expiry
job, the design clean-up, and the rights."""
import datetime
from unittest.mock import patch

from odoo.exceptions import AccessError, UserError
from odoo.tests import tagged

from ..models import cart as cart_module
from .staff_common import DELIVERY, StaffOrderCase


@tagged('post_install', '-at_install', 'clothcraft')
class TestServerCart(StaffOrderCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.other_template = env['product.template'].create({
            'name': f'Cart Polo {cls.tag}', 'garment_type_id': cls.template.garment_type_id.id, 'list_price': 450.0, 'is_published': True,
            'sale_ok': True, 'clothcraft_group': 'Men', 'clothcraft_slug': f'cart-{cls.tag}'})
        cls.other_variant = cls.other_template.product_variant_id
        cls.other_variant.default_code = f'CRT-{cls.tag}'
        env['stock.quant']._update_available_quantity(cls.other_variant, cls.warehouse.lot_stock_id, 50)
        cls.stranger, cls.stranger_sid = cls._person(f'stranger-{cls.tag}', [env.ref('base.group_portal')], 'customer')

    # ---- helpers
    def _design(self, partner=None, template=None, state='draft'):
        return self.env['clothcraft.design'].sudo().create({'partner_id': (partner or self.customer_user.partner_id).id,
                                                            'product_tmpl_id': (template or self.template).id, 'state': state})

    def _get(self, sid=None):
        return self.api.cart_get({'sid_hash': sid or self.customer_sid})

    def _put(self, lines, base, sid=None):
        return self.api.cart_put({'sid_hash': sid or self.customer_sid, 'base_version': base, 'lines': lines})

    def _line(self, sku=None, quantity=1, selected=False, design=None):
        row = {'sku': sku or self.variant.default_code, 'quantity': quantity, 'selected': selected}
        if design:
            row['design_id'] = str(design.id)
        return row

    def _lines(self, cart):
        return [(l['sku'], l['quantity'], l['selected'], l.get('design_id')) for l in cart['lines']]

    # ------------------------------------------------------------------ whose
    def test_a_new_customer_has_an_empty_cart_and_only_a_customer_session_opens_one(self):
        got = self._get()
        self.assertEqual((got['status'], got['cart']), ('ok', {'version': 0, 'updated': None, 'lines': []}))
        for sid in (self.inventory_sid, self.admin_sid, 'sid-forged', '', None):
            self.assertEqual(self.api.cart_get({'sid_hash': sid})['status'], 'unauthorised', sid)
            self.assertEqual(self.api.cart_put({'sid_hash': sid, 'base_version': 0, 'lines': [self._line()]})['status'], 'unauthorised', sid)
        self.assertFalse(self.env['clothcraft.cart'].sudo().search([]).filtered(lambda c: c.partner_id in (self.inventory.partner_id, self.admin.partner_id)))

    def test_a_cart_is_kept_as_written_in_its_order_with_no_prices(self):
        design = self._design()
        written = self._put([self._line(self.other_variant.default_code, 2, True), self._line(quantity=1, design=design), self._line(quantity=3)], 0)
        self.assertEqual((written['status'], written['cart']['version']), ('ok', 1))
        read = self._get()['cart']
        self.assertEqual(self._lines(read), [(self.other_variant.default_code, 2, True, None), (self.variant.default_code, 1, False, str(design.id)),
                                             (self.variant.default_code, 3, False, None)])
        self.assertEqual(read['lines'][0]['product_slug'], self.other_template.clothcraft_slug)
        self.assertTrue(read['updated'])
        self.assertNotIn('price', str(read))

    def test_another_customer_never_sees_this_cart_and_cannot_use_its_designs(self):
        design = self._design()
        self._put([self._line(design=design)], 0)
        self.assertEqual(self._get(self.stranger_sid)['cart']['lines'], [])
        refused = self._put([self._line(design=design)], 0, self.stranger_sid)
        self.assertEqual((refused['status'], refused['fields']), ('invalid', {'lines[0].designId': 'This design is not one of yours.'}))
        self.assertEqual(self._lines(self._get()['cart']), [(self.variant.default_code, 1, False, str(design.id))])
        self.assertEqual(self._put([self._line(quantity=4)], 0, self.stranger_sid)['status'], 'ok')
        self.assertEqual(self._lines(self._get()['cart']), [(self.variant.default_code, 1, False, str(design.id))])     # still theirs, unchanged

    # ------------------------------------------------------------------ what it may hold
    def test_the_limits_and_every_malformed_line_are_refused_and_nothing_is_written(self):
        cases = [
            ([self._line(quantity=1)] * 0 + [self._line(sku=f'X-{n}') for n in range(51)], 'lines'),
            ([self._line(quantity=0)], 'lines[0].quantity'), ([self._line(quantity=100)], 'lines[0].quantity'),
            ([self._line(quantity=True)], 'lines[0].quantity'), ([{**self._line(), 'quantity': '2'}], 'lines[0].quantity'),
            ([self._line(sku='NO-SUCH-SKU')], 'lines[0].sku'), ([{**self._line(), 'sku': ''}], 'lines[0].sku'), ([self._line(sku='X' * 65)], 'lines[0].sku'),
            ([self._line(), self._line(quantity=2)], 'lines[1]'),
            ([{**self._line(), 'selected': 'yes'}], 'lines[0].selected'),
            ([{**self._line(), 'design_id': 'abc'}], 'lines[0].designId'),
            ([self._line(design=self._design(template=self.other_template))], 'lines[0].designId'),     # a design for another garment
            ([self._line(design=self._design(state='void'))], 'lines[0].designId'),                    # a removed design
            ('not a list', 'lines'), ([42], 'lines[0]'),
        ]
        for lines, field in cases:
            with self.subTest(field=field):
                answer = self._put(lines, 0)
                self.assertEqual(answer['status'], 'invalid', answer)
                self.assertIn(field, answer['fields'])
        self.assertEqual(self.api.cart_put({'sid_hash': self.customer_sid, 'base_version': -1, 'lines': []})['status'], 'invalid')
        self.assertEqual(self.api.cart_put({'sid_hash': self.customer_sid, 'base_version': True, 'lines': []})['status'], 'invalid')
        self.assertEqual(self._get()['cart']['version'], 0)
        self.assertEqual(self._put([self._line(sku=self.variant.default_code, quantity=99)], 0)['status'], 'ok')     # 99 is allowed

    def test_a_deleted_design_takes_its_line_with_it_never_leaving_the_plain_garment(self):
        design = self._design()
        self._put([self._line(design=design), self._line(self.other_variant.default_code)], 0)
        design.unlink()
        self.assertEqual(self._lines(self._get()['cart']), [(self.other_variant.default_code, 1, False, None)])

    # ------------------------------------------------------------------ two writers
    def test_a_write_based_on_an_old_version_is_a_conflict_with_the_cart_as_it_is_and_the_same_write_again_is_not(self):
        first = self._put([self._line(quantity=2)], 0)
        self.assertEqual(first['cart']['version'], 1)
        late = self._put([self._line(self.other_variant.default_code)], 0)          # another tab, still at version 0
        self.assertEqual((late['status'], self._lines(late['cart']), late['cart']['version']), ('conflict', [(self.variant.default_code, 2, False, None)], 1))
        again = self._put([self._line(quantity=2)], 0)                                # the first write sent again (its answer was lost)
        self.assertEqual((again['status'], again['replayed'], again['cart']['version']), ('ok', True, 1))
        same = self._put([self._line(quantity=2)], 1)                                 # nothing changes: no new version
        self.assertEqual((same['replayed'], same['cart']['version']), (True, 1))
        moved = self._put([self._line(quantity=2), self._line(self.other_variant.default_code)], 1)
        self.assertEqual((moved['status'], moved['replayed'], moved['cart']['version']), ('ok', False, 2))
        reordered = self._put([self._line(self.other_variant.default_code), self._line(quantity=2)], 2)     # the order of the lines counts
        self.assertEqual((reordered['replayed'], reordered['cart']['version']), (False, 3))

    def test_writes_are_limited_per_session(self):
        with patch.object(cart_module, 'PUT_RATE', 3):
            answers = [self._put([self._line(quantity=n)], n - 1)['status'] for n in range(1, 5)]
            self.assertEqual(answers, ['ok', 'ok', 'ok', 'throttled'])
            throttled = self._put([self._line(quantity=9)], 3)
            self.assertTrue(0 < throttled['retry_after'] <= cart_module.PUT_WINDOW)
            self.assertEqual(self._put([self._line(quantity=1)], 0, self.stranger_sid)['status'], 'ok')       # another session has its own count
        self.assertEqual(self._get()['cart']['version'], 3)

    def test_the_write_locks_the_cart_row(self):
        self._put([self._line()], 0)
        seen = []
        real = type(self.env.cr).execute

        def spy(cr, query, params=None, *args, **kwargs):
            seen.append(str(query))
            return real(cr, query, params, *args, **kwargs)

        with patch.object(type(self.env.cr), 'execute', spy):
            self._put([self._line(quantity=2)], 1)
        self.assertTrue(any('FROM clothcraft_cart WHERE id = %s FOR UPDATE' in q for q in seen), 'cart_put must lock the cart row')

    # ------------------------------------------------------------------ orders
    def _order(self, quantity, key=None, total=None):
        return self.api.place_order({'sid_hash': self.customer_sid, 'lines': [{'sku': self.variant.default_code, 'quantity': quantity}], 'delivery': dict(DELIVERY),
                                     'payment_method': 'cod', 'quoted_total': total if total is not None else 350.0 * quantity, 'idempotency_key': key})

    def test_an_order_takes_exactly_what_it_holds_off_the_cart_in_the_same_transaction(self):
        self._put([self._line(quantity=2, selected=True), self._line(self.other_variant.default_code, 1)], 0)
        self.assertEqual(self._order(2)['status'], 'created')
        cart = self._get()['cart']
        self.assertEqual((self._lines(cart), cart['version']), ([(self.other_variant.default_code, 1, False, None)], 2))

    def test_more_on_the_cart_than_was_ordered_keeps_the_rest_unticked(self):
        self._put([self._line(quantity=5, selected=True)], 0)                          # raised to 5 on another device while 2 were ordered
        self._order(2)
        self.assertEqual(self._lines(self._get()['cart']), [(self.variant.default_code, 3, False, None)])

    def test_a_refused_order_leaves_the_cart_exactly_as_it_was(self):
        self._put([self._line(quantity=2, selected=True)], 0)
        self.assertEqual(self._order(2, total=1.0)['status'], 'price_changed')
        with patch.object(type(self.env['sale.order']), 'action_confirm', lambda _self: (_ for _ in ()).throw(UserError('stock just ran out'))):
            self.assertEqual(self._order(2)['status'], 'guard_refused')               # the order and the cart change roll back together
        cart = self._get()['cart']
        self.assertEqual((self._lines(cart), cart['version']), ([(self.variant.default_code, 2, True, None)], 1))

    def test_a_replayed_order_changes_the_cart_no_further(self):
        self._put([self._line(quantity=1, selected=True)], 0)
        first = self._order(1, key='k-cart-1')
        self.assertEqual(first['status'], 'created')
        self._put([self._line(quantity=1, selected=True)], self._get()['cart']['version'])      # the shopper adds it again
        again = self._order(1, key='k-cart-1')                                                    # the same order sent again
        self.assertEqual((again['status'], again['replayed']), ('created', True))
        self.assertEqual(self._lines(self._get()['cart']), [(self.variant.default_code, 1, True, None)])

    def test_an_order_without_a_saved_cart_works_as_before(self):
        self.assertEqual(self._order(1)['status'], 'created')
        self.assertEqual(self._get()['cart'], {'version': 0, 'updated': None, 'lines': []})

    # ------------------------------------------------------------------ expiry and the design clean-up
    def test_carts_untouched_for_sixty_days_go_and_their_lonely_drafts_are_voided(self):
        self.env['ir.config_parameter'].sudo().search([('key', '=', cart_module.EXPIRY_PARAM)]).unlink()
        mine, shared = self._design(), self._design()
        self._put([self._line(design=mine), self._line(quantity=2, design=shared)], 0)
        other_design = self._design(self.stranger.partner_id)
        self._put([self._line(design=other_design)], 0, self.stranger_sid)
        cart = self.env['clothcraft.cart'].sudo().search([('partner_id', '=', self.customer_user.partner_id.id)])
        written = cart.write_date
        Cart = self.env['clothcraft.cart']
        self.assertEqual(Cart._cron_clothcraft_cart_expiry(now=written + datetime.timedelta(days=59)), 0)
        self.assertEqual(Cart._cron_clothcraft_cart_expiry(now=written + datetime.timedelta(days=61)), 2)       # both carts are that old here
        self.assertFalse(Cart.sudo().search([]))
        self.assertEqual((mine.state, shared.state, other_design.state), ('void', 'void', 'void'))

    def test_the_expiry_follows_its_setting_and_keeps_designs_still_used_elsewhere(self):
        design = self._design()
        self._put([self._line(design=design)], 0)
        order = self._order(1)                                       # the plain line in another cart's order does not matter here
        self.assertEqual(order['status'], 'created')
        written = self.env['clothcraft.cart'].sudo().search([]).mapped('write_date')[0]
        self.env['ir.config_parameter'].sudo().set_param(cart_module.EXPIRY_PARAM, '0')
        self.assertEqual(self.env['clothcraft.cart']._cron_clothcraft_cart_expiry(now=written + datetime.timedelta(days=999)), 0)
        self.env['ir.config_parameter'].sudo().set_param(cart_module.EXPIRY_PARAM, 'nonsense')
        self.assertEqual(self.env['clothcraft.cart']._clothcraft_expiry_days(), 60)
        self.env['ir.config_parameter'].sudo().set_param(cart_module.EXPIRY_PARAM, '10')
        ordered = self._design(state='ordered')
        self._put([self._line(design=design), self._line(quantity=2, design=ordered)], self._get()['cart']['version'])
        self.assertEqual(self.env['clothcraft.cart']._cron_clothcraft_cart_expiry(now=written + datetime.timedelta(days=11)), 1)
        self.assertEqual((design.state, ordered.state), ('void', 'ordered'))       # an ordered design is never voided

    def test_the_design_clean_up_never_removes_a_design_in_a_saved_cart(self):
        kept, dropped = self._design(), self._design()
        self._put([self._line(design=kept)], 0)
        old = datetime.datetime.now() - datetime.timedelta(days=40)
        self.env.cr.execute('UPDATE clothcraft_design SET last_used = %s WHERE id IN %s', [old, (kept.id, dropped.id)])
        self.env.invalidate_all()
        self.env['clothcraft.design']._cron_cleanup()
        self.assertTrue(kept.exists())
        self.assertFalse(dropped.exists())

    # ------------------------------------------------------------------ rights
    def test_only_an_administrator_may_read_carts_and_nobody_writes_them_but_the_facade(self):
        self._put([self._line()], 0)
        cart = self.env['clothcraft.cart'].sudo().search([])
        for who in (self.api_user, self.inventory, self.customer_user):
            with self.assertRaises(AccessError):
                cart.with_user(who).read(['version'])
            with self.assertRaises(AccessError):
                cart.line_ids.with_user(who).read(['quantity'])
        self.assertTrue(cart.with_user(self.admin).read(['version']))
        for model in ('clothcraft.cart', 'clothcraft.cart.line'):
            access = self.env['ir.model.access'].sudo().search([('model_id.model', '=', model)])
            self.assertEqual([(a.group_id, a.perm_read, a.perm_write, a.perm_create, a.perm_unlink) for a in access],
                             [(self.env.ref('clothcraft.group_admin'), True, False, False, False)])
        with self.assertRaises(AccessError):
            cart.with_user(self.admin).write({'version': 99})
        api_access = self.env['ir.model.access'].sudo().search([('group_id', '=', self.env.ref('clothcraft.group_api').id)])
        self.assertEqual(sorted(a.model_id.model for a in api_access), ['clothcraft.garment.type', 'sale.order', 'sale.order.line'])

    def test_the_expiry_job_is_a_daily_cron_on_carts(self):
        cron = self.env.ref('clothcraft.ir_cron_cart_expiry')
        self.assertEqual((cron.model_id.model, cron.interval_number, cron.interval_type), ('clothcraft.cart', 1, 'days'))
