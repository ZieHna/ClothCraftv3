import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { designPreviewUrl, removeDesign } from '../api/designs';
import type { Quote, QuoteLine } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { cartStore, lineKey, MAX_QUANTITY, useCart, type CartLine } from '../cart/cartStore';
import { editDesignPath, estimateNote, isDesigned, pricedFor, printFeeText } from '../cart/designed';
import { useQuote } from '../cart/useQuote';
import { CartSyncNotes } from '../components/CartSyncNotes';
import { JustMadeNote } from '../components/JustMadeNote';
import { PricingSkeleton } from '../components/skeleton/Skeleton';
import { RouteFallback } from '../components/skeleton/pageSkeletons';
import { CartSkeleton } from '../components/skeleton/routeSkeletons';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { QuantityStepper } from '../components/QuantityStepper';
import { QuoteTotals } from '../components/QuoteTotals';
import { RequireAccount } from '../components/RequireAccount';
import { SimulatedBadge } from '../components/SimulatedBadge';
import { formatMoney } from '../lib/format';

interface Removed {
  line: CartLine;
  index: number;
  name: string;
}

/** The cart is a signed-in customer's (there is no guest cart): signed out, the page asks for sign-in. */
export function Cart() {
  return (
    <RequireAccount what="see your cart" why="Your cart belongs to your account, so it needs a sign-in. Browsing the catalogue never does." checking={<RouteFallback kind="cart" />}>
      <CartView />
    </RequireAccount>
  );
}

/** The money of one priced line; two answers that differ here describe different prices. */
const amountsOf = (q: QuoteLine | undefined) => (q ? JSON.stringify([q.quantity, q.unitPrice, q.lineTotal, q.issue, isDesigned(q) ? q.printFee?.total ?? null : null]) : null);

/**
 * Real shop: until the account's saved cart has come, nothing is shown as the cart (no line, no total, no count), only its skeleton (drawn
 * after the usual delay and kept for its minimum). The mock keeps its cart in this browser, so it never loads.
 */
function CartView() {
  const { loading, lines } = useCart();
  const gate = useSkeletonGate(loading);
  // how many rows the skeleton draws: as many lines as this device already holds for the customer (its local copy), or two
  return gate === 'content' ? <CartReady /> : <CartSkeleton gate={gate} rows={lines.length || 2} />;
}

