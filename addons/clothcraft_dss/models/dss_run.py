"""One DSS run (B8 S2): when, by what, on which data, with which rules and libraries, and its outputs.

A run is ONE transaction (the cron's cursor):
  1. pg_try_advisory_xact_lock: when another run holds it, log and stop; no row is written.
  2. the run row is created `running` (sudo, runner flag);
  3. inside a savepoint: the engine reads the native facts through this cursor (one REPEATABLE READ snapshot) and computes, the six output
     tables are written, and the run is finished `done` with its metadata;
  4. on any error the savepoint is rolled back (every output row goes) and the run is finished `failed` with the error text; the error is
     not raised again, so the failed row commits and the cron is never switched off by Odoo's failure counter.
  Before step 2 a cron run commits an attempt marker on its own connection (ATTEMPT_KEY): a run killed by the time limit or a restart is
  then recorded as failed ("interrupted") on the job's next start instead of being computed again (B8 S2b).
Nobody else ever sees a `running` row: it exists only inside that transaction, and a crash rolls it back with everything else.

Runs start only from a cron, never inside a web request: the weekly cron (installed inactive) and the "run now" cron (active, next call in
2999, so it fires only when triggered: Odoo ignores triggers of an inactive cron). The "Run now" button only adds a trigger.
Append only like the outputs (dss_outputs.py): a run can be written only by the runner and only while it is `running`; the database
trigger lets a row in only as `running`, lets it be changed only while `running` (keeping its company, start and trigger), and refuses
every DELETE.
"""
import hashlib
import json
import logging
import time

from odoo import api, fields, models
from odoo.exceptions import AccessError, UserError

from .dss_outputs import RUNNER

_logger = logging.getLogger(__name__)

LOCK_KEY = 'clothcraft_dss.run'
ADMIN_GROUP = 'clothcraft.group_admin'
RUN_NOW_CRON = 'clothcraft_dss.ir_cron_dss_run_now'
WEEKLY_CRON = 'clothcraft_dss.ir_cron_dss_weekly'
# B8 S2b: the attempt being served ("<slot>|<started at>"), committed in its own transaction before the run computes. Odoo deletes a job's
# triggers (and moves its next call) in the job-control transaction, which commits only after the job: a run killed at the time limit or by
# a restart leaves the trigger (or the past next call) in place and the job starts again. That transaction also holds row locks on those
# triggers, so they cannot be deleted from another connection without waiting on the job itself. Instead, a run that finds its own slot
# already marked records a failed run ("interrupted") and returns; the job then completes and Odoo's own clean-up commits.
ATTEMPT_KEY = 'clothcraft_dss.attempt'
OUTPUTS = (('forecast', 'clothcraft.dss.forecast'), ('backtest', 'clothcraft.dss.backtest'), ('restock', 'clothcraft.dss.restock'),
           ('segments', 'clothcraft.dss.segment'), ('alerts', 'clothcraft.dss.alert'), ('health_monthly', 'clothcraft.dss.health'),
           ('actuals', 'clothcraft.dss.actual'))

RUN_GUARD_SQL = """
    CREATE OR REPLACE FUNCTION clothcraft_dss_run_guard() RETURNS trigger AS $$
    BEGIN
        IF TG_OP = 'INSERT' THEN
            IF NEW.state <> 'running' THEN
                RAISE EXCEPTION 'A DSS run must start as running';
            END IF;
            RETURN NEW;
        ELSIF TG_OP = 'UPDATE' THEN
            IF OLD.state <> 'running' THEN
                RAISE EXCEPTION 'A finished DSS run cannot be changed';
            END IF;
            IF NEW.state NOT IN ('running', 'done', 'failed') THEN
                RAISE EXCEPTION 'Invalid DSS run state';
            END IF;
            IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.started_at IS DISTINCT FROM OLD.started_at
               OR NEW.trigger IS DISTINCT FROM OLD.trigger THEN
                RAISE EXCEPTION 'A DSS run keeps its origin';
            END IF;
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'DSS runs cannot be deleted';
    END;
    $$ LANGUAGE plpgsql"""


