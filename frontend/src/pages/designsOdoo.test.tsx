import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignedOrderLine, DesignedQuoteLine, Order, Quote } from '../api/types';
import { cartStore, setServerCartForTests } from '../cart/cartStore';

// Step 9 in the real shop only (the frozen mock has no designs): this file runs as if built with VITE_API=odoo, and answers the API itself.
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), API_MODE: 'odoo' as const }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: '1', displayName: 'Real customer', email: 'real@example.test' }, status: 'ready', openSignIn() {}, openRegister() {}, signOut() {}, requireAccount: (then: () => void) => then() }),
}));

const { Cart } = await import('./Cart');
const { OrderPage } = await import('./OrderPage');

const FEE = { coveredSqIn: 12, rate: 2, sizeStep: 20, steps: 1, unit: 44, total: 88 };
const base = { sku: 'M-TEE-BLK-M', productId: 'm-tee', name: 'Men Crew Tee', colorName: 'Black', size: 'M' as const, image: '/garments/m-tee/black.webp', quantity: 2, available: 9, message: null };
const designed: DesignedQuoteLine = { ...base, unitPrice: 349, lineTotal: 698, issue: 'ok', designId: '12', printFee: FEE, remedy: null };
const gone: DesignedQuoteLine = { ...base, quantity: 1, unitPrice: 0, lineTotal: 0, issue: 'design_unavailable', message: 'This design is no longer available.', designId: '13', printFee: null, remedy: 'remove' };
const quoteOf = (lines: Quote['lines']): Quote => ({ currency: 'PHP', vatIncluded: true, vatRate: 12, lines, deliveryFee: 0, deliveryLabel: 'Free delivery', total: lines.reduce((n, l) => n + l.lineTotal + ('printFee' in l && l.printFee ? l.printFee.total : 0), 0), vatAmount: 84, ready: lines.every((l) => l.issue === 'ok') });

