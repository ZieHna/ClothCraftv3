import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LoadingRegion, PricingSkeleton, SkeletonBlock, SkeletonCard, SkeletonText } from './Skeleton';

const css = readFileSync('src/index.css', 'utf8');
const src = (file: string) => readFileSync(`src/${file}`, 'utf8');

describe('the loading region', () => {
  it('is aria-busy, and says "Loading…" to a screen reader once it is VISIBLE', () => {
    render(
      <LoadingRegion gate="skeleton" label="Loading the thing…" data-testid="r">
        <SkeletonBlock className="h-4" />
      </LoadingRegion>,
    );
    const region = screen.getByTestId('r');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAttribute('data-skeleton', 'skeleton');
    expect(screen.getByRole('status')).toHaveTextContent('Loading the thing…');
    expect(screen.getByRole('status')).toHaveClass('sr-only'); // visually hidden
  });

  it('while it only reserves its room (inside the show delay) it is aria-busy but says nothing and draws nothing', () => {
    render(
      <LoadingRegion gate="wait" label="Loading the thing…" data-testid="r">
        <SkeletonBlock className="h-4" />
      </LoadingRegion>,
    );
    expect(screen.getByTestId('r')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('r')).toHaveAttribute('data-skeleton', 'wait');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(css).toMatch(/\[data-skeleton='wait'\]\s*\{\s*visibility:\s*hidden;/);
  });

  it('the grey shapes are hidden from assistive technology, and a text skeleton reserves the line height of the text it stands for', () => {
    const { container } = render(
      <>
        <SkeletonBlock />
        <SkeletonText size="lg" lines={2} />
        <ul>
          <SkeletonCard />
        </ul>
      </>,
    );
    expect(container.querySelector('.skeleton')?.getAttribute('aria-hidden')).toBe('true');
    const lines = container.querySelectorAll('[aria-hidden="true"] > .h-7');
    expect(lines).toHaveLength(2); // text-lg's line is 1.75 rem = h-7, each line
    expect(container.querySelector('li')).toHaveAttribute('aria-hidden', 'true');
  });

  it('a price still being worked out says so to screen readers and draws bars', () => {
    render(<PricingSkeleton label="Pricing your cart…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Pricing your cart…');
  });
});

describe('the skeleton styles', () => {
  const block = css.slice(css.indexOf('/* ---- loading skeletons and the page fade'), css.indexOf('@media (prefers-reduced-motion: reduce)'));

  it('use design tokens only: no hard-coded colour anywhere in them', () => {
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/);
    expect(block).toMatch(/var\(--color-skeleton\)/);
    expect(css).toMatch(/--color-skeleton:\s*color-mix\(in srgb, var\(--color-tan\)/);
  });

  it('the shimmer and the page fade exist only for people who have NOT asked for reduced motion', () => {
    const inside = block.slice(block.indexOf('@media (prefers-reduced-motion: no-preference)'));
    expect(inside).toMatch(/\.skeleton:not\(\.skeleton-still\)::after/);
    expect(inside).toMatch(/animation:\s*skeleton-shimmer/);
    expect(inside).toMatch(/\.page-fade\s*\{\s*animation:\s*page-in/);
    // and nothing outside that media query animates
    const outside = block.slice(0, block.indexOf('@media (prefers-reduced-motion: no-preference)'));
    expect(outside).not.toMatch(/animation|@keyframes/);
    // the global reduced-motion rule is still there as a second guard
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{[\s\S]*animation-duration: 0\.01ms !important/);
  });
});

describe('each skeleton wears the frame of the page it stands in for (no layout shift)', () => {
  // the skeletons of the entry pages and, in their own file, those of the pages loaded on demand
  const skeletons = src('components/skeleton/pageSkeletons.tsx') + src('components/skeleton/routeSkeletons.tsx');
  const same = (frame: string, page: string) => {
    expect(skeletons).toContain(frame);
    expect(src(page)).toContain(frame);
  };

  it('the cart, checkout and order pages', () => {
    same('mx-auto max-w-6xl px-4 py-8 max-md:pb-28 sm:py-10', 'pages/Cart.tsx');
    same('mx-auto max-w-6xl px-4 py-8 sm:py-10', 'pages/Checkout.tsx');
    same('mx-auto max-w-4xl px-4 py-8 sm:py-10', 'pages/OrderPage.tsx');
    same('mt-4 grid gap-8 md:grid-cols-[minmax(0,1fr)_22rem] md:items-start lg:grid-cols-[minmax(0,1fr)_24rem]', 'pages/Cart.tsx');
    // a cart row has the same minimum height as the skeleton's row, so it already has its size while its price is being worked out
    same('min-h-[15.5rem]', 'pages/Cart.tsx');
    same('sm:min-h-[21rem]', 'pages/Cart.tsx');
    same('lg:min-h-[10.5rem]', 'pages/Cart.tsx');
  });

  it('the product page (its measured column heights) and the catalogue and landing grids', () => {
    same('mt-6 grid gap-8 md:grid-cols-2 md:gap-12', 'pages/Product.tsx');
    expect(skeletons).toContain('min-h-[58.4rem] border border-tan bg-paper p-4 md:min-h-[66.4rem] lg:min-h-[52.1rem] xl:min-h-[50.85rem]'); // measured on the real page
    expect(skeletons).toContain('mt-2 grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-3 lg:grid-cols-4');
    expect(src('pages/Category.tsx')).toContain('mt-2 grid grid-cols-2 gap-4 transition-opacity sm:gap-6 md:grid-cols-3 lg:grid-cols-4');
    same('mt-10 grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4', 'components/landing/ShopByCategory.tsx');
    same('grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 lg:grid-cols-5', 'components/landing/FeaturedDesigns.tsx');
    // a card: ProductCard's own frame
    expect(src('components/ProductCard.tsx')).toContain('flex flex-col border border-tan bg-cream p-4');
    expect(src('components/skeleton/Skeleton.tsx')).toContain('flex flex-col border border-tan bg-cream p-4');
  });

  it('the lists and the staff pages', () => {
    same('mt-3 divide-y divide-tan border-y border-tan', 'components/OrdersList.tsx');
    same('mt-3 space-y-3', 'staff/BoardPage.tsx');
    same('mx-auto max-w-6xl px-4 py-8 sm:py-10', 'staff/OrderDetailPage.tsx');
  });
});
