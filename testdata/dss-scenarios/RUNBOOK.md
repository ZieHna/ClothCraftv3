# Runbook: load the DSS scenario pack and look at it

For someone with **Windows PowerShell, Docker Desktop, Node.js and this repo**. No Claude Code needed. About 15 minutes the first time (most of it the load).
(`README.md` describes the data; its "Status" line dates from before the loader existed.)

**What you need besides the repo**
1. **One file from the owner:** `clothcraft_shop-postapply-s4e-20261026-150721.dump` (6 MB). It is not in git on purpose (dumps hold password hashes). Put it in the repo's `backups` folder (make the folder if it is missing).
2. **The product pictures (a second file from the owner):** `product-images-<date>.tgz` (5 MB). A dump holds the database rows but not the picture files, so without it the storefront shows broken images. Put it in the `backups` folder next to the dump; `restore` finds it by itself. (The owner makes it once with `.\scripts\pack_run.ps1 export-images`.)
3. **Your own `.env`** in the repo folder (the first command below). It is yours; nothing of anyone else's is needed.

All commands run in PowerShell, **from the repo folder** (the one that contains `scripts` and `frontend`). If PowerShell says "running scripts is disabled", put `powershell -ExecutionPolicy Bypass -File` before the script path, for example
`powershell -ExecutionPolicy Bypass -File .\scripts\pack_run.ps1 restore`.

The script only ever touches one database, `clothcraft_pack_20261026`. It never prints a password and is safe to run again: a second `load` is refused with a message.

| step | command | takes |
|---|---|---|
| a | start Docker Desktop | 1 min |
| b | `.\scripts\pack_run.ps1 restore` | 1 min (first time +3 to 6 min to build the Odoo image) |
| c | `.\scripts\pack_run.ps1 dryrun` | 15 s |
| d | `.\scripts\pack_run.ps1 load` | 8 min |
| e | `.\scripts\pack_run.ps1 check` | 15 s |
| f | `.\scripts\pack_run.ps1 serve -StartVite` | 1 min (+ 3 min for `npm install` once) |
| g | `.\scripts\pack_run.ps1 clean` | 15 s |

---

## a) Start Docker, make your `.env`

```powershell
Copy-Item .env.example .env      # then open .env in Notepad and put a password of your own after POSTGRES_PASSWORD=
docker info                      # must print "Server Version" and no error
```
**Expected:** `docker info` prints a block of text. **If it fails:** "error during connect" or "cannot connect": Docker Desktop is not running. Open it, wait until the whale says *Engine running*, try again.

## b) Restore the throwaway database

```powershell
.\scripts\pack_run.ps1 restore
```
**Expected (last lines):** `Restored: 573 tables, 59283 rows (the expected dump has 573 tables and 59283 rows).`, then `IMAGES copied=19 already_there=0 missing=0` (the product pictures, step "Product pictures" below), then `DONE: next step is ... dryrun`.
**If it fails**
- `I need the dump file ...`: the dump is not in `backups\`. Get it from the owner (see above), or pass its path: `.\scripts\pack_run.ps1 restore -Dump C:\path\file.dump`.
- `The database ... already exists`: it is already there. To start over: `.\scripts\pack_run.ps1 clean` and then `restore`.
- `.env must have a value after POSTGRES_USER=`: finish step a.

## Product pictures (part of restore; can be run again by itself)

```powershell
.\scripts\pack_run.ps1 images                              # uses the shop's own filestore on the owner's computer, or backups\product-images-*.tgz
.\scripts\pack_run.ps1 images -ImagesArchive C:\path\product-images-20261026.tgz
.\scripts\pack_run.ps1 export-images                      # owner only: makes backups\product-images-<date>.tgz
```
**Why:** a restored database knows which 19 picture files it needs (rows in `ir_attachment`) but a dump does not carry the files, so the API answers 404 for every garment picture. The step copies exactly those 19 files into the throwaway database's own filestore folder.
**Safe by design:** it checks that each file exists in the source first, never overwrites a file, never touches any other file or the database, and checks each copy (Odoo names a file by the SHA-1 of its content). A second run says `copied=0 already_there=19`.
**Expected:** `IMAGES copied=19 already_there=0 missing=0`. After `serve` the script also prints `Product pictures through the API: 19 of 19 answer 200.`
**If it says `missing=` more than 0:** the source does not have those files. Ask the owner for `product-images-<date>.tgz` (put it in `backups`) and run `images` again. The files are not generated or replaced by placeholders.

## c) Dry run (writes nothing)

```powershell
.\scripts\pack_run.ps1 dryrun -SelfTest
```
**Expected:** a list of lines starting `PASS`, then `DRY RUN PASSED: nothing was written`, then (with `-SelfTest`) a second list ending `SELFTEST PASSED`.
The self-test writes one test order, restock, stock count and employee, compares their history rows with real ones column by column, then rolls everything back.
**If a line says `FAIL`:** read it. The usual causes: the files in `testdata\dss-scenarios` were edited (the first check compares them with `manifest.csv`), or the dump is not the expected one (stock differs). Nothing was written, so fix and rerun.

## d) Load

```powershell
.\scripts\pack_run.ps1 load
```
**Expected:** the same `PASS` lines, the self-test, a line `D1 seed re-dated to 2025-09-30 ...`, `replaying 2138 events`, a `progress` line every 100 events, then

```
events replayed: 2109 | unexpected results: 0 | total time ~450 s
stock guard refusals (placements not created): 0 (expected 0)
state_changed answers (two staff, one order): 2 | the CSV expects 2 => MATCH
LOAD COMPLETE
```
It also writes `testdata\dss-scenarios\_local\accounts.csv` (two sign-in accounts: an Administrator and an Inventory Staff; open it yourself in Notepad) and `_local\load_log.csv` (one row per event). `_local` is ignored by git.
**If it fails**
- Lines starting `UNEXPECTED`: something answered differently from the CSV. The first one is the cause; the rest follow from it. Send the line to the owner.
- The window closes or Docker stops in the middle (sleep, restart): the database is half loaded. Run `clean`, `restore`, `load` again.
- `A second load is refused`: it is already loaded. That is fine; go to step e.

## e) Check

```powershell
.\scripts\pack_run.ps1 check
```
**Expected:** `orders: 370 in the database for 370 in the CSV`, `stock on hand: 4018 units ... differences: 0`, `employees listed by the admin page: 10`, ... `CHECK PASSED`.

## f) Look at it

```powershell
cd frontend; npm install; cd ..                  # once
.\scripts\pack_run.ps1 serve -StartVite
```
**Expected:** `The API answers on http://127.0.0.1:8001`, then a second window starts the website. Open **http://localhost:5174/admin**.
Sign in with `_local\accounts.csv`: the **admin** row at `/admin`, the **inventory** row at `/staff`. (Inventory at `/admin` is refused, which is the point.)
Without `-StartVite` the script prints the one command to run in a second window.
**If it fails:** `The API did not answer`: run `docker logs cc-pack-api` and `docker logs cc-pack-odoo` and read the last lines. A blank page: wait 30 s, the first request warms Odoo up. Port 5174 or 8001 busy: close the other program, or ask the owner for another port.

