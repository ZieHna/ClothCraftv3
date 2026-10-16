from odoo import api, fields, models, tools
from odoo.tools import SQL

NO_SUPPLIER = "No supplier"


class ClothcraftStockListing(models.Model):
    """Read-only stock list: one row per variant, or per lot when the stock is lot-tracked."""
    _name = 'clothcraft.stock.listing'
    _description = 'Stock Listing'
    _auto = False
    _order = 'product_id, lot_id'

    product_id = fields.Many2one('product.product', string="Variant", readonly=True)
    lot_id = fields.Many2one('stock.lot', string="Lot", readonly=True)
    company_id = fields.Many2one('res.company', readonly=True)
    quantity = fields.Float(string="On Hand", digits='Product Unit', readonly=True)
    list_price = fields.Float(
        string="Sale Price", digits='Product Price', related='product_id.lst_price')
    standard_price = fields.Float(
        string="Cost", digits='Product Price', related='product_id.standard_price')
    first_received = fields.Datetime(
        string="First Received", compute='_compute_arrival',
        help="Earliest supplier receipt of this variant (or lot).")
    supplier = fields.Char(
        compute='_compute_arrival',
        help="Vendor of the purchase order line, else the partner, of that first supplier receipt, "
             "else 'No supplier'. Returns never count as supplier receipts.")

    def init(self):
        tools.drop_view_if_exists(self.env.cr, self._table)
        self.env.cr.execute(SQL("""
            CREATE VIEW %s AS (
                SELECT min(quant.id) AS id,
                       quant.product_id,
                       quant.lot_id,
                       quant.company_id,
                       sum(quant.quantity) AS quantity
                  FROM stock_quant quant
                  JOIN stock_location location ON location.id = quant.location_id
                 WHERE location.usage = 'internal'
              GROUP BY quant.product_id, quant.lot_id, quant.company_id
                HAVING sum(quant.quantity) > 0
            )
        """, SQL.identifier(self._table)))

    @api.depends('product_id', 'lot_id')
    def _compute_arrival(self):
        MoveLine = self.env['stock.move.line']
        lines = MoveLine.search(
            MoveLine._clothcraft_supplier_receipt_domain()
            + [('product_id', 'in', self.product_id.ids)], order='date, id')
        first = {}  # oldest first, so the first receipt seen per key is the earliest
        for line in lines:
            first.setdefault((line.product_id.id, line.lot_id.id), line)
        for row in self:
            line = first.get((row.product_id.id, row.lot_id.id))
            row.first_received = line.date if line else False
            partner = (line.move_id.purchase_line_id.order_id.partner_id
                       or line.picking_id.partner_id) if line else False
            row.supplier = partner.display_name if partner else NO_SUPPLIER
