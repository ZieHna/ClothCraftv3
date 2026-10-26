import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { ApiError } from '../api/client';
import { getCheckoutOptions, placeOrder } from '../api/orders';
import type { ApiResponse, CheckoutOptions, DeliveryDetails, PaymentMethodId } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { cartStore, useCart, useJustMadeNote } from '../cart/cartStore';
import { isDesigned, printFeeText } from '../cart/designed';
import { toQuoteLines, useQuote } from '../cart/useQuote';
import { JustMadeNote } from '../components/JustMadeNote';
import { QuoteTotals } from '../components/QuoteTotals';
import { RequireAccount } from '../components/RequireAccount';
import { PricingSkeleton } from '../components/skeleton/Skeleton';
import { RouteFallback } from '../components/skeleton/pageSkeletons';
import { CheckoutSkeleton } from '../components/skeleton/routeSkeletons';
import { SimulatedBadge } from '../components/SimulatedBadge';
import { DELIVERY_FIELDS, EMPTY_DELIVERY, validateDelivery, type DeliveryErrors, type DeliveryField } from '../lib/deliveryRules';
import { formatMoney } from '../lib/format';
import { useSkeletonGate } from '../lib/useSkeletonGate';

export function Checkout() {
  return (
    <RequireAccount what="check out" why="An order belongs to your account, so checking out needs a sign-in. Browsing the catalogue never does." checking={<RouteFallback kind="checkout" />}>
      <CheckoutPage />
    </RequireAccount>
  );
}

type Options = { phase: 'loading' } | { phase: 'ready'; data: ApiResponse<CheckoutOptions> } | { phase: 'error'; message: string };

