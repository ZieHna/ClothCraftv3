import type { ElementType, ReactNode } from 'react';
import type { Gate } from '../../lib/useSkeletonGate';

/**
 * The loading skeleton set (step B). Every piece is a plain block of a token colour (.skeleton in index.css) whose shimmer is off under
 * prefers-reduced-motion. A skeleton is built from the SAME wrapper classes and sizes as the page it stands in for, so nothing moves when
 * the data arrives; the pieces here only draw the grey shapes inside those frames.
 */

/** One grey block. `className` gives it its size; `still` turns the shimmer off for this block (the editor page's light state). */
export function SkeletonBlock({ className = '', still = false }: { className?: string; still?: boolean }) {
  return <div aria-hidden="true" className={`skeleton ${still ? 'skeleton-still' : ''} ${className}`} />;
}

/** The line-height each text size really takes, so a skeleton line reserves exactly the room the text will. */
const LINE = { sm: 'h-5', base: 'h-6', lg: 'h-7', xl: 'h-7', '2xl': 'h-8', '3xl': 'h-9' } as const;
const BAR = { sm: 'h-3', base: 'h-3.5', lg: 'h-4', xl: 'h-4.5', '2xl': 'h-5', '3xl': 'h-6' } as const;

/** One or more lines of text: each line is as tall as the text it replaces, with a thinner bar drawn inside it. */
export function SkeletonText({ size = 'base', width = '100%', lines = 1, className = '' }: { size?: keyof typeof LINE; width?: string; lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={className}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={`flex items-center ${LINE[size]}`}>
          <div className={`skeleton ${BAR[size]}`} style={{ width: i === lines - 1 && lines > 1 ? '65%' : width }} />
        </div>
      ))}
    </div>
  );
}

/** A picture area: square by default, or any aspect-ratio class. */
export function SkeletonImage({ className = 'aspect-square' }: { className?: string }) {
  return <SkeletonBlock className={`w-full ${className}`} />;
}

/** A catalogue card (ProductCard's frame: the same border, padding, square picture and a text block of the measured height). */
export function SkeletonCard() {
  return (
    <li aria-hidden="true" className="flex flex-col border border-tan bg-cream p-4">
      <SkeletonImage className="mt-2 aspect-square" />
      <div className="mt-3 h-[7.125rem]">
        <SkeletonBlock className="h-6 w-4/5" />
        <SkeletonBlock className="mt-2.5 h-3.5 w-3/5" />
        <SkeletonBlock className="mt-3.5 h-5 w-2/5" />
        <SkeletonBlock className="mt-3 h-4 w-1/3" />
      </div>
    </li>
  );
}

/** A list row: a small square, then two lines, then a short block at the end (cart lines, orders). Its height is the caller's `className`. */
export function SkeletonRow({ className = '', lead = true }: { className?: string; lead?: boolean }) {
  return (
    <div aria-hidden="true" className={`flex items-center gap-4 ${className}`}>
      {lead && <SkeletonBlock className="size-16 shrink-0" />}
      <div className="min-w-0 flex-1">
        <SkeletonBlock className="h-5 w-2/3" />
        <SkeletonBlock className="mt-2 h-3.5 w-1/3" />
      </div>
      <SkeletonBlock className="h-8 w-16 shrink-0" />
    </div>
  );
}

/**
 * The frame of a loading page or section: aria-busy while it is up, and, once it is VISIBLE (not just reserving its room), a polite
 * "Loading" message for screen readers. `gate` is what useSkeletonGate said ('wait' draws nothing yet, 'skeleton' draws the shapes).
 */
export function LoadingRegion({ gate, label, as, className = '', children, ...rest }: {
  gate: Exclude<Gate, 'content'>;
  /** said to screen readers, e.g. "Loading your cart…" */
  label: string;
  as?: ElementType;
  className?: string;
  children: ReactNode;
  'data-testid'?: string;
}) {
  const Tag = as ?? 'div';
  return (
    <Tag aria-busy="true" data-skeleton={gate} className={className} {...rest}>
      {gate === 'skeleton' && (
        <p role="status" className="sr-only">
          {label}
        </p>
      )}
      {children}
    </Tag>
  );
}

/**
 * The price of something still being worked out by the shop (the per-line "Pricing…" in the cart, the summary's "Pricing your cart…"):
 * grey bars, with the words kept for screen readers. No delay or minimum: it sits inside a page that is already there.
 */
export function PricingSkeleton({ label, small = false }: { label: string; small?: boolean }) {
  return (
    <div aria-busy="true" className={small ? 'mt-1' : ''}>
      <p role="status" className="sr-only">
        {label}
      </p>
      {small ? (
        <SkeletonText size="sm" width="9rem" />
      ) : (
        <div aria-hidden="true">
          <SkeletonBlock className="h-5 w-full" />
          <SkeletonBlock className="mt-3 h-5 w-full" />
          <SkeletonBlock className="mt-3 h-7 w-full" />
        </div>
      )}
    </div>
  );
}
