import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order, OrderState, PaymentMethodId } from '../api/types';
import { OrdersList } from '../components/OrdersList';
import { placeOrder } from '../mocks/shop';
import { catalogue, resetDb } from '../mocks/shopDb';
import { STATE_LABEL } from '../lib/orderText';

// pretend a signed-in customer, so the order page is reachable
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: '1', displayName: 'Customer', email: 'c@example.test' }, status: 'ready', openSignIn() {}, openRegister() {}, signOut() {}, requireAccount: (then: () => void) => then() }),
}));
const { OrderPage } = await import('./OrderPage');

const variant = catalogue.products.flatMap((p) => p.variants).find((v) => v.stock >= 5)!;
const STATES: OrderState[] = ['awaiting_payment', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];
/** Nothing a shopper reads may promise a time, a date or a refund: staff cannot know any of them. */
const PROMISES = /\b(within|days?|hours?|minutes?|weeks?|tomorrow|today|estimated|expected|eta|guarantee[sd]?|refund(ed|s)?|by (mon|tue|wed|thu|fri|sat|sun)\w*|deadline|\d+\s*(am|pm))\b/i;

function orderIn(state: OrderState, method: PaymentMethodId): Order {
  resetDb();
  const result = placeOrder(
    {
      lines: [{ sku: variant.sku, quantity: 1 }],
      delivery: { fullName: 'Juana', email: 'j@example.com', phone: '09171234567', street: '1 Test Street', city: 'Manila', province: 'PH-00', postalCode: '1000', note: '' },
      paymentMethod: method, quotedTotal: variant.price,
    },
    null,
  );
  if (result.status !== 201) throw new Error('could not build a sample order');
  const { ownerId, paid, history, ...order } = result.order;
  void ownerId;
  void paid;
  void history;
  return { ...order, state };
}
function serve(body: unknown) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: body, simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}
function renderOrder(order: Order) {
  serve(order);
  render(<RouterProvider router={createMemoryRouter([{ path: '/orders/:id', element: <OrderPage /> }], { initialEntries: [`/orders/${order.id}`] })} />);
}

beforeEach(() => resetDb());
afterEach(() => vi.unstubAllGlobals());

describe('what a customer reads for each status', () => {
  it('every status has its own word', () => {
    // step 11 adds out_for_delivery and closed (real shop only)
    expect(STATE_LABEL).toEqual({
      awaiting_payment: 'Waiting for payment', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Shipped', out_for_delivery: 'On delivery', delivered: 'Delivered',
      closed: 'Completed', cancelled: 'Cancelled',
    });
  });

  it.each([
    ['packed', 'cod', 'Packed', 'Your items are packed and ready to be handed over for delivery.'],
    ['shipped', 'cod', 'Shipped', 'Your order has been handed over for delivery. Please pay in cash when it arrives.'],
    ['shipped', 'bank_transfer', 'Shipped', 'Your order has been handed over for delivery.'],
    ['delivered', 'cod', 'Delivered', 'Your order was delivered. Thank you for shopping with ClothCraft.'],
    ['confirmed', 'bank_transfer', 'Confirmed', 'We have received your payment and your order is confirmed.'],
    ['confirmed', 'cod', 'Confirmed', 'Please pay in cash when your order arrives.'],
  ] as const)('the order page for %s (%s) says "%s" and what it means', async (state, method, word, sentence) => {
    renderOrder(orderIn(state, method));
    const box = await screen.findByTestId('order-status');
    expect(box).toHaveAttribute('data-state', state);
    expect(within(box).getByText(word)).toBeInTheDocument();
    expect(box).toHaveTextContent(sentence);
  });

  it('a cash-on-delivery order that is delivered is not asked for cash again, and a bank-transfer one is not told to pay in cash at any step', async () => {
    renderOrder(orderIn('delivered', 'cod'));
    expect((await screen.findByTestId('order-status')).textContent).not.toMatch(/pay in cash/i);
  });

  it.each(STATES.flatMap((s) => (['cod', 'bank_transfer'] as const).map((m) => [s, m] as const)))('%s (%s): no time, date, deadline or refund is promised in what the customer reads', async (state, method) => {
    renderOrder(orderIn(state, method));
    const box = await screen.findByTestId('order-status');
    expect(box.textContent).not.toMatch(PROMISES);
  });

  it('the orders list shows the new statuses in words', async () => {
    const orders = (['packed', 'shipped', 'delivered'] as const).map((s, i) => ({ ...orderIn(s, 'cod'), id: String(i + 1), reference: `S0000${i + 1}` }));
    serve(orders);
    render(<RouterProvider router={createMemoryRouter([{ path: '/', element: <OrdersList /> }])} />);
    const rows = await screen.findAllByTestId('order-row');
    expect(rows.map((r) => /Packed|Shipped|Delivered/.exec(r.textContent ?? '')?.[0])).toEqual(['Packed', 'Shipped', 'Delivered']);
  });
});
