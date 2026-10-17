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

## Create a Philippine (PHP, VAT 12%) database

The shop runs on PHP with VAT 12% included in retail prices. A database must be set up in this
order, because the chart of accounts is chosen from the company country the moment `account` is
installed (and the company currency cannot be changed cleanly once entries exist):

```powershell
docker compose stop odoo
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" -E UTF8 -T template0 clothcraft_ph'
# 1. base only
docker compose run --rm --no-deps odoo odoo -d clothcraft_ph -i base --stop-after-init --without-demo=True
# 2. company -> Philippines / PHP (before account is installed)
Get-Content config/set_ph_company.py | docker compose run --rm --no-deps -T odoo odoo shell -d clothcraft_ph --no-http
# 3. ClothCraft (pulls in account -> l10n_ph, the PH chart and the 12% VAT)
docker compose run --rm --no-deps odoo odoo -d clothcraft_ph -i clothcraft --stop-after-init --without-demo=True
```

ClothCraft then makes the 12% sale tax price-included (`price_include_override = tax_included`), so a
350.00 price is 312.50 untaxed + 37.50 VAT. Check with: `select amount, price_include_override from
account_tax where id = 1;`.

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

### Run the tests on a throwaway database (recommended)

Tests never touch the live `clothcraft` database this way. The throwaway database must be set up
for the Philippines (steps above) or the VAT tests fail. The first install takes about 4 minutes;
later runs with `-u` take about 30 seconds.

```powershell
docker compose stop odoo
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" -E UTF8 -T template0 clothcraft_test'
docker compose run --rm --no-deps odoo odoo -d clothcraft_test -i base --stop-after-init --without-demo=True
Get-Content config/set_ph_company.py | docker compose run --rm --no-deps -T odoo odoo shell -d clothcraft_test --no-http
docker compose run --rm --no-deps odoo odoo -d clothcraft_test -i clothcraft --test-tags /clothcraft --stop-after-init --without-demo=True
# after code changes:
docker compose run --rm --no-deps odoo odoo -d clothcraft_test -u clothcraft --test-tags /clothcraft --stop-after-init
# when finished:
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" clothcraft_test'
docker compose up -d odoo
```

### Upgrade the live database after pulling new module code

The module adds columns (for example `garment_type_id` on products), so the live database must be
upgraded before the web service is started with new code:

```powershell
docker compose stop odoo
docker compose run --rm --no-deps odoo odoo -d clothcraft -u clothcraft --stop-after-init
docker compose up -d odoo
```

## Simulated data (B7)

A reproducible simulation of 18 months of shop activity, to give the demand forecast, restock and customer
segments (B8) something realistic to work on: about 19 garment products with Color x Size variants, 6 fake
suppliers, several hundred purchase orders and receipts with lots, 560 fake portal customers and about 2,200 orders
(cash on delivery and bank transfer; most delivered, some cancelled, a few unpaid transfers left stuck), with
seasonality, weekday and payday effects, promotions, supplier outages and real stock-outs. Everything goes through
Odoo's normal purchase, sale, delivery and payment flows, so the B6 stock guard runs on every sale and is never
bypassed. Demand the shop cannot serve is not recorded as an order; it is written to `lost_demand.csv`
(date, variant, wanted, free).

- **Labelled and removable.** Every simulated record carries the label "Simulated" (partner category, product
  tag, sale-order tag), lots start with `SIM-`, purchase orders have origin `SIM`; names are invented and emails
  are on `example.com`. One command removes all of it (below).
- **Never runs by itself.** The code is in `addons/clothcraft/sim/`; nothing imports it on install or `-u`.
- **Reproducible.** The same preset and seed always give the same data; the run prints a digest you can compare.
- **Dates.** Orders, receipts, deliveries, moves, payments, `create_date` and `write_date` carry the simulated
  dates (Odoo cannot freeze `create_date`; a final SQL pass stamps it).

### Plan a run in seconds (no database)

```powershell
docker run --rm -v "${PWD}:/repo:ro" python:3.12-slim python /repo/scripts/plan_sim.py full 7
```

Prints orders, cancellations, purchase orders and the share of demand lost, per month and per product.

### Seed a database

Use a **fresh** database with the Philippine setup (see above; for example `clothcraft_sim`), and stop the web
service first, because its background jobs also work on every database and can collide with a long run. A full
run takes roughly 25 minutes on a fresh database.

```powershell
docker compose stop odoo
Get-Content scripts/seed_sim.py | docker compose run --rm --no-deps -T `
    -v "${PWD}/assets-v1:/mnt/assets-v1:ro" -v "${PWD}/seed_output:/mnt/sim-out" `
    -e SIM_PRESET=full -e SIM_SEED=7 odoo odoo shell -d clothcraft_sim --no-http
docker compose up -d odoo
```

| Variable | Meaning |
|---|---|
| `SIM_PRESET` | `tiny` (tests), `small` (a quick look, deliberately starved of stock) or `full` (18 months). Default `small`. |
| `SIM_SEED` | Random seed. Default `7`. |
| `SIM_ASSETS` | Where the product images are mounted. Default `/mnt/assets-v1`. |
| `SIM_OUT` | Folder for `lost_demand.csv` (mount it, as above). Default `/mnt/sim-out`; without the mount no CSV is written. |
| `SIM_DRY_RUN=1` | Roll back at the end instead of committing. |
| `SIM_BACKUP` | A `pg_dump` file you just took (path as seen inside the container). **Required** to seed a database named `clothcraft`; `clothcraft_usd_old` is always refused. |

A second run on a seeded database is refused until you purge it. Check the result with
`Get-Content scripts/verify_sim.sql | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d clothcraft_sim'`.

### Remove the simulated data

```powershell
docker compose stop odoo
Get-Content scripts/purge_sim.py | docker compose run --rm --no-deps -T odoo odoo shell -d clothcraft_sim --no-http
docker compose up -d odoo
```

Deletes exactly what the seed created (the tests prove every table returns to its pre-seed row count) and nothing
else; running it twice is harmless. It does not reset ids or number sequences, and it leaves the Wire Transfer
payment provider enabled (the simulation needs it). Dropping the database is the other clean way out.

### Warnings

- **Never seed or purge the live `clothcraft` database without a fresh backup.** The runner refuses without one.
- The simulation tests (`tests/test_sim.py`) are for throwaway databases only. They roll back, but they run heavy
  SQL, freeze the clock and enable the Wire Transfer provider, and they skip themselves on a protected database.
- The data is invented. Seasonality, payday effects, promotions and outages are assumptions, so a forecast's
  accuracy on this data demonstrates the method, not real-world accuracy.

## Notes

- Never commit `.env`. It is gitignored; `.env.example` holds the placeholders.
- The Odoo master password is set in the web form when you create the first database. It is not stored in any file here.
- Custom modules go in `addons/`.
