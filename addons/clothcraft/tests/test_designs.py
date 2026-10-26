import base64
import io
import json
import uuid
from contextlib import contextmanager
from datetime import timedelta
from unittest.mock import patch

from PIL import Image

from odoo import Command, fields
from odoo.exceptions import AccessError, UserError
from odoo.tests import TransactionCase, tagged

from ..models import design as design_module
from ..models.design import bounds_file, fill_print_boxes

DELIVERY = {'name': 'Ana Cruz', 'email': 'ana@example.com', 'phone': '0917 123 4567', 'street': '12 Rizal Street', 'city': 'Quezon City',
            'province': 'PH-00', 'postal_code': '1100', 'note': ''}
BOX = {'x': 100.0, 'y': 100.0, 'width': 600.0, 'height': 600.0}   # with 200 sq in at Small: 1800 design units squared per sq in


def picture(width, height, fmt='PNG', mode='RGBA'):
    out = io.BytesIO()
    Image.new(mode, (width, height), (20, 40, 60, 255) if mode == 'RGBA' else (20, 40, 60)).save(out, fmt)
    return base64.b64encode(out.getvalue()).decode()


PREVIEW, PRINT = picture(800, 800), picture(64, 64)


def element(layer_id, left, top, width, height, angle=0, **extra):
    """A Fabric object as the editor's state stores it (centred origin)."""
    return {'type': 'Rect', 'layerId': layer_id, 'left': left, 'top': top, 'width': width, 'height': height, 'scaleX': 1, 'scaleY': 1,
            'angle': angle, 'skewX': 0, 'skewY': 0, 'originX': 'center', 'originY': 'center', 'visible': True, 'opacity': 1, **extra}


def layer_of(o):
    """The editor's layer list entry for that object (what getLayers() reports)."""
    return {'id': o['layerId'], 'x': o['left'], 'y': o['top'], 'width': o['width'] * o['scaleX'], 'height': o['height'] * o['scaleY'],
            'rotation': o['angle'], 'visible': o['visible'], 'opacity': o['opacity']}


