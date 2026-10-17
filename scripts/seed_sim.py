# Seed the demand simulation into ONE database. Not run on install or update.
#
# Feed it to `odoo shell` (PowerShell, from the repo root), with the assets folder mounted read-only and an
# output folder for lost_demand.csv:
#   Get-Content scripts/seed_sim.py | docker compose run --rm --no-deps -T `
#       -v "${PWD}/assets-v1:/mnt/assets-v1:ro" -v "${PWD}/seed_output:/mnt/sim-out" `
#       -e SIM_PRESET=small -e SIM_SEED=7 odoo odoo shell -d clothcraft_sim --no-http
# Options (environment): SIM_PRESET small|full, SIM_SEED, SIM_ASSETS, SIM_OUT (folder for lost_demand.csv),
# SIM_DRY_RUN=1 (roll back at the end), SIM_BACKUP=<pg_dump file> (required to seed a database named
# "clothcraft"; clothcraft_usd_old is always refused).
import os
import time

from odoo.addons.clothcraft.sim import seeder

began = time.monotonic()
result = seeder.run(
    env, preset=os.environ.get('SIM_PRESET', 'small'), seed=int(os.environ.get('SIM_SEED', '7')),
    assets_dir=os.environ.get('SIM_ASSETS', '/mnt/assets-v1'), backup=os.environ.get('SIM_BACKUP'),
    out_dir=os.environ.get('SIM_OUT', '/mnt/sim-out'))
result.pop('simulation')
result.pop('world')
print('SIM RESULT', result)
print('SIM elapsed %.1fs' % (time.monotonic() - began))
if os.environ.get('SIM_DRY_RUN') == '1':
    env.cr.rollback()
    print('SIM dry run: rolled back')
else:
    env.cr.commit()
    print('SIM committed')
