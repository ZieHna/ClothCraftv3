import datetime as dt

from odoo import Command

from .util import at, quiet


def build_customers(env, plan, labels):
    """Portal users with invented names on example.com: no password, no invitation email, no address.
    Returns {customer index: res.partner}."""
    env = quiet(env)
    portal = env.ref('base.group_portal')
    partners = {}
    for customer in plan:
        with at(dt.datetime.combine(customer['join'], dt.time(0, 5))):
            user = env['res.users'].create({
                'name': f"{customer['first']} {customer['last']}", 'login': customer['email'],
                'email': customer['email'], 'group_ids': [Command.set([portal.id])]})
        user.partner_id.category_id = [Command.set(labels['partner'].ids)]
        partners[customer['index']] = user.partner_id
    return partners