@tagged('post_install', '-at_install', 'clothcraft')
class TestDesigns(TransactionCase):
    """Step 9a: customized garments, called the way the service calls them (as the Storefront API service user)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.tag = uuid.uuid4().hex[:6]
        cls.warehouse = env['stock.warehouse'].search([('company_id', '=', env.company.id)], limit=1)
        cls.garment = env['clothcraft.garment.type'].create({'name': f'Design shirt {cls.tag}', 'code': f'D{cls.tag}', 'reference_area_sq_in': 200})
        size = env.ref('clothcraft.attribute_size')
        cls.template = env['product.template'].create({
            'name': f'Design Tee {cls.tag}', 'garment_type_id': cls.garment.id, 'list_price': 350.0, 'is_published': True, 'sale_ok': True,
            'clothcraft_group': 'Men', 'clothcraft_slug': f'design-{cls.tag}',
            'clothcraft_print_x': BOX['x'], 'clothcraft_print_y': BOX['y'], 'clothcraft_print_w': BOX['width'], 'clothcraft_print_h': BOX['height'],
            'attribute_line_ids': [Command.create({'attribute_id': size.id, 'value_ids': [Command.set([
                env.ref('clothcraft.size_s').id, env.ref('clothcraft.size_m').id, env.ref('clothcraft.size_xl').id])]})]})
        cls.sizes = {}
        for variant in cls.template.product_variant_ids:
            name = variant.product_template_variant_value_ids.name
            variant.default_code = f'DSG-{cls.tag}-{name}'
            cls.sizes[name] = variant
            env['stock.quant']._update_available_quantity(variant, cls.warehouse.lot_stock_id, 20)
        cls.m = cls.sizes['M']
        cls.boxless = env['product.template'].create({
            'name': f'Plain Tee {cls.tag}', 'garment_type_id': cls.garment.id, 'list_price': 300.0, 'is_published': True, 'sale_ok': True,
            'clothcraft_group': 'Men', 'clothcraft_slug': f'boxless-{cls.tag}'})
        cls.boxless.product_variant_id.default_code = f'BOX-{cls.tag}'
        env['stock.quant']._update_available_quantity(cls.boxless.product_variant_id, cls.warehouse.lot_stock_id, 5)
        cls.other_template = env['product.template'].create({
            'name': f'Other Tee {cls.tag}', 'garment_type_id': cls.garment.id, 'list_price': 300.0, 'is_published': True, 'sale_ok': True,
            'clothcraft_group': 'Men', 'clothcraft_slug': f'other-{cls.tag}', 'clothcraft_print_x': 0, 'clothcraft_print_y': 0,
            'clothcraft_print_w': 800, 'clothcraft_print_h': 800})
        cls.other_template.product_variant_id.default_code = f'OTH-{cls.tag}'
        cls.pricing = env['clothcraft.design.pricing']._clothcraft_get()
        cls.pricing.write({'rate': 2.0, 'size_step': 20.0})

        cls.api_user = env['res.users'].create({
            'name': f'api {cls.tag}', 'login': f'apid_{cls.tag}', 'group_ids': [Command.set([env.ref('base.group_user').id, env.ref('clothcraft.group_api').id])]})
        cls.api = env(user=cls.api_user)['clothcraft.api']
        cls.ana, cls.sid_ana = cls._person(f'ana-{cls.tag}', [env.ref('base.group_portal')], 'customer')
        cls.ben, cls.sid_ben = cls._person(f'ben-{cls.tag}', [env.ref('base.group_portal')], 'customer')
        cls.inventory, cls.sid_inventory = cls._person(f'inv-{cls.tag}', [env.ref('base.group_user'), env.ref('clothcraft.group_inventory')], 'staff')
        cls.admin, _sid = cls._person(f'adm-{cls.tag}', [env.ref('base.group_user'), env.ref('clothcraft.group_admin')], 'staff')

    @classmethod
    def _person(cls, name, groups, scope):
        env = cls.env
        user = env['res.users'].create({'name': name, 'login': f'{name}@example.com', 'email': f'{name}@example.com',
                                        'group_ids': [Command.set([g.id for g in groups])]})
        now = fields.Datetime.now()
        env['clothcraft.api.session'].sudo().create({'sid_hash': f'sid-{name}', 'user_id': user.id, 'scope': scope, 'last_seen': now, 'expires': now + timedelta(hours=12)})
        return user, f'sid-{name}'

    def setUp(self):
        super().setUp()

        @contextmanager
        def same_transaction(*_args, **_kwargs):
            yield self.env.cr

        # a repeated key is looked up in a fresh transaction; a test cannot commit, so 'fresh' is the test's own cursor
        self.enterContext(patch.object(self.env.registry, 'cursor', same_transaction))

    # ------------------------------------------------------------------ helpers
    def _payload(self, objects=None, pictures=None, sid=None, sku=None, template=None, key=None, **extra):
        objects = [element('a', 400, 400, 180, 120)] if objects is None else objects   # 21600 units = 12 sq in
        state = {'schemaVersion': 1, 'engine': 'simple', 'state': {'fabric': '7.4.0', 'objects': objects, 'counter': len(objects)}, 'assets': {}}
        return {'sid_hash': sid or self.sid_ana, 'product': (template or self.template).clothcraft_slug, 'sku': sku or self.m.default_code,
                'idempotency_key': key, 'state': json.dumps(state), 'layers': [layer_of(o) for o in objects],
                'pictures': pictures or [], 'preview': PREVIEW, 'print': PRINT, **extra}

    def _upload(self, **kwargs):
        result = self.api.design_upload(self._payload(**kwargs))
        self.assertEqual(result['status'], 'created', result)
        return self.env['clothcraft.design'].browse(result['design']['id'])

    def _refused(self, payload):
        result = self.api.design_upload(payload)
        self.assertEqual(result['status'], 'refused', result)
        return result['code']

    def _order(self, lines, total, sid=None):
        return self.api.place_order({'sid_hash': sid or self.sid_ana, 'lines': lines, 'delivery': dict(DELIVERY), 'payment_method': 'cod',
                                     'quoted_total': total, 'idempotency_key': None})

    # ------------------------------------------------------------------ the garment's print box: no box, no designing
    def test_pricing_gives_the_box_the_rate_and_the_size_steps(self):
        data = self.api.design_pricing(self.template.clothcraft_slug)
        self.assertEqual((data['status'], data['designable'], data['box'], data['reference_sq_in']), ('ok', True, BOX, 200.0))
        self.assertEqual((data['rate'], data['size_step'], data['steps']), (2.0, 20.0, {'XS': 0, 'S': 0, 'M': 1, 'L': 2, 'XL': 3, 'XXL': 4}))
        self.assertEqual(self.api.design_pricing('no-such-garment')['status'], 'not_found')

    def test_a_garment_without_a_print_box_cannot_be_customized(self):
        self.assertFalse(self.boxless.clothcraft_designable)
        data = self.api.design_pricing(self.boxless.clothcraft_slug)
        self.assertEqual((data['designable'], data['box'], data['message']), (False, None, "This garment cannot be customized yet."))
        payload = self._payload(template=self.boxless, sku=self.boxless.product_variant_id.default_code)
        self.assertEqual(self._refused(payload), 'not_designable')
        self.assertFalse(self.env['clothcraft.design'].search([('product_tmpl_id', '=', self.boxless.id)]))
        # and the product form says so to staff
        arch = self.env['product.template'].with_user(self.inventory).get_views([(False, 'form')])['views']['form']['arch']
        self.assertIn('Customers cannot customize this garment: it has no print box.', arch)

    def test_the_print_box_lies_inside_the_design_square(self):
        with self.assertRaises(Exception):
            self.boxless.write({'clothcraft_print_x': 500, 'clothcraft_print_y': 0, 'clothcraft_print_w': 400, 'clothcraft_print_h': 100})

    def test_the_print_boxes_in_odoo_equal_the_measured_file(self):
        boxes = bounds_file()['products']
        slug = next(iter(boxes))
        template = self.env['product.template'].with_context(active_test=False).search([('clothcraft_slug', '=', slug)])
        if not template:
            template = self.template.copy({'name': f'Measured {self.tag}', 'clothcraft_slug': slug, 'clothcraft_print_w': 0, 'clothcraft_print_h': 0,
                                           'clothcraft_print_x': 0, 'clothcraft_print_y': 0})
        fill_print_boxes(self.env)
        for t in self.env['product.template'].with_context(active_test=False).search([('clothcraft_slug', 'in', list(boxes))]):
            b = boxes[t.clothcraft_slug]
            with self.subTest(slug=t.clothcraft_slug):
                self.assertEqual((t.clothcraft_print_x, t.clothcraft_print_y, t.clothcraft_print_w, t.clothcraft_print_h), (b['x'], b['y'], b['width'], b['height']))
        self.assertTrue(template.clothcraft_designable)

    # ------------------------------------------------------------------ uploading
    def test_an_upload_is_checked_priced_and_kept_privately(self):
        design = self._upload()
        self.assertEqual((design.partner_id, design.product_tmpl_id, design.state, design.covered_sq_in, design.layer_count, design.print_px),
                         (self.ana.partner_id, self.template, 'draft', 12.0, 1, 64))
        attachments = self.env['ir.attachment'].search([('res_model', '=', 'clothcraft.design'), ('res_id', '=', design.id)])
        self.assertEqual(sorted(attachments.mapped('name')), ['preview.png', 'print.png', 'state.json'])
        self.assertFalse(any(attachments.mapped('public')))
        with self.assertRaises(AccessError):
            self.env(user=self.api_user)['clothcraft.design'].browse(design.id).read(['state'])
        with self.assertRaises(AccessError):
            self.env(user=self.api_user)['ir.attachment'].browse(attachments.ids).read(['datas'])

    def test_the_same_key_gives_the_same_design(self):
        first = self.api.design_upload(self._payload(key='k-1'))
        again = self.api.design_upload(self._payload(key='k-1'))
        self.assertEqual((first['replayed'], again['replayed'], again['design']['id']), (False, True, first['design']['id']))

    def test_pictures_must_be_real_png_jpeg_or_webp(self):
        objects = [element('p', 400, 400, 100, 100, type='Image', assetId='img1')]
        self._upload(objects=objects, pictures=[{'id': 'img1', 'data': picture(10, 10, 'JPEG', 'RGB')}])
        self._upload(objects=objects, pictures=[{'id': 'img1', 'data': picture(10, 10, 'WEBP')}])
        gif = picture(10, 10, 'GIF', 'RGB')
        svg = base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg"/>').decode()
        broken = base64.b64encode(base64.b64decode(picture(10, 10))[:40]).decode()
        for data, code in ((gif, 'picture_type'), (svg, 'picture_type'), (broken, 'unreadable')):
            with self.subTest(code=code):
                self.assertEqual(self._refused(self._payload(objects=objects, pictures=[{'id': 'img1', 'data': data}])), code)
        # a picture the state does not use, or one it uses but that was not sent
        self.assertEqual(self._refused(self._payload(pictures=[{'id': 'img1', 'data': picture(10, 10)}])), 'mismatch')
        self.assertEqual(self._refused(self._payload(objects=objects)), 'mismatch')

    def test_the_preview_and_print_file_are_checked(self):
        self.assertEqual(self._refused(self._payload(preview=picture(400, 400))), 'preview_size')
        self.assertEqual(self._refused(self._payload(print=picture(64, 32))), 'print_size')
        self.assertEqual(self._refused(self._payload(print=picture(64, 64, 'JPEG', 'RGB'))), 'png_required')
        self.assertEqual(self._refused(self._payload(preview='not base64!')), 'format')

    def test_the_limits(self):
        many = [element(f'e{i}', 400, 400, 10, 10) for i in range(51)]
        self.assertEqual(self._refused(self._payload(objects=many)), 'too_many_layers')
        nine = [{'id': f'i{i}', 'data': picture(4, 4)} for i in range(9)]
        self.assertEqual(self._refused(self._payload(pictures=nine)), 'too_many_pictures')
        small = {**design_module.LIMITS, 'total': 2000}
        with patch.dict(design_module.LIMITS, small):
            self.assertEqual(self._refused(self._payload()), 'too_large')
        objects = [element('p', 400, 400, 100, 100, assetId='img1')]
        with patch.dict(design_module.LIMITS, {'picture': 50}):
            self.assertEqual(self._refused(self._payload(objects=objects, pictures=[{'id': 'img1', 'data': picture(40, 40)}])), 'picture_too_large')
        with patch.dict(design_module.LIMITS, {'megapixels': 100}):
            self.assertEqual(self._refused(self._payload(objects=objects, pictures=[{'id': 'img1', 'data': picture(40, 40)}])), 'megapixels')
        with patch.dict(design_module.LIMITS, {'state': 100}):
            self.assertEqual(self._refused(self._payload()), 'state_too_large')
        with patch.dict(design_module.LIMITS, {'preview': 100}):
            self.assertEqual(self._refused(self._payload()), 'preview_too_large')
        with patch.dict(design_module.LIMITS, {'print': 50}):
            self.assertEqual(self._refused(self._payload()), 'print_too_large')
        with patch.dict(design_module.LIMITS, {'unordered_designs': 1}):
            self._upload()
            self.assertEqual(self._refused(self._payload()), 'too_many_designs')

    def test_the_element_list_must_match_the_editor_state(self):
        payload = self._payload()
        payload['layers'][0]['x'] += 2
        self.assertEqual(self._refused(payload), 'mismatch')
        payload = self._payload()
        payload['layers'][0]['visible'] = False
        self.assertEqual(self._refused(payload), 'mismatch')
        # within half a unit, and a box turned 180 degrees is the same box
        payload = self._payload(objects=[element('a', 400, 400, 180, 120, angle=180)])
        payload['layers'][0].update(x=400.3, rotation=0)
        self.assertEqual(self.api.design_upload(payload)['status'], 'created')
        self.assertEqual(self._refused(self._payload(objects=[element('a', 400, 400, 180, 120, skewX=12)])), 'skewed')
        bad = self._payload()
        bad['state'] = json.dumps({'schemaVersion': 2, 'state': {'objects': []}})
        self.assertEqual(self._refused(bad), 'format')

    def test_hidden_and_transparent_elements_are_not_priced(self):
        design = self._upload(objects=[element('a', 400, 400, 180, 120, visible=False), element('b', 400, 400, 180, 120, opacity=0)])
        self.assertEqual(design.covered_sq_in, 0.0)

    def test_a_design_must_be_for_the_garment_of_the_variant(self):
        payload = self._payload(sku=self.other_template.product_variant_id.default_code)
        self.assertEqual(self._refused(payload), 'product_mismatch')

    def test_no_session_no_upload(self):
        self.assertEqual(self.api.design_upload(self._payload(sid='sid-nobody'))['status'], 'unauthorised')

    # ------------------------------------------------------------------ quotes and orders
    def test_a_designed_line_is_the_garment_plus_its_print_fee(self):
        design = self._upload()
        quote = self.api.quote([{'sku': self.m.default_code, 'quantity': 2, 'design_id': design.id}], self.sid_ana)
        row = quote['lines'][0]
        self.assertEqual((row['unit_price'], row['line_total'], row['design_id']), (350.0, 700.0, design.id))
        self.assertEqual(row['print_fee'], {'covered_sq_in': 12.0, 'rate': 2.0, 'size_step': 20.0, 'steps': 1, 'unit': 44.0, 'total': 88.0})
        self.assertEqual(quote['amount_total'], 788.0)
        # the same garment without the design is a separate line
        quote = self.api.quote([{'sku': self.m.default_code, 'quantity': 1, 'design_id': design.id}, {'sku': self.m.default_code, 'quantity': 1}], self.sid_ana)
        self.assertEqual([(r['design_id'], r.get('print_fee', {}).get('unit')) for r in quote['lines']], [(design.id, 44.0), (False, None)])
        self.assertEqual(quote['amount_total'], 744.0)

    def test_the_size_step_is_added_per_piece(self):
        design = self._upload()
        fees = {size: self.api.quote([{'sku': v.default_code, 'quantity': 1, 'design_id': design.id}], self.sid_ana)['lines'][0]['print_fee']['unit']
                for size, v in self.sizes.items()}
        self.assertEqual(fees, {'S': 24.0, 'M': 44.0, 'XL': 84.0})

    def test_a_removed_or_foreign_design_is_never_priced_as_a_plain_garment(self):
        design = self._upload()
        line = {'sku': self.m.default_code, 'quantity': 1, 'design_id': design.id}
        foreign = self.api.quote([line], self.sid_ben)
        anonymous = self.api.quote([line])
        self.assertEqual(self.api.design_void({'sid_hash': self.sid_ana, 'design_id': design.id})['status'], 'voided')
        removed = self.api.quote([line], self.sid_ana)
        design.sudo().unlink()
        deleted = self.api.quote([line], self.sid_ana)
        for name, quote in (('foreign', foreign), ('anonymous', anonymous), ('removed', removed), ('deleted', deleted)):
            with self.subTest(name):
                row = quote['lines'][0]
                self.assertTrue(row['design_unavailable'])
                self.assertEqual(row['message'], "This design is no longer available.")
                self.assertNotIn('unit_price', row)
                self.assertNotIn('print_fee', row)
                self.assertEqual(quote['amount_total'], 0.0)
        result = self._order([line], 0.0)
        self.assertEqual(result['status'], 'quote_not_ready')

    def test_a_design_on_another_garment_is_invalid(self):
        design = self._upload()
        quote = self.api.quote([{'sku': self.other_template.product_variant_id.default_code, 'quantity': 1, 'design_id': design.id}], self.sid_ana)
        self.assertEqual((quote['status'], quote['code']), ('invalid', 'product_mismatch'))

    def test_an_order_keeps_the_fee_on_its_own_line_and_the_design_is_then_fixed(self):
        design = self._upload()
        result = self._order([{'sku': self.m.default_code, 'quantity': 2, 'design_id': design.id}], 788.0)
        self.assertEqual(result['status'], 'created', result)
        order = self.env['sale.order'].browse(result['order']['id'])
        garment, fee = order.order_line.sorted('sequence')
        self.assertEqual((garment.product_id, garment.clothcraft_design_id, garment.product_uom_qty), (self.m, design, 2))
        self.assertEqual((fee.product_id.product_tmpl_id, fee.clothcraft_fee_for_id, fee.product_uom_qty, fee.price_unit, fee.price_total),
                         (self.env.ref('clothcraft.product_customization_fee'), garment, 2, 44.0, 88.0))
        self.assertEqual((fee.clothcraft_print_sq_in, fee.clothcraft_print_rate, fee.clothcraft_print_size_step, fee.clothcraft_print_steps), (12.0, 2.0, 20.0, 1))
        self.assertEqual(order.amount_total, 788.0)
        self.assertEqual(design.state, 'ordered')
        row = result['order']['lines']
        self.assertEqual(len(row), 1)
        self.assertEqual((row[0]['design_id'], row[0]['print_fee']['total']), (design.id, 88.0))
        # what was printed never changes
        with self.assertRaises(UserError):
            design.sudo().write({'covered_sq_in': 1.0})
        with self.assertRaises(UserError):
            design.sudo().unlink()
        self.assertEqual(self.api.design_void({'sid_hash': self.sid_ana, 'design_id': design.id})['code'], 'ordered')
        # a later price change does not touch the order
        self.pricing.rate = 3.0
        self.assertEqual(self.api.order(self.sid_ana, order.id)['order']['lines'][0]['print_fee']['unit'], 44.0)

    def test_the_total_includes_the_fee_or_the_price_has_changed(self):
        design = self._upload()
        line = [{'sku': self.m.default_code, 'quantity': 1, 'design_id': design.id}]
        self.assertEqual(self._order(line, 350.0)['status'], 'price_changed')
        self.pricing.rate = 3.0
        result = self._order(line, 394.0)
        self.assertEqual((result['status'], result['quote']['amount_total']), ('price_changed', 406.0))

    def test_changing_the_garment_quantity_in_odoo_changes_its_fee_line(self):
        design = self._upload()
        order = self.env['sale.order'].browse(self._order([{'sku': self.m.default_code, 'quantity': 1, 'design_id': design.id}], 394.0)['order']['id'])
        garment = order.order_line.filtered('clothcraft_design_id')
        order.write({'order_line': [Command.update(garment.id, {'product_uom_qty': 3})]})
        fee = garment.clothcraft_fee_line_ids
        self.assertEqual((fee.product_uom_qty, fee.price_unit), (3, 44.0))
        self.assertEqual(order.amount_total, 3 * 350.0 + 3 * 44.0)

    def test_the_fee_product_is_a_hidden_service_with_vat_included(self):
        fee = self.env.ref('clothcraft.product_customization_fee')
        self.assertEqual((fee.type, fee.is_storable, fee.is_published, fee.sale_ok, fee.purchase_ok, fee.default_code), ('service', False, False, True, False, False))
        self.assertEqual(fee.taxes_id, self.env.company.account_sale_tax_id)
        self.assertNotIn(fee.id, [p['id'] for p in self.api.catalogue()['products']])

    # ------------------------------------------------------------------ pictures, removing, staff
    def test_only_the_owner_sees_the_pictures(self):
        design = self._upload()
        mine = self.api.design_image({'sid_hash': self.sid_ana, 'design_id': design.id, 'kind': 'preview'})
        self.assertEqual((mine['status'], mine['mimetype'], mine['data']), ('ok', 'image/png', PREVIEW))
        self.assertEqual(self.api.design_image({'sid_hash': self.sid_ben, 'design_id': design.id, 'kind': 'preview'})['status'], 'not_found')
        self.assertEqual(self.api.design_get({'sid_hash': self.sid_ben, 'design_id': design.id})['status'], 'not_found')
        self.assertEqual(self.api.design_void({'sid_hash': self.sid_ben, 'design_id': design.id})['status'], 'not_found')
        self.assertEqual(self.api.design_get({'sid_hash': self.sid_ana, 'design_id': design.id})['design']['covered_sq_in'], 12.0)
        # staff only for a design on an order, named after the order line
        self.assertEqual(self.api.staff_design_image({'sid_hash': self.sid_inventory, 'design_id': design.id, 'kind': 'print'})['status'], 'not_found')
        order = self._order([{'sku': self.m.default_code, 'quantity': 1, 'design_id': design.id}], 394.0)['order']
        staff = self.api.staff_design_image({'sid_hash': self.sid_inventory, 'design_id': design.id, 'kind': 'print'})
        self.assertEqual((staff['status'], staff['filename'], staff['data']), ('ok', f"{order['name']}-1-{self.m.default_code}.png", PRINT))
        self.assertEqual(self.api.staff_design_image({'sid_hash': self.sid_ana, 'design_id': design.id, 'kind': 'print'})['status'], 'unauthorised')
        self.assertEqual(self.api.design_image({'sid_hash': self.sid_inventory, 'design_id': design.id, 'kind': 'print'})['status'], 'unauthorised')

    def test_the_print_file_and_pictures_are_kept_at_full_size(self):
        # Odoo's default shrinks image attachments to 1920 px; a 3200 px print file and large pictures must come back unchanged
        self.env['ir.config_parameter'].sudo().set_param('base.image_autoresize_max_px', '1920x1920')
        big_print, big_png, big_jpeg = picture(3200, 3200), picture(2400, 2000), picture(2600, 2100, 'JPEG', 'RGB')
        # the pictures sit outside the print box, so the fee is the usual 12 sq in of element 'a'
        objects = [element('a', 400, 400, 180, 120), element('p', 40, 40, 60, 60, type='Image', assetId='img-png'),
                   element('j', 760, 760, 60, 60, type='Image', assetId='img-jpg')]
        design = self._upload(objects=objects, print=big_print, pictures=[{'id': 'img-png', 'data': big_png}, {'id': 'img-jpg', 'data': big_jpeg}])
        self.assertEqual(design.print_px, 3200)
        self.assertEqual(Image.open(io.BytesIO(design.print_id.raw)).size, (3200, 3200))
        self.assertEqual(Image.open(io.BytesIO(design.preview_id.raw)).size, (800, 800))
        self.assertEqual(design.covered_sq_in, 12.0)
        self.assertTrue(self._order([{'sku': self.m.default_code, 'quantity': 1, 'design_id': design.id}], 394.0)['order'])
        staff = self.api.staff_design_image({'sid_hash': self.sid_inventory, 'design_id': design.id, 'kind': 'print'})
        self.assertEqual(staff['data'], big_print)
        mine = self.api.design_state({'sid_hash': self.sid_ana, 'design_id': design.id})
        self.assertEqual({p['id']: p['data'] for p in mine['pictures']}, {'img-png': big_png, 'img-jpg': big_jpeg})

    def test_the_owner_can_reopen_a_design_with_its_pictures(self):
        objects = [element('p', 400, 400, 100, 100, type='Image', assetId='img-1')]
        data = picture(10, 10)
        design = self._upload(objects=objects, pictures=[{'id': 'img-1', 'data': data}])
        mine = self.api.design_state({'sid_hash': self.sid_ana, 'design_id': design.id})
        self.assertEqual(mine['status'], 'ok')
        self.assertEqual(json.loads(mine['state'])['state']['objects'][0]['assetId'], 'img-1')
        self.assertEqual(mine['pictures'], [{'id': 'img-1', 'mimetype': 'image/png', 'data': data}])
        self.assertEqual(self.api.design_state({'sid_hash': self.sid_ben, 'design_id': design.id})['status'], 'not_found')
        self.assertEqual(self.api.design_state({'sid_hash': 'sid-nobody', 'design_id': design.id})['status'], 'unauthorised')
        self.api.design_void({'sid_hash': self.sid_ana, 'design_id': design.id})
        self.assertEqual(self.api.design_state({'sid_hash': self.sid_ana, 'design_id': design.id})['status'], 'not_found')

    def test_the_daily_job_removes_unused_drafts_and_removed_designs_only(self):
        old, removed, fresh = self._upload(), self._upload(), self._upload()
        ordered = self._upload()
        self._order([{'sku': self.m.default_code, 'quantity': 1, 'design_id': ordered.id}], 394.0)
        removed.write({'state': 'void'})
        self.env.flush_all()   # before the dates are moved back, or the pending write stamps write_date again afterwards
        long_ago = fields.Datetime.now() - timedelta(days=31)
        self.env.cr.execute('UPDATE clothcraft_design SET last_used = %s, write_date = %s WHERE id IN %s', [long_ago, long_ago, (old.id, removed.id, ordered.id)])
        self.env['clothcraft.design'].invalidate_model()
        self.env['clothcraft.design']._cron_cleanup()
        self.assertEqual(self.env['clothcraft.design'].search([('id', 'in', (old.id, removed.id, fresh.id, ordered.id))]), fresh | ordered)
        self.assertFalse(self.env['ir.attachment'].search([('res_model', '=', 'clothcraft.design'), ('res_id', 'in', (old.id, removed.id))]))

    # ------------------------------------------------------------------ rights
    def test_the_pricing_is_set_by_the_administrator_only(self):
        self.assertEqual(self.pricing.with_user(self.inventory).rate, 2.0)
        with self.assertRaises(AccessError):
            self.pricing.with_user(self.inventory).write({'rate': 1.0})
        self.pricing.with_user(self.admin).write({'rate': 2.5})
        self.assertEqual(self.pricing.rate, 2.5)
        with self.assertRaises(AccessError):
            self.env(user=self.api_user)['clothcraft.design.pricing'].search([])
        with self.assertRaises(AccessError):
            self.env(user=self.admin)['clothcraft.design'].create({'partner_id': self.ana.partner_id.id, 'product_tmpl_id': self.template.id})
        self.assertTrue(self.env.ref('clothcraft.menu_clothcraft_design_pricing').group_ids <= self.env.ref('clothcraft.group_admin'))
