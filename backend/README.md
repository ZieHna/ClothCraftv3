# ClothCraft storefront API (FastAPI)

The shapes of `frontend/src/api/types.ts`, answered from Odoo. The service reaches Odoo **only** through its JSON-2 API
(`POST /json/2/<model>/<method>`, bearer API key, `X-Odoo-Database` header), never through Postgres.
The XML-RPC and `/jsonrpc` endpoints are deprecated in Odoo 19 (removal in Odoo 22) and are not used.

Built so far: catalogue (`/api/catalogue/...`), `/api/cart/quote`, `/api/checkout/options`, orders (`/api/orders...`), and customer
accounts (`/api/auth/register`, `/login`, `/logout`, `/me`). The shop's register and sign-in forms use them; the browser mock
implements the same endpoints and rules, and `contract/` proves the two agree.

## Customer accounts and sessions

**Who is the customer.** Only the session. Every order route resolves the cookie to a customer inside Odoo
(`clothcraft.api` gets the *hash of the session id*, never a customer id), so a caller cannot name someone else's orders, and another
customer's order id is simply 404. The old `DEMO_PARTNER_ID`, `ALLOW_DEMO_SESSION` and `X-Demo-Session` are gone; the header means nothing.

**The session.**
- The browser holds `cc_session=<random id>.<HMAC of it>` (`__Host-cc_session` over https). Flags: `HttpOnly`, `SameSite=Lax`, `Path=/`,
  `Secure` when the request is https (or `COOKIE_SECURE=true`), no `Domain`. `Max-Age` follows what the session can still last.
- A forged, tampered or unsigned cookie is 401 here, before Odoo is asked. The HMAC key is `SESSION_SECRET` (32+ characters, only in the
  gitignored `backend/.env`; the service will not start without it; changing it ends every session).
- Odoo keeps the SHA-256 of the id in `clothcraft.api.session`, so a copy of that table is not a set of working cookies. Sign-out and
  expiry are real because the row is revoked there, not because the cookie is deleted: a copy of an old cookie is dead.
- **Lifetime:** idle 8 hours (sliding) and 7 days absolute. A new id at every sign-in and registration, and the one the browser held is
  ended. **Why no periodic rotation:** an id that changes on a timer protects against a stolen cookie only for the time between rotations,
  while the cookie is `HttpOnly`, never in a URL, never logged, and the 8 h idle limit and 7 d cap already bound its life. Rotation adds
  races (two tabs, a lost response leaves a browser with a dead id) for little gain. Odoo itself rotates every 3 hours; here a new id is
  issued whenever the *privilege* changes (sign-in, registration, sign-out). Revisit if sessions ever grant more than a customer's own orders.
- **Staff accounts can never hold a shop session**, and nor can a deactivated customer (checked on every request).

**Sign-in and the throttle.**
- Odoo's own login cooldown counts failures per source address in memory. Through this service every customer has the same address, so
  five wrong passwords from anyone would lock everybody out. So the password is checked with `_check_credentials` directly and the
  facade keeps its own counters (`clothcraft.api.throttle`): per email, and per client address.
- 5 failures on one email lock it for 60 s, doubling with each further failure up to 15 minutes; failures older than 15 minutes are
  forgotten; a success clears the email's counter (not the address's). 20 failures from one address lock that address. At most 10
  registration attempts (successful or not) per address. A locked attempt is **not** checked and not counted. The answer is HTTP 429 with
  `Retry-After` and `retryAfter` in the body.
- The counters are keyed by a hash of the email whether or not it has an account, so an unknown email locks exactly like a real one, and
  wrong password, unknown email, a staff account, a deactivated account and an account with no password all answer the same 401, taking
  the same time (a dummy hash is checked when there is no account).
- **Deliberate lockout is possible.** Anyone who knows an email can fail five times on purpose and lock that customer out for a minute
  (and again, longer, if they keep going). That is the price of per-email counters, which are the only defence that works when every client looks like
  the same address behind Docker. A per-address limit alone would not stop a slow guess at one account. In production, put the real client address
  in (`TRUSTED_PROXIES`, below) and consider CAPTCHA or email verification before relying on this.
- **Two-step verification:** a customer who switched on Odoo's authenticator-app login gets a distinct 403 `mfa_unsupported` answer, only after
  the *correct* password, and it is **not counted** as a failed attempt (otherwise using the shop with such an account would lock it). The
  shop does not support it yet, so such an account cannot sign in to the shop.

**Registration.** `clothcraft.api.auth_register` makes a portal user from Odoo's portal template (never an internal user), with the
name, email (trimmed, lower-cased) and password only. Password: 10 to 128 characters, not on a short list of common passwords
(`addons/clothcraft/data/common_passwords.txt`), not all one character, not containing the email; no composition rules (Odoo itself
enforces no minimum, because `auth_password_policy` is not installed). A taken email answers 409 *"We couldn't create an account with that
email. If it is yours, sign in instead."* Because a successful registration signs the person in, success and "taken" can be told apart, so
**account enumeration at registration is not fully preventable** without email confirmation (there is no mail server in development);
it is rate limited per address. Odoo's own uniqueness is `UNIQUE (login, website_id)` and customers have no website, so two registrations
of one email at the same moment would both be accepted: an advisory lock per email (with the lookup made in a fresh transaction) and a partial unique
index `res_users (lower(login)) WHERE website_id IS NULL` stop that (proved by `test_auth_live.py`). The 560 simulated customers have
no password, so none of them can sign in.

