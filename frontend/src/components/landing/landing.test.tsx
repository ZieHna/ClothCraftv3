import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Group, ProductSummary, Simulation } from '../../api/types';
import { AuthProvider } from '../../auth/AuthContext';
import { AuthDialog } from '../AuthDialog';
import { Footer, FooterSlim } from '../Footer';
import { RequireAccount } from '../RequireAccount';
import { FeaturedDesigns } from './FeaturedDesigns';
import { categoriesFrom, ShopByCategory } from './ShopByCategory';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
afterEach(() => vi.unstubAllGlobals());

const GROUPS: Group[] = ['Men', 'Women', 'Kids', 'Babies'];
function product(id: string, group: Group, kind: string, over: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id, name: `${group} ${kind}`, group, garmentType: { code: kind.toUpperCase().slice(0, 4), name: kind }, price: 349, image: `/api/catalogue/products/${id}/image?v=abc`,
    colors: ['black'], sizes: ['M'], stock: 9, status: 'in_stock', ...over,
  };
}
/** the API, as far as these sections ask it: one answer per path */
function serve(answers: Record<string, unknown>, simulation: Simulation | null = null) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://x').pathname;
    if (!(path in answers)) return new Response(JSON.stringify({ error: { code: 'down', message: 'The shop is not available right now. Please try again.' } }), { status: 502 });
    return new Response(JSON.stringify({ data: answers[path], simulation }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}
const list = (products: ProductSummary[]) => ({ currency: 'PHP', vatIncluded: true, groups: GROUPS, colors: [], sizes: [], count: products.length, garmentTypes: [], priceBounds: { min: 0, max: 0 }, products });
const inRouter = (element: React.ReactNode) => render(<RouterProvider router={createMemoryRouter([{ path: '/', element }])} />);

describe('shop by category: the groups come from the catalogue', () => {
  it('only groups with something on sale, in the API order, each described by its own garment types and pictures', () => {
    const products = [
      product('m-tee', 'Men', 'T-Shirt'), product('m-polo', 'Men', 'Polo Shirt'), product('m-tank', 'Men', 'Tank Top'),
      product('b-ones', 'Babies', 'Onesie'),
    ];
    const c = categoriesFrom(GROUPS, products);
    expect(c.map((x) => x.group)).toEqual(['Men', 'Babies']);
    expect(c[0]).toEqual({ group: 'Men', blurb: 'T-Shirt, Polo Shirt, Tank Top', art: ['/api/catalogue/products/m-tee/image?v=abc', '/api/catalogue/products/m-polo/image?v=abc'], count: 3 });
    expect(c[1].art).toEqual(['/api/catalogue/products/b-ones/image?v=abc']);
  });

  it('more than four kinds of garment end in "and more"', () => {
    const kinds = ['T-Shirt', 'Polo Shirt', 'Tank Top', 'Long Sleeve', 'V-Neck Tee'];
    const c = categoriesFrom(GROUPS, kinds.map((k, i) => product(`m-${i}`, 'Men', k)));
    expect(c[0].blurb).toBe('T-Shirt, Polo Shirt, Tank Top, Long Sleeve and more');
  });

  it('shows a tile per group linking to Category, with the products\' own pictures', async () => {
    serve({ '/api/catalogue/products': list([product('w-tee', 'Women', 'T-Shirt'), product('k-polo', 'Kids', 'Polo Shirt')]) });
    inRouter(<ShopByCategory />);
    const tiles = await screen.findAllByTestId('category');
    expect(tiles.map((t) => within(t).getByRole('heading').textContent)).toEqual(['Women', 'Kids']);
    expect(within(tiles[0]).getByRole('link')).toHaveAttribute('href', '/category?group=Women');
    expect(within(tiles[0]).getByRole('link')).toHaveTextContent('Shop Women');
    expect(tiles[0].querySelector('img')).toHaveAttribute('src', '/api/catalogue/products/w-tee/image?v=abc');
    expect(tiles[1]).toHaveTextContent('Polo Shirt');
  });

  it('says so when nothing is on sale, and offers a retry when the shop cannot be reached', async () => {
    serve({ '/api/catalogue/products': list([]) });
    const first = inRouter(<ShopByCategory />);
    expect(await screen.findByTestId('categories-empty')).toHaveTextContent('No garments are on sale right now.');
    first.unmount();
    serve({});
    inRouter(<ShopByCategory />);
    expect(await screen.findByTestId('categories-error')).toHaveTextContent('The shop is not available right now.');
    serve({ '/api/catalogue/products': list([product('m-tee', 'Men', 'T-Shirt')]) });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByTestId('category')).toHaveLength(1);
  });
});

