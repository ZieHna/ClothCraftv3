"""DSS scenario pack, step 0: copy the facts the generator needs out of a database DUMP FILE into testdata/dss-scenarios/reference/.

No database is touched or needed: the input is the text that `pg_restore --data-only -f FILE -t TABLE ... DUMP` writes (that command reads the
dump file only and makes no connection). Run once; the generator (scripts/pack_generate.py) then works from the committed CSVs alone.

    pg_restore --data-only -f ref.sql -t product_product -t product_template -t product_template_attribute_value -t product_variant_combination \
        -t product_attribute_value -t product_attribute -t clothcraft_garment_type -t stock_move -t stock_location -t sale_order \
        -t sale_order_line -t clothcraft_order_audit -t res_country_state -t res_country -t clothcraft_supplier -t clothcraft_supplier_line \
        -t clothcraft_design_pricing DUMP
    python3 scripts/pack_extract_baseline.py ref.sql testdata/dss-scenarios/reference

Only catalogue, price, stock, supplier and province facts and the two shop test orders (customers anonymised to B1, B2) are copied. No
personal data, no credentials. Pure standard library.
"""
import csv
import datetime
import json
import os
import re
import sys

MANILA = datetime.timedelta(hours=8)


def unescape(value):
    if value == '\\N':
        return None
    return re.sub(r'\\(.)', lambda m: {'t': '\t', 'n': '\n', 'r': '\r', '\\': '\\'}.get(m.group(1), m.group(1)), value)


def read_tables(path):
    tables, current = {}, None
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            if line.startswith('COPY public.'):
                match = re.match(r'COPY public\.(\w+) \((.*)\) FROM stdin;', line)
                current = match.group(1)
                tables[current] = {'cols': [c.strip().strip('"') for c in match.group(2).split(',')], 'rows': []}
            elif current and line.rstrip('\n') == '\\.':
                current = None
            elif current:
                tables[current]['rows'].append([unescape(x) for x in line.rstrip('\n').split('\t')])
    return tables


def records(tables, name):
    t = tables[name]
    return [dict(zip(t['cols'], row)) for row in t['rows']]


def name_of(value):
    """A translated jsonb name -> its English text."""
    try:
        data = json.loads(value)
        return data.get('en_US') or next(iter(data.values()))
    except (TypeError, ValueError):
        return value


def iso_manila(utc_text):
    when = datetime.datetime.fromisoformat(utc_text.split('.')[0]) + MANILA
    return when.strftime('%Y-%m-%dT%H:%M:%S+08:00')


