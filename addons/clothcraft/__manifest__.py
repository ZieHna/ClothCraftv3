{
    'name': 'ClothCraft',
    'version': '19.0.1.0.0',
    'summary': 'Custom clothing shop: garment catalogue, pricing, stock and DSS on top of Odoo.',
    'author': 'ClothCraft Team',
    'category': 'Sales',
    'license': 'LGPL-3',
    'depends': ['sale_management', 'stock', 'purchase', 'website_sale'],
    'data': [
        'security/ir.model.access.csv',
        'security/clothcraft_security.xml',
        'views/garment_type_views.xml',
        'views/menus.xml',
    ],
    'application': True,
    'installable': True,
}