function CartReady() {
  const { lines, selectedLines, storageBlocked } = useCart();
  // step 10: two answers from the same server route. A prices EVERY line (its own price, stock and design, ticked or not; quoting a
  // design also keeps it from expiring). B prices only the TICKED lines: the total, the VAT and "ready" are the selection's, worked
  // out by the server. When every line is ticked, B would be A, so A is used.
  const allTicked = selectedLines.length === lines.length;
  const all = useQuote(lines);
  const picked = useQuote(selectedLines, !allTicked);
  const sel = allTicked ? all : picked;
  const { requireAccount } = useAuth();
  const navigate = useNavigate();
  // set by Checkout when the order was refused (an item ran out): the cart is exactly as it was
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const [removed, setRemoved] = useState<Removed | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // a removed customized line keeps its design on the server while Undo is offered; then (or on leaving) the design is removed too
  const pendingDesign = useRef<string | null>(null);
  const dropDesign = () => {
    if (pendingDesign.current) void removeDesign(pendingDesign.current).catch(() => undefined); // a design left behind is cleaned up by the shop
    pendingDesign.current = null;
  };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      dropDesign();
    },
    [],
  );

  const quote = all.state.phase === 'ready' ? all.state.quote : null;
  const selQuote = sel.state.phase === 'ready' ? sel.state.quote : null;
  // the two answers can disagree on a ticked line (a price changed between them): no line price may then contradict the total,
  // so those lines and the total say "Updating prices…" and both are asked again
  const disagree = !allTicked && all.fresh && picked.fresh && selectedLines.some((l) => amountsOf(pricedFor(quote, l)) !== amountsOf(pricedFor(selQuote, l)));
  const asked = useRef(false);
  useEffect(() => {
    if (!disagree) {
      asked.current = false;
      return;
    }
    if (asked.current) return; // once per disagreement: the fresh answers settle it
    asked.current = true;
    all.retry();
    picked.retry();
  }, [disagree, all.retry, picked.retry]);

  const nothingTicked = selectedLines.length === 0;
  const settled = !!selQuote && sel.fresh && !disagree;
  const blocked = nothingTicked || !settled || !selQuote?.ready;
  const goCheckout = () => requireAccount(() => navigate('/checkout'));

  const remove = (line: CartLine, name: string) => {
    const index = lines.findIndex((l) => lineKey(l) === lineKey(line));
    cartStore.remove(lineKey(line));
    dropDesign(); // an earlier removal can no longer be undone
    pendingDesign.current = line.designId ?? null;
    setRemoved({ line, index, name });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setRemoved(null);
      dropDesign();
    }, 10000);
  };

  /** What a line's money is read from: a ticked line from the selection's answer (so it matches the total), an unticked one from A. */
  const amountsFor = (line: CartLine) => {
    if (!line.selected || allTicked) return pricedFor(quote, line); // as before step 10: a figure for another quantity shows "…" (see `settled`)
    return picked.fresh && !disagree ? pricedFor(selQuote, line) : undefined;
  };
  const countText = `${selectedLines.length} of ${lines.length} selected`;

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 max-md:pb-28 sm:py-10">
      <h1 className="text-5xl">Your cart</h1>

      {notice && (
        <p role="alert" className="mt-3 border-2 border-brown-dark bg-cream p-4 font-medium text-brown-dark" data-testid="checkout-refused">
          Your order was not placed. {notice}
        </p>
      )}
      <JustMadeNote />
      <CartSyncNotes />

      {/* one polite region for what just happened (a removal) */}
      <p role="status" className="min-h-6 text-sm font-medium text-sage-dark" data-testid="cart-status">
        {removed && (
          <span>
            Removed {removed.name}.{' '}
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={() => {
                cartStore.restore(removed.line, removed.index);
                pendingDesign.current = null;
                setRemoved(null);
              }}
            >
              Undo
            </button>
          </span>
        )}
      </p>

      {storageBlocked && (
        <p role="alert" className="mt-3 border border-brown-dark bg-cream p-3 text-sm font-medium text-brown-dark" data-testid="storage-blocked">
          Your browser is blocking storage, so this cart will be lost when you leave or reload the page.
        </p>
      )}

      {lines.length === 0 ? (
        <div className="mt-6 max-w-xl border border-tan bg-cream p-6" data-testid="cart-empty">
          <h2 className="text-3xl">Your cart is empty</h2>
          <p className="mt-2">Ready-made garments you add from a product page appear here.</p>
          <Link to="/category" className="btn btn-primary mt-5">
            Choose a category
          </Link>
        </div>
      ) : (
        <div className="mt-4 grid gap-8 md:grid-cols-[minmax(0,1fr)_22rem] md:items-start lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div>
            {all.state.phase === 'error' && (
              <div role="alert" className="mb-4 border border-brown-dark bg-cream p-4">
                <p className="font-medium text-brown-dark">{all.state.message}</p>
                <button type="button" onClick={all.retry} className="btn btn-primary mt-3">
                  Try again
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-x-4 border-t border-tan py-1">
              <SelectAll ticked={selectedLines.length} total={lines.length} />
              <p role="status" className="text-sm text-muted" data-testid="selection-count">
                {countText}
              </p>
            </div>
            <ul className="divide-y divide-tan border-y border-tan" data-testid="cart-lines" aria-busy={all.state.phase === 'loading'}>
              {lines.map((line) => (
                <CartRow
                  key={lineKey(line)}
                  line={line}
                  priced={pricedFor(quote, line)}
                  amounts={amountsFor(line)}
                  loading={all.state.phase === 'loading'}
                  currency={quote?.currency ?? 'PHP'}
                  onRemove={remove}
                />
              ))}
            </ul>
          </div>

          <aside className="border border-tan bg-cream p-5 md:sticky md:top-4" aria-labelledby="cart-summary-title">
            <div className="flex items-start justify-between gap-3">
              <h2 id="cart-summary-title" className="text-3xl">
                Summary
              </h2>
              {sel.state.phase === 'ready' && <SimulatedBadge simulation={sel.state.simulation} />}
            </div>
            <p className="mt-1 text-sm text-muted">For the {selectedLines.length === 1 ? 'ticked item' : `${selectedLines.length} ticked items`} only.</p>
            <div className="mt-3">
              {nothingTicked ? (
                <p className="text-muted">Nothing is ticked yet.</p>
              ) : selQuote ? (
                <QuoteTotals quote={selQuote} stale={!settled} vat={false} />
              ) : (
                sel.state.phase === 'error' ? <p className="text-muted">The total is not available right now.</p> : <PricingSkeleton label="Pricing your cart…" />
              )}
            </div>
            {sel.state.phase === 'error' && !allTicked && (
              <button type="button" onClick={picked.retry} className="btn btn-secondary btn-small mt-3">
                Try again
              </button>
            )}
            <CheckoutGate quote={selQuote} settled={settled} nothingTicked={nothingTicked} />
            <button
              type="button"
              disabled={blocked}
              onClick={goCheckout}
              aria-describedby="cart-checkout-gate"
              className="btn btn-primary mt-4 hidden w-full text-lg disabled:cursor-not-allowed disabled:border-muted disabled:bg-paper-warm disabled:text-muted md:inline-flex"
            >
              Checkout
            </button>
          </aside>
        </div>
      )}

      {/* phone: the ticked total, the count and the button stay at the bottom of the screen. It stands in for the summary's button. */}
      {lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-3 border-t border-brown-dark bg-cream px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
          <p className="min-w-0 flex-1">
            <span className="block text-sm text-muted" data-testid="bar-count">
              Total, {countText}
            </span>
            <span className="block text-xl font-semibold text-ink" data-testid="bar-total">
              {nothingTicked ? formatMoney(0, quote?.currency ?? 'PHP') : selQuote && settled ? formatMoney(selQuote.total, selQuote.currency) : '…'}
            </span>
          </p>
          <button
            type="button"
            disabled={blocked}
            onClick={goCheckout}
            aria-describedby="cart-checkout-gate"
            className="btn btn-primary min-h-12 px-6 text-lg disabled:cursor-not-allowed disabled:border-muted disabled:bg-paper-warm disabled:text-muted"
          >
            Checkout
          </button>
        </div>
      )}
    </section>
  );
}

