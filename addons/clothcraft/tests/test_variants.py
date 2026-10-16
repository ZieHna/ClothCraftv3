from odoo import Command
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'clothcraft')
class TestVariants(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.color = cls.env.ref('clothcraft.attribute_color')
        cls.size = cls.env.ref('clothcraft.attribute_size')
        cls.template = cls.env['product.template'].create({
            'name': 'Classic Tee',
            'list_price': 500,
            'attribute_line_ids': [
                Command.create({
                    'attribute_id': cls.color.id,
                    'value_ids': [Command.set([cls.env.ref('clothcraft.color_black').id,
                                               cls.env.ref('clothcraft.color_white').id])],
                }),
                Command.create({
                    'attribute_id': cls.size.id,
                    'value_ids': [Command.set([cls.env.ref('clothcraft.size_s').id,
                                               cls.env.ref('clothcraft.size_m').id,
                                               cls.env.ref('clothcraft.size_xl').id])],
                }),
            ],
        })

    def test_attributes_are_seeded(self):
        self.assertEqual(self.color.display_type, 'color')
        self.assertEqual(self.size.value_ids.mapped('name'), ['XS', 'S', 'M', 'L', 'XL', 'XXL'])

    def test_two_colors_three_sizes_make_six_variants(self):
        self.assertEqual(len(self.template.product_variant_ids), 6)

    def test_price_is_list_price_plus_extras(self):
        xl = self.template.attribute_line_ids.filtered(
            lambda line: line.attribute_id == self.size).product_template_value_ids.filtered(
            lambda value: value.name == 'XL')
        xl.price_extra = 50
        variants = self.template.product_variant_ids
        xl_variants = variants.filtered(lambda p: 'XL' in p.product_template_attribute_value_ids.mapped('name'))
        other = variants - xl_variants
        self.assertEqual(set(xl_variants.mapped('lst_price')), {550.0})
        self.assertEqual(set(other.mapped('lst_price')), {500.0})

    def test_garment_type_link(self):
        garment = self.env['clothcraft.garment.type'].create({'name': 'T-Shirt', 'code': 'TSH'})
        self.template.garment_type_id = garment
        self.assertEqual(self.env['product.template'].search([('garment_type_id', '=', garment.id)]), self.template)

    def test_product_without_garment_type_still_works(self):
        plain = self.env['product.template'].create({'name': 'Plain'})
        self.assertFalse(plain.garment_type_id)
