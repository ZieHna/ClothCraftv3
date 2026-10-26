# API contract cases

One set of cases that **both** the browser mock and the real service must pass, so they cannot drift apart.

| | Runs | Where |
|---|---|---|
| Mock (MSW handlers) | `npx vitest run --project jsdom src/api/contract.test.ts` in `frontend/` | `frontend/src/test/contractRunner.ts` |
| Real service + Odoo | `pytest tests/test_contract.py` in `backend/` with `CONTRACT_BASE_URL` set | `backend/tests/contract_runner.py` |

The two interpreters are written twice (TypeScript, Python) and must be kept in step: every `op` exists in both.

## Files

- `shapes.json` — named response shapes. A leaf is a type name (`string`, `number`, `boolean`, `null`, `a|b`), `enum:x|y`, `{"$ref": "Name"}`,
  `{"$oneOf": [...]}`, or an array of one element (every item must match). Objects must have **exactly** these keys: a key the
  contract does not name is a failure (that is how a renamed or extra field is caught).
- `cases/*.json` — `{name, method, path, query?, body?, status, shape?, asserts?}`.
- `real-only/*.json` — cases for the **real service only**, read by the Python runner alone: what the frozen mock does not have
  (step 9, customized garments: `08-designs.json`; step 11, order tracking: `09-tracking.json`). They use only the ops and steps both
  runners know.
- `mock-only/*.json` — cases for the **frozen mock only**, read by the TypeScript runner alone: what the mock still does and the real
  service no longer does. Step 11 moved the four step 7 order-flow cases here unchanged (`07-staff-step7-flow.json`: the cash-on-delivery
  and bank-transfer walks through "packed", the paid bank-transfer cancel, and the two-staff race on "packed"); `real-only/09-tracking.json`
  has their step 11 versions.

## DSS (`real-only/11-admin-dss.json` and `12-admin-dss-simulated.json`, B8 S4d/S4e)

The decision-support routes under `/api/admin/dss/...` (reference: `backend/README.md`, "DSS API"). Real service only: the frozen mock has no
admin handlers at all. 14 cases in two files (below), 19 `Dss*` shapes (`DssOverview`, `DssRuns`, `DssRunDetail`, `DssForecastKeys`, `DssForecast`, `DssBacktest`,
`DssRestock`, `DssSegments`, `DssAlerts`, `DssHealth`, `DssRunQueued`, `DssRunRequest` and their parts). **No change to either runner.** The cases:
the access matrix for every DSS route (no cookie 401, customer cookie 401, employee cookie 403, Administrator 200, plus the POST); unknown query
names, bad values, `pageSize` 101 and 0 and `page` 0 on every paged route (422); the overview's two labelled blocks and the rule that the default is
never simulated; the run list and detail; forecast with history (product, total, a garment type, and the empty state of a real run); backtest, restock,
segments, alerts and health, each on the simulated run (rows to check) and the real one (the empty state); Run now (two at once give one 202 and one 409,
in either order; no body; an unknown request); import impossible (POST `/dss/import` 404, POST `/dss/runs` 405); signing out ends the session.

**Two files, two databases.** `11-admin-dss.json` (6 cases: the access matrix, the 422 matrix, the Run now race, Run now with no body or an unknown
request, import impossible, sign-out) needs only the DSS module installed and **at least one finished real run** (press Run now once; the race case
makes more). It is the half to run on `clothcraft_shop`: on a database with no run yet the access matrix gets 404 where it expects 200 for the run-based
routes. `12-admin-dss-simulated.json` (8 cases: overview labelling, runs, forecast, backtest, restock, segments, alerts, health) also needs **one imported
simulated run**, so it is only for a throwaway copy with the import switch on; it must never be run against the shop. Select them by file name with pytest's
`-k "11-admin-dss"` and `-k "12-admin-dss-simulated"`.

