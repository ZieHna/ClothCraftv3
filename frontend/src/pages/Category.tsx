import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { listProducts, type ProductQuery } from '../api/catalogue';
import { ApiError } from '../api/client';
import type { ApiResponse, CatalogueList, Group } from '../api/types';
import { FilterBar, type Filters } from '../components/category/FilterBar';
import { CardGridSkeleton } from '../components/skeleton/pageSkeletons';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { ProductCard } from '../components/ProductCard';
import { SimulatedBadge } from '../components/SimulatedBadge';

type Load = { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; message: string };

/**
 * Category (was Browse until step A): the garment chooser, where the design phase starts. Group tabs and filters, all kept in the URL (?group=&type=&q=&min=&max=&stock=1), so a link reproduces exactly
 * what is on screen and the Back button steps through the choices. The mock server filters and counts; this page only asks
 * and shows. While new results load, the previous ones stay (dimmed) so the page does not jump.
 */
export function Category() {
  const [params, setParams] = useSearchParams();
  const search = params.toString();
  const group = (params.get('group') ?? '') as Group | '';
  const filters: Filters = useMemo(
    () => ({ q: params.get('q') ?? '', type: params.get('type') ?? '', min: params.get('min') ?? '', max: params.get('max') ?? '', stock: params.get('stock') === '1' }),
    // `search` is the string form of `params`: it changes exactly when the URL's query changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search],
  );

  // the tab says where you are (the title goes back to the site's own when the page is left)
  useEffect(() => {
    const before = document.title;
    document.title = 'Category · ClothCraft';
    return () => {
      document.title = before;
    };
  }, []);

  const [response, setResponse] = useState<ApiResponse<CatalogueList> | null>(null);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    const query: ProductQuery = {
      group: group || undefined,
      type: filters.type || undefined,
      q: filters.q.trim() || undefined,
      min: filters.min || undefined,
      max: filters.max || undefined,
      inStock: filters.stock,
    };
    listProducts(query, controller.signal)
      .then((next) => {
        setResponse(next);
        setLoad({ phase: 'ready' });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not load the catalogue.' });
      });
    return () => controller.abort();
  }, [group, filters, attempt]);

  const update = useCallback(
    (changes: Partial<Filters>, options?: { replace?: boolean }) => {
      const next = new URLSearchParams(params);
      const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
      if (changes.q !== undefined) set('q', changes.q);
      if (changes.type !== undefined) set('type', changes.type);
      if (changes.min !== undefined) set('min', changes.min);
      if (changes.max !== undefined) set('max', changes.max);
      if (changes.stock !== undefined) set('stock', changes.stock ? '1' : '');
      setParams(next, { replace: options?.replace ?? false });
    },
    [params, setParams],
  );
  const clearFilters = useCallback(() => {
    const next = new URLSearchParams();
    if (group) next.set('group', group);
    setParams(next);
  }, [group, setParams]);

  // a group tab keeps the search, price and stock filters, but drops the garment type (the types differ per group)
  const tabTo = (g: string) => {
    const next = new URLSearchParams(params);
    next.delete('type');
    if (g) next.set('group', g);
    else next.delete('group');
    const qs = next.toString();
    return qs ? `/category?${qs}` : '/category';
  };

  const data = response?.data;
  const busy = load.phase === 'loading';
  const count = data?.count ?? 0;
  // the skeleton covers only the first load; a new filter keeps the previous results on screen (dimmed), as before
  const gate = useSkeletonGate(!data && load.phase === 'loading', { immediate: load.phase === 'error' || (!!data && count === 0) });

  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-5xl">Category</h1>
        {response && <SimulatedBadge simulation={response.simulation} />}
      </div>

      <nav aria-label="Groups" className="mt-6 flex flex-wrap gap-2">
        {['', ...(data?.groups ?? ['Men', 'Women', 'Kids', 'Babies'])].map((g) => (
          <Link
            key={g || 'all'}
            to={tabTo(g)}
            aria-current={g === group ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center rounded-sm border px-4 text-base font-medium no-underline ${g === group ? 'border-sage-dark bg-sage-dark text-cream' : 'border-tan bg-cream text-text hover:border-brown'}`}
          >
            {g || 'All'}
          </Link>
        ))}
      </nav>

      <div className="mt-5">
        <FilterBar filters={filters} facets={data ?? null} onChange={update} onClear={clearFilters} />
      </div>

      {/* the result count, spoken politely when it changes. A fixed-height line, so it never shifts the grid. */}
      <p className="mt-6 min-h-7 text-lg" role="status" aria-live="polite">
        {load.phase === 'error' ? '' : data ? `${count} ${count === 1 ? 'result' : 'results'}${busy ? ' (updating)' : ''}` : 'Loading the catalogue…'}
      </p>

      {load.phase === 'error' && (
        <div role="alert" className="mt-2 border border-brown-dark bg-cream p-5">
          <p className="font-medium text-brown-dark">{load.message}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn btn-primary btn-small">
              Try again
            </button>
            <Link to="/category" className="btn btn-secondary btn-small">
              Reset all filters
            </Link>
          </div>
        </div>
      )}

      {/* first load: placeholders built like real cards (same padding, square image, text block), so the page
          has the same height and nothing, the footer included, jumps when the products arrive */}
      {gate !== 'content' && <CardGridSkeleton gate={gate} />}

      {gate === 'content' && data && load.phase !== 'error' && count === 0 && (
        <div className="mt-2 border border-tan bg-cream p-8 text-center">
          <h2 className="text-3xl">Nothing matches these filters</h2>
          <p className="mt-2 text-muted">Try a different word, widen the price range or switch off "In stock only".</p>
          <p className="mt-4">
            <button type="button" onClick={clearFilters} className="btn btn-primary">
              Clear filters
            </button>
          </p>
        </div>
      )}

      {gate === 'content' && data && load.phase !== 'error' && count > 0 && (
        <ul aria-busy={busy} className={`mt-2 grid grid-cols-2 gap-4 transition-opacity sm:gap-6 md:grid-cols-3 lg:grid-cols-4 ${busy ? 'opacity-60' : ''}`}>
          {data.products.map((product) => (
            <ProductCard key={product.id} product={product} currency={data.currency} simulation={response.simulation} headingLevel={2} />
          ))}
        </ul>
      )}
    </section>
  );
}
