from odoo import Command
from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestReceiptSupplierCheck(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.warehouse = cls.env['stock.warehouse'].search([('company_id', '=', cls.env.company.id)], limit=1)
        cls.product = cls.env['product.product'].create(
            {'name': 'Receipt Tee', 'type': 'consu', 'is_storable': True})
        cls.vendor = cls.env['res.partner'].create({'name': 'Receipt Vendor'})

    def _manual_receipt(self, partner=None, qty=5):
        picking_type = self.warehouse.in_type_id
        picking = self.env['stock.picking'].create({
            'picking_type_id': picking_type.id,
            'partner_id': partner.id if partner else False,
            'location_id': picking_type.default_location_src_id.id,
            'location_dest_id': picking_type.default_location_dest_id.id,
            'move_ids': [Command.create({
                'product_id': self.product.id, 'product_uom_qty': qty,
                'location_id': picking_type.default_location_src_id.id,
                'location_dest_id': picking_type.default_location_dest_id.id,
            })],
        })
        picking.action_confirm()
        return picking

    def _fill(self, picking):
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            move.picked = True

    def _return(self, picking, qty=None):
        wizard = self.env['stock.return.picking'].with_context(
            active_id=picking.id, active_model='stock.picking').create({})
        if qty is not None:
            wizard.product_return_moves.quantity = qty
        returned = self.env['stock.picking'].browse(wizard.action_create_returns()['res_id'])
        return returned

    def test_draft_receipt_without_supplier_is_allowed(self):
        picking = self.env['stock.picking'].create({
            'picking_type_id': self.warehouse.in_type_id.id,
            'location_id': self.warehouse.in_type_id.default_location_src_id.id,
            'location_dest_id': self.warehouse.in_type_id.default_location_dest_id.id,
        })
        self.assertEqual(picking.state, 'draft')
        self.assertFalse(picking.partner_id)

    def test_receipt_without_supplier_is_refused_on_validation(self):
        picking = self._manual_receipt()
        self._fill(picking)
        with self.assertRaisesRegex(UserError, "Receipts need a supplier before they can be validated."):
            picking.button_validate()
        self.assertNotEqual(picking.state, 'done')

    def test_manual_receipt_with_supplier_validates(self):
        picking = self._manual_receipt(partner=self.vendor)
        self._fill(picking)
        picking.button_validate()
        self.assertEqual(picking.state, 'done')
        self.assertEqual(self.product.qty_available, 5)

    def test_purchase_order_receipt_still_validates(self):
        order = self.env['purchase.order'].create({
            'partner_id': self.vendor.id,
            'order_line': [Command.create({
                'product_id': self.product.id, 'product_qty': 3, 'price_unit': 100})],
        })
        order.button_confirm()
        picking = order.picking_ids
        self.assertEqual(picking.partner_id, self.vendor)
        self._fill(picking)
        picking.button_validate()
        self.assertEqual(picking.state, 'done')

    def test_return_is_not_supplier_stock_and_skips_the_check(self):
        receipt = self._manual_receipt(partner=self.vendor, qty=5)
        self._fill(receipt)
        receipt.button_validate()
        move_line = self.env['stock.move.line']
        domain = move_line._clothcraft_supplier_receipt_domain() + [('product_id', '=', self.product.id)]
        self.assertEqual(len(move_line.search(domain)), 1)

        # send 2 back to the vendor, then take 1 of those back again
        to_vendor = self._return(receipt, qty=2)
        self._fill(to_vendor)
        to_vendor.button_validate()
        back = self._return(to_vendor, qty=1)
        self.assertEqual(back.picking_type_code, 'incoming')
        back.partner_id = False  # a return may carry no partner
        self._fill(back)
        back.button_validate()  # not blocked: it is a return
        self.assertEqual(back.state, 'done')

        # the returned-back line comes from the supplier location but is not supplier stock
        lines = move_line.search(domain)
        self.assertEqual(lines.picking_id, receipt)
        self.assertEqual(len(lines), 1)
