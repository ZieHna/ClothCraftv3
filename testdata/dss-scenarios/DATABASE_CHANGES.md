# Database change log: DSS scenario pack work (26 Oct 2026)

What was done to databases, containers and database files during the DSS scenario pack work (slices P0 to P3, fixes F1 to F3, the S5 screens, and the last investigation).
Written from what the work recorded; items marked **unverified** are not confirmed. Times are UTC unless a zone is named.

## Summary

| Database | Changed? | How |
|---|---|---|
| `clothcraft_pack_20261026` | **Yes** (created and loaded) | restored from a dump, loaded with the pack, DSS runs written |
| `clothcraft_shop` | No | read-only SELECTs only |
| `clothcraft_dev`, `clothcraft_demo`, `clothcraft_sim`, `clothcraft`, `clothcraft_usd_old` | No | read-only SELECTs only (counts) |
| Spike database (P0) | Created, then dropped | throwaway, gone |
| `clothcraft_dss_*`, `clothcraft_test`, `clothcraft_ctest` | Not touched, not inspected | |

No commits, nothing staged. `config/odoo.conf`, compose files and `backend/.env` were not changed.

## 1. `clothcraft_pack_20261026`

### 1.1 Created (P0, P2)
- Restored from `backups/clothcraft_shop-postapply-s4e-20261026-150721.dump`: 573 tables, 59,283 rows (verified after restore).
- A P0 spike database and the P0 volume `cc-pack-data` were used for tests and then removed.
- A first load attempt was killed by a Docker or host shutdown (about 09:50 UTC, 112 of 370 orders in). That was not caused by the loader. The database was cleaned (`pack_run.ps1 clean`), restored again and loaded from scratch.

