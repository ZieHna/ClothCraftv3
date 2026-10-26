"""The DSS output tables (B8 S2). Append only, on three layers like the order audit:
  - access lines: the Administrator may only read; no group may create, write or delete (security/ir.model.access.csv);
  - the ORM: create needs the runner's context flag (only clothcraft.dss.run._run sets it), write and unlink are refused;
  - the database: a trigger lets a row in only while its run is `running`, and refuses every UPDATE and DELETE.
TRUNCATE and DROP TABLE (module uninstall) are not row operations, so the trigger does not see them.

Odoo stores an empty Integer or Float as 0, so a figure that can be missing has a companion field (a date that can be empty, or a has_*
flag); NaN is never stored. Products, partners and suppliers are plain integer ids plus labels, not links: a simulated run imported later
(S3) has ids that do not exist here, and deleting a product or a partner never has to change history.
"""
from odoo import api, fields, models
from odoo.exceptions import UserError

RUNNER = 'clothcraft_dss_runner'

OUTPUT_GUARD_SQL = """
    CREATE OR REPLACE FUNCTION clothcraft_dss_output_guard() RETURNS trigger AS $$
    BEGIN
        IF TG_OP = 'INSERT' THEN
            IF NOT EXISTS (SELECT 1 FROM clothcraft_dss_run WHERE id = NEW.run_id AND state = 'running') THEN
                RAISE EXCEPTION 'DSS output can only be added to a running run';
            END IF;
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'DSS output cannot be changed or deleted';
    END;
    $$ LANGUAGE plpgsql"""


class ClothcraftDssGuard(models.AbstractModel):
    """Create only by the runner; write only where the model allows it (_dss_can_write); never unlink. The access lines are checked
    first, so a call without sudo fails on them (AccessError) and the ORM refusal (UserError) is the layer behind them."""
    _name = 'clothcraft.dss.guard'
    _description = 'DSS append-only guard'

    @api.model_create_multi
    def create(self, vals_list):
        self.browse().check_access('create')
        if not self.env.context.get(RUNNER):
            raise UserError(self.env._("DSS records are written only by a DSS run."))
        return super().create(vals_list)

    def _dss_can_write(self, vals):
        return False

    def write(self, vals):
        self.check_access('write')
        if not self._dss_can_write(vals):
            raise UserError(self.env._("DSS records cannot be changed."))
        return super().write(vals)

    def unlink(self):
        self.check_access('unlink')
        raise UserError(self.env._("DSS records cannot be deleted."))


class ClothcraftDssOutput(models.AbstractModel):
    """What every output table shares: its run, and the row trigger."""
    _name = 'clothcraft.dss.output'
    _inherit = ['clothcraft.dss.guard']
    _description = 'DSS output row'
    _order = 'id'

    run_id = fields.Many2one('clothcraft.dss.run', required=True, index=True, ondelete='restrict', readonly=True)

    def init(self):
        super().init()
        if self._abstract:
            return
        cr = self.env.cr
        cr.execute(OUTPUT_GUARD_SQL)
        name = f'{self._table}_guard'
        cr.execute(f'DROP TRIGGER IF EXISTS {name} ON {self._table}')
        cr.execute(f'CREATE TRIGGER {name} BEFORE INSERT OR UPDATE OR DELETE ON {self._table} '
                   f'FOR EACH ROW EXECUTE FUNCTION clothcraft_dss_output_guard()')


LEVELS = [('product', 'Product'), ('garment_type', 'Garment type'), ('total', 'Total')]


class ClothcraftDssForecast(models.Model):
    _name = 'clothcraft.dss.forecast'
    _inherit = ['clothcraft.dss.output']
    _description = 'DSS weekly demand forecast'

    level = fields.Selection(LEVELS, required=True, readonly=True)
    key = fields.Char(required=True, readonly=True, help="Product template id, garment type code or 'total'.")
    key_label = fields.Char(readonly=True)
    week_start = fields.Date(required=True, readonly=True, help="The Monday of the week (Manila).")
    h = fields.Integer(string="Weeks ahead", readonly=True)
    yhat = fields.Float(string="Forecast units", readonly=True)
    has_interval = fields.Boolean(readonly=True)
    lo80 = fields.Float(readonly=True)
    hi80 = fields.Float(readonly=True)
    lo95 = fields.Float(readonly=True)
    hi95 = fields.Float(readonly=True)
    method = fields.Char(readonly=True)
    flags = fields.Char(readonly=True)
    censored = fields.Boolean(readonly=True)


class ClothcraftDssBacktest(models.Model):
    _name = 'clothcraft.dss.backtest'
    _inherit = ['clothcraft.dss.output']
    _description = 'DSS forecast backtest metrics'

    level = fields.Char(readonly=True)
    key = fields.Char(readonly=True)
    policy = fields.Char(readonly=True)
    horizon = fields.Char(readonly=True, help="'all' or the number of weeks ahead.")
    weeks = fields.Char(readonly=True, help="'all' or 'uncensored'.")
    n = fields.Integer(readonly=True)
    n_int = fields.Integer(string="With interval", readonly=True)
    has_metrics = fields.Boolean(readonly=True, help="WAPE and bias are defined (the actuals sum above 0).")
    mae = fields.Float(readonly=True)
    wape = fields.Float(readonly=True)
    bias = fields.Float(readonly=True)
    has_coverage = fields.Boolean(readonly=True)
    cov80 = fields.Float(readonly=True)
    cov95 = fields.Float(readonly=True)
    chosen = fields.Boolean(readonly=True)


