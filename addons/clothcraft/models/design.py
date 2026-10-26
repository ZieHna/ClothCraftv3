"""Customized garments (step 9a): the print-fee settings, the customer's saved design, and the checks an upload goes through.

A design is uploaded once, whole (POST /api/designs through clothcraft.api.design_upload): the editor's state, the pictures it uses, an
800 x 800 preview and the print file. Odoo cannot tell whether the preview shows what the geometry says (it does not render designs), so
it checks what it can: every picture and both renders really are pictures of the allowed kinds and sizes (Pillow decodes each one), and the
element list it is asked to price matches the editor state it is given, element by element. Staff review the print file before printing.

Attachments belong to the design (res_model clothcraft.design) and are never public; the shop serves them only to the owner, staff only for
designs on an order. A design that has been ordered never changes; a draft can be voided by its owner. A daily job deletes drafts unused for
30 days and void designs after a day, unless an order line refers to them.
"""
import base64
import binascii
import datetime
import io
import json
import logging
import math
import os

from PIL import Image
# Odoo loads only a few Pillow formats (odoo/tools/image.py: preinit, then _initialized = 2), and WebP is not one of them: register it here,
# and only it, so a customer's WebP picture can be decoded and checked. GIF is loaded by Odoo but refused below by its signature.
from PIL import WebPImagePlugin  # noqa: F401

from odoo import api, fields, models
from odoo.exceptions import UserError

from .. import design_fee

_logger = logging.getLogger(__name__)

MB = 1024 * 1024
LIMITS = {
    'total': 20 * MB,          # everything decoded: pictures + preview + print file + state
    'picture': 5 * MB, 'pictures': 8, 'layers': 50,
    'preview': 2 * MB, 'print': 12 * MB, 'state': 512 * 1024, 'state_depth': 40,
    'megapixels': 40_000_000, 'print_px': 4096, 'preview_px': 800,
    'unordered_designs': 30,
}
TOLERANCE = {'position': 0.5, 'size': 0.5, 'angle': 0.5, 'opacity': 0.01}
DRAFT_DAYS, VOID_DAYS = 30, 1

# code -> (HTTP status the service answers with, the sentence the customer reads)
REFUSALS = {
    'too_large': (413, "This design is too large to upload (at most 20 MB in all). Use smaller pictures or fewer of them."),
    'picture_too_large': (413, "A picture in this design is larger than 5 MB."),
    'preview_too_large': (413, "The design preview is larger than 2 MB."),
    'print_too_large': (413, "The print file is larger than 12 MB."),
    'state_too_large': (413, "The saved design is larger than 512 KB."),
    'too_many_pictures': (422, "A design can have at most 8 pictures."),
    'too_many_layers': (422, "A design can have at most 50 elements."),
    'picture_type': (415, "Only PNG, JPEG or WebP pictures can be used."),
    'png_required': (415, "The preview and print file must be PNG pictures."),
    'unreadable': (422, "A picture in this design could not be read."),
    'megapixels': (422, "A picture in this design has more than 40 megapixels."),
    'preview_size': (422, "The preview must be 800 × 800 pixels."),
    'print_size': (422, "The print file must be square and at most 4096 pixels."),
    'format': (422, "This design could not be read (format version 1 expected)."),
    'mismatch': (422, "The design changed while it was being sent. Please try again."),
    'skewed': (422, "An element in this design is slanted. Straighten it and try again."),
    'not_designable': (422, "This garment cannot be customized yet."),
    'product_mismatch': (422, "This design was made for another garment."),
    'too_many_designs': (429, "You have 30 designs that are not ordered yet. Remove one before saving another."),
    'unavailable': (404, "This design is no longer available."),
    'ordered': (409, "This design is on an order and cannot be removed."),
}
SIGNATURES = (('png', b'\x89PNG\r\n\x1a\n', None), ('jpeg', b'\xff\xd8\xff', None), ('webp', b'RIFF', b'WEBP'))
PIL_FORMAT = {'png': 'PNG', 'jpeg': 'JPEG', 'webp': 'WEBP'}
MIMETYPE = {'png': 'image/png', 'jpeg': 'image/jpeg', 'webp': 'image/webp'}


class DesignRefused(Exception):
    def __init__(self, code):
        super().__init__(REFUSALS[code][1])
        self.code = code


# ------------------------------------------------------------------ the checks (pure, so tests can call them)
def decode(data, cap, code):
    """base64 text -> bytes, refusing (before decoding) anything that would decode to more than `cap` bytes."""
    if not isinstance(data, str) or not data:
        raise DesignRefused('format')
    if len(data) * 3 // 4 > cap + 2:
        raise DesignRefused(code)
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise DesignRefused('format') from None
    if len(raw) > cap:
        raise DesignRefused(code)
    return raw


