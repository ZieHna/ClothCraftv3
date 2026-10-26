import { configure, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cartStore } from '../cart/cartStore';
import { Layout } from '../components/Layout';
import { FeaturedDesigns } from '../components/landing/FeaturedDesigns';
import { ShopByCategory } from '../components/landing/ShopByCategory';
import { setDraftDbForTests } from '../drafts/db';
import { createMemoryDb } from '../drafts/memoryDb';
import { handlers } from '../mocks/handlers';
import { placeOrder as serverPlaceOrder, priceCart } from '../mocks/shop';
import { catalogue, loadDb, resetDb } from '../mocks/shopDb';
import { signInTestCustomer } from '../test/mockSession';
import { Account } from './Account';
import { Category } from './Category';
import { OrderPage } from './OrderPage';
import { Product as ProductPage } from './Product';

/**
 * Step B: what each page shows WHILE its data is on the way (a skeleton in the page's own frame, aria-busy, and a "Loading" message for
 * screen readers), and that it is gone, replaced by the content or by the error, when the data is there. The API is the real mock handlers
 * with every request held back until the test lets it go. (The unit tests build with VITE_SKELETON_INSTANT, so the skeleton is up at once;
 * the delay and the minimum are proved in lib/useSkeletonGate.test.tsx.)
 */
configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 60000 });

const server = setupServer(...handlers);
let held: Promise<void> = Promise.resolve();
let holdMatch = /./;
let release: () => void = () => undefined;
/** from now on, every API request (or only those whose URL matches) waits until release() */
function hold(match: RegExp = /./) {
  holdMatch = match;
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
}

beforeAll(() => {
  server.listen({ onUnhandledFrame: ({ defaults }) => defaults.error() });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (holdMatch.test(String(input))) await held;
    return realFetch(typeof input === 'string' && input.startsWith('/') ? `${window.location.origin}${input}` : input, init);
  });
  window.scrollTo = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetDb();
  cartStore.setOwner(null);
  held = Promise.resolve();
  holdMatch = /./;
  setDraftDbForTests(createMemoryDb());
});
afterEach(() => {
  release();
  server.resetHandlers();
  setDraftDbForTests(undefined);
});

