import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getProduct, listProducts } from '../api/catalogue';
import { ApiError } from '../api/client';
import type { ProductDetail, ProductSummary, Variant } from '../api/types';
import { StockBadge } from '../components/StockBadge';
import { customizeUrl, EDITABLE_NOTE, fitsGarment, garmentLabels, type PremadeDesign } from '../designs/catalog';
import { buildSnapshot, fetchTemplate, TemplateError } from '../designs/template';
import type { PricingLoad } from '../editor/EditorStage';
import type { EditorSnapshot } from '../editor/types';
import { formatMoney } from '../lib/format';

/**
 * Starting the editor from a premade design (/design?template=<id>). Three small pieces around the existing editor page (pages/Design.tsx):
 *   TemplateGarmentPicker   no garment yet: the real garments the design is made for, to choose one (the shop's own names, prices and stock)
 *   PickVariant             a garment but no colour and size yet: choose a sensible variant and put it in the address
 *   useTemplateSnapshot     the design as an editor snapshot fitted to that garment's print box, handed to the editor as its starting scene
 * The design files are static and read-only: the editor gets a COPY, so nothing a customer does can change the shared design.
 */

/** The variant to start on: the design's own colour if the garment comes in it, else a colour it reads well on, else any; size M, else the middle size; in stock first. */
export function defaultVariant(product: Pick<ProductDetail, 'variants' | 'colorOptions'>, design: PremadeDesign): Variant | undefined {
  const inStock = product.variants.filter((v) => v.status !== 'out_of_stock');
  const pool = inStock.length ? inStock : product.variants;
  const colours = [design.previewGarment.color, ...design.bestOn, ...product.colorOptions.map((c) => c.id)];
  for (const colour of colours) {
    const ofColour = pool.filter((v) => v.color === colour);
    if (ofColour.length) return ofColour.find((v) => v.size === 'M') ?? ofColour[Math.floor((ofColour.length - 1) / 2)];
  }
  return pool[0];
}

type Snap = { phase: 'none' } | { phase: 'loading' } | { phase: 'ready'; snapshot: EditorSnapshot } | { phase: 'error'; message: string };