/** "Select all": ticked when every line is, unticked when none is, and mixed (indeterminate) in between. */
function SelectAll({ ticked, total }: { ticked: number; total: number }) {
  const box = useRef<HTMLInputElement>(null);
  const some = ticked > 0 && ticked < total;
  useEffect(() => {
    if (box.current) box.current.indeterminate = some;
  }, [some]);
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-3 font-medium">
      <input ref={box} type="checkbox" checked={total > 0 && ticked === total} onChange={(e) => cartStore.setAllSelected(e.target.checked)} className="size-5 accent-sage-dark" data-testid="select-all" />
      Select all
    </label>
  );
}

/** Says, in words, why Checkout is off. */
function CheckoutGate({ quote, settled, nothingTicked }: { quote: Quote | null; settled: boolean; nothingTicked: boolean }) {
  const problems = quote ? quote.lines.filter((l) => l.issue !== 'ok').length : 0;
  let text = '';
  if (nothingTicked) text = 'Tick the items you want to order.';
  else if (!quote) text = '';
  else if (!settled) text = 'Updating prices…';
  else if (problems > 0) text = `Fix the ${problems === 1 ? 'item' : `${problems} items`} marked above, or untick ${problems === 1 ? 'it' : 'them'}, before you check out.`;
  return (
    <p id="cart-checkout-gate" className="mt-3 text-sm text-muted" data-testid="checkout-gate">
      {text}
    </p>
  );
}