describe('featured: what Odoo flags, and the Simulated label only when the API says so', () => {
  it('lists the featured items with their own pictures (this one has no premade design), and no "Simulated" label on real data', async () => {
    serve({ '/api/catalogue/featured': { currency: 'PHP', vatIncluded: true, products: [product('k-jkt', 'Kids', 'Jacket')] } }, null);
    inRouter(<FeaturedDesigns />);
    const card = await screen.findByTestId('product-card');
    expect(card.querySelector('img')).toHaveAttribute('src', '/api/catalogue/products/k-jkt/image?v=abc');
    expect(screen.queryByText('Simulated')).not.toBeInTheDocument();
  });

  it('shows the label (and only the label: no note under it) when the API says the data is simulated', async () => {
    serve({ '/api/catalogue/featured': { currency: 'PHP', vatIncluded: true, products: [product('m-tee', 'Men', 'T-Shirt')] } }, { label: 'Simulated', note: 'A seeded mock: invented prices.' });
    inRouter(<FeaturedDesigns />);
    await screen.findByTestId('product-card');
    expect(screen.getAllByText('Simulated').length).toBeGreaterThan(0);
    expect(screen.queryByText(/seeded mock|invented prices/)).not.toBeInTheDocument();
  });

  it('is not shown at all when nothing is featured', async () => {
    serve({ '/api/catalogue/featured': { currency: 'PHP', vatIncluded: true, products: [] } });
    const { container } = inRouter(<FeaturedDesigns />);
    await vi.waitFor(() => expect(container.querySelector('#featured')).toBeNull());
    expect(screen.queryByText(/Featured/)).not.toBeInTheDocument();
  });
});

describe('no mock-only wording in the shop', () => {
  const MOCK_WORDS = /demo|this browser tab|this tab|reset when|simulated|mock api|placeholder/i;

  it('the footers, the sign-in and register dialog and the sign-in prompt say nothing about a demo or a mock', async () => {
    serve({});
    const { container } = render(
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '/',
            element: (
              <AuthProvider>
                <Footer />
                <FooterSlim />
                <RequireAccount what="see your cart">
                  <p>hidden</p>
                </RequireAccount>
                <AuthDialog mode="register" onSwitch={() => undefined} onClose={() => undefined} onComplete={() => undefined} />
              </AuthProvider>
            ),
          },
        ])}
      />,
    );
    await screen.findByRole('heading', { name: /sign in to see your cart/i });
    expect(container.textContent).not.toMatch(MOCK_WORDS);
  });
});

describe('the featured section and its link', () => {
  it('is the "Featured designs" section (stable id #featured), and its button, Browse all designs, goes to the designs page', async () => {
    serve({ '/api/catalogue/featured': { currency: 'PHP', vatIncluded: true, products: [product('m-tee', 'Men', 'T-Shirt')] } });
    const { container } = inRouter(<FeaturedDesigns />);
    await screen.findByTestId('product-card');
    expect(container.querySelector('#featured')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/^Featured designs\.?$/);
    expect(screen.getByRole('link', { name: 'Browse all designs' })).toHaveAttribute('href', '/designs');
    expect(screen.queryByText('See all categories')).not.toBeInTheDocument();
  });
});

describe('featured garments with a premade design on them (F7)', () => {
  it('shows the design mockup as the picture only: name, price, stock and the product link stay the shop\'s, and a design card offers Customize this design', async () => {
    serve({ '/api/catalogue/featured': { currency: 'PHP', vatIncluded: true, products: [product('m-tee', 'Men', 'T-Shirt'), product('k-jkt', 'Kids', 'Jacket', { price: 699 })] } });
    inRouter(<FeaturedDesigns />);
    const cards = await screen.findAllByTestId('product-card');
    expect(cards).toHaveLength(2);
    const [withDesign, plain] = cards;
    expect(withDesign).toHaveAttribute('data-design', 'night-shift');
    expect(within(withDesign!).getByTestId('featured-mockup')).toHaveAttribute('src', '/designs/previews/night-shift--m-tee.webp');
    expect(within(withDesign!).getByRole('link', { name: 'Men T-Shirt' })).toHaveAttribute('href', '/products/m-tee'); // the card still leads to the real product
    expect(withDesign).toHaveTextContent('₱349');
    expect(withDesign).toHaveTextContent('In stock');
    expect(within(withDesign!).getByTestId('featured-design-name')).toHaveTextContent('Design: Night Shift (Streetwear)');
    expect(within(withDesign!).getByRole('link', { name: /Customize this design/ })).toHaveAttribute('href', '/design?template=night-shift&product=m-tee');
    // a product the catalog does not mention is exactly as before: its own picture, no design, no customize link
    expect(plain).not.toHaveAttribute('data-design');
    expect(within(plain!).queryByTestId('featured-mockup')).toBeNull();
    expect(plain!.querySelector('img')).toHaveAttribute('src', '/api/catalogue/products/k-jkt/image?v=abc');
    expect(within(plain!).queryByRole('link', { name: /Customize this design/ })).toBeNull();
    expect(plain).toHaveTextContent('₱699');
  });
});
