import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order } from '../api/types';
import { placeOrder } from '../mocks/shop';
import { catalogue, resetDb } from '../mocks/shopDb';

// This whole file runs as if built with VITE_API=odoo: API_MODE is "odoo" for every module that imports it.
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), API_MODE: 'odoo' as const }));
// pretend a signed-in customer, so the order page is reachable and the buttons can be judged
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: '1', displayName: 'Real customer', email: 'real@example.test' }, status: 'ready', openSignIn() {}, openRegister() {}, signOut() {}, requireAccount: (then: () => void) => then() }),
}));

const { OrderPage } = await import('./OrderPage');

const variant = catalogue.products.flatMap((p) => p.variants).find((v) => v.stock >= 5)!;
function sampleOrder(paymentMethod: 'cod' | 'bank_transfer'): Order {
  resetDb();
  const lines = [{ sku: variant.sku, quantity: 1 }];
  const result = placeOrder(
    { lines, delivery: { fullName: 'Juana', email: 'j@example.com', phone: '09171234567', street: '1 Test Street', city: 'Manila', province: 'PH-00', postalCode: '1000', note: '' }, paymentMethod, quotedTotal: variant.price },
    null,
  );
  if (result.status !== 201) throw new Error('could not build a sample order');
  return result.order;
}

function renderOrder(order: Order) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: order, simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const router = createMemoryRouter([{ path: '/orders/:id', element: <OrderPage /> }], { initialEntries: [`/orders/${order.id}`] });
  render(<RouterProvider router={router} />);
}

beforeEach(() => resetDb());
afterEach(() => vi.unstubAllGlobals());

describe('with VITE_API=odoo', () => {
  it('shows a bank-transfer order waiting for payment, with no staff-cancel button and no demo notes', async () => {
    renderOrder(sampleOrder('bank_transfer'));
    expect(await screen.findByTestId('wait-note')).toHaveTextContent('our staff may cancel the order');
    expect(screen.getByTestId('order-status')).toHaveAttribute('data-state', 'awaiting_payment');
    expect(screen.queryByTestId('mock-staff-cancel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /staff/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Demo only|pretend/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-reset-note')).not.toBeInTheDocument();
  });

  it('has no customer cancel anywhere on a cash-on-delivery order either', async () => {
    renderOrder(sampleOrder('cod'));
    await screen.findByTestId('order-status');
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });
});
