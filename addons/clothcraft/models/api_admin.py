"""The admin dashboard's READ side (step 7b): one summary for /admin, every figure worked out here and nothing worked out in the browser.

Rules this file keeps:
- It only READS business data. The one write is the session's own `last_seen` touch that every staff call makes (at most once a minute).
- The admin session is checked HERE, in Odoo, on every call (`_api_staff(..., scope='admin')`): a live admin-scope session of a person who holds
  the Administrator group NOW. The cookie alone proves nothing. An employee never holds such a session.
- Money: orders carry their VAT-inclusive `amount_total`; each order is split with the one helper, `money.vat_split`, and the parts are summed
  with 2-decimal rounding, so VAT + net = total exactly. EARNED revenue is CLOSED orders only (the customer confirmed, or the shop closed the order
  by itself), counted in the Manila month the order CLOSED. A delivered order still waiting for that is reported on its own ("Delivered, awaiting
  confirmation"), by the month it was delivered, and is never added to earnings. The opening balance of a supplier is a starting investment: it
  is reported on its own line and is never added into any month or any period.
- Time: Manila (UTC+8, no daylight saving). A month is a Manila month; a range is whole Manila days; the database holds UTC.
"""
import datetime

from odoo import api, fields, models
from odoo.tools.float_utils import float_round

from ..money import vat_split
from .supplier import today_manila

RANGES = ('this_month', 'last_3_months', 'last_12_months', 'all')
BACK_MONTHS = {'this_month': 0, 'last_3_months': 2, 'last_12_months': 11}
STATE_ORDER = ('awaiting_payment', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'closed', 'cancelled')
STATE_LABEL = {
    'awaiting_payment': 'Awaiting payment', 'confirmed': 'Received or paid', 'packed': 'Packed', 'shipped': 'Shipped',
    'out_for_delivery': 'On delivery', 'delivered': 'Delivered', 'closed': 'Closed', 'cancelled': 'Cancelled',
}
ALERT_ROWS = 8
QUEUE_ROWS = 5
TOP_TYPES = 5
UTC_OFFSET = datetime.timedelta(hours=8)  # Manila


def _manila_midnight_utc(day):
    """The UTC moment (naive, as Odoo stores it) at which this Manila calendar day begins."""
    return datetime.datetime.combine(day, datetime.time.min) - UTC_OFFSET


def _month_of(moment):
    """'YYYY-MM' of a UTC (naive) moment, in Manila time: 23:30 Manila on the last day of a month is still that month."""
    return (moment + UTC_OFFSET).strftime('%Y-%m')


def _rounded(values):
    return float_round(sum(values), precision_digits=2)


def _split_sum(totals):
    """{total, vat, net} for a list of VAT-inclusive amounts: each split on its own, then added part by part."""
    vats, nets = zip(*(vat_split(amount) for amount in totals)) if totals else ((), ())
    return {'total': _rounded(totals), 'vat': _rounded(vats), 'net': _rounded(nets)}