**Cross-site requests (CSRF).** `SameSite=Lax`; every body is JSON; there is no CORS; and a state-changing request (POST, PUT, PATCH,
DELETE) is refused (403) when the browser says it came from another site: `Sec-Fetch-Site: cross-site`, or an `Origin` that is not in
`ALLOWED_ORIGINS` (empty means no origin is allowed; requests with no `Origin` header are not browsers acting for someone and pass).
**Production hardening not done:** a CSRF token header (double submit) on top of this. It is not needed for the threat model above
(a browser always sends `Origin` on a cross-site POST), but it is the usual belt and braces.

**What can't be avoided with passwords.** The service never stores or logs a password and keeps no request body in a log; it holds
the password in memory for the length of one request and sends it to Odoo as JSON. Inside Docker that last hop is plain HTTP, so on a
real deployment the service-to-Odoo link must be TLS or a private network. Odoo's debug logging could include parameters (the INFO log
was checked and does not). The generic `/json/2/res.users/authenticate` also remains callable with the service key, so a leaked key
can be used to guess passwords (limited by Odoo's own per-address cooldown); keep the key in `backend/.env` and off any shared host.

## Staff dashboard API (`/api/staff/...`)

Staff are Odoo internal users, kept completely apart from customers: their own cookie (`cc_staff`, `__Host-cc_staff` over https) with a
MAC that is not valid for a customer cookie (and the reverse), their own server-side session `scope` in Odoo, their own throttle counters,
and a customer cookie never opens a staff route (nor the other way round). Sessions end after **2 hours idle or 12 hours absolute**. The
service decides nothing about who may do what: Odoo re-reads the person's groups on **every call**, so removing a group takes effect at
once. Same CSRF rules as the customer routes.

| Route | Does |
|---|---|
| `POST /api/staff/auth/login`, `POST .../logout`, `GET .../me` | sign in (email + password), out, who am I |
| `GET /api/staff/orders` | list: `state` (repeatable or comma list), `method`, `from`, `to`, `q`, `page`, `pageSize` (1-100) |
| `GET /api/staff/orders/{id}` | the order, the customer's contact details, the history, the moves allowed to this person now, and the blocked ones with a reason |
| `POST /api/staff/orders/{id}/transition` | `{to, expectedState, note?}`. `expectedState` is what the screen showed; if the order has moved since, nothing is done (409 `state_changed`, with the fresh order) |

Moves: awaiting_payment → confirmed (shown as "paid") or cancelled; confirmed → packed or cancelled; packed → shipped or cancelled;
shipped → delivered. Packed means the Odoo move lines are picked, shipped means the delivery is validated (Odoo's own stock effect),
delivered also completes the cash-on-delivery payment. **Cancelling a paid bank-transfer order is for an Administrator only, with a
required note, and the audit entry says "REFUND DUE"**; Inventory Staff cancel unpaid orders only. Once a delivery is validated an order
cannot be cancelled. Every move is a line in `clothcraft.order.audit` (append-only: refused by the ORM, by a database trigger and by
read-only access rights). Customers see only the status (the order's `state`: no history, no staff names); no customer text promises a refund or a
delivery time.

**The audit trigger does not block `TRUNCATE`.** It is a row-level trigger on `UPDATE` and `DELETE`, which Postgres does not fire for
`TRUNCATE`: a database superuser (or the table's owner, the `odoo` role) can still empty `clothcraft_order_audit` that way, and `DROP TABLE`
or a restore over the database can remove it too. The ORM, the trigger and the access rights stop the application and every Odoo user; they
are not a defence against someone with direct database access. If that ever matters, add a statement-level `BEFORE TRUNCATE` trigger that
raises, and keep database backups.

**Not supported yet:** staff accounts with two-step verification get a clear "not supported yet" message (403 `mfa_unsupported`) and are
not signed in. **Out of scope:** returns, failed deliveries and partial shipments.

Staff test users are made on a development database with `scripts/create_staff_users.py` (passwords go to the gitignored `backend/.env`
as `STAFF_*`, never printed).

## Suppliers, restocks, stock, low-stock levels and the bell (`/api/staff/...`, phase 4)

33 routes in `app/inventory.py`, one per facade method of `clothcraft.api`. The service checks the SHAPE of a request, forwards it with the
`cc_staff` session (the same cookie, idle/absolute expiry and renewal as the order routes), and turns Odoo's answer into HTTP. It decides
nothing else: the role is re-read in Odoo on every call (an Inventory member asking for an Administrator's action gets Odoo's `forbidden`,
403), and every rule and every sentence a person reads is Odoo's. Nothing here gives `api_shop` a create, write or unlink right.

| Method and path | Who | Facade method |
|---|---|---|
| GET `/suppliers?q&status&page&pageSize` | any | `staff_suppliers` |
| GET `/suppliers/{id}` | any | `staff_supplier` |
| POST `/suppliers` (201) | any | `supplier_create` |
| PATCH `/suppliers/{id}` | any | `supplier_update` |
| POST `/suppliers/{id}/lines` (201), PATCH / DELETE `/supplier-lines/{id}` | any | `supplier_line_add / update / remove` |
| POST `/suppliers/{id}/ranges` (201), PATCH / DELETE `/supplier-ranges/{id}` | any | `supplier_range_add / update / remove` |
| POST `/suppliers/{id}/deactivate`, `/reactivate`, `/switch-off`, `/switch-on` | Administrator | `supplier_deactivate / reactivate / switch_off / switch_on` |
| PUT `/suppliers/{id}/opening-balance` (body `{openingBalance}`) | Administrator | `supplier_set_opening_balance` |
| GET `/garment-options` | any | `staff_garment_options` (garment types with their sizes, colours and the valid size x colour pairs) |
| GET `/restock-options?supplierId` | any | `staff_restock_options` |
| GET `/restocks?q&state&supplierId&late&overdue&page&pageSize`, GET `/restocks/{id}` | any | `staff_restocks`, `staff_restock` |
| POST `/restocks` (201), PATCH `/restocks/{id}` (only while `requested`) | any | `restock_create`, `restock_update` |
| POST `/restocks/{id}/approve`, `/reject`, `/receive`, `/not-received` | Administrator | `restock_approve / reject / receive / not_received` |
| GET `/stock?q&low&page&pageSize`, GET `/stock/history?productId&page&pageSize` | any | `staff_stock`, `staff_stock_history` |
| POST `/stock/{productId}/edit` | any | `stock_set` |
| PUT `/stock/threshold`, PUT `/stock/{productId}/threshold` (`threshold: null` removes it) | Administrator | `stock_threshold_set_global / variant` |
| GET `/notifications?unreadOnly&page&pageSize`, POST `/notifications/{id}/read`, POST `/notifications/read-all` | any (own only) | `staff_notifications`, `staff_notification_read`, `staff_notifications_read_all` |

**Opening balance (step 7, module 19.0.1.8.0).** `clothcraft.supplier.opening_balance` (VAT included, default 0, never negative) treats the stock the shop
already held as if bought from that supplier. It is a STARTING INVESTMENT: no restock, stock move, lot or receipt stands behind it, and only an
Administrator sets it (`PUT /suppliers/{id}/opening-balance`; the model refuses anyone else, and it replaces the old value with no history besides
`lastEditedBy / lastEditedAt`). Every supplier (summary and detail) carries `openingBalance`, `openingBalanceVat`, `openingBalanceNet` and the
combined figures `combinedTotal`, `combinedTotalVat`, `combinedTotalNet` (opening balance PLUS received restocks; the VAT and net parts are added
part by part, so VAT + net = total). The list also answers `totals` over ALL the company's suppliers, inactive ones included, whatever the page, search
or status filter: `{supplierCount, openingBalance(Vat/Net), receivedTotal/Vat/Net, combinedTotal/Vat/Net}`. The frontend adds no money.

> **For profit and DSS.** Received-only spending is, per supplier, exactly these fields: `total_spent` (JSON `totalSpent`), `total_spent_vat`
> (`totalSpentVat`), `total_spent_net` (`totalSpentNet`) and `received_count` (`receivedCount`) (and `totals.receivedTotal / receivedVat /
> receivedNet`). Their meaning is unchanged by step 7. Treat `opening_balance` as a separate opening line, a starting investment, and **never use
> `opening_balance` or any `combined_*` figure as a monthly cost** (or as spending in any period).

**Admin sign-in (step 7a, module 19.0.1.9.0).** The Administrator's own sign-in is separate from the employee dashboard's: `POST /api/admin/auth/login`,
`POST /api/admin/auth/logout`, `GET /api/admin/auth/me` (`app/admin.py`). Its cookie is `cc_admin` (`__Host-cc_admin` over https), written by the same
code as `cc_staff` (HttpOnly, SameSite=Lax, Secure over https, Path=/, Max-Age = what the session can still last), with its own HMAC kind and its own
Odoo session scope `admin` (1 hour idle, 8 hours absolute; staff is 2 and 12) and its own failure counters. Odoo accepts an admin session only while the person
holds the Administrator group (re-read on every call). An employee's account at the admin door is `403 not_admin` ("This is an employee account. Use
Employee login."), said only AFTER a correct password and never counted; a wrong password, for an employee's email or for none at all, is the same
`401 invalid_credentials`. A request to an admin route with a valid employee cookie and no admin cookie is `403 forbidden`; with no cookie, or a forged one, 401.
One person may hold both sessions; each sign-out ends only its own.

`clothcraft.employee_dashboard_only` (a system parameter, default off) limits an Administrator's *employee* session (`cc_staff`) to the employee role: the
server then offers and accepts none of the admin-only actions on `/staff`, and `/auth/me` says `workingAsEmployee: true`. It is read from the database with
plain SQL on every staff call (`_api_employee_only`), never cached. Turn it on only when `/admin` has the moved actions: `UPDATE ir_config_parameter SET value = '1'
WHERE key = 'clothcraft.employee_dashboard_only'` (insert the row if there is none); delete the row or set it to `0` to turn it off at once.
Since step 7g (module 19.0.1.12.0) the same switch is a checkbox in Odoo Settings (Sales > ClothCraft orders, "Employee dashboard is
employee-only"), which writes exactly `'1'` or removes the row. Any other value (`'true'`, `'True'`) reads as OFF. See README.md for the
checks to make before turning it on.

**Admin dashboard (step 7b).** `GET /api/admin/dashboard?range=this_month|last_3_months|last_12_months|all` (default `last_12_months`; anything else, or any other
parameter, is 422) answers one read-only summary from the facade method `admin_dashboard` (`models/api_admin.py`): `kpis`, `revenueByMonth`, `ordersByStatus`,
`stockAlerts`, `restockQueue`, `supplierSpend`, `topGarmentTypes`. Access: the service needs the `cc_admin` cookie (an employee cookie alone is 403, no or a forged
cookie 401) and Odoo then checks, on that very call, for a live admin-scope session of someone who holds the Administrator group (anything else is 401, so a person
whose group is removed is cut off at once). The method only reads business data. Money: revenue is delivered and closed orders, each order's VAT-included
total split with `vat_split` and the parts added part by part; an order counts in the Manila month it reached delivered (the latest `delivered` history line, else the
day it was placed); ranges are whole Manila days. The suppliers' opening balance is a starting investment and appears on its own line, never inside a month or a
period. The page does no money arithmetic (it only sizes a bar by value / largest value).

**The same routes under `/api/admin` (step 7e-1).** The order, supplier, stock, restock and design-picture routes above also exist under `/api/admin/…` (the
same handler code, mounted a second time in `main.py`; no notification routes yet). Each mount reads exactly ONE cookie kind and sends that scope to Odoo
with every call (`context.clothcraft_scope`, via `ScopedOdoo` in `odoo.py`): `/api/staff/*` reads only `cc_staff`, `/api/admin/*` only `cc_admin`, so there
is no cookie precedence. An employee cookie alone on `/api/admin/*` is 403, no or a forged cookie 401, an admin cookie on `/api/staff/*` 401. Odoo
(`_api_staff`) looks the session up in that scope only (a staff session under an admin context finds nothing, and the reverse), re-reads the role on every
call, and an `admin` session exists only for an Administrator. `clothcraft.employee_dashboard_only` caps `cc_staff` sessions only; a `cc_admin` session is never capped.

**JSON.** camelCase in and out, ids are strings, datetimes are ISO with a `Z`, plain dates stay `YYYY-MM-DD`. Money is a plain JSON number
rounded to 2 decimals, as the order routes do (not strings, not minor units); entered prices include the 12% VAT, and the VAT / net
parts come from Odoo. A list answers `{total, page, pageSize, <items>}` (`pageSize` 1 to 100, default 25).

**Strict.** An unknown body field or query parameter is 422 `validation` naming it ("Not allowed."). Filters take only their known values
(`status`: available, unavailable_range, off, inactive; `state`: requested, approved, rejected, received, not_received; `low`, `late`,
`overdue`, `unreadOnly`: `true` or `false`); anything else is 422 naming the field and is never sent to Odoo. A body that is not a JSON
object is 400 `bad_request` (an EMPTY body behaves like `{}`: on a route that needs fields it gets the 422 that names the missing fields), over
16 KB is 413, and a POST / PUT / PATCH / DELETE from another site is 403 `forbidden_origin`. A route that takes no body refuses one.

**`requestNote` and `note` on a restock.** `requestNote` is the employee's own note ON THE TICKET ("why this restock"), kept on the ticket and
changed by `PATCH /restocks/{id}` while it is `requested`. `note` is the HISTORY note of one action: on `approve` and `not-received` it is
optional, on `reject` it is needed (5 to 500 characters), on `receive` it is optional, and on `PATCH /restocks/{id}` it is the note of that
edit's history line. `POST /restocks` takes `requestNote` only: a new ticket's first history line carries no note, so `note` there is refused
(422). `receive` also takes `quantities` and `lots` (objects keyed by the line id, as strings) and `receivedOn` (`YYYY-MM-DD`, not in the future).

**Errors.** One body for every failure: `{"error": {"code", "message", ...}}`.

| Odoo status | HTTP | `error.code` | Extra |
|---|---|---|---|
| done / ok | 200 (201 on create) | | |
| `unauthorised` | 401 | `unauthorised` | the staff cookie is cleared |
| `forbidden` | 403 | `forbidden` | Odoo's sentence |
| `not_found` | 404 | `not_found` | |
| `invalid`, or a shape problem found here | 422 | `validation` | `fields`: `{camelCaseName: sentence}` |
| `invalid_transition` | 409 | `invalid_transition` | `currentState`, and the `restock` when Odoo sends it |
| `refused` | 409 | `refused` | Odoo's sentence, `currentState` when it sends one |
| Odoo down, or a status the service does not know | 502 | `upstream_unavailable` | a generic sentence; the status is logged, never a body |

Sentences written for people (the size / colour message, "already received", "below what orders reserved") pass through as they are. Odoo's
`UserError` text is all that crosses; a real server fault in Odoo is a 502 with the generic sentence, never a stack trace.

**Sample answers** (from the phase 4 smoke run on a throwaway copy; test data only, trimmed):

```jsonc
// POST /api/staff/suppliers -> 201
{"data": {"supplier": {"id": "1", "name": "Sample Textiles", "contactName": "Test Contact", "city": "Manila", "phone": null, "active": true,
  "permanentlyOff": false, "status": "available", "availableNow": true, "ships": true, "shippingFee": 112, "shippingFeeVat": 12, "shippingFeeNet": 100,
  "totalSpent": 0, "totalSpentVat": 0, "totalSpentNet": 0, "receivedCount": 0, "lineCount": 0, "rangeCount": 0, "lastEditedBy": "Staff Inventory (test)",
  "lastEditedAt": "2026-10-24T16:34:18Z", "street": "1 Test Street", "street2": null, "zip": null, "countryCode": "PH", "country": "Philippines",
  "partnerId": "13", "lines": [], "ranges": []}}, "simulation": null}

// POST /api/staff/restocks/{id}/receive -> 200 (a short receipt, shown trimmed)
{"data": {"restock": {"id": "1", "name": "RS00001", "state": "received", "supplier": {"id": "1", "name": "Sample Textiles"}, "lineCount": 2,
  "expectedFrom": "2026-10-25", "expectedTo": "2026-10-28", "shippingOn": true, "shippingApplied": true, "receivedOn": "2026-10-25",
  "receivedLate": false, "overdue": false, "goodsCost": 700.5, "shippingCost": 112, "actualCost": 812.5, "actualVat": 87.05, "actualNet": 725.45,
  "stockReceipt": "WH/IN/00002", "requestNote": "edited in the smoke run",
  "lines": [{"id": "1", "productId": "139", "sku": "W-TEE-BLK-XS", "quantity": 10, "unitCost": 56.5, "quantityReceived": 7, "lot": "SMOKE-LOT-A", "receivedCost": 395.5}],
  "history": [{"id": "4", "event": "received", "fromState": "approved", "toState": "received", "staffName": "Staff Administrator (test)",
               "note": "short by three", "at": "2026-10-24T16:34:20Z", "via": "dashboard"}]}}, "simulation": null}

// GET /api/staff/stock?q=TEE&pageSize=3 -> 200
{"data": {"total": 88, "page": 1, "pageSize": 3, "globalThreshold": 5, "defaultThreshold": 5, "variants": [{"id": "51", "sku": "M-LSLV-BLK-L",
  "name": "[M-LSLV-BLK-L] Men Long Sleeve Tee (Black, L)", "garmentType": {"id": "6", "code": "LSLV"}, "onHand": 14, "reserved": 0, "free": 14,
  "threshold": null, "effectiveThreshold": 5, "thresholdSource": "global", "low": false}]}, "simulation": null}

// GET /api/staff/notifications -> 200
{"data": {"total": 5, "page": 1, "pageSize": 5, "unreadCount": 5, "notifications": [{"id": "13", "kind": "restock_requested",
  "title": "New restock request", "body": "RS00003 from Sample Textiles by Staff Inventory (test): 1 line(s), about 122.00.", "restockId": "3",
  "supplierId": "1", "productId": null, "createdAt": "2026-10-24T16:34:21Z", "read": false, "readAt": null}]}, "simulation": null}

// GET /api/staff/garment-options -> 200 (one garment type, three of its pairs: [sizeId, colourId])
{"data": {"garmentTypes": [{"id": "3", "code": "CROP", "name": "Cropped Tee", "sizes": [{"id": "6", "name": "XS"}, {"id": "7", "name": "S"}],
  "colors": [{"id": "1", "name": "Black", "html": "#000000"}, {"id": "2", "name": "White", "html": "#FFFFFF"}, {"id": "4", "name": "Red", "html": "#C62828"}],
  "combos": [["6", "1"], ["6", "2"], ["6", "4"]]}]}, "simulation": null}

// 422 validation (POST /api/staff/suppliers with required fields missing)
{"error": {"code": "validation", "message": "Some details need fixing.", "fields": {"contactName": "This is needed.", "street": "This is needed.", "city": "This is needed."}}}

// 422 validation, a sentence from Odoo (POST /api/staff/suppliers/{id}/lines with a size and colour the garment is not made in)
{"error": {"code": "validation", "message": "Some details need fixing.", "fields": {"colorValueId": "T-Shirt (TEE) has no Red / XXL variant."}}}

// 403 forbidden (an Inventory member on POST /api/staff/suppliers/{id}/deactivate)
{"error": {"code": "forbidden", "message": "Only an Administrator can do this."}}

// 409 invalid_transition (POST /api/staff/restocks/{id}/approve on a ticket already approved; "restock" is the whole ticket, as GET /restocks/{id})
{"error": {"code": "invalid_transition", "message": "A approved restock cannot be approved.", "currentState": "approved", "restock": {"id": "1", "state": "approved"}}}

// 409 refused (POST /api/staff/restocks/{id}/receive with a typed lot name Odoo already holds for that product)
{"error": {"code": "refused", "message": "The combination of lot/serial number and product must be unique within a company including when no company is defined.\nThe following combinations contain duplicates:\n - Product: [W-TEE-BLK-XS] Women Tee (Black, XS), Lot/Serial Number: OPEN-W-TEE-BLK-XS", "currentState": "approved"}}
```

## DSS API (`/api/admin/dss/...`, B8 S4)

The decision-support section of the admin dashboard: what the DSS module (`addons/clothcraft_dss`) computed, read-only, plus one POST that asks
for a new run. Facade methods are `clothcraft.api.admin_dss_*` (`addons/clothcraft_dss/models/api_dss.py`); the routes are registered in
`app/inventory.py` through the same builder as the other admin routes.

**Access.** The `cc_admin` cookie only: no cookie or a forged one is 401, a customer's cookie 401, a valid *employee* cookie alone 403
("The admin dashboard has its own sign-in. Use Admin login."), the Administrator 200. Odoo re-reads the Administrator group on every call. The
API service user has **no access line on any DSS model**; each facade method checks the admin session first and then reads with a narrow `sudo()`
into explicit field lists. **Import is not exposed**: there is no route for it (POST `/api/admin/dss/import` is 404, POST/PUT/DELETE on `/runs`
is 405); a bundle is imported only in the Odoo screens or shell, and only where the system parameter `clothcraft_dss.bundle_import_enabled` is `1`.

**Which run.** Every data route answers for ONE run: `run=<id>` (a run of this company, done or failed) or `kind=real|simulated` (the latest *finished*
run of that kind; default `real`). Giving both is 422. Real and simulated runs are never mixed in one answer; only `overview` returns both, as two
blocks. On `alerts`, `kind` is the alert's own kind, so the run is `run=<id>` or the latest real run.

**Envelope.** `{"data": ..., "simulation": ...}` as everywhere. `data.run` (on every data route; the run itself on `overview`, `runs`, `runs/{id}`):

| Field | Meaning |
|---|---|
| `id` | the run (string) |
| `kind`, `simulated` | `real` / `simulated`; `simulated` is true for an imported bundle |
| `notice` | the standing text for a simulated run, **"Simulated data: demonstrates the method, not real-world accuracy."**; null for a real run. When the run is more than 8 days old the text "This run is N days old; the figures may be out of date." is added (to the simulated notice if there is one); `stale` is true then |
| `asOf` | the day the figures are as of (Manila) |
| `engineVersion`, `trigger` | `B8-S4`; `cron` (weekly), `manual` (Run now) or `import` |
| `closedRule`, `closedRuleText` | which "Closed" rule priced the money: `closed_state` (orders in the Closed state) or `delivered_and_paid` (a database without that state, such as the simulation) |
| `finishedAt`, `ageDays` | when it finished (ISO `Z`) and its whole age in days |

**Routes** (all GET unless noted; `page` from 1, `pageSize` 1 to 100, default **25**; unknown query names and bad values are 422 with `error.fields`):

| Route | Query | `data` |
|---|---|---|
| `/overview` | – | `real`, `simulated` (each a run summary or null), `queue` (the request being served, or null) |
| `/runs` | `kind` real (default) / simulated / all, `state` done / failed / all, paging | `runs` (summaries, newest first), `total`, `page`, `pageSize` |
| `/runs/{runId}` | – | `run`: the summary plus `partStatus`, `selection`, `rowCounts`, `libraries`, `inputFingerprint`, `outputHash`, `forecastNotes`, `error` (a failed run, at most 300 characters) |
| `/forecast/keys` | `run`/`kind`, `level` product (default) / garment_type / total | `run`, `level`, `keys` [{level, key, label}] |
| `/forecast` | `run`/`kind`, `level` (default total), `key` | `run`, `level`, `key`, `dataStatus`, `rows` (weekly forecast), `history`, `historyStatus` |
| `/backtest` | `run`/`kind`, `level`, `key`, `policy`, `horizon` (all, 1 to 8), `weeks` (all / uncensored), `chosen`, paging | `run`, `rows`, `total`, `page`, `pageSize` |
| `/restock` | `run`/`kind`, `urgency`, `garmentType`, `supplierId`, `q` (SKU), paging | `run`, `rows`, `counts` per urgency, `total`, `page`, `pageSize` |
| `/segments` | `run`/`kind`, `segment`, `sort` monetary (default) / recency / frequency, paging | `run`, `dataStatus`, `summary`, `rows`, `total`, `page`, `pageSize` |
| `/alerts` | `run`, `kind` (alert kind), `severity`, paging | `run`, `rows`, `counts` per severity, `total`, `page`, `pageSize` |
| `/health` | `run`/`kind` | `run`, `months`, `trend`, `kpis`, `projection` |
| POST `/run-now` (no body) | – | **202** `{requestId, state: "queued"}` |
| `/run-now/{requestId}` | – | `{requestId, state, runId, detail}` |

Sort orders are stable (the last key is always the id): restock by urgency, then run-out date (none last), SKU; alerts critical, warning, info, then
the oldest first; backtest by level, key, policy, horizon, weeks; runs newest first.

**Renamed keys.** The service strips the top-level keys `status` and `message` from an Odoo reply as its own envelope, so the DSS answers use
`dataStatus` ({code, message}: why a table is empty, for example `not_enough_history`, `not_enough_customers`), `partStatus` (the same, per part of
a run, on `runs/{id}`), `historyStatus` ({code, message} for the forecast history: `not_enough_history`, or `history_unavailable` with the reason) and
`detail` (the text of a run request).

**Units and precision.** DSS numbers are sent with up to **4 decimals** (every other route keeps 2, and money everywhere is VAT included, in pesos).
Units are stated by the field name's meaning:

| Field | Unit |
|---|---|
| `yhat`, `lo80`, `hi80`, `lo95`, `hi95`, `units` (history) | units **per week** |
| `dailyDemand` | units per day (4 decimals); `weeklyDemand` = `dailyDemand` x 7, units per week, sent next to it so a slow variant reads "about 0.24 a week" instead of 0.03 a day |
| `safetyStock`, `reorderPoint`, `orderUpTo`, `onHand`, `reserved`, `free`, `incoming`, `suggestedQty` | units |
| `leadP50`, `leadP90`, `leadDays`, `daysLeft`, `ageDays` | days |
| `wape`, `bias`, `cov80`, `cov95` (backtest) | **percent** as the engine measures them (49.65 means 49.65 %); `mae` in units per week |
| `sharePct` (segment summary), `growthPct` (health KPIs), `revenueRelSlopePct`, `thresholdPct` (trend) | percent |
| `revenueRelSlope`, `threshold` (trend) | a **fraction** of the 3-month average per month (0.1109); the same figure in percent is sent as `revenueRelSlopePct` / `thresholdPct` |
| money (`revenue`, `unitCost`, `landedUnitCost`, `estCost`, `monetary`, ...) | pesos, VAT included; screens round to 2 decimals |

A figure that does not exist is `null`, never 0: no interval, no supplier, no run-out date, no forecast, a 3-month average with fewer than 3
complete months.

**Segments and privacy.** A *simulated* run returns only the pseudonymous `customerKey` (`c_` and 16 hex characters) and `customer: null`. A *real*
run's row adds `customer: {customerId, partnerId, displayName}`: the name is read at that moment (never stored by the DSS), `customerId` is the
person's shop account (for the Customers page; null when there is none), and a customer who no longer exists has `displayName: null`. **Never an
email, phone or address.**

**Run now.** `POST /run-now` only queues: it adds a cron trigger as the signed-in Administrator and returns **202** with a `requestId` (the trigger's
id), because the run itself is made by Odoo's cron and exists only once it starts. It is **409 `run_in_progress`** ("A DSS run is already queued or
running. It appears here when it has finished.") while a request is queued or an attempt is running, detected by two plain reads (a pending trigger,
or a fresh attempt marker that no run has finished) and never by taking the run's lock. A body is 422. `GET /run-now/{requestId}` answers 200 with
`state` `queued` (waiting for the cron), `running`, `done` or `failed` (with `runId`; `detail` carries a failed run's message) or `unknown` (not
known, or no longer known); a request id that is not a number is 404. A run killed at the time limit is recorded as a failed run on the job's next
start and not run again.

**Empty and failure states.**

| Case | HTTP | Answer |
|---|---|---|
| no run of that kind yet | 404 `not_found` | "No DSS run yet. Press Run now to start one." (`overview` is 200 with nulls) |
| a `run` that is not there (or another company's) | 404 `not_found` | `No DSS run "12"`; a non-numeric path id is 404 too |
| a failed run asked for data | 409 `run_failed` | "This run failed: <its message, at most 300 characters, never a stack trace>" |
| `/runs/{id}` of a failed run | 200 | `state: "failed"`, `error` |
| a part without enough data | 200 | `rows: []` with `dataStatus` (the engine's own sentence) |
| a run older than 8 days | 200 | `stale: true` and the age in `notice` |
| Run now while one is queued or running | 409 `run_in_progress` | the sentence above |
| Odoo down | 502 `upstream_unavailable` | the usual sentence |

**Forecast history.** `history` is the weekly units the forecast was trained on (`weekStart`, `units`, `censored`): stored for a product and the
total; a garment type is **summed from its products only when the run's product-to-type mapping is proven reliable** (every product names one type,
every product with sales is mapped, and the stored type forecast equals the sum of its products' forecasts in every week). Otherwise `history` is
null with `historyStatus.code = history_unavailable` and the reason. A run with no actuals has `history: []` and `historyStatus.code = not_enough_history`.

**What a run may change.** Reading these routes writes nothing in business tables. A run (and Run now) may change only: the `clothcraft_dss_*`
tables (run, forecast, backtest, restock, segment, alert, health, actual: append-only), the cron trigger and progress rows and Odoo's own `ir_cron`
bookkeeping (last call, failure count), the attempt marker (`ir_config_parameter` `clothcraft_dss.attempt`), and the admin session's last-seen time.
Proven with `pg_stat_user_tables` before and after (see `contract/README.md`).

## Settings (environment, or `backend/.env`)

| Setting | Meaning |
|---|---|
| `ODOO_API_KEY`, `ODOO_URL`, `ODOO_DB` | how the service reaches Odoo |
| `SESSION_SECRET` | 32+ characters; the HMAC key of the cookie. Required |
| `ALLOWED_ORIGINS` | comma-separated origins allowed on state-changing requests (dev: the Vite dev server and previews) |
| `TRUSTED_PROXIES` | addresses whose `X-Forwarded-For` / `X-Forwarded-Proto` are believed; `*` trusts anyone (**tests only**) |
| `COOKIE_SECURE` | force the `Secure` flag on or off (default: on over https) |
| `DELIVERY_LABEL` | the words on the delivery line (default `Free delivery`). **Delivery rates are not decided yet**: delivery is free until they are |
| `BANK_NAME`, `BANK_ACCOUNT_NAME`, `BANK_ACCOUNT_NUMBER` | where a bank transfer goes. Placeholders until the shop has a real account (the order page then warns "Do not send money") |

## How an order is placed

`POST /api/orders` validates the request (the delivery messages are the browser's, shared in `contract/delivery-validation.json`),
then calls ONE Odoo method, `clothcraft.api.place_order`, which does everything in a single Odoo transaction:

1. resolves the session to the customer, then takes an advisory lock on the Idempotency-Key and looks the key up in a fresh transaction
   (`sale_order.client_order_ref` = `api:<customer id>:<key>`). A repeated key, even at the same moment, returns the first order. A partial
   unique index on that column is the second line of defence;
2. prices the cart; any unknown, sold-out or short line returns `quote_not_ready` (the service answers 409 `stock_conflict`
   listing every short line), and a total different from the one the shopper saw returns `price_changed` (409 with the new quote);
3. inside a savepoint: creates the delivery address (a child of the customer), the order, confirms it (the **B6 stock guard**
   runs in `action_confirm`; there is no bypass) and creates the payment transaction. If the guard refuses, the savepoint rolls
   back everything and the guard's own sentence is returned (`guard_refused`, answered as 409 `stock_conflict`).

A refused order leaves no order, no address, no transaction and no reservation (tested). Cash on delivery and bank transfer are both
confirmed at once and reserve stock; bank transfer then shows `awaiting_payment`. Delivery addresses accumulate under the customer
(one per order); nothing removes them.

## Run it (dev)

Everything runs in Docker (the host has no Python). Odoo is switched to the dev database `clothcraft_dev` only, so the sim
database `clothcraft_sim` is never opened or touched by Odoo's cron jobs.

```
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d odoo api
```

1. `clothcraft_dev` is a restore of `clothcraft_sim_seed7_560c_20261017.dump` into a new database (never over another one).
2. `scripts/create_api_user.py` creates the service user `api_shop` and writes `ODOO_API_KEY=...` and `SESSION_SECRET=...` into
   `backend/.env` (gitignored; neither is ever printed). Re-run it to rotate the key (89 days); an existing `SESSION_SECRET` is kept.
3. The service listens on `127.0.0.1:8000`. In `frontend/`, `VITE_API=odoo npm run dev` makes Vite proxy `/api` to it, so the
   browser talks to one origin and no CORS is configured.

## Tests

```
# service unit tests (a pretend Odoo, no database)
docker run --rm -v "$PWD/backend:/srv" -v "$PWD/contract:/contract" -e CONTRACT_DIR=/contract -w /srv python:3.12.15-slim-trixie \
    sh -c "pip install -q -r requirements.lock && python -m pytest -q"
```

The Odoo side (`clothcraft.api`) is tested in `addons/clothcraft/tests/test_api.py`, `test_api_auth.py` and `test_staff.py`, on a throwaway
database only. `tests/test_auth_live.py` and `tests/test_staff_live.py` run against the real service and Odoo when `CONTRACT_BASE_URL` is
set (they register customers, place and move orders: a copy of `clothcraft_dev` only).

**Against the real service.** `tests/test_auth_live.py` and `tests/test_contract.py` register customers and place orders, so never aim
them at `clothcraft_dev`, `clothcraft_sim` or the live `clothcraft`. The way used: copy `clothcraft_dev` into a throwaway database
(`pg_dump` / `pg_restore` into `clothcraft_ctest`), start a second Odoo and a second API for it with explicit container names (the API with
`TRUSTED_PROXIES=*` and no `ALLOWED_ORIGINS`, so each test can present its own client address), run the two files with
`CONTRACT_BASE_URL` pointing at that API, then remove both containers and drop the database.

## Pinned

Image `python:3.12.15-slim-trixie`. Direct dependencies are in `requirements.txt`, the whole tree in `requirements.lock`
(`pip freeze`); regenerate the lock when the first changes. Accounts added no dependency (standard library only).

## The service user: `api_shop`

An internal user (`base.group_user`) in **one** ClothCraft group, "Storefront API service" (`clothcraft.group_api`). Never an
administrator, never in a ClothCraft staff group. Its whole extra access is three **read-only** lines, each added because a test
failed without it:

| Read access | Why |
|---|---|
| `clothcraft.garment.type` | the garment type code and name in the catalogue |
| `sale.order` | listing and reading a customer's orders |
| `sale.order.line` | the lines of those orders |

It has **no create, write or delete right on anything**, and **no access at all** to `clothcraft.api.session` and
`clothcraft.api.throttle` (only `Administrator` staff can read them). Inside the facade `sudo()` is used for: the variant free stock,
the simulation marker, an order's payment transaction (read), the `place_order` writes, and everything in register, sign-in, sign-out and
session checks (users, partners, sessions, counters). That is deliberate: if the key leaks, it cannot create a user or an order through the
generic `/json/2/<model>/create`; it can only call the facade, which validates and throttles. Tests prove the user cannot create users,
orders or partners, cannot read payments, stock moves, pickings, sessions or counters, and cannot delete orders.

## Demo stub: removed

The fixed demo customer, `ALLOW_DEMO_SESSION` and the `X-Demo-Session` header no longer exist, in the service or in the shop. The demo partner that
existed in `clothcraft_dev` was deleted after a verified dump (`clothcraft_dev_20261022.dump`) showed it had no orders, addresses, users or transactions.
In the browser mock, accounts are real in the mock's sense: made through the same forms, kept in this tab's sessionStorage, and gone when the tab closes.
