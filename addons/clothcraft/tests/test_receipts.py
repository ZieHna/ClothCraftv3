from odoo import Command
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestReceiptsValidateWithOrWithoutSupplier(TransactionCase):
    """The supplier on a receipt is information only: it never blocks validation."""

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
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            move.picked = True
        return picking

    def test_receipt_without_supplier_validates(self):
        picking = self._manual_receipt()
        picking.button_validate()
        self.assertEqual(picking.state, 'done')
        self.assertEqual(self.product.qty_available, 5)

    def test_receipt_with_supplier_validates(self):
        picking = self._manual_receipt(partner=self.vendor)
        picking.button_validate()
        self.assertEqual(picking.state, 'done')

    def test_purchase_order_receipt_validates(self):
        order = self.env['purchase.order'].create({
            'partner_id': self.vendor.id,
            'order_line': [Command.create({
                'product_id': self.product.id, 'product_qty': 3, 'price_unit': 100})],
        })
        order.button_confirm()
        picking = order.picking_ids
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            move.picked = True
        picking.button_validate()
        self.assertEqual(picking.state, 'done')
