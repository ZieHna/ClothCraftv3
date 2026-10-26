import { type Gate } from '../../lib/useSkeletonGate';
import { LoadingRegion, SkeletonBlock, SkeletonImage, SkeletonRow, SkeletonText } from './Skeleton';

/**
 * Step B: the skeletons of the pages that are loaded on demand (cart, checkout, order, design, the staff dashboard). They are NOT in the entry
 * bundle: the pages import them from here, and RouteFallback loads this file (prefetched once the site has loaded, see pageSkeletons.tsx) for
 * the Suspense fallback of those routes. Same rules as pageSkeletons.tsx: the page's own outer classes, heights measured on the real page.
 */
type G = { gate: Exclude<Gate, 'content'> };

/**
 * The cart: its heading is real (it is always there); the lines and the summary are grey. The rows have the real row's grid and the heights
 * measured on the real page at each width (a row's height is its data's: these are for a typical line); how MANY rows is the lines this
 * device already holds for the customer (the saved cart's local copy), or two.
 */
export function CartSkeleton({ gate, rows = 2 }: G & { rows?: number }) {
  return (
    <LoadingRegion gate={gate} label="Loading your cart…" as="section" className="mx-auto max-w-6xl px-4 py-8 max-md:pb-28 sm:py-10" data-testid="cart-loading">
      <h1 className="text-5xl">Your cart</h1>
      <div className="min-h-6" />
      <div className="mt-4 grid gap-8 md:grid-cols-[minmax(0,1fr)_22rem] md:items-start lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div>
          <div className="flex h-[3.3125rem] items-center border-t border-tan py-1">
            <SkeletonBlock className="h-5 w-32" />
          </div>
          <div className="divide-y divide-tan border-y border-tan">
            {Array.from({ length: Math.min(4, Math.max(1, rows)) }, (_, i) => (
              <div key={i} className="grid min-h-[15.5rem] grid-cols-[2.75rem_5.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 py-5 sm:min-h-[21rem] sm:grid-cols-[2.75rem_7rem_minmax(0,1fr)_auto] sm:gap-x-4 lg:min-h-[10.5rem]">
                <SkeletonBlock className="size-11 self-start" />
                <SkeletonImage />
                <div className="min-w-0">
                  <SkeletonBlock className="h-6 w-4/5" />
                  <SkeletonBlock className="mt-2 h-3.5 w-1/3" />
                  <SkeletonBlock className="mt-3 h-5 w-1/2" />
                </div>
                <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-span-1 sm:col-start-4 sm:row-start-1 sm:flex-col sm:items-end">
                  <SkeletonBlock className="h-11 w-32" />
                  <SkeletonBlock className="h-7 w-20" />
                  <SkeletonBlock className="h-10 w-24" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="h-[11.875rem] border border-tan bg-cream p-5 md:h-[15.75rem]">
          <SkeletonBlock className="h-9 w-1/2" />
          <SkeletonBlock className="mt-2 h-4 w-2/3" />
          <SkeletonBlock className="mt-4 h-5 w-full" />
          <SkeletonBlock className="mt-3 h-5 w-full" />
          <SkeletonBlock className="mt-3 h-7 w-full" />
          <SkeletonBlock className="mt-4 hidden h-11 w-full md:block" />
        </div>
      </div>
    </LoadingRegion>
  );
}

/** Checkout while the cart arrives: the real heading under a breadcrumb row, then the form and the summary (the measured height of the form). */
export function CheckoutSkeleton({ gate }: G) {
  return (
    <LoadingRegion gate={gate} label="Loading your cart…" as="section" className="mx-auto max-w-6xl px-4 py-8 sm:py-10" data-testid="cart-loading">
      <div aria-hidden="true" className="h-5" />
      <h1 className="mt-3 text-5xl">Checkout</h1>
      <div className="mt-6 grid min-h-[95.8rem] gap-8 md:min-h-[58.6rem] md:grid-cols-[minmax(0,1fr)_22rem] md:items-start lg:min-h-[56rem] lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-5">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i}>
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="mt-2 h-11 w-full" />
            </div>
          ))}
        </div>
        <div className="border border-tan bg-cream p-5">
          <SkeletonBlock className="h-9 w-1/2" />
          <SkeletonRow className="mt-5" />
          <SkeletonBlock className="mt-5 h-5 w-full" />
          <SkeletonBlock className="mt-3 h-7 w-full" />
        </div>
      </div>
    </LoadingRegion>
  );
}