def write_csv(path, header, rows):
    with open(path, 'w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle, lineterminator='\r\n')
        writer.writerow(header)
        writer.writerows(rows)
    print(f'{os.path.basename(path):24} {len(rows):5} rows')


def main(source, out):
    os.makedirs(out, exist_ok=True)
    T = read_tables(source)
    gtypes = {r['id']: r for r in records(T, 'clothcraft_garment_type')}
    templates = {r['id']: r for r in records(T, 'product_template')}
    attr_name = {r['id']: name_of(r['name']) for r in records(T, 'product_attribute')}
    value = {r['id']: r for r in records(T, 'product_attribute_value')}
    ptav = {r['id']: r for r in records(T, 'product_template_attribute_value')}
    combos = {}
    for r in records(T, 'product_variant_combination'):
        combos.setdefault(r['product_product_id'], []).append(r['product_template_attribute_value_id'])
    location = {r['id']: r['usage'] for r in records(T, 'stock_location')}

    # opening units (the shop's seed: inventory -> internal, done) and units the two shop orders already shipped (internal -> customer)
    seed, shipped = {}, {}
    for m in records(T, 'stock_move'):
        if m['state'] != 'done':
            continue
        src, dst = location.get(m['location_id']), location.get(m['location_dest_id'])
        qty = float(m['quantity'])
        if src == 'inventory' and dst == 'internal':
            seed[m['product_id']] = seed.get(m['product_id'], 0) + qty
        elif src == 'internal' and dst == 'customer':
            shipped[m['product_id']] = shipped.get(m['product_id'], 0) + qty

    # products
    products, rows = {}, []
    for t in sorted(templates.values(), key=lambda x: int(x['id'])):
        if not t['garment_type_id'] or t['active'] != 't':
            continue
        g = gtypes[t['garment_type_id']]
        designable = all(t[k] not in (None, '0', '0.00') and float(t[k] or 0) > 0 for k in ('clothcraft_print_w', 'clothcraft_print_h'))
        products[t['id']] = {'slug': t['clothcraft_slug'], 'name': name_of(t['name']), 'type': g['code']}
        rows.append([t['clothcraft_slug'], name_of(t['name']), g['code'], f"{float(t['list_price']):.2f}", 'yes' if designable else 'no',
                     t['clothcraft_print_x'] or '', t['clothcraft_print_y'] or '', t['clothcraft_print_w'] or '', t['clothcraft_print_h'] or '',
                     f"{float(g['reference_area_sq_in']):.4f}" if g['reference_area_sq_in'] else ''])
    write_csv(os.path.join(out, 'products.csv'), ['slug', 'name', 'garment_type', 'list_price', 'designable', 'print_x', 'print_y', 'print_w', 'print_h',
                                                   'reference_sq_in'], rows)

    # variants
    rows, by_id = [], {}
    for pp in sorted(records(T, 'product_product'), key=lambda x: int(x['id'])):
        t = templates[pp['product_tmpl_id']]
        if pp['active'] != 't' or not t['garment_type_id']:
            continue
        size = colour = None
        extra = 0.0
        for pid in combos.get(pp['id'], []):
            v = ptav[pid]
            extra += float(v['price_extra'] or 0)
            attribute = attr_name[value[v['product_attribute_value_id']]['attribute_id']]
            text = name_of(value[v['product_attribute_value_id']]['name'])
            if attribute == 'Size':
                size = text
            elif attribute == 'Color':
                colour = text
        price = float(t['list_price']) + extra
        by_id[pp['id']] = (pp['default_code'], size, colour)
        rows.append([pp['default_code'], t['clothcraft_slug'], size, colour, f'{price:.2f}', f"{seed.get(pp['id'], 0):.0f}", f"{shipped.get(pp['id'], 0):.0f}"])
    write_csv(os.path.join(out, 'variants.csv'), ['sku', 'slug', 'size', 'colour', 'unit_price', 'opening_units', 'baseline_sold_units'], rows)

    # suppliers and supply lines
    suppliers = {r['id']: r for r in records(T, 'clothcraft_supplier')}
    write_csv(os.path.join(out, 'suppliers.csv'), ['supplier_id', 'name', 'ships', 'shipping_fee', 'opening_balance', 'active', 'permanently_off'],
              [[f'SUP{s["id"]}', s['name'], 'yes' if s['ships'] == 't' else 'no', f"{float(s['shipping_fee']):.2f}", f"{float(s['opening_balance']):.2f}",
                'yes' if s['active'] == 't' else 'no', 'yes' if s['permanently_off'] == 't' else 'no'] for s in sorted(suppliers.values(), key=lambda x: int(x['id']))])
    lines = []
    for l in sorted(records(T, 'clothcraft_supplier_line'), key=lambda x: int(x['id'])):
        lines.append([f'SUP{l["supplier_id"]}', gtypes[l['garment_type_id']]['code'], name_of(value[l['size_value_id']]['name']),
                      name_of(value[l['color_value_id']]['name']), f"{float(l['unit_cost']):.2f}"])
    write_csv(os.path.join(out, 'supply_lines.csv'), ['supplier_id', 'garment_type', 'size', 'colour', 'unit_cost'], lines)

    # provinces (the codes the shop accepts) and design settings
    ph = next(r['id'] for r in records(T, 'res_country') if r['code'] == 'PH')
    write_csv(os.path.join(out, 'provinces.csv'), ['code', 'name'], [[s['code'], name_of(s['name'])] for s in sorted(records(T, 'res_country_state'), key=lambda x: x['code'])
                                                                      if s['country_id'] == ph])
    pricing = records(T, 'clothcraft_design_pricing')[0]
    write_csv(os.path.join(out, 'design_settings.csv'), ['rate_per_sq_in', 'size_step'], [[f"{float(pricing['rate']):.2f}", f"{float(pricing['size_step']):.2f}"]])

    # the two shop test orders, customers anonymised
    audit = records(T, 'clothcraft_order_audit')
    lines_of = {}
    for l in records(T, 'sale_order_line'):
        if l['display_type'] is None and l['product_id'] in by_id:
            lines_of.setdefault(l['order_id'], []).append(f"{by_id[l['product_id']][0]}x{float(l['product_uom_qty']):.0f}")
    who, rows = {}, []
    for o in sorted(records(T, 'sale_order'), key=lambda x: int(x['id'])):
        who.setdefault(o['partner_id'], f'B{len(who) + 1}')
        closed = [a for a in audit if a['order_id'] == o['id'] and a['to_state'] == 'closed']
        rows.append([o['name'], who[o['partner_id']], iso_manila(o['date_order']), o['state'], o['clothcraft_state'], f"{float(o['amount_total']):.2f}",
                     ' '.join(lines_of.get(o['id'], [])), iso_manila(closed[-1]['create_date']) if closed else ''])
    write_csv(os.path.join(out, 'baseline_orders.csv'), ['order', 'customer', 'placed_at', 'state', 'fulfilment', 'amount_total', 'garment_lines', 'closed_at'], rows)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