class ClothcraftDssRestock(models.Model):
    _name = 'clothcraft.dss.restock'
    _inherit = ['clothcraft.dss.output']
    _description = 'DSS restock recommendation'

    product_key = fields.Integer(string="Variant id", readonly=True)
    template_key = fields.Integer(string="Product id", readonly=True)
    sku = fields.Char(readonly=True)
    product = fields.Char(readonly=True)
    garment_type = fields.Char(readonly=True)
    size = fields.Char(readonly=True)
    color = fields.Char(readonly=True)
    on_hand = fields.Float(readonly=True)
    reserved = fields.Float(readonly=True)
    free = fields.Float(readonly=True)
    incoming = fields.Float(readonly=True)
    share = fields.Float(readonly=True, digits=(16, 6))
    daily_demand = fields.Float(readonly=True, digits=(16, 4))
    days_left = fields.Integer(readonly=True, help="Meaningful only with a run-out date.")
    runout_date = fields.Date(readonly=True, help="Empty: no run-out within the forecast.")
    runout_date_hi80 = fields.Date(readonly=True)
    supplier_key = fields.Integer(readonly=True, help="0: no eligible supplier.")
    supplier = fields.Char(readonly=True)
    unit_cost = fields.Float(readonly=True)
    landed_unit_cost = fields.Float(readonly=True)
    est_cost = fields.Float(readonly=True)
    lead_p50 = fields.Float(readonly=True)
    lead_p90 = fields.Float(readonly=True)
    lead_source = fields.Char(readonly=True)
    lead_days = fields.Integer(readonly=True)
    safety_stock = fields.Float(readonly=True)
    reorder_point = fields.Float(readonly=True)
    order_up_to = fields.Float(readonly=True)
    suggested_qty = fields.Integer(readonly=True)
    order_by = fields.Date(readonly=True)
    order_now = fields.Boolean(readonly=True)
    stockout_before_arrival = fields.Boolean(readonly=True)
    arrives_before_runout = fields.Boolean(readonly=True)
    coverage_risk = fields.Boolean(readonly=True)
    capped = fields.Boolean(readonly=True)
    alternatives = fields.Json(readonly=True)
    status = fields.Char(readonly=True)
    flags = fields.Char(readonly=True)


class ClothcraftDssSegment(models.Model):
    _name = 'clothcraft.dss.segment'
    _inherit = ['clothcraft.dss.output']
    _description = 'DSS customer segment (RFM)'

    customer_key = fields.Char(readonly=True, help="The partner id, or a pseudonym on a simulated run.")
    partner_key = fields.Integer(readonly=True, help="0 on a simulated run.")
    recency_days = fields.Integer(readonly=True)
    frequency = fields.Integer(readonly=True)
    monetary = fields.Float(readonly=True)
    r_score = fields.Integer(readonly=True)
    f_score = fields.Integer(readonly=True)
    m_score = fields.Integer(readonly=True)
    segment = fields.Char(readonly=True)
    segment_name = fields.Char(readonly=True)


class ClothcraftDssAlert(models.Model):
    _name = 'clothcraft.dss.alert'
    _inherit = ['clothcraft.dss.output']
    _description = 'DSS alert'

    kind = fields.Char(readonly=True)
    band = fields.Char(readonly=True)
    severity = fields.Selection([('info', 'Info'), ('warning', 'Warning'), ('critical', 'Critical')], readonly=True)
    subject_type = fields.Char(readonly=True)
    subject_key = fields.Integer(readonly=True)
    subject_label = fields.Char(readonly=True)
    has_age = fields.Boolean(readonly=True)
    age_days = fields.Float(readonly=True)
    message = fields.Char(readonly=True)


class ClothcraftDssActual(models.Model):
    """B8 S4-0: the weekly units the forecast was trained and scored on (product and total; garment types are sums of products)."""
    _name = 'clothcraft.dss.actual'
    _inherit = ['clothcraft.dss.output']
    _description = 'DSS weekly actual units'

    level = fields.Selection([('product', 'Product'), ('total', 'Total')], required=True, readonly=True)
    key = fields.Char(required=True, readonly=True, help="Product template id, or 'total'.")
    week_start = fields.Date(required=True, readonly=True, help="The Monday of the week (Manila).")
    units = fields.Float(readonly=True)
    censored = fields.Boolean(readonly=True, help="Enough of the week's variant-days were at zero stock that the units understate demand.")


class ClothcraftDssHealth(models.Model):
    _name = 'clothcraft.dss.health'
    _inherit = ['clothcraft.dss.output']
    _description = 'DSS business health per month'

    month = fields.Char(readonly=True, help="YYYY-MM (Manila).")
    month_start = fields.Date(readonly=True)
    complete = fields.Boolean(readonly=True)
    revenue = fields.Float(readonly=True)
    closed_orders = fields.Integer(readonly=True)
    spending = fields.Float(readonly=True)
    cogs = fields.Float(string="Cost of goods sold", readonly=True)
    closed_units = fields.Float(readonly=True)
    units_without_cost = fields.Integer(readonly=True)
    net_cash = fields.Float(readonly=True)
    net_margin = fields.Float(readonly=True)
    has_ma3 = fields.Boolean(readonly=True)
    revenue_ma3 = fields.Float(readonly=True)
    net_cash_ma3 = fields.Float(readonly=True)
    net_margin_ma3 = fields.Float(readonly=True)
    flags = fields.Char(readonly=True)