/** One order's page, in the real page's order and with the heights measured on it at each width. */
export function OrderSkeleton({ gate }: G) {
  return (
    <LoadingRegion gate={gate} label="Loading your order…" as="section" className="mx-auto max-w-4xl px-4 py-8 sm:py-10" data-testid="order-loading">
      <div className="flex h-5 items-center">
        <SkeletonBlock className="h-3.5 w-24" />
      </div>
      <SkeletonBlock className="mt-1 h-12 w-3/4" />
      <div className="mt-2 min-h-10 sm:min-h-5">
        <SkeletonBlock className="h-3.5 w-1/2" />
      </div>
      <div className="mt-6 min-h-[25rem] border border-tan bg-cream p-5 sm:min-h-[15.9rem] lg:min-h-[14.6rem]">
        <SkeletonBlock className="h-8 w-1/3" />
        <div className="mt-6 flex gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <SkeletonBlock key={i} className="h-12 flex-1" />
          ))}
        </div>
      </div>
      <div className="mt-8 grid min-h-[33rem] gap-8 sm:min-h-[31.7rem] md:min-h-[15.6rem] md:grid-cols-[minmax(0,1fr)_20rem] md:items-start">
        <div>
          <SkeletonBlock className="h-9 w-24" />
          <div className="mt-3 divide-y divide-tan border-y border-tan">
            <SkeletonRow className="py-3" />
          </div>
          <div className="mt-4 max-w-sm">
            <SkeletonBlock className="h-5 w-full" />
            <SkeletonBlock className="mt-3 h-7 w-full" />
          </div>
        </div>
        <div>
          <SkeletonBlock className="h-9 w-1/2" />
          <SkeletonBlock className="mt-3 h-4 w-full" />
          <SkeletonBlock className="mt-2 h-4 w-3/4" />
        </div>
      </div>
      <div className="mt-8 min-h-[6.25rem] min-[390px]:min-h-11" />
    </LoadingRegion>
  );
}

/**
 * The editor page's LIGHT state (the editor is a full-height layout with fixed bottom bars on a phone: nothing here may touch that).
 * One still block (no shimmer) under the page's own heading, with the height the old "Loading your garment…" line had.
 */
export function DesignSkeleton({ gate, label = 'Loading your garment…' }: G & { label?: string }) {
  return (
    <LoadingRegion gate={gate} label={label} className="mt-6 min-h-24" data-testid="design-loading">
      <SkeletonBlock still className="h-24 w-full" />
    </LoadingRegion>
  );
}

/** One board column's cards. */
export function BoardColumnSkeleton({ gate }: G) {
  return (
    <LoadingRegion gate={gate} label="Loading orders…" as="ul" className="mt-3 space-y-3" data-testid="board-loading">
      {Array.from({ length: 3 }, (_, i) => (
        <li key={i} className="h-[6.5rem] border border-brown-dark bg-paper p-3">
          <SkeletonBlock className="h-5 w-3/4" />
          <SkeletonBlock className="mt-2.5 h-3.5 w-1/2" />
          <SkeletonBlock className="mt-2.5 h-3.5 w-2/3" />
        </li>
      ))}
    </LoadingRegion>
  );
}

/** The staff order list: a count line and rows. */
export function StaffListSkeleton({ gate, label = 'Loading orders…' }: G & { label?: string }) {
  return (
    <LoadingRegion gate={gate} label={label} data-testid="staff-list-loading">
      <SkeletonText size="sm" width="14rem" />
      <div className="mt-3 divide-y divide-tan border-y border-tan">
        {Array.from({ length: 8 }, (_, i) => (
          <SkeletonRow key={i} lead={false} className="min-h-14 py-2" />
        ))}
      </div>
    </LoadingRegion>
  );
}

/** One staff order: heading, then the details beside the history. */
export function StaffDetailSkeleton({ gate, label = 'Loading the order…' }: G & { label?: string }) {
  return (
    <LoadingRegion gate={gate} label={label} as="section" className="mx-auto max-w-6xl px-4 py-8 sm:py-10" data-testid="staff-detail-loading">
      <SkeletonBlock className="h-12 w-1/2" />
      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <SkeletonBlock className="h-40 w-full" />
          <SkeletonBlock className="h-56 w-full" />
        </div>
        <SkeletonBlock className="h-80 w-full" />
      </div>
    </LoadingRegion>
  );
}

/** The staff frame while its sign-in is being checked, and the page-wide fallback while the dashboard's code arrives. */
export function StaffCheckingSkeleton({ gate }: G) {
  return (
    <LoadingRegion gate={gate} label="Checking your sign-in…" className="mx-auto max-w-3xl px-4 py-16" data-testid="staff-checking">
      <SkeletonBlock className="h-8 w-1/3" />
      <SkeletonBlock className="mt-4 h-4 w-2/3" />
      <SkeletonBlock className="mt-2 h-4 w-1/2" />
    </LoadingRegion>
  );
}

export type RouteKind = 'cart' | 'checkout' | 'order' | 'design' | 'staff';

/** The skeleton for a lazy route (RouteFallback's content). */
export function RouteSkeleton({ kind, gate }: G & { kind: RouteKind }) {
  switch (kind) {
    case 'cart':
      return <CartSkeleton gate={gate} />;
    case 'checkout':
      return <CheckoutSkeleton gate={gate} />;
    case 'order':
      return <OrderSkeleton gate={gate} />;
    case 'staff':
      return <StaffCheckingSkeleton gate={gate} />;
    case 'design':
      return (
        <section className="mx-auto max-w-6xl px-4 py-8 max-sm:py-3 sm:py-10 lg:flex lg:h-full lg:w-full lg:flex-col lg:py-3 2xl:max-w-[105rem]">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h1 className="text-4xl max-sm:text-3xl sm:text-5xl lg:text-4xl">Design</h1>
          </div>
          <DesignSkeleton gate={gate} />
        </section>
      );
  }
}