## g) Reset or remove

```powershell
.\scripts\pack_run.ps1 clean                       # removes the database, the two containers and _local
.\scripts\pack_run.ps1 restore; .\scripts\pack_run.ps1 load     # to start fresh
```
`clean` leaves your other databases and your own containers alone.

---

## Teach it: what happens and why

```
 testdata/dss-scenarios/*.csv          the story of a year: people, orders, who did what and when, restocks, stock counts
            |
            v   pack_run.ps1 load starts it
 scripts/pack_load.py  (inside "odoo shell")      for each event, in time order:
            |            1. set the clock to that moment      2. sign in as the person who did it (a fresh session)
            |            3. call the SAME method the website calls
            v
 the shop's real methods   register a customer, place an order (the stock guard runs here), staff move an order,
 (clothcraft.api)          customer confirms receipt, daily job closes, request/approve/receive a restock, count stock
            |            they check the rules and write the history rows with that moment's time
            v
 database clothcraft_pack_20261026   (PostgreSQL in Docker)
      |                         |
      v                         v
 API + website  /staff /admin   DSS "Run now": reads orders, stock, restocks and works out
 (serve)                        forecast, restock advice, customer segments, alerts, health
                                         |
                                         v
                                ground_truth.csv  what it SHOULD show (written in advance, from the rules; a mismatch may mean the pack is wrong)
```

| step | what it does | why |
|---|---|---|
| restore | makes the database from the dump | the same shop to start from every time: 19 products, 246 variants, 3 suppliers, 2 test orders |
| dryrun | checks files, stock, keys and the stock ledger; writes nothing | a rehearsal: you learn what is wrong before anything changes |
| self-test | proves history rows written for a past moment equal real ones | the pack is only believable if its history looks exactly like history the shop wrote itself |
| load | replays the year; first re-dates the shop's 243 opening-stock moves to 2025-09-30 (tables `stock_move`, `stock_move_line`, `stock_quant`) | so the shop's stock is the stock the year starts with; every order goes through the stock guard |
| check | compares the database with the CSVs | orders by state, totals, stock on hand per variant, restocks, employees |
| serve / clean | a one-off API on port 8001 and the website on 5174 / remove it all | look without touching your normal setup |

**What you should see** (the data is one year, 2025-10-01 to 2026-10-26)
- **/staff** (Inventory Staff): Orders list of 372 (370 + the shop's 2), with the board by state: 5 awaiting payment, 10 confirmed, 3 shipped, 2 out for delivery, 4 delivered, 335 closed, 13 cancelled. Open an order: the history shows who moved it and when, in working hours with a few late evenings. Two orders show an Administrator's **step back** with a note; one cancelled order shows **REFUND DUE**. Stock: **9** variants flagged low (one is the best-selling women's tee with 1 unit). Restocks: 31 (25 received, 3 approved of which one is overdue, 2 rejected, 1 waiting). Suppliers: Cebu Heritage delivers late.
- **/admin**: the dashboard (all time) shows about **260,042.50** earned from **335** closed orders (between roughly 12,000 and 28,000 a month; orders *placed* peak in December, but revenue counts when an order closes, a week or so later), "delivered, waiting" for 4 orders, and the stock and restock panels. Employees: **10** (8 from the pack, one of them archived, plus 2 test accounts). Customers: **113**. Orders summary: awaiting payment 5, the oldest 20 days.
- **/admin/dss** (Forecast and DSS): before any run both blocks say there is no run. Press **Run now**: within a minute (not yet timed on this data) the **Real data** block fills in (Order now, Critical alerts, Warning alerts, the engine's status words). The **Simulated** block stays empty on purpose: this database is real data, not a demonstration bundle. What the numbers should be is in `ground_truth.csv`.