const plenty = catalogue.products.flatMap((product) => product.variants.map((variant) => ({ product, variant }))).find((x) => x.variant.stock >= 5 && x.variant.status === 'in_stock')!;

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Layout />,
        children: [
          { path: 'category', element: <Category /> },
          { path: 'products/:id', element: <ProductPage /> },
          { path: 'orders/:id', element: <OrderPage /> },
          { path: 'account', element: <Account /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
}
const inRouter = (element: React.ReactNode) => render(<RouterProvider router={createMemoryRouter([{ path: '/', element }])} />);

/** the skeleton region: aria-busy, with its "Loading" message for screen readers */
function expectSkeleton(testId: string, message: string) {
  const region = screen.getByTestId(testId);
  expect(region).toHaveAttribute('aria-busy', 'true');
  expect(within(region).getByRole('status')).toHaveTextContent(message);
}

describe('landing', () => {
  it('"Shop by category" shows tiles while the categories load, then the categories', async () => {
    hold();
    inRouter(<ShopByCategory />);
    expectSkeleton('categories-loading', 'Loading the categories…');
    expect(screen.queryByTestId('category')).not.toBeInTheDocument();
    release();
    expect((await screen.findAllByTestId('category')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('categories-loading')).not.toBeInTheDocument();
  });

  it('"Featured designs" shows cards while the items load, then the items', async () => {
    hold();
    inRouter(<FeaturedDesigns />);
    expectSkeleton('featured-loading', 'Loading featured items…');
    release();
    expect((await screen.findAllByTestId('product-card')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('featured-loading')).not.toBeInTheDocument();
  });

  it('an error is shown at once and the skeleton goes: "Shop by category" with the shop down', async () => {
    server.use(http.get('/api/catalogue/products', () => HttpResponse.json({ error: { code: 'down', message: 'The shop is not available right now.' } }, { status: 502 })));
    hold();
    inRouter(<ShopByCategory />);
    expect(screen.getByTestId('categories-loading')).toBeInTheDocument();
    release();
    expect(await screen.findByTestId('categories-error')).toHaveTextContent('The shop is not available right now.');
    expect(screen.queryByTestId('categories-loading')).not.toBeInTheDocument();
  });
});

describe('Category and product', () => {
  it('Category shows a grid of cards on the first load, then the catalogue (no skeleton on a later filter change)', async () => {
    hold();
    renderAt('/category');
    expectSkeleton('catalogue-loading', 'Loading the catalogue…');
    expect(screen.queryByTestId('product-card')).not.toBeInTheDocument();
    release();
    expect((await screen.findAllByTestId('product-card')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('catalogue-loading')).not.toBeInTheDocument();
  });

  it('Category with the shop down: the error, not a skeleton', async () => {
    server.use(http.get('/api/catalogue/products', () => HttpResponse.json({ error: { code: 'down', message: 'The shop is not available right now.' } }, { status: 502 })));
    renderAt('/category');
    expect(await screen.findByRole('alert')).toHaveTextContent('The shop is not available right now.');
    expect(screen.queryByTestId('catalogue-loading')).not.toBeInTheDocument();
  });

  it('the product page shows its frame while the product loads, then the product', async () => {
    hold();
    renderAt(`/products/${plenty.product.id}`);
    expectSkeleton('product-loading', 'Loading the product…');
    release();
    expect(await screen.findByRole('heading', { level: 1, name: plenty.product.name })).toBeInTheDocument();
    expect(screen.queryByTestId('product-loading')).not.toBeInTheDocument();
  });

  it('an unknown product is a "not found" page at once, with no skeleton', async () => {
    renderAt('/products/no-such-product');
    expect(await screen.findByRole('heading', { name: 'Product not found' })).toBeInTheDocument();
    expect(screen.queryByTestId('product-loading')).not.toBeInTheDocument();
  });
});

describe('account and orders', () => {
  const signIn = () => {
    const id = signInTestCustomer('Demo', 1);
    cartStore.setOwner(String(id));
  };

  it('the account page shows rows for the orders and the drafts while they load, then "no orders yet" and "no drafts yet"', async () => {
    signIn();
    // the orders request and the drafts database are held; the sign-in check is not
    hold(/\/api\/orders$/);
    const drafts = createMemoryDb();
    let letDraftsGo: () => void = () => undefined;
    const draftsHeld = new Promise<void>((resolve) => {
      letDraftsGo = resolve;
    });
    setDraftDbForTests({ ...drafts, list: async (user: string) => (await draftsHeld, drafts.list(user)) });
    renderAt('/account');
    await screen.findByRole('heading', { name: 'Account' });
    await vi.waitFor(() => expect(screen.getByTestId('orders-loading')).toBeInTheDocument());
    expectSkeleton('orders-loading', 'Loading your orders…');
    await vi.waitFor(() => expect(screen.getByTestId('drafts-loading')).toBeInTheDocument());
    expectSkeleton('drafts-loading', 'Loading your drafts…');
    release();
    letDraftsGo();
    await screen.findByTestId('orders-empty');
    await screen.findByTestId('drafts-empty');
    expect(screen.queryByTestId('orders-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drafts-loading')).not.toBeInTheDocument();
  });

  it('the order page shows its frame while the order loads, then the order', async () => {
    signIn();
    const delivery = { fullName: 'Juana Dela Cruz', email: 'j@example.com', phone: '09171234567', street: '1 Test Street', city: 'Manila', province: 'PH-00', postalCode: '1000', note: '' };
    const lines = [{ sku: plenty.variant.sku, quantity: 1 }];
    const placed = serverPlaceOrder({ lines, delivery, paymentMethod: 'cod', quotedTotal: priceCart(lines).total }, null, loadDb(), 1);
    if (placed.status !== 201) throw new Error('could not place the sample order');
    hold(/\/api\/orders\/\d+$/); // the order itself; the sign-in check goes through
    renderAt(`/orders/${placed.order.id}`);
    await vi.waitFor(() => expect(screen.getByTestId('order-loading')).toBeInTheDocument());
    expectSkeleton('order-loading', 'Loading your order…');
    release();
    expect(await screen.findByTestId('order-heading')).toBeInTheDocument();
    expect(screen.queryByTestId('order-loading')).not.toBeInTheDocument();
  });

  it('an order that is not there is a "not found" page at once, with no skeleton held back', async () => {
    signIn();
    renderAt('/orders/99999');
    expect(await screen.findByRole('heading', { name: 'Order not found' })).toBeInTheDocument();
    expect(screen.queryByTestId('order-loading')).not.toBeInTheDocument();
  });
});
