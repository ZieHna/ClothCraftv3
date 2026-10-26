"""The DSS facade for the admin dashboard (B8 S4b): read-only methods on clothcraft.api for /api/admin/dss/*, plus Run now.

Rules (the approved S4 plan):
- Every method needs a LIVE admin-scope session (clothcraft.api._api_admin_start: the Administrator group is re-read on every call).
- The API service user has NO access line on any DSS model: each method reads the DSS tables with sudo() only after that check, and
  builds its answer from explicit field lists. Nothing here writes a DSS table; Run now only adds a cron trigger (as the Administrator, so
  the run records who asked), and import is not offered here at all.
- One run per answer: the given run (`run_id`, of this company) or the latest finished run of one kind (`kind`: real by default, or
  simulated). Real and simulated are never mixed, except in the overview, which returns them as two labelled blocks.
- Every data answer carries `run` (the envelope, _dss_ref). A simulated run carries the standing notice; a run more than STALE_DAYS old is
  `stale` and its notice says how old it is.
- A part without enough data answers rows [] with `data_status` {code, message} (the engine's own sentence). The key is not `status` /
  `message`: the service strips those top-level keys as its envelope.
Replies: ok; unauthorised; invalid (fields); not_found (a path id); no_run (message); run_failed (message); run_in_progress (message).
"""
import datetime

from odoo import api, fields, models

from .dss_run import ATTEMPT_KEY, RUN_NOW_CRON

NOTICE = 'Simulated data: demonstrates the method, not real-world accuracy.'
STALE_DAYS = 8
FRESH_ATTEMPT = datetime.timedelta(minutes=15)     # a run cannot live longer than this inside the cron limits: an older marker is not "running"
PAGE_MAX = 100
KINDS = ('real', 'simulated')
LEVELS = ('product', 'garment_type', 'total')
POLICIES = ('naive', 'ma4', 'snaive', 'ets', 'ets_croston', 'chosen')
HORIZONS = ('all',) + tuple(str(h) for h in range(1, 9))
URGENCY = ('stockout_before_arrival', 'order_now', 'plan', 'ok', 'no_forecast')
SEVERITY = ('critical', 'warning', 'info')
SEGMENTS = ('champions', 'loyal', 'potential_loyalists', 'new', 'at_risk', 'one_time_lapsed', 'hibernating', 'needs_attention')
ALERT_KINDS = ('unpaid_bank_transfer', 'forecast_stockout', 'low_stock_risk', 'restock_supplier', 'restock_overdue')
SEGMENT_SORTS = {'monetary': 'monetary desc, id', 'recency': 'recency_days, id', 'frequency': 'frequency desc, id'}
NO_RUN = 'No DSS run yet. Press Run now to start one.'
IN_PROGRESS = 'A DSS run is already queued or running. It appears here when it has finished.'
UNKNOWN_REQUEST = 'No such request, or it is no longer known.'
HISTORY_GENERIC = 'Not enough history yet.'


def _dt(value):
    return fields.Datetime.to_string(value) if value else None


def _d(value):
    return fields.Date.to_string(value) if value else None


def _flags(value):
    return [f for f in (value or '').split(',') if f]


def _part(run, part):
    return ((run.status or {}).get(part) or {}) if run else {}


