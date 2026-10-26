import { configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_STAFF_SESSION_KEY } from '../api/client';
import type { DeliveryDetails } from '../api/types';
import { handlers } from '../mocks/handlers';
import { placeOrder, priceCart } from '../mocks/shop';
import { catalogue, loadDb, resetDb, saveDb } from '../mocks/shopDb';
import { DEMO_STAFF } from '../mocks/staff';
import { OrderDetailPage } from './OrderDetailPage';
import { OrdersPage } from './OrdersPage';
import { StaffApp } from './StaffApp';

/**
 * Step B, the staff dashboard: each of its pages shows a skeleton in its own frame while its data is on the way, then the data. (The unit
 * tests build with VITE_SKELETON_INSTANT; the staff minimum of 300 ms is in lib/skeletonTiming.ts and proved in useSkeletonGate.test.tsx.)
 * The board has no mock endpoint of its own (it is the real shop's), so it is checked in board.test.tsx's way with its own API answers.
 */
configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 60000 });

const server = setupServer(...handlers);
let held: Promise<void> = Promise.resolve();
let release: () => void = () => undefined;
let holdMatch = /./;
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
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  resetDb();
  sessionStorage.clear();
  localStorage.clear();
  held = Promise.resolve();
  holdMatch = /./;
});
afterEach(() => {
  release();
  server.resetHandlers();
});

const GOOD: DeliveryDetails = { fullName: 'Juana Dela Cruz', email: 'juana@example.com', phone: '0917 123 4567', street: '12 Rizal Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: '' };
const variant = catalogue.products.flatMap((p) => p.variants).find((v) => v.stock >= 5 && v.status === 'in_stock')!;
function place() {
  const lines = [{ sku: variant.sku, quantity: 1 }];
  const result = placeOrder({ lines, delivery: GOOD, paymentMethod: 'cod', quotedTotal: priceCart(lines).total }, null, loadDb(), 0);
  if (result.status !== 201) throw new Error('could not place the test order');
  return result.order;
}
const inventory = DEMO_STAFF.find((s) => s.role === 'inventory')!;
function seedStaff() {
  const db = loadDb();
  db.staffSessions['test-staff'] = inventory.id;
  saveDb(db);
  sessionStorage.setItem(MOCK_STAFF_SESSION_KEY, 'test-staff');
}
function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/staff', element: <StaffApp />, children: [{ index: true, element: <OrdersPage /> }, { path: 'orders/:id', element: <OrderDetailPage /> }] }],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
function expectSkeleton(testId: string, message: string) {
  const region = screen.getByTestId(testId);
  expect(region).toHaveAttribute('aria-busy', 'true');
  expect(within(region).getByRole('status')).toHaveTextContent(message);
}

describe('the staff dashboard', () => {
  it('while a returning staff member\'s sign-in is checked, the frame shows a skeleton (no sign-in form, no "signed out" flash), then the dashboard', async () => {
    seedStaff();
    place();
    hold(/\/api\/staff\/auth\/me$/);
    renderAt('/staff');
    expectSkeleton('staff-checking', 'Checking your sign-in…');
    expect(screen.queryByRole('heading', { name: 'Staff sign in' })).not.toBeInTheDocument();
    release();
    expect(await screen.findByTestId('staff-orders')).toBeInTheDocument();
    expect(screen.queryByTestId('staff-checking')).not.toBeInTheDocument();
  });

  it('the order list shows rows while its first answer loads, then the orders; a new filter keeps them on screen (dimmed) with no skeleton', async () => {
    seedStaff();
    place();
    place();
    hold(/\/api\/staff\/orders\?/);
    renderAt('/staff');
    await vi.waitFor(() => expect(screen.getByTestId('staff-list-loading')).toBeInTheDocument());
    expectSkeleton('staff-list-loading', 'Loading orders…');
    release();
    await screen.findByTestId('staff-orders');
    expect(screen.queryByTestId('staff-list-loading')).not.toBeInTheDocument();
    // a second request (a search) is held: the first list stays, dimmed, and no skeleton comes back
    hold(/\/api\/staff\/orders\?/);
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByRole('searchbox'), 'Juana');
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(screen.queryByTestId('staff-list-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('staff-orders')).toBeInTheDocument();
    release();
  });

  it('one order shows its frame while it loads, then the order', async () => {
    seedStaff();
    const order = place();
    hold(new RegExp(`/api/staff/orders/${order.id}$`));
    renderAt(`/staff/orders/${order.id}`);
    await vi.waitFor(() => expect(screen.getByTestId('staff-detail-loading')).toBeInTheDocument());
    expectSkeleton('staff-detail-loading', 'Loading the order…');
    release();
    expect(await screen.findByText(order.reference, { exact: false })).toBeInTheDocument();
    expect(screen.queryByTestId('staff-detail-loading')).not.toBeInTheDocument();
  });

  it('an order that is not there is a "not found" page at once, not a skeleton held for its minimum', async () => {
    seedStaff();
    renderAt('/staff/orders/99999');
    expect(await screen.findByRole('heading', { name: 'Order not found' })).toBeInTheDocument();
    expect(screen.queryByTestId('staff-detail-loading')).not.toBeInTheDocument();
  });
});

describe('the board (the real shop\'s kanban)', () => {
  it('each column shows cards while its first answer loads, then its orders or "No orders here."', async () => {
    vi.resetModules();
    vi.doMock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), API_MODE: 'odoo' as const }));
    const { BoardPage: Board } = await import('./BoardPage');
    let go: () => void = () => undefined;
    const answers = new Promise<void>((resolve) => {
      go = resolve;
    });
    vi.stubGlobal('fetch', async () => {
      await answers;
      return new Response(JSON.stringify({ data: { orders: [], total: 0, page: 1, pageSize: 25 }, simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    render(<RouterProvider router={createMemoryRouter([{ path: '/staff', element: <Board /> }], { initialEntries: ['/staff'] })} />);
    const loading = await screen.findAllByTestId('board-loading');
    expect(loading).toHaveLength(5); // one per column
    for (const region of loading) expect(region).toHaveAttribute('aria-busy', 'true');
    go();
    await vi.waitFor(() => expect(screen.queryAllByTestId('board-loading')).toHaveLength(0));
    expect((await screen.findAllByText('No orders here.')).length).toBe(5);
    vi.doUnmock('../api/client');
  });
});
