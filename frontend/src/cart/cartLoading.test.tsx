import { configure, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quote } from '../api/types';
import { checkoutOptions } from '../mocks/shop';
import { cartStore, setServerCartForTests } from './cartStore';

// Step B, the real shop (VITE_API=odoo): the cart and checkout while the account's saved cart is on its way. The API is answered here.
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), API_MODE: 'odoo' as const }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: '5', displayName: 'Real customer', email: 'real@example.test' }, status: 'ready', openSignIn() {}, openRegister() {}, signOut() {}, requireAccount: (then: () => void) => then() }),
}));
configure({ asyncUtilTimeout: 8000 });

const { Cart } = await import('../pages/Cart');
const { Checkout } = await import('../pages/Checkout');

const json = (data: unknown) => new Response(JSON.stringify({ data, simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const quoteOf = (lines: { sku: string; quantity: number }[]): Quote => ({
  currency: 'PHP', vatIncluded: true, vatRate: 12, deliveryFee: 0, deliveryLabel: 'Free delivery', vatAmount: 37, ready: true, total: 349 * lines.reduce((n, l) => n + l.quantity, 0),
  lines: lines.map((l) => ({ sku: l.sku, productId: 'm-tee', name: 'Men Crew Tee', colorName: 'Black', size: 'M' as const, image: '/x.webp', quantity: l.quantity, available: 9, message: null, unitPrice: 349, lineTotal: 349 * l.quantity, issue: 'ok' as const })),
});

let releaseCart: () => void = () => undefined;
function serve() {
  const cartHeld = new Promise<void>((resolve) => {
    releaseCart = resolve;
  });
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const path = new URL(input, 'http://localhost').pathname;
    if (path === '/api/cart' && (init.method ?? 'GET') === 'GET') {
      await cartHeld;
      return json({ version: 1, updatedAt: null, lines: [{ sku: 'M-TEE-BLK-M', productId: 'm-tee', quantity: 2, selected: true }] });
    }
    if (path === '/api/cart/quote') return json(quoteOf((JSON.parse(String(init.body)) as { lines: { sku: string; quantity: number }[] }).lines));
    if (path === '/api/checkout/options') return json(checkoutOptions);
    return new Response('{}', { status: 404 });
  });
}
function renderAt(path: string) {
  const router = createMemoryRouter([{ path: '/cart', element: <Cart /> }, { path: '/checkout', element: <Checkout /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  localStorage.clear();
  setServerCartForTests(true);
  serve();
  cartStore.setOwner('5'); // what AuthProvider does: the saved cart starts loading
});
afterEach(() => {
  releaseCart();
  cartStore.setOwner(null);
  setServerCartForTests(false);
  vi.unstubAllGlobals();
});

describe('the cart page while the saved cart loads', () => {
  it('shows the cart\'s own frame as a skeleton (its heading is real, the lines and the summary are grey), then the cart', async () => {
    renderAt('/cart');
    const region = screen.getByTestId('cart-loading');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(within(region).getByRole('status')).toHaveTextContent('Loading your cart…');
    expect(within(region).getByRole('heading', { name: 'Your cart' })).toBeInTheDocument();
    expect(screen.queryByTestId('cart-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cart-empty')).not.toBeInTheDocument(); // never "your cart is empty" for a cart that has not come yet
    releaseCart();
    expect(await screen.findAllByTestId('cart-line')).toHaveLength(1);
    expect(screen.queryByTestId('cart-loading')).not.toBeInTheDocument();
  });

  it('the quote\'s own wait is a skeleton too (grey bars, the words kept for screen readers)', async () => {
    renderAt('/cart');
    releaseCart();
    await screen.findAllByTestId('cart-line');
    await screen.findByTestId('line-total');
    // while priced lines are on screen there is no leftover "Pricing…" status
    expect(screen.queryByText('Pricing your cart…')).not.toBeInTheDocument();
  });
});

describe('the checkout page while the saved cart loads', () => {
  it('shows its frame as a skeleton and does NOT send the customer back to the cart for an empty cart that has not come yet', async () => {
    const router = renderAt('/checkout');
    const region = screen.getByTestId('cart-loading');
    expect(within(region).getByRole('heading', { name: 'Checkout' })).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(router.state.location.pathname).toBe('/checkout');
    releaseCart();
    // the saved cart has one ticked line: checkout shows it and stays where it is
    await within(await screen.findByTestId('summary-lines')).findAllByRole('listitem');
    expect(screen.queryByTestId('cart-loading')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/checkout');
  });
});