class ClothcraftApiDss(models.AbstractModel):
    _inherit = 'clothcraft.api'

    # ------------------------------------------------------------------------------------------------------------ shared
    def _dss_models(self):
        env = self.env
        return {name: env[f'clothcraft.dss.{name}'].sudo() for name in ('run', 'forecast', 'backtest', 'restock', 'segment', 'alert', 'health', 'actual')}

    @api.model
    def _dss_page(self, payload, info):
        try:
            limit = min(max(int(payload.get('limit', 25)), 1), PAGE_MAX)
            offset = max(int(payload.get('offset', 0)), 0)
        except (TypeError, ValueError):
            return None, None, {**info, 'status': 'invalid', 'fields': {'limit': 'The page size and start must be whole numbers.'}}
        return limit, offset, None

    @api.model
    def _dss_one_of(self, payload, name, values, info, default=None):
        value = payload.get(name, default)
        if value is not None and value not in values:
            return None, {**info, 'status': 'invalid', 'fields': {name: 'Choose one of: ' + ', '.join(values) + '.'}}
        return value, None

    @api.model
    def _dss_select(self, payload, info):
        """(run, early reply): the run asked for (run_id) or the latest finished run of `kind` (real by default)."""
        Run = self._dss_models()['run']
        run_id, kind = payload.get('run_id'), payload.get('kind')
        if run_id is not None and kind is not None:
            return None, {**info, 'status': 'invalid', 'fields': {'run': 'Give run or kind, not both.'}}
        if run_id is not None:
            if not isinstance(run_id, int) or isinstance(run_id, bool):
                return None, {**info, 'status': 'invalid', 'fields': {'run': 'Send an id.'}}
            run = Run.search([('id', '=', run_id), ('company_id', '=', self.env.company.id)])
            if not run:
                return None, {**info, 'status': 'no_run', 'message': f'No DSS run "{run_id}"'}
        else:
            kind, early = self._dss_one_of(payload, 'kind', KINDS, info)
            if early:
                return None, early
            run = Run._latest_done(simulated=(kind == 'simulated'))
            if not run:
                return None, {**info, 'status': 'no_run', 'message': NO_RUN}
        if run.state == 'failed':
            return None, {**info, 'status': 'run_failed', 'message': 'This run failed: ' + (run.error or '')[:300]}
        if run.state != 'done':
            return None, {**info, 'status': 'no_run', 'message': NO_RUN}
        return run, None

    @api.model
    def _dss_now(self):
        """The clock for a run's age and for a running attempt (the session checks keep their own, _api_now)."""
        return self._api_now()

    @api.model
    def _dss_ref(self, run):
        """The envelope every data answer carries."""
        age = None
        if run.finished_at:
            age = int((self._dss_now() - run.finished_at).total_seconds() // 86400)
        stale = age is not None and age > STALE_DAYS
        notice = ([NOTICE] if run.simulated else []) + ([f'This run is {age} days old; the figures may be out of date.'] if stale else [])
        return {'id': run.id, 'kind': 'simulated' if run.simulated else 'real', 'simulated': bool(run.simulated), 'notice': ' '.join(notice) or None,
                'as_of': _d(run.as_of), 'engine_version': run.engine_version or None, 'closed_rule': run.closed_rule or None,
                'closed_rule_text': run.closed_rule_text or None, 'trigger': run.trigger, 'finished_at': _dt(run.finished_at), 'age_days': age,
                'stale': stale}

    @api.model
    def _dss_summary(self, run):
        M = self._dss_models()
        alerts = M['alert'].search([('run_id', '=', run.id)])
        return {**self._dss_ref(run), 'state': run.state, 'started_at': _dt(run.started_at), 'duration_s': run.duration_s,
                'requested_by_name': run.requested_by_name or None,
                'headline': {'order_now': M['restock'].search_count([('run_id', '=', run.id), ('order_now', '=', True)]),
                             'alerts_critical': len(alerts.filtered(lambda a: a.severity == 'critical')),
                             'alerts_warning': len(alerts.filtered(lambda a: a.severity == 'warning')),
                             'forecast_status': _part(run, 'forecast').get('status'), 'segments_status': _part(run, 'segments').get('status'),
                             'trend': (((run.summary or {}).get('health') or {}).get('trend') or {}).get('label')}}

    # ------------------------------------------------------------------------------------------------------------ requests (Run now)
    @api.model
    def _dss_marker(self):
        """(slot, started) of the attempt marker, or (None, None)."""
        self.env.cr.execute('SELECT value FROM ir_config_parameter WHERE key = %s', [ATTEMPT_KEY])
        row = self.env.cr.fetchone()
        if not row or '|' not in (row[0] or ''):
            return None, None
        slot, started = row[0].split('|', 1)
        try:
            return slot, fields.Datetime.to_datetime(started[:19])
        except ValueError:
            return slot, None

    @api.model
    def _dss_running_slot(self):
        """The slot of an attempt that is running now: a marker younger than FRESH_ATTEMPT whose slot no run has finished yet."""
        slot, started = self._dss_marker()
        if not slot or not started or self._dss_now() - started > FRESH_ATTEMPT:
            return None
        if self._dss_models()['run'].search_count([('trigger_ref', '=', slot)]):
            return None
        return slot

    @api.model
    def _dss_pending_triggers(self):
        cron = self.env.ref(RUN_NOW_CRON)
        return self.env['ir.cron.trigger'].sudo().search([('cron_id', '=', cron.id)], order='call_at, id')

    @api.model
    def _dss_request(self, request_id):
        """The state of one Run now request (its id is the cron trigger's): queued, running, done, failed or unknown."""
        slot = f'manual:{request_id}'
        run = self._dss_models()['run'].search([('trigger_ref', '=', slot)], order='id desc', limit=1)
        if run:
            failed = run.state == 'failed'
            return {'request_id': request_id, 'state': run.state if run.state in ('done', 'failed') else 'running', 'run_id': run.id,
                    'detail': ('This run failed: ' + (run.error or '')[:300]) if failed else None}
        if request_id in self._dss_pending_triggers().ids:
            running = self._dss_running_slot() == slot
            return {'request_id': request_id, 'state': 'running' if running else 'queued', 'run_id': None, 'detail': None}
        return {'request_id': request_id, 'state': 'unknown', 'run_id': None, 'detail': UNKNOWN_REQUEST}

    @api.model
    def _dss_queue(self):
        """What is in progress now, for the overview: the oldest pending request, or a weekly run that is running, or None."""
        pending = self._dss_pending_triggers()
        if pending:
            return self._dss_request(pending[0].id)
        slot = self._dss_running_slot()
        if slot:
            return {'request_id': None, 'state': 'running', 'run_id': None, 'detail': 'The weekly DSS run is running.'}
        return None

    # ------------------------------------------------------------------------------------------------------------ overview and runs
    @api.model
    def admin_dss_overview(self, payload):
        """payload: sid_hash. ok: real and simulated (the latest finished run of each, or null, as two labelled blocks), queue."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        Run = self._dss_models()['run']
        real, simulated = Run._latest_done(), Run._latest_done(simulated=True)
        return {**info, 'status': 'ok', 'real': self._dss_summary(real) if real else None,
                'simulated': self._dss_summary(simulated) if simulated else None, 'queue': self._dss_queue()}

    @api.model
    def admin_dss_runs(self, payload):
        """payload: sid_hash, kind (real default, simulated, all), state (done, failed, all; default all), limit, offset. Newest first."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        kind, early = self._dss_one_of(payload, 'kind', KINDS + ('all',), info, 'real')
        state, early2 = self._dss_one_of(payload, 'state', ('done', 'failed', 'all'), info, 'all')
        limit, offset, early3 = self._dss_page(payload, info)
        if early or early2 or early3:
            return early or early2 or early3
        domain = [('company_id', '=', self.env.company.id), ('state', 'in', ('done', 'failed') if state == 'all' else (state,))]
        if kind != 'all':
            domain.append(('simulated', '=', kind == 'simulated'))
        Run = self._dss_models()['run']
        runs = Run.search(domain, order='finished_at desc, id desc', limit=limit, offset=offset)
        return {**info, 'status': 'ok', 'runs': [self._dss_summary(r) for r in runs], 'total': Run.search_count(domain), 'limit': limit, 'offset': offset}

    @api.model
    def admin_dss_run(self, payload):
        """payload: sid_hash, run_id (path). ok: the run in detail (also a failed one, with its error). not_found."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        run = self._dss_models()['run'].search([('id', '=', payload.get('run_id') or 0), ('company_id', '=', self.env.company.id),
                                               ('state', 'in', ('done', 'failed'))])
        if not run:
            return {**info, 'status': 'not_found'}
        sel = run.selection or {}
        return {**info, 'status': 'ok', 'run': {
            **self._dss_summary(run),
            'part_status': {part: {'code': v.get('status'), 'message': v.get('message')} for part, v in (run.status or {}).items() if isinstance(v, dict)},
            'selection': {'chosen': sel.get('chosen'), 'best_baseline': sel.get('best_baseline'), 'model_beats_baseline': sel.get('model_beats_baseline'),
                          'wape': sel.get('wape') or {}} if sel else None,
            'row_counts': run.row_counts or {}, 'libraries': run.libraries or {}, 'input_fingerprint': run.input_fingerprint or None,
            'output_hash': run.output_hash or None, 'forecast_notes': (run.summary or {}).get('forecast_notes') or [],
            'error': (run.error or '')[:300] if run.state == 'failed' else None}}

    # ------------------------------------------------------------------------------------------------------------ forecast
    @api.model
    def admin_dss_forecast_keys(self, payload):
        """payload: sid_hash, run_id or kind, level. ok: run, level, keys [{level, key, label}] (by label)."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        level, early = self._dss_one_of(payload, 'level', LEVELS, info, 'product')
        run, early2 = (None, None) if early else self._dss_select(payload, info)
        if early or early2:
            return early or early2
        rows = self._dss_models()['forecast'].search([('run_id', '=', run.id), ('level', '=', level)])
        keys = sorted({(r.key, r.key_label or r.key) for r in rows}, key=lambda kl: (kl[1], kl[0]))
        return {**info, 'status': 'ok', 'run': self._dss_ref(run), 'level': level, 'keys': [{'level': level, 'key': k, 'label': lbl} for k, lbl in keys]}

    @api.model
    def _dss_type_map(self, run):
        """({template key: garment type code}, None) when the product-to-type mapping of this run is reliable, else (None, why). Reliable:
        every product of the run's restock rows names exactly one garment type, every product with actuals is mapped, and the run's own
        garment-type forecast equals the sum of its mapped products' forecasts in every week (the engine sums bottom-up)."""
        M = self._dss_models()
        mapping = {}
        for r in M['restock'].search([('run_id', '=', run.id)]):
            key = str(r.template_key)
            if not r.garment_type:
                return None, f'Product {key} has no garment type in this run.'
            if mapping.setdefault(key, r.garment_type) != r.garment_type:
                return None, f'Product {key} is listed under two garment types in this run.'
        products = set(M['actual'].search([('run_id', '=', run.id), ('level', '=', 'product')]).mapped('key'))
        missing = products - set(mapping)
        if missing:
            return None, f'{len(missing)} products with sales have no garment type in this run.'
        fc = M['forecast'].search([('run_id', '=', run.id), ('level', 'in', ('product', 'garment_type'))])
        prod = {}
        for r in fc.filtered(lambda f: f.level == 'product'):
            prod.setdefault((mapping.get(r.key), r.week_start), 0.0)
            prod[(mapping.get(r.key), r.week_start)] += r.yhat
        for r in fc.filtered(lambda f: f.level == 'garment_type'):
            if abs(prod.get((r.key, r.week_start), 0.0) - r.yhat) > 0.01:
                return None, f'The garment type {r.key} forecast does not equal the sum of its products ({r.week_start}).'
        return mapping, None

    @api.model
    def admin_dss_forecast(self, payload):
        """payload: sid_hash, run_id or kind, level, key ('total' for the total). ok: run, level, key, data_status, rows (the weekly forecast),
        history (the weekly actuals: product and total from the run's actuals, a garment type as the sum of its products when the mapping is
        reliable, else null with history_status saying why), history_status."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        level, early = self._dss_one_of(payload, 'level', LEVELS, info, 'total')
        key = payload.get('key') or ('total' if level == 'total' else None)
        if not early and (not isinstance(key, str) or not key or len(key) > 100):
            early = {**info, 'status': 'invalid', 'fields': {'key': 'Choose a key (see forecast/keys).'}}
        run, early2 = (None, None) if early else self._dss_select(payload, info)
        if early or early2:
            return early or early2
        M = self._dss_models()
        part = _part(run, 'forecast')
        data_status = None if part.get('status') == 'ok' else {'code': part.get('status') or 'not_enough_history',
                                                                'message': part.get('message') or HISTORY_GENERIC}
        rows = M['forecast'].search([('run_id', '=', run.id), ('level', '=', level), ('key', '=', key)], order='week_start, id')
        if not rows and data_status is None:
            return {**info, 'status': 'invalid', 'fields': {'key': 'No forecast for this key in this run.'}}
        history, history_status = self._dss_history(run, level, key, part)
        return {**info, 'status': 'ok', 'run': self._dss_ref(run), 'level': level, 'key': key, 'data_status': data_status,
                'rows': [{'week_start': _d(r.week_start), 'h': r.h, 'yhat': r.yhat, 'lo80': r.lo80 if r.has_interval else None,
                          'hi80': r.hi80 if r.has_interval else None, 'lo95': r.lo95 if r.has_interval else None,
                          'hi95': r.hi95 if r.has_interval else None, 'method': r.method or None, 'flags': _flags(r.flags), 'censored': r.censored}
                         for r in rows],
                'history': history, 'history_status': history_status}

    @api.model
    def _dss_history(self, run, level, key, part):
        A = self._dss_models()['actual']
        if not A.search_count([('run_id', '=', run.id)]):
            return [], {'code': 'not_enough_history', 'message': part.get('message') or HISTORY_GENERIC}
        if level in ('product', 'total'):
            rows = A.search([('run_id', '=', run.id), ('level', '=', level), ('key', '=', key)], order='week_start, id')
            return [{'week_start': _d(r.week_start), 'units': r.units, 'censored': r.censored} for r in rows], None
        mapping, why = self._dss_type_map(run)
        if mapping is None:
            return None, {'code': 'history_unavailable', 'message': why}
        weeks = {}
        for r in A.search([('run_id', '=', run.id), ('level', '=', 'product'), ('key', 'in', [k for k, t in mapping.items() if t == key])]):
            units, censored = weeks.get(r.week_start, (0.0, False))
            weeks[r.week_start] = (units + r.units, censored or r.censored)     # a type's week is censored when any of its products is
        return [{'week_start': _d(w), 'units': round(u, 6), 'censored': c} for w, (u, c) in sorted(weeks.items())], None

    # ------------------------------------------------------------------------------------------------------------ the tables
    @api.model
    def admin_dss_backtest(self, payload):
        """payload: sid_hash, run_id or kind, level, key, policy, horizon, weeks, chosen, limit, offset. Sorted level, key, policy, horizon,
        weeks, id."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        checks = [self._dss_one_of(payload, 'level', LEVELS, info), self._dss_one_of(payload, 'policy', POLICIES, info),
                  self._dss_one_of(payload, 'horizon', HORIZONS, info), self._dss_one_of(payload, 'weeks', ('all', 'uncensored'), info)]
        early = next((e for _v, e in checks if e), None)
        limit, offset, early2 = self._dss_page(payload, info)
        run, early3 = (None, None) if (early or early2) else self._dss_select(payload, info)
        if early or early2 or early3:
            return early or early2 or early3
        domain = [('run_id', '=', run.id)]
        for name in ('level', 'policy', 'horizon', 'weeks'):
            if payload.get(name) is not None:
                domain.append((name, '=', payload[name]))
        if isinstance(payload.get('key'), str) and payload['key']:
            domain.append(('key', '=', payload['key'][:100]))
        if isinstance(payload.get('chosen'), bool):
            domain.append(('chosen', '=', payload['chosen']))
        B = self._dss_models()['backtest']
        rows = B.search(domain, order='level, key, policy, horizon, weeks, id', limit=limit, offset=offset)
        return {**info, 'status': 'ok', 'run': self._dss_ref(run), 'total': B.search_count(domain), 'limit': limit, 'offset': offset,
                'rows': [{'level': r.level, 'key': r.key, 'policy': r.policy, 'horizon': r.horizon, 'weeks': r.weeks, 'n': r.n,
                          'n_with_interval': r.n_int, 'mae': r.mae if r.n else None, 'wape': r.wape if r.has_metrics else None,
                          'bias': r.bias if r.has_metrics else None, 'cov80': r.cov80 if r.has_coverage else None,
                          'cov95': r.cov95 if r.has_coverage else None, 'chosen': r.chosen} for r in rows]}

    @staticmethod
    def _dss_urgency(r):
        if r.status == 'no_forecast':
            return 'no_forecast'
        if r.stockout_before_arrival:
            return 'stockout_before_arrival'
        if r.order_now:
            return 'order_now'
        if r.status == 'plan':
            return 'plan'
        return 'ok'

    @api.model
    def admin_dss_restock(self, payload):
        """payload: sid_hash, run_id or kind, urgency (one of URGENCY or all), garment_type, supplier_id, q (SKU), limit, offset. Sorted by
        urgency, then run-out date (none last), SKU, id. counts: rows per urgency (before the urgency filter)."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        urgency, early = self._dss_one_of(payload, 'urgency', URGENCY + ('all',), info, 'all')
        limit, offset, early2 = self._dss_page(payload, info)
        run, early3 = (None, None) if (early or early2) else self._dss_select(payload, info)
        if early or early2 or early3:
            return early or early2 or early3
        domain = [('run_id', '=', run.id)]
        if isinstance(payload.get('garment_type'), str) and payload['garment_type']:
            domain.append(('garment_type', '=', payload['garment_type'][:100]))
        if isinstance(payload.get('supplier_id'), int) and not isinstance(payload['supplier_id'], bool):
            domain.append(('supplier_key', '=', payload['supplier_id']))
        if isinstance(payload.get('q'), str) and payload['q'].strip():
            domain.append(('sku', 'ilike', payload['q'].strip()[:100]))
        rows = [(self._dss_urgency(r), r) for r in self._dss_models()['restock'].search(domain)]
        counts = {u: sum(1 for x, _r in rows if x == u) for u in URGENCY}
        rank = {u: i for i, u in enumerate(URGENCY)}
        rows = sorted((x for x in rows if urgency == 'all' or x[0] == urgency),
                      key=lambda x: (rank[x[0]], x[1].runout_date is False, x[1].runout_date or datetime.date.max, x[1].sku or '', x[1].id))
        page = rows[offset:offset + limit]
        return {**info, 'status': 'ok', 'run': self._dss_ref(run), 'total': len(rows), 'limit': limit, 'offset': offset, 'counts': counts,
                'rows': [self._dss_restock_row(u, r) for u, r in page]}

    @staticmethod
    def _dss_restock_row(urgency, r):
        planned = urgency != 'no_forecast'
        supplier = bool(r.supplier_key)

        def when(value):
            return value if planned else None
        return {'product_id': r.product_key, 'product_template_id': r.template_key, 'sku': r.sku or None, 'product': r.product or None,
                'garment_type': r.garment_type or None, 'size': r.size or None, 'color': r.color or None, 'on_hand': r.on_hand, 'reserved': r.reserved,
                'free': r.free, 'incoming': r.incoming, 'daily_demand': when(r.daily_demand), 'weekly_demand': when(round(r.daily_demand * 7, 4)),
                'days_left': r.days_left if r.runout_date else None,
                'runout_date': _d(r.runout_date), 'runout_date_hi80': _d(r.runout_date_hi80), 'supplier_id': r.supplier_key if supplier else None,
                'supplier': r.supplier or None, 'unit_cost': r.unit_cost if supplier else None,
                'landed_unit_cost': r.landed_unit_cost if supplier else None, 'est_cost': r.est_cost if supplier else None,
                'lead_p50': when(r.lead_p50), 'lead_p90': when(r.lead_p90), 'lead_source': r.lead_source or None, 'lead_days': when(r.lead_days),
                'safety_stock': when(r.safety_stock), 'reorder_point': when(r.reorder_point), 'order_up_to': when(r.order_up_to),
                'suggested_qty': when(r.suggested_qty), 'order_by': _d(r.order_by), 'order_now': r.order_now,
                'stockout_before_arrival': r.stockout_before_arrival, 'arrives_before_runout': r.arrives_before_runout if planned else None,
                'coverage_risk': r.coverage_risk, 'capped': r.capped, 'urgency': urgency,
                'alternatives': [{'supplier_id': a.get('supplier_id'), 'supplier': a.get('supplier'), 'landed_unit_cost': a.get('landed_unit_cost'),
                                  'lead_p90': a.get('lead_p90'), 'coverage_risk': a.get('coverage_risk'),
                                  'arrives_before_runout': a.get('arrives_before_runout'), 'ineligible': a.get('ineligible') or []}
                                 for a in (r.alternatives or []) if isinstance(a, dict)],
                'flags': _flags(r.flags)}

    @api.model
    def admin_dss_segments(self, payload):
        """payload: sid_hash, run_id or kind, segment, sort (monetary default, recency, frequency), limit, offset. ok: run, data_status, summary,
        rows. A simulated run's row has only the pseudonymous customer_key (customer null); a real run's row adds customer {customer_id (the
        customer's shop account, for the Customers page), partner_id, display_name (read now)} and never an email, phone or address."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        segment, early = self._dss_one_of(payload, 'segment', SEGMENTS, info)
        sort, early2 = self._dss_one_of(payload, 'sort', tuple(SEGMENT_SORTS), info, 'monetary')
        limit, offset, early3 = self._dss_page(payload, info)
        run, early4 = (None, None) if (early or early2 or early3) else self._dss_select(payload, info)
        if early or early2 or early3 or early4:
            return early or early2 or early3 or early4
        part = _part(run, 'segments')
        data_status = None if part.get('status') == 'ok' else {'code': part.get('status') or 'not_enough_customers',
                                                                'message': part.get('message') or 'Not enough customers with Closed orders yet.'}
        domain = [('run_id', '=', run.id)] + ([('segment', '=', segment)] if segment else [])
        S = self._dss_models()['segment']
        rows = S.search(domain, order=SEGMENT_SORTS[sort], limit=limit, offset=offset)
        people = self._dss_customers(rows) if not run.simulated else {}
        return {**info, 'status': 'ok', 'run': self._dss_ref(run), 'data_status': data_status, 'total': S.search_count(domain), 'limit': limit,
                'offset': offset, 'summary': (run.summary or {}).get('segment_summary') or [],
                'rows': [{'customer_key': r.customer_key, 'recency_days': r.recency_days, 'frequency': r.frequency, 'monetary': r.monetary,
                          'r_score': r.r_score, 'f_score': r.f_score, 'm_score': r.m_score, 'segment': r.segment, 'segment_name': r.segment_name,
                          'customer': None if run.simulated else people.get(r.id)} for r in rows]}

    @api.model
    def _dss_customers(self, rows):
        """{segment row id: {customer_id, partner_id, display_name}} for a REAL run: the name is read now; the customer id is the partner's
        shop account (a portal user), or None. Nothing else about the person is read."""
        ids = [r.partner_key for r in rows if r.partner_key]
        partners = {p.id: p for p in self.env['res.partner'].sudo().with_context(active_test=False).browse(ids).exists()}
        users = {}
        for u in self.env['res.users'].sudo().with_context(active_test=False).search([('partner_id', 'in', list(partners)), ('share', '=', True)],
                                                                                    order='active desc, id'):
            users.setdefault(u.partner_id.id, u.id)
        return {r.id: {'customer_id': users.get(r.partner_key), 'partner_id': r.partner_key or None,
                       'display_name': partners[r.partner_key].name if r.partner_key in partners else None} for r in rows}

    @api.model
    def admin_dss_alerts(self, payload):
        """payload: sid_hash, run_id, kind (an alert kind), severity, limit, offset. Alerts have no state. Sorted critical, warning, info, then
        the oldest first, then id. counts: per severity (after the kind filter, before the severity filter). The run is the given one or the
        latest real run (`kind` here is the alert's kind)."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        kind, early = self._dss_one_of(payload, 'kind', ALERT_KINDS, info)
        severity, early2 = self._dss_one_of(payload, 'severity', SEVERITY, info)
        limit, offset, early3 = self._dss_page(payload, info)
        run, early4 = (None, None) if (early or early2 or early3) else self._dss_select({'run_id': payload.get('run_id')} if payload.get('run_id') is not None else {}, info)
        if early or early2 or early3 or early4:
            return early or early2 or early3 or early4
        rows = self._dss_models()['alert'].search([('run_id', '=', run.id)] + ([('kind', '=', kind)] if kind else []))
        counts = {s: len(rows.filtered(lambda a, s=s: a.severity == s)) for s in SEVERITY}
        rank = {s: i for i, s in enumerate(SEVERITY)}
        rows = sorted((a for a in rows if not severity or a.severity == severity),
                      key=lambda a: (rank.get(a.severity, 9), -(a.age_days if a.has_age else -1), a.id))
        return {**info, 'status': 'ok', 'run': self._dss_ref(run), 'total': len(rows), 'limit': limit, 'offset': offset, 'counts': counts,
                'rows': [{'kind': a.kind, 'band': a.band, 'severity': a.severity, 'subject_type': a.subject_type, 'subject_id': a.subject_key or None,
                          'subject_label': a.subject_label or None, 'age_days': a.age_days if a.has_age else None, 'message': a.message or None}
                         for a in rows[offset:offset + limit]]}

    @api.model
    def admin_dss_health(self, payload):
        """payload: sid_hash, run_id or kind. ok: run, months, trend, kpis, projection."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        run, early = self._dss_select(payload, info)
        if early:
            return early
        health = (run.summary or {}).get('health') or {}
        months = self._dss_models()['health'].search([('run_id', '=', run.id)], order='month, id')
        trend = health.get('trend')
        if trend:       # the engine's slope is a fraction of the mean (0.1109); the same figure in percent is what a screen shows (B8 S4d)
            trend = {**trend, 'revenue_rel_slope_pct': None if trend.get('revenue_rel_slope') is None else round(trend['revenue_rel_slope'] * 100, 4),
                     'threshold_pct': None if trend.get('threshold') is None else round(trend['threshold'] * 100, 4)}
        return {**info, 'status': 'ok', 'run': self._dss_ref(run), 'trend': trend, 'kpis': health.get('kpis'),
                'projection': health.get('projection'),
                'months': [{'month': m.month, 'month_start': _d(m.month_start), 'complete': m.complete, 'revenue': m.revenue, 'closed_orders': m.closed_orders,
                            'spending': m.spending, 'cogs': m.cogs, 'closed_units': m.closed_units, 'units_without_cost': m.units_without_cost,
                            'net_cash': m.net_cash, 'net_margin': m.net_margin, 'revenue_ma3': m.revenue_ma3 if m.has_ma3 else None,
                            'net_cash_ma3': m.net_cash_ma3 if m.has_ma3 else None, 'net_margin_ma3': m.net_margin_ma3 if m.has_ma3 else None,
                            'flags': _flags(m.flags)} for m in months]}

    # ------------------------------------------------------------------------------------------------------------ Run now
    @api.model
    def admin_dss_run_now(self, payload):
        """payload: sid_hash. ok: request_id (the cron trigger's id) and state queued; run_in_progress when a request is pending or an attempt
        is running (a pending run-now trigger, or a fresh attempt marker that no run has finished). The run itself happens in the cron."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        # Check and create must not interleave. A transaction-scoped lock (released at commit) makes a second press wait for the first; the
        # pending check then reads on a fresh cursor, because this transaction's own snapshot (repeatable read) predates the first press's commit.
        self.env.cr.execute("SELECT pg_advisory_xact_lock(hashtext('clothcraft_dss.run_now'))")
        cron_id = self.env.ref(RUN_NOW_CRON).id
        self.env['ir.cron.trigger'].flush_model()
        with self.pool.cursor() as fresh:
            fresh.execute('SELECT count(*) FROM ir_cron_trigger WHERE cron_id = %s', (cron_id,))
            pending_now = fresh.fetchone()[0]
        if pending_now or self._dss_pending_triggers() or self._dss_running_slot():       # either view: ours (sees our own writes) or the fresh one (sees later commits)
            return {**info, 'status': 'run_in_progress', 'message': IN_PROGRESS}
        trigger =self.env.ref(RUN_NOW_CRON).with_user(staff['user']).sudo()._trigger()
        return {**info, 'status': 'ok', 'request_id': trigger[:1].id, 'state': 'queued'}

    @api.model
    def admin_dss_run_request(self, payload):
        """payload: sid_hash, request_id (path). ok: request_id, state (queued, running, done, failed, unknown), run_id, detail."""
        info, _staff, early = self._api_admin_start(payload)
        if early:
            return early
        request_id = payload.get('request_id')
        if not isinstance(request_id, int) or isinstance(request_id, bool):
            return {**info, 'status': 'not_found'}
        return {**info, 'status': 'ok', **self._dss_request(request_id)}
