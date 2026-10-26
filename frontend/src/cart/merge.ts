import { lineKey, type CartLine } from './line';

/**
 * Step 12: how this device's cart and the account's saved cart (GET/PUT /api/cart) are put together. Pure functions, no storage, no
 * network: cartStore calls them. A line is identified by lineKey (the SKU, plus the design for a customized garment); the fields that
 * can differ are the quantity and the tick. The editor's estimate is this device's own and is never sent.
 */
export type CartFields = Pick<CartLine, 'sku' | 'productId' | 'quantity' | 'designId' | 'selected'>;

const byKey = (lines: readonly CartFields[]) => new Map(lines.map((l) => [lineKey(l), l] as const));
const ticked = (l: CartFields | undefined) => !!l?.selected;

/** The same lines in the same order with the same quantities and ticks (estimates do not count). */
export function sameLines(a: readonly CartFields[], b: readonly CartFields[]): boolean {
  return a.length === b.length && a.every((l, i) => lineKey(l) === lineKey(b[i]!) && l.quantity === b[i]!.quantity && ticked(l) === ticked(b[i]));
}

function withFields(from: CartLine | undefined, fields: CartFields, quantity: number, selected: boolean): CartLine {
  const line: CartLine = { sku: fields.sku, productId: fields.productId, quantity, ...(fields.designId ? { designId: fields.designId } : {}) };
  if (from?.designId && from.estimate !== undefined) line.estimate = from.estimate;
  if (selected) line.selected = true;
  return line;
}

/**
 * The three-way merge. `base` is the saved cart this device last saw, `local` is this device's cart now, `server` is the saved cart now
 * (after another tab or device changed it). For each line:
 *  - added on one side: kept (added on both: the larger quantity, ticked if either ticked it);
 *  - removed on one side: gone, unless the other side changed its quantity meanwhile (the edit is kept, nothing is lost). A tick
 *    alone does not bring back a line that was removed (an order took it, or it was removed on purpose);
 *  - on both sides: each field takes this device's value if this device changed it since `base`, the server's otherwise.
 * The order is the server's, then lines only this device has, in its own order.
 */
export function mergeCarts(base: readonly CartFields[], local: readonly CartLine[], server: readonly CartFields[]): CartLine[] {
  const b = byKey(base);
  const l = byKey(local);
  const s = byKey(server);
  const out: CartLine[] = [];
  for (const sv of server) {
    const key = lineKey(sv);
    const bv = b.get(key);
    const lv = l.get(key);
    if (lv && bv) {
      out.push(withFields(lv, sv, lv.quantity !== bv.quantity ? lv.quantity : sv.quantity, ticked(lv) !== ticked(bv) ? ticked(lv) : ticked(sv)));
    } else if (lv) {
      out.push(withFields(lv, sv, Math.max(lv.quantity, sv.quantity), ticked(lv) || ticked(sv)));
    } else if (!bv || sv.quantity !== bv.quantity) {
      out.push(withFields(undefined, sv, sv.quantity, ticked(sv))); // new on the server, or removed here but raised there
    }
  }
  for (const lv of local) {
    const key = lineKey(lv);
    if (s.has(key)) continue;
    const bv = b.get(key);
    if (!bv || lv.quantity !== bv.quantity) out.push(withFields(lv, lv, lv.quantity, ticked(lv))); // new here, or removed there but raised here
  }
  return out;
}

/**
 * First sign-in on this device after step 12: the cart this browser kept for the customer (cc.cart.v1) meets the account's saved cart.
 * Nothing in a saved cart is ever overwritten: the same line takes the larger quantity and keeps the saved tick; a line only this device
 * had is added, unticked. `added` counts the lines this device brought in (new, or raised), for "We added N items…".
 */
export function adoptDeviceCart(server: readonly CartFields[], device: readonly CartLine[]): { lines: CartLine[]; added: number } {
  const d = byKey(device);
  let added = 0;
  const lines = server.map((sv) => {
    const dv = d.get(lineKey(sv));
    if (dv && dv.quantity > sv.quantity) added += 1;
    return withFields(dv, sv, Math.max(sv.quantity, dv?.quantity ?? 0), ticked(sv));
  });
  const known = byKey(server);
  for (const dv of device) {
    if (known.has(lineKey(dv))) continue;
    lines.push(withFields(dv, dv, dv.quantity, server.length === 0 && ticked(dv))); // an empty saved cart simply receives this device's cart
    added += 1;
  }
  return { lines, added };
}

/** Take away what an order held (the same rule as Odoo's _api_cart_take_ordered): a line ordered in full goes, the rest stays unticked. */
export function takeOrdered<T extends CartFields>(lines: readonly T[], ordered: readonly Pick<CartLine, 'sku' | 'designId' | 'quantity'>[]): T[] {
  return lines.flatMap((l) => {
    const sent = ordered.find((o) => lineKey(o) === lineKey(l));
    if (!sent) return [l];
    const left = l.quantity - sent.quantity;
    if (left <= 0) return [];
    const { selected: _dropped, ...rest } = l;
    return [{ ...rest, quantity: left } as T];
  });
}
