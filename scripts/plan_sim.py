"""Planning pass: run the whole simulation in memory (no database, no Odoo) and report lost demand.

    python scripts/plan_sim.py [small|full] [seed]

It uses the same decision code as the database run (sim/loop.py) with the in-memory stock world, so you can tune
the full preset in seconds. Tests check that it agrees with the database run.
"""
import datetime as dt
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'addons' / 'clothcraft'))

from sim import demand  # noqa: E402
from sim.data import PRESETS  # noqa: E402
from sim.loop import Simulation  # noqa: E402
from sim.variants import opening_plan, variant_table  # noqa: E402
from sim.world import MemWorld  # noqa: E402


def plan(preset='full', seed=7):
    cfg = dict(PRESETS[preset])
    customers = demand.plan_customers(cfg, seed)
    arrivals = demand.plan_arrivals(cfg, customers, seed)
    priors = demand.priors(cfg, demand.count_orders(arrivals), variant_table(cfg['products']))
    world = MemWorld()
    opening = opening_plan(cfg, seed, priors)
    for entry in opening:
        for code, qty in entry['lines']:
            world.add_stock(code, qty)
    simulation = Simulation(world, cfg, seed, customers, arrivals, priors)
    simulation.run()
    return cfg, simulation, opening


def report(preset='full', seed=7):
    cfg, simulation, opening = plan(preset, seed)
    share = simulation.lost_share()
    result = simulation.result()
    print(f"preset={preset} seed={seed}: {result['orders']} orders, {result['lines']} lines, {result['units']} units sold, "
          f"{result['purchase_orders']} purchase orders, {result['receipts']} receipts")
    print(f"cancelled {result['cancelled']} (customer {result['cancelled_customer']}, staff {result['cancelled_staff']}), "
          f"stuck {result['stuck']}, delivered {result['deliveries']}, guard refusals {result['guard_refusals']}")
    print(f"lost units: net {share['lost_units_net']} of {share['sold_units'] + share['lost_units_net']} wanted "
          f"= {share['net_share']:.1%} (gross at variant level {share['lost_units_gross']}, substitutions {result['substitutions']})")
    months = sorted({m for m, _k in share['sold']} | {m for m, _k in share['lost']})
    print("lost share by month (gross lost / (sold + gross lost)):")
    for month in months:
        sold = sum(v for (m, _k), v in share['sold'].items() if m == month)
        lost = sum(v for (m, _k), v in share['lost'].items() if m == month)
        print(f"  {month}: sold {sold:5.0f}  lost {lost:4.0f}  {lost / max(1, sold + lost):6.1%}")
    by_product = defaultdict(lambda: [0.0, 0.0])
    for (_m, key), v in share['sold'].items():
        by_product[key][0] += v
    for (_m, key), v in share['lost'].items():
        by_product[key][1] += v
    weeks = defaultdict(float)
    for day, _code, wanted, free in simulation.lost:
        weeks[day - dt.timedelta(days=day.weekday())] += wanted - min(wanted, free)
    total_lost = sum(weeks.values()) or 1
    worst = sorted(weeks.items(), key=lambda kv: -kv[1])
    print(f"lost units sit in {len(weeks)} distinct weeks; the worst 8 weeks hold {sum(v for _w, v in worst[:8]) / total_lost:.0%}: "
          + ", ".join(f"{w:%Y-%m-%d} ({v:.0f})" for w, v in worst[:8]))
    print("lost share by product (sold, lost, share):")
    for key, (sold, lost) in sorted(by_product.items(), key=lambda kv: -kv[1][1] / max(1, kv[1][0] + kv[1][1])):
        print(f"  {key:7s} {sold:6.0f} {lost:5.0f}  {lost / max(1, sold + lost):6.1%}")
    return simulation


if __name__ == '__main__':
    report(sys.argv[1] if len(sys.argv) > 1 else 'full', int(sys.argv[2]) if len(sys.argv) > 2 else 7)