let calls: { method: string; url: string; body: unknown }[] = [];
function answer(route: (method: string, url: string, body: unknown) => unknown) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', url, body });
    return new Response(JSON.stringify({ data: route(init.method ?? 'GET', url, body), simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/cart', element: <Cart /> },
      { path: '/orders/:id', element: <OrderPage /> },
      { path: '/design', element: <p>design page</p> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  localStorage.clear();
  // the cart page itself is tested here; the saved cart's sync (step 12, GET/PUT /api/cart) is tested in cart/serverCart.test.ts
  setServerCartForTests(false);
  cartStore.setOwner('1');
  cartStore.reload();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cartStore.setOwner(null);
});

describe('the cart with a customized garment', () => {
  it('sends the design with the line, shows the design, the print fee, the server figure beside the estimate, and Edit design', async () => {
    cartStore.add('M-TEE-BLK-M', 'm-tee', 2, { id: '12', estimate: 43.5 });
    answer(() => quoteOf([designed]));
    renderAt('/cart');
    const line = await screen.findByTestId('cart-line');
    expect(await within(line).findByTestId('line-print-fee')).toHaveTextContent('Print fee 12.00 sq in · ₱44 × 2');
    expect(calls.find((c) => c.url.endsWith('/cart/quote'))?.body).toEqual({ lines: [{ sku: 'M-TEE-BLK-M', quantity: 2, designId: '12' }] });
    expect(within(line).getByTestId('line-design-preview')).toHaveAttribute('src', '/api/designs/12/preview.png');
    expect(within(line).getByTestId('line-estimate-note')).toHaveTextContent("Estimated ₱43.50 in the editor; the shop's figure is ₱44.");
    expect(within(line).getByTestId('line-fee-total')).toHaveTextContent('+ print ₱88');
    expect(within(line).getByTestId('line-edit-design')).toHaveAttribute('href', '/design?product=m-tee&variant=M-TEE-BLK-M&design=12');
    // the VAT is stated at checkout and on the order, not in the cart (step 9)
    expect(screen.queryByTestId('quote-vat')).toBeNull();
  });

  it('says nothing about the estimate when it matches the shop', async () => {
    cartStore.add('M-TEE-BLK-M', 'm-tee', 2, { id: '12', estimate: 44 });
    answer(() => quoteOf([designed]));
    renderAt('/cart');
    await screen.findByTestId('line-print-fee');
    expect(screen.queryByTestId('line-estimate-note')).toBeNull();
  });

  it('a design that is gone is an issue with Remove, priced at nothing, and blocks checkout', async () => {
    cartStore.add('M-TEE-BLK-M', 'm-tee', 1, { id: '13' });
    cartStore.setAllSelected(true); // step 10: only a ticked problem line blocks checkout
    answer(() => quoteOf([gone]));
    renderAt('/cart');
    const issue = await screen.findByTestId('line-issue');
    expect(issue).toHaveTextContent('This design is no longer available.');
    expect(within(issue).getAllByRole('button').map((b) => b.textContent)).toEqual(['Remove from cart']);
    expect(screen.queryByTestId('line-price')).toBeNull();
    expect(screen.queryByTestId('line-print-fee')).toBeNull();
    expect(screen.queryByTestId('line-edit-design')).toBeNull();
    expect(screen.getByTestId('line-total')).toHaveTextContent('');
    expect(screen.getAllByRole('button', { name: 'Checkout' })[0]).toBeDisabled();
  });

  it('the same garment plain and with a design are two lines', async () => {
    cartStore.add('M-TEE-BLK-M', 'm-tee', 1);
    cartStore.add('M-TEE-BLK-M', 'm-tee', 2, { id: '12' });
    cartStore.add('M-TEE-BLK-M', 'm-tee', 1);
    expect(cartStore.get().lines.map((l) => [l.designId ?? null, l.quantity])).toEqual([
      [null, 2],
      ['12', 2],
    ]);
  });

  it('Remove keeps the design while Undo is offered, then removes it from the shop; Undo keeps it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    cartStore.add('M-TEE-BLK-M', 'm-tee', 2, { id: '12' });
    answer((method) => (method === 'DELETE' ? { removed: true } : quoteOf([designed])));
    renderAt('/cart');
    await screen.findByTestId('line-print-fee');
    fireEvent.click(screen.getByRole('button', { name: /^Remove .* from the cart$/ }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(11000)));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(cartStore.get().lines).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^Remove .* from the cart$/ }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(11000)));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/designs/12']);
  });

  it('a stored line with a damaged design reference is dropped, never kept as the plain garment', () => {
    localStorage.setItem('cc.cart.v1:1', JSON.stringify([{ sku: 'M-TEE-BLK-M', productId: 'm-tee', quantity: 1, designId: '12abc' }, { sku: 'W-TEE-WHT-S', productId: 'w-tee', quantity: 1 }]));
    cartStore.reload();
    expect(cartStore.get().lines.map((l) => l.sku)).toEqual(['W-TEE-WHT-S']);
  });
});

describe('the order page with a customized garment', () => {
  it('shows the design and the print fee as it was ordered', async () => {
    const line: DesignedOrderLine = { sku: 'M-TEE-BLK-M', productId: 'm-tee', name: 'Men Crew Tee', colorName: 'Black', size: 'M', image: '/garments/m-tee/black.webp', quantity: 2, unitPrice: 349, lineTotal: 698, designId: '12', printFee: FEE };
    const order: Order = {
      id: '7', reference: 'S00007', state: 'confirmed', createdAt: '2026-10-23T10:00:00.000Z', paymentMethod: 'cod', currency: 'PHP', vatIncluded: true, vatRate: 12, lines: [line],
      delivery: { fullName: 'Juana', email: 'j@example.com', phone: '09171234567', street: '1 Test Street', city: 'Manila', province: 'PH-00', provinceName: 'Metro Manila', postalCode: '1000', note: '' },
      deliveryFee: 0, deliveryLabel: 'Free delivery', total: 786, vatAmount: 84.21, bankTransfer: null,
    };
    answer(() => order);
    renderAt('/orders/7');
    const row = await screen.findByTestId('order-designed-line');
    expect(within(row).getByRole('img')).toHaveAttribute('src', '/api/designs/12/preview.png');
    expect(within(row).getByTestId('order-print-fee')).toHaveTextContent('Print fee 12.00 sq in · ₱44 × 2');
    expect(row).toHaveTextContent('₱88');
    expect(screen.getByTestId('quote-vat')).toHaveTextContent('12% VAT');
  });
});
