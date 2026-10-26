import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quote, QuoteLine } from '../api/types';
import { cartStore, setServerCartForTests } from '../cart/cartStore';

// Step 10: the cart's two quotes (A: every line, B: the ticked lines) answered here, so they can be made to disagree.
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), API_MODE: 'odoo' as const }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: '1', displayName: 'Real customer', email: 'real@example.test' }, status: 'ready', openSignIn() {}, openRegister() {}, signOut() {}, requireAccount: (then: () => void) => then() }),
}));

const { Cart } = await import('./Cart');

const line = (sku: string, unitPrice: number): QuoteLine => ({
  sku, productId: 'm-tee', name: `Tee ${sku}`, colorName: 'Black', size: 'M', image: '/garments/m-tee/black.webp', quantity: 1, unitPrice, lineTotal: unitPrice, available: 9, issue: 'ok', message: null,
});
const quoteOf = (lines: QuoteLine[]): Quote => ({ currency: 'PHP', vatIncluded: true, vatRate: 12, lines, deliveryFee: 0, deliveryLabel: 'Free delivery', total: lines.reduce((n, l) => n + l.lineTotal, 0), vatAmount: 0, ready: true });

/** quote answers: `price(call number, skus asked)` gives the price of A-1 in that answer; a held answer waits for release() */
let quoteCalls: string[][] = [];
let held: (() => void)[] = [];
function answer(price: (n: number, skus: string[]) => number, hold: (n: number) => boolean = () => false) {
  quoteCalls = [];
  held = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { lines: { sku: string }[] };
    const skus = body.lines.map((l) => l.sku);
    const n = quoteCalls.push(skus);
    if (hold(n)) await new Promise<void>((resolve) => held.push(resolve));
    const data = quoteOf(skus.map((s) => line(s, s === 'A-1' ? price(n, skus) : 50)));
    return new Response(JSON.stringify({ data, simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}
function renderCart() {
  render(<RouterProvider router={createMemoryRouter([{ path: '/cart', element: <Cart /> }], { initialEntries: ['/cart'] })} />);
}
const ticked = () => screen.getAllByTestId('cart-line').find((li) => li.dataset.sku === 'A-1')!;

beforeEach(() => {
  localStorage.clear();
  // the cart page itself is tested here; the saved cart's sync (step 12, GET/PUT /api/cart) is tested in cart/serverCart.test.ts
  setServerCartForTests(false);
  cartStore.setOwner('1');
  cartStore.reload();
  cartStore.add('A-1', 'm-tee', 1);
  cartStore.add('B-2', 'm-tee', 1);
  cartStore.setSelected('A-1', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cartStore.setOwner(null);
});

describe('the cart with some lines ticked (step 10)', () => {
  it('prices every line once and the ticked lines once; the ticked line and the total come from the same answer', async () => {
    answer(() => 100);
    renderCart();
    await vi.waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent('₱100'));
    expect(quoteCalls).toEqual(expect.arrayContaining([['A-1', 'B-2'], ['A-1']]));
    expect(quoteCalls).toHaveLength(2);
    expect(ticked().querySelector('[data-testid="line-total"]')).toHaveTextContent('₱100');
  });

  it('when the two answers disagree on a ticked line, it says "Updating prices…" (never two figures) and asks both again, once', async () => {
    // A says 100 for the ticked line, B says 120; the answers asked again are held, then both say 120
    answer((n, skus) => (n <= 2 ? (skus.length === 2 ? 100 : 120) : 120), (n) => n > 2);
    renderCart();
    await vi.waitFor(() => expect(quoteCalls).toHaveLength(4));
    // while asked again: no figure for the ticked line and no total that could contradict each other
    expect(ticked().querySelector('[data-testid="line-price"]')).toBeNull();
    expect(screen.queryByText('₱100')).toBeNull();
    expect(screen.queryByTestId('quote-total')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Checkout' })[0]).toBeDisabled();
    held.forEach((release) => release());
    await vi.waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent('₱120'));
    expect(ticked().querySelector('[data-testid="line-price"]')).toHaveTextContent('₱120 each');
    expect(ticked().querySelector('[data-testid="line-total"]')).toHaveTextContent('₱120');
    expect(quoteCalls).toHaveLength(4); // agreeing answers end it: no loop
  });

  it('a ticked line shows "Updating prices…" while only the ticked lines are being priced', async () => {
    answer(() => 100, (n) => n === 2); // the ticked-lines answer is held; every line's answer comes back
    renderCart();
    await vi.waitFor(() => expect(screen.getAllByTestId('line-total').some((t) => t.textContent === '₱50')).toBe(true));
    expect(ticked().querySelector('[data-testid="line-updating"]')).toHaveTextContent('Updating prices…');
    expect(ticked().querySelector('[data-testid="line-price"]')).toBeNull();
    expect(screen.queryByTestId('quote-total')).toBeNull();
    held.forEach((release) => release());
    await vi.waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent('₱100'));
    expect(ticked().querySelector('[data-testid="line-updating"]')).toBeNull();
  });
});