def kind_of(raw):
    for kind, head, tag in SIGNATURES:
        if raw.startswith(head) and (tag is None or raw[8:12] == tag):
            return kind
    return None


def check_picture(raw, allowed, type_code):
    """(kind, width, height) of a real picture of an allowed kind; refuses SVG, GIF, anything else, and anything Pillow cannot decode."""
    kind = kind_of(raw)
    if kind not in allowed:
        raise DesignRefused(type_code)
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != PIL_FORMAT[kind]:
                raise DesignRefused(type_code)
            width, height = image.size
            if width * height > LIMITS['megapixels']:
                raise DesignRefused('megapixels')
            image.verify()
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
    except DesignRefused:
        raise
    except Exception:  # noqa: BLE001 - whatever Pillow raises for a broken picture (including its decompression bomb error)
        raise DesignRefused('unreadable') from None
    return kind, width, height


def check_depth(value, limit):
    stack = [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if depth > limit:
            raise DesignRefused('format')
        if isinstance(item, dict):
            stack.extend((v, depth + 1) for v in item.values())
        elif isinstance(item, list):
            stack.extend((v, depth + 1) for v in item)


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise DesignRefused('format')
    return float(value)


def state_elements(state):
    """The elements of the editor's state ({schemaVersion 1, engine, state: {objects}}), as the editor's own layer list would give them:
    centre, size after scaling, rotation, visibility, opacity. Fabric objects are centred (originX/Y center); a line has no height of its
    own and reports its stroke. Groups are not made by the editor and are refused; so is a slanted (skewed) element, whose outline is not
    a rectangle and so cannot be priced by the bounding-box rule."""
    if not isinstance(state, dict) or state.get('schemaVersion') != 1 or not isinstance(state.get('state'), dict):
        raise DesignRefused('format')
    objects = state['state'].get('objects')
    if not isinstance(objects, list):
        raise DesignRefused('format')
    out = []
    for o in objects:
        if not isinstance(o, dict) or not isinstance(o.get('layerId'), str) or o.get('type') in ('Group', 'group', 'ActiveSelection'):
            raise DesignRefused('format')
        if o.get('originX', 'center') != 'center' or o.get('originY', 'center') != 'center':
            raise DesignRefused('format')
        if abs(_number(o.get('skewX', 0))) > 1e-6 or abs(_number(o.get('skewY', 0))) > 1e-6:
            raise DesignRefused('skewed')
        height = _number(o.get('height', 0)) * abs(_number(o.get('scaleY', 1)))
        if o.get('shapeKind') == 'line':
            height = max(height, _number(o.get('strokeWidth', 0)))
        out.append({
            'id': o['layerId'], 'x': _number(o.get('left', 0)), 'y': _number(o.get('top', 0)),
            'width': _number(o.get('width', 0)) * abs(_number(o.get('scaleX', 1))), 'height': height,
            'rotation': _number(o.get('angle', 0)) % 360, 'visible': o.get('visible', True) is not False,
            'opacity': _number(o.get('opacity', 1)), 'asset': o.get('assetId') if isinstance(o.get('assetId'), str) else None,
        })
    return out


def check_geometry(layers, elements):
    """The element list the customer asks us to price, normalised, after checking it against the editor state element by element (same
    ids in the same order, centres and sizes within half a design unit, angles within half a degree: a rectangle turned 180 degrees is
    the same box, opacity within 0.01, the same visibility)."""
    if not isinstance(layers, list):
        raise DesignRefused('format')
    if len(layers) > LIMITS['layers'] or len(elements) > LIMITS['layers']:
        raise DesignRefused('too_many_layers')
    if len(layers) != len(elements):
        raise DesignRefused('mismatch')
    geometry = []
    for layer, element in zip(layers, elements):
        if not isinstance(layer, dict) or layer.get('id') != element['id']:
            raise DesignRefused('mismatch')
        g = {'id': layer['id'], 'x': _number(layer.get('x')), 'y': _number(layer.get('y')), 'width': _number(layer.get('width')),
             'height': _number(layer.get('height')), 'rotation': _number(layer.get('rotation')) % 360,
             'visible': layer.get('visible', True) is not False, 'opacity': _number(layer.get('opacity', 1))}
        turn = abs(g['rotation'] - element['rotation']) % 180
        if abs(g['x'] - element['x']) > TOLERANCE['position'] or abs(g['y'] - element['y']) > TOLERANCE['position'] \
                or abs(g['width'] - element['width']) > TOLERANCE['size'] or abs(g['height'] - element['height']) > TOLERANCE['size'] \
                or min(turn, 180 - turn) > TOLERANCE['angle'] or abs(g['opacity'] - element['opacity']) > TOLERANCE['opacity'] \
                or g['visible'] != element['visible']:
            raise DesignRefused('mismatch')
        geometry.append(g)
    return geometry


def check_upload(payload):
    """Everything about an upload that does not need the database. Returns the decoded parts; raises DesignRefused."""
    pictures, layers = payload.get('pictures') or [], payload.get('layers')
    if not isinstance(pictures, list) or not isinstance(payload.get('state'), str):
        raise DesignRefused('format')
    if len(pictures) > LIMITS['pictures']:
        raise DesignRefused('too_many_pictures')
    if isinstance(layers, list) and len(layers) > LIMITS['layers']:
        raise DesignRefused('too_many_layers')
    # the total first, from the text lengths, so nothing large is decoded before it is known to fit
    texts = [p.get('data') if isinstance(p, dict) else None for p in pictures] + [payload.get('preview'), payload.get('print')]
    if sum(len(t) * 3 // 4 for t in texts if isinstance(t, str)) + len(payload['state'].encode()) > LIMITS['total']:
        raise DesignRefused('too_large')

    state_raw = payload['state'].encode()
    if len(state_raw) > LIMITS['state']:
        raise DesignRefused('state_too_large')
    try:
        state = json.loads(state_raw)
    except ValueError:
        raise DesignRefused('format') from None
    check_depth(state, LIMITS['state_depth'])
    elements = state_elements(state)
    geometry = check_geometry(layers, elements)

    decoded = {}
    for picture in pictures:
        if not isinstance(picture, dict) or not isinstance(picture.get('id'), str) or picture['id'] in decoded:
            raise DesignRefused('format')
        raw = decode(picture.get('data'), LIMITS['picture'], 'picture_too_large')
        kind, _w, _h = check_picture(raw, ('png', 'jpeg', 'webp'), 'picture_type')
        decoded[picture['id']] = (raw, kind)
    used = {e['asset'] for e in elements if e['asset']}
    if used != set(decoded):
        raise DesignRefused('mismatch')

    preview = decode(payload.get('preview'), LIMITS['preview'], 'preview_too_large')
    _k, w, h = check_picture(preview, ('png',), 'png_required')
    if (w, h) != (LIMITS['preview_px'], LIMITS['preview_px']):
        raise DesignRefused('preview_size')
    printed = decode(payload.get('print'), LIMITS['print'], 'print_too_large')
    _k, w, h = check_picture(printed, ('png',), 'png_required')
    if w != h or w > LIMITS['print_px']:
        raise DesignRefused('print_size')
    return {'state': state_raw, 'geometry': geometry, 'pictures': decoded, 'preview': preview, 'print': printed, 'print_px': w}


def bounds_file():
    path = os.path.join(os.path.dirname(__file__), '..', 'data', 'garment_bounds.json')
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def fill_print_boxes(env, overwrite=False):
    """Set the print box of every garment whose storefront id is in data/garment_bounds.json (the migration and the seeder call this).
    Garments with a box already keep it unless overwrite. Returns (set, missing storefront ids)."""
    products = bounds_file()['products']
    templates = env['product.template'].with_context(active_test=False).search([('garment_type_id', '!=', False), ('clothcraft_slug', '!=', False)])
    done, missing = 0, []
    for template in templates:
        box = products.get(template.clothcraft_slug)
        if not box:
            missing.append(template.clothcraft_slug)
            continue
        if template.clothcraft_print_w and not overwrite:
            continue
        template.write({'clothcraft_print_x': box['x'], 'clothcraft_print_y': box['y'], 'clothcraft_print_w': box['width'], 'clothcraft_print_h': box['height']})
        done += 1
    return done, missing


# ------------------------------------------------------------------ the models
class ClothcraftDesignPricing(models.Model):
    """The print-fee settings, one record per company: rate per square inch, and the surcharge per size step above Small."""
    _name = 'clothcraft.design.pricing'
    _description = 'Customization pricing'

    name = fields.Char(default='Customization pricing', readonly=True)
    company_id = fields.Many2one('res.company', required=True, default=lambda self: self.env.company, readonly=True)
    rate = fields.Float(string="Price per square inch", default=2.0, digits=(8, 2), required=True,
                        help="VAT included. The fee of a design is its covered area in square inches times this.")
    size_step = fields.Float(string="Per size step above Small", default=20.0, digits=(8, 2), required=True,
                             help="VAT included. Added per print for each size step above Small: M 1 step, L 2, XL 3, XXL 4 (XS and S: none).")

    _company_uniq = models.Constraint('UNIQUE(company_id)', 'There is one customization pricing per company.')
    _not_negative = models.Constraint('CHECK(rate >= 0 AND size_step >= 0)', 'Prices cannot be negative.')

    @api.model
    def _clothcraft_get(self):
        record = self.sudo().search([('company_id', '=', self.env.company.id)], limit=1)
        return record or self.sudo().create({'company_id': self.env.company.id})

    @api.model
    def action_open(self):
        return {'type': 'ir.actions.act_window', 'res_model': self._name, 'res_id': self._clothcraft_get().id, 'view_mode': 'form',
                'name': self.env._("Customization pricing"), 'target': 'current'}


class ClothcraftDesign(models.Model):
    _name = 'clothcraft.design'
    _description = 'Customer design'
    _order = 'id desc'

    name = fields.Char(compute='_compute_name')
    partner_id = fields.Many2one('res.partner', string="Customer", required=True, index=True, ondelete='restrict', readonly=True)
    product_tmpl_id = fields.Many2one('product.template', string="Garment", required=True, index=True, ondelete='restrict', readonly=True)
    variant_id = fields.Many2one('product.product', string="Designed on", ondelete='set null', readonly=True,
                                 help="The colour and size the customer had chosen in the editor.")
    state = fields.Selection([('draft', 'Not ordered'), ('ordered', 'Ordered'), ('void', 'Removed')], default='draft', required=True, index=True, readonly=True)
    geometry = fields.Json(readonly=True, help="The elements as priced: centre, size, rotation, visibility, opacity (design units).")
    covered_sq_in = fields.Float(string="Covered area (sq in)", digits=(8, 2), readonly=True)
    print_box = fields.Json(readonly=True, help="The garment's print box and print area at size Small when the design was priced.")
    layer_count = fields.Integer(readonly=True)
    print_px = fields.Integer(string="Print file size (px)", readonly=True)
    preview_id = fields.Many2one('ir.attachment', readonly=True, ondelete='set null')
    print_id = fields.Many2one('ir.attachment', readonly=True, ondelete='set null')
    state_id = fields.Many2one('ir.attachment', string="Editor state", readonly=True, ondelete='set null')
    idempotency_key = fields.Char(readonly=True, copy=False)
    last_used = fields.Datetime(default=fields.Datetime.now, readonly=True)
    order_line_ids = fields.One2many('sale.order.line', 'clothcraft_design_id', readonly=True)
    company_id = fields.Many2one('res.company', required=True, default=lambda self: self.env.company, readonly=True)

    _key_uniq = models.Constraint('UNIQUE(partner_id, idempotency_key)', 'This design was already uploaded.')

    def _compute_name(self):
        for design in self:
            design.name = f'Design {design.id}' if design.id else 'New design'

    def write(self, vals):
        # an ordered design is what was printed: it never changes (the job may still mark when it was last used)
        if set(vals) - {'last_used', 'state'} and any(d.state == 'ordered' for d in self):
            raise UserError(self.env._("A design that has been ordered cannot be changed."))
        if vals.get('state') not in (None, 'ordered') and any(d.state == 'ordered' for d in self):
            raise UserError(self.env._("A design that has been ordered cannot be changed."))
        return super().write(vals)

    @api.ondelete(at_uninstall=False)
    def _unlink_never_ordered(self):
        if any(d.state == 'ordered' or d.order_line_ids for d in self):
            raise UserError(self.env._("A design that has been ordered cannot be deleted."))

    @api.model
    def _cron_cleanup(self):
        """Delete drafts unused for 30 days and void designs after a day; never one an order line refers to, nor (step 12) one that is in a
        customer's saved cart (the cart's own expiry decides about those)."""
        now = fields.Datetime.now()
        stale = self.sudo().search([
            '|', '&', ('state', '=', 'draft'), ('last_used', '<', now - datetime.timedelta(days=DRAFT_DAYS)),
            '&', ('state', '=', 'void'), ('write_date', '<', now - datetime.timedelta(days=VOID_DAYS)),
        ]).filtered(lambda d: not d.order_line_ids)
        in_carts = self.env['clothcraft.cart.line'].sudo().search([('design_id', 'in', stale.ids)]).design_id
        stale -= in_carts
        count = len(stale)
        stale.unlink()
        _logger.info('clothcraft: removed %s unused design(s)', count)
        return count


def price_design(design, size, pricing):
    """The print fee of one piece of this design at this size, with everything an order line keeps. A size the fee does not know (none
    of XS to XXL) has no size step."""
    size = size if size in design_fee.SIZE_STEPS else 'S'
    return {'covered_sq_in': design.covered_sq_in, 'rate': pricing.rate, 'size_step': pricing.size_step, 'steps': design_fee.SIZE_STEPS[size],
            'fee': design_fee.fee_per_piece(design.covered_sq_in, pricing.rate, pricing.size_step, size)}