export function useTemplateSnapshot(design: PremadeDesign | undefined, pricing: PricingLoad): Snap {
  const [snap, setSnap] = useState<Snap>({ phase: 'none' });
  // the print box comes with the garment's print-fee settings; without it (the mock shop, a garment that cannot be printed) a typical T-shirt box is used
  const waiting = pricing.phase === 'loading';
  const box = pricing.phase === 'ready' ? pricing.pricing.box : null;
  const boxKey = box ? `${box.x},${box.y},${box.width},${box.height}` : 'none';
  useEffect(() => {
    if (!design) {
      setSnap({ phase: 'none' });
      return;
    }
    if (waiting) {
      setSnap({ phase: 'loading' });
      return;
    }
    const controller = new AbortController();
    setSnap({ phase: 'loading' });
    fetchTemplate(`/designs/templates/${design.id}.json`, undefined, controller.signal)
      .then((file) => buildSnapshot(file, box, undefined, controller.signal))
      .then((snapshot) => {
        if (!controller.signal.aborted) setSnap({ phase: 'ready', snapshot });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSnap({ phase: 'error', message: error instanceof TemplateError ? error.message : 'That design could not be opened.' });
      });
    return () => controller.abort();
    // `box` is read through its key: a new object with the same numbers must not load the design again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design?.id, waiting, boxKey]);
  return snap;
}

export function TemplateStatus({ snap }: { snap: Snap }) {
  if (snap.phase === 'error') {
    return (
      <p role="alert" className="mt-6 text-brown-dark">
        {snap.message} <Link to="/designs" className="underline">Back to all designs</Link>.
      </p>
    );
  }
  return (
    <p role="status" className="mt-6 min-h-24">
      Opening the design…
    </p>
  );
}

/** What the person is starting from, said plainly, with what can and cannot be edited and that nothing is saved as a draft yet. */
export function TemplateNote({ design, garmentTypeCode, garmentName }: { design: PremadeDesign; garmentTypeCode: string; garmentName: string }) {
  return (
    <div className="mt-3 border border-tan bg-paper px-4 py-3 text-sm max-sm:px-3 max-sm:py-2" data-testid="design-template-note">
      <p>
        <span className="font-semibold text-ink">Starting from the premade design {design.name}</span> ({design.style}). {EDITABLE_NOTE[design.editable]} The premade design itself is never changed: what you
        change is your own copy.
      </p>
      {!fitsGarment(design, garmentTypeCode) && (
        <p className="mt-1 font-medium text-brown-dark" data-testid="design-template-fit">
          This design was made for {garmentLabels(design).join(', ')}. It may need moving or resizing on {garmentName}.
        </p>
      )}
      <p className="mt-1 text-muted">A design started this way is not saved as a draft: add it to the cart to keep it.</p>
    </div>
  );
}

type Garments = { phase: 'loading' } | { phase: 'ready'; products: ProductSummary[]; currency: string } | { phase: 'error'; message: string };

export function TemplateGarmentPicker({ design }: { design: PremadeDesign }) {
  const [state, setState] = useState<Garments>({ phase: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: 'loading' });
    listProducts({}, controller.signal)
      .then((r) => setState({ phase: 'ready', products: r.data.products.filter((p) => fitsGarment(design, p.garmentType.code)), currency: r.data.currency }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ phase: 'error', message: error instanceof ApiError ? error.message : 'The garments could not be loaded.' });
      });
    return () => controller.abort();
  }, [design]);

  return (
    <div className="mt-4" data-testid="template-garment-picker">
      <p className="max-w-prose text-lg">
        You chose <span className="font-semibold">{design.name}</span>. Now pick the garment to put it on: these are the garments it is made for ({garmentLabels(design).join(', ')}).
      </p>
      {state.phase === 'loading' && (
        <p role="status" className="mt-4 min-h-24">
          Loading the garments…
        </p>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="mt-4 text-brown-dark">
          {state.message}
        </p>
      )}
      {state.phase === 'ready' && state.products.length === 0 && (
        <p className="mt-4" role="status">
          No garment in the shop fits this design right now. <Link to="/designs" className="underline">Back to all designs</Link>.
        </p>
      )}
      {state.phase === 'ready' && state.products.length > 0 && (
        <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {state.products.map((p) => (
            <li key={p.id} className="card-link relative flex flex-col border border-tan bg-cream p-3 hover:border-brown" data-testid="template-garment">
              <img src={p.image} alt="" width={240} height={240} loading="lazy" decoding="async" className="aspect-square w-full object-contain" />
              <h2 className="mt-2 text-xl leading-tight">
                <Link to={customizeUrl(design.id, p.id)} className="no-underline after:absolute after:inset-0 after:content-['']">
                  {p.name}
                </Link>
              </h2>
              <p className="text-sm text-muted">{formatMoney(p.price, state.currency)}</p>
              <p className="mt-1">
                <StockBadge status={p.status} />
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-sm">
        <Link to="/designs" className="underline underline-offset-4">
          Back to all designs
        </Link>
      </p>
    </div>
  );
}

/** A garment is chosen but no colour and size: read it, pick the default variant and call back so the address holds it (replacing the entry). */
export function PickVariant({ design, productId, onPicked }: { design: PremadeDesign; productId: string; onPicked: (sku: string) => void }) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setMessage(null);
    getProduct(productId, controller.signal)
      .then((r) => {
        const v = defaultVariant(r.data, design);
        if (v) onPicked(v.sku);
        else setMessage('That garment has no colour and size to start from.');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setMessage(error instanceof ApiError ? error.message : 'Could not load this garment.');
      });
    return () => controller.abort();
    // onPicked is the page's own setter and changes every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, productId]);
  return message ? (
    <p role="alert" className="mt-6 text-brown-dark">
      {message} <Link to={customizeUrl(design.id)} className="underline">Choose another garment</Link>.
    </p>
  ) : (
    <p role="status" className="mt-6 min-h-24">
      Getting the garment ready…
    </p>
  );
}
