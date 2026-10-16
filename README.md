# ClothCraft v3 (backend)

Custom Odoo 19.0 module in Docker. Images: `odoo:19.0-20261015`, `postgres:16`.

## First-time setup (PowerShell, from this folder)

```powershell
Copy-Item .env.example .env     # then edit .env and set a real POSTGRES_PASSWORD
```

## Commands

| Task | Command |
|---|---|
| Build and start (foreground) | `docker compose up --build` |
| Start in background | `docker compose up -d` |
| Stop (keeps data) | `docker compose down` |
| View logs | `docker compose logs -f odoo` |
| Open Odoo | http://localhost:8069 |
| **Full reset (deletes all databases and files)** | `docker compose down -v` |

After a full reset, run `docker compose up --build` again for a clean start.

## Install / update the module and run tests

The web service is stopped first so it doesn't clash with the one-off container.

```powershell
docker compose stop odoo
# install (first time)
docker compose run --rm --no-deps odoo odoo -d clothcraft -i clothcraft --stop-after-init
# update + run only the clothcraft tests
docker compose run --rm --no-deps odoo odoo -d clothcraft -u clothcraft --test-tags /clothcraft --stop-after-init
docker compose up -d odoo
```

Success looks like `0 failed, 0 error(s) of N tests when loading database`.

## Notes

- Never commit `.env`. It is gitignored; `.env.example` holds the placeholders.
- The Odoo master password is set in the web form when you create the first database. It is not stored in any file here.
- Custom modules go in `addons/`.
