# DSS scenario pack (slice P1: generated, NOT loaded anywhere yet)

A year of a small shop, 2025-10-01 to 2026-10-26 (Manila time, +08:00), built to test the decision-support (DSS) module on its **real** path:
orders, lifecycles acted by named employees, restocks, receipts and stock counts, plus `ground_truth.csv`: what the DSS should show, written in advance.

**Read this first.** Every expected value in `ground_truth.csv` comes from *reading the DSS code and rules* and from arithmetic over these CSVs. It is not
a measurement. **If the DSS disagrees with a row, the pack may be wrong as easily as the DSS**: check the row's `rule` and `note` before blaming either.

Fake data only: invented names, `example.test` emails, no passwords anywhere, phone numbers in the fake block `0900 000 xxxx`, invented streets.

## How it is made

`python3 scripts/pack_generate.py` (standard library only) writes every file here. A fixed seed (`clothcraft-dss-scenarios-v1`), no wall clock, no database: running it twice
gives byte-identical files (`manifest.csv` holds the SHA-256 of each). The catalogue, prices, opening stock, supply lines and provinces in `reference/`
were copied once, from a database dump file, by `scripts/pack_extract_baseline.py`.
The generator keeps a **stock ledger**: it never schedules an order the shop's stock guard would refuse, so a product with no stock simply gets no orders.

## Conventions

UTF-8 with a byte-order mark and CRLF line endings (Excel opens them directly); a header row; text ids (`C001` customers, `O0001` orders, `V0001` order moves,
`E01` employees, `R001` restocks, `D001` designs, `A001` stock counts, `SUP1` suppliers) so Excel keeps them as text; timestamps `2026-03-31T23:50:00+08:00`;
money in pesos, VAT included, two decimals. `orders.client_order_ref` (`pack:O0001`) is the key the loader (slice P2) will store on each order.

## Files

| file | rows | what |
|---|---|---|
| employees.csv | 8 | the 8 employees (5 Inventory Staff, 2 Administrators, 1 archived), working days and hours |
| customers.csv | 112 | customers with their plan, registration time and delivery details |
| orders.csv | 370 | one row per order with its expected end state and total |
| order_lines.csv | 552 | what each order contains (and the print fee of designed lines) |
| order_events.csv | 1496 | every move of every order: who, when, from, to, expected outcome |
| payments.csv | 370 | payment of each order at the end |
| designs.csv | 24 | designed garments |
| design_layers.csv | 43 | the elements of each design (boxes inside the print area) |
| suppliers.csv | 3 | the three suppliers, promised and actual delivery behaviour, unavailable dates |
| restock_requests.csv | 31 | restock requests and what became of them |
| restock_lines.csv | 147 | lines of each restock (quantity, unit cost) |
| receipts.csv | 118 | goods received |
| stock_adjustments.csv | 38 | stock counts and write-downs by staff |
| ground_truth.csv | 357 | expected DSS and screen results, with the rule behind each |
| reference/baseline_orders.csv | 2 | the shop's two test orders (copied from the dump) |
| reference/design_settings.csv | 1 | print-fee settings (copied from the dump) |
| reference/products.csv | 19 | 19 garments, prices, print boxes (copied from the dump) |
| reference/provinces.csv | 83 | province codes the shop accepts (copied from the dump) |
| reference/suppliers.csv | 3 | the 3 shop suppliers (copied from the dump) |
| reference/supply_lines.csv | 199 | what each supplier supplies, at what unit cost (copied from the dump) |
| reference/variants.csv | 246 | 246 variants: price, opening units (copied from the dump) |
| manifest.csv | | file names, row counts, SHA-256 |

## The scenarios (ids are used in `scenarios` columns and in `ground_truth.csv`)

