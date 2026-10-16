from odoo import Command
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestAverageCostHistory(TransactionCase):
    """Under average costing, every receipt at a new price rewrites standard_price through
    stock_account. The cost hook must log exactly one row per real change, and none when the
    receipt price equals the current cost."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        category = cls.env['product.category'].create(
            {'name': 'Average cost', 'property_cost_method': 'average'})
        cls.product = cls.env['product.product'].create({
            'name': 'Average Tee', 'type': 'consu', 'is_storable': True,
            'categ_id': category.id, 'standard_price': 100})
        cls.vendor = cls.env['res.partner'].create({'name': 'Average Vendor'})

    def _receive(self, qty, price):
        order = self.env['purchase.order'].create({
            'partner_id': self.vendor.id,
            'order_line': [Command.create({
                'product_id': self.product.id, 'product_qty': qty, 'price_unit': price})],
        })
        order.button_confirm()
        picking = order.picking_ids
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            move.picked = True
        picking.button_validate()

    def _cost_rows(self):
        return self.env['clothcraft.price.history'].search(
            [('product_id', '=', self.product.id), ('kind', '=', 'cost')], order='id')

    def test_receipt_at_current_cost_logs_nothing(self):
        self._receive(10, 100)
        self.assertEqual(self.product.standard_price, 100)
        self.assertFalse(self._cost_rows())

    def test_each_receipt_at_a_new_price_logs_one_row_with_the_new_average(self):
        self._receive(10, 100)
        self._receive(10, 200)
        self.assertEqual(self.product.standard_price, 150)
        self._receive(5, 200)
        self.assertEqual(self.product.standard_price, 160)
        rows = self._cost_rows()
        self.assertEqual([(r.old_price, r.new_price) for r in rows], [(100, 150), (150, 160)])
        self.assertFalse(any(rows.mapped('is_initial')))

    def _cost_rows_with_source(self):
        return [(r.old_price, r.new_price, r.description, r.partner_id) for r in self._cost_rows()]

    def test_average_cost_change_from_a_receipt_names_the_receipt_and_vendor(self):
        self._receive(10, 100)
        order = self.env['purchase.order'].create({
            'partner_id': self.vendor.id,
            'order_line': [Command.create({
                'product_id': self.product.id, 'product_qty': 10, 'price_unit': 200})],
        })
        order.button_confirm()
        picking = order.picking_ids
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            move.picked = True
        picking.button_validate()
        self.assertEqual(self._cost_rows_with_source(), [(100, 150, picking.name, self.vendor)])

    def test_manual_receipt_without_a_vendor_is_valued_at_current_cost_and_logs_nothing(self):
        self._receive(10, 100)
        warehouse = self.env['stock.warehouse'].search([('company_id', '=', self.env.company.id)], limit=1)
        picking_type = warehouse.in_type_id
        picking = self.env['stock.picking'].create({
            'picking_type_id': picking_type.id,
            'location_id': picking_type.default_location_src_id.id,
            'location_dest_id': picking_type.default_location_dest_id.id,
            'move_ids': [Command.create({
                'product_id': self.product.id, 'product_uom_qty': 10,
                'location_id': picking_type.default_location_src_id.id,
                'location_dest_id': picking_type.default_location_dest_id.id,
            })],
        })
        picking.action_confirm()
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            move.picked = True
        picking.button_validate()
        # no PO price to average in: valued at the current cost, so nothing changes and nothing is logged
        self.assertEqual(self.product.standard_price, 100)
        self.assertFalse(self._cost_rows())

    def test_manual_cost_edit_has_no_receipt_or_vendor(self):
        self.product.standard_price = 120
        rows = self._cost_rows()
        self.assertEqual([(r.old_price, r.new_price, r.description, r.partner_id.id) for r in rows],
                         [(100, 120, False, False)])