# ---------------------------------------------------------------------------------------------------------------- value helpers
def _missing(v):
    return v is None or v != v      # None, NaN and NaT (neither equals itself)


def _num(v, default=0.0):
    return default if _missing(v) else float(v)


def _int(v):
    return 0 if _missing(v) else int(v)


def _txt(v):
    return False if _missing(v) or v == '' else str(v)


def _date(v):
    if _missing(v) or v == '':
        return False
    return v.date() if hasattr(v, 'date') else fields.Date.to_date(str(v)[:10])


def _json(s):
    if _missing(s) or s == '':
        return False
    return json.loads(s) if isinstance(s, str) else s


class ClothcraftDssRun(models.Model):
    _name = 'clothcraft.dss.run'
    _inherit = ['clothcraft.dss.guard']
    _description = 'DSS run'
    _order = 'id desc'

    state = fields.Selection([('running', 'Running'), ('done', 'Done'), ('failed', 'Failed')], required=True, default='running', readonly=True)
    trigger = fields.Selection([('cron', 'Weekly job'), ('manual', 'Run now'), ('import', 'Import')], required=True, readonly=True)
    requested_by_uid = fields.Integer(readonly=True, help="The user who pressed Run now (0: the weekly job, or not known). Not a link.")
    requested_by_name = fields.Char(readonly=True)
    company_id = fields.Many2one('res.company', required=True, readonly=True, ondelete='restrict', default=lambda self: self.env.company)
    started_at = fields.Datetime(required=True, readonly=True)
    finished_at = fields.Datetime(readonly=True)
    duration_s = fields.Float(string="Seconds", readonly=True, digits=(16, 1))
    as_of = fields.Date(readonly=True)
    as_of_end_utc = fields.Datetime(readonly=True)
    source_db = fields.Char(readonly=True)
    module_version = fields.Char(readonly=True)
    engine_version = fields.Char(readonly=True)
    simulated = fields.Boolean(readonly=True)
    label = fields.Char(readonly=True)
    closed_rule = fields.Selection([('closed_state', 'Closed state'), ('delivered_and_paid', 'Delivered and paid')], readonly=True)
    closed_rule_text = fields.Char(readonly=True)
    params = fields.Json(readonly=True)
    status = fields.Json(readonly=True)
    selection = fields.Json(readonly=True)
    summary = fields.Json(readonly=True)
    libraries = fields.Json(readonly=True)
    row_counts = fields.Json(readonly=True)
    input_fingerprint = fields.Char(readonly=True)
    output_hash = fields.Char(readonly=True)
    bundle_sha256 = fields.Char(readonly=True, help="An imported run: the SHA-256 of the bundle it came from (its manifest's bundle_sha256).")
    trigger_ref = fields.Char(readonly=True, index=True,
                              help="The cron execution this run served (B8 S4b): 'manual:<trigger id>' for Run now (the API's request id), "
                                   "'cron:<scheduled time>' for the weekly job; empty for a run started from code or an import.")
    error = fields.Text(readonly=True)
    technical_text = fields.Text(compute='_compute_technical_text', string="Technical details")

    forecast_ids = fields.One2many('clothcraft.dss.forecast', 'run_id', readonly=True)
    backtest_ids = fields.One2many('clothcraft.dss.backtest', 'run_id', readonly=True)
    restock_ids = fields.One2many('clothcraft.dss.restock', 'run_id', readonly=True)
    segment_ids = fields.One2many('clothcraft.dss.segment', 'run_id', readonly=True)
    alert_ids = fields.One2many('clothcraft.dss.alert', 'run_id', readonly=True)
    health_ids = fields.One2many('clothcraft.dss.health', 'run_id', readonly=True)
    actual_ids = fields.One2many('clothcraft.dss.actual', 'run_id', readonly=True)

    @api.depends('as_of', 'state')
    def _compute_display_name(self):
        for run in self:
            run.display_name = f"DSS {run.as_of or '-'} #{run.id}" if run.id else "DSS run"

    def _compute_technical_text(self):
        for run in self:
            run.technical_text = json.dumps({k: run[k] for k in ('params', 'status', 'selection', 'libraries', 'row_counts')}, indent=1,
                                            sort_keys=True, default=str)

    def _dss_can_write(self, vals):
        return bool(self.env.context.get(RUNNER)) and all(run.state == 'running' for run in self)

    def init(self):
        super().init()
        cr = self.env.cr
        cr.execute(RUN_GUARD_SQL)
        cr.execute('DROP TRIGGER IF EXISTS clothcraft_dss_run_guard ON clothcraft_dss_run')
        cr.execute('CREATE TRIGGER clothcraft_dss_run_guard BEFORE INSERT OR UPDATE OR DELETE ON clothcraft_dss_run '
                   'FOR EACH ROW EXECUTE FUNCTION clothcraft_dss_run_guard()')

    # ------------------------------------------------------------------------------------------------------------ reading
    @api.model
    def _latest_done(self, company=None, simulated=False):
        """The latest finished run of the company (failed runs are never chosen), or an empty recordset. Real and simulated runs have
        separate latests (B8 S3): by default only real runs count, so an imported simulated bundle is never chosen over a real run;
        simulated=True asks for the latest simulated run instead."""
        company = company or self.env.company
        return self.search([('state', '=', 'done'), ('company_id', '=', company.id), ('simulated', '=', bool(simulated))],
                           order='finished_at desc, id desc', limit=1)

    # ------------------------------------------------------------------------------------------------------------ starting
    def action_run_now(self):
        """The Administrator's button: queue the "run now" cron. Nothing is computed in this request."""
        if not self.env.user.has_group(ADMIN_GROUP):
            raise AccessError(self.env._("Only an Administrator can start a DSS run."))
        cron = self.env.ref(RUN_NOW_CRON).sudo()
        if self.env['ir.cron.trigger'].sudo().search_count([('cron_id', '=', cron.id)]):
            raise UserError(self.env._("A DSS run is already queued; it appears in this list when it has finished."))
        cron._trigger()
        return {'type': 'ir.actions.client', 'tag': 'display_notification',
                'params': {'type': 'success', 'sticky': False, 'title': self.env._("DSS run queued"),
                           'message': self.env._("It appears in this list when it has finished.")}}

    @api.model
    def _cron_dss_run(self, trigger):
        """Entry point of both crons."""
        return self._run(trigger)

    def _requester(self, trigger):
        """(uid, name): for "run now", who created the trigger being served; the weekly job has no requester."""
        if trigger != 'manual':
            return 0, False
        cron = self.env.ref(RUN_NOW_CRON, raise_if_not_found=False)
        trig = self.env['ir.cron.trigger'].sudo().search([('cron_id', '=', cron.id), ('call_at', '<=', fields.Datetime.now())],
                                                         order='call_at, id', limit=1) if cron else self.env['ir.cron.trigger']
        user = trig.create_uid
        return (user.id, user.name) if user else (0, False)

    # ------------------------------------------------------------------------------------------------------------ attempts
    def _attempt_slot(self, trigger):
        """What this cron execution serves: the oldest due trigger of "run now", or the weekly cron's scheduled time. None otherwise
        (a run started from code, such as a test, has no slot and no marker)."""
        if trigger == 'manual':
            cron = self.env.ref(RUN_NOW_CRON, raise_if_not_found=False)
            trig = self.env['ir.cron.trigger'].sudo().search([('cron_id', '=', cron.id), ('call_at', '<=', fields.Datetime.now())],
                                                             order='call_at, id', limit=1) if cron else None
            return f'manual:{trig.id}' if trig else None
        if trigger == 'cron':
            cron = self.env.ref(WEEKLY_CRON, raise_if_not_found=False)
            if cron:
                self.env.cr.execute('SELECT nextcall FROM ir_cron WHERE id = %s', [cron.id])
                return f'cron:{self.env.cr.fetchone()[0]}'
        return None

    def _attempt_marker(self):
        self.env.cr.execute('SELECT value FROM ir_config_parameter WHERE key = %s', [ATTEMPT_KEY])
        row = self.env.cr.fetchone()
        return row[0] if row else None

    def _commit_attempt_marker(self, value):
        """Written and committed on its own connection, so it survives the run's transaction being killed."""
        with self.env.registry.cursor() as cr:
            cr.execute("""
                INSERT INTO ir_config_parameter (key, value, create_uid, create_date, write_uid, write_date)
                VALUES (%s, %s, %s, now() at time zone 'UTC', %s, now() at time zone 'UTC')
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, write_date = EXCLUDED.write_date""",
                       [ATTEMPT_KEY, value, self.env.uid, self.env.uid])

    # ------------------------------------------------------------------------------------------------------------ the run
    @api.model
    def _run(self, trigger, params=None):
        cr = self.env.cr
        cr.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0))', [LOCK_KEY])
        if not cr.fetchone()[0]:
            _logger.warning("DSS run (%s) skipped: another DSS run is in progress", trigger)
            return self.browse()
        uid, name = self._requester(trigger)
        runner = self.sudo().with_context(**{RUNNER: True})
        slot = self._attempt_slot(trigger)
        previous = self._attempt_marker()
        if slot and previous and previous.split('|')[0] == slot:
            started = previous.split('|')[1] if '|' in previous else '?'
            run = runner.create({'trigger': trigger, 'requested_by_uid': uid, 'requested_by_name': name, 'company_id': self.env.company.id,
                                 'started_at': fields.Datetime.now(), 'trigger_ref': slot})
            run.write({'state': 'failed', 'finished_at': fields.Datetime.now(), 'duration_s': 0.0,
                       'error': f'Interrupted: the attempt started at {started} UTC did not finish (time limit or server restart). '
                                f'It is not run again; press Run now to start a new run.'})
            _logger.error("DSS run %s: attempt %s was interrupted earlier; recorded as failed, not run again", run.id, slot)
            return run
        if slot:
            self._commit_attempt_marker(f'{slot}|{fields.Datetime.now()}')
        run = runner.create({'trigger': trigger, 'requested_by_uid': uid, 'requested_by_name': name, 'company_id': self.env.company.id,
                             'started_at': fields.Datetime.now(), 'trigger_ref': slot or False})
        t0 = time.monotonic()
        try:
            with cr.savepoint():
                self.env.flush_all()
                from ..engine import bundle  # lazy: pandas and statsmodels load only when a run starts
                result = bundle.run_all(cr, None, params)
                counts = run._dss_write_outputs(result)
                run.write({**run._dss_meta(result), 'row_counts': counts, 'output_hash': run._dss_output_hash(result),
                           'state': 'done', 'finished_at': fields.Datetime.now(), 'duration_s': round(time.monotonic() - t0, 1)})
                self.env.flush_all()
        except Exception as exc:  # the savepoint is rolled back: no output row of this run remains
            _logger.exception("DSS run %s failed", run.id)
            self.env.invalidate_all()
            run.write({'state': 'failed', 'error': f'{type(exc).__name__}: {exc}'[:2000], 'finished_at': fields.Datetime.now(),
                       'duration_s': round(time.monotonic() - t0, 1)})
        _logger.info("DSS run %s %s in %.1f s", run.id, run.state, time.monotonic() - t0)
        return run

    def _dss_meta(self, result):
        from ..engine import bundle
        m = bundle._clean(result['meta'])
        s = bundle._clean(result['summary'])
        seg = result['tables'].get('segment_summary')
        s['segment_summary'] = bundle._clean(seg.to_dict('records')) if seg is not None else []
        return {'as_of': m['as_of'], 'as_of_end_utc': m['as_of_end_utc'][:19], 'source_db': m['source_db'], 'module_version': m['module_version'],
                'engine_version': m['engine_version'], 'simulated': bool(m['simulated']), 'label': m['label'] or False,
                'closed_rule': m['closed_rule'], 'closed_rule_text': m['closed_rule_text'], 'params': m['params'], 'status': m['status'],
                'libraries': m['libraries'], 'input_fingerprint': m['input_fingerprint'], 'selection': s.pop('selection'), 'summary': s}

    def _dss_output_hash(self, result):
        """SHA-256 over the engine's canonical fingerprint of the six tables and the sorted summary JSON."""
        from ..engine import bundle, transform
        tables = {name: result['tables'][name] for name, _ in OUTPUTS}
        summary = json.dumps(bundle._clean(result['summary']), sort_keys=True)
        return hashlib.sha256((transform.fingerprint(tables)['all'] + '\n' + hashlib.sha256(summary.encode()).hexdigest()).encode()).hexdigest()

    def _dss_write_outputs(self, result):
        self.ensure_one()
        counts = {}
        labels = self._dss_product_labels(result['tables']['restock'])
        for name, model in OUTPUTS:
            rows = [self._dss_row(name, r, labels) for r in result['tables'][name].to_dict('records')]
            self._dss_write_table(model, rows)
            counts[name] = len(rows)
        return counts

    def _dss_write_table(self, model, rows):
        if rows:
            self.env[model].sudo().with_context(**{RUNNER: True}).create([{**r, 'run_id': self.id} for r in rows])

    @staticmethod
    def _dss_product_labels(restock):
        if restock is None or not len(restock) or 'template_id' not in restock:
            return {}
        return {str(int(t)): p for t, p in zip(restock['template_id'], restock['product']) if not _missing(t)}

    @staticmethod
    def _dss_row(name, r, labels):
        if name == 'forecast':
            key = str(int(r['key'])) if r['level'] == 'product' and not _missing(r['key']) else str(r['key'])
            return {'level': r['level'], 'key': key, 'key_label': labels.get(key, key) if r['level'] == 'product' else key,
                    'week_start': _date(r['week_start']), 'h': _int(r['h']), 'yhat': _num(r['yhat']), 'has_interval': not _missing(r['lo80']),
                    'lo80': _num(r['lo80']), 'hi80': _num(r['hi80']), 'lo95': _num(r['lo95']), 'hi95': _num(r['hi95']),
                    'method': _txt(r['method']), 'flags': _txt(r['flags']), 'censored': bool(r['censored']) if not _missing(r['censored']) else False}
        if name == 'backtest':
            key = r['key']
            key = str(int(key)) if isinstance(key, float) and key.is_integer() else str(key)
            return {'level': _txt(r['level']), 'key': key, 'policy': _txt(r['policy']), 'horizon': _txt(r['horizon']), 'weeks': _txt(r['weeks']),
                    'n': _int(r['n']), 'n_int': _int(r['n_int']), 'has_metrics': not _missing(r['wape']), 'mae': _num(r['mae']),
                    'wape': _num(r['wape']), 'bias': _num(r['bias']), 'has_coverage': not _missing(r['cov80']), 'cov80': _num(r['cov80']),
                    'cov95': _num(r['cov95']), 'chosen': bool(r['chosen'])}
        if name == 'restock':
            g = r.get
            return {'product_key': _int(g('product_id')), 'template_key': _int(g('template_id')), 'sku': _txt(g('sku')), 'product': _txt(g('product')),
                    'garment_type': _txt(g('garment_type')), 'size': _txt(g('size')), 'color': _txt(g('color')), 'on_hand': _num(g('on_hand')),
                    'reserved': _num(g('reserved')), 'free': _num(g('free')), 'incoming': _num(g('incoming')), 'share': _num(g('share')),
                    'daily_demand': _num(g('daily_demand')), 'days_left': _int(g('days_left')), 'runout_date': _date(g('runout_date')),
                    'runout_date_hi80': _date(g('runout_date_hi80')), 'supplier_key': _int(g('supplier_id')), 'supplier': _txt(g('supplier')),
                    'unit_cost': _num(g('unit_cost')), 'landed_unit_cost': _num(g('landed_unit_cost')), 'est_cost': _num(g('est_cost')),
                    'lead_p50': _num(g('lead_p50')), 'lead_p90': _num(g('lead_p90')), 'lead_source': _txt(g('lead_source')),
                    'lead_days': _int(g('lead_days')), 'safety_stock': _num(g('safety_stock')), 'reorder_point': _num(g('reorder_point')),
                    'order_up_to': _num(g('order_up_to')), 'suggested_qty': _int(g('suggested_qty')), 'order_by': _date(g('order_by')),
                    'order_now': bool(g('order_now')) if not _missing(g('order_now')) else False,
                    'stockout_before_arrival': bool(g('stockout_before_arrival')) if not _missing(g('stockout_before_arrival')) else False,
                    'arrives_before_runout': bool(g('arrives_before_runout')) if not _missing(g('arrives_before_runout')) else False,
                    'coverage_risk': bool(g('coverage_risk')) if not _missing(g('coverage_risk')) else False,
                    'capped': 'capped' in (_txt(g('flags')) or ''), 'alternatives': _json(g('alternatives')), 'status': _txt(g('status')),
                    'flags': _txt(g('flags'))}
        if name == 'segments':
            return {'customer_key': _txt(r['customer_key']), 'partner_key': _int(r['partner_id']), 'recency_days': _int(r['recency_days']),
                    'frequency': _int(r['frequency']), 'monetary': _num(r['monetary']), 'r_score': _int(r['r_score']), 'f_score': _int(r['f_score']),
                    'm_score': _int(r['m_score']), 'segment': _txt(r['segment']), 'segment_name': _txt(r['segment_name'])}
        if name == 'alerts':
            return {'kind': _txt(r['kind']), 'band': _txt(r['band']), 'severity': _txt(r['severity']), 'subject_type': _txt(r['subject_type']),
                    'subject_key': _int(r['subject_id']), 'subject_label': _txt(r['subject_label']), 'has_age': not _missing(r['age_days']),
                    'age_days': _num(r['age_days']), 'message': _txt(r['message'])}
        if name == 'health_monthly':
            return {'month': r['month'], 'month_start': fields.Date.to_date(r['month'] + '-01'), 'complete': bool(r['complete']),
                    'revenue': _num(r['revenue']), 'closed_orders': _int(r['closed_orders']), 'spending': _num(r['spending']), 'cogs': _num(r['cogs']),
                    'closed_units': _num(r['closed_units']), 'units_without_cost': _int(r['units_without_cost']), 'net_cash': _num(r['net_cash']),
                    'net_margin': _num(r['net_margin']), 'has_ma3': not _missing(r['revenue_ma3']), 'revenue_ma3': _num(r['revenue_ma3']),
                    'net_cash_ma3': _num(r['net_cash_ma3']), 'net_margin_ma3': _num(r['net_margin_ma3']), 'flags': _txt(r['flags'])}
        if name == 'actuals':
            key = r['key']
            key = str(int(key)) if isinstance(key, float) and key.is_integer() else str(key)
            return {'level': r['level'], 'key': key, 'week_start': _date(r['week_start']), 'units': _num(r['units']),
                    'censored': bool(r['censored']) if not _missing(r['censored']) else False}
        raise ValueError(name)
