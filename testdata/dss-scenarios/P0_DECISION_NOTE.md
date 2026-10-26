# DSS scenario pack: P0 spike, decision note

Date: 2026-10-26. Database restored for the real load: `clothcraft_pack_20261026` (from `clothcraft_shop-postapply-s4e-20261026-150721.dump`, 573 tables, 59,283 rows, every table equal to the dump; nothing loaded into it yet). All spike writes went to a scratch copy that has been dropped.

## Decision

| Question | Result |
|---|---|
| Backdating technique | **T1** (set Odoo's clock with freezegun AND the transaction timestamp `cr._now` to the event time, per event). Accepted: the history rows of a T1 lifecycle equal a real-time control lifecycle in every column except ids, times and the test customer's own name (order audit, restock history, stock edit). Applies to all rows the ORM stamps: orders, deliveries, stock moves, payments, sessions, users, notifications, lots. |
| T2 (raw INSERT with the CSV time) | Works (the guard trigger allows INSERT; the row equalled the ORM row column for column). **Kept as the fallback** if `cr._now` ever misbehaves. |
| T3 (trigger switched off) | Works in a rolled-back transaction; **not needed**. UPDATE and DELETE on the audit table are refused as designed. |
| freezegun through the facade | Works for registration, quote, place order, staff moves, customer confirmation, restocks, stock edits, employees, the automatic-close job. |
| Design upload with a generated image | **Works** with Pillow only (one 200 px picture, 800 px preview, 1,024 px print): created, 32.01 sq in covered. No fallback needed. |
| Fake phone block `0900 000 xxxx` | Passes the service's own rule (also `0900-000-0001`, `+63 900 000 0001`). Whether that block is unassigned cannot be checked offline. |
| Stock guard | Refuses with `quote_not_ready` when the wanted quantity exceeds free stock; reserves at confirm, releases on cancel; ships at "shipped". |
| Baseline stock (D1) | Confirmed necessary: without the rebase, one Dec 2025 order against a seed-only variant makes the DSS's rebuilt on-hand go to -1 from 2025-12-03 to 2026-10-22. After moving the 243 seed moves (all stamped 2026-10-23 09:37:54 UTC) to 2025-09-30 08:00 Manila it reads 3, then 2. |
| Engine on such data | `simulated False`, Closed rule `closed_state`; unpaid transfer alert raised; health months follow the closing history line; a designed order adds 1 demand unit (fee line excluded). |
| Replay speed | about 1.75 s per full order lifecycle (11 committed calls, 0.16 s a call). Expect 10 to 15 minutes for the pack. |

## Rules the loader must follow (found in the spike)

1. Run every facade call as the **service user** (`env(user=<group_api user>)`), as the real API does: rows then carry its `create_uid`.
2. **Set `cr._now` and the frozen clock at the start of every event**, and commit after it (a commit resets `cr._now`). Everything, **including `quote`**, runs inside the frozen event; a quote outside it cannot see the session and reports a design as unavailable.
3. A **fresh session per event**, started a minute before it (staff sessions idle out after 2 hours, customers sooner), with a unique id; purge the sessions at the end.
4. Staff and Administrator calls pass `clothcraft_scope='staff'` or `'admin'` in the context; Administrator-only moves need an `admin` session.
5. The automatic close is the daily job `_cron_clothcraft_auto_close(now)`. In this database it runs **daily at 10:38 Manila** (the cron's own time of day; my earlier 02:00 assumption was wrong). An order delivered at D closes at the first daily run at or after D + 7 days; the history line gets that run's time, actor automatic, via cron.
6. **Back-steps allowed** (Administrator, note required, history line flagged `step_back`): out for delivery -> shipped (any payment), delivered -> out for delivery (paid bank transfer only), closed -> delivered (any). A delivered cash-on-delivery order **cannot** be stepped back. Scenario S14 uses out for delivery -> shipped.
7. Cancelling a paid bank transfer needs an Administrator and a note; the history note starts `REFUND DUE.`; the payment stays `done`, the reservation is released. Inventory Staff get `forbidden`.
8. The two-staff conflict: the second move sends the state it saw and gets `state_changed` ("changed by ..."), with one history line only.
9. The designed fee is 2.00 per covered sq in plus 20.00 per size step above Small (XXL = 4 steps); the generator can import `addons/clothcraft/design_fee.py` (pure Python) to price it.
10. The restock `received_on` may be backdated (the frozen clock sets "today"); Inventory Staff request, an Administrator approves and receives.
11. The two shop test staff accounts (ids 6 and 7, "Staff Inventory/Administrator (test)") and the Odoo admin (id 2) exist in the copy and will show in the employees list; decide in P1 whether to archive them.

## README sentence for D1 (to carry into the pack README)

> The only change to existing data: on the throwaway database, the shop's 243 opening-stock moves (dated 2026-10-23, 2026-10-24 in the dump) are re-dated to 2025-09-30 08:00 Manila, so that the shop's own stock is the opening stock of the test year. Their stock-edit history rows keep the original dates. Nothing in `clothcraft_shop` is changed.

## Not verified

`cr._now` is a private cursor attribute of this pinned Odoo build; the pack database was not loaded; Excel was not opened; the designed order was priced for one design and one size only.
