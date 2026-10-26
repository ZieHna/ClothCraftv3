import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listFeatured } from '../../api/catalogue';
import { customizeUrl, featuredDesignFor } from '../../designs/catalog';
import { formatMoney } from '../../lib/format';
import { StockBadge } from '../StockBadge';
import { ApiError } from '../../api/client';
import type { ApiResponse, FeaturedList, ProductSummary, Simulation } from '../../api/types';
import { ProductCard } from '../ProductCard';
import { SimulatedBadge } from '../SimulatedBadge';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { FeaturedSkeleton } from '../skeleton/pageSkeletons';
import { TornEdge } from './TornEdge';

/**
 * A featured garment shown with a premade design on it. ONLY the picture is the design's mockup: the name, the price and the stock status
 * are the product's own, exactly as the API sent them, and the product page and the other screens keep the product's real picture.
 * The card still leads to the product page; "Customize this design" opens the editor on that garment with the design.
 */
function FeaturedDesignCard({ product, currency, simulation }: { product: ProductSummary; currency: string; simulation: Simulation | null }) {
  const featured = featuredDesignFor(product.id);
  if (!featured) return <ProductCard product={product} currency={currency} simulation={simulation} />;
  const { design, preview } = featured;
  return (
    <li className="card-link relative flex flex-col border border-tan bg-cream p-4 hover:border-brown" data-testid="product-card" data-design={design.id}>
      {simulation && (
        <div className="min-h-6">
          <SimulatedBadge simulation={simulation} />
        </div>
      )}
      <img src={preview} alt={design.previewAlt} width={320} height={320} loading="lazy" decoding="async" className="mt-2 aspect-square w-full bg-white object-contain" data-testid="featured-mockup" />
      <h3 className="mt-3 text-2xl leading-tight">
        <Link to={`/products/${product.id}`} className="no-underline after:absolute after:inset-0 after:content-['']">
          {product.name}
        </Link>
      </h3>
      <p className="text-sm text-muted">
        {product.garmentType.name} · {product.group}
      </p>
      <p className="mt-1 text-sm font-medium text-brown-dark" data-testid="featured-design-name">
        Design: {design.name} ({design.style})
      </p>
      <p className="mt-2 text-lg font-semibold text-ink">{formatMoney(product.price, currency)}</p>
      <p className="mt-1">
        <StockBadge status={product.status} />
      </p>
      <p className="relative z-10 mt-3">
        <Link to={customizeUrl(design.id, product.id)} className="btn btn-secondary btn-small" aria-label={`Customize this design: ${design.name} on ${product.name}`}>
          Customize this design
        </Link>
      </p>
    </li>
  );
}

type State = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; response: ApiResponse<FeaturedList> };

/**
 * Which items are featured (Odoo's "Featured on the shop" flag), and their prices, pictures and stock, all come from the API. With nothing
 * featured (or all of it sold out) the section is not shown at all. Simulated data is labelled, and only when the API says so.
 */
export function FeaturedDesigns() {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const gate = useSkeletonGate(state.phase === 'loading', { immediate: state.phase === 'error' || (state.phase === 'ready' && state.response.data.products.length === 0) });

  useEffect(() => {
    const controller = new AbortController();
    listFeatured(controller.signal)
      .then((response) => setState({ phase: 'ready', response }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the featured items.' });
      });
    return () => controller.abort();
  }, []);

  if (state.phase === 'ready' && state.response.data.products.length === 0) return null;

  return (
    <section id="featured" aria-labelledby="featured-title" className="relative bg-paper">
      <TornEdge className="fill-paper" />
      <div className="mx-auto max-w-6xl px-4 py-16 lg:py-20">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <p className="eyebrow">Featured</p>
            <h2 id="featured-title" className="mt-2 text-5xl leading-none sm:text-6xl">
              Featured <em className="text-brown">designs.</em>
            </h2>
          </div>
          {state.phase === 'ready' && <SimulatedBadge simulation={state.response.simulation} />}
        </div>

        {/* min-height keeps the section from jumping when the items arrive */}
        <div className="mt-10 min-h-[22rem]">
          {gate !== 'content' && <FeaturedSkeleton gate={gate} />}
          {gate === 'content' && state.phase === 'error' && <p role="alert" className="text-brown-dark">{state.message}</p>}
          {gate === 'content' && state.phase === 'ready' && (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 lg:grid-cols-5 max-sm:[&>li:last-child:nth-child(odd)]:col-span-2 max-sm:[&>li:last-child:nth-child(odd)]:mx-auto max-sm:[&>li:last-child:nth-child(odd)]:w-1/2">
              {state.response.data.products.map((product) => (
                <FeaturedDesignCard key={product.id} product={product} currency={state.response.data.currency} simulation={state.response.simulation} />
              ))}
            </ul>
          )}
        </div>

        <p className="mt-8">
          <Link to="/designs" className="btn btn-secondary">
            Browse all designs
          </Link>
        </p>
      </div>
    </section>
  );
}