/** one attempt = one key: a double click or a retry after a lost answer cannot make two orders */
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`);

const FIELD_LABEL: Record<DeliveryField, string> = {
  fullName: 'Full name', email: 'Email', phone: 'Mobile number', street: 'House number and street', city: 'City or municipality', province: 'Province', postalCode: 'Postal code', note: 'Delivery note',
};

function CheckoutPage() {
  // step 10: only the ticked lines are priced and ordered; the others stay in the cart as they are
  const { selectedLines: lines, lines: everything, loading } = useCart();
  const inCart = everything.length;
  const justMade = useJustMadeNote();
  const { state, fresh, adopt } = useQuote(lines);
  const { openSignIn } = useAuth();
  const navigate = useNavigate();
  const [options, setOptions] = useState<Options>({ phase: 'loading' });
  const [details, setDetails] = useState<DeliveryDetails>(EMPTY_DELIVERY);
  const [method, setMethod] = useState<PaymentMethodId | ''>('');
  const [errors, setErrors] = useState<DeliveryErrors>({});
  const [methodError, setMethodError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'price' | 'error'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const key = useRef<string | null>(null);
  const placed = useRef(false);
  // the saved cart still arriving: a skeleton (after the delay, held for its minimum), never a redirect
  const gate = useSkeletonGate(loading && !placed.current);

  useEffect(() => {
    const controller = new AbortController();
    getCheckoutOptions(controller.signal)
      .then((data) => setOptions({ phase: 'ready', data }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setOptions({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the checkout options.' });
      });
    return () => controller.abort();
  }, []);

  // the error summary takes focus when it appears, so a keyboard or screen reader user lands on it
  useEffect(() => {
    if (showSummary) summary.current?.focus();
  }, [showSummary]);

  // real shop: the account's saved cart is still coming, so what is ticked is not known yet (never sent back to the cart for that)
  if (gate !== 'content') return <CheckoutSkeleton gate={gate} />;
  // nothing ticked (or an empty cart): there is nothing to check out, so back to the cart
  if (lines.length === 0 && !placed.current) return <Navigate to="/cart" replace />;

  const quote = state.phase === 'ready' ? state.quote : null;
  const opts = options.phase === 'ready' ? options.data.data : null;
  const money = (n: number) => formatMoney(n, quote?.currency ?? 'PHP');

  const set = (field: DeliveryField) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setDetails((d) => ({ ...d, [field]: event.target.value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !opts || !quote) return;
    const found = validateDelivery(details, opts.provinces.map((p) => p.code));
    const noMethod = method === '' ? 'Choose how you will pay.' : '';
    setErrors(found);
    setMethodError(noMethod);
    setNotice(null);
    if (Object.keys(found).length > 0 || noMethod) {
      setShowSummary(true);
      summary.current?.focus(); // the effect only fires on a change; this covers a second failed submit
      return;
    }
    setShowSummary(false);
    if (!fresh || !quote.ready) {
      setNotice({ kind: 'error', text: 'Some items in your cart cannot be supplied. Go back to the cart to fix them.' });
      return;
    }
    setPending(true);
    key.current ??= newKey();
    try {
      const sent = lines; // exactly what this order holds
      const response = await placeOrder({ lines: toQuoteLines(sent), delivery: details, paymentMethod: method as PaymentMethodId, quotedTotal: quote.total }, key.current);
      key.current = null;
      placed.current = true;
      navigate(`/orders/${response.data.id}`, { state: { justPlaced: true } });
      cartStore.removeOrdered(sent); // only what was ordered leaves the cart; unticked lines stay
    } catch (error) {
      if (error instanceof ApiError) {
        key.current = null; // an answer arrived: the next attempt is a new one
        if (error.status === 401) openSignIn();
        else if (error.code === 'validation') {
          setErrors((error.details.fields ?? {}) as DeliveryErrors);
          setShowSummary(true);
        } else if (error.code === 'stock_conflict' || error.code === 'design_unavailable') {
          navigate('/cart', { state: { notice: error.message } });
        } else if (error.code === 'price_changed' && error.details.quote) {
          adopt(error.details.quote, state.phase === 'ready' ? state.simulation : null);
          setNotice({ kind: 'price', text: `${error.message} The new total is ${formatMoney(error.details.quote.total, error.details.quote.currency)}.` });
        } else setNotice({ kind: 'error', text: error.message });
      } else {
        // no answer at all (offline?): keep the key, so pressing the button again cannot double-order if the first one got through
        setNotice({ kind: 'error', text: 'Could not reach the shop. Nothing was confirmed. Check your connection and press Place order again.' });
      }
    } finally {
      setPending(false);
    }
  };

  const messages = DELIVERY_FIELDS.filter((f) => errors[f]);
  const showErrors = showSummary && (messages.length > 0 || methodError);

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link to="/cart" className="underline underline-offset-4">
          Back to the cart
        </Link>
      </nav>
      <h1 className="mt-3 text-5xl">Checkout</h1>
      {justMade ? (
        <JustMadeNote />
      ) : (
        inCart > lines.length && (
          <p className="mt-2 text-sm text-muted" data-testid="checkout-partial">
            Ordering the {lines.length === 1 ? 'item' : `${lines.length} items`} you ticked. The other {inCart - lines.length === 1 ? 'item stays' : `${inCart - lines.length} items stay`} in your cart.
          </p>
        )
      )}

      {options.phase === 'error' && (
        <p role="alert" className="mt-4 border border-brown-dark bg-cream p-3 font-medium text-brown-dark">
          {options.message}
        </p>
      )}

      <form onSubmit={(e) => void submit(e)} noValidate className="mt-6 grid gap-8 md:grid-cols-[minmax(0,1fr)_22rem] md:items-start lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          <div ref={summary} tabIndex={-1} role={showErrors ? 'alert' : undefined} data-testid="error-summary" className={showErrors ? 'mb-6 border-2 border-brown-dark bg-cream p-4' : 'sr-only'}>
            {showErrors && (
              <>
                <h2 className="text-2xl">Please fix {messages.length + (methodError ? 1 : 0) === 1 ? 'this' : 'these'} before placing your order</h2>
                <ul className="mt-2 list-disc pl-5">
                  {messages.map((f) => (
                    <li key={f}>
                      <a href={`#field-${f}`} className="font-medium underline underline-offset-4" onClick={(e) => { e.preventDefault(); document.getElementById(`field-${f}`)?.focus(); }}>
                        {FIELD_LABEL[f]}: {errors[f]}
                      </a>
                    </li>
                  ))}
                  {methodError && (
                    <li>
                      <a href="#pay-cod" className="font-medium underline underline-offset-4" onClick={(e) => { e.preventDefault(); document.getElementById('pay-cod')?.focus(); }}>
                        Payment: {methodError}
                      </a>
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>

          <fieldset className="min-w-0">
            <legend className="text-3xl [font-family:var(--font-display)]">Delivery details</legend>
            <p className="mt-1 text-sm text-muted">We deliver within the Philippines. Fields marked * are required.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field id="fullName" label="Full name" required error={errors.fullName} className="sm:col-span-2">
                {(p) => <input {...p} type="text" autoComplete="name" value={details.fullName} onChange={set('fullName')} />}
              </Field>
              <Field id="email" label="Email" required error={errors.email}>
                {(p) => <input {...p} type="email" autoComplete="email" inputMode="email" value={details.email} onChange={set('email')} />}
              </Field>
              <Field id="phone" label="Mobile number" required error={errors.phone} hint="For example 0917 123 4567">
                {(p) => <input {...p} type="tel" autoComplete="tel" inputMode="tel" value={details.phone} onChange={set('phone')} />}
              </Field>
              <Field id="street" label="House number and street" required error={errors.street} className="sm:col-span-2">
                {(p) => <input {...p} type="text" autoComplete="street-address" value={details.street} onChange={set('street')} />}
              </Field>
              <Field id="city" label="City or municipality" required error={errors.city}>
                {(p) => <input {...p} type="text" autoComplete="address-level2" value={details.city} onChange={set('city')} />}
              </Field>
              <Field id="province" label="Province" required error={errors.province}>
                {(p) => (
                  <select {...p} autoComplete="address-level1" value={details.province} onChange={set('province')}>
                    <option value="">{opts ? 'Choose a province' : 'Loading provinces…'}</option>
                    {opts?.provinces.map((province) => (
                      <option key={province.code} value={province.code}>
                        {province.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id="postalCode" label="Postal code" required error={errors.postalCode} hint="4 digits">
                {(p) => <input {...p} type="text" autoComplete="postal-code" inputMode="numeric" maxLength={4} value={details.postalCode} onChange={set('postalCode')} />}
              </Field>
              <Field id="note" label="Delivery note (optional)" error={errors.note} className="sm:col-span-2">
                {(p) => <textarea {...p} rows={2} maxLength={300} value={details.note} onChange={set('note')} />}
              </Field>
            </div>
          </fieldset>

          <fieldset className="mt-8 min-w-0" aria-describedby={methodError ? 'pay-error' : undefined}>
            <legend className="text-3xl [font-family:var(--font-display)]">Payment</legend>
            <div className="mt-3 grid gap-3">
              {(opts?.paymentMethods ?? []).map((m) => (
                <label key={m.id} className={`flex cursor-pointer items-start gap-3 border bg-cream p-4 ${method === m.id ? 'border-ink' : 'border-brown-dark'}`}>
                  <input
                    id={m.id === 'cod' ? 'pay-cod' : `pay-${m.id}`}
                    type="radio"
                    name="payment"
                    value={m.id}
                    checked={method === m.id}
                    onChange={() => {
                      setMethod(m.id);
                      setMethodError('');
                    }}
                    className="mt-1 size-5 accent-[var(--color-sage-dark)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-lg font-semibold text-ink">{m.label}</span>
                    <span className="block text-sm">{m.description}</span>
                    {m.id === 'bank_transfer' && method === m.id && (
                      <span className="mt-2 block text-sm font-medium text-brown-dark" data-testid="bank-note">
                        After you place the order we show where to send the payment. The order waits for your payment, and our staff may cancel it if payment is not received; the items then go back into stock.
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            {methodError && (
              <p id="pay-error" className="mt-2 text-sm font-medium text-brown-dark">
                {methodError}
              </p>
            )}
          </fieldset>
        </div>

        <aside className="border border-tan bg-cream p-5 md:sticky md:top-4" aria-labelledby="checkout-summary-title">
          <div className="flex items-start justify-between gap-3">
            <h2 id="checkout-summary-title" className="text-3xl">
              Your order
            </h2>
            {state.phase === 'ready' && <SimulatedBadge simulation={state.simulation} />}
          </div>
          {quote ? (
            <>
              <ul className="mt-3 divide-y divide-tan border-y border-tan" data-testid="summary-lines">
                {quote.lines.map((l) => (
                  <li key={isDesigned(l) ? `${l.sku}#${l.designId}` : l.sku} className="py-2.5">
                    <p className="font-medium text-ink">
                      {l.name}
                      {l.size ? ` (${l.colorName}, ${l.size})` : ''}
                    </p>
                    <p className="flex justify-between gap-3 text-sm">
                      <span>
                        {l.quantity} × {money(l.unitPrice)}
                      </span>
                      <span className="font-semibold text-ink">{money(l.lineTotal)}</span>
                    </p>
                    {isDesigned(l) && l.printFee && (
                      <p className="flex justify-between gap-3 text-sm" data-testid="summary-print-fee">
                        <span>{printFeeText(l.printFee, l.quantity, quote.currency)}</span>
                        <span className="font-semibold text-ink">{money(l.printFee.total)}</span>
                      </p>
                    )}
                    {l.message && <p className="mt-1 text-sm font-medium text-brown-dark">{l.message}</p>}
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                <QuoteTotals quote={quote} stale={!fresh} />
              </div>
            </>
          ) : (
            <div className="mt-3">
              {state.phase === 'error' ? (
                <p className="text-muted" role="alert">
                  {state.message}
                </p>
              ) : (
                <PricingSkeleton label="Pricing your cart…" />
              )}
            </div>
          )}

          <div role="status" aria-live="polite">
            {notice && (
              <p className="mt-4 border border-brown-dark bg-paper-warm p-3 text-sm font-medium text-brown-dark" data-testid={notice.kind === 'price' ? 'price-changed' : 'checkout-error'}>
                {notice.text}
              </p>
            )}
          </div>

          <button type="submit" disabled={pending || !opts || !quote} aria-disabled={pending} className="btn btn-primary mt-4 min-h-12 w-full text-lg disabled:cursor-not-allowed disabled:border-muted disabled:bg-paper-warm disabled:text-muted">
            {pending ? 'Placing your order…' : 'Place order'}
          </button>
          <p className="mt-3 text-sm text-muted">Placing the order reserves your items. You pay by the method you chose above.</p>
        </aside>
      </form>
    </section>
  );
}

interface FieldProps {
  id: DeliveryField;
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  className?: string;
  children: (props: Record<string, unknown>) => ReactNode;
}

/** A labelled field whose error text is tied to it with aria-describedby (and aria-invalid), never shown by colour alone. */
function Field({ id, label, required, error, hint, className = '', children }: FieldProps) {
  const uid = useId();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const describedBy = [hint && !error ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={`field-${id}`} className="block text-sm font-medium text-ink">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children({
        id: `field-${id}`,
        name: id,
        required,
        'aria-required': required || undefined,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        className: `mt-1 block w-full border bg-paper px-3 py-2.5 text-base ${error ? 'border-2 border-brown-dark' : 'border-brown-dark'}`,
      })}
      {hint && !error && (
        <p id={hintId} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-sm font-medium text-brown-dark">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}
    </div>
  );
}
