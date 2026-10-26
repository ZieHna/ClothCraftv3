"""The storefront API's side of customized garments (step 9a): the fee settings for a garment, uploading a design, reading it back, its
pictures, removing it, and the staff download. Quotes and orders with designs are in api.py.

The service user has NO right on clothcraft.design or its attachments (security/ir.model.access.csv): every method here finds the customer
from the session (never from a value the caller names), and reads or writes with sudo only the design records of that customer. Another
customer's design is "not found", never "refused": it gives nothing away.
"""
import base64

from odoo import SUPERUSER_ID, api, fields, models

from .. import design_fee
from .design import LIMITS, MIMETYPE, REFUSALS, DesignRefused, check_upload


class ClothcraftApiDesign(models.AbstractModel):
    _inherit = 'clothcraft.api'

    @api.model
    def _api_design_data(self, design):
        return {
            'id': design.id, 'product_id': design.product_tmpl_id.id, 'slug': design.product_tmpl_id.clothcraft_slug or '',
            'sku': design.variant_id.default_code or '', 'state': design.state, 'covered_sq_in': design.covered_sq_in,
            'layer_count': design.layer_count, 'print_px': design.print_px,
            'created': design.create_date.isoformat(timespec='milliseconds'),
            'version': (design.preview_id.checksum or '')[:12],
        }

    @api.model
    def _api_own_design(self, partner, design_id):
        """The customer's own design that is not removed, or an empty recordset."""
        try:
            design_id = int(design_id)
        except (TypeError, ValueError):
            return self.env['clothcraft.design'].sudo()
        return self.env['clothcraft.design'].sudo().search([('id', '=', design_id), ('partner_id', '=', partner.id), ('state', '!=', 'void')])

    @api.model
    def _api_refused(self, info, code):
        return {**info, 'status': 'refused', 'code': code, 'http_status': REFUSALS[code][0], 'message': REFUSALS[code][1]}

    # ------------------------------------------------------------------ the fee settings of one garment
    @api.model
    def design_pricing(self, slug):
        """What the editor needs to estimate the print fee: {status: ok, designable, box, reference_sq_in, rate, size_step, steps, limits},
        or not_found for a garment the shop does not sell. designable False (with the sentence) when it has no print box: no fallback."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        template = self._api_products().filtered(lambda v: v.product_tmpl_id.clothcraft_slug == slug)[:1].product_tmpl_id
        if not template:
            return {**info, 'status': 'not_found'}
        pricing = self.env['clothcraft.design.pricing']._clothcraft_get()
        box = template._clothcraft_print_box()
        return {
            **info, 'status': 'ok', 'product_id': template.id, 'designable': bool(box), 'box': box,
            'message': '' if box else REFUSALS['not_designable'][1],
            'reference_sq_in': template.garment_type_id.reference_area_sq_in, 'rate': pricing.rate, 'size_step': pricing.size_step,
            'steps': dict(design_fee.SIZE_STEPS), 'band': design_fee.BAND,
            'limits': {k: LIMITS[k] for k in ('total', 'picture', 'pictures', 'layers', 'preview', 'print', 'state', 'print_px', 'preview_px')},
        }

    # ------------------------------------------------------------------ uploading
    @api.model
    def design_upload(self, payload):
        """payload: sid_hash, product (the garment's storefront id), sku (the variant chosen in the editor), idempotency_key (optional), state (the
        editor state, JSON text), layers [{id, x, y, width, height, rotation, visible, opacity}], pictures [{id, data}], preview, print
        (base64). Returns status created (design, replayed), unauthorised, not_found, or refused (code, http_status, message); nothing is
        written unless created. The same key again returns the first design (an advisory lock makes a concurrent repeat wait for it)."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(payload.get('sid_hash'))
        if not partner:
            return {**info, 'status': 'unauthorised'}
        info['session_remaining'] = remaining
        Design = self.env['clothcraft.design'].sudo()
        key = payload.get('idempotency_key') or False
        if key:
            self.env.cr.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', [f'design:{partner.id}:{key}'])
            with self.env.registry.cursor() as cr:
                fresh = api.Environment(cr, SUPERUSER_ID, self.env.context)   # only to look the key up
                earlier = fresh['clothcraft.design'].search([('partner_id', '=', partner.id), ('idempotency_key', '=', key)], limit=1)
                if earlier:
                    return {**info, 'status': 'created', 'replayed': True, 'design': fresh['clothcraft.api']._api_design_data(earlier)}

        slug = payload.get('product')
        on_sale = self._api_products().filtered(lambda v: v.product_tmpl_id.clothcraft_slug == slug) if isinstance(slug, str) and slug else None
        if not on_sale:
            return {**info, 'status': 'not_found'}
        variant = on_sale.filtered(lambda v: v.default_code == payload.get('sku'))[:1]
        if not variant:
            return self._api_refused(info, 'product_mismatch')
        template = variant.product_tmpl_id
        box = template._clothcraft_print_box()
        if not box:
            return self._api_refused(info, 'not_designable')
        if Design.search_count([('partner_id', '=', partner.id), ('state', '=', 'draft')]) >= LIMITS['unordered_designs']:
            return self._api_refused(info, 'too_many_designs')
        try:
            parts = check_upload(payload)
        except DesignRefused as refused:
            return self._api_refused(info, refused.code)

        reference = template.garment_type_id.reference_area_sq_in
        design = Design.create({
            'partner_id': partner.id, 'product_tmpl_id': template.id, 'variant_id': variant.id, 'idempotency_key': key,
            'geometry': parts['geometry'], 'covered_sq_in': design_fee.covered_sq_in(parts['geometry'], box, reference),
            'print_box': {**box, 'reference_sq_in': reference}, 'layer_count': len(parts['geometry']), 'print_px': parts['print_px'],
        })
        # stored byte for byte: Odoo otherwise shrinks PNG/JPEG attachments to base.image_autoresize_max_px (1920 px by default),
        # which would cut the 3200 px print file and change the customer's pictures under the editor state that refers to them
        Attachment = self.env['ir.attachment'].sudo().with_context(image_no_postprocess=True)

        def attach(name, raw, mimetype):
            return Attachment.create({'name': name, 'raw': raw, 'mimetype': mimetype, 'res_model': 'clothcraft.design', 'res_id': design.id, 'public': False})

        for picture_id, (raw, kind) in parts['pictures'].items():
            attach(f'picture-{picture_id}.{"jpg" if kind == "jpeg" else kind}', raw, MIMETYPE[kind])
        design.write({
            'state_id': attach('state.json', parts['state'], 'application/json').id,
            'preview_id': attach('preview.png', parts['preview'], 'image/png').id,
            'print_id': attach('print.png', parts['print'], 'image/png').id,
        })
        return {**info, 'status': 'created', 'replayed': False, 'design': self._api_design_data(design)}

    # ------------------------------------------------------------------ reading, pictures, removing
    @api.model
    def design_get(self, payload):
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(payload.get('sid_hash'))
        if not partner:
            return {**info, 'status': 'unauthorised'}
        design = self._api_own_design(partner, payload.get('design_id'))
        if not design:
            return {**info, 'status': 'not_found', 'session_remaining': remaining}
        return {**info, 'status': 'ok', 'session_remaining': remaining, 'design': self._api_design_data(design)}

    @api.model
    def design_state(self, payload):
        """What reopening the customer's own design in the editor needs (step 9d, "Edit design" in the cart): the editor state as it was
        uploaded (JSON text) and its pictures {id, mimetype, data (base64)}. Owner only, not removed."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(payload.get('sid_hash'))
        if not partner:
            return {**info, 'status': 'unauthorised'}
        design = self._api_own_design(partner, payload.get('design_id'))
        if not design or not design.state_id:
            return {**info, 'status': 'not_found', 'session_remaining': remaining}
        pictures = []
        for attachment in self.env['ir.attachment'].sudo().search([('res_model', '=', 'clothcraft.design'), ('res_id', '=', design.id), ('name', '=like', 'picture-%')], order='id'):
            pictures.append({'id': attachment.name[len('picture-'):].rsplit('.', 1)[0], 'mimetype': attachment.mimetype, 'data': base64.b64encode(attachment.raw).decode()})
        return {**info, 'status': 'ok', 'session_remaining': remaining, 'design': self._api_design_data(design),
                'state': design.state_id.raw.decode(), 'pictures': pictures}

    @api.model
    def _api_image(self, design, kind, filename):
        attachment = design.preview_id if kind == 'preview' else design.print_id
        if kind not in ('preview', 'print') or not attachment:
            return {'status': 'not_found'}
        return {'status': 'ok', 'mimetype': 'image/png', 'data': base64.b64encode(attachment.raw).decode(),
                'version': (attachment.checksum or '')[:12], 'filename': filename}

    @api.model
    def design_image(self, payload):
        """The preview or the print file of the customer's own design: {status ok, mimetype, data (base64), version, filename}."""
        partner, _remaining = self._api_customer(payload.get('sid_hash'))
        if not partner:
            return {'status': 'unauthorised'}
        design = self._api_own_design(partner, payload.get('design_id'))
        if not design:
            return {'status': 'not_found'}
        return self._api_image(design, payload.get('kind'), f'design-{design.id}-{payload.get("kind")}.png')

    @api.model
    def design_void(self, payload):
        """Remove a design that is not ordered: status voided, not_found, or refused (ordered). It is deleted a day later."""
        info = {**self._api_money(), 'simulation': self._api_simulation()}
        partner, remaining = self._api_customer(payload.get('sid_hash'))
        if not partner:
            return {**info, 'status': 'unauthorised'}
        info['session_remaining'] = remaining
        design = self._api_own_design(partner, payload.get('design_id'))
        if not design:
            return {**info, 'status': 'not_found'}
        if design.state == 'ordered' or design.order_line_ids:
            return self._api_refused(info, 'ordered')
        design.write({'state': 'void'})
        return {**info, 'status': 'voided'}

    @api.model
    def staff_design_image(self, payload):
        """payload: sid_hash (staff), design_id, kind. Only a design on an order; the download is named <order>-<line>-<sku>.png, the line
        being its place among the order's garments (1, 2, ...)."""
        staff = self._api_staff(payload.get('sid_hash'))
        if not staff:
            return {'status': 'unauthorised'}
        try:
            design_id = int(payload.get('design_id'))
        except (TypeError, ValueError):
            return {'status': 'not_found'}
        line = self.env['sale.order.line'].sudo().search(
            [('clothcraft_design_id', '=', design_id), ('order_id.state', 'in', ('sale', 'cancel'))], order='id', limit=1)
        if not line:
            return {'status': 'not_found'}
        garments = line.order_id.order_line.filtered(lambda l: not l.display_type and l.product_id.default_code and not l.clothcraft_fee_for_id).sorted(lambda l: (l.sequence, l.id))
        position = list(garments).index(line) + 1
        kind = payload.get('kind')
        return self._api_image(line.clothcraft_design_id, kind, f'{line.order_id.name}-{position}-{line.product_id.default_code}{"" if kind == "print" else "-preview"}.png')

    @api.model
    def _api_touch_designs(self, designs):
        """Mark designs as used (they are in a cart being priced): at most once a day, so a quote seldom writes."""
        stale = designs.filtered(lambda d: not d.last_used or (fields.Datetime.now() - d.last_used).days >= 1)
        if stale:
            stale.sudo().write({'last_used': fields.Datetime.now()})