### 1.2 Loaded (P2, `scripts/pack_load.py`)
- 2,109 events replayed through the shop's own facade (`clothcraft.api`) with a back-dated clock; 0 unexpected results, 0 stock-guard refusals, 2 `state_changed` answers (equal to the CSV).
- Result: 370 pack orders (372 with the shop's two), 112 customers (115 customer users in total), 8 pack employees (10 listed by the admin page with the 2 test accounts), 31 restocks, 118 receipt lines (1,154 units), 38 stock counts, stock on hand 4,018 units with 0 per-variant differences, 1,501 order audit lines.
- Marker written: `ir_config_parameter clothcraft.scenario_pack` = `loaded:2d0d4e52943754c3`. Auto-close days set to 0.
- **D1 rebase** (pack database only): the shop's opening-stock moves were re-dated to 2025-09-30 08:00 Manila: `stock_move.date` 243 rows, `stock_move_line.date` 243 rows, `stock_quant.in_date` 488 rows. (These were copies inside the pack database; the real shop database was not rebased.)
- 36 tables changed; total rows went from 59,283 to 74,134.
- Sign-in accounts for testing were created and written to `testdata/dss-scenarios/_local/accounts.csv` (git-ignored; passwords are not recorded here).
- Verified loaded dump: `backups/clothcraft_pack_20261026-loaded-20261026-183730.dump` (12,259 entries; scratch restore showed 573 tables / 74,134 rows).

### 1.3 DSS runs written (rows in `clothcraft_dss_*`)
| Run | State | Started | Took | Note |
|---|---|---|---|---|
| 1 | done | 11:00:29 | 59.6 s | first run, from the old engine |
| 3 | **failed** | 13:15:35 | 0 s | "Interrupted: … time limit or server restart". Queued request 15; my restart of `cc-pack-odoo` interrupted it. Not retried automatically. |
| 4 | done | 13:15:58 | 73.6 s | first run with the F3 engine (metrics and notes fixes) |
| 5, 6, 7 | done | 13:24, 13:49, 13:55 | 63.3 / 51.6 / 49.5 s | **unverified**: not made by me knowingly; presumably "Run now" presses during testing |

Run id 2 is not present (its number was never kept). Run 1 is the stored run the P3 comparison used. Runs 4 and later carry the corrected snaive metrics and the real-run-only notes. Run 1's stored numbers were never edited.

### 1.4 Housekeeping changes seen after the load (not business data)
Row counts changed in `bus_bus`, `clothcraft_api_session` (38 to 28), `clothcraft_api_throttle` (2 to 0), `ir_cron_progress`, `ir_cron_trigger`, `orm_signaling_registry`, `res_users_log`, one extra `ir_config_parameter` row, and `stock_quant` 924 to 897 (looks like Odoo clearing empty quants). No order, customer or stock business row changed in P3.

### 1.5 Files outside the database
- Pack filestore folder `…/filestore/clothcraft_pack_20261026` holds 39 to 41 files (design pictures from the load).
- **The 19 product pictures are not in it.** The database has 19 `image_1920` attachments pointing at files that exist only in `filestore/clothcraft_shop` (19 of 19 there, 0 of 19 in the pack folder). This is why the pack storefront shows broken category images (pack API answers 404). **Not fixed yet; awaiting approval.**

## 2. Other databases: read only
- `clothcraft_shop`: 2 orders (S00001 delivered, S00002 closed), 3 customers, 19 products, 245 done stock moves, 2 DSS runs (from before this work).
- `clothcraft_demo`: counts looked at; not changed. The planned rebuild of `clothcraft_demo` and regeneration of the simulation bundle were **not done**.
- Nothing was written to `clothcraft_shop`, `clothcraft_dev`, `clothcraft_sim`, `clothcraft` or `clothcraft_usd_old`.

## 3. Containers and volumes
- The dev stack (`api`, `odoo`, `mcp-db`) was stopped by a host event and brought back with `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db odoo api` and `docker start clothcraft-mcp-db`. No data change.
- `cc-pack-odoo` was restarted once (to load the new engine code); that interrupted request 15 (run 3 above).
- The old P0 volume `cc-pack-data` was removed. No `docker prune`, `down` or volume removal of the shared volumes (`clothcraft-db`, `clothcraft-odoo`).

## 4. Code that changes what the DSS stores (not database writes)
- F3 (engine): `engine/forecast.py` `metrics()` now scores only rows that have a forecast; notes split into generic and simulation notes (`notes_for`); `engine/bundle.py` writes them. Effects: seasonal-naive rows in new runs show their true n (14 instead of 90, WAPE 76.4% instead of 19.85%); real runs no longer carry "Simulated data…" notes. Other methods' stored numbers are identical to run 1.
- Hashes before and after are in the F3 report; the files changed were `forecast.py`, `bundle.py` and their two test files.

## 5. Backups
All under `C:\Users\mainezie\clothcraft-backups\` (not in git): `repo-p3-20261026-1905.zip`, `frontend-s5b-20261026.zip`/`.tar.gz`, `frontend-f1-20261026.tar.gz`, `f3-dss-20261026.tar.gz`, `f3-frontend-20261026.tar.gz`, and the loaded pack dump above in the repo's `backups/` folder. The pack dump does **not** include the filestore.

## 6. Open items before any migration
1. Copy the 19 product pictures into the pack filestore (and add it to `pack_run.ps1 restore`): awaiting your approval.
2. Decide whether the pack stays a separate database (recommended) or is loaded into `clothcraft_shop`.
3. Confirm who started DSS runs 5 to 7 (harmless, but they are in the table).
4. `clothcraft_demo` rebuild and simulation bundle regeneration remain pending as their own step.

---

# F4: integration rehearsal (26 Oct 2026, evening)

`clothcraft_shop` was **not written to**. Everything below happened in new rehearsal copies, the pack database's filestore, and local files.

## Backups of the real shop (verified)
- `backups/clothcraft_shop-preintegration-20261026-221441.dump` (6.25 MB, 573 tables with data). Verified by restoring it into a clone with `--exit-on-error` (counts matched: 2 orders, 245 stock moves, 913 attachments).
- `backups/clothcraft_shop-filestore-preintegration-20261026-221441.tgz` (11.1 MB, 543 files). Verified by extracting it into a clone folder (543 files).
- `backups/shop-counts-before-integration.txt`: customers 3, products 19, variants 247, orders 2, order lines 3, stock moves 245, stock on hand 3,686 units, suppliers 3, restocks 0, designs 5, DSS runs 2.
- `backups/product-images-20261026.tgz` (5.2 MB, the 19 product picture files; made by `pack_run.ps1 export-images`).

## Databases created (both are throwaway rehearsal copies, restored from the backup above)
| Database | What was done to it |
|---|---|
| `clothcraft_shop_rehearse` ("A") | pack loaded with the D1 date rebase (2,109 events, 0 unexpected, 0 guard refusals, check passed). The D1 undo was tested (all 974 original dates restored, verified against `clothcraft_shop`), then the saved D1 dates were re-applied with SQL to reproduce the state. One DSS run (run 3). |
| `clothcraft_shop_rehearseb` ("B") | pack loaded with D1 skipped (`PACK_SKIP_D1=1`, rehearsal copies only): 2,109 events, 0 unexpected, check passed. Three DSS runs (runs 3, 4, 5), each with a different in-memory reconstruction of the daily balance (the engine files were not edited). |
Both filestore folders (`.../filestore/clothcraft_shop_rehearse` and `...rehearseb`) were extracted from the shop backup. Nothing was removed from any other database.

## Pack database filestore
- 19 product picture files were copied into `filestore/clothcraft_pack_20261026` (each checked against its SHA-1 name; nothing overwritten; second run copied 0). The pack API now returns 200 for every product picture.

## Local files
- A clean-up command of mine deleted the contents of `testdata/dss-scenarios/_local` except `accounts.csv`: lost `api.env` (the pack API key file; `pack_run.ps1 serve` makes a new one), `load_log.csv` and `p3_comparison.csv` of the pack load, and the rehearsal folders' logs (including the D1 originals file, whose undo was already verified). No database or tracked file was affected.

## Still true
- `clothcraft_shop`: 2 orders, unchanged; no pack data in it yet.
- D1 on the real shop has NOT been run. Waiting for a decision (see the F4 report).

---

# F5: engine change validated on the rehearsal clones (26 Oct 2026, late evening)

`clothcraft_shop` was **not touched**. Original stock dates were not changed anywhere.

## Code
- `addons/clothcraft_dss/engine/transform.py`: new `opening_moves`, `backdate_opening`; `daily_balance` uses them (opening-balance rule). `engine/tests/test_transform.py`: 13 new tests. The other 31 addon .py files are byte-identical (SHA-256 before and after recorded).
- `scripts/pack_load.py` (rehearsal-only `PACK_SKIP_D1`, `PACK_LOCAL`, `undo_d1`), `scripts/pack_compare.py` (`PACK_RUN_ID`): helper changes, no effect on the shop.

## Databases
| Database | Change in this step |
|---|---|
| `clothcraft_shop_rehearse` (A, D1 applied) | DSS run 4 (new engine). No other change. |
| `clothcraft_shop_rehearseb` (B, original dates) | DSS runs 6 and 7 (new engine), read-only statistics. Stored `stock_move`, `stock_move_line` and `stock_quant` hashes were identical before and after the runs. |
| `clothcraft_shop_testrun` (NEW scratch copy of the shop backup) | restored from the verified dump and filestore; `odoo -u clothcraft_dss --test-tags /clothcraft_dss` run on it, twice (new engine, then old `transform.py` as a baseline). The module update re-applied the addon's own data in this scratch copy only. It can be dropped on request. |
Neither rehearsal clone was deleted or recreated. No wildcard deletion was used.

---

# F6: the scenario pack is now in `clothcraft_shop` (26 Oct 2026, 23:17 to 23:32 Manila)

## SYNTHETIC DATA NOTICE
Everything the pack added to `clothcraft_shop` is **invented, reconstructed demo data**. It is not real sales, real customers or real staff, and it has not been independently verified. It was made by `scripts/pack_generate.py` and replayed through the shop's own API by `scripts/pack_load.py` so that the shop and the DSS have a year of history to show.
How to recognise it (all of these are safe to query):
- customers and employees: `login` / email ends in `@example.test` (phones in the block `0900 000 xxxx`);
- orders: `sale_order.client_order_ref` like `api:<id>:pack:O####`; restocks, receipts, stock counts and designs were created by the same replay;
- the database marker: `ir_config_parameter clothcraft.scenario_pack` = `loaded:2d0d4e52943754c3`;
- the shop's own records are the 2 orders `S00001` and `S00002`, the 3 original customers, the 19 products, 3 suppliers and the 5 original designs.
Known label gap: the DSS screens call a run "REAL DATA" when the database has no simulation marker. The shop now has this synthetic history, so a DSS run on it is badged REAL DATA although the orders are synthetic. The badge was not changed (not part of this approval); treat any number in the shop as demo data.

## What was run
`scripts/pack_load.py` with `PACK_MODE=load`, `PACK_ALLOW_SHOP=I_HAVE_A_VERIFIED_BACKUP`, from 15:17:39 UTC, 470 s. D1 did NOT run (the loader skips it on the shop and the D1 routine refuses to run there). The dev API container was stopped during the load and restarted after; the Odoo container was restarted afterwards to clear its caches.

## Result
2,109 events, 0 unexpected results, 0 stock-guard refusals, 2 `state_changed` answers (equal to the CSV), loader `check` passed. Marker set. `auto_close_days` left at 7.

| | before | after | change |
|---|---|---|---|
| customer users | 3 | 115 | +112 |
| employees | 3 | 11 | +8 |
| partners | 14 | 504 | +490 |
| orders | 2 | 372 | +370 |
| order lines | 3 | 579 | +576 (552 garment lines + 24 print-fee lines) |
| order history lines | 7 | 1,501 | +1,494 |
| stock moves (done) | 245 | 956 (917) | +711 (+672) |
| stock move lines | 245 | 940 | +695 |
| stock quants | 488 | 975 | +487 |
| stock on hand | 3,686 | 4,018 | +332 (= the CSV ledger end) |
| restocks / lines | 0 / 0 | 31 / 147 | |
| designs | 5 | 29 | +24 |
| stock counts (stock edits) | 0 | 38 | +38 |
| attachments | 913 | 1,049 | +136 |
| suppliers, products, variants | 3, 19, 247 | same | matched, not duplicated |
| DSS runs | 2 | 3 | +1 (run 3, made through Run now, 59.1 s) |
The post-load counts equal rehearsal clone B (original dates) on every line compared.

## Original records
- All 245 original stock moves and 245 move lines: id, date, quantity, state identical to the snapshot taken before the load. The 243 seed moves are still dated 2026-10-23; none is dated 2025-09-30.
- All 488 original quants keep their `in_date`, product and lot (204 changed quantity because of the replayed sales and counts).
- Hashes of products, variants, suppliers, the 2 shop orders with their lines and history, the 5 original designs, the 3 original customers and the 19 product-image attachments equal a pristine copy restored from the backup.

## Backups (kept; nothing deleted)
- before: `backups/clothcraft_shop-preintegration-20261026-221441.dump` and `...-filestore-preintegration-...tgz`; counts and stock snapshot: `backups/shop-counts-*.txt`, `backups/shop-stock-snapshot-before-load.txt`.
- after (checkpoint): `backups/clothcraft_shop-postintegration-20261026-233154.dump` and `...-filestore-postintegration-...tgz`.
- pack database `clothcraft_pack_20261026`, rehearsal clones `clothcraft_shop_rehearse` and `clothcraft_shop_rehearseb`, scratch copy `clothcraft_shop_testrun`, and all scenario CSV and reference files are unchanged and kept.
- Local files written for the load: `testdata/dss-scenarios/_local/shop/accounts.csv` (two sign-in accounts, an Administrator and an Inventory Staff; passwords only in that file) and `load_log.csv`.