**The database they need together** (a throwaway copy, like every real-service case): the DSS module installed, **one real run** made from shop data (almost no
history: its forecast says `not_enough_history`, its segments `not_enough_customers`) and **one imported simulated run** (a B8-S4 bundle from a
`clothcraft_sim2` run, with `clothcraft_dss.bundle_import_enabled` = `1` in that copy only). The Administrator comes from the same four staff variables
as the staff cases (`STAFF_ADMIN_EMAIL` / `STAFF_ADMIN_PASSWORD`, signing in at `/api/admin/auth/login`; the inventory account signs in at
`/api/staff/auth/login` for the 403 steps). The ids of the two runs are found by the cases themselves (`save` from the overview). The Run now race starts
a real run in the copy's cron, so the copy must be running Odoo's cron (not `--max-cron-threads=0`).

**What these cases do not prove** (Odoo tests and the proof scripts do): the figures themselves, real customers' names (the copy has almost none),
that nothing writes to business tables (a `pg_stat_user_tables` before/after around the whole GET set and one Run now), and the end-to-end timing of a
run. The browser mock never sees these routes, so the mock runner is unchanged and does not read `real-only/`.

## Saved cart (`real-only/10-cart.json`, step 12)

`GET /api/cart` and `PUT /api/cart` (`{baseVersion, lines: [{sku, quantity, designId?, selected}]}`), customer session only. New shapes:
`ServerCart` (`version`, `updatedAt`, `lines`: `ServerCartLine` | `DesignedServerCartLine`) and `ApiErrorCart` (409 `cart_conflict`
carries `error.cart`, the cart as it is now). The cases: an empty cart for a new customer and 401 for no session or a staff session;
written and read back, with each customer seeing only their own cart; a write on an old version is a conflict while the same write
again is not; the limits (422) and a missing version (400); an order taking exactly what it ordered off the cart; a cross-site write
(403).

## Order tracking (`real-only/09-tracking.json`, step 11)

States `out_for_delivery` and `closed` join the state enums (the mock never sends them). Where step 11 adds keys, a shape is a `$oneOf` of
the step 7 shape (what the mock sends) and the step 11 shape (what the real service sends): `Order` = `OrderStep7` | `OrderTracked`
(adds `tracking`: `OrderTracking` — the four steps with `reachedAt`, `current`, `awaitingPayment`, `closedAt`, `closedBy`, `canConfirm`;
times only, never a name or a note), `StaffOrderSummary` (adds `hasDesign`), `StaffOrderDetail` (adds `tracking`; a history line may add
`actor` and `stepBack`, a move `direction`). The step 11 cases ask for the step 11 shapes by name. New route:
`POST /api/orders/{id}/received` (the customer's "I received my order": owner only, 404 for another customer's order, 409
`invalid_transition` before delivery, the same 200 when pressed again).

## Customized garments (`real-only/08-designs.json`)

New shapes only: the existing ones are unchanged, so the frozen mock still passes. A quote line or an order line is either the plain
`QuoteLine` / `OrderLine` or a `DesignedQuoteLine` / `DesignedOrderLine` (`$oneOf`), which adds `designId` and `printFee`
(`PrintFee`: coveredSqIn, rate, sizeStep, steps, unit, total), and on a quote `remedy`. A cart line is `{sku, quantity, designId?}`; a line
is (sku, designId). A design that is removed, deleted or not the shopper's is the issue `design_unavailable`, "This design is no longer
available.", with `remedy: "remove"`, and is **never priced as the plain garment** (unitPrice, lineTotal 0, printFee null, not ready);
placing such an order is 409 `design_unavailable`. Other shapes: `DesignPricing`, `DesignSummary`, `DesignRemoved`, and `DesignState`
(`GET /api/designs/{id}/state`, owner only: the editor state and pictures, so "Edit design" in the cart can open a design again).

The test (`backend/tests/test_contract.py`) builds the upload bodies itself (a real PNG written by hand) and the expected figures from the
shop's own settings: one element covering the garment's whole print box, so the covered area is the garment type's print area at size
Small. Picture responses have no JSON body; the cases check their status and headers.

## Cases with several steps (orders)