function CartRow({
  line, priced, amounts, loading, currency, onRemove,
}: { line: CartLine; priced: QuoteLine | undefined; amounts: QuoteLine | undefined; loading: boolean; currency: string; onRemove: (line: CartLine, name: string) => void }) {
  const designed = priced && isDesigned(priced) ? priced : null;
  const money = amounts && isDesigned(amounts) ? amounts : null;
  const title = priced ? `${priced.name}${priced.size ? ` (${priced.colorName}, ${priced.size})` : ''}${line.designId ? ', customized' : ''}` : line.sku;
  const upTo = priced && priced.available > 0 ? Math.min(MAX_QUANTITY, priced.available) : MAX_QUANTITY;
  const sellable = !priced || priced.issue === 'ok' || priced.issue === 'over_stock';
  const settled = !!amounts && amounts.quantity === line.quantity;
  const key = lineKey(line);
  const priceShown = priced && priced.issue !== 'unavailable' && priced.issue !== 'design_unavailable';
  // a ticked line whose price is being asked again shows no figure, so it can never contradict the total
  const updating = !!priceShown && !amounts && !loading;
  const note = money ? estimateNote(line.estimate, money.printFee, currency) : null;
  return (
    <li
      // the min-height is a typical priced row at each width (the same numbers as the cart's skeleton), so a row already has its size while its
      // price is still being worked out, and the page does not move when the prices arrive
      className="grid min-h-[15.5rem] grid-cols-[2.75rem_5.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 py-5 sm:min-h-[21rem] sm:grid-cols-[2.75rem_7rem_minmax(0,1fr)_auto] sm:gap-x-4 lg:min-h-[10.5rem]"
      data-testid="cart-line"
      data-sku={line.sku}
      data-design={line.designId}
      data-selected={line.selected ? 'true' : 'false'}
    >
      <label className="row-span-2 -mt-2 inline-flex size-11 cursor-pointer items-center justify-center self-start sm:row-span-1">
        <input type="checkbox" checked={!!line.selected} onChange={(e) => cartStore.setSelected(key, e.target.checked)} className="size-5 accent-sage-dark" data-testid="line-select" />
        <span className="sr-only">Select {title}</span>
      </label>
      <div className="row-span-2 sm:row-span-1">
        {line.designId && priced?.issue !== 'design_unavailable' ? (
          // the customer's own design on the garment (their own picture, served to them only)
          <img src={designPreviewUrl(line.designId)} alt={`Your design on ${priced?.name ?? 'the garment'}`} width={112} height={112} className="aspect-square w-full border border-tan bg-paper object-contain" data-testid="line-design-preview" />
        ) : priced?.image ? (
          <img src={priced.image} alt="" width={112} height={112} className="aspect-square w-full border border-tan bg-paper object-contain" />
        ) : (
          <div aria-hidden="true" className="aspect-square w-full border border-tan bg-paper-warm" />
        )}
      </div>
      <div className="min-w-0">
        {/* two lines are kept for the name: before the shop has priced the line this shows the item code (one line), after it the name (often two) */}
        <h2 className="min-h-14 text-xl font-semibold leading-snug text-ink">
          {priced?.productId ? (
            <Link to={`/products/${priced.productId}`} className="underline-offset-4 hover:underline">
              {title}
            </Link>
          ) : (
            title
          )}
        </h2>
        <p className="mt-0.5 text-xs text-muted">Item code {line.sku}</p>
        {priceShown && amounts && (
          <p className="mt-1 text-base" data-testid="line-price">
            {formatMoney(amounts.unitPrice, currency)} each{designed ? ' (garment)' : ''}
          </p>
        )}
        {money?.printFee && priceShown && (
          <p className="text-base" data-testid="line-print-fee">
            {printFeeText(money.printFee, line.quantity, currency)}
          </p>
        )}
        {updating && (
          <p className="mt-1 text-sm text-muted" data-testid="line-updating">
            Updating prices…
          </p>
        )}
        {note && priceShown && (
          <p className="mt-1 text-sm text-muted" data-testid="line-estimate-note">
            {note}
          </p>
        )}
        {line.designId && priced?.issue !== 'design_unavailable' && (
          <Link to={editDesignPath(line)} className="mt-1 inline-block text-sm font-medium underline underline-offset-4" data-testid="line-edit-design">
            Edit design
          </Link>
        )}
        {loading && !priced && <PricingSkeleton label="Pricing…" small />}
      </div>
      <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-span-1 sm:col-start-4 sm:row-start-1 sm:flex-col sm:items-end">
        <QuantityStepper label={`Quantity of ${title}`} value={line.quantity} max={upTo} disabled={!sellable} onChange={(n) => cartStore.setQuantity(key, n)} />
        {/* its room is kept while the price is worked out, so the controls do not re-wrap when it appears */}
        <p className="min-h-7 min-w-20 text-lg font-semibold text-ink" data-testid="line-total">
          {priceShown ? (settled ? formatMoney(amounts.lineTotal, currency) : '…') : ''}
        </p>
        {designed?.printFee && priceShown && (
          <p className="text-sm text-ink" data-testid="line-fee-total">
            + print {settled && money?.printFee ? formatMoney(money.printFee.total, currency) : '…'}
          </p>
        )}
        <button type="button" onClick={() => onRemove(line, title)} aria-label={`Remove ${title} from the cart`} className="btn btn-secondary btn-small">
          Remove
        </button>
      </div>
      {priced && priced.issue !== 'ok' && (
        <div className="col-[2/-1] border border-brown-dark bg-paper-warm p-3" data-testid="line-issue" role="group" aria-label={`Problem with ${title}`}>
          <p className="font-medium text-brown-dark">{priced.message}</p>
          {!line.selected && <p className="mt-1 text-sm text-muted">Not ticked, so it does not stop the others from being ordered.</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {priced.issue === 'over_stock' && (
              <button type="button" className="btn btn-primary btn-small" onClick={() => cartStore.setQuantity(key, priced.available)}>
                Set to {priced.available}
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-small" onClick={() => onRemove(line, title)}>
              Remove from cart
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
