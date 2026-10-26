# Prepares a database for the storefront API service. Idempotent. Run it on a DEVELOPMENT copy (clothcraft_dev, never
# clothcraft_sim or the live clothcraft):
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm --no-deps -T -v ./backend:/out \
#       -e API_KEY_OUT=/out/.env odoo odoo shell -d clothcraft_dev --no-http < scripts/create_api_user.py
# It makes sure of the service user api_shop: an internal user in ONE ClothCraft group (clothcraft.group_api), never an
# administrator. Customers are not made here: they register through the shop (clothcraft.api.auth_register).
# With API_KEY_OUT set it also replaces the user's API key with a new one (the old one stops working) and writes
# ODOO_API_KEY=... to that file (a gitignored .env), keeping every other line in it (and making a SESSION_SECRET if there is none).
# The .env holds ONE key: the key of the database the service points at (clothcraft_shop from step 8b). Neither value is ever printed.
import datetime
import os
import secrets

from odoo import Command

LOGIN = 'api_shop'
if env.cr.dbname in ('clothcraft', 'clothcraft_sim', 'clothcraft_usd_old'):
    raise SystemExit(f'refusing to prepare the service user in {env.cr.dbname}')

group_api = env.ref('clothcraft.group_api')
user = env['res.users'].search([('login', '=', LOGIN)], limit=1)
if not user:
    user = env['res.users'].create({
        'name': 'Storefront API service', 'login': LOGIN,
        # internal user (base.group_user) plus the one ClothCraft service group; nothing else
        'group_ids': [Command.set([env.ref('base.group_user').id, group_api.id])],
    })

out = os.environ.get('API_KEY_OUT')
if out:
    env.cr.execute("DELETE FROM res_users_apikeys WHERE user_id = %s AND name = 'storefront-api'", [user.id])
    # a key that lasts 89 days, the longest an internal user's own group allows; rotate by running this again
    expires = datetime.datetime.now() + datetime.timedelta(days=89)
    key = env['res.users.apikeys'].with_user(user).sudo()._generate(None, 'storefront-api', expires)
    # every other line of the file is kept (the session secret, the staff test users, the shop's settings); only the key is replaced
    keep = []
    if os.path.exists(out):
        with open(out) as handle:
            keep = [line.rstrip(chr(10)) for line in handle if not line.startswith('ODOO_API_KEY=')]
    if not any(line.startswith('SESSION_SECRET=') for line in keep):
        keep.append('SESSION_SECRET=' + secrets.token_urlsafe(48))
    with open(out, 'w') as handle:
        handle.write(chr(10).join(['ODOO_API_KEY=' + key] + [line for line in keep if line]) + chr(10))
env.cr.commit()
print('API USER READY', user.login, 'groups:', sorted(user.group_ids.mapped('name')), '| key replaced' if out else '| key untouched')
