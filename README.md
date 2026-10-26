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

**Module 19.0.1.1.0 (step 8b)** adds the storefront fields to products (Shop group, Storefront id, Featured on the shop) and a migration
that fills them for the garments already there, from their SKUs. It has been run on `clothcraft_dev` only; `clothcraft_sim` and the live
`clothcraft` are still on 19.0.1.0.0. Upgrading either later runs the same migration (take a backup first).

## A clean shop database: `clothcraft_shop` (step 8b)

The shop's own catalogue with **no simulated data**: the 19 garments of `addons/clothcraft/sim/data.py` (Men, Women, Kids, Babies) with
their 246 Color x Size variants, pictures, prices, cost, the storefront fields, and a starting stock; no suppliers, purchase orders, customers,
orders, simulation tag or simulation marker (so the API answers `simulation: null` and the shop shows no "Simulated" label). SKUs have no
`SIM-` prefix (`M-TEE-BLK-S`). The dev stack serves it (`docker-compose.dev.yml`, `DEV_DB`, default `clothcraft_shop`).

```powershell
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" -E UTF8 -T template0 clothcraft_shop'
docker compose run --rm --no-deps odoo odoo -d clothcraft_shop -i base --stop-after-init --without-demo=True
Get-Content config/set_ph_company.py | docker compose run --rm --no-deps -T odoo odoo shell -d clothcraft_shop --no-http
docker compose run --rm --no-deps odoo odoo -d clothcraft_shop -i clothcraft --stop-after-init --without-demo=True
Get-Content scripts/seed_catalogue.py | docker compose run --rm --no-deps -T -v "${PWD}/assets-v1:/mnt/assets-v1:ro" odoo odoo shell -d clothcraft_shop --no-http
# the service user's key, then the two staff test users (in this order: both write the gitignored backend/.env, never print a secret)
Get-Content scripts/create_api_user.py | docker compose run --rm --no-deps -T -v "${PWD}/backend:/out" -e API_KEY_OUT=/out/.env odoo odoo shell -d clothcraft_shop --no-http
Get-Content scripts/create_staff_users.py | docker compose run --rm --no-deps -T -v "${PWD}/backend:/out" -e STAFF_OUT=/out/.env odoo odoo shell -d clothcraft_shop --no-http
```

- `seed_catalogue.py` refuses any database other than `clothcraft_shop` or a throwaway copy named `clothcraft_shop_<name>`, and one that
  already has garments, orders or the simulation marker.
- **Starting stock:** more of the best sellers and the middle sizes (5 to 29 a variant); a few sizes start low (Men Tank Top XL at 2, Women Polo
  XS at 3) and one starts sold out (Kids Jacket XS), so the shop shows both. One opening lot per variant.
- **Catalogue management** is done in Odoo's own product and inventory screens (the product form has the Storefront fields under the
  category). The Storefront id cannot change once a product has been ordered. What the staff test users can do there is checked by
  `scripts/check_catalogue_rights.py` (on a throwaway copy).
- Take a dump into `backups/` (gitignored) after seeding and verify it with `pg_restore --list`.

## Customized garments (step 9)

A customer's design is uploaded to Odoo (`clothcraft.design`, attachments never public) and priced there; the shop's figure is Odoo's,
the editor's is an estimate made with the same rule (`addons/clothcraft/design_fee.py` and `frontend/src/pricing/designFee.ts`, both run
against `addons/clothcraft/data/design_area_cases.json`).

