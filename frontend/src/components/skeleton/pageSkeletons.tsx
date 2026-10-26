import { useEffect, useState } from 'react';
import { useSkeletonGate, type Gate } from '../../lib/useSkeletonGate';
import { LoadingRegion, SkeletonBlock, SkeletonCard, SkeletonImage, SkeletonRow, SkeletonText } from './Skeleton';
import type { RouteKind } from './routeSkeletons';

export type { RouteKind };

/**
 * Step B: the skeleton of each page and section that is in the entry bundle (landing, Category, product, the account page's lists). Each one
 * wears the SAME outer classes as the page it stands in for (container width, padding, grid, minimum heights measured on the real page), and only
 * draws grey shapes inside. The pages that load on demand have theirs in routeSkeletons.tsx, so the landing page does not download them.
 * `gate` is what useSkeletonGate returned: 'wait' keeps the room without drawing, 'skeleton' draws.
 */
type G = { gate: Exclude<Gate, 'content'> };

/** "Shop by category": four tiles (the frame the real tiles have). */
export function CategoryTilesSkeleton({ gate }: G) {
  return (
    <LoadingRegion gate={gate} label="Loading the categories…" className="mt-10 grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4" data-testid="categories-loading">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="border border-tan bg-cream">
          <SkeletonBlock className="aspect-[4/3]" />
          <div className="h-[8.625rem] p-4">
            <SkeletonBlock className="h-8 w-1/2" />
            <SkeletonBlock className="mt-3 h-3.5 w-full" />
            <SkeletonBlock className="mt-2 h-3.5 w-3/4" />
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}

/** Featured items: five cards in the grid the real cards use. */
export function FeaturedSkeleton({ gate }: G) {
  return (
    <LoadingRegion
      gate={gate}
      label="Loading featured items…"
      as="ul"
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 lg:grid-cols-5 max-sm:[&>li:last-child:nth-child(odd)]:col-span-2 max-sm:[&>li:last-child:nth-child(odd)]:mx-auto max-sm:[&>li:last-child:nth-child(odd)]:w-1/2"
      data-testid="featured-loading"
    >
      {Array.from({ length: 5 }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </LoadingRegion>
  );
}

/** The catalogue grid, first load (the same grid as the real cards). */
export function CardGridSkeleton({ gate }: G) {
  return (
    <LoadingRegion gate={gate} label="Loading the catalogue…" as="ul" className="mt-2 grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-3 lg:grid-cols-4" data-testid="catalogue-loading">
      {Array.from({ length: 8 }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </LoadingRegion>
  );
}

/** The product page: breadcrumb row, then the picture column and the options column (heights measured on the real page at each width). */
export function ProductSkeleton({ gate }: G) {
  return (
    <LoadingRegion gate={gate} label="Loading the product…" as="section" className="mx-auto max-w-6xl px-4 py-8" data-testid="product-loading">
      <div aria-hidden="true" className="h-5" />
      <div aria-hidden="true" className="mt-6 grid gap-8 md:grid-cols-2 md:gap-12">
        <div className="h-[27.6rem] md:h-auto">
          <div className="border border-tan bg-paper p-4">
            <SkeletonImage />
          </div>
          <SkeletonText size="sm" lines={2} className="mt-3" />
        </div>
        <div className="min-h-[58.4rem] border border-tan bg-paper p-4 md:min-h-[66.4rem] lg:min-h-[52.1rem] xl:min-h-[50.85rem]">
          <SkeletonBlock className="h-10 w-3/4" />
          <SkeletonBlock className="mt-3 h-4 w-1/3" />
          <SkeletonBlock className="mt-6 h-8 w-1/4" />
          <SkeletonBlock className="mt-8 h-4 w-1/5" />
          <div className="mt-3 flex gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonBlock key={i} className="size-11" />
            ))}
          </div>
          <SkeletonBlock className="mt-8 h-4 w-1/5" />
          <div className="mt-3 flex flex-wrap gap-3">
            {Array.from({ length: 5 }, (_, i) => (
              <SkeletonBlock key={i} className="h-11 w-14" />
            ))}
          </div>
          <SkeletonBlock className="mt-8 h-12 w-full" />
        </div>
      </div>
    </LoadingRegion>
  );
}

/** "Your orders" on the account page: two rows (the real list is as long as the customer's history; a row is as tall as the real one at each width). */
export function OrdersListSkeleton({ gate }: G) {
  return (
    <LoadingRegion gate={gate} label="Loading your orders…" as="ul" className="mt-3 divide-y divide-tan border-y border-tan" data-testid="orders-loading">
      {Array.from({ length: 2 }, (_, i) => (
        <li key={i} className="flex min-h-[6.25rem] flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3 md:min-h-[4.5rem]">
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-6 w-1/3" />
            <SkeletonBlock className="mt-2 h-3.5 w-1/2" />
          </div>
          <SkeletonBlock className="h-6 w-28" />
        </li>
      ))}
    </LoadingRegion>
  );
}

/** "Your drafts": two rows. */
export function DraftsSkeleton({ gate }: G) {
  return (
    <LoadingRegion gate={gate} label="Loading your drafts…" as="ul" className="mt-3 divide-y divide-tan border-y border-tan" data-testid="drafts-loading">
      {Array.from({ length: 2 }, (_, i) => (
        <li key={i}>
          <SkeletonRow className="py-3" />
        </li>
      ))}
    </LoadingRegion>
  );
}

// The skeletons of the lazy routes are a small chunk of their own (about 1.7 kB), fetched once the site has settled: the landing page does not
// need them, and most visitors click a link to such a page long after. Plain module state, not React.lazy: once the chunk is there the
// skeleton renders in the very same pass (a lazy component would suspend once even from the cache and lose the invisible "wait" stage).
let routeSkeleton: typeof import('./routeSkeletons').RouteSkeleton | null = null;
let routeSkeletonLoad: Promise<void> | null = null;
function loadRouteSkeletons(): Promise<void> {
  routeSkeletonLoad ??= import('./routeSkeletons').then((m) => {
    routeSkeleton = m.RouteSkeleton;
  });
  return routeSkeletonLoad;
}
if (typeof window !== 'undefined') {
  const prefetch = () => window.setTimeout(() => void loadRouteSkeletons(), 1500);
  if (document.readyState === 'complete') prefetch();
  else window.addEventListener('load', prefetch, { once: true });
}

/**
 * The Suspense fallback of a lazy route (cart, checkout, order, design, staff): the page's own skeleton, shown after the usual delay and
 * never held back (the chunk is not made to wait). When the page then starts loading its data, its own gate takes over from this one without
 * a blank moment in between (useSkeletonGate's hand-off). On a cold visit straight to such a page, before the skeleton chunk has arrived, the
 * fallback is an invisible block the height of the window (the footer stays out of sight) until the skeleton can be drawn.
 */
export function RouteFallback({ kind }: { kind: RouteKind }) {
  const gate = useSkeletonGate(true, { minMs: 0, fallback: true });
  const [, arrived] = useState(0);
  useEffect(() => {
    if (!routeSkeleton) void loadRouteSkeletons().then(() => arrived((n) => n + 1));
  }, []);
  if (gate === 'content') return null;
  if (!routeSkeleton) return <div aria-busy="true" data-skeleton="wait" className="min-h-dvh" />;
  const Skeleton = routeSkeleton;
  return <Skeleton kind={kind} gate={gate} />;
}
