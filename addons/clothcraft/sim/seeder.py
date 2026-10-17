import datetime as dt
import json
import os

from odoo.exceptions import UserError

from . import catalogue, customers, demand
from .backfill import PriceStamps, backfill, unstamped
from .data import MARKER_PARAM, PRESETS, PROTECTED_DBS
from .dbworld import DbWorld
from .digest import content_digest, summary
from .labels import ensure_labels, preexisting
from .loop import Simulation
from .util import add_recorder, remove_recorder
from .variants import opening_plan, variant_table

VERSION = 1


def check_target(env, backup):
    """Refuse to seed a database that holds (or may hold) real data, unless a backup file is given."""
    database = env.cr.dbname
    if database == 'clothcraft_usd_old':
        raise UserError("clothcraft_usd_old is never seeded.")
    if database in PROTECTED_DBS and not (backup and os.path.isfile(backup) and os.path.getsize(backup) > 0):
        raise UserError(
            f"Refusing to seed the live database {database!r} without a backup. Pass SIM_BACKUP=<path of a "
            f"pg_dump file you just took>, or seed a separate database such as clothcraft_sim.")


def check_prerequisites(env):
    if env.company.currency_id.name != 'PHP':
        raise UserError("The simulation expects a PHP company (see README: Philippine database).")
    if not env['ir.module.module'].search_count([('name', '=', 'clothcraft'), ('state', '=', 'installed')]):
        raise UserError("The clothcraft module must be installed.")
    marker = env['ir.config_parameter'].sudo().get_param(MARKER_PARAM)
    if marker:
        raise UserError(f"This database is already seeded ({marker}). Purge it first.")


def run(env, preset='small', seed=7, assets_dir='/mnt/assets-v1', backup=None, out_dir=None):
    """Seed the database (no commit: the caller commits or rolls back). Returns a summary dict."""
    cfg = dict(PRESETS[preset])
    check_target(env, backup)
    check_prerequisites(env)
    before = preexisting(env)
    stale_before = unstamped(env)    # rows already dated "now" (e.g. other work in the same transaction): not ours
    env.cr.execute("SELECT COALESCE(MAX(id), 0) FROM mail_message")
    baseline_message = env.cr.fetchone()[0]
    plan = demand.plan_customers(cfg, seed)
    arrivals = demand.plan_arrivals(cfg, plan, seed)
    planned_orders = demand.count_orders(arrivals)
    launch = dt.datetime.combine(cfg['start'], dt.time(9)) - dt.timedelta(days=60)
    stamps = PriceStamps(env.cr)
    add_recorder(stamps)
    try:
        labels = ensure_labels(env)
        suppliers = catalogue.build_suppliers(env, cfg, labels)
        cat = catalogue.build_catalogue(env, cfg, labels, suppliers, assets_dir, launch)
        partners = customers.build_customers(env, plan, labels)
        priors = demand.priors(cfg, planned_orders, variant_table(cfg['products']))
        world = DbWorld(env, cat, suppliers, partners, labels)
        opening = opening_plan(cfg, seed, priors)
        for entry in opening:
            world.add_opening_receipt(entry)
        simulation = Simulation(world, cfg, seed, plan, arrivals, priors, out_dir)
        simulation.run()
    finally:
        remove_recorder(stamps)
    unprocessed = world.unprocessed_transactions()
    if unprocessed:
        raise UserError(f"{unprocessed} simulated payment transactions are not flagged as post-processed.")
    result = summary(env)
    result.update(simulation.result())
    result['digest'] = content_digest(env, lost=simulation.lost)

    # the ORM stamped every row with the database clock: replace it with the simulated dates
    env.flush_all()
    joins = {partners[c['index']].id: dt.datetime.combine(c['join'], dt.time(0, 5)) for c in plan}
    result['backfill'] = backfill(env, labels, before, launch, joins, simulation.cancel_times, stamps.ranges, baseline_message)
    left = {t: n - stale_before.get(t, 0) for t, n in unstamped(env).items() if n > stale_before.get(t, 0)}
    if left:
        raise UserError(f"Rows still carry the real clock after the backfill: {left}")
    env.invalidate_all()

    result['planned_orders'] = planned_orders
    result['transaction_changes'] = world.transaction_changes
    result['opening_receipts'] = {'first': str(min(e['received'] for e in opening)), 'last': str(max(e['received'] for e in opening)),
                                  'units': sum(q for e in opening for _c, q in e['lines'])}
    result['lost_demand_csv'] = simulation.write_lost_demand()
    env['ir.config_parameter'].sudo().set_param(MARKER_PARAM, json.dumps({
        'version': VERSION, 'preset': preset, 'seed': seed, 'start': str(cfg['start']), 'end': str(cfg['end']),
        'preexisting': before}))
    result['simulation'], result['world'] = simulation, world
    return result