A case is one request, or has `steps`. A step is a request (`method`, `path`, `query`, `headers`, `body`, `status`, `shape`, `asserts`, and `save`: variable -> path in the response, kept for later steps) or `{"parallel": [request, request], "statuses": [201, 409], "asserts", "save"}`: the requests are sent at the same moment, `statuses` is the sorted list of answers (which request wins a race is not fixed), and the asserts see `{results: [{status, body}]}`.

- `"customers": ["alice", "bob"]` registers each customer fresh before the steps (a unique email, the password `{{contractPassword}}`) and makes each a **named client**:
  its own browser, with its own session and its own client address. The variables `<name>Email`, `<name>Password` and `<name>Id` are set. A step or the case
  says who sends it with `"as": "alice"`; a name that was never registered is simply another anonymous browser (no session). Against the real service a client's
  session is a cookie jar (the runner does what a browser does with `Set-Cookie`); against the mock it is a token (`X-Mock-Session`). Each client presents
  its own address in `X-Forwarded-For`, which the attempt counters are keyed by (the service under test runs with `TRUSTED_PROXIES=*`).
- `{"snapshot": "label", "as": "alice"}` remembers a client's session and `{"restore": "label", "as": "alice"}` gives it back: a copy of an old cookie, to prove
  that signing out or signing in again really ends the old session. `"repeat": 5` on a request sends it five times, each answer expected to be the same.
- `"keys": ["k1"]` makes fresh unique values (`{{k1}}`) for an `Idempotency-Key` or an email, so repeated runs against one database do not collide.
- Each order case uses an in-stock variant of its own (`orderSku1` to `orderSku7`, with `...Price`, `...Avail`, `...PriceMore`), and `raceSku` for the last-units race, so no case depends on another case's stock.
- The cases REGISTER CUSTOMERS and the order cases PLACE ORDERS. Run them against a throwaway database, never clothcraft_sim or the live clothcraft.
- `delivery-validation.json` is a table of address changes and the exact 422 messages they give. The browser rules (`deliveryRules.ts`) and the service (`backend/app/delivery.py`) are both run against it.

## Staff cases (`07-staff.json`)

The staff dashboard routes (`/api/staff/...`, see `backend/README.md`). Same runner, same step kinds, plus these conventions:

- **Staff sign in with a step**, not a case field: `POST /api/staff/auth/login` with `{{staffInventoryEmail}}` / `{{staffInventoryPassword}}` (an Inventory Staff user) or `{{staffAdminEmail}}` / `{{staffAdminPassword}}` (an Administrator), `"as": "inv"` (any client name). A client holds its customer session and its staff session side by side, which is what the crosswise cases rely on.
- The four staff variables come from the environment (`STAFF_INVENTORY_EMAIL`, `STAFF_INVENTORY_PASSWORD`, `STAFF_ADMIN_EMAIL`, `STAFF_ADMIN_PASSWORD`; `backend/.env`, written by `scripts/create_staff_users.py`, never printed). The real-service runner (`backend/tests/test_contract.py`) adds them to the discovered variables; a case that needs one fails with "unknown variable" when it is unset. The password only ever appears in a login request body: cases assert it is `absent` from responses.
- **Staff variants**: discovery also finds `staffSku1` to `staffSku8` (with `...Price`, `...Avail`), variants with 2 to 90 free after the order, race and iso variants. Each staff case uses its own, so none depends on another's stock. Put the staff cases AFTER 05 and 06; they place and move orders.
- **Moves** are `POST /api/staff/orders/{id}/transition` with `{to, expectedState, note?}`. `expectedState` is what the screen showed: when the order has moved, nothing is done and the answer is 409 `state_changed` with the fresh order. `parallel` steps with two staff clients prove one 200 and one 409.
- **Stock**: a cancel gives the reserved stock back, checked through `POST /api/cart/quote` (`available` goes down by one when the order is placed and returns when it is cancelled).

