import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order, OrderTracking, TrackedState } from '../api/types';
import { MAX_BACKOFF_MS, useVisiblePolling } from '../lib/useVisiblePolling';
import { placeOrder } from '../mocks/shop';
import { catalogue, resetDb } from '../mocks/shopDb';

// Step 11 in the real shop only (the frozen mock sends no tracking): this file runs as if built with VITE_API=odoo and answers the API itself.
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), API_MODE: 'odoo' as const }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: '1', displayName: 'Real customer', email: 'real@example.test' }, status: 'ready', openSignIn() {}, openRegister() {}, signOut() {}, requireAccount: (then: () => void) => then() }),
}));

const { OrderPage } = await import('./OrderPage');

let visibility: DocumentVisibilityState = 'visible';
beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterAll(() => {
  Reflect.deleteProperty(document, 'visibilityState');
});

const variant = catalogue.products.flatMap((p) => p.variants).find((v) => v.stock >= 5)!;
const AT = ['2026-10-22T02:00:00.000Z', '2026-10-23T03:00:00.000Z', '2026-10-24T04:00:00.000Z', '2026-10-24T09:30:00.000Z'];
const STEPS = ['received', 'shipped', 'on_delivery', 'delivered'] as const;

function tracking(state: TrackedState, extra: Partial<OrderTracking> = {}): OrderTracking {
  const index = { confirmed: 0, shipped: 1, out_for_delivery: 2, delivered: 3, closed: 3 }[state as 'confirmed'] ?? -1;
  return {
    steps: STEPS.map((step, i) => ({ step, reachedAt: i <= index ? AT[i]! : null })),
    current: index >= 0 ? STEPS[index]! : null, awaitingPayment: state === 'awaiting_payment', closedAt: null, closedBy: null, canConfirm: state === 'delivered',
    ...extra,
  };
}
function order(state: TrackedState, method: 'cod' | 'bank_transfer' = 'cod', extra: Partial<OrderTracking> = {}): Order {
  resetDb();
  const result = placeOrder(
    { lines: [{ sku: variant.sku, quantity: 1 }], delivery: { fullName: 'Juana', email: 'j@example.com', phone: '09171234567', street: '1 Test Street', city: 'Manila', province: 'PH-00', postalCode: '1000', note: '' }, paymentMethod: method, quotedTotal: variant.price },
    null,
  );
  if (result.status !== 201) throw new Error('could not build a sample order');
  return { ...result.order, state, tracking: tracking(state, extra) };
}

