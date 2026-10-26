# Creates two STAFF TEST USERS on a development database, for trying the staff dashboard: one Inventory Staff and one ClothCraft
# Administrator (never an Odoo system administrator). Idempotent. Run it on clothcraft_dev or a throwaway copy, never on clothcraft_sim
# or the live clothcraft:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm --no-deps -T -v ./backend:/out \
#       -e STAFF_OUT=/out/.env odoo odoo shell -d clothcraft_dev --no-http < scripts/create_staff_users.py
# With STAFF_OUT set it (re)sets both passwords to new random ones and writes STAFF_INVENTORY_EMAIL / _PASSWORD and STAFF_ADMIN_EMAIL /
# _PASSWORD into that file (a gitignored .env), keeping every other line. The passwords are never printed.
import os
import secrets

from odoo import Command

if env.cr.dbname in ('clothcraft', 'clothcraft_sim', 'clothcraft_usd_old'):
    raise SystemExit(f'refusing to create test staff in {env.cr.dbname}')

PEOPLE = [
    ('INVENTORY', 'Staff Inventory (test)', 'staff.inventory@clothcraft.test', 'clothcraft.group_inventory'),
    ('ADMIN', 'Staff Administrator (test)', 'staff.admin@clothcraft.test', 'clothcraft.group_admin'),
]
out = os.environ.get('STAFF_OUT')
lines = {}
for key, name, login, group in PEOPLE:
    user = env['res.users'].search([('login', '=', login)], limit=1)
    groups = [Command.set([env.ref('base.group_user').id, env.ref(group).id])]
    if not user:
        user = env['res.users'].create({'name': name, 'login': login, 'email': login, 'group_ids': groups})
    password = secrets.token_urlsafe(18)
    if out:
        user.password = password
        lines[f'STAFF_{key}_EMAIL'] = login
        lines[f'STAFF_{key}_PASSWORD'] = password
if out:
    kept = []
    if os.path.exists(out):
        with open(out) as handle:
            kept = [line.rstrip('\n') for line in handle if line.split('=', 1)[0] not in lines]
    with open(out, 'w') as handle:
        handle.write('\n'.join(kept + [f'{k}={v}' for k, v in lines.items()]) + '\n')
env.cr.commit()
print('STAFF USERS READY', [login for _k, _n, login, _g in PEOPLE], 'passwords replaced' if out else 'passwords untouched')