| Case group | What it proves |
|---|---|
| no session, wrong password, bad request, sign out, a copy of the old cookie | every staff route is 401 without a staff session; the wrong password and an unknown email read the same; signing out ends that session |
| crosswise | a customer session never opens a staff route and a staff session never opens a customer route; the two sessions of one browser are independent |
| lifecycle (cash on delivery, bank transfer) | every step is a history line; "paid" is the move to confirmed; delivered completes the cash payment; the customer sees the status only |
| cancel | releases stock; unpaid bank orders by Inventory Staff; a PAID bank order is Administrator-only, needs a note, and the history says REFUND DUE; shipped and delivered orders cannot be cancelled |
| invalid and stale | unknown target (422), same state, a missing field (400), a stale screen (409 `state_changed`), unknown order (404) change nothing |
| the list | state (repeatable or comma list), method and date filters, search by reference or email, paging, and the 400 for each bad filter |

Shapes added to `shapes.json`: `StaffUser`, `StaffAuthResponse`, `StaffOrderSummary`, `StaffOrderList`, `StaffOrderDetail` (an `Order` plus `customer`, `history`, `allowed`, `blocked`), `ApiErrorCurrent` (409 `invalid_transition`, 403 `forbidden`: `currentState`) and `ApiErrorStateChanged` (409 with the fresh `order`). The customer `Order.state` now allows all six states (`awaiting_payment`, `confirmed`, `packed`, `shipped`, `delivered`, `cancelled`).

**The mock implements them too (step 7c)**: `frontend/src/mocks/staff.ts` (the rules, the same sentences) and `staffHandlers.ts` (the routes), with two demo staff accounts that exist only in a mock build (`DEMO_STAFF`; `contract.test.ts` passes their email and password as the four staff variables). A session is the `X-Mock-Staff-Session` header, kept apart from the customer's `X-Mock-Session`; the TypeScript runner's jar holds both (`session` and `staff`). The runner itself knows nothing about staff: signing in is a step. Run: `npx vitest run --project jsdom src/api/contract.test.ts` in `frontend/` (85 cases and delivery rows plus the 12 staff cases).

## Asserts

Paths look like `data.lines[0].message`, `data.products[*].name` (one value per item) or have a prefix: `len:`, `sum:`, `min:`, `max:`.

`eq`, `eqPath`, `gt`, `lte`, `each` (`is`: eq, ne, gte, lte, containsI), `unique`, `countEq` (how many values equal `value`), `matches` (regex), `absent` (the text must not appear anywhere in the response: a password), `header` (a response header matches a regex), `startsWith`, `endsWith`, `eachSum`, `vatOf`
(the VAT is the included part of the total, rounded once on the total), `statusFollowsStock` (low stock = 2 or fewer).

## Data-dependent cases

Cases never hard-code stock. Both runners first find, through the API itself: `firstProductId`, `soldOutSku` (a variant with 0), and the variants with 2 to 90 free: `inStockSku` (with `inStockProductId`, `inStockPrice`, `inStockAvailable`), `otherInStockSku`, `orderSku1..7`, `raceSku` and `isoSku1..2` (for the two-customer cases).
`{{name}}`, `{{name+1}}`, `{{name-1}}`, `{{name*2}}` and `{{x81}}` (81 letters x) are filled in. A server whose data has no sold-out variant, or fewer than 10 such
variants, fails discovery with a clear message.

## Where the rules the mock and the service both follow come from

| Rule | Source |
|---|---|
| prices, VAT, rounding, free stock | Odoo (`clothcraft.api`, `addons/clothcraft/models/api.py`) |
| product id (`m-tee`), group (Men/Women/Kids/Babies), featured | Odoo product fields (step 8b): Storefront id, Shop group, Featured on the shop |
| product picture | Odoo's own image, served by the service at `/api/catalogue/products/<id>/image?v=<version>` (checked by `backend/tests/test_catalogue_live.py`: a picture is not JSON, so it is not a contract case) |
| swatch colours, province list, bank wording | `backend/app/data/*.json`, copied from the mock |
| low-stock threshold (2 or fewer), max quantity 99, max 50 lines | `backend/app/config.py` |
| delivery wording, bank details | service settings (`DELIVERY_LABEL`, `BANK_*` in `backend/.env`); the cases only require a delivery label to be there |
