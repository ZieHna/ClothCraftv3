-- Read-only checks that the simulated data is sane. Run against the seeded database:
--   Get-Content scripts/verify_sim.sql | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d clothcraft_sim'
-- "asof" is the last simulated order, so the results do not drift as real time passes.

\echo '--- Q1 monthly demand by product (confirmed orders, cancelled excluded)'
select to_char(date_trunc('month', so.date_order),'YYYY-MM') as month, pt.name->>'en_US' as product, sum(l.product_uom_qty)::int as units, count(distinct so.id) as orders
from sale_order_line l join sale_order so on so.id=l.order_id join product_product pp on pp.id=l.product_id join product_template pt on pt.id=pp.product_tmpl_id
where so.state='sale' group by 1,2 order by 1,2;

\echo '--- Q2 days of stock left (free qty / average daily demand over the last 30 days of data): lowest 8, and how many variants are at zero'
with asof as (select max(date_order) d from sale_order where state='sale'),
sales as (select l.product_id, sum(l.product_uom_qty)/30.0 as daily from sale_order_line l join sale_order so on so.id=l.order_id, asof
          where so.state='sale' and so.date_order > asof.d - interval '30 days' group by 1),
stock as (select q.product_id, sum(q.quantity - q.reserved_quantity) as free from stock_quant q join stock_location loc on loc.id=q.location_id
          where loc.usage='internal' group by 1)
select pp.default_code, round(st.free::numeric,0) as free, round(coalesce(s.daily,0)::numeric,2) as per_day,
       case when coalesce(s.daily,0) > 0 then round((st.free/s.daily)::numeric,1) end as days_left
from stock st join product_product pp on pp.id=st.product_id left join sales s on s.product_id=st.product_id
where pp.default_code like 'SIM-%' order by days_left nulls last limit 8;
select count(*) filter (where free<=0) as variants_at_zero, count(*) as variants_with_stock_rows
from (select product_id, sum(quantity-reserved_quantity) free from stock_quant q join stock_location l on l.id=q.location_id where l.usage='internal' group by 1) x;

\echo '--- Q3 supplier lead times: purchase order confirmed -> receipt done (days)'
select rp.name as supplier, count(distinct po.id) as pos, round(avg(extract(epoch from (sp.date_done - po.date_approve))/86400)::numeric,1) as avg_days,
       round(min(extract(epoch from (sp.date_done - po.date_approve))/86400)::numeric,1) as min_days, round(max(extract(epoch from (sp.date_done - po.date_approve))/86400)::numeric,1) as max_days
from purchase_order po join res_partner rp on rp.id=po.partner_id join purchase_order_line pol on pol.order_id=po.id
join stock_move sm on sm.purchase_line_id=pol.id join stock_picking sp on sp.id=sm.picking_id
where sp.state='done' and po.origin='SIM' group by 1 order by 1;

\echo '--- Q4 customer order counts (distribution) and spend'
with c as (select partner_id, count(*) n, sum(amount_total) spent from sale_order where state='sale' group by 1)
select case when n=1 then '1' when n<=3 then '2-3' when n<=8 then '4-8' else '9+' end as orders, count(*) as customers, round(avg(spent)::numeric,0) as avg_spent, max(n) max_orders
from c group by 1 order by min(n);

\echo '--- Q5 cancelled, confirmed, drafts left behind (expect 0), and stuck unpaid bank transfers (3+ days old, not delivered)'
select count(*) filter (where state='cancel') as cancelled, count(*) filter (where state='sale') as confirmed, count(*) filter (where state='draft') as drafts_left_behind from sale_order;
with asof as (select max(date_order) d from sale_order)
select count(*) as stuck_unpaid_bank_transfers, min(asof.d - tx.last_state_change) as youngest, max(asof.d - tx.last_state_change) as oldest
from sale_order so join sale_order_transaction_rel r on r.sale_order_id=so.id join payment_transaction tx on tx.id=r.transaction_id
join payment_provider pr on pr.id=tx.provider_id, asof
where so.state='sale' and tx.state='pending' and pr.custom_mode='wire_transfer' and asof.d - tx.last_state_change >= interval '3 days'
  and exists (select 1 from stock_picking sp where sp.sale_id = so.id and sp.state not in ('done','cancel'));

\echo '--- Q6 stock sanity: negative or over-reserved quants (expect 0)'
select count(*) as bad_quants from stock_quant q join stock_location loc on loc.id=q.location_id where loc.usage='internal' and (q.quantity < 0 or q.reserved_quantity > q.quantity);

\echo '--- Q7 units add up: ordered = delivered + reserved/waiting; received - delivered = on hand'
select (select sum(l.product_uom_qty) from sale_order_line l join sale_order so on so.id=l.order_id where so.state='sale')::int as ordered,
       (select sum(sm.quantity) from stock_move sm join stock_location d on d.id=sm.location_dest_id where sm.state='done' and sm.sale_line_id is not null and d.usage='customer')::int as delivered,
       (select sum(sm.product_uom_qty) from stock_move sm where sm.state in ('assigned','confirmed','partially_available') and sm.sale_line_id is not null)::int as reserved_or_waiting;
select (select sum(qty_received) from purchase_order_line where order_id in (select id from purchase_order where origin='SIM'))::int as received,
       (select sum(sm.quantity) from stock_move sm join stock_location d on d.id=sm.location_dest_id where sm.state='done' and sm.sale_line_id is not null and d.usage='customer')::int as delivered,
       (select sum(q.quantity) from stock_quant q join stock_location l on l.id=q.location_id where l.usage='internal')::int as on_hand;

\echo '--- Q8 payment cron safety: simulated transactions not flagged as processed (expect 0)'
select count(*) filter (where not tx.is_post_processed) as not_processed, count(*) as total
from payment_transaction tx join sale_order_transaction_rel r on r.transaction_id=tx.id join sale_order_tag_rel t on t.order_id=r.sale_order_id;

\echo '--- Q9 first delivery of a variant never before its first receipt (expect 0 violations)'
select count(*) as violations from (
  select sm.product_id, min(sp.date_done) first_out from stock_move sm join stock_picking sp on sp.id=sm.picking_id join stock_location d on d.id=sm.location_dest_id
  where sm.state='done' and d.usage='customer' group by 1) o
join (select sm.product_id, min(sp.date_done) first_in from stock_move sm join stock_picking sp on sp.id=sm.picking_id join stock_location s on s.id=sm.location_id
      where sm.state='done' and s.usage='supplier' group by 1) i on i.product_id=o.product_id where o.first_out < i.first_in;

\echo '--- Q10 order dates, and the payment method mix'
select min(date_order)::date first_order, max(date_order)::date last_order from sale_order;
select pr.custom_mode, count(*) from sale_order so join sale_order_transaction_rel r on r.sale_order_id=so.id join payment_transaction tx on tx.id=r.transaction_id join payment_provider pr on pr.id=tx.provider_id group by 1;
