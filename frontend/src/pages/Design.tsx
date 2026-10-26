import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { getProduct } from '../api/catalogue';
import { useAuth } from '../auth/AuthContext';
import { userKey } from '../auth/userKey';
import { API_MODE, ApiError } from '../api/client';
import { getDesignPricing, getDesignState } from '../api/designs';
import type { ApiResponse, ProductDetail } from '../api/types';
import { RequireAccount } from '../components/RequireAccount';
import { SimulatedBadge } from '../components/SimulatedBadge';
import { StockBadge } from '../components/StockBadge';
import { snapshotFromServer } from '../editor/designUpload';
import { EditorStage, type DesignCart, type PricingLoad } from '../editor/EditorStage';
import type { GarmentOptions } from '../editor/panel/ColorSizePicker';
import { isProEditorEnabled, PHONE_QUERY } from '../editor/flags';
import { ModeChooser } from '../editor/ModeChooser';
import { SwitchModeDialog } from '../editor/SwitchModeDialog';
import { resolveEntry } from '../editor/entry';
import type { EditorMode, EditorSnapshot, GarmentBase } from '../editor/types';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { RouteFallback } from '../components/skeleton/pageSkeletons';
import { DesignSkeleton } from '../components/skeleton/routeSkeletons';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { getDesign } from '../designs/catalog';
import { PickVariant, TemplateGarmentPicker, TemplateNote, TemplateStatus, useTemplateSnapshot } from './designTemplate';

type Load = { phase: 'loading' } | { phase: 'ready'; response: ApiResponse<ProductDetail> } | { phase: 'error'; message: string };

/**
 * The garment chosen on the product page, read back from the API by the ?product= and ?variant= in the URL. It shows no price
 * itself: the editor shows the estimate under the canvas (step 9), the cart the shop's figure.
 */
interface ChosenContext {
  garment: GarmentBase;
  /** the product's colours, sizes and what is sold out (no price) */
  options: GarmentOptions;
  /** the editor's garment changed (the picker, undo, redo): put the matching variant in the URL, replacing the entry */
  follow: (garment: { color: string; size: string }) => void;
  product: ProductDetail;
}

function Chosen({ productId, sku, onVariant, children }: { productId: string; sku: string; onVariant: (sku: string) => void; children: (ctx: ChosenContext) => ReactNode }) {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error' });
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getProduct(productId, controller.signal)
      .then((response) => setLoad({ phase: 'ready', response }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load this garment.' });
      });
    return () => controller.abort();
  }, [productId]);

  const product = load.phase === 'ready' ? load.response.data : null;
  const variant = product?.variants.find((v) => v.sku === sku);
  const color = product?.colorOptions.find((c) => c.id === variant?.color);
  const garment = useMemo<GarmentBase | null>(
    () =>
      product && variant && color
        ? {
            image: color.image,
            color: color.id,
            size: variant.size,
            colorImages: Object.fromEntries(product.colorOptions.map((c) => [c.id, c.image])),
          }
        : null,
    [product, variant, color],
  );

  const options = useMemo<GarmentOptions | null>(
    () =>
      product
        ? {
            productName: product.name,
            colors: product.colorOptions.map((c) => ({ id: c.id, name: c.name, hex: c.hex })),
            sizes: product.sizes,
            // a colour and size with no variant, or a variant out of stock, is sold out
            soldOut: (colorId, size) => {
              const v = product.variants.find((x) => x.color === colorId && x.size === size);
              return !v || v.status === 'out_of_stock';
            },
          }
        : null,
    [product],
  );
  const follow = (g: { color: string; size: string }) => {
    const v = product?.variants.find((x) => x.color === g.color && x.size === g.size);
    if (v && v.sku !== sku) onVariant(v.sku);
  };

  // the editor page's LIGHT loading state: one still block under the heading (the editor's own layout and fixed bars are not touched)
  if (load.phase === 'loading' || gate !== 'content') return <DesignSkeleton gate={gate === 'content' ? 'skeleton' : gate} />;
  if (load.phase === 'error') return <p role="alert" className="mt-6 text-brown-dark">{load.message}</p>;
  if (!product || !variant || !garment || !options) {
    return (
      <p role="alert" className="mt-6 text-brown-dark">
        That colour and size is not available for {product?.name}. <Link to={`/products/${productId}`} className="underline">Choose again</Link>.
      </p>
    );
  }
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border border-tan bg-cream px-4 py-3 max-sm:mt-2 max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-3 max-sm:py-2 lg:mt-2 lg:py-1.5" data-testid="design-chosen">
        <p className="font-display text-2xl font-bold text-ink max-sm:text-xl">{product.name}</p>
        <p>
          {color?.name ?? variant.color}, size {variant.size}
        </p>
        <StockBadge status={variant.status} />
        <SimulatedBadge simulation={load.response.simulation} />
        <Link
          to={`/products/${product.id}?color=${variant.color}&size=${variant.size}`}
          className="text-sm text-muted underline underline-offset-4 sm:ml-auto"
        >
          Change garment, colour or size
        </Link>
      </div>
      {children({ garment, options, follow, product })}
    </>
  );
}

