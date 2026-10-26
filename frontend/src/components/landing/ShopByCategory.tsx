import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listProducts } from '../../api/catalogue';
import { ApiError } from '../../api/client';
import type { Group, ProductSummary } from '../../api/types';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { CategoryTilesSkeleton } from '../skeleton/pageSkeletons';
import { TornEdge } from './TornEdge';

// the panel colour behind each group's garments (decoration only; the words say everything)
const PANEL: Record<Group, string> = { Men: 'bg-sage-light', Women: 'bg-tan', Kids: 'bg-tan', Babies: 'bg-sage-light' };

export interface Category {
  group: Group;
  /** the kinds of garment in the group, from the catalogue, for example "T-Shirt, Polo Shirt, Tank Top and more" */
  blurb: string;
  /** the pictures of its first two products (Odoo's own, through the API) */
  art: string[];
  count: number;
}

/** The groups that have something on sale, in the API's order, each described by what is actually in it. Nothing is invented here. */
export function categoriesFrom(groups: Group[], products: ProductSummary[]): Category[] {
  return groups
    .map((group) => {
      const inGroup = products.filter((p) => p.group === group);
      const kinds = [...new Set(inGroup.map((p) => p.garmentType.name))];
      const blurb = kinds.length > 4 ? `${kinds.slice(0, 4).join(', ')} and more` : kinds.join(', ');
      return { group, blurb, art: inGroup.slice(0, 2).map((p) => p.image), count: inGroup.length };
    })
    .filter((c) => c.count > 0);
}

type State = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; categories: Category[] };

/** "Shop by category": the catalogue's groups, read from the API (step 8c). A group with nothing on sale is not shown. */
export function ShopByCategory() {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // an error, or nothing on sale, is shown at once; the skeleton only covers the wait for the categories
  const gate = useSkeletonGate(state.phase === 'loading', { immediate: state.phase === 'error' || (state.phase === 'ready' && state.categories.length === 0) });

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: 'loading' });
    listProducts({}, controller.signal)
      .then((response) => setState({ phase: 'ready', categories: categoriesFrom(response.data.groups as Group[], response.data.products) }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the categories.' });
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <section id="shop" aria-labelledby="shop-title" className="relative bg-paper-warm">
      <TornEdge className="fill-paper-warm" />
      <div className="mx-auto max-w-6xl px-4 py-16 lg:py-20">
        <p className="eyebrow">Shop by category</p>
        <h2 id="shop-title" className="mt-2 text-5xl leading-none sm:text-6xl">
          Start with a <em className="text-brown">garment.</em>
        </h2>

        {/* the same frame as the tiles, so the page does not jump when they arrive */}
        {gate !== 'content' && <CategoryTilesSkeleton gate={gate} />}
        {gate === 'content' && state.phase === 'error' && (
          <div role="alert" className="mt-10" data-testid="categories-error">
            <p className="font-medium text-brown-dark">{state.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && state.phase === 'ready' && state.categories.length === 0 && (
          <p className="mt-10 max-w-prose text-lg" data-testid="categories-empty">
            No garments are on sale right now.
          </p>
        )}
        {gate === 'content' && state.phase === 'ready' && state.categories.length > 0 && (
          <ul className="mt-10 grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4" data-testid="categories">
            {state.categories.map(({ group, blurb, art }) => (
              <li key={group} data-testid="category">
                <Link to={`/category?group=${group}`} className="group block h-full border border-tan bg-cream no-underline">
                  <div className={`relative flex aspect-[4/3] items-center justify-center overflow-hidden ${PANEL[group]}`}>
                    {art[0] && (
                      <img src={art[0]} alt="" width={640} height={640} loading="lazy" decoding="async" className={`absolute top-[10%] drop-shadow-[0_6px_6px_rgb(43_33_24/0.25)] transition-transform ${art[1] ? 'left-[3%] w-[52%] -rotate-6 group-hover:-rotate-3' : 'left-[22%] w-[56%]'}`} />
                    )}
                    {art[1] && (
                      <img src={art[1]} alt="" width={640} height={640} loading="lazy" decoding="async" className="absolute right-[3%] top-[16%] w-[46%] rotate-6 drop-shadow-[0_6px_6px_rgb(43_33_24/0.25)] transition-transform group-hover:rotate-3" />
                    )}
                  </div>
                  <div className="p-4">
                    <h3 className="text-3xl leading-none">{group}</h3>
                    <p className="mt-1 text-sm text-muted">{blurb}</p>
                    <p className="mt-3 text-sm font-semibold text-sage-dark underline underline-offset-4 group-hover:text-ink">Shop {group}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