let served: Order;
let calls: { method: string; url: string }[] = [];
let answerConfirm: () => Response;
function serve(o: Order, onCommit?: (ms: number) => void) {
  served = o;
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? 'GET', url });
    if (init.method === 'POST') return answerConfirm();
    return new Response(JSON.stringify({ data: served, simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const router = createMemoryRouter([{ path: '/orders/:id', element: <OrderPage /> }], { initialEntries: [`/orders/${o.id}`] });
  render(
    <Profiler id="order" onRender={(_id, _phase, ms) => onCommit?.(ms)}>
      <RouterProvider router={router} />
    </Profiler>,
  );
}
const steps = () => screen.getAllByTestId('tracker-step');
const kinds = () => steps().map((s) => s.dataset.kind);
const gets = () => calls.filter((c) => c.method === 'GET').length;

beforeEach(() => {
  visibility = 'visible';
  answerConfirm = () => new Response(JSON.stringify({ data: { ...served, state: 'closed', tracking: tracking('closed', { closedAt: '2026-10-25T01:00:00.000Z', closedBy: 'customer' }) }, simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the order tracker (step 11, real shop)', () => {
  it('step 1: four steps in words and icons, the current one marked for assistive technology, with the time it was reached', async () => {
    serve(order('confirmed'));
    await screen.findByTestId('order-tracker');
    expect(steps().map((s) => s.textContent)).toEqual([
      expect.stringMatching(/^Order received and preparingNow · Oct 22, 2026/), expect.stringMatching(/^Shipped outStill to come$/),
      expect.stringMatching(/^On deliveryStill to come$/), expect.stringMatching(/^DeliveredStill to come$/),
    ]);
    expect(steps().map((s) => s.getAttribute('aria-current'))).toEqual(['step', null, null, null]);
    expect(screen.getByRole('list', { name: 'Order progress' })).toBeInTheDocument();
    expect(screen.queryByTestId('confirm-received')).toBeNull();
  });

  it('step 3: the steps before are done with their times, and it says a cash-on-delivery order is paid on arrival', async () => {
    serve(order('out_for_delivery'));
    await screen.findByTestId('order-tracker');
    expect(kinds()).toEqual(['done', 'done', 'now', 'next']);
    expect(steps()[2]).toHaveAttribute('aria-current', 'step');
    expect(steps()[1]?.textContent).toMatch(/Done · Oct 23, 2026/);
    expect(screen.getByTestId('order-status')).toHaveTextContent('Your order is on its way to you. Please pay in cash when it arrives.');
  });

  it('a step reached before times were kept says so instead of inventing one', async () => {
    const o = order('shipped');
    o.tracking!.steps[0]!.reachedAt = null;
    serve(o);
    await screen.findByTestId('order-tracker');
    expect(steps()[0]).toHaveTextContent('Done · time not recorded');
  });

  it('step 4: "Confirm I received my order" asks first; "Not yet" and Escape change nothing and give focus back', async () => {
    const user = userEvent.setup();
    serve(order('delivered'));
    const button = await screen.findByRole('button', { name: 'Confirm I received my order' });
    expect(screen.getByTestId('auto-close-note')).toHaveTextContent("If you don't confirm, we'll close the order automatically.");
    expect(screen.getByTestId('auto-close-note').textContent).not.toMatch(/\d/);         // no number of days is promised
    await user.click(button);
    const dialog = screen.getByTestId('confirm-received-dialog');
    expect(within(dialog).getByRole('button', { name: 'Not yet' })).toHaveFocus();   // the safe choice first
    await user.click(within(dialog).getByRole('button', { name: 'Not yet' }));
    expect(screen.queryByTestId('confirm-received-dialog')).toBeNull();
    expect(button).toHaveFocus();
    await user.click(button);
    fireEvent(screen.getByTestId('confirm-received-dialog'), new Event('cancel', { cancelable: true }));     // Escape
    expect(screen.queryByTestId('confirm-received-dialog')).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('confirming closes the order: one POST, the closed state, a polite message, and focus on the status', async () => {
    const user = userEvent.setup();
    serve(order('delivered'));
    await user.click(await screen.findByRole('button', { name: 'Confirm I received my order' }));
    await user.click(within(screen.getByTestId('confirm-received-dialog')).getByRole('button', { name: 'Yes, I received it' }));
    expect(await screen.findByTestId('closed-note')).toHaveTextContent('You confirmed you received your order. Thank you for shopping with ClothCraft.');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([expect.stringMatching(/\/api\/orders\/\d+\/received$/)]);
    expect(screen.getByTestId('order-status')).toHaveAttribute('data-state', 'closed');
    expect(kinds()).toEqual(['done', 'done', 'done', 'done']);
    expect(screen.getByTestId('tracker-closed')).toHaveTextContent('You confirmed you received it · Oct 25, 2026');
    expect(screen.getByTestId('order-said')).toHaveTextContent('Thank you. You confirmed you received your order, and it is now complete.');
    await waitFor(() => expect(screen.getByTestId('order-status').querySelector('p')).toHaveFocus());
    expect(screen.queryByTestId('confirm-received')).toBeNull();
  });

  it('a refused confirmation says why in the shop\'s words and changes nothing', async () => {
    const user = userEvent.setup();
    answerConfirm = () => new Response(JSON.stringify({ error: { code: 'invalid_transition', message: 'This order is out for delivery. You can confirm you received it once it has been delivered.', currentState: 'out_for_delivery' } }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    serve(order('delivered'));
    await user.click(await screen.findByRole('button', { name: 'Confirm I received my order' }));
    await user.click(within(screen.getByTestId('confirm-received-dialog')).getByRole('button', { name: 'Yes, I received it' }));
    expect(await screen.findByTestId('confirm-error')).toHaveTextContent('This order is out for delivery. You can confirm you received it once it has been delivered.');
  });

  it('closed automatically, cancelled (no tracker), and waiting for a bank transfer (no current step)', async () => {
    serve(order('closed', 'cod', { closedAt: '2026-10-31T01:00:00.000Z', closedBy: 'automatic' }));
    expect(await screen.findByTestId('tracker-closed')).toHaveTextContent('Closed automatically');
    expect(screen.getByTestId('closed-note')).toHaveTextContent('This order is complete.');
    document.body.innerHTML = '';
    serve(order('cancelled'));
    expect(await screen.findByText('This order was cancelled. Its items went back into stock.')).toBeInTheDocument();
    expect(screen.queryByTestId('order-tracker')).toBeNull();
    document.body.innerHTML = '';
    serve(order('awaiting_payment', 'bank_transfer'));
    expect(await screen.findByTestId('wait-note')).toBeInTheDocument();
    expect(kinds()).toEqual(['next', 'next', 'next', 'next']);
    expect(steps().some((s) => s.hasAttribute('aria-current'))).toBe(false);
  });

  it('asks again when the window regains focus, and a refresh with nothing new redraws nothing (focus stays)', async () => {
    let rendered = 0;
    serve(order('confirmed'), (ms) => (rendered += ms));
    const box = await screen.findByTestId('order-status');
    const back = screen.getByRole('link', { name: 'Your orders' });
    back.focus();
    await new Promise((r) => setTimeout(r, 50));
    const before = gets();
    const renderedBefore = rendered;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(gets()).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 50));
    // the same answer re-renders no component: React bails out at once (measured: ~0 ms; without the check the page re-renders, 10+ ms)
    expect(rendered - renderedBefore).toBeLessThan(2);
    expect(screen.getByTestId('order-status')).toBe(box);
    expect(back).toHaveFocus();
    served = { ...served, state: 'shipped', tracking: tracking('shipped') };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(kinds()).toEqual(['done', 'now', 'next', 'next']));
    expect(screen.getByTestId('order-said')).toHaveTextContent('Your order is now at: Shipped out.');
    expect(back).toHaveFocus();
  });

  it('is not polled once the order is closed', async () => {
    serve(order('closed', 'cod', { closedAt: '2026-10-25T01:00:00.000Z', closedBy: 'customer' }));
    await screen.findByTestId('order-tracker');
    const before = gets();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(gets()).toBe(before);
  });
});

describe('useVisiblePolling', () => {
  beforeEach(() => vi.useFakeTimers());

  it('runs every interval only while visible, at once when the tab comes back, never twice at a time, and waits while paused', async () => {
    const refresh = vi.fn(async () => true);
    let paused = false;
    renderHook(() => useVisiblePolling(refresh, { every: 60_000, enabled: true, paused: () => paused }));
    await act(async () => vi.advanceTimersByTimeAsync(59_000));
    expect(refresh).toHaveBeenCalledTimes(0);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    visibility = 'hidden';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);                       // hidden: nothing
    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));                       // both fire on return: still one refresh
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    paused = true;
    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect(refresh).toHaveBeenCalledTimes(2);                       // a drag or a dialog: due refreshes wait
    paused = false;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('a screen opened in a hidden tab asks nothing until the tab is shown', async () => {
    visibility = 'hidden';
    const refresh = vi.fn(async () => true);
    renderHook(() => useVisiblePolling(refresh, { every: 30_000, enabled: true }));
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(refresh).toHaveBeenCalledTimes(0);
    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('backs off after errors, doubling up to the cap, and goes back to the interval after a success', async () => {
    let ok = false;
    const refresh = vi.fn(async () => ok);
    renderHook(() => useVisiblePolling(refresh, { every: 30_000, enabled: true }));
    const at: number[] = [];
    refresh.mockImplementation(async () => {
      at.push(Date.now());
      return ok;
    });
    const start = Date.now();
    await act(async () => vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 240_000));
    expect(at.map((t) => (t - start) / 1000)).toEqual([30, 90, 210, 450]);       // 30 s, then 60, 120, 240 after each failure
    await act(async () => vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS * 3));
    const gaps = at.slice(4).map((t, i) => t - (at[3 + i] ?? 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    ok = true;
    const n = at.length;
    await act(async () => vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 30_000));
    expect(at.length).toBeGreaterThanOrEqual(n + 2);
    expect(at[at.length - 1]! - at[at.length - 2]!).toBe(30_000);          // back to every 30 s
  });
});
