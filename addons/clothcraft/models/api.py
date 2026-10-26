import base64
from collections import defaultdict

from odoo import Command, SUPERUSER_ID, api, models
from odoo.exceptions import UserError
from odoo.tools import html2plaintext, plaintext2html
from odoo.tools.mimetypes import guess_mimetype

from .design import REFUSALS, price_design

SIM_MARKER = 'clothcraft.sim.marker'


class ClothcraftApi(models.AbstractModel):
    """What the storefront API service (backend/) asks Odoo, in one call each.

    The service reaches Odoo only through /json/2 as a low-privilege user, so every method here runs with that
    user's rights. sudo is used for two read-only numbers the user has no table access for (the free stock of a variant,
    which reads stock moves, and the simulation marker) and, in place_order only, for the writes. Methods return plain data.
    """
    _name = 'clothcraft.api'
    _description = 'Storefront API'

    def _api_products(self, skus=None):
        """Garments the shop sells: a garment type, a shop group and a storefront id (an incomplete product stays off the shop),
        published, sellable, active."""
        domain = [
            ('product_tmpl_id.garment_type_id', '!=', False), ('product_tmpl_id.is_published', '=', True),
            ('product_tmpl_id.clothcraft_group', '!=', False), ('product_tmpl_id.clothcraft_slug', '!=', False),
            ('sale_ok', '=', True), ('active', '=', True),
        ]
        if skus is not None:
            domain.append(('default_code', 'in', list(skus)))
        return self.env['product.product'].search(domain, order='product_tmpl_id, id')

    @api.model
    def _api_free_qty(self, variant, warehouse):
        """Units free to sell, the number the stock guard checks (reservations taken off)."""
        return variant.sudo().with_context(warehouse_id=warehouse.id).free_qty

    @api.model
    def _api_warehouse(self):
        return self.env['stock.warehouse'].search([('company_id', '=', self.env.company.id)], limit=1)

    @api.model
    def _api_money(self):
        company = self.env.company
        tax = company.account_sale_tax_id
        return {
            'currency': company.currency_id.name,
            'vat_rate': tax.amount if tax else 0.0,
            'vat_included': bool(tax) and (tax.price_include_override == 'tax_included' or bool(tax.price_include)),
            'vat_rounding': company.tax_calculation_rounding_method,
        }

    @api.model
    def _api_simulation(self):
        """The simulation marker as stored by the seeder (a JSON text), or False for a real database."""
        return self.env['ir.config_parameter'].sudo().get_param(SIM_MARKER, False)

    @staticmethod
    def _api_attribute(variant, attribute_name):
        for value in variant.product_template_variant_value_ids:
            if value.attribute_id.name == attribute_name:
                return value.name
        return False

    @api.model
    def shop_info(self):
        """Currency, VAT and the simulation marker: what every response states, without loading the catalogue."""
        return {**self._api_money(), 'simulation': self._api_simulation()}

    @api.model
    def catalogue(self):
        """Every garment with its variants: the final variant price, the surcharge in it, and the free stock."""
        warehouse = self._api_warehouse()
        variants = self._api_products()
        by_template = defaultdict(list)
        for variant in variants:
            by_template[variant.product_tmpl_id].append({
                'sku': variant.default_code,
                'color': self._api_attribute(variant, 'Color'),
                'size': self._api_attribute(variant, 'Size'),
                'price': variant.lst_price,
                'price_extra': variant.price_extra,
                'free_qty': self._api_free_qty(variant, warehouse),
            })
        versions = self._api_image_versions(list(by_template))
        products = [{
            'id': template.id,
            'name': template.name,
            'slug': template.clothcraft_slug,
            'group': template.clothcraft_group,
            'featured': template.clothcraft_featured,
            'image_version': versions.get(template.id, ''),
            'list_price': template.list_price,
            'garment_type': {'code': template.garment_type_id.code, 'name': template.garment_type_id.name},
            'variants': rows,
        } for template, rows in by_template.items()]
        return {**self._api_money(), 'simulation': self._api_simulation(), 'products': products}

    @api.model
    def _api_image_versions(self, templates):
        """{template id: a short fingerprint of its image}: changes when the picture changes, so the shop's image address does too."""
        ids = [t.id for t in templates]
        if not ids:
            return {}
        rows = self.env['ir.attachment'].sudo().search_read(
            [('res_model', '=', 'product.template'), ('res_field', '=', 'image_1920'), ('res_id', 'in', ids)], ['res_id', 'checksum'])
        return {row['res_id']: (row['checksum'] or '')[:12] for row in rows}

    @api.model
    def product_image(self, slug):
        """A garment's own picture, as Odoo keeps it (resized to at most 1024 px): {status: ok, mimetype, data (base64), version}, or
        {status: not_found} for an unknown or unsold storefront id, or one with no picture."""
        variant = self._api_products().filtered(lambda v: v.product_tmpl_id.clothcraft_slug == slug)[:1]
        template = variant.product_tmpl_id
        if not template or not template.image_1920:
            return {'status': 'not_found'}
        data = template.image_1024
        raw = base64.b64decode(data)
        return {'status': 'ok', 'mimetype': guess_mimetype(raw, default='image/png'), 'data': data.decode() if isinstance(data, bytes) else data,
                'version': self._api_image_versions(template).get(template.id, '')}

    @api.model
    def quote(self, lines, sid_hash=None):
        """Price a cart the way Odoo prices an order, without writing anything.

        `lines` is [{'sku', 'quantity', 'design_id'?}]. Lines with the same SKU AND design are merged, first-seen order kept. Totals and
        VAT come from a virtual sale.order, so the company's tax rounding is applied by Odoo itself. A line with a design is the garment
        plus its print fee (step 9a); the design must be the signed-in customer's (sid_hash) and not removed, or the row says
        design_unavailable and is NOT priced (never as a plain garment). A design made for another garment: status invalid.
        """
        partner = self._api_customer(sid_hash)[0] if sid_hash else None
        return self._api_quote(lines, partner)

    @staticmethod
    def _api_merge(lines):
        merged = {}
        for line in lines:
            key = (line['sku'], int(line.get('design_id') or 0))
            merged[key] = merged.get(key, 0) + line['quantity']
        return merged

    @api.model
    def _api_designs_of(self, partner, ids):
        """{id: design} of the designs among ids that this customer may put in a cart: their own, not removed."""
        if not partner or not ids:
            return {}
        found = self.env['clothcraft.design'].sudo().search([('id', 'in', list(ids)), ('partner_id', '=', partner.id), ('state', '!=', 'void')])
        return {d.id: d for d in found}

    @api.model
    def _api_line_commands(self, entries, pricing):
        """sale.order.line values for priced entries [(sku, design, quantity, variant)]: the garment and, after a designed one, its fee."""
        fee_product = self.env['sale.order.line']._clothcraft_fee_product()
        values = []
        for index, (_sku, design, quantity, variant) in enumerate(entries):
            sequence = 10 * (index + 1)
            values.append({'product_id': variant.id, 'product_uom_qty': quantity, 'sequence': sequence, 'clothcraft_design_id': design.id if design else False})
            if design:
                fee = price_design(design, self._api_attribute(variant, 'Size'), pricing)
                values.append({
                    'product_id': fee_product.id, 'product_uom_qty': quantity, 'sequence': sequence + 1,
                    'name': self.env._("Print fee: %(garment)s, design %(design)s", garment=variant.display_name, design=design.id),
                    'price_unit': fee['fee'], 'technical_price_unit': 0.0,   # differ on purpose: Odoo keeps a price it sees as set by hand
                    'clothcraft_print_sq_in': fee['covered_sq_in'], 'clothcraft_print_rate': fee['rate'],
                    'clothcraft_print_size_step': fee['size_step'], 'clothcraft_print_steps': fee['steps'],
                })
        return values

    @staticmethod
    def _api_print_fee(fee_line):
        return {'covered_sq_in': fee_line.clothcraft_print_sq_in, 'rate': fee_line.clothcraft_print_rate, 'size_step': fee_line.clothcraft_print_size_step,
                'steps': fee_line.clothcraft_print_steps, 'unit': fee_line.price_unit, 'total': fee_line.price_total}

    @api.model
    def _api_quote(self, lines, partner):
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        merged = self._api_merge(lines)
        warehouse = self._api_warehouse()
        variants = {v.default_code: v for v in self._api_products({sku for sku, _d in merged})}
        designs = self._api_designs_of(partner, {d for _s, d in merged if d})
        for sku, design_id in merged:
            if design_id in designs and sku in variants and designs[design_id].product_tmpl_id != variants[sku].product_tmpl_id:
                return {**info, 'status': 'invalid', 'code': 'product_mismatch', 'message': REFUSALS['product_mismatch'][1], 'sku': sku, 'design_id': design_id}

        priced = [(sku, designs.get(d), q, variants[sku]) for (sku, d), q in merged.items() if sku in variants and (not d or d in designs)]
        values = self._api_line_commands(priced, self.env['clothcraft.design.pricing']._clothcraft_get())
        order = self.env['sale.order'].new({'warehouse_id': warehouse.id, 'order_line': [Command.create(v) for v in values]})
        # the virtual lines come back in the order given: a garment, then its fee when it has a design
        lines_iter = iter(order.order_line)
        by_key = {}
        for sku, design, _q, _v in priced:
            garment = next(lines_iter)
            by_key[sku, design.id if design else 0] = (garment, next(lines_iter) if design else None)
        self._api_touch_designs(self.env['clothcraft.design'].sudo().browse([d.id for _s, d, _q, _v in priced if d]))

        rows = []
        for (sku, design_id), quantity in merged.items():
            variant = variants.get(sku)
            if not variant:
                rows.append({'sku': sku, 'known': False, 'quantity': quantity, 'design_id': design_id or False})
                continue
            row = {
                'sku': sku, 'known': True, 'quantity': quantity, 'design_id': design_id or False,
                'template_id': variant.product_tmpl_id.id, 'name': variant.product_tmpl_id.name,
                'slug': variant.product_tmpl_id.clothcraft_slug,
                'color': self._api_attribute(variant, 'Color'), 'size': self._api_attribute(variant, 'Size'),
                'free_qty': self._api_free_qty(variant, warehouse),
            }
            if design_id and design_id not in designs:
                rows.append({**row, 'design_unavailable': True, 'message': REFUSALS['unavailable'][1]})
                continue
            garment, fee = by_key[sku, design_id]
            row.update({'unit_price': garment.price_unit, 'line_total': garment.price_total})
            if fee:
                row['print_fee'] = self._api_print_fee(fee)
            rows.append(row)
        return {**info, 'status': 'ok', 'lines': rows, 'amount_total': order.amount_total, 'amount_tax': order.amount_tax}

    # ------------------------------------------------------------------ orders (step 6c)
    @api.model
    def _api_idem_ref(self, partner, key):
        return f'api:{partner.id}:{key}'

    @api.model
    def _api_order_data(self, order):
        """An order as plain data: what the service needs to build the API's Order."""
        shipping = order.partner_shipping_id
        transactions = order.sudo().transaction_ids   # read with sudo: the service user has no access to payments
        cod = transactions[:1].provider_id.custom_mode == 'cash_on_delivery'
        lines = []
        for line in order.order_line.filtered(lambda l: not l.display_type and l.product_id.default_code and not l.clothcraft_fee_for_id):
            variant = line.product_id
            row = {
                'sku': variant.default_code, 'name': variant.product_tmpl_id.name, 'slug': variant.product_tmpl_id.clothcraft_slug or '',
                'color': self._api_attribute(variant, 'Color'), 'size': self._api_attribute(variant, 'Size'),
                'quantity': int(line.product_uom_qty), 'unit_price': line.price_unit, 'line_total': line.price_total,
            }
            if line.clothcraft_design_id:
                # the fee line keeps what it was priced with; read with sudo: the service user has no right on designs
                row['design_id'] = line.clothcraft_design_id.id
                row['print_fee'] = self._api_print_fee(line.sudo().clothcraft_fee_line_ids[:1]) if line.sudo().clothcraft_fee_line_ids else None
            lines.append(row)
        return {
            'id': order.id, 'name': order.name, 'created': order.create_date.isoformat(timespec='milliseconds'),
            'stage': order.clothcraft_state, 'status_changed': self._api_status_time(order), 'tracking': self._api_tracking(order),
            'cancelled': order.state == 'cancel', 'payment_method': 'cod' if cod else 'bank_transfer',
            'paid': any(t.state == 'done' for t in transactions),
            'lines': lines, 'amount_total': order.amount_total, 'amount_tax': order.amount_tax,
            'delivery': {
                'name': shipping.name, 'email': shipping.email or '', 'phone': shipping.phone or '', 'street': shipping.street or '',
                'city': shipping.city or '', 'province': shipping.state_id.code or '', 'postal_code': shipping.zip or '',
                'note': html2plaintext(order.note or '').strip(),
            },
        }

    @api.model
    def _api_orders_of(self, partner_id):
        return self.env['sale.order'].search([('partner_id', '=', partner_id), ('state', 'in', ('sale', 'cancel'))], order='id desc')

    @api.model
    def _api_customer(self, sid_hash):
        """(the customer's partner, seconds the session can still last) for a live session id hash, else (None, 0).
        Every order method starts here: the customer is whoever the SESSION says, never a value the caller names."""
        row = self._api_session(sid_hash)
        return (row.user_id.partner_id, self._api_remaining(row)) if row else (None, 0)

    @api.model
    def orders(self, sid_hash):
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(sid_hash)
        if not partner:
            return {**info, 'unauthorised': True}
        return {**info, 'session_remaining': remaining, 'orders': [self._api_order_data(o) for o in self._api_orders_of(partner.id)]}

    @api.model
    def order(self, sid_hash, order_id):
        """One order of the signed-in customer, or found=False. Another customer's order is not found, never refused: it gives nothing away."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(sid_hash)
        if not partner:
            return {**info, 'unauthorised': True}
        order = self._api_orders_of(partner.id).filtered(lambda o: o.id == order_id)
        return {**info, 'session_remaining': remaining, 'found': bool(order), 'order': self._api_order_data(order) if order else None}

    @api.model
    def order_by_key(self, sid_hash, idempotency_key):
        """The order the signed-in customer already placed with this key (for a repeated submit), if any."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(sid_hash)
        if not partner:
            return {**info, 'unauthorised': True}
        order = self.env['sale.order'].search([('client_order_ref', '=', self._api_idem_ref(partner, idempotency_key))], limit=1)
        return {**info, 'session_remaining': remaining, 'found': bool(order), 'order': self._api_order_data(order) if order else None}

    @api.model
    def _api_new_transaction(self, order, partner, cod):
        env = self.env
        provider = env.ref('delivery.payment_provider_cod') if cod else env.ref('payment.payment_provider_transfer')
        method = env.ref('delivery.payment_method_cash_on_delivery') if cod else env.ref('payment_custom.payment_method_wire_transfer')
        transaction = env['payment.transaction'].sudo().create({
            'provider_id': provider.id, 'payment_method_id': method.id, 'amount': order.amount_total,
            'currency_id': order.currency_id.id, 'partner_id': partner.id, 'reference': order.name,
            'operation': 'online_direct', 'sale_order_ids': [Command.set([order.id])]})
        transaction._set_pending()
        # as the simulator does: the payment cron must not post-process (email, invoice) a development order
        transaction.is_post_processed = True
        return transaction

    @api.model
    def place_order(self, payload):
        """Create and confirm an order in ONE transaction, through the B6 stock guard.

        payload: sid_hash (the customer's session), lines [{sku, quantity}], delivery {name, email, phone, street, city, province, postal_code, note},
        payment_method ('cod' | 'bank_transfer'), quoted_total, idempotency_key (optional).

        The writes (address, order, transaction, confirm) use sudo: the service user has NO create right on any of them, so a
        leaked key cannot make an order with prices of its own. Only this method can, and it prices and checks stock itself.

        Returns a status, and writes nothing unless it is 'created':
          created          the order (the earlier order, replayed=True, when this key was used before)
          quote_not_ready  a line is unknown or cannot be supplied; `quote` says which
          price_changed    the total is not the one the shopper saw; `quote` is the new one
          guard_refused    the guard refused at confirm (a race lost); `message` is its sentence, `quote` is priced again
        Same key, two requests at once: an advisory lock on the key makes the second wait for the first to commit, then it
        looks the key up in a fresh transaction (its own snapshot predates that commit) and returns the first's order.
        A partial unique index on sale_order.client_order_ref is the second line of defence.
        """
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(payload.get('sid_hash'))
        if not partner:
            return {**info, 'status': 'unauthorised'}
        info['session_remaining'] = remaining
        key = payload.get('idempotency_key')
        ref = self._api_idem_ref(partner, key) if key else False
        if ref:
            self.env.cr.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', [ref])
            with self.env.registry.cursor() as cr:
                fresh = api.Environment(cr, SUPERUSER_ID, self.env.context)   # only to look the key up
                earlier = fresh['sale.order'].search([('client_order_ref', '=', ref)], limit=1)
                if earlier:
                    return {**info, 'status': 'created', 'replayed': True, 'order': fresh['clothcraft.api']._api_order_data(earlier)}

        lines = payload['lines']
        quote = self._api_quote(lines, partner)
        if quote['status'] == 'invalid':
            return {**info, 'status': 'invalid', 'code': quote['code'], 'message': quote['message']}
        wanted = defaultdict(int)   # one SKU can be on several rows (several designs): the stock must cover them together
        for r in quote['lines']:
            wanted[r['sku']] += r['quantity']
        if not quote['lines'] or any(not r['known'] or r.get('design_unavailable') or r['free_qty'] <= 0 or r['free_qty'] < wanted[r['sku']]
                                     for r in quote['lines']):
            return {**info, 'status': 'quote_not_ready', 'quote': quote}
        if round(payload['quoted_total'], 2) != round(quote['amount_total'], 2):
            return {**info, 'status': 'price_changed', 'quote': quote}

        delivery, cod = payload['delivery'], payload['payment_method'] == 'cod'
        warehouse = self._api_warehouse()
        variants = {v.default_code: v for v in self._api_products([line['sku'] for line in lines])}
        merged = self._api_merge(lines)
        designs = self._api_designs_of(partner, {d for _s, d in merged if d})
        values = self._api_line_commands([(sku, designs.get(d), q, variants[sku]) for (sku, d), q in merged.items()],
                                         self.env['clothcraft.design.pricing']._clothcraft_get())
        try:
            with self.env.cr.savepoint():
                state = self.env['res.country.state'].search([('country_id.code', '=', 'PH'), ('code', '=', delivery['province'])], limit=1)
                address = self.env['res.partner'].sudo().create({
                    'parent_id': partner.id, 'type': 'delivery', 'name': delivery['name'], 'email': delivery['email'],
                    'phone': delivery['phone'], 'street': delivery['street'], 'city': delivery['city'],
                    'zip': delivery['postal_code'], 'state_id': state.id, 'country_id': self.env.ref('base.ph').id})
                order = self.env['sale.order'].sudo().create({
                    'partner_id': partner.id, 'partner_shipping_id': address.id, 'warehouse_id': warehouse.id,
                    'client_order_ref': ref, 'note': plaintext2html(delivery['note']) if delivery.get('note') else False,
                    'order_line': [Command.create(v) for v in values if 'clothcraft_print_rate' not in v]})
                # each fee line after its garment line, linked to it (a line cannot point at a sibling made in the same create)
                garment_of = {line.sequence: line for line in order.order_line}
                order.write({'order_line': [Command.create({**v, 'clothcraft_fee_for_id': garment_of[v['sequence'] - 1].id})
                                            for v in values if 'clothcraft_print_rate' in v]})
                order.action_confirm()   # the B6 guard runs here; there is no bypass
                order.order_line.clothcraft_design_id.filtered(lambda d: d.state == 'draft').write({'state': 'ordered'})
                self._api_new_transaction(order, partner, cod)
                # step 12: what was ordered leaves the customer's saved cart in this same transaction (a refusal rolls both back)
                self._api_cart_take_ordered(partner, merged)
        except UserError as error:
            self.env.invalidate_all()
            return {**info, 'status': 'guard_refused', 'message': str(error), 'quote': self._api_quote(lines, partner)}
        return {**info, 'status': 'created', 'replayed': False, 'order': self._api_order_data(order)}
