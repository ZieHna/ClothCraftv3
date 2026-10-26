import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { getProduct } from '../api/catalogue';
import { ApiError } from '../api/client';
import type { ApiResponse, ColorId, ProductDetail, SizeId, Variant } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { cartStore, useCart } from '../cart/cartStore';
import { QuantityStepper } from '../components/QuantityStepper';
import { ProductSkeleton } from '../components/skeleton/pageSkeletons';
import { SimulatedBadge } from '../components/SimulatedBadge';
import { StockBadge } from '../components/StockBadge';
import { formatMoney } from '../lib/format';
import { useSkeletonGate } from '../lib/useSkeletonGate';

type Load = { phase: 'loading' } | { phase: 'ready'; response: ApiResponse<ProductDetail> } | { phase: 'error'; status: number; message: string };

/** Pick the variant to show: the one in the URL (?color=&size=) if it exists, else the first one that is not sold out. */
function chooseVariant(variants: Variant[], color: string | null, size: string | null): Variant {
  const wanted = variants.find((v) => v.color === color && v.size === size);
  return wanted ?? variants.find((v) => v.status !== 'out_of_stock') ?? variants[0];
}

export function Product() {
  const { id = '' } = useParams();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error' });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getProduct(id, controller.signal)
      .then((response) => setLoad({ phase: 'ready', response }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(error instanceof ApiError ? { phase: 'error', status: error.status, message: error.message } : { phase: 'error', status: 0, message: 'Could not load this product.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  if (load.phase === 'error') {
    return (
      <section className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="text-5xl">{load.status === 404 ? 'Product not found' : 'Could not load this product'}</h1>
        <p role="alert" className="mt-3 text-lg text-brown-dark">{load.message}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          {load.status !== 404 && (
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn btn-primary">
              Try again
            </button>
          )}
          <Link to="/category" className="btn btn-secondary">
            Back to Category
          </Link>
        </div>
      </section>
    );
  }

  // the skeleton has the real page's frame (padding, breadcrumb row, grid and column heights measured at each width), so nothing, the
  // footer included, moves when the product arrives
  if (load.phase === 'loading' || gate !== 'content') return <ProductSkeleton gate={gate === 'content' ? 'skeleton' : gate} />;

  return <ProductView response={load.response} />;
}

function ProductView({ response }: { response: ApiResponse<ProductDetail> }) {
  const product = response.data;
  const [params, setParams] = useSearchParams();
  const { requireAccount, user } = useAuth();
  const navigate = useNavigate();

  const variant = chooseVariant(product.variants, params.get('color'), params.get('size'));
  const colorId = variant.color;
  const size = variant.size;
  const chosenColor = product.colorOptions.find((c) => c.id === colorId);
  const colorName = chosenColor?.name ?? colorId;
  const colorImage = chosenColor?.image ?? product.image;
  // the other colours are small pictures: fetch them now so a click on a swatch swaps the picture without a gap
  useEffect(() => {
    for (const c of product.colorOptions) new Image().src = c.image;
  }, [product]);
  const money = (amount: number) => formatMoney(amount, product.currency);

  // the selection lives in the URL (replace, so Back leaves the page, not each click); a link opens the same variant
  const select = (next: { color?: ColorId; size?: SizeId }) => {
    const target = new URLSearchParams(params);
    target.set('color', next.color ?? colorId);
    target.set('size', next.size ?? size);
    setParams(target, { replace: true });
  };
  // a lookup in the variants the API returned, not a calculation: is this size on offer in a given colour, and is it sold out?
  const variantFor = (color: ColorId, s: SizeId) => product.variants.find((v) => v.color === color && v.size === s);
  const soldOutSizesInColour = product.sizes.filter((s) => variantFor(colorId, s)?.status === 'out_of_stock');
  const colourFullySoldOut = (color: ColorId) => product.variants.filter((v) => v.color === color).every((v) => v.status === 'out_of_stock');

  const soldOut = variant.status === 'out_of_stock';
  const cart = useCart();
  const inCart = cart.lines.find((l) => l.sku === variant.sku)?.quantity ?? 0; // the shopper's own number, as chosen
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState<{ sku: string; quantity: number; round: number } | null>(null);
  const quantityId = useId();
  // a new variant starts again at 1, and a "just added" message belongs to the variant it was shown for
  useEffect(() => setQuantity(1), [variant.sku]);
  const maxQuantity = Math.max(1, variant.stock); // the server's number for this variant; the cart page checks it again
  // a cart is a signed-in customer's: signed out, the sign-in dialog opens first and the item is added once the customer has signed in
  // (closing the dialog adds nothing)
  const addToCart = () => {
    const line = { sku: variant.sku, productId: product.id, quantity };
    requireAccount(() => {
      cartStore.add(line.sku, line.productId, line.quantity);
      setAdded((previous) => ({ sku: line.sku, quantity: line.quantity, round: (previous?.round ?? 0) + 1 }));
    }, 'Sign in or register to add this to your cart.');
  };
  const designUrl = `/design?${new URLSearchParams({ product: product.id, variant: variant.sku })}`;
  const stockText = variant.status === 'out_of_stock' ? 'Sold out' : variant.status === 'low_stock' ? `Only ${variant.stock} left` : `${variant.stock} available`;

  return (
    <section className="mx-auto max-w-6xl px-4 py-8">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <ol className="flex flex-wrap items-center gap-x-2">
          <li>
            <Link to="/category" className="underline underline-offset-4">Category</Link>
          </li>
          <li aria-hidden="true">›</li>
          <li>
            <Link to={`/category?group=${product.group}`} className="underline underline-offset-4">{product.group}</Link>
          </li>
          <li aria-hidden="true">›</li>
          <li aria-current="page">{product.name}</li>
        </ol>
      </nav>

      <div className="mt-6 grid gap-8 md:grid-cols-2 md:gap-12">
        <div>
          <div className="stitched relative border border-tan bg-cream p-6">
            <SimulatedBadge simulation={response.simulation} className="relative z-10" />
            <img src={colorImage} alt={`${product.name} in ${colorName}`} width={640} height={640} fetchPriority="high" className="relative mx-auto mt-2 aspect-square w-full max-w-md object-contain" />
          </div>
          <p className="mt-3 text-sm text-muted" data-testid="colour-note">Shown in {colorName}. Colours are our own rendering of the garment, so the fabric you receive can look a little different.</p>
        </div>

        <div>
          <p className="eyebrow">{product.garmentType.name} · {product.group}</p>
          <h1 className="mt-2 text-5xl leading-none sm:text-6xl">{product.name}</h1>

          {/* price and stock of the chosen variant: both are the API's numbers for that exact variant */}
          <div className="mt-5" aria-live="polite" aria-atomic="true" data-testid="variant-summary">
            <p className="text-4xl font-semibold text-ink" data-testid="variant-price">{money(variant.price)}</p>
            {product.vatIncluded && <p className="text-sm text-muted">Price includes VAT.</p>}
            {variant.priceExtra > 0 && (
              <p className="mt-1 text-sm font-medium text-brown-dark" data-testid="variant-extra">Includes a size extra of {money(variant.priceExtra)} for {variant.size}.</p>
            )}
            <p className="mt-3 flex flex-wrap items-center gap-3" data-testid="variant-stock">
              <StockBadge status={variant.status} />
              <span className="text-base">{stockText}</span>
            </p>
            <p className="mt-1 text-xs text-muted">Item code {variant.sku}</p>
          </div>

          <fieldset className="mt-7">
            <legend className="text-base font-semibold text-ink">
              Colour options: <span className="font-normal" data-testid="chosen-color">{colorName}</span>
            </legend>
            <p className="mt-1 text-sm text-muted">The picture changes to show each colour.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {product.colorOptions.map((color) => {
                const gone = colourFullySoldOut(color.id);
                return (
                  <span key={color.id}>
                    <input type="radio" name="color" id={`color-${color.id}`} value={color.id} checked={color.id === colorId} onChange={() => select({ color: color.id })} className="sr-only" />
                    <label htmlFor={`color-${color.id}`} className="option">
                      <span aria-hidden="true" className="size-5 rounded-full border-2 border-cream shadow-[0_0_0_1px_var(--color-ink)]" style={{ background: color.hex }} />
                      {color.name}
                      {gone && <span className="text-xs font-normal">(sold out)</span>}
                    </label>
                  </span>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="mt-6">
            <legend className="text-base font-semibold text-ink">
              Size: <span className="font-normal" data-testid="chosen-size">{size}</span>
            </legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {product.sizes.map((s) => {
                const v = variantFor(colorId, s);
                const out = !v || v.status === 'out_of_stock';
                return (
                  <span key={s}>
                    <input type="radio" name="size" id={`size-${s}`} value={s} checked={s === size} disabled={out && s !== size} onChange={() => select({ size: s })} className="sr-only" />
                    <label htmlFor={`size-${s}`} className={`option min-w-14 ${out ? 'is-soldout' : ''}`}>
                      {s}
                      {out && <span className="sr-only"> (sold out in {colorName})</span>}
                    </label>
                  </span>
                );
              })}
            </div>
            {soldOutSizesInColour.length > 0 && (
              <p className="mt-3 text-sm font-medium text-brown-dark" data-testid="soldout-note">
                Sold out in {colorName}: {soldOutSizesInColour.join(', ')}. Those sizes are crossed out and cannot be chosen.
              </p>
            )}
          </fieldset>

          {soldOut && (
            <p role="status" className="mt-5 border border-brown-dark bg-cream p-4 font-medium text-brown-dark" data-testid="variant-soldout">
              {colorName} in size {size} is sold out right now. Pick another size or colour to order or design it.
            </p>
          )}

          <div className="mt-7" data-testid="add-to-cart">
            <label htmlFor={quantityId} className="text-base font-semibold text-ink">
              Quantity
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <QuantityStepper id={quantityId} value={quantity} max={maxQuantity} disabled={soldOut} blank={soldOut} describedBy="quantity-help" onChange={setQuantity} />
              <button
                type="button"
                disabled={soldOut}
                onClick={addToCart}
                className="btn btn-primary min-h-12 flex-1 text-lg disabled:cursor-not-allowed disabled:border-muted disabled:bg-paper-warm disabled:text-muted sm:flex-none sm:min-w-52"
              >
                Add to cart
              </button>
            </div>
            <p id="quantity-help" className="mt-2 text-sm text-muted">
              {soldOut ? 'This variant is sold out, so it cannot be added.' : `Up to ${maxQuantity} of this variant. Stock is checked again in your cart and at checkout.`}
              {inCart > 0 && ` You already have ${inCart} in your cart.`}
            </p>
            <p role="status" className="mt-2 min-h-6 text-sm font-medium text-sage-dark" data-testid="added-status">
              {added && added.sku === variant.sku ? (
                <span key={added.round}>
                  Added {added.quantity} to your cart.{' '}
                  <Link to="/cart" className="underline underline-offset-4">
                    View cart
                  </Link>
                </span>
              ) : null}
            </p>
          </div>

          <div className="mt-4">
            <button
              type="button"
              disabled={soldOut}
              onClick={() => requireAccount(() => navigate(designUrl))}
              aria-describedby="design-help"
              className="btn btn-secondary w-full text-lg disabled:cursor-not-allowed disabled:border-muted disabled:bg-paper-warm disabled:text-muted sm:w-auto sm:min-w-64"
            >
              Design this
            </button>
            <p id="design-help" className="mt-2 text-sm text-muted">
              {soldOut ? 'Choose a variant that is in stock to design it.' : user ? 'Opens the designer with this garment, colour and size.' : 'Designing needs an account, so you will be asked to sign in first (a demo sign-in for now).'}
            </p>
          </div>

          <p className="mt-6 text-sm text-muted" data-testid="cart-note">
            Ready-made garments only: a design you make yourself is not added to the cart yet. Your cart is kept in this browser until you sign out.
          </p>
        </div>
      </div>
    </section>
  );
}
