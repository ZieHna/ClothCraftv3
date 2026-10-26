{
    'name': 'ClothCraft DSS',
    'version': '19.0.1.0.0',
    'summary': 'Decision support: demand forecast, restock, customer segments, alerts, business health.',
    'author': 'ClothCraft Team',
    'category': 'Sales',
    'license': 'LGPL-3',
    'depends': ['clothcraft'],
    # the engine (engine/) is plain pandas; install refuses when these are missing. Imported lazily, inside a run only.
    'external_dependencies': {'python': ['pandas', 'numpy', 'statsmodels']},
    'data': [
        'security/dss_security.xml',
        'security/ir.model.access.csv',
        'data/dss_cron_data.xml',
        'views/dss_run_views.xml',
        'views/dss_menus.xml',
    ],
    'application': False,
    'installable': True,
}
