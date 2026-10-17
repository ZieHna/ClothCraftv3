# Remove everything the demand simulation created from ONE database. Not run on install or update.
#
# Feed it to `odoo shell` (PowerShell, from the repo root):
#   Get-Content scripts/purge_sim.py | docker compose run --rm --no-deps -T odoo odoo shell -d clothcraft_sim --no-http
# Options (environment): SIM_DRY_RUN=1 (roll back at the end), SIM_BACKUP=<pg_dump file> (required for a database
# named "clothcraft"; clothcraft_usd_old is always refused). Safe to run twice: the second run deletes nothing.
import os

from odoo.addons.clothcraft.sim import purge, seeder

seeder.check_target(env, os.environ.get('SIM_BACKUP'))
deleted = purge.purge(env)
print('SIM PURGED', sum(deleted.values()), 'rows in', len(deleted), 'tables', deleted)
if os.environ.get('SIM_DRY_RUN') == '1':
    env.cr.rollback()
    print('SIM dry run: rolled back')
else:
    env.cr.commit()
    print('SIM committed')