/** The print-fee settings of this garment (step 9): from the real shop; the mock shop has none, and its buttons say so. */
function usePricing(productId: string | null): PricingLoad {
  const [load, setLoad] = useState<PricingLoad>(API_MODE === 'mock' ? { phase: 'mock' } : { phase: 'loading' });
  useEffect(() => {
    if (API_MODE === 'mock' || !productId) return;
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getDesignPricing(productId, controller.signal)
      .then((response) => setLoad({ phase: 'ready', pricing: response.data }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', message: error instanceof ApiError && error.status !== 404 ? error.message : 'The print prices could not be loaded. Please reload the page.' });
      });
    return () => controller.abort();
  }, [productId]);
  return load;
}

type Saved = { phase: 'none' } | { phase: 'loading' } | { phase: 'ready'; snapshot: EditorSnapshot } | { phase: 'error'; message: string };

/** A cart design opened again: the server's copy (the owner's only), as an editor snapshot. */
function useSavedDesign(id: string | null): Saved {
  const [saved, setSaved] = useState<Saved>(id ? { phase: 'loading' } : { phase: 'none' });
  useEffect(() => {
    if (!id) {
      setSaved({ phase: 'none' });
      return;
    }
    const controller = new AbortController();
    setSaved({ phase: 'loading' });
    getDesignState(id, controller.signal)
      .then((response) => setSaved({ phase: 'ready', snapshot: snapshotFromServer(response.data) }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSaved({ phase: 'error', message: error instanceof ApiError ? error.message : 'This design could not be opened.' });
      });
    return () => controller.abort();
  }, [id]);
  return saved;
}

/**
 * The designer. It needs an account, because a design has an owner. With VITE_PRO_EDITOR on, a missing ?mode= shows the
 * Simple/Pro chooser first; with it off (default) everything goes straight to Simple, and ?mode=pro is ignored.
 * An unknown mode means Simple. Loaded lazily by the router, so the landing and browse pages carry none of this.
 */