- **The fee per piece** = covered area in square inches × the rate + the size step × the size's steps (XS and S 0, M 1, L 2, XL 3, XXL 4),
  rounded to the centavo; nothing when no element lands on the garment. Every element is priced by its **rotated bounding box**
  (a text's box is taller than its letters: about 1.6 times their own rectangle); overlaps count once; only what lands on the garment's
  print box counts. VAT 12% included. The XXL surcharge stays on the garment's price.
- **Settings:** ClothCraft › Configuration › Customization pricing (rate, size step; ClothCraft Administrator only, Inventory Staff can
  read). Each garment type has *Print area at size Small* (default 200 sq in). Each garment has a **print box** (General Information tab),
  measured from its pictures by `frontend/scripts/measure-garment-bounds.mjs` into `addons/clothcraft/data/garment_bounds.json`; the 19.0.1.2.0
  migration and `seed_catalogue.py` copy it in. **No box, no customizing**: the API says the garment cannot be customized and the
  product form shows a warning.
- **On an order** a customized garment is two lines: the garment (with its design) and right after it one line of the service product
  **Customization fee**, same quantity, the fee as its price, with the area, rate, size step and steps it was priced with. Changing the
  garment line's quantity in the Odoo screens changes its fee line too. An ordered design never changes.
- **Leave the Customization fee product out of demand forecasts and restock figures**: it is a service, not stock, and its quantities
  repeat the garment lines'. Any future forecast must filter it out (it is the product with the XML id `clothcraft.product_customization_fee`).
- **Clean-up:** a daily job deletes drafts unused for 30 days and removed designs after a day, never one on an order.
- **In the shop:** the Design page shows the estimate ("Every element is priced by the rectangle around it") and "Add this customization
  to cart" / "Proceed to checkout" (on a phone, a row in the bottom bar). The cart shows the shop's figure, and a note when the editor's
  estimate differed; "Edit design" opens the design again and replaces it in the cart. The VAT line is shown at checkout and on the order
  only. Slanting is off in the editor; an old draft or design with slanted elements opens straightened, with a note.

## Order tracking (step 11)

`sale.order.clothcraft_state` (addons/clothcraft/models/order_flow.py) now runs
`awaiting_payment -> confirmed -> shipped -> out_for_delivery -> delivered -> closed`, or `cancelled` before shipped. The customer sees
four steps with the time each was reached (1 received and preparing, 2 shipped out, 3 on delivery, 4 delivered) and, once delivered,
confirms they received it, which closes the order. `packed` is no longer a step (it folds into step 1).

- **Who moves it.** Staff forward one step at a time; an Administrator back one step with a note where nothing native has to be undone
  (out for delivery -> shipped, delivered -> out for delivery for a bank transfer only, closed -> delivered); the customer from delivered
  to closed (`POST /api/orders/{id}/received`, owner only); a daily job closes a delivered order N days after delivery
  (Sales > Settings > "Close delivered orders after", default 7, 0 = off). Each move writes one history line naming WHO by kind:
  staff, customer, automatic or Odoo, kept apart by database checks.
- **Native effects, unchanged.** Stock leaves at shipped (the delivery is validated); cash on delivery becomes paid at delivered, which
  also locks the order; out for delivery and closed change neither stock nor payment.
- **Changed from step 7:** a delivery validated in the Odoo screens now reads as **shipped** (the goods left), not delivered.
- **Migration 19.0.1.3.0** (clothcraft_dev and clothcraft_shop only, after a verified dump): delivered -> closed, packed -> confirmed;
  only real orders (without the simulation's "Simulated" tag) get an automatic history line.

**For B8 (the DSS): read native facts, not `clothcraft_state`.** Demand, restock and segment queries must use what Odoo itself records:
`sale.order.state` (sale / cancel), `date_order`, the order lines, `stock.picking` (`state = 'done'`, `date_done`) for what left, and
`payment.transaction.state` for what was paid. `clothcraft_sim` has **no** `clothcraft_state` column (it was seeded before step 7 and is
never upgraded), and the meaning of the field changed in step 11, so a query on it would not run on the simulated data and would not
mean the same thing over time.

## Saved cart (step 12)

In the real shop a customer's cart is kept on the server under their account (`clothcraft.cart`, `clothcraft.cart.line`:
addons/clothcraft/models/cart.py), so it follows them to any device and survives sign-out; the frozen mock keeps its browser cart.

- **What it holds:** lines of (variant, design or none) with a quantity (1-99) and a "ticked" flag, at most 50 lines; no prices (the
  quote prices it every time). A design must be the customer's own, for that garment. A deleted design takes its line with it.
- **Writing:** `PUT /api/cart` sends the whole cart with the version the browser last saw. Odoo locks the cart row; another version is
  409 `cart_conflict` with the cart as it is now (the browser merges its own edits into it). The same write again is 200. The body is
  capped at 32 KB and writes are limited to 120 a minute per session. Only a customer session opens it.
- **Orders:** placing an order takes exactly what it ordered off the cart in the same transaction (a refused order changes neither).
- **Expiry:** a daily job removes carts untouched for N days (Sales > Settings > "Remove saved carts", default 60, 0 = keep) and voids
  the draft designs only they used. The design clean-up never deletes a design that is in a cart.
- **Rights:** Administrator may read carts; nobody writes them except the facade (`clothcraft.api.cart_put` / `place_order`).
- **Proof of the lock:** `scripts/check_cart_race.py` (two real connections, a throwaway copy only).
- **In the browser** (frontend/src/cart/cartStore.ts, merge.ts): the page keeps a copy (`cc.cart.v2:<customer id>` in localStorage)
  so it answers at once, and saves a moment after the last edit (at most 3 s). On a 409 it merges three ways (what both started from,
  this device's edits, the newer cart: an edit is never dropped, a tick alone never brings back a removed line) and saves again. An
  edit that cannot be saved stays on the device, the page says "You're offline…", and it is retried (on reconnect, on focus, with
  growing pauses); a page being closed sends its last edits with keepalive. While the cart loads, the cart page says "Loading your
  cart…" and the badge shows no number. Sign-out saves first, asks "Some cart changes couldn't be saved. Sign out anyway?" if it
  cannot, and warns about unfinished designs on the device (which sign-out deletes). The first sign-in after this step adds the
  old browser cart (`cc.cart.v1:<id>`) to the account's (never overwriting it), then removes the old copy; copies of customers who
  have not signed in on that browser for 30 days are removed. Proof in real Edge: `frontend/scripts/check-cart-real.mjs`.

**For B8 (abandoned carts):** the saved cart is the first record of what customers meant to buy and did not: lines that stay in a cart
(and are taken off only by an order or by the expiry) can feed an abandoned-cart analysis next to the demand forecast. Read it as it is:
`clothcraft_cart.write_date` is the last change, a line's quantity is the shopper's intention (not a reservation: carts hold no stock),
and an expired cart is deleted, so measure before the expiry or keep a snapshot. `clothcraft_sim` has no carts.

## Suppliers (Supplier and Restock, phase 1)

Real suppliers live in `clothcraft.supplier` (addons/clothcraft/models/supplier.py), each tied to one `res.partner`, the key that
purchase orders, receipts and the DSS use. The simulation's suppliers are only partners with `product.supplierinfo` rows and stay that
way (`clothcraft_sim` is untouched); join both kinds on the partner.

- **Holds:** company, contact, address, optional phone, shipping on/off with a flat amount per restock, supply lines (garment type x
  size x colour with a unit cost, the size and colour must exist on that garment type's variants), and unavailable date ranges. A
  supplier is available now unless it is inactive, permanently off, or today (Manila) is inside a range; `available_now` is worked out
  on every read, never stored.
- **VAT:** entered prices include 12%. `money.vat_split(amount)` is the only place that extracts it (vat = amount x 12/112, net = the rest).
- **Rights:** Inventory Staff add and edit suppliers, lines and ranges (only while the supplier is active and not switched off); only
  the Administrator deactivates, reactivates, or switches a supplier off or on. Nobody deletes a supplier. The staff API
  (`clothcraft.api`: `staff_suppliers`, `staff_supplier`, `supplier_*`) writes with sudo after checking the role, and records who did it
  in `last_edited_by` / `last_edited_at`.
- **Not yet:** stock edits, thresholds and notifications (later phases).

### Restocks (Supplier and Restock, phase 2)

A restock (`clothcraft.restock`, models/restock.py; staff API in models/api_restock.py) asks one available supplier for lines of
(variant, quantity, unit cost copied from the supply line and editable), with shipping on or off and an expected arrival range. All entered
prices include 12% VAT.

- **States:** `requested` -> `approved` or `rejected` (final, a note is needed); `approved` -> `received` or `not_received`;
  `not_received` -> `received`. Inventory Staff create a request and change it while it is `requested` (no cancel: the Administrator
  rejects); only the Administrator approves, rejects, receives or marks not received. Every change is a line in
  `clothcraft.restock.history`, append only (the ORM and a database trigger refuse changes). A restock is never deleted.
- **Receiving** (once, all or nothing, ticket row locked): a native stock receipt (`stock.picking` from the supplier location into the
  warehouse, no purchase order), so the stock moves are real and count as supplier receipts for the DSS. The garments are lot-tracked, so
  each received line gets one lot, named `<ticket>-<SKU>` unless the Administrator types a name for it; a name that already exists for
  that product is refused. A short quantity per line is allowed (no backorder). The ticket records the ACTUAL COST = unit cost x received
  quantity + the flat shipping (only if shipping is on for the request and the supplier ships), split once by `money.vat_split`. Profit
  must use this recorded cost, never Odoo's product cost. A ticket received after the end of its range is flagged late (Manila date).
- **Supplier total spent** counts received restocks only (VAT-inclusive, VAT, net).
- **Product cost:** the garment category is on Standard Price (migration 19.0.1.6.0 switches it from Average; the garments have no cost, and
  under standard costing receipts never touch `standard_price`). A receipt that would change a product's cost is refused. A database seeded
  by `scripts/seed_catalogue.py` still creates the category with Average costing: switch it to Standard Price before receiving stock.

### Stock edits, low-stock levels and the bell (Supplier and Restock, phase 3)

All in addons/clothcraft/models/stock_alert.py; the staff API is models/api_stock.py and models/api_notification.py.

- **Stock edit** (`stock_set`): Inventory Staff or the Administrator set a variant's on-hand quantity with a reason (5 to 500 characters).
  It uses Odoo's own inventory adjustment, so real stock moves exist; it is all or nothing, serialised per variant, and it never changes
  `standard_price` (a guard rolls the edit back if it would). The garments are lot-tracked: a decrease takes from the oldest lots first, an
  increase goes into one adjustment lot per variant per day (`ADJ-<SKU>-<YYYYMMDD>`). No negative numbers, no same number, and not below
  what orders have reserved. Every edit is a row in `clothcraft.stock.edit`, append only (ORM, database trigger and read-only rights);
  an adjustment made in the Odoo screens is written there too with a generic reason.
- **Low-stock levels:** one global level (default 5, the Administrator's) and an optional override per variant. A variant is low when its
  on-hand quantity is strictly below its effective level; a level of 0 never makes it low. Changing a level re-checks every variant
  silently.
- **Once per drop:** `stock.move._action_done` re-checks the garment variants a move changed (only moves that cross the internal boundary;
  it never raises into a checkout, shipment or receipt). The Administrators get one notification when a variant drops below its level; it
  is re-armed when the variant goes back up. Lock order everywhere: the product advisory lock first, then the alert row. The simulation
  seeder sets `clothcraft_no_alerts` (sim/util.py `quiet`) so seeding writes no history and sends no alerts.
- **The bell** (`clothcraft.notification`, in-app only): one row per person, with a read time. Administrators hear of a new restock request,
  a supplier made unavailable by an employee, and a low-stock drop; the employee who asked hears when a restock is approved, rejected,
  received or marked not received. Nobody is told about their own action. A person reads only their own rows; marking read goes through
  the API. A daily job removes notifications older than N days (Settings, default 60, 0 keeps them).

### Admin restock actions, levels, bell and the earnings rule (Supplier and Restock, phase 8)

- **Admin screens (`/admin`).** The restock detail page (`/admin/restocks/:id`) has Approve, Reject (a note of 5 to 500 characters, the
  server's rule), Receive (received quantity per line, an optional typed lot name per line, an optional arrival day, a note) and "Did not
  receive on the expected date"; a not-received ticket can still be received later and then reads "Received, late". The stock page
  (`/admin/stock`) has the shop-wide low-stock level and a level of a variant's own. Each action asks first; the server's sentences are shown
  as sent. These controls are drawn only inside the admin workspace, and the server checks the Administrator role on every call anyway.
  The bell at the top of `/admin` is the same bell as `/staff`, over `/api/admin/notifications` (the admin cookie); it shows the signed-in
  person's own rows, so an account that signs in at both doors sees one set of notifications and one read state.
- **Earnings rule (phase 8).** *Earned* revenue is **Closed** orders only (the customer confirmed, or the shop closed the order by itself
  after the auto-close days), counted in the Manila month the order **closed**: its latest `closed` line in the order history. An order with no
  `closed` line (a simulated order migrated to closed) falls back to its latest `delivered` line, then to the day it was placed.
  *Delivered, awaiting confirmation* is a separate figure and chart series (by the month it was delivered); it is **not** earnings and is never
  added to them. VAT and net come from the one `vat_split` helper, order by order; the browser adds no money. **Earnings, profit and cash flow
  in phase 9 count Closed orders only.**

### Employee management (admin dashboard, step 7c, module version 19.0.1.10.0)

`/admin/employees` (Administrator only; the routes exist only under `/api/admin`, never under `/api/staff`). All rules are Odoo's
(`models/api_employee.py`); the screen only mirrors them.

- **Who is an employee.** An internal Odoo user in the Inventory Staff or Administrator group. Never listed or touched (they answer 404): the
  superuser, Odoo's base `admin`, anyone holding the Settings (system) group, the storefront API service, customers (portal users).
- **Rules.** You cannot deactivate, demote, reset the password of, or change the email of your own account. The last active managed Administrator
  can never be deactivated or demoted (counted on a fresh connection while an advisory lock is held, because Odoo's own transaction works on an
  older snapshot). The email is unique across all users, in lower case. A role change, a deactivation and a password reset end the person's
  sessions at once, in every scope. Nothing is ever deleted.
- **Passwords.** Typed by the Administrator, 12 to 128 characters, not a common password, not one repeated character, not containing the person's
  email or name. Odoo hashes it; it is in no reply, audit line, notification or log. No "your password changed" mail is sent (context flag
  `clothcraft_no_security_mail`). These actions never count toward sign-in throttling.
- **History.** `clothcraft.employee.audit` is append only (ORM refusal, database trigger on UPDATE and DELETE, read-only access for Administrators
  only) and records non-secret old/new values only. Existing order, restock and stock history keep the staff name as it was written, so a rename
  changes nothing already recorded. Because of the trigger, a user who has history lines cannot be hard-deleted; deactivate instead.
- **If every managed Administrator is lost** (all deactivated or demoted by mistake outside the dashboard, or the passwords are gone), the
  dashboard cannot help, because it needs an Administrator to sign in. Recover with Odoo, signing in as the base `admin` user at `/odoo`
  (Settings > Users and Companies > Users): open the person, tick **Activate** (or unarchive), and under *ClothCraft* set the role to
  *Administrator*, then use *Action > Change Password*. Or from a shell, on the database that needs it (the password is typed in the shell and not
  kept anywhere):

  ```powershell
  docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm --no-deps odoo odoo shell -d clothcraft_shop --no-http
  # then, in the shell:
  #   u = env['res.users'].with_context(active_test=False).search([('login', '=', 'person@example.com')])
  #   u.active = True; u.group_ids = [(4, env.ref('clothcraft.group_admin').id)]; u.password = '<new password>'
  #   env.cr.commit()
  ```

- **Not yet.** A person changing their own password, and "change at next sign-in", are future steps: Odoo has no such flag, so they need a flag
  on the user, a sign-in reply that carries it, and a self-service change-password call and page at both doors. Until then a temporary password
  stays valid until an Administrator resets it.

### Customer management (admin dashboard, step 7d, module version 19.0.1.11.0)

`/admin/customers` (Administrator only; the routes exist only under `/api/admin`). All rules are Odoo's (`models/api_customer.py`).

- **Who is a customer.** A portal user (`base.group_portal`). Never listed or touched (404): the public user, the portal template, each website's
  public user, anyone holding a staff, internal or API group. Customers register themselves in the shop; there is no "add a customer".
- **Figures.** Orders placed (cancelled included); total spent = Closed orders only, VAT included; "Delivered, awaiting confirmation" is a separate
  figure on the detail page and never part of total spent. The list carries no phone and no address; the detail adds the phone, last sign-in,
  recent orders and counts (unpaid orders, cart lines, draft designs). Delivery addresses are not shown in this step.
- **Edit.** Name, email and phone only; a password can be neither seen nor set (no route takes or returns one). The email is the sign-in name:
  it is unique across all users in lower case, checked under the same lock as registration; changing it ends the customer's sessions (they sign
  in with the new email and the same password) and sends no mail. Orders, the cart and designs belong to the customer's contact, which never
  changes. Stored history keeps the names it recorded, but the staff order screens show the account's CURRENT name and email (a live link).
- **Deactivate / reactivate.** Deactivation ends the customer's sessions and blocks sign-in; the contact, orders, cart, unpaid orders and designs
  stay as they are. Registering again with that email is refused with "contact the shop". Reactivation restores sign-in with the same password.
- **History.** `clothcraft.customer.audit`, append only like the employee history (ORM refusal, trigger, Administrator read only), old/new values
  for name, email, phone and active only.
- **If a mistyped email locks a customer out** (the shop has no "forgot password"): open the customer in `/admin/customers`; under *Recent
  changes* the latest "Edited" line shows "Email: old → new". Edit the customer and type the OLD email back (the confirmation shows both
  addresses side by side). They can then sign in again with the old email and their usual password. The audit keeps both changes. If the
  dashboard is not available, read the line in SQL (`select old_values, new_values from clothcraft_customer_audit where target_login = '<typed
  email>' order by id desc limit 1`) and put the old email back through the dashboard once it is.

### Employee-only employee dashboard (step 7g, module version 19.0.1.12.0)

The system parameter `clothcraft.employee_dashboard_only` (off by default; the shop has no row) makes `/staff` employee-only for everyone:
an Administrator who signs in there works as an employee (the header says "Administrator (working as an employee)" and a banner links to
Admin login), and every admin-only action is refused there and offered only under `/admin`. It is read on every request, so it takes effect
at once for every open session; `/admin`, the admin cookie and `/api/admin` are never affected.

- **Before turning it on (lockout check).** (1) Sign in at `/admin/login` as each Administrator who will need it and open a restock and a
  supplier page there. (2) Sign in to Odoo at `/odoo` as the base `admin` and open Settings > Sales: the "ClothCraft orders" block must show
  "Employee dashboard is employee-only". If either fails, do not turn it on: with the switch on, the admin dashboard is the only place left
  for admin actions, and Odoo Settings (or SQL) is the way back.
- **Turn on.** Tick the checkbox in Odoo Settings, or
  `INSERT INTO ir_config_parameter (key, value, create_date, write_date) VALUES ('clothcraft.employee_dashboard_only', '1', now(), now())
  ON CONFLICT (key) DO UPDATE SET value = '1';`. Only the exact value `1` means on.
- **Turn off (rollback, one row).** Untick it, or `DELETE FROM ir_config_parameter WHERE key = 'clothcraft.employee_dashboard_only';`.
- **Check from the browser.** Reload `/staff` signed in as an Administrator. On: the header says "Administrator (working as an employee)", the
  banner is there, a supplier page shows no Deactivate or opening-balance button. Off: the header says "Administrator", no banner, the buttons
  are back. A page that was already open keeps its old buttons until it is reloaded; the server refuses them anyway.
- **Scripts.** `scripts/seed_suppliers.py` uses only employee actions and still works when it is on. `scripts/set_opening.py` sets opening
  balances through `/api/staff`, which is refused while it is on: run it with the switch off (it is idempotent and already applied).

## Dev tooling: read-only MCP server (M1, not part of the product)

`scripts/mcp_dev/` is a small local MCP server for Claude Code that reads **only** `clothcraft_sim2` and `clothcraft_throwaway_*` copies, in
its own container `clothcraft-mcp-db` (`postgres:16`, `--network none`, volume `clothcraft-mcp-data`), as a read-only role. It never sees the
dev stack's databases (`clothcraft_shop`, `clothcraft_dev`, `clothcraft`, `clothcraft_sim`); those names are refused before anything runs.

- **Setup (once):** `bash scripts/mcp_dev/setup.sh` (writes the untracked `scripts/mcp_dev/.env` with new random passwords, never printed),
  then `cd scripts/mcp_dev && npm ci`.
- **Restore a copy:** `bash scripts/mcp_dev/restore.sh <file.dump> clothcraft_sim2` (or `clothcraft_throwaway_<name>`): restores as-is,
  checks every table's row count against the dump, applies `grants.sql`, makes the database read-only by default.
- **Register:** `claude mcp add --scope local clothcraft-dev -- node <repo>/scripts/mcp_dev/server.mjs` (the `claude` CLI is bundled with
  the VS Code extension under `resources/native-binary/claude.exe`), then reload so the session picks it up.
- **What it can read:** tables in `public` that the role is granted; secrets (password hashes, two-step and API keys, session and throttle
  tables, `ir_config_parameter.value`, attachment contents) are never granted. Email, phone, street, zip and users' login are readable only
  masked, through `mcp_masked.<table>`. Tools: `list_tables`, `describe_table`, `count_rows`, `run_query` (one SELECT, 200 rows by default,
  1000 at most, 5 s timeout, 15 s at most), `compare_counts`. Query text (never results) is logged to `scripts/mcp_dev/logs/` (untracked).
- **Never** point Odoo (web or crons) at `clothcraft_sim2`; it has no network, and it is read-only by default.

## DSS bundle import (B8 S3/S4a, clothcraft_demo only)

A simulated DSS run computed elsewhere (`addons/clothcraft_dss/engine/bundle.py` on `clothcraft_sim2`, read-only role) can be imported as a
run labelled simulated, by the Administrator (DSS runs > "Import simulated bundle", or `env['clothcraft.dss.run']._import_bundle(path)` in
the Odoo shell). The bundle's checksums and engine version (`B8-S4`; an older bundle must be regenerated) are checked first.

- **Off by default.** Import works only where the system parameter `clothcraft_dss.bundle_import_enabled` is exactly `1`; otherwise it is
  refused and the button is not shown. Only `clothcraft_demo` turns it on. Changing a system parameter needs Settings > Technical
  (`base.group_system`); the ClothCraft Administrator role alone does not give it. On `clothcraft_demo`:
  ```powershell
  "env['ir.config_parameter'].sudo().set_param('clothcraft_dss.bundle_import_enabled', '1'); env.cr.commit()" | docker compose run --rm --no-deps -T odoo odoo shell -d clothcraft_demo --no-http
  ```
- **The bundle folder** is mounted read-only at `/mnt/dss-bundles` only through the extra override `docker-compose.dss-bundles.yml`, as a
  third `-f`, with `DSS_BUNDLES_DIR` set (it refuses to start without it; no other compose file mounts it). Use a **short folder outside
  the repo** (for example `C:\ccb`); a bundle is a folder directly inside it:
  ```powershell
  $env:DSS_BUNDLES_DIR = "C:\ccb"
  docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.dss-bundles.yml up -d odoo
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