| id | what is planted | where to look |
|---|---|---|
| S01 | Baby Hoodie (all variants) written down after water damage on 3 Dec 2025, last packs written off 17 Dec; restock requested 18 Dec arrives 24 Jan: weeks with no stock and no sales | DSS Forecast (censored weeks), staff stock |
| S02 | Women Tee climbs about eightfold over the year | DSS Forecast (direction up) |
| S03 | Men Tank Top fades to a tenth | DSS Forecast (direction down) |
| S04 | Men Crew Tee is the steady seller | DSS Forecast (flat) |
| S05 | four VIP customers (about 15 orders each, the last one recent) | DSS Segments (champions) |
| S06 | one-time customers: 14 recent, 24 lapsed | DSS Segments (new / one-time, lapsed) |
| S07 | eight regulars who stopped ordering after January | DSS Segments (at risk / hibernating) |
| S08 | customers whose orders were all cancelled, and customers with an order but none Closed | DSS Segments (not scored) |
| S09 | unpaid bank transfers placed 2, 5, 10 and 20 days before the run day | DSS alerts (none, info, warning, critical) |
| S10 | Women Tee, black, M ends with one sellable unit after a stock count | DSS alerts (forecast stock-out, low stock), DSS Restock, staff stock |
| S11 | Cebu Heritage delivers late (14 to 21 days against 7 to 10); one open restock is overdue; Marikina is unavailable 3 to 10 Nov over an open restock | DSS Restock (lead times), DSS alerts |
| S12 | 24 designed garments: the print fee is revenue, never demand | DSS Forecast (units), admin dashboard |
| S13 | two orders confirmed by the customer at 23:50 on 31 Mar and 00:20 on 1 Apr (Manila) | DSS Health (March / April revenue) |
| S14 | an Administrator steps an order back (out for delivery -> shipped) with a note | staff order history |
| S15 | paid bank transfers cancelled by an Administrator: "REFUND DUE" | staff order history, not demand, not revenue |
| S16 | two staff press the same move on one order; the second is refused | staff order history (one line) |
| S17 | Nov-Dec 2025 peak, slow Jan-Feb 2026, weekend and payday rhythm (the model cannot see seasons, paydays or promotions: documented limits) | DSS Health |
| S19 | delivered less than 7 days ago and still waiting for the customer: not earnings | admin dashboard |
| S20 | one employee left on 27 Feb 2026 (archived) | admin employees, order history |
| S21 | everything above is REAL data (no simulation marker) | DSS Overview |

## Facts that are not the pack's

* **Pre-existing accounts, separate from the pack's 8 employees (E01 to E08):** the Odoo administrator and the shop's two test staff accounts
  ("Staff Inventory (test)" and "Staff Administrator (test)"). They exist in the database the pack will be loaded into. The pack does not use them.
  The admin Employees page lists the two test staff accounts with the pack's 8 (10 in all); the Odoo administrator is never listed there.
* **The shop's two test orders** (S00001 delivered, S00002 closed, both 24 October 2026, one customer) already exist in the database. They count in the DSS
  (units, revenue in October 2026, one scored customer) and in `ground_truth.csv`. See `reference/baseline_orders.csv`.
* **The one change to existing data (D1):** on the throwaway database only, the shop's 243 opening-stock moves (dated 2026-10-23 in the dump) are re-dated
  to 2025-09-30 08:00 Manila, so that the shop's own stock is the opening stock of the test year. Their stock-edit history rows keep the original date.
  Nothing in `clothcraft_shop` is changed. The opening stock is large for this demand, so the planted shortages use stock counts (write-downs), not sales.
* **Order numbers** in Odoo (S00003 and up) follow the load order; the two shop test orders have the lowest numbers although they are dated last.
* **The daily "close delivered orders" job** runs at 10:38 Manila in the shop's database: an order delivered at D closes at the first run at or after D + 7 days
  unless the customer confirmed earlier (about 60% do). Orders that would close after 2026-10-26 09:00 are left delivered.
* **Data ends 2026-10-26 09:00; the DSS run is for the day 2026-10-26.** A run on another day shifts alert ages and recency; compare with a pinned as-of date then.

## Status

Slice P1: generated and validated only. Nothing is loaded. The loader (P2) will replay `orders.csv`, `order_events.csv`, `restock_*`, `receipts.csv` and
`stock_adjustments.csv` through the shop's real code, each step inside its own frozen clock, then stop if the history rows differ from real ones.