class ClothcraftApiAdmin(models.AbstractModel):
    _inherit = 'clothcraft.api'

    @api.model
    def _api_admin_start(self, payload):
        """(info, staff, early reply): the Administrator's own session, re-read now. Anything else is `unauthorised`."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        staff = self._api_staff(payload.get('sid_hash'), scope='admin')
        if not staff:
            return info, None, {**info, 'status': 'unauthorised'}
        info['session_remaining'] = staff['remaining']
        return info, staff, None

    @api.model
    def _api_admin_range(self, key):
        """(first Manila day or None for all time, today): whole months, the current one included."""
        today = today_manila()
        if key == 'all':
            return None, today
        index = today.year * 12 + today.month - 1 - BACK_MONTHS[key]
        return datetime.date(index // 12, index % 12 + 1, 1), today

    @api.model
    def admin_dashboard(self, payload):
        """payload: sid_hash, range (this_month, last_3_months, last_12_months or all). status ok with the whole summary, unauthorised, invalid.
        Read-only; see the module docstring for the money and time rules."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        key = payload.get('range') or 'last_12_months'
        if key not in RANGES:
            return {**info, 'status': 'invalid', 'fields': {'range': 'Choose one of: ' + ', '.join(RANGES) + '.'}}
        start, today = self._api_admin_range(key)
        lower = _manila_midnight_utc(start) if start else None
        upper = _manila_midnight_utc(today + datetime.timedelta(days=1))  # exclusive

        def in_range(moment):
            return (lower is None or moment >= lower) and moment < upper

        Order = self.env['sale.order'].sudo()
        company = [('company_id', '=', self.env.company.id)]

        # ---- revenue. Earned = closed orders, in the month they CLOSED (their latest "closed" history line; an order with none, such as a simulated
        # one migrated to closed, falls back to its latest "delivered" line, then to the day it was placed). Delivered, awaiting confirmation =
        # delivered orders, in the month they were delivered (same fallback): shown beside earnings, never part of them.
        Audit = self.env['clothcraft.order.audit'].sudo()
        orders = Order.search(company + [('clothcraft_state', 'in', ('closed', 'delivered')), ('state', 'in', ('sale', 'done'))])
        latest = {'closed': {}, 'delivered': {}}
        for audit in Audit.search([('order_id', 'in', orders.ids), ('to_state', 'in', ('closed', 'delivered'))], order='id'):
            latest[audit.to_state][audit.order_id.id] = audit.create_date  # the latest line wins (an order may be stepped back and on again)

        def moment_of(order):
            kind = 'closed' if order.clothcraft_state == 'closed' else 'delivered'
            return latest[kind].get(order.id) or latest['delivered'].get(order.id) or order.date_order

        dated = [(order, moment_of(order)) for order in orders]
        dated = [(order, moment) for order, moment in dated if moment and in_range(moment)]
        revenue_orders = [(o, m) for o, m in dated if o.clothcraft_state == 'closed']
        pending_orders = [(o, m) for o, m in dated if o.clothcraft_state == 'delivered']

        by_month, pending_by_month = {}, {}
        for order, moment in revenue_orders:
            by_month.setdefault(_month_of(moment), []).append(order.amount_total)
        for order, moment in pending_orders:
            pending_by_month.setdefault(_month_of(moment), []).append(order.amount_total)
        first_day = start
        if first_day is None:
            placed = Order.search(company + [('clothcraft_state', '!=', False)], order='date_order asc', limit=1)
            moments = ([placed.date_order] if placed.date_order else []) + [moment for _, moment in dated]
            first_day = ((min(moments) + UTC_OFFSET).date() if moments else today).replace(day=1)
        months, index = [], first_day.year * 12 + first_day.month - 1
        while index <= today.year * 12 + today.month - 1:
            months.append(f'{index // 12:04d}-{index % 12 + 1:02d}')
            index += 1
        revenue_by_month = [{
            'month': m, **_split_sum(by_month.get(m, [])), 'orders': len(by_month.get(m, [])),
            'pending': {**_split_sum(pending_by_month.get(m, [])), 'orders': len(pending_by_month.get(m, []))}} for m in months]
        revenue = {**_split_sum([order.amount_total for order, _ in revenue_orders]), 'order_count': len(revenue_orders)}
        delivered_awaiting = {**_split_sum([order.amount_total for order, _ in pending_orders]), 'order_count': len(pending_orders)}

        # ---- orders placed in the range, by their state now
        domain = company + [('clothcraft_state', '!=', False), ('state', 'in', ('sale', 'done', 'cancel')), ('date_order', '<', upper)]
        if lower:
            domain.append(('date_order', '>=', lower))
        counts = {}
        for order in Order.search(domain):
            counts[order.clothcraft_state] = counts.get(order.clothcraft_state, 0) + 1
        orders_by_status = [{'state': s, 'label': STATE_LABEL[s], 'count': counts.get(s, 0)} for s in STATE_ORDER if counts.get(s) or s != 'packed']
        cancelled = counts.get('cancelled', 0)

        # ---- top garment types of the earned (closed) orders (customization fees and other lines without a garment type are not counted)
        types = {}
        for order, _ in revenue_orders:
            for line in order.order_line:
                garment = line.product_id.product_tmpl_id.garment_type_id
                if garment:
                    row = types.setdefault(garment.id, {'code': garment.code, 'name': garment.name, 'units': 0.0, 'revenue': []})
                    row['units'] += line.product_uom_qty
                    row['revenue'].append(line.price_total)
        top_types = sorted(
            ({'code': r['code'], 'name': r['name'], 'units': int(round(r['units'])), 'revenue': _rounded(r['revenue'])} for r in types.values()),
            key=lambda r: (-r['units'], r['name']))[:TOP_TYPES]

        # ---- low stock, now
        products = self.env['product.product'].sudo().search([('product_tmpl_id.garment_type_id', '!=', False)], order='default_code, id')
        rows = self._api_stock_rows(products)
        low = sorted((r for r in rows if r['low']), key=lambda r: (r['free'], r['sku'] or ''))
        stock_alerts = {
            'count': len(low), 'variants': [
                {'id': r['id'], 'sku': r['sku'], 'name': r['name'], 'on_hand': r['on_hand'], 'reserved': r['reserved'], 'free': r['free'],
                 'alert_at': r['effective_threshold']} for r in low[:ALERT_ROWS]]}

        # ---- restocks, now
        Restock = self.env['clothcraft.restock'].sudo()
        waiting = Restock.search([('state', '=', 'requested')], order='requested_at asc, id asc')
        queue = {
            'requested': len(waiting), 'approved': Restock.search_count([('state', '=', 'approved')]),
            'not_received': Restock.search_count([('state', '=', 'not_received')]),
            'oldest_waiting': [self._api_restock_summary(r) for r in waiting[:QUEUE_ROWS]]}

        # ---- supplier spend: received restocks in the range, with the opening balance on its own
        suppliers = self._api_supplier_model().search(company)
        received_domain = [('state', '=', 'received'), ('received_on', '<=', today)]
        if start:
            received_domain.append(('received_on', '>=', start))
        received = Restock.search(received_domain)
        per_supplier = {s.id: [r for r in received if r.supplier_id == s] for s in suppliers}
        supplier_spend = {
            'opening_balance': {'total': _rounded(suppliers.mapped('opening_balance')), 'vat': _rounded(suppliers.mapped('opening_balance_vat')),
                                'net': _rounded(suppliers.mapped('opening_balance_net'))},
            'received': {'total': _rounded(received.mapped('actual_cost')), 'vat': _rounded(received.mapped('actual_vat')),
                         'net': _rounded(received.mapped('actual_net')), 'count': len(received)},
            'suppliers': [
                {'id': s.id, 'name': s.name, 'active': s.active, 'opening_balance': s.opening_balance,
                 'received_total': _rounded([r.actual_cost for r in per_supplier[s.id]]), 'received_count': len(per_supplier[s.id])}
                for s in suppliers]}

        return {
            **info, 'status': 'ok',
            'range': {'key': key, 'from': fields.Date.to_string(first_day), 'to': fields.Date.to_string(today), 'timezone': 'Asia/Manila'},
            'generated_at': fields.Datetime.to_string(fields.Datetime.now()),
            'kpis': {
                'revenue': revenue, 'delivered_awaiting': delivered_awaiting,
                'orders': {'placed': sum(counts.values()) - cancelled, 'cancelled': cancelled},
                'low_stock': {'count': len(low), 'variants': len(rows)},
                'restocks_waiting': {'count': len(waiting), 'estimate_total': _rounded([r.estimate_total for r in waiting])}},
            'revenue_by_month': revenue_by_month, 'orders_by_status': orders_by_status, 'stock_alerts': stock_alerts,
            'restock_queue': queue, 'supplier_spend': supplier_spend, 'top_garment_types': top_types,
        }

    @api.model
    def admin_orders_summary(self, payload):
        """payload: sid_hash, range (this_month, last_3_months, last_12_months or all). status ok with COUNTS ONLY (no amounts), unauthorised, invalid.
        Read-only, and the live admin session is checked here on every call.

        - in_progress is "right now" and not limited by the range: awaiting payment (with the age in whole Manila days of the oldest, or none),
          received and preparing (the order state `confirmed` plus any legacy `packed`, as the board counts them), shipped, on delivery, and
          delivered_waiting: delivered orders the customer has not confirmed yet (state `delivered`), with the age in whole Manila days of the
          oldest SINCE ITS DELIVERY (the latest "delivered" history line, else the day it was placed), or none. That is the clock the automatic
          close runs on.
        - success is CLOSED orders only (the customer confirmed, or the shop closed it automatically some days after delivery) and failed is
          cancelled orders: both are orders PLACED in the range (Manila days), by their state now. A delivered order is not yet a success."""
        info, staff, early = self._api_admin_start(payload)
        if early:
            return early
        key = payload.get('range') or 'last_12_months'
        if key not in RANGES:
            return {**info, 'status': 'invalid', 'fields': {'range': 'Choose one of: ' + ', '.join(RANGES) + '.'}}
        start, today = self._api_admin_range(key)
        lower = _manila_midnight_utc(start) if start else None
        upper = _manila_midnight_utc(today + datetime.timedelta(days=1))  # exclusive
        Order = self.env['sale.order'].sudo()
        base = [('company_id', '=', self.env.company.id), ('state', 'in', ('sale', 'done', 'cancel'))]

        def count(states, in_range):
            domain = base + [('clothcraft_state', 'in', states)]
            if in_range:
                domain.append(('date_order', '<', upper))
                if lower:
                    domain.append(('date_order', '>=', lower))
            return Order.search_count(domain)

        waiting = Order.search(base + [('clothcraft_state', '=', 'awaiting_payment')], order='date_order asc, id asc', limit=1)
        oldest = max(0, (today - (waiting.date_order + UTC_OFFSET).date()).days) if waiting.date_order else None
        delivered_orders = Order.search(base + [('clothcraft_state', '=', 'delivered')])
        delivered_at = {}
        for audit in self.env['clothcraft.order.audit'].sudo().search([('order_id', 'in', delivered_orders.ids), ('to_state', '=', 'delivered')], order='id'):
            delivered_at[audit.order_id.id] = audit.create_date  # the latest delivered line wins (an order may be stepped back and delivered again)
        moments = [m for m in (delivered_at.get(o.id) or o.date_order for o in delivered_orders) if m]
        delivered_oldest = max(0, (today - (min(moments) + UTC_OFFSET).date()).days) if moments else None
        return {
            **info, 'status': 'ok',
            'range': {'key': key, 'from': fields.Date.to_string(start) if start else None, 'to': fields.Date.to_string(today), 'timezone': 'Asia/Manila'},
            'generated_at': fields.Datetime.to_string(fields.Datetime.now()),
            'in_progress': {
                'awaiting_payment': {'count': count(['awaiting_payment'], False), 'oldest_days': oldest},
                'received_preparing': {'count': count(['confirmed', 'packed'], False)},
                'shipped': {'count': count(['shipped'], False)},
                'on_delivery': {'count': count(['out_for_delivery'], False)},
                'delivered_waiting': {'count': len(delivered_orders), 'oldest_days': delivered_oldest},
            },
            'success': {'closed': count(['closed'], True)},
            'failed': {'cancelled': count(['cancelled'], True)},
        }
