from datetime import datetime

from odoo import Command
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestStockListing(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.warehouse = cls.env['stock.warehouse'].search([('company_id', '=', cls.env.company.id)], limit=1)
        cls.vendor_a = cls.env['res.partner'].create({'name': 'Listing Vendor A'})
        cls.vendor_b = cls.env['res.partner'].create({'name': 'Listing Vendor B'})
        cls.customer = cls.env['res.partner'].create({'name': 'Listing Customer'})

    def _product(self, name, tracking='none'):
        return self.env['product.product'].create({
            'name': name, 'type': 'consu', 'is_storable': True, 'tracking': tracking,
            'list_price': 900, 'standard_price': 400})

    def _rows(self, product):
        self.env.flush_all()
        return self.env['clothcraft.stock.listing'].search([('product_id', '=', product.id)])

    def _picking(self, picking_type, product, qty, partner=None):
        picking = self.env['stock.picking'].create({
            'picking_type_id': picking_type.id,
            'partner_id': partner.id if partner else False,
            'location_id': picking_type.default_location_src_id.id,
            'location_dest_id': picking_type.default_location_dest_id.id,
            'move_ids': [Command.create({
                'product_id': product.id, 'product_uom_qty': qty,
                'location_id': picking_type.default_location_src_id.id,
                'location_dest_id': picking_type.default_location_dest_id.id,
            })],
        })
        picking.action_confirm()
        picking.action_assign()
        return picking

    def _validate(self, picking, when=None):
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            move.picked = True
        picking.button_validate()
        assert picking.state == 'done', picking.state
        if when:
            picking.move_line_ids.date = when
        return picking

    def _receive(self, product, qty, partner=None, when=None):
        return self._validate(self._picking(self.warehouse.in_type_id, product, qty, partner), when)

    def _return(self, picking, qty):
        wizard = self.env['stock.return.picking'].with_context(
            active_id=picking.id, active_model='stock.picking').create({})
        wizard.product_return_moves.quantity = qty
        return self.env['stock.picking'].browse(wizard.action_create_returns()['res_id'])

    def test_receipt_with_supplier_shows_it(self):
        product = self._product('Listing Tee 1')
        when = datetime(2026, 2, 3, 10, 0)
        self._receive(product, 6, partner=self.vendor_a, when=when)
        row = self._rows(product)
        self.assertEqual(len(row), 1)
        self.assertEqual(row.supplier, 'Listing Vendor A')
        self.assertEqual(row.quantity, 6)
        self.assertEqual(row.arrival_date, when)
        self.assertEqual((row.list_price, row.standard_price), (900, 400))
        self.assertFalse(row.lot_id)

    def test_receipt_without_supplier_shows_no_supplier(self):
        product = self._product('Listing Tee 2')
        self._receive(product, 3)
        row = self._rows(product)
        self.assertEqual(row.supplier, 'No supplier')
        self.assertTrue(row.arrival_date)

    def test_stock_with_no_receipt_shows_no_supplier_and_no_date(self):
        product = self._product('Listing Tee 3')
        self.env['stock.quant']._update_available_quantity(product, self.warehouse.lot_stock_id, 4)
        row = self._rows(product)
        self.assertEqual((row.supplier, row.quantity), ('No supplier', 4))
        self.assertFalse(row.arrival_date)

    def test_purchase_order_receipt_shows_the_po_vendor(self):
        product = self._product('Listing Tee 4')
        order = self.env['purchase.order'].create({
            'partner_id': self.vendor_a.id,
            'order_line': [Command.create({
                'product_id': product.id, 'product_qty': 2, 'price_unit': 100})],
        })
        order.button_confirm()
        picking = order.picking_ids
        picking.partner_id = self.vendor_b  # the PO line wins over the receipt's partner
        self._validate(picking)
        self.assertEqual(self._rows(product).supplier, 'Listing Vendor A')

    def test_customer_return_is_not_shown_as_a_supplier(self):
        product = self._product('Listing Tee 5')
        self.env['stock.quant']._update_available_quantity(product, self.warehouse.lot_stock_id, 5)
        delivery = self._validate(self._picking(self.warehouse.out_type_id, product, 5, self.customer))
        returned = self._validate(self._return(delivery, 2))
        self.assertTrue(returned.move_ids.origin_returned_move_id)
        row = self._rows(product)
        self.assertEqual(row.quantity, 2)
        self.assertEqual(row.supplier, 'No supplier')
        self.assertFalse(row.arrival_date)

    def test_returned_back_vendor_return_is_not_a_second_supplier(self):
        product = self._product('Listing Tee 6')
        receipt = self._receive(product, 5, partner=self.vendor_a, when=datetime(2026, 2, 3, 10, 0))
        to_vendor = self._validate(self._return(receipt, 5))
        back = self._return(to_vendor, 5)
        back.partner_id = self.vendor_b
        self._validate(back)
        row = self._rows(product)
        self.assertEqual(row.quantity, 5)
        self.assertEqual(row.supplier, 'Listing Vendor A')
        self.assertEqual(row.arrival_date, datetime(2026, 2, 3, 10, 0))

    def test_lot_tracked_stock_has_one_row_per_lot_with_its_own_supplier(self):
        product = self._product('Listing Tee 7', tracking='lot')
        for vendor, lot, qty, when in [
                (self.vendor_a, 'LST-A', 10, datetime(2026, 1, 10, 9, 0)),
                (self.vendor_b, 'LST-B', 4, datetime(2026, 3, 5, 14, 30))]:
            picking = self._picking(self.warehouse.in_type_id, product, qty, vendor)
            picking.move_ids.move_line_ids.write({'lot_name': lot, 'quantity': qty})
            picking.move_ids.picked = True
            picking.button_validate()
            picking.move_line_ids.date = when
        rows = self._rows(product)
        self.assertEqual(len(rows), 2)
        by_lot = {row.lot_id.name: row for row in rows}
        self.assertEqual((by_lot['LST-A'].quantity, by_lot['LST-A'].supplier, by_lot['LST-A'].arrival_date),
                         (10, 'Listing Vendor A', datetime(2026, 1, 10, 9, 0)))
        self.assertEqual((by_lot['LST-B'].quantity, by_lot['LST-B'].supplier, by_lot['LST-B'].arrival_date),
                         (4, 'Listing Vendor B', datetime(2026, 3, 5, 14, 30)))
