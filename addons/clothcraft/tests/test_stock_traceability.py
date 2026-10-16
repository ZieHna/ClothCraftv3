from datetime import datetime

from odoo import Command
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestStockTraceability(TransactionCase):
    """Receive one product in two lots, on two dates, from two suppliers, then check the
    questions the DSS will ask: how many are left, when did each lot arrive, who supplied it.

    The lookup helpers below are the exact join path documented in the B4 design.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.product = cls.env['product.product'].create({
            'name': 'Traceable Tee', 'type': 'consu', 'is_storable': True, 'tracking': 'lot',
        })
        cls.vendor_a = cls.env['res.partner'].create({'name': 'Supplier A'})
        cls.vendor_b = cls.env['res.partner'].create({'name': 'Supplier B'})
        cls.date_a = datetime(2026, 1, 10, 9, 0)
        cls.date_b = datetime(2026, 3, 5, 14, 30)
        cls._receive(cls.vendor_a, 'LOT-A', 10, cls.date_a)
        cls._receive(cls.vendor_b, 'LOT-B', 4, cls.date_b)

    @classmethod
    def _receive(cls, vendor, lot_name, qty, when):
        order = cls.env['purchase.order'].create({
            'partner_id': vendor.id,
            'order_line': [Command.create({
                'product_id': cls.product.id, 'product_qty': qty, 'price_unit': 100})],
        })
        order.button_confirm()
        picking = order.picking_ids
        picking.move_ids.move_line_ids.write({'lot_name': lot_name, 'quantity': qty})
        picking.move_ids.picked = True
        picking.button_validate()
        assert picking.state == 'done', picking.state
        # the real flow stamps "now"; pin the dates so the test is deterministic
        picking.move_line_ids.date = when
        picking.date_done = when

    # --- the lookups the DSS will use
    def _lot(self, name):
        return self.env['stock.lot'].search([('name', '=', name), ('product_id', '=', self.product.id)])

    def _left(self, lot):
        quants = self.env['stock.quant'].search([
            ('lot_id', '=', lot.id), ('location_id.usage', '=', 'internal')])
        return sum(quants.mapped('quantity')) - sum(quants.mapped('reserved_quantity'))

    def _arrival(self, lot):
        line = self.env['stock.move.line'].search(
            self.env['stock.move.line']._clothcraft_supplier_receipt_domain() + [('lot_id', '=', lot.id)])
        self.assertEqual(len(line), 1)
        supplier = line.move_id.purchase_line_id.order_id.partner_id
        return line.date, supplier, line.picking_id.date_done

    def test_each_lot_has_its_own_arrival_date_supplier_and_quantity(self):
        lot_a, lot_b = self._lot('LOT-A'), self._lot('LOT-B')
        self.assertEqual(len(lot_a), 1)
        self.assertEqual(len(lot_b), 1)

        date, supplier, picking_date = self._arrival(lot_a)
        self.assertEqual((date, supplier, picking_date), (self.date_a, self.vendor_a, self.date_a))
        self.assertEqual(self._left(lot_a), 10)

        date, supplier, picking_date = self._arrival(lot_b)
        self.assertEqual((date, supplier, picking_date), (self.date_b, self.vendor_b, self.date_b))
        self.assertEqual(self._left(lot_b), 4)

    def test_total_left_across_lots(self):
        quants = self.env['stock.quant'].search([
            ('product_id', '=', self.product.id), ('location_id.usage', '=', 'internal')])
        self.assertEqual(sum(quants.mapped('quantity')), 14)
        self.assertEqual(self.product.qty_available, 14)

    def test_earlier_lot_arrived_before_later_lot(self):
        self.assertLess(self._arrival(self._lot('LOT-A'))[0], self._arrival(self._lot('LOT-B'))[0])