export function Design() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const proOn = isProEditorEnabled();
  const phone = useMediaQuery(PHONE_QUERY);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const rawMode = params.get('mode');
  const { mode, showChooser } = resolveEntry(rawMode, proOn, phone);
  const choose = (next: EditorMode) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('mode', next);
    setParams(nextParams);
  };
  /** colour or size changed in the editor: the URL keeps up, REPLACING the entry (Back leaves the designer, it does not step through colours) */
  const setVariant = (variantSku: string) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('variant', variantSku);
    setParams(nextParams, { replace: true });
  };
  const startOver = () => {
    const nextParams = new URLSearchParams(params);
    nextParams.delete('mode');
    setConfirmSwitch(false);
    setParams(nextParams);
  };
  const productId = params.get('product');
  const sku = params.get('variant');
  // "Edit design" from the cart: ?design=<id> opens that design (the server's copy) instead of the product's draft
  const designParam = params.get('design');
  const editId = designParam && /^\d{1,12}$/.test(designParam) ? designParam : null;
  const editSku = useRef(sku);
  const navigate = useNavigate();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const pricing = usePricing(productId);
  const editing = useSavedDesign(editId);
  // a premade design (?template=): an edit from the cart wins; the design is the editor's starting scene, fitted to this garment's print box
  const templateParam = params.get('template');
  const design = editId ? undefined : getDesign(templateParam);
  const unknownTemplate = !editId && templateParam !== null && !design;
  const templateSnap = useTemplateSnapshot(productId && sku ? design : undefined, pricing);
  const cartFor = (product: ProductDetail): DesignCart | undefined =>
    productId
      ? {
          productId,
          pricing,
          variantFor: (color, size) => {
            const v = product.variants.find((x) => x.color === color && x.size === size);
            return v ? { sku: v.sku, price: v.price, soldOut: v.status === 'out_of_stock' } : undefined;
          },
          slot,
          onCheckout: () => navigate('/checkout'),
          onViewCart: () => navigate('/cart'),
          ...(editId && editing.phase === 'ready' ? { editing: { designId: editId, sku: editSku.current ?? '' }, initial: editing.snapshot } : {}),
          // a premade design is a NEW design that starts from the template (no `editing`: Add to cart makes a new line, nothing is replaced)
          ...(design && templateSnap.phase === 'ready' ? { initial: templateSnap.snapshot } : {}),
        }
      : undefined;
  return (
    <RequireAccount what="design your own" checking={<RouteFallback kind="design" />}>
      <section className="mx-auto max-w-6xl px-4 py-8 max-sm:py-3 sm:py-10 lg:flex lg:h-full lg:w-full lg:flex-col lg:py-3 2xl:max-w-[105rem]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-4xl max-sm:text-3xl sm:text-5xl lg:text-4xl">Design</h1>
          {proOn && productId && sku && !showChooser && (
            <button type="button" onClick={() => setConfirmSwitch(true)} className="btn btn-secondary btn-small">
              Switch mode
            </button>
          )}
          {/* the editor puts "Add this customization to cart" and "Proceed to checkout" here on a tablet and a desktop */}
          {productId && sku && !showChooser && <div ref={setSlot} className="ml-auto" data-testid="design-actions-slot" />}
        </div>
        {unknownTemplate ? (
          <p role="alert" className="mt-6 text-brown-dark" data-testid="design-unknown-template">
            That premade design does not exist. <Link to="/designs" className="underline">Browse all designs</Link>.
          </p>
        ) : design && !productId ? (
          <TemplateGarmentPicker design={design} />
        ) : design && productId && !sku ? (
          <PickVariant design={design} productId={productId} onPicked={setVariant} />
        ) : productId && sku && editId && editing.phase !== 'ready' ? (
          editing.phase === 'error' ? (
            <p role="alert" className="mt-6 text-brown-dark">
              {editing.message} <Link to="/cart" className="underline">Back to the cart</Link>.
            </p>
          ) : (
            <p role="status" className="mt-6 min-h-24">
              Opening your design…
            </p>
          )
        ) : productId && sku ? (
          <Chosen productId={productId} sku={sku} onVariant={setVariant}>
            {({ garment, options, follow, product }) =>
              showChooser ? (
                <ModeChooser onChoose={choose} />
              ) : design && templateSnap.phase !== 'ready' ? (
                // the editor is shown only when the design is ready: it takes its starting scene once, when it is ready itself
                <TemplateStatus snap={templateSnap} />
              ) : (
                <>
                  {design && <TemplateNote design={design} garmentTypeCode={product.garmentType.code} garmentName={product.name} />}
                  {/* a cart design being edited, or one started from a premade design, is not the product's draft: no draft session, so neither overwrites the other */}
                  <EditorStage mode={mode} garment={garment} options={options} onGarmentChange={follow} drafts={user && !editId && !design ? { user: userKey(user), productId, sku } : undefined} cart={cartFor(product)} />
                </>
              )
            }
          </Chosen>
        ) : (
          <p className="mt-4 max-w-prose text-lg">
            No garment chosen yet. <Link to="/category" className="underline underline-offset-4">Choose a category</Link> and pick a garment to design.
          </p>
        )}
        {proOn && <SwitchModeDialog open={confirmSwitch} onConfirm={startOver} onCancel={() => setConfirmSwitch(false)} />}
      </section>
    </RequireAccount>
  );
}
